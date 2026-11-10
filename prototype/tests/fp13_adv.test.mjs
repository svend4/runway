// fp13_adv.test.mjs — состязательная проверка FP-13 (календарь выходных и праздников, перенос и своя сумма одного вхождения, разовый платёж).
// Файл добавлен проверяющим аддитивно. Тесты без пометки todo — подтверждённое поведение (круг «открыть — сохранить» для разных форм правил, идемпотентность, отказы).
// Пробы ADV-3…ADV-6 описывали найденные дефекты (были с пометкой todo); после исправления FP-13 (волна 3а, правка после проверки) пометки сняты — пробы зелёные.
// Регрессионные тесты исправлений — tests/calendar_fix.test.mjs.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/fp13_adv.test.mjs. Браузер, сервер и сеть не используются.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const DEMO = path.join(PROTO, 'demo');
const imp = (rel) => import(pathToFileURL(path.join(PROTO, rel)).href);
const G = JSON.parse(fs.readFileSync(path.join(PROTO, 'data', 'g001.json'), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));

// ── заглушка DOM, как в calendar_form.test.mjs (настоящий app.mjs) ──────────────────────────────────────────────────────────────
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
  append(...kids) { for (const k of kids) { this.children.push(k); if (k.nodeType === 1) k.parent = this; } this._text = ''; }
  replaceChildren(...kids) { this.children = []; this._text = ''; this.append(...kids); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() { if (this.parent !== undefined) this.parent.children = this.parent.children.filter((c) => c !== this); }
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
  getElementById: (id) => byid.get(id) ?? find_in(byid.get('main'), id) ?? find_in(byid.get('nav'), id),
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
await import(pathToFileURL(path.join(DEMO, 'app.mjs')).href);
await new Promise((r) => setTimeout(r, 700));

const E = await imp('engine/index.mjs');
const WE = await imp('demo/ws_edit.mjs');
const RULE = await imp('demo/form_rule.mjs');
const CAL = await imp('demo/form_calendar.mjs');
const PLAN = await imp('demo/form_plan.mjs');
const NF = await imp('demo/number_format.mjs');

const NB = /[  ]/g;
const N = (x) => String(x).replace(NB, ' ');
const main = () => byid.get('main');
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const by_id = (id) => find_all(main(), (n) => n.attrs.id === id)[0];
const click = (n) => { assert.ok(n !== undefined, 'нет узла'); n.listeners.click[0](); };
const type_into = (n, value, event = 'input') => { assert.ok(n !== undefined, 'нет поля'); n.value = value; for (const fn of n.listeners[event] ?? []) fn({ target: n }); };
const submit = (id) => { const f = by_id(id); assert.ok(f !== undefined, 'нет формы ' + id); return f.listeners.submit[0]({ preventDefault() {} }); };
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };
const ctx = ext.ctx;
const reset = async (ws = G) => { const r = ctx.adopt(clone(ws), { source: 'test' }); assert.equal(r.ok, true, JSON.stringify(r.error)); await go('#forms'); return r; };
const status_of = (form_id) => find_all(by_id(form_id), (n) => n.attrs.role === 'status').map((n) => N(n.textContent)).join(' ');
const rule_item = (rule_id) => find_all(main(), (n) => n.attrs['data-rule'] === rule_id)[0];

const apply = (ws, edit) => WE.apply_edit(ws, edit, { new_id: (p) => p + '_t1' });
const must = (r) => { assert.equal(r.ok, true, JSON.stringify(r.error)); return r.ws; };

// ── круг «открыть — сохранить» для разных форм правила (подтверждённое поведение) ───────────────────────────────────────────────

