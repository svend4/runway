// reconcile_boot.test.mjs — FP-11 в настоящем app.mjs на заглушке DOM: пакет pack_fp11 подхватывается манифестом, «Сверка» и «Качество прогноза» стоят в навигации, на наборе late после сдвига «Сегодня»
// виден просроченный платёж, «Пропустить» и «Подтвердить» идут общим путём в настоящий журнал приложения (match.set), единая стопка «Отменить» откатывает действия сверки, согласие на вероятностные блоки
// пишется под ключом runway-prob-consent/1 и стирается штатным «Удалить все данные» (FP-05) при целых чужих ключах. Заглушка DOM минимальная; браузер, сеть и серверы не используются.
// Расчёт по введённым данным и правилам, не консультация.

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
    this._text = ''; this._value = ''; this._sel = null; this.open = false; this.focused = false; this.checked = false;
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
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this._value = String(v); if (k === 'checked') this.checked = true; }
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
const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.ResizeObserver = class { observe() {} };
globalThis.fetch = async (url) => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8')) });
store.set('portal-v9-theme', 'dark');
store.set('nexus.save', '{"keep":1}');

const { ext } = await import(pathToFileURL(path.join(DEMO, 'ext.mjs')).href);
await import(pathToFileURL(path.join(DEMO, 'app.mjs')).href);
await new Promise((r) => setTimeout(r, 700));

const DA = await import(pathToFileURL(path.join(DEMO, 'data_actions.mjs')).href);
const WE = await import(pathToFileURL(path.join(DEMO, 'ws_edit.mjs')).href);
const RC = await import(pathToFileURL(path.join(DEMO, 'reconcile.mjs')).href);
const N = (x) => String(x).replace(/[  ]/g, ' ');
const main = () => byid.get('main');
const by_id = (id) => find_all(main(), (n) => n.attrs.id === id)[0];
const nav_link = (label) => find_all(byid.get('nav'), (n) => n.tagName === 'a' && n.textContent === label)[0];
const nav_button = (prefix) => find_all(byid.get('nav'), (n) => n.tagName === 'button' && n.textContent.startsWith(prefix))[0];
const click = (n) => n.listeners.click[0]();
const ctx = ext.ctx;
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };
const choose_dataset = async (id) => {
  const select = find_all(byid.get('controls'), (n) => n.tagName === 'select' && n.attrs.id === 'ds-top')[0];
  await select.listeners.change[0]({ target: { value: id } });
};
const KEY = 'runway-prob-consent/1';

test('REQ-031 boot: пакет FP-11 подхвачен манифестом; «Сверка» и «Качество прогноза» стоят в навигации; app.mjs пакет не называет; виды правок set_match и set_plan_status зарегистрированы', () => {
  assert.ok(ext.diagnostics().some((d) => d.pack === 'pack_fp11' && d.status === 'ok'), JSON.stringify(ext.diagnostics().filter((d) => d.pack === 'pack_fp11')));
  assert.deepEqual(ext.diagnostics().filter((d) => d.status === 'failed'), [], 'ни один пакет не упал');
  assert.ok(nav_link('Сверка') !== undefined && nav_link('Качество прогноза') !== undefined);
  assert.ok(ext.has_view('reconcile') && ext.has_view('quality'));
  assert.ok(WE.list_edit_types().includes('set_match') && WE.list_edit_types().includes('set_plan_status'));
  const app_src = fs.readFileSync(path.join(DEMO, 'app.mjs'), 'utf8');
  assert.ok(!/pack_fp11|reconcile|quality|prob_band|prob_buy/.test(app_src), 'app.mjs не знает пакет поимённо');
});

