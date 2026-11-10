// fp16_fix.test.mjs — исправления FP-16 после независимой проверки (дефекты D1–D8; REQ-077, REQ-079, REQ-112).
// D1 (средний): остаток на счёте в чужой валюте пересчитывается по курсу даже без единого события в этой валюте — такая сумма тоже подписана курсом, датой и возрастом:
//   сводка курсов (rate_uses) и ответ ассистента, «Остаток на …» в шапке, шов ленты, «Обзор», «Покупка», «В магазине», лист для печати; сценарий курса действует на остаток.
// D2: группа однотипных платежей в «Почему» показывает одну подпись, а не по подписи на платёж. D3: предел «устарел» читается так же, как движок.
// D7: подсказка у выбора формата на v0. D8: пакет строк не загрузился — вместо сырых ключей общий текст ядра; названия раздела форм в статических строках не расходятся с каталогом.
// Браузер, сеть и серверы не используются; ровно один процесс node.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.resolve(HERE, '..');

// ── заглушка DOM (как в fp16_adv.test.mjs) ──────────────────────────────────────────────────────────────────────────────
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
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = String(v); if (k === 'value') this._value = String(v); }
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
const RC = await imp('demo', 'rate_chip.mjs');
const BT = await imp('demo', 'banner_texts.mjs');
const FX = await imp('demo', 'form_fx.mjs');
const V0 = await imp('demo', 'v0.mjs');
const I18N = await imp('demo', 'i18n.mjs');
const E = await imp('engine', 'index.mjs');
const { analyze } = E;

const G = JSON.parse(fs.readFileSync(path.join(PROTO, 'data', 'g001.json'), 'utf8'));
const NB = /[   ]/g;
const plain = (s) => s.replace(NB, ' ');
const tr_ru = (key, params) => I18N.t('ru', key, params);
const tr_en = (key, params) => I18N.t('en', key, params);
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };
const text_of = (id) => plain(byid.get(id).textContent);
const field = (id) => find_all(byid.get('main'), (n) => n.attrs.id === id)[0];

const SIGN = 'курс 0,9250 от 2026-10-01 · возраст 3 дн.';
const GENERIC = 'Суммы в иностранной валюте пересчитаны по введённым курсам: USD → EUR: ' + SIGN;
const BALANCE = 'Остаток пересчитан по введённым курсам: 5 000,00 $ · ' + SIGN;

/**
 * G-001 и долларовый счёт ТОЛЬКО с остатком: якорь 5000,00 $ на 4 октября, ни одного плана, правила или факта в долларах; курс USD→EUR 0,9250 от `rate_date`.
 * Опорный остаток вырастает на 4625,00 € (500000 × 9250 / 10000), вердикт Q3 меняется, а событий с подписью курса нет — случай D1.
 */
function balance_ws({ balance = 500000, rate_date = '2026-10-01', liquidity = 'operating', extra = {} } = {}) {
  const ws = JSON.parse(JSON.stringify(G));
  ws.accounts.push({ account_id: 'acc_usd', name: 'USD', kind: 'bank', liquidity, currency: 'USD', exponent: 2, opened_on: '2026-01-01' });
  ws.anchors.push({ anchor_id: 'a-usd', account_id: 'acc_usd', date: '2026-10-04', amount_minor: balance });
  ws.rates = [{ fx_id: 'r-usd', date: rate_date, base: 'USD', quote: 'EUR', num: 9250, den: 10000 }];
  return { ...ws, ...extra };
}

// ── D1: остаток без событий ────────────────────────────────────────────────────────────────────────────────────────────────

