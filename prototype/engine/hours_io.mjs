// hours_io.mjs — импорт отработанных часов из CSV (ALG-07 A07.7, IDEA-18; волна 3а-2, FP-29).
// Файл с часами (по дням или по периодам) → «отработано N часов» за период потока: правки `set_stream_hours` рабочей области (вид правки регистрирует
// демо, FP-08). Разбор — поверх `parse_csv` движка; профиль «часы» — данные (data/profiles/hours-csv-1.json), исполняемых полей нет.
// Сухой прогон устроен как у фактов (ALG-14): «распознано · отклонено · дубликатов», сумма трёх равна числу строк файла; дубликат — строка периода,
// чей итог уже записан; повторный импорт того же файла даёт 0 новых. Откат партии возвращает прежние значения периодов (`rollback_edits`).
//
// Правила разбора. Часы одного потока за один период складываются (файл по дням → итог периода); итог ЗАМЕНЯЕТ записанное «отработано» периода, а не
// прибавляется к нему (иначе повторный импорт удваивал бы часы). Целые минуты: дробь часов округляется до минуты (half_even) и это считается в
// предупреждении `rounded_rows` отчёта, а не делается молча. Период, который ещё не начался на дату расчёта, отвергается (`future_period`).
// Деньги в модуле не участвуют: время — целые минуты. Расчёт по введённым данным и правилам, не консультация.
// Зависимости: money, dates, hourly, io. Модуль чистый (ни часов, ни случайности, ни DOM); из index.mjs не реэкспортируется.

import { fail } from './money.mjs';
import { format_date, to_epoch_day } from './dates.mjs';
import { period_bounds } from './hourly.mjs';
import { parse_csv, parse_date_fmt, MAX_IMPORT_BYTES } from './io.mjs';

/** Идентификатор встроенного профиля «часы». */
export const HOURS_PROFILE_ID = 'hours-csv/1';
/** Единицы колонки часов: десятичные часы («7,5»), целые минуты («450»), «часы:минуты» («7:30»). */
export const HOURS_UNITS = Object.freeze(['hours', 'minutes', 'hm']);
/** Верхняя граница итога одного периода, минут: 31 сутки (как у вида правки `set_stream_hours`). */
export const MAX_PERIOD_MINUTES = 31 * 24 * 60;
/** Причины отклонения строки. Для каждой есть строка `importv11.rj_<причина>` в каталоге демо. */
export const HOURS_REJECT_REASONS = Object.freeze([
  'short_row', 'bad_date', 'future_period', 'unknown_stream', 'empty_hours', 'bad_hours', 'over_period',
]);

/**
 * Встроенный профиль «часы»: колонки `date` и `hours` (десятичные часы), необязательная колонка `stream`. Совпадает с data/profiles/hours-csv-1.json
 * (тест сверки). Если колонки потока нет или ячейка пуста, берётся поток, выбранный в мастере.
 */
export const HOURS_PROFILE = Object.freeze({
  profile_id: HOURS_PROFILE_ID,
  v: 1,
  kind: 'hours',
  encoding: 'utf-8',
  delimiter: ',',
  skip: 0,
  date: Object.freeze({ col: 'date', fmt: 'YYYY-MM-DD' }),
  hours: Object.freeze({ col: 'hours', unit: 'hours', decimal: '.' }),
  stream: Object.freeze({ col: 'stream' }),
});

const PROFILE_KEYS = new Set(['profile_id', 'v', 'kind', 'encoding', 'delimiter', 'skip', 'date', 'hours', 'stream']);
const is_col = (c) => (typeof c === 'string' && c !== '') || (Number.isInteger(c) && c >= 0);
const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Профиль «часы» (а не профиль фактов): по полю `kind`. */
export function is_hours_profile(p) {
  return is_obj(p) && p.kind === 'hours';
}

