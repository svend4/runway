// ws_edit.mjs — чистые функции правки рабочей копии (FP-01, REQ-017, ADR-004).
// Все формы ввода (быстрый «+», сверка остатка, мастер, формы данных) пишут в рабочую область ТОЛЬКО через `apply_edit`:
//
//     apply_edit(ws, edit, env?) → { ok: true, ws', type, touched } | { ok: false, error: { code, ctx } }
//
// Свойства:
//   - исходная рабочая область не мутируется: результат — новый объект, неизменённые корзины разделяются со старым (копирование при записи);
//     правка принимается целиком или отвергается целиком;
//   - ошибки — коды канона `E_*` (design-brief §4, REQ-017): `E_NOT_INTEGER`, `E_OVERFLOW`, `E_BAD_DATE`, `E_FUTURE_POSTED`, `E_RULE_INVALID`,
//     `E_CURRENCY_MISMATCH`, `E_NO_RATE`, `E_SCHEMA`; контекст `ctx` — `{field, reason, value?}`, но никогда не содержит пользовательских
//     текстов (названий, заметок, получателей, меток): текстовые поля в `ctx` не попадают;
//   - ключи `__proto__`, `constructor`, `prototype` отвергаются на любой глубине правки (E_SCHEMA); неизвестные поля сущностей тоже;
//   - идентификаторы создаёт приложение (`env.new_id(prefix)` из `ids.mjs`), а не пользовательский текст; единое пространство `Id`
//     (design-brief §3.10 п. 7, C-025): `rule_id`, `stream_id`, `tax_rule_id`, `reserve_id` и другие сущности не совпадают;
//   - расширяемость: `register_edit(type, fn)` добавляет вид правки (пакеты фазы B), `register_validator(fn)` — общую проверку результата
//     (например, `validate_ws` движка после FP-02).
// Словарь правок: add_fact, void_fact, set_anchor, set_param, upsert_account, upsert_rule, delete_rule, upsert_stream, upsert_tax_rule,
// upsert_reserve, record_allocation, upsert_fx_rate, add_purchase, save_scenario, delete_scenario, set_wave_override, add_counterparty.
// Налоги — расчёт по введённым правилам пользователя, не консультация. Модуль чистый: ни DOM, ни часов, ни сети.

import {
  fail, RunwayError, assert_minor, parse_date, rate_at, currency_exponent, validate_rule, validate_stream, validate_tax_rule, analyze, canon,
} from '../engine/index.mjs';
import { validate_ws } from '../engine/validate_ws.mjs';
import { FORBIDDEN_KEYS, is_valid_id } from './ids.mjs';
import { AUTO_PREFIX } from './ws_bridge.mjs';

// ── ошибки и проверки полей ───────────────────────────────────────────────────────────────────────────────────────

const clip = (x) => String(x).slice(0, 40);
const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Отказ с кодом канона и контекстом `{field, reason, …}` (текстовые значения в контекст не кладём). */
function bad(code, field, reason, extra) {
  return fail(code, { field, reason, ...extra });
}
const schema = (field, reason, extra) => bad('E_SCHEMA', field, reason, extra);

function need_obj(x, field) {
  if (!is_obj(x)) schema(field, 'not_object');
  return x;
}

/** Только перечисленные поля: неизвестное поле — `E_SCHEMA` (имя поля кодовое, не пользовательское значение). */
function allow_keys(obj, allowed, field) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) schema(field, 'unknown_field', { key: clip(k) });
}

function id_of(x, field) {
  if (!is_valid_id(x) || x.startsWith(AUTO_PREFIX)) schema(field, 'bad_id');
  return x;
}

/** Текст: строка до `max` знаков без управляющих (кроме перевода строки и табуляции). Значение в контекст ошибки не попадает. */
function text_of(x, field, max = 200) {
  if (typeof x !== 'string') schema(field, 'not_string');
  if (x.length > max) schema(field, 'too_long', { max });
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(x)) schema(field, 'control_chars');
  return x.normalize('NFC');
}

function date_of(x, field) {
  if (typeof x !== 'string') bad('E_BAD_DATE', field, 'not_iso_string');
  try { parse_date(x); } catch { bad('E_BAD_DATE', field, 'bad_date', { value: clip(x) }); }
  return x;
}

/** Денежное число: целое safe-integer; нецелое — `E_NOT_INTEGER`, вне диапазона — `E_OVERFLOW`. */
function minor_of(x, field, { nonzero = false, min, max } = {}) {
  let v;
  try { v = assert_minor(x); } catch (e) { bad(e.code, field, 'not_money', { value: clip(x) }); }
  if (nonzero && v === 0) schema(field, 'zero');
  if (min !== undefined && v < min) schema(field, 'below_min', { value: v });
  if (max !== undefined && v > max) schema(field, 'above_max', { value: v });
  return v;
}

/** Не денежное целое (счётчики, дни, базисные пункты): иначе `E_SCHEMA`. */
function int_of(x, field, min, max) {
  if (!Number.isSafeInteger(x)) schema(field, 'not_int', { value: clip(x) });
  if (min !== undefined && x < min) schema(field, 'below_min', { value: x });
  if (max !== undefined && x > max) schema(field, 'above_max', { value: x });
  return x;
}

function enum_of(x, field, list) {
  if (!list.includes(x)) schema(field, 'not_in_list', { value: clip(x) });
  return x;
}

function currency_of(x, field) {
  if (typeof x !== 'string' || !/^[A-Z0-9]{3,10}$/.test(x)) schema(field, 'bad_currency', { value: clip(x) });
  try { currency_exponent(x); } catch { schema(field, 'unknown_currency', { value: clip(x) }); }
  return x;
}

function bool_of(x, field) {
  if (typeof x !== 'boolean') schema(field, 'not_boolean');
  return x;
}

/** Глубокий обход правки: ключи-«ловушки» прототипа, не-JSON значения, нецелые и непредставимые числа. */
function scan_edit(x, depth = 0, count = { n: 0, limit: 20000 }) {
  if (depth > 30) schema('edit', 'too_deep');
  if (++count.n > count.limit) schema('edit', 'too_large');
  if (typeof x === 'number') {
    if (!Number.isInteger(x)) bad('E_NOT_INTEGER', 'edit', 'not_integer', { value: clip(x) });
    if (!Number.isSafeInteger(x)) bad('E_OVERFLOW', 'edit', 'unsafe_integer', { value: clip(x) });
    return;
  }
  if (typeof x === 'bigint' || typeof x === 'function' || typeof x === 'symbol') schema('edit', 'unsupported_type');
  if (x === null || typeof x !== 'object') return;
  if (Array.isArray(x)) { for (const v of x) scan_edit(v, depth + 1, count); return; }
  const proto = Object.getPrototypeOf(x);
  if (proto !== Object.prototype && proto !== null) schema('edit', 'not_plain_object');
  for (const k of Object.getOwnPropertyNames(x)) {
    if (FORBIDDEN_KEYS.includes(k)) schema('edit', 'forbidden_key', { key: k });
    scan_edit(x[k], depth + 1, count);
  }
}

const clone = (x) => JSON.parse(JSON.stringify(x));

// ── чтение рабочей области ────────────────────────────────────────────────────────────────────────────────────────

