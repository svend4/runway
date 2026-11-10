// expected.test.mjs — ряд «ожидаемый» как ОТОБРАЖАЕМАЯ оценка (FP-11, REQ-053, ADR-006, C-052, C-053, TST-50): сдвиг только при ≥ 10 наблюдениях,
// режим расчёта `expected` по-прежнему недоступен (`mode_not_in_v1`), вердикты и числа Q1/Q3 не меняются.
// Ожидаемые числа — из канона REQ-053 (8 наблюдений → как plan; 10 и более → p50 nearest-rank) и независимых сопоставлений рядов.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import * as ex from '../engine/expected.mjs';
import { analyze, build_events, check_purchase } from '../engine/index.mjs';
import { parse_date } from '../engine/dates.mjs';
import { throws_code } from './helpers.mjs';

const DATA = new URL('../data/', import.meta.url);
const G = JSON.parse(fs.readFileSync(new URL('g001.json', DATA), 'utf8'));
const A = analyze(G, { as_of: '2026-10-04' });
const deep_freeze = (x) => {
  if (x !== null && typeof x === 'object' && !Object.isFrozen(x)) { Object.freeze(x); for (const k of Object.keys(x)) deep_freeze(x[k]); }
  return x;
};

/** Десять наблюдений лага потока S-HOURLY: после сортировки 0 2 3 4 5 6 7 8 9 14, nearest-rank p50 = 5-й = 5. */
const LAGS10 = [0, 3, 7, 5, 14, 6, 2, 9, 4, 8];
const LAGS8 = [0, 3, 7, 5, 14, 6, 2, 9];

test('REQ-053 flow_expected_lag: 8 наблюдений — как plan (лага нет); 10 и более — lag_p50 по nearest-rank; пустой поток — лага нет', () => {
  assert.deepEqual(ex.flow_expected_lag(LAGS8), { n: 8, lag_days: null });
  assert.deepEqual(ex.flow_expected_lag(LAGS10), { n: 10, lag_days: 5 });
  assert.deepEqual(ex.flow_expected_lag([]), { n: 0, lag_days: null });
  assert.deepEqual(ex.flow_expected_lag(undefined), { n: 0, lag_days: null });
  // C-052: «медиана» везде nearest-rank: клиент с лагами [10, 12] имел бы p50 = 10, но при n = 2 дату всё равно не сдвигает
  assert.deepEqual(ex.flow_expected_lag([12, 10]), { n: 2, lag_days: null });
  assert.equal(ex.EXPECTED_MIN_OBS, 10);
});

test('REQ-053 expected_series: поток с 10 наблюдениями сдвигает выплату 5 ноября на p50 = 5 дней; ряд отличается от plan ровно на сумму выплаты в днях 5–9 ноября', () => {
  const income = A.events.plan.find((e) => e.cash_event_id === 'S-HOURLY@2026-11-05');
  const r = ex.expected_series(G, A, { lag_obs: { 'S-HOURLY': LAGS10 } });
  assert.equal(r.displayed_only, true);
  assert.equal(r.mode, 'expected');
  assert.equal(r.same_as_plan, false);
  assert.equal(r.shifted.length, 1);
  assert.equal(r.shifted[0].lag_days, 5);
  assert.equal(r.shifted[0].n, 10);
  assert.equal(r.shifted[0].expected_date, parse_date('2026-11-10'));
  assert.equal(r.shifted[0].plan_date, parse_date('2026-11-05'));
  const base = A.series.plan;
  const d5 = parse_date('2026-11-05') - base.from;
  const d10 = parse_date('2026-11-10') - base.from;
  for (let i = 0; i < base.close.length; i++) {
    const delta = i >= d5 && i < d10 ? -income.amount_minor : 0;
    assert.equal(r.close[i], base.close[i] + delta, `close[${i}]`);
  }
  assert.equal(r.close.length, base.close.length);
  assert.equal(r.trough.length, base.trough.length);
  assert.equal(r.free.length, base.free.length);
});

