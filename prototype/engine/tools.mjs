// tools.mjs — контракт инструментов ассистента и экранов: реестр TOOLS (10 инструментов), мини-валидатор схем, раннер, конверт Result
// с evidence и call_id, защита контекста от недоверенного текста (ALG-12, ADR-010, ADR-013).
// Канон: design-brief §5.1, D-21, §14 N6/N8/N10; C-008, C-009, C-015, C-017, C-018, C-054, C-063, C-064, C-067, C-074…C-079, C-097;
// canon-decisions «Финальные сигнатуры» (tools.mjs); wiki/algorithms/alg-12-llm-tool-contract-and-number-verifier.md.
// Зависимости (правило слоёв §14 B4): всё ниже `index` (читаем через `index.mjs`) и `ledger` (call_id, state_at). Модуль чистый:
// ни часов, ни случайности, ни ввода-вывода; время и идентификаторы — аргументы/порты `ctx`. Расчёт по введённым данным, не консультация.
//
// ── Контракт `ctx` раннера ───────────────────────────────────────────────────────────────────────────────────────────
// `ctx` = `Analysis` из `analyze()` (as_of, horizon_end, params, buffer_minor, events, series, reserve, readiness, anchor_status, rule_status,
// warnings, inputs_hash, engine_version) плюс поля раннера (их собирает `make_tool_ctx`):
//   tier, t1_enabled — уровень прав (T1 включает пользователь; по умолчанию выключен);
//   calls_used       — счётчик вызовов на вопрос (раннер увеличивает сам; предел `tools.max_calls`, 12);
//   locale           — 'ru' | 'en';
//   ws               — рабочая область (нужна `get_tax_envelope`, `run_scenario`, `propose_change`, сценариям и `what_changed`);
//   query            — запрос, которым построен `Analysis` (нужен для пересчёта со сценарием);
//   journal          — журнал `LedgerEvent[]` (нужен `what_changed`);
//   call_log         — `{ <hex call_id>: 'YYYY-MM-DD' }` — день записи вызова (порт для `since = c_<hex>`).
// Ряды (`series_handle`) и недоверенный текст (`note`, `tag`, описания) в `Result` не попадают.

import {
  fail, RunwayError, assert_minor, currency_exponent, sum_minor,
  parse_date, format_date, to_epoch_day, diff_days,
  normalize_ws, get_param, narrowest_point, runway_days, explain_narrowest,
  list_waves_ex, gate, max_amount, earliest_date, check_purchase, safe_to_spend, binding_events, argmin_first,
  next_release, rule_at,
  canon, sha256, state_at, effective_events, reduce,
  analyze,
} from './index.mjs';

/** @typedef {import('./money.mjs').Minor} Minor */
/** @typedef {import('./dates.mjs').EpochDay} EpochDay */
/**
 * Доказательство числа или даты в `Result` (D-21). `id` назначает `ResultBuilder` (e1, e2, …); у значения из `make_evidence` его ещё нет.
 * @typedef {object} Evidence
 * @property {string} [id]
 * @property {'money'|'date'|'pct_bp'|'days'|'count'|'enum'} kind
 * @property {number|string} v money — minor (целое), date — IsoDate, pct_bp — базисные пункты, days/count — целое ≥ 0, enum — значение словаря
 * @property {string} [cur] только money
 * @property {number} [dp] только money: число знаков при показе (0 ≤ dp ≤ exponent)
 * @property {string[]} event_ids уникальные, по возрастанию, SAFE_ID, ≤ 50
 */
/**
 * Конверт результата инструмента (D-21).
 * @typedef {object} Result
 * @property {string} call_id 8 hex-знаков
 * @property {string} tool
 * @property {string} engine_version
 * @property {string} inputs_hash
 * @property {string} as_of IsoDate
 * @property {{mode: 'plan'|'worse', scenario_id: string|null}} scope
 * @property {object} facts литералы, идентификаторы и ссылки «eN»; чисел-литералов нет
 * @property {Evidence[]} evidence
 * @property {{code: string}[]} warnings
 */
/**
 * Ошибка инструмента (возвращается, не бросается).
 * @typedef {object} ToolError
 * @property {true} isError
 * @property {string} code `E_SCHEMA`, `E_NOT_PERMITTED`, `E_CALL_LIMIT`, `E_UNKNOWN_TOOL`, `E_BAD_DATE`, … (§14 N8)
 * @property {string} [reason] короткий код причины (`not_permitted`, `call_limit`, `unknown_tool`, …); значений аргументов в нём нет
 * @property {{path: string, code: string}[]} [errors] ошибки схемы (без значений)
 */

// ── белые списки форм (assert_clean) ──────────────────────────────────────────────────────────────────────────────────