const list = (ws, key) => (Array.isArray(ws[key]) ? ws[key] : []);
const find_by = (arr, field, id) => arr.find((x) => x?.[field] === id);
/** Заменить элемент с тем же идентификатором на месте или добавить в конец. */
function upsert(arr, field, item) {
  const i = arr.findIndex((x) => x?.[field] === item[field]);
  if (i < 0) return [...arr, item];
  const out = arr.slice();
  out[i] = item;
  return out;
}
const without = (arr, pred) => arr.filter((x) => !pred(x));
const set_bucket = (ws, key, arr) => ({ ...ws, [key]: arr });

/** Валюта решения: поле рабочей области, параметр или валюта первого operating-счёта (§2.0). */
export function decision_currency_of(ws) {
  if (typeof ws.decision_currency === 'string') return ws.decision_currency;
  const p = ws.params?.decision_currency;
  if (typeof p === 'string') return p;
  return list(ws, 'accounts').find((a) => a.liquidity === 'operating')?.currency ?? null;
}

/** Курс пары валюта → валюта решения на дату: нет курса — `E_NO_RATE`. */
function need_rate(ws, currency, date, field) {
  const dec = decision_currency_of(ws);
  if (dec === null || currency === dec) return;
  let r = null;
  try { r = rate_at(list(ws, 'rates'), currency, dec, date); } catch (e) { if (e instanceof RunwayError) r = null; else throw e; }
  if (r === null) bad('E_NO_RATE', field, 'no_rate', { currency, decision_currency: dec, date: clip(date) });
}

function account_of(ws, id, field) {
  const a = find_by(list(ws, 'accounts'), 'account_id', id);
  if (a === undefined) schema(field, 'unknown_account');
  return a;
}

// ── единое пространство Id ────────────────────────────────────────────────────────────────────────────────────────

/** Виды сущностей с общим пространством идентификаторов (design-brief §3.10 п. 7, C-025). */
export const ID_KINDS = Object.freeze({
  account: ['accounts', 'account_id'], calendar: ['calendars', 'calendar_id'], rule: ['rules', 'rule_id'], stream: ['streams', 'stream_id'],
  tax_rule: ['tax_rules', 'tax_rule_id'], reserve: ['reserves', 'reserve_id'], plan: ['plans', 'plan_id'], debt: ['debts', 'debt_id'],
  counterparty: ['counterparties', 'counterparty_id'], scenario: ['scenarios', 'scenario_id'], purchase: ['purchases', 'purchase_id'],
});

/** Идентификатор `id` вида `kind` не занят сущностью другого вида. */
function claim_id(ws, kind, id, field) {
  for (const [k, [bucket, f]] of Object.entries(ID_KINDS)) {
    if (k === kind) continue;
    const arr = bucket === 'tax_rules' ? list(ws, bucket).flat() : list(ws, bucket);
    if (arr.some((x) => x?.[f] === id)) schema(field, 'id_taken_by_other_kind', { kind: k });
  }
}

// ── реестр правок ─────────────────────────────────────────────────────────────────────────────────────────────────

/** @type {Map<string, (ws: object, edit: object, env: object) => object>} */
const EDITS = new Map();
/** @type {Array<(ws: object, edit: object, env: object) => void>} */
const VALIDATORS = [];

/**
 * Добавить вид правки. `fn(ws, edit, env)` возвращает новую рабочую область (или `{ws, touched}`) и бросает `RunwayError` на отказ.
 * Имя — `[a-z][a-z0-9_]{1,40}`; повтор имени — ошибка (правки пакетов не перекрывают друг друга).
 * @param {string} type
 * @param {(ws: object, edit: object, env: {as_of: string, new_id?: (prefix: string) => string}) => object} fn
 */
export function register_edit(type, fn) {
  if (typeof type !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/.test(type)) throw new TypeError('register_edit: имя вида правки — [a-z][a-z0-9_]{1,40}');
  if (typeof fn !== 'function') throw new TypeError('register_edit: нужна функция');
  if (EDITS.has(type)) throw new Error('register_edit: вид правки уже зарегистрирован: ' + type);
  EDITS.set(type, fn);
}

/** Добавить общую проверку результата правки (бросает `RunwayError`, если результат недопустим). Например, `validate_ws` движка. */
export function register_validator(fn) {
  if (typeof fn !== 'function') throw new TypeError('register_validator: нужна функция');
  VALIDATORS.push(fn);
}

/** Зарегистрированные виды правок (по алфавиту). */
export function list_edit_types() {
  return [...EDITS.keys()].sort();
}

// ── применение правки ─────────────────────────────────────────────────────────────────────────────────────────────

function to_error(e) {
  if (e instanceof RunwayError) return { code: e.code, ctx: e.ctx ?? null };
  return { code: 'E_SCHEMA', ctx: { field: 'edit', reason: 'internal', detail: String(e?.name ?? 'Error').slice(0, 40) } };
}

/**
 * Применить правку к копии рабочей области.
 * @param {object} ws рабочая область (не мутируется; может быть заморожена)
 * @param {{type: string}} edit правка: объект с полем `type` и полями вида (см. словарь в заголовке)
 * @param {{as_of?: string, new_id?: (prefix: string) => string, deep?: boolean}} [env]
 *   `as_of` — дата «сегодня» (по умолчанию `ws.as_of`); `new_id` — создатель идентификаторов; `deep` — после правки пересчитать
 *   `analyze` и вернуть его отказ (E_NO_RATE и т. п.), если расчёт не проходит
 * @returns {{ok: true, ws: object, type: string, touched: string[]} | {ok: false, error: {code: string, ctx: object|null}}}
 */
export function apply_edit(ws, edit, env = {}) {
  try {
    if (!is_obj(ws)) schema('workspace', 'not_object');
    if (!is_obj(edit)) schema('edit', 'not_object');
    scan_edit(edit);
    if (typeof edit.type !== 'string' || !EDITS.has(edit.type)) schema('type', 'unknown_edit_type', { type: clip(edit.type) });
    const as_of = env.as_of ?? ws.as_of;
    const e = { ...env, as_of: date_of(as_of, 'as_of') };
    const raw = EDITS.get(edit.type)(ws, edit, e);
    const next = raw !== null && typeof raw === 'object' && raw.ws !== undefined ? raw.ws : raw;
    if (!is_obj(next)) schema('edit', 'edit_returned_no_workspace');
    for (const v of VALIDATORS) v(next, edit, e);
    if (env.deep === true) analyze(next, { as_of });
    const touched = Object.keys(next).filter((k) => next[k] !== ws[k]);
    return { ok: true, ws: next, type: edit.type, touched };
  } catch (err) {
    return { ok: false, error: to_error(err) };
  }
}

// ── add_fact / void_fact ──────────────────────────────────────────────────────────────────────────────────────────

/** Поля факта, которые принимает `add_fact` (FP-28: «Исправить факт» копирует прежнюю запись только по этому списку). */
export const FACT_KEYS = ['event_id', 'account_id', 'date', 'amount_minor', 'currency', 'kind', 'tag', 'note', 'counterparty_id', 'transfer_id', 'fx',
  'rule_id', 'stream_id', 'occ_key', 'plan_ref', 'no_plan', 'dedup_key', 'is_exceptional', 'reserve_id', 'batch_id'];
