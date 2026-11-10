// reconcile.test.mjs — FP-11: экран «Сверка» (demo/reconcile.mjs, pack_fp11.mjs, виды правок set_match и set_plan_status, мост ws_bridge → match.set).
// Покрывает: TST-40 REQ-031 (матрица допусков: −90000 → сопоставлено, −94500 → сопоставлено, −95000 → «возможный двойник», −100000 → не сопоставлено, два кандидата → очередь),
// TST-41 REQ-032 (доход 15 октября: 18-го «ожидается», 19-го «просрочено»), REQ-106 (очередь по убыванию суммы, сверка необязательна), набор late («Просрочено: ожидали …»),
// действия пишут match.set (запись журнала, факт не мутирует) и общий путь, очередь пустеет после разбора, отмена возвращает прежнее, пагинация всех фактов, RU/EN, a11y, TST-56, TST-59.
// Ожидаемые числа — из канона REQ-031 и ручного расчёта допусков (4500·10000 ≤ 500·90000); DOM — заглушка, браузер и сеть не используются.
// Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ── заглушка DOM ───────────────────────────────────────────────────────────────────────────────────────────────────────

class FakeNode {
  constructor(tag) {
    this.nodeType = 1; this.tagName = tag; this.attrs = {}; this.children = []; this.listeners = {}; this.className = ''; this._text = ''; this._value = ''; this._sel = null; this.focused = false; this.open = false;
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
  querySelectorAll() { return []; }
  walk(fn) { fn(this); for (const c of this.children) if (c.nodeType === 1) c.walk(fn); }
}
const CUR = { root: null };
const STATIC = new Map();
for (const id of ['dlg', 'dlg-title', 'dlg-body', 'dlg-close', 'live']) STATIC.set(id, new FakeNode(id === 'dlg' ? 'dialog' : 'div'));
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const by_id = (root, id) => find_all(root, (n) => n.attrs.id === id)[0];
globalThis.document = {
  createElement: (t) => new FakeNode(t), createElementNS: (_n, t) => new FakeNode(t), createTextNode: (data) => ({ nodeType: 3, data }),
  getElementById: (id) => STATIC.get(id) ?? (CUR.root === null ? null : by_id(CUR.root, id) ?? null), head: new FakeNode('head'), body: new FakeNode('body'),
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.resolve(HERE, '..');
const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);
const ENGINE = await imp('engine', 'index.mjs');
const APP = await imp('demo', 'app.mjs');
const { create_ext } = await imp('demo', 'ext.mjs');
const I18N = await imp('demo', 'i18n.mjs');
const { seeded_ports } = await imp('demo', 'ids.mjs');
const WE = await imp('demo', 'ws_edit.mjs');
const BR = await imp('demo', 'ws_bridge.mjs');
const RC = await imp('demo', 'reconcile.mjs');
const PACK = await imp('demo', 'pack_fp11.mjs');
const PACK08 = await imp('demo', 'pack_fp08.mjs');
const FORMS_CAT = (await imp('demo', 'i18n', 'forms.mjs')).default;
const RC_CAT = (await imp('demo', 'i18n', 'reconcile.mjs')).default;
const UNDO = await imp('demo', 'undo.mjs');
const JL = await imp('demo', 'journal_log.mjs');
const IDS = await imp('demo', 'ids.mjs');
const ENTRY_CAT = (await imp('demo', 'i18n', 'entry.mjs')).default;
if (I18N.t('ru', 'entry.u_reconcile') === 'entry.u_reconcile') I18N.register_strings('entry', ENTRY_CAT);
I18N.register_strings('forms', FORMS_CAT); // тексты отказов форм (forms.err_*)
for (const [type, fn] of Object.entries(PACK08.EDITS)) if (!WE.list_edit_types().includes(type)) WE.register_edit(type, fn); // set_occurrence_override
const load = (name) => JSON.parse(fs.readFileSync(path.join(PROTO, 'data', name), 'utf8'));
const LATE = load('g001-late.json');
const tr = (lang, k, p) => I18N.t(lang, k, p);
const tick = () => new Promise((r) => setImmediate(r));
const N = (s) => String(s).replace(/[  ]/g, ' ');

// ── рабочие области ────────────────────────────────────────────────────────────────────────────────────────────────────

const BASE = {
  workspace_id: 'ws-rc', name: 'Сверка', locale: 'ru', decision_currency: 'EUR', as_of: '2026-11-30',
  params: { horizon_days: 30, buffer_minor: 50000 },
  accounts: [{ account_id: 'acc_main', name: 'Основной счёт', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2, liquidity_bp: 0 }],
  calendars: [], anchors: [{ anchor_id: 'anc1', account_id: 'acc_main', date: '2026-11-01', amount_minor: 500000 }],
  facts: [], rules: [], overrides: [], plans: [], streams: [], tax_rules: [], reserves: [], allocations: [], rates: [], scenarios: [], purchases: [], debts: [], wave_overrides: [], counterparties: [],
};
const plan = (id, date, amount, extra = {}) => ({
  plan_id: id, account_id: 'acc_main', name: extra.name ?? id, date, amount_minor: amount, currency: 'EUR', kind: amount < 0 ? 'expense' : 'income', tag: extra.tag ?? id,
  is_obligation: amount < 0, is_estimate: false, ...extra.rest,
});
const fact = (id, date, amount, tag = 'факт') => ({ event_id: id, account_id: 'acc_main', date, amount_minor: amount, currency: 'EUR', kind: amount < 0 ? 'expense' : 'income', tag });
const mk = (over) => ({ ...BASE, ...over });
const RENT = plan('P-RENT', '2026-11-25', -90000, { name: 'Аренда' });
const kinds_of = (m) => m.queue.map((q) => q.kind);

// ── страница с настоящим пересчётом и пакетом FP-11 ───────────────────────────────────────────────────────────────────

async function make_page(ws, { lang = 'ru', view = 'reconcile' } = {}) {
  const e = create_ext({ ports: seeded_ports({ seed: 5 }) });
  const st = { ws, lang, root: null, notes: [], renders: 0, view };
  const build = (w) => APP.build_model(w, { lang: st.lang });
  st.model = build(ws);
  e.bind_host({
    get_ws: () => st.ws, get_model: () => st.model, lang: () => st.lang, mode: () => 'worse', fmt: () => APP.make_fmt(st.lang, st.model.cur, st.model.as_of_iso),
    set_ws: (next) => { let m; try { m = build(next); } catch (err) { return { ok: false, error: err }; } st.ws = next; st.model = m; return { ok: true }; },
    render: () => { st.renders += 1; st.root = e.render_view(st.view); CUR.root = st.root; },
    notify: (m, k) => { st.notes.push([m, k]); },
  });
  const clock = { t: 1_000_000 };
  const storage = { m: new Map(), getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }, setItem(k, v) { this.m.set(k, String(v)); }, removeItem(k) { this.m.delete(k); } };
  const deps = PACK.register(e, { ports: { now_ms: () => clock.t, tz_offset_min: () => 0 }, storage });
  await e.run('boot');
  void e.ctx.journal; // журнал создаётся при первом обращении: дальше он следует за правками
  st.root = e.render_view(view);
  CUR.root = st.root;
  const page = { e, ctx: e.ctx, st, deps, clock, storage };
  page.root = () => st.root;
  page.find = (id) => by_id(st.root, id);
  page.click = (id) => { const b = by_id(st.root, id) ?? by_id(STATIC.get('dlg-body'), id); assert.ok(b !== undefined, 'нет кнопки ' + id); return b.listeners.click[0](); };
  page.text = () => N(st.root.textContent);
  page.ws = () => st.ws;
  return page;
}

