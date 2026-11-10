// hourly.mjs — почасовой и нерегулярный доход: ставка × минуты → плановые поступления (ALG-07).
// Канон: design-brief D-19, §3.6, §9.2, C-025…C-029, C-031, C-032, C-033, §14 B2; canon-decisions «Финальные сигнатуры» (hourly.mjs);
// wiki/algorithms/alg-07-hourly-income.md; ADR-002 (деньги), ADR-003 (даты).
// Зависимости: money, dates (слой hourly = слой recurrence: на recurrence не опирается, `occ_key` собирается здесь же).
// Чистые функции: часов и глобального `params` нет — режим округления приходит последним аргументом `opts = { rounding }` (B2).
// Время — целые МИНУТЫ; деньги — целые minor; одно округление за период (C-028). Это расчёт по введённым данным, не консультация.

import { fail, assert_minor, mul_div, floor_mod } from './money.mjs';
import {
  civil_from_days, days_from_civil, days_in_month, dow, format_date, parse_date, to_epoch_day, shift_by_policy, make_calendar,
} from './dates.mjs';

/** @typedef {import('./money.mjs').Minor} Minor */
/** @typedef {import('./money.mjs').RoundMode} RoundMode */
/** @typedef {import('./dates.mjs').EpochDay} EpochDay */
/** @typedef {import('./dates.mjs').Calendar} Calendar */
/**
 * Поток дохода `IncomeStream` (design-brief §3.6, v1.1).
 * @typedef {object} IncomeStream
 * @property {string} stream_id
 * @property {string} account_id
 * @property {string} name
 * @property {string} currency
 * @property {string} [counterparty_id]
 * @property {Minor} rate_minor ставка за ЧАС
 * @property {'month'|'week'|'biweek'} period
 * @property {{kind: 'month_end'|'weekday', weekday?: number, anchor?: string|EpochDay}} cutoff граница периода; `anchor` обязателен при `biweek` (C-026)
 * @property {number} pay_lag_days
 * @property {'keep'|'prev'|'next'} weekend `skip` для потока запрещён (C-032)
 * @property {{min_minutes: number, exp_minutes: number, max_minutes: number}} hours
 * @property {Object<string, {min_minutes?: number, exp_minutes?: number, max_minutes?: number, actual_minutes?: number}>} [hours_by_period] ключ — IsoDate начала периода
 * @property {number|null} [pace_minutes_per_day]
 * @property {{threshold_minutes: number, mult_bp: number}|null} [overtime] порог относится к периоду потока (C-027)
 * @property {Array<{date: string|EpochDay, amount_minor: Minor}>} [bonus]
 * @property {number|null} [delay_days_worse]
 */
/**
 * Опции округления (B2): режим берёт вызывающий из `ws.params.rounding`.
 * @typedef {object} HourlyOpts
 * @property {RoundMode} [rounding] по умолчанию `half_even`
 * @property {EpochDay|string} [as_of] «сегодня» для признака «период закрыт» и предупреждения о неподтверждённых часах;
 *   по умолчанию — `window.from`. Окно плана может начинаться раньше `as_of` (дата якоря счёта, C-004): без `as_of`
 *   прошлый, но ещё не оплаченный период считался бы незакрытым и введённый факт часов игнорировался.
 */

const PERIODS = ['month', 'week', 'biweek'];
/** Запас дней на сдвиг даты выплаты политикой выходных (ALG-07, GUARD). */
const GUARD = 62;

function int_ge(x, lo) {
  return typeof x === 'number' && Number.isSafeInteger(x) && x >= lo;
}

function rounding_of(opts) {
  return opts?.rounding ?? 'half_even';
}

