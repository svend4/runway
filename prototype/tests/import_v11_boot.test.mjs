// import_v11_boot.test.mjs — FP-29 в настоящем app.mjs (заглушка DOM, браузера нет): часы из CSV и обмены двумя ногами в мастере импорта, «Валюта решения» в «Настройках».
// Пакеты pack_fp06, pack_fp03 и pack_fp29 подхватываются манифестом; запись идёт общим путём ctx.set_ws, журнал и «Отменить» следуют. Чистая модель: import_v11.test.mjs, decision_currency.test.mjs.
// Расчёт по введённым данным и правилам, не консультация.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/import_v11_boot.test.mjs

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
const M = await import(pathToFileURL(path.join(DEMO, 'import_model.mjs')).href);
const V = await import(pathToFileURL(path.join(DEMO, 'import_v11.mjs')).href);
const { events_to_ws } = await import(pathToFileURL(path.join(DEMO, 'ws_bridge.mjs')).href);
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
const submit = (id) => { const f = by_attr('id', id); assert.ok(f !== undefined, 'нет формы ' + id); f.listeners.submit[0]({ preventDefault() {} }); };
async function to_file_step() {
  const again = by_text('button', 'Другой файл');
  if (again !== undefined) await click(again);
}

const ctx = ext.ctx;
const WS0 = structuredClone(ctx.get_ws()); // набор G-001, загруженный приложением
const reset = async (ws = WS0) => { const r = ctx.adopt(structuredClone(ws), { source: 'test' }); assert.equal(r.ok, true, JSON.stringify(r.error)); };
const USD = { account_id: 'acc_usd', name: 'Доллары', kind: 'bank', liquidity: 'operating', currency: 'USD', exponent: 2, liquidity_bp: 0 };
const RATE = { fx_id: 'fx1', date: '2026-10-01', base: 'USD', quote: 'EUR', num: 9200, den: 10000, source: 'manual' };
const WFX = { ...WS0, accounts: [...WS0.accounts, USD], rates: [RATE] };
/** Курс введён в день расчёта: на дату строк файла (2–3 октября) курса пары ещё нет, а расчёт страницы на сегодня проходит. */
const WLATE = { ...WFX, rates: [{ ...RATE, date: '2026-10-04' }] };

const HOURS_TEXT = 'date,hours\n2026-09-03,8\n2026-09-04,7.5\n2026-09-05,100\n2026-10-02,6.33\n2026-11-02,5\nxx,3\n2026-09-06,\n';
const FX_TEXT = 'date,amount_minor,currency,note,counter_amount_minor,counter_currency\n2026-10-02,-100000,USD,Обмен в евро,92400,EUR\n2026-10-03,50000,USD,Обратно,-46000,EUR\n2026-10-03,-1000,USD,Нет второй ноги,,\n2026-10-03,-1000,GBP,Фунты,900,EUR\n2026-10-03,1500,EUR,Обычная строка,,\n';

test('boot: пакет pack_fp29 подхвачен манифестом; в мастере рядом со встроенными профилями есть «Часы» и «Обмен двумя ногами»', async () => {
  const diag = ext.diagnostics().filter((d) => d.pack === 'pack_fp29');
  assert.deepEqual(diag.map((d) => d.status), ['ok'], JSON.stringify(ext.diagnostics()));
  await go('#data');
  await pick('import-file', 'hours.csv', enc(HOURS_TEXT));
  const opts = find_all(by_attr('id', 'import-profile'), (n) => n.tagName === 'option').map((o) => [o.attrs.value, o.textContent]);
  assert.deepEqual(opts.map((o) => o[0]), ['custom', 'csv-generic', 'csv-semicolon-dmy', 'runway-csv-1', 'hours-csv-1', 'fx-rows-csv-1']);
  assert.match(opts.find((o) => o[0] === 'hours-csv-1')[1], /^Часы: дата и отработанные часы/);
  assert.match(opts.find((o) => o[0] === 'fx-rows-csv-1')[1], /^Обмен двумя ногами/);
  await to_file_step();
});

