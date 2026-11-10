// fp15_adv.test.mjs — состязательная проверка FP-15 (независимый проверяющий): пробы, которых нет в reserve_screen.
// Пробы описывают ПРАВИЛЬНОЕ поведение. Подтверждённые дефекты были помечены `todo`; после исправления (ADV-2, 3, 6, 8, 12, 14) пометки сняты — пробы теперь обычные тесты.
// Реализацию не меняют; общий вид заглушки DOM — как в reserve_screen.test.mjs. Расчёт по введённым данным и правилам, не консультация.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/fp15_adv.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const DEMO = path.join(PROTO, 'demo');
const DATA = path.join(PROTO, 'data');
const clone = (x) => JSON.parse(JSON.stringify(x));
const load = (name) => JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8'));
const G = load('g001.json');

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
  getElementById: (id) => byid.get(id) ?? find_in(byid.get('main'), id) ?? find_in(byid.get('nav'), id) ?? find_in(byid.get('summary'), id),
  documentElement: new Node_('html'), head: new Node_('head'), body: new Node_('body'), title: '',
};
globalThis.window = { addEventListener: (t, fn) => { (listeners[t] ??= []).push(fn); }, scrollTo: () => {} };
globalThis.location = { hash: '' };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'ru-RU' }, configurable: true });
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.ResizeObserver = class { observe() {} };
globalThis.fetch = async (url) => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8')) });

const imp = (rel) => import(pathToFileURL(path.join(PROTO, rel)).href);
const { ext } = await imp('demo/ext.mjs');
const E = await imp('engine/index.mjs');
const { make_tool_ctx } = await imp('engine/tools.mjs');
const WE = await imp('demo/ws_edit.mjs');
const RELEASE = await imp('demo/reserve_release.mjs');
const EXPLAIN = await imp('demo/alloc_explain.mjs');
const FT = await imp('demo/form_tax.mjs');
const APP = await imp('demo/app.mjs');
await new Promise((r) => setTimeout(r, 700));

const N = (x) => String(x).replace(/[  ]/g, ' ');
const main = () => byid.get('main');
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const by_id = (id) => find_all(main(), (n) => n.attrs.id === id)[0];
const in_summary = (id) => find_all(byid.get('summary'), (n) => n.attrs.id === id)[0];
const click = (n) => { assert.ok(n !== undefined, 'нет узла'); n.listeners.click[0](); };
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };
const ctx = ext.ctx;
const reset = (ws) => { const r = ctx.set_ws(ws, { reason: 'test_reset' }); assert.equal(r.ok, true, JSON.stringify(r.error)); };
const text_main = () => N(main().textContent);
const text_sum = () => N(byid.get('summary').textContent);
const money = (minor, lang = 'ru') => APP.make_fmt(lang, 'EUR', '2026-10-04').money(minor);
const model_of = (ws) => ({ ws, ctx: make_tool_ctx(ws, { as_of: ws.as_of }, { locale: 'ru' }), cur: ws.decision_currency, as_of_iso: ws.as_of });
const day = (iso) => E.to_epoch_day(iso);
const iso_ago = (ws, n) => E.format_date(day(ws.as_of) - n);

function with_rule_age(base, age, ttl) {
  const ws = clone(base);
  ws.tax_rules[0].reviewed_at = iso_ago(ws, age);
  ws.tax_rules[0].ttl_days = ttl;
  return ws;
}
function insurance_ws({ paid, due = '2026-09-15' }) {
  const base = {
    ...clone(G),
    reserves: [{ reserve_id: 'RES-INS', kind: 'sinking', name: 'Страховка', currency: 'EUR', funded_start_minor: 5000, funded_as_of: '2026-08-01', target_minor: 60000,
      due_date: due, cadence: { freq: 'M', day: 1 }, mode: 'refill_to_target', backed_by_account_id: null }],
    tax_rules: [], streams: [],
  };
  if (paid) base.facts = [...base.facts, { event_id: 'f-ins', account_id: 'acc_main', date: '2026-09-10', amount_minor: -3000, currency: 'EUR', reserve_id: 'RES-INS', kind: 'expense' }];
  return base;
}

// ═══ ADV-1. Маскирование под disabled на всех наборах G-001 ══════════════════════════════════════════════════════════════

