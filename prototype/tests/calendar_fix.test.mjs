// calendar_fix.test.mjs — исправления FP-13 после независимой проверки (волна 3а): регрессионные тесты на найденные дефекты.
//   FIX-1 (medium) форма правила принимает дату из поля type="date" (ISO) при стиле дат «ДД.ММ.ГГГГ» и «ММ/ДД/ГГГГ»; общий разбор даты форм не отвергает ISO ни в одной форме;
//   FIX-2 (low)    календарь, на который ссылается резерв, не удаляется (cal_in_use_reserve), строка «Используют» показывает резервы;
//   FIX-3 (low)    правка вхождения, осиротевшая после смены календаря, видна как «не применяется», её можно убрать, смена календаря об этом говорит;
//   FIX-4 (low)    разовый платёж, введённый с ошибкой в дате (в прошлом), виден в свёрнутом списке «прошедшие» с «Править» и «Удалить»;
//   FIX-5 (low)    предпросмотр календаря показывает введённые праздники отдельным списком, дальний праздник не теряется за выходными.
// Тесты на настоящем app.mjs с заглушкой DOM (как calendar_form.test.mjs); чистые части — без DOM. Браузер, сервер и сеть не используются.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/calendar_fix.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const DEMO = path.join(PROTO, 'demo');
const imp = (rel) => import(pathToFileURL(path.join(PROTO, rel)).href);
const G = JSON.parse(fs.readFileSync(path.join(PROTO, 'data', 'g001.json'), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));

// ── заглушка DOM ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
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
  append(...kids) { for (const k of kids) { this.children.push(k); if (k.nodeType === 1) k.parent = this; } this._text = ''; }
  replaceChildren(...kids) { this.children = []; this._text = ''; this.append(...kids); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() { if (this.parent !== undefined) this.parent.children = this.parent.children.filter((c) => c !== this); }
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
  getElementById: (id) => byid.get(id) ?? find_in(byid.get('main'), id) ?? find_in(byid.get('nav'), id),
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

const { ext } = await import(pathToFileURL(path.join(DEMO, 'ext.mjs')).href);
await import(pathToFileURL(path.join(DEMO, 'app.mjs')).href);
await new Promise((r) => setTimeout(r, 700));

const E = await imp('engine/index.mjs');
const WE = await imp('demo/ws_edit.mjs');
const RULE = await imp('demo/form_rule.mjs');
const CAL = await imp('demo/form_calendar.mjs');
const PLAN = await imp('demo/form_plan.mjs');
const FORMS = await imp('demo/forms.mjs');
const INST = await imp('demo/form_installment.mjs');
const NF = await imp('demo/number_format.mjs');
const I18N = await imp('demo/i18n.mjs');
const CATALOG = (await imp('demo/i18n/calendars.mjs')).default;
const FORMS_CAT = (await imp('demo/i18n/forms.mjs')).default;

const NB = /[  ]/g;
const N = (x) => String(x).replace(NB, ' ');
const main = () => byid.get('main');
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const by_id = (id) => find_all(main(), (n) => n.attrs.id === id)[0];
const nav_button = (prefix) => find_all(byid.get('nav'), (n) => n.tagName === 'button' && N(n.textContent).startsWith(prefix))[0];
const click = (n) => { assert.ok(n !== undefined, 'нет узла'); assert.equal(n.hasAttribute('disabled'), false, 'кнопка недоступна: ' + n.attrs.id); n.listeners.click[0](); };
const type_into = (n, value, event = 'input') => { assert.ok(n !== undefined, 'нет поля'); n.value = value; for (const fn of n.listeners[event] ?? []) fn({ target: n }); };
const submit = (id) => { const f = by_id(id); assert.ok(f !== undefined, 'нет формы ' + id); return f.listeners.submit[0]({ preventDefault() {} }); };
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };
const ctx = ext.ctx;
const reset = async (ws = G) => { const r = ctx.adopt(clone(ws), { source: 'test' }); assert.equal(r.ok, true, JSON.stringify(r.error)); await go('#forms'); };
const notes = () => ext.diagnostics().filter((d) => d.status === 'notify').map((d) => N(d.message));
const rule_item = (rule_id) => find_all(main(), (n) => n.attrs['data-rule'] === rule_id)[0];
const lang_button = (lang) => find_all(byid.get('controls'), (n) => n.attrs.lang === lang)[0];

