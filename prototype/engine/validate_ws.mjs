// validate_ws.mjs — проверка ЧУЖОЙ рабочей области и журнала до расчёта (FP-02; REQ-016, REQ-017, REQ-158, Q-12, Q-22, К-4).
// Вход из файла, импорта или ассистента — недоверенные данные (ADR-013): форма, размеры, диапазоны параметров, уникальность Id, ссылки между
// записями, знаки и валюты. Результат — не исключение, а список ошибок с кодами из набора REQ-017 (`E_NOT_INTEGER`, `E_OVERFLOW`, `E_BAD_DATE`,
// `E_FUTURE_POSTED`, `E_RULE_INVALID`, `E_CURRENCY_MISMATCH`, `E_NO_RATE`, `E_SCHEMA`); путь к записи и её Id называются в ошибке, значения — нет.
// Режим карантина (`quarantine_invalid`, `analyze_checked(..., {quarantine: true})`): один невалидный объект исключается из расчёта и помечается
// предупреждением, а не роняет весь `analyze` (Q-22). Режим по умолчанию — строгий: нет карантина, нет молчаливых исправлений.
// Модуль стоит ВЫШЕ index (импортирует analyze); index и остальной движок его не импортируют (правило слоёв §14 B4: циклов нет).
// Модуль чистый: ни часов, ни случайности, ни ввода-вывода. Расчёты — по введённым данным и правилам, не консультация.

import { fail, ERROR_CODES, currency_exponent } from './money.mjs';
import { to_epoch_day, days_from_civil } from './dates.mjs';
import { validate_rule, validate_override } from './recurrence.mjs';
import { validate_stream } from './hourly.mjs';
import { validate_tax_rule } from './tax.mjs';
import { validate_debt } from './debt.mjs';
import { EVENT_TYPES, DEFAULT_UPCAST_REGISTRY, effective_events, reduce } from './ledger.mjs';
import { TIMELINE_DEFAULTS, HORIZON_DAYS_MAX } from './timeline.mjs';
import { analyze } from './index.mjs';

// ── пределы и диапазоны ───────────────────────────────────────────────────────────────────────────────────────────────

/** Пределы размеров чужого файла: защита от памяти и времени (REQ-158). Все значения можно сузить через `opts.limits`. */
export const WS_LIMITS = Object.freeze({
  max_records: 200000, // записей в одном списке рабочей области
  max_events: 1000000, // записей журнала
  max_string: 10000, // знаков в одной строке
  max_id: 200, // знаков в идентификаторе
  max_depth: 24, // вложенность
  max_nodes: 5000000, // всего узлов JSON
  max_errors: 500, // ошибок в отчёте (дальше — `truncated`)
});

/**
 * Диапазоны параметров рабочей области (К-4). `horizon_days`, `worse.income_delay_days`, `match.window_days`, `tools.max_calls` — границы-предложение
 * К-4 (владельцу подтвердить); остальные — технические границы типа (целое, bp ≤ 10000), без смысловых ограничений.
 * @type {Readonly<Record<string, {type: 'int'|'enum'|'currency', min?: number, max?: number, values?: readonly string[], nullable?: boolean, proposal?: boolean}>>}
 */
export const PARAM_RANGES = Object.freeze({
  horizon_days: Object.freeze({ type: 'int', min: 1, max: HORIZON_DAYS_MAX, proposal: true }),
  'worse.income_delay_days': Object.freeze({ type: 'int', min: 0, max: 365, proposal: true }),
  'match.window_days': Object.freeze({ type: 'int', min: 0, max: 31, proposal: true }),
  'tools.max_calls': Object.freeze({ type: 'int', min: 1, max: 12, proposal: true }),
  buffer_minor: Object.freeze({ type: 'int', min: 0, max: Number.MAX_SAFE_INTEGER, nullable: true }),
  buffer_hint_days: Object.freeze({ type: 'int', min: 0, max: 3660 }),
  headline_mode: Object.freeze({ type: 'enum', values: Object.freeze(['plan', 'worse']) }),
  'grace_days.income': Object.freeze({ type: 'int', min: 0, max: 365 }),
  'grace_days.expense': Object.freeze({ type: 'int', min: 0, max: 365 }),
  'match.tol_bp': Object.freeze({ type: 'int', min: 0, max: 10000 }),
  'wave.gap_days': Object.freeze({ type: 'int', min: 0, max: 365 }),
  'wave.max_span_days': Object.freeze({ type: 'int', min: 1, max: 366 }),
  'wave.threshold_minor': Object.freeze({ type: 'int', min: 0, max: Number.MAX_SAFE_INTEGER, nullable: true }),
  'explain.top_k': Object.freeze({ type: 'int', min: 1, max: 1000 }),
  'explain.share_cutoff_bp': Object.freeze({ type: 'int', min: 0, max: 10000 }),
  'stale.banner_days': Object.freeze({ type: 'int', min: 0, max: 3660 }),
  'stale.block_days': Object.freeze({ type: 'int', min: 0, max: 3660 }),
  rounding: Object.freeze({ type: 'enum', values: Object.freeze(['half_even', 'half_up', 'floor', 'ceil']) }),
  'ready.q1': Object.freeze({ type: 'int', min: 0, max: 100 }),
  'ready.q3': Object.freeze({ type: 'int', min: 0, max: 100 }),
  'crypto.liquidity_bp': Object.freeze({ type: 'int', min: 0, max: 10000 }),
  'backup.remind_events': Object.freeze({ type: 'int', min: 1, max: 10000000 }),
  'backup.remind_days': Object.freeze({ type: 'int', min: 1, max: 3660 }),
  'fx.stale_days': Object.freeze({ type: 'int', min: 0, max: 3660 }),
  'backtest.h_days': Object.freeze({ type: 'int', min: 1, max: 3660 }),
  'backtest.min_window_days': Object.freeze({ type: 'int', min: 1, max: 3660 }),
  'debt.drift_tol_bp': Object.freeze({ type: 'int', min: 0, max: 10000 }),
  'calib.window': Object.freeze({ type: 'int', min: 1, max: 1000 }),
  'calib.prior': Object.freeze({ type: 'int', min: 0, max: 365 }),
  'calib.k': Object.freeze({ type: 'int', min: 0, max: 1000 }),
  'calib.alpha_bp': Object.freeze({ type: 'int', min: 0, max: 10000 }),
  'calib.min_origins': Object.freeze({ type: 'int', min: 1, max: 1000 }),
  'mc.n_paths': Object.freeze({ type: 'int', min: 1, max: 100000 }),
  decision_currency: Object.freeze({ type: 'currency', nullable: true }),
});

const CURRENCY_RE = /^[A-Z][A-Z0-9]{1,9}$/;
const LIQUIDITY = ['operating', 'savings', 'asset', 'debt'];
const RESERVE_KINDS = ['tax', 'sinking'];
const RESERVE_MODES = ['fixed', 'refill_to_target'];
const ALLOCATION_SOURCES = ['income', 'schedule', 'manual', 'release'];
const OVERRIDE_ACTIONS = ['move', 'skip', 'set_amount'];
const FORMAT_RE = /^runway-journal\/([1-9]\d*)$/;
const KNOWN_FORMAT_VERSION = 1;
const ACTOR_RE = /^(?:user|system|import:.+|assistant:.+)$/;
const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;

// ── служебное ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const is_obj = (x) => {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false;
  const p = Object.getPrototypeOf(x);
  return p === Object.prototype || p === null;
};
const is_int = (x) => typeof x === 'number' && Number.isSafeInteger(x);

/** Допустимый диапазон дат чужого файла: 1900-01-01 … 2200-12-31. Дальше расчёт тянулся бы на века (as_of = 10^9 дней → вечный цикл по правилам). */
const DAY_MIN = days_from_civil(1900, 1, 1);
const DAY_MAX = days_from_civil(2200, 12, 31);

