// afford.mjs — Q3 «могу ли я это купить?» и «можно потратить» на ряде свободного остатка `free` (ALG-04, ALG-11).
// Канон: design-brief D-11, D-12, §3.9 (PurchaseAnswer, Result.facts.sts), §5 (afford.mjs), §14 B3/B4, N6; C-015, C-017, C-018, C-019, C-021,
// C-058, C-067, C-076; canon-decisions «Финальные сигнатуры» (afford.mjs); wiki/algorithms/alg-04-can-i-afford.md, alg-11-safe-to-spend.md; ADR-006, ADR-016.
// Зависимости (правило слоёв §14 B4): money, dates, timeline. Модуль чистый: ни часов, ни случайности, ни ввода-вывода;
// ряды приходят готовыми в `ctx` (`Analysis` из `analyze()`, C-012). `purchase_to_events` живёт в timeline.mjs (C-008).
// Это ликвидность по правилам пользователя, не совет покупать; числа — расчёт по введённым данным.
//
// Вердикты сравнивают минимум `free` после покупки с буфером; граница включительная (`≥ B` — держится).
// Единый защитный признак режима `baseline_below_buffer_m = min free_m < B` (C-015): при нём `S_max_m = 0`, `earliest_m = null`.

import { fail, assert_minor } from './money.mjs';
import { to_epoch_day } from './dates.mjs';
import { get_param, normalize_mode, argmin_first } from './timeline.mjs';

/** @typedef {import('./money.mjs').Minor} Minor */
/** @typedef {import('./dates.mjs').EpochDay} EpochDay */
/** @typedef {'OK'|'TIGHT'|'FRAGILE'|'NO'} Verdict */
/**
 * Результат гейта и ответ «данных мало» (C-018).
 * @typedef {object} InsufficientData
 * @property {'insufficient_data'} kind
 * @property {'readiness'|'stale'|'no_anchor'|'no_buffer'|'rule_disabled'} reason первая причина
 * @property {string[]} reasons все причины
 */
/**
 * Ответ `check_purchase` — объединение (C-017): `ok` | `insufficient_data` | `outside_horizon`.
 * @typedef {object} PurchaseOk
 * @property {'ok'} kind
 * @property {Verdict} verdict
 * @property {{plan: ModeAnswer, worse: ModeAnswer}} by_mode
 * @property {{plan: Minor|null, worse: Minor|null}|null} s_max `null` для покупки из нескольких частей (v1)
 * @property {{plan: EpochDay|null, worse: EpochDay|null}|null} earliest `null` для покупки из нескольких частей (v1)
 * @property {{worse_gap: boolean, cash_gap: boolean, baseline_below_buffer: boolean}} flags по `worse`; по режимам — из `by_mode`
 * @property {Minor} buffer_minor
 * @property {string[]} culprit_event_ids опорные события `headline_mode`
 * @property {Minor} beyond_horizon_minor сумма частей позже `horizon_end` (при `> 0` подпись вердикта обязана это сказать, C-017)
 * @property {{code: string}[]} warnings
 */
/**
 * @typedef {object} ModeAnswer
 * @property {Minor} m_after минимум `free` после покупки
 * @property {EpochDay} at первая дата минимума
 * @property {Minor} margin `m_after − B`
 * @property {Minor} delta `min free − m_after` (насколько покупка снизила минимум)
 * @property {boolean} cash_gap физический `trough` после покупки уходит ниже нуля
 */
/**
 * @typedef {object} PurchasePart
 * @property {EpochDay|string} date
 * @property {Minor} amount_minor > 0
 */

const MODES = ['plan', 'worse'];

// ── служебное ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Ряд `free` режима из `ctx` (ошибка, если ряда нет). */
function free_of(ctx, mode) {
  const f = ctx?.series?.[mode]?.free;
  if (!Array.isArray(f) || f.length === 0) fail('E_SCHEMA', { reason: 'ctx_series_free_missing', mode });
  return f;
}

