// number_format.mjs — формат чисел и дат отдельно от языка интерфейса (REQ-112, FP-03).
// Язык (`ru`/`en`) задаёт слова, порядок символа валюты и названия месяцев; формат чисел и дат — отдельная настройка рабочей области
// `ws.number_format = {decimal, thousands, date}` (канон §3.1, все поля необязательны, `decimal` и `thousands` — только парой).
// Внутри данных остаются целые minor units и даты ISO: этот модуль только показывает и разбирает.
// Пример: язык `ru` + формат «1.234,50» → 123450 показывается как «1.234,50 €» и разбирается обратно в 123450.
//
// Модуль чистый: без DOM и без часов; импортируется в Node. Данные из файла — недоверенные: `number_format` из чужого JSON проходит
// `sanitize_number_format`, неизвестные ключи и значения отбрасывают настройку целиком (показ возвращается к формату языка).

import { parse_minor, format_minor, currency_exponent, round_div, parse_date, format_date, fail } from '../engine/index.mjs';
import { render_value } from '../engine/verifier.mjs';
import { MONTHS_SHORT, word_form } from './i18n.mjs';

const NBSP = ' ';
const MINUS = '−';
const CUR_SYMBOLS = Object.freeze({ EUR: '€', USD: '$', GBP: '£', RUB: '₽' });
const SYMBOL_RE = /[€$£₽]/g;

/** Допустимые десятичные знаки и разделители тысяч (в хранении пробел — обычный, при показе он становится неразрывным). */
export const DECIMALS = Object.freeze([',', '.']);
export const THOUSANDS = Object.freeze(['', ' ', ',', '.']);

/** Стили дат: `auto` — по языку («4 октября»), `iso` — 2026-10-04, `dmy` — 04.10.2026, `mdy` — 10/04/2026. */
export const DATE_STYLES = Object.freeze(['auto', 'iso', 'dmy', 'mdy']);

/** Пресеты чисел для выбора в настройках (`auto` — следовать языку интерфейса). */
export const NUMBER_PRESETS = Object.freeze({
  auto: null,
  space_comma: Object.freeze({ decimal: ',', thousands: ' ' }),
  comma_dot: Object.freeze({ decimal: '.', thousands: ',' }),
  dot_comma: Object.freeze({ decimal: ',', thousands: '.' }),
  plain_dot: Object.freeze({ decimal: '.', thousands: '' }),
  plain_comma: Object.freeze({ decimal: ',', thousands: '' }),
});

/** Формат чисел по умолчанию для языка (совпадает с `render_value` верификатора). */
const LANG_DEFAULT = Object.freeze({
  ru: Object.freeze({ decimal: ',', thousands: ' ' }),
  en: Object.freeze({ decimal: '.', thousands: ',' }),
});

const is_plain = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const pad2 = (n) => String(n).padStart(2, '0');

// ── проверка и нормализация настройки ──────────────────────────────────────────────────────────────────────────────

/**
 * Строгая проверка настройки (для правки) и нормализация: `{ok: true, value}` (`value = null`, если ничего не задано) или `{ok: false, field, reason}`.
 * @param {any} x
 * @returns {{ok: true, value: {decimal?: string, thousands?: string, date?: string}|null}|{ok: false, field: string, reason: string}}
 */
export function validate_number_format(x) {
  if (!is_plain(x)) return { ok: false, field: 'number_format', reason: 'not_object' };
  for (const k of Object.keys(x)) if (k !== 'decimal' && k !== 'thousands' && k !== 'date') return { ok: false, field: 'number_format.' + k.slice(0, 40), reason: 'unknown_field' };
  const out = {};
  const has_dec = Object.hasOwn(x, 'decimal');
  const has_th = Object.hasOwn(x, 'thousands');
  if (has_dec || has_th) {
    if (!(has_dec && has_th)) return { ok: false, field: has_dec ? 'number_format.thousands' : 'number_format.decimal', reason: 'pair_required' };
    if (!DECIMALS.includes(x.decimal)) return { ok: false, field: 'number_format.decimal', reason: 'bad_value' };
    if (!THOUSANDS.includes(x.thousands)) return { ok: false, field: 'number_format.thousands', reason: 'bad_value' };
    if (x.thousands === x.decimal) return { ok: false, field: 'number_format.thousands', reason: 'same_separator' };
    out.decimal = x.decimal;
    out.thousands = x.thousands;
  }
  if (Object.hasOwn(x, 'date')) {
    if (!DATE_STYLES.includes(x.date)) return { ok: false, field: 'number_format.date', reason: 'bad_value' };
    if (x.date !== 'auto') out.date = x.date;
  }
  return { ok: true, value: Object.keys(out).length === 0 ? null : out };
}

/** Настройка из рабочей области (в том числе чужой): нормализованная или `null`, если её нет либо она недопустима. */
export function sanitize_number_format(x) {
  const r = validate_number_format(x);
  return r.ok ? r.value : null;
}

