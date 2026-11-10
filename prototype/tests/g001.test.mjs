// g001.test.mjs — golden-тесты сквозного примера G-001 «Ян» на данных prototype/data/g001*.json (design-brief §9, ADR-014 п. 1).
// Покрывает TST-01, TST-02, TST-07, TST-09, TST-10, TST-41 (часть), TST-57 (часть) и проверку самих датасетов (G-001-low, -gap, -late).
// ВАЖНО (X2): все числа воспроизводятся только при ЯВНОМ горизонте 57 дн. (`horizon_days = 57` в params датасета).
// Числа ожидаемых значений берутся из канона ДОСЛОВНО; код движка в ожиданиях не участвует. В тестах допустимы node:fs и Date.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { parse_date, format_date, make_calendar } from '../engine/dates.mjs';
import { mul_div } from '../engine/money.mjs';
import { validate_rule } from '../engine/recurrence.mjs';
import { validate_stream, gross_pay, expand_stream_ex, period_bounds, shortfall } from '../engine/hourly.mjs';
import { validate_tax_rule, allocation_for_income } from '../engine/tax.mjs';
import { contribution_allocations, reserve_open, reserve_series, free_series } from '../engine/sinking.mjs';
import {
  opening_state, build_events, build_events_ex, project, narrowest_point, answer_q1, runway_days, explain_narrowest, apply_scenario,
  outflow_90, buffer_hint, default_wave_threshold, readiness, anchor_status, normalize_ws, plan_from, argmin_first,
} from '../engine/timeline.mjs';

const DATA = new URL('../data/', import.meta.url);
const load = (name) => JSON.parse(fs.readFileSync(new URL(name, DATA), 'utf8'));
const iso = (s) => parse_date(s);
const AS_OF = iso('2026-10-04'); // 20730
const HORIZON_END = iso('2026-11-30'); // 20787

/** Полный прогон режима: опорный остаток → события → ряды → резервы (sinking из L1) → free. */
function run(ws, mode, extra = {}) {
  const as_of = iso(ws.as_of);
  const hz = as_of + (extra.horizon_days ?? ws.params.horizon_days);
  const os = opening_state(ws, as_of);
  const bx = build_events_ex(ws, { as_of, horizon_end: hz, mode, ...extra });
  const series = project(bx.events, os.opening_minor, as_of, hz);
  const recorded = ws.allocations ?? [];
  const reserves = ws.reserves.map((r) => ({ ...r, funded_open_minor: reserve_open(r, recorded, as_of) }));
  const cal = make_calendar(ws.calendars[0]);
  const ids = recorded.map((a) => a.allocation_id);
  const sched = reserves.filter((r) => r.kind === 'sinking').flatMap((r) => contribution_allocations(r, r.funded_open_minor, as_of, hz, cal, ids));
  const rs = reserve_series(reserves, bx.events, [...bx.allocations, ...sched], as_of, hz);
  const free = free_series(series.trough, rs.reserve_trough);
  return { as_of, hz, os, bx, series, rs, free, reserves };
}

const G = load('g001.json');
const LOW = load('g001-low.json');
const GAP = load('g001-gap.json');
const LATE = load('g001-late.json');

// ── сам датасет ───────────────────────────────────────────────────────────────────────────────────────────────────────

test('G-001 датасет: форма по модели данных §3, горизонт 57 дн. (X2), нет float, единое пространство Id (C-025), факты не позже as_of', () => {
  for (const ws of [G, LOW, GAP, LATE]) {
    assert.equal(ws.params.horizon_days, 57, 'X2: числа G-001 только при horizon_days = 57');
    assert.equal(ws.decision_currency, 'EUR');
    assert.equal(ws.format, 'runway-journal/1');
    assert.equal(ws.params.buffer_minor, 50000);
    assert.equal(ws.params['worse.income_delay_days'], 14);
    assert.deepEqual([ws.params['wave.gap_days'], ws.params['wave.max_span_days'], ws.params['wave.threshold_minor']], [3, 10, 3000]);
    const walk = (x, path) => {
      if (typeof x === 'number') assert.ok(Number.isSafeInteger(x), `float/не-safe в ${path}: ${x}`);
      else if (Array.isArray(x)) x.forEach((v, i) => walk(v, `${path}[${i}]`));
      else if (x !== null && typeof x === 'object') for (const k of Object.keys(x)) walk(x[k], `${path}.${k}`);
    };
    walk(ws, 'ws');
    for (const r of ws.rules) assert.equal(validate_rule(r).ok, true, `правило ${r.rule_id}`);
    for (const s of ws.streams) assert.equal(validate_stream(s).ok, true, `поток ${s.stream_id}`);
    for (const t of ws.tax_rules) assert.equal(validate_tax_rule(t).ok, true, `налоговое правило ${t.tax_rule_id}`);
    const ids = [...ws.rules.map((r) => r.rule_id), ...ws.streams.map((s) => s.stream_id), ...ws.tax_rules.map((t) => t.tax_rule_id), ...ws.reserves.map((r) => r.reserve_id), ...ws.plans.map((p) => p.plan_id)];
    assert.equal(new Set(ids).size, ids.length, 'Id единого пространства имён не повторяются');
    for (const f of ws.facts) assert.ok(f.date <= ws.as_of, `posted ${f.event_id} позже as_of`);
    for (const r of ws.reserves) assert.equal(r.currency, ws.decision_currency, 'резерв хранится в валюте решения (X4)');
  }
  assert.equal(G.anchors.at(-1).amount_minor, 400000);
  assert.equal(LOW.anchors.at(-1).amount_minor, 220000);
  assert.equal(GAP.anchors.at(-1).amount_minor, 100000);
  assert.equal(AS_OF, 20730);
  assert.equal(HORIZON_END, 20787);
  assert.equal(HORIZON_END - AS_OF + 1, 58, 'N = 58');
});

