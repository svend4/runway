// dates.test.mjs — TST-15 (даты), TST-12/13 (сдвиги, рабочие дни), TST-11 (add_months без дрейфа), TST-51 (фаззинг 1970–2100).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parse_date, format_date, days_from_civil, civil_from_days, dow, is_leap, days_in_month, clamp_day, add_months, add_years,
  end_of_month, diff_days, make_calendar, is_business, next_business_day, prev_business_day, nth_business_day,
  shift_by_policy, to_epoch_day,
} from '../engine/dates.mjs';
import { make_rng, throws_code } from './helpers.mjs';

const D = parse_date;

test('TST-15 parse_date: канонические EpochDay §9.10', () => {
  assert.equal(D('2026-10-04'), 20730);
  assert.equal(D('2026-11-30'), 20787);
  assert.equal(D('2027-03-15'), 20892);
  assert.equal(D('2028-02-29'), 21243);
  assert.equal(D('1970-01-01'), 0);
  assert.equal(D('1969-12-31'), -1);
  assert.equal(format_date(20730), '2026-10-04');
  assert.equal(format_date(0), '1970-01-01');
  assert.equal(format_date(-1), '1969-12-31');
});

test('TST-15 dow: воскресенье = 0, dow(0) = 4 (четверг)', () => {
  assert.equal(dow(20730), 0);
  assert.equal(dow(0), 4);
  assert.equal(dow(D('2026-10-05')), 1, 'понедельник');
  assert.equal(dow(D('2026-10-10')), 6, 'суббота');
  assert.equal(dow(-1), 3);
  for (let z = -50; z < 50; z++) assert.equal(dow(z + 7), dow(z));
});

test('TST-15 days_from_civil / civil_from_days: расчёт Хиннанта §9.10 по шагам', () => {
  assert.equal(days_from_civil(2026, 10, 4), 20730);
  const [y, m, d] = civil_from_days(20730);
  assert.deepEqual([y, m, d], [2026, 10, 4]);
  const c = civil_from_days(20730);
  assert.equal(c.y, 2026); assert.equal(c.m, 10); assert.equal(c.d, 4);
  assert.deepEqual(civil_from_days(-719468).slice(), [0, 3, 1], 'эпоха алгоритма: 0000-03-01');
  assert.equal(days_from_civil(1, 1, 1), -719162);
  assert.equal(days_from_civil(9999, 12, 31), 2932896);
});

test('is_leap / days_in_month / clamp_day / end_of_month', () => {
  assert.deepEqual([1900, 2000, 2024, 2026, 2028, 2100].map(is_leap), [false, true, true, false, true, false]);
  assert.equal(days_in_month(2028, 2), 29);
  assert.equal(days_in_month(2100, 2), 28);
  assert.equal(days_in_month(2026, 4), 30);
  assert.equal(days_in_month(2026, 12), 31);
  assert.equal(clamp_day(2026, 2, 31), 28);
  assert.equal(clamp_day(2028, 2, 31), 29);
  assert.equal(clamp_day(2026, 3, 15), 15);
  assert.equal(format_date(end_of_month(D('2026-10-04'))), '2026-10-31');
  assert.equal(format_date(end_of_month(D('2028-02-10'))), '2028-02-29');
  assert.equal(diff_days(D('2026-10-04'), D('2026-11-30')), 57, 'горизонт G-001: 57 дней');
  assert.equal(diff_days(D('2026-11-30'), D('2026-10-04')), -57);
});

test('parse_date / format_date: отказы E_BAD_DATE', () => {
  for (const bad of ['2026-02-29', '2026-13-01', '2026-00-10', '2026-10-32', '2026-1-1', '26-10-04', '2026/10/04', '2026-10-04T00:00', '', ' 2026-10-04',
    '0000-01-01', 'abcd-ef-gh', '２０２６-10-04']) {
    throws_code(() => parse_date(bad), 'E_BAD_DATE', bad);
  }
  throws_code(() => parse_date(20730), 'E_BAD_DATE');
  throws_code(() => parse_date(null), 'E_BAD_DATE');
  assert.equal(D('2028-02-29'), 21243);
  throws_code(() => format_date(D('9999-12-31') + 1), 'E_BAD_DATE');
  throws_code(() => format_date(D('0001-01-01') - 1), 'E_BAD_DATE');
  throws_code(() => format_date(1.5), 'E_BAD_DATE');
  throws_code(() => days_from_civil(2026, 2, 29), 'E_BAD_DATE');
  throws_code(() => days_from_civil(2026, 13, 1), 'E_BAD_DATE');
  throws_code(() => days_in_month(2026, 0), 'E_BAD_DATE');
});

