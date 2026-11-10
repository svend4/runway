// timeline.test.mjs — ALG-02: ряды close/trough, Q1, сценарии, объяснение, опорный остаток, готовность данных.
// Покрывает: TST-31 (сохранение), TST-34 (локальность), TST-35 (worse ≤ plan и монотонность рядов), TST-36 (аддитивность сценариев),
// TST-41 (expected → overdue), TST-53 (оракул против быстрой реализации, 10⁴ случаев, seed фиксирован), TST-54 (производительность,
// N = 10³ событий, H = 180), TST-57 (готовность и свежесть), часть TST-33 (детерминизм), TST-01/09 на малых синтетических наборах (TV6).
// Golden-числа G-001 — в g001.test.mjs. В тестах допустимы node:fs и performance.now (в engine/ — нет).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { make_rng, throws_code } from './helpers.mjs';
import {
  oracle_series, oracle_reserves, oracle_free, oracle_q1, oracle_runway, oracle_eff_date, oracle_pipeline,
} from './oracle.mjs';
import { parse_date, format_date } from '../engine/dates.mjs';
import { reserve_series, free_series } from '../engine/sinking.mjs';
import {
  project, argmin_first, narrowest_point, answer_q1, runway_days, eff_date, apply_scenario, purchase_to_events, explain_narrowest,
  opening_state, plan_from, build_events, build_events_ex, readiness, anchor_status, outflow_90, buffer_hint, default_wave_threshold,
  normalize_ws, normalize_mode, flat_params, get_param, rule_statuses, TIMELINE_DEFAULTS,
} from '../engine/timeline.mjs';

const iso = parse_date;
const G = JSON.parse(fs.readFileSync(new URL('../data/g001.json', import.meta.url), 'utf8'));
const AS_OF = iso('2026-10-04');
const HZ = iso('2026-11-30');
const clone = (x) => JSON.parse(JSON.stringify(x));

/** Минимальная рабочая область: один счёт EUR, якорь на as_of; детали — через `over`. */
function mini_ws(over = {}) {
  return {
    decision_currency: 'EUR',
    params: { horizon_days: 40, 'match.tol_bp': 500 },
    accounts: [{ account_id: 'a', name: 'Счёт', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 }],
    anchors: [{ anchor_id: 'anc', account_id: 'a', date: '2026-10-01', amount_minor: 100000 }],
    facts: [], rules: [], overrides: [], calendars: [], streams: [], plans: [], tax_rules: [], reserves: [], rates: [], scenarios: [], debts: [],
    ...over,
  };
}
const plan1 = (id, date, amount, extra = {}) => ({ plan_id: id, account_id: 'a', date, amount_minor: amount, currency: 'EUR', tag: id, ...extra });

// ── генераторы случайных наборов (seed фиксирован) ────────────────────────────────────────────────────────────────────

/** Случайные события: даты в [as_of, as_of + N + extra), суммы ненулевые. */
function rand_events(rng, as_of, N, M, opts = {}) {
  const { max_amt = 100000, extra = 5, reserve_ids = [] } = opts;
  return Array.from({ length: M }, (_, k) => {
    const amt = rng.int(1, max_amt) * (rng.bool() ? 1 : -1);
    const e = {
      cash_event_id: 'e' + String(k).padStart(3, '0'), layer: 'planned', account_id: 'a', date: as_of + rng.int(0, N + extra - 1), amount_minor: amt,
      currency: 'EUR', kind: amt > 0 ? 'income' : 'expense', tag: 't' + rng.int(0, 3), is_obligation: false, is_estimate: false,
    };
    if (amt < 0 && reserve_ids.length > 0 && rng.int(0, 2) === 0) e.reserve_id = rng.pick(reserve_ids);
    return e;
  });
}

function rand_case(rng, opts = {}) {
  const as_of = 19000 + rng.int(0, 6000);
  const N = rng.int(1, opts.max_n ?? 40);
  const M = rng.int(0, opts.max_m ?? 25);
  return { as_of, N, horizon_end: as_of + N - 1, opening: rng.int(-50000, 500000), events: rand_events(rng, as_of, N, M, opts) };
}

// ── project: определения D-01 ─────────────────────────────────────────────────────────────────────────────────────────

test('project (D-01, TV6): день 0 — доход и расход в один день: trough = opening + расход, close = opening + расход + доход («расходы раньше доходов»)', () => {
  const s = project([{ cash_event_id: 'i', date: 100, amount_minor: 50000 }, { cash_event_id: 'o', date: 100, amount_minor: -30000 }], 10000, 100, 100);
  assert.deepEqual(s, { from: 100, opening_minor: 10000, close: [30000], trough: [-20000] });
  // порядок событий во входе не важен
  const s2 = project([{ cash_event_id: 'o', date: 100, amount_minor: -30000 }, { cash_event_id: 'i', date: 100, amount_minor: 50000 }], 10000, 100, 100);
  assert.deepEqual(s2, s);
});

test('project: нет событий — trough = close = opening; as_of = horizon_end — одна точка; за горизонтом пропускаются; две записи дня суммируются', () => {
  const s = project([], 777, 50, 54);
  assert.deepEqual([s.close, s.trough], [[777, 777, 777, 777, 777], [777, 777, 777, 777, 777]]);
  const one = project([{ date: 5, amount_minor: -1 }, { date: 6, amount_minor: -1000 }], 10, 5, 5);
  assert.deepEqual(one.trough, [9]);
  assert.deepEqual(one.close, [9]);
  const two = project([{ date: 5, amount_minor: -100 }, { date: 5, amount_minor: -50 }, { date: 5, amount_minor: 20 }, { date: 5, amount_minor: 30 }], 1000, 5, 6);
  assert.deepEqual(two.trough, [850, 900]);
  assert.deepEqual(two.close, [900, 900]);
  assert.deepEqual(project([{ date: '2026-10-05', amount_minor: -5 }], 10, '2026-10-04', '2026-10-06').close, [10, 5, 5]); // IsoDate на границе
});

test('project: ошибки — horizon_end < as_of (E_BAD_DATE), событие раньше as_of (E_SCHEMA), float и переполнение суммы', () => {
  throws_code(() => project([], 0, 10, 9), 'E_BAD_DATE');
  throws_code(() => project([{ date: 9, amount_minor: -5 }], 0, 10, 12), 'E_SCHEMA');
  throws_code(() => project([{ date: 10, amount_minor: 1.5 }], 0, 10, 12), 'E_NOT_INTEGER');
  throws_code(() => project([{ date: 10, amount_minor: 2 ** 53 }], 0, 10, 12), 'E_OVERFLOW');
  throws_code(() => project([{ date: 10, amount_minor: Number.MAX_SAFE_INTEGER }, { date: 10, amount_minor: 1 }], 0, 10, 12), 'E_OVERFLOW');
  throws_code(() => project([], 0.5, 10, 12), 'E_NOT_INTEGER');
});

test('argmin_first / narrowest_point (D-02): побеждает первая дата минимума; подотрезок; неверный диапазон — E_SCHEMA', () => {
  assert.equal(argmin_first([5, 3, 3, 9, 3], 0, 4), 1);
  assert.equal(argmin_first([5, 3, 3, 9, 3], 2, 4), 2);
  assert.equal(argmin_first([7], 0, 0), 0);
  throws_code(() => argmin_first([1, 2], 1, 0), 'E_SCHEMA');
  throws_code(() => argmin_first([1, 2], 0, 2), 'E_SCHEMA');
  const s = { from: 100, opening_minor: 10, close: [10, 4, 9], trough: [10, 4, 4] };
  assert.deepEqual(narrowest_point(s, 100, 102), { date: 101, amount_minor: 4 });
  assert.deepEqual(narrowest_point(s, 102, 102), { date: 102, amount_minor: 4 });
});

// ── Q1 и runway (D-13) ────────────────────────────────────────────────────────────────────────────────────────────────

test('answer_q1 (D-13): свойство пути [as_of, D]; first_breach и first_buffer_breach — на пути, а не на всём горизонте; D после горизонта — beyond_horizon; D < as_of — E_BAD_DATE', () => {
  const s = project([{ date: 3, amount_minor: -80 }, { date: 7, amount_minor: -90 }, { date: 9, amount_minor: 300 }], 100, 0, 10);
  // trough: 100,100,100,20,20,20,20,-70,-70,-70(до дохода),... close: ...
  const a = answer_q1(s, 5, 50);
  assert.deepEqual([a.min, a.at, a.ok_cash, a.ok_buffer, a.first_breach, a.first_buffer_breach, a.need, a.close_on_D], [20, 3, true, false, null, 3, 30, 20]);
  const b = answer_q1(s, 10, 50);
  assert.deepEqual([b.min, b.at, b.ok_cash, b.first_breach, b.first_buffer_breach, b.need], [-70, 7, false, 7, 3, 120]);
  assert.deepEqual(answer_q1(s, 11, 50), { beyond_horizon: true });
  throws_code(() => answer_q1(s, -1, 50), 'E_BAD_DATE');
  // B не задан → 0
  const c = answer_q1(s, 5, null);
  assert.deepEqual([c.ok_buffer, c.first_buffer_breach, c.need], [true, null, 0]);
  assert.equal(answer_q1(s, 5, undefined).need, 0);
  // min не возрастает с ростом D
  let prev = Infinity;
  for (let d = 0; d <= 10; d++) { const m = answer_q1(s, d, 0).min; assert.ok(m <= prev); prev = m; }
});

test('runway_days (C-005, C-006): по trough на всём горизонте — с доходами и без (ряд без поступлений пересчитывается); null — «за горизонтом»', () => {
  const evs = [{ date: 2, amount_minor: -60 }, { date: 4, amount_minor: 500 }, { date: 6, amount_minor: -60 }, { date: 7, amount_minor: -60 }];
  const s = project(evs, 100, 0, 9);
  const r = runway_days(s, evs);
  assert.equal(r.with, null); // доход 4 спасает: trough[6] = 40 + 500 − 60 = 480 ...
  assert.deepEqual(r.without, { date: 6, days: 6 }); // 100 − 60 = 40; день 6: trough = −20
  const poor = project([{ date: 11, amount_minor: -50 }], 100, 10, 12);
  assert.deepEqual(runway_days(poor, [{ date: 11, amount_minor: -50 }]), { with: null, without: null });
  assert.deepEqual(runway_days(project([{ date: 11, amount_minor: -150 }], 100, 10, 12), [{ date: 11, amount_minor: -150 }]), { with: { date: 11, days: 1 }, without: { date: 11, days: 1 } });
  assert.deepEqual(runway_days(project([], 100, 10, 12), []), { with: null, without: null });
  // отрицательный opening: разрыв с первого дня (days = 0)
  assert.deepEqual(runway_days(project([], -5, 10, 12), []).with, { date: 10, days: 0 });
});

// ── eff_date (D-04) ───────────────────────────────────────────────────────────────────────────────────────────────────