/**
 * Брутто за период (одно округление, C-028).
 * Без переработки — `mul_div(rate, m, 60)`; с переработкой — `mul_div(rate, min(m,T)·10000 + max(0, m−T)·mult_bp, 60·10000)`;
 * взвешенные минуты ×10000 остаются точным целым и не округляются.
 * @param {Minor} rate_minor ставка за час (≥ 0)
 * @param {number} minutes минуты периода (≥ 0)
 * @param {{threshold_minutes: number, mult_bp: number}|null} [overtime]
 * @param {RoundMode} [rounding] по умолчанию `half_even`
 * @returns {Minor}
 * @throws {RunwayError} E_SCHEMA (отрицательные аргументы, плохая переработка), E_NOT_INTEGER, E_OVERFLOW
 */
export function gross_pay(rate_minor, minutes, overtime, rounding = 'half_even') {
  const rate = assert_minor(rate_minor);
  const m = assert_minor(minutes);
  if (rate < 0 || m < 0) fail('E_SCHEMA', { reason: 'negative_rate_or_minutes', rate_minor: rate, minutes: m });
  if (overtime === null || overtime === undefined) return mul_div(rate, m, 60, rounding);
  const t = assert_minor(overtime.threshold_minutes);
  const mult = assert_minor(overtime.mult_bp);
  if (t < 0 || mult < 0) fail('E_SCHEMA', { reason: 'bad_overtime', threshold_minutes: t, mult_bp: mult });
  const wx = BigInt(Math.min(m, t)) * 10000n + BigInt(Math.max(0, m - t)) * BigInt(mult);
  return mul_div(rate, wx, 600000, rounding);
}

/**
 * Период расчёта, содержащий дату `d`: `[start, end]`, `end` — граница периода.
 * `month`/`month_end` — календарный месяц; `week`/`weekday` — неделя, заканчивающаяся в `cutoff.weekday`;
 * `biweek`/`weekday` — две недели, граница чётности задана `cutoff.anchor` (C-026).
 * @param {IncomeStream} stream
 * @param {EpochDay|string} d
 * @returns {{start: EpochDay, end: EpochDay}}
 * @throws {RunwayError} E_SCHEMA (недопустимая пара period/cutoff, нет `anchor`)
 */
export function period_bounds(stream, d) {
  const day = to_epoch_day(d);
  const c = stream.cutoff;
  if (stream.period === 'month' && c?.kind === 'month_end') {
    const [y, m] = civil_from_days(day);
    const start = days_from_civil(y, m, 1);
    return { start, end: start + days_in_month(y, m) - 1 };
  }
  if (stream.period === 'week' && c?.kind === 'weekday') {
    if (!Number.isInteger(c.weekday) || c.weekday < 0 || c.weekday > 6) fail('E_SCHEMA', { reason: 'bad_cutoff_weekday', value: String(c.weekday) });
    const end = day + floor_mod(c.weekday - dow(day), 7);
    return { start: end - 6, end };
  }
  if (stream.period === 'biweek' && c?.kind === 'weekday') {
    if (!Number.isInteger(c.weekday) || c.weekday < 0 || c.weekday > 6) fail('E_SCHEMA', { reason: 'bad_cutoff_weekday', value: String(c.weekday) });
    if (c.anchor === undefined || c.anchor === null) fail('E_SCHEMA', { reason: 'biweek_needs_cutoff_anchor' });
    const anchor = to_epoch_day(c.anchor);
    if (dow(anchor) !== c.weekday) fail('E_SCHEMA', { reason: 'anchor_weekday_mismatch', anchor: format_date(anchor), weekday: c.weekday });
    let e = day + floor_mod(c.weekday - dow(day), 7);
    if (floor_mod(e - anchor, 14) !== 0) e += 7;
    return { start: e - 13, end: e };
  }
  return fail('E_SCHEMA', { reason: 'bad_period_cutoff_pair', period: String(stream.period), cutoff: String(c?.kind) });
}

/**
 * Дата выплаты: `shift_by_policy(period_end + pay_lag_days, weekend, cal)`. Номинальная дата (без сдвига) — ключ `occ_key`.
 * @param {EpochDay} period_end
 * @param {IncomeStream} stream
 * @param {Calendar} cal
 * @returns {EpochDay}
 * @throws {RunwayError} E_SCHEMA (политика `skip`: доход нельзя пропустить молча, C-032)
 */
