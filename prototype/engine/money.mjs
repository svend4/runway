// money.mjs — целые деньги, округление, дробление, парсинг и форматирование без Intl.
// Канон: design-brief §4 (вспомогательные функции), ADR-002, canon-decisions «Финальные сигнатуры» (money.mjs).
// Модуль чистый: ни часов, ни случайности, ни ввода-вывода. Зависимостей нет (корень графа: money ← dates ← …).
//
// Единый механизм ошибок движка (`fail(code, ctx)`, §4) живёт здесь, потому что money — корень зависимостей;
// остальные модули импортируют `fail` и `RunwayError` отсюда.

/** @typedef {number} Minor  Целое число минимальных единиц валюты (safe-integer). */
/** @typedef {'half_even'|'half_up'|'floor'|'ceil'} RoundMode */

/** Реестр кодов ошибок движка (design-brief §4 + решение N8 из §14). */
export const ERROR_CODES = Object.freeze([
  'E_NOT_INTEGER', 'E_OVERFLOW', 'E_BAD_DATE', 'E_FUTURE_POSTED', 'E_RULE_INVALID',
  'E_CURRENCY_MISMATCH', 'E_NO_RATE', 'E_SCHEMA',
  'E_UNTRUSTED_LEAK', 'E_NOT_PERMITTED', 'E_CALL_LIMIT', 'E_UNKNOWN_TOOL',
]);

/** Ошибка движка: машинный `code` из реестра и контекст `ctx` (JSON-совместимый, для диагностики). */
export class RunwayError extends Error {
  /**
   * @param {string} code код из `ERROR_CODES`
   * @param {object} [ctx] контекст (какое поле, какое значение)
   */
  constructor(code, ctx) {
    super(code + (ctx === undefined ? '' : ': ' + safe_json(ctx)));
    this.name = 'RunwayError';
    this.code = code;
    this.ctx = ctx === undefined ? null : ctx;
  }
}

/**
 * Есть ли у словаря СОБСТВЕННЫЙ ключ (не из `Object.prototype`): идентификаторы приходят из чужого файла и ассистента (ADR-013),
 * ключи «__proto__», «constructor», «toString» — обычные данные (Q-07). Помощник для словарей по идентификаторам.
 * @param {object} dict
 * @param {string} key
 * @returns {boolean}
 */
export function own_has(dict, key) {
  return Object.hasOwn(dict, key);
}

/**
 * Записать ключ в словарь как СОБСТВЕННОЕ свойство без побочных эффектов на прототип: ключ «__proto__» не подменяет прототип словаря
 * (`defineProperty`), как `ledger.put`. Возвращает значение.
 * @template T
 * @param {object} dict
 * @param {string} key
 * @param {T} value
 * @returns {T}
 */
export function own_put(dict, key, value) {
  if (key === '__proto__') Object.defineProperty(dict, key, { value, writable: true, enumerable: true, configurable: true });
  else dict[key] = value;
  return value;
}

/**
 * Прервать расчёт ошибкой с кодом (псевдокод §4: `fail(code, ctx)`).
 * @param {string} code
 * @param {object} [ctx]
 * @returns {never}
 */
export function fail(code, ctx) {
  throw new RunwayError(code, ctx);
}

function safe_json(x) {
  try {
    return JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() + 'n' : v));
  } catch {
    return String(x);
  }
}

const BIG_MAX = BigInt(Number.MAX_SAFE_INTEGER);
const MODES = Object.freeze(['half_even', 'half_up', 'floor', 'ceil']);
/** Верхняя граница числа частей `split_equal` (защита от выделения гигантского массива). */
const MAX_PARTS = 10_000_000;

/**
 * Проверить, что значение — целое в безопасном диапазоне; вернуть его как Number (−0 → 0).
 * BigInt в безопасном диапазоне допускается и превращается в Number.
 * @param {number|bigint} x
 * @returns {Minor}
 * @throws {RunwayError} E_NOT_INTEGER (не целое/не число), E_OVERFLOW (вне ±(2^53−1))
 */
