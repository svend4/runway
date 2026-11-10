// montecarlo.mjs — неопределённость: seeded Монте-Карло с общими случайными числами (ALG-10, ADR-008, D-15, D-16).
// Канон: design-brief §2 D-15/D-16, §4 (float допустим только в статистике), §9.15, §14 B4; C-048…C-050, C-056, C-057, C-061;
// canon-decisions «Финальные сигнатуры» (montecarlo.mjs); wiki/algorithms/alg-10-uncertainty-monte-carlo.md (подробная спецификация).
// Зависимости (правило слоёв §14 B4): `timeline`, `sinking`, `afford`, `calibration` (и нижележащие `money`, `dates`, `tax`).
// От `index`, `ledger`, `sha256` модуль НЕ зависит (C-050): seed — свёртка `mix32`, а `inputs_hash` уже хэш. Модуль чистый:
// ни часов, ни `Math.random`, ни ввода-вывода; случайность — функция `u01(seed, ключ, путь)` без состояния (счётчиковый хэш),
// поэтому правка одного события не меняет `u` других и два сценария сравниваются на общих путях (CRN).
// Float — только в `u01` (точное деление на 2^32), `tri_bp` (sqrt) и `wilson` (из calibration); результат — целые bp/‰/деньги.
// Это v2 в продукте (v1 вероятностей не показывает), в прототипе реализовано заранее. Расчёт по введённым данным и истории
// пользователя, не прогноз и не совет; малая выборка подаётся только как «k из n».

import { fail, assert_minor, round_div, mul_div, ceil_div } from './money.mjs';
import { to_epoch_day, make_calendar } from './dates.mjs';
import { normalize_ws, get_param, project, opening_state } from './timeline.mjs';
import { reserve_open, contribution_allocations, reserve_series, free_series } from './sinking.mjs';
import { allocations_for_events } from './tax.mjs';
import { nearest_rank, flow_key, wilson } from './calibration.mjs';

export { nearest_rank } from './calibration.mjs';

/** @typedef {import('./money.mjs').Minor} Minor */
/** @typedef {import('./dates.mjs').EpochDay} EpochDay */
/** @typedef {import('./timeline.mjs').CashEvent} CashEvent */
/**
 * Результат `run_paths` (ALG-10, «Выход Paths»).
 * @typedef {object} Paths
 * @property {number} n_paths число путей (при `enumerated` — число наблюдений)
 * @property {number} seed
 * @property {boolean} enumerated полный перебор наблюдений вместо выборки (ошибки выборки нет)
 * @property {number|null} n_eff минимум `n_obs` по источникам `lag`/`ratio`/`fx`, зависящим от данных (`hours` не входит, C-048)
 * @property {boolean} prior_used хотя бы один доход считался по prior (нет наблюдений)
 * @property {{p10: Minor, p50: Minor, p90: Minor}[]} close_q по дням сетки
 * @property {{p10: Minor, p50: Minor, p90: Minor}[]} trough_q по дням сетки
 * @property {Minor[]|null} m_free `m_p = min free_p[j0..N−1]` по путям; `null`, если дата `from` за горизонтом
 * @property {Minor[]} m_trough минимум `trough` по пути (для `p_gap_any`)
 * @property {{k: number, n: number}} p_gap_any путей с физическим разрывом `min trough < 0`
 * @property {number} p_gap_any_pm `round_div(1000·k, n)`
 * @property {{code: string, flow_key?: string}[]} warnings `W_NO_HISTORY`, `W_LAG_BEYOND_HISTORY` (реестр vocab.json)
 * @property {boolean} coarse `n_paths < 100` для выборки: квантили грубые
 */

const TWO32 = 4294967296;

// ── генератор без состояния (только imul, сдвиги, + − × ÷, sqrt) ───────────────────────────────────────────────────────

/**
 * Финализатор murmur3 над `uint32`: `mix32(0) = 0`, `mix32(1) = 0x514E28B7`, `mix32(0xFFFFFFFF) = 0x81F16F39`.
 * @param {number} h целое (берётся по модулю 2^32)
 * @returns {number} uint32
 */
export function mix32(h) {
  let x = h >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85EBCA6B);
  x ^= x >>> 13;
  x = Math.imul(x, 0xC2B2AE35);
  x ^= x >>> 16;
  return x >>> 0;
}

