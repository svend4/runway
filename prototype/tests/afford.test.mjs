// afford.test.mjs — Q3 «могу ли я это купить?» и «можно потратить» (ALG-04, ALG-11): TST-04 (вердикты по сумме), TST-05 (максимум и ранняя дата),
// TST-06 (safe-to-spend), TST-08 (G-001-low: NO из-за резервов), TST-30 (часть: дробление покупки по частям), TST-35 (часть: монотонность вердикта по S,
// S_max_worse ≤ S_max_plan, границы вердикта), TST-39 (S_max(as_of) = STS(horizon_end); без резервов free = trough), оракул «сценарий add_purchase»
// (TST-53, часть) и инвариант разложения Σ v = min_free − B. Ожидаемые числа — из design-brief §9.6–§9.9 и ALG-04/ALG-11 ДОСЛОВНО.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { parse_date, add_months, format_date } from '../engine/dates.mjs';
import { installment_parts } from '../engine/debt.mjs';
import { narrowest_point, argmin_first } from '../engine/timeline.mjs';
import {
  suffix_min, gate, normalize_parts, verdict_of, binding_events, check_purchase, max_amount, earliest_date, safe_to_spend,
  sts_breakdown, default_sts_horizon,
} from '../engine/afford.mjs';
import { analyze } from '../engine/index.mjs';
import { make_rng, throws_code } from './helpers.mjs';

const DATA = new URL('../data/', import.meta.url);
const load = (name) => JSON.parse(fs.readFileSync(new URL(name, DATA), 'utf8'));
const G = load('g001.json');
const LOW = load('g001-low.json');
const GAP = load('g001-gap.json');
const LATE = load('g001-late.json');
const iso = (s) => parse_date(s);
const run = (ws, extra = {}) => analyze(ws, { as_of: ws.as_of, ...extra });
const buy = (S, date = '2026-10-12') => ({ currency: 'EUR', parts: [{ date, amount_minor: S }] });
const RANK = { OK: 0, FRAGILE: 1, TIGHT: 2, NO: 3 };
const min_of = (xs) => xs.reduce((a, b) => (b < a ? b : a));
const AG = run(G);

// ── вспомогательные функции ────────────────────────────────────────────────────────────────────────────────────────────

test('TST-35 suffix_min: M[i] = min(a[i..N−1]), не убывает; пустой и одноэлементный ряды', () => {
  assert.deepEqual(suffix_min([100, 40, 120, 120]), [40, 40, 120, 120]);
  assert.deepEqual(suffix_min([5]), [5]);
  assert.deepEqual(suffix_min([]), []);
  assert.deepEqual(suffix_min([3, -2, 7, -2, 9]), [-2, -2, -2, -2, 9]);
  const rng = make_rng(3503);
  for (let c = 0; c < 200; c++) {
    const a = Array.from({ length: rng.int(1, 40) }, () => rng.int(-500, 500));
    const M = suffix_min(a);
    for (let i = 0; i < a.length; i++) assert.equal(M[i], min_of(a.slice(i)));
    for (let i = 1; i < M.length; i++) assert.ok(M[i - 1] <= M[i]);
  }
});

test('TST-04 verdict_of: границы NO (< 0), TIGHT (< B), FRAGILE (worse < B при plan ≥ B), OK; B = 0 — TIGHT недостижим', () => {
  assert.equal(verdict_of(-1, 1000, 50), 'NO');
  assert.equal(verdict_of(0, 1000, 50), 'TIGHT');
  assert.equal(verdict_of(49, 1000, 50), 'TIGHT');
  assert.equal(verdict_of(50, 49, 50), 'FRAGILE');
  assert.equal(verdict_of(50, 50, 50), 'OK');
  assert.equal(verdict_of(500, -7, 50), 'FRAGILE');
  for (let p = -3; p <= 3; p++) for (let w = -3; w <= p; w++) assert.notEqual(verdict_of(p, w, 0), 'TIGHT', 'при B = 0 вердикта TIGHT нет');
});

// ── TST-04: вердикты по сумме ──────────────────────────────────────────────────────────────────────────────────────────

test('TST-04 G-001: дорожка 300,00 € на 2026-10-12 при B = 500,00 € → FRAGILE; m_after 63500 · 11-01 / 41000 · 11-14; margin +13500 / −9000; delta 30000; нет cash_gap', () => {
  const r = check_purchase(AG, buy(30000), 50000);
  assert.equal(r.kind, 'ok');
  assert.equal(r.verdict, 'FRAGILE'); // G-001.q3.treadmill.verdict
  assert.deepEqual(r.by_mode.plan, { m_after: 63500, at: iso('2026-11-01'), margin: 13500, delta: 30000, cash_gap: false }); // G-001.q3.treadmill.m_after.plan
  assert.deepEqual(r.by_mode.worse, { m_after: 41000, at: iso('2026-11-14'), margin: -9000, delta: 30000, cash_gap: false }); // …worse
  assert.deepEqual(r.flags, { worse_gap: false, cash_gap: false, baseline_below_buffer: false });
  assert.equal(r.buffer_minor, 50000);
  assert.deepEqual(r.culprit_event_ids, ['S-HOURLY@2026-11-05'], 'опорное событие — задержанный доход S-HOURLY (11-05 → 11-19)');
  assert.equal(r.beyond_horizon_minor, 0);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.s_max, { plan: 43500, worse: 21000 });
  assert.deepEqual(r.earliest, { plan: iso('2026-10-04'), worse: iso('2026-11-20') });
});

test('TST-04 G-001: физический минимум после покупки (по сценарию add_purchase): 175500 · 10-31 (plan) и 153000 · 11-14 (worse); cash_gap нет', () => {
  const sc = run(G, { scenario_id: 'scn-treadmill' });
  assert.deepEqual(narrowest_point(sc.series.plan, sc.as_of, sc.horizon_end), { date: iso('2026-10-31'), amount_minor: 175500 });
  assert.deepEqual(narrowest_point(sc.series.worse, sc.as_of, sc.horizon_end), { date: iso('2026-11-14'), amount_minor: 153000 });
});

/** Таблица §9.6 и ALG-04 TV-2: [S, m_after plan, m_after worse, вердикт]. */
const BY_S = [
  [15000, 78500, 56000, 'OK'], [21000, 72500, 50000, 'OK'], [21001, 72499, 49999, 'FRAGILE'], [30000, 63500, 41000, 'FRAGILE'],
  [43500, 50000, 27500, 'FRAGILE'], [43501, 49999, 27499, 'TIGHT'], [60000, 33500, 11000, 'TIGHT'], [93500, 0, -22500, 'TIGHT'],
  [93501, -1, -22501, 'NO'], [120000, -26500, -49000, 'NO'],
];

