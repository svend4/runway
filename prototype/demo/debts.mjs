// debts.mjs — экран «Долги» (REQ-082, REQ-083, ALG-09, IDEA-22): график аннуитета / дифференцированных платежей / рассрочки, «что если досрочно»
// (`prepay`: срок короче или платёж ниже), сверка с банком (`reanchor` и допуск `debt.drift_tol_bp`), предупреждение о платежах за горизонтом
// и влияние долга на прогноз. Все числа — из `debt.mjs` движка; здесь только разбор формы, сводки и показ.
// График по модели не равен договору банка (дни, комиссии, плавающая ставка): это расчёт по введённым данным, не консультация.
// Сам калькулятор ничего не записывает в данные: долг из формы лишь примеряется к копии рабочей области, чтобы показать влияние на «свободно».
// Запись долга в прогноз (форма «Добавить в прогноз», сохранённые долги, досрочное погашение и сверка с банком, которые меняют сохранённый график) —
// пакет FP-14 (`debt_edit.mjs`, `pack_fp14.mjs`): он подключает свои блоки через `register_debt_block` (без обратного импорта; без пакета экран работает как прежде).
// Модели чистые (без DOM) — в первой половине файла; DOM-часть — `render_debts`.

import {
  amortization_schedule, prepay, reanchor, schedule_to_events, analyze, add_months, to_epoch_day, format_date, currency_exponent, sum_minor, round_div,
} from '../engine/index.mjs';
import { DEBT_DEFAULTS, drift_tol_bp, rounding_of } from '../engine/debt_ext.mjs';
import { h, table } from './dom.mjs';
import { parse_amount_text, parse_decimal_text, format_input_amount, resolve_number_format } from './number_format.mjs';
import { engine_error_text } from './store_mode.mjs';
import { LABELS } from '../engine/verifier.mjs';

export const DEBT_KINDS = Object.freeze(['annuity', 'differential', 'installment_0']);

/** Допуск дрейфа по умолчанию (bp), гипотеза v2: `vocab.json → params.debt.drift_tol_bp`; значение берётся из общей таблицы умолчаний долгов движка (`DEBT_DEFAULTS`). */
export const DRIFT_TOL_DEFAULT_BP = DEBT_DEFAULTS['debt.drift_tol_bp'];

const MAX_ROWS_SHOWN = 600;

// ── разбор формы ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Разобрать поля формы долга без float. Ставка «12» или «12,5» → bp (1200 / 1250).
 * @param {{principal: string, rate: string, n: string, kind: string, start: string}} t тексты полей
 * @param {{cur: string, lang: 'ru'|'en', nf?: any}} env
 * @returns {{ok: true, value: {principal_minor: number, rate_bp: number, n: number, kind: string, start_date: string}}|{ok: false, errors: Object<string, string>}}
 */
export function parse_debt_form(t, env) {
  const errors = {};
  const p = parse_amount_text(String(t.principal ?? ''), env.cur, env.lang, env.nf);
  if (!p.ok || p.value < 1) errors.principal = p.ok ? 'zero' : p.reason;
  const rate_text = String(t.rate ?? '').replace(/%/g, '').trim();
  const r = parse_decimal_text(rate_text, { exponent: 2, lang: env.lang, nf: env.nf });
  if (!r.ok) errors.rate = r.reason;
  const n_text = String(t.n ?? '').trim();
  const n = /^\d{1,3}$/.test(n_text) ? Number(n_text) : null;
  if (n === null || n < 1) errors.n = 'bad_number';
  if (!DEBT_KINDS.includes(t.kind)) errors.kind = 'bad_kind';
  let start = null;
  try { start = /^\d{4}-\d{2}-\d{2}$/.test(String(t.start ?? '')) && format_date(to_epoch_day(t.start)) === t.start ? t.start : null; } catch { start = null; }
  if (start === null) errors.start = 'bad_date';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { principal_minor: p.value, rate_bp: r.value, n, kind: t.kind, start_date: start } };
}

/** Операционный счёт платежей: первый счёт `operating` в валюте решения (иначе `null`). */
export function pay_account_of(ws, cur) {
  const acc = (ws?.accounts ?? []).find((x) => x.liquidity === 'operating' && x.currency === cur);
  return acc === undefined ? null : acc.account_id;
}

