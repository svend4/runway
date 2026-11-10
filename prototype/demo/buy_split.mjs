// buy_split.mjs — «Купить»: переключатель «разбить на N платежей» и ответ по разбивке (FP-28, ALG-04 A04.5, REQ-044, IDEA-14).
//
// Экран «Купить» (`view_buy` в app.mjs) отвечает по одной сумме; рассрочка раньше жила только в «Формах данных». Теперь под полями суммы и даты есть флажок
// «Разбить на N платежей» (число платежей 2…24 — предел инструмента `check_purchase`, и необязательная годовая ставка): график считает тот же `installment_plan`, что и форма
// «Рассрочка» (без процентов — равные части, с процентами — аннуитет), первый платёж — в выбранную дату, дальше раз в месяц. Ответ по разбивке стоит под основным:
// вердикт `check_purchase` по частям (части за горизонтом в расчёт не входят и названы), график платежей и «с какой даты график держится в буфере» (`earliest_installment_start`:
// сдвиг всего графика через `move_part_date` + `check_purchase`, по режимам). Основной ответ по одной сумме не меняется; запись покупки в данные — по-прежнему в «Формах данных».
// Состояние переключателя живёт в пакете (`deps.ui`), экран только вызывает слоты `buy.form` и `buy.result`. Модель чистая (без DOM), узлы строит dom.mjs (текст — textContent).
// График по модели не равен договору банка; расчёт по введённым данным и правилам, не консультация.

import { check_purchase, format_minor } from '../engine/index.mjs';
import { installment_plan, split_horizon } from '../engine/installment.mjs';
import { earliest_installment_start } from '../engine/installment_earliest.mjs';
import { LABELS } from '../engine/verifier.mjs';
import { word_form } from './i18n.mjs';
import { h, table } from './dom.mjs';
import { env_of, fmt_of, parse_count, parse_percent_bp, first_error, bad, plural_cat, is_checked } from './forms.mjs';
import { RATE_BP_MAX } from './form_installment.mjs';
import { ask_button } from './ask_button.mjs';

/** Границы числа платежей: меньше двух — это не разбивка; больше 24 инструмент `check_purchase` не принимает. */
export const SPLIT_N_MIN = 2;
export const SPLIT_N_MAX = 24;

/** Состояние переключателя на один реестр: включён ли он и что введено в полях. */
export function make_deps() {
  return { ui: { on: false, n: '3', rate: '' } };
}

// ══ 1. Чистые модели ══════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * График разбивки суммы на платежи.
 * @param {object} ws рабочая область (режим округления)
 * @param {{lang: 'ru'|'en', nf?: any, cur?: string, as_of?: string}} env см. `forms.env_of`
 * @param {{total_minor: number, date: string, n_text: string, rate_text?: string}} form
 * @returns {{ok: true, plan: object, parts: {date: string, amount_minor: number}[], n: number, rate_bp: number}|{ok: false, error: {code: string, ctx: object}}}
 */
export function split_plan(ws, env, form) {
  const n = parse_count(form.n_text, 'n', SPLIT_N_MIN, SPLIT_N_MAX);
  const has_rate = typeof form.rate_text === 'string' && form.rate_text.trim() !== '';
  const rate = has_rate ? parse_percent_bp(form.rate_text, env, 'rate', RATE_BP_MAX) : { ok: true, value: 0 };
  const err = first_error([n, rate]);
  if (err !== null) return err;
  const rounding = ws?.params?.rounding === 'half_up' ? 'half_up' : 'half_even'; // график аннуитета знает только эти два режима
  try {
    const plan = installment_plan({ total_minor: form.total_minor, n: n.value, rate_bp: rate.value, start: form.date, kind: rate.value === 0 ? 'installment_0' : 'annuity', rounding });
    return { ok: true, plan, parts: plan.parts, n: n.value, rate_bp: rate.value };
  } catch (e) {
    return bad(typeof e?.code === 'string' ? e.code : 'E_SCHEMA', 'total', typeof e?.ctx?.reason === 'string' ? e.ctx.reason : 'schedule');
  }
}

/**
 * Ответ по разбивке: вердикт по частям и «с какой даты график держится в буфере».
 * @param {{ctx: object}} model модель страницы
 * @param {{date: string, amount_minor: number}[]} parts
 * @returns {{ok: true, verdict: object, earliest: object|null, split: object}|{ok: false, error: {code: string, ctx: object}}}
 *   `earliest = null`, если вердикт не построен (данных не хватает, все части за горизонтом)
 */