// ── TST-40 REQ-031: матрица допусков ─────────────────────────────────────────────────────────────────────────────────

test('TST-40 REQ-031 допуск суммы: −90000 и −94500 (ровно 5 %) сопоставляются сами, очереди нет', () => {
  for (const amount of [-90000, -94500]) {
    const m = RC.reconcile_model(mk({ plans: [RENT], facts: [fact('F1', '2026-11-27', amount)] }));
    assert.deepEqual(m.queue, [], 'сумма ' + amount);
    assert.equal(m.facts[0].state, 'matched');
    assert.equal(m.facts[0].by, 'auto');
  }
  // 4500·10000 = 45 000 000 ≤ 500·90000 = 45 000 000: граница включена
  assert.ok(4500 * 10000 <= 500 * 90000);
});

test('TST-40 REQ-031 −95000 — «возможный двойник»: факт и план в очереди, оба учитываются до решения; −100000 — не сопоставлено: платёж просрочен, факт без плана', () => {
  const m = RC.reconcile_model(mk({ plans: [RENT], facts: [fact('F1', '2026-11-27', -95000)] }));
  assert.deepEqual(kinds_of(m), ['double']);
  assert.equal(m.queue[0].reason, 'near_tolerance');
  assert.equal(m.queue[0].fact.id, 'F1');
  assert.deepEqual(m.queue[0].candidates.map((p) => p.id), ['P-RENT']);
  assert.equal(m.facts[0].state, 'double');
  // сам расчёт держит оба: план остался в событиях, факт уже в остатке (двойной учёт до решения — по канону REQ-031)
  const a = ENGINE.analyze(mk({ plans: [RENT], facts: [fact('F1', '2026-11-27', -95000)] }), { as_of: '2026-11-30' });
  assert.ok(a.events.plan.some((e) => e.cash_event_id === 'P-RENT'));

  const far = RC.reconcile_model(mk({ plans: [RENT], facts: [fact('F1', '2026-11-27', -100000)] }));
  assert.deepEqual(kinds_of(far), ['overdue']);
  assert.equal(far.queue[0].plan.id, 'P-RENT');
  assert.deepEqual(far.queue[0].candidates.map((x) => x.id), ['F1'], 'факт предложен как кандидат для привязки');
  assert.equal(far.facts[0].state, 'unmatched');
});

test('TST-40 REQ-031 два кандидата в окне — очередь подтверждения (неоднозначно); два факта на один план — «спорно»', () => {
  const two = RC.reconcile_model(mk({ plans: [RENT, plan('P-RENT2', '2026-11-26', -90000, { name: 'Аренда 2' })], facts: [fact('F1', '2026-11-27', -90000)] }));
  assert.deepEqual(kinds_of(two), ['double']);
  assert.equal(two.queue[0].reason, 'ambiguous');
  assert.deepEqual(two.queue[0].candidates.map((p) => p.id).sort(), ['P-RENT', 'P-RENT2']);
  const dup = RC.reconcile_model(mk({ plans: [RENT], facts: [fact('F1', '2026-11-26', -90000), fact('F2', '2026-11-27', -90000)] }));
  assert.deepEqual(kinds_of(dup), ['double', 'double']);
  assert.ok(dup.queue.every((q) => q.reason === 'contested'));
});

test('TST-40 REQ-031 частичный факт оставляет остаток плана: очередь показывает «оплачено частично» и остаток', () => {
  const m = RC.reconcile_model(mk({ plans: [RENT], facts: [{ ...fact('F1', '2026-11-26', -50000), plan_ref: 'P-RENT' }] }));
  assert.deepEqual(kinds_of(m), ['partial']);
  assert.equal(m.queue[0].residual, -40000);
  assert.equal(m.queue[0].plan.id, 'P-RENT');
  assert.equal(m.facts[0].state, 'partial');
});

// ── TST-41 REQ-032: жизненный цикл вхождения ─────────────────────────────────────────────────────────────────────────