test('TST-04 G-001: m_after plan / worse и вердикт по сумме S (21000 → OK, граница margin_worse = 0; 43500 → FRAGILE, margin_plan = 0; 93500 → TIGHT, worse_gap; 93501 → NO)', () => {
  for (const [S, mp, mw, v] of BY_S) {
    const r = check_purchase(AG, buy(S), 50000);
    assert.equal(r.by_mode.plan.m_after, mp, `S = ${S}: plan`);
    assert.equal(r.by_mode.worse.m_after, mw, `S = ${S}: worse`);
    assert.equal(r.verdict, v, `S = ${S}`);
  }
  assert.equal(check_purchase(AG, buy(21000), 50000).by_mode.worse.margin, 0);
  assert.equal(check_purchase(AG, buy(43500), 50000).by_mode.plan.margin, 0);
  const t = check_purchase(AG, buy(93500), 50000);
  assert.equal(t.flags.worse_gap, true);
  assert.equal(t.flags.cash_gap, false, 'физический минимум worse 89500 ≥ 0');
  assert.equal(check_purchase(AG, buy(120000), 50000).flags.worse_gap, true);
});

test('TST-04 G-001: перебор S: OK до 21000, FRAGILE 21001–43500, TIGHT 43501–93500, NO с 93501 (границы ± 2 и шаг 997 по 1…130000)', () => {
  const expect = (S) => (S <= 21000 ? 'OK' : S <= 43500 ? 'FRAGILE' : S <= 93500 ? 'TIGHT' : 'NO');
  const probes = new Set();
  for (const edge of [21000, 43500, 93500]) for (let d = -2; d <= 2; d++) probes.add(edge + d);
  for (let S = 1; S <= 130000; S += 997) probes.add(S);
  probes.add(1).add(130000);
  for (const S of [...probes].sort((a, b) => a - b)) assert.equal(check_purchase(AG, buy(S), 50000).verdict, expect(S), `S = ${S}`);
});

test('TST-04 буфер вызова перекрывает буфер контекста (N6): B = 70000 → TIGHT (63500 < 70000); явный B = 0 при незаданном буфере контекста — «задан»', () => {
  assert.equal(check_purchase(AG, buy(30000), 70000).verdict, 'TIGHT');
  assert.equal(check_purchase(AG, buy(30000), 70000).buffer_minor, 70000);
  assert.equal(check_purchase(AG, buy(30000), null).verdict, 'FRAGILE', 'null → ctx.buffer_minor');
  assert.equal(check_purchase(AG, buy(30000)).verdict, 'FRAGILE');
  const nb = run({ ...G, params: { ...G.params, buffer_minor: null } });
  const zero = check_purchase(nb, buy(30000), 0);
  assert.equal(zero.kind, 'ok');
  assert.equal(zero.buffer_minor, 0);
  assert.notEqual(zero.verdict, 'TIGHT', 'при B = 0 TIGHT недостижим');
});

// ── гейт ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('TST-04 гейт (C-018): буфер не задан → insufficient_data / no_buffer на Q3 и «можно потратить»; готовность, свежесть, отключённое правило — свои причины; banner не блокирует', () => {
  const nb = run({ ...G, params: { ...G.params, buffer_minor: null } });
  assert.equal(nb.buffer_minor, null);
  assert.deepEqual(check_purchase(nb, buy(30000)), { kind: 'insufficient_data', reason: 'no_buffer', reasons: ['no_buffer'] });
  assert.deepEqual(safe_to_spend(nb, nb.horizon_end, null, 'worse'), { kind: 'insufficient_data', reason: 'no_buffer', reasons: ['no_buffer'] });
  assert.equal(gate(AG), null);
  // готовность 3 (нет оценки повседневных трат): rules без R-GROC
  const rd = run({ ...G, rules: G.rules.filter((r) => r.rule_id !== 'R-GROC') });
  assert.equal(rd.readiness.score, 3);
  assert.deepEqual(gate(rd), { kind: 'insufficient_data', reason: 'readiness', reasons: ['readiness'] });
  assert.equal(check_purchase(rd, buy(30000), 50000).kind, 'insufficient_data');
  // якорь старше 21 дня — stale; 9 дней — плашка, не отказ
  const old = run(G, { as_of: '2026-10-29' });
  assert.equal(old.anchor_status.level, 'block');
  assert.deepEqual(gate(old), { kind: 'insufficient_data', reason: 'stale', reasons: ['stale'] });
  const banner = run(G, { as_of: '2026-10-13' });
  assert.equal(banner.anchor_status.level, 'banner');
  assert.equal(gate(banner), null, 'уровень banner — плашка, не отказ');
  // нет якоря — no_anchor
  const na = run({ ...G, anchors: [] });
  assert.equal(na.anchor_status.reason, 'no_anchor');
  assert.equal(gate(na).reason, 'no_anchor');
  // правило disabled (reviewed_at + ttl_days: age 276 > 2·100)
  const dis = run({ ...G, tax_rules: [{ ...G.tax_rules[0], reviewed_at: '2026-01-01', ttl_days: 100 }] });
  assert.equal(dis.rule_status['TR-20'], 'disabled');
  assert.deepEqual(gate(dis), { kind: 'insufficient_data', reason: 'rule_disabled', reasons: ['rule_disabled'] });
  assert.ok(dis.warnings.some((w) => w.code === 'W_RULE_DISABLED'));
  assert.equal(safe_to_spend(dis, dis.horizon_end, 50000, 'worse').kind, 'insufficient_data');
  const stale = run({ ...G, tax_rules: [{ ...G.tax_rules[0], reviewed_at: '2026-01-01', ttl_days: 200 }] });
  assert.equal(stale.rule_status['TR-20'], 'stale');
  assert.equal(gate(stale), null, 'stale — только предупреждение');
  assert.ok(stale.warnings.some((w) => w.code === 'W_RULE_STALE'));
  // все причины сразу, порядок: готовность, свежесть, буфер, правило
  const all = { ...rd, anchor_status: { level: 'block', reason: 'no_anchor' }, buffer_minor: null, rule_status: { x: 'disabled' } };
  assert.deepEqual(gate(all).reasons, ['readiness', 'no_anchor', 'no_buffer', 'rule_disabled']);
  assert.equal(gate(all).reason, 'readiness');
  // readiness числом (минимальный контекст) допустим
  assert.equal(gate({ ...AG, readiness: 4 }), null);
  throws_code(() => gate({ ...AG, readiness: undefined }), 'E_SCHEMA');
});

// ── TST-05: максимум и ранняя дата ─────────────────────────────────────────────────────────────────────────────────────

