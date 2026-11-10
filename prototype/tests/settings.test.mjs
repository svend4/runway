// settings.test.mjs — FP-03: настройки, буфер, запас хода и честная готовность данных.
// Покрывает: REQ-026 + TST-58 (буфер: 0 = «задан», пусто = «не задан», подсказка buffer_hint = 49000 на G-001), REQ-023 (запас хода = runway_days движка
// на g001, low, gap; канон G-001-gap: 2026-10-26, 22 дня), REQ-029 (плашка s < 4 из readiness.reasons, тексты разных причин различаются; гейт вердикта),
// REQ-112 + TST-58 («ru + 1.234,50 €» показывается и разбирается; в данных 123450 и ISO), REQ-024 (сдвиг «если хуже» пересчитывает режим, подпись «сдвиг
// сценария + сдвиг режима»), TST-56 (каталог строк), TST-59 (нет innerHTML и inline-стилей; параметры — только через set_param).
// DOM в Node подменён заглушкой: проверяется логика и связка с настоящим app.mjs/ext.mjs, а не вёрстка. Браузер не используется.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ── заглушка DOM ────────────────────────────────────────────────────────────────────────────────────────────────────

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
  focus() { this.focused = true; }
  querySelectorAll() { return []; }
  walk(fn) { fn(this); for (const c of this.children) if (c.nodeType === 1) c.walk(fn); }
}
globalThis.document = {
  createElement: (t) => new FakeNode(t),
  createElementNS: (_ns, t) => new FakeNode(t),
  createTextNode: (data) => ({ nodeType: 3, data }),
  getElementById: () => null,
  head: new FakeNode('head'),
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.resolve(HERE, '..');
const DEMO = path.join(PROTO, 'demo');
const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);

const ENGINE = await imp('engine', 'index.mjs');
const { buffer_hint, runway_days, gate, list_waves_ex, canon, parse_minor, format_minor } = ENGINE;
const { LABELS } = await imp('engine', 'verifier.mjs');
const APP = await imp('demo', 'app.mjs'); // без DOM-страницы boot не запускается
const { create_ext, ext: APP_EXT } = await imp('demo', 'ext.mjs');
const I18N = await imp('demo', 'i18n.mjs');
const { apply_edit, PARAM_SPECS } = await imp('demo', 'ws_edit.mjs');
const { seeded_ports } = await imp('demo', 'ids.mjs');
const { ws_to_events, events_to_ws } = await imp('demo', 'ws_bridge.mjs');
const { create_journal, ports_from_gen } = await imp('demo', 'journal_log.mjs');
const { make_id_gen } = await imp('demo', 'ids.mjs');
const { sync_journal } = await imp('demo', 'ws_bridge.mjs');
const NF = await imp('demo', 'number_format.mjs');
const HC = await imp('demo', 'home_cards.mjs');
const ST = await imp('demo', 'settings.mjs');
const PACK = await imp('demo', 'pack_fp03.mjs');
const CATALOG = (await imp('demo', 'i18n', 'settings.mjs')).default;
const { make_rng } = await imp('tests', 'helpers.mjs');

const load = (name) => JSON.parse(fs.readFileSync(path.join(PROTO, 'data', name), 'utf8'));
const G = load('g001.json');
const LOW = load('g001-low.json');
const GAP = load('g001-gap.json');
const NBSP = ' ';
const MINUS = '−';

// пакет подключается один раз «как в приложении»: строки, правка set_number_format, экран и слоты
const PACK_EXT = create_ext({ ports: seeded_ports({ seed: 3 }) });
await PACK_EXT.load_packs({ pack_fp03: () => import(pathToFileURL(path.join(DEMO, 'pack_fp03.mjs')).href) });

/** Хост-заглушка с настоящим пересчётом страницы (`build_model`): отказ пересчёта откатывает правку, как в app.mjs. */
function make_env(ws = G, { lang = 'ru', mode = 'worse', scenario = null, ext = null } = {}) {
  const e = ext ?? create_ext({ ports: seeded_ports({ seed: 5 }) });
  const st = { ws, lang, mode, scenario, renders: 0, notes: [] };
  const build = (w) => APP.build_model(w, { lang: st.lang, scenario: st.scenario });
  st.model = build(ws);
  e.bind_host({
    get_ws: () => st.ws,
    get_model: () => st.model,
    lang: () => st.lang,
    mode: () => st.mode,
    fmt: () => APP.make_fmt(st.lang, st.model.cur, st.model.as_of_iso),
    set_ws: (next) => {
      let m;
      try { m = build(next); } catch (err) { return { ok: false, error: err }; }
      st.ws = next;
      st.model = m;
      return { ok: true };
    },
    render: () => { st.renders += 1; },
    notify: (m, k) => { st.notes.push([m, k]); },
  });
  return { e, ctx: e.ctx, st };
}

const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const by_id = (root, id) => find_all(root, (n) => n.attrs.id === id)[0];
const text_of = (n) => n.textContent;
const submit_form = (root, id) => { const f = by_id(root, id); assert.ok(f !== undefined, 'нет формы ' + id); f.listeners.submit[0]({ preventDefault() {} }); };
const button_by_text = (root, re) => find_all(root, (n) => n.tagName === 'button' && re.test(n.textContent))[0];

// ── REQ-026 + TST-58: буфер ─────────────────────────────────────────────────────────────────────────────────────────

test('REQ-026 TST-58 буфер вводится числом: пусто = «не задан» (null), 0 = «задан», сумма разбирается по формату, мусор и минус отвергаются', () => {
  const env = { cur: 'EUR', lang: 'ru', nf: undefined };
  const def = ST.SECTIONS.buffer[0];
  assert.deepEqual(ST.parse_field(def, '', env), { ok: true, value: null }, 'пусто → не задан');
  assert.deepEqual(ST.parse_field(def, '   ', env), { ok: true, value: null });
  assert.deepEqual(ST.parse_field(def, '0', env), { ok: true, value: 0 }, '0 → задан');
  assert.deepEqual(ST.parse_field(def, '490', env), { ok: true, value: 49000 });
  assert.deepEqual(ST.parse_field(def, '490,50', env), { ok: true, value: 49050 });
  assert.deepEqual(ST.parse_field(def, '1 234,50 €', env), { ok: true, value: 123450 }, 'символ валюты и пробел тысяч');
  assert.deepEqual(ST.parse_field(def, '1 234,50', { ...env, lang: 'en' }), { ok: false, reason: 'bad_number' }, 'en: «,» — группа тысяч, «1 234,50» не читается');
  assert.deepEqual(ST.parse_field(def, '1,234.50', { ...env, lang: 'en' }), { ok: true, value: 123450 });
  for (const [text, reason] of [['abc', 'bad_number'], ['12,5,0', 'bad_number'], ['490,555', 'bad_number'], ['-5', 'negative'], [MINUS + '5', 'negative'], ['9'.repeat(30), 'too_big']]) {
    const r = ST.parse_field(def, text, env);
    assert.equal(r.ok, false, text);
    assert.equal(r.reason, reason, text);
  }
});

