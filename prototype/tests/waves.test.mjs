// waves.test.mjs — волны платежей (ALG-03): TST-03 (G-001: состав и метрики, оба случая окна C-013), TST-08 (волны G-001-low и G-001-gap),
// TST-37 (свойство: разбиение обязательств, ручные split/merge/pin переживают пересчёт). Ожидаемые числа — из design-brief §9.5, §9.9 и
// ALG-03 (TV-1…TV-5) ДОСЛОВНО; код движка в ожиданиях не участвует. В тестах допустимы node:fs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { parse_date } from '../engine/dates.mjs';
import { project } from '../engine/timeline.mjs';
import {
  detect_waves, apply_wave_overrides, apply_wave_overrides_ex, next_income_day, wave_metrics, list_waves, list_waves_ex,
} from '../engine/waves.mjs';
import { analyze } from '../engine/index.mjs';
import { make_rng, throws_code } from './helpers.mjs';

const DATA = new URL('../data/', import.meta.url);
const load = (name) => JSON.parse(fs.readFileSync(new URL(name, DATA), 'utf8'));
const G = load('g001.json');
const LOW = load('g001-low.json');
const GAP = load('g001-gap.json');
const iso = (s) => parse_date(s);
const run = (ws, extra = {}) => analyze(ws, { as_of: ws.as_of, ...extra });
const by_id_of = (evs) => new Map(evs.map((e) => [e.cash_event_id, e]));

/** Метрики волны по идентификатору первого события. */
function wave_by(items, first_id) {
  const hit = items.find((x) => x.wave.event_ids.includes(first_id));
  assert.ok(hit, `волна с событием ${first_id}`);
  return hit;
}

const SHAPE = (items) => items.map(({ wave, metrics }) => ({
  start: wave.start, end: wave.end, total: wave.total_out_minor, ids: wave.event_ids,
  window_end: metrics.window_end, cash: metrics.cash_minor, min: metrics.min_trough, r: metrics.r_minor, need: metrics.need_minor,
  gap: metrics.gap_minor, cov: metrics.coverage_pm, reserved: metrics.reserved_minor,
}));

// ── синтетика TV-1 (ALG-03): состав ─────────────────────────────────────────────────────────────────────────────────────

const ob = (id, date, amount, over = {}) => ({
  cash_event_id: id, layer: 'planned', account_id: 'a', date: iso(date), amount_minor: amount, currency: 'EUR', kind: 'expense',
  is_obligation: true, is_estimate: false, ...over,
});
const TV1 = [
  ob('o1', '2026-10-06', -5000), ob('o2', '2026-10-09', -4000), ob('o3', '2026-10-12', -8000), ob('o4', '2026-10-15', -3000),
  ob('o5', '2026-10-16', -6000), ob('o6', '2026-10-17', -2999), ob('o7', '2026-10-30', -7000), ob('o8', '2026-10-30', -9000),
  ob('f1', '2026-10-20', -20000, { is_obligation: false }), // фон: не обязательство
  ob('f2', '2026-10-21', -15000, { is_estimate: true }), // фон: оценка
  { ...ob('f3', '2026-10-22', 9000), kind: 'income', is_obligation: false }, // фон: доход
];
const P = (g, S, theta) => ({ wave: { gap_days: g, max_span_days: S, threshold_minor: theta } });
const ids_of = (waves) => waves.map((w) => w.event_ids);

test('TST-03 TV-1 состав волн (g = 3, S = 10, θ = 3000): [o1…o4], [o5], [o8, o7]; Σ total_out = Σ значимых обязательств', () => {
  const ws = detect_waves(TV1, P(3, 10, 3000));
  assert.deepEqual(ids_of(ws), [['o1', 'o2', 'o3', 'o4'], ['o5'], ['o8', 'o7']]);
  assert.deepEqual(ws.map((w) => w.total_out_minor), [20000, 6000, 16000]);
  assert.deepEqual(ws.map((w) => [w.start, w.end]), [[iso('2026-10-06'), iso('2026-10-15')], [iso('2026-10-16'), iso('2026-10-16')], [iso('2026-10-30'), iso('2026-10-30')]]);
  assert.deepEqual(ws.map((w) => w.wave_id), ['wave:o1', 'wave:o5', 'wave:o8']);
  assert.equal(ws.reduce((s, w) => s + w.total_out_minor, 0), 42000); // 5000+4000+8000+3000+6000+7000+9000
});

test('TST-03 TV-1 чувствительность (REQ-188): g = 2 → 5 волн; g = 4 → как при 3; S = 7; S = 13; θ = 2999', () => {
  assert.deepEqual(ids_of(detect_waves(TV1, P(2, 10, 3000))), [['o1'], ['o2'], ['o3'], ['o4', 'o5'], ['o8', 'o7']]);
  assert.deepEqual(ids_of(detect_waves(TV1, P(4, 10, 3000))), [['o1', 'o2', 'o3', 'o4'], ['o5'], ['o8', 'o7']]);
  assert.deepEqual(ids_of(detect_waves(TV1, P(3, 7, 3000))), [['o1', 'o2', 'o3'], ['o4', 'o5'], ['o8', 'o7']]);
  assert.deepEqual(ids_of(detect_waves(TV1, P(3, 13, 3000))), [['o1', 'o2', 'o3', 'o4', 'o5'], ['o8', 'o7']]);
  const t = detect_waves(TV1, P(3, 10, 2999));
  assert.deepEqual(ids_of(t), [['o1', 'o2', 'o3', 'o4'], ['o5', 'o6'], ['o8', 'o7']]);
  assert.equal(t[1].total_out_minor, 8999);
  assert.deepEqual([t[1].start, t[1].end], [iso('2026-10-16'), iso('2026-10-17')]);
});

