// io.mjs — ввод-вывод данных: CSV (RFC 4180) и профили банков, сухой прогон, импорт-партии, JSON-копия, CSV журнала, hledger (ALG-14).
// Канон: design-brief §3.9, §5, §14 B4; canon-decisions «Финальные сигнатуры» (io.mjs); ALG-14; product/09-import-export; ADR-011.
// Зависимости: ТОЛЬКО ledger, dates, money (§14 B4). Модуль чистый: ни часов, ни случайности, ни файловой системы;
// идентификаторы, `seq` и время записей приходят аргументом `ctx` (порты). Расчёт и экспорт — по введённым данным, не консультация.
//
// Допущения прототипа (расхождения с текстом канона перечислены в отчёте spec_issues):
//  * `export_json` принимает ЖУРНАЛ (массив записей или `{events}`), а не `State`: «полный журнал по порядку seq» из State не восстановить.
//  * `export_hledger` не может сам развернуть правила и потоки (io не зависит от recurrence/timeline): плановые события приходят
//    портом `opts.planned` (результат `build_events` в режиме `plan`); без него экспортируются только разовые `plan.set` из State.
//  * Встроенный профиль `runway-csv/1` (C-045) выражается данными: `amount.unit = 'minor'`, `desc.csv_safe = true`, `filter`.

import { fail, assert_minor, parse_minor, format_minor, currency_exponent } from './money.mjs';
import { parse_date, format_date, days_from_civil, days_in_month, civil_from_days, dow, to_epoch_day } from './dates.mjs';
import { canon, sha256, norm, dedup_key, reduce, effective_events, make_event } from './ledger.mjs';
import { vdefault as vd } from './param_defaults.mjs';

/** @typedef {import('./money.mjs').Minor} Minor */
/** @typedef {import('./dates.mjs').EpochDay} EpochDay */
/** @typedef {import('./ledger.mjs').LedgerEvent} LedgerEvent */

/** Формат файла-копии. */
export const JOURNAL_FORMAT = 'runway-journal/1';
/** Предел размера файла импорта, байт (REQ-091). */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

// ── CSV: разбор ───────────────────────────────────────────────────────────────

/**
 * Определить разделитель по первой записи файла (вне кавычек): `;`, `,` или TAB — тот, которого больше; при равенстве `,`.
 * @param {string} text
 * @returns {',' | ';' | '\t'}
 */
export function detect_delimiter(text) {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const count = { ';': 0, ',': 0, '\t': 0 };
  let in_q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') { in_q = !in_q; continue; }
    if (in_q) continue;
    if (ch === '\n' || ch === '\r') break;
    if (ch in count) count[ch] += 1;
  }
  let best = ',';
  for (const d of [',', ';', '\t']) if (count[d] > count[best]) best = d;
  return /** @type {any} */ (best);
}

/**
 * Разбор CSV по RFC 4180 с допусками: BOM снимается, CRLF/LF/CR — один разрыв, кавычка открывает поле только в его начале,
 * `""` внутри кавычек — литерал, переводы строк внутри кавычек сохраняются. Пустые строки (все поля пусты) отбрасываются.
 * @param {string} text
 * @param {{delimiter?: string}} [opts] `delimiter`: один символ (`,` по умолчанию, `;`, TAB) либо `'auto'`
 * @returns {string[][]}
 * @throws {RunwayError} E_SCHEMA (`unterminated_quote`, плохой разделитель)
 */
export function parse_csv(text, opts) {
  if (typeof text !== 'string') fail('E_SCHEMA', { reason: 'csv_text_not_string' });
  let delimiter = opts?.delimiter ?? ',';
  if (delimiter === 'auto') delimiter = detect_delimiter(text);
  if (typeof delimiter !== 'string' || delimiter.length !== 1 || delimiter === '"' || delimiter === '\n' || delimiter === '\r') {
    fail('E_SCHEMA', { reason: 'bad_delimiter' });
  }
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let in_q = false;
  let field = '';
  let row = [];
  const rows = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (in_q) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 1; } else in_q = false;
      } else field += ch;
    } else if (ch === '"' && field === '') {
      in_q = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (in_q) fail('E_SCHEMA', { reason: 'unterminated_quote' });
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f !== ''));
}

/**
 * Разбор даты по шаблону: токены `YYYY` (4 цифры), `MM`/`DD` (2 цифры), `M`/`D` (1–2 цифры), прочее — литерал.
 * @param {string} s
 * @param {string} fmt
 * @returns {EpochDay|null} `null`, если не совпало, остался хвост или даты не существует (`31/02/2026`)
 */
export function parse_date_fmt(s, fmt) {
  if (typeof s !== 'string' || typeof fmt !== 'string') return null;
  let i = 0;
  let y = null;
  let m = null;
  let d = null;
  const take = (re) => { const t = re.exec(s.slice(i)); if (t === null) return null; i += t[0].length; return Number(t[0]); };
  for (let j = 0; j < fmt.length;) {
    if (fmt.startsWith('YYYY', j)) { y = take(/^\d{4}/); j += 4; if (y === null) return null; }
    else if (fmt.startsWith('MM', j)) { m = take(/^\d{2}/); j += 2; if (m === null) return null; }
    else if (fmt.startsWith('DD', j)) { d = take(/^\d{2}/); j += 2; if (d === null) return null; }
    else if (fmt[j] === 'M') { m = take(/^\d{1,2}/); j += 1; if (m === null) return null; }
    else if (fmt[j] === 'D') { d = take(/^\d{1,2}/); j += 1; if (d === null) return null; }
    else {
      if (s[i] !== fmt[j]) return null;
      i += 1;
      j += 1;
    }
  }
  if (i !== s.length || y === null || m === null || d === null) return null;
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > days_in_month(y, m)) return null;
  return days_from_civil(y, m, d);
}

const WS_SEP = '   ';

/**
 * Группы тысяч целой части ячейки: если разделитель встречается, то целая часть (без знака) — `\d{1,3}(?:SEP\d{3})+`, а дробь (после
 * десятичного знака) — только цифры. Без разделителя в целой части проверять нечего (ячейка идёт в `parse_minor` как раньше).
 * Двусмысленная запись (десятичный знак совпадает с разделителем или встречается дважды) отвергается.
 * @param {string} raw ячейка после trim и замены U+2212
 * @param {string} thousands
 * @param {string} decimal
 * @returns {boolean}
 */
function groups_ok(raw, thousands, decimal) {
  const is_ws = [...thousands].every((c) => WS_SEP.includes(c));
  const sep_in = (str) => (is_ws ? [...str].some((c) => WS_SEP.includes(c)) : str.includes(thousands));
  if (!sep_in(raw)) return true;
  if (decimal !== '' && decimal === thousands) return false;
  const body = raw.replace(/^[-+]/, '');
  const di = decimal === '' ? -1 : body.indexOf(decimal);
  if (di !== -1 && body.indexOf(decimal, di + 1) !== -1) return false;
  const int_part = di === -1 ? body : body.slice(0, di);
  const frac_part = di === -1 ? '' : body.slice(di + decimal.length);
  if (!/^\d*$/.test(frac_part)) return false;
  const groups = is_ws ? int_part.split(/[   ]/) : int_part.split(thousands);
  if (groups.length < 2) return true; // разделитель только в дроби: дальше решит parse_minor
  if (!/^\d{1,3}$/.test(groups[0])) return false;
  return groups.slice(1).every((g) => /^\d{3}$/.test(g));
}

/**
 * Разбор ячейки суммы профиля: пробелы-разделители и знак «−» (U+2212) нормализуются, разделитель тысяч удаляется,
 * затем `parse_minor` (знаков дроби больше `exp` — ошибка, округления нет).
 * @param {string} s
 * @param {{decimal?: string, thousands?: string}} a поля `amount` профиля
 * @param {number} exp число знаков валюты
 * @returns {Minor|null} `null` для пустого, мусора и слишком длинной дроби
 */
export function parse_amount_cell(s, a, exp) {
  if (typeof s !== 'string') return null;
  const thousands = a?.thousands ?? '';
  const raw = s.trim().replace(/−/g, '-');
  // Строгие группы тысяч (Q-05, К-32): при заданном разделителе число с ним — группы РОВНО по три цифры (первая 1–3); «12,50» при
  // thousands = «,» — не 1250,00, а отказ (bad_amount). Тот же контроль для пробельного разделителя (обычный пробел, NBSP, U+202F).
  if (thousands !== '' && !groups_ok(raw, thousands, a?.decimal ?? '.')) return null;
  let t = raw.replace(/[  ]/g, '');
  if (thousands !== '') t = t.split(thousands).join('');
  try {
    return parse_minor(t, { decimal: a?.decimal ?? '.', thousands: '', exponent: exp });
  } catch (e) {
    if (e?.name === 'RunwayError' && (e.code === 'E_NOT_INTEGER' || e.code === 'E_OVERFLOW')) return null;
    throw e;
  }
}