test('TST-41 REQ-032 доход на 2026-10-15 без факта: 18 октября — ожидается (в очереди нет), 19 октября — просрочено (в очереди есть)', () => {
  const income = plan('P-INC', '2026-10-15', 300000, { name: 'Оплата от клиента' });
  const base = { anchors: [{ anchor_id: 'a', account_id: 'acc_main', date: '2026-10-01', amount_minor: 500000 }], plans: [income] };
  assert.deepEqual(RC.reconcile_model(mk({ ...base, as_of: '2026-10-18' })).queue, [], '15 + 3 дня льготы = 18: ещё не просрочено');
  const late = RC.reconcile_model(mk({ ...base, as_of: '2026-10-19' }));
  assert.deepEqual(kinds_of(late), ['overdue']);
  assert.equal(late.queue[0].plan.id, 'P-INC');
  // расход без льготы: просрочен со следующего дня
  const rent = plan('P-R', '2026-10-15', -10000);
  assert.deepEqual(RC.reconcile_model(mk({ ...base, plans: [rent], as_of: '2026-10-15' })).queue, []);
  assert.deepEqual(kinds_of(RC.reconcile_model(mk({ ...base, plans: [rent], as_of: '2026-10-16' }))), ['overdue']);
});

test('REQ-106 очередь отсортирована по убыванию суммы; пропущенные и отменённые платежи в очередь не попадают; сверка необязательна — ряды те же', () => {
  const ws = mk({ plans: [plan('P-A', '2026-11-20', -10000), plan('P-B', '2026-11-21', -90000), plan('P-C', '2026-11-22', -30000), plan('P-D', '2026-11-23', -70000, { rest: { status: 'skipped' } }), plan('P-E', '2026-11-24', -80000, { rest: { status: 'cancelled' } })] });
  const m = RC.reconcile_model(ws);
  assert.deepEqual(m.queue.map((q) => q.plan.id), ['P-B', 'P-C', 'P-A']);
  assert.deepEqual(m.queue.map((q) => q.sort_amount), [90000, 30000, 10000]);
  // прогноз считается без единого решения сверки: модель сверки данные не меняет
  const before = JSON.stringify(ws);
  RC.reconcile_model(ws);
  assert.equal(JSON.stringify(ws), before);
  assert.ok(Number.isInteger(ENGINE.analyze(ws, { as_of: ws.as_of }).series.plan.close[0]));
});

// ── набор late ───────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-031 набор late: после 26 ноября плановый расход P-X виден как «Просрочено: ожидали 26 нояб.»; выплата клиента помечена «нельзя убрать отсюда»; очередь по убыванию суммы', async () => {
  const ws = { ...LATE, as_of: '2026-11-30' };
  const m = RC.reconcile_model(ws);
  const px = m.queue.find((q) => q.plan?.id === 'P-X');
  assert.ok(px !== undefined, 'P-X в очереди');
  assert.equal(px.kind, 'overdue');
  assert.equal(px.plan.amount_minor, -250000);
  assert.deepEqual([px.plan.can_skip, px.plan.can_cancel], [true, true], 'разовый платёж можно пропустить и отменить');
  const stream = m.queue.find((q) => q.plan?.source === 'stream');
  assert.ok(stream !== undefined && stream.plan.id === 'S-HOURLY@2026-11-05', 'выплата по потоку часов просрочена (5 ноября + 3 дня)');
  assert.deepEqual([stream.plan.can_skip, stream.plan.can_cancel], [false, false]);
  const rent = m.queue.find((q) => q.plan?.id === 'R-RENT@2026-10-25');
  assert.deepEqual([rent.plan.source, rent.plan.can_skip, rent.plan.can_cancel, rent.plan.nominal, rent.plan.date], ['rule', true, false, '2026-10-25', ENGINE.parse_date('2026-10-26')], 'выходной 25-го сдвинут на понедельник, ключ вхождения хранит номинальную дату');
  const amounts = m.queue.map((q) => q.sort_amount);
  assert.deepEqual(amounts, [...amounts].sort((a, b) => b - a));
  const page = await make_page(ws);
  assert.ok(page.text().includes('Просрочено: ожидали 26 ноября'), page.text().slice(0, 400));
  assert.ok(page.text().includes('Плановый расход (иллюстрация)'));
  const en = await make_page(ws, { lang: 'en' });
  assert.ok(en.text().includes('Overdue: expected November 26'), en.text().slice(0, 600));
  // на дату расчёта 4 октября набор late очереди не имеет: просроченных нет
  assert.deepEqual(RC.reconcile_model(LATE).queue, []);
});

// ── действия: match.set, очередь пустеет, отмена ───────────────────────────────────────────────────────────────────────

test('REQ-031 «Подтвердить»: запись журнала match.set (а не новый tx.posted), факт получает plan_ref, очередь пустеет; тот же inputs_hash после круга журнал → ws', async () => {
  const page = await make_page(mk({ plans: [RENT], facts: [fact('F1', '2026-11-27', -95000)] }));
  const j = page.ctx.journal;
  const n0 = j.length;
  assert.ok(page.find('rc-confirm-0') !== undefined);
  assert.ok(page.text().includes('Возможное совпадение') || page.text().includes('Сумма отличается от плана'), page.text().slice(0, 300));
  page.click('rc-confirm-0');
  const added = j.events().slice(n0);
  assert.deepEqual(added.map((e) => e.type), ['match.set'], 'в журнал ушла одна запись match.set');
  assert.deepEqual(added[0].payload, { fact_event_id: 'F1', plan_ref: 'P-RENT' });
  assert.equal(page.ws().facts[0].plan_ref, 'P-RENT');
  assert.equal(page.ws().facts[0].amount_minor, -95000, 'сам факт не изменился');
  assert.ok(page.find('rc-empty') !== undefined, 'очередь пуста: ' + page.text().slice(0, 200));
  assert.deepEqual(RC.reconcile_model(page.ws()).queue, []);
  assert.equal(RC.reconcile_model(page.ws()).facts[0].state, 'matched');
  const back = BR.events_to_ws(j.events());
  assert.equal(ENGINE.analyze(back, { as_of: back.as_of }).inputs_hash, ENGINE.analyze(page.ws(), { as_of: page.ws().as_of }).inputs_hash);
  assert.equal(back.facts.find((f) => f.event_id === 'F1').plan_ref, 'P-RENT');
  assert.ok(page.st.notes.some(([t]) => t.includes('привязан')), 'сообщение о действии');
});