test('TST-03 граничные случаи ALG-03: нет обязательств; один день; разрыв g / g + 1; цепочка через 3 дня режется размахом; θ − 1 — фон', () => {
  assert.deepEqual(detect_waves([], P(3, 10, 3000)), []);
  assert.deepEqual(detect_waves([ob('x', '2026-10-06', -2999)], P(3, 10, 3000)), []); // θ − 1 — фон
  assert.equal(detect_waves([ob('x', '2026-10-06', -3000)], P(3, 10, 3000)).length, 1); // порог включительный
  // два обязательства в один день — одна волна, крупнее первым, затем по id
  const same = detect_waves([ob('b', '2026-10-06', -4000), ob('a', '2026-10-06', -4000), ob('c', '2026-10-06', -9000)], P(3, 10, 3000));
  assert.deepEqual(ids_of(same), [['c', 'a', 'b']]);
  assert.equal(same[0].total_out_minor, 17000);
  // разрыв ровно g вместе, g + 1 раздельно
  assert.equal(detect_waves([ob('a', '2026-10-06', -5000), ob('b', '2026-10-09', -5000)], P(3, 10, 3000)).length, 1);
  assert.equal(detect_waves([ob('a', '2026-10-06', -5000), ob('b', '2026-10-10', -5000)], P(3, 10, 3000)).length, 2);
  // цепочка 10-06, 09, 12, 15, 18: волны [10-06…10-15] и [10-18] (10-18 − 10-06 = 12 ≥ S)
  const chain = ['2026-10-06', '2026-10-09', '2026-10-12', '2026-10-15', '2026-10-18'].map((d, k) => ob('c' + k, d, -5000));
  assert.deepEqual(ids_of(detect_waves(chain, P(3, 10, 3000))), [['c0', 'c1', 'c2', 'c3'], ['c4']]);
  // фон не соединяет и не разделяет: платёж θ − 1 между двумя волнами их не склеивает
  const bg = detect_waves([ob('a', '2026-10-06', -5000), ob('m', '2026-10-08', -2999), ob('b', '2026-10-12', -5000)], P(3, 10, 3000));
  assert.deepEqual(ids_of(bg), [['a'], ['b']]);
  // параметры можно задать и плоскими ключами (как в Analysis.params)
  const flat = detect_waves(TV1, { 'wave.gap_days': 3, 'wave.max_span_days': 10, 'wave.threshold_minor': 3000 });
  assert.deepEqual(ids_of(flat), [['o1', 'o2', 'o3', 'o4'], ['o5'], ['o8', 'o7']]);
});

test('TST-03 параметры волн: g < 0, S < 1, θ < 1, не целые или не заданные — E_SCHEMA', () => {
  throws_code(() => detect_waves(TV1, P(-1, 10, 3000)), 'E_SCHEMA');
  throws_code(() => detect_waves(TV1, P(3, 0, 3000)), 'E_SCHEMA');
  throws_code(() => detect_waves(TV1, P(3, 10, 0)), 'E_SCHEMA');
  throws_code(() => detect_waves(TV1, P(3.5, 10, 3000)), 'E_SCHEMA');
  throws_code(() => detect_waves(TV1, { 'wave.gap_days': 3, 'wave.max_span_days': 10 }), 'E_SCHEMA'); // θ не задан
  assert.deepEqual(ids_of(detect_waves(TV1, P(0, 10, 3000))), [['o1'], ['o2'], ['o3'], ['o4'], ['o5'], ['o8', 'o7']]); // g = 0 допустим: сливаются только события одного дня
});

// ── TST-03: G-001 ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('TST-03 G-001 состав: обязательства ≥ θ = 3000 — налог 10-23, аренда и ЖКХ 10-26 и 11-25; связь 2500 — фон; две волны W1 152000 и W2 102000; состав в plan и worse совпадает', () => {
  const a = run(G);
  const plan = list_waves(a, 'plan');
  const worse = list_waves(a, 'worse');
  assert.equal(plan.length, 2);
  assert.deepEqual(plan.map((x) => x.wave), worse.map((x) => x.wave), 'состав волн не зависит от режима (D-04)');
  const [w1, w2] = plan.map((x) => x.wave);
  assert.deepEqual([w1.start, w1.end, w1.total_out_minor], [iso('2026-10-23'), iso('2026-10-26'), 152000]);
  assert.deepEqual(w1.event_ids, ['P-TAX1', 'R-RENT@2026-10-25', 'R-UTIL@2026-10-25']);
  assert.deepEqual([w2.start, w2.end, w2.total_out_minor], [iso('2026-11-25'), iso('2026-11-25'), 102000]);
  assert.deepEqual(w2.event_ids, ['R-RENT@2026-11-25', 'R-UTIL@2026-11-25']);
  assert.ok(!plan.some((x) => x.wave.event_ids.some((id) => id.startsWith('R-PHONE'))), 'связь 2500 < θ — фон');
  assert.ok(!plan.some((x) => x.wave.event_ids.some((id) => id.startsWith('R-GROC'))), 'продукты — оценка');
});

