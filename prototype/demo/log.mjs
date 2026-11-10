// log.mjs — типизированный логгер и отчёт об ошибке без персональных данных (FP-05, REQ-124, IDEA-80, TST-46).
// Правило: в лог и в отчёт попадают ТОЛЬКО поля белого списка `id`, `n`, `ms`, `code`, `engine_version`; строки длиннее 32 знаков срезаются;
// суммы, описания, названия, заметки и метки в лог не входят (поле вне списка — исключение в строгом режиме, а в обычном — отбрасывается и считается).
// Отчёт об ошибке строится только по согласию пользователя и показывается целиком до отправки (в v1 отправки нет: пользователь копирует текст сам).
// Модуль чистый: часов и случайности не читает, в консоль не пишет (`console` не используется: вывод — только в память и в `sink`, который передаёт вызывающий).
// Расчёт по введённым данным и правилам, не консультация.

/** Белый список полей лога (REQ-124). */
export const LOG_FIELDS = Object.freeze(['id', 'n', 'ms', 'code', 'engine_version']);

/** Длина строки, после которой она срезается. */
export const LOG_MAX_STRING = 32;

/** Сколько записей хранится в памяти (кольцо). */
export const LOG_RING = 200;

const EVENT_RE = /^[a-z][a-z0-9_]{0,31}$/;
const ID_BAD_CHARS = /[^A-Za-z0-9_.:~@/-]/g;
const CODE_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,31}$/;
const VERSION_BAD_CHARS = /[^0-9A-Za-z.+-]/g;

/** Ошибка логгера: `code` — `log_field_forbidden | log_value_invalid | log_event_invalid`; `field` — имя поля (срезанное и очищенное), не значение. */
export class LogError extends Error {
  constructor(code, field = null) {
    super(code + (field === null ? '' : ' ' + field));
    this.name = 'LogError';
    this.code = code;
    this.field = field;
  }
}

/** Имя поля для сообщений: только допустимые знаки и не больше 32 (значение никогда не попадает в текст ошибки). */
const safe_name = (k) => String(k).slice(0, LOG_MAX_STRING).replace(ID_BAD_CHARS, '?');

const cut = (s) => (s.length > LOG_MAX_STRING ? s.slice(0, LOG_MAX_STRING - 1) + '…' : s);

/** Привести значение поля к допустимому виду или вернуть `undefined` (значение негодно). */
function clean_value(key, v) {
  switch (key) {
    case 'id': {
      if (typeof v === 'number') return Number.isSafeInteger(v) ? v : undefined;
      if (typeof v !== 'string' || v === '') return undefined;
      return cut(v.replace(ID_BAD_CHARS, '?'));
    }
    case 'n':
    case 'ms':
      return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
    case 'code': {
      if (typeof v !== 'string') return undefined;
      const c = v.slice(0, LOG_MAX_STRING);
      return CODE_RE.test(c) ? c : undefined;
    }
    case 'engine_version': {
      if (typeof v !== 'string' || v === '') return undefined;
      return cut(v.replace(VERSION_BAD_CHARS, '?'));
    }
    default: return undefined;
  }
}

/**
 * Проверить поля записи по белому списку.
 * @param {object} fields
 * @param {{strict?: boolean}} [opts] `strict` — любое лишнее поле и негодное значение: исключение; иначе — отбрасываются
 * @returns {{fields: object, dropped: number}}
 * @throws {LogError} в строгом режиме
 */
export function sanitize_fields(fields, opts = {}) {
  const strict = opts.strict === true;
  if (fields === undefined || fields === null) return { fields: {}, dropped: 0 };
  if (typeof fields !== 'object' || Array.isArray(fields)) {
    if (strict) throw new LogError('log_value_invalid', 'fields');
    return { fields: {}, dropped: 1 };
  }
  const out = {};
  let dropped = 0;
  for (const k of Object.getOwnPropertyNames(fields)) {
    if (!LOG_FIELDS.includes(k)) {
      if (strict) throw new LogError('log_field_forbidden', safe_name(k));
      dropped += 1;
      continue;
    }
    const v = clean_value(k, fields[k]);
    if (v === undefined) {
      if (strict) throw new LogError('log_value_invalid', k);
      dropped += 1;
      continue;
    }
    out[k] = v;
  }
  return { fields: out, dropped };
}

