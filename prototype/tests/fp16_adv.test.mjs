// fp16_adv.test.mjs — независимая состязательная проверка FP-16 (подпись курса и возраста, формат чисел и дат на всех поверхностях; REQ-077, REQ-079, REQ-112).
// Часть 1 — числа, посчитанные другим путём (BigInt вручную, без rate_chip): пересчёт, сценарий курса, валюта без дробной части, курс из «будущего», граница «устарел».
// Часть 2 — верификатор с форматом пользователя: свойство «сумма проходит только по своему значению», чужой формат — нарушение, недоверенная настройка отбрасывается.
// Часть 3 — недоверенный ввод: пара валют в сообщении «нет курса», файл v0 с недопустимым number_format.
// Часть 4 — найденные дефекты D1–D3: были todo, после исправления (fp16_fix) стали обычными проверками.
// Браузер, сеть и серверы не используются; ровно один процесс node.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.resolve(HERE, '..');

// ── заглушка DOM (как в fx_labels.test.mjs) ─────────────────────────────────────────────────────────────────────────────
class Node_ {
  constructor(tag, ns) {
    this.nodeType = 1; this.tagName = tag; this.ns = ns ?? null; this.attrs = {}; this.children = []; this.listeners = {}; this.className = '';
    this._text = ''; this._value = ''; this._sel = null; this.open = false;
  }
  get textContent() { return this.children.length === 0 ? this._text : this.children.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get value() { return this._value; }
  set value(v) { this._value = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = String(v); }
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
const V0 = await imp('demo', 'v0.mjs');
const I18N = await imp('demo', 'i18n.mjs');
const VER = await imp('engine', 'verifier.mjs');
const E = await imp('engine', 'index.mjs');
const { analyze } = E;

const G = JSON.parse(fs.readFileSync(path.join(PROTO, 'data', 'g001.json'), 'utf8'));
const NB = /[  ]/g;
const plain = (s) => s.replace(NB, ' ');
const tr_ru = (key, params) => I18N.t('ru', key, params);
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };
const field = (id) => find_all(byid.get('main'), (n) => n.attrs.id === id)[0];

/** G-001 с долларовым счётом, курс USD→EUR 0,9250 от `rate_date`; доход 2000,00 $ на 20 октября; недельный расход 500,00 $ (по средам). */
function usd_ws(rate_date = '2026-10-01', extra = {}, weekly = true) {
  return {
    ...G,
    accounts: [...G.accounts, { account_id: 'acc_usd', name: 'USD', kind: 'bank', liquidity: 'operating', currency: 'USD', exponent: 2, opened_on: '2026-01-01' }],
    anchors: [...G.anchors, { anchor_id: 'a-usd', account_id: 'acc_usd', date: '2026-10-04', amount_minor: 0 }],
    rates: [...(G.rates ?? []), { fx_id: 'r-usd', date: rate_date, base: 'USD', quote: 'EUR', num: 9250, den: 10000 }],
    rules: weekly
      ? [...G.rules, { rule_id: 'R-USDW', version: 1, account_id: 'acc_usd', name: 'Подписка', kind: 'expense', amount: { exp_minor: -50000 }, currency: 'USD', freq: 'W', interval: 1,
        month_end: 'clamp', weekend: 'next', calendar_id: 'cal-main', exdates: [], is_obligation: true, is_estimate: false, tag: 'sub', start_date: '2026-09-01', by_weekday: [3] }]
      : G.rules,
    plans: [...(G.plans ?? []), { plan_id: 'U-INC', account_id: 'acc_usd', name: 'Доллары', date: '2026-10-20', amount_minor: 200000, currency: 'USD', kind: 'income', tag: 'usd' }],
    ...extra,
  };
}

// ── часть 1: числа другим путём ─────────────────────────────────────────────────────────────────────────────────────────────

/** Независимый пересчёт minor: round-half-even на BigInt (без convert_minor движка), для валют с одинаковой экспонентой. */
function half_even(num, den) {
  const q = num / den;
  const r = num % den;
  const twice = 2n * (r < 0n ? -r : r);
  if (twice < den) return q;
  if (twice > den) return num < 0n ? q - 1n : q + 1n;
  return q % 2n === 0n ? q : (num < 0n ? q - 1n : q + 1n);
}

test('FP-16 adv: пересчитанная сумма в подписи совпадает с независимым BigInt-расчётом (доход, расход, сценарий курса −500 bp); возраст = разности дат', () => {
  const ws = usd_ws();
  const model = APP.build_model(ws, { lang: 'ru' });
  const fx = RC.fx_by_event(ws, model.ctx, model.ctx.events.plan);
  const inc = fx.get('U-INC');
  assert.equal(BigInt(inc.conv_minor), half_even(200000n * 9250n, 10000n), '2000,00 $ × 0,9250');
  assert.equal(inc.conv_minor, 185000);
  // независимый возраст: 2026-10-04 − 2026-10-01 = 3 дня
  assert.equal(inc.sig.age, Math.round((Date.UTC(2026, 9, 4) - Date.UTC(2026, 9, 1)) / 86400000));
  const weekly = [...fx.entries()].filter(([id]) => id.startsWith('R-USDW@'));
  assert.ok(weekly.length >= 8, 'недельный расход: ' + weekly.length + ' вхождений в горизонте');
  for (const [, x] of weekly) assert.equal(BigInt(x.conv_minor), half_even(-50000n * 9250n, 10000n), '−500,00 $ → −462,50 €');
  // сценарий курса: 9250 × (10000 − 500) / 10000 = 8787,5 (дробь не сокращается до целого, но итог — по половинке к чётному)
  const sc = APP.build_model(ws, { lang: 'ru', scenario: { ops: [{ op: 'fx_shock', currency: 'USD', bp: -500 }] } });
  const sx = RC.fx_by_event(ws, sc.ctx, sc.ctx.events.plan).get('U-INC');
  assert.equal(sx.sig.shocked, true);
  assert.equal(BigInt(sx.conv_minor), half_even(200000n * 9250n * 9500n, 10000n * 10000n), '2000,00 $ × 0,9250 × 0,95 = 1757,50 €');
  assert.equal(sx.conv_minor, 175750);
  assert.equal(RC.fx_by_event(ws, model.ctx, model.ctx.events.plan).get('U-INC').sig.shocked, false, 'без сценария флага нет');
});

test('FP-16 adv: валюта без дробной части (JPY) и курс из «будущего»: подпись по курсу на дату расчёта, курс следующей недели не подставляется', () => {
  const ws = JSON.parse(JSON.stringify(G));
  ws.accounts.push({ account_id: 'acc_jpy', name: 'JPY', kind: 'bank', liquidity: 'operating', currency: 'JPY', exponent: 0, opened_on: '2026-01-01' });
  ws.anchors.push({ anchor_id: 'a-j', account_id: 'acc_jpy', date: '2026-10-04', amount_minor: 0 });
  ws.rates = [{ fx_id: 'rj0', date: '2026-10-01', base: 'JPY', quote: 'EUR', num: 62, den: 10000 }, { fx_id: 'rj1', date: '2026-10-09', base: 'JPY', quote: 'EUR', num: 100, den: 10000 }];
  ws.plans.push({ plan_id: 'J-1', account_id: 'acc_jpy', name: 'Токио', date: '2026-10-20', amount_minor: -150000, currency: 'JPY', kind: 'expense', tag: 'jp', is_obligation: true });
  const m = APP.build_model(ws, { lang: 'ru' });
  const x = RC.fx_by_event(ws, m.ctx, m.ctx.events.plan).get('J-1');
  assert.equal(x.sig.date, '2026-10-01', 'курс от 9 октября позже даты расчёта: не spot');
  assert.equal(x.conv_minor, -93000, '150 000 JPY × 0,0062 = 930,00 €');
  const env = RC.make_env('ru', ws, m.ctx);
  assert.equal(plain(RC.row_text(tr_ru, env, x)), '−150 000 JPY · курс 0,0062 от 2026-10-01 · возраст 3 дн.');
});

test('FP-16 adv: граница «устарел» по умолчанию (без fx.stale_days): возраст 30 — ещё нет, 31 — да; подпись и W_RATE_STALE движка согласны', () => {
  for (const [date, age, stale] of [['2026-09-04', 30, false], ['2026-09-03', 31, true]]) {
    const ws = usd_ws(date);
    const a = analyze(ws, { as_of: ws.as_of });
    const x = RC.fx_by_event(ws, a, a.events.plan).get('U-INC');
    assert.deepEqual([x.sig.age, x.sig.stale], [age, stale], date);
    assert.equal(a.warnings.some((w) => w.code === 'W_RATE_STALE'), stale, 'движок: ' + date);
    const w = a.warnings.find((v) => v.code === 'W_RATE_STALE');
    if (stale) assert.match(plain(BT.rate_stale_text(tr_ru, ws, a, w)), new RegExp('не обновлялся ' + age + ' дн\\.'));
  }
});

test('FP-16 adv: набор G-001 без чужой валюты — на экранах нет ни подписи, ни примечания о курсах', async () => {
  assert.equal(ext.ctx.set_ws(JSON.parse(JSON.stringify(G)), { reason: 'adv_g001' }).ok, true);
  for (const r of ['#overview', '#feed', '#waves', '#assistant', '#report']) {
    await go(r);
    assert.doesNotMatch(byid.get('main').textContent, /возраст \d+ дн\.|пересчитан[ыо] (в валюту решения )?по введённым курсам|Пересчёт по курсу/, r);
  }
  field('as-q'); // экран «Ассистент» на месте
});

// ── часть 2: верификатор ────────────────────────────────────────────────────────────────────────────────────────────────────

const NFS = [
  { decimal: ',', thousands: ' ' }, { decimal: '.', thousands: ',' }, { decimal: ',', thousands: '.' }, { decimal: '.', thousands: '' }, { decimal: ',', thousands: '' },
  { decimal: '.', thousands: ' ' }, { decimal: ',', thousands: '.', date: 'dmy' }, { decimal: '.', thousands: ',', date: 'mdy' }, { date: 'iso' },
];

test('FP-16 adv: сумма проходит слой 2 только по своему значению — в любом формате и обоих языках (перебор 1 500 значений на формат)', () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  const values = [0, 1, 99, 100, 101, 99999, 100000, 123450, 99999999, 100000000];
  for (let i = 0; i < 140; i++) values.push(rnd() % 1000000000);
  for (const nf of NFS) {
    for (const lang of ['ru', 'en']) {
      for (const v of values) {
        const ev = { id: 'e1', kind: 'money', v, cur: 'EUR', dp: 2 };
        const good = 'Итого ' + VER.render_value(ev, lang, '2026-10-04', nf) + '.';
        assert.deepEqual(VER.verify_text(good, [ev], lang, nf), [], `${good} ${lang} ${JSON.stringify(nf)}`);
        const other = { ...ev, v: v + 1 };
        const bad = VER.verify_text('Итого ' + VER.render_value(other, lang, '2026-10-04', nf) + '.', [ev], lang, nf);
        assert.deepEqual(bad.map((x) => x.code), ['V_NO_MATCH'], `v+1 ${v} ${lang} ${JSON.stringify(nf)}`);
      }
    }
  }
});

