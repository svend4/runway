// prob_band.test.mjs — FP-11: вероятностная полоса P10–P90 и «при уверенности α максимум X» по согласию (demo/prob_band.mjs, prob_buy.mjs, quality.mjs; решение владельца № 3).
// Покрывает: TST-49 REQ-054 REQ-055 (полоса выключена по умолчанию; при n < 20 — «в k из n»; без истории — отказ; ни в одном шаблоне v1 нет ключа probability), согласие (флажок и подтверждение,
// ключ localStorage с префиксом runway, чистится «Удалить все данные», чужие ключи целы), метка «эксперимент, не обещание», «наибольшее / наименьшее из n», независимость от вердиктов и чисел Q1/Q3,
// воспроизводимость по seed, устаревание результата при смене данных, RU/EN, a11y (график с описанием и таблицей-двойником), TST-59. Ожидаемые числа: канон REQ-055 (2 из 8; 5 из 40 → ≈ 12,5 %
// (95 %: 5,5–26,1 %)) и лаги REQ-054 [0,3,7,5,14,6,2,9]; расчёт по введённым данным, не консультация.

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
const PB = await imp('demo', 'prob_band.mjs');
const PUY = await imp('demo', 'prob_buy.mjs');
const PACK = await imp('demo', 'pack_fp11.mjs');
const DA = await imp('demo', 'data_actions.mjs');
const NF = await imp('demo', 'number_format.mjs');
const GEN = await imp('data', 'synthetic-journals', 'generate.mjs');
const FORMS_CAT = (await imp('demo', 'i18n', 'forms.mjs')).default;
I18N.register_strings('forms', FORMS_CAT);
const load = (name) => JSON.parse(fs.readFileSync(path.join(PROTO, 'data', name), 'utf8'));
const G = load('g001.json');
const LATE = load('g001-late.json');
const N = (s) => String(s).replace(/[  ]/g, ' ');
const KEY = 'runway-prob-consent/1';

function fake_storage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return { m, get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
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
  const p = { e, ctx: e.ctx, st, deps: handles.qual, storage: store, find: (id) => by_id(st.root, id), text: () => N(st.root.textContent), ws: () => st.ws };
  p.click = (id) => { const b = by_id(st.root, id); assert.ok(b !== undefined, 'нет кнопки ' + id); return b.listeners.click[0](); };
  p.enable = () => {
    const box = p.find('qx-agree');
    box.checked = true;
    box.listeners.change[0]();
    p.click('qx-enable');
  };
  p.choose_source = (v) => { const sel = p.find('qx-source'); sel.value = v; sel.listeners.change[0]({ target: { value: v } }); };
  p.submit_buy = (amount, date, confidence = '90') => {
    p.find('fp08-qxbuy-amount').value = amount;
    p.find('fp08-qxbuy-date').value = date;
    p.find('fp08-qxbuy-confidence').value = confidence;
    return p.find('qx-buy-form').listeners.submit[0]({ preventDefault() {} });
  };
  return p;
}

/** Рабочая область с историей: синтетический журнал `reg02` за `months` месяцев до 2026-09-30. */
function history_ws(months = 15) {
  const start = months === 15 ? '2025-07-01' : '2024-07-01'; // 15 и 27 месяцев истории
  const spec = { ...GEN.regular_corpus()[1], start, end: '2026-09-30' };
  return { ...BR.events_to_ws(GEN.make_journal(spec)), as_of: '2026-09-30', decision_currency: 'EUR', locale: 'ru' };
}

/** Один регулярный доход (5-го числа) и восемь выплат с лагами REQ-054 [0,3,7,5,14,6,2,9], привязанных пользователем (match.set / plan_ref). */
function eight_lags_ws() {
  const lags = [0, 3, 7, 5, 14, 6, 2, 9];
  const rule = { rule_id: 'R-INC', account_id: 'acc_main', name: 'Клиент', kind: 'income', amount: { exp_minor: 300000 }, currency: 'EUR', freq: 'M', interval: 1, by_monthday: [5], start_date: '2026-01-05', month_end: 'clamp', weekend: 'keep', calendar_id: null, exdates: [], is_obligation: false, is_estimate: false, tag: 'клиент' };
  const facts = lags.map((lag, i) => {
    const m = String(i + 1).padStart(2, '0');
    const day = String(5 + lag).padStart(2, '0');
    return { event_id: 'F' + i, account_id: 'acc_main', date: `2026-${m}-${day}`, amount_minor: 300000, currency: 'EUR', kind: 'income', tag: 'клиент', plan_ref: `R-INC@2026-${m}-05` };
  });
  return {
    workspace_id: 'ws-8', name: 'Восемь выплат', locale: 'ru', decision_currency: 'EUR', as_of: '2026-08-31', params: { horizon_days: 30, buffer_minor: 50000 },
    accounts: [{ account_id: 'acc_main', name: 'Основной счёт', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2, liquidity_bp: 0 }],
    calendars: [], anchors: [{ anchor_id: 'a1', account_id: 'acc_main', date: '2026-01-01', amount_minor: 500000 }],
    facts, rules: [rule], overrides: [], plans: [], streams: [], tax_rules: [], reserves: [], allocations: [], rates: [], scenarios: [], purchases: [], debts: [], wave_overrides: [], counterparties: [],
  };
}

