// ws_edit.test.mjs — чистые функции правки рабочей копии (FP-01): REQ-017 (по негативному тесту на каждый из восьми кодов модели, ноги перевода
// с ненулевой суммой, ключи __proto__), REQ-014 (сценарий не меняет журнал фактов), REQ-012 (правка — новая копия, исходная не мутируется).
// Тесты — в Node, без DOM.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze, canon, ERROR_CODES } from '../engine/index.mjs';
import {
  apply_edit, register_edit, register_validator, list_edit_types, check_model, check_tax_rate_sums, PARAM_SPECS, PARAMS_NOT_EDITABLE, ID_KINDS, decision_currency_of,
} from '../demo/ws_edit.mjs';
import { make_rng } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(fs.readFileSync(path.join(HERE, '..', 'data', name), 'utf8'));
const VOCAB = load('../engine/vocab.json');
const SETS = { g001: load('g001.json'), 'g001-low': load('g001-low.json'), 'g001-gap': load('g001-gap.json'), 'g001-late': load('g001-late.json') };

function deep_freeze(x) {
  if (x !== null && typeof x === 'object' && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const k of Object.keys(x)) deep_freeze(x[k]);
  }
  return x;
}
const G = deep_freeze(JSON.parse(JSON.stringify(SETS.g001)));

/** Применить правку и потребовать успех (с глубокой проверкой расчётом движка). */
function ok(ws, edit, env) {
  const r = apply_edit(ws, edit, { deep: true, ...env });
  assert.equal(r.ok, true, `${edit.type}: ${JSON.stringify(r.error)}`);
  return r.ws;
}
/** Применить правку и потребовать отказ с кодом (и контекстом с полем). */
function refuse(ws, edit, code, env) {
  const r = apply_edit(ws, edit, env);
  assert.equal(r.ok, false, `ожидался отказ ${code} для ${JSON.stringify(edit).slice(0, 120)}`);
  assert.equal(r.error.code, code, JSON.stringify(r.error));
  assert.ok(r.error.ctx !== null && typeof r.error.ctx.field === 'string', 'ошибка несёт поле: ' + JSON.stringify(r.error));
  assert.ok(ERROR_CODES.includes(r.error.code), 'код из реестра канона');
  return r.error;
}
const FACT = { event_id: 'tx-new', account_id: 'acc_main', date: '2026-10-03', amount_minor: -1500, tag: 'кофе' };

// ── словарь правок ───────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-017 словарь правок: add_fact, void_fact, set_anchor, set_param, upsert_account, upsert_rule, delete_rule, upsert_stream, upsert_tax_rule, upsert_reserve, record_allocation, upsert_fx_rate, add_purchase, save_scenario, delete_scenario, set_wave_override, add_counterparty', () => {
  const need = ['add_fact', 'void_fact', 'set_anchor', 'set_param', 'upsert_account', 'upsert_rule', 'delete_rule', 'upsert_stream', 'upsert_tax_rule', 'upsert_reserve',
    'record_allocation', 'upsert_fx_rate', 'add_purchase', 'save_scenario', 'delete_scenario', 'set_wave_override', 'add_counterparty'];
  for (const t of need) assert.ok(list_edit_types().includes(t), t);
});

// ── REQ-017: по негативному тесту на каждый из восьми кодов ──────────────────────────────────────────────────────────

test('REQ-017 E_NOT_INTEGER: нецелая сумма в факте и в якоре отвергается (на любой глубине правки)', () => {
  const e1 = refuse(G, { type: 'add_fact', fact: { ...FACT, amount_minor: 1.5 } }, 'E_NOT_INTEGER');
  assert.equal(e1.ctx.value, '1.5');
  refuse(G, { type: 'set_anchor', anchor: { account_id: 'acc_main', date: '2026-10-04', amount_minor: 100.25 } }, 'E_NOT_INTEGER');
  refuse(G, { type: 'upsert_rule', rule: { ...G.rules[0], amount: { exp_minor: -90000.5 } } }, 'E_NOT_INTEGER');
  refuse(G, { type: 'add_fact', fact: { ...FACT, amount_minor: NaN } }, 'E_NOT_INTEGER');
  refuse(G, { type: 'add_fact', fact: { ...FACT, amount_minor: '1500' } }, 'E_NOT_INTEGER');
});

test('REQ-017 E_OVERFLOW: сумма вне safe-integer отвергается', () => {
  refuse(G, { type: 'add_fact', fact: { ...FACT, amount_minor: 2 ** 53 } }, 'E_OVERFLOW');
  refuse(G, { type: 'set_anchor', anchor: { account_id: 'acc_main', date: '2026-10-04', amount_minor: -(2 ** 60) } }, 'E_OVERFLOW');
  const fine = ok(G, { type: 'add_fact', fact: { ...FACT, amount_minor: -(2 ** 53 - 1) + 1 } }, { deep: false });
  assert.equal(fine.facts.at(-1).amount_minor, -(2 ** 53 - 2));
});