test('FP-16 adv: число в чужом формате не принимается за верное — «1.234,50» при формате «1,234.50» и «1,234.50» при «1.234,50» — V_AMBIGUOUS_NUMBER, а не тихое совпадение', () => {
  const ev = { id: 'e1', kind: 'money', v: 123450, cur: 'EUR', dp: 2 };
  const A = { decimal: ',', thousands: '.' };
  const B = { decimal: '.', thousands: ',' };
  for (const lang of ['ru', 'en']) {
    assert.deepEqual(VER.verify_text('Итого 1.234,50 €.', [ev], lang, B).map((x) => x.code), ['V_AMBIGUOUS_NUMBER'], lang);
    assert.deepEqual(VER.verify_text('Итого 1,234.50 €.', [ev], lang, A).map((x) => x.code), ['V_AMBIGUOUS_NUMBER'], lang);
    // группа не из трёх цифр — не число формата
    assert.deepEqual(VER.verify_text('Итого 12.34,50 €.', [ev], lang, A).map((x) => x.code), ['V_AMBIGUOUS_NUMBER'], lang);
    // «1234.50» при формате без групп и точкой — совпадение; запятая вместо точки — нарушение
    assert.deepEqual(VER.verify_text('Итого 1234.50 €.', [ev], lang, { decimal: '.', thousands: '' }), [], lang);
    assert.deepEqual(VER.verify_text('Итого 1234,50 €.', [ev], lang, { decimal: '.', thousands: '' }).map((x) => x.code), ['V_AMBIGUOUS_NUMBER'], lang);
  }
});