test('TST-05 G-001: S_max на 2026-10-12 и на as_of — 43500 (plan) и 21000 (worse, главное число); D за горизонтом — null; D в прошлом считается на as_of', () => {
  for (const D of ['2026-10-12', '2026-10-04']) {
    assert.equal(max_amount(AG, D, 50000, 'plan'), 43500, D);
    assert.equal(max_amount(AG, D, 50000, 'worse'), 21000, D);
  }
  assert.equal(max_amount(AG, '2026-09-01', 50000, 'worse'), 21000);
  assert.equal(max_amount(AG, '2026-11-30', 50000, 'worse'), 122200, 'M_plan[horizon_end] = 172200');
  assert.equal(max_amount(AG, '2026-11-30', 50000, 'plan'), 122200);
  assert.equal(max_amount(AG, '2026-12-01', 50000, 'worse'), null); // «в горизонте нет»
  assert.equal(max_amount(AG, iso('2026-10-12'), 50000), 21000, 'по умолчанию — headline_mode (worse)');
  assert.equal(max_amount(AG, '2026-10-12', 50000, 'conservative'), 21000);
  // S_max не убывает с ростом D на всём горизонте
  for (const mode of ['plan', 'worse']) {
    let prev = -1;
    for (let d = AG.as_of; d <= AG.horizon_end; d++) {
      const v = max_amount(AG, d, 50000, mode);
      assert.ok(v >= prev, `${mode}: S_max(${format_date(d)})`);
      prev = v;
    }
  }
  throws_code(() => max_amount(AG, '2026-10-12', null, 'worse'), 'E_SCHEMA');
});

test('TST-05 G-001: earliest(S): 15000 → 10-04 / 10-04; 30000 → 10-04 / 11-20; 60000 и 90000 → 11-06 / 11-20 (день 11-19 не подходит: расходы раньше доходов)', () => {
  const E = (S, nb, mode) => earliest_date(AG, S, nb ?? '2026-10-04', 50000, mode);
  const D = (s) => iso(s);
  assert.deepEqual([E(15000, null, 'plan'), E(15000, null, 'worse')], [D('2026-10-04'), D('2026-10-04')]);
  assert.deepEqual([E(30000, null, 'plan'), E(30000, null, 'worse')], [D('2026-10-04'), D('2026-11-20')]);
  assert.deepEqual([E(60000, null, 'plan'), E(60000, null, 'worse')], [D('2026-11-06'), D('2026-11-20')]);
  assert.deepEqual([E(90000, null, 'plan'), E(90000, null, 'worse')], [D('2026-11-06'), D('2026-11-20')]);
  assert.notEqual(E(30000, null, 'worse'), D('2026-11-19'), 'минимум 11-19 остаётся 71000');
  // не раньше: S = 15000 с nb = 11-10 → 11-10
  assert.deepEqual([E(15000, '2026-11-10', 'plan'), E(15000, '2026-11-10', 'worse')], [D('2026-11-10'), D('2026-11-10')]);
  // верхняя граница: 122200 → 11-06 / 11-20; 122201 → null («в горизонте нет»)
  assert.deepEqual([E(122200, null, 'plan'), E(122200, null, 'worse')], [D('2026-11-06'), D('2026-11-20')]);
  assert.deepEqual([E(122201, null, 'plan'), E(122201, null, 'worse')], [null, null]);
  assert.equal(E(15000, '2026-12-05', 'worse'), null, 'не раньше даты за горизонтом');
  assert.equal(earliest_date(AG, 30000, '2026-01-01', 50000), D('2026-11-20'), 'по умолчанию — headline_mode; прошлое «не раньше» → as_of');
  throws_code(() => earliest_date(AG, 0, '2026-10-04', 50000, 'plan'), 'E_SCHEMA');
  throws_code(() => earliest_date(AG, -5, '2026-10-04', 50000, 'plan'), 'E_SCHEMA');
  throws_code(() => earliest_date(AG, 100, '2026-10-04', null, 'plan'), 'E_SCHEMA');
});

test('TST-05 earliest_date против перебора по определению: min{d ≥ nb : M[idx(d)] − S ≥ B} на G-001 (все S кратные 997 до 130000, оба режима)', () => {
  for (const mode of ['plan', 'worse']) {
    const free = AG.series[mode].free;
    for (let S = 1; S <= 130000; S += 997) {
      let want = null;
      for (let i = 0; i < free.length && want === null; i++) if (min_of(free.slice(i)) - S >= 50000) want = AG.as_of + i;
      assert.equal(earliest_date(AG, S, AG.as_of, 50000, mode), want, `${mode}, S = ${S}`);
    }
  }
});

// ── TST-06: safe-to-spend ──────────────────────────────────────────────────────────────────────────────────────────────

test('TST-06 G-001: T по умолчанию 2026-11-19 (поступление 11-05 + 14 дней): STS 43500 (plan) / 21000 (worse); sts_horizon = 43500 / 21000; min free 93500 · 11-01 / 71000 · 11-14', () => {
  assert.equal(default_sts_horizon(AG, AG.as_of), iso('2026-11-19'));
  assert.equal(default_sts_horizon(AG), iso('2026-11-19'));
  const T = default_sts_horizon(AG, AG.as_of);
  assert.deepEqual(safe_to_spend(AG, T, 50000, 'plan'), { sts: 43500, short_to_buffer: 0, at: iso('2026-11-01'), min_free: 93500, sts_horizon: 43500 });
  assert.deepEqual(safe_to_spend(AG, T, 50000, 'worse'), { sts: 21000, short_to_buffer: 0, at: iso('2026-11-14'), min_free: 71000, sts_horizon: 21000 });
  assert.deepEqual(safe_to_spend(AG, T, null), safe_to_spend(AG, T, 50000, 'worse'), 'по умолчанию — headline_mode и ctx.buffer_minor');
});

test('TST-06 G-001: T = 10-31 → 55500 / 55500 (min free 105500 в обоих); T = horizon_end → 43500 / 21000 = S_max(as_of); подпись C-084: резервы на момент минимума 112000, на сегодня 150000', () => {
  for (const mode of ['plan', 'worse']) {
    const r = safe_to_spend(AG, '2026-10-31', 50000, mode);
    assert.equal(r.sts, 55500, mode);
    assert.equal(r.min_free, 105500, mode);
    assert.equal(r.at, iso('2026-10-31'), mode);
  }
  assert.equal(safe_to_spend(AG, '2026-11-30', 50000, 'plan').sts, 43500);
  assert.equal(safe_to_spend(AG, '2026-11-30', 50000, 'worse').sts, 21000);
  const k = iso('2026-11-14') - AG.as_of;
  assert.equal(AG.series.worse.reserve_trough[k], 112000); // «резервы на момент минимума (14 ноября) — 1 120,00 €»
  assert.equal(AG.series.worse.reserve_opening_minor, 150000); // «на сегодня — 1 500,00 €»
  assert.equal(183000 - 112000 - 50000, 21000);
});

