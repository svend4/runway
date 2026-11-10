// entry.mjs — быстрый ввод факта «+» (FP-04, REQ-090, REQ-063, IDEA-02, IDEA-38).
//
// Шторка «+»: сумма → Enter. Счёт по умолчанию — последний использованный, дата — `as_of`, вид — расход (знак «−» впереди — расход, «+» — приход;
// вид «Перевод» — две ноги с общим `transfer_id`). Поле суммы читается по формату чисел РАБОЧЕЙ ОБЛАСТИ (`number_format`: «ru» → 12,50,
// «en» → 12.50), а не по языку интерфейса (REQ-112): набор данных с форматом «en» принимает «1,234.50» и при русском интерфейсе.
// Запись идёт через `ws_edit.apply_edit` и общий путь `ctx.set_ws` (пересчёт → журнал → показ): отказ — код канона (`E_NOT_INTEGER`, `E_FUTURE_POSTED`…)
// и текст на странице, данные не меняются. Для перевода на неоперационный счёт при резерве без привязки перед записью показывается предупреждение
// о двойном вычитании (`engine/transfer_guard.mjs`, REQ-063): записать и уменьшить резерв / записать без изменения / назад.
//
// Файл делится на две части: чистые модели (без DOM; их проверяет tests/entry.test.mjs) и построители DOM в конце. Расчёт по введённым данным
// и правилам, не консультация.

import { NUMBER_FORMATS, parse_minor, format_minor, currency_exponent } from '../engine/index.mjs';
import { render_value } from '../engine/verifier.mjs';
import { check_transfer, pending_transfers, declined_transfers, decline_record } from '../engine/transfer_guard.mjs';
import { apply_edit } from './ws_edit.mjs';
import { make_nf_fmt } from './number_format.mjs';
import { label_of } from './i18n.mjs';
import { h, open_dialog, close_dialog, announce } from './dom.mjs';
import { UNDO_RECORDED } from './undo.mjs';

const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const list = (ws, key) => (Array.isArray(ws?.[key]) ? ws[key] : []);

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 1. Формат чисел и разбор суммы
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

const SIGN_CHARS = '+-−';

/** Допустимые знаки формата — как в настройке формата (канон §3.1, REQ-112): десятичный «,» или «.», тысячи — пусто, пробел, «,» или «.». */
const DECIMALS = [',', '.'];
const THOUSANDS = ['', ' ', ',', '.'];

function format_of(x) {
  if (typeof x === 'string' && Object.hasOwn(NUMBER_FORMATS, x)) return NUMBER_FORMATS[x];
  if (is_obj(x) && DECIMALS.includes(x.decimal) && THOUSANDS.includes(x.thousands) && x.thousands !== x.decimal) return { decimal: x.decimal, thousands: x.thousands };
  return null;
}

/**
 * Формат чисел для ввода: настройка рабочей области (`ws.number_format = {decimal, thousands, date?}` по канону §3.1; допустимы и имя пресета «ru»/«en», и то же в `ws.params.number_format`),
 * иначе пресет языка интерфейса. Язык интерфейса настройку НЕ перебивает.
 * @param {object} ws
 * @param {'ru'|'en'} lang
 * @returns {{decimal: string, thousands: string, source: 'workspace'|'language'}}
 */
export function resolve_number_format(ws, lang) {
  for (const x of [ws?.number_format, ws?.params?.number_format]) {
    const f = format_of(x);
    if (f !== null) return { decimal: f.decimal, thousands: f.thousands, source: 'workspace' };
  }
  const f = NUMBER_FORMATS[lang] ?? NUMBER_FORMATS.ru;
  return { decimal: f.decimal, thousands: f.thousands, source: 'language' };
}

/** Число знаков дроби счёта (поле счёта, иначе по валюте). */
export function account_exponent(acc) {
  return Number.isInteger(acc?.exponent) ? acc.exponent : currency_exponent(acc.currency);
}