/** Режим аргумента (по умолчанию — `headline_mode`). */
function mode_of(ctx, mode) {
  return normalize_mode(mode === undefined || mode === null ? get_param(ctx?.params, 'headline_mode') : mode);
}

/** Буфер как целое ≥ 0; `null` — не задан (`E_SCHEMA`: функции ряда без заданного буфера не отвечают). */
function need_buffer(B) {
  if (B === null || B === undefined) fail('E_SCHEMA', { reason: 'buffer_required' });
  const b = assert_minor(B);
  if (b < 0) fail('E_SCHEMA', { reason: 'buffer_negative', value: b });
  return b;
}

/** Минимум массива без `Math.min(...xs)` (безопасно для длинных рядов). */
function min_of(xs) {
  let m = xs[0];
  for (let i = 1; i < xs.length; i++) if (xs[i] < m) m = xs[i];
  return m;
}

// ── суффиксный минимум ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Суффиксный минимум `M[i] = min(a[i..N−1])`; не убывает по `i`; `O(N)`.
 * @param {number[]} a
 * @returns {number[]}
 */
export function suffix_min(a) {
  const N = a.length;
  const M = new Array(N);
  if (N === 0) return M;
  M[N - 1] = a[N - 1];
  for (let i = N - 2; i >= 0; i--) M[i] = a[i] < M[i + 1] ? a[i] : M[i + 1];
  return M;
}

// ── гейт ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Гейт (C-018) — один для Q3 (`check_purchase`, `max_amount`, `earliest_date` на уровне инструментов) и «можно потратить»:
 * `insufficient_data`, если (1) `readiness < ready.q3`; (2) уровень свежести якоря `block` (`stale` или `no_anchor`, D-22);
 * (3) буфер не задан (`no_buffer`; явный `0` — «задан»); (4) есть правило в статусе `disabled` (`rule_disabled`, C-024).
 * Уровень `banner` — плашка, не отказ. Q1 и волны гейтом не блокируются.
 * @param {{readiness: number|{score: number}, anchor_status?: {level: string, reason?: string}, buffer_minor?: Minor|null, rule_status?: Object<string, string>, params?: object}} ctx
 * @param {Minor|null} [buffer_minor] буфер вызова (N6: эффективный буфер = `arg ?? ctx.buffer_minor`)
 * @returns {null|InsufficientData}
 * @throws {RunwayError} E_SCHEMA (нет `readiness` в `ctx`)
 */
export function gate(ctx, buffer_minor) {
  const score = typeof ctx?.readiness === 'number' ? ctx.readiness : ctx?.readiness?.score;
  if (!Number.isSafeInteger(score)) fail('E_SCHEMA', { reason: 'ctx_readiness_missing' });
  const reasons = [];
  if (score < get_param(ctx.params, 'ready.q3')) reasons.push('readiness');
  if (ctx.anchor_status?.level === 'block') reasons.push(ctx.anchor_status.reason ?? 'stale');
  const B = buffer_minor ?? ctx.buffer_minor;
  if (B === null || B === undefined) reasons.push('no_buffer');
  if (Object.values(ctx.rule_status ?? {}).includes('disabled')) reasons.push('rule_disabled');
  return reasons.length === 0 ? null : { kind: 'insufficient_data', reason: reasons[0], reasons };
}

// ── покупка ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Части покупки к расчёту: валюта = валюте решения (иначе `E_CURRENCY_MISMATCH`); сумма — целое `> 0` (иначе `E_SCHEMA`);
 * дата в прошлом зажимается на `as_of` (`W_DATE_CLAMPED`); часть позже `horizon_end` отбрасывается (`W_PART_BEYOND_HORIZON`).
 * @param {{as_of: EpochDay, horizon_end: EpochDay, decision_currency: string}} ctx
 * @param {{currency: string, parts: PurchasePart[]}} purchase
 * @returns {{parts: {date: EpochDay, amount_minor: Minor}[], warnings: {code: string, part: number}[]}}
 * @throws {RunwayError} E_CURRENCY_MISMATCH, E_SCHEMA (нет частей, часть ≤ 0), E_NOT_INTEGER
 */
