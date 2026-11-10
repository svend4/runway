// tax_hooks.test.mjs — FP-08: оболочки ALG-06 `on_posted_income` / `on_posted_payment` (TST-23, TST-24, REQ-064, REQ-065, REQ-067, C-016, C-038, D-08).
// Проведённый доход оставляет запись `allocation.recorded` по правилу на ФАКТИЧЕСКУЮ дату; на G-001 выплата 2 790,00 € при ставке 20 % даёт 558,00 € в конверт.
// Запуск: node --test --test-timeout=120000 --test-concurrency=1 tests/tax_hooks.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { reduce, effective_events, mul_div } from '../engine/index.mjs';
import { income_allocations, on_posted_income, on_posted_payment, pending_posted_allocations, income_allocation_id, release_allocation_id } from '../engine/tax_hooks.mjs';
import { throws_code } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const G = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'data', 'g001.json'), 'utf8'));
const state_of = (ws, extra = {}) => ({ tax_rules: ws.tax_rules, rates: ws.rates ?? [], decision_currency: 'EUR', allocations: [], reserves: ws.reserves, ...extra });
const payout = (over = {}) => ({ event_id: 'tx-oct', date: '2026-11-05', amount_minor: 279000, currency: 'EUR', stream_id: 'S-HOURLY', ...over });

test('TST-23 REQ-064: проведённая выплата 2 790,00 € при ставке 20 % даёт 558,00 € в конверт; запись несёт дату факта, источник income и rule_version', () => {
  const r = on_posted_income(state_of(G), payout());
  assert.equal(r.allocations.length, 1);
  assert.deepEqual(r.allocations[0], {
    allocation_id: 'tax:TR-20@tx-oct', reserve_id: 'RES-TAX', date: '2026-11-05', amount_minor: 55800, source: 'income', source_event_id: 'tx-oct', rule_version: 1,
  });
  assert.equal(income_allocation_id('TR-20', 'tx-oct'), r.allocations[0].allocation_id);
});

test('TST-23 REQ-064: сентябрьская выплата 288000 → 57600; mul_div(123457, 2100, 10000, half_even) = 25926; округление берётся из правила', () => {
  assert.equal(income_allocations(payout({ event_id: 'tx-sep', date: '2026-10-02', amount_minor: 288000 }), state_of(G))[0].amount_minor, 57600);
  const rule = { ...G.tax_rules[0], rate_bp: 2100, tax_rule_id: 'TR-21', reserve_id: 'RES-TAX' };
  const a = income_allocations(payout({ amount_minor: 123457 }), state_of(G, { tax_rules: [rule] }));
  assert.equal(a[0].amount_minor, 25926);
  assert.equal(a[0].amount_minor, mul_div(123457, 2100, 10000, 'half_even'));
  const up = income_allocations(payout({ amount_minor: 12345 }), state_of(G, { tax_rules: [{ ...rule, rate_bp: 5000, rounding: 'half_up' }] }));
  assert.equal(up[0].amount_minor, 6173, 'ничья 6172,5: half_up → 6173 (округление правила)');
});

test('TST-24 REQ-065: версии 2000 bp с 2026-01-01 и 2200 bp с 2026-07-01 — доход 300000 на 06-30 даёт 60000, на 07-02 — 66000; прошлая запись хранит свою версию', () => {
  const v1 = { ...G.tax_rules[0], tax_rule_id: 'TR-V', version: 1, rate_bp: 2000, valid_from: '2026-01-01', recorded_at: '2026-01-02T10:00:00Z' };
  const v2 = { ...v1, version: 2, rate_bp: 2200, valid_from: '2026-07-01', recorded_at: '2026-06-20T10:00:00Z' };
  const st = state_of(G, { tax_rules: [v1, v2] });
  const early = income_allocations(payout({ event_id: 'a1', date: '2026-06-30', amount_minor: 300000 }), st)[0];
  const late = income_allocations(payout({ event_id: 'a2', date: '2026-07-02', amount_minor: 300000 }), st)[0];
  assert.equal(early.amount_minor, 60000);
  assert.equal(early.rule_version, 1);
  assert.equal(late.amount_minor, 66000);
  assert.equal(late.rule_version, 2);
  // третья версия не меняет заготовки за прошлые даты
  const v3 = { ...v1, version: 3, rate_bp: 2500, valid_from: '2026-09-01', recorded_at: '2026-08-30T10:00:00Z' };
  const again = income_allocations(payout({ event_id: 'a1', date: '2026-06-30', amount_minor: 300000 }), state_of(G, { tax_rules: [v1, v2, v3] }))[0];
  assert.deepEqual(again, early);
});