test('REQ-031 «Отменить» возвращает прежнее: возврат рабочей области до привязки пишет match.set без plan_ref, привязка снимается и в журнале', async () => {
  const before = mk({ plans: [RENT], facts: [fact('F1', '2026-11-27', -95000)] });
  const page = await make_page(before);
  const j = page.ctx.journal;
  page.click('rc-confirm-0');
  const linked = page.ws();
  assert.equal(linked.facts[0].plan_ref, 'P-RENT');
  const r = page.ctx.set_ws(before, { reason: 'undo' }); // так «Отменить» возвращает рабочую область
  assert.equal(r.ok, true);
  const last = j.events().at(-1);
  assert.equal(last.type, 'match.set');
  assert.deepEqual(last.payload, { fact_event_id: 'F1' });
  const back = BR.events_to_ws(j.events());
  assert.equal(back.facts[0].plan_ref, undefined);
  assert.equal(ENGINE.analyze(back, { as_of: back.as_of }).inputs_hash, ENGINE.analyze(before, { as_of: before.as_of }).inputs_hash);
  assert.deepEqual(kinds_of(RC.reconcile_model(page.ws())), ['double']);
});

test('REQ-032 «Пропустить» и «Отменить платёж» для разового платежа: статус skipped / cancelled, платёж ушёл из прогноза и очереди, запись осталась в истории', async () => {
  for (const [btn, status] of [['rc-skip-0', 'skipped'], ['rc-cancel-0', 'cancelled']]) {
    const page = await make_page(mk({ plans: [RENT] }));
    assert.ok(page.find(btn) !== undefined, btn);
    page.click(btn);
    assert.equal(page.ws().plans[0].status, status);
    assert.equal(page.ws().plans.length, 1, 'запись в истории осталась');
    assert.ok(page.find('rc-empty') !== undefined);
    const a = ENGINE.analyze(page.ws(), { as_of: page.ws().as_of });
    assert.ok(!a.events.plan.some((e) => e.cash_event_id === 'P-RENT'), 'из прогноза убран');
    assert.ok(page.st.notes.some(([t]) => t.includes('Аренда')), 'сообщение называет платёж');
  }
});

test('REQ-032 «Пропустить» вхождение повторяющегося правила: запись override, вхождение уходит из очереди; «Отменить платёж» для правила не предлагается — вместо него пояснение со ссылкой', async () => {
  const ws = { ...LATE, as_of: '2026-10-27', plans: [], streams: [] }; // 25 октября ЖКХ и аренда сдвинуты на понедельник 26-го
  const page = await make_page(ws);
  const m = RC.reconcile_model(page.ws());
  const i = m.queue.findIndex((q) => q.plan?.id === 'R-RENT@2026-10-25');
  assert.ok(i >= 0);
  assert.equal(page.find(`rc-cancel-${i}`), undefined, 'у правила кнопки «Отменить платёж» нет');
  assert.ok(find_all(page.find(`rc-item-${i}`), (n) => n.tagName === 'a' && n.attrs.href === '#forms').length === 1, 'ссылка на «Формы данных»');
  const n0 = page.ws().overrides.length;
  page.click(`rc-skip-${i}`);
  assert.equal(page.ws().overrides.length, n0 + 1);
  assert.deepEqual(page.ws().overrides.at(-1), { rule_id: 'R-RENT', nominal_date: '2026-10-25', action: 'skip' });
  assert.ok(!RC.reconcile_model(page.ws()).queue.some((q) => q.plan?.id === 'R-RENT@2026-10-25'));
});

test('REQ-031 «Привязать факт…» к просроченному платежу: диалог с фактами-кандидатами, привязка пишет match.set, платёж и факт уходят из очереди; «Не относится» оставляет платёж просроченным', async () => {
  const ws = mk({ plans: [RENT], facts: [fact('F1', '2026-11-27', -100000, 'квартира')] });
  const page = await make_page(ws);
  const j = page.ctx.journal;
  page.click('rc-link-0');
  const dlg = STATIC.get('dlg-body');
  assert.ok(dlg.textContent.includes('Какой факт — этот платёж'), dlg.textContent);
  assert.equal(STATIC.get('dlg').open, true);
  const n0 = j.length;
  page.click('rc-pick-fact-ok');
  assert.deepEqual(j.events().slice(n0).map((e) => e.type), ['match.set']);
  assert.equal(page.ws().facts[0].plan_ref, 'P-RENT');
  assert.deepEqual(RC.reconcile_model(page.ws()).queue, [], 'сумма 1000 при плане 900 — больше плана: связь пользователя засчитывается');
  assert.equal(STATIC.get('dlg').open, false, 'диалог закрыт после успеха');

  const other = await make_page(ws);
  other.click('rc-fn-0'); // строка факта в списке «Все факты» — «Не относится к плану»
  assert.equal(other.ws().facts[0].no_plan, true);
  assert.deepEqual(kinds_of(RC.reconcile_model(other.ws())), ['overdue'], 'платёж по-прежнему просрочен, факт больше не кандидат');
  assert.deepEqual(RC.reconcile_model(other.ws()).queue[0].candidates, []);
  assert.equal(RC.reconcile_model(other.ws()).facts[0].state, 'no_plan');
  other.click('rc-fu-0'); // «Снять привязку»
  assert.equal(other.ws().facts[0].no_plan, undefined);
  assert.equal(RC.reconcile_model(other.ws()).facts[0].state, 'unmatched');
});