test('eff_date (D-04, C-005): plan — base = max(plan_date, as_of); worse — доход + задержка; расходы не сдвигаются; delay_days_worse переопределяет, в т.ч. 0', () => {
  const inc = { kind: 'income', date: 100, plan_date: 100, amount_minor: 5 };
  const exp = { kind: 'expense', date: 100, plan_date: 100, amount_minor: -5 };
  const P = { 'worse.income_delay_days': 14 };
  assert.equal(eff_date(inc, 'plan', P, 90), 100);
  assert.equal(eff_date(inc, 'worse', P, 90), 114);
  assert.equal(eff_date(exp, 'worse', P, 90), 100);
  assert.equal(eff_date({ ...inc, delay_days_worse: 3 }, 'worse', P, 90), 103);
  assert.equal(eff_date({ ...inc, delay_days_worse: 0 }, 'worse', P, 90), 100);
  assert.equal(eff_date({ ...inc, delay_days_worse: null }, 'worse', P, 90), 114, 'null — берётся параметр');
  // «просроченное» (plan_date < as_of): считается на as_of; в worse — as_of + delay
  assert.equal(eff_date(inc, 'plan', P, 120), 120);
  assert.equal(eff_date(inc, 'worse', P, 120), 134);
  // plan_date по умолчанию — date; вложенные параметры; IsoDate as_of
  assert.equal(eff_date({ kind: 'income', date: 100 }, 'worse', { worse: { income_delay_days: 2 } }, 90), 102);
  assert.equal(eff_date({ kind: 'income', date: iso('2026-10-04') }, 'plan', {}, '2026-10-06'), iso('2026-10-06'));
  assert.equal(eff_date({ kind: 'income', date: 100 }, 'worse', undefined, 90), 114, 'по умолчанию 14');
  // статусы matched / skipped / cancelled в поток не входят
  for (const status of ['matched', 'skipped', 'cancelled']) assert.equal(eff_date({ ...inc, status }, 'plan', P, 90), null);
  for (const status of ['expected', 'overdue']) assert.equal(eff_date({ ...inc, status }, 'plan', P, 90), 100);
  // режим conservative — синоним worse; expected — v2
  assert.equal(eff_date(inc, 'conservative', P, 90), 114);
  throws_code(() => eff_date(inc, 'expected', P, 90), 'E_SCHEMA');
  throws_code(() => eff_date(inc, 'bogus', P, 90), 'E_SCHEMA');
  throws_code(() => eff_date({ ...inc, delay_days_worse: -1 }, 'worse', P, 90), 'E_SCHEMA');
  throws_code(() => eff_date({ ...inc, delay_days_worse: 1.5 }, 'worse', P, 90), 'E_SCHEMA');
  throws_code(() => eff_date(inc, 'worse', { 'worse.income_delay_days': -3 }, 90), 'E_SCHEMA');
  assert.equal(eff_date({ ...exp, delay_days_worse: -1 }, 'worse', P, 90), 100, 'у расхода сдвиг не читается');
  assert.equal(normalize_mode('conservative'), 'worse');
});

test('параметры: flat_params / get_param — плоские и вложенные ключи, значения по умолчанию §2.0 (зеркало vocab.json)', () => {
  const vocab = JSON.parse(fs.readFileSync(new URL('../engine/vocab.json', import.meta.url), 'utf8'));
  for (const [k, v] of Object.entries(TIMELINE_DEFAULTS)) {
    assert.ok(Object.hasOwn(vocab.params, k), `${k} есть в vocab.json`);
    assert.deepEqual(v, vocab.params[k].default, `умолчание ${k} совпадает с vocab.json`);
  }
  const f = flat_params({ worse: { income_delay_days: 7 }, 'match.tol_bp': 300, buffer_minor: null, rounding: 'half_up' });
  assert.equal(f['worse.income_delay_days'], 7);
  assert.equal(f['match.tol_bp'], 300);
  assert.equal(f['match.window_days'], 3);
  assert.equal(f.buffer_minor, null);
  assert.equal(f.rounding, 'half_up');
  assert.equal(get_param({ explain: { top_k: 3 } }, 'explain.top_k'), 3);
  assert.equal(get_param({}, 'explain.share_cutoff_bp'), 9000);
  assert.equal(get_param(undefined, 'horizon_days'), 180);
  assert.equal(get_param({}, 'buffer_minor'), null);
  throws_code(() => normalize_ws(mini_ws({ params: { rounding: 'banker' } })), 'E_SCHEMA');
});

// ── apply_scenario и purchase_to_events (D-14, C-008, C-009) ───────────────────────────────────────────────────────────

const SC_CTX = { as_of: 100, horizon_end: 160, calendars: [{ calendar_id: 'c', weekend_dows: [0, 6], holidays: [] }], default_account_id: 'a', default_currency: 'EUR' };
const mk = (id, date, amount, extra = {}) => ({
  cash_event_id: id, layer: 'planned', account_id: 'a', date, amount_minor: amount, currency: 'EUR', kind: amount > 0 ? 'income' : 'expense', tag: id, ...extra,
});

test('purchase_to_events (C-008): гипотетические расходы purchase_id#k (k с 0), сумма части со знаком «−», scenario_id по необходимости; ошибки', () => {
  const evs = purchase_to_events({ purchase_id: 'p1', currency: 'EUR', parts: [{ date: 110, amount_minor: 18334 }, { date: '2026-10-05', amount_minor: 18333 }] }, 'a', 'sc');
  assert.deepEqual(evs.map((e) => [e.cash_event_id, e.date, e.amount_minor, e.layer, e.kind, e.scenario_id, e.purchase_id, e.account_id]),
    [['p1#0', 110, -18334, 'hypothetical', 'expense', 'sc', 'p1', 'a'], ['p1#1', iso('2026-10-05'), -18333, 'hypothetical', 'expense', 'sc', 'p1', 'a']]);
  assert.ok(!('scenario_id' in purchase_to_events({ purchase_id: 'p', currency: 'EUR', parts: [{ date: 1, amount_minor: 1 }] }, 'a')[0]));
  throws_code(() => purchase_to_events({ purchase_id: 'p', currency: 'EUR', parts: [] }, 'a'), 'E_SCHEMA');
  throws_code(() => purchase_to_events({ purchase_id: 'p', currency: 'EUR', parts: [{ date: 1, amount_minor: 0 }] }, 'a'), 'E_SCHEMA');
  throws_code(() => purchase_to_events({ purchase_id: 'p', currency: 'EUR', parts: [{ date: 1, amount_minor: -5 }] }, 'a'), 'E_SCHEMA');
});

test('apply_scenario (C-008): event_ref — сначала точное cash_event_id/occ_key, затем rule_id/stream_id; delay_income и set_amount требуют ровно одно событие', () => {
  const evs = [
    mk('R1@a', 105, -10, { rule_id: 'R1', occ_key: 'R1@a' }), mk('R1@b', 112, -10, { rule_id: 'R1', occ_key: 'R1@b' }),
    mk('S1@x', 120, 500, { stream_id: 'S1', occ_key: 'S1@x', rule_id: null }), mk('P', 130, 300),
  ];
  const run = (ops) => apply_scenario(evs, { scenario_id: 's', ops }, SC_CTX);
  // точное совпадение occ_key
  assert.equal(run([{ op: 'delay_income', event_ref: 'S1@x', days: 14 }]).find((e) => e.occ_key === 'S1@x').date, 134);
  // группа по stream_id — одно вхождение: допустимо
  assert.equal(run([{ op: 'delay_income', event_ref: 'S1', days: 3 }]).find((e) => e.stream_id === 'S1').date, 123);
  // группа по rule_id — два: delay_income / set_amount требуют одно
  throws_code(() => run([{ op: 'delay_income', event_ref: 'R1', days: 1 }]), 'E_SCHEMA');
  throws_code(() => run([{ op: 'set_amount', event_ref: 'R1', amount_minor: -5 }]), 'E_SCHEMA');
  // shift_flow и remove_flow допускают группу
  const sh = run([{ op: 'shift_flow', event_ref: 'R1', days: -2 }]);
  assert.deepEqual(sh.filter((e) => e.rule_id === 'R1').map((e) => e.date), [103, 110]);
  assert.deepEqual(sh.filter((e) => e.rule_id === 'R1').map((e) => e.scenario_id), ['s', 's']);
  assert.equal(run([{ op: 'remove_flow', event_ref: 'R1' }]).length, 2);
  // нет совпадения — E_SCHEMA, не молчаливый пропуск
  throws_code(() => run([{ op: 'delay_income', event_ref: 'NOPE', days: 1 }]), 'E_SCHEMA');
  throws_code(() => run([{ op: 'remove_flow', event_ref: 'NOPE' }]), 'E_SCHEMA');
  throws_code(() => run([{ op: 'shift_flow', days: 1 }]), 'E_SCHEMA');
  // delay_income только для дохода и days ≥ 0; set_amount — знак по kind
  throws_code(() => run([{ op: 'delay_income', event_ref: 'R1@a', days: 1 }]), 'E_SCHEMA');
  throws_code(() => run([{ op: 'delay_income', event_ref: 'P', days: -1 }]), 'E_SCHEMA');
  throws_code(() => run([{ op: 'delay_income', event_ref: 'P', days: 1.5 }]), 'E_SCHEMA');
  throws_code(() => run([{ op: 'set_amount', event_ref: 'P', amount_minor: -5 }]), 'E_SCHEMA');
  throws_code(() => run([{ op: 'set_amount', event_ref: 'R1@a', amount_minor: 5 }]), 'E_SCHEMA');
  throws_code(() => run([{ op: 'set_amount', event_ref: 'P', amount_minor: 0 }]), 'E_SCHEMA');
  const sa = run([{ op: 'set_amount', event_ref: 'P', amount_minor: 999 }]).find((e) => e.cash_event_id === 'P');
  assert.equal(sa.amount_minor, 999);
  assert.equal(sa.scenario_id, 's');
  // неизвестная операция и op, не входящий в v1
  throws_code(() => run([{ op: 'teleport' }]), 'E_SCHEMA');
  throws_code(() => run([{ op: 'hours', stream_id: 'S1', minutes: 60 }]), 'E_SCHEMA');
  throws_code(() => run([{ ref: 'P' }]), 'E_SCHEMA');
  // fx_shock данных не меняет
  assert.deepEqual(run([{ op: 'fx_shock', currency: 'USD', bp: -500 }]), evs.map((e) => ({ ...e })));
  throws_code(() => run([{ op: 'fx_shock', bp: -500 }]), 'E_SCHEMA');
  throws_code(() => run([{ op: 'fx_shock', currency: 'USD', bp: 1.5 }]), 'E_SCHEMA');
  // exact побеждает группу: событие с cash_event_id = rule_id другого
  const tricky = [mk('X', 105, -1, { rule_id: 'Y' }), mk('Y', 106, -2, { rule_id: 'Z' })];
  assert.deepEqual(apply_scenario(tricky, { scenario_id: 's', ops: [{ op: 'remove_flow', event_ref: 'Y' }] }, SC_CTX).map((e) => e.cash_event_id), ['X']);
});

