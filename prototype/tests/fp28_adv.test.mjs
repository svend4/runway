// fp28_adv.test.mjs — состязательная проверка FP-28 (независимый проверяющий): края, которые тесты реализатора не трогают.
// Один процесс node, браузер и серверы не запускаются. Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { boot_app, find_all, N } from './dom_boot.mjs';
import { make_rng } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const imp = (rel) => import(pathToFileURL(path.join(PROTO, rel)).href);
const A = await boot_app();
const ctx = A.ext.ctx;
const text = () => A.text_of('main');
const click = (n) => n.listeners.click[0]({ preventDefault() {}, target: n });
const by_id = (id) => find_all(A.main(), (n) => n.attrs.id === id)[0];
const input_value = () => find_all(A.main(), (n) => n.attrs.id === 'as-q')[0]?.value;

const E = await imp('engine/index.mjs');
const IE = await imp('engine/installment_earliest.mjs');
const AF = await imp('engine/afford.mjs');
const load = (n) => JSON.parse(fs.readFileSync(path.join(PROTO, 'data', n), 'utf8'));

// Дефект ADV-1 закрыт исправлением после проверки (shortage.first_below + «впервые ниже буфера — <дата>»): пометка todo снята, тест — обычный.
test('ADV G-001-low: «первая дата нарушения буфера» (first_buffer_breach, 26 октября) должна быть названа на экране «Обзор»', async () => {
  await A.choose_dataset('low');
  A.set_lang('ru');
  await A.go('#overview');
  const model = ctx.get_model().ctx;
  const q = E.answer_q1(model.series.plan, model.horizon_end, model.buffer_minor);
  assert.equal(E.format_date(q.first_buffer_breach), '2026-10-26', 'движок знает первую дату нарушения буфера');
  const t = text();
  const mentions = t.match(/26 октября/g) ?? [];
  // в таблице значений 26 окт — сокращённая дата; в сообщениях о нехватке полной даты «26 октября» нет
  assert.ok(mentions.length > 0, 'дата первого нарушения буфера (26 октября) нигде не названа полным текстом');
});

test('ADV кнопка «Спросить ассистента» в блоке разбивки на «Купить»: заготовка с суммой в формате без разделителей', async () => {
  await A.choose_dataset('g001');
  A.set_lang('ru');
  await A.go('#buy');
  const box = by_id('bx-on');
  box.checked = true;
  box.listeners.change[0]({ target: box });
  const n = by_id('bx-n');
  n.value = '2';
  n.listeners.input[0]({ target: n });
  const res = find_all(A.main(), (x) => /(^|\s)buyx-result(\s|$)/.test(x.className))[0];
  assert.ok(res);
  const ask = find_all(res, (x) => x.tagName === 'button' && N(x.textContent) === 'Спросить ассистента')[0];
  assert.ok(ask);
  click(ask);
  console.log('ADV заготовка из разбивки:', JSON.stringify(input_value()));
  assert.match(String(input_value()), /^когда \d+\.\d{2}$/);
});

test('ADV earliest_installment_start: одинаковые даты частей, даты числом (EpochDay), части не по порядку — совпадает с независимым перебором', () => {
  const rng = make_rng(9191);
  const base = [load('g001.json'), load('g001-late.json')].map((ws) => E.analyze(ws, { as_of: ws.as_of }));
  for (let c = 0; c < 300; c++) {
    const ctx_a = base[c % 2];
    const k = rng.int(1, 5);
    const day0 = ctx_a.as_of + rng.int(0, 20);
    const parts = Array.from({ length: k }, () => ({ date: rng.int(0, 1) === 0 ? day0 : day0 + rng.int(0, 15), amount_minor: rng.int(100, 60000) }));
    const r = IE.earliest_installment_start(ctx_a, { currency: 'EUR', parts });
    assert.equal(r.kind, 'ok');
    for (const m of ['plan', 'worse']) {
      const free = ctx_a.series[m].free;
      const B = ctx_a.buffer_minor;
      let want = { status: 'none' };
      if (Math.min(...free) < B) want = { status: 'baseline_below_buffer' };
      else {
        const last = Math.max(...parts.map((p) => p.date));
        for (let s = 0; s <= ctx_a.horizon_end - last; s++) {
          const cum = new Array(free.length).fill(0);
          for (const p of parts) cum[p.date + s - ctx_a.as_of] += p.amount_minor;
          let run = 0; let mn = Infinity;
          for (let i = 0; i < free.length; i++) { run += cum[i]; mn = Math.min(mn, free[i] - run); }
          if (mn >= B) { want = { status: s === 0 ? 'now' : 'shifted', shift_days: s }; break; }
        }
      }
      assert.equal(r.by_mode[m].status, want.status, `c=${c} ${m} ${JSON.stringify(parts)}`);
      if (want.shift_days !== undefined) assert.equal(r.by_mode[m].shift_days, want.shift_days);
    }
  }
});