// ── по умолчанию выключено ───────────────────────────────────────────────────────────────────────────────────────────────

test('TST-49 REQ-054 по умолчанию выключено: экран «Качество» показывает «Сейчас: выключено», блоков полосы и «при уверенности α» нет, на «Обзоре» карточки коридора нет, в хранилище ничего не записано', async () => {
  const page = await make_page(G);
  assert.ok(page.find('qx-exp-state').textContent.includes('выключено'));
  assert.equal(page.find('qx-band'), undefined);
  assert.equal(page.find('qx-buy'), undefined);
  assert.equal(page.find('qx-source'), undefined);
  assert.equal(page.find('qx-agree').checked, false, 'флажок согласия не отмечен');
  assert.equal(page.storage.m.size, 0, 'простое открытие экрана ничего не пишет');
  assert.equal(PB.consent_on(page.deps), false);
  assert.equal(PB.render_band_card(page.ctx, page.deps), null, 'на «Обзоре» без согласия ничего нет');
  assert.ok(page.text().includes('Эксперимент, не обещание'), 'пометка есть и на выключенном блоке');
  assert.ok(page.text().includes('выключены по умолчанию'));
  assert.equal(find_all(page.st.root, (n) => n.tagName === 'svg').length, 0, 'графика коридора нет');
  assert.ok(!/P10 (ниже)/.test(page.text()), 'таблицы коридора нет');
});

test('REQ-055 согласие — флажок и подтверждение: кнопка без флажка не включает (ошибка у флажка), с флажком — пишет ключ runway-prob-consent/1 без дат и сумм, открывает блоки; «Выключить» убирает ключ', async () => {
  const page = await make_page(G);
  page.click('qx-enable');
  assert.equal(PB.consent_on(page.deps), false, 'без флажка не включается');
  assert.ok(page.find('qx-agree-err').textContent.includes('Эксперимент включается только после отметки согласия'));
  assert.equal(page.storage.m.size, 0);
  page.enable();
  assert.equal(page.storage.m.get(KEY), '{"v":1,"experiment":true}');
  assert.equal(PB.consent_on(page.deps), true);
  assert.ok(page.find('qx-band') !== undefined && page.find('qx-buy') !== undefined);
  assert.ok(page.find('qx-exp-state').textContent.includes('включено'));
  assert.ok(page.st.notes.some(([t]) => t.includes('Эксперимент включён')));
  assert.equal(page.find('qx-agree'), undefined, 'форма согласия скрыта, пока оно действует');
  page.click('qx-disable');
  assert.equal(page.storage.m.has(KEY), false);
  assert.equal(PB.consent_on(page.deps), false);
  assert.equal(page.find('qx-band'), undefined);
});

test('REQ-055 ключ согласия переживает перезагрузку (то же хранилище), «Удалить все данные» стирает его вместе с остальными ключами runway, чужие ключи общего localhost целы', async () => {
  const foreign = { 'portal-v9-theme': 'dark', 'nexus.save': '{"keep":1}' };
  const storage = fake_storage(foreign);
  const a = await make_page(G, { storage });
  a.enable();
  assert.equal(storage.m.get(KEY), '{"v":1,"experiment":true}');
  const b = await make_page(G, { storage });
  assert.equal(PB.consent_on(b.deps), true, 'после перезагрузки согласие на месте');
  assert.ok(b.find('qx-band') !== undefined);
  const res = await DA.erase_all({ storage, today: () => '2026-10-09' });
  assert.equal(res.erased, true);
  assert.equal(storage.m.has(KEY), false, 'ключ с префиксом runway стёрт');
  assert.deepEqual([...storage.m.keys()].sort(), ['nexus.save', 'portal-v9-theme'], 'чужое не тронуто');
  b.ctx.refresh();
  assert.equal(PB.consent_on(b.deps), false, 'после стирания блоки снова выключены');
  assert.equal(b.find('qx-band'), undefined);
  assert.ok(KEY.startsWith(DA.LOCAL_PREFIX), 'префикс ключа — тот, что стирает eraseAll');
});

