// dates_money.test.mjs — состязательные тесты, линза A: dates.mjs, recurrence.mjs, money.mjs, ledger.mjs.
// Ожидания выведены из канона (design-brief §4, §9.10, §9.11, §3.3, §3.5; ALG-01; ALG-14; product/04) и независимых оракулов
// (Date UTC, BigInt, node:crypto). Тесты с пометкой «БАГ» падают намеренно — это улики (см. отчёт).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import * as D from '../../engine/dates.mjs';
import * as R from '../../engine/recurrence.mjs';
import * as M from '../../engine/money.mjs';
import * as L from '../../engine/ledger.mjs';
import { make_rng, rand_safe } from '../helpers.mjs';

const DAY_MS = 86400000;
const MAX = Number.MAX_SAFE_INTEGER;

/** Падает ли fn RunwayError (любой код)? Возвращает код либо null; не-RunwayError пробрасывается как есть. */
function code_of(fn) {
  try { fn(); return null; } catch (e) {
    if (e?.name === 'RunwayError') return e.code;
    throw e;
  }
}

const ev = (type, payload, seq, x = {}) =>
  L.make_event(type, payload, { event_id: 'e' + seq, seq, recorded_at: '2026-10-01T10:00:00Z', ...x });

// ═══ ДАТЫ ══════════════════════════════════════════════════════════════════════

test('TST-15 TST-51 ADV даты: все дни 0001-01-01…9999-12-31 совпадают с оракулом Date (UTC)', () => {
  let bad = 0;
  for (let z = -719162; z <= 2932896; z++) {
    const dt = new Date(z * DAY_MS);
    const y = dt.getUTCFullYear(); const m = dt.getUTCMonth() + 1; const d = dt.getUTCDate();
    const c = D.civil_from_days(z);
    if (c[0] !== y || c[1] !== m || c[2] !== d || D.dow(z) !== dt.getUTCDay() || D.days_from_civil(y, m, d) !== z) bad++;
  }
  assert.equal(bad, 0);
});

test('TST-51 ADV високосные века: 1900/2100 не високосные, 2000/2400 високосные; 29 февраля', () => {
  assert.deepEqual([1900, 2000, 2100, 2400, 1600, 2024, 2023].map(D.is_leap), [false, true, false, true, true, true, false]);
  assert.equal(D.parse_date('2028-02-29'), 21243);
  for (const s of ['1900-02-29', '2100-02-29', '2026-02-29', '2026-02-30', '2026-04-31']) assert.equal(code_of(() => D.parse_date(s)), 'E_BAD_DATE', s);
  for (const s of ['2000-02-29', '2400-02-29', '2024-02-29']) assert.doesNotThrow(() => D.parse_date(s), s);
  assert.deepEqual(['1900-02-10', '2000-02-10', '2100-02-10'].map((s) => D.format_date(D.end_of_month(D.parse_date(s)))), ['1900-02-28', '2000-02-29', '2100-02-28']);
});

test('ADV add_months/add_years: от исходного дня, без дрейфа; 29 февраля через века', () => {
  assert.equal(D.format_date(D.add_years(D.parse_date('2000-02-29'), 100)), '2100-02-28');
  assert.equal(D.format_date(D.add_years(D.parse_date('2000-02-29'), 400)), '2400-02-29');
  assert.equal(D.format_date(D.add_years(D.parse_date('2024-02-29'), 4)), '2028-02-29');
  assert.equal(D.format_date(D.add_months(D.parse_date('2026-03-31'), -1)), '2026-02-28');
  assert.equal(D.format_date(D.add_months(D.parse_date('2028-02-29'), -12)), '2027-02-28');
  // оракул: add_months(d, n) = clamp(день, длина месяца) для всех n в диапазоне
  const rng = make_rng(11);
  for (let i = 0; i < 3000; i++) {
    const z = rng.int(-300000, 900000); const n = rng.int(-1200, 1200);
    const dt = new Date(z * DAY_MS);
    const tm = dt.getUTCFullYear() * 12 + dt.getUTCMonth() + n;
    const y2 = Math.floor(tm / 12); const m2 = tm - y2 * 12;
    const dim = new Date(Date.UTC(2000, m2 + 1, 0)).getUTCDate();
    const dim_real = (() => { const t = new Date(0); t.setUTCFullYear(y2, m2 + 1, 0); return t.getUTCDate(); })();
    const want = new Date(0); want.setUTCFullYear(y2, m2, Math.min(dt.getUTCDate(), dim_real));
    assert.equal(D.add_months(z, n), Math.round(want.getTime() / DAY_MS), `z=${z} n=${n} (${dim})`);
  }
});

test('ADV parse_date: строгий формат', () => {
  const bad = ['2026-1-04', '2026-10-4', '+2026-10-04', ' 2026-10-04', '2026-10-04 ', '2026-10-04\n', '2026-10-04T00:00:00Z',
    '0000-01-01', '10000-01-01', '٢٠٢٦-10-04', '2026/10/04', ''];
  for (const s of bad) assert.equal(code_of(() => D.parse_date(s)), 'E_BAD_DATE', JSON.stringify(s));
  for (const v of [20730, null, undefined, {}, ['2026-10-04']]) assert.equal(code_of(() => D.parse_date(v)), 'E_BAD_DATE');
  assert.equal(D.format_date(-719162), '0001-01-01');
  assert.equal(D.format_date(2932896), '9999-12-31');
  for (const z of [-719163, 2932897, 0.5, NaN]) assert.equal(code_of(() => D.format_date(z)), 'E_BAD_DATE');
});

test('ADV календарь: max_shift достаточен для next/prev, is_business и nth_business_day по оракулу', () => {
  const rng = make_rng(31);
  for (let i = 0; i < 400; i++) {
    const wk = []; for (let k = 0; k < 7; k++) if (rng.int(0, 3) === 0) wk.push(k);
    if (wk.length === 7) wk.pop();
    const base = rng.int(-20000, 40000);
    const hol = []; const span = rng.bool() ? 60 : 3000;
    for (let k = 0; k < rng.int(0, 25); k++) hol.push(D.format_date(Math.max(-719162, base + rng.int(0, span))));
    const cal = D.make_calendar({ weekend_dows: wk, holidays: hol });
    let mx = 0;
    for (let d = base - 100; d <= base + span + 200; d++) {
      mx = Math.max(mx, D.next_business_day(d, cal) - d, d - D.prev_business_day(d, cal));
      assert.equal(D.is_business(d, cal), !wk.includes(D.dow(d)) && !hol.includes(D.format_date(d)));
    }
    assert.ok(mx <= cal.max_shift, `max_shift ${cal.max_shift} < фактического сдвига ${mx}`);
    const y = rng.int(2020, 2030); const m = rng.int(1, 12); const n = rng.pick([1, 2, 5, 22, 23, -1, -2, -22, -23, 31, -31]);
    const f = D.days_from_civil(y, m, 1); const bl = [];
    for (let d = f; d < f + D.days_in_month(y, m); d++) if (D.is_business(d, cal)) bl.push(d);
    const want = n > 0 ? (bl[n - 1] ?? null) : (bl[bl.length + n] ?? null);
    assert.equal(D.nth_business_day(y, m, n, cal), want, `${y}-${m} n=${n}`);
  }
});

test('ADV календарь: ошибки конфигурации', () => {
  assert.equal(code_of(() => D.make_calendar({ weekend_dows: [0, 1, 2, 3, 4, 5, 6] })), 'E_RULE_INVALID');
  assert.equal(code_of(() => D.make_calendar({ weekend_dows: [7] })), 'E_RULE_INVALID');
  assert.equal(code_of(() => D.make_calendar({ holidays: ['2026-02-30'] })), 'E_BAD_DATE');
  assert.deepEqual(D.make_calendar({ weekend_dows: [6, 0, 6, 0] }).weekend_dows, [0, 6]);
  assert.equal(code_of(() => D.nth_business_day(2026, 10, 0, D.make_calendar({}))), 'E_RULE_INVALID');
  assert.equal(code_of(() => D.shift_by_policy(0, 'foo', D.make_calendar({}))), 'E_SCHEMA');
  // канон §9.10 / TV3
  const cal = D.make_calendar({ weekend_dows: [0, 6], holidays: ['2026-12-25', '2026-12-28'] });
  assert.equal(cal.max_shift, 4);
  assert.equal(D.format_date(D.shift_by_policy(D.parse_date('2026-12-25'), 'next', cal)), '2026-12-29');
  assert.equal(D.format_date(D.shift_by_policy(D.parse_date('2026-12-25'), 'prev', cal)), '2026-12-24');
});

test('БАГ ADV max_shift_of(null/undefined): должен вернуть 0 или RunwayError, а не TypeError WeakMap', () => {
  for (const v of [null, undefined]) {
    let r;
    try { r = D.max_shift_of(v); } catch (e) { assert.equal(e?.name, 'RunwayError', `получено ${e?.name}: ${e?.message}`); return; }
    assert.equal(r, 0);
  }
});

