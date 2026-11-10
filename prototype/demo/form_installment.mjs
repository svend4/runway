// form_installment.mjs — рассрочка по частям и с процентами (FP-08, REQ-044, REQ-192, ALG-09, ALG-04, IDEA-14).
//
// Покупка — список частей `(дата, сумма)`. Без процентов — равные части (`split_equal`: первые части получают лишний minor); с процентами — график аннуитета или
// дифференцированных платежей `DebtPlan`, превращённый в части покупки с датами договорных платежей, БЕЗ сдвига выходных; перенос платежа — правка даты строки.
// Форма до записи показывает график (платёж, проценты, остаток), итог с переплатой, что внутри горизонта и что за ним, и вердикт «Могу ли я это купить?» (`check_purchase`
// по ЧАСТЯМ, а не всей суммой сразу). Части за горизонтом в «свободно» не входят — это не скрывается: «не все платежи учтены: X за горизонтом».
// График по модели не равен договору банка (дни, комиссии, плавающая ставка): это расчёт по введённым данным, не консультация.
// Файл: чистая часть (разбор формы, расчёт, вердикт) и узлы.

import { check_purchase, to_epoch_day, format_date } from '../engine/index.mjs';
import { installment_plan, purchase_from_parts, move_part_date, split_horizon, INSTALLMENT_KINDS } from '../engine/installment.mjs';
import { LABELS } from '../engine/verifier.mjs';
import { h, table } from './dom.mjs';
import {
  bad, first_error, env_of, fmt_of, parse_money, parse_count, parse_percent_bp, parse_date_input, commit_edits, apply_chain, error_text, text_field, select_field,
  show_field_error, form_card, plural_cat,
} from './forms.mjs';

const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Верхняя граница годовой ставки в форме: 1000 % (предел `validate_debt`, 100000 bp). */
export const RATE_BP_MAX = 100000;

/**
 * Разобрать форму рассрочки и рассчитать график. Ставка пустая или 0 — рассрочка без процентов; иначе вид — `annuity` или `differential`.
 * Необязательный перенос платежа (`move_k` — номер с 1, `move_date`) меняет дату одной части, сумма не меняется.
 * @param {object} ws
 * @param {{name: string, total: string, n: string, rate?: string, kind?: string, start_date: string, move_k?: string, move_date?: string, purchase_id?: string}} t
 * @param {{cur: string, lang: 'ru'|'en', nf?: any, as_of: string}} env
 * @returns {{ok: true, plan: object, parts: {date: string, amount_minor: number}[], purchase: object}|{ok: false, error: object}}
 */
export function build_installment(ws, t, env) {
  if (!is_obj(t)) return bad('E_SCHEMA', 'form', 'not_object');
  const name = typeof t.name === 'string' ? t.name.trim() : '';
  if (name === '') return bad('E_SCHEMA', 'name', 'empty');
  const has = (x) => typeof x === 'string' && x.trim() !== '';
  const total = parse_money(t.total, env, 'total');
  const n = parse_count(t.n, 'n', 1, 120);
  const rate = has(t.rate) ? parse_percent_bp(t.rate, env, 'rate', RATE_BP_MAX) : { ok: true, value: 0 };
  const start = parse_date_input(t.start_date, env, 'start_date');
  const err = first_error([total, n, rate, start]);
  if (err !== null) return err;
  const kind = rate.value === 0 ? 'installment_0' : (t.kind === 'differential' ? 'differential' : 'annuity');
  if (!INSTALLMENT_KINDS.includes(kind)) return bad('E_SCHEMA', 'kind', 'not_in_list');
  const rounding = ws?.params?.rounding === 'half_up' ? 'half_up' : 'half_even'; // график аннуитета знает только эти два режима
  let plan;
  try { plan = installment_plan({ total_minor: total.value, n: n.value, rate_bp: rate.value, start: start.value, kind, rounding }); } catch (e) {
    return bad(typeof e?.code === 'string' ? e.code : 'E_SCHEMA', 'total', typeof e?.ctx?.reason === 'string' ? e.ctx.reason : 'schedule');
  }
  let parts = plan.parts;
  if (has(t.move_date) || has(t.move_k)) {
    const k = parse_count(t.move_k ?? '', 'move_k', 1, parts.length);
    const d = parse_date_input(t.move_date, env, 'move_date');
    const e2 = first_error([k, d]);
    if (e2 !== null) return e2;
    try { parts = move_part_date(parts, k.value - 1, d.value); } catch (e) { return bad(typeof e?.code === 'string' ? e.code : 'E_SCHEMA', 'move_k', 'move'); }
  }
  const purchase = purchase_from_parts(parts, { currency: env.cur, name, purchase_id: t.purchase_id });
  return { ok: true, plan, parts, purchase };
}