test('TST-06 safe_to_spend: T = as_of — окно из одного дня; T позже горизонта зажимается (W_T_CLAMPED); T < as_of — E_BAD_DATE; STS не возрастает с ростом T', () => {
  assert.equal(safe_to_spend(AG, '2026-10-04', 50000, 'worse').sts, 200000); // free[0] − B = 250000 − 50000
  const clamped = safe_to_spend(AG, '2027-03-01', 50000, 'worse');
  assert.deepEqual(clamped.warnings, [{ code: 'W_T_CLAMPED' }]);
  assert.equal(clamped.sts, 21000);
  assert.equal(safe_to_spend(AG, '2026-11-30', 50000, 'worse').warnings, undefined, 'без зажима поля warnings нет');
  throws_code(() => safe_to_spend(AG, '2026-10-03', 50000, 'worse'), 'E_BAD_DATE');
  for (const mode of ['plan', 'worse']) {
    let prev = Infinity;
    for (let d = AG.as_of; d <= AG.horizon_end; d++) {
      const v = safe_to_spend(AG, d, 50000, mode).sts;
      assert.ok(v <= prev, `${mode}: STS(${format_date(d)})`);
      prev = v;
    }
  }
});

test('TST-06 default_sts_horizon: headline_mode = plan → 2026-11-05; нет ожидаемых доходов → min(as_of + 30, horizon_end) = 2026-11-03', () => {
  const plan = run({ ...G, params: { ...G.params, headline_mode: 'plan' } });
  assert.equal(default_sts_horizon(plan), iso('2026-11-05'));
  const none = run({ ...G, streams: [] });
  assert.equal(default_sts_horizon(none), iso('2026-11-03'));
  const short = run({ ...G, streams: [] }, { horizon_end: '2026-10-20' });
  assert.equal(default_sts_horizon(short), iso('2026-10-20'), 'горизонт короче 30 дней');
});

test('TST-06 sts_breakdown (REQ-057), worse, T = 11-19, at = 11-14: opening 400000, reserves_start −150000, payments −217000, incomes 0, released +50000, reserve_adds −12000, buffer −50000; Σ = 21000', () => {
  const rows = sts_breakdown(AG, iso('2026-11-19'), 50000, 'worse');
  assert.deepEqual(rows, [
    { id: 'opening', v: 400000 }, { id: 'reserves_start', v: -150000 }, { id: 'payments', v: -217000 }, { id: 'incomes', v: 0 },
    { id: 'released', v: 50000 }, { id: 'reserve_adds', v: -12000 }, { id: 'buffer', v: -50000 },
  ]);
  assert.equal(rows.reduce((s, r) => s + r.v, 0), 21000);
  const plan = sts_breakdown(AG, iso('2026-11-19'), 50000, 'plan'); // at = 11-01
  assert.deepEqual(plan.map((r) => r.v), [400000, -150000, -194500, 0, 50000, -12000, -50000]);
  assert.equal(plan.reduce((s, r) => s + r.v, 0), 43500);
  assert.equal(rows.find((r) => r.id === 'payments').v + rows.find((r) => r.id === 'released').v, -167000, '«платежи без налога 1 670,00 €»: налог нейтрален');
});

test('TST-06 TV-5: платёж больше резерва — funded_open 30000, налог 50000 на 10-23: released 30000, true_up 20000; free 347500 → 327500; минимумы 193500 / 171000; STS(11-19) = 143500 / 121000', () => {
  const ws = { ...G, reserves: G.reserves.map((r) => (r.reserve_id === 'RES-TAX' ? { ...r, funded_start_minor: 30000 } : r)) };
  const a = run(ws);
  const i22 = iso('2026-10-22') - a.as_of;
  assert.equal(a.series.plan.free[i22], 347500);
  assert.equal(a.series.plan.free[i22 + 1], 327500);
  const br = a.reserve.plan.by_reserve['RES-TAX'];
  assert.equal(br.released[i22 + 1], 30000);
  assert.equal(br.true_up[i22 + 1], 20000);
  assert.deepEqual([safe_to_spend(a, '2026-11-19', 50000, 'plan').min_free, safe_to_spend(a, '2026-11-19', 50000, 'worse').min_free], [193500, 171000]);
  assert.deepEqual([safe_to_spend(a, '2026-11-19', 50000, 'plan').sts, safe_to_spend(a, '2026-11-19', 50000, 'worse').sts], [143500, 121000]);
});

// ── TST-39: S_max(as_of) = STS(horizon_end); без резервов free = trough ───────────────────────────────────────────────

test('TST-39 G-001: S_max(as_of) = STS(horizon_end) = sts_horizon: 43500 = 43500 (plan), 21000 = 21000 (worse)', () => {
  for (const [mode, v] of [['plan', 43500], ['worse', 21000]]) {
    assert.equal(max_amount(AG, AG.as_of, 50000, mode), v);
    assert.equal(safe_to_spend(AG, AG.horizon_end, 50000, mode).sts, v);
    assert.equal(safe_to_spend(AG, AG.as_of, 50000, mode).sts_horizon, v);
  }
});

test('TST-39 без резервов (нет RES-TAX и RES-INS, нет правил) free = trough: S_max 155500 / 133000; дорожка 300,00 € → OK; W_NO_RESERVES; STS(11-19) = 155500 / 133000', () => {
  const bare = run({ ...G, reserves: [], tax_rules: [] });
  for (const mode of ['plan', 'worse']) {
    assert.deepEqual(bare.series[mode].free, bare.series[mode].trough, mode);
    assert.equal(bare.series[mode].reserve_opening_minor, 0);
  }
  assert.equal(max_amount(bare, '2026-10-12', 50000, 'plan'), 155500);
  assert.equal(max_amount(bare, '2026-10-12', 50000, 'worse'), 133000);
  assert.equal(check_purchase(bare, buy(30000), 50000).verdict, 'OK');
  assert.ok(bare.warnings.some((w) => w.code === 'W_NO_RESERVES'));
  assert.equal(safe_to_spend(bare, '2026-11-19', 50000, 'plan').sts, 155500);
  assert.equal(safe_to_spend(bare, '2026-11-19', 50000, 'worse').sts, 133000);
  assert.ok(!AG.warnings.some((w) => w.code === 'W_NO_RESERVES'), 'в G-001 резервы заданы');
});

// ── TST-08: G-001-low, G-001-gap, G-001-late ──────────────────────────────────────────────────────────────────────────

test('TST-08 G-001-low (opening 220000): min free −86500 · 11-01 / −109000 · 11-14 → STS = 0, short_to_buffer 136500 / 159000; физические деньги не отрицательны (min trough 25500 / 3000, need 24500 / 47000)', () => {
  const a = run(LOW);
  const sp = safe_to_spend(a, '2026-11-19', 50000, 'plan');
  const sw = safe_to_spend(a, '2026-11-19', 50000, 'worse');
  assert.deepEqual([sp.sts, sp.short_to_buffer, sp.min_free, sp.at], [0, 136500, -86500, iso('2026-11-01')]);
  assert.deepEqual([sw.sts, sw.short_to_buffer, sw.min_free, sw.at], [0, 159000, -109000, iso('2026-11-14')]);
  assert.equal(sp.sts_horizon + sw.sts_horizon, 0);
  assert.deepEqual([a.q1.plan.min, a.q1.plan.at, a.q1.plan.ok_buffer, a.q1.plan.need], [25500, iso('2026-10-31'), false, 24500]);
  assert.deepEqual([a.q1.worse.min, a.q1.worse.at, a.q1.worse.ok_buffer, a.q1.worse.need], [3000, iso('2026-11-14'), false, 47000]);
  assert.equal(a.q1.plan.ok_cash && a.q1.worse.ok_cash, true);
});

