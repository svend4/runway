// import_worker.mjs — разбор CSV по профилю в модульном Web Worker (FP-18, REQ-091): большой файл не держит интерфейс.
// Файл читают двумя способами: как воркер (`new Worker(new URL('import_worker.mjs', import.meta.url), { type: 'module' })`, см. `make_import_worker`
// в worker_client.mjs) и как обычный модуль — тесты и клиент (`join_parts`) вызывают его функции напрямую. В обычном модуле побочных эффектов нет:
// обработчик сообщений ставится только внутри воркера (проверка по `WorkerGlobalScope`).
//
// Контракт сообщений (версия протокола 1). Запрос страницы воркеру — объект, все поля обязательны:
//   { v: 1, id: <целое ≥ 0>, op: 'hello' }
//   { v: 1, id: <целое ≥ 0>, op: 'parse_csv', profile: <ImportProfile>, text: <декодированный файл>, ctx: { account_id, account_currency, as_of } }
// Ответ воркера на `parse_csv` — результат ровно того же вида, что возвращает `parse_with_profile` (engine/io.mjs): { candidates, rejects, rows_total }.
//   Малый результат (строк не больше CHUNK_ROWS) — одно сообщение:
//     { v: 1, id, ok: true, op, engine_version, result: { candidates, rejects, rows_total } }
//   Большой результат приходит частями, чтобы страница разбирала каждое сообщение за миллисекунды, а не одним куском за сотни (копирование
//   сообщения идёт в потоке получателя). Части идут по порядку, затем итог:
//     { v: 1, id, ok: true, op, engine_version, part: { kind: 'candidates' | 'rejects', index }, items: [...] }   (index с 0 внутри вида)
//     { v: 1, id, ok: true, op, engine_version, result: { rows_total, chunked: { candidates: <число частей>, rejects: <число частей> } } }
//   Сборка частей (`join_parts`) даёт тот же объект, что и малый ответ: JSON побайтно равен `parse_with_profile` (тесты).
//   Ошибка движка: { v: 1, id, ok: false, op, engine_version, error: { code, ctx } } — код E_* и JSON-совместимый контекст движка.
// Нарушение протокола (не объект, другая версия, плохой id, неизвестная операция, плохие аргументы) — ответ с `E_SCHEMA` и `ctx.reason`;
// любое неожиданное исключение — `E_SCHEMA` с `ctx.reason = 'unexpected'` (сообщение исключения наружу не уходит). `handle_message` не бросает исключений.
// Кроме того, воркер один раз при старте шлёт { v: 1, ready: true, engine_version } — клиент может его игнорировать.
// Расчёт по введённым данным и правилам, не консультация.

import { parse_with_profile } from '../engine/io.mjs';
import { ENGINE_VERSION } from '../engine/index.mjs';

/** Версия протокола сообщений. */
export const PROTOCOL = 1;
/** Операции воркера. */
export const OPS = Object.freeze(['hello', 'parse_csv']);
/** Сколько строк (кандидатов или отклонённых) в одной части ответа: копия такой части в потоке страницы — единицы миллисекунд (модель — import_worker_model.test.mjs). */
export const CHUNK_ROWS = 1000;

const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function error_reply(id, op, code, ctx) {
  return { v: PROTOCOL, id, ok: false, op, engine_version: ENGINE_VERSION, error: { code, ctx } };
}

/**
 * Обработать одно сообщение страницы: один ответ целиком (части делает `split_reply`).
 * @param {unknown} msg
 * @returns {object} ответ по контракту выше
 */
