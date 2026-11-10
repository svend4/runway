// calibration.mjs — сопоставление план↔факт, статусы вхождений, свежесть данных, лаги и малые выборки (ALG-13).
// Канон: design-brief §2.0, D-04, D-06, D-22, §14 B4; canon-decisions «Финальные сигнатуры» (calibration.mjs); ALG-13.
// Зависимости: ТОЛЬКО money и dates (§14 B4). backtest / release_gate / default_breach живут в backtest.mjs, не здесь;
// `state_at` — только в ledger.mjs (C-056). Модуль чистый: ни часов, ни случайности, ни ввода-вывода.
// Float допускается только в `wilson` (sqrt) — результат целые ‰ с явным округлением (design-brief §4).

import { fail, assert_minor, round_div, ceil_div, sum_minor, own_has, own_put } from './money.mjs';
import { to_epoch_day } from './dates.mjs';
import { vdefault as vd } from './param_defaults.mjs';

/** @typedef {import('./money.mjs').Minor} Minor */
/** @typedef {import('./dates.mjs').EpochDay} EpochDay */
/** @typedef {'in_tol'|'near'|'far'} DevClass */
/** @typedef {'expected'|'matched'|'overdue'|'skipped'|'cancelled'} OccStatus */
/**
 * Событие денежного потока (подмножество полей, нужных калибровке).
 * @typedef {object} CashEventLike
 * @property {string} [cash_event_id]
 * @property {string} [occ_key]
 * @property {string} [event_id]
 * @property {string} [entity_id]
 * @property {'posted'|'planned'|'hypothetical'} [layer]
 * @property {string} account_id
 * @property {string} currency
 * @property {EpochDay|string} date
 * @property {Minor} amount_minor
 * @property {Minor} [amount_min_minor]
 * @property {Minor} [amount_max_minor]
 * @property {OccStatus} [status]
 * @property {string} [plan_ref]
 * @property {boolean} [no_plan]
 * @property {string} [counterparty_id]
 * @property {string} [stream_id]
 * @property {string} [rule_id]
 */

// ── параметры ─────────────────────────────────────────────────────────────────

/**
 * Значения по умолчанию (`vocab.json` через `vocab.generated.mjs`, FP-17/REQ-019; design-brief §2.0 и §14 N5; тест сверяет с файлом).
 * Ключи плоские, с точкой в имени, как в `Workspace.params` (product/04); вложенная форма `params.match.window_days` тоже читается.
 */
export const CALIBRATION_DEFAULTS = Object.freeze({
  'match.window_days': vd('match.window_days'),
  'match.tol_bp': vd('match.tol_bp'),
  'grace_days.income': vd('grace_days.income'),
  'grace_days.expense': vd('grace_days.expense'),
  'stale.banner_days': vd('stale.banner_days'),
  'stale.block_days': vd('stale.block_days'),
  'calib.window': vd('calib.window'),
  'calib.prior': vd('calib.prior'),
  'calib.k': vd('calib.k'),
  'calib.alpha_bp': vd('calib.alpha_bp'),
});

/**
 * Прочитать параметр: сначала плоский ключ `a.b`, затем вложенный `params.a.b`, затем значение по умолчанию.
 * @param {object|undefined} params
 * @param {string} key
 * @returns {number}
 */
function param(params, key) {
  let v;
  if (params !== undefined && params !== null && typeof params === 'object') {
    if (Object.hasOwn(params, key)) v = params[key];
    else {
      let cur = params;
      for (const part of key.split('.')) {
        cur = (cur !== null && typeof cur === 'object' && Object.hasOwn(cur, part)) ? cur[part] : undefined;
        if (cur === undefined) break;
      }
      v = cur;
    }
  }
  if (v === undefined || v === null) v = CALIBRATION_DEFAULTS[key];
  if (!Number.isSafeInteger(v) || v < 0) fail('E_SCHEMA', { reason: 'param_not_nonneg_int', key, value: String(v) });
  return v;
}

// ── общие мелочи ──────────────────────────────────────────────────────────────

/** Знак суммы: −1, 0, +1. */
const sign_of = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const abs_of = (x) => (x < 0 ? -x : x);

/** Идентификатор плана: `occ_key`, иначе `cash_event_id`. */
function plan_id(p) {
  const id = p.occ_key ?? p.cash_event_id;
  if (typeof id !== 'string' || id === '') fail('E_SCHEMA', { reason: 'plan_id_required' });
  return id;
}