/**
 * Литеральное правило метки (без regex — профиль это данные, ReDoS исключён): при ведущем `^` — префикс, иначе подстрока;
 * сравнивается нормализованная форма.
 * @param {{match: string}} rule
 * @param {string} nd `norm(desc)`
 * @returns {boolean}
 */
export function rule_matches(rule, nd) {
  const m = rule.match;
  const anchored = m.startsWith('^');
  const p = norm(anchored ? m.slice(1) : m);
  return p !== '' && (anchored ? nd.startsWith(p) : nd.includes(p));
}

// ── Профиль CSV ───────────────────────────────────────────────────────────────

const PROFILE_KEYS = new Set(['profile_id', 'v', 'encoding', 'delimiter', 'skip', 'date', 'amount', 'currency', 'desc', 'rules', 'filter', 'tag', 'counterparty']);
const CURRENCY_RE = /^[A-Z][A-Z0-9]{1,9}$/;

/**
 * Встроенный профиль CSV журнала Runway `runway-csv/1` (C-045): сумма — целые minor units, ведущий `'` у текстовых ячеек снимается,
 * строки планов (`layer ≠ posted`) отфильтровываются. Метка (`tag`) и контрагент (`counterparty`) читаются из своих колонок, если они есть в
 * заголовке (REQ-095, FP-47); номер счёта (`account_id`) и вид (`kind`) файла не читаются — решение владельца. Только данные.
 */
export const RUNWAY_CSV_PROFILE = Object.freeze({
  profile_id: 'runway-csv/1',
  v: 1,
  encoding: 'utf-8',
  delimiter: ',',
  skip: 0,
  date: Object.freeze({ col: 'date', fmt: 'YYYY-MM-DD' }),
  amount: Object.freeze({ mode: 'signed', col: 'amount_minor', unit: 'minor' }),
  currency: Object.freeze({ col: 'currency' }),
  desc: Object.freeze({ cols: Object.freeze(['note']), csv_safe: true }),
  rules: Object.freeze([]),
  filter: Object.freeze({ col: 'layer', equals: 'posted' }),
  tag: Object.freeze({ col: 'tag', csv_safe: true, optional: true }),
  counterparty: Object.freeze({ col: 'counterparty', csv_safe: true, optional: true }),
});

const is_col = (c) => (typeof c === 'string' && c !== '') || (Number.isInteger(c) && c >= 0);

/**
 * Проверка профиля: только известные поля, никаких исполняемых значений. Не бросает исключений.
 * @param {object} profile
 * @returns {{ok: boolean, errors: {field: string, reason: string}[]}}
 */
export function validate_profile(profile) {
  const errors = [];
  const bad = (field, reason) => errors.push({ field, reason });
  const only = (obj, allowed, where) => {
    for (const k of Object.keys(obj)) if (!allowed.has(k)) bad(where + '.' + k, 'unknown_field');
  };
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) return { ok: false, errors: [{ field: '', reason: 'not_object' }] };
  for (const k of Object.keys(profile)) if (!PROFILE_KEYS.has(k)) bad(k, 'unknown_field');
  if (profile.profile_id !== undefined && typeof profile.profile_id !== 'string') bad('profile_id', 'not_string');
  if (profile.v !== undefined && profile.v !== 1) bad('v', 'unsupported_version');
  if (profile.encoding !== undefined && typeof profile.encoding !== 'string') bad('encoding', 'not_string');
  if (![',', ';', '\t'].includes(profile.delimiter)) bad('delimiter', 'must_be_comma_semicolon_or_tab');
  if (profile.skip !== undefined && !(Number.isInteger(profile.skip) && profile.skip >= 0)) bad('skip', 'not_nonneg_int');

  const d = profile.date;
  if (d === null || typeof d !== 'object') bad('date', 'required_object');
  else {
    only(d, new Set(['col', 'fmt']), 'date');
    if (!is_col(d.col)) bad('date.col', 'bad_column');
    if (typeof d.fmt !== 'string' || !/(YYYY)/.test(d.fmt) || !/(MM?)/.test(d.fmt) || !/(DD?)/.test(d.fmt)) bad('date.fmt', 'needs_year_month_day');
  }

  const a = profile.amount;
  if (a === null || typeof a !== 'object') bad('amount', 'required_object');
  else {
    only(a, new Set(['mode', 'col', 'debit', 'credit', 'decimal', 'thousands', 'unit']), 'amount');
    if (a.mode !== 'signed' && a.mode !== 'debit_credit') bad('amount.mode', 'must_be_signed_or_debit_credit');
    if (a.mode === 'signed' && !is_col(a.col)) bad('amount.col', 'bad_column');
    if (a.mode === 'debit_credit' && (!is_col(a.debit) || !is_col(a.credit))) bad('amount.debit_credit', 'bad_column');
    if (a.mode === 'debit_credit' && a.col !== undefined) bad('amount.col', 'not_allowed_in_debit_credit');
    if (a.unit !== undefined && a.unit !== 'major' && a.unit !== 'minor') bad('amount.unit', 'must_be_major_or_minor');
    if (a.unit === 'minor' && a.mode !== 'signed') bad('amount.unit', 'minor_requires_signed');
    if (a.decimal !== undefined && (typeof a.decimal !== 'string' || a.decimal.length !== 1 || /[0-9+\-−]/.test(a.decimal))) bad('amount.decimal', 'bad_char');
    if (a.thousands !== undefined && (typeof a.thousands !== 'string' || a.thousands.length > 1 || /[0-9+\-−]/.test(a.thousands) || (a.thousands !== '' && a.thousands === (a.decimal ?? '.')))) bad('amount.thousands', 'bad_char');
  }

  const c = profile.currency;
  if (c === null || typeof c !== 'object') bad('currency', 'required_object');
  else {
    only(c, new Set(['fixed', 'col']), 'currency');
    const has_fixed = c.fixed !== undefined;
    const has_col = c.col !== undefined;
    if (has_fixed === has_col) bad('currency', 'exactly_one_of_fixed_col');
    else if (has_fixed && !(typeof c.fixed === 'string' && CURRENCY_RE.test(c.fixed))) bad('currency.fixed', 'bad_code');
    else if (has_col && !is_col(c.col)) bad('currency.col', 'bad_column');
  }

  const ds = profile.desc;
  if (ds === null || typeof ds !== 'object') bad('desc', 'required_object');
  else {
    only(ds, new Set(['cols', 'csv_safe']), 'desc');
    if (!Array.isArray(ds.cols) || ds.cols.length === 0 || !ds.cols.every(is_col)) bad('desc.cols', 'needs_nonempty_columns');
    if (ds.csv_safe !== undefined && typeof ds.csv_safe !== 'boolean') bad('desc.csv_safe', 'not_boolean');
  }

  if (profile.rules !== undefined) {
    if (!Array.isArray(profile.rules)) bad('rules', 'not_array');
    else {
      profile.rules.forEach((r, i) => {
        if (r === null || typeof r !== 'object') { bad(`rules[${i}]`, 'not_object'); return; }
        only(r, new Set(['match', 'tag']), `rules[${i}]`);
        if (typeof r.match !== 'string' || norm(r.match.startsWith('^') ? r.match.slice(1) : r.match) === '') bad(`rules[${i}].match`, 'empty_pattern');
        if (typeof r.tag !== 'string' || r.tag === '') bad(`rules[${i}].tag`, 'empty_tag');
      });
    }
  }
  if (profile.filter !== undefined) {
    const f = profile.filter;
    if (f === null || typeof f !== 'object') bad('filter', 'not_object');
    else {
      only(f, new Set(['col', 'equals']), 'filter');
      if (!is_col(f.col)) bad('filter.col', 'bad_column');
      if (typeof f.equals !== 'string') bad('filter.equals', 'not_string');
    }
  }
  // необязательные колонки текстовых полей (REQ-095): метка и контрагент берутся из ячейки; `optional` — нет колонки в заголовке, поле просто пусто
  for (const key of ['tag', 'counterparty']) {
    const t = profile[key];
    if (t === undefined) continue;
    if (t === null || typeof t !== 'object' || Array.isArray(t)) { bad(key, 'not_object'); continue; }
    only(t, new Set(['col', 'csv_safe', 'optional']), key);
    if (!is_col(t.col)) bad(key + '.col', 'bad_column');
    if (t.csv_safe !== undefined && typeof t.csv_safe !== 'boolean') bad(key + '.csv_safe', 'not_boolean');
    if (t.optional !== undefined && typeof t.optional !== 'boolean') bad(key + '.optional', 'not_boolean');
  }
  return { ok: errors.length === 0, errors };
}

/** Снять ведущий `'` перед `= + - @ TAB CR` (только для файлов самого Runway, C-045). */
function unquote_formula(s) {
  // снимается ОДИН ведущий «'», если за цепочкой апострофов идёт формульный символ («'=x» → «=x», «''=x» → «'=x»): симметрично экспорту
  return /^'+[=+\-@\t\r]/.test(s) ? s.slice(1) : s;
}

const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