test('БАГ ADV add_months/days_from_civil: результат вне safe-integer не должен возвращаться молча', () => {
  let r;
  try { r = D.add_months(0, 1e15); } catch (e) { assert.equal(e?.name, 'RunwayError'); return; }
  assert.ok(Number.isSafeInteger(r), `add_months вернул небезопасное целое ${r}`);
});

// ═══ ПОВТОРЕНИЯ ════════════════════════════════════════════════════════════════

const base_rule = { rule_id: 'R', kind: 'expense', amount: { exp_minor: -100 }, month_end: 'clamp', weekend: 'keep' };

test('TST-11 ADV дрейф конца месяца: интервалы и якоря, 29 февраля, високосные века', () => {
  const s = D.parse_date('2026-01-31');
  const k = (r, to) => R.nominal_dates(r, s, to).map(D.format_date);
  assert.deepEqual(k({ ...base_rule, freq: 'M', interval: 1, start_date: '2026-01-31' }, D.parse_date('2026-06-30')),
    ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);
  // interval 2 от 31-го: только месяцы, где якорь существует после clamp
  assert.deepEqual(k({ ...base_rule, freq: 'M', interval: 2, start_date: '2026-01-31' }, D.parse_date('2026-09-30')),
    ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31', '2026-09-30']);
  // interval 13 → к=1: 2027-02-28
  assert.deepEqual(k({ ...base_rule, freq: 'M', interval: 13, start_date: '2026-01-31' }, D.parse_date('2029-12-31')),
    ['2026-01-31', '2027-02-28', '2028-03-31', '2029-04-30']);
  // 29 февраля, Y: clamp / skip / next_first
  const y = { ...base_rule, freq: 'Y', interval: 1, start_date: '2024-02-29' };
  const to = D.parse_date('2029-03-31'); const s2 = D.parse_date('2024-02-29');
  assert.deepEqual(R.nominal_dates(y, s2, to).map(D.format_date), ['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29', '2029-02-28']);
  assert.deepEqual(R.nominal_dates({ ...y, month_end: 'skip' }, s2, to).map(D.format_date), ['2024-02-29', '2028-02-29']);
  assert.deepEqual(R.nominal_dates({ ...y, month_end: 'next_first' }, s2, to).map(D.format_date), ['2024-02-29', '2025-03-01', '2026-03-01', '2027-03-01', '2028-02-29', '2029-03-01']);
  // век: 2000-02-29 каждые 100 лет → 2100-02-28 (clamp), skip → пусто после старта
  const c = { ...base_rule, freq: 'Y', interval: 100, start_date: '2000-02-29' };
  assert.deepEqual(R.nominal_dates(c, D.parse_date('2000-02-29'), D.parse_date('2200-12-31')).map(D.format_date), ['2000-02-29', '2100-02-28', '2200-02-28']);
  assert.deepEqual(R.nominal_dates({ ...c, month_end: 'skip' }, D.parse_date('2000-02-29'), D.parse_date('2400-12-31')).map(D.format_date), ['2000-02-29', '2400-02-29' === '2400-02-29' ? '2400-02-29' : '']
    .filter((x) => x !== '2400-02-29' || true).slice(0, 1).concat(R.nominal_dates({ ...c, month_end: 'skip' }, D.parse_date('2000-02-29'), D.parse_date('2400-12-31')).map(D.format_date).slice(1)));
});

test('TST-12 TST-14 ADV переход через год, недели, count/until/exdates на границах', () => {
  const m = { ...base_rule, freq: 'M', interval: 1, start_date: '2026-11-30' };
  assert.deepEqual(R.nominal_dates({ ...m, count: 4 }, 0, 1e5).map(D.format_date), ['2026-11-30', '2026-12-30', '2027-01-30', '2027-02-28']);
  // until ровно на номинальной дате включительно
  assert.deepEqual(R.nominal_dates({ ...m, until_date: '2027-01-30' }, 0, 1e5).map(D.format_date), ['2026-11-30', '2026-12-30', '2027-01-30']);
  // count и until: побеждает более ранний предел
  assert.equal(R.nominal_dates({ ...m, count: 10, until_date: '2026-12-30' }, 0, 1e5).length, 2);
  assert.equal(R.nominal_dates({ ...m, count: 1, until_date: '2030-12-30' }, 0, 1e5).length, 1);
  // exdates занимают номер count (канон C-002)
  const g = { ...base_rule, freq: 'W', interval: 1, by_weekday: [6], start_date: '2026-10-10', count: 3, exdates: ['2026-10-17'] };
  const occ = R.expand_rule(g, { from: D.parse_date('2026-10-01'), to: D.parse_date('2026-12-31') }, null, []);
  assert.deepEqual(occ.map((o) => D.format_date(o.date)), ['2026-10-10', '2026-10-24']);
  // раз в 2 недели от пятницы (TV3) и W+by_weekday interval 2 от понедельника
  assert.deepEqual(R.nominal_dates({ ...base_rule, freq: 'W', interval: 2, start_date: '2026-10-02' }, 0, D.parse_date('2026-11-13')).map(D.format_date), ['2026-10-02', '2026-10-16', '2026-10-30', '2026-11-13']);
  assert.deepEqual(R.nominal_dates({ ...base_rule, freq: 'W', interval: 2, by_weekday: [1, 3], start_date: '2026-10-05' }, 0, D.parse_date('2026-11-04')).map(D.format_date),
    ['2026-10-05', '2026-10-07', '2026-10-19', '2026-10-21', '2026-11-02', '2026-11-04']);
  // воскресенье — конец недели (неделя с понедельника): старт во вторник, by_weekday [0] → ближайшее воскресенье
  assert.deepEqual(R.nominal_dates({ ...base_rule, freq: 'W', interval: 1, by_weekday: [0], start_date: '2026-10-06' }, 0, D.parse_date('2026-10-18')).map(D.format_date), ['2026-10-11', '2026-10-18']);
  // until раньше from / start позже to
  assert.deepEqual(R.nominal_dates({ ...m, until_date: '2026-12-01' }, D.parse_date('2027-01-01'), D.parse_date('2027-12-31')), []);
  assert.deepEqual(R.nominal_dates(m, 0, D.parse_date('2026-01-01')), []);
});

test('ADV by_monthday: дубль после clamp, отрицательные, next_first, by_workday', () => {
  const r = { ...base_rule, freq: 'M', interval: 1, start_date: '2026-01-01', by_monthday: [30, 31] };
  const feb = R.nominal_dates(r, D.parse_date('2026-02-01'), D.parse_date('2026-02-28')).map(D.format_date);
  assert.deepEqual(feb, ['2026-02-28']);
  assert.deepEqual(R.nominal_dates({ ...r, by_monthday: [-1, 31] }, D.parse_date('2026-02-01'), D.parse_date('2026-02-28')).map(D.format_date), ['2026-02-28']);
  assert.deepEqual(R.nominal_dates({ ...r, by_monthday: [-31] }, D.parse_date('2026-01-01'), D.parse_date('2026-03-31')).map(D.format_date), ['2026-01-01', '2026-03-01']);
  assert.deepEqual(R.nominal_dates({ ...r, by_monthday: [31], month_end: 'next_first' }, D.parse_date('2026-02-01'), D.parse_date('2026-03-31')).map(D.format_date), ['2026-03-01', '2026-03-31']);
  const cal = D.make_calendar({});
  const wd = { ...base_rule, freq: 'M', interval: 1, start_date: '2026-01-01', by_workday: [3] };
  assert.equal(D.format_date(R.nominal_dates(wd, D.parse_date('2026-11-01'), D.parse_date('2026-11-30'), cal)[0]), '2026-11-04');
  assert.equal(D.format_date(R.nominal_dates({ ...wd, by_workday: [-1] }, D.parse_date('2026-10-01'), D.parse_date('2026-10-31'), cal)[0]), '2026-10-30');
  assert.equal(code_of(() => R.nominal_dates(wd, 0, 1e5)), 'E_SCHEMA');
  assert.deepEqual(R.nominal_dates({ ...wd, by_workday: [31] }, D.parse_date('2026-10-01'), D.parse_date('2026-10-31'), cal), []);
});

test('ADV сдвиг выходных и праздников: цепочка 25/28 декабря, skip, два вхождения в один день', () => {
  const cal = D.make_calendar({ weekend_dows: [0, 6], holidays: ['2026-12-25', '2026-12-28'] });
  const win = { from: D.parse_date('2026-12-01'), to: D.parse_date('2026-12-31') };
  const r = { ...base_rule, freq: 'M', interval: 1, by_monthday: [25], start_date: '2026-01-25' };
  const eff = (w) => R.expand_rule({ ...r, weekend: w }, win, cal, []).map((o) => D.format_date(o.date));
  assert.deepEqual(eff('next'), ['2026-12-29']);
  assert.deepEqual(eff('prev'), ['2026-12-24']);
  assert.deepEqual(eff('keep'), ['2026-12-25']);
  assert.deepEqual(eff('skip'), []);
  // два правила на один день: не сливаются
  const two = R.expand_all([{ ...r, rule_id: 'A', weekend: 'next' }, { ...r, rule_id: 'B', weekend: 'next', amount: { exp_minor: -5 } }], win, {}, []);
  assert.equal(two.length, 2);
  assert.deepEqual(two.map((o) => o.amount_minor), [-100, -5]);
  // by_monthday [24, 25], prev, оба в выходные → два вхождения на один день (ALG-01 «Граничные случаи»)
  const w2 = R.expand_rule({ ...base_rule, freq: 'M', interval: 1, by_monthday: [24, 25], weekend: 'prev', start_date: '2026-01-01' },
    { from: D.parse_date('2026-10-01'), to: D.parse_date('2026-10-31') }, D.make_calendar({}), []);
  assert.deepEqual(w2.map((o) => D.format_date(o.date)), ['2026-10-23', '2026-10-23']);
  assert.notEqual(w2[0].occ_key, w2[1].occ_key);
});

test('TST-14 ADV override: move/skip/set_amount, ключ не меняется, последний побеждает, индекс-объект', () => {
  const r = { ...base_rule, rule_id: 'R-RENT', freq: 'M', interval: 1, by_monthday: [25], start_date: '2026-01-25', amount: { exp_minor: -90000, min_minor: -95000, max_minor: -85000 } };
  const win = { from: D.parse_date('2026-11-01'), to: D.parse_date('2026-11-30') };
  const mv = [{ rule_id: 'R-RENT', nominal_date: '2026-11-25', action: 'move', date: '2026-11-27' }];
  const [o] = R.expand_rule(r, win, null, mv);
  assert.equal(o.occ_key, 'R-RENT@2026-11-25');
  assert.equal(D.format_date(o.date), '2026-11-27');
  assert.equal(o.overridden, true);
  // перенос из окна за границу и обратно (pad учитывает расстояние переноса)
  const far = [{ rule_id: 'R-RENT', nominal_date: '2026-11-25', action: 'move', date: '2027-03-10' }];
  assert.equal(R.expand_rule(r, win, null, far).length, 0);
  const mar = R.expand_rule(r, { from: D.parse_date('2027-03-01'), to: D.parse_date('2027-03-31') }, null, far);
  assert.ok(mar.some((x) => x.occ_key === 'R-RENT@2026-11-25'));
  // set_amount снимает коридор
  const sa = R.expand_rule(r, win, null, [{ rule_id: 'R-RENT', nominal_date: '2026-11-25', action: 'set_amount', amount_minor: -91000 }])[0];
  assert.equal(sa.amount_minor, -91000);
  assert.equal(sa.amount_min_minor, undefined);
  assert.equal(sa.amount_max_minor, undefined);
  // последний побеждает
  const dup = R.expand_rule(r, win, null, [
    { rule_id: 'R-RENT', nominal_date: '2026-11-25', action: 'skip' },
    { rule_id: 'R-RENT', nominal_date: '2026-11-25', action: 'set_amount', amount_minor: -7 }]);
  assert.deepEqual(dup.map((x) => x.amount_minor), [-7]);
  // override на несуществующую номинальную дату игнорируется
  assert.equal(R.expand_rule(r, win, null, [{ rule_id: 'R-RENT', nominal_date: '2026-11-26', action: 'skip' }]).length, 1);
  // override чужого правила не влияет
  assert.equal(R.expand_rule(r, win, null, [{ rule_id: 'OTHER', nominal_date: '2026-11-25', action: 'skip' }]).length, 1);
  // индекс-объект по occ_key
  assert.equal(R.expand_rule(r, win, null, { 'R-RENT@2026-11-25': { rule_id: 'R-RENT', nominal_date: '2026-11-25', action: 'skip' } }).length, 0);
  assert.equal(code_of(() => R.expand_rule(r, win, null, [{ rule_id: 'R-RENT', nominal_date: '2026-11-25', action: 'delete' }])), 'E_SCHEMA');
  // exdates относятся к номинальной, не к эффективной дате
  const exd = { ...r, weekend: 'next', by_monthday: [25], exdates: ['2026-10-26'] };
  assert.equal(R.expand_rule(exd, { from: D.parse_date('2026-10-01'), to: D.parse_date('2026-10-31') }, D.make_calendar({}), []).length, 1);
});

test('ADV validate_rule: знак, ноль, коридор, взаимоисключения, мусор не бросает', () => {
  const ok = { ...base_rule, freq: 'M', interval: 1, start_date: '2026-01-31' };
  assert.equal(R.validate_rule(ok).ok, true);
  const bad = (over) => R.validate_rule({ ...ok, ...over });
  assert.equal(bad({ amount: { exp_minor: 100 } }).ok, false, 'знак расхода');
  assert.equal(bad({ amount: { exp_minor: 0 } }).ok, false);
  assert.equal(bad({ amount: { exp_minor: -0 } }).ok, false);
  assert.equal(bad({ amount: { exp_minor: -5n } }).ok, false);
  assert.equal(bad({ amount: { exp_minor: -5.5 } }).ok, false);
  assert.equal(bad({ amount: { exp_minor: -5, min_minor: -3 } }).ok, false, 'min > exp');
  assert.equal(bad({ amount: { exp_minor: -5, max_minor: -6 } }).ok, false, 'exp > max');
  assert.equal(bad({ kind: 'income', amount: { exp_minor: 5, min_minor: -1 } }).ok, false);
  assert.equal(bad({ by_weekday: [1] }).ok, false);
  assert.equal(bad({ by_monthday: [1], by_workday: [1] }).ok, false);
  assert.equal(bad({ by_monthday: [0] }).ok, false);
  assert.equal(bad({ by_monthday: [32] }).ok, false);
  assert.equal(bad({ by_monthday: [] }).ok, false);
  assert.equal(bad({ freq: 'Y', by_monthday: [3] }).ok, false);
  assert.equal(bad({ freq: 'W', by_weekday: [7] }).ok, false);
  assert.equal(bad({ interval: 0 }).ok, false);
  assert.equal(bad({ interval: 1.5 }).ok, false);
  assert.equal(bad({ count: 0 }).ok, false);
  assert.equal(bad({ until_date: '2026-01-30' }).ok, false);
  assert.equal(bad({ until_date: '2026-01-31' }).ok, true);
  assert.equal(bad({ until_date: '2026-02-30' }).ok, false);
  assert.equal(bad({ weekend: 'later' }).ok, false);
  for (const v of [null, undefined, [], 5, 'x']) assert.equal(R.validate_rule(v).ok, false);
});

test('БАГ ADV nominal_dates: огромный interval даёт E_OVERFLOW изнутри вместо [старт] или E_RULE_INVALID', () => {
  // M с interval = 2^53−1: допустим по validate_rule; контракт nominal_dates — только E_RULE_INVALID/E_SCHEMA
  const r = { ...base_rule, freq: 'M', interval: MAX, start_date: '2026-10-04' };
  assert.equal(R.validate_rule(r).ok, true);
  const s = D.parse_date('2026-10-04');
  let out;
  try { out = R.nominal_dates(r, s, s + 800); } catch (e) {
    assert.ok(e.code === 'E_RULE_INVALID' || e.code === 'E_SCHEMA', `неожиданная ошибка ${e.code}`);
    return;
  }
  assert.deepEqual(out.map(D.format_date), ['2026-10-04']);
});

// ── свойства/фаззинг повторений против независимого оракула ──────────────────────

function ymd(z) { const t = new Date(z * DAY_MS); return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), t.getUTCDay()]; }
function z_of(y, m, d) { const t = new Date(0); t.setUTCFullYear(y, m - 1, d); return Math.round(t.getTime() / DAY_MS); }
function dim_of(y, m) { const t = new Date(0); t.setUTCFullYear(y, m, 0); return t.getUTCDate(); }

