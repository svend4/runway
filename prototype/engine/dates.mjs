// dates.mjs — гражданские даты без часовых поясов, календари выходных и праздников, рабочие дни.
// Канон: design-brief §4 (days_from_civil / civil_from_days — Хиннант), ADR-003, ALG-01, canon-decisions (dates.mjs).
// Зависимости: только money. Никаких системных часов и таймзон: EpochDay — целое число дней от 1970-01-01 (= 0).

import { fail, floor_div, floor_mod } from './money.mjs';

/** @typedef {number} EpochDay  Целое число дней от 1970-01-01 (1970-01-01 = 0). */
/** @typedef {string} IsoDate   Календарная дата `YYYY-MM-DD`. */
/**
 * @typedef {object} Calendar
 * @property {number[]} weekend_dows дни недели выходных (0 = воскресенье … 6 = суббота), отсортированы
 * @property {IsoDate[]} holidays праздники, отсортированы, без дублей
 * @property {number} max_shift длиннейшая серия нерабочих дней подряд (для расширения окна развёртки)
 */
/** @typedef {'keep'|'prev'|'next'|'skip'} WeekendPolicy */

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Високосный ли год (григорианский календарь).
 * @param {number} y
 * @returns {boolean}
 */
export function is_leap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/**
 * Число дней в месяце.
 * @param {number} y год
 * @param {number} m месяц 1…12
 * @returns {number}
 */
export function days_in_month(y, m) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) fail('E_BAD_DATE', { y, m });
  return m === 2 && is_leap(y) ? 29 : DAYS_IN_MONTH[m - 1];
}

/**
 * Зажать день до длины месяца: `min(day, days_in_month(y, m))`.
 * @param {number} y
 * @param {number} m
 * @param {number} day
 * @returns {number}
 */
export function clamp_day(y, m, day) {
  return Math.min(day, days_in_month(y, m));
}

/**
 * Гражданская дата → EpochDay (алгоритм Хиннанта; верен для любых лет).
 * @param {number} y год
 * @param {number} m месяц 1…12
 * @param {number} d день 1…days_in_month
 * @returns {EpochDay}
 * @throws {RunwayError} E_BAD_DATE
 */
export function days_from_civil(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) fail('E_BAD_DATE', { y, m, d });
  if (m < 1 || m > 12 || d < 1 || d > days_in_month(y, m)) fail('E_BAD_DATE', { y, m, d });
  const yy = y - (m <= 2 ? 1 : 0);
  const era = floor_div(yy, 400);
  const yoe = yy - era * 400;
  const doy = floor_div(153 * (m + (m > 2 ? -3 : 9)) + 2, 5) + d - 1;
  const doe = yoe * 365 + floor_div(yoe, 4) - floor_div(yoe, 100) + doy;
  const z = era * 146097 + doe - 719468;
  // EpochDay вне safe-integer (era·146097 уходит за 2^53) — молча вернуть нельзя: дальше арифметика неточна
  if (!Number.isSafeInteger(z)) fail('E_OVERFLOW', { y: String(y), m, d });
  return z;
}

/**
 * EpochDay → гражданская дата. Результат — массив `[y, m, d]`, у которого есть и именованные поля `y`, `m`, `d`
 * (можно писать `const [y, m, d] = civil_from_days(z)` и `civil_from_days(z).y`).
 * @param {EpochDay} z
 * @returns {[number, number, number] & {y: number, m: number, d: number}}
 * @throws {RunwayError} E_BAD_DATE
 */
export function civil_from_days(z) {
  if (!Number.isSafeInteger(z)) fail('E_BAD_DATE', { z: String(z) });
  const zz = z + 719468;
  const era = floor_div(zz, 146097);
  const doe = zz - era * 146097;
  const yoe = floor_div(doe - floor_div(doe, 1460) + floor_div(doe, 36524) - floor_div(doe, 146096), 365);
  const y0 = yoe + era * 400;
  const doy = doe - (365 * yoe + floor_div(yoe, 4) - floor_div(yoe, 100));
  const mp = floor_div(5 * doy + 2, 153);
  const d = doy - floor_div(153 * mp + 2, 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const y = y0 + (m <= 2 ? 1 : 0);
  return Object.assign([y, m, d], { y, m, d });
}

/**
 * День недели: 0 = воскресенье … 6 = суббота; `dow(0) = 4` (четверг).
 * @param {EpochDay} d
 * @returns {number}
 */
export function dow(d) {
  return floor_mod(d + 4, 7);
}

/**
 * `YYYY-MM-DD` → EpochDay. Строгий разбор: ровно `dddd-dd-dd`, год ≥ 1, существующая дата.
 * @param {IsoDate} iso
 * @returns {EpochDay}
 * @throws {RunwayError} E_BAD_DATE
 */
export function parse_date(iso) {
  const m = typeof iso === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
  if (m === null) fail('E_BAD_DATE', { value: String(iso) });
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > days_in_month(y, mo)) fail('E_BAD_DATE', { value: iso });
  return days_from_civil(y, mo, d);
}

