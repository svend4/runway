// import_runway_boot.test.mjs — FP-18 в настоящем app.mjs (заглушка DOM, браузера нет): собственный CSV Runway в мастере импорта.
// REQ-095: выгрузка приложения читается профилем «Собственный формат Runway» (выбран сам, подсказка на экране), суммы верные, строки плана пропущены, повторный импорт даёт 0 новых;
// предупреждения сухого прогона об единицах суммы видны в отчёте; REQ-091: большой файл проверяется «в фоне» (в Node воркера нет — откат на главный поток, экран показывает
// «Проверяю файл» и не принимает второй запуск), устаревший отчёт большого файла пересчитывается в фоне с сохранением решений.
// Чистая модель: import_runway_csv.test.mjs; воркер: import_worker.test.mjs. Расчёт по введённым данным и правилам, не консультация.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/import_runway_boot.test.mjs

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
const { state_hash } = await import(pathToFileURL(path.join(HERE, '..', 'engine', 'index.mjs')).href);
const { t } = await import(pathToFileURL(path.join(DEMO, 'i18n.mjs')).href);
await import(pathToFileURL(path.join(DEMO, 'app.mjs')).href); // getElementById('app-title') !== null → boot() запускается сам
await new Promise((r) => setTimeout(r, 500)); // boot асинхронный: манифест пакетов, набор данных, boot-хуки

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
const choose = async (id, value) => {
  const sel = by_attr('id', id);
  assert.ok(sel !== undefined, 'нет списка ' + id);
  sel.value = value;
  sel.listeners.change[0]({});
  await settle();
};
/** Ждать, пока текст страницы не совпадёт (фоновая проверка идёт сама, без нажатий). */
async function until(re, ms = 8000) {
  const t0 = Date.now();
  while (!re.test(text_of('main'))) {
    if (Date.now() - t0 > ms) assert.fail('не дождались ' + re + '; на экране: ' + text_of('main').slice(0, 400));
    await settle(20);
  }
}
/** Ждать конца фоновой проверки: баннер «Проверяю файл» исчез. */
async function until_idle(ms = 8000) {
  const t0 = Date.now();
  while (by_attr('id', 'import-checking') !== undefined) {
    if (Date.now() - t0 > ms) assert.fail('проверка в фоне не закончилась');
    await settle(20);
  }
}
async function to_file_step() {
  const again = by_text('button', 'Другой файл');
  if (again !== undefined) await click(again);
}

const norm_note = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().normalize('NFC');
function facts_hash(ws) {
  const rows = ws.facts.map((f) => ({ account_id: f.account_id, date: f.date, amount_minor: f.amount_minor, currency: f.currency, note: norm_note(f.note) }));
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.amount_minor - b.amount_minor) || (a.note < b.note ? -1 : a.note > b.note ? 1 : 0)));
  return state_hash({ facts: Object.fromEntries(rows.map((r, i) => ['f' + String(i).padStart(5, '0'), r])) });
}

const WS0 = structuredClone(ext.ctx.get_ws()); // набор G-001, загруженный приложением
const RUNWAY_TEXT = DA.export_csv_file(WS0).text;

test('boot: набор G-001 загружен, экран «Данные» содержит мастер импорта; факты и якорь на месте', async () => {
  assert.equal(WS0.facts.length, 28);
  await go('#data');
  assert.match(text_of('main'), /Импорт из файла/);
  assert.ok(by_attr('id', 'import-file') !== undefined);
});

