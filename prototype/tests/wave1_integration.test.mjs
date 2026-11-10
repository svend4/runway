// wave1_integration.test.mjs — интеграция волны 1 (интегратор): хуки общих файлов app.mjs / ext.mjs работают в настоящем app.mjs с настоящими пакетами
// pack_fp03…pack_fp09: хук fmt (REQ-112), слот banner.actions (REQ-028, ≤ 3 действий), числа в W_RESERVE_BEHIND (REQ-069), плашка «не учтено» по причинам
// readiness.reasons (REQ-029), слот overview.cards при готовности ниже порога, «почему» у обеих строк вердикта (REQ-104), загрузка всех пакетов без сбоев (TST-59).
// Заглушка DOM — та же, что в ext_boot.test.mjs (проверяется связка, а не вёрстка). Браузер не используется.

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
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.ResizeObserver = class { observe() {} };
const real_fetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const file = fileURLToPath(url);
  return { ok: true, json: async () => JSON.parse(fs.readFileSync(file, 'utf8')) };
};

const { ext } = await import(pathToFileURL(path.join(DEMO, 'ext.mjs')).href);
const { h } = await import(pathToFileURL(path.join(DEMO, 'dom.mjs')).href);

// экран-проба: даёт тесту ctx реестра; регистрируется до запуска приложения, как это сделал бы пакет
let ctx_seen = null;
ext.register_i18n('wone', { ru: { 'wone.nav': 'Проба' }, en: { 'wone.nav': 'Probe' } });
ext.register_view({ id: 'wone_probe', title_key: 'wone.nav', order: 900, render: (ctx) => { ctx_seen = ctx; return h('div', { class: 'view', text: 'экран-проба для теста интеграции' }); } });

await import(pathToFileURL(path.join(DEMO, 'app.mjs')).href); // document.getElementById('app-title') !== null → boot() запускается сам
await new Promise((r) => setTimeout(r, 600)); // boot асинхронный: пакеты, набор данных, boot-хуки

const text_of = (id) => byid.get(id).textContent;
function find_all(root, pred) {
  const out = [];
  root.walk((n) => { if (pred(n)) out.push(n); });
  return out;
}
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };
await go('#wone_probe');
const base_ws = ctx_seen.get_ws();

test('TST-59 интеграция: все пакеты манифеста загружены без сбоев и без отсутствующих файлов; в навигации есть экраны пакетов', () => {
  const diag = ext.diagnostics();
  const failed = diag.filter((d) => d.status === 'failed' || d.status === 'absent');
  assert.deepEqual(failed, [], 'сбои загрузки: ' + JSON.stringify(failed));
  const ok = diag.filter((d) => d.status === 'ok').map((d) => d.pack);
  for (const p of ['pack_fp03', 'pack_fp04', 'pack_fp05', 'pack_fp06', 'pack_fp07', 'pack_fp08', 'pack_fp09']) assert.ok(ok.includes(p), p + ' не зарегистрирован');
  const hashes = find_all(byid.get('nav'), (n) => n.tagName === 'a').map((a) => a.attrs.href);
  for (const v of ['#settings', '#forms', '#scenario_lab', '#store', '#ladder', '#debts', '#golden', '#promises', '#report', '#payload']) assert.ok(hashes.includes(v), 'нет вкладки ' + v + ' среди ' + hashes.join(' '));
  assert.equal(new Set(hashes).size, hashes.length, 'вкладки не повторяются');
});

test('TST-59 интеграция: каждый экран приложения и пакетов рисуется без сообщения о сбое («Раздел не открылся»)', async () => {
  const hashes = find_all(byid.get('nav'), (n) => n.tagName === 'a').map((a) => a.attrs.href);
  for (const hash of hashes) {
    await go(hash);
    assert.doesNotMatch(text_of('main'), /не открылся/, hash + ': ' + text_of('main').slice(0, 160));
    assert.ok(text_of('main').length > 20, hash + ': пустой экран');
  }
  assert.deepEqual(ext.diagnostics().filter((d) => d.status === 'failed'), [], 'сбоев блоков и хуков нет');
  await go('#wone_probe');
});

