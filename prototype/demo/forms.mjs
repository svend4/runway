// forms.mjs — общий набор полей, разбора ввода и записи для форм данных (FP-08): правила, часы, налог, накопления, курсы, счета, рассрочка.
//
// Принципы (design-brief §4, §10, ADR-004):
//   - введённые тексты разбираются по ФОРМАТУ ЧИСЕЛ РАБОЧЕЙ ОБЛАСТИ (`number_format`, REQ-112), а не по языку интерфейса; деньги — целые minor, без float;
//   - любая запись идёт ТОЛЬКО через `ws_edit.apply_edit` (проверка → копия) и общий путь `ctx.set_ws` (пересчёт страницы → журнал → показ);
//     форма принимается целиком или отвергается целиком; отказ даёт код канона `E_*` и текст на странице, данные не меняются;
//   - текст ошибки НЕ повторяет введённое: показываются код, название поля и подсказка с примером в формате пользователя;
//   - все идентификаторы создаёт приложение (`ctx.new_id`), пользователь ключей не вводит;
//   - ставки, сроки и налоговые календари в формах не предзаполняются: налог — расчёт по введённым правилам, не консультация.
// Файл делится на чистую часть (без DOM, проверяется в Node: `tests/forms.test.mjs`) и небольшой набор узлов (`h` из dom.mjs: textContent и узлы,
// без inline-стилей и обработчиков-строк).

import { to_epoch_day, parse_date, format_date } from '../engine/index.mjs';
import { h } from './dom.mjs';
import { pair_of } from './banner_texts.mjs';
import { apply_edit, decision_currency_of } from './ws_edit.mjs';
import {
  make_nf_fmt, parse_amount_text, parse_decimal_text, parse_date_text, resolve_number_format, format_input_amount,
} from './number_format.mjs';

const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Список в рабочей области (пусто, если нет или не массив). */
export const list_of = (ws, key) => (Array.isArray(ws?.[key]) ? ws[key] : []);

// ── результат разбора ────────────────────────────────────────────────────────────────────────────────────────────────

/** Отказ разбора с кодом канона: `ctx` — `{field, reason}`; значение, которое ввёл пользователь, в него не попадает. */
export function bad(code, field, reason) {
  return { ok: false, error: { code, ctx: { field, reason } } };
}

/** Первая ошибка из набора результатов разбора (`null`, если все приняты). */
export function first_error(results) {
  for (const r of results) if (r !== undefined && r !== null && r.ok === false) return r;
  return null;
}

// ── окружение ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Окружение разбора: валюта решения, язык интерфейса, формат чисел рабочей области, дата расчёта.
 * @param {object} ctx контекст расширений
 * @param {object} ws рабочая область
 * @returns {{cur: string, lang: 'ru'|'en', nf: any, as_of: string}}
 */
export function env_of(ctx, ws) {
  return { cur: decision_currency_of(ws) ?? 'EUR', lang: ctx.lang(), nf: ws?.number_format, as_of: ws?.as_of };
}

/** Форматтеры показа в валюте `cur` (по умолчанию — валюта решения) с учётом формата чисел и дат рабочей области. */
export function fmt_of(env, cur) {
  return make_nf_fmt(env.lang, cur ?? env.cur, env.as_of, env.nf);
}

// ── разбор полей ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Сумма в валюте `cur` по формату рабочей области → minor. Знак «−» допустим только при `negative`; ноль — только при `zero`.
 * @returns {{ok: true, value: number}|{ok: false, error: {code: string, ctx: object}}}
 */
export function parse_money(text, env, field, o = {}) {
  const cur = o.cur ?? env.cur;
  const r = parse_amount_text(text, cur, env.lang, env.nf, { negative: o.negative === true });
  if (!r.ok) return bad(r.reason === 'too_big' ? 'E_OVERFLOW' : r.reason === 'negative' ? 'E_SCHEMA' : 'E_NOT_INTEGER', field, r.reason);
  if (r.value === 0 && o.zero !== true) return bad('E_SCHEMA', field, 'zero');
  if (o.max !== undefined && r.value > o.max) return bad('E_SCHEMA', field, 'above_max');
  return { ok: true, value: r.value };
}

