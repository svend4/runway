// hourly.test.mjs — TST-25 (часы: брутто и переработка), TST-26 (часы: недоработка и пересчёт дохода), TST-10 (часть: доход по часам G-001),
// TST-51/53 (фаззинг и оракул периодов и выплат). Числа — design-brief §9.2, ALG-07 TV-1…TV-5, C-028 (одно округление), C-026 (biweek).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gross_pay, period_bounds, pay_date, planned_exp, resolve_hours, validate_stream, expand_stream, expand_stream_ex, plan_to_date, shortfall,
} from '../engine/hourly.mjs';
import { parse_date, format_date, dow, make_calendar, days_from_civil, civil_from_days } from '../engine/dates.mjs';
import { make_rng, throws_code, G001 } from './helpers.mjs';

const d = parse_date;
const CAL = make_calendar({ weekend_dows: [0, 6], holidays: [] });

/** Поток G-001: 30,00 €/ч, месяц, граница — конец месяца, лаг 5 дней, сдвиг `next`, часы 80/93/110 ч. */
const S_HOURLY = Object.freeze({
  stream_id: 'S-HOURLY', account_id: 'acc_main', name: 'S-HOURLY', currency: 'EUR', rate_minor: 3000, period: 'month', cutoff: { kind: 'month_end' },
  pay_lag_days: 5, weekend: 'next', hours: { min_minutes: 4800, exp_minutes: 5580, max_minutes: 6600 },
});
const WIN57 = { from: G001.as_of, to: G001.horizon_end };

/** Эталон деления с округлением на BigInt (независимо от money.mjs): half_even / half_up (от нуля) / floor / ceil, d > 0. */
function oracle_div(n, dd, mode) {
  let q = n / dd;
  let r = n % dd;
  if (r < 0n) { q -= 1n; r += dd; }
  if (mode === 'floor') return q;
  if (mode === 'ceil') return r > 0n ? q + 1n : q;
  const t = 2n * r;
  if (t < dd) return q;
  if (t > dd) return q + 1n;
  if (mode === 'half_up') return n >= 0n ? q + 1n : q;
  return q % 2n === 0n ? q : q + 1n;
}

// ── TST-25: брутто и переработка ───────────────────────────────────────────────

test('TST-25 gross_pay: mul_div(3000, 5580, 60) = 279000; диапазон 80/110 ч = 240000 / 330000', () => {
  assert.equal(gross_pay(3000, 5580, null), 279000);
  assert.equal(gross_pay(3000, 4800, undefined), 240000);
  assert.equal(gross_pay(3000, 6600), 330000);
  assert.equal(gross_pay(3000, 5760), 288000, 'сентябрь: 96 ч');
  assert.equal(gross_pay(0, 5580), 0);
  assert.equal(gross_pay(3000, 0), 0);
});

test('TST-25 переработка (одно округление, C-028): 46 ч за неделю, порог 40 ч, ×1,5 → 147000; 40 ч → 120000', () => {
  const ot = { threshold_minutes: 2400, mult_bp: 15000 };
  assert.equal(gross_pay(3000, 2760, ot), 147000, 'mul_div(3000, 2400·10000 + 360·15000, 600000)');
  assert.equal(gross_pay(3000, 2400, ot), 120000, 'без переработки');
  assert.equal(gross_pay(3000, 2000, ot), 100000, 'ниже порога');
  assert.equal(gross_pay(3000, 2401, ot), 120075, '24015000 / 200 — точно (прежние 120100 отменены)');
  assert.equal(gross_pay(3000, 2403, ot), 120225, '24045000 / 200 — точно (прежние 120200 отменены)');
  // mult_bp = 10000 — линейно, как без переработки; mult_bp = 0 — сверхпорог не оплачивается
  assert.equal(gross_pay(3000, 2760, { threshold_minutes: 2400, mult_bp: 10000 }), gross_pay(3000, 2760));
  assert.equal(gross_pay(3000, 2760, { threshold_minutes: 2400, mult_bp: 0 }), 120000);
  assert.equal(gross_pay(3000, 2760, { threshold_minutes: 0, mult_bp: 20000 }), 3000 * 2760 * 2 / 60);
});

