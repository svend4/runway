// import_wizard.test.mjs — FP-06 в настоящем app.mjs: мастер импорта подхватывается манифестом (pack_fp06.mjs) и стоит на экране «Данные»;
// весь путь «файл → колонки → сухой прогон → Подтвердить → Откатить» проходит через DOM-заглушку и общий путь записи (ctx.set_ws → пересчёт → журнал).
// TST-42 REQ-092, TST-43 REQ-093, REQ-091, REQ-099. Заглушка DOM минимальная (без вёрстки); браузер не используется.
// Чистая модель проверена отдельно: tests/import_model.test.mjs.
// Запуск: node --test --test-timeout=120000 --test-concurrency=1 tests/import_wizard.test.mjs

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
const W = await import(pathToFileURL(path.join(DEMO, 'import_wizard.mjs')).href);
await import(pathToFileURL(path.join(DEMO, 'app.mjs')).href); // getElementById('app-title') !== null → boot() запускается сам
await new Promise((r) => setTimeout(r, 500)); // boot асинхронный: манифест пакетов, набор данных, boot-хуки

const enc = (s) => new TextEncoder().encode(s);
const FIXTURE = new Uint8Array(fs.readFileSync(path.join(HERE, 'fixtures', 'import-152.csv')));
const LINES = Buffer.from(FIXTURE).toString('utf8').split('\n');
const HEAD12 = enc(LINES.slice(0, 13).join('\n') + '\n');

const text_of = (id) => byid.get(id).textContent;
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const by_attr = (k, v) => find_all(byid.get('main'), (n) => n.attrs[k] === v)[0];
const by_text = (tag, t) => find_all(byid.get('main'), (n) => n.tagName === tag && n.textContent === t)[0];
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };
const settle = () => new Promise((r) => setTimeout(r, 30));
const click = async (node) => { assert.ok(node !== undefined, 'нет элемента'); node.listeners.click[0]({ preventDefault() {} }); await settle(); };
const pick = async (id, name, bytes, size) => {
  const input = by_attr('id', id);
  assert.ok(input !== undefined, 'нет поля файла ' + id);
  input.files = [{ name, size: size ?? bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }];
  input.listeners.change[0]({});
  await settle();
};
const hash = () => M.ws_state_hash(ext.ctx.get_ws());

/** Вернуть мастер к шагу «файл» (кнопка «Другой файл» или уже на нём). */
async function to_file_step() {
  const again = by_text('button', 'Другой файл');
  if (again !== undefined) await click(again);
}

test('boot: манифест подхватил pack_fp06; экран «Данные» содержит мастер импорта (слот data.sections), набор G-001 загружен', async () => {
  const diag = ext.diagnostics().filter((d) => d.pack === 'pack_fp06');
  assert.deepEqual(diag.map((d) => d.status), ['ok'], JSON.stringify(ext.diagnostics()));
  await go('#data');
  const main = text_of('main');
  assert.match(main, /Импорт из файла/);
  assert.match(main, /Шаг 1: Файл/);
  assert.match(main, /не больше 5 МБ/);
  assert.ok(by_attr('id', 'import-file') !== undefined, 'поле выбора CSV');
  assert.equal(by_attr('id', 'import-file').attrs.type, 'file');
});

test('TST-42 REQ-092 в интерфейсе: «распознано 138 · отклонено 2 · дубликатов 12», сумма равна строкам, state_hash прежний до «Подтвердить»', async () => {
  const ctx = ext.ctx;
  // 1) в данных уже есть 12 первых строк (импорт малой партии тем же мастером)
  const n0 = ctx.get_ws().facts.length;
  const h_start = hash();
  await pick('import-file', 'июль-12.csv', HEAD12);
  assert.match(text_of('main'), /Шаг 2: Колонки/);
  assert.match(text_of('main'), /июль-12\.csv/);
  assert.equal(hash(), h_start, 'выбор файла данные не меняет');
  await click(by_attr('id', 'import-check'));
  assert.match(text_of('main'), /распознано 12 · отклонено 0 · дубликатов 0/);
  assert.equal(hash(), h_start, 'сухой прогон данные не меняет');
  const j0 = ctx.journal.length;
  await click(by_attr('id', 'import-confirm'));
  assert.equal(ctx.get_ws().facts.length, n0 + 12);
  assert.ok(ctx.journal.length > j0, 'журнал следует за записью');
  assert.match(text_of('main'), /Партия записана/);
  assert.match(text_of('main'), /Записано фактов: 12/);
  ext.__h_after_a = hash();

  // 2) полный файл на 152 строки
  await to_file_step();
  await pick('import-file', 'июль-сентябрь.csv', FIXTURE);
  await click(by_attr('id', 'import-check'));
  const main = text_of('main');
  assert.match(main, /распознано 138 · отклонено 2 · дубликатов 12/);
  assert.match(main, /Строк в файле: 152 = 138 \+ 2 \+ 12\./);
  assert.match(main, /Данные не изменены, пока вы не нажмёте «Подтвердить»\./);
  assert.match(main, /Подтвердить: записать 138/);
  assert.equal(hash(), ext.__h_after_a, 'state_hash не меняется до «Подтвердить»');
  assert.equal(ctx.get_ws().facts.length, n0 + 12);
  // отклонённые строки названы по номеру и причине, без текста из файла
  const rej = find_all(byid.get('main'), (n) => n.className === 'import-rejects')[0];
  assert.ok(rej !== undefined);
  assert.match(rej.textContent, /Отклонённые строки: 2/);
  assert.match(rej.textContent, /61.*дата не разобрана/);
  assert.match(rej.textContent, /121.*сумма не разобрана/);
});

