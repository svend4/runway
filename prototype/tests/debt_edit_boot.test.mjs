// debt_edit_boot.test.mjs — FP-14 в настоящем app.mjs: пакет pack_fp14 подхвачен манифестом; экран «Долги» получает форму «Добавить в прогноз» и раздел «Долги в прогнозе»;
// добавление, перенос платежа, досрочное погашение, сверка с банком и удаление идут общим путём (ctx.edit → пересчёт страницы → журнал), «Отменить» и «Вернуть» откатывают
// каждое действие побайтно, платежи входят в «свободно», платежи за горизонтом дают плашку в шапке. Заглушка DOM минимальная: проверяется связка, не внешний вид.
// Браузер, сервер и сеть не используются. Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/debt_edit_boot.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(HERE, '..', 'demo');
const DATA = path.join(HERE, '..', 'data');

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
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() {}
  querySelectorAll() { return []; }
  walk(fn) { fn(this); for (const c of this.children) if (c.nodeType === 1) c.walk(fn); }
}
const byid = new Map();
function find_in(root, id) {
  let hit = null;
  if (root !== undefined) root.walk((n) => { if (hit === null && n.attrs.id === id) hit = n; });
  return hit;
}
for (const id of ['app-title', 'app-sub', 'skip', 'controls', 'nav', 'summary', 'main', 'footer', 'live', 'dlg', 'dlg-title', 'dlg-close', 'dlg-body']) byid.set(id, new Node_(id === 'dlg' ? 'dialog' : 'div'));
const listeners = {};
globalThis.document = {
  createElement: (t) => new Node_(t),
  createElementNS: (ns, t) => new Node_(t, ns),
  createTextNode: (data) => ({ nodeType: 3, data }),
  getElementById: (id) => byid.get(id) ?? find_in(byid.get('main'), id) ?? find_in(byid.get('nav'), id), // как в браузере: элемент страницы находится по id в любом месте дерева
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
globalThis.fetch = async (url) => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8')) });

const { ext } = await import(pathToFileURL(path.join(DEMO, 'ext.mjs')).href);
await import(pathToFileURL(path.join(DEMO, 'app.mjs')).href); // document.getElementById('app-title') !== null → boot() запускается сам
await new Promise((r) => setTimeout(r, 700)); // boot асинхронный: пакеты, набор данных, boot-хук

const E = await import('../engine/index.mjs');
const DE = await import('../engine/debt_ext.mjs');
const WE = await import(pathToFileURL(path.join(DEMO, 'ws_edit.mjs')).href);
const BR = await import(pathToFileURL(path.join(DEMO, 'ws_bridge.mjs')).href);
const I18N = await import(pathToFileURL(path.join(DEMO, 'i18n.mjs')).href);
const DB = await import(pathToFileURL(path.join(DEMO, 'debts.mjs')).href);
const APP = await import(pathToFileURL(path.join(DEMO, 'app.mjs')).href);
const CATALOG = (await import(pathToFileURL(path.join(DEMO, 'i18n', 'debtedit.mjs')).href)).default;

const NB = /[  ]/g;
const N = (x) => String(x).replace(NB, ' ');
const main = () => byid.get('main');
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const by_id = (id) => find_all(main(), (n) => n.attrs.id === id)[0];
const nav_button = (prefix) => find_all(byid.get('nav'), (n) => n.tagName === 'button' && N(n.textContent).startsWith(prefix))[0];
const click = (n) => { assert.ok(n !== undefined, 'нет узла'); assert.equal(n.hasAttribute('disabled'), false, 'кнопка недоступна: ' + n.attrs.id); n.listeners.click[0](); };
const type_into = (n, value, event = 'input') => { n.value = value; for (const fn of n.listeners[event] ?? []) fn({ target: n }); };
const choose = (n, value) => { n.value = value; for (const fn of n.listeners.change ?? []) fn({ target: n }); };
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };
const tick = () => new Promise((r) => setTimeout(r, 15));
const ctx = ext.ctx;
const canon = E.canon;
const clone = (x) => JSON.parse(JSON.stringify(x));
const money = (minor) => APP.make_fmt('ru', 'EUR', '2026-10-04').money(minor);
const G = JSON.parse(fs.readFileSync(path.join(DATA, 'g001.json'), 'utf8'));
const GD = JSON.parse(fs.readFileSync(path.join(DATA, 'g001-debt.json'), 'utf8'));
const model_free = (mode = 'plan') => ctx.get_model().ctx.series[mode].free;

