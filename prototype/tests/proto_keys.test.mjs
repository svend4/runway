// proto_keys.test.mjs — FP-02 · Q-07, REQ-158, ADR-013: класс «идентификатор из чужого файла совпал с ключом Object.prototype».
// Идентификаторы (счета, правила, потоки, резервы, события, валюты сценариев) — недоверенные данные: «__proto__», «constructor», «toString»,
// «hasOwnProperty», «valueOf» — обычные значения. Сквозное свойство: любой такой id в любом построителе словаря даёт результат или код ошибки
// из реестра, не TypeError; ключ сохраняется как СОБСТВЕННЫЙ; Object.prototype не загрязняется; state_hash определён.
// Ожидания — из требования, а не из вывода движка. В тестах допустимы node:fs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { analyze } from '../engine/index.mjs';
import * as C from '../engine/calibration.mjs';
import * as T from '../engine/timeline.mjs';
import * as L from '../engine/ledger.mjs';
import * as IO from '../engine/io.mjs';
import * as B from '../engine/backtest.mjs';
import * as MC from '../engine/montecarlo.mjs';
import * as S from '../engine/sinking.mjs';
import { own_has, own_put } from '../engine/money.mjs';
import { make_tool_ctx, run_tool } from '../engine/tools.mjs';
import { throws_code } from './helpers.mjs';

const DATA = new URL('../data/', import.meta.url);
const load = (name) => JSON.parse(fs.readFileSync(new URL(name, DATA), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const G = load('g001.json');
const HOSTILE = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'prototype', '__defineGetter__', 'isPrototypeOf'];
const PROTO_NAMES = Object.getOwnPropertyNames(Object.prototype).sort();

/** Прототип не загрязнён и словарь не унаследовал ключей. */
function assert_clean_proto(msg = '') {
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), PROTO_NAMES, 'Object.prototype изменён ' + msg);
  assert.equal(({}).polluted, undefined, 'загрязнение ' + msg);
  assert.deepEqual(Object.keys({}), [], msg);
}
/** Результат или ошибка движка с кодом; чужие исключения (TypeError…) — дефект. */
function result_or_code(fn, msg) {
  try { return { value: fn() }; } catch (e) {
    assert.equal(e?.name, 'RunwayError', `${msg}: ожидался результат или RunwayError, получено ${e?.name}: ${e?.message}`);
    return { code: e.code, error: e };
  }
}

test('money.own_has / own_put: «__proto__» сохраняется собственным ключом и не меняет прототип; остальные ключи — как обычно', () => {
  for (const id of HOSTILE) {
    const d = {};
    own_put(d, id, { n: 1 });
    assert.ok(own_has(d, id), id);
    assert.deepEqual(Object.keys(d), [id]);
    assert.deepEqual(d[id], { n: 1 });
    assert.equal(Object.getPrototypeOf(d), Object.prototype, 'прототип словаря цел: ' + id);
    assert.equal(own_has({}, id), false, 'у пустого словаря собственных ключей нет: ' + id);
  }
  assert_clean_proto();
});

test('TST-40 Q-07 calibration.lag_observations: любой flow_key (id из чужого журнала) — собственный ключ, без TypeError; flow_calibration на значении словаря работает; на унаследованном — E_SCHEMA', () => {
  for (const id of HOSTILE) {
    const match = (day, lag) => ({ plan: { cash_event_id: id, date: day, amount_minor: -1000 }, facts: [{ cash_event_id: 'f' + day, date: day + lag, amount_minor: -1000 }] });
    const obs = C.lag_observations([match(20000, 1), match(20010, 3)]);
    assert.ok(Object.hasOwn(obs, id), id);
    assert.deepEqual(Object.keys(obs), [id]);
    assert.deepEqual(obs[id].lags, [1, 3]);
    const cal = C.flow_calibration(obs[id].lags, obs[id].ratios_bp);
    assert.equal(cal.n, 2);
    // унаследованное значение («constructor» → функция Object) не массив лагов
    const inherited = ({})[id];
    if (!Object.hasOwn({}, id) && inherited !== undefined) throws_code(() => C.flow_calibration(inherited, []), 'E_SCHEMA');
    // montecarlo читает таблицу наблюдений по тому же ключу
    const pool = MC.lag_pool({ as_of: 20020, lag_obs: obs, params: {} }, { cash_event_id: id, plan_date: 20015, date: 20015, kind: 'income', layer: 'planned', status: 'expected', amount_minor: 1000 });
    assert.ok(Array.isArray(pool.obs), id);
    assert.equal(pool.n_obs, 2, id + ': наблюдения найдены по собственному ключу');
  }
  assert_clean_proto();
});