test('apply_scenario: add_purchase (parts и короткая форма), add_flow (once и rule), без счёта по умолчанию — E_SCHEMA; вход не мутируется', () => {
  const evs = [mk('P', 130, 300)];
  const snap = JSON.stringify(evs);
  const out = apply_scenario(evs, {
    scenario_id: 's',
    ops: [
      { op: 'add_purchase', parts: [{ date: 110, amount_minor: 300 }, { date: 120, amount_minor: 200 }] },
      { op: 'add_purchase', date: 115, amount_minor: 50, currency: 'EUR' },
      { op: 'add_flow', once: { date: 118, amount_minor: -70, tag: 'нечто', is_obligation: true } },
      { op: 'add_flow', rule: { rule_id: 'RX', kind: 'expense', amount: { exp_minor: -5 }, freq: 'W', interval: 1, by_weekday: [1], start_date: '2026-01-05', weekend: 'keep', calendar_id: null } },
    ],
  }, { ...SC_CTX, as_of: iso('2026-10-05'), horizon_end: iso('2026-10-26') });
  assert.equal(JSON.stringify(evs), snap);
  const hyp = out.filter((e) => e.layer === 'hypothetical');
  assert.deepEqual(hyp.slice(0, 3).map((e) => [e.cash_event_id, e.amount_minor]), [['scn:s:1#0', -300], ['scn:s:1#1', -200], ['scn:s:2#0', -50]]);
  const once = hyp.find((e) => e.cash_event_id === 'scn:s:3');
  assert.deepEqual([once.amount_minor, once.kind, once.is_obligation, once.scenario_id, once.account_id], [-70, 'expense', true, 's', 'a']);
  const rule_evs = hyp.filter((e) => e.rule_id === 'RX');
  assert.deepEqual(rule_evs.map((e) => format_date(e.date)), ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']); // понедельники окна
  assert.equal(rule_evs[0].cash_event_id, 'scn:s:4:RX@2026-10-05');
  throws_code(() => apply_scenario(evs, { scenario_id: 's', ops: [{ op: 'add_purchase', date: 1, amount_minor: 1 }] }, { ...SC_CTX, default_account_id: null }), 'E_SCHEMA');
  throws_code(() => apply_scenario(evs, { scenario_id: 's', ops: [{ op: 'add_flow' }] }, SC_CTX), 'E_SCHEMA');
  throws_code(() => apply_scenario(evs, { scenario_id: 's', ops: [{ op: 'add_flow', once: { date: 1, amount_minor: 0 } }] }, SC_CTX), 'E_SCHEMA');
  // сценарий без id: гипотезы получают id inline
  const inline = apply_scenario(evs, { ops: [{ op: 'add_purchase', date: 110, amount_minor: 5 }] }, SC_CTX);
  assert.equal(inline.at(-1).cash_event_id, 'scn:inline:1#0');
  assert.ok(!('scenario_id' in inline.at(-1)));
  assert.deepEqual(apply_scenario(evs, { scenario_id: 's', ops: [] }, SC_CTX), evs);
  assert.deepEqual(apply_scenario(evs, undefined, SC_CTX), evs);
});

// ── опорный остаток (D-01, D-22, C-010) ───────────────────────────────────────────────────────────────────────────────

test('opening_state (D-22): якорь + факты после якоря; факт на дату якоря уже внутри; несколько счетов; перевод в валюту решения; закрытые и неоперационные не входят', () => {
  const ws = mini_ws({
    accounts: [
      { account_id: 'a', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 },
      { account_id: 'u', kind: 'bank', liquidity: 'operating', currency: 'USD', exponent: 2 },
      { account_id: 's', kind: 'savings', liquidity: 'savings', currency: 'EUR', exponent: 2 },
      { account_id: 'old', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2, closed_on: '2026-09-01' },
    ],
    rates: [{ fx_id: 'r1', date: '2026-09-01', base: 'USD', quote: 'EUR', num: 9250, den: 10000 }],
    anchors: [
      { anchor_id: 'a1', account_id: 'a', date: '2026-10-01', amount_minor: 100000 },
      { anchor_id: 'u1', account_id: 'u', date: '2026-10-02', amount_minor: 200000 },
      { anchor_id: 's1', account_id: 's', date: '2026-10-02', amount_minor: 9999999 },
      { anchor_id: 'o1', account_id: 'old', date: '2026-08-01', amount_minor: 555 },
    ],
    facts: [
      { event_id: 'f1', account_id: 'a', date: '2026-10-01', amount_minor: -7777, currency: 'EUR' }, // на дату якоря — внутри якоря
      { event_id: 'f2', account_id: 'a', date: '2026-10-03', amount_minor: -2500, currency: 'EUR' },
      { event_id: 'f3', account_id: 'u', date: '2026-10-04', amount_minor: 1000, currency: 'USD' },
    ],
  });
  const os = opening_state(ws, '2026-10-04');
  // a: 100000 − 2500 = 97500; u: 201000 USD → 185925 (201000 · 0,9250); savings и закрытый — вне
  assert.equal(os.opening_minor, 97500 + 185925);
  assert.equal(os.anchor_age, 3); // самый несвежий — a (10-01)
  assert.deepEqual(os.stale_accounts, []);
  assert.equal(plan_from(ws, 'u', '2026-10-04'), iso('2026-10-02'));
  assert.equal(plan_from(ws, { account_id: 'a' }, '2026-10-04'), iso('2026-10-01'));
  assert.equal(plan_from(ws, 'ghost', '2026-10-04'), iso('2026-10-04'));
  // drift: якорь − (предыдущий якорь + проведённые) — по одному якорю: якорь − Σ posted до него; для a: 100000 − (0 + 0 + (−7777 на дату якоря)) = 107777
  assert.equal(os.drift, 107777 + 185000);
});

test('opening_state: posted позже as_of — E_FUTURE_POSTED; нет курса — E_NO_RATE; нет якоря — остаток от нуля, anchor_age = null (no_anchor); нет счетов/валюты решения — E_SCHEMA', () => {
  throws_code(() => opening_state(mini_ws({ facts: [{ event_id: 'f', account_id: 'a', date: '2026-10-05', amount_minor: 1, currency: 'EUR' }] }), '2026-10-04'), 'E_FUTURE_POSTED');
  const usd = mini_ws({ accounts: [{ account_id: 'a', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 }, { account_id: 'u', kind: 'bank', liquidity: 'operating', currency: 'USD', exponent: 2 }] });
  throws_code(() => opening_state(usd, '2026-10-04'), 'E_NO_RATE');
  const none = mini_ws({ anchors: [], facts: [{ event_id: 'f', account_id: 'a', date: '2026-10-02', amount_minor: 4200, currency: 'EUR' }] });
  const os = opening_state(none, '2026-10-04');
  assert.equal(os.opening_minor, 4200);
  assert.equal(os.anchor_age, null);
  assert.equal(os.drift, null);
  assert.deepEqual(os.stale_accounts, [{ account_id: 'a', age: null }]);
  throws_code(() => opening_state({ params: {}, accounts: [] }, '2026-10-04'), 'E_SCHEMA');
  // валюта решения берётся у первого operating-счёта, если не задана
  const ws2 = mini_ws();
  delete ws2.decision_currency;
  assert.equal(normalize_ws(ws2).decision_currency, 'EUR');
});

test('TST-57 свежесть по самому несвежему operating-счёту (C-010): якоря 10-04 и 09-20 → age 14 (плашка, Q3 ещё отвечает); якорь 09-10 → age 24 (block, stale_accounts называет счёт); без якоря — block/no_anchor', () => {
  const two = (d2) => mini_ws({
    accounts: [{ account_id: 'a', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 }, { account_id: 'b', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 }],
    anchors: [{ anchor_id: 'x1', account_id: 'a', date: '2026-10-04', amount_minor: 1 }, { anchor_id: 'x2', account_id: 'b', date: d2, amount_minor: 2 }],
  });
  const s14 = anchor_status(two('2026-09-20'), '2026-10-04');
  assert.equal(s14.age, 14);
  assert.equal(s14.level, 'banner');
  assert.deepEqual(s14.stale_accounts, [{ account_id: 'b', age: 14 }]);
  const s24 = anchor_status(two('2026-09-10'), '2026-10-04');
  assert.deepEqual([s24.age, s24.level, s24.reason], [24, 'block', 'stale']);
  assert.deepEqual(s24.stale_accounts, [{ account_id: 'b', age: 24 }]);
  const none = anchor_status(mini_ws({ anchors: [] }), '2026-10-04');
  assert.deepEqual([none.age, none.level, none.reason], [null, 'block', 'no_anchor']);
  // один из двух счетов без якоря — block/no_anchor
  const half = anchor_status(mini_ws({
    accounts: [{ account_id: 'a', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 }, { account_id: 'b', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 }],
    anchors: [{ anchor_id: 'x1', account_id: 'a', date: '2026-10-04', amount_minor: 1 }],
  }), '2026-10-04');
  assert.deepEqual([half.level, half.reason], ['block', 'no_anchor']);
  assert.deepEqual(half.stale_accounts, [{ account_id: 'b', age: null }]);
  // расхождения суммируются по счетам
  const dr = opening_state(mini_ws({
    accounts: [{ account_id: 'a', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 }, { account_id: 'b', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 }],
    anchors: [{ anchor_id: 'x1', account_id: 'a', date: '2026-10-04', amount_minor: 1000 }, { anchor_id: 'x2', account_id: 'b', date: '2026-10-04', amount_minor: 300 }],
  }), '2026-10-04');
  assert.equal(dr.drift, 1300);
  assert.equal(dr.opening_minor, 1300);
});

// ── build_events: слои, статусы, сценарии, валюты ──────────────────────────────────────────────────────────────────────

test('TST-41 (ALG-02 TV6): доход 10-15, grace 3: as_of 10-18 — expected (eff plan 10-18, worse 11-01); as_of 10-19 — overdue (10-19 и 11-02); plan_date хранит 10-15 без зажима', () => {
  const ws = mini_ws({ anchors: [{ anchor_id: 'anc', account_id: 'a', date: '2026-10-01', amount_minor: 0 }], plans: [plan1('INC', '2026-10-15', 5000)] });
  const get = (as_of, mode) => build_events(ws, { as_of, horizon_days: 40, mode }).find((e) => e.cash_event_id === 'INC');
  const e18 = get('2026-10-18', 'plan');
  assert.deepEqual([e18.status, format_date(e18.date), format_date(e18.plan_date)], ['expected', '2026-10-18', '2026-10-15']);
  assert.equal(format_date(get('2026-10-18', 'worse').date), '2026-11-01');
  const e19 = get('2026-10-19', 'plan');
  assert.deepEqual([e19.status, format_date(e19.date)], ['overdue', '2026-10-19']);
  assert.equal(format_date(get('2026-10-19', 'worse').date), '2026-11-02');
  // расход grace 0: на следующий день — overdue и считается на as_of
  const ws2 = mini_ws({ plans: [plan1('X', '2026-10-15', -300)] });
  const x15 = build_events(ws2, { as_of: '2026-10-15', horizon_days: 3, mode: 'plan' })[0];
  assert.equal(x15.status, 'expected');
  const x16 = build_events(ws2, { as_of: '2026-10-16', horizon_days: 3, mode: 'worse' })[0];
  assert.deepEqual([x16.status, format_date(x16.date), format_date(x16.plan_date)], ['overdue', '2026-10-16', '2026-10-15']);
});

test('build_events (C-004): окно плана от даты якоря включительно — план на дату якоря входит, раньше — нет; без якоря — с as_of', () => {
  const ws = mini_ws({ plans: [plan1('before', '2026-09-30', -1), plan1('on', '2026-10-01', -2), plan1('after', '2026-10-02', -4)] });
  const ids = build_events(ws, { as_of: '2026-10-04', horizon_days: 5, mode: 'plan' }).map((e) => e.cash_event_id);
  assert.deepEqual(ids, ['on', 'after'].sort(), 'on и after считаются на as_of');
  const evs = build_events(ws, { as_of: '2026-10-04', horizon_days: 5, mode: 'plan' });
  assert.deepEqual(evs.map((e) => format_date(e.date)), ['2026-10-04', '2026-10-04']);
  const bare = mini_ws({ anchors: [], plans: [plan1('before', '2026-09-30', -1), plan1('today', '2026-10-04', -2)] });
  assert.deepEqual(build_events(bare, { as_of: '2026-10-04', horizon_days: 5, mode: 'plan' }).map((e) => e.cash_event_id), ['today']);
});

test('build_events (D-06, ALG-13): факт сопоставляется с планом — план matched и в поток не входит; частичный факт (plan_ref) оставляет остаток плана; skipped/cancelled не входят', () => {
  const ws = mini_ws({
    plans: [plan1('RENT', '2026-10-20', -90000, { is_obligation: true }), plan1('SKIP', '2026-10-22', -100, { status: 'skipped' }), plan1('CAN', '2026-10-22', -100, { status: 'cancelled' }), plan1('OPEN', '2026-10-25', -5)],
    facts: [{ event_id: 'F1', account_id: 'a', date: '2026-10-21', amount_minor: -90000, currency: 'EUR' }],
  });
  const ids = (w, as_of) => build_events(w, { as_of, horizon_days: 10, mode: 'plan' }).map((e) => e.cash_event_id);
  assert.deepEqual(ids(ws, '2026-10-21'), ['OPEN']);
  // частичный факт со связью: остаток −60000 остаётся ожидаемым/просроченным
  const part = mini_ws({
    plans: [plan1('RENT', '2026-10-20', -100000)],
    facts: [{ event_id: 'F1', account_id: 'a', date: '2026-10-20', amount_minor: -40000, currency: 'EUR', plan_ref: 'RENT' }],
  });
  const r = build_events(part, { as_of: '2026-10-21', horizon_days: 10, mode: 'plan' });
  assert.deepEqual(r.map((e) => [e.cash_event_id, e.amount_minor, e.status]), [['RENT', -60000, 'overdue']]);
  // «не относится к плану»: факт без сопоставления, план остаётся
  const nop = mini_ws({
    plans: [plan1('RENT', '2026-10-20', -100000)],
    facts: [{ event_id: 'F1', account_id: 'a', date: '2026-10-20', amount_minor: -100000, currency: 'EUR', no_plan: true }],
  });
  assert.equal(build_events(nop, { as_of: '2026-10-21', horizon_days: 10, mode: 'plan' }).length, 1);
});

test('build_events: неоперационные счета не входят; перевод между operating-счетами исключён (нетто 0), в неоперационный — остаётся расходом (D-07)', () => {
  const accounts = [
    { account_id: 'a', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 },
    { account_id: 'b', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 },
    { account_id: 's', kind: 'savings', liquidity: 'savings', currency: 'EUR', exponent: 2 },
  ];
  const ws = mini_ws({
    accounts,
    anchors: [{ anchor_id: 'x', account_id: 'a', date: '2026-10-04', amount_minor: 0 }, { anchor_id: 'y', account_id: 'b', date: '2026-10-04', amount_minor: 0 }],
    plans: [
      { plan_id: 'T1a', account_id: 'a', date: '2026-10-10', amount_minor: -500, currency: 'EUR', kind: 'transfer', transfer_id: 'tr1' },
      { plan_id: 'T1b', account_id: 'b', date: '2026-10-10', amount_minor: 500, currency: 'EUR', kind: 'transfer', transfer_id: 'tr1' },
      { plan_id: 'T2a', account_id: 'a', date: '2026-10-11', amount_minor: -700, currency: 'EUR', kind: 'transfer', transfer_id: 'tr2' },
      { plan_id: 'T2s', account_id: 's', date: '2026-10-11', amount_minor: 700, currency: 'EUR', kind: 'transfer', transfer_id: 'tr2' },
      { plan_id: 'ONSAV', account_id: 's', date: '2026-10-12', amount_minor: -9, currency: 'EUR' },
    ],
  });
  const evs = build_events(ws, { as_of: '2026-10-04', horizon_days: 10, mode: 'plan' });
  assert.deepEqual(evs.map((e) => e.cash_event_id), ['T2a']);
});

test('build_events (C-034, X4, D-20): события в чужой валюте — в валюту решения по spot с одним округлением; E_NO_RATE; E_CURRENCY_MISMATCH; резерв не в валюте решения — E_CURRENCY_MISMATCH', () => {
  const usd_acc = { account_id: 'u', kind: 'bank', liquidity: 'operating', currency: 'USD', exponent: 2 };
  const ws = mini_ws({
    accounts: [{ account_id: 'a', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 }, usd_acc],
    anchors: [{ anchor_id: 'x', account_id: 'u', date: '2026-10-04', amount_minor: 0 }, { anchor_id: 'y', account_id: 'a', date: '2026-10-04', amount_minor: 0 }],
    rates: [{ fx_id: 'r', date: '2026-10-01', base: 'USD', quote: 'EUR', num: 9250, den: 10000 }],
    plans: [{ plan_id: 'U', account_id: 'u', date: '2026-10-10', amount_minor: 200000, currency: 'USD', kind: 'income', amount_min_minor: 100000 }],
  });
  const e = build_events(ws, { as_of: '2026-10-04', horizon_days: 10, mode: 'plan' })[0];
  assert.deepEqual([e.amount_minor, e.currency, e.orig_amount_minor, e.orig_currency, e.amount_min_minor], [185000, 'EUR', 200000, 'USD', 92500]); // TST-27: 2000,00 $ × 0,9250
  assert.deepEqual(e.rate_used, { num: 9250, den: 10000, date: iso('2026-10-01') });
  // сценарий курса −5 %: 175750 (TST-27)
  const shocked = build_events(ws, { as_of: '2026-10-04', horizon_days: 10, mode: 'plan', scenario: { scenario_id: 'fx', ops: [{ op: 'fx_shock', currency: 'USD', bp: -500 }] } })[0];
  assert.equal(shocked.amount_minor, 175750);
  // только обратная пара EUR→USD
  const inv = { ...ws, rates: [{ fx_id: 'r', date: '2026-10-01', base: 'EUR', quote: 'USD', num: 10000, den: 9250 }] };
  assert.equal(build_events(inv, { as_of: '2026-10-04', horizon_days: 10, mode: 'plan' })[0].amount_minor, 185000);
  throws_code(() => build_events({ ...ws, rates: [] }, { as_of: '2026-10-04', horizon_days: 10, mode: 'plan' }), 'E_NO_RATE');
  const bad = { ...ws, plans: [{ plan_id: 'U', account_id: 'u', date: '2026-10-10', amount_minor: 5, currency: 'EUR', kind: 'income' }] };
  throws_code(() => build_events(bad, { as_of: '2026-10-04', horizon_days: 10, mode: 'plan' }), 'E_CURRENCY_MISMATCH');
  throws_code(() => build_events({ ...ws, reserves: [{ reserve_id: 'R', kind: 'tax', currency: 'USD', funded_start_minor: 0, backed_by_account_id: null }] }, { as_of: '2026-10-04', horizon_days: 10, mode: 'plan' }), 'E_CURRENCY_MISMATCH');
});

test('build_events: горизонт (horizon_end главнее horizon_days, умолчание — params.horizon_days), as_of строкой, события за горизонтом не входят, E_BAD_DATE; режим expected — E_SCHEMA; conservative = worse', () => {
  const ws = mini_ws({ plans: [plan1('in', '2026-10-10', 5), plan1('edge', '2026-10-14', 5), plan1('out', '2026-10-15', 5)], params: { horizon_days: 10 } });
  const ids = (q) => build_events(ws, { mode: 'plan', ...q }).map((e) => e.cash_event_id);
  assert.deepEqual(ids({ as_of: '2026-10-04' }), ['in', 'edge']); // умолчание — params.horizon_days = 10: horizon_end = 10-14, событие 10-15 — вне
  assert.deepEqual(ids({ as_of: '2026-10-04', horizon_days: 11 }), ['in', 'edge', 'out']);
  assert.deepEqual(ids({ as_of: iso('2026-10-04'), horizon_end: '2026-10-14' }), ['in', 'edge']);
  assert.deepEqual(ids({ as_of: '2026-10-04', horizon_end: '2026-10-14', horizon_days: 0 }), ['in', 'edge']);
  assert.deepEqual(ids({ as_of: '2026-10-04', horizon_days: 6 }), ['in']);
  throws_code(() => ids({ as_of: '2026-10-04', horizon_end: '2026-10-03' }), 'E_BAD_DATE');
  throws_code(() => ids({ as_of: '2026-10-04', horizon_days: -1 }), 'E_SCHEMA');
  throws_code(() => build_events(ws, { as_of: '2026-10-04', mode: 'expected' }), 'E_SCHEMA');
  const w = build_events(ws, { as_of: '2026-10-04', mode: 'worse' });
  assert.deepEqual(build_events(ws, { as_of: '2026-10-04', mode: 'conservative' }), w);
  assert.equal(build_events(ws, { as_of: '2026-10-04' }).length, 2, 'режим по умолчанию — plan');
  assert.equal(build_events(mini_ws({ plans: [plan1('far', '2027-01-01', 5)], params: {} }), { as_of: '2026-10-04' }).length, 1, 'умолчание горизонта — 180 дней: 2027-01-01 в пределах');
});

test('build_events: сценарий — объект главнее scenario_id; неизвестный scenario_id — E_SCHEMA; add_purchase ложится на первый operating-счёт в валюте решения', () => {
  const ws = mini_ws({
    plans: [plan1('INC', '2026-10-10', 1000)],
    scenarios: [{ scenario_id: 'late', name: 'позже', ops: [{ op: 'delay_income', event_ref: 'INC', days: 5 }] }],
  });
  const d = (q) => build_events(ws, { as_of: '2026-10-04', horizon_days: 20, mode: 'plan', ...q }).find((e) => e.cash_event_id === 'INC').date;
  assert.equal(format_date(d({ scenario_id: 'late' })), '2026-10-15');
  assert.equal(format_date(d({ scenario_id: 'late', scenario: { scenario_id: 'x', ops: [] } })), '2026-10-10');
  throws_code(() => d({ scenario_id: 'nope' }), 'E_SCHEMA');
  const pur = build_events(ws, { as_of: '2026-10-04', horizon_days: 20, mode: 'plan', scenario: { scenario_id: 'p', ops: [{ op: 'add_purchase', date: '2026-10-06', amount_minor: 300 }] } });
  const h = pur.find((e) => e.layer === 'hypothetical');
  assert.deepEqual([h.account_id, h.amount_minor, h.currency, h.scenario_id], ['a', -300, 'EUR', 'p']);
  // покупка в прошлом — считается на as_of (base = max(plan_date, as_of)), plan_date хранит дату части
  const past = build_events(ws, { as_of: '2026-10-04', horizon_days: 20, mode: 'worse', scenario: { scenario_id: 'p', ops: [{ op: 'add_purchase', date: '2026-10-01', amount_minor: 300 }] } });
  const hp = past.find((e) => e.layer === 'hypothetical');
  assert.deepEqual([format_date(hp.date), format_date(hp.plan_date)], ['2026-10-04', '2026-10-01']);
});

test('build_events: график долга (рассрочка 0 %, debt.mjs) — плановые обязательства; окно плана; перенос даты строки; sort по (date, amount_minor, id)', () => {
  const ws = mini_ws({
    debts: [{ debt_id: 'D1', pay_account_id: 'a', currency: 'EUR', kind: 'installment_0', principal_minor: 90000, rate_bp: 0, n: 3, start_date: '2026-10-10' }],
    plans: [plan1('Z', '2026-10-10', -30000), plan1('Y', '2026-10-10', -30000)],
  });
  const evs = build_events(ws, { as_of: '2026-10-04', horizon_days: 40, mode: 'plan' });
  assert.deepEqual(evs.map((e) => [format_date(e.date), e.amount_minor, e.cash_event_id, e.is_obligation]), [
    ['2026-10-10', -30000, 'D1@2026-10-10', true], ['2026-10-10', -30000, 'Y', false], ['2026-10-10', -30000, 'Z', false],
    ['2026-11-10', -30000, 'D1@2026-11-10', true], ['2026-12-10', -30000, 'D1@2026-12-10', true],
  ].filter((r) => r[0] <= '2026-11-13'));
});

test('build_events: правила и потоки — режим округления берётся из params.rounding (§14 B2): ничья 2401 мин при ×1,25 → half_even 120062, half_up 120063', () => {
  const stream = {
    stream_id: 'S', account_id: 'a', name: 'почасовка', currency: 'EUR', rate_minor: 3000, period: 'week', cutoff: { kind: 'weekday', weekday: 0 }, pay_lag_days: 1, weekend: 'next',
    calendar_id: null, hours: { min_minutes: 2401, exp_minutes: 2401, max_minutes: 2401 }, overtime: { threshold_minutes: 2400, mult_bp: 12500 },
  };
  const mk_ws = (rounding) => mini_ws({ params: { horizon_days: 12, rounding }, streams: [stream], anchors: [{ anchor_id: 'x', account_id: 'a', date: '2026-10-04', amount_minor: 0 }] });
  const first = (rounding) => build_events(mk_ws(rounding), { as_of: '2026-10-04', horizon_days: 12, mode: 'plan' }).find((e) => e.stream_id === 'S').amount_minor;
  assert.equal(first('half_even'), 120062);
  assert.equal(first('half_up'), 120063);
});

test('build_events_ex: предупреждения W_HOURS_NOT_CONFIRMED (период закрыт без факта часов), W_RULE_STALE / W_RULE_DISABLED (C-023); аллокации по налоговому правилу', () => {
  const ws = clone(G);
  delete ws.streams[0].hours_by_period;
  const r = build_events_ex(ws, { as_of: '2026-10-04', horizon_end: '2026-11-30', mode: 'plan' });
  assert.ok(r.warnings.some((w) => w.code === 'W_HOURS_NOT_CONFIRMED' && w.stream_id === 'S-HOURLY'));
  // правило проверено 2026-10-04, ttl 120: на 2027-02-02 stale (age 121), на 2027-06-02 disabled (age 241)
  const tr = { ...clone(G), tax_rules: [{ ...G.tax_rules[0], reviewed_at: '2026-10-04', ttl_days: 120 }] };
  assert.deepEqual(rule_statuses(tr, '2027-02-01'), { 'TR-20': 'fresh' });
  assert.deepEqual(rule_statuses(tr, '2027-02-02'), { 'TR-20': 'stale' });
  assert.deepEqual(rule_statuses(tr, '2027-06-02'), { 'TR-20': 'disabled' });
  assert.deepEqual(rule_statuses(tr, '2026-10-04'), { 'TR-20': 'fresh' });
  const fresh = build_events_ex(tr, { as_of: '2026-10-04', horizon_end: '2026-11-30', mode: 'plan' });
  assert.deepEqual(fresh.warnings, []);
  // as_of в будущем относительно проверки: warnings по статусу (якорь 10-04 → переносим as_of на 2027-02-02 с новым якорем)
  const late = { ...tr, anchors: [...tr.anchors, { anchor_id: 'late', account_id: 'acc_main', date: '2027-02-02', amount_minor: 100 }], facts: [] };
  const w1 = build_events_ex(late, { as_of: '2027-02-02', horizon_days: 3, mode: 'plan' }).warnings;
  assert.deepEqual(w1.map((w) => w.code).filter((c) => c.startsWith('W_RULE')), ['W_RULE_STALE']);
  const late2 = { ...late, anchors: [...late.anchors, { anchor_id: 'late2', account_id: 'acc_main', date: '2027-06-02', amount_minor: 100 }] };
  assert.deepEqual(build_events_ex(late2, { as_of: '2027-06-02', horizon_days: 3, mode: 'plan' }).warnings.map((w) => w.code).filter((c) => c.startsWith('W_RULE')), ['W_RULE_DISABLED']);
  assert.equal(r.allocations.length, 1);
});

test('build_events: правила со сдвигом выходных и override (move/skip/set_amount) — через ws.overrides; календарь по calendar_id; вхождения не сливаются в один день', () => {
  const rule = {
    rule_id: 'R', account_id: 'a', kind: 'expense', amount: { exp_minor: -100 }, currency: 'EUR', freq: 'M', interval: 1, by_monthday: [25], start_date: '2026-01-25',
    month_end: 'clamp', weekend: 'next', calendar_id: 'c', exdates: [], is_obligation: true, is_estimate: false, tag: 'r',
  };
  const ws = mini_ws({
    rules: [rule, { ...rule, rule_id: 'R2', amount: { exp_minor: -7 } }],
    calendars: [{ calendar_id: 'c', weekend_dows: [0, 6], holidays: ['2026-10-26'] }],
    overrides: [{ rule_id: 'R', nominal_date: '2026-11-25', action: 'move', date: '2026-11-27' }, { rule_id: 'R2', nominal_date: '2026-11-25', action: 'skip' }],
    anchors: [{ anchor_id: 'x', account_id: 'a', date: '2026-10-04', amount_minor: 0 }],
  });
  const evs = build_events(ws, { as_of: '2026-10-04', horizon_end: '2026-11-30', mode: 'plan' });
  // 10-25 — воскресенье, 10-26 — праздник, сдвиг next → 10-27
  assert.deepEqual(evs.map((e) => [format_date(e.date), e.cash_event_id, e.amount_minor]), [
    ['2026-10-27', 'R@2026-10-25', -100], ['2026-10-27', 'R2@2026-10-25', -7], ['2026-11-27', 'R@2026-11-25', -100],
  ].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[2] - y[2])));
  assert.equal(evs.find((e) => e.cash_event_id === 'R@2026-11-25').occ_key, 'R@2026-11-25');
  throws_code(() => build_events({ ...ws, rules: [{ ...rule, calendar_id: 'нет' }] }, { as_of: '2026-10-04', horizon_days: 5 }), 'E_SCHEMA');
});

