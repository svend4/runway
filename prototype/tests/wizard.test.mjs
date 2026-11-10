// wizard.test.mjs — FP-10: мастер «Старт» (demo/wizard.mjs, pack_fp10.mjs, start_template.mjs, data/g001-empty.json, data/templates/*).
// Покрывает: REQ-110 и REQ-029 (четыре шага и буфер на наборе g001-empty доводят готовность s до 4; прогноз виден при s ≥ 3; причины — движка; числа сверены
// независимой ручной симуляцией по дням), поля и ошибки (код канона E_*, текст рядом с полем, введённое не повторяется, данные при отказе не меняются), пропуск шагов
// и возврат, журнал времени шагов без сумм и дат (порядковый номер сеанса, предел простоя), REQ-068 (шаблон-скелет без ставок, срок годности правил, зеркало = файл),
// REQ-183 (юридическое ревью и вычитка RU/EN помечены «ожидает людей»), a11y (подписи полей, aria-describedby, role=alert/status, фокус-заголовок), RU и EN,
// TST-56 (каталог строк), TST-59 (нет innerHTML, inline-стилей и сети). DOM подменён заглушкой; браузер и сеть не используются.
// Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ── заглушка DOM ────────────────────────────────────────────────────────────────────────────────────────────────────

class FakeNode {
  constructor(tag) {
    this.nodeType = 1; this.tagName = tag; this.attrs = {}; this.children = []; this.listeners = {}; this.className = ''; this._text = ''; this._value = ''; this._sel = null; this.focused = false;
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
  querySelectorAll() { return []; }
  walk(fn) { fn(this); for (const c of this.children) if (c.nodeType === 1) c.walk(fn); }
}
const CUR = { root: null };
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const by_id = (root, id) => find_all(root, (n) => n.attrs.id === id)[0];
globalThis.document = {
  createElement: (t) => new FakeNode(t), createElementNS: (_n, t) => new FakeNode(t), createTextNode: (data) => ({ nodeType: 3, data }),
  getElementById: (id) => (CUR.root === null ? null : by_id(CUR.root, id) ?? null), head: new FakeNode('head'), body: new FakeNode('body'),
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.resolve(HERE, '..');
const DEMO = path.join(PROTO, 'demo');
const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);
const ENGINE = await imp('engine', 'index.mjs');
const APP = await imp('demo', 'app.mjs');
const { create_ext } = await imp('demo', 'ext.mjs');
const I18N = await imp('demo', 'i18n.mjs');
const { seeded_ports, make_id_gen } = await imp('demo', 'ids.mjs');
const { apply_chain } = await imp('demo', 'forms.mjs');
const W = await imp('demo', 'wizard.mjs');
const PACK = await imp('demo', 'pack_fp10.mjs');
const MX = await imp('demo', 'metrics.mjs');
const TPL = await imp('demo', 'start_template.mjs');
const HC = await imp('demo', 'home_cards.mjs');
const CATALOG = (await imp('demo', 'i18n', 'start.mjs')).default;
const SETTINGS = (await imp('demo', 'i18n', 'settings.mjs')).default;
I18N.register_strings('settings', SETTINGS); // подписи причин готовности (settings.rd_miss_*) берёт мастер из каталога FP-03
I18N.register_strings('start', CATALOG); // строки мастера (пакет при регистрации видит, что они уже приняты)
const VOCAB = JSON.parse(fs.readFileSync(path.join(PROTO, 'engine', 'vocab.json'), 'utf8'));

const load = (name) => JSON.parse(fs.readFileSync(path.join(PROTO, 'data', name), 'utf8'));
const EMPTY = load('g001-empty.json');
const G = load('g001.json');
const tr = (lang, k, p) => I18N.t(lang, k, p);
const tick = () => new Promise((r) => setImmediate(r));

function fake_storage() {
  const m = new Map();
  return { m, get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}

/** Страница с настоящим пересчётом (`build_model`) и пакетом FP-10: часы и хранилище метрик — наши. */
async function make_page(ws = EMPTY, { lang = 'ru' } = {}) {
  const e = create_ext({ ports: seeded_ports({ seed: 11 }) });
  const st = { ws, lang, root: null, notes: [], renders: 0, view: 'start' };
  const build = (w) => APP.build_model(w, { lang: st.lang });
  st.model = build(ws);
  e.bind_host({
    get_ws: () => st.ws, get_model: () => st.model, lang: () => st.lang, mode: () => 'worse', fmt: () => APP.make_fmt(st.lang, st.model.cur, st.model.as_of_iso),
    set_ws: (next) => { let m; try { m = build(next); } catch (err) { return { ok: false, error: err }; } st.ws = next; st.model = m; return { ok: true }; },
    render: () => { st.renders += 1; st.root = e.render_view(st.view); CUR.root = st.root; },
    notify: (m, k) => { st.notes.push([m, k]); },
  });
  const clock = { t: 1_000_000 };
  const storage = fake_storage();
  const deps = PACK.register(e, { ports: { now_ms: () => clock.t, tz_offset_min: () => 0 }, storage });
  await e.run('boot');
  st.root = e.render_view('start');
  CUR.root = st.root;
  const page = { e, ctx: e.ctx, st, deps, clock, storage, mx: deps.metrics };
  page.root = () => st.root;
  page.set_lang = (l) => { st.lang = l; e.ctx.refresh(); };
  /** Ввести значения в поля и отправить форму. */
  page.submit = (form_id, values = {}) => {
    for (const [id, v] of Object.entries(values)) { by_id(st.root, id).value = v; }
    const card = by_id(st.root, 'st-step');
    for (const fn of card.listeners.input ?? []) fn();
    const form = by_id(st.root, form_id);
    assert.ok(form !== undefined, 'нет формы ' + form_id);
    return form.listeners.submit[0]({ preventDefault() {} });
  };
  page.click = (id) => { const b = by_id(st.root, id); assert.ok(b !== undefined, 'нет кнопки ' + id); return b.listeners.click[0](); };
  page.score = () => st.model.ctx.readiness.score;
  return page;
}

const ENV = { cur: 'EUR', lang: 'ru', as_of: '2026-10-04', default_account_name: 'Основной счёт', default_daily_name: 'Повседневные траты', default_income_name: 'Доход' };
const new_gen = (seed = 3) => make_id_gen(seeded_ports({ seed })).entity;

/** Применить план шага к рабочей области (как это делает общий путь записи). */
function apply_plan(ws, plan, gen) {
  assert.equal(plan.ok, true, JSON.stringify(plan.error));
  const r = apply_chain(ws, plan.edits, { new_id: gen, as_of: ws.as_of });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  return r.ws;
}

// ── набор g001-empty ────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-110 REQ-029 набор g001-empty: пустой, готовность s = 0 со всеми четырьмя причинами движка; он в переключателе наборов (ds.empty RU и EN)', () => {
  assert.equal(EMPTY.accounts.length, 0);
  assert.equal(EMPTY.params.horizon_days, 57, 'горизонт задан явно, как у наборов G-001');
  assert.equal(EMPTY.as_of, G.as_of);
  const m = APP.build_model(EMPTY);
  assert.deepEqual({ score: m.ctx.readiness.score, level: m.ctx.readiness.level }, { score: 0, level: 'empty' });
  assert.deepEqual(m.ctx.readiness.reasons, ['no_account', 'obligations_lt_3', 'no_income_45d', 'no_daily_spend']);
  const d = I18N.DATASETS.find((x) => x.id === 'empty');
  assert.deepEqual(d, { id: 'empty', file: '../data/g001-empty.json' });
  assert.ok(fs.existsSync(path.resolve(DEMO, d.file)));
  assert.equal(I18N.t('ru', 'ds.empty'), 'G-001-empty — пустой, с нуля');
  assert.equal(I18N.t('en', 'ds.empty'), 'G-001-empty — blank, from scratch');
  // на пустом наборе кроме готовности ничего не считается: вердикта нет, узкая точка нулевая
  assert.equal(m.ctx.series.plan.opening_minor, 0);
  const rd = HC.readiness_model(m);
  assert.equal(rd.forecast_visible, false);
  assert.equal(rd.buffer.set, false);
});