test('REQ-095 FP-18 в интерфейсе: выгрузка Runway → профиль «Собственный формат Runway» выбран сам, на экране подсказка; сухой прогон: суммы верные, строка плана пропущена профилем, предупреждений нет; запись и повтор', async () => {
  const ctx = ext.ctx;
  // «чистая» рабочая область: те же счета и якоря, фактов нет (файл Runway переносят в новую область)
  const cleared = ctx.set_ws({ ...ctx.get_ws(), facts: [] }, { reason: 'edit' });
  assert.ok(cleared.ok, JSON.stringify(cleared.error));
  await go('#data');
  await to_file_step();
  await pick('import-file', 'runway-csv-2026-10-04.csv', enc(RUNWAY_TEXT));
  assert.match(text_of('main'), /Шаг 2: Колонки/);
  const prof = by_attr('id', 'import-profile');
  assert.equal(prof.value, 'runway-csv-1', 'профиль определён по заголовку');
  const opts = find_all(prof, (n) => n.tagName === 'option').map((o) => o.textContent);
  assert.ok(opts.some((o) => /Собственный формат Runway/.test(o)));
  const hint = by_attr('id', 'import-runway-hint');
  assert.ok(hint !== undefined, 'подсказка про файл Runway');
  assert.match(hint.textContent, /Файл выгружен самим Runway: суммы в минимальных единицах \(4730 означает 47,30\)/);
  // FP-47 (намеренное изменение ожидания): метки и контрагенты теперь возвращаются; название экрана прямо говорит, что номер счёта и вид файла не читаются
  assert.match(hint.textContent, /Метки и контрагенты возвращаются из своих колонок/);
  assert.match(hint.textContent, /Номер счёта \(account_id\) и вид операции \(kind\) файла не читаются/);
  assert.match(hint.textContent, /переводы CSV не переносит/);
  assert.match(text_of('main'), /Сумма: колонка amount_minor, целое число в минимальных единицах/);
  assert.match(text_of('main'), /Берутся строки, где layer = «posted»/);
  const h0 = M.ws_state_hash(ctx.get_ws());

  await click(by_attr('id', 'import-check'));
  const main = text_of('main');
  assert.match(main, /распознано 28 · отклонено 1 · дубликатов 0/);
  assert.match(main, /Строк в файле: 29 = 28 \+ 1 \+ 0\./);
  assert.match(main, /Строк другого слоя \(плановых\), пропущено профилем: 1/);
  assert.match(main, /Итог по распознанным строкам: .*1\s?920,00/, 'итог 1 920,00 €, а не 192 000,00 €');
  assert.ok(!/192\s?000,00/.test(main));
  assert.equal(by_attr('id', 'import-warn-minor_as_major'), undefined);
  assert.equal(by_attr('id', 'import-warn-amount_scale'), undefined);
  assert.match(main, /25,00/, 'первая строка предпросмотра: 25,00 €');
  assert.ok(!/2\s?500,00/.test(main.split('Что будет записано')[1] ?? ''), 'в предпросмотре нет сумм в 100 раз больше');
  assert.equal(M.ws_state_hash(ctx.get_ws()), h0, 'сухой прогон данные не меняет');

  await click(by_attr('id', 'import-confirm'));
  assert.equal(ctx.get_ws().facts.length, 28);
  assert.equal(facts_hash(ctx.get_ws()), facts_hash(WS0), 'тот же состав фактов, что в исходном наборе');
  assert.match(text_of('main'), /Записано фактов: 28/);

  // повторный импорт того же файла
  await to_file_step();
  await pick('import-file', 'runway-csv-2026-10-04.csv', enc(RUNWAY_TEXT));
  assert.equal(by_attr('id', 'import-profile').value, 'runway-csv-1');
  await click(by_attr('id', 'import-check'));
  assert.match(text_of('main'), /распознано 0 · отклонено 1 · дубликатов 28/);
  assert.notEqual(by_attr('id', 'import-confirm').attrs.disabled, undefined, '«Подтвердить» недоступна: записывать нечего');
});