/**
 * Действующий формат: поля настройки, недостающее — по языку.
 * @param {'ru'|'en'} lang
 * @param {any} nf `ws.number_format`
 * @returns {{decimal: string, thousands: string, date: string}}
 */
export function resolve_number_format(lang, nf) {
  const base = LANG_DEFAULT[lang] ?? LANG_DEFAULT.ru;
  const s = sanitize_number_format(nf);
  return { decimal: s?.decimal ?? base.decimal, thousands: s?.thousands ?? base.thousands, date: s?.date ?? 'auto' };
}

/** Идентификатор пресета чисел: `auto` (следовать языку), имя из `NUMBER_PRESETS` или `custom` (допустимая комбинация, которой нет в списке). */
export function preset_of(nf) {
  const s = sanitize_number_format(nf);
  if (s === null || s.decimal === undefined) return 'auto';
  for (const [id, p] of Object.entries(NUMBER_PRESETS)) if (p !== null && p.decimal === s.decimal && p.thousands === s.thousands) return id;
  return 'custom';
}

/** Стиль дат из настройки (`auto`, если не задан). */
export function date_style_of(nf) {
  return sanitize_number_format(nf)?.date ?? 'auto';
}

/**
 * Правка `set_number_format` для `ws_edit.register_edit`: `{type, number_format: {decimal?, thousands?, date?} | null}`; `null` или пустая
 * настройка возвращают показ к формату языка (ключ убирается). Больше в рабочей области ничего не меняется: суммы и даты остаются прежними.
 * @param {object} ws
 * @param {{type: string, number_format: any}} edit
 * @returns {object} новая рабочая область
 * @throws {RunwayError} E_SCHEMA с `{field, reason}`
 */
export function edit_set_number_format(ws, edit) {
  for (const k of Object.keys(edit)) if (k !== 'type' && k !== 'number_format') fail('E_SCHEMA', { field: 'edit.' + k.slice(0, 40), reason: 'unknown_field' });
  if (!Object.hasOwn(edit, 'number_format')) fail('E_SCHEMA', { field: 'number_format', reason: 'required' });
  let value = null;
  if (edit.number_format !== null) {
    const r = validate_number_format(edit.number_format);
    if (!r.ok) fail('E_SCHEMA', { field: r.field, reason: r.reason });
    value = r.value;
  }
  const next = { ...ws };
  if (value === null) delete next.number_format;
  else next.number_format = value;
  return next;
}

// ── показ ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Процент из базисных пунктов: «41,47 %», «170 %» (знак дроби — из формата). */
function pct_bp(v, decimal) {
  const neg = v < 0;
  const abs = Math.abs(v);
  const frac = abs % 100;
  let s = String(Math.floor(abs / 100));
  if (frac !== 0) s += decimal + (frac % 10 === 0 ? String(frac / 10) : String(frac).padStart(2, '0'));
  return (neg ? MINUS : '') + s + NBSP + '%';
}

/**
 * Форматтеры интерфейса с учётом `number_format`: тот же набор, что у `make_fmt` приложения (`money`, `money0`, `date`, `short`, `pm`, `bp`,
 * `days`, `exp`). Без настройки результат равен `make_fmt(lang, cur, as_of_iso)`.
 * @param {'ru'|'en'} lang
 * @param {string} cur код валюты решения
 * @param {string} as_of_iso дата расчёта `YYYY-MM-DD` (год даты показывается, только если он отличается; для числовых стилей — всегда)
 * @param {any} [nf] `ws.number_format`
 */
export function make_nf_fmt(lang, cur, as_of_iso, nf) {
  const r = resolve_number_format(lang, nf);
  const exp = currency_exponent(cur);
  const sep = { decimal: r.decimal, thousands: r.thousands === ' ' ? NBSP : r.thousands };
  const iso_of = (x) => (typeof x === 'number' ? format_date(x) : x);
  const money_dp = (v, dp) => {
    const neg = v < 0;
    let abs = Math.abs(v);
    if (dp < exp) abs = round_div(abs, 10 ** (exp - dp), 'half_even');
    const num = format_minor(abs, dp, sep);
    const sign = neg && abs !== 0 ? MINUS : '';
    const sym = CUR_SYMBOLS[cur];
    if (sym === undefined) return sign + num + NBSP + cur;
    return lang === 'en' ? sign + sym + num : sign + num + NBSP + sym;
  };
  const parts = (x) => {
    const iso = iso_of(x);
    return { iso, y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)), d: Number(iso.slice(8, 10)) };
  };
  const date = (x) => {
    const p = parts(x);
    if (r.date === 'iso') return p.iso;
    if (r.date === 'dmy') return pad2(p.d) + '.' + pad2(p.m) + '.' + p.y;
    if (r.date === 'mdy') return pad2(p.m) + '/' + pad2(p.d) + '/' + p.y;
    return render_value({ kind: 'date', v: p.iso }, lang, as_of_iso);
  };
  const short = (x) => {
    const p = parts(x);
    const other_year = String(p.y) !== as_of_iso.slice(0, 4);
    if (r.date === 'iso') return other_year ? p.iso : pad2(p.m) + '-' + pad2(p.d);
    if (r.date === 'dmy') return pad2(p.d) + '.' + pad2(p.m) + (other_year ? '.' + p.y : '');
    if (r.date === 'mdy') return pad2(p.m) + '/' + pad2(p.d) + (other_year ? '/' + p.y : '');
    const mon = MONTHS_SHORT[lang][p.m - 1];
    const tail = other_year ? (lang === 'ru' ? ' ' : ', ') + p.y : '';
    return (lang === 'ru' ? p.d + ' ' + mon : mon + ' ' + p.d) + tail;
  };
  const pm = (v) => (v < 0 ? MINUS : '') + Math.floor(Math.abs(v) / 10) + r.decimal + (Math.abs(v) % 10) + NBSP + '%';
  return {
    money: (v) => money_dp(v, exp), money0: (v) => money_dp(v, 0), date, short, pm, bp: (v) => pct_bp(v, r.decimal),
    days: (n) => n + ' ' + word_form(lang, 'day', n), exp,
  };
}

