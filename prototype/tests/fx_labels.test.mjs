// fx_labels.test.mjs — FP-16: подпись курса и его возраста у каждой пересчитанной суммы (REQ-077, REQ-079), тексты плашек курса (W_RATE_STALE, E_NO_RATE) из каталога строк.
// Часть 1 — чистые подписи (demo/rate_chip.mjs, demo/banner_texts.mjs) на событиях расчёта G-001 с долларовым доходом и расходом.
// Часть 2 — модели экранов app.mjs (лента, «Почему», волны, ответ ассистента) и настоящий app.mjs на заглушке DOM: подпись видна на экранах, плашка в шапке называет валюту и возраст.
// Часть 3 — тексты «нет курса», каталог и статические проверки (нет русских литералов и литерала предела в новых модулях). Браузер, сеть и серверы не используются.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(HERE, '..', 'demo');
const DATA = path.join(HERE, '..', 'data');

// ── заглушка DOM (как в scenario_builder.test.mjs) ──────────────────────────────────────────────────────────────────────
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
      return opts.length === 0 ? '' : opts[0].attrs.value;
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

const { ext } = await import(pathToFileURL(path.join(DEMO, 'ext.mjs')).href);
const APP = await import(pathToFileURL(path.join(DEMO, 'app.mjs')).href);
await new Promise((r) => setTimeout(r, 500));
const RC = await import(pathToFileURL(path.join(DEMO, 'rate_chip.mjs')).href);
const BT = await import(pathToFileURL(path.join(DEMO, 'banner_texts.mjs')).href);
const FORMS = await import(pathToFileURL(path.join(DEMO, 'forms.mjs')).href);
const ENTRY = await import(pathToFileURL(path.join(DEMO, 'entry.mjs')).href);
const I18N = await import(pathToFileURL(path.join(DEMO, 'i18n.mjs')).href);
const CAT = (await import(pathToFileURL(path.join(DEMO, 'i18n', 'ratechip.mjs')).href)).default;
const E = await import('../engine/index.mjs');
const { analyze } = E;

const read = (name) => JSON.parse(fs.readFileSync(path.join(DATA, name + '.json'), 'utf8'));
const G = read('g001');
const NB = / | /g;
const plain = (s) => s.replace(NB, ' ');
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };
const text_of = (id) => byid.get(id).textContent;
const field = (id) => find_all(byid.get('main'), (n) => n.attrs.id === id)[0];
const tr_ru = (key, params) => I18N.t('ru', key, params);
const tr_en = (key, params) => I18N.t('en', key, params);

/** G-001 с долларовым счётом: доход 2000,00 $ на 20 октября и расход 400,00 $ на 22 октября; курс 0,9250 от 1 октября (на дату расчёта 4 октября — возраст 3 дн.). */
function usd_ws(rate_date = '2026-10-01', extra = {}) {
  return {
    ...G,
    accounts: [...G.accounts, { account_id: 'acc_usd', name: 'USD', kind: 'bank', liquidity: 'operating', currency: 'USD', exponent: 2, opened_on: '2026-01-01' }],
    anchors: [...G.anchors, { anchor_id: 'a-usd', account_id: 'acc_usd', date: '2026-10-04', amount_minor: 0 }],
    rates: [...(G.rates ?? []), { fx_id: 'r-usd', date: rate_date, base: 'USD', quote: 'EUR', num: 9250, den: 10000 }],
    plans: [...(G.plans ?? []),
      { plan_id: 'U-PAY', account_id: 'acc_usd', name: 'Лицензия', date: '2026-10-22', amount_minor: -40000, currency: 'USD', kind: 'expense', tag: 'usd', is_obligation: true },
      { plan_id: 'U-INC', account_id: 'acc_usd', name: 'Доллары', date: '2026-10-20', amount_minor: 200000, currency: 'USD', kind: 'income', tag: 'usd' }],
    ...extra,
  };
}