test('REQ-017 E_BAD_DATE: несуществующая дата, не-ISO строка, закрытие счёта раньше открытия', () => {
  refuse(G, { type: 'add_fact', fact: { ...FACT, date: '2026-02-30' } }, 'E_BAD_DATE');
  refuse(G, { type: 'add_fact', fact: { ...FACT, date: 'вчера' } }, 'E_BAD_DATE');
  refuse(G, { type: 'add_fact', fact: { ...FACT, date: 20730 } }, 'E_BAD_DATE');
  refuse(G, { type: 'set_anchor', anchor: { account_id: 'acc_main', date: '2026-13-01', amount_minor: 1 } }, 'E_BAD_DATE');
  refuse(G, { type: 'upsert_account', account: { account_id: 'acc_x', name: 'X', kind: 'bank', liquidity: 'savings', currency: 'EUR', opened_on: '2026-05-01', closed_on: '2026-04-01' } }, 'E_BAD_DATE');
  refuse(G, { type: 'add_purchase', purchase: { purchase_id: 'p1', name: 'x', currency: 'EUR', parts: [{ date: '2026-02-31', amount_minor: 100 }] } }, 'E_BAD_DATE');
  refuse(G, { type: 'upsert_fx_rate', rate: { date: '2026-00-10', base: 'USD', quote: 'EUR', num: 1, den: 1 } }, 'E_BAD_DATE');
});

test('REQ-017 E_FUTURE_POSTED: факт позже as_of (G-001: 2026-10-05 при as_of 2026-10-04); якорь и запись аллокации — тоже', () => {
  const e = refuse(G, { type: 'add_fact', fact: { ...FACT, date: '2026-10-05' } }, 'E_FUTURE_POSTED');
  assert.equal(e.ctx.value, '2026-10-05');
  assert.equal(e.ctx.as_of, '2026-10-04');
  ok(G, { type: 'add_fact', fact: { ...FACT, date: '2026-10-04' } }); // ровно as_of допустимо
  refuse(G, { type: 'add_fact', fact: { ...FACT, date: '2026-10-05' } }, 'E_FUTURE_POSTED', { as_of: '2026-10-04' });
  ok(G, { type: 'add_fact', fact: { ...FACT, date: '2026-10-05' } }, { as_of: '2026-10-05' }); // «сегодня» передаётся приложением
  refuse(G, { type: 'set_anchor', anchor: { account_id: 'acc_main', date: '2026-10-09', amount_minor: 1 } }, 'E_FUTURE_POSTED');
  refuse(G, { type: 'record_allocation', allocation: { allocation_id: 'a1', reserve_id: 'RES-TAX', date: '2026-10-09', amount_minor: 100, source: 'manual' } }, 'E_FUTURE_POSTED');
});

test('REQ-017 E_RULE_INVALID: расход со знаком «плюс», неверная частота, сумма ставок налоговых правил на один доход больше 10000 bp', () => {
  const rule = { ...G.rules[2], rule_id: 'R-NEW' };
  refuse(G, { type: 'upsert_rule', rule: { ...rule, amount: { exp_minor: 2500 } } }, 'E_RULE_INVALID');
  refuse(G, { type: 'upsert_rule', rule: { ...rule, freq: 'X' } }, 'E_RULE_INVALID');
  refuse(G, { type: 'upsert_rule', rule: { ...rule, amount: { exp_minor: 0 } } }, 'E_RULE_INVALID');
  refuse(G, { type: 'upsert_rule', rule: { ...rule, by_weekday: [1] } }, 'E_RULE_INVALID'); // by_weekday только при W
  const t = { tax_rule_id: 'TR-OTHER', name: 'Второе правило пользователя', rate_bp: 8001, applies_to: { stream_ids: ['S-HOURLY'], tags: [] }, valid_from: '2026-01-01', reserve_id: 'RES-TAX' };
  const e = refuse(G, { type: 'upsert_tax_rule', tax_rule: t }, 'E_RULE_INVALID'); // 2000 + 8001 > 10000
  assert.equal(e.ctx.reason, 'rate_sum_gt_10000');
  assert.equal(e.ctx.value, 10001);
  const fine = ok(G, { type: 'upsert_tax_rule', tax_rule: { ...t, rate_bp: 8000 } }); // ровно 10000 допустимо
  assert.equal(fine.tax_rules.length, 2);
  refuse(G, { type: 'upsert_tax_rule', tax_rule: { ...t, rate_bp: 10001 } }, 'E_RULE_INVALID');
  refuse(G, { type: 'upsert_tax_rule', tax_rule: { ...t, rate_bp: 100, valid_from: '2026-13-01' } }, 'E_RULE_INVALID');
});

test('REQ-017 E_CURRENCY_MISMATCH: валюта факта, правила и потока не совпадает с валютой счёта; смена валюты счёта с записями', () => {
  const e = refuse(G, { type: 'add_fact', fact: { ...FACT, currency: 'USD' } }, 'E_CURRENCY_MISMATCH');
  assert.equal(e.ctx.account_currency, 'EUR');
  refuse(G, { type: 'upsert_rule', rule: { ...G.rules[2], rule_id: 'R-NEW', currency: 'USD' } }, 'E_CURRENCY_MISMATCH');
  refuse(G, { type: 'upsert_stream', stream: { ...G.streams[0], stream_id: 'S-NEW', currency: 'USD' } }, 'E_CURRENCY_MISMATCH');
  refuse(G, { type: 'upsert_account', account: { ...G.accounts[0], currency: 'USD' } }, 'E_CURRENCY_MISMATCH');
  refuse(G, { type: 'upsert_fx_rate', rate: { date: '2026-10-01', base: 'EUR', quote: 'EUR', num: 1, den: 1 } }, 'E_CURRENCY_MISMATCH');
});

