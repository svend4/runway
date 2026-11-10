// calibration.test.mjs — ALG-13 (v1: сопоставление, статусы, свежесть; v2: лаги, малые выборки, Уилсон).
// Покрывает: TST-32 (часть: идемпотентность и порядок сопоставления), TST-40, TST-41, TST-50, TST-57 (часть: unlogged_rate, stale_status), TST-49 (часть: nearest_rank, Уилсон).
// Ожидаемые числа — ДОСЛОВНО из design-brief §9.13, ALG-13 «Тест-векторы» (TV-1…TV-5) и 11-testing-strategy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse_date } from '../engine/dates.mjs';
import {
  CALIBRATION_DEFAULTS, dev_class, match_plan_to_fact, classify_occurrence, assign_statuses, flow_key, unlogged_rate,
  stale_status, lag_observations, nearest_rank, ewma, shrink_to_prior, flow_calibration, expected_lag, wilson,
} from '../engine/calibration.mjs';
import { make_rng, throws_code } from './helpers.mjs';

const D = (iso) => parse_date(iso);
const PARAMS = { 'match.window_days': 3, 'match.tol_bp': 500, 'grace_days.income': 3, 'grace_days.expense': 0 };

/** План аренды G-001: −90000 на 2026-11-25. */
const rent = (over = {}) => ({
  layer: 'planned', occ_key: 'R-RENT@2026-11-25', cash_event_id: 'R-RENT@2026-11-25', rule_id: 'R-RENT', account_id: 'acc_main', currency: 'EUR',
  date: D('2026-11-25'), amount_minor: -90000, status: 'expected', ...over,
});
const fact = (id, iso, amount, over = {}) => ({
  layer: 'posted', cash_event_id: id, account_id: 'acc_main', currency: 'EUR', date: D(iso), amount_minor: amount, ...over,
});

test('значения по умолчанию совпадают с vocab.json (§2.0, N5)', () => {
  const vocab = JSON.parse(fs.readFileSync(new URL('../engine/vocab.json', import.meta.url), 'utf8'));
  for (const [k, v] of Object.entries(CALIBRATION_DEFAULTS)) {
    assert.equal(vocab.params[k].default, v, `vocab.params[${k}].default`);
  }
});

// ── dev_class ─────────────────────────────────────────────────────────────────

test('dev_class: границы допуска целочисленные — ровно tol это in_tol, ровно 2·tol это near (TV-1)', () => {
  const p = rent();
  assert.equal(dev_class(-90000, p, 500), 'in_tol');
  assert.equal(dev_class(-94500, p, 500), 'in_tol', '4500·10000 = 500·90000 — граница включительно');
  assert.equal(dev_class(-94501, p, 500), 'near');
  assert.equal(dev_class(-95000, p, 500), 'near');
  assert.equal(dev_class(-99000, p, 500), 'near', '9000·10000 = 2·500·90000 — граница near');
  assert.equal(dev_class(-99001, p, 500), 'far');
  assert.equal(dev_class(-100000, p, 500), 'far');
  assert.equal(dev_class(-85500, p, 500), 'in_tol', 'меньше плана — симметрично');
  assert.equal(dev_class(90000, p, 500), 'in_tol', 'знак не участвует: сравниваются модули (знак проверяет вызывающий)');
});

test('dev_class: коридор плана [amount_min, amount_max] даёт in_tol независимо от допуска (S-HOURLY)', () => {
  const p = { amount_minor: 279000, amount_min_minor: 240000, amount_max_minor: 330000 };
  assert.equal(dev_class(270000, p, 500), 'in_tol');
  assert.equal(dev_class(330000, p, 500), 'in_tol', 'граница коридора включительно');
  assert.equal(dev_class(330001, p, 500), 'far');
  assert.equal(dev_class(239999, p, 500), 'far');
  // коридор в «обратном» порядке и со знаком — min/max берутся по модулю
  const q = { amount_minor: -279000, amount_min_minor: -330000, amount_max_minor: -240000 };
  assert.equal(dev_class(-300000, q, 0), 'in_tol');
});

