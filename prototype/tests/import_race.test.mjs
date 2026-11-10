// import_race.test.mjs — исправление дефекта D1 (medium) FP-18 после независимой проверки: ответ фонового разбора (Worker) должен перерисовывать ЖИВОЙ экран.
// Было: `run_check` и `refresh_plans` по ответу воркера вызывали замкнутую `redraw()` того вызова `render_wizard`, который запустил проверку. Если за это время
// страницу перестроили (данные записаны другим путём, уход на другой экран и возврат), `render_wizard` вызывается заново с теми же `deps`, а старая `redraw`
// рисует в отсоединённый узел: живой экран навсегда оставался на «Проверяю файл», кнопка «Проверить» была недоступна. В Node воркера нет, разбор уходит на
// главный поток синхронно, и окно гонки не открывается — поэтому здесь Worker подменён заглушкой с задержкой ответа (ответ по настоящему протоколу:
// `handle_message` / `split_reply` из demo/import_worker.mjs), страница — настоящий app.mjs на заглушке DOM.
// Проверяется: перестройка страницы во время проверки (смена данных, уход и возврат), пересчёт устаревшего отчёта в фоне при повторной перестройке, «Назад» во время
// проверки (устаревший ответ отброшен), сбой воркера (откат на главный поток, причина на экране), строка «где разобран файл», нейтральная формулировка amount_scale.
// Браузер не запускается. Расчёт по введённым данным и правилам, не консультация.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/import_race.test.mjs

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
await import(pathToFileURL(path.join(DEMO, 'app.mjs')).href);
await new Promise((r) => setTimeout(r, 500));

const enc = (s) => new TextEncoder().encode(s);
const text_of = (id) => byid.get(id).textContent;
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const by_attr = (k, v) => find_all(byid.get('main'), (n) => n.attrs[k] === v)[0];
const by_text = (tag, txt) => find_all(byid.get('main'), (n) => n.tagName === tag && n.textContent === txt)[0];
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const click = async (node) => { assert.ok(node !== undefined, 'нет элемента'); node.listeners.click[0]({ preventDefault() {} }); await settle(); };
const pick = async (id, name, bytes) => {
  const input = by_attr('id', id);
  assert.ok(input !== undefined, 'нет поля файла ' + id);
  input.files = [{ name, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }];
  input.listeners.change[0]({});
  await settle();
};
async function until(pred, what, ms = 10000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) assert.fail('не дождались: ' + what + '; на экране: ' + text_of('main').slice(0, 300));
    await settle(20);
  }
}
const to_file_step = async () => { const again = by_text('button', 'Другой файл'); if (again !== undefined) await click(again); };
const REPORT_RE = /распознано \d+ · отклонено \d+ · дубликатов \d+/;