const apply = (ws, edit) => WE.apply_edit(ws, edit, { new_id: (p) => p + '_t1' });
const must = (r) => { assert.equal(r.ok, true, JSON.stringify(r.error)); return r.ws; };
const RENT = G.rules.find((r) => r.rule_id === 'R-RENT');

/** Тексты формы так, как их заполняет `fill()` экрана правил (дата начала — ISO, как её отдаёт поле type="date"). */
function texts_from(ws, rule, env) {
  const acc = ws.accounts.find((a) => a.account_id === rule.account_id);
  const nf = NF.resolve_number_format(env.lang, env.nf);
  return {
    rule_id: rule.rule_id, name: rule.name, kind: rule.kind,
    amount: NF.format_input_amount(Math.abs(rule.amount?.exp_minor ?? 0), acc.exponent ?? E.currency_exponent(acc.currency), nf, true),
    account_id: rule.account_id, freq: rule.freq, interval: String(rule.interval ?? 1), start_date: rule.start_date,
    monthday: Array.isArray(rule.by_monthday) ? rule.by_monthday.join(', ') : '', workday: Array.isArray(rule.by_workday) ? rule.by_workday.join(', ') : '',
    weekday: Array.isArray(rule.by_weekday) && rule.by_weekday.length === 1 ? String(rule.by_weekday[0]) : '', weekend: rule.weekend ?? 'keep',
    calendar_id: typeof rule.calendar_id === 'string' && ws.calendars.some((c) => c.calendar_id === rule.calendar_id) ? rule.calendar_id : '',
    until_date: rule.until_date ?? '', is_obligation: rule.is_obligation === true, is_estimate: rule.is_estimate === true,
  };
}
const as_text = (iso, style) => { const [y, m, d] = iso.split('-'); return style === 'dmy' ? `${d}.${m}.${y}` : style === 'mdy' ? `${m}/${d}/${y}` : iso; };

// ── FIX-1: даты формы правила при стиле дат dmy / mdy ───────────────────────────────────────────────────────────────────────────────

test('FIX-1 REQ-009 build_rule_edit принимает ISO из поля type="date" при стиле дат «ДД.ММ.ГГГГ» и «ММ/ДД/ГГГГ» (дата начала и окончание), а также даты в формате рабочей области; результат один и тот же', () => {
  for (const [lang, nf, style] of [['ru', { date: 'dmy' }, 'dmy'], ['en', { date: 'mdy' }, 'mdy'], ['ru', { date: 'iso' }, 'iso'], ['ru', undefined, 'iso'], ['en', undefined, 'iso']]) {
    const env = { cur: 'EUR', lang, nf, as_of: G.as_of };
    const iso_form = RULE.build_rule_edit(G, { ...texts_from(G, RENT, env), until_date: '2027-06-25' }, env);
    assert.equal(iso_form.ok, true, `${lang}/${style} ISO: ${JSON.stringify(iso_form.error)}`);
    assert.equal(iso_form.edit.rule.start_date, RENT.start_date);
    assert.equal(iso_form.edit.rule.until_date, '2027-06-25');
    const own_form = RULE.build_rule_edit(G, { ...texts_from(G, RENT, env), start_date: as_text(RENT.start_date, style), until_date: as_text('2027-06-25', style) }, env);
    assert.equal(own_form.ok, true, `${lang}/${style} формат рабочей области: ${JSON.stringify(own_form.error)}`);
    assert.deepEqual(own_form.edit, iso_form.edit, `${lang}/${style}: оба написания дают одну правку`);
  }
});