test('FP-16 adv: недоверенная настройка (лишний ключ, пара не целиком, одинаковые разделители, произвольный символ, прототип) отбрасывается целиком — вывод как без настройки', () => {
  const ev = { kind: 'money', v: 123450, cur: 'EUR', dp: 2 };
  const base = VER.render_value(ev, 'ru', '2026-10-04');
  const junk = [{ decimal: ',', thousands: ',' }, { decimal: ',' }, { thousands: '.' }, { decimal: '٫', thousands: '٬' }, { decimal: ',', thousands: '.', evil: 1 },
    { decimal: ',', thousands: '.', date: 'yyyy' }, Object.create({ decimal: ',', thousands: '.' }), JSON.parse('{"__proto__": {"decimal": ",", "thousands": "."}}'), [',', '.'], 'dot_comma', 7];
  for (const nf of junk) assert.equal(VER.render_value(ev, 'ru', '2026-10-04', nf), base, JSON.stringify(nf));
  // и в слое 2 тот же текст по языку проходит, а текст «в формате мусора» — нет
  assert.deepEqual(VER.verify_text('Итого ' + base + '.', [{ id: 'e1', ...ev }], 'ru', junk[0]), []);
});

// ── часть 3: недоверенный ввод ───────────────────────────────────────────────────────────────────────────────────────────────

