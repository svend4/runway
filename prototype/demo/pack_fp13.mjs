// pack_fp13.mjs — точка входа пакета FP-13: календарь выходных и праздников, перенос и своя сумма одного вхождения, разовый платёж (REQ-009, REQ-010).
// Экран «Формы данных» → «Платежи» получает под формой правила две карточки:
//   - «Разовый платёж» (`form_plan.mjs`): один платёж или поступление на дату → вид правки `upsert_plan` (и `delete_plan`);
//   - «Календарь выходных и праздников» (`form_calendar.mjs`): свои выходные дни недели и праздники → виды правок `upsert_calendar`, `delete_calendar`.
// Действия «Перенести» и «Другая сумма» у вхождения, выбор календаря, политика выходных и поле «n-й рабочий день» живут в самой форме правила (`form_rule.mjs`, FP-08):
// там нужен только вид правки `set_occurrence_override`, который уже регистрирует пакет FP-08. Готовых списков праздников по странам нет: календарь вносит пользователь.
// Запись — только общим путём (`ctx.set_ws` после `apply_edit`): «Отменить» и журнал работают (корзины `calendars` и `plans` известны единой стопке и мосту).
// Подключается реестром (`ext_manifest.mjs`); `app.mjs` пакет не знает. Расчёт по введённым данным и правилам, не консультация.

import catalog from './i18n/calendars.mjs';
import { list_edit_types } from './ws_edit.mjs';
import { register_rule_block } from './form_rule.mjs';
import { CALENDAR_EDITS, make_deps, render_calendars } from './form_calendar.mjs';
import { PLAN_EDITS, render_plans } from './form_plan.mjs';

/** Места блоков в разделе «Платежи»: сначала разовый платёж, затем календарь. */
export const BLOCK_ORDER = Object.freeze({ plan: 20, calendar: 30 });

/** Новые виды правок пакета (`ws_edit.register_edit`). */
export const EDITS = Object.freeze({ ...CALENDAR_EDITS, ...PLAN_EDITS });

/**
 * @param {object} ext реестр расширений (`ext.mjs`, версия для пакета)
 * @param {{ports?: {now_ms: () => number}}} [env] только для тестов: загрузчик реестра второй аргумент не передаёт
 * @returns {object} состояние блоков (хранитель фокуса; для тестов)
 */
export function register(ext, env = {}) {
  const ctx = ext.ctx;
  // каталог принимается один раз на процесс: повторная загрузка пакета (тесты, перезапуск реестра) не должна падать
  if (ctx.tr('calendars.cal_title') === 'calendars.cal_title') ext.register_i18n('calendars', catalog);
  ext.ensure_css('css/calendar.css');
  // виды правок — по одному на процесс (так же, как у пакетов FP-03, FP-08 и FP-14)
  const have = new Set(list_edit_types());
  for (const [type, fn] of Object.entries(EDITS)) if (!have.has(type)) ext.register_edit(type, fn);
  const deps = make_deps(env);
  register_rule_block('fp13_plan', (c) => render_plans(c, deps), BLOCK_ORDER.plan);
  register_rule_block('fp13_calendar', (c) => render_calendars(c, deps), BLOCK_ORDER.calendar);
  return deps;
}