test('G-001 подсказки по истории (D-03, X1, C-022): outflow_90 = 630000, buffer_hint = 49000, порог волны = max(3000, 2100) = 3000', () => {
  assert.equal(outflow_90(G, AS_OF), 630000);
  assert.equal(buffer_hint(G, AS_OF), 49000); // round_div(7 · 630000, 90)
  assert.equal(default_wave_threshold(G, AS_OF), 3000);
  assert.equal(G.params['wave.threshold_minor'], 3000);
  // нет истории — null и порог 30·10^exp
  const bare = { ...G, facts: [] };
  assert.equal(outflow_90(bare, AS_OF), null);
  assert.equal(buffer_hint(bare, AS_OF), null);
  assert.equal(default_wave_threshold(bare, AS_OF), 3000);
});

// ── TST-01 ────────────────────────────────────────────────────────────────────────────────────────────────────────────

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

test('TST-01 G-001: ряды trough/close обоих режимов по таблице §9.4 для всех 58 дней (дни без событий — значения предыдущей строки)', () => {
  const plan = run(G, 'plan');
  const worse = run(G, 'worse');
  assert.equal(plan.series.trough.length, 58);
  const by_date = new Map(TABLE.map((r) => [iso(r[0]), r]));
  // дни без событий: close = close предыдущего дня, trough = close предыдущего дня (нет расходов дня).
  // Замечание к §9.4 («значения предыдущей строки сохраняются»): для trough это верно, только если в предыдущей строке trough = close;
  // на следующий день после дохода (11-06 plan, 11-20 worse) trough равен close дня дохода — см. spec_issues отчёта.
  let prev_close = { plan: null, worse: null };
  for (let i = 0; i < 58; i++) {
    const d = AS_OF + i;
    const row = by_date.get(d);
    const where = format_date(d);
    const exp = row !== undefined
      ? { pt: row[1], pc: row[2], wt: row[5], wc: row[6] }
      : { pt: prev_close.plan, pc: prev_close.plan, wt: prev_close.worse, wc: prev_close.worse };
    assert.equal(plan.series.trough[i], exp.pt, `trough plan ${where}`);
    assert.equal(plan.series.close[i], exp.pc, `close plan ${where}`);
    assert.equal(worse.series.trough[i], exp.wt, `trough worse ${where}`);
    assert.equal(worse.series.close[i], exp.wc, `close worse ${where}`);
    prev_close = { plan: exp.pc, worse: exp.wc };
  }
});

test('TST-01 G-001: opening 400000; end_close 340000 в обоих режимах; min trough 205500 · 2026-10-31 (plan) и 183000 · 2026-11-14 (worse)', () => {
  const plan = run(G, 'plan');
  const worse = run(G, 'worse');
  assert.equal(plan.os.opening_minor, 400000); // G-001.opening
  assert.equal(plan.series.opening_minor, 400000);
  assert.equal(plan.series.close.at(-1), 340000); // G-001.end_close
  assert.equal(worse.series.close.at(-1), 340000);
  assert.deepEqual(narrowest_point(plan.series, AS_OF, HORIZON_END), { date: iso('2026-10-31'), amount_minor: 205500 }); // G-001.q1.min_trough.plan
  assert.deepEqual(narrowest_point(worse.series, AS_OF, HORIZON_END), { date: iso('2026-11-14'), amount_minor: 183000 }); // G-001.q1.min_trough.worse
  // «то же значение на 11-01…11-05 (plan) и до 11-19 (worse)» — побеждает первая дата
  assert.equal(plan.series.trough[iso('2026-11-05') - AS_OF], 205500);
  assert.equal(worse.series.trough[iso('2026-11-19') - AS_OF], 183000);
  assert.equal(plan.os.drift, 0, 'расхождение якоря с проведёнными — 0 (вторая точка якоря согласована)');
  assert.equal(plan.os.anchor_age, 0);
  assert.deepEqual(plan.os.stale_accounts, []);
});

