// installment_earliest.mjs — «с какой даты рассрочка держится в буфере» (FP-28, ALG-04 A04.5, REQ-044, IDEA-14).
//
// Покупка по частям `(дата, сумма)` отвечает на «могу ли я это купить?» через `check_purchase`, но `earliest_date` для нескольких частей в ядре `null`
// («сдвиг графика платежей — v1.1», ALG-04). Здесь — этот сдвиг: весь график переносится на `s = 0, 1, 2, …` дней (каждая часть — через `move_part_date`,
// сумма не меняется), и для каждого режима находится самое раннее `s`, при котором `check_purchase` оставляет минимум свободных денег не ниже буфера
// (`margin ≥ 0`). Ответ — первая дата графика, ближайшая к выбранной, и сколько дней это от неё.
//
// Что модуль честно оговаривает:
//   - части за горизонтом ядро в расчёт не берёт (`W_PART_BEYOND_HORIZON`); если бы сдвиг выталкивал часть за горизонт, проверка «упрощалась» бы сама собой.
//     Поэтому проверяются только части, лежащие внутри горизонта при `s = 0`, а перебор останавливается, когда последняя из них вышла бы за горизонт.
//     Остальные части считаются и возвращаются (`beyond_count`, `beyond_minor`), но «держится» относится только к проверенным (`checked_count` из `total_count`);
//   - «держится с даты X» — самая ранняя дата, не гарантия для всех более поздних: минимум свободных после покупки при сдвиге вправо не обязан расти монотонно
//     (график может упереться в другую просадку), поэтому перебор линейный, а не бинарный поиск;
//   - если ещё до покупки минимум свободных ниже буфера (`baseline_below_buffer`, C-015), сдвиг не поможет: ответ `baseline_below_buffer`, перебора нет;
//   - часть с датой раньше `as_of` (из интерфейса недостижимо — дата «Купить» не раньше «сегодня», но функция публична) считается как в расчёте — на `as_of` (`clamped_count`):
//     график начинается не раньше «сегодня», поэтому «держится с даты» (`start`) никогда не лежит в прошлом.
// Для покупки из одной части результат совпадает с `earliest_date(ctx, S, date, B, mode)` (свойство, которое проверяет тест).
//
// Это ликвидность по правилам пользователя, не совет покупать и не договор рассрочки: числа — расчёт по введённым данным.
// Зависимости: money, dates, afford, installment. Модуль чистый: ни часов, ни случайности, ни ввода-вывода; в index.mjs не реэкспортируется.

import { assert_minor } from './money.mjs';
import { to_epoch_day, format_date } from './dates.mjs';
import { check_purchase } from './afford.mjs';
import { move_part_date } from './installment.mjs';

const MODES = ['plan', 'worse'];

/**
 * Состояние режима: `now` — график держится с выбранной даты; `shifted` — держится после сдвига; `none` — в пределах горизонта такой даты нет;
 * `baseline_below_buffer` — буфер нарушен ещё до покупки, сдвиг не поможет.
 * @typedef {'now'|'shifted'|'none'|'baseline_below_buffer'} StartStatus
 */

/**
 * Перенести весь график на `days` дней вперёд: каждая часть — через `move_part_date`, суммы не меняются, порядок частей сохраняется.
 * @param {{date: string, amount_minor: number}[]} parts части с датами `YYYY-MM-DD`
 * @param {number} days сдвиг ≥ 0 в днях
 * @returns {{date: string, amount_minor: number}[]} новый список; исходный не меняется
 */
export function shift_schedule(parts, days) {
  let out = parts.map((p) => ({ date: p.date, amount_minor: p.amount_minor }));
  if (days === 0) return out;
  for (let i = 0; i < out.length; i++) out = move_part_date(out, i, format_date(to_epoch_day(parts[i].date) + days));
  return out;
}

/** Минимум массива без `Math.min(...xs)`. */
function min_of(xs) {
  let m = xs[0];
  for (let i = 1; i < xs.length; i++) if (xs[i] < m) m = xs[i];
  return m;
}