function day_ok(x) {
  if (typeof x === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(x)) return false;
  if (typeof x !== 'string' && !is_int(x)) return false;
  try {
    const d = to_epoch_day(x);
    return d >= DAY_MIN && d <= DAY_MAX;
  } catch { return false; }
}

function instant_ok(s) {
  if (typeof s !== 'string') return false;
  const m = INSTANT_RE.exec(s);
  if (m === null || +m[4] > 23 || +m[5] > 59 || +m[6] > 59) return false;
  return day_ok(m[1] + '-' + m[2] + '-' + m[3]);
}

function currency_known(code) {
  if (typeof code !== 'string' || !CURRENCY_RE.test(code)) return false;
  try { currency_exponent(code); return true; } catch { return false; }
}

/** Накопитель ошибок и предупреждений с пределом длины (`truncated`). */
function make_sink(limit) {
  const errors = [];
  const warnings = [];
  const sink = {
    errors,
    warnings,
    truncated: false,
    /** @param {string} code @param {object} where {kind, index, id, field} @param {string} reason */
    err(code, where, reason) {
      if (errors.length >= limit) { sink.truncated = true; return; }
      const e = { code, kind: where.kind ?? null, index: where.index ?? null, id: where.id ?? null, field: where.field ?? null, reason };
      e.path = (e.kind === null ? '' : e.kind + (e.index === null ? '' : '[' + e.index + ']')) + (e.field === null ? '' : (e.kind === null ? '' : '.') + e.field);
      errors.push(e);
    },
    warn(w) { if (warnings.length < limit) warnings.push(w); },
  };
  return sink;
}

/** Ответ `entries_of` и `flat_tax` на слишком длинный список: его не разворачивали (FZ-1, хвост); вызывающий называет причину `too_many_records`. */
const TOO_LONG = Object.freeze({ too_long: true });

/**
 * Коллекция рабочей области (массив или словарь по Id) → массив `{key, rec}`. Иная форма — `null`.
 * Дыра разреженного массива (FZ-1, REQ-158) становится записью `undefined`: `Array.from` обходит каждый индекс, тогда как `Array.prototype.map` дыры пропускает и оставляет
 * в результате; цикл проверки получал бы `undefined` вместо `{key, rec}` и падал. Запись «не объект» проверка называет `record_not_object`, карантин её исключает.
 * Хвост FZ-1: `Array.from` обходит и каждую дыру, а длина разреженного массива не связана с памятью (до 2^32−1), поэтому массив длиннее `max` (`limits.max_records`) НЕ разворачивается:
 * ответ `TOO_LONG`, и вызывающий отвечает прежним `too_many_records`. Массив не длиннее предела и словарь разворачиваются как раньше.
 * @param {unknown} x
 * @param {number} max предел записей в списке (`limits.max_records`)
 */
function entries_of(x, max = WS_LIMITS.max_records) {
  if (x === undefined || x === null) return [];
  if (Array.isArray(x)) return x.length > max ? TOO_LONG : Array.from(x, (rec, i) => ({ key: i, rec }));
  if (is_obj(x)) return Object.keys(x).sort().map((k) => ({ key: k, rec: x[k] }));
  return null;
}

// ── обход значений: типы JSON, глубина, деньги, запрещённые ключи ─────────────────────────────────────────────────────

/**
 * Общая проверка значения: только JSON (без функций, символов, BigInt, не-обычных объектов), конечные числа, глубина и число узлов в пределах,
 * строки не длиннее `max_string`, ключ `__proto__` как имя поля запрещён (идентификаторы-значения допустимы), поля `*_minor` — целые safe-integer.
 * @returns {void}
 */
function scan_value(v, where, st, depth) {
  st.nodes += 1;
  if (st.nodes > st.limits.max_nodes) { if (!st.node_over) { st.node_over = true; st.sink.err('E_SCHEMA', { kind: where.kind, index: where.index, id: where.id }, 'too_many_nodes'); } return; }
  if (v === null || v === undefined || typeof v === 'boolean') return;
  switch (typeof v) {
    case 'string':
      if (v.length > st.limits.max_string) st.sink.err('E_SCHEMA', { ...where, field: st.field }, 'string_too_long');
      return;
    case 'number':
      if (!Number.isFinite(v)) st.sink.err('E_NOT_INTEGER', { ...where, field: st.field }, 'not_finite');
      return;
    case 'object': break;
    default:
      st.sink.err('E_SCHEMA', { ...where, field: st.field }, 'not_json_value');
      return;
  }
  if (depth >= st.limits.max_depth) { st.sink.err('E_SCHEMA', { ...where, field: st.field }, 'too_deep'); return; }
  if (Array.isArray(v)) {
    if (v.length > st.limits.max_records) { st.sink.err('E_SCHEMA', { ...where, field: st.field }, 'array_too_long'); return; }
    for (let i = 0; i < v.length; i++) {
      const prev = st.field;
      st.field = (prev === null ? '' : prev) + '[' + i + ']';
      scan_value(v[i], where, st, depth + 1);
      st.field = prev;
      if (st.sink.truncated) return;
    }
    return;
  }
  if (!is_obj(v)) { st.sink.err('E_SCHEMA', { ...where, field: st.field }, 'not_plain_object'); return; }
  for (const k of Object.keys(v)) {
    const prev = st.field;
    st.field = prev === null ? k : prev + '.' + k;
    if (k === '__proto__') st.sink.err('E_SCHEMA', { ...where, field: st.field }, 'forbidden_key');
    else if (k.length > st.limits.max_id * 2) st.sink.err('E_SCHEMA', { ...where, field: st.field.slice(0, 60) }, 'key_too_long');
    else if (k.endsWith('_minor') && v[k] !== null && v[k] !== undefined) {
      const x = v[k];
      if (typeof x !== 'number' || !Number.isInteger(x)) st.sink.err('E_NOT_INTEGER', { ...where, field: st.field }, 'money_not_integer');
      else if (!Number.isSafeInteger(x)) st.sink.err('E_OVERFLOW', { ...where, field: st.field }, 'money_out_of_range');
      else scan_value(x, where, st, depth + 1);
    } else scan_value(v[k], where, st, depth + 1);
    st.field = prev;
    if (st.sink.truncated) return;
  }
}

function scan_record(rec, where, st) {
  st.field = null;
  scan_value(rec, where, st, 0);
}

// ── параметры (К-4) ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Развернуть вложенные параметры в плоские ключи `a.b` (только собственные ключи; `__proto__` пропускается). */
function flatten_params(obj, prefix, out, depth) {
  if (depth > 6) return;
  for (const k of Object.keys(obj)) {
    if (k === '__proto__') continue;
    const key = prefix === '' ? k : prefix + '.' + k;
    const v = obj[k];
    if (is_obj(v)) flatten_params(v, key, out, depth + 1);
    else out[key] = v;
  }
}

function param_problem(key, v) {
  const r = PARAM_RANGES[key];
  if (r === undefined) return null; // неизвестный ключ — не нарушение (расширения)
  if (v === null || v === undefined) return r.nullable === true ? null : 'null_not_allowed';
  if (r.type === 'int') {
    if (typeof v !== 'number' || !Number.isInteger(v)) return 'not_integer';
    if (!Number.isSafeInteger(v)) return 'overflow';
    if (v < r.min || v > r.max) return 'out_of_range';
    return null;
  }
  if (r.type === 'enum') return typeof v === 'string' && r.values.includes(v) ? null : 'not_in_list';
  if (r.type === 'currency') return currency_known(v) ? null : 'unknown_currency';
  return null;
}