const FACT_KINDS = ['income', 'expense', 'transfer'];

function norm_fact(ws, f, env, field, kind_override) {
  need_obj(f, field);
  allow_keys(f, FACT_KEYS, field);
  const out = {};
  const id = f.event_id ?? env.new_id?.('tx');
  if (id === undefined) schema(field + '.event_id', 'id_required');
  out.event_id = id_of(id, field + '.event_id');
  const acc = account_of(ws, id_of(f.account_id, field + '.account_id'), field + '.account_id');
  out.account_id = acc.account_id;
  out.date = date_of(f.date, field + '.date');
  if (out.date > env.as_of) bad('E_FUTURE_POSTED', field + '.date', 'posted_after_as_of', { value: out.date, as_of: env.as_of });
  out.amount_minor = minor_of(f.amount_minor, field + '.amount_minor', { nonzero: true });
  out.currency = f.currency === undefined ? acc.currency : currency_of(f.currency, field + '.currency');
  if (out.currency !== acc.currency) bad('E_CURRENCY_MISMATCH', field + '.currency', 'differs_from_account', { currency: out.currency, account_currency: acc.currency });
  const kind = kind_override ?? f.kind ?? (out.amount_minor > 0 ? 'income' : 'expense');
  out.kind = enum_of(kind, field + '.kind', FACT_KINDS);
  if ((out.kind === 'income' && out.amount_minor < 0) || (out.kind === 'expense' && out.amount_minor > 0)) schema(field + '.amount_minor', 'sign_mismatch_kind');
  if (f.tag !== undefined) out.tag = text_of(f.tag, field + '.tag', 100);
  if (f.note !== undefined) out.note = text_of(f.note, field + '.note', 1000);
  if (f.counterparty_id !== undefined) {
    out.counterparty_id = id_of(f.counterparty_id, field + '.counterparty_id');
    if (find_by(list(ws, 'counterparties'), 'counterparty_id', out.counterparty_id) === undefined) schema(field + '.counterparty_id', 'unknown_counterparty');
  }
  for (const k of ['rule_id', 'stream_id', 'reserve_id']) if (f[k] !== undefined) out[k] = id_of(f[k], field + '.' + k);
  for (const k of ['occ_key', 'plan_ref', 'dedup_key', 'batch_id']) if (f[k] !== undefined) out[k] = text_of(f[k], field + '.' + k, 200);
  if (f.no_plan !== undefined) out.no_plan = bool_of(f.no_plan, field + '.no_plan');
  if (f.is_exceptional !== undefined) out.is_exceptional = bool_of(f.is_exceptional, field + '.is_exceptional');
  if (f.fx !== undefined) {
    const fx = need_obj(f.fx, field + '.fx');
    allow_keys(fx, ['num', 'den'], field + '.fx');
    out.fx = { num: int_of(fx.num, field + '.fx.num', 1), den: int_of(fx.den, field + '.fx.den', 1) };
  }
  if (f.transfer_id !== undefined) out.transfer_id = id_of(f.transfer_id, field + '.transfer_id');
  if (acc.liquidity === 'operating') need_rate(ws, out.currency, out.date, field + '.currency');
  return out;
}

/** Ноги перевода: две ноги с общим `transfer_id`; одна валюта — сумма 0 (инвариант 1, §3.10); разные валюты — нужен курс. */
function check_transfer_legs(ws, legs, field) {
  if (legs.length !== 2) schema(field, 'transfer_needs_two_legs', { count: legs.length });
  const [a, b] = legs;
  if (a.account_id === b.account_id) schema(field, 'transfer_same_account');
  if (a.currency === b.currency) {
    const sum = a.amount_minor + b.amount_minor;
    if (!Number.isSafeInteger(sum)) bad('E_OVERFLOW', field, 'transfer_sum_overflow');
    if (sum !== 0) schema(field, 'transfer_legs_nonzero_sum', { transfer_id: a.transfer_id, currency: a.currency, sum });
  } else {
    if (Math.sign(a.amount_minor) === Math.sign(b.amount_minor)) schema(field, 'transfer_legs_same_sign');
    const have_fx = a.fx !== undefined || b.fx !== undefined;
    let r = null;
    try { r = rate_at(list(ws, 'rates'), a.currency, b.currency, a.date); } catch { r = null; }
    if (!have_fx && r === null) bad('E_NO_RATE', field, 'transfer_cross_currency_needs_rate', { from: a.currency, to: b.currency });
  }
}

register_edit('add_fact', (ws, edit, env) => {
  allow_keys(edit, ['type', 'fact', 'legs', 'transfer_id'], 'edit');
  const facts = list(ws, 'facts');
  let add;
  if (edit.legs !== undefined) {
    if (edit.fact !== undefined) schema('edit', 'fact_and_legs');
    if (!Array.isArray(edit.legs)) schema('legs', 'not_array');
    const given = edit.transfer_id ?? edit.legs[0]?.transfer_id;
    add = edit.legs.map((l, i) => norm_fact(ws, { ...need_obj(l, `legs[${i}]`), transfer_id: given }, env, `legs[${i}]`, 'transfer'));
    check_transfer_legs(ws, add, 'legs');
    const tid = given ?? env.new_id?.('trf'); // идентификатор перевода — последним: сначала сообщаем об ошибках введённых значений
    if (tid === undefined) schema('transfer_id', 'id_required');
    id_of(tid, 'transfer_id');
    if (facts.some((x) => x.transfer_id === tid)) schema('transfer_id', 'duplicate_transfer_id');
    for (const f of add) f.transfer_id = tid;
  } else {
    add = [norm_fact(ws, edit.fact, env, 'fact')];
    if (add[0].kind === 'transfer' || add[0].transfer_id !== undefined) schema('fact.kind', 'transfer_needs_legs');
  }
  const ids = new Set(facts.map((x) => x.event_id));
  for (const f of add) {
    if (ids.has(f.event_id)) schema('fact.event_id', 'duplicate_id');
    ids.add(f.event_id);
  }
  return set_bucket(ws, 'facts', [...facts, ...add]);
});

register_edit('void_fact', (ws, edit) => {
  allow_keys(edit, ['type', 'event_id'], 'edit');
  const id = id_of(edit.event_id, 'event_id');
  const facts = list(ws, 'facts');
  const hit = find_by(facts, 'event_id', id);
  if (hit === undefined) schema('event_id', 'unknown_fact');
  const tid = hit.transfer_id;
  return set_bucket(ws, 'facts', without(facts, (x) => x.event_id === id || (tid !== undefined && x.transfer_id === tid)));
});

// ── якорь и параметры ─────────────────────────────────────────────────────────────────────────────────────────────