test('REQ-031 «Привязать к плану…» из списка фактов: выбор плана того же счёта и знака; без подходящих планов — пояснение и ссылка, а не пустой выбор', async () => {
  const page = await make_page(mk({ plans: [RENT], facts: [fact('F1', '2026-11-12', -33300, 'кофе')] }));
  page.click('rc-fl-0');
  assert.ok(STATIC.get('dlg-body').textContent.includes('Аренда'), 'план предложен');
  page.click('rc-pick-plan-ok');
  assert.equal(page.ws().facts[0].plan_ref, 'P-RENT');
  const none = await make_page(mk({ plans: [plan('P-IN', '2026-11-25', 100000)], facts: [fact('F1', '2026-11-12', -33300, 'кофе')] }));
  none.click('rc-fl-0');
  const body = STATIC.get('dlg-body').textContent;
  assert.ok(body.includes('Подходящих плановых платежей нет'), body);
  assert.equal(find_all(STATIC.get('dlg-body'), (n) => n.tagName === 'select').length, 0);
});

test('REQ-031 несколько кандидатов в «возможном совпадении»: выбор плана в списке, «Не относится» снимает двойник', async () => {
  const ws = mk({ plans: [RENT, plan('P-RENT2', '2026-11-26', -90000, { name: 'Аренда 2' })], facts: [fact('F1', '2026-11-27', -90000)] });
  const page = await make_page(ws);
  const sel = page.find('rc-plan-0');
  assert.ok(sel !== undefined && find_all(sel, (n) => n.tagName === 'option').length === 2);
  sel.value = 'P-RENT2';
  page.click('rc-confirm-0');
  assert.equal(page.ws().facts[0].plan_ref, 'P-RENT2');
  const next = RC.reconcile_model(page.ws());
  assert.deepEqual(kinds_of(next), ['overdue'], 'первый план остался без факта');
  assert.equal(next.queue[0].plan.id, 'P-RENT');
  page.click('rc-skip-0');
  assert.deepEqual(RC.reconcile_model(page.ws()).queue, [], 'очередь пустеет после разбора');
});

// ── пагинация всех фактов ────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-106 все факты с пагинацией: 40 фактов → 3 страницы по 15, ни один не потерян и не повторён; кнопки «Назад»/«Вперёд» и подпись страницы', async () => {
  const facts = Array.from({ length: 40 }, (_, i) => fact('F' + String(i).padStart(2, '0'), '2026-11-' + String(1 + (i % 28)).padStart(2, '0'), -(1000 + i), 'траты ' + i));
  const ws = mk({ facts });
  const m = RC.reconcile_model(ws);
  assert.equal(m.facts.length, 40);
  const seen = new Set();
  for (let p = 0; p < 3; p++) for (const r of RC.facts_page(m, p).rows) { assert.ok(!seen.has(r.fact.id)); seen.add(r.fact.id); }
  assert.equal(seen.size, 40);
  assert.deepEqual([RC.facts_page(m, 0).rows.length, RC.facts_page(m, 1).rows.length, RC.facts_page(m, 2).rows.length], [15, 15, 10]);
  assert.equal(RC.facts_page(m, 99).page, 2, 'за границей — к последней');
  assert.equal(RC.facts_page(m, -3).page, 0);
  const sorted = m.facts.map((r) => r.fact.date);
  assert.deepEqual(sorted, [...sorted].sort().reverse(), 'новые сверху');

  const page = await make_page(ws);
  assert.ok(page.text().includes('Все факты: 40') && page.text().includes('Страница 1 из 3'));
  assert.equal(page.find('rc-prev').attrs.disabled, '');
  page.click('rc-next');
  assert.ok(page.text().includes('Страница 2 из 3'));
  page.click('rc-next');
  assert.ok(page.text().includes('Страница 3 из 3'));
  assert.equal(page.find('rc-next').attrs.disabled, '');
  assert.equal(find_all(page.find('rc-facts'), (n) => n.tagName === 'tr' && n.attrs.id?.startsWith('rc-fact-')).length, 10);
  page.click('rc-prev');
  assert.ok(page.text().includes('Страница 2 из 3'));
});

// ── виды правок ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-031 REQ-017 вид правки set_match: проверка идентификаторов, взаимоисключение признаков, исходная область не меняется; неизвестный план отвергается', () => {
  const ws = deep_freeze(mk({ plans: [RENT], facts: [fact('F1', '2026-11-27', -95000)] }));
  const ok = WE.apply_edit(ws, { type: 'set_match', event_id: 'F1', plan_ref: 'P-RENT' });
  assert.equal(ok.ok, true, JSON.stringify(ok.error));
  assert.equal(ok.ws.facts[0].plan_ref, 'P-RENT');
  assert.equal(ws.facts[0].plan_ref, undefined, 'вход не изменён');
  assert.equal(WE.apply_edit(ok.ws, { type: 'set_match', event_id: 'F1', no_plan: true }).ws.facts[0].plan_ref, undefined, 'no_plan заменяет plan_ref');
  const cleared = WE.apply_edit(ok.ws, { type: 'set_match', event_id: 'F1' });
  assert.equal(cleared.ok, true);
  assert.equal(Object.hasOwn(cleared.ws.facts[0], 'plan_ref') || Object.hasOwn(cleared.ws.facts[0], 'no_plan'), false);
  for (const bad of [
    { type: 'set_match', event_id: 'F1', plan_ref: 'P-RENT', no_plan: true }, { type: 'set_match', event_id: 'NOPE', plan_ref: 'P-RENT' }, { type: 'set_match', event_id: 'F1', plan_ref: 'P-NOPE' },
    { type: 'set_match', event_id: 'F1', plan_ref: '' }, { type: 'set_match', event_id: 'F1', plan_ref: 5 }, { type: 'set_match', event_id: 'F1', surprise: 1 }, { type: 'set_match' },
    { type: 'set_match', event_id: 'F1', no_plan: 'yes' }, { type: 'set_match', event_id: 'F1', plan_ref: 'P\u0000X' },
  ]) {
    const r = WE.apply_edit(ws, bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.error.code, 'E_SCHEMA');
  }
});