// ── четыре шага и буфер ─────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-110 REQ-029 четыре шага и буфер на g001-empty: s = 1 → 1 → 1 → 2 → 3 → 4; прогноз виден с s = 3; вердикт доступен после буфера; причины — движка', () => {
  const gen = new_gen();
  let ws = EMPTY;
  const seen = [];
  const step = (label, plan) => {
    ws = apply_plan(ws, plan, gen);
    const m = APP.build_model(ws);
    const rd = HC.readiness_model(m);
    seen.push([label, m.ctx.readiness.score, rd.forecast_visible, [...m.ctx.readiness.reasons]]);
    return { m, rd, wm: W.wizard_model(m) };
  };
  let r = step('счёт', W.plan_account(ws, { name: '', balance: '4000' }, ENV, gen));
  assert.deepEqual(r.wm.done, { account: true, obligations: false, income: false, daily: false, buffer: false });
  assert.equal(r.wm.first_open, 'obligations');
  assert.equal(r.wm.account.name, 'Основной счёт', 'пустое название заменено названием по умолчанию');
  // три небольших платежа (меньше порога значимого): шаг засчитывается только на третьем — «не менее трёх обязательств»
  r = step('платёж 1', W.plan_obligation(ws, { name: 'Связь', amount: '25', freq: 'M', date: '2026-10-09' }, ENV, gen));
  assert.equal(r.wm.done.obligations, false);
  r = step('платёж 2', W.plan_obligation(ws, { name: 'Музыка', amount: '15', freq: 'M', date: '2026-10-12' }, ENV, gen));
  assert.equal(r.wm.done.obligations, false);
  assert.equal(r.wm.obligations.length, 2);
  r = step('платёж 3', W.plan_obligation(ws, { name: 'Зал', amount: '20', freq: 'M', date: '2026-10-20' }, ENV, gen));
  assert.equal(r.wm.done.obligations, true);
  assert.equal(r.wm.obligations.length, 3);
  assert.equal(r.rd.forecast_visible, false, 's = 2: прогноза ещё нет');
  r = step('доход', W.plan_income(ws, { name: '', amount: '2790', repeat: 'once', date: '2026-11-05', delay: '' }, ENV, gen));
  assert.equal(r.rd.forecast_visible, true, 's = 3: прогноз появился');
  assert.deepEqual(r.rd.reasons, ['no_daily_spend']);
  assert.ok(r.rd.verdict_gate !== null, 'вердикт ещё закрыт');
  r = step('траты', W.plan_daily(ws, { name: '', amount: '100', period: 'W' }, ENV, gen));
  assert.deepEqual(r.rd.reasons, []);
  assert.deepEqual(r.rd.verdict_gate.reasons, ['no_buffer'], 's = 4, но буфера нет: вердикт закрыт по причине no_buffer');
  r = step('буфер', W.plan_buffer(ws, { amount: '500' }, ENV));
  assert.equal(r.rd.verdict_gate, null, 'буфер задан: вердикт доступен');
  assert.deepEqual(seen.map((x) => [x[0], x[1], x[2]]), [
    ['счёт', 1, false], ['платёж 1', 1, false], ['платёж 2', 1, false], ['платёж 3', 2, false], ['доход', 3, true], ['траты', 4, true], ['буфер', 4, true],
  ]);
  assert.deepEqual(seen[0][3], ['obligations_lt_3', 'no_income_45d', 'no_daily_spend'], 'недостающее называет движок');
  // числа прогноза сверены независимой симуляцией по дням (оракул без движка): остаток 4000 €, платежи 25/15/20 € по 9-му/12-му/20-му, 100 € по воскресеньям, поступление 2790 € 5 ноября
  const a = r.m.ctx;
  const np = (mode) => ENGINE.narrowest_point(a.series[mode], a.as_of, a.horizon_end);
  const expected = (mode) => {
    const as_of = ENGINE.to_epoch_day('2026-10-04');
    let bal = 400000; let best = null;
    for (let d = as_of; d <= as_of + 57; d++) {
      const day = Number(ENGINE.format_date(d).slice(8));
      let out = 0;
      if (day === 9 && d >= ENGINE.to_epoch_day('2026-10-09')) out += 2500;
      if (day === 12 && d >= ENGINE.to_epoch_day('2026-10-12')) out += 1500;
      if (day === 20 && d >= ENGINE.to_epoch_day('2026-10-20')) out += 2000;
      if ((d - as_of) % 7 === 0) out += 10000;
      bal -= out;
      if (best === null || bal < best.v) best = { v: bal, d: ENGINE.format_date(d) };
      if (d === ENGINE.to_epoch_day('2026-11-05') + (mode === 'worse' ? 14 : 0)) bal += 279000;
    }
    return best;
  };
  for (const mode of ['plan', 'worse']) {
    assert.deepEqual({ v: np(mode).amount_minor, d: ENGINE.format_date(np(mode).date) }, expected(mode), 'узкая точка ' + mode);
  }
  assert.deepEqual(expected('plan'), { v: 344000, d: '2026-11-01' });
  assert.deepEqual(expected('worse'), { v: 320000, d: '2026-11-15' });
});

test('REQ-110 правила шагов: платёж — обязательство с вычетом, доход — поступление (один раз или раз в месяц, привычная задержка), траты — одно приблизительное правило, которое правится, а не дублируется', () => {
  const gen = new_gen(5);
  let ws = apply_plan(EMPTY, W.plan_account(EMPTY, { name: 'Дом', balance: '1 234,50' }, ENV, gen), gen);
  const acc = ws.accounts[0];
  assert.deepEqual({ name: acc.name, kind: acc.kind, liquidity: acc.liquidity, currency: acc.currency }, { name: 'Дом', kind: 'bank', liquidity: 'operating', currency: 'EUR' });
  assert.equal(ws.anchors.at(-1).amount_minor, 123450);
  assert.equal(ws.anchors.at(-1).date, '2026-10-04');
  // второй запуск шага 1: тот же счёт и тот же якорь за дату расчёта — новых записей нет
  const again = apply_plan(ws, W.plan_account(ws, { name: 'Дом', balance: '2000' }, ENV, gen), gen);
  assert.equal(again.accounts.length, 1);
  assert.equal(again.accounts[0].account_id, acc.account_id);
  assert.equal(again.anchors.length, 1, 'якорь за ту же дату заменён, а не добавлен');
  assert.equal(again.anchors[0].amount_minor, 200000);
  ws = apply_plan(again, W.plan_obligation(again, { name: 'Аренда', amount: '900', freq: 'M', date: '2026-10-31' }, ENV, gen), gen);
  const rent = ws.rules[0];
  assert.deepEqual({ kind: rent.kind, exp: rent.amount.exp_minor, freq: rent.freq, monthday: rent.by_monthday, obligation: rent.is_obligation, estimate: rent.is_estimate, start: rent.start_date },
    { kind: 'expense', exp: -90000, freq: 'M', monthday: [31], obligation: true, estimate: false, start: '2026-10-31' });
  ws = apply_plan(ws, W.plan_obligation(ws, { name: 'Страховка', amount: '300', freq: 'Y', date: '2027-02-01' }, ENV, gen), gen);
  assert.equal(ws.rules[1].freq, 'Y');
  ws = apply_plan(ws, W.plan_income(ws, { name: 'Клиент', amount: '2000', repeat: 'M', date: '2026-10-20', delay: '7' }, ENV, gen), gen);
  const inc = ws.rules[2];
  assert.deepEqual({ kind: inc.kind, exp: inc.amount.exp_minor, freq: inc.freq, count: inc.count, delay: inc.delay_days_worse, obligation: inc.is_obligation }, { kind: 'income', exp: 200000, freq: 'M', count: undefined, delay: 7, obligation: false });
  ws = apply_plan(ws, W.plan_income(ws, { name: 'Разово', amount: '100', repeat: 'once', date: '2026-10-21', delay: '' }, ENV, gen), gen);
  assert.equal(ws.rules[3].count, 1);
  assert.equal(ws.rules[3].delay_days_worse, undefined);
  // повседневные траты: первая запись создаёт правило, вторая правит то же правило (версия растёт), недельное → месячное меняет условия повторения
  ws = apply_plan(ws, W.plan_daily(ws, { name: '', amount: '80', period: 'W' }, ENV, gen), gen);
  const day = ws.rules.find((r) => r.is_estimate === true);
  assert.deepEqual({ freq: day.freq, wd: day.by_weekday, exp: day.amount.exp_minor, obligation: day.is_obligation }, { freq: 'W', wd: [0], exp: -8000, obligation: false });
  const n = ws.rules.length;
  ws = apply_plan(ws, W.plan_daily(ws, { name: 'Мелочь', amount: '300', period: 'M' }, ENV, gen), gen);
  assert.equal(ws.rules.length, n, 'второй запуск шага не плодит правила');
  const day2 = ws.rules.find((r) => r.is_estimate === true);
  assert.equal(day2.rule_id, day.rule_id);
  assert.deepEqual({ freq: day2.freq, wd: day2.by_weekday, md: day2.by_monthday, exp: day2.amount.exp_minor, name: day2.name }, { freq: 'M', wd: undefined, md: [4], exp: -30000, name: 'Мелочь' });
  assert.ok(day2.version > day.version, 'правка существующего правила повышает версию');
  ws = apply_plan(ws, W.plan_buffer(ws, { amount: '0' }, ENV), gen);
  assert.equal(ws.params.buffer_minor, 0, 'ноль допустим: буфер задан и равен нулю');
  assert.equal(APP.build_model(ws).ctx.buffer_minor, 0);
});

test('REQ-110 мастер на существующем наборе G-001: шаг 1 правит тот же счёт и тот же якорь, шаг «траты» правит R-GROC, платежи и поступления добавляются, прежние записи целы', () => {
  const gen = new_gen(9);
  const before = JSON.stringify(G);
  let ws = apply_plan(G, W.plan_account(G, { name: 'Основной счёт', balance: '4000' }, { ...ENV }, gen), gen);
  assert.equal(ws.accounts.length, 1);
  assert.equal(ws.accounts[0].account_id, 'acc_main');
  assert.equal(ws.anchors.length, G.anchors.length, 'якорь 2026-10-04 заменён по тому же идентификатору');
  assert.ok(ws.anchors.some((a) => a.anchor_id === 'anc-g001-1004'));
  const rules_n = ws.rules.length;
  ws = apply_plan(ws, W.plan_daily(ws, { name: 'Продукты', amount: '100', period: 'W' }, ENV, gen), gen);
  assert.equal(ws.rules.length, rules_n);
  const groc = ws.rules.find((r) => r.rule_id === 'R-GROC');
  assert.equal(groc.tag, 'продукты', 'прочие поля существующего правила сохранены');
  assert.equal(groc.calendar_id, 'cal-main');
  assert.equal(JSON.stringify(G), before, 'исходный набор не изменён');
  const m = APP.build_model(ws);
  assert.equal(m.ctx.readiness.score, 4);
});

