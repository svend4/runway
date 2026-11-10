// number_format_surfaces.test.mjs — FP-16: формат чисел и дат пользователя (ws.number_format, REQ-112) применяется на ВСЕХ поверхностях, а не только в основных таблицах:
// ответы ассистента A0 (верификатор: четвёртый параметр render_value и a0_answer, слой 2 понимает тот же формат), таблица доказательств, страница v0, мастер импорта,
// сообщения «Отменить», сверка остатка, лист для печати, «в магазине». Без настройки поведение прежнее (побайтно). Браузер, сеть и серверы не используются.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.resolve(HERE, '..');
const DEMO = path.join(PROTO, 'demo');

// ── заглушка DOM ────────────────────────────────────────────────────────────────────────────────────────────────────────
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
  focus() {}
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
  createElement: (t) => new Node_(t), createElementNS: (ns, t) => new Node_(t, ns), createTextNode: (data) => ({ nodeType: 3, data }),
  getElementById: (id) => byid.get(id) ?? null, documentElement: new Node_('html'), head: new Node_('head'), body: new Node_('body'), title: '',
};
globalThis.window = { addEventListener: (t, fn) => { (listeners[t] ??= []).push(fn); }, scrollTo: () => {} };
globalThis.location = { hash: '' };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'ru-RU' }, configurable: true });
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.ResizeObserver = class { observe() {} };
globalThis.fetch = async (url) => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8')) });

const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);
const { ext } = await imp('demo', 'ext.mjs');
const APP = await imp('demo', 'app.mjs');
await new Promise((r) => setTimeout(r, 500));
const VER = await imp('engine', 'verifier.mjs');
const E = await imp('engine', 'index.mjs');
const NF = await imp('demo', 'number_format.mjs');
const ENTRY = await imp('demo', 'entry.mjs');
const IMPW = await imp('demo', 'import_wizard.mjs');
const ANCHOR = await imp('demo', 'anchor_dialog.mjs');
const PACK04 = await imp('demo', 'pack_fp04.mjs');
const STORE = await imp('demo', 'store_mode.mjs');
const V0 = await imp('demo', 'v0.mjs');
const I18N = await imp('demo', 'i18n.mjs');

const G = JSON.parse(fs.readFileSync(path.join(PROTO, 'data', 'g001.json'), 'utf8'));
const NBSP = /[  ]/g;
const plain = (s) => s.replace(NBSP, ' ');
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };
const main_text = () => byid.get('main').textContent;
const field = (id) => find_all(byid.get('main'), (n) => n.attrs.id === id)[0];
const tr_of = (lang) => (key, params) => I18N.t(lang, key, params);

const DOT_COMMA = { decimal: ',', thousands: '.' }; // «1.234,50»
const PRESETS = Object.entries(NF.NUMBER_PRESETS).filter(([, v]) => v !== null);
const DATE_NFS = [{ date: 'iso' }, { date: 'dmy' }, { date: 'mdy' }];
const ALL_NFS = [...PRESETS.map(([, v]) => v), ...DATE_NFS, { ...DOT_COMMA, date: 'dmy' }, { decimal: '.', thousands: '', date: 'mdy' }];
const AS_OF = '2026-10-04';

// ── верификатор: четвёртый параметр ──────────────────────────────────────────────────────────────────────────────────────

