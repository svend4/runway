// semantics.test.mjs — СОСТЯЗАТЕЛЬНЫЙ ТЕСТ, линза C: семантика Q1/Q2/Q3, резервы, валюты, часы.
// Модули: waves, afford, timeline (сценарии, explain, Q1), sinking, tax, hourly, fx, debt (через analyze и напрямую).
// Ожидания выведены из канона (design-brief §2 D-01…D-23, §9, §12 X1…X13, §14; ALG-02…ALG-09, ALG-11) и независимого ручного расчёта —
// не из вывода движка. Тесты с пометкой «БАГ» падают намеренно (улики), тесты с {todo} — подозрения на ошибку самого канона.
// В тестах допустимы Date/node:* (purity.test.mjs проверяет только engine/).
//
// ПОДТВЕРЖДЁННЫЕ БАГИ (тесты падают намеренно — улики; ищи слово «БАГ» в названии):
//   B1  hourly/timeline: «закрытый период» считается от window.from (= дата якоря), а не от as_of → actual_minutes и W_HOURS_NOT_CONFIRMED теряются при якоре старше as_of.
//   B2  analyze: W_RATE_STALE (X11, REQ-079) не выдаётся — rate_status нигде не вызывается.
//   B3  analyze/opening_state: счёт kind = crypto с liquidity = operating молча попадает в opening (канон: E_SCHEMA / «в operating не входит»).
//   B4  fx.to_decision_events/timeline: «внутренний перевод» определяется по ногам, попавшим в окно событий → расход на накопительный счёт пропадает (просроченная нога, нога за горизонтом).
//   B5  debt.amortization_schedule: допустимые по validate_debt входы дают E_SCHEMA degenerate_schedule или строку с нулевым основным долгом.
//   B6  sinking.reserve_open/analyze: записанное списание больше накопленного (funded_open < 0) роняет весь analyze (E_SCHEMA).
//   B7  timeline.readiness: «доход в ближайшие 45 дней» ищется только внутри horizon_days → при horizon_days < 45 гейт Q3 отказывает без причины.
// Подозрения на ошибки канона — тесты с {todo} (canon_suspect в названии).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { analyze } from '../../engine/index.mjs';
import * as T from '../../engine/timeline.mjs';
import * as W from '../../engine/waves.mjs';
import * as A from '../../engine/afford.mjs';
import * as S from '../../engine/sinking.mjs';
import * as X from '../../engine/tax.mjs';
import * as H from '../../engine/hourly.mjs';
import * as F from '../../engine/fx.mjs';
import * as Dt from '../../engine/debt.mjs';
import * as D from '../../engine/dates.mjs';
import * as M from '../../engine/money.mjs';
import { make_rng, throws_code } from '../helpers.mjs';

const P = D.parse_date;
const fmt = D.format_date;
const AS_OF = P('2026-10-04'); // 20730
const DATA = new URL('../../data/', import.meta.url);
const load = (name) => JSON.parse(fs.readFileSync(new URL(name, DATA), 'utf8'));

// ═══ оснастка ═══════════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Малая рабочая область: один EUR-счёт `acc` с якорем на `as_of` (или на `anchor_date`), разовые плановые записи `plans`.
 * Записи `plans`: `{id, date, amount_minor, kind?, tag?, is_obligation?, is_estimate?, ...}`; `date` — ISO.
 */
function mkws({ opening = 100000, as_of = '2026-10-04', anchor_date = as_of, plans = [], params = {}, extra = {} } = {}) {
  return {
    decision_currency: 'EUR',
    params: { horizon_days: 30, ...params },
    accounts: [{ account_id: 'acc', kind: 'bank', liquidity: 'operating', currency: 'EUR' }],
    anchors: [{ anchor_id: 'a1', account_id: 'acc', date: anchor_date, amount_minor: opening }],
    plans: plans.map((p, i) => ({ plan_id: p.id ?? 'p' + i, account_id: 'acc', currency: 'EUR', kind: p.amount_minor > 0 ? 'income' : 'expense', ...p })),
    ...extra,
  };
}
const day = (n) => fmt(AS_OF + n);
/** Рабочая область с готовностью 4 (счёт, значимое обязательство, доход ≤ 45 дн., оценка повседневных): для гейта Q3. */
function ready_plans() {
  return [
    { id: 'r-obl', date: day(3), amount_minor: -5000, tag: 'аренда', is_obligation: true },
    { id: 'r-inc', date: day(10), amount_minor: 1000, tag: 'доход' },
    { id: 'r-est', date: day(4), amount_minor: -100, tag: 'еда', is_estimate: true },
  ];
}
/** Синтетический `ctx` для afford (свободные ряды заданы напрямую). */
function mkctx(fp, fw, o = {}) {
  const N = fp.length;
  const tp = o.tp ?? fp;
  const tw = o.tw ?? fw;
  return {
    as_of: 0, horizon_end: N - 1, decision_currency: 'EUR', params: {}, readiness: { score: 4 }, anchor_status: { level: 'fresh' }, rule_status: {},
    buffer_minor: o.B ?? 0, events: { plan: o.events_plan ?? [], worse: o.events_worse ?? [] },
    series: { plan: { free: fp, trough: tp }, worse: { free: fw, trough: tw } },
  };
}
const ev_of = (id, date, amount, o = {}) => ({
  cash_event_id: id, date: typeof date === 'string' ? P(date) : date, amount_minor: amount, kind: amount > 0 ? 'income' : 'expense',
  layer: 'planned', is_obligation: amount < 0, is_estimate: false, ...o,
});
const THETA = { 'wave.gap_days': 3, 'wave.max_span_days': 10, 'wave.threshold_minor': 3000 };
const show_waves = (ws) => ws.map((w) => [w.event_ids.join(','), fmt(w.start), fmt(w.end), w.total_out_minor]);

// ═══ ВОЛНЫ: границы g / S / θ (D-09, X1, TST-03, TST-37) ═══════════════════════════════════════════════════════════════

test('TST-03 ADV волны: разрыв ровно g вместе, g+1 раздельно (условие ≤ g)', () => {
  const a = ev_of('a', '2026-10-01', -5000);
  assert.deepEqual(show_waves(W.detect_waves([a, ev_of('b', '2026-10-04', -5000)], THETA)), [['a,b', '2026-10-01', '2026-10-04', 10000]]);
  assert.deepEqual(show_waves(W.detect_waves([a, ev_of('b', '2026-10-05', -5000)], THETA)), [['a', '2026-10-01', '2026-10-01', 5000], ['b', '2026-10-05', '2026-10-05', 5000]]);
});

test('TST-03 ADV волны: размах S — строго «< S»: цепочка 0,3,6,9 — одна волна, 0,3,6,9,10 — новая волна несмотря на разрыв 1', () => {
  const mk = (offs) => offs.map((o, i) => ev_of('e' + i, AS_OF + o, -5000));
  assert.equal(W.detect_waves(mk([0, 3, 6, 9]), THETA).length, 1);
  const w = W.detect_waves(mk([0, 3, 6, 9, 10]), THETA);
  assert.deepEqual(w.map((x) => x.event_ids), [['e0', 'e1', 'e2', 'e3'], ['e4']]);
  // S = 1: в одну волну попадают только события одного дня (d − start = 0 < 1)
  const w1 = W.detect_waves([ev_of('a', 1, -5000), ev_of('b', 1, -4000), ev_of('c', 2, -4000)], { ...THETA, 'wave.max_span_days': 1 });
  assert.deepEqual(w1.map((x) => x.event_ids), [['a', 'b'], ['c']]);
});

test('TST-03 X1 ADV θ включительно: |amount| = θ — обязательство, θ−1 — фон; фон не склеивает волны и не режет их', () => {
  assert.equal(W.detect_waves([ev_of('a', 1, -3000)], THETA).length, 1);
  assert.equal(W.detect_waves([ev_of('a', 1, -2999)], THETA).length, 0);
  // фон между двумя обязательствами с разрывом 5 > g: мост не строится
  const bridged = W.detect_waves([ev_of('a', 1, -5000), ev_of('bg', 3, -2999), ev_of('b', 6, -5000)], THETA);
  assert.deepEqual(bridged.map((x) => x.event_ids), [['a'], ['b']]);
  // фон между двумя обязательствами с разрывом 2 ≤ g: не разделяет
  assert.deepEqual(W.detect_waves([ev_of('a', 1, -5000), ev_of('bg', 2, -2999), ev_of('b', 3, -5000)], THETA).map((x) => x.event_ids), [['a', 'b']]);
});

test('TST-03 ADV волны: не-обязательства (без is_obligation, is_estimate, доходы, нулевые) в состав не входят; оценка-обязательство тоже фон', () => {
  const evs = [
    ev_of('no_obl', 1, -9000, { is_obligation: false }), ev_of('est', 1, -9000, { is_obligation: true, is_estimate: true }),
    ev_of('inc', 1, 9000, { is_obligation: true }), ev_of('zero', 1, 0, { is_obligation: true }), ev_of('ok', 1, -9000),
  ];
  assert.deepEqual(W.detect_waves(evs, THETA).map((x) => x.event_ids), [['ok']]);
});

test('TST-03 ADV волны: в один день — крупнее первым, затем по id; wave_id = id первого; результат не зависит от порядка входа', () => {
  const evs = [ev_of('c', 5, -5000), ev_of('a', 5, -9000), ev_of('b', 5, -5000), ev_of('z', 20, -4000)];
  const w = W.detect_waves(evs, THETA);
  assert.deepEqual(w.map((x) => [x.wave_id, x.event_ids, x.total_out_minor]), [['wave:a', ['a', 'b', 'c'], 19000], ['wave:z', ['z'], 4000]]);
  assert.deepEqual(W.detect_waves([...evs].reverse(), THETA), w);
  assert.deepEqual(W.detect_waves([evs[3], evs[1], evs[0], evs[2]], THETA), w);
});

test('TST-03 ADV волны: даты как ISO-строки и EpochDay дают одно и то же; пустой и undefined список — пустой результат', () => {
  const iso = [{ ...ev_of('a', 0, -5000), date: '2026-10-05' }, { ...ev_of('b', 0, -5000), date: '2026-10-06' }];
  const num = [ev_of('a', '2026-10-05', -5000), ev_of('b', '2026-10-06', -5000)];
  assert.deepEqual(W.detect_waves(iso, THETA), W.detect_waves(num, THETA));
  assert.deepEqual(W.detect_waves([], THETA), []);
  assert.deepEqual(W.detect_waves(undefined, THETA), []);
});

// ═══ ВОЛНЫ: метрики и окно (D-10, C-012, C-013) ═════════════════════════════════════════════════════════════════════════

function mk_series(events, opening, from, N) {
  return T.project(events, opening, from, from + N - 1);
}

test('TST-03 ADV wave_metrics: окно до дня перед ближайшим приходом; фон окна входит в min trough (ручной расчёт)', () => {
  // from = 100, opening 100000: d102 −30000 (волна), d103 −10000 (фон), d105 +50000, d106 −20000
  const evs = [ev_of('w', 102, -30000), ev_of('bg', 103, -10000, { is_obligation: false }), ev_of('in', 105, 50000), ev_of('x', 106, -20000, { is_obligation: false })];
  const s = mk_series(evs, 100000, 100, 10);
  const wave = W.detect_waves(evs, THETA)[0];
  const m = W.wave_metrics(wave, s, 15000, W.next_income_day(evs, wave.end));
  // cash_w = close[101] = 100000; окно [102, 104]; min trough = 60000 (d103, d104); R = 40000; need = 55000; gap = max(0, 15000 − 60000) = 0; floor(1000·100000/55000) = 1818
  assert.deepEqual(m, { window_end: 104, cash_minor: 100000, min_trough: { date: 103, amount_minor: 60000 }, r_minor: 40000, need_minor: 55000, gap_minor: 0, coverage_pm: 1818, reserved_minor: 0 });
});

test('TST-03 ADV wave_metrics: приход на следующий день после конца волны — окно = [start, end]; приход внутри волны окно не режет', () => {
  const evs = [ev_of('w1', 102, -30000), ev_of('w2', 104, -20000), ev_of('in_inside', 103, 5000), ev_of('in_next', 105, 40000)];
  const s = mk_series(evs, 100000, 100, 10);
  const wave = W.detect_waves(evs, THETA)[0];
  assert.deepEqual([wave.start, wave.end], [102, 104]);
  assert.equal(W.next_income_day(evs, wave.end), 105, 'приход внутри волны (d103) не считается «следующим после конца»');
  const m = W.wave_metrics(wave, s, 0, 105);
  assert.equal(m.window_end, 104, 'e_ext = max(end, 105 − 1)');
  // trough: d102 70000, d103 70000 (расходов нет, +5000 в close), d104 = 75000 − 20000 = 55000
  assert.deepEqual(m.min_trough, { date: 104, amount_minor: 55000 });
  assert.equal(m.r_minor, 100000 - 55000);
});

test('TST-03 ADV wave_metrics: поступление позже горизонта или его отсутствие — окно до horizon_end; поступление на horizon_end+1 — тоже', () => {
  const evs = [ev_of('w', 102, -30000)];
  const s = mk_series(evs, 100000, 100, 10); // horizon_end = 109
  const wave = W.detect_waves(evs, THETA)[0];
  assert.equal(W.wave_metrics(wave, s, 0, null).window_end, 109);
  assert.equal(W.wave_metrics(wave, s, 0, 200).window_end, 109);
  assert.equal(W.wave_metrics(wave, s, 0, 110).window_end, 109, 'приход на горизонт+1: день перед ним = horizon_end');
  assert.equal(W.wave_metrics(wave, s, 0, 109).window_end, 108);
});

test('TST-03 ADV wave_metrics: cash_w < 0 — coverage_pm отрицательное с ПОЛОМ (не усечением): floor(−8333,33) = −8334; gap честно большой', () => {
  const evs = [ev_of('w', 100, -5000)];
  const s = mk_series(evs, -100000, 100, 5);
  const wave = W.detect_waves(evs, THETA)[0];
  const m = W.wave_metrics(wave, s, 7000, null);
  assert.equal(m.cash_minor, -100000);
  assert.equal(m.r_minor, 5000);
  assert.equal(m.need_minor, 12000);
  assert.equal(m.gap_minor, 7000 + 105000, 'gap = max(0, B − min trough) = 7000 − (−105000)');
  assert.equal(m.coverage_pm, -8334);
});

test('TST-03 ADV wave_metrics: волна на as_of берёт cash_w из opening_minor, reserved — из reserve_opening_minor (C-012)', () => {
  const evs = [ev_of('w', 100, -5000)];
  const s = { ...mk_series(evs, 77000, 100, 5), reserve_opening_minor: 30000, reserve_close: [30000, 30000, 30000, 30000, 30000] };
  const m = W.wave_metrics(W.detect_waves(evs, THETA)[0], s, 1000, null);
  assert.equal(m.cash_minor, 77000);
  assert.equal(m.reserved_minor, 30000);
  // волна не на as_of — reserve_close[start − 1]
  const evs2 = [ev_of('w', 102, -5000)];
  const s2 = { ...mk_series(evs2, 77000, 100, 5), reserve_opening_minor: 30000, reserve_close: [31000, 32000, 33000, 34000, 35000] };
  assert.equal(W.wave_metrics(W.detect_waves(evs2, THETA)[0], s2, 0, null).reserved_minor, 32000);
});

test('TST-03 ADV wave_metrics: B < 0 — E_SCHEMA; волна вне ряда — E_BAD_DATE; B = 0 допустим', () => {
  const evs = [ev_of('w', 102, -5000)];
  const s = mk_series(evs, 10000, 100, 5);
  const wave = W.detect_waves(evs, THETA)[0];
  throws_code(() => W.wave_metrics(wave, s, -1, null), 'E_SCHEMA');
  throws_code(() => W.wave_metrics({ ...wave, start: 150, end: 150 }, s, 0, null), 'E_BAD_DATE');
  assert.equal(W.wave_metrics(wave, s, 0, null).gap_minor, 0);
});

test('TST-03 ADV next_income_day: строго после after; нулевые и отрицательные суммы и расходы не считаются приходом; ISO-даты', () => {
  // 1970-04-17 = EpochDay 106 (янв 31 + фев 28 + мар 31 = 90 → 1 апреля = 90)
  const evs = [ev_of('neg', 101, -5, { kind: 'income' }), { ...ev_of('i0', 102, 0), kind: 'income' }, ev_of('exp', 103, -5), { ...ev_of('i1', 0, 10), date: '1970-04-17' }, ev_of('i2', 110, 10)];
  assert.equal(W.next_income_day(evs, 100), 106);
  assert.equal(W.next_income_day(evs, 106), 110, 'строго после after');
  assert.equal(W.next_income_day(evs, 110), null);
  assert.equal(W.next_income_day([], 0), null);
});

// ═══ ВОЛНЫ через analyze: буфер не задан, граница горизонта, отрицательный старт ════════════════════════════════════════

test('TST-03 C-018 ADV analyze → list_waves: буфер не задан — B = 0, W_BUFFER_UNSET, волны НЕ блокируются; gate Q3 отвечает no_buffer', () => {
  const ws = mkws({ opening: 50000, plans: [...ready_plans()] });
  const a = analyze(ws, { as_of: '2026-10-04' });
  assert.equal(a.buffer_minor, null);
  assert.ok(a.warnings.some((w) => w.code === 'W_BUFFER_UNSET'));
  const r = W.list_waves_ex(a, 'plan');
  assert.ok(r.warnings.some((w) => w.code === 'W_BUFFER_UNSET'));
  assert.equal(r.items.length, 1);
  // B = 0: gap = max(0, 0 − min trough) = 0, need = R_w
  assert.equal(r.items[0].metrics.gap_minor, 0);
  assert.equal(r.items[0].metrics.need_minor, r.items[0].metrics.r_minor);
  assert.deepEqual(A.gate(a), { kind: 'insufficient_data', reason: 'no_buffer', reasons: ['no_buffer'] });
  // явный 0 — «задан»
  assert.equal(A.gate({ ...a, buffer_minor: 0 }), null);
  assert.equal(A.gate(a, 0), null, 'N6: буфер вызова перекрывает ctx');
});

test('TST-03 C-021 ADV W_WAVE_NEAR_HORIZON: граница «end + g > horizon_end» — wave.end = horizon_end − g без предупреждения, на 1 позже — с ним', () => {
  const mk = (n) => mkws({ opening: 100000, params: { horizon_days: 30, buffer_minor: 1000 }, plans: [{ id: 'o', date: day(n), amount_minor: -5000, is_obligation: true }] });
  const warn = (n) => W.list_waves_ex(analyze(mk(n), { as_of: '2026-10-04' }), 'plan').warnings.filter((w) => w.code === 'W_WAVE_NEAR_HORIZON');
  assert.equal(warn(27).length, 0, '27 + 3 = 30 — не больше горизонта');
  assert.equal(warn(28).length, 1, '28 + 3 = 31 > 30');
  assert.equal(warn(30).length, 1);
});

test('TST-03 D-10 ADV отрицательный старт: Q1 — first_breach на as_of, ok_cash = false, need = B − min; волна — отрицательное покрытие', () => {
  const ws = mkws({ opening: -20000, params: { buffer_minor: 7000 }, plans: [{ id: 'o', date: day(2), amount_minor: -5000, is_obligation: true }] });
  const a = analyze(ws, { as_of: '2026-10-04' });
  const q = a.q1.plan;
  assert.deepEqual([q.min, q.at, q.ok_cash, q.ok_buffer, q.first_breach, q.first_buffer_breach], [-25000, AS_OF + 2, false, false, AS_OF, AS_OF]);
  assert.equal(q.need, 7000 + 25000);
  const m = W.list_waves(a, 'plan')[0].metrics;
  // cash_w = close[1] = −20000; min trough −25000; R = 5000; need = 12000; coverage = floor(−20000000/12000) = floor(−1666,67) = −1667
  assert.deepEqual([m.cash_minor, m.r_minor, m.need_minor, m.coverage_pm, m.gap_minor], [-20000, 5000, 12000, -1667, 32000]);
});

// ═══ ВОЛНЫ: ручные правки (D-09, C-014, TST-37) ═════════════════════════════════════════════════════════════════════════

const OV_EVS = [ev_of('a', 1, -5000), ev_of('b', 3, -5000), ev_of('c', 6, -5000), ev_of('d', 20, -5000), ev_of('bg', 2, -2999)];
const OV_BY = Object.fromEntries(OV_EVS.map((e) => [e.cash_event_id, e]));
const OV_WAVES = W.detect_waves(OV_EVS, THETA);
const ids_of = (ws) => ws.map((w) => w.event_ids);

test('TST-37 ADV правки: исходные волны [a,b,c] и [d]; split режет ПЕРЕД событием; split первого события и одиночной волны — без изменений', () => {
  assert.deepEqual(ids_of(OV_WAVES), [['a', 'b', 'c'], ['d']]);
  assert.deepEqual(ids_of(W.apply_wave_overrides(OV_WAVES, [{ action: 'split', event_ids: ['c'] }], OV_BY)), [['a', 'b'], ['c'], ['d']]);
  assert.deepEqual(ids_of(W.apply_wave_overrides(OV_WAVES, [{ action: 'split', event_ids: ['b'] }], OV_BY)), [['a'], ['b', 'c'], ['d']]);
  const noop = W.apply_wave_overrides_ex(OV_WAVES, [{ action: 'split', event_ids: ['a', 'd'] }], OV_BY);
  assert.deepEqual(ids_of(noop.waves), [['a', 'b', 'c'], ['d']]);
  assert.deepEqual(noop.warnings, []);
});

test('TST-37 ADV правки: merge объединяет волны указанных событий (в т. ч. разнесённые на 19 дней), total и границы пересчитываются', () => {
  const r = W.apply_wave_overrides(OV_WAVES, [{ action: 'merge', event_ids: ['a', 'd'] }], OV_BY);
  assert.deepEqual(ids_of(r), [['a', 'b', 'c', 'd']]);
  assert.deepEqual([r[0].start, r[0].end, r[0].total_out_minor, r[0].wave_id], [1, 20, 20000, 'wave:a']);
  // merge двух событий одной волны — без изменений
  assert.deepEqual(ids_of(W.apply_wave_overrides(OV_WAVES, [{ action: 'merge', event_ids: ['a', 'c'] }], OV_BY)), [['a', 'b', 'c'], ['d']]);
});

test('TST-37 ADV правки: pin извлекает события в отдельную волну (остаток исходной остаётся одной волной); pin_range добавляет события по дате', () => {
  assert.deepEqual(ids_of(W.apply_wave_overrides(OV_WAVES, [{ action: 'pin', event_ids: ['b'] }], OV_BY)), [['a', 'c'], ['b'], ['d']]);
  const r = W.apply_wave_overrides(OV_WAVES, [{ action: 'pin', event_ids: [], pin_range: { from: 3, to: 6 } }], OV_BY);
  assert.deepEqual(ids_of(r), [['a'], ['b', 'c'], ['d']]);
  // pin_range с ISO-датами: 1970-01-04 = EpochDay 3, 1970-01-07 = EpochDay 6
  const r2 = W.apply_wave_overrides(OV_WAVES, [{ action: 'pin', event_ids: ['d'], pin_range: { from: '1970-01-04', to: '1970-01-07' } }], OV_BY);
  assert.deepEqual(ids_of(r2).map((x) => x.join('')).sort(), ['a', 'bcd'].sort(), 'в одну закреплённую волну: d и события диапазона b, c');
});

test('TST-37 C-014 ADV правки: ссылка на исчезнувшее событие и на событие-фон — W_OVERRIDE_STALE, правка пропущена, волны не воскрешаются', () => {
  const r = W.apply_wave_overrides_ex(OV_WAVES, [{ override_id: 'o1', action: 'split', event_ids: ['ghost'] }, { override_id: 'o2', action: 'merge', event_ids: ['bg', 'a'] }], OV_BY);
  assert.deepEqual(r.warnings, [
    { code: 'W_OVERRIDE_STALE', override_id: 'o1', event_ids: ['ghost'] },
    { code: 'W_OVERRIDE_STALE', override_id: 'o2', event_ids: ['bg'] },
  ]);
  assert.deepEqual(ids_of(r.waves), [['a', 'b', 'c'], ['d']], 'merge{bg, a} сводится к merge{a}: волна не меняется');
  assert.equal(r.waves.flatMap((w) => w.event_ids).includes('bg'), false, 'фон в волну не попал');
});

test('TST-37 C-014 ADV правки: порядок — по seq (если задан у всех), иначе по порядку массива; результат различается', () => {
  const ops = (s1, s2) => [{ action: 'merge', event_ids: ['a', 'd'], ...(s1 === undefined ? {} : { seq: s1 }) }, { action: 'split', event_ids: ['c'], ...(s2 === undefined ? {} : { seq: s2 }) }];
  // по массиву: merge (всё в одну), затем split перед c → [a,b], [c,d]
  assert.deepEqual(ids_of(W.apply_wave_overrides(OV_WAVES, ops(), OV_BY)), [['a', 'b'], ['c', 'd']]);
  // по seq: split (seq 1) раньше merge (seq 2) → [a,b,d], [c]
  assert.deepEqual(ids_of(W.apply_wave_overrides(OV_WAVES, ops(2, 1), OV_BY)), [['a', 'b', 'd'], ['c']]);
});

test('TST-37 ADV правки: неизвестное действие, event_ids не массив, событие волны отсутствует в by_id — E_SCHEMA', () => {
  throws_code(() => W.apply_wave_overrides(OV_WAVES, [{ action: 'explode', event_ids: ['a'] }], OV_BY), 'E_SCHEMA');
  throws_code(() => W.apply_wave_overrides(OV_WAVES, [{ action: 'split', event_ids: 'a' }], OV_BY), 'E_SCHEMA');
  throws_code(() => W.apply_wave_overrides(OV_WAVES, [], { a: OV_BY.a }), 'E_SCHEMA');
});

test('TST-37 ADV правки: случайные последовательности правок сохраняют разбиение — каждое значимое обязательство ровно в одной волне, Σ total = Σ|amount|, границы волн точные', () => {
  const rng = make_rng(20261004);
  for (let it = 0; it < 300; it++) {
    const n = rng.int(1, 9);
    const evs = Array.from({ length: n }, (_, i) => ev_of('e' + i, rng.int(0, 30), -rng.int(3000, 9000)));
    const by = Object.fromEntries(evs.map((e) => [e.cash_event_id, e]));
    const params = { 'wave.gap_days': rng.int(0, 5), 'wave.max_span_days': rng.int(1, 12), 'wave.threshold_minor': 3000 };
    const waves = W.detect_waves(evs, params);
    const ov = Array.from({ length: rng.int(0, 5) }, (_, i) => {
      const o = { override_id: 'o' + i, action: rng.pick(['split', 'merge', 'pin']), event_ids: Array.from({ length: rng.int(1, 3) }, () => 'e' + rng.int(0, n + 1)) };
      if (o.action === 'pin' && rng.bool()) { const f = rng.int(0, 30); o.pin_range = { from: f, to: f + rng.int(0, 6) }; }
      return o;
    });
    const out = W.apply_wave_overrides(waves, ov, by);
    const ids = out.flatMap((w) => w.event_ids);
    assert.equal(ids.length, n, `it ${it}: все события на месте`);
    assert.equal(new Set(ids).size, n, `it ${it}: нет дублей`);
    assert.equal(out.reduce((s, w) => s + w.total_out_minor, 0), evs.reduce((s, e) => s - e.amount_minor, 0));
    for (const w of out) {
      const ds = w.event_ids.map((i) => by[i].date);
      assert.equal(w.start, Math.min(...ds));
      assert.equal(w.end, Math.max(...ds));
      assert.equal(w.wave_id, 'wave:' + w.event_ids[0]);
    }
    for (let i = 1; i < out.length; i++) assert.ok(out[i - 1].start <= out[i].start, 'волны по возрастанию начала');
    assert.deepEqual(W.apply_wave_overrides(waves.slice().reverse(), ov, by), out, 'порядок входных волн не важен');
  }
});

