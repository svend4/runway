// entry.test.mjs — быстрый ввод факта «+», сверка остатка одним числом и «Отменить / Вернуть» (FP-04; REQ-090, REQ-028, REQ-063, TST-57, TST-58).
// Что проверяется: разбор «12,50» по формату рабочей области (а не языка интерфейса), дата = as_of, запоминание счёта, тексты отказов E_NOT_INTEGER и
// E_FUTURE_POSTED, предупреждение о двойном вычитании в шторке, плашка свежести до и после сверки (границы 7/8 и 21/22 дня не меняются), три действия
// от плашки до её исчезновения, дрейф сверки = дрейф движка, «Отменить» возвращает state_hash журнала. Числа переписаны из канона вручную.
// Медиана ввода ≤ 5 с — процессная проверка на ≥ 5 людях (REQ-090), не автотест: здесь проверяется только число полей и действий.
// DOM в Node подменён минимальной заглушкой (проверяется связка модель ↔ слот ↔ диалог, а не вёрстка); браузер не используется.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── заглушка DOM ────────────────────────────────────────────────────────────────────────────────────────────────────

class FakeNode {
  constructor(tag) {
    this.nodeType = 1; this.tagName = tag; this.attrs = {}; this.children = []; this.listeners = {}; this.className = ''; this._text = ''; this.value = ''; this.open = false; this.focused = false;
  }
  get textContent() { return this.children.length === 0 ? this._text : this.children.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return Object.hasOwn(this.attrs, k); }
  append(...kids) { for (const k of kids) this.children.push(k); this._text = ''; }
  replaceChildren(...kids) { this.children = []; this._text = ''; this.append(...kids); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  querySelectorAll() { return []; }
  walk(fn) { fn(this); for (const c of this.children) if (c.nodeType === 1) c.walk(fn); }
}
const byid = new Map();
for (const id of ['dlg', 'dlg-title', 'dlg-close', 'dlg-body', 'live']) byid.set(id, new FakeNode(id === 'dlg' ? 'dialog' : 'div'));
globalThis.document = {
  createElement: (t) => new FakeNode(t),
  createElementNS: (_ns, t) => new FakeNode(t),
  createTextNode: (data) => ({ nodeType: 3, data }),
  getElementById: (id) => byid.get(id) ?? null,
  head: new FakeNode('head'),
};

import { analyze, canon, opening_state, anchor_status, state_hash, core_hash } from '../engine/index.mjs';
import { create_ext } from '../demo/ext.mjs';
import { seeded_ports } from '../demo/ids.mjs';
import { t as tr_of } from '../demo/i18n.mjs';
import { apply_edit } from '../demo/ws_edit.mjs';
import { make_rng } from './helpers.mjs';
import {
  resolve_number_format, parse_entry_amount, example_amount, default_account_id, default_transfer_target, entry_accounts, create_entry_memory,
  build_entry_edit, prepare_entry, commit_entry, resolve_pending, create_decline_store, error_text, open_entry_dialog, render_pending_card,
} from '../demo/entry.mjs';
import { pending_transfers } from '../engine/transfer_guard.mjs';
import {
  freshness, default_anchor_account, reconcile_preview, build_anchor_edit, anchor_open, anchor_input, anchor_confirm, ANCHOR_ACTIONS, open_anchor_dialog,
  preview_text, done_text,
} from '../demo/anchor_dialog.mjs';
import { create_undo_stack, diff_unit, apply_unit } from '../demo/undo.mjs';
import { make_deps } from '../demo/pack_fp04.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const G = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'data', 'g001.json'), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const NBSP = ' ';
/** Неразрывные пробелы форматтера денег → обычные (в ожиданиях тестов — обычные пробелы). */
const N = (x) => String(x).replace(/[  ]/g, ' ');

/** G-001 «на сутки позже»: as_of 2026-10-05, якорь 10-04 и резервы прежние; добавлены копилка и (по умолчанию) касса с остатком 100,00 €. */
function day_after(over_as_of = '2026-10-05', { cash = true } = {}) {
  const w = clone(G);
  w.as_of = over_as_of;
  w.accounts.push({ account_id: 'acc_sav', name: 'Копилка', kind: 'savings', liquidity: 'savings', currency: 'EUR', exponent: 2, opened_on: '2026-01-01' });
  if (cash) {
    w.accounts.push({ account_id: 'acc_cash', name: 'Наличные', kind: 'cash', liquidity: 'operating', currency: 'EUR', exponent: 2, opened_on: '2026-01-01' });
    w.anchors.push({ anchor_id: 'anc-cash-1004', account_id: 'acc_cash', date: '2026-10-04', amount_minor: 10000 });
  }
  return w;
}

// ── реестр и страница-заглушка ───────────────────────────────────────────────────────────────────────────────────────

const st = { ws: G, notes: [], renders: 0, lang: 'ru', refuse: false, probe: null };
const e = create_ext({ ports: seeded_ports({ seed: 4 }), loaders: { pack_fp04: () => import('../demo/pack_fp04.mjs') } });
e.bind_host({
  get_ws: () => st.ws,
  get_model: () => ({ ctx: analyze(st.ws, { as_of: st.ws.as_of }) }),
  lang: () => st.lang,
  mode: () => 'worse',
  fmt: () => null,
  set_ws: (next) => {
    if (st.refuse) return { ok: false, error: { code: 'E_SCHEMA', ctx: { reason: 'forced_refusal' } } };
    try { analyze(next, { as_of: next.as_of }); } catch (x) { return { ok: false, error: x }; }
    st.ws = next;
    return { ok: true };
  },
  render: () => { st.renders += 1; st.probe?.(); },
  notify: (m, k) => { st.notes.push([m, k]); },
});
await e.load_packs(); // регистрирует каталог entry.* и слоты: так пакет подключает приложение
const ctx = e.ctx;
/** Новая рабочая область на странице: журнал и стопки пересоздаются (как при смене набора данных). */
function reset(ws, lang = 'ru') {
  st.ws = ws; st.lang = lang; st.notes = []; st.renders = 0; st.refuse = false; st.probe = null;
  e.reset(ws);
  return make_deps(ctx);
}
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const click = (node) => node.listeners.click[0]();
const submit = (form) => form.listeners.submit[0]({ preventDefault() {} });
const money = (v) => v; // форматирование проверяется отдельно
void money;
const env = (extra = {}) => ({ lang: 'ru', new_id: ctx.new_id, ...extra });

// ── REQ-090: разбор суммы и формат чисел ─────────────────────────────────────────────────────────────────────────────

test('TST-58 REQ-090: «12,50» даёт 1250 minor при формате ru, «12.50» — при en; чужой разделитель — E_NOT_INTEGER; группы тысяч и знак по правилам формата', () => {
  const ru = { decimal: ',', thousands: ' ' };
  const en = { decimal: '.', thousands: ',' };
  const ok = (text, fmt, sign, abs) => assert.deepEqual(parse_entry_amount(text, fmt, 2), { ok: true, sign, abs_minor: abs }, `«${text}»`);
  ok('12,50', ru, 0, 1250);
  ok('12.50', en, 0, 1250);
  ok('1 234,50', ru, 0, 123450);
  ok(`1${NBSP}234,50`, ru, 0, 123450);
  ok('1,234.50', en, 0, 123450);
  ok('300', ru, 0, 30000);
  ok('0,5', ru, 0, 50);
  ok('-12,50', ru, -1, 1250);
  ok('−12,50', ru, -1, 1250);
  ok('+12,50', ru, 1, 1250);
  ok(' 12,50 ', ru, 0, 1250);
  const bad = (text, fmt, reason, code = 'E_NOT_INTEGER') => {
    const r = parse_entry_amount(text, fmt, 2);
    assert.equal(r.ok, false, `«${text}» должна отвергаться`);
    assert.equal(r.code, code, `«${text}»: ${r.code}/${r.reason}`);
    if (reason !== undefined) assert.equal(r.reason, reason);
  };
  bad('12.50', ru); // точка — не десятичный знак формата ru
  bad('12,50', en); // запятая в en — разделитель тысяч, группа из двух цифр недопустима
  bad('12,5,0', ru);
  bad('1,2345', ru, 'too_many_decimals');
  bad('', ru, 'empty');
  bad('   ', ru, 'empty');
  bad('-', ru, 'empty');
  bad('--5', ru, 'double_sign');
  bad('+-5', ru, 'double_sign');
  bad('abc', ru);
  bad('12 €', ru);
  bad('1e3', ru);
  bad('12,50,', ru);
  bad('99999999999999999999,00', ru, undefined, 'E_OVERFLOW');
  bad('0', ru, 'zero', 'E_SCHEMA');
  bad('0,00', ru, 'zero', 'E_SCHEMA');
  assert.equal(parse_entry_amount('0,00', ru, 2, { allow_zero: true }).ok, true, 'остаток при сверке может быть нулём');
  assert.equal(parse_entry_amount(null, ru, 2).ok, false);
  assert.equal(parse_entry_amount(12.5, ru, 2).code, 'E_NOT_INTEGER');
  // валюта без дробной части: «12» — 12 minor, «12,5» — отказ
  assert.deepEqual(parse_entry_amount('12', ru, 0), { ok: true, sign: 0, abs_minor: 12 });
  assert.equal(parse_entry_amount('12,5', ru, 0).ok, false);
  assert.equal(example_amount(ru), '1 234,50');
  assert.equal(example_amount(en), '1,234.50');
});

test('TST-58 REQ-090: ввод в чужом формате — число из набора «en» читается по правилам набора, а не языка интерфейса; без настройки — по языку', () => {
  const base = day_after();
  const form = (text) => ({ kind: 'expense', amount_text: text, account_id: 'acc_main' });
  // набор данных с number_format = en, интерфейс русский
  const en_ws = { ...base, number_format: 'en' };
  assert.deepEqual(resolve_number_format(en_ws, 'ru'), { decimal: '.', thousands: ',', source: 'workspace' });
  const a = build_entry_edit(en_ws, form('1,234.50'), env({ lang: 'ru' }));
  assert.equal(a.ok, true);
  assert.equal(a.edit.fact.amount_minor, -123450, '«1,234.50» по правилам набора en, хотя интерфейс ru');
  const b = build_entry_edit(en_ws, form('12,50'), env({ lang: 'ru' }));
  assert.equal(b.ok, false, '«12,50» не читается по правилам языка интерфейса, когда набор — en');
  assert.equal(b.error.code, 'E_NOT_INTEGER');
  // набор ru, интерфейс английский
  const ru_ws = { ...base, number_format: 'ru' };
  assert.equal(build_entry_edit(ru_ws, form('12,50'), env({ lang: 'en' })).edit.fact.amount_minor, -1250);
  assert.equal(build_entry_edit(ru_ws, form('12.50'), env({ lang: 'en' })).ok, false);
  // настройка в params и объект формата
  assert.equal(resolve_number_format({ params: { number_format: 'en' } }, 'ru').decimal, '.');
  assert.deepEqual(resolve_number_format({ number_format: { decimal: '.', thousands: '', date: 'iso' } }, 'ru'), { decimal: '.', thousands: '', source: 'workspace' }, 'формат из настройки рабочей области: поле date не мешает');
  assert.deepEqual(resolve_number_format({ number_format: { decimal: ',', thousands: '.' } }, 'en'), { decimal: ',', thousands: '.', source: 'workspace' }, '«1.234,50» при английском интерфейсе (REQ-112)');
  assert.equal(resolve_number_format({ number_format: { decimal: ';', thousands: '' } }, 'ru').source, 'language', 'знак вне допустимых — формат языка');
  assert.equal(resolve_number_format({ number_format: { date: 'iso' } }, 'en').decimal, '.', 'только дата — числа по языку');
  assert.equal(resolve_number_format({ number_format: { decimal: ',', thousands: ',' } }, 'en').source, 'language', 'одинаковые знаки — формат языка');
  assert.equal(resolve_number_format({ number_format: { decimal: '1', thousands: ',' } }, 'ru').source, 'language', 'мусор в настройке — формат языка');
  assert.equal(resolve_number_format({ number_format: 'xx' }, 'en').decimal, '.', 'неизвестный пресет — формат языка');
  // сочетание «язык en + формат 1.234,50» (REQ-112): ввод читается по настройке набора
  const dot_comma = { ...base, number_format: { decimal: ',', thousands: '.' } };
  assert.equal(build_entry_edit(dot_comma, form('1.234,50'), env({ lang: 'en' })).edit.fact.amount_minor, -123450);
  assert.equal(build_entry_edit(dot_comma, form('1,234.50'), env({ lang: 'en' })).ok, false, 'формат языка настройку не перебивает');
  // нет настройки: формат языка интерфейса
  assert.equal(build_entry_edit(base, form('12,50'), env({ lang: 'ru' })).edit.fact.amount_minor, -1250);
  assert.equal(build_entry_edit(base, form('12.50'), env({ lang: 'en' })).edit.fact.amount_minor, -1250);
});

test('TST-58 REQ-090: «12,50» → факт −1250 minor с датой = as_of и счётом по умолчанию; счёт запоминается; знак и вид (расход, приход)', () => {
  const deps = reset(day_after());
  const p = prepare_entry(st.ws, { kind: 'expense', amount_text: '12,50', account_id: 'acc_main' }, env());
  assert.equal(p.ok, true);
  assert.deepEqual(p.edit, { type: 'add_fact', fact: { account_id: 'acc_main', date: '2026-10-05', amount_minor: -1250 } }, 'дата = as_of, сумма в minor units');
  const r = commit_entry(ctx, p, undefined, deps);
  assert.equal(r.ok, true);
  const added = st.ws.facts.at(-1);
  assert.equal(added.amount_minor, -1250);
  assert.equal(added.date, '2026-10-05');
  assert.equal(added.account_id, 'acc_main');
  assert.equal(added.kind, 'expense');
  assert.match(added.event_id, /^tx_[0-9a-f]{12}$/, 'идентификатор создаёт приложение');
  assert.equal(st.renders, 1, 'страница перерисована ровно один раз');
  // запомненный счёт: следующий ввод по умолчанию на нём
  const cash = prepare_entry(st.ws, { kind: 'expense', amount_text: '3', account_id: 'acc_cash' }, env());
  commit_entry(ctx, cash, undefined, deps);
  assert.equal(deps.memory.get(st.ws), 'acc_cash');
  assert.equal(default_account_id(st.ws, deps.memory.get(st.ws)), 'acc_cash');
  assert.equal(default_account_id(st.ws, 'нет такого'), 'acc_cash', 'без запомненного — счёт самого позднего факта');
  assert.equal(default_account_id(day_after(), null), 'acc_main', 'нет фактов на 10-05 — но последний факт G-001 на acc_main');
  assert.equal(default_account_id({ accounts: [], facts: [] }, null), null);
  const closed = clone(st.ws);
  closed.accounts.find((a) => a.account_id === 'acc_cash').closed_on = '2026-10-01';
  assert.equal(default_account_id(closed, 'acc_cash'), 'acc_main', 'закрытый счёт не предлагается');
  assert.equal(entry_accounts(closed).some((a) => a.account_id === 'acc_cash'), false);
  // знак и вид
  const kinds = [['expense', '5', -500], ['income', '5', 500], ['expense', '+5', 500], ['income', '-5', -500], ['income', '−5', -500]];
  for (const [kind, text, want] of kinds) {
    const b = build_entry_edit(st.ws, { kind, amount_text: text, account_id: 'acc_main' }, env());
    assert.equal(b.edit.fact.amount_minor, want, `${kind} «${text}»`);
    assert.equal(b.info.kind, want > 0 ? 'income' : 'expense');
  }
  // память по рабочим областям и сброс
  const mem = create_entry_memory();
  mem.remember({ workspace_id: 'a' }, 'x');
  assert.equal(mem.get({ workspace_id: 'a' }), 'x');
  assert.equal(mem.get({ workspace_id: 'b' }), null);
  mem.forget();
  assert.equal(mem.get({ workspace_id: 'a' }), null);
});

test('TST-58 REQ-028 REQ-090: факт от шторки реально меняет остаток — «25,00» расходом на 10-05 при якоре 10-04 = 400000 даёт opening 397500', () => {
  const deps = reset(day_after());
  assert.equal(opening_state(st.ws, '2026-10-05').opening_minor, 400000 + 10000, 'до ввода: якорь 400000 + касса 10000');
  const p = prepare_entry(st.ws, { kind: 'expense', amount_text: '25,00', account_id: 'acc_main' }, env());
  assert.deepEqual(p.notes, [], 'дата позже якоря: заметки нет');
  assert.equal(commit_entry(ctx, p, undefined, deps).ok, true);
  assert.equal(opening_state(st.ws, '2026-10-05').opening_minor, 397500 + 10000, 'канон REQ-028: 400000 − 2500 = 397500');
  assert.equal(analyze(st.ws, { as_of: st.ws.as_of }).series.plan.opening_minor, 407500);
});

test('TST-58 REQ-090: дата не позже последнего якоря счёта — факт записан, но остаток не меняется; шторка говорит об этом заметкой', () => {
  const deps = reset(clone(G)); // as_of = дата якоря
  const p = prepare_entry(st.ws, { kind: 'expense', amount_text: '12,50', account_id: 'acc_main' }, env());
  assert.deepEqual(p.notes, ['covered_by_anchor']);
  const before = opening_state(st.ws, st.ws.as_of).opening_minor;
  const r = commit_entry(ctx, p, undefined, deps);
  assert.equal(r.ok, true);
  assert.equal(opening_state(st.ws, st.ws.as_of).opening_minor, before, 'якорь на ту же дату уже включает факт (канон REQ-028: после якоря — строго позже)');
  assert.match(tr_of('ru', 'entry.note_covered'), /не изменится/);
});

test('TST-58 REQ-090: E_NOT_INTEGER и E_FUTURE_POSTED показываются текстом, данные не меняются; прочие коды ввода тоже имеют текст', () => {
  const deps = reset(day_after());
  const ws0 = st.ws;
  const refuse = (form) => {
    const p = prepare_entry(st.ws, form, env());
    assert.equal(p.ok, false);
    return p.error;
  };
  const f = { kind: 'expense', amount_text: '12,50', account_id: 'acc_main' };
  const not_int = refuse({ ...f, amount_text: 'двенадцать' });
  assert.equal(not_int.code, 'E_NOT_INTEGER');
  assert.equal(error_text(ctx, not_int, { example: '1 234,50' }), 'Не похоже на сумму. Образец записи: 1 234,50.');
  const future = refuse({ ...f, date: '2026-10-06' });
  assert.equal(future.code, 'E_FUTURE_POSTED');
  assert.equal(error_text(ctx, future, { as_of: '5 октября' }), 'Факт не может быть позже даты расчёта (5 октября): введите его как план.');
  st.lang = 'en';
  assert.equal(error_text(ctx, not_int, { example: '1,234.50' }), 'That does not look like an amount. Example: 1,234.50.');
  st.lang = 'ru';
  assert.equal(error_text(ctx, refuse({ ...f, date: '2026-13-01' }), {}), tr_of('ru', 'entry.err_bad_date'));
  assert.equal(error_text(ctx, refuse({ ...f, amount_text: '0' }), {}), tr_of('ru', 'entry.err_zero'));
  assert.equal(error_text(ctx, refuse({ ...f, amount_text: '99999999999999999999' }), {}), tr_of('ru', 'entry.err_overflow'));
  assert.equal(error_text(ctx, refuse({ ...f, account_id: 'нет' }), {}), tr_of('ru', 'entry.err_schema'));
  assert.equal(error_text(ctx, refuse({ kind: 'transfer', amount_text: '5', account_id: 'acc_main', to_account_id: 'acc_main' }), {}), tr_of('ru', 'entry.err_same_account'));
  const usd = clone(st.ws);
  usd.accounts.push({ account_id: 'acc_usd', name: 'USD', kind: 'bank', liquidity: 'savings', currency: 'USD', exponent: 2, opened_on: '2026-01-01' });
  const cur = prepare_entry(usd, { kind: 'transfer', amount_text: '5', account_id: 'acc_main', to_account_id: 'acc_usd' }, env());
  assert.equal(cur.error.code, 'E_CURRENCY_MISMATCH');
  assert.equal(error_text(ctx, cur.error, {}), tr_of('ru', 'entry.err_currency_mismatch'));
  assert.equal(error_text(ctx, { code: 'E_NO_RATE', ctx: null }, {}), tr_of('ru', 'entry.err_no_rate'));
  assert.equal(error_text(ctx, { code: 'E_XXX', ctx: null }, {}), tr_of('ru', 'entry.err_other'));
  assert.equal(error_text(ctx, undefined), tr_of('ru', 'entry.err_other'));
  // отказ через commit_entry: ничего не записано, страница не перерисована
  const p = prepare_entry(st.ws, f, env());
  const bad = { ...p, form: { ...f, date: '2026-10-06' }, base_ws: {} }; // устаревшая подготовка → повторная с неверной датой
  assert.equal(commit_entry(ctx, bad, undefined, deps).error.code, 'E_FUTURE_POSTED');
  assert.equal(st.ws, ws0, 'рабочая область — тот же объект');
  assert.equal(st.renders, 0);
  assert.equal(deps.undo.can_undo(), false, 'отказанная запись в стопку не попадает');
});

test('TST-58 REQ-090: шторка — не более трёх полей и трёх действий (открыть «+», набрать сумму, Enter); счёт и дата убраны под «Другой счёт или дата»', () => {
  const deps = reset(day_after());
  const nav = e.slot_nodes('nav.actions');
  assert.deepEqual(nav.map((n) => n.textContent), ['+ Факт', 'Сверить остаток', 'ОтменитьВернуть'], 'кнопка «+» и сверка — в навигации через реестр, без правки app.mjs');
  let actions = 0;
  click(nav[0]); actions += 1; // 1: открыть
  const dlg = byid.get('dlg');
  assert.equal(dlg.open, true);
  assert.equal(byid.get('dlg-title').textContent, 'Новый факт');
  const form = byid.get('dlg-body').children[0];
  const visible = find_all(form, (n) => ['input', 'select'].includes(n.tagName) && !n.hasAttribute('hidden'))
    .filter((n) => !find_all(form, (r) => r.hasAttribute('hidden')).some((hid) => find_all(hid, (x) => x === n).length > 0));
  assert.deepEqual(visible.map((n) => n.attrs.id), ['entry-amount', 'entry-account', 'entry-date'], 'три поля: сумма, счёт, дата (получатель перевода скрыт)');
  const amount = find_all(form, (n) => n.attrs.id === 'entry-amount')[0];
  assert.equal(amount.focused, true, 'курсор уже в поле суммы');
  amount.value = '12,50'; actions += 1; // 2: набрать
  submit(form); actions += 1; // 3: Enter
  assert.ok(actions <= 3);
  assert.equal(st.ws.facts.at(-1).amount_minor, -1250);
  assert.equal(dlg.open, false, 'шторка закрыта после записи');
  assert.match(N(st.notes.at(-1)[0]), /^Добавлен расход 12,50 € · Основной счёт · 5 октября\.$/);
  void deps;
});

test('TST-58 REQ-090: ошибка в шторке — текст под полем, шторка остаётся открытой, данные не тронуты; потом верная сумма проходит', () => {
  const deps = reset(day_after());
  const h = open_entry_dialog(ctx, deps);
  h.amount.value = 'abc';
  submit(h.form);
  assert.equal(h.error.textContent, 'Не похоже на сумму. Образец записи: 1 234,50.');
  assert.equal(byid.get('dlg').open, true);
  assert.equal(st.ws.facts.length, G.facts.length);
  assert.equal(byid.get('live').textContent, h.error.textContent, 'ошибка объявлена скринридеру');
  h.date.value = '2026-10-06';
  h.amount.value = '12,50';
  submit(h.form);
  assert.match(h.error.textContent, /^Факт не может быть позже даты расчёта \(5 октября\)/);
  h.date.value = '2026-10-05';
  submit(h.form);
  assert.equal(h.error.textContent, '');
  assert.equal(st.ws.facts.length, G.facts.length + 1);
  assert.equal(byid.get('dlg').open, false);
  // английский интерфейс и набор en: «1,234.50»
  const w = { ...day_after(), number_format: 'en' };
  const d2 = reset(w, 'en');
  const h2 = open_entry_dialog(ctx, d2);
  assert.match(find_all(h2.form, (n) => n.attrs.id === 'entry-hint')[0].textContent, /for example 1,234\.50\./);
  h2.amount.value = '1,234.50';
  submit(h2.form);
  assert.equal(st.ws.facts.at(-1).amount_minor, -123450);
});

// ── REQ-063: предупреждение в шторке и карточка ожидающих переводов ───────────────────────────────────────────────────

const free0 = (ws) => analyze(ws, { as_of: ws.as_of }).series.plan.free[0];

test('TST-02 REQ-063: перевод на копилку при резерве без привязки — предупреждение в шторке до записи; «записать и уменьшить» — free остаётся 250000; одно «Отменить» убирает и перевод, и уменьшение', () => {
  const deps = reset(day_after('2026-10-05', { cash: false }));
  const free_before = free0(st.ws);
  assert.equal(free_before, 250000, 'канон G-001: free 250000');
  const h = open_entry_dialog(ctx, deps);
  h.set_kind('transfer');
  h.account.value = 'acc_main';
  h.to.value = 'acc_sav';
  h.amount.value = '1000,00';
  submit(h.form);
  assert.equal(st.ws.facts.length, G.facts.length, 'до ответа ничего не записано');
  const box = h.guard_box.children[0];
  assert.ok(box !== undefined, 'показано предупреждение о двойном вычитании');
  assert.match(box.textContent, /Деньги вычтутся дважды/);
  assert.match(N(box.textContent), /Перевод 1 000,00 € на счёт «Копилка»/);
  assert.match(N(box.textContent), /накоплено 1 500,00 €, предлагается уменьшить на 1 000,00 €/);
  const buttons = find_all(box, (n) => n.tagName === 'button').map((b) => N(b.textContent));
  assert.deepEqual(buttons, ['Записать и уменьшить резерв на 1 000,00 €', 'Записать без изменения резерва', 'Назад']);
  const j = ctx.journal;
  const hash0 = j.state_hash();
  click(find_all(box, (n) => n.tagName === 'button')[0]);
  assert.equal(byid.get('dlg').open, false);
  assert.equal(st.ws.facts.length, G.facts.length + 2, 'две ноги перевода');
  assert.equal(st.ws.allocations.length, 1);
  assert.equal(st.ws.allocations[0].amount_minor, -100000);
  assert.equal(st.ws.allocations[0].source, 'manual');
  assert.equal(free0(st.ws), free_before, 'после согласия free прежний (канон: 250000 остаётся 250000)');
  assert.equal(analyze(st.ws, { as_of: st.ws.as_of }).series.plan.reserve_opening_minor, 50000);
  assert.deepEqual(pending_transfers(st.ws), [], 'запрос больше не появляется');
  // одно действие для «Отменить»
  const undo = e.slot_nodes('nav.actions');
  void undo; // кнопки пакета видят свою стопку; здесь проверяем стопку deps
  assert.equal(deps.undo.size().undo, 1);
  const r = deps.undo.undo(ctx);
  assert.equal(r.ok, true);
  assert.equal(st.ws.facts.length, G.facts.length);
  assert.equal(st.ws.allocations.length, 0);
  assert.equal(j.state_hash(), hash0, 'state_hash журнала после «Отменить» равен хэшу до ввода');
});

test('TST-02 REQ-063: «записать без изменения» — перевод записан, free падает (двойной счёт), отказ запомнен: запрос по этому переводу не повторяется; по новому — повторяется', () => {
  const deps = reset(day_after('2026-10-05', { cash: false }));
  const free_before = free0(st.ws);
  const h = open_entry_dialog(ctx, deps);
  h.set_kind('transfer');
  h.account.value = 'acc_main'; h.to.value = 'acc_sav'; h.amount.value = '1000';
  submit(h.form);
  click(find_all(h.guard_box.children[0], (n) => n.tagName === 'button')[1]);
  assert.equal(st.ws.facts.length, G.facts.length + 2);
  assert.equal(st.ws.allocations.length, 0);
  assert.equal(free0(st.ws), free_before - 100000, 'без согласия free падает на сумму перевода');
  const tid = st.ws.facts.at(-1).transfer_id;
  assert.ok(deps.declines.all().has(tid), 'отказ запомнен');
  const j = ctx.journal;
  assert.ok(j.events().some((x) => x.type === 'draft.proposed' && x.payload.transfer_id === tid && x.payload.decision === 'declined'), 'отказ записан в журнал');
  assert.equal(render_pending_card(ctx, deps), null, 'карточка ожидающих не показывается');
  const again = prepare_entry(st.ws, { kind: 'transfer', amount_text: '10', account_id: 'acc_main', to_account_id: 'acc_sav' }, env({ declined: deps.declines.all() }));
  assert.equal(again.guard.warn, true, 'новый перевод — новый запрос');
  // «Назад» — ничего не записано; «Записать» без выбора — отказ commit
  const back = open_entry_dialog(ctx, deps);
  back.set_kind('transfer');
  back.account.value = 'acc_main'; back.to.value = 'acc_sav'; back.amount.value = '10';
  submit(back.form);
  click(find_all(back.guard_box.children[0], (n) => n.tagName === 'button')[2]);
  assert.equal(back.guard_box.children.length, 0);
  assert.equal(st.ws.facts.length, G.facts.length + 2);
  assert.equal(commit_entry(ctx, again, undefined, deps).error.ctx.reason, 'guard_choice_required');
});

test('TST-02 REQ-063: перевод из файла без ответа — карточка «ждёт ответа» на «Обзоре» и «Резервах»; «уменьшить» записывает аллокацию и отменяется; «оставить» убирает карточку', () => {
  const w = day_after('2026-10-05', { cash: false });
  const posted = apply_edit(w, { type: 'add_fact', transfer_id: 'trf_file', legs: [{ account_id: 'acc_main', date: '2026-10-05', amount_minor: -40000 }, { account_id: 'acc_sav', date: '2026-10-05', amount_minor: 40000 }] }, { new_id: ctx.new_id });
  const deps = reset(posted.ws);
  assert.equal(e.slot_nodes('overview.cards').length, 1, 'карточка в слоте обзора');
  assert.equal(e.slot_nodes('reserves.sections').length, 1, 'и в слоте резервов');
  const card = render_pending_card(ctx, deps);
  assert.match(N(card.textContent), /Перевод 400,00 € на «Копилка» от 5 октября: резерв остался прежним/);
  const free_after = free0(st.ws);
  assert.equal(free_after, 250000 - 40000);
  const [c] = pending_transfers(st.ws);
  assert.equal(resolve_pending(ctx, c, 'reduce', deps).ok, true);
  assert.equal(free0(st.ws), 250000, 'после согласия free прежний');
  assert.equal(render_pending_card(ctx, deps), null);
  assert.equal(deps.undo.undo(ctx).ok, true);
  assert.equal(st.ws.allocations.length, 0);
  assert.equal(pending_transfers(st.ws).length, 1, 'после «Отменить» запрос вернулся');
  // «оставить как есть» через кнопку карточки
  const card2 = render_pending_card(ctx, deps);
  const keep = find_all(card2, (n) => n.tagName === 'button')[1];
  assert.equal(keep.textContent, 'Оставить как есть');
  click(keep);
  assert.equal(render_pending_card(ctx, deps), null);
  assert.ok(st.notes.at(-1)[0].startsWith('Оставлено как есть'));
});

// ── «Отменить / Вернуть» ─────────────────────────────────────────────────────────────────────────────────────────────

test('TST-16 REQ-090: «Отменить» возвращает state_hash журнала к значению до ввода (и core_hash, опция FP-02); журнал только дописывается; «Вернуть» восстанавливает факт', () => {
  const deps = reset(day_after());
  const j = ctx.journal;
  const n0 = j.length;
  const prefix0 = j.prefix_hash(n0);
  const hash0 = j.state_hash();
  const core0 = core_hash(j.state().state);
  const ws0 = st.ws;
  commit_entry(ctx, prepare_entry(st.ws, { kind: 'expense', amount_text: '12,50', account_id: 'acc_main' }, env()), undefined, deps);
  const ws1 = st.ws;
  assert.equal(ctx.journal, j, 'тот же журнал следует за правками');
  assert.notEqual(j.state_hash(), hash0, 'ввод меняет состояние');
  assert.equal(deps.undo.can_undo(), true);
  assert.equal(deps.undo.can_redo(), false);
  assert.deepEqual(deps.undo.peek_undo(), { kind: 'expense', amount_minor: 1250, currency: 'EUR' });
  const u = deps.undo.undo(ctx);
  assert.equal(u.ok, true);
  assert.equal(canon(st.ws), canon(ws0), 'рабочая область как до ввода');
  assert.equal(j.state_hash(), hash0, 'state_hash после «Отменить» равен хэшу до ввода');
  assert.equal(core_hash(j.state().state), core0, 'и core_hash (state_hash без imports)');
  assert.equal(state_hash(j.state().state, { omit: ['imports'] }), core0);
  assert.equal(j.prefix_hash(n0), prefix0, 'журнал только дописывается: прежний префикс не изменился');
  assert.ok(j.length > n0, 'отмена — это записи revert, а не удаление');
  assert.ok(j.events().slice(n0).some((x) => x.type === 'revert'));
  assert.equal(deps.undo.can_undo(), false);
  assert.equal(deps.undo.can_redo(), true);
  const r = deps.undo.redo(ctx);
  assert.equal(r.ok, true);
  assert.equal(canon(st.ws), canon(ws1), 'после «Вернуть» — как после ввода');
  assert.ok(Object.values(j.state().state.facts).some((f) => f.entity_id === ws1.facts.at(-1).event_id), 'факт снова в состоянии журнала');
  assert.equal(j.prefix_hash(n0), prefix0);
  // повторная отмена тоже возвращает хэш
  assert.equal(deps.undo.undo(ctx).ok, true);
  assert.equal(j.state_hash(), hash0);
});

test('TST-16 REQ-090: страница перерисовывается ВНУТРИ записи — стопка отмены и отказ уже обновлены к этому моменту; отказ пересчёта возвращает стопки как были', () => {
  const deps = reset(day_after('2026-10-05', { cash: false }));
  const seen = [];
  st.probe = () => seen.push([deps.undo.can_undo(), deps.undo.can_redo()]);
  commit_entry(ctx, prepare_entry(st.ws, { kind: 'expense', amount_text: '1', account_id: 'acc_main' }, env()), undefined, deps);
  assert.deepEqual(seen, [[true, false]], 'кнопка «Отменить» к моменту перерисовки уже доступна');
  seen.length = 0;
  deps.undo.undo(ctx);
  assert.deepEqual(seen, [[false, true]], 'после отмены «Вернуть» доступна уже при перерисовке');
  st.probe = null;
  // перевод с ответом «оставить»: отказ запомнен до перерисовки, карточка ожидающих не мигает
  const posted = [];
  st.probe = () => posted.push(render_pending_card(ctx, deps) === null);
  const t = prepare_entry(st.ws, { kind: 'transfer', amount_text: '10', account_id: 'acc_main', to_account_id: 'acc_sav' }, env());
  assert.equal(t.guard.warn, true);
  assert.equal(commit_entry(ctx, t, 'keep', deps).ok, true);
  assert.deepEqual(posted, [true], 'при перерисовке карточка уже скрыта');
  st.probe = null;
  // отказ пересчёта страницей: рабочая область, стопка «вернуть» и память отказов — как до попытки
  deps.undo.clear();
  const base = st.ws;
  commit_entry(ctx, prepare_entry(st.ws, { kind: 'expense', amount_text: '2', account_id: 'acc_main' }, env()), undefined, deps);
  deps.undo.undo(ctx); // теперь «вернуть» доступна
  assert.deepEqual(deps.undo.size(), { undo: 0, redo: 1 });
  const ws_now = st.ws;
  st.refuse = true;
  const tt = prepare_entry(st.ws, { kind: 'transfer', amount_text: '20', account_id: 'acc_main', to_account_id: 'acc_sav' }, env());
  const refused = commit_entry(ctx, tt, 'keep', deps);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.ctx.reason, 'forced_refusal');
  assert.equal(st.ws, ws_now);
  assert.deepEqual(deps.undo.size(), { undo: 0, redo: 1 }, 'отказ записи не очистил «Вернуть» и не добавил единицу');
  assert.equal(deps.declines.all().has(tt.info.transfer_id), false, 'отказ по несостоявшемуся переводу не запомнен');
  assert.equal(deps.undo.redo(ctx).ok, false, 'и возврат при отказе страницы не меняет данные');
  assert.deepEqual(deps.undo.size(), { undo: 0, redo: 1 }, 'единица вернулась на место');
  assert.equal(st.ws, ws_now);
  st.refuse = false;
  assert.equal(deps.undo.redo(ctx).ok, true);
  void base;
});