test('REQ-112 render_value(ev, locale, as_of, number_format): деньги, проценты и даты совпадают с make_nf_fmt приложения для всех пресетов и стилей дат, обоих языков', () => {
  const moneys = [0, 5, -5, 99, 100, 123450, -123450, 99999999, -1, 150];
  const bps = [0, 5, 4147, -250, 17000, 1250];
  const dates = ['2026-10-04', '2026-11-14', '2027-03-01', '2025-12-31'];
  for (const nf of ALL_NFS) {
    for (const lang of ['ru', 'en']) {
      const f = NF.make_nf_fmt(lang, 'EUR', AS_OF, nf);
      for (const v of moneys) {
        assert.equal(VER.render_value({ kind: 'money', v, cur: 'EUR', dp: 2 }, lang, AS_OF, nf), f.money(v), `money ${v} ${lang} ${JSON.stringify(nf)}`);
        assert.equal(VER.render_value({ kind: 'money', v, cur: 'EUR', dp: 0 }, lang, AS_OF, nf), f.money0(v), `money0 ${v} ${lang} ${JSON.stringify(nf)}`);
      }
      for (const v of bps) assert.equal(VER.render_value({ kind: 'pct_bp', v }, lang, AS_OF, nf), f.bp(v), `bp ${v} ${lang} ${JSON.stringify(nf)}`);
      for (const v of dates) assert.equal(VER.render_value({ kind: 'date', v }, lang, AS_OF, nf), f.date(v), `date ${v} ${lang} ${JSON.stringify(nf)}`);
    }
  }
  assert.equal(plain(VER.render_value({ kind: 'money', v: 123450, cur: 'EUR', dp: 2 }, 'ru', AS_OF, DOT_COMMA)), '1.234,50 €');
  assert.equal(VER.render_value({ kind: 'money', v: 123450, cur: 'USD', dp: 2 }, 'en', AS_OF, DOT_COMMA), '$1.234,50');
  assert.equal(VER.render_value({ kind: 'date', v: '2026-10-04' }, 'ru', AS_OF, { date: 'dmy' }), '04.10.2026');
  assert.equal(VER.render_value({ kind: 'days', v: 14 }, 'ru', AS_OF, DOT_COMMA), '14 дней', 'слова остаются по языку');
});

test('REQ-112 без настройки поведение прежнее побайтно; недопустимая настройка из файла отбрасывается целиком', () => {
  const evs = [{ kind: 'money', v: 123450, cur: 'EUR', dp: 2 }, { kind: 'money', v: -5, cur: 'RUB', dp: 2 }, { kind: 'date', v: '2027-01-05' }, { kind: 'pct_bp', v: 4147 }, { kind: 'days', v: 21 }, { kind: 'count', v: 3 }];
  const junk = [null, undefined, {}, { decimal: ',' }, { thousands: '.' }, { decimal: ',', thousands: ',' }, { decimal: ';', thousands: ' ' }, { decimal: ',', thousands: '.', extra: 1 }, { date: 'yyyy' }, [], 'dot_comma', 5];
  for (const lang of ['ru', 'en']) for (const ev of evs) {
    const base = VER.render_value(ev, lang, AS_OF);
    for (const nf of junk) assert.equal(VER.render_value(ev, lang, AS_OF, nf), base, `${JSON.stringify(ev)} ${lang} ${JSON.stringify(nf)}`);
  }
  assert.equal(VER.render_value({ kind: 'money', v: 123450, cur: 'EUR', dp: 2 }, 'ru', AS_OF), '1 234,50 €');
  assert.equal(VER.render_value({ kind: 'money', v: 123450, cur: 'EUR', dp: 2 }, 'en', AS_OF), '€1,234.50');
});