test('TST-03 G-001 метрики (§9.5): W1 plan — окно до 11-04, cash 377500, min 205500 · 10-31, R 172000, need 222000, gap 0, 1700 ‰, reserved 150000', () => {
  const a = run(G);
  const m = wave_by(list_waves(a, 'plan'), 'P-TAX1').metrics;
  assert.equal(m.window_end, iso('2026-11-04'));
  assert.equal(m.cash_minor, 377500);
  assert.deepEqual(m.min_trough, { date: iso('2026-10-31'), amount_minor: 205500 });
  assert.equal(m.r_minor, 172000);
  assert.equal(m.need_minor, 222000); // G-001.waves.w1.need.plan
  assert.equal(m.gap_minor, 0);
  assert.equal(m.coverage_pm, 1700); // floor(377500000 / 222000) = 1700,45
  assert.equal(m.reserved_minor, 150000);
});

test('TST-03 G-001 метрики (§9.5): W1 worse — окно до 11-18, min 183000 · 11-14, R 194500, need 244500, 1543 ‰', () => {
  const a = run(G);
  const m = wave_by(list_waves(a, 'worse'), 'P-TAX1').metrics;
  assert.equal(m.window_end, iso('2026-11-18'));
  assert.equal(m.cash_minor, 377500);
  assert.deepEqual(m.min_trough, { date: iso('2026-11-14'), amount_minor: 183000 });
  assert.equal(m.r_minor, 194500); // + продукты 11-07, 11-14 и связь 11-09 = 22500
  assert.equal(m.need_minor, 244500); // G-001.waves.w1.need.worse
  assert.equal(m.gap_minor, 0);
  assert.equal(m.coverage_pm, 1543); // floor(377500000 / 244500) = 1543,9
  assert.equal(m.reserved_minor, 150000);
});

test('TST-03 G-001 метрики (§9.5): W2 в обоих режимах — приходов нет, окно до horizon_end; cash 452000, min 340000 · 11-28, R 112000, need 162000, 2790 ‰, reserved 167800', () => {
  const a = run(G);
  for (const mode of ['plan', 'worse']) {
    const m = wave_by(list_waves(a, mode), 'R-RENT@2026-11-25').metrics;
    assert.equal(m.window_end, iso('2026-11-30'), mode);
    assert.equal(m.cash_minor, 452000, mode); // close[11-24]
    assert.deepEqual(m.min_trough, { date: iso('2026-11-28'), amount_minor: 340000 }, mode);
    assert.equal(m.r_minor, 112000, mode);
    assert.equal(m.need_minor, 162000, mode); // G-001.waves.w2.need
    assert.equal(m.gap_minor, 0, mode);
    assert.equal(m.coverage_pm, 2790, mode);
    assert.equal(m.reserved_minor, 167800, mode);
  }
});

test('TST-03 окно «до своего прихода» (C-013), случай 1 (G-001): next_income_day(worse) = 11-19 ≥ plan = 11-05, поэтому need и gap в worse не лучше plan', () => {
  const a = run(G);
  const w1 = list_waves(a, 'plan')[0].wave;
  const n_plan = next_income_day(a.events.plan, w1.end);
  const n_worse = next_income_day(a.events.worse, w1.end);
  assert.equal(n_plan, iso('2026-11-05'));
  assert.equal(n_worse, iso('2026-11-19'));
  assert.ok(n_worse >= n_plan);
  const mp = list_waves(a, 'plan')[0].metrics;
  const mw = list_waves(a, 'worse')[0].metrics;
  assert.ok(mw.need_minor >= mp.need_minor && mw.gap_minor >= mp.gap_minor);
});

test('TST-03 окно «до своего прихода» (C-013), случай 2 (синтетика §11-testing-strategy): worse ЛУЧШЕ plan, хотя trough_worse ≤ trough_plan в каждый день', () => {
  // opening 1000, B = 300, horizon_end = день 40, сдвиг worse 14; доход A +500 (день 3; в worse — 17), обязательство −400 (день 10),
  // оценочная трата −900 (день 25), доход B +2000 (день 30; в worse — день 44, вне горизонта)
  const e = (id, day, amount, over = {}) => ({
    cash_event_id: id, layer: 'planned', account_id: 'a', date: day, amount_minor: amount, currency: 'EUR',
    kind: amount > 0 ? 'income' : 'expense', is_obligation: false, is_estimate: false, ...over,
  });
  const ev_plan = [e('A', 3, 500), e('O', 10, -400, { is_obligation: true }), e('E', 25, -900, { is_estimate: true }), e('B', 30, 2000)];
  const ev_worse = [e('A', 17, 500), e('O', 10, -400, { is_obligation: true }), e('E', 25, -900, { is_estimate: true })]; // B вне горизонта
  const s_plan = project(ev_plan, 1000, 0, 40);
  const s_worse = project(ev_worse, 1000, 0, 40);
  for (let i = 0; i <= 40; i++) assert.ok(s_worse.trough[i] <= s_plan.trough[i], `trough_worse ≤ trough_plan, день ${i}`);
  const params = P(3, 10, 300);
  const w = detect_waves(ev_plan, params);
  assert.equal(w.length, 1);
  assert.equal(w[0].start, 10);
  const mp = wave_metrics(w[0], s_plan, 300, next_income_day(ev_plan, w[0].end));
  assert.equal(mp.window_end, 29);
  assert.equal(mp.cash_minor, 1500);
  assert.deepEqual(mp.min_trough, { date: 25, amount_minor: 200 });
  assert.deepEqual([mp.r_minor, mp.need_minor, mp.gap_minor], [1300, 1600, 100]);
  const mw = wave_metrics(detect_waves(ev_worse, params)[0], s_worse, 300, next_income_day(ev_worse, 10));
  assert.equal(mw.window_end, 16);
  assert.equal(mw.cash_minor, 1000);
  assert.deepEqual(mw.min_trough, { date: 10, amount_minor: 600 });
  assert.deepEqual([mw.r_minor, mw.need_minor, mw.gap_minor], [400, 700, 0]);
  assert.ok(mw.need_minor < mp.need_minor && mw.gap_minor < mp.gap_minor, 'монотонность need/gap условна (C-013)');
});