test('REQ-055 чтение согласия устойчиво: мусор, чужая версия, experiment ≠ true, сбой хранилища — «выключено»; без хранилища согласие живёт до перезагрузки, об этом сказано', async () => {
  const st = (v) => ({ getItem: () => v });
  for (const bad of [null, '', 'oops', '{}', '{"v":2,"experiment":true}', '{"v":1}', '{"v":1,"experiment":false}', '{"v":1,"experiment":"yes"}', '[]', '5']) assert.equal(PB.read_consent(st(bad)), false, String(bad));
  assert.equal(PB.read_consent({ getItem() { throw new Error('private mode'); } }), false);
  assert.equal(PB.read_consent(st('{"v":1,"experiment":true}')), true);
  assert.equal(PB.write_consent(null, true), false);
  assert.equal(PB.write_consent({ setItem() { throw new Error('quota'); } }, true), false);
  assert.equal(PB.read_consent(null, { mem: true }), true);
  const page = await make_page(G, { no_storage: true });
  assert.ok(page.text().includes('Хранилище браузера недоступно'));
  page.enable();
  assert.equal(PB.consent_on(page.deps), true, 'до перезагрузки действует');
  assert.ok(page.find('qx-band') !== undefined);
});

// ── честная подача ───────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-055 present_text: 2 из 8 → «в 2 из 8 прошлых случаев»; 5 из 40 → «≈ 12,5 % (95 %: 5,5–26,1 %)»; мало наблюдений и нет истории — слова, не проценты', () => {
  const ru = (key, p) => I18N.t('ru', key, p);
  const en = (key, p) => I18N.t('en', key, p);
  const f_ru = NF.make_nf_fmt('ru', 'EUR', '2026-10-04');
  const f_en = NF.make_nf_fmt('en', 'EUR', '2026-10-04');
  assert.equal(PB.present_text(ru, { kind: 'count', k: 2, n: 8 }, PB.pm_number(f_ru)), 'в 2 из 8 прошлых случаев');
  const w = ENGINE.wilson(5, 40, 196);
  assert.deepEqual([ENGINE.round_div(1000 * 5, 40), w.lo_pm, w.hi_pm], [125, 55, 261]);
  const interval = { kind: 'interval', p_pm: 125, lo_pm: 55, hi_pm: 261, n: 40 };
  assert.ok(N(PB.present_text(ru, interval, PB.pm_number(f_ru))).startsWith('≈ 12,5 % (95 %: 5,5–26,1 %)'), PB.present_text(ru, interval, PB.pm_number(f_ru)));
  assert.ok(N(PB.present_text(en, interval, PB.pm_number(f_en))).startsWith('≈ 12.5 % (95 %: 5.5–26.1 %)'));
  const small = PB.present_text(ru, { kind: 'none', reason: 'small_sample', n: 15 }, PB.pm_number(f_ru));
  assert.ok(small.includes('мало наблюдений (n = 15)') && !small.includes('≈') && !/\d\s?%/.test(small), small);
  assert.ok(PB.present_text(ru, { kind: 'none', reason: 'no_history' }, PB.pm_number(f_ru)).includes('нет истории'));
});

test('TST-49 без истории — отказ: коридор и «при уверенности α» не строятся, названы потоки без наблюдений; цифр нет', async () => {
  const no_income = { ...LATE, as_of: '2026-10-04', facts: LATE.facts.filter((f) => f.amount_minor < 0) };
  const page = await make_page(no_income);
  page.enable();
  page.click('qx-band-run');
  const refusal = page.find('qx-band-refusal');
  assert.ok(refusal !== undefined, page.text().slice(0, 500));
  assert.ok(refusal.textContent.includes('Нет истории по: Почасовая работа'), refusal.textContent);
  assert.equal(find_all(page.find('qx-band-result'), (n) => n.tagName === 'svg' || n.tagName === 'table').length, 0, 'ни графика, ни таблицы');
  page.submit_buy('300,00', '2026-10-12');
  const buy = page.find('qx-buy-refusal');
  assert.ok(buy !== undefined && buy.textContent.includes('Нет истории по: Почасовая работа'));
  assert.equal(page.find('qx-buy-lines'), undefined);
});

