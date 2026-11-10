// mc_inputs.test.mjs — входы вероятностных расчётов из истории пользователя (FP-11): приращения курса в bp, плановые вхождения окна,
// пары «план ↔ факт», лаги и отношения сумм по потокам, «Привычки платежей» (REQ-053, REQ-054, REQ-055, ALG-10, ALG-13, TST-41, TST-49, TST-50).
// Ожидаемые числа — из канона и независимых вычислений (BigInt-формула приращения, разбор журнала генератора); движок в ожиданиях не участвует.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import * as mi from '../engine/mc_inputs.mjs';
import { analyze, round_div } from '../engine/index.mjs';
import { to_epoch_day } from '../engine/dates.mjs';
import { events_to_ws } from '../demo/ws_bridge.mjs';
import { make_journal, regular_corpus } from '../data/synthetic-journals/generate.mjs';
import { throws_code } from './helpers.mjs';

const DATA = new URL('../data/', import.meta.url);
const load = (name) => JSON.parse(fs.readFileSync(new URL(name, DATA), 'utf8'));
const G = load('g001.json');

const deep_freeze = (x) => {
  if (x !== null && typeof x === 'object' && !Object.isFrozen(x)) { Object.freeze(x); for (const k of Object.keys(x)) deep_freeze(x[k]); }
  return x;
};

/** Рабочая область из синтетического журнала (длинная история: 15 месяцев — 15 выплат клиента). */
function history_ws(extra = {}) {
  const spec = { ...regular_corpus()[1], start: '2025-07-01', end: '2026-09-30', ...extra };
  return { journal: make_journal(spec), ws: { ...events_to_ws(make_journal(spec)), as_of: '2026-09-30', decision_currency: 'EUR' } };
}
const H = history_ws();

// ── fx_obs_from_rates ────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-054 fx_obs_from_rates: 9250/10000 → 9400/10000 даёт +162 bp (независимая формула BigInt), ключ — валюта base', () => {
  const rates = [
    { fx_id: 'a', date: '2026-01-01', base: 'USD', quote: 'EUR', num: 9250, den: 10000 },
    { fx_id: 'b', date: '2026-02-01', base: 'USD', quote: 'EUR', num: 9400, den: 10000 },
  ];
  const out = mi.fx_obs_from_rates(rates, 'USD', 'EUR');
  // (9400 − 9250) / 9250 = 1,6216 % → 162 bp
  assert.deepEqual(out, { USD: [162] });
  // знак: курс падает → отрицательное приращение (к ближайшему, ничья — к чётному)
  const down = mi.fx_obs_from_rates([{ ...rates[1], date: '2026-01-01' }, { ...rates[0], date: '2026-02-01' }], 'USD', 'EUR');
  assert.deepEqual(down, { USD: [-160] }); // −150/9400 = −1,5957 % → −160 bp
});

test('REQ-054 fx_obs_from_rates: запись обратной пары переворачивается, две записи за один день — одно наблюдение, окно хранит последние приращения', () => {
  const rates = [
    { fx_id: 'a', date: '2026-01-01', base: 'USD', quote: 'EUR', num: 9250, den: 10000 },
    { fx_id: 'b', date: '2026-02-01', base: 'EUR', quote: 'USD', num: 10000, den: 9400 }, // = USD→EUR 9400/10000
    { fx_id: 'c', date: '2026-02-01', base: 'USD', quote: 'EUR', num: 9500, den: 10000 }, // исправление курса того же дня: id «c» позже «b» и побеждает
    { fx_id: 'd', date: '2026-03-01', base: 'USD', quote: 'EUR', num: 9500, den: 10000 },
    { fx_id: 'e', date: '2026-04-01', base: 'USD', quote: 'EUR', num: 9405, den: 10000 },
    { fx_id: 'x', date: '2026-04-01', base: 'GBP', quote: 'EUR', num: 11000, den: 10000 }, // чужая пара не мешает
  ];
  const all = mi.fx_obs_from_rates(rates, 'USD', 'EUR', 24);
  // 9250→9500: +270 (250/9250 = 2,7027 %), 9500→9500: 0, 9500→9405: −100 (−95/9500 = −1 %)
  assert.deepEqual(all, { USD: [270, 0, -100] });
  assert.deepEqual(mi.fx_obs_from_rates(rates, 'USD', 'EUR', 2), { USD: [0, -100] }, 'окно 2 — последние два приращения');
  assert.equal(mi.fx_obs_from_rates(rates, 'EUR', 'USD', 24).EUR.length, 3);
});