test('A07.7 в интерфейсе: файл с часами — профиль «Часы» выбран сам, описание профиля и выбор потока; сухой прогон: периоды «было → станет», округление и замена названы; данные не меняются', async () => {
  await reset();
  await go('#data');
  await to_file_step();
  await pick('import-file', 'hours.csv', enc(HOURS_TEXT));
  assert.match(text_of('main'), /Шаг 2: Колонки/);
  assert.equal(by_attr('id', 'import-profile').value, 'hours-csv-1');
  assert.match(text_of('main'), /Часы: колонка hours, десятичные часы/);
  assert.match(text_of('main'), /Поток: колонка stream/);
  assert.match(by_attr('id', 'import-hours-hint').textContent, /итог периода заменяет записанное «отработано»/);
  assert.equal(by_attr('id', 'import-hours-stream').value, 'S-HOURLY', 'поток один — выбран сам');
  const h0 = M.ws_state_hash(ctx.get_ws());
  await click(by_attr('id', 'import-check'));
  const main = text_of('main');
  assert.match(main, /распознано 4 · отклонено 3 · дубликатов 0/);
  assert.match(main, /Строк в файле: 7 = 4 \+ 3 \+ 0\./);
  assert.match(main, /Что изменится: периодов 2/);
  assert.match(main, /96 ч/, 'было: 5760 минут');
  assert.match(main, /115 ч 30 мин/, 'станет: 6930 минут');
  assert.match(main, /не записано/, 'октябрь раньше не был записан');
  assert.ok(by_attr('id', 'import-warn-hours_rounded') !== undefined, 'округление дроби названо');
  assert.match(by_attr('id', 'import-warn-hours_rounded').textContent, /строках: 1/);
  assert.match(by_attr('id', 'import-hours-replaced').textContent, /Заменит уже записанное «отработано» в периодах: 1\./);
  assert.match(main, /период ещё не начался на дату расчёта/);
  assert.match(main, /пустая ячейка часов/);
  assert.match(by_attr('id', 'import-confirm').textContent, /записать 2/);
  assert.equal(M.ws_state_hash(ctx.get_ws()), h0, 'сухой прогон данные не меняет');
});

test('A07.7 REQ-093 в интерфейсе: «Подтвердить» пишет часы общим путём, партия видна в списке «Партии часов»; повторный импорт — 0 новых; «Откатить партию» возвращает данные', async () => {
  await reset();
  const h0 = M.ws_state_hash(ctx.get_ws());
  const n0 = ctx.journal.length;
  await go('#data');
  await to_file_step();
  await pick('import-file', 'hours.csv', enc(HOURS_TEXT));
  await click(by_attr('id', 'import-check'));
  await click(by_attr('id', 'import-confirm'));
  const ws = ctx.get_ws();
  assert.equal(ws.streams[0].hours_by_period['2026-09-01'].actual_minutes, 6930);
  assert.equal(ws.streams[0].hours_by_period['2026-10-01'].actual_minutes, 380);
  assert.equal(Object.keys(ws.hours_imports).length, 1);
  assert.ok(ctx.journal.length > n0, 'запись попала в журнал');
  assert.match(text_of('main'), /Записано периодов часов: 2\. Номер партии: imp_/);
  assert.match(text_of('main'), /прежние значения «отработано» вернутся/);
  assert.deepEqual(Object.keys(events_to_ws(ctx.journal.export().events).hours_imports), Object.keys(ws.hours_imports), 'партия записана в журнал: после перезагрузки из хранилища она на месте');
  assert.ok(by_attr('id', 'import-hours-batches') !== undefined, 'карточка «Партии часов»');
  assert.match(by_attr('id', 'import-hours-batches').textContent, /Партии часов/);
  assert.match(text_of('main'), /Уже записано|2026|Партия записана/);

  // повторный импорт того же файла
  await to_file_step();
  await pick('import-file', 'hours.csv', enc(HOURS_TEXT));
  await click(by_attr('id', 'import-check'));
  assert.match(text_of('main'), /распознано 0 · отклонено 3 · дубликатов 4/);
  assert.match(by_attr('id', 'import-hours-unchanged').textContent, /периодов 2/);
  assert.notEqual(by_attr('id', 'import-confirm').attrs.disabled, undefined, '«Подтвердить» недоступна: записывать нечего');

  // откат из списка партий (он работает и после перезагрузки страницы: партия лежит в данных)
  const batch_id = Object.keys(ctx.get_ws().hours_imports)[0];
  await click(by_attr('aria-label', 'Откатить партию ' + batch_id));
  assert.equal(M.ws_state_hash(ctx.get_ws()), h0, 'данные вернулись к состоянию до импорта');
  assert.equal('hours_imports' in ctx.get_ws(), false);
  assert.equal('hours_imports' in events_to_ws(ctx.journal.export().events), false, 'откат записан и в журнал: после перезагрузки партии нет');
  assert.equal(by_attr('id', 'import-hours-batches'), undefined, 'партии больше нет в списке');
  assert.match(text_of('main'), new RegExp('Партия ' + batch_id + ' откатена: возвращено периодов 2\\.'));
});

