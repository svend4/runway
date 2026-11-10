// v0.test.mjs — FP-10: страница-калькулятор v0 (demo/v0.html, v0.mjs, i18n/v0.mjs), REQ-180, IDEA-96, ADR-015.
// Покрывает: «v0 = G-001» — на входных данных, эквивалентных G-001, тот же вердикт (FRAGILE для покупки 300 € на 2026-10-12), минимум (635,00 / 410,00 €), самая ранняя
// дата (20 ноября) и максимум (435,00 / 210,00 €), а также все восемь значений golden-g001.json и ряды движка (побайтно как у data/g001.json); числа 635/410 воспроизводятся
// только после ввода резервов (без них — «без учёта резервов», W_NO_RESERVES); пределы 12 платежей и 3 поступлений проверяются и объясняются (форма и файл); состояние — файл JSON
// (рабочая область runway-journal/1 или файл-журнал), круг «сохранить → открыть» без потерь; страница автономна (нет мастера, метрик, хранилища и сети), CSP, RU и EN, a11y.
// DOM подменён заглушкой; сервер поднимается на время одного запроса и сразу останавливается. Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

class FakeNode {
  constructor(tag) {
    this.nodeType = 1; this.tagName = tag; this.attrs = {}; this.children = []; this.listeners = {}; this.className = ''; this._text = ''; this._value = ''; this._sel = null;
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
  append(...kids) { for (const k of kids) this.children.push(k); this._text = ''; }
  replaceChildren(...kids) { this.children = []; this._text = ''; this.append(...kids); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  click() { this.clicked = (this.clicked ?? 0) + 1; }
  remove() {}
  focus() { this.focused = true; }
  walk(fn) { fn(this); for (const c of this.children) if (c.nodeType === 1) c.walk(fn); }
}
const REG = new Map();
for (const id of ['main', 'v0-lang-ru', 'v0-lang-en', 'v0-title-bar']) REG.set(id, new FakeNode(id === 'main' ? 'main' : 'div'));
globalThis.document = {
  createElement: (t) => new FakeNode(t), createElementNS: (_n, t) => new FakeNode(t), createTextNode: (data) => ({ nodeType: 3, data }),
  getElementById: (id) => REG.get(id) ?? null, documentElement: new FakeNode('html'), head: new FakeNode('head'), body: new FakeNode('body'), title: '',
};
Object.defineProperty(globalThis, 'navigator', { value: { language: 'ru-RU' }, configurable: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.resolve(HERE, '..');
const DEMO = path.join(PROTO, 'demo');
const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);
const V0 = await imp('demo', 'v0.mjs');
const E = await imp('engine', 'index.mjs');
const IDS = await imp('demo', 'ids.mjs');
const TOOLS = await imp('engine', 'tools.mjs');
const I18N = await imp('demo', 'i18n.mjs');
const BRIDGE = await imp('demo', 'ws_bridge.mjs');
const CATALOG = (await imp('demo', 'i18n', 'v0.mjs')).default;
const SERVE = await imp('serve.mjs');
const VOCAB = JSON.parse(fs.readFileSync(path.join(PROTO, 'engine', 'vocab.json'), 'utf8'));
const GOLDEN = JSON.parse(fs.readFileSync(path.join(PROTO, 'data', 'golden-g001.json'), 'utf8'));
const G = JSON.parse(fs.readFileSync(path.join(PROTO, 'data', 'g001.json'), 'utf8'));
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const by_id = (root, id) => find_all(root, (n) => n.attrs.id === id)[0];
const NB = (s) => s.replace(/[  ]/g, ' ');

const ENV = { cur: 'EUR', lang: 'ru', as_of: '2026-10-04' };

/** Форма v0, эквивалентная G-001: остаток, четыре регулярных платежа, налоговый платёж из конверта, выплата 5 ноября с задержкой 14 дней, два резерва; горизонт 57 дней. */
function g001_form({ with_reserves = true, horizon = 57 } = {}) {
  let f = { ...V0.empty_form('2026-10-04'), horizon_days: horizon, balance_minor: 400000, buffer_minor: 50000, purchase: { amount_minor: 30000, date: '2026-10-12' } };
  const add = (bucket, parse, t) => {
    const p = parse(t, ENV);
    assert.equal(p.ok, true, JSON.stringify(p.error));
    const r = V0.add_item(f, bucket, p.value);
    assert.equal(r.ok, true, JSON.stringify(r.error));
    f = r.form;
  };
  add('payments', V0.parse_payment, { name: 'Аренда', amount: '900', freq: 'M', date: '2026-10-25', weekend: 'next', kind: 'obligation' });
  add('payments', V0.parse_payment, { name: 'ЖКХ', amount: '120', freq: 'M', date: '2026-10-25', weekend: 'next', kind: 'obligation' });
  add('payments', V0.parse_payment, { name: 'Связь', amount: '25', freq: 'M', date: '2026-10-09', weekend: 'next', kind: 'obligation' });
  add('payments', V0.parse_payment, { name: 'Продукты', amount: '100', freq: 'W', date: '2026-10-10', weekend: 'keep', kind: 'estimate' });
  add('payments', V0.parse_payment, { name: 'Налоговый платёж', amount: '500', freq: 'once', date: '2026-10-23', weekend: 'next', kind: 'obligation', from_reserve: with_reserves });
  add('incomes', V0.parse_income, { name: 'Выплата за часы', amount: '2790', freq: 'once', date: '2026-11-05', delay: '14' });
  if (with_reserves) {
    add('reserves', V0.parse_reserve, { kind: 'tax', name: 'Налоговый конверт', funded: '1500', rate: '20' });
    add('reserves', V0.parse_reserve, { kind: 'sinking', name: 'Годовая страховка', funded: '0', target: '600', due: '2027-03-15' });
  }
  return f;
}

const answer_of = (ws, lang = 'ru') => V0.purchase_answer(ws, { amount_minor: 30000, date: '2026-10-12' }, lang);

// ── REQ-180: v0 = G-001 ─────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-180 TST-04 v0 на входных данных, эквивалентных G-001, даёт те же вердикт, минимум, раннюю дату и максимум: FRAGILE, 635,00 / 410,00 €, 20 ноября, 435,00 / 210,00 €', () => {
  const built = V0.form_to_ws(g001_form());
  assert.equal(built.ok, true, JSON.stringify(built.error));
  const a = answer_of(built.ws);
  assert.equal(a.ok, true);
  assert.equal(a.kind, 'ok');
  assert.equal(a.verified, true, 'числа ответа проверены верификатором');
  const v = a.view;
  assert.equal(v.verdict, 'FRAGILE');
  assert.deepEqual(v.by_mode.plan, { m_after: 63500, at: '2026-11-01', margin: 13500 });
  assert.deepEqual(v.by_mode.worse, { m_after: 41000, at: '2026-11-14', margin: -9000 });
  assert.deepEqual(v.earliest, { plan: '2026-10-04', worse: '2026-11-20' });
  assert.deepEqual(v.s_max, { plan: 43500, worse: 21000 });
  assert.equal(v.buffer, 50000);
  assert.deepEqual(v.warnings, [], 'резервы введены: предупреждения «без учёта резервов» нет');
  const t = NB(a.text);
  for (const frag of ['635,00 €', '1 ноября', '410,00 €', '14 ноября', 'ниже буфера 500,00 €', 'хрупко', '20 ноября']) assert.ok(t.includes(frag), frag + ' ← ' + t);
  // ответ на английском — та же математика
  const en = answer_of(built.ws, 'en');
  assert.equal(en.view.verdict, 'FRAGILE');
  assert.ok(NB(en.text).includes('€635.00') && NB(en.text).includes('€410.00') && en.text.includes('November 20'), en.text);
  // и тем же ответом, что у основного приложения по файлу G-001
  const ref = V0.purchase_answer(G, { amount_minor: 30000, date: '2026-10-12' }, 'ru');
  assert.equal(a.text, ref.text, 'побуквенно тот же ответ, что на data/g001.json');
  assert.deepEqual(a.view, ref.view);
});

test('REQ-180 TST-01 TST-02 v0 воспроизводит восемь значений golden-g001.json и ряды движка (остаток, свободные, резервы) побайтно как G-001', () => {
  const v0 = TOOLS.make_tool_ctx(V0.form_to_ws(g001_form()).ws, { as_of: '2026-10-04' }, { locale: 'ru' });
  const g = TOOLS.make_tool_ctx(G, { as_of: G.as_of }, { locale: 'ru' });
  for (const mode of ['plan', 'worse']) for (const key of ['close', 'trough', 'free', 'reserve_close']) {
    assert.deepEqual(v0.series[mode][key], g.series[mode][key], `${mode}.${key}`);
  }
  const first_min = (xs, from) => { let k = 0; for (let i = 1; i < xs.length; i++) if (xs[i] < xs[k]) k = i; return { amount_minor: xs[k], date: E.format_date(from + k) }; };
  const got = {
    opening: v0.series.plan.opening_minor,
    end_close: [v0.series.plan.close.at(-1), v0.series.worse.close.at(-1)],
    min_trough_plan: first_min(v0.series.plan.trough, v0.series.plan.from),
    min_trough_worse: first_min(v0.series.worse.trough, v0.series.worse.from),
    min_free_plan: first_min(v0.series.plan.free, v0.series.plan.from),
    min_free_worse: first_min(v0.series.worse.free, v0.series.worse.from),
    reserve_close_end: v0.series.plan.reserve_close.at(-1),
    treadmill_verdict: answer_of(V0.form_to_ws(g001_form()).ws).view.verdict,
  };
  assert.equal(GOLDEN.values.length, 8);
  for (const row of GOLDEN.values) {
    const x = got[row.key];
    if (row.kind === 'money_both') assert.deepEqual(x, [row.expected, row.expected], row.id);
    else assert.deepEqual(x, row.expected, row.id);
  }
});

test('REQ-180 C-065 числа 635,00 и 410,00 € воспроизводятся только после ввода резервов; без них ответ «без учёта резервов» (W_NO_RESERVES) и другие числа', () => {
  const bare = V0.form_to_ws(g001_form({ with_reserves: false })).ws;
  const a = answer_of(bare);
  assert.equal(a.ok, true);
  assert.ok(a.view.warnings.includes('W_NO_RESERVES'));
  assert.notEqual(a.view.by_mode.plan.m_after, 63500, 'без резервов минимум другой');
  assert.notEqual(a.view.by_mode.worse.m_after, 41000);
  assert.notEqual(a.view.verdict, 'FRAGILE');
  // только налоговый конверт без накопления: уже есть резервы — предупреждения нет, но числа ещё не канон
  const f = g001_form({ with_reserves: false });
  const tax = V0.parse_reserve({ kind: 'tax', name: 'Конверт', funded: '1500', rate: '20' }, ENV);
  const only_tax = V0.add_item(f, 'reserves', tax.value).form;
  const b = answer_of(V0.form_to_ws(only_tax).ws);
  assert.ok(!b.view.warnings.includes('W_NO_RESERVES'));
  assert.notDeepEqual(b.view.by_mode, answer_of(V0.form_to_ws(g001_form()).ws).view.by_mode);
});

test('REQ-180 файл G-001, открытый в v0 (рабочая область и файл-журнал), даёт тот же ответ, что форма; созданный не в v0 файл показан сводкой', () => {
  const ws_text = JSON.stringify(G);
  const r = V0.read_state(ws_text);
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'foreign');
  assert.deepEqual(r.limits.counts, { payments: 4, incomes: 1, reserves: 2 });
  assert.deepEqual(r.limits.violations, []);
  const from_file = V0.purchase_answer(r.ws, { amount_minor: 30000, date: '2026-10-12' }, 'ru');
  const from_form = answer_of(V0.form_to_ws(g001_form()).ws);
  assert.equal(from_file.text, from_form.text);
  assert.deepEqual(from_file.view, from_form.view);
  // файл-журнал (runway-journal/1 с записями), как скачивает основное приложение
  const journal = BRIDGE.ws_to_journal(G);
  const j = V0.read_state(journal);
  assert.equal(j.ok, true, JSON.stringify(j));
  assert.equal(j.kind, 'foreign');
  assert.deepEqual(V0.purchase_answer(j.ws, { amount_minor: 30000, date: '2026-10-12' }, 'ru').view, from_form.view);
});