// ── часть 1: чистые подписи ─────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-077 подпись курса: rate_digits показывает курс «как введён», знак дроби — из формата чисел; совпадает с forms.rate_text', () => {
  const cases = [[9250, 10000], [1, 3], [108, 100], [3, 2], [925069, 1000000]];
  for (const [num, den] of cases) {
    for (const nf of [undefined, { decimal: ',', thousands: '.' }, { decimal: '.', thousands: ',' }]) {
      const env = { lang: 'ru', nf };
      assert.equal(RC.rate_digits(num, den, 'ru', nf), FORMS.rate_text(num, den, env), `${num}/${den} ${JSON.stringify(nf)}`);
    }
  }
  assert.equal(RC.rate_digits(9250, 10000, 'ru'), '0,9250');
  assert.equal(RC.rate_digits(9250, 10000, 'en'), '0.9250');
  assert.equal(RC.rate_digits(9250, 10000, 'ru', { decimal: '.', thousands: ',' }), '0.9250', 'формат пользователя главнее языка');
  assert.equal(RC.rate_digits(1, 3, 'ru'), '≈ 0,333333');
});

test('REQ-077 REQ-079 каждое пересчитанное событие получает подпись: исходная сумма, курс, дата курса, возраст в днях; непересчитанные — без подписи', () => {
  const ws = usd_ws();
  const a = analyze(ws, { as_of: ws.as_of });
  const converted = a.events.plan.filter((e) => e.rate_used !== null && e.rate_used !== undefined);
  assert.deepEqual(converted.map((e) => e.cash_event_id).sort(), ['U-INC', 'U-PAY']);
  const fx = RC.fx_by_event(ws, a, a.events.plan);
  assert.deepEqual([...fx.keys()].sort(), ['U-INC', 'U-PAY'], 'подпись только у пересчитанных событий');
  const inc = fx.get('U-INC');
  assert.deepEqual([inc.cur, inc.orig_minor, inc.conv_minor], ['USD', 200000, 185000]);
  assert.deepEqual(inc.sig, { cur: 'USD', dec: 'EUR', num: 9250, den: 10000, date: '2026-10-01', age: 3, stale: false, inverse: false, shocked: false });
  const env = RC.make_env('ru', ws, a);
  assert.equal(plain(RC.row_text(tr_ru, env, inc)), '2 000,00 $ · курс 0,9250 от 2026-10-01 · возраст 3 дн.');
  assert.equal(plain(RC.row_text(tr_en, RC.make_env('en', ws, a), inc)), '$2,000.00 · rate 0.9250 of 2026-10-01 · age 3 d');
  assert.equal(fx.get('U-PAY').orig_minor, -40000);
  // событие в валюте решения подписи не имеет
  assert.equal(RC.event_fx(ws, a, a.events.plan.find((e) => e.cash_event_id === 'P-TAX1')), null);
  // сводка курсов: один курс, два события
  const uses = RC.rate_uses(ws, a);
  assert.equal(uses.length, 1);
  assert.equal(plain(RC.answer_note_text(tr_ru, env, uses)), 'Суммы в иностранной валюте пересчитаны по введённым курсам: USD → EUR: курс 0,9250 от 2026-10-01 · возраст 3 дн.');
  assert.equal(RC.answer_note_text(tr_ru, env, []), '', 'нет пересчётов — нет примечания');
  assert.match(plain(RC.report_note_text(tr_ru, env, uses)), /^Суммы в иностранной валюте пересчитаны в валюту решения по введённым курсам: USD → EUR: курс 0,9250/);
  assert.equal(RC.report_note_text(tr_ru, env, []), '');
});

