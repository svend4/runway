// sinking.test.mjs — TST-20, TST-21, TST-22 (sinking: страховка, отпуск с догоном и пул, режим fixed);
// TST-02 (G-001: резервы и свободный остаток), TST-39 (часть: без резервов free = trough), TST-17 (пул), TST-51/53 (фаззинг и оракул).
// Все числа — design-brief §9.4, §9.12, ALG-05 TV-1…TV-5, ALG-11 TV-1, TV-4, TV-5, TV-7; ожидаемые значения не подгонялись под код.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contribution_dates, contribution_plan, contribution_plan_fixed, plan_status, periods_to_goal, pool_split,
  contribution_allocations, reserve_open, reserve_series, free_series,
} from '../engine/sinking.mjs';
import { expand_stream } from '../engine/hourly.mjs';
import { allocations_for_events } from '../engine/tax.mjs';
import { expand_all } from '../engine/recurrence.mjs';
import { parse_date, format_date, make_calendar } from '../engine/dates.mjs';
import { split_equal } from '../engine/money.mjs';
import { make_rng, throws_code, g001_rules, G001 } from './helpers.mjs';

const d = parse_date;
const CAL = make_calendar({ weekend_dows: [0, 6], holidays: [] });
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const amounts = (rows) => rows.map((r) => r.amount_minor);

// ── TST-20: страховка 5 × 120,00 ───────────────────────────────────────────────

test('TST-20 sinking: страховка — даты 1-го числа до срока 2027-03-15 и [12000 ×5], Σ 60000', () => {
  const dates = contribution_dates(d('2026-10-04'), d('2027-03-15'), { freq: 'M', day: 1 }, CAL);
  assert.deepEqual(dates.map(format_date), ['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01', '2027-03-01'], '10-01 раньше as_of, 04-01 после срока');
  const rows = contribution_plan({ target_minor: 60000, funded_open_minor: 0, dates, mode: 'refill_to_target' });
  assert.deepEqual(amounts(rows), [12000, 12000, 12000, 12000, 12000]);
  assert.equal(sum(amounts(rows)), 60000);
  assert.deepEqual(rows.map((r) => r.date), dates);
});

test('TST-20 sinking: страховка G-001 в горизонте 57 дн. — одна аллокация 12000 на 2026-11-01 (виртуальная, не расход)', () => {
  const reserve = { reserve_id: 'RES-INS', kind: 'sinking', funded_start_minor: 0, funded_as_of: '2026-10-04', target_minor: 60000, due_date: '2027-03-15', mode: 'refill_to_target' };
  const alloc = contribution_allocations(reserve, 0, G001.as_of, G001.horizon_end, CAL, []);
  assert.deepEqual(alloc, [{ allocation_id: 'sch:RES-INS@2026-11-01', reserve_id: 'RES-INS', date: d('2026-11-01'), amount_minor: 12000, source: 'schedule' }]);
  // размер взноса зависит от всего срока (n = 5), обрезается только список строк
  const wide = contribution_allocations(reserve, 0, G001.as_of, d('2027-12-31'), CAL, []);
  assert.deepEqual(amounts(wide), [12000, 12000, 12000, 12000, 12000]);
  assert.deepEqual(wide.map((a) => a.allocation_id).slice(0, 2), ['sch:RES-INS@2026-11-01', 'sch:RES-INS@2026-12-01']);
});

// ── TST-21: отпуск с догоном и пул ─────────────────────────────────────────────

test('TST-21 sinking: отпуск 180000, funded 9500, срок 2027-07-01 → 8 дат, [21313 ×4, 21312 ×4], Σ 170500 = split_equal', () => {
  const dates = contribution_dates(d('2026-10-04'), d('2027-07-01'), { freq: 'M', day: 1 }, CAL);
  assert.equal(dates.length, 8);
  assert.equal(format_date(dates[0]), '2026-11-01');
  assert.equal(format_date(dates[7]), '2027-06-01');
  const rows = contribution_plan({ target_minor: 180000, funded_open_minor: 9500, dates, mode: 'refill_to_target' });
  assert.deepEqual(amounts(rows), [21313, 21313, 21313, 21313, 21312, 21312, 21312, 21312]);
  assert.equal(sum(amounts(rows)), 170500);
  assert.deepEqual(amounts(rows), split_equal(170500, 8), 'оракул: split_equal(rem, n)');
});

test('TST-21 sinking: день рождения 25000, funded 4000, 5 периодов → [4200 ×5]; сумма взносов дня 2026-11-01 = 37513', () => {
  const dates = contribution_dates(d('2026-10-04'), d('2027-04-01'), { freq: 'M', day: 1 }, CAL);
  assert.equal(dates.length, 5);
  const bday = contribution_plan({ target_minor: 25000, funded_open_minor: 4000, dates, mode: 'refill_to_target' });
  assert.deepEqual(amounts(bday), [4200, 4200, 4200, 4200, 4200]);
  assert.equal(12000 + bday[0].amount_minor + 21313, 37513);
});

test('TST-21 sinking: пул 37500 по весам 12000 : 4200 : 21313 → [11996, 4198, 21306]; сумма весов 0 — нули (TST-17)', () => {
  assert.deepEqual(pool_split(37500, [12000, 4200, 21313]), [11996, 4198, 21306]);
  assert.equal(sum(pool_split(37500, [12000, 4200, 21313])), 37500);
  assert.deepEqual(pool_split(1000, [0, 0, 0]), [0, 0, 0], 'все цели достигнуты');
  assert.deepEqual(pool_split(0, [1, 2]), [0, 0]);
});