test('TST-01 G-001: Q1 — к 10-26 → 215500; к 11-05 → 205500 (10-31); к 11-30 → 205500 / 183000; ok_cash, ok_buffer, first_breach = null, need = 0', () => {
  const plan = run(G, 'plan');
  const worse = run(G, 'worse');
  const B = 50000;
  for (const r of [plan, worse]) {
    const a = answer_q1(r.series, iso('2026-10-26'), B);
    assert.deepEqual([a.min, a.at], [215500, iso('2026-10-26')]);
    const b = answer_q1(r.series, iso('2026-11-05'), B);
    assert.deepEqual([b.min, b.at], [205500, iso('2026-10-31')]);
    for (const q of [a, b, answer_q1(r.series, HORIZON_END, B)]) {
      assert.equal(q.ok_cash, true);
      assert.equal(q.ok_buffer, true);
      assert.equal(q.first_breach, null);
      assert.equal(q.first_buffer_breach, null);
      assert.equal(q.need, 0);
    }
  }
  const p30 = answer_q1(plan.series, HORIZON_END, B);
  const w30 = answer_q1(worse.series, HORIZON_END, B);
  assert.deepEqual([p30.min, p30.at], [205500, iso('2026-10-31')]);
  assert.deepEqual([w30.min, w30.at], [183000, iso('2026-11-14')]);
  assert.equal(p30.min - B, 155500); // запас над буфером к 11-30
  assert.equal(w30.min - B, 133000);
  assert.equal(p30.close_on_D, 340000);
  assert.deepEqual(answer_q1(plan.series, HORIZON_END + 1, B), { beyond_horizon: true });
  for (const r of [plan, worse]) {
    assert.deepEqual(runway_days(r.series, r.bx.events), { with: null, without: null }); // расходы 339000 < остатка 400000
  }
});

test('TST-01 G-001: события режимов — 16 штук, суммы расходов 339000 и дохода 279000; worse сдвигает ТОЛЬКО доход на 14 дн., plan_date хранит 2026-11-05', () => {
  const plan = run(G, 'plan').bx.events;
  const worse = run(G, 'worse').bx.events;
  assert.equal(plan.length, 16);
  assert.equal(worse.length, 16);
  const sum = (evs, f) => evs.filter(f).reduce((s, e) => s + e.amount_minor, 0);
  assert.equal(sum(plan, (e) => e.amount_minor < 0), -339000); // 204000 + 5000 + 80000 + 50000
  assert.equal(sum(plan, (e) => e.amount_minor > 0), 279000);
  const inc_p = plan.find((e) => e.kind === 'income');
  const inc_w = worse.find((e) => e.kind === 'income');
  assert.equal(format_date(inc_p.date), '2026-11-05');
  assert.equal(format_date(inc_w.date), '2026-11-19');
  assert.equal(inc_w.plan_date, iso('2026-11-05'));
  assert.equal(inc_w.stream_id, 'S-HOURLY');
  assert.equal(inc_w.rule_id, null);
  assert.equal(inc_w.occ_key, 'S-HOURLY@2026-11-05');
  // расходы: даты и суммы одинаковы в режимах
  const exp = (evs) => evs.filter((e) => e.amount_minor < 0).map((e) => [e.date, e.amount_minor, e.cash_event_id]);
  assert.deepEqual(exp(plan), exp(worse));
  // аренда и ЖКХ — 10-26 (25-е — воскресенье, сдвиг next), 11-25; связь — 10-09, 11-09; продукты — 8 суббот
  const dates_of = (id) => plan.filter((e) => e.rule_id === id).map((e) => format_date(e.date));
  assert.deepEqual(dates_of('R-RENT'), ['2026-10-26', '2026-11-25']);
  assert.deepEqual(dates_of('R-UTIL'), ['2026-10-26', '2026-11-25']);
  assert.deepEqual(dates_of('R-PHONE'), ['2026-10-09', '2026-11-09']);
  assert.deepEqual(dates_of('R-GROC'), ['2026-10-10', '2026-10-17', '2026-10-24', '2026-10-31', '2026-11-07', '2026-11-14', '2026-11-21', '2026-11-28']);
  assert.equal(plan.find((e) => e.cash_event_id === 'P-TAX1').is_obligation, true);
  // сентябрьская выплата (план на 10-05) сопоставлена с фактом от 10-02 и в поток не входит
  assert.ok(!plan.some((e) => e.occ_key === 'S-HOURLY@2026-09-30'));
});

