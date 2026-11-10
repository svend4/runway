// fp11_adv.test.mjs — состязательная проверка FP-11 (независимый проверяющий): пробы, которых нет в reconcile / quality_report / prob_band / anonymize / band_adapter.
// Пробы описывают ПРАВИЛЬНОЕ поведение. Подтверждённые дефекты помечены `todo` (воспроизведение для исправляющего: после исправления снять `todo`); без пометки — закрепляет проверенное.
// После исправлений (раунд «fix» FP-11) `todo` снят у ADV-1, 2, 8, 11, 12 — теперь это обычные регрессионные пробы; у ADV-6 остался: инструмент предупреждает, но расхождение метрик устранит только решение владельца.
// Дефекты: (ADV-1) согласие при хранилище, которое читается, но не пишется (квота общего localhost): уведомление «Эксперимент включён», а экран остаётся «выключено»;
// (ADV-2) результат «при уверенности α» показывается свежим после смены набора возмущений (ratio / fx) — полоса помечает устаревшим, оценка покупки нет;
// (ADV-6) анонимизированный журнал при k = 1 и сдвиге кратном 7 даёт другие счётчики backtest (дни месяца правил не сдвигаются) — гейт REQ-176 считался бы по искажённым данным (нужно решение владельца);
// (ADV-8) вид правки set_match принимает план другой валюты; (ADV-11) повторные ключи каталога quality.col_p50 / quality.col_p90 подменяют заголовки таблицы «Привычки платежей»;
// (ADV-12) tools/backtest_report.mjs --corpus regular без --out затирает канонический data/backtest-report.json неполным отчётом.
// Закрепляют проверенное: (ADV-3) расчёт полосы и оценки не мутирует глубоко замороженный Analysis; (ADV-5) круг журнал → рабочая область после цепочки действий сверки
// (привязать, «не относится», снять, пропустить, вернуть, void_fact) совпадает с рабочей областью; (ADV-7) границы пагинации; (ADV-9) gate_from_report отвергает подправленный отчёт;
// (ADV-10) fx_obs_from_rates (порядок записей, обратная пара, нулевой и отрицательный курс).
// DOM подменён заглушкой; браузер и сеть не используются. Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

