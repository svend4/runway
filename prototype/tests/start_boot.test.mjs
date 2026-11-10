// start_boot.test.mjs — FP-10 в настоящем app.mjs на заглушке DOM: пакет pack_fp10 подхватывается манифестом, «Старт» и «Метрики» стоят в навигации, набор g001-empty выбирается
// в переключателе и открывает экран «Обзор» с текстом ov.empty и карточкой «Старт»; четыре шага и буфер доводят готовность до 4 общим путём записи; «Отменить» откатывает шаг мастера;
// метрики пишутся в localStorage под ключом runway-metrics/1, показываются целиком и стираются штатным «Удалить все данные» (FP-05) вместе с данными, чужие ключи целы.
// Заглушка DOM минимальная (без вёрстки): проверяется связка app.mjs ↔ ext.mjs ↔ пакет. Браузер, сеть и серверы не используются.

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
const body = new Node_('body');
globalThis.document = {
  createElement: (t) => new Node_(t),
  createElementNS: (ns, t) => new Node_(t, ns),
  createTextNode: (data) => ({ nodeType: 3, data }),
  // статические узлы страницы и (для проверки фокуса) любой элемент, который сейчас нарисован в #main
  getElementById: (id) => byid.get(id) ?? find_all(byid.get('main'), (n) => n.attrs.id === id)[0] ?? null,
  documentElement: new Node_('html'),
  head: new Node_('head'),
  body,
  title: '',
};
globalThis.window = { addEventListener: (t, fn) => { (listeners[t] ??= []).push(fn); }, scrollTo: () => {} };
globalThis.location = { hash: '' };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'ru-RU' }, configurable: true });

/** localStorage-заглушка: как настоящий (getItem/setItem/removeItem/key/length). */
const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.ResizeObserver = class { observe() {} };
const real_fetch = async (url) => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8')) });
globalThis.fetch = real_fetch;

// чужие данные того же localhost: «Удалить все данные» их не тронет
store.set('portal-v9-theme', 'dark');
store.set('nexus.save', '{"keep":1}');

const { ext } = await import(pathToFileURL(path.join(DEMO, 'ext.mjs')).href);
await import(pathToFileURL(path.join(DEMO, 'app.mjs')).href); // boot() запускается сам: в #app-title есть узел
await new Promise((r) => setTimeout(r, 700));

const MX = await import(pathToFileURL(path.join(DEMO, 'metrics.mjs')).href);
const DA = await import(pathToFileURL(path.join(DEMO, 'data_actions.mjs')).href);
const I18N = await import(pathToFileURL(path.join(DEMO, 'i18n.mjs')).href);
const N = (x) => String(x).replace(/[  ]/g, ' ');
const text_of = (id) => N(byid.get(id).textContent);
const main = () => byid.get('main');
const by_id = (id) => find_all(main(), (n) => n.attrs.id === id)[0];
const nav_link = (label) => find_all(byid.get('nav'), (n) => n.tagName === 'a' && n.textContent === label)[0];
const nav_button = (label) => find_all(byid.get('nav'), (n) => n.tagName === 'button' && n.textContent === label)[0];
const click = (n) => n.listeners.click[0]();
const ctx = ext.ctx;
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };
const choose_dataset = async (id) => {
  const select = find_all(byid.get('controls'), (n) => n.tagName === 'select' && n.attrs.id === 'ds-top')[0];
  await select.listeners.change[0]({ target: { value: id } });
};
const submit = (form_id, values = {}) => {
  for (const [id, v] of Object.entries(values)) by_id(id).value = v;
  const card = by_id('st-step');
  for (const fn of card.listeners.input ?? []) fn();
  return by_id(form_id).listeners.submit[0]({ preventDefault() {} });
};
const tick = () => new Promise((r) => setImmediate(r));