/** Тексты формы так, как их заполняет `fill()` экрана правил. */
function texts_from(ws, rule, env) {
  const acc = ws.accounts.find((a) => a.account_id === rule.account_id);
  const nf = NF.resolve_number_format(env.lang, env.nf);
  const wk = Array.isArray(rule.by_weekday) && rule.by_weekday.length > 1 ? rule.by_weekday.join(',') : (Array.isArray(rule.by_weekday) && rule.by_weekday.length === 1 ? String(rule.by_weekday[0]) : '');
  return {
    rule_id: rule.rule_id, name: rule.name, kind: rule.kind,
    amount: NF.format_input_amount(Math.abs(rule.amount?.exp_minor ?? 0), acc.exponent ?? E.currency_exponent(acc.currency), nf, true),
    account_id: rule.account_id, freq: rule.freq, interval: String(rule.interval ?? 1), start_date: rule.start_date,
    monthday: Array.isArray(rule.by_monthday) ? rule.by_monthday.join(', ') : '', workday: Array.isArray(rule.by_workday) ? rule.by_workday.join(', ') : '',
    weekday: wk, weekend: rule.weekend ?? 'keep',
    calendar_id: typeof rule.calendar_id === 'string' && ws.calendars.some((c) => c.calendar_id === rule.calendar_id) ? rule.calendar_id : '',
    until_date: rule.until_date ?? '', is_obligation: rule.is_obligation === true, is_estimate: rule.is_estimate === true,
  };
}

test('ADV-1 круг «открыть — сохранить без изменений» даёт те же данные для разных форм правил: счёт, окончание, количество, исключённые даты, коридор суммы, отрицательные и несколько n-х рабочих дней, длинная сумма', () => {
  const base = G.rules.find((r) => r.rule_id === 'R-RENT');
  const shapes = {
    count: { count: 5 }, exdates: { exdates: ['2026-11-25'] }, month_end_skip: { month_end: 'skip', by_monthday: [31] }, tag: { tag: 'жильё' }, delay: { delay_days_worse: 3 },
    until: { until_date: '2027-06-25' }, interval3: { interval: 3 }, weekend_skip: { weekend: 'skip' }, workday_neg: { by_monthday: null, by_workday: [-1] },
    workday_two: { by_monthday: null, by_workday: [1, -1] }, monthday_neg: { by_monthday: [-1] }, corridor: { amount: { exp_minor: -90000, min_minor: -95000, max_minor: -85000 } },
    income_big: { kind: 'income', amount: { exp_minor: 123456789012 } }, reserve_link: { reserve_id: 'RES-INS' },
  };
  for (const [label, patch] of Object.entries(shapes)) {
    const ws = clone(G);
    ws.rules = [{ ...clone(base), rule_id: 'R-X', ...clone(patch) }];
    for (const k of Object.keys(ws.rules[0])) if (ws.rules[0][k] === null) delete ws.rules[0][k];
    ws.overrides = []; ws.streams = [];
    const env = { cur: 'EUR', lang: 'ru', nf: undefined, as_of: ws.as_of };
    const built = RULE.build_rule_edit(ws, texts_from(ws, ws.rules[0], env), env);
    assert.equal(built.ok, true, label + ': ' + JSON.stringify(built.error));
    assert.equal(E.canon(must(apply(ws, built.edit))), E.canon(ws), label + ': данные и версия прежние');
  }
});

test('ADV-2 повтор правки переноса и своей суммы по тому же вхождению из формы не плодит записей и не меняет inputs_hash, а «пропуск» поверх переноса заменяет его', () => {
  const rent = RULE.move_edit('R-RENT', '2026-10-25', '2026-10-28');
  const once = must(apply(G, rent));
  const twice = must(apply(once, rent));
  assert.equal(E.canon(twice), E.canon(once));
  const skip = must(apply(twice, RULE.skip_edit('R-RENT', '2026-10-25')));
  assert.deepEqual(skip.overrides, [{ rule_id: 'R-RENT', nominal_date: '2026-10-25', action: 'skip' }]);
});

// ── ранее найденные дефекты (исправлены; пробы остаются регрессионными) ──────────────────────────────────────────────────────────────

