// timeline.mjs — слои → эффективные события → дневные ряды close/trough; Q1; сценарии; объяснение «почему» (ALG-02).
// Канон: design-brief D-01…D-06, D-13, D-14, D-22, D-23, §3.4, §9.4, §9.8, C-004…C-010, C-022, C-025, C-034, §14 B1/B2/B3;
// canon-decisions «Финальные сигнатуры» (timeline.mjs); wiki/algorithms/alg-02-timeline-projection.md; ADR-003, ADR-006.
// Зависимости (правило слоёв §14 B4): money, dates, recurrence, hourly, fx, tax, debt, calibration. Модуль чистый:
// ни часов, ни случайности, ни ввода-вывода; `as_of` и `horizon_end` приходят аргументами.
// Деньги — целые minor; даты — EpochDay (на границе допускается и IsoDate). Расчёт по введённым данным, не консультация.
//
// ── Форма рабочей области `ws` ────────────────────────────────────────────────────────────────────────────────────────
// `ws` — рабочая область: поля Workspace (§3.1: `decision_currency`, `params`) и проекции журнала. Каждое множество допускается
// и массивом, и словарём «id → запись» (как возвращает `ledger.reduce`): `accounts`, `anchors`, `facts` (posted), `plans`
// (= `planned_one_offs`, разовые плановые записи), `rules`, `overrides`, `calendars`, `streams`, `tax_rules` (словарь id → версии),
// `reserves`, `allocations`, `rates` (= `fx`), `scenarios`, `purchases`, `debts`, `wave_overrides`. Даты — IsoDate или EpochDay.
// `params` — плоские ключи `a.b` (как в vocab.json) либо вложенные объекты; недостающее берётся из значений по умолчанию §2.0.
// Функция `normalize_ws(ws)` приводит всё к спискам и EpochDay, исходный `ws` не меняется.

import { fail, assert_minor, round_div, mul_div, sum_minor, currency_exponent, own_put } from './money.mjs';
import { to_epoch_day, make_calendar } from './dates.mjs';
import { expand_all, expand_rule } from './recurrence.mjs';
import { expand_stream_ex } from './hourly.mjs';
import { to_decision, to_decision_events, opening_in_decision } from './fx.mjs';
import { allocations_for_events, rule_at, rule_age_status } from './tax.mjs';
import { schedule_to_events } from './debt.mjs';
import { assign_statuses, unlogged_rate, stale_status } from './calibration.mjs';
import { vdefault as vd } from './param_defaults.mjs';

/** @typedef {import('./money.mjs').Minor} Minor */
/** @typedef {import('./dates.mjs').EpochDay} EpochDay */
/** @typedef {'plan'|'worse'} Mode */
/**
 * Событие денежного потока (design-brief §3.4). В движке `date` — EpochDay; служебные поля результата `build_events`:
 * `plan_date` (дата после сценария и до режима, без зажима `max(·, as_of)`, C-005), `orig_amount_minor`, `orig_currency`, `rate_used` (C-034).
 * @typedef {object} CashEvent
 * @property {string} cash_event_id
 * @property {'posted'|'planned'|'hypothetical'} layer
 * @property {string} account_id
 * @property {EpochDay} date
 * @property {Minor} amount_minor доход > 0, расход < 0
 * @property {string} currency
 * @property {'income'|'expense'|'transfer'} kind
 * @property {string} [tag]
 * @property {'expected'|'matched'|'overdue'|'skipped'|'cancelled'} [status]
 * @property {string|null} [rule_id]
 * @property {string|null} [stream_id]
 * @property {string} [occ_key]
 * @property {EpochDay} [plan_date]
 * @property {boolean} [is_obligation]
 * @property {boolean} [is_estimate]
 * @property {boolean} [is_exceptional]
 * @property {Minor} [amount_min_minor]
 * @property {Minor} [amount_max_minor]
 * @property {number|null} [delay_days_worse]
 * @property {string} [reserve_id]
 * @property {string} [scenario_id]
 * @property {string} [purchase_id]
 * @property {string} [transfer_id]
 * @property {string} [counterparty_id]
 */
/**
 * Ряд (`Series`, §3.9): индекс `i ↔ from + i`; `close[−1] := opening_minor`. Ряды резервов и `free` добавляет `analyze`.
 * @typedef {object} Series
 * @property {EpochDay} from
 * @property {Minor} opening_minor
 * @property {Minor[]} close остаток на конец дня
 * @property {Minor[]} trough остаток после расходов дня, до его доходов
 */
/**
 * @typedef {object} Q1Answer
 * @property {Minor} min минимум `trough` на пути `[as_of, D]`
 * @property {EpochDay} at первая дата минимума
 * @property {boolean} ok_cash
 * @property {boolean} ok_buffer
 * @property {EpochDay|null} first_breach первая дата `trough < 0` на пути
 * @property {EpochDay|null} first_buffer_breach первая дата `trough < B` на пути
 * @property {Minor} need `max(0, B − min)` — «не хватает до буфера (деньги на счетах)»
 * @property {Minor} close_on_D
 */

// ── параметры ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Значения по умолчанию §2.0: читаются из `vocab.json` через `vocab.generated.mjs` (FP-17, REQ-019), литералов здесь нет; тест сверяет с файлом.
 * Ключи плоские, с точкой в имени.
 */
export const TIMELINE_DEFAULTS = Object.freeze({
  horizon_days: vd('horizon_days'),
  buffer_hint_days: vd('buffer_hint_days'),
  headline_mode: vd('headline_mode'),
  'worse.income_delay_days': vd('worse.income_delay_days'),
  'grace_days.income': vd('grace_days.income'),
  'grace_days.expense': vd('grace_days.expense'),
  'match.window_days': vd('match.window_days'),
  'match.tol_bp': vd('match.tol_bp'),
  'wave.gap_days': vd('wave.gap_days'),
  'wave.max_span_days': vd('wave.max_span_days'),
  'explain.top_k': vd('explain.top_k'),
  'explain.share_cutoff_bp': vd('explain.share_cutoff_bp'),
  'stale.banner_days': vd('stale.banner_days'),
  'stale.block_days': vd('stale.block_days'),
  rounding: vd('rounding'),
  'ready.q1': vd('ready.q1'),
  'ready.q3': vd('ready.q3'),
  'crypto.liquidity_bp': vd('crypto.liquidity_bp'),
});

/** Сценарный сдвиг курсов `{валюта → bp}` из операций `fx_shock` сценария (последняя операция на валюту побеждает). */
export function scenario_fx_shock(scenario) {
  const shock = {};
  for (const op of scenario?.ops ?? []) if (op?.op === 'fx_shock' && typeof op.currency === 'string') own_put(shock, op.currency, op.bp);
  return shock;
}

const ROUND_MODES = ['half_even', 'half_up', 'floor', 'ceil'];

function is_plain(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x) && !(x instanceof Map);
}

/** Развернуть вложенные объекты в плоские ключи `a.b`. */
function flatten_into(out, obj, prefix) {
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k];
    const key = prefix === '' ? k : prefix + '.' + k;
    if (is_plain(v)) flatten_into(out, v, key);
    else own_put(out, key, v);
  }
}

/**
 * Плоская таблица параметров: значения по умолчанию §2.0, поверх — заданные (плоские ключи `a.b` или вложенные объекты).
 * @param {object|undefined|null} params
 * @returns {Object<string, any>}
 */
export function flat_params(params) {
  const out = { ...TIMELINE_DEFAULTS };
  if (is_plain(params)) {
    const given = {};
    flatten_into(given, params, '');
    for (const k of Object.keys(given)) own_put(out, k, given[k]);
  }
  return out;
}

/**
 * Прочитать параметр: плоский ключ `a.b`, затем вложенный путь, затем значение по умолчанию; нет нигде — `null`.
 * @param {object|undefined|null} params
 * @param {string} key
 * @returns {any}
 */
