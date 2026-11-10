// form_fx.mjs — курсы валют и обмен (FP-08, REQ-077, REQ-078, REQ-079, ALG-08, IDEA-19, IDEA-50).
//
// Курс — допущение пользователя, а не данные сети: он вводится вручную дробью `num/den` КАК ВВЕДЁН («0,9250» → 9250/10000, не сокращается, C-037), у каждого курса
// есть дата. Каждая пересчитанная сумма подписывается курсом и датой курса («курс 0,9250 от 2026-10-04») и возрастом курса; старше `fx.stale_days` (параметр,
// значение по умолчанию живёт в `vocab.json`, а не в коде) — плашка «курс не обновлялся N дн.». Курса пары нет — `E_NO_RATE`, а не молчаливый ноль.
// Обмен между собственными счетами — ДВЕ ноги одного перевода (`add_fact` с `legs`): курс обмена выводится как несократимая дробь `leg_b / leg_a`
// (`implied_rate`), а «курсовая разница обмена» (выведенный курс против `spot`) — справочная (`exchange_difference`), в расчёт «свободно» она не входит.
// Файл: чистая часть и узлы. Расчёт по введённым данным и правилам, не консультация.

import {
  implied_rate, exchange_difference, rate_at, rate_status, convert_minor, currency_exponent, to_epoch_day, format_date,
} from '../engine/index.mjs';
import { h, table } from './dom.mjs';
import { apply_edit } from './ws_edit.mjs';
import { rate_date_text, stale_limit } from './rate_chip.mjs';
import {
  bad, first_error, list_of, env_of, fmt_of, parse_money, parse_rate, rate_text, parse_date_input, open_accounts, account_label, commit_edits, error_text,
  text_field, select_field, show_field_error, form_card, kids,
} from './forms.mjs';

const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const code_of = (x) => (typeof x === 'string' ? x.trim().toUpperCase() : '');

/** Предел возраста курса в днях: параметр рабочей области `fx.stale_days` (иначе значение по умолчанию из таблицы параметров движка); одна функция с подписью суммы и плашкой — `rate_chip.stale_limit`. */
export function stale_days_of(ws) {
  return stale_limit(ws);
}

// ── курсы ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Правка `upsert_fx_rate` из текстовых полей: валюты (коды), курс «как введён», дата не позже даты расчёта.
 * @param {object} ws
 * @param {{base: string, quote: string, rate: string, date?: string, fx_id?: string}} t
 * @param {{cur: string, lang: 'ru'|'en', nf?: any, as_of: string}} env
 * @returns {{ok: true, edit: {type: 'upsert_fx_rate', rate: object}}|{ok: false, error: object}}
 */
export function build_rate_edit(ws, t, env) {
  if (!is_obj(t)) return bad('E_SCHEMA', 'form', 'not_object');
  const base = code_of(t.base);
  const quote = code_of(t.quote);
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(base)) return bad('E_SCHEMA', 'base', 'bad_currency');
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(quote)) return bad('E_SCHEMA', 'quote', 'bad_currency');
  try { currency_exponent(base); } catch { return bad('E_SCHEMA', 'base', 'unknown_currency'); }
  try { currency_exponent(quote); } catch { return bad('E_SCHEMA', 'quote', 'unknown_currency'); }
  if (base === quote) return bad('E_CURRENCY_MISMATCH', 'quote', 'same_currency');
  const rate = parse_rate(t.rate, env, 'rate');
  const date = parse_date_input(t.date === undefined || t.date === '' ? env.as_of : t.date, env, 'date');
  const err = first_error([rate, date]);
  if (err !== null) return err;
  if (date.value > env.as_of) return bad('E_FUTURE_POSTED', 'date', 'rate_in_future');
  const out = { date: date.value, base, quote, num: rate.value.num, den: rate.value.den, source: 'manual' };
  if (typeof t.fx_id === 'string' && t.fx_id !== '') out.fx_id = t.fx_id;
  return { ok: true, edit: { type: 'upsert_fx_rate', rate: out } };
}