test('REQ-017 E_NO_RATE: факт, якорь и перевод в валюте без курса к валюте решения', () => {
  const usd = ok(G, { type: 'upsert_account', account: { account_id: 'acc_usd', name: 'Доллары', kind: 'bank', liquidity: 'operating', currency: 'USD', opened_on: '2026-01-01' } }, { deep: false });
  const e = refuse(usd, { type: 'add_fact', fact: { event_id: 'tx-usd', account_id: 'acc_usd', date: '2026-10-03', amount_minor: -500 } }, 'E_NO_RATE');
  assert.equal(e.ctx.currency, 'USD');
  refuse(usd, { type: 'set_anchor', anchor: { account_id: 'acc_usd', date: '2026-10-03', amount_minor: 10000 } }, 'E_NO_RATE');
  refuse(usd, { type: 'add_fact', legs: [
    { event_id: 'l1', account_id: 'acc_main', date: '2026-10-03', amount_minor: -10000 }, { event_id: 'l2', account_id: 'acc_usd', date: '2026-10-03', amount_minor: 11000 },
  ] }, 'E_NO_RATE');
  // с курсом всё принимается и считается движком
  const rated = ok(usd, { type: 'upsert_fx_rate', rate: { date: '2026-10-01', base: 'USD', quote: 'EUR', num: 9250, den: 10000 } }, { deep: false });
  const f = ok(rated, { type: 'add_fact', fact: { event_id: 'tx-usd', account_id: 'acc_usd', date: '2026-10-03', amount_minor: -500 } });
  assert.equal(f.facts.at(-1).currency, 'USD');
  ok(rated, { type: 'set_anchor', anchor: { anchor_id: 'anc-usd', account_id: 'acc_usd', date: '2026-10-03', amount_minor: 10000 } });
});

test('REQ-017 E_SCHEMA: неизвестный вид, неизвестное поле, не объект, неизвестный счёт, нулевая сумма, знак не по виду, повтор идентификатора', () => {
  refuse(G, { type: 'нет_такой' }, 'E_SCHEMA');
  refuse(G, { type: 5 }, 'E_SCHEMA');
  refuse(G, { fact: FACT }, 'E_SCHEMA');
  refuse(G, 'add_fact', 'E_SCHEMA');
  refuse(G, { type: 'add_fact', fact: { ...FACT, лишнее: 1 } }, 'E_SCHEMA');
  refuse(G, { type: 'add_fact', fact: { ...FACT, account_id: 'нет' } }, 'E_SCHEMA');
  refuse(G, { type: 'add_fact', fact: { ...FACT, amount_minor: 0 } }, 'E_SCHEMA');
  refuse(G, { type: 'add_fact', fact: { ...FACT, kind: 'income' } }, 'E_SCHEMA'); // доход со знаком «минус»
  refuse(G, { type: 'add_fact', fact: { ...FACT, event_id: 'tx-g001-01' } }, 'E_SCHEMA'); // повтор
  refuse(G, { type: 'add_fact', fact: { ...FACT, event_id: undefined } }, 'E_SCHEMA'); // идентификатор создаёт приложение
  refuse(G, { type: 'add_fact', fact: { ...FACT, tag: 'x'.repeat(101) } }, 'E_SCHEMA');
  refuse(G, { type: 'void_fact', event_id: 'нет' }, 'E_SCHEMA');
  refuse(G, { type: 'delete_rule', rule_id: 'нет' }, 'E_SCHEMA');
  refuse(G, { type: 'add_fact', fact: FACT }, 'E_BAD_DATE', { as_of: 'сегодня' });
  refuse({ ...G, as_of: undefined }, { type: 'add_fact', fact: FACT }, 'E_BAD_DATE');
  refuse(null, { type: 'add_fact', fact: FACT }, 'E_SCHEMA');
});