test('TST-21 sinking: догон — взнос не подтверждён, пересчёт от текущего funded на 7 дат → [24358, 24357 ×6] (ALG-05 / TST-21)', () => {
  // ничего не записано: funded_open остаётся 9500, as_of сдвинулся на 2026-11-02, дат осталось 7 (12-01 … 06-01)
  const dates = contribution_dates(d('2026-11-02'), d('2027-07-01'), { freq: 'M', day: 1 }, CAL);
  assert.equal(dates.length, 7);
  const rows = contribution_plan({ target_minor: 180000, funded_open_minor: 9500, dates, mode: 'refill_to_target' });
  assert.deepEqual(amounts(rows), [24358, 24357, 24357, 24357, 24357, 24357, 24357]);
  assert.equal(sum(amounts(rows)), 170500);
});

test('TST-21 sinking: догон ALG-05 TV-3 — записаны 11-01 и 12-01, as_of 2027-01-02 → funded_open 52126, [25575 ×4, 25574]', () => {
  const reserve = { reserve_id: 'RES-VAC', kind: 'sinking', funded_start_minor: 9500, funded_as_of: '2026-10-04', target_minor: 180000, due_date: '2027-07-01', mode: 'refill_to_target' };
  const recorded = [
    { allocation_id: 'sch:RES-VAC@2026-11-01', reserve_id: 'RES-VAC', date: '2026-11-01', amount_minor: 21313, source: 'schedule' },
    { allocation_id: 'sch:RES-VAC@2026-12-01', reserve_id: 'RES-VAC', date: '2026-12-01', amount_minor: 21313, source: 'schedule' },
    { allocation_id: 'sch:OTHER@2026-12-01', reserve_id: 'OTHER', date: '2026-12-01', amount_minor: 999999, source: 'schedule' },
  ];
  const as_of = d('2027-01-02');
  const open = reserve_open(reserve, recorded, as_of);
  assert.equal(open, 52126, '9500 + 21313 + 21313; чужой резерв не считается');
  const alloc = contribution_allocations(reserve, open, as_of, d('2027-12-31'), CAL, recorded.map((a) => a.allocation_id));
  assert.deepEqual(alloc.map((a) => format_date(a.date)), ['2027-02-01', '2027-03-01', '2027-04-01', '2027-05-01', '2027-06-01']);
  assert.deepEqual(amounts(alloc), [25575, 25575, 25575, 25575, 25574]);
  assert.equal(sum(amounts(alloc)), 127874);
  assert.equal(25575 - 21313, 4262, 'первый взнос больше планового на 4262');
});

test('TST-21 sinking: идемпотентность ALG-05 TV-3b — запись 11-01 не повторяется, хвост = строки k = 1…7 из TV-2', () => {
  const reserve = { reserve_id: 'RES-VAC', kind: 'sinking', funded_start_minor: 9500, funded_as_of: '2026-10-04', target_minor: 180000, due_date: '2027-07-01', mode: 'refill_to_target' };
  const rec = [{ allocation_id: 'sch:RES-VAC@2026-11-01', reserve_id: 'RES-VAC', date: '2026-11-01', amount_minor: 21313, source: 'schedule' }];
  const as_of = d('2026-12-01');
  const open = reserve_open(reserve, rec, as_of);
  assert.equal(open, 30813);
  const a1 = contribution_allocations(reserve, open, as_of, d('2027-12-31'), CAL, ['sch:RES-VAC@2026-11-01']);
  assert.equal(a1.length, 7);
  assert.equal(format_date(a1[0].date), '2026-12-01', 'взнос в день as_of входит в день 0');
  assert.deepEqual(amounts(a1), [21313, 21313, 21313, 21312, 21312, 21312, 21312]);
  assert.equal(sum(amounts(a1)), 149187);
  // повторный вызов даёт тот же результат (чистая функция), а уже записанные id не дублируются
  assert.deepEqual(contribution_allocations(reserve, open, as_of, d('2027-12-31'), CAL, ['sch:RES-VAC@2026-11-01']), a1);
  const all_ids = a1.map((a) => a.allocation_id);
  const a2 = contribution_allocations(reserve, open + 21313, as_of, d('2027-12-31'), CAL, ['sch:RES-VAC@2026-11-01', all_ids[0]]);
  assert.ok(!a2.some((a) => a.allocation_id === all_ids[0]), 'записанный взнос 12-01 больше не в расписании');
});

test('TST-21 reserve_open: учитываются записи funded_as_of < date ≤ as_of (в т. ч. на as_of), отрицательные (release/manual) тоже', () => {
  const r = { reserve_id: 'R', funded_start_minor: 1000, funded_as_of: '2026-10-01' };
  const rec = [
    { reserve_id: 'R', date: '2026-10-01', amount_minor: 111, source: 'income' }, // не позже funded_as_of — уже в funded_start
    { reserve_id: 'R', date: '2026-10-02', amount_minor: 200, source: 'income' },
    { reserve_id: 'R', date: '2026-10-04', amount_minor: 300, source: 'income' }, // на as_of — входит
    { reserve_id: 'R', date: '2026-10-05', amount_minor: 400, source: 'income' }, // позже as_of — нет
    { reserve_id: 'R', date: '2026-10-03', amount_minor: -50, source: 'manual' },
  ];
  assert.equal(reserve_open(r, rec, '2026-10-04'), 1000 + 200 + 300 - 50);
  assert.equal(reserve_open({ reserve_id: 'R', funded_start_minor: 7 }, [], d('2026-10-04')), 7);
});

// ── TST-22: fixed, недостача; X3 ───────────────────────────────────────────────

