// debtedit.test.mjs — FP-14 (демо, без DOM): виды правок долга для ws_edit.register_edit, журнал, «Отменить», модели показа, строки RU/EN.
// Покрывает: REQ-082 (upsert_debt: счёт, валюта, validate_debt; перенос строки графика), REQ-083 (apply_prepay и apply_reanchor пишут пересчитанный график в сохранённый долг),
// REQ-012/REQ-094 (журнал: debt.set с supersedes_id, круг без потерь), REQ-090/TST-16 (единая стопка «Отменить» знает корзину debts), TST-56 (строки, причины отказа),
// REQ-131 (названия долга нет в контексте ошибок). Экраны и настоящий app.mjs — tests/debt_edit_boot.test.mjs.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/debtedit.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyze, canon, format_date, parse_date } from '../engine/index.mjs';
import { build_debt_record, apply_prepay, apply_reanchor, move_row_date, rows_of } from '../engine/debt_ext.mjs';
import { validate_ws } from '../engine/validate_ws.mjs';
import { apply_edit, list_edit_types, register_edit } from '../demo/ws_edit.mjs';
import { ws_to_events, events_to_ws, sync_journal, ws_to_journal, journal_to_ws, BUCKETS } from '../demo/ws_bridge.mjs';
import { create_journal, ports_from_gen } from '../demo/journal_log.mjs';
import { make_id_gen, seeded_ports } from '../demo/ids.mjs';
import { register_strings, t as tr_of } from '../demo/i18n.mjs';
import { diff_unit, apply_unit, describe_unit, unit_label, UNDO_ARRAY_BUCKETS, REASON_KINDS, UNDO_LABEL_KEYS } from '../demo/undo.mjs';
import entry_catalog from '../demo/i18n/entry.mjs';
import catalog from '../demo/i18n/debtedit.mjs';
import forms_catalog from '../demo/i18n/forms.mjs';
import showcase_catalog from '../demo/i18n/showcase.mjs';
import { EDITS, add_edit, pay_accounts, same_terms_exists, prepay_preview, reanchor_preview, reason_text } from '../demo/debt_edit.mjs';
import { register as register_pack } from '../demo/pack_fp14.mjs';
import * as DB from '../demo/debts.mjs';

