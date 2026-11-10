// band_adapter.mjs — адаптер коридора P10/P50/P90 и «при уверенности α» над `montecarlo.mjs` (FP-11, ALG-10, REQ-054, REQ-055, ADR-008, ADR-015).
// Слой выше `montecarlo`; от `backtest` модуль не зависит (`backtest` не вправе иметь импортёров в `engine/`, кроме себя, — тест слоёв B4): срез журнала «как знали тогда»
// для `mc_band_adapter` подставляет вызывающий (ALG-13). Модуль собирает входы из истории пользователя (`mc_inputs`), строит контекст `mc_context`, запускает `run_paths` с `seed = H(engine_version, inputs_hash, user_seed)` и приводит результат к виду, который
// показывает интерфейс. Он НЕ входит в `analyze`, не меняет `Analysis`, вердикты `OK/TIGHT/FRAGILE/NO` и числа Q1/Q3: это отдельный расчёт «по согласию».
// Честность малых выборок (D-15, REQ-055): без истории — отказ (`no_history`), при `n < 20` — счёт «k из n» (только при полном переборе наблюдений),
// при `n ≥ 20` — процент с интервалом Уилсона; число наблюдений `n` возвращается всегда; квантиль с `ceil(q·n) = n` помечается «наибольшее из n»,
// с `ceil(q·n) = 1` при `q < 50` — «наименьшее из n» (C-049). Слов-обещаний здесь нет: результат — эксперимент, расчёт по введённым данным.
// Зависимости: money, dates, montecarlo, mc_inputs. Чистый: ни часов, ни случайности.

import { fail, assert_minor, ceil_div } from './money.mjs';
import { to_epoch_day } from './dates.mjs';
import { mc_context, run_paths, make_seed, p_fail, q_alpha, s_max_alpha, ok_at_alpha, present_probability } from './montecarlo.mjs';
import { mc_observations } from './mc_inputs.mjs';

/** @typedef {import('./money.mjs').Minor} Minor */
/** @typedef {import('./dates.mjs').EpochDay} EpochDay */

/** Параметры расчёта по умолчанию: возмущаются только задержки платежей (`lag`) — главный источник разрыва и единственный вид, дающий полный перебор «k из n»; `ratio`, `fx`, `hours` — по явному запросу. */
export const BAND_DEFAULTS = Object.freeze({
  n_paths: 1000,
  kinds: Object.freeze(['lag']),
  user_seed: 0,
  step_days: 7,
});

/** Уровни уверенности в «при уверенности α»: 80, 90, 95 % (допуск риска α = 100 − уровень, в % по `montecarlo`). */
export const CONFIDENCE_LEVELS = Object.freeze([80, 90, 95]);

/** Допуск риска (целые %, 1…99) по уровню уверенности. */
export function alpha_of(confidence) {
  if (!Number.isInteger(confidence) || confidence < 1 || confidence > 99) fail('E_SCHEMA', { reason: 'confidence_out_of_range', value: String(confidence) });
  return 100 - confidence;
}

/**
 * Подпись квантиля малой выборки (C-049): `'max_of_n'` — «наибольшее из n» (`ceil(q·n) = n`), `'min_of_n'` — «наименьшее из n» (`ceil(q·n) = 1` при `q < 50`), иначе `null`.
 * @param {number} q целые %, 1…99
 * @param {number} n объём выборки ≥ 1
 * @returns {'max_of_n'|'min_of_n'|null}
 */
export function quantile_label(q, n) {
  if (!Number.isInteger(q) || q < 1 || q > 99) fail('E_SCHEMA', { reason: 'quantile_out_of_range', value: String(q) });
  if (!Number.isSafeInteger(n) || n < 1) fail('E_SCHEMA', { reason: 'sample_size_not_positive', value: String(n) });
  const rank = ceil_div(q * n, 100);
  if (rank === n) return 'max_of_n';
  if (rank === 1 && q < 50) return 'min_of_n';
  return null;
}

function check_opts(opts) {
  const n_paths = opts.n_paths ?? BAND_DEFAULTS.n_paths;
  if (!Number.isSafeInteger(n_paths) || n_paths < 1 || n_paths > 20000) fail('E_SCHEMA', { reason: 'n_paths_out_of_range', value: String(n_paths) });
  const user_seed = opts.user_seed ?? BAND_DEFAULTS.user_seed;
  if (!Number.isSafeInteger(user_seed)) fail('E_SCHEMA', { reason: 'user_seed_not_integer', value: String(user_seed) });
  const kinds = [...new Set(opts.kinds ?? BAND_DEFAULTS.kinds)];
  return { n_paths, user_seed, kinds };
}

