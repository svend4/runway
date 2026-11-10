// entry_memory_store.test.mjs — FP-22, REQ-090 (TST-58): «последний использованный счёт» в быстром вводе запоминается в localStorage (ключ runway-entry-memory/1) и переживает перезагрузку.
// Часть 1 — модуль без DOM: запись и чтение, «перезагрузка» (новый экземпляр над тем же хранилищем), forget() очищает только кэш страницы, без хранилища и с хранилищем-заглушкой память страницы
// работает как раньше, испорченное содержимое не ломает, ключ находит и стирает «Удалить все данные» (erase_all по префиксу runway), удалённое не воскресает из кэша.
// Часть 2 — настоящий app.mjs на заглушке DOM: «+ Факт» на втором счёте записывает счёт на устройство; после «перезагрузки» (новая память над тем же хранилищем) быстрый ввод предлагает его.
// Браузер, сеть и серверы не используются. Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/entry_memory_store.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(HERE, '..', 'demo');
const DATA = path.join(HERE, '..', 'data');

class Node_ {
  constructor(tag, ns) {
    this.nodeType = 1; this.tagName = tag; this.ns = ns ?? null; this.attrs = {}; this.children = []; this.listeners = {}; this.className = '';
    this._text = ''; this._value = ''; this._sel = null; this.open = false; this.focused = false;
  }
  get textContent() { return this.children.length === 0 ? this._text : this.children.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get value() {
    if (this.tagName === 'select') {
      if (this._sel !== null) return this._sel;
      const opts = this.children.filter((c) => c.tagName === 'option');
      const hit = opts.find((o) => o.attrs.selected !== undefined) ?? opts[0];
      return hit === undefined ? '' : hit.attrs.value;
    }
    return this._value;
  }
  set value(v) { if (this.tagName === 'select') this._sel = String(v); else this._value = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this._value = String(v); }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return Object.hasOwn(this.attrs, k); }
  append(...kids) { for (const k of kids) this.children.push(k); this._text = ''; }
  replaceChildren(...kids) { this.children = []; this._text = ''; this.append(...kids); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  focus() { this.focused = true; }
  click() { this.clicked = (this.clicked ?? 0) + 1; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() {}
  querySelectorAll() { return []; }
  walk(fn) { fn(this); for (const c of this.children) if (c.nodeType === 1) c.walk(fn); }
}
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const byid = new Map();
for (const id of ['app-title', 'app-sub', 'skip', 'controls', 'nav', 'summary', 'main', 'footer', 'live', 'dlg', 'dlg-title', 'dlg-close', 'dlg-body']) byid.set(id, new Node_(id === 'dlg' ? 'dialog' : 'div'));
const listeners = {};
globalThis.document = {
  createElement: (t) => new Node_(t),
  createElementNS: (ns, t) => new Node_(t, ns),
  createTextNode: (data) => ({ nodeType: 3, data }),
  getElementById: (id) => byid.get(id) ?? find_all(byid.get('main'), (n) => n.attrs.id === id)[0] ?? null,
  documentElement: new Node_('html'),
  head: new Node_('head'),
  body: new Node_('body'),
  title: '',
};
globalThis.window = { addEventListener: (t, fn) => { (listeners[t] ??= []).push(fn); }, scrollTo: () => {} };
globalThis.location = { hash: '' };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'ru-RU' }, configurable: true });
const page_store = new Map();
globalThis.localStorage = {
  get length() { return page_store.size; },
  key: (i) => [...page_store.keys()][i] ?? null,
  getItem: (k) => (page_store.has(k) ? page_store.get(k) : null),
  setItem: (k, v) => { page_store.set(k, String(v)); },
  removeItem: (k) => { page_store.delete(k); },
};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.ResizeObserver = class { observe() {} };
globalThis.fetch = async (url) => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8')) });
page_store.set('portal-v9-theme', 'dark'); // чужой ключ общего localhost

const { ext } = await import(pathToFileURL(path.join(DEMO, 'ext.mjs')).href);
await import(pathToFileURL(path.join(DEMO, 'app.mjs')).href);
await new Promise((r) => setTimeout(r, 700));