/** Целое число без знака и дробей: `[min, max]`; не число — `E_NOT_INTEGER`, вне границ — `E_SCHEMA`. */
export function parse_count(text, field, min, max) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!/^\d{1,9}$/.test(s)) return bad('E_NOT_INTEGER', field, s === '' ? 'empty' : 'bad_number');
  const v = Number(s);
  if (v < min || v > max) return bad('E_SCHEMA', field, 'range');
  return { ok: true, value: v };
}

/** Целое со знаком (день месяца «−1» — последний): `[min, max]`, ноль допустим только при `zero`. */
export function parse_signed_int(text, field, min, max, o = {}) {
  const s = typeof text === 'string' ? text.trim().replace(/^−/, '-') : '';
  if (!/^-?\d{1,9}$/.test(s)) return bad('E_NOT_INTEGER', field, s === '' ? 'empty' : 'bad_number');
  const v = Number(s);
  if (v === 0 && o.zero !== true) return bad('E_SCHEMA', field, 'zero');
  if (v < min || v > max) return bad('E_SCHEMA', field, 'range');
  return { ok: true, value: v };
}

/** Проценты → базисные пункты без float: «20» → 2000, «20,5» → 2050; граница `max_bp` (по умолчанию 10000 = 100 %). */
export function parse_percent_bp(text, env, field, max_bp = 10000) {
  const s = typeof text === 'string' ? text.trim().replace(/\s*%$/, '') : '';
  const r = parse_decimal_text(s, { exponent: 2, lang: env.lang, nf: env.nf });
  if (!r.ok) return bad(r.reason === 'too_big' ? 'E_OVERFLOW' : 'E_NOT_INTEGER', field, r.reason);
  if (r.value > max_bp) return bad('E_SCHEMA', field, 'range');
  return { ok: true, value: r.value };
}

/**
 * Дата из поля: в формате рабочей области, а `ГГГГ-ММ-ДД` — всегда (так отдаёт `<input type="date">` браузера при любом стиле дат: «ДД.ММ.ГГГГ», «ММ/ДД/ГГГГ»;
 * иначе форма с таким полем не записывалась бы, FP-13). Несуществующая дата — `E_BAD_DATE`. Пустое значение допустимо только при `optional`.
 */
export function parse_date_input(text, env, field, o = {}) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (s === '') return o.optional === true ? { ok: true, value: null } : bad('E_BAD_DATE', field, 'empty');
  const iso = parse_date_text(s, env.lang, env.nf);
  if (iso !== null) return { ok: true, value: iso };
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    let canonical = false;
    try { canonical = format_date(parse_date(s)) === s; } catch { canonical = false; }
    if (canonical) return { ok: true, value: s };
  }
  return bad('E_BAD_DATE', field, 'bad_date');
}

/**
 * Дата из поля, которое может отдать ISO: `<input type="date">` браузера всегда даёт `ГГГГ-ММ-ДД`, какой бы формат дат ни стоял в рабочей области (FP-13).
 * ISO принимается как есть (если такая дата есть в календаре), всё остальное разбирается как `parse_date_input` — по формату рабочей области.
 * Пустое значение допустимо только при `optional`; отказ — `E_BAD_DATE` без повтора введённого.
 * @returns {{ok: true, value: string|null}|{ok: false, error: {code: string, ctx: object}}}
 */
export function parse_date_flexible(text, env, field, o = {}) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    let canonical = false;
    try { canonical = format_date(parse_date(s)) === s; } catch { canonical = false; }
    return canonical ? { ok: true, value: s } : bad('E_BAD_DATE', field, 'bad_date');
  }
  return parse_date_input(s, env, field, o);
}

/**
 * Часы → минуты без float: «93» → 5580, «93:30» → 5610, «93,5» → 5610 (дробь по формату чисел; доли, которые не дают целых минут, отвергаются).
 * @returns {{ok: true, value: number}|{ok: false, error: object}}
 */