/**
 * Разобрать сумму из поля ввода по формату `fmt` (без float, группы тысяч — по правилам формата).
 * Знак впереди необязателен: «−»/«-» → −1, «+» → +1, нет знака → 0 (вид решает форма). Ноль отвергается, если не `allow_zero`.
 * @param {string} text
 * @param {{decimal: string, thousands: string}} fmt
 * @param {number} exponent знаков дроби счёта
 * @param {{allow_zero?: boolean}} [opts]
 * @returns {{ok: true, sign: -1|0|1, abs_minor: number} | {ok: false, code: string, reason: string}}
 */
export function parse_entry_amount(text, fmt, exponent, opts = {}) {
  if (typeof text !== 'string') return { ok: false, code: 'E_NOT_INTEGER', reason: 'not_a_string' };
  let s = text.trim();
  if (s === '') return { ok: false, code: 'E_NOT_INTEGER', reason: 'empty' };
  let sign = 0;
  if (SIGN_CHARS.includes(s[0])) { sign = s[0] === '+' ? 1 : -1; s = s.slice(1).trim(); }
  if (s === '' || SIGN_CHARS.includes(s[0])) return { ok: false, code: 'E_NOT_INTEGER', reason: s === '' ? 'empty' : 'double_sign' };
  let v;
  try {
    v = parse_minor(s, { decimal: fmt.decimal, thousands: fmt.thousands, exponent });
  } catch (e) {
    const code = typeof e?.code === 'string' ? e.code : 'E_NOT_INTEGER';
    return { ok: false, code: code === 'E_OVERFLOW' ? 'E_OVERFLOW' : 'E_NOT_INTEGER', reason: String(e?.ctx?.reason ?? 'bad_amount') };
  }
  if (v === 0 && opts.allow_zero !== true) return { ok: false, code: 'E_SCHEMA', reason: 'zero' };
  return { ok: true, sign, abs_minor: v };
}

/** Пример суммы в формате ввода: «1 234,50» / «1,234.50» (для подсказки и сообщения об ошибке). */
export function example_amount(fmt, exponent = 2) {
  return format_minor(123450, exponent, { decimal: fmt.decimal, thousands: fmt.thousands });
}

/**
 * Деньги с валютой по правилам языка интерфейса («−12,50 €», «€12.50»); с `nf` (`ws.number_format`, REQ-112, FP-16) — в формате чисел пользователя («1.234,50 €»).
 * Без `nf` результат прежний.
 */
export function money_text(lang, minor, currency, as_of, nf) {
  if (nf === undefined || nf === null) return render_value({ kind: 'money', v: minor, cur: currency, dp: currency_exponent(currency) }, lang, as_of ?? null);
  return make_nf_fmt(lang, currency, as_of ?? '0000-01-01', nf).money(minor);
}