test('TST-08 G-001-low: любая S > 0 → NO; m_after −86501 / −109001 при S = 1; S_max = 0, earliest = null; baseline_below_buffer; cash_gap — только когда физические деньги уходят в минус', () => {
  const a = run(LOW);
  const r = check_purchase(a, buy(1), 50000);
  assert.equal(r.verdict, 'NO');
  assert.deepEqual([r.by_mode.plan.m_after, r.by_mode.worse.m_after], [-86501, -109001]);
  assert.deepEqual(r.s_max, { plan: 0, worse: 0 });
  assert.deepEqual(r.earliest, { plan: null, worse: null });
  assert.deepEqual(r.flags, { worse_gap: true, cash_gap: false, baseline_below_buffer: true }); // физический минимум 25499 / 2999 ≥ 0
  for (const S of [1, 100, 5000, 30000, 100000]) assert.equal(check_purchase(a, buy(S), 50000).verdict, 'NO', `S = ${S}`);
  assert.equal(check_purchase(a, buy(30000), 50000).flags.cash_gap, true, '3000 − 30000 < 0');
  assert.equal(max_amount(a, '2026-10-12', 50000, 'plan'), 0);
  assert.equal(earliest_date(a, 1, '2026-10-04', 50000, 'worse'), null);
});

test('TST-08 G-001-gap (opening 100000): short_to_buffer 256500 / 279000 (min free −206500 · 11-01 / −229000 · 11-14); Q1 need 144500 / 167000 — три «не хватает» из разных рядов (X13, C-067)', () => {
  const a = run(GAP);
  assert.deepEqual([safe_to_spend(a, a.horizon_end, 50000, 'plan').short_to_buffer, safe_to_spend(a, a.horizon_end, 50000, 'worse').short_to_buffer], [256500, 279000]);
  assert.deepEqual([safe_to_spend(a, a.horizon_end, 50000, 'plan').min_free, safe_to_spend(a, a.horizon_end, 50000, 'worse').min_free], [-206500, -229000]);
  assert.deepEqual([a.q1.plan.need, a.q1.worse.need], [144500, 167000]);
  assert.deepEqual([a.q1.plan.min, a.q1.worse.min], [-94500, -117000]);
  assert.equal(check_purchase(a, buy(1), 50000).verdict, 'NO');
});

test('TST-39 G-001-late (C-058): STS(11-19) = 43500 / 21000, а sts_horizon = 0: min free на горизонте −77800 (11-28), short_to_buffer 127800; baseline → S_max = 0, earliest = null, вердикт OK невозможен', () => {
  const a = run(LATE);
  const T = default_sts_horizon(a);
  assert.equal(T, iso('2026-11-19'));
  const p = safe_to_spend(a, T, 50000, 'plan');
  const w = safe_to_spend(a, T, 50000, 'worse');
  assert.deepEqual([p.sts, w.sts], [43500, 21000]);
  assert.deepEqual([p.sts_horizon, w.sts_horizon], [0, 0]);
  assert.ok(w.sts_horizon < w.sts, 'экран добавляет строку «до конца горизонта»');
  for (const mode of ['plan', 'worse']) {
    const h = safe_to_spend(a, a.horizon_end, 50000, mode);
    assert.deepEqual([h.sts, h.short_to_buffer, h.min_free, h.at], [0, 127800, -77800, iso('2026-11-28')], mode);
    assert.equal(max_amount(a, a.as_of, 50000, mode), 0, mode); // S_max(as_of) = STS(horizon_end) = 0
    assert.equal(earliest_date(a, 1, a.as_of, 50000, mode), null, mode);
  }
  const r = check_purchase(a, buy(1), 50000);
  assert.notEqual(r.verdict, 'OK');
  assert.equal(r.flags.baseline_below_buffer, true);
  assert.deepEqual(r.s_max, { plan: 0, worse: 0 });
  assert.equal(AG.warnings.length, 0);
});

// ── TV-6 (защитный признак, синтетика C-015) ─────────────────────────────────────────────────────────────────────────

/** Минимальный `ctx` по рядам free/trough (оба режима) — для синтетики и свойств. */
function mk_ctx({ free_plan, free_worse = free_plan, trough_plan = free_plan, trough_worse = free_worse, B = 50, readiness = 4, events }) {
  const N = free_plan.length;
  return {
    as_of: 0, horizon_end: N - 1, decision_currency: 'EUR', params: {}, buffer_minor: B, readiness: { score: readiness },
    anchor_status: { level: 'fresh' }, rule_status: {},
    series: {
      plan: { from: 0, opening_minor: free_plan[0], close: trough_plan, trough: trough_plan, free: free_plan },
      worse: { from: 0, opening_minor: free_worse[0], close: trough_worse, trough: trough_worse, free: free_worse },
    },
    events: events ?? { plan: [], worse: [] },
  };
}
const pur = (parts) => ({ currency: 'EUR', parts: parts.map(([date, amount_minor]) => ({ date, amount_minor })) });

test('TST-35 TV-6 (C-015): free = [100, 40, 120, 120], B = 50, D = индекс 2: S_max = 0 (а не 70), earliest = null; S = 10 → TIGHT; при free = [100, 90, 120, 120]: S_max = 70, S = 70 → OK, S = 71 → TIGHT', () => {
  const bad = mk_ctx({ free_plan: [100, 40, 120, 120] });
  assert.equal(max_amount(bad, 2, 50, 'plan'), 0);
  assert.equal(max_amount(bad, 2, 50, 'worse'), 0);
  assert.equal(earliest_date(bad, 10, 0, 50, 'plan'), null);
  const r = check_purchase(bad, pur([[2, 10]]), 50);
  assert.equal(r.verdict, 'TIGHT'); // m_plan = 40 ≥ 0 и < B
  assert.deepEqual([r.by_mode.plan.m_after, r.by_mode.worse.m_after], [40, 40]);
  assert.equal(r.flags.baseline_below_buffer, true);
  assert.deepEqual(r.s_max, { plan: 0, worse: 0 });
  const good = mk_ctx({ free_plan: [100, 90, 120, 120] });
  assert.equal(max_amount(good, 2, 50, 'plan'), 70);
  assert.equal(check_purchase(good, pur([[2, 70]]), 50).verdict, 'OK');
  assert.equal(check_purchase(good, pur([[2, 71]]), 50).verdict, 'TIGHT');
  assert.equal(check_purchase(good, pur([[2, 71]]), 50).by_mode.plan.m_after, 49);
});

// ── TST-30: дробление покупки по частям ───────────────────────────────────────────────────────────────────────────────

