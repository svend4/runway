// reserve_screen.test.mjs — FP-15: экран «Резервы» (освободить остаток, срок годности налогового правила, «как посчитано» у чисел резервов).
// Часть 1 — чистые модели без DOM: `release_residual_edit`, `reserve_flags`, дата проверки правила, цепочка «поступление → правило → сумма» на четырёх наборах G-001.
// Часть 2 — настоящий app.mjs на заглушке DOM: пакет pack_fp15 подхвачен манифестом, плашка и карточки на «Резервы», запись общим путём, «Отменить», RU и EN.
// Расчёт по введённым данным и правилам, не консультация. Браузер, сервер и сеть не используются.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/reserve_screen.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { make_rng } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const DEMO = path.join(PROTO, 'demo');
const DATA = path.join(PROTO, 'data');
const clone = (x) => JSON.parse(JSON.stringify(x));
const load = (name) => JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8'));
const G = load('g001.json');

// ── заглушка DOM (минимальная: проверяется связка app.mjs ↔ ext.mjs ↔ пакет, а не вёрстка) ─────────────────────────────

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
  getElementById: (id) => byid.get(id) ?? find_in(byid.get('main'), id) ?? find_in(byid.get('nav'), id) ?? find_in(byid.get('summary'), id), // как в браузере: по id в любом месте дерева
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

const imp = (rel) => import(pathToFileURL(path.join(PROTO, rel)).href);
const { ext, SLOTS } = await imp('demo/ext.mjs');
const E = await imp('engine/index.mjs');
const { make_tool_ctx } = await imp('engine/tools.mjs');
const WE = await imp('demo/ws_edit.mjs');
const RELEASE = await imp('demo/reserve_release.mjs');
const EXPLAIN = await imp('demo/alloc_explain.mjs');
const RULE_AGE = await imp('demo/rule_age.mjs');
const PACK = await imp('demo/pack_fp15.mjs');
const FT = await imp('demo/form_tax.mjs');
const FK = await imp('demo/focus_keep.mjs');
const CATALOG = (await imp('demo/i18n/reserveui.mjs')).default;
const APP = await imp('demo/app.mjs'); // document.getElementById('app-title') !== null → boot() запускается сам
await new Promise((r) => setTimeout(r, 700)); // boot асинхронный: пакеты, набор данных, boot-хук

const NB = /[  ]/g;
const N = (x) => String(x).replace(NB, ' ');
const main = () => byid.get('main');
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const by_id = (id) => find_all(main(), (n) => n.attrs.id === id)[0];
const in_summary = (id) => find_all(byid.get('summary'), (n) => n.attrs.id === id)[0];
const nav_button = (prefix) => find_all(byid.get('nav'), (n) => n.tagName === 'button' && N(n.textContent).startsWith(prefix))[0];
const click = (n) => { assert.ok(n !== undefined, 'нет узла'); assert.equal(n.hasAttribute('disabled'), false, 'кнопка недоступна: ' + n.attrs.id); n.listeners.click[0](); };
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ctx = ext.ctx;
const reset = (ws) => { const r = ctx.set_ws(ws, { reason: 'test_reset' }); assert.equal(r.ok, true, JSON.stringify(r.error)); };
const text_main = () => N(main().textContent);
const text_dlg = () => N(byid.get('dlg-body').textContent);
const money = (minor, lang = 'ru') => APP.make_fmt(lang, 'EUR', '2026-10-04').money(minor);
const model_of = (ws) => ({ ws, ctx: make_tool_ctx(ws, { as_of: ws.as_of }, { locale: 'ru' }), cur: ws.decision_currency, as_of_iso: ws.as_of });
const day = (iso) => E.to_epoch_day(iso);
const iso_ago = (ws, n) => E.format_date(day(ws.as_of) - n);

/** Правило G-001 с отметкой проверки `age` дней назад и сроком `ttl`. */
function with_rule_age(age, ttl) {
  const ws = clone(G);
  ws.tax_rules[0].reviewed_at = iso_ago(ws, age);
  ws.tax_rules[0].ttl_days = ttl;
  return ws;
}

/** Страховка со сроком 15 сентября и привязанным платежом (RESIDUAL: остаток 50,00 €) — набор из analyze.test (C-059). */
function insurance_ws({ paid }) {
  const base = {
    ...clone(G),
    reserves: [{ reserve_id: 'RES-INS', kind: 'sinking', name: 'Страховка', currency: 'EUR', funded_start_minor: 5000, funded_as_of: '2026-08-01', target_minor: 60000,
      due_date: '2026-09-15', cadence: { freq: 'M', day: 1 }, mode: 'refill_to_target', backed_by_account_id: null }],
    tax_rules: [], streams: [],
  };
  if (paid) base.facts = [...base.facts, { event_id: 'f-ins', account_id: 'acc_main', date: '2026-09-10', amount_minor: -3000, currency: 'EUR', reserve_id: 'RES-INS', kind: 'expense' }];
  return base;
}

const apply = (ws, edit) => { const r = WE.apply_edit(ws, edit, { new_id: (p) => p + '_t1' }); assert.equal(r.ok, true, JSON.stringify(r.error)); return r.ws; };
const warn_codes = (ws) => E.analyze(ws, { as_of: ws.as_of }).warnings.map((w) => w.code);

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Часть 1. Чистые модели
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

test('REQ-062 release_residual_edit: правка record_allocation с отрицательной суммой source=manual на весь остаток; предупреждение исчезает, funded_open = 0; повтор безвреден', () => {
  const ws = insurance_ws({ paid: true });
  assert.ok(warn_codes(ws).includes('W_RESERVE_RESIDUAL'));
  const built = RELEASE.release_residual_edit(ws, 'RES-INS', ws.as_of);
  assert.equal(built.ok, true, JSON.stringify(built));
  assert.deepEqual(built.edit, { type: 'record_allocation', allocation: { allocation_id: 'man:RES-INS@2026-10-04', reserve_id: 'RES-INS', date: '2026-10-04', amount_minor: -5000, source: 'manual' } });
  assert.equal(built.amount_minor, 5000);
  const after = apply(ws, built.edit);
  assert.equal(E.reserve_open(after.reserves[0], after.allocations, day(after.as_of)), 0, 'funded_open = 0');
  assert.ok(!warn_codes(after).includes('W_RESERVE_RESIDUAL'), 'предупреждение исчезло');
  // повтор безвреден: та же правка ничего не меняет, а правка, построенная заново, отказывает «освобождать нечего»
  const twice = apply(after, built.edit);
  assert.equal(E.canon(twice.allocations), E.canon(after.allocations));
  assert.equal(E.analyze(twice, { as_of: twice.as_of }).inputs_hash, E.analyze(after, { as_of: after.as_of }).inputs_hash);
  const again = RELEASE.release_residual_edit(after, 'RES-INS', after.as_of);
  assert.deepEqual(again, { ok: false, error: { code: 'E_SCHEMA', ctx: { field: 'reserve_id', reason: 'nothing_to_release' } } });
  assert.equal(ws.allocations.length, 0, 'исходная область не тронута');
});