export function get_param(params, key) {
  if (is_plain(params)) {
    if (Object.hasOwn(params, key) && params[key] !== undefined) return params[key];
    let cur = params;
    for (const part of key.split('.')) {
      cur = is_plain(cur) && Object.hasOwn(cur, part) ? cur[part] : undefined;
      if (cur === undefined) break;
    }
    if (cur !== undefined) return cur;
  }
  return Object.hasOwn(TIMELINE_DEFAULTS, key) ? TIMELINE_DEFAULTS[key] : null;
}

// ── нормализация рабочей области ──────────────────────────────────────────────────────────────────────────────────────

function cmp_str(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Массив / словарь «id → запись» / Map → список (порядок словаря — по ключам, детерминированно). */
function list_of(x) {
  if (x === undefined || x === null) return [];
  if (Array.isArray(x)) return x;
  if (x instanceof Map) return [...x.keys()].sort(cmp_str).map((k) => x.get(k));
  if (typeof x === 'object') return Object.keys(x).sort(cmp_str).map((k) => x[k]);
  return fail('E_SCHEMA', { reason: 'collection_not_array_or_object' });
}

/** Режим → канонический (`conservative` — синоним `worse`); `expected` — v2. */
export function normalize_mode(mode) {
  if (mode === 'plan') return 'plan';
  if (mode === 'worse' || mode === 'conservative') return 'worse';
  if (mode === 'expected') return fail('E_SCHEMA', { reason: 'mode_not_in_v1', mode });
  return fail('E_SCHEMA', { reason: 'unknown_mode', mode: String(mode) });
}

function norm_fact(f) {
  const id = f.cash_event_id ?? f.event_id ?? f.entity_id ?? f.id;
  if (typeof id !== 'string' || id === '') fail('E_SCHEMA', { reason: 'fact_id_required' });
  const amount = assert_minor(f.amount_minor);
  return {
    ...f,
    cash_event_id: id,
    layer: 'posted',
    date: to_epoch_day(f.date),
    amount_minor: amount,
    kind: f.kind ?? (amount > 0 ? 'income' : amount < 0 ? 'expense' : 'transfer'),
  };
}

/**
 * Рабочая область в виде списков и EpochDay.
 * @typedef {object} NormalizedWorkspace
 * @property {Object<string, any>} params плоские параметры с умолчаниями
 * @property {string|null} decision_currency валюта решения; `null`, если не задана и нет `operating`-счетов
 * @property {object[]} accounts
 * @property {{anchor_id: string, account_id: string, date: EpochDay, amount_minor: Minor}[]} anchors по `(date, anchor_id)`
 * @property {CashEvent[]} facts `posted`
 * @property {object[]} plans разовые плановые записи
 * @property {object[]} rules
 * @property {object[]} overrides
 * @property {object[]} calendars
 * @property {object[]} streams
 * @property {object[]} tax_rules все версии всех правил
 * @property {object[]} reserves
 * @property {object[]} allocations
 * @property {object[]} rates
 * @property {object[]} scenarios
 * @property {object[]} purchases
 * @property {object[]} debts
 * @property {object[]} wave_overrides
 */

/**
 * Привести рабочую область к спискам и EpochDay (исходный объект не меняется).
 * @param {object} ws
 * @returns {NormalizedWorkspace}
 */
export function normalize_ws(ws) {
  if (!is_plain(ws)) fail('E_SCHEMA', { reason: 'workspace_not_object' });
  const js = is_plain(ws.js) ? ws.js : {};
  const pick = (name, alt) => ws[name] ?? (alt === undefined ? undefined : ws[alt]) ?? js[name];
  const params = flat_params(ws.params);
  if (!ROUND_MODES.includes(params.rounding)) fail('E_SCHEMA', { reason: 'unknown_round_mode', value: String(params.rounding) });
  const accounts = list_of(pick('accounts'));
  const anchors = list_of(pick('anchors')).map((a) => ({ ...a, date: to_epoch_day(a.date), amount_minor: assert_minor(a.amount_minor) }))
    .sort((p, q) => (p.date - q.date) || cmp_str(String(p.anchor_id), String(q.anchor_id)));
  const facts = list_of(pick('facts')).map(norm_fact);
  let decision_currency = ws.decision_currency ?? params.decision_currency ?? null;
  if (decision_currency === null) {
    const first = accounts.find((a) => a.liquidity === 'operating');
    if (first !== undefined) decision_currency = first.currency; // валюта первого operating-счёта (§2.0)
  }
  return {
    params,
    decision_currency,
    accounts,
    anchors,
    facts,
    plans: list_of(pick('plans', 'planned_one_offs')),
    rules: list_of(pick('rules')),
    overrides: list_of(pick('overrides')),
    calendars: list_of(pick('calendars')),
    streams: list_of(pick('streams')),
    tax_rules: list_of(pick('tax_rules')).flat(),
    reserves: list_of(pick('reserves')),
    allocations: list_of(pick('allocations')),
    rates: list_of(pick('rates', 'fx')),
    scenarios: list_of(pick('scenarios')),
    purchases: list_of(pick('purchases')),
    debts: list_of(pick('debts')),
    wave_overrides: list_of(pick('wave_overrides')),
  };
}

/** Счёт открыт на дату и не закрыт. */
function active_on(a, asof) {
  if (a.opened_on !== undefined && a.opened_on !== null && to_epoch_day(a.opened_on) > asof) return false;
  if (a.closed_on !== undefined && a.closed_on !== null && to_epoch_day(a.closed_on) <= asof) return false;
  return true;
}

/** Валюты активных `operating`-счетов на дату (отсортированы, без повторов): для проверки свежести курсов. */
export function active_operating_currencies(w, asof) {
  return [...new Set(w.accounts.filter((a) => a.liquidity === 'operating' && active_on(a, asof)).map((a) => a.currency))].sort(cmp_str);
}

/** Валюта решения обязательна для расчётов в деньгах (нет счетов и не задана — `E_SCHEMA`). */
function need_currency(w) {
  if (w.decision_currency === null) fail('E_SCHEMA', { reason: 'decision_currency_unknown' });
  return w.decision_currency;
}

/** Календарь по идентификатору из списка; `null` — календарь по умолчанию (сб, вс; праздников нет). */
function calendar_of(calendars, id) {
  if (id === undefined || id === null) return undefined;
  const hit = calendars instanceof Map ? calendars.get(id)
    : Array.isArray(calendars) ? calendars.find((c) => c.calendar_id === id)
      : (calendars !== null && typeof calendars === 'object' && Object.hasOwn(calendars, id) ? calendars[id] : undefined);
  if (hit === undefined) fail('E_SCHEMA', { reason: 'unknown_calendar', calendar_id: String(id) });
  return hit;
}

// ── опорный остаток, якоря ────────────────────────────────────────────────────────────────────────────────────────────

/** Последний якорь счёта с датой ≤ `asof` (или `null`) и предыдущий. */
function last_anchors(anchors, account_id, asof) {
  let last = null;
  let prev = null;
  for (const a of anchors) { // anchors отсортированы по (date, anchor_id)
    if (a.account_id !== account_id || a.date > asof) continue;
    prev = last;
    last = a;
  }
  return { last, prev };
}

/**
 * Опорное состояние на `as_of` (D-01, D-22, C-010, C-034): остаток `operating`-счетов в валюте решения от последнего якоря,
 * `drift` последних якорей, возраст по самому несвежему счёту. `posted` с датой позже `as_of` — `E_FUTURE_POSTED`.
 * Необязательный `scenario`: сценарий курса `fx_shock` применяется и к ОСТАТКАМ счетов (а не только к будущим событиям), чтобы остаток и
 * поток одного сценария оценивались по одному курсу (ALG-08 TV-5: −5 % к USD пересчитывает и остаток). `drift` — историческая величина, шок на неё не влияет.
 * @param {object} ws
 * @param {EpochDay|string} as_of
 * @param {{ops?: object[]}|null} [scenario]
 * @returns {{opening_minor: Minor, drift: Minor|null, anchor_age: number|null, stale_accounts: {account_id: string, age: number|null}[]}}
 * @throws {RunwayError} E_FUTURE_POSTED, E_NO_RATE, E_OVERFLOW, E_SCHEMA (крипта на operating-счёте)
 */
export function opening_state(ws, as_of, scenario) {
  const w = normalize_ws(ws);
  need_currency(w);
  const asof = to_epoch_day(as_of);
  const P = w.params;
  for (const f of w.facts) {
    if (f.date > asof) fail('E_FUTURE_POSTED', { cash_event_id: f.cash_event_id, date: f.date, as_of: asof });
  }
  const fx_ctx = { rates: w.rates, decision_currency: w.decision_currency, policy: 'spot', rounding: P.rounding };
  const active = w.accounts.filter((a) => a.liquidity === 'operating' && active_on(a, asof));
  for (const a of active) { // D-20 / ALG-08: «крипта в operating не входит» — молча переводить её по курсу нельзя
    if (a.kind === 'crypto') fail('E_SCHEMA', { reason: 'crypto_in_operating', account_id: String(a.account_id) });
  }
  const balances = new Map();
  let drift = null;
  let oldest = null;
  let no_anchor = false;
  const stale_accounts = [];
  for (const a of active) {
    const mine = w.facts.filter((f) => f.account_id === a.account_id);
    const { last, prev } = last_anchors(w.anchors, a.account_id, asof);
    const base = last === null ? 0 : last.amount_minor;
    const after = last === null ? -Infinity : last.date;
    // счёт без якоря и без фактов остаток не задаёт вовсе: чужая валюта по-прежнему требует курс (сигнал неполных данных); явный 0 — курса не просит (Q-16)
    if (last !== null || mine.length > 0) balances.set(a.account_id, sum_minor([base, ...mine.filter((f) => after < f.date && f.date <= asof).map((f) => f.amount_minor)]));
    let age = null;
    if (last !== null) {
      const pa = prev === null ? 0 : prev.amount_minor;
      const pd = prev === null ? -Infinity : prev.date;
      const posted = sum_minor(mine.filter((f) => pd < f.date && f.date <= last.date).map((f) => f.amount_minor));
      const d = zero_or_decision(last.amount_minor - (pa + posted), a.currency, asof, fx_ctx);
      drift = (drift === null ? 0 : drift) + d;
      oldest = oldest === null ? last.date : Math.min(oldest, last.date);
      age = asof - last.date;
    } else no_anchor = true;
    if (age === null || age > P['stale.banner_days']) stale_accounts.push({ account_id: a.account_id, age });
  }
  const shock = scenario_fx_shock(scenario);
  const shocked_ctx = Object.keys(shock).length === 0 ? fx_ctx
    : { ...fx_ctx, policy: { kind: 'spot', as_of: asof, shock, rounding: P.rounding } };
  const total = opening_in_decision(active, balances, shocked_ctx, asof);
  return {
    opening_minor: assert_minor(total),
    drift,
    anchor_age: no_anchor || oldest === null ? null : asof - oldest,
    stale_accounts,
  };
}

/** Нулевая сумма в любой валюте равна нулю: курс нужен только для ненулевой (Q-16; тот же контракт, что у `fx.opening_in_decision`). */
function zero_or_decision(amount_minor, currency, as_of, ctx) {
  return amount_minor === 0 ? 0 : to_decision(amount_minor, currency, as_of, ctx).amount_minor;
}

/**
 * Начало окна плана счёта (C-004): дата последнего якоря счёта с датой ≤ `as_of` ВКЛЮЧИТЕЛЬНО; нет якоря — `as_of`.
 * План до якоря уже учтён в якоре.
 * @param {object} ws
 * @param {object|string} account `Account` или `account_id`
 * @param {EpochDay|string} as_of
 * @returns {EpochDay}
 */
export function plan_from(ws, account, as_of) {
  const w = normalize_ws(ws);
  const asof = to_epoch_day(as_of);
  const id = typeof account === 'string' ? account : account?.account_id;
  const { last } = last_anchors(w.anchors, id, asof);
  return last === null ? asof : last.date;
}

/**
 * Свежесть якоря (D-22): возраст по самому несвежему `operating`-счёту, скорость неучтённых трат по прошлым якорям
 * (`unlogged_rate`, медиана `|drift|/дни`), уровень плашки (`stale_status`, ALG-13).
 * @param {object} ws
 * @param {EpochDay|string} as_of
 * @returns {{level: 'fresh'|'banner'|'block', reason?: 'no_anchor'|'stale', age: number|null, unaccounted_minor: Minor|null, rate_minor: Minor|null, stale_accounts: {account_id: string, age: number|null}[]}}
 */
export function anchor_status(ws, as_of) {
  const w = normalize_ws(ws);
  const asof = to_epoch_day(as_of);
  const os = opening_state(ws, asof);
  const fx_ctx = { rates: w.rates, decision_currency: w.decision_currency, policy: 'spot', rounding: w.params.rounding };
  const drifts = [];
  for (const a of w.accounts) {
    if (a.liquidity !== 'operating' || !active_on(a, asof)) continue;
    const mine = w.anchors.filter((x) => x.account_id === a.account_id && x.date <= asof);
    for (let i = 1; i < mine.length; i++) {
      const days = mine[i].date - mine[i - 1].date;
      if (days < 1) continue;
      const posted = sum_minor(w.facts.filter((f) => f.account_id === a.account_id && mine[i - 1].date < f.date && f.date <= mine[i].date).map((f) => f.amount_minor));
      const d = mine[i].amount_minor - (mine[i - 1].amount_minor + posted);
      drifts.push({ drift_minor: zero_or_decision(d, a.currency, asof, fx_ctx), days });
    }
  }
  const rate = unlogged_rate(drifts);
  const st = stale_status(os.anchor_age, rate, w.params);
  return { ...st, age: os.anchor_age, rate_minor: rate, stale_accounts: os.stale_accounts };
}

/**
 * Статусы налоговых правил на дату (C-023): `tax_rule_id → fresh|stale|disabled` по действующей на `today` версии.
 * @param {object} ws
 * @param {EpochDay|string} today
 * @returns {Object<string, 'fresh'|'stale'|'disabled'>}
 */
export function rule_statuses(ws, today) {
  const w = normalize_ws(ws);
  const d = to_epoch_day(today);
  const out = {};
  for (const id of [...new Set(w.tax_rules.map((r) => r.tax_rule_id))].sort(cmp_str)) {
    const r = rule_at(w.tax_rules, id, d);
    if (r !== null) own_put(out, id, rule_age_status(r, d)); // id правила — из чужого журнала (Q-07)
  }
  return out;
}

// ── эффективная дата и режимы ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Эффективная дата события в режиме (D-04, C-005): `base = max(plan_date, as_of)`; `plan` — `base`; `worse` — `base` плюс сдвиг дохода
 * (`delay_days_worse ?? params.worse.income_delay_days`; только `kind = income`). Статусы `matched`/`skipped`/`cancelled` — `null`.
 * Расходы и суммы не сдвигаются. `plan_date` по умолчанию — `date`.
 * @param {CashEvent} e
 * @param {Mode|'conservative'} mode
 * @param {object} params плоские или вложенные параметры
 * @param {EpochDay|string} as_of
 * @returns {EpochDay|null}
 * @throws {RunwayError} E_SCHEMA (режим `expected` — v2, сдвиг не целый или < 0)
 */
export function eff_date(e, mode, params, as_of) {
  if (e.status === 'matched' || e.status === 'skipped' || e.status === 'cancelled') return null;
  const m = normalize_mode(mode);
  const asof = to_epoch_day(as_of);
  const base = Math.max(to_epoch_day(e.plan_date ?? e.date), asof);
  if (m === 'plan') return base;
  let d = 0;
  if (e.kind === 'income') {
    d = e.delay_days_worse ?? get_param(params, 'worse.income_delay_days');
    if (!Number.isSafeInteger(d) || d < 0) fail('E_SCHEMA', { reason: 'bad_income_delay_days', value: String(d), cash_event_id: String(e.cash_event_id) });
  }
  return base + d;
}

// ── сценарии ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Покупка → гипотетические события-расходы (C-008: функция timeline). Части — `purchase_id#k` (k с 0), `amount_minor = −часть`.
 * @param {{purchase_id: string, currency: string, parts: {date: EpochDay|string, amount_minor: Minor}[]}} purchase
 * @param {string} account_id
 * @param {string} [scenario_id]
 * @returns {CashEvent[]}
 * @throws {RunwayError} E_SCHEMA (нет частей, часть ≤ 0)
 */
export function purchase_to_events(purchase, account_id, scenario_id) {
  if (!Array.isArray(purchase?.parts) || purchase.parts.length === 0) fail('E_SCHEMA', { reason: 'purchase_without_parts' });
  return purchase.parts.map((p, k) => {
    const amt = assert_minor(p.amount_minor);
    if (amt <= 0) fail('E_SCHEMA', { reason: 'purchase_part_not_positive', k, value: amt });
    /** @type {CashEvent} */
    const e = {
      cash_event_id: purchase.purchase_id + '#' + k,
      layer: 'hypothetical',
      kind: 'expense',
      account_id,
      date: to_epoch_day(p.date),
      amount_minor: -amt,
      currency: purchase.currency,
      tag: 'purchase',
      is_obligation: false,
      is_estimate: false,
      is_exceptional: false,
      purchase_id: purchase.purchase_id,
    };
    if (scenario_id !== undefined && scenario_id !== null) e.scenario_id = scenario_id;
    return e;
  });
}

/** `event_ref` (C-008): сначала точное `cash_event_id`/`occ_key`, затем `rule_id`/`stream_id`; нет совпадения — `E_SCHEMA`. */
function resolve(evs, ref) {
  if (typeof ref !== 'string' || ref === '') fail('E_SCHEMA', { reason: 'event_ref_required' });
  let hit = evs.filter((e) => e.cash_event_id === ref || e.occ_key === ref);
  if (hit.length === 0) hit = evs.filter((e) => e.rule_id === ref || e.stream_id === ref);
  if (hit.length === 0) fail('E_SCHEMA', { reason: 'event_ref_not_found', event_ref: ref });
  return hit;
}

function op_ref(op) {
  return op.event_ref ?? op.ref;
}

function need_int(x, what, min) {
  if (!Number.isSafeInteger(x) || (min !== undefined && x < min)) fail('E_SCHEMA', { reason: 'bad_' + what, value: String(x) });
  return x;
}

/**
 * Применить сценарий — правки данных до режима (D-14): `delay_income`, `shift_flow`, `set_amount`, `remove_flow`, `add_purchase`, `add_flow`;
 * `fx_shock` данных не меняет (курс применяет `build_events` при переводе в валюту решения); `hours` — v1.1. Вход не мутируется.
 * `ctx = {as_of, horizon_end, calendars, default_account_id}`; необязательные `default_currency` (валюта счёта по умолчанию) и `decision_currency`.
 * @param {CashEvent[]} events
 * @param {{scenario_id?: string, ops: object[]}} scenario
 * @param {{as_of: EpochDay|string, horizon_end: EpochDay|string, calendars?: any, default_account_id?: string|null, default_currency?: string, decision_currency?: string}} ctx
 * @returns {CashEvent[]}
 * @throws {RunwayError} E_SCHEMA (ссылка не найдена, операция требует одно событие, знак суммы, неизвестная операция)
 */
export function apply_scenario(events, scenario, ctx) {
  let evs = events.map((e) => ({ ...e }));
  const sid = scenario?.scenario_id ?? null;
  const tag_id = String(sid ?? 'inline');
  const touch = (e) => { if (sid !== null) e.scenario_id = sid; };
  const asof = to_epoch_day(ctx.as_of);
  const hz = to_epoch_day(ctx.horizon_end);
  let n = 0;
  for (const op of scenario?.ops ?? []) {
    n += 1;
    switch (op?.op) {
      case 'delay_income': {
        const hit = resolve(evs, op_ref(op));
        if (hit.length !== 1) fail('E_SCHEMA', { reason: 'delay_income_needs_single_event', event_ref: String(op_ref(op)), count: hit.length });
        const e = hit[0];
        const days = need_int(op.days, 'days', 0);
        if (e.kind !== 'income') fail('E_SCHEMA', { reason: 'delay_income_on_non_income', event_ref: String(op_ref(op)) });
        e.date += days;
        if (e.plan_date !== undefined) e.plan_date += days;
        touch(e);
        break;
      }
      case 'shift_flow': {
        const days = need_int(op.days, 'days');
        for (const e of resolve(evs, op_ref(op))) {
          e.date += days;
          if (e.plan_date !== undefined) e.plan_date += days;
          touch(e);
        }
        break;
      }
      case 'set_amount': {
        const hit = resolve(evs, op_ref(op));
        if (hit.length !== 1) fail('E_SCHEMA', { reason: 'set_amount_needs_single_event', event_ref: String(op_ref(op)), count: hit.length });
        const e = hit[0];
        const amt = assert_minor(op.amount_minor);
        if (amt === 0 || (e.kind === 'income' && amt < 0) || (e.kind === 'expense' && amt > 0)) fail('E_SCHEMA', { reason: 'set_amount_sign_mismatch', event_ref: String(op_ref(op)) });
        e.amount_minor = amt;
        delete e.amount_min_minor;
        delete e.amount_max_minor;
        touch(e);
        break;
      }
      case 'remove_flow': {
        const gone = new Set(resolve(evs, op_ref(op)));
        evs = evs.filter((e) => !gone.has(e));
        break;
      }
      case 'add_purchase': {
        if (ctx.default_account_id === undefined || ctx.default_account_id === null) fail('E_SCHEMA', { reason: 'no_default_account' });
        const parts = op.parts ?? [{ date: op.date, amount_minor: op.amount_minor }];
        const currency = op.currency ?? ctx.default_currency ?? ctx.decision_currency;
        if (typeof currency !== 'string') fail('E_SCHEMA', { reason: 'purchase_currency_unknown' });
        evs.push(...purchase_to_events({ purchase_id: 'scn:' + tag_id + ':' + n, currency, parts }, ctx.default_account_id, sid ?? undefined));
        break;
      }
      case 'add_flow': {
        if (op.once !== undefined && op.once !== null) {
          const o = op.once;
          const amt = assert_minor(o.amount_minor);
          if (amt === 0) fail('E_SCHEMA', { reason: 'flow_amount_zero' });
          const account_id = o.account_id ?? ctx.default_account_id;
          if (account_id === undefined || account_id === null) fail('E_SCHEMA', { reason: 'no_default_account' });
          const e = {
            cash_event_id: 'scn:' + tag_id + ':' + n, layer: 'hypothetical', account_id, date: to_epoch_day(o.date), amount_minor: amt,
            currency: o.currency ?? ctx.default_currency ?? ctx.decision_currency, kind: amt > 0 ? 'income' : 'expense', tag: o.tag ?? 'flow',
            is_obligation: o.is_obligation === true, is_estimate: o.is_estimate === true, is_exceptional: false,
          };
          if (o.reserve_id !== undefined && o.reserve_id !== null) e.reserve_id = o.reserve_id;
          touch(e);
          evs.push(e);
        } else if (op.rule !== undefined && op.rule !== null) {
          const r = op.rule;
          const account_id = r.account_id ?? ctx.default_account_id;
          if (account_id === undefined || account_id === null) fail('E_SCHEMA', { reason: 'no_default_account' });
          const cal = r.calendar_id === undefined || r.calendar_id === null ? make_calendar({}) : calendar_of(ctx.calendars, r.calendar_id);
          for (const o of expand_rule(r, { from: asof, to: hz }, cal, [])) {
            const e = {
              cash_event_id: 'scn:' + tag_id + ':' + n + ':' + o.occ_key, layer: 'hypothetical', account_id, date: o.date, amount_minor: o.amount_minor,
              currency: o.currency ?? ctx.default_currency ?? ctx.decision_currency, kind: o.kind, tag: o.tag, rule_id: o.rule_id, occ_key: o.occ_key,
              is_obligation: o.is_obligation, is_estimate: o.is_estimate, is_exceptional: false,
            };
            if (o.reserve_id !== undefined) e.reserve_id = o.reserve_id;
            if (o.delay_days_worse !== undefined) e.delay_days_worse = o.delay_days_worse;
            touch(e);
            evs.push(e);
          }
        } else fail('E_SCHEMA', { reason: 'add_flow_needs_once_or_rule' });
        break;
      }
      case 'fx_shock': {
        if (typeof op.currency !== 'string') fail('E_SCHEMA', { reason: 'fx_shock_needs_currency' });
        need_int(op.bp, 'bp');
        break; // курс применяет build_events
      }
      case 'hours':
        fail('E_SCHEMA', { reason: 'op_not_in_v1', op: 'hours' });
        break;
      default:
        fail('E_SCHEMA', { reason: 'unknown_op', op: String(op?.op) });
    }
  }
  return evs;
}

// ── построение событий ────────────────────────────────────────────────────────────────────────────────────────────────

const OCC_OPTIONAL = ['amount_min_minor', 'amount_max_minor', 'counterparty_id', 'delay_days_worse', 'reserve_id'];
const PLAN_OPTIONAL = [...OCC_OPTIONAL, 'transfer_id'];

function cmp_event(x, y) {
  if (x.date !== y.date) return x.date < y.date ? -1 : 1;
  if (x.amount_minor !== y.amount_minor) return x.amount_minor < y.amount_minor ? -1 : 1;
  return cmp_str(String(x.cash_event_id), String(y.cash_event_id));
}

/** Верхний предел `horizon_days` (К-4: 1…3660; нижний предел движка — 0, как прежде). */
export const HORIZON_DAYS_MAX = 3660;

function resolve_horizon(P, as_of, query) {
  let hz;
  if (query.horizon_end !== undefined && query.horizon_end !== null) {
    hz = to_epoch_day(query.horizon_end);
    if (hz - as_of > HORIZON_DAYS_MAX) fail('E_SCHEMA', { reason: 'horizon_end_out_of_range', days: hz - as_of, max: HORIZON_DAYS_MAX });
  } else {
    const days = query.horizon_days ?? P.horizon_days;
    if (!Number.isSafeInteger(days) || days < 0) fail('E_SCHEMA', { reason: 'bad_horizon_days', value: String(days) });
    // К-4 (Q-12): верхний предел горизонта — до расчёта; иначе horizon_days = 200000 считался 37 с, а 3·10^6 — до E_BAD_DATE (REQ-158)
    if (days > HORIZON_DAYS_MAX) fail('E_SCHEMA', { reason: 'horizon_days_out_of_range', value: String(days), max: HORIZON_DAYS_MAX });
    hz = as_of + days;
  }
  if (hz < as_of) fail('E_BAD_DATE', { reason: 'horizon_end_before_as_of', as_of, horizon_end: hz });
  return hz;
}

/**
 * Плановые события окна: правила (ALG-01), потоки часов (ALG-07), разовые записи, график долгов — с датой не раньше якоря счёта,
 * со статусами после сопоставления с фактом (ALG-13). Сопоставленные, пропущенные и отменённые отброшены. Служебная.
 * @param {NormalizedWorkspace} w
 * @param {EpochDay} as_of
 * @param {EpochDay} horizon_end
 */
function collect_planned(w, as_of, horizon_end) {
  const P = w.params;
  const warnings = [];
  const operating = w.accounts.filter((a) => a.liquidity === 'operating' && active_on(a, as_of));
  const acc_by_id = new Map(w.accounts.map((a) => [a.account_id, a]));
  const pf_of = new Map();
  let f0 = as_of;
  for (const a of operating) {
    const { last } = last_anchors(w.anchors, a.account_id, as_of);
    const pf = last === null ? as_of : last.date;
    pf_of.set(a.account_id, pf);
    f0 = Math.min(f0, pf);
  }
  const pf = (account_id) => pf_of.get(account_id) ?? as_of;
  const default_acc = operating.find((a) => a.currency === w.decision_currency) ?? null;
  const cur_of = (account_id) => acc_by_id.get(account_id)?.currency;
  const acc_of = (id) => {
    const account_id = id ?? default_acc?.account_id;
    if (account_id === undefined || account_id === null) fail('E_SCHEMA', { reason: 'no_account_for_event' });
    return account_id;
  };
  const window = { from: f0, to: horizon_end };
  /** @type {CashEvent[]} */
  const planned = [];
  // 1. правила
  if (w.rules.length > 0) {
    for (const o of expand_all(w.rules, window, w.calendars, w.overrides)) {
      const account_id = acc_of(o.account_id);
      /** @type {CashEvent} */
      const e = {
        cash_event_id: o.occ_key, layer: 'planned', account_id, date: o.date, amount_minor: o.amount_minor,
        currency: o.currency ?? cur_of(account_id), kind: o.kind, tag: o.tag, status: 'expected', rule_id: o.rule_id, stream_id: null,
        occ_key: o.occ_key, is_obligation: o.is_obligation, is_estimate: o.is_estimate, is_exceptional: false,
      };
      for (let q = 0; q < OCC_OPTIONAL.length; q++) { const k = OCC_OPTIONAL[q]; if (o[k] !== undefined) e[k] = o[k]; }
      planned.push(e);
    }
  }
  // 2. потоки часов (округление — ws.params.rounding, §14 B2)
  for (const s of w.streams) {
    const cal = calendar_of(w.calendars, s.calendar_id);
    const r = expand_stream_ex(s, window, cal, { rounding: P.rounding, as_of }); // «закрыт ли период» — от as_of, не от f0
    planned.push(...r.events);
    warnings.push(...r.warnings);
  }
  // 3. разовые плановые записи
  for (const p of w.plans) {
    const date = to_epoch_day(p.date);
    if (date < f0 || date > horizon_end) continue;
    const id = p.plan_id ?? p.cash_event_id;
    if (typeof id !== 'string' || id === '') fail('E_SCHEMA', { reason: 'plan_id_required' });
    const amount = assert_minor(p.amount_minor);
    const account_id = acc_of(p.account_id);
    /** @type {CashEvent} */
    const e = {
      cash_event_id: id, layer: 'planned', account_id, date, amount_minor: amount, currency: p.currency ?? cur_of(account_id),
      kind: p.kind ?? (amount > 0 ? 'income' : 'expense'), tag: p.tag ?? '', status: p.status ?? 'expected', rule_id: null,
      stream_id: p.stream_id ?? null, occ_key: null, is_obligation: p.is_obligation === true, is_estimate: p.is_estimate === true,
      is_exceptional: p.is_exceptional === true,
    };
    for (const k of PLAN_OPTIONAL) if (p[k] !== undefined && p[k] !== null) e[k] = p[k];
    planned.push(e);
  }
  // 4. график долгов и рассрочек (платежи — плановые обязательства). Платежи за горизонтом в ряд не входят, но и не пропадают молча:
  // по каждому долгу такие платежи считаются, и это предупреждение расширения `W_DEBT_BEYOND_HORIZON` (FP-14, REQ-082; код вне vocab.json —
  // engine/warnings_ext.mjs). Платежи раньше начала окна (до якоря счёта) уже в остатке, а не за горизонтом.
  for (const d of w.debts) {
    let beyond_count = 0;
    let beyond_minor = 0;
    for (const e of schedule_to_events(d)) {
      if (e.date >= f0 && e.date <= horizon_end) planned.push(e);
      else if (e.date > horizon_end) { beyond_count += 1; beyond_minor = assert_minor(beyond_minor - e.amount_minor); }
    }
    if (beyond_count > 0) warnings.push({ code: 'W_DEBT_BEYOND_HORIZON', debt_id: String(d.debt_id), count: beyond_count, total_minor: beyond_minor, currency: String(d.currency) });
  }
  // 5. окно плана счёта — от даты его якоря включительно (C-004)
  const windowed = planned.filter((e) => e.date >= pf(e.account_id));
  // 6. сопоставление с фактом: matched / expected / overdue (ALG-13)
  const win = P['match.window_days'];
  const facts = w.facts.filter((f) => f.date >= f0 - win && f.date <= as_of);
  const staged = assign_statuses(windowed, facts, as_of, P).filter((e) => e.status !== 'matched' && e.status !== 'skipped' && e.status !== 'cancelled');
  return { planned: staged, warnings, f0, default_acc, operating };
}

/**
 * `transfer_id` разовых записей, у которых есть нога НЕ на operating-счёте (или на неизвестном счёте): такой перевод — расход из прогноза (X12).
 * Перевод с ровно ОДНОЙ ногой (парная не введена, данные неполны) тоже внешний: иначе расход молча пропал бы из ряда как «внутренний»
 * (Q-01, К-15). Такие переводы возвращаются отдельно (`unpaired`, по возрастанию id) — для служебного предупреждения `W_TRANSFER_UNPAIRED`.
 * Пара operating + operating по-прежнему внутренняя (исключается; G-001 не меняется). Счёт ног — по разовым записям `w.plans`.
 * @returns {{ids: Set<string>, unpaired: string[]}}
 */
function external_transfers(w) {
  const acc = new Map(w.accounts.map((a) => [a.account_id, a]));
  const ids = new Set();
  const legs = new Map();
  for (const p of w.plans) {
    if (p.transfer_id === undefined || p.transfer_id === null) continue;
    legs.set(p.transfer_id, (legs.get(p.transfer_id) ?? 0) + 1);
    const a = acc.get(p.account_id);
    if (a === undefined || a.liquidity !== 'operating') ids.add(p.transfer_id);
  }
  const unpaired = [];
  for (const [id, n] of legs) if (n === 1) { ids.add(id); unpaired.push(String(id)); }
  unpaired.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return { ids, unpaired };
}

/**
 * События режима вместе с налоговыми аллокациями и предупреждениями (§14 B1: `allocations_for_events(events, rules, as_of)`).
 * Шаги (ALG-02): план из правил, потоков, разовых записей и графика долгов → статусы по факту → сценарий (правка данных) →
 * валюта решения по `spot` (D-20) → режим (D-04). `posted` в результат не входят (они внутри `opening`).
 * `query = {as_of, horizon_end | horizon_days, mode?, scenario? | scenario_id?}`; `scenario` — встроенный объект, главнее `scenario_id`.
 * @param {object} ws
 * @param {{as_of: EpochDay|string, horizon_end?: EpochDay|string, horizon_days?: number, mode?: Mode|'conservative', scenario?: object, scenario_id?: string}} query
 * @returns {{events: CashEvent[], allocations: object[], warnings: {code: string}[]}}
 *   `events` отсортированы по `(date, amount_minor, cash_event_id)`; `date` — эффективная дата режима, `plan_date` — до режима
 * @throws {RunwayError} E_SCHEMA, E_NO_RATE, E_CURRENCY_MISMATCH (событие/резерв не в валюте счёта/решения), E_RULE_INVALID
 */
export function build_events_ex(ws, query) {
  const w = normalize_ws(ws);
  need_currency(w);
  const P = w.params;
  const as_of = to_epoch_day(query.as_of);
  const horizon_end = resolve_horizon(P, as_of, query);
  const mode = normalize_mode(query.mode ?? 'plan');
  for (const r of w.reserves) { // C-098: резерв хранится в валюте решения
    if (r.currency !== undefined && r.currency !== null && r.currency !== w.decision_currency) {
      fail('E_CURRENCY_MISMATCH', { reserve_id: String(r.reserve_id), currency: r.currency, decision_currency: w.decision_currency });
    }
  }
  const { planned, warnings, default_acc } = collect_planned(w, as_of, horizon_end);
  let scenario = query.scenario ?? null;
  if (scenario === null && query.scenario_id !== undefined && query.scenario_id !== null) {
    scenario = w.scenarios.find((s) => s.scenario_id === query.scenario_id) ?? null;
    if (scenario === null) fail('E_SCHEMA', { reason: 'scenario_not_found', scenario_id: String(query.scenario_id) });
  }
  const ctx = {
    as_of, horizon_end, calendars: w.calendars, default_account_id: default_acc === null ? null : default_acc.account_id,
    default_currency: default_acc === null ? undefined : default_acc.currency, decision_currency: w.decision_currency,
  };
  let evs = scenario === null ? planned : apply_scenario(planned, scenario, ctx);
  const shock = scenario_fx_shock(scenario);
  const policy = { kind: 'spot', as_of, shock, rounding: P.rounding };
  // только operating; внутренние переводы исключены. Решение «внутренний» принимается по ВСЕМ ногам рабочей области, а не по ногам,
  // уцелевшим после окна: нога на накопительном счёте за окном/горизонтом не делает перевод «внутренним» (баг C-B4)
  const ext = external_transfers(w);
  // служебное предупреждение: кода нет в vocab.json (реестр закрыт, К-15/К-39); текст и описание — engine/warnings_ext.mjs
  for (const id of ext.unpaired) warnings.push({ code: 'W_TRANSFER_UNPAIRED', transfer_id: id });
  evs = to_decision_events(evs, w.accounts, w.rates, w.decision_currency, policy, as_of, { external_transfer_ids: ext.ids });
  const out = [];
  for (const e of evs) { // `to_decision_events` вернул собственные копии: правим на месте
    e.plan_date = e.date; // C-005: дата после сценария, до режима, без зажима
    const d = eff_date(e, mode, P, as_of);
    if (d === null || d > horizon_end) continue;
    e.date = d;
    out.push(e);
  }
  out.sort(cmp_event);
  const allocations = w.tax_rules.length === 0 ? [] : allocations_for_events(out, w.tax_rules, as_of);
  for (const [id, st] of Object.entries(rule_statuses(ws, as_of))) {
    if (st === 'stale') warnings.push({ code: 'W_RULE_STALE', rule_id: id });
    else if (st === 'disabled') warnings.push({ code: 'W_RULE_DISABLED', rule_id: id });
  }
  return { events: out, allocations, warnings };
}

/**
 * События режима (ALG-02): эффективные, в валюте решения, с `plan_date`. Налоговые аллокации и предупреждения — `build_events_ex`.
 * @param {object} ws
 * @param {{as_of: EpochDay|string, horizon_end?: EpochDay|string, horizon_days?: number, mode?: Mode|'conservative', scenario?: object, scenario_id?: string}} query
 * @returns {CashEvent[]}
 */
export function build_events(ws, query) {
  return build_events_ex(ws, query).events;
}

// ── проекция ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Дневные ряды (D-01): `trough[i] = bal + out_i` (расходы раньше доходов), `close[i] = bal + out_i + in_i`; `close[−1] := opening`.
 * События за горизонтом пропускаются; событие раньше `as_of` — `E_SCHEMA`. Линейна по событиям: сценарий аддитивен, правка локальна.
 * @param {CashEvent[]} events эффективные события (`date`, `amount_minor`)
 * @param {Minor} opening_minor
 * @param {EpochDay|string} as_of
 * @param {EpochDay|string} horizon_end
 * @returns {Series}
 * @throws {RunwayError} E_BAD_DATE (`horizon_end < as_of`), E_SCHEMA (событие раньше `as_of`), E_NOT_INTEGER, E_OVERFLOW
 */
export function project(events, opening_minor, as_of, horizon_end) {
  const from = to_epoch_day(as_of);
  const N = to_epoch_day(horizon_end) - from + 1;
  if (N < 1) fail('E_BAD_DATE', { reason: 'horizon_end_before_as_of', as_of: from });
  const out = new Array(N).fill(0);
  const inn = new Array(N).fill(0);
  for (const e of events) {
    const amt = assert_minor(e.amount_minor);
    const i = to_epoch_day(e.date) - from;
    if (i < 0) fail('E_SCHEMA', { reason: 'event_before_as_of', cash_event_id: String(e.cash_event_id) });
    if (i >= N) continue; // за горизонтом
    if (amt < 0) out[i] = assert_minor(out[i] + amt);
    else inn[i] = assert_minor(inn[i] + amt);
  }
  let bal = assert_minor(opening_minor);
  const close = new Array(N);
  const trough = new Array(N);
  for (let i = 0; i < N; i++) {
    trough[i] = assert_minor(bal + out[i]);
    bal = assert_minor(bal + out[i] + inn[i]);
    close[i] = bal;
  }
  return { from, opening_minor: assert_minor(opening_minor), close, trough };
}

/**
 * Индекс первого минимума на `[lo, hi]` (строгое `<`: при равенстве побеждает ранний).
 * @param {number[]} xs
 * @param {number} lo
 * @param {number} hi включительно
 * @returns {number}
 */
export function argmin_first(xs, lo, hi) {
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || hi >= xs.length || lo > hi) fail('E_SCHEMA', { reason: 'bad_range', lo, hi, length: xs.length });
  let idx = lo;
  for (let i = lo + 1; i <= hi; i++) if (xs[i] < xs[idx]) idx = i;
  return idx;
}

