// v0.mjs — калькулятор v0 «Могу ли я купить?» (FP-10, REQ-180, IDEA-96, ADR-015): отдельная страница v0.html без мастера, без хранилища и без аккаунта.
//
// Что это. Остаток, до 12 повторяющихся платежей, до 3 поступлений (у каждого — привычная задержка в днях), по желанию до 2 резервов (налоговый конверт и накопление)
// и покупка → вердикт, минимум после покупки, самая ранняя дата и максимальная сумма. Считает ТЕМ ЖЕ движком, что и основное приложение: форма собирает рабочую область
// (`form_to_ws`, правки проходят `ws_edit.apply_edit`), а ответ даёт `check_purchase` через шаблон каталога верификатора (числа — только из результата инструмента).
// На входных данных, эквивалентных G-001, получаются те же вердикт FRAGILE, минимум 635,00 € / 410,00 €, самая ранняя дата 20 ноября и максимум 435,00 € / 210,00 €
// (tests/v0.test.mjs). Без резервов ответ подписывается «без учёта резервов» (`W_NO_RESERVES`, C-065): числа канона воспроизводятся только после ввода резервов.
//
// Состояние. Хранилища у страницы нет (ни localStorage, ни IndexedDB, ни cookie): состояние — файл JSON. «Сохранить» отдаёт рабочую область (формат `runway-journal/1`,
// как в основном приложении; форма v0 лежит в её поле `v0_form`), «Открыть» читает рабочую область или файл-журнал. Файл, созданный не в v0 (например, G-001), открывается
// для расчёта и покупки; формы v0 для него нет (он показан сводкой). Файл с большим числом платежей или поступлений, чем принимает v0, отвергается с объяснением.
// Страница живёт отдельно от остального приложения: не использует реестр расширений, мастер, метрики и хранилище; сети у неё нет (ни одного fetch). Расчёт по введённым
// данным и правилам, не консультация.
//
// Файл: чистые функции (разбор полей, лимиты, сборка рабочей области, ответ, файл) и узлы (`h` из dom.mjs: только textContent и узлы). Запуск — `boot_v0()` из v0.html.

import { to_epoch_day, format_date, currency_exponent } from '../engine/index.mjs';
import { make_tool_ctx, call_ref } from '../engine/tools.mjs';
import { a0_answer, render_value, LABELS } from '../engine/verifier.mjs';
import { journal_to_ws } from './ws_bridge.mjs';
import { h } from './dom.mjs';
import { clock_ports, local_today } from './ids.mjs';
import {
  parse_amount_text, parse_date_text, parse_decimal_text, make_nf_fmt, sanitize_number_format, validate_number_format, resolve_number_format, NUMBER_PRESETS, DATE_STYLES, preset_of, date_style_of,
} from './number_format.mjs';
import { make_env, rate_uses, answer_note_text } from './rate_chip.mjs';
import { apply_edit } from './ws_edit.mjs';
import { make_rule } from './rule_kit.mjs';
import catalog from './i18n/v0.mjs';
import rate_catalog from './i18n/ratechip.mjs';

// ── границы v0 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Пределы v0 (REQ-180): повторяющихся платежей, поступлений и резервов. Больше — основное приложение. */
export const V0_LIMITS = Object.freeze({ payments: 12, incomes: 3, reserves: 2 });

/** Поле рабочей области, где лежит форма v0 (поле верхнего уровня; движок его не читает и `inputs_hash` оно не меняет). */
export const FORM_KEY = 'v0_form';

/** Предел размера открываемого файла (как в основном приложении, REQ-091). */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Дни вперёд, дальше которых первую дату не принимаем (опечатка в годе). */
export const MAX_DAYS_AHEAD = 800;

export const PAYMENT_FREQS = Object.freeze(['M', 'W', 'Y', 'once']);
export const INCOME_FREQS = Object.freeze(['M', 'once']);
export const WEEKENDS = Object.freeze(['keep', 'next']);
export const PAYMENT_KINDS = Object.freeze(['obligation', 'estimate']);
export const RESERVE_KINDS = Object.freeze(['tax', 'sinking']);

const MODES = Object.freeze(['plan', 'worse']);
const CAL_ID = 'v0-cal';
const ACC_ID = 'v0-acc';
const TAX_ID = 'v0-res-tax';
const TAX_RULE_ID = 'v0-tax';
const SINK_ID = 'v0-res-sink';
const INCOME_TAG = 'v0-income';
const NAME_MAX = 120;

const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const trim = (x) => (typeof x === 'string' ? x.trim() : '');

// ── строки ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

function fill(table, key, params) {
  const raw = Object.hasOwn(table, key) ? table[key] : undefined;
  if (raw === undefined) return key;
  return params === undefined ? raw : raw.replace(/\{([A-Za-z0-9_]+)\}/g, (m, name) => (Object.hasOwn(params, name) ? String(params[name]) : m));
}

/** Строка страницы с подстановкой `{имя}`; неизвестный ключ виден как есть. */
export function tr(lang, key, params) {
  return fill(catalog[lang] ?? catalog.ru, key, params);
}

/** Строки подписи курса (`ratechip.*`, каталог пакета FP-16): у страницы v0 нет реестра расширений, каталог подключён напрямую. */
function rate_tr(lang) {
  return (key, params) => fill(rate_catalog[lang] ?? rate_catalog.ru, key, params);
}

/**
 * Форматтеры денег и дат (те же, что у основного приложения: `render_value` верификатора); с `nf` (`ws.number_format`, REQ-112, FP-16) — в формате чисел и дат
 * пользователя («1.234,50 €»). Без `nf` или при недопустимом значении — по языку, как прежде.
 */
export function make_v0_fmt(lang, cur, as_of, nf) {
  if (sanitize_number_format(nf) !== null) {
    const f = make_nf_fmt(lang, cur, as_of, nf);
    return { money: f.money, date: f.date };
  }
  const exp = currency_exponent(cur);
  return {
    money: (v) => render_value({ kind: 'money', v, cur, dp: exp }, lang, as_of),
    date: (d) => render_value({ kind: 'date', v: typeof d === 'number' ? format_date(d) : d }, lang, as_of),
  };
}

// ── форма ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Пустая форма v0. Все суммы — целые minor units, даты — ISO.
 * @param {string} as_of дата расчёта `YYYY-MM-DD` («сегодня»)
 * @param {string} [currency]
 */
export function empty_form(as_of, currency = 'EUR') {
  return { v: 1, as_of, currency, horizon_days: 60, balance_minor: null, buffer_minor: null, payments: [], incomes: [], reserves: [], purchase: null };
}

const bad = (code, field, reason, extra = {}) => ({ ok: false, error: { code, ctx: { field, reason, ...extra } } });

/** Первая ошибка из набора результатов разбора. */
function first_error(results) {
  for (const r of results) if (r.ok === false) return r;
  return null;
}

function parse_name(text, field) {
  const s = trim(text);
  if (s === '') return bad('E_SCHEMA', field, 'empty');
  if (s.length > NAME_MAX) return bad('E_SCHEMA', field, 'too_long');
  return { ok: true, value: s };
}

function parse_money(text, env, field, o = {}) {
  const r = parse_amount_text(text, env.cur, env.lang, env.nf, { negative: o.negative === true });
  if (!r.ok) return bad(r.reason === 'too_big' ? 'E_OVERFLOW' : r.reason === 'negative' ? 'E_SCHEMA' : 'E_NOT_INTEGER', field, r.reason);
  if (r.value === 0 && o.zero !== true) return bad('E_SCHEMA', field, 'zero');
  return { ok: true, value: r.value };
}

function parse_int(text, field, min, max) {
  const s = trim(text);
  if (!/^\d{1,9}$/.test(s)) return bad('E_NOT_INTEGER', field, s === '' ? 'empty' : 'bad_number');
  const v = Number(s);
  return v < min || v > max ? bad('E_SCHEMA', field, 'range', { min, max }) : { ok: true, value: v };
}