test('REQ-026 TST-58 запись буфера: 0 → «задан» (нет причины no_buffer), пусто → «не задан» (W_BUFFER_UNSET, причина no_buffer); значение равное текущему не пишется', () => {
  const { ctx, st } = make_env(G);
  const env = { cur: 'EUR', lang: 'ru', nf: undefined };
  let plan = ST.plan_section_edits(st.model, 'buffer', { buffer_minor: '0' }, env);
  assert.deepEqual(plan.edits, [{ type: 'set_param', key: 'buffer_minor', value: 0 }]);
  assert.equal(ST.save_edits(ctx, plan.edits).ok, true);
  assert.equal(st.ws.params.buffer_minor, 0);
  assert.equal(st.model.ctx.buffer_minor, 0, 'явный 0 — буфер задан');
  assert.equal(gate(st.model.ctx), null, 'гейт пропускает: 0 — это «задан»');
  assert.ok(!st.model.ctx.warnings.some((w) => w.code === 'W_BUFFER_UNSET'));
  plan = ST.plan_section_edits(st.model, 'buffer', { buffer_minor: '' }, env);
  assert.deepEqual(plan.edits, [{ type: 'set_param', key: 'buffer_minor', value: null }]);
  assert.equal(ST.save_edits(ctx, plan.edits).ok, true);
  assert.equal(st.ws.params.buffer_minor, null);
  assert.ok(st.model.ctx.warnings.some((w) => w.code === 'W_BUFFER_UNSET'), 'не задан → предупреждение движка');
  assert.deepEqual(gate(st.model.ctx).reasons, ['no_buffer']);
  const same = ST.plan_section_edits(st.model, 'buffer', { buffer_minor: '' }, env);
  assert.deepEqual(same.edits, [], 'то же значение — правки нет');
  assert.deepEqual(ST.save_edits(ctx, []), { ok: true, unchanged: true });
});

test('REQ-026 TST-58 подсказка buffer_hint: на G-001 = 49000 = round_div(7·630000, 90) = значение движка; сдвиг будущего платежа её не меняет; без истории — null', () => {
  const m = APP.build_model(G);
  const bm = ST.buffer_model(m);
  assert.equal(bm.outflow_90, 630000);
  assert.equal(bm.hint, 49000, 'канон REQ-026');
  assert.equal(bm.hint, buffer_hint(G, G.as_of), 'совпадает с движком');
  assert.equal(bm.hint_days, 7);
  assert.equal(bm.value, 50000);
  assert.equal(bm.is_set, true);
  const shifted = { ...G, plans: G.plans.map((p) => ({ ...p, date: '2026-10-24' })) };
  assert.equal(ST.buffer_model(APP.build_model(shifted)).hint, 49000, 'сдвиг будущего платежа на день — подсказка прежняя');
  const none = ST.buffer_model(APP.build_model({ ...G, facts: [] }));
  assert.equal(none.hint, null, 'нет фактов за 90 дней — подсказки нет');
  assert.equal(ST.buffer_model(APP.build_model({ ...G, params: { ...G.params, buffer_minor: null } })).is_set, false);
});

test('REQ-026 TST-58 экран: «Взять подсказку» подставляет 49000 в поле, «Сохранить» пишет буфер через set_param и дописывает журнал; прочее не меняется; «Сохранено» показано один раз', () => {
  const { ctx, st } = make_env(G);
  const before = st.ws;
  const n0 = ctx.journal.length;
  const root = ST.render_settings(ctx);
  const input = by_id(root, 'set-buffer');
  assert.equal(input.value, '500,00', 'поле открывается с действующим буфером');
  assert.match(text_of(root), /Подсказка: 490,00 €/, 'подсказка видна текстом');
  button_by_text(root, /Взять подсказку/).listeners.click[0]();
  assert.equal(input.value, '490,00', 'подсказка в поле (ещё не сохранена)');
  assert.equal(st.ws, before, 'до «Сохранить» данные не менялись');
  submit_form(root, 'settings-buffer');
  assert.equal(st.ws.params.buffer_minor, 49000, 'буфер = buffer_hint движка на G-001');
  assert.equal(st.ws.params.buffer_minor, buffer_hint(G, G.as_of));
  assert.deepEqual(st.ws, apply_edit(before, { type: 'set_param', key: 'buffer_minor', value: 49000 }).ws, 'результат — ровно правка set_param, ничего лишнего');
  assert.equal(st.renders, 1, 'один пересчёт и одна перерисовка');
  assert.equal(ctx.journal.length, n0 + 1);
  assert.equal(ctx.journal.at(n0).type, 'params.set');
  assert.ok(st.notes.some(([m, k]) => m === 'Сохранено.' && k === 'info'));
  const again = ST.render_settings(ctx);
  assert.equal(text_of(by_id(again, 'settings-buffer')).includes('Сохранено.'), true, 'после перерисовки — подтверждение у раздела');
  assert.equal(text_of(by_id(ST.render_settings(ctx), 'settings-buffer')).includes('Сохранено.'), false, 'подтверждение показывается один раз');
  assert.match(text_of(by_id(again, 'settings-buffer')), /Сейчас задан: 490,00 €/);
});

test('REQ-026: без истории за 90 дней подсказки нет — кнопка выключена, поле не меняется; не заданный буфер показан плашкой, а не нулём', () => {
  const { ctx } = make_env({ ...G, facts: [], params: { ...G.params, buffer_minor: null } });
  const root = ST.render_settings(ctx);
  const take = button_by_text(root, /Взять подсказку/);
  assert.equal(take.getAttribute('disabled'), '', 'кнопка выключена');
  take.listeners.click[0]();
  assert.equal(by_id(root, 'set-buffer').value, '', 'пустое поле: «не задан»');
  assert.match(text_of(root), /Подсказки нет/);
  assert.match(text_of(root), /Буфер не задан: прогноз и волны считаются с буфером 0/);
  assert.ok(find_all(root, (n) => n.className === 'banner').length >= 1, 'плашка «не задан»');
});

test('REQ-026 TST-58 ошибка ввода: понятный текст у поля, aria-invalid, данные не меняются и журнал не дописывается', () => {
  const { ctx, st } = make_env(G);
  const before = st.ws;
  const root = ST.render_settings(ctx);
  by_id(root, 'set-buffer').value = 'много';
  submit_form(root, 'settings-buffer');
  assert.equal(st.ws, before);
  assert.equal(st.renders, 0, 'перерисовки нет: данные те же');
  assert.match(text_of(by_id(root, 'set-buffer-err')), /Не удалось прочитать число\. Пример в вашем формате: 1234,50\./);
  assert.equal(by_id(root, 'set-buffer').getAttribute('aria-invalid'), 'true');
  assert.match(text_of(by_id(root, 'settings-buffer')), /Отмеченные поля содержат ошибки: ничего не сохранено\./);
  by_id(root, 'set-buffer').value = '500,00'; // то же число, что сейчас: правки нет
  submit_form(root, 'settings-buffer');
  assert.equal(by_id(root, 'set-buffer').getAttribute('aria-invalid'), 'false');
  assert.match(text_of(by_id(root, 'settings-buffer')), /Значения не изменились\./);
  assert.equal(st.ws, before);
});

test('REQ-026: отказ записи (пересчёт страницей не принял значение) возвращает причину в форму и не меняет данные', () => {
  const { ctx, st } = make_env(G);
  const before = st.ws;
  const root = ST.render_settings(ctx);
  by_id(root, 'set-threshold').value = '0'; // PARAM_SPECS допускает 0, движок требует θ ≥ 1: отказ приходит из пересчёта
  submit_form(root, 'settings-waves');
  assert.equal(st.ws, before, 'данные прежние');
  assert.match(text_of(by_id(root, 'settings-waves')), /Не сохранено: /);
  assert.ok(st.notes.some(([m, k]) => /Не сохранено/.test(m) && k === 'error'));
});

// ── REQ-023: запас хода ─────────────────────────────────────────────────────────────────────────────────────────────

/** Независимый поиск первого дня `trough < 0` по ряду (не через runway_days). */
const first_negative = (series) => { const i = series.trough.findIndex((x) => x < 0); return i < 0 ? null : { date: series.from + i, days: i }; };

