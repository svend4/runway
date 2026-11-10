// installment_earliest.test.mjs — FP-28: «с какой даты рассрочка держится в буфере» (ALG-04 A04.5, REQ-044, IDEA-14) и переключатель «разбить на N платежей» на экране «Купить».
// Часть 1 — чистый модуль engine/installment_earliest.mjs: сдвиг графика через move_part_date + check_purchase; для одной части результат совпадает с earliest_date (свойство);
// независимый оракул «перебор по рядам free» на случайных графиках; границы (гейт, вне горизонта, буфер нарушен до покупки, части за горизонтом, предел поиска);
// чистота и детерминизм. Часть 2 — настоящий app.mjs на заглушке DOM: флажок на «Купить», ответ по разбивке, ошибки полей, режим сохранённой покупки. Браузер и серверы не запускаются.
// Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { analyze } from '../engine/index.mjs';
import { parse_date, format_date } from '../engine/dates.mjs';
import { earliest_date, check_purchase } from '../engine/afford.mjs';
import { installment_plan, move_part_date } from '../engine/installment.mjs';
import { earliest_installment_start, shift_schedule } from '../engine/installment_earliest.mjs';
import { make_rng } from './helpers.mjs';
import { boot_app, find_all, N } from './dom_boot.mjs';

const DATA = new URL('../data/', import.meta.url);
const load = (name) => JSON.parse(fs.readFileSync(new URL(name, DATA), 'utf8'));
const G = load('g001.json');
const LOW = load('g001-low.json');
const LATE = load('g001-late.json');
const run = (ws) => analyze(ws, { as_of: ws.as_of });
const AG = run(G);
const iso = (d) => (d === null ? null : format_date(d));
const buy = (parts) => ({ currency: 'EUR', parts });
const AS_OF = AG.as_of;
const HORIZON_END = AG.horizon_end;
const deep_freeze = (x) => { if (x !== null && typeof x === 'object') { Object.freeze(x); for (const v of Object.values(x)) deep_freeze(v); } return x; };

// ── 1. сдвиг графика ────────────────────────────────────────────────────────────────────────────────────────────────

test('FP-28 shift_schedule: каждая часть переносится через move_part_date на столько же дней, суммы и порядок те же, исходный график не меняется', () => {
  const parts = deep_freeze([{ date: '2026-10-12', amount_minor: 30000 }, { date: '2026-11-12', amount_minor: 30001 }, { date: '2026-12-12', amount_minor: 29999 }]);
  assert.deepEqual(shift_schedule(parts, 0), parts.map((p) => ({ ...p })), 'сдвиг 0 — копия');
  assert.notEqual(shift_schedule(parts, 0)[0], parts[0], 'копия, а не те же объекты');
  const s = shift_schedule(parts, 20);
  assert.deepEqual(s.map((p) => p.date), ['2026-11-01', '2026-12-02', '2027-01-01']);
  assert.deepEqual(s.map((p) => p.amount_minor), [30000, 30001, 29999]);
  let by_hand = parts.map((p) => ({ ...p }));
  for (let i = 0; i < by_hand.length; i++) by_hand = move_part_date(by_hand, i, format_date(parse_date(parts[i].date) + 20));
  assert.deepEqual(s, by_hand, 'ровно то же, что последовательные move_part_date');
});

// ── 2. одна часть = earliest_date ───────────────────────────────────────────────────────────────────────────────────