test('FIX-1 REQ-009 круг «открыть — сохранить без изменений» при стиле дат dmy и mdy даёт те же данные и ту же версию; несуществующая дата в ISO — E_BAD_DATE без повтора введённого', () => {
  for (const [lang, nf] of [['ru', { date: 'dmy' }], ['en', { date: 'mdy' }]]) {
    const env = { cur: 'EUR', lang, nf, as_of: G.as_of };
    for (const rule of G.rules) {
      const built = RULE.build_rule_edit(G, texts_from(G, rule, env), env);
      assert.equal(built.ok, true, `${lang} ${rule.rule_id}: ${JSON.stringify(built.error)}`);
      assert.equal(E.canon(must(apply(G, built.edit))), E.canon(G), `${lang} ${rule.rule_id}: данные и версия прежние`);
    }
    for (const bad of ['2026-02-30', '2026-13-01', '2026-10-4', '2026-10-04T00:00']) {
      const r = RULE.build_rule_edit(G, { ...texts_from(G, RENT, env), start_date: bad }, env);
      assert.equal(r.ok, false, bad);
      assert.deepEqual([r.error.code, r.error.ctx.field], ['E_BAD_DATE', 'start_date'], bad);
      assert.ok(!JSON.stringify(r.error).includes(bad), 'введённое не повторяется: ' + bad);
    }
  }
});

test('FIX-1 общий разбор даты форм: ISO принимается при любом стиле дат (так отдаёт поле type="date"), формат рабочей области по-прежнему работает; мусор и несуществующие даты отвергаются', () => {
  for (const [lang, nf] of [['ru', { date: 'dmy' }], ['en', { date: 'mdy' }], ['ru', { date: 'iso' }], ['ru', undefined]]) {
    const env = { cur: 'EUR', lang, nf };
    assert.equal(FORMS.parse_date_input('2026-10-28', env, 'd').value, '2026-10-28', `${lang}: ISO`);
    assert.equal(FORMS.parse_date_input(' 2026-10-28 ', env, 'd').value, '2026-10-28', `${lang}: ISO с пробелами`);
    assert.equal(FORMS.parse_date_input('', env, 'd', { optional: true }).value, null);
    for (const bad of ['2026-02-30', 'вчера', '28/10', '2026-10-28 10:00']) assert.equal(FORMS.parse_date_input(bad, env, 'd').error.code, 'E_BAD_DATE', `${lang}: ${bad}`);
    assert.equal(FORMS.parse_date_input('', env, 'd').error.code, 'E_BAD_DATE');
  }
  assert.equal(FORMS.parse_date_input('28.10.2026', { cur: 'EUR', lang: 'ru', nf: { date: 'dmy' } }, 'd').value, '2026-10-28');
  assert.equal(FORMS.parse_date_input('10/28/2026', { cur: 'EUR', lang: 'en', nf: { date: 'mdy' } }, 'd').value, '2026-10-28');
  // другая форма с полем type="date" (рассрочка): дата начала из поля читается при стиле dmy
  const env = { cur: 'EUR', lang: 'ru', nf: { date: 'dmy' }, as_of: G.as_of };
  const inst = INST.build_installment(G, { name: 'Проба', total: '1200', n: '12', rate: '', start_date: '2026-11-01' }, env);
  assert.equal(inst.ok, true, JSON.stringify(inst.error));
});

test('FIX-1 в приложении при стиле дат «ДД.ММ.ГГГГ» кнопка «Записать» формы правила создаёт правило и сохраняет существующее без изменений данных и версии', async () => {
  const ws = clone(G);
  ws.number_format = { date: 'dmy' };
  await reset(ws);
  type_into(by_id('fp08-rule-name'), 'Проба дат');
  type_into(by_id('fp08-rule-amount'), '10');
  type_into(by_id('fp08-rule-start_date'), '2026-11-01');
  const n0 = ctx.get_ws().rules.length;
  submit('fp08-rule');
  const made = ctx.get_ws().rules;
  assert.equal(made.length, n0 + 1, N(by_id('fp08-rule-name-err')?.textContent ?? ''));
  assert.equal(made.at(-1).start_date, '2026-11-01');
  await go('#forms');
  const edit = find_all(rule_item(RENT.rule_id), (n) => n.attrs['data-act'] === 'edit')[0];
  click(edit);
  const before = E.canon(ctx.get_ws());
  const j0 = ctx.journal.length;
  submit('fp08-rule');
  assert.equal(E.canon(ctx.get_ws()), before, 'сохранение без изменений не меняет данные и версию');
  assert.equal(ctx.journal.length, j0, 'журнал не растёт');
});

// ── FIX-2: календарь и резервы ──────────────────────────────────────────────────────────────────────────────────────────────────────

