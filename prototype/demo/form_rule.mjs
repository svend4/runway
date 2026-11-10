// form_rule.mjs — форма регулярного платежа или поступления (правило повторения) и действия с одним вхождением (FP-08, FP-13, REQ-009, REQ-010, REQ-032, ALG-01, IDEA-05).
//
// Что делает форма: собирает правило (`upsert_rule`) из текстовых полей, до записи показывает ближайшие даты и суммы (предпросмотр через `expand_all`
// движка — те же вхождения, что увидит прогноз), записывает общим путём. Поля правила: календарь выходных и праздников (список календарей рабочей области),
// политика переноса («оставить / на рабочий день раньше / позже / пропустить»), день месяца ИЛИ n-й рабочий день месяца (`by_workday`, отрицательные — с конца);
// правка существующего правила НЕ теряет ни одно из этих условий (список дней месяца и дней недели, `by_workday`, календарь, поля вне формы). Если политика
// или n-й рабочий день требуют календаря, а его нет, форма говорит об этом и предлагает создать календарь, а не молчит (REQ-009).
// Действия с ОДНИМ вхождением (REQ-010, REQ-032): «Пропустить» (вхождение уходит из потока и ряда, запись остаётся в истории), «Перенести» на дату (дата точная, без сдвига
// по выходным) и «Другая сумма» этого платежа; каждое до записи показывает результат (то же вхождение до и после, ближайшие даты), серия не разрывается,
// «Вернуть как по правилу» снимает запись. Запись — `override` (`ws.overrides`, ключ `rule_id@nominal_date`): повтор той же правки не меняет данные (идемпотентно).
// Вид правки `set_occurrence_override` регистрирует пакет (`register_edit`); проверка — `validate_override` движка, номинальная дата обязана быть
// настоящим вхождением правила. Точка расширения `register_rule_block` (как `register_debt_block` у «Долгов»): пакет FP-13 кладёт под форму правила карточки
// «Разовый платёж» и «Календарь выходных и праздников» без обратного импорта; без пакета раздел работает как прежде.
// Файл: чистая часть (разбор формы, предпросмотр, правка) и узлы. Расчёт по введённым данным и правилам, не консультация.

import { fail, expand_all, nominal_dates, make_calendar, parse_date, format_date, to_epoch_day, validate_override, currency_exponent } from '../engine/index.mjs';
import { h, el_by_id } from './dom.mjs';
import { apply_edit } from './ws_edit.mjs';
import { WEEKDAYS_SHORT } from './i18n.mjs';
import { clock_ports } from './ids.mjs';
import { create_focus_keeper } from './focus_keep.mjs';
import { format_input_amount, resolve_number_format } from './number_format.mjs';
import {
  bad, first_error, list_of, env_of, fmt_of, parse_money, parse_count, parse_signed_int, parse_date_flexible, open_accounts, account_label,
  commit_edits, error_text, text_field, select_field, check_field, show_field_error, is_checked, form_card, kids,
} from './forms.mjs';

export const RULE_KINDS = Object.freeze(['expense', 'income']);
export const RULE_FREQS = Object.freeze(['M', 'W', 'Y', 'D']);
export const WEEKEND_POLICIES = Object.freeze(['keep', 'prev', 'next', 'skip']);

/** Сколько ближайших дат показывает предпросмотр и список. */
export const PREVIEW_ROWS = 6;
const PREVIEW_DAYS = 800;
/** Запас окна (дней) при поиске одного вхождения по номинальной дате: сдвиг по выходным и праздникам лежит внутри. */
const OCC_SPAN = 45;

const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// ── разбор формы → правка ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Список целых через пробел, запятую или точку с запятой: «1, 15, −1» → [1, 15, -1]; повторы убираются, порядок ввода сохраняется.
 * Отказ — код и поле без повтора введённого.
 * @returns {{ok: true, value: number[]}|{ok: false, error: {code: string, ctx: object}}}
 */
export function parse_int_list(text, field, min, max) {
  const tokens = String(text ?? '').trim().split(/[\s,;]+/).filter((x) => x !== '');
  if (tokens.length === 0) return bad('E_NOT_INTEGER', field, 'empty');
  if (tokens.length > 31) return bad('E_SCHEMA', field, 'range');
  const out = [];
  for (const tk of tokens) {
    const r = parse_signed_int(tk, field, min, max);
    if (!r.ok) return r;
    if (!out.includes(r.value)) out.push(r.value);
  }
  return { ok: true, value: out };
}

/**
 * Собрать правку `upsert_rule` из текстовых полей формы.
 * @param {object} ws рабочая область
 * @param {{rule_id: string, name: string, kind: string, amount: string, account_id: string, freq: string, interval: string, start_date: string,
 *   monthday?: string, workday?: string, weekday?: string, weekend?: string, calendar_id?: string, until_date?: string, is_obligation?: boolean, is_estimate?: boolean}} t тексты полей;
 *   `calendar_id` — выбранный календарь (пустая строка — календарь по умолчанию: суббота и воскресенье, без праздников; поле не передано — календарь правила не меняется);
 *   `workday` — «n-й рабочий день месяца» (список целых; поле не передано — прежнее значение правила сохраняется)
 * @param {{cur: string, lang: 'ru'|'en', nf?: any, as_of: string}} env
 * @returns {{ok: true, edit: {type: 'upsert_rule', rule: object}}|{ok: false, error: {code: string, ctx: object}}}
 */
