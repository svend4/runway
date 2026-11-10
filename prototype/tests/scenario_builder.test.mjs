// scenario_builder.test.mjs — FP-07: конструктор сценариев (REQ-049, REQ-051, REQ-050; TST-33, TST-27, TST-58) и операция `hours` через engine/scenario_ext.mjs.
// Чистые модели (demo/scenario_builder.mjs, engine/scenario_ext.mjs) — на G-001; DOM — в настоящем app.mjs на заглушке DOM (как settings_boot.test.mjs).
// Браузер не используется.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
const SB = await import(pathToFileURL(path.join(DEMO, 'scenario_builder.mjs')).href);
const SX = await import('../engine/scenario_ext.mjs');
const E = await import('../engine/index.mjs');
const { apply_edit } = await import(pathToFileURL(path.join(DEMO, 'ws_edit.mjs')).href);
const { ws_to_events, ws_to_journal, journal_to_ws } = await import(pathToFileURL(path.join(DEMO, 'ws_bridge.mjs')).href);
const { analyze, apply_scenario, build_events, scenario_fx_shock, canon } = E;

const read = (name) => JSON.parse(fs.readFileSync(path.join(DATA, name + '.json'), 'utf8'));
const G = read('g001');
const A0 = analyze(G, { as_of: G.as_of });
const FLOWS = SB.list_flows(A0);
const ENV = { flows: FLOWS, as_of: A0.as_of, horizon_end: A0.horizon_end, currencies: [], streams: G.streams };
const ok_op = (kind, input, env = ENV) => { const r = SB.build_op(kind, input, env); assert.equal(r.ok, true, JSON.stringify(r)); return r.op; };
const sha = (x) => crypto.createHash('sha256').update(canon(x)).digest('hex');
const code_of = (fn) => { try { fn(); } catch (e) { return e.code + ':' + (e.ctx?.reason ?? ''); } return null; };
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };
const text_of = (id) => byid.get(id).textContent;
const field = (id) => find_all(byid.get('main'), (n) => n.attrs.id === id)[0];
const press = (label, nth = 0) => {
  const bs = find_all(byid.get('main'), (n) => n.tagName === 'button' && (n.textContent === label || n.attrs['aria-label'] === label));
  assert.ok(bs[nth] !== undefined, 'нет кнопки «' + label + '»');
  bs[nth].listeners.click[0]();
};
const a11y_problems = (root) => {
  const ids = new Set();
  const labels_for = new Set();
  root.walk((n) => { if (n.attrs.id !== undefined) ids.add(n.attrs.id); if (n.tagName === 'label' && n.attrs.for !== undefined) labels_for.add(n.attrs.for); });
  const bad = [];
  root.walk((n) => {
    if (n.attrs.style !== undefined) bad.push('inline style');
    if (n.tagName === 'table' && !n.children.some((c) => c.tagName === 'caption' && c.textContent.trim() !== '')) bad.push('таблица без подписи');
    if (n.attrs['aria-labelledby'] !== undefined && !n.attrs['aria-labelledby'].split(' ').every((i) => ids.has(i))) bad.push('aria-labelledby → нет id: ' + n.attrs['aria-labelledby']);
    if (n.tagName === 'button' && n.textContent.trim() === '' && !n.attrs['aria-label']) bad.push('кнопка без текста');
    if (['input', 'select', 'textarea'].includes(n.tagName) && !labels_for.has(n.attrs.id) && !n.attrs['aria-label']) bad.push('поле без подписи: ' + n.attrs.id);
  });
  return bad;
};

/** Набор G-001 с долларовым доходом: 2000,00 $ на 20 октября, курс 0,9250 (TST-27). */
function usd_ws() {
  return {
    ...G,
    accounts: [...G.accounts, { account_id: 'acc_usd', name: 'USD', kind: 'bank', liquidity: 'operating', currency: 'USD', exponent: 2, opened_on: '2026-01-01' }],
    anchors: [...G.anchors, { anchor_id: 'a-usd', account_id: 'acc_usd', date: '2026-10-04', amount_minor: 0 }],
    rates: [...(G.rates ?? []), { fx_id: 'r-usd', date: '2026-10-01', base: 'USD', quote: 'EUR', num: 9250, den: 10000 }],
    plans: [...(G.plans ?? []), { plan_id: 'U-INC', account_id: 'acc_usd', name: 'Доллары', date: '2026-10-20', amount_minor: 200000, currency: 'USD', kind: 'income', tag: 'usd' }],
  };
}

// ── TST-33 · REQ-049: операции строят ops и проходят apply_scenario ─────────────────────────────────────────────────