test('REQ-180 REQ-091 состояние — файл JSON: «сохранить → открыть» возвращает форму и ответ без потерь; формат — рабочая область runway-journal/1 с формой в поле v0_form; хэш входов расчёта тот же', () => {
  const form = g001_form();
  const built = V0.form_to_ws(form);
  const text = V0.state_text(built.ws);
  const ws = JSON.parse(text);
  assert.equal(ws.format, 'runway-journal/1');
  assert.deepEqual(ws[V0.FORM_KEY], form, 'форма лежит в файле как есть');
  assert.equal(V0.FORM_KEY, 'v0_form');
  const back = V0.read_state(text);
  assert.equal(back.ok, true);
  assert.equal(back.kind, 'v0');
  assert.deepEqual(back.form, form);
  assert.equal(TOOLS.make_tool_ctx(back.ws, { as_of: back.ws.as_of }, {}).inputs_hash, TOOLS.make_tool_ctx(built.ws, { as_of: built.ws.as_of }, {}).inputs_hash);
  assert.deepEqual(answer_of(back.ws).view, answer_of(built.ws).view);
  // файл-журнал, сделанный из файла v0, читается обратно с формой
  const j = V0.read_state(BRIDGE.ws_to_journal(built.ws));
  assert.equal(j.ok, true);
  assert.equal(j.kind, 'v0');
  assert.deepEqual(j.form, form);
  // испорченное: не JSON, не рабочая область, слишком большой, чужая структура — отказ без исключений и без изменений
  for (const [bad, reason] of [['{', 'bad_json'], ['[]', 'bad_shape'], ['{"x":1}', 'bad_shape'], ['null', 'bad_shape'], ['"строка"', 'bad_shape'], [JSON.stringify({ as_of: '2026-13-40' }), 'bad_shape']]) {
    const r = V0.read_state(bad);
    assert.equal(r.ok, false, bad);
    assert.equal(r.reason, reason, bad);
  }
  assert.deepEqual(V0.read_state('{}', V0.MAX_FILE_BYTES + 1), { ok: false, reason: 'too_big' }, 'размер проверяется до разбора');
  // форма, испорченная в файле, не ломает открытие: остаётся расчёт по самой рабочей области
  const tampered = JSON.parse(text);
  tampered[V0.FORM_KEY].payments[0].amount_minor = 'много';
  const t = V0.read_state(JSON.stringify(tampered));
  assert.equal(t.ok, true);
  assert.equal(t.kind, 'foreign');
});