function with_reserve_calendar(place) {
  const ws = clone(G);
  ws.calendars.push({ calendar_id: 'cal-x', name: 'Запасной', weekend_dows: [0, 6], holidays: [] });
  const res = ws.reserves.find((r) => r.reserve_id === 'RES-INS');
  if (place === 'calendar_id') res.calendar_id = 'cal-x'; else res.cadence = { ...res.cadence, calendar_id: 'cal-x' };
  return ws;
}

test('FIX-2 REQ-009 delete_calendar: календарь, названный резервом (calendar_id или cadence.calendar_id), не удаляется — cal_in_use_reserve; после снятия ссылки удаляется, расчёт не падает', () => {
  for (const place of ['calendar_id', 'cadence']) {
    const ws = with_reserve_calendar(place);
    E.analyze(ws, { as_of: ws.as_of });
    assert.deepEqual(CAL.reserve_calendar_use(ws, 'cal-x'), { explicit: 1, implicit: 0 }, place);
    const r = apply(ws, { type: 'delete_calendar', calendar_id: 'cal-x' });
    assert.equal(r.ok, false, place);
    assert.deepEqual([r.error.code, r.error.ctx.field, r.error.ctx.reason], ['E_SCHEMA', 'calendar_id', 'cal_in_use_reserve'], place);
    // ссылку на календарь снимают (в данных) — удаление проходит, прогноз считается
    const free = clone(ws);
    const res = free.reserves.find((x) => x.reserve_id === 'RES-INS');
    if (place === 'calendar_id') delete res.calendar_id; else delete res.cadence.calendar_id;
    const ok = apply(free, { type: 'delete_calendar', calendar_id: 'cal-x' });
    assert.equal(ok.ok, true, JSON.stringify(ok.error));
    assert.doesNotThrow(() => E.analyze(ok.ws, { as_of: ok.ws.as_of }));
  }
  // порядок движка: у резерва `calendar_id` сильнее `cadence.calendar_id`
  const both = with_reserve_calendar('calendar_id');
  both.reserves.find((r) => r.reserve_id === 'RES-INS').cadence.calendar_id = 'cal-main';
  assert.deepEqual([CAL.reserve_calendar_use(both, 'cal-x').explicit, CAL.reserve_calendar_use(both, 'cal-main').explicit], [1, 0]);
});

test('FIX-2 REQ-009 резервы без своего календаря считаются по первому календарю: use.implicit показывает их у первого календаря и только у него', () => {
  // G-001: RES-INS (копилка) без календаря → первый календарь cal-main; RES-TAX — налоговый резерв, взносов по календарю нет
  assert.deepEqual(CAL.reserve_calendar_use(G, 'cal-main'), { explicit: 0, implicit: 1 });
  const two = with_reserve_calendar('calendar_id');
  assert.deepEqual(CAL.reserve_calendar_use(two, 'cal-main'), { explicit: 0, implicit: 0 }, 'копилка называет cal-x, а не первый');
  const no_cal = clone(G);
  no_cal.calendars = [];
  assert.deepEqual(CAL.reserve_calendar_use(no_cal, 'cal-main'), { explicit: 0, implicit: 0 });
  assert.deepEqual(CAL.calendar_usage(G, 'cal-main'), { rules: 4, streams: 1 }, 'прежний вид calendar_usage не изменился');
});

test('FIX-2 в приложении: строка «Используют» называет резервы, отказ удаления говорит причину и не трогает данные и журнал', async () => {
  await reset();
  const g_card = N(by_id('fp13-calendars').textContent);
  assert.match(g_card, /Используют: правил — 4, потоков часов — 1\./, 'прежняя часть строки на месте');
  assert.match(g_card, /Резервов без своего календаря — 1: их взносы считаются по этому календарю, пока он первый в списке/);
  await reset(with_reserve_calendar('calendar_id'));
  const card = N(by_id('fp13-calendars').textContent);
  assert.match(card, /Запасной выходные: Сб, Вс; 0 праздников Используют: правил — 0, потоков часов — 0\. Резервов, которые называют этот календарь, — 1\./);
  const del = find_all(by_id('fp13-calendars'), (n) => n.attrs['data-act'] === 'cal-delete' && N(n.attrs['aria-label']).includes('Запасной'))[0];
  const j0 = ctx.journal.length;
  click(del);
  assert.deepEqual(ctx.get_ws().calendars.map((c) => c.calendar_id), ['cal-main', 'cal-x'], 'данные не тронуты');
  assert.equal(ctx.journal.length, j0, 'журнал не растёт');
  assert.ok(notes().some((m) => /^Не принято \(E_SCHEMA\): календарь указан у резерва/.test(m)), notes().slice(-3).join(' | '));
});