/** Правка `add_purchase` из рассчитанной рассрочки. */
export function installment_edit(built) {
  const p = built.purchase;
  const purchase = { name: p.name, currency: p.currency, parts: p.parts };
  if (p.purchase_id !== undefined) purchase.purchase_id = p.purchase_id;
  return { type: 'add_purchase', purchase };
}

/**
 * Вердикт «Могу ли я это купить?» по частям рассрочки (`check_purchase` на расчёте страницы) и разбор «внутри / за горизонтом».
 * Данных не хватает (гейт) — `kind = insufficient_data` с причиной; ошибка движка — код.
 * @param {{ctx: object}} model модель страницы
 * @param {{currency: string, parts: {date: string, amount_minor: number}[]}} purchase
 * @returns {{ok: true, result: object, split: {inside_count: number, inside_minor: number, beyond_count: number, beyond_minor: number}}|{ok: false, error: object}}
 */
export function installment_verdict(model, purchase) {
  try {
    const result = check_purchase(model.ctx, { currency: purchase.currency, parts: purchase.parts }, null);
    return { ok: true, result, split: split_horizon(purchase.parts, to_epoch_day(model.ctx.horizon_end)) };
  } catch (e) {
    return { ok: false, error: { code: typeof e?.code === 'string' ? e.code : 'E_SCHEMA', ctx: { field: 'purchase', reason: 'check_failed' } } };
  }
}

// ── узлы ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Слово «платежей» с числом. */
export function payments_text(ctx, n) {
  return ctx.tr('forms.inst_pay_n_' + plural_cat(ctx.lang(), n), { n });
}

/**
 * Раздел «Рассрочка»: форма (сумма, число платежей, ставка, вид, первая дата, перенос платежа), график, итог, вердикт и запись покупки.
 * @param {object} ctx контекст расширений
 * @returns {HTMLElement}
 */