export function assert_minor(x) {
  if (typeof x === 'bigint') {
    if (x > BIG_MAX || x < -BIG_MAX) fail('E_OVERFLOW', { value: x.toString() + 'n' });
    return Number(x);
  }
  if (typeof x !== 'number' || !Number.isInteger(x)) fail('E_NOT_INTEGER', { value: String(x) });
  if (!Number.isSafeInteger(x)) fail('E_OVERFLOW', { value: String(x) });
  return x + 0; // −0 → 0
}

/** Положительный целый делитель (Number). */
function pos_divisor(b) {
  const v = assert_minor(b);
  if (v <= 0) fail('E_SCHEMA', { reason: 'divisor_not_positive', value: String(b) });
  return v;
}

function check_mode(mode) {
  if (!MODES.includes(mode)) fail('E_SCHEMA', { reason: 'unknown_round_mode', value: String(mode) });
}

/**
 * Целочисленное деление с округлением к −∞ (b > 0). Точно для всех safe-integer, без BigInt.
 * @param {Minor} a
 * @param {Minor} b делитель > 0
 * @returns {number}
 */
export function floor_div(a, b) {
  const x = assert_minor(a);
  const y = pos_divisor(b);
  const r = x % y;
  let q = (x - r) / y; // (x − r) кратно y и по модулю ≤ |x|, значит деление точное
  if (r < 0) q -= 1;
  return q + 0;
}

/**
 * Остаток floor-деления: 0 ≤ r < b, a = b·floor_div(a, b) + r.
 * @param {Minor} a
 * @param {Minor} b делитель > 0
 * @returns {number}
 */
export function floor_mod(a, b) {
  const x = assert_minor(a);
  const y = pos_divisor(b);
  const r = x % y;
  return (r < 0 ? r + y : r) + 0;
}

/**
 * Деление с округлением к +∞ (b > 0): `ceil_div(a, b) = −floor_div(−a, b)`.
 * @param {Minor} a
 * @param {Minor} b делитель > 0
 * @returns {number}
 */
export function ceil_div(a, b) {
  return 0 - floor_div(0 - assert_minor(a), b);
}

/** @returns {bigint} */
function to_big(x) {
  if (typeof x === 'bigint') return x;
  return BigInt(assert_minor(x));
}

/**
 * Округляющее деление BigInt (d > 0n) — ядро `round_div` и `mul_div`.
 * @param {bigint} n
 * @param {bigint} d
 * @param {RoundMode} mode
 * @returns {bigint}
 */
function round_div_big(n, d, mode) {
  if (d <= 0n) fail('E_SCHEMA', { reason: 'divisor_not_positive', value: d.toString() + 'n' });
  let q = n / d;
  let r = n % d;
  if (r < 0n) { q -= 1n; r += d; } // floor: 0 ≤ r < d
  switch (mode) {
    case 'floor': return q;
    case 'ceil': return r > 0n ? q + 1n : q;
    case 'half_even': {
      const t = 2n * r;
      if (t < d) return q;
      if (t > d) return q + 1n;
      return q % 2n === 0n ? q : q + 1n;
    }
    case 'half_up': { // «от нуля»
      const t = 2n * r;
      if (t > d) return q + 1n;
      if (t === d) return n >= 0n ? q + 1n : q;
      return q;
    }
    /* c8 ignore next */
    default: return fail('E_SCHEMA', { reason: 'unknown_round_mode', value: String(mode) });
  }
}

/**
 * Деление с округлением (d > 0). `n` может быть BigInt (тогда результат проверяется `assert_minor`).
 * @param {Minor|bigint} n числитель
 * @param {Minor|bigint} d знаменатель > 0
 * @param {RoundMode} [mode] по умолчанию `half_even`
 * @returns {Minor}
 * @throws {RunwayError} E_SCHEMA (d ≤ 0, неизвестный режим), E_NOT_INTEGER, E_OVERFLOW
 */
export function round_div(n, d, mode = 'half_even') {
  check_mode(mode);
  if (typeof n === 'bigint' || typeof d === 'bigint') {
    return assert_minor(round_div_big(to_big(n), to_big(d), mode));
  }
  const x = assert_minor(n);
  const y = pos_divisor(d);
  const q = floor_div(x, y);
  const r = floor_mod(x, y);
  const t = 2 * r; // r < y ≤ 2^53−1, удвоение точное
  switch (mode) {
    case 'floor': return q;
    case 'ceil': return r > 0 ? q + 1 : q;
    case 'half_even':
      if (t < y) return q;
      if (t > y) return q + 1;
      return q % 2 === 0 ? q : q + 1;
    default: // half_up (от нуля)
      if (t > y) return q + 1;
      if (t === y) return x >= 0 ? q + 1 : q;
      return q;
  }
}

