// metrics_feed.test.mjs — FP-22, REQ-185 (TST-55, TST-59): окна прогноза кормят метрики на устройстве — ошибка минимума (record_min_error) и покрытие коридора (record_coverage).
// Часть 1 — модуль без DOM (open_window, reconciled_through, settle_window, create_feed): числа G-001 проверены вручную (минимум plan за 14 дней 3 775,00 €), пакет runway-metrics/1
// по-прежнему без сумм и дат, окна не пересекаются, выключенные и остановленные метрики окон не трогают, испорченное состояние на устройстве не ломает страницу.
// Сверка окна (после независимой проверки): окно закрывает только сверка, согласованная с фактами, на счёте, который был в начале окна; якорь нового счёта и якорь, расходящийся с записями, окно
// не закрывают; набор счетов, изменившийся за окно, окно закрывает без записи в метрики; встроенные демо-наборы ленту не кормят.
// Часть 2 — настоящий app.mjs на заглушке DOM: пакет pack_fp22 подхвачен манифестом, демо-набор ленту не кормит, пользовательский набор открывает окно, «Сегодня» дошло до конца окна, «Сверка остатка» закрывает его и
// вызывает record_min_error / record_coverage; экран «Метрики» показывает значения; «Отменить» окно второй раз не считает; «Удалить все данные» стирает состояние окон.
// Браузер, сеть и серверы не используются. Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/metrics_feed.test.mjs

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
Object.defineProperty(globalThis, 'navigator', { value: { language: 'ru-RU' }, configurable: true });

/** localStorage-заглушка страницы: как настоящий (getItem/setItem/removeItem/key/length). */
const page_store = new Map();
globalThis.localStorage = {
  get length() { return page_store.size; },
  key: (i) => [...page_store.keys()][i] ?? null,
  getItem: (k) => (page_store.has(k) ? page_store.get(k) : null),
  setItem: (k, v) => { page_store.set(k, String(v)); },
  removeItem: (k) => { page_store.delete(k); },
};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.ResizeObserver = class { observe() {} };
globalThis.fetch = async (url) => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8')) });
page_store.set('portal-v9-theme', 'dark'); // чужой ключ общего localhost

const { ext } = await import(pathToFileURL(path.join(DEMO, 'ext.mjs')).href);
await import(pathToFileURL(path.join(DEMO, 'app.mjs')).href); // boot() запускается сам: в #app-title есть узел
await new Promise((r) => setTimeout(r, 700));

const E = await import('../engine/index.mjs');
const FEED = await import(pathToFileURL(path.join(DEMO, 'metrics_feed.mjs')).href);
const MX = await import(pathToFileURL(path.join(DEMO, 'metrics.mjs')).href);
const DA = await import(pathToFileURL(path.join(DEMO, 'data_actions.mjs')).href);
const BT = await import('../engine/backtest.mjs');
const I18N = await import(pathToFileURL(path.join(DEMO, 'i18n.mjs')).href);
const CATALOG = (await import(pathToFileURL(path.join(DEMO, 'i18n', 'mfeed.mjs')).href)).default;