/**
 * Узкая точка физических денег на `[a, b]` (D-02): первая дата минимума `trough`.
 * @param {Series} series
 * @param {EpochDay|string} a
 * @param {EpochDay|string} b
 * @returns {{date: EpochDay, amount_minor: Minor}}
 */
export function narrowest_point(series, a, b) {
  const i = argmin_first(series.trough, to_epoch_day(a) - series.from, to_epoch_day(b) - series.from);
  return { date: series.from + i, amount_minor: series.trough[i] };
}

/**
 * Q1 «хватит ли к дате D» (D-13): свойство пути `[as_of, D]`. `B` не задан (`null`) — считается как 0 (предупреждение — в `analyze`).
 * @param {Series} series
 * @param {EpochDay|string} D
 * @param {Minor|null} B буфер
 * @returns {Q1Answer|{beyond_horizon: true}}
 * @throws {RunwayError} E_BAD_DATE (`D < as_of`)
 */
export function answer_q1(series, D, B) {
  const N = series.trough.length;
  const d = to_epoch_day(D);
  if (d < series.from) fail('E_BAD_DATE', { reason: 'D_before_as_of', D: d, as_of: series.from });
  if (d > series.from + N - 1) return { beyond_horizon: true };
  const buf = B === undefined || B === null ? 0 : assert_minor(B);
  const idx = d - series.from;
  const k = argmin_first(series.trough, 0, idx);
  const m = series.trough[k];
  let fb = null;
  let fbb = null;
  for (let i = 0; i <= idx; i++) {
    if (fb === null && series.trough[i] < 0) fb = series.from + i;
    if (fbb === null && series.trough[i] < buf) fbb = series.from + i;
    if (fb !== null && fbb !== null) break;
  }
  return {
    min: m, at: series.from + k, ok_cash: m >= 0, ok_buffer: m >= buf, first_breach: fb, first_buffer_breach: fbb,
    need: Math.max(0, assert_minor(buf - m)), close_on_D: series.close[idx],
  };
}

