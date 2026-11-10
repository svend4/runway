// form_accounts.mjs — счета по ликвидности и «запас» (FP-08, REQ-018, REQ-080, IDEA-40, ALG-08).
//
// Счёт относится к `liquidity`: `operating` входит в прогноз, `savings`, `asset` и `debt` показываются справочно. «Запас» — деньги вне прогноза:
// Σ накопительных счетов + Σ активов · `liquidity_bp` / 10^4; `liquidity_bp` по умолчанию 0 и задаётся ПОЛЬЗОВАТЕЛЕМ (никаких процентов haircut от продукта,
// иначе число читается как совет). Запас показывается ОТДЕЛЬНО от денег на операционных счетах и от резервов и в «можно потратить» не входит.
// Крипто-счёт (`kind = crypto`, экспонента у BTC 8) в `operating` не входит; в запас идёт только `liquidity_bp` его оценки — по умолчанию 0 (REQ-080).
// Форма счёта пишет `upsert_account` и, если задан остаток, якорь `set_anchor` на дату расчёта (оценка актива — тоже остаток). Числа считает `engine/liquidity.mjs`.
// Файл: чистая часть и узлы. Расчёт по введённым данным и правилам, не консультация.

import { currency_exponent } from '../engine/index.mjs';
import { liquidity_report, LIQUIDITY_GROUPS } from '../engine/liquidity.mjs';
import { h, table } from './dom.mjs';
import { oldest_review_date } from './rule_age.mjs';
import { format_input_amount, resolve_number_format } from './number_format.mjs';
import {
  bad, first_error, list_of, env_of, fmt_of, parse_money, parse_percent_bp, commit_edits, apply_chain, text_field, select_field, show_field_error, form_card,
} from './forms.mjs';

export const ACCOUNT_KINDS = Object.freeze(['cash', 'bank', 'savings', 'asset', 'debt', 'crypto']);

/** Ликвидность по умолчанию для вида счёта (пользователь может выбрать другую, кроме крипты на `operating`). */
export const DEFAULT_LIQUIDITY = Object.freeze({ cash: 'operating', bank: 'operating', savings: 'savings', asset: 'asset', debt: 'debt', crypto: 'asset' });

const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/**
 * Правки счёта из текстовых полей: `upsert_account` и, если указан остаток, `set_anchor` на дату расчёта.
 * @param {object} ws
 * @param {{account_id: string, name: string, kind: string, liquidity?: string, currency: string, liquidity_bp?: string, balance?: string}} t
 * @param {{cur: string, lang: 'ru'|'en', nf?: any, as_of: string}} env
 * @returns {{ok: true, edits: object[], account: object}|{ok: false, error: object}}
 */
export function build_account_edits(ws, t, env) {
  if (!is_obj(t)) return bad('E_SCHEMA', 'form', 'not_object');
  const name = typeof t.name === 'string' ? t.name.trim() : '';
  if (name === '') return bad('E_SCHEMA', 'name', 'empty');
  if (!ACCOUNT_KINDS.includes(t.kind)) return bad('E_SCHEMA', 'kind', 'not_in_list');
  const liquidity = t.liquidity === undefined || t.liquidity === '' ? DEFAULT_LIQUIDITY[t.kind] : t.liquidity;
  if (!LIQUIDITY_GROUPS.includes(liquidity)) return bad('E_SCHEMA', 'liquidity', 'not_in_list');
  if (t.kind === 'crypto' && liquidity === 'operating') return bad('E_SCHEMA', 'liquidity', 'crypto_not_operating');
  const currency = typeof t.currency === 'string' ? t.currency.trim().toUpperCase() : '';
  let exponent;
  try { exponent = currency_exponent(currency); } catch { return bad('E_SCHEMA', 'currency', 'unknown_currency'); }
  const has = (x) => typeof x === 'string' && x.trim() !== '';
  const bp = has(t.liquidity_bp) ? parse_percent_bp(t.liquidity_bp, env, 'liquidity_bp') : { ok: true, value: 0 };
  const balance = has(t.balance) ? parse_money(t.balance, env, 'balance', { cur: currency, negative: true, zero: true }) : { ok: true, value: null };
  const err = first_error([bp, balance]);
  if (err !== null) return err;
  const old = list_of(ws, 'accounts').find((a) => a?.account_id === t.account_id);
  const account = { ...(old === undefined ? {} : JSON.parse(JSON.stringify(old))), account_id: t.account_id, name, kind: t.kind, liquidity, currency, exponent, liquidity_bp: bp.value };
  if (old === undefined && account.opened_on === undefined) account.opened_on = env.as_of;
  const edits = [{ type: 'upsert_account', account }];
  if (balance.value !== null) edits.push({ type: 'set_anchor', anchor: { account_id: t.account_id, date: env.as_of, amount_minor: balance.value } });
  return { ok: true, edits, account };
}

