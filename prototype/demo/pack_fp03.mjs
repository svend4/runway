// pack_fp03.mjs — точка входа пакета FP-03: настройки, буфер, запас хода и честная готовность данных.
// Что подключается: экран `#settings` (settings.mjs), карточки «Запас хода» и «Готовность данных» в слот `overview.cards` (home_cards.mjs),
// правки `set_number_format` (формат чисел и дат отдельно от языка, number_format.mjs), `set_as_of` («сегодня» — дата расчёта, as_of.mjs) и
// `set_decision_currency` («Валюта решения», decision_currency.mjs, FP-29),
// строки `settings.*` и `defaults.*` (значения по умолчанию как данные словаря, FP-17) и стили css/settings.css.
// Пакет не импортирует app.mjs; запись — только через `ctx.set_ws` после `apply_edit`. Расчёт по введённым данным и правилам, не консультация.

import catalog from './i18n/settings.mjs';
import defaults_catalog from './i18n/defaults.mjs';
import { list_edit_types } from './ws_edit.mjs';
import { edit_set_number_format, make_nf_fmt } from './number_format.mjs';
import { edit_set_as_of } from './as_of.mjs';
import { edit_set_decision_currency } from './decision_currency.mjs';
import { render_settings } from './settings.mjs';
import { runway_card, ready_card } from './home_cards.mjs';

/** Порядок экрана в навигации: после экранов приложения (10…80). */
export const SETTINGS_ORDER = 85;

/** @param {object} ext реестр расширений (`ext.mjs`, версия для пакета) */
export function register(ext) {
  ext.register_i18n('settings', catalog);
  ext.register_i18n('defaults', defaults_catalog); // FP-17: «по умолчанию N», «Вернуть по умолчанию» и таблица параметров на экране «Настройки»
  ext.ensure_css('css/settings.css');
  // вид правки — один на процесс: повторная загрузка пакета (тесты, перезапуск реестра) не должна падать
  if (!list_edit_types().includes('set_number_format')) ext.register_edit('set_number_format', edit_set_number_format);
  // «сегодня» — дата расчёта: правка `set_as_of` (as_of.mjs); раньше последней проведённой записи дату поставить нельзя
  if (!list_edit_types().includes('set_as_of')) ext.register_edit('set_as_of', edit_set_as_of);
  // «Валюта решения» (FP-29): правка поверх `set_param decision_currency`; пишет и поле рабочей области, которое движок читает раньше параметра
  if (!list_edit_types().includes('set_decision_currency')) ext.register_edit('set_decision_currency', edit_set_decision_currency);
  ext.register_view({ id: 'settings', title_key: 'settings.nav', order: SETTINGS_ORDER, render: render_settings });
  ext.register_slot_item('overview.cards', { id: 'fp03_runway', order: 100, render: runway_card });
  ext.register_slot_item('overview.cards', { id: 'fp03_ready', order: 110, render: ready_card });
  // формат чисел и дат отдельно от языка (REQ-112): без настройки хук отвечает «не знаю» и приложение берёт формат языка
  ext.register_hook('fmt', (ctx, lang, cur, as_of, nf) => (nf === undefined || nf === null ? undefined : make_nf_fmt(lang, cur, as_of, nf)));
}