const DATA = new URL('../data/', import.meta.url);
const load = (name) => JSON.parse(fs.readFileSync(new URL(name, DATA), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const G = load('g001.json');
const GD = load('g001-debt.json');
const AS_OF = G.as_of;
const SECRET = 'СЕКРЕТНОЕ-НАЗВАНИЕ-ДОЛГА';
const hash_of = (ws) => analyze(ws, { as_of: ws.as_of }).inputs_hash;
const day = (iso) => parse_date(iso);

for (const [type, fn] of Object.entries(EDITS)) if (!list_edit_types().includes(type)) register_edit(type, fn);
for (const [ns, cat] of [['entry', entry_catalog], ['forms', forms_catalog], ['showcase', showcase_catalog], ['debtedit', catalog]]) {
  try { register_strings(ns, cat); } catch { /* уже принят */ }
}

let counter = 0;
const new_id = (prefix) => `${prefix}_t${++counter}`;
const edit_of = (ws, edit, env = {}) => apply_edit(ws, edit, { new_id, ...env });
const ok = (ws, edit, env) => { const r = edit_of(ws, edit, env); assert.equal(r.ok, true, JSON.stringify(r.error)); return r.ws; };
/** Код и причина отказа правки. */
const refusal = (ws, edit, env) => { const r = edit_of(ws, edit, env); assert.equal(r.ok, false, 'правка должна быть отвергнута'); return [r.error.code, r.error.ctx?.reason ?? null]; };
const NEW = { debt_id: 'D-NEW', name: SECRET, pay_account_id: 'acc_main', kind: 'annuity', principal_minor: 120000, rate_bp: 1200, n: 6, start_date: '2026-11-05' };
const up = (patch = {}, ws = G) => edit_of(ws, { type: 'upsert_debt', debt: { ...NEW, ...patch } });
const why = (patch, ws = G) => { const r = up(patch, ws); assert.equal(r.ok, false, JSON.stringify(patch)); return [r.error.code, r.error.ctx?.reason ?? null]; };

const SPEC = { debt_id: 'D-LOAN', name: 'Кредит на технику', pay_account_id: 'acc_main', currency: 'EUR', kind: 'annuity', principal_minor: 120000, rate_bp: 1200, n: 6, start_date: '2026-11-05' };
const PP = { type: 'apply_prepay', debt_id: 'D-LOAN', date: '2026-12-05', amount_minor: 30000, option: 'shorten' };
const RA = { type: 'apply_reanchor', debt_id: 'D-LOAN', k: 2, observed_minor: 80900 };
const MV = { type: 'move_debt_row', debt_id: 'D-LOAN', k: 2, date: '2026-12-07' };

// ═══ регистрация ═════════════════════════════════════════════════════════════════════════════════════════════════════

test('REQ-082 пакет FP-14: пять видов правок регистрируются один раз (повторная загрузка не падает), каталог строк принимается один раз, блоки подключены к экрану «Долги»', () => {
  const regs = { edits: [], i18n: [] };
  const fake = {
    ctx: { tr: (k) => (regs.i18n.length > 0 ? 'есть' : k) },
    register_i18n: (ns) => regs.i18n.push(ns),
    register_edit: (t) => regs.edits.push(t),
  };
  const deps1 = register_pack(fake);
  assert.deepEqual(regs.i18n, ['debtedit']);
  assert.deepEqual(regs.edits, [], 'все виды правок уже зарегистрированы этим файлом: повторно не регистрируются');
  const deps2 = register_pack(fake);
  assert.deepEqual(regs.i18n, ['debtedit'], 'каталог — один раз на процесс');
  assert.ok(deps1.ui.by instanceof Map && deps2.ui.by instanceof Map);
  assert.deepEqual(Object.keys(EDITS).sort(), ['apply_prepay', 'apply_reanchor', 'delete_debt', 'move_debt_row', 'upsert_debt']);
  for (const t of Object.keys(EDITS)) assert.ok(list_edit_types().includes(t), t);
  // пакет, загруженный в пустом процессе, регистрирует недостающие виды правок
  const fresh = new Set();
  register_pack({ ctx: { tr: (k) => k }, register_i18n: () => {}, register_edit: (t) => fresh.add(t) });
  assert.ok(fresh.size === 0 || [...fresh].every((t) => Object.hasOwn(EDITS, t)));
});

// ═══ upsert_debt ═════════════════════════════════════════════════════════════════════════════════════════════════════

test('REQ-082 upsert_debt: долг записывается со сохранённым графиком (как build_debt_record), меняется только корзина debts, исходная область не изменена; deep-пересчёт проходит', () => {
  const frozen = Object.freeze(clone(G));
  const r = edit_of(frozen, { type: 'upsert_debt', debt: { ...NEW, name: 'Кредит на технику', debt_id: 'D-LOAN' } }, { deep: true });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(r.touched, ['debts']);
  assert.deepEqual(r.ws.debts, [build_debt_record(SPEC)]);
  assert.equal(r.ws.accounts, frozen.accounts, 'неизменённые корзины разделяются');
  assert.deepEqual(frozen.debts, [], 'исходная область не изменена');
  assert.equal(canon(r.ws), canon({ ...clone(G), debts: GD.debts }), 'то же, что набор g001-debt.json');
  // идентификатор создаёт приложение, если его не задали
  const auto = ok(G, { type: 'upsert_debt', debt: (({ debt_id: _id, ...rest }) => rest)(NEW) });
  assert.match(auto.debts[0].debt_id, /^debt_t\d+$/);
  // название обрезается по краям и приводится к NFC; валюта берётся со счёта
  const spaced = ok(G, { type: 'upsert_debt', debt: { ...NEW, name: '  Кредит  ' } });
  assert.equal(spaced.debts[0].name, 'Кредит');
  assert.equal(spaced.debts[0].currency, 'EUR');
  assert.equal(spaced.debts[0].rounding, 'half_even');
  assert.equal(ok({ ...clone(G), params: { ...G.params, rounding: 'half_up' } }, { type: 'upsert_debt', debt: NEW }).debts[0].rounding, 'half_up');
  assert.equal(ok({ ...clone(G), params: { ...G.params, rounding: 'floor' } }, { type: 'upsert_debt', debt: NEW }).debts[0].rounding, 'half_even', 'график знает только half_even и half_up');
});

test('REQ-082 upsert_debt: аннуитет под 0 % записывается как рассрочка; дифференцированный и рассрочка без процентов принимаются; запись с тем же debt_id заменяется целиком (история сбрасывается)', () => {
  assert.equal(ok(G, { type: 'upsert_debt', debt: { ...NEW, rate_bp: 0 } }).debts[0].kind, 'installment_0');
  assert.equal(ok(G, { type: 'upsert_debt', debt: { ...NEW, kind: 'differential' } }).debts[0].schedule[0].payment_minor, 21200);
  assert.equal(ok(G, { type: 'upsert_debt', debt: { ...NEW, kind: 'installment_0', rate_bp: 0 } }).debts[0].kind, 'installment_0');
  const once = ok(G, { type: 'upsert_debt', debt: NEW });
  const changed = ok(once, PP_OF(once));
  assert.equal(changed.debts[0].history.length, 1);
  const again = ok(changed, { type: 'upsert_debt', debt: { ...NEW, principal_minor: 90000 } });
  assert.equal(again.debts.length, 1, 'тот же debt_id — замена, а не второй долг');
  assert.equal(again.debts[0].principal_minor, 90000);
  assert.equal(again.debts[0].history, undefined);
  const two = ok(once, { type: 'upsert_debt', debt: { ...NEW, debt_id: 'D-NEW-2' } });
  assert.deepEqual(two.debts.map((d) => d.debt_id), ['D-NEW', 'D-NEW-2'], 'второй долг добавляется в конец');
});

function PP_OF(ws) {
  return { type: 'apply_prepay', debt_id: ws.debts[0].debt_id, date: '2026-12-05', amount_minor: 30000, option: 'shorten' };
}

test('REQ-082 upsert_debt: проверка счёта платежей — неизвестный, не операционный, закрытый; валюта долга ≠ валюте счёта — E_CURRENCY_MISMATCH; для чужой валюты нужен курс (E_NO_RATE)', () => {
  assert.deepEqual(why({ pay_account_id: 'нет-такого' }), ['E_SCHEMA', 'unknown_account']);
  const sav = { ...clone(G), accounts: [...G.accounts, { account_id: 'acc_sav', name: 'Копилка', kind: 'savings', liquidity: 'savings', currency: 'EUR', exponent: 2, opened_on: '2026-01-01' }] };
  assert.deepEqual(why({ pay_account_id: 'acc_sav' }, sav), ['E_SCHEMA', 'pay_account_not_operating']);
  const closed = { ...clone(G), accounts: [...G.accounts, { account_id: 'acc_old', name: 'Старый', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2, opened_on: '2026-01-01', closed_on: '2026-09-30' }] };
  assert.deepEqual(why({ pay_account_id: 'acc_old' }, closed), ['E_SCHEMA', 'pay_account_closed']);
  assert.deepEqual(why({ currency: 'USD' }), ['E_CURRENCY_MISMATCH', 'differs_from_account']);
  assert.deepEqual(why({ currency: 'нет' }), ['E_SCHEMA', 'bad_currency']);
  const usd = {
    ...clone(G), accounts: [...G.accounts, { account_id: 'acc_usd', name: 'USD', kind: 'bank', liquidity: 'operating', currency: 'USD', exponent: 2, opened_on: '2026-01-01' }],
    anchors: [...G.anchors, { anchor_id: 'anc-usd', account_id: 'acc_usd', date: AS_OF, amount_minor: 100000 }],
  };
  assert.deepEqual(why({ pay_account_id: 'acc_usd' }, usd), ['E_NO_RATE', 'no_rate'], 'у платёжного счёта в USD нет курса к EUR');
  const rated = { ...usd, rates: [{ fx_id: 'fx-1', date: '2026-10-01', base: 'USD', quote: 'EUR', num: 92, den: 100, source: 'manual' }] };
  const r = edit_of(rated, { type: 'upsert_debt', debt: { ...NEW, pay_account_id: 'acc_usd' } }, { deep: true });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.ws.debts[0].currency, 'USD');
  const a = analyze(r.ws, { as_of: AS_OF, horizon_end: '2026-12-31' });
  const ev = a.events.plan.find((e) => e.cash_event_id === 'D-NEW@2026-11-05');
  assert.equal(ev.currency, 'EUR', 'событие переведено в валюту решения по курсу');
  assert.equal(ev.amount_minor, -Math.round(20706 * 0.92));
  assert.ok(a.warnings.some((w) => w.code === 'W_DEBT_BEYOND_HORIZON' && w.currency === 'USD'));
  // счёт долга (справочный) — только liquidity = debt
  const withdebt = { ...clone(G), accounts: [...G.accounts, { account_id: 'acc_loan', name: 'Кредит', kind: 'debt', liquidity: 'debt', currency: 'EUR', exponent: 2, opened_on: '2026-01-01' }] };
  assert.equal(ok(withdebt, { type: 'upsert_debt', debt: { ...NEW, account_id: 'acc_loan' } }).debts[0].account_id, 'acc_loan');
  assert.deepEqual(why({ account_id: 'acc_main' }, withdebt), ['E_SCHEMA', 'not_a_debt_account']);
  assert.deepEqual(why({ account_id: 'нет-такого' }, withdebt), ['E_SCHEMA', 'unknown_account']);
});

test('REQ-082 upsert_debt: ограничения графика (validate_debt) и поля — отказ с кодом канона и причиной; даты, целые, имена, идентификаторы, лишние и опасные поля', () => {
  assert.deepEqual(why({ principal_minor: 5 }), ['E_SCHEMA', 'principal_lt_n']);
  assert.deepEqual(why({ principal_minor: 0 }), ['E_SCHEMA', 'below_min']);
  assert.deepEqual(why({ n: 0 }), ['E_SCHEMA', 'below_min']);
  assert.deepEqual(why({ n: 601, principal_minor: 10 ** 7 }), ['E_SCHEMA', 'n_out_of_1_600']);
  assert.deepEqual(why({ rate_bp: 100001 }), ['E_SCHEMA', 'rate_bp_out_of_0_100000']);
  assert.deepEqual(why({ rate_bp: -1 }), ['E_SCHEMA', 'below_min']);
  assert.deepEqual(why({ kind: 'installment_0' }), ['E_SCHEMA', 'installment_needs_zero_rate']);
  assert.deepEqual(why({ kind: 'взрыв' }), ['E_SCHEMA', 'not_in_list']);
  assert.deepEqual(why({ principal_minor: 1200.5 }), ['E_NOT_INTEGER', 'not_integer']);
  assert.deepEqual(why({ principal_minor: 2 ** 53 }), ['E_OVERFLOW', 'unsafe_integer']);
  assert.deepEqual(why({ n: '6' }), ['E_NOT_INTEGER', 'not_integer']);
  assert.deepEqual(why({ start_date: '2026-02-30' }), ['E_BAD_DATE', 'bad_date']);
  assert.deepEqual(why({ start_date: '2026-11-5' }), ['E_BAD_DATE', 'bad_date']);
  assert.deepEqual(why({ start_date: 20000 }), ['E_BAD_DATE', 'not_iso_string']);
  assert.deepEqual(why({ start_date: '2026-10-03' }), ['E_BAD_DATE', 'first_payment_before_as_of']);
  assert.equal(up({ start_date: AS_OF }).ok, true, 'первый платёж в день расчёта — можно');
  assert.deepEqual(why({ name: '' }), ['E_SCHEMA', 'name_empty']);
  assert.deepEqual(why({ name: '   ' }), ['E_SCHEMA', 'name_empty']);
  assert.deepEqual(why({ name: 'я'.repeat(121) }), ['E_SCHEMA', 'too_long']);
  assert.deepEqual(why({ name: 'a\u0007b' }), ['E_SCHEMA', 'control_chars']);
  assert.deepEqual(why({ name: 42 }), ['E_SCHEMA', 'not_string']);
  assert.deepEqual(why({ debt_id: 'R-RENT' }), ['E_SCHEMA', 'id_taken_by_other_kind']);
  assert.deepEqual(why({ debt_id: 'acc_main' }), ['E_SCHEMA', 'id_taken_by_other_kind']);
  assert.deepEqual(why({ debt_id: 'auto:debts:0' }), ['E_SCHEMA', 'bad_id']);
  assert.deepEqual(why({ debt_id: 'x'.repeat(300) }), ['E_SCHEMA', 'bad_id']);
  assert.deepEqual(why({ debt_id: 42 }), ['E_SCHEMA', 'bad_id']);
  assert.deepEqual(why({ лишнее: 1 }), ['E_SCHEMA', 'unknown_field']);
  assert.deepEqual(refusal(G, { type: 'upsert_debt', debt: NEW, лишнее: 1 }), ['E_SCHEMA', 'unknown_field']);
  assert.deepEqual(refusal(G, { type: 'upsert_debt', debt: 'строка' }), ['E_SCHEMA', 'not_object']);
  assert.deepEqual(refusal(G, { type: 'upsert_debt', debt: JSON.parse('{"__proto__": 1, "debt_id": "x"}') }), ['E_SCHEMA', 'forbidden_key']);
});

test('REQ-131 название долга не попадает в контекст ошибок ни одной из правок (проверка подстрокой по всем отказам)', () => {
  const bads = [
    { type: 'upsert_debt', debt: { ...NEW, pay_account_id: 'нет-такого' } },
    { type: 'upsert_debt', debt: { ...NEW, principal_minor: 5 } },
    { type: 'upsert_debt', debt: { ...NEW, start_date: '2026-01-01' } },
    { type: 'upsert_debt', debt: { ...NEW, лишнее: SECRET } },
    { type: 'upsert_debt', debt: { ...NEW, kind: SECRET } },
    { type: 'upsert_debt', debt: { ...NEW, currency: SECRET } },
    { type: 'upsert_debt', debt: { ...NEW, debt_id: '|' + SECRET } },
    { type: 'delete_debt', debt_id: SECRET },
    { type: 'move_debt_row', debt_id: SECRET, k: 1, date: '2026-12-07' },
  ];
  for (const b of bads) {
    const r = edit_of(G, b);
    assert.equal(r.ok, false);
    assert.ok(!JSON.stringify(r.error).includes(SECRET), JSON.stringify(r.error));
  }
});

// ═══ delete / move / prepay / reanchor как правки рабочей области ═══════════════════════════════════════════════════

test('REQ-082 delete_debt: убирает запись и её график; неизвестный долг и лишние поля — отказ; остальные долги остаются на местах', () => {
  const two = ok(GD, { type: 'upsert_debt', debt: { ...NEW, debt_id: 'D-TWO', name: 'Второй' } });
  const left = ok(two, { type: 'delete_debt', debt_id: 'D-LOAN' });
  assert.deepEqual(left.debts.map((d) => d.debt_id), ['D-TWO']);
  assert.deepEqual(ok(left, { type: 'delete_debt', debt_id: 'D-TWO' }).debts, []);
  assert.deepEqual(refusal(GD, { type: 'delete_debt', debt_id: 'нет-такого' }), ['E_SCHEMA', 'unknown_debt']);
  assert.deepEqual(refusal(GD, { type: 'delete_debt', debt_id: 'D-LOAN', лишнее: 1 }), ['E_SCHEMA', 'unknown_field']);
  assert.deepEqual(refusal(GD, { type: 'delete_debt' }), ['E_SCHEMA', 'bad_id']);
});

test('REQ-082 move_debt_row: правка переносит дату строки (как move_row_date), «сегодня» берётся из env.as_of; порядок и границы — отказ с причиной', () => {
  const ws = ok(GD, MV);
  assert.deepEqual(ws.debts[0], move_row_date(GD.debts[0], 2, '2026-12-07', AS_OF));
  assert.equal(ws.debts[0].schedule[1].date, '2026-12-07');
  assert.equal(ws.debts[0].history[0].on, AS_OF);
  assert.equal(ok(GD, MV, { as_of: '2026-10-10' }).debts[0].history[0].on, '2026-10-10');
  assert.deepEqual(refusal(GD, { ...MV, date: '2027-01-05' }), ['E_SCHEMA', 'row_date_not_before_next']);
  assert.deepEqual(refusal(GD, { ...MV, date: '2026-10-03' }), ['E_BAD_DATE', 'row_date_before_as_of']);
  assert.deepEqual(refusal(GD, { ...MV, date: '2026-12-05' }), ['E_SCHEMA', 'row_date_unchanged']);
  assert.deepEqual(refusal(GD, { ...MV, k: 9 }), ['E_SCHEMA', 'row_out_of_range']);
  assert.deepEqual(refusal(GD, { ...MV, k: 1.5 }), ['E_NOT_INTEGER', 'not_integer']);
  assert.deepEqual(refusal(GD, { ...MV, k: 0 }), ['E_SCHEMA', 'below_min']);
  assert.deepEqual(refusal(GD, { ...MV, date: '2026-12-7' }), ['E_BAD_DATE', 'bad_date']);
  assert.deepEqual(refusal(GD, { ...MV, debt_id: 'нет-такого' }), ['E_SCHEMA', 'unknown_debt']);
  assert.equal(ws.debts[0].schedule[1].payment_minor, 20706, 'сумма платежа не меняется');
});

test('REQ-083 apply_prepay: правка записывает пересчитанный график в сохранённый долг (как apply_prepay движка) — extra_minor, остаток, история; обе опции; отказы с причиной', () => {
  for (const option of ['shorten', 'lower_payment']) {
    const ws = ok(GD, { ...PP, option });
    assert.deepEqual(ws.debts[0], apply_prepay(GD.debts[0], { date: '2026-12-05', amount_minor: 30000, option, as_of: AS_OF }), option);
    assert.equal(ws.debts[0].schedule[1].extra_minor, 30000);
  }
  assert.equal(ok(GD, PP).debts[0].schedule.length, 5);
  assert.equal(ok(GD, { ...PP, option: 'lower_payment' }).debts[0].schedule.length, 6);
  assert.deepEqual(refusal(GD, { ...PP, option: 'иначе' }), ['E_SCHEMA', 'not_in_list']);
  assert.deepEqual(refusal(GD, { ...PP, date: '2026-12-06' }), ['E_SCHEMA', 'prepay_only_on_payment_date_before_last']);
  assert.deepEqual(refusal(GD, { ...PP, date: '2027-04-05' }), ['E_SCHEMA', 'prepay_only_on_payment_date_before_last']);
  assert.deepEqual(refusal(GD, { ...PP, amount_minor: 0 }), ['E_SCHEMA', 'below_min']);
  assert.deepEqual(refusal(GD, { ...PP, amount_minor: 99999999 }), ['E_SCHEMA', 'prepay_amount_out_of_range']);
  assert.deepEqual(refusal(GD, { ...PP, amount_minor: 100.5 }), ['E_NOT_INTEGER', 'not_integer']);
  assert.deepEqual(refusal(GD, { ...PP, debt_id: 'нет-такого' }), ['E_SCHEMA', 'unknown_debt']);
  assert.deepEqual(refusal(GD, { ...PP, date: undefined }), ['E_BAD_DATE', 'not_iso_string']);
});

test('REQ-083 apply_reanchor: правка записывает пересчитанный график (хвост от наблюдаемого остатка, дрейф в истории); после последнего платежа с остатком — отказ; остаток 0 закрывает долг', () => {
  const ws = ok(GD, RA);
  assert.deepEqual(ws.debts[0], apply_reanchor(GD.debts[0], { k: 2, observed_minor: 80900, as_of: AS_OF }).debt);
  assert.deepEqual(ws.debts[0].history, [{ kind: 'reanchor', k: 2, date: '2026-12-05', observed_minor: 80900, drift_minor: 107, on: AS_OF }]);
  assert.deepEqual(refusal(GD, { ...RA, k: 6, observed_minor: 500 }), ['E_SCHEMA', 'balance_after_last_payment']);
  assert.deepEqual(refusal(GD, { ...RA, k: 0 }), ['E_SCHEMA', 'below_min']);
  assert.deepEqual(refusal(GD, { ...RA, k: 8 }), ['E_SCHEMA', 'k_out_of_1_n']);
  assert.deepEqual(refusal(GD, { ...RA, observed_minor: -5 }), ['E_SCHEMA', 'below_min']);
  assert.deepEqual(refusal(GD, { ...RA, observed_minor: 1.5 }), ['E_NOT_INTEGER', 'not_integer']);
  assert.equal(ok(GD, { ...RA, observed_minor: 0 }).debts[0].schedule.length, 2);
  const pre = ok(GD, PP);
  assert.deepEqual(refusal(pre, { ...RA, k: 1, observed_minor: 100494 }), ['E_SCHEMA', 'planned_prepay_after_k']);
});

test('REQ-082 REQ-083 правки долга проходят validate_ws и analyze: после каждой правки область валидна, расчёт проходит, платежи в ряду совпадают с графиком', () => {
  let ws = GD;
  for (const edit of [MV, { ...PP, date: '2026-12-07', option: 'lower_payment' }, { type: 'apply_reanchor', debt_id: 'D-LOAN', k: 3, observed_minor: 38300 }, { type: 'move_debt_row', debt_id: 'D-LOAN', k: 6, date: '2027-04-09' }]) {
    ws = ok(ws, edit, { deep: true });
    assert.equal(validate_ws(ws).ok, true, JSON.stringify(validate_ws(ws).errors));
    const a = analyze({ ...ws, params: { ...ws.params, horizon_days: 250 } }, { as_of: AS_OF });
    const paid = a.events.plan.filter((e) => e.tag === 'debt').reduce((s, e) => s - e.amount_minor, 0);
    const expected = ws.debts[0].schedule.reduce((s, r) => s + r.payment_minor + (r.extra_minor ?? 0), 0);
    assert.equal(paid, expected, edit.type);
  }
  assert.deepEqual(ws.debts[0].history.map((h) => h.kind), ['move', 'prepay', 'reanchor', 'move']);
});

// ═══ журнал ══════════════════════════════════════════════════════════════════════════════════════════════════════════

function fresh_journal(ws, seed = 14) {
  const gen = make_id_gen(seeded_ports({ seed }));
  return create_journal({ events: ws_to_events(ws), ports: ports_from_gen(gen), snapshot_every: 25 });
}

test('REQ-012 REQ-094 журнал: добавление долга — debt.set, каждое применение — замена с supersedes_id (старая запись остаётся), удаление — revert; свёртка журнала даёт ту же область и inputs_hash', () => {
  let ws = G;
  const j = fresh_journal(ws);
  const n0 = j.length;
  const step = (edit) => { const next = ok(ws, edit); const added = sync_journal(j, ws, next); ws = next; return added; };
  const a1 = step({ type: 'upsert_debt', debt: { ...NEW, debt_id: 'D-LOAN', name: 'Кредит на технику' } });
  assert.deepEqual(a1.map((e) => e.type), ['debt.set']);
  assert.equal(a1[0].payload.debt_id, 'D-LOAN');
  assert.equal(a1[0].supersedes_id, undefined);
  const prefix = j.prefix_hash(j.length);
  const a2 = step(PP);
  assert.deepEqual(a2.map((e) => e.type), ['debt.set']);
  assert.equal(typeof a2[0].supersedes_id, 'string', 'применение досрочного — запись с supersedes_id, а не перезапись');
  assert.equal(a2[0].payload.history.length, 1);
  assert.equal(j.prefix_hash(j.length - 1), prefix, 'журнал только дописывается: хэш прежнего префикса не изменился');
  const a3 = step({ type: 'apply_reanchor', debt_id: 'D-LOAN', k: 3, observed_minor: 30700 });
  assert.equal(a3[0].payload.history.length, 2);
  const a4 = step(MV);
  assert.equal(a4[0].payload.history.at(-1).kind, 'move');
  const back = events_to_ws(j.events());
  assert.equal(canon(back.debts), canon(ws.debts), 'история и extra_minor доезжают до свёртки журнала');
  assert.equal(hash_of(back), hash_of(ws));
  const a5 = step({ type: 'delete_debt', debt_id: 'D-LOAN' });
  assert.ok(a5.length >= 1 && a5.every((e) => e.type === 'revert'), 'удаление — откат действующей записи вместе с цепочкой её замен: ' + a5.map((e) => e.type));
  assert.deepEqual(events_to_ws(j.events()).debts, []);
  assert.equal(j.length, n0 + 4 + a5.length);
  assert.deepEqual(sync_journal(j, ws, ws), []);
});

test('REQ-094 файл-копия runway-journal/1: долг со сохранённым графиком, историей и extra_minor переживает ws → файл → ws → файл побайтно, inputs_hash тот же', () => {
  const ws = ok(ok(ok(GD, PP), { ...RA, k: 3, observed_minor: 30700 }), MV);
  const text = ws_to_journal(ws, { engine_version: 'test' });
  const ws2 = journal_to_ws(text);
  assert.equal(canon(ws2.debts), canon(ws.debts));
  assert.equal(hash_of(ws2), hash_of(ws));
  assert.equal(ws_to_journal(ws2, { engine_version: 'test' }), text);
  assert.ok(BUCKETS.some((b) => b.ws_key === 'debts' && b.type === 'debt.set'));
});

// ═══ «Отменить» ══════════════════════════════════════════════════════════════════════════════════════════════════════

test('TST-16 REQ-090 «Отменить»: корзина debts известна единой стопке — добавление, перенос, досрочное, ре-якорение и удаление откатываются и возвращаются побайтно', () => {
  assert.ok(UNDO_ARRAY_BUCKETS.some(([bucket, key]) => bucket === 'debts' && key === 'debt_id'));
  const steps = [
    [G, { type: 'upsert_debt', debt: { ...NEW, debt_id: 'D-LOAN', name: 'Кредит на технику' } }],
    [GD, MV], [GD, PP], [GD, { ...PP, option: 'lower_payment' }], [GD, RA], [GD, { type: 'delete_debt', debt_id: 'D-LOAN' }],
  ];
  for (const [before, edit] of steps) {
    const after = ok(before, edit);
    const unit = diff_unit(before, after, describe_unit(edit.type, { changes: [] }, after));
    assert.ok(unit !== null, edit.type);
    assert.deepEqual(unit.changes.map((c) => c.bucket), ['debts'], edit.type + ': один шаг — одна запись корзины debts');
    const undone = apply_unit(after, unit, 'undo');
    assert.equal(undone.ok, true, edit.type);
    assert.equal(canon(undone.ws), canon(before), edit.type + ': отмена побайтно');
    const redone = apply_unit(undone.ws, unit, 'redo');
    assert.equal(redone.ok, true, edit.type);
    assert.equal(canon(redone.ws), canon(after), edit.type + ': возврат побайтно');
    assert.equal(hash_of(undone.ws), hash_of(before));
  }
});

test('TST-16 REQ-090 «Отменить»: удаление платёжного счёта, на который ссылается долг, после добавления долга — честный undo_conflict, а не висячая ссылка', () => {
  const extra = { account_id: 'acc_two', name: 'Второй', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2, opened_on: '2026-01-01' };
  const base = { ...clone(G), accounts: [...G.accounts, extra] };
  const with_acc = ok(base, { type: 'upsert_debt', debt: { ...NEW, pay_account_id: 'acc_two' } });
  const unit = diff_unit(G, base, { kind: 'account' });
  const r = apply_unit(with_acc, unit, 'undo'); // отмена добавления счёта, пока на него ссылается долг
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'undo_conflict');
  assert.equal(r.cause, 'dangling_ref');
  assert.equal(r.bucket, 'debts');
});