for (const [name, ws] of [['g001', G], ['low', LOW], ['gap', GAP]]) {
  test(`REQ-023 TST-09 плитка запаса хода = runway_days движка на ${name} (оба режима, с поступлениями и без них)`, () => {
    const m = APP.build_model(ws);
    const rm = HC.runway_model(m);
    const a = m.ctx;
    for (const mode of ['plan', 'worse']) {
      const rd = runway_days(a.series[mode], a.events[mode]);
      assert.deepEqual(rm.per_mode[mode].with, rd.with, `${name} ${mode}: с поступлениями`);
      assert.deepEqual(rm.per_mode[mode].without, rd.without, `${name} ${mode}: без поступлений`);
      assert.deepEqual(rm.per_mode[mode].with, first_negative(a.series[mode]), `${name} ${mode}: независимый поиск по trough`);
      const { with: w, without: wo } = rm.per_mode[mode];
      if (w !== null) assert.ok(wo !== null && wo.days <= w.days, 'без поступлений не позже, чем с ними');
    }
    assert.equal(rm.horizon_days, 58);
  });
}

test('REQ-023 канон: G-001 — «за горизонтом» в обоих режимах; G-001-gap — первая дата ниже нуля 2026-10-26, через 22 дня; карточка показывает те же числа', () => {
  const g = HC.runway_model(APP.build_model(G));
  assert.deepEqual([g.per_mode.plan.with, g.per_mode.plan.without, g.per_mode.worse.with, g.per_mode.worse.without], [null, null, null, null]);
  const { ctx } = make_env(G);
  const card = HC.runway_card(ctx);
  assert.match(text_of(card), /Запас хода в днях/);
  assert.match(text_of(card), /денег на счетах хватает на весь горизонт — 57 дней/); // FP-48: то же число, что в «Настройках» и в шапке (дней вперёд от даты расчёта; строк в ряду — 58)
  assert.equal(find_all(card, (n) => n.tagName === 'td' && n.textContent === 'за горизонтом').length, 4, 'четыре ячейки «за горизонтом»');
  const gap = HC.runway_model(APP.build_model(GAP));
  assert.equal(ENGINE.format_date(gap.per_mode.plan.with.date), '2026-10-26');
  assert.equal(gap.per_mode.plan.with.days, 22);
  const gcard = HC.runway_card(make_env(GAP).ctx);
  assert.match(text_of(gcard), /денег на счетах хватает на 22 дня; ниже нуля — с 26 октября/);
  assert.match(text_of(gcard), /22 дня · 26 октября/);
  const low = HC.runway_model(APP.build_model(LOW));
  assert.equal(low.per_mode.plan.with, null);
  assert.equal(low.per_mode.plan.without.days, low.per_mode.plan.without.date - low.as_of);
  const lcard = HC.runway_card(make_env(LOW).ctx);
  assert.ok(text_of(lcard).includes(low.per_mode.plan.without.days + ' дней · '), 'LOW: без поступлений — число дней движка');
});

test('REQ-023 REQ-029: пока прогноз не показывается (s < ready.q1), карточка «Запас хода» не выдумывает числа: вместо «хватает на весь горизонт» — пояснение; при s = 3 числа есть', () => {
  const empty = HC.runway_card(make_env(no_acc).ctx);
  assert.match(text_of(empty), /Запас хода появится вместе с прогнозом: сначала нужны данные \(готовность от 3 из 4\)\./);
  assert.ok(!/хватает на весь горизонт/.test(text_of(empty)));
  assert.equal(find_all(empty, (n) => n.tagName === 'table').length, 0);
  assert.match(text_of(HC.runway_card(make_env(no_acc, { lang: 'en' }).ctx)), /Runway appears together with the forecast/);
  assert.equal(find_all(HC.runway_card(make_env(no_groc).ctx), (n) => n.tagName === 'table').length, 1, 's = 3: прогноз виден, числа есть');
});

test('REQ-023: карточка следует за главным режимом, помечает его строку и говорит по-английски на en; формат дат берётся из number_format', () => {
  const plan = make_env(GAP, { mode: 'plan' });
  const rows = find_all(HC.runway_card(plan.ctx), (n) => n.tagName === 'tr' && n.className === 'mark');
  assert.equal(rows.length, 1);
  assert.match(text_of(rows[0]), new RegExp(LABELS.modes.ru.plan));
  const en = make_env(GAP, { lang: 'en' });
  const t = text_of(HC.runway_card(en.ctx));
  assert.match(t, /Runway in days/);
  assert.match(t, /the money on the accounts lasts 22 days; below zero from October 26/);
  assert.match(t, /beyond the horizon|22 days · October 26/);
  const iso = make_env({ ...GAP, number_format: { date: 'iso' } });
  assert.match(text_of(HC.runway_card(iso.ctx)), /22 дня · 2026-10-26/);
});

// ── REQ-029: честная готовность данных ──────────────────────────────────────────────────────────────────────────────

const no_groc = { ...G, rules: G.rules.filter((r) => r.rule_id !== 'R-GROC') };
const no_income = { ...G, streams: [] };
const no_obl = { ...G, rules: G.rules.filter((r) => r.rule_id === 'R-GROC'), plans: [] };
const no_acc = { ...G, accounts: [], anchors: [], facts: [], rules: [], streams: [], plans: [] };
const READY_CASES = [
  ['no_daily_spend', no_groc, 3], ['no_income_45d', no_income, 3], ['obligations_lt_3', no_obl, 3],
];

for (const [reason, ws, score] of READY_CASES) {
  test(`REQ-029 TST-57 плашка s < 4 строится из readiness.reasons: ${reason} → s = ${score}, один пункт «Не учтено» с текстом именно этой причины (RU и EN)`, () => {
    const m = APP.build_model(ws);
    assert.deepEqual(m.ctx.readiness.reasons, [reason], 'движок называет причину');
    assert.equal(m.ctx.readiness.score, score);
    for (const lang of ['ru', 'en']) {
      const { ctx } = make_env(ws, { lang });
      const card = HC.ready_card(ctx);
      const banner = find_all(card, (n) => n.className === 'banner')[0];
      assert.ok(banner !== undefined, 'плашка есть');
      const items = find_all(banner, (n) => n.tagName === 'li').map(text_of);
      assert.deepEqual(items, [CATALOG[lang]['settings.rd_miss_' + reason]], lang);
      assert.match(text_of(banner), lang === 'ru' ? /^Не учтено:/ : /^Not counted:/);
      const steps = find_all(card, (n) => n.tagName === 'li').map(text_of);
      assert.equal(steps.filter((s) => /не учтено|not counted/.test(s)).length, 1, 'ровно один шаг не набран: ' + lang);
    }
    assert.match(text_of(HC.ready_card(make_env(ws).ctx)), /3 из 4 — рабочий\+/); // FP-26 (U21): ступень называется так же, как в шапке — «рабочий+» (было «почти полная»)
  });
}