test('REQ-112 слой 2 верификатора понимает формат пользователя: отрисованный в нём текст проходит сверку, чужой формат — нарушение (fail-closed)', () => {
  const values = [0, 5, 99, 1000, 123450, -123450, 99999999, 100000000];
  for (const nf of ALL_NFS) for (const lang of ['ru', 'en']) for (const v of values) {
    const ev = { id: 'e1', kind: 'money', v, cur: 'EUR', dp: 2 };
    const text = 'Сумма ' + VER.render_value(ev, lang, AS_OF, nf) + '.';
    assert.deepEqual(VER.verify_text(text, [ev], lang, nf), [], `${text} ${lang} ${JSON.stringify(nf)}`);
  }
  for (const nf of ALL_NFS) for (const lang of ['ru', 'en']) for (const d of ['2026-10-04', '2026-11-14', '2027-02-01']) {
    const ev = { id: 'e2', kind: 'date', v: d };
    const text = 'Дата ' + VER.render_value(ev, lang, AS_OF, nf) + '.';
    assert.deepEqual(VER.verify_text(text, [ev], lang, nf), [], `${text} ${lang} ${JSON.stringify(nf)}`);
  }
  const ev = { id: 'e1', kind: 'money', v: 123450, cur: 'EUR', dp: 2 };
  // тот же текст без указания формата: «1.234,50» в русской локали — не по правилам локали → V_AMBIGUOUS_NUMBER
  assert.deepEqual(VER.verify_text('Сумма 1.234,50 €.', [ev], 'ru').map((x) => x.code), ['V_AMBIGUOUS_NUMBER']);
  assert.deepEqual(VER.verify_text('Сумма 1.234,50 €.', [ev], 'ru', DOT_COMMA), []);
  // а числа в языке по умолчанию при формате пользователя — нарушение: смешивать форматы нельзя
  assert.deepEqual(VER.verify_text('Сумма 1 234,50 €.', [ev], 'ru', DOT_COMMA).map((x) => x.code), ['V_AMBIGUOUS_NUMBER']);
  // неверное число в формате пользователя ловится как обычно
  assert.deepEqual(VER.verify_text('Сумма 1.234,51 €.', [ev], 'ru', DOT_COMMA).map((x) => x.code), ['V_NO_MATCH']);
  assert.deepEqual(VER.verify_text('Сумма 1.2345,50 €.', [ev], 'ru', DOT_COMMA).map((x) => x.code), ['V_AMBIGUOUS_NUMBER'], 'группа не из трёх цифр');
  // «мм/дд/гггг» распознаётся только при выбранном стиле, и несуществующая дата — нарушение
  const dev = { id: 'e2', kind: 'date', v: '2026-10-04' };
  assert.deepEqual(VER.verify_text('Дата 10/04/2026.', [dev], 'ru', { date: 'mdy' }), []);
  assert.deepEqual(VER.verify_text('Дата 13/45/2026.', [dev], 'ru', { date: 'mdy' }).map((x) => x.code), ['V_BAD_DATE']);
  assert.notDeepEqual(VER.verify_text('Дата 10/04/2026.', [dev], 'ru'), [], 'без стиля «мм/дд/гггг» — не дата');
  assert.deepEqual(VER.verify_text('Дата 05.10.2026.', [dev], 'ru', { date: 'dmy' }).map((x) => x.code), ['V_NO_MATCH']);
});

test('REQ-112 a0_answer(…, number_format): фраза ответа Q3 показывает «1.234,50 €», слой 2 проверяет её по тому же формату; без настройки ответ прежний побайтно', () => {
  const model = APP.build_model(G, { lang: 'ru' });
  const cmd = { name: 'check_purchase', args: { date: '2026-10-31', amount_minor: 123450, currency: 'EUR' } };
  const ask = (lang, opts, nf) => { model.ctx.calls_used = 0; return VER.a0_answer(cmd, model.ctx, { locale: lang, ...opts }, nf); };
  const base = ask('ru', {});
  assert.equal(base.verified, true);
  assert.ok(base.text.includes('Покупка 1 234,50 € на 31 октября'), base.text);
  assert.equal(ask('ru', { number_format: null }).text, base.text, 'null — как без настройки');
  assert.equal(ask('ru', { number_format: {} }).text, base.text, 'пустая настройка — как без настройки');
  const custom = ask('ru', {}, DOT_COMMA);
  assert.equal(custom.verified, true, JSON.stringify(custom.violations));
  assert.deepEqual(custom.violations, []);
  assert.ok(custom.text.includes('Покупка 1.234,50 € на 31 октября'), custom.text);
  assert.ok(!/\d \d{3}/.test(custom.text), 'нет сумм по языку по умолчанию: ' + custom.text);
  assert.equal(ask('ru', { number_format: DOT_COMMA }).text, custom.text, 'opts.number_format и четвёртый параметр равнозначны');
  // даты: каждый стиль виден в тексте и проходит сверку
  for (const [style, frag] of [['iso', '2026-10-31'], ['dmy', '31.10.2026'], ['mdy', '10/31/2026']]) {
    const r = ask('ru', {}, { ...DOT_COMMA, date: style });
    assert.equal(r.verified, true, style + ' ' + JSON.stringify(r.violations));
    assert.ok(r.text.includes(frag), style + ': ' + r.text);
  }
  // английский: слова английские, числа — в формате пользователя
  const en = ask('en', {}, DOT_COMMA);
  assert.equal(en.verified, true, JSON.stringify(en.violations));
  assert.ok(en.text.includes('Purchase of €1.234,50 on October 31'), en.text);
  // tool-ошибка не зависит от формата
  const bad = VER.a0_answer({ name: 'check_purchase', args: { date: 'вчера' } }, model.ctx, { locale: 'ru' }, DOT_COMMA);
  assert.equal(bad.ok, false);
});