/** Дата `YYYY-MM-DD` словами по правилам языка («4 октября», «October 4»); с `nf` — в стиле дат пользователя (`number_format.date`, REQ-112, FP-16). */
export function date_text(lang, iso, as_of, nf) {
  return render_value({ kind: 'date', v: iso }, lang, as_of ?? null, nf ?? null);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 2. Счета и память «последнего счёта»
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** Счета, на которые можно записать факт: не закрытые на `as_of`. */
export function entry_accounts(ws) {
  const as_of = typeof ws?.as_of === 'string' ? ws.as_of : '';
  return list(ws, 'accounts').filter((a) => is_obj(a) && typeof a.account_id === 'string' && (typeof a.closed_on !== 'string' || a.closed_on > as_of));
}

/** Название счёта для людей: подпись из словаря данных, иначе имя из рабочей области, иначе идентификатор. */
export function account_name(ws, account_id, lang) {
  const a = list(ws, 'accounts').find((x) => x?.account_id === account_id);
  return label_of(lang, account_id, typeof a?.name === 'string' && a.name !== '' ? a.name : String(account_id));
}

/**
 * Счёт по умолчанию: запомненный (если он ещё открыт), иначе счёт самого позднего факта, иначе первый operating, иначе первый открытый.
 * @param {object} ws
 * @param {string|null} [remembered]
 * @returns {string|null}
 */
export function default_account_id(ws, remembered = null) {
  const open = entry_accounts(ws);
  const ids = open.map((a) => a.account_id);
  if (remembered !== null && ids.includes(remembered)) return remembered;
  let last = null;
  for (const f of list(ws, 'facts')) if (is_obj(f) && ids.includes(f.account_id) && (last === null || String(f.date) >= String(last.date))) last = f;
  if (last !== null) return last.account_id;
  return (open.find((a) => a.liquidity === 'operating') ?? open[0])?.account_id ?? null;
}

/** Счёт-получатель перевода по умолчанию: другой открытый счёт той же валюты, неоперационный — в первую очередь. */
export function default_transfer_target(ws, from_id) {
  const from = list(ws, 'accounts').find((a) => a?.account_id === from_id);
  if (from === undefined) return null;
  const pool = entry_accounts(ws).filter((a) => a.account_id !== from_id && a.currency === from.currency);
  return (pool.find((a) => a.liquidity !== 'operating') ?? pool[0])?.account_id ?? null;
}

/** Память последнего использованного счёта по рабочей области (в пределах страницы; на диск ничего не пишется). */
export function create_entry_memory() {
  const by_ws = new Map();
  const key = (ws) => String(ws?.workspace_id ?? '');
  return {
    get: (ws) => by_ws.get(key(ws)) ?? null,
    remember(ws, account_id) { if (typeof account_id === 'string') by_ws.set(key(ws), account_id); },
    forget() { by_ws.clear(); },
  };
}

/** Дата последнего якоря счёта (ISO) или `null`. */
export function last_anchor_date(ws, account_id) {
  let best = null;
  for (const a of list(ws, 'anchors')) if (a?.account_id === account_id && typeof a.date === 'string' && (best === null || a.date > best)) best = a.date;
  return best;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 3. Правка из формы
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

const fail_with = (code, field, reason, extra) => ({ ok: false, error: { code, ctx: { field, reason, ...extra } } });

/**
 * Собрать правку `add_fact` из полей формы.
 * @param {object} ws
 * @param {{kind: 'expense'|'income'|'transfer', amount_text: string, account_id: string, to_account_id?: string, date?: string}} form
 * @param {{lang?: 'ru'|'en', new_id: (prefix: string) => string}} env
 * @returns {{ok: true, edit: object, info: object} | {ok: false, error: {code: string, ctx: object}}}
 *   `info` — `{kind, account_id, to_account_id?, transfer_id?, amount_minor (знаковая), abs_minor, currency, date}`
 */
export function build_entry_edit(ws, form, env) {
  if (!is_obj(form)) return fail_with('E_SCHEMA', 'form', 'not_object');
  const acc = list(ws, 'accounts').find((a) => a?.account_id === form.account_id);
  if (acc === undefined) return fail_with('E_SCHEMA', 'account_id', 'unknown_account');
  const fmt = resolve_number_format(ws, env?.lang ?? 'ru');
  const p = parse_entry_amount(form.amount_text, fmt, account_exponent(acc));
  if (!p.ok) return fail_with(p.code, 'amount', p.reason);
  const date = typeof form.date === 'string' && form.date.trim() !== '' ? form.date.trim() : ws.as_of;
  const kind = form.kind === 'income' || form.kind === 'transfer' ? form.kind : 'expense';
  if (kind === 'transfer') {
    const to = list(ws, 'accounts').find((a) => a?.account_id === form.to_account_id);
    if (to === undefined) return fail_with('E_SCHEMA', 'to_account_id', 'unknown_account');
    if (to.account_id === acc.account_id) return fail_with('E_SCHEMA', 'to_account_id', 'transfer_same_account');
    if (to.currency !== acc.currency) return fail_with('E_CURRENCY_MISMATCH', 'to_account_id', 'transfer_currencies_differ');
    const transfer_id = env.new_id('trf');
    const edit = {
      type: 'add_fact',
      transfer_id,
      legs: [{ account_id: acc.account_id, date, amount_minor: -p.abs_minor }, { account_id: to.account_id, date, amount_minor: p.abs_minor }],
    };
    return { ok: true, edit, info: { kind, account_id: acc.account_id, to_account_id: to.account_id, transfer_id, amount_minor: -p.abs_minor, abs_minor: p.abs_minor, currency: acc.currency, date } };
  }
  const sign = p.sign !== 0 ? p.sign : (kind === 'income' ? 1 : -1);
  const amount_minor = sign * p.abs_minor;
  return {
    ok: true,
    edit: { type: 'add_fact', fact: { account_id: acc.account_id, date, amount_minor } },
    info: { kind: sign > 0 ? 'income' : 'expense', account_id: acc.account_id, amount_minor, abs_minor: p.abs_minor, currency: acc.currency, date },
  };
}

/**
 * Подготовить запись, ничего не меняя: правка к копии, предупреждение о двойном вычитании для перевода, заметки.
 * @param {object} ws
 * @param {object} form см. `build_entry_edit`
 * @param {{lang?: 'ru'|'en', new_id: (prefix: string) => string, declined?: Iterable<string>}} env
 * @returns {{ok: true, base_ws: object, ws_after: object, edit: object, form: object, info: object, notes: string[], guard: object|null, meta: object}
 *   | {ok: false, error: {code: string, ctx: object|null}}}
 *   `notes`: `covered_by_anchor` — дата не позже последнего якоря счёта (остаток не изменится)
 */
export function prepare_entry(ws, form, env) {
  const built = build_entry_edit(ws, form, env);
  if (!built.ok) return built;
  const r = apply_edit(ws, built.edit, { new_id: env.new_id });
  if (!r.ok) return r;
  const info = built.info;
  const notes = [];
  const anchor = last_anchor_date(ws, info.account_id);
  if (anchor !== null && info.date <= anchor) notes.push('covered_by_anchor');
  let guard = null;
  if (info.kind === 'transfer') {
    try {
      guard = check_transfer(r.ws, {
        transfer_id: info.transfer_id, from_account_id: info.account_id, to_account_id: info.to_account_id, amount_minor: info.abs_minor, date: info.date,
      }, { declined: env.declined });
    } catch { guard = null; }
  }
  return { ok: true, base_ws: ws, ws_after: r.ws, edit: built.edit, form, info, notes, guard, meta: { kind: info.kind, amount_minor: info.abs_minor, currency: info.currency } };
}

/** Применить аллокации предложения последовательно через `apply_edit` (каждая проверяется; отказ любой — отказ всей записи). */
function with_allocations(ws, allocations, new_id) {
  let cur = ws;
  for (const allocation of allocations) {
    const r = apply_edit(cur, { type: 'record_allocation', allocation }, { new_id });
    if (!r.ok) return r;
    cur = r.ws;
  }
  return { ok: true, ws: cur };
}

/**
 * Хранилище отказов пользователя по запросу о двойном вычитании: память страницы плюс запись в журнале (`draft.proposed`, `state.extra`).
 * @param {object} ctx контекст расширений
 */
export function create_decline_store(ctx) {
  const memory = new Set();
  const from_journal = () => {
    try {
      const j = ctx.journal;
      return j === null || j === undefined ? new Set() : declined_transfers(j.state().state.extra);
    } catch { return new Set(); }
  };
  const store = {
    /** Все переводы, по которым пользователь отказался. */
    all: () => new Set([...memory, ...from_journal()]),
    /** Запомнить отказ в памяти страницы (до записи перевода: перерисовка внутри записи уже не покажет запрос). */
    hold(transfer_id) { memory.add(transfer_id); },
    /** Снять отказ из памяти (запись перевода не удалась). */
    release(transfer_id) { memory.delete(transfer_id); },
    /** Записать отказ в журнал (после успешной записи перевода). */
    persist(transfer_id) {
      try {
        const { entity_id, payload } = decline_record(transfer_id);
        ctx.journal?.append('draft.proposed', payload, { entity_id });
      } catch { /* журнал недоступен: отказ остаётся в памяти страницы */ }
    },
    /** Отказ целиком: память и журнал. */
    add(transfer_id) { store.hold(transfer_id); store.persist(transfer_id); },
    clear() { memory.clear(); },
  };
  return store;
}

/**
 * Записать подготовленный факт. Для перевода с предупреждением нужен выбор: `reduce` (записать и уменьшить резерв) или `keep` (записать без
 * изменения резерва; отказ запоминается, запрос не повторяется). Правка и аллокации идут ОДНИМ пересчётом — это одно действие для «Отменить».
 * @param {object} ctx
 * @param {ReturnType<typeof prepare_entry> & {ok: true}} prepared
 * @param {'reduce'|'keep'|undefined} choice
 * @param {{undo?: object, memory?: object, declines?: ReturnType<typeof create_decline_store>, lang?: 'ru'|'en'}} [deps]
 * @returns {{ok: true, ws: object, prepared: object} | {ok: false, error: {code: string, ctx: object|null}}}
 */
export function commit_entry(ctx, prepared, choice, deps = {}) {
  let p = prepared;
  const before = ctx.get_ws();
  if (before === null || before === undefined) return fail_with('E_SCHEMA', 'workspace', 'no_workspace');
  if (p.base_ws !== before) { // данные изменились, пока шторка была открыта: подготовить заново
    p = prepare_entry(before, p.form, { lang: deps.lang ?? ctx.lang(), new_id: ctx.new_id, declined: deps.declines?.all() });
    if (!p.ok) return p;
  }
  let ws_final = p.ws_after;
  let meta = p.meta;
  const warn = p.guard !== null && p.guard.warn === true;
  if (warn) {
    if (choice !== 'reduce' && choice !== 'keep') return fail_with('E_SCHEMA', 'choice', 'guard_choice_required');
    if (choice === 'reduce') {
      const r = with_allocations(ws_final, p.guard.allocations, ctx.new_id);
      if (!r.ok) return r;
      ws_final = r.ws;
      meta = { ...meta, reduced_minor: p.guard.reduce_total_minor };
    }
  }
  // стопка отмены и отказ обновляются ДО записи: страница перерисовывается внутри `ctx.set_ws` и должна уже видеть новое состояние
  const rec = deps.undo?.record(before, ws_final, meta);
  const keep = warn && choice === 'keep';
  if (keep) deps.declines?.hold(p.info.transfer_id);
  const s = ctx.set_ws(ws_final, { reason: 'add_fact', undo: rec ? UNDO_RECORDED : undefined }); // «уже записано»: общий подписчик стопки второй раз не пишет
  if (!s.ok) {
    if (rec) rec.rollback();
    if (keep) deps.declines?.release(p.info.transfer_id);
    return { ok: false, error: s.error };
  }
  if (keep) deps.declines?.persist(p.info.transfer_id);
  deps.memory?.remember(ws_final, p.info.account_id);
  return { ok: true, ws: ws_final, prepared: p };
}

/**
 * Ответ на запрос о переводе, который уже есть в данных (из файла или введённый раньше): уменьшить резерв или оставить как есть.
 * @param {object} ctx
 * @param {{transfer_id: string, allocations: object[], reduce_total_minor: number, currency: string}} check элемент `pending_transfers`
 * @param {'reduce'|'keep'} choice
 * @param {{undo?: object, declines?: ReturnType<typeof create_decline_store>}} [deps]
 */
export function resolve_pending(ctx, check, choice, deps = {}) {
  if (choice === 'keep') { deps.declines?.add(check.transfer_id); return { ok: true, ws: ctx.get_ws() }; }
  const before = ctx.get_ws();
  if (before === null || before === undefined) return fail_with('E_SCHEMA', 'workspace', 'no_workspace');
  const r = with_allocations(before, check.allocations, ctx.new_id);
  if (!r.ok) return r;
  const rec = deps.undo?.record(before, r.ws, { kind: 'reserve_cut', amount_minor: check.reduce_total_minor, currency: check.currency });
  const s = ctx.set_ws(r.ws, { reason: 'record_allocation', undo: rec ? UNDO_RECORDED : undefined });
  if (!s.ok) {
    if (rec) rec.rollback();
    return { ok: false, error: s.error };
  }
  return { ok: true, ws: r.ws };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 4. Тексты ошибок
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Текст отказа для человека: код канона → строка пакета; для суммы — с примером в формате ввода.
 * @param {object} ctx контекст расширений
 * @param {{code: string, ctx: object|null}} error
 * @param {{example?: string, as_of?: string}} [info]
 */
export function error_text(ctx, error, info = {}) {
  const reason = error?.ctx?.reason;
  if (reason === 'read_only') return ctx.tr('ro.refused'); // режим «только чтение» (FP-17): называем причину, а не винить введённое
  const params = { example: info.example ?? '', date: info.as_of ?? '' };
  if (reason === 'zero') return ctx.tr('entry.err_zero', params);
  if (reason === 'transfer_same_account') return ctx.tr('entry.err_same_account', params);
  if (reason === 'transfer_currencies_differ') return ctx.tr('entry.err_currency_mismatch', params);
  if (reason === 'guard_choice_required') return ctx.tr('entry.err_other', params);
  switch (error?.code) {
    case 'E_NOT_INTEGER': return ctx.tr('entry.err_not_integer', params);
    case 'E_OVERFLOW': return ctx.tr('entry.err_overflow', params);
    case 'E_FUTURE_POSTED': return ctx.tr('entry.err_future_posted', params);
    case 'E_BAD_DATE': return ctx.tr('entry.err_bad_date', params);
    case 'E_CURRENCY_MISMATCH': return ctx.tr('entry.err_currency_mismatch', params);
    case 'E_NO_RATE': return ctx.tr('entry.err_no_rate', params);
    case 'E_SCHEMA': return ctx.tr('entry.err_schema', params);
    default: return ctx.tr('entry.err_other', params);
  }
}

/** Текст сообщения «добавлено» с заметками (дата не позже якоря). */
export function added_text(ctx, ws_after, prepared) {
  const lang = ctx.lang();
  const i = prepared.info;
  const as_of = ws_after.as_of;
  const nf = ws_after.number_format;
  const p = { amount: money_text(lang, i.abs_minor, i.currency, as_of, nf), account: account_name(ws_after, i.account_id, lang), date: date_text(lang, i.date, as_of, nf) };
  let text;
  if (i.kind === 'transfer') text = ctx.tr('entry.added_transfer', { ...p, to: account_name(ws_after, i.to_account_id, lang) });
  else text = ctx.tr(i.kind === 'income' ? 'entry.added_income' : 'entry.added_expense', p);
  if (prepared.notes.includes('covered_by_anchor')) text += ' ' + ctx.tr('entry.note_covered');
  return text;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 5. DOM: шторка «+», кнопка в навигации, карточка запросов о двойном вычитании
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

const KINDS = ['expense', 'income', 'transfer'];

/** Кнопка «+» для слота `nav.actions`. */
export function render_nav_add(ctx, open) {
  return h('button', { type: 'button', class: 'btn primary nav-plus', 'aria-label': ctx.tr('entry.nav_add_label'), onclick: open, text: ctx.tr('entry.nav_add') });
}

function guard_node(ctx, ws, prepared, handlers) {
  const lang = ctx.lang();
  const g = prepared.guard;
  const as_of = ws.as_of;
  const reserve_name = (id) => label_of(lang, id, String(list(ws, 'reserves').find((r) => r?.reserve_id === id)?.name ?? id));
  const lines = g.candidates.filter((c) => c.reduce_minor > 0).map((c) => h('li', {
    text: ctx.tr('entry.guard_line', { reserve: reserve_name(c.reserve_id), funded: money_text(lang, c.funded_minor, g.currency, as_of, ws.number_format), reduce: money_text(lang, c.reduce_minor, g.currency, as_of, ws.number_format) }),
  }));
  return h('div', { class: 'banner tight guard-box', role: 'alert', 'data-guard': '1' },
    h('h3', { text: ctx.tr('entry.guard_title') }),
    h('p', { text: ctx.tr('entry.guard_text', { amount: money_text(lang, g.amount_minor, g.currency, as_of, ws.number_format), to: account_name(ws, g.to_account_id, lang) }) }),
    h('ul', null, lines),
    g.uncovered_minor > 0 ? h('p', { text: ctx.tr('entry.guard_uncovered', { rest: money_text(lang, g.uncovered_minor, g.currency, as_of, ws.number_format) }) }) : null,
    h('p', { class: 'muted', text: ctx.tr('entry.guard_note') }),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn primary', onclick: handlers.reduce, text: ctx.tr('entry.guard_reduce', { sum: money_text(lang, g.reduce_total_minor, g.currency, as_of, ws.number_format) }) }),
      h('button', { type: 'button', class: 'btn', onclick: handlers.keep, text: ctx.tr('entry.guard_keep') }),
      h('button', { type: 'button', class: 'btn', onclick: handlers.back, text: ctx.tr('entry.guard_back') })));
}

/**
 * Открыть шторку «+» в общем диалоге страницы.
 * @param {object} ctx
 * @param {{undo?: object, memory?: object, declines?: ReturnType<typeof create_decline_store>}} deps
 * @param {{kind?: 'expense'|'income'|'transfer'}} [opts]
 * @returns {{amount: HTMLElement}|null} элементы шторки (для тестов и фокуса)
 */
export function open_entry_dialog(ctx, deps, opts = {}) {
  const ws = ctx.get_ws();
  if (ws === null || ws === undefined) { ctx.notify(ctx.tr('entry.no_data'), 'error'); return null; }
  const accounts = entry_accounts(ws);
  if (accounts.length === 0) { ctx.notify(ctx.tr('entry.no_accounts'), 'error'); return null; }
  void ctx.journal; // журнал создаётся заранее, чтобы он видел правку и отмену
  const lang = ctx.lang();
  const fmt = resolve_number_format(ws, lang);
  const first_id = default_account_id(ws, deps.memory?.get(ws) ?? null);
  const acc0 = accounts.find((a) => a.account_id === first_id) ?? accounts[0];
  const example = example_amount(fmt, account_exponent(acc0));
  const as_of = ws.as_of;
  let kind = KINDS.includes(opts.kind) ? opts.kind : 'expense';

  const amount = h('input', { type: 'text', id: 'entry-amount', inputmode: 'decimal', autocomplete: 'off', enterkeyhint: 'done', 'aria-describedby': 'entry-hint' });
  amount.value = '';
  const acc_opt = (a, sel) => h('option', { value: a.account_id, selected: a.account_id === sel ? true : null, text: account_name(ws, a.account_id, lang) + ' · ' + a.currency });
  const account = h('select', { id: 'entry-account' }, accounts.map((a) => acc_opt(a, acc0.account_id)));
  account.value = acc0.account_id;
  const to_id0 = default_transfer_target(ws, acc0.account_id);
  const to = h('select', { id: 'entry-to' }, accounts.map((a) => acc_opt(a, to_id0)));
  if (to_id0 !== null) to.value = to_id0;
  const date = h('input', { type: 'date', id: 'entry-date', max: as_of });
  date.value = as_of;
  const error = h('p', { class: 'error', id: 'entry-error', role: 'alert' });
  const guard_box = h('div', { id: 'entry-guard' });
  const to_row = h('div', { class: 'field', hidden: kind === 'transfer' ? null : true }, h('label', { for: 'entry-to', text: ctx.tr('entry.f_to') }), to);
  const from_label = h('label', { for: 'entry-account', text: ctx.tr(kind === 'transfer' ? 'entry.f_from' : 'entry.f_account') });

  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': ctx.tr('entry.f_kind') });
  const seg_btn = new Map();
  const set_kind = (k) => {
    kind = k;
    for (const [id, b] of seg_btn) b.setAttribute('aria-pressed', id === k ? 'true' : 'false');
    if (k === 'transfer') to_row.removeAttribute('hidden'); else to_row.setAttribute('hidden', '');
    from_label.textContent = ctx.tr(k === 'transfer' ? 'entry.f_from' : 'entry.f_account');
    guard_box.replaceChildren();
  };
  for (const [k, key] of [['expense', 'entry.kind_expense'], ['income', 'entry.kind_income'], ['transfer', 'entry.kind_transfer']]) {
    const b = h('button', { type: 'button', 'aria-pressed': k === kind ? 'true' : 'false', onclick: () => set_kind(k), text: ctx.tr(key) });
    seg_btn.set(k, b);
    seg.append(b);
  }

  const read_form = () => ({ kind, amount_text: amount.value, account_id: account.value, to_account_id: to.value, date: date.value });
  const env = () => ({ lang: ctx.lang(), new_id: ctx.new_id, declined: deps.declines?.all() });

  const show_error = (err) => {
    const cur = ctx.get_ws();
    const f = resolve_number_format(cur, ctx.lang());
    const acc = list(cur, 'accounts').find((a) => a?.account_id === account.value);
    error.textContent = error_text(ctx, err, { example: example_amount(f, acc === undefined ? 2 : account_exponent(acc)), as_of: date_text(ctx.lang(), cur.as_of, cur.as_of, cur.number_format) });
    announce(error.textContent);
  };

  const finish = (choice) => {
    error.textContent = '';
    const cur = ctx.get_ws();
    const p = prepare_entry(cur, read_form(), env());
    if (!p.ok) { show_error(p.error); amount.focus(); return; }
    if (p.guard !== null && p.guard.warn === true && choice === undefined) {
      guard_box.replaceChildren(guard_node(ctx, p.ws_after, p, {
        reduce: () => finish('reduce'), keep: () => finish('keep'), back: () => { guard_box.replaceChildren(); amount.focus(); },
      }));
      return;
    }
    const r = commit_entry(ctx, p, choice, deps);
    if (!r.ok) { show_error(r.error); amount.focus(); return; }
    close_dialog();
    ctx.notify(added_text(ctx, r.ws, r.prepared), 'info');
  };

  const form = h('form', { class: 'entry-form', novalidate: true, onsubmit: (ev) => { ev.preventDefault(); finish(undefined); } },
    h('div', { class: 'field' }, h('label', { for: 'entry-amount', text: ctx.tr('entry.f_amount') }), seg, amount,
      h('p', { class: 'muted', id: 'entry-hint', text: ctx.tr('entry.hint', { example }) })),
    error,
    guard_box,
    h('details', { class: 'entry-more' },
      h('summary', { text: ctx.tr('entry.more') }),
      h('div', { class: 'field' }, from_label, account),
      to_row,
      h('div', { class: 'field' }, h('label', { for: 'entry-date', text: ctx.tr('entry.f_date') }), date,
        h('p', { class: 'muted', text: ctx.tr('entry.date_hint', { date: date_text(lang, as_of, as_of, ws.number_format) }) }))),
    h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'btn primary', text: ctx.tr('entry.submit') })));

  open_dialog(ctx.tr('entry.title'), ctx.tr('entry.close'), form);
  amount.focus();
  return { amount, account, to, date, error, guard_box, form, set_kind };
}

