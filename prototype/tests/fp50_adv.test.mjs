// fp50_adv.test.mjs — состязательная проверка FP-50 (RISK-22, разбор матрицы часов и поясов): мастер импорта при управляемом воркере и выбор файла,
// чей ответ пришёл после перестройки страницы. Правило 10 пакета FP-18: ответ асинхронной работы (Worker, таймер, чтение файла) рисует ЖИВОЙ экран
// через общий redraw_live, а не через замыкание узла, с которого начали. Для чтения файла этого не было: D-1 (CSV), D-2 (профиль), D-3 (журнал hledger)
// рисовали результат в отсоединённый узел. Исправлено в demo/import_wizard.mjs (pick_csv, pick_profile, pick_hl); отметки todo сняты, названия не менялись.
// Воркер здесь управляется тестом (ответ — по команде `deliver()`), поэтому ожидание идёт по состоянию экрана (опрос), а не по фиксированному времени.
// Заглушка DOM — как в fp18_adv.test.mjs; настоящий app.mjs.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/fp50_adv.test.mjs

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
globalThis.fetch = async (url) => {
  const file = fileURLToPath(url);
  return { ok: true, json: async () => JSON.parse(fs.readFileSync(file, 'utf8')) };
};

// ── воркер под управлением теста: запросы копятся в очереди, ответ уходит только по `deliver()` (протокол — как у настоящего воркера) ──
const W = await import(pathToFileURL(path.join(DEMO, 'import_worker.mjs')).href);
const workers = [];
class ManualWorker {
  constructor(url) {
    // расчётный воркер в тестах не нужен: клиент расчёта считает на главном потоке, когда создание воркера падает (как без `Worker`)
    if (String(url).includes('calc_worker')) throw new Error('в тестах расчёт идёт на главном потоке');
    this.url = String(url); this.queue = []; this.onmessage = null; workers.push(this);
  }
  postMessage(msg) { this.queue.push(structuredClone(msg)); }
  terminate() { this.queue.length = 0; }
  /** Ответить на самый ранний запрос так, как ответил бы воркер разбора. */
  deliver() {
    const msg = this.queue.shift();
    assert.ok(msg !== undefined, 'в воркер не уходил запрос');
    for (const r of W.split_reply(W.handle_message(structuredClone(msg)))) this.onmessage?.({ data: structuredClone(r) });
  }
}
globalThis.Worker = ManualWorker;
const last_worker = () => workers[workers.length - 1];

const { ext } = await import(pathToFileURL(path.join(DEMO, 'ext.mjs')).href);
const M = await import(pathToFileURL(path.join(DEMO, 'import_model.mjs')).href);
await import(pathToFileURL(path.join(DEMO, 'app.mjs')).href);
await new Promise((r) => setTimeout(r, 500));

const enc = (s) => new TextEncoder().encode(s);
const text_of = (id) => byid.get(id).textContent;
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const by_attr = (k, v) => find_all(byid.get('main'), (n) => n.attrs[k] === v)[0];
const by_text = (tag, txt) => find_all(byid.get('main'), (n) => n.tagName === tag && n.textContent === txt)[0];
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
/** Ждать условия опросом (каждые 10 мс), не дольше `ms`; `true`, если условие выполнилось. */
async function until(pred, ms = 10000) {
  const t = performance.now();
  while (!pred()) { if (performance.now() - t > ms) return false; await settle(10); }
  return true;
}
const click = async (node) => { assert.ok(node !== undefined, 'нет элемента'); node.listeners.click[0]({ preventDefault() {} }); await settle(); };

/** Выбрать файл в поле `id`. Чтение можно задержать: `gate` — промис, после которого отдаётся содержимое (как медленный диск). */
async function pick(id, name, bytes, gate = null) {
  const input = by_attr('id', id);
  assert.ok(input !== undefined, 'нет поля файла ' + id);
  const buf = () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  input.files = [{ name, size: bytes.length, arrayBuffer: async () => { if (gate !== null) await gate; return buf(); } }];
  input.listeners.change[0]({});
  await settle();
}

/** Вернуть мастер к первому шагу вкладки «CSV» — как пользователь: вкладка, затем «Другой файл» (до трёх раз). */
async function fresh_wizard() {
  await go('#data');
  const tab = by_attr('id', 'import-tab-csv');
  if (tab !== undefined && tab.attrs['aria-pressed'] !== 'true') await click(tab);
  for (let i = 0; i < 3; i++) {
    const again = by_text('button', 'Другой файл');
    if (again === undefined) break;
    await click(again);
  }
}

/** Задержка чтения: промис и функция, которая его открывает. */
function gate() { let open = null; const p = new Promise((r) => { open = r; }); return { p, open }; }

function big_bank_file() {
  const rows = ['Date,Description,Amount,Currency'];
  for (let i = 0; i < 3300; i++) rows.push(`2026-0${1 + (i % 9)}-${String(1 + (i % 28)).padStart(2, '0')},"Покупка №${i % 313}, касса ${i % 17}",-${1 + (i % 90)}.${String(i % 100).padStart(2, '0')},EUR`);
  return enc(rows.join('\n') + '\n');
}
const SMALL_CSV = 'Date,Description,Amount,Currency\n2026-10-01,Кофе,-3.50,EUR\n2026-10-02,Книги,-12.00,EUR\n';
const HL_JOURNAL = '2026-10-01 Кофе\n    expenses:food  3.50 EUR\n    assets:cash\n';