register_edit('set_anchor', (ws, edit, env) => {
  allow_keys(edit, ['type', 'anchor'], 'edit');
  const a = need_obj(edit.anchor, 'anchor');
  allow_keys(a, ['anchor_id', 'account_id', 'date', 'amount_minor'], 'anchor');
  const acc = account_of(ws, id_of(a.account_id, 'anchor.account_id'), 'anchor.account_id');
  const date = date_of(a.date, 'anchor.date');
  if (date > env.as_of) bad('E_FUTURE_POSTED', 'anchor.date', 'anchor_after_as_of', { value: date, as_of: env.as_of });
  const amount_minor = minor_of(a.amount_minor, 'anchor.amount_minor');
  if (acc.liquidity === 'operating') need_rate(ws, acc.currency, date, 'anchor.account_id');
  const id = a.anchor_id ?? env.new_id?.('anc'); // идентификатор — последним: сначала сообщаем об ошибках введённых значений
  if (id === undefined) schema('anchor.anchor_id', 'id_required');
  const item = { anchor_id: id_of(id, 'anchor.anchor_id'), account_id: acc.account_id, date, amount_minor };
  return set_bucket(ws, 'anchors', upsert(list(ws, 'anchors'), 'anchor_id', item));
});

const ROUND = ['half_even', 'half_up', 'floor', 'ceil'];
const pint = (min, max) => ({ kind: 'int', min, max });
const pminor = { kind: 'minor', min: 0, nullable: true };
/** Редактируемые параметры (ключи — как в `vocab.json → params`; `kdf.*` не редактируются). Границы — для ввода, не для канона. */
export const PARAM_SPECS = Object.freeze({
  decision_currency: { kind: 'currency', nullable: true },
  horizon_days: pint(1, 3650), buffer_minor: pminor, buffer_hint_days: pint(0, 365), headline_mode: { kind: 'enum', values: ['plan', 'worse'] },
  'worse.income_delay_days': pint(0, 365), 'grace_days.income': pint(0, 60), 'grace_days.expense': pint(0, 60),
  'match.window_days': pint(0, 60), 'match.tol_bp': pint(0, 10000), 'wave.gap_days': pint(0, 60), 'wave.max_span_days': pint(1, 60),
  // θ ≥ 1 (канон; п. 5 запроса FP-03): порог волны нельзя задать нулём, «не задан» — null
  'wave.threshold_minor': { kind: 'minor', min: 1, nullable: true }, 'explain.top_k': pint(1, 100), 'explain.share_cutoff_bp': pint(0, 10000),
  'stale.banner_days': pint(1, 3650), 'stale.block_days': pint(1, 3650), rounding: { kind: 'enum', values: ROUND },
  'ready.q1': pint(0, 4), 'ready.q3': pint(0, 4), 'crypto.liquidity_bp': pint(0, 10000),
  'backup.remind_events': pint(1, 1000000), 'backup.remind_days': pint(1, 3650), 'fx.stale_days': pint(0, 3650),
  'backtest.h_days': pint(1, 3650), 'backtest.min_window_days': pint(1, 3650), 'debt.drift_tol_bp': pint(0, 10000),
  'calib.window': pint(1, 1000), 'calib.prior': pint(0, 1000), 'calib.k': pint(1, 1000), 'calib.alpha_bp': pint(0, 10000), 'calib.min_origins': pint(1, 1000),
  'mc.n_paths': pint(1, 100000), 'tools.max_calls': pint(1, 1000),
});
/** Параметры из `vocab.json`, которые правкой не меняются (определяет отдельное решение). */
export const PARAMS_NOT_EDITABLE = Object.freeze(['kdf.iterations', 'kdf.wrap']);

register_edit('set_param', (ws, edit) => {
  allow_keys(edit, ['type', 'key', 'value', 'reset'], 'edit');
  if (typeof edit.key !== 'string' || !Object.hasOwn(PARAM_SPECS, edit.key)) schema('key', 'unknown_param', { key: clip(edit.key) });
  const sp = PARAM_SPECS[edit.key];
  if (edit.reset !== undefined) {
    // «вернуть по умолчанию» (FP-17, REQ-019): значения по умолчанию — данные словаря, поэтому запись не копирует число, а снимает собственное значение рабочей области:
    // ключ пропадает из params (действует умолчание словаря), а у параметров, где «не задан» — отдельное значение (`nullable`), ключ получает явный null,
    // как и при чтении журнала (`ws_bridge`: null допустимого параметра остаётся ключом; иначе inputs_hash после перезагрузки отличался бы от сеансового).
    if (edit.reset !== true) schema('reset', 'reset_must_be_true');
    if (edit.value !== undefined) schema('value', 'reset_with_value');
    if (sp.kind === 'currency') schema('key', 'not_resettable', { key: clip(edit.key) }); // валюта решения задаётся при создании рабочей области
    const params = is_obj(ws.params) ? ws.params : {};
    if (!Object.hasOwn(params, edit.key)) return ws;
    if (sp.nullable === true) return { ...ws, params: { ...params, [edit.key]: null } };
    const { [edit.key]: _gone, ...rest } = params;
    return { ...ws, params: rest };
  }
  const v = edit.value;
  let value;
  if (v === null) {
    if (sp.nullable !== true) schema('value', 'null_not_allowed');
    value = null; // «не задан»: параметр остаётся ключом со значением null
  } else if (sp.kind === 'int') value = int_of(v, 'value', sp.min, sp.max);
  else if (sp.kind === 'minor') value = minor_of(v, 'value', { min: sp.min });
  else if (sp.kind === 'enum') value = enum_of(v, 'value', sp.values);
  else value = currency_of(v, 'value');
  return { ...ws, params: { ...(is_obj(ws.params) ? ws.params : {}), [edit.key]: value } };
});

// ── счета ─────────────────────────────────────────────────────────────────────────────────────────────────────────

register_edit('upsert_account', (ws, edit) => {
  allow_keys(edit, ['type', 'account'], 'edit');
  const a = need_obj(edit.account, 'account');
  allow_keys(a, ['account_id', 'name', 'kind', 'liquidity', 'currency', 'exponent', 'liquidity_bp', 'opened_on', 'closed_on'], 'account');
  const id = id_of(a.account_id, 'account.account_id');
  claim_id(ws, 'account', id, 'account.account_id');
  const item = { account_id: id, name: text_of(a.name, 'account.name', 120) };
  item.kind = enum_of(a.kind, 'account.kind', ['cash', 'bank', 'savings', 'asset', 'debt', 'crypto']);
  item.liquidity = enum_of(a.liquidity, 'account.liquidity', ['operating', 'savings', 'asset', 'debt']);
  item.currency = currency_of(a.currency, 'account.currency');
  item.exponent = a.exponent === undefined ? currency_exponent(item.currency) : int_of(a.exponent, 'account.exponent', 0, 18);
  item.liquidity_bp = a.liquidity_bp === undefined ? 0 : int_of(a.liquidity_bp, 'account.liquidity_bp', 0, 10000);
  if (a.opened_on !== undefined) item.opened_on = date_of(a.opened_on, 'account.opened_on');
  if (a.closed_on !== undefined && a.closed_on !== null) {
    item.closed_on = date_of(a.closed_on, 'account.closed_on');
    if (item.opened_on !== undefined && item.closed_on < item.opened_on) bad('E_BAD_DATE', 'account.closed_on', 'before_opened');
  }
  const old = find_by(list(ws, 'accounts'), 'account_id', id);
  if (old !== undefined && old.currency !== item.currency) {
    const used = [...list(ws, 'facts'), ...list(ws, 'anchors'), ...list(ws, 'rules'), ...list(ws, 'streams')].some((x) => x.account_id === id);
    if (used) bad('E_CURRENCY_MISMATCH', 'account.currency', 'account_has_records_in_other_currency', { currency: item.currency, account_currency: old.currency });
  }
  return set_bucket(ws, 'accounts', upsert(list(ws, 'accounts'), 'account_id', item));
});