export function split_answer(model, parts) {
  const a = model.ctx;
  const purchase = { currency: a.decision_currency, parts };
  try {
    const verdict = check_purchase(a, purchase, null);
    const earliest = verdict.kind === 'ok' ? earliest_installment_start(a, purchase) : null;
    return { ok: true, verdict, earliest, split: split_horizon(parts, a.horizon_end) };
  } catch (e) {
    return bad(typeof e?.code === 'string' ? e.code : 'E_SCHEMA', 'purchase', 'check_failed');
  }
}

// ══ 2. Узлы ═══════════════════════════════════════════════════════════════════════════════════════════════════════════

/** «5 платежей» с учётом склонения. */
export function payments_text(ctx, n) {
  return ctx.tr('feedx.pay_' + plural_cat(ctx.lang(), n), { n });
}

/**
 * Переключатель в карточке полей «Купить» (слот `buy.form`).
 * @param {object} ctx
 * @param {{ui: {on: boolean, n: string, rate: string}}} deps
 * @param {{rerun: () => void}} api пересчёт ответа после смены полей
 * @returns {HTMLElement}
 */
export function render_split_toggle(ctx, deps, api) {
  if (api === null || typeof api !== 'object' || typeof api.rerun !== 'function') return null; // чужое описание места вызова: блок молча пропускается
  const ui = deps.ui;
  const on = h('input', { id: 'bx-on', type: 'checkbox', checked: ui.on ? true : null });
  const n = h('input', { id: 'bx-n', type: 'text', inputmode: 'numeric', autocomplete: 'off', 'aria-describedby': 'bx-hint' });
  n.value = ui.n;
  const rate = h('input', { id: 'bx-rate', type: 'text', inputmode: 'decimal', autocomplete: 'off', 'aria-describedby': 'bx-hint' });
  rate.value = ui.rate;
  const fields = h('div', { class: 'buyx-fields', hidden: ui.on ? null : true },
    h('div', { class: 'field' }, h('label', { for: 'bx-n', text: ctx.tr('feedx.sp_n', { min: SPLIT_N_MIN, max: SPLIT_N_MAX }) }), n),
    h('div', { class: 'field' }, h('label', { for: 'bx-rate', text: ctx.tr('feedx.sp_rate') }), rate),
    h('p', { class: 'muted', id: 'bx-hint', text: ctx.tr('feedx.sp_hint') }));
  on.addEventListener('change', () => {
    ui.on = is_checked(on);
    if (ui.on) fields.removeAttribute('hidden'); else fields.setAttribute('hidden', '');
    api.rerun();
  });
  const read = () => { ui.n = n.value; ui.rate = rate.value; api.rerun(); };
  for (const x of [n, rate]) { x.addEventListener('input', read); x.addEventListener('change', read); }
  return h('div', { class: 'buyx-toggle' },
    h('div', { class: 'field check' }, h('label', { for: 'bx-on' }, on, ' ', ctx.tr('feedx.sp_toggle'))),
    fields);
}

/** Текст «с какой даты держится» для одного режима. */
function start_line(ctx, f, m, x) {
  const mode = LABELS.modes[ctx.lang()]?.[m] ?? m;
  if (x.status === 'now') return ctx.tr('feedx.sp_e_now', { mode, start: f.date(x.start) });
  if (x.status === 'shifted') return ctx.tr('feedx.sp_e_shifted', { mode, start: f.date(x.start), days: x.shift_days + ' ' + word_form(ctx.lang(), 'day', x.shift_days) });
  if (x.status === 'baseline_below_buffer') return ctx.tr('feedx.sp_e_baseline', { mode });
  return ctx.tr('feedx.sp_e_none', { mode });
}

/**
 * Ответ по разбивке под основным ответом «Купить» (слот `buy.result`; зовётся на каждый пересчёт ответа).
 * @param {object} ctx
 * @param {{ui: object}} deps
 * @param {{date: string, amount_minor: number, multi_part: boolean}} info введённые сумма и дата; `multi_part` — выбрана сохранённая покупка по частям
 * @returns {HTMLElement|null} `null` — переключатель выключен или описание места вызова чужое
 */
