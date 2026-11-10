// montecarlo.test.mjs — seeded Монте-Карло (ALG-10, ADR-008): TST-48, TST-49, TST-50 (+ часть TST-33: детерминизм seed).
// Ожидаемые числа — из канона ДОСЛОВНО: design-brief §9.15, wiki/algorithms/alg-10 (TV-1…TV-6), alg-13 (TV-3, TV-4), product/11 (TST-48…50).
// Код движка в ожиданиях не участвует. В тестах допустимы node:fs и Date (в engine/ — нет).
// Это v2 в продукте (в v1 вероятностей нет), в прототипе — заранее; восемь лагов — наблюдения потока S-HOURLY (REQ-054).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import * as mc from '../engine/montecarlo.mjs';
import { analyze, ENGINE_VERSION } from '../engine/index.mjs';
import { project } from '../engine/timeline.mjs';
import {
  nearest_rank as nearest_rank_cal, wilson, flow_calibration, shrink_to_prior, expected_lag, ewma,
} from '../engine/calibration.mjs';
import { parse_date, format_date } from '../engine/dates.mjs';
import { ceil_div } from '../engine/money.mjs';
import { throws_code, make_rng } from './helpers.mjs';

const DATA = new URL('../data/', import.meta.url);
const load = (name) => JSON.parse(fs.readFileSync(new URL(name, DATA), 'utf8'));
const G = load('g001.json');
const LOW = load('g001-low.json');
const GAP = load('g001-gap.json');

/** Восемь наблюдённых задержек выплаты, дни (§9.15). */
const LAGS = [0, 3, 7, 5, 14, 6, 2, 9];
const LAGS_SORTED = [0, 2, 3, 5, 6, 7, 9, 14];
const HASH64 = '0123456789abcdef'.repeat(4); // синтетический inputs_hash из TV-1
const KEY = 'S-HOURLY@2026-11-05|lag';
const D_BUY = '2026-10-12';
const S_BUY = 30000;
const B = 50000;

function ctx_of(ws, lags = LAGS) {
  const A = analyze(ws, { as_of: '2026-10-04' });
  return { A, ctx: mc.mc_context(ws, A, { lag_obs: { 'S-HOURLY': lags } }) };
}
const { A: A_G, ctx: CTX } = ctx_of(G);
const SEED = 68106871;

const hex = (x) => '0x' + x.toString(16).toUpperCase();

// ── TST-48: генератор ──────────────────────────────────────────────────────────────────────────────────────────────────

test('TST-48 mix32: векторы канона (TV-1), uint32, mix32(0) = 0', () => {
  assert.equal(mc.mix32(0), 0);
  assert.equal(hex(mc.mix32(1)), '0x514E28B7');
  assert.equal(hex(mc.mix32(0xFFFFFFFF)), '0x81F16F39');
  // значение берётся по модулю 2^32 и всегда беззнаковое
  assert.equal(mc.mix32(2 ** 32 + 1), mc.mix32(1));
  assert.equal(mc.mix32(-1), mc.mix32(0xFFFFFFFF));
  const rng = make_rng(7);
  for (let i = 0; i < 2000; i++) {
    const h = mc.mix32(Math.floor(rng.next() * 2 ** 32));
    assert.ok(Number.isInteger(h) && h >= 0 && h < 2 ** 32);
  }
});

test('TST-48 fold32: точное значение через mix32; порядок важен в ЦЕПОЧКЕ свёрток (сам fold32 симметричен из-за XOR — расхождение с текстом ALG-10)', () => {
  assert.equal(mc.fold32(0, 0), mc.mix32(0x9E3779B9));
  assert.equal(mc.fold32(5, 3), mc.mix32(((5 ^ 3) + 0x9E3779B9) >>> 0));
  // ALG-10 пишет «порядок аргументов важен», но acc XOR x симметрично: fold32(a, b) = fold32(b, a)
  assert.equal(mc.fold32(1, 2), mc.fold32(2, 1));
  // а вот последовательность (seed, ключ, путь) от порядка зависит: поэтому u01 свёртывает именно в этом порядке
  const a = mc.fold32(mc.fold32(SEED, mc.hash_str('k')), 7);
  const b = mc.fold32(mc.fold32(SEED, 7), mc.hash_str('k'));
  assert.notEqual(a, b);
  assert.equal(mc.u01(SEED, 'k', 7), a / 2 ** 32);
});

test('TST-48 make_seed и hash_str: векторы TV-1 (inputs_hash = «0123456789abcdef»×4)', () => {
  assert.equal(mc.make_seed('0.1.0', HASH64, 0), 68106871);
  assert.equal(mc.make_seed('0.1.0', HASH64, 1), 477279656);
  assert.equal(mc.make_seed('0.1.0', HASH64), 68106871, 'user_seed по умолчанию 0');
  assert.equal(mc.make_seed('0.1.0', 'sha256:' + HASH64, 0), 68106871, 'префикс sha256: допустим');
  assert.equal(mc.hash_str(KEY), 1311552458);
  // user_seed берётся по модулю 2^32
  assert.equal(mc.make_seed('0.1.0', HASH64, 2 ** 32 + 1), 477279656);
  assert.equal(mc.make_seed('0.1.0', HASH64, -1), mc.make_seed('0.1.0', HASH64, 2 ** 32 - 1));
  // другая версия движка или другой хэш входов — другой seed
  assert.notEqual(mc.make_seed('0.1.1', HASH64, 0), 68106871);
  assert.notEqual(mc.make_seed('0.1.0', HASH64.replace('0', '1'), 0), 68106871);
});

test('TST-48 make_seed: inputs_hash не из 64 hex-знаков → E_SCHEMA (seed не воспроизводим)', () => {
  throws_code(() => mc.make_seed('0.1.0', 'abc', 0), 'E_SCHEMA');
  throws_code(() => mc.make_seed('0.1.0', HASH64.toUpperCase(), 0), 'E_SCHEMA', 'только нижний регистр');
  throws_code(() => mc.make_seed('0.1.0', HASH64 + '0', 0), 'E_SCHEMA');
  throws_code(() => mc.make_seed('0.1.0', HASH64, 1.5), 'E_SCHEMA');
  throws_code(() => mc.make_seed(1, HASH64, 0), 'E_SCHEMA');
});