// ── заглушка Worker: ответ по настоящему протоколу через DELAY_MS; режим меняется между тестами ──
const DELAY_MS = 300;
let BEHAVIOR = 'ok'; // 'ok' — ответить; 'error' — упасть (событие error)
let worker_created = 0;
globalThis.Worker = class FakeWorker {
  constructor(url) { worker_created += 1; this.url = String(url); this.dead = false; }
  postMessage(msg) {
    setTimeout(() => {
      if (this.dead) return;
      if (BEHAVIOR === 'error') { this.onerror?.({}); return; }
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
const BIG = big_bank_file();
const add_fact = (id) => { const w = ext.ctx.get_ws(); return ext.ctx.set_ws({ ...w, facts: [...w.facts, { event_id: id, account_id: 'acc_main', date: '2026-10-01', amount_minor: -111, currency: 'EUR', kind: 'expense', note: id }] }, { reason: 'edit' }); };
/** Большой файл выбран, профиль автоматический, проверка запущена; возвращает сразу после нажатия (ответ воркера ещё впереди). */
async function start_big_check(name) {
  await go('#data');
  await to_file_step();
  await pick('import-file', name, BIG);
  assert.equal(by_attr('id', 'import-profile').value, 'csv-generic');
  by_attr('id', 'import-check').listeners.click[0]({ preventDefault() {} });
  assert.ok(by_attr('id', 'import-checking') !== undefined, 'проверка началась: баннер на месте');
}
const settled = () => by_attr('id', 'import-checking') === undefined && REPORT_RE.test(text_of('main'));

test('boot: набор G-001 загружен, мастер импорта на экране «Данные»', async () => {
  await go('#data');
  assert.match(text_of('main'), /Импорт из файла/);
  assert.equal(ext.ctx.get_ws().facts.length, 28);
});

test('REQ-095 FP-18 amount_scale при профиле минимальных единиц: на экране нейтральная формулировка (счёт и файл), а не «прочитана как основные»', async () => {
  const ctx = ext.ctx;
  const w0 = ctx.get_ws();
  const exported = DA.export_csv_file(w0).text;
  // та же рабочая область, но у счёта остаток 100,00 € и фактов нет: крупнейшая сумма выгрузки (2 880,00 €) намного больше
  const r = ctx.set_ws({ ...w0, facts: [], anchors: w0.anchors.slice(0, 1).map((a) => ({ ...a, amount_minor: 10000 })) }, { reason: 'edit' });
  assert.ok(r.ok, JSON.stringify(r.error));
  await go('#data');
  await to_file_step();
  await pick('import-file', 'runway.csv', enc(exported));
  assert.equal(by_attr('id', 'import-profile').value, 'runway-csv-1');
  await click(by_attr('id', 'import-check'));
  const warn = by_attr('id', 'import-warn-amount_scale');
  assert.ok(warn !== undefined, 'предупреждение о масштабе есть');
  assert.equal(warn.attrs.role, 'alert');
  assert.match(warn.textContent, /Единицы суммы заданы как минимальные/);
  assert.match(warn.textContent, /нужный счёт/);
  assert.ok(!/прочитана как основные/.test(warn.textContent), warn.textContent);
  assert.equal(by_attr('id', 'import-warn-minor_as_major'), undefined, 'название колонки читается верно: второго предупреждения нет');
  assert.equal(by_attr('id', 'import-parse-path'), undefined, 'малый файл разобран на месте: строки «где разобран» нет');
});

test('REQ-091 FP-18 D1 данные записаны другим путём, пока большой файл проверяется в Worker: ответ воркера перерисовывает живой экран — отчёт на месте, баннера «Проверяю файл» нет, строка «в фоне»', async () => {
  const created_before = worker_created;
  await start_big_check('год-1.csv');
  assert.equal(worker_created, created_before + (created_before === 0 ? 1 : 0), 'воркер создаётся один раз на клиента');
  await settle(60);
  const r = add_fact('tx_race_1'); // общий путь записи: страница перестраивается, новый render_wizard берёт то же состояние мастера
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.ok(by_attr('id', 'import-checking') !== undefined, 'перестроенный экран пока тоже показывает проверку');
  assert.notEqual(by_attr('id', 'import-check').attrs.disabled, undefined, 'второй запуск не принимается');
  await until(settled, 'отчёт на живом экране');
  assert.equal(by_attr('id', 'import-checking'), undefined);
  assert.equal(by_attr('id', 'import-check'), undefined, 'экран на шаге «отчёт»');
  assert.equal(by_attr('id', 'import-confirm').attrs.disabled, undefined, '«Подтвердить» доступна');
  assert.match(by_attr('id', 'import-parse-path').textContent, /разобран в фоне, отдельным потоком/);
  // числа отчёта те же, что при разборе на месте по актуальным данным
  const ws = ext.ctx.get_ws();
  const expected = M.plan_csv(ws, { text: new TextDecoder().decode(BIG), bytes: BIG, name: 'год-1.csv', profile: M.BUILTIN_PROFILES['csv-generic'], account_id: 'acc_main' }).plan.report;
  assert.ok(text_of('main').includes(`распознано ${expected.recognized} · отклонено ${expected.rejected} · дубликатов ${expected.duplicates}`), text_of('main').slice(0, 300));
});

test('REQ-091 FP-18 D1 пользователь ушёл на другой экран и вернулся на «Данные», пока шла проверка: возврат строит блок заново, ответ воркера доходит до него', async () => {
  await start_big_check('год-2.csv');
  await settle(60);
  await go('#overview');
  await settle(20);
  await go('#data');
  assert.ok(by_attr('id', 'import-checking') !== undefined, 'возврат во время проверки: баннер на месте');
  await until(settled, 'отчёт после возврата на экран');
  assert.equal(by_attr('id', 'import-confirm').attrs.disabled, undefined);
  assert.match(text_of('main'), /Строк в файле: 3300 = /);
});

test('REQ-091 FP-18 D1 отчёт большого файла устарел, пересчёт идёт в фоне, а страницу перестраивают ещё раз: пересчёт доходит до живого экрана, «Подтвердить» снова доступна', async () => {
  // отчёт предыдущего теста на экране; данные меняются → страница перестраивается → пересчёт устаревшего отчёта в фоне
  assert.match(text_of('main'), REPORT_RE);
  assert.ok(add_fact('tx_race_2').ok);
  await settle(80);
  assert.ok(by_attr('id', 'import-checking') !== undefined, 'пересчёт устаревшего отчёта идёт в фоне');
  assert.notEqual(by_attr('id', 'import-confirm').attrs.disabled, undefined, 'на время пересчёта запись недоступна');
  assert.ok(add_fact('tx_race_3').ok); // ещё одна смена данных и перестройка страницы, пока идёт первый пересчёт
  await until(settled, 'пересчитанный отчёт на живом экране');
  assert.equal(by_attr('id', 'import-confirm').attrs.disabled, undefined);
  // отчёт построен по текущим данным: запись проходит (иначе мастер отказал бы с stale_plan)
  await click(by_attr('id', 'import-confirm'));
  assert.match(text_of('main'), /Партия записана/);
  assert.ok(ext.ctx.get_ws().facts.length > 3000, 'партия записана: ' + ext.ctx.get_ws().facts.length);
});

test('REQ-091 FP-18 смена настройки во время первой проверки: устаревший ответ воркера отброшен, живой экран остаётся на шаге «колонки» и не застревает на «Проверяю файл»', async () => {
  await start_big_check('год-3.csv');
  await settle(60);
  const sel = by_attr('id', 'import-delimiter');
  assert.ok(sel !== undefined);
  sel.value = ',';
  sel.listeners.change[0]({});
  await settle(10);
  assert.equal(by_attr('id', 'import-checking'), undefined, 'смена настройки сняла ожидание');
  assert.equal(by_attr('id', 'import-check').attrs.disabled, undefined, '«Проверить» снова доступна');
  await settle(DELAY_MS + 200); // устаревший ответ приходит и отбрасывается
  assert.equal(by_attr('id', 'import-checking'), undefined);
  assert.equal(by_attr('id', 'import-rep-line'), undefined, 'устаревший ответ не вернул отчёт на экран');
  assert.ok(by_attr('id', 'import-check') !== undefined, 'экран остался на шаге «колонки»');
});

test('REQ-091 FP-18 «Назад» во время пересчёта устаревшего отчёта: пересчёт отброшен, живой экран на шаге «колонки», баннер снят, поздний ответ ничего не возвращает', async () => {
  await start_big_check('год-6.csv');
  await until(settled, 'отчёт');
  assert.ok(add_fact('tx_race_4').ok); // отчёт устарел → пересчёт в фоне; пока он идёт, отчёт остаётся на экране
  await settle(80);
  assert.ok(by_attr('id', 'import-checking') !== undefined, 'пересчёт идёт');
  const back = by_text('button', 'Назад');
  assert.ok(back !== undefined, 'кнопка «Назад» доступна на шаге «отчёт»');
  await click(back);
  assert.equal(by_attr('id', 'import-checking'), undefined, '«Назад» сняла ожидание');
  assert.ok(by_attr('id', 'import-check') !== undefined);
  assert.equal(by_attr('id', 'import-check').attrs.disabled, undefined);
  await settle(DELAY_MS + 200);
  assert.equal(by_attr('id', 'import-checking'), undefined);
  assert.equal(by_attr('id', 'import-rep-line'), undefined, 'поздний ответ отчёт не вернул');
  assert.ok(by_attr('id', 'import-check') !== undefined);
});

test('REQ-091 FP-18 сбой воркера во время проверки: откат на главный поток, отчёт тот же, на экране причина; экран не застревает', async () => {
  BEHAVIOR = 'error';
  try {
    await to_file_step();
    await pick('import-file', 'год-4.csv', BIG);
    by_attr('id', 'import-check').listeners.click[0]({ preventDefault() {} });
    assert.ok(by_attr('id', 'import-checking') !== undefined);
    await until(settled, 'отчёт после отката на главный поток');
    const line = by_attr('id', 'import-parse-path');
    assert.ok(line !== undefined);
    assert.match(line.textContent, /разобран на основном потоке/);
    assert.match(line.textContent, /причина: worker_error/);
    const ws = ext.ctx.get_ws();
    const expected = M.plan_csv(ws, { text: new TextDecoder().decode(BIG), bytes: BIG, name: 'год-4.csv', profile: M.BUILTIN_PROFILES['csv-generic'], account_id: 'acc_main' }).plan.report;
    assert.ok(text_of('main').includes(`распознано ${expected.recognized} · отклонено ${expected.rejected} · дубликатов ${expected.duplicates}`), 'числа те же, что при разборе на месте');
    // дальше воркер считается мёртвым до конца сеанса: следующий файл разбирается на месте сразу, причина та же
    await to_file_step();
    await pick('import-file', 'год-5.csv', BIG);
    by_attr('id', 'import-check').listeners.click[0]({ preventDefault() {} });
    await until(settled, 'отчёт без воркера');
    assert.match(by_attr('id', 'import-parse-path').textContent, /причина: worker_error/);
  } finally { BEHAVIOR = 'ok'; }
});