/** Идентификатор факта: `cash_event_id`, `event_id` или `entity_id` (проекция журнала). */
function fact_id(f) {
  const id = f.cash_event_id ?? f.event_id ?? f.entity_id;
  if (typeof id !== 'string' || id === '') fail('E_SCHEMA', { reason: 'fact_id_required' });
  return id;
}

/** Сравнение строк по кодовым единицам (детерминированно, без локали). */
const cmp_str = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Нормализованная форма плана/факта для вычислений: EpochDay и идентификатор. */
const day_of = (e) => to_epoch_day(e.date);

// ── v1: сопоставление план↔факт ────────────────────────────────────────────────

/**
 * Класс расхождения суммы факта (или суммы частей) с планом. Все сравнения целочисленные (BigInt), без деления:
 * `in_tol` — `d·10000 ≤ tol·|P|` либо `|x|` внутри коридора плана `[amount_min, amount_max]`; `near` — `d·10000 ≤ 2·tol·|P|`; иначе `far`.
 * Знак, валюта и счёт проверяются вызывающим.
 * @param {Minor} x сумма факта (или Σ частей)
 * @param {CashEventLike} plan план: `amount_minor`, необязательные `amount_min_minor` / `amount_max_minor`
 * @param {number} tol_bp допуск, bp (500 = 5 %)
 * @returns {DevClass}
 */
export function dev_class(x, plan, tol_bp) {
  const a = BigInt(abs_of(assert_minor(x)));
  const b = BigInt(abs_of(assert_minor(plan.amount_minor)));
  const tol = BigInt(assert_minor(tol_bp));
  if (tol < 0n) fail('E_SCHEMA', { reason: 'tol_bp_negative', value: String(tol_bp) });
  const lo_raw = plan.amount_min_minor;
  const hi_raw = plan.amount_max_minor;
  if (lo_raw !== undefined && lo_raw !== null && hi_raw !== undefined && hi_raw !== null) {
    const p = BigInt(abs_of(assert_minor(lo_raw)));
    const q = BigInt(abs_of(assert_minor(hi_raw)));
    const lo = p < q ? p : q;
    const hi = p < q ? q : p;
    if (lo <= a && a <= hi) return 'in_tol';
  }
  const d = a > b ? a - b : b - a;
  if (d * 10000n <= tol * b) return 'in_tol';
  if (d * 10000n <= 2n * tol * b) return 'near';
  return 'far';
}

/**
 * @typedef {object} MatchResult
 * @property {{plan: CashEventLike, facts: CashEventLike[], by: 'auto'|'user', excluded?: boolean}[]} matches
 * @property {{fact: CashEventLike, candidates: CashEventLike[], reason: 'ambiguous'|'contested'|'near_tolerance'}[]} doubles
 * @property {{plan: CashEventLike, facts: CashEventLike[], residual: Minor}[]} partials
 * @property {CashEventLike[]} unmatched_plans
 * @property {CashEventLike[]} unmatched_facts
 */

/**
 * Сопоставление фактов с планами (D-06, ALG-13). Автосовпадение — только изолированные пары: у факта ровно один кандидат,
 * у плана ровно один кандидат-факт и класс `in_tol`; иначе очередь подтверждения («возможный двойник»), и план, и факт
 * учитываются оба. Результат не зависит от порядка входов; повторный вызов без совпавших планов идемпотентен.
 * Связь, подтверждённая пользователем (`fact.plan_ref == plan.occ_key`), обрабатывается первой, в том числе частичные платежи.
 * Факт со связью на план вне очереди (план уже терминален) в автосопоставлении не участвует и попадает в `unmatched_facts`.
 * @param {CashEventLike[]} plans события `planned`
 * @param {CashEventLike[]} facts события `posted`
 * @param {object} [params] `match.window_days`, `match.tol_bp` (плоские ключи или вложенные)
 * @returns {MatchResult}
 */
