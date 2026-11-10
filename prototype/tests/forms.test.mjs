// forms.test.mjs — FP-08: формы данных (правила, часы, налог, накопления, курсы и обмен, счета и запас, рассрочка), «пишущий» слой демо.
// Часть 1 — чистые модели и виды правок без DOM: разбор ввода по формату чисел рабочей области, предпросмотр, запись через `apply_edit`, коды `E_*` без повтора введённого.
// Часть 2 — настоящий app.mjs на заглушке DOM: пакет pack_fp08 подхватывается манифестом, экран #forms и карточки на «Резервы» работают, запись идёт общим путём
// (ctx.set_ws → пересчёт страницы → журнал). Браузер не используется.
// Запуск: node --test --test-timeout=120000 --test-concurrency=1 tests/forms.test.mjs
// Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const DEMO = path.join(PROTO, 'demo');
const G = JSON.parse(fs.readFileSync(path.join(PROTO, 'data', 'g001.json'), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));

// ── заглушка DOM (минимальная: проверяется связка app.mjs ↔ ext.mjs ↔ пакет, а не вёрстка) ─────────────────────────────

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
  createElement: (t) => new Node_(t),
  createElementNS: (ns, t) => new Node_(t, ns),
  createTextNode: (data) => ({ nodeType: 3, data }),
  getElementById: (id) => byid.get(id) ?? null,
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
globalThis.fetch = async (url) => {
  const file = fileURLToPath(url);
  return { ok: true, json: async () => JSON.parse(fs.readFileSync(file, 'utf8')) };
};

const imp = (rel) => import(pathToFileURL(path.join(PROTO, rel)).href);
const { ext } = await imp('demo/ext.mjs');
const E = await imp('engine/index.mjs');
const { make_tool_ctx } = await imp('engine/tools.mjs');
const WE = await imp('demo/ws_edit.mjs');
const FORMS = await imp('demo/forms.mjs');
const RULE = await imp('demo/form_rule.mjs');
const HOURS = await imp('demo/form_hours.mjs');
const TAX = await imp('demo/form_tax.mjs');
const SINK = await imp('demo/form_sinking.mjs');
const FX = await imp('demo/form_fx.mjs');
const ACC = await imp('demo/form_accounts.mjs');
const INST = await imp('demo/form_installment.mjs');
const PACK = await imp('demo/pack_fp08.mjs');
const { reserve_behind_detail } = await imp('engine/sinking_report.mjs');

// виды правок пакета — один раз на процесс (как это делает register)
for (const [type, fn] of Object.entries(PACK.EDITS)) if (!WE.list_edit_types().includes(type)) WE.register_edit(type, fn);

const ENV = { cur: 'EUR', lang: 'ru', nf: undefined, as_of: G.as_of };
const ids = (() => { let n = 0; return (p) => `${p}_t${String(++n).padStart(4, '0')}`; })();
const model_of = (ws) => ({ ws, ctx: make_tool_ctx(ws, { as_of: ws.as_of }, { locale: 'ru' }), cur: ws.decision_currency, as_of_iso: ws.as_of });
const apply = (ws, edit, env = {}) => WE.apply_edit(ws, edit, { new_id: ids, ...env });
const must = (r) => { assert.equal(r.ok, true, JSON.stringify(r.error)); return r.ws ?? r; };
const no_echo = (r, typed) => assert.ok(!JSON.stringify(r).includes(typed), `введённый текст «${typed}» повторён в ошибке: ${JSON.stringify(r)}`);
const CODES = ['E_NOT_INTEGER', 'E_OVERFLOW', 'E_BAD_DATE', 'E_FUTURE_POSTED', 'E_RULE_INVALID', 'E_CURRENCY_MISMATCH', 'E_NO_RATE', 'E_SCHEMA'];
const STREAM = G.streams[0];

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Часть 1. Чистые модели
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

test('REQ-112 разбор полей: числа — по формату рабочей области, а не по языку интерфейса; ставка «20» → 2000 bp без float; часы «93», «93:30», «93,5»; курс «0,9250» → 9250/10000 как введён', () => {
  const ru = { ...ENV, nf: undefined };
  const en = { ...ENV, lang: 'ru', nf: { decimal: '.', thousands: ',' } }; // формат «en» при русском интерфейсе
  assert.equal(FORMS.parse_money('1 234,50', ru, 'amount').value, 123450);
  assert.equal(FORMS.parse_money('1,234.50', en, 'amount').value, 123450);
  assert.equal(FORMS.parse_money('0', ru, 'amount').error.ctx.reason, 'zero');
  assert.equal(FORMS.parse_money('−5', ru, 'amount').error.code, 'E_SCHEMA', 'знак «−» без права negative');
  assert.equal(FORMS.parse_money('99999999999999999', ru, 'amount').error.code, 'E_OVERFLOW');
  assert.equal(FORMS.parse_percent_bp('20', ru, 'rate').value, 2000);
  assert.equal(FORMS.parse_percent_bp('20,5 %', ru, 'rate').value, 2050);
  assert.equal(FORMS.parse_percent_bp('100,01', ru, 'rate').error.code, 'E_SCHEMA');
  assert.equal(FORMS.parse_percent_bp('двадцать', ru, 'rate').error.code, 'E_NOT_INTEGER');
  assert.equal(FORMS.parse_hours('93', ru, 'h').value, 5580);
  assert.equal(FORMS.parse_hours('93:30', ru, 'h').value, 5610);
  assert.equal(FORMS.parse_hours('93,5', ru, 'h').value, 5610);
  assert.equal(FORMS.parse_hours('93,33', ru, 'h').error.ctx.reason, 'fraction_not_whole_minutes');
  assert.equal(FORMS.parse_hours('10000', ru, 'h').error.code, 'E_SCHEMA');
  assert.deepEqual(FORMS.parse_rate('0,9250', ru, 'rate').value, { num: 9250, den: 10000 });
  assert.deepEqual(FORMS.parse_rate('0.9250', en, 'rate').value, { num: 9250, den: 10000 });
  assert.equal(FORMS.parse_rate('0,9250', en, 'rate').ok, false, 'запятая не десятичный знак формата «en»');
  assert.equal(FORMS.parse_rate('0', ru, 'rate').error.code, 'E_SCHEMA');
  assert.equal(FORMS.rate_text(9250, 10000, ru), '0,9250');
  assert.equal(FORMS.rate_text(2303, 2500, ru), '0,9212');
  assert.match(FORMS.rate_text(1, 3, ru), /^≈ 0,333333$/);
  assert.equal(FORMS.parse_date_input('2026-10-04', ru, 'd').value, '2026-10-04');
  assert.equal(FORMS.parse_date_input('2026-02-30', ru, 'd').error.code, 'E_BAD_DATE');
  assert.equal(FORMS.parse_date_input('', ru, 'd', { optional: true }).value, null);
  assert.equal(FORMS.parse_count('7', 'n', 1, 12).value, 7);
  assert.equal(FORMS.parse_count('13', 'n', 1, 12).error.code, 'E_SCHEMA');
  assert.equal(FORMS.parse_signed_int('−1', 'd', -31, 31).value, -1);
  assert.equal(FORMS.parse_signed_int('0', 'd', -31, 31).error.ctx.reason, 'zero');
  assert.deepEqual(['one', 'few', 'many', 'many'], [1, 2, 5, 11].map((n) => FORMS.plural_cat('ru', n)));
});

// ── REQ-032 правила: предпросмотр и «пропустить вхождение» ─────────────────────────────────────────────────────────────

const RULE_TEXTS = {
  rule_id: 'rule_new', name: 'Подписка', kind: 'expense', amount: '15', account_id: 'acc_main', freq: 'M', interval: '1', start_date: '2026-10-10',
  monthday: '', weekday: '', weekend: 'keep', until_date: '', is_obligation: true, is_estimate: false,
};

test('REQ-032 форма правила: правило собирается из текстов, предпросмотр показывает ближайшие даты и суммы — те же, что увидит прогноз; невалидный ввод — код E_*, введённый текст не повторяется', () => {
  const built = RULE.build_rule_edit(G, RULE_TEXTS, ENV);
  assert.equal(built.ok, true, JSON.stringify(built.error));
  assert.equal(built.edit.rule.amount.exp_minor, -1500, 'вид «расход» задаёт знак');
  assert.equal(built.edit.rule.currency, 'EUR');
  const p = RULE.rule_preview(G, built.edit, { as_of: G.as_of, new_id: ids });
  assert.equal(p.ok, true);
  assert.deepEqual(p.rows.slice(0, 3).map((x) => x.date), ['2026-10-10', '2026-11-10', '2026-12-10']);
  assert.equal(p.rows.length, RULE.PREVIEW_ROWS);
  // те же вхождения видит прогноз
  const ws2 = must(apply(G, built.edit));
  const events = E.analyze(ws2, { as_of: ws2.as_of }).events.plan.filter((e) => e.rule_id === 'rule_new');
  assert.deepEqual(events.slice(0, 2).map((e) => [E.format_date(e.date), e.amount_minor]), [['2026-10-10', -1500], ['2026-11-10', -1500]]);
  const bads = [
    [{ amount: 'abc' }, 'abc', 'E_NOT_INTEGER'], [{ amount: '' }, '', 'E_NOT_INTEGER'], [{ interval: '0' }, '0', 'E_SCHEMA'], [{ interval: 'x1' }, 'x1', 'E_NOT_INTEGER'],
    [{ start_date: '2026-02-30' }, '2026-02-30', 'E_BAD_DATE'], [{ monthday: '32' }, '32', 'E_SCHEMA'], [{ name: '   ' }, '   ', 'E_SCHEMA'],
    [{ account_id: 'нет' }, 'нет', 'E_SCHEMA'], [{ kind: 'донат' }, 'донат', 'E_SCHEMA'], [{ freq: 'X' }, 'X', 'E_SCHEMA'], [{ until_date: '2026-13-01' }, '2026-13-01', 'E_BAD_DATE'],
  ];
  for (const [over, typed, code] of bads) {
    const r = RULE.build_rule_edit(G, { ...RULE_TEXTS, ...over }, ENV);
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.equal(r.error.code, code, JSON.stringify(over));
    if (typed.trim() !== '') no_echo(r, typed);
  }
  // правило, которое не проходит validate_rule, отвергается проверкой правки
  const early = RULE.build_rule_edit(G, { ...RULE_TEXTS, until_date: '2026-09-01' }, ENV);
  assert.equal(RULE.rule_preview(G, early.edit, { as_of: G.as_of }).error.code, 'E_RULE_INVALID');
});