export function normalize_parts(ctx, purchase) {
  if (purchase?.currency !== ctx.decision_currency) fail('E_CURRENCY_MISMATCH', { currency: String(purchase?.currency), decision_currency: String(ctx.decision_currency) });
  if (!Array.isArray(purchase.parts) || purchase.parts.length === 0) fail('E_SCHEMA', { reason: 'purchase_without_parts' });
  const as_of = to_epoch_day(ctx.as_of);
  const horizon_end = to_epoch_day(ctx.horizon_end);
  const parts = [];
  const warnings = [];
  purchase.parts.forEach((p, k) => {
    const amount = assert_minor(p.amount_minor);
    if (amount <= 0) fail('E_SCHEMA', { reason: 'purchase_part_not_positive', k, value: amount });
    const raw = to_epoch_day(p.date);
    if (raw < as_of) warnings.push({ code: 'W_DATE_CLAMPED', part: k });
    const d = Math.max(raw, as_of);
    if (d > horizon_end) {
      warnings.push({ code: 'W_PART_BEYOND_HORIZON', part: k });
      return;
    }
    parts.push({ date: d, amount_minor: amount });
  });
  return { parts, warnings };
}

/**
 * Вердикт (D-11): `NO` — `m_after_plan < 0`; `TIGHT` — `< B`; `FRAGILE` — план не ниже `B`, а `m_after_worse < B`; иначе `OK`.
 * @param {Minor} m_plan минимум `free` после покупки в `plan`
 * @param {Minor} m_worse то же в `worse`
 * @param {Minor} B буфер
 * @returns {Verdict}
 */
export function verdict_of(m_plan, m_worse, B) {
  if (m_plan < 0) return 'NO';
  if (m_plan < B) return 'TIGHT';
  if (m_worse < B) return 'FRAGILE';
  return 'OK';
}

/**
 * Опорные события: приходы режима, которыми «заканчивается» сужение после точки `j` — `rise` = первый `i > j` с `a[i] > a[j]`;
 * события дохода с `j ≤ день ≤ rise − 1`. Нет подъёма — пусто. В G-001 (`worse`): задержанный доход `S-HOURLY` (11-05 → 11-19).
 * @param {{as_of: EpochDay, events: Object<string, object[]>}} ctx
 * @param {'plan'|'worse'} mode
 * @param {number[]} a ряд (обычно `free` после покупки)
 * @param {number} j индекс узкой точки
 * @returns {string[]} `cash_event_id`
 */
export function binding_events(ctx, mode, a, j) {
  const m = normalize_mode(mode);
  let rise = -1;
  for (let i = j + 1; i < a.length; i++) {
    if (a[i] > a[j]) { rise = i; break; }
  }
  if (rise < 0) return [];
  const as_of = to_epoch_day(ctx.as_of);
  const ids = [];
  for (const e of ctx.events?.[m] ?? []) {
    if (!(e.amount_minor > 0)) continue;
    const i = to_epoch_day(e.date) - as_of;
    if (j <= i && i <= rise - 1) ids.push(e.cash_event_id);
  }
  return ids;
}

/**
 * Максимальная разовая сумма на дату `D` (D-11 (б)): `S_max_m(D) = baseline_below_buffer_m ? 0 : max(0, M_m[idx(D)] − B)`;
 * `D` в прошлом считается на `as_of`; `D` позже горизонта — `null` («в горизонте нет»). Гейт — на стороне вызывающего (`check_purchase`, инструменты).
 * @param {object} ctx `Analysis`
 * @param {EpochDay|string} D
 * @param {Minor} B буфер (задан)
 * @param {'plan'|'worse'|'conservative'} [mode] по умолчанию `headline_mode`
 * @returns {Minor|null}
 */