test('TST-37 ADV правки: одиночная правка идемпотентна (повторное применение к результату ничего не меняет)', () => {
  const rng = make_rng(77);
  for (let it = 0; it < 300; it++) {
    const n = rng.int(2, 8);
    const evs = Array.from({ length: n }, (_, i) => ev_of('e' + i, rng.int(0, 30), -5000));
    const by = Object.fromEntries(evs.map((e) => [e.cash_event_id, e]));
    const waves = W.detect_waves(evs, { 'wave.gap_days': rng.int(0, 5), 'wave.max_span_days': rng.int(1, 12), 'wave.threshold_minor': 3000 });
    const o = { action: rng.pick(['split', 'merge', 'pin']), event_ids: ['e' + rng.int(0, n - 1), 'e' + rng.int(0, n - 1)] };
    if (o.action === 'pin' && rng.bool()) o.pin_range = { from: rng.int(0, 15), to: rng.int(15, 30) };
    const once = W.apply_wave_overrides(waves, [o], by);
    assert.deepEqual(W.apply_wave_overrides(once, [o], by), once, `it ${it}: ${JSON.stringify(o)}`);
  }
});

test('TST-37 ADV canon_suspect ALG-03 инв. 3: «повторное применение тех же правок ничего не меняет» неверно для ПОСЛЕДОВАТЕЛЬНОСТИ правок', { todo: 'канон: инвариант верен только для одиночной правки' }, () => {
  // a, b, c, d — четыре отдельные волны; правки merge{a,b}, split{b}, merge{a,c}
  const evs = ['a', 'b', 'c', 'd'].map((id, i) => ev_of(id, i * 20, -5000));
  const by = Object.fromEntries(evs.map((e) => [e.cash_event_id, e]));
  const waves = W.detect_waves(evs, THETA);
  const ov = [{ action: 'merge', event_ids: ['a', 'b'] }, { action: 'split', event_ids: ['b'] }, { action: 'merge', event_ids: ['a', 'c'] }];
  const once = W.apply_wave_overrides(waves, ov, by);
  assert.deepEqual(ids_of(once), [['a', 'c'], ['b'], ['d']]);
  assert.deepEqual(W.apply_wave_overrides(once, ov, by), once, 'второе применение даёт [a,b,c],[d]');
});

// ═══ SINKING (ALG-05, D-18, §9.12, X3) ══════════════════════════════════════════════════════════════════════════════════

test('X3 TST-23 ADV sinking: rem ≤ 0 и n = 0 — пустой график БЕЗ исключения; plan_status различает reached / no_dates / ok', () => {
  const d1 = [P('2026-11-01'), P('2026-12-01')];
  assert.deepEqual(S.contribution_plan({ target_minor: 100, funded_open_minor: 100, dates: d1 }), []);
  assert.deepEqual(S.contribution_plan({ target_minor: 100, funded_open_minor: 250, dates: d1 }), []);
  assert.deepEqual(S.contribution_plan({ target_minor: 100, funded_open_minor: 0, dates: [] }), []);
  assert.deepEqual(S.plan_status({ target_minor: 100, funded_open_minor: 100, dates: d1 }), { status: 'reached', shortfall_minor: 0 });
  assert.deepEqual(S.plan_status({ target_minor: 100, funded_open_minor: 0, dates: [] }), { status: 'no_dates', shortfall_minor: 100 });
  assert.deepEqual(S.plan_status({ target_minor: 100, funded_open_minor: 40, dates: d1 }), { status: 'ok', shortfall_minor: 0 });
  assert.deepEqual(S.plan_status({ target_minor: 100, funded_open_minor: 130, dates: [] }), { status: 'reached', shortfall_minor: 0 }, 'rem ≤ 0 приоритетнее отсутствия дат');
});

test('TST-23 §9.12 ADV sinking: векторы канона — страховка [12000×5], отпуск [21313×4, 21312×4] Σ 170500, день рождения [4200×5]', () => {
  const dates = (n) => Array.from({ length: n }, (_, i) => 20000 + i * 30);
  const amounts = (p) => S.contribution_plan(p).map((r) => r.amount_minor);
  assert.deepEqual(amounts({ target_minor: 60000, funded_open_minor: 0, dates: dates(5) }), [12000, 12000, 12000, 12000, 12000]);
  const vac = amounts({ target_minor: 180000, funded_open_minor: 9500, dates: dates(8) });
  assert.deepEqual(vac, [21313, 21313, 21313, 21313, 21312, 21312, 21312, 21312]);
  assert.equal(vac.reduce((a, b) => a + b, 0), 170500);
  assert.deepEqual(amounts({ target_minor: 25000, funded_open_minor: 4000, dates: dates(5) }), [4200, 4200, 4200, 4200, 4200]);
});

test('TST-23 ADV sinking: свойство — Σ взносов = rem, разброс соседних ≤ 1 minor, ранние крупнее, нулевые строки опущены (случайные входы)', () => {
  const rng = make_rng(5);
  for (let it = 0; it < 500; it++) {
    const n = rng.int(1, 40);
    const rem = rng.int(1, 5000000);
    const funded = rng.int(-1000, 1000);
    const rows = S.contribution_plan({ target_minor: rem + funded, funded_open_minor: funded, dates: Array.from({ length: n }, (_, i) => i) });
    const xs = rows.map((r) => r.amount_minor);
    assert.equal(xs.reduce((a, b) => a + b, 0), rem);
    assert.ok(xs.every((x) => x > 0));
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i - 1] >= xs[i] && xs[i - 1] - xs[i] <= 1, `it ${it}: ${xs[i - 1]} → ${xs[i]}`);
    assert.equal(xs.length, Math.min(n, rem), 'при rem < n — только rem строк по 1');
  }
});

test('TST-23 ADV sinking fixed: недостача отпуска 50500; потолок цели (последний взнос урезается); цель не задана — без потолка; fixed = 0', () => {
  const dates8 = Array.from({ length: 8 }, (_, i) => i);
  const r = S.contribution_plan_fixed({ funded_open_minor: 9500, fixed_minor: 15000, dates: dates8, target_minor: 180000 });
  assert.equal(r.shortfall_minor, 50500);
  assert.equal(r.reached_on, null);
  assert.equal(r.rows.length, 8);
  const cap = S.contribution_plan_fixed({ funded_open_minor: 0, fixed_minor: 30, dates: [10, 11, 12, 13, 14], target_minor: 100 });
  assert.deepEqual(cap.rows.map((x) => x.amount_minor), [30, 30, 30, 10]);
  assert.deepEqual([cap.shortfall_minor, cap.reached_on], [0, 13], 'пятая дата не нужна: цель достигнута на четвёртой');
  const free = S.contribution_plan_fixed({ funded_open_minor: 0, fixed_minor: 30, dates: [1, 2], target_minor: null });
  assert.deepEqual([free.rows.length, free.shortfall_minor, free.reached_on], [2, 0, null]);
  assert.deepEqual(S.contribution_plan_fixed({ funded_open_minor: 0, fixed_minor: 0, dates: [1, 2], target_minor: 50 }).rows, []);
  assert.equal(S.contribution_plan_fixed({ funded_open_minor: 0, fixed_minor: 0, dates: [1, 2], target_minor: 50 }).shortfall_minor, 50);
  assert.deepEqual(S.contribution_plan_fixed({ funded_open_minor: 70, fixed_minor: 30, dates: [1, 2], target_minor: 50 }), { rows: [], shortfall_minor: 0, reached_on: null });
  throws_code(() => S.contribution_plan_fixed({ funded_open_minor: 0, fixed_minor: -1, dates: [1], target_minor: 5 }), 'E_SCHEMA');
  assert.equal(S.periods_to_goal(100, 30), 4);
  assert.equal(S.periods_to_goal(0, 30), 0);
  assert.equal(S.periods_to_goal(-5, 30), 0);
  assert.equal(S.periods_to_goal(100, 0), null);
});

test('TST-23 ADV sinking: пул делится методом наибольших остатков (вектор §9.12: 37500 → [11996, 4198, 21306]); нулевые веса — нули', () => {
  assert.deepEqual(S.pool_split(37500, [12000, 4200, 21313]), [11996, 4198, 21306]);
  assert.deepEqual(S.pool_split(500, [0, 0, 0]), [0, 0, 0]);
  assert.equal(S.pool_split(1, [5, 5, 5]).reduce((a, b) => a + b, 0), 1);
});

test('TST-23 D-18 ADV contribution_dates: старт включительно, срок исключён; день 31 без дрейфа; weekend next/prev/skip; сдвиг за срок отбрасывается', () => {
  const cal = D.make_calendar({});
  const md = (s, d, c) => S.contribution_dates(P(s), P(d), c, cal).map(fmt);
  assert.deepEqual(md('2026-10-04', '2027-03-15', { freq: 'M', day: 1 }), ['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01', '2027-03-01']);
  assert.deepEqual(md('2026-10-04', '2027-03-01', { freq: 'M', day: 1 }), ['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01'], 'срок 03-01 в число дат не входит');
  assert.deepEqual(md('2026-11-01', '2026-12-02', { freq: 'M', day: 1 }), ['2026-11-01', '2026-12-01'], 'start включительно');
  assert.deepEqual(md('2026-01-01', '2026-04-01', { freq: 'M', day: 31 }), ['2026-01-31', '2026-02-28', '2026-03-31']);
  assert.deepEqual(md('2026-10-01', '2026-11-30', { freq: 'M', day: 31, weekend: 'next' }), ['2026-11-02'], '31 окт — суббота → понедельник 11-02');
  assert.deepEqual(md('2026-10-01', '2026-11-30', { freq: 'M', day: 31, weekend: 'prev' }), ['2026-10-30']);
  assert.deepEqual(md('2026-10-01', '2026-11-30', { freq: 'M', day: 31, weekend: 'skip' }), []);
  assert.deepEqual(md('2026-10-01', '2026-11-01', { freq: 'M', day: 31, weekend: 'next' }), [], '11-02 ≥ срока 11-01 — отброшена');
  assert.deepEqual(md('2026-11-05', '2026-11-05', { freq: 'M', day: 1 }), []);
  assert.deepEqual(md('2026-12-05', '2026-11-05', { freq: 'M', day: 1 }), [], 'срок раньше старта');
});

test('TST-23 ADV contribution_dates: freq ≠ M и день вне 1…31 — E_SCHEMA', () => {
  throws_code(() => S.contribution_dates(0, 100, { freq: 'W', day: 1 }), 'E_SCHEMA');
  throws_code(() => S.contribution_dates(0, 100, { freq: 'M', day: 0 }), 'E_SCHEMA');
  throws_code(() => S.contribution_dates(0, 100, { freq: 'M', day: 32 }), 'E_SCHEMA');
  throws_code(() => S.contribution_dates(0, 100, { freq: 'M', day: 1.5 }), 'E_SCHEMA');
});

test('TST-23 ALG-05 contribution_dates (закрыто FP-02, Q-18): номинальная дата ПРЕДЫДУЩЕГО месяца, сдвинутая weekend=next в окно, учитывается (цикл идёт от месяца start − 1)', () => {
  // 2026-10-31 — суббота → номинал сдвигается на 11-02 (понедельник); start = 11-01 → 11-02 лежит в [start, due), но октябрьский номинал не рассматривается
  const got = S.contribution_dates(P('2026-11-01'), P('2026-12-15'), { freq: 'M', day: 31, weekend: 'next' }, D.make_calendar({})).map(fmt);
  assert.deepEqual(got, ['2026-11-02', '2026-11-30'], 'ожидалось: 11-02 (из октября) и 11-30 (ноябрьский номинал, понедельник)');
});

test('TST-23 C-020 ADV reserve_open: funded_start + Σ аллокаций funded_as_of < date ≤ as_of; граница funded_as_of исключена, as_of включена; чужой резерв и будущее игнорируются; знаки суммируются', () => {
  const r = { reserve_id: 'R', funded_start_minor: 1000, funded_as_of: '2026-09-01' };
  const al = (id, d, a, rid = 'R', source = 'manual') => ({ allocation_id: id, reserve_id: rid, date: d, amount_minor: a, source });
  const allocs = [al('on_as_of_start', '2026-09-01', 500), al('x1', '2026-09-02', 200), al('x2', '2026-10-04', 300), al('future', '2026-10-05', 9999), al('other', '2026-09-10', 7777, 'R2'), al('rel', '2026-09-20', -150, 'R', 'release')];
  assert.equal(S.reserve_open(r, allocs, '2026-10-04'), 1000 + 200 + 300 - 150);
  assert.equal(S.reserve_open({ reserve_id: 'R' }, [], '2026-10-04'), 0);
  assert.equal(S.reserve_open({ reserve_id: 'R', funded_start_minor: 5 }, [al('any', '1999-01-01', 1)], '2026-10-04'), 6, 'без funded_as_of учитываются все записанные ≤ as_of');
});

test('TST-23 C-020 ADV contribution_allocations: страховка G-001 — 5 взносов по 12000 id sch:RES-INS@…; записанные id исключаются без изменения размера; горизонт обрезает строки, а не суммы', () => {
  const r = { reserve_id: 'RES-INS', kind: 'sinking', mode: 'refill_to_target', target_minor: 60000, due_date: '2027-03-15' };
  const cal = D.make_calendar({});
  const all = S.contribution_allocations(r, 0, '2026-10-04', '2027-03-31', cal, []);
  assert.deepEqual(all.map((a) => [a.allocation_id, a.amount_minor, a.source, fmt(a.date)]), [
    ['sch:RES-INS@2026-11-01', 12000, 'schedule', '2026-11-01'], ['sch:RES-INS@2026-12-01', 12000, 'schedule', '2026-12-01'],
    ['sch:RES-INS@2027-01-01', 12000, 'schedule', '2027-01-01'], ['sch:RES-INS@2027-02-01', 12000, 'schedule', '2027-02-01'],
    ['sch:RES-INS@2027-03-01', 12000, 'schedule', '2027-03-01'],
  ]);
  const cut = S.contribution_allocations(r, 0, '2026-10-04', '2026-11-30', cal, []);
  assert.deepEqual(cut.map((a) => a.amount_minor), [12000], 'в горизонте 57 дн. — только 11-01, размер от всего срока');
  // первый взнос записан: funded_open = 12000, id исключён, оставшиеся 4 по 12000
  const rec = S.contribution_allocations(r, 12000, '2026-10-04', '2027-03-31', cal, ['sch:RES-INS@2026-11-01']);
  assert.deepEqual(rec.map((a) => a.amount_minor), [12000, 12000, 12000, 12000]);
  // срок в прошлом — пусто, без исключения (X3)
  assert.deepEqual(S.contribution_allocations({ ...r, due_date: '2026-10-01' }, 0, '2026-10-04', '2027-03-31', cal, []), []);
});

test('TST-23 ADV contribution_allocations: fixed не переполняет цель, без due — до горизонта; ошибки конфигурации — E_SCHEMA', () => {
  const cal = D.make_calendar({});
  const fx = S.contribution_allocations({ reserve_id: 'V', kind: 'sinking', mode: 'fixed', fixed_minor: 15000, target_minor: 10000 }, 9500, '2026-10-04', '2026-12-31', cal, []);
  assert.deepEqual(fx.map((a) => a.amount_minor), [500], 'цель 10000, накоплено 9500: единственный взнос 500');
  const nolimit = S.contribution_allocations({ reserve_id: 'V', kind: 'sinking', mode: 'fixed', fixed_minor: 100 }, 0, '2026-10-04', '2026-12-31', cal, []);
  assert.deepEqual(nolimit.map((a) => fmt(a.date)), ['2026-11-01', '2026-12-01']);
  throws_code(() => S.contribution_allocations({ reserve_id: 'V', kind: 'tax', mode: 'fixed', fixed_minor: 1 }, 0, 0, 10, cal, []), 'E_SCHEMA');
  throws_code(() => S.contribution_allocations({ reserve_id: 'V', kind: 'sinking' }, 0, 0, 10, cal, []), 'E_SCHEMA');
  throws_code(() => S.contribution_allocations({ reserve_id: 'V', kind: 'sinking', mode: 'refill_to_target', target_minor: 5 }, 0, 0, 10, cal, []), 'E_SCHEMA');
  throws_code(() => S.contribution_allocations({ reserve_id: 'V', kind: 'sinking', mode: 'fixed' }, 0, 0, 10, cal, []), 'E_SCHEMA');
});

// ═══ reserve_series (ALG-11, D-08) ══════════════════════════════════════════════════════════════════════════════════════

test('TST-29 D-08 ADV reserve_series: порядок дня — взнос/правка (head) → релиз → trough → аллокация дохода (tail) → close; true_up уходит из свободных денег (ручной расчёт)', () => {
  const reserves = [{ reserve_id: 'R', funded_open_minor: 10000 }];
  const allocations = [
    { allocation_id: 's1', reserve_id: 'R', date: 2, amount_minor: 3000, source: 'schedule' },
    { allocation_id: 'i1', reserve_id: 'R', date: 2, amount_minor: 4000, source: 'income' },
  ];
  const events = [{ reserve_id: 'R', date: 2, amount_minor: -8000 }, { reserve_id: 'R', date: 3, amount_minor: -20000 }];
  const r = S.reserve_series(reserves, events, allocations, 0, 4);
  assert.deepEqual(r.reserve_trough, [10000, 10000, 5000, 0, 0]);
  assert.deepEqual(r.reserve_close, [10000, 10000, 9000, 0, 0]);
  const b = r.by_reserve.R;
  assert.deepEqual(b.contributed, [0, 0, 3000, 0, 0]);
  assert.deepEqual(b.released, [0, 0, 8000, 9000, 0]);
  assert.deepEqual(b.true_up, [0, 0, 0, 11000, 0]);
  assert.deepEqual(b.allocated, [0, 0, 4000, 0, 0]);
  assert.deepEqual(b.trough, r.reserve_trough);
  assert.deepEqual(b.close, r.reserve_close);
});

test('TST-29 D-08 ADV reserve_series: аллокация дохода того же дня НЕ покрывает платёж этого дня (платёж 5000, накоплено 3000, приход +4000 → released 3000, true_up 2000, close 4000)', () => {
  const r = S.reserve_series([{ reserve_id: 'T', funded_open_minor: 3000 }], [{ reserve_id: 'T', date: 0, amount_minor: -5000 }],
    [{ allocation_id: 'x', reserve_id: 'T', date: 0, amount_minor: 4000, source: 'income' }], 0, 1);
  assert.deepEqual([r.by_reserve.T.released[0], r.by_reserve.T.true_up[0], r.reserve_trough[0], r.reserve_close[0], r.reserve_close[1]], [3000, 2000, 0, 4000, 4000]);
});

test('TST-29 ADV reserve_series: платёж при пустом резерве — released 0, true_up = весь платёж; ручная правка больше накопленного обнуляет резерв (не уходит ниже 0)', () => {
  const r = S.reserve_series([{ reserve_id: 'E', funded_open_minor: 0 }], [{ reserve_id: 'E', date: 1, amount_minor: -700 }], [], 0, 2);
  assert.deepEqual([r.by_reserve.E.released[1], r.by_reserve.E.true_up[1]], [0, 700]);
  const m = S.reserve_series([{ reserve_id: 'M', funded_open_minor: 5000 }], [], [{ allocation_id: 'm', reserve_id: 'M', date: 1, amount_minor: -9000, source: 'manual' }], 0, 2);
  assert.deepEqual(m.reserve_close, [5000, 0, 0]);
  assert.deepEqual(m.by_reserve.M.contributed, [0, -5000, 0], 'фактически списано 5000, не 9000');
});

test('TST-29 D-07 ADV reserve_series: резерв с backed_by_account_id в ряд не входит; платёж чужого/неизвестного резерва и расход без reserve_id игнорируются; аллокации после горизонта и чужие — тоже', () => {
  const r = S.reserve_series([{ reserve_id: 'B', funded_open_minor: 7000, backed_by_account_id: 'sav' }, { reserve_id: 'A', funded_open_minor: 100 }],
    [{ reserve_id: 'B', date: 0, amount_minor: -50 }, { reserve_id: 'ZZ', date: 0, amount_minor: -50 }, { date: 0, amount_minor: -50 }],
    [{ allocation_id: 'l', reserve_id: 'A', date: 99, amount_minor: 5, source: 'manual' }, { allocation_id: 'z', reserve_id: 'ZZ', date: 0, amount_minor: 5, source: 'manual' }], 0, 1);
  assert.deepEqual(Object.keys(r.by_reserve), ['A']);
  assert.deepEqual(r.reserve_close, [100, 100]);
});

test('TST-29 ADV reserve_series: ошибки — funded_open < 0, аллокация раньше as_of, неизвестный source, отрицательная income-аллокация, дубль/пустой reserve_id, horizon < as_of', () => {
  const ok = [{ reserve_id: 'R', funded_open_minor: 0 }];
  throws_code(() => S.reserve_series([{ reserve_id: 'R', funded_open_minor: -1 }], [], [], 0, 1), 'E_SCHEMA');
  throws_code(() => S.reserve_series(ok, [], [{ allocation_id: 'x', reserve_id: 'R', date: -1, amount_minor: 1, source: 'manual' }], 0, 1), 'E_SCHEMA');
  throws_code(() => S.reserve_series(ok, [], [{ allocation_id: 'x', reserve_id: 'R', date: 0, amount_minor: 1, source: 'weird' }], 0, 1), 'E_SCHEMA');
  throws_code(() => S.reserve_series(ok, [], [{ allocation_id: 'x', reserve_id: 'R', date: 0, amount_minor: -1, source: 'income' }], 0, 1), 'E_SCHEMA');
  throws_code(() => S.reserve_series([...ok, ...ok], [], [], 0, 1), 'E_SCHEMA');
  throws_code(() => S.reserve_series([{ reserve_id: '', funded_open_minor: 0 }], [], [], 0, 1), 'E_SCHEMA');
  throws_code(() => S.reserve_series(ok, [], [], 5, 4), 'E_BAD_DATE');
});

test('TST-29 ADV free_series: free = trough − reserve_trough, может быть < 0; разная длина — E_SCHEMA; пустые ряды допустимы', () => {
  assert.deepEqual(S.free_series([100, 50, -5], [150, 20, 0]), [-50, 30, -5]);
  assert.deepEqual(S.free_series([], []), []);
  throws_code(() => S.free_series([1, 2], [1]), 'E_SCHEMA');
});

// ═══ НАЛОГИ: версии правил, аллокация, релиз, срок годности (ALG-06, D-17, C-016, C-023, X8) ══════════════════════════════

const tr = (version, rate_bp, valid_from, valid_to = null, recorded_at = '2026-01-01T00:00:00Z', o = {}) => ({
  tax_rule_id: 'TR', version, kind: 'percent_of_income', rate_bp, base: 'gross', applies_to: { stream_ids: ['S'] }, valid_from, valid_to,
  rounding: 'half_even', reserve_id: 'RT', recorded_at, ...o,
});
const TWO_VERSIONS = [tr(1, 2000, '2026-01-01', '2026-07-01'), tr(2, 2200, '2026-07-01', null, '2026-06-01T00:00:00Z')];

test('TST-24 D-17 ADV rule_at: valid_from включительно, valid_to исключён; до первой версии и после закрытой без преемника — null', () => {
  assert.equal(X.rule_at(TWO_VERSIONS, 'TR', '2026-06-30').version, 1);
  assert.equal(X.rule_at(TWO_VERSIONS, 'TR', '2026-07-01').version, 2);
  assert.equal(X.rule_at(TWO_VERSIONS, 'TR', '2025-12-31'), null);
  assert.equal(X.rule_at([TWO_VERSIONS[0]], 'TR', '2026-07-01'), null);
  assert.equal(X.rule_at(TWO_VERSIONS, 'OTHER', '2026-07-01'), null);
  assert.equal(X.rule_at([], 'TR', '2026-07-01'), null);
  assert.equal(X.rule_at(undefined, 'TR', '2026-07-01'), null);
});

test('TST-24 ADV rule_at: при нескольких действующих версиях побеждает наибольший recorded_at, затем version; доли секунды сравниваются корректно; known_at отбрасывает позднее записанное', () => {
  const a = tr(1, 1000, '2026-01-01', null, '2026-03-01T00:00:00Z');
  const b = tr(2, 2000, '2026-01-01', null, '2026-04-01T00:00:00Z');
  assert.equal(X.rule_at([a, b], 'TR', '2026-05-01').version, 2);
  assert.equal(X.rule_at([b, a], 'TR', '2026-05-01').version, 2, 'порядок входа не важен');
  assert.equal(X.rule_at([a, b], 'TR', '2026-05-01', '2026-03-15T00:00:00Z').version, 1, 'known_at: версия 2 ещё не была записана');
  assert.equal(X.rule_at([a, b], 'TR', '2026-05-01', '2026-02-01T00:00:00Z'), null, 'на тот момент не было ни одной версии');
  const same = tr(3, 3000, '2026-01-01', null, '2026-04-01T00:00:00Z');
  assert.equal(X.rule_at([b, same], 'TR', '2026-05-01').version, 3, 'равный recorded_at — выше version');
  const f1 = tr(1, 1000, '2026-01-01', null, '2026-04-01T00:00:00.25Z');
  const f2 = tr(2, 2000, '2026-01-01', null, '2026-04-01T00:00:00.5Z');
  assert.equal(X.rule_at([f1, f2], 'TR', '2026-05-01').version, 2, '.5 > .25 (а не лексикографическое «.5Z» < «.25Z»)');
  const g1 = tr(1, 1000, '2026-01-01', null, '2026-04-01T00:00:00Z');
  const g2 = tr(2, 2000, '2026-01-01', null, '2026-04-01T00:00:00.000001Z');
  assert.equal(X.rule_at([g1, g2], 'TR', '2026-05-01').version, 2, 'доля секунды > отсутствия доли');
});

test('TST-24 §9.12 ADV налог: версии — доход 300000 на 2026-06-30 → 60000, на 2026-07-02 → 66000; округление 123457·21 % = 25926; ничья всеми режимами', () => {
  const at = (d) => X.allocation_for_income(300000, X.rule_at(TWO_VERSIONS, 'TR', d));
  assert.equal(at('2026-06-30'), 60000);
  assert.equal(at('2026-07-02'), 66000);
  assert.equal(X.allocation_for_income(123457, { rate_bp: 2100, rounding: 'half_even' }), 25926);
  // 5 · 5000 bp = 2,5 minor: half_even → 2, half_up → 3, floor → 2, ceil → 3; 7 · 5000 = 3,5: half_even → 4
  const alloc = (inc, rounding) => X.allocation_for_income(inc, { rate_bp: 5000, rounding });
  assert.deepEqual(['half_even', 'half_up', 'floor', 'ceil'].map((m) => alloc(5, m)), [2, 3, 2, 3]);
  assert.deepEqual(['half_even', 'half_up', 'floor', 'ceil'].map((m) => alloc(7, m)), [4, 4, 3, 4]);
  assert.equal(X.allocation_for_income(0, { rate_bp: 2000, rounding: 'half_even' }), 0);
  assert.equal(X.allocation_for_income(100, { rate_bp: 0, rounding: 'ceil' }), 0);
  assert.equal(X.allocation_for_income(100, { rate_bp: 10000, rounding: 'half_even' }), 100);
  throws_code(() => X.allocation_for_income(-1, { rate_bp: 2000, rounding: 'half_even' }), 'E_SCHEMA');
});

test('TST-24 D-17 ADV allocation_range: min ≤ exp ≤ max по коридору дохода (G-001: 240000 / 279000 / 330000 при 20 % → 48000 / 55800 / 66000); без коридора — все три равны', () => {
  const rule = { rate_bp: 2000, rounding: 'half_even' };
  assert.deepEqual(X.allocation_range({ amount_minor: 279000, amount_min_minor: 240000, amount_max_minor: 330000 }, rule), { min: 48000, exp: 55800, max: 66000 });
  assert.deepEqual(X.allocation_range({ amount_minor: 279000 }, rule), { min: 55800, exp: 55800, max: 55800 });
});

