// backtest.mjs — backtest «как знали тогда», метрики ошибки и ложного спокойствия, гейт релиза (ALG-13 v2, REQ-176, REQ-185, ADR-014).
// Канон: design-brief §14 B4 (модуль вынесен из `calibration`: `backtest`, `release_gate`, `default_breach`), D-22, C-055, C-056, C-082;
// canon-decisions «Финальные сигнатуры» (calibration.mjs → backtest.mjs); wiki/algorithms/alg-13-plan-vs-actual-calibration.md, product/11 (TST-55).
// Зависимости (правило слоёв §14 B4): `index` (`analyze`), `afford` (`check_purchase`), `ledger` (`state_at`, `reduce`, `effective_events`),
// `calibration` и нижележащие. От `tools` и `verifier` модуль не зависит. Модуль чистый: ни часов, ни случайности, ни ввода-вывода;
// даты — аргументы и записи журнала. Деньги — целые; float нет.
//
// Что измеряется. Для начал `t = t0 + j·h` строится прогноз «как знали тогда» (журнал, срез по `recorded_at ≤ t`), сравнивается с фактическим
// остатком на `t + h` из ПОЛНОГО журнала: MAE, bias, skill против «баланс не меняется», покрытие коридора `plan`–`worse`, ошибка минимума
// (REQ-185). Отдельно — пробные покупки: реальные расходы без `is_obligation` и `is_estimate` с `|amount| ≥ θ`; вердикт `check_purchase` на
// день раньше покупки сверяется с фактом «пробой буфера» (`min` фактического `free` на `[e.date, e.date + H] < B(t)`, `H = backtest.h_days`):
// FRR = доля вердиктов `OK` с пробоем, cry-wolf = доля `FRAGILE`/`NO` без пробоя. `release_gate` — по сумме счётчиков по журналам.
// Все значения порогов и окон (30 дн., 14 дн., θ, 5 %, 50 %) — гипотезы до первого замера на журналах добровольцев (C-055).
// В прототипе гейт демонстрируется на СИНТЕТИЧЕСКИХ журналах (tests/backtest.test.mjs, data/synthetic-journals/): реальных журналов нет.

import { fail, assert_minor, round_div, sum_minor, own_put } from './money.mjs';
import { to_epoch_day } from './dates.mjs';
import { normalize_ws } from './timeline.mjs';
import { reserve_open, reserve_series } from './sinking.mjs';
import { allocations_for_events } from './tax.mjs';
import { to_decision, opening_in_decision } from './fx.mjs';
import { check_purchase } from './afford.mjs';
import { analyze } from './index.mjs';
import { effective_events, reduce, state_at } from './ledger.mjs';
import { vdefault as vd } from './param_defaults.mjs';

/** @typedef {import('./money.mjs').Minor} Minor */
/** @typedef {import('./dates.mjs').EpochDay} EpochDay */
/**
 * @typedef {object} Report
 * @property {number} n_origins число начал прогноза, по которым посчитаны метрики
 * @property {boolean} hidden `n_origins < min_origins`: метрики подаются как «данных мало» (значения всё равно посчитаны)
 * @property {Minor|null} mae_minor среднее `|прогноз − факт|` остатка на `t + h` (`null`, если начал нет)
 * @property {Minor|null} bias_minor среднее `прогноз − факт` (знак: прогноз выше факта — плюс)
 * @property {number|null} skill_pm `1000 − floor(1000·MAE/MAE_naive)`; `null`, если наивный прогноз точен (MAE_naive = 0)
 * @property {{k: number, n: number}} coverage попаданий факта в коридор из `n_origins`
 * @property {{k: number, n: number, bp: number|null}} frr вердиктов `OK` с пробоем буфера / всех `OK`
 * @property {{k: number, n: number, bp: number|null}} cry_wolf `FRAGILE`/`NO` без пробоя / всех `FRAGILE`/`NO`
 * @property {number} insufficient проб с ответом «данных мало» (не входят в метрики, D-22)
 * @property {{n: number, mean_bp: number|null, mae_bp: number|null}} min_error ошибка минимума `trough` режима `plan` (REQ-185)
 * @property {number} n_tight проб с вердиктом `TIGHT` (не входят ни в FRR, ни в cry-wolf — формулы ALG-13)
 * @property {number} censored проб, чьё окно `H` выходит за последний факт (исход не наблюдён — не учитываются)
 * @property {number} skipped_origins начал, на которые журнал ещё не содержал `operating`-счёта
 */

