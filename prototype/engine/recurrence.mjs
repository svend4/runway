// recurrence.mjs — развёртка правил повторения в вхождения (ALG-01).
// Канон: design-brief §3.5, §9.10, C-001…C-003, C-025; страница wiki/algorithms/alg-01-recurrence-expansion.md.
// Зависимости: money, dates. Чистые функции; номинальные даты считаются только от `start_date` (без дрейфа).

import { fail, ceil_div, floor_div, floor_mod, assert_minor } from './money.mjs';
import {
  parse_date, format_date, civil_from_days, days_from_civil, days_in_month, dow, make_calendar, max_shift_of,
  nth_business_day, shift_by_policy, to_epoch_day,
} from './dates.mjs';

/** @typedef {import('./dates.mjs').EpochDay} EpochDay */
/** @typedef {import('./dates.mjs').Calendar} Calendar */
/**
 * @typedef {object} Rule
 * @property {string} rule_id
 * @property {string} [account_id]
 * @property {'income'|'expense'} kind
 * @property {{exp_minor: number, min_minor?: number, max_minor?: number}} amount со знаком, согласован с `kind`
 * @property {string} [currency]
 * @property {'D'|'W'|'M'|'Y'} freq
 * @property {number} interval ≥ 1
 * @property {number[]} [by_weekday] 0 = вс … 6 = сб; только при `W`
 * @property {number[]} [by_monthday] 1…31, отрицательные — с конца; только при `M`
 * @property {number[]} [by_workday] n-й рабочий день, отрицательные — с конца; только при `M`
 * @property {string} start_date IsoDate
 * @property {string} [until_date] IsoDate
 * @property {number} [count]
 * @property {'clamp'|'skip'|'next_first'} [month_end]
 * @property {'keep'|'prev'|'next'|'skip'} [weekend]
 * @property {string|null} [calendar_id]
 * @property {string[]} [exdates] IsoDate (номинальные)
 * @property {boolean} [is_obligation]
 * @property {boolean} [is_estimate]
 * @property {string} [tag]
 * @property {string} [counterparty_id]
 * @property {number} [delay_days_worse]
 * @property {string} [reserve_id]
 */
/**
 * @typedef {object} Override
 * @property {string} rule_id
 * @property {string} nominal_date IsoDate
 * @property {'move'|'skip'|'set_amount'} action
 * @property {string} [date] IsoDate (для `move`)
 * @property {number} [amount_minor] (для `set_amount`)
 */
/**
 * @typedef {object} Occurrence
 * @property {string} occ_key `rule_id@номинальная_дата`
 * @property {string} rule_id
 * @property {EpochDay} nominal
 * @property {EpochDay} date эффективная дата
 * @property {number} amount_minor
 * @property {number} [amount_min_minor]
 * @property {number} [amount_max_minor]
 * @property {string} [currency]
 * @property {string} [account_id]
 * @property {'income'|'expense'} kind
 * @property {boolean} is_obligation
 * @property {boolean} is_estimate
 * @property {string} tag
 * @property {string} [counterparty_id]
 * @property {number} [delay_days_worse]
 * @property {string} [reserve_id]
 * @property {boolean} overridden
 */

const FREQS = ['D', 'W', 'M', 'Y'];
const MONTH_END = ['clamp', 'skip', 'next_first'];
const WEEKEND = ['keep', 'prev', 'next', 'skip'];
const OVERRIDE_ACTIONS = ['move', 'skip', 'set_amount'];

function is_iso_date(s) {
  if (typeof s !== 'string') return false;
  try { parse_date(s); return true; } catch { return false; }
}

/**
 * Проверить правило. Не бросает: возвращает список ошибок `{code: 'E_RULE_INVALID', field, reason}`.
 * @param {Rule} r
 * @returns {{ok: boolean, errors: Array<{code: string, field: string, reason: string}>}}
 */