test('ADV-3 форма правила принимает ISO из поля type="date" при стиле дат «ДД.ММ.ГГГГ» и «ММ/ДД/ГГГГ» (как это сделано для переноса, разового платежа и праздников)', () => {
  for (const [lang, nf] of [['ru', { date: 'dmy' }], ['en', { date: 'mdy' }]]) {
    const env = { cur: 'EUR', lang, nf, as_of: G.as_of };
    const rule = G.rules.find((r) => r.rule_id === 'R-RENT');
    const t = texts_from(G, rule, env);
    const r = RULE.build_rule_edit(G, { ...t, until_date: '2027-06-25' }, env);
    assert.equal(r.ok, true, `${lang} ${nf.date}: ${JSON.stringify(r.error)}`);
  }
});

test('ADV-3b то же в настоящем приложении: при стиле дат «ДД.ММ.ГГГГ» кнопка «Записать» формы правила принимает дату начала из поля type="date"', async () => {
  const ws = clone(G);
  ws.number_format = { date: 'dmy' };
  await reset(ws);
  type_into(by_id('fp08-rule-name'), 'Проба');
  type_into(by_id('fp08-rule-amount'), '10');
  type_into(by_id('fp08-rule-start_date'), '2026-11-01');
  const n0 = ctx.get_ws().rules.length;
  submit('fp08-rule');
  assert.equal(ctx.get_ws().rules.length, n0 + 1, status_of('fp08-rule'));
});

test('ADV-4 календарь, на который ссылается резерв (calendar_id или cadence.calendar_id), не удаляется: иначе analyze бросает E_SCHEMA unknown_calendar', () => {
  for (const place of ['calendar_id', 'cadence']) {
    const ws = clone(G);
    ws.calendars.push({ calendar_id: 'cal-x', name: 'X', weekend_dows: [0, 6], holidays: [] });
    const res = ws.reserves.find((r) => r.reserve_id === 'RES-INS');
    if (place === 'calendar_id') res.calendar_id = 'cal-x'; else res.cadence = { ...res.cadence, calendar_id: 'cal-x' };
    E.analyze(ws, { as_of: ws.as_of }); // исходная область считается
    const r = apply(ws, { type: 'delete_calendar', calendar_id: 'cal-x' });
    if (r.ok) assert.doesNotThrow(() => E.analyze(r.ws, { as_of: r.ws.as_of }), place + ': после удаления расчёт падает');
  }
});

test('ADV-5 смена календаря не оставляет «осиротевших» правок вхождения у правила с n-м рабочим днём: пропуск остаётся виден как пропуск существующего вхождения', () => {
  const ws = clone(G);
  ws.rules.push({ rule_id: 'R-WD', account_id: 'acc_main', name: 'Взнос', kind: 'expense', currency: 'EUR', freq: 'M', interval: 1, start_date: '2026-10-01', weekend: 'keep', by_workday: [3],
    calendar_id: 'cal-main', amount: { exp_minor: -10000 }, month_end: 'clamp', exdates: [], is_obligation: false, is_estimate: false });
  const skipped = must(apply(ws, RULE.skip_edit('R-WD', '2026-11-04')));
  const moved = must(apply(skipped, { type: 'upsert_calendar', calendar: { calendar_id: 'cal-main', name: 'Суббота и воскресенье', weekend_dows: [0, 6], holidays: ['2026-11-03'] } }));
  const noms = E.expand_all(moved.rules.filter((r) => r.rule_id === 'R-WD'), { from: E.to_epoch_day('2026-10-01'), to: E.to_epoch_day('2027-01-31') }, moved.calendars, []).map((o) => E.format_date(o.nominal));
  const orphan = RULE.skipped_of(moved, 'R-WD', moved.as_of).filter((d) => !noms.includes(d));
  assert.deepEqual(orphan, [], 'пропуск ссылается на несуществующее вхождение: платёж вернулся в прогноз, а «Вернуть» показывает пропуск');
});