test('TST-16 REQ-090: новое действие очищает «Вернуть»; смена набора данных очищает стопку; предел стопки; пустая стопка — отказ без записи', () => {
  const deps = reset(day_after());
  const add = (t) => commit_entry(ctx, prepare_entry(st.ws, { kind: 'expense', amount_text: t, account_id: 'acc_main' }, env()), undefined, deps);
  add('1'); add('2');
  assert.equal(deps.undo.size().undo, 2);
  deps.undo.undo(ctx);
  assert.equal(deps.undo.can_redo(), true);
  add('3');
  assert.equal(deps.undo.can_redo(), false, 'новое действие очистило «Вернуть»');
  assert.deepEqual(st.ws.facts.slice(-2).map((f) => f.amount_minor), [-100, -300]);
  deps.undo.clear();
  assert.deepEqual(deps.undo.size(), { undo: 0, redo: 0 });
  const r = deps.undo.undo(ctx);
  assert.equal(r.ok, false);
  assert.equal(r.error.ctx.reason, 'nothing_to_undo');
  assert.equal(deps.undo.redo(ctx).error.ctx.reason, 'nothing_to_redo');
  const small = create_undo_stack({ limit: 3 });
  for (let i = 0; i < 5; i++) {
    const a = apply_edit(st.ws, { type: 'add_fact', fact: { account_id: 'acc_main', date: '2026-10-05', amount_minor: -(i + 1) } }, { new_id: ctx.new_id });
    small.record(st.ws, a.ws, { kind: 'expense', amount_minor: i + 1, currency: 'EUR' });
    st.ws = a.ws;
  }
  assert.equal(small.size().undo, 3, 'помнит последние 3 действия');
  assert.equal(small.record(st.ws, st.ws, {}), false, 'без разницы единицы нет');
  // пакет очищает свои стопки при смене набора данных: кнопки «Отменить» неактивны
  const pack_undo = () => find_all(e.slot_nodes('nav.actions')[2], (n) => n.tagName === 'button');
  reset(day_after());
  assert.deepEqual(pack_undo().map((b) => b.hasAttribute('disabled')), [true, true]);
});