export function parse_hours(text, env, field, max_minutes = 31 * 24 * 60) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (s === '') return bad('E_NOT_INTEGER', field, 'empty');
  let minutes;
  const hm = /^(\d{1,4}):([0-5]\d)$/.exec(s);
  if (hm !== null) minutes = Number(hm[1]) * 60 + Number(hm[2]);
  else {
    const r = parse_decimal_text(s, { exponent: 2, lang: env.lang, nf: env.nf }); // сотые доли часа
    if (!r.ok) return bad(r.reason === 'too_big' ? 'E_OVERFLOW' : 'E_NOT_INTEGER', field, r.reason);
    if ((r.value * 60) % 100 !== 0) return bad('E_NOT_INTEGER', field, 'fraction_not_whole_minutes');
    minutes = (r.value * 60) / 100;
  }
  if (minutes > max_minutes) return bad('E_SCHEMA', field, 'range');
  return { ok: true, value: minutes };
}

/**
 * Курс как введён: «0,9250» → `num/den = 9250/10000` (дробь хранится как введена, C-037; сокращать её не нужно). Курс > 0.
 * @returns {{ok: true, value: {num: number, den: number}}|{ok: false, error: object}}
 */
export function parse_rate(text, env, field) {
  const s = typeof text === 'string' ? text.trim() : '';
  const f = resolve_number_format(env.lang, env.nf);
  const sep = f.decimal === ',' ? ',' : '\\.';
  const m = new RegExp('^(\\d{1,12})(?:' + sep + '(\\d{1,9}))?$').exec(s);
  if (m === null) return bad('E_NOT_INTEGER', field, s === '' ? 'empty' : 'bad_number');
  const frac = m[2] ?? '';
  const num = Number(m[1] + frac);
  const den = 10 ** frac.length;
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den)) return bad('E_OVERFLOW', field, 'too_big');
  if (num === 0) return bad('E_SCHEMA', field, 'zero');
  return { ok: true, value: { num, den } };
}

/** Курс «num/den» как число: точная десятичная запись, если дробь конечна (знаменатель делит 10^k), иначе округление до 6 знаков с пометкой «≈». */
export function rate_text(num, den, env) {
  const f = resolve_number_format(env.lang, env.nf);
  for (let k = 0; k <= 12; k++) {
    const p = 10 ** k;
    if (p % den === 0) return format_input_amount(num * (p / den), k, f, false);
  }
  const scaled = (BigInt(num) * 10n ** 6n * 2n + BigInt(den)) / (BigInt(den) * 2n); // половина вверх: курс — положительный
  return '≈ ' + format_input_amount(Number(scaled), 6, f, false);
}

/** Дети без пустых значений: `replaceChildren` настоящего DOM превратил бы `null` в текст «null». */
export function kids(...x) {
  return x.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false);
}

// ── плюральные категории и перечни ───────────────────────────────────────────────────────────────────────────────────

/** Плюральная категория числа для ключей `<префикс>one|few|many` (en: `one|many`). */
export function plural_cat(lang, n) {
  const i = Math.abs(n);
  if (lang === 'ru') {
    const m10 = i % 10;
    const m100 = i % 100;
    if (m10 === 1 && m100 !== 11) return 'one';
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'few';
    return 'many';
  }
  return i === 1 ? 'one' : 'many';
}

/** Открытые счета рабочей области (не закрыты на дату расчёта). */
export function open_accounts(ws) {
  const as_of = typeof ws?.as_of === 'string' ? ws.as_of : '';
  return list_of(ws, 'accounts').filter((a) => is_obj(a) && typeof a.account_id === 'string' && (typeof a.closed_on !== 'string' || a.closed_on > as_of));
}

/** Подпись счёта для людей: имя из рабочей области, иначе идентификатор. */
export function account_label(ws, id) {
  const a = list_of(ws, 'accounts').find((x) => x?.account_id === id);
  return typeof a?.name === 'string' && a.name !== '' ? a.name : String(id);
}