/**
 * @typedef {object} Candidate
 * @property {number} row порядковый номер записи файла (с 1)
 * @property {string} account_id
 * @property {EpochDay} date
 * @property {Minor} amount_minor
 * @property {string} currency
 * @property {string} desc недоверенный текст
 * @property {string|null} tag из колонки метки профиля (если она есть и непуста), иначе по правилам описания, иначе `null`
 * @property {string} [counterparty] имя контрагента из колонки профиля (только если колонка есть и ячейка непуста)
 * @property {number} k номер среди одинаковых `(date, amount, currency, norm(desc))` в партии
 * @property {string} dedup_key
 */

/**
 * Разбор CSV по профилю: кандидаты `tx.posted` и отклонённые строки с причиной. Деньги — без float, описание — недоверенный текст.
 * Причины отклонения: `short_row`, `filtered_out`, `bad_date`, `future_date`, `unknown_currency`, `currency_mismatch`, `bad_amount`,
 * `empty_amount`, `both_debit_credit`, `sign_in_debit_credit`, `zero_amount`.
 * @param {object} profile `ImportProfile` (данные)
 * @param {string} text декодированный файл, ≤ 5 МБ
 * @param {{account_id: string, account_currency: string, as_of: EpochDay|string}} ctx
 * @returns {{candidates: Candidate[], rejects: {row: number, reason: string}[], rows_total: number}}
 * @throws {RunwayError} E_SCHEMA — плохой профиль, файл больше 5 МБ, незакрытая кавычка, неизвестная колонка
 */
export function parse_with_profile(profile, text, ctx) {
  const v = validate_profile(profile);
  if (!v.ok) fail('E_SCHEMA', { reason: 'bad_profile', errors: v.errors });
  if (typeof text !== 'string') fail('E_SCHEMA', { reason: 'text_not_string' });
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.account_id !== 'string' || typeof ctx.account_currency !== 'string') {
    fail('E_SCHEMA', { reason: 'ctx_required', need: 'account_id, account_currency, as_of' });
  }
  if (text.length > MAX_IMPORT_BYTES || (text.length * 3 > MAX_IMPORT_BYTES && new TextEncoder().encode(text).length > MAX_IMPORT_BYTES)) {
    fail('E_SCHEMA', { reason: 'file_too_large', limit: MAX_IMPORT_BYTES });
  }
  const as_of = to_epoch_day(ctx.as_of);
  const skip = profile.skip ?? 0;
  const rows = parse_csv(text, { delimiter: profile.delimiter });
  if (rows.length <= skip) fail('E_SCHEMA', { reason: 'no_header_row' });
  const header = rows[skip].map((h) => h.trim());
  const data = rows.slice(skip + 1);

  const col_ix = (ref, where) => {
    if (typeof ref === 'number') {
      if (ref >= header.length) fail('E_SCHEMA', { reason: 'column_index_out_of_header', where, col: ref });
      return ref;
    }
    const i = header.indexOf(ref);
    if (i < 0) fail('E_SCHEMA', { reason: 'unknown_column', where, col: ref });
    return i;
  };
  // колонка метки или контрагента: `optional` и колонки нет в заголовке — поля нет (-1); без `optional` нет колонки — отказ, как у остальных
  const opt_col_ix = (spec, where) => {
    if (spec === undefined) return -1;
    if (spec.optional === true) {
      if (typeof spec.col === 'number') return spec.col < header.length ? spec.col : -1;
      const i = header.indexOf(spec.col);
      return i < 0 ? -1 : i;
    }
    return col_ix(spec.col, where);
  };
  const a = profile.amount;
  const ix = {
    date: col_ix(profile.date.col, 'date'),
    desc: profile.desc.cols.map((c) => col_ix(c, 'desc')),
    cur: profile.currency.col !== undefined ? col_ix(profile.currency.col, 'currency') : -1,
    amount: a.mode === 'signed' ? col_ix(a.col, 'amount') : -1,
    debit: a.mode === 'debit_credit' ? col_ix(a.debit, 'amount.debit') : -1,
    credit: a.mode === 'debit_credit' ? col_ix(a.credit, 'amount.credit') : -1,
    filter: profile.filter !== undefined ? col_ix(profile.filter.col, 'filter') : -1,
    tag: opt_col_ix(profile.tag, 'tag'),
    counterparty: opt_col_ix(profile.counterparty, 'counterparty'),
  };
  const need = Math.max(ix.date, ...ix.desc, ix.cur, ix.amount, ix.debit, ix.credit, ix.filter) + 1; // необязательные колонки метки и контрагента строку не отклоняют
  const rules = profile.rules ?? [];
  const csv_safe = profile.desc.csv_safe === true;

  const seen = new Map();
  const candidates = [];
  const rejects = [];
  data.forEach((r, i) => {
    const row = skip + 2 + i;
    const reject = (reason) => { rejects.push({ row, reason }); };
    if (r.length < need) return reject('short_row');
    if (ix.filter >= 0 && r[ix.filter].trim() !== profile.filter.equals) return reject('filtered_out');
    const d = parse_date_fmt(r[ix.date].trim(), profile.date.fmt);
    if (d === null) return reject('bad_date');
    if (d > as_of) return reject('future_date');
    const cur = profile.currency.fixed ?? r[ix.cur].trim().toUpperCase();
    let exp;
    try { exp = currency_exponent(cur); } catch (e) {
      if (e?.name === 'RunwayError' && e.code === 'E_SCHEMA') return reject('unknown_currency');
      throw e;
    }
    if (cur !== ctx.account_currency) return reject('currency_mismatch');
    let amount;
    if (a.mode === 'signed') {
      if (a.unit === 'minor') {
        const t = r[ix.amount].trim();
        if (!/^[-+]?\d+$/.test(t)) return reject('bad_amount');
        try { amount = assert_minor(BigInt(t)); } catch { return reject('bad_amount'); }
      } else {
        amount = parse_amount_cell(r[ix.amount], a, exp);
        if (amount === null) return reject('bad_amount');
      }
    } else {
      const x = r[ix.debit].trim();
      const y = r[ix.credit].trim();
      if (x === '' && y === '') return reject('empty_amount');
      if (x !== '' && y !== '') return reject('both_debit_credit');
      const s = x !== '' ? x : y;
      if (/^[-+−]/.test(s)) return reject('sign_in_debit_credit');
      const m = parse_amount_cell(s, a, exp);
      if (m === null) return reject('bad_amount');
      amount = x !== '' ? 0 - m : m;
    }
    if (amount === 0) return reject('zero_amount');
    const parts = [];
    for (const c of ix.desc) {
      const cell = csv_safe ? unquote_formula(r[c]) : r[c];
      const t = cell.replace(CONTROL_RE, ' ').trim();
      if (t !== '') parts.push(t);
    }
    const desc = parts.join(' ');
    const nd = norm(desc);
    const rule = rules.find((q) => rule_matches(q, nd));
    // метка из своей колонки (непустая ячейка) главнее правил по описанию; контрагент — только из своей колонки. Ключ дедупликации от них не зависит
    const text_cell = (spec, i) => {
      if (i < 0) return '';
      const raw = r[i] ?? '';
      return (spec.csv_safe === true ? unquote_formula(raw) : raw).replace(CONTROL_RE, ' ').trim();
    };
    const tag_cell = text_cell(profile.tag, ix.tag);
    const cp_cell = text_cell(profile.counterparty, ix.counterparty);
    const g = d + '|' + amount + '|' + cur + '|' + nd;
    const k = seen.get(g) ?? 0;
    seen.set(g, k + 1);
    candidates.push({
      row, account_id: ctx.account_id, date: d, amount_minor: amount, currency: cur, desc, tag: tag_cell !== '' ? tag_cell : rule === undefined ? null : rule.tag, k,
      dedup_key: dedup_key(ctx.account_id, d, amount, cur, desc, k),
      ...(cp_cell === '' ? {} : { counterparty: cp_cell }),
    });
  });
  return { candidates, rejects, rows_total: data.length };
}

// ── Сухой прогон, партия, откат ────────────────────────────────────────────────

/** Плоский вид существующей записи: принимает `LedgerEvent` (`payload`) и факт проекции (`State.facts[...]`). */
function existing_view(e) {
  const x = e.payload ?? e;
  return {
    id: String(e.event_id ?? e.entity_id ?? ''),
    account_id: x.account_id,
    date: x.date === undefined ? NaN : to_epoch_day(x.date),
    amount_minor: x.amount_minor,
    currency: x.currency,
    dedup_key: x.dedup_key,
  };
}

/** Ключ индекса двойников: счёт, валюта и сумма (разделитель — NUL, в идентификаторах не встречается). */
function double_key(account_id, currency, amount_minor) {
  return String(account_id) + '\u0000' + String(currency) + '\u0000' + String(amount_minor);
}

