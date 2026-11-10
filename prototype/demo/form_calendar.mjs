// form_calendar.mjs — календарь выходных и праздников как данные пользователя (FP-13, REQ-009, ALG-01, IDEA-06).
//
// Что делает: даёт два вида правок — `upsert_calendar` (выходные дни недели `weekend_dows` и праздники `holidays`, проверка движком `make_calendar`)
// и `delete_calendar` (только если календарь не нужен ни одному правилу и потоку часов) — и форму «Календарь выходных и праздников» в «Формах данных».
// Календарь НЕ зашит по странам: готовых списков праздников со ставками и странами нет, даты вводит пользователь; допустим пустой календарь.
// Запись — только общим путём `ctx.set_ws` (проверка `apply_edit` → копия → пересчёт страницей → журнал `calendar.set` → «Отменить»).
// Календарь меняет вычисляемые даты будущих вхождений, но не проведённые факты: `facts` и их записи журнала остаются прежними.
// Файл: чистая часть (правки, разбор формы, модели, без DOM) и узлы. Расчёт по введённым данным и правилам, не консультация.

import { fail, make_calendar, parse_date, format_date, to_epoch_day, is_business } from '../engine/index.mjs';
import { h } from './dom.mjs';
import { ID_KINDS, apply_edit } from './ws_edit.mjs';
import { is_valid_id, clock_ports } from './ids.mjs';
import { AUTO_PREFIX } from './ws_bridge.mjs';
import { WEEKDAYS_SHORT } from './i18n.mjs';
import { create_focus_keeper } from './focus_keep.mjs';
import {
  bad, first_error, list_of, env_of, fmt_of, parse_date_flexible, commit_edits, error_text, text_field, check_field, is_checked, form_card, plural_cat, kids,
} from './forms.mjs';
import { orphan_count } from './form_rule.mjs';

const clip = (x) => String(x).slice(0, 40);
const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Сколько праздников и других нерабочих дат хранит один календарь (защита от случайной вставки огромного текста). */
export const HOLIDAYS_MAX = 1000;
/** Допустимый диапазон дат календаря: вне него `make_calendar` перебирал бы слишком много дней. */
export const DATE_MIN = '1970-01-01';
export const DATE_MAX = '2200-12-31';
/** Сколько ближайших нерабочих дней показывает предпросмотр и на сколько дней вперёд он смотрит. */
export const PREVIEW_DAYS = 90;
export const PREVIEW_ROWS = 8;
/** Дни недели в порядке показа: с понедельника (0 = воскресенье … 6 = суббота, как в движке). */
export const WEEKDAY_ORDER = Object.freeze([1, 2, 3, 4, 5, 6, 0]);

// ── общие проверки правок (небольшие помощники, как в ws_edit: тот модуль их не экспортирует) ───────────────────────────────────────

/** Отказ `E_SCHEMA` с кодовым полем и причиной; значения пользователя в контекст не попадают. */
export const schema = (field, reason, extra) => fail('E_SCHEMA', { field, reason, ...extra });

/** Только перечисленные поля. */
export function allow_keys(obj, allowed, field) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) schema(field, 'unknown_field', { key: clip(k) });
}

/** Объект (не массив, не null). */
export function need_obj(x, field) {
  if (!is_obj(x)) schema(field, 'not_object');
  return x;
}

/** Идентификатор сущности: допустимая строка, не служебная (`auto:`). */
export function id_of(x, field) {
  if (!is_valid_id(x) || x.startsWith(AUTO_PREFIX)) schema(field, 'bad_id');
  return x;
}

/** Текст до `max` знаков без управляющих (кроме перевода строки и табуляции); пустой отвергается, если не `allow_empty`. */
export function text_of(x, field, max = 120, o = {}) {
  if (typeof x !== 'string') schema(field, 'not_string');
  if (x.length > max) schema(field, 'too_long', { max });
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(x)) schema(field, 'control_chars');
  const v = x.normalize('NFC');
  if (o.allow_empty !== true && v.trim() === '') schema(field, 'empty');
  return v;
}