test('REQ-095 FP-18 в интерфейсе: «Свои колонки» на файле Runway — единицы суммы «минимальные» подставлены сами; выбор «основные» даёт предупреждения в отчёте (название колонки и масштаб сумм), возврат убирает их', async () => {
  const ctx = ext.ctx;
  await to_file_step();
  await pick('import-file', 'runway.csv', enc(RUNWAY_TEXT));
  await choose('import-profile', 'custom');
  const unit = by_attr('id', 'import-amount-unit');
  assert.ok(unit !== undefined, 'список «Единицы суммы» в форме колонок');
  assert.equal(unit.value, 'minor');
  assert.match(text_of('main'), /Единицы суммы/);
  assert.match(text_of('main'), /минимальные \(1250 означает 12,50\)/);
  // сначала «как основные» — так мастер читал этот файл раньше
  await choose('import-amount-unit', 'major');
  assert.equal(by_attr('id', 'import-amount-unit').value, 'major');
  await click(by_attr('id', 'import-check'));
  const w1 = by_attr('id', 'import-warn-minor_as_major');
  assert.ok(w1 !== undefined, 'предупреждение о названии колонки');
  assert.equal(w1.attrs.role, 'alert');
  assert.match(w1.textContent, /колонка суммы «amount_minor» названа как минимальные единицы/);
  assert.match(w1.textContent, /завышенными в 100 раз/);
  const w2 = by_attr('id', 'import-warn-amount_scale');
  assert.ok(w2 !== undefined, 'предупреждение о масштабе сумм');
  assert.match(w2.textContent, /самая крупная сумма в файле — .*288\s?000,00.* примерно в \d+ раз больше остатка/);
  assert.match(text_of('main'), /Итог по распознанным строкам: .*192\s?000,00/, 'неверный итог виден — и сопровождён предупреждением');
  // исправили единицы — предупреждений нет, итог верный
  await click(by_text('button', 'Назад'));
  await choose('import-amount-unit', 'minor');
  await click(by_attr('id', 'import-check'));
  assert.equal(by_attr('id', 'import-warn-minor_as_major'), undefined);
  assert.equal(by_attr('id', 'import-warn-amount_scale'), undefined);
  assert.match(text_of('main'), /Итог по распознанным строкам: .*1\s?920,00/);
  assert.equal(ctx.get_ws().facts.length, 28, 'ничего не записано: это сухой прогон');
});

test('REQ-091 FP-18 в интерфейсе: файл банка от 128 КБ проверяется «в фоне» (в Node воркера нет — откат на главный поток): экран показывает «Проверяю файл», кнопка недоступна, затем отчёт тот же, что при разборе на месте', async () => {
  const ctx = ext.ctx;
  const rows = ['Date,Description,Amount,Currency'];
  for (let i = 0; i < 3300; i++) rows.push(`2026-0${1 + (i % 9)}-${String(1 + (i % 28)).padStart(2, '0')},"Покупка у партнёра №${i % 313}, касса ${i % 17}",-${1 + (i % 90)}.${String(i % 100).padStart(2, '0')},EUR`);
  const big = enc(rows.join('\n') + '\n');
  assert.ok(big.length >= M.WORKER_MIN_BYTES, 'файл не меньше порога: ' + big.length);
  const before = ctx.get_ws();
  await go('#data');
  await to_file_step();
  await pick('import-file', 'год.csv', big);
  assert.equal(by_attr('id', 'import-profile').value, 'csv-generic');
  // нажатие: разбор ушёл в фон, экран уже показывает состояние ожидания
  by_attr('id', 'import-check').listeners.click[0]({ preventDefault() {} });
  assert.match(text_of('main'), /Проверяю файл в фоне\. Данные не изменены\./);
  assert.ok(by_attr('id', 'import-checking') !== undefined);
  assert.notEqual(by_attr('id', 'import-check').attrs.disabled, undefined, 'второй запуск не принимается');
  await until(/распознано \d+ · отклонено \d+ · дубликатов \d+/);
  assert.equal(by_attr('id', 'import-checking'), undefined);
  assert.match(text_of('main'), /Строк в файле: 3300 = /);
  const expected = M.plan_csv(ctx.get_ws(), { text: new TextDecoder().decode(big), bytes: big, name: 'год.csv', profile: M.BUILTIN_PROFILES['csv-generic'], account_id: 'acc_main' }).plan.report;
  assert.ok(text_of('main').includes(`распознано ${expected.recognized} · отклонено ${expected.rejected} · дубликатов ${expected.duplicates}`), 'числа отчёта те же, что при разборе на месте');
  assert.equal(M.ws_state_hash(ctx.get_ws()), M.ws_state_hash(before), 'проверка данные не меняет');
  assert.equal(by_attr('id', 'import-confirm').attrs.disabled, undefined, 'кнопка записи доступна');
});

