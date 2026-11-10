// debt_edit.mjs — долг записывается в прогноз (FP-14, REQ-082, REQ-083, ALG-09 A09.3–A09.5, IDEA-22).
// До этого пакета экран «Долги» (FP-09) был калькулятором: график, «что если досрочно» и сверка с банком ничего не записывали, а платежи графика попадали в
// прогноз, только если долг пришёл из файла. Здесь появляется запись: форма «Добавить в прогноз» превращает рассчитанный график в сохранённый долг
// (`ws.debts`, график — источник истины), а у сохранённого долга есть перенос платежа, досрочное погашение и ре-якорение по факту банка. Платежи входят в
// «свободно» и в волны платежей как плановые обязательства (`engine/timeline.build_events`), платежи за горизонтом не пропадают молча (предупреждение
// `W_DEBT_BEYOND_HORIZON`, `engine/warnings_ext.mjs`).
//
// Файл делится на виды правок (чистые функции для `ws_edit.register_edit`; регистрирует `pack_fp14.mjs`), чистые модели показа (проверяются в Node) и узлы.
// Запись данных — только через `ctx.edit` (проверка → копия → пересчёт страницей → журнал → «Отменить»): корзина `debts` известна единой стопке отмены
// (S1.3), одно нажатие — одна единица. Тексты пользователя (название долга) попадают в страницу только через textContent и не попадают в контекст ошибок.
// График по модели не равен договору банка (дни, комиссии, плавающая ставка): это расчёт по введённым данным, не консультация.

import { fail, parse_date, format_date, rate_at, round_div, currency_exponent } from '../engine/index.mjs';
import {
  build_debt_record, move_row_date, apply_prepay, apply_reanchor, rows_of, rows_totals, debt_status, drift_tol_bp, rounding_of,
} from '../engine/debt_ext.mjs';
import { h, table } from './dom.mjs';
import { ID_KINDS, decision_currency_of } from './ws_edit.mjs';
import { AUTO_PREFIX } from './ws_bridge.mjs';
import { is_valid_id, clock_ports } from './ids.mjs';
import { parse_amount_text } from './number_format.mjs';
import { list_of, env_of, fmt_of, error_text } from './forms.mjs';
import { create_focus_keeper } from './focus_keep.mjs';

const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// ── виды правок ─────────────────────────────────────────────────────────────────────────────────────────────────────

const DEBT_KEYS = ['debt_id', 'name', 'pay_account_id', 'account_id', 'kind', 'principal_minor', 'rate_bp', 'n', 'start_date', 'currency'];
const KINDS = ['annuity', 'differential', 'installment_0'];
const OPTIONS = ['shorten', 'lower_payment'];
/** Строк графика, больше которых карточка не рисует таблицу и формы (граница `validate_debt` — 600; запись из чужого файла может быть длиннее). */
export const MAX_CARD_ROWS = 600;

/** Отказ с кодом канона и контекстом `{field, reason, …}`: названия и другие тексты пользователя в контекст не попадают. */
const bad = (code, field, reason, extra) => fail(code, { field, reason, ...extra });

function allow_keys(obj, allowed, field) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) bad('E_SCHEMA', field, 'unknown_field', { key: k.slice(0, 40) });
}

function need_obj(x, field) {
  if (!is_obj(x)) bad('E_SCHEMA', field, 'not_object');
  return x;
}

function id_of(x, field) {
  if (!is_valid_id(x) || x.startsWith(AUTO_PREFIX)) bad('E_SCHEMA', field, 'bad_id');
  return x;
}

/** Целое с границами: нецелое — `E_NOT_INTEGER`, вне safe-диапазона — `E_OVERFLOW`, вне границ — `E_SCHEMA`. */
function int_of(x, field, min, max) {
  if (typeof x !== 'number' || !Number.isInteger(x)) bad('E_NOT_INTEGER', field, 'not_integer');
  if (!Number.isSafeInteger(x)) bad('E_OVERFLOW', field, 'unsafe_integer');
  if (min !== undefined && x < min) bad('E_SCHEMA', field, 'below_min');
  if (max !== undefined && x > max) bad('E_SCHEMA', field, 'above_max');
  return x;
}

/** Дата канонического вида `ГГГГ-ММ-ДД`. */
function date_of(x, field) {
  if (typeof x !== 'string') bad('E_BAD_DATE', field, 'not_iso_string');
  let d;
  try { d = parse_date(x); } catch { bad('E_BAD_DATE', field, 'bad_date'); }
  if (format_date(d) !== x) bad('E_BAD_DATE', field, 'not_canonical');
  return x;
}

function name_of(x, field) {
  if (typeof x !== 'string') bad('E_SCHEMA', field, 'not_string');
  const t = x.normalize('NFC').trim();
  if (t === '') bad('E_SCHEMA', field, 'name_empty');
  if (t.length > 120) bad('E_SCHEMA', field, 'too_long');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(t)) bad('E_SCHEMA', field, 'control_chars');
  return t;
}

function currency_of(x, field) {
  if (typeof x !== 'string' || !/^[A-Z0-9]{3,10}$/.test(x)) bad('E_SCHEMA', field, 'bad_currency');
  try { currency_exponent(x); } catch { bad('E_SCHEMA', field, 'unknown_currency'); }
  return x;
}

function account_of(ws, id, field) {
  const a = list_of(ws, 'accounts').find((x) => x?.account_id === id);
  if (a === undefined) bad('E_SCHEMA', field, 'unknown_account');
  return a;
}