// ── FIX-3: осиротевшие правки вхождений ───────────────────────────────────────────────────────────────────────────────────────────

/** Правило «третий рабочий день месяца» с пропуском (или переносом) вхождения 4 ноября. */
function with_workday_rule(kind) {
  const ws = clone(G);
  ws.rules.push({ rule_id: 'R-WD', account_id: 'acc_main', name: 'Взнос', kind: 'expense', currency: 'EUR', freq: 'M', interval: 1, start_date: '2026-10-01', weekend: 'keep', by_workday: [3],
    calendar_id: 'cal-main', amount: { exp_minor: -10000 }, month_end: 'clamp', exdates: [], is_obligation: false, is_estimate: false });
  return must(apply(ws, kind === 'skip' ? RULE.skip_edit('R-WD', '2026-11-04') : RULE.move_edit('R-WD', '2026-11-04', '2026-11-06')));
}
const add_holiday = (ws, iso) => must(apply(ws, { type: 'upsert_calendar', calendar: { calendar_id: 'cal-main', name: 'Суббота и воскресенье', weekend_dows: [0, 6], holidays: [iso] } }));

test('FIX-3 REQ-010 смена календаря сдвинула номинальную дату: пропуск и перенос становятся осиротевшими — их нет в «пропущено» и «перенесено», они в orphaned_of; вернули календарь — правка снова действует', () => {
  for (const kind of ['skip', 'move']) {
    const live = with_workday_rule(kind);
    assert.equal(RULE.orphan_count(live, live.as_of), 0, kind + ': пока календарь прежний, сирот нет');
    assert.deepEqual(kind === 'skip' ? RULE.skipped_of(live, 'R-WD', live.as_of) : RULE.changed_of(live, 'R-WD', live.as_of).map((o) => o.nominal_date), ['2026-11-04']);
    const moved = add_holiday(live, '2026-11-03');
    assert.deepEqual(RULE.skipped_of(moved, 'R-WD', moved.as_of), [], kind + ': пропуск не показывается как действующий');
    assert.deepEqual(RULE.changed_of(moved, 'R-WD', moved.as_of), [], kind + ': перенос не показывается как действующий');
    assert.deepEqual(RULE.orphaned_of(moved, 'R-WD', moved.as_of).map((o) => [o.nominal_date, o.action]), [['2026-11-04', kind === 'skip' ? 'skip' : 'move']]);
    assert.equal(RULE.orphan_count(moved, moved.as_of), 1);
    assert.equal(RULE.orphan_count(moved, '2026-12-01'), 0, 'прошедшие сироты не считаются');
    assert.deepEqual(RULE.orphaned_of(moved, 'R-RENT', moved.as_of), [], 'у других правил сирот нет');
    // убрать осиротевшую правку можно общей правкой «вернуть»
    const clean = must(apply(moved, RULE.restore_edit('R-WD', '2026-11-04')));
    assert.deepEqual(clean.overrides, []);
    // календарь вернули — запись снова действует
    const back = must(apply(moved, { type: 'upsert_calendar', calendar: { calendar_id: 'cal-main', name: 'Суббота и воскресенье', weekend_dows: [0, 6], holidays: [] } }));
    assert.equal(RULE.orphan_count(back, back.as_of), 0);
    assert.equal(E.canon(back.overrides), E.canon(live.overrides));
  }
  // правило с неизвестным идентификатором и пустая область не ломают подсчёт
  assert.deepEqual(RULE.orphaned_of(G, 'нет такого', G.as_of), []);
  assert.equal(RULE.orphan_count({ ...G, rules: [], overrides: [] }, G.as_of), 0);
  assert.equal(RULE.orphan_count(G, G.as_of), 0);
});

