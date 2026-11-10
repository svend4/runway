// quality_report.test.mjs — FP-11: отчёт backtest на синтетических журналах и экран «Качество прогноза» (tools/backtest_report.mjs, data/backtest-report.json, demo/quality.mjs).
// Покрывает: TST-55 REQ-176 (FRR, cry-wolf, n и дата на data/synthetic-journals; release_gate читает отчёт; гейт «обычных» проходит, «стресс» — нет по FRR), REQ-188 (число волн, доля волн
// из одного платежа, чувствительность к g ± 1 и S ± 3 на ≥ 10 журналах в vocab-совместимом файле), пометка «синтетика» на экране, «Привычки платежей» только при n ≥ 10 (REQ-053),
// ряд «ожидаемый» как оценка, RU/EN, TST-56 (каталог quality), TST-59. Ожидаемые числа — из замка tests/backtest.test.mjs (счётчики корпусов) и ручного расчёта волн.
// Дата замера — аргумент инструмента (часы не читаются). Расчёт по введённым данным, не консультация.

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
const Q = await imp('demo', 'quality.mjs');
const PACK = await imp('demo', 'pack_fp11.mjs');
const MIRROR = await imp('demo', 'quality_report.mjs');
const TOOL = await imp('tools', 'backtest_report.mjs');
const GEN = await imp('data', 'synthetic-journals', 'generate.mjs');
const BT = await imp('engine', 'backtest.mjs');
const Q_CAT = (await imp('demo', 'i18n', 'quality.mjs')).default;
const FORMS_CAT = (await imp('demo', 'i18n', 'forms.mjs')).default;
I18N.register_strings('forms', FORMS_CAT);

const REPORT_FILE = path.join(PROTO, 'data', 'backtest-report.json');
const REPORT = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
const MANIFEST = JSON.parse(fs.readFileSync(path.join(PROTO, 'data', 'synthetic-journals', 'manifest.json'), 'utf8'));
const VOCAB = JSON.parse(fs.readFileSync(path.join(PROTO, 'engine', 'vocab.json'), 'utf8'));
const load = (name) => JSON.parse(fs.readFileSync(path.join(PROTO, 'data', name), 'utf8'));
const N = (s) => String(s).replace(/[  ]/g, ' ');

// ── отчёт ────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('TST-55 REQ-176 файл отчёта: формат, пометка «синтетика», дата замера, версия движка, привязка к корпусам; ключи params — из vocab.json; validate_report не находит нарушений', () => {
  assert.equal(REPORT.format, 'runway-backtest-report/1');
  assert.equal(REPORT.synthetic, true);
  assert.match(REPORT.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(REPORT.engine_version, ENGINE.ENGINE_VERSION);
  assert.equal(REPORT.corpus_sha256, ENGINE.sha256(ENGINE.canon(MANIFEST.corpora)), 'отчёт привязан к тем самым журналам манифеста');
  for (const k of Object.keys(REPORT.params)) assert.ok(Object.hasOwn(VOCAB.params, k), 'ключ params не из vocab.json: ' + k);
  assert.equal(REPORT.params['wave.gap_days'], VOCAB.params['wave.gap_days'].default);
  assert.equal(REPORT.params['wave.max_span_days'], VOCAB.params['wave.max_span_days'].default);
  assert.equal(REPORT.params['backtest.h_days'], VOCAB.params['backtest.h_days'].default);
  assert.deepEqual(TOOL.validate_report(REPORT), []);
  assert.match(REPORT.source, /СИНТЕТИКА/);
  assert.equal(REPORT.n_journals, 22);
});