/** Идентификатор, допустимый в `Result`: латиница, цифры и `_ . : @ # -`, 1…80 знаков. */
export const SAFE_ID = /^[A-Za-z0-9_.:@#-]{1,80}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_RE = /^[WE]_[A-Z_]+$/;
const EVIDENCE_ID_RE = /^e\d+$/;
const KEY_RE = /^[A-Za-z0-9_.]{1,40}$/;

/** Виды evidence (D-21). */
export const EVIDENCE_KINDS = Object.freeze(['money', 'date', 'pct_bp', 'days', 'count', 'enum']);
/** Классы причин узкой точки: вместо `tag` и описаний (C-097). */
export const CAUSE_CLASSES = Object.freeze(['income_delay', 'tax_payment', 'sinking_payment', 'estimate', 'obligation', 'other']);
/** Значения словаря (§2.0), допустимые в `enum`-evidence и в `facts`. */
export const ENUM_VALUES = Object.freeze(new Set([
  'plan', 'worse', 'OK', 'TIGHT', 'FRAGILE', 'NO', 'posted', 'planned', 'hypothetical',
  'expected', 'matched', 'overdue', 'skipped', 'cancelled', 'A0', 'A1', 'A2', 'A3', 'T0', 'T1',
  ...CAUSE_CLASSES,
]));
/** Виды записей журнала для `what_changed`: префикс типа записи → `kind`. */
const CHANGE_KINDS = Object.freeze({
  tx: 'tx', anchor: 'anchor', plan: 'plan', rule: 'rule', stream: 'stream', taxrule: 'taxrule', reserve: 'reserve', fx: 'fx', params: 'params',
});

/** Безопасная форма идентификатора: идентификатор вне белого списка заменяется псевдонимом `id_<hash>` (детерминированно). */
export function safe_id(x) {
  const s = String(x);
  return SAFE_ID.test(s) ? s : 'id_' + sha256(s).slice(0, 12);
}

// ── схемы инструментов (ALG-12, N6) ───────────────────────────────────────────────────────────────────────────────────

const DEFS = Object.freeze({
  IsoDate: { type: 'string', format: 'date' },
  Minor: { type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 },
  Pos: { type: 'integer', minimum: 1, maximum: 9007199254740991 },
  Cur: { type: 'string', pattern: '^[A-Z]{3}$' },
  Mode: { enum: ['plan', 'worse'] },
  Id: { type: 'string', pattern: '^[A-Za-z0-9_.:@#-]{1,80}$' },
  Part: {
    type: 'object', additionalProperties: false, required: ['date', 'amount_minor'],
    properties: { date: { $ref: '#/$defs/IsoDate' }, amount_minor: { $ref: '#/$defs/Pos' } },
  },
});

const ref = (name) => ({ $ref: '#/$defs/' + name });
const obj = (properties, required = []) => ({ $defs: DEFS, type: 'object', additionalProperties: false, required, properties });

/** Схемы входов (самодостаточны: `$defs` внутри). `earliest_safe_date.horizon_days` удалён (N6): горизонт — свойство `ctx`. */
const SCHEMAS = Object.freeze({
  get_projection: obj({ from: ref('IsoDate'), to: ref('IsoDate'), mode: ref('Mode'), scenario: ref('Id') }, ['to']),
  check_purchase: obj({
    date: ref('IsoDate'), amount_minor: ref('Pos'), currency: ref('Cur'),
    parts: { type: 'array', maxItems: 24, items: ref('Part') }, buffer_minor: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
  }, ['date', 'amount_minor', 'currency']),
  max_purchase_amount: obj({ date: ref('IsoDate'), mode: ref('Mode') }, ['date']),
  earliest_safe_date: obj({ amount_minor: ref('Pos'), currency: ref('Cur'), not_before: ref('IsoDate'), mode: ref('Mode') }, ['amount_minor', 'currency']),
  list_waves: obj({ from: ref('IsoDate'), to: ref('IsoDate'), mode: ref('Mode') }, ['from', 'to']),
  explain_min_point: obj({ mode: ref('Mode'), scenario: ref('Id'), top_k: { type: 'integer', minimum: 1, maximum: 10 } }),
  run_scenario: obj({
    base: ref('Id'), mode: ref('Mode'),
    ops: {
      type: 'array', minItems: 1, maxItems: 10,
      items: {
        oneOf: [
          {
            type: 'object', additionalProperties: false, required: ['op', 'event_ref', 'days'],
            properties: { op: { const: 'delay_income' }, event_ref: ref('Id'), days: { type: 'integer', minimum: 1, maximum: 90 } },
          },
          {
            type: 'object', additionalProperties: false, required: ['op', 'date', 'amount_minor', 'currency'],
            properties: { op: { const: 'add_purchase' }, date: ref('IsoDate'), amount_minor: ref('Pos'), currency: ref('Cur') },
          },
        ],
      },
    },
  }, ['ops']),
  what_changed: obj({ since: { type: 'string', pattern: '^(\\d{4}-\\d{2}-\\d{2}|c_[0-9a-f]{8})$' } }, ['since']),
  get_tax_envelope: obj({ as_of: ref('IsoDate') }),
  propose_change: obj({
    note: { type: 'string', maxLength: 200 },
    ops: {
      type: 'array', minItems: 1, maxItems: 5,
      items: {
        oneOf: [
          { type: 'object', additionalProperties: false, required: ['op', 'ref', 'date'], properties: { op: { const: 'move_plan' }, ref: ref('Id'), date: ref('IsoDate') } },
          { type: 'object', additionalProperties: false, required: ['op', 'ref'], properties: { op: { const: 'skip_plan' }, ref: ref('Id') } },
          {
            type: 'object', additionalProperties: false, required: ['op', 'date', 'amount_minor', 'currency'],
            properties: { op: { const: 'add_plan' }, date: ref('IsoDate'), amount_minor: ref('Minor'), currency: ref('Cur') },
          },
        ],
      },
    },
  }, ['ops']),
});

// ── мини-валидатор схем ───────────────────────────────────────────────────────────────────────────────────────────────

function is_plain_object(x) {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false;
  const p = Object.getPrototypeOf(x);
  return p === Object.prototype || p === null;
}

function resolve_ref(root, r) {
  if (typeof r !== 'string' || !r.startsWith('#/$defs/')) fail('E_SCHEMA', { reason: 'bad_schema_ref' });
  const s = root?.$defs?.[r.slice('#/$defs/'.length)];
  if (s === undefined) fail('E_SCHEMA', { reason: 'unknown_schema_ref' });
  return s;
}

function is_calendar_date(s) {
  if (typeof s !== 'string' || !ISO_DATE_RE.test(s)) return false;
  try {
    return format_date(parse_date(s)) === s;
  } catch {
    return false;
  }
}

/**
 * Мини-валидатор JSON-схем без зависимостей (ALG-12): `type` (object, array, string, integer, boolean), `enum`, `const`, `pattern`,
 * `format: date` (календарная проверка: 2026-02-30 — ошибка), `minimum`, `maximum`, `maxLength`, `minItems`, `maxItems`, `required`,
 * `properties`, `additionalProperties: false`, `items`, `oneOf` (ветка выбирается по const-полю `op`), `$ref` (на `$defs` корня).
 * Тип `integer` — только `Number.isSafeInteger` (дроби и строки с цифрами — ошибка). Значения аргументов в ошибки НЕ попадают:
 * `errors = [{path, code}]`, лишние ключи — под путём `….<unknown>` (имя ключа — недоверенный текст).
 * @param {object} schema
 * @param {any} args
 * @param {string} [path]
 * @param {object} [root] корень для `$ref` (по умолчанию — `schema`)
 * @returns {{ok: boolean, errors: {path: string, code: string}[]}}
 */
export function validate_args(schema, args, path = '$', root = schema) {
  const errors = [];
  const push = (p, code) => errors.push({ path: p, code });
  const walk = (s0, x, p) => {
    const s = s0.$ref !== undefined ? resolve_ref(root, s0.$ref) : s0;
    if (s.oneOf !== undefined) {
      if (!is_plain_object(x)) { push(p, 'type'); return; }
      const branch = s.oneOf.filter((b) => b.properties?.op?.const !== undefined && b.properties.op.const === x.op);
      if (branch.length !== 1) { push(p + '.op', 'oneOf'); return; }
      walk(branch[0], x, p);
      return;
    }
    if (s.const !== undefined) { if (x !== s.const) push(p, 'const'); return; }
    if (s.enum !== undefined && s.type === undefined) { if (!s.enum.includes(x)) push(p, 'enum'); return; }
    switch (s.type) {
      case 'object': {
        if (!is_plain_object(x)) { push(p, 'type'); return; }
        for (const k of s.required ?? []) if (!Object.hasOwn(x, k) || x[k] === undefined) push(p + '.' + k, 'required');
        for (const k of Object.keys(x)) {
          if (s.properties !== undefined && Object.hasOwn(s.properties, k)) {
            if (x[k] !== undefined) walk(s.properties[k], x[k], p + '.' + k);
          } else if (s.additionalProperties === false) push(p + '.<unknown>', 'additional');
        }
        return;
      }
      case 'array': {
        if (!Array.isArray(x)) { push(p, 'type'); return; }
        if (s.minItems !== undefined && x.length < s.minItems) push(p, 'minItems');
        if (s.maxItems !== undefined && x.length > s.maxItems) push(p, 'maxItems');
        if (s.items !== undefined) x.forEach((v, i) => walk(s.items, v, p + '[' + i + ']'));
        return;
      }
      case 'string': {
        if (typeof x !== 'string') { push(p, 'type'); return; }
        if (s.maxLength !== undefined && x.length > s.maxLength) push(p, 'maxLength');
        if (s.pattern !== undefined && !new RegExp(s.pattern).test(x)) push(p, 'pattern');
        if (s.format === 'date' && !is_calendar_date(x)) push(p, 'format');
        if (s.enum !== undefined && !s.enum.includes(x)) push(p, 'enum');
        return;
      }
      case 'integer': {
        if (typeof x !== 'number' || !Number.isSafeInteger(x)) { push(p, 'type'); return; }
        if (s.minimum !== undefined && x < s.minimum) push(p, 'minimum');
        if (s.maximum !== undefined && x > s.maximum) push(p, 'maximum');
        return;
      }
      case 'boolean': {
        if (typeof x !== 'boolean') push(p, 'type');
        return;
      }
      default:
        fail('E_SCHEMA', { reason: 'unsupported_schema' });
    }
  };
  walk(schema, args, path);
  return { ok: errors.length === 0, errors };
}

/** Запись ключа словаря как собственного свойства (ключ «__proto__» не меняет прототип словаря; Q-07). */
function own_set(dict, key, value) {
  if (key === '__proto__') Object.defineProperty(dict, key, { value, writable: true, enumerable: true, configurable: true });
  else dict[key] = value;
}

/**
 * Нормализация аргументов до проверки схемы: псевдоним режима `conservative` = `worse` (C3). Вход не мутируется; значения по умолчанию
 * НЕ подставляются (иначе меняется `canon(args)` и `call_id`). Не объект — возвращается как есть (его отвергнет валидатор).
 * @param {any} args
 * @returns {any}
 */
export function normalize_args(args) {
  if (!is_plain_object(args)) return args;
  const out = {};
  for (const k of Object.keys(args)) {
    if (args[k] === undefined) continue;
    // «__proto__» (собственный ключ из JSON.parse) должен остаться ключом, а не сменить прототип out: иначе лишний аргумент молча пропадает
    // и additionalProperties:false не срабатывает
    if (k === '__proto__') Object.defineProperty(out, k, { value: args[k], writable: true, enumerable: true, configurable: true });
    else out[k] = args[k];
  }
  if (out.mode === 'conservative') out.mode = 'worse';
  return out;
}

// ── evidence ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const EVIDENCE_OBJECTS = new WeakSet();

function norm_event_ids(ids) {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids)) fail('E_SCHEMA', { reason: 'event_ids_not_array' });
  const u = [...new Set(ids.map((x) => safe_id(x)))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return u.slice(0, 50);
}

