// band_adapter.test.mjs — адаптер коридора P10/P50/P90 и «при уверенности α» над montecarlo (FP-11, REQ-054, REQ-055, ADR-008, ADR-015, TST-48, TST-49).
// Ожидаемые числа: канон REQ-054 (лаги [0,3,7,5,14,6,2,9], покупка 30000 при B = 50000 → p_fail = 2 из 8) и независимые вычисления (интервал Уилсона
// из calibration, эквивалентность OK(α) ⇔ 100·k < α·n из ALG-10). Расчёт по введённым данным, эксперимент: вердикты и Q1/Q3 не меняются.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import * as ba from '../engine/band_adapter.mjs';
import { analyze, check_purchase, round_div } from '../engine/index.mjs';
import { wilson } from '../engine/calibration.mjs';
import { backtest, replay_state } from '../engine/backtest.mjs';
import { make_journal, regular_corpus } from '../data/synthetic-journals/generate.mjs';
import { throws_code } from './helpers.mjs';

const DATA = new URL('../data/', import.meta.url);
const G = JSON.parse(fs.readFileSync(new URL('g001.json', DATA), 'utf8'));
const A = analyze(G, { as_of: '2026-10-04' });
const LAGS = [0, 3, 7, 5, 14, 6, 2, 9];
const obs_of = (lags) => ({ lag_obs: { 'S-HOURLY': lags }, ratio_obs_bp: {}, fx_obs_bp: {}, flows: [{ key: 'S-HOURLY', n: lags.length }] });
const deep_freeze = (x) => {
  if (x !== null && typeof x === 'object' && !Object.isFrozen(x)) { Object.freeze(x); for (const k of Object.keys(x)) deep_freeze(x[k]); }
  return x;
};

test('REQ-054 TST-49 mc_buy: канон — на лагах [0,3,7,5,14,6,2,9] покупка 30000 при B = 50000 нарушает буфер в 2 из 8; подача — счёт «k из n», процента нет', () => {
  const r = ba.mc_buy(G, A, { S: 30000, date: '2026-10-12', obs: obs_of(LAGS) });
  assert.equal(r.ok, true);
  assert.equal(r.enumerated, true, 'один доход и история ≤ 64 — полный перебор наблюдений');
  assert.equal(r.n_paths, 8);
  assert.equal(r.n_eff, 8);
  assert.deepEqual(r.presentation, { kind: 'count', k: 2, n: 8 });
  assert.deepEqual(r.held, { k: 6, n: 8 });
  assert.equal(r.B, 50000);
  assert.equal(r.S, 30000);
});

test('REQ-054 mc_buy: уровни уверенности — s_max = max(0, q − B); OK(α) ⇔ 100·k < α·n (эквивалентность ALG-10); подпись «наименьшее из n» там, где ceil(α·n/100) = 1', () => {
  const r = ba.mc_buy(G, A, { S: 30000, date: '2026-10-12', obs: obs_of(LAGS) });
  const k = r.held.n - r.held.k;
  assert.deepEqual(r.levels.map((l) => l.confidence), [80, 90, 95]);
  for (const l of r.levels) {
    assert.equal(l.alpha, 100 - l.confidence);
    assert.equal(l.s_max, Math.max(0, l.q_min - r.B));
    assert.equal(l.ok, 100 * k < l.alpha * r.held.n, `α = ${l.alpha}`);
    assert.equal(l.ok, l.q_min - r.S >= r.B);
  }
  // n = 8: α = 20 → ceil(1,6) = 2 → подписи нет; α = 10 и 5 → ceil(0,8) = ceil(0,4) = 1 → «наименьшее из 8»
  assert.deepEqual(r.levels.map((l) => l.label), [null, 'min_of_n', 'min_of_n']);
  const custom = ba.mc_buy(G, A, { S: 30000, date: '2026-10-12', obs: obs_of(LAGS), confidences: [50, 99] });
  assert.deepEqual(custom.levels.map((l) => [l.confidence, l.alpha]), [[50, 50], [99, 1]]);
  throws_code(() => ba.mc_buy(G, A, { S: 30000, date: '2026-10-12', obs: obs_of(LAGS), confidences: [0] }), 'E_SCHEMA');
});