test('TST-25 ничья округления: m = 2401, T = 2400, ставка 3000, mult_bp = 12500 → 120062,5 → half_even 120062, half_up 120063', () => {
  const ot = { threshold_minutes: 2400, mult_bp: 12500 };
  assert.equal(gross_pay(3000, 2401, ot, 'half_even'), 120062);
  assert.equal(gross_pay(3000, 2401, ot, 'half_up'), 120063);
  assert.equal(gross_pay(3000, 2401, ot, 'floor'), 120062);
  assert.equal(gross_pay(3000, 2401, ot, 'ceil'), 120063);
  assert.equal(gross_pay(3000, 2401, ot), 120062, 'по умолчанию half_even');
  // режим округления потока — params.rounding (opts), у потока своего нет (C-029)
  const win = { from: d('2026-11-01'), to: d('2026-11-30') };
  const week = { ...S_HOURLY, period: 'week', cutoff: { kind: 'weekday', weekday: 5 }, pay_lag_days: 0, weekend: 'keep', hours: { min_minutes: 2401, exp_minutes: 2401, max_minutes: 2401 }, overtime: ot };
  assert.ok(expand_stream(week, win, CAL, { rounding: 'half_even' }).every((e) => e.amount_minor === 120062));
  assert.ok(expand_stream(week, win, CAL, { rounding: 'half_up' }).every((e) => e.amount_minor === 120063));
  assert.ok(expand_stream(week, win, CAL).every((e) => e.amount_minor === 120062), 'без opts — half_even');
});

test('TST-25 gross_pay: ошибки — отрицательные ставка/минуты, дробные значения, плохая переработка, неизвестный режим', () => {
  throws_code(() => gross_pay(-1, 60), 'E_SCHEMA');
  throws_code(() => gross_pay(3000, -1), 'E_SCHEMA');
  throws_code(() => gross_pay(3000, 1.5), 'E_NOT_INTEGER');
  throws_code(() => gross_pay(3000, 60, { threshold_minutes: -1, mult_bp: 15000 }), 'E_SCHEMA');
  throws_code(() => gross_pay(3000, 60, { threshold_minutes: 10, mult_bp: -1 }), 'E_SCHEMA');
  throws_code(() => gross_pay(3000, 60, null, 'round'), 'E_SCHEMA');
  throws_code(() => gross_pay(Number.MAX_SAFE_INTEGER, 6000), 'E_OVERFLOW');
});

test('TST-53 оракул gross_pay: монотонность, линейность ±1 minor и точное значение на BigInt (5 000 случаев)', () => {
  const rng = make_rng(25);
  const modes = ['half_even', 'half_up', 'floor', 'ceil'];
  for (let it = 0; it < 5000; it++) {
    const rate = rng.int(0, 20000);
    const m = rng.int(0, 20000);
    const mode = rng.pick(modes);
    const ot = rng.bool() ? { threshold_minutes: rng.int(0, 12000), mult_bp: rng.int(0, 30000) } : null;
    const wx = ot === null ? BigInt(m) * 10000n : BigInt(Math.min(m, ot.threshold_minutes)) * 10000n + BigInt(Math.max(0, m - ot.threshold_minutes)) * BigInt(ot.mult_bp);
    const want = Number(oracle_div(BigInt(rate) * wx, 600000n, mode));
    assert.equal(gross_pay(rate, m, ot, mode), want);
    // монотонность по минутам и по ставке
    assert.ok(gross_pay(rate, m + rng.int(0, 500), ot, mode) >= want);
    assert.ok(gross_pay(rate + rng.int(0, 500), m, ot, mode) >= want);
  }
  for (let it = 0; it < 1000; it++) {
    const rate = rng.int(0, 20000);
    const a = rng.int(0, 10000);
    const b = rng.int(0, 10000);
    assert.ok(Math.abs(gross_pay(rate, a + b) - gross_pay(rate, a) - gross_pay(rate, b)) <= 1, 'линейность без переработки: ±1 minor');
  }
});

// ── периоды, выплаты ───────────────────────────────────────────────────────────