/**
 * «Запас хода» (C-005, C-006): первая дата `trough < 0` на всём горизонте — с поступлениями и без них (ряд без доходов
 * пересчитывается из `events`). `null` — «за горизонтом». `days` — дней от `as_of`.
 * @param {Series} series
 * @param {CashEvent[]} events эффективные события того же режима
 * @returns {{with: {date: EpochDay, days: number}|null, without: {date: EpochDay, days: number}|null}}
 */
export function runway_days(series, events) {
  const from = series.from;
  const horizon_end = from + series.trough.length - 1;
  const first_neg = (tr) => {
    const i = tr.findIndex((x) => x < 0);
    return i < 0 ? null : { date: from + i, days: i };
  };
  const s0 = project(events.filter((e) => e.amount_minor < 0), series.opening_minor, from, horizon_end);
  return { with: first_neg(series.trough), without: first_neg(s0.trough) };
}

// ── объяснение «почему» ───────────────────────────────────────────────────────────────────────────────────────────────

/** Ключ группы цепочки (C-025): `rule_id ?? stream_id ?? 'tag:'+tag ?? cash_event_id`. Ключ `tag:…` — только для экрана (C-097). */
function group_key(e) {
  if (e.rule_id !== undefined && e.rule_id !== null) return e.rule_id;
  if (e.stream_id !== undefined && e.stream_id !== null) return e.stream_id;
  if (typeof e.tag === 'string' && e.tag !== '') return 'tag:' + e.tag;
  return e.cash_event_id;
}