/** Контекст и пути для расчёта; `obs` — наблюдения (по умолчанию из истории `ws`). */
function run_for(ws, analysis, opts, from) {
  const { n_paths, user_seed, kinds } = check_opts(opts);
  const obs = opts.obs ?? mc_observations(ws, analysis.as_of);
  const ctx = mc_context(ws, analysis, obs);
  const seed = make_seed(analysis.engine_version, analysis.inputs_hash, user_seed);
  const paths = run_paths(ctx, n_paths, from === undefined ? { kinds } : { kinds, from }, seed);
  return { paths, obs, kinds, n_paths, user_seed, seed };
}

/** Отказ «нет истории»: у возмущаемых потоков нет ни одного сопоставленного наблюдения (`n_eff` = 0) или возмущать нечего (`n_eff` = null). */
function history_refusal(paths) {
  if (paths.n_eff !== null && paths.n_eff > 0) return null;
  const flows = [...new Set(paths.warnings.filter((w) => w.code === 'W_NO_HISTORY').map((w) => w.flow_key))].sort();
  return { ok: false, reason: 'no_history', flows_without_history: flows, n_eff: paths.n_eff ?? 0 };
}

/**
 * Строки коридора для таблицы: день расчёта, затем каждые `step_days`, затем последний день горизонта.
 * @param {{from: EpochDay, close_q: {p10: Minor, p50: Minor, p90: Minor}[]}} band
 * @param {number} [step_days]
 * @returns {{date: EpochDay, p10: Minor, p50: Minor, p90: Minor}[]}
 */
export function band_rows(band, step_days = BAND_DEFAULTS.step_days) {
  if (!Number.isSafeInteger(step_days) || step_days < 1) fail('E_SCHEMA', { reason: 'step_days_not_positive', value: String(step_days) });
  const n = band.close_q.length;
  const idx = [];
  for (let i = 0; i < n; i += step_days) idx.push(i);
  if (idx[idx.length - 1] !== n - 1 && n > 0) idx.push(n - 1);
  return idx.map((i) => ({ date: band.from + i, p10: band.close_q[i].p10, p50: band.close_q[i].p50, p90: band.close_q[i].p90 }));
}

/**
 * Коридор P10/P50/P90 остатка на счетах по дням (`close_q` из `run_paths`) по истории пользователя. Без истории — отказ.
 * Результат — расчёт по введённым данным и прошлым задержкам, эксперимент: он не меняет вердикты и числа Q1/Q3.
 * @param {object} ws рабочая область
 * @param {object} analysis результат `analyze` на этой же рабочей области (нужны `events.plan`, `series.plan`, `inputs_hash`, `engine_version`)
 * @param {{n_paths?: number, kinds?: string[], user_seed?: number, obs?: object}} [opts] по умолчанию 1000 путей, возмущения `lag`/`ratio`/`fx`, `user_seed` 0
 * @returns {{ok: false, reason: 'no_history', flows_without_history: string[], n_eff: number}|{ok: true, from: EpochDay, close_q: object[], trough_q: object[],
 *   n_paths: number, n_eff: number, enumerated: boolean, prior_used: boolean, coarse: boolean, seed: number, kinds: string[],
 *   p_gap_any: {k: number, n: number}, gap_presentation: object, warnings: object[], flows: {key: string, n: number}[], rows: object[]}}
 * @throws {RunwayError} E_SCHEMA (неверные параметры, нет плана в `analysis`)
 */
export function mc_band(ws, analysis, opts = {}) {
  const r = run_for(ws, analysis, opts);
  const refusal = history_refusal(r.paths);
  if (refusal !== null) return refusal;
  const p = r.paths;
  const band = {
    ok: true,
    from: to_epoch_day(analysis.as_of),
    close_q: p.close_q,
    trough_q: p.trough_q,
    n_paths: p.n_paths,
    n_eff: p.n_eff,
    enumerated: p.enumerated,
    prior_used: p.prior_used,
    coarse: p.coarse,
    seed: p.seed,
    kinds: r.kinds,
    p_gap_any: p.p_gap_any,
    gap_presentation: present_probability(p.p_gap_any.k, p),
    warnings: p.warnings,
    flows: r.obs.flows ?? [],
  };
  return { ...band, rows: band_rows(band, opts.step_days ?? BAND_DEFAULTS.step_days) };
}