/**
 * Доказательство для значения факта (без `id`: его назначает построитель результата).
 * money — `assert_minor`, `cur` из реестра, `dp` (по умолчанию — `currency_exponent`, допустимо `0 ≤ dp ≤ exponent`);
 * date — календарно верная IsoDate (или EpochDay); pct_bp — целое; days, count — целое ≥ 0; enum — значение словаря;
 * `event_ids` — уникальные, по возрастанию, SAFE_ID, ≤ 50.
 * @param {'money'|'date'|'pct_bp'|'days'|'count'|'enum'} kind
 * @param {number|string} v
 * @param {{cur?: string, dp?: number, event_ids?: string[]}} [opts]
 * @returns {Evidence}
 * @throws {RunwayError} E_SCHEMA, E_NOT_INTEGER, E_OVERFLOW, E_BAD_DATE
 */
export function make_evidence(kind, v, opts = {}) {
  if (!EVIDENCE_KINDS.includes(kind)) fail('E_SCHEMA', { reason: 'bad_evidence_kind' });
  const o = opts ?? {};
  const ev = { kind };
  switch (kind) {
    case 'money': {
      ev.v = assert_minor(v);
      const exp = currency_exponent(o.cur);
      const dp = o.dp === undefined || o.dp === null ? exp : o.dp;
      if (!Number.isInteger(dp) || dp < 0 || dp > exp) fail('E_SCHEMA', { reason: 'bad_dp', dp: String(dp) });
      ev.cur = o.cur;
      ev.dp = dp;
      break;
    }
    case 'date': {
      const iso = typeof v === 'number' ? format_date(to_epoch_day(v)) : v;
      if (!is_calendar_date(iso)) fail('E_BAD_DATE', { reason: 'evidence_date' });
      ev.v = iso;
      break;
    }
    case 'pct_bp':
      ev.v = assert_minor(v);
      break;
    case 'days':
    case 'count': {
      ev.v = assert_minor(v);
      if (ev.v < 0) fail('E_SCHEMA', { reason: 'negative_' + kind });
      break;
    }
    case 'enum':
      if (typeof v !== 'string' || !ENUM_VALUES.has(v)) fail('E_SCHEMA', { reason: 'enum_not_in_vocab' });
      ev.v = v;
      break;
    default:
      break;
  }
  ev.event_ids = norm_event_ids(o.event_ids);
  EVIDENCE_OBJECTS.add(ev);
  return Object.freeze(ev);
}

/** `true`, если значение создано `make_evidence` (ещё без `id`). */
function is_evidence_value(x) {
  return x !== null && typeof x === 'object' && EVIDENCE_OBJECTS.has(x);
}

// ── call_id ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `call_id = hex(sha256(tool + "|" + canon(args) + "|" + inputs_hash))[0:8]` (D-21; 8 hex-знаков). В интерфейсе и в аргументе `since` — `c_` + hex.
 * @param {string} tool
 * @param {object} args проверенные нормализованные аргументы
 * @param {string} inputs_hash 64 hex-знака
 * @returns {string}
 */
export function call_id(tool, args, inputs_hash) {
  return sha256(tool + '|' + canon(args) + '|' + inputs_hash).slice(0, 8);
}

/** Вид идентификатора вызова для интерфейса и аргумента `since`: `c_` + hex. */
export function call_ref(id) {
  return 'c_' + id;
}

// ── построитель Result ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Построитель результата: обходит `raw.facts`, заменяет значения `make_evidence` ссылками «eN» в порядке первого появления;
 * одинаковые `(kind, v, cur, dp, event_ids)` получают один id. Чисел-литералов в facts нет (`E_SCHEMA`).
 */
class ResultBuilder {
  constructor() {
    this.list = [];
    this.index = new Map();
  }

  register(ev) {
    const key = canon({ kind: ev.kind, v: ev.v, cur: ev.cur, dp: ev.dp, event_ids: ev.event_ids });
    let id = this.index.get(key);
    if (id === undefined) {
      id = 'e' + (this.list.length + 1);
      this.index.set(key, id);
      const e = { id, kind: ev.kind, v: ev.v };
      if (ev.cur !== undefined) e.cur = ev.cur;
      if (ev.dp !== undefined) e.dp = ev.dp;
      e.event_ids = [...ev.event_ids];
      this.list.push(e);
    }
    return id;
  }

  /** Заранее закрепить первые id: пути в `facts` в заданном порядке (для `check_purchase` — e1…e9, §9.14). */
  pre_register(facts, paths) {
    for (const p of paths ?? []) {
      let cur = facts;
      for (const part of p.split('.')) cur = cur === null || typeof cur !== 'object' ? undefined : cur[part];
      if (is_evidence_value(cur)) this.register(cur);
    }
  }