test('D1 остаток 5000,00 $ без событий в долларах: баланс пересчитан по курсу (независимый расчёт), и сводка курсов, примечание к остатку и ответ ассистента его называют', () => {
  const ws = balance_ws();
  const base = APP.build_model(G, { lang: 'ru' });
  const m = APP.build_model(ws, { lang: 'ru' });
  // независимо: 500000 × 9250 / 10000 = 462500 без округления
  assert.equal(m.ctx.series.plan.opening_minor - base.ctx.series.plan.opening_minor, Number(500000n * 9250n / 10000n), 'остаток вошёл в расчёт по курсу');
  assert.equal(RC.fx_by_event(ws, m.ctx, m.ctx.events.plan).size, 0, 'контроль: ни одного пересчитанного события, только остаток');
  assert.equal(RC.fx_by_event(ws, m.ctx, m.ctx.events.worse).size, 0);
  const bal = RC.balance_fx(ws, m.ctx, m.scenario);
  assert.deepEqual(bal, [{ kind: 'operating', account_id: 'acc_usd', cur: 'USD', orig_minor: 500000,
    sig: { cur: 'USD', dec: 'EUR', num: 9250, den: 10000, date: '2026-10-01', age: 3, stale: false, inverse: false, shocked: false } }]);
  const uses = RC.rate_uses(ws, m.ctx, m.scenario);
  assert.equal(uses.length, 1);
  assert.deepEqual([uses[0].cur, uses[0].dec, uses[0].age], ['USD', 'EUR', 3]);
  const env = RC.make_env('ru', ws, m.ctx);
  assert.equal(plain(RC.balance_note_text(tr_ru, env, bal)), BALANCE);
  assert.equal(plain(RC.answer_note_text(tr_ru, env, uses)), GENERIC);
  const q = APP.ask_a0(m, 'Могу ли я купить за 120 на 31 октября?', 'ru', APP.first_income_ref(m));
  assert.equal(q.ok, true);
  assert.equal(plain(q.fx_note), GENERIC, 'под ответом ассистента — курс остатка');
  // английский интерфейс
  assert.equal(plain(RC.balance_note_text(tr_en, RC.make_env('en', ws, m.ctx), bal)), 'The balance is converted at the rates you entered: $5,000.00 · rate 0.9250 of 2026-10-01 · age 3 d');
  // набор G-001: чужих остатков нет — ни остатков, ни сводки, ни примечания
  assert.deepEqual(RC.balance_fx(G, base.ctx, null), []);
  assert.deepEqual(RC.rate_uses(G, base.ctx, null), []);
  assert.equal(RC.balance_note_text(tr_ru, RC.make_env('ru', G, base.ctx), []), '');
  assert.equal(APP.ask_a0(base, 'Могу ли я купить за 120 на 31 октября?', 'ru', APP.first_income_ref(base)).fx_note, undefined);
});

test('D1 на экранах: «Остаток на …» в шапке, шов ленты, «Обзор», «Покупка», «В магазине», лист для печати и ответ ассистента называют курс остатка; у G-001 примечаний нет', async () => {
  assert.equal(ext.ctx.set_ws(balance_ws(), { reason: 'fp16_fix_balance' }).ok, true);
  const summary = text_of('summary');
  assert.ok(summary.includes(BALANCE), 'шапка: ' + summary);
  await go('#feed');
  assert.ok(text_of('main').includes(BALANCE), 'шов ленты');
  await go('#overview');
  assert.ok(text_of('main').includes(GENERIC), 'обзор: ' + text_of('main').slice(0, 300));
  await go('#buy');
  assert.ok(text_of('main').includes(GENERIC), 'покупка: ' + text_of('main').slice(0, 300));
  await go('#store');
  assert.ok(text_of('main').includes(GENERIC), 'в магазине');
  await go('#report');
  assert.match(text_of('main'), /Суммы в иностранной валюте пересчитаны в валюту решения по введённым курсам: USD → EUR: курс 0,9250 от 2026-10-01 · возраст 3 дн\./, 'лист для печати');
  await go('#assistant');
  field('as-q').value = 'Могу ли я купить за 120 на 31 октября?';
  const form = find_all(byid.get('main'), (n) => n.tagName === 'form' && /ask/.test(n.className))[0];
  form.listeners.submit[0]({ preventDefault() {} });
  assert.ok(text_of('main').includes(GENERIC), 'ассистент');
  find_all(byid.get('main'), (n) => n.tagName === 'button' && n.textContent === 'Очистить')[0].listeners.click[0](); // журнал вопросов живёт между наборами данных
  // набор G-001
  assert.equal(ext.ctx.set_ws(JSON.parse(JSON.stringify(G)), { reason: 'fp16_fix_reset' }).ok, true);
  assert.doesNotMatch(text_of('summary'), /возраст \d+ дн\./);
  const NOTE = /возраст \d+ дн\.|пересчитан[ыо] (в валюту решения )?по введённым курсам/;
  for (const r of ['#feed', '#overview', '#buy', '#store', '#report']) {
    await go(r);
    assert.doesNotMatch(text_of('main'), NOTE, r);
  }
  await go('#assistant');
  field('as-q').value = 'Могу ли я купить за 120 на 31 октября?';
  find_all(byid.get('main'), (n) => n.tagName === 'form' && /ask/.test(n.className))[0].listeners.submit[0]({ preventDefault() {} });
  assert.match(text_of('main'), /Покупка 120,00 € на 31 октября/, 'ответ на экране');
  assert.doesNotMatch(text_of('main'), NOTE, 'ассистент у G-001');
});