test('TST-48 u01 по канону: seed 68106871 — пути 0…3 (индексы 2, 2, 5, 0 → лаги 3, 3, 7, 0); seed 477279656 — путь 0 → лаг 14', () => {
  const u = [0, 1, 2, 3].map((p) => mc.u01(SEED, KEY, p));
  assert.deepEqual(u.map((x) => x.toFixed(8)), ['0.27058609', '0.29148285', '0.66307358', '0.08763797']);
  assert.deepEqual(u.map((x) => Math.floor(8 * x)), [2, 2, 5, 0]);
  assert.deepEqual(u.map((x) => mc.sample_lag(LAGS_SORTED, x)), [3, 3, 7, 0]);
  const u2 = mc.u01(477279656, KEY, 0);
  assert.equal(u2.toFixed(8), '0.91283491');
  assert.equal(Math.floor(8 * u2), 7);
  assert.equal(mc.sample_lag(LAGS_SORTED, u2), 14);
  // u ∈ [0, 1); функция без состояния: повторный вызов — то же
  for (let p = 0; p < 500; p++) {
    const x = mc.u01(SEED, KEY, p);
    assert.ok(x >= 0 && x < 1);
    assert.equal(x, mc.u01(SEED, KEY, p));
  }
});

test('TST-48 sample_lag: граница u → последний элемент, пустая выборка → E_SCHEMA; tri_bp: 0…10000 и мода', () => {
  assert.equal(mc.sample_lag([4, 8, 9], 0), 4);
  assert.equal(mc.sample_lag([4, 8, 9], 0.9999999), 9);
  assert.equal(mc.sample_lag([4, 8, 9], 0.34), 8);
  throws_code(() => mc.sample_lag([], 0.5), 'E_SCHEMA');
  for (const c of [0, 1, 2500, 5000, 9999, 10000]) {
    assert.equal(mc.tri_bp(0, c), 0);
    assert.ok(mc.tri_bp(0.999999999, c) <= 10000);
    let prev = -1;
    for (let k = 0; k < 1000; k++) {
      const v = mc.tri_bp(k / 1000, c);
      assert.ok(v >= prev && v >= 0 && v <= 10000, 'монотонно по u, в диапазоне 0…10000');
      prev = v;
    }
    // u = c даёт моду: sqrt(c·c) = c
    assert.equal(mc.tri_bp(c / 10000, c), c === 10000 ? 10000 : c);
  }
});

test('TST-48 nearest_rank в montecarlo — реэкспорт calibration (C-050)', () => {
  assert.equal(mc.nearest_rank, nearest_rank_cal);
});

// ── TST-48: воспроизводимость, локальность, CRN ────────────────────────────────────────────────────────────────────────

test('TST-48/33 воспроизводимость: те же (ctx, seed, kinds, n_paths) → побайтно тот же Paths; порядок ctx.events не влияет', () => {
  const run = (ctx, seed, enumerate) => JSON.stringify(mc.run_paths(ctx, 300, { kinds: ['lag', 'hours'], from: D_BUY, enumerate }, seed));
  const a = run(CTX, SEED);
  const b = run(CTX, SEED);
  assert.equal(a, b);
  const reversed = { ...CTX, events: [...CTX.events].reverse() };
  assert.equal(run(reversed, SEED), a, 'порядок событий не влияет');
  assert.notEqual(run(CTX, SEED + 1), a, 'другой seed → другие пути');
  const paths = JSON.parse(a);
  assert.equal(paths.enumerated, false, 'два источника возмущений — выборка');
  assert.equal(paths.n_paths, 300);
});

test('TST-48 перебор не зависит от seed (инвариант 8): «k из n» без ошибки выборки', () => {
  const a = mc.run_paths(CTX, 2000, { kinds: ['lag'], from: D_BUY }, 1);
  const b = mc.run_paths(CTX, 2000, { kinds: ['lag'], from: D_BUY }, 987654321);
  assert.equal(a.enumerated, true);
  assert.equal(a.n_paths, 8, 'число путей = числу наблюдений');
  assert.equal(a.seed, 1);
  assert.deepEqual({ ...a, seed: 0 }, { ...b, seed: 0 });
});

test('TST-48 локальность: добавление/правка других событий не меняет u и выбранный лаг события дохода', () => {
  const extra = { cash_event_id: 'X-NEW', layer: 'planned', account_id: 'acc_main', date: parse_date('2026-10-20'), plan_date: parse_date('2026-10-20'), amount_minor: -1234, currency: 'EUR', kind: 'expense', tag: 'новое', status: 'expected', rule_id: 'X-NEW', stream_id: null, is_obligation: false, is_estimate: false };
  const ctx2 = { ...CTX, events: [...CTX.events.map((e) => (e.cash_event_id === 'R-GROC@2026-10-17' ? { ...e, amount_minor: -9999 } : e)), extra] };
  const income_date = (c, p) => mc.perturb_events(c, ['lag'], SEED, p).find((e) => e.cash_event_id === 'S-HOURLY@2026-11-05')?.date;
  for (let p = 0; p < 200; p++) assert.equal(income_date(ctx2, p), income_date(CTX, p), `путь ${p}`);
  // и вручную: лаг пути p = sample_lag(sorted obs, u01(seed, id|lag, p))
  for (let p = 0; p < 50; p++) {
    const expect = parse_date('2026-11-05') + mc.sample_lag(LAGS_SORTED, mc.u01(SEED, KEY, p));
    assert.equal(income_date(CTX, p), expect);
  }
});

test('TST-48 CRN: два сценария на одном seed сравниваются путь в путь — разность m_p ровно S, без шума выборки', () => {
  const purchase = { cash_event_id: 'buy', layer: 'hypothetical', account_id: 'acc_main', date: parse_date(D_BUY), plan_date: parse_date(D_BUY), amount_minor: -S_BUY, currency: 'EUR', kind: 'expense', tag: 'покупка', status: 'expected', is_obligation: false, is_estimate: false };
  const ctx_buy = { ...CTX, events: [...CTX.events, purchase] };
  for (const enumerate of [true, false]) {
    const base = mc.run_paths(CTX, 500, { kinds: ['lag'], from: D_BUY, enumerate }, SEED);
    const buy = mc.run_paths(ctx_buy, 500, { kinds: ['lag'], from: D_BUY, enumerate }, SEED);
    assert.equal(buy.m_free.length, base.m_free.length);
    for (let p = 0; p < base.m_free.length; p++) assert.equal(buy.m_free[p], base.m_free[p] - S_BUY, `путь ${p}: покупка снижает m_p ровно на S (инвариант 7)`);
    assert.deepEqual(mc.p_fail(base.m_free, S_BUY, B), mc.p_fail(buy.m_free, 0, B), 'p_fail(S) на базе = p_fail(0) со встроенной покупкой');
  }
});

