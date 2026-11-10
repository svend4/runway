// golden_panel.mjs — панель «Эталон G-001» (REQ-109, IDEA-35, TST-01, TST-02, TST-04): восемь значений канона рядом с тем, что считает движок, и отметка «совпало».
// Ожидаемые значения переписаны из канона дословно (design-brief §9.4, §9.6) и лежат в `data/golden-g001.json`; `GOLDEN` ниже — зеркало этого файла
// (страница не читает JSON: сеть и динамический import разрешены только приложению и манифесту, поэтому значения продублированы, а равенство двух копий
// проверяет tests/showcase.test.mjs). Расхождение эталона и движка блокирует выпуск (тест на всех восьми значениях).
// Вычисление — чистая функция (без DOM): читатель может сверить числа вручную по подсказке «откуда число». Расчёт по введённым данным и правилам, не консультация.

import { narrowest_point, check_purchase, format_date } from '../engine/index.mjs';
import { LABELS } from '../engine/verifier.mjs';
import { h } from './dom.mjs';

/** Зеркало `data/golden-g001.json` (порядок значений — порядок строк панели). */
export const GOLDEN = Object.freeze({
  format: 'runway-golden/1',
  dataset: 'g001',
  workspace_id: 'ws-g001',
  purchase: Object.freeze({ date: '2026-10-12', amount_minor: 30000, currency: 'EUR' }),
  values: Object.freeze([
    Object.freeze({ id: 'G-001.opening', key: 'opening', kind: 'money', expected: 400000, tst: 'TST-01', source: '§9.4' }),
    Object.freeze({ id: 'G-001.end_close', key: 'end_close', kind: 'money_both', expected: 340000, tst: 'TST-01', source: '§9.4' }),
    Object.freeze({ id: 'G-001.q1.min_trough.plan', key: 'min_trough_plan', kind: 'money_date', expected: Object.freeze({ amount_minor: 205500, date: '2026-10-31' }), tst: 'TST-01', source: '§9.4' }),
    Object.freeze({ id: 'G-001.q1.min_trough.worse', key: 'min_trough_worse', kind: 'money_date', expected: Object.freeze({ amount_minor: 183000, date: '2026-11-14' }), tst: 'TST-01', source: '§9.4' }),
    Object.freeze({ id: 'G-001.free.min.plan', key: 'min_free_plan', kind: 'money_date', expected: Object.freeze({ amount_minor: 93500, date: '2026-11-01' }), tst: 'TST-02', source: '§9.4' }),
    Object.freeze({ id: 'G-001.free.min.worse', key: 'min_free_worse', kind: 'money_date', expected: Object.freeze({ amount_minor: 71000, date: '2026-11-14' }), tst: 'TST-02', source: '§9.4' }),
    Object.freeze({ id: 'G-001.reserve_close.end', key: 'reserve_close_end', kind: 'money', expected: 167800, tst: 'TST-02', source: '§9.4' }),
    Object.freeze({ id: 'G-001.q3.treadmill.verdict', key: 'treadmill_verdict', kind: 'verdict', expected: 'FRAGILE', tst: 'TST-04', source: '§9.6' }),
  ]),
});

/** Рабочая область — набор G-001 (по идентификатору); другие наборы сверять с этим эталоном не имеет смысла. */
export function is_golden_workspace(ws, golden = GOLDEN) {
  return ws !== null && typeof ws === 'object' && ws.workspace_id === golden.workspace_id;
}

function first_min(xs, from) {
  let k = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i] < xs[k]) k = i;
  return { amount_minor: xs[k], date: format_date(from + k) };
}

function same(x, y) {
  if (x === y) return true;
  if (x === null || y === null || typeof x !== 'object' || typeof y !== 'object') return false;
  const kx = Object.keys(x);
  const ky = Object.keys(y);
  return kx.length === ky.length && kx.every((k) => Object.hasOwn(y, k) && same(x[k], y[k]));
}

/**
 * Значения движка по ключам эталона (вычисляются из `model.ctx`, а не читаются из данных).
 * @param {{ctx: object}} model
 * @param {typeof GOLDEN} [golden]
 * @returns {Object<string, any>} id → вычисленное значение той же формы, что `expected` (для `money_both` — `{plan, worse}`)
 */
