// why_more.test.mjs — FP-07: «почему» у каждого числа (REQ-104, IDEA-29, IDEA-45; TST-07, TST-58).
// Чистые модели (demo/why_more.mjs) проверяются на четырёх наборах G-001; DOM-часть — в настоящем app.mjs на заглушке DOM (как settings_boot.test.mjs):
// карточка «Почему так» на «Обзоре», блок хука show_why в штатном диалоге, диалоги волны, вердикта по плану и «можно потратить».
// Главное: сумма строк цепочки вместе с «Остальное» равна просадке (было: 200000 против 217000 на G-001, «если хуже»).
// Браузер не используется.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(HERE, '..', 'demo');
const DATA = path.join(HERE, '..', 'data');

// ── заглушка DOM ────────────────────────────────────────────────────────────────────────────────────────────────────

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
      return opts.length === 0 ? '' : opts[0].attrs.value;
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
  focus() {}
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
  createElement: (t) => new Node_(t), createElementNS: (ns, t) => new Node_(t, ns), createTextNode: (data) => ({ nodeType: 3, data }),
  getElementById: (id) => byid.get(id) ?? null, documentElement: new Node_('html'), head: new Node_('head'), body: new Node_('body'), title: '',
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
await import(pathToFileURL(path.join(DEMO, 'app.mjs')).href);
await new Promise((r) => setTimeout(r, 500));
const W = await import(pathToFileURL(path.join(DEMO, 'why_more.mjs')).href);
const { make_tool_ctx } = await import('../engine/tools.mjs');
const { list_waves_ex } = await import('../engine/index.mjs');

const read = (name) => JSON.parse(fs.readFileSync(path.join(DATA, name + '.json'), 'utf8'));
const model_of = (ws) => ({ ws, ctx: make_tool_ctx(ws, { as_of: ws.as_of }, {}) });
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };
const text_of = (id) => byid.get(id).textContent;
const click = (root, label) => {
  const b = find_all(root, (n) => n.tagName === 'button' && (n.textContent === label || n.attrs['aria-label'] === label))[0];
  assert.ok(b !== undefined, 'нет кнопки «' + label + '»');
  b.listeners.click[0]();
};

/** Проверки доступности (TST-58): подписи таблиц, связи заголовков, подписи полей и кнопок, нет inline-стилей, смысл — не только цветом. */
export function a11y_problems(root) {
  const ids = new Set();
  const labels_for = new Set();
  root.walk((n) => { if (n.attrs.id !== undefined) ids.add(n.attrs.id); if (n.tagName === 'label' && n.attrs.for !== undefined) labels_for.add(n.attrs.for); });
  const bad = [];
  root.walk((n) => {
    if (n.attrs.style !== undefined) bad.push('inline style');
    if (n.tagName === 'table' && !n.children.some((c) => c.tagName === 'caption' && c.textContent.trim() !== '')) bad.push('таблица без подписи');
    if (n.attrs['aria-labelledby'] !== undefined && !n.attrs['aria-labelledby'].split(' ').every((i) => ids.has(i))) bad.push('aria-labelledby → нет id: ' + n.attrs['aria-labelledby']);
    if (n.tagName === 'button' && n.textContent.trim() === '' && !n.attrs['aria-label']) bad.push('кнопка без текста');
    if (['input', 'select', 'textarea'].includes(n.tagName) && n.attrs.type !== 'hidden' && !labels_for.has(n.attrs.id) && !n.attrs['aria-label']) bad.push('поле без подписи: ' + n.attrs.id);
    if (/\b(bad|short|tight|current)\b/.test(n.className) && n.textContent.trim() === '' && n.children.length === 0) bad.push('цветовой знак без текста');
  });
  return bad;
}

// ── чистые модели ───────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-104 TST-07: сумма строк цепочки вместе с «Остальное» равна просадке 217000 (G-001, «если хуже»); цепочка движка без остатка даёт только 200000', () => {
  const m = model_of(read('g001-low'));
  const w = W.narrowest_why(m, 'worse');
  assert.equal(w.drop_minor, 217000);
  const groups = w.rows.filter((r) => r.kind === 'group');
  assert.deepEqual(groups.map((r) => [r.group, r.amount_minor]), [['R-RENT', 90000], ['R-GROC', 60000], ['tag:налог', 50000]]);
  assert.equal(groups.reduce((s, r) => s + r.amount_minor, 0), 200000, 'прежняя цепочка: 200000 против 217000');
  const rest = w.rows.find((r) => r.kind === 'rest');
  assert.equal(rest.amount_minor, 17000, '«Остальное»');
  assert.equal(w.rows.reduce((s, r) => s + r.amount_minor, 0), 217000);
  assert.equal(w.total_minor, 217000);
  assert.equal(w.ok, true);
  assert.equal(w.rows.some((r) => r.kind === 'inflow'), false, 'поступлений до узкой точки нет');
});

