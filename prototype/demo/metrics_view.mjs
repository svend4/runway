// metrics_view.mjs — экран «Метрики на устройстве» (#metrics, FP-10, REQ-185): показывает файл `runway-metrics/1` ЦЕЛИКОМ до скачивания.
// Показанный текст и скачиваемый — один и тот же (текст берётся при отрисовке и передаётся кнопке «Скачать» как есть). Файл приложение само не отправляет:
// скачивание — по кнопке, дальше решает пользователь. Метрики можно выключить и очистить; «Удалить все данные» (FP-05) стирает их тоже.
// Логика и схема — metrics.mjs (чистый модуль); здесь только узлы (`h` из dom.mjs: textContent и узлы, без inline-стилей и обработчиков-строк).
// Расчёт по введённым данным и правилам, не консультация.

import { h } from './dom.mjs';
import { METRICS_FORMAT } from './metrics.mjs';

/** Имя скачиваемого файла: без календарной даты. */
export const METRICS_FILE_NAME = 'runway-metrics-1.json';

/**
 * Скачать текст файлом (Blob и временная ссылка; сети нет). Возвращает `true`, если ссылка создана и нажата.
 * @param {string} name имя файла
 * @param {string} text содержимое
 */
export function download_text(name, text) {
  try {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: name });
    document.body.append(link);
    link.click();
    if (typeof link.remove === 'function') link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return true;
  } catch {
    return false;
  }
}

/** Значения пакета словами: строки «подпись → значение» для таблицы под файлом. Только числа пакета, ничего нового. */
export function metrics_rows(tr, pkg) {
  const none = tr('start.mx_none');
  const median = (vs) => {
    if (vs.length === 0) return null;
    const s = [...vs].sort((a, b) => a - b);
    return s[Math.floor((s.length - 1) / 2)];
  };
  const counters = Object.entries(pkg.counters).sort(([a], [b]) => (a < b ? -1 : 1));
  const med = median(pkg.min_error_bp.values);
  return [
    ['sessions', String(pkg.sessions)],
    ['days', String(pkg.active_days.length)],
    ['steps', String(pkg.steps.length)],
    ['forecast', pkg.first_forecast === null ? none
      : (pkg.first_forecast.after_seconds === null ? tr('start.mx_ff_nosec', { session: pkg.first_forecast.session }) : tr('start.mx_ff', { seconds: pkg.first_forecast.after_seconds, session: pkg.first_forecast.session }))],
    ['verdict', pkg.verdict_ready === null ? none : tr('start.mx_vr', { session: pkg.verdict_ready.session })],
    ['counters', counters.length === 0 ? none : counters.map(([k, v]) => tr('start.mx_c_' + k) + ' = ' + v).join('; ')],
    ['error', pkg.min_error_bp.n === 0 ? tr('start.mx_n0') : tr('start.mx_error', { n: pkg.min_error_bp.n, bp: med === null ? tr('start.mx_none') : String(med) })],
    ['coverage', pkg.coverage.n === 0 ? tr('start.mx_n0') : tr('start.mx_coverage', { k: pkg.coverage.k, n: pkg.coverage.n })],
  ];
}

/**
 * Экран «Метрики на устройстве».
 * @param {object} ctx контекст расширений
 * @param {{metrics: ReturnType<typeof import('./metrics.mjs').create_metrics>, metrics_ui: {confirm_clear: boolean}}} deps
 */