export function match_plan_to_fact(plans, facts, params) {
  const win = param(params, 'match.window_days');
  const tol = param(params, 'match.tol_bp');
  const by_plan = (a, b) => (day_of(a) - day_of(b)) || cmp_str(plan_id(a), plan_id(b));
  /** @type {CashEventLike[]} */
  let P = plans
    .filter((p) => (p.layer === undefined || p.layer === 'planned') && (p.status === undefined || p.status === 'expected' || p.status === 'overdue'))
    .sort(by_plan);
  let F = facts.filter((f) => (f.layer === undefined || f.layer === 'posted') && f.no_plan !== true);

  const matches = [];
  const doubles = [];
  const partials = [];
  const unmatched_facts = [];
  const partial_ids = new Set();

  // 0. связи, подтверждённые пользователем
  const linked = new Set();
  const plan_ids = new Set(P.map(plan_id));
  const claimed = [];
  const free = [];
  for (const f of F) {
    if (typeof f.plan_ref === 'string' && f.plan_ref !== '') {
      if (plan_ids.has(f.plan_ref)) claimed.push(f);
      else unmatched_facts.push(f); // план уже терминален (или исчез): связь не отменяется, но и не ищет другой план
    } else free.push(f);
  }
  const used_plan = new Set();
  const next_P = [];
  for (const p of P) {
    const L = claimed.filter((f) => f.plan_ref === plan_id(p)).sort((a, b) => (day_of(a) - day_of(b)) || cmp_str(fact_id(a), fact_id(b)));
    if (L.length === 0) { next_P.push(p); continue; }
    const s = sum_minor(L.map((f) => f.amount_minor));
    for (const f of L) linked.add(fact_id(f));
    if (dev_class(s, p, tol) === 'in_tol' || abs_of(s) > abs_of(p.amount_minor)) {
      matches.push({ plan: p, facts: L, by: 'user' });
      used_plan.add(plan_id(p));
    } else {
      const residual = assert_minor(p.amount_minor - s);
      partials.push({ plan: p, facts: L, residual });
      partial_ids.add(plan_id(p));
      // остаток плана ещё может сопоставиться: коридор суммы к остатку не относится
      next_P.push({ ...p, amount_minor: residual, amount_min_minor: undefined, amount_max_minor: undefined });
    }
  }
  P = next_P;
  F = free;

  // 1. кандидаты в обе стороны
  /** @type {Map<CashEventLike, CashEventLike[]>} */
  const C = new Map();
  /** @type {Map<string, CashEventLike[]>} */
  const Cinv = new Map();
  for (const p of P) Cinv.set(plan_id(p), []);
  for (const f of F) {
    const fd = day_of(f);
    const cand = P.filter((p) => p.account_id === f.account_id && p.currency === f.currency
      && sign_of(p.amount_minor) === sign_of(f.amount_minor)
      && (fd - day_of(p)) >= -win && (fd - day_of(p)) <= win
      && dev_class(f.amount_minor, p, tol) !== 'far');
    C.set(f, cand);
    for (const p of cand) Cinv.get(plan_id(p)).push(f);
  }

  // 2. решение; обход по (date, amount_minor, id) — результат от порядка входов не зависит
  const order = [...F].sort((a, b) => (day_of(a) - day_of(b)) || (a.amount_minor - b.amount_minor) || cmp_str(fact_id(a), fact_id(b)));
  const in_doubles = new Set();
  for (const f of order) {
    const cand = C.get(f);
    if (cand.length === 0) { unmatched_facts.push(f); continue; }
    if (cand.length === 1) {
      const p = cand[0];
      const inv = Cinv.get(plan_id(p));
      if (inv.length === 1 && dev_class(f.amount_minor, p, tol) === 'in_tol') {
        matches.push({ plan: p, facts: [f], by: 'auto' });
        used_plan.add(plan_id(p));
      } else {
        doubles.push({ fact: f, candidates: [p], reason: inv.length > 1 ? 'contested' : 'near_tolerance' });
        in_doubles.add(plan_id(p));
      }
    } else {
      doubles.push({ fact: f, candidates: cand, reason: 'ambiguous' });
      for (const p of cand) in_doubles.add(plan_id(p));
    }
  }
  const unmatched_plans = P.filter((p) => !used_plan.has(plan_id(p)) && !partial_ids.has(plan_id(p)) && !in_doubles.has(plan_id(p)));
  return { matches, doubles, partials, unmatched_plans, unmatched_facts };
}

/**
 * Статус вхождения на `as_of`: терминальные (`matched`, `skipped`, `cancelled`) задают сопоставление и пользователь;
 * иначе `overdue`, если `date + grace < as_of`, иначе `expected`. Статус выводится заново при каждом `as_of`, не хранится.
 * @param {CashEventLike} plan
 * @param {EpochDay|string} as_of
 * @param {object} [params] `grace_days.income` (3), `grace_days.expense` (0)
 * @returns {OccStatus}
 */