// ── правила ───────────────────────────────────────────────────────────────────────────────────────────────────────

const RULE_KEYS = ['rule_id', 'version', 'account_id', 'name', 'kind', 'amount', 'currency', 'freq', 'interval', 'by_weekday', 'by_monthday', 'by_workday',
  'start_date', 'until_date', 'count', 'month_end', 'weekend', 'calendar_id', 'exdates', 'is_obligation', 'is_estimate', 'tag', 'counterparty_id',
  'delay_days_worse', 'reserve_id', 'reviewed_at', 'ttl_days'];

/** Первый отказ валидатора движка (`{ok, errors}`) → исключение с тем же кодом и контекстом поля. */
function throw_first(res, field) {
  if (res.ok) return;
  const e = res.errors[0];
  bad(e.code, field + '.' + e.field, e.reason);
}

register_edit('upsert_rule', (ws, edit) => {
  allow_keys(edit, ['type', 'rule'], 'edit');
  const r = need_obj(edit.rule, 'rule');
  allow_keys(r, RULE_KEYS, 'rule');
  const id = id_of(r.rule_id, 'rule.rule_id');
  claim_id(ws, 'rule', id, 'rule.rule_id');
  const rules = list(ws, 'rules');
  const old = find_by(rules, 'rule_id', id);
  const acc = account_of(ws, id_of(r.account_id, 'rule.account_id'), 'rule.account_id');
  const item = clone(r);
  item.name = text_of(r.name, 'rule.name', 120);
  if (r.tag !== undefined) item.tag = text_of(r.tag, 'rule.tag', 100);
  for (const k of ['is_obligation', 'is_estimate']) if (r[k] !== undefined) bool_of(r[k], 'rule.' + k);
  // версия: новое правило — 1 (или заданная); правка существующего с изменённым содержимым повышает версию (если не задана большая)
  const given = r.version === undefined ? undefined : int_of(r.version, 'rule.version', 1);
  if (old === undefined) item.version = given ?? 1;
  else {
    const strip = (x) => { const { version: _v, ...rest } = x; return canon(rest); };
    const changed = strip(old) !== strip({ ...item, name: item.name });
    item.version = given !== undefined && given > (old.version ?? 0) ? given : (changed ? (old.version ?? 0) + 1 : (old.version ?? 1));
  }
  item.currency = r.currency === undefined ? acc.currency : currency_of(r.currency, 'rule.currency');
  if (item.currency !== acc.currency) bad('E_CURRENCY_MISMATCH', 'rule.currency', 'differs_from_account', { currency: item.currency, account_currency: acc.currency });
  if (item.calendar_id !== undefined && item.calendar_id !== null && find_by(list(ws, 'calendars'), 'calendar_id', item.calendar_id) === undefined) schema('rule.calendar_id', 'unknown_calendar');
  if (item.counterparty_id !== undefined && find_by(list(ws, 'counterparties'), 'counterparty_id', item.counterparty_id) === undefined) schema('rule.counterparty_id', 'unknown_counterparty');
  const a = item.amount;
  if (!is_obj(a)) bad('E_RULE_INVALID', 'rule.amount', 'required');
  allow_keys(a, ['exp_minor', 'min_minor', 'max_minor'], 'rule.amount');
  for (const k of ['exp_minor', 'min_minor', 'max_minor']) if (a[k] !== undefined && a[k] !== null) minor_of(a[k], 'rule.amount.' + k);
  throw_first(validate_rule(item), 'rule');
  need_rate(ws, item.currency, item.start_date, 'rule.currency');
  return set_bucket(ws, 'rules', upsert(rules, 'rule_id', item));
});

register_edit('delete_rule', (ws, edit) => {
  allow_keys(edit, ['type', 'rule_id'], 'edit');
  const id = id_of(edit.rule_id, 'rule_id');
  const rules = list(ws, 'rules');
  if (find_by(rules, 'rule_id', id) === undefined) schema('rule_id', 'unknown_rule');
  return { ...ws, rules: without(rules, (x) => x.rule_id === id), overrides: without(list(ws, 'overrides'), (x) => x.rule_id === id) };
});

// ── поток часов ───────────────────────────────────────────────────────────────────────────────────────────────────

const STREAM_KEYS = ['stream_id', 'account_id', 'name', 'counterparty_id', 'currency', 'rate_minor', 'period', 'cutoff', 'pay_lag_days', 'weekend',
  'calendar_id', 'hours', 'hours_by_period', 'pace_minutes_per_day', 'overtime', 'bonus', 'delay_days_worse'];

register_edit('upsert_stream', (ws, edit) => {
  allow_keys(edit, ['type', 'stream'], 'edit');
  const s = need_obj(edit.stream, 'stream');
  allow_keys(s, STREAM_KEYS, 'stream');
  const id = id_of(s.stream_id, 'stream.stream_id');
  claim_id(ws, 'stream', id, 'stream.stream_id');
  const acc = account_of(ws, id_of(s.account_id, 'stream.account_id'), 'stream.account_id');
  const item = clone(s);
  item.name = text_of(s.name, 'stream.name', 120);
  item.currency = s.currency === undefined ? acc.currency : currency_of(s.currency, 'stream.currency');
  if (item.currency !== acc.currency) bad('E_CURRENCY_MISMATCH', 'stream.currency', 'differs_from_account', { currency: item.currency, account_currency: acc.currency });
  minor_of(s.rate_minor, 'stream.rate_minor', { min: 0 });
  for (const [i, b] of (item.bonus ?? []).entries()) { date_of(b?.date, `stream.bonus[${i}].date`); minor_of(b?.amount_minor, `stream.bonus[${i}].amount_minor`, { min: 1 }); }
  if (item.calendar_id !== undefined && item.calendar_id !== null && find_by(list(ws, 'calendars'), 'calendar_id', item.calendar_id) === undefined) schema('stream.calendar_id', 'unknown_calendar');
  throw_first(validate_stream(item), 'stream');
  need_rate(ws, item.currency, env_date(ws), 'stream.currency');
  return set_bucket(ws, 'streams', upsert(list(ws, 'streams'), 'stream_id', item));
});

/** Дата для проверки курса потока: `as_of` рабочей области (поток раскрывается вперёд от неё). */
function env_date(ws) {
  return typeof ws.as_of === 'string' ? ws.as_of : '1970-01-01';
}

// ── налоговое правило (расчёт по введённым правилам, не консультация) ─────────────────────────────────────────────────

const TAX_KEYS = ['tax_rule_id', 'version', 'name', 'kind', 'rate_bp', 'base', 'applies_to', 'valid_from', 'valid_to', 'rounding', 'reserve_id',
  'reviewed_at', 'ttl_days', 'source_note', 'recorded_at'];

/**
 * Сумма ставок правил на одно поступление не больше 10000 bp (C-032): для каждого потока и метки берётся действующая версия каждого
 * правила на каждую дату начала действия и складываются ставки. Нарушение — `E_RULE_INVALID`.
 * @param {object[]} versions все версии всех налоговых правил
 */