test('REQ-053 expected_series: 8 наблюдений — ряд равен plan, поток отмечен как «без достаточной истории»; без наблюдений — то же', () => {
  const r8 = ex.expected_series(G, A, { lag_obs: { 'S-HOURLY': LAGS8 } });
  assert.equal(r8.same_as_plan, true);
  assert.deepEqual(r8.shifted, []);
  assert.deepEqual(r8.unshifted, [{ flow_key: 'S-HOURLY', n: 8 }]);
  assert.deepEqual(r8.close, A.series.plan.close);
  assert.deepEqual(r8.trough, A.series.plan.trough);
  assert.deepEqual(r8.free, A.series.plan.free, 'свободные деньги plan и expected без сдвига совпадают');
  const none = ex.expected_series(G, A);
  assert.equal(none.same_as_plan, true);
  assert.deepEqual(none.unshifted, [{ flow_key: 'S-HOURLY', n: 0 }]);
});

test('REQ-053 expected_series: лаг за горизонтом убирает выплату из ряда; нулевой p50 ничего не двигает', () => {
  const far = Array.from({ length: 10 }, () => 60); // 5 ноября + 60 дней — за горизонтом 57 дней от 4 октября
  const r = ex.expected_series(G, A, { lag_obs: { 'S-HOURLY': far } });
  assert.equal(r.shifted[0].expected_date, null);
  const income = A.events.plan.find((e) => e.cash_event_id === 'S-HOURLY@2026-11-05');
  assert.equal(r.close.at(-1), A.series.plan.close.at(-1) - income.amount_minor);
  const zero = ex.expected_series(G, A, { lag_obs: { 'S-HOURLY': Array.from({ length: 10 }, () => 0) } });
  assert.equal(zero.same_as_plan, true, 'сдвига нет: ряд равен plan, хотя поток и «достаточно изучен»');
  assert.deepEqual(zero.close, A.series.plan.close);
});

test('REQ-053 режим expected в расчёте по-прежнему недоступен: mode_not_in_v1; анализ, события, вердикт и Q1 не меняются от ряда-оценки', () => {
  throws_code(() => analyze(G, { as_of: '2026-10-04', modes: ['expected'] }), 'E_SCHEMA');
  throws_code(() => build_events(G, { as_of: '2026-10-04', mode: 'expected' }), 'E_SCHEMA');
  try { build_events(G, { as_of: '2026-10-04', mode: 'expected' }); assert.fail('должен бросить'); } catch (e) { assert.equal(e.ctx?.reason ?? e.context?.reason, 'mode_not_in_v1'); }
  const frozen = deep_freeze(analyze(G, { as_of: '2026-10-04' }));
  const before_hash = frozen.inputs_hash;
  const buy = { currency: 'EUR', parts: [{ date: '2026-10-12', amount_minor: 30000 }] };
  const verdict_before = check_purchase(frozen, buy, frozen.buffer_minor);
  ex.expected_series(G, frozen, { lag_obs: { 'S-HOURLY': LAGS10 } });
  assert.deepEqual(Object.keys(frozen.series).sort(), ['plan', 'worse'], 'в Analysis нет третьего режима');
  assert.equal(frozen.inputs_hash, before_hash);
  assert.deepEqual(check_purchase(frozen, buy, frozen.buffer_minor), verdict_before);
  assert.equal(verdict_before.verdict, 'FRAGILE', 'канон: покупка 300 € 12 октября на G-001 — «хрупко»');
});

test('REQ-053 expected_series: просроченный доход при лаге меньше возраста встаёт на as_of, а не в прошлое; нет плана в Analysis — E_SCHEMA', () => {
  const late = analyze({ ...G, as_of: '2026-11-12' }, { as_of: '2026-11-12', horizon_days: 20 });
  const overdue = late.events.plan.find((e) => e.cash_event_id === 'S-HOURLY@2026-11-05');
  assert.equal(overdue.status, 'overdue');
  const r = ex.expected_series({ ...G, as_of: '2026-11-12' }, late, { lag_obs: { 'S-HOURLY': LAGS10 } });
  // план 5 ноября + 5 дней = 10 ноября < as_of 12 ноября → выплата ожидается в день расчёта, как у overdue в режиме plan
  assert.equal(r.shifted[0].expected_date, parse_date('2026-11-12'));
  assert.equal(r.same_as_plan, true, 'просроченный доход и так стоит на as_of');
  throws_code(() => ex.expected_series(G, { as_of: 1 }, {}), 'E_SCHEMA');
});