test('REQ-110 boot: пакет FP-10 подхвачен манифестом; «Старт» и «Метрики» стоят после экранов приложения; app.mjs пакет не называет', () => {
  assert.ok(ext.diagnostics().some((d) => d.pack === 'pack_fp10' && d.status === 'ok'), JSON.stringify(ext.diagnostics().filter((d) => d.pack === 'pack_fp10')));
  assert.deepEqual(ext.diagnostics().filter((d) => d.status === 'failed'), [], 'ни один пакет не упал');
  const links = find_all(byid.get('nav'), (n) => n.tagName === 'a').map((a) => a.textContent);
  assert.equal(links[0], 'Обзор', 'порядок экранов приложения прежний');
  assert.equal(links.at(-1), 'О программе', 'FP-12: «О программе» — последний раздел (order 180), «Метрики» (order 170) — перед ним');
  assert.equal(links.at(-2), 'Метрики');
  assert.ok(links.indexOf('Старт') > links.indexOf('Данные'), '«Старт» — после экранов приложения');
  const app_src = fs.readFileSync(path.join(DEMO, 'app.mjs'), 'utf8');
  assert.ok(!/pack_fp10|wizard|metrics\.mjs|start_template|v0\.mjs/.test(app_src), 'app.mjs не знает пакет поимённо');
  assert.ok(ext.has_view('start') && ext.has_view('metrics'));
});

test('REQ-110 ov.empty достижим из демо через g001-empty: набор в переключателе, «Обзор» показывает «Прогноз появится…» и карточку «Старт» со ссылкой на мастер; ошибок расчёта нет', async () => {
  const opts = find_all(find_all(byid.get('controls'), (n) => n.attrs.id === 'ds-top')[0], (n) => n.tagName === 'option').map((o) => [o.attrs.value, o.textContent]);
  assert.deepEqual(opts.at(-1), ['empty', 'G-001-empty — пустой, с нуля']);
  await choose_dataset('empty');
  const m = ctx.get_model();
  assert.equal(m.ctx.readiness.score, 0);
  assert.equal(ctx.get_ws().accounts.length, 0);
  await go('#overview');
  const t = N(main().textContent);
  assert.ok(t.includes(I18N.t('ru', 'ov.empty')), 'текст ov.empty показан: ' + t.slice(0, 200));
  assert.ok(find_all(main(), (n) => n.attrs.role === 'alert').length === 0, 'нет плашек ошибок');
  const card = find_all(main(), (n) => n.className === 'card start-card')[0];
  assert.ok(card !== undefined, 'карточка «Старт» в «Обзоре»');
  const link = find_all(card, (n) => n.tagName === 'a')[0];
  assert.equal(link.attrs.href, '#start');
  assert.ok(text_of('summary').includes('Не учтено:'), 'в шапке перечислено недостающее (причины движка)');
  // набор «с нуля» открывается и в английском интерфейсе
  find_all(byid.get('controls'), (n) => n.attrs.lang === 'en')[0].listeners.click[0]();
  assert.ok(N(main().textContent).includes(I18N.t('en', 'ov.empty')));
  find_all(byid.get('controls'), (n) => n.attrs.lang === 'ru')[0].listeners.click[0]();
});

