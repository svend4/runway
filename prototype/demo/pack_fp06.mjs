// pack_fp06.mjs — точка входа пакета FP-06: мастер импорта CSV и hledger с сухим прогоном и откатом партии (REQ-091, REQ-092, REQ-093, REQ-099).
// Подключается реестром (`ext_manifest.mjs` → `register(ext)`); `app.mjs` пакет не знает. Что регистрируется:
//   - слот `data.sections`: карточка мастера (вкладки CSV и hledger), список партий импорта с кнопкой «Откатить» и (FP-29) список партий часов;
//   - строки `import.*` (i18n/import.mjs) и стили css/import.css;
//   - подписка на смену набора данных (`adopt`): состояние мастера начинается заново.
// Запись только через общий путь `ctx.set_ws` (проверка → пересчёт страницей → журнал → показ). Расчёт по введённым данным и правилам, не консультация.

import catalog from './i18n/import.mjs';
import { new_wizard } from './import_model.mjs';
import { create_deps, render_wizard, render_batches, render_hours_batches } from './import_wizard.mjs';

/** Место блока в слоте «Данные»: после штатных карточек и блоков других пакетов с меньшим `order`. */
export const IMPORT_ORDER = 60;

/** @param {object} ext реестр расширений (версия для пакета) */
export function register(ext) {
  const ctx = ext.ctx;
  ext.register_i18n('import', catalog);
  ext.ensure_css('css/import.css');
  const deps = create_deps();
  ctx.subscribe(({ reason }) => { if (reason === 'adopt') { deps.w = new_wizard(); deps.notice = null; deps.busy = false; } });
  ext.register_slot_item('data.sections', { id: 'import_wizard', order: IMPORT_ORDER, render: (c) => [render_wizard(c, deps), render_batches(c, deps), render_hours_batches(c, deps)] });
  return deps;
}