/**
 * Проверка параметров по диапазонам К-4. Чужой журнал с параметром вне диапазона получает значение по умолчанию (`params` — только допустимые
 * ключи, плоские; вызывающий подставляет их вместо исходных) и предупреждение `W_PARAM_OUT_OF_RANGE`; при записи через `params.set` это
 * `E_SCHEMA` (`ok = false`, `problems`).
 * @param {object|null|undefined} params плоские ключи `a.b` или вложенные объекты
 * @returns {{ok: boolean, params: Object<string, any>, problems: {key: string, reason: string}[], warnings: {code: string, key: string}[]}}
 */
export function check_params(params) {
  const flat = {};
  if (is_obj(params)) flatten_params(params, '', flat, 0);
  const clean = {};
  const problems = [];
  for (const key of Object.keys(flat).sort()) {
    const why = param_problem(key, flat[key]);
    if (why === null) clean[key] = flat[key];
    else problems.push({ key, reason: why });
  }
  return { ok: problems.length === 0, params: clean, problems, warnings: problems.map((p) => ({ code: 'W_PARAM_OUT_OF_RANGE', key: p.key })) };
}

// ── проверки записей ──────────────────────────────────────────────────────────────────────────────────────────────────

function id_of(rec, ...fields) {
  if (!is_obj(rec)) return null;
  for (const f of fields) if (typeof rec[f] === 'string' && rec[f] !== '') return rec[f].slice(0, 80);
  return null;
}

function check_id(value, field, where, ctx) {
  if (typeof value !== 'string' || value === '') { ctx.sink.err('E_SCHEMA', { ...where, field }, 'id_required'); return false; }
  if (value.length > ctx.limits.max_id) { ctx.sink.err('E_SCHEMA', { ...where, field }, 'id_too_long'); return false; }
  if (CONTROL_RE.test(value)) { ctx.sink.err('E_SCHEMA', { ...where, field }, 'id_control_chars'); return false; }
  return true;
}

function check_unique(set, value, field, where, ctx) {
  if (!check_id(value, field, where, ctx)) return;
  if (set.has(value)) ctx.sink.err('E_SCHEMA', { ...where, field }, 'duplicate_id');
  set.add(value);
}

function need_date(value, field, where, ctx, optional = false) {
  if (optional && (value === undefined || value === null)) return null;
  if (!day_ok(value)) { ctx.sink.err('E_BAD_DATE', { ...where, field }, 'bad_date'); return null; }
  return to_epoch_day(value);
}

function need_money(value, field, where, ctx, optional = false) {
  if (optional && (value === undefined || value === null)) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) { ctx.sink.err('E_NOT_INTEGER', { ...where, field }, 'money_not_integer'); return null; }
  if (!Number.isSafeInteger(value)) { ctx.sink.err('E_OVERFLOW', { ...where, field }, 'money_out_of_range'); return null; }
  return value;
}

function need_account(value, field, where, ctx, optional = false) {
  if (optional && (value === undefined || value === null)) return null;
  if (typeof value !== 'string' || !ctx.accounts.has(value)) { ctx.sink.err('E_SCHEMA', { ...where, field }, 'unknown_account'); return null; }
  return ctx.accounts.get(value);
}

function map_errors(list, where, ctx, code_override) {
  for (const e of list) ctx.sink.err(code_override ?? e.code, { ...where, field: e.field }, e.reason);
}