test('TST-24 D-07 ADV release_on_payment: funded 150000 / платёж 50000 → released 50000, true_up 0; funded 30000 / платёж 50000 → 30000 / 20000; нули и ошибки', () => {
  assert.deepEqual(X.release_on_payment(150000, 50000), { released: 50000, true_up: 0 });
  assert.deepEqual(X.release_on_payment(30000, 50000), { released: 30000, true_up: 20000 });
  assert.deepEqual(X.release_on_payment(0, 50000), { released: 0, true_up: 50000 });
  assert.deepEqual(X.release_on_payment(50000, 50000), { released: 50000, true_up: 0 });
  assert.deepEqual(X.release_on_payment(5, 0), { released: 0, true_up: 0 });
  throws_code(() => X.release_on_payment(-1, 5), 'E_SCHEMA');
  throws_code(() => X.release_on_payment(1, -5), 'E_SCHEMA');
});

test('TST-24 C-032 ADV validate_tax_rule: пустой applies_to — E_SCHEMA, ставка > 10000, valid_to ≤ valid_from, reviewed_at без ttl, неизвестное округление — E_RULE_INVALID; корректное правило проходит', () => {
  assert.deepEqual(X.validate_tax_rule(tr(1, 2000, '2026-01-01')), { ok: true, errors: [] });
  const codes = (r) => X.validate_tax_rule(r).errors.map((e) => `${e.code}:${e.field}`);
  assert.deepEqual(codes(tr(1, 2000, '2026-01-01', null, undefined, { applies_to: { stream_ids: [], tags: [] } })), ['E_SCHEMA:applies_to']);
  assert.deepEqual(codes(tr(1, 10001, '2026-01-01')), ['E_RULE_INVALID:rate_bp']);
  assert.deepEqual(codes(tr(1, -1, '2026-01-01')), ['E_RULE_INVALID:rate_bp']);
  assert.deepEqual(codes(tr(1, 2000, '2026-01-01', '2026-01-01')), ['E_RULE_INVALID:valid_to']);
  assert.deepEqual(codes(tr(1, 2000, '2026-01-01', null, undefined, { reviewed_at: '2026-10-04' })), ['E_RULE_INVALID:reviewed_at']);
  assert.deepEqual(codes(tr(1, 2000, '2026-01-01', null, undefined, { rounding: 'banker' })), ['E_RULE_INVALID:rounding']);
  assert.deepEqual(codes(tr(1, 10000, '2026-01-01')), [], 'ставка 10000 допустима');
  assert.equal(X.validate_tax_rule(null).ok, false);
});

test('TST-24 C-032 ADV allocations_for_events: Σ ставок на одно поступление > 10000 — E_RULE_INVALID, = 10000 допустима; нулевая аллокация опускается; id tax:<правило>@<событие>', () => {
  const inc = { cash_event_id: 'i1', layer: 'planned', kind: 'income', date: AS_OF, plan_date: AS_OF, amount_minor: 1000, stream_id: 'S', tag: '' };
  const r1 = tr(1, 6000, '2026-01-01', null, undefined, { tax_rule_id: 'A', reserve_id: 'RA' });
  const r2 = tr(1, 5000, '2026-01-01', null, undefined, { tax_rule_id: 'B', reserve_id: 'RB' });
  throws_code(() => X.allocations_for_events([inc], [r1, r2], AS_OF), 'E_RULE_INVALID');
  const r3 = { ...r2, rate_bp: 4000 };
  const got = X.allocations_for_events([inc], [r1, r3], AS_OF);
  assert.deepEqual(got.map((a) => [a.allocation_id, a.reserve_id, a.amount_minor, a.rule_version]), [['tax:A@i1', 'RA', 600, 1], ['tax:B@i1', 'RB', 400, 1]]);
  const tiny = X.allocations_for_events([{ ...inc, amount_minor: 1 }], [tr(1, 2000, '2026-01-01')], AS_OF);
  assert.deepEqual(tiny, [], '1 minor × 20 % = 0,2 → 0 — строка не создаётся');
  // расход, нулевой доход, posted — не облагаются
  const not_taxed = [{ ...inc, kind: 'expense', amount_minor: -1000 }, { ...inc, amount_minor: 0 }, { ...inc, layer: 'posted' }];
  assert.deepEqual(X.allocations_for_events(not_taxed, [tr(1, 2000, '2026-01-01')], AS_OF), []);
});

test('TST-24 D-17 C-016 ADV allocations_for_events: версия выбирается по base = max(plan_date, as_of) и НЕ зависит от режима: доход plan 06-30, в worse сдвинут на 07-14 → всё равно 2000 bp', () => {
  const rules = TWO_VERSIONS;
  const inc = { cash_event_id: 'i1', layer: 'planned', kind: 'income', plan_date: P('2026-06-30'), date: P('2026-06-30'), amount_minor: 300000, stream_id: 'S' };
  const as_of = P('2026-06-20');
  const plan = X.allocations_for_events([inc], rules, as_of);
  const worse = X.allocations_for_events([{ ...inc, date: P('2026-07-14') }], rules, as_of);
  assert.equal(plan[0].amount_minor, 60000);
  assert.equal(worse[0].amount_minor, 60000, 'в worse доход попал в период 22 %, но версия по plan_date');
  assert.equal(worse[0].date, P('2026-07-14'), 'date аллокации — эффективная дата режима (попадает в reserve_close дня прихода)');
  assert.equal(plan[0].rule_version, 1);
});

test('TST-24 D-17 C-016 ADV allocations_for_events: просроченный доход (plan_date до as_of) берёт версию на as_of: план 06-30, as_of 07-05 → 22 %', () => {
  const inc = { cash_event_id: 'i1', layer: 'planned', kind: 'income', plan_date: P('2026-06-30'), date: P('2026-07-05'), amount_minor: 300000, stream_id: 'S' };
  const r = X.allocations_for_events([inc], TWO_VERSIONS, P('2026-07-05'));
  assert.deepEqual([r[0].amount_minor, r[0].rule_version], [66000, 2]);
});

test('TST-24 X8 C-023 ADV rule_age_status: reviewed 2026-10-04, ttl 120 — fresh по 2027-02-01 (age 120), stale с 02-02 по 2027-06-01 (age 240), disabled с 06-02; ttl 90 — disabled с 2027-04-03', () => {
  const rule = (ttl) => ({ reviewed_at: '2026-10-04', ttl_days: ttl });
  const st = (d, ttl = 120) => X.rule_age_status(rule(ttl), d);
  assert.deepEqual(['2026-10-04', '2027-02-01', '2027-02-02', '2027-06-01', '2027-06-02'].map((d) => st(d)), ['fresh', 'fresh', 'stale', 'stale', 'disabled']);
  assert.deepEqual(['2027-04-02', '2027-04-03'].map((d) => st(d, 90)), ['stale', 'disabled']);
  assert.equal(X.rule_age_status({}, '2030-01-01'), 'fresh', 'без reviewed_at/ttl — fresh («проверка не отмечена»)');
  assert.equal(X.rule_age_status({ reviewed_at: null, ttl_days: 5 }, '2030-01-01'), 'fresh');
  throws_code(() => X.rule_age_status(rule(120), '2026-10-03'), 'E_BAD_DATE');
});

// ═══ АНАЛИЗ G-001: налоги, резервы, гейт ════════════════════════════════════════════════════════════════════════════════

const clone = (x) => JSON.parse(JSON.stringify(x));
const G001 = load('g001.json');
const run_g = (ws, extra = {}) => analyze(ws, { as_of: ws.as_of, ...extra });
const last = (xs) => xs[xs.length - 1];

test('TST-24 C-016 ADV analyze: смена ставки между plan_date (11-05) и эффективной датой worse (11-19) — аллокации в режимах равны (55800), резерв конца ряда 167800 в обоих', () => {
  const ws = clone(G001);
  ws.tax_rules.push({ ...ws.tax_rules[0], version: 2, rate_bp: 2200, valid_from: '2026-11-10', recorded_at: '2026-10-03T00:00:00Z' });
  const a = run_g(ws);
  assert.equal(last(a.series.plan.reserve_close), 167800);
  assert.equal(last(a.series.worse.reserve_close), 167800, 'версия 22 % действует с 11-10, но выбирается по plan_date = 11-05');
  assert.deepEqual(a.series.worse.free.every((f, i) => f <= a.series.plan.free[i]), true, 'free_worse ≤ free_plan (C-016)');
});

test('TST-24 C-016 ADV analyze: версия 22 % с 2026-11-05 — в ОБОИХ режимах 61380 (279000·22 %), резерв конца ряда 150000 − 50000 + 61380 + 12000 = 173380', () => {
  const ws = clone(G001);
  ws.tax_rules.push({ ...ws.tax_rules[0], version: 2, rate_bp: 2200, valid_from: '2026-11-05', recorded_at: '2026-10-03T00:00:00Z' });
  ws.tax_rules[0].valid_to = '2026-11-05';
  const a = run_g(ws);
  assert.equal(last(a.series.plan.reserve_close), 173380);
  assert.equal(last(a.series.worse.reserve_close), 173380);
  assert.equal(last(a.series.plan.close), 340000, 'резерв не меняет физические деньги');
});

test('TST-24 C-024 ADV analyze: правило disabled — расчёт free ПРОДОЛЖАЕТСЯ (резерв учитывается), W_RULE_DISABLED, гейт Q3 и «можно потратить» отвечают insufficient_data(rule_disabled); Q1 и волны не затронуты', () => {
  const base = run_g(G001);
  const ws = clone(G001);
  ws.tax_rules[0].reviewed_at = '2026-05-01';
  ws.tax_rules[0].ttl_days = 60; // age = 156 > 120
  const a = run_g(ws);
  assert.deepEqual(a.rule_status, { 'TR-20': 'disabled' });
  assert.ok(a.warnings.some((w) => w.code === 'W_RULE_DISABLED' && w.rule_id === 'TR-20'));
  assert.deepEqual(a.series.worse.free, base.series.worse.free, 'расчёт free продолжается как раньше');
  assert.deepEqual(a.q1, base.q1);
  assert.deepEqual(W.list_waves(a, 'worse').map((x) => x.metrics), W.list_waves(base, 'worse').map((x) => x.metrics));
  const purchase = { currency: 'EUR', parts: [{ date: '2026-10-12', amount_minor: 30000 }] };
  assert.deepEqual(A.check_purchase(a, purchase), { kind: 'insufficient_data', reason: 'rule_disabled', reasons: ['rule_disabled'] });
  assert.equal(A.safe_to_spend(a, '2026-11-19').kind, 'insufficient_data');
  assert.equal(A.check_purchase(base, purchase).kind, 'ok');
  // stale (ttl 100: age 156 ≤ 200) — плашка, но не отказ
  const st = clone(G001);
  st.tax_rules[0].reviewed_at = '2026-05-01';
  st.tax_rules[0].ttl_days = 100;
  const b = run_g(st);
  assert.deepEqual(b.rule_status, { 'TR-20': 'stale' });
  assert.ok(b.warnings.some((w) => w.code === 'W_RULE_STALE'));
  assert.equal(A.check_purchase(b, purchase).kind, 'ok');
});

test('TST-29 D-07 ADV analyze: резервы не меняют close и trough; free = trough − reserve_trough (G-001 с резервами и без)', () => {
  const ws = clone(G001);
  ws.reserves = [];
  ws.tax_rules = [];
  ws.plans = ws.plans.map((p) => ({ ...p, reserve_id: undefined }));
  const bare = run_g(ws);
  const a = run_g(G001);
  for (const m of ['plan', 'worse']) {
    assert.deepEqual(a.series[m].close, bare.series[m].close, `${m}: close`);
    assert.deepEqual(a.series[m].trough, bare.series[m].trough, `${m}: trough`);
    assert.deepEqual(bare.series[m].free, bare.series[m].trough, 'без резервов free = trough');
    assert.deepEqual(a.series[m].free, a.series[m].trough.map((t, i) => t - a.series[m].reserve_trough[i]));
  }
  assert.ok(bare.warnings.some((w) => w.code === 'W_NO_RESERVES'), 'есть доход, но ни правил, ни резервов — W_NO_RESERVES');
});

test('X12 REQ-063 ADV analyze: реальный перевод 100000 на накопительный счёт при резерве 150000 снижает free с 250000 до 150000 (двойное вычитание); перевод между operating-счетами — free не меняется', () => {
  const ws = clone(G001);
  ws.accounts.push({ account_id: 'acc_sav', name: 'Копилка', kind: 'savings', liquidity: 'savings', currency: 'EUR', exponent: 2, opened_on: '2026-01-01' });
  const leg = (id, acc, amt) => ({ plan_id: id, account_id: acc, date: '2026-10-04', amount_minor: amt, currency: 'EUR', kind: 'transfer', transfer_id: 'T-SAV', tag: 'копилка' });
  ws.plans.push(leg('T-out', 'acc_main', -100000), leg('T-in', 'acc_sav', 100000));
  const a = run_g(ws);
  assert.equal(a.series.plan.trough[0], 300000);
  assert.equal(a.series.plan.reserve_trough[0], 150000);
  assert.equal(a.series.plan.free[0], 150000, 'было 250000');
  // оба operating
  const ws2 = clone(G001);
  ws2.accounts.push({ account_id: 'acc_two', name: 'Второй', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2, opened_on: '2026-01-01' });
  ws2.anchors.push({ anchor_id: 'anc2', account_id: 'acc_two', date: '2026-10-04', amount_minor: 0 });
  ws2.plans.push(leg('T-out', 'acc_main', -100000), leg('T-in', 'acc_two', 100000));
  const b = run_g(ws2);
  assert.equal(b.series.plan.free[0], 250000);
  assert.equal(b.series.plan.trough[0], 400000, 'обе ноги исключены: нетто 0');
});

test('TST-29 C-020 ADV analyze: напоминания по резервам — W_RESERVE_BEHIND (плановые взносы до as_of не записаны), записанные взносы гасят предупреждение и входят в funded_open', () => {
  const R = { reserve_id: 'R', kind: 'sinking', mode: 'refill_to_target', target_minor: 60000, due_date: '2027-03-15', funded_start_minor: 0, funded_as_of: '2026-08-15', currency: 'EUR', cadence: { freq: 'M', day: 1 } };
  const sch = (d) => ({ allocation_id: 'sch:R@' + d, reserve_id: 'R', date: d, amount_minor: 12000, source: 'schedule' });
  const warns = (allocs) => analyze(mkws({ extra: { reserves: [R], allocations: allocs } }), { as_of: '2026-10-04' }).warnings.filter((w) => w.code === 'W_RESERVE_BEHIND');
  assert.equal(warns([]).length, 1);
  assert.equal(warns([sch('2026-09-01')]).length, 1, 'октябрьский взнос 10-01 не записан');
  assert.equal(warns([sch('2026-09-01'), sch('2026-10-01')]).length, 0);
  const a = analyze(mkws({ extra: { reserves: [R], allocations: [sch('2026-09-01'), sch('2026-10-01')] } }), { as_of: '2026-10-04' });
  assert.equal(a.series.plan.reserve_opening_minor, 24000);
  // оставшиеся даты 11-01, 12-01, 01-01, 02-01, 03-01: rem 36000 / 5 = 7200
  assert.deepEqual(a.reserve.plan.by_reserve.R.contributed.filter((x) => x > 0), [7200], 'в горизонте 30 дн. — только 11-01 (7200)');
});

test('TST-29 C-059 ADV analyze: срок резерва прошёл — W_RESERVE_OVERDUE (привязанного платежа не было), W_RESERVE_RESIDUAL (платёж был, остаток остался); срок = as_of уже «прошёл»; будущий срок — без предупреждений', () => {
  const R = (due) => ({ reserve_id: 'R', kind: 'sinking', mode: 'fixed', fixed_minor: 100, due_date: due, funded_start_minor: 5000, funded_as_of: '2026-08-01', currency: 'EUR' });
  const paid = { event_id: 'f1', account_id: 'acc', date: '2026-09-20', amount_minor: -3000, currency: 'EUR', kind: 'expense', reserve_id: 'R' };
  const codes = (due, facts = []) => analyze(mkws({ extra: { reserves: [R(due)], facts } }), { as_of: '2026-10-04' }).warnings.filter((w) => /^W_RESERVE_(OVERDUE|RESIDUAL)$/.test(w.code)).map((w) => w.code);
  assert.deepEqual(codes('2026-09-30'), ['W_RESERVE_OVERDUE']);
  assert.deepEqual(codes('2026-09-30', [paid]), ['W_RESERVE_RESIDUAL']);
  assert.deepEqual(codes('2026-10-04'), ['W_RESERVE_OVERDUE'], 'due = as_of');
  assert.deepEqual(codes('2026-10-05'), []);
});

test('X3 TST-23 ADV analyze: срок резерва раньше первой даты взноса (нет дат) — анализ не падает, взносов нет, резерв постоянен', () => {
  const R = { reserve_id: 'R', kind: 'sinking', mode: 'refill_to_target', target_minor: 60000, due_date: '2026-10-20', funded_start_minor: 1000, funded_as_of: '2026-10-04', currency: 'EUR' };
  const a = analyze(mkws({ extra: { reserves: [R] } }), { as_of: '2026-10-04' });
  assert.deepEqual(new Set(a.series.plan.reserve_close), new Set([1000]));
  assert.deepEqual(a.reserve.plan.by_reserve.R.contributed.every((x) => x === 0), true);
});

test('TST-29 ADV analyze БАГ: записанная ручная аллокация больше накопленного (funded_open < 0) роняет ВЕСЬ анализ E_SCHEMA вместо «остатки не уходят ниже 0» (D-08)', () => {
  const R = { reserve_id: 'R', kind: 'sinking', mode: 'fixed', fixed_minor: 100, funded_start_minor: 0, funded_as_of: '2026-09-01', currency: 'EUR' };
  const allocs = [{ allocation_id: 'm1', reserve_id: 'R', date: '2026-09-15', amount_minor: -5000, source: 'manual' }];
  let a;
  assert.doesNotThrow(() => { a = analyze(mkws({ extra: { reserves: [R], allocations: allocs } }), { as_of: '2026-10-04' }); }, 'анализ не должен падать от записи пользователя');
  assert.ok(a.series.plan.reserve_close.every((x) => x >= 0), 'резерв не уходит ниже 0');
});

// ═══ ГЕЙТ Q3 / свежесть якоря / готовность (D-11, D-22, C-018) ═════════════════════════════════════════════════════════

test('TST-18 D-22 ADV гейт и свежесть: возраст якоря 7 → fresh, 8…21 → banner (гейт пропускает), 22 → block/stale (insufficient_data), якоря нет → block/no_anchor', () => {
  const purchase = { currency: 'EUR', parts: [{ date: day(5), amount_minor: 100 }] };
  const at = (age) => analyze(mkws({ anchor_date: day(-age), params: { buffer_minor: 1000 }, plans: ready_plans() }), { as_of: '2026-10-04' });
  assert.equal(at(7).anchor_status.level, 'fresh');
  assert.equal(at(8).anchor_status.level, 'banner');
  assert.equal(at(21).anchor_status.level, 'banner');
  assert.equal(A.gate(at(21)), null);
  assert.equal(A.check_purchase(at(21), purchase).kind, 'ok');
  const b = at(22);
  assert.deepEqual([b.anchor_status.level, b.anchor_status.reason], ['block', 'stale']);
  assert.deepEqual(A.gate(b), { kind: 'insufficient_data', reason: 'stale', reasons: ['stale'] });
  assert.equal(A.safe_to_spend(b, day(10)).kind, 'insufficient_data');
  const none = analyze(mkws({ extra: { anchors: [] }, params: { buffer_minor: 1000 }, plans: ready_plans() }), { as_of: '2026-10-04' });
  assert.deepEqual([none.anchor_status.level, none.anchor_status.reason, none.anchor_status.age], ['block', 'no_anchor', null]);
  assert.equal(A.gate(none).reason, 'no_anchor');
});

test('TST-18 C-018 ADV гейт: все причины перечисляются вместе (readiness, stale, no_buffer, rule_disabled) в порядке канона; Q1 и волны гейтом не блокируются', () => {
  const ctx = { readiness: { score: 2 }, anchor_status: { level: 'block', reason: 'stale' }, buffer_minor: null, rule_status: { A: 'fresh', B: 'disabled' }, params: {} };
  assert.deepEqual(A.gate(ctx), { kind: 'insufficient_data', reason: 'readiness', reasons: ['readiness', 'stale', 'no_buffer', 'rule_disabled'] });
  assert.equal(A.gate({ ...ctx, readiness: 3 }).reasons[0], 'readiness', 'readiness 3 < ready.q3 = 4');
  assert.equal(A.gate({ ...ctx, readiness: 4, anchor_status: { level: 'banner' }, buffer_minor: 0, rule_status: { A: 'stale' } }), null);
  throws_code(() => A.gate({ params: {} }), 'E_SCHEMA');
  // параметр ready.q3 перекрывается рабочей областью
  assert.equal(A.gate({ ...ctx, readiness: 3, anchor_status: {}, buffer_minor: 1, rule_status: {}, params: { 'ready.q3': 3 } }), null);
});

test('TST-18 D-22 ADV anchor_status: канон §9.3 — прошлые расхождения 8400/7 дн. и 15000/10 дн. → unlogged_rate 1350; age 9 → плашка, не учтено 12150', () => {
  const ws = mkws({
    as_of: '2026-09-27',
    extra: { anchors: [
      { anchor_id: 'a1', account_id: 'acc', date: '2026-09-01', amount_minor: 100000 },
      { anchor_id: 'a2', account_id: 'acc', date: '2026-09-08', amount_minor: 100000 - 8400 },
      { anchor_id: 'a3', account_id: 'acc', date: '2026-09-18', amount_minor: 100000 - 8400 - 15000 },
    ] },
  });
  const st = T.anchor_status(ws, '2026-09-27');
  assert.deepEqual([st.level, st.age, st.rate_minor, st.unaccounted_minor], ['banner', 9, 1350, 12150]);
  const os = T.opening_state(ws, '2026-09-27');
  assert.equal(os.opening_minor, 100000 - 8400 - 15000);
  assert.equal(os.drift, -15000, 'drift последнего якоря: показывается, не скрывается');
  assert.equal(os.anchor_age, 9);
});

test('TST-18 C-010 ADV opening_state: у одного из operating-счетов нет якоря — anchor_age = null (block/no_anchor), счёт в stale_accounts с age = null; свежий счёт — нет', () => {
  const ws = mkws({ extra: { accounts: [{ account_id: 'acc', kind: 'bank', liquidity: 'operating', currency: 'EUR' }, { account_id: 'acc2', kind: 'bank', liquidity: 'operating', currency: 'EUR' }] } });
  const os = T.opening_state(ws, '2026-10-04');
  assert.equal(os.anchor_age, null);
  assert.deepEqual(os.stale_accounts, [{ account_id: 'acc2', age: null }]);
  assert.equal(os.opening_minor, 100000);
  assert.equal(T.anchor_status(ws, '2026-10-04').level, 'block');
});

test('TST-18 D-01 ADV opening_state: posted с датой > as_of — E_FUTURE_POSTED; факт в день якоря в якорь уже включён, факт после якоря добавляется', () => {
  const fact = (id, d, a) => ({ event_id: id, account_id: 'acc', date: d, amount_minor: a, currency: 'EUR', kind: a < 0 ? 'expense' : 'income' });
  const mk = (facts) => mkws({ opening: 100000, as_of: '2026-10-04', anchor_date: '2026-10-01', extra: { facts } });
  assert.equal(T.opening_state(mk([fact('f0', '2026-10-01', -999)]), '2026-10-04').opening_minor, 100000, 'в день якоря — уже в якоре');
  assert.equal(T.opening_state(mk([fact('f1', '2026-10-02', -400), fact('f2', '2026-10-04', 150)]), '2026-10-04').opening_minor, 100000 - 400 + 150);
  throws_code(() => T.opening_state(mk([fact('f3', '2026-10-05', -1)]), '2026-10-04'), 'E_FUTURE_POSTED');
});

// ═══ ЧАСЫ: ставка × минуты (ALG-07, D-19, C-026…C-033) ══════════════════════════════════════════════════════════════════

const STREAM = {
  stream_id: 'S', account_id: 'acc', name: 'Работа', currency: 'EUR', rate_minor: 3000, period: 'month', cutoff: { kind: 'month_end' },
  pay_lag_days: 5, weekend: 'next', hours: { min_minutes: 4800, exp_minutes: 5760, max_minutes: 6600 },
};
const NOCAL = D.make_calendar({});

test('TST-25 D-19 ADV gross_pay: переработка 46 ч при пороге 40 ч ×1,5 = 147000; ничья 2401 мин — half_even 120062 / half_up 120063 / floor 120062 / ceil 120063; одно округление', () => {
  const ot = (mult) => ({ threshold_minutes: 2400, mult_bp: mult });
  assert.equal(H.gross_pay(3000, 2760, ot(15000)), 147000);
  const modes = ['half_even', 'half_up', 'floor', 'ceil'];
  assert.deepEqual(modes.map((m) => H.gross_pay(3000, 2401, ot(12500), m)), [120062, 120063, 120062, 120063]);
  assert.equal(H.gross_pay(3000, 5580), 279000);
  assert.equal(H.gross_pay(3000, 0), 0);
  assert.equal(H.gross_pay(0, 5580, ot(15000)), 0);
});

test('TST-25 D-19 ADV gross_pay: порог 0 — все минуты с множителем; mult_bp = 0 — переработка не оплачивается; порог больше минут — без надбавки; null и undefined переработка — линейно', () => {
  assert.equal(H.gross_pay(3000, 60, { threshold_minutes: 0, mult_bp: 20000 }), 6000);
  assert.equal(H.gross_pay(3000, 3000, { threshold_minutes: 2400, mult_bp: 0 }), 120000);
  assert.equal(H.gross_pay(3000, 100, { threshold_minutes: 2400, mult_bp: 20000 }), 5000);
  assert.equal(H.gross_pay(3000, 90, null), 4500);
  assert.equal(H.gross_pay(3000, 90, undefined), 4500);
});

test('TST-25 ADV gross_pay: отрицательные ставка/минуты/порог/множитель — E_SCHEMA; нецелые — E_NOT_INTEGER; переполнение — E_OVERFLOW; монотонность по минутам и ставке', () => {
  throws_code(() => H.gross_pay(-1, 10), 'E_SCHEMA');
  throws_code(() => H.gross_pay(3000, -1), 'E_SCHEMA');
  throws_code(() => H.gross_pay(3000, 10, { threshold_minutes: -1, mult_bp: 10000 }), 'E_SCHEMA');
  throws_code(() => H.gross_pay(3000, 10, { threshold_minutes: 1, mult_bp: -1 }), 'E_SCHEMA');
  throws_code(() => H.gross_pay(3000.5, 10), 'E_NOT_INTEGER');
  throws_code(() => H.gross_pay(3000, 1.5), 'E_NOT_INTEGER');
  throws_code(() => H.gross_pay(Number.MAX_SAFE_INTEGER, 6000), 'E_OVERFLOW');
  const rng = make_rng(11);
  for (let i = 0; i < 300; i++) {
    const rate = rng.int(0, 50000);
    const m = rng.int(0, 20000);
    const o = { threshold_minutes: rng.int(0, 10000), mult_bp: rng.int(0, 30000) };
    assert.ok(H.gross_pay(rate, m + 1, o) >= H.gross_pay(rate, m, o), 'не убывает по минутам');
    assert.ok(H.gross_pay(rate + 1, m, o) >= H.gross_pay(rate, m, o), 'не убывает по ставке');
  }
});