// ── TST-02 ────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('TST-02 G-001: резервы и free по таблице §9.4 (reserve_open = 150000, free[0] = 250000, взнос RES-INS 11-01, релиз налога 10-23)', () => {
  const plan = run(G, 'plan');
  const worse = run(G, 'worse');
  const tax = plan.reserves.find((r) => r.reserve_id === 'RES-TAX');
  assert.equal(tax.funded_open_minor, 150000);
  assert.equal(plan.free[0], 250000);
  assert.equal(worse.free[0], 250000);
  const by_date = new Map(TABLE.map((r) => [iso(r[0]), r]));
  for (const [d, row] of by_date) {
    const i = d - AS_OF;
    assert.equal(plan.rs.reserve_trough[i], row[3], `Rт plan ${format_date(d)}`);
    assert.equal(plan.free[i], row[4], `F plan ${format_date(d)}`);
    assert.equal(worse.rs.reserve_trough[i], row[7], `Rт worse ${format_date(d)}`);
    assert.equal(worse.free[i], row[8], `F worse ${format_date(d)}`);
  }
  // аллокация 55800 входит в reserve_close в день дохода и в reserve_trough — со следующего дня
  const i5 = iso('2026-11-05') - AS_OF;
  assert.equal(plan.rs.reserve_trough[i5], 112000);
  assert.equal(plan.rs.reserve_close[i5], 167800);
  assert.equal(plan.rs.reserve_trough[i5 + 1], 167800);
  const i19 = iso('2026-11-19') - AS_OF;
  assert.equal(worse.rs.reserve_trough[i19], 112000);
  assert.equal(worse.rs.reserve_close[i19], 167800);
  assert.equal(worse.rs.reserve_trough[i19 + 1], 167800);
  // free min: 93500 · 2026-11-01 (plan), 71000 · 2026-11-14 (worse); конец: reserve_close 167800 = 155800 + 12000
  const fp = argmin_first(plan.free, 0, 57);
  const fw = argmin_first(worse.free, 0, 57);
  assert.deepEqual([plan.free[fp], format_date(AS_OF + fp)], [93500, '2026-11-01']); // G-001.free.min.plan
  assert.deepEqual([worse.free[fw], format_date(AS_OF + fw)], [71000, '2026-11-14']); // G-001.free.min.worse
  for (const r of [plan, worse]) {
    assert.equal(r.rs.reserve_close.at(-1), 167800); // G-001.reserve_close.end
    assert.equal(r.rs.by_reserve['RES-TAX'].close.at(-1), 155800); // 150000 − 50000 + 55800
    assert.equal(r.rs.by_reserve['RES-INS'].close.at(-1), 12000);
    assert.equal(r.series.close.at(-1) - r.rs.reserve_close.at(-1), 340000 - 167800, 'резерв не меняет close');
  }
  // резерв не меняет close и trough (D-07): те же ряды без резервов
  const bare = run({ ...G, reserves: [], tax_rules: [] }, 'plan');
  assert.deepEqual(bare.series.trough, plan.series.trough);
  assert.deepEqual(bare.free, bare.series.trough, 'без резервов free = trough');
});

test('TST-02/TST-08 G-001 налоговая аллокация: версия правила выбирается по base(e) — аллокации plan и worse равны (C-016), allocation_id детерминирован', () => {
  const p = build_events_ex(G, { as_of: AS_OF, horizon_end: HORIZON_END, mode: 'plan' }).allocations;
  const w = build_events_ex(G, { as_of: AS_OF, horizon_end: HORIZON_END, mode: 'worse' }).allocations;
  assert.equal(p.length, 1);
  assert.equal(p[0].amount_minor, 55800);
  assert.equal(p[0].allocation_id, 'tax:TR-20@S-HOURLY@2026-11-05');
  assert.equal(p[0].reserve_id, 'RES-TAX');
  assert.equal(p[0].rule_version, 1);
  assert.equal(p[0].date, iso('2026-11-05'));
  assert.equal(w[0].date, iso('2026-11-19'));
  assert.equal(w[0].amount_minor, p[0].amount_minor);
});

// ── TST-07 ────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('TST-07 G-001: «почему» в режиме worse — точка 183000 · 11-14, пик 400000 · 10-04, out_total 217000, цепочка 4147/2765/2304 (накоплено 9217), контрфакты', () => {
  const worse = run(G, 'worse');
  const x = explain_narrowest(worse.bx.events, worse.series, G.params);
  assert.deepEqual(x.point, { date: iso('2026-11-14'), amount_minor: 183000 });
  assert.deepEqual(x.peak, { date: AS_OF, amount_minor: 400000 });
  assert.equal(x.out_total_minor, 217000);
  assert.equal(x.inflow_offset_minor, 0);
  assert.equal(x.peak.amount_minor - x.point.amount_minor, x.out_total_minor - x.inflow_offset_minor, 'peak − point = out_total − inflow_offset (217000)');
  assert.deepEqual(x.chain.map((c) => c.group), ['R-RENT', 'R-GROC', 'tag:налог']);
  assert.deepEqual(x.chain.map((c) => c.amount_minor), [90000, 60000, 50000]);
  assert.deepEqual(x.chain.map((c) => c.share_bp), [4147, 2765, 2304]);
  assert.deepEqual(x.chain.map((c) => c.cum_bp), [4147, 6912, 9217]); // накопленная доля от накопленной суммы: 9217, не 9216
  assert.equal(x.chain[1].count, 6); // продукты: 6 событий
  assert.deepEqual(x.chain[2].event_ids, ['P-TAX1']);
  assert.ok(x.chain.at(-1).cum_bp >= 9000, 'стоп на накопленной доле ≥ 9000 bp');
  const cf = x.counterfactuals;
  const f = (kind, key) => cf.find((c) => c.kind === kind && (c.group === key || c.event_id === key));
  assert.deepEqual(f('without', 'R-RENT').new_min, { date: iso('2026-11-14'), amount_minor: 273000 });
  assert.equal(f('without', 'R-RENT').delta_minor, 90000);
  assert.deepEqual(f('without', 'R-GROC').new_min, { date: iso('2026-11-09'), amount_minor: 243000 });
  assert.equal(f('without', 'R-GROC').delta_minor, 60000);
  assert.deepEqual(f('without', 'tag:налог').new_min, { date: iso('2026-11-14'), amount_minor: 233000 });
  assert.equal(f('without', 'tag:налог').delta_minor, 50000);
  const nd = f('no_delay', 'S-HOURLY@2026-11-05');
  assert.deepEqual(nd.new_min, { date: iso('2026-10-31'), amount_minor: 205500 }); // доход вовремя
  assert.equal(nd.delta_minor, 22500);
  assert.equal(cf.length, 4);
  // ниже порога цепочки: ЖКХ 12000 (553 bp) и связь 5000 (230 bp) — не в цепочке
  assert.ok(!x.chain.some((c) => c.group === 'R-UTIL' || c.group === 'R-PHONE'));
});

