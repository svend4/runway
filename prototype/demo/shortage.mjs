// shortage.mjs — факты к сообщениям о нехватке: «ближайшее ожидаемое поступление» и «первая дата нарушения буфера» (REQ-046, FP-28, ALG-03 next_income_day).
//
// Требование REQ-046: при `trough < 0` или `free < B` экран называет факты — первую дату нарушения, число «не хватает до буфера» с указанием ряда
// (деньги на счетах / с учётом резервов) и ближайшее ожидаемое поступление. Число и «первая дата, когда деньги на счетах стали меньше нуля» уже есть в движке (`answer_q1`,
// `safe_to_spend`); этот модуль даёт остальное:
//   - `nearest_income` — первое поступление режима в день отсчёта или позже (сумма за день);
//   - `first_below` — первая дата, когда ряд (деньги на счетах `trough` или свободные деньги `free`) ниже буфера: дата нарушения для режима «впритык» (`trough` ≥ 0, но < B)
//     и для ряда «с учётом резервов», у которого в движке есть только минимум и его дата.
// Ранжированных «ходов» (сдвинуть, сократить) нет и здесь не появится — только факт расчёта.
// Модуль чистый (без DOM): его вызывает app.mjs при сборке фразы и проверяют тесты (tests/feed_ext.test.mjs). Расчёт по введённым данным, не консультация.

import { next_income_day, to_epoch_day } from '../engine/index.mjs';

/**
 * Ближайшее ожидаемое поступление режима в день `from_day` или позже.
 * Поступление — событие режима `kind = income` с суммой `> 0` (план, ожидаемое, просроченное, гипотеза сценария); день отсчёта входит: расходы дня идут раньше его поступлений
 * (D-02), поэтому поступление в день нарушения не отменяет само нарушение, но и его стоит назвать. Несколько поступлений одного дня суммируются.
 * @param {object[]|undefined} events события режима (`ctx.events[mode]`)
 * @param {number|string} from_day EpochDay или ISO-дата отсчёта (обычно — первая дата нарушения)
 * @returns {{date: number, amount_minor: number, count: number}|null} `null` — поступлений от этой даты до конца горизонта нет
 */
export function nearest_income(events, from_day) {
  const from = to_epoch_day(from_day);
  const date = next_income_day(events, from - 1); // «строго после» от предыдущего дня = «в этот день или позже»
  if (date === null) return null;
  let amount_minor = 0;
  let count = 0;
  for (const e of events ?? []) {
    if (e.kind === 'income' && e.amount_minor > 0 && to_epoch_day(e.date) === date) { amount_minor += e.amount_minor; count++; }
  }
  return { date, amount_minor, count };
}

/**
 * Первая дата, когда ряд опускается ниже буфера (REQ-046: «первая дата нарушения»): первый `values[i] < B` при `i ≤ last_day − from_day`.
 * Для денег на счетах это `series.trough` (совпадает с `answer_q1().first_buffer_breach`), для «с учётом резервов» — `series.free` (`free < B`, на этом стоит «не хватает до буфера (с учётом резервов)»).
 * @param {number[]} values ряд по дням от `from_day`
 * @param {number} from_day EpochDay первого элемента ряда (`as_of`)
 * @param {number|null|undefined} B буфер; не задан — даты нет
 * @param {number} [last_day] последний день окна (включительно); по умолчанию — конец ряда
 * @returns {number|null} EpochDay первого нарушения; `null` — в окне ряд не ниже буфера (или буфера нет)
 */
export function first_below(values, from_day, B, last_day) {
  if (B === null || B === undefined || !Array.isArray(values)) return null;
  const end = last_day === undefined || last_day === null ? values.length - 1 : Math.min(values.length - 1, last_day - from_day);
  for (let i = 0; i <= end; i++) if (values[i] < B) return from_day + i;
  return null;
}
