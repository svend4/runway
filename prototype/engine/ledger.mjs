// ledger.mjs — журнал событий (append-only), канонический JSON, SHA-256, хэши, дедупликация.
// Канон: design-brief §3.3, §3.10, §5, §14 N7; ADR-004; product/04-data-model.md (раздел «Журнал событий»); C-043, C-069…C-072, C-095.
// Зависимости: ТОЛЬКО money (§14 B4: `ledger` — только money). Даты здесь — строки ISO; небольшие преобразования
// EpochDay ↔ ISO сделаны локально (private), чтобы не зависеть от dates.mjs.
// Модуль чистый: время ввода, идентификатор записи и `seq` приходят аргументом `ctx` (порты), SHA-256 — собственный.

import { fail, assert_minor } from './money.mjs';

/** @typedef {string} IsoDate */
/**
 * @typedef {object} LedgerEvent
 * @property {string} event_id идентификатор записи (uuidv7; создаёт адаптер)
 * @property {string} type вид записи (`tx.posted`, `rule.set`, …)
 * @property {number} v версия схемы payload
 * @property {string} entity_id сущность записи
 * @property {object} payload целые, ISO-даты, без float
 * @property {string} recorded_at момент ввода `YYYY-MM-DDTHH:MM:SSZ` (аудит; в арифметике не участвует)
 * @property {number} seq монотонный номер записи в рабочей области (обязателен в v1, C-072)
 * @property {string} actor `user | import:<batch_id> | assistant:<draft_id> | system`
 * @property {string} [causation_id]
 * @property {string} [supersedes_id]
 */

// ── SHA-256 (чистая реализация, FIPS 180-4) ────────────────────────────────────

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

/**
 * SHA-256 → строка из 64 hex-знаков. Строка кодируется как UTF-8.
 * @param {Uint8Array|number[]|string} bytes
 * @returns {string}
 */
export function sha256(bytes) {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  if (!(data instanceof Uint8Array) && !Array.isArray(data)) fail('E_SCHEMA', { reason: 'sha256_input_not_bytes' });
  const len = data.length;
  if (!(data instanceof Uint8Array)) {
    // числовой массив: байты вне 0…255 не маскируются молча (иначе разные входы дают один хэш)
    for (let i = 0; i < len; i++) {
      const b = data[i];
      if (!Number.isInteger(b) || b < 0 || b > 255) fail('E_SCHEMA', { reason: 'sha256_byte_out_of_range', index: i });
    }
  }
  const padded_len = (((len + 9 + 63) >>> 6) << 6);
  const buf = new Uint8Array(padded_len);
  for (let i = 0; i < len; i++) buf[i] = data[i];
  buf[len] = 0x80;
  const bit_hi = Math.floor(len / 0x20000000); // старшие 32 бита длины в битах (len·8 / 2^32)
  const bit_lo = (len << 3) >>> 0;
  const dv = new DataView(buf.buffer);
  dv.setUint32(padded_len - 8, bit_hi >>> 0, false);
  dv.setUint32(padded_len - 4, bit_lo, false);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded_len; off += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(off + 4 * t, false);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K256[t] + w[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  let hex = '';
  for (let i = 0; i < 8; i++) hex += h[i].toString(16).padStart(8, '0');
  return hex;
}

// ── канонический JSON и хэши ──────────────────────────────────────────────────

/** Сравнение строк по кодовым точкам (не по UTF-16-единицам). */
function cmp_code_points(a, b) {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done) return y.done ? 0 : -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0);
    const cy = y.value.codePointAt(0);
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

/**
 * Канонический JSON: ключи по возрастанию кодовых точек, без пробелов, строки в NFC,
 * числа — только safe-integer, `undefined` в объекте опускается. Порядок элементов массива задаёт производитель.
 * @param {*} x
 * @returns {string}
 * @throws {RunwayError} E_NOT_INTEGER (float/NaN/вне safe-integer), E_SCHEMA (неподдерживаемый тип)
 */