test('FP-16 adv: сообщение «нет курса» и плашка курса не пропускают текст пользователя — только коды валют по шаблону', () => {
  for (const c of [{ pair: '<img src=x onerror=1>/EUR' }, { pair: 'USD/<b>' }, { currency: '<b>x</b>', decision_currency: 'EUR' }, { from: 'usd', to: 'EUR' }, { pair: 'USD/EUR\nHTTP' }, { pair: 'A'.repeat(40) + '/EUR' }, null, undefined, 5, 'USD/EUR']) {
    const t = BT.no_rate_text(tr_ru, c);
    assert.doesNotMatch(t, /[<>\n]|onerror|HTTP|AAAA/, JSON.stringify(c));
    assert.match(t, /Формы данных → Курсы и обмен/);
  }
  assert.equal(BT.no_rate_text(tr_ru, { pair: 'USD/EUR' }), 'Нет курса USD → EUR: введите его — Формы данных → Курсы и обмен.');
  const ws = usd_ws('2026-08-01');
  const a = analyze(ws, { as_of: ws.as_of });
  assert.equal(BT.rate_stale_text(tr_ru, ws, a, { code: 'W_RATE_STALE', currency: '"><script>' }), null);
  assert.equal(BT.rate_stale_text(tr_ru, ws, a, { code: 'W_RATE_STALE', currency: 'USD‮' }), null);
});