const G = JSON.parse(fs.readFileSync(path.join(DATA, 'g001.json'), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const N = (x) => String(x).replace(/[  ]/g, ' ');
const main = () => byid.get('main');
const by_id = (id) => find_all(main(), (n) => n.attrs.id === id)[0];
const nav_button = (label) => find_all(byid.get('nav'), (n) => n.tagName === 'button' && n.textContent === label)[0];
const click = (n) => { assert.ok(n !== undefined, 'нет узла'); n.listeners.click[0](); };
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };
const ctx = ext.ctx;
const DAY0 = E.to_epoch_day('2026-10-04'); // as_of G-001

/** Map-хранилище с полным набором методов. */
function fake_storage() {
  const m = new Map();
  return { m, get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
/** Метрики над своим хранилищем (день использования — постоянный). */
function fresh_metrics(storage) {
  return MX.create_metrics({ storage, day: () => 0, engine_version: E.ENGINE_VERSION });
}
/** G-001, «сегодня» сдвинуто на 14 дней и сверен остаток 4 000,00 € (ничего не потрачено). */
function g001_reconciled() {
  const ws = clone(G);
  ws.as_of = '2026-10-18';
  ws.anchors.push({ anchor_id: 'anc-new', account_id: 'acc_main', date: '2026-10-18', amount_minor: 400000 });
  return ws;
}

// ═══ часть 1: модуль без DOM ═════════════════════════════════════════════════════════════════════════════════════════════════

test('REQ-185 ключ состояния — с префиксом runway (его стирает «Удалить все данные»); длина окна — backtest.min_window_days словаря', () => {
  assert.equal(FEED.FEED_KEY, 'runway-metrics-feed/1');
  assert.ok(FEED.FEED_KEY.startsWith(DA.LOCAL_PREFIX));
  assert.equal(FEED.WINDOW_DAYS, 14);
  assert.equal(FEED.WINDOW_DAYS, JSON.parse(fs.readFileSync(path.join(HERE, '..', 'engine', 'vocab.json'), 'utf8')).params['backtest.min_window_days'].default);
});

test('REQ-185 open_window на G-001: минимум plan за 14 дней — 3 775,00 € (трудный день 13: 4 000 − 25 − 100 − 100), остаток на конец окна по plan и worse — 3 775,00 €; рабочая область не меняется', () => {
  const before = JSON.stringify(G);
  const r = FEED.open_window(G);
  assert.deepEqual(r, { ok: true, open: { start: DAY0, days: 14, f_min: 377500, f_close: 377500, w_close: 377500, accts: ['acc_main'] } });
  assert.equal(JSON.stringify(G), before, 'рабочая область не изменена');
  // прямое сопоставление с движком: окно ошибки минимума — первые 14 дней ряда trough, остаток на конец — close[14]
  const A = E.analyze(G, { as_of: DAY0, horizon_end: DAY0 + 14 });
  assert.equal(r.open.f_min, Math.min(...A.series.plan.trough.slice(0, 14)));
  assert.equal(r.open.f_close, A.series.plan.close[14]);
  assert.equal(r.open.w_close, A.series.worse.close[14]);
  assert.equal(FEED.open_window({ as_of: 5 }).ok, false);
  assert.deepEqual(FEED.open_window(G, 0), { ok: false, reason: 'bad_days' });
  assert.equal(FEED.open_window({ as_of: '2026-10-04', accounts: 'нет' }).ok, false, 'испорченная область — отказ, не исключение');
  assert.equal(FEED.open_window(null).ok, false);
});

test('REQ-185 reconciled_through: окно закрывается, только когда «сегодня» дошло до конца и есть сверка остатка на operating-счёте на дату от конца окна; чужие и закрытые счета не считаются', () => {
  const open = FEED.open_window(G).open;
  assert.equal(FEED.reconciled_through(G, open), false, 'сегодня — начало окна');
  const w = g001_reconciled();
  assert.equal(FEED.reconciled_through(w, open), true, 'якорь ровно на дату конца окна (as_of = start + 14)');
  const early = clone(w); early.anchors[2].date = '2026-10-17';
  assert.equal(FEED.reconciled_through(early, open), false, 'якорь за день до конца окна — окно ещё открыто');
  const no_anchor = clone(w); no_anchor.anchors.pop();
  assert.equal(FEED.reconciled_through(no_anchor, open), false, '«сегодня» дошло до конца, но сверки нет');
  const later = clone(w); later.as_of = '2026-10-30'; later.anchors[2].date = '2026-10-25';
  assert.equal(FEED.reconciled_through(later, open), true, 'сверка позже конца окна тоже закрывает его');
  const reserve = clone(w); reserve.accounts[0].liquidity = 'reserve';
  assert.equal(FEED.reconciled_through(reserve, open), false, 'якорь не на operating-счёте не сверяет окно');
  const closed = clone(w); closed.accounts[0].closed_on = '2026-10-10';
  assert.equal(FEED.reconciled_through(closed, open), false, 'счёт закрыт до конца окна');
  const future = clone(w); future.as_of = '2026-10-10';
  assert.equal(FEED.reconciled_through(future, open), false, 'сегодня раньше конца окна');
  assert.equal(FEED.reconciled_through(null, open), false);
});

test('REQ-185 settle_window: факт по полному журналу — минимум фактического trough за 14 дней и остаток на конец; без трат минимум 4 000,00 € против прогноза 3 775,00 € (+596 bp), коридор plan–worse не содержит факт', () => {
  const open = FEED.open_window(G).open;
  const s = FEED.settle_window(g001_reconciled(), open);
  assert.deepEqual(s, { ok: true, a_min: 400000, act: 400000, lo: 377500, hi: 377500, inside: false });
  assert.equal(MX.min_error_bp(open.f_min, s.a_min), 596, '10000·(400000 − 377500)/377500 = 596,03 → 596');
  // те же траты, что в плане, и сверка на 3 775,00 €: ошибка 0, факт в коридоре
  const exact = g001_reconciled();
  exact.facts.push({ event_id: 'tx-a', account_id: 'acc_main', date: '2026-10-09', amount_minor: -2500, currency: 'EUR', kind: 'expense', tag: 'связь' },
    { event_id: 'tx-b', account_id: 'acc_main', date: '2026-10-10', amount_minor: -10000, currency: 'EUR', kind: 'expense', tag: 'продукты' },
    { event_id: 'tx-c', account_id: 'acc_main', date: '2026-10-17', amount_minor: -10000, currency: 'EUR', kind: 'expense', tag: 'продукты' });
  exact.anchors[2].amount_minor = 377500;
  assert.deepEqual(FEED.settle_window(exact, open), { ok: true, a_min: 377500, act: 377500, lo: 377500, hi: 377500, inside: true });
  // испорченная область: отказ с кодом, не исключение
  const bad = FEED.settle_window({ as_of: '2026-10-18' }, open);
  assert.equal(bad.ok, false);
  assert.equal(typeof bad.reason, 'string');
});

test('REQ-185 согласованность с backtest ALG-13: ошибка минимума и покрытие одного окна равны min_error и coverage отчёта backtest по журналу с одним началом', async () => {
  const bridge = await import(pathToFileURL(path.join(DEMO, 'ws_bridge.mjs')).href);
  const ws = g001_reconciled();
  // всё известное на 2026-10-04 введено 2026-10-04; сверка остатка введена 2026-10-18: «как знали тогда» на 10-04 её нет
  const events = bridge.ws_to_events(ws, { recorded_at: '2026-10-04T00:00:00Z' })
    .map((e) => (e.entity_id === 'anc-new' ? { ...e, recorded_at: '2026-10-18T00:00:00Z' } : e));
  // backtest берёт начала t0 + j·h, пока t + h не позже последнего факта: нулевой расход 18 октября (введён тогда же) делает ровно одно начало
  const last = E.make_event('tx.posted', { account_id: 'acc_main', date: '2026-10-18', amount_minor: 0, currency: 'EUR', kind: 'expense', tag: 'ноль' },
    { event_id: 'evt-last', seq: events.length + 1, recorded_at: '2026-10-18T00:00:00Z', entity_id: 'tx-last', actor: 'user' });
  const report = BT.backtest([...events, last], '2026-10-04', 14);
  assert.equal(report.n_origins, 1);
  const open = FEED.open_window(G).open;
  const s = FEED.settle_window(ws, open);
  assert.equal(report.min_error.n, 1);
  assert.equal(report.min_error.mean_bp, MX.min_error_bp(open.f_min, s.a_min), 'ошибка минимума окна = min_error backtest');
  assert.deepEqual(report.coverage, { k: s.inside ? 1 : 0, n: 1 }, 'покрытие окна = coverage backtest');
});

test('REQ-185 create_feed: окно открывается при готовом прогнозе, закрывается сверкой и вызывает record_min_error и record_coverage; пакет runway-metrics/1 без сумм и дат', () => {
  const st = fake_storage();
  const metrics = fresh_metrics(st);
  const feed = FEED.create_feed({ storage: st, metrics });
  assert.deepEqual(feed.step(G, { ready: false }), { closed: null, opened: false, skipped: null }, 'прогноз не показывается — окна нет');
  assert.equal(feed.peek(G), null);
  const r1 = feed.step(G, { ready: true });
  assert.deepEqual(r1, { closed: null, opened: true, skipped: null });
  assert.deepEqual(feed.peek(G), { through: null, open: { start: DAY0, days: 14, f_min: 377500, f_close: 377500, w_close: 377500, accts: ['acc_main'] } });
  assert.deepEqual(feed.step(G, { ready: true }), { closed: null, opened: false, skipped: null }, 'повторный шаг окно не дублирует');
  // «сегодня» дошло до конца, сверки нет — окно открыто
  const w = g001_reconciled();
  const no_anchor = clone(w); no_anchor.anchors.pop();
  assert.equal(feed.step(no_anchor, { ready: true }).closed, null);
  assert.equal(metrics.package().min_error_bp.n, 0);
  // сверка остатка закрывает окно
  const r2 = feed.step(w, { ready: true });
  assert.deepEqual(r2.closed, { ok: true, error_bp: 596, inside: false, a_min: 400000, act: 400000 });
  assert.equal(r2.opened, true, 'следующее окно открыто в тот же шаг');
  const pkg = metrics.package();
  assert.deepEqual(pkg.min_error_bp, { n: 1, values: [596] });
  assert.deepEqual(pkg.coverage, { k: 0, n: 1 });
  assert.deepEqual(MX.validate_package(pkg), [], 'пакет по строгой схеме');
  const text = metrics.package_text();
  for (const s of ['377500', '400000', '3775', '4000', '2026', '-10-']) assert.ok(!text.includes(s), 'в метриках нет: ' + s);
  assert.deepEqual(feed.peek(w), { through: DAY0 + 14, open: { start: DAY0 + 14, days: 14, f_min: feed.peek(w).open.f_min, f_close: feed.peek(w).open.f_close, w_close: feed.peek(w).open.w_close, accts: ['acc_main'] } });
  assert.equal(feed.peek(w).open.start, E.to_epoch_day('2026-10-18'));
});

test('REQ-185 ошибка 0 bp — значение, а не отсутствие: траты как в плане и сверка на 3 775,00 € дают min_error_bp = [0] и покрытие 1 из 1', () => {
  const st = fake_storage();
  const metrics = fresh_metrics(st);
  const feed = FEED.create_feed({ storage: st, metrics });
  feed.step(G, { ready: true });
  const exact = g001_reconciled();
  exact.facts.push({ event_id: 'tx-a', account_id: 'acc_main', date: '2026-10-09', amount_minor: -2500, currency: 'EUR', kind: 'expense', tag: 'связь' },
    { event_id: 'tx-b', account_id: 'acc_main', date: '2026-10-10', amount_minor: -10000, currency: 'EUR', kind: 'expense', tag: 'продукты' },
    { event_id: 'tx-c', account_id: 'acc_main', date: '2026-10-17', amount_minor: -10000, currency: 'EUR', kind: 'expense', tag: 'продукты' });
  exact.anchors[2].amount_minor = 377500;
  const r = feed.step(exact, { ready: true });
  assert.deepEqual(r.closed, { ok: true, error_bp: 0, inside: true, a_min: 377500, act: 377500 });
  assert.deepEqual(metrics.package().min_error_bp, { n: 1, values: [0] });
  assert.deepEqual(metrics.package().coverage, { k: 1, n: 1 });
});

test('REQ-185 окна не пересекаются: возврат «сегодня» назад и повторный вперёд тот же период второй раз не считает', () => {
  const st = fake_storage();
  const metrics = fresh_metrics(st);
  const feed = FEED.create_feed({ storage: st, metrics });
  feed.step(G, { ready: true });
  const w = g001_reconciled();
  assert.equal(feed.step(w, { ready: true }).closed.ok, true);
  assert.equal(metrics.package().min_error_bp.n, 1);
  // «Отменить» вернул «сегодня» на 10-10 (раньше начала нового окна 10-18): окна из несуществующего будущего нет, нового раньше конца прошлого тоже
  const back = clone(G); back.as_of = '2026-10-10';
  assert.deepEqual(feed.step(back, { ready: true }), { closed: null, opened: false, skipped: null });
  assert.equal(feed.peek(back).open, null);
  assert.equal(feed.peek(back).through, DAY0 + 14);
  // «сегодня» снова 10-18: окно открывается заново с этой даты — прежний период не повторяется
  const again = feed.step(w, { ready: true });
  assert.equal(again.closed, null, 'период 04–18 октября уже посчитан');
  assert.equal(metrics.package().min_error_bp.n, 1);
  assert.equal(metrics.package().coverage.n, 1);
});

test('REQ-185 выключенные метрики и остановка после «Удалить все данные»: окон не открывают и не закрывают, ключ состояния не воскрешается', () => {
  const st = fake_storage();
  const metrics = fresh_metrics(st);
  const feed = FEED.create_feed({ storage: st, metrics });
  metrics.begin_session();
  metrics.set_enabled(false);
  assert.deepEqual(feed.step(G, { ready: true }), { closed: null, opened: false, skipped: 'metrics_off' });
  assert.equal(st.m.has(FEED.FEED_KEY), false);
  metrics.set_enabled(true);
  assert.equal(feed.step(G, { ready: true }).opened, true);
  assert.ok(st.m.has(FEED.FEED_KEY));
  // «Удалить все данные»: ключи с префиксом runway исчезают
  st.m.delete(FEED.FEED_KEY);
  st.m.delete(MX.METRICS_KEY);
  const halted = feed.step(g001_reconciled(), { ready: true });
  assert.deepEqual(halted, { closed: null, opened: false, skipped: 'metrics_halted' });
  assert.equal(st.m.has(FEED.FEED_KEY), false, 'состояние окон не воскресло');
  assert.equal(st.m.has(MX.METRICS_KEY), false);
});

test('REQ-185 состояние окна переживает перезагрузку (новый экземпляр над тем же хранилищем) и стирается «Удалить все данные» (префикс runway)', async () => {
  const st = fake_storage();
  st.m.set('portal-v9-theme', 'dark');
  const feed1 = FEED.create_feed({ storage: st, metrics: fresh_metrics(st) });
  fresh_metrics(st).begin_session();
  feed1.step(G, { ready: true });
  const saved = JSON.parse(st.m.get(FEED.FEED_KEY));
  assert.equal(saved.v, 1);
  assert.deepEqual(saved.items, [{ ws: 'ws-g001', through: null, open: { start: DAY0, days: 14, f_min: 377500, f_close: 377500, w_close: 377500, accts: ['acc_main'] } }]);
  // «перезагрузка»: новый экземпляр читает окно с устройства и закрывает его
  const metrics2 = fresh_metrics(st);
  const feed2 = FEED.create_feed({ storage: st, metrics: metrics2 });
  assert.equal(feed2.peek(G).open.f_min, 377500);
  assert.equal(feed2.step(g001_reconciled(), { ready: true }).closed.error_bp, 596);
  assert.deepEqual(metrics2.package().min_error_bp, { n: 1, values: [596] });
  // штатное удаление: список ключей очистки подхватывает ключ окон, чужой ключ цел
  const receipt = await DA.erase_all({ today: () => '2026-10-23', storage: st, store: null }, {});
  assert.equal(receipt.erased, true, JSON.stringify(receipt));
  assert.equal(st.m.has(FEED.FEED_KEY), false);
  assert.equal(st.m.get('portal-v9-theme'), 'dark');
  assert.equal(feed2.peek(G), null, 'экземпляр страницы не держит удалённое: окно после стирания не воскрешается из памяти');
});

test('REQ-185 испорченное состояние на устройстве (не JSON, чужая версия, дробные числа, ключи-«ловушки», слишком много записей) отбрасывается по одной записи и не ломает страницу', () => {
  const good = { ws: 'ws-ok', through: 5, open: { start: 100, days: 14, f_min: 1, f_close: 2, w_close: 3, accts: ['a'] } };
  const cases = [
    ['{не json', 0],
    [JSON.stringify({ v: 2, items: [good] }), 0],
    [JSON.stringify({ v: 1, items: 'нет' }), 0],
    [JSON.stringify({ v: 1, items: [good, { ws: '__proto__', through: null, open: null }] }), 1],
    [JSON.stringify({ v: 1, items: [good, { ws: 'x', through: 1.5, open: null }] }), 1],
    [JSON.stringify({ v: 1, items: [good, { ws: 'x', through: null, open: { start: 1, days: 14, f_min: 0.5, f_close: 2, w_close: 3 } }] }), 1],
    [JSON.stringify({ v: 1, items: [good, { ws: 'x', through: null, open: { start: -1, days: 14, f_min: 1, f_close: 2, w_close: 3 } }] }), 1],
    [JSON.stringify({ v: 1, items: [good, { ws: 'x', through: null, open: { start: 1, days: 1000, f_min: 1, f_close: 2, w_close: 3 } }] }), 1],
    [JSON.stringify({ v: 1, items: [good, good] }), 1],
    [JSON.stringify({ v: 1, items: [good, { ws: 'x', through: null, open: { start: 1, days: 14, f_min: 1, f_close: 2, w_close: 3, accts: 'acc' } }] }), 1],
    [JSON.stringify({ v: 1, items: [good, { ws: 'x', through: null, open: { start: 1, days: 14, f_min: 1, f_close: 2, w_close: 3, accts: [7] } }] }), 1],
    [JSON.stringify({ v: 1, items: [good, { ws: 'x', through: null, open: { start: 1, days: 14, f_min: 1, f_close: 2, w_close: 3, accts: Array.from({ length: 65 }, (_, i) => 'a' + i) } }] }), 1],
    [JSON.stringify({ v: 1, items: Array.from({ length: 40 }, (_, i) => ({ ws: 'w' + i, through: null, open: null })) }), FEED.MAX_ITEMS],
  ];
  for (const [raw, n] of cases) assert.equal(FEED.accept_state(raw).items.length, n, raw.slice(0, 50));
  const st = fake_storage();
  st.m.set(FEED.FEED_KEY, '{не json');
  const feed = FEED.create_feed({ storage: st, metrics: fresh_metrics(st) });
  assert.equal(feed.step(G, { ready: true }).opened, true, 'испорченный ключ заменён новым состоянием');
  assert.equal(JSON.parse(st.m.get(FEED.FEED_KEY)).items.length, 1);
  // ключ рабочей области очищается от знаков вне безопасного набора и не бывает «ловушкой»
  assert.equal(FEED.ws_key({ workspace_id: 'Зарплата 4730' }), '?'.repeat(9) + '4730');
  assert.equal(FEED.ws_key({ workspace_id: '__proto__' }), '?__proto__');
  assert.equal(FEED.ws_key({}), '-');
  assert.equal(FEED.ws_key({ workspace_id: 'x'.repeat(200) }).length, 64);
});

test('REQ-185 хранилища нет или оно ничего не хранит (заглушка, приватный режим): состояние живёт в памяти страницы, окно всё равно закрывается', () => {
  for (const storage of [null, { getItem: () => null, setItem: () => {} }, { getItem: () => { throw new Error('нет'); }, setItem: () => { throw new Error('нет'); } }]) {
    const metrics = fresh_metrics(null);
    const feed = FEED.create_feed({ storage, metrics });
    assert.equal(feed.step(G, { ready: true }).opened, true);
    assert.equal(feed.step(g001_reconciled(), { ready: true }).closed.error_bp, 596);
    assert.equal(metrics.package().min_error_bp.n, 1);
  }
});

test('REQ-185 forecast_ready: прогноз показывается при готовности s ≥ ready.q1 (по умолчанию 3); без модели — нет', () => {
  assert.equal(FEED.forecast_ready(null), false);
  assert.equal(FEED.forecast_ready({ ctx: { readiness: { score: 2 }, params: {} } }), false);
  assert.equal(FEED.forecast_ready({ ctx: { readiness: { score: 3 }, params: {} } }), true);
  assert.equal(FEED.forecast_ready({ ctx: { readiness: { score: 3 }, params: { 'ready.q1': 4 } } }), false);
  assert.equal(FEED.forecast_ready({ ctx: { readiness: { score: 4 }, params: { 'ready.q1': 4 } } }), true);
});

test('REQ-185 окно запоминает operating-счета начала окна: справочный, закрытый до начала и ещё не открытый счета не входят; идентификатор со служебными знаками отбрасывается', () => {
  const w = clone(G);
  w.accounts.push(
    { account_id: 'acc_two', name: 'Второй', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2, liquidity_bp: 0, opened_on: '2026-02-01' },
    { account_id: 'acc_res', name: 'Резерв', kind: 'bank', liquidity: 'reserve', currency: 'EUR', exponent: 2, liquidity_bp: 0, opened_on: '2026-02-01' },
    { account_id: 'acc_old', name: 'Закрытый', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2, liquidity_bp: 0, opened_on: '2026-01-01', closed_on: '2026-09-01' },
    { account_id: 'acc_future', name: 'Будущий', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2, liquidity_bp: 0, opened_on: '2026-11-01' },
    { account_id: 'acc\u0007bad', name: 'Служебный знак', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2, liquidity_bp: 0, opened_on: '2026-02-01' });
  const r = FEED.open_window(w);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.open.accts, ['acc_main', 'acc_two']);
});

test('REQ-185 ДЕФЕКТ-1 исправлен: якорь нового операционного счёта (его не было в начале окна) окно не закрывает; сверка счёта из начала окна закрывает его, а открытие нового счёта в день после конца окна прогноз не искажает', () => {
  const open = FEED.open_window(G).open;
  const w = clone(G);
  w.as_of = '2026-10-19';
  w.accounts.push({ account_id: 'acc_new', name: 'Новый счёт', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2, liquidity_bp: 0, opened_on: '2026-10-19' });
  w.anchors.push({ anchor_id: 'anc-new', account_id: 'acc_new', date: '2026-10-19', amount_minor: 10000 });
  assert.equal(FEED.reconciled_through(w, open), false, 'якорь нового счёта — не сверка основного');
  w.anchors.push({ anchor_id: 'anc-main', account_id: 'acc_main', date: '2026-10-19', amount_minor: 400000 });
  assert.equal(FEED.reconciled_through(w, open), true, 'основной счёт сверен и сходится с записями');
  assert.equal(FEED.settle_window(w, open).ok, true, 'новый счёт открыт после конца окна: на остаток конца окна он не влияет');
  // счёт, который был в начале окна и ещё открыт, нужен весь: второй счёт без сверки окно не закрывает
  const two = clone(G);
  two.accounts.push({ account_id: 'acc_two', name: 'Второй', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2, liquidity_bp: 0, opened_on: '2026-02-01' });
  two.anchors.push({ anchor_id: 'anc-two-0', account_id: 'acc_two', date: '2026-10-04', amount_minor: 50000 });
  const open2 = FEED.open_window(two).open;
  assert.deepEqual(open2.accts, ['acc_main', 'acc_two']);
  const later = clone(two);
  later.as_of = '2026-10-18';
  later.anchors.push({ anchor_id: 'anc-main-1', account_id: 'acc_main', date: '2026-10-18', amount_minor: 400000 });
  assert.equal(FEED.reconciled_through(later, open2), false, 'второй счёт не сверен');
  later.anchors.push({ anchor_id: 'anc-two-1', account_id: 'acc_two', date: '2026-10-18', amount_minor: 50000 });
  assert.equal(FEED.reconciled_through(later, open2), true, 'оба счёта сверены');
  // окно прежней версии (без списка счетов) закрыть нельзя
  const { accts, ...legacy } = open;
  assert.equal(FEED.reconciled_through(g001_reconciled(), legacy), false);
});

test('REQ-185 ДЕФЕКТ-2 исправлен: якорь, расходящийся с записями, окно не закрывает; расхождение внутри окна блокирует закрытие, пока факты не внесены; допуск — параметр', () => {
  const open = FEED.open_window(G).open;
  const off = g001_reconciled();
  off.anchors[2].amount_minor = 250000; // в банке на 1 500,00 € меньше, чем следует из записей
  assert.equal(FEED.reconciled_through(off, open), false);
  assert.equal(FEED.reconciled_through(off, open, { tolerance_minor: 149999 }), false, 'допуск меньше расхождения');
  assert.equal(FEED.reconciled_through(off, open, { tolerance_minor: 150000 }), true, 'допуск не меньше расхождения');
  assert.equal(FEED.reconciled_through(off, open, { tolerance_minor: -5 }), false, 'отрицательный допуск — нулевой');
  assert.equal(FEED.reconciled_through(off, open, { tolerance_minor: 1.5 }), false, 'нецелый допуск — нулевой');
  off.facts.push({ event_id: 'tx-miss', account_id: 'acc_main', date: '2026-10-10', amount_minor: -150000, currency: 'EUR', kind: 'expense', tag: 'прочее' });
  assert.equal(FEED.reconciled_through(off, open), true, 'недостающий расход внесён — запись и якорь сходятся');
  // якорь позже конца окна проверяется так же
  const late = clone(G);
  late.as_of = '2026-10-30';
  late.anchors.push({ anchor_id: 'anc-late', account_id: 'acc_main', date: '2026-10-30', amount_minor: 250000 });
  assert.equal(FEED.reconciled_through(late, open), false);
  late.facts.push({ event_id: 'tx-late', account_id: 'acc_main', date: '2026-10-25', amount_minor: -150000, currency: 'EUR', kind: 'expense', tag: 'прочее' });
  assert.equal(FEED.reconciled_through(late, open), true);
  // расхождение якоря внутри окна: факты до него неполны, даже если конечный якорь сходится с ним
  const mid = g001_reconciled();
  mid.anchors[2].amount_minor = 390000;
  mid.anchors.push({ anchor_id: 'anc-mid', account_id: 'acc_main', date: '2026-10-10', amount_minor: 390000 });
  assert.equal(FEED.reconciled_through(mid, open), false, 'якорь 10 октября на 100,00 € ниже записей');
  mid.facts.push({ event_id: 'tx-mid', account_id: 'acc_main', date: '2026-10-09', amount_minor: -10000, currency: 'EUR', kind: 'expense', tag: 'продукты' });
  assert.equal(FEED.reconciled_through(mid, open), true, 'расход внесён — цепочка якорей согласована');
  // у счёта нет предыдущего якоря: сравнивать не с чем, остаток не подтверждён записями
  const first = g001_reconciled();
  first.anchors = [{ anchor_id: 'anc-end-only', account_id: 'acc_main', date: '2026-10-18', amount_minor: 400000 }];
  assert.equal(FEED.reconciled_through(first, open), false, 'без предыдущего якоря остаток не подтверждён записями');
});

test('REQ-185 набор operating-счетов изменился за окно: счёт открыт внутри окна или перестал быть operating — окно закрывается без записи в метрики (accounts_changed); счёт, открытый после конца окна, не мешает', () => {
  const st = fake_storage();
  const metrics = fresh_metrics(st);
  const feed = FEED.create_feed({ storage: st, metrics });
  feed.step(G, { ready: true });
  const w = g001_reconciled();
  w.accounts.push({ account_id: 'acc_mid', name: 'Открыт в окне', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2, liquidity_bp: 0, opened_on: '2026-10-10' });
  w.anchors.push({ anchor_id: 'anc-mid', account_id: 'acc_mid', date: '2026-10-10', amount_minor: 30000 });
  const open = feed.peek(G).open;
  assert.equal(FEED.reconciled_through(w, open), true, 'основной счёт сверен');
  assert.deepEqual(FEED.settle_window(w, open), { ok: false, reason: 'accounts_changed' });
  const r = feed.step(w, { ready: true });
  assert.deepEqual(r.closed, { ok: false, reason: 'accounts_changed' });
  assert.deepEqual(metrics.package().min_error_bp, { n: 0, values: [] }, 'в метрики ничего не записано');
  assert.deepEqual(metrics.package().coverage, { k: 0, n: 0 });
  assert.equal(feed.peek(w).through, DAY0 + 14, 'период закрыт, повторно не считается');
  // счёт из начала окна перестал быть operating
  const re = g001_reconciled();
  re.accounts[0].liquidity = 'reserve';
  assert.deepEqual(FEED.settle_window(re, open), { ok: false, reason: 'accounts_changed' });
});

test('REQ-185 состояние прежней версии (окно без списка счетов) не ломает страницу: окно считается не открытым, граница through сохраняется, новое окно открывается со списком счетов', () => {
  const st = fake_storage();
  st.m.set(FEED.FEED_KEY, JSON.stringify({ v: 1, items: [{ ws: 'ws-g001', through: DAY0 - 3, open: { start: DAY0, days: 14, f_min: 1, f_close: 2, w_close: 3 } }] }));
  const metrics = fresh_metrics(st);
  const feed = FEED.create_feed({ storage: st, metrics });
  assert.deepEqual(feed.peek(G), { through: DAY0 - 3, open: null });
  assert.equal(feed.step(G, { ready: true }).opened, true);
  assert.deepEqual(feed.peek(G).open.accts, ['acc_main']);
  assert.equal(metrics.package().min_error_bp.n, 0, 'старое окно с негодными числами в метрики не попало');
});

test('REQ-185 допуск create_feed(tolerance_minor): якорь с расхождением в пределах допуска окно закрывает; по умолчанию допуск нулевой', () => {
  const off = g001_reconciled();
  off.anchors[2].amount_minor = 399950; // на 0,50 € меньше записей
  for (const [tol, n] of [[undefined, 0], [49, 0], [50, 1]]) {
    const st = fake_storage();
    const metrics = fresh_metrics(st);
    const feed = FEED.create_feed({ storage: st, metrics, ...(tol === undefined ? {} : { tolerance_minor: tol }) });
    feed.step(G, { ready: true });
    feed.step(off, { ready: true });
    assert.equal(metrics.package().min_error_bp.n, n, 'допуск ' + tol);
  }
});

test('REQ-185 модуль чистый: нет Date, Math.random, сетевых вызовов, консоли и обращений к глобальному хранилищу; метрики пишутся только через record_*', () => {
  const src = fs.readFileSync(path.join(DEMO, 'metrics_feed.mjs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
  for (const bad of ['Date.', 'new Date', 'Math.random', 'fetch(', 'console.', 'localStorage', 'sendBeacon', 'XMLHttpRequest', 'METRICS_KEY', 'innerHTML']) assert.ok(!src.includes(bad), bad);
  assert.ok(/metrics\.record_min_error\(/.test(src) && /metrics\.record_coverage\(/.test(src));
});

test('TST-56 REQ-185 каталог mfeed: RU и EN, ключи используются литералами в коде пакета, плейсхолдеры одинаковы, в RU русские буквы', () => {
  assert.deepEqual(Object.keys(CATALOG.ru).sort(), Object.keys(CATALOG.en).sort());
  const code = fs.readFileSync(path.join(DEMO, 'pack_fp22.mjs'), 'utf8');
  for (const k of Object.keys(CATALOG.ru)) {
    assert.ok(code.includes(`'${k}'`), `ключ ${k} не используется литералом`);
    assert.match(CATALOG.ru[k], /[А-Яа-яЁё]/, k);
    assert.deepEqual([...CATALOG.ru[k].matchAll(/{(\w+)}/g)].map((m) => m[1]).sort(), [...CATALOG.en[k].matchAll(/{(\w+)}/g)].map((m) => m[1]).sort(), k);
  }
});

// ═══ часть 2: настоящий app.mjs на заглушке DOM ══════════════════════════════════════════════════════════════════════════════

const pkg_now = () => MX.app_metrics().package();
const feed_items = () => JSON.parse(page_store.get(FEED.FEED_KEY) ?? '{"items":[]}').items;

test('REQ-185 boot: пакет FP-22 подхвачен манифестом без сбоев; app.mjs пакет по имени не знает; на встроенном демо-наборе G-001 окно не открывается (демо метрики пользователя не кормит)', () => {
  assert.ok(ext.diagnostics().some((d) => d.pack === 'pack_fp22' && d.status === 'ok'), JSON.stringify(ext.diagnostics().filter((d) => d.pack === 'pack_fp22')));
  assert.deepEqual(ext.diagnostics().filter((d) => d.status === 'failed'), [], 'ни один пакет не упал');
  assert.ok(!/pack_fp22|metrics_feed|error_report|entry_memory/.test(fs.readFileSync(path.join(DEMO, 'app.mjs'), 'utf8')), 'app.mjs пакет не называет');
  assert.notEqual(MX.app_metrics(), null, 'экземпляр метрик приложения общий (его ставит пакет FP-10)');
  assert.deepEqual(feed_items(), [], 'встроенный набор: состояния окон нет');
  assert.deepEqual(pkg_now().min_error_bp, { n: 0, values: [] });
  assert.deepEqual(pkg_now().coverage, { k: 0, n: 0 });
});

test('REQ-185 ДЕФЕКТ-3 исправлен: правка встроенного демо-набора (сдвиг «сегодня» на 14 дней и сверка остатка) окно не открывает, не закрывает и в метрики ничего не пишет', () => {
  assert.equal(ctx.edit({ type: 'set_as_of', date: '2026-10-18' }, { reason: 'set_as_of' }).ok, true);
  assert.equal(ctx.edit({ type: 'set_anchor', anchor: { account_id: 'acc_main', date: '2026-10-18', amount_minor: 400000 } }, { reason: 'set_anchor' }).ok, true);
  assert.equal(ctx.get_ws().anchors.length, 3, 'правка применена');
  assert.deepEqual(pkg_now().min_error_bp, { n: 0, values: [] });
  assert.deepEqual(pkg_now().coverage, { k: 0, n: 0 });
  assert.deepEqual(feed_items(), []);
  assert.ok(!page_store.has(FEED.FEED_KEY), 'ключ состояния окон не создан');
});

test('REQ-185 пользовательский набор (подмена набора целиком: файл, мастер, восстановление — dataset_id custom) кормит ленту: окно открывается на дату набора, состояние лежит на устройстве под ключом runway-metrics-feed/1', () => {
  const seen = [];
  const off = ctx.subscribe((info) => { if (info.reason === 'adopt') seen.push(info.dataset_id); });
  const r = ctx.adopt(clone(G), { source: 'restore' });
  off();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(seen, ['custom'], 'событие adopt несёт идентификатор набора');
  assert.equal(ctx.get_ws().as_of, '2026-10-04');
  assert.deepEqual(feed_items(), [{ ws: 'ws-g001', through: null, open: { start: DAY0, days: 14, f_min: 377500, f_close: 377500, w_close: 377500, accts: ['acc_main'] } }]);
  assert.deepEqual(pkg_now().min_error_bp, { n: 0, values: [] });
});

test('REQ-185 «Сегодня» дошло до конца окна, но остаток не сверен — окно остаётся открытым, метрики пусты', () => {
  const r = ctx.edit({ type: 'set_as_of', date: '2026-10-18' }, { reason: 'set_as_of' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(ctx.get_ws().as_of, '2026-10-18');
  assert.equal(feed_items()[0].open.start, DAY0);
  assert.deepEqual(pkg_now().min_error_bp, { n: 0, values: [] });
});

test('REQ-185 «Сверка остатка» (set_anchor) закрывает окно: вызваны record_min_error (+596 bp) и record_coverage (0 из 1); пользователю сообщено, что записано; открыто следующее окно', () => {
  const n0 = ext.diagnostics().filter((d) => d.status === 'notify').length;
  const r = ctx.edit({ type: 'set_anchor', anchor: { account_id: 'acc_main', date: '2026-10-18', amount_minor: 400000 } }, { reason: 'set_anchor' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(pkg_now().min_error_bp, { n: 1, values: [596] });
  assert.deepEqual(pkg_now().coverage, { k: 0, n: 1 });
  assert.deepEqual(MX.validate_package(pkg_now()), []);
  const notes = ext.diagnostics().filter((d) => d.status === 'notify').slice(n0).map((d) => N(d.message));
  assert.ok(notes.some((m) => m.startsWith('Окно прогноза на 14 дн. закрыто сверкой остатка. В метрики на устройстве записано: ошибка минимума 5,96 %, факт вне коридора')), notes.join(' | '));
  const items = feed_items();
  assert.equal(items.length, 1);
  assert.equal(items[0].through, DAY0 + 14);
  assert.equal(items[0].open.start, DAY0 + 14, 'следующее окно начинается с даты сверки');
  // файл метрик в localStorage страницы: тот же пакет, без сумм и дат
  const stored = JSON.parse(page_store.get(MX.METRICS_KEY));
  assert.deepEqual(stored.min_error_bp, { n: 1, values: [596] });
  const raw = JSON.stringify(pkg_now());
  for (const s of ['377500', '400000', '2026-']) assert.ok(!raw.includes(s), 'в метриках нет: ' + s);
});

test('REQ-185 экран «Метрики» показывает ошибку минимума и покрытие из настоящих окон', async () => {
  await go('#metrics');
  const t = N(main().textContent);
  assert.ok(t.includes('окон: n = 1, медиана 596 bp'), t.slice(0, 600));
  assert.ok(t.includes('0 из 1'), 'покрытие коридора');
});

test('REQ-185 «Отменить» и «Вернуть» сверку окно второй раз не считают: n остаётся 1', () => {
  click(nav_button('Отменить'));
  assert.equal(ctx.get_ws().anchors.length, 2, 'сверка отменена');
  assert.deepEqual(pkg_now().min_error_bp, { n: 1, values: [596] });
  click(nav_button('Вернуть'));
  assert.equal(ctx.get_ws().anchors.length, 3);
  assert.deepEqual(pkg_now().min_error_bp, { n: 1, values: [596] });
  assert.deepEqual(pkg_now().coverage, { k: 0, n: 1 });
});

test('REQ-185 второе окно: ещё 14 дней и сверка — n = 2; значение второго окна равно расчёту по движку от записанного прогноза', () => {
  const open = feed_items()[0].open;
  assert.equal(open.start, DAY0 + 14);
  assert.equal(ctx.edit({ type: 'set_as_of', date: '2026-11-01' }, { reason: 'set_as_of' }).ok, true);
  assert.equal(pkg_now().min_error_bp.n, 1, 'без сверки окно не закрыто');
  // сверка 3 900,00 € при записях 4 000,00 € (расход 100,00 € не внесён) окно не закрывает: факты неполны
  assert.equal(ctx.edit({ type: 'set_anchor', anchor: { account_id: 'acc_main', date: '2026-11-01', amount_minor: 390000 } }, { reason: 'set_anchor' }).ok, true);
  assert.equal(pkg_now().min_error_bp.n, 1, 'якорь расходится с записями — окно остаётся открытым');
  assert.equal(feed_items()[0].open.start, DAY0 + 14);
  // расход внесён — запись и якорь сходятся, окно закрывается
  assert.equal(ctx.edit({ type: 'add_fact', fact: { account_id: 'acc_main', date: '2026-10-25', amount_minor: -10000, currency: 'EUR', kind: 'expense', tag: 'продукты' } }, { reason: 'add_fact' }).ok, true);
  const rows = BT.actual_rows(ctx.get_ws(), open.start, open.start + open.days);
  const a_min = Math.min(...rows.trough.slice(0, open.days));
  assert.deepEqual(pkg_now().min_error_bp, { n: 2, values: [596, MX.min_error_bp(open.f_min, a_min)] });
  assert.equal(pkg_now().coverage.n, 2);
  assert.equal(feed_items()[0].through, DAY0 + 28);
});

test('REQ-185 REQ-098 «Удалить все данные» стирает ключи метрик и окон, чужой ключ цел; после остановки метрик действия пользователя окно не воскрешают', async () => {
  assert.ok(page_store.has(FEED.FEED_KEY) && page_store.has(MX.METRICS_KEY));
  const receipt = await DA.erase_all({ today: () => '2026-10-23', storage: globalThis.localStorage, store: null }, {});
  assert.equal(receipt.erased, true, JSON.stringify(receipt));
  assert.ok(!page_store.has(FEED.FEED_KEY) && !page_store.has(MX.METRICS_KEY));
  assert.equal(page_store.get('portal-v9-theme'), 'dark');
  assert.deepEqual([...page_store.keys()].filter((k) => k.startsWith('runway') && k !== 'runway-store/1'), [], 'свои ключи стёрты (журнал хранилища FP-05 стирает его собственный порт store)');
  // следующее действие пользователя: метрики остановлены до перезагрузки, окно не открывается
  assert.equal(ctx.edit({ type: 'set_as_of', date: '2026-11-02' }, { reason: 'set_as_of' }).ok, true);
  assert.ok(!page_store.has(FEED.FEED_KEY), 'ключ окон не воскрес');
  assert.ok(!page_store.has(MX.METRICS_KEY), 'ключ метрик не воскрес');
});

test('REQ-185 строки сообщения о закрытии окна: RU и EN, форматтер формата чисел пользователя (бp → процент), без форматтера — «N bp»', () => {
  const tr = (lang) => (k, p) => I18N.t(lang, k, p);
  const fake = (lang, bp_fn) => ({ tr: tr(lang), fmt: () => (bp_fn === null ? null : { bp: bp_fn }) });
  return import(pathToFileURL(path.join(DEMO, 'pack_fp22.mjs')).href).then((P) => {
    const closed = { ok: true, error_bp: -917, inside: true, a_min: 1, act: 1 };
    assert.equal(N(P.closed_text(fake('ru', (v) => `${v / 100} %`), closed)), 'Окно прогноза на 14 дн. закрыто сверкой остатка. В метрики на устройстве записано: ошибка минимума -9.17 %, факт попал в коридор «по плану» — «если хуже». Сумм и дат в метриках нет.');
    assert.ok(N(P.closed_text(fake('en', null), closed)).includes('minimum error -917 bp, the actual fell inside'));
    assert.ok(N(P.closed_text(fake('ru', null), { ok: true, error_bp: null, inside: false })).includes('Ошибку минимума определить нельзя'));
    assert.equal(P.closed_text(fake('ru', null), { ok: false, reason: 'E_SCHEMA' }), 'Окно прогноза закрыть не удалось: E_SCHEMA. В метрики ничего не записано.');
  });
});