test('TST-22 sinking fixed: отпуск, взнос 15000 × 8, funded 9500 → недостача 50500; periods_to_goal(170500, 15000) = 12', () => {
  const dates = contribution_dates(d('2026-10-04'), d('2027-07-01'), { freq: 'M', day: 1 }, CAL);
  const r = contribution_plan_fixed({ funded_open_minor: 9500, fixed_minor: 15000, dates, target_minor: 180000 });
  assert.equal(r.rows.length, 8);
  assert.ok(r.rows.every((x) => x.amount_minor === 15000));
  assert.equal(9500 + sum(amounts(r.rows)), 129500);
  assert.equal(r.shortfall_minor, 50500, '505,00 €');
  assert.equal(r.reached_on, null);
  assert.equal(periods_to_goal(170500, 15000), 12);
  assert.equal(periods_to_goal(170500, 0), null);
  assert.equal(periods_to_goal(0, 15000), 0);
});

test('TST-22 sinking fixed: взнос 30000 → [30000 ×5, 20500], reached_on 2027-04-01, shortfall 0; потолок цели', () => {
  const dates = contribution_dates(d('2026-10-04'), d('2027-07-01'), { freq: 'M', day: 1 }, CAL);
  const r = contribution_plan_fixed({ funded_open_minor: 9500, fixed_minor: 30000, dates, target_minor: 180000 });
  assert.deepEqual(amounts(r.rows), [30000, 30000, 30000, 30000, 30000, 20500]);
  assert.equal(r.shortfall_minor, 0);
  assert.equal(format_date(r.reached_on), '2027-04-01');
  assert.equal(9500 + sum(amounts(r.rows)) + r.shortfall_minor, 180000);
  // fixed_minor = 0 — строк нет, недостача = rem
  const z = contribution_plan_fixed({ funded_open_minor: 9500, fixed_minor: 0, dates, target_minor: 180000 });
  assert.deepEqual(z, { rows: [], shortfall_minor: 170500, reached_on: null });
  // цель не задана — потолка нет, недостачи нет
  const nt = contribution_plan_fixed({ funded_open_minor: 0, fixed_minor: 100, dates: dates.slice(0, 3), target_minor: null });
  assert.deepEqual(amounts(nt.rows), [100, 100, 100]);
  assert.equal(nt.shortfall_minor, 0);
  throws_code(() => contribution_plan_fixed({ funded_open_minor: 0, fixed_minor: -1, dates, target_minor: 10 }), 'E_SCHEMA');
});

test('TST-22 sinking X3: rem ≤ 0 → пустой график, shortfall 0; n = 0 и rem > 0 → пустой график, shortfall = rem, без исключения', () => {
  assert.deepEqual(contribution_plan({ target_minor: 60000, funded_open_minor: 60000, dates: [d('2026-11-01')] }), []);
  assert.deepEqual(contribution_plan({ target_minor: 60000, funded_open_minor: 70000, dates: [d('2026-11-01')] }), [], 'funded > target: отрицательных взносов нет');
  assert.deepEqual(plan_status({ target_minor: 60000, funded_open_minor: 60000, dates: [d('2026-11-01')] }), { status: 'reached', shortfall_minor: 0 });
  assert.deepEqual(plan_status({ target_minor: 60000, funded_open_minor: 70000, dates: [] }), { status: 'reached', shortfall_minor: 0 });
  // цель 60000, срок 2026-10-20, as_of 2026-10-04: ближайшая дата 11-01 уже после срока
  const dates = contribution_dates(d('2026-10-04'), d('2026-10-20'), { freq: 'M', day: 1 }, CAL);
  assert.deepEqual(dates, []);
  assert.deepEqual(contribution_plan({ target_minor: 60000, funded_open_minor: 0, dates }), []);
  assert.deepEqual(plan_status({ target_minor: 60000, funded_open_minor: 0, dates }), { status: 'no_dates', shortfall_minor: 60000 });
  assert.deepEqual(plan_status({ target_minor: 60000, funded_open_minor: 0, dates: [d('2026-11-01')] }), { status: 'ok', shortfall_minor: 0 });
  // due ≤ as_of: полуинтервал пуст
  assert.deepEqual(contribution_dates(d('2026-10-04'), d('2026-10-04'), { freq: 'M', day: 1 }, CAL), []);
  assert.deepEqual(contribution_dates(d('2026-10-04'), d('2026-01-01'), { freq: 'M', day: 1 }, CAL), []);
});

test('sinking ALG-05 граничные: rem < n → rem взносов по 1; n = 1 → один взнос; as_of на дату взноса → день 0; day 31 без дрейфа', () => {
  const dates5 = ['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01', '2027-03-01'].map(d);
  assert.deepEqual(amounts(contribution_plan({ target_minor: 3, funded_open_minor: 0, dates: dates5 })), [1, 1, 1], 'нулевые строки опущены');
  assert.deepEqual(amounts(contribution_plan({ target_minor: 777, funded_open_minor: 0, dates: [d('2026-11-01')] })), [777]);
  assert.equal(format_date(contribution_dates(d('2026-11-01'), d('2027-01-01'), { freq: 'M', day: 1 }, CAL)[0]), '2026-11-01');
  const d31 = contribution_dates(d('2026-10-04'), d('2027-06-01'), { freq: 'M', day: 31 }, CAL);
  assert.deepEqual(d31.map(format_date), ['2026-10-31', '2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31']);
  // сдвиг по календарю: 2026-11-01 — воскресенье → next = 2026-11-02, prev = 2026-10-30, skip = пропуск
  const nx = contribution_dates(d('2026-10-04'), d('2026-12-01'), { freq: 'M', day: 1, weekend: 'next' }, CAL);
  assert.deepEqual(nx.map(format_date), ['2026-11-02']);
  const pv = contribution_dates(d('2026-10-04'), d('2026-12-01'), { freq: 'M', day: 1, weekend: 'prev' }, CAL);
  assert.deepEqual(pv.map(format_date), ['2026-10-30'], '10-30 ≥ as_of: входит; 12-01 — не раньше due');
  const sk = contribution_dates(d('2026-10-04'), d('2027-01-02'), { freq: 'M', day: 1, weekend: 'skip' }, CAL);
  assert.deepEqual(sk.map(format_date), ['2026-12-01', '2027-01-01'], '11-01 — воскресенье, пропущено');
});