/**
 * План долга `DebtPlan` из значений формы (идентификатор служебный, график считается по полям). Режим округления — рабочей области (`params.rounding`):
 * тот же, с которым долг записывается в прогноз (`upsert_debt`), поэтому показанный график равен записанному до minor. Он лежит в плане, и по плану его берут
 * `prepay`, `reanchor` и `schedule_to_events` ядра.
 * @returns {{ok: true, plan: object}|{ok: false, code: string}}
 */
export function make_plan(model, v) {
  const pay = pay_account_of(model.ws, model.cur);
  if (pay === null) return { ok: false, code: 'no_pay_account' };
  const kind = v.kind === 'annuity' && v.rate_bp === 0 ? 'installment_0' : v.kind;
  return {
    ok: true,
    plan: { debt_id: 'debt_calc', pay_account_id: pay, currency: model.cur, kind, principal_minor: v.principal_minor, rate_bp: v.rate_bp, n: v.n, start_date: v.start_date, rounding: rounding_of(model.ws?.params) },
  };
}

// ── сводки ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Сводка графика: платежи, проценты (переплата), первый и последний платёж, дата последнего.
 * Сумма платежей = остаток долга + проценты — для любого графика движка.
 * @param {{k: number, date: number, payment_minor: number, interest_minor: number, principal_minor: number, balance_minor: number}[]} rows
 * @param {number} principal_minor
 */
export function debt_summary(rows, principal_minor) {
  const total = sum_minor(rows.map((r) => r.payment_minor));
  const interest = sum_minor(rows.map((r) => r.interest_minor));
  return {
    count: rows.length,
    total_minor: total,
    interest_minor: interest,
    overpay_minor: total - principal_minor,
    first_payment_minor: rows[0].payment_minor,
    last_payment_minor: rows[rows.length - 1].payment_minor,
    last_date: format_date(rows[rows.length - 1].date),
    closes_at_zero: rows[rows.length - 1].balance_minor === 0,
  };
}

/**
 * Платежи за горизонтом прогноза: их в расчёт «свободно» нет (предупреждение, как для частей покупки, W_PART_BEYOND_HORIZON).
 * @returns {{inside: {count: number, total_minor: number}, beyond: {count: number, total_minor: number, first_date: string|null}}}
 */
export function beyond_horizon(rows, horizon_end) {
  const inside = rows.filter((r) => r.date <= horizon_end);
  const beyond = rows.filter((r) => r.date > horizon_end);
  return {
    inside: { count: inside.length, total_minor: sum_minor(inside.map((r) => r.payment_minor)) },
    beyond: { count: beyond.length, total_minor: sum_minor(beyond.map((r) => r.payment_minor)), first_date: beyond.length === 0 ? null : format_date(beyond[0].date) },
  };
}

function first_min_free(a, mode) {
  const xs = a.series[mode].free;
  let k = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i] < xs[k]) k = i;
  return { amount_minor: xs[k], date: format_date(a.as_of + k) };
}

/**
 * Влияние долга на прогноз: минимум «свободно» по режимам до и после добавления платежей в копию рабочей области (данные не меняются).
 * @returns {{ok: true, per_mode: Object<string, {before: object, after: object, delta_minor: number}>}|{ok: false, code: string}}
 */
export function debt_impact(model, plan) {
  try {
    const ws = model.ws;
    const q = { as_of: ws.as_of };
    const before = analyze(ws, q);
    const ws2 = { ...ws, debts: [...(Array.isArray(ws.debts) ? ws.debts : []), plan] };
    const after = analyze(ws2, q);
    const per_mode = {};
    for (const m of ['plan', 'worse']) {
      const b = first_min_free(before, m);
      const x = first_min_free(after, m);
      per_mode[m] = { before: b, after: x, delta_minor: x.amount_minor - b.amount_minor };
    }
    return { ok: true, per_mode };
  } catch (e) {
    return { ok: false, code: typeof e?.code === 'string' ? e.code : 'E_SCHEMA' };
  }
}

/** Платёжные события плана (для проверки «график → плановые обязательства»): число и сумма по датам горизонта. */
export function plan_events_in_horizon(plan, as_of, horizon_end) {
  const ev = schedule_to_events(plan).filter((e) => e.date >= as_of && e.date <= horizon_end);
  return { count: ev.length, total_minor: -sum_minor(ev.map((e) => e.amount_minor)) };
}