// ── ошибки полей ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-017 REQ-110 ошибки полей: код канона E_*, поле и причина; нет счёта → отказ; введённое значение не попадает ни в код ошибки, ни в текст', () => {
  const gen = new_gen();
  const with_acc = apply_plan(EMPTY, W.plan_account(EMPTY, { name: '', balance: '1000' }, ENV, gen), gen);
  const P = {
    account: (t) => W.plan_account(EMPTY, t, ENV, gen),
    obl: (t) => W.plan_obligation(with_acc, t, ENV, gen),
    inc: (t) => W.plan_income(with_acc, t, ENV, gen),
    day: (t) => W.plan_daily(with_acc, t, ENV, gen),
    buf: (t) => W.plan_buffer(with_acc, t, ENV),
  };
  const good_obl = { name: 'Связь', amount: '25', freq: 'M', date: '2026-10-09' };
  const good_inc = { name: 'Доход', amount: '100', repeat: 'M', date: '2026-10-09', delay: '' };
  const cases = [
    ['account', { name: '', balance: '' }, 'E_NOT_INTEGER', 'balance', 'empty'],
    ['account', { name: '', balance: 'много' }, 'E_NOT_INTEGER', 'balance', 'bad_number'],
    ['account', { name: '', balance: '9'.repeat(30) }, 'E_OVERFLOW', 'balance', 'too_big'],
    ['account', { name: 'я'.repeat(121), balance: '10' }, 'E_SCHEMA', 'name', 'too_long'],
    ['obl', { ...good_obl, name: '   ' }, 'E_SCHEMA', 'name', 'empty'],
    ['obl', { ...good_obl, amount: '' }, 'E_NOT_INTEGER', 'amount', 'empty'],
    ['obl', { ...good_obl, amount: 'abc-секрет' }, 'E_NOT_INTEGER', 'amount', 'bad_number'],
    ['obl', { ...good_obl, amount: '0' }, 'E_SCHEMA', 'amount', 'zero'],
    ['obl', { ...good_obl, amount: '-5' }, 'E_SCHEMA', 'amount', 'negative'],
    ['obl', { ...good_obl, amount: '1,5,5' }, 'E_NOT_INTEGER', 'amount', 'bad_number'],
    ['obl', { ...good_obl, freq: 'раз в час' }, 'E_SCHEMA', 'freq', 'not_in_list'],
    ['obl', { ...good_obl, date: '' }, 'E_BAD_DATE', 'date', 'empty'],
    ['obl', { ...good_obl, date: '2026-13-40' }, 'E_BAD_DATE', 'date', 'bad_date'],
    ['obl', { ...good_obl, date: '2026-02-30' }, 'E_BAD_DATE', 'date', 'bad_date'],
    ['obl', { ...good_obl, date: '2026-10-03' }, 'E_BAD_DATE', 'date', 'date_past'],
    ['obl', { ...good_obl, date: '2028-01-01' }, 'E_BAD_DATE', 'date', 'date_far'],
    ['inc', { ...good_inc, amount: '0' }, 'E_SCHEMA', 'amount', 'zero'],
    ['inc', { ...good_inc, repeat: 'иногда' }, 'E_SCHEMA', 'repeat', 'not_in_list'],
    ['inc', { ...good_inc, delay: '400' }, 'E_SCHEMA', 'delay', 'range'],
    ['inc', { ...good_inc, delay: '-1' }, 'E_NOT_INTEGER', 'delay', 'bad_number'],
    ['inc', { ...good_inc, delay: '1,5' }, 'E_NOT_INTEGER', 'delay', 'bad_number'],
    ['day', { name: '', amount: '', period: 'W' }, 'E_NOT_INTEGER', 'amount', 'empty'],
    ['day', { name: '', amount: '5', period: 'каждый час' }, 'E_SCHEMA', 'period', 'not_in_list'],
    ['buf', { amount: '' }, 'E_NOT_INTEGER', 'amount', 'empty'],
    ['buf', { amount: '-100' }, 'E_SCHEMA', 'amount', 'negative'],
  ];
  for (const [form, t, code, field, reason] of cases) {
    const r = P[form](t);
    assert.equal(r.ok, false, `${form} ${JSON.stringify(t)}`);
    assert.deepEqual({ code: r.error.code, field: r.error.ctx.field, reason: r.error.ctx.reason }, { code, field, reason }, `${form} ${JSON.stringify(t)}`);
    // введённое не повторяется: ни в контексте ошибки, ни в тексте на обоих языках
    const raw = Object.values(t).filter((v) => typeof v === 'string' && v.trim().length >= 3);
    for (const lang of ['ru', 'en']) {
      const text = W.error_message((k, p) => tr(lang, k, p), r.error, { ...ENV, lang });
      assert.ok(text.includes(code), `${lang}: в тексте код ${code}: ${text}`);
      assert.ok(!/\{[a-z_]+\}/.test(text), 'нет неподставленных полей: ' + text);
      for (const v of raw) assert.ok(!text.includes(v), `${lang}: текст не повторяет введённое «${v}»`);
      if (lang === 'en') assert.ok(!/[А-Яа-яЁё]/.test(text), 'EN-текст без русских слов: ' + text);
    }
    assert.ok(!JSON.stringify(r.error).includes('секрет'), 'в контексте ошибки нет введённого текста');
  }
  // нет счёта: платёж, доход и траты отвергаются с понятной причиной
  for (const r of [W.plan_obligation(EMPTY, good_obl, ENV, gen), W.plan_income(EMPTY, good_inc, ENV, gen), W.plan_daily(EMPTY, { name: '', amount: '5', period: 'W' }, ENV, gen)]) {
    assert.deepEqual({ code: r.error.code, field: r.error.ctx.field, reason: r.error.ctx.reason }, { code: 'E_SCHEMA', field: 'account', reason: 'no_account' });
    assert.match(W.error_message((k, p) => tr('ru', k, p), r.error, ENV), /Сначала нужны счёт и остаток/);
  }
  // неизвестные причины и коды сводятся к общему тексту, а не к пустоте
  assert.match(W.error_message((k, p) => tr('ru', k, p), { code: 'E_WHATEVER', ctx: { field: 'rule.name', reason: 'control_chars' } }, ENV), /Не принято \(E_SCHEMA\)/);
  assert.match(W.error_message((k, p) => tr('ru', k, p), null, ENV), /Не принято/);
  // даты в формате пользователя: «31.10.2026» при ru читается как ISO 2026-10-31
  const dmy = W.plan_obligation(with_acc, { ...good_obl, date: '31.10.2026' }, ENV, gen);
  assert.equal(dmy.ok, true);
  assert.equal(dmy.edits[0].rule.start_date, '2026-10-31');
});

test('REQ-110 TST-51 разбор сумм: формат чисел языка и рабочей области; EN понимает «1,234.50», RU — «1 234,50»; лишние разделители и символ валюты', () => {
  const gen = new_gen();
  const ok = (text, lang = 'ru', nf) => {
    const r = W.plan_account(EMPTY, { name: 'a', balance: text }, { ...ENV, lang, nf }, gen);
    return r.ok ? r.edits[1].anchor.amount_minor : r.error.ctx.reason;
  };
  assert.equal(ok('1 234,50'), 123450);
  assert.equal(ok('1234'), 123400);
  assert.equal(ok('1 234,50 €'), 123450);
  assert.equal(ok('-50'), -5000, 'остаток может быть отрицательным (овердрафт)');
  assert.equal(ok('0'), 0, 'остаток 0 допустим');
  assert.equal(ok('1,234.50', 'en'), 123450);
  assert.equal(ok('1.234,50', 'en'), 'bad_number');
  assert.equal(ok('1.234,50', 'ru', { decimal: ',', thousands: '.' }), 123450, 'формат рабочей области важнее языка');
});