test('TST-30 installment_parts(110000, 6) = [18334, 18334, 18333, 18333, 18333, 18333]; рассрочка 1 100,00 € (6 частей помесячно с 11-01): в горизонте 57 дн. одна часть, beyond_horizon_minor = 91666, s_max и earliest — null', () => {
  assert.deepEqual(installment_parts(110000, 6), [18334, 18334, 18333, 18333, 18333, 18333]);
  const purchase = G.purchases.find((p) => p.purchase_id === 'pur-treadmill-6');
  assert.deepEqual(purchase.parts.map((p) => p.amount_minor), installment_parts(110000, 6));
  const r = check_purchase(AG, purchase, 50000);
  assert.equal(r.kind, 'ok');
  assert.equal(r.beyond_horizon_minor, 91666); // 5 из 6 платежей за горизонтом
  assert.equal(r.warnings.filter((w) => w.code === 'W_PART_BEYOND_HORIZON').length, 5);
  assert.equal(r.s_max, null);
  assert.equal(r.earliest, null);
  assert.deepEqual([r.by_mode.plan.m_after, r.by_mode.worse.m_after], [75166, 52666]); // 93500 − 18334, 71000 − 18334
  assert.equal(r.verdict, 'OK', 'вердикт по части в горизонте — «спокойно»: поэтому подпись обязана добавить «не все платежи учтены» (ALG-12)');
});

test('TST-30 иллюстрация: 6 платежей, первый 2026-11-12, дальше ежемесячно — в горизонте 18334, beyond_horizon_minor = 91666', () => {
  const parts = installment_parts(110000, 6).map((a, k) => [add_months(iso('2026-11-12'), k), a]);
  const r = check_purchase(AG, pur(parts), 50000);
  assert.equal(r.beyond_horizon_minor, 91666);
  assert.equal(r.s_max, null);
  assert.equal(r.earliest, null);
  // часть 11-12 вычитается с даты 11-12, а не раньше: минимум plan 93500 − 0 (11-01…11-11) остаётся
  assert.equal(r.by_mode.plan.m_after, 93500);
  assert.equal(r.by_mode.worse.m_after, 71000 - 18334, 'worse: узкая точка 11-14 после первой части');
});

test('TST-30 TV-5 (ALG-04): 30000 тремя платежами по 10000 (10-12, 11-16, 11-23): cum вычитается по датам частей; plan min 83500 · 11-01 (margin +33500); worse 51000 · 11-16 (margin +1000, delta 20000); OK; s_max = earliest = null', () => {
  const r = check_purchase(AG, pur([['2026-10-12', 10000], ['2026-11-16', 10000], ['2026-11-23', 10000]]), 50000);
  assert.deepEqual(r.by_mode.plan, { m_after: 83500, at: iso('2026-11-01'), margin: 33500, delta: 10000, cash_gap: false });
  assert.deepEqual(r.by_mode.worse, { m_after: 51000, at: iso('2026-11-16'), margin: 1000, delta: 20000, cash_gap: false });
  assert.equal(r.verdict, 'OK');
  assert.equal(r.s_max, null);
  assert.equal(r.earliest, null);
  // вся сумма сразу на ту же первую дату — хуже (41000), чем по частям (51000)
  assert.equal(check_purchase(AG, buy(30000), 50000).by_mode.worse.m_after, 41000);
  // порядок частей не важен
  const rev = check_purchase(AG, pur([['2026-11-23', 10000], ['2026-10-12', 10000], ['2026-11-16', 10000]]), 50000);
  assert.deepEqual(rev, r);
});

test('TST-30 части: дата в прошлом зажимается на as_of (W_DATE_CLAMPED); части позже горизонта отбрасываются; все за горизонтом → outside_horizon; несколько частей в один день суммируются', () => {
  const past = check_purchase(AG, pur([['2026-09-01', 30000]]), 50000);
  assert.deepEqual(past.warnings, [{ code: 'W_DATE_CLAMPED', part: 0 }]);
  assert.equal(past.by_mode.worse.m_after, 41000 - 0, 'покупка с as_of: min free worse 71000 − 30000');
  assert.equal(past.s_max.worse, 21000);
  const beyond = check_purchase(AG, pur([['2026-12-05', 1000]]), 50000);
  assert.deepEqual(beyond, { kind: 'outside_horizon', horizon_end: iso('2026-11-30') });
  const same_day = check_purchase(AG, pur([['2026-10-12', 10000], ['2026-10-12', 20000]]), 50000);
  assert.deepEqual(same_day.by_mode, check_purchase(AG, buy(30000), 50000).by_mode);
  assert.equal(same_day.s_max, null, 'две части — s_max не считается (v1)');
  // граница горизонта включительная
  assert.equal(check_purchase(AG, pur([['2026-11-30', 1000]]), 50000).kind, 'ok');
});

test('TST-30 normalize_parts: валюта = валюте решения (E_CURRENCY_MISMATCH); сумма > 0 и целая (E_SCHEMA / E_NOT_INTEGER); нет частей — E_SCHEMA', () => {
  throws_code(() => normalize_parts(AG, { currency: 'USD', parts: [{ date: '2026-10-12', amount_minor: 1 }] }), 'E_CURRENCY_MISMATCH');
  throws_code(() => normalize_parts(AG, { parts: [{ date: '2026-10-12', amount_minor: 1 }] }), 'E_CURRENCY_MISMATCH');
  throws_code(() => normalize_parts(AG, pur([['2026-10-12', 0]])), 'E_SCHEMA');
  throws_code(() => normalize_parts(AG, pur([['2026-10-12', -5]])), 'E_SCHEMA');
  throws_code(() => normalize_parts(AG, pur([['2026-10-12', 1.5]])), 'E_NOT_INTEGER');
  throws_code(() => normalize_parts(AG, pur([])), 'E_SCHEMA');
  throws_code(() => check_purchase(AG, { currency: 'USD', parts: [{ date: '2026-10-12', amount_minor: 1 }] }, 50000), 'E_CURRENCY_MISMATCH');
  const r = normalize_parts(AG, pur([['2026-09-01', 5], ['2026-10-12', 7], ['2027-01-01', 9]]));
  assert.deepEqual(r.parts, [{ date: iso('2026-10-04'), amount_minor: 5 }, { date: iso('2026-10-12'), amount_minor: 7 }]);
  assert.deepEqual(r.warnings.map((w) => w.code), ['W_DATE_CLAMPED', 'W_PART_BEYOND_HORIZON']);
});

test('TST-04 binding_events: приходы между точкой минимума и первым подъёмом ряда; нет подъёма — пусто', () => {
  const a = [10, 5, 5, 5, 20, 30];
  const ctx = { as_of: 100, events: { plan: [
    { cash_event_id: 'in1', amount_minor: 50, date: 102 }, { cash_event_id: 'out1', amount_minor: -5, date: 102 },
    { cash_event_id: 'in2', amount_minor: 50, date: 103 }, { cash_event_id: 'in3', amount_minor: 50, date: 104 },
  ] } };
  assert.deepEqual(binding_events(ctx, 'plan', a, 1), ['in1', 'in2']); // j = 1, rise = 4 → дни 101…103
  assert.deepEqual(binding_events(ctx, 'plan', [10, 8, 6], 2), []);
  assert.deepEqual(binding_events(ctx, 'plan', a, 5), []);
});