const CHECKS = {
  accounts(rec, where, ctx) {
    check_unique(ctx.ids.accounts, rec.account_id, 'account_id', where, ctx);
    if (!LIQUIDITY.includes(rec.liquidity)) ctx.sink.err('E_SCHEMA', { ...where, field: 'liquidity' }, 'unknown_liquidity');
    if (!currency_known(rec.currency)) ctx.sink.err('E_SCHEMA', { ...where, field: 'currency' }, 'unknown_currency');
    else if (rec.exponent !== undefined && rec.exponent !== currency_exponent(rec.currency)) ctx.sink.err('E_SCHEMA', { ...where, field: 'exponent' }, 'exponent_mismatch');
    if (rec.kind !== undefined && typeof rec.kind !== 'string') ctx.sink.err('E_SCHEMA', { ...where, field: 'kind' }, 'not_string');
    const o = need_date(rec.opened_on, 'opened_on', where, ctx, true);
    const c = need_date(rec.closed_on, 'closed_on', where, ctx, true);
    if (o !== null && c !== null && c < o) ctx.sink.err('E_BAD_DATE', { ...where, field: 'closed_on' }, 'closed_before_opened');
  },
  anchors(rec, where, ctx) {
    check_unique(ctx.ids.anchors, rec.anchor_id, 'anchor_id', where, ctx);
    need_account(rec.account_id, 'account_id', where, ctx);
    need_date(rec.date, 'date', where, ctx);
    need_money(rec.amount_minor, 'amount_minor', where, ctx);
  },
  facts(rec, where, ctx) {
    const id = rec.cash_event_id ?? rec.event_id ?? rec.entity_id ?? rec.id;
    check_unique(ctx.ids.facts, id, 'event_id', where, ctx);
    const acc = need_account(rec.account_id, 'account_id', where, ctx);
    const d = need_date(rec.date, 'date', where, ctx);
    if (d !== null && ctx.as_of !== null && d > ctx.as_of) ctx.sink.err('E_FUTURE_POSTED', { ...where, field: 'date' }, 'posted_after_as_of');
    need_money(rec.amount_minor, 'amount_minor', where, ctx);
    if (rec.currency !== undefined && rec.currency !== null) {
      if (!currency_known(rec.currency)) ctx.sink.err('E_SCHEMA', { ...where, field: 'currency' }, 'unknown_currency');
      else if (acc !== null && acc.currency !== rec.currency) ctx.sink.err('E_CURRENCY_MISMATCH', { ...where, field: 'currency' }, 'currency_differs_from_account');
    }
    if (rec.transfer_id !== undefined && rec.transfer_id !== null) check_id(rec.transfer_id, 'transfer_id', where, ctx);
  },
  plans(rec, where, ctx) {
    check_unique(ctx.ids.plans, rec.plan_id ?? rec.cash_event_id, 'plan_id', where, ctx);
    const acc = need_account(rec.account_id, 'account_id', where, ctx, true);
    need_date(rec.date, 'date', where, ctx);
    need_money(rec.amount_minor, 'amount_minor', where, ctx);
    if (rec.currency !== undefined && rec.currency !== null) {
      if (!currency_known(rec.currency)) ctx.sink.err('E_SCHEMA', { ...where, field: 'currency' }, 'unknown_currency');
      else if (acc !== null && acc.currency !== rec.currency) ctx.sink.err('E_CURRENCY_MISMATCH', { ...where, field: 'currency' }, 'currency_differs_from_account');
    }
    if (rec.transfer_id !== undefined && rec.transfer_id !== null) check_id(rec.transfer_id, 'transfer_id', where, ctx);
  },
  rules(rec, where, ctx) {
    check_unique(ctx.ids.rules, rec.rule_id, 'rule_id', where, ctx);
    map_errors(validate_rule(rec).errors, where, ctx);
    const acc = need_account(rec.account_id, 'account_id', where, ctx, true);
    if (acc !== null && rec.currency !== undefined && rec.currency !== null && acc.currency !== rec.currency) ctx.sink.err('E_CURRENCY_MISMATCH', { ...where, field: 'currency' }, 'currency_differs_from_account');
    if (rec.calendar_id !== undefined && rec.calendar_id !== null && !ctx.calendar_ids.has(rec.calendar_id)) ctx.sink.err('E_SCHEMA', { ...where, field: 'calendar_id' }, 'unknown_calendar');
  },
  overrides(rec, where, ctx) {
    const rule = is_obj(rec) && typeof rec.rule_id === 'string' ? ctx.rules_by_id.get(rec.rule_id) : undefined;
    map_errors(validate_override(rec, rule).errors, where, ctx);
    if (is_obj(rec) && rec.action === 'move' && rec.date !== undefined && day_ok(rec.date) && day_ok(rec.nominal_date)
      && Math.abs(to_epoch_day(rec.date) - to_epoch_day(rec.nominal_date)) > 3660) ctx.sink.err('E_BAD_DATE', { ...where, field: 'date' }, 'move_too_far');
  },
  streams(rec, where, ctx) {
    check_unique(ctx.ids.streams, rec.stream_id, 'stream_id', where, ctx);
    map_errors(validate_stream(rec).errors, where, ctx);
    need_account(rec.account_id, 'account_id', where, ctx, true);
    if (rec.currency !== undefined && rec.currency !== null && !currency_known(rec.currency)) ctx.sink.err('E_SCHEMA', { ...where, field: 'currency' }, 'unknown_currency');
    if (rec.calendar_id !== undefined && rec.calendar_id !== null && !ctx.calendar_ids.has(rec.calendar_id)) ctx.sink.err('E_SCHEMA', { ...where, field: 'calendar_id' }, 'unknown_calendar');
  },
  tax_rules(rec, where, ctx) {
    map_errors(validate_tax_rule(rec).errors, where, ctx);
    if (is_obj(rec) && typeof rec.reserve_id === 'string' && !ctx.reserve_ids.has(rec.reserve_id)) ctx.sink.err('E_SCHEMA', { ...where, field: 'reserve_id' }, 'unknown_reserve');
  },
  reserves(rec, where, ctx) {
    check_unique(ctx.ids.reserves, rec.reserve_id, 'reserve_id', where, ctx);
    if (rec.kind !== undefined && !RESERVE_KINDS.includes(rec.kind)) ctx.sink.err('E_SCHEMA', { ...where, field: 'kind' }, 'unknown_reserve_kind');
    if (rec.currency !== undefined && rec.currency !== null) {
      if (!currency_known(rec.currency)) ctx.sink.err('E_SCHEMA', { ...where, field: 'currency' }, 'unknown_currency');
      else if (ctx.decision_currency !== null && rec.currency !== ctx.decision_currency) ctx.sink.err('E_CURRENCY_MISMATCH', { ...where, field: 'currency' }, 'reserve_not_in_decision_currency');
    }
    const f = need_money(rec.funded_start_minor, 'funded_start_minor', where, ctx, true);
    if (f !== null && f < 0) ctx.sink.err('E_SCHEMA', { ...where, field: 'funded_start_minor' }, 'negative');
    need_date(rec.funded_as_of, 'funded_as_of', where, ctx, true);
    need_date(rec.due_date, 'due_date', where, ctx, true);
    const t = need_money(rec.target_minor, 'target_minor', where, ctx, true);
    if (t !== null && t < 0) ctx.sink.err('E_SCHEMA', { ...where, field: 'target_minor' }, 'negative');
    if (rec.kind === 'sinking') {
      if (!RESERVE_MODES.includes(rec.mode)) ctx.sink.err('E_SCHEMA', { ...where, field: 'mode' }, 'sinking_needs_mode');
      else if (rec.mode === 'refill_to_target') {
        if (rec.target_minor === undefined || rec.target_minor === null) ctx.sink.err('E_SCHEMA', { ...where, field: 'target_minor' }, 'target_missing');
        if (rec.due_date === undefined || rec.due_date === null) ctx.sink.err('E_SCHEMA', { ...where, field: 'due_date' }, 'refill_to_target_needs_due_date');
      } else if (rec.fixed_minor === undefined || rec.fixed_minor === null) ctx.sink.err('E_SCHEMA', { ...where, field: 'fixed_minor' }, 'fixed_mode_needs_fixed_minor');
      const fx = need_money(rec.fixed_minor, 'fixed_minor', where, ctx, true);
      if (fx !== null && fx < 0) ctx.sink.err('E_SCHEMA', { ...where, field: 'fixed_minor' }, 'negative');
      if (rec.cadence !== undefined && rec.cadence !== null) {
        const c = rec.cadence;
        if (!is_obj(c) || c.freq !== 'M' || !is_int(c.day) || c.day < 1 || c.day > 31) ctx.sink.err('E_SCHEMA', { ...where, field: 'cadence' }, 'only_monthly_cadence_day_1_31');
      }
    }
    if (rec.backed_by_account_id !== undefined && rec.backed_by_account_id !== null) need_account(rec.backed_by_account_id, 'backed_by_account_id', where, ctx);
  },
  allocations(rec, where, ctx) {
    check_unique(ctx.ids.allocations, rec.allocation_id, 'allocation_id', where, ctx);
    if (typeof rec.reserve_id !== 'string' || !ctx.reserve_ids.has(rec.reserve_id)) ctx.sink.err('E_SCHEMA', { ...where, field: 'reserve_id' }, 'unknown_reserve');
    need_date(rec.date, 'date', where, ctx);
    need_money(rec.amount_minor, 'amount_minor', where, ctx);
    if (!ALLOCATION_SOURCES.includes(rec.source)) ctx.sink.err('E_SCHEMA', { ...where, field: 'source' }, 'unknown_allocation_source');
    else if (rec.source === 'income' && is_int(rec.amount_minor) && rec.amount_minor < 0) ctx.sink.err('E_SCHEMA', { ...where, field: 'amount_minor' }, 'income_allocation_negative');
  },
  rates(rec, where, ctx) {
    if (rec.fx_id !== undefined && rec.fx_id !== null) check_unique(ctx.ids.rates, rec.fx_id, 'fx_id', where, ctx);
    need_date(rec.date, 'date', where, ctx);
    if (!currency_known(rec.base)) ctx.sink.err('E_SCHEMA', { ...where, field: 'base' }, 'unknown_currency');
    if (!currency_known(rec.quote)) ctx.sink.err('E_SCHEMA', { ...where, field: 'quote' }, 'unknown_currency');
    if (rec.base === rec.quote && typeof rec.base === 'string') ctx.sink.err('E_SCHEMA', { ...where, field: 'quote' }, 'base_equals_quote');
    for (const f of ['num', 'den']) {
      if (typeof rec[f] !== 'number' || !Number.isInteger(rec[f])) ctx.sink.err('E_NOT_INTEGER', { ...where, field: f }, 'rate_part_not_integer');
      else if (!Number.isSafeInteger(rec[f])) ctx.sink.err('E_OVERFLOW', { ...where, field: f }, 'rate_part_out_of_range');
      else if (rec[f] < 1) ctx.sink.err('E_SCHEMA', { ...where, field: f }, 'rate_part_not_positive');
    }
  },
  scenarios(rec, where, ctx) {
    check_unique(ctx.ids.scenarios, rec.scenario_id, 'scenario_id', where, ctx);
    if (rec.ops !== undefined && rec.ops !== null) {
      if (!Array.isArray(rec.ops)) ctx.sink.err('E_SCHEMA', { ...where, field: 'ops' }, 'ops_not_array');
      else rec.ops.forEach((op, i) => { if (!is_obj(op) || typeof op.op !== 'string') ctx.sink.err('E_SCHEMA', { ...where, field: 'ops[' + i + ']' }, 'op_required'); });
    }
  },
  purchases(rec, where, ctx) {
    check_unique(ctx.ids.purchases, rec.purchase_id, 'purchase_id', where, ctx);
    if (!Array.isArray(rec.parts) || rec.parts.length === 0) ctx.sink.err('E_SCHEMA', { ...where, field: 'parts' }, 'parts_required');
    else rec.parts.forEach((p, i) => {
      if (!is_obj(p)) { ctx.sink.err('E_SCHEMA', { ...where, field: 'parts[' + i + ']' }, 'not_object'); return; }
      need_date(p.date, 'parts[' + i + '].date', where, ctx);
      need_money(p.amount_minor, 'parts[' + i + '].amount_minor', where, ctx);
    });
    if (rec.currency !== undefined && rec.currency !== null && !currency_known(rec.currency)) ctx.sink.err('E_SCHEMA', { ...where, field: 'currency' }, 'unknown_currency');
  },
  debts(rec, where, ctx) {
    check_unique(ctx.ids.debts, rec.debt_id, 'debt_id', where, ctx);
    const acc = need_account(rec.pay_account_id, 'pay_account_id', where, ctx);
    if (!currency_known(rec.currency)) ctx.sink.err('E_SCHEMA', { ...where, field: 'currency' }, 'unknown_currency');
    else if (acc !== null && acc.currency !== rec.currency) ctx.sink.err('E_CURRENCY_MISMATCH', { ...where, field: 'currency' }, 'currency_differs_from_account');
    if (Array.isArray(rec.schedule)) {
      rec.schedule.forEach((r, i) => {
        if (!is_obj(r)) { ctx.sink.err('E_SCHEMA', { ...where, field: 'schedule[' + i + ']' }, 'not_object'); return; }
        need_date(r.date, 'schedule[' + i + '].date', where, ctx);
        need_money(r.payment_minor, 'schedule[' + i + '].payment_minor', where, ctx);
      });
    } else {
      need_date(rec.start_date, 'start_date', where, ctx);
      try { validate_debt(rec.principal_minor, rec.rate_bp, rec.n, rec.kind); } catch (e) {
        ctx.sink.err(ERROR_CODES.includes(e?.code) ? e.code : 'E_SCHEMA', { ...where, field: 'principal_minor' }, String(e?.ctx?.reason ?? 'debt_invalid'));
      }
      if (rec.cadence !== undefined && rec.cadence !== null && !is_obj(rec.cadence)) ctx.sink.err('E_SCHEMA', { ...where, field: 'cadence' }, 'not_object');
    }
  },
  calendars(rec, where, ctx) {
    check_unique(ctx.ids.calendars, rec.calendar_id, 'calendar_id', where, ctx);
    if (rec.weekend_dows !== undefined && rec.weekend_dows !== null) {
      if (!Array.isArray(rec.weekend_dows) || rec.weekend_dows.some((d) => !is_int(d) || d < 0 || d > 6)) ctx.sink.err('E_SCHEMA', { ...where, field: 'weekend_dows' }, 'int_0_6_list');
    }
    if (rec.holidays !== undefined && rec.holidays !== null) {
      if (!Array.isArray(rec.holidays) || rec.holidays.some((d) => !day_ok(d))) ctx.sink.err('E_BAD_DATE', { ...where, field: 'holidays' }, 'bad_date_list');
    }
  },
  wave_overrides(rec, where, ctx) {
    if (rec.override_id !== undefined && rec.override_id !== null) check_unique(ctx.ids.wave_overrides, rec.override_id, 'override_id', where, ctx);
  },
  counterparties() {},
};