/**
 * Отчёт для карточки: деньги на операционных счетах, запас (отдельно), резервы, счета по группам. Вся арифметика — `liquidity_report`.
 * @param {object} ws
 */
export function liquidity_model(ws) {
  const rep = liquidity_report(ws, ws.as_of);
  const groups = {};
  for (const g of LIQUIDITY_GROUPS) groups[g] = rep.accounts.filter((a) => a.liquidity === g);
  return { ...rep, groups };
}

// ── узлы ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Карточка «Запас и счета» (REQ-018): деньги на операционных счетах и запас отдельными строками, счета по группам ликвидности, вклад каждого в запас.
 * Нет счетов — `null`.
 * @param {object} ctx контекст расширений
 * @returns {HTMLElement|null}
 */
export function render_liquidity_card(ctx) {
  const ws = ctx.get_ws();
  if (ws === null || ws === undefined || list_of(ws, 'accounts').length === 0) return null;
  let m;
  try { m = liquidity_model(ws); } catch { return null; }
  const env = env_of(ctx, ws);
  const f = fmt_of(env);
  const model = ctx.get_model();
  const off = model !== null && model !== undefined && Object.values(model.ctx.rule_status ?? {}).includes('disabled');
  const off_since = off ? (oldest_review_date(ws, model.ctx.as_of, model.ctx.rule_status, 'disabled') ?? ctx.tr('c.na')) : null;
  const nodes = [
    h('h3', { id: 'fp08-liq-title', text: ctx.tr('forms.liq_title') }),
    h('p', { text: ctx.tr('forms.liq_line_operating', { value: f.money(m.operating_minor) }) }),
    h('p', { class: 'fp08-big', text: ctx.tr('forms.liq_line_stock', { value: f.money(m.stock_minor) }) }),
    h('p', { class: 'muted', text: ctx.tr('forms.liq_line_parts', { savings: f.money(m.savings_minor), asset: f.money(m.asset_minor), crypto: f.money(m.crypto_minor) }) }),
    // FP-15 (REQ-067, C-024): под правилом, не подтверждённым дольше двух сроков годности, сумма резервов (в ней налоговый конверт) заменяется текстом
    h('p', { class: 'muted', text: off_since === null ? ctx.tr('forms.liq_line_reserve', { value: f.money(m.reserve_minor) }) : ctx.tr('reserveui.liq_masked', { since: off_since }) }),
  ];
  if (!m.complete) nodes.push(h('p', { class: 'banner tight', role: 'status', text: ctx.tr('forms.liq_incomplete') }));
  const rows = [];
  for (const g of LIQUIDITY_GROUPS) {
    for (const a of m.groups[g]) {
      const af = fmt_of(env, a.currency);
      const contrib = a.error !== null ? ctx.tr('forms.liq_error', { code: a.error })
        : g === 'operating' ? ctx.tr('forms.liq_in_forecast') : g === 'debt' ? ctx.tr('forms.liq_reference') : f.money(a.value_minor ?? 0);
      rows.push(h('tr', { 'data-account': a.account_id },
        h('td', { text: a.name }), h('td', { text: ctx.tr('forms.liq_' + g) }),
        h('td', { text: a.balance_minor === null ? ctx.tr('forms.liq_unknown') : af.money(a.balance_minor) }),
        h('td', { text: (g === 'asset' || a.kind === 'crypto') && g !== 'operating' ? f.bp(a.liquidity_bp) : '' }),
        h('td', { text: contrib })));
    }
  }
  nodes.push(table(ctx.tr('forms.liq_table'), [ctx.tr('forms.liq_col_account'), ctx.tr('forms.liq_col_group'), ctx.tr('forms.liq_col_balance'), ctx.tr('forms.liq_col_bp'), ctx.tr('forms.liq_col_stock')], rows));
  nodes.push(h('p', { class: 'muted', text: ctx.tr('forms.liq_note') }));
  return h('section', { class: 'card fp08-card', id: 'fp08-liq', 'aria-labelledby': 'fp08-liq-title' }, nodes);
}