export function check_tax_rate_sums(versions) {
  const targets = new Map(); // «s:<stream>» / «t:<tag>» → версии, которые на него действуют
  for (const v of versions) {
    for (const s of v.applies_to?.stream_ids ?? []) (targets.get('s:' + s) ?? targets.set('s:' + s, []).get('s:' + s)).push(v);
    for (const t of v.applies_to?.tags ?? []) (targets.get('t:' + t) ?? targets.set('t:' + t, []).get('t:' + t)).push(v);
  }
  for (const vs of targets.values()) {
    for (const d of new Set(vs.map((v) => v.valid_from))) {
      const active = new Map();
      for (const v of vs) {
        if (v.valid_from > d || (v.valid_to !== null && v.valid_to !== undefined && v.valid_to <= d)) continue;
        const cur = active.get(v.tax_rule_id);
        if (cur === undefined || v.version > cur.version) active.set(v.tax_rule_id, v);
      }
      let sum = 0;
      for (const v of active.values()) sum += v.rate_bp;
      if (sum > 10000) bad('E_RULE_INVALID', 'tax_rule.rate_bp', 'rate_sum_gt_10000', { value: sum, date: d });
    }
  }
}

register_edit('upsert_tax_rule', (ws, edit) => {
  allow_keys(edit, ['type', 'tax_rule'], 'edit');
  const t = need_obj(edit.tax_rule, 'tax_rule');
  allow_keys(t, TAX_KEYS, 'tax_rule');
  const id = id_of(t.tax_rule_id, 'tax_rule.tax_rule_id');
  claim_id(ws, 'tax_rule', id, 'tax_rule.tax_rule_id');
  const all = list(ws, 'tax_rules').flat();
  const mine = all.filter((x) => x.tax_rule_id === id);
  const item = clone(t);
  item.name = text_of(t.name, 'tax_rule.name', 120);
  if (t.source_note !== undefined) item.source_note = text_of(t.source_note, 'tax_rule.source_note', 1000);
  if (t.recorded_at !== undefined) item.recorded_at = text_of(t.recorded_at, 'tax_rule.recorded_at', 40);
  const top = mine.reduce((m, x) => Math.max(m, x.version ?? 0), 0);
  item.version = t.version === undefined ? top + 1 : int_of(t.version, 'tax_rule.version', 1);
  if (mine.some((x) => x.version === item.version)) schema('tax_rule.version', 'duplicate_version'); // версии добавляются, прошлые не правятся
  item.kind = t.kind ?? 'percent_of_income';
  item.base = t.base ?? 'gross';
  item.rounding = t.rounding ?? (ws.params?.rounding ?? 'half_even');
  if (item.valid_to === undefined) item.valid_to = null;
  if (item.valid_from === undefined) bad('E_RULE_INVALID', 'tax_rule.valid_from', 'bad_date');
  if (typeof item.rate_bp === 'number') int_of(item.rate_bp, 'tax_rule.rate_bp');
  throw_first(validate_tax_rule(item), 'tax_rule');
  if (find_by(list(ws, 'reserves'), 'reserve_id', item.reserve_id) === undefined) schema('tax_rule.reserve_id', 'unknown_reserve');
  for (const sid of item.applies_to.stream_ids ?? []) if (find_by(list(ws, 'streams'), 'stream_id', sid) === undefined) schema('tax_rule.applies_to', 'unknown_stream');
  check_tax_rate_sums([...all, item]);
  return set_bucket(ws, 'tax_rules', [...all, item]);
});

// ── резервы и аллокации ───────────────────────────────────────────────────────────────────────────────────────────

const RESERVE_KEYS = ['reserve_id', 'kind', 'name', 'currency', 'funded_start_minor', 'funded_as_of', 'target_minor', 'due_date', 'cadence', 'mode',
  'fixed_minor', 'tax_rule_id', 'backed_by_account_id'];

register_edit('upsert_reserve', (ws, edit) => {
  allow_keys(edit, ['type', 'reserve'], 'edit');
  const r = need_obj(edit.reserve, 'reserve');
  allow_keys(r, RESERVE_KEYS, 'reserve');
  const id = id_of(r.reserve_id, 'reserve.reserve_id');
  claim_id(ws, 'reserve', id, 'reserve.reserve_id');
  const item = { reserve_id: id };
  item.kind = enum_of(r.kind, 'reserve.kind', ['tax', 'sinking']);
  item.name = text_of(r.name, 'reserve.name', 120);
  item.currency = currency_of(r.currency, 'reserve.currency');
  item.funded_start_minor = minor_of(r.funded_start_minor ?? 0, 'reserve.funded_start_minor', { min: 0 });
  item.funded_as_of = date_of(r.funded_as_of, 'reserve.funded_as_of');
  if (r.backed_by_account_id !== undefined && r.backed_by_account_id !== null) {
    account_of(ws, id_of(r.backed_by_account_id, 'reserve.backed_by_account_id'), 'reserve.backed_by_account_id');
    item.backed_by_account_id = r.backed_by_account_id;
  } else item.backed_by_account_id = null;
  if (r.tax_rule_id !== undefined && r.tax_rule_id !== null) item.tax_rule_id = id_of(r.tax_rule_id, 'reserve.tax_rule_id');
  if (item.kind === 'sinking') {
    item.mode = enum_of(r.mode, 'reserve.mode', ['refill_to_target', 'fixed']);
    if (r.target_minor !== undefined) item.target_minor = minor_of(r.target_minor, 'reserve.target_minor', { min: 1 });
    if (r.due_date !== undefined) item.due_date = date_of(r.due_date, 'reserve.due_date');
    if (item.mode === 'refill_to_target' && (item.target_minor === undefined || item.due_date === undefined)) schema('reserve.mode', 'refill_needs_target_and_due_date');
    if (item.mode === 'fixed') {
      if (r.fixed_minor === undefined) schema('reserve.fixed_minor', 'required_for_fixed');
      item.fixed_minor = minor_of(r.fixed_minor, 'reserve.fixed_minor', { min: 1 });
    }
    if (r.cadence !== undefined) {
      const c = need_obj(r.cadence, 'reserve.cadence');
      allow_keys(c, ['freq', 'day'], 'reserve.cadence');
      item.cadence = { freq: enum_of(c.freq, 'reserve.cadence.freq', ['M']), day: int_of(c.day, 'reserve.cadence.day', 1, 31) };
    }
  }
  return set_bucket(ws, 'reserves', upsert(list(ws, 'reserves'), 'reserve_id', item));
});