test('TST-57 Q-07 timeline.rule_statuses: id налогового правила из ключа Object.prototype — собственный ключ результата, статус не теряется', () => {
  for (const id of HOSTILE) {
    const ws = clone(G);
    ws.tax_rules = [{ ...ws.tax_rules[0], tax_rule_id: id }];
    ws.reserves = ws.reserves.map((r) => (r.reserve_id === 'RES-TAX' ? { ...r, tax_rule_id: id } : r));
    const st = T.rule_statuses(ws, ws.as_of);
    assert.ok(Object.hasOwn(st, id), id);
    assert.ok(['fresh', 'stale', 'disabled'].includes(st[id]), id + ' → ' + st[id]);
    assert.deepEqual(Object.keys(st), [id]);
  }
  assert_clean_proto();
});

test('TST-33 Q-07 timeline.flat_params и scenario_fx_shock: ключ «__proto__» в параметрах и код валюты в fx_shock не теряются и не меняют прототип', () => {
  const p = T.flat_params(JSON.parse('{"__proto__": 5, "x": {"__proto__": 1, "y": 2}}'));
  assert.ok(Object.hasOwn(p, '__proto__'));
  assert.equal(p['__proto__'], 5);
  assert.equal(p['x.y'], 2);
  assert.equal(Object.getPrototypeOf(p), Object.prototype);
  for (const cur of HOSTILE) {
    const shock = T.scenario_fx_shock({ ops: [{ op: 'fx_shock', currency: cur, bp: -500 }] });
    assert.ok(Object.hasOwn(shock, cur), cur);
    assert.equal(shock[cur], -500);
  }
  assert_clean_proto();
});

test('TST-38 Q-07 ledger.reduce: id любого вида записи — собственный ключ своего словаря; state_hash определён и не зависит от порядка', () => {
  for (const id of HOSTILE) {
    let n = 0;
    const ev = (type, payload, extra = {}) => { n += 1; return L.make_event(type, payload, { event_id: 'e' + n, seq: n, recorded_at: '2026-10-01T10:00:00Z', ...extra }); };
    const events = [
      ev('account.opened', { account_id: id, name: 'A', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 }),
      ev('anchor.set', { anchor_id: id, account_id: id, date: '2026-10-01', amount_minor: 1000 }),
      ev('tx.posted', { account_id: id, date: '2026-10-02', amount_minor: -1, currency: 'EUR' }, { entity_id: id }),
      ev('plan.set', { plan_id: id, account_id: id, date: '2026-10-09', amount_minor: -5, currency: 'EUR' }),
      ev('rule.set', { rule_id: id, kind: 'expense' }),
      ev('stream.set', { stream_id: id }),
      ev('taxrule.set', { tax_rule_id: id, version: 1 }),
      ev('reserve.set', { reserve_id: id, kind: 'tax' }),
      ev('allocation.recorded', { allocation_id: id, reserve_id: id, date: '2026-10-02', amount_minor: 1, source: 'manual' }),
      ev('fx.set', { fx_id: id, base: 'USD', quote: 'EUR', num: 1, den: 1, date: '2026-10-01' }),
      ev('scenario.set', { scenario_id: id, ops: [] }),
      ev('purchase.saved', { purchase_id: id, parts: [] }),
      ev('calendar.set', { calendar_id: id }),
      ev('counterparty.set', { counterparty_id: id, name: 'C' }),
      ev('profile.set', { profile_id: id }),
      ev('debt.set', { debt_id: id }),
    ];
    const state = L.reduce(L.effective_events(events));
    for (const bucket of ['accounts', 'anchors', 'facts', 'plans', 'rules', 'streams', 'tax_rules', 'reserves', 'allocations', 'fx', 'scenarios', 'purchases', 'calendars', 'counterparties', 'profiles', 'debts']) {
      assert.ok(Object.hasOwn(state[bucket], id), `${id} в ${bucket}`);
    }
    assert.match(L.state_hash(state), /^[0-9a-f]{64}$/);
    assert.equal(L.state_hash(L.reduce(L.effective_events([...events].reverse()))), L.state_hash(state), 'порядок входа не влияет: ' + id);
    // JSON-копия: round-trip
    assert.equal(L.state_hash(IO.import_json(IO.export_json(events))), L.state_hash(state), id);
  }
  assert_clean_proto();
});