test('REQ-032 правка существующего правила: версия повышается, поля вне формы (календарь, исключения) сохраняются; еженедельное правило и последний день месяца собираются из полей', () => {
  const old = G.rules.find((r) => r.rule_id === 'R-RENT');
  const t = { ...RULE_TEXTS, rule_id: 'R-RENT', name: old.name, amount: '950', start_date: old.start_date, monthday: '25', weekend: 'next', is_obligation: true };
  const built = RULE.build_rule_edit(G, t, ENV);
  assert.equal(built.ok, true, JSON.stringify(built.error));
  assert.equal(built.edit.rule.calendar_id, 'cal-main', 'календарь не потерян');
  const ws2 = must(apply(G, built.edit));
  assert.equal(ws2.rules.find((r) => r.rule_id === 'R-RENT').version, 2);
  const weekly = RULE.build_rule_edit(G, { ...RULE_TEXTS, freq: 'W', weekday: '6', start_date: '2026-10-10', interval: '2' }, ENV);
  assert.deepEqual(weekly.edit.rule.by_weekday, [6]);
  const rows = RULE.rule_preview(G, weekly.edit, { as_of: G.as_of }).rows;
  assert.deepEqual(rows.slice(0, 2).map((x) => x.date), ['2026-10-10', '2026-10-24'], 'каждые две недели по субботам');
  const last = RULE.build_rule_edit(G, { ...RULE_TEXTS, monthday: '-1', start_date: '2026-01-31' }, ENV);
  assert.deepEqual(RULE.rule_preview(G, last.edit, { as_of: G.as_of }).rows.slice(0, 2).map((x) => x.date), ['2026-10-31', '2026-11-30']);
});

test('REQ-032: «пропустить вхождение» пишет override skip; вхождение не попадает в ряд, но остаётся в истории; inputs_hash детерминирован; возврат восстанавливает прежний hash', () => {
  const base = E.analyze(G, { as_of: G.as_of });
  const occ = RULE.occurrences_of(G, G.rules.find((r) => r.rule_id === 'R-RENT'), G.as_of, 3);
  assert.equal(occ[0].nominal, '2026-10-25');
  assert.equal(occ[0].date, '2026-10-26', 'воскресенье 25 октября сдвинуто на понедельник');
  assert.ok(base.events.plan.some((e) => e.cash_event_id === 'R-RENT@2026-10-25'));
  const skipped = must(apply(G, RULE.skip_edit('R-RENT', '2026-10-25')));
  assert.deepEqual(skipped.overrides, [{ rule_id: 'R-RENT', nominal_date: '2026-10-25', action: 'skip' }], 'запись об исключении осталась в данных (история)');
  const a1 = E.analyze(skipped, { as_of: G.as_of });
  const a2 = E.analyze(must(apply(clone(G), RULE.skip_edit('R-RENT', '2026-10-25'))), { as_of: G.as_of });
  assert.ok(!a1.events.plan.some((e) => e.cash_event_id === 'R-RENT@2026-10-25'), 'вхождение не попадает в ряд');
  assert.ok(a1.events.plan.some((e) => e.cash_event_id === 'R-RENT@2026-11-25'), 'следующее вхождение на месте');
  assert.equal(a1.inputs_hash, a2.inputs_hash, 'inputs_hash детерминирован');
  assert.notEqual(a1.inputs_hash, base.inputs_hash);
  assert.ok(a1.series.plan.trough.some((v, i) => v !== base.series.plan.trough[i]), 'ряд изменился');
  assert.deepEqual(RULE.skipped_of(skipped, 'R-RENT', G.as_of), ['2026-10-25']);
  assert.equal(RULE.occurrences_of(skipped, skipped.rules.find((r) => r.rule_id === 'R-RENT'), G.as_of, 1)[0].nominal, '2026-11-25');
  const back = must(apply(skipped, RULE.restore_edit('R-RENT', '2026-10-25')));
  assert.equal(E.analyze(back, { as_of: G.as_of }).inputs_hash, base.inputs_hash, 'возврат даёт прежнее состояние');
  assert.deepEqual(back.overrides, []);
});

test('REQ-032 вид правки set_occurrence_override: номинальная дата обязана быть вхождением правила; move и set_amount проверяются validate_override; повтор заменяет запись; ключи-ловушки и float отвергаются', () => {
  const edit = (o) => apply(G, { type: 'set_occurrence_override', override: o });
  assert.equal(edit({ rule_id: 'R-RENT', nominal_date: '2026-10-26', action: 'skip' }).error.ctx.reason, 'not_an_occurrence', '26-е — это сдвинутая дата, а не номинальная');
  assert.equal(edit({ rule_id: 'нет', nominal_date: '2026-10-25', action: 'skip' }).error.ctx.reason, 'unknown_rule');
  assert.equal(edit({ rule_id: 'R-RENT', nominal_date: '2026-02-30', action: 'skip' }).error.code, 'E_BAD_DATE');
  assert.equal(edit({ rule_id: 'R-RENT', nominal_date: '2026-10-25', action: 'delete' }).ok, false);
  assert.equal(edit({ rule_id: 'R-RENT', nominal_date: '2026-10-25', action: 'set_amount', amount_minor: 5000 }).ok, false, 'знак суммы расхода должен быть отрицательным');
  assert.equal(edit({ rule_id: 'R-RENT', nominal_date: '2026-10-25', action: 'set_amount', amount_minor: -1.5 }).error.code, 'E_NOT_INTEGER');
  assert.equal(edit({ rule_id: 'R-RENT', nominal_date: '2026-10-25', action: 'move' }).ok, false, 'для move нужна дата');
  assert.equal(edit({ rule_id: 'R-RENT', nominal_date: '2026-10-25', action: 'skip', extra: 1 }).error.ctx.reason, 'unknown_field');
  assert.equal(apply(G, JSON.parse('{"type":"set_occurrence_override","override":{"rule_id":"R-RENT","nominal_date":"2026-10-25","action":"skip","__proto__":{"x":1}}}')).ok, false);
  const moved = must(edit({ rule_id: 'R-RENT', nominal_date: '2026-10-25', action: 'move', date: '2026-10-28' }));
  assert.equal(E.analyze(moved, { as_of: G.as_of }).events.plan.find((e) => e.cash_event_id === 'R-RENT@2026-10-25').date, E.to_epoch_day('2026-10-28'));
  const again = must(apply(moved, { type: 'set_occurrence_override', override: { rule_id: 'R-RENT', nominal_date: '2026-10-25', action: 'set_amount', amount_minor: -95000 } }));
  assert.equal(again.overrides.length, 1, 'запись с тем же ключом заменяется');
  assert.equal(apply(G, { type: 'set_occurrence_override', remove: true, rule_id: 'R-RENT', nominal_date: '2026-10-25' }).error.ctx.reason, 'unknown_override');
});

// ── REQ-075 / REQ-108 часы ───────────────────────────────────────────────────────────────────────────────────────────

test('REQ-075 REQ-108: диапазон часов 80 / 93 / 110 даёт доход 2 400 / 2 790 / 3 300; ближайшая выплата — 5 ноября, коридор из расчёта страницы', () => {
  const r = HOURS.stream_income_range(STREAM, 'half_even');
  assert.deepEqual(r, { min_minor: 240000, exp_minor: 279000, max_minor: 330000 });
  const a = E.analyze(G, { as_of: G.as_of });
  const p = HOURS.next_payout(a, STREAM);
  assert.equal(E.format_date(p.date), '2026-11-05');
  assert.deepEqual([p.min_minor, p.amount_minor, p.max_minor], [240000, 279000, 330000]);
  assert.deepEqual([E.format_date(p.period.start), E.format_date(p.period.end)], ['2026-10-01', '2026-10-31'], 'доход «за октябрь»');
  const env = TAX.income_envelope_model(model_of(G));
  assert.equal(env.length, 1);
  assert.deepEqual(env[0].envelope[0].alloc, { min: 48000, exp: 55800, max: 66000 }, 'в конверт по правилу 20 %: 558,00 € (диапазон 480,00–660,00 €)');
});

test('REQ-075 TST-26: на 2026-10-20 темп 180 мин/день, план к дате 3600, факт 52 ч = 3120 → недоработка 480 мин (8 ч), эффект 24000 (240,00 €); оценка при rho = 1 — 5100 мин, 255000', () => {
  const m = HOURS.shortfall_model(G, STREAM, '2026-10-20', { actual_minutes: 3120 });
  assert.equal(m.state, 'short');
  assert.equal(m.plan_minutes, 3600);
  assert.equal(m.short_minutes, 480);
  assert.equal(m.effect_minor, 24000);
  assert.equal(m.est_minutes, 5100);
  assert.equal(m.est_gross_minor, 255000);
  assert.equal(HOURS.shortfall_model(G, STREAM, '2026-10-20', { actual_minutes: 3600 }).state, 'even');
  const ahead = HOURS.shortfall_model(G, STREAM, '2026-10-20', { actual_minutes: 3900 });
  assert.deepEqual([ahead.state, ahead.short_minutes, ahead.effect_minor], ['ahead', -300, -15000]);
  assert.equal(HOURS.shortfall_model(G, STREAM, '2026-10-20').state, 'no_fact', 'факта нет — число не выдумывается');
});

test('REQ-075 «отработано N часов»: вид правки set_stream_hours пишет actual_minutes периода; недоработка считается по факту из данных; неверный период, минуты и float отвергаются; null снимает факт', () => {
  const ws = { ...G, as_of: '2026-10-20' };
  const done = must(apply(ws, HOURS.actual_hours_edit('S-HOURLY', '2026-10-01', 3120)));
  assert.equal(done.streams[0].hours_by_period['2026-10-01'].actual_minutes, 3120);
  assert.equal(done.streams[0].hours_by_period['2026-09-01'].actual_minutes, 5760, 'другие периоды целы');
  const m = HOURS.shortfall_model(done, done.streams[0], '2026-10-20');
  assert.deepEqual([m.state, m.short_minutes, m.effect_minor], ['short', 480, 24000]);
  assert.equal(apply(ws, HOURS.actual_hours_edit('S-HOURLY', '2026-10-05', 100)).error.ctx.reason, 'not_a_period_start');
  assert.equal(apply(ws, HOURS.actual_hours_edit('S-HOURLY', '2026-10-01', -1)).error.ctx.reason, 'range');
  assert.equal(apply(ws, HOURS.actual_hours_edit('S-HOURLY', '2026-10-01', 44641)).error.ctx.reason, 'range');
  assert.equal(apply(ws, HOURS.actual_hours_edit('S-HOURLY', '2026-10-01', 12.5)).error.code, 'E_NOT_INTEGER');
  assert.equal(apply(ws, HOURS.actual_hours_edit('нет', '2026-10-01', 100)).error.ctx.reason, 'unknown_stream');
  assert.equal(apply(ws, HOURS.actual_hours_edit('S-HOURLY', '2026-02-30', 100)).error.code, 'E_BAD_DATE');
  const cleared = must(apply(done, HOURS.actual_hours_edit('S-HOURLY', '2026-10-01', null)));
  assert.equal(cleared.streams[0].hours_by_period['2026-10-01'], undefined);
  assert.deepEqual(E.analyze(cleared, { as_of: '2026-10-20' }).inputs_hash, E.analyze(ws, { as_of: '2026-10-20' }).inputs_hash, 'снятие факта возвращает прежнее состояние');
});