test('TST-10/TV-5 period_bounds: месяц, неделя с границей в пятницу, biweek с anchor 2026-10-09', () => {
  assert.deepEqual(period_bounds(S_HOURLY, d('2026-10-17')), { start: d('2026-10-01'), end: d('2026-10-31') });
  assert.deepEqual(period_bounds(S_HOURLY, d('2026-02-10')), { start: d('2026-02-01'), end: d('2026-02-28') });
  assert.deepEqual(period_bounds(S_HOURLY, d('2028-02-29')), { start: d('2028-02-01'), end: d('2028-02-29') });
  const week = { ...S_HOURLY, period: 'week', cutoff: { kind: 'weekday', weekday: 5 } };
  assert.deepEqual(period_bounds(week, d('2026-10-04')), { start: d('2026-10-03'), end: d('2026-10-09') }, 'd — воскресенье → end 10-09');
  assert.deepEqual(period_bounds(week, d('2026-10-09')), { start: d('2026-10-03'), end: d('2026-10-09') }, 'd на границе — в этом же периоде');
  assert.equal(format_date(period_bounds(week, d('2026-10-04')).end + S_HOURLY.pay_lag_days), '2026-10-14', 'лаг 5 → номинал среда 10-14');
  const bi = { ...S_HOURLY, period: 'biweek', cutoff: { kind: 'weekday', weekday: 5, anchor: '2026-10-09' } };
  assert.deepEqual(period_bounds(bi, d('2026-10-12')), { start: d('2026-10-10'), end: d('2026-10-23') });
  assert.deepEqual(period_bounds(bi, d('2026-10-09')), { start: d('2026-09-26'), end: d('2026-10-09') });
  assert.deepEqual(period_bounds(bi, d('2026-10-10')), { start: d('2026-10-10'), end: d('2026-10-23') });
});

test('period_bounds: недопустимая пара period/cutoff, biweek без anchor или с anchor не того дня недели — E_SCHEMA (C-026)', () => {
  throws_code(() => period_bounds({ ...S_HOURLY, period: 'week' }, 20730), 'E_SCHEMA');
  throws_code(() => period_bounds({ ...S_HOURLY, period: 'month', cutoff: { kind: 'weekday', weekday: 5 } }, 20730), 'E_SCHEMA');
  throws_code(() => period_bounds({ ...S_HOURLY, period: 'biweek', cutoff: { kind: 'weekday', weekday: 5 } }, 20730), 'E_SCHEMA');
  throws_code(() => period_bounds({ ...S_HOURLY, period: 'biweek', cutoff: { kind: 'weekday', weekday: 5, anchor: '2026-10-10' } }, 20730), 'E_SCHEMA');
  throws_code(() => period_bounds({ ...S_HOURLY, period: 'week', cutoff: { kind: 'weekday', weekday: 9 } }, 20730), 'E_SCHEMA');
});

test('TST-10 pay_date: 31 окт + 5 = 2026-11-05 (четверг, сдвиг не нужен); 30 ноя + 5 = 12-05 (суббота) → 2026-12-07; keep/prev', () => {
  assert.equal(format_date(pay_date(d('2026-10-31'), S_HOURLY, CAL)), '2026-11-05');
  assert.equal(pay_date(d('2026-10-31'), S_HOURLY, CAL), 20762, 'EpochDay 20762');
  assert.equal(format_date(pay_date(d('2026-11-30'), S_HOURLY, CAL)), '2026-12-07');
  assert.equal(pay_date(d('2026-11-30'), S_HOURLY, CAL), 20794);
  assert.equal(format_date(pay_date(d('2026-11-30'), { ...S_HOURLY, weekend: 'keep' }, CAL)), '2026-12-05');
  assert.equal(format_date(pay_date(d('2026-11-30'), { ...S_HOURLY, weekend: 'prev' }, CAL)), '2026-12-04');
  throws_code(() => pay_date(d('2026-11-30'), { ...S_HOURLY, weekend: 'skip' }, CAL), 'E_SCHEMA');
});

// ── TST-10: expand_stream на G-001 ─────────────────────────────────────────────

test('TST-10 expand_stream G-001 (горизонт 57 дн.): октябрьская выплата 279000 на 2026-11-05, коридор 240000…330000, occ_key S-HOURLY@2026-11-05', () => {
  // сентябрьская выплата (09-30 + 5 = 10-05) уже получена 10-02 и лежит в якоре; её исключает сопоставление план→факт (ALG-13),
  // поэтому для вектора берём окно с 10-06, а 10-05 проверяем отдельно ниже
  const evs = expand_stream(S_HOURLY, { from: d('2026-10-06'), to: G001.horizon_end }, CAL, { rounding: 'half_even' });
  assert.equal(evs.length, 1, 'ноябрьская выплата 2026-12-07 вне горизонта 57 дн.');
  const e = evs[0];
  assert.equal(e.date, 20762);
  assert.equal(format_date(e.date), '2026-11-05');
  assert.equal(e.amount_minor, 279000);
  assert.equal(e.amount_min_minor, 240000);
  assert.equal(e.amount_max_minor, 330000);
  assert.equal(e.occ_key, 'S-HOURLY@2026-11-05');
  assert.equal(e.cash_event_id, e.occ_key);
  assert.equal(e.stream_id, 'S-HOURLY');
  assert.equal(e.rule_id, null, 'C-025: у событий потока rule_id = null');
  assert.equal(e.layer, 'planned');
  assert.equal(e.kind, 'income');
  assert.equal(e.status, 'expected');
  assert.equal(e.account_id, 'acc_main');
  assert.equal(e.currency, 'EUR');
  assert.equal(e.tag, 'S-HOURLY');
  assert.deepEqual([e.is_obligation, e.is_estimate, e.is_exceptional], [false, false, false]);
  assert.ok(e.amount_min_minor <= e.amount_minor && e.amount_minor <= e.amount_max_minor);
});