test('REQ-029: для разных причин тексты разные; s = 0 перечисляет все четыре причины в порядке движка; при s = 4 плашки «Не учтено» нет', () => {
  const texts = new Set(HC.READINESS_STEPS.map((s) => CATALOG.ru[HC.miss_key(s.reason)]));
  assert.equal(texts.size, 4, 'четыре разных текста');
  assert.equal(new Set(HC.READINESS_STEPS.map((s) => CATALOG.en[HC.miss_key(s.reason)])).size, 4);
  assert.notEqual(CATALOG.ru[HC.miss_key('нет-такой-причины')], undefined, 'неизвестная причина — общий текст, не ключ');
  const m0 = APP.build_model(no_acc);
  assert.deepEqual(m0.ctx.readiness.reasons, ['no_account', 'obligations_lt_3', 'no_income_45d', 'no_daily_spend']);
  const { ctx } = make_env(no_acc);
  const card = HC.ready_card(ctx);
  const items = find_all(find_all(card, (n) => n.className === 'banner')[0], (n) => n.tagName === 'li').map(text_of);
  assert.deepEqual(items, m0.ctx.readiness.reasons.map((r) => CATALOG.ru[HC.miss_key(r)]));
  assert.match(text_of(card), /0 из 4 — пусто/);
  assert.match(text_of(card), /Прогноз появится при готовности от 3 из 4\./);
  const full = HC.ready_card(make_env(G).ctx);
  assert.equal(find_all(full, (n) => n.className === 'banner').length, 0, 's = 4: недостающего нет');
  assert.match(text_of(full), /4 из 4 — полный/);
  assert.match(text_of(full), /Прогноз показывается/);
  assert.match(text_of(full), /Вердикт «можно ли купить» и «можно потратить» доступны\./);
  const model = HC.readiness_model({ ctx: { readiness: { score: 2, level: 'working', reasons: ['no_income_45d', 'новая_причина'] }, params: {}, buffer_minor: 0, anchor_status: { level: 'fresh' }, rule_status: {} } });
  assert.deepEqual(model.reasons, ['no_income_45d', 'новая_причина'], 'модель не отбрасывает неизвестное');
  assert.equal(model.forecast_visible, false);
});

test('REQ-029 гейт вердикта: причины из движка (readiness, no_buffer…) показаны своими словами; не заданный буфер ведёт ссылкой в настройки', () => {
  const unset = { ...G, params: { ...G.params, buffer_minor: null } };
  const m = APP.build_model(unset);
  assert.deepEqual(HC.readiness_model(m).verdict_gate.reasons, ['no_buffer']);
  const card = HC.ready_card(make_env(unset).ctx);
  assert.match(text_of(card), /Вердикт и «можно потратить» скрыты: не задан буфер\./);
  assert.match(text_of(card), /Буфер не задан: расчёт ведётся с буфером 0\./);
  const link = find_all(card, (n) => n.tagName === 'a')[0];
  assert.equal(link.getAttribute('href'), '#settings');
  assert.equal(link.textContent, 'Задать буфер');
  const s3 = HC.ready_card(make_env(no_groc).ctx);
  assert.match(text_of(s3), /скрыты: готовность данных ниже 4 из 4\./);
  const set = HC.ready_card(make_env(G).ctx);
  assert.match(text_of(set), /Буфер: 500,00 € — число, которое задали вы\./);
  assert.equal(find_all(set, (n) => n.tagName === 'a')[0].textContent, 'Изменить в настройках');
  const en = HC.ready_card(make_env(unset, { lang: 'en' }).ctx);
  assert.match(text_of(en), /The verdict and "can I spend" are hidden: the buffer is not set\./);
  assert.equal(HC.gate_key('no_buffer'), 'settings.gt_no_buffer');
  assert.equal(HC.gate_key('что-то'), 'settings.gt_other');
});

// ── REQ-024: сдвиг «если хуже» ──────────────────────────────────────────────────────────────────────────────────────

test('REQ-024 TST-35 изменение worse.income_delay_days пересчитывает «если хуже»: 14 → узкая точка 183000 (14 ноября); 0 → ряды worse = plan; подпись сдвига видна', () => {
  const { ctx, st } = make_env(G);
  const wm = ST.worse_model(st.model);
  assert.equal(wm.mode_days, 14);
  assert.deepEqual(wm.narrow.worse, { date: ENGINE.parse_date('2026-11-14'), amount_minor: 183000 }, 'канон REQ-030: минимум worse 183000 на 14 ноября');
  assert.deepEqual(wm.narrow.plan, { date: ENGINE.parse_date('2026-10-31'), amount_minor: 205500 });
  const root = ST.render_settings(ctx);
  assert.match(text_of(by_id(root, 'settings-horizon')), /каждое ожидаемое поступление сдвинуто на 14 дней/);
  by_id(root, 'set-delay').value = '0';
  submit_form(root, 'settings-horizon');
  assert.equal(st.ws.params['worse.income_delay_days'], 0);
  const a = st.model.ctx;
  assert.deepEqual(a.series.worse.trough, a.series.plan.trough, 'при 0 ряды worse = plan');
  assert.deepEqual(a.series.worse.close, a.series.plan.close);
  const root0 = ST.render_settings(ctx);
  assert.match(text_of(by_id(root0, 'settings-horizon')), /сдвинуто на 0 дней/);
  assert.match(text_of(by_id(root0, 'settings-horizon')), /При сдвиге 0 режим «если хуже» даёт те же ряды, что и план\./);
  by_id(root0, 'set-delay').value = '21';
  submit_form(root0, 'settings-horizon');
  const w21 = ST.worse_model(st.model);
  assert.equal(w21.mode_days, 21);
  assert.ok(w21.narrow.worse.amount_minor <= 183000, 'больший сдвиг не улучшает узкую точку');
  const a21 = st.model.ctx;
  a21.series.worse.trough.forEach((v, i) => assert.ok(v <= a21.series.plan.trough[i], 'trough_worse[i] ≤ trough_plan[i], i = ' + i));
  assert.match(text_of(by_id(ST.render_settings(ctx), 'settings-horizon')), /сдвинуто на 21 день/);
});

test('REQ-024 C-009 подпись «сдвиг сценария + сдвиг режима»: delay_income 7 в worse даёт 7 + 14 = 21', () => {
  const base = APP.build_model(G);
  const ref = APP.first_income_ref(base);
  const scenario = { ops: [{ op: 'delay_income', event_ref: ref, days: 7 }] };
  const { ctx } = make_env(G, { scenario });
  const wm = ST.worse_model(ctx.get_model());
  assert.deepEqual([wm.scenario_days, wm.mode_days, wm.total_days], [7, 14, 21]);
  assert.match(text_of(ST.render_settings(ctx)), /Сдвиг сценария 7 дней \+ сдвиг режима 14 дней = 21 день\./);
  const plain = text_of(ST.render_settings(make_env(G).ctx));
  assert.ok(!/Сдвиг сценария/.test(plain), 'без сценария подписи нет');
  const en = text_of(ST.render_settings(make_env(G, { scenario, lang: 'en' }).ctx));
  assert.match(en, /Scenario shift 7 days \+ mode shift 14 days = 21 days\./);
});

test('REQ-024 REQ-025: горизонт и сдвиг — целые из границ PARAM_SPECS: диапазон, дробь и минус отвергаются с понятным текстом, принятое пересчитывает модель', () => {
  const env = { cur: 'EUR', lang: 'ru' };
  const [horizon, delay] = ST.SECTIONS.horizon;
  assert.deepEqual(ST.parse_field(horizon, '0', env), { ok: false, reason: 'range', min: '1', max: '3650' });
  assert.deepEqual(ST.parse_field(horizon, '3651', env), { ok: false, reason: 'range', min: '1', max: '3650' });
  assert.equal(ST.parse_field(horizon, '14,5', env).reason, 'bad_number');
  assert.equal(ST.parse_field(horizon, '-3', env).reason, 'negative');
  assert.equal(ST.parse_field(horizon, '', env).reason, 'empty', 'горизонт обязателен');
  assert.equal(ST.parse_field(delay, '0', env).value, 0);
  assert.equal(PARAM_SPECS['worse.income_delay_days'].max, 365);
  const { ctx, st } = make_env(G);
  const root = ST.render_settings(ctx);
  by_id(root, 'set-horizon').value = '3651';
  submit_form(root, 'settings-horizon');
  assert.match(text_of(by_id(root, 'set-horizon-err')), /Допустимо от 1 до 3650\./);
  assert.equal(st.ws.params.horizon_days, 57, 'данные не изменились');
  by_id(root, 'set-horizon').value = '60';
  by_id(root, 'set-delay').value = '14';
  submit_form(root, 'settings-horizon');
  assert.equal(st.ws.params.horizon_days, 60);
  assert.equal(st.model.ctx.series.plan.close.length, 61, 'горизонт пересчитан');
});

