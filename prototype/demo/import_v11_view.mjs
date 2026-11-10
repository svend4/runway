// import_v11_view.mjs — узлы мастера импорта для v1.1 (FP-29): профиль «часы» и строки обмена с двумя ногами. Экран мастера (import_wizard.mjs) вызывает эти функции
// короткими ветками; здесь нет состояния и записи данных — только разметка по готовому плану из import_v11.mjs / import_model.mjs.
// Защита от внедрения: текст из файла (названия потоков и колонок, описания операций) попадает в разметку только через `h` (textContent); inline-стилей, обработчиков-строк
// и внешних адресов нет. Курс и разница обмена — справочные: в расчёт «свободно» они не входят. Расчёт по введённым данным и правилам, не консультация.

import { h } from './dom.mjs';
import { make_nf_fmt } from './number_format.mjs';
import { rate_text } from './forms.mjs';
import { no_rate_text } from './banner_texts.mjs';
import { hours_text } from './form_hours.mjs';
import { V11_PROFILES, V11_REJECT_REASONS, has_fx_block, plan_exchanges } from './import_v11.mjs';

const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const list = (ws, key) => (Array.isArray(ws?.[key]) ? ws[key] : []);
const th = (text) => h('th', { scope: 'col', text });
const SHOW_ROWS = 20;

/** Название профиля v1.1 для выбора и подсказки (`importv11.pf_<id>`, «-» → «_»). */
export function v11_profile_name(tr, id) {
  return tr('importv11.pf_' + id.replaceAll('-', '_'));
}

/** Пункты выбора профиля, добавляемые к встроенным: `[[id, название]]`. */
export function v11_profile_options(tr) {
  return Object.keys(V11_PROFILES).map((id) => [id, v11_profile_name(tr, id)]);
}

/** Текст причины отклонения строки v1.1 (`importv11.rj_<причина>`) или `null`, если причина не из v1.1. */
export function v11_reject_text(tr, reason) {
  return V11_REJECT_REASONS.includes(reason) ? tr('importv11.rj_' + reason) : null;
}

/** Выпадающий список с подписью (как в мастере): `{node, select}`. */
function select_field(id, label, options, value, on_change) {
  const sel = h('select', { id, onchange: () => on_change(sel.value) },
    options.map(([v, text]) => h('option', { value: v, selected: String(v) === String(value) ? true : null, text })));
  sel.value = String(value);
  return { node: h('div', { class: 'field' }, h('label', { for: id, text: label }), sel), select: sel };
}

const col_options = (tr, header) => [['-1', tr('import.col_none')], ...header.map((n, i) => [String(i), tr('import.col_n', { n: i + 1, name: n === '' ? '…' : n })])];

// ── шаг «колонки» ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Краткое описание профиля «часы» (колонки, единицы). */
export function hours_summary(tr, p) {
  const lines = [
    tr('import.ps_delim', { v: p.delimiter === '\t' ? 'TAB' : p.delimiter }),
    tr('import.ps_date', { col: String(p.date.col), fmt: p.date.fmt }),
    tr('importv11.ps_hours', { col: String(p.hours.col), unit: tr('importv11.u_' + p.hours.unit) }),
    p.stream === undefined ? tr('importv11.ps_stream_none') : tr('importv11.ps_stream', { col: String(p.stream.col) }),
  ];
  return h('ul', { class: 'plain import-profile-summary' }, lines.map((t) => h('li', { text: t })));
}

/** Описание блока `fx` профиля строк обмена. */
export function fx_summary(tr, fx) {
  const a = fx.counter_amount;
  const c = fx.counter_currency;
  const lines = [
    tr('importv11.ps_fx_amount', { col: String(a.col), unit: tr(a.unit === 'minor' ? 'importv11.u_minor' : 'importv11.u_major') }),
    c.fixed !== undefined ? tr('importv11.ps_fx_cur_fixed', { cur: c.fixed }) : tr('importv11.ps_fx_cur_col', { col: String(c.col) }),
  ];
  return h('ul', { class: 'plain import-profile-summary' }, lines.map((t) => h('li', { text: t })));
}

/**
 * Шаг «колонки» для профиля «часы»: описание профиля, подсказка про итоги периодов и выбор потока для строк без потока. Нет потоков — подсказка, куда идти.
 * @param {object} ctx
 * @param {object} p профиль «часы»
 * @param {{v11: object}} st состояние CSV мастера
 * @param {object} ws
 * @param {(patch: object) => void} set_csv
 */
export function hours_columns_nodes(ctx, p, st, ws, set_csv) {
  const tr = ctx.tr;
  const streams = list(ws, 'streams').filter((s) => is_obj(s) && typeof s.stream_id === 'string');
  const out = [hours_summary(tr, p), h('p', { class: 'muted', id: 'import-hours-hint', text: tr('importv11.h_hint') })];
  if (streams.length === 0) {
    out.push(h('p', { class: 'banner short', role: 'status', id: 'import-hours-nostreams', text: tr('importv11.h_no_streams') }));
    return out;
  }
  const value = st.v11.hours_stream_id ?? (streams.length === 1 ? streams[0].stream_id : '');
  out.push(select_field('import-hours-stream', tr('importv11.f_hours_stream'),
    [['', tr('importv11.h_stream_none')], ...streams.map((s) => [s.stream_id, String(s.name ?? s.stream_id)])], value, (v) => set_csv({ hours_stream_id: v === '' ? null : v })).node);
  return out;
}