test('TST-33 REQ-049: пять операций движка и сдвиг выбранного поступления строятся конструктором и проходят apply_scenario; список платежей — ожидаемые события от дня расчёта', () => {
  assert.equal(FLOWS.length, 16);
  assert.ok(FLOWS.every((f) => f.date >= A0.as_of && Number.isSafeInteger(f.amount_minor)));
  const ops = [
    ok_op('shift_flow', { ref: 'R-RENT@2026-10-25', days: 3 }),
    ok_op('set_amount', { ref: 'R-UTIL@2026-10-25', amount_minor: 15000 }),
    ok_op('remove_flow', { ref: 'R-UTIL@2026-11-25' }),
    ok_op('add_flow', { when: 'once', kind: 'expense', amount_minor: 5000, date: '2026-10-10', tag: 'тест' }),
    ok_op('add_flow', { when: 'monthly', kind: 'income', amount_minor: 3000, date: '2026-10-15', tag: 'аренда ниши', n: 1 }),
    ok_op('fx_shock', { currency: 'USD', bp: -500 }, { ...ENV, currencies: ['USD'] }),
    ok_op('shift_income', { ref: 'S-HOURLY@2026-11-05', days: 7 }),
  ];
  assert.deepEqual(ops.map((o) => o.op), ['shift_flow', 'set_amount', 'remove_flow', 'add_flow', 'add_flow', 'fx_shock', 'delay_income']);
  assert.equal(ops[1].amount_minor, -15000, 'знак суммы берётся у платежа');
  const ctx = { as_of: A0.as_of, horizon_end: A0.horizon_end, calendars: G.calendars, default_account_id: 'acc_main', default_currency: 'EUR', decision_currency: 'EUR' };
  for (const op of ops) {
    const out = apply_scenario(A0.events.plan, { scenario_id: 'tst', ops: [op] }, ctx); // не бросает
    assert.ok(Array.isArray(out));
    const a = analyze(G, { as_of: G.as_of, scenario: { scenario_id: 'tst', ops: [op] } });
    assert.ok(a.series.plan.close.length > 0);
  }
  const all = analyze(G, { as_of: G.as_of, scenario: { ops: ops.slice(0, 5) } });
  assert.ok(all.events.plan.some((e) => e.layer === 'hypothetical'), 'гипотетические события помечены слоем «гипотеза»');
});

test('TST-33 REQ-049: результат сценария совпадает с ручным редактированием копии данных (сдвиг, сумма, удаление, новая запись)', () => {
  const same = (ws2, op) => {
    const a = analyze(G, { as_of: G.as_of, scenario: { ops: [op] } });
    const b = analyze(ws2, { as_of: ws2.as_of });
    for (const m of ['plan', 'worse']) {
      assert.deepEqual(a.series[m].trough, b.series[m].trough, op.op + ' ' + m);
      assert.deepEqual(a.series[m].close, b.series[m].close, op.op + ' ' + m);
    }
  };
  same({ ...G, overrides: [{ rule_id: 'R-RENT', nominal_date: '2026-10-25', action: 'move', date: '2026-10-29' }] }, ok_op('shift_flow', { ref: 'R-RENT@2026-10-25', days: 3 }));
  same({ ...G, overrides: [{ rule_id: 'R-UTIL', nominal_date: '2026-10-25', action: 'set_amount', amount_minor: -15000 }] }, ok_op('set_amount', { ref: 'R-UTIL@2026-10-25', amount_minor: 15000 }));
  same({ ...G, overrides: [{ rule_id: 'R-UTIL', nominal_date: '2026-11-25', action: 'skip' }] }, ok_op('remove_flow', { ref: 'R-UTIL@2026-11-25' }));
  same({ ...G, plans: [...G.plans, { plan_id: 'M-1', account_id: 'acc_main', date: '2026-10-10', amount_minor: -5000, currency: 'EUR', kind: 'expense', tag: 'тест' }] },
    ok_op('add_flow', { when: 'once', kind: 'expense', amount_minor: 5000, date: '2026-10-10', tag: 'тест' }));
});

test('TST-33 REQ-049: операция по правилу или потоку целиком (scope all) — shift_flow и remove_flow берут rule_id / stream_id; у разовой записи серии нет', () => {
  const shift = ok_op('shift_flow', { ref: 'R-GROC@2026-10-10', days: 1, scope: 'all' });
  assert.equal(shift.event_ref, 'R-GROC');
  const a = analyze(G, { as_of: G.as_of, scenario: { ops: [shift] } });
  const dates = a.events.plan.filter((e) => e.rule_id === 'R-GROC').map((e) => e.date);
  const base = A0.events.plan.filter((e) => e.rule_id === 'R-GROC').map((e) => e.date);
  assert.deepEqual(dates.map((d, i) => d - base[i]), dates.map(() => 1));
  const rem = ok_op('remove_flow', { ref: 'R-GROC@2026-10-10', scope: 'all' });
  assert.equal(analyze(G, { as_of: G.as_of, scenario: { ops: [rem] } }).events.plan.filter((e) => e.rule_id === 'R-GROC').length, 0);
  const r = SB.build_op('remove_flow', { ref: 'P-TAX1', scope: 'all' }, ENV);
  assert.deepEqual([r.ok, r.reason], [false, 'no_series']);
});