/** Поля, из которых берётся Id записи для отчёта об ошибке. */
const ID_FIELDS = {
  accounts: ['account_id'], anchors: ['anchor_id'], facts: ['event_id', 'cash_event_id', 'entity_id', 'id'], plans: ['plan_id', 'cash_event_id'], rules: ['rule_id'],
  overrides: ['rule_id'], streams: ['stream_id'], tax_rules: ['tax_rule_id'], reserves: ['reserve_id'], allocations: ['allocation_id'], rates: ['fx_id'],
  scenarios: ['scenario_id'], purchases: ['purchase_id'], debts: ['debt_id'], calendars: ['calendar_id'], wave_overrides: ['override_id'], counterparties: ['counterparty_id'],
};

/** Порядок проверки списков: сначала те, на которые ссылаются остальные. */
const LIST_ORDER = ['accounts', 'calendars', 'reserves', 'rules', 'streams', 'anchors', 'facts', 'plans', 'overrides', 'tax_rules', 'allocations', 'rates', 'scenarios', 'purchases', 'debts', 'wave_overrides', 'counterparties'];
const ALT_NAME = { plans: 'planned_one_offs', rates: 'fx' };

function pick(ws, name) {
  const js = is_obj(ws.js) ? ws.js : {};
  const alt = ALT_NAME[name];
  return ws[name] ?? (alt === undefined ? undefined : ws[alt]) ?? js[name];
}

/**
 * `tax_rules` в рабочей области — список версий (допустим список списков, как принимает `normalize_ws`).
 * Хвост FZ-1: плоский список длиннее `max` не строится — ответ `TOO_LONG` (решение то же, что давала проверка длины после сборки: «слишком много записей»); вложенный разреженный
 * массив длиннее `max` не обходится, а работа ограничена `max + 1` шагами.
 * @param {unknown[]} list
 * @param {number} max предел записей в списке (`limits.max_records`)
 * @returns {unknown[]|typeof TOO_LONG}
 */
function flat_tax(list, max = WS_LIMITS.max_records) {
  const out = [];
  for (const x of list) {
    if (Array.isArray(x)) {
      if (x.length > max) return TOO_LONG;
      for (const y of x) out.push(y);
    } else out.push(x);
    if (out.length > max) return TOO_LONG;
  }
  return out;
}

// ── рабочая область ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Проверка рабочей области (формат `ws`, как `data/g001.json`) до расчёта. Не бросает исключений на любом входе.
 * Ошибки — `{code, kind, index, id, field, reason, path}`; `code` — из набора REQ-017. Предупреждения расчёт не прерывают.
 * Проверяется: форма (объект; списки — массив или словарь), формат файла (`runway-journal/N`, N > 1 — `newer_format`, только чтение), типы JSON,
 * размеры и глубина, поля `*_minor` — целые safe-integer, даты, уникальность Id по спискам и общее пространство `rule_id`/`stream_id` (REQ-010),
 * ссылки (счёт, календарь, резерв), знак и валюта (`E_CURRENCY_MISMATCH`), ноги перевода в одной валюте дают в сумме 0 (REQ-017), факт позже `as_of`
 * (`E_FUTURE_POSTED`), диапазоны параметров К-4, правила повторения, потоки часов, налоговые правила, долги (валидаторами модулей), правки сумм.
 * @param {object} ws
 * @param {{as_of?: string|number, limits?: Partial<typeof WS_LIMITS>}} [opts] `as_of` — дата, по которой проверяются факты (иначе `ws.as_of`)
 * @returns {{ok: boolean, errors: {code: string, kind: string|null, index: number|string|null, id: string|null, field: string|null, reason: string, path: string}[],
 *   warnings: object[], truncated: boolean, read_only: boolean, stats: {records: number}}}
 */