/**
 * «Что если досрочно»: оба варианта — `shorten` (срок короче, платёж прежний) и `lower_payment` (срок прежний, платёж ниже) — рядом с базовым графиком.
 * @param {object} plan
 * @param {number} k платёж, после которого вносится сумма (1…n−1)
 * @param {number} amount_minor
 * @returns {{ok: true, base: object, options: Object<string, object>}|{ok: false, code: string, reason: string|null}}
 */
export function prepay_compare(plan, k, amount_minor) {
  try {
    const base_rows = amortization_schedule({ principal: plan.principal_minor, rate_bp: plan.rate_bp, n: plan.n, start: plan.start_date, kind: plan.kind, rounding: plan.rounding });
    const base = debt_summary(base_rows, plan.principal_minor);
    if (!Number.isInteger(k) || k < 1 || k >= base_rows.length) return { ok: false, code: 'E_SCHEMA', reason: 'prepay_k_out_of_range' };
    const date = base_rows[k - 1].date;
    const options = {};
    for (const opt of ['shorten', 'lower_payment']) {
      const rows = prepay(plan, amount_minor, date, opt);
      const s = debt_summary(rows, plan.principal_minor);
      // выплачено всего с учётом внесённой суммы; экономия на процентах относительно базового графика
      const total_with_extra = s.total_minor + amount_minor;
      options[opt] = {
        rows,
        count: s.count,
        last_date: s.last_date,
        next_payment_minor: rows.length > k ? rows[k].payment_minor : 0,
        total_with_extra_minor: total_with_extra,
        interest_minor: s.interest_minor,
        saved_interest_minor: base.interest_minor - s.interest_minor,
        fewer_payments: base.count - s.count,
      };
    }
    return { ok: true, base, options, date: format_date(date) };
  } catch (e) {
    return { ok: false, code: typeof e?.code === 'string' ? e.code : 'E_SCHEMA', reason: typeof e?.ctx?.reason === 'string' ? e.ctx.reason : null };
  }
}

/**
 * Сверка с банком: после `k` платежей банк показал остаток `observed`. Дрейф = наблюдаемый − модельный; в bp он считается от модельного остатка
 * (целочисленно); допуск — `debt.drift_tol_bp` (гипотеза, проверяет вызывающий, здесь — он).
 * @param {object} plan
 * @param {number} k
 * @param {number} observed_minor
 * @param {number} [tol_bp]
 * @returns {{ok: true, drift_minor: number, drift_bp: number, tol_bp: number, over_tolerance: boolean, modeled_minor: number, schedule: object[], summary: object|null}|{ok: false, code: string, reason: string|null}}
 */
export function reanchor_check(plan, k, observed_minor, tol_bp = DRIFT_TOL_DEFAULT_BP) {
  try {
    const base_rows = amortization_schedule({ principal: plan.principal_minor, rate_bp: plan.rate_bp, n: plan.n, start: plan.start_date, kind: plan.kind, rounding: plan.rounding });
    const r = reanchor(plan, k, observed_minor);
    const modeled = base_rows[k - 1].balance_minor;
    const abs = Math.abs(r.drift);
    const drift_bp = modeled === 0 ? (abs === 0 ? 0 : 10000) : round_div(abs * 10000, modeled);
    const tail = r.schedule.slice(k);
    return {
      ok: true,
      drift_minor: r.drift,
      drift_bp: r.drift < 0 ? -drift_bp : drift_bp,
      tol_bp,
      over_tolerance: drift_bp > tol_bp,
      modeled_minor: modeled,
      schedule: r.schedule,
      summary: tail.length === 0 ? null : debt_summary(tail, observed_minor),
    };
  } catch (e) {
    return { ok: false, code: typeof e?.code === 'string' ? e.code : 'E_SCHEMA', reason: typeof e?.ctx?.reason === 'string' ? e.ctx.reason : null };
  }
}

/** Допуск дрейфа из параметров рабочей области (целое ≥ 0), иначе значение по умолчанию. */
export function drift_tol_of(ws) {
  return drift_tol_bp(ws?.params);
}

// ── точки расширения (FP-14) ────────────────────────────────────────────────────────────────────────────────────────

/** Места для блоков пакета «долг в прогнозе»: `saved` — над калькулятором (`render(ctx, {model})`), `calc_actions` — под расчётом (`render(ctx, {model, plan, rows, touched})`; `touched` — менял ли пользователь поля: пока нет, в форме пример, а не его данные). */
export const DEBT_BLOCK_SLOTS = Object.freeze(['saved', 'calc_actions']);
const BLOCKS = new Map(DEBT_BLOCK_SLOTS.map((slot) => [slot, new Map()]));

