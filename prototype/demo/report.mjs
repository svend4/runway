// report.mjs — лист для печати (IDEA-22, REQ-132): две режима рядом, таблица значений, версия движка и `inputs_hash`, чтобы лист можно было сверить с экраном.
// Числа берутся из расчёта страницы (`model.ctx`): ряды обоих режимов, узкие точки, `max_amount`, резервы; своих формул здесь нет.
// Модель `report_model` чистая (без DOM и часов: даты — дата расчёта рабочей области). Печать — `window.print()` по кнопке; правила печати — в css/showcase.css.
// Расчёт по введённым данным и правилам, не консультация.

import { narrowest_point, max_amount, gate, format_date } from '../engine/index.mjs';
import { LABELS } from '../engine/verifier.mjs';
import { h, table } from './dom.mjs';
import { make_env, rate_uses, report_note_text, note_node } from './rate_chip.mjs';
import { horizon_rows_of, horizon_ahead_of } from './horizon.mjs'; // FP-49: одно выражение «строк ряда − 1» для шапки, «Запаса хода», листа и «Настроек»

/** Режимы листа: сначала «по плану», затем «если хуже». */
export const REPORT_MODES = Object.freeze(['plan', 'worse']);

function first_min(xs, from) {
  let k = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i] < xs[k]) k = i;
  return { amount_minor: xs[k], date: format_date(from + k) };
}

/**
 * Модель листа.
 * @param {{ws: object, ctx: object, cur: string}} model
 * @returns {{name: string, as_of: string, horizon_end: string, horizon_days: number, horizon_ahead: number, currency: string, buffer: number|null, readiness: number,
 *   engine_version: string, inputs_hash: string,
 *   per_mode: Object<string, {opening: number, end_close: number, narrow: {amount_minor: number, date: string}, min_free: {amount_minor: number, date: string},
 *     reserve_end: number, can_spend: number|null}>,
 *   days: {date: string, plan_close: number, plan_free: number, worse_close: number, worse_free: number}[]}}
 */
export function report_model(model) {
  const a = model.ctx;
  const closed = gate(a, a.buffer_minor) === null; // «можно потратить» отвечает только при достаточных данных (гейт C-018)
  const per_mode = {};
  for (const m of REPORT_MODES) {
    const s = a.series[m];
    const np = narrowest_point(s, a.as_of, a.horizon_end);
    per_mode[m] = {
      opening: s.opening_minor,
      end_close: s.close.at(-1),
      narrow: { amount_minor: np.amount_minor, date: format_date(np.date) },
      min_free: first_min(s.free, a.as_of),
      reserve_end: s.reserve_close.at(-1),
      can_spend: closed ? max_amount(a, a.as_of, a.buffer_minor, m) : null,
    };
  }
  const days = a.series.plan.close.map((_, i) => ({
    date: format_date(a.as_of + i),
    plan_close: a.series.plan.close[i],
    plan_free: a.series.plan.free[i],
    worse_close: a.series.worse.close[i],
    worse_free: a.series.worse.free[i],
  }));
  return {
    name: String(model.ws.name ?? ''),
    as_of: format_date(a.as_of),
    horizon_end: format_date(a.horizon_end),
    horizon_days: horizon_rows_of(a.series),
    horizon_ahead: horizon_ahead_of(a.series), // FP-48: дней вперёд от даты расчёта — то же число, что в «Настройках» и в шапке; horizon_days — строк ряда
    currency: model.cur,
    buffer: a.buffer_minor,
    readiness: a.readiness.score,
    engine_version: a.engine_version,
    inputs_hash: a.inputs_hash,
    per_mode,
    days,
  };
}

// ── DOM ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Экран «Лист для печати»: сводка, таблица значений по двум режимам, таблица по дням, версия движка и хэш входов; кнопка «Печать».
 * @param {object} ctx
 * @returns {HTMLElement}
 */
export function render_report(ctx) {
  const tr = ctx.tr;
  const title = h('h2', { id: 'view-title', tabindex: '-1', text: tr('showcase.rp_title') });
  const model = ctx.get_model();
  if (model === null) return h('div', { class: 'view sc-view' }, title, h('p', { text: tr('showcase.no_data') }));
  const f = ctx.fmt();
  const lang = ctx.lang();
  const r = report_model(model);
  const rate_note = report_note_text(tr, make_env(lang, model.ws, model.ctx), rate_uses(model.ws, model.ctx, model.scenario)); // курсы, по которым пересчитаны суммы листа: события И остатки счетов в чужой валюте (REQ-077, REQ-079)
  const money_date = (x) => f.money(x.amount_minor) + ' · ' + f.date(x.date);
  const cell = (m, fn) => h('td', { text: fn(r.per_mode[m]) });
  const line = (key, fn) => h('tr', null, h('th', { scope: 'row', text: tr(key) }), ...REPORT_MODES.map((m) => cell(m, fn)));
  const values = table(tr('showcase.rp_values_caption'), [tr('showcase.rp_col_value'), ...REPORT_MODES.map((m) => LABELS.modes[lang][m])], [
    line('showcase.rp_opening', (x) => f.money(x.opening)),
    line('showcase.rp_end_close', (x) => f.money(x.end_close)),
    line('showcase.rp_narrow', (x) => money_date(x.narrow)),
    line('showcase.rp_min_free', (x) => money_date(x.min_free)),
    line('showcase.rp_reserve_end', (x) => f.money(x.reserve_end)),
    line('showcase.rp_can_spend', (x) => (x.can_spend === null ? tr('showcase.rp_no_answer') : f.money(x.can_spend))),
  ], 'tbl');
  const days = h('div', { class: 'table-wrap' }, table(tr('showcase.rp_days_caption'),
    ['showcase.rp_col_date', 'showcase.rp_col_plan_close', 'showcase.rp_col_plan_free', 'showcase.rp_col_worse_close', 'showcase.rp_col_worse_free'].map((k) => tr(k)),
    r.days.map((d) => h('tr', null, h('th', { scope: 'row', text: f.date(d.date) }), h('td', { text: f.money(d.plan_close) }), h('td', { text: f.money(d.plan_free) }),
      h('td', { text: f.money(d.worse_close) }), h('td', { text: f.money(d.worse_free) }))), 'tbl'));
  const print_btn = h('button', { type: 'button', class: 'btn primary sc-noprint', text: tr('showcase.rp_print') });
  print_btn.addEventListener('click', () => { if (typeof window !== 'undefined' && typeof window.print === 'function') window.print(); });
  return h('div', { class: 'view sc-view' }, title,
    h('p', { class: 'lead sc-noprint', text: tr('showcase.rp_lead') }),
    h('div', { class: 'actions sc-noprint' }, print_btn),
    h('article', { class: 'rep-sheet', 'aria-label': tr('showcase.rp_sheet') },
      h('h3', { text: tr('showcase.rp_head', { name: r.name === '' ? '—' : r.name }) }),
      h('p', { text: tr('showcase.rp_meta', { date: f.date(r.as_of), horizon: f.date(r.horizon_end), days: r.horizon_ahead, cur: r.currency }) }),
      h('p', { text: r.buffer === null ? tr('showcase.rp_buffer_unset') : tr('showcase.rp_buffer', { value: f.money(r.buffer), score: r.readiness }) }),
      values,
      note_node(rate_note, 'rep-rates'),
      h('h4', { text: tr('showcase.rp_days_title') }), days,
      h('p', { class: 'rep-foot', text: tr('showcase.rp_foot', { version: r.engine_version, hash: r.inputs_hash }) }),
      h('p', { class: 'muted', text: tr('showcase.tax_note') })));
}
