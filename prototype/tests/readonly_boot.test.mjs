// readonly_boot.test.mjs — FP-17, REQ-016 в настоящем app.mjs: файл-копия НОВЕЕ известного формата выбирается на экране «Данные» → «Восстановить из файла»,
// диалог предлагает «Открыть только для просмотра» (а не «Заменить данные»), после чего прогноз виден, в шапке написано почему, правки отклоняются с понятным
// текстом, настройки отключены, а выбор набора данных возвращает обычный режим. Версия движка в файле сравнивается с текущей (предупреждение, не отказ).
// Заглушка DOM минимальная (без вёрстки), как в settings_boot.test.mjs: проверяется связка app.mjs ↔ ext.mjs ↔ пакет FP-05 ↔ data_view. Браузер не используется.

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
const { export_journal_copy, events_of_ws } = await import(pathToFileURL(path.join(DEMO, 'data_actions.mjs')).href);
const { canon } = await import(pathToFileURL(path.join(HERE, '..', 'engine', 'index.mjs')).href);
await new Promise((r) => setTimeout(r, 500)); // boot асинхронный: манифест пакетов, набор данных, boot-хуки

const text_of = (id) => byid.get(id).textContent;
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };
const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const G = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'data', 'g001.json'), 'utf8'));

/** Копия набора G-001, «сохранённая более новой версией программы»: формат /2, движок 0.2.0, две записи, которых эта версия прочитать не может. */
function newer_copy_text() {
  const obj = JSON.parse(export_journal_copy(events_of_ws(G)).text);
  obj.format = 'runway-journal/2';
  obj.engine_version = '0.2.0';
  const last = obj.events.at(-1).seq;
  obj.events.push(
    { actor: 'user', entity_id: 'cat-food', event_id: 'ev-x1', payload: { category_id: 'cat-food', name: 'Продукты' }, recorded_at: '2026-10-05T08:00:00Z', seq: last + 1, type: 'category.set', v: 1 },
    { actor: 'user', entity_id: 'tx-next', event_id: 'ev-x2', payload: { account_id: 'acc_main', amount: { currency: 'EUR', minor: -1999 }, date: '2026-10-03' }, recorded_at: '2026-10-05T08:00:00Z', seq: last + 2, type: 'tx.posted', v: 2 },
  );
  return canon(obj);
}

test('boot: пакет хранения подхвачен, режима «только чтение» нет, в шапке нет плашки', () => {
  assert.deepEqual(ext.diagnostics().filter((d) => d.pack === 'pack_fp05').map((d) => d.status), ['ok'], JSON.stringify(ext.diagnostics()));
  assert.equal(ext.ctx.read_only(), null);
  assert.ok(!text_of('summary').includes('Только для просмотра'));
});

test('REQ-016 FP-17 «Восстановить из файла»: файл нового формата — диалог «Открыть только для просмотра» с предупреждением о версии движка, без кнопки «Заменить данные»', async () => {
  await go('#data');
  const input = find_all(byid.get('main'), (n) => n.attrs.id === 'fp05-file')[0];
  assert.ok(input !== undefined, 'поле выбора файла на экране «Данные»');
  const text = newer_copy_text();
  input.files = [{ size: text.length, text: async () => text }];
  input.listeners.change[0]();
  await wait();
  const dlg = byid.get('dlg-body').textContent;
  assert.equal(byid.get('dlg').open, true, 'диалог открыт');
  assert.match(dlg, /Файл создан более новой версией программы \(формат runway-journal\/2; эта версия читает до runway-journal\/1\)/);
  assert.match(dlg, /откроется только для просмотра/);
  assert.match(dlg, /Записей, которые эта версия не умеет читать и пропустила: 2\./);
  assert.match(dlg, /Файл сделан более новой версией движка \(0\.2\.0; сейчас 0\.1\.0\)/, 'версия движка в файле новее — предупреждение');
  assert.match(dlg, /Это предупреждение, а не отказ/);
  assert.match(dlg, /Состояние по файлу: [0-9a-f]{8}\./);
  const buttons = find_all(byid.get('dlg-body'), (n) => n.tagName === 'button').map((b) => b.textContent);
  assert.deepEqual(buttons, ['Открыть только для просмотра'], 'заменить данные файлом нового формата нельзя');
  assert.ok(!dlg.includes('Замена необратима'), 'ничего не заменяется — предупреждения о замене нет');
});