test('TST-07 explain в режиме plan: узкая точка 205500 · 10-31, пик 400000, окно расходов 194500 (без дохода: он 11-05 после точки)', () => {
  const plan = run(G, 'plan');
  const x = explain_narrowest(plan.bx.events, plan.series, G.params);
  assert.deepEqual(x.point, { date: iso('2026-10-31'), amount_minor: 205500 });
  assert.equal(x.out_total_minor, 194500);
  assert.equal(x.peak.amount_minor - x.point.amount_minor, 194500);
  assert.equal(x.counterfactuals.filter((c) => c.kind === 'no_delay').length, 0, 'в plan задержанных доходов нет');
});

// ── TST-09 и варианты ────────────────────────────────────────────────────────────────────────────────────────────────

test('TST-09 G-001-gap: кассовый разрыв — первая дата trough < 0 = 2026-10-26 (−84500), runway_with через 22 дня, first_buffer_breach 10-23, need 144500 / 167000', () => {
  const plan = run(GAP, 'plan');
  const worse = run(GAP, 'worse');
  assert.equal(plan.os.opening_minor, 100000);
  const B = 50000;
  const q = answer_q1(plan.series, HORIZON_END, B);
  assert.equal(q.first_breach, iso('2026-10-26'));
  assert.equal(plan.series.trough[iso('2026-10-26') - AS_OF], -84500);
  assert.equal(q.first_buffer_breach, iso('2026-10-23'));
  assert.equal(plan.series.trough[iso('2026-10-23') - AS_OF], 27500);
  assert.equal(plan.series.close[iso('2026-10-24') - AS_OF], 17500);
  assert.deepEqual(narrowest_point(plan.series, AS_OF, HORIZON_END), { date: iso('2026-10-31'), amount_minor: -94500 });
  assert.deepEqual(narrowest_point(worse.series, AS_OF, HORIZON_END), { date: iso('2026-11-14'), amount_minor: -117000 });
  assert.equal(q.ok_cash, false);
  assert.equal(q.need, 144500);
  assert.equal(answer_q1(worse.series, HORIZON_END, B).need, 167000);
  assert.deepEqual(runway_days(plan.series, plan.bx.events).with, { date: iso('2026-10-26'), days: 22 });
  assert.deepEqual(runway_days(worse.series, worse.bx.events).with, { date: iso('2026-10-26'), days: 22 });
  // свободные деньги: min free −206500 · 11-01 / −229000 · 11-14 → short_to_buffer = B − min free = 256500 / 279000
  const fp = argmin_first(plan.free, 0, 57);
  const fw = argmin_first(worse.free, 0, 57);
  assert.deepEqual([plan.free[fp], format_date(AS_OF + fp)], [-206500, '2026-11-01']);
  assert.deepEqual([worse.free[fw], format_date(AS_OF + fw)], [-229000, '2026-11-14']);
  assert.equal(B - plan.free[fp], 256500);
  assert.equal(B - worse.free[fw], 279000);
  // кассовые денежные потоки волн: cash_w = close[w.start − 1]: W1 — 77500, W2 — 152000; min в окне W2 — 40000 · 11-28
  assert.equal(plan.series.close[iso('2026-10-22') - AS_OF], 77500);
  assert.equal(plan.series.close[iso('2026-11-24') - AS_OF], 152000);
  assert.equal(plan.series.trough[iso('2026-11-28') - AS_OF], 40000);
});

test('G-001-low: min trough 25500 · 10-31 (plan) / 3000 · 11-14 (worse), need 24500 / 47000, min free −86500 · 11-01 / −109000 · 11-14 (short_to_buffer 136500 / 159000)', () => {
  const plan = run(LOW, 'plan');
  const worse = run(LOW, 'worse');
  const B = 50000;
  assert.deepEqual(narrowest_point(plan.series, AS_OF, HORIZON_END), { date: iso('2026-10-31'), amount_minor: 25500 });
  assert.deepEqual(narrowest_point(worse.series, AS_OF, HORIZON_END), { date: iso('2026-11-14'), amount_minor: 3000 });
  const qp = answer_q1(plan.series, HORIZON_END, B);
  const qw = answer_q1(worse.series, HORIZON_END, B);
  assert.equal(qp.ok_buffer, false);
  assert.equal(qp.ok_cash, true);
  assert.equal([qp.need, qw.need].join('/'), '24500/47000');
  const fp = argmin_first(plan.free, 0, 57);
  const fw = argmin_first(worse.free, 0, 57);
  assert.deepEqual([plan.free[fp], format_date(AS_OF + fp)], [-86500, '2026-11-01']);
  assert.deepEqual([worse.free[fw], format_date(AS_OF + fw)], [-109000, '2026-11-14']);
  assert.equal(B - plan.free[fp], 136500);
  assert.equal(B - worse.free[fw], 159000);
  // cash_w волн: W1 — 197500 (close на 10-22), W2 — 272000 (close на 11-24), min в W2 160000 · 11-28
  assert.equal(plan.series.close[iso('2026-10-22') - AS_OF], 197500);
  assert.equal(plan.series.close[iso('2026-11-24') - AS_OF], 272000);
  assert.equal(plan.series.trough[iso('2026-11-28') - AS_OF], 160000);
});

