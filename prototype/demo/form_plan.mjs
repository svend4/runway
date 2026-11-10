// form_plan.mjs — разовый платёж на экране (FP-13, REQ-010, REQ-032): ввод одного платежа или поступления на дату без правила повторения.
//
// Что делает: даёт два вида правок — `upsert_plan` (запись в `ws.plans`: счёт, название, дата, сумма со знаком, вид) и `delete_plan` — и форму «Разовый платёж»
// с предпросмотром и списком ближайших разовых платежей. Статус платежа («пропущен», «отменён») по-прежнему меняется в «Сверке» (`set_plan_status`, FP-11):
// форма его не дублирует, а ссылается на неё. Платёж попадает в прогноз так же, как запись набора данных (движок читает `ws.plans`).
// Запись — только общим путём `ctx.set_ws` (проверка → копия → пересчёт страницей → журнал `plan.set` → «Отменить»). Перевод между счетами (запись с `transfer_id`)
// этой формой не создаётся и не правится: у него свой путь. Расчёт по введённым данным и правилам, не консультация.

import { fail, rate_at, RunwayError, to_epoch_day, currency_exponent } from '../engine/index.mjs';
import { h } from './dom.mjs';
import { decision_currency_of, apply_edit } from './ws_edit.mjs';
import { format_input_amount, resolve_number_format } from './number_format.mjs';
import {
  bad, first_error, list_of, env_of, fmt_of, parse_money, parse_date_flexible, open_accounts, account_label, commit_edits, text_field, select_field, check_field,
  is_checked, form_card, kids,
} from './forms.mjs';
import {
  schema, allow_keys, need_obj, id_of, text_of, date_of, claim_id, upsert_by, reason_text, show_error,
} from './form_calendar.mjs';

const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

export const PLAN_KINDS = Object.freeze(['expense', 'income']);
/** Сколько ближайших разовых платежей показывает список. */
export const PLAN_ROWS = 15;

const PLAN_KEYS = ['plan_id', 'account_id', 'name', 'date', 'amount_minor', 'currency', 'kind', 'tag', 'is_obligation', 'is_estimate'];

/** Курс пары «валюта счёта → валюта решения» на дату должен быть, иначе `E_NO_RATE` (как у остальных записей с чужой валютой). */
function need_rate(ws, currency, date, field) {
  const dec = decision_currency_of(ws);
  if (dec === null || currency === dec) return;
  let r = null;
  try { r = rate_at(list_of(ws, 'rates'), currency, dec, date); } catch (e) { if (e instanceof RunwayError) r = null; else throw e; }
  if (r === null) fail('E_NO_RATE', { field, reason: 'no_rate', currency, decision_currency: dec, date: String(date).slice(0, 40) });
}

/**
 * Вид правки для `ws_edit.register_edit`: `{type: 'upsert_plan', plan: {plan_id?, account_id, name, date, amount_minor, currency?, kind?, tag?, is_obligation?, is_estimate?}}`.
 * Сумма — целое со знаком (расход меньше нуля, поступление больше), не ноль; вид, если задан, обязан совпасть со знаком. Валюта — валюта счёта; для чужой валюты нужен курс
 * (`E_NO_RATE`). Запись с тем же `plan_id` заменяется, её поля вне формы (статус, резерв, контрагент) сохраняются; перевод между счетами (`transfer_id`) не правится.
 * @param {object} ws
 * @param {object} edit
 * @param {{new_id?: (prefix: string) => string}} [env]
 * @returns {object} новая рабочая область
 * @throws {RunwayError} E_SCHEMA, E_BAD_DATE, E_NOT_INTEGER, E_OVERFLOW, E_CURRENCY_MISMATCH, E_NO_RATE
 */