/**
 * Последний курс каждой пары с возрастом и признаком «устарел» (`rate_status`, предел — `fx.stale_days`).
 * @returns {{base: string, quote: string, num: number, den: number, date: string, age: number, stale: boolean, fx_id: string}[]}
 */
export function rate_rows(ws, as_of = ws?.as_of) {
  const stale_days = stale_days_of(ws);
  const best = new Map();
  for (const r of list_of(ws, 'rates')) {
    if (!is_obj(r)) continue;
    const key = r.base + '/' + r.quote;
    const d = to_epoch_day(r.date);
    if (to_epoch_day(r.date) > to_epoch_day(as_of)) continue; // курс из «будущего» — не spot
    const cur = best.get(key);
    if (cur === undefined || d > cur.d || (d === cur.d && String(r.fx_id) > String(cur.r.fx_id))) best.set(key, { r, d });
  }
  return [...best.values()].sort((x, y) => (x.r.base + x.r.quote < y.r.base + y.r.quote ? -1 : 1)).map(({ r }) => {
    const st = rate_status(r, as_of, stale_days);
    return { base: r.base, quote: r.quote, num: r.num, den: r.den, date: format_date(to_epoch_day(r.date)), age: st.age, stale: st.stale, fx_id: String(r.fx_id ?? '') };
  });
}

/**
 * Перевод суммы по курсу пары на `as_of` с подписью курса и его возраста (REQ-079): сумма, курс (`num/den`, `inverse`), дата курса, возраст, «устарел».
 * Нет курса — `{ok: false, error: {code: 'E_NO_RATE'}}`.
 * @returns {{ok: true, amount_minor: number, rate: {num: number, den: number, date: string, inverse: boolean}, age: number, stale: boolean}|{ok: false, error: object}}
 */
export function convert_with_signature(ws, amount_minor, from_cur, to_cur, as_of = ws?.as_of) {
  const r = rate_at(list_of(ws, 'rates'), from_cur, to_cur, as_of);
  if (r === null) return { ok: false, error: { code: 'E_NO_RATE', ctx: { field: 'rate', reason: 'no_rate' } } };
  const v = convert_minor(amount_minor, currency_exponent(from_cur), currency_exponent(to_cur), r.num, r.den, ws?.params?.rounding ?? 'half_even');
  const st = rate_status({ date: r.date }, as_of, stale_days_of(ws));
  return { ok: true, amount_minor: v, rate: { num: r.num, den: r.den, date: format_date(r.date), inverse: r.inverse === true }, age: st.age, stale: st.stale };
}

// ── обмен ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Правка обмена: два события-ноги одного перевода (`add_fact` с `legs`). Продано `sold` со счёта `from_account_id`, получено `got` на счёт `to_account_id`
 * (в валютах счетов). Курс обмена выводится из ног как несократимая дробь и кладётся в проданную ногу (`fx`), поэтому обмен принимается и без введённого курса пары.
 * @param {object} ws
 * @param {{from_account_id: string, to_account_id: string, sold: string, got: string, date?: string, transfer_id: string}} t
 * @param {{cur: string, lang: 'ru'|'en', nf?: any, as_of: string}} env
 * @returns {{ok: true, edit: object, info: {implied: {num: number, den: number}, sold_minor: number, got_minor: number, from_currency: string, to_currency: string,
 *   spot: {num: number, den: number, inverse: boolean}|null, diff_minor: number|null, date: string}}|{ok: false, error: object}}
 */
