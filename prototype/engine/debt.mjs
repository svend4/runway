// debt.mjs — долги и рассрочки: аннуитет, график, дробление покупки (ALG-09).
// Канон: design-brief §3.8 (DebtPlan), §9.12, C-039, C-040, C-041, §14 N9; canon-decisions «Финальные сигнатуры» (debt.mjs);
// wiki/algorithms/alg-09-debt-amortization.md; ADR-002 (деньги).
// Зависимости: money, dates. Чистые функции: только целые, BigInt — в `annuity_payment` (u^n) и внутри `mul_div`/`round_div`.
// Период — месяц; `rate_bp` — годовая номинальная ставка; ставка периода `rate_bp / 120000` (12·10^4: bp → доля, год → 12 месяцев).
// График по модели не равен договору банка (дни, комиссии, плавающая ставка); это расчёт по введённым данным, не консультация.

import { fail, assert_minor, round_div, mul_div, ceil_div, split_equal } from './money.mjs';
import { add_months, format_date, to_epoch_day } from './dates.mjs';

/** @typedef {import('./money.mjs').Minor} Minor */
/** @typedef {import('./money.mjs').RoundMode} RoundMode */
/** @typedef {import('./dates.mjs').EpochDay} EpochDay */
/**
 * Строка графика.
 * @typedef {object} DebtRow
 * @property {number} k номер платежа (с 1)
 * @property {EpochDay} date
 * @property {Minor} payment_minor `principal_minor + interest_minor`
 * @property {Minor} interest_minor
 * @property {Minor} principal_minor
 * @property {Minor} balance_minor остаток долга после платежа
 */
/**
 * План долга `DebtPlan` (design-brief §3.8, C-039).
 * @typedef {object} DebtPlan
 * @property {string} debt_id
 * @property {string} [account_id] счёт долга (`liquidity = debt`, справочный)
 * @property {string} pay_account_id operating-счёт платежей
 * @property {string} currency валюта долга = валюте платёжного счёта
 * @property {'annuity'|'differential'|'installment_0'} kind
 * @property {Minor} principal_minor остаток долга
 * @property {number} rate_bp
 * @property {number} n
 * @property {EpochDay|string} start_date дата первого неоплаченного платежа
 * @property {{freq: 'M', interval: 1}} [cadence]
 * @property {DebtRow[]} [schedule]
 */

const KINDS = ['annuity', 'differential', 'installment_0'];
const ROUNDINGS = ['half_even', 'half_up']; // N9: допустимые режимы графика
const MAX_N = 600;
const MAX_RATE_BP = 100000;
/** Знаменатель ставки периода: rate_bp / 120000 = (rate_bp / 10000) / 12. */
const RATE_DEN = 120000;

function check_rounding(rounding) {
  if (!ROUNDINGS.includes(rounding)) fail('E_SCHEMA', { reason: 'rounding_half_even_or_half_up', value: String(rounding) });
  return rounding;
}

/**
 * Проверка параметров долга (C-041): `P ≥ 1`, `1 ≤ n ≤ 600`, `0 ≤ rate_bp ≤ 100000`; `installment_0` ⇒ `rate_bp = 0`;
 * для `annuity`/`differential` дополнительно `P ≥ n` (нет нулевых частей долга).
 * @param {Minor} P остаток долга
 * @param {number} rate_bp
 * @param {number} n
 * @param {'annuity'|'differential'|'installment_0'} kind
 * @returns {void}
 * @throws {RunwayError} E_SCHEMA (нарушено ограничение), E_NOT_INTEGER, E_OVERFLOW
 */
export function validate_debt(P, rate_bp, n, kind) {
  const p = assert_minor(P);
  const r = assert_minor(rate_bp);
  const nn = assert_minor(n);
  if (!KINDS.includes(kind)) fail('E_SCHEMA', { reason: 'unknown_debt_kind', value: String(kind) });
  if (p < 1) fail('E_SCHEMA', { reason: 'principal_lt_1', value: p });
  if (nn < 1 || nn > MAX_N) fail('E_SCHEMA', { reason: 'n_out_of_1_600', value: nn });
  if (r < 0 || r > MAX_RATE_BP) fail('E_SCHEMA', { reason: 'rate_bp_out_of_0_100000', value: r });
  if (kind === 'installment_0' && r !== 0) fail('E_SCHEMA', { reason: 'installment_needs_zero_rate', value: r });
  if (kind !== 'installment_0' && p < nn) fail('E_SCHEMA', { reason: 'principal_lt_n', principal: p, n: nn });
}