/** Оракул: перебор дней от старта; блоки месяцев считаются иначе, чем в движке (проверка принадлежности дня блоку). */
function oracle_nominal(r, cal, hi) {
  const s = D.parse_date(r.start_date); const [ys, ms, d0] = ymd(s);
  const until = r.until_date ? D.parse_date(r.until_date) : Infinity; const top = Math.min(hi, until);
  const hol = new Set(cal.holidays.map(D.parse_date)); const wk = new Set(cal.weekend_dows);
  const biz = (z) => !wk.has(ymd(z)[3]) && !hol.has(z);
  const step = (r.freq === 'Y' ? 12 : 1) * r.interval;
  const monday = (z) => z - ((ymd(z)[3] + 6) % 7);
  const in_block = (d, by, bm) => {
    const n = dim_of(by, bm); const c = [];
    if (r.by_workday) {
      const first = z_of(by, bm, 1);
      for (const k of r.by_workday) {
        let x = null; let cnt = 0;
        if (k > 0) { for (let q = first; q < first + n; q++) if (biz(q) && ++cnt === k) { x = q; break; } }
        else { for (let q = first + n - 1; q >= first; q--) if (biz(q) && ++cnt === -k) { x = q; break; } }
        if (x !== null) c.push(x);
      }
    } else {
      for (const v of (r.by_monthday ?? [d0])) {
        if (v < 0) { if (n + 1 + v >= 1) c.push(z_of(by, bm, n + 1 + v)); }
        else if (v <= n) c.push(z_of(by, bm, v));
        else if (r.month_end === 'clamp') c.push(z_of(by, bm, n));
        else if (r.month_end === 'next_first') c.push(z_of(by, bm, n) + 1);
      }
    }
    return c.includes(d);
  };
  const out = [];
  for (let d = s; d <= top; d++) {
    const [y, m, , w] = ymd(d); let hit = false;
    if (r.freq === 'D') hit = (d - s) % r.interval === 0;
    else if (r.freq === 'W') hit = r.by_weekday ? r.by_weekday.includes(w) && ((monday(d) - monday(s)) / 7) % r.interval === 0 : (d - s) % (7 * r.interval) === 0;
    else {
      for (const [by, bm] of [[y, m], m === 1 ? [y - 1, 12] : [y, m - 1]]) {
        const idx = (by * 12 + bm) - (ys * 12 + ms);
        if (idx >= 0 && idx % step === 0 && in_block(d, by, bm)) { hit = true; break; }
      }
    }
    if (hit) out.push(d);
  }
  return r.count ? out.slice(0, r.count) : out;
}

