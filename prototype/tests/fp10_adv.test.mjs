// fp10_adv.test.mjs — состязательная проверка FP-10 (независимый проверяющий): пробы, которых нет в wizard / v0 / metrics / start_boot.
// Покрывает: (1) метрики — выключатель переживает «Очистить метрики» (согласие пользователя не должно сбрасываться очисткой);
// (2) v0 — открытие испорченного файла не бросает исключений и не оставляет страницу в нерабочем состоянии;
// (3) v0 — числа формы сверены независимым расчётом по дням (оракул без движка): остаток, платёж, поступление с задержкой, перенос выходного дня;
// (4) мастер — подсказка «платежей добавлено» не противоречит отметке «учтено» движка; время ухода с экрана не приписывается шагу;
// (5) v0 — введённое в верх формы не пропадает при добавлении строки; (6) мастер — фокус на заголовке шага переживает позднюю перерисовку после записи
// (хранилище FP-05 после каждой правки просит ctx.refresh() уже после того, как мастер поставил фокус; у wave_edit.mjs от этого сделана страховка, у мастера нет).
// Пробы описывают ПРАВИЛЬНОЕ поведение. На момент проверки семь из восьми были красными или помеченными todo (воспроизведение дефектов FP-10); после исправления
// (волна 2, «исправление дефектов после проверки») все восемь зелёные и идут обычными тестами (без todo) — это закрепляет исправления: ADV-1 (очистка метрик не снимает отказ),
// ADV-8 (фокус мастера переживает позднюю перерисовку), ADV-2/3 (испорченная форма v0 в файле), ADV-5 (подсказка «n из 3»), ADV-6 (простой вне экрана «Старт»),
// ADV-7 (введённое в верх формы v0 не пропадает); ADV-4 (числа v0 по независимому оракулу) зелёный с самого начала.
// DOM подменён заглушкой; браузер и сеть не используются. Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