test('TST-16 REQ-090: кнопки «Отменить» / «Вернуть» в навигации живут от стопки пакета: подпись действия, сообщение, возврат', () => {
  reset(day_after());
  const nav = () => e.slot_nodes('nav.actions');
  const open_and_add = () => {
    click(nav()[0]);
    const form = byid.get('dlg-body').children[0];
    find_all(form, (n) => n.attrs.id === 'entry-amount')[0].value = '12,50';
    submit(form);
  };
  open_and_add();
  const [undo_btn, redo_btn] = find_all(nav()[2], (n) => n.tagName === 'button');
  assert.equal(undo_btn.hasAttribute('disabled'), false);
  assert.equal(redo_btn.hasAttribute('disabled'), true);
  assert.equal(N(undo_btn.attrs['aria-label']), 'Отменить последнее действие: расход 12,50 €');
  const n_facts = st.ws.facts.length;
  click(undo_btn);
  assert.equal(st.ws.facts.length, n_facts - 1);
  assert.equal(N(st.notes.at(-1)[0]), 'Отменено: расход 12,50 €.');
  const [, redo2] = find_all(nav()[2], (n) => n.tagName === 'button');
  assert.equal(N(redo2.attrs['aria-label']), 'Вернуть отменённое действие: расход 12,50 €');
  click(redo2);
  assert.equal(st.ws.facts.length, n_facts);
  assert.equal(N(st.notes.at(-1)[0]), 'Возвращено: расход 12,50 €.');
  // чужая правка после действия: отмена отказывает, данные не трогаются, единица снимается.
  // S1.3: «чужой» теперь только запись, которой нет в стопке (здесь — запись мастера импорта, причина `import`); обычная `ctx.edit` сама становится единицей отмены
  const fact = st.ws.facts.at(-1);
  const voided = apply_edit(st.ws, { type: 'void_fact', event_id: fact.event_id }, {});
  assert.equal(ctx.set_ws(voided.ws, { reason: 'import' }).ok, true);
  const ws_after_void = st.ws;
  const [undo3] = find_all(nav()[2], (n) => n.tagName === 'button');
  click(undo3);
  assert.equal(st.ws, ws_after_void, 'данные не тронуты');
  assert.equal(st.notes.at(-1)[0], 'Отменить нельзя: данные изменились после этого действия.');
  assert.equal(find_all(nav()[2], (n) => n.tagName === 'button')[0].hasAttribute('disabled'), true, 'устаревшая единица снята со стопки');
});