test('TST-16 REQ-090 подпись «Отменить»: каждый вид правки долга относится к виду «debt» — «изменение долга» / "debt change" (RU и EN); корзина debts без причины тоже даёт «debt»', () => {
  for (const t of Object.keys(EDITS)) assert.equal(REASON_KINDS[t], 'debt', t);
  assert.equal(UNDO_LABEL_KEYS.debt, 'entry.u_debt');
  const money = (m, c) => `${m / 100} ${c}`;
  assert.equal(unit_label({ kind: 'debt' }, (k, p) => tr_of('ru', k, p), money), 'изменение долга');
  assert.equal(unit_label({ kind: 'debt' }, (k, p) => tr_of('en', k, p), money), 'debt change');
  const after = ok(GD, PP);
  const unit = diff_unit(GD, after, {});
  assert.equal(describe_unit('что-то-иное', unit, after).kind, 'debt');
  assert.equal(describe_unit('apply_prepay', unit, after).kind, 'debt');
});

// ═══ модели показа ══════════════════════════════════════════════════════════════════════════════════════════════════

test('REQ-082 pay_accounts и same_terms_exists: счета платежей — операционные, открытые, в валюте; повтор тех же условий замечен, другое условие — нет', () => {
  const ws = { ...clone(G), accounts: [...G.accounts,
    { account_id: 'acc_old', name: 'Старый', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2, closed_on: '2026-09-30' },
    { account_id: 'acc_usd', name: 'USD', kind: 'bank', liquidity: 'operating', currency: 'USD', exponent: 2 },
    { account_id: 'acc_sav', name: 'Копилка', kind: 'savings', liquidity: 'savings', currency: 'EUR', exponent: 2 }] };
  assert.deepEqual(pay_accounts(ws, 'EUR').map((a) => a.account_id), ['acc_main']);
  assert.deepEqual(pay_accounts(ws, 'USD').map((a) => a.account_id), ['acc_usd']);
  assert.deepEqual(pay_accounts({}, 'EUR'), []);
  const plan = { kind: 'annuity', principal_minor: 120000, rate_bp: 1200, n: 6, start_date: '2026-11-05' };
  assert.equal(same_terms_exists(GD, plan, 'acc_main'), true);
  assert.equal(same_terms_exists(GD, plan, 'acc_other'), false);
  assert.equal(same_terms_exists(GD, { ...plan, n: 7 }, 'acc_main'), false);
  assert.equal(same_terms_exists(G, plan, 'acc_main'), false);
  assert.deepEqual(add_edit(plan, { debt_id: 'x', name: 'N', pay_account_id: 'acc_main' }), {
    type: 'upsert_debt', debt: { debt_id: 'x', name: 'N', pay_account_id: 'acc_main', kind: 'annuity', principal_minor: 120000, rate_bp: 1200, n: 6, start_date: '2026-11-05' },
  });
});