const M = await import(pathToFileURL(path.join(DEMO, 'entry_memory_store.mjs')).href);
const EN = await import(pathToFileURL(path.join(DEMO, 'entry.mjs')).href);
const DA = await import(pathToFileURL(path.join(DEMO, 'data_actions.mjs')).href);
const P4 = await import(pathToFileURL(path.join(DEMO, 'pack_fp04.mjs')).href);

const G = JSON.parse(fs.readFileSync(path.join(DATA, 'g001.json'), 'utf8'));
const ws_a = { workspace_id: 'ws-a' };
const ws_b = { workspace_id: 'ws-b' };
function fake_storage() {
  const m = new Map();
  return { m, get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}

// ═══ часть 1: модуль без DOM ═════════════════════════════════════════════════════════════════════════════════════════════════

test('REQ-090 ключ — с префиксом runway (его находит и стирает «Удалить все данные»); тот же вид, что у памяти страницы entry.create_entry_memory', () => {
  assert.equal(M.ENTRY_MEMORY_KEY, 'runway-entry-memory/1');
  assert.ok(M.ENTRY_MEMORY_KEY.startsWith(DA.LOCAL_PREFIX));
  const mem = M.create_persisted_entry_memory(null);
  assert.deepEqual(Object.keys(mem).sort(), Object.keys(EN.create_entry_memory()).sort());
});

test('REQ-090 запомненный счёт пишется на устройство и переживает «перезагрузку» (новый экземпляр над тем же хранилищем); рабочие области различаются', () => {
  const st = fake_storage();
  const m1 = M.create_persisted_entry_memory(st);
  assert.equal(m1.get(ws_a), null);
  m1.remember(ws_a, 'acc_cash');
  m1.remember(ws_b, 'acc_card');
  assert.equal(m1.get(ws_a), 'acc_cash');
  assert.deepEqual(JSON.parse(st.m.get(M.ENTRY_MEMORY_KEY)), { v: 1, items: [['ws-a', 'acc_cash'], ['ws-b', 'acc_card']] });
  const m2 = M.create_persisted_entry_memory(st); // страница открыта заново
  assert.equal(m2.get(ws_a), 'acc_cash');
  assert.equal(m2.get(ws_b), 'acc_card');
  assert.equal(m2.get({ workspace_id: 'ws-c' }), null);
  m2.remember(ws_a, 'acc_main'); // новый ввод заменяет прежний счёт этой рабочей области
  assert.equal(M.create_persisted_entry_memory(st).get(ws_a), 'acc_main');
  assert.equal(JSON.parse(st.m.get(M.ENTRY_MEMORY_KEY)).items.length, 2);
  // в хранилище только идентификаторы: ни сумм, ни названий, ни дат
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(st.m.get(M.ENTRY_MEMORY_KEY)));
});

test('REQ-090 forget() (его зовёт пакет FP-04 при каждой загрузке набора) очищает только кэш страницы: сохранённое на устройстве остаётся; без хранилища — прежнее поведение, forget стирает всё', () => {
  const st = fake_storage();
  const m = M.create_persisted_entry_memory(st);
  m.remember(ws_a, 'acc_cash');
  m.forget();
  assert.equal(m.get(ws_a), 'acc_cash', 'на устройстве остался');
  const plain = M.create_persisted_entry_memory(null);
  plain.remember(ws_a, 'acc_cash');
  assert.equal(plain.get(ws_a), 'acc_cash');
  plain.forget();
  assert.equal(plain.get(ws_a), null, 'без хранилища память страницы, как раньше');
  // заглушка, которая не хранит (getItem всегда null): тоже память страницы
  const stub = M.create_persisted_entry_memory({ getItem: () => null, setItem: () => {} });
  stub.remember(ws_a, 'acc_cash');
  assert.equal(stub.get(ws_a), 'acc_cash');
  stub.forget();
  assert.equal(stub.get(ws_a), null);
  // хранилище бросает исключения (приватный режим): страница работает
  const broken = M.create_persisted_entry_memory({ getItem: () => { throw new Error('нет'); }, setItem: () => { throw new Error('нет'); } });
  assert.doesNotThrow(() => broken.remember(ws_a, 'acc_cash'));
  assert.equal(broken.get(ws_a), 'acc_cash');
});