test('D1 сценарий курса действует на остаток: подпись говорит «с учётом сценария курса», а остаток совпадает с независимым расчётом 5000,00 $ × 0,9250 × 0,95', () => {
  const ws = balance_ws();
  const base = APP.build_model(G, { lang: 'ru' });
  const sc = APP.build_model(ws, { lang: 'ru', scenario: { ops: [{ op: 'fx_shock', currency: 'USD', bp: -500 }] } });
  assert.equal(sc.ctx.series.plan.opening_minor - base.ctx.series.plan.opening_minor, Number(500000n * 9250n * 9500n / (10000n * 10000n)), '4393,75 €');
  const bal = RC.balance_fx(ws, sc.ctx, sc.scenario);
  assert.equal(bal.length, 1);
  assert.equal(bal[0].sig.shocked, true);
  // независимо: 9250/10000 × 9500/10000 = 87 875 000 / 100 000 000 = 703/800 (общий делитель 125 000)
  assert.deepEqual([bal[0].sig.num, bal[0].sig.den], [703, 800], 'курс 0,9250 × 0,95 как несократимая дробь');
  assert.match(plain(RC.balance_note_text(tr_ru, RC.make_env('ru', ws, sc.ctx), bal)), /· с учётом сценария курса$/);
  // без сценария в аргументе подпись — по курсу пары (так её видят экраны без сценария)
  assert.equal(RC.balance_fx(ws, sc.ctx, null)[0].sig.shocked, false);
  assert.equal(RC.rate_uses(ws, sc.ctx, sc.scenario)[0].shocked, true);
});

test('D1 крайние случаи: нулевой остаток курса не просит и подписи не получает; два долларовых счёта дают одну подпись с суммой; накопительный счёт — вклад в «запас», но не в «Остаток на …»', () => {
  // нулевой остаток
  const zero = balance_ws({ balance: 0 });
  const mz = APP.build_model(zero, { lang: 'ru' });
  assert.deepEqual(RC.balance_fx(zero, mz.ctx, null), []);
  assert.deepEqual(RC.rate_uses(zero, mz.ctx, null), []);
  // два операционных счёта в долларах с одним курсом
  const two = balance_ws();
  two.accounts.push({ account_id: 'acc_usd2', name: 'USD2', kind: 'bank', liquidity: 'operating', currency: 'USD', exponent: 2, opened_on: '2026-01-01' });
  two.anchors.push({ anchor_id: 'a-usd2', account_id: 'acc_usd2', date: '2026-10-04', amount_minor: 100000 });
  const m2 = APP.build_model(two, { lang: 'ru' });
  const bal2 = RC.balance_fx(two, m2.ctx, null);
  assert.equal(bal2.length, 2);
  assert.deepEqual(RC.balance_groups(bal2).map((g) => [g.cur, g.orig_minor]), [['USD', 600000]]);
  assert.equal(plain(RC.balance_note_text(tr_ru, RC.make_env('ru', two, m2.ctx), bal2)), 'Остаток пересчитан по введённым курсам: 6 000,00 $ · ' + SIGN);
  assert.equal(RC.rate_uses(two, m2.ctx, null).length, 1, 'сводка курсов не повторяет один курс');
  // накопительный счёт в долларах: вклад в запас, в опорный остаток не входит
  const sav = balance_ws({ liquidity: 'savings' });
  const ms = APP.build_model(sav, { lang: 'ru' });
  const bs = RC.balance_fx(sav, ms.ctx, null);
  assert.deepEqual(bs.map((b) => [b.kind, b.cur, b.orig_minor]), [['stock', 'USD', 500000]]);
  assert.equal(RC.balance_note_text(tr_ru, RC.make_env('ru', sav, ms.ctx), bs), '', 'запас не входит в «Остаток на …»');
  assert.equal(RC.rate_uses(sav, ms.ctx, null).length, 1, 'но курс запаса назван в сводке курсов');
  // актив при 0 bp в запас не входит — пересчитанной суммы нет
  const asset = balance_ws({ liquidity: 'asset' });
  assert.deepEqual(RC.balance_fx(asset, APP.build_model(asset, { lang: 'ru' }).ctx, null), []);
  // нет курса пары: подпись пропускается без исключения (отказ расчёту называет E_NO_RATE)
  const norate = { ...balance_ws(), rates: [] };
  assert.doesNotThrow(() => RC.balance_fx(norate, APP.build_model(G, { lang: 'ru' }).ctx, null));
  assert.throws(() => analyze(norate, { as_of: norate.as_of }), (e) => e.code === 'E_NO_RATE');
});