  walk(x, path = 'facts') {
    if (is_evidence_value(x)) return this.register(x);
    if (x === null || x === undefined) return null;
    if (typeof x === 'boolean' || typeof x === 'string') return x;
    if (typeof x === 'number') return fail('E_SCHEMA', { reason: 'number_literal_in_facts', path });
    if (Array.isArray(x)) return x.map((v, i) => this.walk(v, path + '[' + i + ']'));
    if (typeof x === 'object') {
      const out = {};
      for (const k of Object.keys(x)) own_set(out, k, this.walk(x[k], path + '.' + k)); // «__proto__» — ключ данных, а не прототип (Q-07)
      return out;
    }
    return fail('E_SCHEMA', { reason: 'type_not_allowed_in_facts', path });
  }
}

/**
 * Режимы, при которых число `id` лежит в `facts` (по именам ключей `plan`/`worse` на пути к ссылке). Пустое множество —
 * число не зависит от режима (используется верификатором: V_SCOPE).
 * @param {Result} r
 * @param {string} id
 * @returns {Set<string>}
 */
export function modes_of(r, id) {
  const found = new Set();
  const walk = (x, modes) => {
    if (x === id) { for (const m of modes) found.add(m); return; }
    if (Array.isArray(x)) { for (const v of x) walk(v, modes); return; }
    if (x !== null && typeof x === 'object') {
      for (const k of Object.keys(x)) walk(x[k], k === 'plan' || k === 'worse' ? [...modes, k] : modes);
    }
  };
  walk(r.facts, []);
  return found;
}

/**
 * Пути в `facts`, под которыми лежит ссылка `id` (для проверки «дефицита»: V_SHORTAGE).
 * @param {Result} r
 * @param {string} id
 * @returns {string[]}
 */
export function paths_of(r, id) {
  const out = [];
  const walk = (x, p) => {
    if (x === id) { out.push(p); return; }
    if (Array.isArray(x)) { x.forEach((v, i) => walk(v, p + '.' + i)); return; }
    if (x !== null && typeof x === 'object') for (const k of Object.keys(x)) walk(x[k], p === '' ? k : p + '.' + k);
  };
  walk(r.facts, '');
  return out;
}

// ── защита контекста ──────────────────────────────────────────────────────────────────────────────────────────────────

function is_clean_string(s, in_facts) {
  if (in_facts && ISO_DATE_RE.test(s)) return false; // дата-литерал в facts — только через evidence
  return ENUM_VALUES.has(s) || EVIDENCE_ID_RE.test(s) || SAFE_ID.test(s) || ISO_DATE_RE.test(s) || CODE_RE.test(s);
}

/**
 * Белый список форм (не чёрный список слов): каждая строка и каждый ключ в `Result` — значение словаря, `cause_class`, id evidence,
 * SAFE_ID, ISO-дата или код `^[WE]_[A-Z_]+$`; в `facts` нет чисел-литералов и дат-литералов (только ссылки на evidence).
 * Иначе — `E_UNTRUSTED_LEAK` (текст строки в ошибку не попадает, ADR-013).
 * @param {Result} r
 * @returns {Result} тот же объект
 * @throws {RunwayError} E_UNTRUSTED_LEAK, E_SCHEMA (число-литерал в facts), E_NOT_INTEGER
 */
export function assert_clean(r) {
  const walk = (x, path, in_facts) => {
    if (x === null || typeof x === 'boolean') return;
    if (typeof x === 'number') {
      if (in_facts) fail('E_SCHEMA', { reason: 'number_literal_in_facts', path });
      if (!Number.isSafeInteger(x)) fail('E_NOT_INTEGER', { reason: 'float_in_result', path });
      return;
    }
    if (typeof x === 'string') {
      if (!is_clean_string(x, in_facts)) fail('E_UNTRUSTED_LEAK', { reason: 'string_not_whitelisted', path });
      return;
    }
    if (Array.isArray(x)) { x.forEach((v, i) => walk(v, path + '[' + i + ']', in_facts)); return; }
    if (typeof x === 'object') {
      for (const k of Object.keys(x)) {
        if (!KEY_RE.test(k)) fail('E_UNTRUSTED_LEAK', { reason: 'key_not_whitelisted', path });
        walk(x[k], path + '.' + k, in_facts || (path === 'result' && k === 'facts'));
      }
      return;
    }
    fail('E_UNTRUSTED_LEAK', { reason: 'type_not_allowed', path });
  };
  walk(r, 'result', false);
  return r;
}

/**
 * Класс причины события вместо `tag`/описаний (поля `note`/`tag`/`desc` НЕ читаются): доход, сдвинутый в `worse` → `income_delay`;
 * платёж, привязанный к резерву: налоговый → `tax_payment`, накопительный → `sinking_payment`; оценка → `estimate`; обязательство →
 * `obligation`; иначе `other`. Вид резерва — из `opts.reserve_kinds` (`{reserve_id: kind}`), иначе из `e.reserve_kind`.
 * @param {object} e CashEvent
 * @param {{as_of?: EpochDay|string, reserve_kinds?: Object<string, string>}} [opts]
 * @returns {'income_delay'|'tax_payment'|'sinking_payment'|'estimate'|'obligation'|'other'}
 */
export function cause_class_of(e, opts = {}) {
  if (e.amount_minor > 0 && e.plan_date !== undefined && e.plan_date !== null) {
    const base = opts.as_of === undefined ? e.plan_date : Math.max(e.plan_date, to_epoch_day(opts.as_of));
    if (e.date > base) return 'income_delay';
  }
  if (e.reserve_id !== undefined && e.reserve_id !== null) {
    const kind = opts.reserve_kinds?.[e.reserve_id] ?? e.reserve_kind;
    if (kind === 'tax') return 'tax_payment';
    if (kind === 'sinking') return 'sinking_payment';
  }
  if (e.is_estimate === true) return 'estimate';
  if (e.is_obligation === true) return 'obligation';
  return 'other';
}

// ── эхо вопроса ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Эхо (D-21): числа и даты из ПРОВЕРЕННЫХ аргументов вызовов и параметры (`worse.income_delay_days`); текст вопроса не разбирается.
 * Идентификаторы: `q.amount` (`amount_minor`), `q.buffer` (`buffer_minor`), `q.date`, `q.from`, `q.to`, `q.not_before`, `q.as_of`, `q.since`
 * (даты по имени аргумента), `q.days` (параметр `worse.income_delay_days`). Для `parts`: `q.part1_date`, `q.part1_amount`, … .
 * @param {{name: string, args: object}[]} calls
 * @param {object} params
 * @param {string} [currency] валюта решения (для сумм без своей валюты)
 * @returns {Evidence[]} с полем `id`
 */