export function render_installment(ctx) {
  const ws = ctx.get_ws();
  const model = ctx.get_model();
  const root = h('section', { class: 'fp08-section', id: 'fp08-sec-installment', 'aria-labelledby': 'fp08-sec-installment-title' }, h('h3', { id: 'fp08-sec-installment-title', text: ctx.tr('forms.inst_title') }));
  if (ws === null || ws === undefined || model === null || model === undefined) { root.append(h('p', { class: 'muted', text: ctx.tr('forms.no_data') })); return root; }
  const env = env_of(ctx, ws);
  const f = fmt_of(env);
  root.append(h('p', { class: 'lead', text: ctx.tr('forms.inst_lead') }));
  const purchase_id = ctx.new_id('pur');
  const name = text_field(ctx, 'inst', 'name', { hint: ctx.tr('forms.h_inst_name') });
  const total = text_field(ctx, 'inst', 'total', { inputmode: 'decimal', hint: ctx.tr('forms.h_inst_total') });
  const n = text_field(ctx, 'inst', 'n', { inputmode: 'numeric', value: '6', hint: ctx.tr('forms.h_inst_n') });
  const rate = text_field(ctx, 'inst', 'rate', { label: ctx.tr('forms.f_rate_inst'), inputmode: 'decimal', hint: ctx.tr('forms.h_inst_rate') });
  const kind = select_field(ctx, 'inst', 'kind', ['annuity', 'differential'].map((k) => ({ value: k, text: ctx.tr('forms.ikind_' + k) })), 'annuity');
  const start = text_field(ctx, 'inst', 'start_date', { type: 'date', value: ws.as_of, hint: ctx.tr('forms.h_inst_start') });
  const move_k = text_field(ctx, 'inst', 'move_k', { inputmode: 'numeric', hint: ctx.tr('forms.h_inst_move') });
  const move_date = text_field(ctx, 'inst', 'move_date', { type: 'date' });
  const out = h('div', { id: 'fp08-inst-preview', class: 'fp08-preview', 'aria-live': 'polite' });
  const fields = [name, total, n, rate, kind, start, move_k, move_date];
  const texts = () => ({
    name: name.input.value, total: total.input.value, n: n.input.value, rate: rate.input.value, kind: kind.input.value, start_date: start.input.value,
    move_k: move_k.input.value, move_date: move_date.input.value, purchase_id,
  });
  const draw = () => {
    const built = build_installment(ws, texts(), env);
    if (!built.ok) { out.replaceChildren(h('p', { class: 'muted', text: ctx.tr('forms.inst_wait') })); return built; }
    const chk = apply_chain(ws, [installment_edit(built)], { new_id: ctx.new_id, as_of: ws.as_of });
    if (!chk.ok) { out.replaceChildren(h('p', { class: 'error', text: error_text(ctx, chk.error) })); return { ok: false, error: chk.error }; }
    const p = built.plan;
    const rows = p.rows.map((r) => h('tr', null, h('td', { text: String(r.k) }), h('td', { text: f.date(date_of_row(built, r)) }),
      h('td', { text: f.money(r.payment_minor) }), h('td', { text: f.money(r.interest_minor) }), h('td', { text: f.money(r.principal_minor) }), h('td', { text: f.money(r.balance_minor) })));
    const nodes = [
      h('p', { text: ctx.tr(p.rate_bp === 0 ? 'forms.inst_total_zero' : 'forms.inst_total', {
        count: payments_text(ctx, built.parts.length), total: f.money(p.total_minor), interest: f.money(p.interest_minor),
      }) }),
      table(ctx.tr('forms.inst_table'), [ctx.tr('forms.inst_col_k'), ctx.tr('forms.inst_col_date'), ctx.tr('forms.inst_col_payment'), ctx.tr('forms.inst_col_interest'), ctx.tr('forms.inst_col_principal'), ctx.tr('forms.inst_col_balance')], rows),
    ];
    const v = installment_verdict(model, built.purchase);
    if (!v.ok) nodes.push(h('p', { class: 'error', text: error_text(ctx, v.error) }));
    else if (v.result.kind === 'ok') {
      nodes.push(h('p', { class: 'fp08-verdict', text: ctx.tr('forms.inst_verdict', { verdict: LABELS.verdicts[ctx.lang()][v.result.verdict], min: f.money(v.result.by_mode[ctx.mode()]?.m_after ?? v.result.by_mode.worse.m_after) }) }));
      if (v.split.beyond_count > 0) nodes.push(h('p', { class: 'banner tight', role: 'status', text: ctx.tr('forms.inst_beyond', { sum: f.money(v.split.beyond_minor), count: payments_text(ctx, v.split.beyond_count) }) }));
    } else nodes.push(h('p', { class: 'muted', text: ctx.tr('forms.inst_insufficient') }));
    nodes.push(h('p', { class: 'muted', text: ctx.tr('forms.inst_note') }));
    out.replaceChildren(...nodes);
    return built;
  };
  for (const x of fields) { x.input.addEventListener('input', draw); x.input.addEventListener('change', draw); }
  const submit = () => {
    const built = build_installment(ws, texts(), env);
    if (!built.ok) { show_field_error(ctx, fields.find((x) => x.id.endsWith('-' + (built.error.ctx.field ?? ''))) ?? total, built.error); return built; }
    const r = commit_edits(ctx, [installment_edit(built)], 'add_purchase');
    if (r.ok) ctx.notify(ctx.tr('forms.inst_saved', { name: built.purchase.name, count: payments_text(ctx, built.parts.length) }), 'info');
    return r;
  };
  root.append(form_card(ctx, 'inst', ctx.tr('forms.inst_form_title'), ctx.tr('forms.inst_form_lead'), fields, ctx.tr('forms.inst_save'), submit, [out]).form);
  return root;
}

/** Дата строки графика: часть покупки с тем же номером (платежи нулевой суммы в части не входят — тогда дата строки — по номеру платежа). */
function date_of_row(built, row) {
  const i = built.plan.rows.filter((x) => x.k <= row.k && x.payment_minor > 0).length - 1;
  return built.parts[Math.max(0, i)]?.date ?? format_date(row.date);
}