test('normalize_ws: словари «id → запись» (как у ledger.reduce), массивы, alias planned_one_offs/fx/js, вложенные params — один и тот же результат; порядок ключей не важен', () => {
  const ws = clone(G);
  const dict = (arr, key) => Object.fromEntries(arr.map((x) => [x[key], x]));
  const as_state = {
    ...ws,
    accounts: dict(ws.accounts, 'account_id'), anchors: dict(ws.anchors, 'anchor_id'), facts: dict(ws.facts, 'event_id'), plans: dict(ws.plans, 'plan_id'),
    rules: dict(ws.rules, 'rule_id'), calendars: dict(ws.calendars, 'calendar_id'), streams: dict(ws.streams, 'stream_id'),
    tax_rules: { 'TR-20': ws.tax_rules }, reserves: dict(ws.reserves, 'reserve_id'), scenarios: dict(ws.scenarios, 'scenario_id'), overrides: {},
  };
  const q = { as_of: AS_OF, horizon_end: HZ, mode: 'worse' };
  const base = JSON.stringify(build_events_ex(ws, q));
  assert.equal(JSON.stringify(build_events_ex(as_state, q)), base);
  const reversed = { ...as_state, rules: Object.fromEntries(Object.entries(as_state.rules).reverse()) };
  assert.equal(JSON.stringify(build_events_ex(reversed, q)), base);
  const alias = { ...ws, plans: undefined, planned_one_offs: ws.plans, rates: undefined, fx: [], params: { ...ws.params, 'worse.income_delay_days': undefined, worse: { income_delay_days: 14 } } };
  assert.equal(JSON.stringify(build_events_ex(alias, q)), base);
  const js_form = { params: ws.params, decision_currency: 'EUR', js: { accounts: ws.accounts, anchors: ws.anchors, facts: ws.facts }, rules: ws.rules, calendars: ws.calendars, plans: ws.plans, streams: ws.streams, tax_rules: ws.tax_rules };
  assert.equal(JSON.stringify(build_events_ex(js_form, q)), base);
  throws_code(() => normalize_ws(null), 'E_SCHEMA');
  throws_code(() => normalize_ws({ accounts: 5 }), 'E_SCHEMA');
});