test('FP-28 свойство: для покупки из ОДНОЙ части результат совпадает с earliest_date(ctx, S, дата_части, B, режим) — G-001, G-001-late и случайные суммы и даты', () => {
  const rng = make_rng(2828);
  for (const ctx of [AG, run(LATE)]) {
    for (let c = 0; c < 60; c++) {
      const S = rng.int(100, 400000);
      const d = ctx.as_of + rng.int(0, ctx.horizon_end - ctx.as_of);
      const r = earliest_installment_start(ctx, buy([{ date: format_date(d), amount_minor: S }]));
      assert.equal(r.kind, 'ok');
      for (const m of ['plan', 'worse']) {
        const want = earliest_date(ctx, S, d, ctx.buffer_minor, m);
        const x = r.by_mode[m];
        if (want === null) assert.ok(x.status === 'none' || x.status === 'baseline_below_buffer', `${m} S=${S} d=${iso(d)}: ${x.status}`);
        else {
          assert.equal(x.start, want, `${m} S=${S} d=${iso(d)}`);
          assert.equal(x.shift_days, want - d);
          assert.equal(x.status, want === d ? 'now' : 'shifted');
        }
      }
    }
  }
});

// ── 3. рассрочка G-001 ──────────────────────────────────────────────────────────────────────────────────────────────

test('FP-28 G-001: 900,00 € тремя платежами по 300,00 € (10-12, 11-12, 12-12): внутри горизонта два платежа, «по плану» держится с выбранной даты, «если хуже» — не нашлось', () => {
  const plan = installment_plan({ total_minor: 90000, n: 3, start: '2026-10-12' });
  assert.deepEqual(plan.parts.map((p) => p.date), ['2026-10-12', '2026-11-12', '2026-12-12']);
  const r = earliest_installment_start(AG, buy(plan.parts));
  assert.equal(r.kind, 'ok');
  assert.deepEqual([r.total_count, r.checked_count, r.beyond_count, r.beyond_minor], [3, 2, 1, 30000]);
  assert.deepEqual([iso(r.first_date), iso(r.last_date), r.max_shift_days], ['2026-10-12', '2026-11-12', HORIZON_END - parse_date('2026-11-12')]);
  assert.deepEqual([r.by_mode.plan.status, r.by_mode.plan.shift_days, iso(r.by_mode.plan.start), r.by_mode.plan.margin >= 0], ['now', 0, '2026-10-12', true]);
  const w = r.by_mode.worse;
  assert.deepEqual([w.status, w.shift_days, w.start], ['none', null, null]);
  assert.ok(w.margin < 0, 'при сдвиге 0 запас отрицательный: ' + w.margin);
  assert.equal(r.scanned, r.max_shift_days + 1, 'перебрали все сдвиги, пока последний проверенный платёж внутри горизонта');
});

test('FP-28 G-001: два платежа по 300,00 € (10-12 и 10-19) — «по плану» держатся с 10-30 (сдвиг 18 дней), «если хуже» — с 11-20, после прихода 11-19 (сдвиг 39 дней)', () => {
  const r = earliest_installment_start(AG, buy([{ date: '2026-10-12', amount_minor: 30000 }, { date: '2026-10-19', amount_minor: 30000 }]));
  assert.deepEqual([r.checked_count, r.beyond_count, r.max_shift_days], [2, 0, 42]);
  const p = r.by_mode.plan;
  const w = r.by_mode.worse;
  assert.deepEqual([p.status, p.shift_days, iso(p.start), iso(p.last), p.margin], ['shifted', 18, '2026-10-30', '2026-11-06', 13500]);
  assert.deepEqual([w.status, w.shift_days, iso(w.start), iso(w.last), w.margin], ['shifted', 39, '2026-11-20', '2026-11-27', 21000]);
  // три платежа по 250,00 € раз в неделю: «по плану» тоже с 10-30, «если хуже» в пределах горизонта не держится
  const three = earliest_installment_start(AG, buy([{ date: '2026-10-12', amount_minor: 25000 }, { date: '2026-10-19', amount_minor: 25000 }, { date: '2026-10-26', amount_minor: 25000 }]));
  assert.deepEqual([three.by_mode.plan.status, three.by_mode.plan.shift_days, three.by_mode.worse.status], ['shifted', 18, 'none']);
});

