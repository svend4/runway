// ladder.mjs — лестница сумм (UP-02, IDEA-57, ALG-04): на какой дате какие суммы получают какой вердикт. Границы — только из `max_amount` движка:
//   «выдерживает» до S_max(если хуже, с буфером); «хрупко» до S_max(по плану, с буфером); «впритык» до S_max(по плану, без буфера); выше — «не хватает».
// G-001 на дату расчёта: 210,00 / 435,00 / 935,00 € (21000 / 43500 / 93500 minor). Согласованность с `check_purchase` проверяет tests/showcase.test.mjs:
// на каждой границе S и S + 1 дают соседние вердикты. Модель чистая (без DOM); DOM-часть — `render_ladder`. Расчёт по введённым данным и правилам, не консультация.

import { max_amount, check_purchase, gate, to_epoch_day, format_date, currency_exponent } from '../engine/index.mjs';
import { LABELS } from '../engine/verifier.mjs';
import { h, s as svg } from './dom.mjs';
import { parse_amount_text, format_input_amount, resolve_number_format } from './number_format.mjs';
import { verdict_badge, engine_error_text } from './store_mode.mjs';

/** Порядок ступеней снизу вверх. */
export const RUNGS = Object.freeze(['OK', 'FRAGILE', 'TIGHT', 'NO']);

/**
 * Модель лестницы на дату `date` (по умолчанию — дата расчёта).
 * @param {object} a контекст расчёта (`model.ctx`)
 * @param {{date?: string|number}} [o]
 * @returns {{kind: 'ok', date: string, buffer: number, grid: {with_buffer: {plan: number, worse: number}, without_buffer: {plan: number, worse: number}},
 *   bounds: {ok_max: number, fragile_max: number, tight_max: number}, rungs: {verdict: string, from: number, to: number|null}[],
 *   samples: {amount_minor: number, verdict: string}[]}
 *   |{kind: 'insufficient_data', reason: string, reasons: string[]}|{kind: 'outside_horizon', horizon_end: string}}
 * @throws {RunwayError} E_BAD_DATE
 */
export function ladder_model(a, o = {}) {
  const g = gate(a, a.buffer_minor);
  if (g !== null) return { kind: 'insufficient_data', reason: g.reason, reasons: g.reasons };
  const B = a.buffer_minor;
  const d = o.date === undefined || o.date === null ? a.as_of : to_epoch_day(o.date);
  if (d > a.horizon_end) return { kind: 'outside_horizon', horizon_end: format_date(a.horizon_end) };
  const at = Math.max(d, a.as_of);
  const grid = {
    with_buffer: { plan: max_amount(a, at, B, 'plan'), worse: max_amount(a, at, B, 'worse') },
    without_buffer: { plan: max_amount(a, at, 0, 'plan'), worse: max_amount(a, at, 0, 'worse') },
  };
  // границы вердиктов в порядке проверки `verdict_of`: NO → TIGHT → FRAGILE → OK; зажим даёт неубывающие границы
  const tight_max = Math.min(grid.with_buffer.plan, grid.without_buffer.plan);
  const fragile_max = Math.min(grid.with_buffer.worse, tight_max);
  const no_edge = grid.without_buffer.plan;
  const bounds = { ok_max: fragile_max, fragile_max: tight_max, tight_max: no_edge };
  const spans = [['OK', 1, bounds.ok_max], ['FRAGILE', bounds.ok_max + 1, bounds.fragile_max], ['TIGHT', bounds.fragile_max + 1, bounds.tight_max], ['NO', bounds.tight_max + 1, null]];
  const rungs = spans.filter(([, from, to]) => to === null || to >= from).map(([verdict, from, to]) => ({ verdict, from, to }));
  const samples = [];
  for (const r of rungs) {
    if (r.to !== null) samples.push({ amount_minor: r.to, verdict: r.verdict });
    if (r.to !== null) samples.push({ amount_minor: r.to + 1, verdict: verdict_at(rungs, r.to + 1) });
  }
  return { kind: 'ok', date: format_date(at), buffer: B, grid, bounds, rungs, samples };
}

/**
 * Вердикт суммы по лестнице (без повторного вызова движка).
 * @param {{verdict: string, from: number, to: number|null}[]} rungs
 * @param {number} amount_minor
 * @returns {string|null}
 */