test('TST-03 TV-5: покупка «дорожка 300,00 € на 10-12» (сценарий) не меняет состав волн; W1 plan: cash 347500, min 175500, need 222000, 1565 ‰; worse: min 153000, need 244500, 1421 ‰', () => {
  const base = run(G);
  const a = run(G, { scenario_id: 'scn-treadmill' });
  assert.deepEqual(list_waves(a, 'plan').map((x) => x.wave), list_waves(base, 'plan').map((x) => x.wave));
  const mp = list_waves(a, 'plan')[0].metrics;
  assert.deepEqual([mp.cash_minor, mp.min_trough.amount_minor, mp.need_minor, mp.coverage_pm], [347500, 175500, 222000, 1565]);
  const mw = list_waves(a, 'worse')[0].metrics;
  assert.deepEqual([mw.min_trough.amount_minor, mw.need_minor, mw.coverage_pm], [153000, 244500, 1421]);
});

test('TST-03 чувствительность на G-001: gap_days = 2 делит W1 на налог (50000) и аренду с ЖКХ (102000) — три волны вместо двух', () => {
  const a = run(G);
  const ws = detect_waves(a.events.plan, { ...a.params, 'wave.gap_days': 2 });
  assert.equal(ws.length, 3);
  assert.deepEqual(ws.map((w) => w.total_out_minor), [50000, 102000, 102000]);
  assert.deepEqual(ids_of(ws)[0], ['P-TAX1']);
});

// ── TST-08: волны G-001-low и G-001-gap ────────────────────────────────────────────────────────────────────────────────

test('TST-08 G-001-low (opening 220000): W1 plan — cash 197500, need 222000, gap 24500, 889 ‰; worse — need 244500, gap 47000, 807 ‰; W2 — cash 272000, min 160000 · 11-28, need 162000, gap 0, 1679 ‰', () => {
  const a = run(LOW);
  const w1p = wave_by(list_waves(a, 'plan'), 'P-TAX1').metrics;
  assert.deepEqual([w1p.cash_minor, w1p.need_minor, w1p.gap_minor, w1p.coverage_pm], [197500, 222000, 24500, 889]);
  assert.equal(w1p.gap_minor, w1p.need_minor - w1p.cash_minor, 'gap = need − cash, когда B > min trough');
  assert.equal(w1p.min_trough.amount_minor, 25500); // 25500 · 10-31
  assert.equal(w1p.min_trough.date, iso('2026-10-31'));
  const w1w = wave_by(list_waves(a, 'worse'), 'P-TAX1').metrics;
  assert.deepEqual([w1w.need_minor, w1w.gap_minor, w1w.coverage_pm], [244500, 47000, 807]);
  assert.deepEqual(w1w.min_trough, { date: iso('2026-11-14'), amount_minor: 3000 });
  for (const mode of ['plan', 'worse']) {
    const w2 = wave_by(list_waves(a, mode), 'R-RENT@2026-11-25').metrics;
    assert.deepEqual([w2.cash_minor, w2.min_trough.amount_minor, w2.need_minor, w2.gap_minor, w2.coverage_pm], [272000, 160000, 162000, 0, 1679], mode);
    assert.equal(w2.min_trough.date, iso('2026-11-28'), mode);
  }
});

test('TST-08 G-001-gap (opening 100000): W1 plan — cash 77500, gap 144500, 349 ‰; worse — gap 167000, 316 ‰; W2 — cash 152000, min 40000 · 11-28, gap 10000, 938 ‰', () => {
  const a = run(GAP);
  const w1p = wave_by(list_waves(a, 'plan'), 'P-TAX1').metrics;
  assert.deepEqual([w1p.cash_minor, w1p.gap_minor, w1p.coverage_pm], [77500, 144500, 349]);
  const w1w = wave_by(list_waves(a, 'worse'), 'P-TAX1').metrics;
  assert.deepEqual([w1w.gap_minor, w1w.coverage_pm], [167000, 316]);
  for (const mode of ['plan', 'worse']) {
    const w2 = wave_by(list_waves(a, mode), 'R-RENT@2026-11-25').metrics;
    assert.deepEqual([w2.cash_minor, w2.min_trough.amount_minor, w2.gap_minor, w2.coverage_pm], [152000, 40000, 10000, 938], mode);
    assert.equal(w2.min_trough.date, iso('2026-11-28'), mode);
  }
});

// ── TV-4: ручные правки на G-001 ───────────────────────────────────────────────────────────────────────────────────────

/** Волны режима с правками (ручной конвейер: detect → apply → wave_metrics). */
function with_overrides(a, mode, overrides) {
  const ev = a.events[mode];
  const { waves, warnings } = apply_wave_overrides_ex(detect_waves(ev, a.params), overrides, by_id_of(ev));
  return { waves, warnings, metrics: waves.map((w) => wave_metrics(w, a.series[mode], a.buffer_minor, next_income_day(ev, w.end))) };
}