test('FP-28 G-001: один платёж 600,00 € на 11-12 — «по плану» держится сразу, «если хуже» с 11-20; это ровно earliest_date', () => {
  const one = earliest_installment_start(AG, buy([{ date: '2026-11-12', amount_minor: 60000 }]));
  assert.deepEqual([one.by_mode.plan.status, one.by_mode.plan.shift_days], ['now', 0]);
  assert.deepEqual([one.by_mode.worse.status, one.by_mode.worse.shift_days, iso(one.by_mode.worse.start)], ['shifted', 8, '2026-11-20']);
  assert.equal(one.by_mode.worse.start, earliest_date(AG, 60000, parse_date('2026-11-12'), AG.buffer_minor, 'worse'));
});

// ── 4. независимый оракул ────────────────────────────────────────────────────────────────────────────────────────────

/** Оракул: минимум `free[i] − cum_i` по рядам режима, часть раньше as_of зажимается на as_of; «держится» — минимум не ниже буфера. */
function oracle(ctx, parts, mode, B) {
  const free = ctx.series[mode].free;
  if (Math.min(...free) < B) return { status: 'baseline_below_buffer' };
  const inside = parts.filter((p) => parse_date(p.date) <= ctx.horizon_end);
  const last = Math.max(...inside.map((p) => parse_date(p.date)));
  for (let s = 0; s <= ctx.horizon_end - last; s++) {
    const cum = new Array(free.length).fill(0);
    for (const p of inside) cum[Math.max(parse_date(p.date) + s, ctx.as_of) - ctx.as_of] += p.amount_minor;
    let run_sum = 0;
    let min = Infinity;
    for (let i = 0; i < free.length; i++) { run_sum += cum[i]; min = Math.min(min, free[i] - run_sum); }
    if (min - B >= 0) return { status: s === 0 ? 'now' : 'shifted', shift_days: s, m_after: min };
  }
  return { status: 'none' };
}

test('FP-28 оракул: на 400 случайных графиках (1…6 частей, суммы, даты, G-001 и G-001-late) сдвиг, статус и минимум после покупки совпадают с независимым перебором по рядам free', () => {
  const rng = make_rng(4004);
  let shifted = 0;
  let none = 0;
  for (let c = 0; c < 400; c++) {
    const ctx = c % 2 === 0 ? AG : run(LATE);
    const n = rng.int(1, 6);
    const parts = Array.from({ length: n }, () => ({ date: format_date(ctx.as_of + rng.int(0, ctx.horizon_end - ctx.as_of)), amount_minor: rng.int(100, 90000) }));
    const r = earliest_installment_start(ctx, buy(parts));
    assert.equal(r.kind, 'ok');
    for (const m of ['plan', 'worse']) {
      const o = oracle(ctx, parts, m, ctx.buffer_minor);
      const x = r.by_mode[m];
      assert.equal(x.status, o.status, `${c} ${m} ${JSON.stringify(parts)}`);
      if (o.shift_days !== undefined) {
        assert.equal(x.shift_days, o.shift_days);
        assert.equal(x.m_after, o.m_after);
        assert.ok(x.margin >= 0);
        if (o.status === 'shifted') shifted++;
        // на предыдущем сдвиге не держалось — иначе это не самая ранняя дата
        if (x.shift_days > 0) {
          const prev = check_purchase(ctx, buy(shift_schedule(parts.filter((p) => parse_date(p.date) <= ctx.horizon_end), x.shift_days - 1)), null);
          assert.ok(prev.by_mode[m].margin < 0, 'на сдвиг раньше запас отрицателен');
        }
      } else if (o.status === 'none') none++;
    }
  }
  assert.ok(shifted > 20 && none > 20, `набор содержателен: сдвинуто ${shifted}, не найдено ${none}`);
});