export function verdict_at(rungs, amount_minor) {
  for (const r of rungs) if (amount_minor >= r.from && (r.to === null || amount_minor <= r.to)) return r.verdict;
  return null;
}

/**
 * Проверка лестницы движком: вердикт `check_purchase` на сумме и дате совпадает с вердиктом лестницы (используется тестом и подсказкой «проверить»).
 * @returns {{engine: string, ladder: string|null, same: boolean}}
 */
export function cross_check(a, model, amount_minor) {
  const r = check_purchase(a, { currency: a.decision_currency, parts: [{ date: to_epoch_day(model.date), amount_minor }] }, a.buffer_minor);
  const engine = r.kind === 'ok' ? r.verdict : r.kind;
  const ladder = verdict_at(model.rungs, amount_minor);
  return { engine, ladder, same: engine === ladder };
}

// ── DOM ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const view_state = { date: null, amount: '' };
const BAR_W = 640;
const BAR_H = 44;

function ladder_svg(ctx, m, f) {
  const lang = ctx.lang();
  const top = Math.max(1, m.bounds.tight_max + Math.max(1, Math.floor(m.bounds.tight_max / 4)));
  const x_of = (v) => Math.round((Math.min(v, top) / top) * BAR_W);
  const nodes = [];
  for (const r of m.rungs) {
    const x0 = r.from === 1 ? 0 : x_of(r.from - 1);
    const x1 = r.to === null ? BAR_W : x_of(r.to);
    nodes.push(svg('rect', { class: 'lad-seg lad-' + r.verdict, x: x0, y: 0, width: Math.max(1, x1 - x0), height: BAR_H }));
    nodes.push(svg('text', { class: 'lad-label', x: x0 + 6, y: 27, text: LABELS.verdicts[lang][r.verdict] }));
  }
  const ticks = [m.bounds.ok_max, m.bounds.fragile_max, m.bounds.tight_max].filter((v, i, xs) => v > 0 && xs.indexOf(v) === i);
  for (const v of ticks) {
    nodes.push(svg('line', { class: 'lad-tick', x1: x_of(v), y1: 0, x2: x_of(v), y2: BAR_H + 8 }));
    nodes.push(svg('text', { class: 'lad-num', x: x_of(v), y: BAR_H + 22, 'text-anchor': 'middle', text: f.money(v) }));
  }
  return svg('svg', { class: 'lad-svg', viewBox: '0 0 ' + BAR_W + ' ' + (BAR_H + 30), role: 'img', 'aria-label': ctx.tr('showcase.ld_svg_label'), preserveAspectRatio: 'xMinYMin meet' }, nodes);
}

/**
 * Экран «Лестница сумм»: полоса вердиктов по границам из `max_amount`, таблица «режим × буфер», примеры на границах и проверка введённой суммы.
 * @param {object} ctx
 * @returns {HTMLElement}
 */