export function build_rule_edit(ws, t, env) {
  if (!is_obj(t)) return bad('E_SCHEMA', 'form', 'not_object');
  const name = typeof t.name === 'string' ? t.name.trim() : '';
  if (name === '') return bad('E_SCHEMA', 'name', 'empty');
  const acc = list_of(ws, 'accounts').find((a) => a?.account_id === t.account_id);
  if (acc === undefined) return bad('E_SCHEMA', 'account_id', 'unknown_account');
  if (!RULE_KINDS.includes(t.kind)) return bad('E_SCHEMA', 'kind', 'not_in_list');
  if (!RULE_FREQS.includes(t.freq)) return bad('E_SCHEMA', 'freq', 'not_in_list');
  const weekend = t.weekend === undefined || t.weekend === '' ? 'keep' : t.weekend;
  if (!WEEKEND_POLICIES.includes(weekend)) return bad('E_SCHEMA', 'weekend', 'not_in_list');
  const amount = parse_money(t.amount, env, 'amount', { cur: acc.currency });
  const interval = parse_count(t.interval, 'interval', 1, 999);
  // поля даты — `<input type="date">`: браузер отдаёт ISO при любом стиле дат рабочей области (ДД.ММ.ГГГГ, ММ/ДД/ГГГГ), поэтому разбор «гибкий»
  const start = parse_date_flexible(t.start_date, env, 'start_date');
  const until = parse_date_flexible(t.until_date, env, 'until_date', { optional: true });
  const monthday = t.freq === 'M' && typeof t.monthday === 'string' && t.monthday.trim() !== '' ? parse_int_list(t.monthday, 'monthday', -31, 31) : { ok: true, value: null };
  const workday_text = typeof t.workday === 'string' ? t.workday.trim() : null;
  let workday = { ok: true, value: null };
  if (workday_text !== null && workday_text !== '') workday = t.freq === 'M' ? parse_int_list(workday_text, 'workday', -31, 31) : bad('E_RULE_INVALID', 'workday', 'only_for_M');
  const err = first_error([amount, interval, start, until, monthday, workday]);
  if (err !== null) return err;
  if (monthday.value !== null && workday.value !== null) return bad('E_RULE_INVALID', 'workday', 'exclusive_with_monthday');
  const old = list_of(ws, 'rules').find((r) => r?.rule_id === t.rule_id);
  // поле «n-й рабочий день» не передано (прежние вызовы): значение правила не теряется, если день месяца не задан
  if (workday_text === null && t.freq === 'M' && monthday.value === null && Array.isArray(old?.by_workday)) workday = { ok: true, value: old.by_workday.slice() };
  const sign = t.kind === 'expense' ? -1 : 1;
  const exp_minor = sign * amount.value;
  const rule = {
    ...(old === undefined ? { month_end: 'clamp', exdates: [] } : JSON.parse(JSON.stringify(old))),
    rule_id: t.rule_id, account_id: acc.account_id, name, kind: t.kind, currency: acc.currency, freq: t.freq, interval: interval.value,
    start_date: start.value, weekend, is_obligation: t.is_obligation === true, is_estimate: t.is_estimate === true,
  };
  rule.amount = old !== undefined && is_obj(old.amount) && old.amount.exp_minor === exp_minor ? { ...old.amount } : { exp_minor };
  for (const k of ['by_monthday', 'by_weekday', 'by_workday']) delete rule[k]; // условия берутся только из полей формы
  if (t.freq === 'M' && monthday.value !== null) rule.by_monthday = monthday.value;
  if (t.freq === 'M' && workday.value !== null) rule.by_workday = workday.value;
  if (t.freq === 'W' && typeof t.weekday === 'string' && /^[0-6](,[0-6])*$/.test(t.weekday)) rule.by_weekday = [...new Set(t.weekday.split(',').map(Number))];
  if (until.value === null) delete rule.until_date; else rule.until_date = until.value;
  const has_cal = rule.calendar_id !== undefined && rule.calendar_id !== null;
  if (typeof t.calendar_id === 'string') {
    // календарь выбран явно (пустая строка — «по умолчанию»); неизвестный отвергается, а не подменяется
    if (t.calendar_id === '') delete rule.calendar_id;
    else if (!list_of(ws, 'calendars').some((c) => c?.calendar_id === t.calendar_id)) return bad('E_SCHEMA', 'calendar_id', 'unknown_calendar');
    else rule.calendar_id = t.calendar_id;
  } else if (weekend !== 'keep' && !has_cal) {
    const cal = list_of(ws, 'calendars')[0];
    if (cal !== undefined) rule.calendar_id = cal.calendar_id; // прежние вызовы без поля: берётся первый календарь рабочей области
  }
  return { ok: true, edit: { type: 'upsert_rule', rule } };
}

/**
 * Что форма говорит о календаре (REQ-009): нужен ли он выбранной политике или n-му рабочему дню и чем заменён, если его нет.
 * `no_calendars` — в рабочей области нет ни одного календаря (считается «суббота и воскресенье, без праздников»; форма предлагает создать свой);
 * `default_chosen` — календари есть, но выбран «по умолчанию»; `none` — сказать нечего.
 * @param {object} ws
 * @param {{weekend?: string, freq?: string, workday?: string, calendar_id?: string}} t
 * @returns {'none'|'no_calendars'|'default_chosen'}
 */
export function calendar_notice(ws, t) {
  const policy = t?.weekend ?? 'keep';
  const needs = (policy !== 'keep' && policy !== '') || (t?.freq === 'M' && typeof t?.workday === 'string' && t.workday.trim() !== '');
  if (!needs) return 'none';
  if (list_of(ws, 'calendars').length === 0) return 'no_calendars';
  return t?.calendar_id === '' ? 'default_chosen' : 'none';
}

/**
 * Предпросмотр правила: ближайшие вхождения с эффективной датой и суммой — те же, что раскроет прогноз (`expand_all`), с учётом записанных
 * исключений (`ws.overrides`). Правка проходит `apply_edit` на копии: невалидное правило даёт код, а не даты.
 * @param {object} ws
 * @param {{type: 'upsert_rule', rule: object}} edit
 * @param {{as_of?: string, rows?: number, new_id?: (p: string) => string}} [o]
 * @returns {{ok: true, rows: {nominal: string, date: string, amount_minor: number, currency: string}[]}|{ok: false, error: object}}
 */
export function rule_preview(ws, edit, o = {}) {
  const r = apply_edit(ws, edit, { new_id: o.new_id, as_of: o.as_of });
  if (!r.ok) return r;
  const rule = list_of(r.ws, 'rules').find((x) => x.rule_id === edit.rule.rule_id);
  return { ok: true, rows: occurrences_of(r.ws, rule, o.as_of ?? ws.as_of, o.rows ?? PREVIEW_ROWS) };
}

/**
 * Ближайшие вхождения правила от `as_of`: номинальная и эффективная даты, сумма. Пропущенные вхождения в список не входят (их показывает `skipped_of`).
 * @returns {{nominal: string, date: string, amount_minor: number, currency: string, overridden: boolean}[]}
 */
export function occurrences_of(ws, rule, as_of, rows = PREVIEW_ROWS) {
  const from = to_epoch_day(as_of);
  const occ = expand_all([rule], { from, to: from + PREVIEW_DAYS }, list_of(ws, 'calendars'), list_of(ws, 'overrides'));
  return occ.slice(0, rows).map((x) => ({
    nominal: format_date(x.nominal), date: format_date(x.date), amount_minor: x.amount_minor, currency: x.currency ?? rule.currency, overridden: x.overridden === true,
  }));
}

/**
 * Номинальная дата — настоящее вхождение правила при его нынешних условиях и календаре (те же `nominal_dates` и календарь правила, что у проверки правки).
 * Праздник или смена календаря сдвигают номинальную дату «n-го рабочего дня»: прежняя дата перестаёт быть вхождением, и правка по ней уже ничего не меняет.
 * Календарь, который не удалось собрать, не даёт повода объявлять правку «осиротевшей»: тогда ответ «да».
 */
export function is_occurrence_of(ws, rule, nominal_iso) {
  try {
    const n = parse_date(nominal_iso);
    const spec = rule.calendar_id === undefined || rule.calendar_id === null ? undefined : list_of(ws, 'calendars').find((c) => c?.calendar_id === rule.calendar_id);
    return nominal_dates(rule, n, n, make_calendar(spec)).length === 1;
  } catch { return true; }
}