test('REQ-031 исправление FP-11: вид правки set_match отвергает план другой валюты, другого счёта и другого знака суммы (как и список планов диалога), а совместимый принимает', () => {
  const usd = { account_id: 'acc_usd', name: 'Доллары', kind: 'bank', liquidity: 'operating', currency: 'USD', exponent: 2, liquidity_bp: 0 };
  const eur2 = { account_id: 'acc_eur2', name: 'Второй евро-счёт', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2, liquidity_bp: 0 };
  const ws = deep_freeze(mk({
    accounts: [...BASE.accounts, usd, eur2],
    plans: [
      RENT,
      plan('P-USD', '2026-11-25', -90000, { rest: { account_id: 'acc_usd', currency: 'USD' } }),
      plan('P-EUR2', '2026-11-25', -90000, { rest: { account_id: 'acc_eur2' } }),
      plan('P-INC', '2026-11-25', 90000),
    ],
    facts: [fact('F1', '2026-11-26', -50000)], // не совпадает с планом по допуску: сам не сопоставится, значит, привязка нужна
  }));
  for (const [ref, why] of [['P-USD', 'валюта'], ['P-EUR2', 'счёт'], ['P-INC', 'знак суммы']]) {
    const r = WE.apply_edit(ws, { type: 'set_match', event_id: 'F1', plan_ref: ref });
    assert.equal(r.ok, false, 'привязка к ' + ref + ' (' + why + ') должна быть отвергнута');
    assert.equal(r.error.code, 'E_SCHEMA');
    assert.equal(r.error.ctx.reason, 'plan_currency_or_sign_mismatch', ref);
    assert.throws(() => RC.edit_set_match(ws, { type: 'set_match', event_id: 'F1', plan_ref: ref }), (e) => e.code === 'E_SCHEMA' && e.ctx.reason === 'plan_currency_or_sign_mismatch');
  }
  assert.equal(WE.apply_edit(ws, { type: 'set_match', event_id: 'F1', plan_ref: 'P-RENT' }).ok, true, 'тот же счёт, валюта и знак — принимается');
  // «не относится» и снятие привязки плана не касаются
  assert.equal(WE.apply_edit(ws, { type: 'set_match', event_id: 'F1', no_plan: true }).ok, true);
  assert.equal(WE.apply_edit(ws, { type: 'set_match', event_id: 'F1' }).ok, true);
  // диалог предлагает ровно те планы, которые принимает вид правки
  const m = RC.reconcile_model(ws);
  const offered = RC.plans_for_fact(m, m.facts[0].fact).map((p) => p.id);
  assert.deepEqual(offered, ['P-RENT']);
  for (const p of m.open_plans) assert.equal(WE.apply_edit(ws, { type: 'set_match', event_id: 'F1', plan_ref: p.id }).ok, offered.includes(p.id), p.id);
});

test('REQ-032 вид правки set_plan_status: skipped / cancelled / expected; неизвестный платёж и статус отвергаются; чужие поля платежа сохраняются', () => {
  const ws = deep_freeze(mk({ plans: [RENT] }));
  const sk = WE.apply_edit(ws, { type: 'set_plan_status', plan_id: 'P-RENT', status: 'skipped' });
  assert.equal(sk.ok, true);
  assert.deepEqual({ ...sk.ws.plans[0], status: undefined }, { ...RENT, status: undefined });
  const back = WE.apply_edit(sk.ws, { type: 'set_plan_status', plan_id: 'P-RENT', status: 'expected' });
  assert.deepEqual(back.ws.plans[0], RENT, 'возврат в «ожидается» убирает статус');
  for (const bad of [{ type: 'set_plan_status', plan_id: 'X', status: 'skipped' }, { type: 'set_plan_status', plan_id: 'P-RENT', status: 'matched' }, { type: 'set_plan_status', plan_id: '', status: 'skipped' }, { type: 'set_plan_status', plan_id: 'P-RENT', status: 'skipped', extra: 1 }]) {
    assert.equal(WE.apply_edit(ws, bad).ok, false, JSON.stringify(bad));
  }
});

// ── мост: только привязка → match.set ────────────────────────────────────────────────────────────────────────────────

test('REQ-031 мост ws → журнал: изменение только plan_ref / no_plan — запись match.set; изменение других полей факта — прежняя замена tx.posted (supersedes), а при смене и привязки — ещё и пересчёт свёртки', () => {
  const before = mk({ plans: [RENT], facts: [fact('F1', '2026-11-27', -95000)] });
  const events = BR.ws_to_events(before);
  const linked = { ...before, facts: [{ ...before.facts[0], plan_ref: 'P-RENT' }] };
  assert.deepEqual(BR.diff_ws_to_specs(before, linked, events).map((s) => s.type), ['match.set']);
  const norel = { ...before, facts: [{ ...before.facts[0], no_plan: true }] };
  assert.deepEqual(BR.diff_ws_to_specs(before, norel, events)[0].payload, { fact_event_id: 'F1', no_plan: true });
  const edited = { ...before, facts: [{ ...before.facts[0], tag: 'другая метка' }] };
  assert.deepEqual(BR.diff_ws_to_specs(before, edited, events).map((s) => s.type), ['tx.posted']);
  const both = { ...before, facts: [{ ...before.facts[0], tag: 'другая метка', plan_ref: 'P-RENT' }] };
  assert.deepEqual(BR.diff_ws_to_specs(before, both, events).map((s) => s.type), ['tx.posted'], 'факт заменён целиком, привязка уходит в нём же');
  // порядок привязок: привязать → сменить план → снять; свёртка всегда равна рабочей области
  const mk2 = { ...BASE, plans: [RENT, plan('P-RENT2', '2026-11-26', -90000)], facts: [fact('F1', '2026-11-27', -95000)] };
  let cur = mk2;
  const ev = BR.ws_to_events(cur);
  const states = [{ plan_ref: 'P-RENT' }, { plan_ref: 'P-RENT2' }, { no_plan: true }, {}];
  for (const st of states) {
    const next = { ...cur, facts: [{ ...fact('F1', '2026-11-27', -95000), ...st }] };
    const specs = BR.diff_ws_to_specs(cur, next, ev);
    for (const sp of specs) ev.push(ENGINE.make_event(sp.type, sp.payload, { event_id: 'x' + ev.length, seq: ev.length + 1, recorded_at: '2026-11-30T00:00:00Z', ...(sp.opts ?? {}) }));
    cur = next;
    const back = BR.events_to_ws(ev);
    assert.deepEqual(back.facts, next.facts, JSON.stringify(st));
  }
});

