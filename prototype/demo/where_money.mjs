// where_money.mjs — карточка «Куда делись деньги» на «Обзоре» (FP-28, IDEA-41, ADR-016): остаток на счетах складывается из резервов, платежей до узкой точки,
// буфера и свободных денег — и сумма этих статей равна остатку.
//
// Источник чисел — разложение движка `sts_breakdown` («можно потратить» = минимум свободных − буфер): его строки `opening`, `reserves_start`, `payments`, `incomes`, `released`,
// `reserve_adds`, `buffer` в сумме дают `min_free − B`. Карточка переставляет те же строки в четыре статьи остатка:
//   резервы = reserves_start + взносы в резервы − возврат из резервов;
//   платежи = −(payments + incomes)  (платежи до узкой точки включительно за вычетом поступлений до неё);
//   буфер   = B;
//   свободно = Σ строк разложения (меньше нуля — «не хватает до буфера»).
// Тождество: остаток = резервы + платежи + буфер + свободно. Его проверяет модель (`ok`) и тест; на экране оно выводится словами («сходится»), а не цветом.
// «Сходится» — не алгебра: статьи в сумме с самим собой всегда дают остаток, поэтому `where_money_check` сверяет их с независимыми числами — остатком на счетах из ряда движка
// (`series.opening_minor`, а не из разложения) и числом «можно потратить» / «не хватает до буфера» из `safe_to_spend` (свободно = `sts − short_to_buffer`). Разошлись — карточка так и пишет.
// Дату `T` карточка берёт из блока «Можно потратить» на «Обзоре» (`info.sts_t` слота `overview.cards`; пусто — `default_sts_horizon`) и называет её на экране: блок меняет дату на лету, а карточка —
// при следующей отрисовке экрана. Гейт «можно потратить» тот же (`safe_to_spend`): пока данных не хватает, карточки нет.
// Расчёт по введённым данным и правилам, не консультация. Модель чистая (без DOM), узлы строит dom.mjs (только textContent).

import { safe_to_spend, sts_breakdown, default_sts_horizon, to_epoch_day } from '../engine/index.mjs';
import { h, table } from './dom.mjs';
import { open_sts_why } from './why_more.mjs';
import { ask_button } from './ask_button.mjs';
import { LABELS } from '../engine/verifier.mjs';

/**
 * Четыре статьи остатка из строк разложения `sts_breakdown` (перестановка тех же строк, чисел не добавляется).
 * @param {{id: string, v: number}[]} detail строки разложения
 * @returns {{id: 'reserves'|'payments'|'buffer'|'free', v: number}[]}
 */
export function where_money_rows(detail) {
  const v = (id) => detail.find((r) => r.id === id).v;
  const free = detail.reduce((acc, r) => acc + r.v, 0); // = min_free − B (может быть меньше нуля)
  return [
    { id: 'reserves', v: -(v('reserves_start') + v('reserve_adds') + v('released')) }, // −(−резервы_на_начало) − (−взносы) − возврат
    { id: 'payments', v: -(v('payments') + v('incomes')) },
    { id: 'buffer', v: -v('buffer') },
    { id: 'free', v: free },
  ];
}

/**
 * Сверка статей карточки с независимыми числами движка (а не сумма самих с собой).
 * @param {{id: string, v: number}[]} rows четыре статьи (резервы, платежи, буфер, свободно)
 * @param {{id: string, v: number}[]} detail строки `sts_breakdown`
 * @param {number} opening_minor остаток на счетах из ряда движка (`series[mode].opening_minor`)
 * @param {number} sts_minor «можно потратить» из `safe_to_spend`
 * @param {number} short_to_buffer_minor «не хватает до буфера (с учётом резервов)» из `safe_to_spend`
 * @returns {boolean} сумма статей = остаток; строка `opening` разложения = остаток; «свободно» = `sts − short_to_buffer`
 */
export function where_money_check(rows, detail, opening_minor, sts_minor, short_to_buffer_minor) {
  const total = rows.reduce((acc, r) => acc + r.v, 0);
  const free = rows.find((r) => r.id === 'free')?.v;
  const opening_row = detail.find((r) => r.id === 'opening')?.v;
  return total === opening_minor && opening_row === opening_minor && free === sts_minor - short_to_buffer_minor;
}

/**
 * Модель карточки.
 * @param {{ctx: object}} model модель страницы (`ctx` — Analysis)
 * @param {'plan'|'worse'} mode
 * @param {number|string} [T] дата, к которой раскладывается остаток; по умолчанию — как на «Обзоре»; вне горизонта зажимается к его границам, как на «Обзоре»
 * @returns {null | {mode: string, T: number, at: number, opening_minor: number, rows: {id: 'reserves'|'payments'|'buffer'|'free', v: number}[],
 *   total_minor: number, ok: boolean, sts_minor: number, short_to_buffer_minor: number, detail: {id: string, v: number}[]}}
 *   `null` — гейт не пропустил (нет буфера, данные устарели, правило отключено) или нет данных
 */