test('D1 устаревший курс остатка: подпись «курс устарел» и плашка W_RATE_STALE согласны; формат чисел пользователя применяется к остатку', () => {
  const old = balance_ws({ rate_date: '2026-08-01' });
  const a = analyze(old, { as_of: old.as_of });
  assert.equal(a.warnings.some((w) => w.code === 'W_RATE_STALE'), true);
  const bal = RC.balance_fx(old, a, null);
  assert.equal(bal[0].sig.stale, true);
  assert.equal(bal[0].sig.age, 64);
  assert.match(plain(RC.balance_note_text(tr_ru, RC.make_env('ru', old, a), bal)), /возраст 64 дн\. · курс устарел$/);
  const nf = balance_ws({ extra: { number_format: { decimal: ',', thousands: '.' } } });
  const m = APP.build_model(nf, { lang: 'ru' });
  assert.equal(plain(RC.balance_note_text(tr_ru, RC.make_env('ru', nf, m.ctx), RC.balance_fx(nf, m.ctx, null))), 'Остаток пересчитан по введённым курсам: 5.000,00 $ · ' + SIGN);
});

// ── D2: группа платежей в «Почему» ──────────────────────────────────────────────────────────────────────────────────────────

/** G-001 с долларовым счётом и еженедельным расходом −500,00 $ (по средам) — группа «Подписка × N» в «Почему». */
function weekly_ws() {
  const ws = balance_ws({ balance: 0 });
  ws.rules = [...ws.rules, { rule_id: 'R-USDW', version: 1, account_id: 'acc_usd', name: 'Подписка', kind: 'expense', amount: { exp_minor: -50000 }, currency: 'USD', freq: 'W', interval: 1,
    month_end: 'clamp', weekend: 'next', calendar_id: 'cal-main', exdates: [], is_obligation: true, is_estimate: false, tag: 'sub', start_date: '2026-09-01', by_weekday: [3] }];
  return ws;
}

test('D2 dedupe_fx склеивает одинаковые пересчёты (сумма, курс, дата), различные оставляет; chip_node дописывает « × N» только по просьбе', () => {
  const sig = (date, num = 9250) => ({ cur: 'USD', dec: 'EUR', num, den: 10000, date, age: 3, stale: false, inverse: false, shocked: false });
  const a = { cur: 'USD', orig_minor: -50000, sig: sig('2026-10-01') };
  const same = { ...a };
  const other_sum = { cur: 'USD', orig_minor: -70000, sig: sig('2026-10-01') };
  const other_rate = { cur: 'USD', orig_minor: -50000, sig: sig('2026-10-02', 9300) };
  const out = RC.dedupe_fx([a, same, other_sum, a, other_rate]);
  assert.deepEqual(out.map((x) => [x.orig_minor, x.sig.date, x.count]), [[-50000, '2026-10-01', 3], [-70000, '2026-10-01', 1], [-50000, '2026-10-02', 1]]);
  assert.deepEqual(RC.dedupe_fx([]), []);
  assert.deepEqual(RC.dedupe_fx(undefined), []);
  const env = { lang: 'ru', nf: undefined, dec: 'EUR', as_of: 0, as_of_iso: '2026-10-04' };
  const node = (fx, with_count) => plain(RC.chip_node(tr_ru, env, fx, with_count).textContent);
  assert.equal(node(out[0], true), '−500,00 $ · ' + SIGN + ' × 3');
  assert.equal(node(out[0], false), '−500,00 $ · ' + SIGN, 'без просьбы число не дописывается');
  assert.equal(node(out[1], true), '−700,00 $ · ' + SIGN, 'одиночная подпись без « × 1»');
});