/**
 * Подключить блок к экрану «Долги». Повтор идентификатора заменяет блок (пакет может загрузиться дважды в одном процессе).
 * @param {'saved'|'calc_actions'} slot
 * @param {string} id
 * @param {(ctx: object, arg: object) => Node|Node[]|null} render
 * @returns {() => void} снятие блока
 */
export function register_debt_block(slot, id, render) {
  if (!BLOCKS.has(slot)) throw new TypeError('register_debt_block: неизвестное место ' + String(slot));
  if (typeof id !== 'string' || id === '' || typeof render !== 'function') throw new TypeError('register_debt_block: нужны идентификатор и функция');
  BLOCKS.get(slot).set(id, render);
  return () => { if (BLOCKS.get(slot).get(id) === render) BLOCKS.get(slot).delete(id); };
}

/** Узлы блоков места; упавший блок заменяется плашкой, остальной экран цел. */
function block_nodes(slot, ctx, arg) {
  const out = [];
  for (const [id, render] of BLOCKS.get(slot)) {
    try { out.push(...[render(ctx, arg)].flat(Infinity).filter((n) => n !== null && n !== undefined && typeof n === 'object' && n.nodeType === 1)); } catch {
      out.push(h('p', { class: 'banner short', role: 'alert', text: ctx.tr('ext.block_failed', { id: 'debts/' + id }) }));
    }
  }
  return out;
}

/** Значения формы по умолчанию — пример REQ-082: 1 200,00 € под 12 % на 6 платежей, первый платёж через месяц от даты расчёта. */
export function default_form(model, lang) {
  const exp = currency_exponent(model.cur);
  const nf = resolve_number_format(lang, model.ws.number_format);
  return {
    principal: format_input_amount(120000, exp, nf, true),
    rate: '12',
    n: '6',
    kind: 'annuity',
    start: format_date(add_months(to_epoch_day(model.ws.as_of), 1)),
  };
}

// ── DOM ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const form_state = { values: null, touched: false, prepay_k: '1', prepay_amount: '', reanchor_k: '1', reanchor_observed: '' }; // touched: пользователь менял поля (пример по умолчанию — не его данные)

function schedule_table(ctx, rows, f) {
  const tr = ctx.tr;
  const shown = rows.slice(0, MAX_ROWS_SHOWN);
  return h('div', { class: 'table-wrap' }, table(tr('showcase.db_sched_caption'),
    ['showcase.db_col_k', 'showcase.db_col_date', 'showcase.db_col_payment', 'showcase.db_col_interest', 'showcase.db_col_principal', 'showcase.db_col_balance'].map((k) => tr(k)),
    shown.map((r) => h('tr', null,
      h('th', { scope: 'row', text: String(r.k) }), h('td', { text: f.date(r.date) }), h('td', { text: f.money(r.payment_minor) }),
      h('td', { text: f.money(r.interest_minor) }), h('td', { text: f.money(r.principal_minor) }), h('td', { text: f.money(r.balance_minor) }))), 'tbl'));
}

function field_error(ctx, errors, key) {
  return errors[key] === undefined ? '' : ctx.tr('showcase.db_e_' + errors[key]);
}

/**
 * Экран «Долги».
 * @param {object} ctx
 * @returns {HTMLElement}
 */