/**
 * Создать логгер. Запись — `log(event, fields?)`; `event` — имя события `[a-z][a-z0-9_]{0,31}`, `fields` — только поля белого списка.
 * Записи хранятся в памяти (кольцо `LOG_RING`) и, если задан `sink`, передаются ему готовым объектом (копией).
 * @param {{strict?: boolean, sink?: ((entry: object) => void)|null, ring?: number}} [opts]
 */
export function create_logger(opts = {}) {
  const strict = opts.strict === true;
  const sink = typeof opts.sink === 'function' ? opts.sink : null;
  const ring = Number.isSafeInteger(opts.ring) && opts.ring > 0 ? opts.ring : LOG_RING;
  const list = [];
  let dropped = 0;
  const write = (level, event, fields) => {
    if (typeof event !== 'string' || !EVENT_RE.test(event)) {
      if (strict) throw new LogError('log_event_invalid', typeof event === 'string' ? safe_name(event) : 'event');
      dropped += 1;
      return null;
    }
    const r = sanitize_fields(fields, { strict });
    dropped += r.dropped;
    const entry = Object.freeze({ level, event, ...r.fields });
    list.push(entry);
    if (list.length > ring) list.shift();
    if (sink !== null) { try { sink({ ...entry }); } catch { /* приёмник не должен ломать вызывающего */ } }
    return entry;
  };
  return {
    strict,
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
    /** Записи в памяти (копия массива). */
    entries: () => list.slice(),
    /** Сколько полей и записей отброшено (в строгом режиме всегда 0: там исключение). */
    dropped: () => dropped,
    clear() { list.length = 0; dropped = 0; },
  };
}

// ── отчёт об ошибке по согласию ───────────────────────────────────────────────────────────────────────────────────

/**
 * Отчёт об ошибке: только поля белого списка, по согласию. Без согласия отчёт не строится (`{ok: false, reason: 'consent_required'}`).
 * Из ошибки берётся только `code` (текст сообщения и контекст могут содержать данные — они в отчёт не входят).
 * @param {{error?: {code?: string}, consent?: boolean, id?: string|number, n?: number, ms?: number, engine_version?: string}} input
 * @returns {{ok: true, fields: object, text: string} | {ok: false, reason: 'consent_required'}}
 */
export function build_error_report(input = {}) {
  if (input.consent !== true) return { ok: false, reason: 'consent_required' };
  const raw = { code: typeof input.error?.code === 'string' ? input.error.code : 'E_UNKNOWN', id: input.id, n: input.n, ms: input.ms, engine_version: input.engine_version };
  for (const k of Object.keys(raw)) if (raw[k] === undefined) delete raw[k];
  const { fields } = sanitize_fields(raw, { strict: false });
  return { ok: true, fields, text: report_text(fields) };
}

/** Полный текст отчёта (его пользователь видит целиком до отправки): строки `поле: значение` в порядке белого списка. */
export function report_text(fields) {
  return LOG_FIELDS.filter((k) => Object.hasOwn(fields, k)).map((k) => k + ': ' + String(fields[k])).join('\n');
}

/** Логгер приложения: обычный режим (лишнее отбрасывается и считается), только память. Тесты создают свой строгий — `create_logger({strict: true})`. */
export const log = create_logger();

// ── глобальные ошибки страницы (FP-22, REQ-124) ───────────────────────────────────────────────────────────────────────

