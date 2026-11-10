// assistant_ext.test.mjs — FP-20: ассистент A0. Покрывает REQ-104 («почему» у ответа ассистента), REQ-132 (чип происхождения: режим, версия движка, дата узкой точки,
// hash_short; в A0 нет пометки «ответ ИИ»; клик по чипу Q3), REQ-136 (запись `assistant.call` только с хэшами, CSV журнала вызовов), интенты «что изменилось с <даты>»,
// «а если сдвинуть платёж», «что с резервом» (отдельная таблица в verifier.mjs; ответ проходит верификатор), TST-47, TST-56, TST-59.
// Часть 1 — чистые функции (таблица намерений, порты `ask_a0`, модели чипа и «почему»); часть 2 — настоящий app.mjs на заглушке DOM (как readonly_boot.test.mjs):
// пакет pack_fp20 подхвачен манифестом, чип на экранах «Купить» и «Ассистент», диалоги «Числа расчёта» и «Почему», журнал вызовов, CSV, примеры вопросов.
// Это отдельный файл, а не demo.test.mjs: demo.test.mjs импортирует app.mjs без DOM намеренно (глобальная заглушка запустила бы приложение во всех его проверках).
// Числа ожиданий — из канона design-brief §9.4, §9.6, §9.8, §9.14 ДОСЛОВНО (узкая точка «если хуже» 1 830,00 € · 14 ноября, Q3 635,00 € / 410,00 €, вклады 4147 / 2765 / 2304 bp,
// просадка 2 170,00 €); код пакета в ожиданиях не участвует. Браузер, сервер и сеть не используются.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(HERE, '..', 'demo');
const DATA = path.join(HERE, '..', 'data');

// ── заглушка DOM ────────────────────────────────────────────────────────────────────────────────────────────────────