test('REQ-075 форма потока: ставка, часы и период собираются из текстов; диапазон дохода виден до записи; порядок min ≤ exp ≤ max проверяет движок; поля вне формы сохраняются при правке', () => {
  const t = {
    stream_id: 'stream_new', name: 'Клиент', account_id: 'acc_main', rate: '30', period: 'month', cutoff_weekday: '', anchor: '', pay_lag_days: '5', weekend: 'next',
    min_hours: '80', exp_hours: '93', max_hours: '110',
  };
  const built = HOURS.build_stream_edit(G, t, ENV);
  assert.equal(built.ok, true, JSON.stringify(built.error));
  assert.deepEqual(HOURS.stream_income_range(built.edit.stream), { min_minor: 240000, exp_minor: 279000, max_minor: 330000 });
  assert.equal(HOURS.check_stream(built.edit.stream).ok, true);
  const ws2 = must(apply(G, built.edit));
  assert.equal(ws2.streams.length, 2);
  const swapped = HOURS.build_stream_edit(G, { ...t, min_hours: '120' }, ENV);
  assert.equal(swapped.ok, true, 'форма собрала правку; проверка порядка — у движка');
  assert.equal(HOURS.check_stream(swapped.edit.stream).ok, false);
  assert.equal(apply(G, swapped.edit).ok, false);
  for (const [over, typed, code] of [[{ rate: 'много' }, 'много', 'E_NOT_INTEGER'], [{ min_hours: 'abc' }, 'abc', 'E_NOT_INTEGER'], [{ pay_lag_days: '99' }, '99', 'E_SCHEMA'],
    [{ period: 'год' }, 'год', 'E_SCHEMA'], [{ weekend: 'skip' }, 'skip', 'E_SCHEMA'], [{ period: 'week', cutoff_weekday: '' }, '', 'E_NOT_INTEGER'], [{ period: 'biweek', cutoff_weekday: '5', anchor: '2026-13-40' }, '2026-13-40', 'E_BAD_DATE']]) {
    const r = HOURS.build_stream_edit(G, { ...t, ...over }, ENV);
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.equal(r.error.code, code, JSON.stringify(over));
    if (typed !== '') no_echo(r, typed);
  }
  const edit_old = HOURS.build_stream_edit(G, { ...t, stream_id: 'S-HOURLY', name: STREAM.name }, ENV);
  assert.deepEqual(edit_old.edit.stream.hours_by_period, STREAM.hours_by_period, 'hours_by_period сохраняется при правке потока');
  assert.equal(edit_old.edit.stream.pace_minutes_per_day, 180);
  assert.equal(HOURS.hours_input(5610), '93:30');
  assert.equal(HOURS.hours_input(5580), '93');
});

test('TST-23 TST-24 REQ-064: выплата 2 790,00 € по потоку — вид правки post_income пишет факт и запись в конверт по правилу на дату факта: 558,00 €; всё или ничего', () => {
  const ws = { ...G, as_of: '2026-11-06' };
  const fact = { account_id: 'acc_main', date: '2026-11-05', amount_minor: 279000, kind: 'income', stream_id: 'S-HOURLY', tag: 'Почасовая работа' };
  const r = apply(ws, { type: 'post_income', fact });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const added = r.ws.facts.at(-1);
  assert.equal(added.amount_minor, 279000);
  assert.equal(r.ws.allocations.length, 1);
  assert.deepEqual(r.ws.allocations[0], {
    allocation_id: 'tax:TR-20@' + added.event_id, reserve_id: 'RES-TAX', date: '2026-11-05', amount_minor: 55800, source: 'income', source_event_id: added.event_id, rule_version: 1,
  });
  assert.equal(E.reserve_open(r.ws.reserves[0], r.ws.allocations, '2026-11-06'), 150000 + 55800, 'конверт вырос на 558,00 €');
  assert.equal(E.analyze(r.ws, { as_of: '2026-11-06' }).series.plan.reserve_opening_minor > 0, true, 'пересчёт принимает запись');
  // всё или ничего: будущая дата — отказ без аллокации
  const bad = apply(ws, { type: 'post_income', fact: { ...fact, date: '2026-11-07' } });
  assert.equal(bad.error.code, 'E_FUTURE_POSTED');
  // без применимого правила — просто факт
  const plain = must(apply(ws, { type: 'post_income', fact: { ...fact, stream_id: undefined, tag: 'прочее' } }));
  assert.equal(plain.allocations.length, 0);
  assert.equal(plain.facts.length, G.facts.length + 1);
  // курс чужой валюты: нет курса — отказ всей правки (факт тоже не записан)
  const usd_ws = { ...ws, accounts: [...ws.accounts, { account_id: 'acc_usd', name: 'USD', kind: 'bank', liquidity: 'savings', currency: 'USD', exponent: 2, liquidity_bp: 0 }] };
  assert.equal(apply(usd_ws, { type: 'post_income', fact: { ...fact, account_id: 'acc_usd' } }).ok, true, 'справочный счёт принимается без курса в add_fact');
});

test('REQ-064 вид правки record_posted_allocations: записи по уже проведённым фактам пачкой; повтор ничего не добавляет; по списку event_ids; ошибка курса — отказ всей правки', () => {
  const ws = {
    ...G, as_of: '2026-11-06',
    facts: [...G.facts,
      { event_id: 'tx-in-1', account_id: 'acc_main', date: '2026-11-05', amount_minor: 279000, currency: 'EUR', kind: 'income', stream_id: 'S-HOURLY' },
      { event_id: 'tx-pay-1', account_id: 'acc_main', date: '2026-11-05', amount_minor: -50000, currency: 'EUR', kind: 'expense', reserve_id: 'RES-TAX' }],
  };
  assert.equal(TAX.edit_record_posted_allocations !== undefined, true);
  const once = must(apply(ws, { type: 'record_posted_allocations' }));
  assert.deepEqual(once.allocations.map((a) => [a.allocation_id, a.amount_minor, a.source]).sort(), [['rel:RES-TAX@tx-pay-1', -50000, 'release'], ['tax:TR-20@tx-in-1', 55800, 'income']]);
  const twice = must(apply(once, { type: 'record_posted_allocations' }));
  assert.deepEqual(twice.allocations, once.allocations, 'повтор безвреден');
  const only = must(apply(ws, { type: 'record_posted_allocations', event_ids: ['tx-in-1'] }));
  assert.equal(only.allocations.length, 1);
  assert.equal(apply(ws, { type: 'record_posted_allocations', event_ids: 'tx-in-1' }).error.ctx.field, 'event_ids');
  assert.equal(apply(ws, { type: 'record_posted_allocations', лишнее: 1 }).error.ctx.reason, 'unknown_field');
  const pend = E.analyze(once, { as_of: '2026-11-06' });
  assert.ok(pend.series.plan.reserve_opening_minor >= 0);
});

// ── налог: правило, версии, срок годности ──────────────────────────────────────────────────────────────────────────────

const TAX_TEXTS = { tax_rule_id: 'trl_new', new_reserve_id: 'res_new', name: 'Налог клиента', rate: '22', stream_id: 'S-HOURLY', tag: '', valid_from: '2026-11-01', rounding: 'half_even', reserve_id: 'RES-TAX', ttl_days: '' };

test('REQ-064 REQ-065 REQ-108: форма налогового правила — ставка вводится пользователем, предпросмотр «что будет с конвертом»; смена ставки ДОБАВЛЯЕТ версию с датой начала, прошлая версия цела', () => {
  const t = { ...TAX_TEXTS, tax_rule_id: 'TR-20', name: G.tax_rules[0].name };
  const built = TAX.build_tax_edits(G, t, ENV);
  assert.equal(built.ok, true, JSON.stringify(built.error));
  assert.equal(built.rule.rate_bp, 2200);
  assert.equal(built.edits.length, 1, 'резерв уже есть: создавать нечего');
  const model = model_of(G);
  const pv = TAX.envelope_preview(model, built.rule);
  assert.deepEqual(pv.rows[0], { date: '2026-11-05', income_minor: 279000, now_minor: 55800, next_minor: 61380 });
  const later = TAX.envelope_preview(model, { ...built.rule, valid_from: '2026-12-01' });
  assert.equal(later.rows[0].next_minor, 55800, 'до даты начала действует прежняя версия');
  const ws2 = must(apply(G, built.edits[0]));
  const versions = ws2.tax_rules.flat().filter((r) => r.tax_rule_id === 'TR-20');
  assert.deepEqual(versions.map((r) => [r.version, r.rate_bp, r.valid_from]), [[1, 2000, '2026-01-01'], [2, 2200, '2026-11-01']]);
  assert.deepEqual(versions[0], G.tax_rules[0], 'прошлая версия не изменена');
  assert.equal(E.rule_at(ws2.tax_rules.flat(), 'TR-20', '2026-10-31').rate_bp, 2000);
  assert.equal(E.rule_at(ws2.tax_rules.flat(), 'TR-20', '2026-11-05').rate_bp, 2200);
});

test('REQ-064 REQ-068: правило без налогового резерва создаёт его одной цепочкой; ставок по умолчанию нет — пустая ставка отвергается; сумма ставок > 100 % и пустое applies_to — отказ с кодом', () => {
  const t = { ...TAX_TEXTS, reserve_id: '', valid_from: '2026-10-04' };
  const built = TAX.build_tax_edits(G, t, ENV);
  assert.equal(built.ok, true);
  assert.deepEqual(built.edits.map((e) => e.type), ['upsert_reserve', 'upsert_tax_rule']);
  const ws2 = apply_all(G, built.edits);
  assert.ok(ws2.reserves.some((r) => r.reserve_id === 'res_new' && r.kind === 'tax' && r.backed_by_account_id === null));
  assert.equal(E.analyze(ws2, { as_of: ws2.as_of }).rule_status.trl_new, 'fresh');
  for (const [over, typed, code] of [[{ rate: '' }, '', 'E_NOT_INTEGER'], [{ rate: '101' }, '101', 'E_SCHEMA'], [{ rate: 'abc' }, 'abc', 'E_NOT_INTEGER'], [{ stream_id: '', tag: '' }, '', 'E_SCHEMA'],
    [{ stream_id: 'нет' }, 'нет', 'E_SCHEMA'], [{ valid_from: '2026-02-30' }, '2026-02-30', 'E_BAD_DATE'], [{ rounding: 'вверх' }, 'вверх', 'E_SCHEMA'], [{ ttl_days: '0' }, '0', 'E_SCHEMA'], [{ reserve_id: 'RES-INS' }, 'RES-INS', 'E_SCHEMA']]) {
    const r = TAX.build_tax_edits(G, { ...t, ...over }, ENV);
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.equal(r.error.code, code, JSON.stringify(over));
    if (typed.length > 1) no_echo(r, typed);
  }
  const heavy = TAX.build_tax_edits(G, { ...TAX_TEXTS, rate: '90', reserve_id: 'RES-TAX' }, ENV);
  assert.equal(apply(G, heavy.edits[0]).error.code, 'E_RULE_INVALID', '20 % + 90 % на один поток — больше 100 %');
});

function apply_all(ws, edits) {
  let cur = ws;
  for (const e of edits) cur = must(apply(cur, e));
  return cur;
}