export function render_debts(ctx) {
  const tr = ctx.tr;
  const title = h('h2', { id: 'view-title', tabindex: '-1', text: tr('showcase.db_title') });
  const model = ctx.get_model();
  if (model === null) return h('div', { class: 'view sc-view' }, title, h('p', { text: tr('showcase.no_data') }));
  const lang = ctx.lang();
  const f = ctx.fmt();
  const env = { cur: model.cur, lang, nf: model.ws.number_format };
  form_state.values ??= default_form(model, lang);
  const v0 = form_state.values;

  const mk = (id, label_key, value, extra = {}) => {
    const input = h('input', { id: 'sc-db-' + id, type: 'text', autocomplete: 'off', spellcheck: 'false', value, 'aria-describedby': 'sc-db-' + id + '-err', ...extra });
    const err = h('p', { id: 'sc-db-' + id + '-err', class: 'error', role: 'alert' });
    return { input, err, wrap: h('div', { class: 'field' }, h('label', { for: 'sc-db-' + id, text: tr(label_key, { cur: model.cur }) }), input, err) };
  };
  const f_principal = mk('principal', 'showcase.db_f_principal', v0.principal, { inputmode: 'decimal' });
  const f_rate = mk('rate', 'showcase.db_f_rate', v0.rate, { inputmode: 'decimal' });
  const f_n = mk('n', 'showcase.db_f_n', v0.n, { inputmode: 'numeric' });
  const f_start = mk('start', 'showcase.db_f_start', v0.start, { type: 'date' });
  const kind = h('select', { id: 'sc-db-kind', 'aria-label': tr('showcase.db_f_kind') },
    DEBT_KINDS.map((k) => h('option', { value: k, selected: v0.kind === k, text: tr('showcase.db_kind_' + k) })));
  const out = h('div', { 'aria-live': 'polite' });

  const update = () => {
    const t = { principal: f_principal.input.value, rate: f_rate.input.value, n: f_n.input.value, kind: kind.value, start: f_start.input.value };
    Object.assign(form_state.values, t);
    const parsed = parse_debt_form(t, env);
    const errs = parsed.ok ? {} : parsed.errors;
    for (const [fld, k] of [[f_principal, 'principal'], [f_rate, 'rate'], [f_n, 'n'], [f_start, 'start']]) {
      fld.err.textContent = field_error(ctx, errs, k);
      fld.input.setAttribute('aria-invalid', errs[k] === undefined ? 'false' : 'true');
    }
    if (!parsed.ok) { out.replaceChildren(h('p', { class: 'banner', role: 'status', text: tr('showcase.db_fix') })); return; }
    const mp = make_plan(model, parsed.value);
    if (!mp.ok) { out.replaceChildren(h('p', { class: 'banner short', role: 'alert', text: tr('showcase.db_no_account') })); return; }
    let rows;
    try {
      rows = amortization_schedule({ principal: mp.plan.principal_minor, rate_bp: mp.plan.rate_bp, n: mp.plan.n, start: mp.plan.start_date, kind: mp.plan.kind, rounding: mp.plan.rounding });
    } catch (e) {
      out.replaceChildren(h('p', { class: 'banner short', role: 'alert', text: tr('showcase.db_failed', { reason: engine_error_text(ctx, e) }) }));
      return;
    }
    const sum = debt_summary(rows, mp.plan.principal_minor);
    const bh = beyond_horizon(rows, model.ctx.horizon_end);
    const nodes = [];
    nodes.push(h('section', { class: 'card' }, h('h3', { text: tr('showcase.db_sum_title') }),
      h('dl', { class: 'sc-dl' },
        ...[
          ['showcase.db_sum_payment', mp.plan.kind === 'differential' ? f.money(sum.first_payment_minor) + ' → ' + f.money(sum.last_payment_minor) : f.money(sum.first_payment_minor)],
          ['showcase.db_sum_last', f.money(sum.last_payment_minor) + ' · ' + f.date(sum.last_date)],
          ['showcase.db_sum_total', f.money(sum.total_minor)],
          ['showcase.db_sum_overpay', f.money(sum.overpay_minor)],
        ].flatMap(([k, val]) => [h('dt', { text: tr(k) }), h('dd', { text: val })])),
      h('p', { class: 'muted', text: tr('showcase.db_model_note') })));
    if (bh.beyond.count > 0) {
      nodes.push(h('p', { class: 'banner', role: 'status', text: tr('showcase.db_beyond', { n: bh.beyond.count, total: f.money(bh.beyond.total_minor), date: f.date(bh.beyond.first_date), horizon: f.date(model.ctx.horizon_end) }) }));
    }
    const imp = debt_impact(model, mp.plan);
    if (imp.ok) {
      const modes = ['plan', 'worse'];
      nodes.push(h('section', { class: 'card' }, h('h3', { text: tr('showcase.db_impact_title') }),
        h('p', { class: 'muted', text: tr('showcase.db_impact_lead', { n: bh.inside.count, total: f.money(bh.inside.total_minor) }) }),
        table(tr('showcase.db_impact_caption'), [tr('showcase.db_col_mode'), tr('showcase.db_col_before'), tr('showcase.db_col_after')],
          modes.map((m) => h('tr', null, h('th', { scope: 'row', text: LABELS.modes[lang][m] }),
            h('td', { text: f.money(imp.per_mode[m].before.amount_minor) + ' · ' + f.date(imp.per_mode[m].before.date) }),
            h('td', { text: f.money(imp.per_mode[m].after.amount_minor) + ' · ' + f.date(imp.per_mode[m].after.date) }))), 'tbl')));
    } else nodes.push(h('p', { class: 'muted', text: tr('showcase.db_impact_failed') }));
    nodes.push(...block_nodes('calc_actions', ctx, { model, plan: mp.plan, rows, touched: form_state.touched }));
    nodes.push(h('details', { class: 'card', open: true }, h('summary', { text: tr('showcase.db_sched_title') }), schedule_table(ctx, rows, f)));
    nodes.push(prepay_section(ctx, model, mp.plan, rows, f));
    nodes.push(reanchor_section(ctx, model, mp.plan, rows, f));
    out.replaceChildren(...nodes);
  };

  const edited = () => { form_state.touched = true; update(); };
  for (const el of [f_principal.input, f_rate.input, f_n.input, f_start.input]) el.addEventListener('input', edited);
  kind.addEventListener('change', edited);
  update();
  return h('div', { class: 'view sc-view' }, title,
    h('p', { class: 'lead', text: tr('showcase.db_lead') }),
    ...block_nodes('saved', ctx, { model }),
    h('section', { class: 'card' }, h('h3', { text: tr('showcase.db_form_title') }),
      h('div', { class: 'grid' }, f_principal.wrap, f_rate.wrap, f_n.wrap, f_start.wrap,
        h('div', { class: 'field' }, h('label', { for: 'sc-db-kind', text: tr('showcase.db_f_kind') }), kind))),
    out,
    h('p', { class: 'muted', text: tr('showcase.tax_note') }));
}