// ── REQ-180: пределы ────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-180 пределы v0: до 12 повторяющихся платежей, до 3 поступлений, до 2 резервов (по одному каждого вида); сверх предела — отказ с объяснением на RU и EN, форма не меняется', () => {
  assert.deepEqual({ ...V0.V0_LIMITS }, { payments: 12, incomes: 3, reserves: 2 });
  let f = V0.empty_form('2026-10-04');
  const pay = (i) => V0.parse_payment({ name: 'Платёж ' + i, amount: String(10 + i), freq: 'M', date: '2026-10-' + String(5 + (i % 20)).padStart(2, '0'), weekend: 'keep', kind: 'obligation' }, ENV).value;
  for (let i = 1; i <= 12; i++) { const r = V0.add_item(f, 'payments', pay(i)); assert.equal(r.ok, true, 'платёж ' + i); f = r.form; }
  assert.equal(f.payments.length, 12);
  const over = V0.add_item(f, 'payments', pay(13));
  assert.equal(over.ok, false);
  assert.deepEqual({ code: over.error.code, field: over.error.ctx.field, reason: over.error.ctx.reason, limit: over.error.ctx.limit }, { code: 'V0_LIMIT', field: 'payments', reason: 'limit', limit: 12 });
  assert.match(V0.error_text('ru', over.error), /Предел v0: не больше 12 повторяющихся платежей\..*основном приложении/);
  assert.match(V0.error_text('en', over.error), /v0 limit: at most 12 recurring payments\..*main app/);
  assert.equal(f.payments.length, 12, 'форма не изменилась');
  const inc = (i) => V0.parse_income({ name: 'Доход ' + i, amount: '100', freq: 'M', date: '2026-10-2' + i, delay: '3' }, ENV).value;
  for (let i = 1; i <= 3; i++) f = V0.add_item(f, 'incomes', inc(i)).form;
  const over_inc = V0.add_item(f, 'incomes', inc(4 % 10));
  assert.equal(over_inc.ok, false);
  assert.equal(over_inc.error.ctx.limit, 3);
  assert.match(V0.error_text('ru', over_inc.error), /не больше 3 поступлений/);
  assert.match(V0.error_text('en', over_inc.error), /at most 3 receipts/);
  const tax = V0.parse_reserve({ kind: 'tax', name: 'К', funded: '0', rate: '10' }, ENV).value;
  const sink = V0.parse_reserve({ kind: 'sinking', name: 'С', funded: '0', target: '100', due: '2027-01-01' }, ENV).value;
  f = V0.add_item(f, 'reserves', tax).form;
  const dup = V0.add_item(f, 'reserves', tax);
  assert.equal(dup.ok, false);
  assert.equal(dup.error.ctx.reason, 'duplicate_kind');
  assert.match(V0.error_text('ru', dup.error), /по одному каждого вида/);
  f = V0.add_item(f, 'reserves', sink).form;
  const third = V0.add_item(f, 'reserves', { ...sink, kind: 'sinking' });
  assert.equal(third.ok, false);
  assert.match(V0.error_text('ru', third.error), /не больше 2 резервов/);
  // убрать строку можно, предел снова не достигнут
  const less = V0.remove_item(f, 'payments', 0);
  assert.equal(less.payments.length, 11);
  assert.equal(V0.add_item(less, 'payments', pay(13)).ok, true);
  assert.equal(V0.remove_item(f, 'payments', 99), f, 'несуществующий номер — форма та же');
  assert.equal(V0.remove_item(f, 'чужое', 0), f);
  // форма, у которой пределы нарушены в обход add_item (испорченный файл), не собирается в рабочую область
  const tampered = { ...f, payments: [...f.payments, ...f.payments] };
  const t = V0.form_to_ws(tampered);
  assert.equal(t.ok, false);
  assert.equal(t.error.code, 'V0_LIMIT');
  assert.deepEqual(V0.form_counts(f), { payments: 12, incomes: 3, reserves: 2 });
});

test('REQ-180 пределы в файле: 12 платежей и 3 поступления принимаются, 13-й платёж или 4-е поступление — файл отвергнут с объяснением, данные не меняются; потоки часов считаются поступлениями', () => {
  const mk = (n_pay, n_inc, n_stream = 0) => {
    const ws = JSON.parse(JSON.stringify(G));
    const base = ws.rules[0];
    ws.rules = [];
    for (let i = 0; i < n_pay; i++) ws.rules.push({ ...base, rule_id: 'P' + i, name: 'П' + i, amount: { exp_minor: -1000 - i } });
    for (let i = 0; i < n_inc; i++) ws.rules.push({ ...base, rule_id: 'I' + i, name: 'Д' + i, kind: 'income', amount: { exp_minor: 5000 + i }, is_obligation: false });
    ws.streams = n_stream === 0 ? [] : G.streams.slice(0, 1).map((s, i) => ({ ...s, stream_id: 'S' + i }));
    ws.tax_rules = []; ws.reserves = []; ws.plans = [];
    return JSON.stringify(ws);
  };
  const ok = V0.read_state(mk(12, 3));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.limits.counts, { payments: 12, incomes: 3, reserves: 0 });
  const many_pay = V0.read_state(mk(13, 1));
  assert.equal(many_pay.ok, false);
  assert.equal(many_pay.reason, 'limits');
  assert.deepEqual(many_pay.limits.violations, [{ bucket: 'payments', count: 13, limit: 12 }]);
  const many_inc = V0.read_state(mk(2, 4));
  assert.equal(many_inc.reason, 'limits');
  assert.deepEqual(many_inc.limits.violations, [{ bucket: 'incomes', count: 4, limit: 3 }]);
  const stream_counts = V0.read_state(mk(2, 3, 1));
  assert.equal(stream_counts.reason, 'limits', '3 поступления-правила + поток часов = 4 поступления');
  assert.deepEqual(V0.ws_limits(JSON.parse(mk(2, 3, 1))).counts, { payments: 2, incomes: 4, reserves: 0 });
});

// ── поля и ошибки ───────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-017 REQ-180 ошибки полей v0: код канона и причина; введённое не повторяется ни в коде, ни в тексте (RU и EN); даты — только с даты расчёта, не дальше 800 дней', () => {
  const good_pay = { name: 'Аренда', amount: '900', freq: 'M', date: '2026-10-25', weekend: 'keep', kind: 'obligation' };
  const good_inc = { name: 'Клиент', amount: '2000', freq: 'M', date: '2026-10-20', delay: '' };
  const good_res = { kind: 'tax', name: 'Конверт', funded: '0', rate: '20' };
  const cases = [
    [V0.parse_payment, { ...good_pay, name: '' }, 'E_SCHEMA', 'name', 'empty'],
    [V0.parse_payment, { ...good_pay, name: 'я'.repeat(121) }, 'E_SCHEMA', 'name', 'too_long'],
    [V0.parse_payment, { ...good_pay, amount: 'сорок' }, 'E_NOT_INTEGER', 'amount', 'bad_number'],
    [V0.parse_payment, { ...good_pay, amount: '0' }, 'E_SCHEMA', 'amount', 'zero'],
    [V0.parse_payment, { ...good_pay, amount: '-1' }, 'E_SCHEMA', 'amount', 'negative'],
    [V0.parse_payment, { ...good_pay, amount: '9'.repeat(30) }, 'E_OVERFLOW', 'amount', 'too_big'],
    [V0.parse_payment, { ...good_pay, freq: 'иногда' }, 'E_SCHEMA', 'freq', 'not_in_list'],
    [V0.parse_payment, { ...good_pay, weekend: 'prev' }, 'E_SCHEMA', 'weekend', 'not_in_list'],
    [V0.parse_payment, { ...good_pay, kind: 'другое' }, 'E_SCHEMA', 'kind', 'not_in_list'],
    [V0.parse_payment, { ...good_pay, date: '' }, 'E_BAD_DATE', 'date', 'empty'],
    [V0.parse_payment, { ...good_pay, date: '2026-02-30' }, 'E_BAD_DATE', 'date', 'bad_date'],
    [V0.parse_payment, { ...good_pay, date: '2026-10-03' }, 'E_BAD_DATE', 'date', 'date_past'],
    [V0.parse_payment, { ...good_pay, date: '2029-10-04' }, 'E_BAD_DATE', 'date', 'date_far'],
    [V0.parse_income, { ...good_inc, delay: '999' }, 'E_SCHEMA', 'delay', 'range'],
    [V0.parse_income, { ...good_inc, delay: 'неделя' }, 'E_NOT_INTEGER', 'delay', 'bad_number'],
    [V0.parse_income, { ...good_inc, freq: 'weekly' }, 'E_SCHEMA', 'freq', 'not_in_list'],
    [V0.parse_reserve, { ...good_res, kind: 'иной' }, 'E_SCHEMA', 'kind', 'not_in_list'],
    [V0.parse_reserve, { ...good_res, rate: '' }, 'E_NOT_INTEGER', 'rate', 'empty'],
    [V0.parse_reserve, { ...good_res, rate: '150' }, 'E_SCHEMA', 'rate', 'range'],
    [V0.parse_reserve, { ...good_res, funded: 'x' }, 'E_NOT_INTEGER', 'funded', 'bad_number'],
    [V0.parse_reserve, { kind: 'sinking', name: 'С', funded: '0', target: '100', due: '2026-10-04' }, 'E_BAD_DATE', 'due', 'date_past'],
    [V0.parse_reserve, { kind: 'sinking', name: 'С', funded: '0', target: '0', due: '2027-01-01' }, 'E_SCHEMA', 'target', 'zero'],
    [V0.parse_purchase, { amount: '', date: '2026-10-12' }, 'E_NOT_INTEGER', 'amount', 'empty'],
    [V0.parse_purchase, { amount: '300', date: '2026-10-03' }, 'E_BAD_DATE', 'date', 'date_past'],
    [V0.parse_top, { as_of: '', balance: '1', buffer: '', horizon: '57' }, 'E_BAD_DATE', 'as_of', 'empty'],
    [V0.parse_top, { as_of: '2026-10-04', balance: '', buffer: '', horizon: '57' }, 'E_NOT_INTEGER', 'balance', 'empty'],
    [V0.parse_top, { as_of: '2026-10-04', balance: '1', buffer: 'x', horizon: '57' }, 'E_NOT_INTEGER', 'buffer', 'bad_number'],
    [V0.parse_top, { as_of: '2026-10-04', balance: '1', buffer: '', horizon: '5' }, 'E_SCHEMA', 'horizon', 'range'],
    [V0.parse_top, { as_of: '2026-10-04', balance: '1', buffer: '', horizon: '400' }, 'E_SCHEMA', 'horizon', 'range'],
  ];
  for (const [fn, texts, code, field, reason] of cases) {
    const r = fn(texts, ENV);
    assert.equal(r.ok, false, JSON.stringify(texts));
    assert.deepEqual({ code: r.error.code, field: r.error.ctx.field, reason: r.error.ctx.reason }, { code, field, reason }, JSON.stringify(texts));
    for (const lang of ['ru', 'en']) {
      const text = V0.error_text(lang, r.error);
      assert.ok(text.includes(code), `${lang}: код ${code}: ${text}`);
      assert.ok(!/\{[a-z_]+\}/.test(text), 'нет неподставленных полей: ' + text);
      for (const v of Object.values(texts).filter((x) => typeof x === 'string' && x.length >= 3)) assert.ok(!text.includes(v), `${lang}: текст не повторяет «${v}»`);
      if (lang === 'en') assert.ok(!/[А-Яа-яЁё]/.test(text), text);
    }
  }
  // успешные разборы: суммы без float, нулевые остаток и буфер допустимы, «Y» и «once»
  assert.deepEqual(V0.parse_top({ as_of: '2026-10-04', balance: '-50', buffer: '0', horizon: '57' }, ENV).value, { as_of: '2026-10-04', balance_minor: -5000, buffer_minor: 0, horizon_days: 57 });
  assert.equal(V0.parse_payment({ ...good_pay, freq: 'once' }, ENV).value.freq, 'once');
  assert.equal(V0.parse_income({ ...good_inc, delay: '14' }, ENV).value.delay_days, 14);
  assert.equal(V0.parse_income({ ...good_inc, delay: '' }, ENV).value.delay_days, null);
  assert.equal(V0.parse_reserve({ kind: 'tax', name: 'К', funded: '10,50', rate: '12,5' }, ENV).value.rate_bp, 1250);
  assert.equal(V0.parse_payment({ ...good_pay, amount: '1 234,50' }, ENV).value.amount_minor, 123450);
  assert.equal(V0.parse_payment({ ...good_pay, amount: '1,234.50' }, { ...ENV, lang: 'en' }).value.amount_minor, 123450);
});