/** Гипотезы §2.0 / N5: значения читаются из `vocab.json` через `vocab.generated.mjs` (FP-17, REQ-019); тест сверяет с файлом. */
export const BACKTEST_DEFAULTS = Object.freeze({
  'backtest.h_days': vd('backtest.h_days'),
  'backtest.min_window_days': vd('backtest.min_window_days'),
  'calib.min_origins': vd('calib.min_origins'),
});

const SOURCES = ['income', 'schedule', 'manual', 'release'];

// ── фактический ряд по полному журналу ─────────────────────────────────────────────────────────────────────────────────

/** Счёт открыт на дату и не закрыт (как в timeline). */
function active_on(a, d) {
  if (a.opened_on !== undefined && a.opened_on !== null && to_epoch_day(a.opened_on) > d) return false;
  if (a.closed_on !== undefined && a.closed_on !== null && to_epoch_day(a.closed_on) <= d) return false;
  return true;
}

/**
 * Фактический ряд по полному журналу на `[from, to]` (ALG-13, C-055): `trough[d]` — остаток на конец `d − 1` плюс исходящие факты дня
 * (расходы раньше доходов, D-01), `close[d]` — остаток по якорям и фактам (как `opening_state`), `reserve_trough[d]` — резервы после
 * взносов и высвобождений дня до доходов (D-08) по ЗАПИСАННЫМ аллокациям журнала; для налогового правила, по которому поступившему доходу
 * аллокация не записана, она добавляется на лету по правилу (как делает прогноз). `free = trough − reserve_trough`.
 * Факты считаются в валюте решения по `spot` на дату факта; перевод, обе ноги которого на operating-счетах (`transfer_id`), из потоков исключён (нетто 0, D-20); перевод на справочный счёт — обычный расход.
 * @param {object} full рабочая область (состояние `reduce` полного журнала либо любая форма `ws` движка)
 * @param {EpochDay|string} from
 * @param {EpochDay|string} to не раньше `from`
 * @returns {{from: EpochDay, opening_minor: Minor, close: Minor[], trough: Minor[], reserve_trough: Minor[], free: Minor[]}}
 * @throws {RunwayError} E_BAD_DATE (`to < from`), E_SCHEMA (нет валюты решения), E_NO_RATE
 */