export function build_exchange_edit(ws, t, env) {
  if (!is_obj(t)) return bad('E_SCHEMA', 'form', 'not_object');
  const from = list_of(ws, 'accounts').find((a) => a?.account_id === t.from_account_id);
  const to = list_of(ws, 'accounts').find((a) => a?.account_id === t.to_account_id);
  if (from === undefined) return bad('E_SCHEMA', 'from_account_id', 'unknown_account');
  if (to === undefined) return bad('E_SCHEMA', 'to_account_id', 'unknown_account');
  if (from.account_id === to.account_id) return bad('E_SCHEMA', 'to_account_id', 'transfer_same_account');
  if (from.currency === to.currency) return bad('E_CURRENCY_MISMATCH', 'to_account_id', 'same_currency_use_transfer');
  const sold = parse_money(t.sold, env, 'sold', { cur: from.currency });
  const got = parse_money(t.got, env, 'got', { cur: to.currency });
  const date = parse_date_input(t.date === undefined || t.date === '' ? env.as_of : t.date, env, 'date');
  const err = first_error([sold, got, date]);
  if (err !== null) return err;
  const a_exp = Number.isInteger(from.exponent) ? from.exponent : currency_exponent(from.currency);
  const b_exp = Number.isInteger(to.exponent) ? to.exponent : currency_exponent(to.currency);
  let implied;
  try { implied = implied_rate(sold.value, got.value, a_exp, b_exp); } catch (e) { return bad(typeof e?.code === 'string' ? e.code : 'E_OVERFLOW', 'got', 'implied_rate'); }
  const spot = rate_at(list_of(ws, 'rates'), from.currency, to.currency, date.value);
  const diff = spot === null ? null : exchange_difference(sold.value, got.value, a_exp, b_exp, spot);
  const edit = {
    type: 'add_fact', transfer_id: t.transfer_id,
    legs: [
      { account_id: from.account_id, date: date.value, amount_minor: -sold.value, fx: { num: implied.num, den: implied.den } },
      { account_id: to.account_id, date: date.value, amount_minor: got.value },
    ],
  };
  return { ok: true, edit, info: {
    implied, sold_minor: sold.value, got_minor: got.value, from_currency: from.currency, to_currency: to.currency,
    spot: spot === null ? null : { num: spot.num, den: spot.den, inverse: spot.inverse === true }, diff_minor: diff, date: date.value,
  } };
}

// ── узлы ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Подпись курса: «курс 0,9250 от 2026-10-04» (дата курса ISO — однозначно), для обратного — пометка. */
export function rate_signature(ctx, env, r) {
  return ctx.tr(r.inverse === true ? 'forms.fx_sign_inverse' : 'forms.fx_sign', { rate: rate_text(r.num, r.den, env), date: rate_date_text(env.nf, r.date) });
}

/** Плашка «курс не обновлялся N дн.» (REQ-079), если курс старше предела; иначе `null`. */
export function stale_banner(ctx, age, stale) {
  return stale ? h('p', { class: 'banner tight', role: 'status', text: ctx.tr('forms.fx_stale', { n: age }) }) : null;
}

/**
 * Раздел «Курсы и обмен»: таблица последних курсов (дробь, дата, возраст, плашка), форма курса, проверка перевода с подписью, форма обмена двумя ногами.
 * @param {object} ctx контекст расширений
 * @returns {HTMLElement}
 */