test('REQ-054 fx_obs_from_rates: меньше двух записей — наблюдений нет; та же валюта — пусто; плохой курс и плохое окно — E_SCHEMA; «constructor» — обычный код валюты', () => {
  assert.deepEqual(mi.fx_obs_from_rates([], 'USD', 'EUR'), {});
  assert.deepEqual(mi.fx_obs_from_rates([{ date: '2026-01-01', base: 'USD', quote: 'EUR', num: 9, den: 10 }], 'USD', 'EUR'), {});
  assert.deepEqual(mi.fx_obs_from_rates([], 'EUR', 'EUR'), {});
  throws_code(() => mi.fx_obs_from_rates([{ date: '2026-01-01', base: 'USD', quote: 'EUR', num: 0, den: 10 }], 'USD', 'EUR'), 'E_SCHEMA');
  throws_code(() => mi.fx_obs_from_rates([], 'USD', 'EUR', 0), 'E_SCHEMA');
  throws_code(() => mi.fx_obs_from_rates([], '', 'EUR'), 'E_SCHEMA');
  const odd = mi.fx_obs_from_rates([
    { date: '2026-01-01', base: 'constructor', quote: 'EUR', num: 1, den: 1 }, { date: '2026-02-01', base: 'constructor', quote: 'EUR', num: 2, den: 1 },
  ], 'constructor', 'EUR');
  assert.ok(Object.hasOwn(odd, 'constructor'));
  assert.deepEqual(odd.constructor, [10000]);
});

test('REQ-054 fx_obs_all: пары с валютой решения, остальные пары не берутся', () => {
  const rates = [
    { fx_id: 'a', date: '2026-01-01', base: 'USD', quote: 'EUR', num: 9250, den: 10000 }, { fx_id: 'b', date: '2026-02-01', base: 'USD', quote: 'EUR', num: 9400, den: 10000 },
    { fx_id: 'c', date: '2026-01-01', base: 'EUR', quote: 'CHF', num: 10000, den: 10600 }, { fx_id: 'd', date: '2026-02-01', base: 'EUR', quote: 'CHF', num: 10000, den: 10500 },
    { fx_id: 'e', date: '2026-01-01', base: 'GBP', quote: 'USD', num: 8, den: 10 }, { fx_id: 'f', date: '2026-02-01', base: 'GBP', quote: 'USD', num: 9, den: 10 },
  ];
  const out = mi.fx_obs_all(rates, 'EUR');
  assert.deepEqual(Object.keys(out).sort(), ['CHF', 'USD']);
  assert.deepEqual(out.USD, [162]);
  // запись EUR→CHF 10000/10600 значит 1 CHF = 1,06 EUR, затем 1 CHF = 1,05 EUR: падение на 0,01/1,06 = 0,9434 % → −94 bp
  assert.deepEqual(out.CHF, [-94]);
});