/**
 * Карточка «перевод ждёт ответа»: переводы, у которых резерв не уменьшен и отказа нет. Нет таких — `null` (блок слота пропускается).
 * @param {object} ctx
 * @param {{undo?: object, declines?: ReturnType<typeof create_decline_store>}} deps
 */
export function render_pending_card(ctx, deps) {
  const ws = ctx.get_ws();
  if (ws === null || ws === undefined) return null;
  const pending = pending_transfers(ws, { declined: deps.declines?.all() });
  if (pending.length === 0) return null;
  const lang = ctx.lang();
  const act = (check, choice) => () => {
    const r = resolve_pending(ctx, check, choice, deps);
    if (!r.ok) { ctx.notify(error_text(ctx, r.error), 'error'); return; }
    if (choice === 'keep') ctx.notify(ctx.tr('entry.pend_done_keep'), 'info');
    else ctx.notify(ctx.tr('entry.pend_done_reduce', { sum: money_text(lang, check.reduce_total_minor, check.currency, ws.as_of, ws.number_format) }), 'info');
    if (choice === 'keep') ctx.set_ws(ctx.get_ws(), { reason: 'guard_answer' }); // отказ данных не меняет: страница перерисовывается, карточка уходит
  };
  return h('section', { class: 'card pending-guard', 'aria-label': ctx.tr('entry.pend_title') },
    h('h3', { text: ctx.tr('entry.pend_title') }),
    pending.map((c) => h('div', { class: 'banner tight', role: 'status' },
      h('p', { text: ctx.tr('entry.pend_text', {
        amount: money_text(lang, c.amount_minor, c.currency, ws.as_of, ws.number_format), to: account_name(ws, c.to_account_id, lang), date: date_text(lang, c.date, ws.as_of, ws.number_format),
      }) }),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn primary', onclick: act(c, 'reduce'), text: ctx.tr('entry.pend_reduce', { sum: money_text(lang, c.reduce_total_minor, c.currency, ws.as_of, ws.number_format) }) }),
        h('button', { type: 'button', class: 'btn', onclick: act(c, 'keep'), text: ctx.tr('entry.pend_keep') })))));
}