export function classify_occurrence(plan, as_of, params) {
  if (plan.status === 'matched' || plan.status === 'skipped' || plan.status === 'cancelled') return plan.status;
  const g = plan.amount_minor > 0 ? param(params, 'grace_days.income') : param(params, 'grace_days.expense');
  return day_of(plan) + g < to_epoch_day(as_of) ? 'overdue' : 'expected';
}

/**
 * Проставить статусы плановым событиям (вызывается из `build_events`, ALG-02). Чистая: возвращает копии в порядке входа.
 * Сопоставленные — `matched`; остальные — `classify_occurrence`; у частично оплаченных (`partials`) сумма заменяется остатком.
 * @param {CashEventLike[]} planned
 * @param {CashEventLike[]} facts
 * @param {EpochDay|string} as_of
 * @param {object} [params]
 * @returns {CashEventLike[]}
 */
export function assign_statuses(planned, facts, as_of, params) {
  const M = match_plan_to_fact(planned, facts, params);
  const matched = new Set(M.matches.map((m) => plan_id(m.plan)));
  const residual = new Map(M.partials.map((r) => [plan_id(r.plan), r.residual]));
  return planned.map((p) => {
    if (p.status === 'matched' || p.status === 'skipped' || p.status === 'cancelled') return { ...p };
    const id = (p.occ_key ?? p.cash_event_id);
    if (id !== undefined && matched.has(id)) return { ...p, status: 'matched' };
    const status = classify_occurrence(p, as_of, params);
    if (id !== undefined && residual.has(id)) {
      const q = { ...p, status, amount_minor: residual.get(id) };
      delete q.amount_min_minor;
      delete q.amount_max_minor;
      return q;
    }
    return { ...p, status };
  });
}

/**
 * Ключ потока для калибровки: `counterparty_id ?? stream_id ?? rule_id ?? cash_event_id`
 * (у событий потока часов `stream_id` задан, `rule_id = null`, C-025).
 * @param {CashEventLike} e
 * @returns {string}
 */
export function flow_key(e) {
  const k = e.counterparty_id ?? e.stream_id ?? e.rule_id ?? e.cash_event_id;
  if (typeof k !== 'string' || k === '') fail('E_SCHEMA', { reason: 'flow_key_unavailable' });
  return k;
}

// ── v1: свежесть и дрейф ───────────────────────────────────────────────────────

/**
 * Скорость «неучтённых» движений: медиана `|drift|/days` по прошлым расхождениям (целая, half_even).
 * @param {{drift_minor: Minor, days: number}[]} drifts наблюдения; `days = 0` пропускается
 * @returns {Minor|null} `null`, если наблюдений нет
 */
export function unlogged_rate(drifts) {
  const r = drifts
    .filter((d) => assert_minor(d.days) >= 1)
    .map((d) => round_div(abs_of(assert_minor(d.drift_minor)), d.days, 'half_even'))
    .sort((a, b) => a - b);
  const n = r.length;
  if (n === 0) return null;
  return n % 2 === 1 ? r[(n - 1) / 2] : round_div(r[n / 2 - 1] + r[n / 2], 2, 'half_even');
}

/**
 * Свежесть данных (D-22): уровень плашки и «не учтено ≈ rate·age».
 * @param {number|null} age возраст якоря в днях по самому несвежему operating-счёту (`anchor_age`); `null` — якоря нет
 * @param {Minor|null} rate результат `unlogged_rate`
 * @param {object} [params] `stale.banner_days` (7), `stale.block_days` (21)
 * @returns {{level: 'fresh'|'banner'|'block', reason?: 'no_anchor'|'stale', unaccounted_minor: Minor|null}}
 */
export function stale_status(age, rate, params) {
  if (age === null || age === undefined) return { level: 'block', reason: 'no_anchor', unaccounted_minor: null };
  const a = assert_minor(age);
  if (a < 0) fail('E_SCHEMA', { reason: 'age_negative', value: a });
  const block = param(params, 'stale.block_days');
  const banner = param(params, 'stale.banner_days');
  const unaccounted_minor = rate === null || rate === undefined ? null : assert_minor(BigInt(assert_minor(rate)) * BigInt(a));
  if (a > block) return { level: 'block', reason: 'stale', unaccounted_minor };
  return { level: a > banner ? 'banner' : 'fresh', unaccounted_minor };
}