export function render_split_result(ctx, deps, info) {
  if (!deps.ui.on || info === null || typeof info !== 'object' || typeof info.date !== 'string' || !Number.isSafeInteger(info.amount_minor)) return null;
  const model = ctx.get_model();
  const ws = ctx.get_ws();
  if (model === null || model === undefined || ws === null || ws === undefined) return null;
  if (info.multi_part === true) return h('p', { class: 'muted buyx-multi', text: ctx.tr('feedx.sp_multi') });
  const env = env_of(ctx, ws);
  const f = fmt_of(env);
  const built = split_plan(ws, env, { total_minor: info.amount_minor, date: info.date, n_text: deps.ui.n, rate_text: deps.ui.rate });
  if (!built.ok) {
    const field = built.error?.ctx?.field;
    return h('p', { class: 'error buyx-error', role: 'status', text: ctx.tr(field === 'n' ? 'feedx.sp_bad_n' : field === 'rate' ? 'feedx.sp_bad_rate' : 'feedx.sp_failed', { min: SPLIT_N_MIN, max: SPLIT_N_MAX }) });
  }
  const ans = split_answer(model, built.parts);
  const sec = h('section', { class: 'card buyx-result', 'aria-labelledby': 'buyx-title' },
    h('h4', { id: 'buyx-title', text: ctx.tr('feedx.sp_title', { count: payments_text(ctx, built.parts.length) }) }),
    h('p', { text: ctx.tr('feedx.sp_summary', {
      total: f.money(built.plan.total_minor), interest: f.money(built.plan.interest_minor), first: f.date(built.parts[0].date), last: f.date(built.parts[built.parts.length - 1].date),
    }) }));
  if (!ans.ok) {
    sec.append(h('p', { class: 'error', role: 'status', text: ctx.tr('feedx.sp_failed') }));
    return sec;
  }
  const v = ans.verdict;
  if (v.kind !== 'ok') {
    sec.append(h('p', { class: 'banner', role: 'status', text: ctx.tr('feedx.sp_no_verdict') }));
  } else {
    const e = ans.earliest;
    if (e.beyond_count > 0) sec.append(h('p', { class: 'banner tight', role: 'status', text: ctx.tr('feedx.sp_partial', { checked: e.checked_count, total: e.total_count, beyond: e.beyond_count, sum: f.money(e.beyond_minor) }) }));
    const mode = (m) => LABELS.modes[ctx.lang()]?.[m] ?? m;
    sec.append(
      h('p', { text: ctx.tr('feedx.sp_verdict', {
        verdict: LABELS.verdicts[ctx.lang()][v.verdict], plan: mode('plan'), m_plan: f.money(v.by_mode.plan.m_after), d_plan: f.date(v.by_mode.plan.at),
        worse: mode('worse'), m_worse: f.money(v.by_mode.worse.m_after), d_worse: f.date(v.by_mode.worse.at),
      }) }),
      h('h5', { text: ctx.tr('feedx.sp_e_title') }),
      h('ul', { class: 'plain' }, ['plan', 'worse'].map((m) => h('li', { text: start_line(ctx, f, m, e.by_mode[m]) }))));
  }
  const rows = built.plan.rows.map((r) => h('tr', null, h('td', { text: String(r.k) }), h('td', { text: f.date(r.date) }), h('td', { class: 'num', text: f.money(r.payment_minor) }),
    h('td', { class: 'num', text: f.money(r.interest_minor) }), h('td', { class: 'num', text: f.money(r.balance_minor) })));
  sec.append(
    h('details', { class: 'buyx-schedule' }, h('summary', { text: ctx.tr('feedx.sp_table') }),
      h('div', { class: 'table-wrap' }, table(ctx.tr('feedx.sp_table'), [ctx.tr('feedx.sp_col_k'), ctx.tr('feedx.sp_col_date'), ctx.tr('feedx.sp_col_payment'), ctx.tr('feedx.sp_col_interest'), ctx.tr('feedx.sp_col_balance')], rows))),
    h('p', { class: 'muted', text: ctx.tr('feedx.sp_note') }),
    h('p', { class: 'actions' }, ask_button(ctx, ctx.tr('as.q_when', { amount: format_minor(info.amount_minor, f.exp, { decimal: '.', thousands: '' }) }), ctx.tr('as.t_buy'))));
  return sec;
}