/**
 * «При уверенности α максимум X» для покупки на дату `D` (ALG-10): `s_max_alpha` по минимумам свободных денег после `D`, доля путей, где `S` нарушает
 * буфер (`p_fail`), и подача по правилу малых выборок. Не заменяет вердикт Q3: тот считается детерминированно и здесь не участвует.
 * Отказы: нет буфера (`no_buffer`), дата раньше расчёта (`date_before_as_of`) или за горизонтом (`beyond_horizon`), нет истории (`no_history`).
 * @param {object} ws
 * @param {object} analysis
 * @param {{S: Minor, date: EpochDay|string, confidences?: number[], n_paths?: number, kinds?: string[], user_seed?: number, obs?: object}} opts
 * @returns {object} `{ok: false, reason, …}` или `{ok: true, S, B, date, n_eff, n_paths, enumerated, seed, coarse, presentation, held, levels}`;
 *   `presentation` — `{kind: 'none', reason}` | `{kind: 'count', k, n}` | `{kind: 'interval', p_pm, lo_pm, hi_pm, n}`; `held = {k, n}` — путей, где буфер сохраняется;
 *   `levels[i] = {confidence, alpha, q_min, s_max, ok, label}`
 * @throws {RunwayError} E_SCHEMA (`S` не целое > 0, уровень уверенности вне 1…99)
 */
export function mc_buy(ws, analysis, opts) {
  const S = assert_minor(opts.S);
  if (S <= 0) fail('E_SCHEMA', { reason: 'purchase_amount_not_positive', value: String(S) });
  const B = analysis.buffer_minor;
  if (B === null || B === undefined) return { ok: false, reason: 'no_buffer' };
  const D = to_epoch_day(opts.date);
  const as_of = to_epoch_day(analysis.as_of);
  if (D < as_of) return { ok: false, reason: 'date_before_as_of' };
  if (D > to_epoch_day(analysis.horizon_end)) return { ok: false, reason: 'beyond_horizon' };
  const confidences = opts.confidences ?? CONFIDENCE_LEVELS;
  const r = run_for(ws, analysis, opts, D);
  const refusal = history_refusal(r.paths);
  if (refusal !== null) return refusal;
  const p = r.paths;
  const m = p.m_free;
  if (m === null) return { ok: false, reason: 'beyond_horizon' };
  const f = p_fail(m, S, B);
  const levels = confidences.map((c) => {
    const alpha = alpha_of(c);
    return { confidence: c, alpha, q_min: q_alpha(m, alpha), s_max: s_max_alpha(m, B, alpha), ok: ok_at_alpha(m, S, B, alpha), label: quantile_label(alpha, m.length) };
  });
  return {
    ok: true,
    S, B, date: D,
    n_eff: p.n_eff,
    n_paths: p.n_paths,
    enumerated: p.enumerated,
    coarse: p.coarse,
    seed: p.seed,
    kinds: r.kinds,
    prior_used: p.prior_used,
    presentation: present_probability(f.k, p),
    held: { k: f.n - f.k, n: f.n },
    levels,
  };
}

/**
 * Адаптер коридора для `backtest(journal, t0, h, {band})`: функция `(analysis, t, h) → {lo, hi}` с коридором P10–P90 остатка на день `t + h`
 * вместо `[min(plan, worse), max(plan, worse)]`. История берётся из среза журнала «как знали тогда»: срез строит `replay_state` — его передаёт вызывающий
 * (`backtest.replay_state`), чтобы слои не замыкались в цикл. Если истории нет, коридор — прежний `plan`–`worse` (честный запасной вариант, а не выдуманные числа).
 * @param {object[]} journal записи журнала (тот же, что в `backtest`)
 * @param {{replay_state: (journal: object[], t: EpochDay) => object, n_paths?: number, kinds?: string[], user_seed?: number}} opts `replay_state` обязателен
 * @returns {(analysis: object, t: EpochDay, h: number) => {lo: Minor, hi: Minor}}
 * @throws {RunwayError} E_SCHEMA (нет `replay_state`, неверные параметры)
 */
export function mc_band_adapter(journal, opts) {
  if (typeof opts?.replay_state !== 'function') fail('E_SCHEMA', { reason: 'band_adapter_needs_replay_state' });
  check_opts(opts);
  const replay_state = opts.replay_state;
  return (analysis, t, h) => {
    const s = replay_state(journal, t);
    const F = analysis.series.plan.close[h];
    const W = analysis.series.worse.close[h];
    const fallback = { lo: Math.min(F, W), hi: Math.max(F, W) };
    const b = mc_band(s, analysis, opts);
    if (b.ok !== true || h >= b.close_q.length) return fallback;
    return { lo: b.close_q[h].p10, hi: b.close_q[h].p90 };
  };
}