const WITH_TTL = (reviewed_at, ttl_days) => ({ ...G, tax_rules: [{ ...G.tax_rules[0], reviewed_at, ttl_days }] });

test('REQ-067 срок годности: свежее → давно не проверялось → не подтверждено; при disabled числа конверта в модели заменены null, расчёт free продолжается; без отметки — «проверка не отмечена»', () => {
  const stale = TAX.tax_state_model(model_of(WITH_TTL('2026-06-01', 120)));
  assert.deepEqual([stale[0].status, stale[0].age_days, stale[0].hidden], ['stale', 125, false]);
  assert.equal(stale[0].now_minor, 150000);
  const off_ws = WITH_TTL('2026-01-01', 60);
  const off = TAX.tax_state_model(model_of(off_ws));
  assert.deepEqual([off[0].status, off[0].hidden, off[0].reviewed_at, off[0].now_minor, off[0].end_minor], ['disabled', true, '2026-01-01', null, null]);
  assert.equal(E.analyze(off_ws, { as_of: off_ws.as_of }).series.plan.reserve_opening_minor, 150000, 'расчёт продолжается, резерв остаётся (C-024)');
  const fresh = TAX.tax_state_model(model_of(WITH_TTL('2026-10-04', 120)));
  assert.equal(fresh[0].status, 'fresh');
  const unmarked = TAX.tax_state_model(model_of(G));
  assert.deepEqual([unmarked[0].status, unmarked[0].marked, unmarked[0].reviewed_at], ['fresh', false, null]);
  // сводка «Налоги и часы»: при disabled аллокации нет, статус виден
  const env = TAX.income_envelope_model(model_of(off_ws));
  assert.deepEqual([env[0].envelope[0].hidden, env[0].envelope[0].alloc], [true, null]);
});

test('REQ-067 «подтвердить правило»: добавляется версия с reviewed_at = сегодня, тем же ttl и датой начала = сегодня; статус становится fresh; прошлые версии и записанные аллокации не меняются; без ttl подтверждать нечего', () => {
  const ws = { ...WITH_TTL('2026-06-01', 120), allocations: [{ allocation_id: 'tax:TR-20@x', reserve_id: 'RES-TAX', date: '2026-09-01', amount_minor: 100, source: 'income', rule_version: 1 }] };
  const c = TAX.confirm_edit(ws, 'TR-20', ws.as_of);
  assert.equal(c.ok, true, JSON.stringify(c.error));
  assert.equal(c.edit.tax_rule.reviewed_at, '2026-10-04');
  assert.equal(c.edit.tax_rule.ttl_days, 120);
  assert.equal(c.edit.tax_rule.version, undefined, 'номер версии назначает правка');
  const ws2 = must(apply(ws, c.edit));
  const versions = ws2.tax_rules.flat();
  assert.deepEqual(versions.map((r) => [r.version, r.reviewed_at]), [[1, '2026-06-01'], [2, '2026-10-04']]);
  assert.equal(E.analyze(ws2, { as_of: ws2.as_of }).rule_status['TR-20'], 'fresh');
  assert.deepEqual(ws2.allocations, ws.allocations, 'записанные аллокации не меняются');
  assert.deepEqual(versions[0], ws.tax_rules[0]);
  assert.equal(E.rule_at(versions, 'TR-20', '2026-09-01').version, 1, 'для прошлых дат действует прежняя версия');
  assert.equal(TAX.confirm_edit(G, 'TR-20', G.as_of).error.ctx.field, 'ttl_days');
  assert.equal(TAX.confirm_edit(G, 'нет', G.as_of).error.ctx.reason, 'unknown_rule');
  const dead = TAX.tax_state_model(model_of({ ...ws, tax_rules: [{ ...ws.tax_rules[0], reviewed_at: '2026-01-01', ttl_days: 60 }] }));
  assert.equal(dead[0].hidden, true);
  const ws3 = must(apply({ ...ws, tax_rules: [{ ...ws.tax_rules[0], reviewed_at: '2026-01-01', ttl_days: 60 }] }, TAX.confirm_edit({ ...ws, tax_rules: [{ ...ws.tax_rules[0], reviewed_at: '2026-01-01', ttl_days: 60 }] }, 'TR-20', ws.as_of).edit));
  assert.equal(TAX.tax_state_model(model_of(ws3))[0].status, 'fresh', 'после подтверждения правило снова даёт числа');
});

// ── накопления ──────────────────────────────────────────────────────────────────────────────────────────────────────

const SINK_TEXTS = { reserve_id: 'res_vac', name: 'Отпуск', mode: 'refill_to_target', target: '1800', due_date: '2027-07-01', cadence_day: '1', fixed: '', funded: '95' };

test('REQ-069 REQ-070 REQ-071: форма цели собирает резерв sinking; план, «N взносов на сумму X», «цель достигнута» и «до срока нет дат взноса» — из модели; отказы — коды без повтора текста', () => {
  const built = SINK.build_sinking_edit(G, SINK_TEXTS, ENV);
  assert.equal(built.ok, true, JSON.stringify(built.error));
  assert.deepEqual([built.edit.reserve.target_minor, built.edit.reserve.funded_start_minor, built.edit.reserve.funded_as_of], [180000, 9500, '2026-10-04']);
  const ws2 = must(apply(G, built.edit));
  const items = SINK.sinking_model(model_of(ws2));
  const vac = items.find((x) => x.reserve.reserve_id === 'res_vac');
  assert.deepEqual([vac.plan.n, vac.plan.total_minor, vac.plan.status], [8, 170500, 'ok']);
  assert.equal(SINK.contributions_text({ lang: () => 'ru', tr: (k, p) => k + JSON.stringify(p) }, 8), 'forms.contrib_n_many{"n":8}');
  const fixed = SINK.build_sinking_edit(G, { ...SINK_TEXTS, mode: 'fixed', fixed: '150', target: '' }, ENV);
  assert.equal(fixed.edit.reserve.target_minor, undefined, 'у fixed цель необязательна');
  const fx_ws = must(apply(G, fixed.edit));
  const p = SINK.sinking_model(model_of(fx_ws)).find((x) => x.reserve.reserve_id === 'res_vac').plan;
  assert.equal(p.mode, 'fixed');
  for (const [over, typed, code] of [[{ target: '' }, '', 'E_SCHEMA'], [{ due_date: '' }, '', 'E_BAD_DATE'], [{ target: 'x9' }, 'x9', 'E_NOT_INTEGER'], [{ cadence_day: '32' }, '32', 'E_SCHEMA'],
    [{ mode: 'weekly' }, 'weekly', 'E_SCHEMA'], [{ mode: 'fixed', fixed: '' }, '', 'E_NOT_INTEGER'], [{ name: '' }, '', 'E_SCHEMA'], [{ funded: 'мало' }, 'мало', 'E_NOT_INTEGER']]) {
    const r = SINK.build_sinking_edit(G, { ...SINK_TEXTS, ...over }, ENV);
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.equal(r.error.code, code, JSON.stringify(over));
    if (typed !== '') no_echo(r, typed);
  }
  // существующая цель: накопленное не перезаписывается формой
  const edit_old = SINK.build_sinking_edit(G, { ...SINK_TEXTS, reserve_id: 'RES-INS', name: 'Страховка', target: '600', due_date: '2027-03-15', funded: '999' }, ENV);
  assert.equal(edit_old.edit.reserve.funded_start_minor, 0, 'funded_start_minor существующего резерва сохраняется');
});

test('REQ-071 TST-22: цель достигнута и «до срока нет дат взноса» — в модели карточки; цель 600 при накоплено 600 → статус reached; срок 2026-10-20 → no_dates, недостача 600,00', () => {
  const reached = must(apply(G, SINK.build_sinking_edit(G, { ...SINK_TEXTS, reserve_id: 'res_ok', name: 'Готово', target: '600', due_date: '2027-03-15', funded: '600' }, ENV).edit));
  assert.equal(SINK.sinking_model(model_of(reached)).find((x) => x.reserve.reserve_id === 'res_ok').plan.status, 'reached');
  const late = must(apply(G, SINK.build_sinking_edit(G, { ...SINK_TEXTS, reserve_id: 'res_late', name: 'Поздно', target: '600', due_date: '2026-10-20', funded: '' }, ENV).edit));
  const p = SINK.sinking_model(model_of(late)).find((x) => x.reserve.reserve_id === 'res_late').plan;
  assert.deepEqual([p.status, p.n, p.shortfall_minor, p.rows.length], ['no_dates', 0, 60000, 0]);
});

test('REQ-069 пакетное «подтвердить за период»: вид правки confirm_contributions пишет все неподтверждённые взносы; W_RESERVE_BEHIND уходит; повтор — отказ «нечего подтверждать»; upto ограничивает период', () => {
  const ws = { ...G, as_of: '2026-12-05' };
  assert.equal(reserve_behind_detail(ws)[0].missed_count, 2);
  const part = must(apply(ws, { type: 'confirm_contributions', reserve_id: 'RES-INS', upto: '2026-11-15' }));
  assert.deepEqual(part.allocations.map((a) => a.date), ['2026-11-01']);
  const all = must(apply(ws, { type: 'confirm_contributions', reserve_id: 'RES-INS' }));
  assert.deepEqual(all.allocations.map((a) => [a.allocation_id, a.amount_minor, a.source]), [['sch:RES-INS@2026-11-01', 12000, 'schedule'], ['sch:RES-INS@2026-12-01', 12000, 'schedule']]);
  assert.ok(!E.analyze(all, { as_of: ws.as_of }).warnings.some((w) => w.code === 'W_RESERVE_BEHIND'));
  assert.equal(apply(all, { type: 'confirm_contributions', reserve_id: 'RES-INS' }).error.ctx.reason, 'nothing_to_confirm');
  assert.equal(apply(ws, { type: 'confirm_contributions', reserve_id: 'RES-INS', upto: '2026-02-30' }).error.code, 'E_BAD_DATE');
  assert.equal(apply(ws, { type: 'confirm_contributions' }).error.ctx.field, 'reserve_id');
  assert.equal(apply(ws, { type: 'confirm_contributions', reserve_id: 'RES-INS', x: 1 }).error.ctx.reason, 'unknown_field');
  const future = must(apply({ ...ws, as_of: '2026-11-02' }, { type: 'confirm_contributions', reserve_id: 'RES-INS' }));
  assert.equal(future.allocations.length, 1, 'до as_of — только взнос 1 ноября');
});

// ── курсы и обмен ───────────────────────────────────────────────────────────────────────────────────────────────────

const USD_ACC = { account_id: 'acc_usd', name: 'Счёт в долларах', kind: 'bank', liquidity: 'operating', currency: 'USD', exponent: 2, liquidity_bp: 0, opened_on: '2026-01-01' };
const RATE_OCT = { fx_id: 'fx-oct', date: '2026-10-04', base: 'USD', quote: 'EUR', num: 9250, den: 10000, source: 'manual' };