test('TST-60 Q-07 backtest.replay_state: факт с entity_id из ключа Object.prototype не теряется молча в срезе «как знали тогда»', () => {
  for (const id of HOSTILE) {
    let n = 0;
    const ev = (type, payload, extra = {}) => { n += 1; return L.make_event(type, payload, { event_id: 'e' + n, seq: n, recorded_at: '2026-10-01T10:00:00Z', ...extra }); };
    const journal = [
      ev('account.opened', { account_id: 'acc', name: 'A', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 }),
      ev('tx.posted', { account_id: 'acc', date: '2026-10-02', amount_minor: -700, currency: 'EUR' }, { entity_id: id }),
    ];
    const s = B.replay_state(journal, '2026-10-05');
    assert.ok(Object.hasOwn(s.facts, id), id + ': факт в срезе');
    assert.equal(s.facts[id].amount_minor, -700);
    assert.equal(Object.keys(B.replay_state(journal, '2026-10-01').facts).length, 0, 'срез раньше даты факта пуст');
  }
  assert_clean_proto();
});

test('REQ-158 Q-07 analyze: id счёта, правила, потока, резерва, налогового правила, плана и календаря из ключей Object.prototype — результат или код ошибки, без TypeError; прототип чист', () => {
  const variants = {
    rule: (ws, id) => { ws.rules = [{ ...ws.rules[0], rule_id: id }, ...ws.rules.slice(1)]; },
    stream: (ws, id) => { ws.streams = [{ ...ws.streams[0], stream_id: id }]; ws.tax_rules = ws.tax_rules.map((r) => ({ ...r, applies_to: { stream_ids: [id], tags: [] } })); },
    reserve_tax: (ws, id) => { ws.reserves = ws.reserves.map((r) => (r.reserve_id === 'RES-TAX' ? { ...r, reserve_id: id } : r)); ws.tax_rules = ws.tax_rules.map((r) => ({ ...r, reserve_id: id })); ws.plans = ws.plans.map((p) => (p.reserve_id === 'RES-TAX' ? { ...p, reserve_id: id } : p)); },
    tax_rule: (ws, id) => { ws.tax_rules = ws.tax_rules.map((r) => ({ ...r, tax_rule_id: id })); ws.reserves = ws.reserves.map((r) => (r.tax_rule_id === 'TR-20' ? { ...r, tax_rule_id: id } : r)); },
    plan: (ws, id) => { ws.plans = [{ ...ws.plans[0], plan_id: id }]; },
    calendar: (ws, id) => { ws.calendars = [{ ...ws.calendars[0], calendar_id: id }]; ws.rules = ws.rules.map((r) => ({ ...r, calendar_id: id })); ws.streams = ws.streams.map((s) => ({ ...s, calendar_id: id })); },
    account: (ws, id) => { ws.accounts = [{ ...ws.accounts[0], account_id: id }]; for (const k of ['anchors', 'facts', 'plans', 'rules', 'streams']) ws[k] = ws[k].map((x) => (x.account_id === 'acc_main' ? { ...x, account_id: id } : x)); },
    scenario_ops: (ws, id) => { ws.scenarios = [{ scenario_id: id, name: 's', ops: [{ op: 'fx_shock', currency: id, bp: -500 }] }]; },
  };
  let ok = 0;
  let coded = 0;
  for (const [name, mutate] of Object.entries(variants)) {
    for (const id of HOSTILE) {
      const ws = clone(G);
      mutate(ws, id);
      const r = result_or_code(() => analyze(ws, { as_of: ws.as_of, ...(name === 'scenario_ops' ? { scenario_id: id } : {}) }), `${name}:${id}`);
      if (r.value !== undefined) {
        ok += 1;
        assert.match(r.value.inputs_hash, /^[0-9a-f]{64}$/);
      } else coded += 1;
    }
  }
  assert.ok(ok >= 40, `большинство вариантов считаются (${ok} из ${ok + coded})`);
  assert_clean_proto();
});