test('REQ-055 quantile_label: «наибольшее из n» при ceil(q·n) = n, «наименьшее из n» при ceil(q·n) = 1 и q < 50 (C-049)', () => {
  assert.equal(ba.quantile_label(90, 8), 'max_of_n'); // ceil(7,2) = 8
  assert.equal(ba.quantile_label(10, 8), 'min_of_n'); // ceil(0,8) = 1
  assert.equal(ba.quantile_label(50, 8), null);
  assert.equal(ba.quantile_label(80, 8), null); // ceil(6,4) = 7 ≠ 8
});

test('REQ-055 quantile_label: проверка границ по определению ceil(q·n/100)', () => {
  const ceil = (q, n) => Math.ceil((q * n) / 100);
  for (const n of [1, 2, 3, 5, 8, 10, 19, 20, 40]) {
    for (const q of [1, 5, 10, 20, 50, 80, 90, 95, 99]) {
      const rank = ceil(q, n);
      const want = rank === n ? 'max_of_n' : rank === 1 && q < 50 ? 'min_of_n' : null;
      assert.equal(ba.quantile_label(q, n), want, `q=${q} n=${n}`);
    }
  }
  throws_code(() => ba.quantile_label(0, 8), 'E_SCHEMA');
  throws_code(() => ba.quantile_label(100, 8), 'E_SCHEMA');
  throws_code(() => ba.quantile_label(50, 0), 'E_SCHEMA');
  throws_code(() => ba.alpha_of(100), 'E_SCHEMA');
  assert.equal(ba.alpha_of(90), 10);
});

test('REQ-055 без истории — отказ no_history с перечнем потоков без наблюдений; на коридор и на покупку одинаково', () => {
  const none = { lag_obs: {}, ratio_obs_bp: {}, fx_obs_bp: {}, flows: [] };
  const buy = ba.mc_buy(G, A, { S: 30000, date: '2026-10-12', obs: none });
  assert.deepEqual(buy, { ok: false, reason: 'no_history', flows_without_history: ['S-HOURLY'], n_eff: 0 });
  const band = ba.mc_band(G, A, { obs: none });
  assert.deepEqual(band, { ok: false, reason: 'no_history', flows_without_history: ['S-HOURLY'], n_eff: 0 });
  // рабочая область без дохода в горизонте: возмущать нечего → тоже отказ (n_eff = null → 0)
  const no_income = { ...G, streams: [] };
  const A2 = analyze(no_income, { as_of: '2026-10-04' });
  assert.equal(ba.mc_band(no_income, A2, { obs: none }).reason, 'no_history');
});

test('REQ-055 при n < 20 и выборке (не полном переборе) процент не подаётся: small_sample с числом наблюдений; при n ≥ 20 — процент и интервал Уилсона по n_eff', () => {
  const sampled8 = ba.mc_buy(G, A, { S: 30000, date: '2026-10-12', obs: obs_of(LAGS), kinds: ['lag', 'ratio'], n_paths: 400 });
  assert.equal(sampled8.enumerated, false);
  assert.deepEqual(sampled8.presentation, { kind: 'none', reason: 'small_sample', n: 8 });
  // 24 наблюдения (повтор профиля из 8 лагов трижды): выборка, n_eff = 24 ≥ 20 → процент и интервал
  const lags24 = [...LAGS, ...LAGS, ...LAGS];
  const r = ba.mc_buy(G, A, { S: 30000, date: '2026-10-12', obs: obs_of(lags24), kinds: ['lag', 'ratio'], n_paths: 1000 });
  assert.equal(r.n_eff, 24);
  assert.equal(r.presentation.kind, 'interval');
  const k = r.held.n - r.held.k;
  const k_e = round_div(k * 24, r.n_paths);
  const w = wilson(k_e, 24, 196);
  assert.deepEqual(r.presentation, { kind: 'interval', p_pm: round_div(1000 * k_e, 24), lo_pm: w.lo_pm, hi_pm: w.hi_pm, n: 24 });
  // профиль повторён трижды: доля нарушений около 2/8 = 25 % (бутстрап, допуск ±6 п. п.)
  assert.ok(Math.abs(k / r.n_paths - 0.25) < 0.06, `доля путей ${k / r.n_paths}`);
  // канон REQ-055: 5 из 40 → ≈ 12,5 % (95 %: 5,5–26,1 %) — то же вычисление интервала
  const w40 = wilson(5, 40, 196);
  assert.deepEqual([w40.lo_pm, w40.hi_pm], [55, 261]);
});