class FakeNode {
  constructor(tag) {
    this.nodeType = 1; this.tagName = tag; this.attrs = {}; this.children = []; this.listeners = {}; this.className = ''; this._text = ''; this._value = ''; this._sel = null; this.focused = false; this.open = false; this.checked = false;
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
const BR = await imp('demo', 'ws_bridge.mjs');
const RC = await imp('demo', 'reconcile.mjs');
const WE = await imp('demo', 'ws_edit.mjs');
const PB = await imp('demo', 'prob_band.mjs');
const PACK = await imp('demo', 'pack_fp11.mjs');
const PACK08 = await imp('demo', 'pack_fp08.mjs');
const BAND = await imp('engine', 'band_adapter.mjs');
const MCI = await imp('engine', 'mc_inputs.mjs');
const BT = await imp('engine', 'backtest.mjs');
const GEN = await imp('data', 'synthetic-journals', 'generate.mjs');
const AN = await imp('tools', 'anonymize.mjs');
const FORMS_CAT = (await imp('demo', 'i18n', 'forms.mjs')).default;
I18N.register_strings('forms', FORMS_CAT);
for (const [type, fn] of Object.entries(PACK08.EDITS)) if (!WE.list_edit_types().includes(type)) WE.register_edit(type, fn);
const load = (name) => JSON.parse(fs.readFileSync(path.join(PROTO, 'data', name), 'utf8'));
const G = load('g001.json');
const N = (s) => String(s).replace(/[  ]/g, ' ');

function fake_storage(seed = {}, opts = {}) {
  const m = new Map(Object.entries(seed));
  return {
    m, get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { if (opts.write_throws === true) throw new Error('QuotaExceededError'); m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

async function make_page(ws, { lang = 'ru', view = 'quality', storage, no_storage = false } = {}) {
  const e = create_ext({ ports: seeded_ports({ seed: 9 }) });
  const st = { ws, lang, root: null, notes: [], view };
  const build = (w) => APP.build_model(w, { lang: st.lang });
  st.model = build(ws);
  e.bind_host({
    get_ws: () => st.ws, get_model: () => st.model, lang: () => st.lang, mode: () => 'worse', fmt: () => APP.make_fmt(st.lang, st.model.cur, st.model.as_of_iso),
    set_ws: (next) => { let m; try { m = build(next); } catch (err) { return { ok: false, error: err }; } st.ws = next; st.model = m; return { ok: true }; },
    render: () => { st.root = e.render_view(st.view); CUR.root = st.root; },
    notify: (m, k) => { st.notes.push([m, k]); },
  });
  const store = no_storage ? null : (storage ?? fake_storage());
  const handles = PACK.register(e, { ports: { now_ms: () => 1_000_000, tz_offset_min: () => 0 }, storage: store });
  await e.run('boot');
  void e.ctx.journal;
  st.root = e.render_view(view);
  CUR.root = st.root;
  const p = { e, ctx: e.ctx, st, deps: handles.qual, rec: handles.rec, storage: store, find: (id) => by_id(st.root, id), text: () => N(st.root.textContent), ws: () => st.ws };
  p.click = (id) => { const b = by_id(st.root, id) ?? by_id(STATIC.get('dlg-body'), id); assert.ok(b !== undefined, 'нет кнопки ' + id); return b.listeners.click[0](); };
  p.enable = () => {
    const box = p.find('qx-agree');
    box.checked = true;
    box.listeners.change[0]();
    p.click('qx-enable');
  };
  p.submit_buy = (amount, date, confidence = '90') => {
    p.find('fp08-qxbuy-amount').value = amount;
    p.find('fp08-qxbuy-date').value = date;
    p.find('fp08-qxbuy-confidence').value = confidence;
    return p.find('qx-buy-form').listeners.submit[0]({ preventDefault() {} });
  };
  return p;
}

/** Рабочая область с историей: синтетический журнал `reg02` за 27 месяцев до 2026-09-30 (24 наблюдения, выборка). */
function history_ws() {
  const spec = { ...GEN.regular_corpus()[1], start: '2024-07-01', end: '2026-09-30' };
  return { ...BR.events_to_ws(GEN.make_journal(spec)), as_of: '2026-09-30', decision_currency: 'EUR', locale: 'ru' };
}

const BASE = {
  workspace_id: 'ws-adv', name: 'Проба', locale: 'ru', decision_currency: 'EUR', as_of: '2026-11-30',
  params: { horizon_days: 30, buffer_minor: 50000 },
  accounts: [
    { account_id: 'acc_main', name: 'Основной счёт', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2, liquidity_bp: 0 },
  ],
  calendars: [], anchors: [{ anchor_id: 'anc1', account_id: 'acc_main', date: '2026-11-01', amount_minor: 500000 }],
  facts: [], rules: [], overrides: [], plans: [], streams: [], tax_rules: [], reserves: [], allocations: [], rates: [], scenarios: [], purchases: [], debts: [], wave_overrides: [], counterparties: [],
};
const plan = (id, date, amount, extra = {}) => ({ plan_id: id, account_id: extra.account_id ?? 'acc_main', name: extra.name ?? id, date, amount_minor: amount, currency: extra.currency ?? 'EUR', kind: amount < 0 ? 'expense' : 'income', tag: id, is_obligation: amount < 0, is_estimate: false });
const fact = (id, date, amount, tag = 'факт') => ({ event_id: id, account_id: 'acc_main', date, amount_minor: amount, currency: 'EUR', kind: amount < 0 ? 'expense' : 'income', tag });
const mk = (over) => ({ ...BASE, ...over });

function deep_freeze(x) {
  if (x !== null && typeof x === 'object' && !Object.isFrozen(x)) { Object.freeze(x); for (const k of Object.keys(x)) deep_freeze(x[k]); }
  return x;
}

// ── ADV-1: хранилище читается, но не пишется ───────────────────────────────────────────────────────────────────────────

test('ADV-1 согласие при хранилище, в которое нельзя писать (квота общего localhost): экран не говорит «включён», оставаясь выключенным', async () => {
  const storage = fake_storage({}, { write_throws: true });
  const page = await make_page(G, { storage });
  page.enable();
  const said_on = page.st.notes.some(([t]) => t.startsWith('Эксперимент включён'));
  const state_on = page.find('qx-exp-state').textContent.includes('включено');
  // правильно: либо согласие действует до перезагрузки (как без хранилища), либо экран честно говорит, что не включил; нельзя «включён» в уведомлении и «выключено» на экране
  assert.equal(said_on, state_on, `уведомление «включён» = ${said_on}, состояние на экране «включено» = ${state_on}`);
});

// ── ADV-2: оценка «при уверенности α» и набор возмущений ───────────────────────────────────────────────────────────────

test('ADV-2 результат «при уверенности α» не показывается свежим после смены набора возмущений (отклонения трат / курсы), как и полоса', async () => {
  const page = await make_page(history_ws());
  page.enable();
  page.click('qx-band-run');
  page.submit_buy('300,00', '2026-10-05');
  assert.ok(page.find('qx-buy-lines') !== undefined, 'оценка посчитана');
  page.deps.ui.kinds.ratio = true; // как если бы пользователь отметил «Отклонения оценочных трат» в блоке полосы
  page.e.render_view('quality');
  page.st.root = page.e.render_view('quality');
  CUR.root = page.st.root;
  assert.equal(by_id(page.st.root, 'qx-buy-lines'), undefined, 'результат посчитан для другого набора возмущений — свежим показывать нельзя');
});

// ── ADV-3: расчёт не мутирует Analysis ─────────────────────────────────────────────────────────────────────────────────────

test('ADV-3 mc_band и mc_buy на глубоко замороженном Analysis не бросают и не меняют вход', () => {
  const ws = history_ws();
  const analysis = ENGINE.analyze(ws, { as_of: ws.as_of });
  const hash = analysis.inputs_hash;
  deep_freeze(analysis);
  deep_freeze(ws);
  const b = BAND.mc_band(ws, analysis, { n_paths: 200 });
  assert.equal(b.ok, true);
  const y = BAND.mc_buy(ws, analysis, { S: 30000, date: '2026-10-05', n_paths: 200 });
  assert.equal(y.ok, true);
  assert.equal(analysis.inputs_hash, hash);
});

// ── ADV-5: круг журнал → рабочая область после цепочки действий ────────────────────────────────────────────────────────

test('ADV-5 цепочка действий сверки (привязать, не относится, снять, привязать, пропустить) даёт журнал, свёртка которого равна рабочей области', async () => {
  const RENT = plan('P-RENT', '2026-11-25', -90000, { name: 'Аренда' });
  const ws = mk({ plans: [RENT, plan('P-GYM', '2026-11-26', -4000, { name: 'Зал' })], facts: [fact('F1', '2026-11-27', -95000), fact('F2', '2026-11-28', -4100, 'зал')] });
  const page = await make_page(ws, { view: 'reconcile' });
  const steps = [
    { type: 'set_match', event_id: 'F1', plan_ref: 'P-RENT' },
    { type: 'set_match', event_id: 'F1', no_plan: true },
    { type: 'set_match', event_id: 'F1' },
    { type: 'set_match', event_id: 'F1', plan_ref: 'P-RENT' },
    { type: 'set_plan_status', plan_id: 'P-GYM', status: 'skipped' },
    { type: 'set_plan_status', plan_id: 'P-GYM', status: 'expected' },
    { type: 'void_fact', event_id: 'F2' },
  ];
  for (const s of steps) {
    const r = page.ctx.edit(s, { reason: s.type });
    assert.equal(r.ok, true, JSON.stringify(s) + ' ' + JSON.stringify(r.error ?? null));
    const back = BR.events_to_ws(page.ctx.journal.events());
    const a = ENGINE.analyze(back, { as_of: back.as_of }).inputs_hash;
    const b = ENGINE.analyze(page.ws(), { as_of: page.ws().as_of }).inputs_hash;
    assert.equal(a, b, 'после ' + JSON.stringify(s));
    assert.deepEqual(back.facts, page.ws().facts, 'факты после ' + JSON.stringify(s));
    assert.deepEqual(back.plans, page.ws().plans, 'планы после ' + JSON.stringify(s));
  }
});

// ── ADV-6: анонимизация сохраняет смысл журнала ──────────────────────────────────────────────────────────────────────────

test('ADV-6 анонимизация при k = 1 и сдвиге 7·N дней сохраняет метрики backtest исходного журнала (иначе гейт REQ-176 считается по искажённым данным)', { todo: 'FP-11 ADV-6: by_monthday правил не сдвигается вместе с фактами; инструмент теперь предупреждает (notes, stderr), README называет масштаб расхождения; сама метрика совпадёт только после решения владельца (REQ-176)' }, () => {
  const diffs = [];
  for (const spec of GEN.regular_corpus().slice(0, 4)) {
    const j = GEN.make_journal(spec);
    const base = BT.backtest(j, '2026-03-01', 14);
    const a = AN.anonymize_journal(j, { shift_weeks: 3, k_bp: 10000 });
    const d0 = new Date(Date.UTC(2026, 2, 1) + 21 * 86400000).toISOString().slice(0, 10);
    const r = BT.backtest(a.journal, d0, 14);
    const row = (x) => `${x.frr.k}/${x.frr.n} ${x.cry_wolf.k}/${x.cry_wolf.n}`;
    if (row(base) !== row(r)) diffs.push(`${spec.id}: ${row(base)} → ${row(r)}`);
  }
  assert.deepEqual(diffs, [], 'метрики после сдвига на 3 недели при k = 1 изменились');
});

// ── ADV-7: пагинация ───────────────────────────────────────────────────────────────────────────────────────────────────

test('ADV-7 пагинация фактов: ровно 15 — одна страница, 16 — две; «Вперёд» на последней и «Назад» на первой недоступны', () => {
  const mkf = (n) => mk({ facts: Array.from({ length: n }, (_, i) => fact('F' + String(i).padStart(3, '0'), '2026-11-' + String(1 + (i % 28)).padStart(2, '0'), -100 - i)) });
  for (const [n, pages] of [[0, 1], [1, 1], [15, 1], [16, 2], [30, 2], [31, 3]]) {
    const m = RC.reconcile_model(mkf(n));
    const p0 = RC.facts_page(m, 0);
    assert.equal(p0.pages, pages, 'n=' + n);
    assert.equal(p0.rows.length, Math.min(15, n));
    assert.equal(RC.facts_page(m, 99).page, pages - 1, 'за границей — к границе');
    assert.equal(RC.facts_page(m, -3).page, 0);
    assert.equal(RC.facts_page(m, Number.NaN).page, 0);
    assert.equal(RC.facts_page(m, 1.5).page, 0, 'нецелая страница не даёт срез с дробным смещением');
    const seen = new Set();
    for (let p = 0; p < pages; p++) for (const r of RC.facts_page(m, p).rows) seen.add(r.fact.id);
    assert.equal(seen.size, n, 'каждый факт ровно на одной странице');
  }
});

// ── ADV-8: вид правки set_match отвергает несовместимый план ────────────────────────────────────────────────────────────

test('ADV-8 set_match: привязка расхода к плану другой валюты или к доходу отвергается самим видом правки (а не только фильтром диалога)', () => {
  const usd = { account_id: 'acc_usd', name: 'Доллары', kind: 'bank', liquidity: 'operating', currency: 'USD', exponent: 2, liquidity_bp: 0 };
  const ws = mk({ accounts: [...BASE.accounts, usd], plans: [plan('P-USD', '2026-11-25', -90000, { account_id: 'acc_usd', currency: 'USD' }), plan('P-INC', '2026-11-25', 90000)], facts: [fact('F1', '2026-11-26', -90000)] });
  for (const ref of ['P-USD', 'P-INC']) {
    let error = null;
    try { RC.edit_set_match(ws, { type: 'set_match', event_id: 'F1', plan_ref: ref }); } catch (e) { error = e; }
    assert.ok(error !== null && error.code === 'E_SCHEMA', 'привязка к ' + ref + ' должна быть отвергнута');
  }
});

// ── ADV-9: чистота расчёта отчёта и каталога ──────────────────────────────────────────────────────────────────────────────

test('ADV-9 gate_from_report отвергает отчёт с подправленным счётчиком и принимает исходный', async () => {
  const BRP = await imp('tools', 'backtest_report.mjs');
  const rep = BRP.read_report();
  assert.equal(BRP.validate_report(rep).length, 0);
  const g = BRP.gate_from_report(rep, 'regular');
  assert.equal(g.pass, true);
  const tampered = structuredClone(rep);
  tampered.corpora.regular.journals[0].frr.k += 3;
  tampered.corpora.regular.journals[0].frr.bp = null;
  assert.throws(() => BRP.gate_from_report(tampered, 'regular'), (e) => e.code === 'E_SCHEMA');
});

test('ADV-10 fx_obs_from_rates: порядок записей не влияет; нули и отрицательные курсы отвергаются; обратная пара даёт обратное по знаку приращение', () => {
  const rates = [
    { fx_id: 'a', date: '2026-01-01', base: 'USD', quote: 'EUR', num: 90, den: 100 },
    { fx_id: 'b', date: '2026-01-02', base: 'USD', quote: 'EUR', num: 99, den: 100 },
    { fx_id: 'c', date: '2026-01-03', base: 'USD', quote: 'EUR', num: 99, den: 100 },
  ];
  const fwd = MCI.fx_obs_from_rates(rates, 'USD', 'EUR');
  assert.deepEqual(fwd, { USD: [1000, 0] }, '90 → 99 это +10 %, затем без изменений');
  assert.deepEqual(MCI.fx_obs_from_rates([...rates].reverse(), 'USD', 'EUR'), fwd);
  const inv = rates.map((r) => ({ ...r, base: 'EUR', quote: 'USD', num: r.den, den: r.num }));
  const back = MCI.fx_obs_from_rates(inv, 'USD', 'EUR');
  assert.deepEqual(back, fwd, 'обратная запись той же пары — те же приращения валюты base');
  assert.throws(() => MCI.fx_obs_from_rates([{ ...rates[0], num: 0 }, rates[1]], 'USD', 'EUR'), (e) => e.code === 'E_SCHEMA');
  assert.throws(() => MCI.fx_obs_from_rates([{ ...rates[0], num: -5 }, rates[1]], 'USD', 'EUR'), (e) => e.code === 'E_SCHEMA');
});

// ── ADV-11: повторные ключи каталога подменяют заголовки таблицы «Привычки платежей» ──────────────────────────────────────────

test('ADV-11 таблица «Привычки платежей»: заголовки столбцов задержки — «Медиана, дн» и «p90, дн», а не подписи коридора «P50 (середина)» / «P90 (выше)»; в каталогах нет повторных ключей', async () => {
  for (const [lang, want, forbidden] of [['ru', ['Медиана, дн', 'p90, дн'], ['P50 (середина)', 'P90 (выше)']], ['en', ['Median, days', 'p90, days'], ['P50 (middle)', 'P90 (upper)']]]) {
    const page = await make_page(history_ws(), { lang });
    const habits = page.find('qx-habits');
    assert.ok(habits !== undefined, 'карточка привычек есть (n = 24)');
    const heads = find_all(habits, (n) => n.tagName === 'th').map((n) => N(n.textContent));
    for (const w of want) assert.ok(heads.includes(w), `${lang}: нет заголовка «${w}», есть ${JSON.stringify(heads)}`);
    for (const f of forbidden) assert.ok(!heads.includes(f), `${lang}: заголовок задержки в днях назван «${f}»`);
  }
  // общий признак: ни в одном каталоге FP-11 один ключ не объявлен дважды в одном языке
  const dup = [];
  for (const f of ['quality.mjs', 'reconcile.mjs']) {
    const lines = fs.readFileSync(path.join(PROTO, 'demo', 'i18n', f), 'utf8').split(/\r?\n/);
    let lang = null;
    const seen = { ru: new Set(), en: new Set() };
    for (const ln of lines) {
      const m = /^  (ru|en): \{/.exec(ln);
      if (m) { lang = m[1]; continue; }
      if (/^  \},?$/.test(ln)) { lang = null; continue; }
      const k = /^\s*'([^']+)':/.exec(ln);
      if (k !== null && lang !== null) { if (seen[lang].has(k[1])) dup.push(`${f}:${lang}:${k[1]}`); seen[lang].add(k[1]); }
    }
  }
  assert.deepEqual(dup, []);
});

// ── ADV-12: частичный прогон отчёта не должен затирать канонический файл ──────────────────────────────────────────────────────

test('ADV-12 tools/backtest_report.mjs --corpus regular без --out не записывает неполный отчёт в канонический data/backtest-report.json (зеркало осталось бы от полного)', async () => {
  const BRP = await imp('tools', 'backtest_report.mjs');
  const writes = [];
  const io = { read: () => '', write: (p) => { writes.push(String(p).split('\\').join('/')); }, out: () => {}, err: () => {} };
  const code = BRP.main(['--date', '2026-10-09', '--corpus', 'regular'], io);
  assert.ok(code === 0 || code === 2, 'код выхода ' + code);
  assert.ok(!writes.some((p) => p.endsWith('/data/backtest-report.json')), 'записан неполный отчёт в канонический файл: ' + JSON.stringify(writes));
});