test('TST-40 TST-41 набор late: на дату по умолчанию очередь пуста (и есть путь к «Настройкам»); после сдвига «Сегодня» на 30 ноября просрочен P-X; «Подтвердить» пишет match.set в журнал приложения; «Пропустить» и «Отменить» идут общим путём', async () => {
  await choose_dataset('late');
  await go('#reconcile');
  assert.equal(by_id('view-title').textContent, 'Сверка плана с фактом');
  assert.ok(by_id('rc-empty') !== undefined, 'на 4 октября ничего не просрочено');
  assert.equal(find_all(by_id('rc-empty-hint'), (n) => n.tagName === 'a')[0].attrs.href, '#settings');
  void ctx.journal;
  const r = ctx.edit({ type: 'set_as_of', date: '2026-11-30' });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  await go('#reconcile');
  assert.ok(N(main().textContent).includes('Просрочено: ожидали 26 ноября'), N(main().textContent).slice(0, 500));
  const model = RC.reconcile_model(ctx.get_ws());
  const i_x = model.queue.findIndex((q) => q.plan?.id === 'P-X');
  assert.ok(i_x >= 0);

  // «возможный двойник» для P-X: факт 27 ноября на 2650,00 € при плане 2500,00 € (отклонение 6 % — больше допуска 5 %, но меньше двух допусков)
  const added = ctx.edit({ type: 'add_fact', fact: { account_id: 'acc_main', date: '2026-11-27', amount_minor: -265000, tag: 'ремонт' } });
  assert.equal(added.ok, true, JSON.stringify(added.error));
  await go('#reconcile');
  const dbl = RC.reconcile_model(ctx.get_ws()).queue.findIndex((q) => q.kind === 'double');
  assert.ok(dbl >= 0, 'факт и план в очереди как возможное совпадение');
  const n0 = ctx.journal.length;
  click(by_id(`rc-confirm-${dbl}`));
  const last = ctx.journal.events().slice(n0);
  assert.deepEqual(last.map((e) => e.type), ['match.set'], 'в журнал приложения ушла запись match.set');
  assert.equal(last[0].payload.plan_ref, 'P-X');
  assert.equal(ctx.get_ws().facts.at(-1).plan_ref, 'P-X');
  assert.ok(!RC.reconcile_model(ctx.get_ws()).queue.some((q) => q.kind === 'double' || q.plan?.id === 'P-X'), 'P-X сопоставлен и ушёл из очереди');

  // единая стопка «Отменить» откатывает привязку; подпись — вид действия
  const undo = nav_button('Отменить');
  assert.ok(undo !== undefined && !undo.attrs.disabled);
  assert.ok(N(undo.attrs['aria-label'] ?? undo.textContent).includes('сверка плана с фактом') || N(undo.textContent).includes('сверка плана с фактом'), undo.textContent + '|' + undo.attrs['aria-label']);
  click(undo);
  assert.equal(ctx.get_ws().facts.at(-1).plan_ref, undefined);
  assert.ok(RC.reconcile_model(ctx.get_ws()).queue.some((q) => q.kind === 'double'));

  // «Пропустить» разового платежа: статус skipped; отмена возвращает
  await go('#reconcile');
  const skip_i = RC.reconcile_model(ctx.get_ws()).queue.findIndex((q) => q.kind === 'double');
  assert.ok(skip_i >= 0);
  click(by_id(`rc-norel-${skip_i}`)); // «Не относится»: факт больше не двойник
  assert.equal(ctx.get_ws().facts.at(-1).no_plan, true);
  await go('#reconcile');
  const px = RC.reconcile_model(ctx.get_ws()).queue.findIndex((q) => q.plan?.id === 'P-X');
  assert.ok(px >= 0, 'без факта P-X снова просрочен');
  click(by_id(`rc-skip-${px}`));
  assert.equal(ctx.get_ws().plans.find((p) => p.plan_id === 'P-X').status, 'skipped');
  assert.ok(!RC.reconcile_model(ctx.get_ws()).queue.some((q) => q.plan?.id === 'P-X'));
  click(nav_button('Отменить'));
  assert.equal(ctx.get_ws().plans.find((p) => p.plan_id === 'P-X').status, undefined, 'отмена вернула платёж');
});