test('TST-16 REQ-090: diff_unit / apply_unit — добавление, замена и удаление по корзинам; несовпадение текущего состояния — undo_conflict', () => {
  const w0 = day_after();
  const add = apply_edit(w0, { type: 'add_fact', fact: { event_id: 'tx-u1', account_id: 'acc_main', date: '2026-10-05', amount_minor: -700 } }, {}).ws;
  const anc = apply_edit(add, { type: 'set_anchor', anchor: { anchor_id: 'anc-g001-1004', account_id: 'acc_main', date: '2026-10-04', amount_minor: 390000 } }, {}).ws;
  const unit = diff_unit(w0, anc, { kind: 'other' });
  assert.deepEqual(unit.changes.map((c) => [c.bucket, c.key, c.before === null, c.after === null]), [['facts', 'tx-u1', true, false], ['anchors', 'anc-g001-1004', false, false]]);
  const undone = apply_unit(anc, unit, 'undo');
  assert.equal(undone.ok, true);
  assert.equal(canon(undone.ws), canon(w0), 'замена якоря откатилась к прежнему значению');
  const redone = apply_unit(undone.ws, unit, 'redo');
  assert.equal(canon(redone.ws), canon(anc));
  // удаление
  const rm = diff_unit(add, w0, {});
  assert.deepEqual(rm.changes.map((c) => [c.key, c.after]), [['tx-u1', null]]);
  assert.equal(canon(apply_unit(w0, rm, 'undo').ws), canon(add), 'отмена удаления возвращает элемент');
  // конфликт: факт уже изменён кем-то
  const tampered = clone(anc);
  tampered.facts.find((f) => f.event_id === 'tx-u1').amount_minor = -1;
  const bad = apply_unit(tampered, unit, 'undo');
  assert.deepEqual([bad.ok, bad.reason, bad.bucket, bad.key], [false, 'undo_conflict', 'facts', 'tx-u1']);
  assert.equal(diff_unit(w0, w0), null);
  // S1.3 (единая стопка): параметры и метаполя тоже отслеживаются — прежнее ожидание «параметры вне корзин отмены не отслеживаются» намеренно снято;
  // формат записи для прежних четырёх корзин (`{bucket, key, before, after}`) не изменился, у слота параметра значение — коробка `{value}`
  const pu = diff_unit(w0, { ...w0, params: { ...w0.params, buffer_minor: 1 } });
  assert.deepEqual(pu.changes.map((c) => [c.bucket, c.key, c.after]), [['params', 'buffer_minor', { value: 1 }]]);
});

