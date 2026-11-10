// debt.test.mjs — TST-29 (долг: аннуитет, график, последний платёж), TST-30 (рассрочка: дробление покупки), TST-51/53 (фаззинг и оракул графика).
// Числа — design-brief §9.12, ALG-09 TV-1…TV-6 (TV-5, TV-6 — v2: prepay, reanchor), C-039, C-040, C-041. Ожидаемые значения не подгонялись под код.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  annuity_payment, amortization_schedule, installment_parts, validate_debt, schedule_to_events, reanchor, prepay,
} from '../engine/debt.mjs';
import { parse_date, format_date, add_months } from '../engine/dates.mjs';
import { split_equal } from '../engine/money.mjs';
import { make_rng, throws_code } from './helpers.mjs';

const d = parse_date;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const col = (rows, k) => rows.map((r) => r[k]);

/** Эталон деления с округлением (BigInt) — независимая от money.mjs реализация, half_even / half_up. */
function oracle_div(n, dd, mode) {
  let q = n / dd;
  let r = n % dd;
  if (r < 0n) { q -= 1n; r += dd; }
  const t = 2n * r;
  if (t < dd) return q;
  if (t > dd) return q + 1n;
  if (mode === 'half_up') return n >= 0n ? q + 1n : q;
  return q % 2n === 0n ? q : q + 1n;
}

const P1200 = { principal: 120000, rate_bp: 1200, n: 6, start: d('2026-11-01'), kind: 'annuity' };

// ── TST-29: аннуитет ───────────────────────────────────────────────────────────

test('TST-29 аннуитет: 120000, 12 % годовых (1 %/мес), 6 платежей → A = 20706; платежи [20706 ×5, 20705]', () => {
  assert.equal(annuity_payment(120000, 1200, 6), 20706, 'A_real = 20705,8');
  const rows = amortization_schedule(P1200);
  assert.deepEqual(col(rows, 'payment_minor'), [20706, 20706, 20706, 20706, 20706, 20705]);
  assert.deepEqual(col(rows, 'interest_minor'), [1200, 1005, 808, 609, 408, 205], 'проценты 1200, 1005 (1004,94), 808 (807,93), 609 (608,95), 408 (407,98), 205');
  assert.deepEqual(col(rows, 'principal_minor'), [19506, 19701, 19898, 20097, 20298, 20500]);
  assert.deepEqual(col(rows, 'balance_minor'), [100494, 80793, 60895, 40798, 20500, 0], 'остаток после платежа k');
  assert.deepEqual(col(rows, 'k'), [1, 2, 3, 4, 5, 6]);
  assert.equal(sum(col(rows, 'interest_minor')), 4235);
  assert.equal(sum(col(rows, 'payment_minor')), 5 * 20706 + 20705);
  assert.equal(sum(col(rows, 'payment_minor')), 120000 + 4235, 'Σ платежи = долг + Σ проценты');
  assert.deepEqual(col(rows, 'date').map(format_date), ['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01', '2027-03-01', '2027-04-01']);
  for (const r of rows) assert.equal(r.payment_minor, r.principal_minor + r.interest_minor);
});