/**
 * Платёж аннуитета: `A = round_div(P·r·u^n, 120000·(u^n − 120000^n))`, `u = 120000 + r` (BigInt).
 * При `rate_bp = 0` — `ceil_div(P, n)` (наибольшая часть `split_equal`).
 * @param {Minor} principal
 * @param {number} rate_bp годовая ставка в bp
 * @param {number} n число платежей
 * @param {RoundMode} [rounding] `half_even` (по умолчанию) или `half_up`
 * @returns {Minor}
 * @throws {RunwayError} E_SCHEMA (ограничения C-041), E_OVERFLOW (результат не safe-integer)
 */
export function annuity_payment(principal, rate_bp, n, rounding = 'half_even') {
  validate_debt(principal, rate_bp, n, 'annuity');
  check_rounding(rounding);
  if (rate_bp === 0) return ceil_div(principal, n);
  const u = BigInt(RATE_DEN + rate_bp);
  const un = u ** BigInt(n);
  const dn = BigInt(RATE_DEN) ** BigInt(n);
  return round_div(BigInt(principal) * BigInt(rate_bp) * un, BigInt(RATE_DEN) * (un - dn), rounding);
}

/**
 * Дробление суммы на части без процентов (рассрочка 0 %, REQ-044): `split_equal`, первые части получают лишние minor.
 * @param {Minor} total ≥ 1
 * @param {number} n ≥ 1
 * @returns {Minor[]} Σ = total
 * @throws {RunwayError} E_SCHEMA
 */
export function installment_parts(total, n) {
  const t = assert_minor(total);
  const nn = assert_minor(n);
  if (t < 1 || nn < 1) fail('E_SCHEMA', { reason: 'total_or_n_lt_1', total: t, n: nn });
  return split_equal(t, nn);
}

/**
 * График платежей. `kind = annuity` при `rate_bp = 0` трактуется как `installment_0`. Проценты округляются на каждом шаге;
 * последний платёж поглощает остаток округлений (баланс закрывается ровно в 0); основная часть аннуитета зажата в `[1, остаток − (n − k)]`
 * (малые долги / высокие ставки: накопленная ошибка округления `A` не даёт нулевых и «лишних» строк). Даты — `add_months(start, k−1)` без дрейфа.
 * @param {{principal: Minor, rate_bp: number, n: number, start: EpochDay|string, cadence?: {freq: string, interval: number}, kind: 'annuity'|'differential'|'installment_0', rounding?: RoundMode}} p
 * @returns {DebtRow[]}
 * @throws {RunwayError} E_SCHEMA (ограничения, вырожденный график, `cadence` ≠ раз в месяц)
 */
export function amortization_schedule({ principal, rate_bp, n, start, cadence, kind, rounding = 'half_even' }) {
  const cad = cadence ?? { freq: 'M', interval: 1 };
  if (cad.freq !== 'M' || cad.interval !== 1) fail('E_SCHEMA', { reason: 'only_monthly_cadence_in_v1_1', freq: String(cad.freq), interval: String(cad.interval) });
  check_rounding(rounding);
  const kd = kind === 'annuity' && rate_bp === 0 ? 'installment_0' : kind; // 0 % — это рассрочка
  validate_debt(principal, rate_bp, n, kd);
  const start_day = to_epoch_day(start);
  const A = kd === 'annuity' ? annuity_payment(principal, rate_bp, n, rounding) : null;
  const parts = kd !== 'annuity' ? split_equal(principal, n) : null; // дифф.: части долга; рассрочка: части платежа
  let bal = principal;
  const rows = [];
  for (let k = 1; k <= n; k++) {
    const interest = kd === 'installment_0' ? 0 : mul_div(bal, rate_bp, RATE_DEN, rounding);
    let p;
    if (k === n) p = bal; // последний платёж поглощает остаток округлений
    else if (kd === 'annuity') {
      // Платёж A округлён и один для всех строк, поэтому на малых долгах и высоких ставках ошибка округления накапливается:
      // основная часть выходит ≤ 0 или съедает остаток раньше срока. Зажимаем её в [1, bal − (n − k)]: каждой оставшейся строке
      // достаётся хотя бы 1 minor (P ≥ n, validate_debt), баланс убывает строго и закрывается ровно в 0 на последнем платеже.
      // В недегенеративных графиках (основная часть уже внутри границ) зажим ничего не меняет.
      p = Math.min(Math.max(A - interest, 1), bal - (n - k));
    } else p = parts[k - 1];
    if (p < 0 || p > bal) fail('E_SCHEMA', { reason: 'degenerate_schedule', k, principal_part: p, balance: bal });
    bal -= p;
    rows.push({ k, date: add_months(start_day, k - 1), payment_minor: p + interest, interest_minor: interest, principal_minor: p, balance_minor: bal });
  }
  return rows;
}