test('REQ-064 идемпотентность: повторный вызов с записанной аллокацией ничего не добавляет; нет применимого правила — нет аллокации', () => {
  const first = on_posted_income(state_of(G), payout());
  const second = on_posted_income(state_of(G, { allocations: first.allocations }), payout());
  assert.deepEqual(second.allocations, []);
  assert.deepEqual(on_posted_income(state_of(G), payout({ stream_id: 'S-OTHER', tag: 'прочее' })).allocations, [], 'правило применяется только по stream_id или метке из applies_to (C-025)');
  assert.deepEqual(income_allocations({ ...payout(), amount_minor: -500 }, state_of(G)), [], 'расход аллокации не даёт');
});

test('REQ-064 C-032: сумма ставок правил на одно поступление больше 10000 bp — E_RULE_INVALID; метка (tag) тоже сопоставляется', () => {
  const a = { ...G.tax_rules[0], tax_rule_id: 'TR-A', rate_bp: 6000, applies_to: { stream_ids: ['S-HOURLY'], tags: [] } };
  const b = { ...G.tax_rules[0], tax_rule_id: 'TR-B', rate_bp: 5000, applies_to: { stream_ids: [], tags: ['клиент'] } };
  throws_code(() => income_allocations(payout({ tag: 'клиент' }), state_of(G, { tax_rules: [a, b] })), 'E_RULE_INVALID');
  assert.equal(income_allocations(payout({ stream_id: undefined, tag: 'клиент' }), state_of(G, { tax_rules: [a, b] }))[0].amount_minor, 139500, 'по метке — только правило TR-B (50 %)');
});

test('REQ-064 C-038: доход в чужой валюте — сумма в валюте решения по курсу даты факта; курса нет — E_NO_RATE, а не молчаливый ноль', () => {
  const rates = [{ fx_id: 'fx-1', date: '2026-10-01', base: 'USD', quote: 'EUR', num: 9250, den: 10000 }];
  const usd = payout({ currency: 'USD', amount_minor: 200000 });
  const a = income_allocations(usd, state_of(G, { rates }));
  assert.equal(a[0].amount_minor, 37000, '200000 USD → 185000 EUR × 20 %');
  throws_code(() => income_allocations(usd, state_of(G, { rates: [] })), 'E_NO_RATE');
  throws_code(() => income_allocations(usd, state_of(G, { rates: [{ ...rates[0], date: '2026-12-01' }] })), 'E_NO_RATE', 'курс из будущего — не spot');
});

test('REQ-064 ADR-004: запись журнала — allocation.recorded через ledger.make_event; свёртка даёт аллокацию с rule_version', () => {
  let seq = 0;
  const ctx = { next_event_id: () => 'evt-' + (seq + 1), next_seq: () => ++seq, recorded_at: '2026-11-05T09:00:00Z' };
  const r = on_posted_income(state_of(G), payout(), ctx);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].type, 'allocation.recorded');
  assert.equal(r.events[0].entity_id, 'tax:TR-20@tx-oct');
  assert.equal(r.events[0].seq, 1);
  const st = reduce(effective_events(r.events));
  assert.equal(st.allocations['tax:TR-20@tx-oct'].amount_minor, 55800);
  assert.equal(st.allocations['tax:TR-20@tx-oct'].rule_version, 1);
});

test('TST-24 on_posted_payment: funded 150000 и платёж 50000 → released 50000, true_up 0; funded 30000 → released 30000, true_up 20000; запись — release со знаком минус', () => {
  const pay = { event_id: 'pay-1', date: '2026-10-23', amount_minor: -50000, currency: 'EUR', reserve_id: 'RES-TAX' };
  const a = on_posted_payment(state_of(G), pay);
  assert.equal(a.released_minor, 50000);
  assert.equal(a.true_up_minor, 0);
  assert.deepEqual(a.allocation, { allocation_id: release_allocation_id('RES-TAX', 'pay-1'), reserve_id: 'RES-TAX', date: '2026-10-23', amount_minor: -50000, source: 'release', source_event_id: 'pay-1' });
  const poor = state_of(G, { reserves: [{ ...G.reserves[0], funded_start_minor: 30000 }] });
  const b = on_posted_payment(poor, pay);
  assert.equal(b.released_minor, 30000);
  assert.equal(b.true_up_minor, 20000);
  assert.equal(b.allocation.amount_minor, -30000);
  const none = on_posted_payment(state_of(G), { ...pay, reserve_id: undefined });
  assert.equal(none.allocation, null, 'платёж без привязки к резерву не высвобождает ничего');
});