test('REQ-090 негодные значения не запоминаются; испорченное содержимое ключа игнорируется; записей не больше предела', () => {
  const st = fake_storage();
  const m = M.create_persisted_entry_memory(st);
  for (const bad of [null, undefined, 5, '', {}, 'a|b', 'x\ny', 'z'.repeat(200), '__proto__', 'constructor']) m.remember(ws_a, bad);
  assert.equal(st.m.has(M.ENTRY_MEMORY_KEY), false);
  assert.equal(m.get(ws_a), null);
  for (const raw of ['{не json', '[]', 'null', '{"v":2,"items":[["ws-a","acc_cash"]]}', '{"v":1,"items":"нет"}', '{"v":1,"items":[["ws-a"],[5,"x"],["ws-a","a|b"],["ws-a",{}]]}']) {
    st.m.set(M.ENTRY_MEMORY_KEY, raw);
    assert.equal(M.create_persisted_entry_memory(st).get(ws_a), null, raw);
  }
  st.m.set(M.ENTRY_MEMORY_KEY, '{"v":1,"items":[["ws-a","acc_cash"],["ws-a","acc_other"],["ws-b","acc_card"]]}');
  assert.equal(M.create_persisted_entry_memory(st).get(ws_a), 'acc_cash', 'первая запись рабочей области');
  const s2 = fake_storage();
  const m3 = M.create_persisted_entry_memory(s2);
  for (let i = 0; i < 40; i++) m3.remember({ workspace_id: 'w' + i }, 'acc' + i);
  assert.equal(JSON.parse(s2.m.get(M.ENTRY_MEMORY_KEY)).items.length, M.MAX_ENTRIES);
  assert.equal(M.create_persisted_entry_memory(s2).get({ workspace_id: 'w39' }), 'acc39');
  assert.equal(M.create_persisted_entry_memory(s2).get({ workspace_id: 'w0' }), null, 'старейшие вытеснены');
});

test('REQ-090 REQ-098 «Удалить все данные» (erase_all по префиксу runway) находит и стирает ключ; чужой ключ цел; удалённое не воскресает из кэша страницы', async () => {
  const st = fake_storage();
  st.m.set('portal-v9-theme', 'dark');
  const m = M.create_persisted_entry_memory(st);
  m.remember(ws_a, 'acc_cash');
  assert.ok(st.m.has(M.ENTRY_MEMORY_KEY));
  const receipt = await DA.erase_all({ today: () => '2026-10-23', storage: st, store: null }, {});
  assert.equal(receipt.erased, true, JSON.stringify(receipt));
  assert.equal(st.m.has(M.ENTRY_MEMORY_KEY), false, 'ключ стёрт');
  assert.equal(st.m.get('portal-v9-theme'), 'dark', 'чужое цело');
  assert.equal(m.get(ws_a), null, 'кэш страницы не воскрешает удалённое');
  assert.equal(M.create_persisted_entry_memory(st).get(ws_a), null);
  m.remember(ws_a, 'acc_card'); // новый ввод после удаления — новая запись
  assert.equal(M.create_persisted_entry_memory(st).get(ws_a), 'acc_card');
});

test('REQ-090 запомненный счёт берётся только если он открыт в текущем наборе, иначе — счёт последнего факта (entry.default_account_id)', () => {
  const ws = { as_of: '2026-10-04', accounts: [{ account_id: 'acc_main', liquidity: 'operating' }, { account_id: 'acc_old', liquidity: 'operating', closed_on: '2026-09-01' }], facts: [{ account_id: 'acc_main', date: '2026-10-01' }] };
  assert.equal(EN.default_account_id(ws, 'acc_old'), 'acc_main', 'закрытый счёт из памяти не берётся');
  assert.equal(EN.default_account_id(ws, 'нет_такого'), 'acc_main');
  assert.equal(EN.default_account_id(ws, 'acc_main'), 'acc_main');
  assert.equal(EN.default_account_id(ws, null), 'acc_main');
});