/** Дата: ISO; не раньше `from` (если задано) и не дальше `MAX_DAYS_AHEAD` дней от даты расчёта. */
function parse_day(text, env, field, from) {
  const s = trim(text);
  if (s === '') return bad('E_BAD_DATE', field, 'empty');
  const iso = parse_date_text(s, env.lang, undefined);
  if (iso === null) return bad('E_BAD_DATE', field, 'bad_date');
  if (iso < (from ?? env.as_of)) return bad('E_BAD_DATE', field, 'date_past');
  if (to_epoch_day(iso) - to_epoch_day(env.as_of) > MAX_DAYS_AHEAD) return bad('E_BAD_DATE', field, 'date_far', { days: MAX_DAYS_AHEAD });
  return { ok: true, value: iso };
}

function pick(list, text, field, fallback) {
  const s = trim(text) === '' ? fallback : trim(text);
  return list.includes(s) ? { ok: true, value: s } : bad('E_SCHEMA', field, 'not_in_list');
}

/** Остаток, дата расчёта, буфер и горизонт: поля верха формы. Остаток может быть нулём или отрицательным (овердрафт), буфер — нулём. */
export function parse_top(texts, env) {
  const as_of = parse_date_text(trim(texts.as_of), env.lang, undefined);
  if (as_of === null) return bad('E_BAD_DATE', 'as_of', trim(texts.as_of) === '' ? 'empty' : 'bad_date');
  const e = { ...env, as_of };
  const balance = parse_money(texts.balance, e, 'balance', { negative: true, zero: true });
  const buffer = trim(texts.buffer) === '' ? { ok: true, value: null } : parse_money(texts.buffer, e, 'buffer', { zero: true });
  const horizon = parse_int(texts.horizon, 'horizon', 14, 365);
  const err = first_error([balance, buffer, horizon]);
  if (err !== null) return err;
  const value = { as_of, balance_minor: balance.value, buffer_minor: buffer.value, horizon_days: horizon.value };
  // выбор формата чисел и дат (REQ-112, FP-16): ключи `numfmt` / `datefmt` необязательны; пустой выбор («по языку») возвращает `number_format: null`
  if (texts.numfmt !== undefined || texts.datefmt !== undefined) value.number_format = nf_from_choice(texts.numfmt, texts.datefmt, env.nf);
  return { ok: true, value };
}

/**
 * Формат чисел и дат из выбора в форме: пресет чисел (`NUMBER_PRESETS`; `custom` оставляет числа формата из файла — `keep`) и стиль даты (`DATE_STYLES`) → `{decimal, thousands, date}`
 * либо `null` («по языку»). Неизвестный выбор считается «по языку».
 */
export function nf_from_choice(preset, date_style, keep) {
  const out = {};
  const p = preset === 'custom' ? sanitize_number_format(keep) : (Object.hasOwn(NUMBER_PRESETS, preset) ? NUMBER_PRESETS[preset] : null);
  if (p !== null && p !== undefined && p.decimal !== undefined) { out.decimal = p.decimal; out.thousands = p.thousands; }
  if (DATE_STYLES.includes(date_style) && date_style !== 'auto') out.date = date_style;
  return Object.keys(out).length === 0 ? null : out;
}

/** Повторяющийся платёж: название, сумма, как часто, ближайшая дата, выходные, вид (обязательный / приблизительный), «из налогового конверта». */
export function parse_payment(texts, env) {
  const name = parse_name(texts.name, 'name');
  const amount = parse_money(texts.amount, env, 'amount');
  const freq = pick(PAYMENT_FREQS, texts.freq, 'freq', 'M');
  const date = parse_day(texts.date, env, 'date');
  const weekend = pick(WEEKENDS, texts.weekend, 'weekend', 'keep');
  const kind = pick(PAYMENT_KINDS, texts.kind, 'kind', 'obligation');
  const err = first_error([name, amount, freq, date, weekend, kind]);
  if (err !== null) return err;
  return { ok: true, value: { name: name.value, amount_minor: amount.value, freq: freq.value, date: date.value, weekend: weekend.value, kind: kind.value, from_reserve: texts.from_reserve === true } };
}

/** Поступление: название, сумма, повторение, ближайшая дата, привычная задержка в днях (необязательна). */
export function parse_income(texts, env) {
  const name = parse_name(texts.name, 'name');
  const amount = parse_money(texts.amount, env, 'amount');
  const freq = pick(INCOME_FREQS, texts.freq, 'freq', 'M');
  const date = parse_day(texts.date, env, 'date');
  const weekend = pick(WEEKENDS, texts.weekend, 'weekend', 'keep');
  const delay = trim(texts.delay) === '' ? { ok: true, value: null } : parse_int(texts.delay, 'delay', 0, 365);
  const err = first_error([name, amount, freq, date, weekend, delay]);
  if (err !== null) return err;
  return { ok: true, value: { name: name.value, amount_minor: amount.value, freq: freq.value, date: date.value, weekend: weekend.value, delay_days: delay.value } };
}

/**
 * Резерв: `tax` — налоговый конверт (уже отложено и ставка в процентах — правило пользователя, не консультация) или `sinking` — накопление на редкий платёж
 * (уже отложено, цель и срок). Ставки по умолчанию нет.
 */
export function parse_reserve(texts, env) {
  const kind = pick(RESERVE_KINDS, texts.kind, 'kind', 'tax');
  if (!kind.ok) return kind;
  const name = parse_name(texts.name, 'name');
  const funded = parse_money(texts.funded, env, 'funded', { zero: true });
  if (kind.value === 'tax') {
    const r = parse_decimal_text(trim(texts.rate).replace(/\s*%$/, ''), { exponent: 2, lang: env.lang, nf: env.nf });
    const rate = !r.ok ? bad('E_NOT_INTEGER', 'rate', r.reason) : (r.value > 10000 ? bad('E_SCHEMA', 'rate', 'range', { min: 0, max: 100 }) : { ok: true, value: r.value });
    const err = first_error([name, funded, rate]);
    if (err !== null) return err;
    return { ok: true, value: { kind: 'tax', name: name.value, funded_minor: funded.value, rate_bp: rate.value } };
  }
  const target = parse_money(texts.target, env, 'target');
  const due = parse_day(texts.due, env, 'due', format_date(to_epoch_day(env.as_of) + 1));
  const err = first_error([name, funded, target, due]);
  if (err !== null) return err;
  return { ok: true, value: { kind: 'sinking', name: name.value, funded_minor: funded.value, target_minor: target.value, due_date: due.value } };
}

/** Покупка: сумма и дата (не раньше даты расчёта). */
export function parse_purchase(texts, env) {
  const amount = parse_money(texts.amount, env, 'amount');
  const date = parse_day(texts.date, env, 'date');
  const err = first_error([amount, date]);
  return err !== null ? err : { ok: true, value: { amount_minor: amount.value, date: date.value } };
}

// ── пределы ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Сколько строк каждого вида в форме и где предел. */
export function form_counts(form) {
  return { payments: form.payments.length, incomes: form.incomes.length, reserves: form.reserves.length };
}

/**
 * Добавить строку в форму с проверкой предела: 12 платежей, 3 поступления, 2 резерва (по одному каждого вида). Форма не меняется, а предел объясняется.
 * @param {object} form
 * @param {'payments'|'incomes'|'reserves'} bucket
 * @param {object} item
 */
export function add_item(form, bucket, item) {
  if (!Object.hasOwn(V0_LIMITS, bucket)) return bad('V0_LIMIT', bucket, 'unknown_bucket');
  if (form[bucket].length >= V0_LIMITS[bucket]) return bad('V0_LIMIT', bucket, 'limit', { limit: V0_LIMITS[bucket] });
  if (bucket === 'reserves' && form.reserves.some((r) => r.kind === item.kind)) return bad('V0_LIMIT', bucket, 'duplicate_kind', { limit: V0_LIMITS.reserves });
  return { ok: true, form: { ...form, [bucket]: [...form[bucket], item] } };
}