test('TST-55 REQ-176 счётчики совпадают с замком tests/backtest.test.mjs: «обычные» 1/117 и 7/18 — гейт проходит; «стресс» 7/32 и 3/72 — не проходит по FRR', () => {
  const r = REPORT.corpora.regular;
  const s = REPORT.corpora.stress;
  assert.deepEqual([r.frr.k, r.frr.n, r.cry_wolf.k, r.cry_wolf.n], [1, 117, 7, 18]);
  assert.deepEqual([r.frr.bp, r.cry_wolf.bp], [85, 3889]);
  assert.deepEqual([s.frr.k, s.frr.n, s.cry_wolf.k, s.cry_wolf.n], [7, 32, 3, 72]);
  assert.deepEqual([s.frr.bp, s.cry_wolf.bp], [2188, 417]);
  assert.equal(r.n_journals, 12);
  assert.equal(s.n_journals, 10);
  assert.equal(r.gate.pass, true);
  assert.deepEqual(r.gate.reasons, []);
  assert.equal(s.gate.pass, false);
  assert.deepEqual(s.gate.reasons, ['frr_above_5pct']);
  // независимый подсчёт: сумма по строкам журналов
  for (const c of [r, s]) {
    assert.equal(c.frr.k, c.journals.reduce((a, x) => a + x.frr.k, 0));
    assert.equal(c.cry_wolf.n, c.journals.reduce((a, x) => a + x.cry_wolf.n, 0));
    assert.ok(c.journals.every((x) => x.n_origins >= 3), 'начал прогноза не меньше порога calib.min_origins');
  }
});

test('TST-55 REQ-176 release_gate читает отчёт: гейт по строкам журналов равен записанному, ручные пороги 5 % и 50 % (10000·K ≤ 500·N) сходятся', () => {
  const reg = TOOL.gate_from_report(REPORT, 'regular');
  const str = TOOL.gate_from_report(REPORT, 'stress');
  assert.equal(reg.pass, true);
  assert.equal(str.pass, false);
  assert.deepEqual([reg.k1, reg.n1, reg.k2, reg.n2], [1, 117, 7, 18]);
  assert.deepEqual([str.k1, str.n1, str.k2, str.n2], [7, 32, 3, 72]);
  assert.ok(10000 * reg.k1 <= 500 * reg.n1 && 10000 * reg.k2 <= 5000 * reg.n2);
  assert.ok(10000 * str.k1 > 500 * str.n1, 'ложное спокойствие стресс-журналов: FRR выше 5 %');
  assert.deepEqual(reg, BT.release_gate(REPORT.corpora.regular.journals));
  assert.equal(reg.pass, REPORT.corpora.regular.gate.pass);
  // «меньше 10 журналов» отчёт отвергает как гейт: срез из девяти строк даёт причину journals_lt_10
  const nine = { ...REPORT, corpora: { ...REPORT.corpora, regular: { ...REPORT.corpora.regular, n_journals: 9, journals: REPORT.corpora.regular.journals.slice(0, 9) } } };
  assert.ok(TOOL.validate_report(nine).length > 0, 'файл, правленный руками, не проходит проверку');
  assert.throws(() => TOOL.gate_from_report(nine, 'regular'), (e) => e.code === 'E_SCHEMA');
  assert.throws(() => TOOL.gate_from_report(REPORT, 'nope'), (e) => e.code === 'E_SCHEMA');
});

test('TST-55 validate_report находит правку руками: счётчик, гейт, пометка «синтетика», ключ вне vocab, число журналов, неверная дата', () => {
  const clone = () => JSON.parse(JSON.stringify(REPORT));
  const bad = (f) => { const r = clone(); f(r); return TOOL.validate_report(r); };
  assert.ok(bad((r) => { r.corpora.regular.journals[0].frr.k += 1; }).length > 0);
  assert.ok(bad((r) => { r.corpora.stress.gate.pass = true; }).some((x) => x.includes('gate')));
  assert.ok(bad((r) => { r.synthetic = false; }).includes('synthetic_flag_missing'));
  assert.ok(bad((r) => { r.params['secret.setting'] = 1; }).some((x) => x.startsWith('param_not_in_vocab')));
  assert.ok(bad((r) => { r.n_journals = 21; }).includes('n_journals'));
  assert.ok(bad((r) => { r.date = '2026-02-31'; }).includes('date'));
  assert.ok(bad((r) => { r.corpora.regular.journals[0].frr.bp = 1; }).length > 0);
  assert.deepEqual(TOOL.validate_report(null), ['not_object']);
});