test('REQ-077 REQ-079: курс вводится вручную («0,9250» → 9250/10000 как введён), дата не позже расчёта; сумма 185000 подписана «курс 0,9250 от 2026-10-04»; курс от 2026-08-20 (45 дн.) — устарел по fx.stale_days из параметров', () => {
  const built = FX.build_rate_edit(G, { base: ' usd ', quote: 'eur', rate: '0,9250', date: '', fx_id: 'fx_1' }, ENV);
  assert.equal(built.ok, true, JSON.stringify(built.error));
  assert.deepEqual(built.edit.rate, { date: '2026-10-04', base: 'USD', quote: 'EUR', num: 9250, den: 10000, source: 'manual', fx_id: 'fx_1' });
  const ws = must(apply(G, built.edit));
  const c = FX.convert_with_signature(ws, 200000, 'USD', 'EUR');
  assert.equal(c.amount_minor, 185000);
  assert.deepEqual(c.rate, { num: 9250, den: 10000, date: '2026-10-04', inverse: false });
  assert.deepEqual([c.age, c.stale], [0, false]);
  assert.equal(FORMS.rate_text(c.rate.num, c.rate.den, ENV), '0,9250');
  const inv = FX.convert_with_signature(ws, 185000, 'EUR', 'USD');
  assert.equal(inv.rate.inverse, true, 'обратная пара — подпись «обратный»');
  assert.equal(FX.convert_with_signature(G, 100, 'USD', 'EUR').error.code, 'E_NO_RATE');
  const old = must(apply(G, { type: 'upsert_fx_rate', rate: { ...RATE_OCT, date: '2026-08-20' } }));
  const rows = FX.rate_rows(old);
  assert.deepEqual([rows[0].age, rows[0].stale, rows[0].date], [45, true, '2026-08-20']);
  assert.equal(FX.stale_days_of(old), E.flat_params(old.params)['fx.stale_days']);
  assert.equal(FX.stale_days_of({ ...old, params: { ...old.params, 'fx.stale_days': 60 } }), 60);
  const edge = FX.rate_rows({ ...old, params: { ...old.params, 'fx.stale_days': 45 } })[0];
  assert.equal(edge.stale, false, 'ровно предел — ещё не устарел');
  for (const [over, typed, code] of [[{ rate: 'abc' }, 'abc', 'E_NOT_INTEGER'], [{ rate: '0' }, '0', 'E_SCHEMA'], [{ base: 'EUR' }, 'EUR', 'E_CURRENCY_MISMATCH'], [{ base: 'ZZZ' }, 'ZZZ', 'E_SCHEMA'],
    [{ date: '2026-02-30' }, '2026-02-30', 'E_BAD_DATE'], [{ date: '2026-12-01' }, '2026-12-01', 'E_FUTURE_POSTED'], [{ base: '1' }, '1', 'E_SCHEMA']]) {
    const r = FX.build_rate_edit(G, { base: 'USD', quote: 'EUR', rate: '0,9250', ...over }, ENV);
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.equal(r.error.code, code, JSON.stringify(over));
    if (typed.length > 1) no_echo(r, typed);
  }
});

test('REQ-078 TST-27: обмен 2 000,00 $ → 1 842,40 € — две ноги одного перевода; курс обмена 2303/2500 = 0,9212; справочная разница со spot 0,9250 — 760 (7,60 €); одна валюта — это перевод, а не обмен', () => {
  const ws0 = { ...G, accounts: [...G.accounts, USD_ACC], rates: [RATE_OCT], anchors: [...G.anchors, { anchor_id: 'anc-usd', account_id: 'acc_usd', date: '2026-10-04', amount_minor: 300000 }] };
  const t = { from_account_id: 'acc_usd', to_account_id: 'acc_main', sold: '2000,00', got: '1842,40', date: '', transfer_id: 'trf_x1' };
  const built = FX.build_exchange_edit(ws0, t, ENV);
  assert.equal(built.ok, true, JSON.stringify(built.error));
  assert.deepEqual(built.info.implied, { num: 2303, den: 2500 });
  assert.equal(FORMS.rate_text(2303, 2500, ENV), '0,9212');
  assert.equal(built.info.diff_minor, 760);
  assert.deepEqual([built.info.sold_minor, built.info.got_minor], [200000, 184240]);
  const ws2 = must(apply(ws0, built.edit));
  const legs = ws2.facts.filter((f) => f.transfer_id === 'trf_x1');
  assert.deepEqual(legs.map((l) => [l.account_id, l.amount_minor]), [['acc_usd', -200000], ['acc_main', 184240]]);
  assert.deepEqual(legs[0].fx, { num: 2303, den: 2500 });
  assert.equal(E.analyze(ws2, { as_of: ws2.as_of }).decision_currency, 'EUR', 'расчёт принимает обмен');
  const bads = [[{ sold: '' }, ''], [{ got: 'x' }, 'x'], [{ to_account_id: 'acc_usd' }, ''], [{ to_account_id: 'нет' }, 'нет'], [{ date: '2026-02-30' }, '2026-02-30']];
  for (const [over, typed] of bads) {
    const r = FX.build_exchange_edit(ws0, { ...t, ...over }, ENV);
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.ok(CODES.includes(r.error.code));
    if (typed.length > 1) no_echo(r, typed);
  }
  const same = FX.build_exchange_edit({ ...ws0, accounts: [...ws0.accounts, { ...G.accounts[0], account_id: 'acc_two', name: 'Второй' }] }, { ...t, from_account_id: 'acc_two', to_account_id: 'acc_main' }, ENV);
  assert.equal(same.error.code, 'E_CURRENCY_MISMATCH');
  const no_rate = FX.build_exchange_edit({ ...ws0, rates: [] }, t, ENV);
  assert.equal(no_rate.ok, true, 'курс обмена выводится из ног: введённый курс пары не нужен');
  assert.equal(no_rate.info.diff_minor, null, 'справочной разницы без spot нет');
});

// ── счета и запас ───────────────────────────────────────────────────────────────────────────────────────────────────

const ACC_TEXTS = { account_id: 'acc_new', name: 'Накопительный', kind: 'savings', liquidity: '', currency: 'eur', liquidity_bp: '', balance: '1000' };

test('REQ-018 REQ-080: форма счёта — вид задаёт ликвидность по умолчанию, остаток пишется якорем; запас = Σ savings + Σ asset·bp/10^4 (145000) отдельно от operating; крипта по умолчанию не ликвидна', () => {
  const sav = ACC.build_account_edits(G, ACC_TEXTS, ENV);
  assert.equal(sav.ok, true, JSON.stringify(sav.error));
  assert.deepEqual(sav.edits.map((e) => e.type), ['upsert_account', 'set_anchor']);
  assert.equal(sav.account.liquidity, 'savings');
  assert.equal(sav.account.currency, 'EUR');
  const asset = ACC.build_account_edits(G, { ...ACC_TEXTS, account_id: 'acc_house', name: 'Квартира', kind: 'asset', liquidity_bp: '30', balance: '1500' }, ENV);
  assert.equal(asset.account.liquidity_bp, 3000, '30 % → 3000 bp: доля задана пользователем');
  const ws2 = apply_all(apply_all(G, sav.edits), asset.edits);
  const rep = ACC.liquidity_model(ws2);
  assert.equal(rep.stock_minor, 100000 + 45000);
  assert.equal(rep.operating_minor, 400000);
  assert.deepEqual(Object.keys(rep.groups), ['operating', 'savings', 'asset', 'debt']);
  const btc = ACC.build_account_edits(G, { ...ACC_TEXTS, account_id: 'acc_btc', name: 'BTC', kind: 'crypto', currency: 'BTC', balance: '0,0015' }, ENV);
  assert.equal(btc.ok, true, JSON.stringify(btc.error));
  assert.equal(btc.account.liquidity, 'asset', 'крипта по умолчанию — не operating');
  assert.equal(btc.account.exponent, 8);
  assert.equal(btc.account.liquidity_bp, 0, 'ликвидность крипты по умолчанию 0');
  assert.equal(ACC.build_account_edits(G, { ...ACC_TEXTS, kind: 'crypto', currency: 'BTC', liquidity: 'operating' }, ENV).error.ctx.reason, 'crypto_not_operating');
  assert.deepEqual(ACC.DEFAULT_LIQUIDITY, { cash: 'operating', bank: 'operating', savings: 'savings', asset: 'asset', debt: 'debt', crypto: 'asset' });
  for (const [over, typed, code] of [[{ currency: 'ЕВРО' }, 'ЕВРО', 'E_SCHEMA'], [{ currency: 'XXX' }, 'XXX', 'E_SCHEMA'], [{ balance: 'много' }, 'много', 'E_NOT_INTEGER'], [{ liquidity_bp: '101' }, '101', 'E_SCHEMA'],
    [{ kind: 'вклад' }, 'вклад', 'E_SCHEMA'], [{ liquidity: 'выдуманная' }, 'выдуманная', 'E_SCHEMA'], [{ name: '' }, '', 'E_SCHEMA']]) {
    const r = ACC.build_account_edits(G, { ...ACC_TEXTS, ...over }, ENV);
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.equal(r.error.code, code, JSON.stringify(over));
    if (typed !== '') no_echo(r, typed);
  }
  // операционный счёт в чужой валюте без курса: правка отвергается кодом E_NO_RATE (set_anchor)
  const usd = ACC.build_account_edits(G, { ...ACC_TEXTS, account_id: 'acc_usd2', kind: 'bank', currency: 'USD', name: 'USD' }, ENV);
  assert.equal(FORMS.apply_chain(G, usd.edits, { new_id: ids, as_of: G.as_of }).error.code, 'E_NO_RATE');
});

// ── рассрочка ───────────────────────────────────────────────────────────────────────────────────────────────────────

const INST_TEXTS = { name: 'Беговая дорожка', total: '1200', n: '6', rate: '12', kind: 'annuity', start_date: '2026-11-01', move_k: '', move_date: '', purchase_id: 'pur_x1' };