/**
 * Узкая точка и «почему» (IDEA-29, C-007): пик остатка до точки, окно `[w0, t]`, цепочка групп расходов (по убыванию суммы, стоп при накопленной
 * доле ≥ `explain.share_cutoff_bp` или `explain.top_k` группах) и контрфакты — полный пересчёт `project` без группы (`without`) и с доходом без
 * задержки (`no_delay`). Доли — целые bp: `share_bp = round_div(10000·сумма, out_total)`, накопленная — от накопленной суммы.
 * Инвариант: `peak − point = out_total − inflow_offset`.
 * @param {CashEvent[]} events эффективные события режима
 * @param {Series} series
 * @param {object} params `explain.top_k`, `explain.share_cutoff_bp`
 * @returns {{point: {date: EpochDay, amount_minor: Minor}, peak: {date: EpochDay, amount_minor: Minor}, out_total_minor: Minor, inflow_offset_minor: Minor,
 *   chain: {group: string, count: number, amount_minor: Minor, share_bp: number, cum_bp: number, event_ids: string[]}[],
 *   counterfactuals: ({kind: 'without', group: string}|{kind: 'no_delay', event_id: string}) & {new_min: {date: EpochDay, amount_minor: Minor}, delta_minor: Minor}[]}}
 */
export function explain_narrowest(events, series, params) {
  const top_k = get_param(params, 'explain.top_k');
  const cutoff = get_param(params, 'explain.share_cutoff_bp');
  const N = series.trough.length;
  const from = series.from;
  const h_end = from + N - 1;
  const k = argmin_first(series.trough, 0, N - 1);
  const t = from + k;
  const m = series.trough[k];
  let pk = -1; // пик остатка до точки: кандидаты opening и close[0..k−1], при равенстве — раньше
  let pv = series.opening_minor;
  for (let j = 0; j < k; j++) if (series.close[j] > pv) { pv = series.close[j]; pk = j; }
  const peak = { date: from + Math.max(pk, 0), amount_minor: pv };
  const w0 = from + pk + 1;
  const W = events.filter((e) => e.amount_minor < 0 && e.date >= w0 && e.date <= t);
  const Wi = events.filter((e) => e.amount_minor > 0 && e.date >= w0 && e.date < t);
  const out_total = sum_minor(W.map((e) => -e.amount_minor));
  const offset = sum_minor(Wi.map((e) => e.amount_minor));
  const groups = new Map();
  for (const e of [...W].sort(cmp_event)) {
    const key = group_key(e);
    if (!groups.has(key)) groups.set(key, { group: key, sum: 0, ids: [] });
    const g = groups.get(key);
    g.sum += -e.amount_minor;
    g.ids.push(e.cash_event_id);
  }
  const G = [...groups.values()].sort((a, b) => (b.sum - a.sum) || cmp_str(a.group, b.group));
  const chain = [];
  const counterfactuals = [];
  if (out_total > 0) {
    let cum = 0;
    for (const g of G) {
      if (chain.length === top_k) break;
      cum += g.sum;
      const cum_bp = mul_div(cum, 10000, out_total, 'half_even'); // накопленная доля — от накопленной суммы (C-007)
      chain.push({
        group: g.group, count: g.ids.length, amount_minor: g.sum, share_bp: mul_div(g.sum, 10000, out_total, 'half_even'),
        cum_bp, event_ids: g.ids,
      });
      if (cum_bp >= cutoff) break;
    }
  }
  const narrowest_of = (evs) => {
    const s2 = project(evs, series.opening_minor, from, h_end);
    const i = argmin_first(s2.trough, 0, N - 1);
    return { date: from + i, amount_minor: s2.trough[i] };
  };
  for (const c of chain) {
    const nm = narrowest_of(events.filter((e) => group_key(e) !== c.group));
    counterfactuals.push({ kind: 'without', group: c.group, new_min: nm, delta_minor: nm.amount_minor - m });
  }
  const base_of = (e) => Math.max(e.plan_date ?? e.date, from);
  const delayed = events.filter((e) => e.amount_minor > 0 && e.date > base_of(e) && base_of(e) <= t)
    .sort((a, b) => (b.amount_minor - a.amount_minor) || cmp_str(String(a.cash_event_id), String(b.cash_event_id))).slice(0, top_k);
  for (const e of delayed) {
    const nm = narrowest_of(events.map((x) => (x === e ? { ...x, date: base_of(e) } : x)));
    counterfactuals.push({ kind: 'no_delay', event_id: e.cash_event_id, new_min: nm, delta_minor: nm.amount_minor - m });
  }
  return { point: { date: t, amount_minor: m }, peak, out_total_minor: out_total, inflow_offset_minor: offset, chain, counterfactuals };
}