// ── подсказки по истории ──────────────────────────────────────────────────────────────────────────────────────────────

test('outflow_90 (X6, C-022): окно [as_of−90, as_of), только исходящие; без переводов, ног обмена (fx), налоговых платежей (резерв kind=tax) и is_exceptional; чужая валюта переводится по spot', () => {
  const f = (id, date, amount, extra = {}) => ({ event_id: id, account_id: 'a', date, amount_minor: amount, currency: 'EUR', ...extra });
  const ws = mini_ws({
    reserves: [{ reserve_id: 'RT', kind: 'tax', currency: 'EUR', funded_start_minor: 0, backed_by_account_id: null }, { reserve_id: 'RS', kind: 'sinking', currency: 'EUR', funded_start_minor: 0, backed_by_account_id: null }],
    accounts: [{ account_id: 'a', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 }, { account_id: 'u', kind: 'bank', liquidity: 'operating', currency: 'USD', exponent: 2 }],
    rates: [{ fx_id: 'r', date: '2026-09-01', base: 'USD', quote: 'EUR', num: 9250, den: 10000 }],
    anchors: [{ anchor_id: 'x', account_id: 'a', date: '2026-10-04', amount_minor: 0 }, { anchor_id: 'y', account_id: 'u', date: '2026-10-04', amount_minor: 0 }],
    facts: [
      f('in', '2026-07-06', -1000), // граница включительно (as_of − 90)
      f('out', '2026-07-05', -9999), // раньше окна
      f('today', '2026-10-04', -9999), // на as_of — не входит
      f('inc', '2026-08-01', 5000), // доход
      f('tr', '2026-08-02', -777, { transfer_id: 't1' }), f('fx', '2026-08-03', -888, { fx: { num: 1, den: 1 } }),
      f('tax', '2026-08-04', -2000, { reserve_id: 'RT' }), f('exc', '2026-08-05', -3000, { is_exceptional: true }),
      f('sink', '2026-08-06', -400, { reserve_id: 'RS' }), // платёж из резерва sinking — обычный расход
      { event_id: 'usd', account_id: 'u', date: '2026-08-07', amount_minor: -2000, currency: 'USD' }, // −2000 USD → −1850 EUR
    ],
  });
  assert.equal(outflow_90(ws, '2026-10-04'), 1000 + 400 + 1850);
  assert.equal(buffer_hint(ws, '2026-10-04'), Math.round((7 * 3250) / 90), 'round_div(7 · 3250, 90) = 253');
  assert.equal(outflow_90(mini_ws({ facts: [f('inc', '2026-08-01', 5000)] }), '2026-10-04'), null);
  // порог волны: max(30·10^exp, round_div(Σ, 300)); у крупных расходов порог растёт
  const big = mini_ws({ facts: [f('b', '2026-08-01', -3_000_000)] });
  assert.equal(default_wave_threshold(big, '2026-10-04'), 10000);
  assert.equal(default_wave_threshold(mini_ws(), '2026-10-04'), 3000);
  assert.equal(default_wave_threshold(mini_ws({ decision_currency: 'JPY', accounts: [{ account_id: 'a', liquidity: 'operating', currency: 'JPY', exponent: 0 }] }), '2026-10-04'), 30);
});

// ── explain_narrowest: краевые случаи ─────────────────────────────────────────────────────────────────────────────────