class FakeNode {
  constructor(tag) { this.nodeType = 1; this.tagName = tag; this.attrs = {}; this.children = []; this.listeners = {}; this.className = ''; this._text = ''; this._value = ''; this._sel = null; this.focused = false; }
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
  click() {}
  remove() {}
  querySelectorAll() { return []; }
  walk(fn) { fn(this); for (const c of this.children) if (c.nodeType === 1) c.walk(fn); }
}
const CUR = { root: null };
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const by_id = (root, id) => find_all(root, (n) => n.attrs.id === id)[0];
const REG = new Map();
for (const id of ['main', 'v0-lang-ru', 'v0-lang-en']) REG.set(id, new FakeNode(id === 'main' ? 'main' : 'div'));
globalThis.document = {
  createElement: (t) => new FakeNode(t), createElementNS: (_n, t) => new FakeNode(t), createTextNode: (data) => ({ nodeType: 3, data }),
  getElementById: (id) => REG.get(id) ?? (CUR.root === null ? null : by_id(CUR.root, id) ?? null),
  documentElement: new FakeNode('html'), head: new FakeNode('head'), body: new FakeNode('body'), title: '',
};
Object.defineProperty(globalThis, 'navigator', { value: { language: 'ru-RU' }, configurable: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.resolve(HERE, '..');
const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);
const E = await imp('engine', 'index.mjs');
const APP = await imp('demo', 'app.mjs');
const { create_ext } = await imp('demo', 'ext.mjs');
const I18N = await imp('demo', 'i18n.mjs');
const { seeded_ports } = await imp('demo', 'ids.mjs');
const MX = await imp('demo', 'metrics.mjs');
const TOOLS = await imp('engine', 'tools.mjs');
const V0 = await imp('demo', 'v0.mjs');
const W = await imp('demo', 'wizard.mjs');
const PACK = await imp('demo', 'pack_fp10.mjs');
I18N.register_strings('settings', (await imp('demo', 'i18n', 'settings.mjs')).default);
I18N.register_strings('start', (await imp('demo', 'i18n', 'start.mjs')).default);
const EMPTY = JSON.parse(fs.readFileSync(path.join(PROTO, 'data', 'g001-empty.json'), 'utf8'));

function fake_storage() {
  const m = new Map();
  return { m, get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}

async function make_page(ws = EMPTY) {
  const e = create_ext({ ports: seeded_ports({ seed: 11 }) });
  const st = { ws, lang: 'ru', root: null };
  const build = (w) => APP.build_model(w, { lang: st.lang });
  st.model = build(ws);
  e.bind_host({
    get_ws: () => st.ws, get_model: () => st.model, lang: () => st.lang, mode: () => 'worse', fmt: () => APP.make_fmt(st.lang, st.model.cur, st.model.as_of_iso),
    set_ws: (next) => { let m; try { m = build(next); } catch (err) { return { ok: false, error: err }; } st.ws = next; st.model = m; return { ok: true }; },
    render: () => { st.root = e.render_view('start'); CUR.root = st.root; },
    notify: () => {},
  });
  const clock = { t: 1_000_000 };
  const deps = PACK.register(e, { ports: { now_ms: () => clock.t, tz_offset_min: () => 0 }, storage: fake_storage() });
  await e.run('boot');
  st.root = e.render_view('start');
  CUR.root = st.root;
  const page = { e, ctx: e.ctx, st, deps, clock, mx: deps.metrics };
  page.submit = (form_id, values = {}) => {
    for (const [id, v] of Object.entries(values)) by_id(st.root, id).value = v;
    return by_id(st.root, form_id).listeners.submit[0]({ preventDefault() {} });
  };
  page.click = (id) => by_id(st.root, id).listeners.click[0]();
  return page;
}

// ── (1) метрики: выключатель и очистка ──────────────────────────────────────────────────────────────────────────────────

test('ADV-1 REQ-185 выключатель метрик переживает «Очистить метрики»: очистка стирает собранное, но не отменяет отказ пользователя от подсчёта', () => {
  const st = fake_storage();
  const mx = MX.create_metrics({ storage: st, day: () => 20730, engine_version: E.ENGINE_VERSION });
  mx.begin_session();
  assert.equal(mx.set_enabled(false), true);
  assert.equal(mx.enabled(), false);
  assert.equal(mx.clear(), true);
  assert.equal(mx.enabled(), false, 'после очистки метрики остаются выключенными (пользователь их выключил)');
  assert.equal(mx.begin_session(), null, 'и ничего не записывают');
  assert.equal(mx.bump('facts_added'), false);
  assert.equal(mx.package().sessions, 0, 'очистка действительно обнулила собранное');
});

// ── (2) v0: испорченный файл ────────────────────────────────────────────────────────────────────────────────────────────

const ENV = { cur: 'EUR', lang: 'ru', as_of: '2026-10-04' };

function good_form() {
  let f = { ...V0.empty_form('2026-10-04'), balance_minor: 400000, buffer_minor: 50000, purchase: { amount_minor: 30000, date: '2026-10-12' } };
  const add = (bucket, parse, t) => { const p = parse(t, ENV); assert.equal(p.ok, true, JSON.stringify(p.error)); f = V0.add_item(f, bucket, p.value).form; };
  add('payments', V0.parse_payment, { name: 'Аренда', amount: '900', freq: 'M', date: '2026-10-25', weekend: 'next', kind: 'obligation' });
  add('incomes', V0.parse_income, { name: 'Выплата', amount: '2790', freq: 'once', date: '2026-11-05', delay: '14' });
  add('reserves', V0.parse_reserve, { kind: 'tax', name: 'Конверт', funded: '1500', rate: '20' });
  return f;
}

const clone = (x) => JSON.parse(JSON.stringify(x));
function file_with(mutate) {
  const form = clone(good_form());
  mutate(form);
  const ws = clone(V0.form_to_ws(good_form()).ws);
  ws[V0.FORM_KEY] = form;
  return JSON.stringify(ws);
}

test('ADV-2 REQ-180 REQ-091 read_state не бросает исключений на испорченной форме v0 в файле: отказ кодом или открытие как чужого файла', () => {
  const cases = {
    'платёж = null': (g) => { g.payments[0] = null; },
    'резерв = null': (g) => { g.reserves = [null]; },
    'поступление = число': (g) => { g.incomes[0] = 5; },
    'дата платежа — число': (g) => { g.payments[0].date = 5; },
  };
  for (const [name, mut] of Object.entries(cases)) {
    let r;
    assert.doesNotThrow(() => { r = V0.read_state(file_with(mut)); }, name);
    assert.equal(typeof r.ok, 'boolean', name);
  }
});

test('ADV-3 REQ-180 файл, принятый read_state как «v0», рисуется без исключений (иначе страница остаётся с испорченной формой до перезагрузки)', () => {
  const r = V0.read_state(file_with((g) => { g.reserves[0].kind = 'x'; }));
  assert.equal(r.ok, true);
  if (r.kind !== 'v0') return; // открытие как чужого файла — тоже допустимый исход
  for (const lang of ['ru', 'en']) {
    const page = { lang, form: r.form, foreign: null, purchase: null, notice: '', changed: () => {} };
    assert.doesNotThrow(() => V0.render_page(page), 'рисование, язык ' + lang);
  }
});

// ── (3) v0: числа формы — независимый оракул ────────────────────────────────────────────────────────────────────────────

test('ADV-4 REQ-180 числа формы v0 сверены независимым расчётом по дням (без движка): платёж, поступление с задержкой, перенос выходного дня', () => {
  const day = (iso) => E.to_epoch_day(iso);
  const as_of = day('2026-10-04');
  // остаток 1000 €, платёж 100 € ежемесячно с 22 октября, поступление 500 € один раз 20 октября (в режиме «если хуже» +5 дней), покупка 300 € 6 октября, буфер 0
  const oracle = (late) => {
    let bal = 100000; let best = null;
    for (let d = as_of; d <= as_of + 60; d++) {
      const iso = E.format_date(d);
      if (iso === '2026-10-06') bal -= 30000;
      if (iso.slice(8) === '22' && d >= day('2026-10-22')) bal -= 10000;
      if (d === day('2026-10-20') + (late ? 5 : 0)) bal += 50000;
      if (best === null || bal < best.v) best = { v: bal, d: iso };
    }
    return best;
  };
  let f = { ...V0.empty_form('2026-10-04'), balance_minor: 100000, buffer_minor: 0 };
  const add = (bucket, parse, t) => { const p = parse(t, ENV); assert.equal(p.ok, true, JSON.stringify(p.error)); f = V0.add_item(f, bucket, p.value).form; };
  add('payments', V0.parse_payment, { name: 'Платёж', amount: '100', freq: 'M', date: '2026-10-22', weekend: 'keep', kind: 'obligation' });
  add('incomes', V0.parse_income, { name: 'Доход', amount: '500', freq: 'once', date: '2026-10-20', delay: '5' });
  const built = V0.form_to_ws(f);
  assert.equal(built.ok, true);
  const ctx = tool_ctx(built.ws);
  for (const [mode, late] of [['plan', false], ['worse', true]]) {
    // минимум физических денег после покупки по движку (ряд trough + вычет покупки с её даты) против оракула
    const series = ctx.series[mode];
    let best = null;
    for (let i = 0; i < series.trough.length; i++) {
      const iso = E.format_date(series.from + i);
      const v = series.trough[i] - (iso >= '2026-10-06' ? 30000 : 0);
      if (best === null || v < best.v) best = { v, d: iso };
    }
    assert.deepEqual(best, oracle(late), 'режим ' + mode);
  }
  // перенос выходного дня: платёж в субботу 10 октября с переносом «на следующий рабочий день» уходит на понедельник 12-е, без переноса — остаётся в субботу
  const weekend_case = (weekend) => {
    let g = { ...V0.empty_form('2026-10-04'), balance_minor: 100000, buffer_minor: 0 };
    const p = V0.parse_payment({ name: 'Выходной', amount: '100', freq: 'M', date: '2026-10-10', weekend, kind: 'obligation' }, ENV);
    g = V0.add_item(g, 'payments', p.value).form;
    const c = tool_ctx(V0.form_to_ws(g).ws);
    const tr = c.series.plan.trough;
    const drop = tr.findIndex((v) => v < 100000);
    return E.format_date(c.series.plan.from + drop);
  };
  assert.equal(weekend_case('keep'), '2026-10-10');
  assert.equal(weekend_case('next'), '2026-10-12');
});

function tool_ctx(ws) { return TOOLS.make_tool_ctx(ws, { as_of: ws.as_of }, { locale: 'ru' }); }

// ── (4) мастер: подсказка о числе платежей и время ──────────────────────────────────────────────────────────────────────

test('ADV-5 REQ-110 подсказка шага «Обязательства» не противоречит отметке «учтено»: если движок засчитал шаг одним крупным платежом, строка не должна говорить «1 из 3» как о недоборе', async () => {
  const p = await make_page(EMPTY);
  p.submit('st-form-acc', { 'st-acc-balance': '4000' });
  p.submit('st-form-obl', { 'st-obl-name': 'Аренда', 'st-obl-amount': '900', 'st-obl-date': '2026-10-25' });
  const m = W.wizard_model(p.st.model);
  const progress = find_all(p.st.root, (n) => n.className === 'start-progress')[0].textContent;
  if (m.done.obligations && m.obligations.length < W.MIN_OBLIGATIONS) {
    assert.ok(!/из\s+3\./.test(progress) || /достаточно|учтён|засчитан/i.test(progress), 'шаг засчитан движком, а подсказка: «' + progress + '»');
  }
});

test('ADV-6 REQ-110 REQ-185 время, проведённое вне экрана «Старт», не приписывается шагу мастера как активная работа', async () => {
  const p = await make_page(EMPTY);
  p.clock.t += 5_000;
  p.click('st-skip'); // шаг 1 → 2, засчитано ≈ 5 с шагу 1
  p.clock.t += 3 * 3600_000; // три часа на другом экране, затем возврат на «Старт» (перерисовка)
  p.ctx.refresh();
  p.clock.t += 4_000;
  p.click('st-skip'); // шаг 2 пропущен: активная работа ≈ 4 с
  const steps = p.mx.package().steps;
  assert.deepEqual(steps.map((s) => s.step), ['account', 'obligations']);
  assert.ok(steps[1].seconds <= 5, 'шагу «обязательства» записано ' + steps[1].seconds + ' с при 4 с активной работы (остальное — простой на другом экране)');
});

// ── (5) v0: введённое не должно пропадать ───────────────────────────────────────────────────────────────────────────────

test('ADV-7 REQ-180 введённый, но не «принятый» остаток не пропадает молча при добавлении платежа (или страница явно предупреждает, что верх формы надо принять)', () => {
  const page = { lang: 'ru', form: V0.empty_form('2026-10-04'), foreign: null, purchase: null, notice: '', changed: null };
  page.changed = (notice) => { page.notice = typeof notice === 'string' ? notice : ''; V0.render_page(page); };
  V0.render_page(page);
  const main = REG.get('main');
  by_id(main, 'v0-balance').value = '4000';
  by_id(main, 'v0-pay-name').value = 'Аренда';
  by_id(main, 'v0-pay-amount').value = '900';
  by_id(main, 'v0-pay-date').value = '2026-10-25';
  const r = by_id(main, 'v0-form-payments').listeners.submit[0]({ preventDefault() {} });
  assert.equal(r.ok, true);
  assert.equal(by_id(REG.get('main'), 'v0-balance').value, '4000', 'остаток, введённый в верхней форме, должен сохраниться при добавлении платежа');
});

// ── (6) мастер: фокус после записи и поздняя перерисовка хранилища ──────────────────────────────────────────────────────

const tick = () => new Promise((r) => setImmediate(r));

test('ADV-8 TST-58 после записи шага фокус остаётся на заголовке шага и после поздней перерисовки страницы (её просит хранилище FP-05 через data_runtime.ping → ctx.refresh)', async () => {
  const p = await make_page(EMPTY);
  p.submit('st-form-acc', { 'st-acc-balance': '4000' });
  await tick();
  assert.equal(by_id(p.st.root, 'st-step-title').focused, true, 'сразу после записи фокус на заголовке (это проверяет и wizard.test)');
  p.ctx.refresh(); // позднее ctx.refresh() от хранилища: в настоящем браузере прежний узел с фокусом заменён, фокус ушёл на body
  await tick();
  assert.equal(by_id(p.st.root, 'st-step-title').focused, true, 'после поздней перерисовки заголовок нового шага должен получить фокус снова');
});