test('D2 «Почему»: еженедельный платёж в долларах — одна подпись на строку цепочки и контрфакта, а не по подписи на каждое событие', async () => {
  const ws = weekly_ws();
  const model = APP.build_model(ws, { lang: 'ru' });
  const why = APP.explain_model(model, 'worse', 'ru');
  const row = why.chain.find((c) => c.name === 'Подписка');
  assert.ok(row !== undefined && row.count > 1, 'группа из нескольких платежей');
  assert.equal(row.fx.length, 1, 'платежи одинаковы по сумме, курсу и дате курса');
  assert.equal(row.fx[0].count, row.count, 'склеено столько подписей, сколько платежей в группе');
  const cf = why.counterfactuals.find((c) => c.kind === 'without' && c.name === 'Подписка');
  if (cf !== undefined) assert.equal(cf.fx.length, 1);
  // на экране: ни в одной строке диалога нет двух одинаковых подписей
  assert.equal(ext.ctx.set_ws(ws, { reason: 'fp16_fix_weekly' }).ok, true);
  await go('#overview');
  const btn = find_all(byid.get('main'), (n) => n.tagName === 'button' && n.textContent === 'почему?');
  assert.ok(btn.length >= 2);
  btn[1].listeners.click[0]();
  const rows = find_all(byid.get('dlg-body'), (n) => n.tagName === 'th' && n.attrs.scope === 'row');
  const chips_in = (th) => find_all(th, (n) => String(n.className).includes('rate-chip')).map((n) => plain(n.textContent));
  const with_chips = rows.map(chips_in).filter((c) => c.length > 0);
  assert.ok(with_chips.length >= 1, 'подпись курса в диалоге есть');
  for (const c of with_chips) assert.equal(new Set(c).size, c.length, 'одинаковые подписи в строке не повторяются: ' + JSON.stringify(c));
  assert.ok(with_chips.every((c) => c.length === 1), 'в строке одна подпись');
  assert.equal(ext.ctx.set_ws(JSON.parse(JSON.stringify(G)), { reason: 'fp16_fix_reset' }).ok, true);
});

// ── D3: предел «устарел» ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('D3 предел fx.stale_days читается как в движке: безопасное неотрицательное целое, иначе запасное значение движка; подпись, плашка и таблица курсов согласны', () => {
  const lim = (v) => RC.stale_limit({ params: { 'fx.stale_days': v } });
  for (const v of [0, 1, 12, 3660]) assert.equal(lim(v), v, 'допустимое значение ' + v);
  for (const v of ['abc', '30', null, undefined, -5, -1, 1.5, NaN, Infinity, 2 ** 60, true, [], {}]) assert.equal(lim(v), undefined, 'недопустимое: ' + String(v));
  assert.equal(RC.stale_limit({ params: { fx: { stale_days: 7 } } }), 7, 'вложенная запись параметра');
  assert.equal(RC.stale_limit(undefined), undefined);
  assert.equal(RC.stale_limit({}), undefined);
  assert.equal(FX.stale_days_of({ params: { 'fx.stale_days': 'abc' } }), undefined, 'таблица курсов использует ту же функцию');
  assert.equal(FX.stale_days_of({ params: { 'fx.stale_days': 9 } }), 9);
  // согласие с движком: W_RATE_STALE и пометка «курс устарел» у суммы совпадают при любом значении параметра
  for (const v of [0, 3, 4, 63, 64, 'abc', null, -5, undefined]) { // дробное значение движок не принимает вовсе (E_NOT_INTEGER в inputs_hash)
    for (const date of ['2026-08-01', '2026-09-30']) { // возраст 64 и 4 дня
      const ws = balance_ws({ rate_date: date, extra: { params: { ...G.params, 'fx.stale_days': v } } });
      const a = analyze(ws, { as_of: ws.as_of });
      const engine = a.warnings.some((w) => w.code === 'W_RATE_STALE');
      assert.equal(RC.balance_fx(ws, a, null)[0].sig.stale, engine, `fx.stale_days=${String(v)}, курс от ${date}`);
      assert.equal(FX.rate_rows(ws, a.as_of).find((r) => r.base === 'USD').stale, engine, `таблица курсов согласна с движком: fx.stale_days=${String(v)}, курс от ${date}`);
      if (engine) assert.match(BT.rate_stale_text(tr_ru, ws, a, a.warnings.find((x) => x.code === 'W_RATE_STALE')), /не обновлялся (4|64) дн\./, 'плашка называет возраст');
    }
  }
});

// ── D7: подсказка у выбора формата на v0 ─────────────────────────────────────────────────────────────────────────────────────