test('TST-33 REQ-049: отказы до записи — неизвестный платёж, дни, суммы, даты вне горизонта, вид записи, валюта вне данных, поток; сообщения без пользовательского текста', () => {
  const no = (kind, input, field, reason, env = ENV) => {
    const r = SB.build_op(kind, input, env);
    assert.deepEqual([r.ok, r.field, r.reason], [false, field, reason], JSON.stringify([kind, input]));
  };
  no('shift_income', { ref: 'нет', days: 3 }, 'ref', 'unknown_flow');
  no('shift_income', { ref: 'R-RENT@2026-10-25', days: 3 }, 'ref', 'not_income');
  no('shift_income', { ref: 'S-HOURLY@2026-11-05', days: 0 }, 'days', 'days_1_3650');
  no('shift_income', { ref: 'S-HOURLY@2026-11-05', days: 1.5 }, 'days', 'days_1_3650');
  no('shift_flow', { ref: 'R-RENT@2026-10-25', days: 0 }, 'days', 'days_nonzero_365');
  no('shift_flow', { ref: 'R-RENT@2026-10-25', days: 400 }, 'days', 'days_nonzero_365');
  no('set_amount', { ref: 'R-RENT@2026-10-25', amount_minor: 0 }, 'amount_minor', 'amount_positive');
  no('set_amount', { ref: 'R-RENT@2026-10-25', amount_minor: null }, 'amount_minor', 'amount_positive');
  no('add_flow', { when: 'once', kind: 'transfer', amount_minor: 5, date: '2026-10-10' }, 'kind', 'kind_income_expense');
  no('add_flow', { when: 'once', kind: 'expense', amount_minor: 5, date: '2026-10-01' }, 'date', 'outside_horizon');
  no('add_flow', { when: 'once', kind: 'expense', amount_minor: 5, date: '2027-10-10' }, 'date', 'outside_horizon');
  no('add_flow', { when: 'once', kind: 'expense', amount_minor: 5, date: 'вчера' }, 'date', 'bad_date');
  no('fx_shock', { currency: 'usd', bp: -500 }, 'currency', 'bad_currency');
  no('fx_shock', { currency: 'USD', bp: -500 }, 'currency', 'currency_not_in_data');
  no('fx_shock', { currency: 'USD', bp: 0 }, 'bp', 'bp_range', { ...ENV, currencies: ['USD'] });
  no('fx_shock', { currency: 'USD', bp: -20000 }, 'bp', 'bp_range', { ...ENV, currencies: ['USD'] });
  no('hours', { stream_id: 'нет', minutes: 100 }, 'stream_id', 'unknown_stream');
  no('hours', { stream_id: 'S-HOURLY', minutes: -1 }, 'minutes', 'bad_minutes');
  no('hours', { stream_id: 'S-HOURLY', minutes: 44641 }, 'minutes', 'bad_minutes');
  no('рисунок', {}, 'kind', 'unknown_kind');
  assert.deepEqual([SB.parse_int_text('14'), SB.parse_int_text(' −3 '), SB.parse_int_text('+5'), SB.parse_int_text('1,5'), SB.parse_int_text(''), SB.parse_int_text('9999999999')], [14, -3, 5, null, null, null]);
});

// ── сохранение в набор ──────────────────────────────────────────────────────────────────────────────────────────────