// ── plan_occurrences ─────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-031 plan_occurrences: окно G-001 с отсечением по якорю совпадает по составу с плановыми событиями анализа (правила, поток часов, разовый налог)', () => {
  const A = analyze(G, { as_of: '2026-10-04' });
  const plan_ids = A.events.plan.filter((e) => e.layer === 'planned').map((e) => e.cash_event_id).sort();
  const occ = mi.plan_occurrences(G, '2026-10-04', A.horizon_end, { as_of: '2026-10-04', anchor_cut: true });
  const ids = occ.filter((e) => e.date <= A.horizon_end && e.status === 'expected').map((e) => e.cash_event_id).sort();
  // единственное расхождение: выплата 5 октября сопоставлена с фактом tx-g001-27 от 2 октября (3 дня раньше, 2880 против 2790 — внутри допуска 5 %) и в плане анализа её нет
  assert.deepEqual(ids.filter((id) => !plan_ids.includes(id)), ['S-HOURLY@2026-10-05']);
  assert.deepEqual(plan_ids.filter((id) => !ids.includes(id)), []);
  assert.ok(occ.some((e) => e.cash_event_id === 'S-HOURLY@2026-11-05'), 'поток часов');
  assert.ok(occ.some((e) => e.cash_event_id === 'P-TAX1'), 'разовая запись');
  // отсортировано по (date, id)
  for (let i = 1; i < occ.length; i++) assert.ok(occ[i - 1].date < occ[i].date || (occ[i - 1].date === occ[i].date && String(occ[i - 1].cash_event_id) <= String(occ[i].cash_event_id)));
});

test('REQ-032 plan_occurrences: пропуск вхождения правила (override skip) убирает его, разовая запись со статусом skipped остаётся с этим статусом; to < from — E_BAD_DATE', () => {
  const rent_oct = mi.plan_occurrences(G, '2026-10-20', '2026-10-31').filter((e) => e.rule_id === 'R-RENT');
  assert.equal(rent_oct.length, 1);
  const nominal = rent_oct[0].occ_key.split('@')[1];
  const skipped = { ...G, overrides: [...G.overrides, { rule_id: 'R-RENT', nominal_date: nominal, action: 'skip' }] };
  assert.equal(mi.plan_occurrences(skipped, '2026-10-20', '2026-10-31').filter((e) => e.rule_id === 'R-RENT').length, 0);
  const plans = G.plans.map((p) => (p.plan_id === 'P-TAX1' ? { ...p, status: 'skipped' } : p));
  const tax = mi.plan_occurrences({ ...G, plans }, '2026-10-01', '2026-10-31').find((e) => e.cash_event_id === 'P-TAX1');
  assert.equal(tax.status, 'skipped');
  throws_code(() => mi.plan_occurrences(G, '2026-10-31', '2026-10-01'), 'E_BAD_DATE');
});

test('REQ-031 plan_occurrences: без отсечения по якорю виден план до последнего остатка; с отсечением — нет', () => {
  const all = mi.plan_occurrences(G, '2026-07-06', '2026-10-03');
  const cut = mi.plan_occurrences(G, '2026-07-06', '2026-10-03', { as_of: '2026-10-04', anchor_cut: true });
  assert.ok(all.length > 20);
  assert.equal(cut.length, 0, 'всё до якоря 2026-10-04 уже учтено в остатке');
});

// ── история и наблюдения ─────────────────────────────────────────────────────────────────────────────────────────────