// ── TST-35 / TST-39: свойства на 10³ случайных рядов ───────────────────────────────────────────────────────────────────

/** Случайный контекст: free_worse ≤ free_plan, резервы одинаковы в режимах (trough = free + R, R ≥ 0). */
function rand_ctx(rng) {
  const N = rng.int(2, 26);
  const free_plan = Array.from({ length: N }, () => rng.int(-150, 650));
  const free_worse = free_plan.map((x) => x - rng.int(0, 130));
  const R = Array.from({ length: N }, () => rng.int(0, 200));
  const B = rng.int(0, 220);
  return mk_ctx({ free_plan, free_worse, trough_plan: free_plan.map((x, i) => x + R[i]), trough_worse: free_worse.map((x, i) => x + R[i]), B });
}

test('TST-35 свойство (10³ случаев, seed 3504): вердикт не улучшается с ростом S; m_after = min(free − cum); S_max_worse ≤ S_max_plan; S_max не убывает по D; границы OK ⇔ S ≤ S_max_worse, FRAGILE ⇔ S_max_worse < S ≤ S_max_plan, TIGHT/NO — по M_plan', () => {
  const rng = make_rng(3504);
  for (let c = 0; c < 1000; c++) {
    const ctx = rand_ctx(rng);
    const N = ctx.series.plan.free.length;
    const B = ctx.buffer_minor;
    const idx = rng.int(0, N - 1);
    const Ss = [rng.int(1, 80), rng.int(1, 400), rng.int(1, 900), rng.int(1, 40), 1].sort((a, b) => a - b);
    let prev_rank = -1;
    let prev_m = { plan: Infinity, worse: Infinity };
    const smax = { plan: max_amount(ctx, idx, B, 'plan'), worse: max_amount(ctx, idx, B, 'worse') };
    assert.ok(smax.worse <= smax.plan, `случай ${c}: S_max_worse ≤ S_max_plan`);
    for (const S of Ss) {
      const r = check_purchase(ctx, pur([[idx, S]]), B);
      assert.equal(r.kind, 'ok');
      assert.ok(RANK[r.verdict] >= prev_rank, `случай ${c}: вердикт не улучшается с ростом S`);
      prev_rank = RANK[r.verdict];
      for (const m of ['plan', 'worse']) {
        const f = ctx.series[m].free;
        const want = min_of(f.map((x, i) => x - (i >= idx ? S : 0)));
        assert.equal(r.by_mode[m].m_after, want, `случай ${c}: m_after ${m}`);
        assert.ok(r.by_mode[m].m_after <= prev_m[m], `случай ${c}: m_after не растёт с ростом S`);
        prev_m[m] = r.by_mode[m].m_after;
        assert.equal(r.by_mode[m].at, argmin_first(f.map((x, i) => x - (i >= idx ? S : 0)), 0, N - 1));
        assert.equal(r.by_mode[m].margin, want - B);
        assert.equal(r.by_mode[m].delta, min_of(f) - want);
        assert.ok(r.by_mode[m].delta >= 0 && r.by_mode[m].delta <= S, `случай ${c}: 0 ≤ delta ≤ S`);
      }
      // границы по сумме — безусловно (C-015)
      const Mp = suffix_min(ctx.series.plan.free)[idx];
      const pre_plan = idx === 0 ? Infinity : min_of(ctx.series.plan.free.slice(0, idx));
      const expect = S <= smax.worse ? 'OK' : S <= smax.plan ? 'FRAGILE' : (S <= Mp && pre_plan >= 0 ? 'TIGHT' : 'NO');
      assert.equal(r.verdict, expect, `случай ${c}: S = ${S}, S_max = ${smax.worse}/${smax.plan}`);
      assert.equal(r.flags.baseline_below_buffer, min_of(ctx.series.worse.free) < B);
      assert.equal(r.flags.worse_gap, r.by_mode.worse.m_after < 0);
      if (r.by_mode.plan.m_after >= 0) assert.equal(r.by_mode.plan.cash_gap, false, `случай ${c}: m_plan ≥ 0 ⇒ нет cash_gap`);
      if (r.by_mode.worse.cash_gap) assert.equal(r.flags.worse_gap, true, `случай ${c}: cash_gap ⇒ worse_gap`);
      assert.ok(S !== smax.worse || r.by_mode.worse.margin >= 0 || smax.worse === 0, `случай ${c}: на границе S_max margin_worse ≥ 0`);
    }
    // S_max(D) не убывает по D
    for (const m of ['plan', 'worse']) {
      let p = -1;
      for (let d = 0; d < N; d++) { const v = max_amount(ctx, d, B, m); assert.ok(v >= p, `случай ${c}: S_max(${m}) по D`); p = v; }
    }
  }
});

test('TST-35 свойство (10³ случаев, seed 3505): earliest_date против перебора по определению; не раньше при большем S; сумма S_max на найденной дате не меньше S', () => {
  const rng = make_rng(3505);
  for (let c = 0; c < 1000; c++) {
    const ctx = rand_ctx(rng);
    const N = ctx.series.plan.free.length;
    const B = ctx.buffer_minor;
    for (const m of ['plan', 'worse']) {
      const f = ctx.series[m].free;
      const baseline = min_of(f) < B;
      const nb = rng.int(-3, N + 1);
      let prev = -Infinity;
      for (const S of [rng.int(1, 60), rng.int(61, 300), rng.int(301, 800)]) {
        let want = null;
        if (!baseline) for (let i = Math.max(0, nb); i < N && want === null; i++) if (min_of(f.slice(i)) - S >= B) want = i;
        const got = earliest_date(ctx, S, nb, B, m);
        assert.equal(got, want, `случай ${c}: ${m}, S = ${S}, nb = ${nb}`);
        const g = got === null ? Infinity : got;
        assert.ok(g >= prev, `случай ${c}: earliest не раньше при большем S`);
        prev = g;
        if (got !== null) assert.ok(max_amount(ctx, got, B, m) >= S, `случай ${c}: S_max(earliest) ≥ S`);
      }
    }
  }
});