test('TST-10 expand_stream: с as_of 2026-10-04 в окно попадает и сентябрьское вхождение 10-05 (его снимает сопоставление с фактом 10-02, ALG-13)', () => {
  const sept = { ...S_HOURLY, hours_by_period: { '2026-09-01': { actual_minutes: 5760 } } };
  const { events, warnings } = expand_stream_ex(sept, WIN57, CAL);
  assert.deepEqual(events.map((e) => [format_date(e.date), e.occ_key, e.amount_minor]), [
    ['2026-10-05', 'S-HOURLY@2026-10-05', 288000], // закрытый период с фактом 96 ч: min = exp = max
    ['2026-11-05', 'S-HOURLY@2026-11-05', 279000],
  ]);
  assert.deepEqual([events[0].amount_min_minor, events[0].amount_max_minor], [288000, 288000]);
  assert.deepEqual(warnings, [], 'факт введён — предупреждения нет');
});

test('TST-10 expand_stream: горизонт 180 дн. — ноябрьская выплата 2026-12-07 (суббота 12-05 → понедельник); бонус 50000 на 2026-11-12', () => {
  const s = { ...S_HOURLY, bonus: [{ date: '2026-11-12', amount_minor: 50000 }, { date: '2027-03-01', amount_minor: 100 }, { date: '2026-09-01', amount_minor: 7 }] };
  const evs = expand_stream(s, { from: d('2026-10-06'), to: d('2026-10-04') + 179 }, CAL);
  assert.deepEqual(evs.map((e) => [format_date(e.date), e.occ_key, e.amount_minor]), [
    ['2026-11-05', 'S-HOURLY@2026-11-05', 279000],
    ['2026-11-12', 'S-HOURLY@bonus@2026-11-12', 50000],
    ['2026-12-07', 'S-HOURLY@2026-12-05', 279000],
    ['2027-01-05', 'S-HOURLY@2027-01-05', 279000],
    ['2027-02-05', 'S-HOURLY@2027-02-05', 279000],
    ['2027-03-01', 'S-HOURLY@bonus@2027-03-01', 100],
    ['2027-03-05', 'S-HOURLY@2027-03-05', 279000],
  ], 'ключ occ_key — номинальная дата (12-05), не зависит от сдвига по выходным; бонус 2026-09-01 раньше окна, 04-05 — позже');
  // порядок бонусов во входе не влияет (инв. 8)
  const rev = { ...s, bonus: [...s.bonus].reverse() };
  assert.deepEqual(expand_stream(rev, { from: d('2026-10-06'), to: d('2027-03-31') }, CAL), expand_stream(s, { from: d('2026-10-06'), to: d('2027-03-31') }, CAL));
  const b = expand_stream(s, { from: d('2026-10-06'), to: d('2026-12-31') }, CAL).find((e) => e.occ_key.includes('bonus'));
  assert.deepEqual([b.amount_min_minor, b.amount_max_minor], [50000, 50000]);
});

test('TST-10 expand_stream: delay_days_worse и counterparty_id переносятся в событие; прошлые выплаты и выплаты за горизонтом не порождаются', () => {
  const s = { ...S_HOURLY, delay_days_worse: 21, counterparty_id: 'CP-1' };
  const evs = expand_stream(s, { from: d('2026-11-06'), to: d('2026-12-06') }, CAL);
  assert.deepEqual(evs, [], '11-05 — раньше окна, 12-07 — позже');
  const e = expand_stream(s, { from: d('2026-11-05'), to: d('2026-11-05') }, CAL);
  assert.equal(e.length, 1, 'выплата ровно в день from — в окне (D-01)');
  assert.equal(e[0].delay_days_worse, 21);
  assert.equal(e[0].counterparty_id, 'CP-1');
  assert.ok(!('delay_days_worse' in expand_stream(S_HOURLY, WIN57, CAL)[0]));
});