/** Коды ошибок движка (REQ-017): только они из свойства `code` пойдут в запись как есть. */
const ENGINE_CODES = Object.freeze(['E_NOT_INTEGER', 'E_OVERFLOW', 'E_BAD_DATE', 'E_FUTURE_POSTED', 'E_RULE_INVALID', 'E_CURRENCY_MISMATCH', 'E_NO_RATE', 'E_SCHEMA']);

/** Стандартные имена ошибок JavaScript: по ним (и только по ним) запись называет тип сбоя. */
const STD_ERROR_NAMES = Object.freeze(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError', 'DOMException', 'RunwayError']);

/** Сколько глобальных ошибок страница записывает в лог за сеанс (дальше записи прекращаются: поток одинаковых сбоев не вытесняет прочие записи кольца). */
export const GLOBAL_ERROR_MAX = 100;

/**
 * Безопасный код глобальной ошибки: код движка из закрытого списка, иначе стандартное имя типа сбоя (`js_typeerror`), иначе общий `js_error` / `js_rejection`.
 * Текст сообщения, стек, имя файла и любые свойства ошибки в код не попадают: пользовательские тексты и пути в запись не идут.
 * @param {unknown} err
 * @param {'js_error'|'js_rejection'} fallback
 * @returns {string}
 */
export function global_error_code(err, fallback) {
  if (err !== null && typeof err === 'object') {
    let code;
    let name;
    try { code = err.code; name = err.name; } catch { return fallback; } // геттер может бросить: код общий
    if (typeof code === 'string' && ENGINE_CODES.includes(code)) return code;
    if (typeof name === 'string' && STD_ERROR_NAMES.includes(name)) return 'js_' + name.toLowerCase();
  }
  return fallback;
}

const installed = new WeakMap(); // цель событий → снятие

/**
 * Подписать глобальные ошибки страницы (`error` и `unhandledrejection`) на безопасную запись логгера: только `code`, счётчик `n` (порядковый номер ошибки за сеанс)
 * и `engine_version`. Идентификатора сообщения, текста, стека и имени файла в записи нет (REQ-124, белый список полей). Повторная подписка той же цели ничего не добавляет
 * и возвращает прежнее снятие. Само событие не гасится: браузер покажет его в своей консоли, как всегда. Модуль в консоль не пишет.
 * @param {{addEventListener?: Function, removeEventListener?: Function}|null|undefined} target обычно `window`; без `addEventListener` — пустое снятие
 * @param {ReturnType<typeof create_logger>} logger
 * @param {{engine_version?: string, max?: number}} [opts]
 * @returns {() => void} снять подписку
 */
export function install_global_handlers(target, logger, opts = {}) {
  if (target === null || target === undefined || (typeof target !== 'object' && typeof target !== 'function') || typeof target.addEventListener !== 'function') return () => {};
  if (installed.has(target)) return installed.get(target);
  const max = Number.isSafeInteger(opts.max) && opts.max > 0 ? opts.max : GLOBAL_ERROR_MAX;
  const version = typeof opts.engine_version === 'string' ? opts.engine_version : undefined;
  let n = 0;
  const record = (event, err, fallback) => {
    if (n >= max) return;
    n += 1;
    try { logger.error(event, { code: global_error_code(err, fallback), n, ...(version === undefined ? {} : { engine_version: version }) }); } catch { /* лог не должен ломать страницу */ }
  };
  const on_error = (ev) => { let err; try { err = ev?.error; } catch { err = undefined; } record('global_error', err, 'js_error'); };
  const on_rejection = (ev) => { let err; try { err = ev?.reason; } catch { err = undefined; } record('global_rejection', err, 'js_rejection'); };
  target.addEventListener('error', on_error);
  target.addEventListener('unhandledrejection', on_rejection);
  const off = () => {
    installed.delete(target);
    if (typeof target.removeEventListener === 'function') { target.removeEventListener('error', on_error); target.removeEventListener('unhandledrejection', on_rejection); }
  };
  installed.set(target, off);
  return off;
}
