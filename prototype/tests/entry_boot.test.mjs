// entry_boot.test.mjs — FP-04 в настоящем app.mjs: пакет подхватывается манифестом (pack_fp04.mjs), кнопки «+», «Сверить остаток», «Отменить» стоят
// в навигации через слот реестра, запись идёт общим путём (ctx.set_ws → пересчёт страницы → журнал → перерисовка), плашка свежести исчезает после сверки.
// Заглушка DOM минимальная (без вёрстки): проверяется связка app.mjs ↔ ext.mjs ↔ пакет, а не внешний вид. Браузер не используется.
// Тест не зависит от других пакетов: проверяется только то, что относится к FP-04 (другие пакеты в манифесте могут быть или отсутствовать).
// Набор данных подменён заглушкой fetch: G-001 с датой расчёта 2026-10-26 (якорь 10-04 → возраст 22 дня → плашка «block», TST-57).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(HERE, '..', 'demo');

class Node_ {
  constructor(tag, ns) {
    this.nodeType = 1; this.tagName = tag; this.ns = ns ?? null; this.attrs = {}; this.children = []; this.listeners = {}; this.className = '';
    this._text = ''; this._value = ''; this._sel = null; this.open = false;
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
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() {}
  querySelectorAll() { return []; }
  walk(fn) { fn(this); for (const c of this.children) if (c.nodeType === 1) c.walk(fn); }
}
const byid = new Map();
for (const id of ['app-title', 'app-sub', 'skip', 'controls', 'nav', 'summary', 'main', 'footer', 'live', 'dlg', 'dlg-title', 'dlg-close', 'dlg-body']) byid.set(id, new Node_(id === 'dlg' ? 'dialog' : 'div'));
const listeners = {};
globalThis.document = {
  createElement: (t) => new Node_(t),
  createElementNS: (ns, t) => new Node_(t, ns),
  createTextNode: (data) => ({ nodeType: 3, data }),
  getElementById: (id) => byid.get(id) ?? null,
  documentElement: new Node_('html'),
  head: new Node_('head'),
  body: new Node_('body'),
  title: '',
};
globalThis.window = { addEventListener: (t, fn) => { (listeners[t] ??= []).push(fn); }, scrollTo: () => {} };
globalThis.location = { hash: '' };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'ru-RU' }, configurable: true });
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.ResizeObserver = class { observe() {} };
globalThis.fetch = async (url) => {
  const ws = JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8'));
  ws.as_of = '2026-10-26'; // возраст якоря 10-04 — 22 дня: плашка «block»
  return { ok: true, json: async () => ws };
};

const { ext } = await import(pathToFileURL(path.join(DEMO, 'ext.mjs')).href);
await import(pathToFileURL(path.join(DEMO, 'app.mjs')).href); // document.getElementById('app-title') !== null → boot() запускается сам
await new Promise((r) => setTimeout(r, 600)); // boot асинхронный: пакеты, набор данных, boot-хук

const N = (x) => String(x).replace(/[  ]/g, ' ');
const text_of = (id) => N(byid.get(id).textContent);
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const nav_button = (label) => find_all(byid.get('nav'), (n) => n.tagName === 'button' && n.textContent === label)[0];
const click = (n) => n.listeners.click[0]();
const submit = (form) => form.listeners.submit[0]({ preventDefault() {} });
const ctx = ext.ctx;

test('boot: пакет FP-04 подхвачен манифестом; кнопки «+ Факт», «Сверить остаток», «Отменить», «Вернуть» — в навигации (слот nav.actions), app.mjs пакет не называет', () => {
  assert.ok(ext.diagnostics().some((d) => d.pack === 'pack_fp04' && d.status === 'ok'), JSON.stringify(ext.diagnostics().filter((d) => d.pack === 'pack_fp04')));
  const items = find_all(byid.get('nav'), (n) => n.className === 'nav-action');
  assert.ok(items.length >= 3, 'кнопки пакета — пункты li.nav-action');
  for (const label of ['+ Факт', 'Сверить остаток', 'Отменить', 'Вернуть']) assert.ok(nav_button(label) !== undefined, label);
  assert.equal(nav_button('Отменить').hasAttribute('disabled'), true, 'отменять пока нечего');
  assert.equal(nav_button('Сверить остаток').className, 'btn primary', 'данные устарели — кнопка выделена');
});