register_edit('record_allocation', (ws, edit, env) => {
  allow_keys(edit, ['type', 'allocation'], 'edit');
  const a = need_obj(edit.allocation, 'allocation');
  allow_keys(a, ['allocation_id', 'reserve_id', 'date', 'amount_minor', 'source', 'source_event_id', 'rule_version'], 'allocation');
  const id = a.allocation_id ?? env.new_id?.('alc');
  if (id === undefined) schema('allocation.allocation_id', 'id_required');
  const item = { allocation_id: id_of(id, 'allocation.allocation_id') };
  const rs = find_by(list(ws, 'reserves'), 'reserve_id', id_of(a.reserve_id, 'allocation.reserve_id'));
  if (rs === undefined) schema('allocation.reserve_id', 'unknown_reserve');
  item.reserve_id = rs.reserve_id;
  item.date = date_of(a.date, 'allocation.date');
  if (item.date > env.as_of) bad('E_FUTURE_POSTED', 'allocation.date', 'allocation_after_as_of', { value: item.date, as_of: env.as_of });
  item.amount_minor = minor_of(a.amount_minor, 'allocation.amount_minor', { nonzero: true });
  item.source = enum_of(a.source, 'allocation.source', ['income', 'schedule', 'manual', 'release']);
  if (a.source_event_id !== undefined) item.source_event_id = text_of(a.source_event_id, 'allocation.source_event_id', 200);
  if (a.rule_version !== undefined) item.rule_version = int_of(a.rule_version, 'allocation.rule_version', 1);
  if (item.source === 'income' && item.rule_version === undefined) schema('allocation.rule_version', 'required_for_income'); // инвариант 6: аллокация хранит rule_version
  return set_bucket(ws, 'allocations', upsert(list(ws, 'allocations'), 'allocation_id', item)); // запись идемпотентна по идентификатору
});

// ── курс, покупка, сценарий, правка волн, контрагент ──────────────────────────────────────────────────────────────

register_edit('upsert_fx_rate', (ws, edit, env) => {
  allow_keys(edit, ['type', 'rate'], 'edit');
  const r = need_obj(edit.rate, 'rate');
  allow_keys(r, ['fx_id', 'date', 'base', 'quote', 'num', 'den', 'source'], 'rate');
  const item = {};
  item.date = date_of(r.date, 'rate.date');
  item.base = currency_of(r.base, 'rate.base');
  item.quote = currency_of(r.quote, 'rate.quote');
  if (item.base === item.quote) bad('E_CURRENCY_MISMATCH', 'rate.quote', 'same_currency', { currency: item.base });
  item.num = int_of(r.num, 'rate.num', 1);
  item.den = int_of(r.den, 'rate.den', 1);
  item.source = r.source === undefined ? 'manual' : enum_of(r.source, 'rate.source', ['manual', 'pack']);
  item.fx_id = id_of(r.fx_id ?? env.new_id?.('fx') ?? `fx-${item.base}${item.quote}-${item.date}`, 'rate.fx_id');
  const out = { fx_id: item.fx_id, date: item.date, base: item.base, quote: item.quote, num: item.num, den: item.den, source: item.source };
  return set_bucket(ws, 'rates', upsert(list(ws, 'rates'), 'fx_id', out));
});

register_edit('add_purchase', (ws, edit, env) => {
  allow_keys(edit, ['type', 'purchase'], 'edit');
  const p = need_obj(edit.purchase, 'purchase');
  allow_keys(p, ['purchase_id', 'scenario_id', 'name', 'currency', 'parts'], 'purchase');
  const id = id_of(p.purchase_id ?? env.new_id?.('pur'), 'purchase.purchase_id');
  claim_id(ws, 'purchase', id, 'purchase.purchase_id');
  const item = { purchase_id: id, name: text_of(p.name, 'purchase.name', 120) };
  item.currency = currency_of(p.currency ?? decision_currency_of(ws), 'purchase.currency');
  if (p.scenario_id !== undefined) {
    item.scenario_id = id_of(p.scenario_id, 'purchase.scenario_id');
    if (find_by(list(ws, 'scenarios'), 'scenario_id', item.scenario_id) === undefined) schema('purchase.scenario_id', 'unknown_scenario');
  }
  if (!Array.isArray(p.parts) || p.parts.length < 1 || p.parts.length > 120) schema('purchase.parts', 'one_to_120_parts');
  item.parts = p.parts.map((x, i) => {
    need_obj(x, `purchase.parts[${i}]`);
    allow_keys(x, ['date', 'amount_minor'], `purchase.parts[${i}]`);
    return { date: date_of(x.date, `purchase.parts[${i}].date`), amount_minor: minor_of(x.amount_minor, `purchase.parts[${i}].amount_minor`, { min: 1 }) };
  });
  need_rate(ws, item.currency, item.parts[0].date, 'purchase.currency');
  return set_bucket(ws, 'purchases', upsert(list(ws, 'purchases'), 'purchase_id', item));
});

const SCENARIO_OPS = ['delay_income', 'shift_flow', 'set_amount', 'remove_flow', 'add_purchase', 'add_flow', 'fx_shock'];

function check_op(op, i) {
  const f = `scenario.ops[${i}]`;
  need_obj(op, f);
  enum_of(op.op, f + '.op', SCENARIO_OPS);
  const ref = op.event_ref ?? op.ref;
  if (['delay_income', 'shift_flow', 'set_amount', 'remove_flow'].includes(op.op) && (typeof ref !== 'string' || ref === '' || ref.length > 200)) schema(f + '.event_ref', 'required');
  if (op.op === 'delay_income') int_of(op.days, f + '.days', 0, 3650);
  if (op.op === 'shift_flow') int_of(op.days, f + '.days', -3650, 3650);
  if (op.op === 'set_amount') minor_of(op.amount_minor, f + '.amount_minor', { nonzero: true });
  if (op.op === 'add_purchase') {
    const parts = op.parts ?? [{ date: op.date, amount_minor: op.amount_minor }];
    if (!Array.isArray(parts) || parts.length < 1 || parts.length > 120) schema(f + '.parts', 'one_to_120_parts');
    parts.forEach((x, j) => { date_of(x?.date, `${f}.parts[${j}].date`); minor_of(x?.amount_minor, `${f}.parts[${j}].amount_minor`, { min: 1 }); });
  }
  if (op.op === 'add_flow') {
    if (is_obj(op.once)) { date_of(op.once.date, f + '.once.date'); minor_of(op.once.amount_minor, f + '.once.amount_minor', { nonzero: true }); }
    else if (is_obj(op.rule)) throw_first(validate_rule({ rule_id: 'scn', ...op.rule }), f + '.rule');
    else schema(f, 'add_flow_needs_once_or_rule');
  }
  if (op.op === 'fx_shock') { currency_of(op.currency, f + '.currency'); int_of(op.bp, f + '.bp', -10000, 100000); }
}

register_edit('save_scenario', (ws, edit, env) => {
  allow_keys(edit, ['type', 'scenario'], 'edit');
  const s = need_obj(edit.scenario, 'scenario');
  allow_keys(s, ['scenario_id', 'name', 'ops'], 'scenario');
  const id = id_of(s.scenario_id ?? env.new_id?.('scn'), 'scenario.scenario_id');
  claim_id(ws, 'scenario', id, 'scenario.scenario_id');
  if (!Array.isArray(s.ops) || s.ops.length > 50) schema('scenario.ops', 'at_most_50_ops');
  s.ops.forEach(check_op);
  const item = { scenario_id: id, name: text_of(s.name, 'scenario.name', 120), ops: clone(s.ops) };
  return set_bucket(ws, 'scenarios', upsert(list(ws, 'scenarios'), 'scenario_id', item)); // журнал фактов не затрагивается (REQ-014)
});