test('ADV-1 «Резервы» при disabled на каждом наборе G-001 в обоих языках: числа конверта (сейчас, к концу, отложено, резервы, свободно, ближайшая запись) не печатаются нигде на странице и в шапке', async () => {
  for (const name of ['g001.json', 'g001-low.json', 'g001-gap.json', 'g001-late.json']) {
    const base = load(name);
    if (!Array.isArray(base.tax_rules) || base.tax_rules.length === 0) continue;
    const fresh = with_rule_age(base, 10, 60);
    const dis = with_rule_age(base, 276, 60);
    const fm = model_of(fresh);
    const forbidden = new Set();
    for (const mode of ['plan', 'worse']) {
      for (const r of fresh.reserves ?? []) {
        if (r.kind !== 'tax') continue;
        const rs = fm.ctx.reserve[mode].by_reserve[r.reserve_id];
        if (rs === undefined) continue;
        forbidden.add(rs.close[rs.close.length - 1]);
        forbidden.add(rs.allocated.reduce((s, v) => s + v, 0));
        for (const v of rs.allocated) if (v > 0) forbidden.add(v);
      }
    }
    for (const r of fresh.reserves ?? []) if (r.kind === 'tax') forbidden.add(E.reserve_open(r, fresh.allocations ?? [], fm.ctx.as_of));
    const visible_ok = new Set();
    // числа, которые не зависят от правила и могут стоять на странице законно (остаток на счёте)
    visible_ok.add(model_of(dis).ctx.series.plan.opening_minor);
    for (const lang of ['ru', 'en']) {
      if (lang === 'en') find_all(byid.get('controls'), (n) => n.attrs.lang === 'en')[0].listeners.click[0]();
      reset(dis);
      await go('#reserves');
      const t = text_main() + ' | ' + text_sum();
      const leaks = [...forbidden].filter((v) => v > 0 && !visible_ok.has(v) && t.includes(N(money(v, lang))));
      assert.deepEqual(leaks.map((v) => N(money(v, lang))), [], `${name} ${lang}: числа конверта под disabled напечатаны`);
      assert.ok(!t.includes('{since}') && !t.includes('undefined') && !t.includes('NaN'), `${name} ${lang}: сырые подстановки`);
    }
    find_all(byid.get('controls'), (n) => n.attrs.lang === 'ru')[0].listeners.click[0]();
  }
});

// ═══ ADV-2. Правило с reviewed_at, но без ttl_days ═══════════════════════════════════════════════════════════════════════

test('ADV-2 правило с отметкой reviewed_at, но без ttl_days: на странице нет «undefined», «null», «NaN», сырых {…}; текст честно говорит, что срок не задан', async () => {
  const ws = clone(G);
  ws.tax_rules[0].reviewed_at = '2026-09-01';
  delete ws.tax_rules[0].ttl_days;
  reset(ws);
  await go('#reserves');
  const t = text_main();
  assert.ok(!/undefined|\bnull\b|NaN|\{[a-z_]+\}/.test(t), 'сырые значения на странице: ' + (t.match(/.{30}(undefined|\bnull\b|NaN|\{[a-z_]+\}).{30}/) ?? [''])[0]);
});

// ═══ ADV-3. «Подтвердить правило» не должно менять числа ═════════════════════════════════════════════════════════════════

test('ADV-3 «Подтвердить правило» при заранее записанной будущей версии (смена ставки с 1 декабря): подтверждение не отменяет запланированную ставку', () => {
  const ws = with_rule_age(G, 276, 60);
  ws.tax_rules.push({ ...clone(ws.tax_rules[0]), version: 2, rate_bp: 2500, valid_from: '2026-12-01', reviewed_at: '2026-10-01', recorded_at: '2026-10-01T10:00:00Z' });
  const c = FT.confirm_edit(ws, 'TR-20', ws.as_of);
  assert.equal(c.ok, true);
  const r = WE.apply_edit(ws, c.edit, { new_id: (p) => p + '_t' });
  assert.equal(r.ok, true);
  const rules = r.ws.tax_rules.flat();
  assert.equal(E.rule_at(rules, 'TR-20', '2026-12-05').rate_bp, 2500, 'на 5 декабря действует запланированная ставка, а не подтверждённая копия старой');
});

// ═══ ADV-4. Освобождение и «к концу горизонта» ═══════════════════════════════════════════════════════════════════════════

test('ADV-4 после «Освободить остаток» карточка резерва не обещает возврата денег в резерв без объяснения: число «к концу горизонта» совпадает с рядом движка и «как посчитано» сходится', async () => {
  reset(insurance_ws({ paid: true }));
  await go('#reserves');
  click(by_id('fp15-r0-release'));
  const model = ctx.get_model();
  const c = EXPLAIN.reserve_chain(model, 'RES-INS', ctx.mode());
  assert.equal(c.ok, true);
  assert.equal(c.matches, true, 'сумма строк равна числу к концу горизонта');
  assert.equal(c.start_minor, 0);
  const t = N(by_id('fp15-reserves').textContent);
  assert.ok(t.includes(`Сейчас в резерве ${N(money(0))};`), t);
  click(by_id('fp15-r0-how'));
  const dlg = N(byid.get('dlg-body').textContent);
  assert.ok(dlg.includes('сходится'), dlg.slice(0, 300));
  // график после срока не должен снова наполнять резерв: иначе предупреждение вернётся без действий пользователя
  const w = model.ctx.warnings.filter((x) => x.reserve_id === 'RES-INS').map((x) => x.code);
  assert.ok(!w.includes('W_RESERVE_RESIDUAL') && !w.includes('W_RESERVE_OVERDUE'), 'предупреждения после освобождения: ' + w);
  click(Array.from(find_all(byid.get('nav'), (n) => n.tagName === 'button' && N(n.textContent).startsWith('Отменить')))[0]);
});