// ── обзор, доступность, язык ─────────────────────────────────────────────────────────────────────────────────────────

test('REQ-106 карточка «Сверка» на «Обзоре»: есть, пока в очереди есть решения, и ведёт на #reconcile; пустая очередь — карточки нет', async () => {
  const page = await make_page(mk({ plans: [RENT] }), { view: 'overview' });
  const card = RC.render_reconcile_card(page.ctx);
  assert.ok(card !== null);
  assert.ok(N(card.textContent).includes('Решения ждут: 1'));
  assert.equal(find_all(card, (n) => n.tagName === 'a')[0].attrs.href, '#reconcile');
  const empty = await make_page(mk({ plans: [] }));
  assert.equal(RC.render_reconcile_card(empty.ctx), null);
  assert.equal(PACK.RECONCILE_ORDER < PACK.QUALITY_ORDER, true);
});

test('a11y TST-59: кнопки действий называют платёж и дату, список очереди подписан, пустое состояние — role=status, поля выбора с подписью, фокус возвращается на заголовок очереди после действия', async () => {
  const page = await make_page(mk({ plans: [RENT, plan('P-B', '2026-11-26', -20000, { name: 'Связь' })], facts: [fact('F0', '2026-11-10', -1500, 'кофе')] }));
  const skip = page.find('rc-skip-0');
  assert.match(skip.attrs['aria-label'], /Пропустить: Аренда, 25 ноября/);
  assert.equal(skip.attrs.type, 'button');
  const list = find_all(page.root(), (n) => n.className === 'plain rc-list')[0];
  assert.equal(list.tagName, 'ol');
  assert.equal(list.attrs['aria-labelledby'], 'rc-queue-title');
  assert.equal(page.find('rc-queue-title').attrs.tabindex, '-1');
  assert.equal(find_all(page.root(), (n) => n.tagName === 'table').length, 1);
  assert.ok(find_all(page.root(), (n) => n.tagName === 'caption').length === 1);
  for (const sel of find_all(page.root(), (n) => n.tagName === 'select')) assert.ok(find_all(page.root(), (n) => n.tagName === 'label' && n.attrs.for === sel.attrs.id).length === 1 || sel.attrs['aria-label'] !== undefined);
  page.click('rc-skip-0');
  await tick();
  assert.equal(page.deps.rec.focus.pending() === null || page.deps.rec.focus.pending() === 'rc-queue-title', true);
  assert.equal(page.find('rc-queue-title').focused, true, 'фокус на заголовке очереди: нажатая кнопка исчезла');
  page.click('rc-skip-0');
  assert.equal(page.find('rc-empty').attrs.role, 'status');
});