test('FIX-3 REQ-010 в приложении: смена календаря сообщает, сколько правок перестало действовать; под правилом строка «не применяется» и кнопка «Убрать правку»; «Отменить» возвращает правку', async () => {
  const ws = with_workday_rule('skip');
  await reset(ws);
  assert.equal(find_all(rule_item('R-WD'), (n) => n.attrs['data-orphan'] === 'true').length, 0, 'до смены календаря сирот нет');
  assert.ok(N(rule_item('R-WD').textContent).includes('Пропущено: 4 ноября'));
  const edit = find_all(by_id('fp13-calendars'), (n) => n.attrs['data-act'] === 'cal-edit')[0];
  click(edit);
  type_into(by_id('fp08-cal-holidays'), '2026-11-03');
  submit('fp08-cal');
  assert.deepEqual(ctx.get_ws().calendars[0].holidays, ['2026-11-03']);
  assert.ok(notes().some((m) => /Календарь «Суббота и воскресенье» обновлён: даты будущих вхождений пересчитаны\. Правок вхождений .*перестали применяться: 1\./.test(m)), notes().slice(-3).join(' | '));
  await go('#forms');
  const orphan = find_all(rule_item('R-WD'), (n) => n.attrs['data-orphan'] === 'true');
  assert.equal(orphan.length, 1);
  assert.match(N(orphan[0].textContent), /Правка на 4 ноября не применяется: в этот день у правила больше нет вхождения/);
  assert.ok(!N(rule_item('R-WD').textContent).includes('Пропущено: 4 ноября'), 'осиротевший пропуск не выдаётся за действующий');
  const button = find_all(orphan[0], (n) => n.tagName === 'button')[0];
  assert.equal(N(button.textContent), 'Убрать правку');
  assert.equal(N(button.attrs['aria-label']), 'Убрать правку, которая не применяется: правило «Взнос», 4 ноября');
  click(button);
  assert.deepEqual(ctx.get_ws().overrides, [], 'правка убрана');
  assert.ok(notes().some((m) => /Правка на 4 ноября у правила «Взнос» убрана\. «Отменить» вернёт её\./.test(m)), notes().slice(-2).join(' | '));
  await go('#forms');
  assert.equal(find_all(rule_item('R-WD'), (n) => n.attrs['data-orphan'] === 'true').length, 0);
  click(nav_button('Отменить'));
  assert.equal(ctx.get_ws().overrides.length, 1, '«Отменить» вернула правку');
  // английский текст
  click(lang_button('en'));
  await go('#forms');
  const en = find_all(rule_item('R-WD'), (n) => n.attrs['data-orphan'] === 'true');
  assert.equal(en.length, 1);
  assert.match(N(en[0].textContent), /The change for November 4 no longer applies/);
  assert.equal(N(find_all(en[0], (n) => n.tagName === 'button')[0].textContent), 'Remove the change');
  click(lang_button('ru'));
  await go('#forms');
});

// ── FIX-4: прошедшие разовые платежи ──────────────────────────────────────────────────────────────────────────────────────────────

test('FIX-4 REQ-010 plan_rows: прошедшие платежи отдаются списком от свежих к давним, не больше предела; остальные — счётчиком; прежние поля не изменились', () => {
  const ws = clone(G);
  for (let i = 1; i <= 35; i++) ws.plans.push({ plan_id: 'P-OLD' + String(i).padStart(2, '0'), account_id: 'acc_main', name: 'Было ' + i, date: E.format_date(E.to_epoch_day('2026-09-30') - i), amount_minor: -100, currency: 'EUR' });
  ws.plans.push({ plan_id: 'P-LEG', account_id: 'acc_main', name: 'Нога', date: '2026-01-01', amount_minor: -5, currency: 'EUR', transfer_id: 'T-1' });
  const m = PLAN.plan_rows(ws);
  assert.equal(m.past, 35);
  assert.equal(m.past_rows.length, PLAN.PAST_ROWS);
  assert.equal(m.past_hidden, 35 - PLAN.PAST_ROWS);
  assert.deepEqual(m.past_rows.slice(0, 2).map((p) => p.plan_id), ['P-OLD01', 'P-OLD02'], 'самые свежие первыми');
  assert.ok(m.past_rows.every((p, i, a) => i === 0 || a[i - 1].date >= p.date));
  assert.ok(!m.past_rows.some((p) => p.plan_id === 'P-LEG'), 'ног переводов нет');
  assert.deepEqual(m.upcoming.map((p) => p.plan_id), PLAN.plan_rows(G).upcoming.map((p) => p.plan_id), 'будущие платежи те же');
  assert.equal(PLAN.plan_rows(ws, 15, 5).past_rows.length, 5);
});