/**
 * Сухой прогон: «распознано · отклонено · дубликатов» (`recognized + rejected + duplicates = rows_total`), возможные двойники,
 * границы выписки и пересечение/разрыв с уже импортированным. Журнал не меняет.
 * Дубликат — ключ уже есть и (записи нет или она совпадает по дате, сумме и валюте); коллизия ключа с другими полями — не дубликат.
 * Двойник — распознанная строка, у которой есть свободная запись той же суммы в окне `±match.window_days`. Запись, уже
 * объяснённая дубликатом этого файла, свободной не считается (иначе второй кофе за день был бы двойником первого, TV-2);
 * каждая запись закрепляется не более чем за одним кандидатом.
 * @param {Candidate[]} candidates
 * @param {Set<string>|string[]} existing_keys ключи эффективных записей
 * @param {{row: number, reason: string}[]} [rejects]
 * @param {(LedgerEvent|object)[]} [existing_events] эффективные записи (события журнала или факты проекции)
 * @param {object} [params] `match.window_days` (3)
 * @returns {{recognized: number, rejected: number, duplicates: number, rows_total: number, doubles: number[], from: EpochDay|null,
 *   to: EpochDay|null, overlap_days: number, gap_days: number, recognized_items: (Candidate & {double: string|null})[], duplicate_items: Candidate[]}}
 */
export function dry_run(candidates, existing_keys, rejects = [], existing_events = [], params = {}) {
  const keys = existing_keys instanceof Set ? existing_keys : new Set(existing_keys ?? []);
  const win = params['match.window_days'] ?? params.match?.window_days ?? vd('match.window_days');
  if (!Number.isSafeInteger(win) || win < 0 || win > 31) fail('E_SCHEMA', { reason: 'window_days_not_nonneg_int' }); // К-4 (Q-12): 0…31
  const views = existing_events.map(existing_view).sort((p, q) => (p.date - q.date) || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  const by_key = new Map();
  for (const e of views) if (e.dedup_key !== undefined) { if (!by_key.has(e.dedup_key)) by_key.set(e.dedup_key, []); by_key.get(e.dedup_key).push(e); }

  const recognized = [];
  const duplicates = [];
  const taken = new Set();
  for (const c of candidates) {
    const es = by_key.get(c.dedup_key) ?? [];
    const same = es.filter((e) => e.date === c.date && e.amount_minor === c.amount_minor && e.currency === c.currency);
    if (keys.has(c.dedup_key) && (es.length === 0 || same.length > 0)) {
      duplicates.push(c);
      if (same[0] !== undefined) taken.add(same[0].id);
    } else recognized.push(c);
  }

  // Индекс двойников: (счёт, валюта, сумма) → записи по возрастанию (дата, id); внутри ключа — бинарный поиск по окну дат.
  // Результат тот же, что у перебора «первая свободная запись окна в порядке (дата, id)», но за O(R·log E) вместо O(R·E) (ALG-14).
  const by_amount = new Map();
  for (const e of views) {
    if (Number.isNaN(e.date)) continue; // запись без даты двойником быть не может
    const k = double_key(e.account_id, e.currency, e.amount_minor);
    if (!by_amount.has(k)) by_amount.set(k, []);
    by_amount.get(k).push(e);
  }
  for (const list of by_amount.values()) list.sort((p, q) => (p.date - q.date) || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  const find_double = (c) => {
    const list = by_amount.get(double_key(c.account_id, c.currency, c.amount_minor));
    if (list === undefined) return undefined;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (list[mid].date < c.date - win) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < list.length && list[i].date <= c.date + win; i++) if (!taken.has(list[i].id)) return list[i];
    return undefined;
  };
  const items = [];
  const doubles = [];
  for (const c of [...recognized].sort((p, q) => p.row - q.row)) {
    const hit = find_double(c);
    if (hit !== undefined) { taken.add(hit.id); doubles.push(c.row); }
    items.push({ ...c, double: hit === undefined ? null : hit.id });
  }
  const acc = candidates.length > 0 ? candidates[0].account_id : undefined;
  const imported = views.filter((e) => e.dedup_key !== undefined && (acc === undefined || e.account_id === acc) && !Number.isNaN(e.date));
  const last = imported.length > 0 ? imported.reduce((m, e) => Math.max(m, e.date), -Infinity) : null;
  const from = candidates.length > 0 ? candidates.reduce((m, c) => Math.min(m, c.date), Infinity) : null;
  const to = candidates.length > 0 ? candidates.reduce((m, c) => Math.max(m, c.date), -Infinity) : null;
  return {
    recognized: recognized.length,
    rejected: rejects.length,
    duplicates: duplicates.length,
    rows_total: candidates.length + rejects.length,
    doubles,
    from,
    to,
    overlap_days: last !== null && from !== null ? Math.max(0, last - from + 1) : 0,
    gap_days: last !== null && from !== null ? Math.max(0, from - last - 1) : 0,
    recognized_items: items,
    duplicate_items: duplicates,
  };
}

/**
 * Ключи эффективных фактов состояния (`dedup_key` у `tx.posted`) — для `existing_keys` сухого прогона.
 * @param {{facts: Record<string, {dedup_key?: string}>}} state
 * @returns {Set<string>}
 */
export function existing_keys_of(state) {
  const out = new Set();
  for (const f of Object.values(state.facts ?? {})) if (typeof f.dedup_key === 'string') out.add(f.dedup_key);
  return out;
}

/**
 * Порты записи для `import_commit` / `import_rollback`: движок не читает часы и не создаёт идентификаторы.
 * @typedef {object} WritePorts
 * @property {() => string} next_id следующий `event_id` (uuidv7 от адаптера)
 * @property {() => number} next_seq следующий `seq`
 * @property {string} recorded_at момент записи `YYYY-MM-DDTHH:MM:SSZ`
 */

/**
 * Партия импорта: `import.started` + `tx.posted` (`actor = import:<batch_id>`) для распознанных строк. Двойники — только по решению
 * `accept` (без решения — `skip`). Возвращает записи для атомарного добавления в журнал (`append_atomic` — у адаптера).
 * @param {{recognized_items: (Candidate & {double: string|null})[], recognized: number, rejected: number, duplicates: number}} result результат `dry_run`
 * @param {Record<number, 'accept'|'skip'>|Map<number, string>} decisions по номеру строки
 * @param {Uint8Array|string} bytes исходный файл (для `source_hash`)
 * @param {WritePorts & {batch_id: string, profile_id?: string}} ctx
 * @returns {LedgerEvent[]}
 */
export function import_commit(result, decisions, bytes, ctx) {
  if (typeof ctx?.batch_id !== 'string' || ctx.batch_id === '') fail('E_SCHEMA', { reason: 'batch_id_required' });
  const decide = (row) => (decisions instanceof Map ? decisions.get(row) : decisions?.[row]);
  const actor = 'import:' + ctx.batch_id;
  const port = (extra) => ({ event_id: ctx.next_id(), seq: ctx.next_seq(), recorded_at: ctx.recorded_at, ...extra });
  const evs = [make_event('import.started', {
    batch_id: ctx.batch_id,
    ...(ctx.profile_id === undefined ? {} : { profile_id: ctx.profile_id }),
    source_hash: sha256(bytes),
    counts: { recognized: result.recognized, rejected: result.rejected, duplicates: result.duplicates },
  }, port({ actor: 'user' }))];
  for (const c of result.recognized_items) {
    if (c.double !== null && c.double !== undefined && decide(c.row) !== 'accept') continue;
    const p = port({ actor });
    evs.push(make_event('tx.posted', {
      account_id: c.account_id, date: format_date(c.date), amount_minor: c.amount_minor, currency: c.currency,
      ...(c.tag === null || c.tag === undefined ? {} : { tag: c.tag }), note: c.desc, dedup_key: c.dedup_key,
    }, { ...p, entity_id: p.event_id }));
  }
  return evs;
}

/**
 * Откат партии: `revert` каждой эффективной записи партии (`actor = import:<batch_id>`) и `import.rolled_back`.
 * Откат уже откатанной партии ничего не добавляет. Ключи откатанных записей перестают считаться существующими
 * (они не входят в `effective_events`). Отдельного `tx.voided` нет (C-070).
 * @param {string} batch_id
 * @param {LedgerEvent[]} events полный журнал
 * @param {WritePorts} ctx порты записи (в каноне у функции их нет — см. spec_issues)
 * @returns {LedgerEvent[]}
 */
export function import_rollback(batch_id, events, ctx) {
  const actor = 'import:' + batch_id;
  const eff = effective_events(events);
  const mine = eff.filter((e) => e.actor === actor);
  if (mine.length === 0) return [];
  const port = (extra) => ({ event_id: ctx.next_id(), seq: ctx.next_seq(), recorded_at: ctx.recorded_at, ...extra });
  const out = mine.map((e) => make_event('revert', { target: e.event_id }, port({ actor: 'user' })));
  out.push(make_event('import.rolled_back', { batch_id }, port({ actor: 'user' })));
  return out;
}

// ── JSON-копия ────────────────────────────────────────────────────────────────

/**
 * Файл-копия `runway-journal/1`: канонический JSON `{engine_version, events, format}`, события по порядку `seq`.
 * @param {LedgerEvent[]|{events: LedgerEvent[], engine_version?: string}} journal журнал (не `State`: из состояния журнал не восстановить)
 * @param {{engine_version?: string}} [opts]
 * @returns {string}
 * @throws {RunwayError} E_SCHEMA (нет `seq`, передано состояние вместо журнала), E_NOT_INTEGER (float в payload)
 */
export function export_json(journal, opts = {}) {
  const events = Array.isArray(journal) ? journal : journal?.events;
  if (!Array.isArray(events)) fail('E_SCHEMA', { reason: 'journal_required', hint: 'передайте массив записей журнала, а не State' });
  const engine_version = opts.engine_version ?? journal?.engine_version ?? 'unversioned';
  const sorted = events.map((e, i) => {
    if (!Number.isSafeInteger(e?.seq)) fail('E_SCHEMA', { reason: 'seq_required', event_id: e?.event_id });
    return { e, i };
  }).sort((p, q) => (p.e.seq - q.e.seq) || (p.i - q.i)).map((x) => x.e);
  return canon({ format: JOURNAL_FORMAT, engine_version, events: sorted });
}

/**
 * Разобрать файл-копию в журнал. Формат новее известного — `E_SCHEMA` (`newer_format`): такой файл можно только читать.
 * @param {string} text
 * @returns {{format: string, engine_version: string|null, events: LedgerEvent[]}}
 */
export function read_journal_json(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { return fail('E_SCHEMA', { reason: 'bad_json' }); }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) fail('E_SCHEMA', { reason: 'not_object' });
  const m = typeof obj.format === 'string' ? /^runway-journal\/([1-9]\d*)$/.exec(obj.format) : null;
  if (m === null) fail('E_SCHEMA', { reason: 'bad_format', format: String(obj.format) });
  if (Number(m[1]) > 1) fail('E_SCHEMA', { reason: 'newer_format', format: obj.format });
  if (!Array.isArray(obj.events)) fail('E_SCHEMA', { reason: 'events_required' });
  for (const e of obj.events) {
    if (e === null || typeof e !== 'object' || typeof e.type !== 'string' || typeof e.event_id !== 'string') fail('E_SCHEMA', { reason: 'bad_event' });
    if (!Number.isSafeInteger(e.seq)) fail('E_SCHEMA', { reason: 'seq_required', event_id: e.event_id });
  }
  return { format: obj.format, engine_version: typeof obj.engine_version === 'string' ? obj.engine_version : null, events: obj.events };
}