test('TST-24 D-08: платёж высвобождает резерв ДО аллокаций доходов того же дня; повторная запись по тому же платежу — already', () => {
  const reserve = { ...G.reserves[0], funded_start_minor: 0 };
  const income_same_day = { allocation_id: 'tax:TR-20@x', reserve_id: 'RES-TAX', date: '2026-10-23', amount_minor: 55800, source: 'income', source_event_id: 'x', rule_version: 1 };
  const pay = { event_id: 'pay-2', date: '2026-10-23', amount_minor: -50000, currency: 'EUR', reserve_id: 'RES-TAX' };
  const r = on_posted_payment(state_of(G, { reserves: [reserve], allocations: [income_same_day] }), pay);
  assert.equal(r.funded_before_minor, 0, 'доход дня в «накоплено до платежа» не входит');
  assert.equal(r.released_minor, 0);
  assert.equal(r.true_up_minor, 50000);
  const done = on_posted_payment(state_of(G, { allocations: [{ allocation_id: release_allocation_id('RES-TAX', 'pay-2'), reserve_id: 'RES-TAX', date: '2026-10-23', amount_minor: -50000, source: 'release' }] }), pay);
  assert.equal(done.already, true);
  assert.equal(done.allocation, null);
});

test('REQ-064 pending_posted_allocations: на G-001 записывать нечего (факты не позже funded_as_of); новая выплата и платёж — по порядку дат, платежи одного дня не высвобождают одни деньги дважды', () => {
  assert.deepEqual(pending_posted_allocations(G), []);
  const ws = {
    ...G, as_of: '2026-11-06',
    facts: [
      ...G.facts,
      { event_id: 'tx-new-in', account_id: 'acc_main', date: '2026-11-05', amount_minor: 279000, currency: 'EUR', kind: 'income', stream_id: 'S-HOURLY' },
      { event_id: 'tx-pay-a', account_id: 'acc_main', date: '2026-11-05', amount_minor: -100000, currency: 'EUR', kind: 'expense', reserve_id: 'RES-TAX' },
      { event_id: 'tx-pay-b', account_id: 'acc_main', date: '2026-11-05', amount_minor: -80000, currency: 'EUR', kind: 'expense', reserve_id: 'RES-TAX' },
    ],
  };
  const p = pending_posted_allocations(ws);
  const by = Object.fromEntries(p.map((x) => [x.event_id, x]));
  assert.equal(by['tx-new-in'].kind, 'income');
  assert.equal(by['tx-new-in'].allocations[0].amount_minor, 55800);
  assert.equal(by['tx-pay-a'].released_minor, 100000);
  assert.equal(by['tx-pay-b'].released_minor, 50000, 'остаток 150000 − 100000 = 50000: второй платёж высвобождает только его');
  assert.equal(by['tx-pay-b'].true_up_minor, 30000);
  // записанные аллокации выводят факт из списка
  const recorded = { ...ws, allocations: [by['tx-new-in'].allocations[0]] };
  assert.ok(!pending_posted_allocations(recorded).some((x) => x.event_id === 'tx-new-in'));
});

test('REQ-064: ошибка по одному факту (нет курса) не прерывает остальные — у строки код ошибки и пустые заготовки', () => {
  const ws = {
    ...G, as_of: '2026-11-06',
    accounts: [...G.accounts, { account_id: 'acc_usd', name: 'USD', kind: 'bank', liquidity: 'savings', currency: 'USD', exponent: 2, liquidity_bp: 0 }],
    facts: [
      ...G.facts,
      { event_id: 'tx-usd', account_id: 'acc_usd', date: '2026-11-05', amount_minor: 100000, currency: 'USD', kind: 'income', stream_id: 'S-HOURLY' },
      { event_id: 'tx-eur', account_id: 'acc_main', date: '2026-11-05', amount_minor: 100000, currency: 'EUR', kind: 'income', stream_id: 'S-HOURLY' },
    ],
  };
  const p = pending_posted_allocations(ws);
  assert.equal(p.find((x) => x.event_id === 'tx-usd').error.code, 'E_NO_RATE');
  assert.equal(p.find((x) => x.event_id === 'tx-eur').allocations[0].amount_minor, 20000);
});