// ── подсказки по истории: буфер и порог волны ─────────────────────────────────────────────────────────────────────────

/**
 * Исходящие `posted` за 90 дней до `as_of` в валюте решения (C-022, X6): без переводов между своими счетами и ног обмена валют
 * (`transfer_id`/`fx`), налоговых платежей (привязка к резерву `kind = tax`) и помеченных `is_exceptional`. Нет таких — `null`.
 * @param {object} ws
 * @param {EpochDay|string} as_of
 * @returns {Minor|null}
 */
export function outflow_90(ws, as_of) {
  const w = normalize_ws(ws);
  need_currency(w);
  const asof = to_epoch_day(as_of);
  const fx_ctx = { rates: w.rates, decision_currency: w.decision_currency, policy: 'spot', rounding: w.params.rounding };
  const tax_reserves = new Set(w.reserves.filter((r) => r.kind === 'tax').map((r) => r.reserve_id));
  const X = w.facts.filter((f) => f.date >= asof - 90 && f.date < asof && f.amount_minor < 0
    && (f.transfer_id === undefined || f.transfer_id === null) && (f.fx === undefined || f.fx === null)
    && !(f.reserve_id !== undefined && f.reserve_id !== null && tax_reserves.has(f.reserve_id))
    && f.is_exceptional !== true);
  if (X.length === 0) return null;
  return sum_minor(X.map((f) => -to_decision(f.amount_minor, f.currency, asof, fx_ctx).amount_minor));
}