export function compute_golden(model, golden = GOLDEN) {
  const a = model.ctx;
  const trough = (m) => { const np = narrowest_point(a.series[m], a.as_of, a.horizon_end); return { amount_minor: np.amount_minor, date: format_date(np.date) }; };
  const r = check_purchase(a, { currency: a.decision_currency, parts: [{ date: golden.purchase.date, amount_minor: golden.purchase.amount_minor }] }, a.buffer_minor);
  return {
    'G-001.opening': a.series.plan.opening_minor,
    'G-001.end_close': { plan: a.series.plan.close.at(-1), worse: a.series.worse.close.at(-1) },
    'G-001.q1.min_trough.plan': trough('plan'),
    'G-001.q1.min_trough.worse': trough('worse'),
    'G-001.free.min.plan': first_min(a.series.plan.free, a.as_of),
    'G-001.free.min.worse': first_min(a.series.worse.free, a.as_of),
    'G-001.reserve_close.end': a.series.plan.reserve_close.at(-1),
    'G-001.q3.treadmill.verdict': r.kind === 'ok' ? r.verdict : r.kind,
  };
}

/**
 * Строки панели: эталон, вычисленное значение и отметка совпадения.
 * @returns {{id: string, key: string, kind: string, expected: any, computed: any, match: boolean, tst: string, source: string}[]}
 */
export function golden_rows(model, golden = GOLDEN) {
  const c = compute_golden(model, golden);
  return golden.values.map((v) => {
    const computed = c[v.id];
    const match = v.kind === 'money_both' ? computed.plan === v.expected && computed.worse === v.expected : same(v.expected, computed);
    return { id: v.id, key: v.key, kind: v.kind, expected: v.expected, computed, match, tst: v.tst, source: v.source };
  });
}

/** Итог панели: сколько значений совпало (все восемь — «всё совпало»). */
export function golden_summary(rows) {
  const matched = rows.filter((r) => r.match).length;
  return { total: rows.length, matched, all_match: matched === rows.length };
}

// ── DOM ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

function value_text(ctx, kind, v) {
  const f = ctx.fmt();
  const lang = ctx.lang();
  if (kind === 'money') return f.money(v);
  if (kind === 'money_both') return typeof v === 'number' ? f.money(v) : LABELS.modes[lang].plan + ' ' + f.money(v.plan) + ' · ' + LABELS.modes[lang].worse + ' ' + f.money(v.worse);
  if (kind === 'money_date') return f.money(v.amount_minor) + ' · ' + f.date(v.date);
  return LABELS.verdicts[lang][v] ?? String(v);
}

/**
 * Экран «Эталон»: таблица «значение — эталон — расчёт — отметка — тест», итог и подсказка, как сверить вручную.
 * @param {object} ctx
 * @returns {HTMLElement}
 */
export function render_golden(ctx) {
  const tr = ctx.tr;
  const title = h('h2', { id: 'view-title', tabindex: '-1', text: tr('showcase.gd_title') });
  const model = ctx.get_model();
  if (model === null) return h('div', { class: 'view sc-view' }, title, h('p', { text: tr('showcase.no_data') }));
  const ws = ctx.get_ws();
  const rows = golden_rows(model);
  const sum = golden_summary(rows);
  const is_g = is_golden_workspace(ws);
  const body = rows.map((r) => h('tr', { class: r.match ? null : 'mark' },
    h('th', { scope: 'row' }, h('span', { text: tr('showcase.gv_' + r.key) }), h('br'), h('span', { class: 'muted', text: r.id })),
    h('td', { text: value_text(ctx, r.kind, r.expected) }),
    h('td', { text: value_text(ctx, r.kind, r.computed) }),
    h('td', null, h('span', { class: r.match ? 'pos' : 'bad' }, h('span', { 'aria-hidden': 'true', text: r.match ? '✓ ' : '✕ ' }), h('span', { text: r.match ? tr('showcase.gd_match') : tr('showcase.gd_differ') }))),
    h('td', { class: 'muted', text: r.tst + ' · ' + r.source }),
    h('td', { class: 'muted', text: tr('showcase.gh_' + r.key) })));
  return h('div', { class: 'view sc-view' }, title,
    h('p', { class: 'lead', text: tr('showcase.gd_lead') }),
    is_g ? null : h('p', { class: 'banner', role: 'status', text: tr('showcase.gd_other_ds') }),
    h('p', { class: sum.all_match ? 'sc-big pos' : 'sc-big bad', role: 'status', text: tr('showcase.gd_summary', { matched: sum.matched, total: sum.total }) }),
    sum.all_match || !is_g ? null : h('p', { class: 'banner', text: tr('showcase.gd_edited') }),
    h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('caption', { class: 'sr-only', text: tr('showcase.gd_caption') }),
      h('thead', null, h('tr', null, ['showcase.gd_col_value', 'showcase.gd_col_expected', 'showcase.gd_col_computed', 'showcase.gd_col_mark', 'showcase.gd_col_test', 'showcase.gd_col_how'].map((k) => h('th', { scope: 'col', text: tr(k) })))),
      h('tbody', null, body))),
    h('p', { class: 'muted', text: tr('showcase.gd_note') }));
}