test('TST-29 REQ-083 prepay_preview: оба варианта на сохранённом долге — те же числа, что у экрана-калькулятора (shorten: 5 платежей, экономия 1114; lower_payment: платёж 13017, экономия 754)', () => {
  const pv = prepay_preview(GD.debts[0], 2, 30000, AS_OF);
  assert.equal(pv.ok, true);
  assert.equal(pv.date, '2026-12-05');
  assert.deepEqual([pv.now.count, pv.now.first_payment_minor, pv.now.last_date, pv.now.interest_minor], [4, 20706, '2027-04-05', 808 + 609 + 408 + 205], 'без досрочного: хвост после платежа 2');
  const s = pv.options.shorten;
  assert.deepEqual([s.ok, s.tail.count, s.tail.first_payment_minor, s.tail.last_date, s.saved_interest_minor], [true, 3, 20706, '2027-03-05', 1114]);
  const l = pv.options.lower_payment;
  assert.deepEqual([l.ok, l.tail.count, l.tail.first_payment_minor, l.saved_interest_minor], [true, 4, 13017, 754]);
  // сохранённый результат — ровно то, что запишет правка
  assert.deepEqual(s.debt, ok(GD, PP).debts[0]);
  assert.equal(prepay_preview(GD.debts[0], 6, 100, AS_OF).ok, false, 'после последнего платежа вносить нечего');
  assert.equal(prepay_preview(GD.debts[0], 1.5, 100, AS_OF).ok, false);
  assert.equal(prepay_preview(GD.debts[0], 0, 100, AS_OF).ok, false);
  const big = prepay_preview(GD.debts[0], 2, 99999999, AS_OF);
  assert.deepEqual([big.ok, big.options.shorten.ok, big.options.shorten.reason], [true, false, 'prepay_amount_out_of_range']);
});