test('REQ-062 release_residual_edit: отказы без изменения данных — нет резерва, резерв привязан к счёту, дата не позже начала учёта, плохая дата; вторая запись того же дня не затирает первую', () => {
  const ws = insurance_ws({ paid: true });
  const code = (r) => [r.error.code, r.error.ctx.reason];
  assert.deepEqual(code(RELEASE.release_residual_edit(ws, 'RES-NONE', ws.as_of)), ['E_SCHEMA', 'unknown_reserve']);
  assert.deepEqual(code(RELEASE.release_residual_edit(ws, 'RES-INS', '2026-08-01')), ['E_SCHEMA', 'not_after_funded_as_of'], 'запись не позже funded_as_of движок бы проигнорировал');
  assert.deepEqual(code(RELEASE.release_residual_edit(ws, 'RES-INS', 'вчера')), ['E_BAD_DATE', 'bad_date']);
  const backed = clone(ws);
  backed.reserves[0].backed_by_account_id = 'acc_main';
  assert.deepEqual(code(RELEASE.release_residual_edit(backed, 'RES-INS', backed.as_of)), ['E_SCHEMA', 'backed_by_account']);
  // первое освобождение, затем новый взнос в тот же день и второе освобождение: записи различаются, сумма обеих — ноль
  const first = RELEASE.release_residual_edit(ws, 'RES-INS', ws.as_of);
  const w1 = apply(ws, first.edit);
  const w2 = apply(w1, { type: 'record_allocation', allocation: { allocation_id: 'sch:RES-INS@2026-10-04', reserve_id: 'RES-INS', date: '2026-10-04', amount_minor: 1500, source: 'schedule' } });
  const second = RELEASE.release_residual_edit(w2, 'RES-INS', w2.as_of);
  assert.equal(second.ok, true);
  assert.equal(second.edit.allocation.allocation_id, 'man:RES-INS@2026-10-04#2');
  assert.equal(second.amount_minor, 1500);
  const w3 = apply(w2, second.edit);
  assert.deepEqual(w3.allocations.map((a) => [a.allocation_id, a.amount_minor]), [['man:RES-INS@2026-10-04', -5000], ['sch:RES-INS@2026-10-04', 1500], ['man:RES-INS@2026-10-04#2', -1500]]);
  assert.equal(E.reserve_open(w3.reserves[0], w3.allocations, day(w3.as_of)), 0);
});

test('REQ-062 release_residual_edit: на 300 случайных резервах после правки funded_open = 0, ровно одна новая запись, повтор не меняет хэш входов', () => {
  const rng = make_rng(15062);
  for (let k = 0; k < 300; k++) {
    const funded = rng.int(1, 900000);
    const ws = insurance_ws({ paid: rng.bool() });
    ws.reserves[0].funded_start_minor = funded;
    ws.reserves[0].funded_as_of = rng.pick(['2026-08-01', '2026-09-01', '2026-10-01']);
    if (rng.bool()) ws.allocations = [{ allocation_id: 'sch:RES-INS@2026-10-02', reserve_id: 'RES-INS', date: '2026-10-02', amount_minor: rng.int(1, 5000), source: 'schedule' }];
    const open = E.reserve_open(ws.reserves[0], ws.allocations, day(ws.as_of));
    const built = RELEASE.release_residual_edit(ws, 'RES-INS', ws.as_of);
    assert.equal(built.ok, true, 'случай ' + k);
    assert.equal(built.amount_minor, open);
    const after = apply(ws, built.edit);
    assert.equal(after.allocations.length, ws.allocations.length + 1);
    assert.equal(E.reserve_open(after.reserves[0], after.allocations, day(after.as_of)), 0);
    assert.equal(E.canon(apply(after, built.edit).allocations), E.canon(after.allocations));
    assert.ok(!warn_codes(after).includes('W_RESERVE_RESIDUAL'));
  }
});

test('REQ-062 reserve_flags: RESIDUAL — платёж был (сумма остатка, срок, платежи); OVERDUE — срока нет платежа; срок не прошёл или остатка нет — резерв не под предупреждением', () => {
  const resid = RELEASE.reserve_flags(model_of(insurance_ws({ paid: true })));
  assert.deepEqual(resid, [{ reserve_id: 'RES-INS', code: 'W_RESERVE_RESIDUAL', funded_minor: 5000, due_date: '2026-09-15', payments: [{ date: '2026-09-10', amount_minor: -3000 }], can_release: true }]);
  const over = RELEASE.reserve_flags(model_of(insurance_ws({ paid: false })));
  assert.deepEqual(over.map((f) => [f.code, f.funded_minor, f.payments.length, f.can_release]), [['W_RESERVE_OVERDUE', 5000, 0, true]]);
  const future = insurance_ws({ paid: true });
  future.reserves[0].due_date = '2027-03-15';
  assert.deepEqual(RELEASE.reserve_flags(model_of(future)), []);
  assert.deepEqual(RELEASE.reserve_flags(model_of(clone(G))), [], 'на G-001 предупреждений нет');
});

test('REQ-067 rule_age: дата проверки действующей версии; самая давняя среди правил в статусе; правило без отметки и будущая версия — null; вложенная форма списка', () => {
  const ws = clone(G);
  const rule = ws.tax_rules[0];
  rule.reviewed_at = '2026-01-01';
  rule.ttl_days = 60;
  assert.equal(RULE_AGE.review_date(ws, 'TR-20', ws.as_of), '2026-01-01');
  assert.equal(RULE_AGE.review_date(ws, 'TR-NONE', ws.as_of), null);
  assert.equal(RULE_AGE.review_date(clone(G), 'TR-20', ws.as_of), null, 'проверка не отмечена');
  // две версии: на as_of действует новая (reviewed_at позже), прошлая — по дате в прошлом
  const v2 = { ...clone(rule), version: 2, valid_from: '2026-09-01', reviewed_at: '2026-09-02', recorded_at: '2026-09-02T10:00:00Z' };
  ws.tax_rules = [rule, v2];
  assert.equal(RULE_AGE.review_date(ws, 'TR-20', '2026-10-04'), '2026-09-02');
  assert.equal(RULE_AGE.review_date(ws, 'TR-20', '2026-08-31'), '2026-01-01');
  ws.tax_rules = [[rule, v2]]; // старая вложенная форма
  assert.equal(RULE_AGE.rule_versions(ws).length, 2);
  // EpochDay вместо строки
  ws.tax_rules = [{ ...rule, reviewed_at: day('2026-02-03') }];
  assert.equal(RULE_AGE.review_date(ws, 'TR-20', ws.as_of), '2026-02-03');
  // самая давняя дата среди правил в заданном статусе
  const two = clone(G);
  two.tax_rules = [{ ...clone(rule), reviewed_at: '2026-03-01' }, { ...clone(rule), tax_rule_id: 'TR-B', reviewed_at: '2026-02-01', reserve_id: 'RES-TAX' }];
  const status = { 'TR-20': 'disabled', 'TR-B': 'disabled' };
  assert.equal(RULE_AGE.oldest_review_date(two, '2026-10-04', status, 'disabled'), '2026-02-01');
  assert.equal(RULE_AGE.oldest_review_date(two, '2026-10-04', { 'TR-20': 'stale', 'TR-B': 'disabled' }, 'stale'), '2026-03-01');
  assert.equal(RULE_AGE.oldest_review_date(two, '2026-10-04', { 'TR-20': 'fresh' }, 'disabled'), null);
  assert.equal(RULE_AGE.oldest_review_date(two, '2026-10-04', undefined), null);
});

test('REQ-108 reserve_chain: G-001, режим plan — цепочка «поступление → правило → сумма»: 2 790,00 € × 20 % = 558,00 €, mul_div(279000, 2000, 10000, half_even) = 55800; платёж P-TAX1 высвобождает 500,00 €; сумма строк равна числу к концу горизонта', () => {
  const model = model_of(clone(G));
  const c = EXPLAIN.reserve_chain(model, 'RES-TAX', 'plan');
  assert.equal(c.ok, true);
  assert.equal(c.hidden, false);
  assert.equal(c.start_minor, 150000);
  assert.deepEqual(c.rows.map((r) => [r.kind, E.format_date(r.date), r.amount_minor]), [['release', '2026-10-23', -50000], ['allocation', '2026-11-05', 55800]]);
  assert.equal(c.rows[0].true_up_minor, 0);
  assert.equal(c.rows[0].payments[0].amount_minor, 50000);
  assert.equal(c.end_minor, 155800);
  assert.equal(c.total_minor, 155800);
  assert.equal(c.matches, true);
  const d = c.details[0];
  assert.deepEqual([d.gross_minor, d.rate_bp, d.rounding, d.result_minor, d.version, d.rule_id, d.matches], [279000, 2000, 'half_even', 55800, 1, 'TR-20', true]);
  // независимый оракул: 279000 × 2000 / 10000 без движка
  assert.equal(Number((BigInt(d.gross_minor) * BigInt(d.rate_bp)) / 10000n), 55800);
  assert.equal(d.marked, false, 'проверка не отмечена');
  assert.equal(d.age_days, null);
  assert.deepEqual(c.recorded, []);
  assert.equal(c.funded_start_minor, 150000);
});