/**
 * Свёртка `mix32(((acc XOR x) + 0x9E3779B9) mod 2^32)`; порядок аргументов важен.
 * @param {number} acc uint32
 * @param {number} x uint32
 * @returns {number} uint32
 */
export function fold32(acc, x) {
  return mix32((((acc ^ x) >>> 0) + 0x9E3779B9) >>> 0);
}

/** Байты UTF-8 строки (без TextEncoder: движок не опирается на глобальные API среды). */
function utf8_bytes(s) {
  const out = [];
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

/**
 * Хэш строки: FNV-1a по байтам UTF-8 и финализатор `mix32`.
 * @param {string} s
 * @returns {number} uint32
 */
export function hash_str(s) {
  let h = 0x811C9DC5;
  for (const b of utf8_bytes(s)) h = Math.imul(h ^ b, 0x01000193);
  return mix32(h);
}

/**
 * `seed = H(engine_version, inputs_hash, user_seed)` — свёртка `mix32` по строке версии, 8 словам по 8 hex-знаков `inputs_hash`
 * (префикс `sha256:` допустим и отбрасывается) и `user_seed mod 2^32` (C-050: без `sha256` и `ledger`).
 * @param {string} engine_version
 * @param {string} inputs_hash 64 hex-знака нижнего регистра
 * @param {number} [user_seed] по умолчанию 0; берётся по модулю 2^32
 * @returns {number} uint32
 * @throws {RunwayError} E_SCHEMA (`inputs_hash` не 64 hex-знака, `user_seed` не целое)
 */
export function make_seed(engine_version, inputs_hash, user_seed = 0) {
  if (typeof engine_version !== 'string') fail('E_SCHEMA', { reason: 'seed_engine_version_not_string' });
  const hex = typeof inputs_hash === 'string' && inputs_hash.startsWith('sha256:') ? inputs_hash.slice(7) : inputs_hash;
  if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/.test(hex)) fail('E_SCHEMA', { reason: 'seed_inputs_hash_not_64_hex' });
  if (!Number.isSafeInteger(user_seed)) fail('E_SCHEMA', { reason: 'seed_user_seed_not_integer', value: String(user_seed) });
  let acc = hash_str(engine_version);
  for (let i = 0; i < 8; i++) acc = fold32(acc, parseInt(hex.slice(8 * i, 8 * i + 8), 16));
  const us = ((user_seed % TWO32) + TWO32) % TWO32;
  return fold32(acc, us);
}

/**
 * Равномерное `u ∈ [0, 1)` — функция трёх аргументов без состояния; деление на 2^32 точное.
 * @param {number} seed uint32
 * @param {string} key ключ источника (например, `<cash_event_id>|lag`)
 * @param {number} path номер пути, uint32
 * @returns {number}
 */
export function u01(seed, key, path) {
  return fold32(fold32(seed >>> 0, hash_str(key)), path >>> 0) / TWO32;
}

// ── распределения ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Бутстрап: `obs[min(n − 1, floor(u·n))]`; `obs` отсортирован по возрастанию, `n ≥ 1`.
 * @param {number[]} obs
 * @param {number} u 0 ≤ u < 1
 * @returns {number}
 */
export function sample_lag(obs, u) {
  const n = obs.length;
  if (n < 1) fail('E_SCHEMA', { reason: 'sample_lag_empty' });
  return obs[Math.min(n - 1, Math.floor(u * n))];
}

/**
 * Треугольное распределение на `[0, 1]` с модой `c_bp/10000`, результат — целые bp `0…10000` (float: `sqrt`, ALG-10).
 * @param {number} u 0 ≤ u < 1
 * @param {number} c_bp мода, 0…10000
 * @returns {number}
 */
export function tri_bp(u, c_bp) {
  const c = c_bp / 10000;
  const t = u < c ? Math.sqrt(u * c) : 1 - Math.sqrt((1 - u) * (1 - c));
  return Math.min(10000, Math.floor(t * 10000 + 0.5));
}

// ── наблюдения и пулы лагов ───────────────────────────────────────────────────────────────────────────────────────────

/** События ctx: массив (`events.plan` из `analyze` разворачивается). */
function events_of(ctx) {
  const ev = ctx?.events;
  if (Array.isArray(ev)) return ev;
  if (ev !== null && typeof ev === 'object' && Array.isArray(ev.plan)) return ev.plan;
  return fail('E_SCHEMA', { reason: 'ctx_events_missing' });
}