// ── экран на странице ───────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-110 REQ-029 экран «Старт»: четыре шага и буфер через формы; запись только общим путём (один set_ws на шаг); прогноз появляется на s = 3 с причинами движка, затем «Могу ли я купить?»', async () => {
  const p = await make_page(EMPTY);
  assert.equal(by_id(p.root(), 'view-title').textContent, 'Старт: первый прогноз');
  assert.equal(by_id(p.root(), 'view-title').attrs.tabindex, '-1');
  // на старте виден шаг 1, прогноза нет, перечислено всё, чего не хватает (причины движка)
  assert.equal(by_id(p.root(), 'st-step-title').textContent, 'Шаг 1. Счёт и остаток');
  const wait = by_id(p.root(), 'st-forecast');
  for (const reason of ['no_account', 'obligations_lt_3', 'no_income_45d', 'no_daily_spend']) assert.ok(wait.textContent.includes(tr('ru', HC.miss_key(reason))), 'причина ' + reason);
  assert.ok(wait.textContent.includes('Прогноз появится, когда готовность данных достигнет 3 из 4. Сейчас 0.'));
  const writes = [];
  const real_set = p.ctx.set_ws;
  p.ctx.subscribe((info) => writes.push(info.reason));
  // шаг 1
  const r1 = p.submit('st-form-acc', { 'st-acc-name': '', 'st-acc-balance': '4000' });
  assert.equal(r1.ok, true);
  assert.equal(p.score(), 1);
  assert.deepEqual(writes, ['upsert_account'], 'один шаг — одна запись общим путём');
  assert.equal(by_id(p.root(), 'st-step-title').textContent, 'Шаг 2. Обязательства', 'после записи — следующий шаг');
  assert.ok(by_id(p.root(), 'st-form-obl') !== undefined);
  // шаг 2: три платежа; шаг остаётся на месте, пока пользователь не уйдёт сам
  for (const [name, amount, date] of [['Связь', '25', '2026-10-09'], ['Музыка', '15', '2026-10-12'], ['Зал', '20', '2026-10-20']]) {
    assert.equal(p.submit('st-form-obl', { 'st-obl-name': name, 'st-obl-amount': amount, 'st-obl-date': date }).ok, true);
  }
  assert.equal(p.score(), 2);
  assert.equal(by_id(p.root(), 'st-step-title').textContent, 'Шаг 2. Обязательства');
  assert.match(by_id(p.root(), 'st-step').textContent, /Платежей добавлено: 3\. Для шага достаточно 3/);
  assert.equal(find_all(by_id(p.root(), 'st-step'), (n) => n.tagName === 'li' && /Связь|Музыка|Зал/.test(n.textContent)).length, 3, 'введённые платежи перечислены');
  assert.ok(!by_id(p.root(), 'st-forecast').textContent.includes('Прогноз готов'), 's = 2: прогноза ещё нет');
  p.click('st-next');
  assert.equal(by_id(p.root(), 'st-step-title').textContent, 'Шаг 3. Ближайший доход');
  // шаг 3 → s = 3: прогноз появился
  p.submit('st-form-inc', { 'st-inc-name': '', 'st-inc-amount': '2790', 'st-inc-date': '2026-11-05', 'st-inc-repeat': 'once', 'st-inc-delay': '' });
  assert.equal(p.score(), 3);
  const fc = by_id(p.root(), 'st-forecast');
  assert.ok(fc.textContent.includes('Прогноз готов: готовность данных 3 из 4.'), fc.textContent.slice(0, 200));
  const fc_text = fc.textContent.replace(/[  ]/g, ' ');
  assert.ok(fc_text.includes('по плану: самая узкая точка 3 940,00 € — 20 октября'), 'узкая точка по плану из расчёта (4000 − 25 − 15 − 20 € до поступления): ' + fc_text);
  assert.ok(fc_text.includes('если хуже: самая узкая точка 3 900,00 € — 12 ноября'), 'и «если хуже» (поступление на 14 дней позже, ещё два платежа): ' + fc_text);
  assert.ok(fc.textContent.includes(tr('ru', HC.miss_key('no_daily_spend'))), 'не учтено — траты');
  assert.equal(find_all(fc, (n) => n.tagName === 'a' && n.attrs.href === '#overview').length, 1);
  assert.equal(find_all(fc, (n) => n.tagName === 'a' && n.attrs.href === '#buy').length, 0, 'вердикт ещё закрыт');
  // шаги 4 и буфер
  p.click('st-next');
  assert.equal(by_id(p.root(), 'st-step-title').textContent, 'Шаг 4. Повседневные траты');
  p.submit('st-form-day', { 'st-day-name': '', 'st-day-amount': '100', 'st-day-period': 'W' });
  assert.equal(p.score(), 4);
  assert.equal(by_id(p.root(), 'st-step-title').textContent, 'Буфер: сколько оставлять нетронутым');
  assert.ok(by_id(p.root(), 'st-forecast').textContent.includes('пока не появится: не задан буфер'));
  p.submit('st-form-buf', { 'st-buf-amount': '500' });
  assert.equal(p.st.model.ctx.buffer_minor, 50000);
  assert.equal(find_all(by_id(p.root(), 'st-forecast'), (n) => n.tagName === 'a' && n.attrs.href === '#buy').length, 1, 'вердикт доступен: ссылка «Могу ли я купить?»');
  assert.ok(by_id(p.root(), 'st-forecast').textContent.includes('Ответ «могу ли я купить» доступен.'));
  assert.deepEqual(writes, ['upsert_account', 'upsert_rule', 'upsert_rule', 'upsert_rule', 'upsert_rule', 'upsert_rule', 'set_param']);
  void real_set;
  // журнал событий (единственный источник истины) следует за правками: все шаги — в нём
  const events = p.ctx.journal.state().state;
  assert.equal(Object.keys(events.rules).length, 5);
  assert.equal(Object.keys(events.accounts).length, 1);
});

test('REQ-110 при отказе записи данные не меняются: ошибка у поля (role=alert), aria-invalid, шаг остаётся, ничего не перерисовывается и не пишется', async () => {
  const p = await make_page(EMPTY);
  const ws0 = p.st.ws;
  const renders0 = p.st.renders;
  const writes = [];
  p.ctx.subscribe((info) => writes.push(info.reason));
  const r = p.submit('st-form-acc', { 'st-acc-name': '', 'st-acc-balance': 'абв-секрет' });
  assert.equal(r.ok, false);
  assert.equal(p.st.ws, ws0, 'рабочая область — тот же объект');
  assert.equal(p.st.renders, renders0, 'страница не перерисована');
  assert.deepEqual(writes, []);
  const err = by_id(p.root(), 'st-acc-balance-err');
  assert.equal(err.attrs.role, 'alert');
  assert.match(err.textContent, /^Остаток: не похоже на число \(E_NOT_INTEGER\)/);
  assert.ok(!err.textContent.includes('абв-секрет'));
  assert.equal(by_id(p.root(), 'st-acc-balance').attrs['aria-invalid'], 'true');
  assert.equal(by_id(p.root(), 'st-acc-balance').focused, true, 'фокус на поле с ошибкой');
  assert.equal(by_id(p.root(), 'st-acc-name-err').textContent, '', 'у других полей ошибки нет');
  // исправили — запись прошла, а ошибки на новой странице нет
  p.submit('st-form-acc', { 'st-acc-balance': '100' });
  assert.equal(p.score(), 1);
  assert.equal(find_all(p.root(), (n) => n.attrs.role === 'alert' && n.textContent !== '').length, 0);
  // отказ общего пути (например, пересчёт страницы) тоже ничего не меняет и показывается в строке состояния
  const ws1 = p.st.ws;
  p.submit('st-form-obl', { 'st-obl-name': 'a\u0007b', 'st-obl-amount': '10', 'st-obl-date': '2026-10-09' });
  assert.equal(p.st.ws, ws1, 'имя с управляющим знаком отвергнуто проверкой правки');
  const status = find_all(by_id(p.root(), 'st-form-obl'), (n) => n.attrs.role === 'status')[0];
  const field_err = by_id(p.root(), 'st-obl-name-err').textContent;
  assert.ok(field_err.includes('E_SCHEMA') || status.textContent.includes('E_SCHEMA'), 'код канона показан: ' + field_err + status.textContent);
});

test('REQ-110 шаги можно пропускать и возвращаться: «Пропустить шаг» ведёт дальше без записи и пишет исход skipped; «Назад» и кнопки хода возвращают; недостающее остаётся в списке причин', async () => {
  const p = await make_page(EMPTY);
  await p.e.run('boot');
  const ws0 = p.st.ws;
  p.click('st-skip'); // шаг 1 пропущен
  assert.equal(p.st.ws, ws0, 'пропуск ничего не пишет');
  assert.equal(by_id(p.root(), 'st-step-title').textContent, 'Шаг 2. Обязательства');
  assert.equal(by_id(p.root(), 'st-back') !== undefined, true);
  p.click('st-skip'); // шаг 2 пропущен
  p.click('st-skip'); // шаг 3 пропущен
  assert.equal(by_id(p.root(), 'st-step-title').textContent, 'Шаг 4. Повседневные траты');
  p.click('st-back');
  assert.equal(by_id(p.root(), 'st-step-title').textContent, 'Шаг 3. Ближайший доход');
  // прыжок по ходу шагов
  const jump = find_all(p.root(), (n) => n.tagName === 'button' && n.attrs['data-step'] === 'account')[0];
  jump.listeners.click[0]();
  assert.equal(by_id(p.root(), 'st-step-title').textContent, 'Шаг 1. Счёт и остаток');
  const current = find_all(p.root(), (n) => n.attrs['aria-current'] === 'step');
  assert.equal(current.length, 1);
  assert.equal(current[0].attrs['data-step'], 'account');
  // метрики: три пропуска записаны, без сумм
  const steps = p.mx.package().steps;
  assert.deepEqual(steps.map((s) => [s.step, s.outcome]), [['account', 'skipped'], ['obligations', 'skipped'], ['income', 'skipped']]);
  assert.equal(p.score(), 0);
  // возвращаемся и заполняем в произвольном порядке: сначала доход нельзя (нет счёта) — отказ понятный; затем счёт
  find_all(p.root(), (n) => n.tagName === 'button' && n.attrs['data-step'] === 'income')[0].listeners.click[0]();
  const bad = p.submit('st-form-inc', { 'st-inc-amount': '100', 'st-inc-date': '2026-10-10' });
  assert.equal(bad.ok, false);
  assert.match(find_all(by_id(p.root(), 'st-form-inc'), (n) => n.attrs.role === 'status')[0].textContent, /Сначала нужны счёт и остаток/);
  find_all(p.root(), (n) => n.tagName === 'button' && n.attrs['data-step'] === 'account')[0].listeners.click[0]();
  p.submit('st-form-acc', { 'st-acc-balance': '10' });
  assert.equal(p.score(), 1);
  // у шага, который уже засчитан, вместо «Пропустить» — «Далее»
  find_all(p.root(), (n) => n.tagName === 'button' && n.attrs['data-step'] === 'account')[0].listeners.click[0]();
  assert.ok(by_id(p.root(), 'st-next') !== undefined && by_id(p.root(), 'st-skip') === undefined);
});