export function handle_message(msg) {
  const op = is_obj(msg) && typeof msg.op === 'string' ? msg.op : null;
  const id = is_obj(msg) && Number.isSafeInteger(msg.id) && msg.id >= 0 ? msg.id : null;
  if (!is_obj(msg)) return error_reply(null, op, 'E_SCHEMA', { reason: 'not_an_object' });
  if (msg.v !== PROTOCOL) return error_reply(id, op, 'E_SCHEMA', { reason: 'bad_version' });
  if (id === null) return error_reply(null, op, 'E_SCHEMA', { reason: 'bad_id' });
  try {
    if (op === 'hello') return { v: PROTOCOL, id, ok: true, op, engine_version: ENGINE_VERSION, result: { protocol: PROTOCOL, engine_version: ENGINE_VERSION } };
    if (op === 'parse_csv') {
      const c = msg.ctx;
      const good = is_obj(msg.profile) && typeof msg.text === 'string' && is_obj(c)
        && typeof c.account_id === 'string' && typeof c.account_currency === 'string' && (typeof c.as_of === 'string' || Number.isSafeInteger(c.as_of));
      if (!good) return error_reply(id, op, 'E_SCHEMA', { reason: 'bad_arguments' });
      const result = parse_with_profile(msg.profile, msg.text, { account_id: c.account_id, account_currency: c.account_currency, as_of: c.as_of });
      return { v: PROTOCOL, id, ok: true, op, engine_version: ENGINE_VERSION, result };
    }
    return error_reply(id, op, 'E_SCHEMA', { reason: 'unknown_op' });
  } catch (e) {
    if (e !== null && typeof e === 'object' && typeof e.code === 'string' && /^E_[A-Z_]+$/.test(e.code)) {
      return error_reply(id, op, e.code, is_obj(e.ctx) ? e.ctx : null);
    }
    return error_reply(id, op, 'E_SCHEMA', { reason: 'unexpected' });
  }
}

/**
 * Разбить ответ на сообщения для `postMessage`: малый ответ и всё, кроме удачного `parse_csv`, остаётся одним сообщением.
 * @param {object} reply результат `handle_message`
 * @param {number} [chunk] строк в части (в тестах меньше, чем `CHUNK_ROWS`)
 * @returns {object[]} один или несколько ответов в порядке отправки; последний — итог
 */
export function split_reply(reply, chunk = CHUNK_ROWS) {
  const r = reply?.result;
  if (reply?.ok !== true || reply.op !== 'parse_csv' || !is_obj(r) || !Array.isArray(r.candidates) || !Array.isArray(r.rejects)) return [reply];
  if (r.candidates.length + r.rejects.length <= chunk) return [reply];
  const head = { v: reply.v, id: reply.id, ok: true, op: reply.op, engine_version: reply.engine_version };
  const out = [];
  const counts = { candidates: 0, rejects: 0 };
  for (const kind of ['candidates', 'rejects']) {
    for (let i = 0; i < r[kind].length; i += chunk) {
      out.push({ ...head, part: { kind, index: counts[kind] }, items: r[kind].slice(i, i + chunk) });
      counts[kind] += 1;
    }
  }
  out.push({ ...head, result: { rows_total: r.rows_total, chunked: counts } });
  return out;
}

/**
 * Собрать результат из частей и итога (обратное к `split_reply`). Нарушение порядка, счёта или вида части — `null`: клиент считает это сбоем воркера.
 * @param {object[]} parts части в порядке получения
 * @param {object} final итоговое сообщение с `result.chunked`
 * @returns {{candidates: object[], rejects: object[], rows_total: number} | null}
 */
export function join_parts(parts, final) {
  const ch = final?.result?.chunked;
  if (!is_obj(ch) || !Number.isSafeInteger(ch.candidates) || !Number.isSafeInteger(ch.rejects) || !Number.isSafeInteger(final.result.rows_total)) return null;
  const got = { candidates: [], rejects: [] };
  const seen = { candidates: 0, rejects: 0 };
  let phase = 0; // кандидаты, затем отклонённые: порядок отправки фиксирован
  for (const p of parts) {
    const kind = p?.part?.kind;
    if (kind !== 'candidates' && kind !== 'rejects') return null;
    const at = kind === 'candidates' ? 0 : 1;
    if (at < phase || p.part.index !== seen[kind] || !Array.isArray(p.items)) return null;
    phase = at;
    seen[kind] += 1;
    for (const it of p.items) got[kind].push(it);
  }
  if (seen.candidates !== ch.candidates || seen.rejects !== ch.rejects) return null;
  return { candidates: got.candidates, rejects: got.rejects, rows_total: final.result.rows_total };
}

// ── запуск внутри воркера ───────────────────────────────────────────────────────────────────────────────────────────

const scope = globalThis;
if (typeof scope.WorkerGlobalScope === 'function' && scope instanceof scope.WorkerGlobalScope && typeof scope.postMessage === 'function') {
  scope.addEventListener('message', (ev) => { for (const r of split_reply(handle_message(ev.data))) scope.postMessage(r); });
  scope.postMessage({ v: PROTOCOL, ready: true, engine_version: ENGINE_VERSION });
}
