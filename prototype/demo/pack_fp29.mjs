// pack_fp29.mjs — точка входа пакета FP-29 (волна 3а-2): импорт v1.1 — часы из CSV и строки в чужой валюте с двумя ногами.
// Пакет регистрирует строки `importv11.*` (i18n/importv11.mjs). Остальное подключено к уже существующим местам, а не к новым слотам:
//   - мастер импорта (pack_fp06 → import_wizard.mjs): профили «часы» и «обмен двумя ногами» в выборе профиля, отчёт по периодам и по обменам, список партий часов;
//   - «Настройки» (pack_fp03 → settings.mjs): раздел «Валюта решения» и правка `set_decision_currency` (decision_currency.mjs).
// Модель и разбор — import_v11.mjs, engine/hours_io.mjs, engine/io_fx_rows.mjs; узлы — import_v11_view.mjs. Запись — только через общий путь `ctx.set_ws`.
// Расчёт по введённым данным и правилам, не консультация.

import catalog from './i18n/importv11.mjs';

/** @param {object} ext реестр расширений (версия для пакета) */
export function register(ext) {
  ext.register_i18n('importv11', catalog);
}