/** График плана: сохранённый `debt.schedule` либо расчёт по полям плана. */
function schedule_of(debt) {
  if (Array.isArray(debt.schedule)) return debt.schedule.map((r) => ({ ...r, date: to_epoch_day(r.date) }));
  return amortization_schedule({
    principal: debt.principal_minor, rate_bp: debt.rate_bp, n: debt.n, start: debt.start_date, cadence: debt.cadence, kind: debt.kind,
    rounding: debt.rounding ?? 'half_even',
  });
}

/** Плановое обязательство графика долга: расход `−amount_minor` с платёжного счёта (общая форма платежа и досрочного погашения). */
function debt_event(debt, row, id, amount_minor) {
  return {
    cash_event_id: id,
    layer: 'planned',
    status: 'expected',
    account_id: debt.pay_account_id,
    date: row.date,
    amount_minor: -amount_minor,
    currency: debt.currency,
    kind: 'expense',
    tag: 'debt',
    rule_id: null,
    occ_key: id,
    is_obligation: true,
    is_estimate: false,
    is_exceptional: false,
  };
}

/**
 * Плановые события платежей по графику (C-039): расход `−payment_minor` с платёжного счёта, `is_obligation = true`.
 * Сдвиг выходных не применяется: дата договорная; перенос одного платежа — правка даты строки графика.
 * Проверка «валюта платёжного счёта = `debt.currency`» (`E_CURRENCY_MISMATCH`) выполняется при записи `debt.set`:
 * у функции нет второго аргумента с счетами (C-039).
 * Необязательное поле строки `extra_minor` (FP-14, REQ-083: записанное досрочное погашение) даёт второе обязательство в тот же день с
 * идентификатором `<debt_id>@<дата>#extra`: деньги, внесённые сверх платежа, уходят со счёта, а не только укорачивают хвост графика.
 * Строки без `extra_minor` ведут себя как прежде.
 * @param {DebtPlan} debt
 * @returns {object[]} CashEvent[] (по `k`; строки с платежом 0 пропускаются)
 * @throws {RunwayError} E_NOT_INTEGER, E_OVERFLOW (нецелое `extra_minor`)
 */
export function schedule_to_events(debt) {
  const out = [];
  for (const row of schedule_of(debt)) {
    const id = debt.debt_id + '@' + format_date(row.date);
    if (row.payment_minor > 0) out.push(debt_event(debt, row, id, row.payment_minor));
    const extra = row.extra_minor === undefined || row.extra_minor === null ? 0 : assert_minor(row.extra_minor);
    if (extra > 0) out.push(debt_event(debt, row, id + '#extra', extra));
  }
  return out;
}

/**
 * Хвост графика при фиксированном платеже/части долга (для `prepay: shorten`). Платёж не покрывает проценты — `E_SCHEMA`.
 * @param {Minor} bal
 * @param {number} rate_bp
 * @param {'annuity'|'differential'|'installment_0'} kind
 * @param {Minor} fixed платёж (annuity) или часть долга (остальные)
 * @param {EpochDay} start дата первой строки хвоста
 * @param {number} k0 число уже выполненных платежей
 * @param {RoundMode} rounding
 * @returns {DebtRow[]}
 */