/** Запись о вхождении действует: правила нет в данных (проверять нечего) или её номинальная дата — настоящее вхождение. */
function override_is_live(ws, rule, o) {
  return rule === undefined || is_occurrence_of(ws, rule, String(o.nominal_date));
}

/** Пропущенные вхождения правила (записи `override` с `action = skip`), не раньше `as_of`: можно вернуть. Осиротевшие правки (`orphaned_of`) сюда не входят. */
export function skipped_of(ws, rule_id, as_of) {
  const rule = list_of(ws, 'rules').find((r) => r?.rule_id === rule_id);
  return list_of(ws, 'overrides').filter((o) => o?.rule_id === rule_id && o.action === 'skip' && String(o.nominal_date) >= as_of && override_is_live(ws, rule, o))
    .map((o) => o.nominal_date).sort();
}

/**
 * Перенесённые и «со своей суммой» вхождения правила (`move`, `set_amount`), которые ещё впереди: по номинальной ИЛИ новой дате не раньше `as_of`.
 * Их можно вернуть «как по правилу»; список нужен, потому что перенесённое вхождение может уйти за пределы ближайших дат и пропасть из виду.
 * Осиротевшие правки (`orphaned_of`) сюда не входят: они уже ничего не меняют.
 * @returns {{nominal_date: string, action: 'move'|'set_amount', date?: string, amount_minor?: number}[]} по номинальной дате
 */
export function changed_of(ws, rule_id, as_of) {
  const rule = list_of(ws, 'rules').find((r) => r?.rule_id === rule_id);
  return list_of(ws, 'overrides')
    .filter((o) => is_obj(o) && o.rule_id === rule_id && (o.action === 'move' || o.action === 'set_amount')
      && (String(o.nominal_date) >= as_of || (o.action === 'move' && String(o.date) >= as_of)) && override_is_live(ws, rule, o))
    .sort((a, b) => (a.nominal_date < b.nominal_date ? -1 : a.nominal_date > b.nominal_date ? 1 : 0));
}

/**
 * «Осиротевшие» правки вхождений правила: запись `override` (пропуск, перенос, своя сумма) с номинальной датой не раньше `as_of`, которая после смены календаря или условий
 * правила больше не вхождение. Прогноз такую запись не применяет (платёж идёт по правилу), но она остаётся в данных; убрать её можно кнопкой «Убрать правку».
 * @returns {{nominal_date: string, action: string, date?: string, amount_minor?: number}[]} по номинальной дате
 */
export function orphaned_of(ws, rule_id, as_of) {
  const rule = list_of(ws, 'rules').find((r) => r?.rule_id === rule_id);
  if (rule === undefined) return [];
  return list_of(ws, 'overrides')
    .filter((o) => is_obj(o) && o.rule_id === rule_id && typeof o.nominal_date === 'string' && o.nominal_date >= as_of && !is_occurrence_of(ws, rule, o.nominal_date))
    .sort((a, b) => (a.nominal_date < b.nominal_date ? -1 : a.nominal_date > b.nominal_date ? 1 : 0));
}

/** Сколько осиротевших правок вхождений во всей рабочей области (по всем правилам), не раньше `as_of`. */
export function orphan_count(ws, as_of) {
  const from = typeof as_of === 'string' ? as_of : String(ws?.as_of ?? '');
  return list_of(ws, 'rules').reduce((n, r) => n + (is_obj(r) && typeof r.rule_id === 'string' ? orphaned_of(ws, r.rule_id, from).length : 0), 0);
}

/** Запись о вхождении по номинальной дате (`undefined`, если вхождение идёт по правилу). */
export function override_of(ws, rule_id, nominal) {
  return list_of(ws, 'overrides').find((o) => is_obj(o) && o.rule_id === rule_id && o.nominal_date === nominal);
}

/** Правка «пропустить вхождение» (REQ-032): запись `override` с `action = skip`; вхождение уходит из потока, но не из истории. */
export function skip_edit(rule_id, nominal_date) {
  return { type: 'set_occurrence_override', override: { rule_id, nominal_date, action: 'skip' } };
}

/** Правка «вернуть вхождение»: снимает запись `override` этого вхождения. */
export function restore_edit(rule_id, nominal_date) {
  return { type: 'set_occurrence_override', remove: true, rule_id, nominal_date };
}

/** Правка «перенести вхождение на дату» (REQ-010): `move` с точной датой (сдвиг по выходным для неё не применяется). */
export function move_edit(rule_id, nominal_date, date) {
  return { type: 'set_occurrence_override', override: { rule_id, nominal_date, action: 'move', date } };
}

/** Правка «своя сумма этого вхождения» (REQ-010): `set_amount` с суммой со знаком правила (расход меньше нуля). */
export function amount_edit(rule_id, nominal_date, amount_minor) {
  return { type: 'set_occurrence_override', override: { rule_id, nominal_date, action: 'set_amount', amount_minor } };
}

function rule_by_id(ws, rule_id) {
  return list_of(ws, 'rules').find((r) => r?.rule_id === rule_id);
}

/**
 * Разобрать поле «Перенести на дату» в правку `move`. Дата — ISO (поле `type="date"`) или в формате рабочей области; несуществующая — `E_BAD_DATE`.
 * @returns {{ok: true, edit: object}|{ok: false, error: {code: string, ctx: object}}}
 */
export function build_move_edit(ws, rule_id, nominal, text, env) {
  if (rule_by_id(ws, rule_id) === undefined) return bad('E_SCHEMA', 'rule_id', 'unknown_rule');
  const d = parse_date_flexible(text, env, 'move_date');
  if (!d.ok) return d;
  return { ok: true, edit: move_edit(rule_id, nominal, d.value) };
}

/**
 * Разобрать поле «Другая сумма» в правку `set_amount`. Сумма вводится без знака по формату чисел рабочей области в валюте правила;
 * знак задаёт вид правила (расход меньше нуля). Ноль и не число — отказ.
 * @returns {{ok: true, edit: object}|{ok: false, error: {code: string, ctx: object}}}
 */
export function build_amount_edit(ws, rule_id, nominal, text, env) {
  const rule = rule_by_id(ws, rule_id);
  if (rule === undefined) return bad('E_SCHEMA', 'rule_id', 'unknown_rule');
  const m = parse_money(text, env, 'amount', { cur: rule.currency });
  if (!m.ok) return m;
  return { ok: true, edit: amount_edit(rule_id, nominal, (rule.kind === 'expense' ? -1 : 1) * m.value) };
}

/**
 * Вхождение правила по номинальной дате с эффективной датой и суммой (через `expand_all`): то, что увидит прогноз. `null`, если вхождения нет или оно пропущено.
 * @param {number} [extra_days] насколько расширить окно (для переноса на далёкую дату)
 */