/** Дата `ГГГГ-ММ-ДД` в каноническом виде. */
export function date_of(x, field) {
  if (typeof x !== 'string') fail('E_BAD_DATE', { field, reason: 'not_iso_string' });
  let ok = false;
  try { ok = format_date(parse_date(x)) === x; } catch { ok = false; }
  if (!ok) fail('E_BAD_DATE', { field, reason: 'bad_date' });
  return x;
}

/** Идентификатор `id` вида `kind` не занят сущностью другого вида (единое пространство `Id`, C-025). */
export function claim_id(ws, kind, id, field) {
  for (const [k, [bucket, f]] of Object.entries(ID_KINDS)) {
    if (k === kind) continue;
    const arr = bucket === 'tax_rules' ? list_of(ws, bucket).flat() : list_of(ws, bucket);
    if (arr.some((x) => x?.[f] === id)) schema(field, 'id_taken_by_other_kind', { kind: k });
  }
}

/** Заменить элемент с тем же идентификатором на месте или добавить в конец. */
export function upsert_by(arr, field, item) {
  const i = arr.findIndex((x) => x?.[field] === item[field]);
  if (i < 0) return [...arr, item];
  const out = arr.slice();
  out[i] = item;
  return out;
}

// ── вид правки `upsert_calendar` ─────────────────────────────────────────────────────────────────────────────────────────────────

const CALENDAR_KEYS = ['calendar_id', 'name', 'weekend_dows', 'holidays'];

/**
 * Вид правки для `ws_edit.register_edit`: `{type: 'upsert_calendar', calendar: {calendar_id?, name, weekend_dows: number[], holidays: string[]}}`.
 * Выходные — целые 0…6 (0 — воскресенье) без повторов; все семь дней сразу — `E_RULE_INVALID` (нет рабочих дней). Праздники — настоящие даты
 * `ГГГГ-ММ-ДД` в пределах `DATE_MIN…DATE_MAX`, не более `HOLIDAYS_MAX`; повторы убираются, список хранится по возрастанию (одинаковый ввод — одинаковые данные).
 * Календарь собирается движком (`make_calendar`) — если он отверг, отказ тот же. Запись с тем же `calendar_id` заменяется; поля вне формы (из файла) сохраняются.
 * @param {object} ws
 * @param {object} edit
 * @param {{new_id?: (prefix: string) => string}} [env]
 * @returns {object} новая рабочая область
 * @throws {RunwayError} E_SCHEMA, E_BAD_DATE, E_RULE_INVALID
 */
export function edit_upsert_calendar(ws, edit, env = {}) {
  allow_keys(edit, ['type', 'calendar'], 'edit');
  const c = need_obj(edit.calendar, 'cal');
  allow_keys(c, CALENDAR_KEYS, 'cal');
  const id = id_of(c.calendar_id ?? env.new_id?.('cal'), 'cal.calendar_id');
  claim_id(ws, 'calendar', id, 'cal.calendar_id');
  const name = text_of(c.name, 'cal.name', 120);
  if (!Array.isArray(c.weekend_dows)) schema('cal.weekend_dows', 'not_array');
  const dows = [...new Set(c.weekend_dows)];
  for (const d of dows) if (!Number.isSafeInteger(d) || d < 0 || d > 6) schema('cal.weekend_dows', 'not_0_6');
  dows.sort((a, b) => a - b);
  const hol_in = c.holidays === undefined ? [] : c.holidays;
  if (!Array.isArray(hol_in)) schema('cal.holidays', 'not_array');
  if (hol_in.length > HOLIDAYS_MAX) schema('cal.holidays', 'cal_too_many_holidays', { max: HOLIDAYS_MAX });
  const holidays = [...new Set(hol_in.map((x) => date_of(x, 'cal.holidays')))].sort();
  for (const d of holidays) if (d < DATE_MIN || d > DATE_MAX) fail('E_BAD_DATE', { field: 'cal.holidays', reason: 'cal_holiday_out_of_range' });
  let built;
  try { built = make_calendar({ weekend_dows: dows, holidays }); } catch (e) {
    if (e?.code === 'E_RULE_INVALID') fail('E_RULE_INVALID', { field: 'cal.weekend_dows', reason: 'cal_no_business_days' });
    throw e;
  }
  const calendars = list_of(ws, 'calendars');
  const old = calendars.find((x) => x?.calendar_id === id);
  const item = { ...(old ?? {}), calendar_id: id, name, weekend_dows: [...built.weekend_dows], holidays: [...built.holidays] };
  return { ...ws, calendars: upsert_by(calendars, 'calendar_id', item) };
}