test('REQ-188 волны на ≥ 10 журналах: число волн, доля волн из одного платежа и чувствительность к g ± 1 и S ± 3 записаны для каждого журнала; итоги сходятся со строками', () => {
  for (const [name, w] of Object.entries(REPORT.waves.corpora)) {
    assert.ok(w.n_journals >= 10, `${name}: журналов ${w.n_journals}`);
    for (const r of w.journals) {
      assert.ok(r.waves > 0 && r.single <= r.waves);
      assert.equal(r.single_share_bp, Math.round((10000 * r.single) / r.waves));
      assert.deepEqual(Object.keys(r.sensitivity), ['gap_days-1', 'gap_days+1', 'max_span_days-3', 'max_span_days+3']);
      assert.equal(r.sensitivity['gap_days-1'].gap_days, 2);
      assert.equal(r.sensitivity['gap_days+1'].gap_days, 4);
      assert.equal(r.sensitivity['max_span_days-3'].max_span_days, 7);
      assert.equal(r.sensitivity['max_span_days+3'].max_span_days, 13);
    }
    assert.equal(w.summary.waves, w.journals.reduce((a, r) => a + r.waves, 0));
    assert.equal(w.summary.single, w.journals.reduce((a, r) => a + r.single, 0));
  }
  assert.equal(REPORT.waves.deltas.gap_days, 1);
  assert.equal(REPORT.waves.deltas.max_span_days, 3);
});

test('REQ-188 wave_stats: ручной пример — платежи в дни 0, 3 и 7 при g = 3, S = 10: две волны (одна из одного платежа); g − 1 даёт три волны, g + 1 — одну; S ± 3 состав не меняет', () => {
  const ev = (id, day, amount = -5000) => ({ cash_event_id: id, date: day, amount_minor: amount, is_obligation: true, is_estimate: false, kind: 'expense' });
  const events = [ev('A', 20000), ev('B', 20003), ev('C', 20007)];
  const params = { 'wave.gap_days': 3, 'wave.max_span_days': 10, 'wave.threshold_minor': 3000 };
  const s = TOOL.wave_stats(events, params);
  // A→B разрыв 3 ≤ 3, размах 3 < 10 → вместе; B→C разрыв 4 > 3 → новая волна
  assert.deepEqual([s.waves, s.single, s.single_share_bp, s.payments], [2, 1, 5000, 3]);
  // g = 2: A | B | C — три волны; волны AB в новом составе нет (изменилась 1 из 2), C осталась как есть
  assert.deepEqual([s.sensitivity['gap_days-1'].waves, s.sensitivity['gap_days-1'].delta_waves, s.sensitivity['gap_days-1'].changed_waves, s.sensitivity['gap_days-1'].changed_share_bp], [3, 1, 1, 5000]);
  // g = 4: A+B+C одной волной (разрыв 4 ≤ 4, размах 7 < 10) — обе исходные волны изменились
  assert.deepEqual([s.sensitivity['gap_days+1'].waves, s.sensitivity['gap_days+1'].delta_waves, s.sensitivity['gap_days+1'].changed_waves], [1, -1, 2]);
  assert.deepEqual([s.sensitivity['max_span_days-3'].changed_waves, s.sensitivity['max_span_days+3'].changed_waves], [0, 0], 'размах 7 и 13 при разрывах 3–4 дня состав не меняет');
  // S = 7: размах от A до C равен 7, условие «размах < S» не выполнено — но разрыв B→C уже разделил волны, поэтому ничего не изменилось
  assert.equal(s.sensitivity['max_span_days-3'].waves, 2);
  // нет волн — доля не определена (null), а не ноль
  const none = TOOL.wave_stats([], params);
  assert.deepEqual([none.waves, none.single_share_bp, none.sensitivity['gap_days+1'].changed_share_bp], [0, null, null]);
});