test('sinking: ошибки схемы — freq ≠ M, day вне 1…31, refill_to_target без due_date, не sinking, нет mode, fixed без fixed_minor', () => {
  throws_code(() => contribution_dates(d('2026-10-04'), d('2027-01-01'), { freq: 'W', day: 1 }, CAL), 'E_SCHEMA');
  throws_code(() => contribution_dates(d('2026-10-04'), d('2027-01-01'), { freq: 'M', day: 0 }, CAL), 'E_SCHEMA');
  throws_code(() => contribution_dates(d('2026-10-04'), d('2027-01-01'), { freq: 'M', day: 32 }, CAL), 'E_SCHEMA');
  const base = { reserve_id: 'R', kind: 'sinking', target_minor: 100, mode: 'refill_to_target' };
  throws_code(() => contribution_allocations(base, 0, G001.as_of, G001.horizon_end, CAL, []), 'E_SCHEMA'); // нет due_date
  throws_code(() => contribution_allocations({ ...base, kind: 'tax', due_date: '2027-01-01' }, 0, G001.as_of, G001.horizon_end, CAL, []), 'E_SCHEMA');
  throws_code(() => contribution_allocations({ ...base, mode: undefined, due_date: '2027-01-01' }, 0, G001.as_of, G001.horizon_end, CAL, []), 'E_SCHEMA');
  throws_code(() => contribution_allocations({ ...base, mode: 'fixed', due_date: '2027-01-01' }, 0, G001.as_of, G001.horizon_end, CAL, []), 'E_SCHEMA'); // нет fixed_minor
  throws_code(() => contribution_plan({ target_minor: 1, funded_open_minor: 0, dates: [1], mode: 'fixed' }), 'E_SCHEMA');
  // fixed без due_date — даты до горизонта
  const fx = contribution_allocations({ reserve_id: 'F', kind: 'sinking', mode: 'fixed', fixed_minor: 500 }, 0, G001.as_of, G001.horizon_end, CAL, []);
  assert.deepEqual(fx.map((a) => [format_date(a.date), a.amount_minor]), [['2026-11-01', 500]]);
});

// ── фаззинг и оракул (TST-51, TST-53) ──────────────────────────────────────────

test('TST-53 оракул: contribution_plan = split_equal(rem, n) без нулей; свойства инвариантов 1, 2, 5 ALG-05 (5 000 случаев)', () => {
  const rng = make_rng(2026);
  for (let it = 0; it < 5000; it++) {
    const n = rng.int(0, 70);
    const target = rng.int(0, 4_000_000);
    const funded = rng.int(0, 4_000_000);
    const dates = Array.from({ length: n }, (_, k) => 20000 + 31 * k);
    const rows = contribution_plan({ target_minor: target, funded_open_minor: funded, dates });
    const rem = target - funded;
    if (rem <= 0 || n === 0) { assert.deepEqual(rows, []); continue; }
    assert.equal(sum(amounts(rows)), rem, 'Σ взносов = rem');
    assert.deepEqual(amounts(rows), split_equal(rem, n).filter((x) => x > 0), 'оракул split_equal');
    const a = amounts(rows);
    for (let k = 1; k < a.length; k++) assert.ok(a[k] <= a[k - 1], 'не возрастают');
    assert.ok(a[0] - a[a.length - 1] <= 1, 'разброс ≤ 1 minor');
    // монотонность: рост цели или падение накоплений не уменьшает ни один взнос
    const more = contribution_plan({ target_minor: target + rng.int(0, 5000), funded_open_minor: funded, dates });
    const less = contribution_plan({ target_minor: target, funded_open_minor: Math.max(0, funded - rng.int(0, 5000)), dates });
    for (const other of [more, less]) {
      for (let k = 0; k < rows.length; k++) assert.ok((other[k]?.amount_minor ?? 0) >= rows[k].amount_minor, 'монотонность');
    }
  }
});

test('TST-51 fixed: funded + Σ rows + shortfall = target, ни один взнос не больше fixed, funded + Σ rows ≤ target (3 000 случаев)', () => {
  const rng = make_rng(77);
  for (let it = 0; it < 3000; it++) {
    const n = rng.int(0, 40);
    const target = rng.int(0, 1_000_000);
    const funded = rng.int(0, 1_000_000);
    const fixed = rng.int(0, 200_000);
    const dates = Array.from({ length: n }, (_, k) => 20000 + 30 * k);
    const r = contribution_plan_fixed({ funded_open_minor: funded, fixed_minor: fixed, dates, target_minor: target });
    const got = sum(amounts(r.rows));
    if (target - funded > 0) {
      assert.equal(funded + got + r.shortfall_minor, target);
      assert.ok(funded + got <= target);
    } else {
      assert.equal(got, 0);
      assert.equal(r.shortfall_minor, 0);
    }
    assert.ok(r.rows.every((x) => x.amount_minor <= fixed && x.amount_minor > 0));
  }
});