/**
 * Умножение с последующим делением `round_div(a·num, den, mode)`; произведение считается в BigInt.
 * @param {Minor} a
 * @param {Minor} num
 * @param {Minor} den знаменатель > 0
 * @param {RoundMode} [mode] по умолчанию `half_even`
 * @returns {Minor}
 * @throws {RunwayError} E_OVERFLOW, если результат вне safe-integer
 */
export function mul_div(a, num, den, mode = 'half_even') {
  check_mode(mode);
  return assert_minor(round_div_big(to_big(a) * to_big(num), to_big(den), mode));
}

/**
 * Разделить сумму на n равных частей; лишние minor — первым частям.
 * Для total < 0 — по модулю с обратным знаком (первые части «больше по модулю»).
 * @param {Minor} total
 * @param {number} n число частей ≥ 1
 * @returns {Minor[]}
 */
export function split_equal(total, n) {
  const t = assert_minor(total);
  const parts = assert_minor(n);
  if (parts < 1) fail('E_SCHEMA', { reason: 'parts_lt_1', value: parts });
  if (parts > MAX_PARTS) fail('E_SCHEMA', { reason: 'too_many_parts', value: parts });
  const neg = t < 0;
  const abs = neg ? -t : t;
  const base = floor_div(abs, parts);
  const rem = floor_mod(abs, parts);
  const out = new Array(parts);
  for (let k = 0; k < parts; k++) {
    const v = k < rem ? base + 1 : base;
    out[k] = neg ? 0 - v : v;
  }
  return out;
}

/**
 * Разделить сумму по весам методом наибольших остатков: лишние minor отдаются
 * индексам с наибольшей дробной частью, при равенстве — меньшему индексу. Σ частей = total.
 * @param {Minor} total
 * @param {number[]} weights целые ≥ 0, сумма > 0
 * @returns {Minor[]}
 */
export function split_largest_remainder(total, weights) {
  const t0 = assert_minor(total);
  if (!Array.isArray(weights) || weights.length === 0) fail('E_SCHEMA', { reason: 'weights_empty' });
  const w = weights.map((x) => {
    const v = assert_minor(x);
    if (v < 0) fail('E_SCHEMA', { reason: 'weight_negative', value: v });
    return BigInt(v);
  });
  const sum_w = w.reduce((a, b) => a + b, 0n);
  if (sum_w <= 0n) fail('E_SCHEMA', { reason: 'weights_sum_not_positive' });
  const neg = t0 < 0;
  const t = BigInt(neg ? -t0 : t0);
  const base = [];
  const frac = [];
  let used = 0n;
  for (const wk of w) {
    const prod = t * wk;
    const b = prod / sum_w;
    base.push(b);
    frac.push(prod % sum_w);
    used += b;
  }
  const rest = Number(t - used);
  const order = w.map((_, k) => k).sort((i, j) => (frac[i] === frac[j] ? i - j : frac[i] > frac[j] ? -1 : 1));
  for (let r = 0; r < rest; r++) base[order[r]] += 1n;
  return base.map((b) => (neg ? 0 - Number(b) : Number(b)));
}

/**
 * Сумма минорных единиц с проверкой переполнения на каждом шаге.
 * @param {Minor[]} xs
 * @returns {Minor}
 */
export function sum_minor(xs) {
  let acc = 0;
  for (const x of xs) {
    acc += assert_minor(x);
    if (!Number.isSafeInteger(acc)) fail('E_OVERFLOW', { reason: 'sum' });
  }
  return acc + 0;
}

/**
 * Наибольший общий делитель (BigInt, неотрицательный). `gcd(0, 0) = 0n`.
 * @param {Minor|bigint} a
 * @param {Minor|bigint} b
 * @returns {bigint}
 */
export function gcd(a, b) {
  let x = to_big(a);
  let y = to_big(b);
  if (x < 0n) x = -x;
  if (y < 0n) y = -y;
  while (y !== 0n) { [x, y] = [y, x % y]; }
  return x;
}