// ── TST-49: восемь лагов (§9.15, TV-2…TV-6) ───────────────────────────────────────────────────────────────────────────

test('TST-49 восемь лагов: min free по лагу 0, 2, 3, 5, 6, 7, 9, 14 = 93500, 83500, 83500, 81000, 81000, 81000, 71000, 71000 (перебор)', () => {
  const P = mc.run_paths(CTX, 2000, { kinds: ['lag'], from: D_BUY }, SEED);
  assert.equal(P.enumerated, true);
  assert.equal(P.n_paths, 8);
  assert.equal(P.n_eff, 8);
  assert.equal(P.prior_used, false);
  assert.deepEqual(P.warnings, []);
  assert.deepEqual(P.m_free, [93500, 83500, 83500, 81000, 81000, 81000, 71000, 71000], 'пути идут по возрастанию лага');
  assert.deepEqual(P.m_free.map((m) => m - S_BUY), [63500, 53500, 53500, 51000, 51000, 51000, 41000, 41000]);
});

test('TST-49 p_fail = 2/8 (лаги 9 и 14); квантили минимумов P10 = 71000, P50 = 81000, P90 = 93500; индексы nearest-rank 0, 3, 7', () => {
  const P = mc.run_paths(CTX, 2000, { kinds: ['lag'], from: D_BUY }, SEED);
  assert.deepEqual(mc.p_fail(P.m_free, S_BUY, B), { k: 2, n: 8 });
  assert.deepEqual(mc.p_fail(P.m_free, 0, B), { k: 0, n: 8 }, 'без покупки буфер держится при любом лаге');
  const sorted = [...P.m_free].sort((a, b) => a - b);
  assert.deepEqual(sorted, [71000, 71000, 81000, 81000, 81000, 83500, 83500, 93500]);
  assert.deepEqual([10, 50, 90].map((q) => ceil_div(q * 8, 100) - 1), [0, 3, 7]);
  assert.deepEqual([10, 50, 90].map((q) => mc.nearest_rank(sorted, q)), [71000, 81000, 93500]);
  assert.deepEqual([10, 50, 90].map((a) => mc.q_alpha(P.m_free, a)), [71000, 81000, 93500]);
  // P90 при n = 8 — наибольшее из n (ceil(0,9·8) = 8 = n); P10 — наименьшее (ceil(0,1·8) = 1)
  assert.equal(ceil_div(90 * 8, 100), 8);
  assert.equal(ceil_div(10 * 8, 100), 1);
});

test('TST-49 допуск риска α: S_max = 21000 при α = 10 и 25, 31000 при α = 26, 43500 при α = 90; OK(25) — нет, OK(26) — да', () => {
  const P = mc.run_paths(CTX, 2000, { kinds: ['lag'], from: D_BUY }, SEED);
  assert.equal(mc.s_max_alpha(P.m_free, B, 10), 21000);
  assert.equal(mc.s_max_alpha(P.m_free, B, 25), 21000, 'равно S_max режима worse: наибольший лаг 14 = worse.income_delay_days');
  assert.equal(mc.s_max_alpha(P.m_free, B, 26), 31000);
  assert.equal(mc.s_max_alpha(P.m_free, B, 90), 43500, 'равно S_max режима plan');
  assert.equal(mc.ok_at_alpha(P.m_free, S_BUY, B, 25), false, '71000 − 30000 = 41000 < 50000');
  assert.equal(mc.ok_at_alpha(P.m_free, S_BUY, B, 26), true, '81000 − 30000 = 51000 ≥ 50000');
  // эквивалентность OK(α) ⇔ 100·k < α·n (инвариант 5) для всех α и набора S
  for (const S of [0, 1, 20999, 21000, 21001, 30000, 31000, 31001, 43500, 43501, 50000]) {
    const { k, n } = mc.p_fail(P.m_free, S, B);
    for (let alpha = 1; alpha <= 99; alpha++) {
      assert.equal(mc.ok_at_alpha(P.m_free, S, B, alpha), 100 * k < alpha * n, `S = ${S}, α = ${alpha}`);
    }
  }
  throws_code(() => mc.q_alpha(P.m_free, 0), 'E_SCHEMA');
  throws_code(() => mc.q_alpha(P.m_free, 100), 'E_SCHEMA');
  throws_code(() => mc.q_alpha(P.m_free, 12.5), 'E_SCHEMA');
});

test('TST-49 инварианты 5: p_fail(S) не убывает по S; s_max_alpha не убывает по α; S_max ≥ 0', () => {
  const P = mc.run_paths(CTX, 2000, { kinds: ['lag'], from: D_BUY }, SEED);
  let prev = -1;
  for (let S = 0; S <= 80000; S += 500) {
    const k = mc.p_fail(P.m_free, S, B).k;
    assert.ok(k >= prev, `S = ${S}`);
    prev = k;
  }
  let prev_s = -1;
  for (let a = 1; a <= 99; a++) {
    const s = mc.s_max_alpha(P.m_free, B, a);
    assert.ok(s >= prev_s && s >= 0, `α = ${a}`);
    prev_s = s;
  }
  assert.equal(mc.s_max_alpha([10, 20], 1000, 50), 0, 'квантиль ниже буфера → 0, не отрицательное');
});

test('TST-49 веер по дням (ALG-10 TV-3): close и trough P10/P50/P90 на 11-05, 11-14, 11-19', () => {
  const P = mc.run_paths(CTX, 2000, { kinds: ['lag'], from: D_BUY }, SEED);
  const at = (iso) => parse_date(iso) - A_G.as_of;
  // 2026-11-05: доход приходит только при лаге 0 → P90 close — наибольшее из 8
  assert.deepEqual(P.close_q[at('2026-11-05')], { p10: 205500, p50: 205500, p90: 484500 });
  assert.deepEqual(P.trough_q[at('2026-11-05')], { p10: 205500, p50: 205500, p90: 205500 });
  // 2026-11-14: P10 — лаг 14 (наименьшее из 8)
  assert.deepEqual(P.close_q[at('2026-11-14')], { p10: 183000, p50: 462000, p90: 462000 });
  assert.deepEqual(P.trough_q[at('2026-11-14')], { p10: 183000, p50: 462000, p90: 462000 });
  // 2026-11-19: в день прихода trough — до дохода (D-01)
  assert.deepEqual(P.close_q[at('2026-11-19')], { p10: 462000, p50: 462000, p90: 462000 });
  assert.deepEqual(P.trough_q[at('2026-11-19')], { p10: 183000, p50: 462000, p90: 462000 });
  // инвариант 3: P10 ≤ P50 ≤ P90 и trough ≤ close по каждому квантилю в каждый день
  assert.equal(P.close_q.length, 58);
  P.close_q.forEach((c, i) => {
    const t = P.trough_q[i];
    assert.ok(c.p10 <= c.p50 && c.p50 <= c.p90, `close день ${i}`);
    assert.ok(t.p10 <= t.p50 && t.p50 <= t.p90, `trough день ${i}`);
    assert.ok(t.p10 <= c.p10 && t.p50 <= c.p50 && t.p90 <= c.p90, `trough ≤ close, день ${i}`);
  });
});