test('G-001-late (C-058): плановый расход P-X −250000 на 2026-11-26 — min free на [10-04, 11-19] 93500 / 71000, на всём горизонте −77800 · 11-28 (trough 90000, reserve_trough 167800)', () => {
  for (const [mode, expect_w] of [['plan', 93500], ['worse', 71000]]) {
    const r = run(LATE, mode);
    const upto = argmin_first(r.free, 0, iso('2026-11-19') - AS_OF);
    assert.equal(r.free[upto], expect_w);
    const all = argmin_first(r.free, 0, 57);
    assert.equal(r.free[all], -77800);
    assert.equal(format_date(AS_OF + all), '2026-11-28');
    assert.equal(r.series.trough[all], 90000);
    assert.equal(r.rs.reserve_trough[all], 167800);
  }
});

// ── TST-10 ────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('TST-10 G-001: доход по часам — 279000 (5580 мин), диапазон 240000…330000, выплата 2026-11-05, аллокация 55800; сентябрь 288000 → 57600; ноябрь → 2026-12-07 вне горизонта 57 дн.', () => {
  const s = G.streams[0];
  assert.equal(gross_pay(s.rate_minor, 5580, null, 'half_even'), 279000);
  assert.equal(mul_div(3000, 5580, 60), 279000);
  assert.equal(gross_pay(s.rate_minor, 4800, null), 240000);
  assert.equal(gross_pay(s.rate_minor, 6600, null), 330000);
  const e = build_events(G, { as_of: AS_OF, horizon_end: HORIZON_END, mode: 'plan' }).find((x) => x.stream_id === 'S-HOURLY');
  assert.deepEqual([e.amount_minor, e.amount_min_minor, e.amount_max_minor, format_date(e.date)], [279000, 240000, 330000, '2026-11-05']);
  const rule = G.tax_rules[0];
  assert.equal(allocation_for_income(279000, rule), 55800);
  assert.equal(allocation_for_income(288000, rule), 57600); // сентябрьская выплата — в funded_start
  assert.equal(mul_div(279000, 2000, 10000), 55800);
  // выплата за ноябрь: 30 ноя + 5 = 12-05 (суббота) → 2026-12-07
  const cal = make_calendar(G.calendars[0]);
  const w = expand_stream_ex(s, { from: iso('2026-11-30'), to: iso('2026-12-31') }, cal, { rounding: 'half_even' });
  assert.deepEqual(w.events.map((x) => [format_date(x.date), x.amount_minor, x.occ_key]), [['2026-12-07', 279000, 'S-HOURLY@2026-12-05']]);
  // октябрьская выплата за сентябрьский период — 288000 на 2026-10-05, при факте 10-02 план сопоставлен
  const sept = expand_stream_ex(s, { from: iso('2026-10-04'), to: iso('2026-10-31') }, cal, { rounding: 'half_even' });
  assert.deepEqual(sept.events.map((x) => [format_date(x.date), x.amount_minor]), [['2026-10-05', 288000]]);
});

test('TST-10/TST-25/TST-26 (иллюстрации §9.2): переработка 46 ч/нед → 147000; ничья 2401 мин → half_even 120062 / half_up 120063; недоработка на 10-20 = 480 мин (24000), оценка 255000', () => {
  assert.equal(gross_pay(3000, 2760, { threshold_minutes: 2400, mult_bp: 15000 }, 'half_even'), 147000);
  assert.equal(gross_pay(3000, 2401, { threshold_minutes: 2400, mult_bp: 12500 }, 'half_even'), 120062);
  assert.equal(gross_pay(3000, 2401, { threshold_minutes: 2400, mult_bp: 12500 }, 'half_up'), 120063);
  const s = G.streams[0];
  const per = period_bounds(s, iso('2026-10-20'));
  assert.deepEqual([format_date(per.start), format_date(per.end)], ['2026-10-01', '2026-10-31']);
  const sf = shortfall(s, per, iso('2026-10-20'), 3120, { rounding: 'half_even' });
  assert.deepEqual(sf, { short_minutes: 480, effect_minor: 24000, est_minutes: 5100, est_gross_minor: 255000 });
});

test('X2 (§12): при горизонте 180 в ряд попадают 2026-12-07 (выплата за ноябрь) и 2026-12-25 (аренда, ЖКХ) — числа другие; ключи G-001 только при 57 дн.', () => {
  const evs = build_events(G, { as_of: AS_OF, horizon_days: 180, mode: 'plan' });
  assert.ok(evs.some((e) => e.stream_id === 'S-HOURLY' && format_date(e.date) === '2026-12-07' && e.amount_minor === 279000));
  assert.ok(evs.some((e) => e.rule_id === 'R-RENT' && format_date(e.date) === '2026-12-25'));
  assert.ok(evs.some((e) => e.rule_id === 'R-UTIL' && format_date(e.date) === '2026-12-25'));
  const os = opening_state(G, AS_OF);
  const s180 = project(evs, os.opening_minor, AS_OF, AS_OF + 180);
  const s57 = project(build_events(G, { as_of: AS_OF, horizon_end: HORIZON_END, mode: 'plan' }), os.opening_minor, AS_OF, HORIZON_END);
  assert.equal(s180.trough.length, 181);
  assert.deepEqual(s180.close.slice(0, 58), s57.close, 'первые 58 дней совпадают (префикс)');
  assert.notEqual(s180.close.at(-1), 340000, 'конец горизонта 180 дн. — другое число (это не ошибка, X2)');
  assert.equal(narrowest_point(s180, AS_OF, AS_OF + 180).amount_minor <= 205500, true);
});