test('TST-29 REQ-083 reanchor_preview: 809,00 € против модельных 807,93 € — дрейф +107 (13 bp), в допуске 50 bp; допуск 5 bp — флаг; −793 (−98 bp); хвост 4 платежа; закрытие и отказ', () => {
  const d = GD.debts[0];
  const r = reanchor_preview(d, 2, 80900, 50, AS_OF);
  assert.deepEqual([r.ok, r.modeled_minor, r.drift_minor, r.drift_bp, r.tol_bp, r.over_tolerance], [true, 80793, 107, 13, 50, false]);
  assert.deepEqual([r.tail.count, r.tail.first_payment_minor, r.tail.total_minor], [4, 20733, 20733 * 3 + 20734]);
  assert.equal(r.tail.total_minor, 80900 + r.tail.interest_minor);
  assert.deepEqual(r.debt, ok(GD, RA).debts[0]);
  const over = reanchor_preview(d, 2, 80900, 5, AS_OF);
  assert.deepEqual([over.drift_bp, over.over_tolerance], [13, true]);
  const under = reanchor_preview(d, 2, 80000, 50, AS_OF);
  assert.deepEqual([under.drift_minor, under.drift_bp, under.over_tolerance], [-793, -98, true]);
  assert.deepEqual([reanchor_preview(d, 2, 80793, 50, AS_OF).drift_minor, reanchor_preview(d, 2, 80793, 50, AS_OF).drift_bp], [0, 0]);
  const closed = reanchor_preview(d, 6, 0, 50, AS_OF);
  assert.deepEqual([closed.ok, closed.tail], [true, null]);
  assert.deepEqual(reanchor_preview(d, 6, 5, 50, AS_OF), { ok: false, code: 'E_SCHEMA', reason: 'balance_after_last_payment' });
  assert.equal(reanchor_preview(d, 9, 5, 50, AS_OF).ok, false);
});