/** Число для поля ввода: десятичный знак из формата, без групп тысяч и без символа валюты; `trim` убирает нулевую дробь («490,00» → «490»). */
export function format_input_amount(minor, exponent, nf_resolved, trim = false) {
  const s = format_minor(minor, exponent, { decimal: nf_resolved.decimal });
  if (!trim || exponent === 0) return s;
  const cut = s.endsWith(nf_resolved.decimal + '0'.repeat(exponent));
  return cut ? s.slice(0, s.length - exponent - 1) : s;
}

/** Пример для предпросмотра формата: сумма, отрицательная сумма и дата в выбранном формате. */
export function format_preview(lang, cur, as_of_iso, nf) {
  const f = make_nf_fmt(lang, cur, as_of_iso, nf);
  return { money: f.money(123450), negative: f.money(-9000), date: f.date('2026-10-04') };
}

// ── разбор ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Разобрать десятичное число по формату без float: группы тысяч — только те, что заданы форматом, строго по три цифры (TST-51); неразрывные пробелы
 * приравниваются к обычному, если разделитель тысяч — пробел. Знак и символ валюты/процента по краям допускаются отдельно (`negative`).
 * @param {string} text
 * @param {{exponent: number, lang?: 'ru'|'en', nf?: any, negative?: boolean}} o
 * @returns {{ok: true, value: number}|{ok: false, reason: 'empty'|'bad_number'|'negative'|'too_big'}}
 */
export function parse_decimal_text(text, o) {
  if (typeof text !== 'string') return { ok: false, reason: 'bad_number' };
  const r = resolve_number_format(o.lang ?? 'ru', o.nf);
  let s = text.trim();
  if (s === '') return { ok: false, reason: 'empty' };
  let v;
  try {
    v = parse_minor(s, { decimal: r.decimal, thousands: r.thousands, exponent: o.exponent });
  } catch (e) {
    return { ok: false, reason: e?.code === 'E_OVERFLOW' ? 'too_big' : 'bad_number' };
  }
  if (v < 0 && o.negative !== true) return { ok: false, reason: 'negative' };
  return { ok: true, value: v + 0 };
}

/**
 * Разобрать сумму в minor units валюты: «1.234,50 €» при формате `1.234,50` → 123450. Символ валюты (или её код) по краям отбрасывается.
 * @param {string} text
 * @param {string} cur
 * @param {'ru'|'en'} lang
 * @param {any} [nf]
 * @param {{negative?: boolean}} [o]
 */
export function parse_amount_text(text, cur, lang, nf, o = {}) {
  const exponent = currency_exponent(cur);
  if (typeof text !== 'string') return { ok: false, reason: 'bad_number' };
  const code = new RegExp('^\\s*' + cur + '\\s*|\\s*' + cur + '\\s*$', 'i');
  return parse_decimal_text(text.replace(SYMBOL_RE, '').replace(code, ''), { exponent, lang, nf, negative: o.negative === true });
}

/** Разобрать дату в выбранном стиле (`iso`, `dmy`, `mdy`; для `auto` — ISO и порядок языка) → ISO или `null`. Несуществующие даты отвергаются. */
export function parse_date_text(text, lang, nf) {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  let style = date_style_of(nf);
  if (style === 'auto') style = /^\d{4}-/.test(s) ? 'iso' : (lang === 'en' ? 'mdy' : 'dmy');
  let y; let m; let d;
  let mt;
  if (style === 'iso') {
    mt = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    if (mt === null) return null;
    [, y, m, d] = mt;
  } else if (style === 'dmy') {
    mt = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
    if (mt === null) return null;
    [, d, m, y] = mt;
  } else {
    mt = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (mt === null) return null;
    [, m, d, y] = mt;
  }
  const iso = y + '-' + pad2(m) + '-' + pad2(d);
  try {
    return format_date(parse_date(iso)) === iso ? iso : null;
  } catch {
    return null;
  }
}