test('TST-55 пересчёт совпадает с файлом и зеркалом демо: `--check` (дата из файла) даёт код 0; другая дата замера — код 1; без даты — код 2', () => {
  const real = { read: (p) => fs.readFileSync(p, 'utf8'), write: () => assert.fail('--check ничего не пишет'), out: () => {}, err: () => {} };
  assert.equal(TOOL.main(['--date', REPORT.date, '--check'], real), 0);
  assert.equal(TOOL.main(['--date', '2030-01-01', '--check', '--no-mirror'], real), 1, 'другая дата замера — другой файл');
  const lines = []; const errs = [];
  assert.equal(TOOL.main([], { ...real, err: (s) => errs.push(s) }), 2);
  assert.match(errs[0], /--date/);
  assert.equal(TOOL.main(['--date', '2026-13-40'], { ...real, err: (s) => errs.push(s) }), 1);
  assert.equal(TOOL.main(['--help'], { ...real, out: (s) => lines.push(s) }), 0);
  assert.ok(lines[0].includes('--date'));
});

test('TST-55 зеркало демо: demo/quality_report.mjs равно сжатому отчёту и получено инструментом (текст файла совпадает до байта)', () => {
  assert.deepEqual(MIRROR.SYNTH_REPORT, TOOL.compact_report(REPORT));
  assert.equal(fs.readFileSync(path.join(PROTO, 'demo', 'quality_report.mjs'), 'utf8'), TOOL.mirror_source(REPORT));
  assert.match(fs.readFileSync(path.join(PROTO, 'demo', 'quality_report.mjs'), 'utf8'), /СГЕНЕРИРОВАНО/);
});

test('TST-55 небольшой прогон инструмента на двух журналах «обычных»: те же строки, что в файле; гейт «журналов меньше 10»; манифест сверяется', () => {
  const small = TOOL.build_report({ date: REPORT.date, corpora: ['regular'], limit: 2 });
  assert.deepEqual(small.corpora.regular.journals, REPORT.corpora.regular.journals.slice(0, 2));
  assert.deepEqual(small.corpora.regular.gate.reasons, ['journals_lt_10']);
  assert.deepEqual(small.waves.corpora.regular.journals, REPORT.waves.corpora.regular.journals.slice(0, 2));
  assert.throws(() => TOOL.build_report({ date: 'вчера' }), (e) => e.code === 'E_BAD_DATE');
  assert.throws(() => TOOL.build_report({ date: REPORT.date, corpora: ['other'] }), (e) => e.code === 'E_SCHEMA');
});

// ── экран «Качество прогноза» ─────────────────────────────────────────────────────────────────────────────────────────

async function make_page(ws, { lang = 'ru', view = 'quality', storage } = {}) {
  const e = create_ext({ ports: seeded_ports({ seed: 7 }) });
  const st = { ws, lang, root: null, notes: [], view };
  const build = (w) => APP.build_model(w, { lang: st.lang });
  st.model = build(ws);
  e.bind_host({
    get_ws: () => st.ws, get_model: () => st.model, lang: () => st.lang, mode: () => 'worse', fmt: () => APP.make_fmt(st.lang, st.model.cur, st.model.as_of_iso),
    set_ws: (next) => { let m; try { m = build(next); } catch (err) { return { ok: false, error: err }; } st.ws = next; st.model = m; return { ok: true }; },
    render: () => { st.root = e.render_view(st.view); CUR.root = st.root; },
    notify: (m, k) => { st.notes.push([m, k]); },
  });
  const store = storage ?? { m: new Map(), getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }, setItem(k, v) { this.m.set(k, String(v)); }, removeItem(k) { this.m.delete(k); } };
  const deps = PACK.register(e, { ports: { now_ms: () => 1_000_000, tz_offset_min: () => 0 }, storage: store });
  await e.run('boot');
  st.root = e.render_view(view);
  CUR.root = st.root;
  return { e, ctx: e.ctx, st, deps, storage: store, find: (id) => by_id(st.root, id), text: () => N(st.root.textContent), ws: () => st.ws };
}