export function validate_ws(ws, opts = {}) {
  const limits = { ...WS_LIMITS, ...(is_obj(opts?.limits) ? opts.limits : {}) };
  const sink = make_sink(limits.max_errors);
  const stats = { records: 0 };
  let read_only = false;
  const done = () => ({ ok: sink.errors.length === 0, errors: sink.errors, warnings: sink.warnings, truncated: sink.truncated, read_only, stats });
  try {
    if (!is_obj(ws)) { sink.err('E_SCHEMA', {}, 'workspace_not_object'); return done(); }
    // формат и дата расчёта
    if (ws.format !== undefined && ws.format !== null) {
      const m = typeof ws.format === 'string' ? FORMAT_RE.exec(ws.format) : null;
      if (m === null) sink.err('E_SCHEMA', { field: 'format' }, 'bad_format');
      else if (Number(m[1]) > KNOWN_FORMAT_VERSION) { sink.err('E_SCHEMA', { field: 'format' }, 'newer_format'); read_only = true; }
    }
    const as_of_raw = opts?.as_of ?? ws.as_of;
    let as_of = null;
    if (as_of_raw !== undefined && as_of_raw !== null) {
      if (day_ok(as_of_raw)) as_of = to_epoch_day(as_of_raw);
      else sink.err('E_BAD_DATE', { field: 'as_of' }, 'bad_date');
    }
    // параметры
    if (ws.params !== undefined && ws.params !== null && !is_obj(ws.params)) sink.err('E_SCHEMA', { field: 'params' }, 'params_not_object');
    else {
      const pc = check_params(ws.params);
      for (const p of pc.problems) sink.err('E_SCHEMA', { kind: 'params', field: p.key }, p.reason);
      for (const k of Object.keys(ws.params ?? {})) if (k === '__proto__') sink.err('E_SCHEMA', { kind: 'params', field: k }, 'forbidden_key');
    }
    if (ws.decision_currency !== undefined && ws.decision_currency !== null && !currency_known(ws.decision_currency)) sink.err('E_SCHEMA', { field: 'decision_currency' }, 'unknown_currency');

    const st = { sink, limits, nodes: 0, field: null, node_over: false };
    // списки
    const lists = new Map();
    for (const name of LIST_ORDER) {
      const raw = pick(ws, name);
      let ents = entries_of(raw, limits.max_records); // слишком длинный массив не разворачивается (хвост FZ-1): ответ TOO_LONG
      if (ents === null) { sink.err('E_SCHEMA', { kind: name }, 'collection_not_array_or_object'); ents = []; }
      if (name === 'tax_rules' && ents !== TOO_LONG) {
        const flat = flat_tax(ents.map((e) => e.rec), limits.max_records);
        ents = flat === TOO_LONG ? TOO_LONG : flat.map((rec, i) => ({ key: i, rec }));
      }
      if (ents === TOO_LONG || ents.length > limits.max_records) { sink.err('E_SCHEMA', { kind: name }, 'too_many_records'); ents = []; }
      lists.set(name, ents);
      stats.records += ents.length;
    }
    // контекст ссылок
    const accounts = new Map();
    for (const { rec } of lists.get('accounts')) if (is_obj(rec) && typeof rec.account_id === 'string' && !accounts.has(rec.account_id)) accounts.set(rec.account_id, rec);
    const calendar_ids = new Set();
    for (const { rec } of lists.get('calendars')) if (is_obj(rec) && typeof rec.calendar_id === 'string') calendar_ids.add(rec.calendar_id);
    const rules_by_id = new Map();
    for (const { rec } of lists.get('rules')) if (is_obj(rec) && typeof rec.rule_id === 'string') rules_by_id.set(rec.rule_id, rec);
    const reserve_ids = new Set();
    for (const { rec } of lists.get('reserves')) if (is_obj(rec) && typeof rec.reserve_id === 'string') reserve_ids.add(rec.reserve_id);
    let decision_currency = typeof ws.decision_currency === 'string' ? ws.decision_currency : (typeof ws.params?.decision_currency === 'string' ? ws.params.decision_currency : null);
    if (decision_currency === null) {
      for (const { rec } of lists.get('accounts')) if (is_obj(rec) && rec.liquidity === 'operating' && typeof rec.currency === 'string') { decision_currency = rec.currency; break; }
    }
    const ids = {};
    for (const name of LIST_ORDER) ids[name] = new Set();
    const ctx = { sink, limits, as_of, accounts, calendar_ids, rules_by_id, decision_currency, ids, reserve_ids };
    for (const name of LIST_ORDER) {
      const check = CHECKS[name];
      for (const { key, rec } of lists.get(name)) {
        const where = { kind: name, index: key, id: id_of(rec, ...ID_FIELDS[name]) };
        if (!is_obj(rec)) { sink.err('E_SCHEMA', where, 'record_not_object'); continue; }
        scan_record(rec, where, st);
        if (sink.truncated) return done();
        try {
          check(rec, where, ctx);
        } catch (e) { // валидатор модуля споткнулся о мусор в записи: запись отвергается, проверка не падает (REQ-158)
          sink.err(name === 'rules' ? 'E_RULE_INVALID' : 'E_SCHEMA', where, 'malformed_record:' + String(e?.name ?? 'Error'));
        }
      }
    }
    // rule_id и stream_id — одно пространство Id (C-025, REQ-010)
    for (const { key, rec } of lists.get('streams')) {
      if (is_obj(rec) && typeof rec.stream_id === 'string' && rules_by_id.has(rec.stream_id)) sink.err('E_SCHEMA', { kind: 'streams', index: key, id: rec.stream_id.slice(0, 80), field: 'stream_id' }, 'id_space_collision');
    }
    check_transfers(lists, ctx);
  } catch (e) {
    // защитная сетка: проверка не должна бросать (REQ-158); непредвиденное — ошибка формы, а не исключение наружу
    sink.err('E_SCHEMA', { kind: null }, 'validator_internal:' + String(e?.name ?? 'Error') + ':' + String(e?.message ?? '').slice(0, 100));
  }
  return done();
}

/** Ноги перевода в одной валюте суммируются в 0 (REQ-017); перевод с единственной ногой — служебное предупреждение. */
function check_transfers(lists, ctx) {
  const groups = new Map(); // transfer_id → {legs, by_currency: Map<cur, {sum, n}>}
  const add = (rec) => {
    if (!is_obj(rec) || typeof rec.transfer_id !== 'string' || !is_int(rec.amount_minor)) return;
    let g = groups.get(rec.transfer_id);
    if (g === undefined) { g = { legs: 0, cur: new Map() }; groups.set(rec.transfer_id, g); }
    g.legs += 1;
    const cur = typeof rec.currency === 'string' ? rec.currency : (ctx.accounts.get(rec.account_id)?.currency ?? '');
    const c = g.cur.get(cur) ?? { sum: 0, n: 0 };
    c.sum += rec.amount_minor;
    c.n += 1;
    g.cur.set(cur, c);
  };
  for (const { rec } of lists.get('plans')) add(rec);
  for (const { rec } of lists.get('facts')) add(rec);
  for (const [id, g] of groups) {
    for (const [, c] of g.cur) {
      if (c.n >= 2 && Math.abs(c.sum) > Number.MAX_SAFE_INTEGER) ctx.sink.err('E_OVERFLOW', { kind: 'transfers', id: id.slice(0, 80) }, 'transfer_sum_out_of_range');
      else if (c.n >= 2 && c.sum !== 0) ctx.sink.err('E_SCHEMA', { kind: 'transfers', id: id.slice(0, 80), field: 'amount_minor' }, 'transfer_legs_not_zero');
    }
    if (g.legs === 1) ctx.sink.warn({ code: 'W_TRANSFER_UNPAIRED', transfer_id: id.slice(0, 80) });
  }
}

// ── журнал ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Состояние журнала (`reduce(effective_events(...))`) → рабочая область для `validate_ws`. */
function ws_from_state(state) {
  const vals = (d) => (is_obj(d) ? Object.keys(d).sort().map((k) => d[k]) : []);
  return {
    format: 'runway-journal/1',
    params: is_obj(state.params) ? state.params : {},
    accounts: vals(state.accounts), anchors: vals(state.anchors), facts: vals(state.facts), plans: vals(state.plans), rules: vals(state.rules),
    overrides: vals(state.overrides), calendars: vals(state.calendars), streams: vals(state.streams),
    tax_rules: vals(state.tax_rules).flat(), reserves: vals(state.reserves), allocations: vals(state.allocations), rates: vals(state.fx),
    scenarios: vals(state.scenarios), purchases: vals(state.purchases), debts: vals(state.debts),
    wave_overrides: Array.isArray(state.wave_overrides) ? state.wave_overrides : [], counterparties: vals(state.counterparties),
  };
}