test('TST-49 p_gap_any (TV-4): G-001 — 0 из 8; G-001-low — 0 из 8, но p_fail(S > 0) = 8 из 8; G-001-gap — 8 из 8, разрыв 2026-10-26 при любом лаге', () => {
  const lags_enum = LAGS_SORTED;
  // G-001: минимумы trough по лагам 205500 (0), 195500 (2, 3), 193000 (5–7), 183000 (9, 14)
  const P = mc.run_paths(CTX, 2000, { kinds: ['lag'] }, SEED);
  assert.deepEqual(P.m_trough, [205500, 195500, 195500, 193000, 193000, 193000, 183000, 183000]);
  assert.deepEqual(P.p_gap_any, { k: 0, n: 8 });
  assert.equal(P.p_gap_any_pm, 0);
  // G-001-low (opening = 220000): 25500, 15500, 13000, 3000; свободные деньги отрицательны
  const low = ctx_of(LOW).ctx;
  const PL = mc.run_paths(low, 2000, { kinds: ['lag'] }, SEED);
  assert.deepEqual(PL.m_trough, [25500, 15500, 15500, 13000, 13000, 13000, 3000, 3000]);
  assert.deepEqual(PL.p_gap_any, { k: 0, n: 8 });
  assert.deepEqual(mc.p_fail(PL.m_free, 1, B), { k: 8, n: 8 });
  assert.ok(PL.m_free.every((m) => m < B), 'буфер не держится даже без покупки');
  // G-001-gap (opening = 100000): разрыв при каждом лаге, от −94500 до −117000
  const gap = ctx_of(GAP).ctx;
  const PG = mc.run_paths(gap, 2000, { kinds: ['lag'] }, SEED);
  assert.deepEqual(PG.m_trough, [-94500, -104500, -104500, -107000, -107000, -107000, -117000, -117000]);
  assert.deepEqual(PG.p_gap_any, { k: 8, n: 8 });
  assert.equal(PG.p_gap_any_pm, 1000);
  lags_enum.forEach((lag, p) => {
    const s = gap.evaluate(mc.perturb_events(gap, ['lag'], SEED, p, lag));
    assert.equal(format_date(A_G.as_of + s.trough.findIndex((x) => x < 0)), '2026-10-26', `лаг ${lag}: первая дата разрыва`);
  });
});

test('TST-49 p_gap_any — доля путей с разрывом, а не максимум дневных вероятностей (два пути уходят в минус в разные дни)', () => {
  // два дохода-лага: путь 0 — разрыв на 3-й день, путь 1 — на 7-й; дневные вероятности по 50 %, итог — 100 %
  const ev = (id, date, amount, extra = {}) => ({ cash_event_id: id, layer: 'planned', account_id: 'a', date, plan_date: date, amount_minor: amount, currency: 'EUR', kind: amount > 0 ? 'income' : 'expense', status: 'expected', rule_id: id, stream_id: null, ...extra });
  const events = [ev('INC', 100, 500, { stream_id: 'S1', rule_id: null }), ev('E3', 103, -900), ev('E7', 107, -900)];
  const ctx = {
    as_of: 100, horizon_end: 110, decision_currency: 'EUR', params: { 'worse.income_delay_days': 14 }, events,
    lag_obs: { S1: [0, 5] },
    evaluate: (evs) => { const s = project(evs, 0, 100, 110); return { close: s.close, trough: s.trough, free: s.trough }; },
  };
  const P = mc.run_paths(ctx, 100, { kinds: ['lag'] }, 1);
  assert.equal(P.enumerated, true);
  assert.equal(P.n_paths, 2);
  // лаг 0: баланс 500 → E3: −400 (разрыв в день 3); лаг 5: доход на 5-й день, разрыв уже в день 3 и позже — оба пути
  assert.deepEqual(P.p_gap_any, { k: 2, n: 2 });
  const day_prob = (i) => P.trough_q[i].p10 < 0 ? 1 : 0;
  assert.ok(P.p_gap_any.k / P.p_gap_any.n >= day_prob(3));
  assert.ok(P.p_gap_any_pm <= 1000 && P.p_gap_any_pm >= 0);
});

test('TST-49 подача (ALG-10 TV-5, REQ-055): «в k из n» при n < 20, интервал Уилсона при n ≥ 20, small_sample и no_history', () => {
  const enum_paths = (n) => ({ enumerated: true, n_paths: n, n_eff: n });
  // 2 из 8, 1 из 8 — счётом; интервал 7,1–59,1 % и 2,2–47,1 % не показывается
  assert.deepEqual(mc.present_probability(2, enum_paths(8)), { kind: 'count', k: 2, n: 8 });
  assert.deepEqual(mc.present_probability(1, enum_paths(8)), { kind: 'count', k: 1, n: 8 });
  assert.deepEqual(wilson(2, 8), { lo_pm: 71, hi_pm: 591 });
  assert.deepEqual(wilson(1, 8), { lo_pm: 22, hi_pm: 471 });
  // 5 из 40: p_pm = 125 → «≈ 12,5 % (95 %: 5,5–26,1 %)»
  assert.deepEqual(mc.present_probability(5, enum_paths(40)), { kind: 'interval', p_pm: 125, lo_pm: 55, hi_pm: 261, n: 40 });
  // 3 из 24: «≈ 12,5 % (95 %: 4,3–31,0 %)»
  assert.deepEqual(mc.present_probability(3, enum_paths(24)), { kind: 'interval', p_pm: 125, lo_pm: 43, hi_pm: 310, n: 24 });
  // 0 из 20: «≈ 0 % (95 %: 0–16,1 %)»
  assert.deepEqual(mc.present_probability(0, enum_paths(20)), { kind: 'interval', p_pm: 0, lo_pm: 0, hi_pm: 161, n: 20 });
  // 9 из 200 (ALG-13 TV-4): 2,4–8,3 %
  assert.deepEqual(wilson(9, 200), { lo_pm: 24, hi_pm: 83 });
  // выборка: k = 500 из 2000 путей при n_eff = 12 → процент не показывается
  assert.deepEqual(mc.present_probability(500, { enumerated: false, n_paths: 2000, n_eff: 12 }), { kind: 'none', reason: 'small_sample', n: 12 });
  // выборка при n_eff = 40: k пересчитывается на n_eff — 250 из 2000 → 5 из 40
  assert.deepEqual(mc.present_probability(250, { enumerated: false, n_paths: 2000, n_eff: 40 }), { kind: 'interval', p_pm: 125, lo_pm: 55, hi_pm: 261, n: 40 });
  // нет наблюдений (prior / диапазон часов): вероятность не показывается
  assert.deepEqual(mc.present_probability(100, { enumerated: false, n_paths: 2000, n_eff: 0 }), { kind: 'none', reason: 'no_history' });
  assert.deepEqual(mc.present_probability(100, { enumerated: false, n_paths: 2000, n_eff: null }), { kind: 'none', reason: 'no_history' });
});