// ── v2: калибровка лагов и малые выборки ────────────────────────────────────────

/**
 * Наблюдения лага и отклонения суммы по сопоставленным парам, по ключу потока, хронологически (дата факта, затем id);
 * хранятся последние `window` (по умолчанию `calib.window = 24`). Пары `excluded` (выброс по пометке пользователя) пропускаются.
 * `lag = F.date − P.date` (по последнему факту), `ratio_bp = round_div(10000·|ΣF|, |P|)`.
 * @param {{plan: CashEventLike, facts: CashEventLike[], excluded?: boolean}[]} matches
 * @param {number} [window] окно наблюдений (по умолчанию 24)
 * @returns {Record<string, {lags: number[], ratios_bp: number[]}>}
 */
export function lag_observations(matches, window = CALIBRATION_DEFAULTS['calib.window']) {
  const w = assert_minor(window);
  if (w < 1) fail('E_SCHEMA', { reason: 'window_lt_1', value: w });
  const items = [];
  for (const m of matches) {
    if (m.excluded || !Array.isArray(m.facts) || m.facts.length === 0) continue;
    const b = abs_of(assert_minor(m.plan.amount_minor));
    if (b === 0) continue; // нет базы для отношения сумм
    const sorted = [...m.facts].sort((x, y) => (day_of(x) - day_of(y)) || cmp_str(fact_id(x), fact_id(y)));
    const last = sorted[sorted.length - 1];
    const total = abs_of(sum_minor(m.facts.map((f) => f.amount_minor)));
    items.push({
      key: flow_key(m.plan),
      fact_day: day_of(last),
      fid: fact_id(last),
      lag: day_of(last) - day_of(m.plan),
      ratio_bp: round_div(BigInt(10000) * BigInt(total), BigInt(b), 'half_even'),
    });
  }
  items.sort((x, y) => (x.fact_day - y.fact_day) || cmp_str(x.fid, y.fid));
  /** @type {Record<string, {lags: number[], ratios_bp: number[]}>} */
  const out = {};
  // ключ потока — идентификатор из чужого журнала: «__proto__», «constructor», «toString» — обычные данные (Q-07): только собственные свойства
  for (const it of items) {
    const o = own_has(out, it.key) ? out[it.key] : own_put(out, it.key, { lags: [], ratios_bp: [] });
    o.lags.push(it.lag);
    o.ratios_bp.push(it.ratio_bp);
  }
  for (const k of Object.keys(out)) {
    if (out[k].lags.length > w) {
      out[k].lags = out[k].lags.slice(-w);
      out[k].ratios_bp = out[k].ratios_bp.slice(-w);
    }
  }
  return out;
}

/**
 * Квантиль nearest-rank: `sorted_asc[max(0, ceil(q·n/100) − 1)]` (владелец — calibration; `montecarlo` реэкспортирует, C-050).
 * @param {number[]} sorted_asc отсортированная по возрастанию непустая выборка
 * @param {number} q 0…100
 * @returns {number}
 */
export function nearest_rank(sorted_asc, q) {
  if (!Array.isArray(sorted_asc) || sorted_asc.length === 0) fail('E_SCHEMA', { reason: 'nearest_rank_empty' });
  const qq = assert_minor(q);
  if (qq < 0 || qq > 100) fail('E_SCHEMA', { reason: 'q_out_of_range', value: qq });
  return sorted_asc[Math.max(0, ceil_div(qq * sorted_asc.length, 100) - 1)];
}

/**
 * EWMA в миллионных долях единицы: `s_0 = x_0·10^6`, `s_k = round_div(α·x_k·10^6 + (10000−α)·s_{k−1}, 10000, half_even)`.
 * @param {number[]} xs хронологичный непустой массив целых
 * @param {number} alpha_bp вес нового наблюдения, bp (3000 = 0,3)
 * @returns {number} значение·10^6
 */
export function ewma(xs, alpha_bp) {
  if (!Array.isArray(xs) || xs.length === 0) fail('E_SCHEMA', { reason: 'ewma_empty' });
  const a = BigInt(assert_minor(alpha_bp));
  if (a < 0n || a > 10000n) fail('E_SCHEMA', { reason: 'alpha_bp_out_of_range', value: String(alpha_bp) });
  let s = BigInt(assert_minor(xs[0])) * 1000000n;
  for (let i = 1; i < xs.length; i++) {
    s = BigInt(round_div(a * BigInt(assert_minor(xs[i])) * 1000000n + (10000n - a) * s, 10000n, 'half_even'));
  }
  return assert_minor(s);
}