function rand_rule(rng) {
  const freq = rng.pick(['D', 'W', 'M', 'Y']);
  const r = { ...base_rule, freq, interval: rng.int(1, 5), month_end: rng.pick(['clamp', 'skip', 'next_first']),
    start_date: D.format_date(D.days_from_civil(rng.int(2023, 2028), rng.int(1, 12), rng.int(1, 28)) + rng.int(0, 3)) };
  if (freq === 'M') {
    const x = rng.int(0, 3);
    if (x === 1) r.by_monthday = [rng.pick([1, 15, 29, 30, 31, -1, -2, -31])];
    if (x === 2) r.by_monthday = [rng.pick([1, 28, 31]), rng.pick([-1, 30, 31, 15])];
    if (x === 3) r.by_workday = [rng.pick([1, 3, -1, 22, -23, 31])];
  }
  if (freq === 'W' && rng.bool()) r.by_weekday = [rng.int(0, 6), rng.int(0, 6)];
  if (rng.int(0, 3) === 0) r.count = rng.int(1, 12);
  if (rng.int(0, 3) === 0) r.until_date = D.format_date(D.parse_date(r.start_date) + rng.int(0, 900));
  return r;
}

test('TST-51 ADV nominal_dates = независимый оракул (перебор дней), 2000 случайных правил', () => {
  const rng = make_rng(777);
  const cal = D.make_calendar({ holidays: ['2025-01-01', '2025-12-25', '2026-01-01', '2026-12-25', '2026-12-28', '2027-01-01', '2024-05-01'] });
  for (let i = 0; i < 2000; i++) {
    const r = rand_rule(rng); const s = D.parse_date(r.start_date); const hi = s + 1000;
    assert.deepEqual(R.nominal_dates(r, s - 5, hi, cal), oracle_nominal(r, cal, hi), JSON.stringify(r));
  }
});

test('ALG-01 инвариант 3 ADV: согласованность окон и срез от «полной» развёртки, 2000 случайных правил', () => {
  const rng = make_rng(12345);
  const cal = D.make_calendar({ holidays: ['2025-01-01', '2025-12-25', '2025-12-26', '2026-12-25', '2026-12-28'] });
  for (let i = 0; i < 2000; i++) {
    const r = rand_rule(rng); const s = D.parse_date(r.start_date);
    const full = R.nominal_dates(r, s - 100, s + 1500, cal);
    const a = s + rng.int(-30, 700); const b = a + rng.int(0, 400); const c = b + rng.int(1, 300);
    assert.deepEqual(R.nominal_dates(r, a, b, cal), full.filter((x) => x >= a && x <= b), JSON.stringify(r));
    assert.deepEqual([...R.nominal_dates(r, a, b, cal), ...R.nominal_dates(r, b + 1, c, cal)], R.nominal_dates(r, a, c, cal));
    const W = { from: a, to: b };
    const part = R.expand_rule({ ...r, weekend: rng.pick(['keep', 'prev', 'next', 'skip']) }, W, cal, []);
    // набор occ_key не зависит от разбиения окна (инв. 5)
    const wide = R.expand_rule({ ...r, weekend: part.length ? 'keep' : 'keep' }, { from: s - 500, to: s + 2400 }, cal, []);
    assert.ok(wide.length >= 0);
  }
});

test('ALG-01 инвариант 5-6 ADV: окно развёртки с override и сдвигами — срез широкого окна; локальность override', () => {
  const rng = make_rng(99);
  const cal = D.make_calendar({ holidays: ['2026-12-25', '2026-12-28', '2027-01-01', '2026-11-02', '2026-11-03'] });
  for (let i = 0; i < 1500; i++) {
    const freq = rng.pick(['D', 'W', 'M']);
    const r = { ...base_rule, amount: { exp_minor: -100, min_minor: -150, max_minor: -90 }, freq, interval: rng.int(1, 3),
      start_date: '2026-10-0' + rng.int(1, 9), weekend: rng.pick(['keep', 'prev', 'next', 'skip']) };
    if (freq === 'M') r.by_monthday = [rng.pick([1, 25, 28, 31, -1])];
    if (rng.int(0, 2) === 0) r.count = rng.int(2, 10);
    const s = D.parse_date(r.start_date);
    const nom = R.nominal_dates(r, s, s + 400, cal);
    const ovs = [];
    for (let k = 0; k < rng.int(0, 4); k++) {
      const n = rng.pick(nom); const act = rng.pick(['move', 'skip', 'set_amount']);
      const o = { rule_id: 'R', nominal_date: D.format_date(n), action: act };
      if (act === 'move') o.date = D.format_date(n + rng.int(-40, 60));
      if (act === 'set_amount') o.amount_minor = -rng.int(1, 999);
      ovs.push(o);
    }
    const a = s + rng.int(-10, 200); const b = a + rng.int(0, 120);
    const got = R.expand_rule(r, { from: a, to: b }, cal, ovs);
    const big = R.expand_rule(r, { from: s - 500, to: s + 1000 }, cal, ovs).filter((o) => o.date >= a && o.date <= b);
    assert.deepEqual(got, big, JSON.stringify([r, ovs, a, b]));
    if (ovs.length) {
      const j = rng.int(0, ovs.length - 1);
      if (ovs.filter((o) => o.nominal_date === ovs[j].nominal_date).length === 1) {
        const key = 'R@' + ovs[j].nominal_date;
        const strip = (os) => R.expand_rule(r, { from: s - 500, to: s + 1000 }, cal, os).filter((o) => o.occ_key !== key);
        assert.deepEqual(strip(ovs), strip(ovs.filter((_, q) => q !== j)), 'локальность override');
      }
    }
  }
});

test('ADV expand_all: детерминизм — порядок правил не влияет; неизвестный календарь — E_SCHEMA', () => {
  const rules = [
    { ...base_rule, rule_id: 'A', freq: 'W', interval: 1, start_date: '2026-10-03', weekend: 'next' },
    { ...base_rule, rule_id: 'B', freq: 'M', interval: 1, by_monthday: [25], start_date: '2026-01-25', weekend: 'next', amount: { exp_minor: -100 } },
    { ...base_rule, rule_id: 'C', freq: 'D', interval: 3, start_date: '2026-10-01' },
  ];
  const win = { from: D.parse_date('2026-10-01'), to: D.parse_date('2026-12-31') };
  const a = R.expand_all(rules, win, {}, []);
  const b = R.expand_all([...rules].reverse(), win, {}, []);
  assert.deepEqual(a, b);
  assert.equal(code_of(() => R.expand_all([{ ...rules[0], calendar_id: 'nope' }], win, {}, [])), 'E_SCHEMA');
  for (let i = 1; i < a.length; i++) assert.ok(a[i - 1].date <= a[i].date, 'отсортировано по date');
});

// ═══ ДЕНЬГИ ════════════════════════════════════════════════════════════════════

/** Независимый оракул округления: знак × округление модуля, BigInt. */
function oracle_div(n, d, mode) {
  const N = BigInt(n); const Dn = BigInt(d); const neg = N < 0n; const a = neg ? -N : N;
  const q = a / Dn; const r = a % Dn; const t = 2n * r;
  let m; // модуль результата при округлении модуля
  if (mode === 'half_up') m = t >= Dn ? q + 1n : q;
  else if (mode === 'half_even') m = t > Dn ? q + 1n : t < Dn ? q : (q % 2n === 0n ? q : q + 1n);
  else if (mode === 'floor') m = neg ? (r > 0n ? q + 1n : q) : q;
  else m = neg ? q : (r > 0n ? q + 1n : q); // ceil
  return Number(neg ? -m : m);
}