/** Идентификатор долга не занят сущностью другого вида (единое пространство `Id`, C-025). */
function claim_debt_id(ws, id) {
  for (const [kind, [bucket, f]] of Object.entries(ID_KINDS)) {
    if (kind === 'debt') continue;
    const arr = bucket === 'tax_rules' ? list_of(ws, bucket).flat() : list_of(ws, bucket);
    if (arr.some((x) => x?.[f] === id)) bad('E_SCHEMA', 'debt.debt_id', 'id_taken_by_other_kind', { kind });
  }
}

/** Курс валюты платежей к валюте решения на дату: нет курса — `E_NO_RATE`. */
function need_rate(ws, currency, date, field) {
  const dec = decision_currency_of(ws);
  if (dec === null || currency === dec) return;
  let r = null;
  try { r = rate_at(list_of(ws, 'rates'), currency, dec, date); } catch { r = null; }
  if (r === null) bad('E_NO_RATE', field, 'no_rate', { currency, decision_currency: dec });
}

function debt_at(ws, id, field) {
  const debts = list_of(ws, 'debts');
  const i = debts.findIndex((x) => x?.debt_id === id_of(id, field));
  if (i < 0) bad('E_SCHEMA', field, 'unknown_debt');
  return { debts, i, debt: debts[i] };
}

const replace_at = (arr, i, item) => arr.map((x, j) => (j === i ? item : x));

/**
 * Вид правки `upsert_debt` (REQ-082): `{type, debt: {debt_id?, name, pay_account_id, [account_id], kind, principal_minor, rate_bp, n, start_date, [currency]}}`.
 * Долг записывается со СОХРАНЁННЫМ графиком (`build_debt_record`): платёжный счёт — операционный, открытый на дату расчёта; валюта долга = валюте счёта
 * (`E_CURRENCY_MISMATCH`); для чужой валюты нужен курс (`E_NO_RATE`); ограничения графика — `validate_debt` (C-041); первый платёж не раньше даты расчёта.
 * Запись с тем же `debt_id` заменяется целиком: график считается заново по условиям, прежние переносы и «что применено» не сохраняются.
 * @returns {object} новая рабочая область
 */
export function edit_upsert_debt(ws, edit, env) {
  allow_keys(edit, ['type', 'debt'], 'edit');
  const d = need_obj(edit.debt, 'debt');
  allow_keys(d, DEBT_KEYS, 'debt');
  const given = d.debt_id ?? env.new_id?.('debt');
  if (given === undefined) bad('E_SCHEMA', 'debt.debt_id', 'id_required');
  const id = id_of(given, 'debt.debt_id');
  claim_debt_id(ws, id);
  const name = name_of(d.name, 'debt.name');
  const acc = account_of(ws, id_of(d.pay_account_id, 'debt.pay_account_id'), 'debt.pay_account_id');
  if (acc.liquidity !== 'operating') bad('E_SCHEMA', 'debt.pay_account_id', 'pay_account_not_operating');
  if (typeof acc.closed_on === 'string' && acc.closed_on <= env.as_of) bad('E_SCHEMA', 'debt.pay_account_id', 'pay_account_closed');
  const currency = d.currency === undefined ? acc.currency : currency_of(d.currency, 'debt.currency');
  if (currency !== acc.currency) bad('E_CURRENCY_MISMATCH', 'debt.currency', 'differs_from_account', { currency, account_currency: acc.currency });
  let account_id;
  if (d.account_id !== undefined) {
    const da = account_of(ws, id_of(d.account_id, 'debt.account_id'), 'debt.account_id');
    if (da.liquidity !== 'debt') bad('E_SCHEMA', 'debt.account_id', 'not_a_debt_account');
    account_id = da.account_id;
  }
  if (!KINDS.includes(d.kind)) bad('E_SCHEMA', 'debt.kind', 'not_in_list');
  const principal_minor = int_of(d.principal_minor, 'debt.principal_minor', 1);
  const rate_bp = int_of(d.rate_bp, 'debt.rate_bp', 0);
  const n = int_of(d.n, 'debt.n', 1);
  const start_date = date_of(d.start_date, 'debt.start_date');
  if (start_date < env.as_of) bad('E_BAD_DATE', 'debt.start_date', 'first_payment_before_as_of');
  need_rate(ws, currency, start_date, 'debt.currency');
  const record = build_debt_record({
    debt_id: id, name, pay_account_id: acc.account_id, account_id, currency, kind: d.kind, principal_minor, rate_bp, n, start_date, rounding: rounding_of(ws.params),
  });
  const debts = list_of(ws, 'debts');
  const i = debts.findIndex((x) => x?.debt_id === id);
  return { ...ws, debts: i < 0 ? [...debts, record] : replace_at(debts, i, record) };
}

/** Вид правки `delete_debt`: `{type, debt_id}` — убрать долг из прогноза (запись и её график). */
export function edit_delete_debt(ws, edit) {
  allow_keys(edit, ['type', 'debt_id'], 'edit');
  const { debts, i } = debt_at(ws, edit.debt_id, 'debt_id');
  return { ...ws, debts: debts.filter((_, j) => j !== i) };
}

/** Вид правки `move_debt_row` (REQ-082): `{type, debt_id, k, date}` — перенос даты строки графика, сумма не меняется. */
export function edit_move_debt_row(ws, edit, env) {
  allow_keys(edit, ['type', 'debt_id', 'k', 'date'], 'edit');
  const { debts, i, debt } = debt_at(ws, edit.debt_id, 'debt_id');
  const k = int_of(edit.k, 'k', 1);
  const next = move_row_date(debt, k, date_of(edit.date, 'date'), env.as_of);
  return { ...ws, debts: replace_at(debts, i, next) };
}