export function max_amount(ctx, D, B, mode) {
  const m = mode_of(ctx, mode);
  const b = need_buffer(B);
  const as_of = to_epoch_day(ctx.as_of);
  const f = free_of(ctx, m);
  const d = to_epoch_day(D);
  if (d > as_of + f.length - 1) return null;
  if (min_of(f) < b) return 0; // baseline_below_buffer_m (C-015): суффикс не видит просадки до D
  const M = suffix_min(f);
  return Math.max(0, assert_minor(M[Math.max(d, as_of) - as_of] - b));
}

/**
 * Самая ранняя дата, с которой сумма `S` держится в буфере (D-11 (в)): `min{d ≥ not_before : M_m[idx(d)] − S ≥ B}` бинарным поиском
 * по неубывающему `M`; `baseline_below_buffer_m` — `null`; нет такой даты в горизонте — `null`.
 * @param {object} ctx `Analysis`
 * @param {Minor} S сумма > 0
 * @param {EpochDay|string} not_before «не раньше» (раньше `as_of` — считается с `as_of`)
 * @param {Minor} B буфер (задан)
 * @param {'plan'|'worse'|'conservative'} [mode] по умолчанию `headline_mode`
 * @returns {EpochDay|null}
 * @throws {RunwayError} E_SCHEMA (`S ≤ 0`, буфер не задан)
 */
export function earliest_date(ctx, S, not_before, B, mode) {
  const m = mode_of(ctx, mode);
  const s = assert_minor(S);
  if (s <= 0) fail('E_SCHEMA', { reason: 'amount_not_positive', value: s });
  const b = need_buffer(B);
  const need = assert_minor(s + b);
  const as_of = to_epoch_day(ctx.as_of);
  const f = free_of(ctx, m);
  if (min_of(f) < b) return null; // baseline_below_buffer_m (C-015)
  const M = suffix_min(f);
  const N = M.length;
  let lo = Math.max(to_epoch_day(not_before), as_of) - as_of;
  let hi = N;
  while (lo < hi) { // M не убывает: первая позиция с M[i] ≥ need
    const mid = Math.floor((lo + hi) / 2);
    if (M[mid] >= need) hi = mid; else lo = mid + 1;
  }
  return lo < N ? as_of + lo : null;
}

/**
 * «Могу ли я это купить?» (ALG-04): гейт → части → по режимам `plan` и `worse` минимум `free` после покупки, `margin`, `delta`, `cash_gap`;
 * вердикт; для одной части — `s_max` и `earliest` по режимам (для нескольких — `null`, v1); опорные события `headline_mode`.
 * Покупка резервов не меняет, поэтому она уменьшает `trough` и `free` на одну величину (`cum`).
 * @param {object} ctx `Analysis` (нужны ряды обоих режимов `plan` и `worse`)
 * @param {{currency: string, parts: PurchasePart[]}} purchase
 * @param {Minor|null} [B] буфер вызова; `null`/не задан — `ctx.buffer_minor` (N6)
 * @returns {PurchaseOk|InsufficientData|{kind: 'outside_horizon', horizon_end: EpochDay}}
 * @throws {RunwayError} E_CURRENCY_MISMATCH, E_SCHEMA, E_NOT_INTEGER
 */
