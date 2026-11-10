// g001.golden.test.mjs — ЕДИНЫЙ golden-файл сквозного примера G-001 «Ян»: все ключи `G-001.*` из design-brief §9.4–§9.9 одним проходом через
// фасад `analyze` (index.mjs) и модули waves/afford (ADR-014 п. 1; TST-01…TST-09, TST-39 — сводная регрессия).
// ВАЖНО (X2): числа воспроизводятся только при ЯВНОМ горизонте 57 дн. (`params.horizon_days = 57` в датасетах prototype/data/g001*.json).
// ОЖИДАЕМЫЕ значения (EXPECTED) переписаны из канона ДОСЛОВНО и не зависят от кода движка; ACTUAL вычисляется движком. Любое расхождение
// ключа — красный тест с именем ключа. Тесты отдельных модулей (waves.test, afford.test, g001.test, timeline.test) глубже; этот файл — «ключи канона».
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import { parse_date } from '../engine/dates.mjs';
import { answer_q1, runway_days, explain_narrowest } from '../engine/timeline.mjs';
import { analyze } from '../engine/index.mjs';
import { list_waves } from '../engine/waves.mjs';
import { check_purchase, max_amount, earliest_date, safe_to_spend, default_sts_horizon } from '../engine/afford.mjs';

const DATA = new URL('../data/', import.meta.url);
const load = (name) => JSON.parse(fs.readFileSync(new URL(name, DATA), 'utf8'));
const iso = (s) => parse_date(s);
const WS = { 'G-001': load('g001.json'), 'G-001-low': load('g001-low.json'), 'G-001-gap': load('g001-gap.json'), 'G-001-late': load('g001-late.json') };
const A = Object.fromEntries(Object.entries(WS).map(([k, ws]) => [k, analyze(ws, { as_of: ws.as_of })]));
const B = 50000;
const D = '2026-10-12';
const buy = (S, date = D) => ({ currency: 'EUR', parts: [{ date, amount_minor: S }] });
const min_free = (a, m) => a.series[m].free.reduce((x, y) => (y < x ? y : x));
const first_min = (xs, from) => { let k = 0; for (let i = 1; i < xs.length; i++) if (xs[i] < xs[k]) k = i; return { amount_minor: xs[k], date: from + k }; };

// ── §9.4: ряды ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Таблица §9.4: [дата, T план, C план, Rт план, F план, T хуже, C хуже, Rт хуже, F хуже]. */
const TABLE = [
  ['2026-10-04', 400000, 400000, 150000, 250000, 400000, 400000, 150000, 250000],
  ['2026-10-09', 397500, 397500, 150000, 247500, 397500, 397500, 150000, 247500],
  ['2026-10-10', 387500, 387500, 150000, 237500, 387500, 387500, 150000, 237500],
  ['2026-10-17', 377500, 377500, 150000, 227500, 377500, 377500, 150000, 227500],
  ['2026-10-23', 327500, 327500, 100000, 227500, 327500, 327500, 100000, 227500],
  ['2026-10-24', 317500, 317500, 100000, 217500, 317500, 317500, 100000, 217500],
  ['2026-10-26', 215500, 215500, 100000, 115500, 215500, 215500, 100000, 115500],
  ['2026-10-31', 205500, 205500, 100000, 105500, 205500, 205500, 100000, 105500],
  ['2026-11-01', 205500, 205500, 112000, 93500, 205500, 205500, 112000, 93500],
  ['2026-11-05', 205500, 484500, 112000, 93500, 205500, 205500, 112000, 93500],
  ['2026-11-07', 474500, 474500, 167800, 306700, 195500, 195500, 112000, 83500],
  ['2026-11-09', 472000, 472000, 167800, 304200, 193000, 193000, 112000, 81000],
  ['2026-11-14', 462000, 462000, 167800, 294200, 183000, 183000, 112000, 71000],
  ['2026-11-19', 462000, 462000, 167800, 294200, 183000, 462000, 112000, 71000],
  ['2026-11-21', 452000, 452000, 167800, 284200, 452000, 452000, 167800, 284200],
  ['2026-11-25', 350000, 350000, 167800, 182200, 350000, 350000, 167800, 182200],
  ['2026-11-28', 340000, 340000, 167800, 172200, 340000, 340000, 167800, 172200],
  ['2026-11-30', 340000, 340000, 167800, 172200, 340000, 340000, 167800, 172200],
];