test('FIX-4 REQ-010 в приложении: платёж с ошибкой в дате (прошлый год) виден в свёрнутом списке «прошедшие», его можно исправить и удалить; «Отменить» возвращает', async () => {
  await reset();
  type_into(by_id('fp08-plan-name'), 'Опечатка в году');
  type_into(by_id('fp08-plan-amount'), '10');
  type_into(by_id('fp08-plan-date'), '2025-10-08');
  assert.match(N(by_id('fp13-plan-preview').textContent), /Ниже, в списке прошедших платежей, его можно исправить или удалить\./);
  submit('fp08-plan');
  await go('#forms');
  const plan = ctx.get_ws().plans.at(-1);
  assert.equal(plan.date, '2025-10-08');
  const past = by_id('fp13-plan-past');
  assert.ok(past !== undefined, 'есть список прошедших');
  assert.equal(past.tagName, 'details');
  assert.match(N(find_all(past, (n) => n.tagName === 'summary')[0].textContent), /^Прошедших разовых платежей: 1; их статус — в «Сверке»\.$/);
  assert.match(N(past.textContent), /Платёж раньше последней сверки остатка в «Сверке» не виден/);
  const edit = find_all(past, (n) => n.attrs['data-act'] === 'plan-edit' && N(n.attrs['aria-label']).includes('Опечатка в году'))[0];
  assert.ok(edit !== undefined, 'есть «Править»');
  assert.match(N(edit.attrs['aria-label']), /^Править разовый платёж «Опечатка в году» 8 октября 2025$/);
  click(edit);
  assert.equal(by_id('fp08-plan-date').value, '2025-10-08');
  type_into(by_id('fp08-plan-date'), '2026-11-10');
  submit('fp08-plan');
  await go('#forms');
  assert.equal(ctx.get_ws().plans.find((p) => p.plan_id === plan.plan_id).date, '2026-11-10', 'дата исправлена');
  assert.equal(by_id('fp13-plan-past'), undefined, 'прошедших не осталось');
  assert.match(N(by_id('fp13-plans').textContent), /10 ноября: Опечатка в году — −10,00 €/, 'платёж в списке ближайших');
  click(nav_button('Отменить'));
  assert.equal(ctx.get_ws().plans.find((p) => p.plan_id === plan.plan_id).date, '2025-10-08', '«Отменить» вернула прежнюю дату');
  await go('#forms');
  const del = find_all(by_id('fp13-plan-past'), (n) => n.attrs['data-act'] === 'plan-delete')[0];
  click(del);
  assert.ok(!ctx.get_ws().plans.some((p) => p.plan_id === plan.plan_id), 'платёж удалён');
  assert.ok(notes().some((m) => /^Платёж «Опечатка в году» удалён\.$/.test(m)));
});

// ── FIX-5: введённые праздники в предпросмотре ────────────────────────────────────────────────────────────────────────────────────

test('FIX-5 REQ-009 holidays_ahead: праздники не раньше «сегодня» по возрастанию, остальные — счётчиками; calendar_preview возвращает их отдельно от выходных', () => {
  const h = CAL.holidays_ahead(['2026-12-25', '2026-09-01', '2026-10-07', '2026-10-07', '2027-05-01', 7, null], '2026-10-04', 2);
  assert.deepEqual(h, { rows: ['2026-10-07', '2026-12-25'], more: 1, past: 1 });
  assert.deepEqual(CAL.holidays_ahead(undefined, '2026-10-04'), { rows: [], more: 0, past: 0 });
  const built = CAL.build_calendar_edit(G, { calendar_id: 'cal-x', name: 'X', weekend_dows: ['0', '6'], holidays: '2026-12-25 2026-09-01' }, { cur: 'EUR', lang: 'ru', as_of: G.as_of });
  const p = CAL.calendar_preview(G, built.edit, { as_of: G.as_of, new_id: (x) => x + '_1' });
  assert.equal(p.ok, true);
  assert.deepEqual(p.holidays, { rows: ['2026-12-25'], more: 0, past: 1 });
  assert.equal(p.rows.length, CAL.PREVIEW_ROWS, 'строки выходных прежние');
  assert.ok(!p.rows.some((x) => x.date === '2026-12-25'), 'дальний праздник за восемь строк выходных не попадает — поэтому нужен отдельный список');
});