test('TST-33 REQ-049: сохранённый сценарий входит в экспорт (журнал и файл-копия), сохранение и удаление не меняют хэш фактов и базовые ряды', () => {
  const draft = { name: 'Тест: аренда позже и разовый расход', ops: [ok_op('shift_flow', { ref: 'R-RENT@2026-10-25', days: 3 }), ok_op('add_flow', { when: 'once', kind: 'expense', amount_minor: 5000, date: '2026-10-10', tag: 'тест' })] };
  const s = SB.save_edit(draft);
  assert.equal(s.ok, true);
  assert.equal(s.edit.type, 'save_scenario');
  // хэш фактов: рабочая область и записи `tx.posted` журнала (номера записей `seq` при добавлении сценария сдвигаются, содержимое фактов — нет)
  const facts_hash = (ws) => sha({ facts: ws.facts, journal: ws_to_events(ws).filter((e) => e.type === 'tx.posted').map((e) => e.payload) });
  const h0 = facts_hash(G);
  const r = apply_edit(G, s.edit, { new_id: (p) => p + '_t1' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const ws1 = r.ws;
  assert.equal(ws1.scenarios.length, G.scenarios.length + 1);
  const saved = ws1.scenarios.find((x) => x.name === draft.name);
  assert.deepEqual(saved.ops, draft.ops);
  assert.equal(facts_hash(ws1), h0, 'сохранение не меняет хэш фактов');
  assert.equal(canon(ws1.facts), canon(G.facts));
  assert.deepEqual(analyze(ws1, { as_of: ws1.as_of }).series.plan.close, A0.series.plan.close, 'базовые ряды не меняются');
  // экспорт: запись журнала и файл-копия
  const ev = ws_to_events(ws1).filter((e) => e.type === 'scenario.set' && e.payload.scenario_id === saved.scenario_id);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.name, draft.name);
  const text = ws_to_journal(ws1);
  assert.ok(text.includes('Тест: аренда позже и разовый расход'));
  const back = journal_to_ws(text);
  assert.deepEqual(back.scenarios.find((x) => x.scenario_id === saved.scenario_id).ops, draft.ops, 'круг ws → файл → ws без потерь');
  // сохранённый сценарий считается движком по идентификатору так же, как по операциям
  const by_id = analyze(ws1, { as_of: ws1.as_of, scenario_id: saved.scenario_id });
  const by_ops = analyze(ws1, { as_of: ws1.as_of, scenario: { scenario_id: saved.scenario_id, ops: draft.ops } });
  assert.deepEqual(by_id.series.worse.trough, by_ops.series.worse.trough);
  // удаление
  const d = apply_edit(ws1, SB.delete_edit(saved.scenario_id));
  assert.equal(d.ok, true);
  assert.equal(facts_hash(d.ws), h0, 'удаление не меняет хэш фактов');
  assert.deepEqual(d.ws.scenarios, G.scenarios);
});

test('TST-33 REQ-049: отказы сохранения — пустое имя, нет операций, операция расширения; имя очищается от управляющих знаков; не больше 50 операций; дубль не добавляется', () => {
  const op = ok_op('shift_flow', { ref: 'R-RENT@2026-10-25', days: 3 });
  assert.deepEqual(SB.save_edit({ name: '  ', ops: [op] }), { ok: false, reason: 'empty_name' });
  assert.deepEqual(SB.save_edit({ name: 'x', ops: [] }), { ok: false, reason: 'no_ops' });
  assert.deepEqual(SB.save_edit({ name: 'x', ops: [{ op: 'hours', stream_id: 'S-HOURLY', minutes: 4800 }] }), { ok: false, reason: 'ext_op_not_saved' });
  assert.equal(SB.save_edit({ name: 'a\u0000b', ops: [op] }).edit.scenario.name, 'a b');
  let d = SB.new_draft();
  const r1 = SB.draft_add(d, op);
  assert.equal(r1.ok, true);
  d = r1.draft;
  assert.deepEqual(SB.draft_add(d, op), { ok: false, reason: 'duplicate_op', draft: d });
  assert.equal(SB.draft_remove(d, 0).ops.length, 0);
  let big = SB.new_draft();
  for (let i = 0; i < SB.MAX_OPS; i++) big = SB.draft_add(big, { op: 'shift_flow', event_ref: 'R-RENT@2026-10-25', days: i + 1 }).draft;
  assert.equal(SB.draft_add(big, { op: 'shift_flow', event_ref: 'x', days: 1 }).reason, 'too_many_ops');
  // слой записи принимает сценарий конструктора целиком (до 50 операций)
  assert.equal(apply_edit(G, SB.save_edit({ name: 'много', ops: big.ops }).edit, { new_id: (p) => p + '_t2' }).ok, true);
});

// ── REQ-050, REQ-051 ────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-050 «что изменится»: задержка поступления на 21 день — минимум по плану 71000 на 25 ноября вместо 205500, разность −134500; словами, а не цветом', () => {
  const op = ok_op('shift_income', { ref: 'S-HOURLY@2026-11-05', days: 21 });
  const p = SB.preview(G, A0, [op]);
  assert.equal(p.ok, true);
  const t = p.rows.find((r) => r.id === 'trough' && r.mode === 'plan');
  assert.deepEqual([t.base, t.scenario, t.delta], [205500, 71000, -134500]);
  assert.equal(E.format_date(t.date_scenario), '2026-11-25');
  const bad = SB.preview(G, A0, [{ op: 'shift_flow', event_ref: 'нет-такого', days: 1 }]);
  assert.deepEqual(bad, { ok: false, code: 'E_SCHEMA' });
});

test('TST-27 REQ-051: чип «курс ±N bp» — тот же результат, что scenario_fx_shock: 2000,00 $ при 0,9250 → 1850,00 €, при −500 bp → 1757,50 € (−92,50 €)', () => {
  const ws = usd_ws();
  const a = analyze(ws, { as_of: ws.as_of });
  const chips = SB.fx_chips(ws, a);
  assert.deepEqual([...new Set(chips.map((c) => c.currency))], ['USD']);
  assert.deepEqual(chips.map((c) => c.bp), [-1000, -500, 500, 1000]);
  assert.deepEqual(SB.foreign_currencies(G, A0), [], 'в G-001 только EUR: чипов курса нет');
  const flows = SB.list_flows(a);
  const usd_flow = flows.find((f) => f.ref === 'U-INC');
  assert.deepEqual([usd_flow.amount_minor, usd_flow.currency], [200000, 'USD'], 'для set_amount — исходная сумма и валюта');
  const env = { flows, as_of: a.as_of, horizon_end: a.horizon_end, currencies: SB.foreign_currencies(ws, a), streams: ws.streams };
  const op = ok_op('fx_shock', { currency: 'USD', bp: -500 }, env);
  assert.deepEqual(scenario_fx_shock({ ops: [op] }), { USD: -500 });
  const base = a.events.plan.find((e) => e.cash_event_id === 'U-INC');
  const shock = analyze_events(ws, [op]).find((e) => e.cash_event_id === 'U-INC');
  assert.deepEqual([base.amount_minor, shock.amount_minor], [185000, 175750]);
  assert.equal(shock.amount_minor - base.amount_minor, -9250);
  // то же через набор операций сценария и через предпросмотр конструктора
  const direct = build_events(ws, { as_of: ws.as_of, horizon_days: 57, mode: 'plan', scenario: { scenario_id: 'fx', ops: [op] } }).find((e) => e.cash_event_id === 'U-INC');
  assert.equal(direct.amount_minor, 175750);
  const p = SB.preview(ws, a, [op]);
  assert.equal(p.ok, true);
  assert.equal(p.base.trough.plan.amount_minor - p.scenario.trough.plan.amount_minor <= 9250, true);
  // сценарий с курсом сохраняется в набор и проходит слой записи
  const s = SB.save_edit({ name: 'Курс −5 %', ops: [op] });
  assert.equal(apply_edit(ws, s.edit, { new_id: (p_) => p_ + '_fx' }).ok, true);
});