/**
 * Проверка журнала `LedgerEvent[]` (или файла-копии `{format, events}`) до свёртки. Формат записей, версии (`v` выше известной — `newer_version`,
 * только чтение), уникальность `event_id`, моменты, акторы, типы JSON и целые деньги в payload; затем свёртка в `try`: ошибка модели (`E_SCHEMA`
 * и др.) становится ошибкой отчёта; состояние проходит те же проверки, что рабочая область.
 * @param {object[]|{format?: string, events: object[]}} journal
 * @param {{as_of?: string|number, limits?: Partial<typeof WS_LIMITS>}} [opts]
 * @returns {{ok: boolean, errors: object[], warnings: object[], truncated: boolean, read_only: boolean, stats: {events: number}}}
 */
export function validate_journal(journal, opts = {}) {
  const limits = { ...WS_LIMITS, ...(is_obj(opts?.limits) ? opts.limits : {}) };
  const sink = make_sink(limits.max_errors);
  let read_only = false;
  const stats = { events: 0 };
  const done = () => ({ ok: sink.errors.length === 0, errors: sink.errors, warnings: sink.warnings, truncated: sink.truncated, read_only, stats });
  try {
    let events = journal;
    if (is_obj(journal)) {
      if (journal.format !== undefined) {
        const m = typeof journal.format === 'string' ? FORMAT_RE.exec(journal.format) : null;
        if (m === null) sink.err('E_SCHEMA', { field: 'format' }, 'bad_format');
        else if (Number(m[1]) > KNOWN_FORMAT_VERSION) { sink.err('E_SCHEMA', { field: 'format' }, 'newer_format'); read_only = true; return done(); }
      }
      events = journal.events;
    }
    if (!Array.isArray(events)) { sink.err('E_SCHEMA', { field: 'events' }, 'events_required'); return done(); }
    if (events.length > limits.max_events) { sink.err('E_SCHEMA', { field: 'events' }, 'too_many_events'); return done(); }
    stats.events = events.length;
    const st = { sink, limits, nodes: 0, field: null, node_over: false };
    const seen = new Set();
    const registry = DEFAULT_UPCAST_REGISTRY;
    events.forEach((e, i) => {
      const where = { kind: 'events', index: i, id: id_of(e, 'event_id') };
      if (!is_obj(e)) { sink.err('E_SCHEMA', where, 'record_not_object'); return; }
      if (typeof e.type !== 'string' || !EVENT_TYPES.includes(e.type)) sink.err('E_SCHEMA', { ...where, field: 'type' }, 'unknown_type');
      if (!is_int(e.v) || e.v < 1) sink.err('E_SCHEMA', { ...where, field: 'v' }, 'v_required');
      else if (typeof e.type === 'string' && Object.hasOwn(registry.current, e.type) && e.v > registry.current[e.type]) { sink.err('E_SCHEMA', { ...where, field: 'v' }, 'newer_version'); read_only = true; }
      if (typeof e.event_id !== 'string' || e.event_id === '' || e.event_id.length > limits.max_id) sink.err('E_SCHEMA', { ...where, field: 'event_id' }, 'id_required');
      else if (seen.has(e.event_id)) sink.err('E_SCHEMA', { ...where, field: 'event_id' }, 'duplicate_id');
      else seen.add(e.event_id);
      if (!is_int(e.seq)) sink.err('E_SCHEMA', { ...where, field: 'seq' }, 'seq_required');
      if (!instant_ok(e.recorded_at)) sink.err('E_BAD_DATE', { ...where, field: 'recorded_at' }, 'bad_instant');
      if (typeof e.actor !== 'string' || !ACTOR_RE.test(e.actor)) sink.err('E_SCHEMA', { ...where, field: 'actor' }, 'bad_actor');
      if (typeof e.entity_id !== 'string' || e.entity_id === '') sink.err('E_SCHEMA', { ...where, field: 'entity_id' }, 'entity_id_required');
      for (const f of ['supersedes_id', 'causation_id']) if (e[f] !== undefined && e[f] !== null && typeof e[f] !== 'string') sink.err('E_SCHEMA', { ...where, field: f }, 'not_string');
      if (!is_obj(e.payload)) sink.err('E_SCHEMA', { ...where, field: 'payload' }, 'payload_not_object');
      else scan_record(e.payload, { ...where, field: null }, st);
    });
    if (sink.errors.length > 0 || sink.truncated) return done();
    let state;
    try {
      state = reduce(effective_events(events));
    } catch (e) {
      sink.err(ERROR_CODES.includes(e?.code) ? e.code : 'E_SCHEMA', { kind: 'events' }, String(e?.ctx?.reason ?? 'reduce_failed'));
      return done();
    }
    const r = validate_ws(ws_from_state(state), opts);
    for (const e of r.errors) if (sink.errors.length < limits.max_errors) sink.errors.push({ ...e, kind: e.kind === null ? 'state' : 'state.' + e.kind, path: 'state.' + e.path });
    for (const w of r.warnings) sink.warn(w);
    if (r.truncated) sink.truncated = true;
  } catch (e) {
    sink.err('E_SCHEMA', { kind: null }, 'validator_internal:' + String(e?.name ?? 'Error') + ':' + String(e?.message ?? '').slice(0, 100));
  }
  return done();
}

// ── карантин ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const QUARANTINE_LISTS = new Set(LIST_ORDER);

/**
 * Режим карантина (Q-22): записи с ошибками исключаются из рабочей области, остальные считаются; ссылки на исключённое каскадно проверяются
 * повторно (до 6 проходов). Параметры вне диапазона заменяются значением по умолчанию (К-4) с предупреждением `W_PARAM_OUT_OF_RANGE`.
 * Ошибки уровня файла (не объект, формат, пределы, неверный `as_of`) исправить нельзя: `ws_clean = null`, `fatal` — список этих ошибок.
 * Исходная рабочая область не меняется (копии списков).
 * @param {object} ws
 * @param {{as_of?: string|number, limits?: Partial<typeof WS_LIMITS>}} [opts]
 * @returns {{ok: boolean, ws_clean: object|null, rejected: {kind: string, index: number|string, id: string|null, codes: string[], reasons: string[]}[],
 *   warnings: object[], fatal: object[]}}
 */
export function quarantine_invalid(ws, opts = {}) {
  const fatal = [];
  const rejected = [];
  const warnings = [];
  const max = { ...WS_LIMITS, ...(is_obj(opts?.limits) ? opts.limits : {}) }.max_records; // предел записей списка: длиннее — не разворачиваем (хвост FZ-1)
  if (!is_obj(ws)) return { ok: false, ws_clean: null, rejected, warnings, fatal: [{ code: 'E_SCHEMA', reason: 'workspace_not_object', path: '' }] };
  // параметры: допустимые остаются, прочие — по умолчанию
  const pc = check_params(ws.params);
  const work = { ...ws };
  if (ws.params !== undefined && ws.params !== null && is_obj(ws.params)) {
    work.params = pc.params;
    for (const w of pc.warnings) warnings.push(w);
  } else if (ws.params !== undefined && ws.params !== null) {
    work.params = {};
    warnings.push({ code: 'W_PARAM_OUT_OF_RANGE', key: 'params' });
  }
  for (const name of LIST_ORDER) {
    if (entries_of(pick(work, name), max) === null) rejected.push({ kind: name, index: null, id: null, codes: ['E_SCHEMA'], reasons: ['collection_not_array_or_object'] });
  }
  const dropped = new Map(); // kind → Set(index)
  for (let pass = 0; pass < 6; pass++) {
    const clean = apply_drops(work, dropped, max);
    const r = validate_ws(clean, opts);
    if (r.ok) return { ok: true, ws_clean: clean, rejected, warnings: [...warnings, ...rejected_warnings(rejected), ...r.warnings], fatal };
    let progressed = false;
    for (const e of r.errors) {
      if (e.kind !== null && QUARANTINE_LISTS.has(e.kind) && e.index !== null) {
        // индексы после apply_drops смещены: храним ключи исходных записей (см. apply_drops → tag)
        const orig = clean.__idx?.get(e.kind)?.[e.index] ?? e.index;
        if (!dropped.has(e.kind)) dropped.set(e.kind, new Set());
        if (!dropped.get(e.kind).has(orig)) {
          dropped.get(e.kind).add(orig);
          progressed = true;
        }
        record_rejection(rejected, e, orig);
      } else if (e.kind === 'params') {
        // уже заменено значениями по умолчанию
      } else if (e.kind === 'transfers') {
        // ноги перевода вне баланса: исключаются обе записи (по transfer_id)
        progressed = drop_transfer(work, dropped, e.id, rejected, max) || progressed;
      } else fatal.push(e);
    }
    if (fatal.length > 0) return { ok: false, ws_clean: null, rejected, warnings, fatal };
    if (!progressed) return { ok: false, ws_clean: null, rejected, warnings, fatal: r.errors.slice(0, 20) };
  }
  return { ok: false, ws_clean: null, rejected, warnings, fatal: [{ code: 'E_SCHEMA', reason: 'quarantine_did_not_converge', path: '' }] };
}