test('TST-49 подача на реальных путях G-001: перебор 8 лагов → «в 2 из 8 прошлых случаев»', () => {
  const P = mc.run_paths(CTX, 2000, { kinds: ['lag'], from: D_BUY }, SEED);
  const f = mc.p_fail(P.m_free, S_BUY, B);
  assert.deepEqual(mc.present_probability(f.k, P), { kind: 'count', k: 2, n: 8 });
});

test('TST-49 выборка (TV-6): n_paths = 2000, seed 68106871 → p_fail = 498 из 2000; seed 477279656 → 493; P10/P50/P90 те же', () => {
  const run = (seed) => mc.run_paths(CTX, 2000, { kinds: ['lag'], from: D_BUY, enumerate: false }, seed);
  const a = run(68106871);
  assert.equal(a.enumerated, false);
  assert.equal(a.n_paths, 2000);
  assert.equal(a.n_eff, 8, 'ошибка выборки не равна неопределённости модели: n_eff — число наблюдений');
  assert.deepEqual(mc.p_fail(a.m_free, S_BUY, B), { k: 498, n: 2000 });
  assert.deepEqual([10, 50, 90].map((q) => mc.q_alpha(a.m_free, q)), [71000, 81000, 93500]);
  const b = run(477279656);
  assert.deepEqual(mc.p_fail(b.m_free, S_BUY, B), { k: 493, n: 2000 });
  assert.deepEqual([10, 50, 90].map((q) => mc.q_alpha(b.m_free, q)), [71000, 81000, 93500]);
  // точное значение 25 %, σ ≈ 0,97 п.п.: оба результата в пределах 3σ
  for (const k of [498, 493]) assert.ok(Math.abs(k / 2000 - 0.25) < 3 * 0.0097);
  // выборка по n_eff = 8 < 20: процент не показывается (small_sample), а не «24,9 %»
  assert.deepEqual(mc.present_probability(498, a), { kind: 'none', reason: 'small_sample', n: 8 });
});

test('TST-49 инвариант 6: при возмущении только лага (≤ worse.income_delay_days) каждый путь не хуже режима worse; min m_free ≥ min free worse', () => {
  const P = mc.run_paths(CTX, 2000, { kinds: ['lag'] }, SEED);
  const worse_min = Math.min(...A_G.series.worse.free);
  assert.equal(worse_min, 71000);
  assert.ok(P.m_free.every((m) => m >= worse_min));
  assert.equal(Math.min(...P.m_free), worse_min, 'наибольший лаг 14 совпадает с worse');
  for (let p = 0; p < 8; p++) {
    const s = CTX.evaluate(mc.perturb_events(CTX, ['lag'], SEED, p, LAGS_SORTED[p]));
    s.trough.forEach((t, i) => assert.ok(t >= A_G.series.worse.trough[i], `путь ${p}, день ${i}: trough ≥ trough_worse`));
    s.free.forEach((f, i) => assert.ok(f >= A_G.series.worse.free[i], `путь ${p}, день ${i}: free ≥ free_worse`));
  }
});

test('TST-49 лаг 0 и лаг 14 совпадают с режимами plan и worse движка (сверка с analyze)', () => {
  const at = (lag) => CTX.evaluate(mc.perturb_events(CTX, ['lag'], SEED, 0, lag));
  assert.deepEqual(at(0).free, A_G.series.plan.free);
  assert.deepEqual(at(0).close, A_G.series.plan.close);
  assert.deepEqual(at(14).free, A_G.series.worse.free);
  assert.deepEqual(at(14).trough, A_G.series.worse.trough);
});

// ── TST-48: источники возмущений и граничные случаи ───────────────────────────────────────────────────────────────────

const mkev = (id, date, amount, extra = {}) => ({
  cash_event_id: id, layer: 'planned', account_id: 'a', date, plan_date: date, amount_minor: amount, currency: 'EUR',
  kind: amount > 0 ? 'income' : 'expense', status: 'expected', rule_id: id, stream_id: null, is_obligation: false, is_estimate: false, ...extra,
});
const stub = (events, extra = {}) => ({
  as_of: 100, horizon_end: 130, decision_currency: 'EUR', params: { 'worse.income_delay_days': 14 }, events,
  evaluate: (evs) => { const s = project(evs, 1000, 100, 130); return { close: s.close, trough: s.trough, free: s.trough }; },
  ...extra,
});

test('TST-48 нет наблюдений: prior [0…worse.income_delay_days], prior_used, W_NO_HISTORY, n_eff = 0, вероятность не показывается', () => {
  const inc = mkev('INC', 105, 500, { stream_id: 'S1', rule_id: null });
  const ctx = stub([inc], { lag_obs: {} });
  const pool = mc.lag_pool(ctx, inc);
  assert.deepEqual(pool.obs, Array.from({ length: 15 }, (_, i) => i));
  assert.equal(pool.n_obs, 0);
  assert.equal(pool.prior, true);
  assert.deepEqual(pool.warnings.map((w) => w.code), ['W_NO_HISTORY']);
  const P = mc.run_paths(ctx, 400, { kinds: ['lag'] }, 5);
  assert.equal(P.enumerated, false, 'prior — не наблюдения: перебора нет');
  assert.equal(P.n_paths, 400);
  assert.equal(P.prior_used, true);
  assert.equal(P.n_eff, 0);
  assert.deepEqual(P.warnings, [{ code: 'W_NO_HISTORY', flow_key: 'S1' }]);
  assert.deepEqual(mc.present_probability(100, P), { kind: 'none', reason: 'no_history' });
  // даты выплат — внутри prior: 105…119
  for (let p = 0; p < 50; p++) {
    const d = mc.perturb_events(ctx, ['lag'], 5, p)[0].date;
    assert.ok(d >= 105 && d <= 119);
  }
});