function analyze_events(ws, ops) {
  return analyze(ws, { as_of: ws.as_of, scenario: { ops } }).events.plan;
}

test('REQ-051: операция hours работает только через scenario_ext — apply_scenario по умолчанию отвечает op_not_in_v1; через расширение: октябрь 2400,00 € вместо 2790,00 € (80 ч вместо 93 ч)', () => {
  const op = { op: 'hours', stream_id: 'S-HOURLY', minutes: 4800 };
  assert.equal(code_of(() => analyze(G, { as_of: G.as_of, scenario: { ops: [op] } })), 'E_SCHEMA:op_not_in_v1');
  assert.equal(code_of(() => apply_scenario(A0.events.plan, { ops: [op] }, { as_of: A0.as_of, horizon_end: A0.horizon_end })), 'E_SCHEMA:op_not_in_v1');
  const base = A0.events.plan.find((e) => e.cash_event_id === 'S-HOURLY@2026-11-05');
  assert.equal(base.amount_minor, 279000);
  const a = SX.analyze_ext(G, { as_of: G.as_of, scenario: { ops: [op] } });
  assert.equal(a.events.plan.find((e) => e.cash_event_id === 'S-HOURLY@2026-11-05').amount_minor, 240000);
  assert.deepEqual(SX.hours_to_ops(G, op, { as_of: G.as_of, horizon_end: A0.horizon_end }), [{ op: 'set_amount', event_ref: 'S-HOURLY@2026-11-05', amount_minor: 240000 }]);
  // без операций расширения analyze_ext равен analyze
  assert.deepEqual(SX.analyze_ext(G, { as_of: G.as_of }).series.plan.close, A0.series.plan.close);
  // «worse» часы не включает сам: без чипа те же суммы, что в plan
  assert.equal(A0.events.worse.find((e) => e.cash_event_id === 'S-HOURLY@2026-11-05').amount_minor, base.amount_minor);
  assert.equal(a.events.worse.find((e) => e.cash_event_id === 'S-HOURLY@2026-11-05').amount_minor, 240000, 'в сценарии с часами сумма меняется и в worse — это гипотеза пользователя');
  // from/to ограничивают периоды (по началу периода): октябрь платится 5 ноября, ноябрь — в декабре
  const wide = { as_of: G.as_of, horizon_end: '2026-12-31' };
  assert.deepEqual(SX.hours_to_ops(G, { ...op, from: '2026-10-01', to: '2026-10-31' }, wide).map((o) => o.event_ref), ['S-HOURLY@2026-11-05']);
  const nov = SX.hours_to_ops(G, { ...op, from: '2026-11-01', to: '2026-11-30' }, wide);
  assert.equal(nov.length, 1);
  assert.match(nov[0].event_ref, /^S-HOURLY@2026-12/);
  assert.equal(nov[0].amount_minor, 240000);
  assert.equal(SX.hours_to_ops(G, op, wide).length, 2, 'без ограничения — оба периода в горизонте');
  assert.equal(SX.has_ext_ops({ ops: [op] }), true);
  assert.equal(SX.has_ext_ops({ ops: [{ op: 'delay_income', event_ref: 'x', days: 1 }] }), false);
  // проверки операции
  assert.equal(code_of(() => SX.validate_hours_op({ op: 'hours', stream_id: 'S-HOURLY', minutes: 1.5 })), 'E_SCHEMA:bad_minutes');
  assert.equal(code_of(() => SX.hours_to_ops(G, { op: 'hours', stream_id: 'нет', minutes: 60 }, { as_of: G.as_of, horizon_end: A0.horizon_end })), 'E_SCHEMA:hours_unknown_stream');
  assert.equal(code_of(() => SX.validate_hours_op({ op: 'hours', stream_id: 'S-HOURLY', minutes: 60, from: '2026-12-01', to: '2026-11-01' })), 'E_BAD_DATE:to_before_from');
  // чипы часов — из диапазона потока
  const chips = SB.hours_chips(G);
  assert.deepEqual(chips.map((c) => [c.kind, c.minutes]), [['min', 4800], ['exp', 5580], ['max', 6600]]);
});