test('to_epoch_day: строка или целое', () => {
  assert.equal(to_epoch_day('2026-10-04'), 20730);
  assert.equal(to_epoch_day(20730), 20730);
  throws_code(() => to_epoch_day(1.5), 'E_BAD_DATE');
  throws_code(() => to_epoch_day('x'), 'E_BAD_DATE');
});

test('TST-11 add_months: конец месяца без дрейфа (от 2026-01-31, k = 0…5, 13, 25)', () => {
  const start = D('2026-01-31');
  const k = (n) => format_date(add_months(start, n));
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(k), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);
  assert.equal(k(13), '2027-02-28');
  assert.equal(k(25), '2028-02-29');
  // наивное «+1 месяц» от предыдущей даты дрейфует: 31→28→28→28
  let naive = start; const seq = [];
  for (let i = 0; i < 4; i++) { seq.push(format_date(naive)); naive = add_months(naive, 1); }
  assert.deepEqual(seq, ['2026-01-31', '2026-02-28', '2026-03-28', '2026-04-28']);
  assert.equal(format_date(add_months(D('2026-03-31'), -1)), '2026-02-28');
  assert.equal(format_date(add_months(D('2026-01-15'), -14)), '2024-11-15');
  assert.equal(format_date(add_years(D('2028-02-29'), 1)), '2029-02-28');
  assert.equal(format_date(add_years(D('2028-02-29'), 4)), '2032-02-29');
  assert.equal(format_date(add_years(D('2026-10-04'), -1)), '2025-10-04');
});

const WK = make_calendar({ weekend_dows: [0, 6], holidays: [] });

test('TST-12 shift_by_policy: 2026-10-25 (воскресенье) next/prev/keep/skip; 11-25 (среда) без сдвига', () => {
  const sun = D('2026-10-25');
  assert.equal(format_date(shift_by_policy(sun, 'next', WK)), '2026-10-26');
  assert.equal(format_date(shift_by_policy(sun, 'prev', WK)), '2026-10-23');
  assert.equal(format_date(shift_by_policy(sun, 'keep', WK)), '2026-10-25');
  assert.equal(shift_by_policy(sun, 'skip', WK), null);
  const wed = D('2026-11-25');
  for (const p of ['next', 'prev', 'keep', 'skip']) assert.equal(shift_by_policy(wed, p, WK), wed, p);
  throws_code(() => shift_by_policy(sun, 'later', WK), 'E_SCHEMA');
});