test('FP-16 adv: v0 — файл состояния с недопустимым number_format отвергается; чужой ws с недопустимым форматом открывается в формате языка', () => {
  const ok = { v: 1, as_of: '2026-10-04', currency: 'EUR', horizon_days: 30, balance_minor: 100000, buffer_minor: 0, payments: [], incomes: [], reserves: [], purchase: null };
  assert.equal(V0.form_is_valid(ok), true, 'контроль: форма без формата допустима');
  assert.equal(V0.form_is_valid({ ...ok, number_format: { decimal: ',', thousands: '.' } }), true);
  assert.equal(V0.form_is_valid({ ...ok, number_format: null }), true);
  for (const nf of [{ decimal: ',', thousands: ',' }, { decimal: ',' }, { x: 1 }, 'dot_comma', [], 5]) assert.equal(V0.form_is_valid({ ...ok, number_format: nf }), false, JSON.stringify(nf));
  const f = V0.make_v0_fmt('ru', 'EUR', '2026-10-04', { decimal: ',', thousands: ',' });
  assert.equal(plain(f.money(123450)), '1 234,50 €', 'недопустимый формат — по языку');
  assert.equal(plain(V0.make_v0_fmt('ru', 'EUR', '2026-10-04', { decimal: ',', thousands: '.' }).money(123450)), '1.234,50 €');
});

// ── часть 4: найденные дефекты D1–D3 (исправлены; дополнительные проверки — tests/fp16_fix.test.mjs) ────────────────────────────────────────────────────────────────────────────────────────

test('FP-16 adv D1: остаток на счёте в чужой валюте пересчитывается по курсу, и расчёт это называет (примечание под ответом, лист для печати)', () => {
  const ws = JSON.parse(JSON.stringify(G));
  ws.accounts.push({ account_id: 'acc_usd', name: 'USD', kind: 'bank', liquidity: 'operating', currency: 'USD', exponent: 2, opened_on: '2026-01-01' });
  ws.anchors.push({ anchor_id: 'a-usd', account_id: 'acc_usd', date: '2026-10-04', amount_minor: 500000 });
  ws.rates = [{ fx_id: 'r-usd', date: '2026-10-01', base: 'USD', quote: 'EUR', num: 9250, den: 10000 }];
  const base = APP.build_model(G, { lang: 'ru' });
  const m = APP.build_model(ws, { lang: 'ru' });
  assert.equal(m.ctx.series.plan.opening_minor - base.ctx.series.plan.opening_minor, 462500, 'остаток 5000,00 $ вошёл в расчёт по курсу 0,9250 (контроль)');
  const q = APP.ask_a0(m, 'Могу ли я купить за 120 на 31 октября?', 'ru', APP.first_income_ref(m));
  assert.equal(q.ok, true);
  assert.ok(typeof q.fx_note === 'string' && /USD → EUR/.test(q.fx_note), 'примечание о курсе под ответом: ' + String(q.fx_note));
  assert.ok(RC.rate_uses(ws, m.ctx).length > 0, 'сводка курсов расчёта называет USD → EUR');
});

test('FP-16 adv D2: в «Почему» группа однотипных платежей в чужой валюте показывает подпись один раз (с числом), а не четыре одинаковые строки', () => {
  const ws = usd_ws();
  const model = APP.build_model(ws, { lang: 'ru' });
  const why = APP.explain_model(model, 'worse', 'ru');
  const row = why.chain.find((c) => c.name === 'Подписка');
  assert.ok(row !== undefined && row.count > 1);
  const env = RC.make_env('ru', ws, model.ctx);
  const texts = (row.fx ?? []).map((x) => RC.row_text(tr_ru, env, x));
  assert.equal(new Set(texts).size, texts.length, 'одинаковые подписи не повторяются: ' + JSON.stringify(texts));
});

test('FP-16 adv D3: недопустимое значение fx.stale_days в данных читается так же, как движок (запасное значение), а не сравнивается как есть', () => {
  for (const v of ['abc', null, -5]) {
    for (const date of ['2026-08-01', '2026-09-30']) { // возраст 64 и 4 дня
      const ws = usd_ws(date, { params: { ...G.params, 'fx.stale_days': v } }, false);
      const a = analyze(ws, { as_of: ws.as_of });
      const x = RC.fx_by_event(ws, a, a.events.plan).get('U-INC');
      const engine = a.warnings.some((w) => w.code === 'W_RATE_STALE');
      assert.equal(x.sig.stale, engine, `fx.stale_days=${JSON.stringify(v)}, курс от ${date}: подпись ${x.sig.stale}, движок ${engine}`);
    }
  }
});