/**
 * EpochDay → `YYYY-MM-DD` (годы 1…9999).
 * @param {EpochDay} z
 * @returns {IsoDate}
 * @throws {RunwayError} E_BAD_DATE
 */
export function format_date(z) {
  const [y, m, d] = civil_from_days(z);
  if (y < 1 || y > 9999) fail('E_BAD_DATE', { z, year: y });
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

/**
 * Привести дату запроса к EpochDay: строка `YYYY-MM-DD` разбирается, целое число принимается как есть.
 * @param {IsoDate|EpochDay} x
 * @returns {EpochDay}
 */
export function to_epoch_day(x) {
  if (typeof x === 'string') return parse_date(x);
  if (!Number.isSafeInteger(x)) fail('E_BAD_DATE', { value: String(x) });
  return x;
}

/**
 * Прибавить месяцы: день берётся из ИСХОДНОЙ даты и зажимается до длины месяца (без дрейфа 31→28→28).
 * @param {EpochDay} d
 * @param {number} n может быть отрицательным
 * @returns {EpochDay}
 */
export function add_months(d, n) {
  const [y, m, day] = civil_from_days(d);
  const t = y * 12 + (m - 1) + n;
  if (!Number.isSafeInteger(t)) fail('E_OVERFLOW', { n: String(n) });
  const y2 = floor_div(t, 12);
  const m2 = floor_mod(t, 12) + 1;
  return days_from_civil(y2, m2, clamp_day(y2, m2, day));
}

/**
 * Прибавить годы (29 февраля → 28 февраля в невисокосном году).
 * @param {EpochDay} d
 * @param {number} n
 * @returns {EpochDay}
 */
export function add_years(d, n) {
  return add_months(d, 12 * n);
}

/**
 * Последний день месяца, в котором лежит `d`.
 * @param {EpochDay} d
 * @returns {EpochDay}
 */
export function end_of_month(d) {
  const [y, m] = civil_from_days(d);
  return days_from_civil(y, m, days_in_month(y, m));
}

/**
 * Разность в днях: `b − a` (> 0, если b позже a).
 * @param {EpochDay} a
 * @param {EpochDay} b
 * @returns {number}
 */
export function diff_days(a, b) {
  return b - a;
}

// ── календари ──────────────────────────────────────────────────────────────────

/** Кэш разобранных календарей (чистая мемоизация по идентичности объекта; календарь не мутируют). */
const COMPILED = new WeakMap();

/** @returns {{weekend: Set<number>, holidays: Set<EpochDay>}} */
function compile(cal) {
  let c = COMPILED.get(cal);
  if (c === undefined) {
    if (cal === null || typeof cal !== 'object') fail('E_SCHEMA', { reason: 'calendar_required' });
    const dows = cal.weekend_dows ?? [0, 6];
    if (!Array.isArray(dows) || dows.some((x) => !Number.isInteger(x) || x < 0 || x > 6)) {
      fail('E_RULE_INVALID', { field: 'weekend_dows', reason: 'not_0_6' });
    }
    const weekend = new Set(dows);
    if (weekend.size === 7) fail('E_RULE_INVALID', { field: 'weekend_dows', reason: 'no_business_days' });
    const hol = new Set((cal.holidays ?? []).map((h) => (typeof h === 'string' ? parse_date(h) : to_epoch_day(h))));
    c = { weekend, holidays: hol };
    COMPILED.set(cal, c);
  }
  return c;
}

/**
 * Построить календарь. Выходные по умолчанию — `[0, 6]`; семь выходных дней → `E_RULE_INVALID`.
 * @param {{weekend_dows?: number[], holidays?: IsoDate[]}} [spec]
 * @returns {Calendar}
 */
export function make_calendar(spec) {
  const { weekend_dows = [0, 6], holidays = [] } = spec ?? {};
  const probe = { weekend_dows, holidays };
  const { weekend, holidays: hol } = compile(probe);
  const hs = [...hol].sort((a, b) => a - b);
  const cal = {
    weekend_dows: [...weekend].sort((a, b) => a - b),
    holidays: hs.map(format_date),
    max_shift: 0,
  };
  const compiled = { weekend, holidays: new Set(hs) };
  COMPILED.set(cal, compiled);
  const lo = (hs.length ? hs[0] : 0) - 14;
  const hi = (hs.length ? hs[hs.length - 1] : 0) + 14;
  let run = 0;
  let best = 0;
  for (let x = lo; x <= hi; x++) {
    if (is_business(x, cal)) run = 0;
    else { run += 1; if (run > best) best = run; }
  }
  cal.max_shift = best;
  return Object.freeze(cal);
}

/** Кэш `max_shift` для «сырых» календарей (из журнала), у которых его нет. */
const SHIFTS = new WeakMap();

/**
 * Длиннейшая серия нерабочих дней подряд календаря (для расширения окна развёртки); для «сырого» календаря
 * без поля `max_shift` вычисляется один раз и кэшируется.
 * @param {Calendar|{weekend_dows?: number[], holidays?: IsoDate[]}} cal
 * @returns {number}
 */
export function max_shift_of(cal) {
  if (cal === null || typeof cal !== 'object') return 0; // нет календаря — нет и сдвигов (WeakMap не принимает null)
  if (Number.isInteger(cal.max_shift)) return cal.max_shift;
  let v = SHIFTS.get(cal);
  if (v === undefined) {
    v = make_calendar({ weekend_dows: cal?.weekend_dows, holidays: cal?.holidays }).max_shift;
    SHIFTS.set(cal, v);
  }
  return v;
}

/**
 * Рабочий ли день: не выходной по дню недели и не в списке праздников.
 * @param {EpochDay} d
 * @param {Calendar} cal
 * @returns {boolean}
 */
export function is_business(d, cal) {
  const c = compile(cal);
  return !c.weekend.has(dow(d)) && !c.holidays.has(d);
}

/**
 * Ближайший рабочий день `≥ d`.
 * @param {EpochDay} d
 * @param {Calendar} cal
 * @returns {EpochDay}
 */
export function next_business_day(d, cal) {
  let x = d;
  for (let i = 0; i < 100000 && !is_business(x, cal); i++) x += 1;
  return x;
}

/**
 * Ближайший рабочий день `≤ d`.
 * @param {EpochDay} d
 * @param {Calendar} cal
 * @returns {EpochDay}
 */
export function prev_business_day(d, cal) {
  let x = d;
  for (let i = 0; i < 100000 && !is_business(x, cal); i++) x -= 1;
  return x;
}

/**
 * n-й рабочий день месяца: n > 0 — с начала месяца, n < 0 — с конца (−1 = последний).
 * @param {number} y
 * @param {number} m
 * @param {number} n n ≠ 0
 * @param {Calendar} cal
 * @returns {EpochDay|null} `null`, если в месяце меньше |n| рабочих дней
 */
export function nth_business_day(y, m, n, cal) {
  if (!Number.isInteger(n) || n === 0) fail('E_RULE_INVALID', { field: 'by_workday', reason: 'n_zero_or_not_int', n: String(n) });
  const first = days_from_civil(y, m, 1);
  const last = first + days_in_month(y, m) - 1;
  let c = 0;
  if (n > 0) {
    for (let x = first; x <= last; x++) {
      if (is_business(x, cal)) { c += 1; if (c === n) return x; }
    }
  } else {
    for (let x = last; x >= first; x--) {
      if (is_business(x, cal)) { c += 1; if (c === -n) return x; }
    }
  }
  return null;
}

/**
 * Сдвиг даты по политике выходных: `keep` — как есть; `next`/`prev` — ближайший рабочий вперёд/назад;
 * `skip` — `null`, если день нерабочий.
 * @param {EpochDay} d
 * @param {WeekendPolicy} policy
 * @param {Calendar} cal
 * @returns {EpochDay|null}
 */
export function shift_by_policy(d, policy, cal) {
  switch (policy) {
    case 'keep': return d;
    case 'next': return next_business_day(d, cal);
    case 'prev': return prev_business_day(d, cal);
    case 'skip': return is_business(d, cal) ? d : null;
    default: return fail('E_SCHEMA', { reason: 'unknown_weekend_policy', value: String(policy) });
  }
}
