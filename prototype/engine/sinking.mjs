// sinking.mjs — sinking funds (ALG-05) и общий ряд резервов `reserve_series` / `free_series` (ALG-11, D-07, D-08, ADR-016).
// Канон: design-brief D-07, D-08, D-18, §3.7, §9.12, §12 X3/X4, C-020, C-030, C-031, C-059, C-098; canon-decisions «Финальные сигнатуры» (sinking.mjs);
// wiki/algorithms/alg-05-sinking-funds.md, alg-11-safe-to-spend.md.
// Зависимости: money, dates. Чистые функции: резерв — виртуальная отметка денег, `CashEvent` не создаёт, `close`/`trough` не меняет.
// Плановые взносы в журнал не пишутся (C-030): `funded_open` растёт только от записанных аллокаций (`reserve_open`).
// Проверка валюты резерва и событий (= валюте решения, X4) выполняется при `reserve.set` и в `build_events`, а не здесь (C-098).

import { fail, assert_minor, ceil_div, floor_div, floor_mod, split_largest_remainder, sum_minor } from './money.mjs';
import { civil_from_days, days_from_civil, clamp_day, format_date, shift_by_policy, to_epoch_day, make_calendar } from './dates.mjs';

/** @typedef {import('./money.mjs').Minor} Minor */
/** @typedef {import('./dates.mjs').EpochDay} EpochDay */
/** @typedef {import('./dates.mjs').Calendar} Calendar */
/**
 * Резерв `Reserve` (§3.7). Для движка — `funded_open_minor` (проекция `reserve_open`).
 * @typedef {object} Reserve
 * @property {string} reserve_id
 * @property {'tax'|'sinking'} kind
 * @property {Minor} [funded_start_minor] хранимое состояние на `funded_as_of`
 * @property {string|EpochDay} [funded_as_of]
 * @property {Minor} [funded_open_minor] состояние на начало `as_of` после `reserve_open` (вход `reserve_series`)
 * @property {Minor|null} [target_minor]
 * @property {string|EpochDay|null} [due_date] обязателен при `mode = refill_to_target`
 * @property {{freq: 'M', day: number, weekend?: 'keep'|'prev'|'next'|'skip'}} [cadence] по умолчанию `{freq: 'M', day: 1}`
 * @property {'refill_to_target'|'fixed'} [mode] обязателен при `kind = sinking`
 * @property {Minor} [fixed_minor]
 * @property {string|null} [backed_by_account_id] v1: `null`; привязанные к счёту резервы в ряд не входят
 */
/**
 * Аллокация (§3.7).
 * @typedef {object} Allocation
 * @property {string} allocation_id `sch:<reserve_id>@<дата>` / `tax:<rule_id>@<event_id>`
 * @property {string} reserve_id
 * @property {EpochDay|string} date
 * @property {Minor} amount_minor ±
 * @property {'income'|'schedule'|'manual'|'release'} source
 */

const SOURCES = ['income', 'schedule', 'manual', 'release'];
/** Верхняя граница числа итераций `contribution_dates` (1000 лет помесячно): защита от неограниченного срока. */
const MAX_MONTHS = 12000;

// ── расписание взносов (ALG-05) ────────────────────────────────────────────────

/**
 * Даты взносов на полуинтервале `start ≤ d < due`: `cadence.day`-е число каждого месяца (от исходного дня, без дрейфа),
 * сдвиг по `cadence.weekend` (по умолчанию `keep`); сдвинутая за границы дата отбрасывается. Срок в число дат не входит.
 * В v1 только `freq = M` (C-030).
 * @param {EpochDay|string} start
 * @param {EpochDay|string} due верхняя граница (не включается)
 * @param {{freq: string, day: number, weekend?: string}} cadence
 * @param {Calendar} [cal] нужен при `weekend ≠ keep`
 * @returns {EpochDay[]} по возрастанию, без повторов
 * @throws {RunwayError} E_SCHEMA (`freq ≠ M`, день вне 1…31)
 */