test('TST-25 ADV period_bounds: месяц (28/29/30/31 дн.), неделя с концом в воскресенье, двухнедельный период по якорю; соседние периоды стыкуются', () => {
  const b = (stream, d) => { const r = H.period_bounds(stream, P(d)); return [fmt(r.start), fmt(r.end)]; };
  const m = { period: 'month', cutoff: { kind: 'month_end' } };
  assert.deepEqual(b(m, '2026-10-20'), ['2026-10-01', '2026-10-31']);
  assert.deepEqual(b(m, '2028-02-10'), ['2028-02-01', '2028-02-29']);
  assert.deepEqual(b(m, '2026-02-28'), ['2026-02-01', '2026-02-28']);
  assert.deepEqual(b(m, '2026-11-30'), ['2026-11-01', '2026-11-30']);
  const w = { period: 'week', cutoff: { kind: 'weekday', weekday: 0 } };
  assert.deepEqual(b(w, '2026-10-04'), ['2026-09-28', '2026-10-04'], 'конец недели — само воскресенье');
  assert.deepEqual(b(w, '2026-10-05'), ['2026-10-05', '2026-10-11']);
  const bw = { period: 'biweek', cutoff: { kind: 'weekday', weekday: 0, anchor: '2026-10-04' } };
  assert.deepEqual(b(bw, '2026-10-04'), ['2026-09-21', '2026-10-04']);
  assert.deepEqual(b(bw, '2026-10-05'), ['2026-10-05', '2026-10-18']);
  assert.deepEqual(b(bw, '2026-10-18'), ['2026-10-05', '2026-10-18']);
  assert.deepEqual(b(bw, '2026-09-27'), ['2026-09-21', '2026-10-04'], 'до якоря чётность та же (floor_mod)');
  assert.deepEqual(b(bw, '2025-01-01'), ['2024-12-30', '2025-01-12'].map((x) => x), 'далеко в прошлом: 2025-01-12 — воскресенье, (2026-10-04 − 2025-01-12) = 630 = 45·14');
});

test('TST-25 C-026 ADV period_bounds: недопустимые пары, biweek без якоря или с якорем другого дня недели, weekday вне 0…6 — E_SCHEMA', () => {
  throws_code(() => H.period_bounds({ period: 'month', cutoff: { kind: 'weekday', weekday: 0 } }, 0), 'E_SCHEMA');
  throws_code(() => H.period_bounds({ period: 'week', cutoff: { kind: 'month_end' } }, 0), 'E_SCHEMA');
  throws_code(() => H.period_bounds({ period: 'biweek', cutoff: { kind: 'weekday', weekday: 0 } }, 0), 'E_SCHEMA');
  throws_code(() => H.period_bounds({ period: 'biweek', cutoff: { kind: 'weekday', weekday: 1, anchor: '2026-10-04' } }, 0), 'E_SCHEMA');
  throws_code(() => H.period_bounds({ period: 'week', cutoff: { kind: 'weekday', weekday: 7 } }, 0), 'E_SCHEMA');
  throws_code(() => H.period_bounds({ period: 'year', cutoff: { kind: 'month_end' } }, 0), 'E_SCHEMA');
});

test('TST-25 D-19 ADV pay_date: лаг через конец месяца и года; сдвиг next/prev/keep; праздник сдвигает next дальше; skip запрещён (E_SCHEMA); номинал — ключ occ_key', () => {
  const pd = (end, lag, weekend, cal = NOCAL) => fmt(H.pay_date(P(end), { ...STREAM, pay_lag_days: lag, weekend }, cal));
  assert.equal(pd('2026-10-31', 5, 'next'), '2026-11-05');
  assert.equal(pd('2026-11-30', 5, 'next'), '2026-12-07', '12-05 — суббота');
  assert.equal(pd('2026-11-30', 5, 'prev'), '2026-12-04');
  assert.equal(pd('2026-11-30', 5, 'keep'), '2026-12-05');
  assert.equal(pd('2026-12-31', 5, 'next'), '2027-01-05');
  assert.equal(pd('2026-10-31', 31, 'keep'), '2026-12-01');
  assert.equal(pd('2026-11-30', 5, 'next', D.make_calendar({ holidays: ['2026-12-07'] })), '2026-12-08', 'праздник в понедельник — ещё на день');
  throws_code(() => H.pay_date(P('2026-11-30'), { ...STREAM, weekend: 'skip' }, NOCAL), 'E_SCHEMA');
  // номинальная дата в occ_key, эффективная — в date
  const ev = H.expand_stream(STREAM, { from: P('2026-11-20'), to: P('2026-12-31') }, NOCAL).find((e) => e.occ_key === 'S@2026-12-05');
  assert.equal(fmt(ev.date), '2026-12-07');
});

test('TST-25 §9.2 ADV expand_stream: поток G-001 — выплата 11-05 = 279000 (коридор 240000 / 330000), occ_key S-HOURLY@2026-11-05, rule_id = null, stream_id задан; прошлые выплаты не порождаются', () => {
  const s = clone(G001.streams[0]);
  const ev = H.expand_stream(s, { from: P('2026-10-06'), to: P('2026-11-30') }, D.make_calendar(G001.calendars[0]));
  assert.equal(ev.length, 1, 'сентябрьская выплата (10-05) раньше начала окна — это прошлое (posted), не план');
  const e = ev[0];
  assert.deepEqual([e.occ_key, e.cash_event_id, fmt(e.date), e.amount_minor, e.amount_min_minor, e.amount_max_minor], ['S-HOURLY@2026-11-05', 'S-HOURLY@2026-11-05', '2026-11-05', 279000, 240000, 330000]);
  assert.deepEqual([e.rule_id, e.stream_id, e.kind, e.layer, e.status, e.is_obligation, e.is_estimate], [null, 'S-HOURLY', 'income', 'planned', 'expected', false, false]);
});

test('TST-25 C-029 ADV expand_stream: режим округления берётся из opts.rounding (B2); ничья 2401 мин при 125 % — 120062 / 120063; по умолчанию half_even', () => {
  const s = { ...STREAM, period: 'week', cutoff: { kind: 'weekday', weekday: 0 }, pay_lag_days: 0, weekend: 'keep', hours: { min_minutes: 2401, exp_minutes: 2401, max_minutes: 2401 }, overtime: { threshold_minutes: 2400, mult_bp: 12500 } };
  const amt = (opts) => H.expand_stream(s, { from: P('2026-10-04'), to: P('2026-10-11') }, NOCAL, opts).map((e) => e.amount_minor);
  assert.deepEqual(amt(undefined), [120062, 120062]);
  assert.deepEqual(amt({ rounding: 'half_up' }), [120063, 120063]);
  assert.deepEqual(amt({ rounding: 'ceil' }), [120063, 120063]);
});

test('TST-25 ADV expand_stream: недельный поток с переработкой (46 ч в неделю 10-05…10-11) — выплата 10-13 = 147000, коридор 90000…165000; остальные недели 120000', () => {
  const s = {
    ...STREAM, period: 'week', cutoff: { kind: 'weekday', weekday: 0 }, pay_lag_days: 2, weekend: 'next',
    hours: { min_minutes: 1800, exp_minutes: 2400, max_minutes: 3000 }, overtime: { threshold_minutes: 2400, mult_bp: 15000 },
    hours_by_period: { '2026-10-05': { exp_minutes: 2760 } },
  };
  const ev = H.expand_stream(s, { from: P('2026-10-04'), to: P('2026-10-31') }, NOCAL);
  assert.deepEqual(ev.map((e) => [fmt(e.date), e.amount_minor, e.amount_min_minor, e.amount_max_minor]), [
    ['2026-10-06', 120000, 90000, 165000], ['2026-10-13', 147000, 90000, 165000], ['2026-10-20', 120000, 90000, 165000], ['2026-10-27', 120000, 90000, 165000],
  ]);
});

test('TST-25 C-031 ADV expand_stream: закрытый период с фактом (window.from = as_of) схлопывается в actual: 5000 мин → 250000, min = max = 250000; без факта — exp и W_HOURS_NOT_CONFIRMED', () => {
  const win = { from: AS_OF, to: P('2026-11-30') };
  const withfact = H.expand_stream_ex({ ...STREAM, hours_by_period: { '2026-09-01': { actual_minutes: 5000 } } }, win, NOCAL);
  assert.deepEqual(withfact.events.map((e) => [e.cash_event_id, e.amount_minor, e.amount_min_minor, e.amount_max_minor]).slice(0, 1), [['S@2026-10-05', 250000, 250000, 250000]]);
  assert.deepEqual(withfact.warnings, []);
  const nofact = H.expand_stream_ex(STREAM, win, NOCAL);
  assert.equal(nofact.events[0].amount_minor, 288000);
  assert.deepEqual(nofact.warnings, [{ code: 'W_HOURS_NOT_CONFIRMED', stream_id: 'S', period_start: '2026-09-01' }]);
});

test('TST-25 C-031 ADV resolve_hours: идущий период поднимает диапазон снизу фактом «на сегодня», exp внутри [min, max]; закрытый схлопывается; actual выше max расширяет max', () => {
  const b = { start: P('2026-10-01'), end: P('2026-10-31') };
  const s = { ...STREAM, hours: { min_minutes: 4800, exp_minutes: 5580, max_minutes: 6600 }, hours_by_period: { '2026-10-01': { actual_minutes: 6000 } } };
  assert.deepEqual(H.resolve_hours(s, b, P('2026-10-20')), { min: 6000, exp: 6000, max: 6600, actual: 6000, closed: false });
  assert.deepEqual(H.resolve_hours(s, b, P('2026-11-01')), { min: 6000, exp: 6000, max: 6000, actual: 6000, closed: true });
  const over = { ...s, hours_by_period: { '2026-10-01': { actual_minutes: 7000 } } };
  assert.deepEqual(H.resolve_hours(over, b, P('2026-10-20')), { min: 7000, exp: 7000, max: 7000, actual: 7000, closed: false });
  const none = { ...STREAM, hours: { min_minutes: 4800, exp_minutes: 5580, max_minutes: 6600 } };
  assert.deepEqual(H.resolve_hours(none, b, P('2026-10-20')), { min: 4800, exp: 5580, max: 6600, actual: null, closed: false });
  assert.equal(H.resolve_hours(none, b, P('2026-10-31')).closed, false, 'закрыт, когда end < as_of: в последний день ещё идёт');
  assert.equal(H.resolve_hours(none, b, P('2026-11-01')).closed, true);
  assert.equal(H.planned_exp({ ...none, hours_by_period: { '2026-10-01': { exp_minutes: 1 } } }, b), 1);
});

test('TST-25 ADV expand_stream: нулевые часы — события нет; бонус — в введённую дату без лага и сдвига выходных; бонус вне окна не входит; ключ hours_by_period не на начале периода — W_HOURS_KEY_IGNORED', () => {
  const zero = { ...STREAM, hours: { min_minutes: 0, exp_minutes: 0, max_minutes: 100 } };
  assert.deepEqual(H.expand_stream(zero, { from: AS_OF, to: P('2026-12-31') }, NOCAL), []);
  const bon = { ...STREAM, hours: { min_minutes: 0, exp_minutes: 0, max_minutes: 0 }, bonus: [{ date: '2026-10-10', amount_minor: 5000 }, { date: '2027-05-01', amount_minor: 7000 }, { date: '2026-10-03', amount_minor: 9000 }] };
  const r = H.expand_stream(bon, { from: AS_OF, to: P('2026-12-31') }, NOCAL);
  assert.deepEqual(r.map((e) => [e.cash_event_id, fmt(e.date), e.amount_minor]), [['S@bonus@2026-10-10', '2026-10-10', 5000]], '10-10 — суббота, но дата бонуса как введена');
  const ex = H.expand_stream_ex({ ...STREAM, hours_by_period: { '2026-10-15': { min_minutes: 0, exp_minutes: 100, max_minutes: 200 } } }, { from: AS_OF, to: P('2026-10-31') }, NOCAL);
  assert.ok(ex.warnings.some((w) => w.code === 'W_HOURS_KEY_IGNORED' && w.key === '2026-10-15'));
});

test('TST-25 C-032 ADV validate_stream: weekend skip, biweek без якоря / якорь другого дня недели, min > exp, бонус 0, отрицательные ставка и лаг, нарушение min ≤ exp ≤ max в hours_by_period, отрицательная переработка — ошибки; корректный поток проходит', () => {
  assert.deepEqual(H.validate_stream(STREAM), { ok: true, errors: [] });
  const f = (patch) => H.validate_stream({ ...STREAM, ...patch }).errors.map((e) => e.field);
  assert.deepEqual(f({ weekend: 'skip' }), ['weekend']);
  assert.ok(f({ period: 'biweek', cutoff: { kind: 'weekday', weekday: 0 } }).includes('cutoff.anchor'));
  assert.ok(f({ period: 'biweek', cutoff: { kind: 'weekday', weekday: 1, anchor: '2026-10-04' } }).includes('cutoff.anchor'));
  assert.ok(f({ hours: { min_minutes: 100, exp_minutes: 50, max_minutes: 200 } }).includes('hours'));
  assert.ok(f({ bonus: [{ date: '2026-10-10', amount_minor: 0 }] }).includes('bonus[0].amount_minor'));
  assert.ok(f({ rate_minor: -1 }).includes('rate_minor'));
  assert.ok(f({ pay_lag_days: -1 }).includes('pay_lag_days'));
  assert.ok(f({ hours_by_period: { '2026-10-01': { exp_minutes: 9999 } } }).includes('hours_by_period.2026-10-01'));
  assert.ok(f({ overtime: { threshold_minutes: -1, mult_bp: 15000 } }).includes('overtime.threshold_minutes'));
  assert.ok(f({ delay_days_worse: -1 }).includes('delay_days_worse'));
  assert.equal(H.validate_stream(null).ok, false);
  throws_code(() => H.expand_stream({ ...STREAM, weekend: 'skip' }, { from: 0, to: 100 }, NOCAL), 'E_SCHEMA');
});

test('TST-25 §9.2 ADV shortfall/plan_to_date: на 2026-10-20 темп 180 мин/дн → план 3600, факт 3120, недоработка 480 мин, эффект 24000, оценка 5100 мин → 255000', () => {
  const s = { ...STREAM, hours: { min_minutes: 4800, exp_minutes: 5580, max_minutes: 6600 }, pace_minutes_per_day: 180 };
  const period = H.period_bounds(s, P('2026-10-20'));
  assert.equal(H.plan_to_date(s, period, P('2026-10-20')), 3600);
  const r = H.shortfall(s, period, P('2026-10-20'), 3120);
  assert.deepEqual(r, { short_minutes: 480, effect_minor: 24000, est_minutes: 5100, est_gross_minor: 255000 });
  assert.equal(r.est_gross_minor, 279000 - r.effect_minor, 'оценка = план − эффект');
  // без темпа: exp/дни периода → 5580·20/31 = 3600 точно
  const nopace = { ...s, pace_minutes_per_day: null };
  assert.equal(H.plan_to_date(nopace, period, P('2026-10-20')), 3600);
  assert.deepEqual(H.shortfall(nopace, period, P('2026-10-20'), 3120), r);
});

test('TST-25 C-033 ADV shortfall: опережение даёт short < 0 и отрицательный эффект; факт = план → short 0 и est = exp; as_of до начала — план 0; после конца — exp; переработка в оценке', () => {
  const s = { ...STREAM, hours: { min_minutes: 4800, exp_minutes: 5580, max_minutes: 6600 }, pace_minutes_per_day: null };
  const period = H.period_bounds(s, P('2026-10-20'));
  const ahead = H.shortfall(s, period, P('2026-10-20'), 4000);
  assert.deepEqual([ahead.short_minutes, ahead.effect_minor, ahead.est_minutes], [-400, -20000, 4000 + (5580 - 3600)]);
  const even = H.shortfall(s, period, P('2026-10-20'), 3600);
  assert.deepEqual([even.short_minutes, even.est_minutes], [0, 5580]);
  assert.equal(H.plan_to_date(s, period, P('2026-09-20')), 0);
  assert.equal(H.plan_to_date(s, period, P('2026-12-20')), 5580);
  assert.equal(H.plan_to_date(s, period, P('2026-10-01')), M.mul_div(5580, 1, 31, 'half_even'), 'as_of входит в «прошло»: 1 день');
  const ot = { ...s, overtime: { threshold_minutes: 5000, mult_bp: 15000 } };
  assert.equal(H.shortfall(ot, period, P('2026-10-20'), 5400).est_gross_minor, H.gross_pay(3000, 5400 + Math.max(0, 5580 - 3600), ot.overtime), 'оценка с переработкой');
  throws_code(() => H.shortfall(s, period, P('2026-10-20'), -1), 'E_SCHEMA');
});

test('TST-25 ALG-07 инв. 7 (закрыто FP-02, Q-19): при закрытом периоде plan_to_date = exp даже при заданном темпе pace_minutes_per_day (200·31 = 6200 → 5580); открытый период — min(pace·elapsed, exp)', () => {
  const s = { ...STREAM, hours: { min_minutes: 4800, exp_minutes: 5580, max_minutes: 6600 }, pace_minutes_per_day: 200 };
  const period = H.period_bounds(s, P('2026-10-20'));
  assert.equal(H.plan_to_date(s, period, P('2026-12-20')), 5580);
});

test('TST-25 D-04 ADV analyze: поток часов в worse — та же сумма, дата на 14 дней позже (11-05 → 11-19); delay_days_worse потока перекрывает параметр; 0 — без сдвига', () => {
  const a = run_g(G001);
  const inc = (m) => a.events[m].find((e) => e.stream_id === 'S-HOURLY');
  assert.deepEqual([fmt(inc('plan').date), fmt(inc('worse').date)], ['2026-11-05', '2026-11-19']);
  assert.equal(inc('plan').amount_minor, inc('worse').amount_minor);
  const ws = clone(G001);
  ws.streams[0].delay_days_worse = 3;
  assert.equal(fmt(run_g(ws).events.worse.find((e) => e.stream_id === 'S-HOURLY').date), '2026-11-08');
  ws.streams[0].delay_days_worse = 0;
  assert.equal(fmt(run_g(ws).events.worse.find((e) => e.stream_id === 'S-HOURLY').date), '2026-11-05');
});

test('TST-25 C-004 ADV БАГ build_events: закрытый период с фактом часов при якоре СТАРШЕ as_of — actual_minutes игнорируется (период «закрыт» считается от window.from = даты якоря, а не от as_of)', () => {
  // якорь 09-20, as_of 10-04; сентябрь закрыт (30.09 < 04.10), факт 5000 мин; выплата 10-05
  const s = { ...STREAM, hours_by_period: { '2026-09-01': { actual_minutes: 5000 } } };
  const ws = mkws({ opening: 100000, anchor_date: '2026-09-20', extra: { streams: [s] }, params: { horizon_days: 30 } });
  const bx = T.build_events_ex(ws, { as_of: '2026-10-04', horizon_days: 30, mode: 'plan' });
  const e = bx.events.find((x) => x.occ_key === 'S@2026-10-05');
  assert.equal(e.amount_minor, 250000, 'gross(5000 мин) = 3000·5000/60; получено gross(exp = 5760) = 288000');
  assert.deepEqual([e.amount_min_minor, e.amount_max_minor], [250000, 250000]);
});

test('TST-25 C-031 ADV БАГ build_events: W_HOURS_NOT_CONFIRMED не выдаётся, если якорь старше as_of (тот же корень: «закрыт» считается от даты якоря)', () => {
  const ws = mkws({ opening: 100000, anchor_date: '2026-09-20', extra: { streams: [STREAM] }, params: { horizon_days: 30 } });
  const bx = T.build_events_ex(ws, { as_of: '2026-10-04', horizon_days: 30, mode: 'plan' });
  assert.deepEqual(bx.warnings.filter((w) => w.code === 'W_HOURS_NOT_CONFIRMED'), [{ code: 'W_HOURS_NOT_CONFIRMED', stream_id: 'S', period_start: '2026-09-01' }]);
  // контроль: якорь = as_of — предупреждение есть
  const ws2 = mkws({ opening: 100000, extra: { streams: [STREAM] }, params: { horizon_days: 30 } });
  assert.equal(T.build_events_ex(ws2, { as_of: '2026-10-04', horizon_days: 30, mode: 'plan' }).warnings.filter((w) => w.code === 'W_HOURS_NOT_CONFIRMED').length, 1);
});

// ═══ ВАЛЮТЫ: курс, перевод, крипта (ALG-08, D-20, X4, X11, C-034…C-038) ════════════════════════════════════════════════

const rate = (base, quote, num, den, date = '2026-10-01', o = {}) => ({ base, quote, num, den, date, ...o });
const SPOT = (shock = {}, as_of = AS_OF) => ({ kind: 'spot', as_of, shock, rounding: 'half_even' });

test('TST-27 §9.12 ADV convert_minor: spot 0,9250 → 185000; BTC 150000 sat × 50000 €/BTC → 7500; JPY (exp 0) → EUR при 1/160 → 6250; одно округление', () => {
  assert.equal(F.convert_minor(200000, 2, 2, 9250, 10000), 185000);
  assert.equal(F.convert_minor(150000, 8, 2, 50000, 1), 7500);
  assert.equal(F.convert_minor(10000, 0, 2, 1, 160), 6250);
  assert.equal(F.convert_minor(0, 2, 2, 9250, 10000), 0);
  assert.equal(F.convert_minor(-200000, 2, 2, 9250, 10000), -185000, 'симметрия знака');
});

test('TST-27 ADV convert_minor: ничья 0,5 minor симметрична по знаку (half_even: 2 и −2; half_up: 3 и −3; floor: 2 и −3; ceil: 3 и −2); ошибки — E_SCHEMA/E_NOT_INTEGER/E_OVERFLOW', () => {
  const c = (a, mode) => F.convert_minor(a, 2, 2, 1, 2, mode);
  assert.deepEqual(['half_even', 'half_up', 'floor', 'ceil'].map((m) => c(5, m)), [2, 3, 2, 3]);
  assert.deepEqual(['half_even', 'half_up', 'floor', 'ceil'].map((m) => c(-5, m)), [-2, -3, -3, -2]);
  throws_code(() => F.convert_minor(1, 2, 2, 0, 1), 'E_SCHEMA');
  throws_code(() => F.convert_minor(1, 2, 2, 1, 0), 'E_SCHEMA');
  throws_code(() => F.convert_minor(1, -1, 2, 1, 1), 'E_SCHEMA');
  throws_code(() => F.convert_minor(1.5, 2, 2, 1, 1), 'E_NOT_INTEGER');
  throws_code(() => F.convert_minor(Number.MAX_SAFE_INTEGER, 0, 2, 100, 1), 'E_OVERFLOW');
});

test('TST-28 §9.12 ADV apply_shock: −5 % к 9250/10000 → 703/800 → 175750 (−92,50 €); +0 bp — та же стоимость; bp ≤ −10000 и нецелое — E_SCHEMA; монотонность по bp', () => {
  const s = F.apply_shock({ num: 9250, den: 10000, date: 5 }, -500);
  assert.deepEqual(s, { num: 703, den: 800, date: 5 });
  assert.equal(F.convert_minor(200000, 2, 2, s.num, s.den), 175750);
  const z = F.apply_shock({ num: 9250, den: 10000 }, 0);
  assert.deepEqual([z.num, z.den], [37, 40], 'несократимая дробь той же величины');
  assert.equal(F.convert_minor(200000, 2, 2, z.num, z.den), 185000);
  throws_code(() => F.apply_shock({ num: 1, den: 1 }, -10000), 'E_SCHEMA');
  throws_code(() => F.apply_shock({ num: 1, den: 1 }, -10001), 'E_SCHEMA');
  throws_code(() => F.apply_shock({ num: 1, den: 1 }, 1.5), 'E_SCHEMA');
  let prev = 0;
  for (const bp of [-9999, -5000, -500, 0, 500, 10000, 50000]) {
    const r = F.apply_shock({ num: 9250, den: 10000 }, bp);
    const v = F.convert_minor(1000000, 2, 2, r.num, r.den);
    assert.ok(v >= prev, `bp ${bp}`);
    prev = v;
  }
});

test('TST-27 ADV implied_rate: 2000,00 $ → 1842,40 € = 2303/2500 (0,9212, несократимая); разные экспоненты — учитываются; нога ≤ 0 — E_SCHEMA', () => {
  assert.deepEqual(F.implied_rate(200000, 184240, 2, 2), { num: 2303, den: 2500 });
  // 2000,00 $ → 12345 ¥ (exp 0): 6,1725 ¥/$ = 2469/400
  assert.deepEqual(F.implied_rate(200000, 12345, 2, 0), { num: 2469, den: 400 });
  throws_code(() => F.implied_rate(0, 5, 2, 2), 'E_SCHEMA');
  throws_code(() => F.implied_rate(5, 0, 2, 2), 'E_SCHEMA');
  throws_code(() => F.implied_rate(5, -5, 2, 2), 'E_SCHEMA');
});

test('TST-27 C-036 ADV rate_at: последний курс ≤ даты; будущий игнорируется; обратная пара переворачивается; при равной дате прямой приоритетнее, новее — выигрывает; триангуляции нет; base = quote → 1/1', () => {
  const R = [rate('USD', 'EUR', 9000, 10000, '2026-09-01'), rate('USD', 'EUR', 9250, 10000, '2026-10-01'), rate('USD', 'EUR', 9999, 10000, '2026-10-05')];
  assert.deepEqual(F.rate_at(R, 'USD', 'EUR', AS_OF), { num: 9250, den: 10000, date: P('2026-10-01'), inverse: false });
  assert.equal(F.rate_at([rate('USD', 'EUR', 1, 1, '2026-10-05')], 'USD', 'EUR', AS_OF), null);
  assert.deepEqual(F.rate_at([rate('EUR', 'USD', 10000, 9250)], 'USD', 'EUR', AS_OF), { num: 9250, den: 10000, date: P('2026-10-01'), inverse: true });
  const tie = [rate('EUR', 'USD', 10000, 9000, '2026-10-01'), rate('USD', 'EUR', 9250, 10000, '2026-10-01')];
  assert.equal(F.rate_at(tie, 'USD', 'EUR', AS_OF).inverse, false, 'равная дата — прямой');
  const inv_newer = [rate('EUR', 'USD', 10000, 9000, '2026-10-02'), rate('USD', 'EUR', 9250, 10000, '2026-10-01')];
  assert.equal(F.rate_at(inv_newer, 'USD', 'EUR', AS_OF).inverse, true, 'обратная новее — берётся она');
  assert.equal(F.rate_at([rate('USD', 'EUR', 1, 1), rate('EUR', 'RUB', 100, 1)], 'USD', 'RUB', AS_OF), null, 'без триангуляции');
  assert.deepEqual(F.rate_at([], 'USD', 'USD', AS_OF), { num: 1, den: 1, date: AS_OF, inverse: false });
  assert.equal(F.rate_at(undefined, 'USD', 'EUR', AS_OF), null);
  assert.deepEqual(F.rate_at(R, 'USD', 'EUR', P('2026-10-05')).num, 9999, 'курс на саму дату as_of включается');
  throws_code(() => F.rate_at([rate('USD', 'EUR', 0, 1)], 'USD', 'EUR', AS_OF), 'E_SCHEMA');
});

test('TST-27 D-20 ADV to_decision: валюта решения без курса; нет пары — E_NO_RATE; сценарий −500 bp → 175750; шок другой валюты не действует', () => {
  const ctx = (shock) => ({ rates: [rate('USD', 'EUR', 9250, 10000)], decision_currency: 'EUR', policy: SPOT(shock) });
  assert.deepEqual(F.to_decision(12345, 'EUR', AS_OF, ctx({})), { amount_minor: 12345, rate: null });
  assert.equal(F.to_decision(200000, 'USD', AS_OF, ctx({})).amount_minor, 185000);
  assert.equal(F.to_decision(200000, 'USD', AS_OF, ctx({ USD: -500 })).amount_minor, 175750);
  assert.equal(F.to_decision(200000, 'USD', AS_OF, ctx({ GBP: -500 })).amount_minor, 185000);
  throws_code(() => F.to_decision(1, 'GBP', AS_OF, ctx({})), 'E_NO_RATE');
  assert.equal(F.to_decision(200000, 'USD', AS_OF, { ...ctx({}), policy: 'spot' }).amount_minor, 185000, 'строка spot нормализуется');
  throws_code(() => F.to_decision(1, 'USD', AS_OF, { ...ctx({}), policy: 'adverse' }), 'E_SCHEMA');
});