test('FIX-5 REQ-009 в приложении: введённый далёкий праздник виден в предпросмотре отдельным списком; RU и EN', async () => {
  await reset();
  click(find_all(by_id('fp13-calendars'), (n) => n.attrs['data-act'] === 'cal-edit')[0]);
  type_into(by_id('fp08-cal-holidays'), '2026-12-25\n2026-09-01');
  const prev = N(by_id('fp13-cal-preview').textContent);
  assert.match(prev, /Введённые праздники по возрастанию \(не раньше «сегодня»\)/);
  assert.match(prev, /25 декабря: праздник/);
  assert.match(prev, /Праздников раньше «сегодня»: 1; на будущие даты они не влияют\./);
  const list = find_all(by_id('fp13-cal-preview'), (n) => n.attrs.id === 'fp13-cal-hol-list')[0];
  assert.deepEqual(find_all(list, (n) => n.tagName === 'li').map((li) => N(li.textContent)), ['25 декабря: праздник']);
  type_into(by_id('fp08-cal-holidays'), '');
  assert.ok(!N(by_id('fp13-cal-preview').textContent).includes('Введённые праздники'), 'без праздников списка нет');
  click(lang_button('en'));
  await go('#forms');
  click(find_all(by_id('fp13-calendars'), (n) => n.attrs['data-act'] === 'cal-edit')[0]);
  type_into(by_id('fp08-cal-holidays'), '2026-12-25');
  assert.match(N(by_id('fp13-cal-preview').textContent), /Holidays you entered, in ascending order \(not earlier than today\)[\s\S]*December 25: holiday/);
  click(lang_button('ru'));
  await go('#forms');
});

// ── строки ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('TST-56 строки исправлений FP-13: новые ключи есть на RU и EN с теми же плейсхолдерами, у RU — русские буквы, у EN — нет; запрещённых формулировок нет', () => {
  const placeholders = (s) => [...s.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]).sort().join(',');
  const keys = [
    ...['cal_usage_reserves', 'cal_usage_default', 'cal_orphans', 'preview_hol_title', 'preview_hol_more', 'preview_hol_past', 'r_cal_in_use_reserve', 'plan_past_hint', 'plan_past_more'].map((k) => ['calendars.' + k, CATALOG]),
    ...['ov_orphan_row', 'ov_orphan_remove', 'ov_orphan_remove_label', 'ov_orphan_removed'].map((k) => ['forms.' + k, FORMS_CAT]),
  ];
  const vocab = JSON.parse(fs.readFileSync(path.join(PROTO, 'engine', 'vocab.json'), 'utf8'));
  for (const [k, cat] of keys) {
    assert.equal(typeof cat.ru[k], 'string', 'RU ' + k);
    assert.equal(typeof cat.en[k], 'string', 'EN ' + k);
    assert.equal(placeholders(cat.ru[k]), placeholders(cat.en[k]), k);
    assert.match(cat.ru[k], /[а-яё]/i, k);
    assert.ok(!/[а-яё]/i.test(cat.en[k]), 'EN без русских букв: ' + k);
    for (const phrase of vocab.forbidden_phrases) {
      for (const text of [cat.ru[k], cat.en[k]]) assert.ok(!text.toLowerCase().replace(/ё/g, 'е').includes(phrase.toLowerCase().replace(/ё/g, 'е')), `запрещено «${phrase}» в ${k}`);
    }
    assert.equal(I18N.t('ru', k, { n: 1, reserves: 1, code: 'E_SCHEMA', date: 'x', name: 'y' }).includes(k), false, 'ключ найден в слитом словаре: ' + k);
  }
  // отказ с кодом канона и без повтора введённого, на обоих языках
  for (const lang of ['ru', 'en']) {
    const tr = (k, p) => I18N.t(lang, k, p);
    const text = CAL.reason_text({ tr }, { code: 'E_SCHEMA', ctx: { field: 'calendar_id', reason: 'cal_in_use_reserve' } });
    assert.ok(text.includes('E_SCHEMA') && !text.includes('calendars.r_'), text);
  }
});
