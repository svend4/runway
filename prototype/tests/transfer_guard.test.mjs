// transfer_guard.test.mjs — предупреждение о двойном вычитании при реальном переводе (FP-04, REQ-063, TST-02, X12 из semantics.test.mjs).
// Числа канона переписаны вручную (G-001: перевод 100000 при RES-TAX.funded = 150000 → free 250000 → 150000 без согласия, 250000 после согласия);
// остальное проверяется свойствами: сумма предложения, идемпотентность, отказ запоминается, модуль ничего не меняет и не ломается на чужом файле.
// Тесты — в Node, без DOM.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze } from '../engine/index.mjs';
import {
  check_transfer, pending_transfers, decline_record, declined_transfers, guard_allocation_id, DECLINE_KIND,
} from '../engine/transfer_guard.mjs';
import { apply_edit } from '../demo/ws_edit.mjs';
import { create_journal, ports_from_gen } from '../demo/journal_log.mjs';
import { make_id_gen, seeded_ports } from '../demo/ids.mjs';
import { make_rng, throws_code } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const G = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'data', 'g001.json'), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
function deep_freeze(x) {
  if (x !== null && typeof x === 'object' && !Object.isFrozen(x)) { Object.freeze(x); for (const k of Object.keys(x)) deep_freeze(x[k]); }
  return x;
}

/** G-001 «на следующий день»: as_of 2026-10-05, якорь 10-04 и резервы прежние, добавлен накопительный счёт. */
function day_after() {
  const w = clone(G);
  w.as_of = '2026-10-05';
  w.accounts.push({ account_id: 'acc_sav', name: 'Копилка', kind: 'savings', liquidity: 'savings', currency: 'EUR', exponent: 2, opened_on: '2026-01-01' });
  return w;
}
let n = 0;
const new_id = (p) => p + '_' + (++n);
const free0 = (ws) => analyze(ws, { as_of: ws.as_of }).series.plan.free[0];
const T = (over = {}) => ({ transfer_id: 'trf_1', from_account_id: 'acc_main', to_account_id: 'acc_sav', amount_minor: 100000, date: '2026-10-05', ...over });
function post(ws, amount, date = ws.as_of, tid = 'trf_1') {
  const r = apply_edit(ws, { type: 'add_fact', transfer_id: tid, legs: [{ account_id: 'acc_main', date, amount_minor: -amount }, { account_id: 'acc_sav', date, amount_minor: amount }] }, { new_id });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  return r.ws;
}
function consent(ws, check) {
  let cur = ws;
  for (const allocation of check.allocations) {
    const r = apply_edit(cur, { type: 'record_allocation', allocation }, { new_id });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    cur = r.ws;
  }
  return cur;
}

test('TST-02 REQ-063 X12: перевод 100000 с acc_main на acc_savings при RES-TAX.funded = 150000 — запрос; без согласия free 250000 → 150000, после согласия (funded 50000) остаётся 250000', () => {
  const base = day_after();
  assert.equal(free0(base), 250000, 'до перевода');
  const posted = post(base, 100000);
  assert.equal(free0(posted), 150000, 'двойное вычитание: free упал на сумму перевода');
  const g = check_transfer(posted, T());
  assert.equal(g.warn, true);
  assert.equal(g.reason, 'double_count');
  assert.equal(g.reduce_total_minor, 100000);
  assert.equal(g.uncovered_minor, 0);
  assert.deepEqual(g.candidates, [{ reserve_id: 'RES-TAX', kind: 'tax', funded_minor: 150000, reduce_minor: 100000 }], 'RES-INS пуст (funded 0) и в предложение не входит');
  assert.deepEqual(g.allocations, [{
    allocation_id: guard_allocation_id('trf_1', 'RES-TAX'), reserve_id: 'RES-TAX', date: '2026-10-05', amount_minor: -100000, source: 'manual', source_event_id: 'trf_1',
  }], 'запись Allocation со знаком минус, source = manual');
  const agreed = consent(posted, g);
  const a = analyze(agreed, { as_of: agreed.as_of });
  assert.equal(a.series.plan.reserve_opening_minor, 50000, 'funded 150000 → 50000');
  assert.equal(a.series.plan.free[0], 250000, 'после согласия free прежний');
  assert.equal(a.series.worse.free[0], 250000);
  // запрос не повторяется для того же перевода: аллокации записаны
  assert.deepEqual(check_transfer(agreed, T()), { warn: false, reason: 'resolved', transfer_id: 'trf_1' });
});