test('REQ-110 REQ-185 журнал времени шагов — локальный и без сумм и дат: шаг, секунды активной работы, исход, номер сеанса; простой дольше минуты засчитывается минутой', async () => {
  const p = await make_page(EMPTY);
  p.clock.t += 0;
  p.clock.t += 12_000; // 12 с набор остатка
  p.submit('st-form-acc', { 'st-acc-balance': '4137,29', 'st-acc-name': 'Мой секретный счёт' });
  p.clock.t += 600_000; // ушли на десять минут и вернулись
  p.submit('st-form-obl', { 'st-obl-name': 'Аренда 777', 'st-obl-amount': '905,55', 'st-obl-date': '2026-10-25' });
  p.click('st-next'); // ушли на шаг дохода без записи: исход не пишется
  p.clock.t += 20_000;
  p.click('st-skip'); // шаг дохода пропущен
  const pkg = p.mx.package();
  assert.deepEqual(MX.validate_package(pkg), []);
  assert.equal(pkg.sessions, 1, 'сеанс — загрузка страницы');
  assert.deepEqual(pkg.steps.map((s) => [s.step, s.seconds, s.session, s.outcome]), [
    ['account', 12, 1, 'saved'],
    ['obligations', 60, 1, 'saved'], // 10 минут простоя засчитаны как 60 с
    ['income', 20, 1, 'skipped'],
  ]);
  const text = JSON.stringify(pkg);
  for (const secret of ['413729', '4137', '90555', '905', 'секрет', 'Аренда', '2026-10-25', '2026-10-04']) assert.ok(!text.includes(secret), 'в журнале нет: ' + secret);
  for (const s of pkg.steps) assert.deepEqual(Object.keys(s).sort(), ['outcome', 'seconds', 'session', 'step']);
  // журнал лежит в локальном хранилище под ключом с префиксом runway и больше нигде
  assert.deepEqual([...p.storage.m.keys()], [MX.METRICS_KEY]);
  assert.ok(p.storage.m.get(MX.METRICS_KEY).includes('"steps"'));
});

test('REQ-185 отметка «первый прогноз»: ставится один раз при переходе s < 3 → s ≥ 3 после шага мастера, секунды = сумма журнала шагов; «вердикт доступен» — после буфера', async () => {
  const p = await make_page(EMPTY);
  p.clock.t += 10_000;
  p.submit('st-form-acc', { 'st-acc-balance': '4000' });
  for (const [n, a, d] of [['a', '25', '2026-10-09'], ['b', '15', '2026-10-12'], ['c', '20', '2026-10-20']]) { p.clock.t += 5_000; p.submit('st-form-obl', { 'st-obl-name': n, 'st-obl-amount': a, 'st-obl-date': d }); }
  assert.equal(p.mx.package().first_forecast, null, 's = 2: прогноза ещё нет');
  p.click('st-next');
  p.clock.t += 7_000;
  p.submit('st-form-inc', { 'st-inc-amount': '2790', 'st-inc-date': '2026-11-05', 'st-inc-repeat': 'once' });
  assert.equal(p.score(), 3);
  assert.deepEqual(p.mx.package().first_forecast, { after_seconds: 10 + 15 + 7, session: 1 }, '10 с шаг 1, три платежа по 5 с, 7 с доход');
  assert.equal(p.mx.package().verdict_ready, null);
  p.click('st-next');
  p.submit('st-form-day', { 'st-day-amount': '100' });
  p.submit('st-form-buf', { 'st-buf-amount': '500' });
  assert.deepEqual(p.mx.package().verdict_ready, { session: 1 });
  p.submit('st-form-buf', { 'st-buf-amount': '600' });
  assert.deepEqual(p.mx.package().first_forecast, { after_seconds: 32, session: 1 }, 'отметка не перезаписывается');
  // счётчики действий: только имена из закрытого списка и числа
  assert.deepEqual(p.mx.package().counters, { wizard_opened: 1, accounts_saved: 1, rules_saved: 5 });
  assert.deepEqual(MX.validate_package(p.mx.package()), []);
});

test('REQ-110 таймер шагов: время копится по шагам отдельно, простой ограничен, часы назад не дают минус; запись шага обнуляет его время', () => {
  const clock = { t: 0 };
  const tm = W.create_step_timer({ now_ms: () => clock.t, idle_cap_ms: 60_000, max_seconds: 3600 });
  tm.enter('account');
  clock.t += 5_000; tm.touch();
  tm.enter('obligations'); // переход: 5 с — шагу «счёт»
  clock.t += 8_000; tm.touch();
  tm.enter('account'); // вернулись: 8 с — «обязательствам»
  clock.t += 2_000;
  assert.deepEqual(tm.done('account', 'saved'), { step: 'account', seconds: 7, outcome: 'saved' }, '5 + 2 с');
  assert.deepEqual(tm.done('obligations', 'skipped'), { step: 'obligations', seconds: 8, outcome: 'skipped' });
  assert.deepEqual(tm.done('account', 'saved'), { step: 'account', seconds: 0, outcome: 'saved' }, 'после записи время обнулено');
  clock.t += 3_600_000;
  assert.equal(tm.done('income', 'saved').seconds, 0, 'шаг, которого не было на экране, — ноль');
  tm.enter('daily');
  for (let i = 0; i < 400; i++) { clock.t += 60_000; tm.touch(); }
  assert.equal(tm.done('daily', 'saved').seconds, 3600, 'предел 3600 с');
  tm.enter('buffer');
  clock.t -= 10_000; tm.touch();
  clock.t += 3_000;
  assert.equal(tm.done('buffer', 'saved').seconds, 3, 'часы пошли назад: отрицательное время — ноль');
});

// ── доступность, RU и EN, безопасность ──────────────────────────────────────────────────────────────────────────────────

test('TST-58 a11y: у каждого поля есть подпись (label for), подсказка и место для ошибки связаны через aria-describedby, ошибки role=alert, статусы role=status, заголовок шага принимает фокус и получает его после записи', async () => {
  const p = await make_page(EMPTY);
  const check_forms = () => {
    const root = p.root();
    const inputs = find_all(root, (n) => (n.tagName === 'input' || n.tagName === 'select') && n.attrs.id !== undefined);
    assert.ok(inputs.length >= 1);
    for (const inp of inputs) {
      const labels = find_all(root, (n) => n.tagName === 'label' && n.attrs.for === inp.attrs.id);
      assert.equal(labels.length, 1, 'подпись поля ' + inp.attrs.id);
      assert.ok(labels[0].textContent.trim().length > 1);
      for (const ref of String(inp.attrs['aria-describedby'] ?? '').split(' ').filter(Boolean)) assert.ok(by_id(root, ref) !== undefined, `${inp.attrs.id}: aria-describedby → ${ref}`);
      assert.ok(by_id(root, inp.attrs.id + '-err').attrs.role === 'alert', 'ошибка поля — role=alert');
    }
    for (const n of find_all(root, () => true)) {
      assert.equal(n.attrs.style, undefined, 'нет inline-стилей');
      for (const k of Object.keys(n.attrs)) assert.ok(!/^on/i.test(k), 'нет атрибутов-обработчиков: ' + k);
      if (n.tagName === 'a') assert.ok(/^#[a-z]+$/.test(n.attrs.href), 'ссылки только на разделы: ' + n.attrs.href);
    }
    assert.ok(find_all(root, (n) => n.attrs.role === 'status').length >= 1, 'есть строки состояния');
    const forms = find_all(root, (n) => n.tagName === 'form');
    for (const f of forms) assert.equal(f.attrs['aria-labelledby'], 'st-step-title');
    assert.equal(by_id(root, 'st-step-title').attrs.tabindex, '-1');
    assert.equal(by_id(root, 'view-title').attrs.tabindex, '-1');
    const required = find_all(root, (n) => n.attrs['aria-required'] === 'true');
    assert.ok(required.length >= 1);
  };
  check_forms();
  p.submit('st-form-acc', { 'st-acc-balance': '100' });
  await tick();
  assert.equal(by_id(p.root(), 'st-step-title').focused, true, 'после записи фокус на заголовке нового шага');
  check_forms();
  p.click('st-back');
  await tick();
  assert.equal(by_id(p.root(), 'st-step-title').focused, true, 'при переходе по шагам фокус на заголовке шага');
  for (const step of ['obligations', 'income', 'daily', 'buffer']) {
    find_all(p.root(), (n) => n.tagName === 'button' && n.attrs['data-step'] === step)[0].listeners.click[0]();
    check_forms();
  }
  // кнопки хода — настоящие button с видимым текстом и состоянием
  const steps = find_all(p.root(), (n) => n.tagName === 'button' && n.attrs['data-step'] !== undefined);
  assert.equal(steps.length, 5);
  for (const b of steps) assert.ok(/учтено|не учтено|задан|не задан/.test(b.textContent), b.textContent);
});

test('REQ-111 TST-58 экран «Старт» на английском: строки из каталога EN, без русских слов; ошибки и подписи на языке интерфейса', async () => {
  const p = await make_page(EMPTY, { lang: 'en' });
  const text = () => p.root().textContent;
  assert.ok(!/[А-Яа-яЁё]/.test(text()), 'на пустом наборе страница EN без русских слов: ' + text().match(/[^\n]{0,40}[А-Яа-яЁё][^\n]{0,20}/)?.[0]);
  assert.equal(by_id(p.root(), 'st-step-title').textContent, 'Step 1. Account and balance');
  p.submit('st-form-acc', { 'st-acc-balance': 'abc' });
  assert.match(by_id(p.root(), 'st-acc-balance-err').textContent, /^Balance: this does not look like a number \(E_NOT_INTEGER\)\. Digits and the decimal sign of your number format are accepted, for example 1234\.50\./);
  p.submit('st-form-acc', { 'st-acc-balance': '1,234.50' });
  assert.equal(p.st.ws.anchors[0].amount_minor, 123450);
  assert.equal(p.st.ws.accounts[0].name, 'Main account', 'название по умолчанию на языке интерфейса');
  assert.ok(!/[А-Яа-яЁё]/.test(text()), 'и после записи');
  // переключение языка перерисовывает экран
  p.set_lang('ru');
  assert.equal(by_id(p.root(), 'st-step-title').textContent, 'Шаг 2. Обязательства');
});

test('TST-59 безопасность мастера: пользовательский текст попадает в страницу только как текст (textContent), в разметку не превращается; нет inline-стилей, обработчиков-строк, innerHTML и сети', async () => {
  const p = await make_page(EMPTY);
  const evil = '<img src=x onerror=alert(1)><script>boom()</script>';
  p.submit('st-form-acc', { 'st-acc-name': evil, 'st-acc-balance': '100' });
  p.click('st-back'); // обратно на шаг 1: введённое показано в списке «Уже введено»
  const all = find_all(p.root(), () => true);
  assert.ok(all.every((n) => n.tagName !== 'img' && n.tagName !== 'script'), 'теги из текста не созданы');
  assert.ok(all.some((n) => n.textContent.includes(evil)), 'текст виден как текст');
  assert.ok(p.st.notes.some(([m]) => m.includes(evil)), 'и в сообщении — текстом');
  for (const n of all) {
    assert.equal(n.attrs.style, undefined);
    for (const [k, v] of Object.entries(n.attrs)) { assert.ok(!/^on/i.test(k)); assert.ok(!/javascript:/i.test(String(v))); }
  }
  for (const f of ['wizard.mjs', 'pack_fp10.mjs', 'start_template.mjs', 'rule_kit.mjs', 'metrics_view.mjs']) {
    const src = fs.readFileSync(path.join(DEMO, f), 'utf8');
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'srcdoc', 'eval(', 'new Function', 'fetch(', 'XMLHttpRequest', 'sendBeacon', 'document.write']) assert.ok(!src.includes(bad), `${f}: ${bad}`);
    assert.ok(!/from\s*'\.\/app\.mjs'/.test(src), `${f}: не импортирует app.mjs`);
  }
});