// ── REQ-028: сверка остатка ──────────────────────────────────────────────────────────────────────────────────────────

test('TST-57 REQ-028: границы свежести не изменились — возраст якоря 7 → fresh, 8 → banner, 21 → banner, 22 → block (движок), freshness() читает тот же уровень', () => {
  const cases = [['2026-10-04', 0, 'fresh'], ['2026-10-11', 7, 'fresh'], ['2026-10-12', 8, 'banner'], ['2026-10-25', 21, 'banner'], ['2026-10-26', 22, 'block']];
  for (const [as_of, age, level] of cases) {
    const w = clone(G);
    w.as_of = as_of;
    const s = anchor_status(w, as_of);
    assert.equal(s.age, age, as_of);
    assert.equal(s.level, level, `возраст ${age}: ${level}`);
    assert.deepEqual([freshness(w).level, freshness(w).age], [level, age]);
  }
  assert.equal(freshness({}), null, 'расчёт недоступен — null, без исключения');
});

test('TST-57 REQ-028: после «сверить остаток» плашка stale/block исчезает; от плашки до закрытия 3 действия (открыть, число, Enter); якорь = названное число', () => {
  assert.equal(ANCHOR_ACTIONS, 3);
  for (const as_of of ['2026-10-13', '2026-10-26']) { // banner (9 дней) и block (22 дня)
    const w = clone(G);
    w.as_of = as_of;
    const deps = reset(w);
    const level0 = anchor_status(w, as_of).level;
    assert.ok(['banner', 'block'].includes(level0), `исходно плашка: ${level0}`);
    let actions = 0;
    const o = anchor_open(ctx, deps); actions += 1; // 1
    assert.equal(o.ok, true);
    assert.equal(o.state.account_id, 'acc_main');
    assert.equal(o.state.date, as_of, 'дата = as_of');
    const s = anchor_input(ctx, o.state, { amount_text: '3 950,00' }); actions += 1; // 2
    assert.equal(s.preview.entered_minor, 395000);
    const r = anchor_confirm(ctx, s, deps); actions += 1; // 3
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.ok(actions <= 3);
    assert.equal(anchor_status(st.ws, as_of).level, 'fresh', 'плашка исчезла');
    assert.equal(anchor_status(st.ws, as_of).age, 0);
    assert.equal(r.before.level, level0);
    assert.equal(r.after.level, 'fresh');
    assert.equal(opening_state(st.ws, as_of).opening_minor, 395000, 'опорный остаток = названное число');
    assert.match(N(done_text(ctx, r)), /Остаток сверен: 3 950,00 € на (13|26) октября\. Расхождение с записями: −50,00 €\. Плашка о давности данных снята\.$/);
  }
});