test('TST-02 REQ-063: отказ пользователя записывается и запрос по тому же переводу не повторяется; по другому переводу — повторяется', () => {
  const posted = post(day_after(), 100000);
  const rec = decline_record('trf_1');
  assert.equal(rec.payload.kind, DECLINE_KIND);
  assert.equal(rec.payload.decision, 'declined');
  // запись отказа — в журнал (draft.proposed), чтение — из state.extra
  const j = create_journal({ ports: ports_from_gen(make_id_gen(seeded_ports({ seed: 5 }))) });
  j.append('draft.proposed', rec.payload, { entity_id: rec.entity_id });
  const declined = declined_transfers(j.state().state.extra);
  assert.deepEqual([...declined], ['trf_1']);
  assert.deepEqual(check_transfer(posted, T(), { declined }), { warn: false, reason: 'declined', transfer_id: 'trf_1' });
  assert.equal(check_transfer(posted, T({ transfer_id: 'trf_2' }), { declined }).warn, true);
  assert.deepEqual(pending_transfers(posted, { declined }), []);
  assert.equal(pending_transfers(posted).length, 1);
  assert.throws(() => decline_record(''), (e) => e.code === 'E_SCHEMA');
  // чужие записи в extra не читаются
  assert.deepEqual([...declined_transfers({ 'draft.proposed': { a: { kind: 'x', decision: 'declined', transfer_id: 't' }, b: 5, c: null } })], []);
  assert.deepEqual([...declined_transfers(null)], []);
  assert.deepEqual([...declined_transfers({})], []);
});

test('TST-02 REQ-063: когда предупреждения нет — и причина названа (не operating→не operating, валюта, будущее, якорь, резерв, снимок резерва)', () => {
  const base = day_after();
  const why = (ws, t, o) => check_transfer(ws, t, o).reason;
  assert.equal(why(base, T({ to_account_id: 'acc_main', from_account_id: 'acc_sav' })), 'not_operating_to_nonoperating', 'из копилки в операционный');
  const two = clone(base);
  two.accounts.push({ account_id: 'acc_two', name: 'Второй', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2, opened_on: '2026-01-01' });
  assert.equal(why(two, T({ to_account_id: 'acc_two' })), 'not_operating_to_nonoperating', 'между операционными счетами free не меняется');
  const usd = clone(base);
  usd.accounts.find((a) => a.account_id === 'acc_sav').currency = 'USD';
  assert.equal(why(usd, T()), 'currency_differs');
  assert.equal(why(base, T({ from_account_id: 'нет' })), 'unknown_account');
  assert.equal(why(base, T({ date: '2026-10-06' })), 'future', 'позже as_of — план, а не проводка');
  assert.equal(why(base, T({ date: '2026-10-04' })), 'covered_by_anchor', 'якорь 10-04 уже включает перевод 10-04');
  assert.equal(why(base, T({ date: '2026-10-03' })), 'covered_by_anchor');
  assert.equal(why(base, T({ date: '2026-10-04', planned: true })), 'before_reserve_snapshot', 'план на дату якоря входит в поток, но аллокация на дату резерва не учлась бы');
  const nores = clone(base);
  nores.reserves = [];
  assert.equal(why(nores, T()), 'no_funded_reserve');
  const zero = clone(base);
  for (const r of zero.reserves) r.funded_start_minor = 0;
  assert.equal(why(zero, T()), 'no_funded_reserve', 'funded = 0');
  const backed = clone(base);
  backed.reserves.find((r) => r.reserve_id === 'RES-TAX').backed_by_account_id = 'acc_sav';
  assert.equal(why(backed, T()), 'reserve_backed', 'привязанный резерв: деньги лежат на копилке, двойного вычитания нет');
  const snap = clone(base);
  for (const r of snap.reserves) r.funded_as_of = '2026-10-05';
  assert.equal(why(snap, T()), 'before_reserve_snapshot', 'резерв задан на дату перевода: аллокация не была бы учтена движком');
  const eurusd = clone(base);
  eurusd.reserves.find((r) => r.reserve_id === 'RES-TAX').currency = 'USD';
  assert.equal(why(eurusd, T()), 'no_funded_reserve', 'резерв в другой валюте не уменьшается переводом в EUR');
});