// ── приложение: ответы, доказательства, экраны ─────────────────────────────────────────────────────────────────────────────

test('REQ-112 ответы ассистента и «Могу ли я купить?» в формате пользователя: модели ask_a0 и buy_run, таблица доказательств в диалоге', async () => {
  const ws = { ...JSON.parse(JSON.stringify(G)), number_format: DOT_COMMA };
  assert.equal(ext.ctx.set_ws(ws, { reason: 'test_nf' }).ok, true);
  const model = APP.build_model(ws, { lang: 'ru' });
  const q = APP.ask_a0(model, 'Могу ли я купить за 1234,50 на 31 октября?', 'ru', APP.first_income_ref(model));
  assert.equal(q.ok, true);
  assert.equal(q.verified, true);
  assert.ok(q.text.includes('1.234,50'), q.text);
  assert.ok(!/\d \d{3},\d{2}/.test(q.text), q.text);
  const buy = APP.buy_run(model, { date: '2026-10-31', amount_minor: 123450 }, 'ru');
  assert.equal(buy.ok, true);
  assert.ok(buy.text.includes('1.234,50'), buy.text);
  assert.equal(buy.view.verified, true);
  // экран «Ассистент»: ответ и таблица доказательств (чип «числа из расчёта»)
  await go('#assistant');
  field('as-q').value = 'Могу ли я купить за 1234,50 на 31 октября?';
  find_all(byid.get('main'), (n) => n.tagName === 'form' && /ask/.test(n.className))[0].listeners.submit[0]({ preventDefault() {} });
  assert.match(main_text(), /Покупка 1\.234,50 € на 31 октября/);
  // FP-20: чип происхождения заменил прежнюю кнопку; список чисел открывает его кнопка «Числа расчёта» (запасная прежняя кнопка без пакета тоже подходит)
  const chip = find_all(byid.get('main'), (n) => n.tagName === 'button' && (/^числа из расчёта/.test(n.textContent) || /(^|\s)a0-numbers(\s|$)/.test(n.className)))[0];
  assert.ok(chip !== undefined, 'чип «числа из расчёта»');
  chip.listeners.click[0]();
  const ev_text = byid.get('dlg-body').textContent;
  assert.match(ev_text, /1\.234,50 €/, 'таблица доказательств: сумма из вопроса в формате пользователя');
  assert.ok(!/\d \d{3},\d{2}/.test(ev_text), 'в таблице доказательств нет формата языка по умолчанию: ' + ev_text);
  // экран «Купить» с результатом в формате пользователя
  await go('#buy');
  assert.ok(!/\d \d{3},\d{2} €/.test(main_text()), 'экран «Купить» без формата языка по умолчанию');
  // лист для печати, «в магазине», обзор: суммы по формату пользователя
  await go('#report');
  const report = main_text();
  assert.match(report, /\d\.\d{3},\d{2} €/, 'лист для печати: ' + report.slice(0, 300));
  assert.ok(!/\d \d{3},\d{2} €/.test(report), 'лист для печати без формата языка');
  await go('#store');
  assert.ok(!/\d \d{3},\d{2} €/.test(main_text()), '«в магазине» без формата языка');
  await go('#overview');
  assert.ok(!/\d \d{3},\d{2} €/.test(main_text()), 'обзор без формата языка');
  // возврат к набору G-001 без настройки: формат языка (регрессия «настройка не залипает»)
  assert.equal(ext.ctx.set_ws(JSON.parse(JSON.stringify(G)), { reason: 'test_reset' }).ok, true);
  await go('#assistant');
  field('as-q').value = 'Могу ли я купить за 1234,50 на 31 октября?';
  find_all(byid.get('main'), (n) => n.tagName === 'form' && /ask/.test(n.className))[0].listeners.submit[0]({ preventDefault() {} });
  const answers = find_all(byid.get('main'), (n) => /(^|\s)a0(\s|$)/.test(n.className));
  assert.ok(answers.length >= 2, 'в журнале прежний ответ и новый');
  assert.match(answers.at(-1).textContent, /Покупка 1 234,50 € на 31 октября/, 'новый ответ — снова в формате языка');
  assert.match(answers[0].textContent, /Покупка 1\.234,50 €/, 'прежний ответ остался таким, каким был показан');
});