const EXPECTED = {};
const ACTUAL = {};
/** Записать ключ: канон — в EXPECTED, значение движка — в ACTUAL. */
function key(name, expected, actual) {
  EXPECTED[name] = expected;
  ACTUAL[name] = actual;
}

(function section_9_3_and_9_4() {
  const a = A['G-001'];
  // §9.3 готовность и свежесть
  key('G-001.readiness.score', 4, a.readiness.score);
  key('G-001.readiness.level', 'full', a.readiness.level);
  key('G-001.anchor.age', 0, a.anchor_status.age);
  key('G-001.anchor.level', 'fresh', a.anchor_status.level);
  // ключи §9.4
  key('G-001.opening', 400000, a.series.plan.opening_minor);
  key('G-001.end_close.plan', 340000, a.series.plan.close.at(-1));
  key('G-001.end_close.worse', 340000, a.series.worse.close.at(-1));
  key('G-001.q1.min_trough.plan', { amount_minor: 205500, date: iso('2026-10-31') }, first_min(a.series.plan.trough, a.as_of));
  key('G-001.q1.min_trough.worse', { amount_minor: 183000, date: iso('2026-11-14') }, first_min(a.series.worse.trough, a.as_of));
  key('G-001.free.min.plan', { amount_minor: 93500, date: iso('2026-11-01') }, first_min(a.series.plan.free, a.as_of));
  key('G-001.free.min.worse', { amount_minor: 71000, date: iso('2026-11-14') }, first_min(a.series.worse.free, a.as_of));
  key('G-001.reserve_close.end', 167800, a.series.plan.reserve_close.at(-1));
  key('G-001.reserve_close.end.worse', 167800, a.series.worse.reserve_close.at(-1));
  key('G-001.reserve_close.end.RES-TAX', 155800, a.reserve.plan.by_reserve['RES-TAX'].close.at(-1)); // 150000 − 50000 + 55800
  key('G-001.reserve_close.end.RES-INS', 12000, a.reserve.plan.by_reserve['RES-INS'].close.at(-1));
  key('G-001.horizon.N', 58, a.series.plan.close.length);
  // таблица §9.4 — все строки, оба режима
  for (const r of TABLE) {
    const i = iso(r[0]) - a.as_of;
    for (const [mode, off] of [['plan', 1], ['worse', 5]]) {
      const s = a.series[mode];
      key(`G-001.table.${r[0]}.${mode}`, { T: r[off], C: r[off + 1], Rt: r[off + 2], F: r[off + 3] }, { T: s.trough[i], C: s.close[i], Rt: s.reserve_trough[i], F: s.free[i] });
    }
  }
  // Q1 на примерах §9.4
  const q1 = (m, d) => { const r = answer_q1(a.series[m], iso(d), B); return [r.min, r.at, r.ok_cash, r.ok_buffer, r.first_breach]; };
  key('G-001.q1.D2026-10-26', { plan: [215500, iso('2026-10-26'), true, true, null], worse: [215500, iso('2026-10-26'), true, true, null] }, { plan: q1('plan', '2026-10-26'), worse: q1('worse', '2026-10-26') });
  key('G-001.q1.D2026-11-05', { plan: [205500, iso('2026-10-31'), true, true, null], worse: [205500, iso('2026-10-31'), true, true, null] }, { plan: q1('plan', '2026-11-05'), worse: q1('worse', '2026-11-05') });
  key('G-001.q1.D2026-11-30', { plan: [205500, iso('2026-10-31'), true, true, null], worse: [183000, iso('2026-11-14'), true, true, null] }, { plan: q1('plan', '2026-11-30'), worse: q1('worse', '2026-11-30') });
  key('G-001.q1.D2026-11-30.headroom', { plan: 155500, worse: 133000 }, { plan: a.q1.plan.min - B, worse: a.q1.worse.min - B }); // запас над буфером
  key('G-001.q1.D2026-11-30.need', { plan: 0, worse: 0 }, { plan: a.q1.plan.need, worse: a.q1.worse.need });
  const rw = { plan: runway_days(a.series.plan, a.events.plan), worse: runway_days(a.series.worse, a.events.worse) };
  key('G-001.runway_with', { plan: null, worse: null }, { plan: rw.plan.with, worse: rw.worse.with }); // «за горизонтом»: расходы 339000 < остатка 400000
  key('G-001.runway_without', { plan: null, worse: null }, { plan: rw.plan.without, worse: rw.worse.without });
})();