// ═══ строки RU/EN ═══════════════════════════════════════════════════════════════════════════════════════════════════

const placeholders = (s) => [...s.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]).sort();
const placeholders_free = (x) => x.replace(/{[A-Za-z0-9_]+}/g, '').replace(/[^A-Za-zА-Яа-яЁё]/g, '');

test('TST-56 каталог debtedit: паритет ключей RU/EN, одинаковые плейсхолдеры, ключи в пространстве debtedit, русские буквы в RU, запрещённых формулировок нет', () => {
  assert.deepEqual(Object.keys(catalog.ru).sort(), Object.keys(catalog.en).sort());
  const vocab = load('../engine/vocab.json');
  for (const k of Object.keys(catalog.ru)) {
    assert.ok(k.startsWith('debtedit.'), k);
    assert.deepEqual(placeholders(catalog.ru[k]), placeholders(catalog.en[k]), k);
    assert.ok(catalog.ru[k].trim() !== '' && catalog.en[k].trim() !== '', k);
    if (placeholders_free(catalog.ru[k]) !== '') assert.match(catalog.ru[k], /[а-яё]/i, k);
    for (const phrase of vocab.forbidden_phrases) {
      for (const lang of ['ru', 'en']) assert.ok(!catalog[lang][k].toLowerCase().replace(/ё/g, 'е').includes(phrase.toLowerCase().replace(/ё/g, 'е')), `${k}: «${phrase}»`);
    }
  }
  assert.ok(Object.hasOwn(catalog.ru, 'debtedit.add_btn'));
});