// ── шаблон-скелет ───────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-068 шаблон-скелет: нет предзаполненных ставок и сумм, у правила есть срок годности, отметки проверки нет; зеркало в коде равно файлу data/templates/freelancer-skeleton.json', () => {
  const dir = path.join(PROTO, 'data', 'templates');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.deepEqual(files, ['freelancer-skeleton.json']);
  for (const f of files) {
    const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.deepEqual(TPL.validate_template(t), [], f);
    // сквозной обход: ни одного числа в полях ставок, сумм и копеек; rate_bp только null
    const walk = (x, at) => {
      if (Array.isArray(x)) { x.forEach((v, i) => walk(v, at + '[' + i + ']')); return; }
      if (x === null || typeof x !== 'object') return;
      for (const [k, v] of Object.entries(x)) {
        if (k === 'rate_bp') assert.equal(v, null, `${f}: ${at}.${k} должен быть null`);
        if (/amount|minor|rate|price|sum/i.test(k)) assert.ok(typeof v !== 'number', `${f}: число в поле ${at}.${k}`);
        walk(v, at + '.' + k);
      }
    };
    walk(t, '');
    assert.equal(t.tax_rule.rate_bp, null);
    assert.ok(Number.isSafeInteger(t.tax_rule.ttl_days) && t.tax_rule.ttl_days >= 1, 'у правила налога есть срок годности');
    assert.ok(Number.isSafeInteger(t.review.ttl_days) && t.review.ttl_days >= 1);
    assert.equal(t.review.reviewed_at, null, 'проверку людьми шаблон не заявляет');
    assert.equal(t.review.status, 'awaiting_humans');
    assert.deepEqual(JSON.parse(JSON.stringify(TPL.TEMPLATES[t.template_id])), t, 'зеркало в коде = файл');
  }
  assert.deepEqual([...TPL.TEMPLATE_IDS], ['freelancer-skeleton']);
  // проверка видит нарушения
  const base = JSON.parse(JSON.stringify(TPL.TEMPLATES['freelancer-skeleton']));
  const probs = (mut) => { const t = JSON.parse(JSON.stringify(base)); mut(t); return TPL.validate_template(t); };
  assert.ok(probs((t) => { t.tax_rule.rate_bp = 2000; }).some((e) => e.startsWith('prefilled_rate')));
  assert.ok(probs((t) => { t.obligations[0].amount_minor = 90000; }).some((e) => e.startsWith('prefilled_number')));
  assert.ok(probs((t) => { t.review.ttl_days = 0; }).includes('review_no_ttl'));
  assert.ok(probs((t) => { t.review.reviewed_at = '2026-10-09'; }).includes('review_claimed'));
  assert.ok(probs((t) => { t.tax_rule.ttl_days = null; }).includes('tax_rule_no_ttl'));
  assert.ok(probs((t) => { t.format = 'x'; }).includes('bad_format'));
  assert.ok(probs((t) => { t.obligations = []; }).includes('no_obligations'));
  assert.ok(probs((t) => { t.obligations[0].label = { ru: 'a' }; }).some((e) => e.startsWith('no_label')));
  assert.deepEqual(TPL.validate_template(null), ['not_object']);
  // и ни в одном наборе данных пакета нет шаблонов стран и предзаполненных ставок в шаблонах
  for (const name of fs.readdirSync(path.join(PROTO, 'data'))) {
    if (!name.endsWith('.json')) continue;
    const ws = load(name);
    for (const r of ws.tax_rules ?? []) assert.ok(/правило пользователя|user/i.test(r.name ?? ''), name + ': налоговое правило помечено как правило пользователя');
  }
  assert.ok(!fs.existsSync(path.join(PROTO, 'data', 'templates', 'ru.json')), 'шаблонов стран нет');
});

test('REQ-068 REQ-110 «Начать с шаблона»: подсказки названий (аренда, связь…) подставляют название и частоту, сумма остаётся пустой; шаблон можно убрать; сведения о сроке и ожидании проверки людьми показаны', async () => {
  const p = await make_page(EMPTY);
  p.submit('st-form-acc', { 'st-acc-balance': '1000' });
  assert.equal(find_all(p.root(), (n) => n.attrs['data-slot'] !== undefined).length, 0, 'без шаблона подсказок нет');
  p.click('st-template-on');
  await tick();
  assert.equal(by_id(p.root(), 'st-template-off').focused, true, 'фокус на кнопке, которая появилась на месте нажатой');
  const note = find_all(p.root(), (n) => n.className === 'banner start-template')[0];
  assert.ok(note.textContent.includes('Скелет подсказывает названия строк'));
  assert.ok(note.textContent.includes('Срок годности правил шаблона: 365 дн.; отметки о проверке нет.'));
  assert.ok(note.textContent.includes('Юридическое ревью формулировок и вычитка RU/EN ещё не выполнены: ждут людей.'));
  const chips = find_all(p.root(), (n) => n.attrs['data-slot'] !== undefined);
  assert.deepEqual(chips.map((c) => c.attrs['data-slot']), ['rent', 'utilities', 'phone', 'software', 'insurance']);
  assert.deepEqual(chips.map((c) => c.textContent), ['Аренда', 'Коммунальные услуги', 'Связь и интернет', 'Подписки и программы для работы', 'Страховка']);
  chips.find((c) => c.attrs['data-slot'] === 'insurance').listeners.click[0]();
  assert.equal(by_id(p.root(), 'st-obl-name').value, 'Страховка');
  assert.equal(by_id(p.root(), 'st-obl-freq').value, 'Y');
  assert.equal(by_id(p.root(), 'st-obl-amount').value, '', 'сумма не подставлена: в шаблоне сумм нет');
  const ws0 = p.st.ws;
  const bad = p.submit('st-form-obl', { 'st-obl-date': '2027-03-01' });
  assert.equal(bad.ok, false, 'без суммы запись невозможна');
  assert.equal(p.st.ws, ws0);
  p.submit('st-form-obl', { 'st-obl-amount': '300' });
  const rule = p.st.ws.rules.at(-1);
  assert.deepEqual({ name: rule.name, freq: rule.freq, exp: rule.amount.exp_minor }, { name: 'Страховка', freq: 'Y', exp: -30000 });
  // доход и траты: свои подсказки; EN — свои подписи
  find_all(p.root(), (n) => n.tagName === 'button' && n.attrs['data-step'] === 'income')[0].listeners.click[0]();
  assert.deepEqual(find_all(p.root(), (n) => n.attrs['data-slot'] !== undefined).map((c) => c.textContent), ['Выплата от клиента']);
  p.set_lang('en');
  assert.deepEqual(find_all(p.root(), (n) => n.attrs['data-slot'] !== undefined).map((c) => c.textContent), ['Client payout']);
  assert.ok(!/[А-Яа-яЁё]/.test(by_id(p.root(), 'st-step').textContent), 'шаг дохода на EN без русских слов');
  p.click('st-template-off');
  assert.equal(find_all(p.root(), (n) => n.attrs['data-slot'] !== undefined).length, 0);
});

test('REQ-183 юридическое ревью формулировок и вычитка RU/EN помечены «ожидает людей»: ни в каталоге, ни в шаблоне нет утверждений о выполненной проверке', () => {
  assert.equal(TPL.TEMPLATES['freelancer-skeleton'].review.status, 'awaiting_humans');
  assert.match(CATALOG.ru['start.tpl_review_pending'], /ещё не выполнены: ждут людей/);
  assert.match(CATALOG.en['start.tpl_review_pending'], /not done yet: they wait for people/);
  const claims = /(проверен\p{L}* юрист|юридическ\p{L}* ревью (выполнен|пройден)|вычитк\p{L}* выполнен|legal review (is |was )?(done|completed|passed)|reviewed by (a )?lawyer|proofread by)/iu;
  for (const lang of ['ru', 'en']) for (const [k, v] of Object.entries(CATALOG[lang])) assert.ok(!claims.test(v), `${lang} ${k}: утверждение о проверке`);
  assert.ok(!claims.test(JSON.stringify(TPL.TEMPLATES)));
});