// ── волны и допуски сопоставления ───────────────────────────────────────────────────────────────────────────────────

test('REQ-026 волны и допуски: параметры волн, порог (пусто = по умолчанию движка) и допуск по сумме в процентах → bp без float', () => {
  const m = APP.build_model(G);
  const wv = ST.wave_model(m);
  assert.deepEqual([wv.gap_days, wv.max_span_days, wv.threshold_effective, wv.threshold_explicit], [3, 10, 3000, 3000]);
  assert.equal(wv.counts.plan, list_waves_ex(m.ctx, 'plan').items.length);
  assert.equal(wv.counts.plan, 2, 'G-001: две волны');
  const env = { cur: 'EUR', lang: 'ru' };
  const tol = ST.SECTIONS.match[1];
  assert.equal(ST.parse_field(tol, '5', env).value, 500);
  assert.equal(ST.parse_field(tol, '2,5', env).value, 250);
  assert.equal(ST.parse_field(tol, '2,5 %', env).value, 250);
  assert.equal(ST.parse_field(tol, '0,01', env).value, 1);
  assert.equal(ST.parse_field(tol, '100', env).value, 10000);
  assert.equal(ST.parse_field(tol, '100,01', env).reason, 'range');
  assert.equal(ST.parse_field(tol, '2.5', env).reason, 'bad_number', 'ru: точка — не десятичный знак');
  assert.equal(ST.parse_field(tol, '2.5', { ...env, lang: 'en' }).value, 250);
  assert.equal(ST.initial_text(m, tol, env), '5', 'проценты в поле — без нулевой дроби');
  const { ctx, st } = make_env(G);
  const root = ST.render_settings(ctx);
  assert.equal(by_id(root, 'set-tol').value, '5');
  assert.equal(by_id(root, 'set-threshold').value, '30,00');
  by_id(root, 'set-gap').value = '2';
  by_id(root, 'set-threshold').value = '';
  submit_form(root, 'settings-waves');
  assert.equal(st.ws.params['wave.gap_days'], 2);
  assert.equal(st.ws.params['wave.threshold_minor'], null, 'пусто → порог по умолчанию');
  assert.equal(st.model.ctx.params['wave.threshold_minor'], 3000, 'движок подставил θ по умолчанию: max(3000, 2100)');
  assert.equal(st.model.ctx.params['wave.gap_days'], 2);
  const root2 = ST.render_settings(ctx);
  by_id(root2, 'set-tol').value = '2,5';
  by_id(root2, 'set-window').value = '5';
  submit_form(root2, 'settings-match');
  assert.equal(st.ws.params['match.tol_bp'], 250);
  assert.equal(st.ws.params['match.window_days'], 5);
});

// ── REQ-112: формат чисел и дат отдельно от языка ───────────────────────────────────────────────────────────────────

test('REQ-112 TST-58 «ru + 1.234,50 €»: 123450 показывается «1.234,50 €» и разбирается обратно; в данных и выгрузке — 123450 и 2026-10-04', () => {
  const nf = { decimal: ',', thousands: '.' };
  const f = NF.make_nf_fmt('ru', 'EUR', '2026-10-04', nf);
  assert.equal(f.money(123450), `1.234,50${NBSP}€`);
  assert.equal(f.money(123450).replace(/ /g, ' '), '1.234,50 €', 'как в требовании');
  assert.equal(f.money(-9000), `${MINUS}90,00${NBSP}€`);
  assert.equal(f.money0(123451), `1.235${NBSP}€`, 'без дробной части — округление half_even');
  assert.equal(f.date('2026-10-04'), '4 октября', 'даты отдельно от чисел: стиль auto — по языку');
  assert.equal(f.bp(4147), `41,47${NBSP}%`);
  assert.deepEqual(NF.parse_amount_text('1.234,50 €', 'EUR', 'ru', nf), { ok: true, value: 123450 });
  assert.deepEqual(NF.parse_amount_text(f.money(123450), 'EUR', 'ru', nf), { ok: true, value: 123450 });
  assert.deepEqual(NF.parse_amount_text(f.money(-9000), 'EUR', 'ru', nf, { negative: true }), { ok: true, value: -9000 });
  assert.equal(NF.parse_amount_text('1 234,50', 'EUR', 'ru', nf).ok, false, 'при формате «1.234,50» пробел группой тысяч не считается');
  assert.equal(NF.parse_amount_text('1.23,50', 'EUR', 'ru', nf).ok, false, 'группы тысяч — строго по три цифры');
  // язык en с тем же форматом чисел: слова и порядок символа — от языка, числа — от формата
  assert.equal(NF.make_nf_fmt('en', 'EUR', '2026-10-04', nf).money(123450), '€1.234,50');
  // данные и выгрузка: правка меняет только ключ number_format
  const r = apply_edit(G, { type: 'set_number_format', number_format: nf });
  assert.equal(r.ok, true);
  assert.deepEqual(r.touched, ['number_format']);
  const { number_format, ...rest } = r.ws;
  assert.deepEqual(rest, G, 'суммы, даты и параметры не затронуты');
  const exported = JSON.stringify(r.ws);
  assert.ok(exported.includes('"amount_minor":400000') && exported.includes('"date":"2026-10-04"'), 'в выгрузке целые minor units и ISO-даты');
  assert.ok(!exported.includes('1.234'), 'отформатированных чисел в данных нет');
  assert.equal(APP.build_model(r.ws).ctx.inputs_hash, APP.build_model(G).ctx.inputs_hash, 'формат показа не входит во входы расчёта');
});

test('REQ-112 TST-58 без настройки make_nf_fmt равен make_fmt приложения (ru и en): деньги, даты, короткие даты, промилле, bp, дни', () => {
  for (const lang of ['ru', 'en']) {
    for (const as_of of ['2026-10-04', '2027-01-02']) {
      const a = APP.make_fmt(lang, 'EUR', as_of);
      const b = NF.make_nf_fmt(lang, 'EUR', as_of, undefined);
      for (const v of [0, 5, -5, 99, 100, 123450, -123450, 100000000, -9000, 123456789]) {
        assert.equal(b.money(v), a.money(v), `${lang} money ${v}`);
        assert.equal(b.money0(v), a.money0(v), `${lang} money0 ${v}`);
      }
      for (const d of ['2026-10-04', '2026-12-31', '2027-01-05', '2025-03-09']) {
        assert.equal(b.date(d), a.date(d), `${lang} date ${d}`);
        assert.equal(b.short(d), a.short(d), `${lang} short ${d}`);
      }
      for (const v of [0, 1, -1, 1543, 1700, -2790, 12345]) assert.equal(b.pm(v), a.pm(v), `${lang} pm ${v}`);
      for (const v of [0, 1, 4147, 10000, 12550, -500, 7, 4150]) assert.equal(b.bp(v), a.bp(v), `${lang} bp ${v}`);
      for (const n of [0, 1, 2, 5, 21, 22, 111]) assert.equal(b.days(n), a.days(n), `${lang} days ${n}`);
      assert.equal(b.exp, a.exp);
    }
  }
  assert.equal(NF.make_nf_fmt('ru', 'JPY', '2026-10-04').money(1234), `1${NBSP}234${NBSP}JPY`, 'валюта без символа — код после числа, экспонента 0');
});