test('REQ-108 reserve_chain: возраст правила у отложенной суммы — проверено, срок, прошло дней, статус; числа в карточке: сейчас и к концу горизонта', () => {
  const ws = with_rule_age(33, 60);
  const c = EXPLAIN.reserve_chain(model_of(ws), 'RES-TAX', 'plan');
  const d = c.details[0];
  assert.deepEqual([d.marked, d.reviewed_at, d.ttl_days, d.age_days, d.status], [true, iso_ago(ws, 33), 60, 33, 'fresh']);
  const stale = EXPLAIN.reserve_chain(model_of(with_rule_age(86, 60)), 'RES-TAX', 'plan').details[0];
  assert.deepEqual([stale.age_days, stale.status], [86, 'stale']);
  assert.deepEqual(EXPLAIN.reserve_numbers(model_of(clone(G)), 'RES-TAX', 'plan'), { ok: true, reserve: G.reserves[0], hidden: false, since: null, now_minor: 150000, end_minor: 155800 });
  assert.deepEqual(EXPLAIN.reserve_numbers(model_of(clone(G)), 'RES-NONE', 'plan'), { ok: false, reason: 'unknown_reserve' });
});

test('REQ-067 REQ-108 границы срока годности: возраст 2·ttl — «давно не подтверждалось» (числа есть), 2·ttl + 1 — «не подтверждено» (чисел нет, остаётся правило и дата)', () => {
  const edge = model_of(with_rule_age(120, 60));
  assert.equal(edge.ctx.rule_status['TR-20'], 'stale');
  assert.equal(EXPLAIN.reserve_numbers(edge, 'RES-TAX', 'plan').hidden, false);
  const over = model_of(with_rule_age(121, 60));
  assert.equal(over.ctx.rule_status['TR-20'], 'disabled');
  const n = EXPLAIN.reserve_numbers(over, 'RES-TAX', 'plan');
  assert.deepEqual([n.hidden, n.now_minor, n.end_minor, n.since], [true, null, null, iso_ago(over.ws, 121)]);
  const c = EXPLAIN.reserve_chain(over, 'RES-TAX', 'plan');
  assert.deepEqual([c.hidden, c.since, c.rules], [true, iso_ago(over.ws, 121), [{ rule_id: 'TR-20', status: 'disabled' }]]);
  assert.equal(JSON.stringify(c).includes('55800'), false, 'сумм под отключённым правилом в цепочке нет');
  // накопления не зависят от налогового правила: числа остаются
  const sink = EXPLAIN.reserve_numbers(over, 'RES-INS', 'plan');
  assert.equal(sink.hidden, false);
  assert.equal(sink.end_minor, 12000);
});

test('REQ-108 reserve_chain: на всех наборах G-001 в обоих режимах и для каждого резерва сумма строк равна числу «к концу горизонта», отложенные суммы совпадают с формулой движка', () => {
  let checked = 0;
  for (const name of ['g001.json', 'g001-low.json', 'g001-gap.json', 'g001-late.json']) {
    const model = model_of(load(name));
    for (const mode of ['plan', 'worse']) {
      for (const r of model.ws.reserves ?? []) {
        const c = EXPLAIN.reserve_chain(model, r.reserve_id, mode);
        if (!c.ok) continue;
        assert.equal(c.matches, true, `${name} ${mode} ${r.reserve_id}`);
        const rs = model.ctx.reserve[mode].by_reserve[r.reserve_id];
        assert.equal(c.end_minor, rs.close[rs.close.length - 1]);
        const alloc_rows = c.rows.filter((x) => x.kind === 'allocation').reduce((s, x) => s + x.amount_minor, 0);
        assert.equal(alloc_rows, rs.allocated.reduce((s, v) => s + v, 0), `${name} ${mode}: отложено`);
        for (const d of c.details) assert.equal(d.matches, true);
        checked += 1;
      }
    }
  }
  assert.ok(checked >= 8, 'проверено резервов: ' + checked);
});