test('REQ-017: ноги перевода с ненулевой суммой отвергаются; −50000 и +50000 в одной валюте принимаются; отмена убирает обе ноги', () => {
  const sav = ok(G, { type: 'upsert_account', account: { account_id: 'acc_sav', name: 'Накопления', kind: 'savings', liquidity: 'savings', currency: 'EUR', opened_on: '2026-01-01' } }, { deep: false });
  const legs = (a, b) => ({ type: 'add_fact', transfer_id: 'trf-1', legs: [
    { event_id: 'leg-a', account_id: 'acc_main', date: '2026-10-03', amount_minor: a }, { event_id: 'leg-b', account_id: 'acc_sav', date: '2026-10-03', amount_minor: b },
  ] });
  const e = refuse(sav, legs(-50000, 49999), 'E_SCHEMA');
  assert.equal(e.ctx.reason, 'transfer_legs_nonzero_sum');
  assert.equal(e.ctx.sum, -1);
  assert.ok(!JSON.stringify(e).includes('Накопления'), 'название счёта в ошибку не попадает');
  const t = ok(sav, legs(-50000, 50000));
  assert.deepEqual(t.facts.slice(-2).map((f) => [f.event_id, f.kind, f.transfer_id]), [['leg-a', 'transfer', 'trf-1'], ['leg-b', 'transfer', 'trf-1']]);
  refuse(t, legs(-1, 1), 'E_SCHEMA'); // transfer_id уже занят
  refuse(sav, { type: 'add_fact', legs: [{ event_id: 'l1', account_id: 'acc_main', date: '2026-10-03', amount_minor: -1 }] }, 'E_SCHEMA'); // одна нога
  refuse(sav, { type: 'add_fact', legs: [{ event_id: 'l1', account_id: 'acc_main', date: '2026-10-03', amount_minor: -1 }, { event_id: 'l2', account_id: 'acc_main', date: '2026-10-03', amount_minor: 1 }] }, 'E_SCHEMA'); // один счёт
  refuse(sav, { type: 'add_fact', fact: { ...FACT, kind: 'transfer' } }, 'E_SCHEMA'); // перевод — только двумя ногами
  const back = ok(t, { type: 'void_fact', event_id: 'leg-a' });
  assert.deepEqual(back.facts, G.facts, 'обе ноги убраны одним действием');
  assert.deepEqual(check_model(t).errors, []);
});

test('REQ-017: ключи __proto__, constructor, prototype отвергаются на любой глубине правки и в идентификаторах', () => {
  const parse = (s) => JSON.parse(s); // из JSON ключ __proto__ становится собственным свойством
  const bad = [
    parse('{"type":"add_fact","fact":{"event_id":"x","account_id":"acc_main","date":"2026-10-03","amount_minor":-1,"__proto__":{"admin":true}}}'),
    parse('{"type":"upsert_rule","rule":{"rule_id":"R-P","account_id":"acc_main","amount":{"exp_minor":-1,"constructor":{"prototype":{"x":1}}}}}'),
    parse('{"type":"save_scenario","scenario":{"scenario_id":"s","name":"s","ops":[{"op":"delay_income","event_ref":"x","days":1,"__proto__":{"y":1}}]}}'),
    parse('{"type":"set_param","key":"horizon_days","value":10,"prototype":1}'),
  ];
  for (const edit of bad) {
    const e = refuse(G, edit, 'E_SCHEMA');
    assert.equal(e.ctx.reason, 'forbidden_key', JSON.stringify(e));
  }
  assert.equal({}.admin, undefined, 'прототип объектов не загрязнён');
  for (const id of ['__proto__', 'constructor', 'prototype']) {
    refuse(G, { type: 'add_counterparty', counterparty: { counterparty_id: id, name: 'x' } }, 'E_SCHEMA');
    refuse(G, { type: 'set_param', key: id, value: 1 }, 'E_SCHEMA');
    refuse(G, { type: 'void_fact', event_id: id }, 'E_SCHEMA');
  }
  refuse(G, { type: 'add_counterparty', counterparty: { counterparty_id: 'a|b', name: 'x' } }, 'E_SCHEMA'); // «|» — разделитель ключа дедупликации
  refuse(G, { type: 'add_counterparty', counterparty: { counterparty_id: 'auto:x', name: 'x' } }, 'E_SCHEMA'); // служебный префикс
  refuse(G, { type: 'add_counterparty', counterparty: { counterparty_id: ' пробел', name: 'x' } }, 'E_SCHEMA');
  // не обычный объект (экземпляр класса) тоже отвергается
  refuse(G, { type: 'add_fact', fact: Object.assign(Object.create({ x: 1 }), FACT) }, 'E_SCHEMA');
});

test('REQ-017: ошибка несёт код и контекст (поле, значение), но не названия, заметки, метки и получателей', () => {
  const secret = 'СЕКРЕТНЫЙ_ПОЛУЧАТЕЛЬ_ООО';
  const cases = [
    { type: 'add_fact', fact: { ...FACT, amount_minor: 1.5, tag: secret, note: secret } },
    { type: 'add_fact', fact: { ...FACT, date: '2026-10-05', tag: secret, note: secret } },
    { type: 'add_fact', fact: { ...FACT, currency: 'USD', tag: secret } },
    { type: 'upsert_rule', rule: { ...G.rules[0], rule_id: 'R-S', name: secret, amount: { exp_minor: 5 } } },
    { type: 'add_counterparty', counterparty: { counterparty_id: 'a|b', name: secret } },
    { type: 'upsert_account', account: { account_id: 'acc_z', name: secret, kind: 'нет', liquidity: 'operating', currency: 'EUR' } },
    { type: 'upsert_tax_rule', tax_rule: { tax_rule_id: 'TR-Z', name: secret, rate_bp: 20000, applies_to: { stream_ids: ['S-HOURLY'], tags: [] }, valid_from: '2026-01-01', reserve_id: 'RES-TAX' } },
  ];
  for (const edit of cases) {
    const r = apply_edit(G, edit);
    assert.equal(r.ok, false);
    assert.ok(!JSON.stringify(r.error).includes(secret), JSON.stringify(r.error));
    assert.equal(typeof r.error.code, 'string');
  }
});

// ── единое пространство Id ───────────────────────────────────────────────────────────────────────────────────────────