export function actual_rows(full, from, to) {
  const w = normalize_ws(full);
  const f0 = to_epoch_day(from);
  const t1 = to_epoch_day(to);
  if (t1 < f0) fail('E_BAD_DATE', { reason: 'actual_rows_to_before_from', from: f0, to: t1 });
  if (w.decision_currency === null) fail('E_SCHEMA', { reason: 'decision_currency_unknown' });
  const fx = { rates: w.rates, decision_currency: w.decision_currency, policy: 'spot', rounding: w.params.rounding };
  const N = t1 - f0 + 1;
  const operating = w.accounts.filter((a) => a.liquidity === 'operating');
  const op_ids = new Set(operating.map((a) => a.account_id));
  const by_acc = new Map(operating.map((a) => [a.account_id, { anchors: [], facts: [] }]));
  for (const a of w.anchors) if (by_acc.has(a.account_id)) by_acc.get(a.account_id).anchors.push(a); // уже по (date, id)
  const facts = w.facts.filter((f) => op_ids.has(f.account_id));
  const legs = new Map(); // transfer_id → счета ног
  for (const f of w.facts) if (f.transfer_id !== undefined && f.transfer_id !== null) legs.set(f.transfer_id, [...(legs.get(f.transfer_id) ?? []), f.account_id]);
  const internal = (f) => f.transfer_id !== undefined && f.transfer_id !== null && legs.get(f.transfer_id).every((id) => op_ids.has(id));
  for (const f of facts) by_acc.get(f.account_id).facts.push(f);

  /** Остаток всех operating-счетов на конец дня `d`: последний якорь `≤ d` плюс факты после него (как `opening_state`). */
  const total_at = (d) => {
    const active = operating.filter((a) => active_on(a, d));
    const bal = new Map();
    for (const a of active) {
      const g = by_acc.get(a.account_id);
      let last = null;
      for (const an of g.anchors) if (an.date <= d) last = an; else break;
      const base = last === null ? 0 : last.amount_minor;
      const after = last === null ? -Infinity : last.date;
      bal.set(a.account_id, sum_minor([base, ...g.facts.filter((f) => after < f.date && f.date <= d).map((f) => f.amount_minor)]));
    }
    return opening_in_decision(active, bal, fx, d);
  };
  const out_of = (d) => sum_minor(facts.filter((f) => f.date === d && f.amount_minor < 0 && !internal(f)
    && active_on(operating.find((a) => a.account_id === f.account_id), d)).map((f) => to_decision(f.amount_minor, f.currency, d, fx).amount_minor));

  const opening_minor = total_at(f0 - 1);
  const close = new Array(N);
  const trough = new Array(N);
  let prev = opening_minor;
  for (let i = 0; i < N; i++) {
    const d = f0 + i;
    trough[i] = prev + out_of(d);
    close[i] = total_at(d);
    prev = close[i];
  }

  // резервы (D-08): записанные аллокации журнала + (на лету) налоговые по поступившим доходам, для которых аллокация не записана.
  // Состояние на начало окна — как у reserve_open (записанное до from) плюс аллокации на лету по доходам раньше from: результат дня не зависит от
  // того, с какой даты начато окно. Платёж, привязанный к резерву (reserve_id), высвобождает резерв внутри окна (min(funded, платёж)).
  const recorded = w.allocations.map((a) => ({ ...a, date: to_epoch_day(a.date), source: a.source ?? 'manual' }));
  const recorded_ids = new Set(recorded.map((a) => a.allocation_id));
  const recorded_events = new Set(recorded.flatMap((a) => [a.source_event_id, typeof a.allocation_id === 'string' && a.allocation_id.startsWith('tax:') ? a.allocation_id.slice(a.allocation_id.indexOf('@') + 1) : null]).filter((x) => typeof x === 'string'));
  const open_res = w.reserves.filter((r) => r.backed_by_account_id === null || r.backed_by_account_id === undefined);
  const lower = new Map(open_res.map((r) => [r.reserve_id, r.funded_as_of === undefined || r.funded_as_of === null ? -Infinity : to_epoch_day(r.funded_as_of)]));
  const allocs = recorded.filter((a) => a.date >= f0 && a.date <= t1 && lower.has(a.reserve_id) && a.date > lower.get(a.reserve_id)
    && SOURCES.includes(a.source) && !(a.source === 'income' && a.amount_minor < 0));
  const derived_before = new Map();
  if (w.tax_rules.length > 0) {
    const inc = facts.filter((f) => f.date <= t1 && f.amount_minor > 0 && !recorded_events.has(f.cash_event_id) && !internal(f))
      .map((f) => ({
        cash_event_id: f.cash_event_id, layer: 'planned', kind: 'income', date: f.date, plan_date: f.date, tag: f.tag, stream_id: f.stream_id ?? null,
        amount_minor: to_decision(f.amount_minor, f.currency, f.date, fx).amount_minor,
      }));
    const base = inc.reduce((m, e) => Math.min(m, e.date), 0); // версия правила — по дате поступления
    for (const a of allocations_for_events(inc, w.tax_rules, base)) {
      if (recorded_ids.has(a.allocation_id) || !lower.has(a.reserve_id) || a.date <= lower.get(a.reserve_id)) continue;
      if (a.date >= f0) allocs.push(a);
      else derived_before.set(a.reserve_id, (derived_before.get(a.reserve_id) ?? 0) + a.amount_minor);
    }
  }
  const reserves = open_res.map((r) => ({ ...r, funded_open_minor: Math.max(0, reserve_open(r, recorded, f0 - 1) + (derived_before.get(r.reserve_id) ?? 0)) }));
  const pay = facts.filter((f) => f.date >= f0 && f.date <= t1 && f.amount_minor < 0 && typeof f.reserve_id === 'string')
    .map((f) => ({ reserve_id: f.reserve_id, date: f.date, amount_minor: to_decision(f.amount_minor, f.currency, f.date, fx).amount_minor }));
  const rs = reserve_series(reserves, pay, allocs, f0, t1);
  const free = trough.map((x, i) => x - rs.reserve_trough[i]);
  return { from: f0, opening_minor, close, trough, reserve_trough: rs.reserve_trough, free };
}

