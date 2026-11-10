// error_report_view.test.mjs — FP-22, REQ-124 (TST-46): блок «Сообщить об ошибке» и глобальные ошибки страницы в безопасной записи.
// Часть 1 — модуль без DOM (latest_error, make_report, copy_text): отчёт — ровно поля белого списка, без согласия не строится, код берётся из записи журнала, сообщение, стек и
// пользовательские тексты в отчёт не попадают.
// Часть 2 — настоящий app.mjs на заглушке DOM: блок стоит на экране «Данные»; без согласия текст не показан; по согласию показан ЦЕЛИКОМ; кнопка копирует в буфер ровно этот текст;
// сетевых обращений нет ни одного (fetch, XMLHttpRequest, sendBeacon подменены счётчиками); глобальные ошибки (error, unhandledrejection) попадают в журнал приложения только как
// code, n и engine_version — без текста сообщения, стека и имён файлов; английский интерфейс без русских слов.
// Браузер, сеть и серверы не используются. Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/error_report_view.test.mjs

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
const nav_stub = { language: 'ru-RU' };
Object.defineProperty(globalThis, 'navigator', { value: nav_stub, configurable: true });
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.ResizeObserver = class { observe() {} };
const net = { calls: 0 }; // любое сетевое обращение страницы считается: после загрузки набора данных их быть не должно
const boot_fetch = async (url) => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8')) });
globalThis.fetch = boot_fetch;

const { ext } = await import(pathToFileURL(path.join(DEMO, 'ext.mjs')).href);
await import(pathToFileURL(path.join(DEMO, 'app.mjs')).href);
await new Promise((r) => setTimeout(r, 700));

const E = await import('../engine/index.mjs');
const V = await import(pathToFileURL(path.join(DEMO, 'error_report_view.mjs')).href);
const L = await import(pathToFileURL(path.join(DEMO, 'log.mjs')).href);
const CATALOG = (await import(pathToFileURL(path.join(DEMO, 'i18n', 'errrep.mjs')).href)).default;

const N = (x) => String(x).replace(/[\u00a0\u202f]/g, ' ');
const main = () => byid.get('main');
const by_id = (id) => find_all(main(), (n) => n.attrs.id === id)[0];
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };
const tick = () => new Promise((r) => setTimeout(r, 15));
const ctx = ext.ctx;
const V0 = E.ENGINE_VERSION;

// ═══ часть 1: модуль без DOM ═════════════════════════════════════════════════════════════════════════════════════════════════

test('TST-46 REQ-124 latest_error: берётся последняя запись уровня error; info и warn не считаются; записей нет — null', () => {
  const lg = L.create_logger();
  assert.equal(V.latest_error(lg.entries()), null);
  lg.info('store_open', { n: 1 });
  lg.warn('file_quarantine', { n: 2 });
  assert.equal(V.latest_error(lg.entries()), null);
  lg.error('store_failed', { code: 'store_failed', n: 3 });
  lg.warn('after', { n: 4 });
  lg.error('write_failed', { code: 'write_failed', n: 5, ms: 12 });
  const e = V.latest_error(lg.entries());
  assert.equal(e.event, 'write_failed');
  assert.equal(e.n, 5);
});

test('TST-46 REQ-124 make_report: без согласия отчёта нет; по согласию — ровно поля белого списка в порядке id, n, ms, code, engine_version; название события, лишние поля и тексты в отчёт не входят', () => {
  const lg = L.create_logger();
  lg.error('write_failed', { id: 'evt~000010', n: 47, ms: 12, code: 'store_failed', engine_version: '0.1.0', amount_minor: -4730, note: 'аренда' });
  const entry = V.latest_error(lg.entries());
  assert.deepEqual(V.make_report(entry, false), { ok: false, reason: 'consent_required' });
  assert.deepEqual(V.make_report(entry, undefined), { ok: false, reason: 'consent_required' });
  const r = V.make_report(entry, true);
  assert.equal(r.ok, true);
  assert.equal(r.text, 'id: evt~000010\nn: 47\nms: 12\ncode: store_failed\nengine_version: 0.1.0');
  assert.deepEqual(Object.keys(r.fields).sort(), ['code', 'engine_version', 'id', 'ms', 'n']);
  for (const s of ['write_failed', 'аренд', '4730', 'amount']) assert.ok(!r.text.includes(s), 'в отчёте нет: ' + s);
  assert.equal(L.report_text(r.fields), r.text);
  // записи нет: в отчёте только версия движка (FP-48: строки `code` нет — блок обещает «только версию движка»)
  assert.equal(V.make_report(null, true).text, `engine_version: ${V0}`);
  // запись без кода (событие без code)
  lg.clear();
  lg.error('write_failed', { n: 1 });
  assert.equal(V.make_report(V.latest_error(lg.entries()), true, '9.9.9').text, 'n: 1\ncode: E_UNKNOWN\nengine_version: 9.9.9');
  // длинный идентификатор срезан до 32 знаков
  lg.clear();
  lg.error('write_failed', { id: 'q'.repeat(90), code: 'E_X' });
  assert.ok(V.make_report(V.latest_error(lg.entries()), true).fields.id.length <= L.LOG_MAX_STRING);
});