test('REQ-192 TST-30: форма рассрочки — 1 200,00 € под 12 % на 6 платежей → части [20706 ×5, 20705], Σ 124235; вердикт по частям через check_purchase; части за горизонтом не прячутся', () => {
  const built = INST.build_installment(G, INST_TEXTS, ENV);
  assert.equal(built.ok, true, JSON.stringify(built.error));
  assert.deepEqual(built.parts.map((p) => p.amount_minor), [20706, 20706, 20706, 20706, 20706, 20705]);
  assert.equal(built.plan.total_minor, 124235);
  assert.equal(built.plan.interest_minor, 4235);
  const v = INST.installment_verdict(model_of(G), built.purchase);
  assert.equal(v.ok, true);
  assert.equal(v.result.kind, 'ok');
  assert.equal(v.result.beyond_horizon_minor, 103529);
  assert.deepEqual(v.split, { inside_count: 1, inside_minor: 20706, beyond_count: 5, beyond_minor: 103529 });
  const ws2 = must(apply(G, INST.installment_edit(built)));
  const saved = ws2.purchases.find((p) => p.purchase_id === 'pur_x1');
  assert.equal(saved.parts.length, 6);
  assert.equal(saved.currency, 'EUR');
  assert.equal(E.analyze(ws2, { as_of: ws2.as_of }).decision_currency, 'EUR');
  // без процентов и с переносом платежа
  const zero = INST.build_installment(G, { ...INST_TEXTS, total: '1100', rate: '', move_k: '3', move_date: '2027-01-05' }, ENV);
  assert.deepEqual(zero.parts.map((p) => p.amount_minor), [18334, 18334, 18333, 18333, 18333, 18333]);
  assert.equal(zero.parts[2].date, '2027-01-05');
  assert.equal(zero.plan.interest_minor, 0);
  const diff = INST.build_installment(G, { ...INST_TEXTS, kind: 'differential' }, ENV);
  assert.equal(diff.plan.kind, 'differential');
  for (const [over, typed, code] of [[{ total: 'abc' }, 'abc', 'E_NOT_INTEGER'], [{ total: '0' }, '0', 'E_SCHEMA'], [{ n: '0' }, '0', 'E_SCHEMA'], [{ n: '121' }, '121', 'E_SCHEMA'], [{ rate: 'xx' }, 'xx', 'E_NOT_INTEGER'],
    [{ rate: '1001' }, '1001', 'E_SCHEMA'], [{ start_date: '2026-02-30' }, '2026-02-30', 'E_BAD_DATE'], [{ name: '' }, '', 'E_SCHEMA'], [{ total: '0,05', rate: '12', n: '6' }, '0,05', 'E_SCHEMA'],
    [{ move_k: '9', move_date: '2027-01-05' }, '9', 'E_SCHEMA'], [{ move_k: '2', move_date: '2027-13-05' }, '2027-13-05', 'E_BAD_DATE']]) {
    const r = INST.build_installment(G, { ...INST_TEXTS, ...over }, ENV);
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.equal(r.error.code, code, JSON.stringify(over));
    if (typed.length > 1) no_echo(r, typed);
  }
  assert.equal(INST.RATE_BP_MAX, 100000);
});

// ── общее: запись целиком или ничего, переведённые отказы ────────────────────────────────────────────────────────────