test('REQ-068 в новых модулях пакета нет зашитых ставок, сроков и названий налогов: числа берутся из правил пользователя', () => {
  for (const f of ['reserve_release.mjs', 'alloc_explain.mjs', 'reserve_rules.mjs', 'rule_age.mjs', 'pack_fp15.mjs', 'i18n/reserveui.mjs']) {
    const src = fs.readFileSync(path.join(DEMO, f), 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
    assert.ok(!/rate_bp\s*[:=]\s*\d/.test(src), `${f}: литерал ставки`);
    assert.ok(!/ttl_days\s*[:=]\s*\d/.test(src), `${f}: литерал срока годности`);
    assert.ok(!/\bНДС\b|\bVAT\b|\bUSt\b|\bусн\b|\bндфл\b|\bIRPF\b|\bIVA\b/i.test(src), `${f}: название налога`);
    assert.ok(!/\binnerHTML\b|\bouterHTML\b|\beval\(|new Function|\bfetch\(/.test(src), `${f}: небезопасный вызов`);
  }
});

test('TST-56 каталог reserveui: паритет RU/EN, одинаковые плейсхолдеры, ключи только reserveui.*, в RU-строках есть русские буквы; имя пространства допустимо для register_strings', () => {
  assert.deepEqual(Object.keys(CATALOG.ru).sort(), Object.keys(CATALOG.en).sort());
  const ph = (s) => [...s.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]).sort();
  for (const k of Object.keys(CATALOG.ru)) {
    assert.ok(k.startsWith('reserveui.'), k);
    assert.deepEqual(ph(CATALOG.ru[k]), ph(CATALOG.en[k]), k);
    const letters = CATALOG.ru[k].replace(/\{[A-Za-z0-9_]+\}/g, '').replace(/[^A-Za-zА-Яа-яЁё]/g, ''); // как в demo.test: строка без букв (только подстановки) допустима
    if (letters !== '') assert.match(CATALOG.ru[k], /[а-яё]/i, 'RU без русских букв: ' + k);
  }
  assert.match('reserveui', /^[a-z][a-z0-9]{1,15}$/);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Часть 2. Настоящий app.mjs на заглушке DOM
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

test('boot: пакет FP-15 подхвачен манифестом без сбоев; новых видов правок нет; слот banner.warning есть в замороженном списке; app.mjs пакет по имени не знает', () => {
  assert.ok(ext.diagnostics().some((d) => d.pack === 'pack_fp15' && d.status === 'ok'), JSON.stringify(ext.diagnostics().filter((d) => d.pack === 'pack_fp15')));
  assert.deepEqual(ext.diagnostics().filter((d) => d.status === 'failed'), [], 'ни один пакет не упал');
  assert.ok(SLOTS.includes('banner.warning') && Object.isFrozen(SLOTS));
  assert.equal(typeof PACK.register, 'function');
  assert.ok(!/pack_fp15|reserve_release|alloc_explain|reserve_rules|reserveui/.test(fs.readFileSync(path.join(DEMO, 'app.mjs'), 'utf8')), 'app.mjs не знает пакет поимённо');
  assert.ok(WE.list_edit_types().includes('record_allocation'));
  assert.equal(ext.slot_nodes('banner.warning', ctx, Object.freeze({ warning: { code: 'W_BUFFER_UNSET' } })).length, 0, 'для чужих предупреждений блок молчит');
});

test('REQ-108 «Резервы» на G-001: карточка каждого резерва с числами «сейчас» и «к концу горизонта»; срок годности правила — «проверка не отмечена», кнопки подтверждения нет; ставок по умолчанию нет', async () => {
  reset(clone(G));
  await go('#reserves');
  const cards = by_id('fp15-reserves');
  assert.ok(cards !== undefined);
  assert.equal(N(by_id('fp15-reserves-title').textContent), 'Резервы: остаток и расчёт');
  assert.equal(N(by_id('fp15-r0-title').textContent), 'Налоговый конверт');
  assert.ok(N(cards.textContent).includes(`Сейчас в резерве ${N(money(150000))}; к концу горизонта ${N(money(155800))}.`), N(cards.textContent).slice(0, 400));
  assert.ok(N(by_id('fp15-r1-title').textContent).startsWith('Годовая страховка'));
  const rules = N(by_id('fp15-rules').textContent);
  assert.ok(rules.includes('Срок годности налоговых правил'));
  assert.ok(rules.includes('Проверка не отмечена: срок годности правила не задан.'));
  assert.equal(by_id('fp15-rule-0-confirm'), undefined, 'у правила без срока подтверждать нечего');
  assert.ok(rules.includes('Ставок по умолчанию нет'));
  assert.ok(rules.toLowerCase().includes('не консультация'));
  assert.equal(find_all(by_id('fp15-reserves'), (n) => n.attrs['data-act'] === 'release').length, 0, 'без предупреждений кнопки «Освободить остаток» нет');
  assert.equal(find_all(byid.get('summary'), (n) => n.tagName === 'button').length, 0);
});

test('REQ-108 «как посчитано»: диалог по конверту — строки цепочки, формула mul_div(279000, 2000, 10000, half_even) = 55800, округление, версия, возраст правила, сходимость; для накоплений — взнос по графику', async () => {
  reset(clone(G));
  await go('#reserves');
  ctx.set_ws(clone(G), { reason: 'test_reset' });
  const mode = ctx.mode();
  const expected = EXPLAIN.reserve_chain(ctx.get_model(), 'RES-TAX', mode);
  click(by_id('fp15-r0-how'));
  assert.equal(N(byid.get('dlg-title').textContent), 'Как посчитано: Налоговый конверт');
  const t = text_dlg();
  assert.equal(byid.get('dlg').open, true);
  assert.ok(t.includes('Сколько будет в конверте к 30 ноября'));
  assert.ok(t.includes(`Сейчас в резерве${N(money(150000))}`));
  assert.ok(t.includes(`из резерва высвобождается ${N(money(50000))}`));
  assert.ok(t.includes(`${N(money(279000))} × 20 %`) && t.includes('правило «20 % от поступлений», версия 1'));
  assert.ok(t.includes('Формула: mul_div(279000, 2000, 10000, half_even) = 55800'), t);
  assert.ok(t.includes(`→ ${N(money(55800))}.`));
  assert.ok(t.includes('округление: до чётного (банковское)'));
  assert.ok(t.includes('Возраст правила: проверка не отмечена.'));
  assert.ok(t.includes(`равна числу «к концу горизонта» ${N(money(expected.end_minor))}: сходится.`));
  assert.ok(t.toLowerCase().includes('не консультация'));
  assert.ok(find_all(byid.get('dlg-body'), (n) => n.tagName === 'table').every((tb) => tb.children.some((c) => c.tagName === 'caption' && c.textContent.trim() !== '')), 'у таблицы есть подпись');
  assert.ok(find_all(byid.get('dlg-body'), (n) => n.attrs.id === 'fp15-alloc-0').length === 1, 'панель вывода отложенной суммы');
  click(by_id('fp15-r1-how'));
  assert.equal(N(byid.get('dlg-title').textContent), 'Как посчитано: Годовая страховка');
  assert.ok(text_dlg().includes('Взнос по графику'));
  assert.ok(!text_dlg().includes('Расчёт отложенных сумм'), 'у накоплений налоговых панелей нет');
  assert.ok(!text_dlg().toLowerCase().includes('не консультация'), 'оговорка про налоги — только у налогового конверта');
});

test('REQ-067 REQ-108 «Резервы» при disabled: строка 558,00 и остатки конверта не встречаются нигде в тексте страницы; в плашке и в gate.rule_disabled названа дата reviewed_at; кнопка «Подтвердить правило» в плашке', async () => {
  const hidden = [money(55800), money(150000), money(155800), money(167800), money(250000)]; // отложено, в конверте сейчас, к концу горизонта, резервы на конец, свободно на сегодня
  reset(clone(G));
  await go('#reserves');
  for (const h of hidden) assert.ok(text_main().includes(N(h)), `пока правило без отметки срока, число на странице есть: ${N(h)}`); // иначе проверка «нигде нет» ничего бы не доказывала
  const ws = with_rule_age(276, 60); // 2026-01-01: старше двух сроков годности
  assert.equal(ws.tax_rules[0].reviewed_at, '2026-01-01');
  reset(ws);
  await go('#reserves');
  const t = text_main();
  for (const h of hidden) assert.ok(!t.includes(N(h)), `число под отключённым правилом на странице: ${N(h)}`);
  assert.ok(!t.includes('558,00') && !t.includes('558.00'));
  assert.ok(!N(byid.get('summary').textContent).includes('558,00'));
  // видимые числа, не зависящие от правила: остаток на счёте и платёж по обязательству
  assert.ok(t.includes(`Остаток ${N(money(400000))}.`));
  // даты проверки названы: в плашке, в тексте гейта «можно потратить», в шапке, в карточках
  assert.ok(t.includes('Правило не подтверждено с 2026-01-01: числа скрыты до подтверждения или правки правила.'), 'текст gate.rule_disabled с датой');
  assert.ok(t.includes('Числа конверта скрыты: правило не подтверждено с 2026-01-01'));
  assert.ok(t.includes('Правило не подтверждено с 2026-01-01: зависящие числа не показываются, пока правило не подтверждено или не изменено.'));
  assert.ok(N(byid.get('summary').textContent).includes('Правило не подтверждено с 2026-01-01: зависящие числа не показываются, пока правило не подтверждено или не изменено.'));
  const banner = find_all(by_id('fp15-rules'), (n) => n.attrs['data-status'] === 'disabled')[0];
  assert.ok(banner !== undefined, 'плашка в карточке срока годности');
  assert.ok(N(banner.textContent).includes('не подтверждено с 2026-01-01 (прошло 276 дн. при сроке 60 дн.)'));
  const btn = find_all(banner, (n) => n.tagName === 'button')[0];
  assert.equal(N(btn.textContent), 'Подтвердить правило');
  assert.equal(btn.attrs['aria-label'], 'Подтвердить правило «20 % от поступлений»');
  assert.ok(N(by_id('fp15-r0-title').textContent) === 'Налоговый конверт' && N(by_id('fp15-reserves').textContent).includes('Числа скрыты: правило не подтверждено с 2026-01-01'));
  // «как посчитано» под отключённым правилом: текст вместо чисел
  click(by_id('fp15-r0-how'));
  assert.ok(text_dlg().includes('Числа скрыты: правило не подтверждено с 2026-01-01; они вернутся после подтверждения или правки правила.'));
  assert.ok(!/55800|558,00|1 500,00|1 558,00/.test(text_dlg()), text_dlg());
  assert.equal(find_all(byid.get('dlg-body'), (n) => n.tagName === 'table').length, 0);
  // накопления под тем же правилом не прячутся
  assert.ok(t.includes('Годовая страховка:'));
});

test('REQ-067 «Подтвердить правило» в плашке: новая версия с reviewed_at = сегодня и прежним сроком, числа возвращаются, «Отменить» снова прячет их; фокус возвращается', async () => {
  reset(with_rule_age(276, 60));
  await go('#reserves');
  click(by_id('fp15-rule-0-confirm'));
  const versions = ctx.get_ws().tax_rules.flat();
  assert.deepEqual(versions.map((r) => [r.version, r.reviewed_at, r.ttl_days]), [[1, '2026-01-01', 60], [2, '2026-10-04', 60]]);
  const t = text_main();
  assert.ok(t.includes(N(money(155800))), 'после подтверждения числа вернулись');
  assert.ok(!t.includes('после подтверждения или правки'));
  assert.equal(find_all(by_id('fp15-rules'), (n) => n.attrs['data-status'] !== undefined).length, 0, 'плашки нет');
  assert.ok(N(by_id('fp15-rules').textContent).includes('Проверено 2026-10-04; срок годности 60 дн., прошло 0 дн.'));
  await wait(200);
  const focused = find_all(main(), (n) => n.focused === true).map((n) => n.attrs.id);
  assert.ok(focused.some((id) => /^fp15-rule|^fp15-rules-title|^view-title/.test(id ?? '')), 'фокус возвращён на карточку или заголовок: ' + focused.join(','));
  click(nav_button('Отменить'));
  assert.deepEqual(ctx.get_ws().tax_rules.flat().map((r) => r.version), [1]);
  assert.ok(!text_main().includes(N(money(155800))), 'числа снова скрыты');
});

test('REQ-067 «давно не подтверждалось» (возраст в пределах двух сроков): числа показаны, плашка называет дату и срок, кнопка «Подтвердить правило» есть; в шапке тоже дата', async () => {
  reset(with_rule_age(86, 60));
  await go('#reserves');
  const t = text_main();
  assert.ok(t.includes(N(money(155800))), 'числа показаны');
  const banner = find_all(by_id('fp15-rules'), (n) => n.attrs['data-status'] === 'stale')[0];
  assert.ok(banner !== undefined);
  assert.ok(N(banner.textContent).includes(`не подтверждено с ${iso_ago(ctx.get_ws(), 86)} (прошло 86 дн. при сроке 60 дн.)`));
  assert.equal(find_all(banner, (n) => n.tagName === 'button').length, 1);
  assert.ok(N(byid.get('summary').textContent).includes(`Правило не подтверждено с ${iso_ago(ctx.get_ws(), 86)}: проверьте его.`));
});

test('REQ-062 RESIDUAL: плашка в шапке и карточка резерва называют сумму остатка; «Освободить остаток» в плашке пишет одну запись source=manual, предупреждение исчезает, «Отменить» откатывает одну запись', async () => {
  reset(insurance_ws({ paid: true }));
  await go('#reserves');
  const hdr = N(byid.get('summary').textContent);
  assert.ok(hdr.includes(`В резерве «Годовая страховка» записано ${N(money(5000))}, срок наступил, платёж был: остаток освобождается вручную.`), hdr);
  const hb = in_summary('fp15-hdr-release-0');
  assert.ok(hb !== undefined, 'кнопка в плашке W_RESERVE_RESIDUAL');
  assert.equal(N(hb.textContent), 'Освободить остаток');
  assert.equal(hb.attrs['aria-label'], `Освободить остаток ${money(5000)} резерва «Годовая страховка»`);
  assert.ok(hb.attrs['aria-label'].startsWith(N(hb.textContent)), 'видимый текст — начало доступного имени');
  const card = N(by_id('fp15-reserves').textContent);
  assert.ok(card.includes(`Срок 15 сентября наступил, платёж по резерву был, а в резерве записано ${N(money(5000))}.`), card);
  assert.ok(card.includes('Автоматически остаток не освобождается'));
  assert.ok(card.includes(`Будет записано: −${N(money(5000))}, источник «вручную».`));
  const cb = by_id('fp15-r0-release');
  assert.equal(N(cb.textContent), 'Освободить остаток');
  assert.equal(find_all(by_id('fp15-reserves'), (n) => n.attrs['data-act'] === 'release').length, 1, 'в карточке ровно одна кнопка на резерв');
  const n0 = ctx.journal.length;
  const before = clone(ctx.get_ws());
  click(hb);
  const ws = ctx.get_ws();
  assert.deepEqual(ws.allocations, [{ allocation_id: 'man:RES-INS@2026-10-04', reserve_id: 'RES-INS', date: '2026-10-04', amount_minor: -5000, source: 'manual' }]);
  assert.equal(E.reserve_open(ws.reserves[0], ws.allocations, day(ws.as_of)), 0, 'funded_open = 0');
  assert.ok(!ctx.get_model().ctx.warnings.some((w) => w.code === 'W_RESERVE_RESIDUAL'), 'предупреждение исчезло');
  assert.ok(!N(byid.get('summary').textContent).includes('осталось'));
  assert.equal(in_summary('fp15-hdr-release-0'), undefined);
  assert.equal(by_id('fp15-r0-release'), undefined);
  assert.deepEqual(ctx.journal.events().slice(n0).map((e) => e.type), ['allocation.recorded'], 'в журнал ушла одна запись');
  // «Отменить» откатывает ровно эту запись; подпись — «уменьшение резерва на …»
  const undo = nav_button('Отменить');
  assert.ok(N(undo.attrs['aria-label'] ?? undo.textContent).includes(`уменьшение резерва на ${N(money(5000))}`));
  click(undo);
  assert.deepEqual(ctx.get_ws().allocations, before.allocations);
  assert.equal(E.canon(ctx.get_ws()), E.canon(before), 'рабочая область побайтно прежняя');
  assert.ok(ctx.get_model().ctx.warnings.some((w) => w.code === 'W_RESERVE_RESIDUAL'), 'предупреждение вернулось');
  assert.ok(in_summary('fp15-hdr-release-0') !== undefined);
});

test('REQ-062 «Освободить остаток» в карточке резерва и повтор: вторая попытка при пустом резерве — «освобождать нечего», данные не меняются; фокус возвращается на заголовок', async () => {
  reset(insurance_ws({ paid: true }));
  await go('#reserves');
  click(by_id('fp15-r0-release'));
  assert.equal(ctx.get_ws().allocations.length, 1);
  assert.equal(by_id('fp15-r0-release'), undefined, 'кнопка ушла вместе с предупреждением');
  const seen = [];
  const off = ctx.subscribe((e) => seen.push(e.reason));
  const again = RELEASE.do_release(ctx, 'RES-INS', ['view-title']);
  off();
  assert.deepEqual(again, { ok: false });
  assert.deepEqual(seen, [], 'запись не пошла');
  assert.equal(ctx.get_ws().allocations.length, 1);
  assert.ok(ext.diagnostics().filter((d) => d.status === 'notify').some((d) => d.message === 'Освобождать нечего: в резерве «Годовая страховка» нет остатка.'));
  await wait(200);
  const focused = find_all(main(), (n) => n.focused === true).map((n) => n.attrs.id);
  assert.ok(focused.includes('fp15-r0-title') || focused.includes('view-title'), 'фокус на заголовке: ' + focused.join(','));
  click(nav_button('Отменить'));
  assert.equal(ctx.get_ws().allocations.length, 0);
});

test('REQ-062 кнопка в плашке работает на любом экране: с «Обзора» остаток освобождается, фокус не теряется на body', async () => {
  reset(insurance_ws({ paid: true }));
  await go('#overview');
  const hb = in_summary('fp15-hdr-release-0');
  assert.ok(hb !== undefined);
  click(hb);
  assert.equal(ctx.get_ws().allocations.length, 1);
  assert.equal(in_summary('fp15-hdr-release-0'), undefined);
  await wait(200);
  assert.ok(find_all(main(), (n) => n.focused === true).some((n) => n.attrs.id === 'view-title'), 'фокус вернулся на заголовок экрана');
  click(nav_button('Отменить'));
});

test('REQ-062 OVERDUE: срок прошёл, платежа нет — текст называет сумму; кнопка «Освободить остаток» есть в карточке, в шапке её нет (платёж не найден — решение осознанное); освобождение работает', async () => {
  reset(insurance_ws({ paid: false }));
  await go('#reserves');
  const hdr = N(byid.get('summary').textContent);
  assert.ok(hdr.includes(`Срок резерва «Годовая страховка» наступил, платёж не найден; в резерве записано ${N(money(5000))}.`), hdr);
  assert.equal(in_summary('fp15-hdr-release-0'), undefined, 'в шапке кнопки для OVERDUE нет');
  const card = N(by_id('fp15-reserves').textContent);
  assert.ok(card.includes(`Срок 15 сентября наступил, а платёж, привязанный к резерву, не найден; в резерве записано ${N(money(5000))}.`), card);
  assert.ok(card.includes('можно освободить вручную'));
  click(by_id('fp15-r0-release'));
  assert.equal(E.reserve_open(ctx.get_ws().reserves[0], ctx.get_ws().allocations, day(ctx.get_ws().as_of)), 0);
  assert.ok(!ctx.get_model().ctx.warnings.some((w) => w.code === 'W_RESERVE_OVERDUE'));
  click(nav_button('Отменить'));
});

test('REQ-067 «Резервы» чужие карточки под отключённым правилом: «Запас и счета» и «проведено, но в конверт не записано» не печатают сумм конверта', async () => {
  const ws = with_rule_age(276, 60);
  ws.reserves[0].funded_as_of = '2026-09-01';
  ws.facts = [...ws.facts, { event_id: 'f-inc', account_id: 'acc_main', date: '2026-10-03', amount_minor: 279000, currency: 'EUR', kind: 'income', stream_id: 'S-HOURLY' }];
  reset(ws);
  await go('#reserves');
  const pend = by_id('fp08-pending');
  assert.ok(pend !== undefined, 'карточка есть: доход проведён, записи в конверте нет');
  const t = N(pend.textContent);
  assert.ok(t.includes('Доход от 3 октября: сумма скрыта, правило не подтверждено с 2026-01-01.'), t);
  assert.ok(t.includes('Записать в конверт (суммы скрыты)'));
  assert.ok(!t.includes('558,00'));
  assert.ok(N(by_id('fp08-liq').textContent).includes('сумма скрыта, правило не подтверждено с 2026-01-01'));
  assert.ok(!text_main().includes('558,00'));
  // пока правило свежее, карточка показывает сумму как прежде
  const fresh = clone(ws);
  fresh.tax_rules[0].reviewed_at = '2026-10-01';
  reset(fresh);
  await go('#reserves');
  assert.ok(N(by_id('fp08-pending').textContent).includes(`Доход ${N(money(55800))} от 3 октября: в конверт.`), N(by_id('fp08-pending').textContent));
});

test('TST-58 REQ-062 REQ-067 REQ-108 английский интерфейс: карточки, плашки, кнопки и диалог рисуются из каталога EN без русских слов; после возврата на русский тексты прежние', async () => {
  reset(insurance_ws({ paid: true }));
  find_all(byid.get('controls'), (n) => n.attrs.lang === 'en')[0].listeners.click[0]();
  await go('#reserves');
  const cards = N(by_id('fp15-reserves').textContent);
  assert.ok(cards.includes('Reserves: balance and calculation'));
  assert.ok(cards.includes('The due date September 15 has arrived and the reserve payment was made, but €50.00 is still recorded in the reserve.'), cards);
  assert.equal(N(by_id('fp15-r0-release').textContent), 'Release the balance');
  assert.equal(by_id('fp15-r0-release').attrs['aria-label'], 'Release the balance €50.00 of the reserve "Annual insurance"');
  assert.equal(N(by_id('fp15-r0-how').textContent), 'How it is calculated');
  assert.ok(N(byid.get('summary').textContent).includes('€50.00 is recorded in the reserve "Annual insurance", its due date has arrived and the payment was made: the balance is released manually.'));
  assert.ok(!/[А-Яа-яЁё]/.test(cards.replace(/«[^»]*»/g, '')), 'русских слов нет: ' + cards.match(/[А-Яа-яЁё]+/g));
  click(by_id('fp15-r0-how'));
  assert.equal(N(byid.get('dlg-title').textContent), 'How it is calculated: Annual insurance');
  assert.ok(!/[А-Яа-яЁё]/.test(text_dlg()), text_dlg().match(/[А-Яа-яЁё]+/g)?.join(','));
  // правило под отключённым сроком — тоже на английском
  reset(with_rule_age(276, 60));
  await go('#reserves');
  const t = text_main();
  assert.ok(t.includes('The rule has not been confirmed since 2026-01-01: the numbers stay hidden until it is confirmed or changed.'), 'gate.rule_disabled с датой');
  assert.ok(t.includes('The envelope numbers are hidden: the rule has not been confirmed since 2026-01-01'));
  assert.equal(N(by_id('fp15-rule-0-confirm').textContent), 'Confirm the rule');
  assert.ok(!t.includes('558.00') && !t.includes('€558'), 'числа скрыты и в EN');
  find_all(byid.get('controls'), (n) => n.attrs.lang === 'ru')[0].listeners.click[0]();
  await go('#reserves');
  assert.equal(N(by_id('fp15-reserves-title').textContent), 'Резервы: остаток и расчёт');
});

test('REQ-166 доступность: у кнопок и заголовков пакета видимый текст и уникальные id; в узлах нет style и on*; видимый текст кнопки — начало доступного имени', async () => {
  reset(insurance_ws({ paid: true }));
  await go('#reserves');
  const ids = [];
  const bad = [];
  for (const root of [main(), byid.get('summary')]) {
    root.walk((n) => {
      if (n.attrs.id !== undefined) ids.push(n.attrs.id);
      if (n.attrs.style !== undefined) bad.push('style');
      if (Object.keys(n.attrs).some((k) => /^on/i.test(k))) bad.push('on*');
      if (n.tagName === 'button' && n.textContent.trim() === '' && !n.attrs['aria-label']) bad.push('кнопка без текста');
      if (n.tagName === 'button' && n.attrs['aria-label'] !== undefined && !N(n.attrs['aria-label']).startsWith(N(n.textContent))) bad.push('имя не начинается с текста: ' + n.attrs.id);
      if (n.tagName === 'table' && !n.children.some((c) => c.tagName === 'caption' && c.textContent.trim() !== '')) bad.push('таблица без подписи');
    });
  }
  assert.deepEqual(bad, []);
  assert.equal(new Set(ids).size, ids.length, 'идентификаторы уникальны: ' + ids.filter((x, i) => ids.indexOf(x) !== i).join(','));
  assert.equal(by_id('fp15-r0-title')?.attrs.tabindex, '-1', 'заголовок карточки резерва — цель фокуса');
  reset(clone(G));
  await go('#reserves');
  for (const id of ['fp15-r0-title', 'fp15-rules-title', 'fp15-rule-0-title']) assert.equal(by_id(id)?.attrs.tabindex, '-1', id + ': цель фокуса');
});

test('REQ-062 общий путь записи: единая стопка «Отменить» знает правку (record_allocation → вид действия), а «Освободить остаток» не пишет ничего, кроме одной записи; рабочая область после цепочки «освободить → отменить → освободить» стабильна', async () => {
  reset(insurance_ws({ paid: true }));
  await go('#reserves');
  const start = E.canon(ctx.get_ws());
  for (let i = 0; i < 3; i++) {
    click(by_id('fp15-r0-release'));
    assert.equal(ctx.get_ws().allocations.length, 1);
    click(nav_button('Отменить'));
    assert.equal(E.canon(ctx.get_ws()), start, 'круг ' + i);
  }
  click(nav_button('Вернуть'));
  assert.equal(ctx.get_ws().allocations.length, 1, '«Вернуть» повторяет запись');
  click(nav_button('Отменить'));
  assert.equal(E.canon(ctx.get_ws()), start);
});

test('REQ-067 gate.rule_disabled называет дату reviewed_at и вне экрана «Резервы»: «Купить», «В магазине» и диалог «Почему «можно потратить»»; на английском то же', async () => {
  reset(with_rule_age(276, 60));
  const since = 'Правило не подтверждено с 2026-01-01: числа скрыты до подтверждения или правки правила.';
  await go('#buy');
  assert.ok(text_main().includes(since), 'экран «Купить»: ' + text_main().slice(0, 300));
  await go('#store');
  const input = by_id('sc-st-amount');
  input.value = '10';
  for (const fn of input.listeners.input ?? []) fn({ target: input });
  assert.ok(text_main().includes(since), 'экран «В магазине»: ' + text_main().slice(0, 300));
  await go('#overview');
  const why = find_all(main(), (n) => n.tagName === 'button' && N(n.textContent) === 'Почему «можно потратить»')[0];
  click(why);
  assert.ok(text_dlg().includes(since), 'диалог «Почему»: ' + text_dlg());
  assert.ok(!text_main().includes('{since}') && !text_dlg().includes('{since}') && !N(byid.get('summary').textContent).includes('{since}'), 'подстановка выполнена везде');
  find_all(byid.get('controls'), (n) => n.attrs.lang === 'en')[0].listeners.click[0]();
  await go('#buy');
  assert.ok(text_main().includes('The rule has not been confirmed since 2026-01-01: the numbers stay hidden until it is confirmed or changed.'));
  find_all(byid.get('controls'), (n) => n.attrs.lang === 'ru')[0].listeners.click[0]();
  reset(clone(G));
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Часть 3. Исправления по независимой проверке (дефекты FP-15)
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** Правило G-001 просрочено на `age` дней (срок `ttl`) и имеет ЗАПЛАНИРОВАННУЮ версию 2 (смена ставки с 1 декабря, записана 1 октября). */
function with_scheduled_version(age = 276, ttl = 60) {
  const ws = with_rule_age(age, ttl);
  ws.tax_rules.push({ ...clone(ws.tax_rules[0]), version: 2, rate_bp: 2500, valid_from: '2026-12-01', reviewed_at: '2026-10-01', recorded_at: '2026-10-01T10:00:00Z' });
  return ws;
}

test('REQ-067 дефект ADV-3 confirm_edit не перекрывает запланированную версию правила: новая версия действует только до её начала, 5 декабря остаётся ставка версии 2', () => {
  const ws = with_scheduled_version();
  const c = FT.confirm_edit(ws, 'TR-20', ws.as_of);
  assert.equal(c.ok, true, JSON.stringify(c.error));
  assert.equal(c.scheduled_from, '2026-12-01', 'ответ называет, чем ограничено подтверждение');
  assert.equal(c.edit.tax_rule.valid_to, '2026-12-01');
  assert.equal(c.edit.tax_rule.valid_from, '2026-10-04');
  const after = apply(ws, c.edit);
  const rules = after.tax_rules.flat();
  assert.deepEqual(rules.map((r) => r.version), [1, 2, 3]);
  assert.deepEqual(rules.slice(1).map((r) => [r.version, r.rate_bp, r.valid_from, r.valid_to ?? null]), [[2, 2500, '2026-12-01', null], [3, 2000, '2026-10-04', '2026-12-01']]);
  assert.equal(E.rule_at(rules, 'TR-20', '2026-12-05').rate_bp, 2500, 'после 1 декабря действует запланированная ставка, а не подтверждённая копия старой');
  assert.equal(E.rule_at(rules, 'TR-20', '2026-12-05').version, 2);
  assert.equal(E.rule_at(rules, 'TR-20', '2026-12-01').version, 2, 'граница: valid_to — первый день запланированной версии');
  assert.equal(E.rule_at(rules, 'TR-20', '2026-11-30').version, 3, 'до начала запланированной версии действует подтверждённая');
  assert.equal(E.rule_at(rules, 'TR-20', '2026-10-04').reviewed_at, '2026-10-04');
  assert.equal(E.analyze(after, { as_of: after.as_of }).rule_status['TR-20'], 'fresh', 'правило снова свежее');
  // повторное подтверждение (версия 3 → 4) запланированную версию тоже не трогает
  const again = FT.confirm_edit(after, 'TR-20', after.as_of);
  assert.equal(again.ok, true);
  const after2 = apply(after, again.edit);
  assert.equal(E.rule_at(after2.tax_rules.flat(), 'TR-20', '2026-12-05').rate_bp, 2500);
  assert.deepEqual(after2.tax_rules.flat().find((r) => r.version === 2), ws.tax_rules[1], 'версия 2 не изменилась');
});

test('REQ-067 confirm_edit: ближайшая из нескольких будущих версий ограничивает подтверждение; прежний valid_to, если он раньше, сохраняется; без будущих версий valid_to не добавляется', () => {
  const ws = with_scheduled_version();
  ws.tax_rules.push({ ...clone(ws.tax_rules[0]), version: 3, rate_bp: 3000, valid_from: '2027-03-01', reviewed_at: '2026-10-02', recorded_at: '2026-10-02T10:00:00Z' });
  const near = FT.confirm_edit(ws, 'TR-20', ws.as_of);
  assert.equal(near.edit.tax_rule.valid_to, '2026-12-01', 'ближайшая версия — 1 декабря, а не 1 марта');
  // прежний valid_to раньше запланированной версии: остаётся прежним, ограничения от версии нет
  const cut = clone(ws);
  cut.tax_rules[0].valid_to = '2026-11-15';
  const c2 = FT.confirm_edit(cut, 'TR-20', cut.as_of);
  assert.equal(c2.ok, true, JSON.stringify(c2.error));
  assert.equal(c2.edit.tax_rule.valid_to, '2026-11-15');
  assert.equal(c2.scheduled_from, null);
  // будущих версий нет: правка прежняя (valid_to как у действующей версии), scheduled_from = null
  const plain = with_rule_age(276, 60);
  const c3 = FT.confirm_edit(plain, 'TR-20', plain.as_of);
  assert.equal(c3.scheduled_from, null);
  assert.equal(c3.edit.tax_rule.valid_to, plain.tax_rules[0].valid_to);
});

test('REQ-067 дефект ADV-3 «Подтвердить правило» в интерфейсе при запланированной смене ставки: числа возвращаются, 5 декабря ставка версии 2, сообщение называет дату, «Отменить» убирает ровно одну версию', async () => {
  reset(with_scheduled_version());
  await go('#reserves');
  click(by_id('fp15-rule-0-confirm'));
  const rules = ctx.get_ws().tax_rules.flat();
  assert.deepEqual(rules.map((r) => r.version), [1, 2, 3]);
  assert.equal(E.rule_at(rules, 'TR-20', '2026-12-05').rate_bp, 2500, 'запланированная ставка не перекрыта');
  assert.ok(text_main().includes(N(money(155800))), 'числа вернулись');
  const notes = ext.diagnostics().filter((d) => d.status === 'notify').map((d) => d.message);
  assert.ok(notes.some((m) => /^Правило «.+» подтверждено до 2026-12-01: с этой даты действует уже записанная версия правила, она не менялась\.$/.test(m)), JSON.stringify(notes.slice(-3)));
  click(nav_button('Отменить'));
  assert.deepEqual(ctx.get_ws().tax_rules.flat().map((r) => r.version), [1, 2]);
  reset(clone(G));
});

test('REQ-067 дефект ADV-2 правило с отметкой проверки, но без срока годности: карточка говорит «срок годности не задан», без «undefined», «NaN» и сырых подстановок; кнопки нет', async () => {
  const ws = clone(G);
  ws.tax_rules[0].reviewed_at = '2026-09-01';
  delete ws.tax_rules[0].ttl_days;
  reset(ws);
  await go('#reserves');
  const card = N(by_id('fp15-rules').textContent);
  assert.ok(card.includes('Проверено 2026-09-01; срок годности не задан'), card);
  assert.ok(!/undefined|\bnull\b|NaN|\{[a-z_]+\}/.test(text_main()), 'сырые значения на странице: ' + (text_main().match(/.{0,40}(undefined|\bnull\b|NaN|\{[a-z_]+\}).{0,30}/) ?? [''])[0]);
  assert.equal(by_id('fp15-rule-0-confirm'), undefined, 'подтверждать нечего: срок не задан, правило не устаревает');
  find_all(byid.get('controls'), (n) => n.attrs.lang === 'en')[0].listeners.click[0]();
  await go('#reserves');
  assert.ok(N(by_id('fp15-rules').textContent).includes('Reviewed 2026-09-01; no shelf life is set'), N(by_id('fp15-rules').textContent));
  find_all(byid.get('controls'), (n) => n.attrs.lang === 'ru')[0].listeners.click[0]();
  reset(clone(G));
});

test('REQ-062 дефект ADV-6 срок резерва сегодня: тексты не говорят «прошёл» про сегодняшнюю дату — «наступил»; на английском «has arrived»', async () => {
  const ws = insurance_ws({ paid: true });
  ws.reserves[0].due_date = ws.as_of;
  assert.ok(warn_codes(ws).includes('W_RESERVE_RESIDUAL'), 'движок строит предупреждение при due_date = as_of');
  reset(ws);
  await go('#reserves');
  const t = N(byid.get('summary').textContent) + ' ' + text_main();
  assert.ok(!/прошёл/.test(t), 'нет слова «прошёл»: ' + t.match(/.{40}прошёл.{20}/));
  assert.ok(N(by_id('fp15-reserves').textContent).includes('Срок 4 октября наступил'));
  assert.ok(N(byid.get('summary').textContent).includes('срок наступил'));
  const od = insurance_ws({ paid: false });
  od.reserves[0].due_date = od.as_of;
  reset(od);
  await go('#reserves');
  assert.ok(N(byid.get('summary').textContent).includes('Срок резерва «Годовая страховка» наступил, платёж не найден'));
  find_all(byid.get('controls'), (n) => n.attrs.lang === 'en')[0].listeners.click[0]();
  await go('#reserves');
  assert.ok(!/has passed|past due/.test(N(byid.get('summary').textContent) + ' ' + text_main()), 'английские тексты тоже без «прошёл»');
  assert.ok(N(by_id('fp15-reserves').textContent).includes('The due date October 4 has arrived'));
  find_all(byid.get('controls'), (n) => n.attrs.lang === 'ru')[0].listeners.click[0]();
  reset(clone(G));
});

test('REQ-062 дефект ADV-14 и ADV-8 текст не выдаёт записанную сумму за остаток «после платежа»: шапка называет записанное, карточка перечисляет платежи резерва и подсказывает записать платёж до освобождения', async () => {
  reset(insurance_ws({ paid: true }));
  await go('#reserves');
  const hdr = N(byid.get('summary').textContent);
  assert.ok(!/после платежа осталось/.test(hdr), hdr);
  assert.ok(hdr.includes(`записано ${N(money(5000))}`), hdr);
  const card = N(by_id('fp15-reserves').textContent);
  assert.ok(card.includes(`Платежи по резерву: 10 сентября ${N(money(-3000))}.`), card);
  assert.ok(card.includes('Освобождается весь записанный в резерве остаток'), card);
  assert.ok(card.includes('Проведено, но в конверт не записано'), 'подсказка называет карточку FP-08');
  assert.ok(N(by_id('fp08-pending').textContent).includes(N(money(3000))), 'эта карточка на странице есть и называет платёж');
  // OVERDUE: платежей нет — ни строки платежей, ни подсказки
  reset(insurance_ws({ paid: false }));
  await go('#reserves');
  const od = N(by_id('fp15-reserves').textContent);
  assert.ok(!od.includes('Платежи по резерву') && !od.includes('Освобождается весь записанный'), od);
  find_all(byid.get('controls'), (n) => n.attrs.lang === 'en')[0].listeners.click[0]();
  reset(insurance_ws({ paid: true }));
  await go('#reserves');
  const en = N(by_id('fp15-reserves').textContent);
  assert.ok(en.includes(`Payments from the reserve: September 10 ${N(money(-3000, 'en'))}.`), en);
  assert.ok(!/[А-Яа-яЁё]/.test(en.replace(/«[^»]*»/g, '').replace(/"[^"]*"/g, '')), 'русских слов нет: ' + en.match(/[А-Яа-яЁё]+/g));
  find_all(byid.get('controls'), (n) => n.attrs.lang === 'ru')[0].listeners.click[0]();
  reset(clone(G));
});

test('REQ-062 payments_text: платежи по возрастанию даты, последние три, раньше — счётчиком «ещё N ранее»; пустой список — нет строки', () => {
  const f = ctx.fmt();
  assert.equal(RELEASE.payments_text(ctx, f, []), null);
  assert.equal(RELEASE.payments_text(ctx, f, undefined), null);
  const pays = ['2026-05-10', '2026-06-10', '2026-07-10', '2026-08-10', '2026-09-10'].map((date, i) => ({ date, amount_minor: -1000 * (i + 1) }));
  const t = N(RELEASE.payments_text(ctx, f, pays));
  assert.ok(t.startsWith('Платежи по резерву: ещё 2 ранее; '), t);
  assert.ok(t.includes(N(money(-3000))) && t.includes(N(money(-5000))) && !t.includes(N(money(-1000))), t);
  assert.equal(N(RELEASE.payments_text(ctx, f, pays.slice(3))), `Платежи по резерву: ${N(f.date('2026-08-10'))} ${N(money(-4000))}; ${N(f.date('2026-09-10'))} ${N(money(-5000))}.`);
});

test('REQ-067 дефект ADV-12 накопление, которое пополняет отключённое правило, не печатает суммы в блоке «Накопления»; накопление без такого правила печатает как прежде', async () => {
  const fresh = with_rule_age(10, 60);
  fresh.tax_rules[0].reserve_id = 'RES-INS';
  const fm = model_of(fresh);
  const rs = fm.ctx.reserve.plan.by_reserve['RES-INS'];
  const end = rs.close[rs.close.length - 1];
  reset(fresh);
  await go('#reserves');
  const sink_of = () => find_all(main(), (n) => n.tagName === 'section' && /Накопления|Savings/.test(N(n.textContent)) && /Годовая страховка:|Annual insurance:/.test(N(n.textContent)))[0];
  assert.ok(N(sink_of().textContent).includes(N(money(end))), 'свежее правило: сумма к концу горизонта напечатана');
  const dis = clone(fresh);
  dis.tax_rules[0].reviewed_at = iso_ago(dis, 276);
  reset(dis);
  await go('#reserves');
  const sink = N(sink_of().textContent);
  assert.ok(!sink.includes(N(money(end))), 'к концу горизонта напечатано ' + N(money(end)) + ': ' + sink);
  assert.ok(sink.includes('Суммы резерва скрыты') && sink.includes('не подтверждено с 2026-01-01'), sink);
  assert.ok(!sink.includes('сейчас в резерве'), sink);
  find_all(byid.get('controls'), (n) => n.attrs.lang === 'en')[0].listeners.click[0]();
  await go('#reserves');
  assert.ok(N(sink_of().textContent).includes('The reserve amounts are hidden') && !N(sink_of().textContent).includes(N(money(end, 'en'))), N(sink_of().textContent));
  find_all(byid.get('controls'), (n) => n.attrs.lang === 'ru')[0].listeners.click[0]();
  // контроль: правило кормит RES-TAX, накопление RES-INS от него не зависит — строка с суммами остаётся
  reset(with_rule_age(276, 60));
  await go('#reserves');
  assert.ok(/Годовая страховка: цель .* сейчас в резерве .*на конец горизонта/.test(N(sink_of().textContent)), N(sink_of().textContent));
  reset(clone(G));
});

test('REQ-067 rule_age.reserve_off_since: резерв, который пополняет отключённое правило, — дата; свежее правило, чужой резерв и резерв без правил — null', () => {
  const dis = with_rule_age(276, 60);
  const st = model_of(dis).ctx.rule_status;
  const tax = dis.reserves.find((r) => r.reserve_id === 'RES-TAX');
  const ins = dis.reserves.find((r) => r.reserve_id === 'RES-INS');
  assert.equal(RULE_AGE.reserve_off_since(dis, tax, dis.as_of, st), '2026-01-01');
  assert.equal(RULE_AGE.reserve_off_since(dis, ins, dis.as_of, st), null, 'накопление правилом не пополняется');
  assert.equal(RULE_AGE.reserve_off_since(dis, tax, dis.as_of, { 'TR-20': 'stale' }), null);
  assert.equal(RULE_AGE.reserve_off_since(dis, tax, dis.as_of, undefined), null);
  assert.equal(RULE_AGE.reserve_off_since(dis, undefined, dis.as_of, st), null);
  const feeds_ins = clone(dis);
  feeds_ins.tax_rules[0].reserve_id = 'RES-INS';
  assert.equal(RULE_AGE.reserve_off_since(feeds_ins, feeds_ins.reserves.find((r) => r.reserve_id === 'RES-INS'), dis.as_of, st), '2026-01-01');
  assert.deepEqual(EXPLAIN.rules_of_reserve(dis, tax), RULE_AGE.rule_ids_of_reserve(dis, tax), 'одна реализация');
});

test('REQ-062 дефект возврата фокуса: попытки идут до конца общего окна хранителя фокуса FP-11; новый запрос отменяет попытки прежнего', async () => {
  assert.equal(RELEASE.REFOCUS_DELAYS[RELEASE.REFOCUS_DELAYS.length - 1], FK.FOCUS_WINDOW_MS, 'последняя попытка — конец общего окна');
  assert.ok(Object.isFrozen(RELEASE.REFOCUS_DELAYS));
  assert.deepEqual([...RELEASE.REFOCUS_DELAYS], [...RELEASE.REFOCUS_DELAYS].sort((a, b) => a - b), 'задержки возрастают');
  reset(clone(G));
  await go('#reserves');
  await wait(60); // хранилище просит ещё одну перерисовку: дальше узлы берём уже после неё
  const a = by_id('fp15-reserves-title');
  const b = by_id('fp15-rules-title');
  assert.ok(a !== undefined && b !== undefined);
  a.focused = false; b.focused = false;
  RELEASE.refocus_later(['fp15-reserves-title'], [30]);
  RELEASE.refocus_later(['fp15-rules-title'], [30]);
  await wait(120);
  assert.equal(document.getElementById('fp15-rules-title'), b, 'страница за это время не перерисовывалась');
  assert.equal(a.focused, false, 'прежний запрос отменён новым');
  assert.equal(b.focused, true, 'новый запрос вернул фокус');
});