/**
 * Подсказка буфера (D-03): `round_div(buffer_hint_days · outflow_90, 90)`; нет истории — `null`. Это подсказка, не канон буфера.
 * @param {object} ws
 * @param {EpochDay|string} as_of
 * @returns {Minor|null}
 */
export function buffer_hint(ws, as_of) {
  const o = outflow_90(ws, as_of);
  if (o === null) return null;
  const P = flat_params(is_plain(ws) ? ws.params : undefined);
  return mul_div(P.buffer_hint_days, o, 90, P.rounding);
}

/**
 * Порог значимого обязательства по умолчанию (X1, C-022): `max(30·10^exponent, round_div(Σ исходящих за 90 дн., 300))`.
 * @param {object} ws
 * @param {EpochDay|string} as_of
 * @returns {Minor}
 */
export function default_wave_threshold(ws, as_of) {
  const w = normalize_ws(ws);
  need_currency(w);
  const base = 30 * 10 ** currency_exponent(w.decision_currency);
  const o = outflow_90(ws, as_of);
  return Math.max(base, o === null ? 0 : round_div(o, 300, w.params.rounding));
}

// ── готовность данных (D-23, §14 B3) ──────────────────────────────────────────────────────────────────────────────────

const LEVELS = Object.freeze(['empty', 'skeleton', 'working', 'working_plus', 'full']);

