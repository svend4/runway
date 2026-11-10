// worker_client.mjs — клиент воркера расчёта (FP-12, REQ-117, REQ-150): `analyze` в модульном Web Worker с откатом на главный поток.
// FP-21: те же правила отката у операций основных экранов `project` («Обзор»), `waves` («Волны») и `afford` («Купить»), они идут поверх `analyze` (calc_worker.mjs).
// Откат происходит, если воркера нет (Node, старый браузер, `Worker` недоступен), он не запустился (CSP, файл не найден, модульные воркеры не
// поддерживаются), упал (событие `error`), не ответил за `timeout_ms`, ответил другой версией движка или не принял сообщение (данные не
// копируются структурным клонированием). После сбоя воркера клиент считает его мёртвым до конца сеанса и дальше считает на главном потоке:
// без цикла перезапусков; ответ `ok: true` без объекта `result` — тоже сбой воркера (не расчёт). Ошибки движка (RunwayError с кодом E_*) — не сбой воркера: они пробрасываются как есть, как при расчёте на месте.
// Протокол сообщений описан в calc_worker.mjs. Порты внедряются (`make_worker`, `local`, `set_timeout`) — модуль проверяется в Node на заглушке воркера.
// Расчёт по введённым данным и правилам, не консультация.

import { RunwayError } from '../engine/money.mjs';
import { analyze, ENGINE_VERSION } from '../engine/index.mjs';
import { PROTOCOL, run_project, run_waves, run_afford } from './calc_worker.mjs';

/** Сколько ждать ответа воркера, мс (холодный старт модульного воркера на слабом телефоне — секунды). */
export const DEFAULT_TIMEOUT_MS = 20000;

/** Причины отката (`reason` в результате): значения закрыты, текста пользователя в них нет. */
export const FALLBACK_REASONS = Object.freeze(['no_worker', 'worker_start_failed', 'worker_error', 'timeout', 'version_mismatch', 'clone_failed']);

/** Воркер по умолчанию: модульный, рядом с этим файлом; без `Worker` — `null`. */
function default_make_worker() {
  if (typeof globalThis.Worker !== 'function') return null;
  return new globalThis.Worker(new URL('calc_worker.mjs', import.meta.url), { type: 'module' });
}

/**
 * Воркер разбора файлов импорта (FP-18, import_worker_client.mjs): модульный, рядом с этим файлом; без `Worker` — `null`.
 * Воркеры создаются только здесь (проверка `offline_inventory`): так перечень источников воркеров в оболочке остаётся в одном файле.
 */
export function make_import_worker() {
  if (typeof globalThis.Worker !== 'function') return null;
  return new globalThis.Worker(new URL('import_worker.mjs', import.meta.url), { type: 'module' });
}

/**
 * Клиент расчёта.
 * @param {{make_worker?: () => (object|null), local?: (ws: object, query: object) => object, timeout_ms?: number,
 *   set_timeout?: (fn: () => void, ms: number) => any, clear_timeout?: (id: any) => void}} [opts]
 */