test('REQ-180 нет остатка → «данных мало» с причиной вместо вердикта; нет буфера — no_buffer; ответ не придумывает числа', () => {
  const no_balance = V0.form_to_ws({ ...g001_form(), balance_minor: null });
  assert.equal(no_balance.ok, true);
  const a = answer_of(no_balance.ws);
  assert.equal(a.ok, true);
  assert.equal(a.kind, 'insufficient_data');
  assert.equal(a.view.verdict, undefined);
  const no_buffer = answer_of(V0.form_to_ws({ ...g001_form(), buffer_minor: null }).ws);
  assert.equal(no_buffer.kind, 'insufficient_data');
  assert.equal(no_buffer.view.reason, 'no_buffer');
  const empty = answer_of(V0.form_to_ws(V0.empty_form('2026-10-04')).ws);
  assert.equal(empty.kind, 'insufficient_data');
  assert.ok(!/\d{2,}/.test(empty.view.verdict ?? ''), 'вердикта нет');
});

// ── страница: DOM ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Часы страницы в тестах (FP-50, RISK-22): 4 октября 2026, 09:00 UTC, пояс 0 — «сегодня» страницы = ENV.as_of = 2026-10-04 (дата G-001).
 * Тесты не зависят от часов машины. Даты платежей, поступлений и покупок в тексте тестов — литералы, согласованные с 4 октября 2026:
 * если меняются эти часы, литералы меняются вместе с ними.
 */
const PAGE_CLOCK = Object.freeze({ now_ms: () => Date.UTC(2026, 9, 4, 9, 0), tz_offset_min: () => 0 });

function fresh_page() {
  const main = REG.get('main');
  main.replaceChildren();
  for (const id of ['v0-lang-ru', 'v0-lang-en']) REG.get(id).listeners = {};
  const page = V0.boot_v0(PAGE_CLOCK);
  return { page, root: () => REG.get('main') };
}
const fill = (root, values) => { for (const [id, v] of Object.entries(values)) { const n = by_id(root, id); assert.ok(n !== undefined, 'нет поля ' + id); n.value = v; } };
const send = (root, form_id) => { const f = by_id(root, form_id); assert.ok(f !== undefined, 'нет формы ' + form_id); return f.listeners.submit[0]({ preventDefault() {} }); };

test('REQ-180 FP-50 страница v0 берёт «сегодня» из порта часов: с часами 4 октября 2026 форма начинается с этой даты; местная дата пояса, а не UTC; без порта — часы устройства', () => {
  const { page } = fresh_page();
  assert.equal(page.form.as_of, '2026-10-04');
  // 12:00 UTC 4 октября в поясе +14 — уже 5 октября по местной дате (UTC-дата другая)
  const east = V0.boot_v0({ now_ms: () => Date.UTC(2026, 9, 4, 12, 0), tz_offset_min: () => 14 * 60 });
  assert.equal(east.form.as_of, '2026-10-05', 'местная дата пояса +14');
  // 03:00 UTC 4 октября в поясе −11 — ещё 3 октября по местной дате
  const west = V0.boot_v0({ now_ms: () => Date.UTC(2026, 9, 4, 3, 0), tz_offset_min: () => -11 * 60 });
  assert.equal(west.form.as_of, '2026-10-03', 'местная дата пояса −11');
  // без порта — часы устройства: та же местная дата, что даёт порт часов (сверка с окном на случай полуночи во время теста)
  const before = IDS.local_today(IDS.clock_ports());
  const device = V0.boot_v0();
  const after = IDS.local_today(IDS.clock_ports());
  assert.ok(device.form.as_of === before || device.form.as_of === after, 'местная дата часов устройства');
});

test('FP-50 D-4: порт страницы без смещения пояса — «сегодня» по часам устройства (местная дата), а не по UTC', () => {
  // момент, где UTC-дата и местная дата устройства различаются: 23:30 UTC на востоке от UTC (местная дата уже следующая), 00:30 UTC на западе (ещё предыдущая)
  const noon = Date.UTC(2026, 9, 4, 12, 0);
  const at = -new Date(noon).getTimezoneOffset() >= 0 ? Date.UTC(2026, 9, 4, 23, 30) : Date.UTC(2026, 9, 4, 0, 30);
  const off = -new Date(at).getTimezoneOffset();
  const want = IDS.local_today({ now_ms: () => at, tz_offset_min: () => off });
  const page = V0.boot_v0({ now_ms: () => at }); // порт без tz_offset_min
  assert.equal(page.form.as_of, want, 'дата порта без смещения — местная дата часов устройства');
});