test('dev_class: большие суммы без потери точности (BigInt), нулевой план', () => {
  const big = 9007199254740991;
  assert.equal(dev_class(big, { amount_minor: big }, 0), 'in_tol');
  assert.equal(dev_class(big - 1, { amount_minor: big }, 0), 'far');
  assert.equal(dev_class(0, { amount_minor: 0 }, 500), 'in_tol');
  assert.equal(dev_class(1, { amount_minor: 0 }, 500), 'far');
  throws_code(() => dev_class(1.5, { amount_minor: 100 }, 500), 'E_NOT_INTEGER');
  throws_code(() => dev_class(1, { amount_minor: 100 }, -1), 'E_SCHEMA');
});

// ── TST-40: сопоставление ─────────────────────────────────────────────────────

test('TST-40 TV-1: аренда −90000 на 11-25, факты на 11-27 — matched / matched / двойник / не сопоставлен', () => {
  const p = rent();
  const cases = [
    { amount: -90000, kind: 'matched', ratio: 10000 },
    { amount: -94500, kind: 'matched', ratio: 10500 },
    { amount: -95000, kind: 'double' },
    { amount: -100000, kind: 'unmatched' },
  ];
  for (const c of cases) {
    const f = fact('F1', '2026-11-27', c.amount);
    const r = match_plan_to_fact([p], [f], PARAMS);
    if (c.kind === 'matched') {
      assert.equal(r.matches.length, 1, `${c.amount}: matched`);
      assert.equal(r.matches[0].by, 'auto');
      assert.deepEqual(r.matches[0].facts, [f]);
      assert.equal(r.doubles.length + r.unmatched_facts.length + r.unmatched_plans.length, 0);
      const obs = lag_observations(r.matches);
      assert.deepEqual(obs['R-RENT'], { lags: [2], ratios_bp: [c.ratio] }, 'lag = 2, ratio_bp по канону');
    } else if (c.kind === 'double') {
      assert.equal(r.matches.length, 0);
      assert.equal(r.doubles.length, 1);
      assert.equal(r.doubles[0].reason, 'near_tolerance');
      assert.deepEqual(r.doubles[0].candidates, [p]);
      assert.equal(r.unmatched_plans.length, 0, 'план в очереди не считается «несопоставленным»');
    } else {
      assert.equal(r.matches.length + r.doubles.length, 0);
      assert.deepEqual(r.unmatched_facts, [f]);
      assert.deepEqual(r.unmatched_plans, [p]);
    }
  }
});

test('TST-40: два плана в окне у одного факта — очередь ambiguous; два факта на один план — оба contested', () => {
  const p1 = rent();
  const p2 = rent({ occ_key: 'R-RENT2@2026-11-26', cash_event_id: 'R-RENT2@2026-11-26', rule_id: 'R-RENT2', date: D('2026-11-26') });
  const f = fact('F1', '2026-11-27', -90000);
  const r = match_plan_to_fact([p1, p2], [f], PARAMS);
  assert.equal(r.matches.length, 0);
  assert.equal(r.doubles.length, 1);
  assert.equal(r.doubles[0].reason, 'ambiguous');
  assert.deepEqual(r.doubles[0].candidates.map((x) => x.occ_key), ['R-RENT@2026-11-25', 'R-RENT2@2026-11-26'], 'кандидаты по (date, occ_key)');

  const fa = fact('FA', '2026-11-26', -90000);
  const fb = fact('FB', '2026-11-27', -90000);
  const r2 = match_plan_to_fact([p1], [fa, fb], PARAMS);
  assert.equal(r2.matches.length, 0);
  assert.deepEqual(r2.doubles.map((d) => d.reason), ['contested', 'contested']);
  assert.deepEqual(r2.doubles.map((d) => d.fact.cash_event_id), ['FA', 'FB']);
});

test('TST-40: окно включительно (±3), другой счёт, валюта, знак — не кандидат', () => {
  const p = rent();
  const at = (iso, over = {}) => match_plan_to_fact([p], [fact('F', iso, -90000, over)], PARAMS);
  assert.equal(at('2026-11-28').matches.length, 1, '+3 — кандидат');
  assert.equal(at('2026-11-22').matches.length, 1, '−3 — кандидат');
  assert.equal(at('2026-11-29').unmatched_facts.length, 1, '+4 — не кандидат');
  assert.equal(at('2026-11-21').unmatched_facts.length, 1, '−4 — не кандидат');
  assert.equal(at('2026-11-27', { account_id: 'acc_other' }).unmatched_facts.length, 1, 'другой счёт');
  assert.equal(at('2026-11-27', { currency: 'USD' }).unmatched_facts.length, 1, 'другая валюта');
  assert.equal(at('2026-11-27').matches.length, 1);
  const r = match_plan_to_fact([p], [fact('F', '2026-11-27', 90000)], PARAMS);
  assert.equal(r.unmatched_facts.length, 1, 'другой знак — не кандидат');
});