/** Рабочая область с историей: синтетический журнал `reg02` (15 выплат клиента), на 2026-09-30. */
function history_ws(spec_over = {}) {
  const spec = { ...GEN.regular_corpus()[1], start: '2025-07-01', end: '2026-09-30', ...spec_over };
  return { ...BR.events_to_ws(GEN.make_journal(spec)), as_of: '2026-09-30', decision_currency: 'EUR', locale: 'ru' };
}

/** Одно повторяющееся списание: `n` ежемесячных платежей с января, все сопоставляются сами. */
function monthly_ws(n) {
  const rule = { rule_id: 'R-X', account_id: 'acc_main', name: 'Подписка', kind: 'expense', amount: { exp_minor: -10000 }, currency: 'EUR', freq: 'M', interval: 1, by_monthday: [15], start_date: '2026-01-15', month_end: 'clamp', weekend: 'keep', calendar_id: null, exdates: [], is_obligation: true, is_estimate: false, tag: 'подписка' };
  const month = (i) => String(i + 1).padStart(2, '0');
  const facts = Array.from({ length: n }, (_, i) => ({ event_id: 'F' + i, account_id: 'acc_main', date: `2026-${month(i)}-15`, amount_minor: -10000, currency: 'EUR', kind: 'expense', tag: 'подписка' }));
  return {
    workspace_id: 'ws-m', name: 'Подписка', locale: 'ru', decision_currency: 'EUR', as_of: `2026-${month(n - 1)}-20`, params: { horizon_days: 30, buffer_minor: 50000 },
    accounts: [{ account_id: 'acc_main', name: 'Основной счёт', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2, liquidity_bp: 0 }],
    calendars: [], anchors: [{ anchor_id: 'a1', account_id: 'acc_main', date: '2026-01-01', amount_minor: 500000 }],
    facts, rules: [rule], overrides: [], plans: [], streams: [], tax_rules: [], reserves: [], allocations: [], rates: [], scenarios: [], purchases: [], debts: [], wave_overrides: [], counterparties: [],
  };
}

test('TST-55 экран: таблица читает отчёт — «Синтетика» на виду, FRR и cry-wolf «k из n = %», n, дата замера, решение гейта с причиной; RU и EN', async () => {
  const rows = Q.report_rows();
  assert.deepEqual(rows.map((r) => [r.corpus, r.n_journals, r.pass]), [['regular', 12, true], ['stress', 10, false]]);
  assert.deepEqual(rows[1].reasons, ['frr_above_5pct']);
  const page = await make_page(load('g001.json'));
  const t = page.text();
  assert.ok(t.includes('Синтетика: журналы сгенерированы программой'), 'пометка «синтетика»');
  assert.ok(find_all(page.find('qx-report'), (n) => n.tagName === 'p' && n.attrs.role === 'note' && n.attrs.id === 'qx-synth').length === 1);
  assert.ok(t.includes('1 из 117 = 0,85 %'), t.slice(0, 900));
  assert.ok(t.includes('7 из 18 = 38,89 %'));
  assert.ok(t.includes('7 из 32 = 21,88 %'));
  assert.ok(t.includes('3 из 72 = 4,17 %'));
  assert.ok(t.includes('Дата замера: 9 октября 2026') || t.includes('Дата замера: 9 октября'), 'дата замера');
  assert.ok(t.includes('журналов: 22'));
  assert.ok(N(page.find('qx-row-regular').textContent).includes('проходит'));
  assert.ok(N(page.find('qx-row-stress').textContent).includes('не проходит: FRR выше 5 %'));
  assert.ok(t.includes('Волны платежей на этих же журналах'));
  assert.ok(t.includes('0 / 0 / 0 / 0 из 96'), 'чувствительность волн в отчёте');
  const en = await make_page(load('g001.json'), { lang: 'en' });
  assert.ok(en.text().includes('Synthetic: the journals were generated by a program'));
  assert.ok(en.text().includes('1 of 117 = 0.85 %'), en.text().slice(0, 900));
  assert.ok(N(en.find('qx-row-stress').textContent).includes('fails: FRR above 5 %'));
});

