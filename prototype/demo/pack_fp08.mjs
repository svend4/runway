// pack_fp08.mjs — точка входа пакета FP-08: формы данных (правила, часы, налог, накопления, курсы и обмен, счета и запас, рассрочка).
// Это «пишущий» слой: без правки файла пользователь вносит регулярный платёж, часы, налоговое правило, цель накопления, курс, счёт и рассрочку. Каждая форма
// до записи показывает результат (ближайшие даты, диапазон дохода, конверт, план взносов, график), отказ даёт код канона `E_*` и текст без повтора введённого.
// Подключается реестром (`ext_manifest.mjs` → `register(ext)`); `app.mjs` пакет не знает. Запись — только через общий путь `ctx.set_ws` после `apply_edit`.
//
// Что регистрируется:
//   - экран `#forms` («Формы данных»): семь разделов с переключателем (`seg`), раздел рисуется при выборе;
//   - слот `reserves.sections`: «Налоги и часы», «Недоработка», «проведено, но в конверт не записано», «Накопления: план взносов», «Запас и счета»;
//   - слот `data.sections`: ссылка на экран форм;
//   - виды правок (`register_edit`): `set_occurrence_override` (пропустить вхождение), `set_stream_hours` (отработано N часов), `post_income` (выплата + запись в конверт),
//     `record_posted_allocations` (записи в резерве по проведённым фактам), `confirm_contributions` (подтвердить взносы пачкой).
// Налог — расчёт по введённым правилам, не консультация.

import catalog from './i18n/forms.mjs';
import { h } from './dom.mjs';
import { list_edit_types } from './ws_edit.mjs';
import { edit_set_occurrence_override, render_rules } from './form_rule.mjs';
import { edit_set_stream_hours, edit_post_income, render_hours, render_shortfall } from './form_hours.mjs';
import { edit_record_posted_allocations, render_tax, render_tax_hours_card, render_pending_allocations } from './form_tax.mjs';
import { edit_confirm_contributions, render_sinking, render_sinking_card } from './form_sinking.mjs';
import { render_fx } from './form_fx.mjs';
import { render_accounts, render_liquidity_card } from './form_accounts.mjs';
import { render_installment } from './form_installment.mjs';

/** Место экрана форм в навигации: после экранов приложения (10…80) и «Настроек» (85) пакета FP-03 — перед витринами FP-09 (100…). */
export const FORMS_ORDER = 90;

/** Разделы экрана форм: идентификатор → отрисовка. Подпись — `forms.tab_<id>`. */
export const SECTIONS = Object.freeze({
  rules: render_rules,
  hours: render_hours,
  tax: render_tax,
  sinking: render_sinking,
  fx: render_fx,
  accounts: render_accounts,
  installment: render_installment,
});

/** Новые виды правок пакета (`ws_edit.register_edit`). */
export const EDITS = Object.freeze({
  set_occurrence_override: edit_set_occurrence_override,
  set_stream_hours: edit_set_stream_hours,
  post_income: edit_post_income,
  record_posted_allocations: edit_record_posted_allocations,
  confirm_contributions: edit_confirm_contributions,
});

/**
 * Экран «Формы данных»: заголовок, переключатель разделов и один раздел под ним.
 * @param {object} ctx контекст расширений
 * @param {{section: string}} ui состояние экрана (выбранный раздел) — живёт, пока открыта страница
 * @returns {HTMLElement}
 */
export function render_forms(ctx, ui) {
  const ids = Object.keys(SECTIONS);
  if (!ids.includes(ui.section)) ui.section = ids[0];
  const panel = h('div', { class: 'fp08-panel', id: 'fp08-panel', role: 'region', 'aria-live': 'off' });
  const buttons = new Map();
  const draw = () => {
    panel.replaceChildren(SECTIONS[ui.section](ctx));
    for (const [id, b] of buttons) b.setAttribute('aria-pressed', id === ui.section ? 'true' : 'false');
  };
  const seg = h('div', { class: 'seg fp08-tabs', role: 'group', 'aria-label': ctx.tr('forms.tabs_label') });
  for (const id of ids) {
    const b = h('button', { type: 'button', 'data-tab': id, 'aria-pressed': id === ui.section ? 'true' : 'false', onclick: () => { ui.section = id; draw(); }, text: ctx.tr('forms.tab_' + id) });
    buttons.set(id, b);
    seg.append(b);
  }
  const root = h('div', { class: 'view fp08' },
    h('h2', { id: 'view-title', tabindex: '-1', text: ctx.tr('forms.title') }),
    h('p', { class: 'lead', text: ctx.tr('forms.lead') }),
    seg, panel);
  draw();
  return root;
}

/** Карточка-ссылка на экран форм в разделе «Данные». */
export function render_data_link(ctx) {
  return h('section', { class: 'card fp08-card', id: 'fp08-data-link', 'aria-labelledby': 'fp08-data-link-title' },
    h('h3', { id: 'fp08-data-link-title', text: ctx.tr('forms.data_title') }),
    h('p', { text: ctx.tr('forms.data_lead') }),
    h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '#forms', text: ctx.tr('forms.data_open') })));
}

/** @param {object} ext реестр расширений (`ext.mjs`, версия для пакета) */
export function register(ext) {
  const ctx = ext.ctx;
  // каталог принимается один раз на процесс: повторная загрузка пакета (тесты, перезапуск реестра) не должна падать
  if (ctx.tr('forms.nav') === 'forms.nav') ext.register_i18n('forms', catalog);
  ext.ensure_css('css/forms.css');
  // вид правки — один на процесс (так же, как у пакета FP-03)
  const have = new Set(list_edit_types());
  for (const [type, fn] of Object.entries(EDITS)) if (!have.has(type)) ext.register_edit(type, fn);
  const ui = { section: 'rules' };
  ext.register_view({ id: 'forms', title_key: 'forms.nav', order: FORMS_ORDER, render: (c) => render_forms(c, ui) });
  ext.register_slot_item('reserves.sections', { id: 'fp08_taxhours', order: 20, render: render_tax_hours_card });
  ext.register_slot_item('reserves.sections', { id: 'fp08_shortfall', order: 22, render: render_shortfall });
  ext.register_slot_item('reserves.sections', { id: 'fp08_pending', order: 25, render: render_pending_allocations });
  ext.register_slot_item('reserves.sections', { id: 'fp08_sinking', order: 30, render: render_sinking_card });
  ext.register_slot_item('reserves.sections', { id: 'fp08_liquidity', order: 40, render: render_liquidity_card });
  ext.register_slot_item('data.sections', { id: 'fp08_link', order: 8, render: render_data_link });
  return ui;
}