test('REQ-090 пакет FP-04: память счёта пакета — персистентная; без хранилища (Node) — память страницы', () => {
  const st = fake_storage();
  const deps = P4.make_deps({ lang: () => 'ru', get_ws: () => null, notify() {}, tr: (k) => k }, st);
  deps.memory.remember(ws_a, 'acc_cash');
  assert.ok(st.m.has(M.ENTRY_MEMORY_KEY));
  const none = P4.make_deps({ lang: () => 'ru', get_ws: () => null, notify() {}, tr: (k) => k }, null);
  none.memory.remember(ws_a, 'acc_cash');
  assert.equal(none.memory.get(ws_a), 'acc_cash');
  assert.ok(!fs.readFileSync(path.join(DEMO, 'entry_memory_store.mjs'), 'utf8').replace(/\/\/.*$/gm, '').includes('console.'));
});

// ═══ часть 2: настоящий app.mjs на заглушке DOM ══════════════════════════════════════════════════════════════════════════════

const ctx = ext.ctx;
const nav_button = (label) => find_all(byid.get('nav'), (n) => n.tagName === 'button' && n.textContent === label)[0];
const click = (n) => { assert.ok(n !== undefined, 'нет узла'); n.listeners.click[0](); };
const submit = (form) => form.listeners.submit[0]({ preventDefault() {} });

test('REQ-090 в настоящем app.mjs: «+ Факт» на втором счёте записывает его на устройство; после «перезагрузки» быстрый ввод предлагает этот счёт; «Удалить все данные» ключ стирает', async () => {
  assert.ok(ext.diagnostics().some((d) => d.pack === 'pack_fp04' && d.status === 'ok'));
  assert.equal(page_store.has(M.ENTRY_MEMORY_KEY), false, 'пока ничего не вводили — памяти на устройстве нет');
  const r = ctx.edit({ type: 'upsert_account', account: { account_id: 'acc_cash', name: 'Наличные', kind: 'cash', liquidity: 'operating', currency: 'EUR', exponent: 2, opened_on: '2026-01-01' } });
  assert.equal(r.ok, true, JSON.stringify(r));
  click(nav_button('+ Факт'));
  const form = byid.get('dlg-body').children[0];
  const account = find_all(form, (n) => n.attrs.id === 'entry-account')[0];
  assert.equal(account.value, 'acc_main', 'до первого ввода — счёт последнего факта');
  account.value = 'acc_cash';
  find_all(form, (n) => n.attrs.id === 'entry-amount')[0].value = '5,00';
  submit(form);
  assert.equal(ctx.get_ws().facts.at(-1).account_id, 'acc_cash');
  assert.deepEqual(JSON.parse(page_store.get(M.ENTRY_MEMORY_KEY)), { v: 1, items: [[G.workspace_id, 'acc_cash']] });
  // «перезагрузка»: новая память над тем же хранилищем помнит счёт, и он идёт первым в быстром вводе
  const fresh = M.create_persisted_entry_memory(globalThis.localStorage);
  assert.equal(fresh.get(ctx.get_ws()), 'acc_cash');
  assert.equal(EN.default_account_id(ctx.get_ws(), fresh.get(ctx.get_ws())), 'acc_cash');
  // следующая шторка открывается на этом счёте, хотя последний факт — на нём же; сменим последний факт на основной счёт и проверим, что берётся именно запомненный
  click(nav_button('Отменить'));
  assert.equal(ctx.get_ws().facts.at(-1).account_id, 'acc_main', 'факт отменён, память на устройстве осталась');
  click(nav_button('+ Факт'));
  const form2 = byid.get('dlg-body').children[0];
  assert.equal(find_all(form2, (n) => n.attrs.id === 'entry-account')[0].value, 'acc_cash', 'запомненный счёт предложен, хотя последний факт — на основном');
  // штатное удаление стирает ключ
  const receipt = await DA.erase_all({ today: () => '2026-10-23', storage: globalThis.localStorage, store: null }, {});
  assert.equal(receipt.erased, true, JSON.stringify(receipt));
  assert.equal(page_store.has(M.ENTRY_MEMORY_KEY), false);
  assert.equal(page_store.get('portal-v9-theme'), 'dark');
});