test('REQ-091 FP-18 в интерфейсе: отчёт большого файла устарел (данные изменились) — он пересчитывается в фоне (решения о двойниках сохраняются — import_runway_csv.test), «Подтвердить» на время пересчёта недоступна', async () => {
  const ctx = ext.ctx;
  // отчёт большого файла уже на экране (предыдущий тест); меняем данные тем же путём, что пользователь
  assert.match(text_of('main'), /распознано \d+ · отклонено \d+ · дубликатов \d+/);
  const before = text_of('main');
  const w = ctx.get_ws();
  const r = ctx.set_ws({ ...w, facts: [...w.facts, { event_id: 'tx_fp18_new', account_id: 'acc_main', date: '2026-10-01', amount_minor: -123, currency: 'EUR', kind: 'expense', note: 'новый факт' }] }, { reason: 'edit' });
  assert.ok(r.ok, JSON.stringify(r.error));
  await go('#data');
  // сразу после смены данных идёт пересчёт в фоне: пока он не закончился, запись недоступна
  if (by_attr('id', 'import-checking') !== undefined) assert.notEqual(by_attr('id', 'import-confirm').attrs.disabled, undefined, 'во время пересчёта запись недоступна');
  await until_idle();
  assert.match(text_of('main'), /распознано \d+ · отклонено \d+ · дубликатов \d+/);
  assert.match(text_of('main'), /Строк в файле: 3300 = /);
  assert.notEqual(text_of('main'), before, 'отчёт пересчитан по новым данным');
  // отчёт свежий: рабочая область — та, по которой он построен (иначе «Подтвердить» отказала бы stale_plan)
  await click(by_attr('id', 'import-confirm'));
  assert.match(text_of('main'), /Партия записана/);
  assert.ok(ctx.get_ws().facts.length > 3000, 'партия большого файла записана: ' + ctx.get_ws().facts.length);
});

test('FP-18 строки каталога: предупреждения, подсказки и состояния проверки есть на RU и EN; числа подставляются', () => {
  const warn_ru = t('ru', 'import.w_minor_as_major', { col: 'amount_minor', factor: 100 });
  const warn_en = t('en', 'import.w_minor_as_major', { col: 'amount_minor', factor: 100 });
  assert.match(warn_ru, /«amount_minor».*в 100 раз/);
  assert.match(warn_en, /"amount_minor".*100 times/);
  assert.match(t('ru', 'import.w_amount_scale', { peak: '288 000,00 €', ref: '4 000,00 €', ratio: 72 }), /288 000,00 €.*72 раз.*4 000,00 €/);
  assert.match(t('en', 'import.w_amount_scale', { peak: '€288,000.00', ref: '€4,000.00', ratio: 72 }), /€288,000\.00.*72 times.*€4,000\.00/);
  for (const key of ['import.pf_runway_csv_1', 'import.runway_hint', 'import.checking', 'import.checked', 'import.rep_filtered', 'import.f_amount_unit', 'import.au_major', 'import.au_minor', 'import.au_hint', 'import.ps_amount_minor', 'import.ps_filter']) {
    assert.notEqual(t('ru', key, { n: 1, col: 'c', equals: 'e' }), key, key);
    assert.notEqual(t('en', key, { n: 1, col: 'c', equals: 'e' }), key, key);
  }
  assert.equal(t('en', 'import.rep_filtered', { n: 2 }), 'Rows of another layer (plans) skipped by the profile: 2. They are not recorded as facts.');
});