test('TST-49 ADR-015 «Качество прогноза» в настоящем приложении: по умолчанию выключено и ничего не пишет; согласие кладёт runway-prob-consent/1; «Удалить все данные» стирает ключ, чужие ключи целы', async () => {
  await choose_dataset('g001');
  store.delete(KEY);
  await go('#quality');
  assert.equal(by_id('view-title').textContent, 'Качество прогноза');
  assert.ok(N(by_id('qx-exp-state').textContent).includes('выключено'));
  assert.equal(by_id('qx-band'), undefined);
  assert.ok(N(main().textContent).includes('Синтетика: журналы сгенерированы программой'));
  assert.ok(!store.has(KEY));
  click(by_id('qx-enable'));
  assert.ok(!store.has(KEY), 'без флажка не включается');
  const box = by_id('qx-agree');
  box.checked = true;
  box.listeners.change[0]();
  click(by_id('qx-enable'));
  assert.equal(store.get(KEY), '{"v":1,"experiment":true}');
  assert.ok(by_id('qx-band') !== undefined && by_id('qx-buy') !== undefined);
  // вероятностных ответов на «Обзоре» без расчёта нет: карточка коридора просит рассчитать на экране «Качество»
  await go('#overview');
  assert.ok(N(main().textContent).includes('Коридор остатка (эксперимент)'));
  const receipt = await DA.erase_all({ today: () => '2026-10-09', storage: globalThis.localStorage, store: null }, {});
  assert.equal(receipt.erased, true, JSON.stringify(receipt));
  assert.ok(!store.has(KEY), 'согласие стёрто вместе с данными');
  assert.equal(store.get('portal-v9-theme'), 'dark');
  assert.equal(store.get('nexus.save'), '{"keep":1}');
  ctx.refresh();
  await go('#overview');
  assert.ok(!N(main().textContent).includes('Коридор остатка (эксперимент)'), 'после стирания карточки коридора нет');
  await go('#quality');
  assert.ok(N(by_id('qx-exp-state').textContent).includes('выключено'));
});

test('REQ-031 TST-58 «Сверка» и «Качество прогноза» в английском интерфейсе рисуются из каталога EN без русских слов', async () => {
  await choose_dataset('late');
  find_all(byid.get('controls'), (n) => n.attrs.lang === 'en')[0].listeners.click[0]();
  await go('#reconcile');
  // русские слова на экране допустимы только в данных набора (метки фактов, названия платежей): интерфейс — заголовки, подписи, кнопки, шапки таблиц, пояснения — из каталога EN
  const ui_cyrillic = () => find_all(main(), (n) => ['button', 'h2', 'h3', 'h4', 'caption', 'label', 'legend', 'dt', 'dd'].includes(n.tagName) || (n.tagName === 'th' && n.attrs.scope === 'col') || (n.tagName === 'p' && /(lead|muted|banner)/.test(n.className)))
    .map((n) => n.textContent).filter((x) => /[А-Яа-яЁё]/.test(x));
  assert.equal(by_id('view-title').textContent, 'Plan vs actual');
  assert.deepEqual(ui_cyrillic().filter((x) => !/Почасовая|Плановый расход|Налоговый платёж|Связь|Аренда|ЖКХ|Продукты|продукты/.test(x)), [], 'интерфейс сверки без русских слов');
  await go('#quality');
  assert.equal(by_id('view-title').textContent, 'Forecast quality');
  assert.deepEqual(ui_cyrillic(), [], 'интерфейс «Качества» без русских слов');
  const nav = find_all(byid.get('nav'), (n) => n.tagName === 'a').map((a) => a.textContent);
  assert.ok(nav.includes('Reconcile') && nav.includes('Forecast quality'));
  find_all(byid.get('controls'), (n) => n.attrs.lang === 'ru')[0].listeners.click[0]();
});