/** Вид правки `apply_prepay` (REQ-083): `{type, debt_id, date, amount_minor, option: 'shorten'|'lower_payment'}` — досрочное погашение в день платежа. */
export function edit_apply_prepay(ws, edit, env) {
  allow_keys(edit, ['type', 'debt_id', 'date', 'amount_minor', 'option'], 'edit');
  const { debts, i, debt } = debt_at(ws, edit.debt_id, 'debt_id');
  if (!OPTIONS.includes(edit.option)) bad('E_SCHEMA', 'option', 'not_in_list');
  const next = apply_prepay(debt, {
    date: date_of(edit.date, 'date'), amount_minor: int_of(edit.amount_minor, 'amount_minor', 1), option: edit.option, as_of: env.as_of,
  });
  return { ...ws, debts: replace_at(debts, i, next) };
}

/** Вид правки `apply_reanchor` (REQ-083): `{type, debt_id, k, observed_minor}` — остаток по данным банка после `k` платежей заменяет модельный. */
export function edit_apply_reanchor(ws, edit, env) {
  allow_keys(edit, ['type', 'debt_id', 'k', 'observed_minor'], 'edit');
  const { debts, i, debt } = debt_at(ws, edit.debt_id, 'debt_id');
  const r = apply_reanchor(debt, { k: int_of(edit.k, 'k', 1), observed_minor: int_of(edit.observed_minor, 'observed_minor', 0), as_of: env.as_of });
  return { ...ws, debts: replace_at(debts, i, r.debt) };
}

/** Виды правок пакета (`ws_edit.register_edit`). */
export const EDITS = Object.freeze({
  upsert_debt: edit_upsert_debt,
  delete_debt: edit_delete_debt,
  move_debt_row: edit_move_debt_row,
  apply_prepay: edit_apply_prepay,
  apply_reanchor: edit_apply_reanchor,
});

// ── модели показа (без DOM) ─────────────────────────────────────────────────────────────────────────────────────────

/** Операционные счета в валюте `cur`, открытые на дату расчёта: из них выбирается счёт платежей. */
export function pay_accounts(ws, cur) {
  const as_of = typeof ws?.as_of === 'string' ? ws.as_of : '';
  return list_of(ws, 'accounts').filter((a) => is_obj(a) && a.liquidity === 'operating' && a.currency === cur && typeof a.account_id === 'string'
    && (typeof a.closed_on !== 'string' || a.closed_on > as_of));
}

/** Правка `upsert_debt` из плана калькулятора (`debts.make_plan`) и значений формы добавления. */
export function add_edit(plan, o) {
  return {
    type: 'upsert_debt',
    debt: {
      debt_id: o.debt_id, name: o.name, pay_account_id: o.pay_account_id, kind: plan.kind, principal_minor: plan.principal_minor, rate_bp: plan.rate_bp, n: plan.n,
      start_date: plan.start_date,
    },
  };
}

/** Уже есть записанный долг с теми же условиями (защита от двойного нажатия): счёт платежей, вид, сумма, ставка, число платежей, первая дата. */
export function same_terms_exists(ws, plan, pay_account_id) {
  return list_of(ws, 'debts').some((d) => is_obj(d) && d.pay_account_id === pay_account_id && d.kind === plan.kind && d.principal_minor === plan.principal_minor
    && d.rate_bp === plan.rate_bp && d.n === plan.n && d.start_date === plan.start_date);
}

/** Текст отказа записи: причина (`ctx.reason`) из каталога пакета, иначе общий текст формы (код канона без повтора введённого). */
export function reason_text(ctx, error) {
  const reason = typeof error?.ctx?.reason === 'string' ? error.ctx.reason : '';
  if (reason !== '') {
    const text = ctx.tr('debtedit.r_' + reason);
    if (text !== 'debtedit.r_' + reason) return text;
  }
  return error_text(ctx, error);
}

/** Причина отказа расчёта (исключение движка) → `{code, reason}`. */
function failure_of(e) {
  return { ok: false, code: typeof e?.code === 'string' ? e.code : 'E_SCHEMA', reason: typeof e?.ctx?.reason === 'string' ? e.ctx.reason : null };
}

/**
 * «Что если досрочно» для сохранённого долга: оба варианта на тех же правилах, что и запись (`apply_prepay`), рядом с графиком без досрочного.
 * @param {object} debt
 * @param {number} k номер платежа (1…n−1), в день которого вносится сумма
 * @param {number} amount_minor
 * @param {string} as_of
 * @returns {{ok: true, k: number, date: string, now: object, options: Object<string, object>}|{ok: false, code: string, reason: string|null}}
 */
export function prepay_preview(debt, k, amount_minor, as_of) {
  try {
    const rows = rows_of(debt);
    if (!Number.isInteger(k) || k < 1 || k >= rows.length) return { ok: false, code: 'E_SCHEMA', reason: 'prepay_only_on_payment_date_before_last' };
    const date = format_date(rows[k - 1].date);
    const now = rows_totals(rows.slice(k));
    const options = {};
    for (const option of OPTIONS) {
      try {
        const next = apply_prepay(debt, { date, amount_minor, option, as_of });
        const tail = rows_totals(rows_of(next).slice(k));
        options[option] = { ok: true, debt: next, tail, saved_interest_minor: now.interest_minor - (tail === null ? 0 : tail.interest_minor) };
      } catch (e) { options[option] = failure_of(e); }
    }
    return { ok: true, k, date, now, options };
  } catch (e) { return failure_of(e); }
}