// ── §9.5: волны ───────────────────────────────────────────────────────────────────────────────────────────────────────

(function section_9_5() {
  const a = A['G-001'];
  const M = (mode, id) => list_waves(a, mode).find((x) => x.wave.event_ids.includes(id));
  const w1p = M('plan', 'P-TAX1');
  const w1w = M('worse', 'P-TAX1');
  key('G-001.waves.count', { plan: 2, worse: 2 }, { plan: list_waves(a, 'plan').length, worse: list_waves(a, 'worse').length });
  key('G-001.waves.w1.composition', { ids: ['P-TAX1', 'R-RENT@2026-10-25', 'R-UTIL@2026-10-25'], start: iso('2026-10-23'), end: iso('2026-10-26'), total_out: 152000 },
    { ids: w1p.wave.event_ids, start: w1p.wave.start, end: w1p.wave.end, total_out: w1p.wave.total_out_minor });
  const w2p = M('plan', 'R-RENT@2026-11-25');
  key('G-001.waves.w2.composition', { ids: ['R-RENT@2026-11-25', 'R-UTIL@2026-11-25'], start: iso('2026-11-25'), total_out: 102000 }, { ids: w2p.wave.event_ids, start: w2p.wave.start, total_out: w2p.wave.total_out_minor });
  key('G-001.waves.w1.need.plan', 222000, w1p.metrics.need_minor);
  key('G-001.waves.w1.need.worse', 244500, w1w.metrics.need_minor);
  key('G-001.waves.w2.need', { plan: 162000, worse: 162000 }, { plan: w2p.metrics.need_minor, worse: M('worse', 'R-RENT@2026-11-25').metrics.need_minor });
  const pick = (m) => ({ window_end: m.window_end, cash: m.cash_minor, min: m.min_trough, r: m.r_minor, need: m.need_minor, gap: m.gap_minor, cov: m.coverage_pm, reserved: m.reserved_minor });
  key('G-001.waves.w1.plan', { window_end: iso('2026-11-04'), cash: 377500, min: { date: iso('2026-10-31'), amount_minor: 205500 }, r: 172000, need: 222000, gap: 0, cov: 1700, reserved: 150000 }, pick(w1p.metrics));
  key('G-001.waves.w1.worse', { window_end: iso('2026-11-18'), cash: 377500, min: { date: iso('2026-11-14'), amount_minor: 183000 }, r: 194500, need: 244500, gap: 0, cov: 1543, reserved: 150000 }, pick(w1w.metrics));
  const w2 = { window_end: iso('2026-11-30'), cash: 452000, min: { date: iso('2026-11-28'), amount_minor: 340000 }, r: 112000, need: 162000, gap: 0, cov: 2790, reserved: 167800 };
  key('G-001.waves.w2', { plan: w2, worse: w2 }, { plan: pick(w2p.metrics), worse: pick(M('worse', 'R-RENT@2026-11-25').metrics) });
})();

// ── §9.6: Q3, дорожка 300,00 € на 2026-10-12 ───────────────────────────────────────────────────────────────────────────