export function occurrence_at(ws, rule, nominal_iso, extra_days = 0) {
  const n = to_epoch_day(nominal_iso);
  const span = OCC_SPAN + extra_days;
  const occ = expand_all([rule], { from: n - span, to: n + span }, list_of(ws, 'calendars'), list_of(ws, 'overrides'));
  const hit = occ.find((x) => x.nominal === n);
  return hit === undefined ? null : { nominal: nominal_iso, date: format_date(hit.date), amount_minor: hit.amount_minor, currency: hit.currency ?? rule.currency, overridden: hit.overridden === true };
}

/**
 * Дата вхождения «по правилу», какой её видел пользователь в списке ДО переноса (FP-48): со сдвигом по выходным и праздникам правила, но без записи о переносе этого вхождения.
 * Номинальная дата правила (25 октября, воскресенье) и показанная дата (26 октября, понедельник при `weekend: next`) могут различаться; подпись «перенесено с …» называет показанную.
 * @param {object} ws
 * @param {object} rule
 * @param {string} nominal_iso номинальная дата вхождения
 * @returns {string|null} ISO-дата; `null`, если вхождения без записи нет (правило или календарь изменились)
 */
export function date_by_rule(ws, rule, nominal_iso) {
  const bare = { ...ws, overrides: list_of(ws, 'overrides').filter((o) => !(is_obj(o) && o.rule_id === rule.rule_id && o.nominal_date === nominal_iso)) };
  try { return occurrence_at(bare, rule, nominal_iso)?.date ?? null; } catch { return null; }
}

/**
 * Подпись у перенесённого вхождения: «перенесено с 26 октября (по правилу — 25 октября)». Названа показанная дата (ту выбирал пользователь), а дата правила — в скобках, только если она другая.
 * @param {(key: string, params?: object) => string} tr
 * @param {{date: (iso: string) => string}} f форматтер дат
 * @param {string} seen показанная дата до переноса (`date_by_rule`)
 * @param {string} nominal номинальная дата вхождения
 */
export function moved_from_text(tr, f, seen, nominal) {
  return seen === nominal ? tr('forms.ov_mark_moved', { from: f.date(nominal) }) : tr('forms.ov_mark_moved_rule', { from: f.date(seen), rule: f.date(nominal) });
}

/** Строка перенесённого вхождения вне ближайших дат: «Перенесено: 26 октября → 10 февраля 2027 (по правилу — 25 октября)»; дата правила в скобках, только если она другая. */
export function moved_row_text(tr, f, seen, o) {
  return seen === o.nominal_date
    ? tr('forms.ov_row_move', { from: f.date(o.nominal_date), to: f.date(o.date) })
    : tr('forms.ov_row_move_rule', { from: f.date(seen), to: f.date(o.date), rule: f.date(o.nominal_date) });
}

/**
 * Предпросмотр правки вхождения: то же вхождение до и после, ближайшие даты после правки (всё через `expand_all`). Правка проходит `apply_edit` на копии.
 * @param {object} ws
 * @param {string} rule_id
 * @param {string} nominal номинальная дата вхождения
 * @param {object} edit результат `move_edit` / `amount_edit`
 * @param {{as_of?: string, rows?: number}} [o]
 * @returns {{ok: true, before: object|null, after: object|null, rows: object[]}|{ok: false, error: object}}
 */
export function override_preview(ws, rule_id, nominal, edit, o = {}) {
  const r = apply_edit(ws, edit, { as_of: o.as_of });
  if (!r.ok) return r;
  const rule = rule_by_id(ws, rule_id);
  const rule2 = rule_by_id(r.ws, rule_id);
  const extra = edit.override?.action === 'move' ? Math.abs(to_epoch_day(edit.override.date) - to_epoch_day(nominal)) : 0;
  return {
    ok: true,
    before: occurrence_at(ws, rule, nominal, extra),
    after: occurrence_at(r.ws, rule2, nominal, extra),
    rows: occurrences_of(r.ws, rule2, o.as_of ?? ws.as_of, o.rows ?? 3),
  };
}

// ── вид правки `set_occurrence_override` ──────────────────────────────────────────────────────────────────────────────

const OVERRIDE_KEYS = ['rule_id', 'nominal_date', 'action', 'date', 'amount_minor'];

function key_of(o) {
  return o.rule_id + '@' + o.nominal_date;
}

/**
 * Вид правки для `ws_edit.register_edit`: `{type, override: {rule_id, nominal_date, action: 'skip'|'move'|'set_amount', date?, amount_minor?}}`
 * либо `{type, remove: true, rule_id, nominal_date}`. Правило должно существовать, номинальная дата — быть настоящим вхождением правила,
 * остальное проверяет `validate_override` движка. Запись с тем же ключом (`rule_id@nominal_date`) заменяется; остальные поля рабочей области не меняются.
 * Повтор той же правки идемпотентен: запись остаётся на своём месте и с теми же значениями (данные, `inputs_hash` и журнал не меняются).
 * @param {object} ws
 * @param {object} edit
 * @returns {object} новая рабочая область
 * @throws {RunwayError} E_SCHEMA, E_BAD_DATE
 */
export function edit_set_occurrence_override(ws, edit) {
  for (const k of Object.keys(edit)) if (!['type', 'override', 'remove', 'rule_id', 'nominal_date'].includes(k)) fail('E_SCHEMA', { field: 'edit', reason: 'unknown_field', key: k.slice(0, 40) });
  const all = list_of(ws, 'overrides');
  if (edit.remove === true) {
    if (typeof edit.rule_id !== 'string' || typeof edit.nominal_date !== 'string') fail('E_SCHEMA', { field: 'rule_id', reason: 'required' });
    const key = edit.rule_id + '@' + edit.nominal_date;
    if (!all.some((o) => key_of(o) === key)) fail('E_SCHEMA', { field: 'nominal_date', reason: 'unknown_override' });
    return { ...ws, overrides: all.filter((o) => key_of(o) !== key) };
  }
  const o = edit.override;
  if (!is_obj(o)) fail('E_SCHEMA', { field: 'override', reason: 'not_object' });
  for (const k of Object.keys(o)) if (!OVERRIDE_KEYS.includes(k)) fail('E_SCHEMA', { field: 'override', reason: 'unknown_field', key: k.slice(0, 40) });
  const rule = list_of(ws, 'rules').find((r) => r?.rule_id === o.rule_id);
  if (rule === undefined) fail('E_SCHEMA', { field: 'override.rule_id', reason: 'unknown_rule' });
  if (typeof o.nominal_date !== 'string') fail('E_BAD_DATE', { field: 'override.nominal_date', reason: 'not_iso_string' });
  let nominal;
  try { nominal = parse_date(o.nominal_date); } catch { fail('E_BAD_DATE', { field: 'override.nominal_date', reason: 'bad_date' }); }
  if (format_date(nominal) !== o.nominal_date) fail('E_BAD_DATE', { field: 'override.nominal_date', reason: 'not_canonical' });
  const cal_spec = rule.calendar_id === undefined || rule.calendar_id === null ? undefined : list_of(ws, 'calendars').find((c) => c.calendar_id === rule.calendar_id);
  if (nominal_dates(rule, nominal, nominal, make_calendar(cal_spec)).length !== 1) fail('E_SCHEMA', { field: 'override.nominal_date', reason: 'not_an_occurrence' });
  const v = validate_override(o, rule);
  if (!v.ok) fail(v.errors[0].code, { field: 'override.' + v.errors[0].field, reason: v.errors[0].reason });
  const item = { rule_id: o.rule_id, nominal_date: o.nominal_date, action: o.action };
  if (o.action === 'move') item.date = o.date;
  if (o.action === 'set_amount') item.amount_minor = o.amount_minor;
  const key = key_of(item);
  const next = all.some((x) => key_of(x) === key) ? all.map((x) => (key_of(x) === key ? item : x)) : [...all, item];
  return { ...ws, overrides: next };
}