class Node_ {
  constructor(tag, ns) {
    this.nodeType = 1; this.tagName = tag; this.ns = ns ?? null; this.attrs = {}; this.children = []; this.listeners = {}; this.className = '';
    this._text = ''; this._value = ''; this._sel = null; this.open = false; this.clicked = 0;
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
  click() { this.clicked += 1; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() {}
  querySelectorAll() { return []; }
  walk(fn) { fn(this); for (const c of this.children) if (c.nodeType === 1) c.walk(fn); }
}
const byid = new Map();
for (const id of ['app-title', 'app-sub', 'skip', 'controls', 'nav', 'summary', 'main', 'footer', 'live', 'dlg', 'dlg-title', 'dlg-close', 'dlg-body']) byid.set(id, new Node_(id === 'dlg' ? 'dialog' : 'div'));
const listeners = {};
/** Узел по атрибуту id среди созданных страницей (основная область и диалог): поле вопроса `as-q` и другие. */
function by_attr_id(id) {
  let hit = null;
  for (const root of [byid.get('main'), byid.get('dlg-body')]) root.walk((n) => { if (hit === null && n.attrs.id === id) hit = n; });
  return hit;
}
globalThis.document = {
  createElement: (t) => new Node_(t),
  createElementNS: (ns, t) => new Node_(t, ns),
  createTextNode: (data) => ({ nodeType: 3, data }),
  getElementById: (id) => byid.get(id) ?? by_attr_id(id),
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

const imp = (...p) => import(pathToFileURL(path.join(...p)).href);
const { ext } = await imp(DEMO, 'ext.mjs');
const APP = await imp(DEMO, 'app.mjs'); // getElementById('app-title') !== null → boot() запускается сам
await new Promise((r) => setTimeout(r, 600)); // boot асинхронный: манифест пакетов, набор данных, boot-хуки

const E = await imp(HERE, '..', 'engine', 'index.mjs');
const V = await imp(HERE, '..', 'engine', 'verifier.mjs');
const T = await imp(HERE, '..', 'engine', 'tools.mjs');
const CL = await imp(HERE, '..', 'engine', 'call_log.mjs');
const AX = await imp(DEMO, 'assistant_ext.mjs');
const PACK = await imp(DEMO, 'pack_fp20.mjs');
const I18N = await imp(DEMO, 'i18n.mjs');
const EXT = await imp(DEMO, 'ext.mjs');
const { ws_to_events, sync_journal } = await imp(DEMO, 'ws_bridge.mjs');
const { create_journal, ports_from_gen } = await imp(DEMO, 'journal_log.mjs');
const { make_id_gen, seeded_ports } = await imp(DEMO, 'ids.mjs');

const read_json = (...p) => JSON.parse(fs.readFileSync(path.join(...p), 'utf8'));
const G = read_json(DATA, 'g001.json');
const LOW = read_json(DATA, 'g001-low.json');
const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const TV1 = { date: '2026-10-12', amount_minor: 30000, currency: 'EUR' };
const TV1_CANON = '{"amount_minor":30000,"currency":"EUR","date":"2026-10-12"}';
const norm = (s) => s.replace(/[\u00a0\u202f\u2009]/g, ' ');

const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const text_of = (node) => norm(node.textContent);
const main_text = () => text_of(byid.get('main'));
const dlg_text = () => norm(byid.get('dlg-title').textContent + ' ' + byid.get('dlg-body').textContent);
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const field = (id) => find_all(byid.get('main'), (n) => n.attrs.id === id)[0];
const ask = (q) => {
  field('as-q').value = q;
  find_all(byid.get('main'), (n) => n.tagName === 'form' && /ask/.test(n.className))[0].listeners.submit[0]({ preventDefault() {} });
};
const buttons = (root, pred) => find_all(root, (n) => n.tagName === 'button' && pred(n));

/** Поддельный ctx: экраны рисуются для любой рабочей области и языка без настоящего приложения (EN, чужие наборы данных). */
function mk_ctx(ws, lang = 'ru', extra = {}) {
  const model = ws === null ? null : APP.build_model(ws);
  return {
    get_ws: () => ws, get_model: () => model, tr: (key, params) => I18N.t(lang, key, params), lang: () => lang, mode: () => 'worse',
    fmt: () => APP.make_fmt(lang, ws === null ? 'EUR' : model.cur, ws === null ? '2026-10-04' : model.as_of_iso), notify: () => {}, ...extra,
  };
}

/** Результат инструмента на модели (счётчик вызовов сбрасывается). */
function run(model, name, args) {
  model.ctx.calls_used = 0;
  return T.run_tool(name, args, model.ctx);
}

/** Страничный журнал на ws: как у реестра расширений (записи из `ws_to_events`, идентификаторы и время — детерминированные порты). */
function page_journal(ws) {
  return create_journal({ events: ws_to_events(ws), ports: ports_from_gen(make_id_gen(seeded_ports({ start_ms: Date.UTC(2026, 9, 5, 10, 0, 0), step_ms: 1000 }))) }); // часы журнала — 5 октября 2026, после записей набора (4 октября)
}

const MG = APP.build_model(G);
const INCOME = APP.first_income_ref(MG);
const INFO = { as_of: G.as_of, horizon_end: '2026-11-30', currency: 'EUR', income_ref: INCOME };

// ══ часть 1. Таблица намерений в verifier.mjs ══════════════════════════════════════════════════════════════════════════

test('FP-20 таблица намерений: EXT_INTENTS и EXT_COMMANDS — отдельные замороженные таблицы; три намерения → инструменты реестра; число инструментов не изменилось', () => {
  assert.ok(Object.isFrozen(V.EXT_INTENTS) && Object.isFrozen(V.EXT_COMMANDS));
  assert.deepEqual(V.EXT_INTENTS.map((x) => [x.id, x.tool]), [['changed', 'what_changed'], ['shift', 'run_scenario'], ['reserve', 'get_tax_envelope']]);
  for (const it of V.EXT_INTENTS) {
    assert.ok(Object.isFrozen(it), it.id);
    assert.ok(T.TOOL_NAMES.includes(it.tool), it.id + ': инструмент из реестра');
    assert.equal(typeof it.build, 'function');
  }
  assert.equal(T.TOOL_NAMES.length, 10, 'реестр по-прежнему из десяти инструментов');
  assert.deepEqual(Object.keys(V.EXT_COMMANDS), ['what-changed', 'shift', 'reserve']);
});

test('FP-20 parse_command: слова новых намерений идут из отдельной таблицы; прежние слова и отказы не изменились', () => {
  assert.deepEqual(V.parse_command(['what-changed', '2026-10-01']), { name: 'what_changed', args: { since: '2026-10-01' } });
  assert.deepEqual(V.parse_command(['what-changed', 'c_131fba11']).args, { since: 'c_131fba11' });
  assert.deepEqual(V.parse_command(['shift', 'S-HOURLY@2026-11-05', '10']), { name: 'run_scenario', args: { ops: [{ op: 'delay_income', event_ref: 'S-HOURLY@2026-11-05', days: 10 }] } });
  assert.deepEqual(V.parse_command(['reserve']), { name: 'get_tax_envelope', args: {} });
  assert.deepEqual(V.parse_command(['reserve', '2026-11-30', '--mode', 'plan']), { name: 'get_tax_envelope', args: { as_of: '2026-11-30', mode: 'plan' } });
  // без аргумента ключа нет — инструмент ответит E_SCHEMA, а не получит undefined
  assert.deepEqual(V.parse_command(['what-changed']).args, {});
  // прежние слова
  assert.deepEqual(V.parse_command(['changed', '2026-10-01']), { name: 'what_changed', args: { since: '2026-10-01' } });
  assert.deepEqual(V.parse_command(['scenario', 'delay', 'S-HOURLY@2026-11-05', '14']).args.ops, [{ op: 'delay_income', event_ref: 'S-HOURLY@2026-11-05', days: 14 }]);
  assert.deepEqual(V.parse_command(['tax']), { name: 'get_tax_envelope', args: {} });
  for (const bad of [[], ['что-то'], ['scenario'], ['propose', 'x'], ['constructor'], ['__proto__'], ['hasOwnProperty']]) assert.throws(() => V.parse_command(bad), (e) => e.code === 'E_SCHEMA', JSON.stringify(bad));
  // новое слово доходит до ответа A0 и проходит верификатор
  const ctx = T.make_tool_ctx(G, { as_of: G.as_of }, { locale: 'ru', journal: ws_to_events(G) });
  const a = V.a0_answer(['what-changed', '2026-10-01'], ctx, { locale: 'ru' });
  assert.equal(a.ok, true);
  assert.equal(a.verified, true);
  assert.match(a.text, /^Изменено записей: 40 \(с 1 октября\)/);
});

test('FP-20 parse_ext_intent «что изменилось»: дата вопроса, «вчера», «за неделю», «за месяц», «с прошлого раза»; будущая дата с годом и вопрос без основания — отказ no_since', () => {
  const p = (q, over = {}) => V.parse_ext_intent(q, { as_of: '2026-10-04', income_ref: INCOME, ...over });
  const since = (r) => r.command.args.since;
  assert.deepEqual(p('что изменилось с', { date: '2026-10-01' }), { ok: true, command: { name: 'what_changed', args: { since: '2026-10-01' } }, intent: 'changed' });
  assert.equal(since(p('what changed since', { date: '2026-10-01' })), '2026-10-01');
  assert.equal(since(p('что изменилось с', { date: '2026-10-04' })), '2026-10-04', 'с сегодняшнего дня');
  // «20 октября» при дне расчёта 4 октября — без года: ближайшее прошедшее, то есть прошлогоднее
  assert.equal(since(p('что изменилось с', { date: '2026-10-20' })), '2025-10-20');
  assert.equal(since(p('что изменилось с', { date: '2027-10-01' })), '2026-10-01', 'прежний разбор переносит прошедшую дату на следующий год — основание возвращается назад');
  // дата с годом из будущего — основания нет
  assert.deepEqual(p('что изменилось с', { date: '2027-01-01', date_explicit: true }), { ok: false, reason: 'no_since' });
  assert.equal(since(p('что изменилось вчера')), '2026-10-03');
  assert.equal(since(p('что изменилось за неделю')), '2026-09-27');
  assert.equal(since(p('что изменилось за последнюю неделю')), '2026-09-27');
  assert.equal(since(p('what changed in the last week')), '2026-09-27');
  assert.equal(since(p('что изменилось за месяц')), '2026-09-04');
  assert.equal(since(p('что изменилось с прошлого раза', { last_call: '131fba11' })), 'c_131fba11');
  assert.equal(since(p('what changed since last time', { last_call: '131fba11' })), 'c_131fba11');
  assert.deepEqual(p('что изменилось с прошлого раза'), { ok: false, reason: 'no_since' }, 'вызовов ещё не было');
  assert.deepEqual(p('что изменилось с прошлого раза', { last_call: 'не hex' }), { ok: false, reason: 'no_since' });
  assert.deepEqual(p('что изменилось'), { ok: false, reason: 'no_since' }, 'без основания по умолчанию ничего не подставляется');
  assert.deepEqual(p('что изменилось', { as_of: undefined, date: '2026-10-01' }), { ok: false, reason: 'no_since' }, 'нет дня расчёта — нет и основания');
});

test('FP-20 parse_ext_intent «а если сдвинуть платёж»: сдвиг ожидаемого поступления (delay_income); срок в днях и неделях; свой платёж, дата без срока и отсутствие поступления — отдельные отказы', () => {
  const p = (q, over = {}) => V.parse_ext_intent(q, { as_of: '2026-10-04', income_ref: INCOME, ...over });
  const op = (r) => r.command.args.ops[0];
  // допущение (исправление FP-20): разбор несёт ключ шаблона, который называет срок и «ближайшее ожидаемое поступление»; срок по умолчанию помечен отдельным ключом
  assert.deepEqual(p('а если сдвинуть платеж на 10 дней'), { ok: true, command: { name: 'run_scenario', args: { ops: [{ op: 'delay_income', event_ref: INCOME, days: 10 }] } }, intent: 'shift', notes: ['SHIFT.NOTE'] });
  assert.deepEqual(p('а если сдвинуть платеж').notes, ['SHIFT.NOTE_DEFAULT']);
  assert.equal(op(p('а если сдвинуть платеж')).days, 14, 'без срока — 14 дней, как у прежнего «если клиент заплатит позже»');
  assert.equal(op(p('что если перенести выплату на 2 недели')).days, 14);
  assert.equal(op(p('отодвинуть поступление на неделю')).days, 7);
  assert.equal(op(p('what if we shift the payment by 10 days')).days, 10);
  assert.equal(op(p('what if the payout is pushed back 3 weeks')).days, 21);
  assert.equal(op(p('что если сдвинуть платеж на 30 дн')).event_ref, INCOME);
  assert.deepEqual(p('а если сдвинуть платеж на 10 дней', { income_ref: null }), { ok: false, reason: 'no_income' });
  assert.deepEqual(p('а если сдвинуть платеж', { income_ref: undefined }), { ok: false, reason: 'no_income' });
  assert.deepEqual(p('а если сдвинуть платеж аренды на 5 дней'), { ok: false, reason: 'shift_unsupported' });
  assert.deepEqual(p('сдвинуть платеж по кредиту'), { ok: false, reason: 'shift_unsupported' });
  assert.deepEqual(p('what if we move the rent payment by 5 days'), { ok: false, reason: 'shift_unsupported' });
  assert.deepEqual(p('а если сдвинуть платеж на', { date: '2026-11-12' }), { ok: false, reason: 'shift_days' }, 'дата срока не задаёт');
  assert.equal(op(p('а если сдвинуть платеж на 10 дней', { date: '2026-11-12' })).days, 10, 'срок словами при наличии даты — действует');
});

test('FP-20 parse_ext_intent «что с резервом»: get_tax_envelope без аргументов; не относящиеся к новым намерениям вопросы — null (прежний разбор их не отдаёт таблице)', () => {
  const p = (q) => V.parse_ext_intent(q, { as_of: '2026-10-04', income_ref: INCOME });
  for (const q of ['что с резервом', 'как мой резерв', 'сколько в резервах', 'what about the reserve', 'my reserves']) {
    assert.deepEqual(p(q), { ok: true, command: { name: 'get_tax_envelope', args: {} }, intent: 'reserve' }, q);
  }
  for (const q of ['', 'нечто странное', 'налоговый конверт', 'почему узкая точка', 'какие волны платежей', 'можно ли купить', 'if the client pays 10 days later']) assert.equal(p(q), null, q || '(пусто)');
  assert.equal(V.parse_ext_intent(undefined, {}), null);
  assert.equal(V.parse_ext_intent('что с резервом').intent, 'reserve', 'info необязателен');
});

// ══ часть 1б. Разбор вопроса в демо: прежние намерения не изменились ═══════════════════════════════════════════════════════

test('FP-20 parse_assistant_command: все семь примеров вопросов (RU и EN) дают прежние команды; новые намерения опрашиваются только после них', () => {
  const ru = [
    ['можно ли купить за 300 € 12 октября', 'check_purchase', { date: '2026-10-12', amount_minor: 30000, currency: 'EUR' }, 'purchase'],
    ['сколько можно потратить 12 октября', 'max_purchase_amount', { date: '2026-10-12' }, 'max'],
    ['когда можно купить за 300 €', 'earliest_safe_date', { amount_minor: 30000, currency: 'EUR' }, 'earliest'],
    ['почему узкая точка', 'explain_min_point', {}, 'explain'],
    ['какие волны платежей', 'list_waves', { from: '2026-10-04', to: '2026-11-30' }, 'waves'],
    ['налоговый конверт', 'get_tax_envelope', {}, 'tax'],
    ['если клиент заплатит на 10 дней позже', 'run_scenario', { ops: [{ op: 'delay_income', event_ref: INCOME, days: 10 }] }, 'delay'],
  ];
  for (const [q, name, args, intent] of ru) assert.deepEqual(APP.parse_assistant_command(q, INFO), { ok: true, command: { name, args }, intent }, q);
  const en = [
    ['can I buy for €300 on October 12', 'check_purchase', 'purchase'], ['how much can I spend on October 12', 'max_purchase_amount', 'max'], ['when can I buy for €300', 'earliest_safe_date', 'earliest'],
    ['why the narrowest point', 'explain_min_point', 'explain'], ['which payment waves', 'list_waves', 'waves'], ['tax envelope', 'get_tax_envelope', 'tax'], ['if the client pays 10 days later', 'run_scenario', 'delay'],
  ];
  for (const [q, name, intent] of en) {
    const r = APP.parse_assistant_command(q, INFO);
    assert.deepEqual([r.ok, r.command.name, r.intent], [true, name, intent], q);
  }
  // прежний разбор побеждает там, где слова новых намерений встречаются внутри прежних вопросов
  assert.equal(APP.parse_assistant_command('почему такой резерв', INFO).intent, 'explain');
  assert.equal(APP.parse_assistant_command('что изменилось в прогнозе', INFO).intent, 'projection');
  assert.equal(APP.parse_assistant_command('если клиент заплатит на 10 дней позже и сдвинуть платёж', INFO).intent, 'delay');
  // отказы прежнего разбора — те же причины
  assert.deepEqual(APP.parse_assistant_command('', INFO), { ok: false, reason: 'empty' });
  assert.deepEqual(APP.parse_assistant_command('можно ли купить 31 февраля', INFO), { ok: false, reason: 'bad_date' });
  assert.deepEqual(APP.parse_assistant_command('можно ли купить', INFO), { ok: false, reason: 'no_amount' });
  assert.deepEqual(APP.parse_assistant_command('нечто странное', INFO), { ok: false, reason: 'unrecognized' });
});

test('FP-20 parse_assistant_command: «что изменилось с 1 октября», «а если сдвинуть платёж на 10 дней», «что с резервом» — RU и EN; год в дате учитывается', () => {
  const p = (q, info = INFO) => APP.parse_assistant_command(q, info);
  assert.deepEqual(p('что изменилось с 1 октября'), { ok: true, command: { name: 'what_changed', args: { since: '2026-10-01' } }, intent: 'changed' });
  assert.equal(p('Что изменилось с 2026-10-02?').command.args.since, '2026-10-02');
  assert.equal(p('что изменилось с 1 октября 2026').command.args.since, '2026-10-01');
  assert.deepEqual(p('что изменилось с 1 октября 2027'), { ok: false, reason: 'no_since' }, 'будущая дата с годом');
  assert.equal(p('что изменилось с 20 октября').command.args.since, '2025-10-20');
  assert.equal(p('что изменилось сегодня').command.args.since, '2026-10-04');
  assert.equal(p('what changed since October 1').command.args.since, '2026-10-01');
  assert.equal(p('что изменилось с 1 октября', { ...INFO, last_call: '131fba11' }).command.args.since, '2026-10-01', 'дата важнее «прошлого раза»');
  assert.equal(p('что изменилось с прошлого раза', { ...INFO, last_call: '131fba11' }).command.args.since, 'c_131fba11');
  assert.deepEqual(p('что изменилось'), { ok: false, reason: 'no_since' });
  assert.deepEqual(p('что изменилось с 31 февраля'), { ok: false, reason: 'bad_date' });
  assert.deepEqual(p('а если сдвинуть платёж на 10 дней'), { ok: true, command: { name: 'run_scenario', args: { ops: [{ op: 'delay_income', event_ref: INCOME, days: 10 }] } }, intent: 'shift', notes: ['SHIFT.NOTE'] });
  assert.equal(p('what if we shift the payment by 10 days').intent, 'shift');
  assert.deepEqual(p('а если сдвинуть платёж аренды на 5 дней'), { ok: false, reason: 'shift_unsupported' });
  assert.deepEqual(p('а если сдвинуть платёж на 12 ноября'), { ok: false, reason: 'shift_days' });
  assert.deepEqual(p('а если сдвинуть платёж на 10 дней', { ...INFO, income_ref: null }), { ok: false, reason: 'no_income' });
  assert.deepEqual(p('что с резервом'), { ok: true, command: { name: 'get_tax_envelope', args: {} }, intent: 'reserve' });
  assert.equal(p('what about the reserve').intent, 'reserve');
  // сквозной разбор (прежние правила опрашиваются первыми): таблица нового намерения прямо понимает «сколько в резерве», но в приложении это прежнее «сколько можно потратить»
  assert.equal(V.parse_ext_intent('сколько в резерве', { as_of: G.as_of }).intent, 'reserve');
  assert.equal(p('сколько в резерве').intent, 'max', 'прежнее «сколько» побеждает: прежние правила не менялись');
  assert.equal(p('как мой резерв').intent, 'reserve');
});

// ══ часть 1в. ask_a0 с портами: журнал страницы, запись вызовов ══════════════════════════════════════════════════════════

test('FP-20 «что изменилось с <даты>»: what_changed получает представление журнала страницы; основание раньше начала журнала — отказ no_history, а не «изменено 40 записей, был 0,00 €»; снимок открытия не считается изменением; ответ проходит верификатор; контекст после вызова прежний', () => {
  const journal = page_journal(G); // снимок открытия — 4 октября (день расчёта), часы журнала — 5 октября
  const ports = () => { const ev = journal.events(); return { journal: ev, call_log: CL.call_day_port(ev), last_call: CL.last_call_hex(ev) }; };
  const m = APP.build_model(G, { lang: 'ru' });
  assert.equal(m.ctx.journal, null);
  // до начала журнала сравнивать не с чем: причина и первый день журнала, инструмент не вызывался, числа не выдуманы
  for (const q of ['что изменилось с 1 октября', 'что изменилось вчера', 'что изменилось за неделю', 'что изменилось за месяц', 'изменения с 3 октября']) {
    assert.deepEqual(APP.ask_a0(m, q, 'ru', INCOME, ports()), { ok: false, reason: 'no_history', date: '2026-10-04' }, q);
  }
  assert.deepEqual(APP.ask_a0(m, 'what changed since October 1', 'en', INCOME, ports()), { ok: false, reason: 'no_history', date: '2026-10-04' });
  assert.equal(m.ctx.calls_used ?? 0, 0, 'отказ раньше вызова инструмента');
  // с начала дня снимка: снимок открытия — не изменение (раньше все 40 записей набора выдавались за изменённые)
  const same = APP.ask_a0(m, 'что изменилось с 4 октября', 'ru', INCOME, ports());
  assert.equal(same.ok, true, JSON.stringify(same));
  assert.equal(same.verified, true, 'ответ проходит верификатор');
  assert.match(norm(same.text), /^Изменено записей: 0 \(с 4 октября\)\. Минимум денег на счетах в режиме «если хуже» был 1 830,00 €, стал 1 830,00 €\./);
  assert.deepEqual([same.info.intent, same.info.history_start], ['changed', '2026-10-04']);
  assert.equal(APP.ask_a0(m, 'что изменилось сегодня', 'ru', INCOME, ports()).text, same.text, '«сегодня» — день расчёта');
  assert.match(same.ref, /^c_[0-9a-f]{8}$/);
  assert.equal(m.ctx.journal, null, 'журнал страницы нужен только этому вызову');
  assert.deepEqual(m.ctx.call_log, {});
  // EN
  const en = APP.ask_a0(m, 'what changed since October 4', 'en', INCOME, ports());
  assert.equal(en.verified, true);
  assert.match(en.text, /^Entries changed: 0 \(since October 4\)\./);
});

test('FP-20 «что изменилось»: без портов страницы (журнала нет) ассистент отвечает кодом ошибки инструмента, а не числами; сбой записи вызова ответ не ломает', () => {
  const m = APP.build_model(G, { lang: 'ru' });
  const none = APP.ask_a0(m, 'что изменилось с 1 октября', 'ru', INCOME);
  assert.deepEqual([none.ok, none.reason, none.tool], [false, 'tool_error', 'what_changed']);
  assert.match(none.text, /^Запрос не выполнен/);
  const journal = page_journal(G);
  const broken = APP.ask_a0(m, 'что изменилось с 4 октября', 'ru', INCOME, { journal: journal.events(), call_log: {}, record() { throw new Error('журнал недоступен'); } });
  assert.equal(broken.ok, true, 'запись вызова — побочное действие');
  assert.equal(broken.verified, true);
});

test('FP-20 «а если сдвинуть платёж» и «что с резервом»: те же инструменты и те же числа, что у прежних вопросов; ответы проходят верификатор; RU и EN', () => {
  const m = APP.build_model(G, { lang: 'ru' });
  const old_delay = APP.ask_a0(m, 'если клиент заплатит на 10 дней позже', 'ru', INCOME);
  const shift = APP.ask_a0(m, 'а если сдвинуть платёж на 10 дней', 'ru', INCOME);
  assert.equal(shift.ok, true);
  assert.equal(shift.verified, true);
  assert.equal(shift.tool, 'run_scenario');
  // тот же сценарий и те же числа, что у прежнего вопроса; к тексту дописано допущение (шаблон каталога, срок — из аргументов вызова), и ответ прошёл верификатор
  assert.equal(shift.text, old_delay.text + ' Допущение: сдвигается ближайшее ожидаемое поступление (не расход), на 10 дней.');
  assert.equal(shift.ref, old_delay.ref);
  const old_tax = APP.ask_a0(m, 'налоговый конверт', 'ru', INCOME);
  const reserve = APP.ask_a0(m, 'что с резервом', 'ru', INCOME);
  assert.equal(reserve.verified, true);
  assert.equal(reserve.tool, 'get_tax_envelope');
  assert.equal(reserve.text, old_tax.text);
  assert.match(reserve.text, /Расчёт по введённым правилам, не консультация\./);
  const en_shift = APP.ask_a0(m, 'what if we shift the payment by 10 days', 'en', INCOME);
  assert.equal(en_shift.verified, true);
  assert.equal(en_shift.ref, shift.ref);
  assert.equal(APP.ask_a0(m, 'what about the reserve', 'en', INCOME).verified, true);
  // отказы — причины, не числа
  assert.deepEqual(APP.ask_a0(m, 'а если сдвинуть платёж аренды на 5 дней', 'ru', INCOME), { ok: false, reason: 'shift_unsupported' });
  assert.deepEqual(APP.ask_a0(m, 'а если сдвинуть платёж на 10 дней', 'ru', null), { ok: false, reason: 'no_income' });
  assert.deepEqual(APP.ask_a0(m, 'что изменилось', 'ru', INCOME), { ok: false, reason: 'no_since' });
});

test('REQ-136 FP-20: каждый ответ ассистента пишет в журнал страницы assistant.call только с хэшами; текста вопроса и значений аргументов в журнале нет; ошибки инструмента и отказы разбора ничего не пишут', () => {
  const journal = page_journal(G);
  const recorded = [];
  const record = (result, args) => { recorded.push([result.call_id, args]); return CL.record_call(journal, result, args); };
  const m = APP.build_model(G, { lang: 'ru' });
  const before = journal.length;
  const q1 = 'можно ли купить за 300 € 12 октября';
  const a1 = APP.ask_a0(m, q1, 'ru', INCOME, { journal: journal.events(), call_log: {}, record });
  assert.equal(a1.ref, 'c_131fba11');
  assert.equal(journal.length, before + 1);
  const ev = journal.events().at(-1);
  assert.equal(ev.type, 'assistant.call');
  assert.equal(ev.actor, 'assistant:a0');
  assert.deepEqual(ev.payload, { call_id: '131fba11', tool: 'check_purchase', args_hash: sha(TV1_CANON), inputs_hash: a1.result.inputs_hash, engine_version: '0.1.0' });
  assert.ok(a1.result.inputs_hash.startsWith('fc9d650d'));
  const dump = JSON.stringify(ev);
  for (const raw of [q1, 'купить', '300', '12 октября', '2026-10-12', 'EUR', '30000']) assert.ok(!dump.includes(raw), `в записи нет «${raw}»`);
  // отказы разбора и ошибка инструмента — без записи
  APP.ask_a0(m, 'нечто странное', 'ru', INCOME, { journal: journal.events(), call_log: {}, record });
  APP.ask_a0(m, 'что изменилось', 'ru', INCOME, { journal: journal.events(), call_log: {}, record });
  APP.ask_a0(m, 'что изменилось с 1 октября', 'ru', INCOME, { journal: null, record });
  assert.equal(journal.length, before + 1, 'ничего лишнего не записано');
  assert.equal(recorded.length, 1);
  // следующий вопрос «с прошлого раза» опирается на порт, собранный из журнала
  const events = journal.events();
  const ports = { journal: events, call_log: CL.call_day_port(events), last_call: CL.last_call_hex(events), record };
  assert.equal(ports.last_call, '131fba11');
  const again = APP.ask_a0(m, 'что изменилось с прошлого раза', 'ru', INCOME, ports);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.verified, true);
  assert.match(again.text, /^Изменено записей: 0\./, 'с дня прошлого вызова изменений нет');
  assert.equal(journal.length, before + 2);
  // CSV: заголовок, две строки, только хэши
  const csv = CL.export_calls_csv(journal.events());
  assert.equal(csv.split('\n').length, 4);
  assert.ok(!csv.includes('купить') && !csv.includes('октября'));
});

// ══ часть 1г. Модели чипа и «почему» ═════════════════════════════════════════════════════════════════════════════════

test('REQ-132 answer_origin: режим, версия движка, дата узкой точки, hash_short и ссылка c_… ответа Q3 на G-001; пометки ИИ нет; изменившиеся данные не выдаются за прогноз ответа', () => {
  const r = run(MG, 'check_purchase', TV1);
  const ref = T.call_ref(r.call_id);
  const ctx = mk_ctx(G, 'ru');
  const om = AX.answer_origin(ctx, MG, r, ref);
  assert.deepEqual([om.mode, om.engine_version, om.hash_short, om.ref, om.ai, om.fresh], ['worse', '0.1.0', 'fc9d650d', 'c_131fba11', false, true]);
  assert.deepEqual(om.narrow, { date: '2026-11-14', amount_minor: 183000 }, 'канон §9.4: 1 830,00 € · 14 ноября (если хуже)');
  assert.deepEqual(om.rows.map((x) => x.value), ['check_purchase', '4 октября']);
  // режим по плану: результат с областью plan — узкая точка 2 055,00 € · 31 октября
  const rp = run(MG, 'explain_min_point', { mode: 'plan' });
  const op = AX.answer_origin(ctx, MG, rp, T.call_ref(rp.call_id));
  assert.deepEqual([op.mode, op.narrow], ['plan', { date: '2026-10-31', amount_minor: 205500 }]);
  // данные изменились после ответа: другой хэш входов, даты нет, строка «Данные» предупреждает
  const low = mk_ctx(LOW, 'ru');
  const stale = AX.answer_origin(low, low.get_model(), r, ref);
  assert.equal(stale.fresh, false);
  assert.equal(stale.narrow, null);
  assert.equal(stale.hash_short, 'fc9d650d', 'хэш — самого ответа');
  assert.ok(stale.rows.some((x) => x.value.includes('изменились после ответа')));
  assert.equal(AX.mode_of_result({ scope: { mode: 'plan' } }), 'plan');
  assert.equal(AX.mode_of_result({ scope: { mode: 'что-то' } }), 'worse');
  assert.equal(AX.is_result(r), true);
  for (const bad of [null, undefined, 'x', { isError: true, code: 'E_SCHEMA' }, { ...r, evidence: null }, { ...r, scope: null }, { ...r, call_id: 7 }]) assert.equal(AX.is_result(bad), false);
});

test('REQ-104 REQ-132 render_answer_chip (RU и EN): чип с режимом, версией, датой узкой точки и хэшем; кнопки «Числа расчёта» и «почему»; пометки «ответ ИИ» нет; без прогноза — null', () => {
  const r = run(MG, 'check_purchase', TV1);
  for (const lang of ['ru', 'en']) {
    const ctx = mk_ctx(G, lang);
    const f = ctx.fmt();
    const chip = AX.render_answer_chip(ctx, r, 'c_131fba11', () => {});
    assert.equal(chip.attrs['data-ref'], 'c_131fba11');
    const t = text_of(chip);
    assert.ok(t.includes(V.LABELS.modes[lang].worse), lang + ' режим');
    assert.ok(t.includes('0.1.0'), lang + ' версия движка');
    assert.ok(t.includes(norm(f.date('2026-11-14'))) && t.includes(norm(f.money(183000))), lang + ' дата и сумма узкой точки');
    assert.ok(t.includes('fc9d650d'), lang + ' hash_short');
    assert.ok(t.includes('c_131fba11'), lang + ' ссылка расчёта');
    assert.ok(!t.includes(I18N.t(lang, 'showcase.chip_ai')), lang + ': пометки «ответ ИИ» нет');
    assert.ok(!/ИИ|\bAI\b/.test(t), lang + ': и других отметок ИИ нет');
    assert.equal(find_all(chip, (n) => n.tagName === 'details' && n.className === 'sc-chip').length, 1, 'это render_origin_chip из FP-09');
    const btns = buttons(chip, () => true);
    assert.deepEqual(btns.map((b) => b.textContent), [I18N.t(lang, 'a0ext.btn_numbers'), I18N.t(lang, 'ov.why')]);
    assert.equal(btns[1].attrs['aria-label'], I18N.t(lang, 'a0ext.why_aria', { ref: 'c_131fba11' }), lang + ': у «почему» чипа есть имя с номером расчёта (рядом такие же кнопки у строк режимов)');
    assert.ok(btns.every((b) => b.attrs.type === 'button' && typeof b.listeners.click?.[0] === 'function'));
  }
  assert.equal(AX.render_answer_chip(mk_ctx(null, 'ru'), r, 'c_131fba11'), null, 'без прогноза — прежняя кнопка');
  assert.equal(AX.render_answer_chip(mk_ctx(G, 'ru'), { isError: true }, 'c_131fba11'), null);
  assert.equal(AX.render_answer_chip(mk_ctx(G, 'ru'), r, undefined), null);
});

test('REQ-104 «почему» у ответа: цепочка вкладов поверх narrowest_why — аренда 41,47 %, продукты 27,65 %, налог 23,04 %, «Остальное», сумма равна просадке 2 170,00 €; контрфакты; режим, версия, hash, c_…', () => {
  const r = run(MG, 'check_purchase', TV1);
  const m = AX.answer_why_model(MG, r);
  assert.equal(m.mode, 'worse');
  assert.equal(m.overlay, true, 'покупка — изменение поверх прогноза');
  assert.equal(m.fresh, true);
  assert.equal(m.why.drop_minor, 217000, 'канон REQ-104: просадка 217000');
  assert.equal(m.why.total_minor, 217000);
  assert.equal(m.why.ok, true);
  assert.deepEqual(m.why.rows.filter((x) => x.kind === 'group').slice(0, 3).map((x) => x.share_bp), [4147, 2765, 2304], 'аренда 4147 bp, продукты 2765 bp, налог 2304 bp');
  assert.ok(m.counterfactuals.length >= 3 && m.counterfactuals.length <= 5);
  assert.ok(m.counterfactuals.every((c) => c.kind === 'without' || c.kind === 'no_delay'));
  // диалог
  for (const lang of ['ru', 'en']) {
    const ctx = mk_ctx(G, lang);
    AX.open_answer_why(ctx, r, 'c_131fba11');
    const t = dlg_text();
    assert.equal(byid.get('dlg').open, true);
    assert.ok(t.includes(norm(ctx.fmt().money(183000))) && t.includes(norm(ctx.fmt().date('2026-11-14'))), lang + ' заголовок: узкая точка');
    assert.ok(t.includes(norm(ctx.fmt().bp(4147))) && t.includes(norm(ctx.fmt().bp(2765))) && t.includes(norm(ctx.fmt().bp(2304))), lang + ' доли вкладов');
    assert.ok(t.includes(norm(ctx.fmt().money(217000))), lang + ' просадка 2 170,00 €');
    assert.ok(t.includes('c_131fba11') && t.includes('0.1.0') && t.includes('fc9d650d'), lang + ' номер расчёта, версия, hash');
    assert.ok(t.includes(V.LABELS.modes[lang].worse), lang + ' режим');
    assert.ok(t.includes(I18N.t(lang, 'a0ext.why_overlay')), lang + ' пояснение про покупку');
    assert.ok(!t.includes(I18N.t(lang, 'a0ext.why_stale')), lang + ': данные не менялись');
    assert.ok(!/ответ ИИ|AI answer/.test(t), lang);
  }
  // данные изменились после ответа — предупреждение в диалоге
  AX.open_answer_why(mk_ctx(LOW, 'ru'), r, 'c_131fba11');
  assert.ok(dlg_text().includes(I18N.t('ru', 'a0ext.why_stale')));
  // инструмент без «поверх»: пояснения про покупку нет
  const ex = run(MG, 'explain_min_point', {});
  AX.open_answer_why(mk_ctx(G, 'ru'), ex, T.call_ref(ex.call_id));
  assert.ok(!dlg_text().includes(I18N.t('ru', 'a0ext.why_overlay')));
  assert.equal(AX.answer_why_model(MG, ex).overlay, false);
});

test('REQ-132 кнопка «Числа расчёта»: вызывает действие, которое дало приложение (таблицу evidence показывает оно); без действия кнопки нет', () => {
  const r = run(MG, 'check_purchase', TV1);
  let opened = 0;
  const chip = AX.render_answer_chip(mk_ctx(G, 'ru'), r, 'c_131fba11', () => { opened += 1; });
  const btn = buttons(chip, (n) => n.textContent === 'Числа расчёта')[0];
  assert.ok(btn !== undefined);
  assert.equal(btn.attrs.title, I18N.t('ru', 'c.chip_hint'));
  btn.listeners.click[0]();
  assert.equal(opened, 1);
  const bare = AX.render_answer_chip(mk_ctx(G, 'ru'), r, 'c_131fba11');
  assert.deepEqual(buttons(bare, () => true).map((x) => x.textContent), ['почему?'], 'без действия — только «почему»');
});

test('REQ-136 make_ports / calls_model / render_calls_card: порты строятся из журнала страницы, запись вызова перерисовывает карточку; карточка показывает хэши и скачивает CSV; без журнала порты — null', () => {
  assert.equal(AX.make_ports(mk_ctx(G, 'ru'), { paint: null }), null, 'у ctx нет журнала');
  assert.equal(AX.make_ports({ journal: null }, { paint: null }), null);
  assert.equal(AX.make_ports({ get journal() { throw new Error('нет'); } }, { paint: null }), null);
  const journal = page_journal(G);
  const view = { paint: null };
  const ctx = mk_ctx(G, 'ru', { journal, notify: () => {} });
  const card = AX.render_calls_card(ctx, view);
  assert.equal(typeof view.paint, 'function');
  assert.ok(text_of(card).includes('Вызовов пока не записано.'));
  const csv_btn = find_all(card, (n) => n.attrs.id === 'a0-calls-csv')[0];
  assert.ok(csv_btn.attrs.disabled !== undefined, 'нечего скачивать — кнопка отключена');
  const ports = AX.make_ports(ctx, view);
  assert.equal(ports.journal.length, journal.length);
  assert.deepEqual(ports.call_log, {});
  assert.equal(ports.last_call, null);
  const r = run(MG, 'check_purchase', TV1);
  const rec = ports.record(r, TV1);
  assert.equal(rec.ok, true);
  const t = text_of(card);
  assert.ok(t.includes('Записано вызовов: 1.'), t);
  assert.ok(t.includes('c_131fba11') && t.includes('check_purchase') && t.includes(sha(TV1_CANON).slice(0, 8)) && t.includes('fc9d650d') && t.includes('0.1.0'));
  assert.equal(csv_btn.attrs.disabled, undefined, 'после записи кнопка включена');
  assert.ok(!t.includes('купить'), 'текста вопроса в карточке нет');
  // режим «только чтение»: ответы и журнал для «что изменилось» есть, записи вызовов нет
  const ro = AX.make_ports({ ...ctx, read_only: () => Object.freeze({ newer_format: true }) }, view);
  assert.equal(ro.record, undefined);
  assert.equal(ro.journal.length, journal.length);
  assert.equal(AX.make_ports({ ...ctx, read_only: () => null }, view).record !== undefined, true);
  const next = AX.make_ports(ctx, view);
  assert.deepEqual(next.call_log, { '131fba11': journal.events().at(-1).recorded_at.slice(0, 10) });
  assert.equal(next.last_call, '131fba11');
  // последние десять
  for (let i = 0; i < 12; i++) ports.record(run(MG, 'max_purchase_amount', { date: E.format_date(MG.ctx.as_of + i) }), { date: E.format_date(MG.ctx.as_of + i) });
  assert.ok(text_of(card).includes('Записано вызовов: 13.'));
  assert.equal(find_all(card, (n) => n.tagName === 'tr').length, 1 + AX.CALLS_SHOWN, 'в таблице заголовок и не больше десяти строк');
  assert.equal(AX.calls_model(journal.events()).csv.split('\n').length, 13 + 2, 'в CSV все тринадцать записей, заголовок и перевод строки');
  assert.deepEqual(AX.calls_model('не журнал'), { count: 0, rows: [], csv: CL.CALL_CSV_COLUMNS.join(',') + '\n' });
  assert.equal(AX.calls_file_name('2026-10-04'), 'runway-assistant-calls-2026-10-04.csv');
  assert.equal(AX.calls_file_name('вчера'), 'runway-assistant-calls-unknown.csv');
});

test('FP-20 примеры новых вопросов: дата подставляется первым днём журнала страницы (раньше — отказ no_history) в виде, который разбирает ассистент; RU и EN', () => {
  assert.deepEqual(AX.example_questions(mk_ctx(G, 'ru'), '2026-10-04'), ['что изменилось с 4 октября', 'а если сдвинуть платёж на 10 дней', 'что с резервом']);
  assert.deepEqual(AX.example_questions(mk_ctx(G, 'en'), '2026-10-04'), ['what changed since October 4', 'what if we shift the payment by 10 days', 'what about the reserve']);
  for (const [lang, qs] of [['ru', AX.example_questions(mk_ctx(G, 'ru'), '2026-10-04')], ['en', AX.example_questions(mk_ctx(G, 'en'), '2026-10-04')]]) {
    assert.deepEqual(qs.map((q) => APP.parse_assistant_command(q, INFO).intent), ['changed', 'shift', 'reserve'], lang + ': примеры разбираются');
  }
  assert.equal(AX.render_examples_card(mk_ctx(null, 'ru')), null);
});

// ══ часть 2. Настоящий app.mjs на заглушке DOM ═══════════════════════════════════════════════════════════════════════════

// ══ часть 1д. Исправления после независимой проверки FP-20 (дефекты high и medium, low) ═══════════════════════════════════════════

/** Журнал страницы с часами журнала, заданными в мс (снимок открытия по-прежнему стоит днём расчёта набора). */
function journal_on(ws, start_ms) {
  return create_journal({ events: ws_to_events(ws), ports: ports_from_gen(make_id_gen(seeded_ports({ start_ms, step_ms: 1000 }))) });
}
const ports_from = (journal, record) => { const ev = journal.events(); return { journal: ev, call_log: CL.call_day_port(ev), last_call: CL.last_call_hex(ev), record }; };
const OCT4_10H = Date.UTC(2026, 9, 4, 10, 0, 0);

test('FP-20 исправление (high): «что изменилось» не выдаёт снимок открытия за изменения — ни «40 записей», ни «был 0,00 €»: до начала журнала отказ, с его начала только настоящие правки (RU и EN)', () => {
  const journal = journal_on(G, OCT4_10H);
  const m = APP.build_model(G, { lang: 'ru' });
  for (const [q, lang] of [['что изменилось с 1 октября', 'ru'], ['что изменилось вчера', 'ru'], ['что изменилось за неделю', 'ru'], ['что изменилось за месяц', 'ru'], ['what changed since October 1', 'en'], ['what changed yesterday', 'en']]) {
    const r = APP.ask_a0(m, q, lang, INCOME, ports_from(journal));
    assert.deepEqual([r.ok, r.reason, r.date], [false, 'no_history', '2026-10-04'], q);
    assert.equal(r.text, undefined, 'числа в отказе не называются');
  }
  const ok = APP.ask_a0(m, 'что изменилось с 4 октября', 'ru', INCOME, ports_from(journal));
  assert.ok(!/был 0,00 €/.test(norm(ok.text)) && !/Изменено записей: 40/.test(norm(ok.text)), norm(ok.text));
  assert.match(norm(ok.text), /^Изменено записей: 0 \(с 4 октября\)/);
  // после настоящей правки — одна запись (параметры), а не весь набор
  const edited = JSON.parse(JSON.stringify(G));
  edited.params = { ...edited.params, buffer_minor: 60000 };
  sync_journal(journal, G, edited);
  const after = APP.ask_a0(APP.build_model(edited, { lang: 'ru' }), 'что изменилось с 4 октября', 'ru', INCOME, ports_from(journal));
  assert.match(norm(after.text), /^Изменено записей: 1 \(с 4 октября\)\./);
  assert.match(after.text, /параметры: 1\./);
  assert.equal(after.verified, true);
});

test('FP-20 исправление (medium): правки того же дня не теряются — «что изменилось сегодня» и «с прошлого раза» видят правку, внесённую после вызова в тот же день; второй вопрос «с прошлого раза» уже не видит её', () => {
  const journal = journal_on(G, OCT4_10H);
  const record = (r, a) => CL.record_call(journal, r, a);
  const m0 = APP.build_model(G, { lang: 'ru' });
  assert.equal(APP.ask_a0(m0, 'сколько можно потратить 12 октября', 'ru', INCOME, ports_from(journal, record)).ok, true);
  const edited = JSON.parse(JSON.stringify(G));
  edited.params = { ...edited.params, buffer_minor: 60000 };
  sync_journal(journal, G, edited);
  const m1 = APP.build_model(edited, { lang: 'ru' });
  const since_last = APP.ask_a0(m1, 'что изменилось с прошлого раза', 'ru', INCOME, ports_from(journal, record));
  assert.match(norm(since_last.text), /^Изменено записей: 1\./, norm(since_last.text));
  assert.match(since_last.text, /параметры: 1\./);
  assert.equal(since_last.verified, true);
  const today = APP.ask_a0(m1, 'что изменилось сегодня', 'ru', INCOME, ports_from(journal, record));
  assert.match(norm(today.text), /^Изменено записей: 1 \(с 4 октября\)/);
  assert.match(today.text, /параметры: 1\./);
  // каждый вопрос записал вызов: «с прошлого раза» теперь отсчитывается от последнего из них, новых правок нет
  const again = APP.ask_a0(m1, 'что изменилось с прошлого раза', 'ru', INCOME, ports_from(journal, record));
  assert.match(norm(again.text), /^Изменено записей: 0\./);
  // правка, внесённая ПОСЛЕ последнего вызова, снова видна
  const edited2 = JSON.parse(JSON.stringify(edited));
  edited2.params = { ...edited2.params, buffer_minor: 70000 };
  sync_journal(journal, edited, edited2);
  assert.match(norm(APP.ask_a0(APP.build_model(edited2, { lang: 'ru' }), 'what changed since last time', 'en', INCOME, ports_from(journal, record)).text), /^Entries changed: 1\./);
});

test('FP-20 исправление (medium): платёж с уточнением (ипотека, квартира, страховка, садик, «ипотечный», mortgage…) — отказ shift_unsupported, а не молчаливый сдвиг поступления; общий «платёж», «ближайший платёж» и слова о поступлении — сдвиг', () => {
  const p = (q, over = {}) => V.parse_ext_intent(q, { as_of: '2026-10-04', income_ref: INCOME, ...over });
  const refused = [
    'а если сдвинуть платёж по ипотеке на 10 дней', 'сдвинуть платёж за квартиру на 5 дней', 'а если перенести платёж по страховке', 'платёж за садик сдвинуть на неделю', 'сдвинуть ипотечный платёж на 10 дней',
    'сдвинуть ежемесячный платёж', 'what if I move my mortgage payment by 10 days', 'what if we shift the insurance payment by 5 days', 'shift the kindergarten payment', 'move the payments to the landlord',
    'а если сдвинуть платёж аренды на 5 дней', 'сдвинуть платёж по кредиту', 'what if we move the rent payment by 5 days',
  ];
  for (const q of refused) assert.deepEqual(p(q), { ok: false, reason: 'shift_unsupported' }, q);
  const allowed = [
    ['а если сдвинуть платёж', 14, 'SHIFT.NOTE_DEFAULT'], ['а если сдвинуть платёж на 10 дней', 10, 'SHIFT.NOTE'], ['сдвинуть ближайший платёж на неделю', 7, 'SHIFT.NOTE'], ['сдвинуть следующий платёж на 3 дня', 3, 'SHIFT.NOTE'],
    ['а если сдвинуть платёж по счёту клиента на 5 дней', 5, 'SHIFT.NOTE'], ['сдвинуть выплату от заказчика на 2 недели', 14, 'SHIFT.NOTE'], ['сдвинуть поступление на 10 дней', 10, 'SHIFT.NOTE'], ['сдвинуть поступление', 14, 'SHIFT.NOTE_DEFAULT'],
    ['а если сдвинуть платёж по плану на 10 дней', 10, 'SHIFT.NOTE'],
    ['what if we shift the payment by 10 days', 10, 'SHIFT.NOTE'], ['what if we shift the next payment by a week', 7, 'SHIFT.NOTE'], ['shift the expected receipt by 4 days', 4, 'SHIFT.NOTE'], ['what if we shift the payment', 14, 'SHIFT.NOTE_DEFAULT'],
  ];
  for (const [q, days, note] of allowed) {
    const r = p(q);
    assert.equal(r.ok, true, q);
    assert.equal(r.command.args.ops[0].days, days, q);
    assert.deepEqual(r.notes, [note], q);
  }
});

test('FP-20 исправление (medium): ответ на «сдвинуть платёж» называет допущение шаблоном каталога — сдвигается ближайшее ожидаемое поступление (не расход) на N дней; срок — из аргументов вызова, а не параметр режима «если хуже»; срок по умолчанию помечен; ответ сверен верификатором; RU и EN', () => {
  const m = APP.build_model(G, { lang: 'ru' });
  const ask_ = (q, lang) => { m.ctx.calls_used = 0; return APP.ask_a0(m, q, lang, INCOME, null); };
  const old_text = (days) => ask_('если клиент заплатит на ' + days + ' дней позже', 'ru').text; // прежний вопрос — текст без допущения
  for (const [q, days, tail] of [
    ['а если сдвинуть платёж на 10 дней', 10, 'Допущение: сдвигается ближайшее ожидаемое поступление (не расход), на 10 дней.'],
    ['а если сдвинуть платёж на неделю', 7, 'Допущение: сдвигается ближайшее ожидаемое поступление (не расход), на 7 дней.'],
    ['а если сдвинуть платёж на 21 день', 21, 'Допущение: сдвигается ближайшее ожидаемое поступление (не расход), на 21 день.'],
    ['а если сдвинуть платёж', 14, 'Допущение: в вопросе нет срока, взяты 14 дней (срок по умолчанию); сдвигается ближайшее ожидаемое поступление (не расход).'],
  ]) {
    const head = old_text(days);
    const r = ask_(q, 'ru');
    assert.equal(r.ok, true, q);
    assert.equal(r.verified, true, 'ответ с допущением проходит верификатор: ' + q);
    assert.ok(norm(r.text).endsWith(tail), q + ' → ' + norm(r.text));
    assert.equal(norm(r.text).slice(0, norm(head).length), norm(head), 'числа сценария — те же, что у прежнего вопроса');
  }
  const en = ask_('what if we shift the payment by 10 days', 'en');
  assert.equal(en.verified, true);
  assert.ok(en.text.endsWith('Assumption: the nearest expected receipt (not a payment out) is shifted, by 10 days.'), en.text);
  const en_def = ask_('what if we shift the payment', 'en');
  assert.ok(en_def.text.endsWith('Assumption: the question gives no period, 14 days is used (the default); the nearest expected receipt (not a payment out) is shifted.'), en_def.text);
  // прежний вопрос «если клиент заплатит позже» допущения не получает (прежние намерения не менялись)
  assert.ok(!old_text(10).includes('Допущение'));
});

test('FP-20 исправление (medium): допущение проверяет верификатор — срок берётся из эхо q.shift_days (аргументы вызова); без эхо шаблон не разрешается; ключ вне EXT_NOTES — E_SCHEMA; ключи есть в обоих каталогах', () => {
  assert.ok(Object.isFrozen(V.EXT_NOTES));
  assert.deepEqual([...V.EXT_NOTES], ['SHIFT.NOTE', 'SHIFT.NOTE_DEFAULT']);
  for (const loc of ['ru', 'en']) for (const k of V.EXT_NOTES) assert.equal(typeof V.templates(loc)[k], 'string', loc + ' ' + k);
  const cmd = ['shift', INCOME, '10'];
  const ctx = APP.build_model(G, { lang: 'ru' }).ctx;
  ctx.calls_used = 0;
  const a = V.a0_answer(cmd, ctx, { locale: 'ru', notes: ['SHIFT.NOTE'] });
  assert.equal(a.verified, true);
  assert.ok(a.echo.some((e) => e.id === 'q.shift_days' && e.kind === 'days' && e.v === 10), 'эхо срока: 10 дней, а не параметр режима «если хуже» (q.days = 14)');
  assert.ok(a.echo.some((e) => e.id === 'q.days' && e.v === 14));
  // подделка: убрали эхо — шаблон допущения не разрешается, ответ не проходит
  const v = V.verify_answer(a.answer, [a.result], { echo: a.echo.filter((e) => e.id !== 'q.shift_days'), locale: 'ru' });
  assert.equal(v.ok, false);
  ctx.calls_used = 0;
  assert.throws(() => V.a0_answer(cmd, ctx, { locale: 'ru', notes: ['SCENARIO.OK'] }), (e) => e.code === 'E_SCHEMA');
  ctx.calls_used = 0;
  assert.throws(() => V.a0_answer(cmd, ctx, { locale: 'ru', notes: ['EVIL'] }), (e) => e.code === 'E_SCHEMA');
  // без notes ответ прежний
  ctx.calls_used = 0;
  assert.ok(!V.a0_answer(cmd, ctx, { locale: 'ru' }).text.includes('Допущение'));
});

test('FP-20 исправление (low): «изменения с/за/после …» без слова «какие» — тоже «что изменилось» (граница слова у кириллицы); слово на «с…» предлогом не считается', () => {
  for (const [q, since] of [['изменения с 1 октября', '2026-10-01'], ['изменения после 2 октября', '2026-10-02'], ['изменения за неделю', '2026-09-27'], ['Изменения с 2026-10-02', '2026-10-02']]) {
    const r = APP.parse_assistant_command(q, INFO);
    assert.equal(r.ok, true, q + ' → ' + JSON.stringify(r));
    assert.equal(r.intent, 'changed', q);
    assert.equal(r.command.args.since, since, q);
  }
  assert.equal(V.parse_ext_intent('изменения совсем другие', { as_of: '2026-10-04' }), null);
  assert.equal(V.parse_ext_intent('изменения', { as_of: '2026-10-04' }), null);
});

test('FP-20 исправление (low): дата без года, ушедшая на прошлый год, называется в пояснении; дата этого года и дата с годом — нет; пояснения answer_notes (RU и EN)', () => {
  const p = (q) => APP.parse_assistant_command(q, INFO);
  assert.deepEqual(p('что изменилось с 20 октября').assumed, { year_rolled: true });
  assert.equal(p('что изменилось с 1 октября').assumed, undefined);
  assert.equal(p('что изменилось с 1 октября 2025').assumed, undefined);
  const ru = mk_ctx(G, 'ru');
  const shift = { intent: 'shift', command: { name: 'run_scenario', args: { ops: [{ op: 'delay_income', event_ref: INCOME, days: 10 }] } } };
  assert.deepEqual(AX.answer_notes(ru, shift), ['Сдвигается поступление «Выплата за часы», 5 ноября.']);
  assert.deepEqual(AX.answer_notes(mk_ctx(G, 'en'), shift), ['The receipt shifted is “Hourly-work payout”, November 5.']);
  const changed = { intent: 'changed', command: { name: 'what_changed', args: { since: '2025-10-20' } }, assumed: { year_rolled: true }, history_start: '2026-10-04' };
  assert.deepEqual(AX.answer_notes(ru, changed).map(norm), ['Сравнение идёт по журналу этой страницы: он начинается 4 октября, правки до открытия набора данных в нём не видны.', 'В вопросе нет года: основанием взято 20 окт 2025.']);
  assert.deepEqual(AX.answer_notes(ru, { ...changed, assumed: null, command: { args: { since: 'c_131fba11' } } }).map(norm), ['Сравнение идёт по журналу этой страницы: он начинается 4 октября, правки до открытия набора данных в нём не видны.']);
  // нет данных для пояснения — пустой список, а не исключение
  for (const bad of [null, undefined, 5, {}, { intent: 'reserve' }, { intent: 'shift', command: { args: { ops: [{ event_ref: 'нет@2026-01-01' }] } } }]) assert.deepEqual(AX.answer_notes(ru, bad), []);
  assert.deepEqual(AX.answer_notes(mk_ctx(null, 'ru'), shift), []);
});

test('FP-20 исправление: карточка «Новые вопросы» берёт дату первого примера из начала журнала страницы (более ранняя дата — отказ no_history), без журнала — из дня расчёта; пример даёт ответ с числами', () => {
  const early = create_journal({ events: ws_to_events(G, { recorded_at: '2026-10-01T00:00:00Z' }), ports: ports_from_gen(make_id_gen(seeded_ports({ start_ms: OCT4_10H, step_ms: 1000 }))) });
  const first_example = (ctx) => buttons(AX.render_examples_card(ctx), () => true)[0].textContent;
  assert.equal(first_example(mk_ctx(G, 'ru', { journal: early })), 'что изменилось с 1 октября');
  assert.equal(first_example(mk_ctx(G, 'ru', { journal: journal_on(G, OCT4_10H) })), 'что изменилось с 4 октября');
  assert.equal(first_example(mk_ctx(G, 'ru')), 'что изменилось с 4 октября', 'без журнала — день расчёта');
  assert.equal(first_example(mk_ctx(G, 'en', { journal: early })), 'what changed since October 1');
  const r = APP.ask_a0(APP.build_model(G, { lang: 'ru' }), first_example(mk_ctx(G, 'ru', { journal: early })), 'ru', INCOME, ports_from(early));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(norm(r.text), /^Изменено записей: 0 \(с 1 октября\)/);
});

test('FP-20 исправление (low): карточка «Журнал вызовов» честно называет границы — запись только у ответов на экране «Ассистент»; нет её в режиме «только чтение», при ошибке, при отказе разбора и у вердикта на экране «Купить»; журнал пропадает при смене набора данных (RU и EN)', () => {
  const ru = text_of(AX.render_calls_card(mk_ctx(G, 'ru', { journal: journal_on(G, OCT4_10H) }), { paint: null }));
  for (const s of ['на этом экране', 'в режиме «только чтение»', 'при ошибке инструмента', 'при отказе разобрать вопрос', 'у вердикта на экране «Купить»', 'пропадает при перезагрузке и при смене набора данных']) assert.ok(ru.includes(s), s);
  const en = text_of(AX.render_calls_card(mk_ctx(G, 'en', { journal: journal_on(G, OCT4_10H) }), { paint: null }));
  for (const s of ['on this screen', 'read-only mode', 'when a tool fails', 'cannot be parsed', 'the “Buy” screen', 'lost on reload and when the dataset is changed']) assert.ok(en.includes(s), s);
});

test('FP-20 исправление: пакет создаёт журнал страницы при открытии набора данных — правка, внесённая до первого вопроса ассистента, видна в «что изменилось» (без пакета она попала бы в снимок открытия)', () => {
  const session = (with_pack) => {
    const e = EXT.create_ext({ ports: seeded_ports({ seed: 5, start_ms: OCT4_10H, step_ms: 1000 }) });
    let ws = JSON.parse(JSON.stringify(G));
    e.bind_host({ get_ws: () => ws, get_model: () => null, lang: () => 'ru', mode: () => 'worse', fmt: () => null, set_ws: (next) => { ws = next; return { ok: true }; }, render() {}, notify() {} });
    if (with_pack) PACK.register(e);
    e.reset(ws, { source: 'dataset', dataset_id: 'g001' });
    const edited = JSON.parse(JSON.stringify(ws));
    edited.params = { ...edited.params, buffer_minor: 60000 };
    assert.equal(e.ctx.set_ws(edited, { reason: 'fp20_test_edit' }).ok, true);
    return { e, edited };
  };
  const answer = ({ e, edited }) => APP.ask_a0(APP.build_model(edited, { lang: 'ru' }), 'что изменилось с 4 октября', 'ru', INCOME, AX.make_ports(e.ctx, { paint: null }));
  const with_pack = session(true);
  assert.equal(with_pack.e.ctx.journal.length, ws_to_events(G).length + 1, 'снимок открытия и одна правка (params.set)');
  assert.match(norm(answer(with_pack).text), /^Изменено записей: 1 \(с 4 октября\)/);
  // контроль: без пакета журнал создаётся при первом обращении, из уже изменённого набора, и правка оказывается в снимке
  const without = session(false);
  assert.equal(without.e.ctx.journal.length, ws_to_events(G).length);
  assert.match(norm(answer(without).text), /^Изменено записей: 0 \(с 4 октября\)/);
});

test('boot: пакет pack_fp20 подхвачен, хук assistant зарегистрирован (чужие действия — undefined), в app.mjs одна строка обращения к хуку, прежняя кнопка осталась запасной', () => {
  assert.deepEqual(ext.diagnostics().filter((d) => d.pack === 'pack_fp20').map((d) => d.status), ['ok'], JSON.stringify(ext.diagnostics()));
  assert.ok(EXT.HOOKS.includes('assistant'));
  assert.equal(ext.first('assistant', 'нет_такого_действия'), undefined);
  assert.equal(ext.first('assistant', 'chip', null, 'c_00000000'), null, 'без результата хук отвечает null — приложение рисует запасную кнопку');
  const ports = ext.first('assistant', 'ports');
  assert.ok(Array.isArray(ports.journal) && ports.journal.length >= 40, 'журнал страницы: записи набора');
  assert.deepEqual([ports.call_log, ports.last_call], [{}, null]);
  assert.equal(typeof ports.record, 'function');
  const app_src = fs.readFileSync(path.join(DEMO, 'app.mjs'), 'utf8');
  const code = app_src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l));
  assert.equal(code.filter((l) => /ext\.first\('assistant'/.test(l)).length, 1, 'обращение к хуку — в одном месте');
  assert.equal(code.filter((l) => /\ba0_hook\(/.test(l) && !/^const a0_hook/.test(l)).length, 3, 'чип, порты вопроса и пояснение допущений');
  assert.ok(code.some((l) => /return a0_hook\('chip', result, ref, \(\) => show_evidence\(result, ref\)\) \?\? h\('button', \{ type: 'button', class: 'chip'/.test(l)), 'прежняя кнопка — запасной вариант; таблицу чисел показывает приложение');
  assert.ok(code.filter((l) => /\bext\b/.test(l)).length <= 25, 'строк хуков в app.mjs не больше 25 (предел waves_card)');
  assert.ok(!/pack_fp20|assistant_ext|record_call|export_calls_csv/.test(app_src), 'app.mjs пакет и запись журнала вызовов по имени не знает: только порты `ports.record`');
});

test('REQ-132 клик по чипу Q3 на экране «Купить»: чип ответа с режимом, версией, датой узкой точки и hash; «Числа расчёта» открывают те же числа; «почему» — цепочку вкладов; пометки ИИ нет', async () => {
  await go('#buy');
  const set = (id, v) => { const f = field(id); f.value = v; for (const fn of f.listeners.input ?? []) fn({ target: f }); };
  set('buy-amount', '300');
  set('buy-date', '2026-10-12');
  const main = byid.get('main');
  const chips = find_all(main, (n) => /(^|\s)a0-origin(\s|$)/.test(n.className));
  assert.equal(chips.length, 1, 'у ответа Q3 один чип');
  const chip = chips[0];
  assert.equal(chip.attrs['data-ref'], 'c_131fba11', 'ссылка TV-1');
  const t = text_of(chip);
  for (const s of ['числа из расчёта c_131fba11', 'Режимесли хуже', 'Версия движка0.1.0', 'Узкая точка14 ноября · 1 830,00 €', 'fc9d650d', 'check_purchase', '4 октября']) assert.ok(t.includes(s), s + ' | ' + t);
  assert.ok(!t.includes('ответ ИИ') && !main_text().includes('ответ ИИ'), 'в ответе A0 нет пометки «ответ ИИ»');
  // старой кнопки «числа из расчёта» на экране нет: чип её заменил
  assert.equal(buttons(main, (n) => /^числа из расчёта/.test(n.textContent)).length, 0);
  // клик: «Числа расчёта»
  const numbers = buttons(chip, (n) => n.textContent === 'Числа расчёта')[0];
  numbers.listeners.click[0]();
  const nt = dlg_text();
  assert.equal(byid.get('dlg').open, true);
  for (const s of ['Числа из расчёта c_131fba11', 'e1money635,00 €', 'e2date1 ноября', 'e3money410,00 €', 'e4date14 ноября', 'e5money500,00 €']) assert.ok(nt.includes(s), s);
  // клик: «почему»
  buttons(chip, (n) => n.textContent === 'почему?')[0].listeners.click[0]();
  const wt = dlg_text();
  assert.ok(wt.includes('Почему 1 830,00 € · 14 ноября'), wt.slice(0, 120));
  for (const s of ['Аренда', '41,47 %', 'Продукты × 6', '27,65 %', '23,04 %', 'Остальное (групп: 2)', 'Итого2 170,00 €', 'Сходится: сумма строк 2 170,00 € равна просадке 2 170,00 €', 'числа из расчёта c_131fba11 · движок 0.1.0 · inputs fc9d650d']) assert.ok(wt.includes(s), s);
  // кнопки «почему?» рядом со строками режимов остались прежними (штатный диалог FP-07)
  const row_why = buttons(main, (n) => n.textContent === 'почему?' && !/a0-why/.test(n.className));
  assert.equal(row_why.length, 2, 'по плану и если хуже');
});

test('REQ-136 FP-20 экран «Ассистент»: примеры новых вопросов, карточка «Журнал вызовов»; ответ → чип у каждого ответа, строка в журнале (только хэши), запись assistant.call в журнале страницы', async () => {
  await go('#assistant');
  const main = byid.get('main');
  const cards = find_all(main, (n) => n.tagName === 'section');
  const titles = cards.map((c) => c.attrs['aria-label'] ?? c.children.find((x) => x.tagName === 'h3')?.textContent);
  assert.ok(titles.includes('Новые вопросы') && titles.includes('Журнал вызовов') && titles.includes('Происхождение чисел'), titles.join(' | '));
  assert.ok(titles.indexOf('Происхождение чисел') < titles.indexOf('Новые вопросы') && titles.indexOf('Новые вопросы') < titles.indexOf('Журнал вызовов'), 'порядок карточек слота');
  assert.ok(main_text().includes('Вызовов пока не записано.'));
  assert.ok(find_all(main, (n) => n.attrs.id === 'a0-calls-csv')[0].attrs.disabled !== undefined);
  // вопрос о покупке
  const j0 = ext.ctx.journal.length;
  ask('можно ли купить за 300 € 12 октября');
  assert.match(main_text(), /Покупка 300,00 € на 12 октября/);
  const chat = find_all(main, (n) => /(^|\s)msg(\s|$)/.test(n.className));
  assert.equal(chat.length, 1);
  const chip = find_all(chat[0], (n) => /(^|\s)a0-origin(\s|$)/.test(n.className))[0];
  assert.ok(chip !== undefined, 'у ответа ассистента чип происхождения');
  assert.equal(chip.attrs['data-ref'], 'c_131fba11');
  assert.ok(text_of(chip).includes('Версия движка0.1.0') && text_of(chip).includes('Узкая точка14 ноября'), 'чип раскрывает версию и дату узкой точки');
  assert.ok(!text_of(chat[0]).includes('ответ ИИ'));
  // журнал страницы и карточка
  assert.equal(ext.ctx.journal.length, j0 + 1);
  const ev = ext.ctx.journal.events().at(-1);
  assert.deepEqual([ev.type, ev.actor, ev.entity_id], ['assistant.call', 'assistant:a0', 'c_131fba11']);
  assert.deepEqual(Object.keys(ev.payload).sort(), [...CL.CALL_FIELDS].sort(), 'ровно пять полей (запись журнала хранит ключи в каноническом порядке)');
  assert.equal(ev.payload.args_hash, sha(TV1_CANON));
  for (const raw of ['можно ли', '300', '12 октября', '2026-10-12', 'EUR']) assert.ok(!JSON.stringify(ev).includes(raw), `в записи нет «${raw}»`);
  assert.ok(main_text().includes('Записано вызовов: 1.'));
  assert.ok(main_text().includes(sha(TV1_CANON).slice(0, 8)));
  assert.equal(find_all(main, (n) => n.attrs.id === 'a0-calls-csv')[0].attrs.disabled, undefined);
  // клик по чипу ответа ассистента
  buttons(chip, (n) => n.textContent === 'Числа расчёта')[0].listeners.click[0]();
  assert.ok(dlg_text().includes('e1money635,00 €'));
  buttons(chip, (n) => n.textContent === 'почему?')[0].listeners.click[0]();
  assert.ok(dlg_text().includes('Сходится'));
});

test('FP-20 «что изменилось с <даты>» на экране: до начала журнала — отказ с причиной (не числа); с даты — журнал страницы доходит до инструмента, ответ сверен, чип и запись вызова есть; правка в тот же день видна и «с даты», и «с прошлого раза»', async () => {
  const count_calls = () => ext.ctx.journal.events().filter((e) => e.type === 'assistant.call').length;
  const chips = () => find_all(byid.get('main'), (n) => /(^|\s)a0-origin(\s|$)/.test(n.className)).length;
  const chips0 = chips();
  const calls0 = count_calls();
  // основание раньше начала журнала: отказ, у отказа нет ни чипа, ни записи вызова, ни «изменено 40 записей»
  ask('что изменилось с 1 октября');
  let t = main_text();
  assert.ok(t.includes(norm(I18N.t('ru', 'as.no_history', { date: '4 октября' }))), t.slice(-400));
  assert.ok(!/Изменено записей: 40/.test(t) && !t.includes('был 0,00 €'));
  assert.deepEqual([chips(), count_calls()], [chips0, calls0], 'отказ ничего не записал и чипа не имеет');
  // с первого дня журнала: снимок открытия — не изменение
  ask('что изменилось с 4 октября');
  t = main_text();
  assert.match(t, /Изменено записей: 0 \(с 4 октября\)/, t.slice(-500));
  assert.match(t, /числа сверены с расчётом/);
  assert.ok(t.includes('Сравнение идёт по журналу этой страницы: он начинается 4 октября, правки до открытия набора данных в нём не видны.'), 'пояснение, чем ограничено сравнение');
  assert.equal(chips(), chips0 + 1);
  assert.equal(count_calls(), calls0 + 1);
  assert.ok(t.includes('Записано вызовов: ' + (calls0 + 1) + '.'));
  // «с прошлого раза»: после последнего вызова ничего не менялось
  ask('что изменилось с прошлого раза');
  t = main_text();
  assert.match(t, /Изменено записей: 0\./);
  // правка данных: буфер → запись params.set (время записи — часы страницы, позже 4 октября); «с прошлого раза» видит её по порядку записей
  const ws = ext.ctx.get_ws();
  const edited = JSON.parse(JSON.stringify(ws));
  edited.params = { ...edited.params, buffer_minor: 60000 };
  assert.equal(ext.ctx.set_ws(edited, { reason: 'fp20_test_buffer' }).ok, true);
  await go('#assistant');
  ask('что изменилось с прошлого раза');
  t = main_text();
  assert.match(t, /Изменено записей: 1\./, t.slice(-500));
  assert.match(t, /параметры: 1\./);
  ask('что изменилось с 4 октября');
  t = main_text();
  assert.match(t, /Изменено записей: 1 \(с 4 октября\)/, t.slice(-500));
  // отказы — текстом причины, без чипа и без записи
  const calls = count_calls();
  const shown = chips();
  ask('что изменилось');
  assert.ok(main_text().includes(I18N.t('ru', 'as.no_since')));
  ask('а если сдвинуть платёж аренды на 5 дней');
  assert.ok(main_text().includes(I18N.t('ru', 'as.shift_unsupported')));
  ask('а если сдвинуть платёж по ипотеке на 10 дней');
  assert.equal(main_text().split(I18N.t('ru', 'as.shift_unsupported')).length - 1, 2, 'платёж по ипотеке — тоже отказ, а не сдвиг поступления');
  ask('а если сдвинуть платёж на 12 ноября');
  assert.ok(main_text().includes(I18N.t('ru', 'as.shift_days')));
  assert.equal(count_calls(), calls, 'отказы ничего не записали');
  assert.equal(chips(), shown, 'у отказов чипа нет');
  // прежние вопросы по-прежнему отвечают
  ask('налоговый конверт');
  assert.match(main_text(), /Налоговый конверт на/);
});

test('FP-20 «а если сдвинуть платёж» и «что с резервом» на экране: ответ как у прежних вопросов («если клиент заплатит позже», «налоговый конверт»), с чипом и записью вызова', async () => {
  const count_calls = () => ext.ctx.journal.events().filter((e) => e.type === 'assistant.call').length;
  const answers = () => find_all(byid.get('main'), (n) => /(^|\s)a0(\s|$)/.test(n.className)).map((n) => norm(n.children[0].textContent).replace(/^A0: /, ''));
  const before = count_calls();
  const n0 = answers().length;
  ask('а если сдвинуть платёж на 10 дней');
  ask('если клиент заплатит на 10 дней позже');
  ask('что с резервом');
  ask('налоговый конверт');
  const t = answers().slice(n0);
  assert.equal(t.length, 4);
  assert.equal(t[0], t[1] + ' Допущение: сдвигается ближайшее ожидаемое поступление (не расход), на 10 дней.', 'сдвиг поступления на 10 дней — тот же ответ, что у прежнего вопроса, и допущение шаблоном каталога');
  assert.equal(t[2], t[3], '«что с резервом» — тот же ответ, что у «налогового конверта»');
  // пояснение под ответом называет, какое именно поступление сдвинуто; у прежнего вопроса («если клиент заплатит позже») пояснения нет
  const notes = find_all(byid.get('main'), (n) => /(^|\s)a0-note(\s|$)/.test(n.className)).map((n) => text_of(n));
  assert.ok(notes.includes('Сдвигается поступление «Выплата за часы», 5 ноября.'), notes.join(' | '));
  assert.match(t[0], /^Сценарий в режиме/);
  assert.match(t[2], /^Налоговый конверт на/);
  assert.equal(count_calls(), before + 4);
  const msgs = find_all(byid.get('main'), (n) => /(^|\s)msg(\s|$)/.test(n.className));
  const chips = find_all(byid.get('main'), (n) => /(^|\s)a0-origin(\s|$)/.test(n.className));
  assert.equal(chips.length, msgs.filter((n) => find_all(n, (x) => x.className === 'a0').some((x) => x.children.length > 1 && /Числа расчёта/.test(x.textContent))).length, 'чип у каждого ответа с числами');
});

test('REQ-136 CSV журнала вызовов: кнопка «Скачать CSV» отдаёт ровно export_calls_csv журнала страницы — заголовок, строки с хэшами, без текста вопросов', async () => {
  const calls = ext.ctx.journal.events().filter((e) => e.type === 'assistant.call');
  assert.ok(calls.length >= 8);
  const orig = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  let captured = null;
  URL.createObjectURL = (blob) => { captured = blob; return 'blob:fp20-test'; };
  URL.revokeObjectURL = () => {};
  try {
    const btn = find_all(byid.get('main'), (n) => n.attrs.id === 'a0-calls-csv')[0];
    btn.listeners.click[0]();
    assert.ok(captured !== null, 'файл создан');
    assert.equal(captured.type, 'text/csv');
    const csv = await captured.text();
    assert.equal(csv, CL.export_calls_csv(ext.ctx.journal.events()));
    const lines = csv.split('\n');
    assert.equal(lines[0], 'seq,recorded_at,call_id,tool,args_hash,inputs_hash,engine_version');
    assert.equal(lines.length, calls.length + 2);
    for (const raw of ['можно ли', 'октября', 'резерв', 'аренд', 'EUR', '300']) assert.ok(!csv.includes(raw), `в CSV нет «${raw}»`);
    assert.ok(lines.slice(1, -1).every((l) => /^\d+,\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z,[0-9a-f]{8},[a-z_]+,[0-9a-f]{64},[0-9a-f]{64},0\.1\.0$/.test(l)), 'каждая строка — только хэши и метки');
  } finally {
    URL.createObjectURL = orig.create;
    URL.revokeObjectURL = orig.revoke;
  }
});

test('FP-20 «Новые вопросы»: пример подставляется в поле вопроса и фокусируется; отправляет его кнопка «Спросить»; «Очистить» убирает чат, но не журнал вызовов', async () => {
  const main = byid.get('main');
  const chips = find_all(main, (n) => /a0-examples/.test(n.className)).flatMap((c) => buttons(c, () => true));
  assert.deepEqual(chips.map((c) => c.textContent), ['что изменилось с 4 октября', 'а если сдвинуть платёж на 10 дней', 'что с резервом'], 'первый день журнала страницы — 4 октября: раньше ответ был бы отказом');
  chips[0].listeners.click[0]();
  assert.equal(field('as-q').value, 'что изменилось с 4 октября');
  assert.equal(field('as-q').focused, true);
  const before = ext.ctx.journal.events().filter((e) => e.type === 'assistant.call').length;
  ask(field('as-q').value);
  assert.match(main_text(), /Изменено записей: [1-9]\d* \(с 4 октября\)/, 'пример даёт ответ с числами, а не отказ');
  const count = ext.ctx.journal.events().filter((e) => e.type === 'assistant.call').length;
  assert.equal(count, before + 1);
  buttons(main, (n) => n.textContent === 'Очистить')[0].listeners.click[0]();
  assert.equal(find_all(byid.get('main'), (n) => /(^|\s)msg(\s|$)/.test(n.className)).length, 0, 'чат очищен');
  assert.ok(main_text().includes('Записано вызовов: ' + count + '.'), 'журнал вызовов остался');
});

test('TST-56 TST-59 FP-20: каталог a0ext — RU и EN, паритет ключей и плейсхолдеров, каждый ключ используется литералом в коде пакета; запретных формулировок нет; пакет не импортирует app.mjs', async () => {
  const catalog = (await imp(DEMO, 'i18n', 'a0ext.mjs')).default;
  const VOCAB = read_json(HERE, '..', 'engine', 'vocab.json');
  const ph = (x) => [...x.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]).sort();
  assert.deepEqual(Object.keys(catalog).sort(), ['en', 'ru']);
  assert.deepEqual(Object.keys(catalog.ru).sort(), Object.keys(catalog.en).sort());
  const code = ['assistant_ext.mjs', 'pack_fp20.mjs'].map((f) => fs.readFileSync(path.join(DEMO, f), 'utf8')).join('\n');
  for (const k of Object.keys(catalog.ru)) {
    assert.ok(k.startsWith('a0ext.'), k);
    assert.deepEqual(ph(catalog.ru[k]), ph(catalog.en[k]), 'плейсхолдеры ' + k);
    assert.match(catalog.ru[k].replace(/\{[A-Za-z0-9_]+\}/g, ''), /[а-яё]/i, 'RU-строка ' + k + ' с русскими буквами');
    assert.ok(code.includes("'" + k + "'"), 'ключ ' + k + ' используется литералом в коде пакета');
  }
  const corpus = (Object.values(catalog.ru).join('\n') + Object.values(catalog.en).join('\n') + code).toLowerCase().replace(/ё/g, 'е');
  for (const phrase of VOCAB.forbidden_phrases) assert.ok(!corpus.includes(phrase.toLowerCase().replace(/ё/g, 'е')), 'запрещено: ' + phrase);
  for (const m of code.matchAll(/'(a0ext\.[a-z_]+)'/g)) assert.ok(Object.hasOwn(catalog.ru, m[1]), 'код ссылается на несуществующий ключ ' + m[1]);
  assert.ok(!/from '\.\/app\.mjs'/.test(code), 'пакет не импортирует app.mjs');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function|style="/.test(code));
  assert.equal(typeof PACK.register, 'function');
  assert.deepEqual(PACK.ORDERS, { examples: 905, calls: 910 });
});