/** Фактический остаток на конец дня `d` по полному журналу. */
export function actual_close(full, d) {
  return actual_rows(full, d, d).close[0];
}

/** Фактический `trough` дня `d` (расходы раньше доходов). */
export function actual_trough(full, d) {
  return actual_rows(full, d, d).trough[0];
}

/** Резервы на момент «до доходов дня» `d` по полному журналу. */
export function reserve_trough(full, d) {
  return actual_rows(full, d, d).reserve_trough[0];
}

/**
 * `actual_free(d) = actual_trough(d) − reserve_trough(d)` по полному журналу (C-055).
 * @param {object} full
 * @param {EpochDay|string} d
 * @returns {Minor}
 */
export function actual_free(full, d) {
  return actual_rows(full, d, d).free[0];
}

/**
 * Исход «пробой буфера» по умолчанию (C-055, рабочее определение до первого замера): `min` фактического `free` на `[e.date, e.date + H] < B`.
 * @param {object} full полный журнал, свёрнутый `reduce` (или `ws`)
 * @param {{date: EpochDay|string}} e проба (реальный расход)
 * @param {number} H окно, дней (`backtest.h_days = 30`, гипотеза)
 * @param {Minor} B буфер на момент вопроса
 * @returns {boolean}
 * @throws {RunwayError} E_SCHEMA (`H` не целое ≥ 0)
 */
export function default_breach(full, e, H, B) {
  if (!Number.isSafeInteger(H) || H < 0) fail('E_SCHEMA', { reason: 'breach_window_not_nonneg_int', value: String(H) });
  const d0 = to_epoch_day(e.date);
  const b = assert_minor(B);
  const free = actual_rows(full, d0, d0 + H).free;
  let m = free[0];
  for (let i = 1; i < free.length; i++) if (free[i] < m) m = free[i];
  return m < b;
}

// ── срез журнала «как знали тогда» ────────────────────────────────────────────────────────────────────────────────────

/**
 * Состояние рабочей области на день `t` «как знали тогда»: записи, введённые не позже `t` (`ledger.state_at`), откаты и правки
 * (`effective_events`), свёртка (`reduce`). Факты с датой после `t` в срез не входят (будущее ещё не произошло).
 * @param {object[]} journal записи журнала
 * @param {EpochDay|string} t
 * @returns {object} состояние (форма `reduce`)
 */
export function replay_state(journal, t) {
  const day = to_epoch_day(t);
  const s = reduce(effective_events(state_at(journal, day)));
  const facts = {};
  for (const k of Object.keys(s.facts)) if (to_epoch_day(s.facts[k].date) <= day) own_put(facts, k, s.facts[k]); // «__proto__» — обычный id факта (Q-07)
  return { ...s, facts };
}