test('TST-43 REQ-093 в интерфейсе: «Подтвердить» пишет партию, повторный импорт даёт 0 новых, «Откатить» возвращает state_hash к значению до импорта', async () => {
  const ctx = ext.ctx;
  const h_before = ext.__h_after_a; // до партии «полный файл»
  const n_before = ctx.get_ws().facts.length;
  const j0 = ctx.journal.length;
  await click(by_attr('id', 'import-confirm'));
  assert.equal(ctx.get_ws().facts.length, n_before + 138);
  assert.notEqual(hash(), h_before);
  assert.ok(ctx.journal.length > j0);
  assert.match(text_of('main'), /Записано фактов: 138/);
  assert.match(text_of('main'), /Партии импорта/, 'список партий показан');
  const batches = M.list_batches(ctx.get_ws());
  assert.deepEqual(batches.map((b) => b.count), [12, 138]);
  // повторный импорт того же файла
  await to_file_step();
  await pick('import-file', 'июль-сентябрь.csv', FIXTURE);
  await click(by_attr('id', 'import-check'));
  assert.match(text_of('main'), /распознано 0 · отклонено 2 · дубликатов 150/);
  assert.notEqual(by_attr('id', 'import-confirm').attrs.disabled, undefined, '«Подтвердить» недоступна: записывать нечего');
  assert.equal(ctx.get_ws().facts.length, n_before + 138, 'новых строк нет');
  // откат партии из списка партий
  const rb = find_all(byid.get('main'), (n) => n.tagName === 'button' && (n.attrs['aria-label'] ?? '').includes(batches[1].batch_id))[0];
  assert.ok(rb !== undefined, 'кнопка «Откатить» у партии из 138 фактов');
  await click(rb);
  assert.equal(ctx.get_ws().facts.length, n_before);
  assert.equal(hash(), h_before, 'state_hash вернулся к значению до импорта');
  assert.match(text_of('main'), new RegExp('Партия ' + batches[1].batch_id + ' откатена: удалено фактов 138'));
  assert.deepEqual(M.list_batches(ctx.get_ws()).map((b) => b.count), [12]);
});

test('REQ-091 в интерфейсе: файл больше 5 МБ отклоняется до разбора (содержимое не читается), данные прежние', async () => {
  await to_file_step();
  const h0 = hash();
  let read = false;
  const input = by_attr('id', 'import-file');
  input.files = [{ name: 'огромный.csv', size: 5 * 1024 * 1024 + 1, arrayBuffer: async () => { read = true; return new ArrayBuffer(0); } }];
  input.listeners.change[0]({});
  await settle();
  assert.equal(read, false, 'до разбора: файл даже не читается');
  assert.match(text_of('main'), /Файл больше 5 МБ: он отклонён до разбора/);
  assert.match(text_of('main'), /\(E_SCHEMA\)/);
  assert.match(text_of('main'), /Шаг 1: Файл/);
  assert.equal(hash(), h0);
  const r = await W.read_picked_file({ size: 6 * 1024 * 1024, arrayBuffer: async () => { read = true; return new ArrayBuffer(0); } });
  assert.equal(r.ok, false);
  assert.equal(read, false);
});