test('TST-27 D-20 ADV to_decision_events: одно округление НА СОБЫТИЕ (два расхода по −5 $ при 0,9250 → по −5 €, сумма −10, а не −9); служебные поля; коридор переводится тем же курсом', () => {
  const accounts = [{ account_id: 'u', currency: 'USD', liquidity: 'operating' }];
  const e = (id, amt, extra = {}) => ({ cash_event_id: id, account_id: 'u', currency: 'USD', date: 100, amount_minor: amt, kind: 'expense', ...extra });
  const out = F.to_decision_events([e('a', -5), e('b', -5)], accounts, [rate('USD', 'EUR', 9250, 10000)], 'EUR', 'spot', AS_OF);
  assert.deepEqual(out.map((x) => x.amount_minor), [-5, -5]);
  assert.equal(out[0].currency, 'EUR');
  assert.deepEqual([out[0].orig_amount_minor, out[0].orig_currency, out[0].rate_used.num, out[0].rate_used.den], [-5, 'USD', 9250, 10000]);
  const corridor = F.to_decision_events([{ ...e('c', 200000, { kind: 'income' }), amount_min_minor: 100000, amount_max_minor: 300000 }], accounts, [rate('USD', 'EUR', 9250, 10000)], 'EUR', 'spot', AS_OF)[0];
  assert.deepEqual([corridor.amount_minor, corridor.amount_min_minor, corridor.amount_max_minor], [185000, 92500, 277500]);
});

test('TST-27 D-20 ADV to_decision_events: справочные счета не входят; обе ноги обмена между operating исключены; нога в неоперационный остаётся расходом; валюта события ≠ валюте счёта — E_CURRENCY_MISMATCH; неизвестный счёт — E_SCHEMA', () => {
  const accounts = [
    { account_id: 'eur', currency: 'EUR', liquidity: 'operating' }, { account_id: 'usd', currency: 'USD', liquidity: 'operating' },
    { account_id: 'sav', currency: 'EUR', liquidity: 'savings' },
  ];
  const rates = [rate('USD', 'EUR', 9250, 10000)];
  const leg = (id, acc, cur, amt, tid) => ({ cash_event_id: id, account_id: acc, currency: cur, date: 100, amount_minor: amt, kind: 'transfer', transfer_id: tid });
  const run = (evs) => F.to_decision_events(evs, accounts, rates, 'EUR', 'spot', AS_OF).map((x) => [x.cash_event_id, x.amount_minor]);
  assert.deepEqual(run([leg('a', 'eur', 'EUR', -50000, 'T'), leg('b', 'usd', 'USD', 54000, 'T')]), [], 'обмен между своими operating — нетто 0');
  assert.deepEqual(run([leg('a', 'eur', 'EUR', -50000, 'T'), leg('b', 'sav', 'EUR', 50000, 'T')]), [['a', -50000]], 'на накопительный — расход');
  assert.deepEqual(run([{ ...leg('s', 'sav', 'EUR', -10, 'X'), transfer_id: undefined }]), [], 'справочный счёт не входит');
  throws_code(() => run([leg('a', 'eur', 'USD', -1, 'T')]), 'E_CURRENCY_MISMATCH');
  throws_code(() => run([{ ...leg('a', 'nope', 'EUR', -1, 'T') }]), 'E_SCHEMA');
});

test('TST-27 D-20 ADV exchange_difference: продано 2000,00 $ (spot 0,9250 → 1850,00 €), получено 1842,40 € → разница +760 (получено меньше spot); получено больше — отрицательная', () => {
  assert.equal(F.exchange_difference(200000, 184240, 2, 2, { num: 9250, den: 10000 }), 760);
  assert.equal(F.exchange_difference(200000, 186000, 2, 2, { num: 9250, den: 10000 }), -1000);
  assert.equal(F.exchange_difference(200000, 185000, 2, 2, { num: 9250, den: 10000 }), 0);
});

test('TST-27 D-20 ADV liquid_value: savings — 100 %; asset — liquidity_bp; крипта по умолчанию 0 даже на накопительном; крипта 50 % от 75,00 € = 37,50 €; крипта на operating и bp > 10000 — E_SCHEMA; operating-счёт — 0', () => {
  const rates = [rate('BTC', 'EUR', 50000, 1), rate('USD', 'EUR', 9250, 10000)];
  const ctx = { decision_currency: 'EUR', policy: SPOT() };
  assert.equal(F.liquid_value({ kind: 'bank', liquidity: 'savings', currency: 'USD' }, 200000, rates, ctx), 185000);
  assert.equal(F.liquid_value({ kind: 'asset', liquidity: 'asset', currency: 'USD', liquidity_bp: 5000 }, 200000, rates, ctx), 92500);
  assert.equal(F.liquid_value({ kind: 'asset', liquidity: 'asset', currency: 'USD' }, 200000, rates, ctx), 0);
  assert.equal(F.liquid_value({ kind: 'crypto', liquidity: 'savings', currency: 'BTC', exponent: 8 }, 150000, rates, ctx), 0, 'D-20: у крипты только liquidity_bp (по умолчанию 0)');
  assert.equal(F.liquid_value({ kind: 'crypto', liquidity: 'asset', currency: 'BTC', exponent: 8, liquidity_bp: 5000 }, 150000, rates, ctx), 3750);
  assert.equal(F.liquid_value({ kind: 'crypto', liquidity: 'asset', currency: 'BTC', exponent: 8, liquidity_bp: 10000 }, 150000, rates, ctx), 7500);
  assert.equal(F.liquid_value({ kind: 'bank', liquidity: 'operating', currency: 'USD' }, 200000, rates, ctx), 0);
  throws_code(() => F.liquid_value({ kind: 'crypto', liquidity: 'operating', currency: 'BTC' }, 1, rates, ctx), 'E_SCHEMA');
  throws_code(() => F.liquid_value({ kind: 'asset', liquidity: 'asset', currency: 'USD', liquidity_bp: 10001 }, 1, rates, ctx), 'E_SCHEMA');
  throws_code(() => F.liquid_value({ kind: 'asset', liquidity: 'asset', currency: 'GBP', liquidity_bp: 100 }, 1, rates, ctx), 'E_NO_RATE');
  // сценарий курса действует и на запас
  assert.equal(F.liquid_value({ kind: 'bank', liquidity: 'savings', currency: 'USD' }, 200000, rates, { ...ctx, policy: SPOT({ USD: -500 }) }), 175750);
});

test('TST-27 X11 ADV rate_status: возраст в днях, «устарел» строго старше stale_days (по умолчанию 30)', () => {
  assert.deepEqual(F.rate_status({ date: '2026-09-04' }, '2026-10-04'), { age: 30, stale: false });
  assert.deepEqual(F.rate_status({ date: '2026-09-03' }, '2026-10-04'), { age: 31, stale: true });
  assert.deepEqual(F.rate_status({ date: '2026-09-03' }, '2026-10-04', 45), { age: 31, stale: false });
  assert.deepEqual(F.rate_status({ date: '2026-10-04' }, '2026-10-04'), { age: 0, stale: false });
});

// ── мультивалютный анализ ─────────────────────────────────────────────────────────────────────────────────────────────

function mkfx(o = {}) {
  return {
    decision_currency: 'EUR',
    params: { horizon_days: 30, buffer_minor: 10000, ...(o.params ?? {}) },
    accounts: [
      { account_id: 'acc', kind: 'bank', liquidity: 'operating', currency: 'EUR' },
      { account_id: 'usd', kind: 'bank', liquidity: 'operating', currency: 'USD' },
      { account_id: 'sav', kind: 'bank', liquidity: 'savings', currency: 'EUR' },
      ...(o.accounts ?? []),
    ],
    anchors: [
      { anchor_id: 'a1', account_id: 'acc', date: o.anchor_date ?? '2026-10-04', amount_minor: 100000 },
      { anchor_id: 'a2', account_id: 'usd', date: o.anchor_date ?? '2026-10-04', amount_minor: 200000 },
      ...(o.anchors ?? []),
    ],
    rates: o.rates ?? [rate('USD', 'EUR', 9250, 10000)],
    plans: (o.plans ?? []).map((p, i) => ({ plan_id: p.id ?? 'p' + i, kind: p.amount_minor > 0 ? 'income' : 'expense', ...p })),
  };
}

test('TST-27 D-20 ADV analyze мультивалютный: opening = 100000 + 200000·0,9250 = 285000; USD-расход −5 $ дважды → −10 €; обратная пара даёт то же; курс «из будущего» — E_NO_RATE', () => {
  const plans = [{ id: 'u1', account_id: 'usd', currency: 'USD', date: day(3), amount_minor: -5 }, { id: 'u2', account_id: 'usd', currency: 'USD', date: day(3), amount_minor: -5 }];
  const a = analyze(mkfx({ plans }), { as_of: '2026-10-04' });
  assert.equal(a.series.plan.opening_minor, 285000);
  assert.equal(a.series.plan.trough[3], 285000 - 10, 'trough дня трат учитывает оба расхода по −5 (расходы раньше доходов)');
  assert.equal(a.series.plan.close[3], 285000 - 10);
  const inv = analyze(mkfx({ plans, rates: [rate('EUR', 'USD', 10000, 9250)] }), { as_of: '2026-10-04' });
  assert.deepEqual(inv.series.plan.close, a.series.plan.close);
  throws_code(() => analyze(mkfx({ plans, rates: [rate('USD', 'EUR', 9250, 10000, '2026-10-05')] }), { as_of: '2026-10-04' }), 'E_NO_RATE');
  throws_code(() => analyze(mkfx({ rates: [] }), { as_of: '2026-10-04' }), 'E_NO_RATE');
  assert.equal(analyze(mkfx({ rates: [rate('USD', 'EUR', 9250, 10000, '2026-10-04')] }), { as_of: '2026-10-04' }).series.plan.opening_minor, 285000, 'курс на день as_of — spot');
});

test('TST-27 D-20 ADV analyze: курс устарел (100 дн.) — расчёт идёт (плашка, не блок), числа те же', () => {
  const fresh = analyze(mkfx(), { as_of: '2026-10-04' });
  const stale = analyze(mkfx({ rates: [rate('USD', 'EUR', 9250, 10000, '2026-06-26')] }), { as_of: '2026-10-04' });
  assert.deepEqual(stale.series.plan.close, fresh.series.plan.close);
});

test('TST-27 X11 REQ-079 ADV analyze БАГ: курс старше fx.stale_days (30) — canon требует предупреждение W_RATE_STALE; движок его не выдаёт (rate_status нигде не вызывается)', () => {
  const stale = analyze(mkfx({ rates: [rate('USD', 'EUR', 9250, 10000, '2026-08-01')] }), { as_of: '2026-10-04' });
  assert.ok(stale.warnings.some((w) => w.code === 'W_RATE_STALE'), 'курс USD→EUR 64 дня: ожидается W_RATE_STALE; получено: ' + JSON.stringify(stale.warnings));
  const fresh = analyze(mkfx({ rates: [rate('USD', 'EUR', 9250, 10000, '2026-09-30')] }), { as_of: '2026-10-04' });
  assert.equal(fresh.warnings.some((w) => w.code === 'W_RATE_STALE'), false, 'контроль: 4 дня — без предупреждения');
});

test('TST-27 D-20 ADV analyze: перевод между operating-счетами в разных валютах исключён, на накопительный — расход (X12); справочные счета (savings, asset) в opening не входят', () => {
  const leg = (id, acc, cur, amt, tid) => ({ id, account_id: acc, currency: cur, date: day(5), amount_minor: amt, kind: 'transfer', transfer_id: tid });
  const swap = analyze(mkfx({ plans: [leg('t1', 'acc', 'EUR', -50000, 'T'), leg('t2', 'usd', 'USD', 54000, 'T')] }), { as_of: '2026-10-04' });
  assert.deepEqual(swap.events.plan, [], 'обмен: обе ноги исключены');
  const sav = analyze(mkfx({ plans: [leg('t1', 'acc', 'EUR', -50000, 'T'), leg('t2', 'sav', 'EUR', 50000, 'T')], anchors: [{ anchor_id: 'a3', account_id: 'sav', date: '2026-10-04', amount_minor: 999999 }] }), { as_of: '2026-10-04' });
  assert.deepEqual(sav.events.plan.map((e) => [e.cash_event_id, e.amount_minor]), [['t1', -50000]]);
  assert.equal(sav.series.plan.opening_minor, 285000, 'остаток накопительного счёта в opening не входит');
});

test('TST-27 D-20 ADV analyze БАГ: счёт kind = crypto с liquidity = operating молча входит в opening (+75,00 €); канон: «крипта в operating не входит» / E_SCHEMA (ALG-08)', () => {
  const ws = mkfx({ accounts: [{ account_id: 'btc', kind: 'crypto', liquidity: 'operating', currency: 'BTC', exponent: 8 }], anchors: [{ anchor_id: 'a3', account_id: 'btc', date: '2026-10-04', amount_minor: 150000 }], rates: [rate('USD', 'EUR', 9250, 10000), rate('BTC', 'EUR', 50000, 1)] });
  let opening = null;
  try { opening = analyze(ws, { as_of: '2026-10-04' }).series.plan.opening_minor; } catch (e) { assert.equal(e.code, 'E_SCHEMA', 'допустим отказ E_SCHEMA'); return; }
  assert.equal(opening, 285000, 'крипта не должна попадать в operating-остаток (получено ' + opening + ')');
});

test('TST-27 D-20 ADV analyze: крипта на неоперационном счёте (asset, liquidity_bp = 0 по умолчанию) в opening не входит и курса не требует', () => {
  const ws = mkfx({ accounts: [{ account_id: 'btc', kind: 'crypto', liquidity: 'asset', currency: 'BTC', exponent: 8 }], anchors: [{ anchor_id: 'a3', account_id: 'btc', date: '2026-10-04', amount_minor: 150000 }] });
  assert.equal(analyze(ws, { as_of: '2026-10-04' }).series.plan.opening_minor, 285000);
});

test('TST-27 D-14 ADV analyze: сценарий fx_shock{USD, −500 bp} меняет USD-события (−200000 $: −185000 → −175750 €), EUR-события — нет; bp ≤ −10000 — E_SCHEMA', () => {
  const plans = [{ id: 'u1', account_id: 'usd', currency: 'USD', date: day(3), amount_minor: -200000 }, { id: 'e1', account_id: 'acc', currency: 'EUR', date: day(3), amount_minor: -1000 }];
  const base = analyze(mkfx({ plans }), { as_of: '2026-10-04' });
  assert.deepEqual(base.events.plan.map((e) => e.amount_minor).sort((a, b) => a - b), [-185000, -1000]);
  const shock = analyze(mkfx({ plans }), { as_of: '2026-10-04', scenario: { scenario_id: 'sc', ops: [{ op: 'fx_shock', currency: 'USD', bp: -500 }] } });
  assert.deepEqual(shock.events.plan.map((e) => e.amount_minor).sort((a, b) => a - b), [-175750, -1000]);
  throws_code(() => analyze(mkfx({ plans }), { as_of: '2026-10-04', scenario: { ops: [{ op: 'fx_shock', currency: 'USD', bp: -10000 }] } }), 'E_SCHEMA');
  throws_code(() => analyze(mkfx({ plans }), { as_of: '2026-10-04', scenario: { ops: [{ op: 'fx_shock', bp: -100 }] } }), 'E_SCHEMA');
});

test('TST-27 D-20 ADV analyze: событие в USD с налоговой аллокацией — резерв хранится в валюте решения (X4): аллокация от СКОНВЕРТИРОВАННОГО дохода', () => {
  const ws = mkfx({ plans: [{ id: 'inc', account_id: 'usd', currency: 'USD', date: day(3), amount_minor: 100000, tag: 'доход' }] });
  ws.reserves = [{ reserve_id: 'RT', kind: 'tax', currency: 'EUR', funded_start_minor: 0, funded_as_of: '2026-10-04' }];
  ws.tax_rules = [[{ tax_rule_id: 'TR', version: 1, kind: 'percent_of_income', rate_bp: 2000, base: 'gross', applies_to: { tags: ['доход'] }, valid_from: '2026-01-01', rounding: 'half_even', reserve_id: 'RT' }]];
  const a = analyze(ws, { as_of: '2026-10-04' });
  assert.equal(a.series.plan.close[3] - a.series.plan.trough[3], 92500, 'доход 100000 $ → 92500 €');
  assert.equal(last(a.series.plan.reserve_close), 18500, '20 % от 92500 €');
});

test('TST-27 C-098 ADV analyze: резерв в валюте ≠ валюте решения — E_CURRENCY_MISMATCH (проверка при построении)', () => {
  const ws = mkws();
  ws.reserves = [{ reserve_id: 'R', kind: 'sinking', mode: 'fixed', fixed_minor: 1, currency: 'USD', funded_start_minor: 0, funded_as_of: '2026-10-04' }];
  throws_code(() => analyze(ws, { as_of: '2026-10-04' }), 'E_CURRENCY_MISMATCH');
});

test('TST-27 D-07 ADV БАГ build_events: ПРОСРОЧЕННЫЙ перевод на накопительный счёт (обе ноги заданы, дата до as_of, якорь старше) пропадает из прогноза, хотя тот же перевод в будущем учитывается расходом', () => {
  const mk = (date) => {
    const leg = (id, acc, amt) => ({ id, account_id: acc, currency: 'EUR', date, amount_minor: amt, kind: 'transfer', transfer_id: 'T1' });
    return mkfx({ anchor_date: '2026-09-25', plans: [leg('t-out', 'acc', -100000), leg('t-in', 'sav', 100000)] });
  };
  const future = T.build_events(mk('2026-10-10'), { as_of: '2026-10-04', horizon_days: 30, mode: 'plan' });
  assert.deepEqual(future.map((e) => [e.cash_event_id, e.amount_minor]), [['t-out', -100000]], 'контроль: будущий перевод — расход');
  const overdue = T.build_events(mk('2026-10-02'), { as_of: '2026-10-04', horizon_days: 30, mode: 'plan' });
  assert.deepEqual(overdue.map((e) => [e.cash_event_id, e.amount_minor]), [['t-out', -100000]], 'просроченный (не подтверждённый фактом) перевод тоже считается на as_of; получено: ' + JSON.stringify(overdue.map((e) => e.cash_event_id)));
});

test('TST-27 D-07 ALG-02 шаг 4 (закрыто FP-02, Q-01): нога перевода без парной (данные неполны) НЕ исключается как «внутренний» перевод — расход остаётся в ряду, служебное предупреждение W_TRANSFER_UNPAIRED', () => {
  const one = mkfx({ plans: [{ id: 't-out', account_id: 'acc', currency: 'EUR', date: day(5), amount_minor: -100000, kind: 'transfer', transfer_id: 'T1' }] });
  const ev = analyze(one, { as_of: '2026-10-04' }).events.plan;
  assert.equal(ev.length, 1, 'ожидалось: расход учтён (или ошибка/предупреждение), а не тихо потерян');
});

test('TST-27 D-20 (закрыто FP-02, Q-16): operating-счёт в чужой валюте с явным нулевым остатком курса не требует — 0 в любой валюте = 0', () => {
  const ws = mkfx({ rates: [], anchors: [] });
  ws.anchors = [{ anchor_id: 'a1', account_id: 'acc', date: '2026-10-04', amount_minor: 100000 }, { anchor_id: 'a2', account_id: 'usd', date: '2026-10-04', amount_minor: 0 }];
  assert.equal(analyze(ws, { as_of: '2026-10-04' }).series.plan.opening_minor, 100000);
});

// ═══ ДОЛГИ И РАССРОЧКИ (ALG-09, C-039…C-041, N9) ════════════════════════════════════════════════════════════════════════

const rows_of = (p) => Dt.amortization_schedule({ start: P('2026-11-01'), ...p });
const cols = (rows, ...keys) => rows.map((r) => keys.map((k) => r[k]));

test('TST-26 §9.12 ADV debt: аннуитет 1200,00 €, 12 % годовых, 6 платежей — A = 20706; платежи 20706×5 и 20705; проценты 1200, 1005, 808, 609, 408, 205 (Σ 4235); остаток 100494 … 0', () => {
  assert.equal(Dt.annuity_payment(120000, 1200, 6), 20706);
  const rows = rows_of({ principal: 120000, rate_bp: 1200, n: 6, kind: 'annuity' });
  assert.deepEqual(rows.map((r) => r.payment_minor), [20706, 20706, 20706, 20706, 20706, 20705]);
  assert.deepEqual(rows.map((r) => r.interest_minor), [1200, 1005, 808, 609, 408, 205]);
  assert.deepEqual(rows.map((r) => r.balance_minor), [100494, 80793, 60895, 40798, 20500, 0]);
  assert.deepEqual(rows.map((r) => fmt(r.date)), ['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01', '2027-03-01', '2027-04-01']);
  assert.equal(rows.reduce((s, r) => s + r.interest_minor, 0), 4235);
  assert.equal(rows.reduce((s, r) => s + r.payment_minor, 0), 124235);
  assert.deepEqual(rows.map((r) => r.k), [1, 2, 3, 4, 5, 6]);
});

test('TST-26 ALG-09 TV-2/TV-4 ADV debt: дифференцированный (платежи 21200, 21000, …, 20200); дорожка 300,00 € в кредит (A = 5176, последний 5178, Σ процентов 1058)', () => {
  const diff = rows_of({ principal: 120000, rate_bp: 1200, n: 6, kind: 'differential' });
  assert.deepEqual(diff.map((r) => r.payment_minor), [21200, 21000, 20800, 20600, 20400, 20200]);
  assert.deepEqual(diff.map((r) => r.balance_minor), [100000, 80000, 60000, 40000, 20000, 0]);
  const cr = Dt.amortization_schedule({ principal: 30000, rate_bp: 1200, n: 6, start: P('2026-11-12'), kind: 'annuity' });
  assert.deepEqual(cols(cr, 'payment_minor', 'interest_minor', 'balance_minor'), [[5176, 300, 25124], [5176, 251, 20199], [5176, 202, 15225], [5176, 152, 10201], [5176, 102, 5127], [5178, 51, 0]]);
  assert.equal(cr.reduce((s, r) => s + r.interest_minor, 0), 1058);
  assert.equal(cr.reduce((s, r) => s + r.payment_minor, 0), 31058);
});

test('TST-26 C-041 ADV debt: аннуитет с нулевой ставкой — это рассрочка: A = ceil(P/n), график split_equal, ПОСЛЕДНИЙ платёж меньше A; даты 31→30→31 без дрейфа', () => {
  assert.equal(Dt.annuity_payment(100, 0, 3), 34);
  const rows = Dt.amortization_schedule({ principal: 100, rate_bp: 0, n: 3, start: P('2026-10-31'), kind: 'annuity' });
  assert.deepEqual(rows.map((r) => [r.payment_minor, r.interest_minor, r.balance_minor]), [[34, 0, 66], [33, 0, 33], [33, 0, 0]]);
  assert.deepEqual(rows.map((r) => fmt(r.date)), ['2026-10-31', '2026-11-30', '2026-12-31']);
  assert.deepEqual(Dt.installment_parts(110000, 6), [18334, 18334, 18333, 18333, 18333, 18333]);
});

test('TST-26 REQ-044 ADV debt: рассрочка на n = 1 — один платёж = сумма на дату старта; аннуитет на n = 1 — P + проценты периода; rate 0 у installment_0', () => {
  const inst = Dt.amortization_schedule({ principal: 110000, rate_bp: 0, n: 1, start: P('2026-11-01'), kind: 'installment_0' });
  assert.deepEqual(inst.map((r) => [r.k, fmt(r.date), r.payment_minor, r.interest_minor, r.principal_minor, r.balance_minor]), [[1, '2026-11-01', 110000, 0, 110000, 0]]);
  const ann = Dt.amortization_schedule({ principal: 120000, rate_bp: 1200, n: 1, start: P('2026-11-01'), kind: 'annuity' });
  assert.deepEqual(ann.map((r) => [r.payment_minor, r.interest_minor, r.balance_minor]), [[121200, 1200, 0]]);
  assert.equal(Dt.annuity_payment(120000, 1200, 1), 121200);
  assert.deepEqual(Dt.installment_parts(7, 1), [7]);
});

test('TST-26 N9 ADV debt: режим округления процентов — half_even (по умолчанию) и half_up различаются на ничьей (50·1 %/12 = 0,5 → 0 / 1); floor запрещён; E_SCHEMA', () => {
  const p = { principal: 50, rate_bp: 1200, n: 1, start: P('2026-11-01'), kind: 'differential' };
  assert.equal(Dt.amortization_schedule(p)[0].payment_minor, 50);
  assert.equal(Dt.amortization_schedule({ ...p, rounding: 'half_up' })[0].payment_minor, 51);
  throws_code(() => Dt.amortization_schedule({ ...p, rounding: 'floor' }), 'E_SCHEMA');
  throws_code(() => Dt.annuity_payment(1000, 1200, 3, 'ceil'), 'E_SCHEMA');
});

test('TST-26 C-041 ADV validate_debt: P ≥ 1, 1 ≤ n ≤ 600, 0 ≤ rate_bp ≤ 100000, installment_0 ⇒ rate 0, P ≥ n для annuity/differential (installment_0 допускает P < n); граница включительна', () => {
  assert.doesNotThrow(() => Dt.validate_debt(600, 100000, 600, 'annuity'));
  assert.doesNotThrow(() => Dt.validate_debt(1, 0, 1, 'annuity'));
  assert.doesNotThrow(() => Dt.validate_debt(3, 0, 5, 'installment_0'));
  for (const args of [[0, 0, 1, 'annuity'], [100, 0, 0, 'annuity'], [100, 0, 601, 'annuity'], [100, -1, 5, 'annuity'], [100, 100001, 5, 'annuity'],
    [100, 1, 5, 'installment_0'], [4, 0, 5, 'annuity'], [4, 0, 5, 'differential'], [100, 0, 5, 'weird']]) {
    throws_code(() => Dt.validate_debt(...args), 'E_SCHEMA', JSON.stringify(args));
  }
  throws_code(() => Dt.validate_debt(100.5, 0, 5, 'annuity'), 'E_NOT_INTEGER');
});

test('TST-26 REQ-044 ADV installment_parts: Σ = total, части различаются ≤ 1 и не возрастают; total < n — нулевые части допустимы; total или n < 1 — E_SCHEMA', () => {
  assert.deepEqual(Dt.installment_parts(3, 5), [1, 1, 1, 0, 0]);
  const rng = make_rng(3);
  for (let i = 0; i < 300; i++) {
    const total = rng.int(1, 1000000);
    const n = rng.int(1, 60);
    const parts = Dt.installment_parts(total, n);
    assert.equal(parts.reduce((a, b) => a + b, 0), total);
    assert.ok(Math.max(...parts) - Math.min(...parts) <= 1);
    for (let j = 1; j < n; j++) assert.ok(parts[j - 1] >= parts[j]);
  }
  throws_code(() => Dt.installment_parts(0, 3), 'E_SCHEMA');
  throws_code(() => Dt.installment_parts(10, 0), 'E_SCHEMA');
});

test('TST-26 C-039 ADV schedule_to_events: платёж → расход с платёжного счёта, is_obligation, id <debt>@<дата>; платёж 0 пропускается; сохранённый schedule главнее полей плана (перенос даты строки)', () => {
  const debt = { debt_id: 'D1', pay_account_id: 'acc', currency: 'EUR', kind: 'installment_0', principal_minor: 3, rate_bp: 0, n: 5, start_date: '2026-11-01' };
  const ev = Dt.schedule_to_events(debt);
  assert.deepEqual(ev.map((e) => [e.cash_event_id, fmt(e.date), e.amount_minor]), [['D1@2026-11-01', '2026-11-01', -1], ['D1@2026-12-01', '2026-12-01', -1], ['D1@2027-01-01', '2027-01-01', -1]]);
  assert.deepEqual([ev[0].account_id, ev[0].kind, ev[0].layer, ev[0].status, ev[0].is_obligation, ev[0].is_estimate, ev[0].rule_id, ev[0].currency], ['acc', 'expense', 'planned', 'expected', true, false, null, 'EUR']);
  const moved = Dt.schedule_to_events({ ...debt, schedule: [{ k: 1, date: '2026-11-03', payment_minor: 100, interest_minor: 0, principal_minor: 100, balance_minor: 0 }] });
  assert.deepEqual(moved.map((e) => [e.cash_event_id, e.amount_minor]), [['D1@2026-11-03', -100]]);
  throws_code(() => Dt.amortization_schedule({ principal: 100, rate_bp: 0, n: 2, start: 0, kind: 'installment_0', cadence: { freq: 'M', interval: 2 } }), 'E_SCHEMA');
  throws_code(() => Dt.amortization_schedule({ principal: 100, rate_bp: 0, n: 2, start: 0, kind: 'installment_0', cadence: { freq: 'W', interval: 1 } }), 'E_SCHEMA');
});