test('TST-56 каталог reconcile: паритет ключей и плейсхолдеров RU/EN, русские буквы в RU, каждый ключ используется в коде литералом или динамическим префиксом, запрещённых фраз нет', () => {
  const ru = Object.keys(RC_CAT.ru).sort();
  assert.deepEqual(Object.keys(RC_CAT.en).sort(), ru);
  const ph = (s) => [...String(s).matchAll(/\{([a-z0-9_]+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const k of ru) {
    assert.ok(k.startsWith('reconcile.'), k);
    assert.equal(ph(RC_CAT.en[k]), ph(RC_CAT.ru[k]), 'плейсхолдеры ' + k);
    // строка только из подстановок и знаков (reconcile.fact_line) букв не имеет; остальные — русские
    if (/[a-zа-яё]/i.test(RC_CAT.ru[k].replace(/{[a-z0-9_]+}/g, ''))) assert.match(RC_CAT.ru[k], /[а-яё]/i, 'русские буквы в ' + k);
  }
  const src = fs.readFileSync(path.join(PROTO, 'demo', 'reconcile.mjs'), 'utf8') + fs.readFileSync(path.join(PROTO, 'demo', 'pack_fp11.mjs'), 'utf8');
  const prefixes = [...src.matchAll(/'(reconcile\.[a-z_]+_)' \+/g)].map((m) => m[1]);
  for (const k of ru) assert.ok(src.includes(`'${k}'`) || prefixes.some((p) => k.startsWith(p)), 'ключ не используется: ' + k);
  const vocab = JSON.parse(fs.readFileSync(path.join(PROTO, 'engine', 'vocab.json'), 'utf8'));
  const all = JSON.stringify(RC_CAT).toLowerCase();
  for (const bad of vocab.forbidden_phrases) assert.ok(!all.includes(bad.toLowerCase()), 'запрещённая фраза: ' + bad);
});

test('TST-59 безопасность интерфейса: в модулях сверки нет innerHTML, inline-стилей, eval, сети и адресов; текст пользователя только через textContent', () => {
  for (const f of ['reconcile.mjs', 'focus_keep.mjs', 'pack_fp11.mjs']) {
    const src = fs.readFileSync(path.join(PROTO, 'demo', f), 'utf8');
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', "setAttribute('style'", 'fetch(', 'XMLHttpRequest', 'http://', 'https://']) assert.ok(!src.includes(bad), `${f}: ${bad}`);
  }
  const css = fs.readFileSync(path.join(PROTO, 'demo', 'css', 'reconcile.css'), 'utf8');
  assert.ok(!/url\(|@import|https?:/.test(css));
});

test('REQ-031 пакет подключается реестром: два экрана, две карточки «Обзора», два вида правок; повторная регистрация не падает', async () => {
  const page = await make_page(mk({ plans: [RENT] }));
  assert.ok(page.e.has_view('reconcile') && page.e.has_view('quality'));
  assert.ok(WE.list_edit_types().includes('set_match') && WE.list_edit_types().includes('set_plan_status'));
  assert.deepEqual(page.e.diagnostics().filter((d) => d.status === 'failed'), []);
  const again = await make_page(mk({ plans: [RENT] })); // второй реестр в том же процессе
  assert.ok(again.e.has_view('reconcile'));
  assert.ok(Object.keys(I18N.DATASETS).length >= 5);
});

function deep_freeze(x) {
  if (x !== null && typeof x === 'object' && !Object.isFrozen(x)) { Object.freeze(x); for (const k of Object.keys(x)) deep_freeze(x[k]); }
  return x;
}

test('REQ-090 подпись «Отменить» для действий сверки: оба вида правки отнесены к виду «reconcile», строки RU и EN есть, чужие виды подписей не менялись', () => {
  assert.equal(UNDO.REASON_KINDS.set_match, 'reconcile');
  assert.equal(UNDO.REASON_KINDS.set_plan_status, 'reconcile');
  assert.equal(UNDO.UNDO_LABEL_KEYS.reconcile, 'entry.u_reconcile');
  const money = (m, c) => `${m / 100} ${c}`;
  assert.equal(UNDO.unit_label({ kind: 'reconcile' }, (k, p) => I18N.t('ru', k, p), money), 'сверка плана с фактом');
  assert.equal(UNDO.unit_label({ kind: 'reconcile' }, (k, p) => I18N.t('en', k, p), money), 'plan vs actual reconciliation');
  assert.equal(UNDO.REASON_KINDS.set_occurrence_override, 'rule', 'пропуск вхождения правила — по-прежнему «изменение правила платежа»');
  assert.equal(UNDO.describe_unit('set_match', { changes: [{ bucket: 'facts', key: 'F1', before: {}, after: {} }] }, mk({})).kind, 'reconcile');
});

test('REQ-153 журнал «снимок + хвост» и match.set: привязка, «не относится», снятие и повторная привязка после снимков каждые 3 записи дают то же состояние, что полная свёртка', () => {
  const base = { ...LATE, as_of: '2026-11-30', facts: [...LATE.facts, fact('F-new', '2026-11-27', -265000, 'ремонт')] };
  for (const every of [3, 25, 500]) {
    const j = JL.create_journal({ events: BR.ws_to_events(base), ports: JL.ports_from_gen(IDS.make_id_gen(seeded_ports({ seed: 3 }))), snapshot_every: every });
    let cur = base;
    for (const st of [{ plan_ref: 'P-X' }, { no_plan: true }, {}, { plan_ref: 'P-X' }, {}]) {
      const next = { ...cur, facts: cur.facts.map((f) => { if (f.event_id !== 'F-new') return f; const { plan_ref: _p, no_plan: _n, ...rest } = f; return { ...rest, ...st }; }) };
      BR.sync_journal(j, cur, next);
      cur = next;
      assert.equal(j.state_hash(), ENGINE.state_hash(ENGINE.reduce(ENGINE.effective_events(j.events()))), `every=${every} ${JSON.stringify(st)}`);
      const back = BR.state_to_ws(j.state().state).facts.find((f) => f.event_id === 'F-new');
      assert.deepEqual([back.plan_ref, back.no_plan], [st.plan_ref, st.no_plan], `every=${every} ${JSON.stringify(st)}`);
    }
  }
});

test('REQ-106 все пять наборов (G-001, low, gap, late, empty) на обеих языках: экраны «Сверка» и «Качество» и карточки «Обзора» рисуются без ошибок и без плашки сбоя модели', async () => {
  for (const name of ['g001', 'g001-low', 'g001-gap', 'g001-late', 'g001-empty']) {
    const ws = load(name + '.json');
    for (const lang of ['ru', 'en']) {
      for (const view of ['reconcile', 'quality']) {
        const page = await make_page(ws, { lang, view });
        assert.equal(find_all(page.root(), (n) => n.attrs.role === 'alert' && n.textContent !== '').length, 0, `${name}/${lang}/${view}: плашка сбоя`);
        assert.ok(page.find('view-title') !== undefined);
        const card = RC.render_reconcile_card(page.ctx);
        assert.equal(card, null, `${name}: на дату набора просроченного нет`);
      }
    }
  }
  const empty = await make_page(load('g001-empty.json'));
  assert.ok(empty.find('rc-empty') !== undefined && empty.text().includes('Фактов пока нет'));
});

test('TST-59 текст пользователя только через textContent: разметка и скрипт в названиях платежей и метках фактов выводятся буквами, элементов не создают; в подписях кнопок они остаются значением атрибута', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  const evil_tag = '</td><script>alert(2)</script>';
  const ws = mk({ plans: [{ ...RENT, name: evil }], facts: [fact('F1', '2026-11-27', -100000, evil_tag), fact('F2', '2026-11-10', -1500, evil_tag)] });
  for (const lang of ['ru', 'en']) {
    const page = await make_page(ws, { lang });
    assert.equal(find_all(page.root(), (n) => ['img', 'script', 'iframe'].includes(n.tagName)).length, 0);
    assert.ok(page.text().includes(evil), 'название платежа показано буквами');
    assert.ok(page.text().includes(evil_tag), 'метка факта показана буквами');
    const skip = page.find('rc-skip-0');
    assert.ok(skip.attrs['aria-label'].includes(evil), 'в атрибуте — значение, а не разметка');
    assert.equal(Object.keys(skip.attrs).filter((k) => k.startsWith('on')).length, 0, 'обработчики-строки не пишутся');
    assert.equal(skip.attrs.style, undefined);
  }
});