/**
 * Сверка сохранённого долга с банком: дрейф = наблюдаемый остаток − модельный; в bp он считается от модельного остатка (целочисленно); допуск — `debt.drift_tol_bp`.
 * @returns {{ok: true, debt: object, drift_minor: number, drift_bp: number, tol_bp: number, over_tolerance: boolean, modeled_minor: number, tail: object|null}|{ok: false, code: string, reason: string|null}}
 */
export function reanchor_preview(debt, k, observed_minor, tol_bp, as_of) {
  try {
    const r = apply_reanchor(debt, { k, observed_minor, as_of });
    const abs = Math.abs(r.drift_minor);
    const bp = r.modeled_minor === 0 ? (abs === 0 ? 0 : 10000) : round_div(abs * 10000, r.modeled_minor);
    return {
      ok: true, debt: r.debt, drift_minor: r.drift_minor, drift_bp: r.drift_minor < 0 ? -bp : bp, tol_bp, over_tolerance: bp > tol_bp, modeled_minor: r.modeled_minor,
      tail: rows_totals(rows_of(r.debt).slice(k)),
    };
  } catch (e) { return failure_of(e); }
}

// ── состояние и зависимости экрана ─────────────────────────────────────────────────────────────────────────────────

/** Состояние форм и хранитель фокуса на один контекст (в тестах часы подменяются). */
export function make_deps(env = {}) {
  const ports = env.ports ?? clock_ports();
  return { ui: { name: null, account: null, by: new Map() }, focus: create_focus_keeper(ports.now_ms) };
}

/** Состояние форм одного долга (по идентификатору; `Map`, чтобы идентификатор из чужого файла не задел прототип). */
function state_of(deps, debt_id) {
  let st = deps.ui.by.get(debt_id);
  if (st === undefined) {
    st = { mv_k: null, mv_date: null, pp_k: null, pp_amount: '', ra_k: null, ra_observed: '' };
    deps.ui.by.set(debt_id, st);
  }
  return st;
}

/** Дата из поля `type="date"`: всегда `ГГГГ-ММ-ДД` (формат чисел рабочей области на неё не влияет); несуществующая — `null`. */
function iso_or_null(text) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  try { return format_date(parse_date(s)) === s ? s : null; } catch { return null; }
}

// ── узлы ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const wrap_table = (t) => h('div', { class: 'table-wrap' }, t);

function text_input(id, label, o = {}) {
  const input = h('input', {
    id, type: o.type ?? 'text', inputmode: o.inputmode ?? null, autocomplete: 'off', spellcheck: 'false', value: o.value ?? '', maxlength: o.maxlength ?? null,
    'aria-describedby': id + '-err',
  });
  const err = h('p', { id: id + '-err', class: 'error', role: 'alert' });
  return { input, err, wrap: h('div', { class: 'field' }, h('label', { for: id, text: label }), input, err) };
}

function select_input(id, label, options, value) {
  const select = h('select', { id, 'aria-describedby': id + '-err' },
    options.map((o) => h('option', { value: o.value, selected: o.value === value ? true : null, text: o.text })));
  if (value !== undefined && value !== null) select.value = value;
  const err = h('p', { id: id + '-err', class: 'error', role: 'alert' });
  return { input: select, err, wrap: h('div', { class: 'field' }, h('label', { for: id, text: label }), select, err) };
}

function set_disabled(btn, disabled) {
  if (disabled) btn.setAttribute('disabled', '');
  else btn.removeAttribute('disabled');
}

/** Записать правку общим путём: фокус просят ДО записи (страница перерисуется внутри `ctx.edit`); отказ — текст у поля, данные не меняются. */
function commit(ctx, deps, edit, focus_id, err) {
  err.textContent = '';
  deps.focus.request(focus_id);
  const r = ctx.edit(edit);
  if (r.ok !== true) {
    deps.focus.clear();
    err.textContent = reason_text(ctx, r.error);
  }
  return r;
}

/**
 * Блок «Записать в прогноз» под расчётом калькулятора «Долги»: название, счёт платежей и кнопка «Добавить в прогноз».
 * @param {object} ctx контекст расширений
 * @param {object} deps `make_deps()`
 * @param {{model: object, plan: object, touched?: boolean}} a модель страницы, план калькулятора (`debts.make_plan`) и признак «поля калькулятора менялись»
 * @returns {HTMLElement}
 */