test('REQ-017 единое пространство Id (C-025): rule_id, stream_id, tax_rule_id, reserve_id, счёт и другие сущности не совпадают', () => {
  const edits = [
    { type: 'upsert_stream', stream: { ...G.streams[0], stream_id: 'R-RENT' } }, // поток с id правила
    { type: 'upsert_rule', rule: { ...G.rules[0], rule_id: 'S-HOURLY' } }, // правило с id потока
    { type: 'upsert_reserve', reserve: { reserve_id: 'TR-20', kind: 'tax', name: 'x', currency: 'EUR', funded_as_of: '2026-10-04' } },
    { type: 'upsert_account', account: { ...G.accounts[0], account_id: 'RES-TAX' } },
    { type: 'add_counterparty', counterparty: { counterparty_id: 'acc_main', name: 'x' } },
    { type: 'save_scenario', scenario: { scenario_id: 'pur-treadmill', name: 'x', ops: [] } },
    { type: 'upsert_tax_rule', tax_rule: { tax_rule_id: 'RES-TAX', name: 'x', rate_bp: 1, applies_to: { stream_ids: ['S-HOURLY'], tags: [] }, valid_from: '2026-01-01', reserve_id: 'RES-TAX' } },
  ];
  for (const edit of edits) {
    const e = refuse(G, edit, 'E_SCHEMA');
    assert.equal(e.ctx.reason, 'id_taken_by_other_kind', JSON.stringify(e));
  }
  // тот же вид — это правка существующей сущности, а не коллизия
  ok(G, { type: 'upsert_rule', rule: { ...G.rules[0], amount: { exp_minor: -91000 } } });
  assert.deepEqual(Object.keys(ID_KINDS).sort(), ['account', 'calendar', 'counterparty', 'debt', 'plan', 'purchase', 'reserve', 'rule', 'scenario', 'stream', 'tax_rule']);
});

// ── не мутирует, копирует при записи ─────────────────────────────────────────────────────────────────────────────────

test('REQ-012: исходная рабочая область не мутируется (заморожена), неизменённые корзины разделяются, результат — новый объект', () => {
  const before = canon(G);
  const r = apply_edit(G, { type: 'add_fact', fact: FACT }, { deep: true });
  assert.equal(r.ok, true);
  assert.notEqual(r.ws, G);
  assert.equal(canon(G), before, 'G не изменился');
  assert.equal(r.ws.rules, G.rules, 'корзина rules разделяется');
  assert.notEqual(r.ws.facts, G.facts);
  assert.equal(r.ws.facts.length, G.facts.length + 1);
  assert.deepEqual(r.touched, ['facts']);
  assert.ok(Object.isFrozen(G) && Object.isFrozen(G.facts), 'вход был заморожен — попытка записи упала бы');
});

test('REQ-014: сохранение и удаление сценария не меняет журнал фактов (та же корзина facts)', () => {
  const s1 = ok(G, { type: 'save_scenario', scenario: { scenario_id: 'scn-x', name: 'Выплата позже', ops: [{ op: 'delay_income', event_ref: 'S-HOURLY@2026-11-05', days: 7 }] } });
  assert.equal(s1.facts, G.facts);
  assert.equal(s1.scenarios.length, G.scenarios.length + 1);
  const s2 = ok(s1, { type: 'delete_scenario', scenario_id: 'scn-x' });
  assert.equal(s2.facts, G.facts);
  assert.deepEqual(s2.scenarios, G.scenarios);
  refuse(G, { type: 'save_scenario', scenario: { scenario_id: 'scn-y', name: 'x', ops: [{ op: 'взорвать' }] } }, 'E_SCHEMA');
  refuse(G, { type: 'save_scenario', scenario: { scenario_id: 'scn-y', name: 'x', ops: [{ op: 'set_amount', event_ref: 'R-RENT@2026-10-26', amount_minor: 0 }] } }, 'E_SCHEMA');
});

// ── сквозной сценарий: все виды правок подряд, расчёт движка принимает результат ───────────────────────────────────