test('REQ-104: цепочка сходится с просадкой в обоих режимах на четырёх наборах G-001; «Остальное» неотрицательно', () => {
  for (const name of ['g001', 'g001-low', 'g001-late', 'g001-gap']) {
    const m = model_of(read(name));
    for (const mode of ['plan', 'worse']) {
      const w = W.narrowest_why(m, mode);
      assert.equal(w.ok, true, `${name} ${mode}`);
      assert.equal(w.total_minor, w.drop_minor, `${name} ${mode}: итог = просадка`);
      assert.ok(w.rows.filter((r) => r.kind === 'rest').every((r) => r.amount_minor > 0));
    }
  }
});

test('REQ-104: поступления в окне учитываются отдельной строкой со знаком «−»: цепочка сходится и тогда, когда доход приходит до узкой точки', () => {
  const ws = read('g001');
  const plans = [
    { plan_id: 'X-OUT', account_id: 'acc_main', date: '2026-10-08', amount_minor: -40000, currency: 'EUR', kind: 'expense', tag: 'прочее' },
    { plan_id: 'X-IN', account_id: 'acc_main', date: '2026-10-09', amount_minor: 25000, currency: 'EUR', kind: 'income', tag: 'возврат' },
  ];
  const m = model_of({ ...ws, plans: [...(ws.plans ?? []), ...plans] });
  for (const mode of ['plan', 'worse']) {
    const w = W.narrowest_why(m, mode);
    assert.equal(w.ok, true, mode);
    assert.equal(w.total_minor, w.drop_minor);
    const inflow = w.rows.find((r) => r.kind === 'inflow');
    if (inflow !== undefined) assert.ok(inflow.amount_minor < 0, 'поступление уменьшает просадку');
  }
});

test('REQ-104 «почему» у волны: потребность волны (R_w) раскладывается по группам и сходится для каждой волны, обоих режимов и четырёх наборов', () => {
  for (const name of ['g001', 'g001-low', 'g001-late', 'g001-gap']) {
    const m = model_of(read(name));
    for (const mode of ['plan', 'worse']) {
      const items = list_waves_ex(m.ctx, mode).items;
      assert.ok(items.length >= 2);
      for (const it of items) {
        const w = W.wave_why(m, mode, it);
        assert.equal(w.ok, true, `${name} ${mode} ${it.wave.wave_id}`);
        assert.equal(w.total_minor, it.metrics.r_minor);
        assert.equal(w.need_minor, it.metrics.r_minor + m.ctx.buffer_minor);
      }
    }
  }
  const w1 = W.wave_why(model_of(read('g001')), 'plan', list_waves_ex(model_of(read('g001')).ctx, 'plan').items[0]);
  assert.equal(w1.r_minor, 172000, 'G-001, волна 1, по плану');
});

test('REQ-104 «почему» у «можно потратить»: платежи до узкой точки раскрыты по группам, сумма строк равна разложению движка (REQ-057), гейт — причиной', () => {
  const m = model_of(read('g001'));
  const w = W.sts_why(m, 'worse');
  assert.equal(w.gated, false);
  assert.equal(w.ok, true);
  assert.equal(w.sts_minor, 21000);
  assert.equal(w.total_minor, w.min_free_minor - w.buffer_minor);
  const pay = w.rows.filter((r) => r.id === 'payment_group' || r.id === 'payment_rest');
  assert.ok(pay.length >= 3 && pay.every((r) => r.v < 0));
  const no_buffer = model_of({ ...read('g001'), params: { ...read('g001').params, buffer_minor: null } });
  const g = W.sts_why(no_buffer, 'plan');
  assert.deepEqual([g.gated, g.reason], [true, 'no_buffer']);
});

test('REQ-104 «почему» у вердикта по плану: статус по набору данных (над буфером / впритык / не хватает), минимум и недостающее до буфера', () => {
  const ok = W.verdict_why(model_of(read('g001')), 'plan');
  assert.deepEqual([ok.status, ok.need_minor], ['ok', 0]);
  const tight = W.verdict_why(model_of(read('g001-low')), 'plan');
  assert.deepEqual([tight.status, tight.need_minor, tight.point.amount_minor], ['tight', 24500, 25500]);
  const short = W.verdict_why(model_of(read('g001-gap')), 'plan');
  assert.equal(short.status, 'short');
  for (const v of [ok, tight, short]) assert.equal(v.why.ok, true);
});

test('REQ-104: группы и имена — как у движка и приложения (rule_id ?? stream_id ?? tag:… ?? id); подписи наборов данных переводятся', () => {
  assert.equal(W.group_of({ rule_id: 'R-RENT', cash_event_id: 'x' }), 'R-RENT');
  assert.equal(W.group_of({ rule_id: null, stream_id: 'S-1', cash_event_id: 'x' }), 'S-1');
  assert.equal(W.group_of({ rule_id: null, stream_id: null, tag: 'налог', cash_event_id: 'x' }), 'tag:налог');
  assert.equal(W.group_of({ tag: '', cash_event_id: 'evt-1' }), 'evt-1');
  const ws = read('g001');
  const ru = W.make_event_namer(ws, 'ru');
  const en = W.make_event_namer(ws, 'en');
  assert.equal(ru.by_id('R-RENT'), 'Аренда');
  assert.equal(en.by_id('R-RENT'), 'Rent');
  assert.equal(ru.group('tag:налог'), 'налог');
});

