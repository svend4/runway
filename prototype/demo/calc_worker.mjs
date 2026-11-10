// calc_worker.mjs — расчёт `analyze` в модульном Web Worker (FP-12, REQ-117, REQ-150): тяжёлый пересчёт не блокирует интерфейс.
// Файл читают двумя способами: как воркер (`new Worker(new URL('calc_worker.mjs', import.meta.url), { type: 'module' })`) и как обычный модуль —
// тесты и `tools/bench.mjs` вызывают `handle_message` напрямую. В обычном модуле побочных эффектов нет: обработчик сообщений ставится только внутри
// воркера (проверка по `WorkerGlobalScope`).
//
// Контракт сообщений (версия протокола 1). Запрос страницы воркеру — объект, все поля обязательны:
//   { v: 1, id: <целое ≥ 0>, op: 'hello' }
//   { v: 1, id: <целое ≥ 0>, op: 'analyze', ws: <рабочая область>, query: <запрос analyze, например { as_of: '2026-10-04' }> }
// Ответ воркера — один на запрос, с тем же `id`, порядок ответов не определён:
//   { v: 1, id, ok: true,  op, engine_version, result }          result: для hello — { protocol, engine_version }, для analyze — Analysis
//   { v: 1, id, ok: false, op, engine_version, error: { code, ctx } }  code — код ошибки движка (E_*), ctx — JSON-совместимый контекст движка
// Нарушение протокола (не объект, другая версия, плохой id, неизвестная операция, ws/query не объекты) — ответ с `E_SCHEMA` и `ctx.reason`;
// любое неожиданное исключение — `E_SCHEMA` с `ctx.reason = 'unexpected'` (сообщение исключения наружу не уходит). `handle_message` не бросает исключений.
// Кроме того, воркер один раз при старте шлёт { v: 1, ready: true, engine_version } — клиент может его игнорировать.
//
// FP-21 (REQ-150): операции основных экранов поверх `analyze` — протокол остаётся версии 1, прежние операции и их ответы не менялись. Запрос:
//   { v: 1, id, op: 'project', ws, query }          «Обзор»: result = { analysis, narrow }, narrow[режим] = { d: EpochDay, v: минимум остатка } (узкая точка режима)
//   { v: 1, id, op: 'waves',   ws, query }          «Волны»: result = { analysis, waves }, waves[режим] = list_waves_ex(analysis, режим) = { items, warnings }
//   { v: 1, id, op: 'afford',  ws, query, parts }   «Купить»: result = { cash_after }, cash_after[режим] = { v, d } — физические деньги после покупки `parts`
//                                                    ([{ date, amount_minor }]) поверх сценария `query.scenario` (как `cash_after` в app.mjs), узкая точка по режимам plan и worse
// `analysis` — ровно то, что вернул бы `analyze(ws, query)` на месте (JSON побайтно). Чистые функции `run_project`, `run_waves`, `run_afford` и `run_screen_op` вызывает и
// клиент как расчёт на месте при откате: воркер и главный поток считают одним и тем же кодом. Нарушение протокола (ws/query не объекты, parts не массив объектов) — `E_SCHEMA`
// с `ctx.reason = 'bad_arguments'`; ошибка движка — её код и контекст, как у `analyze`.
// Расчёт по введённым данным и правилам, не консультация.

import { analyze, ENGINE_VERSION, narrowest_point, list_waves_ex } from '../engine/index.mjs';

/** Версия протокола сообщений. */
export const PROTOCOL = 1;
/** Операции воркера (FP-12). */
export const OPS = Object.freeze(['hello', 'analyze']);
/** Операции основных экранов (FP-21): «Обзор», «Купить», «Волны». */
export const SCREEN_OPS = Object.freeze(['project', 'afford', 'waves']);

const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Режимы расчёта v1 (D-04), как `MODES` приложения: по ним считается «деньги после покупки». */
const AFFORD_MODES = Object.freeze(['plan', 'worse']);

/** Узкая точка ряда режима в форме экрана: `{ d, v }`. */
function narrow_of(a, mode) {
  const p = narrowest_point(a.series[mode], a.as_of, a.horizon_end);
  return { d: p.date, v: p.amount_minor };
}

/**
 * «Обзор»: расчёт `analyze` и узкая точка каждого посчитанного режима.
 * @param {object} ws
 * @param {object} query запрос `analyze`
 * @returns {{analysis: object, narrow: Object<string, {d: number, v: number}>}}
 * @throws {RunwayError} ошибка движка
 */