test('REQ-091 в интерфейсе: описание операции из файла выводится только текстом (нет элемента <img>, нет обработчиков из данных); профиль с regex отвергается', async () => {
  const evil = '<img src=x onerror=alert(1)> Cafe';
  const csv = enc('Date,Description,Amount,Currency\n2026-09-01,"' + evil + '",-7.00,EUR\n');
  await pick('import-file', 'зло.csv', csv);
  await click(by_attr('id', 'import-check'));
  assert.match(text_of('main'), /распознано 1 · отклонено 0 · дубликатов 0/);
  assert.ok(text_of('main').includes(evil), 'описание показано как текст');
  const tags = [];
  byid.get('main').walk((n) => tags.push(n.tagName));
  assert.ok(!tags.includes('img'), 'разметка из файла не стала элементом');
  const styled = find_all(byid.get('main'), (n) => n.attrs.style !== undefined || Object.keys(n.attrs).some((k) => k.startsWith('on')));
  assert.equal(styled.length, 0, 'нет inline-стилей и атрибутов-обработчиков');
  // вернуться на шаг «колонки»: профиль из файла с полем regex
  await click(by_text('button', 'Назад'));
  const prof = by_attr('id', 'import-profile-file');
  assert.ok(prof !== undefined, 'поле профиля из файла');
  const bad = enc(JSON.stringify({ profile_id: 'x', v: 1, delimiter: ',', skip: 0, date: { col: 'Date', fmt: 'YYYY-MM-DD' }, amount: { mode: 'signed', col: 'Amount' }, currency: { fixed: 'EUR' }, desc: { cols: ['Description'] }, rules: [{ match: 'a', tag: 'b', regex: '.*' }] }));
  prof.files = [{ name: 'p.json', size: bad.length, arrayBuffer: async () => bad.buffer.slice(bad.byteOffset, bad.byteOffset + bad.byteLength) }];
  prof.listeners.change[0]({});
  await settle();
  assert.match(text_of('main'), /Профиль отвергнут/);
  assert.match(text_of('main'), /rules\[0\]\.regex: unknown_field/);
  const forb = enc('{"__proto__":{"x":1}}');
  by_attr('id', 'import-profile-file').files = [{ name: 'p2.json', size: forb.length, arrayBuffer: async () => forb.buffer.slice(forb.byteOffset, forb.byteOffset + forb.byteLength) }];
  by_attr('id', 'import-profile-file').listeners.change[0]({});
  await settle();
  assert.match(text_of('main'), /запрещённое имя поля/);
  assert.equal({}.x, undefined);
});

test('REQ-091 в интерфейсе: «12,50» при thousands="," не становится 1250,00 — строка названа отклонённой', async () => {
  await to_file_step();
  await go('#data'); // перерисовка экрана: состояние мастера сохраняется
  const w = by_attr('id', 'import-check') === undefined ? null : true;
  if (w === null) await to_file_step();
  const csv = enc('Date,Description,Amount,Currency\n2026-09-02,Один,"12,50",EUR\n2026-09-02,Два,12.50,EUR\n');
  await pick('import-file', 'сумма.csv', csv);
  await click(by_attr('id', 'import-check'));
  assert.match(text_of('main'), /распознано 1 · отклонено 1 · дубликатов 0/);
  assert.match(text_of('main'), /сумма не разобрана/);
  assert.match(text_of('main'), /Итог по распознанным строкам: .*12,50/);
  assert.ok(!/1[  ]?250,00/.test(text_of('main').split('Итог по распознанным')[1]?.slice(0, 40) ?? ''), '1250,00 не появилось');
});