test('make_calendar: выходные по умолчанию, праздники, max_shift, цепочка 25 и 28 декабря 2026', () => {
  assert.deepEqual(make_calendar().weekend_dows, [0, 6]);
  assert.deepEqual(make_calendar({}).holidays, []);
  assert.equal(make_calendar({}).max_shift, 2);
  const cal = make_calendar({ weekend_dows: [6, 0], holidays: ['2026-12-28', '2026-12-25', '2026-12-25'] });
  assert.deepEqual(cal.weekend_dows, [0, 6], 'выходные отсортированы');
  assert.deepEqual(cal.holidays, ['2026-12-25', '2026-12-28'], 'праздники отсортированы и без дублей');
  assert.equal(cal.max_shift, 4, '25 дек (пт) + сб + вс + 28 дек (пн) = 4 нерабочих подряд');
  const dec25 = D('2026-12-25');
  assert.equal(format_date(shift_by_policy(dec25, 'next', cal)), '2026-12-29');
  assert.equal(format_date(shift_by_policy(dec25, 'prev', cal)), '2026-12-24');
  assert.equal(format_date(shift_by_policy(dec25, 'keep', cal)), '2026-12-25');
  assert.equal(shift_by_policy(dec25, 'skip', cal), null);
  assert.equal(is_business(D('2026-12-24'), cal), true);
  assert.equal(is_business(D('2026-12-25'), cal), false);
  assert.equal(is_business(D('2026-12-26'), cal), false);
  assert.equal(is_business(D('2026-12-29'), cal), true);
  assert.equal(format_date(next_business_day(D('2026-12-26'), cal)), '2026-12-29');
  assert.equal(format_date(prev_business_day(D('2026-12-28'), cal)), '2026-12-24');
  assert.equal(next_business_day(D('2026-12-29'), cal), D('2026-12-29'));
  assert.ok(Object.isFrozen(cal));
  throws_code(() => make_calendar({ weekend_dows: [0, 1, 2, 3, 4, 5, 6] }), 'E_RULE_INVALID');
  throws_code(() => make_calendar({ weekend_dows: [7] }), 'E_RULE_INVALID');
  throws_code(() => make_calendar({ holidays: ['2026-02-30'] }), 'E_BAD_DATE');
  // один рабочий день в неделе: сдвиг найдётся
  const one = make_calendar({ weekend_dows: [0, 1, 2, 3, 5, 6] });
  assert.equal(dow(next_business_day(D('2026-10-05'), one)), 4);
  assert.equal(one.max_shift, 6);
  // «сырой» календарь без max_shift (как из журнала) тоже работает
  assert.equal(is_business(D('2026-10-10'), { weekend_dows: [0, 6], holidays: [] }), false);
  assert.equal(is_business(D('2026-10-12'), { holidays: ['2026-10-12'] }), false, 'выходные по умолчанию, праздник из списка');
  throws_code(() => is_business(1, null), 'E_SCHEMA');
});

test('TST-13 nth_business_day: 3-й рабочий день ноября 2026, последний рабочий октября 2026', () => {
  assert.equal(format_date(nth_business_day(2026, 11, 3, WK)), '2026-11-04', '11-01 воскресенье → 02, 03, 04');
  assert.equal(format_date(nth_business_day(2026, 11, 1, WK)), '2026-11-02');
  assert.equal(format_date(nth_business_day(2026, 10, -1, WK)), '2026-10-30', '10-31 — суббота');
  assert.equal(format_date(nth_business_day(2026, 10, -2, WK)), '2026-10-29');
  assert.equal(format_date(nth_business_day(2026, 10, 1, WK)), '2026-10-01');
  assert.equal(nth_business_day(2026, 2, 25, WK), null, 'в феврале меньше 25 рабочих дней');
  assert.equal(nth_business_day(2026, 2, -25, WK), null);
  const hol = make_calendar({ holidays: ['2026-11-02'] });
  assert.equal(format_date(nth_business_day(2026, 11, 1, hol)), '2026-11-03', 'праздник пропускается');
  throws_code(() => nth_business_day(2026, 11, 0, WK), 'E_RULE_INVALID');
});

// ── TST-51: фаззинг дат ───────────────────────────────────────────────────────

test('TST-51 все 47 847 дней 1970–2100: civil_from_days ↔ days_from_civil, dow, parse/format — против Date (UTC) как оракула', () => {
  const first = days_from_civil(1970, 1, 1);
  const last = days_from_civil(2100, 12, 31);
  assert.equal(first, 0);
  assert.equal(last - first + 1, 47847, 'ровно 47 847 дней в 1970–2100');
  for (let z = first; z <= last; z++) {
    const dt = new Date(z * 86400000); // оракул — только в тестах
    const y = dt.getUTCFullYear(); const m = dt.getUTCMonth() + 1; const d = dt.getUTCDate();
    const [yy, mm, dd] = civil_from_days(z);
    if (yy !== y || mm !== m || dd !== d) assert.fail(`civil_from_days(${z}) = ${yy}-${mm}-${dd}, оракул ${y}-${m}-${d}`);
    if (days_from_civil(y, m, d) !== z) assert.fail(`days_from_civil(${y},${m},${d}) ≠ ${z}`);
    if (dow(z) !== dt.getUTCDay()) assert.fail(`dow(${z})`);
    const iso = format_date(z);
    if (iso !== dt.toISOString().slice(0, 10)) assert.fail(`format_date(${z}) = ${iso}`);
    if (parse_date(iso) !== z) assert.fail(`parse_date(${iso}) ≠ ${z}`);
  }
});