(function section_9_6() {
  const a = A['G-001'];
  const r = check_purchase(a, buy(30000), B);
  key('G-001.q3.treadmill.m_after.plan', 63500, r.by_mode.plan.m_after);
  key('G-001.q3.treadmill.m_after.worse', 41000, r.by_mode.worse.m_after);
  key('G-001.q3.treadmill.at', { plan: iso('2026-11-01'), worse: iso('2026-11-14') }, { plan: r.by_mode.plan.at, worse: r.by_mode.worse.at });
  key('G-001.q3.treadmill.margin', { plan: 13500, worse: -9000 }, { plan: r.by_mode.plan.margin, worse: r.by_mode.worse.margin });
  key('G-001.q3.treadmill.delta', { plan: 30000, worse: 30000 }, { plan: r.by_mode.plan.delta, worse: r.by_mode.worse.delta });
  key('G-001.q3.treadmill.cash_gap', { plan: false, worse: false }, { plan: r.by_mode.plan.cash_gap, worse: r.by_mode.worse.cash_gap });
  key('G-001.q3.treadmill.verdict', 'FRAGILE', r.verdict);
  key('G-001.q3.treadmill.culprit', ['S-HOURLY@2026-11-05'], r.culprit_event_ids); // задержанный доход S-HOURLY (11-05 → 11-19)
  const sc = analyze(WS['G-001'], { as_of: WS['G-001'].as_of, scenario_id: 'scn-treadmill' });
  key('G-001.q3.treadmill.min_trough', { plan: { amount_minor: 175500, date: iso('2026-10-31') }, worse: { amount_minor: 153000, date: iso('2026-11-14') } },
    { plan: first_min(sc.series.plan.trough, sc.as_of), worse: first_min(sc.series.worse.trough, sc.as_of) });
  const by_S = [[15000, 78500, 56000, 'OK'], [21000, 72500, 50000, 'OK'], [30000, 63500, 41000, 'FRAGILE'], [43500, 50000, 27500, 'FRAGILE'], [60000, 33500, 11000, 'TIGHT'],
    [93500, 0, -22500, 'TIGHT'], [120000, -26500, -49000, 'NO']];
  for (const [S, mp, mw, v] of by_S) {
    const x = check_purchase(a, buy(S), B);
    key(`G-001.q3.S${S}`, { plan: mp, worse: mw, verdict: v }, { plan: x.by_mode.plan.m_after, worse: x.by_mode.worse.m_after, verdict: x.verdict });
  }
  const bounds = (S) => check_purchase(a, buy(S), B).verdict;
  key('G-001.q3.bounds', { OK: 21000, FRAGILE: [21001, 43500], TIGHT: [43501, 93500], NO: 93501 },
    { OK: bounds(21000) === 'OK' && bounds(21001) === 'FRAGILE' ? 21000 : null, FRAGILE: bounds(43500) === 'FRAGILE' && bounds(43501) === 'TIGHT' ? [21001, 43500] : null,
      TIGHT: bounds(93500) === 'TIGHT' && bounds(93501) === 'NO' ? [43501, 93500] : null, NO: bounds(93501) === 'NO' ? 93501 : null });
  key('G-001.q3.worse_gap.S93500', true, check_purchase(a, buy(93500), B).flags.worse_gap);
  key('G-001.q3.s_max', { plan: 43500, worse: 21000 }, { plan: max_amount(a, iso(D), B, 'plan'), worse: max_amount(a, iso(D), B, 'worse') });
  key('G-001.q3.s_max.as_of', { plan: 43500, worse: 21000 }, { plan: max_amount(a, a.as_of, B, 'plan'), worse: max_amount(a, a.as_of, B, 'worse') });
  const E = (S) => ({ plan: earliest_date(a, S, a.as_of, B, 'plan'), worse: earliest_date(a, S, a.as_of, B, 'worse') });
  key('G-001.q3.earliest.S15000', { plan: iso('2026-10-04'), worse: iso('2026-10-04') }, E(15000));
  key('G-001.q3.earliest.S30000', { plan: iso('2026-10-04'), worse: iso('2026-11-20') }, E(30000));
  key('G-001.q3.earliest.S60000', { plan: iso('2026-11-06'), worse: iso('2026-11-20') }, E(60000));
  key('G-001.q3.earliest.S90000', { plan: iso('2026-11-06'), worse: iso('2026-11-20') }, E(90000));
})();