export function render_add_block(ctx, deps, a) {
  const tr = ctx.tr;
  const ws = a.model.ws;
  const accounts = pay_accounts(ws, a.model.cur);
  const has = (id) => accounts.some((x) => x.account_id === id);
  const chosen = has(deps.ui.account) ? deps.ui.account : (has(a.plan.pay_account_id) ? a.plan.pay_account_id : accounts[0]?.account_id);
  const root = h('section', { class: 'card', id: 'fp14-add', 'aria-labelledby': 'fp14-add-title' },
    h('h3', { id: 'fp14-add-title', text: tr('debtedit.add_title') }),
    h('p', { class: 'muted', text: tr('debtedit.add_lead') }));
  if (chosen === undefined) { root.append(h('p', { class: 'banner short', role: 'alert', text: tr('debtedit.r_pay_account_closed') })); return root; }
  const name = text_input('fp14-add-name', tr('debtedit.f_name'), { value: deps.ui.name ?? tr('debtedit.default_name'), maxlength: 120 });
  const account = select_input('fp14-add-account', tr('debtedit.f_account'),
    accounts.map((x) => ({ value: x.account_id, text: typeof x.name === 'string' && x.name !== '' ? x.name : x.account_id })), chosen);
  const btn = h('button', { type: 'button', class: 'btn primary', id: 'fp14-add-btn', text: tr('debtedit.add_btn'), 'aria-describedby': 'fp14-add-note' });
  const note = h('p', { id: 'fp14-add-note', class: 'muted', role: 'status' });
  const err = h('p', { id: 'fp14-add-err', class: 'error', role: 'alert' });
  // пример в форме (сумма, ставка, срок) — не данные пользователя: пока поля калькулятора не менялись, записать его в прогноз нельзя
  const refresh = () => {
    const exists = same_terms_exists(ws, a.plan, account.input.value);
    set_disabled(btn, a.touched !== true || exists);
    note.textContent = a.touched !== true ? tr('debtedit.add_example') : (exists ? tr('debtedit.add_exists') : '');
  };
  btn.addEventListener('click', () => {
    deps.ui.name = name.input.value;
    deps.ui.account = account.input.value;
    name.err.textContent = '';
    const nm = String(name.input.value ?? '').trim();
    if (nm === '') { name.err.textContent = tr('debtedit.r_name_empty'); name.input.setAttribute('aria-invalid', 'true'); return; }
    name.input.setAttribute('aria-invalid', 'false');
    const r = commit(ctx, deps, add_edit(a.plan, { debt_id: ctx.new_id('debt'), name: nm, pay_account_id: account.input.value }), 'fp14-saved-title', err);
    if (r.ok === true) ctx.notify(tr('debtedit.added', { name: nm, n: a.plan.n }), 'info');
  });
  account.input.addEventListener('change', () => { deps.ui.account = account.input.value; refresh(); });
  name.input.addEventListener('input', () => { deps.ui.name = name.input.value; });
  refresh();
  root.append(h('div', { class: 'grid' }, name.wrap, account.wrap), note, btn, err);
  return root;
}

/** Строка истории «что применено» → текст. */
function history_line(ctx, f, entry) {
  const tr = ctx.tr;
  if (!is_obj(entry)) return null;
  const on = typeof entry.on === 'string' ? f.date(entry.on) : '';
  if (entry.kind === 'move') return tr('debtedit.hist_move', { on, k: entry.k, from: f.date(entry.from), to: f.date(entry.to) });
  if (entry.kind === 'prepay') {
    return tr('debtedit.hist_prepay', {
      on, amount: f.money(entry.amount_minor), k: entry.k, date: f.date(entry.date), option: entry.option === 'shorten' ? tr('debtedit.opt_shorten') : tr('debtedit.opt_lower'),
    });
  }
  if (entry.kind === 'reanchor') {
    const sign = entry.drift_minor > 0 ? '+' : '';
    return tr('debtedit.hist_reanchor', { on, k: entry.k, observed: f.money(entry.observed_minor), drift: sign + f.money(entry.drift_minor) });
  }
  return null;
}

function schedule_node(ctx, f, debt, rows) {
  const tr = ctx.tr;
  const with_extra = rows.some((r) => (r.extra_minor ?? 0) > 0);
  const head = ['showcase.db_col_k', 'showcase.db_col_date', 'showcase.db_col_payment', 'showcase.db_col_interest', 'showcase.db_col_principal', 'showcase.db_col_balance'].map((k) => tr(k));
  if (with_extra) head.push(tr('debtedit.col_extra'));
  const body = rows.map((r) => h('tr', null,
    h('th', { scope: 'row', text: String(r.k) }), h('td', { text: f.date(r.date) }), h('td', { text: f.money(r.payment_minor) }), h('td', { text: f.money(r.interest_minor) }),
    h('td', { text: f.money(r.principal_minor) }), h('td', { text: f.money(r.balance_minor) }),
    with_extra ? h('td', { text: (r.extra_minor ?? 0) > 0 ? f.money(r.extra_minor) : '' }) : null));
  const name = typeof debt.name === 'string' && debt.name !== '' ? debt.name : String(debt.debt_id);
  return wrap_table(table(tr('debtedit.sched_caption', { name }), head, body, 'tbl'));
}

/** Перенос платежа: строка графика с датой не раньше «сегодня», новая дата, кнопка «Перенести». */
function move_form(ctx, deps, ws, debt, key, f, rows) {
  const tr = ctx.tr;
  const st = state_of(deps, debt.debt_id);
  const today = ws.as_of;
  const ahead = rows.filter((r) => format_date(r.date) >= today);
  const head = h('summary', { text: tr('debtedit.mv_title') });
  if (ahead.length === 0) return h('details', { class: 'card', id: key + '-mv' }, head, h('p', { class: 'muted', text: tr('debtedit.mv_none') }));
  const k_now = ahead.some((r) => String(r.k) === st.mv_k) ? st.mv_k : String(ahead[0].k);
  const sel = select_input(key + '-mv-k', tr('debtedit.mv_k'),
    ahead.map((r) => ({ value: String(r.k), text: tr('debtedit.mv_option', { k: r.k, date: f.date(r.date), amount: f.money(r.payment_minor) }) })), k_now);
  const date_of_k = (k) => format_date(rows[Number(k) - 1].date);
  const dt = text_input(key + '-mv-date', tr('debtedit.mv_date'), { type: 'date', value: st.mv_date ?? date_of_k(k_now) });
  const btn = h('button', { type: 'button', class: 'btn', id: key + '-mv-btn', text: tr('debtedit.mv_btn') });
  const err = h('p', { id: key + '-mv-err', class: 'error', role: 'alert' });
  sel.input.addEventListener('change', () => { st.mv_k = sel.input.value; st.mv_date = null; dt.input.value = date_of_k(sel.input.value); });
  dt.input.addEventListener('input', () => { st.mv_date = dt.input.value; });
  btn.addEventListener('click', () => {
    dt.err.textContent = '';
    const date = iso_or_null(dt.input.value);
    if (date === null) { dt.err.textContent = tr('debtedit.r_bad_date'); return; }
    const k = Number(sel.input.value);
    st.mv_date = null;
    const r = commit(ctx, deps, { type: 'move_debt_row', debt_id: debt.debt_id, k, date }, key + '-title', err);
    if (r.ok === true) ctx.notify(tr('debtedit.mv_done', { k, date: f.date(date) }), 'info');
  });
  return h('details', { class: 'card', id: key + '-mv' }, head, h('p', { class: 'muted', text: tr('debtedit.mv_lead') }),
    h('div', { class: 'grid' }, sel.wrap, dt.wrap), btn, err);
}