export function check_purchase(ctx, purchase, B) {
  const effective = B ?? ctx.buffer_minor;
  const g = gate(ctx, effective);
  if (g !== null) return g;
  const b = need_buffer(effective);
  const { parts, warnings } = normalize_parts(ctx, purchase);
  if (parts.length === 0) return { kind: 'outside_horizon', horizon_end: ctx.horizon_end };
  const as_of = to_epoch_day(ctx.as_of);
  const horizon_end = to_epoch_day(ctx.horizon_end);
  let beyond = 0;
  for (const p of purchase.parts) if (to_epoch_day(p.date) > horizon_end) beyond = assert_minor(beyond + assert_minor(p.amount_minor));
  const N = horizon_end - as_of + 1;
  const cum = new Array(N).fill(0);
  for (const p of parts) cum[p.date - as_of] = assert_minor(cum[p.date - as_of] + p.amount_minor);
  for (let i = 1; i < N; i++) cum[i] = assert_minor(cum[i] + cum[i - 1]);
  const after = {};
  const j = {};
  const by_mode = {};
  for (const m of MODES) {
    const s = ctx?.series?.[m];
    const free = free_of(ctx, m);
    if (free.length !== N || !Array.isArray(s.trough) || s.trough.length !== N) fail('E_SCHEMA', { reason: 'ctx_series_length_mismatch', mode: m, N });
    after[m] = free.map((x, i) => assert_minor(x - cum[i]));
    j[m] = argmin_first(after[m], 0, N - 1); // строго «<»: ранняя дата (D-02)
    let cash_min = assert_minor(s.trough[0] - cum[0]);
    for (let i = 1; i < N; i++) { const v = s.trough[i] - cum[i]; if (v < cash_min) cash_min = v; }
    const m_after = after[m][j[m]];
    by_mode[m] = { m_after, at: as_of + j[m], margin: assert_minor(m_after - b), delta: assert_minor(min_of(free) - m_after), cash_gap: cash_min < 0 };
  }
  const single = purchase.parts.length === 1;
  const h = mode_of(ctx, undefined);
  const out = { kind: 'ok', verdict: verdict_of(by_mode.plan.m_after, by_mode.worse.m_after, b), by_mode };
  out.s_max = single ? { plan: max_amount(ctx, parts[0].date, b, 'plan'), worse: max_amount(ctx, parts[0].date, b, 'worse') } : null;
  out.earliest = single ? { plan: earliest_date(ctx, parts[0].amount_minor, as_of, b, 'plan'), worse: earliest_date(ctx, parts[0].amount_minor, as_of, b, 'worse') } : null;
  out.flags = { worse_gap: by_mode.worse.m_after < 0, cash_gap: by_mode.worse.cash_gap, baseline_below_buffer: min_of(free_of(ctx, 'worse')) < b };
  out.buffer_minor = b;
  out.culprit_event_ids = binding_events(ctx, h, after[h], j[h]);
  out.beyond_horizon_minor = beyond;
  out.warnings = warnings;
  return out;
}

// ── safe-to-spend ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Дата `T` «можно потратить» по умолчанию (D-12): ближайшее ожидаемое поступление в `headline_mode` (доход `planned`, статус
 * `expected`/`overdue`, эффективная дата ≥ `as_of`); нет такого — `min(as_of + 30, horizon_end)`.
 * @param {object} ctx `Analysis`
 * @param {EpochDay|string} [as_of] по умолчанию `ctx.as_of`
 * @returns {EpochDay}
 */
export function default_sts_horizon(ctx, as_of) {
  const a = to_epoch_day(as_of ?? ctx.as_of);
  const h = mode_of(ctx, undefined);
  let best = null;
  for (const e of ctx?.events?.[h] ?? []) {
    if (e.layer !== 'planned' || e.kind !== 'income' || !(e.amount_minor > 0)) continue;
    if (e.status !== 'expected' && e.status !== 'overdue') continue;
    const d = to_epoch_day(e.date);
    if (d >= a && (best === null || d < best)) best = d;
  }
  return best === null ? Math.min(a + 30, to_epoch_day(ctx.horizon_end)) : best;
}

/** Ядро «можно потратить» без гейта: `T` зажимается границей горизонта (`W_T_CLAMPED`). */
function sts_core(ctx, T, B, mode) {
  const m = mode_of(ctx, mode);
  const b = need_buffer(B);
  const as_of = to_epoch_day(ctx.as_of);
  const t = to_epoch_day(T);
  if (t < as_of) fail('E_BAD_DATE', { reason: 'T_before_as_of', T: t, as_of });
  const f = free_of(ctx, m);
  const t2 = Math.min(t, as_of + f.length - 1);
  const k = argmin_first(f, 0, t2 - as_of);
  const min_free = f[k];
  return {
    value: {
      sts: Math.max(0, assert_minor(min_free - b)),
      short_to_buffer: Math.max(0, assert_minor(b - min_free)),
      at: as_of + k,
      min_free,
      sts_horizon: Math.max(0, assert_minor(min_of(f) - b)), // STS(horizon_end) = S_max(as_of), C-019
    },
    clamped: t2 !== t,
    mode: m,
    k,
  };
}