export function render_metrics(ctx, deps) {
  const tr = ctx.tr;
  const mx = deps.metrics;
  const ui = deps.metrics_ui;
  const root = h('div', { class: 'view metrics' }, h('h2', { id: 'view-title', tabindex: '-1', text: tr('start.mx_title') }), h('p', { class: 'lead', text: tr('start.mx_lead') }));
  const st = mx.status();
  let text = '';
  let pkg = null;
  try { pkg = mx.package(); text = mx.package_text(); } catch { pkg = null; }
  const toggle = h('input', {
    id: 'mx-enabled', type: 'checkbox', checked: st.enabled ? true : null, 'aria-describedby': 'mx-enabled-hint',
    onchange: (ev) => { mx.set_enabled(ev?.target?.checked === true); ui.confirm_clear = false; ctx.refresh(); },
  });
  const notes = [];
  if (st.halted) notes.push(h('p', { class: 'banner short', role: 'status', text: tr('start.mx_halted') }));
  else if (st.in_memory || !st.persisted) notes.push(h('p', { class: 'banner', role: 'status', text: tr('start.mx_memory') }));
  const file_card = h('section', { class: 'card', 'aria-labelledby': 'mx-file-title' },
    h('h3', { id: 'mx-file-title', text: tr('start.mx_file_title', { format: METRICS_FORMAT }) }),
    h('p', { class: 'muted', text: tr('start.mx_file_lead') }),
    h('pre', { id: 'mx-file', class: 'mx-file', tabindex: '0', role: 'region', 'aria-label': tr('start.mx_file_label'), text }));
  const status = h('p', { class: 'muted', role: 'status', id: 'mx-status' });
  const actions = h('div', { class: 'row' },
    h('button', {
      type: 'button', class: 'btn primary', id: 'mx-download', disabled: text === '' ? true : null,
      onclick: () => { status.textContent = download_text(METRICS_FILE_NAME, text) ? tr('start.mx_downloaded', { name: METRICS_FILE_NAME }) : tr('start.mx_download_failed'); }, text: tr('start.mx_download'),
    }),
    ui.confirm_clear
      ? h('span', { class: 'row' },
        h('button', { type: 'button', class: 'btn', id: 'mx-clear-yes', onclick: () => { mx.clear(); ui.confirm_clear = false; ctx.notify(tr('start.mx_cleared'), 'info'); ctx.refresh(); }, text: tr('start.mx_clear_yes') }),
        h('button', { type: 'button', class: 'btn', id: 'mx-clear-no', onclick: () => { ui.confirm_clear = false; ctx.refresh(); }, text: tr('start.mx_clear_no') }))
      : h('button', { type: 'button', class: 'btn', id: 'mx-clear', onclick: () => { ui.confirm_clear = true; ctx.refresh(); }, text: tr('start.mx_clear') }));
  const rows = pkg === null ? [] : metrics_rows(tr, pkg);
  root.append(
    h('section', { class: 'card', 'aria-labelledby': 'mx-what-title' },
      h('h3', { id: 'mx-what-title', text: tr('start.mx_what_title') }),
      h('ul', null, [1, 2, 3].map((i) => h('li', { text: tr('start.mx_in_' + i) }))),
      h('p', { class: 'muted', text: tr('start.mx_anchor_note') })),
    h('div', { class: 'field check' }, h('label', { for: 'mx-enabled' }, toggle, ' ', tr('start.mx_enabled')), h('p', { id: 'mx-enabled-hint', class: 'muted', text: tr('start.mx_enabled_hint') })),
    ...notes,
    file_card,
    actions,
    status,
    pkg === null ? null : h('section', { class: 'card', 'aria-labelledby': 'mx-sum-title' },
      h('h3', { id: 'mx-sum-title', text: tr('start.mx_summary_title') }),
      h('table', { class: 'tbl' }, h('caption', { class: 'sr-only', text: tr('start.mx_summary_title') }),
        h('thead', null, h('tr', null, h('th', { scope: 'col', text: tr('start.mx_col_name') }), h('th', { scope: 'col', text: tr('start.mx_col_value') }))),
        h('tbody', null, rows.map(([k, v]) => h('tr', null, h('th', { scope: 'row', text: tr('start.mx_row_' + k) }), h('td', { text: v })))))),
    h('p', { class: 'muted', text: tr('start.mx_note_send') }),
    h('p', { class: 'muted', text: tr('start.mx_note_erase') }));
  return root;
}
