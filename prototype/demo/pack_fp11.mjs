// pack_fp11.mjs — точка входа пакета FP-11: экраны «Сверка» (#reconcile) и «Качество прогноза» (#quality), виды правок привязки факта и статуса разового платежа, вероятностные блоки по согласию.
// Что подключается: два экрана; карточка «Сверка» на «Обзоре» (только если в очереди есть решения); карточка «Коридор остатка (эксперимент)» на «Обзоре» (только при согласии — по умолчанию её нет);
// виды правок `set_match` (в журнал уходит `match.set`, факт не мутирует) и `set_plan_status`; подписка на смену набора данных (результаты полосы и «при уверенности α» сбрасываются).
// Пакет не импортирует app.mjs; запись — только через общий путь `ctx.edit` / `ctx.set_ws`. Согласие на вероятностные блоки — localStorage `runway-prob-consent/1` (префикс `runway`: стирается «Удалить все данные»).
// Вероятностные блоки выключены по умолчанию и не влияют на вердикты и числа Q1/Q3 (решение владельца № 3, предварительное). Расчёт по введённым данным и правилам, не консультация.

import reconcile_catalog from './i18n/reconcile.mjs';
import quality_catalog from './i18n/quality.mjs';
import { list_edit_types } from './ws_edit.mjs';
import { EDITS, make_deps as make_reconcile_deps, render_reconcile, render_reconcile_card } from './reconcile.mjs';
import { make_deps as make_quality_deps, render_quality } from './quality.mjs';
import { render_band_card } from './prob_band.mjs';

/** Места экранов в навигации: рядом с «Формами данных» и «Стартом» (90), после экранов приложения и «Настроек». */
export const RECONCILE_ORDER = 91;
export const QUALITY_ORDER = 92;

/**
 * @param {object} ext реестр расширений (`ext.mjs`, версия для пакета)
 * @param {{ports?: object, storage?: object|null}} [env] порты и хранилище согласия (в приложении не передаются; в тестах подменяются)
 */
export function register(ext, env = {}) {
  const ctx = ext.ctx;
  // каталоги принимаются один раз на процесс: повторная загрузка пакета (тесты, перезапуск реестра) не должна падать
  if (ctx.tr('reconcile.nav') === 'reconcile.nav') ext.register_i18n('reconcile', reconcile_catalog);
  if (ctx.tr('quality.nav') === 'quality.nav') ext.register_i18n('quality', quality_catalog);
  ext.ensure_css('css/reconcile.css');
  ext.ensure_css('css/quality.css');
  const have = new Set(list_edit_types());
  for (const [type, fn] of Object.entries(EDITS)) if (!have.has(type)) ext.register_edit(type, fn);
  const rec = make_reconcile_deps(env);
  const qual = make_quality_deps(env);
  ext.register_view({ id: 'reconcile', title_key: 'reconcile.nav', order: RECONCILE_ORDER, render: (c) => render_reconcile(c, rec) });
  ext.register_view({ id: 'quality', title_key: 'quality.nav', order: QUALITY_ORDER, render: (c) => render_quality(c, qual) });
  ext.register_slot_item('overview.cards', { id: 'fp11_reconcile', order: 60, render: render_reconcile_card });
  ext.register_slot_item('overview.cards', { id: 'fp11_band', order: 130, render: (c) => render_band_card(c, qual) });
  ctx.subscribe((info) => {
    if (info.reason === 'adopt' || info.reason === 'restore') {
      rec.ui.page = 0;
      qual.band = { key: null, result: null };
      qual.buy = { key: null, result: null, error: null };
    }
  });
  return { rec, qual };
}