function has_operating(s) {
  return Object.values(s.accounts).some((a) => a.liquidity === 'operating');
}

/**
 * Пробные покупки: реальные расходы (`posted`, `amount < 0`) на operating-счетах без `is_obligation`, `is_estimate` и без переводов
 * между своими счетами; порог `θ` проверяет вызывающий на моменте вопроса (`wave.threshold_minor`).
 * @param {object} full
 * @returns {{id: string, date: EpochDay, amount_minor: Minor, currency: string, account_id: string}[]} по `(date, id)`
 */
export function list_probes(full) {
  const w = normalize_ws(full);
  const op = new Set(w.accounts.filter((a) => a.liquidity === 'operating').map((a) => a.account_id));
  return w.facts.filter((f) => op.has(f.account_id) && f.amount_minor < 0 && f.is_obligation !== true && f.is_estimate !== true
    && (f.transfer_id === undefined || f.transfer_id === null))
    .map((f) => ({ id: f.cash_event_id, date: f.date, amount_minor: f.amount_minor, currency: f.currency, account_id: f.account_id }))
    .sort((a, b) => (a.date - b.date) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Метрики ошибки по окнам (ALG-13, TV-6): `MAE = mean|F − A|`, `bias = mean(F − A)`, `skill = 1000 − floor(1000·Σ|F − A| / Σ|N0 − A|)`
 * (наивный прогноз — «баланс не меняется»), покрытие — число окон, где факт внутри коридора.
 * @param {{forecast: Minor, actual: Minor, naive: Minor, lo: Minor, hi: Minor}[]} windows
 * @returns {{n: number, mae_minor: Minor|null, bias_minor: Minor|null, skill_pm: number|null, hits: number}}
 */
export function window_metrics(windows) {
  let err = 0;
  // суммы модулей — BigInt (Q-28): 1000·Σ|F − A| выходило за safe-integer, и floor-деление вещественным числом округляло
  let abs_err = 0n;
  let abs_naive = 0n;
  let hits = 0;
  const abs_b = (x) => (x < 0n ? -x : x);
  for (const w of windows) {
    err += assert_minor(w.forecast) - assert_minor(w.actual);
    abs_err += abs_b(BigInt(assert_minor(w.forecast)) - BigInt(assert_minor(w.actual)));
    abs_naive += abs_b(BigInt(assert_minor(w.naive)) - BigInt(assert_minor(w.actual)));
    if (w.lo <= w.actual && w.actual <= w.hi) hits++;
  }
  const n = windows.length;
  return {
    n,
    mae_minor: n === 0 ? null : round_div(assert_minor(abs_err), n),
    bias_minor: n === 0 ? null : round_div(assert_minor(err), n),
    skill_pm: abs_naive === 0n ? null : Number(1000n - (1000n * abs_err) / abs_naive),
    hits,
  };
}

function min_of(xs) {
  let m = xs[0];
  for (let i = 1; i < xs.length; i++) if (xs[i] < m) m = xs[i];
  return m;
}

/**
 * Backtest «как знали тогда» (ALG-13 v2). Начала `t = t0 + j·h` (непересекающиеся окна, `t + h ≤` последний факт); для каждого — `analyze`
 * по срезу журнала на `t`, сравнение с фактом на `t + h`. Пробы: расходы без `is_obligation` и `is_estimate` с `|amount| ≥ θ`
 * (`θ = wave.threshold_minor` на `t`), вопрос `check_purchase` на день раньше покупки (горизонт — до `e.date + H`), исход — `opts.breach` или
 * `default_breach`. «Данных мало» уходит в `insufficient`; пробы с окном `H` за последним фактом (`censored`) не учитываются — исход не наблюдён;
 * `TIGHT` не входит ни в FRR, ни в cry-wolf (формулы ALG-13).
 * @param {object[]} journal записи журнала (`ledger.make_event`)
 * @param {EpochDay|string} t0 первая дата-источник
 * @param {number} h шаг сравнения, дней ≥ 1
 * @param {{H?: number, band?: 'plan_worse'|((analysis: object, t: EpochDay, h: number) => {lo: Minor, hi: Minor}), breach?: (full: object, e: object, H: number, B: Minor) => boolean,
 *   min_origins?: number, min_window_days?: number}} [opts] `H = backtest.h_days` (30); `band` — коридор покрытия: по умолчанию `[min(plan, worse), max]`;
 *   P10–P90 (ALG-10) задаёт вызывающий функцией (слои: `montecarlo` не зависит от `backtest` и наоборот); `min_origins = 3`
 * @returns {Report}
 * @throws {RunwayError} E_SCHEMA (`h`, `H` не целые), ошибки `analyze` на данных журнала
 */
export function backtest(journal, t0, h, opts = {}) {
  const H = opts.H ?? BACKTEST_DEFAULTS['backtest.h_days'];
  const min_origins = opts.min_origins ?? BACKTEST_DEFAULTS['calib.min_origins'];
  const win_days = opts.min_window_days ?? BACKTEST_DEFAULTS['backtest.min_window_days'];
  if (!Number.isSafeInteger(h) || h < 1) fail('E_SCHEMA', { reason: 'backtest_step_not_positive_int', value: String(h) });
  if (!Number.isSafeInteger(H) || H < 0) fail('E_SCHEMA', { reason: 'backtest_H_not_nonneg_int', value: String(H) });
  const start = to_epoch_day(t0);
  const full = reduce(effective_events(journal));
  const wf = normalize_ws(full);
  if (wf.facts.length === 0) fail('E_SCHEMA', { reason: 'backtest_journal_without_facts' });
  const last = wf.facts.reduce((m, f) => Math.max(m, f.date), -Infinity);
  const band = opts.band ?? 'plan_worse';

  let skipped = 0;
  const windows = [];
  let min_n = 0;
  let min_sum = 0;
  let min_abs = 0;
  for (let t = start; t + h <= last; t += h) {
    const s = replay_state(journal, t);
    if (!has_operating(s)) { skipped++; continue; }
    const A = analyze(s, { as_of: t, horizon_end: t + h });
    const F = A.series.plan.close[h];
    const W = A.series.worse.close[h];
    const N0 = A.series.plan.opening_minor;
    const rows = actual_rows(full, t, t + h);
    const act = rows.close[h];
    const { lo, hi } = typeof band === 'function' ? band(A, t, h) : { lo: Math.min(F, W), hi: Math.max(F, W) };
    windows.push({ forecast: F, actual: act, naive: N0, lo, hi });
    // ошибка минимума (REQ-185): режим plan, физический trough, окно min_window_days
    const w = Math.min(win_days, h + 1);
    const f_min = min_of(A.series.plan.trough.slice(0, w));
    const a_min = min_of(rows.trough.slice(0, w));
    if (f_min !== 0) {
      const e_bp = round_div(10000 * (a_min - f_min), Math.abs(f_min), 'half_even');
      min_n++;
      min_sum += e_bp;
      min_abs += Math.abs(e_bp);
    }
  }

  const n = windows.length;
  const wm = window_metrics(windows);
  let n_ok = 0; let k_ok = 0; let n_al = 0; let k_al = 0; let insufficient = 0; let n_tight = 0; let censored = 0;
  const cache = new Map();
  for (const e of list_probes(full)) {
    const t = e.date - 1;
    if (t < start) continue;
    if (e.date + H > last) { censored++; continue; } // окно исхода не наблюдено до конца
    let c = cache.get(t);
    if (c === undefined) {
      const s = replay_state(journal, t);
      c = has_operating(s) ? { s, A: analyze(s, { as_of: t, horizon_end: e.date + H }) } : null;
      cache.set(t, c);
    }
    if (c === null) continue;
    const A = c.A;
    const amount = -to_decision(e.amount_minor, e.currency, e.date, { rates: normalize_ws(c.s).rates, decision_currency: A.decision_currency, policy: 'spot', rounding: A.params.rounding }).amount_minor;
    if (amount < A.params['wave.threshold_minor']) continue; // не проба: ниже θ
    const B = A.buffer_minor;
    const ans = check_purchase(A, { currency: A.decision_currency, parts: [{ date: e.date, amount_minor: amount }] }, B);
    if (ans.kind !== 'ok') { insufficient++; continue; }
    const br = (opts.breach ?? default_breach)(full, { ...e, date: e.date, amount_minor: e.amount_minor }, H, B);
    if (ans.verdict === 'OK') { n_ok++; if (br) k_ok++; }
    else if (ans.verdict === 'FRAGILE' || ans.verdict === 'NO') { n_al++; if (!br) k_al++; }
    else n_tight++;
  }
  return {
    n_origins: n,
    hidden: n < min_origins,
    mae_minor: wm.mae_minor,
    bias_minor: wm.bias_minor,
    skill_pm: wm.skill_pm,
    coverage: { k: wm.hits, n },
    frr: { k: k_ok, n: n_ok, bp: n_ok === 0 ? null : round_div(10000 * k_ok, n_ok) },
    cry_wolf: { k: k_al, n: n_al, bp: n_al === 0 ? null : round_div(10000 * k_al, n_al) },
    insufficient,
    min_error: { n: min_n, mean_bp: min_n === 0 ? null : round_div(min_sum, min_n), mae_bp: min_n === 0 ? null : round_div(min_abs, min_n) },
    n_tight,
    censored,
    skipped_origins: skipped,
  };
}

/**
 * Гейт релиза REQ-176 (C-055): счётчики суммируются по журналам; проходит, если журналов не меньше 10, `N1 > 0`, `N2 > 0`,
 * `FRR ≤ 5 %` (`10000·K1 ≤ 500·N1`) и `cry-wolf ≤ 50 %` (`10000·K2 ≤ 5000·N2`). `n_ok = 0` или `n_al = 0` — замера нет, гейт не пройден.
 * Пороги — гипотезы до первого замера; в прототипе гейт проверяется на синтетических журналах.
 * @param {Pick<Report, 'frr'|'cry_wolf'>[]} reports отчёты `backtest` по журналам
 * @returns {{pass: boolean, n_journals: number, k1: number, n1: number, k2: number, n2: number, frr_bp: number|null, cry_wolf_bp: number|null, reasons: string[]}}
 */
export function release_gate(reports) {
  let k1 = 0; let n1 = 0; let k2 = 0; let n2 = 0;
  for (const r of reports) {
    k1 += assert_minor(r.frr.k);
    n1 += assert_minor(r.frr.n);
    k2 += assert_minor(r.cry_wolf.k);
    n2 += assert_minor(r.cry_wolf.n);
  }
  const reasons = [];
  if (reports.length < 10) reasons.push('journals_lt_10');
  if (n1 === 0) reasons.push('no_ok_verdicts');
  if (n2 === 0) reasons.push('no_alarms');
  if (n1 > 0 && 10000 * k1 > 500 * n1) reasons.push('frr_above_5pct');
  if (n2 > 0 && 10000 * k2 > 5000 * n2) reasons.push('cry_wolf_above_50pct');
  return {
    pass: reasons.length === 0,
    n_journals: reports.length,
    k1, n1, k2, n2,
    frr_bp: n1 === 0 ? null : round_div(10000 * k1, n1),
    cry_wolf_bp: n2 === 0 ? null : round_div(10000 * k2, n2),
    reasons,
  };
}