test('REQ-017 apply_chain: цепочка правок принимается целиком или отвергается целиком; commit_edits без рабочей области — E_SCHEMA; отказы пакета называют код канона', () => {
  const ok = FORMS.apply_chain(G, [{ type: 'set_param', key: 'buffer_minor', value: 60000 }, { type: 'set_param', key: 'horizon_days', value: 90 }], { new_id: ids });
  assert.equal(ok.ok, true);
  assert.deepEqual([ok.ws.params.buffer_minor, ok.ws.params.horizon_days], [60000, 90]);
  const bad = FORMS.apply_chain(G, [{ type: 'set_param', key: 'buffer_minor', value: 60000 }, { type: 'set_param', key: 'horizon_days', value: 0 }], { new_id: ids });
  assert.equal(bad.ok, false);
  assert.equal(bad.index, 1);
  assert.equal(G.params.buffer_minor, 50000, 'исходная рабочая область не тронута');
  assert.equal(FORMS.commit_edits({ get_ws: () => null }, [{ type: 'set_param', key: 'buffer_minor', value: 1 }]).error.code, 'E_SCHEMA');
  assert.deepEqual(PACK.EDITS.constructor === Object, true);
  assert.deepEqual(Object.keys(PACK.EDITS).sort(), ['confirm_contributions', 'post_income', 'record_posted_allocations', 'set_occurrence_override', 'set_stream_hours']);
  assert.deepEqual(Object.keys(PACK.SECTIONS), ['rules', 'hours', 'tax', 'sinking', 'fx', 'accounts', 'installment']);
  assert.ok(WE.list_edit_types().includes('post_income'));
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Часть 2. Настоящий app.mjs на заглушке DOM: пакет pack_fp08, экран #forms, карточки на «Резервы», запись общим путём
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

await imp('demo/app.mjs'); // getElementById('app-title') !== null → boot() запускается сам
await new Promise((r) => setTimeout(r, 600)); // boot асинхронный: манифест пакетов, набор данных, boot-хуки

const text_of = (id) => byid.get(id).textContent;
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };
const main = () => byid.get('main');
const by_id = (id) => find_all(main(), (n) => n.attrs.id === id)[0];
const field = (id) => { const f = by_id(id); assert.ok(f !== undefined, 'нет поля ' + id); return f; };
const set = (id, v) => { field(id).value = v; };
const click = (node) => { assert.ok(node !== undefined, 'нет кнопки'); node.listeners.click[0]({}); };
const change = (id) => { for (const fn of field(id).listeners.change ?? []) fn({}); };
const tab = (id) => click(find_all(main(), (n) => n.attrs['data-tab'] === id)[0]);
const submit = (id) => { const f = by_id(id); assert.ok(f !== undefined, 'нет формы ' + id); return f.listeners.submit[0]({ preventDefault() {} }); };
const status_of = (form_id) => find_all(by_id(form_id), (n) => n.attrs.role === 'status' || n.attrs.role === 'alert').map((n) => n.textContent).join(' ');
const reset = (ws) => { const r = ext.ctx.set_ws(ws, { reason: 'test_reset' }); assert.equal(r.ok, true, JSON.stringify(r.error)); };
const cur = () => ext.ctx.get_ws();
const notes = () => ext.diagnostics().filter((d) => d.status === 'notify').map((d) => d.message);

test('boot: манифест подхватил pack_fp08 без сбоев, в навигации — «Формы данных» (#forms); набор G-001 загружен; виды правок пакета зарегистрированы', () => {
  const diag = ext.diagnostics().filter((d) => d.pack === 'pack_fp08');
  assert.deepEqual(diag.map((d) => d.status), ['ok'], JSON.stringify(ext.diagnostics()));
  const links = find_all(byid.get('nav'), (n) => n.tagName === 'a').map((a) => [a.attrs.href, a.textContent]);
  assert.ok(links.some(([href, t]) => href === '#forms' && t === 'Формы данных'), JSON.stringify(links));
  assert.equal(cur().workspace_id, 'ws-g001');
  assert.deepEqual(WE.list_edit_types().filter((t) => Object.keys(PACK.EDITS).includes(t)).sort(), Object.keys(PACK.EDITS).sort());
});

test('REQ-108 REQ-064 «Резервы»: карточка «Налоги и часы» — доход за октябрь 2 790,00 € (диапазон 2 400,00–3 300,00 €), выплата 5 ноября; в конверт по правилу 20 % — 558,00 €; оговорка «не консультация»', async () => {
  reset(clone(G));
  await go('#reserves');
  const card = by_id('fp08-taxhours');
  assert.ok(card !== undefined, 'карточка в слоте reserves.sections');
  const t = card.textContent;
  assert.match(t, /Налоги и часы/);
  assert.match(t, /Доход за октябрь 2\s790,00\s€ \(диапазон 2\s400,00\s€–3\s300,00\s€\), выплата 5 ноября\./);
  assert.match(t, /В конверт по правилу 20\s% — 558,00\s€ \(диапазон 480,00\s€–660,00\s€\)/);
  assert.match(t.toLowerCase(), /расчёт по введённым правилам, не консультация/);
  assert.match(t, /Проверка не отмечена/);
  assert.match(text_of('main'), /Налоговый конверт/, 'штатный блок «Резервы» на месте');
});

test('REQ-067 «Резервы»: правило не подтверждено дольше 2·ttl — числа конверта заменены текстом «не подтверждено с <даты>; числа скрыты до подтверждения или правки»; «Подтвердить» добавляет версию — числа возвращаются', async () => {
  const ws = clone(G);
  ws.tax_rules[0].reviewed_at = '2026-01-01';
  ws.tax_rules[0].ttl_days = 60;
  reset(ws);
  await go('#reserves');
  let t = by_id('fp08-taxhours').textContent;
  assert.match(t, /Правило не подтверждено с 2026-01-01: числа скрыты до подтверждения или правки правила\./);
  assert.match(t, /В конверт по правилу 20\s%: правило не подтверждено с 2026-01-01/);
  assert.ok(!/558,00/.test(t), 'числа конверта в карточке скрыты');
  assert.match(t, /не подтверждено/, 'статус правила виден');
  // экран «Формы данных» → «Налог»: кнопка «Подтвердить правило»
  await go('#forms');
  tab('tax');
  const btn = find_all(main(), (n) => n.attrs['data-act'] === 'confirm')[0];
  assert.equal(btn.attrs.disabled, undefined, 'у правила есть срок годности — подтверждать можно');
  click(btn);
  const versions = cur().tax_rules.flat();
  assert.deepEqual(versions.map((r) => [r.version, r.reviewed_at]), [[1, '2026-01-01'], [2, '2026-10-04']]);
  assert.ok(notes().some((m) => /подтверждено: добавлена версия/.test(m)));
  await go('#reserves');
  t = by_id('fp08-taxhours').textContent;
  assert.match(t, /558,00/, 'после подтверждения числа вернулись');
  assert.ok(!/до подтверждения или правки/.test(t));
});

test('REQ-069 REQ-071 «Резервы»: карточка накоплений — «Предстоит 5 взносов на сумму 600,00 €»; при неподтверждённых — «Взносов не подтверждено: 2 взноса на сумму 240,00 €», «Подтвердить за период» пишет их', async () => {
  reset(clone(G));
  await go('#reserves');
  assert.match(by_id('fp08-card-sink').textContent, /Предстоит 5 взносов на сумму 600,00\s€\./);
  reset({ ...clone(G), as_of: '2026-12-05' });
  await go('#reserves');
  assert.match(by_id('fp08-card-sink').textContent, /Взносов не подтверждено: 2 взноса на сумму 240,00\s€\./);
  click(find_all(by_id('fp08-card-sink'), (n) => n.attrs['data-act'] === 'confirm')[0]);
  assert.deepEqual(cur().allocations.map((a) => a.allocation_id), ['sch:RES-INS@2026-11-01', 'sch:RES-INS@2026-12-01']);
  assert.ok(!/Взносов не подтверждено/.test(by_id('fp08-card-sink').textContent));
  assert.match(by_id('fp08-card-sink').textContent, /Предстоит 3 взноса на сумму 360,00\s€\./);
  assert.ok(cur().allocations.every((a) => a.source === 'schedule'));
});

test('REQ-018 «Резервы»: карточка «Запас и счета» — деньги на счетах и запас отдельными строками; запас 0,00 € у G-001', async () => {
  reset(clone(G));
  await go('#reserves');
  const t = by_id('fp08-liq').textContent;
  assert.match(t, /Деньги на операционных счетах \(в прогнозе\): 4\s000,00\s€/);
  assert.match(t, /Запас вне прогноза: 0,00\s€/);
  assert.match(t, /Резервы \(налоговый конверт и накопления\): 1\s500,00\s€/);
  assert.match(t, /Запас не входит в «можно потратить»/);
});

test('REQ-075 «Резервы»: карточка «Недоработка по часам» — 2026-10-20, факт 52 ч при плане 60 ч → «Недоработка 8 ч … 240,00 €»; без факта — число не выдумывается', async () => {
  const ws = { ...clone(G), as_of: '2026-10-20' };
  reset(ws);
  await go('#reserves');
  assert.match(by_id('fp08-shortfall').textContent, /Факт часов за период не введён; по плану к сегодняшнему дню — 60 ч\./);
  ws.streams[0].hours_by_period['2026-10-01'] = { actual_minutes: 3120 };
  reset(ws);
  await go('#reserves');
  const t = by_id('fp08-shortfall').textContent;
  assert.match(t, /Недоработка 8 ч: по плану к сегодняшнему дню 60 ч, отработано 52 ч; это 240,00\s€ дохода\./);
  assert.match(t, /Оценка дохода за период с учётом факта: 2\s550,00\s€ \(85 ч\)\./);
});

test('«Данные»: карточка-ссылка «Формы данных» ведёт на #forms', async () => {
  reset(clone(G));
  await go('#data');
  const link = find_all(by_id('fp08-data-link'), (n) => n.tagName === 'a')[0];
  assert.equal(link.attrs.href, '#forms');
  assert.match(by_id('fp08-data-link').textContent, /Формы данных/);
});

test('REQ-032 экран #forms, «Платежи»: список правил с ближайшими датами; «Пропустить» пишет override skip общим путём (журнал override.set), вхождение уходит из ряда; «Вернуть» возвращает', async () => {
  reset(clone(G));
  await go('#forms');
  tab('rules');
  assert.match(text_of('main'), /^Формы данных/);
  assert.equal(find_all(main(), (n) => n.attrs['data-tab'] !== undefined).length, 7, 'семь разделов');
  assert.match(by_id('fp08-sec-rules').textContent, /Регулярные платежи и поступления/);
  const rent = find_all(main(), (n) => n.attrs['data-rule'] === 'R-RENT')[0];
  assert.match(rent.textContent, /Аренда · −900,00\s€ · раз в месяц/);
  assert.match(rent.textContent, /26 октября: −900,00\s€/, 'эффективная дата — понедельник');
  const hash0 = ext.ctx.get_model().ctx.inputs_hash;
  const n0 = ext.ctx.journal.length;
  const skip = find_all(rent, (n) => n.attrs['data-act'] === 'skip' && n.attrs['data-nominal'] === '2026-10-25')[0];
  assert.match(skip.attrs['aria-label'], /Пропустить вхождение «Аренда» 26 октября/);
  click(skip);
  assert.deepEqual(cur().overrides, [{ rule_id: 'R-RENT', nominal_date: '2026-10-25', action: 'skip' }]);
  assert.notEqual(ext.ctx.get_model().ctx.inputs_hash, hash0, 'пересчёт страницей');
  assert.ok(!ext.ctx.get_model().ctx.events.plan.some((e) => e.cash_event_id === 'R-RENT@2026-10-25'));
  assert.equal(ext.ctx.journal.length, n0 + 1);
  assert.equal(ext.ctx.journal.at(n0).type, 'override.set');
  assert.match(text_of('main'), /Пропущено: 25 октября/);
  assert.ok(notes().some((m) => /пропущено: оно уходит из прогноза/.test(m)));
  const restore = find_all(main(), (n) => n.attrs['data-act'] === 'restore')[0];
  click(restore);
  assert.deepEqual(cur().overrides, []);
  assert.equal(ext.ctx.get_model().ctx.inputs_hash, hash0);
});

test('REQ-032 форма правила в приложении: предпросмотр ближайших дат до записи; невалидная сумма — код E_NOT_INTEGER в форме без повтора введённого, данные не меняются; верный ввод — правило записано', async () => {
  reset(clone(G));
  await go('#forms');
  tab('rules');
  set('fp08-rule-name', 'Подписка');
  set('fp08-rule-amount', 'abc');
  set('fp08-rule-start_date', '2026-10-10');
  const rules0 = cur().rules.length;
  const hash0 = ext.ctx.get_model().ctx.inputs_hash;
  submit('fp08-rule');
  assert.match(status_of('fp08-rule'), /Не принято \(E_NOT_INTEGER\) «Сумма»/);
  assert.ok(!text_of('main').includes('abc'), 'введённый текст не повторяется');
  assert.equal(cur().rules.length, rules0);
  assert.equal(ext.ctx.get_model().ctx.inputs_hash, hash0);
  set('fp08-rule-amount', '15');
  field('fp08-rule-amount').listeners.input[0]();
  assert.match(by_id('fp08-rule-preview').textContent, /10 октября: −15,00\s€/);
  assert.match(by_id('fp08-rule-preview').textContent, /10 ноября: −15,00\s€/);
  submit('fp08-rule');
  assert.equal(cur().rules.length, rules0 + 1);
  const added = cur().rules.at(-1);
  assert.deepEqual([added.name, added.amount.exp_minor, added.start_date, added.freq], ['Подписка', -1500, '2026-10-10', 'M']);
  assert.match(added.rule_id, /^rule_[0-9a-f]{12}$/, 'идентификатор создаёт приложение');
  assert.ok(notes().some((m) => /Правило «Подписка» записано\./.test(m)));
  assert.match(text_of('main'), /Подписка · −15,00\s€ · раз в месяц/);
});

test('REQ-075 «Часы»: диапазон часов 80 / 93 / 110 и дохода 2 400,00 / 2 790,00 / 3 300,00 €; форма потока показывает диапазон до записи; «отработано N часов» пишет факт', async () => {
  reset({ ...clone(G), as_of: '2026-10-20' });
  await go('#forms');
  tab('hours');
  const t = by_id('fp08-sec-hours').textContent;
  assert.match(t, /Почасовая работа · ставка 30,00\s€ в час/);
  assert.match(t, /Часы за период: 80 ч \/ 93 ч \/ 110 ч → доход 2\s400,00\s€ \/ 2\s790,00\s€ \/ 3\s300,00\s€\./);
  assert.match(t, /Ближайшая выплата 5 ноября: 2\s790,00\s€\./);
  set('fp08-stream-name', 'Клиент Б');
  set('fp08-stream-rate', '30');
  set('fp08-stream-pay_lag_days', '5');
  set('fp08-stream-min_hours', '80');
  set('fp08-stream-exp_hours', '93');
  set('fp08-stream-max_hours', '110');
  field('fp08-stream-rate').listeners.input[0]();
  assert.match(by_id('fp08-stream-range').textContent, /Доход за период: 2\s400,00\s€ \/ 2\s790,00\s€ \/ 3\s300,00\s€\./);
  set('fp08-actual-hours', '52');
  submit('fp08-actual');
  assert.equal(cur().streams[0].hours_by_period['2026-10-01'].actual_minutes, 3120);
  assert.match(text_of('main'), /Часы за период/);
  await go('#reserves');
  assert.match(by_id('fp08-shortfall').textContent, /Недоработка 8 ч/);
  // отказ: не число
  await go('#forms');
  tab('hours');
  set('fp08-actual-hours', 'много');
  submit('fp08-actual');
  assert.match(status_of('fp08-actual'), /E_NOT_INTEGER/);
  assert.ok(!text_of('main').includes('много'));
  assert.equal(cur().streams[0].hours_by_period['2026-10-01'].actual_minutes, 3120, 'данные не изменились');
});

test('TST-23 TST-24 REQ-064 «Часы» → «Выплата получена»: будущая дата — E_FUTURE_POSTED без записи; выплата 2 790,00 € на 2026-11-05 пишет факт и запись в конверт 558,00 € (журнал: tx.posted, allocation.recorded)', async () => {
  reset({ ...clone(G), as_of: '2026-11-06' });
  await go('#forms');
  tab('hours');
  set('fp08-payout-date', '2026-11-07');
  set('fp08-payout-amount', '2790');
  const facts0 = cur().facts.length;
  submit('fp08-payout');
  assert.match(status_of('fp08-payout'), /E_FUTURE_POSTED/);
  assert.equal(cur().facts.length, facts0);
  assert.equal(cur().allocations.length, 0);
  set('fp08-payout-date', '2026-11-05');
  const n0 = ext.ctx.journal.length;
  submit('fp08-payout');
  assert.equal(cur().facts.length, facts0 + 1);
  const a = cur().allocations;
  assert.equal(a.length, 1);
  assert.deepEqual([a[0].amount_minor, a[0].date, a[0].source, a[0].rule_version], [55800, '2026-11-05', 'income', 1]);
  const types = Array.from({ length: ext.ctx.journal.length - n0 }, (_, i) => ext.ctx.journal.at(n0 + i).type).sort();
  assert.deepEqual(types, ['allocation.recorded', 'tx.posted']);
  assert.ok(notes().some((m) => /Выплата «Почасовая работа»/.test(m)));
  await go('#reserves');
  assert.ok(by_id('fp08-pending') === undefined, 'записывать в конверт нечего');
});

test('REQ-064 «Резервы»: проведённый факт без записи — карточка «Проведено, но в конверт не записано» и кнопка пишет запись по правилу на дату факта; повтор безвреден', async () => {
  const ws = { ...clone(G), as_of: '2026-11-06' };
  ws.facts.push({ event_id: 'tx-in-1', account_id: 'acc_main', date: '2026-11-05', amount_minor: 279000, currency: 'EUR', kind: 'income', stream_id: 'S-HOURLY' });
  reset(ws);
  await go('#reserves');
  const card = by_id('fp08-pending');
  assert.ok(card !== undefined);
  assert.match(card.textContent, /Доход 558,00\s€ от 5 ноября: в конверт\./);
  click(find_all(card, (n) => n.tagName === 'button')[0]);
  assert.deepEqual(cur().allocations.map((x) => [x.allocation_id, x.amount_minor]), [['tax:TR-20@tx-in-1', 55800]]);
  assert.ok(by_id('fp08-pending') === undefined);
});

test('REQ-064 REQ-065 «Налог»: форма правила с предпросмотром «что будет с конвертом»; запись добавляет версию 2 с датой начала; прошлая версия цела; пустая ставка — E_NOT_INTEGER без повтора', async () => {
  reset(clone(G));
  await go('#forms');
  tab('tax');
  set('fp08-tax-tax_rule_id', 'TR-20');
  change('fp08-tax-tax_rule_id');
  assert.equal(field('fp08-tax-rate').value, '20');
  set('fp08-tax-rate', '22');
  set('fp08-tax-valid_from', '2026-11-01');
  field('fp08-tax-rate').listeners.input[0]();
  assert.match(by_id('fp08-tax-preview').textContent, /5 ноября: поступление 2\s790,00\s€ → в конверт сейчас 558,00\s€, по правилу 613,80\s€/);
  assert.match(by_id('fp08-tax-preview').textContent.toLowerCase(), /расчёт по введённым правилам, не консультация/);
  set('fp08-tax-rate', '');
  submit('fp08-tax');
  assert.match(status_of('fp08-tax'), /E_NOT_INTEGER/);
  assert.equal(cur().tax_rules.flat().length, 1);
  set('fp08-tax-rate', '22');
  submit('fp08-tax');
  const v = cur().tax_rules.flat();
  assert.deepEqual(v.map((r) => [r.version, r.rate_bp, r.valid_from]), [[1, 2000, '2026-01-01'], [2, 2200, '2026-11-01']]);
  assert.deepEqual(v[0], G.tax_rules[0]);
});

test('REQ-069 REQ-070 «Накопления»: форма цели — предпросмотр плана («Предстоит 8 взносов на сумму 1 705,00 €»); запись создаёт резерв sinking; пул 375,00 € делится между целями', async () => {
  reset(clone(G));
  await go('#forms');
  tab('sinking');
  set('fp08-sink-name', 'Отпуск');
  set('fp08-sink-target', '1800');
  set('fp08-sink-due_date', '2027-07-01');
  set('fp08-sink-funded', '95');
  field('fp08-sink-name').listeners.input[0]();
  assert.match(by_id('fp08-sink-preview').textContent, /Предстоит 8 взносов на сумму 1\s705,00\s€\./);
  submit('fp08-sink');
  const r = cur().reserves.find((x) => x.name === 'Отпуск');
  assert.deepEqual([r.kind, r.mode, r.target_minor, r.funded_start_minor, r.backed_by_account_id], ['sinking', 'refill_to_target', 180000, 9500, null]);
  assert.match(r.reserve_id, /^res_[0-9a-f]{12}$/);
  tab('sinking');
  set('fp08-pool-total', '375');
  submit('fp08-pool');
  const out = by_id('fp08-pool-out').textContent;
  assert.match(out, /Годовая страховка|Страховка/);
  assert.match(out, /Σ|доля/);
  const shares = [...out.matchAll(/доля (\d[\d\s]*,\d\d)/g)].map((m) => m[1].replace(/\s/g, ''));
  assert.equal(shares.length, 2);
  assert.equal(shares.reduce((s, x) => s + Number(x.replace(',', '')), 0), 37500, 'Σ долей = общему взносу');
  set('fp08-sink-name', 'Ещё цель');
  set('fp08-sink-target', 'много');
  submit('fp08-sink');
  assert.match(status_of('fp08-sink'), /E_NOT_INTEGER/);
});

test('REQ-077 REQ-079 «Курсы»: курс от 2026-08-20 — плашка «Курс не обновлялся 45 дн.»; свежий курс 0,9250 — сумма 2 000,00 $ → 1 850,00 € с подписью «курс 0,9250 от 2026-10-04»; курс вводится как введён', async () => {
  const ws = clone(G);
  ws.rates = [{ fx_id: 'fx-old', date: '2026-08-20', base: 'USD', quote: 'EUR', num: 9250, den: 10000, source: 'manual' }];
  reset(ws);
  await go('#forms');
  tab('fx');
  assert.match(by_id('fp08-sec-fx').textContent, /USD → EUR0,92502026-08-2045 дн\. · Курс не обновлялся 45 дн\./);
  set('fp08-rate-base', 'usd');
  set('fp08-rate-quote', 'EUR');
  set('fp08-rate-rate', '0,9250');
  submit('fp08-rate');
  const added = cur().rates.find((x) => x.date === '2026-10-04');
  assert.deepEqual([added.base, added.quote, added.num, added.den, added.source], ['USD', 'EUR', 9250, 10000, 'manual']);
  assert.match(added.fx_id, /^fx_[0-9a-f]{12}$/);
  assert.ok(!/Курс не обновлялся/.test(by_id('fp08-sec-fx').textContent), 'свежий курс — плашки нет');
  set('fp08-conv-amount', '2000');
  set('fp08-conv-from', 'USD');
  submit('fp08-conv');
  assert.match(by_id('fp08-conv-out').textContent, /2\s000,00\s\$ → 1\s850,00\s€ · курс 0,9250 от 2026-10-04/);
  set('fp08-conv-from', 'ZZZ');
  submit('fp08-conv');
  assert.match(status_of('fp08-conv'), /E_SCHEMA/);
  set('fp08-rate-base', 'USD');
  set('fp08-rate-quote', 'EUR');
  set('fp08-rate-rate', 'abc');
  submit('fp08-rate');
  assert.match(status_of('fp08-rate'), /E_NOT_INTEGER/);
});

test('REQ-078 «Курсы»: обмен 2 000,00 $ → 1 842,40 € — курс обмена 0,9212 (2303/2500), справочная разница 7,60 €; запись — две ноги одного перевода', async () => {
  const ws = clone(G);
  ws.accounts.push({ ...USD_ACC });
  ws.rates = [{ ...RATE_OCT }];
  ws.anchors.push({ anchor_id: 'anc-usd', account_id: 'acc_usd', date: '2026-10-04', amount_minor: 300000 });
  reset(ws);
  await go('#forms');
  tab('fx');
  set('fp08-xchg-from_account_id', 'acc_usd');
  set('fp08-xchg-to_account_id', 'acc_main');
  set('fp08-xchg-sold', '2000,00');
  set('fp08-xchg-got', '1842,40');
  field('fp08-xchg-sold').listeners.input[0]();
  const prev = by_id('fp08-xchg-preview').textContent;
  assert.match(prev, /Курс обмена 0,9212 \(2303\/2500\)\./);
  assert.match(prev, /Справочная разница с курсом на день обмена \(0,9250\): 7,60\s€\./);
  submit('fp08-xchg');
  const legs = cur().facts.filter((f) => f.transfer_id !== undefined);
  assert.equal(legs.length, 2);
  assert.deepEqual(legs.map((l) => [l.account_id, l.amount_minor]), [['acc_usd', -200000], ['acc_main', 184240]]);
  assert.match(legs[0].transfer_id, /^trf_[0-9a-f]{12}$/);
  set('fp08-xchg-sold', '2000,00');
  set('fp08-xchg-got', 'x');
  submit('fp08-xchg');
  assert.match(status_of('fp08-xchg'), /E_NOT_INTEGER/);
});

test('REQ-018 REQ-080 «Счета»: форма счёта (накопительный, остаток якорем) → запас 1 000,00 €; актив 1 500,00 € при доле 30 % → +450,00 €; крипта на operating — отказ; показ отдельно от денег на счетах', async () => {
  reset(clone(G));
  await go('#forms');
  tab('accounts');
  set('fp08-acc-name', 'Накопительный');
  set('fp08-acc-kind', 'savings');
  set('fp08-acc-balance', '1000');
  submit('fp08-acc');
  const sav = cur().accounts.find((a) => a.name === 'Накопительный');
  assert.deepEqual([sav.liquidity, sav.currency, sav.exponent], ['savings', 'EUR', 2]);
  assert.match(sav.account_id, /^acc_[0-9a-f]{12}$/);
  assert.equal(cur().anchors.at(-1).amount_minor, 100000);
  tab('accounts');
  assert.match(by_id('fp08-liq').textContent, /Запас вне прогноза: 1\s000,00\s€/);
  set('fp08-acc-name', 'Квартира');
  set('fp08-acc-kind', 'asset');
  set('fp08-acc-liquidity_bp', '30');
  set('fp08-acc-balance', '1500');
  submit('fp08-acc');
  tab('accounts');
  assert.match(by_id('fp08-liq').textContent, /Запас вне прогноза: 1\s450,00\s€/);
  assert.match(by_id('fp08-liq').textContent, /Деньги на операционных счетах \(в прогнозе\): 4\s000,00\s€/);
  set('fp08-acc-name', 'BTC');
  set('fp08-acc-kind', 'crypto');
  set('fp08-acc-liquidity', 'operating');
  set('fp08-acc-currency', 'BTC');
  set('fp08-acc-balance', '');
  const n0 = cur().accounts.length;
  submit('fp08-acc');
  assert.match(status_of('fp08-acc'), /E_SCHEMA/);
  assert.equal(cur().accounts.length, n0, 'крипта в operating не принимается');
});

test('REQ-192 TST-30 «Рассрочка»: 1 200,00 € под 12 % на 6 платежей — график, итог 1 242,35 €, проценты 42,35 €, вердикт и «Не все платежи учтены»; запись добавляет покупку из шести частей', async () => {
  reset(clone(G));
  await go('#forms');
  tab('installment');
  set('fp08-inst-name', 'Беговая дорожка');
  set('fp08-inst-total', '1200');
  set('fp08-inst-n', '6');
  set('fp08-inst-rate', '12');
  set('fp08-inst-start_date', '2026-11-01');
  field('fp08-inst-total').listeners.input[0]();
  const prev = by_id('fp08-inst-preview').textContent;
  assert.match(prev, /Платежей: 6 платежей, сумма 1\s242,35\s€, из них проценты 42,35\s€\./);
  assert.match(prev, /Вердикт: (выдерживает|хрупко|впритык|не хватает);/);
  assert.match(prev, /Не все платежи учтены: 1\s035,29\s€ за горизонтом \(5 платежей\)\./);
  assert.match(prev, /207,06\s€/);
  assert.match(prev.toLowerCase(), /не консультация/);
  submit('fp08-inst');
  const p = cur().purchases.at(-1);
  assert.equal(p.name, 'Беговая дорожка');
  assert.deepEqual(p.parts.map((x) => x.amount_minor), [20706, 20706, 20706, 20706, 20706, 20705]);
  assert.match(p.purchase_id, /^pur_[0-9a-f]{12}$/);
  tab('installment');
  set('fp08-inst-name', 'Другая покупка');
  set('fp08-inst-total', 'abc');
  submit('fp08-inst');
  assert.match(status_of('fp08-inst'), /E_NOT_INTEGER/);
  assert.ok(!text_of('main').includes('abc'));
});

test('REQ-070 REQ-071 «Резервы»: карточка накоплений — «Цель достигнута», «До срока нет дат взноса: не хватает 600,00 €», режим fixed — накоплено к сроку и недостача 505,00 €, «цель через 12 мес.»', async () => {
  const ws = clone(G);
  const mk = (over) => ({ kind: 'sinking', currency: 'EUR', funded_as_of: '2026-10-04', backed_by_account_id: null, cadence: { freq: 'M', day: 1 }, mode: 'refill_to_target', ...over });
  ws.reserves.push(
    mk({ reserve_id: 'RES-OK', name: 'Готово', funded_start_minor: 60000, target_minor: 60000, due_date: '2027-03-15' }),
    mk({ reserve_id: 'RES-LATE', name: 'Поздно', funded_start_minor: 0, target_minor: 60000, due_date: '2026-10-20' }),
    mk({ reserve_id: 'RES-VAC', name: 'Отпуск', mode: 'fixed', fixed_minor: 15000, funded_start_minor: 9500, target_minor: 180000, due_date: '2027-07-01' }));
  reset(ws);
  await go('#reserves');
  const t = by_id('fp08-card-sink').textContent;
  assert.match(t, /Цель достигнута: взносы не нужны\./);
  assert.match(t, /До срока нет дат взноса: не хватает 600,00\s€\./);
  assert.match(t, /Фиксированный взнос 150,00\s€; к сроку накоплено будет 1\s295,00\s€\./);
  assert.match(t, /Недостача к цели: 505,00\s€\./);
  assert.match(t, /При таком взносе цель достигается через 12 мес\./);
  assert.match(t, /Взнос — отметка денег, а не расход/);
});