test('TST-02 REQ-063: перевод больше накопленного — предложение не больше резерва, остаток назван; два резерва — по убыванию накопленного', () => {
  const base = day_after();
  const g = check_transfer(base, T({ amount_minor: 200000 }));
  assert.equal(g.warn, true);
  assert.equal(g.reduce_total_minor, 150000);
  assert.equal(g.uncovered_minor, 50000);
  assert.equal(g.allocations[0].amount_minor, -150000);
  const two = clone(base);
  two.reserves.find((r) => r.reserve_id === 'RES-INS').funded_start_minor = 40000;
  const g2 = check_transfer(two, T({ amount_minor: 170000 }));
  assert.deepEqual(g2.candidates.map((c) => [c.reserve_id, c.funded_minor, c.reduce_minor]), [['RES-TAX', 150000, 150000], ['RES-INS', 40000, 20000]]);
  assert.equal(g2.reduce_total_minor, 170000);
  assert.deepEqual(g2.allocations.map((a) => [a.reserve_id, a.amount_minor]), [['RES-TAX', -150000], ['RES-INS', -20000]]);
  const posted = post(two, 170000);
  const agreed = consent(posted, g2);
  const a = analyze(agreed, { as_of: agreed.as_of });
  assert.equal(a.series.plan.reserve_opening_minor, 20000, '190000 − 170000');
  assert.equal(a.series.plan.free[0], free0(two), 'free прежний');
});

test('TST-02 REQ-063: свойство — для любой суммы перевода в пределах накопленного согласие возвращает free к значению до перевода (30 случайных переводов)', () => {
  const rng = make_rng(63);
  for (let i = 0; i < 30; i++) {
    const amount = rng.int(1, 150000); // 1…150000 = в пределах RES-TAX.funded
    const base = day_after();
    const posted = post(base, amount, '2026-10-05', 'trf_p' + i);
    const g = check_transfer(posted, T({ transfer_id: 'trf_p' + i, amount_minor: amount }));
    assert.equal(g.warn, true, 'сумма ' + amount);
    assert.equal(g.reduce_total_minor, amount);
    assert.equal(g.allocations.reduce((s, a) => s + a.amount_minor, 0), -amount);
    assert.equal(free0(posted), free0(base) - amount, 'без согласия: двойное вычитание');
    assert.equal(free0(consent(posted, g)), free0(base), 'после согласия: free прежний, сумма ' + amount);
  }
});