test('REQ-053 «Привычки платежей» только при n ≥ 10: 9 сопоставленных платежей — карточки нет, есть подсказка с числом; 10 — карточка с n, медианой, p80, p90', async () => {
  const nine = await make_page(monthly_ws(9));
  assert.equal(nine.find('qx-habits'), undefined, 'карточки при n = 9 нет');
  assert.ok(nine.find('qx-habits-hint').textContent.includes('не менее 10') && nine.find('qx-habits-hint').textContent.includes('сейчас у лучшего — 9'), nine.find('qx-habits-hint').textContent);
  const ten = await make_page(monthly_ws(10));
  const card = ten.find('qx-habits');
  assert.ok(card !== undefined, 'карточка при n = 10');
  const cells = find_all(card, (n) => n.tagName === 'tr').map((r) => N(r.textContent));
  assert.ok(cells.some((c) => c.startsWith('Подписка') && c.includes('10')), cells.join('|'));
  const row = find_all(card, (n) => n.tagName === 'tr').find((r) => N(r.textContent).startsWith('Подписка'));
  const nums = find_all(row, (n) => n.tagName === 'td').map((c) => c.textContent);
  assert.deepEqual(nums.slice(0, 4), ['10', '0', '0', '0'], 'n, медиана, p80, p90: платежи шли в срок');
  assert.equal(ten.find('qx-habits-hint'), undefined);
  // гейт модели — тот же порог
  const m9 = Q.habits_model(monthly_ws(9), APP.build_model(monthly_ws(9)).ctx);
  assert.deepEqual([m9.habits.shown.length, m9.best_n, m9.min_n], [0, 9, 10]);
});

test('REQ-053 ряд «ожидаемый» — оценка: при 15 наблюдениях выплата клиента сдвигается на медиану, строка показывает узкую точку рядом с планом; вердикт и режимы расчёта не затронуты', async () => {
  const ws = history_ws();
  const page = await make_page(ws);
  const card = page.find('qx-habits');
  assert.ok(card !== undefined);
  const hours = find_all(card, (n) => n.tagName === 'tr').find((r) => N(r.textContent).startsWith('Почасовая работа'));
  assert.ok(hours !== undefined, 'поток часов в таблице');
  assert.equal(find_all(hours, (n) => n.tagName === 'td')[0].textContent, '15');
  const exp = page.find('qx-expected');
  assert.ok(exp !== undefined);
  assert.ok(N(exp.textContent).includes('Ряд «ожидаемый» (оценка): узкая точка'), exp.textContent);
  assert.ok(card.textContent.includes('Оценка для сравнения, а не режим расчёта'));
  const a = page.st.model.ctx;
  assert.deepEqual(Object.keys(a.series).sort(), ['plan', 'worse']);
  assert.throws(() => ENGINE.analyze(ws, { as_of: ws.as_of, modes: ['expected'] }), (e) => e.code === 'E_SCHEMA');
});

