// expected.mjs — ряд «ожидаемый» как ОТОБРАЖАЕМАЯ оценка (FP-11, REQ-053, ADR-006, ALG-13, C-052, C-053).
// Режим `expected` в расчёте по-прежнему не включён: `normalize_mode('expected')` бросает `E_SCHEMA mode_not_in_v1`, `analyze` и `build_events` его не принимают,
// заголовочный режим остаётся `plan`/`worse`. Здесь — отдельный ряд-оценка поверх готового `Analysis`: плановые поступления потоков, у которых есть не менее
// 10 сопоставленных наблюдений лага (`expected_ready`), сдвигаются на медиану лага `lag_p50` (nearest-rank), остальные остаются как в `plan` (D-04, C-053).
// Ряд ничего не меняет в `Analysis`, в вердиктах `OK/TIGHT/FRAGILE/NO` и в числах Q1/Q3; он нужен только для показа рядом с `plan` и `worse`.
// Зависимости (слой над ядром): money, dates, calibration, timeline, montecarlo (`make_evaluate`). Модуль чистый: ни часов, ни случайности.
// Расчёт по введённым данным и истории пользователя, не прогноз и не совет.

import { fail, assert_minor } from './money.mjs';
import { to_epoch_day } from './dates.mjs';
import { flow_key, flow_calibration, expected_lag } from './calibration.mjs';
import { make_evaluate } from './montecarlo.mjs';

/** @typedef {import('./money.mjs').Minor} Minor */
/** @typedef {import('./dates.mjs').EpochDay} EpochDay */

/** Минимум наблюдений потока для сдвига на `lag_p50` (REQ-053, C-053). */
export const EXPECTED_MIN_OBS = 10;

const cmp_str = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Поступление, которое может сдвигать оценка: плановое, доход, ожидается или просрочено. */
function is_income_to_shift(e) {
  return e.kind === 'income' && e.layer === 'planned' && (e.status === 'expected' || e.status === 'overdue') && e.amount_minor > 0;
}

/**
 * Лаг потока для ряда «ожидаемый»: `lag_p50`, если наблюдений не меньше 10, иначе `null` (поток считается как `plan`).
 * Медиана — nearest-rank `p50` (C-052); `shrink_to_prior` — подсказка интерфейса и дату не сдвигает (C-053).
 * @param {number[]|undefined} lags наблюдения лага потока, дни
 * @returns {{n: number, lag_days: number|null}}
 */
export function flow_expected_lag(lags) {
  const list = Array.isArray(lags) ? lags : [];
  const cal = flow_calibration(list, []);
  return { n: cal.n, lag_days: cal.n === 0 ? null : expected_lag(cal) };
}

/**
 * Ряд «ожидаемый» на готовом расчёте: даты поступлений потоков с историей ≥ 10 сдвигаются на `lag_p50` потока (от плановой даты, не раньше `as_of`);
 * поступление, ушедшее за горизонт, из ряда выпадает (как в режиме `worse`). Расходы и поступления потоков без истории не меняются.
 * Результат — ОЦЕНКА ДЛЯ ПОКАЗА: `displayed_only = true`; `Analysis` и режимы расчёта не затронуты.
 * @param {object} ws рабочая область (форма — как у `analyze`)
 * @param {object} analysis результат `analyze` (нужны `events.plan`, `series.plan`, `as_of`, `horizon_end`)
 * @param {{lag_obs?: Object<string, number[]>}} obs наблюдения лагов по потокам (`mc_inputs.mc_observations`)
 * @returns {{displayed_only: true, mode: 'expected', from: EpochDay, close: Minor[], trough: Minor[], free: Minor[],
 *   shifted: {cash_event_id: string, flow_key: string, plan_date: EpochDay, expected_date: EpochDay|null, lag_days: number, n: number}[],
 *   unshifted: {flow_key: string, n: number}[], same_as_plan: boolean}}
 *   `shifted` — сдвинутые поступления (`expected_date = null` — вышло за горизонт); `unshifted` — потоки доходов без достаточной истории (с числом `n`)
 * @throws {RunwayError} E_SCHEMA (нет плана в `analysis`)
 */
export function expected_series(ws, analysis, obs = {}) {
  const plan_events = analysis?.events?.plan;
  if (!Array.isArray(plan_events) || analysis?.series?.plan === undefined) fail('E_SCHEMA', { reason: 'expected_needs_plan_events' });
  const as_of = to_epoch_day(analysis.as_of);
  const horizon_end = to_epoch_day(analysis.horizon_end);
  const lag_obs = obs.lag_obs ?? {};
  const shifted = [];
  const unshifted = new Map();
  const events = [];
  let moved = false; // хоть одно поступление реально сменило дату или вышло за горизонт
  for (const e of plan_events) {
    if (!is_income_to_shift(e)) { events.push(e); continue; }
    const key = flow_key(e);
    const { n, lag_days } = flow_expected_lag(Object.hasOwn(lag_obs, key) ? lag_obs[key] : undefined);
    if (lag_days === null) {
      unshifted.set(key, n);
      events.push(e);
      continue;
    }
    const plan_date = to_epoch_day(e.plan_date ?? e.date);
    const d = Math.max(as_of, plan_date + assert_minor(lag_days));
    if (d !== to_epoch_day(e.date)) moved = true;
    if (d > horizon_end) {
      shifted.push({ cash_event_id: e.cash_event_id, flow_key: key, plan_date, expected_date: null, lag_days, n });
      continue;
    }
    shifted.push({ cash_event_id: e.cash_event_id, flow_key: key, plan_date, expected_date: d, lag_days, n });
    events.push({ ...e, date: d });
  }
  events.sort((x, y) => (x.date - y.date) || (x.amount_minor - y.amount_minor) || cmp_str(String(x.cash_event_id), String(y.cash_event_id)));
  const s = make_evaluate(ws, analysis)(events);
  return {
    displayed_only: true,
    mode: 'expected',
    from: as_of,
    close: s.close,
    trough: s.trough,
    free: s.free,
    shifted,
    unshifted: [...unshifted.entries()].sort((a, b) => cmp_str(a[0], b[0])).map(([flow, n]) => ({ flow_key: flow, n })),
    same_as_plan: !moved,
  };
}