/**
 * Выбор счёта второй ноги: «единственный счёт в этой валюте» (по умолчанию) или конкретный открытый счёт, кроме счёта импорта.
 */
function counter_account_field(ctx, st, ws, set_csv) {
  const tr = ctx.tr;
  const own = st.account_id;
  const accs = list(ws, 'accounts').filter((a) => is_obj(a) && typeof a.account_id === 'string' && a.account_id !== own && (typeof a.closed_on !== 'string' || a.closed_on > ws.as_of));
  return select_field('import-fx-counter', tr('importv11.f_fx_counter'),
    [['', tr('importv11.fx_counter_auto')], ...accs.map((a) => [a.account_id, String(a.name ?? a.account_id) + ' · ' + String(a.currency)])], st.v11.counter_account_id ?? '', (v) => set_csv({ counter_account_id: v === '' ? null : v })).node;
}

/**
 * Настройки строк обмена на шаге «колонки»: у встроенного профиля (и профиля из файла с блоком `fx`) — описание блока и выбор счёта второй ноги;
 * у «своих колонок» — переключатель «строки в другой валюте — обмен» и колонки второй ноги.
 * @param {object} ctx
 * @param {{profile_choice: string, v11: object, sniff: {header: string[]}|null, account_id: string|null}} st
 * @param {object} ws
 * @param {(patch: object) => void} set_csv
 * @param {object|null} fx блок `fx` выбранного профиля (если он есть)
 */
export function fx_columns_nodes(ctx, st, ws, set_csv, fx) {
  const tr = ctx.tr;
  const out = [];
  if (fx !== null) {
    out.push(fx_summary(tr, fx), h('p', { class: 'muted', id: 'import-fx-hint', text: tr('importv11.fx_hint') }), counter_account_field(ctx, st, ws, set_csv));
    return out;
  }
  if (st.profile_choice !== 'custom' || st.sniff === null) return out;
  const cb = h('input', { type: 'checkbox', id: 'import-fx-on', checked: st.v11.fx_on ? true : null });
  cb.addEventListener('change', () => set_csv({ fx_on: cb.checked === true }));
  out.push(h('div', { class: 'field' }, h('label', { for: 'import-fx-on' }, cb, ' ', tr('importv11.f_fx_on')), h('p', { class: 'muted', text: tr('importv11.fx_hint') })));
  if (!st.v11.fx_on) return out;
  const cols = col_options(tr, st.sniff.header);
  out.push(select_field('import-fx-amount-col', tr('importv11.f_fx_amount_col'), cols, st.v11.fx_amount_col, (v) => set_csv({ fx_amount_col: Number(v) })).node);
  out.push(select_field('import-fx-amount-unit', tr('importv11.f_fx_amount_unit'), [['major', tr('importv11.u_major')], ['minor', tr('importv11.u_minor')]], st.v11.fx_amount_unit, (v) => set_csv({ fx_amount_unit: v })).node);
  out.push(select_field('import-fx-currency-col', tr('importv11.f_fx_currency_col'), cols, st.v11.fx_currency_col, (v) => set_csv({ fx_currency_col: Number(v) })).node);
  out.push(counter_account_field(ctx, st, ws, set_csv));
  return out;
}

/** Профиль с блоком fx (встроенный строк обмена или из файла) — для описания на шаге «колонки»; иначе `null`. */
export function fx_block_of(profile_choice, profile_file) {
  if (profile_choice === 'file' && has_fx_block(profile_file)) return profile_file.fx;
  if (Object.hasOwn(V11_PROFILES, profile_choice) && has_fx_block(V11_PROFILES[profile_choice])) return V11_PROFILES[profile_choice].fx;
  return null;
}

// ── отчёт сухого прогона ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Отчёт по часам: что изменится по периодам (было → станет), сколько периодов уже записано, сколько строк с округлением дроби. Число строк файла сходится:
 * распознано + отклонено + дубликатов = строк (строки в `import-rep-line` показывает общий код мастера).
 * @param {object} ctx
 * @param {object} plan план `kind: 'hours'`
 * @param {object} ws
 */