test('TST-37 TV-4 merge{P-TAX1, R-RENT@11-25}: одна волна 254000, start 10-23, end 11-25, окно до 11-30; plan: min 205500, need 222000, 1700 ‰; worse: 183000, 244500, 1543 ‰', () => {
  const a = run(G);
  const merge = [{ override_id: 'ov1', action: 'merge', event_ids: ['P-TAX1', 'R-RENT@2026-11-25'] }];
  const p = with_overrides(a, 'plan', merge);
  assert.equal(p.waves.length, 1);
  assert.deepEqual([p.waves[0].start, p.waves[0].end, p.waves[0].total_out_minor], [iso('2026-10-23'), iso('2026-11-25'), 254000]);
  assert.equal(p.metrics[0].cash_minor, 377500);
  assert.equal(p.metrics[0].window_end, iso('2026-11-30'));
  assert.deepEqual([p.metrics[0].min_trough.amount_minor, p.metrics[0].need_minor, p.metrics[0].coverage_pm], [205500, 222000, 1700]);
  const w = with_overrides(a, 'worse', merge);
  assert.deepEqual([w.metrics[0].min_trough.amount_minor, w.metrics[0].need_minor, w.metrics[0].coverage_pm], [183000, 244500, 1543]);
});

test('TST-37 TV-4 split{R-RENT@10-26}: W1 → [P-TAX1] (50000) и [R-RENT, R-UTIL] (102000); вторая в plan: cash 317500, R 112000, need 162000, 1959 ‰, reserved 100000; в worse: R 134500, need 184500, 1720 ‰', () => {
  const a = run(G);
  const split = [{ action: 'split', event_ids: ['R-RENT@2026-10-25'] }];
  const p = with_overrides(a, 'plan', split);
  assert.equal(p.waves.length, 3);
  assert.deepEqual(p.waves.map((w) => w.total_out_minor), [50000, 102000, 102000]);
  assert.deepEqual(p.waves[0].event_ids, ['P-TAX1']);
  assert.deepEqual(p.waves[1].event_ids, ['R-RENT@2026-10-25', 'R-UTIL@2026-10-25']);
  const m = p.metrics[1];
  assert.deepEqual([m.cash_minor, m.r_minor, m.need_minor, m.coverage_pm, m.reserved_minor], [317500, 112000, 162000, 1959, 100000]); // налог уже высвобожден
  const mw = with_overrides(a, 'worse', split).metrics[1];
  assert.deepEqual([mw.r_minor, mw.need_minor, mw.coverage_pm], [134500, 184500, 1720]);
});

test('TST-37 split / pin / merge: pin извлекает события и события в pin_range; идентификатор волны = id первого события; повторное применение ничего не меняет', () => {
  const a = run(G);
  const ev = a.events.plan;
  const base = detect_waves(ev, a.params);
  const get = by_id_of(ev);
  const pin = [{ action: 'pin', event_ids: ['R-UTIL@2026-10-25'] }];
  const p1 = apply_wave_overrides(base, pin, get);
  assert.deepEqual(ids_of(p1), [['P-TAX1', 'R-RENT@2026-10-25'], ['R-UTIL@2026-10-25'], ['R-RENT@2026-11-25', 'R-UTIL@2026-11-25']]);
  assert.deepEqual(p1.map((w) => w.wave_id), ['wave:P-TAX1', 'wave:R-UTIL@2026-10-25', 'wave:R-RENT@2026-11-25']);
  assert.deepEqual(apply_wave_overrides(p1, pin, get), p1, 'идемпотентность pin');
  // pin_range 10-26…10-26 вытягивает аренду и ЖКХ этого дня
  const pr = apply_wave_overrides(base, [{ action: 'pin', event_ids: [], pin_range: { from: iso('2026-10-26'), to: '2026-10-26' } }], get);
  assert.deepEqual(ids_of(pr), [['P-TAX1'], ['R-RENT@2026-10-25', 'R-UTIL@2026-10-25'], ['R-RENT@2026-11-25', 'R-UTIL@2026-11-25']]);
  // merge и split идемпотентны
  for (const ov of [[{ action: 'merge', event_ids: ['P-TAX1', 'R-RENT@2026-11-25'] }], [{ action: 'split', event_ids: ['R-UTIL@2026-10-25'] }]]) {
    const once = apply_wave_overrides(base, ov, get);
    assert.deepEqual(apply_wave_overrides(once, ov, get), once, JSON.stringify(ov));
  }
  // split по первому событию волны (k = 0) ничего не режет
  assert.deepEqual(apply_wave_overrides(base, [{ action: 'split', event_ids: ['P-TAX1'] }], get), base);
});

test('TST-37 порядок применения правок — по seq (иначе порядок массива); результат не зависит от порядка входного массива правок с seq', () => {
  const a = run(G);
  const ev = a.events.plan;
  const base = detect_waves(ev, a.params);
  const get = by_id_of(ev);
  const merge = { action: 'merge', event_ids: ['P-TAX1', 'R-RENT@2026-11-25'], seq: 2 };
  const split = { action: 'split', event_ids: ['R-RENT@2026-11-25'], seq: 1 }; // сначала режем (ничего не меняет, W2 — отдельная), потом сливаем
  const split_late = { ...split, seq: 3 }; // сливаем, потом режем перед R-RENT@11-25 — получаем разрез
  const x = apply_wave_overrides(base, [merge, split], get);
  const y = apply_wave_overrides(base, [split, merge], get);
  assert.deepEqual(x, y, 'seq определяет порядок, не позиция в массиве');
  assert.equal(x.length, 1, 'split (seq 1) → merge (seq 2): одна волна');
  const z = apply_wave_overrides(base, [split_late, merge], get);
  assert.deepEqual(z.map((w) => w.event_ids.length), [3, 2], 'merge (seq 2) → split (seq 3): режет перед R-RENT@11-25');
});