test('REQ-079 устаревший курс: старше предела fx.stale_days — пометка «курс устарел»; ровно предел — ещё нет; предел берётся из параметров рабочей области', () => {
  const old = usd_ws('2026-08-01'); // возраст 64 дн.
  const a = analyze(old, { as_of: old.as_of });
  const fx = RC.fx_by_event(old, a, a.events.plan).get('U-INC');
  assert.deepEqual([fx.sig.age, fx.sig.stale], [64, true]);
  const env = RC.make_env('ru', old, a);
  assert.match(plain(RC.row_text(tr_ru, env, fx)), /возраст 64 дн\. · курс устарел$/);
  assert.match(plain(RC.row_text(tr_en, RC.make_env('en', old, a), fx)), /age 64 d · rate is out of date$/);
  // граница: предел 64 дня — ещё не устарел, 63 — устарел (так же считает движок: W_RATE_STALE)
  for (const [limit, stale] of [[64, false], [63, true]]) {
    const w = usd_ws('2026-08-01', { params: { ...G.params, 'fx.stale_days': limit } });
    const aw = analyze(w, { as_of: w.as_of });
    assert.equal(RC.fx_by_event(w, aw, aw.events.plan).get('U-INC').sig.stale, stale, 'предел ' + limit);
    assert.equal(aw.warnings.some((x) => x.code === 'W_RATE_STALE'), stale, 'движок согласен с подписью, предел ' + limit);
  }
  assert.equal(RC.stale_limit(G), undefined, 'в данных предел не задан: по умолчанию его знает движок, в демо литерала нет');
  assert.equal(RC.stale_limit({ ...G, params: { ...G.params, 'fx.stale_days': 12 } }), 12);
});

test('REQ-077 подпись различает сценарий курса и обратную пару; формат дат пользователя применяется к дате курса', () => {
  const ws = usd_ws();
  const model = APP.build_model(ws, { scenario: { ops: [{ op: 'fx_shock', currency: 'USD', bp: -500 }] } });
  const a = model.ctx;
  const fx = RC.fx_by_event(ws, a, a.events.plan).get('U-INC');
  assert.equal(fx.sig.shocked, true, 'курс сдвинут сценарием');
  assert.equal(fx.conv_minor, 175750, '2000,00 $ × 0,9250 × 0,95');
  assert.match(plain(RC.row_text(tr_ru, RC.make_env('ru', ws, a), fx)), /· с учётом сценария курса$/);
  // только обратная пара EUR→USD: подпись говорит «обратная пара», сумма та же с точностью до округления
  const inv = { ...ws, rates: [{ fx_id: 'r-eur', date: '2026-10-01', base: 'EUR', quote: 'USD', num: 10800, den: 10000 }] };
  const ai = analyze(inv, { as_of: inv.as_of });
  const fi = RC.fx_by_event(inv, ai, ai.events.plan).get('U-INC');
  assert.equal(fi.sig.inverse, true);
  assert.equal(fi.sig.shocked, false);
  assert.match(plain(RC.row_text(tr_ru, RC.make_env('ru', inv, ai), fi)), /курс 0,925925 от 2026-10-01 \(обратная пара\) · возраст 3 дн\.|курс ≈ 0,925926 от 2026-10-01 \(обратная пара\) · возраст 3 дн\./);
  // стиль дат пользователя
  const dmy = { ...ws, number_format: { date: 'dmy' } };
  assert.match(plain(RC.row_text(tr_ru, RC.make_env('ru', dmy, a), RC.fx_by_event(dmy, a, a.events.plan).get('U-INC'))), /от 01\.10\.2026/);
  const mdy = { ...ws, number_format: { date: 'mdy' } };
  assert.match(plain(RC.row_text(tr_ru, RC.make_env('ru', mdy, a), RC.fx_by_event(mdy, a, a.events.plan).get('U-INC'))), /от 10\/01\/2026/);
  assert.equal(RC.rate_date_text(undefined, '2026-10-01'), '2026-10-01', 'по умолчанию дата курса — ISO');
});

test('REQ-112 подпись курса в формате чисел пользователя: «2.000,00 $ · курс 0,9250 …» при формате «1.234,50»', () => {
  const ws = usd_ws('2026-10-01', { number_format: { decimal: ',', thousands: '.' } });
  const a = analyze(ws, { as_of: ws.as_of });
  const env = RC.make_env('en', ws, a);
  const fx = RC.fx_by_event(ws, a, a.events.plan).get('U-INC');
  assert.equal(RC.money_in(env, 'USD', 200000), '$2.000,00');
  assert.equal(plain(RC.money_in(RC.make_env('ru', ws, a), 'EUR', 123450)), '1.234,50 €');
  assert.equal(plain(RC.row_text(tr_en, env, fx)), '$2.000,00 · rate 0,9250 of 2026-10-01 · age 3 d', 'и сумма, и курс — в формате пользователя, язык слов — английский');
});