export function edit_upsert_plan(ws, edit, env = {}) {
  allow_keys(edit, ['type', 'plan'], 'edit');
  const p = need_obj(edit.plan, 'plan');
  allow_keys(p, PLAN_KEYS, 'plan');
  const id = id_of(p.plan_id ?? env.new_id?.('plan'), 'plan.plan_id');
  claim_id(ws, 'plan', id, 'plan.plan_id');
  const plans = list_of(ws, 'plans');
  const old = plans.find((x) => x?.plan_id === id);
  if (old !== undefined && old.transfer_id !== undefined && old.transfer_id !== null) schema('plan.plan_id', 'plan_is_transfer');
  const acc = list_of(ws, 'accounts').find((a) => a?.account_id === id_of(p.account_id, 'plan.account_id'));
  if (acc === undefined) schema('plan.account_id', 'unknown_account');
  const name = text_of(p.name, 'plan.name', 120);
  const date = date_of(p.date, 'plan.date');
  if (!Number.isSafeInteger(p.amount_minor)) {
    fail(typeof p.amount_minor === 'number' && Number.isFinite(p.amount_minor) && Number.isInteger(p.amount_minor) ? 'E_OVERFLOW' : 'E_NOT_INTEGER', { field: 'plan.amount_minor', reason: 'not_money' });
  }
  if (p.amount_minor === 0) schema('plan.amount_minor', 'zero');
  const currency = p.currency === undefined ? acc.currency : p.currency;
  if (currency !== acc.currency) fail('E_CURRENCY_MISMATCH', { field: 'plan.currency', reason: 'differs_from_account', currency: String(currency).slice(0, 10), account_currency: acc.currency });
  const kind = p.kind === undefined ? (p.amount_minor > 0 ? 'income' : 'expense') : p.kind;
  if (!PLAN_KINDS.includes(kind)) schema('plan.kind', 'not_in_list');
  if ((kind === 'income') !== (p.amount_minor > 0)) schema('plan.amount_minor', 'sign_mismatch_kind');
  const item = { plan_id: id, account_id: acc.account_id, name, date, amount_minor: p.amount_minor, currency, kind };
  if (p.tag !== undefined) item.tag = text_of(p.tag, 'plan.tag', 100, { allow_empty: true });
  for (const k of ['is_obligation', 'is_estimate']) {
    if (p[k] === undefined) continue;
    if (typeof p[k] !== 'boolean') schema('plan.' + k, 'not_boolean');
    item[k] = p[k];
  }
  need_rate(ws, currency, date, 'plan.currency');
  const merged = { ...(old ?? {}), ...item };
  if (item.tag === '') delete merged.tag; // пустая метка снимает прежнюю
  return { ...ws, plans: upsert_by(plans, 'plan_id', merged) };
}

/**
 * Вид правки `delete_plan`: `{type, plan_id}`. Платёж, к которому привязан факт (`plan_ref`), и нога перевода не удаляются (`E_SCHEMA`, причины
 * `plan_has_matches`, `plan_is_transfer`): отметить такой платёж отменённым можно в «Сверке».
 */
export function edit_delete_plan(ws, edit) {
  allow_keys(edit, ['type', 'plan_id'], 'edit');
  const id = id_of(edit.plan_id, 'plan_id');
  const plans = list_of(ws, 'plans');
  const old = plans.find((x) => x?.plan_id === id);
  if (old === undefined) schema('plan_id', 'unknown_plan');
  if (old.transfer_id !== undefined && old.transfer_id !== null) schema('plan_id', 'plan_is_transfer');
  if (list_of(ws, 'facts').some((x) => is_obj(x) && x.plan_ref === id)) schema('plan_id', 'plan_has_matches');
  return { ...ws, plans: plans.filter((x) => x?.plan_id !== id) };
}

/** Новые виды правок пакета (`ws_edit.register_edit`). */
export const PLAN_EDITS = Object.freeze({ upsert_plan: edit_upsert_plan, delete_plan: edit_delete_plan });

// ── разбор формы ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Собрать правку `upsert_plan` из текстов формы.
 * @param {object} ws
 * @param {{plan_id: string, name: string, kind: string, amount: string, account_id: string, date: string, tag?: string, is_obligation?: boolean, is_estimate?: boolean}} t
 * @param {{cur: string, lang: 'ru'|'en', nf?: any, as_of: string}} env
 * @returns {{ok: true, edit: {type: 'upsert_plan', plan: object}}|{ok: false, error: {code: string, ctx: object}}}
 */
