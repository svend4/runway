// settings_boot.test.mjs — FP-03 в настоящем app.mjs: пакет подхватывается манифестом (pack_fp03.mjs), экран #settings открывается по маршруту,
// карточки «Запас хода» и «Готовность данных» стоят в «Обзоре», запись настроек идёт общим путём (ctx.set_ws → пересчёт страницы → журнал → перерисовка).
// Заглушка DOM минимальная (без вёрстки): проверяется связка app.mjs ↔ ext.mjs ↔ пакет, а не внешний вид. Браузер не используется.
// Тест не зависит от других пакетов: проверяется только то, что относится к FP-03 (другие пакеты в манифесте могут быть или отсутствовать).

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
const real_fetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const file = fileURLToPath(url);
  return { ok: true, json: async () => JSON.parse(fs.readFileSync(file, 'utf8')) };
};

const { ext } = await import(pathToFileURL(path.join(DEMO, 'ext.mjs')).href);
await import(pathToFileURL(path.join(DEMO, 'app.mjs')).href); // getElementById('app-title') !== null → boot() запускается сам
await new Promise((r) => setTimeout(r, 500)); // boot асинхронный: манифест пакетов, набор данных, boot-хуки

const text_of = (id) => byid.get(id).textContent;
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };
const submit = (id) => { const f = find_all(byid.get('main'), (n) => n.attrs.id === id)[0]; assert.ok(f !== undefined, 'нет формы ' + id); f.listeners.submit[0]({ preventDefault() {} }); };
const field = (id) => find_all(byid.get('main'), (n) => n.attrs.id === id)[0];

test('boot: манифест подхватил pack_fp03, навигация содержит «Настройки» (#settings), набор G-001 загружен', () => {
  const diag = ext.diagnostics().filter((d) => d.pack === 'pack_fp03');
  assert.deepEqual(diag.map((d) => d.status), ['ok'], JSON.stringify(ext.diagnostics()));
  const links = find_all(byid.get('nav'), (n) => n.tagName === 'a').map((a) => [a.attrs.href, a.textContent]);
  assert.ok(links.some(([href, t]) => href === '#settings' && t === 'Настройки'), JSON.stringify(links));
  assert.match(text_of('summary'), /буфер 500,00/);
});

test('REQ-023 REQ-029 «Обзор»: карточки «Запас хода в днях» и «Готовность данных» стоят в слоте overview.cards рядом со штатными блоками', async () => {
  await go('#overview');
  const main = text_of('main');
  assert.match(main, /Запас хода в днях/);
  assert.match(main, /денег на счетах хватает на весь горизонт — 57 дней/); // FP-48: число совпадает с «Горизонт, дней» в «Настройках» и с шапкой
  assert.match(main, /Готовность данных/);
  assert.match(main, /4 из 4 — полный/);
  assert.match(main, /Вердикт «можно ли купить» и «можно потратить» доступны\./);
  assert.ok(find_all(byid.get('main'), (n) => n.className === 'card fp03-runway').length === 1);
  assert.ok(find_all(byid.get('main'), (n) => n.className === 'card fp03-ready').length === 1);
  assert.match(main, /Узкая точка|узкая точка|Минимум/i, 'штатные карточки обзора на месте');
});

test('REQ-026 TST-59 маршрут #settings: экран открывается, семь форм (с «Сегодня» и «Валютой решения»), фокус-заголовок; запись буфера — общим путём, шапка и журнал следуют, подтверждение показано', async () => {
  await go('#settings');
  assert.match(text_of('main'), /^Настройки/);
  assert.equal(find_all(byid.get('main'), (n) => n.tagName === 'form').length, 7);
  const ctx = ext.ctx;
  const n0 = ctx.journal.length;
  const hash0 = ctx.get_model().ctx.inputs_hash;
  field('set-buffer').value = '490';
  submit('settings-buffer');
  assert.equal(ctx.get_ws().params.buffer_minor, 49000);
  assert.notEqual(ctx.get_model().ctx.inputs_hash, hash0, 'пересчёт страницей');
  assert.match(text_of('summary'), /буфер 490,00/, 'шапка перерисована');
  assert.equal(ctx.journal.length, n0 + 1);
  assert.equal(ctx.journal.at(n0).type, 'params.set');
  assert.match(text_of('main'), /Сейчас задан: 490,00/, 'экран перерисован с новым значением');
  assert.match(text_of('main'), /Сохранено\./, 'подтверждение — после перерисовки');
  // отказ ввода: данные и журнал прежние
  const hash1 = ctx.get_model().ctx.inputs_hash;
  field('set-buffer').value = 'много';
  submit('settings-buffer');
  assert.equal(ctx.get_model().ctx.inputs_hash, hash1);
  assert.equal(ctx.journal.length, n0 + 1);
  assert.match(text_of('main'), /Не удалось прочитать число/);
});

test('REQ-024 REQ-112 в настоящем приложении: сдвиг «если хуже» пересчитывает режим; формат чисел — отдельной правкой, суммы в данных прежние; в обзоре буфер не задан → карточка зовёт в настройки', async () => {
  await go('#settings');
  const ctx = ext.ctx;
  field('set-delay').value = '0';
  submit('settings-horizon');
  const a = ctx.get_model().ctx;
  assert.deepEqual(a.series.worse.trough, a.series.plan.trough, 'при сдвиге 0 «если хуже» совпадает с планом');
  assert.match(text_of('main'), /сдвинуто на 0 дней/);
  const before = JSON.stringify(ctx.get_ws().anchors);
  field('set-nf-preset').value = 'dot_comma';
  field('set-nf-date').value = 'iso';
  submit('settings-format');
  assert.deepEqual(ctx.get_ws().number_format, { decimal: ',', thousands: '.', date: 'iso' });
  assert.equal(JSON.stringify(ctx.get_ws().anchors), before, 'суммы и даты данных не менялись');
  field('set-buffer').value = '';
  submit('settings-buffer');
  assert.equal(ctx.get_ws().params.buffer_minor, null);
  await go('#overview');
  const main = text_of('main');
  assert.match(main, /Буфер не задан: расчёт ведётся с буфером 0\./);
  assert.match(main, /Вердикт и «можно потратить» скрыты: не задан буфер\./);
  const link = find_all(byid.get('main'), (n) => n.tagName === 'a' && n.attrs.href === '#settings');
  assert.ok(link.length >= 1, 'ссылка на настройки из карточки');
});

test('смена набора данных: карточки пересчитываются на G-001-gap (запас хода 22 дня, 26 октября) без перезапуска', async () => {
  await go('#overview');
  const sel = find_all(byid.get('controls'), (n) => n.tagName === 'select')[0];
  sel.listeners.change[0]({ target: { value: 'gap' } });
  await new Promise((r) => setTimeout(r, 100));
  const main = text_of('main');
  assert.match(main, /денег на счетах хватает на 22 дня; ниже нуля — с 26 октября/);
});

test('завершение: заглушки сняты', () => {
  globalThis.fetch = real_fetch;
  assert.ok(true);
});