test('REQ-112 TST-51 круг «показать → разобрать» без потерь: все пресеты × языки × 3000 случайных сумм; стили дат — круг и отказ на несуществующих датах', () => {
  const rng = make_rng(112);
  for (const lang of ['ru', 'en']) {
    for (const [id, preset] of Object.entries(NF.NUMBER_PRESETS)) {
      const nf = preset === null ? undefined : { ...preset };
      const f = NF.make_nf_fmt(lang, 'EUR', '2026-10-04', nf);
      const r = NF.resolve_number_format(lang, nf);
      for (let i = 0; i < 300; i++) {
        const v = rng.int(-2_000_000_000, 2_000_000_000);
        assert.deepEqual(NF.parse_amount_text(f.money(v), 'EUR', lang, nf, { negative: true }), { ok: true, value: v }, `${lang} ${id} ${v}: ${f.money(v)}`);
        const plain = NF.format_input_amount(Math.abs(v), 2, r);
        assert.deepEqual(NF.parse_amount_text(plain, 'EUR', lang, nf), { ok: true, value: Math.abs(v) }, `${lang} ${id} поле ввода ${plain}`);
      }
    }
  }
  // «12,50» при разделителе тысяч «,» — не 1250 (TST-51, REQ-091)
  assert.equal(NF.parse_amount_text('12,50', 'EUR', 'en', undefined).ok, false);
  assert.deepEqual(NF.parse_amount_text('12,500', 'EUR', 'en', undefined), { ok: true, value: 1250000 }, 'en: «12,500» — двенадцать тысяч пятьсот');
  assert.deepEqual(NF.parse_amount_text('12,500.00', 'EUR', 'en', undefined), { ok: true, value: 1250000 });
  for (const [style, text] of [['iso', '2026-10-04'], ['dmy', '04.10.2026'], ['mdy', '10/04/2026']]) {
    const nf = { date: style };
    assert.equal(NF.make_nf_fmt('ru', 'EUR', '2026-10-04', nf).date('2026-10-04'), text, style);
    assert.equal(NF.parse_date_text(text, 'ru', nf), '2026-10-04', 'разбор ' + style);
    assert.equal(NF.parse_date_text(text.replace('04', '30').replace('10', '02'), 'ru', nf), null, 'несуществующая дата: ' + style);
  }
  assert.equal(NF.parse_date_text('4.10.2026', 'ru', undefined), '2026-10-04', 'auto + ru: день.месяц.год');
  assert.equal(NF.parse_date_text('10/4/2026', 'en', undefined), '2026-10-04', 'auto + en: месяц/день/год');
  assert.equal(NF.parse_date_text('2026-10-04', 'en', undefined), '2026-10-04');
  assert.equal(NF.make_nf_fmt('ru', 'EUR', '2026-10-04', { date: 'dmy' }).short('2026-11-14'), '14.11');
  assert.equal(NF.make_nf_fmt('ru', 'EUR', '2026-10-04', { date: 'iso' }).short('2027-01-05'), '2027-01-05');
  assert.equal(NF.make_nf_fmt('en', 'EUR', '2026-10-04', { date: 'mdy' }).short('2026-11-14'), '11/14');
});

test('REQ-112 REQ-017: правка set_number_format — проверка значений, «ловушки» ключей, возврат к языку; чужая настройка из файла безопасна', () => {
  for (const bad of [
    { type: 'set_number_format', number_format: { decimal: ',', thousands: ',' } },
    { type: 'set_number_format', number_format: { decimal: ';', thousands: '' } },
    { type: 'set_number_format', number_format: { decimal: ',' } },
    { type: 'set_number_format', number_format: { date: 'yyyy' } },
    { type: 'set_number_format', number_format: { decimal: ',', thousands: '.', extra: 1 } },
    { type: 'set_number_format', number_format: 'ru' },
    { type: 'set_number_format', number_format: [] },
    { type: 'set_number_format' },
    { type: 'set_number_format', number_format: null, lang: 'ru' },
  ]) {
    const r = apply_edit(G, bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.error.code, 'E_SCHEMA', JSON.stringify(bad));
  }
  const evil = JSON.parse('{"type":"set_number_format","number_format":{"__proto__":{"decimal":","},"date":"iso"}}');
  assert.equal(apply_edit(G, evil).ok, false, '__proto__ в правке отвергается');
  const set = apply_edit(G, { type: 'set_number_format', number_format: { decimal: ',', thousands: '.', date: 'iso' } });
  assert.deepEqual(set.ws.number_format, { decimal: ',', thousands: '.', date: 'iso' });
  assert.deepEqual(apply_edit(G, { type: 'set_number_format', number_format: { date: 'auto' } }).ws.number_format, undefined, 'пустая настройка = «по языку»: ключа нет');
  const back = apply_edit(set.ws, { type: 'set_number_format', number_format: null });
  assert.equal(back.ok, true);
  assert.ok(!Object.hasOwn(back.ws, 'number_format'));
  assert.deepEqual(back.ws, G);
  // чужой файл: недопустимое значение не ломает показ — формат языка
  for (const hostile of [{ decimal: 'x', thousands: '.' }, { decimal: ',', thousands: ',' }, 'ru', 5, [], { date: '<b>' }, JSON.parse('{"__proto__":{"decimal":","}}'), { decimal: ',', thousands: '.', style: 'x' }]) {
    assert.equal(NF.sanitize_number_format(hostile), null, JSON.stringify(hostile));
    assert.deepEqual(NF.resolve_number_format('ru', hostile), { decimal: ',', thousands: ' ', date: 'auto' });
    assert.equal(NF.make_nf_fmt('ru', 'EUR', '2026-10-04', hostile).money(123450), `1${NBSP}234,50${NBSP}€`);
  }
  assert.equal(NF.preset_of({ decimal: ',', thousands: '.' }), 'dot_comma');
  assert.equal(NF.preset_of(undefined), 'auto');
  assert.equal(NF.preset_of({ date: 'iso' }), 'auto');
  assert.equal(NF.date_style_of({ date: 'iso' }), 'iso');
});

test('REQ-112 REQ-012: настройка формата доходит до журнала и возвращается из него; снятие настройки убирает ключ', () => {
  const j = create_journal({ events: ws_to_events(G), ports: ports_from_gen(make_id_gen(seeded_ports({ seed: 9 }))) });
  const ws2 = apply_edit(G, { type: 'set_number_format', number_format: { decimal: ',', thousands: '.', date: 'dmy' } }).ws;
  sync_journal(j, G, ws2);
  assert.deepEqual(events_to_ws(j.events()).number_format, ws2.number_format);
  const ws3 = apply_edit(ws2, { type: 'set_number_format', number_format: null }).ws;
  sync_journal(j, ws2, ws3);
  assert.equal(events_to_ws(j.events()).number_format, undefined);
});