test('TST-46 REQ-131 Q-07 tools: id правила и резерва из ключей Object.prototype — инструменты возвращают Result или ошибку-значение, не исключение; в Result идентификаторы только допустимой формы', () => {
  for (const id of HOSTILE) {
    const ws = clone(G);
    ws.reserves = ws.reserves.map((r) => (r.reserve_id === 'RES-TAX' ? { ...r, reserve_id: id } : r));
    ws.tax_rules = ws.tax_rules.map((r) => ({ ...r, reserve_id: id }));
    ws.plans = ws.plans.map((p) => (p.reserve_id === 'RES-TAX' ? { ...p, reserve_id: id } : p));
    ws.rules = [{ ...ws.rules[0], rule_id: id }, ...ws.rules.slice(1)];
    let ctx;
    try { ctx = make_tool_ctx(ws, { as_of: ws.as_of }); } catch (e) { assert.equal(e?.name, 'RunwayError', id); continue; }
    for (const [name, args] of [['explain_min_point', {}], ['list_waves', { from: '2026-10-04', to: '2026-11-30' }], ['get_tax_envelope', {}], ['check_purchase', { date: '2026-10-12', amount_minor: 30000, currency: 'EUR' }]]) {
      ctx.calls_used = 0;
      const r = run_tool(name, args, ctx);
      assert.ok(r !== null && typeof r === 'object', `${id}/${name}`);
      if (r.isError !== true) assert.match(r.call_id, /^[0-9a-f]{8}$/);
    }
  }
  assert_clean_proto();
});

test('TST-43 REQ-095 Q-07 io: экспорт CSV/hledger/JSON с id из ключей Object.prototype не падает и не теряет записи; импорт JSON-копии возвращает то же состояние', () => {
  for (const id of HOSTILE) {
    let n = 0;
    const ev = (type, payload, extra = {}) => { n += 1; return L.make_event(type, payload, { event_id: 'e' + n, seq: n, recorded_at: '2026-10-01T10:00:00Z', ...extra }); };
    const events = [
      ev('account.opened', { account_id: id, name: 'A', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 }),
      ev('tx.posted', { account_id: id, date: '2026-10-02', amount_minor: -700, currency: 'EUR', note: 'n' }, { entity_id: id }),
    ];
    const state = L.reduce(L.effective_events(events));
    const csv = IO.export_csv(state, 'journal');
    assert.equal(IO.parse_csv(csv).length, 2, id);
    const hl = result_or_code(() => IO.export_hledger(state, '2026-10-04', '2026-11-30'), 'hledger ' + id);
    assert.ok(hl.value !== undefined || typeof hl.code === 'string');
    assert.equal(L.state_hash(IO.import_json(IO.export_json(events))), L.state_hash(state));
  }
  assert_clean_proto();
});

test('TST-23 Q-07 sinking.reserve_series: id резерва из ключей Object.prototype — собственный ключ by_reserve; «__proto__» — явный E_SCHEMA (а не молчаливая потеря)', () => {
  for (const id of HOSTILE) {
    const r = result_or_code(() => S.reserve_series([{ reserve_id: id, funded_open_minor: 100 }], [], [], '2026-10-04', '2026-10-10'), id);
    if (id === '__proto__') { assert.equal(r.code, 'E_SCHEMA'); continue; }
    assert.ok(Object.hasOwn(r.value.by_reserve, id), id);
    assert.equal(r.value.reserve_close[0], 100);
  }
  assert_clean_proto();
});