test('TST-56 REQ-017 причины отказа: каждая причина, с которой правки долга отвергают ввод, имеет собственный текст RU и EN; неизвестная причина — общий текст формы с кодом', () => {
  const reasons = new Set();
  const collect = (r) => { if (!r.ok && typeof r.error.ctx?.reason === 'string') reasons.add(r.error.ctx.reason); };
  for (const patch of [{ pay_account_id: 'x' }, { principal_minor: 5 }, { n: 601, principal_minor: 10 ** 7 }, { rate_bp: 100001 }, { start_date: '2026-10-03' }, { name: '' }, { currency: 'USD' },
    { debt_id: 'R-RENT' }, { debt_id: 'auto:x' }, { kind: 'installment_0' }]) collect(up(patch));
  for (const edit of [{ ...MV, date: '2026-10-03' }, { ...MV, date: '2026-11-05' }, { ...MV, date: '2027-01-05' }, { ...MV, date: '2026-12-05' }, { ...MV, k: 9 }, { ...MV, debt_id: 'x' },
    { ...PP, date: '2026-12-06' }, { ...PP, amount_minor: 99999999 }, { ...RA, k: 6, observed_minor: 5 }, { ...RA, k: 8 }, { ...RA, observed_minor: -1 }]) collect(edit_of(GD, edit));
  collect(edit_of(ok(GD, PP), { ...RA, k: 1, observed_minor: 100494 }));
  collect(edit_of(ok(GD, PP), { ...PP, date: '2026-11-05', amount_minor: 1000 }));
  collect(edit_of(ok(GD, { ...RA, k: 3, observed_minor: 61000 }), { ...PP, amount_minor: 1000 }));
  const odd = clone(GD); odd.debts[0].schedule[1].payment_minor = 100;
  collect(edit_of(odd, PP));
  assert.ok(reasons.size >= 17 && reasons.has('later_prepay_exists') && reasons.has('later_reanchor_exists'), [...reasons].join(', '));
  const generic_ok = new Set(['below_min', 'above_max', 'not_in_list', 'not_integer', 'unsafe_integer', 'unknown_field', 'not_object', 'bad_id', 'id_taken_by_other_kind', 'not_a_debt_account',
    'too_long', 'control_chars', 'not_string', 'not_iso_string', 'unknown_prepay_option', 'installment_needs_zero_rate', 'unknown_debt_kind', 'bad_currency', 'unknown_currency']);
  for (const lang of ['ru', 'en']) {
    const ctx = { tr: (k, p) => tr_of(lang, k, p) };
    for (const reason of reasons) {
      const key = 'debtedit.r_' + reason;
      const own = Object.hasOwn(catalog[lang], key);
      assert.ok(own || generic_ok.has(reason), `${lang}: для причины «${reason}» нет собственного текста ${key}`);
      const text = reason_text(ctx, { code: 'E_SCHEMA', ctx: { reason, field: 'debt.name' } });
      assert.ok(text.length > 0 && !text.includes('{'), `${lang}/${reason}: «${text}»`);
      if (own) assert.equal(text, catalog[lang][key]);
    }
    const generic = reason_text(ctx, { code: 'E_NO_RATE', ctx: { reason: 'такой-причины-нет', field: 'debt.currency' } });
    assert.match(generic, /E_NO_RATE/);
    assert.ok(!generic.includes('такой-причины-нет'), 'неизвестная причина в текст не повторяется');
    assert.match(reason_text(ctx, null), /E_SCHEMA/);
  }
});