/** Разница дат в днях между двумя ISO-датами (целое, `later − earlier`). */
export function days_between(earlier_iso, later_iso) {
  return to_epoch_day(later_iso) - to_epoch_day(earlier_iso);
}

// ── запись ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Применить цепочку правок к копии рабочей области: каждая проходит `apply_edit`, отказ любой — отказ всего (данные не меняются).
 * @param {object} ws
 * @param {object[]} edits
 * @param {{new_id: (prefix: string) => string, as_of?: string}} env
 * @returns {{ok: true, ws: object}|{ok: false, error: {code: string, ctx: object|null}, index: number}}
 */
export function apply_chain(ws, edits, env) {
  let cur = ws;
  for (let i = 0; i < edits.length; i++) {
    const r = apply_edit(cur, edits[i], { new_id: env.new_id, as_of: env.as_of });
    if (!r.ok) return { ok: false, error: r.error, index: i };
    cur = r.ws;
  }
  return { ok: true, ws: cur };
}

/**
 * Записать цепочку правок одним действием: проверка → один `ctx.set_ws` (один пересчёт страницей, одна запись журнала).
 * @param {object} ctx контекст расширений
 * @param {object[]} edits
 * @param {string} [reason] причина для подписчиков (по умолчанию тип первой правки)
 * @returns {{ok: true, ws: object}|{ok: false, error: {code: string, ctx: object|null}}}
 */
export function commit_edits(ctx, edits, reason) {
  const ws = ctx.get_ws();
  if (ws === null || ws === undefined) return bad('E_SCHEMA', 'workspace', 'no_workspace');
  const r = apply_chain(ws, edits, { new_id: ctx.new_id, as_of: ws.as_of });
  if (!r.ok) return { ok: false, error: r.error };
  const s = ctx.set_ws(r.ws, { reason: reason ?? edits[0]?.type ?? 'forms' });
  return s.ok ? { ok: true, ws: r.ws } : { ok: false, error: s.error };
}

// ── тексты ошибок ────────────────────────────────────────────────────────────────────────────────────────────────────

const KNOWN_CODES = ['E_NOT_INTEGER', 'E_OVERFLOW', 'E_BAD_DATE', 'E_FUTURE_POSTED', 'E_RULE_INVALID', 'E_CURRENCY_MISMATCH', 'E_NO_RATE', 'E_SCHEMA'];

/**
 * Текст отказа: код канона, название поля (если оно известно форме) и подсказка по коду. Введённый текст и значения из `ctx` ошибки не повторяются.
 * @param {object} ctx контекст расширений
 * @param {{code: string, ctx?: object|null}} error
 */
export function error_text(ctx, error) {
  if (error?.ctx?.reason === 'read_only') return ctx.tr('ro.refused'); // режим «только чтение» (FP-17): причина, а не «проверьте заполнение»
  const code = KNOWN_CODES.includes(error?.code) ? error.code : 'E_SCHEMA';
  const field = typeof error?.ctx?.field === 'string' ? error.ctx.field.split('.').pop().replace(/\[\d+\]$/, '') : '';
  const label = /^[a-z][a-z0-9_]*$/.test(field) ? ctx.tr('forms.f_' + field) : '';
  const known_label = label !== '' && label !== 'forms.f_' + field;
  return ctx.tr('forms.err_' + code, { code, field: known_label ? ' «' + label + '»' : '', pair: pair_of(error?.ctx) ?? ctx.tr('ratechip.pair_unknown') }); // E_NO_RATE называет пару (FP-16)
}