test('REQ-112 экран: выбор формата меняет предпросмотр, «Сохранить» пишет number_format одной правкой; цифры в данных не меняются; карточки показывают числа в новом формате', () => {
  const { ctx, st } = make_env(G);
  const root = ST.render_settings(ctx);
  assert.match(text_of(by_id(root, 'set-nf-preview')), /Пример: 1 234,50 €; −90,00 €; 4 октября\./);
  by_id(root, 'set-nf-preset').value = 'dot_comma';
  by_id(root, 'set-nf-preset').listeners.change[0]();
  assert.match(text_of(by_id(root, 'set-nf-preview')), /Пример: 1\.234,50 €; −90,00 €; 4 октября\./);
  by_id(root, 'set-nf-date').value = 'iso';
  by_id(root, 'set-nf-date').listeners.change[0]();
  assert.match(text_of(by_id(root, 'set-nf-preview')), /; 2026-10-04\.$/);
  const before = st.ws;
  submit_form(root, 'settings-format');
  assert.deepEqual(st.ws.number_format, { decimal: ',', thousands: '.', date: 'iso' });
  assert.deepEqual({ ...st.ws, number_format: undefined }, { ...before, number_format: undefined }, 'остальные данные прежние');
  const root2 = ST.render_settings(ctx);
  assert.equal(by_id(root2, 'set-nf-preset').value, 'dot_comma', 'выбранное значение сохранилось');
  assert.equal(by_id(root2, 'set-nf-date').value, 'iso');
  assert.match(text_of(by_id(root2, 'settings-buffer')), /Сейчас задан: 500,00 €/);
  // тот же выбор ещё раз — правки нет
  submit_form(root2, 'settings-format');
  assert.match(text_of(by_id(root2, 'settings-format')), /Значения не изменились\./);
  // поле суммы читает формат: «1.234,50»
  by_id(root2, 'set-buffer').value = '1.234,50';
  submit_form(root2, 'settings-buffer');
  assert.equal(st.ws.params.buffer_minor, 123450);
  assert.equal(by_id(ST.render_settings(ctx), 'set-buffer').value, '1234,50', 'в поле — без групп тысяч, десятичный знак по формату');
  // плановая правка: пусто → null → убирает ключ
  const planned = ST.plan_format_edit(st.model, 'auto', 'auto');
  assert.deepEqual(planned.edits, [{ type: 'set_number_format', number_format: null }]);
  assert.deepEqual(ST.plan_format_edit(APP.build_model(G), 'auto', 'auto').edits, [], 'ничего не выбрано — правки нет');
  assert.equal(ST.plan_format_edit(APP.build_model(G), 'нет-такого', 'auto').ok, false);
  assert.equal(ST.plan_format_edit(APP.build_model(G), 'auto', 'нет-такого').ok, false);
  assert.deepEqual(ST.candidate_number_format({ decimal: '.', thousands: ',' }, 'custom', 'iso').value, { decimal: '.', thousands: ',', date: 'iso' });
  assert.ok(find_all(ST.render_settings(make_env({ ...G, number_format: { decimal: '.', thousands: '' } }).ctx), (n) => n.tagName === 'option').length > 0);
});

test('REQ-112: пресет из файла, которого нет в списке, остаётся выбираемым («custom») и сохраняется без изменений', () => {
  assert.equal(NF.preset_of({ decimal: ',', thousands: '.', date: 'mdy' }), 'dot_comma');
  const custom = { ...G, number_format: { decimal: '.', thousands: ' ' } };
  assert.equal(NF.preset_of(custom.number_format), 'custom');
  const { ctx } = make_env(custom);
  const root = ST.render_settings(ctx);
  const opts = find_all(by_id(root, 'set-nf-preset'), (n) => n.tagName === 'option').map((o) => o.getAttribute('value'));
  assert.ok(opts.includes('custom'));
  assert.equal(by_id(root, 'set-nf-preset').value, 'custom');
  assert.deepEqual(ST.plan_format_edit(APP.build_model(custom), 'custom', 'auto').edits, []);
});

// ── пакет в приложении ──────────────────────────────────────────────────────────────────────────────────────────────

test('пакет FP-03 в реестре: экран #settings в навигации после экранов приложения, две карточки в overview.cards, правка set_number_format и строки зарегистрированы; повторная регистрация не падает', async () => {
  const diag = PACK_EXT.diagnostics().filter((d) => d.pack === 'pack_fp03');
  assert.deepEqual(diag.map((d) => d.status), ['ok']);
  const items = PACK_EXT.nav_items();
  assert.deepEqual(items.at(-1), { id: 'settings', title_key: 'settings.nav', core: false });
  assert.equal(items.at(-2).id, 'data');
  assert.equal(PACK.SETTINGS_ORDER, 85);
  const { ctx } = make_env(G, { ext: PACK_EXT });
  const view = PACK_EXT.render_view('settings');
  assert.equal(by_id(view, 'view-title').textContent, 'Настройки');
  const cards = PACK_EXT.slot_nodes('overview.cards');
  assert.deepEqual(cards.map((n) => n.className), ['card fp03-runway', 'card fp03-ready']);
  assert.equal(I18N.t('ru', 'settings.nav'), 'Настройки');
  assert.equal(I18N.t('en', 'settings.nav'), 'Settings');
  assert.equal(typeof ctx.edit, 'function');
  // правка зарегистрирована в общем реестре правок: общий путь ctx.edit принимает её
  const r = ctx.edit({ type: 'set_number_format', number_format: { decimal: '.', thousands: ',' } });
  assert.equal(r.ok, true);
  assert.deepEqual(ctx.get_ws().number_format, { decimal: '.', thousands: ',' });
  // второй вызов register (другой реестр, другой процесс-«перезапуск») не ломается на уже зарегистрированной правке
  const e2 = create_ext({ ports: seeded_ports({ seed: 4 }) });
  const calls = [];
  PACK.register({
    register_i18n: () => calls.push('i18n'), ensure_css: (h) => calls.push(h), register_edit: () => calls.push('edit'),
    register_view: (d) => calls.push('view:' + d.id), register_slot_item: (s, d) => calls.push(s + ':' + d.id), register_hook: (n) => calls.push('hook:' + n),
  });
  assert.deepEqual(calls, ['i18n', 'i18n', 'css/settings.css', 'view:settings', 'overview.cards:fp03_runway', 'overview.cards:fp03_ready', 'hook:fmt'], 'правка уже есть — повторно не регистрируется; хук fmt — формат чисел отдельно от языка (REQ-112); два каталога строк: settings.* и defaults.* (FP-17)');
  assert.ok(e2 !== null);
});

test('экран и карточки по-английски: ни одной русской строки пакета в en, ни одной английской в ru', () => {
  const { ctx } = make_env(G, { lang: 'en' });
  const en = text_of(ST.render_settings(ctx)) + text_of(HC.runway_card(ctx)) + text_of(HC.ready_card(ctx));
  assert.match(en, /Settings/);
  assert.match(en, /Use the hint/);
  assert.ok(!/[а-яё]/i.test(en), 'в английском тексте нет кириллицы: ' + (en.match(/[а-яё]+/i)?.[0] ?? ''));
  const ru = text_of(ST.render_settings(make_env(G).ctx));
  assert.ok(!/Use the hint|Save\b/.test(ru));
  const empty = ST.render_settings({ ...make_env(G).ctx, get_model: () => null });
  assert.match(text_of(empty), /Набор данных ещё не загружен\./);
  assert.equal(HC.runway_card({ ...make_env(G).ctx, get_model: () => null }), null);
  assert.equal(HC.ready_card({ ...make_env(G).ctx, get_model: () => null }), null);
});

// ── TST-56: строки пакета ───────────────────────────────────────────────────────────────────────────────────────────

const SRC = Object.fromEntries(['settings.mjs', 'home_cards.mjs', 'number_format.mjs', 'pack_fp03.mjs'].map((f) => [f, fs.readFileSync(path.join(DEMO, f), 'utf8')]));
const ALL_SRC = Object.values(SRC).join('\n');

