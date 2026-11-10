// pack_fp09.mjs — точка входа пакета FP-09: витрины на готовом движке. Экраны: «В магазине», «Лестница сумм», «Долги», «Эталон», «Обещаем / не обещаем»,
// «Лист для печати», «Облако: предпросмотр»; чип происхождения чисел в слоте `assistant.extras`; переходы с клавиатуры («g» и буква, «?») и кнопка «?» в навигации.
// Ничего не пишет в данные: экраны читают расчёт страницы (`ctx.get_model()`) и показывают его. Подключается реестром (`ext_manifest.mjs`); `app.mjs` пакет не знает.
// Расчёт по введённым данным и правилам, не консультация.

import catalog from './i18n/showcase.mjs';
import { render_store } from './store_mode.mjs';
import { render_ladder } from './ladder.mjs';
import { render_debts } from './debts.mjs';
import { render_golden } from './golden_panel.mjs';
import { render_promises } from './promises.mjs';
import { render_report } from './report.mjs';
import { render_payload, render_assistant_chip } from './payload_preview.mjs';
import { install_hotkeys, render_nav_help } from './hotkeys.mjs';

/** Места экранов в навигации: после экранов приложения (10…80) и «Настроек» (85). */
export const ORDERS = Object.freeze({ store: 100, ladder: 110, debts: 120, golden: 130, promises: 140, report: 150, payload: 160 });

/** Экраны пакета: идентификатор → отрисовка. Подписи — `showcase.nav_<id>`. */
export const VIEWS = Object.freeze({
  store: render_store,
  ladder: render_ladder,
  debts: render_debts,
  golden: render_golden,
  promises: render_promises,
  report: render_report,
  payload: render_payload,
});

/** @param {object} ext реестр расширений (`ext.mjs`, версия для пакета) */
export function register(ext) {
  const ctx = ext.ctx;
  // каталог строк принимается один раз на процесс: повторная загрузка пакета (тесты, перезапуск реестра) не должна падать
  if (ctx.tr('showcase.nav_store') === 'showcase.nav_store') ext.register_i18n('showcase', catalog);
  ext.ensure_css('css/showcase.css');
  ext.register_view({ id: 'store', title_key: 'showcase.nav_store', order: ORDERS.store, render: VIEWS.store });
  ext.register_view({ id: 'ladder', title_key: 'showcase.nav_ladder', order: ORDERS.ladder, render: VIEWS.ladder });
  ext.register_view({ id: 'debts', title_key: 'showcase.nav_debts', order: ORDERS.debts, render: VIEWS.debts });
  ext.register_view({ id: 'golden', title_key: 'showcase.nav_golden', order: ORDERS.golden, render: VIEWS.golden });
  ext.register_view({ id: 'promises', title_key: 'showcase.nav_promises', order: ORDERS.promises, render: VIEWS.promises });
  ext.register_view({ id: 'report', title_key: 'showcase.nav_report', order: ORDERS.report, render: VIEWS.report });
  ext.register_view({ id: 'payload', title_key: 'showcase.nav_payload', order: ORDERS.payload, render: VIEWS.payload });
  ext.register_slot_item('assistant.extras', { id: 'fp09_origin', order: 900, render: render_assistant_chip });
  ext.register_slot_item('nav.actions', { id: 'fp09_keys', order: 900, render: render_nav_help });
  install_hotkeys(ctx);
}