/** Список наблюдений ключа: массив чисел либо объект `{lags|ratios_bp}` (выход `lag_observations`). */
function obs_of(table, key, field) {
  const v = table === undefined || table === null ? undefined : table[key];
  if (v === undefined || v === null) return [];
  const list = Array.isArray(v) ? v : v[field];
  if (!Array.isArray(list)) return [];
  return list.map(assert_minor);
}

const sort_num = (xs) => [...xs].sort((a, b) => a - b);

/** Доход, который возмущается: `planned`, доход, статус `expected`/`overdue`. */
function is_inc(e) {
  return e.kind === 'income' && e.layer === 'planned' && (e.status === 'expected' || e.status === 'overdue') && e.amount_minor > 0;
}

/**
 * Пул лагов события дохода (условный лаг, IDEA-03): наблюдения потока `≥ age`, где `age` — число дней, которое платёж уже ждём.
 * Нет наблюдений — prior `[0 … worse.income_delay_days]` (`W_NO_HISTORY`); нет наблюдений `≥ age` — `[∞]` (`W_LAG_BEYOND_HISTORY`:
 * доход из горизонта выпадает, лучшего исхода, чем виденный, не придумываем).
 * @param {{as_of: EpochDay, lag_obs?: object, params?: object}} ctx
 * @param {CashEvent} e доход `expected`/`overdue`
 * @returns {{obs: number[], n_obs: number, prior: boolean, warnings: {code: string, flow_key: string}[]}}
 */
export function lag_pool(ctx, e) {
  const key = flow_key(e);
  const age = Math.max(0, to_epoch_day(ctx.as_of) - to_epoch_day(e.plan_date ?? e.date));
  let raw = sort_num(obs_of(ctx.lag_obs, key, 'lags'));
  const n_obs = raw.length;
  const warnings = [];
  let prior = false;
  if (n_obs === 0) {
    const delay = get_param(ctx.params, 'worse.income_delay_days');
    // К-4 (Q-12): без диапазона delay задавал длину массива (10^9 → память); границы 0…365
    if (!Number.isSafeInteger(delay) || delay < 0 || delay > 365) fail('E_SCHEMA', { reason: 'income_delay_days_out_of_range', value: String(delay) });
    raw = Array.from({ length: delay + 1 }, (_, i) => i);
    prior = true;
    warnings.push({ code: 'W_NO_HISTORY', flow_key: key });
  }
  let cond = raw.filter((x) => x >= age);
  if (cond.length === 0) {
    warnings.push({ code: 'W_LAG_BEYOND_HISTORY', flow_key: key });
    cond = [Infinity];
  }
  return { obs: cond, n_obs, prior, warnings };
}

/** Подготовка: пулы лагов доходов, отсортированные выборки отношений и курсов (один раз на запуск). */
function prepare(ctx, kinds) {
  const evs = events_of(ctx);
  const pools = new Map();
  if (kinds.includes('lag')) for (const e of evs) if (is_inc(e)) pools.set(e.cash_event_id, lag_pool(ctx, e));
  const ratio = new Map();
  if (kinds.includes('ratio')) {
    for (const e of evs) {
      if (e.is_estimate === true && e.amount_minor < 0) {
        const key = flow_key(e);
        if (!ratio.has(key)) ratio.set(key, sort_num(obs_of(ctx.ratio_obs_bp, key, 'ratios_bp')));
      }
    }
  }
  const fx = new Map();
  if (kinds.includes('fx') && ctx.fx_obs_bp !== undefined && ctx.fx_obs_bp !== null) {
    for (const cur of Object.keys(ctx.fx_obs_bp)) fx.set(cur, sort_num(obs_of(ctx.fx_obs_bp, cur, 'bp')));
  }
  return { evs, pools, ratio, fx };
}

const cmp_event = (x, y) => (x.date - y.date)
  || (x.amount_minor < y.amount_minor ? -1 : x.amount_minor > y.amount_minor ? 1 : 0)
  || (String(x.cash_event_id) < String(y.cash_event_id) ? -1 : String(x.cash_event_id) > String(y.cash_event_id) ? 1 : 0);