test('TST-56 каталог quality: паритет ключей и плейсхолдеров RU/EN, каждый ключ используется в коде литералом или динамическим префиксом, запрещённых фраз и обещаний нет', () => {
  const ru = Object.keys(Q_CAT.ru).sort();
  assert.deepEqual(Object.keys(Q_CAT.en).sort(), ru);
  const ph = (s) => [...String(s).matchAll(/\{([a-z0-9_]+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const k of ru) {
    assert.ok(k.startsWith('quality.'));
    assert.equal(ph(Q_CAT.en[k]), ph(Q_CAT.ru[k]), 'плейсхолдеры ' + k);
    if (/[a-zа-яё]/i.test(Q_CAT.ru[k].replace(/\{[a-z0-9_]+\}/g, ''))) assert.match(Q_CAT.ru[k], /[а-яё]/i, 'русские буквы в ' + k);
  }
  const src = ['quality.mjs', 'prob_band.mjs', 'prob_buy.mjs', 'pack_fp11.mjs'].map((f) => fs.readFileSync(path.join(PROTO, 'demo', f), 'utf8')).join('\n');
  const prefixes = [...src.matchAll(/'(quality\.[a-z_0-9]+_)' \+/g)].map((m) => m[1]);
  assert.ok(prefixes.length >= 3, 'динамические префиксы найдены: ' + prefixes.join(','));
  for (const k of ru) assert.ok(src.includes(`'${k}'`) || prefixes.some((p) => k.startsWith(p)), 'ключ не используется: ' + k);
  const all = JSON.stringify(Q_CAT).toLowerCase();
  for (const bad of VOCAB.forbidden_phrases) assert.ok(!all.includes(bad.toLowerCase()), 'запрещённая фраза: ' + bad);
  for (const bad of ['точный прогноз', 'вероятность успеха', 'гарантируем', 'guarantee', 'accurate forecast', 'probability of success']) assert.ok(!all.includes(bad), 'обещание: ' + bad);
});

test('TST-59 безопасность интерфейса: в модулях «Качества» нет innerHTML, inline-стилей, eval, сети; стили — только токены и файлы', () => {
  for (const f of ['quality.mjs', 'prob_band.mjs', 'prob_buy.mjs', 'quality_report.mjs']) {
    const src = fs.readFileSync(path.join(PROTO, 'demo', f), 'utf8');
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', "setAttribute('style'", 'fetch(', 'XMLHttpRequest', 'http://', 'https://']) assert.ok(!src.includes(bad), `${f}: ${bad}`);
  }
  const css = fs.readFileSync(path.join(PROTO, 'demo', 'css', 'quality.css'), 'utf8');
  assert.ok(!/url\(|@import|https?:/.test(css));
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'цвета — только токены var(--…)');
});


// ── исправления после независимой проверки FP-11 ───────────────────────────────────────────────────────────────────────────

/** Ключи каталога по языкам из ИСХОДНОГО текста файла: повторный ключ в литерале объекта молча затирает первый, во время выполнения его уже не видно. */
function catalog_keys_by_lang(file) {
  const text = fs.readFileSync(path.join(PROTO, 'demo', 'i18n', file), 'utf8');
  const at = text.search(/^ {2}en: \{/m);
  assert.ok(at > 0, file + ': не найден раздел en');
  const keys = (s) => [...s.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]);
  return { ru: keys(text.slice(0, at)), en: keys(text.slice(at)) };
}

test('TST-56 исправление FP-11: ни в одном каталоге пакета (quality, reconcile) ключ не объявлен дважды в одном языке — повтор затирал бы первую подпись', () => {
  for (const file of ['quality.mjs', 'reconcile.mjs']) {
    const by = catalog_keys_by_lang(file);
    for (const lang of ['ru', 'en']) {
      const seen = new Set();
      const dup = by[lang].filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
      assert.deepEqual(dup, [], `${file}/${lang}: повторные ключи`);
      assert.ok(by[lang].length > 20, `${file}/${lang}: ключи прочитаны (${by[lang].length})`);
    }
    // порядок и состав ключей в RU и EN совпадают, число объявлений равно числу ключей объекта
    assert.deepEqual([...by.en].sort(), [...by.ru].sort(), file + ': паритет по тексту файла');
  }
  assert.equal(catalog_keys_by_lang('quality.mjs').ru.length, Object.keys(Q_CAT.ru).length, 'число объявлений равно числу ключей: ни один не затёрт');
  assert.equal(catalog_keys_by_lang('quality.mjs').en.length, Object.keys(Q_CAT.en).length);
});

test('REQ-053 исправление FP-11: заголовки таблицы «Привычки платежей» — «Медиана, дн / p80, дн / p90, дн» (EN: Median, days / p80, days / p90, days), а не подписи коридора P50 / P90; таблица коридора сохранила свои', async () => {
  for (const [lang, want, forbidden] of [
    ['ru', ['Платёж', 'n (наблюдений)', 'Медиана, дн', 'p80, дн', 'p90, дн'], ['P50 (середина)', 'P90 (выше)', 'P10 (ниже)']],
    ['en', ['Payment', 'n (observations)', 'Median, days', 'p80, days', 'p90, days'], ['P50 (middle)', 'P90 (upper)', 'P10 (lower)']],
  ]) {
    const page = await make_page(history_ws(), { lang });
    const card = page.find('qx-habits');
    assert.ok(card !== undefined, lang + ': карточка привычек есть (15 наблюдений)');
    const heads = find_all(card, (n) => n.tagName === 'th' && n.attrs.scope !== 'row').map((n) => N(n.textContent));
    assert.deepEqual(heads, want, `${lang}: заголовки таблицы привычек`);
    for (const f of forbidden) assert.ok(!heads.includes(f), `${lang}: в таблице привычек подпись коридора «${f}»`);
  }
  // таблица коридора (после согласия и расчёта) подписана P10 / P50 / P90
  const page = await make_page(history_ws());
  const box = page.find('qx-agree');
  box.checked = true;
  box.listeners.change[0]();
  page.find('qx-enable').listeners.click[0]();
  page.find('qx-band-run').listeners.click[0]();
  const band_heads = find_all(page.find('qx-band-result'), (n) => n.tagName === 'th').map((n) => N(n.textContent));
  for (const w of ['Дата', 'P10 (ниже)', 'P50 (середина)', 'P90 (выше)']) assert.ok(band_heads.includes(w), `таблица коридора: нет «${w}», есть ${JSON.stringify(band_heads)}`);
});

test('TST-55 исправление FP-11: неполный прогон отчёта (--corpus regular|stress) без --out не пишет ничего и не трогает канонический файл и зеркало: код 2 и пояснение; явный --out вне канонического файла работает', () => {
  const writes = [];
  const errs = [];
  const io = { read: () => '', write: (p) => { writes.push(String(p).replaceAll(path.sep, '/')); }, out: () => {}, err: (s) => errs.push(s) };
  for (const corpus of ['regular', 'stress']) {
    assert.equal(TOOL.main(['--date', '2026-10-09', '--corpus', corpus], io), 2, corpus);
    assert.equal(TOOL.main(['--date', '2026-10-09', '--corpus', corpus, '--check'], io), 2, corpus + ' --check');
  }
  assert.deepEqual(writes, [], 'ни канонический файл, ни зеркало не записаны');
  assert.ok(errs.length >= 4 && errs.every((e) => e.includes('--out')), 'сообщение называет --out');
  // явный путь, совпадающий с каноническим, — тоже отказ (в том числе другой записью того же пути)
  const canonical = REPORT_FILE;
  const spellings = [canonical, canonical.replaceAll(path.sep, '/'), path.join(PROTO, 'data', '..', 'data', 'backtest-report.json')];
  if (process.platform === 'win32') spellings.push(canonical.toUpperCase()); // на Windows пути без учёта регистра
  for (const spelled of spellings) assert.equal(TOOL.main(['--date', '2026-10-09', '--corpus', 'regular', '--out', spelled], io), 2, spelled);
  assert.deepEqual(writes, []);
  // полный отчёт по умолчанию пишет оба файла (проверяем только --check, без записи: он читает канонический файл и зеркало)
  const real = { read: (p) => fs.readFileSync(p, 'utf8'), write: () => assert.fail('--check ничего не пишет'), out: () => {}, err: () => {} };
  assert.equal(TOOL.main(['--date', REPORT.date, '--check'], real), 0);
});