// ── сценарии на G-001 (ALG-02 TV4, TST-35, TST-36) ───────────────────────────────────────────────────────────────────

test('TST-36 G-001 (TV4): delay_income{S-HOURLY@2026-11-05, 21} в plan → доход 11-26, min trough 71000 · 11-25 (Δ −134500); delay 14 в plan = ряд worse; delay 7 в worse = delay 21 в plan (C-009)', () => {
  const as_of = AS_OF;
  const hz = HORIZON_END;
  const op = (days) => ({ scenario_id: 'x', ops: [{ op: 'delay_income', event_ref: 'S-HOURLY@2026-11-05', days }] });
  const os = opening_state(G, as_of);
  const series = (mode, sc) => project(build_events(G, { as_of, horizon_end: hz, mode, scenario: sc }), os.opening_minor, as_of, hz);
  const base = series('plan');
  const s21 = series('plan', op(21));
  assert.equal(format_date(build_events(G, { as_of, horizon_end: hz, mode: 'plan', scenario: op(21) }).find((e) => e.kind === 'income').date), '2026-11-26');
  assert.deepEqual(narrowest_point(s21, as_of, hz), { date: iso('2026-11-25'), amount_minor: 71000 });
  assert.equal(71000 - narrowest_point(base, as_of, hz).amount_minor, -134500);
  const s14 = series('plan', op(14));
  const worse = series('worse');
  assert.deepEqual(s14.trough, worse.trough);
  assert.deepEqual(s14.close, worse.close);
  assert.deepEqual(narrowest_point(s14, as_of, hz), { date: iso('2026-11-14'), amount_minor: 183000 });
  const w7 = series('worse', op(7));
  assert.deepEqual(w7.trough, s21.trough);
  assert.deepEqual(w7.close, s21.close);
  const wev = build_events(G, { as_of, horizon_end: hz, mode: 'worse', scenario: op(7) }).find((e) => e.kind === 'income');
  assert.equal(format_date(wev.plan_date), '2026-11-12'); // сценарий сдвинул данные на 7 дн.
  assert.equal(format_date(wev.date), '2026-11-26'); // режим добавил 14
  // сохранённый сценарий по id даёт то же
  const by_id = project(build_events(G, { as_of, horizon_end: hz, mode: 'plan', scenario_id: 'scn-delay-14' }), os.opening_minor, as_of, hz);
  assert.deepEqual(by_id.close, worse.close);
});

test('TST-36 G-001 (TV4): add_purchase 30000 на 10-12 → min trough plan 175500 (10-31), worse 153000 (11-14); ряд базы + ряд дельты −30000 с 10-12 покомпонентно', () => {
  const os = opening_state(G, AS_OF);
  const sc = { scenario_id: 'scn-treadmill', ops: G.scenarios.find((s) => s.scenario_id === 'scn-treadmill').ops };
  for (const [mode, expect, day] of [['plan', 175500, '2026-10-31'], ['worse', 153000, '2026-11-14']]) {
    const base_ev = build_events(G, { as_of: AS_OF, horizon_end: HORIZON_END, mode });
    const ev = build_events(G, { as_of: AS_OF, horizon_end: HORIZON_END, mode, scenario: sc });
    assert.equal(ev.length, base_ev.length + 1);
    const s = project(ev, os.opening_minor, AS_OF, HORIZON_END);
    assert.deepEqual(narrowest_point(s, AS_OF, HORIZON_END), { date: iso(day), amount_minor: expect });
    const b = project(base_ev, os.opening_minor, AS_OF, HORIZON_END);
    const delta = project(ev.filter((e) => e.layer === 'hypothetical'), 0, AS_OF, HORIZON_END);
    for (let i = 0; i < 58; i++) {
      assert.equal(s.close[i], b.close[i] + delta.close[i]);
      assert.equal(s.trough[i], b.trough[i] + delta.trough[i]);
      assert.equal(delta.close[i], AS_OF + i >= iso('2026-10-12') ? -30000 : 0);
    }
    const p = ev.find((e) => e.layer === 'hypothetical');
    assert.equal(p.purchase_id, 'scn:scn-treadmill:1');
    assert.equal(p.scenario_id, 'scn-treadmill');
    assert.equal(p.cash_event_id, 'scn:scn-treadmill:1#0');
  }
});