test('explain_narrowest: цепочка ограничена top_k и порогом накопленной доли; out_total = 0 — пустая цепочка; точка в день 0; peak − point = out_total − inflow_offset при доходах в окне', () => {
  const evs = [
    { cash_event_id: 'a', date: 1, amount_minor: -400, rule_id: 'A', tag: 'x' }, { cash_event_id: 'b', date: 2, amount_minor: -300, rule_id: 'B', tag: 'x' },
    { cash_event_id: 'c', date: 3, amount_minor: 250, stream_id: 'S', rule_id: null, tag: 'inc' }, { cash_event_id: 'd', date: 4, amount_minor: -200, tag: '' },
    { cash_event_id: 'e', date: 5, amount_minor: -100, tag: 'x' },
  ];
  const s = project(evs, 1000, 0, 6);
  const x = explain_narrowest(evs, s, {});
  // trough: 1000, 600, 300, 300 (день 3: доход после расходов; close = 550), 350, 250, 250 → min 250 на дне 5 → окно [0, 5]
  assert.deepEqual(s.trough, [1000, 600, 300, 300, 350, 250, 250]);
  assert.deepEqual(x.point, { date: 5, amount_minor: 250 });
  assert.deepEqual(x.peak, { date: 0, amount_minor: 1000 });
  assert.equal(x.out_total_minor, 1000);
  assert.equal(x.inflow_offset_minor, 250); // доход c на дне 3 — внутри окна
  assert.equal(x.peak.amount_minor - x.point.amount_minor, x.out_total_minor - x.inflow_offset_minor); // 750
  // группы: A 400, B 300, d 200 (пустой tag → cash_event_id), tag:x 100; стоп на накопленной доле 9000 bp
  assert.deepEqual(x.chain.map((c) => [c.group, c.amount_minor, c.share_bp, c.cum_bp]), [['A', 400, 4000, 4000], ['B', 300, 3000, 7000], ['d', 200, 2000, 9000]]);
  // top_k = 1
  assert.equal(explain_narrowest(evs, s, { 'explain.top_k': 1 }).chain.length, 1);
  // порог 4000 bp — достаточно первой группы; 7000 — двух
  assert.equal(explain_narrowest(evs, s, { explain: { share_cutoff_bp: 4000 } }).chain.length, 1);
  assert.equal(explain_narrowest(evs, s, { explain: { share_cutoff_bp: 7000 } }).chain.length, 2);
  // контрфакт «без A» пересчитывает ряд: минимум поднимается на 400
  const cfA = x.counterfactuals.find((c) => c.kind === 'without' && c.group === 'A');
  assert.equal(cfA.delta_minor, 400);
  // группа без rule/stream: ключ по tag; пустой tag — по cash_event_id
  const e2 = [{ cash_event_id: 'p', date: 1, amount_minor: -100, tag: 'k' }, { cash_event_id: 'q', date: 1, amount_minor: -50, tag: '' }];
  const g2 = explain_narrowest(e2, project(e2, 500, 0, 2), {}).chain.map((c) => c.group);
  assert.deepEqual(g2, ['tag:k', 'q']);
  // нет расходов в окне
  const flat = project([{ cash_event_id: 'i', date: 1, amount_minor: 50 }], 100, 0, 3);
  const none = explain_narrowest([{ cash_event_id: 'i', date: 1, amount_minor: 50 }], flat, {});
  assert.deepEqual([none.out_total_minor, none.chain, none.counterfactuals, none.point], [0, [], [], { date: 0, amount_minor: 100 }]);
  // доход в окне: пик до точки не в начале
  const inc = [{ cash_event_id: 'i', date: 1, amount_minor: 500 }, { cash_event_id: 'o', date: 3, amount_minor: -900, rule_id: 'O' }];
  const si = project(inc, 100, 0, 4);
  const xi = explain_narrowest(inc, si, {});
  assert.deepEqual(xi.peak, { date: 1, amount_minor: 600 }); // close[1]
  assert.equal(xi.out_total_minor, 900);
  assert.equal(xi.peak.amount_minor - xi.point.amount_minor, xi.out_total_minor - xi.inflow_offset_minor);
});

// ── TST-57 готовность данных ──────────────────────────────────────────────────────────────────────────────────────────

test('TST-57 readiness (D-23, §14 B3): G-001 = 4 («полный»); уровни 0…4; reasons — чего не хватает; прогноз виден при s ≥ 3, вердикт — при s ≥ 4', () => {
  assert.deepEqual(readiness(G, AS_OF), { score: 4, level: 'full', reasons: [] });
  const without = (fn) => { const w = clone(G); fn(w); return w; };
  // нет оценки повседневных (R-GROC): s = 3 — прогноз виден, Q3 нет
  const r3 = readiness(without((w) => { w.rules = w.rules.filter((r) => r.rule_id !== 'R-GROC'); }), AS_OF);
  assert.deepEqual([r3.score, r3.level, r3.reasons], [3, 'working_plus', ['no_daily_spend']]);
  assert.ok(r3.score >= TIMELINE_DEFAULTS['ready.q1'] && r3.score < TIMELINE_DEFAULTS['ready.q3']);
  // нет дохода в ближайшие 45 дней (поток убран)
  const noinc = readiness(without((w) => { w.streams = []; w.tax_rules = []; }), AS_OF);
  assert.deepEqual([noinc.score, noinc.reasons], [3, ['no_income_45d']]);
  // доход ровно через 45 дней (2026-11-18) — входит; через 46 — нет
  const inc_at = (d) => without((w) => { w.streams = []; w.tax_rules = []; w.plans.push(plan1_g('INC', d, 100000)); });
  const plan1_g = (id, date, amount) => ({ plan_id: id, account_id: 'acc_main', date, amount_minor: amount, currency: 'EUR', tag: id });
  assert.equal(readiness(inc_at('2026-11-18'), AS_OF).score, 4);
  assert.deepEqual(readiness(inc_at('2026-11-19'), AS_OF).reasons, ['no_income_45d']);
  // доход на дату as_of (она же дата якоря) входит; доход раньше якоря учтён в якоре и в поток не входит (C-004)
  assert.equal(readiness(inc_at('2026-10-04'), AS_OF).score, 4);
  assert.deepEqual(readiness(inc_at('2026-10-03'), AS_OF).reasons, ['no_income_45d']);
  // обязательств < 3 и нет значимого: оставляем только связь (2500 < θ = 3000)
  const few = readiness(without((w) => { w.rules = w.rules.filter((r) => r.rule_id === 'R-PHONE' || r.rule_id === 'R-GROC'); w.plans = []; }), AS_OF);
  assert.deepEqual([few.score, few.reasons], [3, ['obligations_lt_3']]);
  // ровно один значимый платёж — «волна»: считается
  const wave = readiness(without((w) => { w.rules = w.rules.filter((r) => r.rule_id === 'R-RENT' || r.rule_id === 'R-GROC'); w.plans = []; }), AS_OF);
  assert.equal(wave.score, 4);
  // три мелких обязательства без значимых — тоже считается («≥ 3»)
  const three = readiness(without((w) => {
    w.rules = [1, 2, 3].map((k) => ({ ...G.rules[2], rule_id: 'R-S' + k })).concat(G.rules.filter((r) => r.rule_id === 'R-GROC')); w.plans = [];
  }), AS_OF);
  assert.equal(three.score, 4);
  // пустая рабочая область
  const empty = readiness({ decision_currency: 'EUR', params: {}, accounts: [] }, AS_OF);
  assert.deepEqual(empty, { score: 0, level: 'empty', reasons: ['no_account', 'obligations_lt_3', 'no_income_45d', 'no_daily_spend'] });
  const only_acc = readiness(mini_ws(), AS_OF);
  assert.deepEqual([only_acc.score, only_acc.level], [1, 'skeleton']);
  // буфер и резервы в s не входят (C-018): без них то же
  const nobuf = readiness(without((w) => { w.params.buffer_minor = null; w.reserves = []; w.tax_rules = []; }), AS_OF);
  assert.equal(nobuf.score, 4);
});

// ── свойства (TST-31, 34, 35, 36) ─────────────────────────────────────────────────────────────────────────────────────

test('TST-31 свойство: сохранение — close[i] − close[i−1] = out_i + in_i, close[−1] = opening; trough[i] ≤ close[i−1] и ≤ close[i] (10³ случаев, seed 3101)', () => {
  const rng = make_rng(3101);
  for (let n = 0; n < 1000; n++) {
    const c = rand_case(rng);
    const s = project(c.events, c.opening, c.as_of, c.horizon_end);
    assert.equal(s.close.length, c.N);
    let prev = c.opening;
    for (let i = 0; i < c.N; i++) {
      let out = 0;
      let inn = 0;
      for (const e of c.events) if (e.date === c.as_of + i) { if (e.amount_minor < 0) out += e.amount_minor; else inn += e.amount_minor; }
      assert.equal(s.close[i] - prev, out + inn, `сохранение: случай ${n}, день ${i}`);
      assert.equal(s.trough[i], prev + out, `trough: случай ${n}, день ${i}`);
      assert.ok(s.trough[i] <= prev && s.trough[i] <= s.close[i]);
      prev = s.close[i];
    }
  }
});

test('TST-34 свойство: локальность — правка события на дату d не меняет close и trough до idx(d); trough[idx(d)] меняется только при расходе (10³ случаев, seed 3401)', () => {
  const rng = make_rng(3401);
  let checked = 0;
  for (let n = 0; n < 1000; n++) {
    const c = rand_case(rng, { max_m: 20 });
    const inside = c.events.map((e, k) => [e, k]).filter(([e]) => e.date <= c.horizon_end);
    if (inside.length === 0) continue;
    const [e, k] = rng.pick(inside);
    const bumped = c.events.map((x, j) => (j === k ? { ...x, amount_minor: Math.sign(x.amount_minor) * rng.int(1, 100000) } : x));
    const a = project(c.events, c.opening, c.as_of, c.horizon_end);
    const b = project(bumped, c.opening, c.as_of, c.horizon_end);
    const idx = e.date - c.as_of;
    for (let i = 0; i < idx; i++) { assert.equal(a.close[i], b.close[i]); assert.equal(a.trough[i], b.trough[i]); }
    if (e.amount_minor > 0) assert.equal(a.trough[idx], b.trough[idx], 'доход не меняет trough своего дня');
    // после правки изменение close одинаково на всём хвосте
    const delta = bumped[k].amount_minor - e.amount_minor;
    for (let i = idx; i < c.N; i++) assert.equal(b.close[i] - a.close[i], delta);
    checked += 1;
  }
  assert.ok(checked > 800);
});

/** Эффективные события режима для сырых «плановых» событий (как build_events, но без fx и статусов). */
function effective(events, mode, params, as_of, horizon_end) {
  const out = [];
  for (const e of events) {
    const d = eff_date({ ...e, plan_date: e.date }, mode, params, as_of);
    if (d === null || d > horizon_end) continue;
    out.push({ ...e, date: d });
  }
  return out;
}

test('TST-35 свойство: trough_worse[i] ≤ trough_plan[i] и close_worse[i] ≤ close_plan[i] при задержке ≥ 0; новый расход и удаление дохода не повышают ряды; сдвиг дохода вправо не повышает (10³ случаев, seed 3501)', () => {
  const rng = make_rng(3501);
  for (let n = 0; n < 1000; n++) {
    const c = rand_case(rng, { extra: 30 });
    // часть событий — «просроченные» (plan_date до as_of)
    const evs = c.events.map((e) => (rng.int(0, 4) === 0 ? { ...e, date: e.date - rng.int(1, 20) } : e))
      .map((e) => (e.kind === 'income' && rng.int(0, 3) === 0 ? { ...e, delay_days_worse: rng.int(0, 30) } : e));
    const P = { 'worse.income_delay_days': rng.int(0, 21) };
    const sp = project(effective(evs, 'plan', P, c.as_of, c.horizon_end), c.opening, c.as_of, c.horizon_end);
    const sw = project(effective(evs, 'worse', P, c.as_of, c.horizon_end), c.opening, c.as_of, c.horizon_end);
    for (let i = 0; i < c.N; i++) {
      assert.ok(sw.trough[i] <= sp.trough[i], `trough worse ≤ plan: случай ${n}, день ${i}`);
      assert.ok(sw.close[i] <= sp.close[i], `close worse ≤ plan: случай ${n}, день ${i}`);
    }
    // новый расход не повышает ни один ряд; удаление дохода — тоже
    const base = effective(evs, 'plan', P, c.as_of, c.horizon_end);
    const s0 = project(base, c.opening, c.as_of, c.horizon_end);
    const more = [...base, { cash_event_id: 'new', date: c.as_of + rng.int(0, c.N - 1), amount_minor: -rng.int(1, 5000) }];
    const s1 = project(more, c.opening, c.as_of, c.horizon_end);
    for (let i = 0; i < c.N; i++) { assert.ok(s1.trough[i] <= s0.trough[i]); assert.ok(s1.close[i] <= s0.close[i]); }
    const incomes = base.filter((e) => e.amount_minor > 0);
    if (incomes.length > 0) {
      const gone = rng.pick(incomes);
      const s2 = project(base.filter((e) => e !== gone), c.opening, c.as_of, c.horizon_end);
      for (let i = 0; i < c.N; i++) { assert.ok(s2.trough[i] <= s0.trough[i]); assert.ok(s2.close[i] <= s0.close[i]); }
    }
    // min trough на [as_of, D] не возрастает с ростом D
    let prev = Infinity;
    for (let d = c.as_of; d <= c.horizon_end; d += 1 + rng.int(0, 3)) { const m = answer_q1(s0, d, 0).min; assert.ok(m <= prev); prev = m; }
  }
});

