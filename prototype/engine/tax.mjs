// tax.mjs — налоговый конверт: версионируемые правила `percent_of_income`, аллокация, релиз, срок годности (ALG-06).
// Канон: design-brief D-17, §3.7, §9.12, C-016, C-023, C-024, C-025, C-032, §14 B1; wiki/algorithms/alg-06-tax-envelope.md; ADR-009.
// Зависимости: money, dates. Чистые функции; ставки и сроки — только данные пользователя, в коде их нет.
// Это расчёт по введённым правилам, не консультация.

import { fail, assert_minor, mul_div } from './money.mjs';
import { to_epoch_day } from './dates.mjs';

/** @typedef {import('./money.mjs').Minor} Minor */
/** @typedef {import('./dates.mjs').EpochDay} EpochDay */
/**
 * Версия налогового правила (`TaxRule`, §3.7). Даты — EpochDay или IsoDate.
 * @typedef {object} TaxRule
 * @property {string} tax_rule_id
 * @property {number} version ≥ 1
 * @property {string} [name]
 * @property {'percent_of_income'} kind
 * @property {number} rate_bp 0…10000
 * @property {'gross'} base
 * @property {{stream_ids?: string[], tags?: string[]}} applies_to
 * @property {EpochDay|string} valid_from
 * @property {EpochDay|string|null} [valid_to] не включается
 * @property {'half_even'|'half_up'|'floor'|'ceil'} rounding
 * @property {string} reserve_id
 * @property {EpochDay|string|null} [reviewed_at]
 * @property {number|null} [ttl_days]
 * @property {string} [recorded_at] Instant ISO-8601 UTC (только порядок версий, в арифметике не участвует)
 */
/**
 * Аллокация в резерв (`Allocation`, §3.7); вход `sinking.reserve_series`.
 * @typedef {object} Allocation
 * @property {string} allocation_id `tax:<tax_rule_id>@<cash_event_id>`
 * @property {string} reserve_id
 * @property {EpochDay} date эффективная дата режима (D-08: попадает в `reserve_close`)
 * @property {Minor} amount_minor
 * @property {'income'} source
 * @property {string} source_event_id
 * @property {number} rule_version
 */

const MODES = ['half_even', 'half_up', 'floor', 'ceil'];

function is_day(x) {
  try { to_epoch_day(x); return true; } catch { return false; }
}

/**
 * Привести Instant к виду, допускающему лексикографическое сравнение (доля секунды дополняется до 9 знаков).
 * Строка не в формате `YYYY-MM-DDThh:mm:ss[.f]Z` сравнивается как есть.
 * @param {string|number|null|undefined} s
 * @returns {string|number}
 */
function norm_instant(s) {
  if (s === null || s === undefined) return '';
  if (typeof s === 'number') return s;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(s);
  return m === null ? s : m[1] + '.' + (m[2] ?? '').padEnd(9, '0') + 'Z';
}

/** Сравнение Instant: −1 / 0 / 1; числа с числами, строки со строками, смешанное — как строки. */
function cmp_instant(a, b) {
  const x = norm_instant(a);
  const y = norm_instant(b);
  if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : x > y ? 1 : 0;
  const xs = String(x);
  const ys = String(y);
  return xs < ys ? -1 : xs > ys ? 1 : 0;
}

/**
 * Проверить правило. Не бросает: возвращает список ошибок `{code, field, reason}`.
 * Пустой `applies_to` — ошибка `E_SCHEMA` (C-032); остальные нарушения — `E_RULE_INVALID`.
 * @param {TaxRule} rule
 * @returns {{ok: boolean, errors: Array<{code: string, field: string, reason: string}>}}
 */
export function validate_tax_rule(rule) {
  const errors = [];
  const bad = (field, reason, code = 'E_RULE_INVALID') => errors.push({ code, field, reason });
  if (rule === null || typeof rule !== 'object') return { ok: false, errors: [{ code: 'E_RULE_INVALID', field: 'rule', reason: 'not_object' }] };
  if (typeof rule.tax_rule_id !== 'string' || rule.tax_rule_id === '') bad('tax_rule_id', 'required');
  if (!Number.isInteger(rule.version) || rule.version < 1) bad('version', 'int_ge_1');
  if (rule.kind !== 'percent_of_income') bad('kind', 'only_percent_of_income_in_v1');
  if (!Number.isInteger(rule.rate_bp) || rule.rate_bp < 0 || rule.rate_bp > 10000) bad('rate_bp', 'int_0_10000');
  if (rule.base !== 'gross') bad('base', 'only_gross_in_v1');
  if (!MODES.includes(rule.rounding)) bad('rounding', 'unknown_round_mode');
  if (!is_day(rule.valid_from)) bad('valid_from', 'bad_date');
  if (rule.valid_to !== null && rule.valid_to !== undefined) {
    if (!is_day(rule.valid_to)) bad('valid_to', 'bad_date');
    else if (is_day(rule.valid_from) && to_epoch_day(rule.valid_to) <= to_epoch_day(rule.valid_from)) bad('valid_to', 'not_after_valid_from');
  }
  if (typeof rule.reserve_id !== 'string' || rule.reserve_id === '') bad('reserve_id', 'required');
  const at = rule.applies_to;
  if (at === null || typeof at !== 'object') bad('applies_to', 'required', 'E_SCHEMA');
  else {
    const sids = at.stream_ids ?? [];
    const tags = at.tags ?? [];
    if (!Array.isArray(sids) || !Array.isArray(tags) || sids.some((x) => typeof x !== 'string') || tags.some((x) => typeof x !== 'string')) bad('applies_to', 'lists_of_strings', 'E_SCHEMA');
    else if (sids.length + tags.length === 0) bad('applies_to', 'empty', 'E_SCHEMA'); // правило «ни к чему» (C-032)
  }
  const has_rev = rule.reviewed_at !== null && rule.reviewed_at !== undefined;
  const has_ttl = rule.ttl_days !== null && rule.ttl_days !== undefined;
  if (has_rev !== has_ttl) bad('reviewed_at', 'reviewed_at_and_ttl_days_go_together');
  if (has_rev && !is_day(rule.reviewed_at)) bad('reviewed_at', 'bad_date');
  if (has_ttl && (!Number.isInteger(rule.ttl_days) || rule.ttl_days < 1)) bad('ttl_days', 'int_ge_1');
  return { ok: errors.length === 0, errors };
}