export function build_plan_edit(ws, t, env) {
  if (!is_obj(t)) return bad('E_SCHEMA', 'form', 'not_object');
  const name = typeof t.name === 'string' ? t.name.trim() : '';
  if (name === '') return bad('E_SCHEMA', 'name', 'empty');
  const acc = list_of(ws, 'accounts').find((a) => a?.account_id === t.account_id);
  if (acc === undefined) return bad('E_SCHEMA', 'account_id', 'unknown_account');
  if (!PLAN_KINDS.includes(t.kind)) return bad('E_SCHEMA', 'kind', 'not_in_list');
  const amount = parse_money(t.amount, env, 'amount', { cur: acc.currency });
  const date = parse_date_flexible(t.date, env, 'date');
  const err = first_error([amount, date]);
  if (err !== null) return err;
  const plan = {
    plan_id: t.plan_id, account_id: acc.account_id, name, date: date.value, amount_minor: (t.kind === 'expense' ? -1 : 1) * amount.value, kind: t.kind,
    is_obligation: t.is_obligation === true, is_estimate: t.is_estimate === true,
  };
  const tag = typeof t.tag === 'string' ? t.tag.trim() : '';
  if (tag !== '' || t.tag === '') plan.tag = tag;
  return { ok: true, edit: { type: 'upsert_plan', plan } };
}

// ── модели показа ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Сколько прошедших разовых платежей показывает свёрнутый список «прошедшие» (самые свежие первыми). */
export const PAST_ROWS = 30;

/**
 * Разовые платежи для списка: без ног переводов, по дате и идентификатору; ближайшие (не раньше `as_of`) первыми. Прошедшие считаются (`past`) и отдаются списком
 * `past_rows` — от свежих к давним, не более `past_rows_max`: платёж с ошибкой в дате (например, год раньше) нельзя было бы ни исправить, ни удалить, если бы он нигде не показывался.
 * @returns {{upcoming: object[], past: number, shown: object[], past_rows: object[], past_hidden: number}}
 */
export function plan_rows(ws, rows = PLAN_ROWS, past_rows_max = PAST_ROWS) {
  const as_of = typeof ws?.as_of === 'string' ? ws.as_of : '';
  const own = list_of(ws, 'plans').filter((p) => is_obj(p) && typeof p.plan_id === 'string' && (p.transfer_id === undefined || p.transfer_id === null));
  const cmp = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.plan_id < b.plan_id ? -1 : a.plan_id > b.plan_id ? 1 : 0));
  const upcoming = own.filter((p) => String(p.date) >= as_of).sort(cmp);
  const old = own.filter((p) => String(p.date) < as_of).sort((a, b) => cmp(b, a));
  return { upcoming, past: own.length - upcoming.length, shown: upcoming.slice(0, rows), past_rows: old.slice(0, past_rows_max), past_hidden: Math.max(0, old.length - past_rows_max) };
}

/**
 * Предпросмотр разового платежа: запись проходит `apply_edit` на копии; показывается дата, сумма и счёт, а для даты раньше «сегодня» — оговорка.
 * @returns {{ok: true, past: boolean, days: number}|{ok: false, error: object}}
 */
export function plan_preview(ws, built_edit, o = {}) {
  const r = apply_edit(ws, built_edit, { new_id: o.new_id, as_of: o.as_of });
  if (!r.ok) return r;
  const as_of = o.as_of ?? ws.as_of;
  const days = to_epoch_day(built_edit.plan.date) - to_epoch_day(as_of);
  return { ok: true, past: days < 0, days };
}

// ── узлы ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Карточка «Разовый платёж»: форма (название, вид, сумма, счёт, дата, метка, обязательный, приблизительная) с предпросмотром и список ближайших разовых платежей.
 * @param {object} ctx контекст расширений
 * @param {{focus: object}} deps `form_calendar.make_deps()`
 * @returns {HTMLElement}
 */