/** Убрать строку по номеру. */
export function remove_item(form, bucket, index) {
  if (!Object.hasOwn(V0_LIMITS, bucket) || !Number.isInteger(index) || index < 0 || index >= form[bucket].length) return form;
  const next = form[bucket].filter((_, i) => i !== index);
  // платежи, привязанные к убранному налоговому конверту, остаются обычными платежами
  return { ...form, [bucket]: next };
}

/**
 * Пределы v0 для готовой рабочей области (например, открытого файла): платежи — расходные правила, поступления — доходные правила и потоки часов, резервы — резервы.
 * @returns {{counts: {payments: number, incomes: number, reserves: number}, violations: {bucket: string, count: number, limit: number}[]}}
 */
export function ws_limits(ws) {
  const rules = Array.isArray(ws.rules) ? ws.rules : [];
  const counts = {
    payments: rules.filter((r) => r?.kind === 'expense').length,
    incomes: rules.filter((r) => r?.kind === 'income').length + (Array.isArray(ws.streams) ? ws.streams.length : 0),
    reserves: Array.isArray(ws.reserves) ? ws.reserves.length : 0,
  };
  const violations = Object.keys(V0_LIMITS).filter((b) => counts[b] > V0_LIMITS[b]).map((b) => ({ bucket: b, count: counts[b], limit: V0_LIMITS[b] }));
  return { counts, violations };
}

// ── проверка формы из файла ────────────────────────────────────────────────────────────────────────────────────────────

const is_day = (x) => {
  if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x)) return false;
  try { return format_date(to_epoch_day(x)) === x; } catch { return false; }
};
const is_int = (x, min, max) => Number.isSafeInteger(x) && x >= min && x <= max;
const BIG = Number.MAX_SAFE_INTEGER;
const is_name = (x) => typeof x === 'string' && x.trim() !== '' && x.trim().length <= NAME_MAX;

/**
 * Форма v0 из файла пригодна для сборки: объекты и типы на месте (строки — из закрытых списков, суммы и сроки — целые числа, даты — настоящие ISO), виды резервов
 * известны и не повторяются. Файл правится руками, поэтому доверять нельзя: непригодная форма не доходит до сборки рабочей области, файл открывается как чужой.
 * Не бросает.
 * @param {any} form
 * @returns {boolean}
 */
export function form_is_valid(form) {
  if (!is_obj(form) || form.v !== 1 || !is_day(form.as_of) || typeof form.currency !== 'string') return false;
  try { currency_exponent(form.currency); } catch { return false; }
  if (form.number_format !== undefined && form.number_format !== null && !validate_number_format(form.number_format).ok) return false; // формат чисел и дат (REQ-112): из файла, значит недоверенный
  if (!is_int(form.horizon_days, 1, 3650)) return false;
  if (form.balance_minor !== null && !is_int(form.balance_minor, -BIG, BIG)) return false;
  if (form.buffer_minor !== null && !is_int(form.buffer_minor, 0, BIG)) return false;
  if (form.purchase !== null && !(is_obj(form.purchase) && is_int(form.purchase.amount_minor, 1, BIG) && is_day(form.purchase.date))) return false;
  if (!Array.isArray(form.payments) || !Array.isArray(form.incomes) || !Array.isArray(form.reserves)) return false;
  const pay = (p) => is_obj(p) && is_name(p.name) && is_int(p.amount_minor, 1, BIG) && PAYMENT_FREQS.includes(p.freq) && is_day(p.date) && WEEKENDS.includes(p.weekend)
    && PAYMENT_KINDS.includes(p.kind) && typeof p.from_reserve === 'boolean';
  const inc = (p) => is_obj(p) && is_name(p.name) && is_int(p.amount_minor, 1, BIG) && INCOME_FREQS.includes(p.freq) && is_day(p.date) && WEEKENDS.includes(p.weekend)
    && (p.delay_days === null || is_int(p.delay_days, 0, 365));
  const res = (r) => is_obj(r) && RESERVE_KINDS.includes(r.kind) && is_name(r.name) && is_int(r.funded_minor, 0, BIG)
    && (r.kind === 'tax' ? is_int(r.rate_bp, 0, 10000) : is_int(r.target_minor, 1, BIG) && is_day(r.due_date));
  if (!form.payments.every(pay) || !form.incomes.every(inc) || !form.reserves.every(res)) return false;
  return new Set(form.reserves.map((r) => r.kind)).size === form.reserves.length;
}

// ── сборка рабочей области ─────────────────────────────────────────────────────────────────────────────────────────────

/** Каркас рабочей области v0: пустые корзины, календарь «суббота и воскресенье» для переноса платежей с выходных. */
function skeleton(form) {
  return {
    workspace_id: 'ws-v0', name: 'Runway v0', locale: 'ru', decision_currency: form.currency, format: 'runway-journal/1', as_of: form.as_of,
    ...(sanitize_number_format(form.number_format) === null ? {} : { number_format: sanitize_number_format(form.number_format) }), // формат чисел и дат пользователя (REQ-112, FP-16)
    params: { horizon_days: form.horizon_days, buffer_minor: form.buffer_minor },
    accounts: [], calendars: [{ calendar_id: CAL_ID, name: 'Sat/Sun', weekend_dows: [0, 6], holidays: [] }], anchors: [], facts: [], rules: [], overrides: [], plans: [],
    streams: [], tax_rules: [], reserves: [], allocations: [], rates: [], scenarios: [], purchases: [], debts: [], wave_overrides: [], counterparties: [],
  };
}

/** Правки по форме: счёт и остаток, резервы, платежи, поступления. Порядок важен: резервы — до правил, которые на них ссылаются. */
function form_edits(form) {
  const edits = [];
  const acc = { account_id: ACC_ID, currency: form.currency };
  edits.push({ type: 'upsert_account', account: { account_id: ACC_ID, name: 'Main', kind: 'bank', liquidity: 'operating', currency: form.currency } });
  // остаток не введён: счёт есть, опорного остатка нет — расчёт ответит «данных мало» (причина no_anchor), а не выдумает число
  if (form.balance_minor !== null) edits.push({ type: 'set_anchor', anchor: { anchor_id: 'v0-anc', account_id: ACC_ID, date: form.as_of, amount_minor: form.balance_minor } });
  const tax = form.reserves.find((r) => r.kind === 'tax');
  const sink = form.reserves.find((r) => r.kind === 'sinking');
  if (tax !== undefined) {
    edits.push({ type: 'upsert_reserve', reserve: { reserve_id: TAX_ID, kind: 'tax', name: tax.name, currency: form.currency, funded_start_minor: tax.funded_minor, funded_as_of: form.as_of, tax_rule_id: TAX_RULE_ID, backed_by_account_id: null } });
    edits.push({ type: 'upsert_tax_rule', tax_rule: { tax_rule_id: TAX_RULE_ID, name: 'v0 tax rule (user rule; calculation, not advice)', rate_bp: tax.rate_bp, applies_to: { stream_ids: [], tags: [INCOME_TAG] }, valid_from: form.as_of, reserve_id: TAX_ID } });
  }
  if (sink !== undefined) {
    edits.push({
      type: 'upsert_reserve',
      reserve: { reserve_id: SINK_ID, kind: 'sinking', name: sink.name, currency: form.currency, funded_start_minor: sink.funded_minor, funded_as_of: form.as_of, target_minor: sink.target_minor, due_date: sink.due_date, cadence: { freq: 'M', day: 1 }, mode: 'refill_to_target', backed_by_account_id: null },
    });
  }
  const cal = (w) => (w === 'keep' ? {} : { calendar_id: CAL_ID });
  form.payments.forEach((p, i) => {
    const extra = { weekend: p.weekend, ...cal(p.weekend), is_obligation: p.kind === 'obligation', is_estimate: p.kind === 'estimate' };
    if (p.freq === 'once') extra.count = 1;
    if (p.from_reserve === true && tax !== undefined) extra.reserve_id = TAX_ID;
    edits.push({ type: 'upsert_rule', rule: make_rule(acc, 'v0-p' + (i + 1), p.name, 'expense', p.amount_minor, p.freq === 'once' ? 'M' : p.freq, p.date, extra) });
  });
  form.incomes.forEach((p, i) => {
    const extra = { weekend: p.weekend, ...cal(p.weekend), tag: INCOME_TAG };
    if (p.freq === 'once') extra.count = 1;
    if (p.delay_days !== null) extra.delay_days_worse = p.delay_days;
    edits.push({ type: 'upsert_rule', rule: make_rule(acc, 'v0-i' + (i + 1), p.name, 'income', p.amount_minor, 'M', p.date, extra) });
  });
  return edits;
}