// ── карточка на «Обзоре» ────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-110 карточка «Старт» в слоте overview.cards: пока данных мало для вердикта — ведёт в #start; с s = 4 и буфером исчезает; на пустом наборе показывает «данных мало»', async () => {
  const p = await make_page(EMPTY);
  const nodes = p.e.slot_nodes('overview.cards');
  const card = nodes.find((n) => n.className === 'card start-card');
  assert.ok(card !== undefined, 'карточка зарегистрирована в слоте');
  assert.ok(card.textContent.includes('Данных пока мало для прогноза'));
  const link = find_all(card, (n) => n.tagName === 'a')[0];
  assert.equal(link.attrs.href, '#start');
  p.submit('st-form-acc', { 'st-acc-balance': '1000' });
  assert.ok(find_all(p.e.slot_nodes('overview.cards').find((n) => n.className === 'card start-card'), (n) => n.tagName === 'p')[0].textContent.includes('Данных пока мало'));
  const full = await make_page(G);
  assert.equal(full.e.slot_nodes('overview.cards').filter((n) => n.className === 'card start-card').length, 0, 'на G-001 (s = 4, буфер задан) карточки нет');
  const partial = await make_page({ ...G, params: { ...G.params, buffer_minor: null } });
  const c2 = partial.e.slot_nodes('overview.cards').find((n) => n.className === 'card start-card');
  assert.ok(c2 !== undefined && c2.textContent.includes('Готовность данных 4 из 4'), 'буфер не задан: карточка напоминает');
});

test('REQ-110 пакет FP-10 в реестре: экраны #start и #metrics в навигации после экранов приложения, строки зарегистрированы, повторная регистрация не падает, подписчик ведёт счётчики', async () => {
  const p = await make_page(EMPTY);
  const items = p.e.nav_items();
  assert.equal(items.find((x) => x.id === 'start').title_key, 'start.nav');
  assert.equal(items.find((x) => x.id === 'metrics').title_key, 'start.nav_metrics');
  assert.deepEqual(items.slice(0, 8).map((x) => x.id), ['overview', 'buy', 'waves', 'reserves', 'scenarios', 'feed', 'assistant', 'data'], 'порядок экранов приложения не тронут');
  assert.ok(items.findIndex((x) => x.id === 'start') > items.findIndex((x) => x.id === 'data'), '«Старт» стоит после экранов приложения');
  assert.equal(PACK.START_ORDER, 90);
  assert.ok(items.findIndex((x) => x.id === 'metrics') > items.findIndex((x) => x.id === 'data'));
  assert.equal(I18N.t('ru', 'start.nav'), 'Старт');
  assert.equal(I18N.t('en', 'start.nav'), 'Start');
  const again = await make_page(EMPTY); // второй реестр в том же процессе: строки уже приняты, регистрация не падает
  assert.ok(again.e.has_view('start') && again.e.has_view('metrics'));
  // экран метрик рисуется из реестра
  const mv = p.e.render_view('metrics');
  assert.equal(by_id(mv, 'view-title').textContent, 'Метрики на устройстве');
  // счётчики: запись общим путём считается по причине
  p.submit('st-form-acc', { 'st-acc-balance': '1' });
  assert.equal(p.mx.package().counters.accounts_saved, 1);
  assert.equal(p.mx.package().counters.wizard_opened, 1);
  // смена набора данных сбрасывает состояние мастера, но не метрики
  p.ctx.subscribe(() => {});
  p.e.reset(EMPTY, { source: 'dataset' });
  assert.equal(p.deps.ui.step, null);
  assert.equal(p.mx.package().counters.accounts_saved, 1);
});

// ── каталог строк ───────────────────────────────────────────────────────────────────────────────────────────────────────

test('TST-56 каталог мастера: паритет RU/EN и плейсхолдеров, семейства ключей полны (поля, ошибки, шаги, частоты, метрики), нет запрещённых формулировок и обещаний времени, налоги — с оговоркой', () => {
  const ru = Object.keys(CATALOG.ru).sort();
  const en = Object.keys(CATALOG.en).sort();
  assert.deepEqual(ru, en);
  const ph = (s) => [...s.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const k of ru) {
    assert.ok(k.startsWith('start.'));
    assert.equal(ph(CATALOG.ru[k]), ph(CATALOG.en[k]), 'плейсхолдеры ' + k);
    const letters = CATALOG.ru[k].replace(/\{[A-Za-z0-9_]+\}/g, '').replace(/[^A-Za-zА-Яа-яЁё]/g, '');
    if (letters !== '') assert.match(CATALOG.ru[k], /[А-Яа-яЁё]/, 'RU-строка без русских букв: ' + k);
  }
  const need = (prefix, tails) => { for (const t of tails) assert.ok(ru.includes(prefix + t), 'нет ключа ' + prefix + t); };
  need('start.er_', ['empty', 'bad_number', 'zero', 'negative', 'too_big', 'bad_date', 'date_past', 'date_far', 'range', 'too_long', 'no_account', 'not_in_list', 'other']);
  need('start.f_', ['name', 'balance', 'amount', 'freq', 'date', 'repeat', 'delay', 'period', 'other']);
  need('start.sn_', W.STEPS);
  need('start.freq_', W.OBLIGATION_FREQS);
  need('start.rep_', W.INCOME_REPEATS);
  need('start.per_', W.DAILY_PERIODS);
  need('start.mx_in_', [1, 2, 3]);
  need('start.mx_c_', MX.COUNTER_NAMES);
  need('start.mx_row_', ['sessions', 'days', 'steps', 'forecast', 'verdict', 'counters', 'error', 'coverage']);
  const forbidden = VOCAB.forbidden_phrases.map((x) => x.toLowerCase().replace(/ё/g, 'е'));
  const src = ['wizard.mjs', 'pack_fp10.mjs', 'metrics.mjs', 'metrics_view.mjs', 'start_template.mjs'].map((f) => fs.readFileSync(path.join(DEMO, f), 'utf8')).join('\n');
  const corpus = [...Object.values(CATALOG.ru), ...Object.values(CATALOG.en), src, JSON.stringify(TPL.TEMPLATES)].join('\n').toLowerCase().replace(/ё/g, 'е');
  for (const phrase of forbidden) assert.ok(!corpus.includes(phrase), `запрещено: «${phrase}»`);
  for (const w of ['спокойно', 'hallucinat', 'guarantee', 'risk-free', 'exact figures']) assert.ok(!corpus.includes(w), w);
  // времени онбординга в строках нет (измерения нет — обещания нет)
  for (const lang of ['ru', 'en']) for (const v of Object.values(CATALOG[lang])) assert.ok(!/(за|in)\s+\d+\s+(минут|minutes)/i.test(v), v);
  assert.match(CATALOG.ru['start.lead'], /мы не обещаем/);
  // налоги — только с оговоркой
  assert.match(CATALOG.ru['start.disclaimer'], /не консультация/);
  assert.match(CATALOG.en['start.disclaimer'], /not advice/);
  for (const lang of ['ru', 'en']) for (const [k, v] of Object.entries(CATALOG[lang])) {
    if (/налог|\btax\b/i.test(v)) assert.ok(/не консультация|not advice|Формы данных|Data forms/i.test(v) || k === 'start.s1_lead', `${lang} ${k}: налоговая строка без оговорки`);
  }
});

test('TST-56 каждый ключ каталога мастера используется кодом пакета (литерал или динамический префикс), а код ссылается только на существующие ключи', () => {
  const code = ['wizard.mjs', 'pack_fp10.mjs', 'metrics.mjs', 'metrics_view.mjs', 'start_template.mjs'].map((f) => fs.readFileSync(path.join(DEMO, f), 'utf8')).join('\n');
  const lits = new Set([...code.matchAll(/'(start\.[a-z0-9_]+)'(?!\s*\+)/g)].map((m) => m[1]));
  const prefixes = [...code.matchAll(/'(start\.[a-z0-9_]*)'\s*\+/g)].map((m) => m[1]);
  assert.ok(!prefixes.includes('start.'), 'голый префикс start. скрыл бы «мёртвые» ключи');
  const keys = Object.keys(CATALOG.ru);
  assert.deepEqual(keys.filter((k) => !lits.has(k) && !prefixes.some((p) => k.startsWith(p))), []);
  assert.deepEqual([...lits].filter((k) => !keys.includes(k)), []);
});

// ── исправления после проверки: фокус, подсказка, таймер, подпись узкой точки ───────────────────────────────────────────

/** Довести пустой набор до s = 3 (прогноз виден): счёт, три небольших платежа, один доход. */
async function drive_to_forecast(p) {
  p.submit('st-form-acc', { 'st-acc-balance': '4000' });
  for (const [n, a, d] of [['a', '25', '2026-10-09'], ['b', '15', '2026-10-12'], ['c', '20', '2026-10-20']]) p.submit('st-form-obl', { 'st-obl-name': n, 'st-obl-amount': a, 'st-obl-date': d });
  p.click('st-next');
  p.submit('st-form-inc', { 'st-inc-amount': '2790', 'st-inc-date': '2026-11-05', 'st-inc-repeat': 'once' });
  assert.equal(p.score(), 3);
}

test('TST-58 REQ-110 фокус мастера переживает позднюю перерисовку: хранилище FP-05 после записи просит ctx.refresh() ещё раз и заменяет узел, на котором стоял фокус — заголовок нового шага получает фокус снова', async () => {
  const p = await make_page(EMPTY);
  p.submit('st-form-acc', { 'st-acc-balance': '4000' });
  await tick();
  const first = by_id(p.root(), 'st-step-title');
  assert.equal(first.focused, true, 'сразу после записи фокус на заголовке');
  for (let i = 1; i <= 3; i++) {
    p.ctx.refresh(); // поздняя перерисовка: прежний узел заменён, в настоящем браузере фокус ушёл на body
    await tick();
    const now = by_id(p.root(), 'st-step-title');
    assert.notEqual(now, first, 'узел заменён');
    assert.equal(now.focused, true, 'после поздней перерисовки № ' + i + ' заголовок нового шага снова в фокусе');
  }
  // запись, оставляющая шаг прежним (ещё один платёж): фокус на первом поле формы — и он тоже возвращается
  p.submit('st-form-obl', { 'st-obl-name': 'Аренда', 'st-obl-amount': '25', 'st-obl-date': '2026-10-09' });
  await tick();
  assert.equal(by_id(p.root(), 'st-obl-name').focused, true);
  p.ctx.refresh();
  await tick();
  assert.equal(by_id(p.root(), 'st-obl-name').focused, true, 'и после поздней перерисовки');
  // переход по шагам и шаблон — те же правила
  p.click('st-back');
  p.ctx.refresh();
  await tick();
  assert.equal(by_id(p.root(), 'st-step-title').focused, true);
  p.click('st-template-on');
  p.ctx.refresh();
  await tick();
  assert.equal(by_id(p.root(), 'st-template-off').focused, true, 'шаблон: фокус на кнопке, которая встала на место нажатой, и после поздней перерисовки');
});