test('A07.7 фокус (урок проходов в браузере): «Подтвердить» и «Откатить партию» убирают нажатую кнопку, хранилище просит ещё одну перерисовку позже — фокус возвращается на заголовок мастера и после неё; выбор в списке возвращает фокус списку с тем же id', async () => {
  await reset();
  const focused = [];
  const real_get = globalThis.document.getElementById;
  const real_active = Object.getOwnPropertyDescriptor(globalThis.document, 'activeElement');
  globalThis.document.getElementById = (id) => (id === 'import-title' || id === 'import-hours-stream' ? { id, focus() { focused.push(id); } } : real_get(id));
  try {
    await go('#data');
    await to_file_step();
    await pick('import-file', 'hours.csv', enc(HOURS_TEXT));
    await click(by_attr('id', 'import-check'));
    focused.length = 0;
    await click(by_attr('id', 'import-confirm'));
    ctx.refresh(); // поздняя перерисовка от хранилища (FP-05)
    await settle();
    assert.ok(focused.includes('import-title'), 'после «Подтвердить» фокус возвращён заголовку мастера: ' + focused.join(','));
    focused.length = 0;
    const batch_id = Object.keys(ctx.get_ws().hours_imports)[0];
    await click(by_attr('aria-label', 'Откатить партию ' + batch_id));
    ctx.refresh();
    await settle();
    assert.ok(focused.includes('import-title'), 'после «Откатить партию» фокус возвращён заголовку мастера: ' + focused.join(','));
    // выбор в списке: активный элемент — список в мастере, перерисовка его заменяет
    await to_file_step();
    await pick('import-file', 'hours.csv', enc(HOURS_TEXT));
    const wizard = find_all(byid.get('main'), (n) => n.className === 'card import-wizard')[0];
    const active = { id: 'import-hours-stream' }; // у заглушки узла нет свойства id: активный элемент настоящего браузера его имеет
    wizard.contains = (n) => n === active;
    let reads = 0; // первое чтение — перед перерисовкой (список в фокусе), дальше список заменён и фокус потерян (на body)
    Object.defineProperty(globalThis.document, 'activeElement', { get: () => (reads++ === 0 ? active : undefined), configurable: true });
    focused.length = 0;
    await choose('import-hours-stream', 'S-HOURLY');
    assert.ok(focused.includes('import-hours-stream'), 'после выбора фокус возвращён списку с тем же id: ' + focused.join(','));
  } finally {
    globalThis.document.getElementById = real_get;
    if (real_active === undefined) delete globalThis.document.activeElement; else Object.defineProperty(globalThis.document, 'activeElement', real_active);
  }
  await reset();
});

test('A07.7 в интерфейсе: профиль «Часы» выбран вручную на чужом файле — отказ с причиной (нет колонки), а не молчаливая потеря; нет потоков — подсказка, куда идти', async () => {
  await reset();
  await go('#data');
  await to_file_step();
  await pick('import-file', 'bank.csv', enc('Date,Description,Amount,Currency\n2026-10-01,Кофе,-3.50,EUR\n'));
  assert.equal(by_attr('id', 'import-profile').value, 'csv-generic');
  await choose('import-profile', 'hours-csv-1');
  assert.ok(by_attr('id', 'import-hours-stream') !== undefined);
  await click(by_attr('id', 'import-check'));
  assert.ok(by_attr('id', 'import-error') !== undefined);
  assert.match(by_attr('id', 'import-error').textContent, /Профиль называет колонку, которой нет в заголовке файла/);
  await reset({ ...WS0, streams: [] });
  await go('#data');
  await to_file_step();
  await pick('import-file', 'hours.csv', enc(HOURS_TEXT));
  assert.match(by_attr('id', 'import-hours-nostreams').textContent, /нет потоков часов/);
  await click(by_attr('id', 'import-check'));
  assert.ok(by_attr('id', 'import-hours-nostreams') !== undefined);
  assert.notEqual(by_attr('id', 'import-confirm').attrs.disabled, undefined);
  await reset();
});