test('REQ-099 в интерфейсе: вкладка hledger — «@» даёт отказ E_SCHEMA и строку «не поддержано», журнал с двумя ногами проходит сухой прогон и откатывается', async () => {
  const ctx = ext.ctx;
  await click(by_attr('id', 'import-tab-hledger'));
  assert.match(text_of('main'), /Файл hledger/);
  assert.match(text_of('main'), /не переносятся: журнал с ними отклоняется целиком/);
  const h0 = hash();
  const bad = enc('2026-09-01 Покупка\n    assets:bank    -100 EUR\n    assets:broker  10 STK @ 10 EUR\n');
  await pick('import-hl-file', 'плохой.journal', bad);
  assert.match(text_of('main'), /Журнал отклонён целиком: неподдерживаемых конструкций — 1\. Ничего не записано\. \(E_SCHEMA\)/);
  assert.match(text_of('main'), /Не поддержано: 1/);
  assert.match(text_of('main'), /Строка 3: не поддержано — цена за единицу «@» не поддерживается/);
  assert.equal(by_attr('id', 'import-confirm'), undefined, 'подтверждать нечего');
  assert.equal(hash(), h0);
  // «@@» и три активные ноги — тоже явный отказ
  await click(by_text('button', 'Другой файл'));
  const bad2 = enc('2026-09-01 А\n    assets:a   -30 EUR\n    assets:b   -30 EUR\n    assets:c   60 EUR\n\n2026-09-02 Б\n    assets:a   -10 EUR\n    assets:x   1 STK @@ 10 EUR\n');
  await pick('import-hl-file', 'плохой2.journal', bad2);
  assert.match(text_of('main'), /Не поддержано: 2/);
  assert.match(text_of('main'), /Строка 1: не поддержано — больше двух активных ног/);
  assert.match(text_of('main'), /Строка 8: не поддержано — общая цена «@@» не поддерживается/);
  assert.equal(hash(), h0);

  // журнал с двумя ногами
  await click(by_text('button', 'Другой файл'));
  const ok = enc('2026-09-01 Зарплата\n    assets:bank    1000,00 EUR\n    income:salary\n\n2026-09-03 Перевод\n    assets:savings    200,00 EUR\n    assets:bank\n');
  await pick('import-hl-file', 'хороший.journal', ok);
  const main = text_of('main');
  assert.match(main, /распознано 3 · отклонено 0 · дубликатов 0/);
  assert.match(main, /Новых счетов: 2/);
  assert.equal(hash(), h0, 'сухой прогон данные не меняет');
  const acc0 = ctx.get_ws().accounts.length;
  await click(by_attr('id', 'import-confirm'));
  assert.equal(ctx.get_ws().accounts.length, acc0 + 2);
  assert.match(text_of('main'), /Партия записана/);
  assert.notEqual(hash(), h0);
  await click(by_attr('id', 'import-rollback'));
  assert.equal(hash(), h0, 'откат партии вернул state_hash, счета убраны вместе с партией');
  assert.equal(ctx.get_ws().accounts.length, acc0);
});

test('смена набора данных (adopt) начинает мастер заново; английские строки отчёта на месте', async () => {
  const { t } = await import(pathToFileURL(path.join(DEMO, 'i18n.mjs')).href);
  assert.equal(t('en', 'import.rep_line', { rec: 138, rej: 2, dup: 12 }), 'recognized 138 · rejected 2 · duplicates 12');
  assert.equal(t('ru', 'import.rep_line', { rec: 138, rej: 2, dup: 12 }), 'распознано 138 · отклонено 2 · дубликатов 12');
  await click(by_attr('id', 'import-tab-csv'));
  await to_file_step();
  assert.match(text_of('main'), /Шаг 1: Файл/);
  // adopt: состояние мастера сбрасывается
  await pick('import-file', 'a.csv', HEAD12);
  assert.match(text_of('main'), /Шаг 2: Колонки/);
  ext.reset(ext.ctx.get_ws());
  ext.ctx.set_ws(ext.ctx.get_ws(), { reason: 'refresh' });
  await go('#data');
  assert.match(text_of('main'), /Шаг 1: Файл/);
});

test('чистые помощники экрана: размер файла, текст отказа без значений из файла, деньги и даты по языку', () => {
  assert.equal(W.size_text(500, 'ru'), '500 Б');
  assert.equal(W.size_text(1536, 'ru'), '1,5 КБ');
  assert.equal(W.size_text(1536, 'en'), '1.5 KB');
  assert.equal(W.size_text(3 * 1024 * 1024, 'ru'), '3,0 МБ');
  const tr = (k, p) => k + JSON.stringify(p ?? {});
  assert.match(W.error_text(tr, { code: 'E_SCHEMA', ctx: { reason: 'file_too_large' } }), /^import\.err_file_too_large\{"mb":5.*\(E_SCHEMA\)$/);
  assert.match(W.error_text(tr, { code: 'E_SCHEMA', ctx: { reason: 'неизвестная причина' } }), /^import\.err_other/);
  assert.equal(W.error_text(tr, null), '');
  assert.deepEqual(W.report_numbers({ recognized: 138, rejected: 2, duplicates: 12, rows_total: 152 }), { rec: 138, rej: 2, dup: 12, total: 152 });
  assert.match(W.money_text('ru', -1250, 'EUR', '2026-10-04'), /12,50/);
  assert.match(W.money_text('en', -1250, 'EUR', '2026-10-04'), /12\.50/);
  assert.equal(W.date_text('ru', null, null), '—');
});