// ── часть 2: экраны ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-077 REQ-079 модели экранов: лента, «Почему» и волны несут подпись курса у пересчитанных сумм; у набора G-001 ключей подписи нет', () => {
  const ws = usd_ws();
  const model = APP.build_model(ws, { lang: 'ru' });
  const feed = APP.feed_model(model, 'plan', 'ru');
  const inc = feed.future.find((r) => r.id === 'U-INC');
  assert.deepEqual([inc.amount_minor, inc.fx.orig_minor, inc.fx.cur, inc.fx.sig.age], [185000, 200000, 'USD', 3]);
  assert.ok(feed.future.filter((r) => r.id !== 'U-INC' && r.id !== 'U-PAY').every((r) => !Object.hasOwn(r, 'fx')), 'евро-события без подписи');
  // волны: платёж в долларах в составе волны
  const waves = APP.waves_model(model, 'ru');
  const members = waves.items.flatMap((it) => it.members);
  const lic = members.find((m) => m.id === 'U-PAY');
  assert.ok(lic !== undefined && lic.fx.orig_minor === -40000, JSON.stringify(waves.items.map((i) => i.members.map((m) => m.id))));
  assert.ok(members.filter((m) => m.id !== 'U-PAY').every((m) => !Object.hasOwn(m, 'fx')));
  // «Почему»: строки цепочки и контрфакты
  const why = APP.explain_model(model, 'plan', 'ru');
  const rows = [...why.chain, ...why.counterfactuals];
  assert.ok(rows.some((r) => Array.isArray(r.fx) && r.fx.length > 0), 'в цепочке «Почему» есть пересчитанная сумма: ' + JSON.stringify(why.chain.map((c) => [c.name, c.event_ids])));
  // набор G-001 без чужой валюты: ни ключей fx, ни валюты факта
  const g = APP.build_model(G, { lang: 'ru' });
  const gf = APP.feed_model(g, 'plan', 'ru');
  assert.ok([...gf.past, ...gf.future].every((r) => !Object.hasOwn(r, 'fx') && !Object.hasOwn(r, 'currency')));
  assert.ok(APP.waves_model(g, 'ru').items.every((it) => it.members.every((m) => !Object.hasOwn(m, 'fx'))));
  const gw = APP.explain_model(g, 'plan', 'ru');
  assert.ok([...gw.chain, ...gw.counterfactuals].every((r) => !Object.hasOwn(r, 'fx')));
  assert.deepEqual(RC.rate_uses(G, g.ctx), []);
});