test('REQ-112 хук fmt: ws.number_format действует на шапку приложения, без настройки — формат языка', () => {
  assert.match(text_of('summary'), /4[\s ]?000,00/, 'формат языка (ru): ' + text_of('summary').slice(0, 160));
  const r = ctx_seen.edit({ type: 'set_number_format', number_format: { decimal: '.', thousands: ',' } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(text_of('summary'), /4,000\.00/, 'после настройки «1,234.50» шапка показывает 4,000.00: ' + text_of('summary').slice(0, 160));
  assert.ok(ctx_seen.fmt().money(123450).includes('1,234.50'), 'ctx.fmt() — тот же форматтер');
  const back = ctx_seen.edit({ type: 'set_number_format', number_format: null });
  assert.equal(back.ok, true);
  assert.doesNotMatch(text_of('summary'), /4,000\.00/, 'настройка снята — формат языка');
});

test('REQ-028 слот banner.actions: кнопка «Сверить остаток» стоит в самой плашке «данные устарели» (и в плашке block); при свежих данных в шапке кнопок нет', () => {
  assert.equal(ctx_seen.set_ws({ ...base_ws, as_of: '2026-10-14' }).ok, true);
  const banners = find_all(byid.get('summary'), (n) => n.tagName === 'p' && /banner/.test(n.className));
  const with_btn = banners.filter((p) => find_all(p, (n) => n.tagName === 'button' && /Сверить/.test(n.textContent)).length === 1);
  assert.equal(with_btn.length, 1, 'ровно одна плашка с кнопкой сверки: ' + banners.map((b) => b.textContent).join(' | '));
  assert.equal(ctx_seen.set_ws({ ...base_ws, as_of: '2026-11-20' }).ok, true);
  const blocked = find_all(byid.get('summary'), (n) => n.tagName === 'p' && /banner short/.test(n.className));
  assert.ok(blocked.some((p) => find_all(p, (n) => n.tagName === 'button').length === 1), 'кнопка и в плашке block');
  assert.equal(ctx_seen.set_ws(base_ws).ok, true);
  assert.equal(find_all(byid.get('summary'), (n) => n.tagName === 'button').length, 0, 'свежие данные: в шапке кнопок нет');
});

test('REQ-069 W_RESERVE_BEHIND: текст несёт число и сумму пропущенных взносов (RU: 1 на сумму 120,00 €)', () => {
  assert.equal(ctx_seen.set_ws({ ...base_ws, as_of: '2026-11-20' }).ok, true);
  assert.match(text_of('summary'), /Взносов не подтверждено: 1 на сумму 120,00/);
  assert.equal(ctx_seen.set_ws(base_ws).ok, true);
  assert.doesNotMatch(text_of('summary'), /Взносов не подтверждено/);
});

test('REQ-029 плашка «Не учтено» строится из readiness.reasons; при готовности ниже q1 слот overview.cards всё равно показан', async () => {
  assert.equal(ctx_seen.set_ws({ ...base_ws, rules: base_ws.rules.slice(0, 1) }).ok, true);
  assert.match(text_of('summary'), /Не учтено: повседневные траты\./, 'причина одна — прежний текст');
  assert.equal(ctx_seen.set_ws({ ...base_ws, rules: [], streams: [] }).ok, true);
  const t = text_of('summary');
  assert.match(t, /Не учтено: нет дохода в ближайшие 45 дней, повседневные траты\./, 'причины называются своими словами: ' + t);
  await go('#overview');
  assert.match(text_of('main'), /Готовность данных/, 'карточка готовности (слот overview.cards) видна и при пустом прогнозе: ' + text_of('main').slice(0, 200));
  assert.equal(ctx_seen.set_ws(base_ws).ok, true);
  await go('#wone_probe');
});

test('REQ-104 «почему» стоит у обеих строк «Могу ли я это купить?» (по плану и если хуже)', async () => {
  await go('#buy');
  const amount = find_all(byid.get('main'), (n) => n.tagName === 'input' && n.attrs.id === 'buy-amount')[0];
  assert.ok(amount !== undefined, 'поле суммы нарисовано');
  const date = find_all(byid.get('main'), (n) => n.tagName === 'input' && n.attrs.id === 'buy-date')[0];
  date.value = '2026-10-10'; // заглушка не копирует атрибут value в свойство
  amount.value = '100';
  amount.listeners.input[0]();
  const why = find_all(byid.get('main'), (n) => n.tagName === 'button' && /^почему\?$/.test(n.textContent));
  assert.ok(why.length >= 2, 'кнопок «Почему» в ответе: ' + why.length + ' · ' + text_of('main').slice(0, 300));
  await go('#wone_probe');
});

test('завершение: заглушки сняты', () => {
  globalThis.fetch = real_fetch;
  assert.ok(true);
});