test('REQ-051: «часы по максимуму» и «как ожидается» через расширение; сценарий с hours не сохраняется в набор, предпросмотр его считает', () => {
  const max = { op: 'hours', stream_id: 'S-HOURLY', minutes: 6600 };
  const a = SX.analyze_ext(G, { as_of: G.as_of, scenario: { ops: [max] } });
  assert.equal(a.events.plan.find((e) => e.cash_event_id === 'S-HOURLY@2026-11-05').amount_minor, 330000);
  const exp = { op: 'hours', stream_id: 'S-HOURLY', minutes: 5580 };
  assert.deepEqual(SX.hours_to_ops(G, exp, { as_of: G.as_of, horizon_end: A0.horizon_end }), [], 'как ожидается — суммы не меняются, операций нет');
  const min = ok_op('hours', { stream_id: 'S-HOURLY', minutes: 4800 });
  const p = SB.preview(G, A0, [min]);
  assert.equal(p.ok, true);
  const t = p.rows.find((r) => r.id === 'trough' && r.mode === 'plan');
  assert.equal(t.delta, 0, 'минимум в октябре наступает раньше выплаты 5 ноября');
  const f = p.rows.find((r) => r.id === 'free' && r.mode === 'plan');
  assert.equal(typeof f.delta, 'number');
  assert.deepEqual(SB.save_edit({ name: 'часы', ops: [min] }), { ok: false, reason: 'ext_op_not_saved' });
  assert.equal(apply_edit(G, { type: 'save_scenario', scenario: { name: 'часы', ops: [min] } }, { new_id: (x) => x + '_h' }).ok, false, 'слой записи без расширения операцию hours не принимает');
});

test('REQ-051 хук scenario_ops: виды fx, shift, hours и ops → операции для apply_scenario (hours — через set_amount); чужой вид — undefined, неверное описание — null', () => {
  const hook = SB.scenario_ops_hook;
  assert.deepEqual(hook(null, { kind: 'fx', currency: 'USD', bp: -500 }, G), [{ op: 'fx_shock', currency: 'USD', bp: -500 }]);
  assert.deepEqual(hook(null, { kind: 'shift', event_ref: 'R-RENT@2026-10-25', days: 2 }, G), [{ op: 'shift_flow', event_ref: 'R-RENT@2026-10-25', days: 2 }]);
  const hrs = hook(null, { kind: 'hours', stream_id: 'S-HOURLY', minutes: 4800 }, G);
  assert.deepEqual(hrs, [{ op: 'set_amount', event_ref: 'S-HOURLY@2026-11-05', amount_minor: 240000 }]);
  assert.doesNotThrow(() => analyze(G, { as_of: G.as_of, scenario: { ops: hrs } }), 'развёрнутые операции проходят apply_scenario');
  assert.deepEqual(hook(null, { kind: 'ops', ops: [{ op: 'delay_income', event_ref: 'S-HOURLY@2026-11-05', days: 7 }] }, G).length, 1);
  assert.equal(hook(null, { kind: 'delay', days: 7 }, G), undefined);
  assert.equal(hook(null, { kind: 'saved', sid: 'x' }, G), undefined);
  assert.equal(hook(null, { kind: 'fx', currency: 'USD', bp: 1.5 }, G), null);
  assert.equal(hook(null, { kind: 'ops', ops: [] }, G), null);
  assert.equal(hook(null, { kind: 'ops', ops: [{ op: 'взрыв' }] }, G), null);
  assert.equal(hook(null, { kind: 'hours', stream_id: 'нет', minutes: 60 }, G), null);
  assert.deepEqual(SB.validate_op({ op: 'set_amount', event_ref: 'x', amount_minor: 0 }), { ok: false, field: 'amount_minor', reason: 'bad_amount' });
});

// ── DOM в настоящем приложении ──────────────────────────────────────────────────────────────────────────────────────

const ORIG = JSON.parse(JSON.stringify(ext.ctx.get_ws()));
const reset = () => { assert.equal(ext.ctx.set_ws(JSON.parse(JSON.stringify(ORIG)), { reason: 'test_reset' }).ok, true); };

test('boot: экран «Конструктор» (#scenario_lab) открывается; платёж, действие, число дней, быстрые чипы; поля подписаны (TST-58)', async () => {
  reset();
  await go('#scenario_lab');
  const main = text_of('main');
  assert.match(main, /^Конструктор сценариев/);
  assert.match(main, /Изменить ожидаемый платёж или поступление/);
  assert.match(main, /Часы по минимуму: «Выплата за часы», 80 ч/);
  assert.match(main, /В данных нет валют, кроме валюты расчёта: чипов курса нет\./);
  const opts = find_all(field('lab-flow'), (n) => n.tagName === 'option');
  assert.equal(opts.length, 16);
  assert.deepEqual(a11y_problems(byid.get('main')), []);
});

