// reserve_release.mjs — «Освободить остаток» резерва после срока и карточки резервов на экране «Резервы» (FP-15, REQ-062, ALG-05, C-059).
//
// Остаток резерва после платежа в срок не освобождается сам: движок показывает `W_RESERVE_RESIDUAL` (платёж был, остаток остался) или `W_RESERVE_OVERDUE`
// (срок прошёл, привязанного платежа нет), а освобождает только пользователь — ручной записью `Allocation` со знаком минус, `source = manual`.
// Здесь это действие: чистая правка `release_residual_edit` (вид `record_allocation` из словаря `ws_edit`, отдельного вида правки не нужно), модель `reserve_flags`
// (какие резервы под предупреждением, сколько в них осталось и какие платежи были) и узлы — кнопка в плашке предупреждения в шапке (слот `banner.warning`)
// и карточка каждого резерва (слот `reserves.sections`): сколько сейчас, предупреждение с суммой и объяснением, «Освободить остаток», «Как посчитано».
// Запись — только общим путём `ctx.edit` (проверка → копия → пересчёт страницей → журнал → «Отменить»: одна запись — одна единица стопки, подпись «уменьшение резерва на …»).
// Число считает движок (`reserve_open`); модуль ничего не округляет и не угадывает. Ставок и сроков в нём нет. Расчёт по введённым данным и правилам, не консультация.

import { reserve_open, to_epoch_day, format_date } from '../engine/index.mjs';
import { label_of } from './i18n.mjs';
import { h, el_by_id } from './dom.mjs';
import { focus_is_lost, FOCUS_WINDOW_MS } from './focus_keep.mjs';
import { reserve_numbers, open_how } from './alloc_explain.mjs';

/** Коды предупреждений движка, у которых есть остаток в резерве. */
export const RESIDUAL_CODES = Object.freeze(['W_RESERVE_RESIDUAL', 'W_RESERVE_OVERDUE']);

const list = (ws, key) => (Array.isArray(ws?.[key]) ? ws[key] : []);
const fail = (code, field, reason) => ({ ok: false, error: { code, ctx: { field, reason } } });

/** Начало учёта резерва (`funded_as_of`, EpochDay); без отметки — минус бесконечность. */
function funded_from(reserve) {
  return reserve.funded_as_of === undefined || reserve.funded_as_of === null ? -Infinity : to_epoch_day(reserve.funded_as_of);
}

// ══ 1. Чистая часть ═══════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Резервы под предупреждением `W_RESERVE_RESIDUAL` / `W_RESERVE_OVERDUE` (предупреждения строит `analyze`): сумма остатка, срок и платежи, привязанные к резерву.
 * @param {{ws: object, ctx: object}} model модель страницы
 * @returns {{reserve_id: string, code: string, funded_minor: number, due_date: string|null, payments: {date: string, amount_minor: number}[], can_release: boolean}[]}
 */
export function reserve_flags(model) {
  const a = model.ctx;
  const ws = model.ws;
  const out = [];
  for (const w of a.warnings ?? []) {
    if (!RESIDUAL_CODES.includes(w?.code) || typeof w.reserve_id !== 'string') continue;
    const reserve = list(ws, 'reserves').find((r) => r?.reserve_id === w.reserve_id);
    if (reserve === undefined) continue;
    const from = funded_from(reserve);
    const funded = reserve_open(reserve, list(ws, 'allocations'), a.as_of);
    const payments = list(ws, 'facts')
      .filter((x) => x?.reserve_id === reserve.reserve_id && x.amount_minor < 0 && to_epoch_day(x.date) > from && to_epoch_day(x.date) <= a.as_of)
      .sort((p, q) => (to_epoch_day(p.date) - to_epoch_day(q.date)))
      .map((x) => ({ date: x.date, amount_minor: x.amount_minor }));
    out.push({ reserve_id: reserve.reserve_id, code: w.code, funded_minor: funded, due_date: reserve.due_date ?? null, payments, can_release: funded > 0 && a.as_of > from });
  }
  return out;
}