export function render_ladder(ctx) {
  const tr = ctx.tr;
  const title = h('h2', { id: 'view-title', tabindex: '-1', text: tr('showcase.ld_title') });
  const model = ctx.get_model();
  if (model === null) return h('div', { class: 'view sc-view' }, title, h('p', { text: tr('showcase.no_data') }));
  const a = model.ctx;
  const f = ctx.fmt();
  const lang = ctx.lang();
  const asof_iso = format_date(a.as_of);
  const date_input = h('input', { id: 'sc-ld-date', type: 'date', value: view_state.date ?? asof_iso, min: asof_iso, max: format_date(a.horizon_end), 'aria-describedby': 'sc-ld-hint' });
  const amount_input = h('input', { id: 'sc-ld-amount', type: 'text', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false', value: view_state.amount, 'aria-describedby': 'sc-ld-amount-out' });
  const out = h('div', { class: 'sc-out', 'aria-live': 'polite' });
  const own = h('p', { id: 'sc-ld-amount-out', class: 'muted', role: 'status' });

  const update = () => {
    view_state.date = date_input.value === '' ? null : date_input.value;
    view_state.amount = amount_input.value;
    let m;
    try { m = ladder_model(a, { date: date_input.value === '' ? asof_iso : date_input.value }); } catch (e) {
      out.replaceChildren(h('p', { class: 'banner short', role: 'alert', text: tr('showcase.ld_failed', { reason: engine_error_text(ctx, e) }) }));
      own.textContent = '';
      return;
    }
    if (m.kind !== 'ok') {
      out.replaceChildren(h('p', { class: 'banner', text: m.kind === 'outside_horizon' ? tr('showcase.ld_outside', { date: f.date(m.horizon_end) }) : tr('showcase.ld_gate') }));
      own.textContent = '';
      return;
    }
    const cell = (v) => h('td', { text: f.money(v) });
    const grid = h('table', { class: 'tbl' },
      h('caption', { class: 'sr-only', text: tr('showcase.ld_grid_caption') }),
      h('thead', null, h('tr', null, ['showcase.ld_col_mode', 'showcase.ld_col_with', 'showcase.ld_col_without'].map((k) => h('th', { scope: 'col', text: tr(k) })))),
      h('tbody', null, ['plan', 'worse'].map((md) => h('tr', null, h('th', { scope: 'row', text: LABELS.modes[lang][md] }), cell(m.grid.with_buffer[md]), cell(m.grid.without_buffer[md])))));
    const rungs = h('table', { class: 'tbl' },
      h('caption', { class: 'sr-only', text: tr('showcase.ld_rungs_caption') }),
      h('thead', null, h('tr', null, ['showcase.ld_col_verdict', 'showcase.ld_col_from', 'showcase.ld_col_to'].map((k) => h('th', { scope: 'col', text: tr(k) })))),
      h('tbody', null, m.rungs.map((r) => h('tr', null,
        h('th', { scope: 'row' }, verdict_badge(lang, r.verdict)),
        h('td', { text: f.money(r.from) }),
        h('td', { text: r.to === null ? tr('showcase.ld_no_limit') : f.money(r.to) })))));
    const samples = h('table', { class: 'tbl' },
      h('caption', { class: 'sr-only', text: tr('showcase.ld_samples_caption') }),
      h('thead', null, h('tr', null, ['showcase.ld_col_amount', 'showcase.ld_col_verdict'].map((k) => h('th', { scope: 'col', text: tr(k) })))),
      h('tbody', null, m.samples.map((x) => h('tr', null, h('th', { scope: 'row', text: f.money(x.amount_minor) }), h('td', null, verdict_badge(lang, x.verdict))))));
    out.replaceChildren(
      h('p', { class: 'lead', text: tr('showcase.ld_for', { date: f.date(m.date), buffer: f.money(m.buffer) }) }),
      h('div', { class: 'sc-svg-wrap' }, ladder_svg(ctx, m, f)),
      h('section', { class: 'card' }, h('h3', { text: tr('showcase.ld_rungs_title') }), rungs),
      h('section', { class: 'card' }, h('h3', { text: tr('showcase.ld_grid_title') }), h('p', { class: 'muted', text: tr('showcase.ld_grid_lead') }), grid),
      h('section', { class: 'card' }, h('h3', { text: tr('showcase.ld_samples_title') }), samples));
    own.textContent = '';
    if (amount_input.value.trim() !== '') {
      const p = parse_amount_text(amount_input.value, model.cur, lang, model.ws.number_format);
      if (!p.ok || p.value < 1) own.textContent = tr('showcase.ld_bad_amount', { example: format_input_amount(123450, currency_exponent(model.cur), resolve_number_format(lang, model.ws.number_format)) });
      else own.textContent = tr('showcase.ld_own', { amount: f.money(p.value), verdict: LABELS.verdicts[lang][verdict_at(m.rungs, p.value)] });
    }
  };
  date_input.addEventListener('change', update);
  date_input.addEventListener('input', update);
  amount_input.addEventListener('input', update);
  update();
  return h('div', { class: 'view sc-view' }, title,
    h('p', { class: 'lead', text: tr('showcase.ld_lead') }),
    h('div', { class: 'grid' },
      h('div', { class: 'field' }, h('label', { for: 'sc-ld-date', text: tr('showcase.ld_date') }), date_input, h('p', { id: 'sc-ld-hint', class: 'muted', text: tr('showcase.ld_date_hint', { from: f.date(asof_iso), to: f.date(a.horizon_end) }) })),
      h('div', { class: 'field' }, h('label', { for: 'sc-ld-amount', text: tr('showcase.ld_amount', { cur: model.cur }) }), amount_input, own)),
    out,
    h('p', { class: 'muted', text: tr('showcase.tax_note') }));
}