function perturb_core(ctx, kinds, seed, p, enum_lag, prep) {
  const dec = ctx.decision_currency ?? ctx.params?.decision_currency;
  const horizon_end = to_epoch_day(ctx.horizon_end);
  const out = [];
  for (const e of prep.evs) {
    const e2 = { ...e };
    const inc = is_inc(e);
    if (inc && kinds.includes('hours') && e.amount_min_minor !== undefined && e.amount_max_minor !== undefined && e.amount_min_minor < e.amount_max_minor) {
      const lo = e.amount_min_minor;
      const hi = e.amount_max_minor;
      if (lo <= e.amount_minor && e.amount_minor <= hi) { // мода вне носителя — событие не возмущается
        const c = round_div(10000 * (e.amount_minor - lo), hi - lo, 'half_even');
        e2.amount_minor = lo + mul_div(hi - lo, tri_bp(u01(seed, e.cash_event_id + '|hours', p), c), 10000);
      }
    }
    if (e.is_estimate === true && e.amount_minor < 0 && kinds.includes('ratio')) {
      const obs = prep.ratio.get(flow_key(e));
      if (obs !== undefined && obs.length > 0) {
        const r = sample_lag(obs, u01(seed, e.cash_event_id + '|ratio', p)); // r — факт/план в bp
        // отношение |ΣF|/|P| неотрицательно: отрицательное наблюдение (ошибка данных) зажимается в 0, а не переворачивает расход в доход (как у fx)
        e2.amount_minor = mul_div(e.amount_minor, Math.max(0, r), 10000);
      }
    }
    if (inc && kinds.includes('lag')) {
      const pool = prep.pools.get(e.cash_event_id) ?? lag_pool(ctx, e);
      const lag = enum_lag ?? sample_lag(pool.obs, u01(seed, e.cash_event_id + '|lag', p));
      const d = to_epoch_day(e.plan_date ?? e.date) + lag;
      if (d > horizon_end) continue; // вне горизонта (в том числе lag = ∞)
      e2.date = d;
    }
    if (kinds.includes('fx') && typeof e.orig_currency === 'string' && e.orig_currency !== dec) {
      const obs = prep.fx.get(e.orig_currency);
      if (obs !== undefined && obs.length > 0) {
        const delta = sample_lag(obs, u01(seed, 'fx:' + e.orig_currency, p)); // один сдвиг на путь и валюту
        e2.amount_minor = mul_div(e2.amount_minor, Math.max(0, 10000 + delta), 10000);
      }
    }
    out.push(e2);
  }
  out.sort(cmp_event);
  return out;
}

/**
 * Возмущённая копия событий пути `p`: `lag` — лаг выплаты дохода (бутстрап наблюдений потока, условный), `hours` — сумма дохода
 * (треугольное по `amount_min/exp/max`), `ratio` — отношение факт/план оценочной траты (бутстрап), `fx` — относительный сдвиг курса
 * (бутстрап приращений, один на путь и валюту). Расходы-обязательства даты и суммы не меняют. Порядок результата — `(date, amount_minor, id)`.
 * @param {{events: CashEvent[]|{plan: CashEvent[]}, as_of: EpochDay, horizon_end: EpochDay, lag_obs?: object, ratio_obs_bp?: object, fx_obs_bp?: object, params?: object, decision_currency?: string}} ctx
 * @param {('lag'|'hours'|'ratio'|'fx')[]} kinds
 * @param {number} seed
 * @param {number} p номер пути
 * @param {number|null} [enum_lag] лаг, заданный перебором (вместо выборки)
 * @returns {CashEvent[]}
 */
export function perturb_events(ctx, kinds, seed, p, enum_lag = null) {
  return perturb_core(ctx, kinds, seed, p, enum_lag, prepare(ctx, kinds));
}

/**
 * Полный перебор наблюдений вместо выборки (`kinds = ['lag']`, один доход в горизонте, есть история, `≤ 64` наблюдений):
 * число путей = числу наблюдений, ошибки выборки нет.
 * @param {object} ctx
 * @param {string[]} kinds
 * @param {number} n_paths
 * @returns {{n: number, enum_lags: number[]|null}}
 */