/**
 * Готовность данных (D-23): `s = has_account + (обязательств ≥ 3 или значимое обязательство) + доход в ближайшие 45 дней + задана оценка повседневных`.
 * Обязательства считаются по источникам (правило, разовая запись, график долга), у которых есть вхождение в горизонте; «волна» — хотя бы
 * одно обязательство не меньше порога θ. Буфер и резервы в `s` не входят (C-018). Прогноз виден при `s ≥ ready.q1`, вердикт Q3 — при `s ≥ ready.q3`.
 * @param {object} ws
 * @param {EpochDay|string} as_of
 * @returns {{score: number, level: 'empty'|'skeleton'|'working'|'working_plus'|'full', reasons: string[]}}
 *   `reasons` — чего не хватает: `no_account`, `obligations_lt_3`, `no_income_45d`, `no_daily_spend`
 */
export function readiness(ws, as_of) {
  const w = normalize_ws(ws);
  const asof = to_epoch_day(as_of);
  const P = w.params;
  const has_account = w.accounts.some((a) => a.liquidity === 'operating' && active_on(a, asof));
  const reasons = [];
  let score = 0;
  if (has_account) score += 1; else reasons.push('no_account');
  // «доход в ближайшие 45 дней» — условие на 45 дней независимо от длины показа: окно не короче 45 дней (баг C-B7)
  const hz = asof + Math.max(P.horizon_days, 45);
  const { planned } = has_account ? collect_planned(w, asof, hz) : { planned: [] };
  const fx_ctx = { rates: w.rates, decision_currency: w.decision_currency, policy: 'spot', rounding: P.rounding };
  const theta = has_account ? (P['wave.threshold_minor'] ?? default_wave_threshold(ws, asof)) : 0;
  const source = (e) => e.rule_id ?? e.stream_id ?? e.cash_event_id;
  const obligations = planned.filter((e) => e.is_obligation === true && e.amount_minor < 0);
  const sources = new Set(obligations.map(source));
  const significant = obligations.some((e) => {
    try { return -to_decision(e.amount_minor, e.currency, asof, fx_ctx).amount_minor >= theta; } catch { return false; }
  });
  if (sources.size >= 3 || significant) score += 1; else reasons.push('obligations_lt_3');
  if (planned.some((e) => e.kind === 'income' && e.amount_minor > 0 && Math.max(e.date, asof) - asof <= 45)) score += 1; else reasons.push('no_income_45d');
  if (planned.some((e) => e.is_estimate === true && e.amount_minor < 0)) score += 1; else reasons.push('no_daily_spend');
  return { score, level: LEVELS[score], reasons };
}