/** Сколько правил и потоков часов ссылаются на календарь. */
export function calendar_usage(ws, calendar_id) {
  const used = (bucket) => list_of(ws, bucket).filter((x) => is_obj(x) && x.calendar_id === calendar_id).length;
  return { rules: used('rules'), streams: used('streams') };
}

/**
 * Как календарь используют резервы. Календарь взносов резерва — `calendar_id` резерва или его `cadence.calendar_id` (так читает движок); без своего календаря
 * взносы копилки (`sinking`) считаются по ПЕРВОМУ календарю рабочей области, а при его отсутствии — по умолчанию «суббота и воскресенье».
 * `explicit` — резервы, которые называют этот календарь (его нельзя удалить: расчёт отказал бы с `unknown_calendar`);
 * `implicit` — копилки без своего календаря, если этот календарь первый в списке (его правка или удаление сдвигает их взносы).
 * @returns {{explicit: number, implicit: number}}
 */
export function reserve_calendar_use(ws, calendar_id) {
  const own = (r) => r.calendar_id ?? (is_obj(r.cadence) ? r.cadence.calendar_id : undefined) ?? null;
  const reserves = list_of(ws, 'reserves').filter(is_obj);
  const first = list_of(ws, 'calendars')[0];
  return {
    explicit: reserves.filter((r) => own(r) === calendar_id).length,
    implicit: is_obj(first) && first.calendar_id === calendar_id ? reserves.filter((r) => r.kind === 'sinking' && own(r) === null).length : 0,
  };
}

/**
 * Вид правки `delete_calendar`: `{type, calendar_id}`. Календарь, на который ссылается правило, поток часов или резерв, не удаляется (`E_SCHEMA`, причины
 * `cal_in_use` и `cal_in_use_reserve`): иначе правило осталось бы без календаря молча, а расчёт резерва отказал бы. Сначала выберите таким правилам другой календарь.
 */
export function edit_delete_calendar(ws, edit) {
  allow_keys(edit, ['type', 'calendar_id'], 'edit');
  const id = id_of(edit.calendar_id, 'calendar_id');
  const calendars = list_of(ws, 'calendars');
  if (!calendars.some((x) => x?.calendar_id === id)) schema('calendar_id', 'unknown_calendar');
  const u = calendar_usage(ws, id);
  if (u.rules + u.streams > 0) schema('calendar_id', 'cal_in_use');
  if (reserve_calendar_use(ws, id).explicit > 0) schema('calendar_id', 'cal_in_use_reserve');
  return { ...ws, calendars: calendars.filter((x) => x?.calendar_id !== id) };
}

/** Новые виды правок пакета (`ws_edit.register_edit`). */
export const CALENDAR_EDITS = Object.freeze({ upsert_calendar: edit_upsert_calendar, delete_calendar: edit_delete_calendar });

// ── разбор формы ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Праздники из текста: даты через пробел, запятую, точку с запятой или с новой строки; каждая — ISO или в формате рабочей области.
 * Пусто — пустой список (календарь без праздников допустим). Отказ называет поле, а не введённое значение.
 * @returns {{ok: true, value: string[]}|{ok: false, error: {code: string, ctx: object}}}
 */
export function parse_holidays_text(text, env, field = 'holidays') {
  const tokens = String(text ?? '').split(/[\s,;]+/).filter((x) => x !== '');
  if (tokens.length > HOLIDAYS_MAX) return bad('E_SCHEMA', field, 'cal_too_many_holidays');
  const out = [];
  for (const tk of tokens) {
    const r = parse_date_flexible(tk, env, field);
    if (!r.ok) return r;
    if (r.value < DATE_MIN || r.value > DATE_MAX) return bad('E_BAD_DATE', field, 'cal_holiday_out_of_range');
    out.push(r.value);
  }
  return { ok: true, value: [...new Set(out)].sort() };
}