export function canon(x) {
  if (x === null) return 'null';
  switch (typeof x) {
    case 'boolean': return x ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(x)) fail('E_NOT_INTEGER', { reason: 'canon_number', value: String(x) });
      return String(x + 0);
    case 'string': return JSON.stringify(x.normalize('NFC'));
    case 'bigint': return fail('E_NOT_INTEGER', { reason: 'canon_bigint' });
    case 'object': {
      if (Array.isArray(x)) {
        const parts = [];
        for (let i = 0; i < x.length; i++) {
          // дырка («[1,,3]») и явный undefined одинаково невалидны: иначе получился бы не-JSON
          if (!Object.hasOwn(x, i) || x[i] === undefined) fail('E_SCHEMA', { reason: 'canon_undefined_in_array', index: i });
          parts.push(canon(x[i]));
        }
        return '[' + parts.join(',') + ']';
      }
      const proto = Object.getPrototypeOf(x);
      if (proto !== Object.prototype && proto !== null) fail('E_SCHEMA', { reason: 'canon_not_plain_object' });
      const entries = [];
      for (const k of Object.keys(x)) {
        if (x[k] === undefined) continue;
        entries.push([k.normalize('NFC'), x[k]]);
      }
      entries.sort((p, q) => cmp_code_points(p[0], q[0]));
      for (let i = 1; i < entries.length; i++) {
        if (entries[i][0] === entries[i - 1][0]) fail('E_SCHEMA', { reason: 'canon_duplicate_key', key: entries[i][0] });
      }
      return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canon(v)).join(',') + '}';
    }
    default: return fail('E_SCHEMA', { reason: 'canon_unsupported_type', type: typeof x });
  }
}

/**
 * Хэш входов расчёта: `hex(sha256(canon(window)))`, где
 * `window = { events, rules, params, as_of, engine_version }` (D-21, ADR-004).
 * Порядок ключей и форма записи на диске на хэш не влияют; смена `as_of`, версии правила или `engine_version` — влияет.
 * @param {object} window
 * @returns {string} 64 hex-знака
 */
export function inputs_hash(window) {
  if (window === null || typeof window !== 'object' || Array.isArray(window)) fail('E_SCHEMA', { reason: 'inputs_hash_window_not_object' });
  return sha256(canon(window));
}

/**
 * Хэш состояния: `hex(sha256(canon(state)))`, `state = reduce(effective_events(journal))` (C-071).
 * `opts.omit` — необязательный список верхнеуровневых ключей состояния, не входящих в хэш (Q-21, К-31): `['imports']` даёт хэш «кроме журнала
 * импортов», который после отката партии равен хэшу до импорта (REQ-093). Без `opts` хэш не меняется (arith.lock, golden).
 * @param {object} state
 * @param {{omit?: string[]}} [opts]
 * @returns {string}
 */
export function state_hash(state, opts) {
  const omit = opts === undefined || opts === null ? undefined : opts.omit;
  if (omit === undefined || omit === null) return sha256(canon(state));
  if (!Array.isArray(omit) || omit.some((k) => typeof k !== 'string')) fail('E_SCHEMA', { reason: 'state_hash_omit_not_string_list' });
  if (state === null || typeof state !== 'object' || Array.isArray(state)) fail('E_SCHEMA', { reason: 'state_hash_state_not_object' });
  const kept = {};
  for (const k of Object.keys(state)) if (!omit.includes(k)) put(kept, k, state[k]);
  return sha256(canon(kept));
}

/**
 * Хэш ядра состояния: `state_hash` без реестра импортов (`imports`). Инвариант 5 ALG-14 «откат партии возвращает хэш» читается как равенство
 * `core_hash` до импорта и после отката (`import.started` / `import.rolled_back` остаются в журнале и в `imports`, К-31).
 * @param {object} state
 * @returns {string}
 */
export function core_hash(state) {
  return state_hash(state, { omit: ['imports'] });
}