test('TST-49 REQ-055 восемь прошлых выплат (лаги REQ-054): полный перебор — «в k из 8 прошлых случаев», проценты не показываются; P10 — «наименьшее из 8», P90 — «наибольшее из 8»', async () => {
  const page = await make_page(eight_lags_ws());
  assert.equal(ENGINE.analyze(page.ws(), { as_of: page.ws().as_of }).events.plan.filter((e) => e.kind === 'income').length, 1, 'один доход в горизонте');
  page.enable();
  page.click('qx-band-run');
  const notes = N(page.find('qx-band-notes').textContent);
  assert.ok(notes.includes('Наблюдений n = 8; путей: 8 (полный перебор наблюдений)'), notes);
  assert.match(notes, /Остаток уходил ниже нуля: в \d+ из 8 прошлых случаев/);
  assert.ok(notes.includes('P10 здесь — наименьшее из 8.') && notes.includes('P90 здесь — наибольшее из 8.'), notes);
  assert.ok(!notes.includes('≈') && !/\(95 %/.test(notes), 'интервал Уилсона при n < 20 не подаётся');
  assert.ok(page.text().includes('Эксперимент, не обещание'));
  page.submit_buy('300,00', '2026-09-02');
  const lines = N(page.find('qx-buy-lines').textContent);
  assert.match(lines, /При уверенности 90 % максимум .+ \(наименьшее из 8\): по 8 прошлым случаям\./);
  assert.match(lines, /При покупке 300,00 € буфер нарушился бы в \d+ из 8 прошлых случаев\./);
  assert.ok(!lines.includes('≈') && !/\(95 %/.test(lines), 'без процентной вероятности: ' + lines);
});

test('REQ-055 мало наблюдений при выборке: n = 15 < 20 — процент не показывается («мало наблюдений»), сумма подаётся как осторожная оценка по n; при n = 24 ≥ 20 — «≈ p % (95 %: …)» по интервалу Уилсона', async () => {
  const few = await make_page(history_ws(15));
  few.enable();
  few.choose_source('mine');
  few.click('qx-band-run');
  const notes = N(few.find('qx-band-notes').textContent);
  assert.ok(notes.includes('Наблюдений n = 15'), notes);
  assert.ok(notes.includes('(выборка)'));
  assert.ok(notes.includes('мало наблюдений (n = 15): доля процентом не показывается'), notes);
  few.submit_buy('300,00', '2026-10-05');
  const lines = N(few.find('qx-buy-lines').textContent);
  assert.match(lines, /Мало наблюдений \(n = 15\): проценты не показываются\. Осторожная оценка максимума: .+ по 15 прошлым случаям\./, lines);
  assert.ok(!lines.includes('≈'));

  const many = await make_page(history_ws(27));
  many.enable();
  many.click('qx-band-run');
  const m_notes = N(many.find('qx-band-notes').textContent);
  assert.ok(m_notes.includes('Наблюдений n = 24'), m_notes);
  assert.match(m_notes, /Остаток уходил ниже нуля: ≈ \d+,\d % \(95 %: \d+,\d–\d+,\d %\), наблюдений n = 24/, m_notes);
  many.submit_buy('300,00', '2026-10-05');
  const m_lines = N(many.find('qx-buy-lines').textContent);
  assert.match(m_lines, /При уверенности 90 % максимум .+ \(n = 24 наблюдений\)\./, m_lines);
  assert.match(m_lines, /доля нарушений буфера ≈ \d+,\d % \(95 %: \d+,\d–\d+,\d %\), n = 24\./, m_lines);
});

test('ADR-015 полоса и оценка не меняют вердикты и числа Q1/Q3: рабочая область, журнал и ряды расчёта до и после — те же; «Купить» остаётся детерминированным', async () => {
  const page = await make_page(G);
  const series_before = JSON.stringify(page.st.model.ctx.series);
  const q1_before = JSON.stringify(page.st.model.ctx.q1);
  const ws_before = page.ws();
  const n_before = page.ctx.journal.length;
  const buy = { currency: 'EUR', parts: [{ date: '2026-10-12', amount_minor: 30000 }] };
  const verdict_before = JSON.stringify(ENGINE.check_purchase(page.st.model.ctx, buy, page.st.model.ctx.buffer_minor));
  page.enable();
  page.choose_source('mine');
  page.click('qx-band-run');
  page.submit_buy('300,00', '2026-10-12');
  assert.equal(page.ws(), ws_before, 'рабочая область — тот же объект: ничего не записано');
  assert.equal(page.ctx.journal.length, n_before, 'журнал не вырос');
  assert.equal(JSON.stringify(page.st.model.ctx.series), series_before);
  assert.equal(JSON.stringify(page.st.model.ctx.q1), q1_before);
  assert.equal(JSON.stringify(ENGINE.check_purchase(page.st.model.ctx, buy, page.st.model.ctx.buffer_minor)), verdict_before);
  assert.equal(JSON.parse(verdict_before).verdict, 'FRAGILE', 'канон G-001: покупка 300 € 12 октября — «хрупко»');
  assert.ok(page.find('qx-buy-lines') !== undefined, 'оценка показана');
  assert.ok(page.text().includes('Ответ «могу ли я купить» на'), 'сказано, что вердикт отдельный');
});

test('TST-48 воспроизводимость: тот же расчёт даёт тот же текст и seed; смена данных делает результат устаревшим; источник «синтетический пример» подписан и данные пользователя не трогает', async () => {
  const page = await make_page(history_ws(15));
  page.enable();
  page.click('qx-band-run');
  const first = N(page.find('qx-band-result').textContent);
  page.click('qx-band-run');
  assert.equal(N(page.find('qx-band-result').textContent), first, 'тот же seed — тот же результат');
  assert.match(first, /seed \d+/);
  // смена данных: буфер → другой inputs_hash → результат устарел и не показывается как свежий
  const r = page.ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 70000 });
  assert.equal(r.ok, true);
  assert.ok(page.find('qx-band-hint').textContent.includes('изменились после расчёта'));
  assert.equal(find_all(page.find('qx-band-result'), (n) => n.tagName === 'svg').length, 0);
  // синтетический пример
  const g = await make_page(G);
  g.enable();
  g.choose_source('synthetic');
  g.click('qx-band-run');
  assert.ok(g.find('qx-band-synth').textContent.includes('Синтетика'), 'пометка «синтетика»');
  assert.ok(N(g.find('qx-band-notes').textContent).includes('Наблюдений n = 15'));
  assert.equal(g.ws(), G, 'рабочая область пользователя не заменена');
});