test('REQ-077 лента, волны, «Почему» и ответ ассистента на экране: у суммы в долларах видна подпись «курс 0,9250 от 2026-10-01 · возраст 3 дн.»', async () => {
  const ws = usd_ws();
  assert.equal(ext.ctx.set_ws(ws, { reason: 'test_usd' }).ok, true);
  const sign = /курс 0,9250 от 2026-10-01 · возраст 3 дн\./;
  await go('#feed');
  let main = plain(text_of('main'));
  assert.match(main, /Доллары/);
  assert.match(main, /2 000,00 \$ · курс 0,9250 от 2026-10-01 · возраст 3 дн\./, 'лента: исходная сумма и подпись под названием');
  assert.match(main, /1 850,00 €/, 'в ячейке суммы — в валюте решения');
  await go('#waves');
  main = plain(text_of('main'));
  assert.match(main, /Пересчёт по курсу:/);
  assert.match(main, /Лицензия: −400,00 \$ → −370,00 € · курс 0,9250 от 2026-10-01 · возраст 3 дн\./, 'карточка волны');
  // «Почему»: диалог узкой точки
  await go('#overview');
  const why = find_all(byid.get('main'), (n) => n.tagName === 'button' && n.textContent === 'почему?');
  assert.ok(why.length > 0, 'кнопка «почему?» у вердикта');
  why[0].listeners.click[0]();
  const dlg = plain(byid.get('dlg-body').textContent);
  assert.match(dlg, /Из чего сложилась просадка/);
  assert.match(dlg, /Лицензия|usd/, 'платёж в долларах в цепочке');
  assert.match(dlg, /−400,00 \$ · курс 0,9250 от 2026-10-01 · возраст 3 дн\./, 'диалог «Почему»: ' + dlg.slice(0, 400));
  // ассистент: примечание под ответом
  await go('#assistant');
  field('as-q').value = 'Могу ли я купить за 120 на 31 октября?';
  const form = find_all(byid.get('main'), (n) => n.tagName === 'form' && /ask/.test(n.className))[0];
  form.listeners.submit[0]({ preventDefault() {} });
  main = plain(text_of('main'));
  assert.match(main, /Суммы в иностранной валюте пересчитаны по введённым курсам: USD → EUR: курс 0,9250 от 2026-10-01 · возраст 3 дн\./);
  // английский интерфейс
  const en = find_all(byid.get('controls'), (n) => n.tagName === 'button' && n.textContent === 'EN');
  if (en.length > 0) {
    en[0].listeners.click[0]();
    await go('#feed');
    assert.match(plain(text_of('main')), /\$2,000\.00 · rate 0\.9250 of 2026-10-01 · age 3 d/);
    find_all(byid.get('controls'), (n) => n.tagName === 'button' && n.textContent === 'RU')[0]?.listeners.click[0]();
  }
});

test('REQ-079 плашка W_RATE_STALE в шапке называет валюту, возраст курса в днях, дату курса и место обновления; движок и подпись согласны', async () => {
  const ws = usd_ws('2026-08-01');
  assert.equal(ext.ctx.set_ws(ws, { reason: 'test_usd_old' }).ok, true);
  const a = analyze(ws, { as_of: ws.as_of });
  const w = a.warnings.find((x) => x.code === 'W_RATE_STALE');
  assert.deepEqual(w, { code: 'W_RATE_STALE', currency: 'USD' });
  const text = plain(BT.rate_stale_text(tr_ru, ws, a, w));
  assert.equal(text, 'Курс USD → EUR не обновлялся 64 дн.: суммы в USD пересчитаны по курсу от 2026-08-01. Введите новый курс: Формы данных → Курсы и обмен.');
  assert.match(plain(BT.rate_stale_text(tr_en, ws, a, w)), /^The USD → EUR rate has not been updated for 64 d: amounts in USD are converted at the rate of 2026-08-01\. Enter a new rate: Data forms → Rates and exchange\.$/);
  assert.match(plain(text_of('summary')), /Курс USD → EUR не обновлялся 64 дн\./, 'плашка в шапке страницы');
  await go('#feed');
  assert.match(plain(text_of('main')), /курс 0,9250 от 2026-08-01 · возраст 64 дн\. · курс устарел/, 'у суммы — пометка «курс устарел»');
  // чужое предупреждение и валюта вне кодов — не наш текст
  assert.equal(BT.rate_stale_text(tr_ru, ws, a, { code: 'W_NO_RESERVES' }), null);
  assert.equal(BT.rate_stale_text(tr_ru, ws, a, { code: 'W_RATE_STALE', currency: '<b>x</b>' }), null);
  assert.equal(BT.rate_stale_text(tr_ru, G, analyze(G, { as_of: G.as_of }), { code: 'W_RATE_STALE', currency: 'USD' }), null, 'нет курса пары — общий текст предупреждения');
  assert.ok(ext.ctx.set_ws(JSON.parse(JSON.stringify(G)), { reason: 'test_reset' }).ok);
});