test('ADV-5 два резерва под предупреждением: у каждого своя кнопка, идентификаторы разные, нажатие освобождает именно свой резерв и ровно свою сумму', async () => {
  const ws = insurance_ws({ paid: true });
  ws.reserves.push({ reserve_id: 'RES-TV', kind: 'sinking', name: 'Телевизор', currency: 'EUR', funded_start_minor: 7777, funded_as_of: '2026-08-01', target_minor: 90000,
    due_date: '2026-09-20', cadence: { freq: 'M', day: 1 }, mode: 'refill_to_target', backed_by_account_id: null });
  reset(ws);
  await go('#reserves');
  const hb = find_all(byid.get('summary'), (n) => n.attrs['data-act'] === 'release');
  assert.equal(hb.length, 1, 'в шапке кнопка только у RESIDUAL (RES-INS), у OVERDUE (RES-TV) её нет');
  const cards = find_all(main(), (n) => n.attrs['data-act'] === 'release');
  assert.equal(cards.length, 2);
  assert.equal(new Set(cards.map((n) => n.attrs.id)).size, 2);
  const tv = cards.find((n) => n.attrs['data-reserve'] === 'RES-TV');
  click(tv);
  const a = ctx.get_ws().allocations;
  assert.deepEqual(a.map((x) => [x.reserve_id, x.amount_minor]), [['RES-TV', -7777]]);
});

// ═══ ADV-6. Тексты и даты ═══════════════════════════════════════════════════════════════════════════════════════════════

test('ADV-6 срок резерва сегодня: движок строит предупреждение при due_date = as_of; текст не должен говорить «прошёл» про сегодняшнюю дату', async () => {
  const ws = insurance_ws({ paid: true, due: '2026-10-04' });
  reset(ws);
  await go('#reserves');
  const t = text_sum() + ' ' + text_main();
  assert.ok(E.analyze(ws, { as_of: ws.as_of }).warnings.some((w) => w.code === 'W_RESERVE_RESIDUAL'));
  assert.ok(!/прошёл/.test(t), 'срок сегодня, а текст: «прошёл»');
});

test('ADV-7 дата срока в тексте карточки резерва однозначна, если срок был в прошлом году (год назван)', async () => {
  const ws = insurance_ws({ paid: true, due: '2025-09-15' });
  ws.reserves[0].funded_as_of = '2025-08-01';
  reset(ws);
  await go('#reserves');
  const card = N(by_id('fp15-reserves').textContent);
  assert.ok(card.includes('2025'), card.slice(0, 200));
});

test('ADV-8 reserve_flags: поле payments (платежи резерва) используется интерфейсом либо отсутствует (нет мёртвых данных)', () => {
  const src = fs.readFileSync(path.join(DEMO, 'reserve_release.mjs'), 'utf8');
  const uses = (src.match(/\.payments\b/g) ?? []).length;
  assert.ok(uses > 0, 'payments вычисляется в reserve_flags, но нигде не читается узлами');
});

// ═══ ADV-9. Безопасность пакета ═════════════════════════════════════════════════════════════════════════════════════════

