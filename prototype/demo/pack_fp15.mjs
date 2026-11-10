// pack_fp15.mjs — точка входа пакета FP-15: экран «Резервы» — освободить остаток, срок годности налогового правила и «как посчитано» у чисел резервов
// (REQ-062, REQ-067, REQ-108, ALG-05, ALG-06, C-023, C-024, C-059). Расчёт по введённым данным и правилам, не консультация.
//
// Что регистрируется (нового вида правок пакет не добавляет: «освободить остаток» — это `record_allocation` из словаря `ws_edit`, «подтвердить правило» — `upsert_tax_rule` формы «Налог»):
//   - слот `reserves.sections`: `fp15_rules` («Срок годности налоговых правил»: плашка «не подтверждено с <даты>» и «Подтвердить правило») и `fp15_cards`
//     (карточка каждого резерва: сколько сейчас, предупреждение `W_RESERVE_RESIDUAL` / `W_RESERVE_OVERDUE` с суммой, «Освободить остаток», «Как посчитано»);
//   - слот `banner.warning`: кнопка «Освободить остаток» прямо в плашке `W_RESERVE_RESIDUAL` в шапке;
//   - строки `reserveui.*` (RU и EN) и стили `css/reserveui.css` (отступы и границы на токенах темы).
// Подключается реестром (`ext_manifest.mjs`); `app.mjs` пакет не знает. Запись — только через общий путь (`ctx.edit` / `ctx.set_ws`): «Отменить» откатывает каждое действие.

import catalog from './i18n/reserveui.mjs';
import { render_rule_cards } from './reserve_rules.mjs';
import { render_reserve_cards, render_banner_release } from './reserve_release.mjs';

/** @param {object} ext реестр расширений (`ext.mjs`, версия для пакета) */
export function register(ext) {
  const ctx = ext.ctx;
  // каталог принимается один раз на процесс: повторная загрузка пакета (тесты, перезапуск реестра) не должна падать
  if (ctx.tr('reserveui.cards_title') === 'reserveui.cards_title') ext.register_i18n('reserveui', catalog);
  ext.ensure_css('css/reserveui.css');
  ext.register_slot_item('reserves.sections', { id: 'fp15_rules', order: 17, render: render_rule_cards });
  ext.register_slot_item('reserves.sections', { id: 'fp15_cards', order: 18, render: render_reserve_cards });
  ext.register_slot_item('banner.warning', { id: 'fp15_release', order: 10, render: render_banner_release });
}