test('REQ-054 mc_buy: отказы по данным — нет буфера, дата раньше расчёта, дата за горизонтом; сумма не из целых больше нуля — E_SCHEMA', () => {
  const no_buf = analyze({ ...G, params: { ...G.params, buffer_minor: null } }, { as_of: '2026-10-04' });
  assert.equal(ba.mc_buy(G, no_buf, { S: 30000, date: '2026-10-12', obs: obs_of(LAGS) }).reason, 'no_buffer');
  assert.equal(ba.mc_buy(G, A, { S: 30000, date: '2026-10-03', obs: obs_of(LAGS) }).reason, 'date_before_as_of');
  assert.equal(ba.mc_buy(G, A, { S: 30000, date: '2026-12-01', obs: obs_of(LAGS) }).reason, 'beyond_horizon');
  throws_code(() => ba.mc_buy(G, A, { S: 0, date: '2026-10-12', obs: obs_of(LAGS) }), 'E_SCHEMA');
  throws_code(() => ba.mc_buy(G, A, { S: 1.5, date: '2026-10-12', obs: obs_of(LAGS) }), 'E_NOT_INTEGER');
  throws_code(() => ba.mc_buy(G, A, { S: 30000, date: '2026-10-12', obs: obs_of(LAGS), n_paths: 0 }), 'E_SCHEMA');
  throws_code(() => ba.mc_buy(G, A, { S: 30000, date: '2026-10-12', obs: obs_of(LAGS), user_seed: 1.5 }), 'E_SCHEMA');
});

test('TST-48 mc_band: коридор P10 ≤ P50 ≤ P90 по дням, в день расчёта равен остатку, детерминирован при одном seed; user_seed меняет seed; строки таблицы — день, каждые 7 дней и последний', () => {
  const a = ba.mc_band(G, A, { obs: obs_of(LAGS) });
  const b = ba.mc_band(G, A, { obs: obs_of(LAGS) });
  assert.deepEqual(a, b);
  assert.equal(a.ok, true);
  assert.equal(a.n_eff, 8);
  assert.equal(a.close_q.length, A.series.plan.close.length);
  for (const q of a.close_q) assert.ok(q.p10 <= q.p50 && q.p50 <= q.p90);
  assert.deepEqual(a.close_q[0], { p10: A.series.plan.close[0], p50: A.series.plan.close[0], p90: A.series.plan.close[0] }, 'в день расчёта неопределённости нет');
  assert.deepEqual(a.rows.map((r) => r.date - a.from).slice(0, 3), [0, 7, 14]);
  assert.equal(a.rows.at(-1).date - a.from, a.close_q.length - 1);
  assert.deepEqual(a.gap_presentation, { kind: 'count', k: a.p_gap_any.k, n: 8 });
  const other = ba.mc_band(G, A, { obs: obs_of(LAGS), user_seed: 7 });
  assert.notEqual(other.seed, a.seed);
  assert.deepEqual(other.close_q, a.close_q, 'полный перебор наблюдений от seed не зависит');
  assert.deepEqual(ba.band_rows({ from: 100, close_q: Array.from({ length: 10 }, (_, i) => ({ p10: i, p50: i, p90: i })) }, 4).map((r) => r.date), [100, 104, 108, 109]);
  throws_code(() => ba.band_rows(a, 0), 'E_SCHEMA');
});