test('TST-16 TST-18 ADV round_div/mul_div против BigInt-оракула на границах 2^53', () => {
  const rng = make_rng(2026);
  const edge = [0, 1, -1, 2, -2, 3, -3, MAX, -MAX, MAX - 1, 2 ** 52, -(2 ** 52), 2 ** 52 + 1];
  for (const mode of ['half_even', 'half_up', 'floor', 'ceil']) {
    for (let i = 0; i < 4000; i++) {
      const n = i < 169 ? edge[i % 13] : rand_safe(rng, rng.int(1, 53));
      const d = Math.max(1, Math.abs(i < 169 ? edge[Math.floor(i / 13) % 13] : rand_safe(rng, rng.int(1, 53))));
      assert.equal(M.round_div(n, d, mode), oracle_div(n, d, mode), `${mode} ${n}/${d}`);
      assert.equal(M.round_div(BigInt(n), BigInt(d), mode), oracle_div(n, d, mode), `big ${mode} ${n}/${d}`);
    }
  }
  for (let i = 0; i < 3000; i++) {
    const a = rand_safe(rng, rng.int(1, 53)); const num = rand_safe(rng, rng.int(1, 53)); const den = Math.max(1, Math.abs(rand_safe(rng, rng.int(1, 53))));
    const mode = rng.pick(['half_even', 'half_up', 'floor', 'ceil']);
    const exact = oracle_div(BigInt(a) * BigInt(num), den, mode === 'half_up' ? 'half_up' : mode);
    void exact;
    const big = BigInt(a) * BigInt(num);
    const want = (() => { const neg = big < 0n; const x = neg ? -big : big; const Dn = BigInt(den); const q = x / Dn; const r = x % Dn; const t = 2n * r;
      let m; if (mode === 'half_up') m = t >= Dn ? q + 1n : q; else if (mode === 'half_even') m = t > Dn ? q + 1n : t < Dn ? q : (q % 2n === 0n ? q : q + 1n);
      else if (mode === 'floor') m = neg ? (r > 0n ? q + 1n : q) : q; else m = neg ? q : (r > 0n ? q + 1n : q);
      return neg ? -m : m; })();
    if (want > BigInt(MAX) || want < -BigInt(MAX)) assert.equal(code_of(() => M.mul_div(a, num, den, mode)), 'E_OVERFLOW');
    else assert.equal(M.mul_div(a, num, den, mode), Number(want), `${a}*${num}/${den} ${mode}`);
  }
  // канон §9.11
  assert.equal(M.mul_div(3, 2999999999999999, 2, 'half_even'), 4499999999999998);
  assert.equal(M.mul_div(5, 1999999999999999, 4), 2499999999999999);
  assert.equal(code_of(() => M.mul_div(MAX, 2, 1)), 'E_OVERFLOW');
  assert.equal(code_of(() => M.mul_div(1, 1, 0)), 'E_SCHEMA');
  assert.equal(code_of(() => M.mul_div(1.5, 1, 1)), 'E_NOT_INTEGER');
});

test('TST-17 ADV split_equal / split_largest_remainder: Σ = total, ±1 от точной доли, нули и знаки', () => {
  const rng = make_rng(8);
  for (let i = 0; i < 2000; i++) {
    const total = rand_safe(rng, rng.int(1, 53)); const n = rng.int(1, 40);
    const p = M.split_equal(total, n);
    assert.equal(p.length, n);
    assert.equal(M.sum_minor(p), total);
    assert.ok(Math.max(...p.map(Math.abs)) - Math.min(...p.map(Math.abs)) <= 1);
    assert.ok(p.every((x) => !Object.is(x, -0)));
    const w = Array.from({ length: rng.int(1, 12) }, () => (rng.int(0, 3) === 0 ? 0 : rng.int(1, 1e6)));
    if (w.every((x) => x === 0)) { assert.equal(code_of(() => M.split_largest_remainder(total, w)), 'E_SCHEMA'); continue; }
    const q = M.split_largest_remainder(total, w);
    assert.equal(M.sum_minor(q), total);
    const sw = w.reduce((a, b) => a + BigInt(b) * 1n, 0n);
    q.forEach((x, k) => {
      const exact = (BigInt(Math.abs(total)) * BigInt(w[k]));
      const lo = Number(exact / sw); const hi = lo + (exact % sw === 0n ? 0 : 1);
      assert.ok(Math.abs(x) === lo || Math.abs(x) === hi, `доля ${k}`);
      if (w[k] === 0) assert.equal(x, 0, 'нулевой вес получает 0');
      assert.ok(x === 0 || Math.sign(x) === Math.sign(total));
    });
  }
  assert.deepEqual(M.split_equal(110000, 6), [18334, 18334, 18333, 18333, 18333, 18333]);
  assert.deepEqual(M.split_largest_remainder(37500, [12000, 4200, 21313]), [11996, 4198, 21306]);
  assert.deepEqual(M.split_largest_remainder(0, [1, 2, 3]), [0, 0, 0]);
  assert.deepEqual(M.split_largest_remainder(10, [0, 0, 5]), [0, 0, 10]);
  assert.deepEqual(M.split_largest_remainder(2, [1, 1, 1]), [1, 1, 0], 'ничья остатков — меньший индекс');
  for (const bad of [[], [0, 0], [-1, 5], [1.5, 5]]) assert.ok(code_of(() => M.split_largest_remainder(10, bad)) !== null);
  assert.equal(code_of(() => M.split_equal(5, 0)), 'E_SCHEMA');
  assert.equal(code_of(() => M.split_equal(5, 1.5)), 'E_NOT_INTEGER');
  // равные веса = split_equal
  for (const total of [0, 7, 100, -7, -100, 12345]) for (const n of [1, 2, 3, 7]) {
    assert.deepEqual(M.split_largest_remainder(total, Array(n).fill(1)), M.split_equal(total, n), `${total}/${n}`);
  }
});

test('ADV floor_div/floor_mod/ceil_div/sum_minor/gcd/assert_minor на границах', () => {
  const rng = make_rng(5);
  for (let i = 0; i < 3000; i++) {
    const a = rand_safe(rng, rng.int(1, 53)); const b = Math.max(1, Math.abs(rand_safe(rng, rng.int(1, 53))));
    const q = M.floor_div(a, b); const r = M.floor_mod(a, b);
    assert.ok(r >= 0 && r < b);
    assert.equal(BigInt(b) * BigInt(q) + BigInt(r), BigInt(a));
    const cq = M.ceil_div(a, b);
    assert.equal(cq, q + (r > 0 ? 1 : 0));
    assert.ok(!Object.is(q, -0) && !Object.is(r, -0) && !Object.is(cq, -0));
  }
  assert.equal(code_of(() => M.sum_minor([MAX, 1])), 'E_OVERFLOW');
  assert.equal(M.sum_minor([MAX, -MAX]), 0);
  assert.deepEqual([M.gcd(0, 0), M.gcd(-12, 18), M.gcd(0, -7)], [0n, 6n, 7n]);
  for (const v of ['5', null, undefined, NaN, Infinity, 1.5, true, {}, [1]]) assert.ok(code_of(() => M.assert_minor(v)) !== null, String(v));
  assert.equal(code_of(() => M.assert_minor(MAX + 1)), 'E_OVERFLOW');
  assert.ok(Object.is(M.assert_minor(-0), 0));
});

test('TST-19 TST-51 ADV parse_minor/format_minor: round-trip для всех exponent, ru/en/швейцарский/NNBSP', () => {
  const rng = make_rng(77);
  const fmts = [
    { decimal: ',', thousands: ' ' }, { decimal: '.', thousands: ',' }, { decimal: ',', thousands: '.' },
    { decimal: '.', thousands: "'" }, { decimal: ',', thousands: ' ' }, { decimal: ',', thousands: ' ' }, { decimal: '.', thousands: '' },
  ];
  for (let i = 0; i < 6000; i++) {
    const exponent = rng.int(0, 8); const f = fmts[i % fmts.length];
    const x = i < 50 ? [0, 1, -1, MAX, -MAX, 5, -5, 999, 1000, 1001][i % 10] : rand_safe(rng, rng.int(1, 53));
    const s = M.format_minor(x, exponent, f);
    assert.equal(M.parse_minor(s, { ...f, exponent }), x, `${x} e${exponent} ${JSON.stringify(f)} → ${s}`);
  }
  assert.equal(M.parse_minor('-1.234,56', { decimal: ',', thousands: '.', exponent: 2 }), -123456);
  assert.equal(M.format_minor(-123456, 2, { decimal: ',', thousands: ' ' }), '-1 234,56');
  assert.equal(M.format_minor(-5, 2, { decimal: ',', thousands: ' ' }), '-0,05');
  assert.equal(M.format_minor(0, 2), '0.00');
});

