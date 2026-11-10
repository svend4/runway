// import_worker_client.mjs — клиент воркера разбора импорта (FP-18, REQ-091): `parse_with_profile` в модульном Web Worker с откатом на главный поток.
// Откат происходит, если воркера нет (Node, старый браузер, `Worker` недоступен), он не запустился (CSP, файл не найден), упал (событие `error`),
// замолчал дольше `timeout_ms` (между сообщениями), ответил другой версией движка или частями, которые не сходятся, либо не принял сообщение
// (данные не копируются структурным клонированием). После сбоя воркера клиент считает его мёртвым до конца сеанса и дальше разбирает на главном
// потоке: без цикла перезапусков. Ошибки движка (RunwayError с кодом E_*) — не сбой воркера: они пробрасываются как есть, как при разборе на месте.
// Результат тот же, что у `parse_with_profile` (JSON побайтно; проверяется тестами), поэтому вызывающий код различает путь только по `via`/`reason`.
// Протокол сообщений описан в import_worker.mjs. Порты внедряются (`make_worker`, `local`, `set_timeout`) — модуль проверяется в Node на заглушке воркера.
// Здесь нет ни сети, ни хранилищ, ни пользовательских текстов в диагностике: причины отката — закрытый список `FALLBACK_REASONS`.
// Расчёт по введённым данным и правилам, не консультация.

import { RunwayError } from '../engine/money.mjs';
import { parse_with_profile } from '../engine/io.mjs';
import { ENGINE_VERSION } from '../engine/index.mjs';
import { PROTOCOL, join_parts } from './import_worker.mjs';
import { make_import_worker } from './worker_client.mjs';

/** Сколько ждать следующего сообщения воркера, мс, плюс `PER_KB_MS` на каждый КБ текста: разбор файла в 5 МБ на слабом телефоне — минуты. */
export const DEFAULT_TIMEOUT_MS = 30000;
export const PER_KB_MS = 10;

/** Причины отката (`reason` в результате): значения закрыты, текста пользователя в них нет. */
export const FALLBACK_REASONS = Object.freeze(['no_worker', 'worker_start_failed', 'worker_error', 'timeout', 'version_mismatch', 'clone_failed', 'terminated']);

const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/**
 * Клиент разбора.
 * @param {{make_worker?: () => (object|null), local?: (profile: object, text: string, ctx: object) => object, timeout_ms?: number,
 *   set_timeout?: (fn: () => void, ms: number) => any, clear_timeout?: (id: any) => void}} [opts]
 */