export function pay_date(period_end, stream, cal) {
  const nominal = period_end + stream.pay_lag_days;
  const d = shift_by_policy(nominal, stream.weekend, cal ?? make_calendar({}));
  if (d === null) fail('E_SCHEMA', { reason: 'weekend_skip_forbidden_for_stream', stream_id: String(stream.stream_id) });
  return d;
}

/**
 * Ожидаемые минуты периода: переопределение `hours_by_period[start].exp_minutes` либо `hours.exp_minutes`.
 * @param {IncomeStream} stream
 * @param {{start: EpochDay}} b
 * @returns {number}
 */
export function planned_exp(stream, b) {
  const o = stream.hours_by_period?.[format_date(b.start)];
  return o?.exp_minutes ?? stream.hours.exp_minutes;
}

/**
 * Часы периода с учётом переопределений и факта: закрытый период с фактом схлопывается в `actual`;
 * идущий период поднимает диапазон снизу фактом «на сегодня»; `exp` всегда внутри `[min, max]`.
 * @param {IncomeStream} stream
 * @param {{start: EpochDay, end: EpochDay}} b
 * @param {EpochDay|string} as_of
 * @returns {{min: number, exp: number, max: number, actual: number|null, closed: boolean}}
 */
export function resolve_hours(stream, b, as_of) {
  const o = stream.hours_by_period?.[format_date(b.start)] ?? {};
  const h = {
    min: o.min_minutes ?? stream.hours.min_minutes,
    exp: planned_exp(stream, b),
    max: o.max_minutes ?? stream.hours.max_minutes,
  };
  const actual = o.actual_minutes ?? null;
  const closed = b.end < to_epoch_day(as_of);
  if (closed && actual !== null) return { min: actual, exp: actual, max: actual, actual, closed };
  if (actual !== null) {
    h.min = Math.max(h.min, actual);
    h.exp = Math.max(h.exp, actual);
    h.max = Math.max(h.max, actual);
  }
  h.min = Math.min(h.min, h.exp);
  h.max = Math.max(h.max, h.exp);
  return { min: h.min, exp: h.exp, max: h.max, actual, closed };
}

/**
 * Проверить поток. Не бросает: возвращает список ошибок `{code, field, reason}` (как `validate_tax_rule`).
 * Правила: `weekend ≠ skip` (C-032); `biweek` ⇒ `cutoff.anchor`, чей день недели = `cutoff.weekday` (C-026);
 * `0 ≤ min ≤ exp ≤ max` (и после слияния `hours_by_period`); порог переработки неотрицателен; бонус > 0.
 * Совпадение `stream_id` с `rule_id` (единое пространство Id, C-025) проверяет валидатор рабочей области.
 * @param {IncomeStream} s
 * @returns {{ok: boolean, errors: Array<{code: string, field: string, reason: string}>}}
 */