test('TST-58 фокус не отбирается: если фокус стоит не «потерянным на body», а на чужом элементе (шапка, меню), мастер его не трогает; на body — возвращает', async () => {
  const doc = globalThis.document;
  const header_button = new FakeNode('button');
  try {
    const p = await make_page(EMPTY);
    doc.activeElement = header_button;
    p.submit('st-form-acc', { 'st-acc-balance': '4000' });
    await tick();
    p.ctx.refresh();
    await tick();
    assert.equal(by_id(p.root(), 'st-step-title').focused, false, 'фокус на чужом элементе: заголовок его не отбирает');
    doc.activeElement = doc.body; // узлы заменены, фокус ушёл на body
    p.ctx.refresh();
    await tick();
    assert.equal(by_id(p.root(), 'st-step-title').focused, true, 'на body — возвращается');
  } finally {
    delete doc.activeElement;
  }
});

test('TST-58 запрос фокуса действует ограниченное время (FOCUS_WINDOW_MS): позже перерисовка (смена языка, возврат на экран) фокус не перетягивает', async () => {
  const p = await make_page(EMPTY);
  assert.ok(Number.isInteger(W.FOCUS_WINDOW_MS) && W.FOCUS_WINDOW_MS >= 500 && W.FOCUS_WINDOW_MS <= 10_000);
  p.submit('st-form-acc', { 'st-acc-balance': '4000' });
  await tick();
  p.clock.t += W.FOCUS_WINDOW_MS - 1;
  p.ctx.refresh();
  await tick();
  assert.equal(by_id(p.root(), 'st-step-title').focused, true, 'внутри окна');
  p.clock.t += 5;
  p.ctx.refresh();
  await tick();
  assert.equal(by_id(p.root(), 'st-step-title').focused, false, 'окно прошло: фокус не перетягивается');
  assert.equal(p.deps.ui.focus, null, 'запрос снят');
  // отказ записи возвращает прежнее состояние, включая окно фокуса
  const ui_before = JSON.stringify(p.deps.ui);
  p.submit('st-form-obl', { 'st-obl-name': 'x', 'st-obl-amount': 'abc', 'st-obl-date': '2026-10-09' });
  assert.equal(JSON.stringify(p.deps.ui), ui_before, 'при отказе состояние экрана не изменилось');
});

test('REQ-110 подсказка шага «Обязательства» не противоречит отметке «учтено»: «n из 3» — только пока шаг не засчитан; засчитан одним крупным платежом — отдельная строка; три платежа — «достаточно»', async () => {
  const p = await make_page(EMPTY);
  const progress = (page) => find_all(page.root(), (n) => n.className === 'start-progress')[0].textContent;
  p.submit('st-form-acc', { 'st-acc-balance': '4000' });
  assert.equal(progress(p), tr('ru', 'start.obl_progress', { n: 0, need: 3 }));
  p.submit('st-form-obl', { 'st-obl-name': 'Мелочь', 'st-obl-amount': '25', 'st-obl-date': '2026-10-09' });
  let m = W.wizard_model(p.st.model);
  assert.equal(m.done.obligations, false);
  assert.equal(progress(p), tr('ru', 'start.obl_progress', { n: 1, need: 3 }), 'шаг не засчитан: «1 из 3»');
  assert.ok(by_id(p.root(), 'st-skip') !== undefined);
  // один крупный платёж: движок засчитывает шаг (значимый платёж), и строка этого не опровергает
  const big = await make_page(EMPTY);
  big.submit('st-form-acc', { 'st-acc-balance': '4000' });
  big.submit('st-form-obl', { 'st-obl-name': 'Аренда', 'st-obl-amount': '900', 'st-obl-date': '2026-10-25' });
  m = W.wizard_model(big.st.model);
  assert.equal(m.done.obligations, true, 'один значимый платёж засчитан расчётом');
  assert.equal(m.obligations.length, 1);
  const line = progress(big);
  assert.equal(line, tr('ru', 'start.obl_progress_engine', { n: 1 }));
  assert.ok(!/из\s+3/.test(line), 'нет «из 3» при засчитанном шаге: ' + line);
  assert.ok(by_id(big.root(), 'st-next') !== undefined && by_id(big.root(), 'st-skip') === undefined, 'вместо «Пропустить» — «Далее»');
  // три платежа
  for (const [n, a, d] of [['b', '15', '2026-10-12'], ['c', '20', '2026-10-20']]) big.submit('st-form-obl', { 'st-obl-name': n, 'st-obl-amount': a, 'st-obl-date': d });
  assert.equal(progress(big), tr('ru', 'start.obl_progress_ok', { n: 3, need: 3 }));
  // EN
  const en = await make_page(EMPTY, { lang: 'en' });
  en.submit('st-form-acc', { 'st-acc-balance': '4000' });
  en.submit('st-form-obl', { 'st-obl-name': 'Rent', 'st-obl-amount': '900', 'st-obl-date': '2026-10-25' });
  assert.equal(progress(en), tr('en', 'start.obl_progress_engine', { n: 1 }));
});

test('REQ-110 REQ-185 таймер шагов: время вне экрана «Старт» шагу не приписывается — повторная отрисовка того же шага (возврат, смена языка, поздняя перерисовка) ничего не засчитывает; действие и смена шага засчитывают', () => {
  const clock = { t: 0 };
  const tm = W.create_step_timer({ now_ms: () => clock.t, idle_cap_ms: 60_000, max_seconds: 3600 });
  tm.enter('obligations');
  clock.t += 3 * 3600_000; // три часа на другом экране
  tm.enter('obligations'); // возврат: перерисовка того же шага
  assert.equal(tm.seconds('obligations'), 0, 'часы простоя не засчитаны');
  clock.t += 4_000;
  assert.deepEqual(tm.done('obligations', 'skipped'), { step: 'obligations', seconds: 4, outcome: 'skipped' }, 'засчитана только работа после возврата');
  // смена шага по-прежнему засчитывает время прежнему шагу (запись шага: перерисовка → новый шаг, затем done прежнего)
  tm.enter('account');
  clock.t += 9_000;
  tm.enter('obligations');
  assert.equal(tm.seconds('account'), 9);
  // пауза без действий, но с последующим действием: засчитывается не больше предела простоя
  clock.t += 600_000;
  tm.touch();
  assert.equal(tm.seconds('obligations'), 60, 'пауза до действия — не больше минуты');
  // повторная отрисовка сдвигает «последний момент»: следующее действие считает от неё
  clock.t += 600_000;
  tm.enter('obligations');
  clock.t += 2_000;
  tm.touch();
  assert.equal(tm.seconds('obligations'), 62);
});

test('REQ-110 REQ-185 журнал времени: возврат на «Старт» через три часа не приписывает простой шагу; запись шага, не меняющего шаг (ещё один платёж), засчитывает время до отправки формы', async () => {
  const p = await make_page(EMPTY);
  p.clock.t += 5_000;
  p.click('st-skip'); // шаг «счёт» пропущен: 5 с
  p.clock.t += 3 * 3600_000; // ушли на другие экраны
  p.ctx.refresh(); // вернулись на «Старт»: перерисовка
  p.clock.t += 4_000;
  p.click('st-skip'); // шаг «обязательства» пропущен: 4 с работы
  assert.deepEqual(p.mx.package().steps.map((s) => [s.step, s.seconds, s.outcome]), [['account', 5, 'skipped'], ['obligations', 4, 'skipped']]);
  // запись без смены шага: отправка формы без отдельного щелчка (как при Enter в заглушке) засчитывает работу до отправки
  const q = await make_page(EMPTY);
  q.submit('st-form-acc', { 'st-acc-balance': '4000' });
  q.clock.t += 9_000;
  q.submit('st-form-obl', { 'st-obl-name': 'Аренда', 'st-obl-amount': '900', 'st-obl-date': '2026-10-25' });
  const last = q.mx.package().steps.at(-1);
  assert.deepEqual([last.step, last.seconds, last.outcome], ['obligations', 9, 'saved'], 'время до отправки засчитано шагу, хотя шаг после записи тот же');
});

test('REQ-110 прогноз мастера называет узкую точку «деньги на счетах», а не «свободно» (как «Обзор»): RU и EN', async () => {
  for (const lang of ['ru', 'en']) {
    const p = await make_page(EMPTY, { lang });
    await drive_to_forecast(p);
    const fc = by_id(p.root(), 'st-forecast').textContent;
    const suffix = lang === 'ru' ? '(деньги на счетах)' : '(money on accounts)';
    assert.equal(fc.split(suffix).length - 1, 2, lang + ': подпись у обоих режимов (по плану и если хуже)');
    assert.ok(tr(lang, 'start.fc_line', { value: '1', date: '2' }).endsWith(suffix));
    assert.ok(tr(lang, 'ov.narrow').includes(lang === 'ru' ? 'деньги на счетах' : 'money on accounts'), 'та же формулировка, что на «Обзоре»');
  }
});