export function create_import_client(opts = {}) {
  const make_worker = opts.make_worker ?? make_import_worker;
  const local = opts.local ?? parse_with_profile;
  const base_timeout_ms = opts.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const set_timeout = opts.set_timeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clear_timeout = opts.clear_timeout ?? ((id) => clearTimeout(id));

  let worker = null;
  let dead = null; // причина, по которой воркер больше не используется
  let started = false;
  let next_id = 1;
  const pending = new Map(); // id → { resolve, reject, timer, wait, parts }
  const stat = { worker_calls: 0, main_calls: 0, engine_errors: 0 };

  function settle_all(err) {
    for (const [id, p] of [...pending]) { pending.delete(id); clear_timeout(p.timer); p.reject(err); }
  }

  /** Отметить воркер мёртвым и освободить ожидающие вызовы (они разбираются на главном потоке). */
  function kill(reason) {
    if (dead === null) dead = reason;
    const w = worker;
    worker = null;
    try { w?.terminate?.(); } catch { /* воркер уже недоступен */ }
    settle_all({ transport: reason });
  }

  /** Таймер ожидания: сбрасывается с каждой частью ответа (воркер жив, пока присылает сообщения). */
  function arm(id, p) {
    if (p.timer !== null) clear_timeout(p.timer);
    p.timer = set_timeout(() => { if (pending.has(id)) kill('timeout'); }, p.wait);
  }

  function ensure_started() {
    if (started) return;
    started = true;
    let w = null;
    try { w = make_worker(); } catch { kill('worker_start_failed'); return; }
    if (w === null || w === undefined) { dead = 'no_worker'; return; }
    worker = w;
    w.onmessage = (ev) => {
      const m = ev?.data;
      if (m === null || typeof m !== 'object' || m.v !== PROTOCOL || !Number.isSafeInteger(m.id)) return; // «готов» и мусор игнорируются
      const p = pending.get(m.id);
      if (p === undefined) return; // чужой или повторный ответ
      if (m.part !== undefined) { p.parts.push(m); arm(m.id, p); return; }
      pending.delete(m.id);
      clear_timeout(p.timer);
      p.resolve({ msg: m, parts: p.parts });
    };
    w.onerror = () => kill('worker_error');
    w.onmessageerror = () => kill('worker_error');
  }

  function request(payload, size) {
    return new Promise((resolve, reject) => {
      const id = next_id;
      next_id += 1;
      const p = { resolve, reject, timer: null, wait: base_timeout_ms + PER_KB_MS * Math.ceil(size / 1024), parts: [] };
      pending.set(id, p);
      arm(id, p);
      try {
        worker.postMessage({ v: PROTOCOL, id, ...payload });
      } catch {
        pending.delete(id);
        clear_timeout(p.timer);
        reject({ transport: 'clone_failed' }); // данные не копируются; воркер цел
      }
    });
  }

  /** Результат из ответа воркера: целиком или собранный из частей; `null`, если форма не та (сбой воркера). */
  function result_of(got) {
    const r = got.msg.result;
    if (!is_obj(r)) return null;
    if (r.chunked !== undefined) return join_parts(got.parts, got.msg);
    return Array.isArray(r.candidates) && Array.isArray(r.rejects) && Number.isSafeInteger(r.rows_total) ? r : null;
  }

  /**
   * Разобрать CSV по профилю: в воркере, а при невозможности — на главном потоке.
   * @param {object} profile `ImportProfile`
   * @param {string} text декодированный файл
   * @param {{account_id: string, account_currency: string, as_of: string|number}} ctx
   * @returns {Promise<{result: {candidates: object[], rejects: object[], rows_total: number}, via: 'worker'|'main', reason: string|null}>}
   * @throws {RunwayError} ошибка движка (как при разборе на месте)
   */
  async function parse_csv(profile, text, ctx) {
    ensure_started();
    let reason = dead;
    if (dead === null && worker !== null) {
      let got = null;
      try {
        got = await request({ op: 'parse_csv', profile, text, ctx }, typeof text === 'string' ? text.length : 0);
      } catch (e) {
        if (typeof e?.transport !== 'string') throw e;
        reason = e.transport;
        if (reason !== 'clone_failed') kill(reason); // данные не скопировались — сбой этого вызова, а не воркера
      }
      if (got !== null) {
        const m = got.msg;
        if (m.engine_version !== ENGINE_VERSION) { kill('version_mismatch'); reason = 'version_mismatch'; }
        else if (m.ok === true) {
          const result = result_of(got);
          if (result !== null) { stat.worker_calls += 1; return { result, via: 'worker', reason: null }; }
          kill('worker_error'); reason = 'worker_error';
        } else if (m.ok === false && typeof m.error?.code === 'string') { stat.engine_errors += 1; throw new RunwayError(m.error.code, m.error.ctx ?? undefined); }
        else { kill('worker_error'); reason = 'worker_error'; }
      }
    }
    stat.main_calls += 1;
    return { result: local(profile, text, ctx), via: 'main', reason };
  }

  return {
    parse_csv,
    // started = true: после остановки воркер заново не создаётся (иначе вызов до первого разбора запустил бы воркер, который никто не закроет)
    terminate: () => { started = true; if (dead === null) dead = 'terminated'; const w = worker; worker = null; try { w?.terminate?.(); } catch { /* уже закрыт */ } settle_all({ transport: 'terminated' }); },
    /** Сводка для экрана и тестов. */
    stats: () => ({ worker_calls: stat.worker_calls, main_calls: stat.main_calls, engine_errors: stat.engine_errors, dead, started, pending: pending.size }),
  };
}
