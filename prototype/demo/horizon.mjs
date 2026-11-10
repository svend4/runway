// horizon.mjs — «горизонт в днях вперёд от даты расчёта» (FP-49, хвост FP-48): одно место для выражения «число строк ряда − 1».
// Движок отдаёт ряд на каждый день от даты расчёта до конца горизонта ВКЛЮЧАЯ день расчёта, поэтому строк на одну больше, чем дней вперёд: при `horizon_days = 57` в ряду 58 строк.
// Число дней вперёд — то, что вводят в «Настройках» (`horizon_days`) и что называют карточка «Запас хода», лист для печати и экран «Настройки»; число строк — заголовок «Таблицы значений».
// Раньше выражение было записано в четырёх местах (app.mjs, home_cards.mjs, report.mjs, settings.mjs) и «легко расходилось» (дефект FP-48 — шапка и «Настройки» называли разные числа).
// Модуль чистый: без DOM, часов и случайности. `app.mjs` его не импортирует (список импортов страницы закреплён тестом `demo.test.mjs`) и держит своё выражение в `horizon_ahead_of(model)`;
// что все места дают одно число, закреплено тестом `fp49_pure.test.mjs`. Расчёт по введённым данным и правилам, не консультация.

/**
 * Массив `close` (остаток на конец каждого дня) из того, что передали: сам массив, один ряд (`series.plan`), ряды расчёта (`ctx.series`), контекст расчёта (`model.ctx`) или модель страницы.
 * Режимы «по плану» и «если хуже» имеют ряды одной длины, поэтому берётся `plan`.
 * @param {unknown} x
 * @returns {unknown[]|null}
 */
function close_of(x) {
  if (Array.isArray(x)) return x;
  if (x === null || typeof x !== 'object') return null;
  const o = /** @type {any} */ (x);
  for (const c of [o.close, o.plan?.close, o.series?.plan?.close, o.ctx?.series?.plan?.close]) if (Array.isArray(c)) return c;
  return null;
}

/**
 * Число строк ряда расчёта: день расчёта и дни вперёд до конца горизонта.
 * @param {unknown} series ряды расчёта (`ctx.series`: `plan` и `worse`); принимается и один ряд, и массив `close`, и контекст или модель страницы
 * @returns {number} 0, если рядов нет
 */
export function horizon_rows_of(series) {
  const close = close_of(series);
  return close === null ? 0 : close.length;
}

/**
 * Горизонт в днях ВПЕРЁД от даты расчёта: строк ряда минус день расчёта (не меньше 0).
 * @param {unknown} series ряды расчёта (`ctx.series`), как у `horizon_rows_of`
 * @returns {number}
 */
export function horizon_ahead_of(series) {
  return Math.max(0, horizon_rows_of(series) - 1);
}