test('TST-25 expand_stream: exp = 0 или rate = 0 — события нет; недельный поток с границей в пятницу; biweek с anchor', () => {
  assert.deepEqual(expand_stream({ ...S_HOURLY, hours: { min_minutes: 0, exp_minutes: 0, max_minutes: 100 } }, WIN57, CAL), []);
  assert.deepEqual(expand_stream({ ...S_HOURLY, rate_minor: 0 }, WIN57, CAL), []);
  const week = { ...S_HOURLY, period: 'week', cutoff: { kind: 'weekday', weekday: 5 }, pay_lag_days: 5, weekend: 'keep', hours: { min_minutes: 1800, exp_minutes: 2400, max_minutes: 2700 } };
  const w = expand_stream(week, { from: d('2026-10-04'), to: d('2026-10-31') }, CAL);
  assert.deepEqual(w.map((e) => format_date(e.date)), ['2026-10-07', '2026-10-14', '2026-10-21', '2026-10-28'], 'границы 10-02, 10-09, 10-16, 10-23 + 5');
  assert.ok(w.every((e) => e.amount_minor === 120000 && e.amount_min_minor === 90000 && e.amount_max_minor === 135000));
  const bi = { ...week, period: 'biweek', cutoff: { kind: 'weekday', weekday: 5, anchor: '2026-10-09' }, hours: { min_minutes: 4800, exp_minutes: 4800, max_minutes: 4800 } };
  const b = expand_stream(bi, { from: d('2026-10-04'), to: d('2026-11-30') }, CAL);
  assert.deepEqual(b.map((e) => e.occ_key), ['S-HOURLY@2026-10-14', 'S-HOURLY@2026-10-28', 'S-HOURLY@2026-11-11', 'S-HOURLY@2026-11-25'], 'границы 10-09, 10-23, 11-06, 11-20 + 5');
});

test('TST-10 expand_stream: переработка применяется к минутам периода потока, коридор — по тем же правилам', () => {
  const s = { ...S_HOURLY, period: 'week', cutoff: { kind: 'weekday', weekday: 5 }, pay_lag_days: 0, weekend: 'keep', hours: { min_minutes: 2400, exp_minutes: 2760, max_minutes: 3000 }, overtime: { threshold_minutes: 2400, mult_bp: 15000 } };
  const e = expand_stream(s, { from: d('2026-10-09'), to: d('2026-10-09') }, CAL)[0];
  assert.equal(e.amount_minor, 147000);
  assert.equal(e.amount_min_minor, 120000);
  assert.equal(e.amount_max_minor, gross_pay(3000, 3000, s.overtime));
});

// ── TV-4: закрытый и идущий период, предупреждения ─────────────────────────────

test('TST-26/TV-4 resolve_hours: закрытый период с фактом схлопывается; без факта — exp; идущий период поднимает диапазон фактом', () => {
  const oct = { start: d('2026-10-01'), end: d('2026-10-31') };
  const closed = { ...S_HOURLY, hours_by_period: { '2026-10-01': { actual_minutes: 5700 } } };
  assert.deepEqual(resolve_hours(closed, oct, d('2026-11-01')), { min: 5700, exp: 5700, max: 5700, actual: 5700, closed: true });
  assert.equal(gross_pay(3000, 5700), 285000);
  assert.deepEqual(resolve_hours(S_HOURLY, oct, d('2026-11-01')), { min: 4800, exp: 5580, max: 6600, actual: null, closed: true });
  const running = { ...S_HOURLY, hours_by_period: { '2026-10-01': { actual_minutes: 5000 } } };
  const r = resolve_hours(running, oct, d('2026-10-20'));
  assert.deepEqual(r, { min: 5000, exp: 5580, max: 6600, actual: 5000, closed: false });
  assert.equal(gross_pay(3000, r.min), 250000, 'amount_min_minor = 250000');
  // факт выше max поднимает и max, и exp
  assert.deepEqual(resolve_hours({ ...S_HOURLY, hours_by_period: { '2026-10-01': { actual_minutes: 7000 } } }, oct, d('2026-10-20')), { min: 7000, exp: 7000, max: 7000, actual: 7000, closed: false });
  // переопределение exp на период и planned_exp
  const ov = { ...S_HOURLY, hours_by_period: { '2026-10-01': { exp_minutes: 6000 } } };
  assert.equal(planned_exp(ov, oct), 6000);
  assert.equal(planned_exp(S_HOURLY, oct), 5580);
  assert.deepEqual(resolve_hours(ov, oct, d('2026-10-04')), { min: 4800, exp: 6000, max: 6600, actual: null, closed: false });
});