test('TST-48 n_obs = 1: все пути одинаковы, n_eff = 1; одно наблюдение — перебор из 1 пути', () => {
  const inc = mkev('INC', 105, 500, { stream_id: 'S1', rule_id: null });
  const P = mc.run_paths(stub([inc], { lag_obs: { S1: [4] } }), 1000, { kinds: ['lag'] }, 9);
  assert.equal(P.enumerated, true);
  assert.equal(P.n_paths, 1);
  assert.equal(P.n_eff, 1);
  assert.deepEqual(P.close_q[0], { p10: 1000, p50: 1000, p90: 1000 });
  assert.deepEqual(P.close_q[9], { p10: 1500, p50: 1500, p90: 1500 }, 'доход 105 + 4 = 109');
  assert.deepEqual(mc.present_probability(0, P), { kind: 'count', k: 0, n: 1 });
});

test('TST-48 условный лаг (IDEA-03): просроченный платёж — лаги меньше уже прошедших дней отбрасываются; дольше истории — доход вне горизонта, W_LAG_BEYOND_HISTORY', () => {
  // доход ждали 6 дней (план 94, as_of 100): допустимы лаги ≥ 6
  const inc = mkev('INC', 94, 500, { stream_id: 'S1', rule_id: null, status: 'overdue' });
  const ctx = stub([inc], { lag_obs: { S1: [9, 0, 3, 7, 5, 14, 6, 2] } });
  const pool = mc.lag_pool(ctx, inc);
  assert.deepEqual(pool.obs, [6, 7, 9, 14]);
  assert.equal(pool.n_obs, 8);
  assert.deepEqual(pool.warnings, []);
  assert.deepEqual(mc.run_paths(ctx, 100, { kinds: ['lag'] }, 1).n_paths, 4, 'перебор по условным наблюдениям');
  // просрочка 20 дней — дольше любого виденного лага (≤ 14)
  const old = mkev('OLD', 80, 500, { stream_id: 'S1', rule_id: null, status: 'overdue' });
  const ctx2 = stub([old], { lag_obs: { S1: [0, 3, 7, 5, 14, 6, 2, 9] } });
  const p2 = mc.lag_pool(ctx2, old);
  assert.deepEqual(p2.obs, [Infinity]);
  assert.deepEqual(p2.warnings, [{ code: 'W_LAG_BEYOND_HISTORY', flow_key: 'S1' }]);
  assert.deepEqual(mc.perturb_events(ctx2, ['lag'], 1, 0), [], 'доход из пути выпал');
  const P2 = mc.run_paths(ctx2, 100, { kinds: ['lag'] }, 1);
  assert.equal(P2.enumerated, false, 'перебор по [∞] не запускается');
  assert.deepEqual(P2.close_q[30], { p10: 1000, p50: 1000, p90: 1000 }, 'дохода нет ни на одном пути');
  assert.ok(P2.warnings.some((w) => w.code === 'W_LAG_BEYOND_HISTORY'));
});

test('TST-48 доход после horizon_end не входит в путь; несколько доходов — выборка с независимыми лагами по ключам', () => {
  const late = mkev('LATE', 128, 700, { stream_id: 'S1', rule_id: null });
  const ctx = stub([late], { lag_obs: { S1: [0, 1, 5, 9] } });
  const lens = new Set();
  for (let p = 0; p < 40; p++) lens.add(mc.perturb_events(ctx, ['lag'], 1, p).length);
  assert.deepEqual([...lens].sort(), [0, 1], 'лаг ≥ 3 выводит доход за горизонт 130');
  const a = mkev('A', 105, 500, { stream_id: 'SA', rule_id: null });
  const b = mkev('B', 105, 500, { stream_id: 'SB', rule_id: null });
  const ctx2 = stub([a, b], { lag_obs: { SA: [0, 3, 8], SB: [1, 2, 6, 9] } });
  assert.equal(mc.plan_paths(ctx2, ['lag'], 700).enum_lags, null);
  const P = mc.run_paths(ctx2, 700, { kinds: ['lag'] }, 3);
  assert.equal(P.enumerated, false);
  assert.equal(P.n_paths, 700);
  assert.equal(P.n_eff, 3, 'n_eff — минимум n_obs по источникам');
  // независимость: лаги A и B на одном пути берутся из u(seed, 'A|lag', p) и u(seed, 'B|lag', p)
  for (let p = 0; p < 30; p++) {
    const evs = mc.perturb_events(ctx2, ['lag'], 3, p);
    assert.equal(evs.find((e) => e.cash_event_id === 'A').date, 105 + mc.sample_lag([0, 3, 8], mc.u01(3, 'A|lag', p)));
    assert.equal(evs.find((e) => e.cash_event_id === 'B').date, 105 + mc.sample_lag([1, 2, 6, 9], mc.u01(3, 'B|lag', p)));
  }
});

test('TST-48 plan_paths: перебор только для kinds = [lag], одного дохода, ≤ 64 наблюдений, с историей', () => {
  const inc = mkev('INC', 105, 500, { stream_id: 'S1', rule_id: null });
  const obs = (n) => Array.from({ length: n }, (_, i) => i % 15);
  const mk = (n, extra) => stub([inc], { lag_obs: { S1: obs(n) }, ...extra });
  assert.equal(mc.plan_paths(mk(64), ['lag'], 2000).n, 64);
  assert.deepEqual(mc.plan_paths(mk(65), ['lag'], 2000), { n: 2000, enum_lags: null });
  assert.deepEqual(mc.plan_paths(mk(8), ['lag', 'hours'], 2000), { n: 2000, enum_lags: null });
  assert.deepEqual(mc.plan_paths(mk(0), ['lag'], 2000), { n: 2000, enum_lags: null });
  assert.equal(mc.plan_paths(mk(8), ['lag'], 2000).n, 8);
});