test('REQ-082 boot: пакет FP-14 подхвачен манифестом без сбоев; виды правок зарегистрированы; app.mjs пакет не называет; экран «Долги» показывает раздел «Долги в прогнозе» и форму добавления', async () => {
  assert.ok(ext.diagnostics().some((d) => d.pack === 'pack_fp14' && d.status === 'ok'), JSON.stringify(ext.diagnostics().filter((d) => d.pack === 'pack_fp14')));
  assert.deepEqual(ext.diagnostics().filter((d) => d.status === 'failed'), [], 'ни один пакет не упал');
  for (const t of ['upsert_debt', 'delete_debt', 'move_debt_row', 'apply_prepay', 'apply_reanchor']) assert.ok(WE.list_edit_types().includes(t), t);
  assert.ok(!/pack_fp14|debt_edit|debtedit/.test(fs.readFileSync(path.join(DEMO, 'app.mjs'), 'utf8')), 'app.mjs не знает пакет поимённо');
  await go('#debts');
  assert.equal(by_id('view-title').textContent, 'Долги');
  assert.ok(by_id('fp14-saved') !== undefined);
  assert.equal(N(by_id('fp14-saved-title').textContent), 'Долги в прогнозе');
  assert.ok(N(by_id('fp14-saved').textContent).includes('Пока ни одного долга'));
  assert.ok(by_id('fp14-add') !== undefined, 'форма добавления под расчётом калькулятора');
  assert.equal(by_id('fp14-add-name').value, 'Долг');
  assert.equal(by_id('fp14-add-account').value, 'acc_main');
  assert.ok(N(by_id('fp14-add-btn').textContent) === 'Добавить в прогноз');
  // в форме пример REQ-082 (1 200 €, 12 %, 6 платежей), а не данные пользователя: записать его нельзя, пока поля не менялись
  assert.equal(by_id('fp14-add-btn').hasAttribute('disabled'), true);
  assert.ok(N(by_id('fp14-add-note').textContent).includes('В форме пример'));
  type_into(by_id('sc-db-rate'), '12,5');
  assert.equal(by_id('fp14-add-btn').hasAttribute('disabled'), false, 'после правки поля кнопка доступна');
  assert.equal(N(by_id('fp14-add-note').textContent), '');
  type_into(by_id('sc-db-rate'), '12');
  assert.ok(N(main().textContent).includes('Пока вы не нажали «Добавить в прогноз», в данные ничего не записывается'), 'вводная фраза экрана уточнена');
  assert.equal((ctx.get_ws().debts ?? []).length, 0, 'до нажатия данные не тронуты');
});

// состояния рабочей области после каждого шага — для проверки «Отменить» по цепочке
const SNAP = [clone(G)];

test('REQ-082 «Добавить в прогноз»: пустое название — сообщение у поля, данные не меняются; название и кнопка → долг записан со сохранённым графиком, «свободно» меньше на платёж, в шапке плашка о платежах за горизонтом', async () => {
  await go('#debts');
  type_into(by_id('sc-db-start'), '2026-11-05');
  type_into(by_id('fp14-add-name'), '   ');
  click(by_id('fp14-add-btn'));
  assert.equal(N(by_id('fp14-add-name-err').textContent), 'Введите название долга.');
  assert.equal(by_id('fp14-add-name').attrs['aria-invalid'], 'true');
  assert.equal((ctx.get_ws().debts ?? []).length, 0);
  const before_free = model_free('plan').slice();
  type_into(by_id('fp14-add-name'), 'Кредит на технику');
  const n0 = ctx.journal.length;
  click(by_id('fp14-add-btn'));
  const ws = ctx.get_ws();
  assert.equal(ws.debts.length, 1);
  const rec = ws.debts[0];
  assert.match(rec.debt_id, /^debt_[0-9a-f]+$/);
  assert.deepEqual({ ...rec, debt_id: 'D-LOAN' }, GD.debts[0], 'запись — как в data/g001-debt.json: график, условия, название');
  SNAP.push(clone(ws));
  // журнал дописан одной записью debt.set
  assert.deepEqual(ctx.journal.events().slice(n0).map((e) => e.type), ['debt.set']);
  // «свободно» уменьшилось на платёж 207,06 € с 5 ноября (горизонт G-001 — 57 дней)
  const free = model_free('plan');
  const i = E.parse_date('2026-11-05') - ctx.get_model().ctx.as_of;
  assert.ok(free.slice(0, i).every((x, k) => x === before_free[k]));
  assert.ok(free.slice(i).every((x, k) => x === before_free[i + k] - 20706));
  // экран перерисован: карточка долга, форма добавления недоступна (тот же долг уже записан)
  assert.ok(by_id('fp14-d0') !== undefined);
  assert.equal(N(by_id('fp14-d0-title').textContent), 'Кредит на технику');
  assert.equal(by_id('fp14-add-btn').hasAttribute('disabled'), true);
  assert.ok(N(by_id('fp14-add-note').textContent).includes('уже записан'));
  // плашка в шапке: 5 платежей на 1 035,29 € за горизонтом
  const banner = N(byid.get('summary').textContent);
  assert.ok(banner.includes('Долг «Кредит на технику»: платежей за горизонтом прогноза — 5 на 1 035,29 €; в «свободно» они не входят.'), banner);
  assert.ok(N(by_id('fp14-d0').textContent).includes('За горизонтом прогноза: 5 платежей на 1 035,29 €'));
  // подпись «Отменить» — вид действия
  assert.ok(N(nav_button('Отменить').attrs['aria-label'] ?? nav_button('Отменить').textContent).includes('изменение долга'));
  // фокус возвращён на раздел (кнопка, которую нажали, ушла из страницы)
  await tick();
  assert.equal(by_id('fp14-saved-title').focused, true);
});