/** Досрочное погашение: платёж, сумма, сравнение вариантов и две кнопки «Применить». */
function prepay_form(ctx, deps, ws, debt, key, f, rows) {
  const tr = ctx.tr;
  const st = state_of(deps, debt.debt_id);
  const head = h('summary', { text: tr('debtedit.pp_title') });
  const first_ahead = rows.findIndex((r) => format_date(r.date) >= ws.as_of);
  const k_default = String(Math.min(rows.length - 1, Math.max(1, first_ahead < 0 ? rows.length - 1 : first_ahead + 1)));
  const opts = rows.slice(0, -1).map((r) => ({ value: String(r.k), text: tr('debtedit.pp_after', { k: r.k, date: f.date(r.date) }) }));
  if (opts.length === 0) return h('details', { class: 'card', id: key + '-pp' }, head, h('p', { class: 'muted', text: tr('debtedit.pp_none') }));
  const sel = select_input(key + '-pp-k', tr('debtedit.pp_k'), opts, opts.some((o) => o.value === st.pp_k) ? st.pp_k : k_default);
  const amt = text_input(key + '-pp-amount', tr('debtedit.pp_amount', { cur: debt.currency }), { inputmode: 'decimal', value: st.pp_amount });
  const res = h('div', { 'aria-live': 'polite', id: key + '-pp-res' });
  const err = h('p', { id: key + '-pp-err', class: 'error', role: 'alert' });
  const mk_btn = (suffix, text) => h('button', { type: 'button', class: 'btn', id: key + '-pp-' + suffix, text, 'aria-describedby': key + '-pp-res', disabled: true });
  const b_short = mk_btn('shorten', tr('debtedit.pp_apply_shorten'));
  const b_lower = mk_btn('lower', tr('debtedit.pp_apply_lower'));
  const current = { amount: null, k: null, date: null };
  const run = () => {
    st.pp_k = sel.input.value;
    st.pp_amount = amt.input.value;
    amt.err.textContent = '';
    err.textContent = '';
    res.replaceChildren();
    set_disabled(b_short, true);
    set_disabled(b_lower, true);
    if (amt.input.value.trim() === '') { res.replaceChildren(h('p', { class: 'muted', text: tr('debtedit.pp_hint') })); return; }
    const p = parse_amount_text(amt.input.value, debt.currency, ctx.lang(), ws.number_format);
    if (!p.ok || p.value < 1) { amt.err.textContent = tr('showcase.db_e_' + (p.ok ? 'zero' : p.reason)); return; }
    const k = Number(sel.input.value);
    const pv = prepay_preview(debt, k, p.value, ws.as_of);
    if (!pv.ok) { amt.err.textContent = reason_text(ctx, { code: pv.code, ctx: { reason: pv.reason } }); return; }
    current.amount = p.value; current.k = k; current.date = pv.date;
    const row = (label, base, fn) => h('tr', null, h('th', { scope: 'row', text: label }), h('td', { text: base }), ...OPTIONS.map((o) => h('td', { text: pv.options[o].ok ? fn(pv.options[o]) : '—' })));
    const notes = OPTIONS.filter((o) => !pv.options[o].ok).map((o) => h('p', { class: 'muted', text: tr('debtedit.pp_unavailable', {
      reason: reason_text(ctx, { code: pv.options[o].code, ctx: { reason: pv.options[o].reason } }) }) }));
    res.replaceChildren(
      wrap_table(table(tr('debtedit.pp_caption', { date: f.date(pv.date) }), [tr('debtedit.pp_col_what'), tr('debtedit.pp_now'), tr('debtedit.pp_shorten'), tr('debtedit.pp_lower')], [
        row(tr('debtedit.pp_row_count'), String(pv.now.count), (o) => String(o.tail === null ? 0 : o.tail.count)),
        row(tr('debtedit.pp_row_next'), f.money(pv.now.first_payment_minor), (o) => (o.tail === null ? '—' : f.money(o.tail.first_payment_minor))),
        row(tr('debtedit.pp_row_last'), f.date(pv.now.last_date), (o) => (o.tail === null ? '—' : f.date(o.tail.last_date))),
        row(tr('debtedit.pp_row_interest'), f.money(pv.now.interest_minor), (o) => f.money(o.tail === null ? 0 : o.tail.interest_minor)),
        row(tr('debtedit.pp_row_saved'), '—', (o) => f.money(o.saved_interest_minor)),
      ], 'tbl')),
      ...notes, h('p', { class: 'muted', text: tr('debtedit.pp_note') }));
    set_disabled(b_short, !pv.options.shorten.ok);
    set_disabled(b_lower, !pv.options.lower_payment.ok);
  };
  const apply = (option) => {
    if (current.amount === null) return;
    const r = commit(ctx, deps, { type: 'apply_prepay', debt_id: debt.debt_id, date: current.date, amount_minor: current.amount, option }, key + '-title', err);
    if (r.ok !== true) return;
    st.pp_amount = '';
    const after = (r.ws.debts ?? []).find((x) => x.debt_id === debt.debt_id);
    const ahead = after === undefined ? 0 : rows_of(after).slice(current.k).length;
    ctx.notify(tr(ahead === 0 ? 'debtedit.pp_done_closed' : 'debtedit.pp_done', { amount: f.money(current.amount), n: ahead }), 'info');
  };
  sel.input.addEventListener('change', run);
  amt.input.addEventListener('input', run);
  b_short.addEventListener('click', () => apply('shorten'));
  b_lower.addEventListener('click', () => apply('lower_payment'));
  run();
  return h('details', { class: 'card', id: key + '-pp' }, head, h('p', { class: 'muted', text: tr('debtedit.pp_lead') }),
    h('div', { class: 'grid' }, sel.wrap, amt.wrap), res, h('div', { class: 'row' }, b_short, b_lower), err);
}