export function build_echo(calls, params, currency) {
  const out = new Map();
  const put = (id, ev) => { if (!out.has(id)) out.set(id, { id, ...ev }); };
  for (const c of calls ?? []) {
    const a = c?.args ?? {};
    const cur = typeof a.currency === 'string' ? a.currency : currency;
    if (Number.isSafeInteger(a.amount_minor) && cur !== undefined) put('q.amount', make_evidence('money', a.amount_minor, { cur }));
    if (Number.isSafeInteger(a.buffer_minor) && cur !== undefined) put('q.buffer', make_evidence('money', a.buffer_minor, { cur }));
    for (const k of ['date', 'from', 'to', 'not_before', 'as_of']) if (typeof a[k] === 'string' && is_calendar_date(a[k])) put('q.' + k, make_evidence('date', a[k]));
    if (typeof a.since === 'string' && is_calendar_date(a.since)) put('q.since', make_evidence('date', a.since));
    if (Array.isArray(a.parts)) {
      a.parts.forEach((p, i) => {
        if (is_calendar_date(p?.date)) put('q.part' + (i + 1) + '_date', make_evidence('date', p.date));
        if (Number.isSafeInteger(p?.amount_minor) && cur !== undefined) put('q.part' + (i + 1) + '_amount', make_evidence('money', p.amount_minor, { cur }));
      });
    }
  }
  const delay = get_param(params, 'worse.income_delay_days');
  if (Number.isSafeInteger(delay) && delay >= 0) put('q.days', make_evidence('days', delay));
  return [...out.values()];
}

// ── помощники инструментов ────────────────────────────────────────────────────────────────────────────────────────────

/** Фабрики evidence в валюте решения. */
function evs(ctx) {
  const cur = ctx.decision_currency;
  return {
    money: (v, ids) => make_evidence('money', v, { cur, event_ids: ids }),
    date: (d, ids) => make_evidence('date', typeof d === 'string' ? d : format_date(d), { event_ids: ids }),
    days: (n) => make_evidence('days', n),
    count: (n, ids) => make_evidence('count', n, { event_ids: ids }),
    pct: (bp, ids) => make_evidence('pct_bp', bp, { event_ids: ids }),
  };
}

const nul = (v, f) => (v === null || v === undefined ? null : f(v));

/** Режим вызова: аргумент, иначе `headline_mode` (у `run_scenario` — `plan`, C-075). */
function mode_of(name, a, ctx) {
  if (a.mode !== undefined) return a.mode;
  if (name === 'run_scenario') return 'plan';
  const h = get_param(ctx.params, 'headline_mode');
  return h === 'plan' ? 'plan' : 'worse';
}

function need_mode(ctx, m) {
  if (ctx?.series?.[m] === undefined) fail('E_SCHEMA', { reason: 'mode_not_in_ctx', mode: m });
}

/** Запрос, которым построен `ctx` (для пересчёта со сценарием). */
function query_of(ctx, extra = {}) {
  const q = { ...(ctx.query ?? {}) };
  delete q.scenario;
  delete q.scenario_id;
  delete q.D;
  q.as_of = ctx.as_of;
  q.horizon_end = ctx.horizon_end;
  delete q.horizon_days;
  if (ctx.buffer_minor !== null && ctx.buffer_minor !== undefined) q.buffer_minor = ctx.buffer_minor;
  else delete q.buffer_minor;
  q.modes = Object.keys(ctx.series);
  return { ...q, ...extra };
}

/** Контекст со сценарием: сохранённый сценарий пересчитывается из рабочей области (`ctx.ws`). */
function ctx_for(ctx, scenario_id) {
  if (scenario_id === undefined || scenario_id === null) return ctx;
  if (ctx.ws === undefined || ctx.ws === null) fail('E_SCHEMA', { reason: 'ws_required_for_scenario' });
  return { ...analyze(ctx.ws, query_of(ctx, { scenario_id })), ws: ctx.ws, query: ctx.query, journal: ctx.journal, call_log: ctx.call_log };
}

function need_ws(ctx) {
  if (ctx.ws === undefined || ctx.ws === null) fail('E_SCHEMA', { reason: 'ws_required' });
  return normalize_ws(ctx.ws);
}

function clean_warnings(list) {
  const seen = new Map();
  for (const w of list ?? []) {
    if (typeof w?.code !== 'string' || !CODE_RE.test(w.code)) continue;
    const o = { code: w.code };
    for (const k of ['rule_id', 'reserve_id', 'wave_id', 'tax_rule_id']) if (typeof w[k] === 'string') o[k] = safe_id(w[k]);
    seen.set(canon(o), o);
  }
  return [...seen.entries()].sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0)).map((p) => p[1]);
}

function gate_facts(g) {
  return { reason: g.reason, reasons: [...g.reasons] };
}

/** Преобразовать ответ `afford` в «объединение» фактов для инструментов без своих чисел. */
function days_between(ctx, d) {
  return diff_days(ctx.as_of, d);
}

// ── инструменты ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Порядок первых evidence `check_purchase` — design-brief §9.14 (e1…e9). */
export const CHECK_PURCHASE_ORDER = Object.freeze([
  'by_mode.plan.m_after', 'by_mode.plan.at', 'by_mode.worse.m_after', 'by_mode.worse.at', 'buffer_minor',
  'by_mode.worse.margin', 's_max.worse', 'earliest.worse', 'days_to_min.worse',
]);

function run_get_projection(a, ctx) {
  const m = mode_of('get_projection', a, ctx);
  const c = ctx_for(ctx, a.scenario);
  need_mode(c, m);
  const E = evs(c);
  const warnings = [...c.warnings];
  const to = parse_date(a.to);
  if (to < c.as_of) fail('E_BAD_DATE', { reason: 'to_before_as_of' });
  if (to > c.horizon_end) return { facts: { kind: 'outside_horizon', horizon_end: E.date(c.horizon_end) }, warnings };
  let from = a.from === undefined ? c.as_of : parse_date(a.from);
  if (from > to) fail('E_BAD_DATE', { reason: 'from_after_to' });
  if (from < c.as_of) { warnings.push({ code: 'W_DATE_CLAMPED' }); from = c.as_of; }
  const s = c.series[m];
  const i0 = from - c.as_of;
  const i1 = to - c.as_of;
  const mp = narrowest_point(s, from, to);
  let first_breach = null;
  for (let i = i0; i <= i1; i++) if (s.trough[i] < 0) { first_breach = c.as_of + i; break; }
  const rw = runway_days(s, c.events[m]);
  const g = gate(c, c.buffer_minor);
  const facts = {
    kind: 'ok',
    to: E.date(to),
    end_close: E.money(s.close[i1]),
    min: { amount_minor: E.money(mp.amount_minor), date: E.date(mp.date) },
    first_breach: nul(first_breach, E.date),
    runway_with_days: nul(rw.with, (x) => E.days(x.days)),
    runway_without_days: nul(rw.without, (x) => E.days(x.days)),
    series_handle: 'ser:' + c.inputs_hash.slice(0, 8) + ':' + m,
    buffer_minor: nul(c.buffer_minor, E.money),
    min_free: null,
    sts_minor: null,
    short_to_buffer_minor: null,
    gate: null,
  };
  if (g === null) {
    const sts = safe_to_spend(c, to, c.buffer_minor, m);
    facts.min_free = { amount_minor: E.money(sts.min_free), date: E.date(sts.at) };
    facts.sts_minor = E.money(sts.sts);
    facts.short_to_buffer_minor = E.money(sts.short_to_buffer);
  } else facts.gate = gate_facts(g);
  return { facts, warnings };
}