test('REQ-180 страница v0: форма → результат в живой области; платежи, поступления, резервы добавляются и убираются; предел 12 виден на странице; RU/EN переключаются', () => {
  const { page, root } = fresh_page();
  assert.equal(page.lang, 'ru');
  assert.equal(by_id(root(), 'v0-title').textContent, 'Могу ли я это купить?');
  assert.equal(by_id(root(), 'v0-title').attrs.tabindex, '-1');
  assert.equal(by_id(root(), 'v0-result').attrs['aria-live'], 'polite');
  assert.match(by_id(root(), 'v0-result').textContent, /Введите покупку/);
  // верх формы
  fill(root(), { 'v0-asof': '2026-10-04', 'v0-balance': '4000', 'v0-buffer': '500', 'v0-horizon': '57' });
  assert.equal(send(root(), 'v0-form-top').ok, true);
  assert.equal(page.form.balance_minor, 400000);
  assert.equal(page.form.as_of, '2026-10-04');
  // платежи
  const add_pay = (name, amount, date, extra = {}) => {
    fill(root(), { 'v0-pay-name': name, 'v0-pay-amount': amount, 'v0-pay-date': date, 'v0-pay-freq': extra.freq ?? 'M', 'v0-pay-weekend': extra.weekend ?? 'next', 'v0-pay-kind': extra.kind ?? 'obligation' });
    return send(root(), 'v0-form-payments');
  };
  assert.equal(add_pay('Аренда', '900', '2026-10-25').ok, true);
  assert.equal(add_pay('ЖКХ', '120', '2026-10-25').ok, true);
  assert.equal(add_pay('Связь', '25', '2026-10-09').ok, true);
  assert.equal(add_pay('Продукты', '100', '2026-10-10', { freq: 'W', weekend: 'keep', kind: 'estimate' }).ok, true);
  assert.equal(page.form.payments.length, 4);
  assert.match(by_id(root(), 'v0-payments-title').textContent, /Повторяющиеся платежи \(4 из 12\)/);
  // поступление и покупка
  fill(root(), { 'v0-inc-name': 'Выплата', 'v0-inc-amount': '2790', 'v0-inc-freq': 'once', 'v0-inc-date': '2026-11-05', 'v0-inc-delay': '14' });
  assert.equal(send(root(), 'v0-form-incomes').ok, true);
  fill(root(), { 'v0-buy-amount': '300', 'v0-buy-date': '2026-10-12' });
  assert.equal(send(root(), 'v0-form-buy').ok, true);
  const res = by_id(root(), 'v0-result');
  assert.ok(res.textContent.includes('Вердикт: '), res.textContent.slice(0, 200));
  assert.ok(NB(res.textContent).includes('без учёта резервов'.replace('без', 'Без')) || res.textContent.includes('Без учёта резервов'), 'подпись «без учёта резервов»');
  assert.equal(find_all(res, (n) => n.tagName === 'span' && /verdict-/.test(n.className)).length, 1, 'вердикт — слово, а не цвет');
  // резервы переводят ответ на канон
  fill(root(), { 'v0-res-kind': 'tax', 'v0-res-name': 'Налоговый конверт', 'v0-res-funded': '1500', 'v0-res-rate': '20' });
  assert.equal(send(root(), 'v0-form-reserves').ok, true);
  fill(root(), { 'v0-res-kind': 'sinking', 'v0-res-name': 'Страховка', 'v0-res-funded': '0', 'v0-res-rate': '', 'v0-res-target': '600', 'v0-res-due': '2027-03-15' });
  assert.equal(send(root(), 'v0-form-reserves').ok, true);
  assert.equal(page.form.reserves.length, 2);
  // налоговый платёж из конверта — отдельный флажок появился, когда есть налоговый резерв
  assert.ok(by_id(root(), 'v0-pay-reserve') !== undefined);
  fill(root(), { 'v0-pay-name': 'Налоговый платёж', 'v0-pay-amount': '500', 'v0-pay-date': '2026-10-23', 'v0-pay-freq': 'once', 'v0-pay-weekend': 'next', 'v0-pay-kind': 'obligation' });
  by_id(root(), 'v0-pay-reserve').checked = true;
  assert.equal(send(root(), 'v0-form-payments').ok, true);
  assert.equal(page.form.payments.at(-1).from_reserve, true);
  const text = NB(by_id(root(), 'v0-result').textContent);
  for (const frag of ['хрупко', '635,00 €', '410,00 €', '20 ноября', '435,00 €', '210,00 €']) assert.ok(text.includes(frag), frag + ' ← ' + text.slice(0, 500));
  assert.ok(!text.includes('Без учёта резервов'), 'резервы введены — подписи «без учёта резервов» нет');
  // убрать платёж
  const rm = find_all(root(), (n) => n.attrs['data-bucket'] === 'payments' && n.attrs['data-index'] === '0')[0];
  assert.match(rm.attrs['aria-label'], /^Убрать: Аренда/);
  rm.listeners.click[0]();
  assert.equal(page.form.payments.length, 4);
  // предел 12: после 12-го платежа на странице объяснение
  for (let i = 0; i < 8; i++) assert.equal(add_pay('Платёж ' + i, '10', '2026-10-2' + (i % 10)).ok, true);
  assert.equal(page.form.payments.length, 12);
  assert.match(by_id(root(), 'v0-payments-title').textContent, /\(12 из 12\)/);
  assert.ok(find_all(root(), (n) => n.className === 'banner' && /Предел v0: не больше 12 повторяющихся платежей/.test(n.textContent)).length === 1, 'предел объяснён на странице');
  const refused = add_pay('Лишний', '10', '2026-10-20');
  assert.equal(refused.ok, false);
  assert.equal(page.form.payments.length, 12);
  assert.match(find_all(by_id(root(), 'v0-form-payments'), (n) => n.attrs.role === 'status')[0].textContent, /Предел v0: не больше 12/);
  // язык
  REG.get('v0-lang-en').listeners.click[0]();
  assert.equal(page.lang, 'en');
  assert.equal(by_id(root(), 'v0-title').textContent, 'Can I buy this?');
  assert.ok(!/[А-Яа-яЁё]/.test(root().textContent.replace(/Платёж \d|Аренда|ЖКХ|Связь|Продукты|Выплата|Налоговый конверт|Страховка|Налоговый платёж/g, '')), 'EN-страница без русских слов (кроме названий, введённых пользователем)');
  assert.equal(REG.get('v0-lang-en').attrs['aria-pressed'], 'true');
  assert.equal(REG.get('v0-lang-ru').attrs['aria-pressed'], 'false');
  assert.equal(document.documentElement.lang, 'en');
});

test('REQ-180 TST-58 a11y страницы v0: у каждого поля подпись и связанные подсказка и место для ошибки, ошибки role=alert, ошибка у поля с aria-invalid и фокусом, вердикт — слово', () => {
  const { page, root } = fresh_page();
  const inputs = find_all(root(), (n) => (n.tagName === 'input' || n.tagName === 'select') && n.attrs.id !== undefined && n.attrs.type !== 'file');
  assert.ok(inputs.length >= 20);
  for (const inp of inputs) {
    if (inp.attrs.type === 'checkbox') continue;
    assert.equal(find_all(root(), (n) => n.tagName === 'label' && n.attrs.for === inp.attrs.id).length, 1, 'подпись ' + inp.attrs.id);
    for (const ref of String(inp.attrs['aria-describedby'] ?? '').split(' ').filter(Boolean)) assert.ok(by_id(root(), ref) !== undefined, `${inp.attrs.id} → ${ref}`);
    assert.equal(by_id(root(), inp.attrs.id + '-err').attrs.role, 'alert');
  }
  assert.ok(find_all(root(), (n) => n.tagName === 'input' && n.attrs.type === 'file').every((f) => find_all(root(), (n) => n.tagName === 'label' && n.attrs.for === f.attrs.id).length === 1), 'у выбора файла есть подпись');
  fill(root(), { 'v0-pay-name': 'Аренда', 'v0-pay-amount': 'сорок-секрет', 'v0-pay-date': '2026-10-25' });
  const r = send(root(), 'v0-form-payments');
  assert.equal(r.ok, false);
  const err = by_id(root(), 'v0-pay-amount-err');
  assert.match(err.textContent, /^Сумма: не похоже на число \(E_NOT_INTEGER\)/);
  assert.ok(!err.textContent.includes('секрет'));
  assert.equal(by_id(root(), 'v0-pay-amount').attrs['aria-invalid'], 'true');
  assert.equal(by_id(root(), 'v0-pay-amount').focused, true);
  assert.equal(page.form.payments.length, 0, 'при отказе форма не меняется');
  for (const n of find_all(root(), () => true)) {
    assert.equal(n.attrs.style, undefined);
    for (const k of Object.keys(n.attrs)) assert.ok(!/^on/i.test(k), k);
  }
});