test('TST-57 REQ-028: показ найденного дрейфа — «−5 000» при записях 400000 и названном 395000; сходится — дрейфа нет; первая сверка счёта — без сравнения', () => {
  const w = clone(G);
  w.as_of = '2026-10-13';
  const pv = reconcile_preview(w, { account_id: 'acc_main', amount_minor: 395000, date: '2026-10-13' });
  assert.deepEqual([pv.expected_minor, pv.drift_minor, pv.first, pv.prev_date, pv.replaces], [400000, -5000, false, '2026-10-04', null]);
  const deps = reset(w);
  const o = anchor_open(ctx, deps);
  const s = anchor_input(ctx, o.state, { amount_text: '3950' });
  assert.equal(N(preview_text(ctx, w, s.preview)), 'По записям на 13 октября выходит 4 000,00 €, вы называете 3 950,00 €: расхождение −50,00 €. Оно останется в данных как неучтённые движения.');
  const same = anchor_input(ctx, o.state, { amount_text: '4000' });
  assert.equal(N(preview_text(ctx, w, same.preview)), 'Сходится: по записям на 13 октября выходит 4 000,00 €.');
  assert.equal(anchor_input(ctx, o.state, { amount_text: 'abc' }).preview, null, 'неразобранное число — без показа');
  // факт после якоря входит в «по записям»
  const w2 = apply_edit(w, { type: 'add_fact', fact: { account_id: 'acc_main', date: '2026-10-10', amount_minor: -2500 } }, { new_id: ctx.new_id }).ws;
  assert.equal(reconcile_preview(w2, { account_id: 'acc_main', amount_minor: 397500, date: '2026-10-13' }).drift_minor, 0, 'якорь 400000 − факт 2500 = 397500');
  // первая сверка: у «Кассы» якоря не было
  const w3 = day_after('2026-10-13');
  w3.anchors = w3.anchors.filter((a) => a.account_id !== 'acc_cash');
  const first = reconcile_preview(w3, { account_id: 'acc_cash', amount_minor: 5000, date: '2026-10-13' });
  assert.equal(first.first, true);
  reset(w3);
  const s3 = anchor_input(ctx, { account_id: 'acc_cash', date: '2026-10-13', amount_text: '' }, { amount_text: '50' });
  assert.equal(N(preview_text(ctx, w3, s3.preview)), 'Раньше остаток этого счёта не сверялся: расхождение сравнивать не с чем, прогноз начнётся с 50,00 €.');
});