test('TST-29 аннуитет: start как IsoDate; даты от start без дрейфа (31-е: 01-31 → 02-28 → 03-31); rounding half_up допустим', () => {
  const a = amortization_schedule({ ...P1200, start: '2026-11-01' });
  assert.deepEqual(a, amortization_schedule(P1200), 'IsoDate и EpochDay дают одно и то же');
  const rows = amortization_schedule({ ...P1200, start: d('2026-01-31'), n: 4 });
  assert.deepEqual(col(rows, 'date').map(format_date), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  assert.deepEqual(amortization_schedule({ ...P1200, rounding: 'half_up' }).map((r) => r.balance_minor).at(-1), 0);
  // двусмысленный cadence — только раз в месяц (v1.1)
  throws_code(() => amortization_schedule({ ...P1200, cadence: { freq: 'W', interval: 1 } }), 'E_SCHEMA');
  throws_code(() => amortization_schedule({ ...P1200, cadence: { freq: 'M', interval: 2 } }), 'E_SCHEMA');
  assert.deepEqual(amortization_schedule({ ...P1200, cadence: { freq: 'M', interval: 1 } }), amortization_schedule(P1200));
  // режимы floor/ceil для графика не допускаются (N9)
  throws_code(() => amortization_schedule({ ...P1200, rounding: 'floor' }), 'E_SCHEMA');
  throws_code(() => annuity_payment(120000, 1200, 6, 'ceil'), 'E_SCHEMA');
});

test('TST-29 дифференцированный (ALG-09 TV-2): части долга 20000 ×6, проценты 1200…200 (Σ 4200), платежи 21200…20200', () => {
  const rows = amortization_schedule({ ...P1200, kind: 'differential' });
  assert.deepEqual(col(rows, 'principal_minor'), [20000, 20000, 20000, 20000, 20000, 20000]);
  assert.deepEqual(col(rows, 'interest_minor'), [1200, 1000, 800, 600, 400, 200]);
  assert.deepEqual(col(rows, 'payment_minor'), [21200, 21000, 20800, 20600, 20400, 20200]);
  assert.deepEqual(col(rows, 'balance_minor'), [100000, 80000, 60000, 40000, 20000, 0]);
  assert.equal(sum(col(rows, 'interest_minor')), 4200);
});

test('TST-29 ALG-09 TV-4: дорожка 300,00 € в кредит — P 30000, 1 %/мес, n = 6, start 2026-11-12 → A = 5176, последний 5178', () => {
  const rows = amortization_schedule({ principal: 30000, rate_bp: 1200, n: 6, start: d('2026-11-12'), kind: 'annuity' });
  assert.deepEqual(rows.map((r) => [r.payment_minor, r.interest_minor, r.balance_minor]), [
    [5176, 300, 25124], [5176, 251, 20199], [5176, 202, 15225], [5176, 152, 10201], [5176, 102, 5127], [5178, 51, 0],
  ]);
  assert.equal(sum(col(rows, 'interest_minor')), 1058);
  assert.equal(sum(col(rows, 'payment_minor')), 31058);
  assert.equal(format_date(rows[0].date), '2026-11-12');
});

test('TST-29 ограничения (C-041): 1 ≤ n ≤ 600, 0 ≤ rate_bp ≤ 100000, P ≥ n для annuity/differential, installment_0 ⇒ rate_bp = 0', () => {
  assert.equal(validate_debt(120000, 1200, 6, 'annuity'), undefined);
  throws_code(() => validate_debt(120000, 1200, 0, 'annuity'), 'E_SCHEMA');
  throws_code(() => validate_debt(120000, 1200, 601, 'annuity'), 'E_SCHEMA');
  throws_code(() => validate_debt(120000, -1, 6, 'annuity'), 'E_SCHEMA');
  throws_code(() => validate_debt(120000, 100001, 6, 'annuity'), 'E_SCHEMA');
  throws_code(() => validate_debt(5, 1200, 6, 'annuity'), 'E_SCHEMA', 'P < n');
  throws_code(() => validate_debt(5, 1200, 6, 'differential'), 'E_SCHEMA');
  throws_code(() => validate_debt(0, 0, 1, 'installment_0'), 'E_SCHEMA', 'P ≥ 1');
  throws_code(() => validate_debt(100, 100, 6, 'installment_0'), 'E_SCHEMA');
  throws_code(() => validate_debt(100, 0, 6, 'loan'), 'E_SCHEMA');
  throws_code(() => validate_debt(100.5, 0, 6, 'installment_0'), 'E_NOT_INTEGER');
  assert.equal(validate_debt(5, 0, 6, 'installment_0'), undefined, 'рассрочка допускает total < n');
  assert.equal(validate_debt(1_000_000, 100000, 600, 'annuity'), undefined);
  assert.equal(annuity_payment(5, 0, 5), 1);
  // граничные значения n и ставки
  assert.equal(amortization_schedule({ principal: 1000, rate_bp: 100000, n: 1, start: 0, kind: 'annuity' })[0].payment_minor, 1000 + 833, 'n = 1: P + проценты периода (83,33 → 833)');
  assert.equal(amortization_schedule({ principal: 10_000_000, rate_bp: 1200, n: 600, start: 0, kind: 'annuity' }).at(-1).balance_minor, 0);
  throws_code(() => annuity_payment(Number.MAX_SAFE_INTEGER, 100000, 1), 'E_OVERFLOW');
});

test('TST-29 аннуитет при rate_bp = 0 трактуется как installment_0 (split_equal); ceil_div как платёж', () => {
  assert.equal(annuity_payment(120000, 0, 7), 17143, 'ceil_div(120000, 7) — наибольшая часть split_equal');
  const a = amortization_schedule({ principal: 120000, rate_bp: 0, n: 7, start: 0, kind: 'annuity' });
  const b = amortization_schedule({ principal: 120000, rate_bp: 0, n: 7, start: 0, kind: 'installment_0' });
  assert.deepEqual(a, b);
  assert.deepEqual(col(a, 'payment_minor'), split_equal(120000, 7));
  assert.ok(a.every((r) => r.interest_minor === 0));
});

// ── TST-30: рассрочка ──────────────────────────────────────────────────────────

test('TST-30 installment_parts(110000, 6) = [18334, 18334, 18333, 18333, 18333, 18333], Σ 110000; части различаются ≤ 1 и не возрастают', () => {
  const parts = installment_parts(110000, 6);
  assert.deepEqual(parts, [18334, 18334, 18333, 18333, 18333, 18333]);
  assert.equal(sum(parts), 110000);
  assert.deepEqual(installment_parts(30000, 7), [4286, 4286, 4286, 4286, 4286, 4285, 4285]);
  assert.deepEqual(installment_parts(2, 5), [1, 1, 0, 0, 0], 'total < n: части 0 допустимы');
  assert.deepEqual(installment_parts(777, 1), [777]);
  throws_code(() => installment_parts(0, 3), 'E_SCHEMA');
  throws_code(() => installment_parts(100, 0), 'E_SCHEMA');
  throws_code(() => installment_parts(10.5, 2), 'E_NOT_INTEGER');
});

test('TST-30 ALG-09 TV-3: рассрочка G-001 1 100,00 € без процентов — 6 частей с 2026-11-01, в горизонте 57 дн. только первая (beyond_horizon_minor = 91666)', () => {
  const rows = amortization_schedule({ principal: 110000, rate_bp: 0, n: 6, start: d('2026-11-01'), kind: 'installment_0' });
  assert.deepEqual(col(rows, 'payment_minor'), installment_parts(110000, 6));
  assert.deepEqual(col(rows, 'date').map(format_date), ['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01', '2027-03-01', '2027-04-01']);
  assert.ok(rows.every((r) => r.interest_minor === 0));
  const horizon_end = d('2026-11-30');
  const within = rows.filter((r) => r.date <= horizon_end);
  assert.deepEqual(col(within, 'payment_minor'), [18334]);
  assert.equal(sum(col(rows.filter((r) => r.date > horizon_end), 'payment_minor')), 91666, 'beyond_horizon_minor: 5 из 6 платежей, 83 % суммы');
  assert.equal(Math.round(91666 / 1100), 83);
  // вариант: первый платёж 2026-11-12 (иллюстрация TST-30)
  const alt = amortization_schedule({ principal: 110000, rate_bp: 0, n: 6, start: d('2026-11-12'), kind: 'installment_0' });
  assert.equal(alt.filter((r) => r.date <= horizon_end).length, 1);
  assert.equal(sum(col(alt.filter((r) => r.date > horizon_end), 'payment_minor')), 91666);
  // total < n у рассрочки допустим, события с нулём не создаются
  const tiny = amortization_schedule({ principal: 2, rate_bp: 0, n: 5, start: 0, kind: 'installment_0' });
  assert.deepEqual(col(tiny, 'payment_minor'), [1, 1, 0, 0, 0]);
});

// ── schedule_to_events ─────────────────────────────────────────────────────────

test('schedule_to_events: плановые платежи — расход с платёжного счёта, is_obligation, дата договорная (без сдвига выходных), нулевые строки пропущены', () => {
  const schedule = amortization_schedule(P1200);
  const debt = { debt_id: 'DBT-1', account_id: 'acc_debt', pay_account_id: 'acc_main', currency: 'EUR', kind: 'annuity', principal_minor: 120000, rate_bp: 1200, n: 6, start_date: '2026-11-01', schedule };
  const evs = schedule_to_events(debt);
  assert.equal(evs.length, 6);
  assert.deepEqual(evs.map((e) => e.amount_minor), [-20706, -20706, -20706, -20706, -20706, -20705]);
  assert.deepEqual(evs.map((e) => format_date(e.date)), ['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01', '2027-03-01', '2027-04-01'], '2026-11-01 — воскресенье, не сдвигается');
  const e = evs[0];
  assert.equal(e.cash_event_id, 'DBT-1@2026-11-01');
  assert.equal(e.occ_key, e.cash_event_id);
  assert.deepEqual([e.layer, e.status, e.kind, e.tag, e.account_id, e.currency], ['planned', 'expected', 'expense', 'debt', 'acc_main', 'EUR']);
  assert.deepEqual([e.is_obligation, e.is_estimate, e.is_exceptional, e.rule_id], [true, false, false, null]);
  // без сохранённого графика — расчёт по полям плана; даты строк могут быть IsoDate
  const noschedule = { ...debt, schedule: undefined };
  assert.deepEqual(schedule_to_events(noschedule), evs);
  const iso = { ...debt, schedule: schedule.map((r) => ({ ...r, date: format_date(r.date) })) };
  assert.deepEqual(schedule_to_events(iso), evs);
  // рассрочка с нулевой частью: событие не создаётся
  const tiny = { debt_id: 'I', pay_account_id: 'a', currency: 'EUR', kind: 'installment_0', principal_minor: 2, rate_bp: 0, n: 5, start_date: '2026-11-01' };
  assert.equal(schedule_to_events(tiny).length, 2);
  // перенос одного платежа — правка даты строки графика: id следует за датой
  const moved = { ...debt, schedule: schedule.map((r, i) => (i === 1 ? { ...r, date: d('2026-12-04') } : r)) };
  assert.equal(schedule_to_events(moved)[1].cash_event_id, 'DBT-1@2026-12-04');
});

// ── v2: досрочное погашение и ре-якорение ──────────────────────────────────────

const DEBT = { debt_id: 'DBT-1', pay_account_id: 'acc_main', currency: 'EUR', kind: 'annuity', principal_minor: 120000, rate_bp: 1200, n: 6, start_date: '2026-11-01', schedule: amortization_schedule(P1200) };

test('TST-29 v2 / ALG-09 TV-5: досрочное 30000 после платежа 2 — shorten: 20706/508/30595, 20706/306/10195, 10297/102/0 (проценты 916 против 2030)', () => {
  const s = prepay(DEBT, 30000, d('2026-12-01'), 'shorten');
  assert.deepEqual(s.slice(0, 2), DEBT.schedule.slice(0, 2), 'выполненные строки не меняются');
  assert.deepEqual(s.slice(2).map((r) => [r.k, r.payment_minor, r.interest_minor, r.balance_minor]), [[3, 20706, 508, 30595], [4, 20706, 306, 10195], [5, 10297, 102, 0]]);
  assert.deepEqual(s.slice(2).map((r) => format_date(r.date)), ['2027-01-01', '2027-02-01', '2027-03-01']);
  assert.equal(sum(col(s.slice(2), 'interest_minor')), 916);
  assert.equal(sum(DEBT.schedule.slice(2).map((r) => r.interest_minor)), 808 + 609 + 408 + 205, 'прежние проценты хвоста 2030');
  assert.ok(s.length <= DEBT.schedule.length, 'платежей не больше исходного');
});

test('TST-29 v2: lower_payment (n = 4) — A′ = 13017: 13017/508/38284, 13017/383/25650, 13017/256/12889, 13018/129/0 (проценты 1276)', () => {
  const s = prepay(DEBT, 30000, d('2026-12-01'), 'lower_payment');
  assert.equal(s.length, DEBT.schedule.length, 'число платежей то же');
  assert.deepEqual(s.slice(2).map((r) => [r.k, r.payment_minor, r.interest_minor, r.balance_minor]), [[3, 13017, 508, 38284], [4, 13017, 383, 25650], [5, 13017, 256, 12889], [6, 13018, 129, 0]]);
  assert.equal(sum(col(s.slice(2), 'interest_minor')), 1276);
  assert.ok(s.slice(2, -1).every((r) => r.payment_minor <= 20706), 'платёж ≤ A');
  assert.deepEqual(s.slice(2).map((r) => format_date(r.date)), ['2027-01-01', '2027-02-01', '2027-03-01', '2027-04-01']);
});

test('v2 prepay: полное погашение (amount = остатку) — график заканчивается на этой строке; ошибки', () => {
  const full = prepay(DEBT, 80793, d('2026-12-01'), 'shorten');
  assert.equal(full.length, 2);
  assert.equal(full[1].balance_minor, 80793, 'строка платежа не переписывается: остаток закрыт досрочным взносом');
  throws_code(() => prepay(DEBT, 80794, d('2026-12-01'), 'shorten'), 'E_SCHEMA', 'переплата');
  throws_code(() => prepay(DEBT, 0, d('2026-12-01'), 'shorten'), 'E_SCHEMA');
  throws_code(() => prepay(DEBT, 100, d('2026-12-02'), 'shorten'), 'E_SCHEMA', 'между платежами — вне модели');
  throws_code(() => prepay(DEBT, 100, d('2027-04-01'), 'shorten'), 'E_SCHEMA', 'последний платёж');
  throws_code(() => prepay(DEBT, 100, d('2026-12-01'), 'other'), 'E_SCHEMA');
  // платёж не покрывает проценты — E_SCHEMA (долг не гасится)
  const poor = { ...DEBT, schedule: DEBT.schedule.map((r, i) => (i === 0 ? { ...r, payment_minor: 100 } : r)), kind: 'annuity' };
  throws_code(() => prepay(poor, 100, d('2026-12-01'), 'shorten'), 'E_SCHEMA');
  // differential: shorten фиксирует часть долга следующей строки
  const dd = { ...DEBT, kind: 'differential', schedule: amortization_schedule({ ...P1200, kind: 'differential' }) };
  const s = prepay(dd, 30000, d('2026-12-01'), 'shorten');
  assert.deepEqual(col(s.slice(2), 'principal_minor'), [20000, 20000, 10000]);
});

test('TST-29 v2 / ALG-09 TV-6: ре-якорение после платежа 2 — банк 80900 против 80793: drift +107, хвост n = 4 от 2027-01-01: A′ = 20733', () => {
  const r = reanchor(DEBT, 2, 80900);
  assert.equal(r.drift, 107);
  assert.deepEqual(r.schedule.slice(0, 2), DEBT.schedule.slice(0, 2));
  assert.deepEqual(r.schedule.slice(2).map((x) => [x.k, x.payment_minor, x.interest_minor, x.balance_minor]), [[3, 20733, 809, 60976], [4, 20733, 610, 40853], [5, 20733, 409, 20529], [6, 20734, 205, 0]]);
  assert.deepEqual(r.schedule.slice(2).map((x) => format_date(x.date)), ['2027-01-01', '2027-02-01', '2027-03-01', '2027-04-01']);
  assert.equal(r.schedule.length, DEBT.schedule.length, 'срок не меняется');
  // совпадение с моделью → дрейф 0, хвост пересчитан тем же графиком
  const same = reanchor(DEBT, 2, 80793);
  assert.equal(same.drift, 0);
  assert.deepEqual(same.schedule, DEBT.schedule);
  // долг закрыт (observed ≤ 0) — хвост пуст; k = n — только дрейф
  assert.deepEqual(reanchor(DEBT, 3, 0).schedule, DEBT.schedule.slice(0, 3));
  assert.equal(reanchor(DEBT, 3, -5).drift, -5 - 60895);
  const last = reanchor(DEBT, 6, 77);
  assert.deepEqual([last.drift, last.schedule.length], [77, 6]);
  throws_code(() => reanchor(DEBT, 0, 100), 'E_SCHEMA');
  throws_code(() => reanchor(DEBT, 7, 100), 'E_SCHEMA');
});

// ── TST-51/53: свойства и оракул графика ───────────────────────────────────────

test('TST-53 оракул аннуитета: A против вещественной формулы (±0,5), проценты — BigInt-оракул, инварианты 1–5, 7 ALG-09 (1 500 случаев)', () => {
  const rng = make_rng(2029);
  let checked = 0;
  let over_n = 0;
  for (let it = 0; it < 1500; it++) {
    const n = rng.int(1, 60);
    const rate = rng.int(1, 2400);
    const P = rng.int(n, 5_000_000);
    const mode = rng.pick(['half_even', 'half_up']);
    let rows;
    try {
      rows = amortization_schedule({ principal: P, rate_bp: rate, n, start: d('2026-11-01'), kind: 'annuity', rounding: mode });
    } catch (e) {
      assert.equal(e.code, 'E_SCHEMA', 'вырожденный график — только E_SCHEMA');
      continue;
    }
    checked += 1;
    const A = annuity_payment(P, rate, n, mode);
    const i = rate / 120000;
    const A_real = P * i / (1 - (1 + i) ** -n);
    assert.ok(Math.abs(A - A_real) <= 0.5 + 1e-6 * A_real, `A=${A}, вещественная формула ${A_real}`);
    // 1: Σ principal = P, balance_n = 0, баланс убывает
    assert.equal(sum(col(rows, 'principal_minor')), P);
    assert.equal(rows.at(-1).balance_minor, 0);
    rows.forEach((r, k) => assert.ok(r.balance_minor < (k === 0 ? P : rows[k - 1].balance_minor) || r.principal_minor === 0));
    // 2: Σ payment = P + Σ interest
    assert.equal(sum(col(rows, 'payment_minor')), P + sum(col(rows, 'interest_minor')));
    // 3: платежи k < n равны A; последний отличается от A на накопленное округление. Гипотеза ALG-09 «не более n minor» ОПРОВЕРГНУТА
    // контрпримером (n = 57, 2308 bp, P = 3202400: 59 > 57), поэтому проверяется строгая граница накопления ошибки
    // ((1+i)^n − 1)/i · (1+i) + 1 (ошибка A ≤ 0,5 и ошибки округления процентов ≤ 0,5 растут со сложным процентом).
    rows.slice(0, -1).forEach((r) => assert.equal(r.payment_minor, A));
    const gap = Math.abs(rows.at(-1).payment_minor - A);
    const bound = Math.ceil(((1 + i) ** n - 1) / i * (1 + i)) + 1;
    assert.ok(gap <= bound, `последний платёж ${rows.at(-1).payment_minor} против A=${A}: разница ${gap} > ${bound}`);
    if (gap > n) over_n += 1;
    // 4: interest_k = round(balance_{k−1}·rate_bp/120000), оракул на BigInt
    rows.forEach((r, k) => {
      const bal = k === 0 ? P : rows[k - 1].balance_minor;
      assert.equal(r.interest_minor, Number(oracle_div(BigInt(bal) * BigInt(rate), 120000n, mode)));
    });
    // 5: даты строго возрастают, date_k = add_months(start, k−1)
    rows.forEach((r, k) => assert.equal(r.date, add_months(d('2026-11-01'), k)));
  }
  assert.ok(checked > 1000, 'большинство случайных графиков корректны: ' + checked);
  assert.ok(over_n <= 0.01 * checked, `разница последнего платежа больше n minor лишь в редких случаях: ${over_n} из ${checked}`);
});

test('TST-51 свойства: сумма процентов монотонно растёт со ставкой; дифференцированный и рассрочка закрываются в 0; части рассрочки не возрастают (800 случаев)', () => {
  const rng = make_rng(31);
  for (let it = 0; it < 800; it++) {
    const n = rng.int(2, 48);
    const P = rng.int(n, 2_000_000);
    const r1 = rng.int(1, 1500);
    const r2 = r1 + rng.int(1, 900);
    const tot = (rate) => sum(col(amortization_schedule({ principal: P, rate_bp: rate, n, start: 0, kind: 'differential' }), 'interest_minor'));
    assert.ok(tot(r1) <= tot(r2), 'проценты не убывают со ставкой');
    const diff = amortization_schedule({ principal: P, rate_bp: r1, n, start: 0, kind: 'differential' });
    assert.equal(diff.at(-1).balance_minor, 0);
    assert.equal(sum(col(diff, 'principal_minor')), P);
    const parts = installment_parts(P, n);
    assert.equal(sum(parts), P);
    assert.ok(parts.every((p, k) => k === 0 || p <= parts[k - 1]));
    assert.ok(parts[0] - parts.at(-1) <= 1);
    assert.deepEqual(parts, split_equal(P, n), 'оракул split_equal');
  }
});

test('TST-53 детерминизм: график не зависит от вызова (чистая функция) и не мутирует вход; prepay/reanchor не меняют debt', () => {
  const before = JSON.stringify(DEBT);
  const a = amortization_schedule(P1200);
  const b = amortization_schedule({ ...P1200 });
  assert.deepEqual(a, b);
  prepay(DEBT, 30000, d('2026-12-01'), 'shorten');
  prepay(DEBT, 30000, d('2026-12-01'), 'lower_payment');
  reanchor(DEBT, 2, 80900);
  assert.equal(JSON.stringify(DEBT), before, 'вход не изменён');
});