test('REQ-180 TST-59 файл состояния на странице: «Сохранить» отдаёт рабочую область как файл (Blob), «Открыть» читает файл v0 и чужой файл (G-001), слишком большой, испорченный и с превышением пределов отвергает с объяснением', async () => {
  const blobs = [];
  const real = { Blob: globalThis.Blob, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  globalThis.Blob = class { constructor(parts, opts) { this.text = parts.join(''); this.type = opts?.type; blobs.push(this); } };
  URL.createObjectURL = () => 'blob:v0/' + blobs.length;
  URL.revokeObjectURL = () => {};
  try {
    const { page, root } = fresh_page();
    page.form = g001_form();
    page.changed();
    by_id(root(), 'v0-save').listeners.click[0]();
    assert.equal(blobs.length, 1);
    assert.equal(blobs[0].type, 'application/json');
    const saved = JSON.parse(blobs[0].text);
    assert.equal(saved.format, 'runway-journal/1');
    assert.deepEqual(saved.v0_form, g001_form());
    assert.match(by_id(root(), 'v0-notice').textContent, /runway-v0\.json подготовлен/);
    // открыть: свежая страница читает файл v0
    const opener = (rt) => async (text, size) => { const input = by_id(rt(), 'v0-file-in'); input.files = [{ size: size ?? text.length, text: async () => text }]; await input.listeners.change[0](); };
    const fresh2 = fresh_page();
    await opener(fresh2.root)(blobs[0].text);
    assert.equal(fresh2.page.form.payments.length, 5);
    assert.equal(fresh2.page.form.reserves.length, 2);
    assert.match(by_id(fresh2.root(), 'v0-notice').textContent, /^Файл открыт\.$/);
    // чужой файл: сводка, формы v0 нет, покупка проверяется
    const f3 = fresh_page();
    await opener(f3.root)(JSON.stringify(G));
    assert.notEqual(f3.page.foreign, null);
    assert.match(by_id(f3.root(), 'v0-notice').textContent, /создан не в v0/);
    assert.match(by_id(f3.root(), 'v0-foreign-title').textContent, /Файл открыт для расчёта/);
    assert.equal(by_id(f3.root(), 'v0-form-payments'), undefined, 'формы платежей для чужого файла нет');
    fill(f3.root(), { 'v0-buy-amount': '300', 'v0-buy-date': '2026-10-12' });
    assert.equal(send(f3.root(), 'v0-form-buy').ok, true);
    const t = NB(by_id(f3.root(), 'v0-result').textContent);
    for (const frag of ['хрупко', '635,00 €', '410,00 €', '20 ноября', '435,00 €', '210,00 €']) assert.ok(t.includes(frag), frag);
    by_id(f3.root(), 'v0-reset').listeners.click[0]();
    assert.equal(f3.page.foreign, null);
    // отказы: не меняют страницу и объясняют
    for (const [text, size, frag] of [['{', undefined, 'не похож на состояние'], ['[]', undefined, 'не похож на состояние'], ['{}', V0.MAX_FILE_BYTES + 1, 'слишком большой']]) {
      const f = fresh_page();
      const form0 = f.page.form;
      const input = by_id(f.root(), 'v0-file-in');
      input.files = [{ size: size ?? text.length, text: async () => text }];
      await input.listeners.change[0]();
      assert.equal(f.page.form, form0, 'данные не изменены');
      assert.ok(by_id(f.root(), 'v0-notice').textContent.includes(frag), by_id(f.root(), 'v0-notice').textContent);
    }
    const too_many = JSON.parse(JSON.stringify(G));
    too_many.rules = Array.from({ length: 13 }, (_, i) => ({ ...G.rules[0], rule_id: 'X' + i }));
    const fm = fresh_page();
    const inp = by_id(fm.root(), 'v0-file-in');
    inp.files = [{ size: 10, text: async () => JSON.stringify(too_many) }];
    await inp.listeners.change[0]();
    assert.match(by_id(fm.root(), 'v0-notice').textContent, /В файле 13 платежей, 1 поступлений и 2 резервов: v0 принимает не больше 12, 3 и 2\. Файл не открыт, данные не изменены/);
  } finally {
    globalThis.Blob = real.Blob; URL.createObjectURL = real.create; URL.revokeObjectURL = real.revoke;
  }
});

// ── автономность и безопасность страницы ────────────────────────────────────────────────────────────────────────────────

test('REQ-180 TST-59 v0.html: CSP только self (script-src, style-src; connect-src none), нет inline-кода и внешних адресов, ссылки только на свои файлы; v0 не зависит от мастера, метрик, хранилища и реестра расширений', () => {
  const html = fs.readFileSync(path.join(DEMO, 'v0.html'), 'utf8');
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1];
  assert.ok(csp, 'есть мета CSP');
  for (const d of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'none'", "base-uri 'none'", "form-action 'none'"]) assert.ok(csp.includes(d), d);
  assert.ok(!/unsafe-inline|unsafe-eval|\*|https?:/.test(csp));
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) { assert.match(m[1], /\bsrc="[^"]+"/); assert.equal(m[2].trim(), ''); }
  assert.ok(!/<style\b/i.test(html) && !/\sstyle\s*=/.test(html) && !/\son[a-z]+\s*=\s*["']/i.test(html));
  assert.ok(!/https?:\/\//.test(html), 'нет внешних адресов');
  const refs = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((m) => m[1]).filter((x) => x !== 'data:,');
  assert.deepEqual(refs.sort(), ['css/v0.css', 'style.css', 'v0.mjs']);
  for (const r of refs) assert.ok(fs.existsSync(path.join(DEMO, r)), r);
  assert.match(html, /<html lang="ru">/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /<main id="main"/);
  assert.match(html, /<a id="v0-skip"/);
  assert.ok(find_all_in_html(html, 'aria-label="Язык / Language"'), 'переключатель языка подписан');
  // автономность: транзитивные импорты v0.mjs не включают приложение, реестр, мастер, метрики, хранилище
  const closure = new Set();
  const walk = (file) => {
    if (closure.has(file)) return;
    closure.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/import\s*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s*from\s*'([^']+)'/g)) walk(path.resolve(path.dirname(file), m[1]));
  };
  walk(path.join(DEMO, 'v0.mjs'));
  const names = [...closure].map((f) => path.relative(PROTO, f).replace(/\\/g, '/'));
  for (const banned of ['demo/app.mjs', 'demo/ext.mjs', 'demo/ext_manifest.mjs', 'demo/wizard.mjs', 'demo/metrics.mjs', 'demo/metrics_view.mjs', 'demo/start_template.mjs', 'demo/pack_fp10.mjs', 'demo/store.mjs', 'demo/store_idb.mjs', 'demo/data_runtime.mjs', 'demo/data_actions.mjs', 'demo/backup.mjs', 'demo/journal_log.mjs', 'demo/log.mjs']) {
    assert.ok(!names.includes(banned), 'v0 не тянет ' + banned + ' (' + names.join(', ') + ')');
  }
  assert.ok(names.includes('demo/i18n/v0.mjs') && names.includes('demo/rule_kit.mjs'));
  const src = fs.readFileSync(path.join(DEMO, 'v0.mjs'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const bad of ['localStorage', 'sessionStorage', 'indexedDB', 'caches.', 'serviceWorker', 'document.cookie', 'fetch(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'EventSource', 'importScripts', 'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'eval(', 'new Function', 'document.write', 'location.hash', 'location.search', 'history.pushState', 'history.replaceState']) {
    assert.ok(!code.includes(bad), 'v0.mjs: ' + bad);
  }
  assert.ok(!/(^|[^.\w])import\(/.test(code), 'нет динамического import()');
  assert.ok(!/\bconsole\s*\./.test(code));
});

function find_all_in_html(html, fragment) { return html.includes(fragment); }

test('REQ-180 v0.html открывается по HTTP: serve.mjs отдаёт страницу, модуль и каталог строк с верными типами и CSP (сервер на время одного запроса)', async () => {
  const server = SERVE.create_server();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })); }).on('error', reject);
  });
  try {
    const page = await get('/demo/v0.html');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /^text\/html/);
    assert.ok(page.body.includes('<script type="module" src="v0.mjs">'));
    const mod = await get('/demo/v0.mjs');
    assert.equal(mod.status, 200);
    assert.match(mod.headers['content-type'], /javascript/);
    for (const f of ['/demo/css/v0.css', '/demo/i18n/v0.mjs', '/demo/rule_kit.mjs', '/demo/style.css']) assert.equal((await get(f)).status, 200, f);
    assert.match(page.headers['content-security-policy'] ?? '', /script-src 'self'/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ── каталог строк ───────────────────────────────────────────────────────────────────────────────────────────────────────

test('TST-56 каталог v0: паритет RU/EN и плейсхолдеров, русские буквы в RU, семейства ключей полны, нет запрещённых формулировок и обещаний времени, налоги — с оговоркой; каждый ключ используется', () => {
  const ru = Object.keys(CATALOG.ru).sort();
  assert.deepEqual(ru, Object.keys(CATALOG.en).sort());
  const ph = (s) => [...s.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const k of ru) {
    assert.ok(k.startsWith('v0.'));
    assert.equal(ph(CATALOG.ru[k]), ph(CATALOG.en[k]), k);
    const letters = CATALOG.ru[k].replace(/\{[A-Za-z0-9_]+\}/g, '').replace(/[^A-Za-zА-Яа-яЁё]/g, '');
    if (letters !== '') assert.match(CATALOG.ru[k], /[А-Яа-яЁё]/, k);
  }
  const need = (prefix, tails) => { for (const t of tails) assert.ok(ru.includes(prefix + t), prefix + t); };
  need('v0.er_', ['empty', 'bad_number', 'zero', 'negative', 'too_big', 'bad_date', 'date_past', 'date_far', 'range', 'too_long', 'not_in_list', 'other']);
  need('v0.f_', ['name', 'amount', 'freq', 'date', 'weekend', 'kind', 'delay', 'funded', 'rate', 'target', 'due', 'balance', 'buffer', 'horizon', 'as_of', 'other']);
  need('v0.freq_', [...V0.PAYMENT_FREQS]);
  need('v0.weekend_', [...V0.WEEKENDS]);
  need('v0.kind_', [...V0.PAYMENT_KINDS]);
  need('v0.res_', [...V0.RESERVE_KINDS]);
  need('v0.limit_', ['payments', 'incomes', 'reserves', 'duplicate']);
  need('v0.gate_', ['readiness', 'stale', 'no_anchor', 'no_buffer', 'rule_disabled', 'generic']);
  const forbidden = VOCAB.forbidden_phrases.map((x) => x.toLowerCase().replace(/ё/g, 'е'));
  const code = fs.readFileSync(path.join(DEMO, 'v0.mjs'), 'utf8') + fs.readFileSync(path.join(DEMO, 'v0.html'), 'utf8');
  const corpus = [...Object.values(CATALOG.ru), ...Object.values(CATALOG.en), code].join('\n').toLowerCase().replace(/ё/g, 'е');
  for (const p of forbidden) assert.ok(!corpus.includes(p), `запрещено: «${p}»`);
  for (const lang of ['ru', 'en']) for (const v of Object.values(CATALOG[lang])) assert.ok(!/(за|in)\s+\d+\s+(минут|minutes)/i.test(v), v);
  assert.match(CATALOG.ru['v0.disclaimer'], /не консультация/);
  assert.match(CATALOG.en['v0.disclaimer'], /not advice/);
  assert.match(CATALOG.ru['v0.r_engine'], /не консультация/);
  const lits = new Set([...code.matchAll(/'(v0\.[a-z0-9_]+)'(?!\s*\+)/g)].map((m) => m[1]));
  const prefixes = [...code.matchAll(/'(v0\.[a-z0-9_]*)'\s*\+/g)].map((m) => m[1]);
  assert.ok(!prefixes.includes('v0.'));
  assert.deepEqual(ru.filter((k) => !lits.has(k) && !prefixes.some((p) => k.startsWith(p))), [], 'ключи без использования');
  assert.deepEqual([...lits].filter((k) => !ru.includes(k)), [], 'код ссылается на несуществующие ключи');
  // совпадение с основным приложением: вердикты и режимы подписаны словарём канона
  assert.equal(V0.tr('ru', 'v0.r_earliest'), 'Самая ранняя дата, с которой сумма держится в буфере');
  assert.equal(V0.tr('ru', 'нет.такого'), 'нет.такого', 'неизвестный ключ виден как есть');
  assert.equal(I18N.t('ru', 'buy.earliest').toLowerCase().includes('самая ранняя дата, с которой сумма держится в буфере'), true);
});

test('REQ-180 форматы показа v0 те же, что у приложения: деньги и даты через render_value верификатора (RU: «1 234,50 €», EN: «€1,234.50»); pct_text', () => {
  const ru = V0.make_v0_fmt('ru', 'EUR', '2026-10-04');
  const en = V0.make_v0_fmt('en', 'EUR', '2026-10-04');
  assert.equal(NB(ru.money(123450)), '1 234,50 €');
  assert.equal(en.money(123450), '€1,234.50');
  assert.equal(ru.money(-9000).replace('−', '-'), '-90,00 €'.replace(' ', ' '));
  assert.equal(ru.date('2026-11-20'), '20 ноября');
  assert.equal(en.date('2026-11-20'), 'November 20');
  assert.equal(V0.pct_text(2000, 'ru'), '20');
  assert.equal(V0.pct_text(2050, 'ru'), '20,50');
  assert.equal(V0.pct_text(1250, 'en'), '12.50');
});

// ── исправления после проверки: испорченная форма в файле, введённое не пропадает ───────────────────────────────────────

const clone = (x) => JSON.parse(JSON.stringify(x));

/** Файл v0 (рабочая область с формой), в котором форма испорчена функцией `mutate`; рабочая область вокруг формы целая. */
function file_with_form(mutate) {
  const ws = clone(V0.form_to_ws(g001_form()).ws);
  mutate(ws[V0.FORM_KEY]);
  return JSON.stringify(ws);
}

test('REQ-180 REQ-091 форма v0 из файла проверяется до сборки: целая форма пригодна; испорченные — нет; read_state не бросает ни на одной, файл с испорченной формой открывается как чужой (для расчёта и покупки)', () => {
  assert.equal(V0.form_is_valid(g001_form()), true);
  assert.equal(V0.form_is_valid(V0.empty_form('2026-10-04')), true);
  const broken = {
    'платёж = null': (f) => { f.payments[0] = null; },
    'платёж = число': (f) => { f.payments[0] = 7; },
    'резерв = null': (f) => { f.reserves = [null]; },
    'вид резерва неизвестен': (f) => { f.reserves[0].kind = 'x'; },
    'два налоговых резерва': (f) => { f.reserves[1] = { ...f.reserves[0] }; },
    'поступление = число': (f) => { f.incomes[0] = 5; },
    'дата платежа — число': (f) => { f.payments[0].date = 5; },
    'дата платежа — не календарная': (f) => { f.payments[0].date = '2026-02-31'; },
    'сумма — строка': (f) => { f.payments[0].amount_minor = '90000'; },
    'сумма — дробь': (f) => { f.payments[0].amount_minor = 12.5; },
    'сумма — ноль': (f) => { f.payments[0].amount_minor = 0; },
    'частота неизвестна': (f) => { f.payments[0].freq = 'D'; },
    'название — не строка': (f) => { f.payments[0].name = { a: 1 }; },
    'название пустое': (f) => { f.incomes[0].name = '   '; },
    'задержка — дробь': (f) => { f.incomes[0].delay_days = 1.5; },
    'ставка — строка': (f) => { f.reserves[0].rate_bp = '2000'; },
    'ставка больше 100 %': (f) => { f.reserves[0].rate_bp = 10001; },
    'срок накопления — не дата': (f) => { f.reserves[1].due_date = 'скоро'; },
    'платежи — не массив': (f) => { f.payments = { 0: 1 }; },
    'валюта неизвестна': (f) => { f.currency = 'XXQ'; },
    'горизонт — строка': (f) => { f.horizon_days = '57'; },
    'остаток — строка': (f) => { f.balance_minor = '400000'; },
    'покупка без даты': (f) => { f.purchase = { amount_minor: 30000 }; },
    'версия формы 2': (f) => { f.v = 2; },
  };
  for (const [name, mut] of Object.entries(broken)) {
    const form = clone(g001_form());
    mut(form);
    assert.equal(V0.form_is_valid(form), false, name);
    let r;
    assert.doesNotThrow(() => { r = V0.read_state(file_with_form(mut)); }, name);
    assert.equal(r.ok, true, name + ': ' + JSON.stringify(r));
    assert.equal(r.kind, 'foreign', name + ': испорченная форма — чужой файл');
    // чужой файл всё равно считает покупку тем же движком: G-001 в нём цел
    const a = V0.purchase_answer(r.ws, { amount_minor: 30000, date: '2026-10-12' }, 'ru');
    assert.equal(a.ok, true, name);
    assert.equal(a.view.verdict, 'FRAGILE', name);
  }
  // форма не объект и мусор вместо формы
  for (const junk of [null, 5, 'x', [], undefined]) assert.equal(V0.form_is_valid(junk), false);
  const ws = clone(V0.form_to_ws(g001_form()).ws);
  ws[V0.FORM_KEY] = 'мусор';
  assert.doesNotThrow(() => V0.read_state(JSON.stringify(ws)));
  assert.equal(V0.read_state(JSON.stringify(ws)).kind, 'foreign');
});

test('REQ-180 form_to_ws не бросает: сборка правила на непригодной дате или сумме возвращает отказ кодом', () => {
  const form = clone(g001_form());
  form.payments[0].date = 5;
  let r;
  assert.doesNotThrow(() => { r = V0.form_to_ws(form); });
  assert.equal(r.ok, false);
  assert.match(r.error.code, /^E_[A-Z_]+$/);
  form.payments[0].date = '2026-10-25';
  form.payments[0].amount_minor = 'много';
  assert.doesNotThrow(() => { r = V0.form_to_ws(form); });
  assert.equal(r.ok, false);
});

test('REQ-180 TST-59 открытие испорченного файла: страница остаётся рабочей — состояние не меняется или файл открыт как чужой; исключений наружу нет, после отказа страница принимает ввод', async () => {
  const opener = (rt) => async (text) => { const input = by_id(rt(), 'v0-file-in'); input.files = [{ size: text.length, text: async () => text }]; await input.listeners.change[0](); };
  for (const mut of [(f) => { f.payments[0] = null; }, (f) => { f.reserves = [null]; }, (f) => { f.reserves[0].kind = 'x'; }, (f) => { f.incomes[0] = 5; }]) {
    const { page, root } = fresh_page();
    await opener(root)(file_with_form(mut));
    assert.notEqual(page.foreign, null, 'испорченная форма: открыто как чужой файл');
    assert.match(by_id(root(), 'v0-notice').textContent, /создан не в v0/);
    // страница не сломана: перерисовка (смена языка) и сброс работают, форма снова доступна
    REG.get('v0-lang-en').listeners.click[0]();
    assert.equal(by_id(root(), 'v0-title').textContent, 'Can I buy this?');
    REG.get('v0-lang-ru').listeners.click[0]();
    by_id(root(), 'v0-reset').listeners.click[0]();
    assert.equal(page.foreign, null);
    fill(root(), { 'v0-pay-name': 'Аренда', 'v0-pay-amount': '900', 'v0-pay-date': '2026-10-25' });
    assert.equal(send(root(), 'v0-form-payments').ok, true);
  }
  // файл, у которого чтение падает или разбор бросает, — отказ с объяснением, страница прежняя
  const { page, root } = fresh_page();
  const form0 = page.form;
  const input = by_id(root(), 'v0-file-in');
  input.files = [{ size: 10, text: async () => { throw new Error('read'); } }];
  await assert.doesNotReject(async () => { await input.listeners.change[0](); });
  assert.equal(page.form, form0);
  assert.match(by_id(root(), 'v0-notice').textContent, /не похож на состояние/);
  // отрисовка, которая бросила после принятия файла, откатывает состояние страницы (проверка защиты на подменённой отрисовке)
  const rendered = [];
  const r2 = fresh_page();
  const text = JSON.stringify(G);
  const real_h = r2.page.form;
  const hook = by_id(r2.root(), 'v0-file-in');
  hook.files = [{ size: text.length, text: async () => text }];
  const real_get = REG.get('main').replaceChildren.bind(REG.get('main'));
  let calls = 0;
  REG.get('main').replaceChildren = (...kids) => { calls += 1; if (calls === 1) { rendered.push('throw'); throw new Error('render'); } return real_get(...kids); };
  try {
    await assert.doesNotReject(async () => { await hook.listeners.change[0](); });
  } finally {
    REG.get('main').replaceChildren = real_get;
  }
  assert.deepEqual(rendered, ['throw']);
  assert.equal(r2.page.foreign, null, 'состояние откатилось');
  assert.equal(r2.page.form, real_h);
  assert.match(by_id(REG.get('main'), 'v0-notice').textContent, /не похож на состояние/);
});

test('REQ-180 введённое, но не принятое, не пропадает при добавлении строки: остаток, буфер, горизонт, покупка и недописанные поля других форм остаются; поля отправленной формы очищаются', () => {
  const { page, root } = fresh_page();
  const d = (n) => E.format_date(E.to_epoch_day(page.form.as_of) + n); // даты — от «сегодня» страницы: тест не зависит от календаря
  fill(root(), { 'v0-balance': '4000', 'v0-buffer': '500', 'v0-horizon': '45', 'v0-buy-amount': '300', 'v0-buy-date': d(5) });
  fill(root(), { 'v0-inc-name': 'Выплата', 'v0-inc-amount': '2790' }); // недописанная форма поступления
  fill(root(), { 'v0-pay-name': 'Аренда', 'v0-pay-amount': '900', 'v0-pay-date': d(20), 'v0-pay-freq': 'W' });
  assert.equal(send(root(), 'v0-form-payments').ok, true);
  assert.equal(page.form.payments.length, 1);
  assert.equal(page.form.balance_minor, null, 'форма верха не принята — в данных остатка нет');
  // но в полях всё осталось как было введено
  for (const [id, v] of Object.entries({ 'v0-balance': '4000', 'v0-buffer': '500', 'v0-horizon': '45', 'v0-buy-amount': '300', 'v0-buy-date': d(5), 'v0-inc-name': 'Выплата', 'v0-inc-amount': '2790' })) {
    assert.equal(by_id(root(), id).value, v, id);
  }
  // отправленная форма очищена: название и сумма пусты, дата — исходная
  assert.equal(by_id(root(), 'v0-pay-name').value, '');
  assert.equal(by_id(root(), 'v0-pay-amount').value, '');
  assert.equal(by_id(root(), 'v0-pay-date').value, page.form.as_of);
  assert.equal(by_id(root(), 'v0-pay-freq').value, 'M', 'выбор частоты сброшен к исходному');
  // ещё одно добавление — черновики переходят и дальше; убрать строку — тоже не теряет введённое
  fill(root(), { 'v0-pay-name': 'Связь', 'v0-pay-amount': '25', 'v0-pay-date': d(3) });
  assert.equal(send(root(), 'v0-form-payments').ok, true);
  assert.equal(by_id(root(), 'v0-balance').value, '4000');
  find_all(root(), (n) => n.attrs['data-bucket'] === 'payments' && n.attrs['data-index'] === '0')[0].listeners.click[0]();
  assert.equal(page.form.payments.length, 1);
  assert.equal(by_id(root(), 'v0-balance').value, '4000');
  assert.equal(by_id(root(), 'v0-inc-amount').value, '2790');
  // принять верх формы: поля берутся из принятого, а не из черновика
  assert.equal(send(root(), 'v0-form-top').ok, true);
  assert.equal(page.form.balance_minor, 400000);
  assert.equal(by_id(root(), 'v0-balance').value, '4000');
  assert.equal(by_id(root(), 'v0-horizon').value, '45');
  assert.equal(by_id(root(), 'v0-inc-amount').value, '2790', 'недописанное поступление остаётся');
  // принятая покупка: поля берутся из формы, ответ считается
  assert.equal(send(root(), 'v0-form-buy').ok, true);
  assert.equal(page.form.purchase.amount_minor, 30000);
  assert.equal(by_id(root(), 'v0-buy-amount').value, '300');
  // черновик живёт одну отрисовку: смена языка сбрасывает недописанное к принятому
  REG.get('v0-lang-en').listeners.click[0]();
  assert.equal(by_id(root(), 'v0-inc-amount').value, '', 'смена языка начинает с принятых значений (десятичный знак зависит от языка)');
  assert.equal(by_id(root(), 'v0-balance').value, '4000');
  // исходная дата расчёта сменилась в верхней форме — даты новых платежей по умолчанию берут новую дату, а не устаревший черновик
  REG.get('v0-lang-ru').listeners.click[0]();
  const next_asof = d(1);
  fill(root(), { 'v0-asof': next_asof });
  assert.equal(send(root(), 'v0-form-top').ok, true);
  assert.equal(by_id(root(), 'v0-pay-date').value, next_asof, 'значение по умолчанию (не введённое пользователем) следует за датой расчёта');
});