test('A14.7 A08.3 в интерфейсе: файл с обменами — профиль «Обмен двумя ногами» выбран сам; отчёт показывает курс обмена, курс из данных и справочную разницу; записываются две ноги; повторный импорт — 0 новых; откат', async () => {
  await reset(WFX);
  const h0 = M.ws_state_hash(ctx.get_ws());
  await go('#data');
  await to_file_step();
  await pick('import-file', 'fx.csv', enc(FX_TEXT));
  assert.equal(by_attr('id', 'import-profile').value, 'fx-rows-csv-1');
  assert.match(by_attr('id', 'import-fx-hint').textContent, /записывается обменом между двумя вашими счетами/);
  assert.equal(by_attr('id', 'import-fx-counter').value, '', 'счёт второй ноги — единственный счёт в валюте');
  await click(by_attr('id', 'import-check'));
  const main = text_of('main');
  assert.match(main, /распознано 3 · отклонено 2 · дубликатов 0/);
  assert.match(main, /Обмены двумя ногами: 2/);
  assert.match(main, /курс: 1 USD = 0,924 EUR/, 'курс обмена выведен из ног: 924,00 € за 1 000,00 $');
  assert.match(main, /курс: 1 USD = 0,9200 EUR/, 'курс из данных');
  assert.match(main, /получено на 4,00.*больше, чем по курсу из данных/);
  assert.match(main, /совпадает с курсом из данных/);
  assert.match(main, /в «свободно» она не входит/);
  assert.match(main, /нет суммы или валюты второй ноги/);
  assert.match(main, /нет единственного открытого счёта в валюте операции; счёт выбирается в списке выше/);
  assert.equal(M.ws_state_hash(ctx.get_ws()), h0);
  await click(by_attr('id', 'import-confirm'));
  const added = ctx.get_ws().facts.filter((f) => f.batch_id !== undefined);
  assert.equal(added.length, 5);
  assert.equal(added.filter((f) => f.kind === 'transfer').length, 4);
  const batch_id = added[0].batch_id;
  assert.match(text_of('main'), /Записано фактов: 5/);

  await to_file_step();
  await pick('import-file', 'fx.csv', enc(FX_TEXT));
  await click(by_attr('id', 'import-check'));
  assert.match(text_of('main'), /распознано 0 · отклонено 2 · дубликатов 3/);

  await click(by_attr('aria-label', 'Откатить партию ' + batch_id));
  assert.equal(M.ws_state_hash(ctx.get_ws()), h0, 'обе ноги каждого обмена убраны');
  await reset();
});

test('A08.2 в интерфейсе: нет курса USD → EUR — плашка называет пару и место ввода курса (Формы данных → Курсы и обмен); обмены не записываются', async () => {
  await reset(WLATE);
  await go('#data');
  await to_file_step();
  await pick('import-file', 'fx.csv', enc(FX_TEXT));
  await click(by_attr('id', 'import-check'));
  const warn = by_attr('id', 'import-fx-norate');
  assert.ok(warn !== undefined, 'плашка «нет курса»');
  assert.equal(warn.attrs.role, 'alert');
  assert.equal(warn.attrs['data-pair'], 'USD/EUR');
  assert.match(warn.textContent, /Нет курса USD → EUR/);
  assert.match(warn.textContent, /Формы данных → Курсы и обмен/);
  assert.match(text_of('main'), /нет курса валюты операции к валюте решения/);
  assert.match(text_of('main'), /распознано 1 · отклонено 4/);
  await reset();
});

test('A14.7 в интерфейсе: «Свои колонки» — переключатель «Строки в другой валюте — обмен двумя ногами» открывает выбор колонок второй ноги; без него строки отклоняются как раньше', async () => {
  await reset(WFX);
  await go('#data');
  await to_file_step();
  const text = 'Datum;Betrag;Währung;Text;Gegenwert;Währung 2\n02.10.2026;-1.000,00;USD;Tausch;924,00;EUR\n03.10.2026;-12,50;EUR;Kaffee;;\n';
  await pick('import-file', 'bank.csv', enc(text));
  assert.equal(by_attr('id', 'import-profile').value, 'custom');
  const cb = by_attr('id', 'import-fx-on');
  assert.ok(cb !== undefined, 'переключатель обмена');
  assert.equal(by_attr('id', 'import-fx-amount-col'), undefined, 'колонки второй ноги скрыты, пока переключатель выключен');
  await click(by_attr('id', 'import-check'));
  assert.match(text_of('main'), /валюта не совпадает с валютой счёта/);
  await click(by_text('button', 'Назад'));
  by_attr('id', 'import-fx-on').checked = true;
  by_attr('id', 'import-fx-on').listeners.change[0]({});
  await settle();
  await choose('import-fx-amount-col', '4');
  await choose('import-fx-currency-col', '5');
  assert.equal(by_attr('id', 'import-fx-amount-unit').value, 'major');
  await click(by_attr('id', 'import-check'));
  assert.match(text_of('main'), /Обмены двумя ногами: 1/);
  assert.match(text_of('main'), /распознано 2 · отклонено 0 · дубликатов 0/);
  await reset();
});