function run_check_purchase(a, ctx) {
  const E = evs(ctx);
  const purchase = { currency: a.currency, parts: a.parts ?? [{ date: a.date, amount_minor: a.amount_minor }] };
  const raw = check_purchase(ctx, purchase, a.buffer_minor ?? null);
  const warnings = [...ctx.warnings];
  if (raw.kind === 'insufficient_data') return { facts: { kind: 'insufficient_data', ...gate_facts(raw) }, warnings };
  if (raw.kind === 'outside_horizon') return { facts: { kind: 'outside_horizon', horizon_end: E.date(raw.horizon_end) }, warnings };
  warnings.push(...raw.warnings);
  const by_mode = {};
  const days_to_min = {};
  for (const m of ['plan', 'worse']) {
    const x = raw.by_mode[m];
    by_mode[m] = { m_after: E.money(x.m_after), at: E.date(x.at), margin: E.money(x.margin), delta: E.money(x.delta), cash_gap: x.cash_gap };
    days_to_min[m] = E.days(days_between(ctx, x.at));
  }
  const pair = (o, f) => (o === null ? null : { plan: nul(o.plan, f), worse: nul(o.worse, f) });
  const facts = {
    kind: 'ok',
    verdict: raw.verdict,
    by_mode,
    buffer_minor: E.money(raw.buffer_minor),
    s_max: pair(raw.s_max, E.money),
    earliest: pair(raw.earliest, E.date),
    days_to_min,
    flags: { ...raw.flags },
    culprit_event_ids: raw.culprit_event_ids.map(safe_id),
    beyond_horizon_minor: E.money(raw.beyond_horizon_minor),
  };
  return { facts, warnings, order: CHECK_PURCHASE_ORDER };
}

/** Индекс минимума `free` на суффиксе `[idx(from), N−1]` — «узкая» точка, ограничивающая сумму. */
function suffix_argmin(ctx, m, from) {
  const f = ctx.series[m].free;
  const lo = Math.max(0, Math.max(from, ctx.as_of) - ctx.as_of);
  return argmin_first(f, lo, f.length - 1);
}

function binding_of(ctx, m, from) {
  const j = suffix_argmin(ctx, m, from);
  const ids = binding_events(ctx, m, ctx.series[m].free, j);
  return ids.length === 0 ? null : safe_id(ids[0]);
}

function run_max_purchase_amount(a, ctx) {
  const m = mode_of('max_purchase_amount', a, ctx);
  need_mode(ctx, m);
  const E = evs(ctx);
  const g = gate(ctx, ctx.buffer_minor);
  const warnings = [...ctx.warnings];
  if (g !== null) return { facts: { kind: 'insufficient_data', ...gate_facts(g) }, warnings };
  const D = parse_date(a.date);
  if (D > ctx.horizon_end) return { facts: { kind: 'outside_horizon', horizon_end: E.date(ctx.horizon_end) }, warnings };
  const B = ctx.buffer_minor;
  const s_max = {};
  for (const mm of ['plan', 'worse']) s_max[mm] = nul(max_amount(ctx, D, B, mm), E.money);
  return {
    facts: { kind: 'ok', date: E.date(D), s_max, buffer_minor: E.money(B), binding_event_id: binding_of(ctx, m, D) },
    warnings,
  };
}

function run_earliest_safe_date(a, ctx) {
  const m = mode_of('earliest_safe_date', a, ctx);
  need_mode(ctx, m);
  const E = evs(ctx);
  const g = gate(ctx, ctx.buffer_minor);
  const warnings = [...ctx.warnings];
  if (a.currency !== ctx.decision_currency) fail('E_CURRENCY_MISMATCH', { reason: 'currency_not_decision_currency' });
  if (g !== null) return { facts: { kind: 'insufficient_data', ...gate_facts(g) }, warnings };
  const nb = a.not_before === undefined ? ctx.as_of : parse_date(a.not_before);
  const B = ctx.buffer_minor;
  const date_or_null = {};
  for (const mm of ['plan', 'worse']) date_or_null[mm] = nul(earliest_date(ctx, a.amount_minor, nb, B, mm), E.date);
  return {
    facts: { kind: 'ok', amount: E.money(a.amount_minor), date_or_null, buffer_minor: E.money(B), binding_event_id: binding_of(ctx, m, nb) },
    warnings,
  };
}

function run_list_waves(a, ctx) {
  const m = mode_of('list_waves', a, ctx);
  need_mode(ctx, m);
  const E = evs(ctx);
  const from = parse_date(a.from);
  const to = parse_date(a.to);
  if (from > to) fail('E_BAD_DATE', { reason: 'from_after_to' });
  const { items, warnings } = list_waves_ex(ctx, m);
  const sel = items.filter((x) => x.wave.end >= from && x.wave.start <= to);
  const waves = sel.map(({ wave, metrics }) => {
    const ids = wave.event_ids;
    return {
      id: safe_id(wave.wave_id),
      start: E.date(wave.start, ids),
      end: E.date(wave.end, ids),
      need: E.money(metrics.need_minor, ids),
      cash: E.money(metrics.cash_minor, ids),
      gap: E.money(metrics.gap_minor, ids),
      coverage_pm: E.pct(metrics.coverage_pm * 10, ids),
      reserved: E.money(metrics.reserved_minor, ids),
      event_ids: ids.map(safe_id),
    };
  });
  return { facts: { kind: 'ok', from: E.date(from), to: E.date(to), waves_count: E.count(waves.length), waves }, warnings: [...ctx.warnings, ...warnings] };
}

/** Идентификатор группы цепочки без `tag`: `rule_id` / `stream_id` / `cash_event_id` (C-097). */
function group_id_of(group, event_ids, events) {
  const by_id = new Map(events.map((e) => [e.cash_event_id, e]));
  const first = by_id.get(event_ids[0]);
  if (!group.startsWith('tag:')) return group;
  return first === undefined ? event_ids[0] : first.cash_event_id;
}

function run_explain_min_point(a, ctx) {
  const m = mode_of('explain_min_point', a, ctx);
  const c = ctx_for(ctx, a.scenario);
  need_mode(c, m);
  const E = evs(c);
  const w = c.ws === undefined || c.ws === null ? null : normalize_ws(c.ws);
  const reserve_kinds = {};
  for (const r of w?.reserves ?? []) own_set(reserve_kinds, r.reserve_id, r.kind);
  const params = { ...c.params };
  if (a.top_k !== undefined) params['explain.top_k'] = a.top_k;
  const ex = explain_narrowest(c.events[m], c.series[m], params);
  const events = c.events[m];
  const by_id = new Map(events.map((e) => [e.cash_event_id, e]));
  const group_ids = new Map();
  const chain = ex.chain.map((g) => {
    const id = group_id_of(g.group, g.event_ids, events);
    group_ids.set(g.group, id);
    const first = by_id.get(g.event_ids[0]);
    return {
      group: safe_id(id),
      cause_class: first === undefined ? 'other' : cause_class_of(first, { as_of: c.as_of, reserve_kinds }),
      amount: E.money(g.amount_minor, g.event_ids),
      share_bp: E.pct(g.share_bp, g.event_ids),
    };
  });
  const counterfactuals = ex.counterfactuals.map((x) => ({
    kind: x.kind,
    without: safe_id(x.kind === 'without' ? group_ids.get(x.group) ?? x.group : x.event_id),
    new_min: { amount_minor: E.money(x.new_min.amount_minor), date: E.date(x.new_min.date) },
  }));
  return {
    facts: { kind: 'ok', point: { amount_minor: E.money(ex.point.amount_minor), date: E.date(ex.point.date) }, chain, counterfactuals },
    warnings: [...c.warnings],
  };
}