/**
 * Самая ранняя первая дата графика платежей, при которой он держится в буфере (по режимам).
 * @param {object} ctx `Analysis` (нужны ряды `plan` и `worse`, `as_of`, `horizon_end`, `decision_currency`, буфер)
 * @param {{currency: string, parts: {date: string|number, amount_minor: number}[]}} purchase части покупки (рассрочка); валюта — валюта решения
 * @param {{buffer_minor?: number|null, max_shift_days?: number}} [opts] `buffer_minor` — буфер вызова (по умолчанию буфер `ctx`, N6);
 *   `max_shift_days` — не искать дальше этого числа дней (по умолчанию — до конца горизонта)
 * @returns {{kind: 'insufficient_data', reason: string, reasons: string[]}
 *   | {kind: 'outside_horizon', horizon_end: number}
 *   | {kind: 'ok', total_count: number, checked_count: number, beyond_count: number, beyond_minor: number, clamped_count: number, first_date: number, last_date: number,
 *      max_shift_days: number, scanned: number,
 *      by_mode: {plan: ModeStart, worse: ModeStart}}}
 *   где `ModeStart = {status: StartStatus, shift_days: number|null, start: number|null, last: number|null, m_after: number|null, margin: number|null}`:
 *   `start` — первая дата сдвинутого графика (EpochDay), `last` — последняя проверенная часть, `m_after` и `margin` — минимум свободных после покупки и запас над буфером
 *   при этом сдвиге (для `none` и `baseline_below_buffer` — значения при сдвиге 0)
 * @throws {RunwayError} E_CURRENCY_MISMATCH, E_SCHEMA (нет частей, часть ≤ 0, буфер не задан), E_NOT_INTEGER, E_BAD_DATE — как у `check_purchase`
 */
export function earliest_installment_start(ctx, purchase, opts = {}) {
  const B = opts.buffer_minor ?? null;
  const base = check_purchase(ctx, purchase, B);
  if (base.kind === 'insufficient_data') return base;
  if (base.kind === 'outside_horizon') return base;
  const buffer = base.buffer_minor;
  const horizon_end = to_epoch_day(ctx.horizon_end);
  const as_of = to_epoch_day(ctx.as_of);
  // часть раньше `as_of` ядро зажимает на `as_of` (W_DATE_CLAMPED); здесь это делается до сдвига, чтобы график начинался не раньше «сегодня»
  // и «держится с даты» не уходила в прошлое: сдвигается график, каким его видит расчёт (`clamped_count` — сколько частей зажато)
  const all = purchase.parts.map((p) => ({ date: format_date(Math.max(to_epoch_day(p.date), as_of)), amount_minor: assert_minor(p.amount_minor) }));
  const clamped_count = purchase.parts.filter((p) => to_epoch_day(p.date) < as_of).length;
  const inside = all.filter((p) => to_epoch_day(p.date) <= horizon_end);
  const beyond = all.filter((p) => to_epoch_day(p.date) > horizon_end);
  const beyond_minor = beyond.reduce((s, p) => s + p.amount_minor, 0);
  const inside_days = inside.map((p) => to_epoch_day(p.date));
  const first_date = Math.min(...inside_days);
  const last_date = Math.max(...inside_days);
  let max_shift = horizon_end - last_date; // дальше последняя проверенная часть вышла бы за горизонт
  if (opts.max_shift_days !== undefined && opts.max_shift_days !== null) max_shift = Math.min(max_shift, Math.max(0, assert_minor(opts.max_shift_days)));

  const by_mode = {};
  const open = new Set();
  for (const m of MODES) {
    const baseline_below = min_of(ctx.series[m].free) < buffer; // C-015: просадка до покупки — сдвиг графика её не лечит
    const at0 = base.by_mode[m];
    by_mode[m] = { status: baseline_below ? 'baseline_below_buffer' : 'none', shift_days: null, start: null, last: null, m_after: at0.m_after, margin: at0.margin };
    if (!baseline_below) open.add(m);
  }
  let scanned = 0;
  for (let s = 0; s <= max_shift && open.size > 0; s++) {
    const r =check_purchase(ctx, { currency: purchase.currency, parts: shift_schedule(inside, s) }, B);
    scanned++;
    if (r.kind !== 'ok') break; // не должно случаться: гейт и горизонт проверены выше; на всякий случай перебор прекращается
    for (const m of [...open]) {
      const x = r.by_mode[m];
      if (x.margin >= 0) {
        by_mode[m] = { status: s === 0 ? 'now' : 'shifted', shift_days: s, start: first_date + s, last: last_date + s, m_after: x.m_after, margin: x.margin };
        open.delete(m);
      }
    }
  }
  return {
    kind: 'ok', total_count: all.length, checked_count: inside.length, beyond_count: beyond.length, beyond_minor, clamped_count,
    first_date, last_date, max_shift_days: max_shift, scanned, by_mode,
  };
}