// ── 5. границы ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('FP-28 G-001-low: буфер нарушен до покупки — baseline_below_buffer в обоих режимах, сдвиг не ищется, запас при сдвиге 0 показан', () => {
  const low = run(LOW);
  const r = earliest_installment_start(low, buy([{ date: '2026-10-12', amount_minor: 1000 }, { date: '2026-10-19', amount_minor: 1000 }]));
  assert.equal(r.kind, 'ok');
  for (const m of ['plan', 'worse']) {
    assert.deepEqual([r.by_mode[m].status, r.by_mode[m].shift_days, r.by_mode[m].start], ['baseline_below_buffer', null, null], m);
    assert.ok(r.by_mode[m].margin < 0);
  }
  assert.equal(r.scanned, 0, 'перебора нет');
});

test('FP-28 гейт и горизонт: без буфера — insufficient_data (причина no_buffer), все части за горизонтом — outside_horizon; части раньше as_of не ломают расчёт', () => {
  const no_buffer = run({ ...G, params: { ...G.params, buffer_minor: null } });
  const g = earliest_installment_start(no_buffer, buy([{ date: '2026-10-12', amount_minor: 1000 }]));
  assert.equal(g.kind, 'insufficient_data');
  assert.ok(g.reasons.includes('no_buffer'));
  const out = earliest_installment_start(AG, buy([{ date: '2027-03-01', amount_minor: 1000 }, { date: '2027-04-01', amount_minor: 1000 }]));
  assert.equal(out.kind, 'outside_horizon');
  const past = earliest_installment_start(AG, buy([{ date: '2026-09-01', amount_minor: 1000 }, { date: '2026-10-20', amount_minor: 1000 }]));
  assert.equal(past.kind, 'ok');
  assert.ok(past.by_mode.plan.status === 'now' || past.by_mode.plan.status === 'shifted');
});

test('FP-28 части за горизонтом не «растворяют» проверку: проверяются только части внутри горизонта при сдвиге 0, перебор останавливается, когда последняя из них вышла бы за горизонт', () => {
  const parts = [{ date: '2026-11-25', amount_minor: 900000 }, { date: '2027-02-25', amount_minor: 1000 }];
  const r = earliest_installment_start(AG, buy(parts));
  assert.deepEqual([r.checked_count, r.beyond_count, r.beyond_minor, r.max_shift_days], [1, 1, 1000, HORIZON_END - parse_date('2026-11-25')]);
  // огромная сумма не держится ни при каком сдвиге внутри горизонта: ответ «не нашлось», а не «держится, потому что платёж вышел за горизонт»
  assert.equal(r.by_mode.plan.status, 'none');
  assert.equal(r.by_mode.worse.status, 'none');
  assert.equal(r.scanned, r.max_shift_days + 1);
});

test('FP-28 max_shift_days ограничивает поиск; ответ не зависит от порядка частей во входе; вход не меняется; повтор даёт тот же результат', () => {
  const parts = deep_freeze([{ date: '2026-10-12', amount_minor: 30000 }, { date: '2026-10-19', amount_minor: 30000 }]);
  const full = earliest_installment_start(AG, buy(parts));
  assert.deepEqual([full.by_mode.plan.shift_days, full.by_mode.worse.shift_days], [18, 39]);
  const at18 = earliest_installment_start(AG, buy(parts), { max_shift_days: 18 });
  assert.deepEqual([at18.by_mode.plan.status, at18.by_mode.plan.shift_days, at18.by_mode.worse.status, at18.max_shift_days], ['shifted', 18, 'none', 18], 'предел 18 дней: «по плану» найдено ровно на пределе, «если хуже» — нет');
  const at17 = earliest_installment_start(AG, buy(parts), { max_shift_days: 17 });
  assert.equal(at17.by_mode.plan.status, 'none', 'предел 17 дней: 18-й день уже не ищется');
  assert.equal(earliest_installment_start(AG, buy(parts), { max_shift_days: 0 }).scanned, 1, 'предел 0: проверен только выбранный день');
  const rev = earliest_installment_start(AG, buy([...parts].reverse()));
  assert.deepEqual(rev.by_mode, full.by_mode, 'порядок частей на результат не влияет');
  assert.deepEqual(earliest_installment_start(AG, buy(parts)), full, 'повтор даёт тот же результат');
});