// ── нормализация и ключ дедупликации ──────────────────────────────────────────

/**
 * Нормализация описания: NFKC → нижний регистр → каждая последовательность не-букв и не-цифр → один пробел → trim.
 * Комбинирующие знаки (`\p{M}`) сохраняются («диакритика сохраняется», ALG-14): иначе «İSTANBUL» (нижний регистр
 * даёт `i` + U+0307) резался бы на «i stanbul», а «हिन्दी» превращалась бы в «ह न द».
 * @param {string} s
 * @returns {string}
 */
export function norm(s) {
  if (typeof s !== 'string') fail('E_SCHEMA', { reason: 'norm_not_string' });
  return s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim();
}

/** Локальное (private) преобразование EpochDay → `YYYY-MM-DD` (алгоритм Хиннанта), чтобы не зависеть от dates.mjs. */
function iso_of_epoch_day(z) {
  if (!Number.isSafeInteger(z)) fail('E_BAD_DATE', { value: String(z) });
  const fdiv = (a, b) => Math.floor(a / b);
  const zz = z + 719468;
  const era = fdiv(zz, 146097);
  const doe = zz - era * 146097;
  const yoe = fdiv(doe - fdiv(doe, 1460) + fdiv(doe, 36524) - fdiv(doe, 146096), 365);
  const doy = doe - (365 * yoe + fdiv(yoe, 4) - fdiv(yoe, 100));
  const mp = fdiv(5 * doy + 2, 153);
  const d = doy - fdiv(153 * mp + 2, 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  if (y < 1 || y > 9999) fail('E_BAD_DATE', { value: z });
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

/** Календарная корректность (год 1…9999, месяц 1…12, день по длине месяца, григорианский високосный год). */
function valid_ymd(y, m, d) {
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return d <= dim;
}

/** `IsoDate | EpochDay` → `IsoDate` (строка проверяется по шаблону И по календарю: «2026-02-31» → E_BAD_DATE). */
function as_iso(date) {
  if (typeof date === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (m === null || !valid_ymd(+m[1], +m[2], +m[3])) fail('E_BAD_DATE', { value: date });
    return date;
  }
  return iso_of_epoch_day(date);
}

/**
 * Ключ идемпотентного импорта: `hex(sha256(acc|date|amount_minor|currency|norm(desc)|k))[0:16]`;
 * `k` — номер среди одинаковых `(date, amount, currency, norm(desc))` в партии в порядке строк.
 * @param {string} acc идентификатор счёта
 * @param {IsoDate|number} date дата (`YYYY-MM-DD` или EpochDay)
 * @param {number} amount_minor
 * @param {string} cur код валюты
 * @param {string} desc описание (нормализуется `norm`)
 * @param {number} k номер дубля ≥ 0
 * @returns {string} 16 hex-знаков
 */
export function dedup_key(acc, date, amount_minor, cur, desc, k) {
  if (!Number.isInteger(k) || k < 0) fail('E_SCHEMA', { reason: 'dedup_k_not_nonneg_int', k: String(k) });
  // «|» — разделитель прообраза: допусти его в acc/cur, и разные кортежи дали бы один прообраз (ALG-14: fail E_SCHEMA)
  if (typeof acc !== 'string' || acc === '' || acc.includes('|')) fail('E_SCHEMA', { reason: 'dedup_acc_invalid' });
  if (typeof cur !== 'string' || cur === '' || cur.includes('|')) fail('E_SCHEMA', { reason: 'dedup_currency_invalid' });
  const pre = acc + '|' + as_iso(date) + '|' + String(assert_minor(amount_minor)) + '|' + cur + '|' + norm(desc) + '|' + String(k);
  return sha256(pre).slice(0, 16);
}

// ── записи журнала ────────────────────────────────────────────────────────────

/** Типы записей v1 (+ v2 для прототипа). `tx.voided` удалён (C-070): отмена — только `revert`. */
export const EVENT_TYPES = Object.freeze([
  'tx.posted', 'anchor.set', 'rule.set', 'override.set', 'stream.set', 'taxrule.set', 'reserve.set',
  'allocation.recorded', 'fx.set', 'scenario.set', 'purchase.saved', 'wave_override.set', 'calendar.set',
  'params.set', 'account.opened', 'account.closed', 'import.started', 'import.rolled_back', 'revert',
  'plan.set', 'counterparty.set', 'profile.set', 'match.set', 'debt.set',
  'consent.granted', 'consent.revoked', 'draft.proposed', 'draft.confirmed', 'assistant.call',
]);

/** Поле payload, из которого выводится `entity_id`, если `ctx.entity_id` не задан. */
const ENTITY_FIELD = Object.freeze({
  'anchor.set': 'anchor_id', 'rule.set': 'rule_id', 'override.set': 'rule_id', 'stream.set': 'stream_id', 'taxrule.set': 'tax_rule_id',
  'reserve.set': 'reserve_id', 'allocation.recorded': 'allocation_id', 'fx.set': 'fx_id', 'scenario.set': 'scenario_id',
  'purchase.saved': 'purchase_id', 'wave_override.set': 'override_id', 'calendar.set': 'calendar_id',
  'account.opened': 'account_id', 'account.closed': 'account_id', 'import.started': 'batch_id',
  'import.rolled_back': 'batch_id', 'plan.set': 'plan_id', 'counterparty.set': 'counterparty_id',
  'profile.set': 'profile_id', 'match.set': 'fact_event_id', 'debt.set': 'debt_id', 'revert': 'target',
});

const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;

/** Момент `YYYY-MM-DDTHH:MM:SS[.fff]Z`: форма + календарь + время (час ≤ 23, минуты и секунды ≤ 59). */
function is_instant(s) {
  if (typeof s !== 'string') return false;
  const m = INSTANT_RE.exec(s);
  return m !== null && valid_ymd(+m[1], +m[2], +m[3]) && +m[4] <= 23 && +m[5] <= 59 && +m[6] <= 59;
}
const ACTOR_RE = /^(?:user|system|import:.+|assistant:.+)$/;

/** Реестр версий схемы: текущая версия payload по типу и цепочка апкастеров `v → v+1`. */
export const DEFAULT_UPCAST_REGISTRY = Object.freeze({
  current: Object.freeze(Object.fromEntries(EVENT_TYPES.map((t) => [t, 1]))),
  steps: Object.freeze({}),
});

/**
 * Создать запись журнала. Идентификатор, `seq` и время приходят аргументом `ctx` — движок не читает часы.
 * Payload проходит `canon` (float и не-JSON отвергаются) и копируется в нормализованном виде.
 * @param {string} type вид записи
 * @param {object} payload
 * @param {{event_id: string, seq: number, recorded_at: string, actor?: string, entity_id?: string, v?: number,
 *          causation_id?: string, supersedes_id?: string}} ctx
 * @returns {LedgerEvent}
 * @throws {RunwayError} E_SCHEMA, E_NOT_INTEGER
 */
export function make_event(type, payload, ctx) {
  if (type === 'tx.voided') fail('E_SCHEMA', { reason: 'removed_type', type });
  if (!EVENT_TYPES.includes(type)) fail('E_SCHEMA', { reason: 'unknown_type', type: String(type) });
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) fail('E_SCHEMA', { reason: 'payload_not_object', type });
  if (ctx === null || typeof ctx !== 'object') fail('E_SCHEMA', { reason: 'ctx_required' });
  const { event_id, seq, recorded_at, actor = 'user', causation_id, supersedes_id } = ctx;
  if (typeof event_id !== 'string' || event_id === '') fail('E_SCHEMA', { reason: 'event_id_required' });
  if (!Number.isSafeInteger(seq) || seq < 0) fail('E_SCHEMA', { reason: 'seq_required_nonneg_int' });
  if (!is_instant(recorded_at)) fail('E_SCHEMA', { reason: 'recorded_at_not_instant' });
  if (typeof actor !== 'string' || !ACTOR_RE.test(actor)) fail('E_SCHEMA', { reason: 'bad_actor', actor: String(actor) });
  const v = ctx.v ?? DEFAULT_UPCAST_REGISTRY.current[type];
  if (!Number.isSafeInteger(v) || v < 1) fail('E_SCHEMA', { reason: 'bad_v' });
  const clean = JSON.parse(canon(payload)); // отвергает float, нормализует NFC, опускает undefined
  let entity_id = ctx.entity_id;
  if (entity_id === undefined && ENTITY_FIELD[type] !== undefined) entity_id = clean[ENTITY_FIELD[type]];
  if (typeof entity_id !== 'string' || entity_id === '') fail('E_SCHEMA', { reason: 'entity_id_required', type });
  /** @type {LedgerEvent} */
  const e = { event_id, type, v, entity_id, payload: clean, recorded_at, seq, actor };
  if (causation_id !== undefined) e.causation_id = causation_id;
  if (supersedes_id !== undefined) e.supersedes_id = supersedes_id;
  return e;
}

/**
 * Поднять запись до текущей версии схемы чистыми апкастерами `v → v+1`. На диске запись не меняется.
 * Запись без `v` — `E_SCHEMA`; запись с более новой, неизвестной `v` — `E_SCHEMA` (`reason: 'newer_version'`):
 * такой файл можно только читать, но не сворачивать.
 * @param {LedgerEvent} event
 * @param {{current: Record<string, number>, steps: Record<string, Record<number, (e: LedgerEvent) => LedgerEvent>>}} [registry]
 * @returns {LedgerEvent}
 */
export function upcast(event, registry = DEFAULT_UPCAST_REGISTRY) {
  if (event === null || typeof event !== 'object') fail('E_SCHEMA', { reason: 'event_not_object' });
  if (!Number.isSafeInteger(event.v) || event.v < 1) fail('E_SCHEMA', { reason: 'v_required', event_id: event.event_id });
  const cur = registry.current[event.type];
  if (cur === undefined) fail('E_SCHEMA', { reason: 'unknown_type', type: String(event.type) });
  if (event.v > cur) fail('E_SCHEMA', { reason: 'newer_version', type: event.type, v: event.v, current: cur });
  let e = event;
  while (e.v < cur) {
    const step = registry.steps[e.type]?.[e.v];
    if (step === undefined) fail('E_SCHEMA', { reason: 'no_upcaster', type: e.type, v: e.v });
    const next = step(e);
    if (next.v !== e.v + 1) fail('E_SCHEMA', { reason: 'upcaster_must_raise_v_by_1', type: e.type, v: e.v });
    e = next;
  }
  return e;
}

/**
 * Эффективные записи: откат (`revert`) и правка (`supersedes_id`) — C-070.
 * `effective(e) = не отменена и нет не отменённой записи-замены x с x.supersedes_id = e.event_id`
 * (отмена — «живой» `revert`, то есть сам не отменённый: откат отката возвращает действие).
 * Ссылки ведут только на более ранние записи (иначе `E_SCHEMA`); ссылка на неизвестную запись игнорируется
 * (журнал может быть срезом). Результат — по порядку `seq`, без самих `revert`-записей.
 * @param {LedgerEvent[]} events
 * @returns {LedgerEvent[]}
 */
export function effective_events(events) {
  const log = events.map((e, i) => {
    if (!Number.isSafeInteger(e.seq)) fail('E_SCHEMA', { reason: 'seq_required', event_id: e.event_id });
    return { e, i };
  }).sort((a, b) => (a.e.seq - b.e.seq) || (a.i - b.i)).map((x) => x.e);
  for (let i = 1; i < log.length; i++) {
    if (log[i].seq === log[i - 1].seq) fail('E_SCHEMA', { reason: 'seq_not_monotonic', seq: log[i].seq });
  }
  const pos = new Map();
  log.forEach((e, i) => {
    if (pos.has(e.event_id)) fail('E_SCHEMA', { reason: 'duplicate_event_id', event_id: e.event_id });
    pos.set(e.event_id, i);
  });
  const check_back = (i, ref, what) => {
    if (ref === undefined || ref === null) return;
    const j = pos.get(ref);
    if (j !== undefined && j >= i) fail('E_SCHEMA', { reason: 'reference_to_later_event', what, event_id: log[i].event_id });
  };
  const reverts_of = new Map();
  const superseded_by = new Map();
  log.forEach((e, i) => {
    if (e.type === 'revert') {
      const target = e.payload?.target;
      if (typeof target !== 'string') fail('E_SCHEMA', { reason: 'revert_without_target', event_id: e.event_id });
      check_back(i, target, 'revert.target');
      if (!reverts_of.has(target)) reverts_of.set(target, []);
      reverts_of.get(target).push(e);
    }
    if (e.supersedes_id !== undefined && e.supersedes_id !== null) {
      check_back(i, e.supersedes_id, 'supersedes_id');
      if (!superseded_by.has(e.supersedes_id)) superseded_by.set(e.supersedes_id, []);
      superseded_by.get(e.supersedes_id).push(e);
    }
    check_back(i, e.causation_id, 'causation_id');
  });
  // live(e) = запись не отменена (нет ЭФФЕКТИВНОГО revert на неё); решение зависит только от более поздних записей.
  // effective(e) = live(e) и нет «живой» записи-замены x (x.supersedes_id = e.event_id).
  // «Живая» замена — не отменённая, даже если сама позже заменена: иначе в цепочке правок a ← b ← c исходная a
  // воскресала бы рядом с c (см. spec_issues отчёта: буквальная формула C-070 даёт для цепочки двойной учёт).
  // Эффективность самого revert определяется через eff (product/04, C-070: eff[r] учитывает замену):
  // revert, заменённый исправляющим revert-ом (supersedes_id = r1), больше не действует (баг A-05).
  const live = new Map();
  const eff = new Map();
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    const is_live = !(reverts_of.get(e.event_id) ?? []).some((r) => eff.get(r.event_id) === true);
    live.set(e.event_id, is_live);
    const replaced = (superseded_by.get(e.event_id) ?? []).some((x) => live.get(x.event_id) === true);
    eff.set(e.event_id, is_live && !replaced);
  }
  return log.filter((e) => eff.get(e.event_id) === true && e.type !== 'revert');
}

