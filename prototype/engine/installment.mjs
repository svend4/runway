// installment.mjs — рассрочка по частям и с процентами (FP-08, REQ-044, REQ-192, IDEA-14, ALG-09, ALG-04).
//
// Покупка — список частей `(date_k, amount_k > 0)`. Рассрочка БЕЗ процентов — `split_equal` (REQ-044: 110000 в шесть частей → [18334, 18334, 18333 ×4]);
// рассрочка С процентами — график `DebtPlan` (`annuity` или `differential`) превращается в части покупки с датами договорных платежей, БЕЗ сдвига выходных
// (REQ-192: 120000 под 12 % годовых на 6 платежей → [20706 ×5, 20705], Σ = 124235 = 120000 + проценты 4235). Перенос платежа — правка даты строки графика
// (`move_part_date`), сумма не меняется. Влияние на «свободно» считает `check_purchase` по частям, а не всей суммой сразу; части за горизонтом дают
// `beyond_horizon_minor` — модуль их не прячет: `split_horizon` показывает, сколько внутри горизонта и сколько за ним.
//
// График по модели не равен договору банка (дни, комиссии, плавающая ставка): это расчёт по введённым данным, не консультация.
// Зависимости: money, dates, debt. Модуль чистый: ни часов, ни случайности, ни ввода-вывода.

import { fail, assert_minor, sum_minor } from './money.mjs';
import { to_epoch_day, format_date } from './dates.mjs';
import { amortization_schedule } from './debt.mjs';

/** Виды рассрочки: без процентов (`installment_0`) и с процентами (`annuity`, `differential`). */
export const INSTALLMENT_KINDS = Object.freeze(['installment_0', 'annuity', 'differential']);

/**
 * Рассрочка: график платежей и части покупки. `rate_bp = 0` — всегда рассрочка без процентов, какой бы вид ни пришёл (как в `amortization_schedule`).
 * Нулевые части (при сумме меньше числа платежей у рассрочки без процентов) в части покупки не попадают: покупка не принимает часть 0.
 * @param {{total_minor: number, n: number, rate_bp?: number, start: string|number, kind?: string, rounding?: 'half_even'|'half_up'}} p
 *   `total_minor` — сумма покупки (долг), `n` — число месячных платежей, `rate_bp` — годовая ставка в bp (0…100000), `start` — дата первого платежа
 * @returns {{kind: string, rate_bp: number, n: number, rows: object[], parts: {date: string, amount_minor: number}[], total_minor: number,
 *   principal_minor: number, interest_minor: number}}
 * @throws {RunwayError} E_SCHEMA (ограничения графика C-041: 1 ≤ n ≤ 600, P ≥ n при процентах), E_NOT_INTEGER, E_BAD_DATE
 */
export function installment_plan({ total_minor, n, rate_bp = 0, start, kind, rounding = 'half_even' }) {
  const principal = assert_minor(total_minor);
  const rate = assert_minor(rate_bp);
  const k = kind ?? (rate === 0 ? 'installment_0' : 'annuity');
  if (!INSTALLMENT_KINDS.includes(k)) fail('E_SCHEMA', { reason: 'unknown_installment_kind', value: String(k) });
  const kd = rate === 0 ? 'installment_0' : k;
  if (kd === 'installment_0' && rate !== 0) fail('E_SCHEMA', { reason: 'installment_needs_zero_rate', value: rate });
  const rows = amortization_schedule({ principal, rate_bp: rate, n, start, kind: kd, rounding });
  const parts = rows.filter((r) => r.payment_minor > 0).map((r) => ({ date: format_date(r.date), amount_minor: r.payment_minor }));
  const total = sum_minor(rows.map((r) => r.payment_minor));
  return { kind: kd, rate_bp: rate, n, rows, parts, total_minor: total, principal_minor: principal, interest_minor: total - principal };
}

/**
 * Части покупки из плана долга `DebtPlan` (REQ-192): даты договорных платежей без сдвига выходных; график — сохранённый `debt.schedule`
 * либо расчёт по полям плана. Платёж 0 пропускается.
 * @param {{kind: string, principal_minor: number, rate_bp: number, n: number, start_date: string|number, schedule?: object[], rounding?: string}} debt
 * @returns {{date: string, amount_minor: number}[]}
 */
export function parts_from_debt_plan(debt) {
  const rows = Array.isArray(debt.schedule)
    ? debt.schedule.map((r) => ({ ...r, date: to_epoch_day(r.date) }))
    : amortization_schedule({
      principal: debt.principal_minor, rate_bp: debt.rate_bp, n: debt.n, start: debt.start_date, kind: debt.kind, rounding: debt.rounding ?? 'half_even',
    });
  return rows.filter((r) => r.payment_minor > 0).map((r) => ({ date: format_date(r.date), amount_minor: r.payment_minor }));
}

/**
 * Покупка из частей: заготовка для правки `add_purchase` и для `check_purchase`.
 * @param {{date: string, amount_minor: number}[]} parts
 * @param {{currency: string, name?: string, purchase_id?: string}} o
 * @returns {{currency: string, parts: {date: string, amount_minor: number}[], name?: string, purchase_id?: string}}
 */
export function purchase_from_parts(parts, o) {
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 120) fail('E_SCHEMA', { reason: 'one_to_120_parts' });
  const out = { currency: o.currency, parts: parts.map((p) => ({ date: p.date, amount_minor: p.amount_minor })) };
  if (o.name !== undefined) out.name = o.name;
  if (o.purchase_id !== undefined) out.purchase_id = o.purchase_id;
  return out;
}

/**
 * Перенос одного платежа: меняется дата строки графика, сумма — нет (договорная дата не сдвигается политикой выходных).
 * @param {{date: string, amount_minor: number}[]} parts
 * @param {number} index номер части с нуля
 * @param {string} new_date ISO-дата
 * @returns {{date: string, amount_minor: number}[]} новый список; исходный не меняется
 * @throws {RunwayError} E_SCHEMA (нет такой части), E_BAD_DATE
 */
export function move_part_date(parts, index, new_date) {
  if (!Number.isInteger(index) || index < 0 || index >= parts.length) fail('E_SCHEMA', { reason: 'part_index_out_of_range', index: String(index) });
  const iso = format_date(to_epoch_day(new_date)); // E_BAD_DATE для несуществующей даты
  return parts.map((p, i) => (i === index ? { date: iso, amount_minor: p.amount_minor } : { ...p }));
}

/**
 * Что внутри горизонта прогноза и что за ним (части за горизонтом в расчёт «свободно» не входят — это не скрывается).
 * @param {{date: string, amount_minor: number}[]} parts
 * @param {string|number} horizon_end последний день горизонта
 * @returns {{inside_count: number, inside_minor: number, beyond_count: number, beyond_minor: number}}
 */
export function split_horizon(parts, horizon_end) {
  const hz = to_epoch_day(horizon_end);
  const inside = parts.filter((p) => to_epoch_day(p.date) <= hz);
  const beyond = parts.filter((p) => to_epoch_day(p.date) > hz);
  return {
    inside_count: inside.length, inside_minor: sum_minor(inside.map((p) => p.amount_minor)),
    beyond_count: beyond.length, beyond_minor: sum_minor(beyond.map((p) => p.amount_minor)),
  };
}
