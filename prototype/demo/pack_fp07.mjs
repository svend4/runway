// pack_fp07.mjs — точка входа пакета FP-07: конструктор сценариев, правки волн и «почему» у каждого числа.
// Подключается реестром (`ext_manifest.mjs` → `register(ext)`); `app.mjs` пакет не знает. Что регистрируется:
//   - экран `#scenario_lab` («Конструктор»): пять операций движка, сдвиг выбранного поступления, чипы курса и часов, «Сохранить в набор» (scenario_builder.mjs);
//   - хук `scenario_ops`: новые виды сценариев (`fx`, `shift`, `hours`, `ops`) → операции для `apply_scenario`; операция `hours` — только через engine/scenario_ext.mjs;
//   - слот `waves.actions`: правки волн «объединить / разделить / закрепить», «почему вместе?», порог θ и таблица чувствительности (wave_edit.mjs);
//   - слот `waves.card` (S1.5): в конце каждой карточки волны кнопки «Почему так» (диалог «Почему волна N») и «Править волну» (merge / split / pin
//     теми же правками, что в `waves.actions`); `render(ctx, card)`, `card = {wave, mode, index}` (wave_edit.mjs);
//   - хук `show_why`: полная цепочка с «Остальное» и сверкой «сумма строк равна просадке» в штатном диалоге «Почему» (why_more.mjs);
//   - слот `overview.cards`: карточка «Почему так» — вердикт по плану, вердикт «если хуже», «можно потратить» (why_more.mjs);
//   - строки `scenarios.*` (i18n/scenarios.mjs) и стили css/scenarios.css; подписка на смену набора данных (`adopt`): черновик сценария очищается.
// Запись только через общий путь `ctx.edit` (проверка → пересчёт страницей → журнал → показ). Расчёт по введённым данным и правилам, не консультация.

import catalog from './i18n/scenarios.mjs';
import { create_lab_deps, render_lab, scenario_ops_hook, new_draft, LAB_ORDER } from './scenario_builder.mjs';
import { create_wave_deps, render_wave_edit, render_wave_card } from './wave_edit.mjs';
import { render_why_block, render_why_card } from './why_more.mjs';

/** Место блоков: правки волн — после календаря волн; карточка «Почему так» — после карточек других пакетов обзора. */
export const WAVE_EDIT_ORDER = 20;
export const WHY_CARD_ORDER = 120;
/** Место кнопок в конце карточки волны (слот `waves.card`). */
export const WAVE_CARD_ORDER = 20;

/** @param {object} ext реестр расширений (версия для пакета) */
export function register(ext) {
  const ctx = ext.ctx;
  ext.register_i18n('scenarios', catalog);
  ext.ensure_css('css/scenarios.css');
  const lab = create_lab_deps();
  const waves = create_wave_deps();
  ctx.subscribe(({ reason }) => {
    if (reason === 'adopt') { lab.draft = new_draft(); lab.n = 1; lab.status = null; waves.status = null; }
  });
  ext.register_view({ id: 'scenario_lab', title_key: 'scenarios.nav', order: LAB_ORDER, render: (c) => render_lab(c, lab) });
  ext.register_hook('scenario_ops', scenario_ops_hook);
  ext.register_hook('show_why', (c, mode) => render_why_block(c, mode));
  ext.register_slot_item('waves.actions', { id: 'fp07_wave_edit', order: WAVE_EDIT_ORDER, render: (c) => render_wave_edit(c, waves) });
  ext.register_slot_item('waves.card', { id: 'fp07_wave_card', order: WAVE_CARD_ORDER, render: (c, card) => render_wave_card(c, waves, card) });
  ext.register_slot_item('overview.cards', { id: 'fp07_why', order: WHY_CARD_ORDER, render: render_why_card });
  return { lab, waves };
}