test('TST-26 ADV debt: свойство — график закрывается ровно (Σ основного = P, остаток 0, строго убывает), проценты = round_half_even(остаток·r/120000) (BigInt-оракул), платежи k < n равны A, |последний − A| ≤ 2n (P ≥ 100000, r ≤ 3000, n ≤ 60)', () => {
  const rng = make_rng(2026);
  const rd = (num, den) => { const q = num / den; const r = num % den; return r * 2n > den || (r * 2n === den && q % 2n === 1n) ? q + 1n : q; };
  for (let it = 0; it < 300; it++) {
    const n = rng.int(1, 60);
    const Pn = rng.int(100000, 100000000);
    const r = rng.int(0, 3000);
    const rows = Dt.amortization_schedule({ principal: Pn, rate_bp: r, n, start: P('2026-01-31'), kind: 'annuity' });
    assert.equal(rows.length, n);
    assert.equal(rows.reduce((s, x) => s + x.principal_minor, 0), Pn);
    assert.equal(rows[n - 1].balance_minor, 0);
    let bal = Pn;
    for (const row of rows) {
      const interest = r === 0 ? 0 : Number(rd(BigInt(bal) * BigInt(r), 120000n));
      assert.equal(row.interest_minor, interest, `it ${it} k ${row.k}`);
      assert.equal(row.payment_minor, row.principal_minor + row.interest_minor);
      assert.ok(row.principal_minor > 0 && row.balance_minor < bal);
      bal = row.balance_minor;
    }
    if (r > 0) {
      const A = Dt.annuity_payment(Pn, r, n);
      assert.ok(rows.slice(0, n - 1).every((x) => x.payment_minor === A));
      assert.ok(Math.abs(rows[n - 1].payment_minor - A) <= 2 * n, `it ${it}: |последний − A| ≤ 2n (гипотеза канона «≤ n» опровергнута отдельным todo-тестом)`);
    }
    for (let k = 1; k < n; k++) assert.ok(rows[k].date > rows[k - 1].date);
  }
});

test('TST-26 canon_suspect ALG-09 инв. 3: гипотеза «|последний платёж − A| ≤ n при n ≤ 60, r ≤ 2400» опровергается: P = 32443759, 23,68 %, n = 57 → отклонение 61 > 57', { todo: 'канон: оценка накопленного округления не доказана' }, () => {
  const rows = Dt.amortization_schedule({ principal: 32443759, rate_bp: 2368, n: 57, start: P('2026-01-31'), kind: 'annuity' });
  const A = Dt.annuity_payment(32443759, 2368, 57);
  assert.ok(Math.abs(rows[56].payment_minor - A) <= 57, 'A = ' + A + ', последний = ' + rows[56].payment_minor);
});

test('TST-26 C-041 ADV БАГ debt: корректные по validate_debt входы (P = 1642 minor, n = 60, 12 %) роняют amortization_schedule E_SCHEMA degenerate_schedule (округление A накапливается); график должен строиться', () => {
  const P_ = 1642;
  assert.doesNotThrow(() => Dt.validate_debt(P_, 1200, 60, 'annuity'));
  const rows = Dt.amortization_schedule({ principal: P_, rate_bp: 1200, n: 60, start: P('2026-11-01'), kind: 'annuity' });
  assert.equal(rows.reduce((s, r) => s + r.principal_minor, 0), P_);
  assert.equal(rows[59].balance_minor, 0);
});

test('TST-26 C-041 ADV БАГ debt: корректные входы с высокой ставкой (P = 806959113, n = 334, 62 % годовых = 6200 bp ≤ 100000) роняют E_SCHEMA degenerate_schedule на k = 331', () => {
  assert.doesNotThrow(() => Dt.validate_debt(806959113, 6200, 334, 'annuity'));
  const rows = Dt.amortization_schedule({ principal: 806959113, rate_bp: 6200, n: 334, start: P('2026-11-01'), kind: 'annuity' });
  assert.equal(rows[333].balance_minor, 0);
});

test('TST-26 ADV debt: нулевая часть основного долга в аннуитете малого долга — график содержит платёж 0 (P = 149, n = 54, 16,04 %): invariant «баланс убывает» нарушен (principal 0 в строке 54)', () => {
  const rows = Dt.amortization_schedule({ principal: 149, rate_bp: 1604, n: 54, start: P('2026-11-01'), kind: 'annuity' });
  assert.ok(rows.every((r) => r.principal_minor > 0 && r.payment_minor > 0), 'ALG-09 инв. 1: баланс убывает строго; получены строки: ' + JSON.stringify(rows.filter((r) => r.principal_minor <= 0).map((r) => r.k)));
});

test('TST-26 D-20 ADV analyze: рассрочка 1100,00 € (110000 / 6 с 2026-11-01) при горизонте 57 дн. — в ряд входит ОДИН платёж 18334; free min plan 93500 − 18334 = 75166 (11-01), worse 71000 − 18334 = 52666 (11-14); при горизонте 180 — шесть платежей Σ 110000', () => {
  const ws = clone(G001);
  ws.debts = [{ debt_id: 'D-INST', pay_account_id: 'acc_main', currency: 'EUR', kind: 'installment_0', principal_minor: 110000, rate_bp: 0, n: 6, start_date: '2026-11-01' }];
  const a = run_g(ws);
  const d = a.events.plan.filter((e) => e.cash_event_id.startsWith('D-INST@'));
  assert.deepEqual(d.map((e) => [fmt(e.date), e.amount_minor]), [['2026-11-01', -18334]]);
  assert.equal(Math.min(...a.series.plan.free), 75166);
  assert.equal(Math.min(...a.series.worse.free), 52666);
  const long = run_g({ ...ws, params: { ...ws.params, horizon_days: 180 } });
  const all = long.events.plan.filter((e) => e.cash_event_id.startsWith('D-INST@'));
  assert.equal(all.length, 6);
  assert.equal(all.reduce((s, e) => s + e.amount_minor, 0), -110000);
  // платёж в долге — обязательство: попадает в волны
  assert.ok(W.list_waves(a, 'plan').some((x) => x.wave.event_ids.includes('D-INST@2026-11-01')));
});

test('TST-26 C-039 ADV analyze: валюта долга ≠ валюте платёжного счёта — E_CURRENCY_MISMATCH', () => {
  const ws = clone(G001);
  ws.debts = [{ debt_id: 'D-USD', pay_account_id: 'acc_main', currency: 'USD', kind: 'installment_0', principal_minor: 1000, rate_bp: 0, n: 2, start_date: '2026-11-01' }];
  throws_code(() => run_g(ws), 'E_CURRENCY_MISMATCH');
});

test('TST-26 ADV debt v2: prepay — только в день платежа и не последнего; shorten уменьшает число платежей и проценты; lower_payment сохраняет срок; reanchor — drift = observed − modeled (80793 → 80900: +107), хвост от наблюдаемого остатка', () => {
  const debt = { debt_id: 'D', pay_account_id: 'acc', currency: 'EUR', kind: 'annuity', principal_minor: 120000, rate_bp: 1200, n: 6, start_date: '2026-11-01' };
  const orig = Dt.amortization_schedule({ principal: 120000, rate_bp: 1200, n: 6, start: P('2026-11-01'), kind: 'annuity' });
  const sh = Dt.prepay(debt, 30000, P('2026-12-01'), 'shorten');
  assert.equal(sh.length, 5, 'платёж 20706 на хвост 50793: 3 платежа после двух выполненных → 5 строк');
  assert.equal(sh.at(-1).balance_minor, 0);
  assert.ok(sh.reduce((s, r) => s + r.interest_minor, 0) < orig.reduce((s, r) => s + r.interest_minor, 0));
  const lo = Dt.prepay(debt, 30000, P('2026-12-01'), 'lower_payment');
  assert.equal(lo.length, 6);
  assert.ok(lo[3].payment_minor < orig[3].payment_minor);
  throws_code(() => Dt.prepay(debt, 30000, P('2026-12-02'), 'shorten'), 'E_SCHEMA');
  throws_code(() => Dt.prepay(debt, 30000, P('2027-04-01'), 'shorten'), 'E_SCHEMA');
  throws_code(() => Dt.prepay(debt, 0, P('2026-12-01'), 'shorten'), 'E_SCHEMA');
  const re = Dt.reanchor(debt, 2, 80900);
  assert.equal(re.drift, 107);
  assert.equal(re.schedule.length, 6);
  assert.equal(re.schedule[1].balance_minor, 80793, 'выполненные строки не меняются');
  assert.equal(re.schedule[5].balance_minor, 0);
  assert.equal(Dt.reanchor(debt, 2, 0).schedule.length, 2, 'observed ≤ 0 — долг закрыт');
  throws_code(() => Dt.reanchor(debt, 0, 1), 'E_SCHEMA');
  throws_code(() => Dt.reanchor(debt, 7, 1), 'E_SCHEMA');
});

// ═══ ТАЙМЛАЙН: сетка, Q1, runway (D-01, D-13, C-005, C-006, ALG-02) ═════════════════════════════════════════════════════

const LOW = load('g001-low.json');
const GAP = load('g001-gap.json');
const LATE = load('g001-late.json');

test('TST-31 D-01 ADV project: день 0 — расходы раньше доходов: opening 10000, +50000 и −30000 → trough −20000, close 30000 (разрыв в течение дня при положительном close)', () => {
  const s = T.project([ev_of('in', 0, 50000), ev_of('out', 0, -30000)], 10000, 0, 2);
  assert.deepEqual(s.trough, [-20000, 30000, 30000]);
  assert.deepEqual(s.close, [30000, 30000, 30000]);
  assert.equal(s.opening_minor, 10000);
  assert.equal(s.from, 0);
});

test('TST-31 D-01 ADV project: событие на horizon_end входит, на horizon_end+1 — нет; событие раньше as_of — E_SCHEMA; as_of = horizon_end → N = 1; horizon_end < as_of — E_BAD_DATE; ISO-даты', () => {
  const s = T.project([ev_of('a', 4, -100), ev_of('b', 5, -999)], 1000, 0, 4);
  assert.deepEqual(s.close, [1000, 1000, 1000, 1000, 900]);
  throws_code(() => T.project([ev_of('a', -1, -100)], 1000, 0, 4), 'E_SCHEMA');
  const one = T.project([ev_of('a', 0, -100), ev_of('b', 0, 30)], 1000, 0, 0);
  assert.deepEqual([one.trough, one.close], [[900], [930]]);
  throws_code(() => T.project([], 1000, 5, 4), 'E_BAD_DATE');
  const iso = T.project([{ ...ev_of('a', 0, -100), date: '2026-10-05' }], 1000, '2026-10-04', '2026-10-06');
  assert.deepEqual(iso.close, [1000, 900, 900]);
  assert.deepEqual(T.project([], 77, 0, 3).close, [77, 77, 77, 77], 'пустой ряд: close = trough = opening');
});

test('TST-31 D-01 ADV project: сохранение close[i] − close[i−1] = out_i + in_i и trough[i] ≤ min(close[i−1], close[i]) на случайных входах; переполнение — E_OVERFLOW', () => {
  const rng = make_rng(31);
  for (let it = 0; it < 200; it++) {
    const N = rng.int(1, 30);
    const evs = Array.from({ length: rng.int(0, 20) }, (_, i) => ev_of('e' + i, rng.int(0, N - 1), rng.int(-5000, 5000) || 1));
    const opening = rng.int(-3000, 9000);
    const s = T.project(evs, opening, 0, N - 1);
    for (let i = 0; i < N; i++) {
      const prev = i === 0 ? opening : s.close[i - 1];
      const day_sum = evs.filter((e) => e.date === i).reduce((a, e) => a + e.amount_minor, 0);
      const outs = evs.filter((e) => e.date === i && e.amount_minor < 0).reduce((a, e) => a + e.amount_minor, 0);
      assert.equal(s.close[i], prev + day_sum);
      assert.equal(s.trough[i], prev + outs);
      assert.ok(s.trough[i] <= prev && s.trough[i] <= s.close[i]);
    }
  }
  throws_code(() => T.project([ev_of('a', 0, 1)], Number.MAX_SAFE_INTEGER, 0, 1), 'E_OVERFLOW');
});

// ряд для Q1: opening 1000; d1 −200; d3 −1500; d5 +3000; d7 −4000; N = 9
const Q1_EVS = [ev_of('a', 1, -200), ev_of('b', 3, -1500), ev_of('c', 5, 3000), ev_of('d', 7, -4000)];
const Q1_SERIES = T.project(Q1_EVS, 1000, 0, 8);

test('TST-13 D-13 ADV answer_q1: путь [as_of, D]: min, первая дата минимума, ok_cash/ok_buffer, first_breach, first_buffer_breach, need, close_on_D (ручной расчёт)', () => {
  assert.deepEqual(Q1_SERIES.trough, [1000, 800, 800, -700, -700, -700, 2300, -1700, -1700]);
  assert.deepEqual(T.answer_q1(Q1_SERIES, 2, 500), { min: 800, at: 1, ok_cash: true, ok_buffer: true, first_breach: null, first_buffer_breach: null, need: 0, close_on_D: 800 });
  assert.deepEqual(T.answer_q1(Q1_SERIES, 3, 500), { min: -700, at: 3, ok_cash: false, ok_buffer: false, first_breach: 3, first_buffer_breach: 3, need: 1200, close_on_D: -700 });
  const q8 = T.answer_q1(Q1_SERIES, 8, 0);
  assert.deepEqual([q8.min, q8.at, q8.first_breach, q8.first_buffer_breach, q8.need, q8.close_on_D], [-1700, 7, 3, 3, 1700, -1700], 'минимум держится d7…d8 — первая дата d7');
  // свойство пути: к D = 6 close = 2300, но минимум по пути −700
  const q6 = T.answer_q1(Q1_SERIES, 6, 0);
  assert.deepEqual([q6.min, q6.close_on_D, q6.ok_cash], [-700, 2300, false]);
});

test('TST-13 D-13 ADV answer_q1: ровно на буфере — ok_buffer (≥), на 1 ниже — нет и first_buffer_breach на самой первой дате; D = as_of; B не задан (null/undefined) = 0', () => {
  assert.equal(T.answer_q1(Q1_SERIES, 0, 1000).ok_buffer, true);
  const b = T.answer_q1(Q1_SERIES, 0, 1001);
  assert.deepEqual([b.ok_buffer, b.ok_cash, b.first_buffer_breach, b.need], [false, true, 0, 1]);
  assert.deepEqual(T.answer_q1(Q1_SERIES, 2, null), T.answer_q1(Q1_SERIES, 2, 0));
  assert.deepEqual(T.answer_q1(Q1_SERIES, 2, undefined), T.answer_q1(Q1_SERIES, 2, 0));
});

test('TST-13 D-13 ADV answer_q1: D позже горизонта — {beyond_horizon: true}; D раньше as_of — E_BAD_DATE; даты как ISO', () => {
  assert.deepEqual(T.answer_q1(Q1_SERIES, 9, 0), { beyond_horizon: true });
  assert.deepEqual(T.answer_q1(Q1_SERIES, 8, 0).beyond_horizon, undefined);
  throws_code(() => T.answer_q1(Q1_SERIES, -1, 0), 'E_BAD_DATE');
  const s = T.project([ev_of('a', '2026-10-06', -500)], 1000, '2026-10-04', '2026-10-08');
  assert.equal(T.answer_q1(s, '2026-10-06', 0).min, 500);
});

test('TST-13 C-006 ADV runway_days: считается по trough на всём горизонте; «без поступлений» пересчитывается из событий: с доходом нет разрыва (null), без — на d3', () => {
  const evs = [ev_of('i', 101, 2000), ev_of('x', 103, -1500), ev_of('y', 105, -1200)];
  const s = T.project(evs, 1000, 100, 109);
  assert.deepEqual(T.runway_days(s, evs), { with: null, without: { date: 103, days: 3 } });
  // разрыв внутри дня при положительном close: расходы раньше доходов
  const evs2 = [ev_of('in', 100, 5000), ev_of('out', 100, -3000)];
  const s2 = T.project(evs2, 1000, 100, 102);
  assert.deepEqual(T.runway_days(s2, evs2), { with: { date: 100, days: 0 }, without: { date: 100, days: 0 } });
});

test('TST-13 §9.9 ADV analyze G-001-gap: Q1 — min −94500 (plan, 10-31) / −117000 (worse, 11-14), first_breach 10-26, first_buffer_breach 10-23, need 144500 / 167000; runway_with = 10-26 (22 дня), runway_without = 10-26', () => {
  const a = run_g(GAP);
  const q = a.q1;
  assert.deepEqual([q.plan.min, fmt(q.plan.at), fmt(q.plan.first_breach), fmt(q.plan.first_buffer_breach), q.plan.need], [-94500, '2026-10-31', '2026-10-26', '2026-10-23', 144500]);
  assert.deepEqual([q.worse.min, fmt(q.worse.at), q.worse.need], [-117000, '2026-11-14', 167000]);
  assert.deepEqual([q.plan.ok_cash, q.plan.ok_buffer], [false, false]);
  const r = T.runway_days(a.series.plan, a.events.plan);
  assert.deepEqual([fmt(r.with.date), r.with.days, fmt(r.without.date)], ['2026-10-26', 22, '2026-10-26']);
  assert.equal(a.series.plan.trough[a.series.plan.trough.findIndex((x) => x < 0)], -84500, 'первая отрицательная trough — −84500');
});

// ═══ режимы и эффективная дата (D-04, C-005, C-009, TV6) ═════════════════════════════════════════════════════════════════

test('TST-35 D-04 ADV eff_date: matched/skipped/cancelled — null; plan = max(plan_date, as_of); worse сдвигает ТОЛЬКО доход; delay_days_worse события главнее параметра, 0 — без сдвига', () => {
  const as_of = 100;
  const inc = { cash_event_id: 'i', kind: 'income', amount_minor: 10, date: 90, plan_date: 90 };
  const exp = { cash_event_id: 'x', kind: 'expense', amount_minor: -10, date: 90, plan_date: 90 };
  for (const status of ['matched', 'skipped', 'cancelled']) assert.equal(T.eff_date({ ...inc, status }, 'plan', {}, as_of), null);
  assert.equal(T.eff_date({ ...inc, status: 'overdue' }, 'plan', {}, as_of), 100);
  assert.equal(T.eff_date(inc, 'plan', {}, as_of), 100, 'прошлый план считается на as_of');
  assert.equal(T.eff_date({ ...inc, plan_date: 120 }, 'plan', {}, as_of), 120);
  assert.equal(T.eff_date({ ...inc, plan_date: undefined, date: 130 }, 'plan', {}, as_of), 130, 'без plan_date — date');
  assert.equal(T.eff_date({ ...inc, plan_date: 120 }, 'worse', {}, as_of), 134, 'по умолчанию +14');
  assert.equal(T.eff_date(inc, 'worse', {}, as_of), 114, 'просроченный доход: as_of + 14');
  assert.equal(T.eff_date({ ...exp, plan_date: 120 }, 'worse', {}, as_of), 120, 'расход не сдвигается');
  assert.equal(T.eff_date({ ...inc, plan_date: 120, delay_days_worse: 3 }, 'worse', {}, as_of), 123);
  assert.equal(T.eff_date({ ...inc, plan_date: 120, delay_days_worse: 0 }, 'worse', {}, as_of), 120);
  assert.equal(T.eff_date({ ...inc, plan_date: 120 }, 'worse', { 'worse.income_delay_days': 5 }, as_of), 125);
  assert.equal(T.eff_date({ ...inc, plan_date: 120 }, 'worse', { worse: { income_delay_days: 6 } }, as_of), 126, 'вложенные параметры');
  assert.equal(T.eff_date({ ...inc, plan_date: 120 }, 'conservative', {}, as_of), 134);
});

test('TST-35 D-04 ADV eff_date: режим expected (v2) и неизвестный — E_SCHEMA; отрицательный или нецелый сдвиг — E_SCHEMA (нарушил бы worse ≤ plan)', () => {
  const inc = { cash_event_id: 'i', kind: 'income', amount_minor: 10, date: 120, plan_date: 120 };
  throws_code(() => T.eff_date(inc, 'expected', {}, 100), 'E_SCHEMA');
  throws_code(() => T.eff_date(inc, 'fast', {}, 100), 'E_SCHEMA');
  throws_code(() => T.eff_date({ ...inc, delay_days_worse: -1 }, 'worse', {}, 100), 'E_SCHEMA');
  throws_code(() => T.eff_date({ ...inc, delay_days_worse: 1.5 }, 'worse', {}, 100), 'E_SCHEMA');
  throws_code(() => T.eff_date(inc, 'worse', { 'worse.income_delay_days': -3 }, 100), 'E_SCHEMA');
  assert.equal(T.eff_date({ ...inc, delay_days_worse: -1 }, 'plan', {}, 100), 120, 'в plan сдвиг не читается');
});

test('TST-35 ALG-02 TV6 ADV analyze: доход, план 10-15, grace 3 — на as_of 10-18 expected (eff plan 10-18, worse 11-01); на 10-19 overdue (eff 10-19 / 11-02)', () => {
  const at = (as_of) => analyze(mkws({ as_of, anchor_date: '2026-10-10', params: { horizon_days: 40 }, plans: [{ id: 'inc', date: '2026-10-15', amount_minor: 50000, tag: 'доход' }] }), { as_of, modes: ['plan', 'worse'] });
  const a18 = at('2026-10-18');
  assert.deepEqual([a18.events.plan[0].status, fmt(a18.events.plan[0].date), fmt(a18.events.worse[0].date)], ['expected', '2026-10-18', '2026-11-01']);
  const a19 = at('2026-10-19');
  assert.deepEqual([a19.events.plan[0].status, fmt(a19.events.plan[0].date), fmt(a19.events.worse[0].date)], ['overdue', '2026-10-19', '2026-11-02']);
  assert.equal(fmt(a19.events.plan[0].plan_date), '2026-10-15', 'plan_date не зажимается');
});

test('TST-35 D-04 ADV analyze: ряды worse ≤ plan по trough и close в любой день, суммы событий равны (режим не меняет суммы), расходы не сдвигаются', () => {
  const rng = make_rng(35);
  for (let it = 0; it < 100; it++) {
    const plans = Array.from({ length: rng.int(1, 10) }, (_, i) => {
      const amt = rng.bool() ? rng.int(1, 9000) : -rng.int(1, 9000);
      return { id: 'p' + i, date: day(rng.int(-3, 28)), amount_minor: amt, tag: 't', ...(amt > 0 && rng.bool() ? { delay_days_worse: rng.int(0, 20) } : {}) };
    });
    const a = analyze(mkws({ opening: rng.int(-2000, 20000), anchor_date: day(-3), plans, params: { horizon_days: 30 } }), { as_of: '2026-10-04' });
    for (let i = 0; i < 31; i++) {
      assert.ok(a.series.worse.trough[i] <= a.series.plan.trough[i], `it ${it} day ${i}`);
      assert.ok(a.series.worse.close[i] <= a.series.plan.close[i]);
    }
    const exp_dates = (m) => a.events[m].filter((e) => e.amount_minor < 0).map((e) => [e.cash_event_id, e.date]);
    assert.deepEqual(exp_dates('worse'), exp_dates('plan'), 'даты расходов не зависят от режима');
  }
});

// ═══ сценарии (D-14, C-008, C-009, TST-34, TST-36) ═══════════════════════════════════════════════════════════════════════

const SC_WS = () => mkws({ opening: 100000, params: { horizon_days: 40 }, plans: [
  { id: 'inc', date: day(5), amount_minor: 50000, tag: 'доход' }, { id: 'exp', date: day(8), amount_minor: -30000, tag: 'аренда', is_obligation: true },
] });
const sc = (...ops) => ({ scenario_id: 'sc', ops });

test('TST-35 C-009 ADV сценарий+режим накапливаются: delay_income 14 в plan = ряд worse (trough и close); delay_income 7 в worse = delay_income 21 в plan', () => {
  const ws = SC_WS();
  const base = analyze(ws, { as_of: '2026-10-04' });
  const d14 = analyze(ws, { as_of: '2026-10-04', scenario: sc({ op: 'delay_income', event_ref: 'inc', days: 14 }) });
  assert.deepEqual(d14.series.plan.trough, base.series.worse.trough);
  assert.deepEqual(d14.series.plan.close, base.series.worse.close);
  const d7w = analyze(ws, { as_of: '2026-10-04', scenario: sc({ op: 'delay_income', event_ref: 'inc', days: 7 }) }).series.worse;
  const d21p = analyze(ws, { as_of: '2026-10-04', scenario: sc({ op: 'delay_income', event_ref: 'inc', days: 21 }) }).series.plan;
  assert.deepEqual(d7w.close, d21p.close);
  assert.deepEqual(d7w.trough, d21p.trough);
  // сдвиг за горизонт: доход исчезает из ряда
  const gone = analyze(ws, { as_of: '2026-10-04', scenario: sc({ op: 'delay_income', event_ref: 'inc', days: 36 }) }).series.plan;
  assert.equal(last(gone.close), 100000 - 30000);
});

test('TST-36 D-14 ADV сценарий add_purchase аддитивен: close_new[i] = close_base[i] − cum[i], trough_new[i] = trough_base[i] − cum[i] (части 4000 на d3 и 2500 на d10)', () => {
  const ws = SC_WS();
  const base = analyze(ws, { as_of: '2026-10-04' });
  const s = analyze(ws, { as_of: '2026-10-04', scenario: sc({ op: 'add_purchase', parts: [{ date: day(3), amount_minor: 4000 }, { date: day(10), amount_minor: 2500 }] }) });
  const cum = (i) => (i >= 3 ? 4000 : 0) + (i >= 10 ? 2500 : 0);
  for (const m of ['plan', 'worse']) {
    for (let i = 0; i < 41; i++) {
      assert.equal(s.series[m].close[i], base.series[m].close[i] - cum(i), `${m} close ${i}`);
      assert.equal(s.series[m].trough[i], base.series[m].trough[i] - cum(i), `${m} trough ${i}`);
    }
  }
  // покупка — не обязательство: волны не меняются по составу
  assert.deepEqual(W.list_waves(s, 'plan').map((x) => x.wave.event_ids), W.list_waves(base, 'plan').map((x) => x.wave.event_ids));
  // локальность (TST-34): ряды до d3 не меняются
  assert.deepEqual(s.series.plan.trough.slice(0, 3), base.series.plan.trough.slice(0, 3));
});