/**
 * Рабочая область по форме: правки проходят ту же проверку, что в основном приложении (`apply_edit`); форма v0 кладётся в поле `v0_form`.
 * @param {object} form
 * @returns {{ok: true, ws: object}|{ok: false, error: {code: string, ctx: object|null}}}
 */
export function form_to_ws(form) {
  if (form.payments.length > V0_LIMITS.payments) return bad('V0_LIMIT', 'payments', 'limit', { limit: V0_LIMITS.payments });
  if (form.incomes.length > V0_LIMITS.incomes) return bad('V0_LIMIT', 'incomes', 'limit', { limit: V0_LIMITS.incomes });
  if (form.reserves.length > V0_LIMITS.reserves) return bad('V0_LIMIT', 'reserves', 'limit', { limit: V0_LIMITS.reserves });
  try {
    let ws = skeleton(form);
    for (const e of form_edits(form)) {
      const r = apply_edit(ws, e, { as_of: form.as_of });
      if (!r.ok) return { ok: false, error: r.error };
      ws = r.ws;
    }
    return { ok: true, ws: { ...ws, [FORM_KEY]: JSON.parse(JSON.stringify(form)) } };
  } catch (e) {
    // сборка правила бросает на непригодной дате или сумме: наружу уходит отказ кодом, а не исключение
    return { ok: false, error: { code: typeof e?.code === 'string' ? e.code : 'E_SCHEMA', ctx: null } };
  }
}

// ── ответ ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Ответ на вопрос «Могу ли я купить?» тем же инструментом `check_purchase`, что и в основном приложении: вердикт, минимум после покупки по двум режимам,
 * самая ранняя дата, максимум на дату покупки, флаги и предупреждения (в том числе «без учёта резервов»); текст — шаблон каталога верификатора.
 * @param {object} ws рабочая область
 * @param {{amount_minor: number, date: string}} purchase
 * @param {'ru'|'en'} lang
 * @returns {{ok: false, code: string}|{ok: true, kind: string, text: string, ref: string, verified: boolean, view: object}}
 */
export function purchase_answer(ws, purchase, lang) {
  let ctx;
  try { ctx = make_tool_ctx(ws, { as_of: ws.as_of }, { locale: lang }); } catch (e) { return { ok: false, code: typeof e?.code === 'string' ? e.code : 'E_SCHEMA' }; }
  const args = { date: purchase.date, amount_minor: purchase.amount_minor, currency: ctx.decision_currency };
  ctx.calls_used = 0;
  const r = a0_answer({ name: 'check_purchase', args }, ctx, { locale: lang, number_format: ws.number_format }); // формат чисел и дат пользователя (REQ-112, FP-16)
  if (!r.ok) return { ok: false, code: typeof r.error?.code === 'string' ? r.error.code : 'E_SCHEMA' };
  const f = r.result.facts;
  const val = (id) => r.result.evidence.find((e) => e.id === id)?.v ?? null;
  const view = { kind: f.kind, warnings: r.result.warnings.map((w) => w.code), currency: ctx.decision_currency, as_of: ws.as_of };
  const fx_note = answer_note_text(rate_tr(lang), make_env(lang, ws, ctx), rate_uses(ws, ctx)); // курсы, по которым пересчитан расчёт чужого файла (REQ-077, REQ-079)
  if (fx_note !== '') view.fx_note = fx_note;
  if (f.kind === 'ok') {
    view.verdict = f.verdict;
    view.buffer = val(f.buffer_minor);
    view.by_mode = {};
    for (const m of MODES) {
      const x = f.by_mode[m];
      view.by_mode[m] = { m_after: val(x.m_after), at: val(x.at), margin: val(x.margin) };
    }
    view.s_max = f.s_max === null ? null : { plan: val(f.s_max.plan), worse: val(f.s_max.worse) };
    view.earliest = f.earliest === null ? null : { plan: val(f.earliest.plan), worse: val(f.earliest.worse) };
    view.beyond = val(f.beyond_horizon_minor) ?? 0;
  } else if (f.kind === 'insufficient_data') {
    view.reason = f.reason;
    view.reasons = f.reasons;
  }
  return { ok: true, kind: f.kind, text: r.text, ref: call_ref(r.result.call_id), verified: r.verified, view };
}

// ── файл состояния ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Текст файла состояния: рабочая область JSON (формат `runway-journal/1`), как «Данные → Выгрузить» основного приложения. */
export function state_text(ws) {
  return JSON.stringify(ws, null, 2) + '\n';
}

/**
 * Прочитать файл состояния: рабочая область (своя — с формой v0, или чужая) либо файл-журнал.
 * @param {string} text
 * @param {number} [bytes] размер файла в байтах (до разбора, REQ-091)
 * @returns {{ok: true, kind: 'v0'|'foreign', ws: object, form?: object, limits: ReturnType<typeof ws_limits>}|{ok: false, reason: string, limits?: ReturnType<typeof ws_limits>}}
 */
export function read_state(text, bytes = text.length) {
  if (bytes > MAX_FILE_BYTES) return { ok: false, reason: 'too_big' };
  let obj;
  try { obj = JSON.parse(text); } catch { return { ok: false, reason: 'bad_json' }; }
  let ws = null;
  if (is_obj(obj) && typeof obj.as_of === 'string') ws = obj;
  else if (is_obj(obj) || Array.isArray(obj)) {
    try { ws = journal_to_ws(text); } catch { return { ok: false, reason: 'bad_shape' }; }
  }
  if (!is_obj(ws) || typeof ws.as_of !== 'string') return { ok: false, reason: 'bad_shape' };
  const limits = ws_limits(ws);
  if (limits.violations.length > 0) return { ok: false, reason: 'limits', limits };
  const form = ws[FORM_KEY];
  // непригодная форма (испорчена руками) не падение: файл открывается как чужой, для расчёта и покупки, а формы v0 у него нет
  if (form_is_valid(form)) {
    const rebuilt = form_to_ws(form);
    if (rebuilt.ok) return { ok: true, kind: 'v0', ws: rebuilt.ws, form: rebuilt.ws[FORM_KEY], limits };
  }
  try { make_tool_ctx(ws, { as_of: ws.as_of }, { locale: 'ru' }); } catch { return { ok: false, reason: 'bad_shape' }; }
  return { ok: true, kind: 'foreign', ws, limits };
}

// ── тексты ошибок ──────────────────────────────────────────────────────────────────────────────────────────────────────

const KNOWN_REASONS = ['empty', 'bad_number', 'zero', 'negative', 'too_big', 'bad_date', 'date_past', 'date_far', 'range', 'too_long', 'not_in_list'];
const KNOWN_FIELDS = ['name', 'amount', 'freq', 'date', 'weekend', 'kind', 'delay', 'funded', 'rate', 'target', 'due', 'balance', 'buffer', 'horizon', 'as_of'];

/**
 * Текст отказа: подпись поля, код и подсказка по причине; введённое значение не повторяется. Предел v0 объясняется отдельной строкой.
 * @param {'ru'|'en'} lang
 * @param {{code?: string, ctx?: object|null}} error
 */
