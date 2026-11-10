// pack_fp14.mjs — точка входа пакета FP-14: долг записывается в прогноз (REQ-082, REQ-083, IDEA-22).
// Экран «Долги» (FP-09) остаётся калькулятором; пакет добавляет к нему запись:
//   - блок «Записать в прогноз» под расчётом (название, счёт платежей, кнопка «Добавить в прогноз») → вид правки `upsert_debt`;
//   - раздел «Долги в прогнозе» над калькулятором: сохранённый график, что применено, перенос платежа (`move_debt_row`), досрочное погашение (`apply_prepay`),
//     сверка с банком (`apply_reanchor`) и «Убрать долг из прогноза» (`delete_debt`).
// Платежи записанных долгов входят в «свободно» и в волны как плановые обязательства (движок: `build_events`), платежи за горизонтом дают служебное
// предупреждение `W_DEBT_BEYOND_HORIZON`. Запись — только через `ctx.edit`: правка проходит «Отменить» (корзина `debts` известна единой стопке) и журнал.
// Подключается реестром (`ext_manifest.mjs`); `app.mjs` пакет не знает. Расчёт по введённым данным и правилам, не консультация.

import catalog from './i18n/debtedit.mjs';
import { list_edit_types } from './ws_edit.mjs';
import { register_debt_block } from './debts.mjs';
import { EDITS, make_deps, render_add_block, render_saved } from './debt_edit.mjs';

/**
 * @param {object} ext реестр расширений (`ext.mjs`, версия для пакета)
 * @param {{ports?: {now_ms: () => number}}} [env] только для тестов: загрузчик реестра второй аргумент не передаёт
 * @returns {object} состояние экрана (для тестов)
 */
export function register(ext, env = {}) {
  const ctx = ext.ctx;
  // каталог принимается один раз на процесс: повторная загрузка пакета (тесты, перезапуск реестра) не должна падать
  if (ctx.tr('debtedit.add_title') === 'debtedit.add_title') ext.register_i18n('debtedit', catalog);
  // виды правок — по одному на процесс (так же, как у пакетов FP-03 и FP-08)
  const have = new Set(list_edit_types());
  for (const [type, fn] of Object.entries(EDITS)) if (!have.has(type)) ext.register_edit(type, fn);
  const deps = make_deps(env);
  register_debt_block('saved', 'fp14_saved', (c, arg) => render_saved(c, deps, arg));
  register_debt_block('calc_actions', 'fp14_add', (c, arg) => render_add_block(c, deps, arg));
  return deps;
}