/**
 * Правка «освободить остаток»: ручная отрицательная аллокация на весь остаток резерва на `as_of` (`source = manual`).
 * Идентификатор детерминирован: `man:<reserve_id>@<дата>`, а вторая ручная запись того же дня получает `#2`, `#3`… — освобождение не затирает прежнее. Повтор той же
 * правки идемпотентен (тот же идентификатор и содержимое), а когда остатка нет, правка отказывает (`nothing_to_release`): данные не меняются.
 * @param {object} ws рабочая область
 * @param {string} reserve_id
 * @param {string|number} as_of дата освобождения (не раньше начала учёта резерва)
 * @returns {{ok: true, edit: {type: 'record_allocation', allocation: object}, amount_minor: number, date: string}|{ok: false, error: {code: string, ctx: object}}}
 */
export function release_residual_edit(ws, reserve_id, as_of) {
  const reserve = list(ws, 'reserves').find((r) => r?.reserve_id === reserve_id);
  if (reserve === undefined) return fail('E_SCHEMA', 'reserve_id', 'unknown_reserve');
  let day;
  try { day = to_epoch_day(as_of); } catch { return fail('E_BAD_DATE', 'date', 'bad_date'); }
  if (reserve.backed_by_account_id !== undefined && reserve.backed_by_account_id !== null) return fail('E_SCHEMA', 'reserve_id', 'backed_by_account');
  if (day <= funded_from(reserve)) return fail('E_SCHEMA', 'date', 'not_after_funded_as_of'); // запись не позже начала учёта движок бы проигнорировал
  const funded = reserve_open(reserve, list(ws, 'allocations'), day);
  if (!(funded > 0)) return fail('E_SCHEMA', 'reserve_id', 'nothing_to_release');
  const date = format_date(day);
  const same_day = list(ws, 'allocations').filter((x) => x?.reserve_id === reserve_id && x.source === 'manual' && x.date === date).length;
  const allocation_id = 'man:' + reserve_id + '@' + date + (same_day === 0 ? '' : '#' + (same_day + 1));
  return { ok: true, edit: { type: 'record_allocation', allocation: { allocation_id, reserve_id, date, amount_minor: 0 - funded, source: 'manual' } }, amount_minor: funded, date };
}

// ══ 2. Узлы ═══════════════════════════════════════════════════════════════════════════════════════════════════════════

/** Задержки попыток вернуть фокус, мс: последняя — общее окно хранителя фокуса FP-11 (`FOCUS_WINDOW_MS`), чтобы поздняя перерисовка хранилища не оставила фокус на body. */
export const REFOCUS_DELAYS = Object.freeze([0, 120, 400, 1200, 2000, FOCUS_WINDOW_MS]);

let refocus_gen = 0; // новый запрос отменяет попытки прежнего: старый запрос не должен переставлять фокус после нового действия

/**
 * Вернуть фокус на первый найденный узел из `ids` (а затем на заголовок экрана), если страница его потеряла: нажатая кнопка уходит из страницы при перерисовке, а
 * хранилище (FP-05) просит перерисовку ещё раз чуть позже. Попытки — через несколько интервалов до конца общего окна фокуса FP-11 (3 с); чужой фокус не отбирается.
 * @param {string[]} ids
 * @param {number[]} [delays] задержки попыток в мс
 */
export function refocus_later(ids, delays = REFOCUS_DELAYS) {
  if (typeof setTimeout !== 'function') return;
  const gen = ++refocus_gen;
  const attempt = () => {
    if (gen !== refocus_gen || !focus_is_lost()) return;
    for (const id of [...ids, 'view-title']) {
      const el = el_by_id(id);
      if (el !== null && el !== undefined && typeof el.focus === 'function') { el.focus(); return; }
    }
  };
  for (const ms of delays) {
    const timer = setTimeout(attempt, ms);
    if (timer !== undefined && typeof timer.unref === 'function') timer.unref();
  }
}

/** Название резерва на языке интерфейса. */
function reserve_name(ctx, reserve) {
  return label_of(ctx.lang(), reserve.reserve_id, reserve.name ?? reserve.reserve_id);
}