test('REQ-054 коридор: график с описанием и таблица-двойник (недели), P10 ≤ P50 ≤ P90 в строках; карточка «Обзора» появляется только при согласии и показывает график после расчёта', async () => {
  const page = await make_page(eight_lags_ws());
  page.enable();
  page.click('qx-band-run');
  const svg = find_all(page.find('qx-band-result'), (n) => n.tagName === 'svg')[0];
  assert.equal(svg.attrs.role, 'img');
  assert.match(svg.attrs['aria-label'], /^Коридор остатка с .+ по .+: от .+ до .+$/);
  assert.equal(svg.attrs.style, undefined, 'без inline-стилей');
  const rows = find_all(page.find('qx-band-result'), (n) => n.tagName === 'tr').slice(1);
  assert.ok(rows.length >= 4);
  const money = (t) => Number(N(t).replace(/[^\d−-]/g, '').replace('−', '-'));
  for (const r of rows) {
    const c = find_all(r, (n) => n.tagName === 'td').map((x) => money(x.textContent));
    assert.ok(c[1] <= c[2] && c[2] <= c[3], c.join(','));
  }
  assert.equal(find_all(page.find('qx-band-result'), (n) => n.tagName === 'caption').length, 1);
  const card = PB.render_band_card(page.ctx, page.deps);
  assert.ok(card !== null);
  assert.ok(find_all(card, (n) => n.tagName === 'svg').length === 1);
  assert.equal(find_all(card, (n) => n.tagName === 'a')[0].attrs.href, '#quality');
  const off = await make_page(eight_lags_ws());
  assert.equal(PB.render_band_card(off.ctx, off.deps), null);
  off.enable();
  const fresh_card = PB.render_band_card(off.ctx, off.deps);
  assert.ok(N(fresh_card.textContent).includes('Коридор ещё не посчитан'));
});