export function where_money_model(model, mode, T) {
  const a = model?.ctx;
  if (a === undefined || a === null || a.buffer_minor === null || a.buffer_minor === undefined) return null;
  let t;
  let s;
  try {
    t = Math.min(Math.max(to_epoch_day(T ?? default_sts_horizon(a)), a.as_of), a.horizon_end);
    s = safe_to_spend(a, t, null, mode);
  } catch { return null; }
  if (s.kind === 'insufficient_data') return null;
  const detail = sts_breakdown(a, t, null, mode);
  const rows = where_money_rows(detail);
  const total = rows.reduce((acc, r) => acc + r.v, 0);
  const opening = a.series[mode].opening_minor;
  return {
    mode, T: t, at: s.at, opening_minor: opening, rows, total_minor: total, ok: where_money_check(rows, detail, opening, s.sts, s.short_to_buffer),
    sts_minor: s.sts, short_to_buffer_minor: s.short_to_buffer, detail,
  };
}

/**
 * Карточка «Куда делись деньги» для слота `overview.cards`.
 * @param {object} ctx контекст расширений
 * @param {{sts_t?: string|null}} [info] описание места вызова: дата из поля «Можно потратить до даты» (ISO) или `null` — по умолчанию
 * @returns {HTMLElement|null} `null` — карточки нет (нет данных, гейт не пропустил или остатка ещё нет)
 */
export function render_where_money(ctx, info) {
  const model = ctx.get_model();
  if (model === null || model === undefined) return null;
  const a = model.ctx;
  if (a.readiness.score < (a.params['ready.q1'] ?? 3)) return null; // как «Обзор»: без готовности вместо карточек стоит плашка
  const mode = ctx.mode();
  const asked = info !== null && typeof info === 'object' && typeof info.sts_t === 'string' && info.sts_t !== '' ? info.sts_t : undefined; // чужое или пустое описание — дата по умолчанию
  let w = where_money_model(model, mode, asked);
  if (w === null && asked !== undefined) w = where_money_model(model, mode); // нечитаемая дата из чужого описания не убирает карточку
  if (w === null) return null;
  const f = ctx.fmt();
  const label = (r) => {
    if (r.id === 'free') return ctx.tr(r.v < 0 ? 'feedx.wm_short' : 'feedx.wm_free');
    if (r.id === 'payments') return ctx.tr('feedx.wm_payments', { at: f.date(w.at) });
    return ctx.tr('feedx.wm_' + r.id);
  };
  const body = w.rows.map((r) => h('tr', null, h('th', { scope: 'row', text: label(r) }), h('td', { class: 'num', text: f.money(r.v) })));
  body.push(h('tr', { class: 'total' }, h('th', { scope: 'row', text: ctx.tr('feedx.wm_total', { date: f.date(a.as_of) }) }), h('td', { class: 'num', text: f.money(w.total_minor) })));
  return h('section', { class: 'card feedx-where', 'aria-labelledby': 'feedx-where-h' },
    h('h3', { id: 'feedx-where-h', text: ctx.tr('feedx.wm_title') }),
    h('p', { class: 'muted', text: ctx.tr('feedx.wm_lead', { date: f.date(a.as_of), opening: f.money(w.opening_minor), at: f.date(w.at), mode: LABELS.modes[ctx.lang()]?.[mode] ?? mode }) }),
    h('p', { class: 'muted feedx-wm-until', text: ctx.tr('feedx.wm_until', { date: f.date(w.T) }) }),
    h('div', { class: 'table-wrap' }, table(ctx.tr('feedx.wm_caption'), [ctx.tr('feedx.col_item'), ctx.tr('feedx.col_amount')], body)),
    h('p', { class: w.ok ? 'muted why-check ok' : 'banner short why-check', role: w.ok ? null : 'alert',
      text: ctx.tr(w.ok ? 'feedx.wm_check' : 'feedx.wm_check_bad', { sum: f.money(w.total_minor), opening: f.money(w.opening_minor) }) }),
    h('p', { class: 'actions' },
      h('button', { type: 'button', class: 'link', onclick: () => open_sts_why(ctx, mode), text: ctx.tr('feedx.wm_how') }), ' ',
      ask_button(ctx, ctx.tr('as.q_why'), ctx.tr('feedx.wm_title'))));
}