test('REQ-017: все 17 видов правок подряд на G-001 — каждый результат проходит analyze и полную проверку модели', () => {
  let ws = G;
  ws = ok(ws, { type: 'upsert_account', account: { account_id: 'acc_sav', name: 'Накопления', kind: 'savings', liquidity: 'savings', currency: 'EUR', opened_on: '2026-01-01' } });
  ws = ok(ws, { type: 'add_counterparty', counterparty: { counterparty_id: 'cp-1', name: 'Клиент', usual_delay_days: 5 } });
  ws = ok(ws, { type: 'upsert_fx_rate', rate: { date: '2026-10-01', base: 'USD', quote: 'EUR', num: 9250, den: 10000 } });
  ws = ok(ws, { type: 'set_param', key: 'buffer_minor', value: 60000 });
  ws = ok(ws, { type: 'set_anchor', anchor: { anchor_id: 'anc-new', account_id: 'acc_main', date: '2026-10-04', amount_minor: 400000 } });
  ws = ok(ws, { type: 'add_fact', fact: { ...FACT, counterparty_id: 'cp-1' } });
  ws = ok(ws, { type: 'add_fact', transfer_id: 'trf-9', legs: [
    { event_id: 'leg-1', account_id: 'acc_main', date: '2026-10-02', amount_minor: -20000 }, { event_id: 'leg-2', account_id: 'acc_sav', date: '2026-10-02', amount_minor: 20000 },
  ] });
  ws = ok(ws, { type: 'upsert_rule', rule: { rule_id: 'R-GYM', account_id: 'acc_main', name: 'Зал', kind: 'expense', amount: { exp_minor: -3000 }, freq: 'M', interval: 1, by_monthday: [3], start_date: '2026-01-03', month_end: 'clamp', weekend: 'next', calendar_id: 'cal-main', exdates: [], is_obligation: false, is_estimate: false, tag: 'спорт' } });
  ws = ok(ws, { type: 'upsert_rule', rule: { ...ws.rules.find((r) => r.rule_id === 'R-GYM'), amount: { exp_minor: -3500 } } });
  assert.equal(ws.rules.find((r) => r.rule_id === 'R-GYM').version, 2, 'правка правила повышает версию');
  ws = ok(ws, { type: 'upsert_stream', stream: { ...ws.streams[0], pace_minutes_per_day: 200 } });
  ws = ok(ws, { type: 'upsert_reserve', reserve: { reserve_id: 'RES-HOL', kind: 'sinking', name: 'Отпуск', currency: 'EUR', funded_start_minor: 0, funded_as_of: '2026-10-04', mode: 'fixed', fixed_minor: 10000, target_minor: 120000, due_date: '2027-06-01' } });
  ws = ok(ws, { type: 'upsert_tax_rule', tax_rule: { tax_rule_id: 'TR-20', name: 'Налоговый конверт 20 % (правило пользователя, не консультация)', rate_bp: 2500, applies_to: { stream_ids: ['S-HOURLY'], tags: [] }, valid_from: '2026-12-01', reserve_id: 'RES-TAX' } });
  assert.deepEqual(ws.tax_rules.map((t) => [t.tax_rule_id, t.version]), [['TR-20', 1], ['TR-20', 2]], 'версия добавляется, прошлая не правится');
  ws = ok(ws, { type: 'record_allocation', allocation: { allocation_id: 'alc-1', reserve_id: 'RES-HOL', date: '2026-10-03', amount_minor: 5000, source: 'manual' } });
  ws = ok(ws, { type: 'record_allocation', allocation: { allocation_id: 'alc-1', reserve_id: 'RES-HOL', date: '2026-10-03', amount_minor: 5000, source: 'manual' } });
  assert.equal(ws.allocations.length, 1, 'запись аллокации идемпотентна по идентификатору');
  refuse(ws, { type: 'record_allocation', allocation: { allocation_id: 'alc-2', reserve_id: 'TR-20', date: '2026-10-03', amount_minor: 1, source: 'manual' } }, 'E_SCHEMA');
  refuse(ws, { type: 'record_allocation', allocation: { allocation_id: 'alc-2', reserve_id: 'RES-TAX', date: '2026-10-03', amount_minor: 1, source: 'income' } }, 'E_SCHEMA'); // нет rule_version
  ws = ok(ws, { type: 'add_purchase', purchase: { purchase_id: 'pur-new', name: 'Ноутбук', currency: 'EUR', parts: [{ date: '2026-10-20', amount_minor: 90000 }, { date: '2026-11-20', amount_minor: 90000 }] } });
  ws = ok(ws, { type: 'save_scenario', scenario: { scenario_id: 'scn-new', name: 'Дорожка', ops: [{ op: 'add_purchase', parts: [{ date: '2026-10-12', amount_minor: 30000 }] }, { op: 'fx_shock', currency: 'USD', bp: -500 }] } });
  ws = ok(ws, { type: 'set_wave_override', override: { override_id: 'wov-1', action: 'pin', event_ids: ['R-RENT@2026-10-26'], pin_range: { from: '2026-10-20', to: '2026-10-30' } } });
  ws = ok(ws, { type: 'set_wave_override', override: { override_id: 'wov-2', action: 'merge', event_ids: ['R-RENT@2026-10-26', 'R-UTIL@2026-10-26'] } });
  ws = ok(ws, { type: 'set_wave_override', override: { override_id: 'wov-1', action: 'split', event_ids: ['R-UTIL@2026-10-26'] } });
  assert.deepEqual(ws.wave_overrides.map((o) => o.override_id), ['wov-2', 'wov-1'], 'правка с тем же id уходит в конец: порядок применения — порядок записей');
  ws = ok(ws, { type: 'set_wave_override', override_id: 'wov-2', remove: true });
  ws = ok(ws, { type: 'void_fact', event_id: 'leg-1' });
  assert.ok(!ws.facts.some((f) => f.transfer_id === 'trf-9'));
  ws = ok(ws, { type: 'delete_scenario', scenario_id: 'scn-new' });
  ws = ok(ws, { type: 'delete_rule', rule_id: 'R-GYM' });
  assert.deepEqual(check_model(ws).errors, []);
  assert.ok(!ws.overrides.some((o) => o.rule_id === 'R-GYM'));
});