/** Сверка с банком: платёж, остаток по данным банка, расхождение с допуском и кнопка «Применить». */
function reanchor_form(ctx, deps, ws, debt, key, f, rows, tol) {
  const tr = ctx.tr;
  const st = state_of(deps, debt.debt_id);
  const head = h('summary', { text: tr('debtedit.ra_title') });
  const past = rows.filter((r) => format_date(r.date) < ws.as_of);
  const k_default = String(past.length === 0 ? 1 : past[past.length - 1].k);
  const sel = select_input(key + '-ra-k', tr('debtedit.ra_k'),
    rows.map((r) => ({ value: String(r.k), text: tr('debtedit.ra_after', { k: r.k, date: f.date(r.date) }) })), rows.some((r) => String(r.k) === st.ra_k) ? st.ra_k : k_default);
  const obs = text_input(key + '-ra-observed', tr('debtedit.ra_observed', { cur: debt.currency }), { inputmode: 'decimal', value: st.ra_observed });
  const res = h('div', { 'aria-live': 'polite', id: key + '-ra-res' });
  const err = h('p', { id: key + '-ra-err', class: 'error', role: 'alert' });
  const btn = h('button', { type: 'button', class: 'btn', id: key + '-ra-btn', text: tr('debtedit.ra_apply'), 'aria-describedby': key + '-ra-res', disabled: true });
  const current = { observed: null, k: null };
  const run = () => {
    st.ra_k = sel.input.value;
    st.ra_observed = obs.input.value;
    obs.err.textContent = '';
    err.textContent = '';
    res.replaceChildren();
    set_disabled(btn, true);
    if (obs.input.value.trim() === '') { res.replaceChildren(h('p', { class: 'muted', text: tr('debtedit.ra_hint') })); return; }
    const p = parse_amount_text(obs.input.value, debt.currency, ctx.lang(), ws.number_format);
    if (!p.ok) { obs.err.textContent = tr('showcase.db_e_' + p.reason); return; }
    const k = Number(sel.input.value);
    const pv = reanchor_preview(debt, k, p.value, tol, ws.as_of);
    if (!pv.ok) { res.replaceChildren(h('p', { class: 'banner short', role: 'alert', text: tr('debtedit.ra_unavailable', { reason: reason_text(ctx, { code: pv.code, ctx: { reason: pv.reason } }) }) })); return; }
    current.observed = p.value; current.k = k;
    const sign = pv.drift_minor > 0 ? '+' : '';
    const nodes = [
      h('p', { role: 'status', text: tr('debtedit.ra_drift', { modeled: f.money(pv.modeled_minor), observed: f.money(p.value), drift: sign + f.money(pv.drift_minor), bp: f.bp(Math.abs(pv.drift_bp)) }) }),
      h('p', { class: pv.over_tolerance ? 'banner tight' : 'muted', text: pv.over_tolerance ? tr('debtedit.ra_over', { tol: f.bp(pv.tol_bp) }) : tr('debtedit.ra_within', { tol: f.bp(pv.tol_bp) }) }),
    ];
    if (pv.tail === null) nodes.push(h('p', { class: 'muted', text: tr('debtedit.ra_closed') }));
    else nodes.push(h('p', { text: tr('debtedit.ra_tail', { n: pv.tail.count, payment: f.money(pv.tail.first_payment_minor), last: f.date(pv.tail.last_date), total: f.money(pv.tail.total_minor) }) }));
    res.replaceChildren(...nodes);
    set_disabled(btn, false);
  };
  btn.addEventListener('click', () => {
    if (current.observed === null) return;
    const r = commit(ctx, deps, { type: 'apply_reanchor', debt_id: debt.debt_id, k: current.k, observed_minor: current.observed }, key + '-title', err);
    if (r.ok !== true) return;
    st.ra_observed = '';
    const after = (r.ws.debts ?? []).find((x) => x.debt_id === debt.debt_id);
    const ahead = after === undefined ? 0 : rows_of(after).slice(current.k).length;
    ctx.notify(tr(ahead === 0 ? 'debtedit.ra_done_closed' : 'debtedit.ra_done', { observed: f.money(current.observed), n: ahead }), 'info');
  });
  sel.input.addEventListener('change', run);
  obs.input.addEventListener('input', run);
  run();
  return h('details', { class: 'card', id: key + '-ra' }, head, h('p', { class: 'muted', text: tr('debtedit.ra_lead', { tol: f.bp(tol) }) }),
    h('div', { class: 'grid' }, sel.wrap, obs.wrap), res, btn, err);
}