test('FP-50 мастер импорта: выбор файла без перестройки страницы — шаг «колонки» на живом экране сразу (нормальный путь)', async () => {
  await fresh_wizard();
  await pick('import-file', 'norm.csv', enc(SMALL_CSV));
  assert.ok(by_attr('id', 'import-check') !== undefined, 'шаг «колонки» виден');
  assert.equal(by_attr('id', 'import-file'), undefined, 'поля выбора файла уже нет');
});

test('FP-50 мастер импорта, управляемый воркер: запись данных во время проверки — после ответов экран показывает отчёт по новым данным, баннер погашен', async () => {
  const ctx = ext.ctx;
  await fresh_wizard();
  await pick('import-file', 'год.csv', big_bank_file());
  assert.equal(by_attr('id', 'import-profile').value, 'csv-generic');
  by_attr('id', 'import-check').listeners.click[0]({ preventDefault() {} });
  assert.ok(await until(() => workers.length === 1 && last_worker().queue.length === 1), 'первый запрос ушёл в воркер');
  assert.ok(by_attr('id', 'import-checking') !== undefined, 'проверка идёт: баннер на экране');
  const w = ctx.get_ws();
  const r = ctx.set_ws({ ...w, facts: [...w.facts, { event_id: 'tx_fp50_1', account_id: 'acc_main', date: '2026-10-01', amount_minor: -111, currency: 'EUR', kind: 'expense', note: 'fp50' }] }, { reason: 'edit' });
  assert.ok(r.ok, 'запись данных прошла');
  assert.ok(by_attr('id', 'import-checking') !== undefined, 'после записи баннер на месте');
  last_worker().deliver(); // ответ на первый запрос: план построен по старым данным и устарел
  assert.ok(await until(() => last_worker().queue.length === 1), 'устаревший план пересчитывается: второй запрос ушёл в воркер');
  assert.ok(by_attr('id', 'import-checking') !== undefined, 'пересчёт идёт: баннер на месте');
  last_worker().deliver();
  assert.ok(await until(() => by_attr('id', 'import-checking') === undefined, 20000), 'баннер погашен после ответа на пересчёт');
  assert.match(text_of('main'), /распознано \d+ · отклонено \d+ · дубликатов \d+/);
});

test('FP-50 мастер импорта, управляемый воркер: уход на другой экран и возврат во время проверки — ответ гасит баннер на живом экране', async () => {
  await fresh_wizard();
  await pick('import-file', 'год2.csv', big_bank_file());
  by_attr('id', 'import-check').listeners.click[0]({ preventDefault() {} });
  assert.ok(await until(() => last_worker().queue.length === 1), 'запрос ушёл в воркер');
  await go('#overview');
  await settle(10);
  await go('#data');
  assert.ok(by_attr('id', 'import-checking') !== undefined, 'возврат во время проверки: баннер на месте');
  last_worker().deliver();
  assert.ok(await until(() => by_attr('id', 'import-checking') === undefined, 20000), 'баннер погашен на живом экране');
  assert.match(text_of('main'), /распознано \d+ · отклонено \d+ · дубликатов \d+/);
});

test('FP-50 D-1: выбор файла CSV — чтение закончилось после перестройки страницы, живой экран переходит к шагу «колонки»', async () => {
  const ctx = ext.ctx;
  await fresh_wizard();
  const g = gate();
  await pick('import-file', 'gate.csv', enc(SMALL_CSV), g.p);
  const w = ctx.get_ws();
  ctx.set_ws({ ...w }, { reason: 'edit' }); // страница перестроена, пока файл читается
  await settle(10);
  g.open();
  assert.ok(await until(() => by_attr('id', 'import-file') === undefined, 5000), 'живой экран ушёл с шага выбора файла');
  assert.ok(by_attr('id', 'import-check') !== undefined, 'шаг «колонки» на живом экране');
});

test('FP-50 D-2: выбор файла профиля — чтение закончилось после перестройки страницы, ошибка профиля видна на живом экране', async () => {
  const ctx = ext.ctx;
  await fresh_wizard();
  await pick('import-file', 'prof.csv', enc(SMALL_CSV));
  assert.ok(by_attr('id', 'import-profile-file') !== undefined, 'поле профиля на шаге «колонки»');
  const g = gate();
  await pick('import-profile-file', 'bad.json', enc('{ не json'), g.p);
  const w = ctx.get_ws();
  ctx.set_ws({ ...w }, { reason: 'edit' });
  await settle(10);
  g.open();
  assert.ok(await until(() => by_attr('id', 'import-error') !== undefined, 5000), 'ошибка профиля на живом экране');
});

test('FP-50 D-3: выбор файла журнала hledger — чтение закончилось после перестройки страницы, шаг выбора файла уходит с живого экрана', async () => {
  const ctx = ext.ctx;
  await fresh_wizard();
  by_attr('id', 'import-tab-hledger').listeners.click[0]({ preventDefault() {} });
  await settle(10);
  const g = gate();
  await pick('import-hl-file', 'j.journal', enc(HL_JOURNAL), g.p);
  const w = ctx.get_ws();
  ctx.set_ws({ ...w }, { reason: 'edit' });
  await settle(10);
  g.open();
  assert.ok(await until(() => by_attr('id', 'import-hl-file') === undefined, 5000), 'живой экран ушёл с шага выбора файла журнала');
});

test('FP-50 мастер импорта: большой файл идёт в фоновый разбор (порог WORKER_MIN_BYTES) — иначе тесты банера проверяли бы не тот путь', () => {
  assert.ok(big_bank_file().length >= M.WORKER_MIN_BYTES, 'файл больше порога разбора в фоне');
});