register_edit('delete_scenario', (ws, edit) => {
  allow_keys(edit, ['type', 'scenario_id'], 'edit');
  const id = id_of(edit.scenario_id, 'scenario_id');
  const arr = list(ws, 'scenarios');
  if (find_by(arr, 'scenario_id', id) === undefined) schema('scenario_id', 'unknown_scenario');
  return set_bucket(ws, 'scenarios', without(arr, (x) => x.scenario_id === id));
});

register_edit('set_wave_override', (ws, edit, env) => {
  allow_keys(edit, ['type', 'override', 'override_id', 'remove'], 'edit');
  const arr = list(ws, 'wave_overrides');
  if (edit.remove === true) {
    const id = id_of(edit.override_id, 'override_id');
    if (find_by(arr, 'override_id', id) === undefined) schema('override_id', 'unknown_override');
    return set_bucket(ws, 'wave_overrides', without(arr, (x) => x.override_id === id));
  }
  const o = need_obj(edit.override, 'override');
  allow_keys(o, ['override_id', 'action', 'event_ids', 'pin_range'], 'override');
  const item = { override_id: id_of(o.override_id ?? env.new_id?.('wov'), 'override.override_id') };
  item.action = enum_of(o.action, 'override.action', ['split', 'merge', 'pin']);
  if (!Array.isArray(o.event_ids) || o.event_ids.length < 1 || o.event_ids.length > 200) schema('override.event_ids', 'one_to_200_ids');
  item.event_ids = o.event_ids.map((x, i) => text_of(x, `override.event_ids[${i}]`, 200));
  if (item.action === 'merge' && item.event_ids.length < 2) schema('override.event_ids', 'merge_needs_two');
  if (o.pin_range !== undefined) {
    const pr = need_obj(o.pin_range, 'override.pin_range');
    allow_keys(pr, ['from', 'to'], 'override.pin_range');
    item.pin_range = { from: date_of(pr.from, 'override.pin_range.from'), to: date_of(pr.to, 'override.pin_range.to') };
    if (item.pin_range.to < item.pin_range.from) bad('E_BAD_DATE', 'override.pin_range', 'to_before_from');
  }
  // порядок применения — порядок записей: правка с тем же id уходит в конец списка
  return set_bucket(ws, 'wave_overrides', [...without(arr, (x) => x.override_id === item.override_id), item]);
});

register_edit('add_counterparty', (ws, edit, env) => {
  allow_keys(edit, ['type', 'counterparty'], 'edit');
  const c = need_obj(edit.counterparty, 'counterparty');
  allow_keys(c, ['counterparty_id', 'name', 'usual_delay_days'], 'counterparty');
  const id = id_of(c.counterparty_id ?? env.new_id?.('cp'), 'counterparty.counterparty_id');
  claim_id(ws, 'counterparty', id, 'counterparty.counterparty_id');
  const item = { counterparty_id: id, name: text_of(c.name, 'counterparty.name', 120) };
  if (c.usual_delay_days !== undefined) item.usual_delay_days = int_of(c.usual_delay_days, 'counterparty.usual_delay_days', 0, 365);
  return set_bucket(ws, 'counterparties', upsert(list(ws, 'counterparties'), 'counterparty_id', item));
});

// ── полная проверка модели (для файла, импорта и тестов; не нужна при каждой правке) ──────────────────────────────────

/**
 * Проверить рабочую область целиком: идентификаторы, единое пространство Id, числа, даты фактов, валюты, ноги переводов, правила,
 * потоки, налоговые правила. Не бросает: возвращает список отказов `{code, field, reason, …}`.
 * @param {object} ws
 * @param {{as_of?: string}} [opts]
 * @returns {{ok: boolean, errors: Array<{code: string, ctx: object|null}>}}
 */
export function check_model(ws, opts = {}) {
  const errors = [];
  const run = (fn) => { try { fn(); } catch (e) { errors.push(to_error(e)); } };
  const as_of = opts.as_of ?? ws.as_of;
  run(() => scan_edit(ws, 0, { n: 0, limit: 50_000_000 }));
  const accounts = list(ws, 'accounts');
  // единое пространство Id: один идентификатор — одна сущность одного вида
  const seen = new Map();
  for (const [kind, [bucket, f]] of Object.entries(ID_KINDS)) {
    const arr = bucket === 'tax_rules' ? list(ws, bucket).flat() : list(ws, bucket);
    const own_ids = new Set();
    for (const x of arr) {
      const id = x?.[f];
      if (typeof id !== 'string') { errors.push({ code: 'E_SCHEMA', ctx: { field: bucket, reason: 'id_required' } }); continue; }
      if (bucket !== 'tax_rules' && own_ids.has(id)) errors.push({ code: 'E_SCHEMA', ctx: { field: bucket, reason: 'duplicate_id' } });
      own_ids.add(id);
      if (seen.has(id) && seen.get(id) !== kind) errors.push({ code: 'E_SCHEMA', ctx: { field: bucket, reason: 'id_taken_by_other_kind', kind: seen.get(id) } });
      seen.set(id, kind);
    }
  }
  const acc_by = new Map(accounts.map((a) => [a.account_id, a]));
  for (const f of list(ws, 'facts')) {
    run(() => {
      if (typeof f.date !== 'string') bad('E_BAD_DATE', 'facts.date', 'not_iso_string');
      date_of(f.date, 'facts.date');
      if (typeof as_of === 'string' && f.date > as_of) bad('E_FUTURE_POSTED', 'facts.date', 'posted_after_as_of', { value: f.date, as_of });
      const a = acc_by.get(f.account_id);
      if (a === undefined) schema('facts.account_id', 'unknown_account');
      if (f.currency !== undefined && f.currency !== a.currency) bad('E_CURRENCY_MISMATCH', 'facts.currency', 'differs_from_account');
    });
  }
  const groups = new Map();
  for (const f of list(ws, 'facts')) if (typeof f.transfer_id === 'string') (groups.get(f.transfer_id) ?? groups.set(f.transfer_id, []).get(f.transfer_id)).push(f);
  for (const [tid, legs] of groups) run(() => check_transfer_legs(ws, legs, 'facts.transfer_id=' + clip(tid)));
  for (const r of list(ws, 'rules')) run(() => throw_first(validate_rule(r), 'rules'));
  for (const s of list(ws, 'streams')) run(() => throw_first(validate_stream(s), 'streams'));
  const tax = list(ws, 'tax_rules').flat();
  for (const t of tax) run(() => throw_first(validate_tax_rule(t), 'tax_rules'));
  run(() => check_tax_rate_sums(tax));
  return { ok: errors.length === 0, errors };
}

// ── общая проверка результата каждой правки: validate_ws движка (REQ-017, REQ-158; подключено интегратором волны 1) ─────────────────────
// Результат правки проверяется целиком теми же кодами, что чужой файл при открытии; значения полей в отказ не попадают (только код, вид и причина).
register_validator((ws, edit, env) => {
  const r = validate_ws(ws, { as_of: env?.as_of ?? ws.as_of }); // «сегодня» приложения может быть позже ws.as_of
  if (r.ok) return;
  const e = r.errors[0];
  fail(e.code, { field: e.field ?? e.kind ?? 'workspace', reason: e.reason, kind: e.kind ?? null });
});