test('TST-34 C-008 ADV apply_scenario: event_ref — сначала cash_event_id/occ_key, затем rule_id/stream_id; delay_income и set_amount требуют одно событие; shift_flow и remove_flow — группу; вход не мутируется', () => {
  const mk = (id, date, amt, o = {}) => ({ cash_event_id: id, layer: 'planned', account_id: 'acc', date, plan_date: date, amount_minor: amt, currency: 'EUR', kind: amt > 0 ? 'income' : 'expense', rule_id: null, occ_key: id, ...o });
  const evs = [mk('R@1', 10, 500, { rule_id: 'R' }), mk('R@2', 20, 500, { rule_id: 'R' }), mk('X', 15, -300)];
  const snapshot = JSON.stringify(evs);
  const ctx = { as_of: 0, horizon_end: 100, calendars: [], default_account_id: 'acc', default_currency: 'EUR' };
  const dates = (r) => r.map((e) => [e.cash_event_id, e.date]);
  assert.deepEqual(dates(T.apply_scenario(evs, { scenario_id: 's', ops: [{ op: 'delay_income', event_ref: 'R@2', days: 3 }] }, ctx)), [['R@1', 10], ['R@2', 23], ['X', 15]]);
  throws_code(() => T.apply_scenario(evs, { ops: [{ op: 'delay_income', event_ref: 'R', days: 3 }] }, ctx), 'E_SCHEMA');
  throws_code(() => T.apply_scenario(evs, { ops: [{ op: 'set_amount', event_ref: 'R', amount_minor: 1 }] }, ctx), 'E_SCHEMA');
  assert.deepEqual(dates(T.apply_scenario(evs, { ops: [{ op: 'shift_flow', event_ref: 'R', days: -4 }] }, ctx)), [['R@1', 6], ['R@2', 16], ['X', 15]]);
  assert.deepEqual(T.apply_scenario(evs, { ops: [{ op: 'remove_flow', event_ref: 'R' }] }, ctx).map((e) => e.cash_event_id), ['X']);
  const set = T.apply_scenario([{ ...evs[0], amount_min_minor: 1, amount_max_minor: 9 }], { ops: [{ op: 'set_amount', event_ref: 'R@1', amount_minor: 777 }] }, ctx)[0];
  assert.deepEqual([set.amount_minor, set.amount_min_minor, set.amount_max_minor], [777, undefined, undefined], 'коридор сброшен');
  assert.equal(JSON.stringify(evs), snapshot, 'входные события не изменены');
  assert.equal(T.apply_scenario(evs, { scenario_id: 's', ops: [{ op: 'shift_flow', event_ref: 'X', days: 1 }] }, ctx).find((e) => e.cash_event_id === 'X').scenario_id, 's', 'изменённому событию проставляется scenario_id');
});

test('TST-34 ALG-02 ADV apply_scenario: ошибки — ссылка не найдена, delay_income на расход, отрицательные дни, set_amount с неверным знаком и нулём, hours (v1.1), неизвестная операция, add_purchase без счёта, add_flow без once/rule', () => {
  const mk = (id, amt, o = {}) => ({ cash_event_id: id, layer: 'planned', account_id: 'acc', date: 10, plan_date: 10, amount_minor: amt, currency: 'EUR', kind: amt > 0 ? 'income' : 'expense', rule_id: null, occ_key: id, ...o });
  const evs = [mk('I', 500), mk('E', -300)];
  const ctx = { as_of: 0, horizon_end: 100, calendars: [], default_account_id: 'acc', default_currency: 'EUR' };
  const bad = (op, c = ctx) => throws_code(() => T.apply_scenario(evs, { ops: [op] }, c), 'E_SCHEMA', JSON.stringify(op));
  bad({ op: 'delay_income', event_ref: 'nope', days: 1 });
  bad({ op: 'delay_income', event_ref: 'E', days: 1 });
  bad({ op: 'delay_income', event_ref: 'I', days: -1 });
  bad({ op: 'delay_income', event_ref: 'I', days: 1.5 });
  bad({ op: 'set_amount', event_ref: 'I', amount_minor: -5 });
  bad({ op: 'set_amount', event_ref: 'E', amount_minor: 5 });
  bad({ op: 'set_amount', event_ref: 'E', amount_minor: 0 });
  bad({ op: 'hours', stream_id: 'S', minutes: 1 });
  bad({ op: 'explode' });
  bad({ op: 'add_flow' });
  bad({ op: 'add_purchase', parts: [{ date: 5, amount_minor: 1 }] }, { ...ctx, default_account_id: null });
  bad({ op: 'add_purchase', parts: [{ date: 5, amount_minor: 0 }] });
  bad({ op: 'add_purchase', parts: [] });
  bad({ op: 'shift_flow', event_ref: 'I', days: 1.5 });
  bad({ op: 'fx_shock', bp: 5 });
  assert.deepEqual(T.apply_scenario(evs, { ops: [] }, ctx), evs, 'пустой сценарий — те же события');
  assert.deepEqual(T.apply_scenario(evs, undefined, ctx), evs);
});

test('TST-34 ADV apply_scenario: add_flow once (знак → kind, tag, reserve_id) и rule (вхождения в окне as_of…horizon_end с id scn:…) — гипотетические события', () => {
  const ctx = { as_of: P('2026-10-04'), horizon_end: P('2026-11-30'), calendars: [], default_account_id: 'acc', default_currency: 'EUR' };
  const once = T.apply_scenario([], { scenario_id: 'S1', ops: [{ op: 'add_flow', once: { date: '2026-10-20', amount_minor: -700, tag: 'ремонт', reserve_id: 'R1' } }] }, ctx);
  assert.deepEqual(once.map((e) => [e.cash_event_id, e.layer, e.kind, e.amount_minor, e.tag, e.reserve_id, e.scenario_id]), [['scn:S1:1', 'hypothetical', 'expense', -700, 'ремонт', 'R1', 'S1']]);
  const rule = { rule_id: 'RX', kind: 'expense', amount: { exp_minor: -1000 }, currency: 'EUR', freq: 'M', interval: 1, start_date: '2026-01-15', month_end: 'clamp', weekend: 'keep', calendar_id: null, exdates: [], is_obligation: false, is_estimate: false, tag: 'подписка' };
  const r = T.apply_scenario([], { scenario_id: 'S2', ops: [{ op: 'add_flow', rule }] }, ctx);
  assert.deepEqual(r.map((e) => [e.cash_event_id, fmt(e.date), e.amount_minor]), [['scn:S2:1:RX@2026-10-15', '2026-10-15', -1000], ['scn:S2:1:RX@2026-11-15', '2026-11-15', -1000]]);
  assert.ok(r.every((e) => e.layer === 'hypothetical' && e.rule_id === 'RX'));
});

// ═══ объяснение «почему» (IDEA-29, C-007, C-097, TV5) ═══════════════════════════════════════════════════════════════════

test('TST-32 §9.8 ADV explain G-001 worse: точка 183000 (11-14), пик 400000 (10-04), out_total 217000; цепочка аренда 4147 → продукты 2765 (Σ 6912) → налог 2304 (Σ 9217, стоп); контрфакты 273000 / 243000 / 233000, доход без задержки 205500', () => {
  const a = run_g(G001);
  const ex = T.explain_narrowest(a.events.worse, a.series.worse, a.params);
  assert.deepEqual([ex.point.amount_minor, fmt(ex.point.date), ex.peak.amount_minor, fmt(ex.peak.date), ex.out_total_minor, ex.inflow_offset_minor], [183000, '2026-11-14', 400000, '2026-10-04', 217000, 0]);
  assert.deepEqual(ex.chain.map((c) => [c.group, c.amount_minor, c.share_bp, c.cum_bp, c.count]), [['R-RENT', 90000, 4147, 4147, 1], ['R-GROC', 60000, 2765, 6912, 6], ['tag:налог', 50000, 2304, 9217, 1]]);
  const cf = ex.counterfactuals.map((c) => [c.kind, c.group ?? c.event_id, c.new_min.amount_minor, fmt(c.new_min.date), c.delta_minor]);
  assert.deepEqual(cf, [['without', 'R-RENT', 273000, '2026-11-14', 90000], ['without', 'R-GROC', 243000, '2026-11-09', 60000], ['without', 'tag:налог', 233000, '2026-11-14', 50000], ['no_delay', 'S-HOURLY@2026-11-05', 205500, '2026-10-31', 22500]]);
  assert.equal(ex.peak.amount_minor - ex.point.amount_minor, ex.out_total_minor - ex.inflow_offset_minor);
});

test('TST-32 ADV explain: полная цепочка (cutoff 10000, top_k большой) даёт Σ вкладов = out_total, а с пиком/точкой: Σ вкладов − приходы окна = peak − point; ничьи сумм — по ключу группы; стоп по top_k', () => {
  const evs = [
    ev_of('a', 1, -300, { rule_id: 'B' }), ev_of('b', 2, -300, { rule_id: 'A' }), ev_of('c', 3, -500, { rule_id: 'C' }), ev_of('d', 4, -100, { tag: 'мелочь' }),
    ev_of('i', 2, 250, { rule_id: 'IN' }),
  ];
  const s = T.project(evs, 2000, 0, 6);
  const ex = T.explain_narrowest(evs, s, { 'explain.top_k': 10, 'explain.share_cutoff_bp': 10000 });
  // пик 2000 (opening), точка: d4 — 2000 −300 −300 +250 −500 −100 = 1050
  assert.deepEqual([ex.point.amount_minor, ex.peak.amount_minor], [1050, 2000]);
  assert.deepEqual(ex.chain.map((c) => [c.group, c.amount_minor]), [['C', 500], ['A', 300], ['B', 300], ['tag:мелочь', 100]], 'ничья 300/300: A раньше B');
  assert.equal(ex.chain.reduce((a, c) => a + c.amount_minor, 0), ex.out_total_minor);
  assert.equal(ex.out_total_minor, 1200);
  assert.equal(ex.inflow_offset_minor, 250);
  assert.equal(ex.out_total_minor - ex.inflow_offset_minor, ex.peak.amount_minor - ex.point.amount_minor);
  assert.equal(ex.chain.at(-1).cum_bp, 10000);
  const k2 = T.explain_narrowest(evs, s, { 'explain.top_k': 2, 'explain.share_cutoff_bp': 10000 });
  assert.equal(k2.chain.length, 2);
  assert.equal(k2.counterfactuals.filter((c) => c.kind === 'without').length, 2);
});

test('TST-32 ADV explain: узкая точка в день 0 без расходов в окне — out_total 0, цепочка пуста, point = opening; приход после точки не входит в offset', () => {
  const evs = [ev_of('i', 2, 900)];
  const s = T.project(evs, 500, 0, 4);
  const ex = T.explain_narrowest(evs, s, {});
  assert.deepEqual([ex.point, ex.peak.amount_minor, ex.out_total_minor, ex.inflow_offset_minor, ex.chain], [{ date: 0, amount_minor: 500 }, 500, 0, 0, []]);
});

test('TST-32 ADV explain: свойства на случайных рядах — peak − point = out_total − inflow_offset; пик = max(opening, close до точки); доли = round_half_even(10000·сумма/out_total); накопленная доля неубывает; контрфакты «без группы» не ухудшают минимум', () => {
  const rng = make_rng(32);
  for (let it = 0; it < 400; it++) {
    const N = rng.int(1, 40);
    const evs = [];
    for (let i = 0; i < rng.int(0, 25); i++) {
      const inc = rng.next() < 0.3;
      const d = rng.int(0, N - 1);
      const e = ev_of('e' + i, d, (inc ? 1 : -1) * rng.int(1, 5000), { plan_date: Math.max(0, d - (inc && rng.bool() ? rng.int(0, 14) : 0)) });
      if (!inc && rng.bool()) e.rule_id = 'R' + rng.int(1, 4);
      evs.push(e);
    }
    const opening = rng.int(-3000, 20000);
    const s = T.project(evs, opening, 0, N - 1);
    const params = { 'explain.top_k': rng.int(1, 12), 'explain.share_cutoff_bp': rng.pick([5000, 9000, 10000]) };
    const ex = T.explain_narrowest(evs, s, params);
    assert.equal(ex.peak.amount_minor - ex.point.amount_minor, ex.out_total_minor - ex.inflow_offset_minor, `it ${it}`);
    const k = ex.point.date;
    assert.equal(ex.peak.amount_minor, Math.max(opening, ...s.close.slice(0, k)));
    let prev = 0;
    for (const c of ex.chain) {
      assert.equal(c.share_bp, Number(M.mul_div(c.amount_minor, 10000, ex.out_total_minor, 'half_even')));
      assert.ok(c.cum_bp >= prev);
      prev = c.cum_bp;
    }
    assert.ok(ex.chain.length <= params['explain.top_k']);
    for (const c of ex.counterfactuals) assert.ok(c.delta_minor >= 0, `it ${it}: контрфакт улучшает минимум`);
  }
});

// ═══ пороги и подсказки по истории (D-03, X1, X6, C-022) ═══════════════════════════════════════════════════════════════════

const fact = (id, date, amt, o = {}) => ({ event_id: id, account_id: 'acc', date, amount_minor: amt, currency: 'EUR', kind: amt < 0 ? 'expense' : 'income', ...o });
const hist = (facts, extra = {}) => mkws({ extra: { facts, ...extra } });

test('TST-02 X6 C-022 ADV outflow_90: окно [as_of−90, as_of); исключены доходы, переводы, ноги обмена, налоговые платежи (резерв kind = tax), is_exceptional; платёж в sinking-резерв входит', () => {
  const facts = [
    fact('in1', '2026-07-06', -10000), fact('out1', '2026-07-05', -99999), fact('as_of', '2026-10-04', -88888), fact('in2', '2026-10-03', -20000),
    fact('inc', '2026-09-01', 50000), fact('tr', '2026-09-02', -5000, { transfer_id: 'T' }), fact('fx', '2026-09-03', -5000, { fx: { num: 1, den: 1 } }),
    fact('exc', '2026-09-04', -7000, { is_exceptional: true }), fact('tax', '2026-09-05', -4000, { reserve_id: 'RT' }), fact('sink', '2026-09-06', -3000, { reserve_id: 'RS' }),
  ];
  const ws = hist(facts, { reserves: [{ reserve_id: 'RT', kind: 'tax', currency: 'EUR' }, { reserve_id: 'RS', kind: 'sinking', mode: 'fixed', fixed_minor: 1, currency: 'EUR' }] });
  assert.equal(T.outflow_90(ws, '2026-10-04'), 10000 + 20000 + 3000);
  assert.equal(T.buffer_hint(ws, '2026-10-04'), 2567, 'round_half_even(7·33000/90) = 2566,67 → 2567');
  assert.equal(T.default_wave_threshold(ws, '2026-10-04'), 3000, 'max(3000, 110)');
});

test('TST-02 X1 ADV default_wave_threshold: нет истории — 30·10^exp (EUR 3000, JPY 30); большие расходы — round_half_even(Σ/300): 1000000 → 3333, 1000050 (ничья .5) → 3334, 999750 (ничья .5) → 3332; buffer_hint без истории — null', () => {
  assert.equal(T.outflow_90(hist([]), '2026-10-04'), null);
  assert.equal(T.buffer_hint(hist([]), '2026-10-04'), null);
  assert.equal(T.default_wave_threshold(hist([]), '2026-10-04'), 3000);
  const th = (sum) => T.default_wave_threshold(hist([fact('f', '2026-09-01', -sum)]), '2026-10-04');
  assert.deepEqual([th(1000000), th(1000050), th(999750), th(1000150)], [3333, 3334, 3332, 3334]);
  const jpy = { decision_currency: 'JPY', params: {}, accounts: [{ account_id: 'j', kind: 'bank', liquidity: 'operating', currency: 'JPY' }], anchors: [], facts: [] };
  assert.equal(T.default_wave_threshold(jpy, '2026-10-04'), 30, 'JPY без дробной части: 30·10^0');
  assert.equal(T.default_wave_threshold({ ...jpy, facts: [{ event_id: 'f', account_id: 'j', date: '2026-09-01', amount_minor: -10000, currency: 'JPY', kind: 'expense' }] }, '2026-10-04'), 33, 'round(10000/300) = 33 > 30');
});

test('TST-02 X6 ADV outflow_90: расход в чужой валюте переводится в валюту решения по spot (10000 $ × 0,9250 = 9250 €)', () => {
  const ws = mkfx({ rates: [rate('USD', 'EUR', 9250, 10000)] });
  ws.facts = [{ event_id: 'u', account_id: 'usd', date: '2026-09-01', amount_minor: -10000, currency: 'USD', kind: 'expense' }];
  assert.equal(T.outflow_90(ws, '2026-10-04'), 9250);
});

// ═══ AFFORD: границы и синтетические ряды (D-11, D-12, C-015, C-017, C-019, TV-6) ═══════════════════════════════════════

test('TST-35 C-015 ADV afford TV-6: free = [100, 40, 120, 120], B = 50, D = 2 — baseline_below_buffer: S_max = 0 (вместо 70), earliest = null, для S = 10 вердикт НЕ OK (plan: TIGHT)', () => {
  const ctx = mkctx([100, 40, 120, 120], [100, 40, 120, 120], { B: 50 });
  assert.equal(A.max_amount(ctx, 2, 50, 'plan'), 0);
  assert.equal(A.max_amount(ctx, 2, 50, 'worse'), 0);
  assert.equal(A.earliest_date(ctx, 10, 0, 50, 'plan'), null);
  const c = A.check_purchase(ctx, { currency: 'EUR', parts: [{ date: 2, amount_minor: 10 }] }, 50);
  assert.equal(c.verdict, 'TIGHT');
  assert.deepEqual([c.flags.baseline_below_buffer, c.s_max.plan, c.s_max.worse, c.earliest.plan, c.earliest.worse], [true, 0, 0, null, null]);
  assert.deepEqual([c.by_mode.plan.m_after, c.by_mode.plan.at], [40, 1]);
});

test('TST-35 ADV afford: горизонт из одного дня (N = 1) — S_max = free − B, вердикты OK / FRAGILE / TIGHT / NO на границах, earliest = as_of, sts = max(0, free − B)', () => {
  const ctx = mkctx([500], [300], { B: 100 });
  const v = (S) => A.check_purchase(ctx, { currency: 'EUR', parts: [{ date: 0, amount_minor: S }] }, 100);
  assert.deepEqual([A.max_amount(ctx, 0, 100, 'plan'), A.max_amount(ctx, 0, 100, 'worse')], [400, 200]);
  assert.deepEqual([200, 201, 400, 401, 500, 501].map((S) => v(S).verdict), ['OK', 'FRAGILE', 'FRAGILE', 'TIGHT', 'TIGHT', 'NO']);
  assert.equal(A.earliest_date(ctx, 200, 0, 100, 'worse'), 0);
  assert.equal(A.earliest_date(ctx, 201, 0, 100, 'worse'), null);
  assert.deepEqual(A.safe_to_spend(ctx, 0, 100, 'worse'), { sts: 200, short_to_buffer: 0, at: 0, min_free: 300, sts_horizon: 200 });
});

test('TST-35 D-11 ADV afford: B = 0 — класс TIGHT недостижим (m_plan < 0 ⇒ NO); границы m_after = 0 → OK при буфере 0; max_amount при B = 0 = min free после D', () => {
  const ctx = mkctx([100, 50, 80], [100, 40, 80], { B: 0 });
  const v = (S) => A.check_purchase(ctx, { currency: 'EUR', parts: [{ date: 1, amount_minor: S }] }, 0).verdict;
  assert.deepEqual([40, 41, 50, 51].map(v), ['OK', 'FRAGILE', 'FRAGILE', 'NO']);
  assert.deepEqual([A.max_amount(ctx, 1, 0, 'plan'), A.max_amount(ctx, 1, 0, 'worse')], [50, 40]);
});

test('TST-35 C-017 ADV check_purchase: часть позже horizon_end отбрасывается (W_PART_BEYOND_HORIZON) и суммируется в beyond_horizon_minor; прошлая дата зажимается (W_DATE_CLAMPED); все части за горизонтом — outside_horizon', () => {
  const ctx = mkctx([1000, 1000, 1000, 1000], [900, 900, 900, 900], { B: 100 });
  const c = A.check_purchase(ctx, { currency: 'EUR', parts: [{ date: -3, amount_minor: 100 }, { date: 2, amount_minor: 200 }, { date: 9, amount_minor: 700 }, { date: 4, amount_minor: 50 }] }, 100);
  assert.equal(c.kind, 'ok');
  assert.equal(c.beyond_horizon_minor, 750, 'части с датой 9 и 4 за горизонтом (horizon_end = 3)');
  assert.deepEqual(c.warnings.map((w) => [w.code, w.part]), [['W_DATE_CLAMPED', 0], ['W_PART_BEYOND_HORIZON', 2], ['W_PART_BEYOND_HORIZON', 3]]);
  assert.equal(c.by_mode.plan.m_after, 1000 - 300, 'в горизонте учтены 100 (зажата на as_of) + 200');
  assert.equal(c.s_max, null, 'несколько частей: s_max и earliest — null (v1)');
  assert.equal(c.earliest, null);
  assert.deepEqual(A.check_purchase(ctx, { currency: 'EUR', parts: [{ date: 9, amount_minor: 5 }] }, 100), { kind: 'outside_horizon', horizon_end: 3 });
});

test('TST-35 ADV check_purchase: ошибки ввода — сумма ≤ 0 (E_SCHEMA), нецелая (E_NOT_INTEGER), нет частей (E_SCHEMA), чужая валюта (E_CURRENCY_MISMATCH); две части в один день суммируются; порядок частей не важен', () => {
  const ctx = mkctx([1000, 1000, 1000], [900, 900, 900], { B: 100 });
  const chk = (parts, cur = 'EUR') => A.check_purchase(ctx, { currency: cur, parts }, 100);
  throws_code(() => chk([{ date: 1, amount_minor: 0 }]), 'E_SCHEMA');
  throws_code(() => chk([{ date: 1, amount_minor: -5 }]), 'E_SCHEMA');
  throws_code(() => chk([{ date: 1, amount_minor: 5.5 }]), 'E_NOT_INTEGER');
  throws_code(() => chk([]), 'E_SCHEMA');
  throws_code(() => chk([{ date: 1, amount_minor: 5 }], 'USD'), 'E_CURRENCY_MISMATCH');
  const x = chk([{ date: 1, amount_minor: 100 }, { date: 1, amount_minor: 150 }, { date: 2, amount_minor: 50 }]);
  const y = chk([{ date: 2, amount_minor: 50 }, { date: 1, amount_minor: 150 }, { date: 1, amount_minor: 100 }]);
  assert.deepEqual(x, y);
  assert.equal(x.by_mode.plan.m_after, 1000 - 300);
  assert.equal(x.by_mode.plan.delta, 300, 'delta ≤ Σ amount');
});

test('TST-35 D-11 ADV afford: ровно на границе — S_max_worse → OK (margin_worse = 0), +1 → FRAGILE; m_after_plan = B → FRAGILE, B − 1 → TIGHT; m_plan = 0 → TIGHT, −1 → NO (ALG-04 «Граничные случаи»)', () => {
  const ctx = mkctx([300, 300, 300], [250, 250, 250], { B: 100 });
  const v = (S) => A.check_purchase(ctx, { currency: 'EUR', parts: [{ date: 0, amount_minor: S }] }, 100);
  assert.deepEqual([v(150).verdict, v(150).by_mode.worse.margin], ['OK', 0]);
  assert.equal(v(151).verdict, 'FRAGILE');
  assert.deepEqual([v(200).verdict, v(200).by_mode.plan.margin], ['FRAGILE', 0]);
  assert.equal(v(201).verdict, 'TIGHT');
  assert.equal(v(300).verdict, 'TIGHT');
  assert.equal(v(301).verdict, 'NO');
  assert.equal(v(301).flags.worse_gap, true);
});

test('TST-35 D-11 ADV afford: свойство на случайных рядах — вердикт ⇔ S_max_worse / S_max_plan / M_plan; монотонность по S; cash_gap = min(trough − cum) < 0; m_after = min(free − cum)', () => {
  const rng = make_rng(4242);
  for (let it = 0; it < 3000; it++) {
    const N = rng.int(1, 12);
    const fp = Array.from({ length: N }, () => rng.int(-50, 150));
    const fw = fp.map((x) => x - rng.int(0, 40));
    const tp = fp.map((x) => x + rng.int(0, 30));
    const tw = fw.map((x, i) => Math.min(x + rng.int(0, 30), tp[i]));
    const B = rng.int(0, 60);
    const d = rng.int(0, N - 1);
    const S_ = rng.int(1, 160);
    const ctx = mkctx(fp, fw, { tp, tw, B });
    const c = A.check_purchase(ctx, { currency: 'EUR', parts: [{ date: d, amount_minor: S_ }] }, B);
    const Mp = Math.min(...fp.slice(d));
    const smp = A.max_amount(ctx, d, B, 'plan');
    const smw = A.max_amount(ctx, d, B, 'worse');
    assert.equal(smp, Math.min(...fp) < B ? 0 : Math.max(0, Mp - B), `it ${it}: S_max plan`);
    assert.equal(smw, Math.min(...fw) < B ? 0 : Math.max(0, Math.min(...fw.slice(d)) - B), `it ${it}: S_max worse`);
    const pre = d === 0 ? Infinity : Math.min(...fp.slice(0, d));
    const exp = S_ <= smw ? 'OK' : S_ <= smp ? 'FRAGILE' : S_ <= Mp && pre >= 0 ? 'TIGHT' : 'NO';
    assert.equal(c.verdict, exp, `it ${it}: ${JSON.stringify({ fp, fw, B, d, S: S_, smp, smw })}`);
    assert.equal(c.by_mode.plan.m_after, Math.min(...fp.map((x, i) => x - (i >= d ? S_ : 0))));
    assert.equal(c.by_mode.worse.cash_gap, tw.some((x, i) => x - (i >= d ? S_ : 0) < 0));
    // монотонность: больший S не улучшает вердикт
    const rank = { OK: 0, FRAGILE: 1, TIGHT: 2, NO: 3 };
    const bigger = A.check_purchase(ctx, { currency: 'EUR', parts: [{ date: d, amount_minor: S_ + rng.int(1, 40) }] }, B);
    assert.ok(rank[bigger.verdict] >= rank[c.verdict], `it ${it}: монотонность по S`);
    // earliest согласован с check_purchase
    for (const m of ['plan', 'worse']) {
      const e = A.earliest_date(ctx, S_, 0, B, m);
      if (e !== null) assert.ok(A.check_purchase(ctx, { currency: 'EUR', parts: [{ date: e, amount_minor: S_ }] }, B).by_mode[m].m_after >= B, `it ${it}: earliest безопасна`);
    }
  }
});

test('TST-35 D-11 ADV earliest_date/max_amount: not_before позже as_of сдвигает нижнюю границу; D раньше as_of — на as_of; D за горизонтом — null; S ≤ 0 и нехватка буфера — E_SCHEMA', () => {
  const ctx = mkctx([100, 200, 300, 300], [100, 200, 300, 300], { B: 0 });
  assert.equal(A.earliest_date(ctx, 150, 0, 0, 'plan'), 1);
  assert.equal(A.earliest_date(ctx, 150, 3, 0, 'plan'), 3, 'not_before = 3');
  assert.equal(A.earliest_date(ctx, 150, -9, 0, 'plan'), 1, 'раньше as_of — с as_of');
  assert.equal(A.earliest_date(ctx, 150, 7, 0, 'plan'), null, 'not_before за горизонтом');
  assert.equal(A.max_amount(ctx, -5, 0, 'plan'), 100, 'D в прошлом — на as_of: min free с as_of = 100');
  assert.equal(A.max_amount(ctx, 4, 0, 'plan'), null);
  throws_code(() => A.earliest_date(ctx, 0, 0, 0, 'plan'), 'E_SCHEMA');
  throws_code(() => A.earliest_date(ctx, 5, 0, null, 'plan'), 'E_SCHEMA');
  throws_code(() => A.max_amount(ctx, 1, -1, 'plan'), 'E_SCHEMA');
});

test('TST-39 D-12 ADV safe_to_spend: T до as_of — E_BAD_DATE; T позже горизонта зажимается с W_T_CLAMPED (поле только когда оно есть); ровно на буфере — sts 0 и short 0; ниже — short_to_buffer = B − min free; at — первая дата', () => {
  const ctx = mkctx([300, 100, 100, 400], [300, 100, 100, 400], { B: 100 });
  throws_code(() => A.safe_to_spend(ctx, -1, 100, 'plan'), 'E_BAD_DATE');
  const clamp = A.safe_to_spend(ctx, 10, 100, 'plan');
  assert.deepEqual(clamp.warnings, [{ code: 'W_T_CLAMPED' }]);
  assert.equal('warnings' in A.safe_to_spend(ctx, 3, 100, 'plan'), false);
  assert.deepEqual(A.safe_to_spend(ctx, 3, 100, 'plan'), { sts: 0, short_to_buffer: 0, at: 1, min_free: 100, sts_horizon: 0 });
  const low = mkctx([300, 70, 100], [300, 70, 100], { B: 100 });
  assert.deepEqual(A.safe_to_spend(low, 2, 100, 'plan'), { sts: 0, short_to_buffer: 30, at: 1, min_free: 70, sts_horizon: 0 });
  assert.equal(A.safe_to_spend(low, 0, 100, 'plan').sts, 200, 'T = as_of: окно из одного дня');
  assert.equal(A.safe_to_spend(low, '1970-01-01', 100, 'plan').sts, 200, 'ISO-дата');
});