// ── §9.7: safe-to-spend ───────────────────────────────────────────────────────────────────────────────────────────────

(function section_9_7() {
  const a = A['G-001'];
  const T = default_sts_horizon(a, a.as_of);
  key('G-001.sts.T_default', iso('2026-11-19'), T);
  const s = (d, m) => safe_to_spend(a, iso(d), B, m);
  key('G-001.sts.2026-10-31', { plan: 55500, worse: 55500 }, { plan: s('2026-10-31', 'plan').sts, worse: s('2026-10-31', 'worse').sts });
  key('G-001.sts.2026-10-31.min_free', { plan: 105500, worse: 105500 }, { plan: s('2026-10-31', 'plan').min_free, worse: s('2026-10-31', 'worse').min_free });
  key('G-001.sts.2026-11-19', { plan: 43500, worse: 21000 }, { plan: safe_to_spend(a, T, B, 'plan').sts, worse: safe_to_spend(a, T, B, 'worse').sts });
  key('G-001.sts.2026-11-19.min_free', { plan: 93500, worse: 71000 }, { plan: safe_to_spend(a, T, B, 'plan').min_free, worse: safe_to_spend(a, T, B, 'worse').min_free });
  key('G-001.sts.2026-11-30', { plan: 43500, worse: 21000 }, { plan: s('2026-11-30', 'plan').sts, worse: s('2026-11-30', 'worse').sts });
  key('G-001.sts.horizon', { plan: 43500, worse: 21000 }, { plan: max_amount(a, a.as_of, B, 'plan'), worse: max_amount(a, a.as_of, B, 'worse') }); // = S_max(as_of)
  key('G-001.sts.caption.reserves_at_min', 112000, a.series.worse.reserve_trough[iso('2026-11-14') - a.as_of]); // C-084: «резервы на момент минимума (14 ноября)»
  key('G-001.sts.caption.reserves_today', 150000, a.series.worse.reserve_opening_minor);
  key('G-001.sts.caption.formula', 21000, 183000 - 112000 - 50000);
})();

// ── §9.8: «почему», режим worse ────────────────────────────────────────────────────────────────────────────────────────

(function section_9_8() {
  const a = A['G-001'];
  const x = explain_narrowest(a.events.worse, a.series.worse, a.params);
  key('G-001.explain.point', { date: iso('2026-11-14'), amount_minor: 183000 }, x.point);
  key('G-001.explain.peak', { date: iso('2026-10-04'), amount_minor: 400000 }, x.peak);
  key('G-001.explain.drop', 217000, x.peak.amount_minor - x.point.amount_minor);
  key('G-001.explain.out_total', { out_total: 217000, inflow_offset: 0 }, { out_total: x.out_total_minor, inflow_offset: x.inflow_offset_minor });
  key('G-001.explain.chain', [[90000, 4147, 4147], [60000, 2765, 6912], [50000, 2304, 9217]], x.chain.map((c) => [c.amount_minor, c.share_bp, c.cum_bp]));
  key('G-001.explain.chain.groups', { first: 'R-RENT', second: 'R-GROC', third_has_P_TAX1: true }, { first: x.chain[0].group, second: x.chain[1].group, third_has_P_TAX1: x.chain[2].event_ids.includes('P-TAX1') });
  key('G-001.explain.chain.R-GROC.count', 6, x.chain[1].count);
  const cf = (pred) => x.counterfactuals.find(pred);
  const first_of = (c) => [c.new_min.amount_minor, c.new_min.date, c.delta_minor];
  key('G-001.explain.cf.without_rent', [273000, iso('2026-11-14'), 90000], first_of(cf((c) => c.kind === 'without' && c.group === 'R-RENT')));
  key('G-001.explain.cf.without_groc', [243000, iso('2026-11-09'), 60000], first_of(cf((c) => c.kind === 'without' && c.group === 'R-GROC')));
  key('G-001.explain.cf.without_tax', [233000, iso('2026-11-14'), 50000], first_of(x.counterfactuals.find((c) => c.kind === 'without' && x.chain[2].group === c.group)));
  key('G-001.explain.cf.no_delay', [205500, iso('2026-10-31'), 22500], first_of(cf((c) => c.kind === 'no_delay')));
})();