test('REQ-054 возмущения по выбору: отклонения оценочных трат и курсы добавляются флажками; «задержки платежей» нельзя отключить; смена набора возмущений делает результат устаревшим', async () => {
  const page = await make_page(history_ws(15));
  page.enable();
  const lag = page.find('qx-kind-lag');
  assert.equal(lag.attrs.disabled, '');
  assert.deepEqual(PB.kinds_of(page.deps), ['lag']);
  const ratio = page.find('fp08-qxk-ratio');
  ratio.checked = true;
  ratio.listeners.change[0]();
  assert.deepEqual(PB.kinds_of(page.deps), ['lag', 'ratio']);
  page.click('qx-band-run');
  assert.ok(page.find('qx-band-notes') !== undefined);
  const fx = page.find('fp08-qxk-fx');
  fx.checked = true;
  fx.listeners.change[0]();
  page.ctx.refresh();
  assert.ok(page.find('qx-band-hint') !== undefined, 'набор возмущений изменился — результат устарел');
});

test('REQ-054 отказы формы «при уверенности α»: пустая сумма, неверная дата, дата за горизонтом, нет буфера — слова у поля или в строке отказа, расчёта нет', async () => {
  const page = await make_page(eight_lags_ws());
  page.enable();
  page.submit_buy('', '2026-09-02');
  assert.ok(page.find('fp08-qxbuy-amount-err').textContent.length > 0);
  assert.equal(page.find('fp08-qxbuy-amount').attrs['aria-invalid'], 'true');
  page.submit_buy('300,00', '2026-13-45');
  assert.ok(page.find('fp08-qxbuy-date-err').textContent.length > 0);
  page.submit_buy('300,00', '2027-03-01');
  assert.ok(page.find('qx-buy-refusal').textContent.includes('Дата за горизонтом'));
  page.submit_buy('300,00', '2026-08-01');
  assert.ok(page.find('qx-buy-refusal').textContent.includes('Дата раньше даты расчёта'));
  const no_buf = { ...eight_lags_ws(), params: { horizon_days: 30, buffer_minor: null } };
  const nb = await make_page(no_buf);
  nb.enable();
  nb.submit_buy('300,00', '2026-09-02');
  assert.ok(nb.find('qx-buy-refusal').textContent.includes('Буфер не задан'));
});

test('a11y TST-59: подписи полей, role=alert у ошибок, role=status у состояния, видимая метка «Эксперимент, не обещание» у каждого вероятностного блока; RU и EN', async () => {
  const page = await make_page(eight_lags_ws());
  page.enable();
  for (const id of ['qx-exp', 'qx-band', 'qx-buy']) {
    const sec = page.find(id);
    assert.ok(find_all(sec, (n) => n.className === 'qx-badge' && n.textContent === 'Эксперимент, не обещание').length >= 1, id);
    assert.ok(sec.attrs['aria-labelledby'] !== undefined, id);
  }
  assert.equal(page.find('qx-exp-state').attrs.role, 'status');
  for (const id of ['fp08-qxbuy-amount', 'fp08-qxbuy-date', 'fp08-qxbuy-confidence', 'qx-source']) {
    assert.equal(find_all(page.st.root, (n) => n.tagName === 'label' && n.attrs.for === id).length, 1, 'подпись для ' + id);
  }
  assert.equal(page.find('fp08-qxbuy-amount-err').attrs.role, 'alert');
  const en = await make_page(eight_lags_ws(), { lang: 'en' });
  en.enable();
  en.click('qx-band-run');
  assert.ok(en.text().includes('Experiment, not a promise'));
  assert.ok(N(en.find('qx-band-notes').textContent).includes('Observations n = 8; paths: 8 (all observations enumerated)'), N(en.find('qx-band-notes').textContent));
  assert.match(N(en.find('qx-band-notes').textContent), /The balance fell below zero: in \d+ of 8 past cases/);
  assert.ok(N(en.find('qx-band-notes').textContent).includes('P10 here is the smallest of 8.'));
});

test('ADR-015 TST-49 в шаблонах ответов v1 ключа probability нет: ни в языковых наборах шаблонов, ни в словаре; обещающих формулировок нет в экране', async () => {
  const V = await imp('engine', 'verifier.mjs');
  const dump = JSON.stringify(Object.fromEntries(Object.entries(V).filter(([, v]) => typeof v !== 'function')));
  assert.ok(!/"probability"/.test(dump), 'ключ probability в экспортах verifier');
  for (const lang of ['ru', 'en']) {
    const tpl = typeof V.templates === 'function' ? V.templates(lang) : null;
    if (tpl !== null) assert.ok(!JSON.stringify(tpl).includes('probability'), 'шаблоны ' + lang);
  }
  const page = await make_page(eight_lags_ws());
  page.enable();
  page.click('qx-band-run');
  page.submit_buy('300,00', '2026-09-02');
  const text = page.text().toLowerCase();
  for (const bad of ['гарантируем', 'точный прогноз', 'вероятность успеха', 'безопасно', 'прогноз точен', 'вы не уйдёте в минус']) assert.ok(!text.includes(bad), bad);
  assert.ok(!/"v":1,"probability"/.test(JSON.stringify([...(page.storage?.m?.values?.() ?? [])])), 'согласие хранится без поля probability');
});