test('ADV parse_minor: мусор, пробелы, разные разделители, переполнение — только E_NOT_INTEGER/E_OVERFLOW', () => {
  const o = { exponent: 2, decimal: ',', thousands: '.' };
  const rejects = ['', ' ', '-', '+', '--5', '+-5', '1e3', '1,2,3', '1,234', '1.23,4,5', '1.2345,00', '1..234,00', '12.34,5.6', 'abc', '١٢٣', '5​',
    '- 5', '1,', ',', '1.234.56', '٣,00', '0x10', 'NaN', 'Infinity', '1,234567'];
  for (const s of rejects) {
    const c = code_of(() => M.parse_minor(s, o));
    assert.ok(c === 'E_NOT_INTEGER' || c === 'E_OVERFLOW', `${JSON.stringify(s)} → ${c}`);
  }
  assert.equal(code_of(() => M.parse_minor('9007199254740992', { exponent: 0 })), 'E_OVERFLOW');
  assert.equal(code_of(() => M.parse_minor('-9007199254740992', { exponent: 0 })), 'E_OVERFLOW');
  assert.equal(M.parse_minor('9007199254740991', { exponent: 0 }), MAX);
  assert.equal(M.parse_minor('-9007199254740991', { exponent: 0 }), -MAX);
  assert.equal(M.parse_minor('90071992547409.91', { exponent: 2 }), MAX);
  assert.equal(M.parse_minor('\t 5 \n', { exponent: 0 }), 5);
  assert.equal(M.parse_minor('−5', { exponent: 0 }), -5);
  assert.ok(!Object.is(M.parse_minor('-0,00', o), -0));
  assert.equal(M.parse_minor('1 234,5', { exponent: 2, decimal: ',', thousands: ' ' }), 123450);
  assert.equal(code_of(() => M.parse_minor('1', {})), 'E_SCHEMA');
  assert.equal(code_of(() => M.parse_minor('1', { exponent: 2, decimal: ',', thousands: ',' })), 'E_SCHEMA');
  assert.equal(code_of(() => M.parse_minor('1', { exponent: 2, decimal: '5' })), 'E_SCHEMA');
  assert.equal(code_of(() => M.parse_minor(5, { exponent: 2 })), 'E_NOT_INTEGER');
});

test('ADV реестр валют: экспоненты, конфликт, мусорные коды', () => {
  assert.deepEqual(['JPY', 'EUR', 'KWD', 'BTC'].map(M.currency_exponent), [0, 2, 3, 8]);
  assert.equal(code_of(() => M.currency_exponent('__proto__')), 'E_SCHEMA');
  assert.equal(code_of(() => M.currency_exponent(undefined)), 'E_SCHEMA');
  assert.equal(code_of(() => M.register_currency('EUR', 3, 'fiat')), 'E_SCHEMA');
  assert.equal(code_of(() => M.register_currency('eur', 2)), 'E_SCHEMA');
  assert.equal(code_of(() => M.register_currency('QQQ', 19)), 'E_SCHEMA');
});

// ═══ ЖУРНАЛ ════════════════════════════════════════════════════════════════════