test('TST-17 pool_split: Σ = total, каждая доля отличается от точной пропорциональной меньше чем на 1 minor (2 000 случаев)', () => {
  const rng = make_rng(5);
  for (let it = 0; it < 2000; it++) {
    const g = rng.int(1, 8);
    const w = Array.from({ length: g }, () => rng.int(0, 50000));
    const total = rng.int(0, 5_000_000);
    const parts = pool_split(total, w);
    assert.equal(parts.length, g);
    const sw = sum(w);
    if (sw === 0) { assert.deepEqual(parts, new Array(g).fill(0)); continue; }
    assert.equal(sum(parts), total);
    parts.forEach((p, k) => {
      const exact_num = total * w[k]; // ≤ 2.5e11 — точно в Number
      assert.ok(Math.abs(p * sw - exact_num) < sw, 'отклонение < 1 minor');
    });
  }
});

// ── TST-02: ряды резервов и free на G-001 ──────────────────────────────────────

/** Ряды `trough` и `close` по дням (внутри дня: расходы раньше доходов, D-01) — независимая «медленная» модель. */
function simulate(events, opening, as_of, horizon_end) {
  const N = horizon_end - as_of + 1;
  const out = new Array(N).fill(0);
  const inn = new Array(N).fill(0);
  for (const e of events) {
    const i = e.date - as_of;
    if (i < 0 || i >= N) continue;
    if (e.amount_minor < 0) out[i] += e.amount_minor; else inn[i] += e.amount_minor;
  }
  const trough = [];
  const close = [];
  let prev = opening;
  for (let i = 0; i < N; i++) {
    trough.push(prev + out[i]);
    prev = prev + out[i] + inn[i];
    close.push(prev);
  }
  return { trough, close };
}

/** События G-001 в режиме `plan`/`worse`: правила §9.1 + P-TAX1 + поток S-HOURLY (часы → доход, +14 дн. в worse); сентябрьская выплата уже в якоре. */
function g001_events(mode, { extra = [] } = {}) {
  const win = { from: G001.as_of, to: G001.horizon_end };
  const occ = expand_all(g001_rules(), win, {}, []);
  const evs = occ.map((o) => ({ cash_event_id: o.occ_key, layer: 'planned', kind: o.kind, date: o.date, plan_date: o.date, amount_minor: o.amount_minor, tag: o.tag, rule_id: o.rule_id, stream_id: null }));
  evs.push({ cash_event_id: 'P-TAX1', layer: 'planned', kind: 'expense', date: d('2026-10-23'), plan_date: d('2026-10-23'), amount_minor: -50000, tag: 'налог', rule_id: null, stream_id: null, reserve_id: 'RES-TAX' });
  const stream = {
    stream_id: 'S-HOURLY', account_id: 'acc_main', name: 'S-HOURLY', currency: 'EUR', rate_minor: 3000, period: 'month', cutoff: { kind: 'month_end' },
    pay_lag_days: 5, weekend: 'next', hours: { min_minutes: 4800, exp_minutes: 5580, max_minutes: 6600 },
  };
  for (const e of expand_stream(stream, win, CAL, { rounding: 'half_even' })) {
    if (e.occ_key === 'S-HOURLY@2026-10-05') continue; // сентябрьская выплата получена 10-02 и входит в якорь (сопоставление план→факт, ALG-13)
    evs.push({ ...e, plan_date: e.date, date: mode === 'worse' ? e.date + 14 : e.date });
  }
  return [...evs, ...extra];
}

const TR20 = [{
  tax_rule_id: 'TR-20', version: 1, kind: 'percent_of_income', rate_bp: 2000, base: 'gross', applies_to: { stream_ids: ['S-HOURLY'], tags: [] },
  valid_from: '2026-01-01', valid_to: null, rounding: 'half_even', reserve_id: 'RES-TAX', recorded_at: '2026-01-01T00:00:00Z',
}];
const RES_INS = { reserve_id: 'RES-INS', kind: 'sinking', funded_start_minor: 0, funded_as_of: '2026-10-04', target_minor: 60000, due_date: '2027-03-15', mode: 'refill_to_target' };

/** Полный расчёт G-001 для режима: ряды, резервы, free. */
function g001_run(mode, { opening = 400000, extra = [], res_tax_open = 150000 } = {}) {
  const events = g001_events(mode, { extra });
  const { trough, close } = simulate(events, opening, G001.as_of, G001.horizon_end);
  const reserves = [
    { reserve_id: 'RES-TAX', kind: 'tax', funded_open_minor: res_tax_open },
    { reserve_id: 'RES-INS', kind: 'sinking', funded_open_minor: reserve_open(RES_INS, [], G001.as_of) },
  ];
  const allocations = [
    ...allocations_for_events(events, TR20, G001.as_of),
    ...contribution_allocations(RES_INS, 0, G001.as_of, G001.horizon_end, CAL, []),
  ];
  const rs = reserve_series(reserves, events, allocations, G001.as_of, G001.horizon_end);
  const free = free_series(trough, rs.reserve_trough);
  return { events, trough, close, rs, free, allocations };
}

const idx = (iso) => d(iso) - G001.as_of;
const argmin_first = (xs) => xs.reduce((k, x, i) => (x < xs[k] ? i : k), 0);