export function contribution_dates(start, due, cadence, cal) {
  if (cadence?.freq !== 'M' || !Number.isInteger(cadence.day) || cadence.day < 1 || cadence.day > 31) {
    fail('E_SCHEMA', { reason: 'only_monthly_cadence_day_1_31', freq: String(cadence?.freq), day: String(cadence?.day) });
  }
  const s = to_epoch_day(start);
  const dd = to_epoch_day(due);
  const policy = cadence.weekend ?? 'keep';
  const calendar = cal ?? make_calendar({});
  const [y, m] = civil_from_days(s);
  const t0 = y * 12 + (m - 1);
  const out = new Set();
  // начиная с месяца t0 − 1: номинал предыдущего месяца, сдвинутый weekend=next (31 окт, суббота → 2 ноя) в окно, иначе терялся (Q-18, К-11);
  // фильтр `s ≤ d < dd` отбрасывает лишнее, Set — повторы
  for (let j = -1; j < MAX_MONTHS; j++) {
    const ty = floor_div(t0 + j, 12);
    const tm = floor_mod(t0 + j, 12) + 1;
    const nom = days_from_civil(ty, tm, clamp_day(ty, tm, cadence.day)); // от исходного day, без дрейфа
    // номинальные даты растут монотонно; запас в 62 дня — сдвиг назад (weekend=prev) номинала на сроке или сразу за ним может попасть до срока
    if (nom >= dd + 62) break;
    const d = shift_by_policy(nom, policy, calendar);
    if (d !== null && s <= d && d < dd) out.add(d);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Состояние резерва на начало `as_of` (C-020): `funded_start + Σ записанных аллокаций с funded_as_of < date ≤ as_of`
 * (в том числе по `posted`-доходу на `as_of`). Суммируются все источники со знаком (в т. ч. `release` и `manual`);
 * результат не ниже 0 (D-08: остаток резерва не бывает отрицательным).
 * @param {Reserve} reserve
 * @param {Allocation[]} recorded_allocations
 * @param {EpochDay|string} as_of
 * @returns {Minor}
 */
export function reserve_open(reserve, recorded_allocations, as_of) {
  return reserve_open_ex(reserve, recorded_allocations, as_of).funded_open_minor;
}

/**
 * То же, что `reserve_open`, но без молчаливых потерь (Q-20, К-13): возвращает ещё список отброшенных записей и обрезанный излишек.
 * `reserve_open` — обёртка над этой функцией и возвращает прежнее число на всех векторах.
 * @param {Reserve} reserve
 * @param {Allocation[]} recorded_allocations
 * @param {EpochDay|string} as_of
 * @returns {{funded_open_minor: Minor, ignored: {allocation_id: string, reason: 'future'|'before_funded_as_of'}[], clipped_minor: Minor}}
 *   `ignored` — записи ЭТОГО резерва с `date > as_of` (`future`) или `date ≤ funded_as_of` (`before_funded_as_of`), в порядке входа;
 *   `clipped_minor` — на сколько сумма ушла бы ниже 0 (ручная/release-запись больше накопленного), иначе 0
 */
export function reserve_open_ex(reserve, recorded_allocations, as_of) {
  const asof = to_epoch_day(as_of);
  const from = reserve.funded_as_of === undefined || reserve.funded_as_of === null ? -Infinity : to_epoch_day(reserve.funded_as_of);
  const parts = [assert_minor(reserve.funded_start_minor ?? 0)];
  const ignored = [];
  for (const a of recorded_allocations ?? []) {
    if (a.reserve_id !== reserve.reserve_id) continue;
    const d = to_epoch_day(a.date);
    if (from < d && d <= asof) parts.push(assert_minor(a.amount_minor));
    else ignored.push({ allocation_id: String(a.allocation_id), reason: d > asof ? 'future' : 'before_funded_as_of' });
  }
  // D-08: остатки резервов не уходят ниже 0 — и на входе тоже: записанная ручная/release-аллокация больше накопленного
  // не должна ронять весь расчёт (`reserve_series` бросает E_SCHEMA на отрицательном `funded_open`); излишек отбрасывается
  const total = sum_minor(parts);
  return { funded_open_minor: Math.max(0, total), ignored, clipped_minor: total < 0 ? -total : 0 };
}

/**
 * График взносов режима `refill_to_target`: `c_k = min(ceil_div(rem_k, n − k), rem_k)`, `rem_0 = target − funded_open`.
 * Сумма сходится ровно, разброс ≤ 1 minor, ранние взносы крупнее. X3: `rem ≤ 0` или нет дат — пустой график, без исключения;
 * нулевые строки опущены. Пересчёт от текущего `funded_open_minor` и есть «догон».
 * @param {{target_minor: Minor, funded_open_minor: Minor, dates: EpochDay[], mode?: 'refill_to_target'}} p
 * @returns {Array<{date: EpochDay, amount_minor: Minor}>}
 * @throws {RunwayError} E_SCHEMA (режим не `refill_to_target`)
 */
export function contribution_plan({ target_minor, funded_open_minor, dates, mode }) {
  if (mode !== undefined && mode !== 'refill_to_target') fail('E_SCHEMA', { reason: 'contribution_plan_is_refill_to_target', mode: String(mode) });
  if (target_minor === undefined || target_minor === null) fail('E_SCHEMA', { reason: 'target_missing' }); // Q-29: цель обязательна, а не E_NOT_INTEGER
  let rem = assert_minor(target_minor) - assert_minor(funded_open_minor);
  const n = dates.length;
  if (rem <= 0 || n === 0) return []; // X3: без деления на ноль и без исключения
  const rows = [];
  for (let k = 0; k < n; k++) {
    const c = Math.min(ceil_div(rem, n - k), rem);
    if (c > 0) rows.push({ date: dates[k], amount_minor: c });
    rem -= c;
  }
  return rows;
}

/**
 * Статус графика (X3): `reached` — цель достигнута (`rem ≤ 0`); `no_dates` — нет дат до срока, `shortfall = rem`;
 * `ok` — расписание строится.
 * @param {{target_minor: Minor, funded_open_minor: Minor, dates: EpochDay[]}} p
 * @returns {{status: 'ok'|'reached'|'no_dates', shortfall_minor: Minor}}
 */
export function plan_status({ target_minor, funded_open_minor, dates }) {
  const rem = assert_minor(target_minor) - assert_minor(funded_open_minor);
  if (rem <= 0) return { status: 'reached', shortfall_minor: 0 };
  if (dates.length === 0) return { status: 'no_dates', shortfall_minor: rem };
  return { status: 'ok', shortfall_minor: 0 };
}

/**
 * Режим `fixed`: взнос `fixed_minor` на каждую дату, цель не переполняется (последний взнос урезается), недостача — `shortfall_minor`.
 * `target_minor = null` — цель не задана, потолка нет (`reached_on = null`).
 * @param {{funded_open_minor: Minor, fixed_minor: Minor, dates: EpochDay[], target_minor?: Minor|null}} p
 * @returns {{rows: Array<{date: EpochDay, amount_minor: Minor}>, shortfall_minor: Minor, reached_on: EpochDay|null}}
 * @throws {RunwayError} E_SCHEMA (`fixed_minor < 0`)
 */
export function contribution_plan_fixed({ funded_open_minor, fixed_minor, dates, target_minor }) {
  const fixed = assert_minor(fixed_minor);
  if (fixed < 0) fail('E_SCHEMA', { reason: 'fixed_minor_negative', value: fixed });
  const has_target = target_minor !== null && target_minor !== undefined;
  let rem = has_target ? assert_minor(target_minor) - assert_minor(funded_open_minor) : null; // null — без потолка
  const rows = [];
  for (const d of dates) {
    if (rem !== null && rem <= 0) break;
    const c = rem === null ? fixed : Math.min(fixed, rem); // не переполняем цель
    if (c > 0) {
      rows.push({ date: d, amount_minor: c });
      if (rem !== null) rem -= c;
    }
  }
  const shortfall = rem === null ? 0 : Math.max(0, rem);
  const reached_on = has_target && shortfall === 0 && rows.length > 0 ? rows[rows.length - 1].date : null;
  return { rows, shortfall_minor: shortfall, reached_on };
}

/**
 * Справочно: за сколько периодов цель достигается при фиксированном взносе (`ceil_div(rem, fixed)`); `null`, если взнос 0.
 * При `rem ≤ 0` — 0.
 * @param {Minor} rem остаток к накоплению
 * @param {Minor} fixed_minor
 * @returns {number|null}
 */
export function periods_to_goal(rem, fixed_minor) {
  const f = assert_minor(fixed_minor);
  if (f === 0) return null;
  const r = assert_minor(rem);
  return r <= 0 ? 0 : ceil_div(r, f);
}

/**
 * Пул: общая сумма делится по весам методом наибольших остатков. Сумма весов 0 (все цели достигнуты) — нули.
 * @param {Minor} total
 * @param {number[]} weights
 * @returns {Minor[]} Σ = total (при Σ weights > 0)
 */
export function pool_split(total, weights) {
  const t = assert_minor(total);
  if (sum_minor(weights) === 0) return weights.map(() => 0);
  return split_largest_remainder(t, weights);
}

/**
 * Будущие плановые аллокации резерва `sinking` (`source = schedule`, `date ≥ as_of`, без уже записанных `allocation_id`).
 * Даты считаются до срока `due_date` (при его отсутствии — до горизонта), размер взноса — от всего срока; строки после `horizon_end` обрезаются
 * после расчёта (суммы не меняются). Уже записанные взносы входят в `funded_open_minor` и в число дат не попадают (идемпотентность, C-020).
 * @param {Reserve} reserve `kind = sinking`, `mode` обязателен; `due_date` обязателен при `refill_to_target`
 * @param {Minor} funded_open_minor результат `reserve_open`
 * @param {EpochDay|string} as_of
 * @param {EpochDay|string} horizon_end
 * @param {Calendar} cal
 * @param {Iterable<string>} recorded_ids `allocation_id` записанных аллокаций
 * @returns {Allocation[]}
 * @throws {RunwayError} E_SCHEMA (не sinking, нет `mode`, нет `due_date` при `refill_to_target`, нет `fixed_minor` при `fixed`)
 */
export function contribution_allocations(reserve, funded_open_minor, as_of, horizon_end, cal, recorded_ids) {
  if (reserve.kind !== 'sinking') fail('E_SCHEMA', { reason: 'not_a_sinking_reserve', reserve_id: String(reserve.reserve_id) });
  if (reserve.mode !== 'refill_to_target' && reserve.mode !== 'fixed') fail('E_SCHEMA', { reason: 'sinking_needs_mode', reserve_id: String(reserve.reserve_id) });
  const asof = to_epoch_day(as_of);
  const hz = to_epoch_day(horizon_end);
  const has_due = reserve.due_date !== undefined && reserve.due_date !== null;
  if (reserve.mode === 'refill_to_target' && !has_due) fail('E_SCHEMA', { reason: 'refill_to_target_needs_due_date', reserve_id: String(reserve.reserve_id) });
  if (reserve.mode === 'refill_to_target' && (reserve.target_minor === undefined || reserve.target_minor === null)) fail('E_SCHEMA', { reason: 'target_missing', reserve_id: String(reserve.reserve_id) }); // Q-29
  const due = has_due ? to_epoch_day(reserve.due_date) : hz + 1;
  const all = contribution_dates(asof, due, reserve.cadence ?? { freq: 'M', day: 1 }, cal);
  const recorded = new Set(recorded_ids ?? []);
  const id_of = (d) => 'sch:' + reserve.reserve_id + '@' + format_date(d);
  const dates = all.filter((d) => !recorded.has(id_of(d))); // записанные взносы уже в funded_open (C-020)
  let rows;
  if (reserve.mode === 'refill_to_target') {
    rows = contribution_plan({ target_minor: reserve.target_minor, funded_open_minor, dates, mode: reserve.mode });
  } else {
    if (reserve.fixed_minor === undefined || reserve.fixed_minor === null) fail('E_SCHEMA', { reason: 'fixed_mode_needs_fixed_minor', reserve_id: String(reserve.reserve_id) });
    rows = contribution_plan_fixed({ funded_open_minor, fixed_minor: reserve.fixed_minor, dates, target_minor: reserve.target_minor ?? null }).rows;
  }
  return rows.filter((r) => r.date <= hz).map((r) => ({
    allocation_id: id_of(r.date), reserve_id: reserve.reserve_id, date: r.date, amount_minor: r.amount_minor, source: 'schedule',
  }));
}

// ── ряд резервов и свободный остаток (ALG-11, D-08) ───────────────────────────

/**
 * Ряд резервов по дням `as_of … horizon_end` (D-08). За день: взнос или ручная правка `head` (в начале дня) → высвобождение
 * `released = min(funded, Σ|платежей, привязанных к резерву|)`, `true_up = платежи − released` → `reserve_trough` →
 * аллокации от доходов дня `tail` → `reserve_close`. Аллокация дохода дня попадает только в `reserve_close`.
 * Резервы с `backed_by_account_id ≠ null` в ряд не входят (деньги уже вне operating). Остатки не уходят ниже 0.
 * Предупреждения (`W_RESERVE_*`) строит `analyze` — здесь их нет.
 * @param {Reserve[]} reserves с `funded_open_minor ≥ 0` (после `reserve_open`)
 * @param {object[]} events эффективные события режима; платёж привязан через `reserve_id`, `amount_minor < 0`
 * @param {Allocation[]} allocations будущие, `date ≥ as_of`, без уже записанных `allocation_id`
 * @param {EpochDay|string} as_of
 * @param {EpochDay|string} horizon_end
 * @returns {{reserve_trough: Minor[], reserve_close: Minor[], by_reserve: Object<string, {trough: Minor[], close: Minor[], contributed: Minor[], released: Minor[], true_up: Minor[], allocated: Minor[]}>}}
 * @throws {RunwayError} E_BAD_DATE (`horizon_end < as_of`), E_SCHEMA (отрицательный `funded_open_minor`, аллокация раньше `as_of`, неизвестный источник, отрицательная аллокация `income`)
 */
export function reserve_series(reserves, events, allocations, as_of, horizon_end) {
  const asof = to_epoch_day(as_of);
  const hz = to_epoch_day(horizon_end);
  const N = hz - asof + 1;
  if (N < 1) fail('E_BAD_DATE', { reason: 'horizon_end_before_as_of', as_of: asof, horizon_end: hz });
  const R = [...(reserves ?? [])].filter((r) => r.backed_by_account_id === null || r.backed_by_account_id === undefined)
    .sort((a, b) => (a.reserve_id < b.reserve_id ? -1 : a.reserve_id > b.reserve_id ? 1 : 0));
  const zeros = () => new Array(N).fill(0);
  const funded = {};
  const pay = {};
  const head = {};
  const tail = {};
  const by_reserve = {};
  for (const r of R) {
    const id = r.reserve_id;
    if (typeof id !== 'string' || id === '' || id === '__proto__' || Object.hasOwn(by_reserve, id)) fail('E_SCHEMA', { reason: 'bad_or_duplicate_reserve_id', reserve_id: String(id) });
    const f = assert_minor(r.funded_open_minor ?? 0);
    if (f < 0) fail('E_SCHEMA', { reason: 'funded_open_negative', reserve_id: id, value: f });
    funded[id] = f;
    pay[id] = zeros();
    head[id] = zeros();
    tail[id] = zeros();
    by_reserve[id] = { trough: zeros(), close: zeros(), contributed: zeros(), released: zeros(), true_up: zeros(), allocated: zeros() };
  }
  for (const a of allocations ?? []) {
    const d = to_epoch_day(a.date);
    if (d < asof) fail('E_SCHEMA', { reason: 'allocation_before_as_of', allocation_id: String(a.allocation_id) }); // прошлое сворачивает журнал
    if (!SOURCES.includes(a.source)) fail('E_SCHEMA', { reason: 'unknown_allocation_source', value: String(a.source) });
    if (!Object.hasOwn(by_reserve, a.reserve_id) || d > hz) continue;
    const amt = assert_minor(a.amount_minor);
    if (a.source === 'income' && amt < 0) fail('E_SCHEMA', { reason: 'income_allocation_negative', allocation_id: String(a.allocation_id) }); // иначе funded < 0
    if (a.source === 'income') tail[a.reserve_id][d - asof] += amt;
    else head[a.reserve_id][d - asof] += amt; // schedule, manual (±), release
  }
  for (const e of events ?? []) {
    if (e.reserve_id === undefined || e.reserve_id === null || !Object.hasOwn(by_reserve, e.reserve_id) || !(e.amount_minor < 0)) continue;
    const i = to_epoch_day(e.date) - asof;
    if (i < 0 || i >= N) continue;
    pay[e.reserve_id][i] += -assert_minor(e.amount_minor);
  }
  const reserve_trough = zeros();
  const reserve_close = zeros();
  for (let i = 0; i < N; i++) {
    let rt = 0;
    for (const r of R) {
      const id = r.reserve_id;
      const b = by_reserve[id];
      const before = funded[id];
      funded[id] = Math.max(0, before + head[id][i]); // взнос / ручная правка
      b.contributed[i] = funded[id] - before;
      b.released[i] = Math.min(funded[id], pay[id][i]);
      funded[id] -= b.released[i];
      b.true_up[i] = pay[id][i] - b.released[i]; // уйдёт из свободных денег
      b.trough[i] = funded[id];
      rt += funded[id];
    }
    reserve_trough[i] = assert_minor(rt);
    let rc = 0;
    for (const r of R) {
      const id = r.reserve_id;
      const b = by_reserve[id];
      funded[id] += tail[id][i];
      b.allocated[i] = tail[id][i];
      b.close[i] = funded[id];
      rc += funded[id];
    }
    reserve_close[i] = assert_minor(rc);
  }
  return { reserve_trough, reserve_close, by_reserve };
}

/**
 * Свободный остаток по дням: `free[i] = trough[i] − reserve_trough[i]` (может быть < 0: деньги есть, но закреплены).
 * Без резервов `free = trough`.
 * @param {Minor[]} trough физический минимум дня
 * @param {Minor[]} reserve_trough
 * @returns {Minor[]}
 * @throws {RunwayError} E_SCHEMA (длины рядов не равны)
 */
export function free_series(trough, reserve_trough) {
  if (trough.length !== reserve_trough.length) fail('E_SCHEMA', { reason: 'series_length_mismatch', trough: trough.length, reserve_trough: reserve_trough.length });
  return trough.map((t, i) => assert_minor(t - reserve_trough[i]));
}