test('TST-41 REQ-031 match_history: каждая связанная пользователем выплата клиента (plan_ref) — пара «план ↔ факт»; лаг = дата факта − дата плана', () => {
  const income = H.ws.facts.filter((f) => f.stream_id === 'S-HOURLY' && f.amount_minor > 0);
  assert.equal(income.length, 15, '15 выплат за 15 месяцев');
  assert.ok(income.every((f) => typeof f.plan_ref === 'string'), 'match.set вшит в факт как plan_ref');
  const obs = mi.mc_observations(H.ws, '2026-09-30');
  assert.equal(obs.lag_obs['S-HOURLY'].length, 15);
  // независимо: лаг каждой выплаты = дата факта − дата плановой выплаты с этим plan_ref
  const plan_by_id = new Map(mi.plan_occurrences(H.ws, '2025-06-01', '2026-09-30', { as_of: '2026-09-30' }).map((e) => [e.cash_event_id, e]));
  const expected = income.map((f) => to_epoch_day(f.date) - plan_by_id.get(f.plan_ref).date).sort((a, b) => a - b);
  assert.deepEqual([...obs.lag_obs['S-HOURLY']].sort((a, b) => a - b), expected);
  assert.ok(obs.lag_obs['S-HOURLY'].every((x) => x >= 0 && x <= 25), 'профиль клиента — задержки до 12 дней плюс выходные');
  assert.deepEqual(obs.flows.map((x) => x.key).sort(), ['R-GROC', 'R-PHONE', 'R-RENT', 'R-UTIL', 'S-HOURLY']);
  assert.ok(obs.flows.reduce((s, x) => s + x.n, 0) <= obs.n_pairs, 'окно 24 наблюдения на поток может отрезать старые пары');
});

test('REQ-054 mc_observations: ratio_obs_bp и lag_obs согласованы по ключам и длине; результат детерминирован, рабочая область не меняется', () => {
  const ws = deep_freeze(structuredClone(H.ws));
  const a = mi.mc_observations(ws, '2026-09-30');
  const b = mi.mc_observations(ws, '2026-09-30');
  assert.deepEqual(a, b);
  for (const k of Object.keys(a.lag_obs)) assert.equal(a.ratio_obs_bp[k].length, a.lag_obs[k].length);
  assert.ok(a.ratio_obs_bp['S-HOURLY'].every((r) => r > 8000 && r < 12000), 'часы укладываются в коридор плана ±20 %');
  assert.deepEqual(a.fx_obs_bp, {}, 'курсов в журнале нет');
  // окно хранит последние N
  const w5 = mi.mc_observations(ws, '2026-09-30', { window: 5 });
  assert.equal(w5.lag_obs['S-HOURLY'].length, 5);
  assert.deepEqual(w5.lag_obs['S-HOURLY'], a.lag_obs['S-HOURLY'].slice(-5));
});

test('REQ-055 mc_observations: без фактов и без сопоставлений наблюдений нет (отказ «нет истории» решает вызывающий)', () => {
  const none = mi.mc_observations({ ...G, facts: [] }, '2026-10-04');
  assert.deepEqual(none.lag_obs, {});
  assert.equal(none.n_pairs, 0);
  const future_only = mi.mc_observations({ ...G, facts: G.facts.filter((f) => f.date > '2026-09-01') }, '2026-08-01');
  assert.equal(future_only.n_pairs, 0, 'факты позже as_of в историю не входят');
});

test('REQ-053 payment_habits: поток показывается только при n ≥ 10; квантили nearest-rank; меньшие потоки скрыты с числом наблюдений', () => {
  const lags = { A: [0, 3, 7, 5, 14, 6, 2, 9, 4, 8], B: [0, 3, 7, 5, 14, 6, 2, 9], C: Array.from({ length: 12 }, (_, i) => i) };
  const h = mi.payment_habits(lags);
  assert.deepEqual(h.shown.map((x) => [x.key, x.n]), [['C', 12], ['A', 10]], 'по убыванию n');
  assert.deepEqual(h.hidden, [{ key: 'B', n: 8 }], '8 наблюдений — карточки нет');
  const a = h.shown.find((x) => x.key === 'A');
  // отсортировано: 0 2 3 4 5 6 7 8 9 14; p50: ceil(0,5·10) = 5-й → 5; p80: 8-й → 8; p90: 9-й → 9
  assert.deepEqual([a.p50, a.p80, a.p90], [5, 8, 9]);
  assert.equal(a.p90_is_max, false);
  assert.equal(mi.payment_habits({ X: [1, 2, 3] }, {}, { min_n: 3 }).shown[0].p90_is_max, true, 'при n = 3 p90 — наибольшее из n');
  assert.deepEqual(mi.payment_habits({}).shown, []);
});