test('TST-51 29 февраля: 2028-02-29 существует (21243), 2100-02-29 — нет; високосные годы 1970–2100', () => {
  assert.equal(D('2028-02-29'), 21243);
  throws_code(() => parse_date('2100-02-29'), 'E_BAD_DATE');
  throws_code(() => parse_date('2026-02-29'), 'E_BAD_DATE');
  assert.equal(D('2000-02-29') + 1, D('2000-03-01'));
  for (let y = 1970; y <= 2100; y++) {
    const oracle = new Date(Date.UTC(y, 1, 29)).getUTCMonth() === 1;
    assert.equal(is_leap(y), oracle, `is_leap(${y})`);
    assert.equal(days_in_month(y, 2), oracle ? 29 : 28);
    assert.equal(days_from_civil(y + 1, 1, 1) - days_from_civil(y, 1, 1), oracle ? 366 : 365);
  }
});

test('TST-51 add_months: оракул «день из исходной даты, зажатый до длины месяца», 20 000 случайных случаев', () => {
  const rng = make_rng(5151);
  const lo = days_from_civil(1970, 1, 1);
  const hi = days_from_civil(2100, 12, 31);
  for (let i = 0; i < 20000; i++) {
    const z = rng.int(lo, hi);
    const n = rng.int(-400, 400);
    const dt = new Date(z * 86400000);
    const t = dt.getUTCFullYear() * 12 + dt.getUTCMonth() + n;
    const y = Math.floor(t / 12); const m = ((t % 12) + 12) % 12;
    const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const want = Date.UTC(y, m, Math.min(dt.getUTCDate(), dim)) / 86400000;
    assert.equal(add_months(z, n), want, `add_months(${format_date(z)}, ${n})`);
    // без дрейфа: nominal_k = add_months(start, k·1) для всех k, а не накопление
    assert.equal(add_months(z, 12 * n), add_years(z, n));
  }
});

test('TST-51 конец месяца: от 29/30/31-го числа ряд add_months(start, k) не дрейфует и совпадает с зажатием', () => {
  for (const day of [29, 30, 31]) {
    const start = D(`2027-01-${day}`);
    for (let k = 0; k < 120; k++) {
      const [y, m, d] = civil_from_days(add_months(start, k));
      assert.equal(d, Math.min(day, days_in_month(y, m)), `день ${day}, k=${k}`);
    }
  }
});

test('TST-51 сдвиги выходных: next/prev дают рабочий день, расстояние ≤ max_shift (случайные календари)', () => {
  const rng = make_rng(2051);
  for (let i = 0; i < 400; i++) {
    const n_weekend = rng.int(0, 3);
    const wk = new Set();
    while (wk.size < n_weekend) wk.add(rng.int(0, 6));
    const holidays = Array.from({ length: rng.int(0, 12) }, () => format_date(rng.int(20000, 21000)));
    const cal = make_calendar({ weekend_dows: [...wk], holidays });
    for (let j = 0; j < 60; j++) {
      const z = rng.int(20000, 21000);
      const nx = shift_by_policy(z, 'next', cal);
      const pv = shift_by_policy(z, 'prev', cal);
      assert.ok(is_business(nx, cal) && is_business(pv, cal));
      assert.ok(nx >= z && nx - z <= cal.max_shift, `next: ${nx - z} > max_shift ${cal.max_shift}`);
      assert.ok(pv <= z && z - pv <= cal.max_shift);
      if (is_business(z, cal)) assert.ok(nx === z && pv === z);
    }
  }
});

// FP-12 (REQ-175, мутация D23): days_in_month сам отвергает месяц вне 1…12, а не полагается на проверку вызывающего.
test('REQ-175 TST-15 days_in_month: месяц 0, 13, дробный и нечисловой год — E_BAD_DATE (границы 1…12 проверяются самой функцией)', () => {
  for (const m of [0, 13, -1, 12.5, 100]) throws_code(() => days_in_month(2026, m), 'E_BAD_DATE', `месяц ${m}`);
  throws_code(() => days_in_month(2026.5, 3), 'E_BAD_DATE');
  assert.deepEqual([1, 2, 12].map((m) => days_in_month(2026, m)), [31, 28, 31]);
  assert.equal(days_in_month(2028, 2), 29);
  assert.equal(days_in_month(2100, 2), 28);
});