test('TST-35 свойство на рабочих областях: при любом наборе плановых записей, статусов и якорей ряды worse ≤ plan и расходы по датам совпадают (build_events, 300 случаев, seed 3502)', () => {
  const rng = make_rng(3502);
  for (let n = 0; n < 300; n++) {
    const as_of = iso('2026-10-04') + rng.int(0, 200);
    const plans = Array.from({ length: rng.int(0, 15) }, (_, k) => {
      const amt = rng.int(1, 90000) * (rng.bool() ? 1 : -1);
      return plan1('P' + k, format_date(as_of + rng.int(-25, 40)), amt, rng.int(0, 5) === 0 ? { status: rng.pick(['skipped', 'cancelled']) } : (amt > 0 && rng.int(0, 3) === 0 ? { delay_days_worse: rng.int(0, 30) } : {}));
    });
    const ws = mini_ws({ plans, anchors: [{ anchor_id: 'x', account_id: 'a', date: format_date(as_of - rng.int(0, 20)), amount_minor: rng.int(0, 200000) }], facts: [], params: { horizon_days: 40 } });
    const os = opening_state(ws, as_of);
    const p = build_events(ws, { as_of, horizon_days: 40, mode: 'plan' });
    const w = build_events(ws, { as_of, horizon_days: 40, mode: 'worse' });
    const sp = project(p, os.opening_minor, as_of, as_of + 40);
    const sw = project(w, os.opening_minor, as_of, as_of + 40);
    for (let i = 0; i < 41; i++) { assert.ok(sw.trough[i] <= sp.trough[i]); assert.ok(sw.close[i] <= sp.close[i]); }
    const exp = (evs) => evs.filter((e) => e.amount_minor < 0).map((e) => [e.date, e.amount_minor, e.cash_event_id]);
    assert.deepEqual(exp(w).filter((r) => r[0] <= as_of + 40), exp(p).filter((r) => r[0] <= as_of + 40));
    assert.ok(p.every((e) => e.date >= as_of && e.plan_date !== undefined));
  }
});

test('TST-36 свойство: аддитивность — ряды base ⊎ Δ = ряды base + ряды Δ покомпонентно (close и trough), в том числе при удалении события; delay_income всех доходов на 14 в plan = ряд worse (10³ случаев, seed 3601)', () => {
  const rng = make_rng(3601);
  const add = (u, v) => u.map((x, i) => x + v[i]);
  for (let n = 0; n < 1000; n++) {
    const c = rand_case(rng, { max_m: 15 });
    const ctx = { as_of: c.as_of, horizon_end: c.horizon_end, calendars: [], default_account_id: 'a', default_currency: 'EUR' };
    const ops = [];
    for (let k = rng.int(1, 3); k > 0; k--) {
      if (rng.bool()) ops.push({ op: 'add_purchase', date: c.as_of + rng.int(0, c.N + 3), amount_minor: rng.int(1, 9000) });
      else ops.push({ op: 'add_flow', once: { date: c.as_of + rng.int(0, c.N + 3), amount_minor: rng.int(1, 9000) * (rng.bool() ? 1 : -1) } });
    }
    const out = apply_scenario(c.events, { scenario_id: 's', ops }, ctx);
    const delta = out.filter((e) => e.layer === 'hypothetical');
    assert.equal(out.length, c.events.length + delta.length);
    const total = project(out, c.opening, c.as_of, c.horizon_end);
    const b = project(c.events, c.opening, c.as_of, c.horizon_end);
    const d = project(delta, 0, c.as_of, c.horizon_end);
    assert.deepEqual(total.close, add(b.close, d.close));
    assert.deepEqual(total.trough, add(b.trough, d.trough));
    // удаление события: proj(base − e) = proj(base) − proj({e}) при том же opening
    const inside = c.events.filter((e) => e.date <= c.horizon_end);
    if (inside.length > 0) {
      const e = rng.pick(inside);
      const without = project(c.events.filter((x) => x !== e), c.opening, c.as_of, c.horizon_end);
      const only = project([e], 0, c.as_of, c.horizon_end);
      assert.deepEqual(add(without.close, only.close), b.close);
      assert.deepEqual(add(without.trough, only.trough), b.trough);
    }
  }
  // delay_income всех доходов на 14 дней в plan = режим worse (без индивидуальных задержек)
  for (let n = 0; n < 200; n++) {
    const as_of = iso('2026-10-04');
    const plans = Array.from({ length: rng.int(1, 10) }, (_, k) => plan1('P' + k, format_date(as_of + rng.int(0, 45)), rng.int(1, 9000) * (k % 3 === 0 ? 1 : -1)));
    const ws = mini_ws({ plans, anchors: [{ anchor_id: 'x', account_id: 'a', date: '2026-10-04', amount_minor: 50000 }], params: { horizon_days: 60 } });
    const incomes = plans.filter((p) => p.amount_minor > 0).map((p) => ({ op: 'delay_income', event_ref: p.plan_id, days: 14 }));
    const sc = build_events(ws, { as_of, horizon_days: 60, mode: 'plan', scenario: { scenario_id: 'd', ops: incomes } });
    const wr = build_events(ws, { as_of, horizon_days: 60, mode: 'worse' });
    const a = project(sc, 50000, as_of, as_of + 60);
    const b = project(wr, 50000, as_of, as_of + 60);
    assert.deepEqual(a.trough, b.trough);
    assert.deepEqual(a.close, b.close);
  }
});

// ── TST-53: оракул против быстрой реализации ──────────────────────────────────────────────────────────────────────────

/** Случайная «простая» рабочая область для оракула конвейера: счета (EUR, USD, JPY), курсы, якоря, факты (нечётные суммы), планы (чётные). */
function rand_sim(rng) {
  const as_of = 20000 + rng.int(0, 3000);
  const horizon_end = as_of + rng.int(3, 40);
  const cur = [['a0', 'EUR', 2], ['a1', 'USD', 2], ['a2', 'JPY', 0]].slice(0, rng.int(1, 3));
  const accounts = cur.map(([id, currency, exponent]) => ({ id, currency, exponent }));
  const rates = [];
  for (const [, currency] of cur) {
    if (currency === 'EUR') continue;
    const num = currency === 'JPY' ? rng.int(5, 9) : rng.int(7000, 13000);
    const den = currency === 'JPY' ? 1000 : 10000;
    const kind = rng.int(0, 2); // прямая, обратная или обе
    const d1 = as_of - rng.int(0, 40);
    if (kind !== 1) rates.push({ base: currency, quote: 'EUR', num, den, date: d1 });
    if (kind !== 0) rates.push({ base: 'EUR', quote: currency, num: den + rng.int(0, 9), den: num, date: d1 - (kind === 2 ? rng.int(0, 3) : 0) });
  }
  const anchors = [];
  for (const a of accounts) {
    const used = new Set();
    for (let k = rng.int(0, 2); k > 0; k--) {
      const date = as_of - rng.int(0, 60);
      if (used.has(date)) continue;
      used.add(date);
      anchors.push({ account: a.id, date, amount: rng.int(-100000, 2_000_000) });
    }
  }
  const facts = [];
  for (const a of accounts) for (let k = rng.int(0, 6); k > 0; k--) facts.push({ account: a.id, date: as_of - rng.int(0, 60), amount: (rng.int(0, 50000) * 2 + 1) * (rng.bool() ? 1 : -1) });
  const plans = Array.from({ length: rng.int(0, 20) }, (_, k) => {
    const a = rng.pick(accounts);
    const amount = rng.int(1, 50000) * 2 * (rng.bool() ? 1 : -1);
    const p = { id: 'P' + String(k).padStart(2, '0'), account: a.id, date: as_of - 30 + rng.int(0, horizon_end - as_of + 35), amount };
    if (rng.int(0, 9) === 0) p.status = rng.pick(['skipped', 'cancelled']);
    if (amount > 0 && rng.int(0, 3) === 0) p.delay = rng.int(0, 25);
    return p;
  });
  return { as_of, horizon_end, decision_currency: 'EUR', decision_exponent: 2, accounts, rates, anchors, facts, plans, worse_delay: rng.int(0, 21) };
}

function sim_to_ws(sim) {
  const rate_ws = sim.rates.map((r, k) => ({ fx_id: 'r' + k, date: format_date(r.date), base: r.base, quote: r.quote, num: r.num, den: r.den }));
  return {
    decision_currency: 'EUR',
    params: { 'worse.income_delay_days': sim.worse_delay, 'match.window_days': 3, 'match.tol_bp': 0 }, // tol 0: сопоставление невозможно (нечётные факты, чётные планы)
    accounts: sim.accounts.map((a) => ({ account_id: a.id, kind: 'bank', liquidity: 'operating', currency: a.currency, exponent: a.exponent })),
    anchors: sim.anchors.map((x, k) => ({ anchor_id: 'x' + k, account_id: x.account, date: format_date(x.date), amount_minor: x.amount })),
    facts: sim.facts.map((f, k) => ({ event_id: 'f' + k, account_id: f.account, date: format_date(f.date), amount_minor: f.amount, currency: sim.accounts.find((a) => a.id === f.account).currency })),
    plans: sim.plans.map((p) => {
      const a = sim.accounts.find((x) => x.id === p.account);
      return { plan_id: p.id, account_id: p.account, date: format_date(p.date), amount_minor: p.amount, currency: a.currency, tag: p.id, ...(p.status ? { status: p.status } : {}), ...(p.delay !== undefined ? { delay_days_worse: p.delay } : {}) };
    }),
    rates: rate_ws, rules: [], streams: [], tax_rules: [], reserves: [],
  };
}

test('TST-53 оракул A: project / answer_q1 / narrowest_point / runway_days против наивной реализации (BigInt, день за днём) — 4000 случаев, seed 5301', () => {
  const rng = make_rng(5301);
  for (let n = 0; n < 4000; n++) {
    const c = rand_case(rng, { max_n: 45, max_m: 30, max_amt: n % 10 === 0 ? 4_000_000_000_000 : 100000 });
    const fast = project(c.events, c.opening, c.as_of, c.horizon_end);
    const slow = oracle_series(c.events, c.opening, c.as_of, c.horizon_end);
    assert.deepEqual(fast.close, slow.close, `close, случай ${n}`);
    assert.deepEqual(fast.trough, slow.trough, `trough, случай ${n}`);
    const B = rng.int(0, 200000);
    for (const D of [c.as_of, c.as_of + rng.int(0, c.N - 1), c.horizon_end, c.horizon_end + 1]) {
      assert.deepEqual(answer_q1(fast, D, B), oracle_q1(slow, c.as_of, D, B), `Q1, случай ${n}, D=${D - c.as_of}`);
    }
    const a = rng.int(0, c.N - 1);
    const b = rng.int(a, c.N - 1);
    const np = narrowest_point(fast, c.as_of + a, c.as_of + b);
    let best = a;
    for (let i = a; i <= b; i++) if (slow.trough[i] < slow.trough[best]) best = i; // первое строгое «<»
    assert.deepEqual(np, { date: c.as_of + best, amount_minor: slow.trough[best] });
    assert.deepEqual(runway_days(fast, c.events), oracle_runway(c.events, c.opening, c.as_of, c.horizon_end), `runway, случай ${n}`);
  }
});