// ── §9.9: варианты ────────────────────────────────────────────────────────────────────────────────────────────────────

(function section_9_9_low_gap() {
  const low = A['G-001-low'];
  const gap = A['G-001-gap'];
  key('G-001-low.opening', 220000, low.series.plan.opening_minor);
  key('G-001-low.q1.min_trough', { plan: [25500, iso('2026-10-31')], worse: [3000, iso('2026-11-14')] }, { plan: [low.q1.plan.min, low.q1.plan.at], worse: [low.q1.worse.min, low.q1.worse.at] });
  key('G-001-low.q1.ok_buffer', { plan: false, worse: false }, { plan: low.q1.plan.ok_buffer, worse: low.q1.worse.ok_buffer });
  key('G-001-low.q1.need', { plan: 24500, worse: 47000 }, { plan: low.q1.plan.need, worse: low.q1.worse.need });
  key('G-001-low.free.min', { plan: { amount_minor: -86500, date: iso('2026-11-01') }, worse: { amount_minor: -109000, date: iso('2026-11-14') } },
    { plan: first_min(low.series.plan.free, low.as_of), worse: first_min(low.series.worse.free, low.as_of) });
  const sl = (m) => safe_to_spend(low, low.horizon_end, B, m);
  key('G-001-low.sts', { plan: 0, worse: 0 }, { plan: sl('plan').sts, worse: sl('worse').sts });
  key('G-001-low.short_to_buffer', { plan: 136500, worse: 159000 }, { plan: sl('plan').short_to_buffer, worse: sl('worse').short_to_buffer });
  const ql = check_purchase(low, buy(1), B);
  key('G-001-low.q3', { verdict: 'NO', s_max: { plan: 0, worse: 0 }, earliest: { plan: null, worse: null } }, { verdict: ql.verdict, s_max: ql.s_max, earliest: ql.earliest });
  const wl = (mode, id) => list_waves(low, mode).find((x) => x.wave.event_ids.includes(id)).metrics;
  key('G-001-low.waves.w1.plan', { cash: 197500, need: 222000, gap: 24500, cov: 889 }, { cash: wl('plan', 'P-TAX1').cash_minor, need: wl('plan', 'P-TAX1').need_minor, gap: wl('plan', 'P-TAX1').gap_minor, cov: wl('plan', 'P-TAX1').coverage_pm });
  key('G-001-low.waves.w1.worse', { need: 244500, gap: 47000, cov: 807 }, { need: wl('worse', 'P-TAX1').need_minor, gap: wl('worse', 'P-TAX1').gap_minor, cov: wl('worse', 'P-TAX1').coverage_pm });
  const l2 = wl('plan', 'R-RENT@2026-11-25');
  key('G-001-low.waves.w2', { cash: 272000, min: { date: iso('2026-11-28'), amount_minor: 160000 }, need: 162000, gap: 0, cov: 1679 }, { cash: l2.cash_minor, min: l2.min_trough, need: l2.need_minor, gap: l2.gap_minor, cov: l2.coverage_pm });

  key('G-001-gap.opening', 100000, gap.series.plan.opening_minor);
  const fb = (m) => { const i = gap.series[m].trough.findIndex((v) => v < 0); return i < 0 ? null : { date: gap.as_of + i, amount_minor: gap.series[m].trough[i] }; };
  key('G-001-gap.first_breach', { plan: { date: iso('2026-10-26'), amount_minor: -84500 }, worse: { date: iso('2026-10-26'), amount_minor: -84500 } }, { plan: fb('plan'), worse: fb('worse') });
  key('G-001-gap.runway_with', { date: iso('2026-10-26'), days: 22 }, runway_days(gap.series.plan, gap.events.plan).with);
  key('G-001-gap.q1.min_trough', { plan: [-94500, iso('2026-10-31')], worse: [-117000, iso('2026-11-14')] }, { plan: [gap.q1.plan.min, gap.q1.plan.at], worse: [gap.q1.worse.min, gap.q1.worse.at] });
  key('G-001-gap.q1.need', { plan: 144500, worse: 167000 }, { plan: gap.q1.plan.need, worse: gap.q1.worse.need });
  key('G-001-gap.free.min', { plan: { amount_minor: -206500, date: iso('2026-11-01') }, worse: { amount_minor: -229000, date: iso('2026-11-14') } },
    { plan: first_min(gap.series.plan.free, gap.as_of), worse: first_min(gap.series.worse.free, gap.as_of) });
  key('G-001-gap.short_to_buffer', { plan: 256500, worse: 279000 }, { plan: safe_to_spend(gap, gap.horizon_end, B, 'plan').short_to_buffer, worse: safe_to_spend(gap, gap.horizon_end, B, 'worse').short_to_buffer });
  const wg = (mode, id) => list_waves(gap, mode).find((x) => x.wave.event_ids.includes(id)).metrics;
  key('G-001-gap.waves.w1', { plan: { cash: 77500, gap: 144500, cov: 349 }, worse: { gap: 167000, cov: 316 } },
    { plan: { cash: wg('plan', 'P-TAX1').cash_minor, gap: wg('plan', 'P-TAX1').gap_minor, cov: wg('plan', 'P-TAX1').coverage_pm }, worse: { gap: wg('worse', 'P-TAX1').gap_minor, cov: wg('worse', 'P-TAX1').coverage_pm } });
  const g2 = wg('plan', 'R-RENT@2026-11-25');
  key('G-001-gap.waves.w2', { cash: 152000, min: { date: iso('2026-11-28'), amount_minor: 40000 }, gap: 10000, cov: 938 }, { cash: g2.cash_minor, min: g2.min_trough, gap: g2.gap_minor, cov: g2.coverage_pm });
})();