/**
 * Собрать правку `upsert_calendar` из текстов формы.
 * @param {object} ws
 * @param {{calendar_id: string, name: string, weekend_dows: (string|number)[], holidays: string}} t
 * @param {{cur: string, lang: 'ru'|'en', nf?: any, as_of: string}} env
 * @returns {{ok: true, edit: {type: 'upsert_calendar', calendar: object}}|{ok: false, error: {code: string, ctx: object}}}
 */
export function build_calendar_edit(ws, t, env) {
  if (!is_obj(t)) return bad('E_SCHEMA', 'form', 'not_object');
  const name = typeof t.name === 'string' ? t.name.trim() : '';
  if (name === '') return bad('E_SCHEMA', 'name', 'empty');
  if (!Array.isArray(t.weekend_dows)) return bad('E_SCHEMA', 'weekend_dows', 'not_array');
  const dows = [];
  for (const x of t.weekend_dows) {
    const n = typeof x === 'number' ? x : Number(String(x).trim());
    if (!Number.isInteger(n) || n < 0 || n > 6) return bad('E_SCHEMA', 'weekend_dows', 'not_0_6');
    if (!dows.includes(n)) dows.push(n);
  }
  if (dows.length === 7) return bad('E_RULE_INVALID', 'weekend_dows', 'cal_no_business_days');
  const holidays = parse_holidays_text(t.holidays, env, 'holidays');
  const err = first_error([holidays]);
  if (err !== null) return err;
  return { ok: true, edit: { type: 'upsert_calendar', calendar: { calendar_id: t.calendar_id, name, weekend_dows: dows.sort((a, b) => a - b), holidays: holidays.value } } };
}

// ── модели показа ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Ближайшие нерабочие дни календаря от `as_of`: дата и причина (`holiday` сильнее `weekend`). Календарь строит движок.
 * @param {{weekend_dows?: number[], holidays?: string[]}} spec
 * @param {string} as_of
 * @returns {{date: string, why: 'holiday'|'weekend'}[]}
 */
export function upcoming_days_off(spec, as_of, days = PREVIEW_DAYS, rows = PREVIEW_ROWS) {
  const cal = make_calendar({ weekend_dows: spec.weekend_dows, holidays: spec.holidays });
  const hol = new Set(cal.holidays);
  const from = to_epoch_day(as_of);
  const out = [];
  for (let d = from; d <= from + days && out.length < rows; d++) {
    if (is_business(d, cal)) continue;
    const iso = format_date(d);
    out.push({ date: iso, why: hol.has(iso) ? 'holiday' : 'weekend' });
  }
  return out;
}

/**
 * Введённые праздники по возрастанию: те, что не раньше `as_of` (первые `rows`), сколько их ещё дальше и сколько осталось в прошлом. Нужно, чтобы дальний праздник
 * (скажем, через полгода) был виден в предпросмотре, а не терялся за выходными ближайших недель.
 * @param {string[]|undefined} holidays
 * @param {string} as_of
 * @returns {{rows: string[], more: number, past: number}}
 */
export function holidays_ahead(holidays, as_of, rows = PREVIEW_ROWS) {
  const list = [...new Set(Array.isArray(holidays) ? holidays.filter((x) => typeof x === 'string') : [])].sort();
  const ahead = list.filter((d) => d >= as_of);
  return { rows: ahead.slice(0, rows), more: Math.max(0, ahead.length - rows), past: list.length - ahead.length };
}

/**
 * Предпросмотр календаря: правка проходит `apply_edit` на копии (отказ — код, а не даты), затем показываются ближайшие нерабочие дни
 * и отдельно — введённые праздники по возрастанию (`holidays`).
 * @returns {{ok: true, rows: {date: string, why: string}[], holidays: {rows: string[], more: number, past: number}}|{ok: false, error: object}}
 */