/**
 * Раздел «Счета»: карточка запаса и форма счёта (вид, ликвидность, валюта, доля в запасе, остаток).
 * @param {object} ctx контекст расширений
 * @returns {HTMLElement}
 */
export function render_accounts(ctx) {
  const ws = ctx.get_ws();
  const root = h('section', { class: 'fp08-section', id: 'fp08-sec-accounts', 'aria-labelledby': 'fp08-sec-accounts-title' }, h('h3', { id: 'fp08-sec-accounts-title', text: ctx.tr('forms.accounts_title') }));
  if (ws === null || ws === undefined) { root.append(h('p', { class: 'muted', text: ctx.tr('forms.no_data') })); return root; }
  const env = env_of(ctx, ws);
  root.append(h('p', { class: 'lead', text: ctx.tr('forms.accounts_lead') }));
  const card = render_liquidity_card(ctx);
  if (card !== null) root.append(card);

  let editing = null;
  const new_id = ctx.new_id('acc');
  const existing = list_of(ws, 'accounts');
  const sel = select_field(ctx, 'acc', 'account_id', [{ value: '', text: ctx.tr('forms.acc_new') }, ...existing.map((a) => ({ value: a.account_id, text: a.name }))], '');
  const name = text_field(ctx, 'acc', 'name', { hint: ctx.tr('forms.h_acc_name') });
  const kind = select_field(ctx, 'acc', 'kind', ACCOUNT_KINDS.map((k) => ({ value: k, text: ctx.tr('forms.akind_' + k) })), 'bank');
  const liquidity = select_field(ctx, 'acc', 'liquidity', [{ value: '', text: ctx.tr('forms.liq_auto') }, ...LIQUIDITY_GROUPS.map((g) => ({ value: g, text: ctx.tr('forms.liq_' + g) }))], '', { hint: ctx.tr('forms.h_acc_liquidity') });
  const currency = text_field(ctx, 'acc', 'currency', { value: env.cur, hint: ctx.tr('forms.h_acc_currency') });
  const bp = text_field(ctx, 'acc', 'liquidity_bp', { inputmode: 'decimal', hint: ctx.tr('forms.h_acc_bp') });
  const balance = text_field(ctx, 'acc', 'balance', { inputmode: 'decimal', hint: ctx.tr('forms.h_acc_balance') });
  const fields = [sel, name, kind, liquidity, currency, bp, balance];
  const texts = () => ({
    account_id: editing ?? new_id, name: name.input.value, kind: kind.input.value, liquidity: liquidity.input.value, currency: currency.input.value,
    liquidity_bp: bp.input.value, balance: balance.input.value,
  });
  sel.input.addEventListener('change', () => {
    editing = sel.input.value === '' ? null : sel.input.value;
    const a = existing.find((x) => x.account_id === editing);
    if (a === undefined) return;
    name.input.value = a.name ?? '';
    kind.input.value = a.kind;
    liquidity.input.value = a.liquidity;
    currency.input.value = a.currency;
    bp.input.value = format_input_amount(a.liquidity_bp ?? 0, 2, resolve_number_format(env.lang, env.nf), true);
    balance.input.value = '';
  });
  const submit = () => {
    const built = build_account_edits(ws, texts(), env);
    if (!built.ok) { show_field_error(ctx, fields.find((x) => x.id.endsWith('-' + (built.error.ctx.field ?? ''))) ?? name, built.error); return built; }
    const dry = apply_chain(ws, built.edits, { new_id: ctx.new_id, as_of: ws.as_of });
    if (!dry.ok) { show_field_error(ctx, fields.find((x) => x.id.endsWith('-' + (dry.error.ctx?.field?.split('.').pop() ?? ''))) ?? name, dry.error); return dry; }
    const r = commit_edits(ctx, built.edits, 'upsert_account');
    if (r.ok) ctx.notify(ctx.tr(editing === null ? 'forms.acc_saved' : 'forms.acc_updated', { name: built.account.name }), 'info');
    return r;
  };
  root.append(form_card(ctx, 'acc', ctx.tr('forms.acc_form_title'), ctx.tr('forms.acc_form_lead'), fields, ctx.tr('forms.save'), submit).form);
  return root;
}