export function create_calc_client(opts = {}) {
  const make_worker = opts.make_worker ?? default_make_worker;
  const local = opts.local ?? analyze;
  const timeout_ms = opts.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const set_timeout = opts.set_timeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clear_timeout = opts.clear_timeout ?? ((id) => clearTimeout(id));

  let worker = null;
  let dead = null; // причина, по которой воркер больше не используется
  let started = false;
  let next_id = 1;
  const pending = new Map(); // id → { resolve, reject, timer }
  const stat = { worker_calls: 0, main_calls: 0, engine_errors: 0 };

  function settle_all(err) {
    for (const [id, p] of [...pending]) { pending.delete(id); clear_timeout(p.timer); p.reject(err); }
  }

  /** Отметить воркер мёртвым и освободить ожидающие вызовы (они считаются на главном потоке). */
  function kill(reason) {
    if (dead === null) dead = reason;
    const w = worker;
    worker = null;
    try { w?.terminate?.(); } catch { /* воркер уже недоступен */ }
    settle_all({ transport: reason });
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
      pending.delete(m.id);
      clear_timeout(p.timer);
      p.resolve(m);
    };
    w.onerror = () => kill('worker_error');
    w.onmessageerror = () => kill('worker_error');
  }

  function request(payload) {
    return new Promise((resolve, reject) => {
      const id = next_id;
      next_id += 1;
      const timer = set_timeout(() => { if (pending.has(id)) kill('timeout'); }, timeout_ms);
      pending.set(id, { resolve, reject, timer });
      try {
        worker.postMessage({ v: PROTOCOL, id, ...payload });
      } catch {
        pending.delete(id);
        clear_timeout(timer);
        reject({ transport: 'clone_failed' }); // данные не копируются; воркер цел
      }
    });
  }

  /**
   * Выполнить операцию: в воркере, а при невозможности — на главном потоке (`local_fn`). Общий путь `analyze` и операций экранов (FP-21): сбои воркера,
   * откат и ошибки движка обрабатываются одинаково.
   * @param {string} op
   * @param {object} payload поля запроса после `op` (`{ws, query}` и т. п.)
   * @param {() => object} local_fn расчёт на месте
   * @param {{stale?: () => boolean}} [o] `stale()` — запрос уже вытеснен более новым (FP-21): откат на главный поток его не считает и возвращает `{result: null, skipped: true}`
   *   (после сбоя воркера на главном потоке считается только актуальный запрос, а не вся очередь устаревших)
   * @returns {Promise<{result: object, via: 'worker'|'main', reason: string|null} | {result: null, via: 'main', reason: string|null, skipped: true}>}
   * @throws {RunwayError} ошибка движка (как при расчёте на месте)
   */
  async function call_async(op, payload, local_fn, o = {}) {
    ensure_started();
    let reason = dead;
    if (dead === null && worker !== null) {
      let reply = null;
      try {
        reply = await request({ op, ...payload });
      } catch (e) {
        if (typeof e?.transport !== 'string') throw e;
        reason = e.transport;
        if (reason !== 'clone_failed') kill(reason); // данные не скопировались — сбой этого вызова, а не воркера
      }
      if (reply !== null) {
        if (reply.engine_version !== ENGINE_VERSION) { kill('version_mismatch'); reason = 'version_mismatch'; }
        else if (reply.ok === true && reply.result !== null && typeof reply.result === 'object' && !Array.isArray(reply.result)) { stat.worker_calls += 1; return { result: reply.result, via: 'worker', reason: null }; }
        else if (reply.ok === false && typeof reply.error?.code === 'string') { stat.engine_errors += 1; throw new RunwayError(reply.error.code, reply.error.ctx ?? undefined); }
        else { kill('worker_error'); reason = 'worker_error'; }
      }
    }
    if (typeof o?.stale === 'function' && o.stale() === true) return { result: null, via: 'main', reason, skipped: true }; // FP-21: вытесненный запрос на главном потоке не считаем
    stat.main_calls += 1;
    return { result: local_fn(), via: 'main', reason };
  }

  /**
   * Посчитать `analyze`: в воркере, а при невозможности — на главном потоке.
   * @param {object} ws
   * @param {object} query
   * @returns {Promise<{result: object, via: 'worker'|'main', reason: string|null}>}
   * @throws {RunwayError} ошибка движка (как при расчёте на месте)
   */
  const analyze_async = (ws, query) => call_async('analyze', { ws, query }, () => local(ws, query));

  return {
    analyze: analyze_async,
    /** FP-21, «Обзор»: `{analysis, narrow}` (calc_worker.mjs `run_project`); тот же откат и те же ошибки, что у `analyze`. */
    project: (ws, query, o) => call_async('project', { ws, query }, () => run_project(ws, query), o),
    /** FP-21, «Волны»: `{analysis, waves}` (`run_waves`). */
    waves: (ws, query, o) => call_async('waves', { ws, query }, () => run_waves(ws, query), o),
    /** FP-21, «Купить»: `{cash_after}` — деньги после покупки `parts` поверх сценария запроса (`run_afford`). */
    afford: (ws, query, parts, o) => call_async('afford', { ws, query, parts }, () => run_afford(ws, query, parts), o),
    /** FP-21: запустить воркер заранее (холодный старт модульного воркера — секунды на слабом телефоне); `false` — воркера нет или он уже признан негодным. */
    warm: () => { ensure_started(); return dead === null && worker !== null; },
    terminate: () => { if (dead === null) dead = 'terminated'; const w = worker; worker = null; try { w?.terminate?.(); } catch { /* уже закрыт */ } settle_all({ transport: 'terminated' }); },
    /** Сводка для экрана и тестов. */
    stats: () => ({ worker_calls: stat.worker_calls, main_calls: stat.main_calls, engine_errors: stat.engine_errors, dead, started, pending: pending.size }),
  };
}