// ── параметры ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-017 set_param: ключи — из vocab.json (kdf.* не редактируются), границы и типы проверяются, null — «не задан» только у необязательных', () => {
  const vocab_keys = Object.keys(VOCAB.params).sort();
  const covered = [...Object.keys(PARAM_SPECS), ...PARAMS_NOT_EDITABLE].sort();
  assert.deepEqual(covered, vocab_keys, 'таблица PARAM_SPECS и реестр параметров vocab.json совпадают');
  const ws = ok(G, { type: 'set_param', key: 'buffer_minor', value: 70000 });
  assert.equal(ws.params.buffer_minor, 70000);
  assert.equal(G.params.buffer_minor, 50000);
  assert.equal(ok(G, { type: 'set_param', key: 'buffer_minor', value: null }).params.buffer_minor, null);
  assert.equal(ok(G, { type: 'set_param', key: 'headline_mode', value: 'plan' }).params.headline_mode, 'plan');
  refuse(G, { type: 'set_param', key: 'headline_mode', value: 'expected' }, 'E_SCHEMA');
  refuse(G, { type: 'set_param', key: 'horizon_days', value: null }, 'E_SCHEMA');
  refuse(G, { type: 'set_param', key: 'horizon_days', value: 0 }, 'E_SCHEMA');
  refuse(G, { type: 'set_param', key: 'horizon_days', value: 99999 }, 'E_SCHEMA');
  refuse(G, { type: 'set_param', key: 'buffer_minor', value: -1 }, 'E_SCHEMA');
  refuse(G, { type: 'set_param', key: 'rounding', value: 'random' }, 'E_SCHEMA');
  refuse(G, { type: 'set_param', key: 'kdf.iterations', value: 1 }, 'E_SCHEMA');
  refuse(G, { type: 'set_param', key: 'нет', value: 1 }, 'E_SCHEMA');
  refuse(G, { type: 'set_param', key: 'match.tol_bp', value: 10001 }, 'E_SCHEMA');
  assert.equal(ok(G, { type: 'set_param', key: 'decision_currency', value: 'EUR' }).params.decision_currency, 'EUR');
  refuse(G, { type: 'set_param', key: 'decision_currency', value: 'ZZZ' }, 'E_SCHEMA');
});

// ── расширяемость ────────────────────────────────────────────────────────────────────────────────────────────────────

test('register_edit и register_validator: пакеты добавляют виды правок и проверки; повтор имени — ошибка; внутренний сбой — E_SCHEMA, а не исключение', () => {
  register_edit('test_noop', (ws) => ({ ...ws, name: 'правка пакета' }));
  assert.throws(() => register_edit('test_noop', (ws) => ws), /уже зарегистрирован/);
  assert.throws(() => register_edit('Bad-Name', (ws) => ws), TypeError);
  assert.throws(() => register_edit('x', 5), TypeError);
  assert.ok(list_edit_types().includes('test_noop'));
  assert.equal(ok(G, { type: 'test_noop' }, { deep: false }).name, 'правка пакета');
  register_edit('test_boom', () => { throw new TypeError('баг пакета'); });
  const e = refuse(G, { type: 'test_boom' }, 'E_SCHEMA');
  assert.equal(e.ctx.reason, 'internal');
  register_edit('test_nothing', () => null);
  refuse(G, { type: 'test_nothing' }, 'E_SCHEMA');
  register_validator((ws, edit) => { if (edit.type === 'test_validated' && ws.name === 'плохое имя') { const err = new Error('x'); err.name = 'RunwayError'; throw err; } });
  register_edit('test_validated', (ws, edit) => ({ ...ws, name: edit.name }));
  assert.equal(apply_edit(G, { type: 'test_validated', name: 'хорошее имя' }).ok, true);
  assert.equal(apply_edit(G, { type: 'test_validated', name: 'плохое имя' }).ok, false, 'общий валидатор отвергает результат');
  assert.throws(() => register_validator(5), TypeError);
});

// ── полная проверка модели ───────────────────────────────────────────────────────────────────────────────────────────

test('check_model: четыре набора G-001 проходят; нарушения находятся — будущий факт, чужая валюта, нет счёта, ноги перевода, коллизия Id, повтор Id', () => {
  for (const [name, ws] of Object.entries(SETS)) assert.deepEqual(check_model(ws).errors, [], name);
  const bad = JSON.parse(JSON.stringify(SETS.g001));
  bad.facts.push({ event_id: 'f1', account_id: 'acc_main', date: '2026-10-05', amount_minor: -1, currency: 'EUR' });
  bad.facts.push({ event_id: 'f2', account_id: 'acc_main', date: '2026-10-01', amount_minor: -1, currency: 'USD' });
  bad.facts.push({ event_id: 'f3', account_id: 'нет', date: '2026-10-01', amount_minor: -1 });
  bad.accounts.push({ account_id: 'acc_sav', name: 'Накопления', kind: 'savings', liquidity: 'savings', currency: 'EUR', exponent: 2, liquidity_bp: 0, opened_on: '2026-01-01' });
  bad.facts.push({ event_id: 'f4', account_id: 'acc_main', date: '2026-10-01', amount_minor: -50000, kind: 'transfer', transfer_id: 't', currency: 'EUR' });
  bad.facts.push({ event_id: 'f5', account_id: 'acc_sav', date: '2026-10-01', amount_minor: 49999, kind: 'transfer', transfer_id: 't', currency: 'EUR' });
  bad.streams.push({ ...bad.streams[0], stream_id: 'R-RENT' });
  bad.rules.push({ ...bad.rules[0] });
  const codes = check_model(bad).errors.map((e) => e.code + ':' + (e.ctx?.reason ?? ''));
  for (const need of ['E_FUTURE_POSTED:posted_after_as_of', 'E_CURRENCY_MISMATCH:differs_from_account', 'E_SCHEMA:unknown_account', 'E_SCHEMA:transfer_legs_nonzero_sum', 'E_SCHEMA:id_taken_by_other_kind', 'E_SCHEMA:duplicate_id']) {
    assert.ok(codes.includes(need), `${need} не найден среди ${codes.join(', ')}`);
  }
  assert.deepEqual(check_tax_rate_sums([]), undefined);
  assert.equal(decision_currency_of(SETS.g001), 'EUR');
  assert.equal(decision_currency_of({ accounts: [{ liquidity: 'operating', currency: 'USD' }] }), 'USD');
  assert.equal(decision_currency_of({}), null);
});