test('TST-37 W_OVERRIDE_STALE: ссылка на исчезнувшее или ставшее фоном событие пропускается с предупреждением и не воскрешает события', () => {
  const a = run(G);
  const ev = a.events.plan;
  const base = detect_waves(ev, a.params);
  const get = by_id_of(ev);
  const r = apply_wave_overrides_ex(base, [
    { override_id: 'gone', action: 'split', event_ids: ['NO-SUCH'] },
    { override_id: 'phone', action: 'pin', event_ids: ['R-PHONE@2026-10-09'] }, // связь — фон (ниже θ), в волны не входит
    { override_id: 'half', action: 'merge', event_ids: ['P-TAX1', 'R-RENT@2026-11-25', 'NO-SUCH-2'] },
  ], get);
  assert.deepEqual(r.warnings, [
    { code: 'W_OVERRIDE_STALE', override_id: 'gone', event_ids: ['NO-SUCH'] },
    { code: 'W_OVERRIDE_STALE', override_id: 'phone', event_ids: ['R-PHONE@2026-10-09'] },
    { code: 'W_OVERRIDE_STALE', override_id: 'half', event_ids: ['NO-SUCH-2'] },
  ]);
  assert.equal(r.waves.length, 1, 'живая часть правки merge применена');
  assert.deepEqual(new Set(r.waves.flatMap((w) => w.event_ids)), new Set(base.flatMap((w) => w.event_ids)), 'новых событий нет');
  throws_code(() => apply_wave_overrides(base, [{ action: 'explode', event_ids: [] }], get), 'E_SCHEMA');
  throws_code(() => apply_wave_overrides(base, [{ action: 'split', event_ids: 'P-TAX1' }], get), 'E_SCHEMA');
  throws_code(() => apply_wave_overrides(base, [], new Map()), 'E_SCHEMA'); // события волн нет в by_id
});

test('TST-37 правки волн в Analysis: wave_overrides из рабочей области применяются в list_waves и переживают пересчёт при другом θ', () => {
  const ws = { ...G, wave_overrides: [{ override_id: 'wo1', action: 'split', event_ids: ['R-RENT@2026-10-25'], seq: 1 }] };
  const a = run(ws);
  assert.equal(list_waves(a, 'plan').length, 3);
  assert.deepEqual(list_waves(a, 'plan').map((x) => x.wave.total_out_minor), [50000, 102000, 102000]);
  // θ = 20000 убирает налог и ЖКХ, но не аренду: правка по R-RENT@10-26 остаётся (событие значимо), по ЖКХ — устарела
  const ws2 = { ...ws, params: { ...ws.params, 'wave.threshold_minor': 20000 }, wave_overrides: [...ws.wave_overrides, { override_id: 'wo2', action: 'pin', event_ids: ['R-UTIL@2026-10-25'], seq: 2 }] };
  const a2 = run(ws2);
  const { items, warnings } = list_waves_ex(a2, 'plan');
  assert.deepEqual(items.map((x) => x.wave.event_ids), [['P-TAX1'], ['R-RENT@2026-10-25'], ['R-RENT@2026-11-25']]);
  assert.ok(warnings.some((x) => x.code === 'W_OVERRIDE_STALE' && x.override_id === 'wo2'));
  assert.ok(a2.warnings.some((x) => x.code === 'W_OVERRIDE_STALE' && x.override_id === 'wo2'), 'предупреждение попало в Analysis.warnings');
});

// ── wave_metrics: краевые случаи ───────────────────────────────────────────────────────────────────────────────────────

test('TST-03 wave_metrics: волна с start = as_of берёт cash из opening, а резервы — из reserve_opening; cash < 0 — coverage_pm отрицательное целое (пол); без резервов reserved = 0', () => {
  const s = { from: 0, opening_minor: 1000, close: [400, 400, 400], trough: [400, 400, 400] }; // событие −600 на день 0
  const w = { wave_id: 'wave:x', start: 0, end: 0, event_ids: ['x'], total_out_minor: 600 };
  const m = wave_metrics(w, s, 100, null);
  assert.equal(m.cash_minor, 1000); // opening
  assert.equal(m.reserved_minor, 0);
  assert.deepEqual([m.r_minor, m.need_minor, m.gap_minor, m.coverage_pm, m.window_end], [600, 700, 0, 1428, 2]);
  const s2 = { ...s, reserve_opening_minor: 250, reserve_close: [250, 250, 250] };
  assert.equal(wave_metrics(w, s2, 100, null).reserved_minor, 250);
  // cash < 0: close[день до волны] = −500
  const neg = { from: 0, opening_minor: 100, close: [-500, -500, -900], trough: [-500, -500, -900] };
  const w2 = { wave_id: 'wave:y', start: 1, end: 1, event_ids: ['y'], total_out_minor: 1 };
  const mn = wave_metrics(w2, neg, 100, null); // cash = close[0] = −500, min = −900, R = 400, need = 500
  assert.deepEqual([mn.cash_minor, mn.r_minor, mn.need_minor, mn.coverage_pm, mn.gap_minor], [-500, 400, 500, -1000, 1000]);
  const mn2 = wave_metrics(w2, { ...neg, close: [-1, -1, -900], trough: [-1, -1, -900] }, 1, null);
  assert.equal(mn2.cash_minor, -1);
  assert.equal(mn2.coverage_pm, Math.floor(-1000 / mn2.need_minor));
  assert.equal(mn2.coverage_pm, -2);
});