/**
 * Сжатие медианы к prior: `round_div(n·median + k·prior, n + k, half_even)`; `n = 0` → `prior`.
 * «Медиана» — nearest-rank `p50` (C-052). Подсказка интерфейса: дату в `expected` сдвигает только `lag_p50` при `n ≥ 10` (C-053).
 * @param {number|null} median
 * @param {number} n объём выборки
 * @param {number} prior
 * @param {number} k вес prior
 * @returns {number}
 */
export function shrink_to_prior(median, n, prior, k) {
  const nn = assert_minor(n);
  const kk = assert_minor(k);
  if (nn < 0 || kk < 0 || nn + kk === 0) fail('E_SCHEMA', { reason: 'shrink_weights', n: nn, k: kk });
  if (nn === 0) return assert_minor(prior);
  return round_div(BigInt(nn) * BigInt(assert_minor(median)) + BigInt(kk) * BigInt(assert_minor(prior)), BigInt(nn + kk), 'half_even');
}

/**
 * Калибровка потока по лагам и отношениям сумм: квантили nearest-rank, EWMA, сжатие к prior, готовность режима `expected`.
 * @param {number[]} lags лаги хронологически
 * @param {number[]} ratios_bp отношения сумм хронологически
 * @param {number} [prior] 7
 * @param {number} [k] 3
 * @param {number} [alpha_bp] 3000
 * @returns {{n: number, p50?: number, p80?: number, p90?: number, p90_label?: string|null, ewma_days?: number,
 *   shrunk_days?: number, ratio_ewma_bp?: number|null, expected_ready?: boolean}}
 */
export function flow_calibration(lags, ratios_bp, prior = CALIBRATION_DEFAULTS['calib.prior'], k = CALIBRATION_DEFAULTS['calib.k'], alpha_bp = CALIBRATION_DEFAULTS['calib.alpha_bp']) {
  if (!Array.isArray(lags)) fail('E_SCHEMA', { reason: 'lags_not_array' }); // «constructor» из словаря чужого журнала — не массив лагов
  const n = lags.length;
  if (n === 0) return { n: 0 };
  const s = [...lags].map(assert_minor).sort((a, b) => a - b);
  const p50 = nearest_rank(s, 50);
  const p80 = nearest_rank(s, 80);
  const p90 = nearest_rank(s, 90);
  return {
    n,
    p50,
    p80,
    p90,
    p90_label: ceil_div(90 * n, 100) === n ? `наибольшее из ${n}` : null,
    ewma_days: round_div(ewma(lags, alpha_bp), 1000000, 'half_even'),
    shrunk_days: shrink_to_prior(p50, n, prior, k),
    ratio_ewma_bp: ratios_bp !== undefined && ratios_bp !== null && ratios_bp.length > 0 ? round_div(ewma(ratios_bp, alpha_bp), 1000000, 'half_even') : null,
    expected_ready: n >= 10,
  };
}

/**
 * Лаг для режима `expected`: `p50`, если выборка достаточна (`n ≥ 10`), иначе `null` (режим как `plan`, D-04).
 * @param {{expected_ready?: boolean, p50?: number}} cal результат `flow_calibration`
 * @returns {number|null}
 */
export function expected_lag(cal) {
  return cal.expected_ready === true ? cal.p50 : null;
}

/**
 * Интервал Уилсона для доли `k/n` (границы в ‰, к ближайшему; C-049). Float только здесь.
 * @param {number} k успехов, 0…n
 * @param {number} n испытаний ≥ 1
 * @param {number} [z_x100] квантиль·100 (196 → 1,96)
 * @returns {{lo_pm: number, hi_pm: number}}
 */
export function wilson(k, n, z_x100 = 196) {
  if (!Number.isInteger(k) || !Number.isInteger(n) || n < 1 || k < 0 || k > n) fail('E_SCHEMA', { reason: 'wilson_args', k: String(k), n: String(n) });
  const z = assert_minor(z_x100) / 100;
  const p = k / n;
  const den = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / den;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return {
    lo_pm: Math.max(0, Math.floor(1000 * (c - h) + 0.5)),
    hi_pm: Math.min(1000, Math.floor(1000 * (c + h) + 0.5)),
  };
}