export function render_fx(ctx) {
  const ws = ctx.get_ws();
  const root = h('section', { class: 'fp08-section', id: 'fp08-sec-fx', 'aria-labelledby': 'fp08-sec-fx-title' }, h('h3', { id: 'fp08-sec-fx-title', text: ctx.tr('forms.fx_title') }));
  if (ws === null || ws === undefined) { root.append(h('p', { class: 'muted', text: ctx.tr('forms.no_data') })); return root; }
  const env = env_of(ctx, ws);
  const f = fmt_of(env);
  root.append(h('p', { class: 'lead', text: ctx.tr('forms.fx_lead') }));

  // курсы
  const rows = rate_rows(ws);
  if (rows.length === 0) root.append(h('p', { class: 'muted', text: ctx.tr('forms.fx_none') }));
  else {
    root.append(table(ctx.tr('forms.fx_table'), [ctx.tr('forms.fx_col_pair'), ctx.tr('forms.fx_col_rate'), ctx.tr('forms.fx_col_date'), ctx.tr('forms.fx_col_age')],
      rows.map((r) => h('tr', { 'data-pair': r.base + '/' + r.quote },
        h('td', { text: r.base + ' → ' + r.quote }), h('td', { text: rate_text(r.num, r.den, env) }), h('td', { text: rate_date_text(env.nf, r.date) }), // дата курса — в стиле дат пользователя (по умолчанию ISO)
        h('td', { text: ctx.tr('forms.fx_age', { n: r.age }) + (r.stale ? ' · ' + ctx.tr('forms.fx_stale', { n: r.age }) : '') })))));
  }

  // форма курса
  const accs = open_accounts(ws);
  const other = [...new Set(accs.map((a) => a.currency))].find((c) => c !== env.cur) ?? '';
  const base = text_field(ctx, 'rate', 'base', { value: other, hint: ctx.tr('forms.h_fx_base') });
  const quote = text_field(ctx, 'rate', 'quote', { value: env.cur, hint: ctx.tr('forms.h_fx_quote') });
  const rate = text_field(ctx, 'rate', 'rate', { label: ctx.tr('forms.f_rate_fx'), inputmode: 'decimal', hint: ctx.tr('forms.h_fx_rate') });
  const date = text_field(ctx, 'rate', 'date', { type: 'date', value: ws.as_of, max: ws.as_of, hint: ctx.tr('forms.h_fx_date') });
  const rate_fields = [base, quote, rate, date];
  const rate_submit = () => {
    const built = build_rate_edit(ws, { base: base.input.value, quote: quote.input.value, rate: rate.input.value, date: date.input.value, fx_id: ctx.new_id('fx') }, env);
    if (!built.ok) { show_field_error(ctx, rate_fields.find((x) => x.id.endsWith('-' + (built.error.ctx.field ?? ''))) ?? rate, built.error); return built; }
    const r = commit_edits(ctx, [built.edit], 'upsert_fx_rate');
    if (r.ok) ctx.notify(ctx.tr('forms.fx_saved', { pair: built.edit.rate.base + ' → ' + built.edit.rate.quote }), 'info');
    return r;
  };
  root.append(form_card(ctx, 'rate', ctx.tr('forms.fx_form_title'), ctx.tr('forms.fx_form_lead'), rate_fields, ctx.tr('forms.save'), rate_submit).form);

  // проверка перевода с подписью курса
  const c_amount = text_field(ctx, 'conv', 'amount', { inputmode: 'decimal', hint: ctx.tr('forms.h_fx_conv') });
  const c_from = text_field(ctx, 'conv', 'from', { value: other, hint: ctx.tr('forms.h_fx_base') });
  const c_out = h('div', { id: 'fp08-conv-out', class: 'fp08-preview', 'aria-live': 'polite' });
  const conv_submit = () => {
    const from_cur = code_of(c_from.input.value);
    let exp_ok = true;
    try { currency_exponent(from_cur); } catch { exp_ok = false; }
    if (!exp_ok) { const e = bad('E_SCHEMA', 'from', 'unknown_currency'); show_field_error(ctx, c_from, e.error); return e; }
    const a = parse_money(c_amount.input.value, env, 'amount', { cur: from_cur });
    if (!a.ok) { show_field_error(ctx, c_amount, a.error); return a; }
    const r = convert_with_signature(ws, a.value, from_cur, env.cur);
    if (!r.ok) { c_out.replaceChildren(h('p', { class: 'error', text: error_text(ctx, r.error) })); return { ok: true }; }
    c_out.replaceChildren(...kids(
      h('p', { text: ctx.tr('forms.fx_converted', { from: fmt_of(env, from_cur).money(a.value), to: f.money(r.amount_minor), sign: rate_signature(ctx, env, r.rate) }) }),
      stale_banner(ctx, r.age, r.stale)));
    return { ok: true };
  };
  root.append(form_card(ctx, 'conv', ctx.tr('forms.fx_conv_title'), ctx.tr('forms.fx_conv_lead'), [c_amount, c_from], ctx.tr('forms.fx_conv_run'), conv_submit, [c_out]).form);

  // обмен двумя ногами
  if (new Set(accs.map((a) => a.currency)).size < 2) {
    root.append(h('p', { class: 'muted', text: ctx.tr('forms.fx_xchg_need') }));
    return root;
  }
  const opts = accs.map((a) => ({ value: a.account_id, text: account_label(ws, a.account_id) + ' · ' + a.currency }));
  const x_from = select_field(ctx, 'xchg', 'from_account_id', opts, accs[0].account_id);
  const x_to = select_field(ctx, 'xchg', 'to_account_id', opts, (accs.find((a) => a.currency !== accs[0].currency) ?? accs[1]).account_id);
  const x_sold = text_field(ctx, 'xchg', 'sold', { inputmode: 'decimal', hint: ctx.tr('forms.h_fx_sold') });
  const x_got = text_field(ctx, 'xchg', 'got', { inputmode: 'decimal', hint: ctx.tr('forms.h_fx_got') });
  const x_date = text_field(ctx, 'xchg', 'date', { type: 'date', value: ws.as_of, max: ws.as_of });
  const x_prev = h('div', { id: 'fp08-xchg-preview', class: 'fp08-preview', 'aria-live': 'polite' });
  const x_fields = [x_from, x_to, x_sold, x_got, x_date];
  const new_trf = ctx.new_id('trf');
  const texts = () => ({ from_account_id: x_from.input.value, to_account_id: x_to.input.value, sold: x_sold.input.value, got: x_got.input.value, date: x_date.input.value, transfer_id: new_trf });
  const draw = () => {
    const built = build_exchange_edit(ws, texts(), env);
    if (!built.ok) { x_prev.replaceChildren(h('p', { class: 'muted', text: ctx.tr('forms.fx_xchg_wait') })); return built; }
    const chk = apply_edit(ws, built.edit, { new_id: ctx.new_id, as_of: ws.as_of });
    if (!chk.ok) { x_prev.replaceChildren(h('p', { class: 'error', text: error_text(ctx, chk.error) })); return chk; }
    const i = built.info;
    const lines = [h('p', { text: ctx.tr('forms.fx_xchg_implied', { rate: rate_text(i.implied.num, i.implied.den, env), frac: i.implied.num + '/' + i.implied.den }) })];
    if (i.diff_minor !== null) lines.push(h('p', { class: 'muted', text: ctx.tr('forms.fx_xchg_diff', { diff: fmt_of(env, i.to_currency).money(i.diff_minor), spot: rate_text(i.spot.num, i.spot.den, env) }) }));
    x_prev.replaceChildren(...lines);
    return chk;
  };
  for (const x of x_fields) { x.input.addEventListener('input', draw); x.input.addEventListener('change', draw); }
  const x_submit = () => {
    const built = build_exchange_edit(ws, texts(), env);
    if (!built.ok) { show_field_error(ctx, x_fields.find((x) => x.id.endsWith('-' + (built.error.ctx.field ?? ''))) ?? x_sold, built.error); return built; }
    const r = commit_edits(ctx, [built.edit], 'add_fact');
    if (r.ok) ctx.notify(ctx.tr('forms.fx_xchg_saved', { sold: fmt_of(env, built.info.from_currency).money(built.info.sold_minor), got: fmt_of(env, built.info.to_currency).money(built.info.got_minor) }), 'info');
    return r;
  };
  root.append(form_card(ctx, 'xchg', ctx.tr('forms.fx_xchg_title'), ctx.tr('forms.fx_xchg_lead'), x_fields, ctx.tr('forms.fx_xchg_save'), x_submit, [x_prev]).form);
  return root;
}