// ── реестр валют ───────────────────────────────────────────────────────────────
// Единственное изменяемое состояние модуля — реестр кодов валют (канон: `register_currency`).
// Встроенные записи — малый набор ISO 4217 и крипты; остальное регистрирует вызывающий.

/** @type {Map<string, {exponent: number, kind: 'fiat'|'crypto'}>} */
const CURRENCIES = new Map();
{
  const fiat2 = ['EUR', 'USD', 'GBP', 'CHF', 'RUB', 'UAH', 'PLN', 'CZK', 'SEK', 'NOK', 'DKK', 'CNY', 'TRY', 'KZT',
    'GEL', 'AMD', 'BYN', 'CAD', 'AUD', 'NZD', 'HUF', 'RON', 'BGN', 'RSD', 'AED', 'ILS', 'INR', 'BRL', 'MXN', 'ARS',
    'ZAR', 'SGD', 'HKD', 'THB', 'MDL', 'AZN', 'UZS'];
  for (const c of fiat2) CURRENCIES.set(c, { exponent: 2, kind: 'fiat' });
  for (const c of ['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'UGX']) CURRENCIES.set(c, { exponent: 0, kind: 'fiat' });
  for (const c of ['KWD', 'BHD', 'JOD', 'TND', 'OMR']) CURRENCIES.set(c, { exponent: 3, kind: 'fiat' });
  CURRENCIES.set('BTC', { exponent: 8, kind: 'crypto' });
  CURRENCIES.set('LTC', { exponent: 8, kind: 'crypto' });
  CURRENCIES.set('USDT', { exponent: 6, kind: 'crypto' });
  CURRENCIES.set('USDC', { exponent: 6, kind: 'crypto' });
}

/**
 * Число знаков минорной единицы валюты.
 * @param {string} code код валюты (`EUR`, `BTC`…)
 * @returns {number}
 * @throws {RunwayError} E_SCHEMA — валюта не зарегистрирована
 */
export function currency_exponent(code) {
  const c = typeof code === 'string' ? CURRENCIES.get(code) : undefined;
  if (c === undefined) fail('E_SCHEMA', { reason: 'unknown_currency', code: String(code) });
  return c.exponent;
}

/**
 * Вид валюты (`fiat` | `crypto`) из реестра.
 * @param {string} code
 * @returns {'fiat'|'crypto'}
 */
export function currency_kind(code) {
  const c = typeof code === 'string' ? CURRENCIES.get(code) : undefined;
  if (c === undefined) fail('E_SCHEMA', { reason: 'unknown_currency', code: String(code) });
  return c.kind;
}

/**
 * Зарегистрировать валюту. Повторная регистрация с теми же параметрами допустима (идемпотентна),
 * с другими — ошибка (иначе суммы поменяли бы смысл).
 * @param {string} code `^[A-Z][A-Z0-9]{1,9}$`
 * @param {number} exponent 0…18
 * @param {'fiat'|'crypto'} [kind]
 * @returns {void}
 */
export function register_currency(code, exponent, kind = 'fiat') {
  if (typeof code !== 'string' || !/^[A-Z][A-Z0-9]{1,9}$/.test(code)) fail('E_SCHEMA', { reason: 'bad_currency_code', code: String(code) });
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 18) fail('E_SCHEMA', { reason: 'bad_exponent', exponent: String(exponent) });
  if (kind !== 'fiat' && kind !== 'crypto') fail('E_SCHEMA', { reason: 'bad_currency_kind', kind: String(kind) });
  const old = CURRENCIES.get(code);
  if (old !== undefined && (old.exponent !== exponent || old.kind !== kind)) {
    fail('E_SCHEMA', { reason: 'currency_conflict', code });
  }
  CURRENCIES.set(code, { exponent, kind });
}

// ── разбор и форматирование без Intl ───────────────────────────────────────────

/** Пресеты формата чисел (`Workspace.number_format`); для ru разделитель тысяч — обычный пробел, как в каноне §9.11. */
export const NUMBER_FORMATS = Object.freeze({
  ru: Object.freeze({ decimal: ',', thousands: ' ' }),
  en: Object.freeze({ decimal: '.', thousands: ',' }),
});

const SPACE_LIKE = new Set([' ', ' ', ' ', ' ']);

function escape_re(ch) {
  return ch.replace(/[.*+?^${}()|[\]\\\-]/g, '\\$&');
}

/**
 * Разобрать десятичную строку в minor units без float.
 * Допускается знак (`-`, `+`, `−`), группы тысяч строго по три цифры, не более `exponent` знаков дроби.
 * @param {string} str
 * @param {{decimal?: string, thousands?: string, exponent: number}} opts
 * @returns {Minor}
 * @throws {RunwayError} E_NOT_INTEGER (мусор, пусто, лишние знаки дроби), E_OVERFLOW
 */
export function parse_minor(str, opts) {
  const { decimal = '.', thousands = '', exponent } = opts ?? {};
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 18) fail('E_SCHEMA', { reason: 'bad_exponent', exponent: String(exponent) });
  if (typeof decimal !== 'string' || decimal.length !== 1 || /[0-9+\-−]/.test(decimal)) fail('E_SCHEMA', { reason: 'bad_decimal' });
  if (typeof thousands !== 'string' || thousands.length > 1 || /[0-9+\-−]/.test(thousands) || thousands === decimal) fail('E_SCHEMA', { reason: 'bad_thousands' });
  if (typeof str !== 'string') fail('E_NOT_INTEGER', { reason: 'not_a_string' });
  let s = str.trim();
  let neg = false;
  if (s[0] === '-' || s[0] === '+' || s[0] === '−') { neg = s[0] !== '+'; s = s.slice(1); }
  if (thousands !== '' && SPACE_LIKE.has(thousands)) {
    s = s.replace(/[   ]/g, thousands); // неразрывные пробелы приводим к заданному
  }
  const parts = s.split(decimal);
  if (parts.length > 2) fail('E_NOT_INTEGER', { reason: 'two_decimal_marks', input: str });
  const int_raw = parts[0];
  const frac = parts.length === 2 ? parts[1] : '';
  let int_digits;
  if (/^[0-9]*$/.test(int_raw)) int_digits = int_raw;
  else if (thousands !== '' && new RegExp('^[0-9]{1,3}(?:' + escape_re(thousands) + '[0-9]{3})+$').test(int_raw)) {
    int_digits = int_raw.split(thousands).join('');
  } else fail('E_NOT_INTEGER', { reason: 'bad_integer_part', input: str });
  if (parts.length === 2 && !/^[0-9]+$/.test(frac)) fail('E_NOT_INTEGER', { reason: 'bad_fraction', input: str });
  if (int_digits === '' && parts.length === 1) fail('E_NOT_INTEGER', { reason: 'empty', input: str });
  if (frac.length > exponent) fail('E_NOT_INTEGER', { reason: 'too_many_decimals', input: str });
  const mag = BigInt((int_digits === '' ? '0' : int_digits) + frac.padEnd(exponent, '0'));
  return assert_minor(neg ? -mag : mag);
}

/**
 * Отформатировать minor units в десятичную строку без Intl: знак `-`, группы тысяч, дробь из `exponent` знаков.
 * @param {Minor} a
 * @param {number} exponent число знаков минорной единицы
 * @param {{decimal?: string, thousands?: string}} [opts] по умолчанию `{decimal: '.', thousands: ''}`
 * @returns {string}
 */
export function format_minor(a, exponent, opts) {
  const { decimal = '.', thousands = '' } = opts ?? {};
  const v = assert_minor(a);
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 18) fail('E_SCHEMA', { reason: 'bad_exponent', exponent: String(exponent) });
  let digits = BigInt(v < 0 ? -v : v).toString();
  let frac = '';
  if (exponent > 0) {
    digits = digits.padStart(exponent + 1, '0');
    frac = digits.slice(-exponent);
    digits = digits.slice(0, -exponent);
  }
  if (thousands !== '') {
    let grouped = '';
    for (let i = 0; i < digits.length; i++) {
      if (i > 0 && (digits.length - i) % 3 === 0) grouped += thousands;
      grouped += digits[i];
    }
    digits = grouped;
  }
  return (v < 0 ? '-' : '') + digits + (exponent > 0 ? decimal + frac : '');
}