/** Карточка одного сохранённого долга. */
function render_debt_card(ctx, deps, model, debt, index) {
  const tr = ctx.tr;
  const ws = model.ws;
  const key = 'fp14-d' + index;
  const env = env_of(ctx, ws);
  const f = fmt_of(env, debt.currency);
  const st = debt_status(debt, model.ctx.as_of, model.ctx.horizon_end);
  const acc = list_of(ws, 'accounts').find((a) => a?.account_id === debt.pay_account_id);
  const name = typeof debt.name === 'string' && debt.name !== '' ? debt.name : String(debt.debt_id);
  const rows = st.rows;
  const up = st.upcoming;
  const pairs = [
    ['debtedit.sum_kind', tr('showcase.db_kind_' + debt.kind)],
    ['debtedit.sum_rate', f.bp(debt.rate_bp)],
    ['debtedit.sum_account', acc !== undefined && typeof acc.name === 'string' && acc.name !== '' ? acc.name : String(debt.pay_account_id)],
    ['debtedit.sum_outstanding', f.money(st.outstanding_minor)],
    ['debtedit.sum_next', st.next === null ? tr('debtedit.sum_left_none') : f.money(st.next.payment_minor) + ' · ' + f.date(st.next.date)],
    ['debtedit.sum_left', up === null ? tr('debtedit.sum_left_none') : tr('debtedit.sum_left_value', { n: up.count, date: f.date(up.last_date) })],
  ];
  if (up !== null) {
    pairs.push(['debtedit.sum_total', f.money(up.total_minor)], ['debtedit.sum_interest', f.money(up.interest_minor)]);
    if (up.extra_minor > 0) pairs.push(['debtedit.sum_extra', f.money(up.extra_minor)]);
  }
  const history = (Array.isArray(debt.history) ? debt.history : []).map((e) => history_line(ctx, f, e)).filter((x) => x !== null);
  const remove = h('button', { type: 'button', class: 'btn', id: key + '-rm', text: tr('debtedit.rm_btn'), 'aria-label': tr('debtedit.rm_aria', { name }) });
  const rm_err = h('p', { id: key + '-rm-err', class: 'error', role: 'alert' });
  remove.addEventListener('click', () => {
    const r = commit(ctx, deps, { type: 'delete_debt', debt_id: debt.debt_id }, 'fp14-saved-title', rm_err);
    if (r.ok === true) ctx.notify(tr('debtedit.rm_done', { name }), 'info');
  });
  return h('section', { class: 'card', id: key, 'aria-labelledby': key + '-title' },
    h('h4', { id: key + '-title', tabindex: '-1', text: name }),
    h('dl', { class: 'sc-dl' }, ...pairs.flatMap(([k, v]) => [h('dt', { text: tr(k) }), h('dd', { text: v })])),
    st.beyond.count > 0 ? h('p', { class: 'banner', role: 'status', text: tr('debtedit.beyond', {
      n: st.beyond.count, total: f.money(st.beyond.total_minor), date: f.date(st.beyond.first_date), horizon: f.date(model.ctx.horizon_end) }) }) : null,
    history.length === 0 ? null : h('div', null, h('h5', { text: tr('debtedit.hist_title') }), h('ul', null, ...history.map((t) => h('li', { text: t })))),
    ...(rows.length > MAX_CARD_ROWS ? [h('p', { class: 'banner short', role: 'status', text: tr('debtedit.card_too_long', { max: MAX_CARD_ROWS }) })] : [
      h('details', { class: 'card', open: true, id: key + '-sched' }, h('summary', { text: tr('debtedit.sched_title') }), schedule_node(ctx, f, debt, rows),
        h('p', { class: 'muted', text: tr('debtedit.model_note') })),
      move_form(ctx, deps, ws, debt, key, f, rows),
      prepay_form(ctx, deps, ws, debt, key, f, rows),
      reanchor_form(ctx, deps, ws, debt, key, f, rows, drift_tol_bp(ws.params)),
    ]),
    h('div', { class: 'row' }, remove), h('p', { class: 'muted', text: tr('debtedit.rm_note') }), rm_err);
}

/**
 * Раздел «Долги в прогнозе» экрана «Долги»: записанные долги с графиком, историей и действиями (перенос, досрочно, сверка, убрать).
 * Сбой на одном долге (запись из файла не читается) не ломает остальные: вместо карточки — строка.
 * @param {object} ctx контекст расширений
 * @param {object} deps `make_deps()`
 * @param {{model: object}} a модель страницы
 * @returns {HTMLElement}
 */
export function render_saved(ctx, deps, a) {
  const tr = ctx.tr;
  const debts = list_of(a.model.ws, 'debts');
  const root = h('section', { class: 'card', id: 'fp14-saved', 'aria-labelledby': 'fp14-saved-title' },
    h('h3', { id: 'fp14-saved-title', tabindex: '-1', text: tr('debtedit.saved_title') }),
    h('p', { class: 'muted', text: tr('debtedit.saved_lead') }));
  if (debts.length === 0) root.append(h('p', { text: tr('debtedit.saved_none') }));
  debts.forEach((debt, i) => {
    let card;
    try { card = render_debt_card(ctx, deps, a.model, debt, i); } catch { card = h('p', { class: 'banner short', role: 'alert', text: tr('debtedit.card_failed', { id: String(debt?.debt_id ?? i) }) }); }
    root.append(card);
  });
  deps.focus.apply();
  return root;
}