export function plan_paths(ctx, kinds, n_paths) {
  const inc = events_of(ctx).filter(is_inc);
  const only_lag = kinds.length > 0 && kinds.every((k) => k === 'lag');
  const L = inc.length === 1 ? lag_pool(ctx, inc[0]) : null;
  if (only_lag && L !== null && !L.prior && L.obs.length <= 64 && L.obs[0] !== Infinity) return { n: L.obs.length, enum_lags: L.obs };
  return { n: n_paths, enum_lags: null }; // иначе — выборка из n_paths путей
}

/** Порт оценки: события → `{close, trough, free}` длины N. */
function check_series(s, N) {
  for (const f of ['close', 'trough', 'free']) {
    if (!Array.isArray(s?.[f]) || s[f].length !== N) fail('E_SCHEMA', { reason: 'evaluate_series_length', field: f, N });
  }
  return s;
}

/**
 * Порт `ctx.evaluate(events)` по рабочей области `ws` и расчёту `analysis` (`analyze`): `project` → налоговые аллокации на лету →
 * `reserve_series` (записанные и плановые взносы резервов) → `free_series`. Версия налогового правила выбирается по `max(plan_date, as_of)`,
 * не по возмущённой дате (C-016), поэтому аллокации не зависят от лага.
 * @param {object} ws рабочая область (форма — как у `analyze`)
 * @param {{as_of: EpochDay, horizon_end: EpochDay, series?: {plan?: {opening_minor: Minor}}}} analysis результат `analyze`
 * @returns {(events: CashEvent[]) => {close: Minor[], trough: Minor[], free: Minor[]}}
 */
export function make_evaluate(ws, analysis) {
  const w = normalize_ws(ws);
  const as_of = to_epoch_day(analysis.as_of);
  const hz = to_epoch_day(analysis.horizon_end);
  const opening = analysis.series?.plan?.opening_minor ?? opening_state(ws, as_of).opening_minor;
  const recorded = w.allocations;
  const recorded_ids = new Set(recorded.map((a) => a.allocation_id));
  const reserves = w.reserves.map((r) => ({ ...r, funded_open_minor: reserve_open(r, recorded, as_of) }));
  const cal_of = (r) => {
    const id = r.calendar_id ?? r.cadence?.calendar_id ?? null;
    const spec = id === null ? w.calendars[0] : w.calendars.find((c) => c.calendar_id === id);
    if (id !== null && spec === undefined) fail('E_SCHEMA', { reason: 'unknown_calendar', calendar_id: String(id) });
    return make_calendar(spec === undefined ? {} : spec);
  };
  const scheduled = reserves.filter((r) => r.kind === 'sinking')
    .flatMap((r) => contribution_allocations(r, r.funded_open_minor, as_of, hz, cal_of(r), recorded_ids));
  return (events) => {
    const s = project(events, opening, as_of, hz);
    const taxes = w.tax_rules.length === 0 ? [] : allocations_for_events(events, w.tax_rules, as_of).filter((a) => !recorded_ids.has(a.allocation_id));
    const rs = reserve_series(reserves, events, [...taxes, ...scheduled], as_of, hz);
    return { close: s.close, trough: s.trough, free: free_series(s.trough, rs.reserve_trough) };
  };
}

/**
 * Контекст для `run_paths`: `Analysis` + события `plan`, порт `evaluate` и наблюдения (`lag_obs` — выход `lag_observations` или
 * `{flow_key → int[]}`; `ratio_obs_bp`, `fx_obs_bp` — аналогично).
 * @param {object} ws
 * @param {object} analysis результат `analyze`
 * @param {{lag_obs?: object, ratio_obs_bp?: object, fx_obs_bp?: object}} [obs]
 * @returns {object}
 */
export function mc_context(ws, analysis, obs = {}) {
  return {
    ...analysis,
    events: analysis.events.plan,
    evaluate: make_evaluate(ws, analysis),
    lag_obs: obs.lag_obs ?? {},
    ratio_obs_bp: obs.ratio_obs_bp ?? {},
    fx_obs_bp: obs.fx_obs_bp ?? {},
  };
}

/** Квантиль по уже отсортированному `Float64Array` (индекс nearest-rank, как у `calibration.nearest_rank`). */
function rank_of(sorted, q) {
  return sorted[Math.max(0, ceil_div(q * sorted.length, 100) - 1)];
}