test('REQ-054 пакет: карточка коридора в слоте «Обзора» не меняет «Обзор» без согласия; пакет перезапускается без ошибок, смена набора данных сбрасывает посчитанное', async () => {
  const page = await make_page(eight_lags_ws(), { view: 'overview' });
  const nodes = page.e.slot_nodes('overview.cards', page.ctx);
  const text = N(nodes.map((n) => n.textContent).join(' '));
  assert.ok(!text.includes('Коридор остатка'), 'без согласия карточки нет');
  page.deps.band = { key: 'x', result: { ok: true } };
  page.e.ctx.subscribe(() => {});
  assert.deepEqual(page.e.diagnostics().filter((d) => d.status === 'failed'), []);
  const q = await make_page(eight_lags_ws());
  q.enable();
  q.click('qx-band-run');
  assert.ok(q.deps.band.result !== null);
  assert.equal(typeof PUY.parse_buy_form, 'function');
  assert.deepEqual(PUY.parse_buy_form({ cur: 'EUR', lang: 'ru', as_of: '2026-08-31', nf: undefined }, { amount: '300,00', date: '2026-09-02', confidence: '90' }).ok, true);
  assert.equal(PUY.parse_buy_form({ cur: 'EUR', lang: 'ru', as_of: '2026-08-31' }, { amount: '300,00', date: '2026-09-02', confidence: '77' }).ok, false);
});

// ── исправления после независимой проверки FP-11 ───────────────────────────────────────────────────────────────────────────

test('FP-11 исправление (средний дефект): оценка «при уверенности α» после смены набора возмущений помечается устаревшей, как и коридор; возврат набора возвращает посчитанный результат (RU и EN)', async () => {
  for (const [lang, amount, stale_text] of [['ru', '300,00', 'Данные или настройки изменились после расчёта'], ['en', '300.00', 'The data or settings changed after the calculation']]) {
    const page = await make_page(history_ws(15), { lang });
    page.enable();
    // до первого расчёта — приглашение ввести сумму, а не «устарело»
    assert.ok(page.find('qx-buy-hint') !== undefined && page.find('qx-buy-stale') === undefined, lang);
    page.click('qx-band-run');
    page.submit_buy(amount, '2026-10-05');
    const fresh = page.find('qx-buy-lines');
    assert.ok(fresh !== undefined, lang + ': оценка посчитана');
    const fresh_text = N(fresh.textContent);
    assert.equal(page.find('qx-buy-stale'), undefined);
    // набор возмущений изменился (отклонения оценочных трат): результат считался для другого набора
    const ratio = page.find('fp08-qxk-ratio');
    ratio.checked = true;
    ratio.listeners.change[0]();
    page.ctx.refresh();
    assert.equal(page.find('qx-buy-lines'), undefined, lang + ': устаревший результат не показывается как свежий');
    const stale = page.find('qx-buy-stale');
    assert.ok(stale !== undefined && N(stale.textContent).includes(stale_text), lang + ': подсказка «устарело»');
    assert.ok(page.find('qx-band-hint') !== undefined, 'коридор помечен так же');
    // курсы валют — тоже часть набора
    const fx = page.find('fp08-qxk-fx');
    fx.checked = true;
    fx.listeners.change[0]();
    page.ctx.refresh();
    assert.equal(page.find('qx-buy-lines'), undefined);
    assert.ok(page.find('qx-buy-stale') !== undefined);
    // пересчёт для нового набора даёт свежий результат; возврат к первому набору — ключ не совпадает уже со вторым
    page.submit_buy(amount, '2026-10-05');
    assert.ok(page.find('qx-buy-lines') !== undefined && page.find('qx-buy-stale') === undefined, lang + ': пересчитано');
    const ratio2 = page.find('fp08-qxk-ratio');
    ratio2.checked = false;
    ratio2.listeners.change[0]();
    const fx2 = page.find('fp08-qxk-fx');
    fx2.checked = false;
    fx2.listeners.change[0]();
    page.ctx.refresh();
    assert.equal(page.find('qx-buy-lines'), undefined, lang + ': набор снова другой');
    assert.ok(page.find('qx-buy-stale') !== undefined);
    assert.ok(fresh_text.length > 0);
  }
});