// ── узлы ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Строка поля: подпись, поле ввода, подсказка и место для ошибки. Идентификатор страницы — `fp08-<form>-<id>`. */
export function text_field(ctx, form, id, o = {}) {
  const dom_id = 'fp08-' + form + '-' + id;
  const input = h('input', {
    id: dom_id, type: o.type ?? 'text', inputmode: o.inputmode ?? null, autocomplete: 'off', spellcheck: 'false', value: o.value ?? '',
    'aria-describedby': dom_id + '-hint ' + dom_id + '-err', max: o.max ?? null, min: o.min ?? null,
  });
  const err = h('p', { id: dom_id + '-err', class: 'error', role: 'alert' });
  const wrap = h('div', { class: 'field' }, h('label', { for: dom_id, text: o.label ?? ctx.tr('forms.f_' + id) }), input,
    h('p', { id: dom_id + '-hint', class: 'muted', text: o.hint ?? '' }), err);
  return { wrap, input, err, id: dom_id };
}

/** Строка выбора: `options` — `[{value, text}]`, `value` — выбранное. */
export function select_field(ctx, form, id, options, value, o = {}) {
  const dom_id = 'fp08-' + form + '-' + id;
  const select = h('select', { id: dom_id, 'aria-describedby': dom_id + '-err' },
    options.map((x) => h('option', { value: x.value, selected: x.value === value ? true : null, text: x.text })));
  if (value !== undefined && value !== null) select.value = value;
  const err = h('p', { id: dom_id + '-err', class: 'error', role: 'alert' });
  const wrap = h('div', { class: 'field' }, h('label', { for: dom_id, text: o.label ?? ctx.tr('forms.f_' + id) }), select, o.hint === undefined ? null : h('p', { class: 'muted', text: o.hint }), err);
  return { wrap, input: select, err, id: dom_id };
}

/** Строка флажка. */
export function check_field(ctx, form, id, checked, o = {}) {
  const dom_id = 'fp08-' + form + '-' + id;
  const input = h('input', { id: dom_id, type: 'checkbox', checked: checked ? true : null });
  const wrap = h('div', { class: 'field check' }, h('label', { for: dom_id }, input, ' ', o.label ?? ctx.tr('forms.f_' + id)));
  return { wrap, input, err: h('p', { class: 'error' }), id: dom_id };
}

/** Показать (или снять) ошибку у поля; `aria-invalid` отмечает поле, смысл не только цветом. */
export function show_field_error(ctx, field, error) {
  field.err.textContent = error === null || error === undefined ? '' : error_text(ctx, error);
  field.input.setAttribute('aria-invalid', error === null || error === undefined ? 'false' : 'true');
}

/** Значение флажка (в тестовой заглушке — по атрибуту). */
export function is_checked(input) {
  if (typeof input.checked === 'boolean') return input.checked;
  return input.getAttribute?.('checked') !== null && input.getAttribute?.('checked') !== undefined;
}

/**
 * Оболочка формы: карточка с заголовком, пояснением, полями, кнопкой и строкой состояния (`role = status`).
 * `on_submit()` возвращает `{ok, error?}`; ошибка показывается в строке состояния и у поля, если указано `error.ctx.field`.
 * `err_text(ctx, error)` — необязательный разбор текста отказа (по умолчанию `error_text`; FP-13 добавляет тексты по причине отказа).
 */
export function form_card(ctx, id, title, lead, fields, submit_label, on_submit, extra = [], err_text = error_text) {
  const status = h('p', { class: 'muted fp08-status', role: 'status' });
  const form = h('form', { class: 'card fp08-form', id: 'fp08-' + id, novalidate: true, 'aria-labelledby': 'fp08-' + id + '-title', onsubmit: (ev) => {
    if (ev !== undefined && ev !== null && typeof ev.preventDefault === 'function') ev.preventDefault();
    for (const f of fields) if (f.err !== undefined) show_field_error(ctx, f, null);
    status.textContent = '';
    const r = on_submit();
    if (r !== undefined && r !== null && r.ok === false) {
      status.textContent = err_text(ctx, r.error);
    }
    return r;
  } },
  h('h3', { id: 'fp08-' + id + '-title', text: title }),
  lead === '' ? null : h('p', { class: 'lead', text: lead }),
  ...fields.map((f) => f.wrap ?? f),
  ...extra,
  h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn primary', text: submit_label })),
  status);
  return { form, status };
}