// ── точка расширения: блоки под формой правила ─────────────────────────────────────────────────────────────────────────

/** Блоки раздела «Платежи» (`id` → {render, order}); порядок показа — по `order`, затем по порядку регистрации. */
const RULE_BLOCKS = new Map();

/**
 * Подключить блок под формой правила (пакет FP-13: «Разовый платёж», «Календарь выходных и праздников»). Без обратного импорта: раздел «Платежи» пакет не знает.
 * Повтор `id` заменяет блок (пакет может загрузиться дважды в одном процессе).
 * @param {string} id
 * @param {(ctx: object) => Node|Node[]|null} render
 * @param {number} [order]
 * @returns {() => void} снятие блока
 */
export function register_rule_block(id, render, order = 500) {
  if (typeof id !== 'string' || id === '' || typeof render !== 'function') throw new TypeError('register_rule_block: нужны идентификатор и функция');
  RULE_BLOCKS.set(id, { render, order });
  return () => { if (RULE_BLOCKS.get(id)?.render === render) RULE_BLOCKS.delete(id); };
}

/** Узлы блоков; упавший блок заменяется плашкой, остальной раздел цел. */
function block_nodes(ctx) {
  const out = [];
  const ordered = [...RULE_BLOCKS.entries()].map(([id, b], i) => ({ id, b, i })).sort((x, y) => x.b.order - y.b.order || x.i - y.i);
  for (const { id, b } of ordered) {
    try { out.push(...[b.render(ctx)].flat(Infinity).filter((n) => n !== null && n !== undefined && typeof n === 'object' && n.nodeType === 1)); } catch {
      out.push(h('p', { class: 'banner short', role: 'alert', text: ctx.tr('ext.block_failed', { id: 'rules/' + id }) }));
    }
  }
  return out;
}

// ── узлы ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Хранитель фокуса раздела: действие над вхождением перерисовывает экран, и нажатая кнопка из страницы уходит (WCAG 2.4.3). */
const FOCUS = create_focus_keeper(() => clock_ports().now_ms());

function weekday_options(ctx) {
  const names = WEEKDAYS_SHORT[ctx.lang()] ?? WEEKDAYS_SHORT.ru;
  return [{ value: '', text: ctx.tr('forms.weekday_none') }, ...[1, 2, 3, 4, 5, 6, 0].map((d) => ({ value: String(d), text: names[(d + 6) % 7] }))];
}

/** Строка о правиле для списка: имя · сумма · как часто. */
export function rule_line(ctx, ws, rule) {
  const f = fmt_of(env_of(ctx, ws), rule.currency);
  const freq = ctx.tr('forms.freq_' + rule.freq);
  const every = Number.isSafeInteger(rule.interval) && rule.interval > 1 ? ctx.tr('forms.rule_step', { n: rule.interval }) : '';
  return ctx.tr('forms.rule_line', { name: rule.name, amount: f.money(rule.amount?.exp_minor ?? 0), freq: freq + every });
}

/** Подпись календаря в списке выбора: имя, иначе идентификатор. */
function calendar_label(cal) {
  return typeof cal.name === 'string' && cal.name !== '' ? cal.name : String(cal.calendar_id);
}

/**
 * Встроенная форма над одним вхождением («Перенести» или «Другая сумма»): поле, предпросмотр (`expand_all`), «Применить» и «Закрыть».
 * @returns {HTMLElement}
 */
function occurrence_editor(ctx, ws, env, f, rule, x, key, kind, anchor_id, close) {
  const tr = ctx.tr;
  const form_key = (kind === 'move' ? 'mv-' : 'am-') + key;
  const acc = list_of(ws, 'accounts').find((a) => a.account_id === rule.account_id);
  const nf = resolve_number_format(env.lang, env.nf);
  const field = kind === 'move'
    ? text_field(ctx, form_key, 'move_date', { type: 'date', value: x.date, hint: tr('forms.h_ov_move') })
    : text_field(ctx, form_key, 'amount', {
      label: tr('forms.f_ov_amount'), inputmode: 'decimal', hint: tr('forms.h_ov_amount'),
      value: format_input_amount(Math.abs(x.amount_minor), acc === undefined ? currency_exponent(rule.currency) : (acc.exponent ?? currency_exponent(acc.currency)), nf, true),
    });
  const preview = h('div', { id: 'fp13-ov-' + form_key + '-preview', class: 'fp08-preview', 'aria-live': 'polite' });
  const money = (minor, cur) => fmt_of(env, cur ?? rule.currency).money(minor);
  // у вхождения может быть только одна правка (перенос или своя сумма): новая другого вида заменяет прежнюю — об этом говорится до нажатия «Применить»
  const existing = override_of(ws, rule.rule_id, x.nominal);
  let replaces = null;
  if (kind === 'move' && existing?.action === 'set_amount') replaces = tr('forms.ov_replaces_amount', { amount: money(existing.amount_minor) });
  else if (kind === 'amount' && existing?.action === 'move') replaces = tr('forms.ov_replaces_move', { date: f.date(existing.date) });
  const build = () => (kind === 'move' ? build_move_edit(ws, rule.rule_id, x.nominal, field.input.value, env) : build_amount_edit(ws, rule.rule_id, x.nominal, field.input.value, env));

  const draw = () => {
    const built = build();
    if (!built.ok) { preview.replaceChildren(h('p', { class: 'muted', text: tr('forms.ov_wait') })); return; }
    let p;
    try { p = override_preview(ws, rule.rule_id, x.nominal, built.edit, { as_of: ws.as_of }); } catch { p = { ok: false, error: { code: 'E_SCHEMA', ctx: { field: 'override', reason: 'preview_failed' } } }; }
    if (!p.ok) { preview.replaceChildren(h('p', { class: 'error', text: error_text(ctx, p.error) })); return; }
    const b = p.before;
    const a = p.after;
    let headline;
    if (b === null || a === null) headline = tr('forms.ov_wait');
    else if (kind === 'move') headline = a.date === b.date ? tr('forms.ov_nochange') : tr('forms.ov_move_preview', { name: rule.name, from: f.date(b.date), to: f.date(a.date) });
    else headline = a.amount_minor === b.amount_minor ? tr('forms.ov_nochange') : tr('forms.ov_amount_preview', { date: f.date(a.date), from: money(b.amount_minor, b.currency), to: money(a.amount_minor, a.currency) });
    preview.replaceChildren(h('p', { text: headline }), h('p', { class: 'muted', text: tr('forms.ov_series') }),
      h('p', { class: 'muted', text: tr('forms.ov_next_title') }),
      h('ul', { class: 'plain' }, p.rows.map((r) => h('li', { text: tr('forms.rule_preview_row', { date: f.date(r.date), amount: money(r.amount_minor, r.currency) }) }))));
  };
  field.input.addEventListener('input', draw);
  field.input.addEventListener('change', draw);

  const apply = () => {
    const built = build();
    if (!built.ok) { show_field_error(ctx, field, built.error); return built; }
    show_field_error(ctx, field, null);
    FOCUS.request(anchor_id);
    const r = commit_edits(ctx, [built.edit], 'set_occurrence_override');
    if (r.ok) {
      ctx.notify(kind === 'move'
        ? tr('forms.ov_moved', { name: rule.name, from: f.date(x.date), to: f.date(built.edit.override.date) })
        : tr('forms.ov_amount_done', { name: rule.name, date: f.date(x.date), amount: money(built.edit.override.amount_minor), old: money(x.amount_minor) }), 'info');
    } else { FOCUS.clear(); show_field_error(ctx, field, r.error); }
    return r;
  };
  const node = h('form', {
    class: 'fp13-inline', id: 'fp13-ov-' + form_key, novalidate: true,
    'aria-label': tr(kind === 'move' ? 'forms.ov_form_move' : 'forms.ov_form_amount', { name: rule.name, date: f.date(x.date) }),
    onsubmit: (ev) => { if (ev !== undefined && ev !== null && typeof ev.preventDefault === 'function') ev.preventDefault(); return apply(); },
  }, replaces === null ? null : h('p', { class: 'muted', id: 'fp13-ov-' + form_key + '-replaces', text: replaces }), field.wrap, preview, h('div', { class: 'row' },
    h('button', { type: 'submit', class: 'btn small primary', 'data-act': 'ov-apply', text: tr('forms.ov_apply') }),
    h('button', { type: 'button', class: 'btn small', 'data-act': 'ov-close', onclick: () => close(true), text: tr('forms.ov_close') })));
  draw();
  node.fp13_focus = () => { if (typeof field.input.focus === 'function') field.input.focus(); };
  return node;
}