test('REQ-082 карточка долга: вид графика, ставка, счёт, остаток по модели, ближайший платёж, платежей впереди, сумма и проценты; таблица графика 6 строк; без inline-стилей и обработчиков; у полей подписи', () => {
  const card = N(by_id('fp14-d0').textContent);
  for (const part of ['Аннуитет (равные платежи)', '12 %', 'Основной счёт', money(120000), money(20706) + ' · 5 ноября', '6, последний 5 апреля 2027', money(124235), money(4235)]) {
    assert.ok(card.includes(N(part)), 'нет «' + part + '» в: ' + card.slice(0, 400));
  }
  const sched = find_all(by_id('fp14-d0'), (n) => n.tagName === 'tbody' && n.children.length === 6 && n.children[0].children[0]?.tagName === 'th');
  assert.equal(sched.length, 1);
  assert.deepEqual(find_all(sched[0], (n) => n.tagName === 'tr').map((r) => N(r.children[2].textContent)), [20706, 20706, 20706, 20706, 20706, 20705].map((x) => N(money(x))));
  const labels = new Set(find_all(main(), (n) => n.tagName === 'label').map((l) => l.attrs.for));
  const bad = [];
  main().walk((n) => {
    if (n.attrs.style !== undefined) bad.push('style');
    if (Object.keys(n.attrs).some((k) => /^on/i.test(k))) bad.push('on*');
    if (['input', 'select'].includes(n.tagName) && !labels.has(n.attrs.id) && !n.attrs['aria-label']) bad.push('без подписи: ' + n.attrs.id);
    if (n.tagName === 'button' && n.textContent.trim() === '' && !n.attrs['aria-label']) bad.push('кнопка без текста');
    if (n.tagName === 'table' && !n.children.some((c) => c.tagName === 'caption' && c.textContent.trim() !== '')) bad.push('таблица без подписи');
  });
  assert.deepEqual(bad, []);
  const ids = find_all(main(), (n) => n.attrs.id !== undefined).map((n) => n.attrs.id);
  assert.equal(new Set(ids).size, ids.length, 'идентификаторы на странице уникальны');
  assert.ok(N(by_id('fp14-d0-rm').attrs['aria-label']).startsWith(N(by_id('fp14-d0-rm').textContent)), 'видимый текст кнопки — начало доступного имени');
});

