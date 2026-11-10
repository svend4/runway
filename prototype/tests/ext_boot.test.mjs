// ext_boot.test.mjs — дымовой запуск демо на заглушке DOM (FP-01): boot() читает набор данных, регистрирует хуки, рисует навигацию из реестра
// и экран пакета по маршруту #<id>; слоты, хук show_why и общий путь записи (ctx.edit) работают в настоящем app.mjs.
// Заглушка DOM — минимальная (без вёрстки): проверяется связка app.mjs ↔ ext.mjs, а не внешний вид. Браузер не используется.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(HERE, '..', 'demo');

// ── заглушка DOM ────────────────────────────────────────────────────────────────────────────────────────────────────

class Node_ {
  constructor(tag, ns) {
    this.nodeType = 1; this.tagName = tag; this.ns = ns ?? null; this.attrs = {}; this.children = []; this.listeners = {}; this.className = '';
    this._text = ''; this.value = ''; this.open = false;
  }
  get textContent() { return this.children.length === 0 ? this._text : this.children.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
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
globalThis.requestAnimationFrame = () => 0; // график рисуется по кадру: в заглушке кадров нет, проверяется связка, а не вёрстка
globalThis.cancelAnimationFrame = () => {};
globalThis.ResizeObserver = class { observe() {} };
const real_fetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const file = fileURLToPath(url);
  return { ok: true, json: async () => JSON.parse(fs.readFileSync(file, 'utf8')) };
};

const EXT = await import(pathToFileURL(path.join(DEMO, 'ext.mjs')).href);
const { h } = await import(pathToFileURL(path.join(DEMO, 'dom.mjs')).href);
const ext = EXT.ext;

// пакет «из реестра»: экран, блоки в слотах, хук show_why — регистрируем ДО запуска, как это сделал бы pack_fpNN.mjs
ext.register_i18n('smk', { ru: { 'smk.nav': 'Дымовой экран', 'smk.hello': 'Привет из пакета', 'smk.card': 'Карточка пакета', 'smk.why': 'Пояснение пакета' }, en: { 'smk.nav': 'Smoke view', 'smk.hello': 'Hello from a pack', 'smk.card': 'Pack card', 'smk.why': 'Pack note' } });
let ctx_seen = null;
ext.register_view({ id: 'smoke', title_key: 'smk.nav', order: 35, render: (ctx) => { ctx_seen = ctx; return h('div', { class: 'view' }, h('h2', { id: 'view-title', tabindex: '-1', text: ctx.tr('smk.hello') })); } });
for (const slot of ['overview.cards', 'reserves.sections', 'data.sections', 'waves.actions', 'assistant.extras', 'nav.actions']) {
  ext.register_slot_item(slot, { id: 'smk_card', render: (ctx) => h('section', { class: 'card smk', text: ctx.tr('smk.card') + ' · ' + slot }) });
}
ext.register_hook('show_why', (ctx, mode) => h('p', { class: 'smk-why', text: ctx.tr('smk.why') + ' ' + mode }));
let boot_hook = 0;
ext.register_hook('boot', async (ctx) => { boot_hook += 1; assert.notEqual(ctx.get_ws(), null, 'к моменту boot-хука набор данных загружен'); });

const APP = await import(pathToFileURL(path.join(DEMO, 'app.mjs')).href); // document.getElementById('app-title') !== null → boot() запускается сам
await new Promise((r) => setTimeout(r, 400)); // boot асинхронный: пакеты, набор данных, boot-хук

const text_of = (id) => byid.get(id).textContent;
function find_all(root, pred) {
  const out = [];
  root.walk((n) => { if (pred(n)) out.push(n); });
  return out;
}

test('boot: страница нарисована, набор G-001 загружен, boot-хук вызван один раз; навигация построена из реестра с экраном пакета и кнопкой слота nav.actions', () => {
  assert.equal(boot_hook, 1);
  assert.match(text_of('app-title'), /Runway/);
  const links = find_all(byid.get('nav'), (n) => n.tagName === 'a').map((a) => [a.attrs.href, a.textContent]);
  // Экраны приложения и заглушки — точно и в прежнем порядке; реальные пакеты (pack_fp03…09) вправе добавлять свои вкладки.
  const hashes = links.map((l) => l[0]);
  const base = ['#overview', '#buy', '#waves', '#smoke', '#reserves', '#scenarios', '#feed', '#assistant', '#data'];
  assert.deepEqual(hashes.filter((h) => base.includes(h)), base, 'экраны приложения и заглушка — в прежнем порядке');
  const extra = hashes.filter((h) => !base.includes(h));
  assert.ok(extra.every((h) => /^#[a-z0-9_-]+$/.test(h)), 'вкладки реальных пакетов: ' + extra.join(', '));
  assert.equal(links[hashes.indexOf('#smoke')][1], 'Дымовой экран', 'подпись экрана пакета — из его каталога строк');
  assert.equal(links[0][1], 'Обзор', 'подписи экранов приложения — как раньше');
  assert.ok(find_all(byid.get('nav'), (n) => n.className === 'nav-action').length >= 1, 'кнопка слота nav.actions (заглушка; реальные пакеты могут добавить свои)');
  assert.ok(text_of('summary').includes('4000,00') || text_of('summary').length > 20, 'сводка нарисована');
  assert.match(text_of('main'), /Карточка пакета · overview\.cards/, 'слот overview.cards на экране «Обзор»');
});

test('route: хэш #smoke открывает экран пакета с ctx; неизвестный хэш оставляет прежний экран; слоты других экранов появляются на своих экранах', async () => {
  const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };
  await go('#smoke');
  assert.equal(text_of('main'), 'Привет из пакета');
  assert.ok(ctx_seen !== null && typeof ctx_seen.edit === 'function' && typeof ctx_seen.get_model === 'function');
  assert.ok(ctx_seen.get_model().ctx.inputs_hash.length === 64, 'ctx.get_model() — модель страницы');
  assert.equal(ctx_seen.mode(), 'worse');
  assert.equal(typeof ctx_seen.fmt().money, 'function');
  await go('#нет-такого');
  assert.equal(text_of('main'), 'Привет из пакета', 'неизвестный маршрут не меняет экран');
  for (const [hash, slot] of [['#reserves', 'reserves.sections'], ['#data', 'data.sections'], ['#waves', 'waves.actions'], ['#assistant', 'assistant.extras']]) {
    await go(hash);
    assert.match(text_of('main'), new RegExp('Карточка пакета · ' + slot.replace('.', '\\.')), slot);
  }
  await go('#overview');
});

test('show_why: диалог «Почему» получает блоки хука пакета (и при пустом, и при обычном объяснении)', async () => {
  const buttons = find_all(byid.get('main'), (n) => n.tagName === 'button' && /почему/i.test(n.textContent));
  assert.ok(buttons.length >= 1, 'кнопка «Почему» на обзоре');
  buttons[0].listeners.click[0]();
  const body = byid.get('dlg-body');
  assert.ok(find_all(body, (n) => n.className === 'smk-why').length === 1, 'блок пакета в диалоге');
  assert.match(body.textContent, /Пояснение пакета (plan|worse)/);
});

test('ctx.edit в настоящем app.mjs: правка пересчитывает модель и перерисовывает страницу; отказанная правка ничего не меняет', async () => {
  const before = text_of('summary');
  const n0 = ctx_seen.journal.length; // журнал создаётся при первом обращении и дальше следует за правками
  const model_hash = ctx_seen.get_model().ctx.inputs_hash;
  const r = ctx_seen.edit({ type: 'set_param', key: 'buffer_minor', value: 80000 });
  assert.equal(r.ok, true);
  assert.notEqual(ctx_seen.get_model().ctx.inputs_hash, model_hash, 'пересчёт: другой inputs_hash');
  assert.equal(ctx_seen.get_ws().params.buffer_minor, 80000);
  assert.notEqual(text_of('summary'), before, 'шапка перерисована (буфер изменился)');
  const hash2 = ctx_seen.get_model().ctx.inputs_hash;
  const bad = ctx_seen.edit({ type: 'add_fact', fact: { event_id: 'tx-future', account_id: 'acc_main', date: '2026-10-05', amount_minor: -1 } });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'E_FUTURE_POSTED');
  assert.equal(ctx_seen.get_model().ctx.inputs_hash, hash2);
  // правка, которую принимает ws_edit, но отвергает пересчёт страницы: откат к прежней рабочей области
  const ws = ctx_seen.get_ws();
  const r3 = ctx_seen.set_ws({ ...ws, params: { ...ws.params, horizon_days: -1 } });
  assert.equal(r3.ok, false);
  assert.equal(ctx_seen.get_ws(), ws, 'рабочая область прежняя');
  assert.equal(ctx_seen.get_model().ctx.inputs_hash, hash2, 'модель прежняя');
  assert.ok(n0 > 40, 'журнал создан из набора: ' + n0);
  assert.equal(ctx_seen.journal.length, n0 + 1, 'принятая правка — одна запись; отказанные — ни одной');
  assert.equal(ctx_seen.journal.at(n0).type, 'params.set');
});

test('смена набора данных (ext.reset): журнал пересобирается, подписчики получают adopt', async () => {
  const seen = [];
  ctx_seen.subscribe((i) => seen.push(i.reason));
  const sel = find_all(byid.get('controls'), (n) => n.tagName === 'select')[0];
  assert.ok(sel !== undefined);
  sel.listeners.change[0]({ target: { value: 'low' } });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(seen, ['adopt']);
  assert.equal(ctx_seen.get_ws().anchors.at(-1).amount_minor, 220000, 'набор low загружен');
  assert.equal(ctx_seen.journal.events().find((e) => e.type === 'anchor.set' && e.payload.anchor_id === 'anc-g001-1004').payload.amount_minor, 220000);
});

test('завершение: заглушки сняты', () => {
  globalThis.fetch = real_fetch;
  assert.ok(true);
});