test('TST-48 hours: треугольное распределение в [min, max], мода — ожидаемая сумма; без разброса или с модой вне носителя — не возмущается', () => {
  const inc = mkev('INC', 105, 279000, { stream_id: 'S1', rule_id: null, amount_min_minor: 240000, amount_max_minor: 330000 });
  const ctx = stub([inc]);
  const vals = [];
  for (let p = 0; p < 4000; p++) vals.push(mc.perturb_events(ctx, ['hours'], 11, p)[0].amount_minor);
  assert.ok(vals.every((v) => v >= 240000 && v <= 330000));
  assert.ok(new Set(vals).size > 500, 'значения разные');
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  // среднее треугольного: (min + mode + max) / 3 = 283000
  assert.ok(Math.abs(mean - 283000) < 1500, `среднее ${mean}`);
  assert.deepEqual(vals.map((v) => v), vals.map((_, p) => mc.perturb_events(ctx, ['hours'], 11, p)[0].amount_minor), 'детерминизм');
  // hours данных не использует: n_eff не зависит от него
  const P = mc.run_paths(ctx, 300, { kinds: ['hours'] }, 11);
  assert.equal(P.n_eff, null, 'C-048: hours в n_eff не входит');
  assert.equal(P.enumerated, false);
  assert.deepEqual(mc.present_probability(10, P), { kind: 'none', reason: 'no_history' });
  // без разброса
  const flat = mkev('F', 105, 100, { stream_id: 'S1', rule_id: null, amount_min_minor: 100, amount_max_minor: 100 });
  assert.equal(mc.perturb_events(stub([flat]), ['hours'], 1, 0)[0].amount_minor, 100);
  // мода вне носителя
  const out = mkev('O', 105, 400, { stream_id: 'S1', rule_id: null, amount_min_minor: 100, amount_max_minor: 300 });
  assert.equal(mc.perturb_events(stub([out]), ['hours'], 1, 0)[0].amount_minor, 400);
  // расходы и не-плановые доходы не возмущаются
  const exp = mkev('X', 105, -400, { amount_min_minor: 100, amount_max_minor: 900 });
  assert.equal(mc.perturb_events(stub([exp]), ['hours'], 1, 0)[0].amount_minor, -400);
});

test('TST-48 ratio: оценочная трата умножается на бутстрап отношения факт/план (bp); обязательства не меняются', () => {
  const groc = mkev('G1', 105, -10000, { rule_id: 'R-GROC', is_estimate: true });
  const rent = mkev('R1', 106, -90000, { rule_id: 'R-RENT', is_obligation: true });
  const ctx = stub([groc, rent], { ratio_obs_bp: { 'R-GROC': [8000, 10000, 12000, 9500] } });
  for (let p = 0; p < 40; p++) {
    const out = mc.perturb_events(ctx, ['ratio'], 2, p);
    const g = out.find((e) => e.cash_event_id === 'G1');
    const r = mc.sample_lag([8000, 9500, 10000, 12000], mc.u01(2, 'G1|ratio', p));
    assert.equal(g.amount_minor, -Math.round((10000 * r) / 10000), 'сумма × r / 10000');
    assert.equal(out.find((e) => e.cash_event_id === 'R1').amount_minor, -90000);
  }
  // нет наблюдений ratio — не возмущается
  assert.equal(mc.perturb_events(stub([groc]), ['ratio'], 2, 0)[0].amount_minor, -10000);
  const P = mc.run_paths(ctx, 100, { kinds: ['ratio'] }, 2);
  assert.equal(P.n_eff, 4);
  assert.equal(P.enumerated, false);
});

test('TST-48 fx: один сдвиг курса на путь и валюту; сдвиг ≤ −10000 bp обнуляет сумму (max(0, ·))', () => {
  const usd1 = mkev('U1', 105, 1000, { stream_id: 'S1', rule_id: null, orig_currency: 'USD' });
  const usd2 = mkev('U2', 108, 2000, { stream_id: 'S2', rule_id: null, orig_currency: 'USD' });
  const eur = mkev('E1', 110, 3000, { stream_id: 'S3', rule_id: null, orig_currency: 'EUR' });
  const ctx = stub([usd1, usd2, eur], { fx_obs_bp: { USD: [-500, 0, 300, 800] } });
  for (let p = 0; p < 40; p++) {
    const out = mc.perturb_events(ctx, ['fx'], 4, p);
    const delta = mc.sample_lag([-500, 0, 300, 800], mc.u01(4, 'fx:USD', p));
    assert.equal(out.find((e) => e.cash_event_id === 'U1').amount_minor, Math.round((1000 * (10000 + delta)) / 10000));
    assert.equal(out.find((e) => e.cash_event_id === 'U2').amount_minor, Math.round((2000 * (10000 + delta)) / 10000), 'тот же сдвиг для той же валюты');
    assert.equal(out.find((e) => e.cash_event_id === 'E1').amount_minor, 3000, 'валюта решения не сдвигается');
  }
  const crash = stub([usd1], { fx_obs_bp: { USD: [-12000] } });
  assert.equal(mc.perturb_events(crash, ['fx'], 4, 0)[0].amount_minor, 0);
  assert.equal(mc.perturb_events(stub([usd1]), ['fx'], 4, 0)[0].amount_minor, 1000, 'нет истории курса — не возмущается');
  const P = mc.run_paths(ctx, 100, { kinds: ['fx'] }, 4);
  assert.equal(P.n_eff, 4);
});

test('TST-48 дата покупки за горизонтом: m_free = null («в горизонте нет»); малое число путей — флаг coarse; ошибки аргументов → E_SCHEMA', () => {
  const P = mc.run_paths(CTX, 2000, { kinds: ['lag'], from: '2026-12-31' }, SEED);
  assert.equal(P.m_free, null);
  const small = mc.run_paths(CTX, 50, { kinds: ['lag'], enumerate: false }, SEED);
  assert.equal(small.coarse, true);
  assert.equal(mc.run_paths(CTX, 2000, { kinds: ['lag'] }, SEED).coarse, false, 'перебор — не выборка');
  throws_code(() => mc.run_paths({ ...CTX, evaluate: undefined }, 10, { kinds: ['lag'] }, 1), 'E_SCHEMA');
  throws_code(() => mc.run_paths(CTX, 0, { kinds: ['lag'] }, 1), 'E_SCHEMA');
  throws_code(() => mc.run_paths(CTX, 10, { kinds: ['weather'] }, 1), 'E_SCHEMA');
  throws_code(() => mc.run_paths({ ...CTX, evaluate: () => ({ close: [], trough: [], free: [] }) }, 10, { kinds: ['lag'] }, 1), 'E_SCHEMA');
});