test('D7 v0: у выбора формата чисел и дат есть подсказка «действует со следующей отправки»; суммы той же отправки читаются по прежнему формату (граница задокументирована)', () => {
  for (const lang of ['ru', 'en']) {
    const s = V0.tr(lang, 'v0.h_numfmt');
    assert.notEqual(s, 'v0.h_numfmt', lang);
    assert.ok(s.length > 40, lang);
  }
  assert.match(V0.tr('ru', 'v0.h_numfmt'), /[А-Яа-я]/);
  const src = fs.readFileSync(path.join(PROTO, 'demo', 'v0.mjs'), 'utf8');
  assert.match(src, /'v0\.h_numfmt'/, 'ключ используется литералом');
  // поведение: сумма той же отправки разбирается по прежнему формату (по языку), выбранный формат применяется со следующей отправки
  const ok = V0.parse_top({ as_of: '2026-10-04', balance: '5000,50', buffer: '', horizon: '60', numfmt: 'dot_comma', datefmt: 'auto' }, { cur: 'EUR', lang: 'ru' });
  assert.equal(ok.ok, true, JSON.stringify(ok.error));
  assert.equal(ok.value.balance_minor, 500050);
  assert.deepEqual(ok.value.number_format, { decimal: ',', thousands: '.' });
  const page = V0.boot_v0();
  assert.ok(find_all(byid.get('main'), (n) => n.tagName === 'p' && plain(n.textContent) === plain(V0.tr(page.lang, 'v0.h_numfmt'))).length === 1, 'подсказка на странице v0 ровно одна');
});

// ── D8: пакет строк не загрузился; названия раздела форм ─────────────────────────────────────────────────────────────────────

test('D8 нет каталога пакета: «нет курса» и «курс устарел» не показывают сырой ключ — общий текст ядра, где путь к курсам написан целиком', () => {
  const core = { 'err.E_NO_RATE': 'ОБЩИЙ ТЕКСТ ЯДРА' };
  const bare = (key) => (Object.hasOwn(core, key) ? core[key] : key); // каталог без пакетов FP-08 и FP-16: неизвестный ключ возвращается как есть
  assert.equal(BT.no_rate_text(bare, { pair: 'USD/EUR' }), 'ОБЩИЙ ТЕКСТ ЯДРА');
  assert.equal(BT.no_rate_text(bare, null), 'ОБЩИЙ ТЕКСТ ЯДРА');
  const ws = balance_ws({ rate_date: '2026-08-01' });
  const a = analyze(ws, { as_of: ws.as_of });
  assert.equal(BT.rate_stale_text(bare, ws, a, { code: 'W_RATE_STALE', currency: 'USD' }), null, 'вызывающий берёт общий текст предупреждения');
  // с каталогом всё по-прежнему
  assert.equal(BT.no_rate_text(tr_ru, { pair: 'USD/EUR' }), 'Нет курса USD → EUR: введите его — Формы данных → Курсы и обмен.');
  assert.match(plain(BT.rate_stale_text(tr_ru, ws, a, { code: 'W_RATE_STALE', currency: 'USD' })), /^Курс USD → EUR не обновлялся 64 дн\./);
});

test('D8 статические строки про курсы называют раздел «Формы данных» и вкладку курсов теми же словами, что каталог форм (переименование не разведёт тексты)', () => {
  for (const lang of ['ru', 'en']) {
    const nav = I18N.t(lang, 'forms.nav');
    const tab = I18N.t(lang, 'forms.tab_fx');
    assert.notEqual(nav, 'forms.nav');
    assert.notEqual(tab, 'forms.tab_fx');
    for (const key of ['err.E_NO_RATE', 'warn.W_RATE_STALE', 'entry.err_no_rate', 'forms.err_E_NO_RATE', 'debtedit.r_no_rate']) {
      const s = I18N.t(lang, key);
      assert.ok(s.includes(nav), `${key} ${lang}: «${nav}»`);
      assert.ok(s.includes(tab), `${key} ${lang}: «${tab}»`);
    }
  }
});

test('D5 справочно: литерал предела «устарел» перенесён в словарь пакетом FP-17 (в движке его больше нет), в демо-коде FP-16 литерала тоже нет', () => {
  const read = (...p) => fs.readFileSync(path.join(PROTO, ...p), 'utf8');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
  for (const f of ['rate_chip.mjs', 'banner_texts.mjs', 'pack_fp16.mjs', 'form_fx.mjs']) assert.doesNotMatch(strip(read('demo', f)), /(^|[^\w.])30([^\w.]|$)/, f);
  assert.doesNotMatch(read('engine', 'fx.mjs'), /stale_days = 30/, 'литерал перенесён в словарь (engine/vocab.generated.mjs) пакетом FP-17');
  assert.match(read('engine', 'fx.mjs'), /stale_days = vd\('fx\.stale_days'\)/, 'предел по умолчанию читается из словаря');
});