test('FP-11 исправление: ключ расчёта «при уверенности α» начинается с общего префикса (источник, inputs_hash, набор возмущений), смена любого из них меняет префикс', async () => {
  const page = await make_page(history_ws(15));
  page.enable();
  const src = PB.source_of(page.ctx, page.deps);
  const base = PUY.buy_key_prefix(src, page.deps);
  assert.ok(base.endsWith('|') && base.startsWith('m|' + src.analysis.inputs_hash + '|lag|'), base);
  page.submit_buy('300,00', '2026-10-05');
  assert.ok(page.deps.buy.key.startsWith(base), 'ключ записи начинается с префикса проверки');
  page.deps.ui.kinds.ratio = true;
  const with_ratio = PUY.buy_key_prefix(src, page.deps);
  assert.notEqual(with_ratio, base);
  assert.ok(with_ratio.includes('|lag+ratio|'));
  assert.ok(!page.deps.buy.key.startsWith(with_ratio), 'прежний результат не подходит к новому набору');
  page.deps.ui.kinds.ratio = false;
  page.deps.ui.source = 'synthetic';
  const synth = PUY.buy_key_prefix({ ...PB.source_of(page.ctx, page.deps) }, page.deps);
  assert.ok(synth.startsWith('s|') && synth !== base);
});

test('FP-11 исправление: если запись согласия не удалась (хранилище читается, но квота исчерпана), экран не противоречит уведомлению — согласие действует до перезагрузки, об этом сказано; «Выключить» снимает его', async () => {
  const storage = fake_storage();
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  const page = await make_page(G, { storage });
  assert.equal(page.find('qx-exp-nostorage'), undefined, 'пока запись не пробовали, предупреждения нет');
  assert.equal(PB.consent_on(page.deps), false);
  page.enable();
  assert.ok(page.st.notes.some(([t]) => t.startsWith('Эксперимент включён')), 'уведомление «включён»');
  assert.equal(PB.consent_on(page.deps), true, 'и состояние на экране то же');
  assert.ok(page.find('qx-exp-state').textContent.includes('включено'));
  assert.ok(page.find('qx-band') !== undefined && page.find('qx-buy') !== undefined, 'блоки открыты');
  const warn = page.find('qx-exp-nostorage');
  assert.ok(warn !== undefined && N(warn.textContent).includes('Хранилище браузера недоступно') && N(warn.textContent).includes('до перезагрузки'));
  assert.equal(storage.m.has(KEY), false, 'в хранилище ничего не записано');
  page.click('qx-disable');
  assert.equal(PB.consent_on(page.deps), false);
  assert.equal(page.find('qx-band'), undefined);
  assert.equal(page.find('qx-exp-nostorage'), undefined, 'после выключения предупреждение снято');
  const again = await make_page(G, { storage });
  assert.equal(PB.consent_on(again.deps), false, 'после перезагрузки согласия нет');
  // английский текст
  const en = await make_page(G, { storage, lang: 'en' });
  en.enable();
  assert.ok(N(en.find('qx-exp-nostorage').textContent).includes('Browser storage is unavailable'));
  assert.ok(en.find('qx-exp-state').textContent.includes('on'));
});

test('FP-11 исправление: read_consent учитывает согласие на время сеанса (mem) при пустом ключе, мусоре и сбое чтения; по умолчанию и без mem — «выключено»', () => {
  const st = (v) => ({ getItem: () => v });
  for (const stored of [null, 'oops', '{}']) {
    assert.equal(PB.read_consent(st(stored), { mem: true }), true, String(stored));
    assert.equal(PB.read_consent(st(stored), { mem: false }), false, String(stored));
    assert.equal(PB.read_consent(st(stored)), false, String(stored));
  }
  const broken = { getItem() { throw new Error('private mode'); } };
  assert.equal(PB.read_consent(broken, { mem: true }), true);
  assert.equal(PB.read_consent(broken, { mem: false }), false);
  assert.equal(PB.read_consent(st('{"v":1,"experiment":true}'), { mem: false }), true);
  assert.equal(PB.read_consent(null, { mem: true }), true);
  assert.equal(PB.read_consent(undefined, {}), false);
});