test('TV-4 expand_stream: закрытый период без факта — exp и W_HOURS_NOT_CONFIRMED; идущий период с фактом 5000 → amount_min_minor 250000', () => {
  const win = { from: d('2026-11-01'), to: d('2026-11-30') };
  const { events, warnings } = expand_stream_ex(S_HOURLY, win, CAL);
  assert.equal(events.length, 1);
  assert.equal(events[0].amount_minor, 279000);
  assert.deepEqual(warnings, [{ code: 'W_HOURS_NOT_CONFIRMED', stream_id: 'S-HOURLY', period_start: '2026-10-01' }]);
  const fact = { ...S_HOURLY, hours_by_period: { '2026-10-01': { actual_minutes: 5700 } } };
  const r = expand_stream_ex(fact, win, CAL);
  assert.equal(r.events[0].amount_minor, 285000);
  assert.deepEqual(r.warnings, []);
  const run = { ...S_HOURLY, hours_by_period: { '2026-10-01': { actual_minutes: 5000 } } };
  const e = expand_stream(run, { from: d('2026-10-20'), to: d('2026-11-30') }, CAL)[0];
  assert.deepEqual([e.amount_min_minor, e.amount_minor, e.amount_max_minor], [250000, 279000, 330000]);
});

test('expand_stream_ex: ключ hours_by_period не совпал с началом периода — игнорируется с предупреждением W_HOURS_KEY_IGNORED', () => {
  const s = { ...S_HOURLY, hours_by_period: { '2026-10-02': { actual_minutes: 9999 }, '2026-10-01': { exp_minutes: 5580 } } };
  const r = expand_stream_ex(s, { from: d('2026-10-06'), to: G001.horizon_end }, CAL);
  assert.equal(r.events[0].amount_minor, 279000, 'опечатанный ключ не влияет на сумму');
  assert.deepEqual(r.warnings, [{ code: 'W_HOURS_KEY_IGNORED', stream_id: 'S-HOURLY', key: '2026-10-02' }]);
});

// ── TST-26: недоработка ────────────────────────────────────────────────────────

test('TST-26 недоработка на 2026-10-20: темп 180 мин/день, plan_to_date = 3600, факт 52 ч = 3120 → short 480, effect 24000, est 5100 → 255000', () => {
  const oct = { start: d('2026-10-01'), end: d('2026-10-31') };
  assert.equal(plan_to_date(S_HOURLY, oct, d('2026-10-20')), 3600);
  const r = shortfall(S_HOURLY, oct, d('2026-10-20'), 3120);
  assert.deepEqual(r, { short_minutes: 480, effect_minor: 24000, est_minutes: 5100, est_gross_minor: 255000 });
  assert.equal(r.est_gross_minor, 279000 - r.effect_minor);
  // опережение: факт 3720 → short −120, effect −6000, est 5700, est_gross 285000
  assert.deepEqual(shortfall(S_HOURLY, oct, d('2026-10-20'), 3720), { short_minutes: -120, effect_minor: -6000, est_minutes: 5700, est_gross_minor: 285000 });
  // short = 0 при actual = plan_to_date; est = exp (инв. 6)
  assert.deepEqual(shortfall(S_HOURLY, oct, d('2026-10-20'), 3600), { short_minutes: 0, effect_minor: 0, est_minutes: 5580, est_gross_minor: 279000 });
});

test('TST-26 plan_to_date: до начала периода 0, после конца — exp (закрытый период, инв. 7); февраль делит на 29; pace_minutes_per_day', () => {
  const oct = { start: d('2026-10-01'), end: d('2026-10-31') };
  assert.equal(plan_to_date(S_HOURLY, oct, d('2026-09-15')), 0);
  assert.equal(plan_to_date(S_HOURLY, oct, d('2026-10-01')), 180, 'as_of входит в «прошло»');
  assert.equal(plan_to_date(S_HOURLY, oct, d('2026-11-20')), 5580);
  const feb = { start: d('2028-02-01'), end: d('2028-02-29') };
  assert.equal(plan_to_date({ ...S_HOURLY, hours: { min_minutes: 0, exp_minutes: 2900, max_minutes: 3000 } }, feb, d('2028-02-10')), 1000, '2900 · 10 / 29');
  assert.equal(plan_to_date({ ...S_HOURLY, pace_minutes_per_day: 200 }, oct, d('2026-10-20')), 4000);
  const closed = shortfall(S_HOURLY, oct, d('2026-11-20'), 5100);
  assert.deepEqual([closed.short_minutes, closed.est_minutes], [480, 5100], 'закрытый период: est = actual');
  // период с переопределённым exp
  const ov = { ...S_HOURLY, hours_by_period: { '2026-10-01': { exp_minutes: 3100 } } };
  assert.equal(plan_to_date(ov, oct, d('2026-10-20')), 2000, 'planned_exp берётся из hours_by_period: 3100 · 20 / 31');
  throws_code(() => shortfall(S_HOURLY, oct, d('2026-10-20'), -1), 'E_SCHEMA');
});