test('REQ-110 REQ-029 мастер в настоящем приложении: четыре шага и буфер на g001-empty доводят готовность до 4, прогноз появляется на s = 3, «Обзор» перестаёт быть пустым и карточка «Старт» исчезает', async () => {
  await go('#start');
  assert.equal(by_id('view-title').textContent, 'Старт: первый прогноз');
  assert.equal(by_id('st-step-title').textContent, 'Шаг 1. Счёт и остаток');
  const score = () => ctx.get_model().ctx.readiness.score;
  submit('st-form-acc', { 'st-acc-name': 'Мой счёт', 'st-acc-balance': '4 000,00' });
  assert.equal(score(), 1);
  assert.equal(ctx.get_ws().accounts[0].name, 'Мой счёт');
  assert.match(text_of('summary'), /4 000,00 €/, 'шапка показывает остаток по якорю');
  for (const [n, a, d] of [['Связь', '25', '2026-10-09'], ['Музыка', '15', '2026-10-12'], ['Зал', '20', '2026-10-20']]) submit('st-form-obl', { 'st-obl-name': n, 'st-obl-amount': a, 'st-obl-date': d });
  assert.equal(score(), 2);
  assert.ok(!N(by_id('st-forecast').textContent).includes('Прогноз готов'));
  click(by_id('st-next'));
  submit('st-form-inc', { 'st-inc-name': 'Клиент', 'st-inc-amount': '2790', 'st-inc-date': '2026-11-05', 'st-inc-repeat': 'once', 'st-inc-delay': '' });
  assert.equal(score(), 3);
  assert.ok(N(by_id('st-forecast').textContent).includes('Прогноз готов: готовность данных 3 из 4.'));
  click(by_id('st-next'));
  submit('st-form-day', { 'st-day-name': '', 'st-day-amount': '100', 'st-day-period': 'W' });
  assert.equal(score(), 4);
  submit('st-form-buf', { 'st-buf-amount': '500' });
  assert.equal(ctx.get_model().ctx.buffer_minor, 50000);
  assert.ok(find_all(by_id('st-forecast'), (n) => n.tagName === 'a' && n.attrs.href === '#buy').length === 1, 'вердикт доступен');
  // обзор рисует графики и числа, пустой плашки больше нет, карточки «Старт» нет
  await go('#overview');
  const t = N(main().textContent);
  assert.ok(!t.includes(I18N.t('ru', 'ov.empty')));
  assert.equal(find_all(main(), (n) => n.className === 'card start-card').length, 0);
  assert.ok(t.includes('Самая узкая точка') || t.includes('Узкая точка') || /узкая точка/i.test(t), 'обзор показывает узкую точку');
  // и вопрос «могу ли я купить» отвечает вердиктом из слов словаря
  await go('#buy');
  const verdict = find_all(main(), (n) => /^verdict verdict-/.test(n.className)).map((n) => n.textContent.trim().replace(/^\S+\s/, ''));
  assert.equal(verdict.length >= 1, true);
  assert.ok(['выдерживает', 'впритык', 'хрупко', 'не хватает'].some((w) => verdict.join(' ').includes(w)), verdict.join(' | '));
});

test('TST-16 REQ-090 «Отменить» откатывает шаг мастера целиком (счёт и остаток — одним действием), «Вернуть» возвращает; мастер перерисовывается по состоянию', async () => {
  await choose_dataset('empty');
  await go('#start');
  submit('st-form-acc', { 'st-acc-name': 'Счёт', 'st-acc-balance': '100' });
  assert.equal(ctx.get_ws().accounts.length, 1);
  assert.equal(ctx.get_ws().anchors.length, 1);
  assert.equal(nav_button('Отменить').hasAttribute('disabled'), false);
  click(nav_button('Отменить'));
  assert.equal(ctx.get_ws().accounts.length, 0, 'счёт убран');
  assert.equal(ctx.get_ws().anchors.length, 0, 'и якорь: шаг — одно действие');
  assert.equal(ctx.get_model().ctx.readiness.score, 0);
  assert.equal(by_id('st-step-title').textContent, 'Шаг 1. Счёт и остаток', 'мастер снова на первом шаге');
  click(nav_button('Вернуть'));
  assert.equal(ctx.get_ws().accounts.length, 1);
  assert.equal(ctx.get_model().ctx.readiness.score, 1);
});