test('REQ-082 перенос платежа: платёж 2 с 5 на 7 декабря — сумма та же, дата в графике и в событии, история; «Отменить» возвращает, «Вернуть» повторяет', async () => {
  choose(by_id('fp14-d0-mv-k'), '2');
  assert.equal(by_id('fp14-d0-mv-date').value, '2026-12-05', 'дата поля следует за выбранным платежом');
  type_into(by_id('fp14-d0-mv-date'), 'вчера');
  click(by_id('fp14-d0-mv-btn'));
  assert.equal(N(by_id('fp14-d0-mv-date-err').textContent), 'Нужна дата вида ГГГГ-ММ-ДД.');
  type_into(by_id('fp14-d0-mv-date'), '2026-12-07');
  click(by_id('fp14-d0-mv-btn'));
  const rec = ctx.get_ws().debts[0];
  assert.deepEqual([rec.schedule[1].date, rec.schedule[1].payment_minor], ['2026-12-07', 20706]);
  assert.deepEqual(rec.history.map((h) => h.kind), ['move']);
  SNAP.push(clone(ctx.get_ws()));
  assert.ok(N(by_id('fp14-d0').textContent).includes('платёж № 2 перенесён с 5 декабря на 7 декабря'), 'история на карточке');
  await tick();
  assert.equal(by_id('fp14-d0-title').focused, true, 'фокус вернулся на карточку долга после перерисовки');
  // граница: дата, равная дате следующего платежа, — отказ с понятным текстом
  choose(by_id('fp14-d0-mv-k'), '2');
  type_into(by_id('fp14-d0-mv-date'), '2027-01-05');
  click(by_id('fp14-d0-mv-btn'));
  assert.equal(N(by_id('fp14-d0-mv-err').textContent), 'Новая дата должна быть раньше следующего платежа.');
  assert.equal(ctx.get_ws().debts[0].schedule[1].date, '2026-12-07', 'отказ данные не меняет');
});

test('REQ-083 досрочное погашение: 300,00 € в день платежа 2 — таблица двух вариантов (платёж ниже 130,17 €, срок короче), «Применить: срок короче» пишет extra_minor и укорачивает график; внесённая сумма — отдельное обязательство в ряду', async () => {
  const k = by_id('fp14-d0-pp-k');
  assert.equal(k.value, '1', 'по умолчанию — ближайший платёж впереди');
  assert.equal(by_id('fp14-d0-pp-k').children.length, 5, 'платежи 1…5: на последнем платеже досрочно вносить нельзя');
  choose(k, '2');
  assert.ok(N(by_id('fp14-d0-pp-res').textContent).includes('Введите сумму'));
  assert.equal(by_id('fp14-d0-pp-shorten').hasAttribute('disabled'), true);
  assert.equal(by_id('fp14-d0-pp-lower').hasAttribute('disabled'), true);
  type_into(by_id('fp14-d0-pp-amount'), 'abc');
  assert.notEqual(N(by_id('fp14-d0-pp-amount-err').textContent), '');
  type_into(by_id('fp14-d0-pp-amount'), '99999,00');
  assert.ok(N(by_id('fp14-d0-pp-res').textContent).includes('Этот вариант не строится'), 'сумма больше остатка — оба варианта недоступны');
  assert.equal(by_id('fp14-d0-pp-shorten').hasAttribute('disabled'), true);
  type_into(by_id('fp14-d0-pp-amount'), '300,00');
  const res = N(by_id('fp14-d0-pp-res').textContent);
  for (const part of [money(13017), money(20706), '5 марта 2027', money(1114), money(754)]) assert.ok(res.includes(N(part)), part + ' в «' + res + '»');
  const ws0 = clone(ctx.get_ws());
  const n0 = ctx.journal.length;
  click(by_id('fp14-d0-pp-shorten'));
  const rec = ctx.get_ws().debts[0];
  assert.equal(rec.schedule.length, 5);
  assert.equal(rec.schedule[1].extra_minor, 30000);
  assert.equal(rec.schedule[1].date, '2026-12-07');
  assert.deepEqual(rec.history.map((h) => h.kind), ['move', 'prepay']);
  assert.deepEqual(rec, DE.apply_prepay(ws0.debts[0], { date: '2026-12-07', amount_minor: 30000, option: 'shorten', as_of: '2026-10-04' }));
  SNAP.push(clone(ctx.get_ws()));
  // новое досрочное раньше уже записанного отвергается: оба варианта недоступны, кнопки «Применить» недоступны
  choose(by_id('fp14-d0-pp-k'), '1');
  type_into(by_id('fp14-d0-pp-amount'), '10,00');
  assert.ok(N(by_id('fp14-d0-pp-res').textContent).includes('Позже уже записано досрочное погашение'), N(by_id('fp14-d0-pp-res').textContent));
  assert.equal(by_id('fp14-d0-pp-shorten').hasAttribute('disabled'), true);
  assert.equal(by_id('fp14-d0-pp-lower').hasAttribute('disabled'), true);
  assert.equal(ctx.journal.events().slice(n0).at(-1).type, 'debt.set');
  assert.equal(typeof ctx.journal.events().slice(n0).at(-1).supersedes_id, 'string');
  // в ряду: платёж 207,06 € и отдельно 300,00 € в тот же день (горизонт увеличен, чтобы 7 декабря было внутри)
  const long = E.analyze({ ...ctx.get_ws(), params: { ...ctx.get_ws().params, horizon_days: 200 } }, { as_of: '2026-10-04' });
  const extra = long.events.plan.find((e) => e.cash_event_id.endsWith('#extra'));
  assert.deepEqual([E.format_date(extra.date), extra.amount_minor], ['2026-12-07', -30000]);
  assert.ok(N(by_id('fp14-d0').textContent).includes('досрочно 300,00 € в день платежа № 2'), 'история');
  assert.ok(by_id('fp14-d0').textContent.includes('Досрочно'), 'колонка «Досрочно» в графике');
});