test('TST-26 shortfall: оценка с переработкой считается через gross_pay; effect — по базовой ставке; opts.rounding', () => {
  const s = { ...S_HOURLY, period: 'week', cutoff: { kind: 'weekday', weekday: 5 }, overtime: { threshold_minutes: 2400, mult_bp: 12500 }, hours: { min_minutes: 2400, exp_minutes: 2401, max_minutes: 2500 } };
  const wk = period_bounds(s, d('2026-10-07'));
  const r = shortfall(s, wk, d('2026-10-02'), 0, { rounding: 'half_even' }); // as_of до начала периода: plan = 0, est = exp = 2401
  assert.equal(r.est_gross_minor, 120062);
  assert.equal(shortfall(s, wk, d('2026-10-02'), 0, { rounding: 'half_up' }).est_gross_minor, 120063);
});

// ── валидация потока ───────────────────────────────────────────────────────────

test('validate_stream: weekend = skip запрещён (C-032), biweek без anchor / с anchor не того дня (C-026), min ≤ exp ≤ max, переработка, бонус', () => {
  assert.deepEqual(validate_stream(S_HOURLY), { ok: true, errors: [] });
  const fields = (s) => validate_stream(s).errors.map((e) => e.field);
  assert.ok(fields({ ...S_HOURLY, weekend: 'skip' }).includes('weekend'));
  assert.ok(fields({ ...S_HOURLY, period: 'biweek', cutoff: { kind: 'weekday', weekday: 5 } }).includes('cutoff.anchor'));
  assert.ok(fields({ ...S_HOURLY, period: 'biweek', cutoff: { kind: 'weekday', weekday: 5, anchor: '2026-10-10' } }).includes('cutoff.anchor'));
  assert.equal(validate_stream({ ...S_HOURLY, period: 'biweek', cutoff: { kind: 'weekday', weekday: 5, anchor: '2026-10-09' } }).ok, true);
  assert.ok(fields({ ...S_HOURLY, hours: { min_minutes: 5000, exp_minutes: 4000, max_minutes: 6000 } }).includes('hours'));
  assert.ok(fields({ ...S_HOURLY, hours_by_period: { '2026-10-01': { exp_minutes: 7000 } } }).includes('hours_by_period.2026-10-01'), 'после слияния exp > max');
  assert.ok(fields({ ...S_HOURLY, overtime: { threshold_minutes: -1, mult_bp: 15000 } }).includes('overtime.threshold_minutes'));
  assert.ok(fields({ ...S_HOURLY, bonus: [{ date: '2026-11-12', amount_minor: 0 }] }).includes('bonus[0].amount_minor'));
  assert.ok(fields({ ...S_HOURLY, bonus: [{ date: '2026-13-12', amount_minor: 5 }] }).includes('bonus[0].date'));
  assert.ok(fields({ ...S_HOURLY, rate_minor: -5 }).includes('rate_minor'));
  assert.ok(fields({ ...S_HOURLY, pay_lag_days: -1 }).includes('pay_lag_days'));
  assert.ok(fields({ ...S_HOURLY, period: 'month', cutoff: { kind: 'weekday', weekday: 5 } }).includes('cutoff'));
  assert.ok(fields({ ...S_HOURLY, weekend: 'maybe' }).includes('weekend'));
  assert.ok(fields({ ...S_HOURLY, pace_minutes_per_day: -1 }).includes('pace_minutes_per_day'));
  assert.equal(validate_stream(null).ok, false);
  // expand_stream не работает с невалидным потоком
  throws_code(() => expand_stream({ ...S_HOURLY, weekend: 'skip' }, WIN57, CAL), 'E_SCHEMA');
  throws_code(() => expand_stream({ ...S_HOURLY, period: 'biweek', cutoff: { kind: 'weekday', weekday: 5 } }, WIN57, CAL), 'E_SCHEMA');
});