test('TST-02 G-001 plan: reserve_trough/reserve_close/free по таблице §9.4 (ключевые даты), free min 93500 на 2026-11-01', () => {
  const r = g001_run('plan');
  const at = (arr, iso) => arr[idx(iso)];
  // trough/close физических денег (контроль модели: Q1 min 205500 · 10-31, end_close 340000)
  assert.equal(Math.min(...r.trough), 205500);
  assert.equal(r.close.at(-1), 340000);
  // таблица §9.4, режим plan: [T, C, Rт, F]
  const rows = {
    '2026-10-04': [400000, 400000, 150000, 250000],
    '2026-10-23': [327500, 327500, 100000, 227500],
    '2026-10-26': [215500, 215500, 100000, 115500],
    '2026-10-31': [205500, 205500, 100000, 105500],
    '2026-11-01': [205500, 205500, 112000, 93500],
    '2026-11-05': [205500, 484500, 112000, 93500],
    '2026-11-07': [474500, 474500, 167800, 306700],
    '2026-11-14': [462000, 462000, 167800, 294200],
    '2026-11-25': [350000, 350000, 167800, 182200],
    '2026-11-30': [340000, 340000, 167800, 172200],
  };
  for (const [iso, [T, C, Rt, F]] of Object.entries(rows)) {
    assert.equal(at(r.trough, iso), T, `trough ${iso}`);
    assert.equal(at(r.close, iso), C, `close ${iso}`);
    assert.equal(at(r.rs.reserve_trough, iso), Rt, `reserve_trough ${iso}`);
    assert.equal(at(r.free, iso), F, `free ${iso}`);
  }
  const k = argmin_first(r.free);
  assert.equal(r.free[k], 93500, 'G-001.free.min.plan');
  assert.equal(format_date(G001.as_of + k), '2026-11-01');
  assert.equal(r.rs.reserve_close.at(-1), 167800, 'G-001.reserve_close.end');
  // состав на конец горизонта: RES-TAX = 150000 − 50000 + 55800, RES-INS = 12000
  assert.equal(r.rs.by_reserve['RES-TAX'].close.at(-1), 155800);
  assert.equal(r.rs.by_reserve['RES-INS'].close.at(-1), 12000);
  // аллокация 55800 входит в reserve_close в день дохода, в reserve_trough — со следующего дня
  assert.equal(at(r.rs.by_reserve['RES-TAX'].allocated, '2026-11-05'), 55800);
  assert.equal(at(r.rs.reserve_close, '2026-11-05') - at(r.rs.reserve_trough, '2026-11-05'), 55800);
  assert.equal(at(r.rs.reserve_trough, '2026-11-06'), 167800);
  // налог 10-23 освобождает резерв: released 50000, true_up 0
  assert.equal(at(r.rs.by_reserve['RES-TAX'].released, '2026-10-23'), 50000);
  assert.equal(at(r.rs.by_reserve['RES-TAX'].true_up, '2026-10-23'), 0);
  assert.equal(at(r.rs.by_reserve['RES-INS'].contributed, '2026-11-01'), 12000);
  // free = trough − reserve_trough; резерв не меняет trough/close (REQ-060): ряды совпадают с рядами без резервов
  const none = reserve_series([], r.events, [], G001.as_of, G001.horizon_end);
  assert.deepEqual(none.reserve_trough, new Array(r.trough.length).fill(0));
  assert.deepEqual(free_series(r.trough, none.reserve_trough), r.trough, 'TST-39: без резервов free = trough');
});

test('TST-02 G-001 worse: доход на 11-19, free min 71000 на 2026-11-14, reserve_close.end 167800 в обоих режимах', () => {
  const r = g001_run('worse');
  const at = (arr, iso) => arr[idx(iso)];
  const rows = {
    '2026-11-05': [205500, 205500, 112000, 93500],
    '2026-11-07': [195500, 195500, 112000, 83500],
    '2026-11-09': [193000, 193000, 112000, 81000],
    '2026-11-14': [183000, 183000, 112000, 71000],
    '2026-11-19': [183000, 462000, 112000, 71000],
    '2026-11-21': [452000, 452000, 167800, 284200],
    '2026-11-30': [340000, 340000, 167800, 172200],
  };
  for (const [iso, [T, C, Rt, F]] of Object.entries(rows)) {
    assert.equal(at(r.trough, iso), T, `trough ${iso}`);
    assert.equal(at(r.close, iso), C, `close ${iso}`);
    assert.equal(at(r.rs.reserve_trough, iso), Rt, `reserve_trough ${iso}`);
    assert.equal(at(r.free, iso), F, `free ${iso}`);
  }
  const k = argmin_first(r.free);
  assert.equal(r.free[k], 71000, 'G-001.free.min.worse');
  assert.equal(format_date(G001.as_of + k), '2026-11-14');
  assert.equal(r.rs.reserve_close.at(-1), 167800);
  assert.equal(at(r.rs.by_reserve['RES-TAX'].allocated, '2026-11-19'), 55800, 'та же аллокация, дата сдвинута (версия по base(e), C-016)');
  // worse не лучше plan по free (инвариант 8 ALG-11, безусловно)
  const p = g001_run('plan');
  r.free.forEach((f, i) => assert.ok(f <= p.free[i], `free_worse ≤ free_plan, день ${i}`));
});

test('TST-06/TST-39 (часть) STS по рядам free: T=10-31 → 55500/55500; T=11-19 → 43500/21000; T=horizon_end → 43500/21000 (B = 50000)', () => {
  const B = 50000;
  const sts = (r, T) => Math.max(0, Math.min(...r.free.slice(0, d(T) - G001.as_of + 1)) - B);
  const p = g001_run('plan');
  const w = g001_run('worse');
  assert.deepEqual([sts(p, '2026-10-31'), sts(w, '2026-10-31')], [55500, 55500]);
  assert.deepEqual([sts(p, '2026-11-19'), sts(w, '2026-11-19')], [43500, 21000]);
  assert.deepEqual([sts(p, '2026-11-30'), sts(w, '2026-11-30')], [43500, 21000]);
  // без резервов: STS(11-19) = 205500 − 50000 / 183000 − 50000 (ALG-11 TV-6)
  assert.equal(Math.min(...p.trough.slice(0, idx('2026-11-19') + 1)) - B, 155500);
  assert.equal(Math.min(...w.trough.slice(0, idx('2026-11-19') + 1)) - B, 133000);
});