test('TST-33 seed из inputs_hash расчёта: перестановка записей рабочей области не меняет seed и Paths', () => {
  const shuffled = JSON.parse(JSON.stringify(G));
  for (const k of ['facts', 'rules', 'anchors', 'reserves', 'accounts']) shuffled[k] = [...shuffled[k]].reverse();
  const A2 = analyze(shuffled, { as_of: '2026-10-04' });
  assert.equal(A2.inputs_hash, A_G.inputs_hash);
  const seed1 = mc.make_seed(A_G.engine_version, A_G.inputs_hash, 0);
  const seed2 = mc.make_seed(A2.engine_version, A2.inputs_hash, 0);
  assert.equal(A_G.engine_version, ENGINE_VERSION);
  assert.equal(seed1, seed2);
  const ctx2 = mc.mc_context(shuffled, A2, { lag_obs: { 'S-HOURLY': LAGS } });
  const a = JSON.stringify(mc.run_paths(CTX, 500, { kinds: ['lag', 'hours'], from: D_BUY }, seed1));
  const b = JSON.stringify(mc.run_paths(ctx2, 500, { kinds: ['lag', 'hours'], from: D_BUY }, seed2));
  assert.equal(a, b);
  assert.notEqual(mc.make_seed(A_G.engine_version, A_G.inputs_hash, 7), seed1, 'user_seed меняет seed');
  // другие входы — другой inputs_hash и другой seed
  const other = analyze(LOW, { as_of: '2026-10-04' });
  assert.notEqual(mc.make_seed(other.engine_version, other.inputs_hash, 0), seed1);
});

test('TST-48 производительность (TST-54, часть): 2000 путей на G-001 с четырьмя возмущениями — меньше 5 секунд', () => {
  const t0 = Date.now();
  const P = mc.run_paths(CTX, 2000, { kinds: ['lag', 'hours', 'ratio', 'fx'], from: D_BUY }, SEED);
  const ms = Date.now() - t0;
  assert.equal(P.n_paths, 2000);
  assert.ok(ms < 5000, `${ms} мс`);
});

// ── TST-50: калибровка малых выборок (ALG-13) ─────────────────────────────────────────────────────────────────────────

test('TST-50 восемь лагов: p50 = 5, p80 = 9, p90 = 14 («наибольшее из 8»); EWMA 6 261 581 → 6; shrink_to_prior(5, 8, 7, 3) = 6; expected_ready = false', () => {
  const cal = flow_calibration(LAGS, []);
  assert.equal(cal.n, 8);
  assert.equal(cal.p50, 5);
  assert.equal(cal.p80, 9);
  assert.equal(cal.p90, 14);
  assert.equal(cal.p90_label, 'наибольшее из 8');
  assert.equal(ewma(LAGS, 3000), 6261581);
  assert.equal(cal.ewma_days, 6);
  assert.equal(shrink_to_prior(5, 8, 7, 3), 6, 'round_div(8·5 + 3·7, 11) = round_div(61, 11)');
  assert.equal(cal.shrunk_days, 6);
  assert.equal(cal.expected_ready, false, 'n = 8 < 10: режим expected не включается');
  assert.equal(expected_lag(cal), null);
  // индексы nearest-rank из канона
  assert.deepEqual([50, 80, 90].map((q) => ceil_div(q * 8, 100) - 1), [3, 6, 7]);
});

test('TST-50 новый клиент (лаги [10, 12], n = 2): «медиана» — nearest-rank p50 = 10, shrink_to_prior = 8 (прежнее 9 — по среднему 11, C-052)', () => {
  const cal = flow_calibration([10, 12], []);
  assert.equal(cal.p50, 10);
  assert.equal(shrink_to_prior(cal.p50, 2, 7, 3), 8, 'round_div(2·10 + 3·7, 5) = round_div(41, 5)');
  assert.equal(cal.shrunk_days, 8);
  assert.equal(shrink_to_prior(null, 0, 7, 3), 7, 'n = 0 → prior');
  // сжатие лежит между медианой и prior
  for (let n = 1; n <= 30; n++) {
    const s = shrink_to_prior(2, n, 12, 3);
    assert.ok(s >= 2 && s <= 12);
  }
});

test('TST-50 при n = 10 (лаги 4 и 8 добавлены) p50 = 5 и режим expected включается: доход 2026-11-05 приходит 11-10', () => {
  const lags10 = [...LAGS, 4, 8];
  assert.deepEqual([...lags10].sort((a, b) => a - b), [0, 2, 3, 4, 5, 6, 7, 8, 9, 14]);
  const cal = flow_calibration(lags10, []);
  assert.equal(cal.n, 10);
  assert.equal(cal.p50, 5, 'индекс ceil_div(500, 100) − 1 = 4');
  assert.equal(cal.expected_ready, true);
  assert.equal(expected_lag(cal), 5);
  assert.equal(format_date(parse_date('2026-11-05') + expected_lag(cal)), '2026-11-10');
});

test('TST-50 интервал Уилсона (ALG-13 TV-4): 1/8 22…471, 2/8 71…591, 3/24 43…310, 5/40 55…261, 0/20 0…161, 9/200 24…83; границы в ‰ к ближайшему', () => {
  const table = [[1, 8, 22, 471], [2, 8, 71, 591], [3, 24, 43, 310], [5, 40, 55, 261], [0, 20, 0, 161], [9, 200, 24, 83]];
  for (const [k, n, lo, hi] of table) assert.deepEqual(wilson(k, n), { lo_pm: lo, hi_pm: hi }, `${k}/${n}`);
  // инвариант 7: lo ≤ round(1000·k/n) ≤ hi; ширина убывает с n при фиксированной доле
  for (const [k, n] of [[1, 8], [2, 8], [3, 24], [5, 40], [0, 20], [9, 200], [8, 8], [0, 1]]) {
    const w = wilson(k, n);
    const p = Math.floor((1000 * k) / n + 0.5);
    assert.ok(w.lo_pm <= p && p <= w.hi_pm, `${k}/${n}`);
  }
  assert.ok(wilson(25, 200).hi_pm - wilson(25, 200).lo_pm < wilson(5, 40).hi_pm - wilson(5, 40).lo_pm);
  throws_code(() => wilson(9, 8), 'E_SCHEMA');
  throws_code(() => wilson(1, 0), 'E_SCHEMA');
});