test('ADV-6 разовый платёж, введённый с ошибкой в дате (в прошлом, раньше последней сверки остатка), можно исправить или удалить с экрана', async () => {
  await reset();
  type_into(by_id('fp08-plan-name'), 'Опечатка в году');
  type_into(by_id('fp08-plan-amount'), '10');
  type_into(by_id('fp08-plan-date'), '2025-10-08');
  submit('fp08-plan');
  const plan = ctx.get_ws().plans.at(-1);
  assert.equal(plan.date, '2025-10-08');
  await go('#reconcile');
  const in_reconcile = N(main().textContent).includes('Опечатка в году');
  await go('#forms');
  assert.equal(in_reconcile, false, 'вне сверки: платёж раньше последней сверки остатка не попадает в очередь');
  const reachable = find_all(by_id('fp13-plans'), (n) => (n.attrs['data-act'] === 'plan-edit' || n.attrs['data-act'] === 'plan-delete') && N(n.attrs['aria-label'] ?? '').includes('Опечатка в году'));
  assert.ok(reachable.length > 0, 'нет кнопок «Править» и «Удалить» у прошедшего платежа');
});

// ── границы, которые реализатор закрыл верно (подтверждение) ────────────────────────────────────────────────────────────────────

test('ADV-7 границы календаря и платежа: 1000 праздников подряд и год 2200 принимаются и считаются; 1001 и 2201 — отказ с кодом; ключи-ловушки отвергаются', () => {
  const hol = []; const d0 = E.to_epoch_day('2026-10-26');
  for (let i = 0; i < 1000; i++) hol.push(E.format_date(d0 + i));
  const okws = must(apply(G, { type: 'upsert_calendar', calendar: { calendar_id: 'cal-main', name: 'x', weekend_dows: [0, 6], holidays: hol } }));
  assert.doesNotThrow(() => E.analyze(okws, { as_of: okws.as_of }));
  const over = apply(G, { type: 'upsert_calendar', calendar: { calendar_id: 'cal-main', name: 'x', weekend_dows: [0, 6], holidays: [...hol, '2030-01-01'] } });
  assert.equal(over.ok, false); assert.equal(over.error.ctx.reason, 'cal_too_many_holidays');
  const far = apply(G, { type: 'upsert_calendar', calendar: { calendar_id: 'cal-main', name: 'x', weekend_dows: [0, 6], holidays: ['2201-01-01'] } });
  assert.equal(far.ok, false); assert.equal(far.error.code, 'E_BAD_DATE');
  for (const bad of ['__proto__', 'constructor', 'toString']) {
    const r = apply(G, { type: 'upsert_calendar', calendar: { calendar_id: 'cal-main', name: 'x', weekend_dows: [0, 6], holidays: [], [bad]: 1 } });
    assert.equal(r.ok, false, bad);
  }
  assert.equal(Object.keys(CAL).includes('edit_upsert_calendar'), true);
  assert.equal(typeof PLAN.edit_upsert_plan, 'function');
});

test('ADV-8 приложение: удаление календаря, нужного резерву, не портит данные — запись отклоняется целиком, текст отказа называет причину и код канона', async () => {
  const ws = clone(G);
  ws.calendars.push({ calendar_id: 'cal-x', name: 'Запасной', weekend_dows: [0, 6], holidays: [] });
  ws.reserves.find((r) => r.reserve_id === 'RES-INS').calendar_id = 'cal-x';
  await reset(ws);
  const del = find_all(by_id('fp13-calendars'), (n) => n.attrs['data-act'] === 'cal-delete' && N(n.attrs['aria-label']).includes('Запасной'))[0];
  const n0 = ctx.journal.length;
  click(del);
  assert.deepEqual(ctx.get_ws().calendars.map((c) => c.calendar_id), ['cal-main', 'cal-x'], 'данные не тронуты');
  assert.equal(ctx.journal.length, n0, 'журнал не растёт');
  const last = ext.diagnostics().filter((d) => d.status === 'notify').map((d) => N(d.message)).at(-1);
  assert.match(last, /^Не принято \(E_SCHEMA\)/, 'отказ называет код канона');
  assert.doesNotThrow(() => ctx.get_model());
});