test('TST-03 wave_metrics: первый минимум при равенстве; окно не короче самой волны; приход после горизонта = «нет поступлений»; ошибки E_BAD_DATE и E_SCHEMA', () => {
  const s = { from: 10, opening_minor: 500, close: [500, 400, 400, 300, 300, 300], trough: [500, 300, 400, 300, 300, 300] };
  const w = { wave_id: 'wave:x', start: 11, end: 13, event_ids: ['x'], total_out_minor: 1 };
  const m = wave_metrics(w, s, 0, 14); // приход на день 14 → окно 11…13 (e_ext = max(end, 13))
  assert.equal(m.window_end, 13);
  assert.deepEqual(m.min_trough, { date: 11, amount_minor: 300 }, 'побеждает ранняя дата');
  assert.equal(wave_metrics(w, s, 0, 999).window_end, 15, 'приход вне горизонта — окно до horizon_end');
  assert.equal(wave_metrics(w, s, 0, null).window_end, 15);
  throws_code(() => wave_metrics({ ...w, start: 9 }, s, 0, null), 'E_BAD_DATE'); // раньше ряда
  throws_code(() => wave_metrics({ ...w, start: 16, end: 16 }, s, 0, null), 'E_BAD_DATE'); // позже ряда
  throws_code(() => wave_metrics(w, s, -1, null), 'E_SCHEMA');
  // need < 1: ряд не содержит расхода волны
  const flat = { from: 0, opening_minor: 100, close: [100, 100], trough: [100, 100] };
  throws_code(() => wave_metrics({ wave_id: 'wave:z', start: 0, end: 0, event_ids: ['z'], total_out_minor: 5 }, flat, 0, null), 'E_SCHEMA');
});

test('TST-03 next_income_day: первое поступление строго после даты; расходы и нулевые суммы не считаются; нет — null', () => {
  const ev = [
    { kind: 'income', amount_minor: 100, date: 5 }, { kind: 'income', amount_minor: 100, date: 9 }, { kind: 'expense', amount_minor: -50, date: 6 },
    { kind: 'income', amount_minor: 0, date: 7 },
  ];
  assert.equal(next_income_day(ev, 4), 5);
  assert.equal(next_income_day(ev, 5), 9, 'строго после');
  assert.equal(next_income_day(ev, 9), null);
  assert.equal(next_income_day([], 0), null);
  assert.equal(next_income_day(ev, '1970-01-04'), 5, 'IsoDate допустима');
});

test('TST-03 list_waves: буфер не задан → B = 0 и W_BUFFER_UNSET (волны не блокируются); волна у края горизонта → W_WAVE_NEAR_HORIZON; нет рядов режима → E_SCHEMA', () => {
  const no_buf = run({ ...G, params: { ...G.params, buffer_minor: null } });
  const r = list_waves_ex(no_buf, 'plan');
  assert.ok(r.warnings.some((x) => x.code === 'W_BUFFER_UNSET'));
  assert.equal(r.items[0].metrics.need_minor, 172000, 'B = 0: need = R');
  assert.equal(r.items[0].metrics.gap_minor, 0);
  assert.ok(no_buf.warnings.some((x) => x.code === 'W_BUFFER_UNSET'));
  // горизонт до 11-26: W2 заканчивается 11-25, 11-25 + 3 > 11-26
  const near = run(G, { horizon_end: '2026-11-26' });
  assert.ok(list_waves_ex(near, 'plan').warnings.some((x) => x.code === 'W_WAVE_NEAR_HORIZON' && x.wave_id === 'wave:R-RENT@2026-11-25'));
  assert.ok(near.warnings.some((x) => x.code === 'W_WAVE_NEAR_HORIZON'));
  assert.ok(!run(G).warnings.some((x) => x.code === 'W_WAVE_NEAR_HORIZON'), 'на G-001 (57 дн.) предупреждения нет');
  throws_code(() => list_waves(run(G, { modes: ['plan'] }), 'worse'), 'E_SCHEMA');
  assert.deepEqual(SHAPE(list_waves(run(G), 'conservative')), SHAPE(list_waves(run(G), 'worse')), '«conservative» — синоним worse');
});

// ── TST-37: свойство ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Случайный набор событий (seed) и параметры волн. */
function random_case(rng) {
  const n = rng.int(0, 28);
  const evs = [];
  for (let k = 0; k < n; k++) {
    evs.push({
      cash_event_id: 'e' + String(k).padStart(2, '0') + (rng.bool() ? 'я' : 'a'), layer: 'planned', account_id: 'a', currency: 'EUR',
      date: rng.int(0, 45), amount_minor: rng.bool() && rng.bool() ? rng.int(1, 9000) : -rng.int(1, 9000), kind: 'expense',
      is_obligation: rng.int(0, 9) < 8, is_estimate: rng.int(0, 9) === 0,
    });
    evs[k].kind = evs[k].amount_minor > 0 ? 'income' : 'expense';
  }
  return { evs, params: P(rng.int(0, 5), rng.int(1, 14), rng.int(1, 5000)) };
}

const KEY = (e) => [e.date, e.amount_minor, e.cash_event_id];
function key_cmp(a, b) {
  const x = KEY(a);
  const y = KEY(b);
  return x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0);
}