/**
 * Освободить остаток резерва: правка → `ctx.edit`; фокус просят до записи (страница перерисуется внутри `ctx.edit`). Успех — сообщение с суммой; отказ — текст,
 * данные не меняются (повторная попытка при пустом резерве — «освобождать нечего»).
 * @param {object} ctx контекст расширений
 * @param {string} reserve_id
 * @param {string[]} [focus_ids] куда вернуть фокус
 * @returns {{ok: boolean}} результат записи
 */
export function do_release(ctx, reserve_id, focus_ids = []) {
  const ws = ctx.get_ws();
  const reserve = list(ws, 'reserves').find((r) => r?.reserve_id === reserve_id);
  if (reserve === undefined) return { ok: false };
  const name = reserve_name(ctx, reserve);
  const built = release_residual_edit(ws, reserve_id, ws.as_of);
  if (!built.ok) {
    ctx.notify(built.error.ctx.reason === 'nothing_to_release' ? ctx.tr('reserveui.release_nothing', { name }) : ctx.tr('reserveui.release_failed', { code: built.error.code }), 'error');
    return { ok: false };
  }
  refocus_later(focus_ids);
  const r = ctx.edit(built.edit, { reason: 'record_allocation', meta: { kind: 'reserve_cut', amount_minor: built.amount_minor, currency: reserve.currency } });
  if (r.ok === true) ctx.notify(ctx.tr('reserveui.released', { name, sum: ctx.fmt().money(built.amount_minor) }), 'info'); // отказ ctx.edit сам объявил код канона
  return { ok: r.ok === true };
}

/** Кнопка «Освободить остаток» (видимый текст — начало доступного имени; сумма и резерв — в `aria-label`). */
function release_button(ctx, flag, reserve, id, focus_ids) {
  return h('button', {
    type: 'button', class: 'btn small', id, 'data-act': 'release', 'data-reserve': reserve.reserve_id,
    'aria-label': ctx.tr('reserveui.release_aria', { sum: ctx.fmt().money(flag.funded_minor), name: reserve_name(ctx, reserve) }),
    onclick: () => { do_release(ctx, reserve.reserve_id, focus_ids); }, text: ctx.tr('reserveui.release_btn'),
  });
}

/**
 * Слот `banner.warning`: кнопка «Освободить остаток» в плашке `W_RESERVE_RESIDUAL` (в шапке, на любом экране). Для остальных предупреждений — `null`.
 * @param {object} ctx
 * @param {{warning: {code: string, reserve_id?: string}}} arg
 * @returns {HTMLElement|null}
 */
export function render_banner_release(ctx, arg) {
  const w = arg?.warning;
  if (w === null || typeof w !== 'object' || w.code !== 'W_RESERVE_RESIDUAL' || typeof w.reserve_id !== 'string') return null;
  const model = ctx.get_model();
  if (model === null || model === undefined) return null;
  const flag = reserve_flags(model).find((x) => x.reserve_id === w.reserve_id && x.code === 'W_RESERVE_RESIDUAL' && x.can_release);
  const idx = list(model.ws, 'reserves').findIndex((r) => r?.reserve_id === w.reserve_id);
  if (flag === undefined || idx < 0) return null;
  return release_button(ctx, flag, model.ws.reserves[idx], 'fp15-hdr-release-' + idx, ['fp15-hdr-release-' + idx]);
}

/** Сколько последних платежей резерва называет карточка (остальные — счётчиком «ещё N ранее»). */
const PAYMENTS_SHOWN = 3;

/**
 * Строка «Платежи по резерву: 10 сентября −30,00 €» из списка платежей `reserve_flags` (по возрастанию даты): последние `PAYMENTS_SHOWN`, раньше — счётчиком.
 * Платежей нет — `null` (строки нет вовсе).
 */