// ── 6. экран «Купить» ───────────────────────────────────────────────────────────────────────────────────────────────

const A = await boot_app();
const lang = () => A.ext.ctx.lang();
const T = (key, params) => N(A.I18N.t(lang(), key, params));
const by_id = (id) => find_all(A.main(), (n) => n.attrs.id === id)[0];
const text = () => A.text_of('main');
const toggle = async (on) => {
  const box = by_id('bx-on');
  box.checked = on;
  box.listeners.change[0]({ target: box });
  await A.tick();
};

await A.go('#buy');

test('FP-28 экран «Купить»: есть флажок «Разбить на N платежей»; пока он снят, ответа по разбивке нет и основной ответ прежний', () => {
  assert.ok(by_id('bx-on') !== undefined, 'флажок на экране');
  assert.ok(text().includes(T('feedx.sp_toggle')), text().slice(0, 300));
  assert.equal(find_all(A.main(), (n) => /(^|\s)buyx-result(\s|$)/.test(n.className)).length, 0);
  assert.equal(by_id('bx-n').parent.parent.attrs.hidden !== undefined, true, 'поля N и ставки скрыты, пока флажок снят');
  assert.ok(text().includes(T('buy.verdict')), 'основной ответ на месте');
});

test('FP-28 экран «Купить», G-001: 300,00 € на 12 октября, 2 платежа без процентов — вердикт по частям, «с какой даты держится» по режимам, график и оговорка', async () => {
  await toggle(true);
  const n = by_id('bx-n');
  n.value = '2';
  n.listeners.input[0]({ target: n });
  await A.tick();
  const res = find_all(A.main(), (x) => /(^|\s)buyx-result(\s|$)/.test(x.className))[0];
  assert.ok(res !== undefined, 'блок разбивки появился: ' + text().slice(0, 400));
  const t = N(res.textContent);
  assert.ok(t.includes('Если разбить на 2 платежа'), t.slice(0, 200));
  assert.match(t, /Всего 300,00 € \(проценты 0,00 €\); первый платёж — 12 октября, последний — 12 ноября\./);
  assert.match(t, /Вердикт по проверенным платежам: /);
  assert.ok(t.includes(T('feedx.sp_e_title')));
  assert.match(t, /по плану: уже с выбранной даты — 12 октября\./);
  assert.match(t, /если хуже: /);
  assert.ok(t.includes(T('feedx.sp_note')));
  const tables = find_all(res, (x) => x.tagName === 'table');
  assert.equal(tables.length, 1);
  assert.equal(find_all(tables[0], (x) => x.tagName === 'tr').length, 3, 'шапка и два платежа');
  assert.ok(find_all(res, (x) => x.tagName === 'button').some((b) => N(b.textContent) === T('c.ask')), 'кнопка «Спросить ассистента»');
});