function run_run_scenario(a, ctx) {
  const m = mode_of('run_scenario', a, ctx);
  need_mode(ctx, m);
  if (ctx.ws === undefined || ctx.ws === null) fail('E_SCHEMA', { reason: 'ws_required' });
  const E = evs(ctx);
  const w = normalize_ws(ctx.ws);
  let base_ops = [];
  if (a.base !== undefined) {
    const sc = w.scenarios.find((s) => s.scenario_id === a.base);
    if (sc === undefined) fail('E_SCHEMA', { reason: 'scenario_not_found' });
    base_ops = sc.ops ?? [];
  }
  const q = query_of(ctx, { modes: [m] });
  const base_ctx = analyze(ctx.ws, a.base === undefined ? q : { ...q, scenario_id: a.base });
  const scn_ctx = analyze(ctx.ws, { ...q, scenario: { ops: [...base_ops, ...a.ops.map((o) => ({ ...o }))] } });
  const b = narrowest_point(base_ctx.series[m], base_ctx.as_of, base_ctx.horizon_end);
  const s = narrowest_point(scn_ctx.series[m], scn_ctx.as_of, scn_ctx.horizon_end);
  const scenario_ref = 'scn_' + sha256(canon({ base: a.base ?? null, mode: m, ops: a.ops })).slice(0, 8);
  return {
    facts: {
      kind: 'ok', scenario_ref, delta_min: E.money(s.amount_minor - b.amount_minor), min_date: E.date(s.date),
      min_minor: E.money(s.amount_minor), base_min_minor: E.money(b.amount_minor),
    },
    warnings: [...ctx.warnings, ...scn_ctx.warnings],
  };
}

function run_what_changed(a, ctx) {
  const m = mode_of('what_changed', a, ctx);
  need_mode(ctx, m);
  if (!Array.isArray(ctx.journal)) fail('E_SCHEMA', { reason: 'journal_required' });
  const E = evs(ctx);
  let day;
  if (a.since.startsWith('c_')) {
    day = ctx.call_log?.[a.since.slice(2)];
    if (typeof day !== 'string') fail('E_SCHEMA', { reason: 'since_call_unknown' });
  } else day = a.since;
  parse_date(day);
  const after = effective_events(ctx.journal);
  const before = effective_events(state_at(ctx.journal, day));
  const in_before = new Set(before.map((e) => e.event_id));
  const in_after = new Set(after.map((e) => e.event_id));
  const diff = [...after.filter((e) => !in_before.has(e.event_id)), ...before.filter((e) => !in_after.has(e.event_id))];
  const seen = new Map();
  for (const e of diff) {
    const kind = CHANGE_KINDS[String(e.type).split('.')[0]];
    if (kind === undefined) continue;
    const id = safe_id(e.entity_id ?? '');
    seen.set(kind + '\u0000' + id, { kind, entity_id: id });
  }
  const changes = [...seen.values()].sort((p, q) => (p.kind < q.kind ? -1 : p.kind > q.kind ? 1 : p.entity_id < q.entity_id ? -1 : p.entity_id > q.entity_id ? 1 : 0));
  const counts = new Map();
  for (const c of changes) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  const st = reduce(before);
  const ws_before = { ...(ctx.ws ?? {}), ...st, params: { ...(ctx.ws?.params ?? {}), ...(st.params ?? {}) } };
  const b_ctx = analyze(ws_before, query_of(ctx, { modes: [m] }));
  const min_before = narrowest_point(b_ctx.series[m], b_ctx.as_of, b_ctx.horizon_end).amount_minor;
  const min_after = narrowest_point(ctx.series[m], ctx.as_of, ctx.horizon_end).amount_minor;
  return {
    facts: {
      kind: 'ok',
      since: is_calendar_date(a.since) ? E.date(a.since) : null,
      changes: changes.slice(0, 50),
      changes_truncated: changes.length > 50,
      changes_count: E.count(changes.length),
      kind_counts: [...counts.entries()].map(([kind, n]) => ({ kind, count: E.count(n) })),
      min_before: E.money(min_before),
      min_after: E.money(min_after),
    },
    warnings: [...ctx.warnings, ...b_ctx.warnings],
  };
}

function run_get_tax_envelope(a, ctx) {
  const m = mode_of('get_tax_envelope', a, ctx);
  need_mode(ctx, m);
  const E = evs(ctx);
  const w = need_ws(ctx);
  const d = a.as_of === undefined ? ctx.as_of : parse_date(a.as_of);
  if (d < ctx.as_of) fail('E_BAD_DATE', { reason: 'as_of_before_as_of' });
  const warnings = [...ctx.warnings];
  if (d > ctx.horizon_end) return { facts: { kind: 'outside_horizon', horizon_end: E.date(ctx.horizon_end) }, warnings };
  const i = d - ctx.as_of;
  const by = ctx.reserve?.[m]?.by_reserve ?? {};
  const tax_reserves = w.reserves.filter((r) => r.kind === 'tax' && Object.hasOwn(by, r.reserve_id)).sort((p, q) => (p.reserve_id < q.reserve_id ? -1 : 1));
  const reserved = sum_minor(tax_reserves.map((r) => by[r.reserve_id].close[i]));
  const by_rule = tax_reserves.filter((r) => r.tax_rule_id !== undefined && r.tax_rule_id !== null).map((r) => {
    const rule = rule_at(w.tax_rules, r.tax_rule_id, d);
    return {
      rule_id: safe_id(r.tax_rule_id),
      version: rule === null ? null : E.count(rule.version ?? 1),
      amount: E.money(by[r.reserve_id].close[i]),
    };
  });
  let next_due = null;
  for (const r of tax_reserves) {
    const n = next_release(r.reserve_id, ctx.reserve[m], ctx.events[m], d);
    if (n !== null && (next_due === null || n.date < next_due.date)) next_due = n;
  }
  return {
    facts: {
      kind: 'ok', as_of: E.date(d), reserved: E.money(reserved), by_rule,
      next_due: next_due === null ? null : { date: E.date(next_due.date), payment_minor: E.money(next_due.payment_minor) },
      notice: 'user_rules_not_advice',
    },
    warnings,
  };
}