// ── TST-51/53: оракул «день за днём» для периодов и выплат ─────────────────────

/** Эталон: все границы периодов в [lo, hi] перебором дней (без period_bounds). */
function oracle_period_ends(s, lo, hi) {
  const ends = [];
  for (let x = lo; x <= hi; x++) {
    let is_end = false;
    if (s.period === 'month') { const [, , dd] = civil_from_days(x + 1); is_end = dd === 1; }
    else if (s.period === 'week') is_end = dow(x) === s.cutoff.weekday;
    else is_end = dow(x) === s.cutoff.weekday && (((x - d(s.cutoff.anchor)) % 14) + 14) % 14 === 0;
    if (is_end) ends.push(x);
  }
  return ends;
}

test('TST-51 период содержит день, длина и граница верны; соседние периоды стыкуются без пропусков (оракул «день за днём», 1 500 потоков)', () => {
  const rng = make_rng(7);
  for (let it = 0; it < 1500; it++) {
    const kind = rng.pick(['month', 'week', 'biweek']);
    const weekday = rng.int(0, 6);
    const anchor = days_from_civil(2026, 1, 1) + rng.int(0, 400);
    const anchor_aligned = anchor + ((weekday - dow(anchor) + 7) % 7);
    const s = kind === 'month' ? { ...S_HOURLY } : { ...S_HOURLY, period: kind, cutoff: { kind: 'weekday', weekday, anchor: kind === 'biweek' ? format_date(anchor_aligned) : undefined } };
    const day = days_from_civil(2020, 1, 1) + rng.int(0, 3000);
    const b = period_bounds(s, day);
    assert.ok(b.start <= day && day <= b.end, 'период содержит день');
    const ends = oracle_period_ends(s, day - 40, day + 40);
    assert.equal(b.end, ends.find((x) => x >= day), 'ближайшая граница не раньше d');
    const next = period_bounds(s, b.end + 1);
    assert.equal(next.start, b.end + 1, 'периоды стыкуются');
    if (kind === 'week') assert.equal(b.end - b.start, 6);
    if (kind === 'biweek') assert.equal(b.end - b.start, 13);
  }
});

test('TST-53 expand_stream: даты выплат совпадают с оракулом «границы дня за днём + лаг + сдвиг», все даты в окне, occ_key уникальны (400 потоков)', () => {
  const rng = make_rng(99);
  const cal = make_calendar({ weekend_dows: [0, 6], holidays: ['2026-12-25', '2026-12-26', '2027-01-01'] });
  for (let it = 0; it < 400; it++) {
    const kind = rng.pick(['month', 'week', 'biweek']);
    const weekday = rng.int(0, 6);
    const a0 = days_from_civil(2026, 1, 1) + rng.int(0, 200);
    const anchor = a0 + ((weekday - dow(a0) + 7) % 7);
    const s = {
      ...S_HOURLY, period: kind, weekend: rng.pick(['keep', 'prev', 'next']), pay_lag_days: rng.int(0, 20),
      cutoff: kind === 'month' ? { kind: 'month_end' } : { kind: 'weekday', weekday, anchor: format_date(anchor) },
      hours: { min_minutes: 100, exp_minutes: 200 + rng.int(0, 5000), max_minutes: 6000 },
    };
    const from = days_from_civil(2026, 10, 4) + rng.int(0, 60);
    const to = from + rng.int(0, 120);
    const evs = expand_stream(s, { from, to }, cal);
    // оракул
    const want = [];
    for (const end of oracle_period_ends(s, from - 150, to + 60)) {
      const nominal = end + s.pay_lag_days;
      let pd = nominal;
      if (s.weekend === 'next') while (dow(pd) === 0 || dow(pd) === 6 || cal.holidays.includes(format_date(pd))) pd += 1;
      if (s.weekend === 'prev') while (dow(pd) === 0 || dow(pd) === 6 || cal.holidays.includes(format_date(pd))) pd -= 1;
      if (from <= pd && pd <= to) want.push([pd, s.stream_id + '@' + format_date(nominal)]);
    }
    want.sort((x, y) => x[0] - y[0] || (x[1] < y[1] ? -1 : 1));
    assert.deepEqual(evs.map((e) => [e.date, e.occ_key]), want);
    assert.equal(new Set(evs.map((e) => e.occ_key)).size, evs.length, 'occ_key уникален');
    for (const e of evs) assert.ok(e.amount_min_minor <= e.amount_minor && e.amount_minor <= e.amount_max_minor);
  }
});