export function payments_text(ctx, f, payments) {
  if (!Array.isArray(payments) || payments.length === 0) return null;
  const shown = payments.slice(-PAYMENTS_SHOWN).map((x) => f.date(x.date) + ' ' + f.money(x.amount_minor));
  const earlier = payments.length - shown.length;
  if (earlier > 0) shown.unshift(ctx.tr('reserveui.payments_more', { n: earlier }));
  return ctx.tr('reserveui.payments_line', { list: shown.join('; ') });
}

/** Предупреждение резерва с объяснением, суммой, платежами и кнопкой (если освобождать есть что). */
function flag_banner(ctx, f, flag, reserve, idx) {
  const due = flag.due_date === null ? ctx.tr('c.na') : f.date(flag.due_date);
  const key = flag.code === 'W_RESERVE_RESIDUAL' ? 'reserveui.residual_text' : 'reserveui.overdue_text';
  const kids = [h('p', { text: ctx.tr(key, { due, sum: f.money(flag.funded_minor) }) })];
  const pay = payments_text(ctx, f, flag.payments);
  if (pay !== null) kids.push(h('p', { class: 'muted', text: pay }));
  if (flag.can_release) {
    kids.push(h('p', { class: 'muted', text: ctx.tr('reserveui.release_hint', { sum: f.money(flag.funded_minor) }) + (pay === null ? '' : ' ' + ctx.tr('reserveui.release_note')) }),
      h('div', { class: 'row' }, release_button(ctx, flag, reserve, 'fp15-r' + idx + '-release', ['fp15-r' + idx + '-release', 'fp15-r' + idx + '-title'])));
  }
  return h('div', { class: 'banner tight fp15-flag', role: 'status', 'data-code': flag.code }, kids);
}

/**
 * Карточка резервов на экране «Резервы» (слот `reserves.sections`): по каждому резерву — сколько сейчас и к концу горизонта (под отключённым правилом — текст вместо чисел),
 * предупреждение об остатке с суммой и действием, «Как посчитано». Резервы, привязанные к счёту, в ряд резервов не входят и не показываются.
 * @param {object} ctx
 * @returns {HTMLElement|null}
 */
export function render_reserve_cards(ctx) {
  const model = ctx.get_model();
  if (model === null || model === undefined) return null;
  const ws = model.ws;
  const f = ctx.fmt();
  const mode = ctx.mode();
  const flags = reserve_flags(model);
  const blocks = [];
  list(ws, 'reserves').forEach((reserve, idx) => {
    const nums = reserve_numbers(model, reserve.reserve_id, mode);
    if (!nums.ok) return;
    const name = reserve_name(ctx, reserve);
    const kids = [h('h4', { id: 'fp15-r' + idx + '-title', tabindex: '-1', text: name })];
    kids.push(nums.hidden
      ? h('p', { class: 'banner short', role: 'status', text: ctx.tr('reserveui.hidden_line', { since: nums.since ?? ctx.tr('c.na') }) })
      : h('p', { text: ctx.tr('reserveui.now_line', { now: f.money(nums.now_minor), end: f.money(nums.end_minor) }) }));
    for (const flag of flags.filter((x) => x.reserve_id === reserve.reserve_id)) kids.push(flag_banner(ctx, f, flag, reserve, idx));
    kids.push(h('div', { class: 'row' }, h('button', {
      type: 'button', class: 'btn small', id: 'fp15-r' + idx + '-how', 'data-act': 'how', 'data-reserve': reserve.reserve_id,
      'aria-label': ctx.tr('reserveui.how_aria', { name }), onclick: () => open_how(ctx, reserve.reserve_id, ctx.mode()), text: ctx.tr('reserveui.how_btn'),
    })));
    blocks.push(h('div', { class: 'fp15-reserve', 'data-reserve': reserve.reserve_id }, kids));
  });
  if (blocks.length === 0) return null;
  return h('section', { class: 'card fp15-card', id: 'fp15-reserves', 'aria-labelledby': 'fp15-reserves-title' },
    h('h3', { id: 'fp15-reserves-title', text: ctx.tr('reserveui.cards_title') }),
    h('p', { class: 'muted', text: ctx.tr('reserveui.cards_lead') }),
    ...blocks);
}
