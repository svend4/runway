// liquidity.test.mjs — FP-08: счета по ликвидности и «запас» (TST-28, REQ-018, REQ-080, ALG-08).
// «Запас» = Σ savings + Σ asset · liquidity_bp / 10^4 (пример 145000) ОТДЕЛЬНО от operating; крипта по умолчанию не ликвидна; никаких процентов haircut от продукта.
// Запуск: node --test --test-timeout=120000 --test-concurrency=1 tests/liquidity.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { analyze, convert_minor } from '../engine/index.mjs';
import { liquidity_report, account_balance, LIQUIDITY_GROUPS } from '../engine/liquidity.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const G = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'data', 'g001.json'), 'utf8'));

const SAV = { account_id: 'acc_sav', name: 'Накопительный', kind: 'savings', liquidity: 'savings', currency: 'EUR', exponent: 2, liquidity_bp: 0, opened_on: '2026-01-01' };
const ASSET = (bp) => ({ account_id: 'acc_house', name: 'Актив', kind: 'asset', liquidity: 'asset', currency: 'EUR', exponent: 2, liquidity_bp: bp, opened_on: '2026-01-01' });
const anchor = (account_id, amount_minor, date = '2026-10-04') => ({ anchor_id: 'anc-' + account_id, account_id, date, amount_minor });
const with_accounts = (accs, anchors, over = {}) => ({ ...G, accounts: [...G.accounts, ...accs], anchors: [...G.anchors, ...anchors], ...over });
const row = (rep, id) => rep.accounts.find((a) => a.account_id === id);

test('TST-28 REQ-018: накопительный счёт 100000 + актив 150000 при liquidity_bp 3000 → запас 145000; при liquidity_bp = 0 запас 100000; operating — отдельно (400000)', () => {
  const rep = liquidity_report(with_accounts([SAV, ASSET(3000)], [anchor('acc_sav', 100000), anchor('acc_house', 150000)]));
  assert.equal(rep.stock_minor, 145000);
  assert.equal(rep.savings_minor, 100000);
  assert.equal(rep.asset_minor, 45000, 'mul_div(150000, 3000, 10000)');
  assert.equal(rep.operating_minor, 400000, 'деньги на счетах — отдельное число, в запас не входят');
  const zero = liquidity_report(with_accounts([SAV, ASSET(0)], [anchor('acc_sav', 100000), anchor('acc_house', 150000)]));
  assert.equal(zero.stock_minor, 100000);
  assert.equal(row(zero, 'acc_house').value_minor, 0);
});

test('REQ-018: operating совпадает с остатком расчёта (analyze: opening_minor), резервы — отдельно; запас не меняет ни остаток, ни вердиктные ряды', () => {
  const ws = with_accounts([SAV, ASSET(3000)], [anchor('acc_sav', 100000), anchor('acc_house', 150000)]);
  const rep = liquidity_report(ws);
  const a = analyze(ws, { as_of: ws.as_of });
  assert.equal(rep.operating_minor, a.series.plan.opening_minor);
  assert.equal(rep.reserve_minor, a.series.plan.reserve_opening_minor);
  const plain = analyze(G, { as_of: G.as_of });
  assert.deepEqual(a.series.plan.free, plain.series.plan.free, 'запас в free не входит');
});

test('REQ-080 TST-28: крипто-счёт неликвиден по умолчанию — в запас 0; при 3000 bp — 2250 (convert_minor(150000, 8, 2, 50000, 1) = 7500)', () => {
  assert.equal(convert_minor(150000, 8, 2, 50000, 1), 7500);
  const btc = (bp) => ({ account_id: 'acc_btc', name: 'BTC', kind: 'crypto', liquidity: 'asset', currency: 'BTC', exponent: 8, liquidity_bp: bp, opened_on: '2026-01-01' });
  const rates = [{ fx_id: 'fx-btc', date: '2026-10-04', base: 'BTC', quote: 'EUR', num: 50000, den: 1 }];
  const off = liquidity_report(with_accounts([btc(0)], [anchor('acc_btc', 150000)], { rates }));
  assert.equal(off.stock_minor, 0);
  assert.equal(off.crypto_minor, 0);
  assert.equal(row(off, 'acc_btc').balance_minor, 150000);
  const on = liquidity_report(with_accounts([btc(3000)], [anchor('acc_btc', 150000)], { rates }));
  assert.equal(on.stock_minor, 2250);
  assert.equal(on.crypto_minor, 2250);
});