test('TST-57 REQ-028: дрейф сверки равен дрейфу движка (opening_state.drift) на 40 случайных рабочих областях с фактами и несколькими якорями', () => {
  const rng = make_rng(28);
  for (let i = 0; i < 40; i++) {
    let w = clone(G);
    w.as_of = '2026-10-20';
    const n_facts = rng.int(0, 6);
    for (let k = 0; k < n_facts; k++) {
      const day = rng.int(5, 20);
      const amount = rng.int(1, 90000) * (rng.bool() ? 1 : -1);
      w = apply_edit(w, { type: 'add_fact', fact: { event_id: `tx-r${i}-${k}`, account_id: 'acc_main', date: '2026-10-' + String(day).padStart(2, '0'), amount_minor: amount } }, {}).ws;
    }
    if (rng.bool()) w = apply_edit(w, { type: 'set_anchor', anchor: { anchor_id: 'anc-mid', account_id: 'acc_main', date: '2026-10-' + String(rng.int(5, 12)).padStart(2, '0'), amount_minor: rng.int(100000, 500000) } }, {}).ws;
    const date = '2026-10-' + String(rng.int(13, 20)).padStart(2, '0');
    const entered = rng.int(0, 600000);
    const pv = reconcile_preview(w, { account_id: 'acc_main', amount_minor: entered, date });
    const b = build_anchor_edit(w, { account_id: 'acc_main', amount_text: String(Math.floor(entered / 100)) + ',' + String(entered % 100).padStart(2, '0'), date }, env());
    assert.equal(b.ok, true);
    assert.equal(b.preview.entered_minor, entered);
    const after = apply_edit(w, b.edit, { new_id: ctx.new_id });
    assert.equal(after.ok, true);
    assert.equal(opening_state(after.ws, '2026-10-20').drift, pv.drift_minor, `случай ${i}: drift движка = drift показа`);
    assert.equal(pv.drift_minor, entered - pv.expected_minor);
  }
});

test('TST-57 REQ-028: якорь на ту же дату заменяет прежний (тот же anchor_id), «Отменить» возвращает его; state_hash журнала возвращается', () => {
  const deps = reset(clone(G)); // as_of 10-04: якорь anc-g001-1004 = 400000 уже есть
  const j = ctx.journal;
  const hash0 = j.state_hash();
  const o = anchor_open(ctx, deps);
  const s = anchor_input(ctx, o.state, { amount_text: '3 990,00' });
  assert.equal(s.preview.replaces, 'anc-g001-1004');
  const r = anchor_confirm(ctx, s, deps);
  assert.equal(r.ok, true);
  assert.equal(st.ws.anchors.length, G.anchors.length, 'якорей столько же: заменён, а не добавлен');
  assert.equal(st.ws.anchors.find((a) => a.anchor_id === 'anc-g001-1004').amount_minor, 399000);
  assert.equal(opening_state(st.ws, st.ws.as_of).opening_minor, 399000);
  assert.deepEqual(deps.undo.peek_undo(), { kind: 'anchor', amount_minor: 399000, currency: 'EUR' });
  assert.equal(deps.undo.undo(ctx).ok, true);
  assert.equal(st.ws.anchors.find((a) => a.anchor_id === 'anc-g001-1004').amount_minor, 400000);
  assert.equal(j.state_hash(), hash0, 'после «Отменить» хэш состояния как до сверки');
  // новая дата — новый якорь, «Отменить» его убирает
  const w = clone(G);
  w.as_of = '2026-10-10';
  const d2 = reset(w);
  const h2 = ctx.journal.state_hash();
  const r2 = anchor_confirm(ctx, anchor_input(ctx, anchor_open(ctx, d2).state, { amount_text: '3 900' }), d2);
  assert.equal(r2.ok, true);
  assert.equal(st.ws.anchors.length, G.anchors.length + 1);
  assert.match(st.ws.anchors.at(-1).anchor_id, /^anc_[0-9a-f]{12}$/);
  assert.equal(d2.undo.undo(ctx).ok, true);
  assert.equal(st.ws.anchors.length, G.anchors.length);
  assert.equal(ctx.journal.state_hash(), h2);
});