test('FP-28 экран «Купить»: число платежей и ставка проверяются — понятный текст ошибки, а не код; ставка даёт проценты в итоге; снятый флажок убирает блок', async () => {
  const n = by_id('bx-n');
  n.value = '1';
  n.listeners.input[0]({ target: n });
  assert.ok(text().includes(T('feedx.sp_bad_n', { min: 2, max: 24 })), 'N = 1');
  n.value = '25';
  n.listeners.input[0]({ target: n });
  assert.ok(text().includes(T('feedx.sp_bad_n', { min: 2, max: 24 })), 'N = 25');
  n.value = 'abc';
  n.listeners.input[0]({ target: n });
  assert.ok(text().includes(T('feedx.sp_bad_n', { min: 2, max: 24 })), 'N = abc');
  n.value = '3';
  const rate = by_id('bx-rate');
  rate.value = '12';
  n.listeners.input[0]({ target: n });
  assert.ok(!/NaN|undefined|E_[A-Z_]+/.test(text()), 'нет мусора и кодов ошибок');
  const interest = N(find_all(A.main(), (x) => /(^|\s)buyx-result(\s|$)/.test(x.className))[0].textContent).match(/проценты ([\d  ,]+) €/);
  assert.ok(interest !== null && interest[1].replace(/[^\d]/g, '') !== '000', 'проценты при 12 % больше нуля: ' + (interest && interest[0]));
  rate.value = '5000';
  rate.listeners.input[0]({ target: rate });
  assert.ok(text().includes(T('feedx.sp_bad_rate')), 'ставка 5000 %');
  rate.value = '';
  rate.listeners.input[0]({ target: rate });
  await toggle(false);
  assert.equal(find_all(A.main(), (x) => /(^|\s)buyx-result(\s|$)/.test(x.className)).length, 0, 'флажок снят — блока нет');
  assert.ok(text().includes(T('buy.verdict')));
});

test('FP-28 экран «Купить»: сумма 1 200,00 € по четырём платежам, два из которых за горизонтом — блок называет «проверено платежей» и «за горизонтом»; повторное включение возвращает блок', async () => {
  const amount = by_id('buy-amount');
  amount.value = '1200,00';
  amount.listeners.input[0]({ target: amount });
  await toggle(true);
  const n = by_id('bx-n');
  n.value = '4';
  n.listeners.input[0]({ target: n });
  const t = N(find_all(A.main(), (x) => /(^|\s)buyx-result(\s|$)/.test(x.className))[0].textContent);
  assert.match(t, /Проверено платежей: 2 из 4; ещё 2 на 600,00 € лежат за горизонтом/);
  await toggle(false);
});

test('FP-28 экран «Купить» на английском: подписи и числа в формате языка, склонение не ломается', async () => {
  A.set_lang('en');
  await A.go('#buy');
  await toggle(true);
  const n = by_id('bx-n');
  n.value = '2';
  n.listeners.input[0]({ target: n });
  const t = N(find_all(A.main(), (x) => /(^|\s)buyx-result(\s|$)/.test(x.className))[0].textContent);
  assert.ok(t.includes('If split into 2 payments'), t.slice(0, 200));
  assert.match(t, /Verdict for the checked payments: /);
  assert.ok(t.includes('From which date the schedule stays within the buffer'));
  await toggle(false);
  A.set_lang('ru');
});

// ── 7. после проверки: часть раньше «сегодня», блок разбивки без основного вердикта ───────────────────────────────────────