test('TST-40: доход S-HOURLY +279000 на 11-05, факт +270000 на 11-07 → matched (допуск и коридор), lag 2, ratio 9677', () => {
  const p = {
    layer: 'planned', occ_key: 'S-HOURLY@2026-11-05', cash_event_id: 'S-HOURLY@2026-11-05', stream_id: 'S-HOURLY', rule_id: null,
    account_id: 'acc_main', currency: 'EUR', date: D('2026-11-05'), amount_minor: 279000, amount_min_minor: 240000, amount_max_minor: 330000, status: 'expected',
  };
  const f = fact('F-IN', '2026-11-07', 270000);
  const r = match_plan_to_fact([p], [f], PARAMS);
  assert.equal(r.matches.length, 1);
  // d = 9000 → 90 000 000 ≤ 500·279000 = 139 500 000 (допуск выполнен и без коридора)
  assert.equal(dev_class(270000, { amount_minor: 279000 }, 500), 'in_tol');
  assert.deepEqual(lag_observations(r.matches)['S-HOURLY'], { lags: [2], ratios_bp: [9677] });
  assert.equal(flow_key(p), 'S-HOURLY', 'поток: rule_id = null → stream_id');
});

test('TST-40: статусы matched / skipped / cancelled в сопоставлении не участвуют (идемпотентность)', () => {
  const f = fact('F', '2026-11-27', -90000);
  for (const status of ['matched', 'skipped', 'cancelled']) {
    const r = match_plan_to_fact([rent({ status })], [f], PARAMS);
    assert.equal(r.matches.length, 0, status);
    assert.deepEqual(r.unmatched_facts, [f]);
    assert.equal(r.unmatched_plans.length, 0);
  }
  const r2 = match_plan_to_fact([rent({ status: 'overdue' })], [f], PARAMS);
  assert.equal(r2.matches.length, 1, 'overdue участвует');
  assert.equal(match_plan_to_fact([rent()], [{ ...f, no_plan: true }], PARAMS).matches.length, 0, 'no_plan исключает факт');
});

test('TST-40: связь, подтверждённая пользователем (plan_ref): полный платёж → matches by user; частичный → partials и остаток', () => {
  const p = rent();
  // факт вне окна и вне допуска, но связан пользователем
  const full = fact('FU', '2026-12-20', -90000, { plan_ref: 'R-RENT@2026-11-25' });
  const r = match_plan_to_fact([p], [full], PARAMS);
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].by, 'user');
  assert.equal(r.unmatched_facts.length, 0);

  // переплата — тоже закрывает план
  const over = fact('FO', '2026-11-26', -120000, { plan_ref: 'R-RENT@2026-11-25' });
  assert.equal(match_plan_to_fact([p], [over], PARAMS).matches[0].by, 'user');

  // частичный платёж: −40000 из −90000 → остаток −50000
  const part = fact('FP', '2026-11-26', -40000, { plan_ref: 'R-RENT@2026-11-25' });
  const r2 = match_plan_to_fact([p], [part], PARAMS);
  assert.equal(r2.matches.length, 0);
  assert.equal(r2.partials.length, 1);
  assert.equal(r2.partials[0].residual, -50000);
  assert.deepEqual(r2.partials[0].facts, [part]);
  assert.equal(r2.unmatched_plans.length, 0, 'план в partials не дублируется в unmatched_plans');

  // остаток ещё может сопоставиться с новым фактом (−50000 на 11-27)
  const rest = fact('FR', '2026-11-27', -50000);
  const r3 = match_plan_to_fact([p], [part, rest], PARAMS);
  assert.equal(r3.matches.length, 1);
  assert.equal(r3.matches[0].plan.amount_minor, -50000, 'сопоставляется остаток');
  assert.equal(r3.partials.length, 1);

  // факт, связанный с планом вне очереди, не уходит на «чужой» план
  const other = rent({ occ_key: 'R-X@2026-11-26', cash_event_id: 'R-X@2026-11-26', rule_id: 'R-X', date: D('2026-11-26') });
  const claimed = fact('FC', '2026-11-26', -90000, { plan_ref: 'R-RENT@2026-10-26' });
  const r4 = match_plan_to_fact([other], [claimed], PARAMS);
  assert.equal(r4.matches.length, 0);
  assert.deepEqual(r4.unmatched_facts, [claimed]);
});