// ── свойство: мусор не роняет, а отвергается ─────────────────────────────────────────────────────────────────────────

test('REQ-017 свойство: 600 случайных и повреждённых правок — apply_edit не бросает исключение, форма результата всегда {ok, ws|error}; принятое проходит analyze', () => {
  const rng = make_rng(17);
  const types = list_edit_types().filter((t) => !t.startsWith('test_'));
  const junk = () => rng.pick([null, undefined, 0, -1, 1.5, 2 ** 53, '', 'x', '2026-10-04', '2026-02-30', [], {}, [1, 2], true, 'EUR', 'acc_main', 'R-RENT', -50000, 50000]);
  let accepted = 0;
  for (let i = 0; i < 600; i++) {
    const type = rng.bool() ? rng.pick(types) : rng.pick(['', 'x', null, 5]);
    const edit = { type };
    const fields = rng.int(0, 4);
    for (let k = 0; k < fields; k++) {
      const name = rng.pick(['fact', 'anchor', 'rule', 'stream', 'tax_rule', 'reserve', 'allocation', 'rate', 'purchase', 'scenario', 'override', 'counterparty', 'account', 'key', 'value', 'event_id', 'rule_id', 'scenario_id', 'legs', 'remove']);
      edit[name] = rng.bool() ? junk() : { event_id: 'q' + i, account_id: junk(), date: junk(), amount_minor: junk(), name: junk(), rule_id: junk() };
    }
    const r = apply_edit(G, edit);
    assert.equal(typeof r.ok, 'boolean');
    if (r.ok) {
      accepted += 1;
      assert.doesNotThrow(() => analyze(r.ws, { as_of: r.ws.as_of }), JSON.stringify(edit).slice(0, 200));
    } else {
      assert.ok(ERROR_CODES.includes(r.error.code), r.error.code);
      assert.ok(Object.hasOwn(r.error, 'ctx'));
    }
  }
  assert.ok(accepted < 60, 'почти весь мусор отвергнут: принято ' + accepted);
});

// ── интеграция волны 1: validate_ws подключён к каждой правке (FP-01 п. 2, FP-02 п. 3) ─────────────────────────────────────────────────

test('REQ-017 REQ-158 validate_ws как общая проверка: результат правки проверяется целиком кодами чужого файла; значения полей в отказ не попадают; «сегодня» приложения учитывается', () => {
  // результат валиден: validate_ws ничего не добавляет к принятым правкам на всех четырёх наборах
  for (const [name, ws] of Object.entries(SETS)) {
    const r = apply_edit(ws, { type: 'set_param', key: 'buffer_minor', value: 70000 });
    assert.equal(r.ok, true, name + ': ' + JSON.stringify(r.error));
  }
  // сохранённый чужой файл с повреждением не даёт «починить» его правкой мимо проверки
  const broken = { ...G, facts: [...G.facts, { event_id: 'tx-bad', account_id: 'acc_main', date: '2026-10-03', amount_minor: 1.5, tag: 'x' }] };
  const r = apply_edit(broken, { type: 'set_param', key: 'buffer_minor', value: 70000 });
  assert.equal(r.ok, false, 'нецелая сумма в фактах: правка отказана');
  assert.ok(ERROR_CODES.includes(r.error.code), r.error.code);
  assert.ok(!JSON.stringify(r.error).includes('1.5'), 'значение поля в отказ не попадает');
  // «сегодня» приложения позже ws.as_of: факт на эту дату допустим (validate_ws получает as_of из env)
  assert.equal(apply_edit(G, { type: 'add_fact', fact: { ...FACT, date: '2026-10-05' } }, { as_of: '2026-10-05' }).ok, true);
});

test('REQ-017 θ ≥ 1: порог волны wave.threshold_minor нулём не задаётся (канон), null — «не задан», 1 — допустимо', () => {
  refuse(G, { type: 'set_param', key: 'wave.threshold_minor', value: 0 }, 'E_SCHEMA');
  assert.equal(ok(G, { type: 'set_param', key: 'wave.threshold_minor', value: 1 }).params['wave.threshold_minor'], 1);
  assert.equal(ok(G, { type: 'set_param', key: 'wave.threshold_minor', value: null }).params['wave.threshold_minor'], null);
});