test('TST-57 REQ-028: сверка читает число по формату набора (en при русском интерфейсе), принимает ноль и минус (овердрафт), отвергает мусор и будущую дату — данные не меняются', () => {
  const w = { ...clone(G), as_of: '2026-10-13', number_format: 'en' };
  const deps = reset(w);
  const ok = (text) => { const b = build_anchor_edit(w, { account_id: 'acc_main', amount_text: text }, env({ lang: 'ru' })); assert.equal(b.ok, true, text); return b.edit.anchor.amount_minor; };
  assert.equal(ok('3,950.00'), 395000, 'en-набор при русском интерфейсе');
  assert.equal(ok('0'), 0);
  assert.equal(ok('-120.50'), -12050);
  assert.equal(ok('−5'), -500);
  const bad = (form, code) => { const b = build_anchor_edit(w, form, env()); assert.equal(b.ok, false); assert.equal(b.error.code, code, JSON.stringify(b.error)); };
  bad({ account_id: 'acc_main', amount_text: '3950,00' }, 'E_NOT_INTEGER');
  bad({ account_id: 'acc_main', amount_text: '' }, 'E_NOT_INTEGER');
  bad({ account_id: 'нет', amount_text: '5' }, 'E_SCHEMA');
  bad({ account_id: 'acc_main', amount_text: '5', date: '2026-10-14' }, 'E_FUTURE_POSTED');
  bad({ account_id: 'acc_main', amount_text: '5', date: '2026-02-30' }, 'E_BAD_DATE');
  bad(null, 'E_SCHEMA');
  const ws0 = st.ws;
  const r = anchor_confirm(ctx, { account_id: 'acc_main', date: '2026-10-13', amount_text: 'мусор' }, deps);
  assert.equal(r.ok, false);
  assert.equal(st.ws, ws0);
  assert.equal(deps.undo.can_undo(), false);
  assert.equal(anchor_open({ ...ctx, get_ws: () => null }, deps).ok, false);
});

test('TST-57 REQ-028: два счёта — сверка одного оставляет плашку (другой не сверен), сообщение об этом; счёт по умолчанию — самый несвежий', () => {
  const w = day_after('2026-10-13');
  w.anchors = w.anchors.filter((a) => a.account_id !== 'acc_cash'); // у кассы якоря нет вовсе → самый несвежий
  const deps = reset(w);
  assert.equal(default_anchor_account(w, null), 'acc_cash');
  assert.equal(default_anchor_account(w, 'acc_main'), 'acc_cash', 'пока есть несвежий счёт, кнопка ведёт на него, а не на запомненный');
  assert.equal(default_anchor_account(w, 'нет такого'), 'acc_cash');
  const o = anchor_open(ctx, deps);
  assert.equal(o.state.account_id, 'acc_cash');
  const first = anchor_confirm(ctx, anchor_input(ctx, { ...o.state, account_id: 'acc_main' }, { amount_text: '4000' }), deps);
  assert.equal(first.ok, true);
  assert.equal(first.after.level, 'block', 'у кассы якоря нет: плашка остаётся');
  assert.match(N(done_text(ctx, first)), /Плашка о давности остаётся: другие счета ещё не сверены\.$/);
  assert.equal(deps.memory.get(st.ws), 'acc_main', 'после сверки запоминается счёт');
  assert.equal(default_anchor_account(st.ws, 'acc_main'), 'acc_cash', 'касса всё ещё без якоря');
  const second = anchor_confirm(ctx, anchor_input(ctx, { ...first, account_id: 'acc_cash', date: st.ws.as_of }, { amount_text: '100' }), deps);
  assert.equal(second.ok, true);
  assert.equal(second.after.level, 'fresh');
  assert.equal(default_anchor_account(st.ws, deps.memory.get(st.ws)), 'acc_cash', 'всё сверено: запомненный (последний сверенный) счёт');
  assert.equal(default_anchor_account({ accounts: [], anchors: [], facts: [], as_of: '2026-10-13' }, null), null);
});

test('TST-57 REQ-028: диалог «Сверить остаток» — число, живой показ расхождения, Enter, итог на странице; кнопка в навигации выделена, пока данные устарели', () => {
  const w = clone(G);
  w.as_of = '2026-10-26'; // block
  reset(w);
  const btn = e.slot_nodes('nav.actions')[1];
  assert.equal(btn.className, 'btn primary', 'данные устарели: кнопка выделена');
  click(btn); // действие 1
  const form = byid.get('dlg-body').children[0];
  assert.equal(byid.get('dlg-title').textContent, 'Сверить остаток');
  const amount = find_all(form, (n) => n.attrs.id === 'anchor-amount')[0];
  assert.equal(amount.focused, true);
  amount.value = '3 950,00'; // действие 2
  amount.listeners.input[0]();
  assert.match(N(find_all(form, (n) => n.attrs.id === 'anchor-preview')[0].textContent), /расхождение −50,00 €/);
  submit(form); // действие 3
  assert.equal(anchor_status(st.ws, '2026-10-26').level, 'fresh');
  const result = N(find_all(form, (n) => n.attrs.id === 'anchor-result')[0].textContent);
  assert.match(result, /Остаток сверен: 3 950,00 € на 26 октября\. Расхождение с записями: −50,00 €\. Плашка о давности данных снята\./);
  assert.equal(N(st.notes.at(-1)[0]), result);
  assert.equal(e.slot_nodes('nav.actions')[1].className, 'btn', 'данные свежие: кнопка обычная');
  // ошибка — текст в диалоге, данные не тронуты
  reset(w);
  const h = open_anchor_dialog(ctx, make_deps(ctx));
  h.amount.value = 'abc';
  submit(h.form);
  assert.equal(h.error.textContent, 'Не похоже на сумму. Образец записи: 1 234,50.');
  assert.equal(st.ws, w);
});

// ── пакет и реестр ───────────────────────────────────────────────────────────────────────────────────────────────────

test('TST-56 TST-59 пакет FP-04: подключён через реестр без правки app.mjs — слоты, каталог строк RU/EN, без ошибок загрузки', () => {
  assert.deepEqual(e.diagnostics().filter((d) => d.status !== 'notify'), [{ status: 'ok', pack: 'pack_fp04' }]);
  assert.equal(e.slot_nodes('nav.actions').length, 3);
  for (const key of ['entry.nav_add', 'entry.nav_anchor', 'entry.nav_undo', 'entry.guard_title', 'entry.a_title']) {
    assert.notEqual(tr_of('ru', key), key, key);
    assert.notEqual(tr_of('en', key), key, key);
  }
  const src = fs.readFileSync(path.join(HERE, '..', 'demo', 'app.mjs'), 'utf8');
  assert.ok(!/pack_fp04|entry\.mjs|anchor_dialog|undo\.mjs/.test(src), 'app.mjs пакет по имени не знает');
  void [ctx, default_transfer_target, create_decline_store, build_anchor_edit];
});