test('REQ-112 мастер «Старт»: суммы шага и прогноз рисуются форматтером рабочей области (fmt_of → make_nf_fmt), а не жёстким форматом языка', async () => {
  const ws = { ...JSON.parse(JSON.stringify(G)), number_format: DOT_COMMA };
  assert.equal(ext.ctx.set_ws(ws, { reason: 'test_nf' }).ok, true);
  await go('#start');
  const start = main_text();
  assert.ok(start.length > 100, 'экран «Старт» нарисован');
  assert.ok(!/\d \d{3},\d{2} €/.test(start), 'на экране «Старт» нет формата языка по умолчанию: ' + start.slice(0, 300));
  const src = fs.readFileSync(path.join(DEMO, 'wizard.mjs'), 'utf8');
  assert.doesNotMatch(src, /render_value\(|make_fmt\(|format_minor\(/, 'мастер не форматирует сам: только fmt_of');
  assert.match(src, /fmt_of\(env\)/);
  assert.equal(ext.ctx.set_ws(JSON.parse(JSON.stringify(G)), { reason: 'test_reset' }).ok, true);
});

// ── мастер импорта, «Отменить», сверка, «в магазине» ──────────────────────────────────────────────────────────────────────

test('REQ-112 мастер импорта: money_text, date_text и size_text по формату пользователя; без настройки прежний вывод', () => {
  assert.equal(plain(IMPW.money_text('ru', 123450, 'EUR', AS_OF)), '1 234,50 €');
  assert.equal(plain(IMPW.money_text('ru', 123450, 'EUR', AS_OF, DOT_COMMA)), '1.234,50 €');
  assert.equal(IMPW.money_text('en', -123450, 'USD', AS_OF, DOT_COMMA), '−$1.234,50');
  assert.equal(IMPW.money_text('ru', 123450, 'EUR', AS_OF, null), IMPW.money_text('ru', 123450, 'EUR', AS_OF));
  assert.equal(IMPW.date_text('ru', '2026-10-04', AS_OF), '4 октября');
  assert.equal(IMPW.date_text('ru', '2026-10-04', AS_OF, { date: 'dmy' }), '04.10.2026');
  assert.equal(IMPW.date_text('en', '2026-10-04', AS_OF, { date: 'mdy' }), '10/04/2026');
  assert.equal(IMPW.date_text('ru', '', AS_OF, { date: 'dmy' }), '—');
  assert.equal(IMPW.size_text(5300, 'ru'), '5,2 КБ');
  assert.equal(IMPW.size_text(5300, 'ru', { decimal: '.', thousands: ',' }), '5.2 КБ', 'десятичный знак размера файла — из формата пользователя');
  assert.equal(IMPW.size_text(5300, 'en', DOT_COMMA), '5,2 KB');
  assert.equal(IMPW.size_text(5300, 'en'), '5.2 KB');
});

test('REQ-112 ввод факта и сообщения «Отменить»: сумма и дата — в формате пользователя (money_text/date_text, undo_done_handler, сверка остатка)', () => {
  assert.equal(plain(ENTRY.money_text('ru', 123450, 'EUR', AS_OF, DOT_COMMA)), '1.234,50 €');
  assert.equal(plain(ENTRY.money_text('ru', 123450, 'EUR', AS_OF)), '1 234,50 €');
  assert.equal(ENTRY.date_text('ru', '2026-10-04', AS_OF, { date: 'iso' }), '2026-10-04');
  assert.equal(ENTRY.date_text('ru', '2026-10-04', AS_OF), '4 октября');
  const ws = { ...JSON.parse(JSON.stringify(G)), number_format: DOT_COMMA };
  const msgs = [];
  const ctx = { ...ext.ctx, lang: () => 'ru', get_ws: () => ws, notify: (m, kind) => msgs.push([m, kind]), set_ws: () => ({ ok: true }) };
  const done = PACK04.undo_done_handler(ctx);
  done('undo', { ok: true, meta: { kind: 'expense', amount_minor: -123450, currency: 'EUR' } });
  done('redo', { ok: true, meta: { kind: 'income', amount_minor: 99999900, currency: 'EUR' } });
  assert.equal(plain(msgs[0][0]), 'Отменено: расход 1.234,50 €.');
  assert.equal(plain(msgs[1][0]), 'Возвращено: приход 999.999,00 €.');
  const plain_ctx = { ...ctx, get_ws: () => G, notify: (m) => msgs.push([m, 'x']) };
  PACK04.undo_done_handler(plain_ctx)('undo', { ok: true, meta: { kind: 'expense', amount_minor: -123450, currency: 'EUR' } });
  assert.equal(plain(msgs[2][0]), 'Отменено: расход 1 234,50 €.', 'без настройки — формат языка');
  // сверка остатка
  const pv = { first: false, drift_minor: 123450, entered_minor: 500000, expected_minor: 376550, currency: 'EUR', date: '2026-10-04' };
  const txt = plain(ANCHOR.preview_text({ ...ext.ctx, lang: () => 'ru' }, ws, pv));
  assert.match(txt, /5\.000,00 €/);
  assert.match(txt, /1\.234,50 €/);
  assert.match(txt, /3\.765,50 €/);
  assert.doesNotMatch(txt, /\d \d{3},\d{2}/);
  const txt2 = plain(ANCHOR.preview_text({ ...ext.ctx, lang: () => 'ru' }, G, pv));
  assert.match(txt2, /1 234,50 €/);
});

test('REQ-112 «в магазине»: время ответа с десятичным знаком из формата пользователя', () => {
  assert.equal(STORE.ms_text('ru', 37), '3,7 мс');
  assert.equal(STORE.ms_text('en', 37), '3.7 ms');
  assert.equal(STORE.ms_text('ru', 37, '.'), '3.7 мс');
  assert.equal(STORE.ms_text('en', 37, ','), '3,7 ms');
});

// ── страница v0 ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-112 страница v0: make_v0_fmt, разбор полей и ответ по формату пользователя; без настройки прежнее', () => {
  const ru = V0.make_v0_fmt('ru', 'EUR', AS_OF, DOT_COMMA);
  assert.equal(plain(ru.money(123450)), '1.234,50 €');
  assert.equal(V0.make_v0_fmt('ru', 'EUR', AS_OF, { date: 'dmy' }).date('2026-10-04'), '04.10.2026');
  assert.equal(plain(V0.make_v0_fmt('ru', 'EUR', AS_OF).money(123450)), '1 234,50 €');
  assert.equal(plain(V0.make_v0_fmt('ru', 'EUR', AS_OF, { decimal: ',', thousands: ',' }).money(123450)), '1 234,50 €', 'недопустимая настройка отброшена');
  assert.equal(V0.pct_text(2050, 'ru'), '20,50');
  assert.equal(V0.pct_text(2050, 'ru', { decimal: '.', thousands: ',' }), '20.50');
  const env = { cur: 'EUR', lang: 'ru', as_of: AS_OF, nf: DOT_COMMA };
  const p = V0.parse_purchase({ amount: '1.234,50', date: '2026-10-31' }, env);
  assert.deepEqual(p.value, { amount_minor: 123450, date: '2026-10-31' });
  assert.equal(V0.parse_purchase({ amount: '1 234,50', date: '2026-10-31' }, env).ok, false, 'формат языка при формате пользователя не принимается');
  assert.equal(V0.parse_top({ as_of: AS_OF, balance: '1.234,50', buffer: '', horizon: '60' }, env).value.balance_minor, 123450);
  const r = V0.parse_reserve({ kind: 'tax', name: 'Налог', funded: '1,000', rate: '20.5' }, { ...env, nf: { decimal: '.', thousands: ',' } });
  assert.equal(r.value.rate_bp, 2050);
  // выбор формата → nf формы
  assert.deepEqual(V0.nf_from_choice('dot_comma', 'dmy'), { decimal: ',', thousands: '.', date: 'dmy' });
  assert.deepEqual(V0.nf_from_choice('auto', 'auto'), null);
  assert.deepEqual(V0.nf_from_choice('auto', 'iso'), { date: 'iso' });
  assert.deepEqual(V0.nf_from_choice('custom', 'auto', DOT_COMMA), DOT_COMMA);
  assert.deepEqual(V0.nf_from_choice('nonsense', 'nonsense'), null);
  const top = V0.parse_top({ as_of: AS_OF, balance: '10', buffer: '', horizon: '60', numfmt: 'comma_dot', datefmt: 'iso' }, { cur: 'EUR', lang: 'ru' });
  assert.deepEqual(top.value.number_format, { decimal: '.', thousands: ',', date: 'iso' });
  assert.ok(!Object.hasOwn(V0.parse_top({ as_of: AS_OF, balance: '10', buffer: '', horizon: '60' }, { cur: 'EUR', lang: 'ru' }).value, 'number_format'), 'без выбора ключа нет');
  // сборка рабочей области и проверка формы из файла
  let form = { ...V0.empty_form(AS_OF), horizon_days: 57, balance_minor: 400000, buffer_minor: 50000, purchase: { amount_minor: 123450, date: '2026-10-31' } };
  const add = (bucket, parse, t) => { const q = parse(t, { cur: 'EUR', lang: 'ru', as_of: AS_OF }); assert.equal(q.ok, true, JSON.stringify(q.error)); form = V0.add_item(form, bucket, q.value).form; };
  add('payments', V0.parse_payment, { name: 'Аренда', amount: '900', freq: 'M', date: '2026-10-25', weekend: 'next', kind: 'obligation' });
  add('payments', V0.parse_payment, { name: 'Связь', amount: '25', freq: 'M', date: '2026-10-09', weekend: 'next', kind: 'obligation' });
  add('payments', V0.parse_payment, { name: 'Продукты', amount: '100', freq: 'W', date: '2026-10-10', weekend: 'keep', kind: 'estimate' });
  add('incomes', V0.parse_income, { name: 'Выплата за часы', amount: '2790', freq: 'once', date: '2026-11-05', delay: '14' });
  form = { ...form, number_format: DOT_COMMA };
  assert.equal(V0.form_is_valid(form), true);
  assert.equal(V0.form_is_valid({ ...form, number_format: { decimal: ',', thousands: ',' } }), false);
  assert.equal(V0.form_is_valid({ ...form, number_format: 'dot_comma' }), false);
  assert.equal(V0.form_is_valid({ ...form, number_format: null }), true);
  const built = V0.form_to_ws(form);
  assert.equal(built.ok, true);
  assert.deepEqual(built.ws.number_format, DOT_COMMA);
  const ans = V0.purchase_answer(built.ws, { amount_minor: 123450, date: '2026-10-31' }, 'ru');
  assert.equal(ans.ok, true);
  assert.equal(ans.verified, true);
  assert.ok(ans.text.includes('1.234,50'), ans.text);
  assert.ok(!Object.hasOwn(ans.view, 'fx_note'), 'в одной валюте примечания о курсе нет');
  const plain_ans = V0.purchase_answer(V0.form_to_ws({ ...form, number_format: undefined }).ws, { amount_minor: 123450, date: '2026-10-31' }, 'ru');
  assert.ok(plain(plain_ans.text).includes('1 234,50'), plain_ans.text);
  // файл состояния: настройка сохраняется и читается
  const saved = V0.state_text(built.ws);
  const back = V0.read_state(saved);
  assert.equal(back.ok, true);
  assert.equal(back.kind, 'v0');
  assert.deepEqual(back.form.number_format, DOT_COMMA);
});

test('REQ-112 страница v0 на экране: выбор формата чисел и дат, суммы в списках и ответе — в выбранном формате; чужой файл с number_format открывается в нём', () => {
  const page = V0.boot_v0();
  const root = () => byid.get('main');
  const set = (id, v) => { const n = field(id); assert.ok(n !== undefined, 'нет поля ' + id); n.value = v; };
  const send = (id) => { const f = find_all(root(), (n) => n.attrs.id === id)[0]; assert.ok(f !== undefined, 'нет формы ' + id); return f.listeners.submit[0]({ preventDefault() {} }); };
  const asof = page.form.as_of;
  set('v0-asof', asof); set('v0-balance', '4000'); set('v0-buffer', '500'); set('v0-horizon', '57');
  assert.ok(field('v0-numfmt') !== undefined && field('v0-datefmt') !== undefined, 'поля «Формат чисел» и «Формат дат»');
  assert.equal(field('v0-numfmt').value, 'auto');
  set('v0-numfmt', 'dot_comma'); set('v0-datefmt', 'dmy');
  assert.equal(send('v0-form-top').ok, true);
  assert.deepEqual(page.form.number_format, { decimal: ',', thousands: '.', date: 'dmy' });
  assert.match(field('v0-balance').value, /^4000$/, 'в поле ввода без групп тысяч, десятичный знак по формату');
  assert.equal(field('v0-numfmt').value, 'dot_comma');
  assert.equal(field('v0-datefmt').value, 'dmy');
  // платёж: сумма с группами тысяч по формату
  set('v0-pay-name', 'Аренда'); set('v0-pay-amount', '1.250,50'); set('v0-pay-date', asof);
  const added = send('v0-form-payments');
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.equal(page.form.payments[0].amount_minor, 125050);
  assert.match(plain(root().textContent), /Аренда[^]*1\.250,50 €/, 'строка списка в формате пользователя');
  // сброс на «по языку»: ключа в форме нет
  set('v0-numfmt', 'auto'); set('v0-datefmt', 'auto');
  assert.equal(send('v0-form-top').ok, true);
  assert.ok(!Object.hasOwn(page.form, 'number_format'));
  assert.match(plain(root().textContent), /1 250,50 €/);
  // чужой файл с number_format: результат в его формате
  const foreign = { ...JSON.parse(JSON.stringify(G)), number_format: DOT_COMMA };
  const rs = V0.read_state(JSON.stringify(foreign));
  assert.equal(rs.ok, true);
  assert.equal(rs.kind, 'foreign');
  page.foreign = rs.ws;
  page.purchase = { amount_minor: 123450, date: '2026-10-31' };
  page.changed();
  assert.match(root().textContent, /1\.234,50/, 'ответ по чужому файлу в формате файла');
  assert.ok(!/\d \d{3},\d{2} €/.test(root().textContent));
});

// ── статика: единый путь ────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-112 единый путь форматирования: жёсткий render_value / format_minor / Intl в demo остаётся только там, где есть запасной путь без настройки', () => {
  const files = fs.readdirSync(DEMO).filter((f) => f.endsWith('.mjs'));
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
  const direct = {};
  for (const f of files) {
    const src = strip(fs.readFileSync(path.join(DEMO, f), 'utf8'));
    assert.doesNotMatch(src, /Intl\.|toLocaleString|toLocaleDateString/, f + ': локаль браузера не используется');
    const n = (src.match(/render_value\(/g) ?? []).length;
    if (n > 0) direct[f] = n;
  }
  // разрешённые места: make_fmt приложения (язык по умолчанию, запасной путь), таблица доказательств (4 параметра), форматтеры number_format.mjs,
  // запасные ветки money_text/date_text (entry, import_wizard) и make_v0_fmt
  assert.deepEqual(Object.keys(direct).sort(), ['app.mjs', 'entry.mjs', 'import_wizard.mjs', 'number_format.mjs', 'v0.mjs']);
  const app = strip(fs.readFileSync(path.join(DEMO, 'app.mjs'), 'utf8'));
  assert.match(app, /render_value\(e, S\.lang, S\.model\.as_of_iso, S\.ws\?\.number_format\)/, 'таблица доказательств');
  assert.equal((app.match(/a0_answer\(/g) ?? []).length, 2);
  assert.equal((app.match(/a0_answer\([^;]*number_format: model\.ws\.number_format/g) ?? []).length, 2, 'оба вызова A0 передают формат пользователя');
  const v0 = strip(fs.readFileSync(path.join(DEMO, 'v0.mjs'), 'utf8'));
  assert.match(v0, /a0_answer\([^;]*number_format: ws\.number_format/);
  for (const f of ['report.mjs', 'wizard.mjs', 'store_mode.mjs', 'home_cards.mjs', 'reconcile.mjs']) {
    const s = strip(fs.readFileSync(path.join(DEMO, f), 'utf8'));
    assert.doesNotMatch(s, /render_value\(|make_fmt\(|format_minor\(/, f);
  }
});