test('TST-08 G-001-low: opening 220000 → min free −86500 · 11-01 (plan), −109000 · 11-14 (worse); физические деньги ≥ 0', () => {
  const p = g001_run('plan', { opening: 220000 });
  const w = g001_run('worse', { opening: 220000 });
  assert.equal(Math.min(...p.free), -86500);
  assert.equal(format_date(G001.as_of + argmin_first(p.free)), '2026-11-01');
  assert.equal(Math.min(...w.free), -109000);
  assert.equal(format_date(G001.as_of + argmin_first(w.free)), '2026-11-14');
  assert.equal(Math.min(...p.trough), 25500);
  assert.equal(Math.min(...w.trough), 3000);
  assert.equal(50000 + 86500, 136500); // short_to_buffer = B − min free
});

test('G-001-gap: opening 100000 → min free plan −206500 · 11-01, worse −229000 · 11-14 (short_to_buffer 256500 / 279000)', () => {
  const p = g001_run('plan', { opening: 100000 });
  const w = g001_run('worse', { opening: 100000 });
  assert.equal(Math.min(...p.free), -206500);
  assert.equal(Math.min(...w.free), -229000);
  assert.equal(50000 + 206500, 256500);
  assert.equal(50000 + 229000, 279000);
});

test('G-001-late: расход −250000 на 2026-11-26 → до 11-19 min free 93500 / 71000, на горизонте −77800 (11-28) в обоих режимах', () => {
  const extra = [{ cash_event_id: 'P-X', layer: 'planned', kind: 'expense', date: d('2026-11-26'), plan_date: d('2026-11-26'), amount_minor: -250000, tag: 'x', rule_id: null, stream_id: null }];
  const p = g001_run('plan', { extra });
  const w = g001_run('worse', { extra });
  assert.equal(Math.min(...p.free.slice(0, idx('2026-11-19') + 1)), 93500);
  assert.equal(Math.min(...w.free.slice(0, idx('2026-11-19') + 1)), 71000);
  for (const r of [p, w]) {
    assert.equal(Math.min(...r.free), -77800);
    assert.equal(format_date(G001.as_of + argmin_first(r.free)), '2026-11-28');
    assert.equal(r.trough[idx('2026-11-28')], 90000);
    assert.equal(r.rs.reserve_trough[idx('2026-11-28')], 167800);
  }
  assert.equal(50000 + 77800, 127800); // short_to_buffer
});

// ── ALG-11 TV-5: платёж больше резерва; граничные случаи reserve_series ─────────

test('TST-24/TST-02 ALG-11 TV-5: RES-TAX funded_open 30000, платёж 50000 → released 30000, true_up 20000, free падает на true_up (347500 → 327500)', () => {
  const r = g001_run('plan', { res_tax_open: 30000 });
  const b = r.rs.by_reserve['RES-TAX'];
  assert.equal(b.released[idx('2026-10-23')], 30000);
  assert.equal(b.true_up[idx('2026-10-23')], 20000);
  assert.equal(b.trough[idx('2026-10-22')], 30000);
  assert.equal(b.trough[idx('2026-10-23')], 0);
  assert.equal(r.free[idx('2026-10-22')], 347500);
  assert.equal(r.free[idx('2026-10-23')], 327500);
  assert.equal(Math.min(...r.free), 193500);
  const w = g001_run('worse', { res_tax_open: 30000 });
  assert.equal(Math.min(...w.free), 171000);
});

test('reserve_series: платёж при пустом резерве — released 0, true_up = весь платёж; платёж, привязанный к резерву, не вычитается дважды (инв. 5)', () => {
  const ev = [{ date: 5, amount_minor: -700, reserve_id: 'R' }, { date: 6, amount_minor: -50, reserve_id: 'R' }];
  const r0 = reserve_series([{ reserve_id: 'R', kind: 'tax', funded_open_minor: 0 }], ev, [], 0, 9);
  assert.equal(r0.by_reserve.R.released[5], 0);
  assert.equal(r0.by_reserve.R.true_up[5], 700);
  // резерв 1000 ≥ платежа: trough падает на платёж, резерв — на высвобождение, free не меняется
  const r1 = reserve_series([{ reserve_id: 'R', kind: 'tax', funded_open_minor: 1000 }], ev, [], 0, 9);
  assert.deepEqual(r1.reserve_trough, [1000, 1000, 1000, 1000, 1000, 300, 250, 250, 250, 250]);
  assert.equal(r1.by_reserve.R.true_up.every((x) => x === 0), true);
  const trough = [5000, 5000, 5000, 5000, 5000, 4300, 4250, 4250, 4250, 4250];
  const free = free_series(trough, r1.reserve_trough);
  assert.deepEqual(free, [4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000]);
});

test('reserve_series: ручная правка (manual ±) и взнос в начале дня; остаток не уходит ниже 0; manual-освобождение остатка (C-059)', () => {
  const allocs = [
    { allocation_id: 'm1', reserve_id: 'R', date: 2, amount_minor: 500, source: 'manual' },
    { allocation_id: 'm2', reserve_id: 'R', date: 4, amount_minor: -10000, source: 'manual' }, // сильнее остатка → 0, не минус
    { allocation_id: 'inc', reserve_id: 'R', date: 6, amount_minor: 300, source: 'income' },
  ];
  const r = reserve_series([{ reserve_id: 'R', kind: 'sinking', funded_open_minor: 1000 }], [], allocs, 0, 7);
  assert.deepEqual(r.reserve_trough, [1000, 1000, 1500, 1500, 0, 0, 0, 300], 'аллокация дохода дня 6 — в close дня 6, в trough со дня 7');
  assert.deepEqual(r.reserve_close, [1000, 1000, 1500, 1500, 0, 0, 300, 300]);
  assert.deepEqual(r.by_reserve.R.contributed, [0, 0, 500, 0, -1500, 0, 0, 0], 'contributed = фактическое изменение funded (с учётом пола 0)');
  assert.deepEqual(r.by_reserve.R.allocated, [0, 0, 0, 0, 0, 0, 300, 0]);
});