/**
 * Восстановить состояние из файла-копии: `reduce(effective_events(events))`.
 * Инвариант: `state_hash(import_json(export_json(j))) = state_hash(reduce(effective_events(j)))` (TST-38).
 * @param {string} text
 * @returns {object} State
 */
export function import_json(text) {
  return reduce(effective_events(read_journal_json(text).events));
}

// ── CSV журнала ───────────────────────────────────────────────────────────────

/**
 * Защита от формул в таблицах (X5): ячейка, начинающаяся с `=`, `+`, `-`, `@`, TAB или CR, получает префикс `'`.
 * Применяется ТОЛЬКО к текстовым колонкам: числовые (`amount_minor`, даты) пишутся каноническим числом.
 * @param {string} s
 * @returns {string}
 */
export function csv_safe_cell(s) {
  if (s === null || s === undefined) return '';
  const t = String(s);
  return t.length > 0 && '=+-@\t\r'.includes(t[0]) ? '\'' + t : t;
}

/**
 * Текстовая колонка CSV: `csv_safe_cell` плюс экранирование значений, которые импорт принял бы за уже защищённые (`'` и формульный символ):
 * «'=x» экспортируется как «''=x» и при импорте (снятие одного ведущего «'» перед цепочкой апострофов и формульным символом) возвращается как «'=x» («текст восстанавливается», ALG-14).
 * @param {string} s
 * @returns {string}
 */
function csv_text_cell(s) {
  const t = s === null || s === undefined ? '' : String(s);
  return /^'+[=+\-@\t\r]/.test(t) ? '\'' + t : csv_safe_cell(t);
}