function record_rejection(rejected, e, orig) {
  const hit = rejected.find((r) => r.kind === e.kind && r.index === orig);
  if (hit === undefined) rejected.push({ kind: e.kind, index: orig, id: e.id, codes: [e.code], reasons: [e.reason] });
  else { if (!hit.codes.includes(e.code)) hit.codes.push(e.code); if (!hit.reasons.includes(e.reason)) hit.reasons.push(e.reason); }
}

function rejected_warnings(rejected) {
  return rejected.map((r) => ({ code: 'W_RECORD_QUARANTINED', kind: r.kind, id: r.id === null ? '' : r.id, rec_code: r.codes[0] }));
}

function drop_transfer(work, dropped, transfer_id, rejected, max = WS_LIMITS.max_records) {
  let any = false;
  for (const name of ['plans', 'facts']) {
    const all = entries_of(pick(work, name), max);
    const ents = all === null || all === TOO_LONG ? [] : all; // слишком длинный список не разворачивается: он отвергается целиком (too_many_records)
    for (const { key, rec } of ents) {
      if (is_obj(rec) && rec.transfer_id === transfer_id) {
        if (!dropped.has(name)) dropped.set(name, new Set());
        if (!dropped.get(name).has(key)) { dropped.get(name).add(key); any = true; }
        if (!rejected.some((r) => r.kind === name && r.index === key)) rejected.push({ kind: name, index: key, id: id_of(rec, 'event_id', 'plan_id', 'cash_event_id'), codes: ['E_SCHEMA'], reasons: ['transfer_legs_not_zero'] });
      }
    }
  }
  return any;
}

/** Копия рабочей области без исключённых записей; `__idx` (несчётное свойство-подсказка) — соответствие нового индекса исходному ключу. */
function apply_drops(work, dropped, max = WS_LIMITS.max_records) {
  const out = { ...work };
  const idx = new Map();
  for (const name of LIST_ORDER) {
    const raw = pick(work, name);
    const drop = dropped.get(name);
    const ents = entries_of(raw, max);
    if (ents === null) { // список не массив и не словарь — исключается целиком
      out[name] = [];
      continue;
    }
    if (ents === TOO_LONG) { // слишком длинный список не разворачивается и не копируется (хвост FZ-1): повторная проверка отвергнет его по too_many_records, как отвергала развёрнутый
      out[name] = raw;
      continue;
    }
    if (name === 'tax_rules') {
      const flat = flat_tax(ents.map((e) => e.rec), max);
      if (flat === TOO_LONG) { out[name] = raw; continue; }
      const kept = [];
      const map = [];
      flat.forEach((rec, i) => { if (!(drop?.has(i))) { kept.push(rec); map.push(i); } });
      out[name] = kept;
      idx.set(name, map);
      continue;
    }
    const kept = [];
    const map = [];
    for (const { key, rec } of ents) if (!(drop?.has(key))) { kept.push(rec); map.push(key); }
    out[name] = kept;
    idx.set(name, map);
  }
  delete out.planned_one_offs;
  delete out.fx;
  Object.defineProperty(out, '__idx', { value: idx, enumerable: false });
  return out;
}

// ── расчёт под защитой ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `analyze` с проверкой входа (REQ-158): всегда возвращает результат или код ошибки из набора REQ-017, исключения наружу не выходят.
 * Строгий режим (по умолчанию): рабочая область не прошла `validate_ws` — `{ok: false, code, errors}`. Карантин (`opts.quarantine = true`): невалидные
 * записи исключаются и перечисляются в `rejected`, расчёт идёт по остальным; предупреждения карантина добавляются к `analysis.warnings`.
 * Непредвиденное (не `RunwayError`) — `{ok: false, code: 'E_SCHEMA', internal: true}`: это дефект движка, а не ввода; тесты требуют 0 таких случаев.
 * @param {object} ws
 * @param {object} query как у `analyze`
 * @param {{quarantine?: boolean, limits?: Partial<typeof WS_LIMITS>}} [opts]
 * @returns {{ok: true, analysis: object, rejected: object[], warnings: object[]} | {ok: false, code: string, errors: object[], rejected?: object[], internal?: boolean}}
 */
export function analyze_checked(ws, query, opts = {}) {
  try {
    const as_of = query?.as_of;
    let target = ws;
    let rejected = [];
    let qwarn = [];
    if (opts?.quarantine === true) {
      const q = quarantine_invalid(ws, { as_of, limits: opts.limits });
      if (!q.ok) return { ok: false, code: q.fatal[0]?.code ?? 'E_SCHEMA', errors: q.fatal, rejected: q.rejected };
      target = q.ws_clean;
      rejected = q.rejected;
      qwarn = q.warnings;
    } else {
      const r = validate_ws(ws, { as_of, limits: opts?.limits });
      if (!r.ok) return { ok: false, code: r.errors[0].code, errors: r.errors };
    }
    const analysis = analyze(target, query);
    // служебные предупреждения проверки добавляются без дублей с теми, что уже дал расчёт
    const have = new Set(analysis.warnings.map((w) => JSON.stringify(w)));
    const extra = qwarn.filter((w) => !have.has(JSON.stringify(w)));
    return { ok: true, analysis, rejected, warnings: extra };
  } catch (e) {
    if (e?.name === 'RunwayError' && ERROR_CODES.includes(e.code)) return { ok: false, code: e.code, errors: [{ code: e.code, reason: String(e.ctx?.reason ?? 'engine_error'), path: '' }] };
    return { ok: false, code: 'E_SCHEMA', internal: true, errors: [{ code: 'E_SCHEMA', reason: 'internal:' + String(e?.name ?? 'Error'), path: '' }] };
  }
}

/** Значения параметров по умолчанию, зеркало `TIMELINE_DEFAULTS` (для тестов и подстановки в карантине). */
export function param_defaults() {
  return { ...TIMELINE_DEFAULTS };
}

/**
 * Быстрая проверка одной записи `params.set` (К-4): `E_SCHEMA` на нечисловом значении или значении вне диапазона. Для слоя записи (`ws_edit`).
 * @param {object} params
 * @returns {void}
 * @throws {RunwayError} E_SCHEMA
 */
export function assert_params(params) {
  const r = check_params(params);
  if (!r.ok) fail('E_SCHEMA', { reason: 'param_out_of_range', key: r.problems[0].key, why: r.problems[0].reason });
}