// ── состояние (проекция журнала) ──────────────────────────────────────────────

/**
 * Пустое состояние рабочей области. Все словари — объекты по идентификатору (порядок ключей на хэш не влияет);
 * `wave_overrides` — массив в порядке `seq` (порядок применения важен, C-014).
 * @returns {object}
 */
export function empty_state() {
  return {
    params: {}, accounts: {}, anchors: {}, facts: {}, plans: {}, rules: {}, overrides: {}, calendars: {},
    streams: {}, tax_rules: {}, reserves: {}, allocations: {}, fx: {}, scenarios: {}, purchases: {},
    wave_overrides: [], counterparties: {}, profiles: {}, debts: {}, matches: {}, imports: {}, extra: {},
  };
}

function need_id(payload, field, type) {
  const v = payload[field];
  if (typeof v !== 'string' || v === '') fail('E_SCHEMA', { reason: 'payload_id_required', type, field });
  return v;
}

/**
 * Глубокая копия JSON-подобного значения (payload уже прошёл canon: только объекты/массивы/строки/целые/bool/null).
 * Состояние не делит изменяемые объекты с записями журнала (инвариант 3: журнал не мутирует; чистота reduce).
 */
function deep_clone(x) {
  if (x === null || typeof x !== 'object') return x;
  if (Array.isArray(x)) return x.map(deep_clone);
  const o = {};
  for (const k of Object.keys(x)) put(o, k, deep_clone(x[k]));
  return o;
}