export function validate_rule(r) {
  const errors = [];
  const bad = (field, reason) => errors.push({ code: 'E_RULE_INVALID', field, reason });
  if (r === null || typeof r !== 'object') return { ok: false, errors: [{ code: 'E_RULE_INVALID', field: 'rule', reason: 'not_object' }] };
  if (typeof r.rule_id !== 'string' || r.rule_id === '') bad('rule_id', 'required');
  if (!FREQS.includes(r.freq)) bad('freq', 'not_D_W_M_Y');
  if (!Number.isInteger(r.interval) || r.interval < 1) bad('interval', 'int_ge_1');
  if (!is_iso_date(r.start_date)) bad('start_date', 'bad_date');
  if (r.until_date != null) {
    if (!is_iso_date(r.until_date)) bad('until_date', 'bad_date');
    else if (is_iso_date(r.start_date) && r.until_date < r.start_date) bad('until_date', 'before_start');
  }
  if (r.exdates != null) {
    if (!Array.isArray(r.exdates) || r.exdates.some((x) => !is_iso_date(x))) bad('exdates', 'bad_date_list');
  }
  if (r.count != null && (!Number.isInteger(r.count) || r.count < 1)) bad('count', 'int_ge_1');
  if (r.month_end != null && !MONTH_END.includes(r.month_end)) bad('month_end', 'unknown');
  if (r.weekend != null && !WEEKEND.includes(r.weekend)) bad('weekend', 'unknown');
  if (r.delay_days_worse != null && (!Number.isInteger(r.delay_days_worse) || r.delay_days_worse < 0)) bad('delay_days_worse', 'int_ge_0');

  const set_ok = (arr, lo, hi, nonzero) => Array.isArray(arr) && arr.length > 0
    && arr.every((v) => Number.isInteger(v) && v >= lo && v <= hi && (!nonzero || v !== 0));
  if (r.by_weekday != null) {
    if (r.freq !== 'W') bad('by_weekday', 'only_for_W');
    if (!set_ok(r.by_weekday, 0, 6, false)) bad('by_weekday', 'nonempty_set_0_6');
  }
  if (r.by_monthday != null) {
    if (r.freq !== 'M') bad('by_monthday', 'only_for_M');
    if (!set_ok(r.by_monthday, -31, 31, true)) bad('by_monthday', 'nonempty_nonzero_abs_le_31');
  }
  if (r.by_workday != null) {
    if (r.freq !== 'M') bad('by_workday', 'only_for_M');
    if (!set_ok(r.by_workday, -31, 31, true)) bad('by_workday', 'nonempty_nonzero_abs_le_31');
    if (r.by_monthday != null) bad('by_workday', 'exclusive_with_by_monthday');
  }
  if (r.freq === 'Y' && (r.by_weekday != null || r.by_monthday != null || r.by_workday != null)) bad('freq', 'Y_without_by');

  const a = r.amount;
  if (a === null || typeof a !== 'object') bad('amount', 'required');
  else {
    if (r.kind !== 'income' && r.kind !== 'expense') bad('kind', 'not_income_expense');
    const sign = r.kind === 'expense' ? -1 : 1;
    const money = (field, v) => {
      if (!Number.isSafeInteger(v)) { bad(field, 'not_safe_integer'); return false; }
      if (v === 0) { bad(field, 'zero'); return false; }
      if (r.kind === 'income' || r.kind === 'expense') {
        if (Math.sign(v) !== sign) { bad(field, 'sign_mismatch_kind'); return false; }
      }
      return true;
    };
    const exp_ok = money('amount.exp_minor', a.exp_minor);
    const min_ok = a.min_minor == null ? true : money('amount.min_minor', a.min_minor);
    const max_ok = a.max_minor == null ? true : money('amount.max_minor', a.max_minor);
    if (exp_ok && min_ok && a.min_minor != null && a.min_minor > a.exp_minor) bad('amount', 'min_gt_exp');
    if (exp_ok && max_ok && a.max_minor != null && a.exp_minor > a.max_minor) bad('amount', 'exp_gt_max');
    if (min_ok && max_ok && a.min_minor != null && a.max_minor != null && a.min_minor > a.max_minor) bad('amount', 'min_gt_max');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Проверить правку вхождения (Q-17, К-5). Не бросает: список ошибок `{code: 'E_SCHEMA', field, reason}`.
 * `set_amount`: целое ≠ 0, знак как у суммы правила (`kind = expense` → отрицательная, `income` → положительная; сценарная `set_amount`
 * проверяет знак так же). Правка без правила (`rule` не передан) проверяется только по форме. Движок на уже записанных журналах поведение
 * не меняет: функцию вызывает слой записи (`validate_ws`, `ws_edit`) — до решения по К-5 это проверка, а не отказ расчёта.
 * @param {Override} o
 * @param {Rule} [rule] правило, к которому относится правка (по `o.rule_id`)
 * @returns {{ok: boolean, errors: Array<{code: string, field: string, reason: string}>}}
 */
export function validate_override(o, rule) {
  const errors = [];
  const bad = (field, reason) => errors.push({ code: 'E_SCHEMA', field, reason });
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return { ok: false, errors: [{ code: 'E_SCHEMA', field: 'override', reason: 'not_object' }] };
  if (typeof o.rule_id !== 'string' || o.rule_id === '') bad('rule_id', 'required');
  if (!is_iso_date(o.nominal_date)) bad('nominal_date', 'bad_date');
  if (!OVERRIDE_ACTIONS.includes(o.action)) bad('action', 'unknown');
  if (o.action === 'move' && !is_iso_date(o.date)) bad('date', 'bad_date');
  if (o.action === 'set_amount') {
    if (!Number.isSafeInteger(o.amount_minor)) bad('amount_minor', 'not_safe_integer');
    else if (o.amount_minor === 0) bad('amount_minor', 'zero');
    else if (rule != null && (rule.kind === 'income' || rule.kind === 'expense') && Math.sign(o.amount_minor) !== (rule.kind === 'expense' ? -1 : 1)) bad('amount_minor', 'override_sign');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Ключ вхождения: `(rule_id | stream_id) + '@' + номинальная_дата`; не меняется при сдвигах и переносах.
 * @param {string} rule_id_or_stream_id
 * @param {EpochDay} nominal
 * @returns {string}
 */
export function occ_key(rule_id_or_stream_id, nominal) {
  return rule_id_or_stream_id + '@' + format_date(nominal);
}

function step_months(r) {
  return (r.freq === 'Y' ? 12 : 1) * r.interval;
}

function week_monday(d) {
  return d - floor_mod(dow(d) - 1, 7);
}

function sort_unique(xs) {
  return [...new Set(xs)].sort((a, b) => a - b);
}

/** Блок k серии: день / неделя / месяц / год. Даты блока возрастают, без дублей, ≥ s. */
function block_dates(r, s, k, cal) {
  if (r.freq === 'D') {
    const d = s + k * r.interval;
    return { lo: d, dates: [d] };
  }
  if (r.freq === 'W') {
    if (r.by_weekday == null) {
      const d = s + 7 * r.interval * k;
      return { lo: d, dates: [d] };
    }
    const b = week_monday(s) + 7 * r.interval * k;
    const ds = sort_unique(r.by_weekday.map((w) => b + floor_mod(w - 1, 7)));
    return { lo: b, dates: ds.filter((x) => x >= s) };
  }
  const [ys, ms, d0] = civil_from_days(s);
  const t = ys * 12 + (ms - 1) + k * step_months(r);
  // блок за пределами безопасного диапазона (огромный interval): дат в нём не может быть ни в каком окне — серия закончилась
  if (!Number.isSafeInteger(t)) return { lo: Infinity, dates: [] };
  const y = floor_div(t, 12);
  const m = floor_mod(t, 12) + 1;
  const dim = days_in_month(y, m);
  const cand = [];
  if (r.by_workday != null) {
    for (const n of r.by_workday) {
      const x = nth_business_day(y, m, n, cal);
      if (x !== null) cand.push(x);
    }
  } else {
    for (const v of (r.by_monthday ?? [d0])) {
      if (v < 0) {
        const day = dim + 1 + v;
        if (day >= 1) cand.push(days_from_civil(y, m, day));
      } else if (v <= dim) {
        cand.push(days_from_civil(y, m, v));
      } else {
        const policy = r.month_end ?? 'clamp';
        if (policy === 'clamp') cand.push(days_from_civil(y, m, dim));
        else if (policy === 'next_first') cand.push(days_from_civil(y, m, dim) + 1);
        // skip — месяца без такого дня нет
      }
    }
  }
  const lo = days_from_civil(y, r.freq === 'Y' ? 1 : m, 1);
  return { lo, dates: sort_unique(cand).filter((x) => x >= s) };
}

/** С какого блока начинать обход: O(1), без прохода по истории (при `count` — с начала серии). */
function first_block(r, s, from) {
  if (r.count != null || from <= s) return 0;
  if (r.freq === 'D') return ceil_div(from - s, r.interval);
  if (r.freq === 'W') {
    return r.by_weekday == null
      ? ceil_div(from - s, 7 * r.interval)
      : Math.max(0, floor_div(from - week_monday(s), 7 * r.interval));
  }
  const [yf, mf] = civil_from_days(from);
  const [ys, ms] = civil_from_days(s);
  const delta = (yf * 12 + mf - 1) - (ys * 12 + ms - 1);
  return Math.max(0, floor_div(delta, step_months(r)) - 1); // −1: next_first переносит дату вперёд
}

/**
 * Номинальные даты правила в окне `[from, to]` (даты до сдвигов выходных и override).
 * `until_date` и `count` относятся к номинальной дате; `count` считает даты после `month_end` и до `exdates`.
 * @param {Rule} r
 * @param {EpochDay} from
 * @param {EpochDay} to
 * @param {Calendar} [cal] обязателен при `by_workday`, иначе `E_SCHEMA`
 * @returns {EpochDay[]} строго возрастающий список без дублей
 * @throws {RunwayError} E_RULE_INVALID, E_SCHEMA
 */
export function nominal_dates(r, from, to, cal) {
  const v = validate_rule(r);
  if (!v.ok) fail('E_RULE_INVALID', { errors: v.errors });
  if (r.by_workday != null && (cal === undefined || cal === null)) fail('E_SCHEMA', { reason: 'calendar_required_for_by_workday' });
  const f = to_epoch_day(from);
  const t = to_epoch_day(to);
  const s = parse_date(r.start_date);
  const hi = r.until_date != null ? Math.min(t, parse_date(r.until_date)) : t;
  if (hi < f || hi < s) return [];
  const out = [];
  let produced = 0;
  let last = -Infinity;
  for (let k = first_block(r, s, f); ; k++) {
    const { lo, dates } = block_dates(r, s, k, cal);
    if (lo > hi) return out;
    for (const d of dates) {
      if (d <= last) continue; // дубль (next_first / clamp)
      if (d > hi) return out;
      last = d;
      produced += 1;
      if (r.count != null && produced > r.count) return out;
      if (d >= f) out.push(d);
    }
  }
}

/**
 * Построить индекс правок по `occ_key` (при повторе ключа побеждает последний).
 * Принимает массив `Override[]`, готовый `Map` или обычный объект `occ_key → Override`.
 * @param {Override[]|Map<string, Override>|Record<string, Override>|null|undefined} overrides
 * @returns {Map<string, Override>}
 */
export function index_overrides(overrides) {
  const idx = new Map();
  if (overrides == null) return idx;
  if (overrides instanceof Map) {
    for (const [k, o] of overrides) idx.set(k, o);
    return idx;
  }
  if (Array.isArray(overrides)) {
    for (const o of overrides) {
      if (!OVERRIDE_ACTIONS.includes(o?.action)) fail('E_SCHEMA', { reason: 'unknown_override_action', value: String(o?.action) });
      idx.set(occ_key(o.rule_id, parse_date(o.nominal_date)), o); // последний побеждает
    }
    return idx;
  }
  for (const k of Object.keys(overrides).sort()) idx.set(k, overrides[k]);
  return idx;
}

/**
 * Эффективная дата вхождения: `move` задаёт дату точно (без повторного сдвига), `skip` → `null`,
 * `set_amount` дату не трогает; иначе сдвиг по политике выходных правила.
 * @param {Rule} rule
 * @param {EpochDay} nominal
 * @param {Calendar|null} cal
 * @param {Override[]|Map<string, Override>|Record<string, Override>} overrides массив или индекс по `occ_key`
 * @returns {EpochDay|null}
 */
export function effective_date(rule, nominal, cal, overrides) {
  const o = index_overrides(overrides).get(occ_key(rule.rule_id, nominal));
  return effective_date_idx(rule, nominal, cal, o);
}

function effective_date_idx(rule, nominal, cal, o) {
  if (o !== undefined) {
    if (o.action === 'skip') return null;
    if (o.action === 'move') {
      if (o.date == null) fail('E_SCHEMA', { reason: 'move_without_date', rule_id: rule.rule_id });
      return parse_date(o.date); // точно, без сдвига выходных
    }
  }
  const policy = rule.weekend ?? 'keep';
  if (policy !== 'keep' && (cal === undefined || cal === null)) fail('E_SCHEMA', { reason: 'calendar_required_for_weekend_policy' });
  return shift_by_policy(nominal, policy, cal);
}

function compare_occ(a, b) {
  if (a.date !== b.date) return a.date - b.date;
  if (a.amount_minor !== b.amount_minor) return a.amount_minor - b.amount_minor;
  return a.occ_key < b.occ_key ? -1 : a.occ_key > b.occ_key ? 1 : 0;
}

function expand_rule_idx(rule, window, cal, mine) {
  const v = validate_rule(rule);
  if (!v.ok) fail('E_RULE_INVALID', { errors: v.errors });
  const w_from = to_epoch_day(window.from);
  const w_to = to_epoch_day(window.to);
  // ошибка не должна зависеть от окна: календарь нужен, как только правило сдвигается по выходным
  if ((rule.weekend ?? 'keep') !== 'keep' && cal == null) fail('E_SCHEMA', { reason: 'calendar_required_for_weekend_policy', rule_id: rule.rule_id });
  let move = 0;
  for (const o of mine.values()) {
    if (o.action === 'move' && o.date != null) {
      move = Math.max(move, Math.abs(parse_date(o.date) - parse_date(o.nominal_date)));
    }
  }
  const max_shift = cal == null ? 0 : max_shift_of(cal);
  const pad = max_shift + move; // вхождение с эффективной датой в окне имеет номинальную в [from − pad, to + pad]
  const ex = new Set((rule.exdates ?? []).map(parse_date));
  const out = [];
  for (const n of nominal_dates(rule, w_from - pad, w_to + pad, cal)) {
    if (ex.has(n)) continue;
    const key = occ_key(rule.rule_id, n);
    const o = mine.get(key);
    const d = effective_date_idx(rule, n, cal, o);
    if (d === null || d < w_from || d > w_to) continue;
    let amt = rule.amount;
    if (o !== undefined && o.action === 'set_amount') {
      amt = { exp_minor: assert_minor(o.amount_minor) }; // коридор снимается
    }
    /** @type {Occurrence} */
    const occ = {
      occ_key: key,
      rule_id: rule.rule_id,
      nominal: n,
      date: d,
      amount_minor: amt.exp_minor,
      kind: rule.kind,
      is_obligation: rule.is_obligation === true,
      is_estimate: rule.is_estimate === true,
      tag: rule.tag ?? '',
      overridden: o !== undefined,
    };
    if (amt.min_minor != null) occ.amount_min_minor = amt.min_minor;
    if (amt.max_minor != null) occ.amount_max_minor = amt.max_minor;
    if (rule.currency != null) occ.currency = rule.currency;
    if (rule.account_id != null) occ.account_id = rule.account_id;
    if (rule.counterparty_id != null) occ.counterparty_id = rule.counterparty_id;
    if (rule.delay_days_worse != null) occ.delay_days_worse = rule.delay_days_worse;
    if (rule.reserve_id != null) occ.reserve_id = rule.reserve_id;
    out.push(occ);
  }
  return out.sort(compare_occ); // вхождения одного дня НЕ сливаются
}

function mine_of(rule, overrides) {
  const mine = new Map();
  for (const [k, o] of index_overrides(overrides)) {
    if (o.rule_id === rule.rule_id) mine.set(k, o);
  }
  return mine;
}

/**
 * Развернуть правило в вхождения с эффективной датой в окне.
 * @param {Rule} rule
 * @param {{from: EpochDay, to: EpochDay}} window
 * @param {Calendar|null} cal
 * @param {Override[]|Map<string, Override>} overrides
 * @returns {Occurrence[]} отсортирован по `(date, amount_minor, occ_key)`
 */
export function expand_rule(rule, window, cal, overrides) {
  return expand_rule_idx(rule, window, cal, mine_of(rule, overrides));
}

/**
 * Развернуть набор правил. `calendars` — объект/Map/массив календарей по `calendar_id`;
 * правило без `calendar_id` использует календарь «суббота и воскресенье, без праздников».
 * @param {Rule[]} rules
 * @param {{from: EpochDay, to: EpochDay}} window
 * @param {Record<string, Calendar>|Map<string, Calendar>|Array<Calendar & {calendar_id: string}>} calendars
 * @param {Override[]|Map<string, Override>} overrides
 * @returns {Occurrence[]} отсортирован по `(date, amount_minor, occ_key)`
 */
export function expand_all(rules, window, calendars, overrides) {
  const idx = index_overrides(overrides);
  const by_rule = new Map();
  for (const o of idx.values()) {
    if (!by_rule.has(o.rule_id)) by_rule.set(o.rule_id, new Map());
    by_rule.get(o.rule_id).set(occ_key(o.rule_id, parse_date(o.nominal_date)), o);
  }
  const cal_of = (id) => {
    if (calendars instanceof Map) return calendars.get(id);
    if (Array.isArray(calendars)) return calendars.find((c) => c.calendar_id === id);
    return calendars == null ? undefined : (Object.hasOwn(calendars, id) ? calendars[id] : undefined);
  };
  const default_cal = make_calendar({ weekend_dows: [0, 6], holidays: [] });
  const out = [];
  for (const r of rules) {
    const cal = r.calendar_id == null ? default_cal : cal_of(r.calendar_id);
    if (cal === undefined) fail('E_SCHEMA', { reason: 'unknown_calendar', calendar_id: r.calendar_id, rule_id: r.rule_id });
    out.push(...expand_rule_idx(r, window, cal, by_rule.get(r.rule_id) ?? new Map()));
  }
  return out.sort(compare_occ);
}