test('FP-28 часть раньше as_of: график считается как в расчёте (часть зажата на as_of), «держится с даты» не уходит в прошлое; результат равен результату с уже зажатыми датами', () => {
  const parts = [{ date: '2026-09-01', amount_minor: 30000 }, { date: '2026-10-12', amount_minor: 30000 }];
  const r = earliest_installment_start(AG, buy(parts));
  assert.equal(r.kind, 'ok');
  assert.equal(r.clamped_count, 1);
  assert.equal(iso(r.first_date), iso(AS_OF), 'первая дата графика — «сегодня», а не 1 сентября');
  for (const m of ['plan', 'worse']) {
    const x = r.by_mode[m];
    if (x.start !== null) assert.ok(x.start >= AS_OF, `${m}: «держится с» ${iso(x.start)} не раньше ${iso(AS_OF)}`);
  }
  const clamped = earliest_installment_start(AG, buy([{ date: iso(AS_OF), amount_minor: 30000 }, { date: '2026-10-12', amount_minor: 30000 }]));
  assert.equal(clamped.clamped_count, 0);
  assert.deepEqual(r.by_mode, clamped.by_mode, 'зажатая часть — то же, что часть на as_of');
  assert.deepEqual([r.total_count, r.checked_count, r.beyond_count, r.scanned], [clamped.total_count, clamped.checked_count, clamped.beyond_count, clamped.scanned]);
  // случайные графики с частями в прошлом: старт никогда не раньше as_of и совпадает с зажатым графиком
  const rng = make_rng(2891);
  for (let c = 0; c < 120; c++) {
    const ctx = c % 2 === 0 ? AG : run(LATE);
    const k = rng.int(1, 4);
    const raw = Array.from({ length: k }, () => ({ date: format_date(ctx.as_of + rng.int(-40, 25)), amount_minor: rng.int(100, 60000) }));
    const fixed = raw.map((p) => ({ ...p, date: format_date(Math.max(parse_date(p.date), ctx.as_of)) }));
    const a = earliest_installment_start(ctx, buy(raw));
    const b = earliest_installment_start(ctx, buy(fixed));
    assert.deepEqual(a.by_mode, b.by_mode, `c=${c} ${JSON.stringify(raw)}`);
    assert.equal(a.clamped_count, raw.filter((p) => parse_date(p.date) < ctx.as_of).length);
    for (const m of ['plan', 'worse']) if (a.by_mode[m].start !== null) assert.ok(a.by_mode[m].start >= ctx.as_of, `c=${c} ${m}`);
  }
});

test('FP-28 экран «Купить»: включённая разбивка отвечает и без основного вердикта — буфер не задан (гейт) и дата вне горизонта называют причину, график платежей виден', async () => {
  const ws = JSON.parse(JSON.stringify(G));
  ws.params.buffer_minor = null;
  assert.equal(A.ext.ctx.adopt(ws).ok, true);
  A.set_lang('ru');
  await A.go('#buy');
  assert.ok(text().includes(T('buy.gate_title')), 'основной ответ — «данных недостаточно»: ' + text().slice(0, 300));
  await toggle(true);
  const n3 = by_id('bx-n');
  n3.value = '3';
  n3.listeners.input[0]({ target: n3 });
  const res = find_all(A.main(), (x) => /(^|\s)buyx-result(\s|$)/.test(x.className))[0];
  assert.ok(res !== undefined, 'блок разбивки есть и при непройденном гейте');
  const t = N(res.textContent);
  assert.ok(t.includes(T('feedx.sp_no_verdict')), t.slice(0, 400));
  assert.ok(t.includes('Если разбить на 3 платежа'), t.slice(0, 200));
  assert.equal(find_all(res, (x) => x.tagName === 'table').length, 1, 'график платежей показан');
  assert.ok(!/NaN|undefined|E_[A-Z_]+/.test(t));
  await toggle(false);
  assert.equal(find_all(A.main(), (x) => /(^|\s)buyx-result(\s|$)/.test(x.className)).length, 0);
  // дата вне горизонта
  await A.choose_dataset('g001');
  await A.go('#buy');
  const date = by_id('buy-date');
  date.value = '2027-03-01';
  date.listeners.input[0]({ target: date });
  assert.ok(text().length > 0);
  await toggle(true);
  const res2 = find_all(A.main(), (x) => /(^|\s)buyx-result(\s|$)/.test(x.className))[0];
  assert.ok(res2 !== undefined, 'блок есть и при дате вне горизонта: ' + text().slice(0, 300));
  assert.ok(N(res2.textContent).includes(T('feedx.sp_no_verdict')), N(res2.textContent).slice(0, 300));
  // на английском
  A.set_lang('en');
  await A.go('#buy');
  assert.ok(N(find_all(A.main(), (x) => /(^|\s)buyx-result(\s|$)/.test(x.className))[0]?.textContent ?? '').includes(T('feedx.sp_no_verdict')), 'на английском тот же блок: ' + text().slice(0, 300));
  await A.choose_dataset('g001');
  A.set_lang('ru');
  await A.go('#buy');
});