/**
 * Версия правила, действующая на дату `d`: `valid_from ≤ d < valid_to`; при нескольких — с наибольшим
 * `(recorded_at, version)`. `known_at` (запрос «что знали тогда», v2) отбрасывает версии, записанные позже.
 * @param {TaxRule[]} rules все версии всех правил
 * @param {string} rule_id `tax_rule_id`
 * @param {EpochDay|string} d дата дохода (для `planned` — `base(e)`, для `posted` — фактическая)
 * @param {string|null} [known_at] Instant
 * @returns {TaxRule|null}
 */
export function rule_at(rules, rule_id, d, known_at = null) {
  const day = to_epoch_day(d);
  let best = null;
  for (const r of rules ?? []) {
    if (r.tax_rule_id !== rule_id) continue;
    if (to_epoch_day(r.valid_from) > day) continue;
    if (r.valid_to !== null && r.valid_to !== undefined && day >= to_epoch_day(r.valid_to)) continue;
    if (known_at !== null && known_at !== undefined && cmp_instant(r.recorded_at, known_at) > 0) continue;
    if (best === null) { best = r; continue; }
    const c = cmp_instant(r.recorded_at, best.recorded_at);
    if (c > 0 || (c === 0 && r.version > best.version)) best = r;
  }
  return best;
}

/**
 * Аллокация в резерв с поступления: `mul_div(income, rate_bp, 10000, rule.rounding)` — одно округление; база — `gross`.
 * @param {Minor} income_minor поступление (≥ 0)
 * @param {TaxRule} rule
 * @returns {Minor}
 * @throws {RunwayError} E_SCHEMA (отрицательное поступление)
 */
export function allocation_for_income(income_minor, rule) {
  const inc = assert_minor(income_minor);
  if (inc < 0) fail('E_SCHEMA', { reason: 'negative_income', value: inc });
  return mul_div(inc, rule.rate_bp, 10000, rule.rounding ?? 'half_even');
}

/**
 * Диапазон конверта по диапазону дохода: `min ≤ exp ≤ max` (в расчёте участвует `exp`).
 * @param {{amount_minor: Minor, amount_min_minor?: Minor, amount_max_minor?: Minor}} e событие дохода
 * @param {TaxRule} rule
 * @returns {{min: Minor, exp: Minor, max: Minor}}
 */
export function allocation_range(e, rule) {
  return {
    min: allocation_for_income(e.amount_min_minor ?? e.amount_minor, rule),
    exp: allocation_for_income(e.amount_minor, rule),
    max: allocation_for_income(e.amount_max_minor ?? e.amount_minor, rule),
  };
}

/**
 * Высвобождение резерва при платеже: `released = min(funded, платёж)`, `true_up = платёж − released` (уходит из свободных денег).
 * @param {Minor} funded_minor накоплено до платежа (≥ 0)
 * @param {Minor} payment_minor модуль платежа (≥ 0)
 * @returns {{released: Minor, true_up: Minor}}
 */
export function release_on_payment(funded_minor, payment_minor) {
  const f = assert_minor(funded_minor);
  const p = assert_minor(payment_minor);
  if (f < 0 || p < 0) fail('E_SCHEMA', { reason: 'negative_argument', funded_minor: f, payment_minor: p });
  const released = Math.min(f, p);
  return { released, true_up: p - released };
}

/** Применимо ли правило к событию: доход `> 0`, `stream_id` или `tag` в `applies_to` (C-025). */
function applies(e, rule) {
  if (e.kind !== 'income' || !(e.amount_minor > 0)) return false;
  const at = rule.applies_to ?? {};
  return (e.stream_id !== null && e.stream_id !== undefined && (at.stream_ids ?? []).includes(e.stream_id))
    || (e.tag !== null && e.tag !== undefined && (at.tags ?? []).includes(e.tag));
}