// ── DOM в настоящем приложении ──────────────────────────────────────────────────────────────────────────────────────

test('boot: пакет FP-07 подхвачен манифестом; в навигации «Конструктор» (#scenario_lab)', () => {
  assert.deepEqual(ext.diagnostics().filter((d) => d.pack === 'pack_fp07').map((d) => d.status), ['ok'], JSON.stringify(ext.diagnostics()));
  const links = find_all(byid.get('nav'), (n) => n.tagName === 'a').map((a) => [a.attrs.href, a.textContent]);
  assert.ok(links.some(([href, t]) => href === '#scenario_lab' && t === 'Конструктор'), JSON.stringify(links));
});

test('REQ-104 TST-07 штатный диалог «Почему» (хук show_why): после таблицы приложения — полная цепочка с «Остальное» и словесной сверкой «Сходится»; одно нажатие от числа', async () => {
  await go('#overview');
  const why = find_all(byid.get('main'), (n) => n.tagName === 'button' && n.textContent === 'почему?');
  assert.ok(why.length >= 2, 'у узкой точки есть «почему?» в обоих режимах');
  why[1].listeners.click[0](); // «если хуже»
  const body = text_of('dlg-body');
  assert.match(byid.get('dlg-title').textContent, /^Почему/);
  assert.match(body, /Из чего сложилась просадка/, 'штатная таблица приложения на месте');
  assert.match(body, /Полная цепочка: все строки до итога/);
  assert.match(body, /Остальное \(групп: \d+\)/);
  assert.match(body, /Сходится: сумма строк 2\s170,00\s€ равна просадке 2\s170,00\s€/);
  assert.deepEqual(a11y_problems(byid.get('dlg-body')), []);
});

test('REQ-104 карточка «Почему так» на «Обзоре»: вердикт по плану, вердикт «если хуже», «можно потратить» — каждый в одно нажатие, цепочка сходится', async () => {
  await go('#overview');
  const main = byid.get('main');
  assert.equal(find_all(main, (n) => n.className === 'card why-card').length, 1);
  click(main, 'Почему вердикт по плану');
  assert.equal(byid.get('dlg-title').textContent, 'Почему такой вердикт: по плану');
  let body = text_of('dlg-body');
  assert.match(body, /Вердикт: над буфером/);
  assert.match(body, /Сходится: сумма строк 1\s945,00\s€ равна просадке 1\s945,00\s€/);
  assert.match(body, /Что было бы без…/);
  assert.deepEqual(a11y_problems(byid.get('dlg-body')), []);
  click(main, 'Почему вердикт «если хуже»');
  assert.equal(byid.get('dlg-title').textContent, 'Почему такой вердикт: если хуже');
  click(main, 'Почему «можно потратить»');
  assert.equal(byid.get('dlg-title').textContent, 'Почему такое «можно потратить»');
  body = text_of('dlg-body');
  assert.match(body, /Платежи до узкой точки|Аренда/);
  assert.match(body, /Сходится/);
  assert.deepEqual(a11y_problems(byid.get('dlg-body')), []);
});

test('REQ-104 «почему» у волны: кнопка «Почему такая потребность» у каждой волны открывает разложение потребности; итог равен R_w', async () => {
  await go('#waves');
  const main = byid.get('main');
  const btns = find_all(main, (n) => n.tagName === 'button' && n.textContent === 'Почему такая потребность');
  assert.equal(btns.length, 2, 'две волны G-001');
  btns[0].listeners.click[0]();
  assert.equal(byid.get('dlg-title').textContent, 'Почему волна 1');
  const body = text_of('dlg-body');
  assert.match(body, /Из чего сложилась потребность волны/);
  assert.match(body, /Сходится: сумма строк 1\s720,00\s€ равна пиковой просадке окна 1\s720,00\s€/);
  assert.match(body, /пиковая просадка 1\s720,00\s€/);
  assert.deepEqual(a11y_problems(byid.get('dlg-body')), []);
});

test('TST-58 каждый новый блок «почему» имеет подпись для скринридера и текстовую альтернативу цвету; нет inline-стилей', async () => {
  await go('#overview');
  assert.deepEqual(a11y_problems(byid.get('main')), []);
  await go('#waves');
  assert.deepEqual(a11y_problems(byid.get('main')), []);
  const card = find_all(byid.get('main'), (n) => n.attrs['aria-labelledby'] === 'why-card-h')[0];
  assert.equal(card, undefined, 'на экране волн карточки обзора нет');
  await go('#overview');
  const why = find_all(byid.get('main'), (n) => n.attrs['aria-labelledby'] === 'why-card-h')[0];
  assert.ok(why !== undefined && find_all(why, (n) => n.attrs.id === 'why-card-h')[0].textContent === 'Почему так');
});