export function run_project(ws, query) {
  const analysis = analyze(ws, query);
  const narrow = {};
  for (const m of Object.keys(analysis.series)) narrow[m] = narrow_of(analysis, m);
  return { analysis, narrow };
}

/**
 * «Волны»: расчёт `analyze` и список волн каждого посчитанного режима (`list_waves_ex`).
 * @param {object} ws
 * @param {object} query
 * @returns {{analysis: object, waves: Object<string, {items: object[], warnings: object[]}>}}
 */
export function run_waves(ws, query) {
  const analysis = analyze(ws, query);
  const waves = {};
  for (const m of Object.keys(analysis.series)) waves[m] = list_waves_ex(analysis, m);
  return { analysis, waves };
}

/**
 * «Купить»: физические деньги после покупки — узкая точка рядов `analyze` при сценарии «базовые операции + покупка `parts`» (как `cash_after` в app.mjs).
 * @param {object} ws
 * @param {object} query запрос модели экрана (`{as_of}` или `{as_of, scenario: {ops}}`)
 * @param {{date: string, amount_minor: number}[]} parts части покупки
 * @returns {{cash_after: Object<string, {v: number, d: number}>}}
 */
export function run_afford(ws, query, parts) {
  const ops = [...(query.scenario?.ops ?? []), { op: 'add_purchase', parts }];
  const a = analyze(ws, { ...query, scenario: { ops } });
  const cash_after = {};
  for (const m of AFFORD_MODES) {
    const p = narrowest_point(a.series[m], a.as_of, a.horizon_end);
    cash_after[m] = { v: p.amount_minor, d: p.date };
  }
  return { cash_after };
}

/**
 * Выполнить операцию экрана на месте (то же, что делает воркер; откат клиента и тесты).
 * @param {'project'|'waves'|'afford'} op
 * @param {{ws: object, query: object, parts?: object[]}} args
 */
export function run_screen_op(op, args) {
  if (op === 'project') return run_project(args.ws, args.query);
  if (op === 'waves') return run_waves(args.ws, args.query);
  if (op === 'afford') return run_afford(args.ws, args.query, args.parts);
  throw new TypeError('неизвестная операция экрана');
}

function error_reply(id, op, code, ctx) {
  return { v: PROTOCOL, id, ok: false, op, engine_version: ENGINE_VERSION, error: { code, ctx } };
}

/**
 * Обработать одно сообщение страницы.
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
    if (op === 'analyze') {
      if (!is_obj(msg.ws) || !is_obj(msg.query)) return error_reply(id, op, 'E_SCHEMA', { reason: 'bad_arguments' });
      return { v: PROTOCOL, id, ok: true, op, engine_version: ENGINE_VERSION, result: analyze(msg.ws, msg.query) };
    }
    if (op === 'project' || op === 'waves' || op === 'afford') { // FP-21: операции экранов
      const parts_ok = op !== 'afford' || (Array.isArray(msg.parts) && msg.parts.length > 0 && msg.parts.every(is_obj));
      if (!is_obj(msg.ws) || !is_obj(msg.query) || !parts_ok) return error_reply(id, op, 'E_SCHEMA', { reason: 'bad_arguments' });
      return { v: PROTOCOL, id, ok: true, op, engine_version: ENGINE_VERSION, result: run_screen_op(op, msg) };
    }
    return error_reply(id, op, 'E_SCHEMA', { reason: 'unknown_op' });
  } catch (e) {
    if (e !== null && typeof e === 'object' && typeof e.code === 'string' && /^E_[A-Z_]+$/.test(e.code)) {
      return error_reply(id, op, e.code, is_obj(e.ctx) ? e.ctx : null);
    }
    return error_reply(id, op, 'E_SCHEMA', { reason: 'unexpected' });
  }
}

// ── запуск внутри воркера ───────────────────────────────────────────────────────────────────────────────────────────

const scope = globalThis;
if (typeof scope.WorkerGlobalScope === 'function' && scope instanceof scope.WorkerGlobalScope && typeof scope.postMessage === 'function') {
  scope.addEventListener('message', (ev) => { scope.postMessage(handle_message(ev.data)); });
  scope.postMessage({ v: PROTOCOL, ready: true, engine_version: ENGINE_VERSION });
}