export function hours_report_nodes(ctx, plan, ws) {
  const tr = ctx.tr;
  const hr = plan.hours;
  const f = make_nf_fmt(ctx.lang(), String(ws?.decision_currency ?? 'EUR'), ws?.as_of ?? '0000-01-01', ws?.number_format);
  const name_of = (id) => String(list(ws, 'streams').find((s) => s?.stream_id === id)?.name ?? id);
  const out = [];
  if (hr.no_streams) out.push(h('p', { class: 'banner short', role: 'alert', id: 'import-hours-nostreams', text: tr('importv11.h_no_streams') }));
  if (hr.rounded_rows > 0) out.push(h('p', { class: 'banner', role: 'status', id: 'import-warn-hours_rounded', text: tr('importv11.h_rounded', { n: hr.rounded_rows }) }));
  if (hr.replaced > 0) out.push(h('p', { class: 'banner', role: 'status', id: 'import-hours-replaced', text: tr('importv11.h_replaced', { n: hr.replaced }) }));
  if (hr.unchanged > 0) out.push(h('p', { class: 'muted', id: 'import-hours-unchanged', text: tr('importv11.h_unchanged', { n: hr.unchanged }) }));
  if (hr.changes.length > 0) {
    const rows = hr.changes.slice(0, SHOW_ROWS).map((c) => h('tr', { 'data-stream': c.stream_id },
      h('td', { text: name_of(c.stream_id) }),
      h('td', { text: f.date(c.period_start) }),
      h('td', { class: 'num', text: c.before === null ? tr('importv11.h_before_none') : hours_text(ctx, c.before) }),
      h('td', { class: 'num', text: hours_text(ctx, c.after) })));
    out.push(h('div', { class: 'table-wrap' }, h('table', { class: 'tbl import-preview import-hours' },
      h('caption', { text: tr('importv11.h_changes_title', { n: hr.changes.length }) }),
      h('thead', null, h('tr', null, th(tr('importv11.h_th_stream')), th(tr('importv11.h_th_period')), th(tr('importv11.h_th_before')), th(tr('importv11.h_th_after')))),
      h('tbody', null, rows))));
    if (hr.changes.length > SHOW_ROWS) out.push(h('p', { class: 'muted', text: tr('import.more', { n: hr.changes.length - SHOW_ROWS }) }));
  }
  return out;
}

/**
 * Обмены плана CSV: таблица «продано · получено · курс обмена · курс из данных · справочная разница», плашка «нет курса» по каждой паре без курса.
 * Справочная разница — выведенный курс против курса из ваших данных; в «свободно» она не входит.
 */
export function fx_report_nodes(ctx, plan, ws) {
  const tr = ctx.tr;
  const info = plan.fx;
  if (!is_obj(info)) return [];
  const lang = ctx.lang();
  const as_of = ws?.as_of ?? '0000-01-01';
  const nf = ws?.number_format;
  const money = (minor, cur) => make_nf_fmt(lang, cur, as_of, nf).money(minor);
  const env = { lang, nf };
  const out = [];
  for (const pair of info.missing_pairs) out.push(h('p', { class: 'banner short', role: 'alert', id: 'import-fx-norate', 'data-pair': pair, text: no_rate_text(tr, { pair }) }));
  if (info.skipped_currencies > 0) out.push(h('p', { class: 'muted', text: tr('importv11.fx_skipped', { n: info.skipped_currencies }) }));
  const ex = plan_exchanges(plan);
  if (ex.length === 0) return out;
  const diff_text = (x) => {
    if (x.spot === null) return tr('importv11.fx_no_spot');
    if (x.diff_minor === 0) return tr('importv11.fx_diff_zero');
    return tr(x.diff_minor > 0 ? 'importv11.fx_diff_less' : 'importv11.fx_diff_more', { amount: money(Math.abs(x.diff_minor), x.got_currency) });
  };
  const rows = ex.slice(0, SHOW_ROWS).map((c) => {
    const x = c.exchange;
    return h('tr', { 'data-row': String(c.row) },
      h('td', { text: make_nf_fmt(lang, c.currency, as_of, nf).date(c.date) }),
      h('td', { class: 'num', text: money(x.sold_minor, x.sold_currency) }),
      h('td', { class: 'num', text: money(x.got_minor, x.got_currency) }),
      h('td', { text: tr('importv11.fx_rate_line', { from: x.sold_currency, to: x.got_currency, rate: rate_text(x.implied.num, x.implied.den, env) }) }),
      h('td', { text: x.spot === null ? '—' : tr('importv11.fx_rate_line', { from: x.sold_currency, to: x.got_currency, rate: rate_text(x.spot.num, x.spot.den, env) }) }),
      h('td', { text: diff_text(x) }));
  });
  out.push(h('h4', { id: 'import-fx-title', text: tr('importv11.fx_title', { n: ex.length }) }));
  out.push(h('p', { class: 'muted', text: tr('importv11.fx_note') }));
  out.push(h('div', { class: 'table-wrap' }, h('table', { class: 'tbl import-fx', 'aria-labelledby': 'import-fx-title' },
    h('caption', { class: 'sr-only', text: tr('importv11.fx_title', { n: ex.length }) }),
    h('thead', null, h('tr', null, th(tr('import.th_date')), th(tr('importv11.fx_th_sold')), th(tr('importv11.fx_th_got')), th(tr('importv11.fx_th_rate')), th(tr('importv11.fx_th_spot')), th(tr('importv11.fx_th_diff')))),
    h('tbody', null, rows))));
  if (ex.length > SHOW_ROWS) out.push(h('p', { class: 'muted', text: tr('import.more', { n: ex.length - SHOW_ROWS }) }));
  return out;
}