test('reserve_series: резерв, привязанный к счёту (backed_by_account_id), в ряд не входит; чужие резервы и события вне окна игнорируются', () => {
  const reserves = [
    { reserve_id: 'A', kind: 'tax', funded_open_minor: 100 },
    { reserve_id: 'B', kind: 'sinking', funded_open_minor: 900, backed_by_account_id: 'acc_save' },
  ];
  const ev = [{ date: 1, amount_minor: -40, reserve_id: 'A' }, { date: 1, amount_minor: -40, reserve_id: 'B' }, { date: 50, amount_minor: -40, reserve_id: 'A' }, { date: -3, amount_minor: -40, reserve_id: 'A' }];
  const r = reserve_series(reserves, ev, [{ allocation_id: 'x', reserve_id: 'B', date: 1, amount_minor: 7, source: 'schedule' }], 0, 3);
  assert.deepEqual(Object.keys(r.by_reserve), ['A']);
  assert.deepEqual(r.reserve_trough, [100, 60, 60, 60]);
});

test('reserve_series: ошибки — аллокация раньше as_of, funded_open < 0, неизвестный источник, horizon_end < as_of, длины рядов free', () => {
  const R = [{ reserve_id: 'R', kind: 'tax', funded_open_minor: 10 }];
  throws_code(() => reserve_series(R, [], [{ allocation_id: 'p', reserve_id: 'R', date: -1, amount_minor: 5, source: 'schedule' }], 0, 5), 'E_SCHEMA');
  throws_code(() => reserve_series([{ reserve_id: 'R', kind: 'tax', funded_open_minor: -1 }], [], [], 0, 5), 'E_SCHEMA');
  throws_code(() => reserve_series(R, [], [{ allocation_id: 'p', reserve_id: 'R', date: 1, amount_minor: 5, source: 'бонус' }], 0, 5), 'E_SCHEMA');
  throws_code(() => reserve_series(R, [], [{ allocation_id: 'neg', reserve_id: 'R', date: 1, amount_minor: -5, source: 'income' }], 0, 5), 'E_SCHEMA');
  throws_code(() => reserve_series(R, [], [], 5, 4), 'E_BAD_DATE');
  throws_code(() => reserve_series([R[0], R[0]], [], [], 0, 5), 'E_SCHEMA');
  throws_code(() => free_series([1, 2], [1]), 'E_SCHEMA');
  // аллокация после горизонта не учитывается
  const r = reserve_series(R, [], [{ allocation_id: 'late', reserve_id: 'R', date: 99, amount_minor: 5, source: 'schedule' }], 0, 5);
  assert.deepEqual(r.reserve_close, [10, 10, 10, 10, 10, 10]);
});

test('TST-33 (часть) reserve_series детерминизм: порядок reserves, events и allocations не влияет; баланс резерва (инв. 3, 4 ALG-11) на 300 случайных наборах', () => {
  const rng = make_rng(11);
  for (let it = 0; it < 300; it++) {
    const N = rng.int(1, 40);
    const ids = ['T1', 'S1', 'S2', 'X'].slice(0, rng.int(1, 4));
    const reserves = ids.map((id) => ({ reserve_id: id, kind: id === 'T1' ? 'tax' : 'sinking', funded_open_minor: rng.int(0, 5000) }));
    const events = Array.from({ length: rng.int(0, 15) }, () => ({ date: rng.int(0, N - 1), amount_minor: -rng.int(1, 3000), reserve_id: rng.pick([...ids, null]) }));
    const allocs = Array.from({ length: rng.int(0, 15) }, (_, k) => ({
      allocation_id: 'a' + k, reserve_id: rng.pick(ids), date: rng.int(0, N + 3), amount_minor: 0, source: rng.pick(['income', 'schedule', 'manual']),
    }));
    for (const x of allocs) x.amount_minor = x.source === 'income' ? rng.int(0, 2000) : rng.int(-500, 2000); // доходная аллокация ≥ 0
    const shuffle = (xs) => xs.map((x) => [rng.next(), x]).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
    const a = reserve_series(reserves, events, allocs, 0, N - 1);
    const b = reserve_series(shuffle(reserves), shuffle(events), shuffle(allocs), 0, N - 1);
    assert.deepEqual(a, b, 'порядок входов не влияет');
    for (const id of ids) {
      const br = a.by_reserve[id];
      let funded = reserves.find((r) => r.reserve_id === id).funded_open_minor;
      for (let i = 0; i < N; i++) {
        assert.ok(br.trough[i] >= 0 && br.close[i] >= 0, 'funded ≥ 0');
        funded += br.contributed[i] - br.released[i] + br.allocated[i];
        assert.equal(br.close[i], funded, 'funded_end = open + Σ contributed + Σ allocated − Σ released');
        const paid = events.filter((e) => e.reserve_id === id && e.date === i).reduce((s, e) => s - e.amount_minor, 0);
        assert.equal(br.released[i] + br.true_up[i], paid, 'released + true_up = |платёж|');
      }
    }
    for (let i = 0; i < N; i++) {
      assert.equal(a.reserve_close[i] - a.reserve_trough[i], ids.reduce((s, id) => s + a.by_reserve[id].allocated[i], 0), 'close − trough = Σ allocated');
      assert.ok(a.reserve_trough[i] >= 0);
    }
  }
});