/**
 * Пути: для каждого пути возмущённые события → `ctx.evaluate` → `close`, `trough`, `free`; квантили P10/P50/P90 по каждому дню
 * (nearest-rank), `m_free[p]` — минимум `free` после даты покупки `perturbations.from` (по умолчанию `as_of`), `p_gap_any` — доля путей
 * с физическим разрывом `min trough < 0` (не максимум дневных вероятностей). Одинаковые `(ctx, seed, kinds, n_paths)` дают равные `Paths`;
 * порядок `ctx.events` не влияет; при полном переборе результат не зависит от `seed`.
 * @param {object} ctx `Analysis` + `events`, `evaluate`, `lag_obs`, `ratio_obs_bp`, `fx_obs_bp` (см. `mc_context`)
 * @param {number} n_paths по умолчанию в продукте 2000
 * @param {{kinds: ('lag'|'hours'|'ratio'|'fx')[], from?: EpochDay|string, enumerate?: boolean}} perturbations
 *   `enumerate: false` принудительно включает выборку вместо перебора (для проверки ошибки выборки)
 * @param {number} seed `make_seed(...)`
 * @returns {Paths}
 * @throws {RunwayError} E_SCHEMA (нет `evaluate`, неверные `kinds`/`n_paths`, ряды неверной длины)
 */
