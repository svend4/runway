// scenario_ext.mjs — расширение операций сценария (FP-07, REQ-051): операция `hours{stream_id, minutes}` («часы по минимуму» и т. п.).
// Движок v1 знает семь операций сценария; `timeline.apply_scenario` на `hours` по умолчанию отвечает `E_SCHEMA op_not_in_v1` — и это
// не меняется: операция `hours` работает ТОЛЬКО через этот модуль. Модуль не правит `apply_scenario`, а заранее переводит `hours` в
// обычные операции `set_amount` над событиями потока (суммы считает тот же `hourly.expand_stream_ex`, что и расчёт, — одно округление за период,
// режим округления из `ws.params.rounding`), после чего сценарий проходит `apply_scenario` без исключений.
//
// Правила:
//   - `hours` — гипотеза о часах будущих периодов потока: `minutes` — ожидаемые минуты периода вместо `hours.exp_minutes` и `hours_by_period`;
//     период, закрытый с фактом (`actual_minutes`), не меняется (факт главнее гипотезы, D-19); переработка и ставка считаются как обычно;
//   - необязательные `from` / `to` (IsoDate начала периода) ограничивают периоды; без них — все периоды потока в горизонте;
//   - режим `worse` операцию не включает сам: сценарий с `hours` строит пользователь явно (REQ-051);
//   - операции `hours` переводятся в начало списка: сначала меняется план потока, затем действуют остальные операции сценария;
//   - рабочая область и сценарий не мутируются.
// Зависимости: money, dates, hourly, timeline, index. Модуль чистый: ни часов, ни случайности, ни ввода-вывода. Расчёт по введённым данным, не консультация.

import { fail, assert_minor } from './money.mjs';
import { to_epoch_day, format_date } from './dates.mjs';
import { period_bounds, expand_stream_ex } from './hourly.mjs';
import { build_events_ex, flat_params } from './timeline.mjs';
import { analyze } from './index.mjs';

/** Операции сценария, которые знает только это расширение. */
export const EXT_OPS = Object.freeze(['hours']);

/** Верхний предел минут в периоде: 31 сутки. */
export const HOURS_MINUTES_MAX = 31 * 24 * 60;

/** Запас дней назад от начала окна: окно развёртки шире окна модели, лишние события отсекаются по списку событий модели. */
const LOOKBACK_DAYS = 100;
/** Запас дней на сдвиг даты выплаты (как в `hourly`). */
const GUARD = 62;

/** Операция расширения (`hours`)? */
export function is_ext_op(op) {
  return op !== null && typeof op === 'object' && EXT_OPS.includes(op.op);
}

/** Есть ли в сценарии операции расширения. */
export function has_ext_ops(scenario) {
  return (scenario?.ops ?? []).some(is_ext_op);
}

function iso_or_fail(x, field) {
  try { return to_epoch_day(x); } catch { return fail('E_BAD_DATE', { reason: 'bad_' + field, value: String(x).slice(0, 40) }); }
}

/**
 * Проверить операцию `hours`.
 * @param {{op: 'hours', stream_id: string, minutes: number, from?: string, to?: string}} op
 * @returns {{op: 'hours', stream_id: string, minutes: number, from?: string, to?: string}} та же операция
 * @throws {RunwayError} E_SCHEMA (нет потока, минуты не целые или вне 0…44640), E_BAD_DATE
 */
export function validate_hours_op(op) {
  if (op === null || typeof op !== 'object' || op.op !== 'hours') fail('E_SCHEMA', { reason: 'not_hours_op' });
  if (typeof op.stream_id !== 'string' || op.stream_id === '' || op.stream_id.length > 200) fail('E_SCHEMA', { reason: 'hours_needs_stream_id' });
  if (!Number.isSafeInteger(op.minutes) || op.minutes < 0 || op.minutes > HOURS_MINUTES_MAX) fail('E_SCHEMA', { reason: 'bad_minutes', value: String(op.minutes).slice(0, 20) });
  if (op.from !== undefined) iso_or_fail(op.from, 'from');
  if (op.to !== undefined) iso_or_fail(op.to, 'to');
  if (op.from !== undefined && op.to !== undefined && iso_or_fail(op.to, 'to') < iso_or_fail(op.from, 'from')) fail('E_BAD_DATE', { reason: 'to_before_from' });
  return op;
}

/** Конец горизонта запроса: `horizon_end`, иначе `as_of + horizon_days` (запрос → параметры → умолчание). */
export function horizon_end_of(ws, query) {
  const as_of = to_epoch_day(query.as_of);
  if (query.horizon_end !== undefined && query.horizon_end !== null) return to_epoch_day(query.horizon_end);
  const days = query.horizon_days ?? flat_params(ws?.params).horizon_days;
  if (!Number.isSafeInteger(days) || days < 0) fail('E_SCHEMA', { reason: 'bad_horizon_days', value: String(days) });
  return as_of + days;
}