test('REQ-079 критерий приёмки: курс от 2026-08-20 на 2026-10-04 (возраст 45 дней) — плашка «курс не обновлялся 45 дн.», у суммы подпись «курс 0,9250 от 2026-08-20»; свежий курс — плашки нет', async () => {
  const ws = usd_ws('2026-08-20');
  assert.equal(ext.ctx.set_ws(ws, { reason: 'test_usd_45' }).ok, true);
  assert.match(plain(text_of('summary')), /Курс USD → EUR не обновлялся 45 дн\./);
  await go('#feed');
  assert.match(plain(text_of('main')), /курс 0,9250 от 2026-08-20 · возраст 45 дн\. · курс устарел/);
  assert.equal(ext.ctx.set_ws(usd_ws('2026-10-01'), { reason: 'test_usd_fresh' }).ok, true);
  assert.doesNotMatch(plain(text_of('summary')), /не обновлялся/);
  // формы данных: таблица курсов и подпись обмена показывают дату курса в стиле дат пользователя
  const dmy = usd_ws('2026-10-01', { number_format: { date: 'dmy' } });
  assert.equal(ext.ctx.set_ws(dmy, { reason: 'test_usd_dmy' }).ok, true);
  await go('#feed');
  assert.match(plain(text_of('main')), /курс 0,9250 от 01\.10\.2026 · возраст 3 дн\./, 'лента: дата курса в стиле пользователя');
  assert.ok(ext.ctx.set_ws(JSON.parse(JSON.stringify(G)), { reason: 'test_reset' }).ok);
});

// ── часть 3: «нет курса», каталог, статика ───────────────────────────────────────────────────────────────────────────────

test('REQ-077 E_NO_RATE называет пару и ведёт на «Формы данных» → «Курсы и обмен», а не «в настройках»', () => {
  assert.equal(BT.rates_route(tr_ru), 'Формы данных → Курсы и обмен');
  assert.equal(BT.rates_route(tr_en), 'Data forms → Rates and exchange');
  assert.equal(BT.no_rate_text(tr_ru, { pair: 'USD/EUR' }), 'Нет курса USD → EUR: введите его — Формы данных → Курсы и обмен.');
  assert.equal(BT.no_rate_text(tr_en, { currency: 'GBP', decision_currency: 'EUR' }), 'There is no GBP → EUR rate: enter it — Data forms → Rates and exchange.');
  assert.match(BT.no_rate_text(tr_ru, null), /^Нет курса для одной из валют: введите его — Формы данных → Курсы и обмен\.$/);
  assert.equal(BT.pair_of({ from: 'USD', to: 'EUR' }), 'USD → EUR', 'перевод между счетами в разных валютах');
  assert.equal(BT.pair_of({ pair: '<img>/EUR' }), null, 'не код валюты — в текст не попадает');
  assert.equal(BT.pair_of({ currency: 'usd', decision_currency: 'EUR' }), null);
  // движок называет пару в контексте ошибки; текст берётся оттуда
  let err = null;
  try { analyze({ ...usd_ws(), rates: [] }, { as_of: G.as_of }); } catch (e) { err = e; }
  assert.equal(err?.code, 'E_NO_RATE');
  assert.equal(BT.pair_of(err.ctx), 'USD → EUR');
  // формы: отказ записи называет пару и маршрут
  const ctx = ext.ctx;
  const form_text = plain(FORMS.error_text(ctx, { code: 'E_NO_RATE', ctx: { field: 'amount', reason: 'no_rate', currency: 'USD', decision_currency: 'EUR' } }));
  assert.match(form_text, /нет курса USD → EUR; введите его в разделе «Формы данных» → «Курсы и обмен»\./);
  assert.match(plain(FORMS.error_text(ctx, { code: 'E_NO_RATE', ctx: null })), /нет курса для этой пары валют; введите его в разделе/);
  // ввод факта и остальные места: нет слова «настройках» в тексте про курс
  for (const key of ['err.E_NO_RATE', 'entry.err_no_rate', 'forms.err_E_NO_RATE', 'debtedit.r_no_rate', 'warn.W_RATE_STALE']) {
    for (const lang of ['ru', 'en']) {
      const s = I18N.t(lang, key);
      assert.doesNotMatch(s, /настройках|in the settings/i, key + ' ' + lang);
      assert.match(s, lang === 'ru' ? /Формы данных/ : /Data forms/, key + ' ' + lang);
    }
  }
  assert.match(ENTRY.error_text(ctx, { code: 'E_NO_RATE', ctx: null }, {}), /«Формы данных» → «Курсы и обмен»/);
});