test('TST-57 REQ-028 в настоящем app.mjs: плашка «block» (22 дня) → «Сверить остаток» → число → Enter → плашка исчезает; три действия; шапка показывает названный остаток', () => {
  assert.ok(ctx.get_model().ctx.anchor_status.level === 'block');
  assert.match(text_of('summary'), /Данных мало для вердикта. Сверьте остаток./, 'плашка block нарисована');
  const before_banners = find_all(byid.get('summary'), (n) => n.className === 'banner short').length;
  assert.ok(before_banners >= 1);
  let actions = 0;
  click(nav_button('Сверить остаток')); actions += 1;
  const form = byid.get('dlg-body').children[0];
  const amount = find_all(form, (n) => n.attrs.id === 'anchor-amount')[0];
  amount.value = '3 950,00'; actions += 1;
  amount.listeners.input[0]();
  assert.match(text_of('dlg-body'), /расхождение −50,00 €/, 'найденное расхождение показано до подтверждения');
  submit(form); actions += 1;
  assert.equal(actions, 3);
  assert.equal(ctx.get_model().ctx.anchor_status.level, 'fresh');
  assert.equal(find_all(byid.get('summary'), (n) => n.className === 'banner short').length, 0, 'плашка block исчезла со страницы');
  assert.match(text_of('summary'), /3 950,00 €/, 'в шапке — остаток по якорю');
  assert.match(text_of('dlg-body'), /Плашка о давности данных снята/);
  assert.equal(nav_button('Сверить остаток').className, 'btn', 'кнопка снова обычная');
  assert.equal(nav_button('Отменить').hasAttribute('disabled'), false, 'сверку можно отменить');
});

test('TST-16 REQ-090 в настоящем app.mjs: «Отменить» возвращает плашку и хэш входов расчёта; «Вернуть» — сверку; журнал дописывается', () => {
  const j = ctx.journal;
  const n = j.length;
  const hash_after = ctx.get_model().ctx.inputs_hash;
  click(nav_button('Отменить'));
  assert.equal(ctx.get_model().ctx.anchor_status.level, 'block', 'плашка вернулась');
  assert.notEqual(ctx.get_model().ctx.inputs_hash, hash_after);
  assert.ok(find_all(byid.get('summary'), (n_) => n_.className === 'banner short').length >= 1);
  assert.ok(j.length > n, 'в журнал дописаны записи отмены');
  assert.equal(nav_button('Вернуть').hasAttribute('disabled'), false);
  click(nav_button('Вернуть'));
  assert.equal(ctx.get_model().ctx.inputs_hash, hash_after, 'после «Вернуть» входы расчёта те же');
  assert.equal(ctx.get_model().ctx.anchor_status.level, 'fresh');
});

test('TST-58 REQ-090 в настоящем app.mjs: «+ Факт» → «12,50» → Enter записывает расход на дату расчёта; ошибка суммы — текст в шторке; перерисовка страницы', () => {
  const ws0 = ctx.get_ws();
  click(nav_button('+ Факт'));
  const dlg = byid.get('dlg');
  assert.equal(dlg.open, true);
  const form = byid.get('dlg-body').children[0];
  const amount = find_all(form, (n) => n.attrs.id === 'entry-amount')[0];
  amount.value = 'много';
  submit(form);
  assert.equal(text_of('dlg-body').includes('Не похоже на сумму. Образец записи: 1 234,50.'), true);
  assert.equal(ctx.get_ws(), ws0, 'данные не тронуты');
  amount.value = '12,50';
  submit(form);
  const ws1 = ctx.get_ws();
  assert.equal(ws1.facts.length, ws0.facts.length + 1);
  const f = ws1.facts.at(-1);
  assert.deepEqual([f.amount_minor, f.date, f.account_id], [-1250, '2026-10-26', 'acc_main']);
  assert.equal(dlg.open, false);
  const days = find_all(byid.get('nav'), (n) => n.tagName === 'button' && n.textContent === 'Отменить')[0];
  click(days);
  assert.equal(ctx.get_ws().facts.length, ws0.facts.length, 'отмена убрала факт');
});

test('REQ-090 замена набора целиком (reason restore: «Продолжить с сохранённого», «Восстановить из файла») очищает «Отменить / Вернуть»: старые единицы не доживают до чужого состояния', () => {
  click(nav_button('+ Факт'));
  const form = byid.get('dlg-body').children[0];
  const amount = find_all(form, (n) => n.attrs.id === 'entry-amount')[0];
  amount.value = '7,00';
  submit(form);
  assert.equal(nav_button('Отменить').hasAttribute('disabled'), false, 'после записи отменять есть что');
  const r = ctx.set_ws(ctx.get_ws(), { reason: 'restore' });
  assert.equal(r.ok, true);
  assert.equal(nav_button('Отменить').hasAttribute('disabled'), true, 'набор заменён целиком — отменять нечего');
  assert.equal(nav_button('Вернуть').hasAttribute('disabled'), true, 'и возвращать тоже');
});
