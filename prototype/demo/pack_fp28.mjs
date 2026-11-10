// pack_fp28.mjs — точка входа пакета FP-28: хвосты интерфейса «Ленты» и «Обзора» (REQ-046, IDEA-38, IDEA-41, IDEA-29, U06, U13, A04.5).
// Что подключается (приложение пакет по имени не знает — только слоты и контекст `ctx.ask`):
//   - слот `feed.head` — «Сверка: N» со ссылкой на #reconcile и оговорка, что в ленте только последние факты;
//   - слот `feed.row` — «Почему» у каждой строки и «Исправить» у факта (`void_fact` + `add_fact` одним пересчётом, «Отменить» возвращает прежний);
//   - слот `overview.cards` — карточка «Куда делись деньги»: остаток = резервы + платежи + буфер + свободно (из `sts_breakdown`), сумма статей равна остатку;
//   - слоты `buy.form` и `buy.result` — «Разбить на N платежей» на экране «Купить»: вердикт по частям и «с какой даты график держится в буфере» (`engine/installment_earliest.mjs`).
// Запись — только через общий путь `ctx.set_ws` (проверка → пересчёт → журнал → «Отменить»). Хранитель фокуса экрана — `focus_keep.mjs`: после «Исправить» кнопка строки
// заменяется, и фокус возвращается на заголовок экрана. Расчёт по введённым данным и правилам, не консультация.

import catalog from './i18n/feedx.mjs';
import { create_focus_keeper } from './focus_keep.mjs';
import { clock_ports } from './ids.mjs';
import { render_feed_head, render_row_actions } from './feed_ext.mjs';
import { render_where_money } from './where_money.mjs';
import { make_deps as make_split_deps, render_split_toggle, render_split_result } from './buy_split.mjs';

/** Место карточки «Куда делись деньги» среди карточек «Обзора»: после «Сверки» (60) и до «Запаса дней» (100). */
export const WHERE_MONEY_ORDER = 70;

/**
 * @param {object} ext реестр расширений (`ext.mjs`, версия для пакета)
 * @param {{ports?: {now_ms: () => number}}} [env] только для тестов
 * @returns {{focus: object, split: object}} зависимости (для тестов)
 */
export function register(ext, env = {}) {
  const ctx = ext.ctx;
  // каталог принимается один раз на процесс: повторная загрузка пакета (тесты, перезапуск реестра) не должна падать
  if (ctx.tr('feedx.recon_link') === 'feedx.recon_link') ext.register_i18n('feedx', catalog);
  ext.ensure_css('css/feedx.css');
  const ports = env.ports ?? clock_ports();
  const deps = { focus: create_focus_keeper(ports.now_ms) };
  const split = make_split_deps();
  ext.register_slot_item('feed.head', { id: 'fp28_head', order: 10, render: (c, info) => { deps.focus.apply(); return render_feed_head(c, info); } }); // apply — в конце каждой отрисовки ленты (фокус после «Исправить»)
  ext.register_slot_item('feed.row', { id: 'fp28_row', order: 10, render: (c, row) => render_row_actions(c, deps, row) });
  ext.register_slot_item('overview.cards', { id: 'fp28_where', order: WHERE_MONEY_ORDER, render: render_where_money });
  ext.register_slot_item('buy.form', { id: 'fp28_split', order: 10, render: (c, api) => render_split_toggle(c, split, api) });
  ext.register_slot_item('buy.result', { id: 'fp28_split_result', order: 10, render: (c, info) => render_split_result(c, split, info) });
  ctx.subscribe((info) => { if (info.reason === 'adopt' || info.reason === 'restore') { split.ui.on = false; deps.focus.clear(); } }); // новый набор данных: разбивка выключена, запрос фокуса снят
  return { focus: deps.focus, split };
}