test('REQ-083 сверка с банком: после платежа 2 банк показал 809,00 € — дрейф, допуск 0,50 %, новый хвост; «Применить» пересчитывает график; остаток после последнего платежа — отказ с текстом', async () => {
  const d = ctx.get_ws().debts[0];
  const modeled = d.schedule[1].balance_minor;
  assert.equal(modeled, 50793, 'после досрочного остаток строки 2 уже без внесённой суммы');
  // сверка раньше записанного досрочного погашения (платёж 1 < платежа 2 с extra_minor) отвергнута текстом: иначе пересчёт хвоста затёр бы досрочное
  choose(by_id('fp14-d0-ra-k'), '1');
  type_into(by_id('fp14-d0-ra-observed'), '1004,94');
  assert.ok(N(by_id('fp14-d0-ra-res').textContent).includes('После этого платежа записано досрочное погашение'), N(by_id('fp14-d0-ra-res').textContent));
  assert.equal(by_id('fp14-d0-ra-btn').hasAttribute('disabled'), true);
  choose(by_id('fp14-d0-ra-k'), '3');
  type_into(by_id('fp14-d0-ra-observed'), '306,00');
  const res = N(by_id('fp14-d0-ra-res').textContent);
  assert.ok(res.includes('По модели остаток ' + N(money(30595))), res);
  assert.ok(res.includes('расхождение +' + N(money(5))), res);
  assert.ok(res.includes('Расхождение в допуске 0,5 %'), res);
  assert.ok(res.includes('Новый хвост графика: платежей 2'), res);
  choose(by_id('fp14-d0-ra-k'), '5');
  type_into(by_id('fp14-d0-ra-observed'), '10,00');
  assert.ok(N(by_id('fp14-d0-ra-res').textContent).includes('После последнего платежа остаток не равен нулю'), 'k = n и остаток > 0: график не продлевается');
  assert.equal(by_id('fp14-d0-ra-btn').hasAttribute('disabled'), true);
  choose(by_id('fp14-d0-ra-k'), '3');
  type_into(by_id('fp14-d0-ra-observed'), '306,00');
  click(by_id('fp14-d0-ra-btn'));
  const rec = ctx.get_ws().debts[0];
  assert.equal(rec.schedule[2].balance_minor, 30600);
  assert.deepEqual(rec.history.at(-1), { kind: 'reanchor', k: 3, date: '2027-01-05', observed_minor: 30600, drift_minor: 5, on: '2026-10-04' });
  assert.equal(rec.schedule.length, 5, 'срок не меняется');
  SNAP.push(clone(ctx.get_ws()));
  // инвариант: платежи + внесённое = долг + проценты
  assert.equal(rec.schedule.reduce((s, r) => s + r.payment_minor + (r.extra_minor ?? 0), 0) - rec.schedule.reduce((s, r) => s + r.interest_minor, 0), 120000 + 5, 'с учётом дрейфа 5');
});

test('REQ-082 «Убрать долг из прогноза»: запись и график пропадают, «свободно» возвращается к G-001; плашка в шапке исчезает', () => {
  click(by_id('fp14-d0-rm'));
  assert.deepEqual(ctx.get_ws().debts, []);
  SNAP.push(clone(ctx.get_ws()));
  assert.equal(canon(ctx.get_model().ctx.series.plan.free), canon(E.analyze(G, { as_of: G.as_of }).series.plan.free));
  assert.ok(!N(byid.get('summary').textContent).includes('Платежей по долгу'));
  assert.ok(N(by_id('fp14-saved').textContent).includes('Пока ни одного долга'));
});