function calendar_spec(ws, stream) {
  if (stream.calendar_id === undefined || stream.calendar_id === null) return undefined;
  const hit = (ws.calendars ?? []).find((c) => c.calendar_id === stream.calendar_id);
  if (hit === undefined) fail('E_SCHEMA', { reason: 'unknown_calendar', calendar_id: String(stream.calendar_id) });
  return hit;
}

/**
 * Перевести одну операцию `hours` в операции `set_amount` над событиями потока, которые есть в модели.
 * @param {object} ws рабочая область
 * @param {{op: 'hours', stream_id: string, minutes: number, from?: string, to?: string}} op
 * @param {{as_of: string|number, horizon_end: string|number}} ctx
 * @returns {{op: 'set_amount', event_ref: string, amount_minor: number}[]} только события, сумма которых действительно меняется
 * @throws {RunwayError} E_SCHEMA (поток не найден, поток не проходит проверку), E_BAD_DATE
 */
export function hours_to_ops(ws, op, ctx) {
  validate_hours_op(op);
  const as_of = to_epoch_day(ctx.as_of);
  const hz = to_epoch_day(ctx.horizon_end);
  const stream = (ws.streams ?? []).find((s) => s.stream_id === op.stream_id);
  if (stream === undefined) return fail('E_SCHEMA', { reason: 'hours_unknown_stream', stream_id: op.stream_id });
  const from = op.from === undefined ? null : to_epoch_day(op.from);
  const to = op.to === undefined ? null : to_epoch_day(op.to);
  const by_period = { ...(stream.hours_by_period ?? {}) };
  let b = period_bounds(stream, as_of - LOOKBACK_DAYS - (stream.pay_lag_days ?? 0) - GUARD);
  let guard = 0;
  while (b.start <= hz + 1 && guard++ < 2000) {
    if ((from === null || b.start >= from) && (to === null || b.start <= to)) {
      const key = format_date(b.start);
      const old = by_period[key] ?? {};
      by_period[key] = {
        ...old,
        exp_minutes: op.minutes,
        min_minutes: Math.min(old.min_minutes ?? stream.hours.min_minutes, op.minutes),
        max_minutes: Math.max(old.max_minutes ?? stream.hours.max_minutes, op.minutes),
      };
    }
    b = period_bounds(stream, b.end + 1);
  }
  const rounding = flat_params(ws.params).rounding;
  const window = { from: as_of - LOOKBACK_DAYS, to: hz };
  const cal = calendar_spec(ws, stream);
  const base = expand_stream_ex(stream, window, cal, { rounding, as_of }).events;
  const next = new Map(expand_stream_ex({ ...stream, hours_by_period: by_period }, window, cal, { rounding, as_of }).events.map((e) => [e.cash_event_id, e]));
  // только события, которые есть в модели (после привязки фактов): иначе `set_amount` не найдёт событие
  const present = new Set(build_events_ex(ws, { as_of, horizon_end: hz, mode: 'plan' }).events
    .filter((e) => e.stream_id === op.stream_id).map((e) => e.cash_event_id));
  const out = [];
  for (const e of base) {
    if (e.stream_id !== op.stream_id || e.amount_minor <= 0 || !present.has(e.cash_event_id) || e.kind !== 'income') continue;
    const n = next.get(e.cash_event_id);
    if (n === undefined || n.amount_minor <= 0) continue; // период без выплаты (0 минут): событие остаётся как есть
    if (n.amount_minor !== e.amount_minor) out.push({ op: 'set_amount', event_ref: e.cash_event_id, amount_minor: assert_minor(n.amount_minor) });
  }
  return out;
}

/**
 * Развернуть операции расширения сценария в обычные операции движка.
 * @param {object} ws рабочая область
 * @param {{scenario_id?: string, ops: object[]}} scenario
 * @param {{as_of: string|number, horizon_end?: string|number, horizon_days?: number}} query
 * @returns {{scenario: {scenario_id?: string, ops: object[]}, expanded: number}} сценарий без `hours`; `expanded` — число операций `hours`
 * @throws {RunwayError} E_SCHEMA, E_BAD_DATE
 */
export function expand_scenario_ext(ws, scenario, query) {
  const ops = scenario?.ops ?? [];
  if (!ops.some(is_ext_op)) return { scenario, expanded: 0 };
  const ctx = { as_of: query.as_of, horizon_end: horizon_end_of(ws, query) };
  const lead = [];
  const rest = [];
  let n = 0;
  for (const op of ops) {
    if (is_ext_op(op)) { lead.push(...hours_to_ops(ws, op, ctx)); n += 1; } else rest.push(op);
  }
  return { scenario: { ...scenario, ops: [...lead, ...rest] }, expanded: n };
}

/**
 * `analyze` со сценарием, где допускается `hours`: тот же `Analysis`, что у `analyze`. Без операций расширения — прямой вызов `analyze`.
 * @param {object} ws
 * @param {object} query как у `analyze`
 * @returns {object} Analysis
 */
export function analyze_ext(ws, query) {
  if (!has_ext_ops(query.scenario)) return analyze(ws, query);
  const x = expand_scenario_ext(ws, query.scenario, query);
  return analyze(ws, { ...query, scenario: x.scenario });
}