test('TST-02 REQ-063: pending_transfers находит проводки из файла (две ноги с одним transfer_id), порядок по дате, одиночные ноги и мусор пропускает', () => {
  let w = day_after();
  w = post(w, 30000, '2026-10-05', 'trf_b');
  w = post(w, 20000, '2026-10-05', 'trf_a');
  const got = pending_transfers(w);
  assert.deepEqual(got.map((x) => x.transfer_id), ['trf_a', 'trf_b'], 'при равной дате — по идентификатору');
  // одна нога, три ноги, нога без суммы, нецелая сумма — не роняют проверку
  const bad = clone(w);
  bad.facts.push({ event_id: 'x1', account_id: 'acc_main', date: '2026-10-05', amount_minor: -5, kind: 'transfer', transfer_id: 'trf_single' });
  bad.facts.push({ event_id: 'x2', account_id: 'acc_main', date: '2026-10-05', amount_minor: 1.5, kind: 'transfer', transfer_id: 'trf_float' }, { event_id: 'x3', account_id: 'acc_sav', date: '2026-10-05', amount_minor: 1, kind: 'transfer', transfer_id: 'trf_float' });
  bad.facts.push(null, 5, { transfer_id: 7 });
  assert.deepEqual(pending_transfers(bad).map((x) => x.transfer_id), ['trf_a', 'trf_b']);
  assert.deepEqual(pending_transfers({}), []);
  assert.deepEqual(pending_transfers({ facts: 'нет' }), []);
  // после согласия по одному переводу остаётся другой
  const first = pending_transfers(w)[0];
  const agreed = consent(w, first);
  assert.deepEqual(pending_transfers(agreed).map((x) => x.transfer_id), ['trf_b']);
});

test('TST-02 REQ-063: модуль чистый — рабочая область не меняется (заморожена), результат детерминирован; неверный вход — коды канона', () => {
  const posted = deep_freeze(post(day_after(), 100000));
  const a = check_transfer(posted, T());
  const b = check_transfer(posted, T());
  assert.deepEqual(a, b);
  assert.notEqual(a.allocations, b.allocations, 'каждый вызов возвращает новые объекты');
  throws_code(() => check_transfer(posted, T({ amount_minor: 0 })), 'E_SCHEMA');
  throws_code(() => check_transfer(posted, T({ amount_minor: -5 })), 'E_SCHEMA');
  throws_code(() => check_transfer(posted, T({ amount_minor: 1.5 })), 'E_NOT_INTEGER');
  throws_code(() => check_transfer(posted, T({ date: '2026-02-30' })), 'E_BAD_DATE');
  throws_code(() => check_transfer(null, T()), 'E_SCHEMA');
  throws_code(() => check_transfer(posted, null), 'E_SCHEMA');
  // без transfer_id предложение строится, но идентификаторов аллокаций нет (их назначит слой записи)
  const anon = check_transfer(posted, T({ transfer_id: undefined }));
  assert.equal(anon.warn, true);
  assert.equal(anon.allocations[0].allocation_id, undefined);
  assert.equal(Object.hasOwn(anon, 'transfer_id'), false);
});

test('TST-02 REQ-063: X12 из semantics.test.mjs не затронут — плановый перевод на копилку даёт free 150000, между операционными — 250000 (те же числа без модуля)', () => {
  const ws = clone(G);
  ws.accounts.push({ account_id: 'acc_sav', name: 'Копилка', kind: 'savings', liquidity: 'savings', currency: 'EUR', exponent: 2, opened_on: '2026-01-01' });
  const leg = (id, acc, amt) => ({ plan_id: id, account_id: acc, date: '2026-10-04', amount_minor: amt, currency: 'EUR', kind: 'transfer', transfer_id: 'T-SAV', tag: 'копилка' });
  ws.plans.push(leg('T-out', 'acc_main', -100000), leg('T-in', 'acc_sav', 100000));
  const a = analyze(ws, { as_of: ws.as_of });
  assert.equal(a.series.plan.free[0], 150000, 'было 250000');
  // тот же перевод как проводка на дату якоря: баланс он не меняет, предупреждение не выдаётся (причина названа)
  assert.equal(check_transfer(ws, { transfer_id: 'T-SAV', from_account_id: 'acc_main', to_account_id: 'acc_sav', amount_minor: 100000, date: '2026-10-04' }).reason, 'covered_by_anchor');
});