(function section_9_9_late() {
  const late = A['G-001-late'];
  const T = default_sts_horizon(late, late.as_of);
  key('G-001-late.sts.2026-11-19', { plan: 43500, worse: 21000 }, { plan: safe_to_spend(late, T, B, 'plan').sts, worse: safe_to_spend(late, T, B, 'worse').sts });
  key('G-001-late.min_free.horizon', { amount_minor: -77800, date: iso('2026-11-28') }, first_min(late.series.plan.free, late.as_of));
  key('G-001-late.min_free.horizon.worse', { amount_minor: -77800, date: iso('2026-11-28') }, first_min(late.series.worse.free, late.as_of));
  key('G-001-late.trough_and_reserve', { trough: 90000, reserve_trough: 167800 }, { trough: late.series.plan.trough[iso('2026-11-28') - late.as_of], reserve_trough: late.series.plan.reserve_trough[iso('2026-11-28') - late.as_of] });
  key('G-001-late.sts_horizon', { plan: 0, worse: 0 }, { plan: safe_to_spend(late, late.horizon_end, B, 'plan').sts_horizon, worse: safe_to_spend(late, late.horizon_end, B, 'worse').sts_horizon });
  key('G-001-late.short_to_buffer', { plan: 127800, worse: 127800 }, { plan: safe_to_spend(late, late.horizon_end, B, 'plan').short_to_buffer, worse: safe_to_spend(late, late.horizon_end, B, 'worse').short_to_buffer });
  key('G-001-late.s_max', { plan: 0, worse: 0 }, { plan: max_amount(late, late.as_of, B, 'plan'), worse: max_amount(late, late.as_of, B, 'worse') });
  key('G-001-late.earliest', { plan: null, worse: null }, { plan: earliest_date(late, 1, late.as_of, B, 'plan'), worse: earliest_date(late, 1, late.as_of, B, 'worse') });
  key('G-001-late.baseline_below_buffer', true, check_purchase(late, buy(1), B).flags.baseline_below_buffer);
  key('G-001-late.verdict_not_OK', true, check_purchase(late, buy(1), B).verdict !== 'OK');
})();