/**
 * «Можно потратить до даты `T`» (D-12): `STS = max(0, min_{i ≤ idx(T)} free[i] − B)`; `short_to_buffer = max(0, B − min free)` —
 * «не хватает до буфера (с учётом резервов)», не путать с `gap_w` и Q1 `need`; `sts_horizon = STS(horizon_end) = S_max(as_of)` (C-019).
 * Тот же гейт, что у Q3 (C-018). `T` позже горизонта зажимается (предупреждение `W_T_CLAMPED` — в поле `warnings`, только когда оно есть);
 * `T < as_of` — `E_BAD_DATE`. Если `sts_horizon < sts`, экран добавляет строку «до конца горизонта (дата) — X» (C-058).
 * @param {object} ctx `Analysis`
 * @param {EpochDay|string} T
 * @param {Minor|null} B буфер; `null` — `ctx.buffer_minor`
 * @param {'plan'|'worse'|'conservative'} [mode] по умолчанию `headline_mode`
 * @returns {{sts: Minor, short_to_buffer: Minor, at: EpochDay, min_free: Minor, sts_horizon: Minor, warnings?: {code: 'W_T_CLAMPED'}[]}|InsufficientData}
 * @throws {RunwayError} E_BAD_DATE (`T < as_of`)
 */
export function safe_to_spend(ctx, T, B, mode) {
  const effective = B ?? ctx.buffer_minor;
  const g = gate(ctx, effective);
  if (g !== null) return g;
  const r = sts_core(ctx, T, effective, mode);
  return r.clamped ? { ...r.value, warnings: [{ code: 'W_T_CLAMPED' }] } : r.value;
}

/**
 * Разложение «можно потратить» (REQ-057): `Σ v = min_free − B`. Строки: `opening`, `reserves_start` (−резервы на начало), `payments`
 * (платежи до узкой точки включительно), `incomes` (приходы до неё: расходы раньше доходов), `released` (возвращено из резервов),
 * `reserve_adds` (−взносы и аллокации), `buffer` (−B). Гейт не применяется: его проходит вызывающий перед показом числа.
 * @param {object} ctx `Analysis` (`series[mode].reserve_opening_minor`, `reserve[mode].by_reserve`)
 * @param {EpochDay|string} T
 * @param {Minor|null} B
 * @param {'plan'|'worse'|'conservative'} [mode]
 * @returns {{id: string, v: Minor}[]}
 */
export function sts_breakdown(ctx, T, B, mode) {
  const r = sts_core(ctx, T, B ?? ctx.buffer_minor, mode);
  const s = ctx.series[r.mode];
  const rs = ctx.reserve?.[r.mode];
  const by = rs?.by_reserve ?? {};
  const ids = Object.keys(by).sort();
  const k = r.k;
  const prev = (i) => (i === 0 ? s.opening_minor : s.close[i - 1]);
  let payments = 0;
  let incomes = 0;
  let released = 0;
  let adds = 0;
  for (let i = 0; i <= k; i++) {
    payments += s.trough[i] - prev(i);
    for (const id of ids) {
      released += by[id].released[i];
      adds += by[id].contributed[i];
      if (i < k) adds += by[id].allocated[i];
    }
    if (i < k) incomes += s.close[i] - s.trough[i];
  }
  return [
    { id: 'opening', v: s.opening_minor },
    { id: 'reserves_start', v: 0 - (s.reserve_opening_minor ?? 0) },
    { id: 'payments', v: assert_minor(payments) },
    { id: 'incomes', v: assert_minor(incomes) },
    { id: 'released', v: assert_minor(released) },
    { id: 'reserve_adds', v: 0 - assert_minor(adds) },
    { id: 'buffer', v: 0 - need_buffer(B ?? ctx.buffer_minor) },
  ];
}