export function error_text(lang, error) {
  const field = String(error?.ctx?.field ?? '');
  if (error?.code === 'V0_LIMIT') {
    if (error?.ctx?.reason === 'duplicate_kind') return tr(lang, 'v0.limit_duplicate');
    const bucket = Object.hasOwn(V0_LIMITS, field) ? field : 'payments';
    return tr(lang, 'v0.limit_' + bucket, { max: V0_LIMITS[bucket] });
  }
  const reason = KNOWN_REASONS.includes(error?.ctx?.reason) ? error.ctx.reason : 'other';
  const code = typeof error?.code === 'string' && /^E_[A-Z_]+$/.test(error.code) ? error.code : 'E_SCHEMA';
  const label = KNOWN_FIELDS.includes(field) ? tr(lang, 'v0.f_' + field) : tr(lang, 'v0.f_other');
  return tr(lang, 'v0.er_' + reason, { field: label, code, days: MAX_DAYS_AHEAD, min: error?.ctx?.min ?? 0, max: error?.ctx?.max ?? 0 });
}

// ── узлы ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

const el = (id) => document.getElementById(id);

/**
 * Черновики полей. Страница перерисовывается целиком после каждого добавления строки, и введённое, но не принятое (остаток, буфер, горизонт, покупка) пропадало бы.
 * Поэтому каждое поле запоминает исходное значение (`init`) и регистрируется в `page.live`; перед перерисовкой `keep_inputs` откладывает значения полей, которые
 * пользователь изменил, а следующая отрисовка (`page.drafts`, один раз) подставляет их назад. Поля только что принятой формы пропускаются: они берутся из формы.
 */
function draft_of(page, dom) {
  const d = page.cur_drafts;
  return d !== undefined && d !== null && Object.hasOwn(d, dom) ? d[dom] : undefined;
}

function register_live(page, dom, input, init) {
  if (!Array.isArray(page.live)) page.live = [];
  page.live.push({ id: dom, input, init: String(init ?? '') });
}

/** Отложить изменённые пользователем поля (кроме `skip`) до следующей отрисовки. */
function keep_inputs(page, skip) {
  const skip_ids = new Set(skip.map((r) => r.id));
  const kept = {};
  for (const r of Array.isArray(page.live) ? page.live : []) {
    const v = r.input.value;
    if (!skip_ids.has(r.id) && typeof v === 'string' && v !== r.init) kept[r.id] = v;
  }
  page.drafts = kept;
}

function text_row(page, id, label_key, o = {}) {
  const dom = 'v0-' + id;
  const draft = draft_of(page, dom);
  const input = h('input', {
    id: dom, type: o.type ?? 'text', inputmode: o.inputmode ?? null, autocomplete: 'off', spellcheck: 'false', value: draft ?? o.value ?? '', 'aria-describedby': dom + '-hint ' + dom + '-err',
    'aria-required': o.required === true ? 'true' : null,
  });
  register_live(page, dom, input, o.value ?? '');
  const err = h('p', { id: dom + '-err', class: 'error', role: 'alert' });
  const wrap = h('div', { class: 'field' }, h('label', { for: dom, text: tr(page.lang, label_key, o.params) }), input, h('p', { id: dom + '-hint', class: 'muted', text: o.hint_key === undefined ? '' : tr(page.lang, o.hint_key, o.hint_params) }), err);
  return { wrap, input, err, key: o.field ?? id, id: dom };
}

function select_row(page, id, label_key, options, value) {
  const dom = 'v0-' + id;
  const draft = draft_of(page, dom);
  const shown = draft !== undefined && options.some((x) => x.value === draft) ? draft : value;
  const select = h('select', { id: dom, 'aria-describedby': dom + '-err' }, options.map((x) => h('option', { value: x.value, selected: x.value === shown ? true : null, text: x.text })));
  if (shown !== undefined) select.value = shown;
  register_live(page, dom, select, value ?? '');
  const err = h('p', { id: dom + '-err', class: 'error', role: 'alert' });
  return { wrap: h('div', { class: 'field' }, h('label', { for: dom, text: tr(page.lang, label_key) }), select, err), input: select, err, key: id, id: dom };
}

function check_row(page, id, label_key) {
  const dom = 'v0-' + id;
  const input = h('input', { id: dom, type: 'checkbox' });
  return { wrap: h('div', { class: 'field check' }, h('label', { for: dom }, input, ' ', tr(page.lang, label_key))), input, err: h('p', { class: 'error' }), key: id, id: dom };
}

const is_checked = (input) => (typeof input.checked === 'boolean' ? input.checked : input.getAttribute?.('checked') !== null && input.getAttribute?.('checked') !== undefined);

function show_errors(page, rows, error, status) {
  const text = error_text(page.lang, error);
  for (const r of rows) { r.err.textContent = ''; r.input.setAttribute('aria-invalid', 'false'); }
  const target = rows.find((r) => r.key === String(error?.ctx?.field ?? '')) ?? null;
  if (target !== null) {
    target.err.textContent = text;
    target.input.setAttribute('aria-invalid', 'true');
    if (typeof target.input.focus === 'function') target.input.focus();
    status.textContent = '';
  } else status.textContent = text;
}

/** Проценты из базисных пунктов для показа: 2000 → «20», 2050 → «20,50» (десятичный знак по языку). */
export function pct_text(bp, lang, nf) {
  const sep = nf === undefined || nf === null ? (lang === 'ru' ? ',' : '.') : resolve_number_format(lang, nf).decimal; // десятичный знак — по формату чисел пользователя (REQ-112, FP-16)
  return String(Math.floor(bp / 100)) + (bp % 100 === 0 ? '' : sep + String(bp % 100).padStart(2, '0'));
}

/** Строка о платеже или поступлении для списка. */
function item_line(page, bucket, it) {
  const f = make_v0_fmt(page.lang, page.form.currency, page.form.as_of, page.form.number_format);
  if (bucket === 'reserves') {
    return it.kind === 'tax'
      ? tr(page.lang, 'v0.line_tax', { name: it.name, funded: f.money(it.funded_minor), rate: pct_text(it.rate_bp, page.lang, page.form.number_format) })
      : tr(page.lang, 'v0.line_sink', { name: it.name, funded: f.money(it.funded_minor), target: f.money(it.target_minor), due: f.date(it.due_date) });
  }
  const key = bucket === 'payments' ? 'v0.line_payment' : 'v0.line_income';
  const every = tr(page.lang, 'v0.freq_' + it.freq);
  const extra = bucket === 'incomes' && it.delay_days !== null ? ' ' + tr(page.lang, 'v0.line_delay', { n: it.delay_days }) : '';
  return tr(page.lang, key, { name: it.name, amount: f.money(it.amount_minor), every, date: f.date(it.date) }) + extra;
}

function list_block(page, bucket, title_key) {
  const items = page.form[bucket];
  const lang = page.lang;
  return h('div', { class: 'v0-list' },
    h('h3', { id: 'v0-' + bucket + '-title', text: tr(lang, title_key, { n: items.length, max: V0_LIMITS[bucket] }) }),
    items.length >= V0_LIMITS[bucket] ? h('p', { class: 'banner', role: 'status', text: error_text(lang, { code: 'V0_LIMIT', ctx: { field: bucket, reason: 'limit' } }) }) : null,
    items.length === 0 ? h('p', { class: 'muted', text: tr(lang, 'v0.list_empty') })
      : h('ul', { class: 'plain', 'aria-labelledby': 'v0-' + bucket + '-title' }, items.map((it, i) => h('li', null, item_line(page, bucket, it), ' ', h('button', {
        type: 'button', class: 'link', 'data-bucket': bucket, 'data-index': String(i), 'aria-label': tr(lang, 'v0.remove_label', { name: it.name }),
        onclick: () => { keep_inputs(page, []); page.form = remove_item(page.form, bucket, i); page.changed(); }, text: tr(lang, 'v0.remove'),
      })))));
}