test('TST-33 REQ-049 REQ-050 экран «Конструктор»: сдвиг выбранного поступления на 21 день — операция в списке, «что изменится» числами и словами; «Сохранить в набор» пишет scenario.set, виден на экране «Сценарии»', async () => {
  reset();
  await go('#scenario_lab');
  const ctx = ext.ctx;
  field('lab-flow').value = 'S-HOURLY@2026-11-05';
  field('lab-action').value = 'shift_income';
  field('lab-action').listeners.change[0]();
  field('lab-number').value = '21';
  press('Добавить в сценарий', 0);
  let main = text_of('main');
  assert.match(main, /Операции сценария: 1/);
  assert.match(main, /Поступление «Выплата за часы» 5 ноя — позже на 21 день/);
  assert.match(main, /Минимум на счетах, по плану2\s055,00\s€710,00\s€хуже на 1\s345,00\s€ · минимум сдвинулся на 25 ноя/);
  assert.match(main, /Операция добавлена в сценарий\./);
  assert.deepEqual(a11y_problems(byid.get('main')), []);
  // дубль не добавляется
  press('Добавить в сценарий', 0);
  assert.match(text_of('main'), /Такая операция уже есть в сценарии\./);
  assert.match(text_of('main'), /Операции сценария: 1/);
  // отказ сохранения без имени
  press('Сохранить в набор');
  assert.match(text_of('main'), /Сценарию нужно название\./);
  // сохранение
  const n0 = ctx.journal.length;
  const facts0 = canon(ctx.get_ws().facts);
  field('lab-name').value = 'Задержка 21 день';
  press('Сохранить в набор');
  assert.equal(ctx.get_ws().scenarios.length, 3);
  assert.equal(ctx.get_ws().scenarios.at(-1).name, 'Задержка 21 день');
  assert.equal(ctx.journal.length, n0 + 1);
  assert.equal(ctx.journal.at(n0).type, 'scenario.set');
  assert.equal(canon(ctx.get_ws().facts), facts0, 'журнал фактов не затронут (REQ-014)');
  main = text_of('main');
  assert.match(main, /Сценарий сохранён в набор\./);
  assert.match(main, /Операции сценария: 0/, 'черновик очищен после сохранения');
  assert.match(main, /Задержка 21 день.*Удалить/);
  await go('#scenarios');
  assert.match(text_of('main'), /Задержка 21 день/, 'на экране «Сценарии» — как сохранённый');
  // удаление из набора
  await go('#scenario_lab');
  press('Удалить сценарий «Задержка 21 день» из набора');
  assert.equal(ctx.get_ws().scenarios.length, 2);
  assert.match(text_of('main'), /Сценарий удалён из набора\./);
  assert.equal(canon(ctx.get_ws().facts), facts0);
});

test('REQ-051 экран «Конструктор»: чип «часы по минимуму» считается через расширение, в набор такой сценарий не сохраняется (сообщение словами); операцию можно убрать', async () => {
  reset();
  await go('#scenario_lab');
  const ctx = ext.ctx;
  press('Часы по минимуму: «Выплата за часы», 80 ч');
  let main = text_of('main');
  assert.match(main, /Часы потока «Выплата за часы» в будущих периодах: 80 ч/);
  assert.match(main, /операция «часы»: её считает только расширение сценариев/);
  assert.doesNotMatch(main, /Сценарий не посчитан/);
  field('lab-name').value = 'часы';
  press('Сохранить в набор');
  assert.match(text_of('main'), /Сценарий с операцией «часы» в набор не сохраняется/);
  assert.equal(ctx.get_ws().scenarios.length, 2);
  press('Убрать из сценария: Часы потока «Выплата за часы» в будущих периодах: 80 ч');
  assert.match(text_of('main'), /Операции сценария: 0/);
  press('Очистить');
  assert.match(text_of('main'), /Черновик очищен\./);
  main = text_of('main');
  assert.match(main, /Операция не добавлена — здесь появится сравнение с базой\./);
});

test('TST-33 экран «Конструктор»: новая запись (разово и каждый месяц) и «всё по правилу»; отказ с причиной словами', async () => {
  reset();
  await go('#scenario_lab');
  field('lab-new-amount').value = 'сто';
  press('Добавить в сценарий', 1);
  assert.match(text_of('main'), /Не добавлено: сумма — нужна положительная сумма\./);
  field('lab-new-amount').value = '50';
  field('lab-new-date').value = '2026-10-10';
  field('lab-new-tag').value = 'подарок';
  press('Добавить в сценарий', 1);
  assert.match(text_of('main'), /Новый расход 50,00\s€ на 10 октября \(подарок\)/);
  field('lab-new-date').value = '2026-12-31';
  press('Добавить в сценарий', 1);
  assert.match(text_of('main'), /Не добавлено: дата — дата вне горизонта расчёта\./);
  field('lab-new-when').value = 'monthly';
  field('lab-new-date').value = '2026-10-15';
  field('lab-new-kind').value = 'income';
  press('Добавить в сценарий', 1);
  assert.match(text_of('main'), /Новое поступление 50,00\s€ каждый месяц, 15-го числа, с 15 октября/);
  assert.match(text_of('main'), /Операции сценария: 2/);
  // «все платежи правила»
  field('lab-flow').value = 'R-GROC@2026-10-10';
  field('lab-action').value = 'remove_flow';
  field('lab-action').listeners.change[0]();
  field('lab-scope').value = 'all';
  press('Добавить в сценарий', 0);
  assert.match(text_of('main'), /Убрать «Продукты» \(все платежи\)/);
  assert.match(text_of('main'), /Минимум на счетах, по плану/);
  assert.deepEqual(a11y_problems(byid.get('main')), []);
  press('Очистить');
});