test('G-001: рассрочка 1 100,00 € (6 частей помесячно с 11-01): в горизонте 57 дн. только первая часть 18334 — остальные отброшены project', () => {
  const pur = G.purchases.find((x) => x.purchase_id === 'pur-treadmill-6');
  assert.equal(pur.parts.reduce((s, p) => s + p.amount_minor, 0), 110000);
  const sc = { scenario_id: 'inst', ops: [{ op: 'add_purchase', parts: pur.parts }] };
  const ev = build_events(G, { as_of: AS_OF, horizon_end: HORIZON_END, mode: 'plan', scenario: sc }).filter((e) => e.layer === 'hypothetical');
  assert.deepEqual(ev.map((e) => [format_date(e.date), e.amount_minor]), [['2026-11-01', -18334]]);
  const all = build_events(G, { as_of: AS_OF, horizon_days: 400, mode: 'plan', scenario: sc }).filter((e) => e.layer === 'hypothetical');
  assert.equal(all.length, 6);
  assert.equal(all.reduce((s, e) => s + e.amount_minor, 0), -110000);
});

// ── TST-41, TST-57 на G-001 ──────────────────────────────────────────────────────────────────────────────────────────

test('TST-41 G-001: S-HOURLY (11-05) — на 11-08 expected, на 11-09 overdue; дата в потоке: plan 11-09, worse 11-23; plan_date хранит 11-05 без зажима', () => {
  const as = (d) => ({ as_of: iso(d), horizon_days: 57 });
  const find = (q, mode) => build_events(G, { ...q, mode }).find((e) => e.stream_id === 'S-HOURLY');
  const e8 = find(as('2026-11-08'), 'plan');
  assert.equal(e8.status, 'expected');
  assert.equal(format_date(e8.date), '2026-11-08'); // base = max(11-05, as_of)
  const p9 = find(as('2026-11-09'), 'plan');
  const w9 = find(as('2026-11-09'), 'worse');
  assert.equal(p9.status, 'overdue');
  assert.equal(format_date(p9.date), '2026-11-09');
  assert.equal(format_date(w9.date), '2026-11-23');
  assert.equal(format_date(p9.plan_date), '2026-11-05');
  assert.equal(format_date(w9.plan_date), '2026-11-05');
});

test('TST-57 G-001: готовность = 4 («полный»), свежесть: anchor_age 0, плашки нет; Q3 разрешён; деградация расхождений: 1200 и 1500 → unlogged_rate 1350, при age 9 — 12150', () => {
  assert.deepEqual(readiness(G, AS_OF), { score: 4, level: 'full', reasons: [] });
  const st = anchor_status(G, AS_OF);
  assert.equal(st.level, 'fresh');
  assert.equal(st.age, 0);
  assert.equal(plan_from(G, 'acc_main', AS_OF), AS_OF);
  assert.equal(plan_from(G, G.accounts[0], iso('2026-10-03')), iso('2026-07-05'), 'якорь 07-05 — последний ≤ 10-03');
  assert.equal(normalize_ws(G).decision_currency, 'EUR');
  // деградация (§9.3): расхождения 8400 за 7 дней и 15000 за 10 дней → 1200 и 1500 в день → unlogged_rate = 1350
  const drifting = {
    ...G,
    anchors: [
      { anchor_id: 'a1', account_id: 'acc_main', date: '2026-08-01', amount_minor: 1000000 },
      { anchor_id: 'a2', account_id: 'acc_main', date: '2026-08-08', amount_minor: 1000000 - 8400 },
      { anchor_id: 'a3', account_id: 'acc_main', date: '2026-08-18', amount_minor: 1000000 - 8400 - 15000 },
    ],
    facts: [],
  };
  const d9 = anchor_status(drifting, iso('2026-08-27'));
  assert.equal(d9.rate_minor, 1350); // round_div(1200 + 1500, 2)
  assert.equal(d9.age, 9);
  assert.equal(d9.level, 'banner');
  assert.equal(d9.unaccounted_minor, 12150); // 1350 · 9 = 121,50 €
  assert.equal(anchor_status(drifting, iso('2026-08-25')).level, 'fresh'); // age 7 — без плашки
  const d22 = anchor_status(drifting, iso('2026-09-09'));
  assert.deepEqual([d22.level, d22.reason, d22.age], ['block', 'stale', 22]); // Q3 заменён «данных мало», Q1 отвечает
});

test('G-001: вход не мутируется (ws, события, сценарий); повторный вызов даёт побайтно то же (детерминизм, TST-33 часть)', () => {
  const before = JSON.stringify(G);
  const q = { as_of: AS_OF, horizon_end: HORIZON_END, mode: 'worse', scenario_id: 'scn-delay-14' };
  const a = build_events_ex(G, q);
  const b = build_events_ex(JSON.parse(before), q);
  assert.equal(JSON.stringify(G), before);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  const evs = build_events(G, { as_of: AS_OF, horizon_end: HORIZON_END, mode: 'plan' });
  const snapshot = JSON.stringify(evs);
  const sc = { scenario_id: 's', ops: [{ op: 'shift_flow', event_ref: 'R-GROC', days: 1 }, { op: 'remove_flow', event_ref: 'R-PHONE' }] };
  const out = apply_scenario(evs, sc, { as_of: AS_OF, horizon_end: HORIZON_END, calendars: G.calendars, default_account_id: 'acc_main' });
  assert.equal(JSON.stringify(evs), snapshot, 'apply_scenario не мутирует вход');
  assert.equal(out.length, evs.length - 2);
});