/** Закавычить поле CSV, если нужно (`,`, `"`, LF, CR внутри); `"` удваивается. */
function csv_quote(s) {
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const CSV_COLUMNS = ['date', 'account_id', 'amount_minor', 'currency', 'kind', 'layer', 'tag', 'counterparty', 'note', 'event_id', 'dedup_key'];
// id-колонки из чужого журнала тоже идут через csv_text_cell: «=cmd|…» в account_id/event_id/dedup_key — DDE-инъекция в Excel (Q-10, К-33).
// Числа (amount_minor: «-4730») и даты вне набора: экранировать отрицательную сумму нельзя.
const CSV_TEXT = new Set(['tag', 'counterparty', 'note', 'account_id', 'currency', 'event_id', 'dedup_key']);
const iso_of = (d) => (typeof d === 'number' ? format_date(d) : String(d));

/**
 * CSV журнала `runway-csv/1`: разделитель `,`, перевод строки LF, колонки
 * `date, account_id, amount_minor, currency, kind, layer, tag, counterparty, note, event_id, dedup_key` (C-045).
 * Строки — факты (`state.facts`) и разовые планы (`state.plans`); правил, потоков, резервов и сценариев в этом формате нет.
 * Текстовые колонки (`tag`, `counterparty`, `note`) проходят `csv_safe_cell`, числа и даты не меняются.
 * @param {object} state `State` (`reduce(effective_events(journal))`)
 * @param {'journal'} kind
 * @returns {string}
 */
export function export_csv(state, kind) {
  if (kind !== 'journal') fail('E_SCHEMA', { reason: 'unknown_csv_kind', kind: String(kind) });
  const rows = [];
  const cp = (id) => (id === undefined || id === null ? '' : (state.counterparties?.[id]?.name ?? String(id)));
  // дата каждой строки проверяется явно (E_BAD_DATE), а не косвенно компаратором sort, который при одной строке не вызывается
  for (const [key, f] of Object.entries(state.facts ?? {})) rows.push({ f, id: String(f.event_id ?? key), layer: 'posted', d: to_epoch_day(f.date) });
  for (const [key, p] of Object.entries(state.plans ?? {})) rows.push({ f: p, id: key, layer: 'planned', d: to_epoch_day(p.date) });
  rows.sort((p, q) => (p.d - q.d) || (p.f.amount_minor - q.f.amount_minor) || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  const lines = [CSV_COLUMNS.join(',')];
  for (const { f, id, layer, d } of rows) {
    const kind_of = f.transfer_id !== undefined && f.transfer_id !== null ? 'transfer' : f.amount_minor > 0 ? 'income' : 'expense';
    const cells = {
      date: format_date(d), account_id: f.account_id, amount_minor: String(assert_minor(f.amount_minor)), currency: f.currency,
      kind: kind_of, layer, tag: f.tag ?? '', counterparty: cp(f.counterparty_id), note: f.note ?? '', event_id: id, dedup_key: f.dedup_key ?? '',
    };
    lines.push(CSV_COLUMNS.map((c) => {
      const raw = String(cells[c] ?? '');
      return csv_quote(CSV_TEXT.has(c) ? csv_text_cell(raw) : raw);
    }).join(','));
  }
  return lines.join('\n') + '\n';
}

// ── hledger: экспорт ──────────────────────────────────────────────────────────

/** Имя счёта/метки для hledger: NFKC, нижний регистр, всё кроме букв и цифр → `-`. */
function slug(s, fallback) {
  const t = String(s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  return t === '' ? fallback : t;
}

/** Код валюты в выводе hledger: `^[A-Z][A-Z0-9]{1,9}$`, иначе E_SCHEMA (одна строка, без управляющих символов). */
function hl_commodity(code) {
  if (typeof code !== 'string' || !CURRENCY_RE.test(code)) fail('E_SCHEMA', { reason: 'bad_currency_code' });
  return code;
}

/** Описание для hledger: управляющие символы и `;` (начало комментария) → пробел, схлопывание, ≤ 200 символов, пусто → «без описания». */
function clean(s) {
  const t = String(s ?? '').replace(CONTROL_RE, ' ').replace(/;/g, ' ').replace(/\s+/g, ' ').trim();
  const cut = [...t].slice(0, 200).join('').trim();
  return cut === '' ? 'без описания' : cut;
}

/** Десятичная запись дроби `num/den` (до 10 знаков, half_even, без хвостовых нулей). */
function decimal_rate(num, den) {
  const n = BigInt(assert_minor(num));
  const d = BigInt(assert_minor(den));
  if (d <= 0n || n < 0n) fail('E_SCHEMA', { reason: 'bad_rate', num: String(num), den: String(den) });
  const scale = 10n ** 10n;
  const scaled = n * scale;
  let q = scaled / d;
  const r = scaled % d;
  if (2n * r > d || (2n * r === d && q % 2n === 1n)) q += 1n;
  const s = q.toString().padStart(11, '0');
  const int_part = s.slice(0, -10);
  const frac = s.slice(-10).replace(/0+$/, '');
  return frac === '' ? int_part : int_part + '.' + frac;
}

/** Можно ли выразить правило одной строкой `~ monthly …` (ALG-14: `native_expressible`). */
function native_expressible(rule, overrides) {
  const bm = rule.by_monthday;
  return rule.freq === 'M' && rule.interval === 1 && (bm === undefined || (bm.length === 1 && bm[0] >= 1 && bm[0] <= 28))
    && (rule.weekend ?? 'keep') === 'keep' && (rule.exdates ?? []).length === 0 && rule.count === undefined && rule.by_workday === undefined
    && !Object.values(overrides ?? {}).some((o) => o.rule_id === rule.rule_id);
}

/**
 * Экспорт в hledger-журнал (ALG-14). Структура: заголовок, `commodity`, курсы `P`, факты и якоря, затем плановые разовые правила `~ ДАТА`.
 * Якорь — транзакция `delta = A − баланс журнала` с утверждением `= A` и противосчётом `equity:opening` (первая запись счёта)
 * или `equity:drift`: утверждение остаётся истинным, дрейф виден (C-046). `history: 'from_anchor'` (по умолчанию) опускает проводки
 * до последнего якоря счёта (они уже в якоре, D-22); `'full'` выводит все. Факты позже `as_of` в выгрузку не входят.
 *
 * ПЛАН. io не умеет разворачивать правила и потоки, поэтому плановые события приходят портом `opts.planned` — события `planned`
 * режима `plan` (`build_events`): `{account_id, date, amount_minor, currency, tag, name?, status?}`; берутся `expected`/`overdue` с датой
 * в `[as_of, horizon_end]` в валюте счёта. Без `opts.planned` экспортируются только разовые планы `state.plans` (не сопоставленные фактом
 * через `plan_ref`). `opts.rules = 'native'` (не проверено на hledger) свёртывает простые ежемесячные правила `state.rules` в `~ monthly from … to …`
 * и исключает их вхождения из материализованных.
 * Сверка: `hledger bal assets:<счёт> --forecast=<as_of>..<horizon_end> -e <день+1>` = `close` движка (TST-44).
 * @param {object} state `State`
 * @param {EpochDay|string} as_of
 * @param {EpochDay|string} horizon_end
 * @param {{history?: 'from_anchor'|'full', rules?: 'materialize'|'native', planned?: object[]}} [opts]
 * @returns {string} журнал, строки разделены LF
 */
export function export_hledger(state, as_of, horizon_end, opts = {}) {
  const asof = to_epoch_day(as_of);
  const hend = to_epoch_day(horizon_end);
  if (hend < asof) fail('E_BAD_DATE', { reason: 'horizon_before_as_of' });
  const history = opts.history ?? 'from_anchor';
  const rules_mode = opts.rules ?? 'materialize';
  if (history !== 'from_anchor' && history !== 'full') fail('E_SCHEMA', { reason: 'bad_history', value: String(history) });
  if (rules_mode !== 'materialize' && rules_mode !== 'native') fail('E_SCHEMA', { reason: 'bad_rules_mode', value: String(rules_mode) });

  // счета: детерминированные уникальные имена
  const acc_ids = Object.keys(state.accounts ?? {}).sort();
  const used = new Set();
  /** @type {Map<string, {name: string, exp: number, ccy: string}>} */
  const accs = new Map();
  for (const id of acc_ids) {
    const a = state.accounts[id];
    const is_debt = a.kind === 'debt' || a.liquidity === 'debt';
    let name = (is_debt ? 'liabilities:' : 'assets:') + slug(a.name ?? id, 'account');
    // суффикс «-id» повторяется до уникальности: «Bank-a3» (счёт a2) и «Bank» (счёт a3) иначе слились бы в одно имя
    while (used.has(name)) name += '-' + slug(id, 'x');
    used.add(name);
    // код валюты счёта приходит из журнала/файла-копии (недоверенный ввод): перевод строки внедрил бы директиву hledger (include, alias…)
    const ccy = hl_commodity(a.currency);
    const exp = a.exponent ?? currency_exponent(ccy);
    if (!Number.isSafeInteger(exp) || exp < 0 || exp > 18) fail('E_SCHEMA', { reason: 'bad_exponent', account_id: String(id) });
    accs.set(id, { name, exp, ccy });
  }
  const acct = (id) => {
    const a = accs.get(id);
    if (a === undefined) fail('E_SCHEMA', { reason: 'unknown_account', account_id: String(id) });
    return a;
  };
  const amt = (minor, a) => format_minor(assert_minor(minor), a.exp, { decimal: '.', thousands: '' }) + ' ' + a.ccy;

  // последний якорь счёта ≤ as_of
  const anchors = Object.values(state.anchors ?? {}).filter((x) => to_epoch_day(x.date) <= asof)
    .sort((p, q) => (to_epoch_day(p.date) - to_epoch_day(q.date)) || (p.anchor_id < q.anchor_id ? -1 : 1));
  const last_anchor = new Map();
  for (const x of anchors) last_anchor.set(x.account_id, to_epoch_day(x.date));

  // факты (с группировкой переводов)
  const facts = Object.entries(state.facts ?? {}).map(([key, f]) => ({ key: String(f.event_id ?? key), f, d: to_epoch_day(f.date) }))
    .filter((x) => x.d <= asof)
    .filter((x) => history === 'full' || !last_anchor.has(x.f.account_id) || x.d > last_anchor.get(x.f.account_id))
    .sort((p, q) => (p.d - q.d) || (p.key < q.key ? -1 : p.key > q.key ? 1 : 0));
  /** @type {{d: number, order: number, id: string, kind: 'tx'|'anchor', legs?: object[], f?: object, anchor?: object}[]} */
  const items = [];
  const by_transfer = new Map();
  for (const x of facts) {
    const tid = x.f.transfer_id;
    if (tid !== undefined && tid !== null) {
      if (!by_transfer.has(tid)) by_transfer.set(tid, []);
      by_transfer.get(tid).push(x);
    } else items.push({ d: x.d, order: 0, id: x.key, kind: 'tx', legs: [x.f] });
  }
  for (const [tid, legs] of by_transfer) {
    const d = Math.min(...legs.map((l) => l.d));
    items.push({ d, order: 0, id: 'tr:' + tid, kind: 'tx', legs: legs.map((l) => l.f), transfer: true });
  }
  for (const x of anchors) {
    if (history === 'from_anchor' && last_anchor.get(x.account_id) !== to_epoch_day(x.date)) continue;
    items.push({ d: to_epoch_day(x.date), order: 1, id: x.anchor_id, kind: 'anchor', anchor: x });
  }
  items.sort((p, q) => (p.d - q.d) || (p.order - q.order) || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));

  const bal = new Map();
  const seen_acc = new Set();
  const blocks = [];
  const ccys = new Map();
  const note_ccy = (a) => { ccys.set(a.ccy, a.exp); };
  for (const it of items) {
    if (it.kind === 'anchor') {
      const x = it.anchor;
      const a = acct(x.account_id);
      note_ccy(a);
      const A = assert_minor(x.amount_minor);
      const delta = A - (bal.get(x.account_id) ?? 0);
      const eq = seen_acc.has(x.account_id) ? 'equity:drift' : 'equity:opening';
      blocks.push([`${format_date(it.d)} * якорь`, `    ${a.name}  ${amt(delta, a)} = ${amt(A, a)}`, `    ${eq}  ${amt(0 - delta, a)}`]);
      bal.set(x.account_id, A);
      seen_acc.add(x.account_id);
      continue;
    }
    const legs = it.legs;
    const first = legs[0];
    const desc = clean(first.note ?? first.tag);
    const lines = [`${format_date(it.d)} * ${desc}`];
    if (it.transfer === true && legs.length === 2) {
      const [p, q] = legs;
      const ap = acct(p.account_id);
      const aq = acct(q.account_id);
      note_ccy(ap);
      note_ccy(aq);
      const neg = p.amount_minor <= q.amount_minor ? p : q;
      const pos = neg === p ? q : p;
      const an = acct(neg.account_id);
      const ap2 = acct(pos.account_id);
      if (an.ccy !== ap2.ccy) {
        lines.push(`    ${an.name}  ${amt(neg.amount_minor, an)} @@ ${amt(Math.abs(pos.amount_minor), ap2)}`);
        lines.push(`    ${ap2.name}  ${amt(pos.amount_minor, ap2)}`);
      } else {
        lines.push(`    ${an.name}  ${amt(neg.amount_minor, an)}`);
        lines.push(`    ${ap2.name}  ${amt(pos.amount_minor, ap2)}`);
        const rest = neg.amount_minor + pos.amount_minor;
        if (rest !== 0) lines.push(`    equity:imbalance  ${amt(0 - rest, an)}`);
      }
      for (const l of legs) { bal.set(l.account_id, (bal.get(l.account_id) ?? 0) + l.amount_minor); seen_acc.add(l.account_id); }
    } else {
      for (const l of legs) {
        const a = acct(l.account_id);
        note_ccy(a);
        lines.push(`    ${a.name}  ${amt(l.amount_minor, a)}`);
        const counter = it.transfer === true ? 'equity:transfers' : (l.amount_minor > 0 ? 'income:' : 'expenses:') + slug(l.tag, 'unsorted');
        lines.push(`    ${counter}  ${amt(0 - l.amount_minor, a)}`);
        bal.set(l.account_id, (bal.get(l.account_id) ?? 0) + l.amount_minor);
        seen_acc.add(l.account_id);
      }
    }
    blocks.push(lines);
  }

  // план: разовые правила `~ ДАТА`
  let planned = opts.planned;
  if (planned === undefined) {
    const matched = new Set(Object.values(state.facts ?? {}).map((f) => f.plan_ref).filter((x) => typeof x === 'string'));
    planned = Object.entries(state.plans ?? {}).filter(([key]) => !matched.has(key)).map(([key, p]) => ({ ...p, cash_event_id: key }));
  }
  const native_rules = new Set();
  const periodic = [];
  const events = planned
    .map((e, i) => ({ e, i, d: to_epoch_day(e.date), id: String(e.cash_event_id ?? e.occ_key ?? e.event_id ?? e.plan_id ?? i) }))
    .filter(({ e, d }) => (e.layer === undefined || e.layer === 'planned') && (e.status === undefined || e.status === 'expected' || e.status === 'overdue') && d >= asof && d <= hend)
    .filter(({ e }) => accs.has(e.account_id) && accs.get(e.account_id).ccy === e.currency)
    .sort((p, q) => (p.d - q.d) || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  if (rules_mode === 'native') {
    for (const r of Object.values(state.rules ?? {})) {
      if (!native_expressible(r, state.overrides) || !accs.has(r.account_id)) continue;
      const mine = events.filter(({ e }) => e.rule_id === r.rule_id);
      if (mine.length === 0) continue;
      const a = acct(r.account_id);
      note_ccy(a);
      native_rules.add(r.rule_id);
      const amount = mine[0].e.amount_minor;
      periodic.push([`~ monthly from ${format_date(mine[0].d)} to ${format_date(hend + 1)}  ${clean(r.name ?? r.tag)}`,
        `    ${a.name}  ${amt(amount, a)}`,
        `    ${(amount > 0 ? 'income:' : 'expenses:') + slug(r.tag, 'unsorted')}  ${amt(0 - amount, a)}`]);
    }
  }
  for (const { e, d } of events) {
    if (native_rules.has(e.rule_id)) continue;
    const a = acct(e.account_id);
    note_ccy(a);
    periodic.push([`~ ${format_date(d)}  ${clean(e.name ?? e.tag ?? e.note)}`,
      `    ${a.name}  ${amt(e.amount_minor, a)}`,
      `    ${(e.amount_minor > 0 ? 'income:' : 'expenses:') + slug(e.tag, 'unsorted')}  ${amt(0 - e.amount_minor, a)}`]);
  }

  // шапка: commodity и курсы
  const head = [`; ${JOURNAL_FORMAT} · as_of ${format_date(asof)} · horizon_end ${format_date(hend)}`];
  // дата курса проверяется явно для каждой записи (компаратор sort при единственном курсе не вызывается), коды валют — по шаблону
  const fx = Object.values(state.fx ?? {}).map((x) => ({ ...x, d: to_epoch_day(x.date) }))
    .sort((p, q) => (p.d - q.d) || (p.fx_id < q.fx_id ? -1 : p.fx_id > q.fx_id ? 1 : 0));
  for (const r of fx) {
    for (const c of [hl_commodity(r.base), hl_commodity(r.quote)]) if (!ccys.has(c)) ccys.set(c, currency_exponent(c));
  }
  for (const c of [...ccys.keys()].sort()) {
    const exp = ccys.get(c);
    head.push(`commodity 1000${exp > 0 ? '.' + '0'.repeat(exp) : ''} ${c}`);
  }
  for (const r of fx) head.push(`P ${format_date(r.d)} ${r.base} ${decimal_rate(r.num, r.den)} ${r.quote}`);

  const parts = [head.join('\n')];
  if (blocks.length > 0) parts.push(blocks.map((b) => b.join('\n')).join('\n\n'));
  if (periodic.length > 0) parts.push(periodic.map((b) => b.join('\n')).join('\n'));
  return parts.join('\n\n') + '\n';
}

// ── hledger: импорт подмножества (v1.1) ───────────────────────────────────────

const HL_DATE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/;

function hl_date(s, line) {
  const m = HL_DATE.exec(s);
  if (m === null) return fail('E_SCHEMA', { reason: 'bad_hledger_date', line, value: s });
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > days_in_month(y, mo)) return fail('E_SCHEMA', { reason: 'bad_hledger_date', line, value: s });
  return format_date(days_from_civil(y, mo, d));
}

/** Разобрать сумму hledger: `[-]число ccy` или `ccy [-]число`; возвращает {minor, ccy, exp}. */
function hl_amount(text, line, commodities) {
  const t = text.trim();
  const m = /^(-?)\s*([0-9][0-9,]*(?:\.[0-9]+)?|\.[0-9]+)\s*([^\s\d,.@=;-][^\s@=;]*)?$/.exec(t) ?? /^([^\s\d,.@=;-][^\s@=;]*)\s*(-?)\s*([0-9][0-9,]*(?:\.[0-9]+)?)$/.exec(t);
  if (m === null) return fail('E_SCHEMA', { reason: 'bad_hledger_amount', line, value: t });
  let sign;
  let num;
  let ccy;
  if (/^[0-9.-]/.test(t)) { sign = m[1]; num = m[2]; ccy = m[3]; } else { ccy = m[1]; sign = m[2]; num = m[3]; }
  if (ccy === undefined || ccy === '') return fail('E_SCHEMA', { reason: 'hledger_amount_without_commodity', line, value: t });
  const literal = num.replace(/,/g, '');
  const dec = literal.includes('.') ? literal.length - literal.indexOf('.') - 1 : 0;
  let exp = commodities.get(ccy);
  if (exp === undefined) { try { exp = currency_exponent(ccy); } catch { exp = dec; } }
  const minor = parse_minor((sign === '-' ? '-' : '') + literal, { decimal: '.', thousands: '', exponent: exp });
  return { minor, ccy, exp };
}

/**
 * Импорт подмножества hledger-журнала (v1.1, REQ-099): `commodity`, `P` → `FxRate`; транзакции с одним или двумя активными
 * счетами (`assets:`/`liabilities:`) → факты `tx.posted` (перевод — две ноги с общим `transfer_id`); утверждение `= A` на активном
 * счёте → `Anchor` (транзакция якоря с противосчётом `equity:*` в факт не превращается); `~ ДАТА` → разовый план `plan.set`;
 * `~ daily|weekly|monthly|yearly [from ДАТА] [to ДАТА]` и `~ every N days|weeks|months|years` → `Rule` (`to` в hledger исключающий).
 * Остальные директивы и комментарии пропускаются. Не поддержаны (TODO): `@`/`@@` как `fx` операции, шаблоны/автоматические
 * транзакции, более двух активных ног, include.
 * @param {string} text
 * @param {{recorded_at?: string}} [opts] порт времени записи (по умолчанию `1970-01-01T00:00:00Z`; в `State` не входит)
 * @returns {object} State
 * @throws {RunwayError} E_SCHEMA — неподдерживаемая конструкция
 */
export function import_hledger(text, opts = {}) {
  if (typeof text !== 'string') fail('E_SCHEMA', { reason: 'text_not_string' });
  const recorded_at = opts.recorded_at ?? '1970-01-01T00:00:00Z';
  const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/);
  const commodities = new Map();
  const events = [];
  let seq = 0;
  const push = (type, payload, entity_id) => {
    seq += 1;
    const id = 'hl-' + String(seq).padStart(6, '0');
    events.push(make_event(type, payload, { event_id: id, seq, recorded_at, ...(entity_id === undefined ? {} : { entity_id }) }));
  };
  const accounts = new Map();
  const used_ids = new Set();
  const ensure_account = (hl_name, ccy, exp) => {
    let a = accounts.get(hl_name);
    if (a === undefined) {
      const is_debt = hl_name.startsWith('liabilities:');
      const name = hl_name.slice(hl_name.indexOf(':') + 1);
      // «assets:bank» / «liabilities:bank», «assets:a:b» / «assets:a-b» дают один slug: идентификатор различаем по полному имени, затем по номеру
      const base_id = 'acc_' + slug(name, 'account');
      let account_id = base_id;
      if (used_ids.has(account_id)) account_id = 'acc_' + slug(hl_name, 'account');
      for (let n = 2; used_ids.has(account_id); n++) account_id = base_id + '-' + n;
      used_ids.add(account_id);
      a = { account_id, name, kind: is_debt ? 'debt' : 'bank', liquidity: is_debt ? 'debt' : 'operating', currency: ccy, exponent: exp };
      accounts.set(hl_name, a);
      push('account.opened', a);
    }
    return a;
  };
  const is_asset = (n) => n.startsWith('assets:') || n.startsWith('liabilities:');
  const counter_tag = (n) => {
    if (!(n.startsWith('income:') || n.startsWith('expenses:'))) return null;
    const t = n.slice(n.indexOf(':') + 1);
    return t === 'unsorted' ? null : t;
  };

  /** Читает отступные строки после заголовка; возвращает {postings, next_index}. */
  const read_postings = (start) => {
    const postings = [];
    let i = start;
    for (; i < lines.length; i++) {
      const raw = lines[i];
      if (!/^[ \t]+\S/.test(raw)) break;
      const body = raw.trim();
      if (body.startsWith(';')) continue;
      const no_comment = body.replace(/\s;.*$/, '');
      const m = /^(.*?)(?:(?:\s{2,}|\t)(.*))?$/.exec(no_comment);
      const account = m[1].trim();
      const rest = (m[2] ?? '').trim();
      let amount_text = rest;
      let assertion = null;
      let price_total = null;
      const eq = /\s*==?\*?\s*(.*)$/.exec(amount_text);
      if (eq !== null && eq.index >= 0) { assertion = eq[1]; amount_text = amount_text.slice(0, eq.index); }
      const at2 = amount_text.indexOf('@@');
      if (at2 >= 0) { price_total = amount_text.slice(at2 + 2); amount_text = amount_text.slice(0, at2); }
      else if (amount_text.includes('@')) fail('E_SCHEMA', { reason: 'hledger_unit_price_not_supported', line: i + 1 });
      postings.push({ account, amount_text: amount_text.trim(), assertion, price_total, line: i + 1 });
    }
    return { postings, next: i };
  };

  let tr_n = 0;
  let plan_n = 0;
  let rule_n = 0;
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '' || /^[;#*]/.test(trimmed) || /^[ \t]/.test(line)) { i += 1; continue; }
    let m;
    if ((m = /^commodity\s+(.+)$/.exec(trimmed)) !== null) {
      const body = m[1].trim();
      const a = /^(-?[0-9][0-9,]*(?:\.[0-9]+)?)\s*(\S+)$/.exec(body);
      if (a !== null) commodities.set(a[2], a[1].includes('.') ? a[1].length - a[1].indexOf('.') - 1 : 0);
      i += 1;
      continue;
    }
    if ((m = /^P\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(?:;.*)?$/.exec(trimmed)) !== null) {
      const date = hl_date(m[1], i + 1);
      const rate = /^([0-9]+)(?:\.([0-9]+))?$/.exec(m[3]);
      if (rate === null) fail('E_SCHEMA', { reason: 'bad_price', line: i + 1 });
      const frac = rate[2] ?? '';
      const num = assert_minor(BigInt(rate[1] + frac));
      const den = assert_minor(10n ** BigInt(frac.length));
      push('fx.set', { fx_id: `fx-${date}-${m[2]}-${m[4]}`, date, base: m[2], quote: m[4], num, den, source: 'manual' });
      i += 1;
      continue;
    }
    if ((m = /^~\s+(.*)$/.exec(trimmed)) !== null) {
      const header_line = i + 1;
      const parts = m[1].replace(/(^|\s);.*$/, '').split(/\s{2,}|\t/); // `;` начинает комментарий hledger
      const period = parts[0].trim();
      const desc = clean(parts.slice(1).join(' '));
      const { postings, next } = read_postings(i + 1);
      i = next;
      const assets = postings.filter((p) => is_asset(p.account));
      if (assets.length !== 1) fail('E_SCHEMA', { reason: 'periodic_needs_one_asset_posting', line: header_line });
      const ap = assets[0];
      const { minor, ccy, exp } = hl_amount(ap.amount_text, ap.line, commodities);
      const acc = ensure_account(ap.account, ccy, exp);
      const other = postings.find((p) => p !== ap);
      const tag = other === undefined ? null : counter_tag(other.account);
      const base = { account_id: acc.account_id, amount_minor: minor, currency: ccy, ...(tag === null ? {} : { tag }) };
      if (HL_DATE.test(period)) {
        plan_n += 1;
        push('plan.set', { plan_id: `plan_${plan_n}`, ...base, date: hl_date(period, header_line), name: desc }, `plan_${plan_n}`);
        continue;
      }
      const pm = /^(?:(daily|weekly|monthly|yearly)|every\s+(\d+)\s+(day|week|month|year)s?)(?:\s+from\s+(\S+))?(?:\s+to\s+(\S+))?$/.exec(period);
      if (pm === null) fail('E_SCHEMA', { reason: 'unsupported_period_expression', line: header_line, value: period });
      const freq = pm[1] !== undefined ? { daily: 'D', weekly: 'W', monthly: 'M', yearly: 'Y' }[pm[1]] : { day: 'D', week: 'W', month: 'M', year: 'Y' }[pm[3]];
      const interval = pm[2] === undefined ? 1 : Number(pm[2]);
      if (pm[4] === undefined) fail('E_SCHEMA', { reason: 'periodic_without_from', line: header_line });
      const start = hl_date(pm[4], header_line);
      const sd = civil_from_days(parse_date(start))[2];
      rule_n += 1;
      const rule = {
        rule_id: `R-hl-${rule_n}`, version: 1, account_id: acc.account_id, name: desc, kind: minor > 0 ? 'income' : 'expense',
        amount: { exp_minor: minor }, currency: ccy, freq, interval, start_date: start, month_end: 'clamp', weekend: 'keep',
        calendar_id: null, exdates: [], is_obligation: false, is_estimate: false, tag: tag ?? 'unsorted',
      };
      if (freq === 'W') rule.by_weekday = [dow(parse_date(start))];
      if (freq === 'M') rule.by_monthday = [sd];
      if (pm[5] !== undefined) rule.until_date = format_date(parse_date(hl_date(pm[5], header_line)) - 1);
      push('rule.set', rule);
      continue;
    }
    if ((m = /^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})(?:=\S+)?\s*(?:[*!]\s*)?(?:\([^)]*\)\s*)?(.*)$/.exec(trimmed)) !== null) {
      const header_line = i + 1;
      const date = hl_date(m[1], header_line);
      const desc = clean(m[2].replace(/(^|\s);.*$/, ''));
      const { postings, next } = read_postings(i + 1);
      i = next;
      // подставить пропущенную сумму (не более одной) = −Σ остальных в той же валюте
      const parsed = postings.map((p) => (p.amount_text === '' ? null : hl_amount(p.amount_text, p.line, commodities)));
      const blanks = parsed.filter((x) => x === null).length;
      if (blanks > 1) fail('E_SCHEMA', { reason: 'more_than_one_posting_without_amount', line: header_line });
      if (blanks === 1) {
        const known = parsed.filter((x) => x !== null);
        const ccy0 = known[0]?.ccy;
        if (ccy0 === undefined || known.some((x) => x.ccy !== ccy0)) fail('E_SCHEMA', { reason: 'cannot_infer_amount', line: header_line });
        const sum = known.reduce((s, x) => s + x.minor, 0);
        parsed[parsed.indexOf(null)] = { minor: 0 - sum, ccy: ccy0, exp: known[0].exp };
      }
      const assets = postings.map((p, k) => ({ p, a: parsed[k] })).filter((x) => is_asset(x.p.account));
      const others = postings.map((p, k) => ({ p, a: parsed[k] })).filter((x) => !is_asset(x.p.account));
      if (assets.length === 0) continue; // проводка без активных счетов — не денежный поток Runway
      const anchored = assets.filter((x) => x.p.assertion !== null);
      const equity_only = others.length > 0 && others.every((x) => x.p.account.startsWith('equity:'));
      for (const x of anchored) {
        const acc = ensure_account(x.p.account, x.a.ccy, x.a.exp);
        const target = hl_amount(x.p.assertion, x.p.line, commodities);
        const aid = `anc_${acc.account_id}_${date.replace(/-/g, '')}`;
        push('anchor.set', { anchor_id: aid, account_id: acc.account_id, date, amount_minor: target.minor });
      }
      if (anchored.length > 0 && equity_only) continue; // якорь: дельта к балансу не является движением денег
      if (assets.length > 2) fail('E_SCHEMA', { reason: 'more_than_two_asset_postings_not_supported', line: header_line });
      const tag = others.length === 1 ? counter_tag(others[0].p.account) : null;
      const transfer_id = assets.length === 2 ? `tr_${++tr_n}` : null;
      for (const x of assets) {
        const acc = ensure_account(x.p.account, x.a.ccy, x.a.exp);
        const p = { account_id: acc.account_id, date, amount_minor: x.a.minor, currency: x.a.ccy, note: desc };
        if (tag !== null) p.tag = tag;
        if (transfer_id !== null) p.transfer_id = transfer_id;
        seq += 1;
        const id = 'hl-' + String(seq).padStart(6, '0');
        events.push(make_event('tx.posted', p, { event_id: id, seq, recorded_at, entity_id: id }));
      }
      continue;
    }
    i += 1; // неизвестная директива — пропускаем
  }
  return reduce(effective_events(events));
}