test('REQ-051 экран «Конструктор» с валютой: чипы «курс ±N bp» по доллару, чип даёт тот же результат, что scenario_fx_shock; запись набора данных не нужна', async () => {
  reset();
  const ctx = ext.ctx;
  const r = ctx.set_ws(usd_ws(), { reason: 'test_usd' });
  assert.equal(r.ok, true, JSON.stringify(r));
  await go('#scenario_lab');
  let main = text_of('main');
  assert.match(main, /Курс USD ниже на 5\s% \(500 bp\)/);
  assert.match(main, /Курс USD выше на 10\s% \(1000 bp\)/);
  press('Курс USD ниже на 5\u00a0% (500 bp)');
  main = text_of('main');
  assert.match(main, /Курс USD ниже на 5\s%/);
  assert.match(main, /Минимум на счетах, по плану/);
  const a = ctx.get_model().ctx;
  const shock = analyze(ctx.get_ws(), { as_of: a.as_of, scenario: { ops: [{ op: 'fx_shock', currency: 'USD', bp: -500 }] } });
  assert.equal(shock.events.plan.find((e) => e.cash_event_id === 'U-INC').amount_minor, 175750);
  assert.deepEqual(a11y_problems(byid.get('main')), []);
  reset();
});

test('TST-58 конструктор: каждый блок подписан (aria-labelledby), таблица «что изменится» с подписью и словесным изменением («лучше», «хуже», «без изменений»), сообщения читает скринридер', async () => {
  reset();
  await go('#scenario_lab');
  press('Часы по минимуму: «Выплата за часы», 80 ч');
  const sections = find_all(byid.get('main'), (n) => n.tagName === 'section');
  assert.ok(sections.length >= 6);
  assert.ok(sections.every((s) => s.attrs['aria-labelledby'] !== undefined));
  assert.ok(find_all(byid.get('main'), (n) => n.attrs['aria-live'] === 'polite').length >= 2);
  const tbl = find_all(byid.get('main'), (n) => n.tagName === 'table' && n.children[0]?.textContent === 'Что изменится по сравнению с базой');
  assert.equal(tbl.length, 1, 'у таблицы предпросмотра есть подпись');
  assert.match(tbl[0].textContent, /без изменений|лучше на|хуже на/);
  assert.deepEqual(a11y_problems(byid.get('main')), []);
  press('Очистить');
});

test('TST-33 «база» в предпросмотре — данные без активного сценария страницы; подпись новой записи по умолчанию — «гипотеза»', async () => {
  reset();
  await go('#scenarios');
  press('Клиент платит на 14 дней позже');
  press('Открыть как вид');
  assert.match(text_of('main'), /Сценарий|сценарий/);
  assert.notEqual(ext.ctx.get_model().scenario, null, 'на странице включён сценарий');
  await go('#scenario_lab');
  field('lab-flow').value = 'S-HOURLY@2026-11-05';
  field('lab-action').value = 'shift_income';
  field('lab-action').listeners.change[0]();
  field('lab-number').value = '21';
  press('Добавить в сценарий', 0);
  assert.match(text_of('main'), /Минимум на счетах, по плану2\s055,00\s€710,00\s€/, 'база — 2055,00 €, а не минимум активного сценария');
  press('Очистить');
  field('lab-new-amount').value = '10';
  field('lab-new-date').value = '2026-10-12';
  field('lab-new-tag').value = '  ';
  press('Добавить в сценарий', 1);
  assert.match(text_of('main'), /Новый расход 10,00\s€ на 12 октября \(гипотеза\)/);
  press('Очистить');
  await go('#scenarios');
  reset(); // смена рабочей области выключает сценарий страницы
});

test('REQ-050 REQ-024 конструктор: «Можно потратить» в «что изменится» всегда с оговоркой про конец горизонта, если до него денег меньше (как UI-1 на экране «Сценарии»; design-brief §10, D-12)', async () => {
  // чистая модель: у сценария «поступление за часы позже на 21 день» до T свободно 210,00 €, до конца горизонта (30 ноября) — 0,00 €
  const p = SB.preview(G, A0, [ok_op('shift_income', { ref: 'S-HOURLY@2026-11-05', days: 21 })]);
  assert.equal(p.ok, true);
  const sts = p.rows.filter((r) => r.id === 'sts');
  assert.deepEqual(sts.map((r) => [r.mode, r.base, r.scenario, r.h_base, r.h_scenario]), [['plan', 43500, 21000, 43500, 0], ['worse', 21000, 21000, 21000, 0]]);
  assert.equal(p.scenario.horizon_end, A0.horizon_end);
  // экран: у базы оговорки нет (до конца горизонта столько же), у сценария она стоит рядом с числом
  reset();
  await go('#scenario_lab');
  field('lab-flow').value = 'S-HOURLY@2026-11-05';
  field('lab-action').value = 'shift_income';
  field('lab-action').listeners.change[0]();
  field('lab-number').value = '21';
  press('Добавить в сценарий', 0);
  const main = text_of('main');
  assert.match(main, /Можно потратить, по плану435,00\s€210,00\s€ · до конца горизонта \(30 ноября\): 0,00\s€/);
  assert.match(main, /Можно потратить, если хуже210,00\s€210,00\s€ · до конца горизонта \(30 ноября\): 0,00\s€без изменений/);
  assert.doesNotMatch(main, /435,00\s€ · до конца горизонта/, 'у базы оговорки нет: до конца горизонта денег столько же');
  assert.deepEqual(a11y_problems(byid.get('main')), []);
  reset();
});