export function calendar_preview(ws, built_edit, o = {}) {
  const r = apply_edit(ws, built_edit, { new_id: o.new_id, as_of: o.as_of });
  if (!r.ok) return r;
  const cal = list_of(r.ws, 'calendars').find((x) => x.calendar_id === built_edit.calendar.calendar_id);
  const as_of = o.as_of ?? ws.as_of;
  return { ok: true, rows: upcoming_days_off(cal, as_of), holidays: holidays_ahead(cal.holidays, as_of) };
}

/** Выходные дни календаря словами: «Сб, Вс» (с понедельника); пусто — `null`. Календарь без поля выходных считается как «суббота и воскресенье» (умолчание движка). */
export function weekend_names(lang, dows) {
  const names = WEEKDAYS_SHORT[lang] ?? WEEKDAYS_SHORT.ru;
  const set = new Set(Array.isArray(dows) ? dows : [0, 6]);
  const out = WEEKDAY_ORDER.filter((d) => set.has(d)).map((d) => names[(d + 6) % 7]);
  return out.length === 0 ? null : out.join(', ');
}

// ── отказы по причине ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Текст отказа: у причин пакета (`calendars.r_<причина>`) — своя фраза с кодом канона, иначе общий текст формы (`error_text`). Введённое не повторяется.
 * @param {object} ctx
 * @param {{code: string, ctx?: object|null}} error
 */
export function reason_text(ctx, error) {
  const reason = typeof error?.ctx?.reason === 'string' ? error.ctx.reason : '';
  if (/^(cal|plan)_[a-z_]+$/.test(reason)) {
    const own = ctx.tr('calendars.r_' + reason, { code: typeof error?.code === 'string' ? error.code : 'E_SCHEMA' });
    if (own !== 'calendars.r_' + reason) return own;
  }
  return error_text(ctx, error);
}

/** Показать (или снять) отказ у поля: текст рядом, `aria-invalid` — смысл не только цветом. */
export function show_error(ctx, field, error) {
  field.err.textContent = error === null || error === undefined ? '' : reason_text(ctx, error);
  field.input.setAttribute('aria-invalid', error === null || error === undefined ? 'false' : 'true');
}

// ── состояние и узлы ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Состояние блоков пакета на один контекст: хранитель фокуса (часы подменяются в тестах). */
export function make_deps(env = {}) {
  const ports = env.ports ?? clock_ports();
  return { focus: create_focus_keeper(ports.now_ms) };
}

/** Строка многострочного ввода: подпись, поле, подсказка и место для ошибки. Идентификатор — `fp08-<form>-<id>`. */
export function area_field(ctx, form, id, o = {}) {
  const dom_id = 'fp08-' + form + '-' + id;
  const input = h('textarea', { id: dom_id, rows: o.rows ?? 3, autocomplete: 'off', spellcheck: 'false', 'aria-describedby': dom_id + '-hint ' + dom_id + '-err' });
  if (o.value !== undefined) input.value = o.value;
  const err = h('p', { id: dom_id + '-err', class: 'error', role: 'alert' });
  const wrap = h('div', { class: 'field' }, h('label', { for: dom_id, text: o.label ?? ctx.tr('forms.f_' + id) }), input,
    h('p', { id: dom_id + '-hint', class: 'muted', text: o.hint ?? '' }), err);
  return { wrap, input, err, id: dom_id };
}

/**
 * Карточка «Календарь выходных и праздников»: список календарей (выходные, число праздников, кто использует) и форма календаря с предпросмотром.
 * Подключается в раздел «Платежи» экрана «Формы данных» через `register_rule_block`.
 * @param {object} ctx контекст расширений
 * @param {{focus: object}} deps `make_deps()`
 * @returns {HTMLElement}
 */