test('TST-40 / TST-32 инвариант 1: каждый факт — ровно в одной из групп, каждый план — не более чем в одной паре (на случайных входах)', () => {
  const rng = make_rng(13);
  for (let trial = 0; trial < 300; trial++) {
    const plans = [];
    const facts = [];
    const n_plans = rng.int(0, 6);
    const n_facts = rng.int(0, 7);
    for (let i = 0; i < n_plans; i++) {
      const day = D('2026-11-20') + rng.int(0, 6);
      plans.push(rent({ occ_key: `R${i}@${day}`, cash_event_id: `R${i}@${day}`, rule_id: `R${i}`, date: day, amount_minor: rng.pick([-90000, -90000, -50000, 120000]) }));
    }
    for (let i = 0; i < n_facts; i++) {
      facts.push(fact(`F${i}`, '2026-11-20', rng.pick([-90000, -94500, -95000, -100000, -50000, 120000, 119000]), { date: D('2026-11-20') + rng.int(0, 9) }));
    }
    const r = match_plan_to_fact(plans, facts, PARAMS);
    const seen = new Map();
    const touch = (f) => seen.set(f.cash_event_id, (seen.get(f.cash_event_id) ?? 0) + 1);
    r.matches.forEach((m) => m.facts.forEach(touch));
    r.partials.forEach((m) => m.facts.forEach(touch));
    r.doubles.forEach((d) => touch(d.fact));
    r.unmatched_facts.forEach(touch);
    for (const f of facts) assert.equal(seen.get(f.cash_event_id), 1, `факт ${f.cash_event_id} — ровно в одной группе (trial ${trial})`);
    const plan_pairs = new Map();
    for (const m of r.matches) plan_pairs.set(m.plan.occ_key, (plan_pairs.get(m.plan.occ_key) ?? 0) + 1);
    for (const [k, c] of plan_pairs) assert.equal(c, 1, `план ${k} — не более одной пары`);
    // порядок входов не влияет
    const r2 = match_plan_to_fact(shuffle(plans, rng), shuffle(facts, rng), PARAMS);
    assert.deepEqual(r2, r, `результат не зависит от порядка (trial ${trial})`);
  }
});