test('TST-16 REQ-090 «Отменить» по цепочке: пять действий над долгом откатываются по одному и возвращаются побайтно, подпись «изменение долга»; журнал только дописывается; его свёртка равна области', () => {
  assert.equal(SNAP.length, 6);
  const j = ctx.journal;
  const n_before = j.length;
  const back = [];
  for (let i = SNAP.length - 1; i >= 1; i--) {
    const undo = nav_button('Отменить');
    assert.ok(undo !== undefined && !undo.hasAttribute('disabled'), 'шаг ' + i);
    assert.ok(N(undo.attrs['aria-label'] ?? undo.textContent).includes('изменение долга'), N(undo.attrs['aria-label'] ?? undo.textContent));
    click(undo);
    back.push(canon(ctx.get_ws()));
    assert.equal(canon(ctx.get_ws()), canon(SNAP[i - 1]), 'после отмены шага ' + i);
  }
  assert.ok(j.length > n_before, 'отмена дописывает журнал (revert и замены), а не стирает');
  assert.equal(canon(ctx.get_ws().debts), canon([]));
  for (let i = 1; i < SNAP.length; i++) {
    click(nav_button('Вернуть'));
    assert.equal(canon(ctx.get_ws()), canon(SNAP[i]), 'возврат шага ' + i);
  }
  const folded = BR.events_to_ws(j.events());
  assert.equal(canon(folded.debts), canon(ctx.get_ws().debts));
  assert.equal(E.analyze(folded, { as_of: folded.as_of }).inputs_hash, ctx.get_model().ctx.inputs_hash);
});

test('REQ-082 набор с долгом из файла (g001-debt) открывается: карточка, плашка за горизонтом, те же числа; правка долга из файла проходит так же', async () => {
  const r = ctx.adopt(clone(GD), { source: 'dataset' });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  await go('#debts');
  assert.ok(by_id('fp14-d0') !== undefined);
  assert.equal(N(by_id('fp14-d0-title').textContent), 'Кредит на технику');
  assert.ok(N(byid.get('summary').textContent).includes('Долг «Кредит на технику»: платежей за горизонтом прогноза — 5 на 1 035,29 €'));
  assert.equal(by_id('fp14-add-btn').hasAttribute('disabled'), true, 'в калькуляторе те же условия (первая дата 5 ноября) — этот долг уже записан');
  assert.ok(N(by_id('fp14-add-note').textContent).includes('уже записан'));
  // лента: платежи названы по долгу
  await go('#feed');
  assert.ok(N(main().textContent).includes('Кредит на технику'), 'в ленте платёж подписан названием долга');
  await go('#debts');
  // досрочное через экран на долге из файла: «платёж ниже»
  type_into(by_id('fp14-d0-pp-amount'), '300,00');
  choose(by_id('fp14-d0-pp-k'), '2');
  click(by_id('fp14-d0-pp-lower'));
  assert.deepEqual(ctx.get_ws().debts[0].schedule.map((x) => x.payment_minor), [20706, 20706, 13017, 13017, 13017, 13018]);
  click(nav_button('Отменить'));
  assert.equal(canon(ctx.get_ws().debts), canon(GD.debts));
});

test('REQ-082 запись долга из чужого файла с графиком длиннее 600 строк: карточка не рисует таблицу и формы (защита от огромной страницы), но показывает сводку и позволяет убрать долг', async () => {
  const long = clone(GD);
  const rec = DE.build_debt_record({ ...GD.debts[0], n: 600, principal_minor: 6000000 });
  const base = E.parse_date('2027-06-01');
  rec.schedule.push(...Array.from({ length: 60 }, (_, i) => ({ ...rec.schedule.at(-1), k: 601 + i, date: E.format_date(base + i * 31) })));
  assert.ok(rec.schedule.length > 600);
  long.debts = [rec];
  const r = ctx.adopt(long, { source: 'dataset' });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  await go('#debts');
  assert.ok(by_id('fp14-d0') !== undefined);
  assert.ok(N(by_id('fp14-d0').textContent).includes('График длиннее 600 строк'));
  assert.equal(by_id('fp14-d0-sched'), undefined, 'таблицы нет');
  for (const suffix of ['-mv', '-pp', '-ra']) assert.equal(by_id('fp14-d0' + suffix), undefined, 'форм нет: ' + suffix);
  assert.ok(by_id('fp14-d0-rm') !== undefined, 'убрать долг можно');
  click(by_id('fp14-d0-rm'));
  assert.deepEqual(ctx.get_ws().debts, []);
  click(nav_button('Отменить'));
  assert.equal(ctx.get_ws().debts.length, 1);
  ctx.adopt(clone(GD), { source: 'dataset' });
});