function tail_fixed(bal, rate_bp, kind, fixed, start, k0, rounding) {
  const rows = [];
  let b = bal;
  for (let j = 1; b > 0; j++) {
    const i = mul_div(b, rate_bp, RATE_DEN, rounding);
    const p = kind === 'annuity' ? Math.min(fixed - i, b) : Math.min(fixed, b);
    if (p <= 0) fail('E_SCHEMA', { reason: 'payment_does_not_cover_interest', interest: i, fixed });
    b -= p;
    rows.push({ k: k0 + j, date: add_months(start, j - 1), payment_minor: p + i, interest_minor: i, principal_minor: p, balance_minor: b });
  }
  return rows;
}

/** Сдвинуть номера строк графика на `k0`. */
function shift_k(rows, k0) {
  return rows.map((r) => ({ ...r, k: r.k + k0 }));
}

/**
 * v2. Досрочное погашение — только в день платежа (проценты между платежами вне модели).
 * `shorten` — платёж/часть долга прежние, срок короче; `lower_payment` — срок прежний, платёж ниже.
 * @param {DebtPlan} debt
 * @param {Minor} amount вносимая сумма (> 0, ≤ остатка после платежа в этот день)
 * @param {EpochDay|string} date дата строки графика
 * @param {'shorten'|'lower_payment'} option
 * @returns {DebtRow[]} новый график (выполненные строки + хвост)
 * @throws {RunwayError} E_SCHEMA (дата не совпала с платежом, последний платёж, сумма вне 1…остаток, платёж не покрывает проценты)
 */
export function prepay(debt, amount, date, option) {
  const sched = schedule_of(debt);
  const rounding = check_rounding(debt.rounding ?? 'half_even');
  const d = to_epoch_day(date);
  const idx = sched.findIndex((r) => r.date === d);
  const k = idx + 1;
  if (idx < 0 || k === sched.length) fail('E_SCHEMA', { reason: 'prepay_only_on_payment_date_before_last', date: format_date(d) });
  const amt = assert_minor(amount);
  const bal = sched[idx].balance_minor - amt;
  if (amt <= 0 || bal < 0) fail('E_SCHEMA', { reason: 'prepay_amount_out_of_range', amount: amt, balance: sched[idx].balance_minor });
  if (option !== 'shorten' && option !== 'lower_payment') fail('E_SCHEMA', { reason: 'unknown_prepay_option', value: String(option) });
  const done = sched.slice(0, k);
  if (bal === 0) return done; // погашено полностью
  const next = sched[k];
  if (option === 'shorten') {
    const fixed = debt.kind === 'annuity' ? sched[0].payment_minor : next.principal_minor;
    return [...done, ...tail_fixed(bal, debt.rate_bp, debt.kind, fixed, next.date, k, rounding)];
  }
  const tail = amortization_schedule({ principal: bal, rate_bp: debt.rate_bp, n: sched.length - k, start: next.date, kind: debt.kind, rounding });
  return [...done, ...shift_k(tail, k)];
}

/**
 * v2. Ре-якорение по факту: после `k`-го проведённого платежа банк показал остаток `observed_outstanding`;
 * срок не меняется, хвост пересчитывается от наблюдаемого остатка. `drift = observed − modeled` (допуск —
 * `debt.drift_tol_bp` в `vocab.json`, гипотеза, проверяет вызывающий).
 * @param {DebtPlan} debt
 * @param {number} k число проведённых платежей (1…n)
 * @param {Minor} observed_outstanding наблюдаемый остаток
 * @returns {{drift: Minor, schedule: DebtRow[]}}
 * @throws {RunwayError} E_SCHEMA (k вне 1…n)
 */
export function reanchor(debt, k, observed_outstanding) {
  const sched = schedule_of(debt);
  const kk = assert_minor(k);
  if (kk < 1 || kk > sched.length) fail('E_SCHEMA', { reason: 'k_out_of_1_n', k: kk, n: sched.length });
  const observed = assert_minor(observed_outstanding);
  const modeled = sched[kk - 1].balance_minor;
  const drift = observed - modeled;
  const done = sched.slice(0, kk);
  if (observed <= 0 || kk === sched.length) return { drift, schedule: done }; // долг закрыт (при k = n и остатке > 0 — только дрейф)
  const tail = amortization_schedule({
    principal: observed, rate_bp: debt.rate_bp, n: sched.length - kk, start: sched[kk].date, kind: debt.kind, rounding: debt.rounding ?? 'half_even',
  });
  return { drift, schedule: [...done, ...shift_k(tail, kk)] };
}