test('REQ-019 REQ-079 W_RULE_STALE и W_RESERVE_OVERDUE в шапке называют дату или сумму (U28, U30)', () => {
  for (const lang of ['ru', 'en']) {
    assert.match(I18N.t(lang, 'warn.W_RULE_STALE'), /\{since\}/, 'дата последней проверки правила');
    assert.match(I18N.t(lang, 'warn.W_RULE_DISABLED'), /\{since\}/);
    assert.match(I18N.t(lang, 'warn.W_RESERVE_OVERDUE_n'), /\{sum\}/, 'сумма в резерве');
    assert.match(I18N.t(lang, 'warn.W_RESERVE_RESIDUAL_n'), /\{sum\}/);
  }
});

test('TST-56 каталог ratechip: паритет RU/EN, плейсхолдеры одинаковы, у каждого ключа есть использование литералом в коде; ключи не пересекаются с каталогом приложения', () => {
  assert.deepEqual(Object.keys(CAT.ru).sort(), Object.keys(CAT.en).sort());
  const code = ['rate_chip.mjs', 'banner_texts.mjs', 'app.mjs', 'forms.mjs', 'v0.mjs', 'pack_fp16.mjs'].map((f) => fs.readFileSync(path.join(DEMO, f), 'utf8')).join('\n');
  const ph = (s) => [...s.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]).sort();
  for (const k of Object.keys(CAT.ru)) {
    assert.ok(k.startsWith('ratechip.'), k);
    assert.deepEqual(ph(CAT.ru[k]), ph(CAT.en[k]), 'плейсхолдеры ' + k);
    assert.ok(code.includes("'" + k + "'"), 'ключ без использования: ' + k);
    assert.ok(!Object.hasOwn(I18N.STRINGS.ru, k), k);
    assert.equal(I18N.t('ru', k), CAT.ru[k], 'пакет зарегистрировал строки: ' + k);
  }
  assert.doesNotMatch(Object.values(CAT.ru).join(' '), /безопасно|гарантир/i);
});

test('REQ-079 тексты плашек курса — только из каталога: в коде новых модулей нет русских литералов; литерала предела (30) нет — предел из fx.stale_days', () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
  for (const f of ['rate_chip.mjs', 'banner_texts.mjs', 'pack_fp16.mjs']) {
    const src = strip(fs.readFileSync(path.join(DEMO, f), 'utf8'));
    assert.doesNotMatch(src, /[А-Яа-яЁё]/, f + ': русский текст только в i18n/ratechip.mjs');
    assert.doesNotMatch(src, /(^|[^\w.])30([^\w.]|$)/, f + ': литерала 30 нет (предел читается из параметра fx.stale_days)');
  }
  assert.match(fs.readFileSync(path.join(DEMO, 'rate_chip.mjs'), 'utf8'), /'fx\.stale_days'/);
  assert.match(fs.readFileSync(path.join(DEMO, 'banner_texts.mjs'), 'utf8'), /stale_limit\(ws\)/);
});

// FP-17 закрыл бывший `todo` FP-16: предел «курс устарел» читается из словаря (engine/vocab.generated.mjs), литерала в engine/ нет — тест стал обычным; название прежнее.
test('REQ-019 FP-17: литерал 30 в rate_status и rate_warnings переносится в VOCAB пакетом FP-17 (FP-16 движок не меняет)', () => {
  const fx = fs.readFileSync(path.join(HERE, '..', 'engine', 'fx.mjs'), 'utf8');
  const idx = fs.readFileSync(path.join(HERE, '..', 'engine', 'index.mjs'), 'utf8');
  assert.doesNotMatch(fx.slice(fx.indexOf('export function rate_status')), /stale_days = 30/);
  assert.doesNotMatch(idx.slice(idx.indexOf('function rate_warnings')), /: 30;/);
});