function prepay_section(ctx, model, plan, rows, f) {
  const tr = ctx.tr;
  const lang = ctx.lang();
  const nf = model.ws.number_format;
  const k_in = h('select', { id: 'sc-db-pk', 'aria-label': tr('showcase.db_pp_k') },
    rows.slice(0, -1).map((r) => h('option', { value: String(r.k), selected: form_state.prepay_k === String(r.k), text: tr('showcase.db_pp_after', { k: r.k, date: f.date(r.date) }) })));
  const amt = h('input', { id: 'sc-db-pa', type: 'text', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false', value: form_state.prepay_amount, 'aria-describedby': 'sc-db-pa-err' });
  const err = h('p', { id: 'sc-db-pa-err', class: 'error', role: 'alert' });
  const res = h('div', { 'aria-live': 'polite' });
  const run = () => {
    form_state.prepay_k = k_in.value;
    form_state.prepay_amount = amt.value;
    err.textContent = '';
    res.replaceChildren();
    if (amt.value.trim() === '') { res.replaceChildren(h('p', { class: 'muted', text: tr('showcase.db_pp_hint') })); return; }
    const p = parse_amount_text(amt.value, model.cur, lang, nf);
    if (!p.ok || p.value < 1) { err.textContent = tr('showcase.db_e_' + (p.ok ? 'zero' : p.reason)); return; }
    const r = prepay_compare(plan, Number(k_in.value), p.value);
    if (!r.ok) { err.textContent = tr('showcase.db_pp_failed', { reason: r.reason === 'prepay_amount_out_of_range' ? tr('showcase.db_pp_range') : ctx.tr('err.' + r.code) }); return; }
    const cols = ['shorten', 'lower_payment'];
    res.replaceChildren(
      table(tr('showcase.db_pp_caption', { date: f.date(r.date) }),
        [tr('showcase.db_pp_col_what'), tr('showcase.db_pp_base'), tr('showcase.db_pp_shorten'), tr('showcase.db_pp_lower')],
        [
          h('tr', null, h('th', { scope: 'row', text: tr('showcase.db_pp_row_count') }), h('td', { text: String(r.base.count) }), ...cols.map((o) => h('td', { text: String(r.options[o].count) }))),
          h('tr', null, h('th', { scope: 'row', text: tr('showcase.db_pp_row_last') }), h('td', { text: f.date(r.base.last_date) }), ...cols.map((o) => h('td', { text: f.date(r.options[o].last_date) }))),
          h('tr', null, h('th', { scope: 'row', text: tr('showcase.db_pp_row_next') }), h('td', { text: f.money(rows[Number(k_in.value)].payment_minor) }), ...cols.map((o) => h('td', { text: f.money(r.options[o].next_payment_minor) }))),
          h('tr', null, h('th', { scope: 'row', text: tr('showcase.db_pp_row_interest') }), h('td', { text: f.money(r.base.interest_minor) }), ...cols.map((o) => h('td', { text: f.money(r.options[o].interest_minor) }))),
          h('tr', null, h('th', { scope: 'row', text: tr('showcase.db_pp_row_saved') }), h('td', { text: '—' }), ...cols.map((o) => h('td', { text: f.money(r.options[o].saved_interest_minor) }))),
        ], 'tbl'),
      h('p', { class: 'muted', text: tr('showcase.db_pp_note') }));
  };
  k_in.addEventListener('change', run);
  amt.addEventListener('input', run);
  run();
  return h('section', { class: 'card' }, h('h3', { text: tr('showcase.db_pp_title') }), h('p', { class: 'muted', text: tr('showcase.db_pp_lead') }),
    h('div', { class: 'grid' },
      h('div', { class: 'field' }, h('label', { for: 'sc-db-pk', text: tr('showcase.db_pp_k') }), k_in),
      h('div', { class: 'field' }, h('label', { for: 'sc-db-pa', text: tr('showcase.db_pp_amount', { cur: model.cur }) }), amt, err)),
    res);
}

function reanchor_section(ctx, model, plan, rows, f) {
  const tr = ctx.tr;
  const lang = ctx.lang();
  const nf = model.ws.number_format;
  const k_in = h('select', { id: 'sc-db-rk', 'aria-label': tr('showcase.db_ra_k') },
    rows.map((r) => h('option', { value: String(r.k), selected: form_state.reanchor_k === String(r.k), text: tr('showcase.db_ra_after', { k: r.k, date: f.date(r.date) }) })));
  const obs = h('input', { id: 'sc-db-ro', type: 'text', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false', value: form_state.reanchor_observed, 'aria-describedby': 'sc-db-ro-err' });
  const err = h('p', { id: 'sc-db-ro-err', class: 'error', role: 'alert' });
  const res = h('div', { 'aria-live': 'polite' });
  const tol = drift_tol_of(model.ws);
  const run = () => {
    form_state.reanchor_k = k_in.value;
    form_state.reanchor_observed = obs.value;
    err.textContent = '';
    res.replaceChildren();
    if (obs.value.trim() === '') { res.replaceChildren(h('p', { class: 'muted', text: tr('showcase.db_ra_hint') })); return; }
    const p = parse_amount_text(obs.value, model.cur, lang, nf);
    if (!p.ok) { err.textContent = tr('showcase.db_e_' + p.reason); return; }
    const r = reanchor_check(plan, Number(k_in.value), p.value, tol);
    if (!r.ok) { err.textContent = tr('showcase.db_pp_failed', { reason: ctx.tr('err.' + r.code) }); return; }
    const sign = r.drift_minor > 0 ? '+' : '';
    const nodes = [
      h('p', { role: 'status' }, tr('showcase.db_ra_drift', { modeled: f.money(r.modeled_minor), observed: f.money(p.value), drift: sign + f.money(r.drift_minor), bp: f.bp(Math.abs(r.drift_bp)) })),
      h('p', { class: r.over_tolerance ? 'banner tight' : 'muted', text: r.over_tolerance ? tr('showcase.db_ra_over', { tol: f.bp(r.tol_bp) }) : tr('showcase.db_ra_within', { tol: f.bp(r.tol_bp) }) }),
    ];
    if (r.summary === null) nodes.push(h('p', { class: 'muted', text: tr('showcase.db_ra_closed') }));
    else nodes.push(h('p', { text: tr('showcase.db_ra_tail', { n: r.summary.count, payment: f.money(r.summary.first_payment_minor), last: f.date(r.summary.last_date), total: f.money(r.summary.total_minor) }) }));
    res.replaceChildren(...nodes);
  };
  k_in.addEventListener('change', run);
  obs.addEventListener('input', run);
  run();
  return h('section', { class: 'card' }, h('h3', { text: tr('showcase.db_ra_title') }), h('p', { class: 'muted', text: tr('showcase.db_ra_lead', { tol: f.bp(tol) }) }),
    h('div', { class: 'grid' },
      h('div', { class: 'field' }, h('label', { for: 'sc-db-rk', text: tr('showcase.db_ra_k') }), k_in),
      h('div', { class: 'field' }, h('label', { for: 'sc-db-ro', text: tr('showcase.db_ra_observed', { cur: model.cur }) }), obs, err)),
    res);
}