// ── проверка всех ключей ──────────────────────────────────────────────────────────────────────────────────────────────

test('G-001 golden: набор ключей §9.4–§9.9 полон (ключи, обязательные по канону, присутствуют) и у каждого ключа есть значение движка', () => {
  const required = [
    'G-001.opening', 'G-001.end_close.plan', 'G-001.end_close.worse', 'G-001.q1.min_trough.plan', 'G-001.q1.min_trough.worse', 'G-001.free.min.plan', 'G-001.free.min.worse',
    'G-001.reserve_close.end', 'G-001.waves.w1.need.plan', 'G-001.waves.w1.need.worse', 'G-001.waves.w2.need', 'G-001.q3.treadmill.m_after.plan', 'G-001.q3.treadmill.m_after.worse',
    'G-001.q3.treadmill.verdict', 'G-001.q3.s_max', 'G-001.q3.earliest.S30000', 'G-001.sts.2026-11-19', 'G-001.explain.chain', 'G-001-low.short_to_buffer', 'G-001-gap.short_to_buffer', 'G-001-late.sts_horizon',
  ];
  for (const k of required) assert.ok(k in EXPECTED, `ключ ${k}`);
  assert.deepEqual(Object.keys(ACTUAL), Object.keys(EXPECTED));
  assert.ok(Object.keys(EXPECTED).length >= 140, `ключей: ${Object.keys(EXPECTED).length}`);
  assert.ok(Object.keys(EXPECTED).every((k) => ACTUAL[k] !== undefined), 'значения движка определены');
});

const GROUPS = [
  ['§9.3–§9.4 готовность, ряды, Q1 (TST-01, TST-02, TST-57)', (k) => /^G-001\.(readiness|anchor|opening|end_close|q1|free|reserve_close|horizon|table|runway)/.test(k)],
  ['§9.5 волны (TST-03)', (k) => /^G-001\.waves/.test(k)],
  ['§9.6 Q3: вердикты, максимум, ранняя дата (TST-04, TST-05)', (k) => /^G-001\.q3/.test(k)],
  ['§9.7 safe-to-spend (TST-06)', (k) => /^G-001\.sts/.test(k)],
  ['§9.8 «почему» (TST-07)', (k) => /^G-001\.explain/.test(k)],
  ['§9.9 G-001-low (TST-08)', (k) => /^G-001-low/.test(k)],
  ['§9.9 G-001-gap (TST-09)', (k) => /^G-001-gap/.test(k)],
  ['§9.9 G-001-late (TST-39, C-058)', (k) => /^G-001-late/.test(k)],
];

for (const [title, pred] of GROUPS) {
  test(`G-001 golden: ${title}`, () => {
    const keys = Object.keys(EXPECTED).filter(pred);
    assert.ok(keys.length > 0, 'в группе есть ключи');
    const bad = keys.filter((k) => !isDeepStrictEqual(ACTUAL[k], EXPECTED[k])).map((k) => ({ key: k, expected: EXPECTED[k], actual: ACTUAL[k] }));
    assert.deepEqual(bad, [], `расхождения с каноном: ${bad.map((b) => b.key).join(', ')}`);
  });
}

test('G-001 golden: все группы покрывают весь набор ключей (ни один ключ не остался без проверки)', () => {
  const covered = new Set();
  for (const [, pred] of GROUPS) for (const k of Object.keys(EXPECTED).filter(pred)) covered.add(k);
  const missed = Object.keys(EXPECTED).filter((k) => !covered.has(k));
  assert.deepEqual(missed, []);
});