test('TST-39 свойство (10³ случаев, seed 3901): S_max(as_of) = STS(horizon_end) = sts_horizon в обоих режимах; STS(T) не возрастает по T; short_to_buffer = max(0, B − min free)', () => {
  const rng = make_rng(3901);
  for (let c = 0; c < 1000; c++) {
    const ctx = rand_ctx(rng);
    const N = ctx.series.plan.free.length;
    const B = ctx.buffer_minor;
    for (const m of ['plan', 'worse']) {
      const f = ctx.series[m].free;
      const sm = max_amount(ctx, 0, B, m);
      const h = safe_to_spend(ctx, N - 1, B, m);
      assert.equal(sm, h.sts, `случай ${c}: ${m}: S_max(as_of) = STS(horizon_end)`);
      assert.equal(h.sts, h.sts_horizon);
      assert.equal(h.sts, Math.max(0, min_of(f) - B));
      let prev = Infinity;
      for (let t = 0; t < N; t++) {
        const r = safe_to_spend(ctx, t, B, m);
        assert.ok(r.sts <= prev);
        prev = r.sts;
        assert.equal(r.min_free, min_of(f.slice(0, t + 1)));
        assert.equal(r.short_to_buffer, Math.max(0, B - r.min_free));
        assert.equal(r.at, f.indexOf(r.min_free), 'первая дата минимума');
        assert.equal(r.sts_horizon, h.sts);
      }
    }
  }
});

// ── оракул: сценарий add_purchase (TST-53, часть) ─────────────────────────────────────────────────────────────────────

test('TST-53 оракул: check_purchase = полный пересчёт рядов со сценарием add_purchase (m_after, дата, cash_gap) на G-001, G-001-low, G-001-gap, G-001-late — 120 случаев (seed 5304)', () => {
  const rng = make_rng(5304);
  const sets = [G, LOW, GAP, LATE];
  for (let c = 0; c < 120; c++) {
    const ws = sets[c % 4];
    const base = run(ws);
    const day = rng.int(0, base.horizon_end - base.as_of);
    const S = rng.pick([1, 777, 5000, 21000, 30000, 43500, 93500, 150000]) + rng.int(0, 3);
    const r = check_purchase(base, buy(S, format_date(base.as_of + day)), 50000);
    const sc = run(ws, { scenario: { ops: [{ op: 'add_purchase', parts: [{ date: base.as_of + day, amount_minor: S }] }] } });
    for (const m of ['plan', 'worse']) {
      const f = sc.series[m].free;
      const k = argmin_first(f, 0, f.length - 1);
      assert.equal(r.by_mode[m].m_after, f[k], `случай ${c}: ${m} m_after`);
      assert.equal(r.by_mode[m].at, sc.as_of + k, `случай ${c}: ${m} at`);
      assert.equal(r.by_mode[m].cash_gap, min_of(sc.series[m].trough) < 0, `случай ${c}: ${m} cash_gap`);
      assert.equal(r.by_mode[m].delta, min_of(base.series[m].free) - f[k]);
    }
    assert.equal(r.verdict, verdict_of(r.by_mode.plan.m_after, r.by_mode.worse.m_after, 50000));
  }
});

// ── инвариант разложения на случайных рабочих областях ─────────────────────────────────────────────────────────────────

/** Случайная простая рабочая область: один счёт, разовые плановые записи, налоговый резерв (платежи привязаны) и sinking `fixed`. */
function random_ws(rng, with_reserves) {
  const as_of = 20000 + rng.int(0, 400);
  const plans = [];
  for (let k = 0, n = rng.int(2, 12); k < n; k++) {
    const income = rng.int(0, 3) === 0;
    const p = {
      plan_id: 'p' + k, account_id: 'a', date: as_of + rng.int(0, 38), amount_minor: income ? rng.int(500, 9000) : -rng.int(100, 6000), currency: 'EUR',
      kind: income ? 'income' : 'expense', tag: 't' + (k % 3), is_obligation: !income && rng.bool(), is_estimate: false,
    };
    if (!income && with_reserves && rng.int(0, 2) === 0) p.reserve_id = 'RES-A';
    plans.push(p);
  }
  const ws = {
    decision_currency: 'EUR', params: { horizon_days: 40, buffer_minor: rng.int(0, 3000) },
    accounts: [{ account_id: 'a', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 }],
    anchors: [{ anchor_id: 'an', account_id: 'a', date: as_of, amount_minor: rng.int(-2000, 20000) }],
    plans, calendars: [], rules: [], streams: [], tax_rules: [], reserves: [],
  };
  if (with_reserves) {
    ws.reserves = [
      { reserve_id: 'RES-A', kind: 'tax', currency: 'EUR', funded_start_minor: rng.int(0, 8000), funded_as_of: as_of, backed_by_account_id: null },
      { reserve_id: 'RES-S', kind: 'sinking', currency: 'EUR', funded_start_minor: rng.int(0, 500), funded_as_of: as_of, mode: 'fixed', fixed_minor: rng.int(1, 700),
        target_minor: rng.int(1000, 6000), due_date: as_of + 90, cadence: { freq: 'M', day: rng.int(1, 28) }, backed_by_account_id: null },
    ];
  }
  return { ws, as_of };
}

test('TST-06 / TST-39 свойство на случайных рабочих областях (300 случаев, seed 3902): Σ sts_breakdown = min_free − B; free = trough − reserve_trough; без резервов free = trough; резерв не меняет close и trough', () => {
  const rng = make_rng(3902);
  for (let c = 0; c < 300; c++) {
    const with_res = c % 3 !== 0;
    const { ws, as_of } = random_ws(rng, with_res);
    const a = { ...analyze(ws, { as_of }), readiness: { score: 4 } }; // гейт готовности здесь не проверяется
    const bare = analyze({ ...ws, reserves: [] }, { as_of });
    const B = a.buffer_minor;
    for (const m of ['plan', 'worse']) {
      const s = a.series[m];
      assert.deepEqual(s.free, s.trough.map((t, i) => t - s.reserve_trough[i]), `случай ${c}: free`);
      assert.deepEqual(s.close, bare.series[m].close, `случай ${c}: резерв не меняет close`);
      assert.deepEqual(s.trough, bare.series[m].trough, `случай ${c}: резерв не меняет trough`);
      if (!with_res) assert.deepEqual(s.free, s.trough, `случай ${c}: без резервов free = trough`);
      for (const T of [as_of, as_of + rng.int(0, 40), a.horizon_end, as_of + 60]) {
        const r = safe_to_spend(a, T, B, m);
        const rows = sts_breakdown(a, T, B, m);
        assert.equal(rows.reduce((x, row) => x + row.v, 0), r.min_free - B, `случай ${c}: ${m}, T = ${T}`);
        assert.deepEqual(rows.map((x) => x.id), ['opening', 'reserves_start', 'payments', 'incomes', 'released', 'reserve_adds', 'buffer']);
      }
    }
    assert.ok(a.series.worse.free.every((v, i) => v <= a.series.plan.free[i]), `случай ${c}: free_worse ≤ free_plan`);
  }
});

test('TST-35 G-001 и варианты: free_worse ≤ free_plan во все дни; S_max_worse ≤ S_max_plan на каждой дате (безусловно, C-016)', () => {
  for (const ws of [G, LOW, GAP, LATE]) {
    const a = run(ws);
    a.series.plan.free.forEach((v, i) => assert.ok(a.series.worse.free[i] <= v, `день ${i}`));
    for (let d = a.as_of; d <= a.horizon_end; d++) assert.ok(max_amount(a, d, 50000, 'worse') <= max_amount(a, d, 50000, 'plan'));
  }
});