test('TST-39 D-12 C-019 ADV safe_to_spend: STS(horizon_end) = S_max(as_of) в обоих режимах; STS не возрастает с ростом T (случайные ряды)', () => {
  const rng = make_rng(39);
  for (let it = 0; it < 500; it++) {
    const N = rng.int(1, 15);
    const fp = Array.from({ length: N }, () => rng.int(-30, 200));
    const fw = fp.map((x) => x - rng.int(0, 50));
    const B = rng.int(0, 80);
    const ctx = mkctx(fp, fw, { B });
    for (const m of ['plan', 'worse']) {
      assert.equal(A.safe_to_spend(ctx, N - 1, B, m).sts, A.max_amount(ctx, 0, B, m), `it ${it} ${m}`);
      let prev = Infinity;
      for (let t = 0; t < N; t++) {
        const r = A.safe_to_spend(ctx, t, B, m);
        assert.ok(r.sts <= prev);
        assert.equal(r.sts_horizon, A.max_amount(ctx, 0, B, m));
        prev = r.sts;
      }
    }
  }
});

test('TST-39 D-12 ADV default_sts_horizon: ближайший ожидаемый доход (planned, expected/overdue, не раньше as_of); matched, гипотетические и расходы не считаются; нет — min(as_of + 30, horizon_end)', () => {
  const evs = [
    { layer: 'planned', kind: 'income', amount_minor: 5, status: 'matched', date: 3 }, { layer: 'hypothetical', kind: 'income', amount_minor: 5, date: 2 },
    { layer: 'planned', kind: 'expense', amount_minor: -5, status: 'expected', date: 1 }, { layer: 'planned', kind: 'income', amount_minor: 5, status: 'overdue', date: 9 },
    { layer: 'planned', kind: 'income', amount_minor: 5, status: 'expected', date: 7 }, { layer: 'planned', kind: 'income', amount_minor: 5, status: 'expected', date: -2 },
  ];
  const ctx = { ...mkctx(Array(60).fill(1), Array(60).fill(1)), as_of: 0, horizon_end: 59, events: { plan: evs, worse: evs } };
  assert.equal(A.default_sts_horizon(ctx), 7);
  assert.equal(A.default_sts_horizon({ ...ctx, events: { plan: [], worse: [] } }), 30);
  assert.equal(A.default_sts_horizon({ ...ctx, horizon_end: 10, events: { plan: [], worse: [] } }), 10, 'min(as_of + 30, horizon_end)');
  assert.equal(A.default_sts_horizon(ctx, 8), 9, 'as_of аргументом: доходы раньше 8 не учитываются');
});

test('TST-08 §9.9 ADV afford G-001-low: любая покупка S > 0 — NO, S_max = 0, earliest = null («в горизонте нет»), STS = 0 и «до буфера не хватает» 136500 / 159000', () => {
  const a = run_g(LOW);
  const c = A.check_purchase(a, { currency: 'EUR', parts: [{ date: '2026-10-12', amount_minor: 1 }] });
  assert.equal(c.verdict, 'NO');
  assert.deepEqual([c.s_max.plan, c.s_max.worse, c.earliest.plan, c.earliest.worse], [0, 0, null, null]);
  const sts = (m) => A.safe_to_spend(a, '2026-11-30', null, m);
  assert.deepEqual([sts('plan').sts, sts('plan').short_to_buffer, sts('worse').sts, sts('worse').short_to_buffer], [0, 136500, 0, 159000]);
  assert.deepEqual([fmt(sts('plan').at), fmt(sts('worse').at)], ['2026-11-01', '2026-11-14']);
});

test('TST-39 §9.9 C-058 ADV afford G-001-late: STS(11-19) = 43500 / 21000, но sts_horizon = 0 (min free на горизонте −77800 в 11-28), short_to_buffer 127800, baseline_below_buffer — вердикт OK невозможен', () => {
  const a = run_g(LATE);
  const t1119 = (m) => A.safe_to_spend(a, '2026-11-19', null, m);
  assert.deepEqual([t1119('plan').sts, t1119('worse').sts, t1119('worse').sts_horizon, t1119('worse').min_free, fmt(t1119('worse').at)], [43500, 21000, 0, 71000, '2026-11-14']);
  const h = A.safe_to_spend(a, '2026-11-30', null, 'worse');
  assert.deepEqual([h.sts, h.short_to_buffer, h.min_free, fmt(h.at)], [0, 127800, -77800, '2026-11-28']);
  const c = A.check_purchase(a, { currency: 'EUR', parts: [{ date: '2026-10-12', amount_minor: 1 }] });
  assert.equal(c.flags.baseline_below_buffer, true);
  assert.notEqual(c.verdict, 'OK');
  assert.deepEqual([c.s_max.plan, c.s_max.worse, c.earliest.worse], [0, 0, null]);
});

test('TST-35 §9.6 ADV afford G-001: дорожка — границы по сумме на 10-12 (OK ≤ 21000, FRAGILE 21001…43500, TIGHT 43501…93500, NO ≥ 93501); опорное событие — задержанный доход S-HOURLY', () => {
  const a = run_g(G001);
  const v = (S_) => A.check_purchase(a, { currency: 'EUR', parts: [{ date: '2026-10-12', amount_minor: S_ }] });
  assert.deepEqual([15000, 21000, 21001, 30000, 43500, 43501, 60000, 93500, 93501, 120000].map((S_) => v(S_).verdict),
    ['OK', 'OK', 'FRAGILE', 'FRAGILE', 'FRAGILE', 'TIGHT', 'TIGHT', 'TIGHT', 'NO', 'NO']);
  const c = v(30000);
  assert.deepEqual([c.by_mode.plan.m_after, c.by_mode.worse.m_after, c.by_mode.worse.margin, c.by_mode.plan.delta, c.by_mode.worse.cash_gap], [63500, 41000, -9000, 30000, false]);
  assert.deepEqual(c.culprit_event_ids, ['S-HOURLY@2026-11-05']);
  assert.deepEqual([c.s_max.plan, c.s_max.worse], [43500, 21000]);
  assert.deepEqual([fmt(c.earliest.plan), fmt(c.earliest.worse)], ['2026-10-04', '2026-11-20']);
  assert.equal(v(93500).flags.worse_gap, true);
});

test('TST-39 REQ-057 ADV sts_breakdown: Σ v = min free − B для всех T, режимов и датасетов G-001 (low / gap / late); строки opening … buffer в каноническом составе', () => {
  for (const ws of [G001, LOW, GAP, LATE]) {
    const a = run_g(ws);
    for (const m of ['plan', 'worse']) {
      for (const d of ['2026-10-04', '2026-10-12', '2026-10-23', '2026-10-31', '2026-11-01', '2026-11-05', '2026-11-19', '2026-11-30']) {
        const bd = A.sts_breakdown(a, d, a.buffer_minor, m);
        const f = a.series[m].free;
        const t = P(d) - a.as_of;
        const mn = Math.min(...f.slice(0, t + 1));
        assert.equal(bd.reduce((s, x) => s + x.v, 0), mn - a.buffer_minor, `${ws.name} ${m} ${d}`);
        assert.deepEqual(bd.map((x) => x.id), ['opening', 'reserves_start', 'payments', 'incomes', 'released', 'reserve_adds', 'buffer']);
      }
    }
  }
});

// ═══ детерминизм и чистота (ADR-001, ADR-005) ═══════════════════════════════════════════════════════════════════════════

test('TST-33 ADV analyze чист: вход не мутируется, повтор даёт побайтно тот же результат (G-001 и мультивалютная область), порядок записей в массивах вход-независим для рядов', () => {
  for (const ws of [clone(G001), mkfx({ plans: [{ id: 'u1', account_id: 'usd', currency: 'USD', date: day(3), amount_minor: -777 }] })]) {
    const before = JSON.stringify(ws);
    const q = { as_of: ws.as_of ?? '2026-10-04' };
    const r1 = JSON.stringify(analyze(ws, q));
    const r2 = JSON.stringify(analyze(ws, q));
    assert.equal(r1, r2);
    assert.equal(JSON.stringify(ws), before, 'ws не изменён');
  }
  const shuffled = clone(G001);
  shuffled.facts.reverse();
  shuffled.rules.reverse();
  shuffled.plans.reverse();
  const a = run_g(G001);
  const b = run_g(shuffled);
  assert.deepEqual(b.series, a.series);
  assert.equal(b.inputs_hash, a.inputs_hash, 'inputs_hash не зависит от порядка записей множеств');
});

// ═══ границы окна и сопоставление с фактом (D-04, D-06, D-22, C-004) ═══════════════════════════════════════════════════

test('TST-31 C-004 ADV build_events: план до даты якоря — вне потока, на дату якоря — внутри (считается на as_of), на as_of и horizon_end — внутри, за horizon_end — нет; posted после якоря входит в opening', () => {
  const ws = mkws({
    opening: 100000, as_of: '2026-10-04', anchor_date: '2026-10-01', params: { horizon_days: 30 },
    plans: [
      { id: 'p0', date: '2026-09-30', amount_minor: -111 }, { id: 'p1', date: '2026-10-01', amount_minor: -222 }, { id: 'p2', date: '2026-10-04', amount_minor: -333 },
      { id: 'p3', date: day(30), amount_minor: -444 }, { id: 'p4', date: day(31), amount_minor: -555 },
    ],
    extra: { facts: [
      { event_id: 'f0', account_id: 'acc', date: '2026-10-01', amount_minor: -9999, currency: 'EUR', kind: 'expense' },
      { event_id: 'f1', account_id: 'acc', date: '2026-10-04', amount_minor: 1000, currency: 'EUR', kind: 'income' },
    ] },
  });
  const a = analyze(ws, { as_of: '2026-10-04' });
  assert.equal(a.series.plan.opening_minor, 101000, 'якорь 100000 включает факт дня якоря; факт 10-04 (+1000) добавляется');
  assert.deepEqual(a.events.plan.map((e) => [e.cash_event_id, fmt(e.date), fmt(e.plan_date), e.status]), [
    ['p2', '2026-10-04', '2026-10-04', 'expected'], ['p1', '2026-10-04', '2026-10-01', 'overdue'], ['p3', '2026-11-03', '2026-11-03', 'expected'],
  ]);
  assert.equal(a.series.plan.trough[0], 101000 - 333 - 222);
  assert.equal(a.series.plan.trough[30], 101000 - 333 - 222 - 444);
  assert.equal(a.series.plan.close.length, 31);
});

test('TST-31 D-06 ADV build_events: окно сопоставления ±3 дня включительно (разница 3 — matched, 4 — нет), допуск 5 % включительно (94500 — matched), 95000 — «возможный двойник» (план остаётся), 100000 — не сопоставлен', () => {
  const run_m = (plan_date, fact_date, fact_amt) => {
    const ws = mkws({
      opening: 100000, as_of: '2026-10-10', anchor_date: '2026-10-01', params: { horizon_days: 10 },
      plans: [{ id: 'rent', date: plan_date, amount_minor: -90000, is_obligation: true }],
      extra: { facts: [{ event_id: 'f', account_id: 'acc', date: fact_date, amount_minor: fact_amt, currency: 'EUR', kind: 'expense' }] },
    });
    const a = analyze(ws, { as_of: '2026-10-10' });
    return { n: a.events.plan.length, opening: a.series.plan.opening_minor };
  };
  assert.deepEqual(run_m('2026-10-02', '2026-10-05', -90000), { n: 0, opening: 10000 }, 'разница 3 дня');
  assert.deepEqual(run_m('2026-10-02', '2026-10-06', -90000), { n: 1, opening: 10000 }, 'разница 4 дня — не сопоставлен: план остаётся, факт уже в opening');
  assert.deepEqual(run_m('2026-10-02', '2026-10-01', -90000), { n: 0, opening: 100000 }, 'факт в день якоря (= в якоре); окно −1 день: matched, план исключён');
  assert.deepEqual(run_m('2026-10-02', '2026-10-03', -94500), { n: 0, opening: 5500 });
  assert.deepEqual(run_m('2026-10-02', '2026-10-03', -95000), { n: 1, opening: 5000 }, 'двойник: учитываются оба');
  assert.deepEqual(run_m('2026-10-02', '2026-10-03', -100000), { n: 1, opening: 0 });
});

test('TST-31 D-06 ADV build_events: частичный факт по подтверждённой связи (plan_ref) — остаётся остаток плана: план −10000, факт −4000 → событие −6000; суммарный отток 10000', () => {
  const ws = mkws({
    opening: 100000, as_of: '2026-10-04', anchor_date: '2026-10-01', params: { horizon_days: 10 }, plans: [{ id: 'rent2', date: '2026-10-02', amount_minor: -10000 }],
    extra: { facts: [{ event_id: 'f', account_id: 'acc', date: '2026-10-03', amount_minor: -4000, currency: 'EUR', kind: 'expense', plan_ref: 'rent2' }] },
  });
  const a = analyze(ws, { as_of: '2026-10-04' });
  assert.deepEqual(a.events.plan.map((e) => [e.cash_event_id, e.amount_minor]), [['rent2', -6000]]);
  assert.equal(a.series.plan.opening_minor, 96000);
  assert.equal(a.series.plan.close[0], 90000);
});

test('TST-31 D-06 ADV build_events: статусы skipped/cancelled/matched плановой записи — события нет; классы: расход (grace 0) просрочен на следующий день, доход (grace 3) — на пятый', () => {
  const ws = mkws({
    opening: 1000, as_of: '2026-10-10', anchor_date: '2026-10-01', params: { horizon_days: 5 },
    plans: [
      { id: 'sk', date: '2026-10-12', amount_minor: -1, status: 'skipped' }, { id: 'ca', date: '2026-10-12', amount_minor: -1, status: 'cancelled' }, { id: 'ma', date: '2026-10-12', amount_minor: -1, status: 'matched' },
      { id: 'e0', date: '2026-10-10', amount_minor: -10 }, { id: 'e1', date: '2026-10-09', amount_minor: -10 },
      { id: 'i3', date: '2026-10-07', amount_minor: 10 }, { id: 'i4', date: '2026-10-06', amount_minor: 10 },
    ],
  });
  const st = Object.fromEntries(analyze(ws, { as_of: '2026-10-10' }).events.plan.map((e) => [e.cash_event_id, e.status]));
  assert.deepEqual(st, { e0: 'expected', e1: 'overdue', i3: 'expected', i4: 'overdue' });
});

// ═══ ГОТОВНОСТЬ (D-23): не зависит от горизонта показа ═════════════════════════════════════════════════════════════════════

test('TST-16 D-23 ADV readiness БАГ: «доход в ближайшие 45 дней» ищется только внутри horizon_days — при horizon_days = 30 доход на 40-й день не виден, готовность 3 вместо 4, гейт Q3 отказывает', () => {
  const plans = (inc_day) => [
    { id: 'o', date: day(3), amount_minor: -5000, is_obligation: true, tag: 'аренда' }, { id: 'e', date: day(4), amount_minor: -100, is_estimate: true, tag: 'еда' },
    { id: 'i', date: day(inc_day), amount_minor: 1000, tag: 'доход' },
  ];
  const r = (hz, d) => T.readiness(mkws({ params: { horizon_days: hz }, plans: plans(d) }), '2026-10-04');
  assert.equal(r(60, 40).score, 4, 'контроль: горизонт 60 — доход виден');
  assert.equal(r(60, 45).score, 4, 'день 45 — ещё «в ближайшие 45 дней»');
  assert.equal(r(60, 46).score, 3, 'день 46 — вне окна 45 дней');
  assert.equal(r(30, 40).score, 4, 'D-23: окно дохода — 45 дней и не зависит от horizon_days (получено ' + r(30, 40).score + ', причины: ' + r(30, 40).reasons + ')');
});

// ═══ резерв, привязанный к платежу (ALG-11 инв. 5) ════════════════════════════════════════════════════════════════════════════

test('TST-29 ALG-11 инв. 5 ADV analyze: платёж страховки −60000 на 2027-03-15, привязанный к RES-INS (накоплено 60000), не меняет free (trough и резерв падают на одну величину); освобождено 60000, true_up 0', () => {
  const ws = clone(G001);
  ws.params.horizon_days = 180;
  ws.plans.push({ plan_id: 'P-INS', account_id: 'acc_main', date: '2027-03-15', amount_minor: -60000, currency: 'EUR', kind: 'expense', tag: 'страховка', is_obligation: true, reserve_id: 'RES-INS' });
  const a = run_g(ws);
  const i = P('2027-03-15') - a.as_of;
  for (const m of ['plan', 'worse']) {
    const s = a.series[m];
    assert.equal(s.trough[i - 1] - s.trough[i], 60000, `${m}: физические деньги упали на 60000`);
    assert.equal(s.reserve_trough[i - 1] - s.reserve_trough[i], 60000, `${m}: резерв освободился на 60000`);
    assert.equal(s.free[i], s.free[i - 1], `${m}: free не изменился`);
    const b = a.reserve[m].by_reserve['RES-INS'];
    assert.deepEqual([b.released[i], b.true_up[i], b.close[i - 1], b.close[i]], [60000, 0, 60000, 0]);
  }
  assert.deepEqual(a.warnings, []);
});

test('TST-29 ALG-11 ADV analyze: платёж больше накопленного (страховка 70000 при накоплении 60000) — released 60000, true_up 10000 уходит из free', () => {
  const ws = clone(G001);
  ws.params.horizon_days = 180;
  ws.plans.push({ plan_id: 'P-INS', account_id: 'acc_main', date: '2027-03-15', amount_minor: -70000, currency: 'EUR', kind: 'expense', tag: 'страховка', is_obligation: true, reserve_id: 'RES-INS' });
  const a = run_g(ws);
  const i = P('2027-03-15') - a.as_of;
  const s = a.series.plan;
  assert.deepEqual([a.reserve.plan.by_reserve['RES-INS'].released[i], a.reserve.plan.by_reserve['RES-INS'].true_up[i]], [60000, 10000]);
  assert.equal(s.free[i - 1] - s.free[i], 10000);
});

test('TST-31 C-004 ADV build_events: окно плана — у КАЖДОГО operating-счёта своё (от его якоря включительно): счёт B с якорем 09-28 учитывает планы с 09-28, счёт A с якорем 10-04 — только с 10-04', () => {
  const plan = (id, acc, date, amt) => ({ plan_id: id, account_id: acc, currency: 'EUR', date, amount_minor: amt, kind: 'expense' });
  const ws = {
    decision_currency: 'EUR', params: { horizon_days: 10 },
    accounts: [{ account_id: 'A', kind: 'bank', liquidity: 'operating', currency: 'EUR' }, { account_id: 'B', kind: 'bank', liquidity: 'operating', currency: 'EUR' }],
    anchors: [{ anchor_id: 'a', account_id: 'A', date: '2026-10-04', amount_minor: 100000 }, { anchor_id: 'b', account_id: 'B', date: '2026-09-28', amount_minor: 50000 }],
    plans: [plan('pA1', 'A', '2026-10-01', -10), plan('pB1', 'B', '2026-09-27', -20), plan('pB2', 'B', '2026-09-28', -30), plan('pB3', 'B', '2026-09-30', -40), plan('pA2', 'A', '2026-10-04', -50)],
  };
  const a = analyze(ws, { as_of: '2026-10-04' });
  assert.equal(a.series.plan.opening_minor, 150000);
  assert.deepEqual(a.events.plan.map((e) => [e.cash_event_id, fmt(e.date)]), [['pA2', '2026-10-04'], ['pB3', '2026-10-04'], ['pB2', '2026-10-04']]);
  assert.equal(a.series.plan.trough[0], 150000 - 120);
  assert.equal(a.anchor_status.age, 6, 'возраст — по самому несвежему счёту B: 10-04 − 09-28');
});

test('TST-27 D-07 ADV БАГ build_events: перевод на накопительный счёт с ногами в РАЗНЫЕ дни (расход 11-03 = horizon_end, зачисление 11-04 за горизонтом) — расходная нога тихо исключается как «внутренний» перевод', () => {
  const ws = {
    decision_currency: 'EUR', params: { horizon_days: 30 },
    accounts: [{ account_id: 'acc', kind: 'bank', liquidity: 'operating', currency: 'EUR' }, { account_id: 'sav', kind: 'bank', liquidity: 'savings', currency: 'EUR' }],
    anchors: [{ anchor_id: 'a', account_id: 'acc', date: '2026-10-04', amount_minor: 500000 }],
    plans: [
      { plan_id: 'o', account_id: 'acc', currency: 'EUR', date: day(30), amount_minor: -100000, kind: 'transfer', transfer_id: 'T' },
      { plan_id: 'i', account_id: 'sav', currency: 'EUR', date: day(31), amount_minor: 100000, kind: 'transfer', transfer_id: 'T' },
    ],
  };
  const ev = T.build_events(ws, { as_of: '2026-10-04', horizon_days: 30, mode: 'plan' });
  assert.deepEqual(ev.map((e) => [e.cash_event_id, e.amount_minor]), [['o', -100000]], 'расходная нога должна остаться (деньги ушли из operating)');
  ws.plans[1].date = day(30);
  assert.equal(T.build_events(ws, { as_of: '2026-10-04', horizon_days: 30, mode: 'plan' }).length, 1, 'контроль: обе ноги в один день — расход остаётся');
});

test('TST-27 C-034 ADV analyze: остаток КАЖДОГО operating-счёта переводится отдельно (два USD-счёта по 5 центов при 0,9250: 5 + 5 = 10, а не округление суммы 9,25 → 9)', () => {
  const ws = mkfx({ anchors: [], rates: [rate('USD', 'EUR', 9250, 10000)] });
  ws.accounts = [{ account_id: 'acc', kind: 'bank', liquidity: 'operating', currency: 'EUR' }, { account_id: 'u1', kind: 'bank', liquidity: 'operating', currency: 'USD' }, { account_id: 'u2', kind: 'bank', liquidity: 'operating', currency: 'USD' }];
  ws.anchors = [{ anchor_id: 'a', account_id: 'acc', date: '2026-10-04', amount_minor: 0 }, { anchor_id: 'b', account_id: 'u1', date: '2026-10-04', amount_minor: 5 }, { anchor_id: 'c', account_id: 'u2', date: '2026-10-04', amount_minor: 5 }];
  assert.equal(analyze(ws, { as_of: '2026-10-04' }).series.plan.opening_minor, 10);
});

test('TST-27 C-029 ADV analyze: ws.params.rounding доходит до конвертации валют и до часов (ничья: курс 1/2: −1 $ → 0 / −1 / −1 / 0 для half_even / half_up / floor / ceil; выплата 2401 мин ×125 % → 120062 / 120063 / 120062 / 120063)', () => {
  const mk = (rounding) => ({
    decision_currency: 'EUR', params: { horizon_days: 14, rounding },
    accounts: [{ account_id: 'acc', kind: 'bank', liquidity: 'operating', currency: 'EUR' }, { account_id: 'u1', kind: 'bank', liquidity: 'operating', currency: 'USD' }],
    anchors: [{ anchor_id: 'a', account_id: 'acc', date: '2026-10-04', amount_minor: 100000 }, { anchor_id: 'b', account_id: 'u1', date: '2026-10-04', amount_minor: 5 }],
    rates: [rate('USD', 'EUR', 1, 2)],
    plans: [{ plan_id: 'x', account_id: 'u1', currency: 'USD', date: day(2), amount_minor: -1, kind: 'expense' }],
    streams: [{ stream_id: 'S', account_id: 'acc', name: 'W', currency: 'EUR', rate_minor: 3000, period: 'week', cutoff: { kind: 'weekday', weekday: 0 }, pay_lag_days: 0, weekend: 'keep', hours: { min_minutes: 2401, exp_minutes: 2401, max_minutes: 2401 }, overtime: { threshold_minutes: 2400, mult_bp: 12500 } }],
  });
  const got = ['half_even', 'half_up', 'floor', 'ceil'].map((r) => {
    const a = analyze(mk(r), { as_of: '2026-10-04' });
    return [a.events.plan.find((e) => e.cash_event_id === 'x').amount_minor, a.events.plan.find((e) => e.cash_event_id === 'S@2026-10-11').amount_minor, a.series.plan.opening_minor];
  });
  // opening: 100000 + round(5·0,5 = 2,5): half_even 2, half_up 3, floor 2, ceil 3
  assert.deepEqual(got, [[0, 120062, 100002], [-1, 120063, 100003], [-1, 120062, 100002], [0, 120063, 100003]]);
});

test('TST-37 C-014 ADV analyze: ручные правки из ws.wave_overrides применяются в порядке seq и ссылка на несуществующее событие даёт W_OVERRIDE_STALE в warnings анализа', () => {
  const ws = mkws({
    params: { buffer_minor: 1000, horizon_days: 20 },
    plans: [{ id: 'o1', date: day(3), amount_minor: -5000, is_obligation: true }, { id: 'o2', date: day(4), amount_minor: -5000, is_obligation: true }],
    extra: { wave_overrides: [{ override_id: 'w2', action: 'merge', event_ids: ['ghost'], seq: 2 }, { override_id: 'w1', action: 'split', event_ids: ['o2'], seq: 1 }] },
  });
  const a = analyze(ws, { as_of: '2026-10-04' });
  assert.deepEqual(a.wave_overrides.map((o) => o.override_id), ['w1', 'w2'], 'в контексте — в порядке seq');
  assert.deepEqual(W.list_waves(a, 'plan').map((x) => x.wave.event_ids), [['o1'], ['o2']]);
  assert.deepEqual(a.warnings.filter((w) => w.code === 'W_OVERRIDE_STALE'), [{ code: 'W_OVERRIDE_STALE', override_id: 'w2', event_ids: ['ghost'] }]);
});

test('TST-31 ADV analyze: пустая рабочая область (нет событий) — плоские ряды = opening, волн нет, Q1 без разрывов, готовность 1 (гейт: readiness), explain и runway без цепочки/разрыва; STS = opening − B', () => {
  const a = analyze(mkws({ opening: 50000, params: { horizon_days: 5, buffer_minor: 10000 } }), { as_of: '2026-10-04' });
  assert.deepEqual(a.events, { plan: [], worse: [] });
  for (const m of ['plan', 'worse']) {
    assert.deepEqual(a.series[m].close, Array(6).fill(50000));
    assert.deepEqual(a.series[m].trough, Array(6).fill(50000));
    assert.deepEqual(a.series[m].free, Array(6).fill(50000));
  }
  assert.deepEqual(W.list_waves(a, 'plan'), []);
  assert.deepEqual([a.q1.plan.first_breach, a.q1.plan.first_buffer_breach, a.q1.plan.need, a.q1.plan.ok_buffer], [null, null, 0, true]);
  assert.deepEqual(a.readiness, { score: 1, level: 'skeleton', reasons: ['obligations_lt_3', 'no_income_45d', 'no_daily_spend'] });
  assert.equal(A.gate(a).reason, 'readiness');
  const ex = T.explain_narrowest(a.events.worse, a.series.worse, a.params);
  assert.deepEqual([ex.out_total_minor, ex.chain, ex.counterfactuals, ex.point.amount_minor], [0, [], [], 50000]);
  assert.deepEqual(T.runway_days(a.series.plan, a.events.plan), { with: null, without: null });
  const r = { ...a, readiness: { score: 4 } };
  assert.equal(A.safe_to_spend(r, a.horizon_end, null, 'worse').sts, 40000);
});