/**
 * Аллокации по плановым и гипотетическим доходам (на лету, в журнал не пишутся). Версия правила выбирается по
 * `base(e) = max(plan_date, as_of)` — не зависит от режима (C-016), поэтому в `plan` и `worse` суммы равны;
 * `date` аллокации — эффективная дата события (D-08: попадает в `reserve_close` дня прихода).
 * @param {object[]} events события в валюте решения (`layer`, `kind`, `date`, `plan_date?`, `amount_minor`, `stream_id?`, `tag?`)
 * @param {TaxRule[]} rules
 * @param {EpochDay|string} as_of
 * @returns {Allocation[]}
 * @throws {RunwayError} E_RULE_INVALID (Σ ставок на одно поступление > 10000, C-032)
 */
export function allocations_for_events(events, rules, as_of) {
  const asof = to_epoch_day(as_of);
  const ids = [...new Set((rules ?? []).map((r) => r.tax_rule_id))].sort();
  const base_of = (e) => Math.max(to_epoch_day(e.plan_date ?? e.date), asof);
  const sorted = (events ?? []).filter((e) => e.layer === 'planned' || e.layer === 'hypothetical').sort((x, y) => {
    const dx = to_epoch_day(x.plan_date ?? x.date);
    const dy = to_epoch_day(y.plan_date ?? y.date);
    if (dx !== dy) return dx - dy;
    if (x.amount_minor !== y.amount_minor) return x.amount_minor - y.amount_minor;
    const ix = String(x.cash_event_id ?? '');
    const iy = String(y.cash_event_id ?? '');
    return ix < iy ? -1 : ix > iy ? 1 : 0;
  });
  const out = [];
  for (const e of sorted) {
    const b = base_of(e);
    const hit = [];
    for (const id of ids) {
      const r = rule_at(rules, id, b);
      if (r !== null && applies(e, r)) hit.push(r);
    }
    if (hit.reduce((s, r) => s + r.rate_bp, 0) > 10000) fail('E_RULE_INVALID', { reason: 'rate_sum_gt_10000', event: String(e.cash_event_id) });
    for (const r of hit) {
      const a = allocation_for_income(e.amount_minor, r);
      if (a > 0) {
        out.push({
          allocation_id: 'tax:' + r.tax_rule_id + '@' + e.cash_event_id,
          reserve_id: r.reserve_id,
          date: to_epoch_day(e.date),
          amount_minor: a,
          source: 'income',
          source_event_id: e.cash_event_id,
          rule_version: r.version,
        });
      }
    }
  }
  return out;
}

/**
 * Срок годности правила (C-023): `age = today − reviewed_at`; `fresh` при `age ≤ ttl`, `stale` при `ttl < age ≤ 2·ttl`,
 * `disabled` при `age > 2·ttl`. Без `reviewed_at`/`ttl_days` — `fresh` (UI пишет «проверка не отмечена»).
 * Поведение `disabled` (C-024): расчёт продолжается, зависящие числа скрывает гейт.
 * @param {TaxRule} rule
 * @param {EpochDay|string} today
 * @returns {'fresh'|'stale'|'disabled'}
 * @throws {RunwayError} E_BAD_DATE (`reviewed_at` в будущем)
 */
export function rule_age_status(rule, today) {
  if (rule.reviewed_at === null || rule.reviewed_at === undefined || rule.ttl_days === null || rule.ttl_days === undefined) return 'fresh';
  const age = to_epoch_day(today) - to_epoch_day(rule.reviewed_at);
  if (age < 0) fail('E_BAD_DATE', { reason: 'reviewed_at_in_future', age });
  if (age <= rule.ttl_days) return 'fresh';
  if (age <= 2 * rule.ttl_days) return 'stale';
  return 'disabled';
}

/**
 * Ближайший платёж, привязанный к резерву (факт `next_due` для `get_tax_envelope`).
 * @param {string} reserve_id
 * @param {{by_reserve: Object<string, {released: Minor[], true_up: Minor[]}>}} rs результат `sinking.reserve_series`
 * @param {object[]} events эффективные события режима (`reserve_id`, `date`, `amount_minor`)
 * @param {EpochDay|string} as_of
 * @returns {{date: EpochDay, payment_minor: Minor, released_minor: Minor, true_up_minor: Minor}|null}
 */
export function next_release(reserve_id, rs, events, as_of) {
  const br = rs?.by_reserve?.[reserve_id];
  if (br === undefined) return null;
  const asof = to_epoch_day(as_of);
  const n = br.released.length;
  const pay = (events ?? []).filter((e) => e.reserve_id === reserve_id && e.amount_minor < 0
    && to_epoch_day(e.date) >= asof && to_epoch_day(e.date) - asof < n);
  if (pay.length === 0) return null;
  const d = Math.min(...pay.map((e) => to_epoch_day(e.date)));
  const i = d - asof;
  let total = 0;
  for (const e of pay) if (to_epoch_day(e.date) === d) total += -e.amount_minor;
  return { date: d, payment_minor: total, released_minor: br.released[i], true_up_minor: br.true_up[i] };
}