/** Строка ближайшего вхождения: текст, кнопки «Пропустить», «Перенести», «Другая сумма» (и «Вернуть как по правилу», если оно изменено) и место для встроенной формы. */
function occurrence_row(ctx, ws, env, f, rule, x, ri, oi, anchor_id) {
  const tr = ctx.tr;
  const key = ri + '-' + oi;
  const ov = override_of(ws, rule.rule_id, x.nominal);
  const money = fmt_of(env, x.currency).money(x.amount_minor);
  let mark = '';
  if (ov?.action === 'move') mark = moved_from_text(tr, f, date_by_rule(ws, rule, x.nominal) ?? x.nominal, x.nominal); // показанная до переноса дата, а не дата правила (FP-48)
  else if (ov?.action === 'set_amount') mark = tr('forms.ov_mark_amount');
  const slot = h('div', { class: 'fp13-slot', id: 'fp13-slot-' + key });
  let open_kind = null;
  const buttons = new Map();
  const close = (refocus) => {
    const was = open_kind;
    open_kind = null;
    slot.replaceChildren();
    for (const b of buttons.values()) b.setAttribute('aria-expanded', 'false');
    if (refocus === true && was !== null && typeof buttons.get(was)?.focus === 'function') buttons.get(was).focus();
  };
  const toggle = (kind) => {
    if (open_kind === kind) { close(true); return; }
    const editor = occurrence_editor(ctx, ws, env, f, rule, x, key, kind, anchor_id, close);
    open_kind = kind;
    slot.replaceChildren(editor);
    for (const [k, b] of buttons) b.setAttribute('aria-expanded', k === kind ? 'true' : 'false');
    if (typeof editor.fp13_focus === 'function') editor.fp13_focus();
  };
  const mk = (kind, act, label_key, text_key) => {
    const b = h('button', {
      type: 'button', class: 'btn small', 'data-act': act, 'data-nominal': x.nominal, 'aria-expanded': 'false', 'aria-controls': 'fp13-slot-' + key,
      'aria-label': tr(label_key, { name: rule.name, date: f.date(x.date) }), onclick: () => toggle(kind), text: tr(text_key),
    });
    buttons.set(kind, b);
    return b;
  };
  const skip = h('button', {
    type: 'button', class: 'btn small', 'data-act': 'skip', 'data-nominal': x.nominal,
    'aria-label': tr('forms.rule_skip_label', { name: rule.name, date: f.date(x.date) }),
    onclick: () => {
      FOCUS.request(anchor_id);
      const r = commit_edits(ctx, [skip_edit(rule.rule_id, x.nominal)], 'set_occurrence_override');
      if (r.ok) ctx.notify(tr('forms.rule_skipped', { name: rule.name, date: f.date(x.date) }), 'info');
      else { FOCUS.clear(); ctx.notify(error_text(ctx, r.error), 'error'); }
    },
    text: tr('forms.rule_skip') });
  const restore = ov === undefined || ov.action === 'skip' ? null : h('button', {
    type: 'button', class: 'btn small', 'data-act': 'ov-restore', 'data-nominal': x.nominal,
    'aria-label': tr('forms.ov_restore_label', { name: rule.name, date: f.date(x.date) }),
    onclick: () => {
      FOCUS.request(anchor_id);
      const r = commit_edits(ctx, [restore_edit(rule.rule_id, x.nominal)], 'set_occurrence_override');
      if (r.ok) ctx.notify(tr('forms.ov_restored', { name: rule.name, date: f.date(x.date) }), 'info');
      else { FOCUS.clear(); ctx.notify(error_text(ctx, r.error), 'error'); }
    },
    text: tr('forms.ov_restore') });
  return h('li', { class: 'fp08-occ', 'data-nominal': x.nominal },
    h('span', { text: tr('forms.rule_next', { date: f.date(x.date), amount: money }) + (mark === '' ? '' : ' · ' + mark) }), ' ',
    skip, ' ', mk('move', 'move', 'forms.rule_move_label', 'forms.rule_move'), ' ', mk('amount', 'amount', 'forms.rule_amount_label', 'forms.rule_amount'),
    restore === null ? null : ' ', restore, slot);
}

/**
 * Раздел «Платежи»: список правил с ближайшими датами и кнопками «Пропустить» / «Перенести» / «Другая сумма» / «Вернуть», ниже — форма правила с предпросмотром,
 * затем блоки пакетов (`register_rule_block`).
 * @param {object} ctx контекст расширений
 * @returns {HTMLElement}
 */