function run_propose_change(a, ctx) {
  const E = evs(ctx);
  const m = mode_of('propose_change', a, ctx);
  need_mode(ctx, m);
  const w = need_ws(ctx);
  const find = (ref_id) => {
    const evs_ = ctx.events[m].filter((e) => e.cash_event_id === ref_id || e.occ_key === ref_id || e.rule_id === ref_id);
    const plan = w.plans.find((p) => p.plan_id === ref_id);
    if (evs_.length === 0 && plan === undefined) fail('E_SCHEMA', { reason: 'ref_not_found' });
    return evs_;
  };
  const diff = a.ops.map((o) => {
    switch (o.op) {
      case 'move_plan': {
        const hit = find(o.ref);
        return {
          op: 'move_plan', ref: safe_id(o.ref),
          from: hit.length === 1 ? E.date(hit[0].plan_date ?? hit[0].date) : null,
          to: E.date(parse_date(o.date)),
        };
      }
      case 'skip_plan':
        find(o.ref);
        return { op: 'skip_plan', ref: safe_id(o.ref) };
      default:
        return { op: 'add_plan', date: E.date(parse_date(o.date)), amount: E.money(o.amount_minor), currency: o.currency };
    }
  });
  const draft_id = 'draft_' + sha256(canon({ ops: a.ops, h: ctx.inputs_hash })).slice(0, 8);
  // `note` — недоверенный текст: в Result не попадает (только признак наличия)
  return { facts: { kind: 'ok', draft_id, has_note: a.note !== undefined, diff, ops_count: E.count(a.ops.length) }, warnings: [...ctx.warnings] };
}

/**
 * Реестр инструментов (10 штук, §5.1): `{name, tier, input_schema, run}`. Ответ любого инструмента — `Result` (через `run_tool`).
 * Нет и не будет: `delete_*`, `export_*`, `send_*`, сетевых.
 * @type {Readonly<Object<string, {name: string, tier: 'T0'|'T1', input_schema: object, run: (args: object, ctx: object) => {facts: object, warnings: object[], order?: string[]}}>>}
 */
export const TOOLS = Object.freeze(Object.fromEntries([
  ['get_projection', 'T0', run_get_projection],
  ['check_purchase', 'T0', run_check_purchase],
  ['max_purchase_amount', 'T0', run_max_purchase_amount],
  ['earliest_safe_date', 'T0', run_earliest_safe_date],
  ['list_waves', 'T0', run_list_waves],
  ['explain_min_point', 'T0', run_explain_min_point],
  ['run_scenario', 'T0', run_run_scenario],
  ['what_changed', 'T0', run_what_changed],
  ['get_tax_envelope', 'T0', run_get_tax_envelope],
  ['propose_change', 'T1', run_propose_change],
].map(([name, tier, run]) => [name, Object.freeze({ name, tier, input_schema: SCHEMAS[name], run })])));

/** Имена инструментов в каноническом порядке. */
export const TOOL_NAMES = Object.freeze(Object.keys(TOOLS));

// ── раннер ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Ошибка инструмента: машинный код и короткая причина; значений аргументов нет. */
function tool_error(code, reason, errors) {
  const e = { isError: true, code };
  if (reason !== undefined) e.reason = reason;
  if (errors !== undefined) e.errors = errors;
  return e;
}

/**
 * Запустить инструмент (ALG-12): предел вызовов (ошибки тоже тратят бюджет) → неизвестный инструмент → права `T1` (до валидации и до чтения
 * данных) → нормализация → схема → межполевая проверка `parts` (C-076) → расчёт → конверт `Result` → `assert_clean`.
 * Ошибки — значением `{isError: true, code, …}`, не исключением: `E_CALL_LIMIT`, `E_UNKNOWN_TOOL`, `E_NOT_PERMITTED` (§14 N8),
 * `E_SCHEMA`, а также коды движка (`E_BAD_DATE`, `E_CURRENCY_MISMATCH`, …). Вызывает `ctx.calls_used += 1`.
 * @param {string} name
 * @param {object} args
 * @param {object} ctx см. заголовок модуля
 * @returns {Result|ToolError}
 */
export function run_tool(name, args, ctx) {
  ctx.calls_used = (ctx.calls_used ?? 0) + 1;
  // предел из параметров рабочей области (данные пользователя/импортированный журнал): нечисловое или отрицательное значение не снимает предел
  const mc = ctx.params?.['tools.max_calls'];
  // К-4 (Q-12): допустимый диапазон 1…12; иное (нечисловое, 0, 10^9) — умолчание 12, предел вызовов не обходится параметром
  const max_calls = Number.isSafeInteger(mc) && mc >= 1 && mc <= 12 ? mc : 12;
  if (ctx.calls_used > max_calls) return tool_error('E_CALL_LIMIT', 'call_limit');
  const t = typeof name === 'string' && Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined;
  if (t === undefined) return tool_error('E_UNKNOWN_TOOL', 'unknown_tool');
  if (t.tier === 'T1' && ctx.t1_enabled !== true) return tool_error('E_NOT_PERMITTED', 'not_permitted');
  const a = normalize_args(args);
  const v = validate_args(t.input_schema, a);
  if (!v.ok) return tool_error('E_SCHEMA', 'schema', v.errors);
  if (name === 'check_purchase' && a.parts !== undefined) {
    let min_date = a.parts[0]?.date;
    let total = 0;
    for (const p of a.parts) { if (p.date < min_date) min_date = p.date; total += p.amount_minor; }
    if (a.parts.length === 0 || a.date !== min_date || a.amount_minor !== total) return tool_error('E_SCHEMA', 'parts_mismatch');
  }
  try {
    const raw = t.run(a, ctx);
    const b = new ResultBuilder();
    b.pre_register(raw.facts, raw.order);
    const facts = b.walk(raw.facts);
    const scope_mode = mode_of(name, a, ctx);
    const r = {
      call_id: call_id(name, a, ctx.inputs_hash),
      tool: name,
      engine_version: ctx.engine_version,
      inputs_hash: ctx.inputs_hash,
      as_of: format_date(ctx.as_of),
      scope: { mode: scope_mode, scenario_id: name === 'run_scenario' ? (a.base ?? null) : (a.scenario ?? null) },
      facts,
      evidence: b.list,
      warnings: clean_warnings(raw.warnings),
    };
    return assert_clean(r);
  } catch (e) {
    if (e instanceof RunwayError) {
      const reason = typeof e.ctx?.reason === 'string' && SAFE_ID.test(e.ctx.reason) ? e.ctx.reason : undefined;
      return tool_error(e.code, reason);
    }
    throw e;
  }
}

/**
 * Собрать контекст раннера: `analyze(ws, query)` плюс поля `ws`, `query`, `journal`, `call_log`, `tier`, `t1_enabled`, `calls_used`, `locale`, `echo`.
 * @param {object} ws рабочая область
 * @param {object} query запрос `analyze`
 * @param {{journal?: object[], call_log?: object, t1_enabled?: boolean, locale?: 'ru'|'en'}} [opts]
 * @returns {object}
 */
export function make_tool_ctx(ws, query, opts = {}) {
  const base = analyze(ws, query);
  return Object.assign(base, {
    ws,
    query: { ...query },
    journal: opts.journal ?? null,
    call_log: opts.call_log ?? {},
    tier: opts.t1_enabled === true ? 'T1' : 'T0',
    t1_enabled: opts.t1_enabled === true,
    calls_used: 0,
    locale: opts.locale ?? ws?.locale ?? 'ru',
    echo: [],
  });
}