test('TST-58 REQ-082 английский интерфейс: раздел «Debts in the forecast», форма добавления и формы действий рисуются из каталога EN без русских слов в подписях', async () => {
  find_all(byid.get('controls'), (n) => n.attrs.lang === 'en')[0].listeners.click[0]();
  await go('#debts');
  assert.equal(by_id('view-title').textContent, 'Debts');
  assert.equal(N(by_id('fp14-saved-title').textContent), 'Debts in the forecast');
  const ui_cyrillic = find_all(by_id('fp14-saved'), (n) => ['button', 'h3', 'h4', 'h5', 'caption', 'label', 'summary', 'dt', 'dd', 'legend'].includes(n.tagName) || (n.tagName === 'th' && n.attrs.scope === 'col')
    || (n.tagName === 'p' && /(lead|muted|banner)/.test(n.className))).map((n) => n.textContent).filter((x) => /[А-Яа-яЁё]/.test(x));
  assert.deepEqual(ui_cyrillic.filter((x) => !/Кредит на технику|Основной счёт/.test(x)), [], 'в разделе только английский интерфейс (название долга и счёта — данные пользователя)');
  assert.equal(N(by_id('fp14-d0-mv').children[0].textContent), 'Move a payment');
  assert.ok(N(by_id('fp14-d0').textContent).includes('Annuity (equal payments)'));
  assert.ok(N(by_id('fp14-d0').textContent).includes('Beyond the forecast horizon: 5 payments'));
  assert.equal(N(by_id('fp14-add-btn').textContent), 'Add to the forecast');
  assert.ok(N(byid.get('summary').textContent).includes('Debt "Кредит на технику": payments beyond the forecast horizon: 5, €1,035.29 in total'));
  find_all(byid.get('controls'), (n) => n.attrs.lang === 'ru')[0].listeners.click[0]();
});

test('TST-56 REQ-082 строки каталога debtedit: у каждого ключа есть использование в коде пакета (литерал или динамический префикс), нет ссылок на несуществующие ключи', () => {
  const src = ['debt_edit.mjs', 'pack_fp14.mjs'].map((f) => fs.readFileSync(path.join(DEMO, f), 'utf8')).join('\n');
  const literals = new Set([...src.matchAll(/'(debtedit\.[a-z0-9_]+)'(?!\s*\+)/g)].map((m) => m[1]));
  const prefixes = [...src.matchAll(/'(debtedit\.[a-z0-9_]*)'\s*\+/g)].map((m) => m[1]);
  for (const k of Object.keys(CATALOG.ru)) assert.ok(literals.has(k) || prefixes.some((p) => k.startsWith(p)), 'ключ без использования: ' + k);
  for (const k of literals) assert.ok(Object.hasOwn(CATALOG.ru, k), 'код ссылается на несуществующий ключ ' + k);
  assert.deepEqual([...new Set(prefixes)], ['debtedit.r_']);
  assert.equal(I18N.t('ru', 'debtedit.add_btn'), 'Добавить в прогноз');
  assert.equal(I18N.t('en', 'debtedit.add_btn'), 'Add to the forecast');
});

test('REQ-082 экран «Долги» без пакета: блоки подключаются реестром debts.register_debt_block; снятие блока возвращает прежний вид; упавший блок — плашка, остальной экран жив', async () => {
  await go('#debts');
  assert.ok(by_id('fp14-saved') !== undefined);
  const off = DB.register_debt_block('saved', 'probe_ok', () => null);
  const boom = DB.register_debt_block('saved', 'probe_boom', () => { throw new Error('сбой блока'); });
  ctx.refresh();
  assert.ok(by_id('sc-db-principal') !== undefined, 'калькулятор жив');
  assert.ok(N(main().textContent).includes('Блок «debts/probe_boom» не показан из-за ошибки'), 'плашка о сбое блока');
  boom(); off();
  ctx.refresh();
  assert.equal(find_all(main(), (n) => n.className === 'banner short').length, 0);
  assert.throws(() => DB.register_debt_block('нет-такого', 'x', () => null), TypeError);
  assert.throws(() => DB.register_debt_block('saved', '', () => null), TypeError);
});