export function render_rules(ctx) {
  const ws = ctx.get_ws();
  const root = h('section', { class: 'fp08-section', id: 'fp08-sec-rules', 'aria-labelledby': 'fp08-sec-rules-title' }, h('h3', { id: 'fp08-sec-rules-title', tabindex: '-1', text: ctx.tr('forms.rules_title') }));
  if (ws === null || ws === undefined) { root.append(h('p', { class: 'muted', text: ctx.tr('forms.no_data') })); return root; }
  const env = env_of(ctx, ws);
  const f = fmt_of(env);
  const accounts = open_accounts(ws);
  const as_of = ws.as_of;
  const calendars = list_of(ws, 'calendars').filter((c) => is_obj(c) && typeof c.calendar_id === 'string');

  // форма
  let editing = null;
  const new_id = ctx.new_id('rule');
  const kind_sel = select_field(ctx, 'rule', 'kind', RULE_KINDS.map((k) => ({ value: k, text: ctx.tr('forms.kind_' + k) })), 'expense');
  const name = text_field(ctx, 'rule', 'name', { hint: ctx.tr('forms.h_rule_name') });
  const amount = text_field(ctx, 'rule', 'amount', { inputmode: 'decimal', hint: ctx.tr('forms.h_rule_amount') });
  const account = select_field(ctx, 'rule', 'account_id', accounts.map((a) => ({ value: a.account_id, text: account_label(ws, a.account_id) + ' · ' + a.currency })), accounts[0]?.account_id);
  const freq = select_field(ctx, 'rule', 'freq', RULE_FREQS.map((x) => ({ value: x, text: ctx.tr('forms.freq_' + x) })), 'M');
  const interval = text_field(ctx, 'rule', 'interval', { inputmode: 'numeric', value: '1', hint: ctx.tr('forms.h_rule_interval') });
  const start = text_field(ctx, 'rule', 'start_date', { type: 'date', value: as_of, hint: ctx.tr('forms.h_rule_start') });
  const monthday = text_field(ctx, 'rule', 'monthday', { inputmode: 'numeric', hint: ctx.tr('forms.h_rule_monthday') });
  const workday = text_field(ctx, 'rule', 'workday', { inputmode: 'numeric', hint: ctx.tr('forms.h_rule_workday') });
  const weekday = select_field(ctx, 'rule', 'weekday', weekday_options(ctx), '');
  const weekend = select_field(ctx, 'rule', 'weekend', WEEKEND_POLICIES.map((p) => ({ value: p, text: ctx.tr('forms.weekend_' + p) })), 'keep', { hint: ctx.tr('forms.h_rule_weekend') });
  const calendar = select_field(ctx, 'rule', 'calendar_id',
    [{ value: '', text: ctx.tr('forms.cal_default') }, ...calendars.map((c) => ({ value: c.calendar_id, text: calendar_label(c) }))], calendars[0]?.calendar_id ?? '',
    { hint: ctx.tr('forms.h_rule_calendar') });
  const until = text_field(ctx, 'rule', 'until_date', { type: 'date', hint: ctx.tr('forms.h_rule_until') });
  const obligation = check_field(ctx, 'rule', 'is_obligation', false);
  const estimate = check_field(ctx, 'rule', 'is_estimate', false);
  const preview = h('div', { id: 'fp08-rule-preview', class: 'fp08-preview', 'aria-live': 'polite' });
  const cal_note = h('div', { id: 'fp08-rule-cal-note', class: 'fp08-calnote', 'aria-live': 'polite' });

  const texts = () => ({
    rule_id: editing ?? new_id, name: name.input.value, kind: kind_sel.input.value, amount: amount.input.value, account_id: account.input.value,
    freq: freq.input.value, interval: interval.input.value, start_date: start.input.value, monthday: monthday.input.value, workday: workday.input.value,
    weekday: weekday.input.value, weekend: weekend.input.value, calendar_id: calendar.input.value, until_date: until.input.value,
    is_obligation: is_checked(obligation.input), is_estimate: is_checked(estimate.input),
  });
  const draw_note = () => {
    const kind = calendar_notice(ws, texts());
    if (kind === 'none') { cal_note.replaceChildren(); return; }
    cal_note.replaceChildren(...kids(h('p', { class: 'muted', text: ctx.tr(kind === 'no_calendars' ? 'forms.cal_note_none' : 'forms.cal_note_default') }),
      kind === 'no_calendars' ? h('button', {
        type: 'button', class: 'btn small', 'data-act': 'goto-calendar', text: ctx.tr('forms.cal_make'),
        onclick: () => { const t = el_by_id('fp08-cal-name'); if (t !== null && t !== undefined && typeof t.focus === 'function') t.focus(); },
      }) : null));
  };
  const draw_preview = () => {
    draw_note();
    const built = build_rule_edit(ws, texts(), env);
    if (!built.ok) { preview.replaceChildren(h('p', { class: 'muted', text: ctx.tr('forms.rule_preview_wait') })); return built; }
    const p = rule_preview(ws, built.edit, { as_of, new_id: ctx.new_id });
    if (!p.ok) { preview.replaceChildren(h('p', { class: 'error', text: error_text(ctx, p.error) })); return p; }
    preview.replaceChildren(h('p', { class: 'muted', text: ctx.tr('forms.rule_preview_title') }),
      p.rows.length === 0 ? h('p', { text: ctx.tr('forms.rule_preview_none') })
        : h('ul', { class: 'plain' }, p.rows.map((x) => h('li', { text: ctx.tr('forms.rule_preview_row', { date: f.date(x.date), amount: fmt_of(env, x.currency).money(x.amount_minor) }) }))));
    return p;
  };
  const fields = [kind_sel, name, amount, account, freq, interval, start, monthday, workday, weekday, weekend, calendar, until, obligation, estimate];
  for (const x of fields) { x.input.addEventListener('input', draw_preview); x.input.addEventListener('change', draw_preview); }

  const submit = () => {
    const built = build_rule_edit(ws, texts(), env);
    if (!built.ok) { show_field_error(ctx, fields.find((x) => x.id.endsWith('-' + (built.error.ctx.field ?? ''))) ?? name, built.error); return built; }
    FOCUS.request('fp08-sec-rules-title');
    const r = commit_edits(ctx, [built.edit], 'upsert_rule');
    if (r.ok) ctx.notify(ctx.tr(editing === null ? 'forms.rule_saved' : 'forms.rule_updated', { name: built.edit.rule.name }), 'info');
    else FOCUS.clear();
    return r;
  };
  const card = form_card(ctx, 'rule', ctx.tr('forms.rule_form_title'), ctx.tr('forms.rule_form_lead'), fields, ctx.tr('forms.save'), submit, [preview, cal_note]);

  let extra_weekday = null; // пункт «как записано» для нескольких дней недели: убирается при следующем заполнении формы
  const fill = (rule) => {
    editing = rule.rule_id;
    kind_sel.input.value = rule.kind;
    name.input.value = rule.name ?? '';
    const acc = list_of(ws, 'accounts').find((a) => a.account_id === rule.account_id);
    const nf = resolve_number_format(env.lang, env.nf);
    amount.input.value = format_input_amount(Math.abs(rule.amount?.exp_minor ?? 0), acc === undefined ? currency_exponent(rule.currency) : (acc.exponent ?? currency_exponent(acc.currency)), nf, true);
    account.input.value = rule.account_id;
    freq.input.value = rule.freq;
    interval.input.value = String(rule.interval ?? 1);
    start.input.value = rule.start_date;
    monthday.input.value = Array.isArray(rule.by_monthday) ? rule.by_monthday.join(', ') : '';
    workday.input.value = Array.isArray(rule.by_workday) ? rule.by_workday.join(', ') : '';
    if (extra_weekday !== null) { if (typeof extra_weekday.remove === 'function') extra_weekday.remove(); extra_weekday = null; }
    if (Array.isArray(rule.by_weekday) && rule.by_weekday.length > 1) {
      // несколько дней недели в списке из одного выбора не представить: добавляется пункт «как записано», чтобы сохранение не стёрло лишние дни
      const names = WEEKDAYS_SHORT[ctx.lang()] ?? WEEKDAYS_SHORT.ru;
      const value = rule.by_weekday.join(',');
      extra_weekday = h('option', { value, text: rule.by_weekday.map((d) => names[(d + 6) % 7]).join(', ') });
      weekday.input.append(extra_weekday);
      weekday.input.value = value;
    } else weekday.input.value = Array.isArray(rule.by_weekday) && rule.by_weekday.length === 1 ? String(rule.by_weekday[0]) : '';
    weekend.input.value = rule.weekend ?? 'keep';
    calendar.input.value = typeof rule.calendar_id === 'string' && calendars.some((c) => c.calendar_id === rule.calendar_id) ? rule.calendar_id : '';
    until.input.value = rule.until_date ?? '';
    if (typeof obligation.input.setAttribute === 'function') {
      if (rule.is_obligation === true) obligation.input.setAttribute('checked', ''); else obligation.input.removeAttribute('checked');
      if (rule.is_estimate === true) estimate.input.setAttribute('checked', ''); else estimate.input.removeAttribute('checked');
    }
    obligation.input.checked = rule.is_obligation === true;
    estimate.input.checked = rule.is_estimate === true;
    draw_preview();
    if (typeof name.input.focus === 'function') name.input.focus();
  };

  // список правил
  const rules = list_of(ws, 'rules');
  const items = rules.map((rule, ri) => {
    const occ = occurrences_of(ws, rule, as_of, 3);
    const skipped = skipped_of(ws, rule.rule_id, as_of);
    const shown = new Set(occ.map((x) => x.nominal));
    const hidden = changed_of(ws, rule.rule_id, as_of).filter((o) => !shown.has(o.nominal_date));
    const orphans = orphaned_of(ws, rule.rule_id, as_of);
    const anchor_id = 'fp08-rule-edit-' + ri;
    return h('li', { class: 'fp08-rule', 'data-rule': rule.rule_id },
      h('p', null, h('strong', { text: rule_line(ctx, ws, rule) }), ' ',
        h('button', { type: 'button', class: 'btn small', id: anchor_id, 'data-act': 'edit', 'aria-label': ctx.tr('forms.rule_edit_label', { name: rule.name }), onclick: () => fill(rule), text: ctx.tr('forms.rule_edit') })),
      h('ul', { class: 'plain' },
        occ.map((x, oi) => occurrence_row(ctx, ws, env, f, rule, x, ri, oi, anchor_id)),
        hidden.map((o) => h('li', { class: 'muted', 'data-nominal': o.nominal_date }, h('span', {
          text: o.action === 'move' ? moved_row_text(ctx.tr, f, date_by_rule(ws, rule, o.nominal_date) ?? o.nominal_date, o)
            : ctx.tr('forms.ov_row_amount', { date: f.date(o.nominal_date), amount: fmt_of(env, rule.currency).money(o.amount_minor) }) }), ' ',
        h('button', {
          type: 'button', class: 'btn small', 'data-act': 'ov-restore', 'data-nominal': o.nominal_date,
          'aria-label': ctx.tr('forms.ov_restore_label', { name: rule.name, date: f.date(o.nominal_date) }),
          onclick: () => {
            FOCUS.request(anchor_id);
            const r = commit_edits(ctx, [restore_edit(rule.rule_id, o.nominal_date)], 'set_occurrence_override');
            if (r.ok) ctx.notify(ctx.tr('forms.ov_restored', { name: rule.name, date: f.date(o.nominal_date) }), 'info');
            else { FOCUS.clear(); ctx.notify(error_text(ctx, r.error), 'error'); }
          },
          text: ctx.tr('forms.ov_restore') }))),
        skipped.map((d) => h('li', { class: 'muted' }, h('span', { text: ctx.tr('forms.rule_skipped_row', { date: f.date(d) }) }), ' ',
          h('button', {
            type: 'button', class: 'btn small', 'data-act': 'restore', 'data-nominal': d,
            onclick: () => {
              FOCUS.request(anchor_id);
              const r = commit_edits(ctx, [restore_edit(rule.rule_id, d)], 'set_occurrence_override');
              if (r.ok) ctx.notify(ctx.tr('forms.rule_restored', { name: rule.name, date: f.date(d) }), 'info');
              else { FOCUS.clear(); ctx.notify(error_text(ctx, r.error), 'error'); }
            },
            text: ctx.tr('forms.rule_restore') }))),
        // правка привязана к дате, которая после смены календаря или условий правила больше не вхождение: не применяется, но лежит в данных — её можно убрать
        orphans.map((o) => h('li', { class: 'muted', 'data-nominal': o.nominal_date, 'data-orphan': 'true' },
          h('span', { text: ctx.tr('forms.ov_orphan_row', { date: f.date(o.nominal_date) }) }), ' ',
          h('button', {
            type: 'button', class: 'btn small', 'data-act': 'ov-orphan-remove', 'data-nominal': o.nominal_date,
            'aria-label': ctx.tr('forms.ov_orphan_remove_label', { name: rule.name, date: f.date(o.nominal_date) }),
            onclick: () => {
              FOCUS.request(anchor_id);
              const r = commit_edits(ctx, [restore_edit(rule.rule_id, o.nominal_date)], 'set_occurrence_override');
              if (r.ok) ctx.notify(ctx.tr('forms.ov_orphan_removed', { name: rule.name, date: f.date(o.nominal_date) }), 'info');
              else { FOCUS.clear(); ctx.notify(error_text(ctx, r.error), 'error'); }
            },
            text: ctx.tr('forms.ov_orphan_remove') })))));
  });
  root.append(
    h('p', { class: 'lead', text: ctx.tr('forms.rules_lead') }),
    rules.length === 0 ? h('p', { class: 'muted', text: ctx.tr('forms.rules_none') }) : h('ul', { class: 'plain fp08-rules-list' }, items),
    card.form,
    ...block_nodes(ctx));
  draw_preview();
  FOCUS.apply();
  return root;
}