test('REQ-082 g001-debt.json в мосте и «Отменить» — ничего не теряется: все корзины набора проходят ws → журнал → ws с тем же inputs_hash (и с долгом, и после правок)', () => {
  for (const ws of [GD, ok(GD, PP), ok(GD, RA), ok(GD, MV)]) {
    const back = events_to_ws(ws_to_events(ws));
    assert.equal(hash_of(back), hash_of(ws));
    assert.equal(canon(back.debts), canon(ws.debts));
  }
  assert.equal(format_date(day('2026-12-05')), '2026-12-05');
  assert.equal(rows_of(GD.debts[0]).length, 6);
});

// ═══ исправления после независимой проверки (FP-14) ═══════════════════════════════════════════════════════════════════════════════════════════

test('REQ-082 REQ-083 калькулятор «Долги» и запись в прогноз считают одним режимом округления: make_plan берёт params.rounding, а показанный график, «что если досрочно» и сверка равны записанным до minor (63 сочетания)', () => {
  const plain = { ws: G, cur: 'EUR' };
  const half_up_ws = { ...clone(G), params: { ...G.params, rounding: 'half_up' } };
  const model = { ws: half_up_ws, cur: 'EUR' };
  assert.equal(DB.make_plan(plain, { principal_minor: 100000, rate_bp: 999, n: 6, kind: 'annuity', start_date: '2026-11-05' }).plan.rounding, 'half_even', 'без параметра — half_even');
  assert.equal(DB.make_plan(model, { principal_minor: 100000, rate_bp: 999, n: 6, kind: 'annuity', start_date: '2026-11-05' }).plan.rounding, 'half_up');
  let differs = 0;
  let checked = 0;
  for (const principal_minor of [100000, 123457, 99900]) {
    for (const rate_bp of [999, 1250, 1199]) {
      for (const n of [4, 6, 7]) {
        for (const kind of ['annuity', 'differential', 'installment_0']) {
          if (kind === 'installment_0' && rate_bp !== 999) continue; // рассрочка — без процентов: одно сочетание ставки достаточно
          const form = { principal_minor, rate_bp: kind === 'installment_0' ? 0 : rate_bp, n, kind, start_date: '2026-11-05' };
          const plan = DB.make_plan(model, form).plan;
          const rec = ok(half_up_ws, { type: 'upsert_debt', debt: { ...NEW, kind, principal_minor, rate_bp: form.rate_bp, n } }).debts[0];
          assert.equal(rec.rounding, 'half_up');
          // график калькулятора (его считает prepay_compare для базы) = записанный
          const cmp = DB.prepay_compare(plan, 1, 1000);
          assert.equal(cmp.ok, true);
          const sum = (key) => rec.schedule.reduce((s, r) => s + r[key], 0);
          assert.deepEqual([cmp.base.first_payment_minor, cmp.base.last_payment_minor, cmp.base.total_minor, cmp.base.interest_minor],
            [rec.schedule[0].payment_minor, rec.schedule.at(-1).payment_minor, sum('payment_minor'), sum('interest_minor')], JSON.stringify(form));
          // «что если досрочно» калькулятора = результат записи досрочного на сохранённом долге
          for (const option of ['shorten', 'lower_payment']) {
            const saved = apply_prepay(rec, { date: rec.schedule[0].date, amount_minor: 1000, option, as_of: AS_OF });
            assert.deepEqual(cmp.options[option].rows.map((r) => r.payment_minor), saved.schedule.map((r) => r.payment_minor), `${JSON.stringify(form)} ${option}`);
          }
          // сверка калькулятора: модельный остаток = остаток записанного графика
          const chk = DB.reanchor_check(plan, 2, rec.schedule[1].balance_minor + 10);
          assert.equal(chk.ok, true);
          assert.equal(chk.modeled_minor, rec.schedule[1].balance_minor);
          const rows_he = DB.prepay_compare(DB.make_plan(plain, form).plan, 1, 1000).base;
          if (rows_he.last_payment_minor !== cmp.base.last_payment_minor || rows_he.interest_minor !== cmp.base.interest_minor) differs += 1;
          checked += 1;
        }
      }
    }
  }
  assert.ok(checked >= 60, 'проверено сочетаний: ' + checked);
  assert.ok(differs > 0, 'в выборке есть сочетания, где half_up и half_even дают разные числа (иначе проверка пуста)');
});