test('TST-56 каталог settings: паритет RU/EN и плейсхолдеров, пространство имён, каждый ключ используется кодом, семейства динамических ключей полны', () => {
  const ph = (s) => [...s.matchAll(/{([A-Za-z0-9_]+)}/g)].map((m) => m[1]).sort().join(',');
  assert.deepEqual(Object.keys(CATALOG.ru).sort(), Object.keys(CATALOG.en).sort());
  const prefixes = [...ALL_SRC.matchAll(/'(settings\.[a-z0-9_]*)'\s*\+/g)].map((m) => m[1]);
  const literals = new Set([...ALL_SRC.matchAll(/'(settings\.[a-z0-9_]+)'(?!\s*\+)/g)].map((m) => m[1]));
  for (const k of Object.keys(CATALOG.ru)) {
    assert.ok(k.startsWith('settings.'), k);
    assert.equal(ph(CATALOG.ru[k]), ph(CATALOG.en[k]), 'плейсхолдеры ' + k);
    assert.ok(literals.has(k) || prefixes.some((p) => k.startsWith(p)), 'ключ без использования: ' + k);
    assert.match(CATALOG.ru[k], /[а-яё]/i, 'RU-строка без русских букв: ' + k);
  }
  for (const k of literals) assert.ok(Object.hasOwn(CATALOG.ru, k), 'код ссылается на несуществующий ключ ' + k);
  const need = (prefix, tails) => { for (const x of tails) assert.ok(Object.hasOwn(CATALOG.ru, 'settings.' + prefix + x), `нет ключа settings.${prefix}${x}`); };
  const ids = Object.values(ST.SECTIONS).flat().map((d) => d.id);
  need('f_', [...ids, 'nf_preset', 'nf_date']);
  need('s_', [...Object.keys(ST.SECTIONS), 'format']);
  need('l_', [...Object.keys(ST.SECTIONS), 'format']);
  need('h_', ids);
  need('e_', ['empty', 'bad_number', 'negative', 'too_big', 'range']);
  need('nf_', Object.keys(NF.NUMBER_PRESETS).concat('custom'));
  need('df_', NF.DATE_STYLES);
  need('rd_level_', HC.READINESS_LEVELS);
  need('rd_step_', HC.READINESS_STEPS.map((s) => s.id));
  need('rd_miss_', HC.READINESS_STEPS.map((s) => s.reason).concat('other'));
  need('gt_', HC.GATE_REASONS.concat('other'));
  // каталог принят общей точкой слияния (регистрация пакета уже прошла) и совпадает со строками словаря
  for (const k of Object.keys(CATALOG.ru)) { assert.equal(I18N.t('ru', k), CATALOG.ru[k]); assert.equal(I18N.t('en', k), CATALOG.en[k]); }
  // названия ступеней готовности не противоречат словарю движка: уровни — те же пять
  assert.deepEqual([...HC.READINESS_LEVELS], ['empty', 'skeleton', 'working', 'working_plus', 'full']);
});

test('TST-56 §10 тон: в строках пакета нет запрещённых формулировок и налоговых обещаний; вердикты — слова словаря', () => {
  const vocab = JSON.parse(fs.readFileSync(path.join(PROTO, 'engine', 'vocab.json'), 'utf8'));
  const corpus = [...Object.values(CATALOG.ru), ...Object.values(CATALOG.en), ...Object.values(SRC)].join('\n').toLowerCase().replace(/ё/g, 'е');
  for (const phrase of vocab.forbidden_phrases) assert.ok(!corpus.includes(phrase.toLowerCase().replace(/ё/g, 'е')), 'запрещено: ' + phrase);
  for (const w of ['спокойно', 'hallucinat', 'guarantee', 'risk-free', 'exact figures']) assert.ok(!corpus.includes(w), w);
  assert.ok(!/налог|\btax/i.test(Object.values(CATALOG.ru).join(' ') + Object.values(CATALOG.en).join(' ')), 'в экране настроек налогов нет: оговорка не требуется');
});

// ── TST-59: безопасность UI ─────────────────────────────────────────────────────────────────────────────────────────

test('TST-59 FP-03: нет innerHTML и inline-стилей, обработчиков-строк, eval, сети; CSS без внешних адресов; параметры пишутся только через set_param', () => {
  const css = fs.readFileSync(path.join(DEMO, 'css', 'settings.css'), 'utf8');
  const cat_src = fs.readFileSync(path.join(DEMO, 'i18n', 'settings.mjs'), 'utf8');
  for (const [name, src] of [...Object.entries(SRC), ['i18n/settings.mjs', cat_src]]) {
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'srcdoc', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'EventSource', 'importScripts', 'eval(', 'new Function', 'document.write', 'localStorage']) {
      assert.ok(!src.includes(bad), `${name}: ${bad}`);
    }
    assert.ok(!/setAttribute\(\s*['"]style['"]/.test(src), `${name}: атрибут style`);
    assert.ok(!/\.style\b|\.cssText/.test(src.replace(/^\s*(\/\/|\*).*$/gm, '')), `${name}: правка стилей из кода`);
    assert.ok(!/(^|[{,\s])style\s*:/m.test(src.replace(/^\s*(\/\/|\*).*$/gm, '')), `${name}: style: в атрибутах узла`);
    assert.ok(!/\bfetch\(|\bimport\(/.test(src), `${name}: сеть или динамический импорт`);
    assert.ok(!/\bon[a-z]+\s*:\s*['"`]/.test(src), `${name}: обработчик-строка`);
    assert.ok(!/https?:\/\//.test(src), `${name}: внешний адрес`);
  }
  assert.ok(!/@import|url\(|https?:/i.test(css), 'CSS без внешних адресов и url()');
  assert.ok(!/!important/.test(css));
  // параметры — только через правку set_param: нет прямых записей в params и вызовов set_ws вне пути «apply_edit → set_ws»
  assert.match(SRC['settings.mjs'], /type:\s*'set_param'/);
  assert.ok(!/\bparams\s*:\s*\{|\.params\[[^\]]+\]\s*=[^=]|\.params\.[\w$]+\s*=[^=]|\bparams\s*=\s*\{/.test(SRC['settings.mjs'].replace(/^\s*(\/\/|\*).*$/gm, '')), 'прямой записи в params нет');
  assert.equal((SRC['settings.mjs'].match(/\bctx\.set_ws\(/g) ?? []).length, 1, 'единственная запись — после apply_edit');
  assert.ok(/apply_edit\(ws, e,/.test(SRC['settings.mjs']));
  assert.ok(!/from '\.\/app\.mjs'/.test(ALL_SRC), 'пакет не импортирует app.mjs');
});

test('TST-59 FP-03: узлы строятся через dom.mjs (textContent): текст из данных не становится разметкой; значения полей не пишутся в атрибуты style', () => {
  const evil = { ...G, name: '<img src=x onerror=alert(1)>', accounts: G.accounts.map((a) => ({ ...a, name: '<b>счёт</b>' })) };
  const { ctx } = make_env(evil);
  const nodes = [ST.render_settings(ctx), HC.runway_card(ctx), HC.ready_card(ctx)];
  for (const root of nodes) {
    root.walk((n) => {
      assert.ok(!Object.hasOwn(n.attrs, 'style'), 'нет атрибута style');
      for (const k of Object.keys(n.attrs)) assert.ok(!/^on/i.test(k), 'нет атрибутов-обработчиков: ' + k);
    });
  }
  const inp = by_id(nodes[0], 'set-buffer');
  inp.value = '<script>alert(1)</script>';
  submit_form(nodes[0], 'settings-buffer');
  assert.match(text_of(by_id(nodes[0], 'set-buffer-err')), /Не удалось прочитать число/);
  assert.ok(!text_of(by_id(nodes[0], 'set-buffer-err')).includes('<script>'), 'введённый текст в сообщении об ошибке не повторяется');
});

test('экран «Настройки» открывается на всех четырёх наборах данных и при s < 3 (в том числе пустой рабочей области), не падая', () => {
  for (const ws of [G, LOW, GAP, no_acc, no_groc, { ...G, number_format: { decimal: '.', thousands: '' } }]) {
    const { ctx } = make_env(ws);
    const root = ST.render_settings(ctx);
    for (const id of ['settings-buffer', 'settings-today', 'settings-horizon', 'settings-waves', 'settings-match', 'settings-format']) assert.ok(by_id(root, id) !== undefined, id);
    assert.equal(find_all(root, (n) => n.tagName === 'form').length, 7); // FP-29: +форма «Валюта решения»
    assert.ok(HC.ready_card(ctx) !== null && HC.runway_card(ctx) !== null);
  }
});