test('REQ-185 метрики в настоящем приложении: ключ runway-metrics/1 в localStorage, пакет по схеме без сумм и дат, экран «Метрики» показывает файл целиком, скачивание — по кнопке тем же текстом', async () => {
  assert.ok(store.has(MX.METRICS_KEY), 'метрики записаны в localStorage');
  const stored = JSON.parse(store.get(MX.METRICS_KEY));
  const { v: _v, enabled: _e, anchor_day: _a, ...pkg } = stored;
  assert.deepEqual(MX.validate_package(pkg), []);
  assert.ok(pkg.sessions >= 1);
  assert.ok(pkg.steps.length >= 1 && pkg.steps.every((s) => ['saved', 'skipped'].includes(s.outcome)));
  assert.ok(pkg.counters.rules_saved >= 1 && pkg.counters.accounts_saved >= 1);
  assert.ok(pkg.first_forecast !== null, 'первый прогноз отмечен: готовность прошла путь 2 → 3 после шага мастера');
  assert.ok(pkg.verdict_ready !== null, 'вердикт доступен после буфера');
  const raw = JSON.stringify(pkg);
  for (const s of ['4000', '400000', '279000', '2790', 'Связь', 'Музыка', 'Клиент', 'Мой счёт', '2026-']) assert.ok(!raw.includes(s), 'в метриках нет: ' + s);
  // экран
  await go('#metrics');
  assert.equal(by_id('view-title').textContent, 'Метрики на устройстве');
  const shown = by_id('mx-file').textContent;
  assert.deepEqual(JSON.parse(shown), pkg, 'показан весь файл');
  assert.ok(shown.startsWith('{\n') && shown.endsWith('}\n'));
  const blobs = [];
  const real = { Blob: globalThis.Blob, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  globalThis.Blob = class { constructor(parts) { this.text = parts.join(''); blobs.push(this); } };
  URL.createObjectURL = () => 'blob:mx';
  URL.revokeObjectURL = () => {};
  try {
    assert.equal(blobs.length, 0);
    click(by_id('mx-download'));
    assert.equal(blobs.length, 1);
    assert.equal(blobs[0].text, shown, 'скачивается то, что показано');
  } finally {
    globalThis.Blob = real.Blob; URL.createObjectURL = real.create; URL.revokeObjectURL = real.revoke;
  }
});

test('REQ-185 REQ-098 «Удалить все данные» (erase_all FP-05) стирает ключ метрик, а чужие ключи общего localhost остаются; экран «Метрики» сообщает об остановке, новые действия метрики не воскрешают', async () => {
  assert.ok(store.has(MX.METRICS_KEY) && store.has('portal-v9-theme') && store.has('nexus.save'));
  const receipt = await DA.erase_all({ today: () => '2026-10-09', storage: globalThis.localStorage, store: null }, {});
  assert.equal(receipt.erased, true, JSON.stringify(receipt));
  assert.ok(!store.has(MX.METRICS_KEY), 'метрики стёрты вместе с данными');
  assert.equal(store.get('portal-v9-theme'), 'dark', 'чужое цело');
  assert.equal(store.get('nexus.save'), '{"keep":1}');
  assert.deepEqual([...store.keys()].filter((k) => k.startsWith('runway')), []);
  await go('#metrics');
  assert.ok(text_of('main').includes(I18N.t('ru', 'start.mx_halted')), 'экран сообщает об остановке');
  // следующее действие пользователя (шаг мастера) метрики не воскрешает
  await choose_dataset('empty');
  await go('#start');
  submit('st-form-acc', { 'st-acc-name': 'После удаления', 'st-acc-balance': '5' });
  assert.ok(!store.has(MX.METRICS_KEY), 'ключ метрик не появился снова');
});

test('REQ-111 TST-58 «Старт» и «Метрики» в английском интерфейсе рисуются из каталога EN без русских слов; смена набора данных возвращает мастер на первый шаг; фокус-заголовок экрана', async () => {
  await choose_dataset('empty');
  find_all(byid.get('controls'), (n) => n.attrs.lang === 'en')[0].listeners.click[0]();
  await go('#start');
  assert.equal(by_id('view-title').textContent, 'Start: your first forecast');
  assert.equal(by_id('st-step-title').textContent, 'Step 1. Account and balance');
  assert.ok(!/[А-Яа-яЁё]/.test(main().textContent), main().textContent.match(/[^\n]{0,30}[А-Яа-яЁё][^\n]{0,20}/)?.[0]);
  const nav = find_all(byid.get('nav'), (n) => n.tagName === 'a').map((a) => a.textContent);
  assert.equal(nav[0], 'Overview');
  assert.ok(nav.includes('Start'));
  assert.equal(nav.at(-1), 'About', 'FP-12: «About» — последний раздел');
  assert.equal(nav.at(-2), 'Metrics');
  await go('#metrics');
  assert.equal(by_id('view-title').textContent, 'Metrics on this device');
  assert.ok(!/[А-Яа-яЁё]/.test(main().textContent));
  find_all(byid.get('controls'), (n) => n.attrs.lang === 'ru')[0].listeners.click[0]();
  // смена набора: мастер снова на первом шаге, а не на последнем шаге прежнего набора
  await go('#start');
  submit('st-form-acc', { 'st-acc-name': 'Счёт', 'st-acc-balance': '1' });
  assert.equal(by_id('st-step-title').textContent, 'Шаг 2. Обязательства');
  await choose_dataset('g001');
  await choose_dataset('empty');
  await go('#start');
  assert.equal(by_id('st-step-title').textContent, 'Шаг 1. Счёт и остаток');
  await tick();
});