/** Форма добавления строки: поля, кнопка «Добавить», строка состояния. `parse` возвращает `{ok, value}` или ошибку. */
function add_form(page, bucket, rows, submit_key, parse, texts) {
  const status = h('p', { class: 'muted', role: 'status' });
  const form = h('form', {
    id: 'v0-form-' + bucket, class: 'v0-form', novalidate: true,
    onsubmit: (ev) => {
      if (ev !== undefined && ev !== null && typeof ev.preventDefault === 'function') ev.preventDefault();
      const env = { cur: page.form.currency, lang: page.lang, as_of: page.form.as_of, nf: sanitize_number_format(page.form.number_format) ?? undefined };
      const p = parse(texts(), env);
      if (!p.ok) { show_errors(page, rows, p.error, status); return p; }
      const added = add_item(page.form, bucket, p.value);
      if (!added.ok) { show_errors(page, rows, added.error, status); return added; }
      const built = form_to_ws(added.form);
      if (!built.ok) { show_errors(page, rows, built.error, status); return built; }
      keep_inputs(page, rows); // поля этой формы очищаются, остальные (остаток, покупка и т. п.) остаются как введены
      page.form = added.form;
      page.changed(tr(page.lang, 'v0.added', { name: p.value.name }));
      return { ok: true };
    },
  }, ...rows.map((r) => r.wrap), h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn', text: tr(page.lang, submit_key) })), status);
  return form;
}

function result_nodes(page) {
  const lang = page.lang;
  const out = [];
  if (page.foreign === null && page.form.purchase === null) return [h('p', { class: 'muted', text: tr(lang, 'v0.r_none') })];
  const built = page.foreign !== null ? { ok: true, ws: page.foreign } : form_to_ws(page.form);
  const ws = built.ok ? built.ws : null;
  const purchase = page.foreign !== null ? page.purchase : page.form.purchase;
  if (ws === null || purchase === null) return [h('p', { class: 'muted', text: tr(lang, 'v0.r_none') })];
  const ans = purchase_answer(ws, purchase, lang);
  if (!ans.ok) return [h('p', { class: 'error', role: 'alert', text: error_text(lang, { code: ans.code, ctx: { field: 'other', reason: 'other' } }) })];
  const v = ans.view;
  const f = make_v0_fmt(lang, v.currency, v.as_of, ws.number_format);
  if (v.kind === 'insufficient_data') {
    out.push(h('p', { class: 'banner', role: 'status', text: tr(lang, 'v0.r_gate', { reason: tr(lang, 'v0.gate_' + (['readiness', 'stale', 'no_anchor', 'no_buffer', 'rule_disabled'].includes(v.reason) ? v.reason : 'generic')) }) }), h('p', { class: 'muted', text: ans.text }));
    return out;
  }
  if (v.kind !== 'ok') return [h('p', { class: 'banner', role: 'status', text: ans.text })];
  out.push(h('h3', { id: 'v0-verdict' }, tr(lang, 'v0.r_verdict') + ': ', h('span', { class: 'verdict verdict-' + v.verdict }, LABELS.verdicts[lang][v.verdict])));
  if (v.beyond > 0) out.push(h('p', { class: 'banner', text: tr(lang, 'v0.r_beyond', { value: f.money(v.beyond) }) }));
  out.push(h('h4', { text: tr(lang, 'v0.r_after') }), h('ul', { class: 'plain' }, MODES.map((m) => {
    const x = v.by_mode[m];
    return h('li', null, h('strong', { text: LABELS.modes[lang][m] + ': ' }), tr(lang, 'v0.r_after_line', { value: f.money(x.m_after), date: f.date(x.at), margin: f.money(Math.abs(x.margin)), where: tr(lang, x.margin < 0 ? 'v0.below' : 'v0.above') }));
  })));
  if (v.s_max !== null) {
    out.push(h('h4', { text: tr(lang, 'v0.r_max', { date: f.date(purchase.date) }) }), h('ul', { class: 'plain' }, MODES.map((m) => h('li', null, h('strong', { text: LABELS.modes[lang][m] + ': ' }), f.money(v.s_max[m])))));
    out.push(h('h4', { text: tr(lang, 'v0.r_earliest') }), h('ul', { class: 'plain' }, MODES.map((m) => h('li', null, h('strong', { text: LABELS.modes[lang][m] + ': ' }), v.earliest[m] === null ? tr(lang, 'v0.r_earliest_none') : f.date(v.earliest[m])))));
  }
  if (v.warnings.includes('W_NO_RESERVES')) out.push(h('p', { class: 'banner', role: 'status', text: tr(lang, 'v0.r_no_reserves') }));
  if (v.fx_note !== undefined) out.push(h('p', { class: 'muted rate-note', text: v.fx_note }));
  out.push(h('details', { class: 'sentence' }, h('summary', { text: tr(lang, 'v0.r_sentence') }), h('p', { text: ans.text })),
    h('p', { class: 'muted', text: tr(lang, 'v0.r_engine', { ref: ans.ref }) }));
  return out;
}

/** Состояние страницы: форма, язык, открытый чужой файл, покупка для чужого файла. */
function make_page(lang, as_of) {
  const page = { lang, form: empty_form(as_of), foreign: null, purchase: null, notice: '', changed: null };
  return page;
}

function download(name, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  if (typeof link.remove === 'function') link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Нарисовать страницу в `#main`. */
export function render_page(page) {
  page.cur_drafts = page.drafts ?? null; // черновики действуют на одну отрисовку
  page.drafts = null;
  page.live = [];
  const lang = page.lang;
  const main = el('main');
  const root = [];
  const f = page.form;
  root.push(h('h2', { id: 'v0-title', tabindex: '-1', text: tr(lang, 'v0.title') }), h('p', { class: 'lead', text: tr(lang, 'v0.lead', { pay: V0_LIMITS.payments, inc: V0_LIMITS.incomes }) }));
  if (page.notice !== '') root.push(h('p', { class: 'banner', role: 'status', id: 'v0-notice', text: page.notice }));

  if (page.foreign !== null) {
    const ws = page.foreign;
    const c = ws_limits(ws).counts;
    root.push(h('section', { class: 'card', 'aria-labelledby': 'v0-foreign-title' },
      h('h3', { id: 'v0-foreign-title', text: tr(lang, 'v0.foreign_title') }),
      h('p', { text: tr(lang, 'v0.foreign_lead', { pay: c.payments, inc: c.incomes, res: c.reserves }) }),
      h('button', { type: 'button', class: 'btn', id: 'v0-reset', onclick: () => { page.foreign = null; page.purchase = null; page.notice = ''; page.changed(); }, text: tr(lang, 'v0.reset') })));
  } else {
    // верх формы
    const as_of = text_row(page, 'asof', 'v0.f_as_of', { type: 'date', value: f.as_of, field: 'as_of', hint_key: 'v0.h_as_of', required: true });
    const bal = text_row(page, 'balance', 'v0.f_balance_cur', { params: { cur: f.currency }, value: f.balance_minor === null ? '' : format_input(f.balance_minor, f.currency, lang, f.number_format), inputmode: 'decimal', field: 'balance', hint_key: 'v0.h_balance', required: true });
    const buf = text_row(page, 'buffer', 'v0.f_buffer_cur', { params: { cur: f.currency }, value: f.buffer_minor === null ? '' : format_input(f.buffer_minor, f.currency, lang, f.number_format), inputmode: 'decimal', field: 'buffer', hint_key: 'v0.h_buffer' });
    const hor = text_row(page, 'horizon', 'v0.f_horizon', { value: String(f.horizon_days), inputmode: 'numeric', field: 'horizon', hint_key: 'v0.h_horizon' });
    // формат чисел и дат (REQ-112, FP-16): пресет чисел и стиль даты; сохраняются в форме (`number_format`) и в файле состояния
    const nf0 = sanitize_number_format(f.number_format);
    const preset_ids = [...Object.keys(NUMBER_PRESETS), ...(preset_of(nf0) === 'custom' ? ['custom'] : [])];
    const numfmt = select_row(page, 'numfmt', 'v0.f_numfmt', preset_ids.map((id) => ({ value: id, text: tr(lang, 'v0.numfmt_' + id) })), preset_of(nf0));
    numfmt.key = 'numfmt';
    const datefmt = select_row(page, 'datefmt', 'v0.f_datefmt', DATE_STYLES.map((id) => ({ value: id, text: tr(lang, 'v0.datefmt_' + id) })), date_style_of(nf0));
    datefmt.key = 'datefmt';
    const top_rows = [as_of, bal, buf, hor, numfmt, datefmt];
    const top_status = h('p', { class: 'muted', role: 'status' });
    root.push(h('section', { class: 'card', 'aria-labelledby': 'v0-top-title' },
      h('h3', { id: 'v0-top-title', text: tr(lang, 'v0.s_top') }),
      h('form', {
        id: 'v0-form-top', class: 'v0-form', novalidate: true,
        onsubmit: (ev) => {
          if (ev !== undefined && ev !== null && typeof ev.preventDefault === 'function') ev.preventDefault();
          const p = parse_top({ as_of: as_of.input.value, balance: bal.input.value, buffer: buf.input.value, horizon: hor.input.value, numfmt: numfmt.input.value, datefmt: datefmt.input.value },
            { cur: f.currency, lang, nf: nf0 ?? undefined });
          if (!p.ok) { show_errors(page, top_rows, p.error, top_status); return p; }
          const next = { ...page.form, ...p.value };
          if (next.number_format === null) delete next.number_format; // «по языку»: ключа в форме нет
          const built = form_to_ws(next);
          if (!built.ok) { show_errors(page, top_rows, built.error, top_status); return built; }
          keep_inputs(page, top_rows);
          page.form = next;
          page.changed(tr(lang, 'v0.top_saved'));
          return { ok: true };
        },
      }, ...top_rows.map((r) => r.wrap), h('p', { class: 'muted', text: tr(lang, 'v0.h_numfmt') }), // выбранный формат действует со следующей отправки: суммы этой отправки читаются по прежнему (дефект D7)
      h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn', text: tr(lang, 'v0.save_top') })), top_status)));

    // платежи
    const pn = text_row(page, 'pay-name', 'v0.f_name', { field: 'name', hint_key: 'v0.h_pay_name', required: true });
    const pa = text_row(page, 'pay-amount', 'v0.f_amount_cur', { params: { cur: f.currency }, inputmode: 'decimal', field: 'amount', hint_key: 'v0.h_pay_amount', required: true });
    const pf = select_row(page, 'pay-freq', 'v0.f_freq', PAYMENT_FREQS.map((x) => ({ value: x, text: tr(lang, 'v0.freq_' + x) })), 'M');
    pf.key = 'freq';
    const pd = text_row(page, 'pay-date', 'v0.f_pay_date', { type: 'date', value: f.as_of, field: 'date', required: true });
    const pw = select_row(page, 'pay-weekend', 'v0.f_weekend', WEEKENDS.map((x) => ({ value: x, text: tr(lang, 'v0.weekend_' + x) })), 'keep');
    pw.key = 'weekend';
    const pk = select_row(page, 'pay-kind', 'v0.f_kind', PAYMENT_KINDS.map((x) => ({ value: x, text: tr(lang, 'v0.kind_' + x) })), 'obligation');
    pk.key = 'kind';
    const pr = check_row(page, 'pay-reserve', 'v0.f_from_reserve');
    const pay_rows = [pn, pa, pf, pd, pw, pk];
    const has_tax = f.reserves.some((r) => r.kind === 'tax');
    if (has_tax) pay_rows.push(pr);
    root.push(h('section', { class: 'card', 'aria-labelledby': 'v0-payments-title' }, list_block(page, 'payments', 'v0.s_payments'),
      add_form(page, 'payments', pay_rows, 'v0.add_payment', parse_payment, () => ({
        name: pn.input.value, amount: pa.input.value, freq: pf.input.value, date: pd.input.value, weekend: pw.input.value, kind: pk.input.value, from_reserve: has_tax && is_checked(pr.input),
      }))));

    // поступления
    const iname = text_row(page, 'inc-name', 'v0.f_name', { field: 'name', hint_key: 'v0.h_inc_name', required: true });
    const iamt = text_row(page, 'inc-amount', 'v0.f_amount_cur', { params: { cur: f.currency }, inputmode: 'decimal', field: 'amount', hint_key: 'v0.h_inc_amount', required: true });
    const ifr = select_row(page, 'inc-freq', 'v0.f_repeat', INCOME_FREQS.map((x) => ({ value: x, text: tr(lang, 'v0.freq_' + x) })), 'M');
    ifr.key = 'freq';
    const idt = text_row(page, 'inc-date', 'v0.f_inc_date', { type: 'date', value: f.as_of, field: 'date', required: true });
    const idl = text_row(page, 'inc-delay', 'v0.f_delay', { inputmode: 'numeric', field: 'delay', hint_key: 'v0.h_delay' });
    root.push(h('section', { class: 'card', 'aria-labelledby': 'v0-incomes-title' }, list_block(page, 'incomes', 'v0.s_incomes'),
      add_form(page, 'incomes', [iname, iamt, ifr, idt, idl], 'v0.add_income', parse_income, () => ({
        name: iname.input.value, amount: iamt.input.value, freq: ifr.input.value, date: idt.input.value, delay: idl.input.value, weekend: 'keep',
      }))));

    // резервы
    const rk = select_row(page, 'res-kind', 'v0.f_res_kind', RESERVE_KINDS.map((x) => ({ value: x, text: tr(lang, 'v0.res_' + x) })), 'tax');
    rk.key = 'kind';
    const rn = text_row(page, 'res-name', 'v0.f_name', { field: 'name', hint_key: 'v0.h_res_name', required: true });
    const rf = text_row(page, 'res-funded', 'v0.f_funded_cur', { params: { cur: f.currency }, inputmode: 'decimal', field: 'funded', hint_key: 'v0.h_funded', required: true });
    const rr = text_row(page, 'res-rate', 'v0.f_rate', { inputmode: 'decimal', field: 'rate', hint_key: 'v0.h_rate' });
    const rt = text_row(page, 'res-target', 'v0.f_target_cur', { params: { cur: f.currency }, inputmode: 'decimal', field: 'target', hint_key: 'v0.h_target' });
    const rd = text_row(page, 'res-due', 'v0.f_due', { type: 'date', field: 'due', hint_key: 'v0.h_due' });
    root.push(h('section', { class: 'card', 'aria-labelledby': 'v0-reserves-title' }, list_block(page, 'reserves', 'v0.s_reserves'),
      h('p', { class: 'muted', text: tr(lang, 'v0.res_lead') }),
      add_form(page, 'reserves', [rk, rn, rf, rr, rt, rd], 'v0.add_reserve', parse_reserve, () => ({
        kind: rk.input.value, name: rn.input.value, funded: rf.input.value, rate: rr.input.value, target: rt.input.value, due: rd.input.value,
      }))));
  }

  // покупка
  const pam = text_row(page, 'buy-amount', 'v0.f_amount_cur', { params: { cur: page.foreign !== null ? (page.foreign.decision_currency ?? 'EUR') : f.currency }, inputmode: 'decimal', field: 'amount', required: true,
    value: (page.foreign !== null ? page.purchase : f.purchase) === null ? '' : format_input((page.foreign !== null ? page.purchase : f.purchase).amount_minor, page.foreign !== null ? (page.foreign.decision_currency ?? 'EUR') : f.currency, lang, page.foreign !== null ? page.foreign.number_format : f.number_format) });
  const base_date = page.foreign !== null ? page.foreign.as_of : f.as_of;
  const pdt = text_row(page, 'buy-date', 'v0.f_buy_date', { type: 'date', value: (page.foreign !== null ? page.purchase : f.purchase)?.date ?? base_date, field: 'date', required: true });
  const buy_status = h('p', { class: 'muted', role: 'status' });
  root.push(h('section', { class: 'card', 'aria-labelledby': 'v0-buy-title' }, h('h3', { id: 'v0-buy-title', text: tr(lang, 'v0.s_buy') }),
    h('form', {
      id: 'v0-form-buy', class: 'v0-form', novalidate: true,
      onsubmit: (ev) => {
        if (ev !== undefined && ev !== null && typeof ev.preventDefault === 'function') ev.preventDefault();
        const as_of = page.foreign !== null ? page.foreign.as_of : f.as_of;
        const cur = page.foreign !== null ? (page.foreign.decision_currency ?? 'EUR') : f.currency;
        const p = parse_purchase({ amount: pam.input.value, date: pdt.input.value }, { cur, lang, as_of, nf: sanitize_number_format(page.foreign !== null ? page.foreign.number_format : page.form.number_format) ?? undefined });
        if (!p.ok) { show_errors(page, [pam, pdt], p.error, buy_status); return p; }
        keep_inputs(page, [pam, pdt]);
        if (page.foreign !== null) page.purchase = p.value; else page.form = { ...page.form, purchase: p.value };
        page.changed();
        return { ok: true };
      },
    }, pam.wrap, pdt.wrap, h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn primary', text: tr(lang, 'v0.calc') })), buy_status)));
  root.push(h('section', { class: 'card', id: 'v0-result', 'aria-live': 'polite', 'aria-labelledby': 'v0-result-title' }, h('h3', { id: 'v0-result-title', text: tr(lang, 'v0.s_result') }), ...result_nodes(page)));

  // файл состояния
  const file_in = h('input', { id: 'v0-file-in', type: 'file', accept: 'application/json,.json', 'aria-describedby': 'v0-file-hint' });
  file_in.addEventListener('change', () => open_file(page, file_in.files?.[0]));
  root.push(h('section', { class: 'card', 'aria-labelledby': 'v0-file-title' }, h('h3', { id: 'v0-file-title', text: tr(lang, 'v0.s_file') }),
    h('p', { id: 'v0-file-hint', class: 'muted', text: tr(lang, 'v0.file_hint') }),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn', id: 'v0-save', onclick: () => save_file(page), text: tr(lang, 'v0.save') }),
      h('label', { class: 'file', for: 'v0-file-in', text: tr(lang, 'v0.open') }), file_in)));
  root.push(h('p', { class: 'muted', text: tr(lang, 'v0.disclaimer') }));
  main.replaceChildren(...root);
  el('v0-lang-ru')?.setAttribute('aria-pressed', String(lang === 'ru'));
  el('v0-lang-en')?.setAttribute('aria-pressed', String(lang === 'en'));
  document.documentElement.lang = lang;
  document.title = tr(lang, 'v0.doc_title');
}

/** Число в поле ввода: десятичный знак по языку, без групп тысяч, без нулевой дроби. */
function format_input(minor, cur, lang, nf) {
  const exp = currency_exponent(cur);
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const s = String(abs).padStart(exp + 1, '0');
  const int_part = exp === 0 ? s : s.slice(0, s.length - exp);
  const frac = exp === 0 ? '' : s.slice(s.length - exp);
  const sep = nf === undefined || nf === null ? (lang === 'ru' ? ',' : '.') : resolve_number_format(lang, nf).decimal; // десятичный знак — по формату чисел пользователя (REQ-112, FP-16)
  const num = /^0+$/.test(frac) ? int_part : int_part + sep + frac;
  return (neg ? '-' : '') + num;
}

function save_file(page) {
  const built = page.foreign !== null ? { ok: true, ws: page.foreign } : form_to_ws(page.form);
  if (!built.ok) { page.notice = error_text(page.lang, built.error); render_page(page); return; }
  try {
    download('runway-v0.json', state_text(built.ws));
    page.notice = tr(page.lang, 'v0.saved');
  } catch { page.notice = tr(page.lang, 'v0.save_failed'); }
  render_page(page);
}

/**
 * Открыть файл состояния. Исключений наружу нет: что бы ни было в файле, страница остаётся рабочей. Состояние страницы меняется до отрисовки, но если
 * отрисовка бросила, прежнее состояние возвращается и показывается отказ.
 */
async function open_file(page, file) {
  if (file === undefined || file === null) return;
  try {
    await open_file_unsafe(page, file);
  } catch {
    page.notice = tr(page.lang, 'v0.open_bad');
    try { render_page(page); } catch { /* прежнее состояние рисуется при следующем действии */ }
  }
}

async function open_file_unsafe(page, file) {
  if (file.size > MAX_FILE_BYTES) { page.notice = tr(page.lang, 'v0.open_big'); render_page(page); return; }
  let text;
  try { text = await file.text(); } catch { page.notice = tr(page.lang, 'v0.open_bad'); render_page(page); return; }
  let r;
  try { r = read_state(text, file.size); } catch { r = { ok: false, reason: 'bad_shape' }; }
  if (!r.ok) {
    page.notice = r.reason === 'limits'
      ? tr(page.lang, 'v0.open_limits', { pay: r.limits.counts.payments, inc: r.limits.counts.incomes, res: r.limits.counts.reserves, max_pay: V0_LIMITS.payments, max_inc: V0_LIMITS.incomes, max_res: V0_LIMITS.reserves })
      : tr(page.lang, r.reason === 'too_big' ? 'v0.open_big' : 'v0.open_bad');
    render_page(page);
    return;
  }
  const before = { form: page.form, foreign: page.foreign, purchase: page.purchase, notice: page.notice };
  if (r.kind === 'v0') { page.form = r.form; page.foreign = null; page.purchase = null; page.notice = tr(page.lang, 'v0.opened'); } else { page.foreign = r.ws; page.purchase = null; page.notice = tr(page.lang, 'v0.opened_foreign'); }
  try {
    render_page(page);
  } catch {
    Object.assign(page, before, { notice: tr(page.lang, 'v0.open_bad') });
    render_page(page);
  }
}

/**
 * «Сегодня» — местная календарная дата порта часов (`ids.local_today`). По умолчанию порт — часы устройства (`ids.clock_ports`):
 * это единственное место, где страница читает часы. Порт без `tz_offset_min` дополняется смещением устройства (FP-50, D-4): иначе
 * `local_today` дал бы UTC-дату (контракт `local_today` без смещения — UTC, закреплён тестом as_of). Тесты подставляют свой порт (FP-50, RISK-22).
 */
function today_iso(ports = clock_ports()) {
  const device = clock_ports();
  return local_today({ now_ms: ports.now_ms, tz_offset_min: typeof ports.tz_offset_min === 'function' ? ports.tz_offset_min : device.tz_offset_min });
}

/**
 * Запуск страницы v0 (вызывается из v0.html): язык по языку браузера, переключатель RU/EN, первая отрисовка.
 * @param {{now_ms: () => number, tz_offset_min?: () => number}} [ports] часы страницы; без аргумента или без `tz_offset_min` — часы устройства
 *   (смещение пояса устройства; дата — местная).
 */
export function boot_v0(ports = clock_ports()) {
  const lang = typeof navigator !== 'undefined' && /^en/i.test(navigator.language ?? '') ? 'en' : 'ru';
  const page = make_page(lang, today_iso(ports));
  page.changed = (notice) => { page.notice = typeof notice === 'string' ? notice : ''; render_page(page); };
  for (const l of ['ru', 'en']) el('v0-lang-' + l)?.addEventListener('click', () => { page.lang = l; page.notice = ''; render_page(page); });
  render_page(page);
  return page;
}

if (typeof document !== 'undefined' && document.getElementById('v0-title-bar') !== null) boot_v0();