// Дефект закрыт: часть раньше as_of зажимается на as_of до сдвига (clamped_count); пометка todo снята.
test('ADV earliest_installment_start: часть до as_of (обход интерфейса) — «держится с даты» в прошлом не должна выдаваться за ответ', () => {
  const g = load('g001.json');
  const a = E.analyze(g, { as_of: g.as_of });
  const r = IE.earliest_installment_start(a, { currency: 'EUR', parts: [{ date: '2026-09-01', amount_minor: 30000 }, { date: '2026-10-12', amount_minor: 30000 }] });
  const p = r.by_mode.plan;
  console.log('ADV past part:', JSON.stringify({ status: p.status, shift: p.shift_days, start: p.start === null ? null : E.format_date(p.start) }));
  if (p.start !== null) assert.ok(p.start >= a.as_of, 'старт графика не раньше сегодня: ' + E.format_date(p.start));
});

test('ADV nearest_income: несколько доходов — берётся ближайший по дате в режиме, а не первый в массиве', async () => {
  const SH = await imp('demo/shortage.mjs');
  const ev = [{ date: 120, amount_minor: 100, kind: 'income' }, { date: 105, amount_minor: 300, kind: 'income' }, { date: 105, amount_minor: -5, kind: 'expense' }];
  assert.deepEqual(SH.nearest_income(ev, 100), { date: 105, amount_minor: 300, count: 1 });
});

test('ADV «Исправить факт» на английском: поле суммы читается в формате языка и «ничего не изменено» срабатывает при круговом прогоне', async () => {
  await A.choose_dataset('g001');
  A.set_lang('en');
  await A.go('#feed');
  const FF = await imp('demo/fact_fix.mjs');
  const ws = ctx.get_ws();
  for (const f of ws.facts.slice(0, 28)) {
    const fixable = FF.fixable_fact(ws, f.event_id);
    if (!fixable.ok) continue;
    const txt = FF.amount_field_text(ws, f, 'en');
    const b = FF.build_fix(ws, f.event_id, { amount_text: txt, date: f.date, tag: f.tag ?? '', note: f.note ?? '' }, { lang: 'en', new_id: ctx.new_id });
    assert.equal(b.ok, true, f.event_id + ' ' + JSON.stringify(b.error));
    assert.equal(b.changed, false, f.event_id + ': круговой прогон ' + txt + ' не должен менять запись');
  }
  A.set_lang('ru');
});

test('ADV «Исправить факт»: новый event_id не совпадает с уже занятыми после серии исправлений подряд', async () => {
  await A.choose_dataset('g001');
  A.set_lang('ru');
  await A.go('#feed');
  const FF = await imp('demo/fact_fix.mjs');
  for (let i = 0; i < 6; i++) {
    const ws = ctx.get_ws();
    const f = ws.facts.find((x) => x.event_id === 'tx-g001-28') ?? ws.facts.find((x) => /^tx-/.test(x.event_id) && x.tag === 'продукты');
    const amount = -(1000 + i * 100);
    const r = FF.commit_fix(ctx, f.event_id, { amount_text: String(amount / 100), date: f.date, tag: 'продукты' });
    assert.equal(r.ok, true, JSON.stringify(r.error));
  }
  const ids = ctx.get_ws().facts.map((x) => x.event_id);
  assert.equal(new Set(ids).size, ids.length, 'идентификаторы уникальны');
});

// Дефект закрыт: в «Сверка → Все факты» у каждого факта (кроме ног перевода) есть кнопка «Исправить» (rc-fx-N); пометка todo снята, проверка требует кнопку.
test('ADV факт старше последних 8 исправить нельзя нигде: лента показывает 8, а «Сверка → Все факты» (куда ведёт оговорка) кнопки «Исправить» не имеет', async () => {
  await A.choose_dataset('g001');
  A.set_lang('ru');
  await A.go('#feed');
  const fix_in_feed = find_all(A.main(), (n) => n.tagName === 'button' && /^feedx-fix-/.test(n.attrs.id ?? '')).length;
  assert.equal(fix_in_feed, 8);
  assert.equal(ctx.get_ws().facts.length, 28);
  await A.go('#reconcile');
  const fix_in_reconcile = find_all(A.main(), (n) => n.tagName === 'button' && /Исправить/.test(N(n.textContent))).length;
  assert.ok(fix_in_reconcile > 0, 'в «Сверке» нет кнопки «Исправить» для старых фактов');
});
