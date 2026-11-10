// fp18_adv.test.mjs — состязательная проверка FP-18 (независимый проверяющий): гонки экрана и клиента воркера, краевые случаи файла Runway.
// Дефекты D1 (гонка экрана) и D3 (terminate до первого разбора), найденные этой проверкой, исправлены: метки todo сняты, тесты обычные.
// FP-50: ADV-01 и ADV-02 ждут погашения баннера «Проверяю файл» по состоянию экрана (until_gone, предел 20 с), а не фиксированным окном: заглушка
// разбирает файл на главном потоке, и окно 1,0–1,4 с на загруженной машине было короче работы. Проверки и названия тестов прежние.
// Заглушка DOM — как в import_runway_boot.test.mjs; настоящий app.mjs; Worker подменяется заглушкой с задержкой ответа (в Node воркера нет, и без неё
// разбор целиком идёт синхронно внутри нажатия, окно гонки не открывается).
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/fp18_adv.test.mjs

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

const { ext } = await import(pathToFileURL(path.join(DEMO, 'ext.mjs')).href);
const M = await import(pathToFileURL(path.join(DEMO, 'import_model.mjs')).href);
const DA = await import(pathToFileURL(path.join(DEMO, 'data_actions.mjs')).href);
const W = await import(pathToFileURL(path.join(DEMO, 'import_worker.mjs')).href);
const C = await import(pathToFileURL(path.join(DEMO, 'import_worker_client.mjs')).href);
await import(pathToFileURL(path.join(DEMO, 'app.mjs')).href);
await new Promise((r) => setTimeout(r, 500));

const enc = (s) => new TextEncoder().encode(s);
const text_of = (id) => byid.get(id).textContent;
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const by_attr = (k, v) => find_all(byid.get('main'), (n) => n.attrs[k] === v)[0];
const by_text = (tag, txt) => find_all(byid.get('main'), (n) => n.tagName === tag && n.textContent === txt)[0];
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
/**
 * Ждать, пока баннер «Проверяю файл» погаснет на живом экране (FP-50): по состоянию, а не по фиксированному времени. Заглушка Worker разбирает файл
 * на главном потоке, поэтому окно в 1,0–1,4 с на загруженной машине короче работы (замер FP-50: баннер гас через 2,4 с и 6,9 с); предел — 20 с.
 */
const until_gone = async (ms = 20000) => {
  const t0 = performance.now();
  while (by_attr('id', 'import-checking') !== undefined && performance.now() - t0 < ms) await settle(20);
};
const click = async (node) => { assert.ok(node !== undefined, 'нет элемента'); node.listeners.click[0]({ preventDefault() {} }); await settle(); };
const pick = async (id, name, bytes) => {
  const input = by_attr('id', id);
  assert.ok(input !== undefined, 'нет поля файла ' + id);
  input.files = [{ name, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }];
  input.listeners.change[0]({});
  await settle();
};

// ── заглушка Worker с задержкой ответа: ответ по настоящему протоколу (handle_message / split_reply) ──
const DELAY_MS = 400;
let worker_created = 0;
globalThis.Worker = class FakeWorker {
  constructor(url) { worker_created += 1; this.url = String(url); this.dead = false; }
  postMessage(msg) {
    setTimeout(() => {
      if (this.dead) return;
      for (const r of W.split_reply(W.handle_message(structuredClone(msg)))) this.onmessage?.({ data: structuredClone(r) });
    }, DELAY_MS);
  }
  terminate() { this.dead = true; }
};

function big_bank_file() {
  const rows = ['Date,Description,Amount,Currency'];
  for (let i = 0; i < 3300; i++) rows.push(`2026-0${1 + (i % 9)}-${String(1 + (i % 28)).padStart(2, '0')},"Покупка №${i % 313}, касса ${i % 17}",-${1 + (i % 90)}.${String(i % 100).padStart(2, '0')},EUR`);
  return enc(rows.join('\n') + '\n');
}

test('ADV-01 гонка: данные изменились, пока большой файл проверяется в Worker — живой экран не остаётся навсегда на «Проверяю файл»', async () => {
  const ctx = ext.ctx;
  const big = big_bank_file();
  assert.ok(big.length >= M.WORKER_MIN_BYTES);
  await go('#data');
  const again = by_text('button', 'Другой файл');
  if (again !== undefined) await click(again);
  await pick('import-file', 'год.csv', big);
  assert.equal(by_attr('id', 'import-profile').value, 'csv-generic');
  by_attr('id', 'import-check').listeners.click[0]({ preventDefault() {} });
  assert.ok(by_attr('id', 'import-checking') !== undefined, 'проверка началась');
  assert.equal(worker_created, 1, 'настоящий клиент создал заглушку воркера');
  // пока воркер «думает», пользователь меняет данные другим путём (общий путь записи → страница перестраивается)
  await settle(50);
  const w = ctx.get_ws();
  const r = ctx.set_ws({ ...w, facts: [...w.facts, { event_id: 'tx_adv_1', account_id: 'acc_main', date: '2026-10-01', amount_minor: -111, currency: 'EUR', kind: 'expense', note: 'adv' }] }, { reason: 'edit' });
  assert.ok(r.ok);
  assert.ok(by_attr('id', 'import-checking') !== undefined, 'перестроенный экран пока тоже показывает проверку');
  // ответ воркера приходит; пересчёт устаревшего отчёта — ещё один круг воркера: ждём погашения баннера по состоянию (FP-50)
  await until_gone();
  assert.equal(by_attr('id', 'import-checking'), undefined, 'ЖИВОЙ экран застрял на «Проверяю файл»: перерисовка после ответа воркера ушла в отсоединённый узел');
  assert.match(text_of('main'), /распознано \d+ · отклонено \d+ · дубликатов \d+/);
});

test('ADV-02 гонка: пользователь ушёл на другой экран и вернулся на «Данные», пока шла проверка в Worker — экран не застревает на «Проверяю файл»', async () => {
  const big = big_bank_file();
  await go('#data');
  const again = by_text('button', 'Другой файл');
  if (again !== undefined) await click(again);
  await go('#data');
  await pick('import-file', 'год2.csv', big);
  by_attr('id', 'import-check').listeners.click[0]({ preventDefault() {} });
  assert.ok(by_attr('id', 'import-checking') !== undefined);
  await settle(50);
  await go('#overview');
  await settle(20);
  await go('#data'); // страница строит блок заново из того же состояния мастера (deps.w)
  assert.ok(by_attr('id', 'import-checking') !== undefined, 'возврат во время проверки: баннер на месте');
  await until_gone();
  assert.equal(by_attr('id', 'import-checking'), undefined, 'ЖИВОЙ экран застрял на «Проверяю файл»');
  assert.match(text_of('main'), /распознано \d+ · отклонено \d+ · дубликатов \d+/);
});

test('ADV-03 клиент: terminate() до первого вызова не должен создавать воркер, который потом никто не закроет (утечка воркера); приложение terminate() не вызывает — серьёзность низкая', () => {
  let created = 0;
  let terminated = 0;
  const fake = () => { created += 1; return { postMessage() {}, terminate() { terminated += 1; } }; };
  const c = C.create_import_client({ make_worker: fake, local: () => ({ candidates: [], rejects: [], rows_total: 0 }) });
  c.terminate();
  return c.parse_csv({}, '', {}).then((r) => {
    assert.equal(r.via, 'main');
    assert.equal(created, 0, 'после terminate() воркер создаваться не должен; создан: ' + created + ', закрыт: ' + terminated);
  });
});