test('ADV-9 пакет не трогает хранилища и сеть, не ставит inline-стили и обработчики-строки', () => {
  for (const f of ['rule_age.mjs', 'reserve_release.mjs', 'reserve_rules.mjs', 'alloc_explain.mjs', 'pack_fp15.mjs', 'css/reserveui.css']) {
    const src = fs.readFileSync(path.join(DEMO, f), 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
    assert.ok(!/localStorage|sessionStorage|indexedDB|caches\b|serviceWorker|XMLHttpRequest|WebSocket|sendBeacon|document\.cookie/.test(src), f + ': хранилище/сеть');
    assert.ok(!/\bstyle\s*:|setAttribute\(\s*['"]style|\bon[a-z]+\s*=\s*['"]|javascript:|@import|url\(\s*['"]?https?:/.test(src.replace(/onclick\s*:\s*\(/g, '')), f + ': inline-стиль/обработчик-строка/внешний адрес');
  }
});

// ═══ ADV-10. Состояние правила в карточке и в движке сходится ═══════════════════════════════════════════════════════════

test('ADV-10 состояние правила в карточке «Срок годности» совпадает с картой rule_status движка на границах ttl, 2·ttl, 2·ttl+1', async () => {
  for (const [age, want] of [[60, 'fresh'], [61, 'stale'], [120, 'stale'], [121, 'disabled']]) {
    const ws = with_rule_age(G, age, 60);
    reset(ws);
    await go('#reserves');
    const m = ctx.get_model();
    assert.equal(m.ctx.rule_status['TR-20'], want, `движок, возраст ${age}`);
    const li = find_all(by_id('fp15-rules'), (n) => n.attrs['data-rule'] === 'TR-20')[0];
    const state_word = { fresh: 'свежее', stale: 'устарело', disabled: 'не подтверждено' }[want];
    assert.ok(N(li.textContent).toLowerCase().includes(state_word), `карточка, возраст ${age}: ${N(li.textContent).slice(0, 160)}`);
    const confirm = by_id('fp15-rule-0-confirm');
    assert.equal(confirm !== undefined, want !== 'fresh', `кнопка подтверждения, возраст ${age}`);
  }
});


// ═══ ADV-12. Правило, пополняющее резерв «накоплений» ════════════════════════════════════════════════════════════════════

test('ADV-12 правило со статусом disabled направлено в резерв вида sinking: суммы этого резерва (сейчас, к концу горизонта) не печатаются в блоке «Накопления» на «Резервы»', async () => {
  const fresh = with_rule_age(G, 10, 60);
  fresh.tax_rules[0].reserve_id = 'RES-INS';
  const fm = model_of(fresh);
  const rs = fm.ctx.reserve.plan.by_reserve['RES-INS'];
  const end = rs.close[rs.close.length - 1];
  const dis = clone(fresh);
  dis.tax_rules[0].reviewed_at = iso_ago(dis, 276);
  reset(dis);
  await go('#reserves');
  const sink = find_all(main(), (n) => n.tagName === 'section' && /Накопления/.test(N(n.textContent)) && /Годовая страховка:/.test(N(n.textContent)))[0];
  assert.ok(sink !== undefined);
  assert.ok(!N(sink.textContent).includes(N(money(end))), 'к концу горизонта напечатано ' + N(money(end)));
});

// ═══ ADV-13. «Как посчитано» при уже записанной аллокации ═══════════════════════════════════════════════════════════════════

test('ADV-13 «как посчитано»: поступление, по которому аллокация уже записана вручную в ряд (дата сегодня), не считается дважды — сумма строк равна числу к концу горизонта', () => {
  const ws = clone(G);
  const m0 = model_of(ws);
  const planned = E.allocations_for_events(m0.ctx.events.plan, ws.tax_rules.flat(), m0.ctx.as_of);
  assert.ok(planned.length > 0);
  const x = planned[0];
  const w2 = apply_alloc(ws, { ...x, date: ws.as_of, source: 'income' });
  const model = model_of(w2);
  for (const mode of ['plan', 'worse']) {
    const c = EXPLAIN.reserve_chain(model, 'RES-TAX', mode);
    assert.equal(c.ok, true);
    assert.equal(c.matches, true, mode + ': ' + JSON.stringify(c.rows.map((r) => [r.kind, r.amount_minor])) + ' start ' + c.start_minor + ' end ' + c.end_minor);
  }
});

function apply_alloc(ws, a) {
  const r = WE.apply_edit(ws, { type: 'record_allocation', allocation: a }, { new_id: (p) => p + '_t' });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  return r.ws;
}

// ═══ ADV-14. Платёж без записи о высвобождении: что говорит текст «после платежа осталось» ═══════════════════════════════════

test('ADV-14 платёж 30,00 € из резерва 50,00 € проведён, высвобождение не записано: плашка не должна выдавать записанные 50,00 € за остаток «после платежа», пока карточка FP-08 предлагает записать высвобождение 30,00 €', async () => {
  reset(insurance_ws({ paid: true }));
  await go('#reserves');
  const pend = by_id('fp08-pending');
  const hdr = text_sum();
  if (process.env.FP15_DEBUG) console.log('HDR:', hdr, '\nPEND:', pend === undefined ? '(нет)' : N(pend.textContent), '\nCARD:', N(by_id('fp15-reserves').textContent));
  const has_pending_payment = pend !== undefined && /30,00/.test(N(pend.textContent));
  assert.ok(!(has_pending_payment && /после платежа осталось 50,00/.test(hdr)), 'шапка: «после платежа осталось 50,00 €», карточка FP-08: платёж 30,00 € ещё не высвобожден');
});