export function render_plans(ctx, deps) {
  const tr = ctx.tr;
  const ws = ctx.get_ws();
  const root = h('section', { class: 'card fp13-card', id: 'fp13-plans', 'aria-labelledby': 'fp13-plans-title' },
    h('h3', { id: 'fp13-plans-title', tabindex: '-1', text: tr('calendars.plan_title') }));
  if (ws === null || ws === undefined) { root.append(h('p', { class: 'muted', text: tr('forms.no_data') })); return root; }
  const env = env_of(ctx, ws);
  const f = fmt_of(env);
  const accounts = open_accounts(ws);

  let editing = null;
  const new_id = ctx.new_id('plan');
  const kind_sel = select_field(ctx, 'plan', 'kind', PLAN_KINDS.map((k) => ({ value: k, text: tr('forms.kind_' + k) })), 'expense');
  const name = text_field(ctx, 'plan', 'name', { hint: tr('calendars.h_plan_name') });
  const amount = text_field(ctx, 'plan', 'amount', { inputmode: 'decimal', hint: tr('forms.h_rule_amount') });
  const account = select_field(ctx, 'plan', 'account_id', accounts.map((a) => ({ value: a.account_id, text: account_label(ws, a.account_id) + ' · ' + a.currency })), accounts[0]?.account_id);
  const date = text_field(ctx, 'plan', 'date', { type: 'date', value: ws.as_of, hint: tr('calendars.h_plan_date') });
  const tag = text_field(ctx, 'plan', 'tag', { label: tr('calendars.f_plan_tag'), hint: tr('calendars.h_plan_tag') });
  const obligation = check_field(ctx, 'plan', 'is_obligation', false);
  const estimate = check_field(ctx, 'plan', 'is_estimate', false);
  const preview = h('div', { id: 'fp13-plan-preview', class: 'fp08-preview', 'aria-live': 'polite' });

  const texts = () => ({
    plan_id: editing ?? new_id, name: name.input.value, kind: kind_sel.input.value, amount: amount.input.value, account_id: account.input.value,
    date: date.input.value, tag: tag.input.value, is_obligation: is_checked(obligation.input), is_estimate: is_checked(estimate.input),
  });
  const draw_preview = () => {
    const built = build_plan_edit(ws, texts(), env);
    if (!built.ok) { preview.replaceChildren(h('p', { class: 'muted', text: tr('calendars.plan_preview_wait') })); return built; }
    const p = plan_preview(ws, built.edit, { as_of: ws.as_of, new_id: ctx.new_id });
    if (!p.ok) { preview.replaceChildren(h('p', { class: 'error', text: reason_text(ctx, p.error) })); return p; }
    const e = built.edit.plan;
    const acc = list_of(ws, 'accounts').find((a) => a.account_id === e.account_id);
    preview.replaceChildren(...kids(h('p', { class: 'muted', text: tr('calendars.plan_preview_title') }),
      h('p', { text: tr('calendars.plan_preview_row', { date: f.date(e.date), amount: fmt_of(env, acc?.currency ?? env.cur).money(e.amount_minor), account: account_label(ws, e.account_id) }) }),
      p.past ? h('p', { class: 'muted', text: tr('calendars.plan_preview_past') }) : null));
    return p;
  };
  const fields = [kind_sel, name, amount, account, date, tag, obligation, estimate];
  for (const x of fields) { x.input.addEventListener('input', draw_preview); x.input.addEventListener('change', draw_preview); }

  const submit = () => {
    const built = build_plan_edit(ws, texts(), env);
    if (!built.ok) { show_error(ctx, fields.find((x) => x.id.endsWith('-' + (built.error.ctx.field ?? ''))) ?? name, built.error); return built; }
    deps.focus.request('fp13-plans-title');
    const r = commit_edits(ctx, [built.edit], 'upsert_plan');
    if (r.ok) ctx.notify(tr(editing === null ? 'calendars.plan_saved' : 'calendars.plan_updated', { name: built.edit.plan.name }), 'info');
    else deps.focus.clear();
    return r;
  };
  const card = form_card(ctx, 'plan', tr('calendars.plan_form_title'), tr('calendars.plan_form_lead'), fields, tr('calendars.plan_save'), submit, [preview], reason_text);

  const fill = (plan) => {
    editing = plan.plan_id;
    kind_sel.input.value = plan.amount_minor > 0 ? 'income' : 'expense';
    name.input.value = plan.name ?? '';
    const acc = list_of(ws, 'accounts').find((a) => a.account_id === plan.account_id);
    const nf = resolve_number_format(env.lang, env.nf);
    amount.input.value = format_input_amount(Math.abs(plan.amount_minor ?? 0), acc === undefined ? currency_exponent(plan.currency ?? env.cur) : (acc.exponent ?? currency_exponent(acc.currency)), nf, true);
    account.input.value = plan.account_id;
    date.input.value = plan.date;
    tag.input.value = plan.tag ?? '';
    if (typeof obligation.input.setAttribute === 'function') {
      if (plan.is_obligation === true) obligation.input.setAttribute('checked', ''); else obligation.input.removeAttribute('checked');
      if (plan.is_estimate === true) estimate.input.setAttribute('checked', ''); else estimate.input.removeAttribute('checked');
    }
    obligation.input.checked = plan.is_obligation === true;
    estimate.input.checked = plan.is_estimate === true;
    draw_preview();
    if (typeof name.input.focus === 'function') name.input.focus();
  };

  // список ближайших разовых платежей
  const model = plan_rows(ws);
  const plan_item = (plan) => {
    const status = plan.status === 'skipped' || plan.status === 'cancelled' ? ' · ' + tr('st.' + plan.status) : '';
    const money = fmt_of(env, plan.currency ?? env.cur).money(plan.amount_minor);
    const label = typeof plan.name === 'string' && plan.name !== '' ? plan.name : plan.plan_id;
    return h('li', { class: 'fp13-plan', 'data-plan': plan.plan_id },
      h('span', { text: tr('calendars.plan_row', { date: f.date(plan.date), name: label, amount: money }) + status }), ' ',
      h('button', {
        type: 'button', class: 'btn small', 'data-act': 'plan-edit', 'aria-label': tr('calendars.plan_edit_label', { name: label, date: f.date(plan.date) }),
        onclick: () => fill(plan), text: tr('calendars.plan_edit'),
      }), ' ',
      h('button', {
        type: 'button', class: 'btn small', 'data-act': 'plan-delete', 'aria-label': tr('calendars.plan_delete_label', { name: label, date: f.date(plan.date) }),
        onclick: () => {
          deps.focus.request('fp13-plans-title');
          const r = commit_edits(ctx, [{ type: 'delete_plan', plan_id: plan.plan_id }], 'delete_plan');
          if (r.ok) ctx.notify(tr('calendars.plan_deleted', { name: label }), 'info');
          else { deps.focus.clear(); ctx.notify(reason_text(ctx, r.error), 'error'); }
        },
        text: tr('calendars.plan_delete'),
      }));
  };
  const items = model.shown.map(plan_item);
  root.append(...kids(
    h('p', { class: 'lead', text: tr('calendars.plan_lead') }),
    model.upcoming.length === 0 ? h('p', { class: 'muted', id: 'fp13-plan-none', text: tr('calendars.plan_none') }) : h('ul', { class: 'plain fp13-plan-list' }, items),
    model.upcoming.length > model.shown.length ? h('p', { class: 'muted', text: tr('calendars.plan_more', { n: model.upcoming.length - model.shown.length }) }) : null,
    // прошедшие платежи: свёрнутый список с «Править» и «Удалить» — платёж с ошибкой в дате (раньше последней сверки остатка в «Сверке» его нет) иначе не найти
    model.past > 0 ? h('details', { class: 'fp13-past', id: 'fp13-plan-past' },
      h('summary', { text: tr('calendars.plan_past', { n: model.past }) }),
      h('p', { class: 'muted', text: tr('calendars.plan_past_hint') }),
      h('ul', { class: 'plain fp13-plan-list' }, model.past_rows.map(plan_item)),
      model.past_hidden > 0 ? h('p', { class: 'muted', text: tr('calendars.plan_past_more', { n: model.past_hidden }) }) : null) : null,
    h('p', { class: 'muted' }, tr('calendars.plan_status_note') + ' ', h('a', { href: '#reconcile', text: tr('calendars.plan_status_link') })),
    card.form));
  draw_preview();
  deps.focus.apply();
  return root;
}