test('TST-46 REQ-124 copy_text: буфер принял — true; буфера нет или он отказал — false, исключение наружу не выходит', async () => {
  const put = [];
  assert.equal(await V.copy_text({ clipboard: () => ({ writeText: async (t) => { put.push(t); } }) }, 'текст'), true);
  assert.deepEqual(put, ['текст']);
  assert.equal(await V.copy_text({ clipboard: () => null }, 'x'), false);
  assert.equal(await V.copy_text({ clipboard: () => ({}) }, 'x'), false);
  assert.equal(await V.copy_text({ clipboard: () => ({ writeText: async () => { throw new Error('NotAllowedError'); } }) }, 'x'), false);
  assert.equal(await V.copy_text({ clipboard: () => { throw new Error('boom'); } }, 'x'), false);
});

test('TST-46 REQ-124 в модуле блока нет сетевых вызовов, ссылок «отправить», почтовых адресов, консоли и хранилища: отчёт можно только показать и скопировать', () => {
  const raw = fs.readFileSync(path.join(DEMO, 'error_report_view.mjs'), 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
  for (const bad of ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'mailto:', 'href', 'localStorage', 'sessionStorage', 'indexedDB', 'console.', 'innerHTML', 'eval(', 'new Function', 'Date.', 'Math.random']) {
    assert.ok(!code.includes(bad), `error_report_view.mjs: ${bad}`);
  }
  assert.ok(/writeText\(/.test(code), 'единственный выход — буфер обмена');
  assert.ok(!/<a\b|'a'/.test(code), 'ссылок нет');
});

test('TST-56 REQ-124 каталог errrep: RU и EN, ключи используются литералами в коде блока, плейсхолдеры одинаковы, в RU русские буквы, в EN их нет', () => {
  assert.deepEqual(Object.keys(CATALOG.ru).sort(), Object.keys(CATALOG.en).sort());
  const code = fs.readFileSync(path.join(DEMO, 'error_report_view.mjs'), 'utf8');
  for (const k of Object.keys(CATALOG.ru)) {
    assert.ok(code.includes(`'${k}'`), `ключ ${k} не используется литералом`);
    assert.match(CATALOG.ru[k], /[А-Яа-яЁё]/, k);
    assert.ok(!/[А-Яа-яЁё]/.test(CATALOG.en[k]), 'EN без русских букв: ' + k);
    assert.deepEqual([...CATALOG.ru[k].matchAll(/{(\w+)}/g)].map((m) => m[1]).sort(), [...CATALOG.en[k].matchAll(/{(\w+)}/g)].map((m) => m[1]).sort(), k);
  }
});

// ═══ глобальные ошибки: log.install_global_handlers ═══════════════════════════════════════════════════════════════════════════

/** Цель событий-заглушка: addEventListener / removeEventListener и ручной запуск. */
function fake_target() {
  const map = {};
  return {
    map,
    addEventListener: (t, fn) => { (map[t] ??= []).push(fn); },
    removeEventListener: (t, fn) => { map[t] = (map[t] ?? []).filter((x) => x !== fn); },
    fire: (t, ev) => { for (const fn of [...(map[t] ?? [])]) fn(ev); },
  };
}

test('TST-46 REQ-124 global_error_code: код движка из закрытого списка, стандартное имя ошибки, иначе общий код; текст сообщения и свойства в код не попадают', () => {
  assert.equal(L.global_error_code(Object.assign(new Error('аренда -4730'), { code: 'E_SCHEMA' }), 'js_error'), 'E_SCHEMA');
  assert.equal(L.global_error_code(Object.assign(new Error('x'), { code: 'E_NO_RATE' }), 'js_error'), 'E_NO_RATE');
  assert.equal(L.global_error_code(Object.assign(new Error('x'), { code: 'E_ЗАРПЛАТА_4730' }), 'js_error'), 'js_error', 'неизвестный код — по имени типа');
  assert.equal(L.global_error_code(new TypeError('секрет 4730'), 'js_error'), 'js_typeerror');
  assert.equal(L.global_error_code(new RangeError('x'), 'js_rejection'), 'js_rangeerror');
  assert.equal(L.global_error_code({ name: 'Зарплата', code: 'аренда' }, 'js_error'), 'js_error');
  assert.equal(L.global_error_code('аренда 4730 EUR', 'js_rejection'), 'js_rejection');
  assert.equal(L.global_error_code(null, 'js_error'), 'js_error');
  assert.equal(L.global_error_code(undefined, 'js_rejection'), 'js_rejection');
  assert.equal(L.global_error_code({ get code() { throw new Error('геттер'); } }, 'js_error'), 'js_error');
  for (const c of ['js_typeerror', 'js_error', 'js_rejection', 'js_domexception', 'js_runwayerror']) assert.match(c, /^[A-Za-z][A-Za-z0-9_.:-]{0,31}$/);
});

test('TST-46 REQ-124 install_global_handlers: error и unhandledrejection пишутся в журнал только как code, n и engine_version; строгий логгер не возражает (полей вне белого списка нет)', () => {
  const lg = L.create_logger({ strict: true });
  const t = fake_target();
  const off = L.install_global_handlers(t, lg, { engine_version: '0.1.0' });
  const err = Object.assign(new Error('Не удалось записать «аренда» -4730 EUR'), { code: 'E_SCHEMA', ctx: { note: 'аренда' }, stack: 'at C:\\Users\\stefan\\runway\\x.mjs:1' });
  t.fire('error', { error: err, message: 'аренда -4730', filename: 'C:/Users/stefan/runway/x.mjs', lineno: 12, colno: 3 });
  t.fire('unhandledrejection', { reason: new TypeError('секрет 4730') });
  t.fire('unhandledrejection', { reason: 'просто строка с текстом пользователя' });
  t.fire('error', {}); // событие без ошибки (ресурс не загрузился)
  const e = lg.entries();
  assert.deepEqual(e.map((x) => ({ ...x })), [
    { level: 'error', event: 'global_error', code: 'E_SCHEMA', n: 1, engine_version: '0.1.0' },
    { level: 'error', event: 'global_rejection', code: 'js_typeerror', n: 2, engine_version: '0.1.0' },
    { level: 'error', event: 'global_rejection', code: 'js_rejection', n: 3, engine_version: '0.1.0' },
    { level: 'error', event: 'global_error', code: 'js_error', n: 4, engine_version: '0.1.0' },
  ]);
  const raw = JSON.stringify(e);
  for (const s of ['аренд', '4730', 'Users', 'stefan', 'x.mjs', 'секрет', 'стока', 'at ']) assert.ok(!raw.includes(s), 'в записях нет: ' + s);
  assert.equal(lg.dropped(), 0);
  off();
  assert.equal((t.map.error ?? []).length + (t.map.unhandledrejection ?? []).length, 0, 'подписка снята');
  t.fire('error', { error: new Error('x') });
  assert.equal(lg.entries().length, 4, 'после снятия записей нет');
});

test('TST-46 REQ-124 install_global_handlers: повторная подписка той же цели ничего не добавляет; цели без addEventListener — пустое снятие; предел записей за сеанс; сбой журнала страницу не ломает', () => {
  const lg = L.create_logger();
  const t = fake_target();
  const off1 = L.install_global_handlers(t, lg, {});
  const off2 = L.install_global_handlers(t, lg, {});
  assert.equal(off1, off2);
  assert.equal(t.map.error.length, 1);
  t.fire('error', { error: new Error('x') });
  assert.equal(lg.entries().length, 1);
  assert.equal('engine_version' in lg.entries()[0], false, 'версия движка не задана — поля нет');
  off1();
  for (const bad of [null, undefined, 5, {}, { addEventListener: 3 }]) assert.equal(typeof L.install_global_handlers(bad, lg, {}), 'function');
  const small = L.create_logger();
  const t2 = fake_target();
  L.install_global_handlers(t2, small, { max: 3 });
  for (let i = 0; i < 10; i++) t2.fire('error', { error: new Error('x') });
  assert.equal(small.entries().length, 3, 'поток одинаковых сбоев не вытесняет прочие записи кольца');
  const broken = { error() { throw new Error('журнал сломан'); } };
  const t3 = fake_target();
  L.install_global_handlers(t3, broken, {});
  assert.doesNotThrow(() => t3.fire('error', { error: new Error('x') }));
  assert.doesNotThrow(() => t3.fire('unhandledrejection', { get reason() { throw new Error('геттер события'); } }));
});

// ═══ часть 2: настоящий app.mjs на заглушке DOM ══════════════════════════════════════════════════════════════════════════════

test('TST-46 REQ-124 boot: пакет FP-22 подхвачен; глобальные обработчики window подписаны; блок «Сообщить об ошибке» стоит на экране «Данные»; без согласия текста отчёта нет', async () => {
  assert.ok(ext.diagnostics().some((d) => d.pack === 'pack_fp22' && d.status === 'ok'), JSON.stringify(ext.diagnostics().filter((d) => d.pack === 'pack_fp22')));
  assert.equal((listeners.error ?? []).length, 1, 'error подписан один раз');
  assert.equal((listeners.unhandledrejection ?? []).length, 1);
  await go('#data');
  const block = by_id('er-block');
  assert.ok(block !== undefined, 'блок на экране «Данные»');
  assert.equal(N(by_id('er-title').textContent), 'Сообщить об ошибке');
  assert.ok(N(by_id('er-state').textContent).startsWith('Ошибок в журнале приложения нет'));
  assert.equal(by_id('er-text'), undefined, 'без согласия текста отчёта нет');
  assert.equal(by_id('er-copy'), undefined, 'и кнопки копирования нет');
  assert.equal(N(by_id('er-consent-hint').textContent), 'Без согласия текст отчёта не составляется и не показывается.');
  assert.ok(N(by_id('er-no-send').textContent).includes('Приложение ничего не отправляет'));
  assert.equal(by_id('er-consent').attrs.type, 'checkbox');
  assert.equal(by_id('er-consent').hasAttribute('checked'), false);
  assert.ok(find_all(block, (n) => n.tagName === 'label' && n.attrs.for === 'er-consent').length === 1, 'у флажка есть подпись');
});

test('TST-46 REQ-124 по согласию показан весь текст отчёта (пока ошибок нет — только версия движка, без строки code); снятие согласия убирает текст; узел перестраивается на месте, фокус остаётся на флажке', async () => {
  const box = by_id('er-block');
  const agree = by_id('er-consent');
  agree.checked = true;
  agree.listeners.change[0]();
  assert.equal(by_id('er-block'), box, 'блок тот же узел: перестроены дети, страница не перерисована');
  assert.equal(by_id('er-text').textContent, `engine_version: ${V0}`);
  assert.ok(by_id('er-copy') !== undefined);
  assert.equal(by_id('er-consent').focused, true, 'фокус возвращён на флажок');
  assert.equal(N(by_id('er-consent-hint').textContent), 'Полный текст отчёта — ровно то, что попадёт в буфер обмена:');
  by_id('er-consent').checked = false;
  by_id('er-consent').listeners.change[0]();
  assert.equal(by_id('er-text'), undefined);
  assert.equal(by_id('er-copy'), undefined);
  by_id('er-consent').checked = true;
  by_id('er-consent').listeners.change[0]();
  assert.ok(by_id('er-text') !== undefined);
});

test('TST-46 REQ-124 глобальные ошибки страницы попадают в журнал приложения и в отчёт только как код и номер; сообщение, стек, имя файла и пользовательский текст — нет', async () => {
  const before = L.log.entries().length;
  const err = Object.assign(new Error('Не удалось записать «Аренда» -4730 EUR'), { code: 'E_RULE_INVALID', stack: 'Error: x\n at C:\\Users\\stefan\\runway\\prototype\\demo\\app.mjs:1:1' });
  for (const fn of listeners.error) fn({ error: err, message: 'Аренда -4730', filename: 'C:/Users/stefan/runway/prototype/demo/app.mjs', lineno: 1 });
  for (const fn of listeners.unhandledrejection) fn({ reason: new TypeError('Зарплата 4730') });
  const added = L.log.entries().slice(before).map((x) => ({ ...x }));
  assert.deepEqual(added, [
    { level: 'error', event: 'global_error', code: 'E_RULE_INVALID', n: 1, engine_version: V0 },
    { level: 'error', event: 'global_rejection', code: 'js_typeerror', n: 2, engine_version: V0 },
  ]);
  const raw = JSON.stringify(L.log.entries());
  for (const s of ['Аренд', '4730', 'Users', 'stefan', 'app.mjs', 'Зарплата']) assert.ok(!raw.includes(s), 'в журнале нет: ' + s);
  // экран перестроен страницей: последняя ошибка — отказ типа TypeError; согласие сохранилось, отчёт обновился
  await go('#data');
  assert.ok(N(by_id('er-state').textContent).includes('код js_typeerror'), by_id('er-state').textContent);
  assert.equal(by_id('er-text').textContent, `n: 2\ncode: js_typeerror\nengine_version: ${V0}`);
});

test('TST-46 REQ-124 кнопка копирует в буфер ровно показанный текст и больше ничего не делает: сетевых обращений 0; ответ буфера обновляет страницу, а не отсоединённый узел', async () => {
  const sent = [];
  const real = { fetch: globalThis.fetch, xhr: globalThis.XMLHttpRequest, beacon: nav_stub.sendBeacon };
  globalThis.fetch = async (...a) => { net.calls += 1; sent.push(['fetch', ...a]); throw new Error('сеть не нужна'); };
  globalThis.XMLHttpRequest = class { constructor() { net.calls += 1; sent.push(['xhr']); } };
  nav_stub.sendBeacon = (...a) => { net.calls += 1; sent.push(['beacon', ...a]); return true; };
  const copied = [];
  nav_stub.clipboard = { writeText: async (t) => { copied.push(t); } };
  try {
    await go('#data');
    const shown = by_id('er-text').textContent;
    const old_btn = by_id('er-copy');
    old_btn.listeners.click[0]();
    await tick();
    assert.deepEqual(copied, [shown], 'в буфере ровно показанный текст');
    assert.equal(N(by_id('er-copy-status').textContent), 'Текст отчёта скопирован в буфер обмена. Приложение его никуда не отправляло.');
    assert.equal(by_id('er-copy-status').attrs.role, 'status');
    assert.notEqual(by_id('er-copy'), old_btn, 'страница перерисована общим redraw, замыкание старого узла не трогалось');
    assert.equal(by_id('er-copy').focused, true, 'фокус возвращён на кнопку после перерисовки');
    assert.equal(net.calls, 0, 'ни одного сетевого обращения: ' + JSON.stringify(sent));
    // буфер отказал
    nav_stub.clipboard = { writeText: async () => { throw new Error('NotAllowedError'); } };
    by_id('er-copy').listeners.click[0]();
    await tick();
    assert.equal(N(by_id('er-copy-status').textContent), 'Буфер обмена недоступен: текст выше можно выделить и скопировать вручную.');
    // буфера нет совсем
    delete nav_stub.clipboard;
    by_id('er-copy').listeners.click[0]();
    await tick();
    assert.ok(N(by_id('er-copy-status').textContent).startsWith('Буфер обмена недоступен'));
    assert.equal(copied.length, 1);
    assert.equal(net.calls, 0);
  } finally {
    globalThis.fetch = real.fetch; globalThis.XMLHttpRequest = real.xhr; if (real.beacon === undefined) delete nav_stub.sendBeacon; else nav_stub.sendBeacon = real.beacon;
    delete nav_stub.clipboard;
  }
});

test('TST-46 TST-58 REQ-124 английский интерфейс: блок рисуется из каталога EN без русских слов; режим «только чтение» блок не отключает (он ничего не записывает)', async () => {
  find_all(byid.get('controls'), (n) => n.attrs.lang === 'en')[0].listeners.click[0]();
  await go('#data');
  const block = by_id('er-block');
  assert.equal(by_id('er-title').textContent, 'Report an error');
  assert.ok(!/[А-Яа-яЁё]/.test(block.textContent), block.textContent.match(/[^\n]{0,30}[А-Яа-яЁё][^\n]{0,20}/)?.[0]);
  assert.ok(by_id('er-text') !== undefined && by_id('er-copy').textContent === 'Copy to clipboard');
  find_all(byid.get('controls'), (n) => n.attrs.lang === 'ru')[0].listeners.click[0]();
  await go('#data');
  assert.equal(N(by_id('er-title').textContent), 'Сообщить об ошибке');
  assert.equal(ctx.read_only(), null);
});