test('REQ-016 FP-17 после «Открыть только для просмотра»: прогноз G-001 виден (400 000 → 340 000), в шапке сказано почему, правки отклоняются с понятным текстом, данные и журнал прежние', async () => {
  const btn = find_all(byid.get('dlg-body'), (n) => n.tagName === 'button' && n.textContent === 'Открыть только для просмотра')[0];
  btn.listeners.click[0]();
  await wait(150);
  const ro = ext.ctx.read_only();
  assert.ok(ro !== null, 'режим включён');
  assert.deepEqual([ro.newer_format, ro.format, ro.format_version, ro.known_version, ro.skipped, ro.source], [true, 'runway-journal/2', 2, 1, 2, 'file']);
  assert.match(text_of('summary'), /Только для просмотра: файл создан более новой версией программы \(формат runway-journal\/2; эта версия читает до runway-journal\/1\)\. Прогноз виден, правки отключены\./);
  assert.match(text_of('summary'), /Записей, которые эта версия не умеет читать и пропустила: 2\./);
  assert.match(text_of('live'), /открыт только для просмотра/, 'сообщение озвучено скринридеру');
  // прогноз виден: числа канона G-001 тот же набор
  const model = ext.ctx.get_model();
  assert.equal(model.ctx.series.plan.opening_minor, 400000);
  assert.equal(model.ctx.series.plan.close.at(-1), 340000);
  await go('#overview');
  assert.match(text_of('main'), /Минимум|минимум|Узкая точка/i);
  // правка отклоняется до пересчёта: данные, журнал и хэш не меняются
  const ws_before = ext.ctx.get_ws();
  const hash_before = model.ctx.inputs_hash;
  const n0 = ext.ctx.journal.length;
  const r = ext.ctx.edit({ type: 'set_param', key: 'horizon_days', value: 30 });
  assert.deepEqual([r.ok, r.error.code, r.error.ctx.reason], [false, 'E_SCHEMA', 'read_only']);
  assert.equal(ext.ctx.get_ws(), ws_before);
  assert.equal(ext.ctx.get_model().ctx.inputs_hash, hash_before);
  assert.equal(ext.ctx.journal.length, n0);
  assert.match(text_of('live'), /Файл открыт только для просмотра: правки отключены, данные не изменены\./);
  // «Данные»: сообщение об отказе видно и на этом экране, версия движка названа; хранилище пусто (режим «fresh»), открытие файла в него ничего не записало
  await go('#data');
  assert.match(text_of('main'), /Файл открыт только для просмотра: правки отключены, данные не изменены\./);
  assert.match(text_of('main'), /Версия движка: 0\.1\.0\./);
  assert.match(text_of('main'), /Журнал лежит только в памяти вкладки: записей 47\./, 'счёт записей — набора G-001, а не файла нового формата с двумя пропущенными');
});

test('REQ-016 FP-17 «Настройки» в режиме «только чтение»: сверху сказано почему, поля и кнопки отключены; сохранение не проходит', async () => {
  await go('#settings');
  const main = byid.get('main');
  assert.match(text_of('main'), /Файл открыт только для просмотра: настройки не меняются\./);
  const input = find_all(main, (n) => n.attrs.id === 'set-buffer')[0];
  assert.ok(input.attrs.disabled !== undefined, 'поле буфера отключено');
  const submits = find_all(main, (n) => n.tagName === 'button' && n.attrs.type === 'submit');
  assert.ok(submits.length >= 5 && submits.every((b) => b.attrs.disabled !== undefined), 'все «Сохранить» отключены');
  assert.ok(find_all(main, (n) => n.tagName === 'button' && /Вернуть/.test(n.textContent)).every((b) => b.attrs.disabled !== undefined), 'все «Вернуть» отключены');
  // форма, отправленная напрямую (например, Enter в поле), тоже ничего не пишет
  input.value = '123';
  const form = find_all(main, (n) => n.attrs.id === 'settings-buffer')[0];
  const buffer_before = ext.ctx.get_ws().params.buffer_minor;
  form.listeners.submit[0]({ preventDefault() {} });
  assert.equal(ext.ctx.get_ws().params.buffer_minor, buffer_before);
  assert.match(text_of('main'), /Не сохранено|Не удалось/, 'форма сообщает об отказе');
});

test('REQ-016 FP-17 выход из режима: выбор набора данных возвращает обычный режим — плашка исчезает, правки снова проходят', async () => {
  await go('#overview');
  const sel = find_all(byid.get('controls'), (n) => n.tagName === 'select')[0];
  sel.listeners.change[0]({ target: { value: 'gap' } });
  await wait(150);
  assert.equal(ext.ctx.read_only(), null);
  assert.ok(!text_of('summary').includes('Только для просмотра'));
  const r = ext.ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 51000 });
  assert.equal(r.ok, true);
  assert.equal(ext.ctx.get_ws().params.buffer_minor, 51000);
});

test('REQ-016 FP-17 набор данных (файл рабочей области) с полем format новее известного, загруженный через «Данные», тоже открывается только для просмотра', async () => {
  const ws = { ...JSON.parse(JSON.stringify(G)), format: 'runway-journal/3' };
  const r = ext.ctx.adopt(ws, { source: 'file' });
  assert.equal(r.ok, true);
  assert.deepEqual([ext.ctx.read_only().newer_format, ext.ctx.read_only().format, ext.ctx.read_only().source], [true, 'runway-journal/3', 'workspace']);
  assert.match(text_of('summary'), /формат runway-journal\/3/);
  assert.equal(ext.ctx.edit({ type: 'set_param', key: 'horizon_days', value: 40 }).error.ctx.reason, 'read_only');
  ext.ctx.adopt(JSON.parse(JSON.stringify(G)), { source: 'dataset' });
  assert.equal(ext.ctx.read_only(), null);
});

test('завершение: заглушки сняты', () => {
  globalThis.fetch = real_fetch;
  assert.ok(true);
});