// ═══ исправления после независимой проверки (FP-14): название долга в плашке, один режим округления у калькулятора и записи ═══════════════════

test('REQ-082 плашка о платежах за горизонтом называет долг: при трёх долгах три разные строки; без названия — идентификатор; фигурные скобки в названии показываются как есть (не подставляются); EN — то же', async () => {
  const base = { pay_account_id: 'acc_main', currency: 'EUR', kind: 'installment_0', rate_bp: 0, n: 6 };
  const phone = DE.build_debt_record({ ...base, debt_id: 'D-PHONE', name: 'Рассрочка {n} на {sum}', principal_minor: 60000, start_date: '2026-11-10' });
  const bare = DE.build_debt_record({ ...base, debt_id: 'D-NONAME', principal_minor: 90000, start_date: '2026-11-12' });
  assert.equal(bare.name, undefined);
  const three = clone(GD);
  three.debts = [GD.debts[0], phone, bare];
  const r = ctx.adopt(three, { source: 'dataset' });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  await go('#debts');
  const lines = () => find_all(byid.get('summary'), (n) => n.tagName === 'p' && /(за горизонтом прогноза —|beyond the forecast horizon)/.test(N(n.textContent))).map((n) => N(n.textContent));
  assert.deepEqual(lines().sort(), [
    `Долг «D-NONAME»: платежей за горизонтом прогноза — 5 на ${N(money(75000))}; в «свободно» они не входят.`,
    `Долг «Кредит на технику»: платежей за горизонтом прогноза — 5 на ${N(money(103529))}; в «свободно» они не входят.`,
    `Долг «Рассрочка {n} на {sum}»: платежей за горизонтом прогноза — 5 на ${N(money(50000))}; в «свободно» они не входят.`,
  ].sort());
  find_all(byid.get('controls'), (n) => n.attrs.lang === 'en')[0].listeners.click[0]();
  await go('#debts');
  const en = lines();
  assert.equal(en.length, 3, en.join(' | '));
  assert.ok(en.some((x) => x.startsWith('Debt "D-NONAME": payments beyond the forecast horizon: 5, €750.00 in total')), en.join(' | '));
  assert.ok(en.some((x) => x.startsWith('Debt "Рассрочка {n} на {sum}": payments beyond the forecast horizon: 5, €500.00 in total')), en.join(' | '));
  find_all(byid.get('controls'), (n) => n.attrs.lang === 'ru')[0].listeners.click[0]();
  ctx.adopt(clone(GD), { source: 'dataset' });
});

test('REQ-082 REQ-083 калькулятор «Долги» считает в режиме округления рабочей области: при params.rounding = half_up платежи на экране равны записанным в прогноз до minor (прежде последний платёж различался на 1 minor)', async () => {
  const half_up_ws = { ...clone(G), params: { ...G.params, rounding: 'half_up' } };
  const r = ctx.adopt(half_up_ws, { source: 'dataset' });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  await go('#debts');
  type_into(by_id('sc-db-principal'), '1000,00');
  type_into(by_id('sc-db-rate'), '9,99');
  type_into(by_id('sc-db-n'), '6');
  type_into(by_id('sc-db-start'), '2026-11-05');
  const sched = () => find_all(main(), (n) => n.tagName === 'tbody' && n.children.length === 6 && n.children[0].children[0]?.tagName === 'th');
  const pay_cells = (tb) => find_all(tb, (n) => n.tagName === 'tr').map((row) => N(row.children[2].textContent));
  assert.equal(sched().length, 1, 'на экране одна таблица графика — калькулятора');
  const shown = pay_cells(sched()[0]);
  type_into(by_id('fp14-add-name'), 'Проба округления');
  click(by_id('fp14-add-btn'));
  const rec = ctx.get_ws().debts[0];
  assert.equal(rec.rounding, 'half_up');
  assert.deepEqual(shown, rec.schedule.map((x) => N(money(x.payment_minor))), 'на экране те же платежи, что записаны в прогноз');
  const half_even = E.amortization_schedule({ principal: 100000, rate_bp: 999, n: 6, start: '2026-11-05', kind: 'annuity', rounding: 'half_even' });
  assert.notDeepEqual(rec.schedule.map((x) => x.payment_minor), half_even.map((x) => x.payment_minor), 'пример выбран так, чтобы режимы округления различались');
  ctx.adopt(clone(GD), { source: 'dataset' });
});