export function run_paths(ctx, n_paths, perturbations, seed) {
  if (typeof ctx?.evaluate !== 'function') fail('E_SCHEMA', { reason: 'ctx_evaluate_missing' });
  if (!Number.isSafeInteger(n_paths) || n_paths < 1) fail('E_SCHEMA', { reason: 'n_paths_not_positive', value: String(n_paths) });
  const kinds = [...new Set(perturbations?.kinds ?? [])];
  for (const k of kinds) if (!['lag', 'hours', 'ratio', 'fx'].includes(k)) fail('E_SCHEMA', { reason: 'unknown_kind', kind: String(k) });
  const as_of = to_epoch_day(ctx.as_of);
  const horizon_end = to_epoch_day(ctx.horizon_end);
  const N = horizon_end - as_of + 1;
  const from = perturbations.from === undefined || perturbations.from === null ? as_of : to_epoch_day(perturbations.from);
  const j0 = Math.max(0, from - as_of);
  const prep = prepare(ctx, kinds);
  const plan = perturbations.enumerate === false ? { n: n_paths, enum_lags: null } : plan_paths(ctx, kinds, n_paths);
  const n = plan.n;
  const CL = Array.from({ length: N }, () => new Float64Array(n));
  const TR = Array.from({ length: N }, () => new Float64Array(n));
  const m_free = new Array(n);
  const m_trough = new Array(n);
  const has_free_window = j0 <= N - 1;
  for (let p = 0; p < n; p++) {
    const s = check_series(ctx.evaluate(perturb_core(ctx, kinds, seed, p, plan.enum_lags === null ? null : plan.enum_lags[p], prep)), N);
    let mt = s.trough[0];
    for (let i = 0; i < N; i++) {
      CL[i][p] = s.close[i];
      TR[i][p] = s.trough[i];
      if (s.trough[i] < mt) mt = s.trough[i];
    }
    m_trough[p] = mt;
    if (has_free_window) {
      let mf = s.free[j0];
      for (let i = j0 + 1; i < N; i++) if (s.free[i] < mf) mf = s.free[i];
      m_free[p] = mf;
    }
  }
  const quant = (col) => { col.sort(); return { p10: rank_of(col, 10), p50: rank_of(col, 50), p90: rank_of(col, 90) }; };
  const close_q = CL.map(quant);
  const trough_q = TR.map(quant);
  const k = m_trough.filter((x) => x < 0).length;
  // n_eff и prior_used: источники, зависящие от данных (hours данных не использует, C-048)
  const n_obs = [];
  const warnings = new Map();
  let prior_used = false;
  for (const pool of prep.pools.values()) {
    n_obs.push(pool.n_obs);
    if (pool.prior) prior_used = true;
    for (const w of pool.warnings) warnings.set(w.code + '|' + w.flow_key, w);
  }
  for (const [, obs] of prep.ratio) if (obs.length > 0) n_obs.push(obs.length);
  if (kinds.includes('fx')) {
    const dec = ctx.decision_currency ?? ctx.params?.decision_currency;
    const used = new Set(prep.evs.filter((e) => typeof e.orig_currency === 'string' && e.orig_currency !== dec).map((e) => e.orig_currency));
    for (const cur of used) { const obs = prep.fx.get(cur); if (obs !== undefined && obs.length > 0) n_obs.push(obs.length); }
  }
  const wl = [...warnings.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((x) => x[1]);
  return {
    n_paths: n,
    seed: seed >>> 0,
    enumerated: plan.enum_lags !== null,
    n_eff: n_obs.length === 0 ? null : Math.min(...n_obs),
    prior_used,
    close_q,
    trough_q,
    m_free: has_free_window ? m_free : null,
    m_trough,
    p_gap_any: { k, n },
    p_gap_any_pm: round_div(1000 * k, n),
    warnings: wl,
    coarse: plan.enum_lags === null && n < 100,
  };
}

// ── вероятностный Q3 и подача ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Доля путей, где покупка `S` нарушает буфер: `#{p : m_p − S < B}` из `n`.
 * @param {Minor[]} m_paths `m_free` из `run_paths`
 * @param {Minor} S сумма покупки
 * @param {Minor} B буфер
 * @returns {{k: number, n: number}}
 */
export function p_fail(m_paths, S, B) {
  const s = assert_minor(S);
  const b = assert_minor(B);
  let k = 0;
  for (const m of m_paths) if (m - s < b) k++;
  return { k, n: m_paths.length };
}

function check_alpha(alpha) {
  if (!Number.isInteger(alpha) || alpha < 1 || alpha > 99) fail('E_SCHEMA', { reason: 'alpha_out_of_range', value: String(alpha) });
  return alpha;
}

/**
 * Квантиль минимумов `free` уровня `alpha` (целые %, 1…99, nearest-rank): «квантиль минимумов», не минимум квантилей.
 * @param {Minor[]} m_paths
 * @param {number} alpha
 * @returns {Minor}
 */
export function q_alpha(m_paths, alpha) {
  return nearest_rank(sort_num(m_paths), check_alpha(alpha));
}

/**
 * Допуск риска: `OK(α) ⇔ q_α(m) − S ≥ B` (эквивалентно `100·p_fail.k < α·n`).
 * @param {Minor[]} m_paths
 * @param {Minor} S
 * @param {Minor} B
 * @param {number} alpha
 * @returns {boolean}
 */
export function ok_at_alpha(m_paths, S, B, alpha) {
  return q_alpha(m_paths, alpha) - assert_minor(S) >= assert_minor(B);
}

/**
 * Максимальная сумма при допуске `alpha`: `max(0, q_α(m) − B)`.
 * @param {Minor[]} m_paths
 * @param {Minor} B
 * @param {number} alpha
 * @returns {Minor}
 */
export function s_max_alpha(m_paths, B, alpha) {
  return Math.max(0, assert_minor(q_alpha(m_paths, alpha) - assert_minor(B)));
}

/**
 * Подача вероятности (D-15, REQ-055): процент и интервал Уилсона — только при `n_eff ≥ 20`; при меньшей выборке перебор подаётся
 * счётом «k из n», выборка — не подаётся (`small_sample`); без наблюдений (prior, диапазон часов) — `no_history`.
 * Для выборки `k` (из `n_paths` путей) пересчитывается на `n_eff`: `round_div(k·n_eff, n_paths)`.
 * @param {number} k число путей-провалов (из `paths.n_paths`)
 * @param {{enumerated: boolean, n_paths: number, n_eff: number|null}} paths
 * @returns {{kind: 'none', reason: 'no_history'|'small_sample', n?: number}|{kind: 'count', k: number, n: number}|{kind: 'interval', p_pm: number, lo_pm: number, hi_pm: number, n: number}}
 */
export function present_probability(k, paths) {
  let k_e;
  let n_e;
  if (paths.enumerated) {
    k_e = k;
    n_e = paths.n_paths;
  } else {
    n_e = paths.n_eff ?? 0;
    k_e = round_div(k * n_e, paths.n_paths);
  }
  if (n_e === 0) return { kind: 'none', reason: 'no_history' };
  if (n_e < 20) return paths.enumerated ? { kind: 'count', k: k_e, n: n_e } : { kind: 'none', reason: 'small_sample', n: n_e };
  const w = wilson(k_e, n_e, 196);
  return { kind: 'interval', p_pm: round_div(1000 * k_e, n_e), lo_pm: w.lo_pm, hi_pm: w.hi_pm, n: n_e };
}