test('ADR-015 mc_band и mc_buy не меняют Analysis и вердикт: заморожённый анализ, тот же inputs_hash, тот же ответ check_purchase', () => {
  const frozen = deep_freeze(analyze(G, { as_of: '2026-10-04' }));
  const buy = { currency: 'EUR', parts: [{ date: '2026-10-12', amount_minor: 30000 }] };
  const before = check_purchase(frozen, buy, frozen.buffer_minor);
  ba.mc_band(G, frozen, { obs: obs_of(LAGS) });
  ba.mc_buy(G, frozen, { S: 30000, date: '2026-10-12', obs: obs_of(LAGS) });
  assert.deepEqual(check_purchase(frozen, buy, frozen.buffer_minor), before);
  assert.equal(before.verdict, 'FRAGILE');
});

test('ALG-13 REQ-054 mc_band_adapter: коридор P10–P90 подставляется в backtest как opts.band; FRR, cry-wolf и число начал не меняются, меняется только покрытие', () => {
  const spec = { ...regular_corpus()[1], start: '2026-01-01', end: '2026-05-31' };
  const journal = make_journal(spec);
  const base = backtest(journal, '2026-03-01', 14);
  const adapter = ba.mc_band_adapter(journal, { replay_state, n_paths: 60 });
  const mc = backtest(journal, '2026-03-01', 14, { band: adapter });
  assert.ok(base.n_origins >= 3);
  assert.equal(mc.n_origins, base.n_origins);
  assert.deepEqual(mc.frr, base.frr);
  assert.deepEqual(mc.cry_wolf, base.cry_wolf);
  assert.deepEqual([mc.mae_minor, mc.bias_minor], [base.mae_minor, base.bias_minor]);
  assert.equal(mc.coverage.n, base.coverage.n);
  assert.ok(mc.coverage.k >= 0 && mc.coverage.k <= mc.coverage.n);
  // без истории (до первого платежа) адаптер возвращает прежний коридор plan–worse, а не придуманный
  const t0 = journal.filter((e) => e.recorded_at.slice(0, 10) <= '2026-01-02');
  const A0 = analyze(
    { accounts: [{ account_id: 'a', name: 'a', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 }], anchors: [{ anchor_id: 'x', account_id: 'a', date: '2026-01-01', amount_minor: 100000 }], decision_currency: 'EUR', params: { horizon_days: 20 } },
    { as_of: '2026-01-01', horizon_end: '2026-01-15' },
  );
  const band = ba.mc_band_adapter(t0, { replay_state })(A0, A0.as_of, 14);
  assert.throws(() => ba.mc_band_adapter(t0, {}), (e) => e.code === 'E_SCHEMA');
  assert.throws(() => ba.mc_band_adapter(t0), (e) => e.code === 'E_SCHEMA');
  assert.deepEqual(band, { lo: Math.min(A0.series.plan.close[14], A0.series.worse.close[14]), hi: Math.max(A0.series.plan.close[14], A0.series.worse.close[14]) });
});

test('ADR-015 TST-49 REQ-055 в шаблонах ответов v1 ключа probability нет; слова-обещания не встречаются в модулях вероятностей', () => {
  const verifier = fs.readFileSync(new URL('../engine/verifier.mjs', import.meta.url), 'utf8');
  assert.ok(!/\bprobability\b/.test(verifier.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'ключ probability в коде шаблонов');
  for (const f of ['mc_inputs.mjs', 'band_adapter.mjs', 'expected.mjs']) {
    const src = fs.readFileSync(new URL('../engine/' + f, import.meta.url), 'utf8').toLowerCase();
    for (const bad of ['гарантируем', 'точный прогноз', 'вероятность успеха', 'безопасно']) assert.ok(!src.includes(bad), `${f}: «${bad}»`);
  }
});