// ── «Настройки»: валюта решения ──────────────────────────────────────────────────────────────────────────────────────

/** G-001 без резервов (они заведены в евро), со счётом в долларах на накопительном и курсом USD → EUR. */
const WDC = { ...WS0, reserves: [], allocations: [], tax_rules: [], accounts: [...WS0.accounts, { ...USD, liquidity: 'savings' }], rates: [RATE] };

test('A08.7 «Настройки»: форма «Валюта решения» — выбор из валют счетов и курсов, курсы нужных пар показаны; запись меняет расчёт (шапка, модель), журнал и «Отменить» следуют', async () => {
  await reset(WDC);
  await go('#settings');
  const main0 = text_of('main');
  assert.match(main0, /Валюта решения/);
  assert.match(main0, /Сейчас расчёт идёт в валюте EUR\./);
  const sel = by_attr('id', 'set-dcur');
  assert.ok(sel !== undefined);
  assert.deepEqual(find_all(sel, (n) => n.tagName === 'option').map((o) => o.attrs.value), ['EUR', 'USD']);
  assert.equal(sel.value, 'EUR');
  assert.match(by_attr('id', 'set-dcur-pairs').textContent, /Курс USD → EUR: 0,9200 от 2026-10-01\./);
  sel.value = 'USD';
  sel.listeners.change[0]({});
  assert.match(by_attr('id', 'set-dcur-pairs').textContent, /Курс EUR → USD: 1,0870 от 2026-10-01|Курс EUR → USD: .* от 2026-10-01/);
  const n0 = ctx.journal.length;
  submit('settings-dcur');
  assert.equal(ctx.get_ws().decision_currency, 'USD');
  assert.equal(ctx.get_ws().params.decision_currency, 'USD');
  assert.equal(ctx.get_model().cur, 'USD', 'пересчёт страницей идёт в выбранной валюте');
  assert.equal(ctx.get_model().ctx.decision_currency, 'USD');
  assert.ok(ctx.journal.length > n0, 'запись попала в журнал');
  assert.match(text_of('main'), /Сейчас расчёт идёт в валюте USD\./);
  assert.match(text_of('main'), /Буфер сейчас: .* \(в USD\)\./, 'сумма буфера не пересчитана — об этом сказано');
  assert.match(text_of('main'), /Сохранено\./);
  assert.match(text_of('summary'), /\$|USD/, 'шапка в долларах');
  // та же валюта — «Значения не изменились.»
  submit('settings-dcur');
  assert.match(text_of('main'), /Значения не изменились\./);
  await reset();
});

test('A08.2 A08.7 «Настройки»: нет курса — отказ у поля с парой и путём к вводу курса, данные прежние; резерв в прежней валюте — свой понятный отказ; чужое значение списка не принимается', async () => {
  await reset({ ...WDC, rates: [] });
  await go('#settings');
  const h0 = M.ws_state_hash(ctx.get_ws());
  const n0 = ctx.journal.length;
  by_attr('id', 'set-dcur').value = 'USD';
  by_attr('id', 'set-dcur').listeners.change[0]({});
  submit('settings-dcur');
  const err = by_attr('id', 'set-dcur-err').textContent;
  assert.match(err, /Нет курса EUR → USD/);
  assert.match(err, /Формы данных → Курсы и обмен/);
  assert.equal(by_attr('id', 'set-dcur').attrs['aria-invalid'], 'true');
  assert.equal(M.ws_state_hash(ctx.get_ws()), h0);
  assert.equal(ctx.journal.length, n0);
  assert.equal(ctx.get_ws().decision_currency, 'EUR');
  assert.match(by_attr('id', 'set-dcur-pairs').textContent, /Нет курса EUR → USD: введите его/);

  by_attr('id', 'set-dcur').value = 'JPY';
  submit('settings-dcur');
  assert.match(by_attr('id', 'set-dcur-err').textContent, /Такой валюты нет в списке/);

  await reset({ ...WS0, accounts: [...WS0.accounts, { ...USD, liquidity: 'savings' }], rates: [RATE] }); // резервы в евро остались
  await go('#settings');
  by_attr('id', 'set-dcur').value = 'USD';
  submit('settings-dcur');
  assert.match(by_attr('id', 'set-dcur-err').textContent, /резерв в прежней валюте решения/);
  assert.equal(ctx.get_ws().decision_currency, 'EUR');
  await reset();
});

test('завершение: заглушки сняты, данные приложения возвращены', async () => {
  await reset();
  globalThis.fetch = real_fetch;
  assert.ok(true);
});