export function render_calendars(ctx, deps) {
  const tr = ctx.tr;
  const ws = ctx.get_ws();
  const root = h('section', { class: 'card fp13-card', id: 'fp13-calendars', 'aria-labelledby': 'fp13-calendars-title' },
    h('h3', { id: 'fp13-calendars-title', tabindex: '-1', text: tr('calendars.cal_title') }));
  if (ws === null || ws === undefined) { root.append(h('p', { class: 'muted', text: tr('forms.no_data') })); return root; }
  const env = env_of(ctx, ws);
  const f = fmt_of(env);
  const calendars = list_of(ws, 'calendars').filter((c) => is_obj(c) && typeof c.calendar_id === 'string');

  let editing = null;
  const new_id = ctx.new_id('cal');
  const name = text_field(ctx, 'cal', 'name', { label: tr('calendars.f_cal_name'), hint: tr('calendars.h_cal_name') });
  const day_names = WEEKDAYS_SHORT[ctx.lang()] ?? WEEKDAYS_SHORT.ru;
  const days = new Map(WEEKDAY_ORDER.map((d) => [d, check_field(ctx, 'cal', 'wd' + d, d === 0 || d === 6, { label: day_names[(d + 6) % 7] })]));
  const days_set = h('fieldset', { class: 'fp13-days', id: 'fp08-cal-days' }, h('legend', { text: tr('calendars.days_legend') }),
    ...[...days.values()].map((x) => x.wrap), h('p', { class: 'muted', text: tr('calendars.h_days') }));
  const holidays = area_field(ctx, 'cal', 'holidays', { label: tr('forms.f_holidays'), hint: tr('calendars.h_holidays'), rows: 4 });
  const preview = h('div', { id: 'fp13-cal-preview', class: 'fp08-preview', 'aria-live': 'polite' });

  const texts = () => ({
    calendar_id: editing ?? new_id, name: name.input.value,
    weekend_dows: WEEKDAY_ORDER.filter((d) => is_checked(days.get(d).input)).map(String), holidays: holidays.input.value,
  });
  const draw_preview = () => {
    const built = build_calendar_edit(ws, texts(), env);
    if (!built.ok) { preview.replaceChildren(h('p', { class: 'muted', text: tr('calendars.preview_wait') })); return built; }
    const p = calendar_preview(ws, built.edit, { as_of: ws.as_of, new_id: ctx.new_id });
    if (!p.ok) { preview.replaceChildren(h('p', { class: 'error', text: reason_text(ctx, p.error) })); return p; }
    const hol = p.holidays;
    preview.replaceChildren(...kids(h('p', { class: 'muted', text: tr('calendars.preview_title') }),
      p.rows.length === 0 ? h('p', { text: tr('calendars.preview_none', { days: PREVIEW_DAYS }) })
        : h('ul', { class: 'plain' }, p.rows.map((x) => h('li', { text: tr('calendars.preview_row', { date: f.date(x.date), why: tr('calendars.why_' + x.why) }) }))),
      // введённые праздники отдельным списком: дальний праздник не теряется за выходными ближайших недель
      hol.rows.length === 0 ? null : h('p', { class: 'muted', text: tr('calendars.preview_hol_title') }),
      hol.rows.length === 0 ? null : h('ul', { class: 'plain', id: 'fp13-cal-hol-list' }, hol.rows.map((d) => h('li', { text: tr('calendars.preview_row', { date: f.date(d), why: tr('calendars.why_holiday') }) }))),
      hol.more > 0 ? h('p', { class: 'muted', text: tr('calendars.preview_hol_more', { n: hol.more }) }) : null,
      hol.past > 0 ? h('p', { class: 'muted', text: tr('calendars.preview_hol_past', { n: hol.past }) }) : null));
    return p;
  };
  const fields = [name, { wrap: days_set }, holidays];
  for (const x of [name, holidays, ...days.values()]) { x.input.addEventListener('input', draw_preview); x.input.addEventListener('change', draw_preview); }

  const submit = () => {
    const built = build_calendar_edit(ws, texts(), env);
    if (!built.ok) {
      const target = built.error.ctx.field === 'name' ? name : (built.error.ctx.field === 'holidays' ? holidays : null);
      if (target !== null) show_error(ctx, target, built.error);
      return built;
    }
    deps.focus.request('fp13-calendars-title');
    const orphans_before = orphan_count(ws, ws.as_of);
    const r = commit_edits(ctx, [built.edit], 'upsert_calendar');
    if (r.ok) {
      // новые даты могут сдвинуть вхождение «n-го рабочего дня»: правка (пропуск, перенос, своя сумма), привязанная к прежней дате, перестаёт действовать — об этом говорим сразу
      const now = ctx.get_ws();
      const lost = now === null || now === undefined ? 0 : orphan_count(now, now.as_of) - orphans_before;
      const base = tr(editing === null ? 'calendars.cal_saved' : 'calendars.cal_updated', { name: built.edit.calendar.name });
      ctx.notify(lost > 0 ? base + ' ' + tr('calendars.cal_orphans', { n: lost }) : base, 'info');
    } else deps.focus.clear();
    return r;
  };
  const card = form_card(ctx, 'cal', tr('calendars.cal_form_title'), tr('calendars.cal_form_lead'), fields, tr('calendars.cal_save'), submit, [preview], reason_text);

  const fill = (cal) => {
    editing = cal.calendar_id;
    name.input.value = cal.name ?? '';
    const set = new Set(Array.isArray(cal.weekend_dows) ? cal.weekend_dows : [0, 6]);
    for (const [d, x] of days) {
      const on = set.has(d);
      if (typeof x.input.setAttribute === 'function') { if (on) x.input.setAttribute('checked', ''); else x.input.removeAttribute('checked'); }
      x.input.checked = on;
    }
    holidays.input.value = (Array.isArray(cal.holidays) ? cal.holidays : []).join('\n');
    draw_preview();
    if (typeof name.input.focus === 'function') name.input.focus();
  };

  // список календарей
  const items = calendars.map((cal) => {
    const u = calendar_usage(ws, cal.calendar_id);
    const label = typeof cal.name === 'string' && cal.name !== '' ? cal.name : cal.calendar_id;
    const hol_n = Array.isArray(cal.holidays) ? cal.holidays.length : 0;
    const off = weekend_names(ctx.lang(), cal.weekend_dows) ?? tr('calendars.days_none');
    const ru = reserve_calendar_use(ws, cal.calendar_id);
    return h('li', { class: 'fp13-cal', 'data-calendar': cal.calendar_id },
      h('p', null, h('strong', { text: label }), ' ',
        h('span', { text: tr('calendars.cal_line', { days: off, n: hol_n, n_word: tr('calendars.holidays_' + plural_cat(ctx.lang(), hol_n)) }) }), ' ',
        h('span', { class: 'muted', text: tr('calendars.cal_usage', { rules: u.rules, streams: u.streams }) }),
        ru.explicit > 0 ? ' ' : null, ru.explicit > 0 ? h('span', { class: 'muted', text: tr('calendars.cal_usage_reserves', { reserves: ru.explicit }) }) : null,
        ru.implicit > 0 ? ' ' : null, ru.implicit > 0 ? h('span', { class: 'muted', text: tr('calendars.cal_usage_default', { n: ru.implicit }) }) : null),
      h('div', { class: 'row' },
        h('button', {
          type: 'button', class: 'btn small', 'data-act': 'cal-edit', 'aria-label': tr('calendars.cal_edit_label', { name: label }),
          onclick: () => fill(cal), text: tr('calendars.cal_edit'),
        }),
        h('button', {
          type: 'button', class: 'btn small', 'data-act': 'cal-delete', 'aria-label': tr('calendars.cal_delete_label', { name: label }),
          onclick: () => {
            deps.focus.request('fp13-calendars-title');
            const r = commit_edits(ctx, [{ type: 'delete_calendar', calendar_id: cal.calendar_id }], 'delete_calendar');
            if (r.ok) ctx.notify(tr('calendars.cal_deleted', { name: label }), 'info');
            else { deps.focus.clear(); ctx.notify(reason_text(ctx, r.error), 'error'); }
          },
          text: tr('calendars.cal_delete'),
        })));
  });
  root.append(
    h('p', { class: 'lead', text: tr('calendars.cal_lead') }),
    calendars.length === 0 ? h('p', { class: 'muted', id: 'fp13-cal-none', text: tr('calendars.cal_none') }) : h('ul', { class: 'plain fp13-cal-list' }, items),
    card.form);
  draw_preview();
  deps.focus.apply();
  return root;
}