test('REQ-080: крипто-счёт в operating недопустим — строка с кодом E_SCHEMA, итог помечен неполным и крипта в operating не входит', () => {
  const bad = { account_id: 'acc_btc', name: 'BTC', kind: 'crypto', liquidity: 'operating', currency: 'BTC', exponent: 8, liquidity_bp: 0, opened_on: '2026-01-01' };
  const rep = liquidity_report(with_accounts([bad], [anchor('acc_btc', 150000)], { rates: [{ fx_id: 'fx-btc', date: '2026-10-04', base: 'BTC', quote: 'EUR', num: 50000, den: 1 }] }));
  assert.equal(row(rep, 'acc_btc').error, 'E_SCHEMA');
  assert.equal(rep.complete, false);
  assert.equal(rep.operating_minor, 400000);
});

test('REQ-018 ALG-08: накопительный счёт в чужой валюте — по курсу пары на дату; нет курса — E_NO_RATE в строке и complete = false, а не молчаливый ноль', () => {
  const usd = { ...SAV, account_id: 'acc_usd', currency: 'USD', name: 'USD' };
  const no_rate = liquidity_report(with_accounts([usd], [anchor('acc_usd', 200000)]));
  assert.equal(row(no_rate, 'acc_usd').error, 'E_NO_RATE');
  assert.equal(no_rate.complete, false);
  assert.equal(no_rate.stock_minor, 0);
  const rates = [{ fx_id: 'fx-1', date: '2026-10-04', base: 'USD', quote: 'EUR', num: 9250, den: 10000 }];
  const ok = liquidity_report(with_accounts([usd], [anchor('acc_usd', 200000)], { rates }));
  assert.equal(ok.stock_minor, 185000);
  assert.equal(ok.complete, true);
});

test('REQ-018: долг — справочно (вклад 0), остаток неизвестен без якоря и фактов (null, а не 0), закрытый счёт не показывается; группы ликвидности перечислены', () => {
  const debt = { account_id: 'acc_loan', name: 'Кредит', kind: 'debt', liquidity: 'debt', currency: 'EUR', exponent: 2, liquidity_bp: 0, opened_on: '2026-01-01' };
  const closed = { ...SAV, account_id: 'acc_old', name: 'Закрыт', closed_on: '2026-09-01' };
  const rep = liquidity_report(with_accounts([debt, SAV, closed], [anchor('acc_loan', -500000)]));
  assert.equal(row(rep, 'acc_loan').value_minor, 0);
  assert.equal(row(rep, 'acc_loan').balance_minor, -500000);
  assert.equal(row(rep, 'acc_sav').balance_minor, null);
  assert.equal(row(rep, 'acc_old'), undefined);
  assert.deepEqual([...LIQUIDITY_GROUPS], ['operating', 'savings', 'asset', 'debt']);
});

test('REQ-018 остаток счёта: последний якорь не позже as_of плюс проведённые факты после него', () => {
  const w = { anchors: [{ account_id: 'a', date: 10, amount_minor: 1000 }, { account_id: 'a', date: 20, amount_minor: 5000 }], facts: [
    { account_id: 'a', date: 15, amount_minor: 111 }, { account_id: 'a', date: 25, amount_minor: -200 }, { account_id: 'a', date: 40, amount_minor: 999 }] };
  assert.equal(account_balance(w, { account_id: 'a' }, 30), 4800);
  assert.equal(account_balance(w, { account_id: 'a' }, 12), 1000);
  assert.equal(account_balance(w, { account_id: 'b' }, 30), null);
});