export function validate_stream(s) {
  const errors = [];
  const bad = (field, reason) => errors.push({ code: 'E_SCHEMA', field, reason });
  if (s === null || typeof s !== 'object') return { ok: false, errors: [{ code: 'E_SCHEMA', field: 'stream', reason: 'not_object' }] };
  if (typeof s.stream_id !== 'string' || s.stream_id === '') bad('stream_id', 'required');
  if (!int_ge(s.rate_minor, 0)) bad('rate_minor', 'int_ge_0');
  if (!int_ge(s.pay_lag_days, 0)) bad('pay_lag_days', 'int_ge_0');
  if (!PERIODS.includes(s.period)) bad('period', 'month_week_biweek');
  const ck = s.cutoff?.kind;
  const pair_ok = (s.period === 'month' && ck === 'month_end') || ((s.period === 'week' || s.period === 'biweek') && ck === 'weekday');
  if (PERIODS.includes(s.period) && !pair_ok) bad('cutoff', 'bad_period_cutoff_pair');
  if (ck === 'weekday' && !(Number.isInteger(s.cutoff.weekday) && s.cutoff.weekday >= 0 && s.cutoff.weekday <= 6)) bad('cutoff.weekday', 'int_0_6');
  if (s.period === 'biweek') {
    const a = s.cutoff?.anchor;
    if (a === undefined || a === null) bad('cutoff.anchor', 'required_for_biweek');
    else {
      let ad = null;
      try { ad = to_epoch_day(a); } catch { bad('cutoff.anchor', 'bad_date'); }
      if (ad !== null && dow(ad) !== s.cutoff.weekday) bad('cutoff.anchor', 'weekday_mismatch');
    }
  }
  if (s.weekend === 'skip') bad('weekend', 'skip_forbidden_for_stream');
  else if (!['keep', 'prev', 'next'].includes(s.weekend)) bad('weekend', 'keep_prev_next');
  const hrs = s.hours;
  const hours_ok = hrs !== null && typeof hrs === 'object' && int_ge(hrs.min_minutes, 0) && int_ge(hrs.exp_minutes, 0) && int_ge(hrs.max_minutes, 0)
    && hrs.min_minutes <= hrs.exp_minutes && hrs.exp_minutes <= hrs.max_minutes;
  if (!hours_ok) bad('hours', 'min_le_exp_le_max');
  if (hours_ok && s.hours_by_period !== undefined && s.hours_by_period !== null) {
    for (const [k, o] of Object.entries(s.hours_by_period)) {
      const mn = o?.min_minutes ?? hrs.min_minutes;
      const ex = o?.exp_minutes ?? hrs.exp_minutes;
      const mx = o?.max_minutes ?? hrs.max_minutes;
      if (!(int_ge(mn, 0) && int_ge(ex, 0) && int_ge(mx, 0) && mn <= ex && ex <= mx)) bad('hours_by_period.' + k, 'min_le_exp_le_max');
      if (o?.actual_minutes !== undefined && o.actual_minutes !== null && !int_ge(o.actual_minutes, 0)) bad('hours_by_period.' + k + '.actual_minutes', 'int_ge_0');
    }
  }
  if (s.overtime !== undefined && s.overtime !== null) {
    if (!int_ge(s.overtime.threshold_minutes, 0)) bad('overtime.threshold_minutes', 'int_ge_0');
    if (!int_ge(s.overtime.mult_bp, 0)) bad('overtime.mult_bp', 'int_ge_0');
  }
  if (s.pace_minutes_per_day !== undefined && s.pace_minutes_per_day !== null && !int_ge(s.pace_minutes_per_day, 0)) bad('pace_minutes_per_day', 'int_ge_0');
  if (s.delay_days_worse !== undefined && s.delay_days_worse !== null && !int_ge(s.delay_days_worse, 0)) bad('delay_days_worse', 'int_ge_0');
  // «bonus» не массив — ошибка формы, а не исключение: validate_stream обещает не бросать (REQ-158)
  if (s.bonus !== undefined && s.bonus !== null && !Array.isArray(s.bonus)) bad('bonus', 'not_array');
  for (const [i, x] of (Array.isArray(s.bonus) ? s.bonus : []).entries()) {
    if (!int_ge(x?.amount_minor, 1)) bad('bonus[' + i + '].amount_minor', 'int_ge_1');
    try { to_epoch_day(x?.date); } catch { bad('bonus[' + i + '].date', 'bad_date'); }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Развернуть поток в плановые события дохода и вернуть вместе с предупреждениями.
 * Предупреждения: `W_HOURS_NOT_CONFIRMED` (закрытый период без факта — берётся `exp`), `W_HOURS_KEY_IGNORED`
 * (ключ `hours_by_period` не совпал с началом периода — игнорируется; код вне реестра §2.0, см. отчёт).
 * @param {IncomeStream} stream
 * @param {{from: EpochDay, to: EpochDay}} window `as_of .. horizon_end`
 * @param {Calendar} cal
 * @param {HourlyOpts} [opts]
 * @returns {{events: object[], warnings: Array<{code: string, stream_id: string, period_start?: string, key?: string}>}}
 * @throws {RunwayError} E_SCHEMA (поток не прошёл `validate_stream`)
 */
export function expand_stream_ex(stream, window, cal, opts) {
  const v = validate_stream(stream);
  if (!v.ok) fail('E_SCHEMA', { reason: 'invalid_stream', stream_id: String(stream?.stream_id), errors: v.errors });
  const rounding = rounding_of(opts);
  const calendar = cal ?? make_calendar({});
  const w_from = to_epoch_day(window.from);
  const w_to = to_epoch_day(window.to);
  const today = opts?.as_of === undefined || opts?.as_of === null ? w_from : to_epoch_day(opts.as_of);
  const ot = stream.overtime ?? null;
  const out = [];
  const warnings = [];
  const seen_starts = new Set();
  let b = period_bounds(stream, w_from - stream.pay_lag_days - GUARD);
  for (;;) {
    if (b.end + stream.pay_lag_days - GUARD > w_to) break;
    const nominal = b.end + stream.pay_lag_days;
    const pd = pay_date(b.end, stream, calendar);
    seen_starts.add(format_date(b.start));
    if (w_from <= pd && pd <= w_to) { // прошлые выплаты — это posted, они в opening
      const hr = resolve_hours(stream, b, today); // «закрыт» — от as_of, а не от начала окна (баг C-B1)
      if (hr.closed && hr.actual === null && pd >= today) warnings.push({ code: 'W_HOURS_NOT_CONFIRMED', stream_id: stream.stream_id, period_start: format_date(b.start) });
      const g = {
        min: gross_pay(stream.rate_minor, hr.min, ot, rounding),
        exp: gross_pay(stream.rate_minor, hr.exp, ot, rounding),
        max: gross_pay(stream.rate_minor, hr.max, ot, rounding),
      };
      if (g.exp > 0) {
        const key = stream.stream_id + '@' + format_date(nominal);
        out.push(make_event(stream, key, pd, g.exp, g.min, g.max));
      }
    }
    b = period_bounds(stream, b.end + 1);
  }
  for (const x of stream.bonus ?? []) {
    const d = to_epoch_day(x.date);
    if (w_from <= d && d <= w_to) {
      const key = stream.stream_id + '@bonus@' + format_date(d); // дата бонуса — как введена: без лага и сдвига
      out.push(make_event(stream, key, d, x.amount_minor, x.amount_minor, x.amount_minor));
    }
  }
  for (const k of Object.keys(stream.hours_by_period ?? {}).sort()) {
    let ok = false;
    try { const d = parse_date(k); ok = period_bounds(stream, d).start === d; } catch { ok = false; }
    if (!ok) warnings.push({ code: 'W_HOURS_KEY_IGNORED', stream_id: stream.stream_id, key: k });
  }
  out.sort(compare_events);
  return { events: out, warnings };
}

/** Событие дохода потока (CashEvent, §3.4): `stream_id`, `rule_id = null`, `tag = stream.name`, `occ_key = stream_id@номинальная_дата`. */
function make_event(stream, key, date, amount, amount_min, amount_max) {
  const e = {
    cash_event_id: key,
    layer: 'planned',
    account_id: stream.account_id,
    date,
    amount_minor: amount,
    currency: stream.currency,
    kind: 'income',
    tag: stream.name,
    status: 'expected',
    rule_id: null,
    stream_id: stream.stream_id,
    occ_key: key,
    is_obligation: false,
    is_estimate: false,
    is_exceptional: false,
    amount_min_minor: amount_min,
    amount_max_minor: amount_max,
  };
  if (stream.delay_days_worse !== undefined && stream.delay_days_worse !== null) e.delay_days_worse = stream.delay_days_worse;
  if (stream.counterparty_id !== undefined && stream.counterparty_id !== null) e.counterparty_id = stream.counterparty_id;
  return e;
}

function compare_events(x, y) {
  if (x.date !== y.date) return x.date - y.date;
  if (x.amount_minor !== y.amount_minor) return x.amount_minor - y.amount_minor;
  return x.cash_event_id < y.cash_event_id ? -1 : x.cash_event_id > y.cash_event_id ? 1 : 0;
}

/**
 * Развернуть поток в плановые события дохода: по одному на выплату в окне (`amount_minor = gross(exp)`,
 * коридор `amount_min_minor`/`amount_max_minor`) и по одному на бонус. Отсортированы по `(date, amount_minor, cash_event_id)`.
 * Предупреждения — в `expand_stream_ex`.
 * @param {IncomeStream} stream
 * @param {{from: EpochDay, to: EpochDay}} window
 * @param {Calendar} cal
 * @param {HourlyOpts} [opts] `{ rounding }` из `ws.params.rounding` (B2)
 * @returns {object[]} CashEvent[]
 */
export function expand_stream(stream, window, cal, opts) {
  return expand_stream_ex(stream, window, cal, opts).events;
}

/**
 * План часов к дате: темп `pace_minutes_per_day` (если задан) либо `exp / дни периода`; `as_of` входит в «прошло».
 * @param {IncomeStream} stream
 * @param {{start: EpochDay, end: EpochDay, exp_minutes?: number}} period `exp_minutes` по умолчанию — `planned_exp`
 * @param {EpochDay|string} as_of
 * @param {HourlyOpts} [opts]
 * @returns {number} минуты
 */
export function plan_to_date(stream, period, as_of, opts) {
  const days = period.end - period.start + 1;
  const asof = to_epoch_day(as_of);
  const elapsed = Math.min(Math.max(asof - period.start + 1, 0), days);
  const exp = period.exp_minutes ?? planned_exp(stream, period);
  if (stream.pace_minutes_per_day !== undefined && stream.pace_minutes_per_day !== null) {
    // Q-19, К-10: темп не уводит план выше ожидания периода (инвариант 7 ALG-07); закрытый период (as_of > end) — ровно exp, открытый — min
    if (asof > period.end) return exp;
    return Math.min(stream.pace_minutes_per_day * elapsed, exp);
  }
  return mul_div(exp, elapsed, days, rounding_of(opts));
}

/**
 * Недоработка: `short = plan_to_date − actual` (> 0 — недоработка, < 0 — опережение), эффект по базовой ставке,
 * оценка `est = actual + max(0, exp − plan)` (в v1 `ρ = 1`, это отображаемая оценка, `exp_minutes` не меняет, C-033).
 * @param {IncomeStream} stream
 * @param {{start: EpochDay, end: EpochDay, exp_minutes?: number}} period
 * @param {EpochDay|string} as_of
 * @param {number} actual_minutes факт часов «на сегодня»
 * @param {HourlyOpts} [opts]
 * @returns {{short_minutes: number, effect_minor: Minor, est_minutes: number, est_gross_minor: Minor}}
 */
export function shortfall(stream, period, as_of, actual_minutes, opts) {
  const rounding = rounding_of(opts);
  const actual = assert_minor(actual_minutes);
  if (actual < 0) fail('E_SCHEMA', { reason: 'negative_actual_minutes', value: actual });
  const exp = period.exp_minutes ?? planned_exp(stream, period);
  const plan = plan_to_date(stream, { ...period, exp_minutes: exp }, as_of, opts);
  const short = plan - actual;
  const est = actual + Math.max(0, exp - plan);
  return {
    short_minutes: short,
    effect_minor: mul_div(short, stream.rate_minor, 60, rounding),
    est_minutes: est,
    est_gross_minor: gross_pay(stream.rate_minor, est, stream.overtime ?? null, rounding),
  };
}