test('TST-53 оракул B: reserve_series + free_series против наивной реализации D-08 (взносы, ручные правки, релиз, true_up, аллокации от доходов) — 3000 случаев, seed 5302', () => {
  const rng = make_rng(5302);
  for (let n = 0; n < 3000; n++) {
    const c = rand_case(rng, { max_n: 40, max_m: 25, reserve_ids: ['R1', 'R2', 'R3'] });
    const k = rng.int(0, 3);
    const reserves = ['R1', 'R2', 'R3'].slice(0, k).map((id) => ({ reserve_id: id, kind: 'tax', funded_open_minor: rng.int(0, 200000), backed_by_account_id: null }));
    if (rng.int(0, 5) === 0 && reserves.length > 0) reserves.push({ reserve_id: 'RX', kind: 'sinking', funded_open_minor: 5000, backed_by_account_id: 'acc-outside' });
    const allocations = Array.from({ length: rng.int(0, 8) }, (_, j) => {
      const source = rng.pick(['income', 'schedule', 'manual', 'release']);
      const amt = rng.int(0, 60000) * (source === 'income' || source === 'schedule' ? 1 : (rng.bool() ? 1 : -1));
      return { allocation_id: 'al' + j, reserve_id: reserves.length === 0 ? 'R1' : rng.pick(reserves).reserve_id, date: c.as_of + rng.int(0, c.N - 1), amount_minor: amt, source };
    });
    const rs = reserve_series(reserves, c.events, allocations, c.as_of, c.horizon_end);
    const slow = oracle_reserves(reserves, c.events, allocations, c.as_of, c.horizon_end);
    assert.deepEqual(rs.reserve_trough, slow.reserve_trough, `reserve_trough, случай ${n}`);
    assert.deepEqual(rs.reserve_close, slow.reserve_close, `reserve_close, случай ${n}`);
    const s = project(c.events, c.opening, c.as_of, c.horizon_end);
    assert.deepEqual(free_series(s.trough, rs.reserve_trough), oracle_free(oracle_series(c.events, c.opening, c.as_of, c.horizon_end).trough, slow.reserve_trough), `free, случай ${n}`);
  }
});

test('TST-53 оракул C: конвейер opening_state → build_events → project против наивного расчёта по определениям D-01, D-04, D-20, D-22 (мультивалюта, прямые/обратные курсы, якоря, окно плана, режимы) — 3000 случаев, seed 5303', () => {
  const rng = make_rng(5303);
  for (let n = 0; n < 3000; n++) {
    const sim = rand_sim(rng);
    const ws = sim_to_ws(sim);
    const os = opening_state(ws, sim.as_of);
    for (const mode of ['plan', 'worse']) {
      const slow = oracle_pipeline(sim, sim.as_of, sim.horizon_end, mode);
      assert.equal(os.opening_minor, slow.opening, `opening, случай ${n}`);
      const evs = build_events(ws, { as_of: sim.as_of, horizon_end: sim.horizon_end, mode });
      assert.deepEqual(evs.map((e) => [e.cash_event_id, e.date, e.amount_minor]).sort(), slow.events.map((e) => [e.id, e.date, e.amount_minor]).sort(), `события ${mode}, случай ${n}`);
      const fast = project(evs, os.opening_minor, sim.as_of, sim.horizon_end);
      assert.deepEqual(fast.close, slow.close, `close ${mode}, случай ${n}`);
      assert.deepEqual(fast.trough, slow.trough, `trough ${mode}, случай ${n}`);
      for (const e of evs) assert.equal(e.date, oracle_eff_date(e.plan_date, e.kind, sim.plans.find((p) => p.id === e.cash_event_id).delay ?? sim.worse_delay, sim.as_of, mode));
    }
  }
});

// ── TST-54: производительность ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Рабочая область из `copies` одинаковых наборов правил (1 ежедневное + 3 еженедельных + 2 ежемесячных ≈ 270 вхождений за 180 дней):
 * число событий растёт линейно с `copies`, состав не меняется — масштабирование измеряется «чисто».
 */
function perf_ws(copies) {
  const rules = [];
  const base = { account_id: 'a', currency: 'EUR', interval: 1, month_end: 'clamp', weekend: 'keep', calendar_id: null, exdates: [], is_obligation: false, is_estimate: true, tag: 'p' };
  for (let c = 0; c < copies; c++) {
    rules.push({ ...base, rule_id: `D${c}`, name: 'd', kind: 'expense', amount: { exp_minor: -(100 + c) }, freq: 'D', start_date: '2026-01-01' });
    for (let k = 0; k < 3; k++) {
      const income = (c + k) % 3 === 0;
      rules.push({ ...base, rule_id: `W${c}_${k}`, name: 'w', kind: income ? 'income' : 'expense', amount: { exp_minor: (income ? 1 : -1) * (1000 + 7 * c + k) }, freq: 'W', by_weekday: [(c + k) % 7], start_date: '2026-01-04' });
    }
    for (let k = 0; k < 2; k++) rules.push({ ...base, rule_id: `M${c}_${k}`, name: 'm', kind: 'expense', amount: { exp_minor: -(5000 + 11 * c + k) }, freq: 'M', by_monthday: [1 + ((c * 5 + k * 9) % 28)], start_date: '2026-01-01', is_obligation: true, is_estimate: false });
  }
  return mini_ws({
    rules, params: { horizon_days: 180 },
    anchors: [{ anchor_id: 'x', account_id: 'a', date: '2026-10-04', amount_minor: 5_000_000 }],
    reserves: [{ reserve_id: 'RT', kind: 'tax', currency: 'EUR', funded_start_minor: 100000, backed_by_account_id: null }],
  });
}

function full_recompute(ws, as_of) {
  const os = opening_state(ws, as_of);
  const out = {};
  for (const mode of ['plan', 'worse']) {
    const bx = build_events_ex(ws, { as_of, horizon_days: 180, mode });
    const s = project(bx.events, os.opening_minor, as_of, as_of + 180);
    const rs = reserve_series(ws.reserves.map((r) => ({ ...r, funded_open_minor: r.funded_start_minor })), bx.events, bx.allocations, as_of, as_of + 180);
    out[mode] = { bx, s, free: free_series(s.trough, rs.reserve_trough), q1: answer_q1(s, as_of + 180, 50000) };
  }
  explain_narrowest(out.worse.bx.events, out.worse.s, ws.params);
  return out;
}

const ms = (f) => {
  const t0 = performance.now();
  f();
  return performance.now() - t0;
};
const percentile = (xs, q) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((q * xs.length) / 100) - 1)];

// FP-23 (REQ-151): название приведено в соответствие с проверкой. Эта проверка МЯГКАЯ (≈540 → ≈1080 событий ≤ ×3; ≈540 → ≈2160 ≤ ×6,25 = 2,5²; минимум по повторам, до пяти попыток);
// строгая проверка критерия «не более ×2,5 на КАЖДОЕ удвоение на точках 10³, 2·10³, 4·10³ событий» — в tests/bench_compare.test.mjs.
test('TST-54 производительность: N·M = 180 · 10³ — полный пересчёт (два режима, ряды, резервы, Q1, объяснение) p95 ≤ 100 мс; project при M = 10³ — доли мс; мягкая проверка роста при удвоении N (≤ ×3 и ≤ ×6,25 на два удвоения; строгая ≤ ×2,5 — в bench_compare)', () => {
  const ws = perf_ws(4);
  const as_of = AS_OF;
  const counts = build_events(ws, { as_of, horizon_days: 180, mode: 'plan' }).length;
  assert.ok(counts >= 900 && counts <= 1250, `ожидалось ≈ 10³ событий, получено ${counts}`);
  // Лучший из трёх раундов по 30 замеров (после прогрева): одиночные паузы сборщика мусора и конкуренция за процессор на общей машине
  // — шум измерения, не свойство алгоритма; бюджет ADR-014 — p95 ≤ 100 мс.
  let best = null;
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 5; i++) full_recompute(ws, as_of);
    const times = Array.from({ length: 30 }, () => ms(() => full_recompute(ws, as_of)));
    const r = { p50: percentile(times, 50), p95: percentile(times, 95), n: times.length };
    if (best === null || r.p95 < best.p95) best = r;
    if (best.p95 <= 100) break;
  }
  assert.ok(best.p95 <= 100, `p95 полного пересчёта ${best.p95.toFixed(1)} мс (p50 ${best.p50.toFixed(1)} мс, n = ${best.n}) > 100 мс`);
  // project отдельно: 10³ событий, H = 180
  const evs = build_events(ws, { as_of, horizon_days: 180, mode: 'worse' });
  for (let i = 0; i < 50; i++) project(evs, 5_000_000, as_of, as_of + 180);
  const tp = Array.from({ length: 200 }, () => ms(() => project(evs, 5_000_000, as_of, as_of + 180)));
  assert.ok(percentile(tp, 50) <= 5, `project p50 ${percentile(tp, 50).toFixed(2)} мс`);
  // масштабирование: при каждом удвоении N время растёт не более чем в 2,5 раза. Два удвоения (≈540 → ≈2160 событий) усредняют шум:
  // ≤ 2,5² = 6,25. Берём минимум по повторам (устойчив к выбросам) и до пяти попыток: сверхлинейный (например, квадратичный) алгоритм
  // не пройдёт ни одну, а нагрузка на общей машине, искажающая замер, бывает разовой.
  const w2 = perf_ws(2);
  const w8 = perf_ws(8);
  const min_of = (w) => Math.min(...Array.from({ length: 15 }, () => ms(() => full_recompute(w, as_of))));
  min_of(w2); min_of(ws); min_of(w8); // прогрев
  let last = '';
  let ok = false;
  for (let attempt = 0; attempt < 5 && !ok; attempt++) {
    const t2 = min_of(w2);
    const t4 = min_of(ws);
    const t8 = min_of(w8);
    last = `≈540 событий: ${t2.toFixed(2)} мс, ≈1080: ${t4.toFixed(2)} мс, ≈2160: ${t8.toFixed(2)} мс`;
    ok = t8 / t2 <= 6.25 && t4 / t2 <= 3;
  }
  assert.ok(ok, `рост времени при удвоении N выше мягкого допуска (≤ ×3 на первое удвоение, ≤ ×6,25 на два) (${last})`);
});

// ── детерминизм (TST-33, часть) ───────────────────────────────────────────────────────────────────────────────────────

test('TST-33 (часть): тот же ws и query — побайтно тот же результат build_events_ex / project / explain; перестановка записей входа не меняет ряды', () => {
  const rng = make_rng(3301);
  for (let n = 0; n < 100; n++) {
    const sim = rand_sim(rng);
    const ws = sim_to_ws(sim);
    const q = { as_of: sim.as_of, horizon_end: sim.horizon_end, mode: rng.bool() ? 'plan' : 'worse' };
    const a = JSON.stringify(build_events_ex(ws, q));
    assert.equal(JSON.stringify(build_events_ex(clone(ws), q)), a);
    const shuffled = { ...ws, plans: [...ws.plans].reverse(), facts: [...ws.facts].reverse(), anchors: [...ws.anchors].reverse(), rates: [...ws.rates].reverse() };
    assert.equal(JSON.stringify(build_events_ex(shuffled, q)), a, 'порядок записей не влияет');
    const os = opening_state(ws, sim.as_of);
    assert.deepEqual(opening_state(shuffled, sim.as_of), os);
  }
});