/**
 * Запись ключа в словарь БЕЗ побочных эффектов на прототип: ключ «__proto__» (идентификаторы приходят из импорта и
 * ассистента — недоверенный ввод, ADR-013) сохраняется как собственное свойство, а не подменяет прототип словаря.
 */
function put(dict, key, value) {
  if (key === '__proto__') Object.defineProperty(dict, key, { value, writable: true, enumerable: true, configurable: true });
  else dict[key] = value;
}

function set_by(bucket, field, type) {
  return (s, e) => {
    const id = need_id(e.payload, field, type);
    put(s[bucket], id, deep_clone(e.payload));
  };
}

/** Применение записи к состоянию: тип → функция. Неверная форма payload → `E_SCHEMA`. */
const APPLY = {
  'account.opened': set_by('accounts', 'account_id', 'account.opened'),
  'account.closed': (s, e) => {
    const id = need_id(e.payload, 'account_id', 'account.closed');
    // собственное свойство, а не унаследованное («toString», «constructor» — не счета)
    if (!Object.hasOwn(s.accounts, id)) fail('E_SCHEMA', { reason: 'unknown_account', account_id: id });
    put(s.accounts, id, { ...s.accounts[id], closed_on: deep_clone(e.payload.closed_on) });
  },
  'anchor.set': set_by('anchors', 'anchor_id', 'anchor.set'),
  'tx.posted': (s, e) => {
    put(s.facts, e.entity_id, { ...deep_clone(e.payload), entity_id: e.entity_id, event_id: e.event_id });
  },
  'plan.set': (s, e) => { put(s.plans, e.entity_id, deep_clone(e.payload)); },
  'rule.set': set_by('rules', 'rule_id', 'rule.set'),
  'override.set': (s, e) => {
    const rid = need_id(e.payload, 'rule_id', 'override.set');
    const nd = need_id(e.payload, 'nominal_date', 'override.set');
    s.overrides[rid + '@' + nd] = deep_clone(e.payload);
  },
  'calendar.set': set_by('calendars', 'calendar_id', 'calendar.set'),
  'stream.set': set_by('streams', 'stream_id', 'stream.set'),
  'taxrule.set': (s, e) => {
    const id = need_id(e.payload, 'tax_rule_id', 'taxrule.set');
    // «??=» видел унаследованные свойства («constructor» → .push у функции): проверяем только собственные ключи
    if (!Object.hasOwn(s.tax_rules, id)) put(s.tax_rules, id, []);
    s.tax_rules[id].push(deep_clone(e.payload)); // все версии, в порядке применения
  },
  'reserve.set': set_by('reserves', 'reserve_id', 'reserve.set'),
  'allocation.recorded': set_by('allocations', 'allocation_id', 'allocation.recorded'), // идемпотентно по id
  'fx.set': set_by('fx', 'fx_id', 'fx.set'),
  'scenario.set': set_by('scenarios', 'scenario_id', 'scenario.set'),
  'purchase.saved': set_by('purchases', 'purchase_id', 'purchase.saved'),
  'wave_override.set': (s, e) => {
    need_id(e.payload, 'override_id', 'wave_override.set');
    s.wave_overrides.push({ ...deep_clone(e.payload), seq: e.seq });
  },
  'counterparty.set': set_by('counterparties', 'counterparty_id', 'counterparty.set'),
  'profile.set': set_by('profiles', 'profile_id', 'profile.set'),
  'debt.set': set_by('debts', 'debt_id', 'debt.set'),
  'match.set': (s, e) => {
    const id = need_id(e.payload, 'fact_event_id', 'match.set');
    const m = {};
    if (e.payload.plan_ref !== undefined) m.plan_ref = deep_clone(e.payload.plan_ref);
    if (e.payload.no_plan !== undefined) m.no_plan = deep_clone(e.payload.no_plan);
    put(s.matches, id, m);
  },
  'params.set': (s, e) => {
    // Object.assign вызвал бы сеттер «__proto__» и подменил прототип s.params
    for (const k of Object.keys(e.payload)) put(s.params, k, deep_clone(e.payload[k]));
  },
  'import.started': (s, e) => {
    const id = need_id(e.payload, 'batch_id', 'import.started');
    put(s.imports, id, { ...deep_clone(e.payload), rolled_back: false });
  },
  'import.rolled_back': (s, e) => {
    const id = need_id(e.payload, 'batch_id', 'import.rolled_back');
    put(s.imports, id, { ...(Object.hasOwn(s.imports, id) ? s.imports[id] : { batch_id: id }), rolled_back: true });
  },
};
for (const t of ['consent.granted', 'consent.revoked', 'draft.proposed', 'draft.confirmed', 'assistant.call']) {
  APPLY[t] = (s, e) => { put(s.extra[t] ??= {}, e.entity_id, deep_clone(e.payload)); }; // v2: храним без интерпретации
}