function shuffle(xs, rng) {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = rng.int(0, i); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

test('TST-32: повторное сопоставление после assign_statuses даёт тот же набор пар и ничего нового', () => {
  const plans = [rent(), rent({ occ_key: 'R-UTIL@2026-11-25', cash_event_id: 'R-UTIL@2026-11-25', rule_id: 'R-UTIL', amount_minor: -12000 })];
  const facts = [fact('F1', '2026-11-27', -90000), fact('F2', '2026-11-25', -12000)];
  const r1 = match_plan_to_fact(plans, facts, PARAMS);
  assert.equal(r1.matches.length, 2);
  const after = assign_statuses(plans, facts, D('2026-11-30'), PARAMS);
  assert.deepEqual(after.map((p) => p.status), ['matched', 'matched']);
  // повторный вызов на уже сопоставленных планах: пар нет, факты остаются несопоставленными (идемпотентно, двойного учёта нет)
  const r2 = match_plan_to_fact(after, facts, PARAMS);
  assert.equal(r2.matches.length, 0);
  assert.equal(r2.unmatched_facts.length, 2);
  // assign_statuses идемпотентна
  assert.deepEqual(assign_statuses(after, facts, D('2026-11-30'), PARAMS), after);
  // и не мутирует вход
  assert.equal(plans[0].status, 'expected');
});

// ── TST-41: жизненный цикл ────────────────────────────────────────────────────

test('TST-41 TV-2: доход 2026-10-15 — as_of 10-18 expected, 10-19 overdue; S-HOURLY 11-05 — 11-08 expected, 11-09 overdue', () => {
  const inc = { layer: 'planned', occ_key: 'X@2026-10-15', account_id: 'a', currency: 'EUR', date: D('2026-10-15'), amount_minor: 100000, status: 'expected' };
  assert.equal(classify_occurrence(inc, D('2026-10-18'), PARAMS), 'expected', 'date + grace == as_of → expected');
  assert.equal(classify_occurrence(inc, D('2026-10-19'), PARAMS), 'overdue');
  const hourly = { ...inc, occ_key: 'S-HOURLY@2026-11-05', date: D('2026-11-05'), amount_minor: 279000 };
  assert.equal(classify_occurrence(hourly, D('2026-11-08'), PARAMS), 'expected');
  assert.equal(classify_occurrence(hourly, D('2026-11-09'), PARAMS), 'overdue');
  // расход: grace = 0 → просрочен со следующего дня
  const out = { ...inc, amount_minor: -5000 };
  assert.equal(classify_occurrence(out, D('2026-10-15'), PARAMS), 'expected');
  assert.equal(classify_occurrence(out, D('2026-10-16'), PARAMS), 'overdue');
});

test('TST-41: терминальные статусы не меняются; монотонность overdue; ISO-даты принимаются', () => {
  const base = { layer: 'planned', occ_key: 'X', account_id: 'a', currency: 'EUR', date: D('2026-10-15'), amount_minor: -100 };
  for (const status of ['matched', 'skipped', 'cancelled']) assert.equal(classify_occurrence({ ...base, status }, D('2030-01-01'), PARAMS), status);
  let was_overdue = false;
  for (let d = D('2026-10-10'); d < D('2026-10-30'); d++) {
    const s = classify_occurrence({ ...base, status: 'expected' }, d, PARAMS);
    if (was_overdue) assert.equal(s, 'overdue', 'overdue остаётся overdue при любом as_of′ ≥ as_of');
    if (s === 'overdue') was_overdue = true;
  }
  assert.equal(classify_occurrence({ ...base, date: '2026-10-15' }, '2026-10-16', PARAMS), 'overdue');
  // параметры можно задать вложенными объектами
  assert.equal(classify_occurrence({ ...base, amount_minor: 100, status: 'expected' }, D('2026-10-20'), { grace_days: { income: 10 } }), 'expected');
});

test('assign_statuses: matched / expected / overdue и остаток частично оплаченного плана', () => {
  const as_of = D('2026-11-30');
  const plans = [
    rent(),
    rent({ occ_key: 'R-UTIL@2026-11-25', cash_event_id: 'R-UTIL@2026-11-25', rule_id: 'R-UTIL', amount_minor: -12000 }),
    rent({ occ_key: 'R-FUT@2026-12-05', cash_event_id: 'R-FUT@2026-12-05', rule_id: 'R-FUT', date: D('2026-12-05'), amount_minor: -3000 }),
    rent({ occ_key: 'R-DONE', cash_event_id: 'R-DONE', rule_id: 'R-DONE', status: 'skipped' }),
  ];
  const facts = [
    fact('F1', '2026-11-27', -90000),
    fact('FP', '2026-11-26', -5000, { plan_ref: 'R-UTIL@2026-11-25' }),
  ];
  const out = assign_statuses(plans, facts, as_of, PARAMS);
  assert.deepEqual(out.map((p) => p.status), ['matched', 'overdue', 'expected', 'skipped']);
  assert.equal(out[1].amount_minor, -7000, 'остаток частично оплаченного = −12000 − (−5000)');
  assert.equal(out[0].amount_minor, -90000, 'сопоставленный план сумму не меняет');
  assert.equal(plans[1].amount_minor, -12000, 'вход не мутируется');
});

// ── TST-57 (часть): свежесть ──────────────────────────────────────────────────

test('TST-57 TV-5: unlogged_rate и stale_status (7 → fresh, 9 → banner 12150, 22 → block)', () => {
  const rate = unlogged_rate([{ drift_minor: 8400, days: 7 }, { drift_minor: 15000, days: 10 }]);
  assert.equal(rate, 1350, 'round_div(1200 + 1500, 2) = 1350');
  assert.deepEqual(stale_status(7, rate, PARAMS), { level: 'fresh', unaccounted_minor: 9450 });
  assert.equal(stale_status(8, rate, PARAMS).level, 'banner');
  assert.deepEqual(stale_status(9, rate, PARAMS), { level: 'banner', unaccounted_minor: 12150 });
  assert.equal(stale_status(21, rate, PARAMS).level, 'banner', 'age = 21 — ещё banner (block при age > 21)');
  assert.deepEqual(stale_status(22, rate, PARAMS), { level: 'block', reason: 'stale', unaccounted_minor: 29700 });
  assert.deepEqual(stale_status(null, rate, PARAMS), { level: 'block', reason: 'no_anchor', unaccounted_minor: null });
  assert.equal(stale_status(0, null, PARAMS).unaccounted_minor, null, 'нет истории дрейфа → неизвестно');
  throws_code(() => stale_status(-1, 1, PARAMS), 'E_SCHEMA');
});

test('unlogged_rate: пусто и days = 0 → null / пропуск; нечётное число — серединное; знак дрейфа не важен', () => {
  assert.equal(unlogged_rate([]), null);
  assert.equal(unlogged_rate([{ drift_minor: 500, days: 0 }]), null, 'days = 0 пропускается');
  assert.equal(unlogged_rate([{ drift_minor: -1200, days: 1 }, { drift_minor: 100, days: 1 }, { drift_minor: 900, days: 3 }]), 300);
  assert.equal(unlogged_rate([{ drift_minor: 5, days: 2 }]), 2, 'half_even: 2,5 → 2');
  assert.equal(unlogged_rate([{ drift_minor: 7, days: 2 }]), 4, 'half_even: 3,5 → 4');
  assert.ok(unlogged_rate([{ drift_minor: -999, days: 3 }]) >= 0, 'unlogged_rate ≥ 0');
  // инвариант 9: unaccounted растёт с age
  let prev = -1;
  for (let age = 0; age < 30; age++) {
    const u = stale_status(age, 1350, PARAMS).unaccounted_minor;
    assert.ok(u >= prev);
    prev = u;
  }
});

// ── TST-50 и v2: калибровка ───────────────────────────────────────────────────

test('TST-50 TV-3: лаги [0,3,7,5,14,6,2,9] — p50 = 5, p80 = 9, p90 = 14 («наибольшее из 8»), ewma = 6 261 581, shrink = 6, expected_ready = false', () => {
  const lags = [0, 3, 7, 5, 14, 6, 2, 9];
  const sorted = [...lags].sort((a, b) => a - b);
  assert.deepEqual(sorted, [0, 2, 3, 5, 6, 7, 9, 14]);
  assert.equal(nearest_rank(sorted, 50), 5);
  assert.equal(nearest_rank(sorted, 80), 9);
  assert.equal(nearest_rank(sorted, 90), 14);
  assert.equal(ewma(lags, 3000), 6261581);
  assert.equal(shrink_to_prior(5, 8, 7, 3), 6, 'round_div(8·5 + 3·7, 11) = round_div(61, 11)');
  const cal = flow_calibration(lags, [10000, 10500, 9700, 10000, 9000, 10000, 10100, 9900]);
  assert.equal(cal.n, 8);
  assert.equal(cal.p50, 5);
  assert.equal(cal.p80, 9);
  assert.equal(cal.p90, 14);
  assert.equal(cal.p90_label, 'наибольшее из 8');
  assert.equal(cal.ewma_days, 6);
  assert.equal(cal.shrunk_days, 6);
  assert.equal(cal.expected_ready, false, 'n = 8 < 10');
  assert.equal(expected_lag(cal), null, 'режим expected как plan');
  assert.ok(Number.isInteger(cal.ratio_ewma_bp));
});

test('TST-50 TV-3: n = 10 (добавлены лаги 4 и 8) — p50 = 5, expected_ready, expected_lag = 5 (доход 11-05 → 11-10)', () => {
  const lags = [0, 3, 7, 5, 14, 6, 2, 9, 4, 8];
  const cal = flow_calibration(lags, []);
  assert.equal(cal.n, 10);
  assert.equal(cal.p50, 5, 'sorted [0,2,3,4,5,6,7,8,9,14], индекс ceil_div(500, 100) − 1 = 4');
  assert.equal(cal.p90_label, null, 'ceil(0,9·10) = 9 ≠ 10 — подписи нет');
  assert.equal(cal.expected_ready, true);
  assert.equal(expected_lag(cal), 5);
  assert.equal(D('2026-11-05') + expected_lag(cal), D('2026-11-10'));
  assert.equal(cal.ratio_ewma_bp, null, 'ratios не заданы');
});

test('TST-50 C-052: новый клиент [10, 12] — p50 по nearest-rank = 10, shrink = round_div(2·10 + 3·7, 5) = 8 (не 9)', () => {
  const cal = flow_calibration([10, 12], []);
  assert.equal(cal.p50, 10);
  assert.equal(shrink_to_prior(cal.p50, 2, 7, 3), 8);
  assert.equal(cal.shrunk_days, 8);
});

test('TST-50: вырожденные выборки — n = 0, n = 1 (ewma = x, p50 = p90 = x, «наибольшее из 1»)', () => {
  assert.deepEqual(flow_calibration([], []), { n: 0 });
  const one = flow_calibration([4], [10000]);
  assert.equal(one.n, 1);
  assert.equal(one.ewma_days, 4);
  assert.equal(one.p50, 4);
  assert.equal(one.p90, 4);
  assert.equal(one.p90_label, 'наибольшее из 1');
  assert.equal(one.expected_ready, false);
  assert.equal(one.ratio_ewma_bp, 10000);
  assert.equal(shrink_to_prior(null, 0, 7, 3), 7, 'n = 0 → prior');
});

test('TST-50 инварианты 5–6 (свойства): p50 ≤ p80 ≤ p90, значения из выборки, min ≤ ewma ≤ max, shrink между median и prior, приближается к median', () => {
  const rng = make_rng(50);
  for (let t = 0; t < 400; t++) {
    const n = rng.int(1, 40);
    const lags = Array.from({ length: n }, () => rng.int(-3, 30));
    const cal = flow_calibration(lags, []);
    assert.ok(cal.p50 <= cal.p80 && cal.p80 <= cal.p90);
    for (const q of [cal.p50, cal.p80, cal.p90]) assert.ok(lags.includes(q), 'квантиль nearest-rank принадлежит выборке');
    const e = ewma(lags, 3000);
    assert.ok(Math.min(...lags) * 1e6 <= e && e <= Math.max(...lags) * 1e6, 'min ≤ ewma ≤ max');
    const lo = Math.min(cal.p50, 7);
    const hi = Math.max(cal.p50, 7);
    assert.ok(cal.shrunk_days >= lo && cal.shrunk_days <= hi, 'shrink лежит между median и prior');
  }
  // рост n при фиксированной медиане приближает shrink к median
  assert.ok(Math.abs(shrink_to_prior(2, 1000, 7, 3) - 2) <= Math.abs(shrink_to_prior(2, 2, 7, 3) - 2));
});

test('ewma: ничья округления half_even (1e6/2^7 = 7812,5 → 7812) и точные значения', () => {
  assert.equal(ewma([1, 0, 0, 0, 0, 0, 0, 0], 5000), 7812, 's_7 = 7812,5 → к чётному');
  assert.equal(ewma([1, 0], 5000), 500000);
  assert.equal(ewma([5], 3000), 5000000, 'одно наблюдение: ewma = x');
  assert.equal(ewma([0, 10], 10000), 10000000, 'alpha = 100 % → последнее значение');
  assert.equal(ewma([0, 10], 0), 0, 'alpha = 0 → первое значение');
});

test('nearest_rank: края и ошибки', () => {
  assert.equal(nearest_rank([7], 10), 7);
  assert.equal(nearest_rank([1, 2, 3, 4], 0), 1, 'q = 0 → первый элемент (max(0, …))');
  assert.equal(nearest_rank([1, 2, 3, 4], 100), 4);
  assert.equal(nearest_rank([10, 20], 50), 10, 'ceil(1) − 1 = 0');
  throws_code(() => nearest_rank([], 50), 'E_SCHEMA');
  throws_code(() => nearest_rank([1], 101), 'E_SCHEMA');
  throws_code(() => ewma([], 3000), 'E_SCHEMA');
  throws_code(() => ewma([1], 10001), 'E_SCHEMA');
  throws_code(() => shrink_to_prior(1, 0, 7, 0), 'E_SCHEMA');
});

test('lag_observations: хронологично, по ключу потока, окно последних 24, excluded пропускается', () => {
  const mk = (i, lag, key = 'S-1', over = {}) => ({
    plan: { layer: 'planned', occ_key: `${key}@${i}`, cash_event_id: `${key}@${i}`, stream_id: key, rule_id: null, account_id: 'a', currency: 'EUR', date: 20000 + i * 30, amount_minor: 100000, status: 'matched' },
    facts: [{ layer: 'posted', cash_event_id: `f${key}${i}`, account_id: 'a', currency: 'EUR', date: 20000 + i * 30 + lag, amount_minor: 100000 }],
    by: 'auto', ...over,
  });
  const ms = [];
  for (let i = 0; i < 30; i++) ms.push(mk(i, i % 5));
  const shuffled = shuffle(ms, make_rng(7));
  const obs = lag_observations(shuffled);
  assert.equal(obs['S-1'].lags.length, 24);
  assert.deepEqual(obs['S-1'].lags, ms.slice(6).map((m, k) => (k + 6) % 5), 'последние 24 в хронологическом порядке');
  assert.deepEqual(lag_observations(shuffled, 5)['S-1'].lags, [0, 1, 2, 3, 4].map((x) => (25 + x) % 5));
  // excluded и пустые факты
  const obs2 = lag_observations([mk(0, 3), mk(1, 9, 'S-1', { excluded: true }), { ...mk(2, 1), facts: [] }]);
  assert.deepEqual(obs2['S-1'], { lags: [3], ratios_bp: [10000] });
  // несколько потоков
  const obs3 = lag_observations([mk(0, 2, 'A'), mk(0, 4, 'B')]);
  assert.deepEqual(Object.keys(obs3).sort(), ['A', 'B']);
  // несколько фактов на план: лаг по последнему, ratio — по сумме (частичные платежи)
  const m = mk(0, 0);
  m.facts = [
    { layer: 'posted', cash_event_id: 'p1', account_id: 'a', currency: 'EUR', date: 20002, amount_minor: 40000 },
    { layer: 'posted', cash_event_id: 'p2', account_id: 'a', currency: 'EUR', date: 20005, amount_minor: 55000 },
  ];
  assert.deepEqual(lag_observations([m])['S-1'], { lags: [5], ratios_bp: [9500] });
});

test('flow_key: counterparty_id ?? stream_id ?? rule_id ?? cash_event_id', () => {
  assert.equal(flow_key({ counterparty_id: 'C1', stream_id: 'S', rule_id: 'R', cash_event_id: 'E' }), 'C1');
  assert.equal(flow_key({ stream_id: 'S', rule_id: null, cash_event_id: 'E' }), 'S');
  assert.equal(flow_key({ rule_id: 'R', cash_event_id: 'E' }), 'R');
  assert.equal(flow_key({ cash_event_id: 'E' }), 'E');
  throws_code(() => flow_key({}), 'E_SCHEMA');
});

test('TST-49/50 TV-4: интервал Уилсона z = 1,96 — все шесть строк канона и инвариант 7', () => {
  const table = [
    [1, 8, 22, 471], [2, 8, 71, 591], [3, 24, 43, 310], [5, 40, 55, 261], [0, 20, 0, 161], [9, 200, 24, 83],
  ];
  for (const [k, n, lo, hi] of table) assert.deepEqual(wilson(k, n), { lo_pm: lo, hi_pm: hi }, `${k}/${n}`);
  for (let n = 1; n <= 60; n++) {
    for (let k = 0; k <= n; k++) {
      const w = wilson(k, n);
      const pm = Math.floor((1000 * k) / n + 0.5);
      assert.ok(w.lo_pm <= pm && pm <= w.hi_pm, `lo ≤ round(1000k/n) ≤ hi при ${k}/${n}`);
      assert.ok(w.lo_pm >= 0 && w.hi_pm <= 1000);
    }
  }
  // ширина убывает с n при фиксированной доле 1/4
  const width = (n) => { const w = wilson(n / 4, n); return w.hi_pm - w.lo_pm; };
  assert.ok(width(8) > width(40) && width(40) > width(200));
  throws_code(() => wilson(3, 2), 'E_SCHEMA');
  throws_code(() => wilson(0, 0), 'E_SCHEMA');
});

test('независимость от параметров: плоские и вложенные params эквивалентны, окно и допуск настраиваются', () => {
  const p = rent();
  const f = fact('F', '2026-11-28', -90000); // +3 дня
  assert.equal(match_plan_to_fact([p], [f], { 'match.window_days': 3 }).matches.length, 1);
  assert.equal(match_plan_to_fact([p], [f], { match: { window_days: 2 } }).matches.length, 0);
  assert.equal(match_plan_to_fact([p], [f], {}).matches.length, 1, 'по умолчанию окно 3');
  assert.equal(match_plan_to_fact([p], [fact('G', '2026-11-27', -95000)], { 'match.tol_bp': 600 }).matches.length, 1, '5000·10000 ≤ 600·90000');
  throws_code(() => match_plan_to_fact([p], [f], { 'match.window_days': -1 }), 'E_SCHEMA');
});