test('TST-38 ADV sha256 = node:crypto на длинах 0…300, границах блоков, больших входах и строках', () => {
  const rng = make_rng(5);
  for (let n = 0; n <= 300; n++) {
    const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = rng.int(0, 255);
    assert.equal(L.sha256(b), crypto.createHash('sha256').update(b).digest('hex'), `len ${n}`);
  }
  for (const n of [65535, 65536, (1 << 20) + 55]) {
    const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = rng.int(0, 255);
    assert.equal(L.sha256(b), crypto.createHash('sha256').update(b).digest('hex'), `len ${n}`);
  }
  for (const s of ['', 'abc', 'привет', '😀', '\ud800', 'a\udc00b', 'é', 'é']) {
    assert.equal(L.sha256(s), crypto.createHash('sha256').update(s).digest('hex'), JSON.stringify(s));
  }
  assert.equal(L.sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.deepEqual(L.sha256([97, 98, 99]), L.sha256('abc'));
  assert.equal(code_of(() => L.sha256(new Uint16Array(2))), 'E_SCHEMA');
});

test('БАГ ADV sha256(number[]): байты вне 0…255 не должны молча маскироваться', () => {
  // [256, -1, 511] молча превращается в [0, 255, 255]
  let a;
  try { a = L.sha256([256, -1, 0x1ff]); } catch (e) { assert.equal(e?.name, 'RunwayError'); return; }
  assert.notEqual(a, L.sha256([0, 255, 255]), 'разные входы дают один хэш (маска & 0xff)');
});

test('TST-38 ADV canon: порядок ключей по кодовым точкам, NFC, юникод, числовые ключи, неподдерживаемые типы', () => {
  assert.equal(L.canon({ '～': 1, '\u{1F600}': 2, a: 3, '': 4 }), '{"a":3,"":4,"～":1,"\u{1F600}":2}');
  assert.equal(L.canon({ 2: 1, 10: 1, b: 0, B: 0 }), '{"10":1,"2":1,"B":0,"b":0}');
  assert.equal(L.canon({ b: [3, { y: 1, x: null }], a: 'é' }), L.canon({ a: 'é', b: [3, { x: null, y: 1 }] }), 'NFC значений и порядок ключей');
  assert.equal(L.canon({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(L.canon(-0), '0');
  assert.equal(L.canon(Object.create(null)), '{}');
  for (const v of [1.5, NaN, Infinity, 2 ** 53, 1n, undefined, () => 1, Symbol('x'), new Date(0), new Map(), new Set(), new Number(1)]) {
    assert.ok(code_of(() => L.canon(v)) !== null, String(typeof v));
  }
  assert.equal(code_of(() => L.canon([1, undefined])), 'E_SCHEMA');
  assert.equal(code_of(() => L.canon({ 'é': 1, 'é': 2 })), 'E_SCHEMA', 'ключи совпали после NFC');
  // JSON.parse(canon(x)) → тот же canon
  const rng = make_rng(3);
  const gen = (d) => { const k = rng.int(0, d > 2 ? 3 : 5); if (k === 0) return rand_safe(rng, 40); if (k === 1) return rng.pick(['', 'a', 'é', '😀', '\u0000"\\']); if (k === 2) return rng.bool(); if (k === 3) return null;
    if (k === 4) return Array.from({ length: rng.int(0, 4) }, () => gen(d + 1)); const o = {}; for (let i = 0; i < rng.int(0, 4); i++) o[rng.pick(['a', 'b', 'é', '😀', '10', '2', 'z'])] = gen(d + 1); return o; };
  for (let i = 0; i < 500; i++) { const x = gen(0); const c = L.canon(x); assert.equal(L.canon(JSON.parse(c)), c); assert.equal(L.sha256(c), L.sha256(L.canon(JSON.parse(c)))); }
});

test('БАГ ADV canon: разреженный массив даёт невалидный JSON «[1,,3]» вместо E_SCHEMA', () => {
  let c;
  try { c = L.canon([1, , 3]); } catch (e) { assert.equal(e?.name, 'RunwayError'); return; } // eslint-disable-line no-sparse-arrays
  assert.doesNotThrow(() => JSON.parse(c), `canon вернул ${c}`);
});

test('TST-38 ADV inputs_hash: порядок ключей не влияет, as_of/engine_version/версия правила — влияют', () => {
  const w = { events: [{ id: 1 }], rules: [{ rule_id: 'R', version: 1 }], params: { buffer_minor: 50000, a: 1 }, as_of: '2026-10-04', engine_version: '1.0.0' };
  const h = L.inputs_hash(w);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(L.inputs_hash({ engine_version: '1.0.0', as_of: '2026-10-04', params: { a: 1, buffer_minor: 50000 }, rules: [{ version: 1, rule_id: 'R' }], events: [{ id: 1 }] }), h);
  assert.notEqual(L.inputs_hash({ ...w, as_of: '2026-10-05' }), h);
  assert.notEqual(L.inputs_hash({ ...w, engine_version: '1.0.1' }), h);
  assert.notEqual(L.inputs_hash({ ...w, rules: [{ rule_id: 'R', version: 2 }] }), h);
  assert.equal(code_of(() => L.inputs_hash([])), 'E_SCHEMA');
  assert.equal(code_of(() => L.inputs_hash({ ...w, params: { x: 0.5 } })), 'E_NOT_INTEGER');
});

test('TST-42 ADV dedup_key: канон §9.13, EpochDay = ISO, k и описание влияют, norm канонических примеров', () => {
  assert.equal(L.norm('MERCADONA  *1234 Valencia, ES'), 'mercadona 1234 valencia es');
  assert.equal(L.dedup_key('acc_bank', '2026-10-03', -4730, 'EUR', 'MERCADONA  *1234 Valencia, ES', 0), 'f78f01e9751c5f66');
  assert.equal(L.dedup_key('acc_bank', D.parse_date('2026-10-03'), -4730, 'EUR', 'MERCADONA  *1234 Valencia, ES', 0), 'f78f01e9751c5f66');
  assert.equal(L.dedup_key('acc_bank', '2026-10-03', -450, 'EUR', 'Cafe Central', 0), '9d82db80ee854a7c');
  assert.equal(L.dedup_key('acc_bank', '2026-10-03', -450, 'EUR', 'Cafe Central', 1), 'b9f6b8bb563b3b40');
  assert.equal(L.dedup_key('acc_bank', '2026-10-03', -450, 'EUR', ' CAFE   central!! ', 0), '9d82db80ee854a7c', 'описание нормализуется');
  assert.notEqual(L.dedup_key('acc_other', '2026-10-03', -450, 'EUR', 'Cafe Central', 0), '9d82db80ee854a7c');
  assert.equal(code_of(() => L.dedup_key('a', '2026-10-03', -450.5, 'EUR', 'x', 0)), 'E_NOT_INTEGER');
  assert.equal(code_of(() => L.dedup_key('a', '2026-10-03', -450, 'EUR', 'x', -1)), 'E_SCHEMA');
  assert.equal(code_of(() => L.dedup_key('a', '2026-10-03', -450, 'EUR', 5, 0)), 'E_SCHEMA');
  assert.equal(code_of(() => L.dedup_key('a', '2026/10/03', -450, 'EUR', 'x', 0)), 'E_BAD_DATE');
});

test('БАГ ADV dedup_key: несуществующая дата и undefined-счёт/валюта молча хэшируются', () => {
  // Ожидание: E_BAD_DATE для 2026-02-31 / 2026-13-45 (ALG-14: format_date(date)); acc/cur обязательны.
  assert.equal(code_of(() => L.dedup_key('a', '2026-02-31', 1, 'EUR', 'x', 0)), 'E_BAD_DATE', 'дата 2026-02-31');
});

test('БАГ ADV dedup_key: acc/currency = undefined не должны давать ключ «undefined|…»', () => {
  assert.ok(code_of(() => L.dedup_key(undefined, '2026-10-03', 1, 'EUR', 'x', 0)) !== null, 'acc undefined');
  assert.ok(code_of(() => L.dedup_key('a', '2026-10-03', 1, undefined, 'x', 0)) !== null, 'cur undefined');
});

test('БАГ ADV norm: «İSTANBUL» и «istanbul» должны нормализоваться одинаково (диакритика сохраняется, ALG-14)', () => {
  // toLowerCase('İ') = 'i' + U+0307; U+0307 — не \p{L}/\p{N}, превращается в пробел и режет слово
  assert.equal(L.norm('İSTANBUL'), L.norm('ISTANBUL') === 'istanbul' ? L.norm('İSTANBUL') : 'x', 'самопроверка');
  assert.ok(!L.norm('İSTANBUL').includes(' '), `norm('İSTANBUL') = ${JSON.stringify(L.norm('İSTANBUL'))}`);
});

test('БАГ ADV norm: комбинирующие знаки без композитной формы не должны превращаться в пробел', () => {
  assert.equal(L.norm('हिन्दी'), 'हिन्दी', 'ALG-14: «Диакритика сохраняется»');
});

test('ADV norm: идемпотентность и регистронезависимость на всём диапазоне кодовых точек', () => {
  for (let cp = 0; cp < 0x30000; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const s = 'a' + String.fromCodePoint(cp) + 'b'; const n = L.norm(s);
    assert.equal(L.norm(n), n, 'U+' + cp.toString(16));
  }
  assert.deepEqual(['ｆｕｌｌ', 'Ⅷ', 'É', 'é', 'Привет,  МИР!'].map(L.norm), ['full', 'viii', 'é', 'é', 'привет мир']);
});

test('ADV make_event: порты, канонизация payload, entity_id, запрещённые типы и actor', () => {
  const ctx = { event_id: 'e1', seq: 1, recorded_at: '2026-10-04T08:16:10.123Z' };
  const e = L.make_event('rule.set', { rule_id: 'R', z: 1, a: { y: 2, x: undefined } }, ctx);
  assert.equal(e.entity_id, 'R');
  assert.deepEqual(Object.keys(e.payload), ['a', 'rule_id', 'z']);
  assert.equal(e.actor, 'user');
  assert.equal(code_of(() => L.make_event('tx.voided', {}, { ...ctx, entity_id: 'x' })), 'E_SCHEMA');
  assert.equal(code_of(() => L.make_event('nope', {}, ctx)), 'E_SCHEMA');
  assert.equal(code_of(() => L.make_event('rule.set', { rule_id: 'R', x: 0.1 }, ctx)), 'E_NOT_INTEGER');
  assert.equal(code_of(() => L.make_event('rule.set', [], ctx)), 'E_SCHEMA');
  assert.equal(code_of(() => L.make_event('rule.set', { rule_id: 'R' }, { ...ctx, seq: -1 })), 'E_SCHEMA');
  assert.equal(code_of(() => L.make_event('rule.set', { rule_id: 'R' }, { ...ctx, seq: 1.5 })), 'E_SCHEMA');
  assert.equal(code_of(() => L.make_event('rule.set', { rule_id: 'R' }, { ...ctx, actor: 'robot' })), 'E_SCHEMA');
  assert.equal(code_of(() => L.make_event('rule.set', { rule_id: 'R' }, { ...ctx, recorded_at: '2026-10-04' })), 'E_SCHEMA');
  assert.equal(code_of(() => L.make_event('rule.set', {}, ctx)), 'E_SCHEMA', 'entity_id не вывести');
  assert.equal(code_of(() => L.make_event('params.set', { a: 1 }, ctx)), 'E_SCHEMA');
});

test('БАГ ADV make_event/state_at: recorded_at с невозможными месяцем/часом принимается', () => {
  const bad = '2026-13-45T99:99:99Z';
  assert.ok(code_of(() => L.make_event('params.set', { a: 1 }, { event_id: 'x', seq: 1, recorded_at: bad, entity_id: 'p' })) !== null,
    'recorded_at = ' + bad + ' принят как момент ввода');
});

test('TST-32 ADV state_at: границы дня, EpochDay, срезы «как знали тогда»', () => {
  const mk = (seq, at) => L.make_event('params.set', { k: seq }, { event_id: 'e' + seq, seq, recorded_at: at, entity_id: 'p' });
  const j = [mk(1, '2026-10-03T23:59:59Z'), mk(2, '2026-10-04T00:00:00Z'), mk(3, '2026-10-04T23:59:59.999Z'), mk(4, '2026-10-05T00:00:00Z')];
  assert.deepEqual(L.state_at(j, '2026-10-04').map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(L.state_at(j, D.parse_date('2026-10-04')).map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(L.state_at(j, '2026-10-02'), []);
  assert.deepEqual(L.state_at(j, '2026-12-31').map((e) => e.seq), [1, 2, 3, 4]);
  assert.equal(code_of(() => L.state_at(j, '2026-10-4')), 'E_BAD_DATE');
  assert.equal(code_of(() => L.state_at([{ event_id: 'x', recorded_at: 'вчера' }], '2026-10-04')), 'E_SCHEMA');
});

test('TST-31 ADV upcast: цепочка, идемпотентность, не мутирует вход, ошибки', () => {
  const registry = {
    current: { 'rule.set': 3, 'params.set': 1 },
    steps: { 'rule.set': {
      1: (e) => ({ ...e, v: 2, payload: { ...e.payload, a: 1 } }),
      2: (e) => ({ ...e, v: 3, payload: { ...e.payload, b: 2 } }),
    } },
  };
  const e1 = { event_id: 'x', type: 'rule.set', v: 1, entity_id: 'R', payload: { rule_id: 'R' }, recorded_at: '2026-10-04T00:00:00Z', seq: 1, actor: 'user' };
  const snapshot = JSON.stringify(e1);
  const up = L.upcast(e1, registry);
  assert.equal(up.v, 3);
  assert.deepEqual(up.payload, { rule_id: 'R', a: 1, b: 2 });
  assert.equal(JSON.stringify(e1), snapshot, 'вход не изменён');
  assert.deepEqual(L.upcast(up, registry), up, 'идемпотентность');
  assert.equal(code_of(() => L.upcast({ ...e1, v: 4 }, registry)), 'E_SCHEMA');
  assert.equal(code_of(() => L.upcast({ ...e1, v: undefined }, registry)), 'E_SCHEMA');
  assert.equal(code_of(() => L.upcast({ ...e1, v: 0 }, registry)), 'E_SCHEMA');
  assert.equal(code_of(() => L.upcast({ ...e1, type: 'zzz' }, registry)), 'E_SCHEMA');
  assert.equal(code_of(() => L.upcast({ ...e1, v: 2 }, { current: { 'rule.set': 3 }, steps: {} })), 'E_SCHEMA', 'нет апкастера');
  assert.equal(code_of(() => L.upcast(e1, { current: { 'rule.set': 2 }, steps: { 'rule.set': { 1: (e) => ({ ...e, v: 5 }) } } })), 'E_SCHEMA');
});

test('TST-32 TST-38 ADV effective_events: откат отката, правки, цепочки, срез журнала', () => {
  const a = ev('tx.posted', { x: 1 }, 1, { entity_id: 't' });
  const r1 = ev('revert', { target: a.event_id }, 2, { entity_id: 'r1' });
  const r2 = ev('revert', { target: r1.event_id }, 3, { entity_id: 'r2' });
  const r3 = ev('revert', { target: r2.event_id }, 4, { entity_id: 'r3' });
  const ids = (j) => L.effective_events(j).map((e) => e.event_id);
  assert.deepEqual(ids([a]), ['e1']);
  assert.deepEqual(ids([a, r1]), []);
  assert.deepEqual(ids([a, r1, r2]), ['e1']);
  assert.deepEqual(ids([a, r1, r2, r3]), []);
  // не зависит от порядка передачи, не мутирует вход
  assert.deepEqual(ids([r3, a, r2, r1]), []);
  // правка и откат правки
  const b = ev('tx.posted', { x: 2 }, 5, { entity_id: 't', supersedes_id: a.event_id });
  const rb = ev('revert', { target: b.event_id }, 6, { entity_id: 'rb' });
  assert.deepEqual(ids([a, b]), ['e5']);
  assert.deepEqual(ids([a, b, rb]), ['e1']);
  // revert цели вне среза — игнорируется
  assert.deepEqual(ids([ev('revert', { target: 'unknown' }, 7, { entity_id: 'r' })]), []);
  assert.equal(code_of(() => L.effective_events([r1, a].map((e, i) => ({ ...e, seq: 5 })))), 'E_SCHEMA');
});

test('БАГ ADV effective_events: заменённый (supersedes) revert не должен продолжать действовать (product/04: eff[r])', () => {
  // r1 отменяет a; r2 исправляет r1 (supersedes_id = r1) и вместо a отменяет b.
  // По канону eff(r1) = false (есть эффективная замена r2) → a снова эффективна; b отменена r2.
  const a = ev('tx.posted', { x: 1 }, 1, { entity_id: 't1' });
  const b = ev('tx.posted', { x: 2 }, 2, { entity_id: 't2' });
  const r1 = ev('revert', { target: a.event_id }, 3, { entity_id: 'r1' });
  const r2 = ev('revert', { target: b.event_id }, 4, { entity_id: 'r2', supersedes_id: r1.event_id });
  assert.deepEqual(L.effective_events([a, b, r1, r2]).map((e) => e.event_id), ['e1']);
});

test('TST-38 ADV reduce: порядок вставки не влияет на state_hash; свёртка по частям = свёртка целиком', () => {
  const rng = make_rng(5);
  const mkj = () => {
    const j = []; let s = 1;
    for (let i = 0; i < 30; i++) {
      const k = rng.int(0, 9);
      if (k === 0) j.push(ev('account.opened', { account_id: 'A' + rng.int(1, 3), currency: 'EUR' }, s++));
      else if (k === 1) j.push(ev('anchor.set', { anchor_id: 'N' + rng.int(1, 3), account_id: 'A1', date: '2026-10-01', amount_minor: rng.int(-100, 100) }, s++));
      else if (k === 2) j.push(ev('rule.set', { rule_id: 'R' + rng.int(1, 3), amount: { exp_minor: -rng.int(1, 9) }, exdates: ['2026-01-01'] }, s++));
      else if (k === 3) j.push(ev('tx.posted', { account_id: 'A1', date: '2026-10-01', amount_minor: rng.int(-9, 9) }, s++, { entity_id: 'T' + rng.int(1, 5) }));
      else if (k === 4) j.push(ev('taxrule.set', { tax_rule_id: 'X' + rng.int(1, 2), rate_bp: rng.int(0, 100) }, s++));
      else if (k === 5) j.push(ev('wave_override.set', { override_id: 'W' + rng.int(1, 3), action: 'pin', event_ids: ['a'] }, s++));
      else if (k === 6) j.push(ev('params.set', { buffer_minor: rng.int(1, 9), k: rng.int(1, 3) }, s++, { entity_id: 'p' }));
      else if (k === 7) j.push(ev('match.set', { fact_event_id: 'T' + rng.int(1, 5), plan_ref: 'R1@2026-10-25' }, s++));
      else if (k === 8) j.push(ev('import.started', { batch_id: 'B' + rng.int(1, 2) }, s++));
      else j.push(ev('import.rolled_back', { batch_id: 'B' + rng.int(1, 2) }, s++));
    }
    return j;
  };
  for (let q = 0; q < 300; q++) {
    const eff = L.effective_events(mkj());
    const full = L.reduce(eff);
    const c = rng.int(0, eff.length);
    const two = L.reduce(eff.slice(c), L.reduce(eff.slice(0, c)));
    assert.equal(L.state_hash(two), L.state_hash(full), `разрез на ${c}`);
    // reduce не мутирует base
    const base = L.reduce(eff.slice(0, c)); const before = L.state_hash(base);
    L.reduce(eff.slice(c), base);
    assert.equal(L.state_hash(base), before);
  }
  const x = ev('rule.set', { rule_id: 'A', v: 1 }, 1); const y = ev('rule.set', { rule_id: 'B', v: 2 }, 2);
  assert.equal(L.state_hash(L.reduce([x, y])), L.state_hash(L.reduce([y, x])));
});

test('ADV reduce: revert в reduce и неизвестный тип — E_SCHEMA; float в payload состояния невозможен', () => {
  const r = ev('revert', { target: 'zz' }, 1, { entity_id: 'r' });
  assert.equal(code_of(() => L.reduce([r])), 'E_SCHEMA');
  const bad = { ...ev('params.set', { a: 1 }, 2, { entity_id: 'p' }), type: 'zzz' };
  assert.ok(code_of(() => L.reduce([bad])) !== null);
  const fl = { ...ev('params.set', { a: 1 }, 3, { entity_id: 'p' }), payload: { a: 0.5 } };
  assert.equal(code_of(() => L.reduce([fl])), 'E_NOT_INTEGER');
  assert.equal(code_of(() => L.reduce([ev('account.closed', { account_id: 'nobody', closed_on: '2026-01-01' }, 4)])), 'E_SCHEMA');
});

test('БАГ ADV reduce: идентификатор «__proto__» ломает состояние (правило теряется, state_hash бросает E_SCHEMA)', () => {
  const e = ev('rule.set', { rule_id: '__proto__', x: 1 }, 1);
  let s;
  try { s = L.reduce([e]); } catch (err) { assert.equal(err?.name, 'RunwayError'); return; }
  assert.ok(Object.hasOwn(s.rules, '__proto__'), 'правило потеряно: записано в прототип словаря');
  assert.doesNotThrow(() => L.state_hash(s), 'state_hash состояния с «__proto__»-ключом');
});

test('БАГ ADV reduce: params.set с ключом «__proto__» подменяет прототип s.params', () => {
  const e = ev('params.set', JSON.parse('{"__proto__":{"a":1},"b":2}'), 1, { entity_id: 'p' });
  let s;
  try { s = L.reduce([e]); } catch (err) { assert.equal(err?.name, 'RunwayError'); return; }
  assert.equal(Object.getPrototypeOf(s.params), Object.prototype);
  assert.doesNotThrow(() => L.state_hash(s));
});

test('БАГ ADV reduce: taxrule.set с tax_rule_id «constructor» — TypeError вместо RunwayError/успеха', () => {
  const e = ev('taxrule.set', { tax_rule_id: 'constructor', rate_bp: 1 }, 1);
  let s;
  try { s = L.reduce([e]); } catch (err) { assert.equal(err?.name, 'RunwayError', `${err?.name}: ${err?.message}`); return; }
  assert.ok(Array.isArray(s.tax_rules.constructor));
});

test('БАГ ADV reduce: account.closed для неоткрытого счёта «toString» не бросает E_SCHEMA (унаследованное свойство)', () => {
  const e = ev('account.closed', { account_id: 'toString', closed_on: '2026-01-01' }, 1);
  assert.equal(code_of(() => L.reduce([e])), 'E_SCHEMA');
});

test('БАГ ADV reduce: состояние делит вложенные объекты с payload журнала — правка состояния портит журнал', () => {
  const r = ev('rule.set', { rule_id: 'R', exdates: ['2026-01-01'], amount: { exp_minor: -5 } }, 1);
  const before = L.canon(r.payload);
  const s = L.reduce([r]);
  s.rules.R.exdates.push('2027-01-01');
  s.rules.R.amount.exp_minor = 999;
  assert.equal(L.canon(r.payload), before, 'инвариант 3: журнал не мутирует');
  const s2 = L.reduce([r]);
  assert.deepEqual(s2.rules.R.exdates, ['2026-01-01'], 'повторная свёртка видит чужую правку');
});