/**
 * Свёртка эффективных записей в состояние. Чистая: `base` не мутируется. Каждая запись проходит `upcast`.
 * Принимает результат `effective_events` (записи `revert` здесь недопустимы: `E_SCHEMA`).
 * Инвариант: `fold(все записи) = reduce(effective_events(журнал))`.
 * @param {LedgerEvent[]} events
 * @param {object} [base] начальное состояние (по умолчанию пустое); N7: снимков/`fold` в v1 нет
 * @param {{own?: boolean}} [opts] `own: true` — база принадлежит вызывающему: не клонируется и меняется на месте (запрос FP-01: «снимок + хвост»
 *   без копии 6 МБ на каждый вызов); без опции поведение прежнее — `base` не мутируется
 * @returns {object} State
 */
export function reduce(events, base, opts) {
  const s = base === undefined ? empty_state() : (opts !== undefined && opts !== null && opts.own === true ? base : JSON.parse(canon(base)));
  for (const raw of events) {
    const e = upcast(raw);
    if (e.type === 'revert') fail('E_SCHEMA', { reason: 'revert_in_reduce', event_id: e.event_id });
    canon(e.payload); // float в payload отвергается
    const fn = APPLY[e.type];
    if (fn === undefined) fail('E_SCHEMA', { reason: 'unknown_type', type: e.type });
    fn(s, e);
  }
  // match.set проставляет plan_ref / no_plan в проекции факта (факт не мутирует, C-051)
  const match_ids = Object.keys(s.matches);
  if (match_ids.length > 0) {
    const key_by_event = new Map();
    for (const k of Object.keys(s.facts)) key_by_event.set(s.facts[k].event_id, k);
    for (const fid of match_ids) {
      const key = key_by_event.get(fid) ?? (Object.hasOwn(s.facts, fid) ? fid : undefined);
      if (key !== undefined) {
        const f = { ...s.facts[key] };
        delete f.plan_ref;
        delete f.no_plan;
        put(s.facts, key, { ...f, ...s.matches[fid] });
      }
    }
  }
  return s;
}

/**
 * Срез журнала «как знали тогда»: записи, введённые не позже дня `recorded_day` (по `recorded_at[0..10]`).
 * Введённое задним числом невидимо. Единственная реализация `state_at` (C-056).
 * @param {LedgerEvent[]} events
 * @param {IsoDate|number} recorded_day день среза (`YYYY-MM-DD` или EpochDay), включительно
 * @returns {LedgerEvent[]} подмножество `events` в исходном порядке
 */
export function state_at(events, recorded_day) {
  const limit = as_iso(recorded_day);
  return events.filter((e) => {
    if (!is_instant(e.recorded_at)) fail('E_SCHEMA', { reason: 'recorded_at_not_instant', event_id: e.event_id });
    return e.recorded_at.slice(0, 10) <= limit;
  });
}