/**
 * Проверка профиля «часы»: только известные поля, никаких исполняемых значений. Не бросает исключений.
 * @param {object} profile
 * @returns {{ok: boolean, errors: {field: string, reason: string}[]}}
 */
export function validate_hours_profile(profile) {
  const errors = [];
  const bad = (field, reason) => errors.push({ field, reason });
  const only = (obj, allowed, where) => { for (const k of Object.keys(obj)) if (!allowed.has(k)) bad(where + '.' + k, 'unknown_field'); };
  if (!is_obj(profile)) return { ok: false, errors: [{ field: '', reason: 'not_object' }] };
  for (const k of Object.keys(profile)) if (!PROFILE_KEYS.has(k)) bad(k, 'unknown_field');
  if (profile.kind !== 'hours') bad('kind', 'must_be_hours');
  if (profile.profile_id !== undefined && typeof profile.profile_id !== 'string') bad('profile_id', 'not_string');
  if (profile.v !== undefined && profile.v !== 1) bad('v', 'unsupported_version');
  if (profile.encoding !== undefined && typeof profile.encoding !== 'string') bad('encoding', 'not_string');
  if (![',', ';', '\t'].includes(profile.delimiter)) bad('delimiter', 'must_be_comma_semicolon_or_tab');
  if (profile.skip !== undefined && !(Number.isInteger(profile.skip) && profile.skip >= 0)) bad('skip', 'not_nonneg_int');
  const d = profile.date;
  if (!is_obj(d)) bad('date', 'required_object');
  else {
    only(d, new Set(['col', 'fmt']), 'date');
    if (!is_col(d.col)) bad('date.col', 'bad_column');
    if (typeof d.fmt !== 'string' || !/(YYYY)/.test(d.fmt) || !/(MM?)/.test(d.fmt) || !/(DD?)/.test(d.fmt)) bad('date.fmt', 'needs_year_month_day');
  }
  const hs = profile.hours;
  if (!is_obj(hs)) bad('hours', 'required_object');
  else {
    only(hs, new Set(['col', 'unit', 'decimal']), 'hours');
    if (!is_col(hs.col)) bad('hours.col', 'bad_column');
    if (!HOURS_UNITS.includes(hs.unit)) bad('hours.unit', 'must_be_hours_minutes_or_hm');
    if (hs.decimal !== undefined && hs.decimal !== '.' && hs.decimal !== ',') bad('hours.decimal', 'must_be_dot_or_comma');
  }
  if (profile.stream !== undefined) {
    if (!is_obj(profile.stream)) bad('stream', 'not_object');
    else {
      only(profile.stream, new Set(['col']), 'stream');
      if (!is_col(profile.stream.col)) bad('stream.col', 'bad_column');
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Целое от `a` по `b` с округлением half_even; a ≥ 0, b > 0, оба — безопасные целые. */
function div_half_even(a, b) {
  const q = Math.floor(a / b);
  const r = a - q * b;
  if (2 * r < b) return q;
  if (2 * r > b) return q + 1;
  return q % 2 === 0 ? q : q + 1;
}

/**
 * Одна ячейка часов → целые минуты.
 * `hours`: десятичная запись с десятичным знаком профиля (до 4 знаков дроби), дробь округляется до минуты (half_even) и помечается `rounded`;
 * `minutes`: целое; `hm`: «ч:мм» (минуты двумя цифрами, 0–59). Пустая ячейка, знак, мусор — отказ.
 * @param {string} cell
 * @param {'hours'|'minutes'|'hm'} unit
 * @param {'.'|','} [decimal]
 * @returns {{ok: true, minutes: number, rounded: boolean} | {ok: false, reason: 'empty'|'bad'}}
 */
export function parse_hours_cell(cell, unit, decimal = '.') {
  const s = typeof cell === 'string' ? cell.trim() : '';
  if (s === '') return { ok: false, reason: 'empty' };
  if (unit === 'minutes') {
    if (!/^\d{1,7}$/.test(s)) return { ok: false, reason: 'bad' };
    return { ok: true, minutes: Number(s), rounded: false };
  }
  if (unit === 'hm') {
    const m = /^(\d{1,5}):([0-5]\d)$/.exec(s);
    if (m === null) return { ok: false, reason: 'bad' };
    return { ok: true, minutes: Number(m[1]) * 60 + Number(m[2]), rounded: false };
  }
  if (unit !== 'hours') return { ok: false, reason: 'bad' };
  const dec = decimal === ',' ? ',' : '.';
  const m = new RegExp('^(\\d{1,5})(?:' + (dec === '.' ? '\\.' : ',') + '(\\d{1,4}))?$').exec(s);
  if (m === null) return { ok: false, reason: 'bad' };
  const whole = Number(m[1]);
  const frac = m[2] ?? '';
  if (frac === '') return { ok: true, minutes: whole * 60, rounded: false };
  const den = 10 ** frac.length;
  const num = Number(frac) * 60; // минут в дроби = num / den
  const min_frac = div_half_even(num, den);
  return { ok: true, minutes: whole * 60 + min_frac, rounded: num % den !== 0 };
}

/** Имя для сравнения: без регистра и лишних пробелов. */
const name_key = (s) => String(s).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Поток по ячейке файла: точный `stream_id`, иначе единственный поток с тем же названием (без учёта регистра); пустая ячейка — выбранный поток.
 * Неоднозначность (два потока с одним названием) и неизвестное значение дают `null`.
 * @param {object[]} streams
 * @param {string} cell
 * @param {string|null} default_id
 * @returns {object|null}
 */
export function find_stream(streams, cell, default_id) {
  const list = Array.isArray(streams) ? streams.filter(is_obj) : [];
  const s = typeof cell === 'string' ? cell.trim() : '';
  if (s === '') return default_id === null || default_id === undefined ? null : (list.find((x) => x.stream_id === default_id) ?? null);
  const by_id = list.find((x) => x.stream_id === s);
  if (by_id !== undefined) return by_id;
  const k = name_key(s);
  const hits = list.filter((x) => typeof x.name === 'string' && name_key(x.name) === k);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Разбор файла с часами по профилю: строки с потоком, началом периода и минутами; отклонённые — с причиной. Часы не складываются
 * (это делает `aggregate_hours`): здесь одна строка файла — одна запись.
 * @param {string} text
 * @param {object} profile профиль «часы» (`validate_hours_profile`)
 * @param {{streams: object[], stream_id?: string|null, as_of: string|number}} ctx `stream_id` — поток для строк без колонки или с пустой ячейкой потока
 * @returns {{rows: {row: number, stream_id: string, period_start: string, minutes: number, rounded: boolean}[], rejects: {row: number, reason: string}[], rows_total: number, header: string[]}}
 * @throws {RunwayError} E_SCHEMA — плохой профиль, файл больше 5 МБ, незакрытая кавычка, нет заголовка, неизвестная колонка
 */
export function import_hours_csv(text, profile, ctx) {
  const v = validate_hours_profile(profile);
  if (!v.ok) fail('E_SCHEMA', { reason: 'bad_profile', errors: v.errors });
  if (typeof text !== 'string') fail('E_SCHEMA', { reason: 'text_not_string' });
  if (!is_obj(ctx) || !Array.isArray(ctx.streams)) fail('E_SCHEMA', { reason: 'ctx_required', need: 'streams, as_of' });
  if (text.length > MAX_IMPORT_BYTES || (text.length * 3 > MAX_IMPORT_BYTES && new TextEncoder().encode(text).length > MAX_IMPORT_BYTES)) {
    fail('E_SCHEMA', { reason: 'file_too_large', limit: MAX_IMPORT_BYTES });
  }
  const as_of = to_epoch_day(ctx.as_of);
  const skip = profile.skip ?? 0;
  const table = parse_csv(text, { delimiter: profile.delimiter });
  if (table.length <= skip) fail('E_SCHEMA', { reason: 'no_header_row' });
  const header = table[skip].map((c) => c.trim());
  const data = table.slice(skip + 1);
  const col_ix = (ref, where) => {
    if (typeof ref === 'number') {
      if (ref >= header.length) fail('E_SCHEMA', { reason: 'column_index_out_of_header', where, col: ref });
      return ref;
    }
    const i = header.indexOf(ref);
    if (i < 0) fail('E_SCHEMA', { reason: 'unknown_column', where, col: ref });
    return i;
  };
  const ix = { date: col_ix(profile.date.col, 'date'), hours: col_ix(profile.hours.col, 'hours') };
  // колонка потока необязательна: её нет в заголовке — все строки относятся к выбранному потоку
  const stream_ix = profile.stream === undefined ? -1 : (typeof profile.stream.col === 'number' ? col_ix(profile.stream.col, 'stream') : header.indexOf(profile.stream.col));
  const need = Math.max(ix.date, ix.hours, stream_ix) + 1;
  const streams = ctx.streams;
  const default_id = typeof ctx.stream_id === 'string' ? ctx.stream_id : null;
  const rows = [];
  const rejects = [];
  data.forEach((r, i) => {
    const row = skip + 2 + i;
    const reject = (reason) => { rejects.push({ row, reason }); };
    if (r.length < need) return reject('short_row');
    const d = parse_date_fmt(r[ix.date].trim(), profile.date.fmt);
    if (d === null) return reject('bad_date');
    const stream = find_stream(streams, stream_ix < 0 ? '' : r[stream_ix], default_id);
    if (stream === null) return reject('unknown_stream');
    let period;
    try { period = period_bounds(stream, d); } catch (e) { if (e?.name === 'RunwayError') return reject('unknown_stream'); throw e; }
    if (period.start > as_of) return reject('future_period');
    const h = parse_hours_cell(r[ix.hours], profile.hours.unit, profile.hours.decimal ?? '.');
    if (!h.ok) return reject(h.reason === 'empty' ? 'empty_hours' : 'bad_hours');
    rows.push({ row, stream_id: stream.stream_id, period_start: format_date(period.start), minutes: h.minutes, rounded: h.rounded });
  });
  return { rows, rejects, rows_total: data.length, header };
}

/**
 * Итоги периодов: часы одного потока за один период складываются. Итог больше 31 суток отвергает все строки периода (`over_period`).
 * @param {{row: number, stream_id: string, period_start: string, minutes: number, rounded: boolean}[]} rows
 * @returns {{groups: {stream_id: string, period_start: string, minutes: number, rows: number[], rounded: number}[], rejects: {row: number, reason: string}[]}}
 */
export function aggregate_hours(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = r.stream_id + '\u0000' + r.period_start;
    let g = by.get(k);
    if (g === undefined) { g = { stream_id: r.stream_id, period_start: r.period_start, minutes: 0, rows: [], rounded: 0 }; by.set(k, g); }
    g.minutes += r.minutes;
    g.rows.push(r.row);
    if (r.rounded) g.rounded += 1;
  }
  const groups = [];
  const rejects = [];
  for (const g of by.values()) {
    if (!Number.isSafeInteger(g.minutes) || g.minutes > MAX_PERIOD_MINUTES) { for (const row of g.rows) rejects.push({ row, reason: 'over_period' }); continue; }
    groups.push(g);
  }
  groups.sort((a, b) => (a.stream_id < b.stream_id ? -1 : a.stream_id > b.stream_id ? 1 : (a.period_start < b.period_start ? -1 : a.period_start > b.period_start ? 1 : 0)));
  return { groups, rejects };
}

/** Записанное «отработано» периода потока (минуты) или `null`. */
export function recorded_minutes(stream, period_start) {
  const v = stream?.hours_by_period?.[period_start]?.actual_minutes;
  return Number.isSafeInteger(v) ? v : null;
}

/**
 * Сухой прогон часов: что изменится в рабочей области. Период, чей итог уже записан, — дубликат (все его строки); иначе — изменение
 * (`before` — прежнее значение или `null`, `after` — итог файла). Рабочая область не меняется.
 * @param {string} text
 * @param {object} profile
 * @param {{streams: object[], stream_id?: string|null, as_of: string|number}} ctx
 * @returns {{rows_total: number, recognized: number, rejected: number, duplicates: number, sum_ok: boolean, by_reason: Object<string, number>,
 *   reject_rows: {row: number, reason: string}[], changes: {stream_id: string, period_start: string, before: number|null, after: number, rows: number}[],
 *   unchanged: number, replaced: number, rounded_rows: number, from: string|null, to: string|null, header: string[]}}
 */
export function dry_run_hours(text, profile, ctx) {
  const parsed = import_hours_csv(text, profile, ctx);
  const agg = aggregate_hours(parsed.rows);
  const rejects = [...parsed.rejects, ...agg.rejects].sort((a, b) => a.row - b.row);
  const by_id = new Map(ctx.streams.filter(is_obj).map((s) => [s.stream_id, s]));
  const changes = [];
  let unchanged = 0;
  let recognized = 0;
  let duplicates = 0;
  let rounded_rows = 0;
  for (const g of agg.groups) {
    const before = recorded_minutes(by_id.get(g.stream_id), g.period_start);
    if (before === g.minutes) { unchanged += 1; duplicates += g.rows.length; continue; }
    changes.push({ stream_id: g.stream_id, period_start: g.period_start, before, after: g.minutes, rows: g.rows.length });
    recognized += g.rows.length;
    rounded_rows += g.rounded;
  }
  const by_reason = {};
  for (const r of rejects) by_reason[r.reason] = (by_reason[r.reason] ?? 0) + 1;
  const starts = agg.groups.map((g) => g.period_start).sort();
  return {
    rows_total: parsed.rows_total, recognized, rejected: rejects.length, duplicates,
    sum_ok: recognized + rejects.length + duplicates === parsed.rows_total,
    by_reason, reject_rows: rejects.slice(0, 200), changes, unchanged, replaced: changes.filter((c) => c.before !== null).length, rounded_rows,
    from: starts.length === 0 ? null : starts[0], to: starts.length === 0 ? null : starts[starts.length - 1], header: parsed.header,
  };
}

/** Правки `set_stream_hours` по изменениям сухого прогона (по порядку потоков и периодов). */
export function hours_edits(changes) {
  return changes.map((c) => ({ type: 'set_stream_hours', stream_id: c.stream_id, period_start: c.period_start, actual_minutes: c.after }));
}

/**
 * Правки отката партии: вернуть прежнее значение (`before`, `null` — снять факт) только там, где сейчас записано то, что внёс импорт (`after`).
 * Период, который пользователь потом изменил сам, не трогается и считается в `kept`; исчезнувший поток — в `gone`.
 * @param {{stream_id: string, period_start: string, before: number|null, after: number}[]} changes изменения партии
 * @param {object[]} streams потоки рабочей области сейчас
 * @returns {{edits: object[], kept: number, gone: number}}
 */
export function rollback_edits(changes, streams) {
  const by_id = new Map((Array.isArray(streams) ? streams : []).filter(is_obj).map((s) => [s.stream_id, s]));
  const edits = [];
  let kept = 0;
  let gone = 0;
  for (const c of changes) {
    const s = by_id.get(c.stream_id);
    if (s === undefined) { gone += 1; continue; }
    if (recorded_minutes(s, c.period_start) !== c.after) { kept += 1; continue; }
    edits.push({ type: 'set_stream_hours', stream_id: c.stream_id, period_start: c.period_start, actual_minutes: c.before });
  }
  return { edits, kept, gone };
}