test('TST-37 свойство (10³ случаев, seed 3701): каждое значимое обязательство — ровно в одной волне; Σ total_out = Σ значимых; инварианты разрыва и размаха; результат не зависит от порядка входа', () => {
  const rng = make_rng(3701);
  for (let c = 0; c < 1000; c++) {
    const { evs, params } = random_case(rng);
    const { g, S, theta } = { g: params.wave.gap_days, S: params.wave.max_span_days, theta: params.wave.threshold_minor };
    const sig = evs.filter((e) => e.is_obligation && !e.is_estimate && e.amount_minor < 0 && -e.amount_minor >= theta);
    const waves = detect_waves(evs, params);
    const flat = waves.flatMap((w) => w.event_ids);
    assert.equal(flat.length, sig.length, `случай ${c}: число`);
    assert.deepEqual([...flat].sort(), sig.map((e) => e.cash_event_id).sort(), `случай ${c}: каждое — ровно в одной волне`);
    assert.equal(waves.reduce((s, w) => s + w.total_out_minor, 0), sig.reduce((s, e) => s - e.amount_minor, 0), `случай ${c}: Σ total_out`);
    const get = by_id_of(evs);
    waves.forEach((w, k) => {
      const members = w.event_ids.map((id) => get.get(id));
      assert.deepEqual([...members].sort(key_cmp), members, `случай ${c}: события волны по ключу сортировки`);
      assert.equal(w.start, members[0].date);
      assert.equal(w.end, members[members.length - 1].date);
      assert.ok(w.end - w.start < S, `случай ${c}: размах < S`);
      for (let i = 1; i < members.length; i++) assert.ok(members[i].date - members[i - 1].date <= g, `случай ${c}: разрыв ≤ g`);
      if (k > 0) { // следующая волна началась из-за разрыва > g либо из-за размаха ≥ S
        const prev = waves[k - 1];
        assert.ok(w.start - prev.end > g || w.start - prev.start >= S, `случай ${c}: граница волн обоснована`);
      }
    });
    const shuffled = [...evs].sort(() => rng.next() - 0.5);
    assert.deepEqual(detect_waves(shuffled, params), waves, `случай ${c}: порядок входа не влияет`);
    // локальность: события ниже θ, оценки и расходы без is_obligation состав не меняют
    const noise = [...evs, { cash_event_id: 'zz-noise', layer: 'planned', account_id: 'a', currency: 'EUR', date: rng.int(0, 45), amount_minor: -(theta - 1), kind: 'expense', is_obligation: true, is_estimate: false }];
    if (theta > 1) assert.deepEqual(detect_waves(noise, params), waves, `случай ${c}: фон не меняет состав`);
  }
});

test('TST-37 свойство (10³ случаев, seed 3702): после правок split / merge / pin разбиение сохраняется; одиночная правка идемпотентна; ссылки на исчезнувшие события дают W_OVERRIDE_STALE', () => {
  const rng = make_rng(3702);
  for (let c = 0; c < 1000; c++) {
    const { evs, params } = random_case(rng);
    const base = detect_waves(evs, params);
    const get = by_id_of(evs);
    const sig_ids = base.flatMap((w) => w.event_ids);
    const all_ids = evs.map((e) => e.cash_event_id);
    const pick = () => {
      const k = rng.int(0, 3);
      const ids = [];
      for (let i = 0; i < k; i++) ids.push(rng.bool() && all_ids.length > 0 ? rng.pick(all_ids) : 'ghost' + rng.int(0, 2));
      return ids;
    };
    const overrides = [];
    for (let i = 0, n = rng.int(1, 4); i < n; i++) {
      const action = rng.pick(['split', 'merge', 'pin']);
      const o = { override_id: 'o' + i, action, event_ids: pick(), seq: i };
      if (action === 'pin' && rng.bool()) o.pin_range = { from: rng.int(0, 20), to: rng.int(20, 45) };
      overrides.push(o);
    }
    const { waves, warnings } = apply_wave_overrides_ex(base, overrides, get);
    assert.deepEqual(waves.flatMap((w) => w.event_ids).sort(), [...sig_ids].sort(), `случай ${c}: разбиение сохраняется`);
    assert.equal(waves.reduce((s, w) => s + w.total_out_minor, 0), base.reduce((s, w) => s + w.total_out_minor, 0), `случай ${c}: Σ total_out`);
    for (const w of waves) {
      const members = w.event_ids.map((id) => get.get(id));
      assert.deepEqual([...members].sort(key_cmp), members);
      assert.equal(w.wave_id, 'wave:' + w.event_ids[0]);
      assert.equal(w.start, members[0].date);
      assert.equal(w.end, members[members.length - 1].date);
    }
    for (let k = 1; k < waves.length; k++) assert.ok(waves[k - 1].start < waves[k].start || (waves[k - 1].start === waves[k].start && waves[k - 1].wave_id < waves[k].wave_id), 'порядок (start, wave_id)');
    // устаревшие ссылки: ровно те идентификаторы, которых нет среди значимых
    for (const o of overrides) {
      const stale = o.event_ids.filter((i) => !sig_ids.includes(i));
      if (stale.length > 0) assert.ok(warnings.some((x) => x.override_id === o.override_id), `случай ${c}: W_OVERRIDE_STALE для ${o.override_id}`);
    }
    // одиночная правка идемпотентна, правки переживают пересчёт на тех же данных
    for (const o of overrides) {
      const once = apply_wave_overrides(base, [o], get);
      assert.deepEqual(apply_wave_overrides(once, [o], get), once, `случай ${c}: идемпотентность ${o.action}`);
    }
    assert.deepEqual(apply_wave_overrides(detect_waves([...evs].reverse(), params), overrides, get), waves, `случай ${c}: правки переживают пересчёт`);
  }
});
