// fact_fix.mjs — «Исправить факт» одной правкой (FP-28, IDEA-38, REQ-090): введённая запись заменяется исправленной, «Отменить» возвращает прежнюю.
//
// Исправление — это `void_fact` прежней записи и `add_fact` новой, собранные в ОДИН пересчёт (`ctx.set_ws`): для единой стопки «Отменить» (S1.3) это одна единица,
// для журнала — `revert` прежней записи и новая `tx.posted` (журнал остаётся только дописываемым). Новая запись получает новый идентификатор, остальные поля прежней
// (привязка к плану `plan_ref` / `no_plan`, метка, заметка, контрагент, курс `fx`, ключ дедупликации импорта) сохраняются; меняются только сумма, дата, счёт, метка и заметка,
// которые правит пользователь. Знак суммы определяет вид (расход / приход): минус впереди — расход, плюс — приход, без знака — прежний знак.
// Перевод (две ноги с общим `transfer_id`) здесь не правится: его ноги связаны, и правка одной нарушила бы нулевую сумму; для него кнопка не предлагается.
// Файл делится на чистую часть (сборка правок и проверка; проверяет tests/feed_ext.test.mjs) и построители DOM. Расчёт по введённым данным и правилам, не консультация.

import { format_minor } from '../engine/index.mjs';
import {
  resolve_number_format, parse_entry_amount, account_exponent, account_name, entry_accounts, example_amount, money_text, date_text, error_text,
} from './entry.mjs';
import { apply_chain } from './forms.mjs';
import { FACT_KEYS } from './ws_edit.mjs';
import { h, open_dialog, close_dialog, announce } from './dom.mjs';

const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const list = (ws, key) => (Array.isArray(ws?.[key]) ? ws[key] : []);
const fail_with = (code, field, reason) => ({ ok: false, error: { code, ctx: { field, reason } } });

/** Причина записи в `ctx.set_ws` (для подписчиков и журнала действий). */
export const FIX_REASON = 'fix_fact';

/**
 * Исправить можно факт, который существует и не является ногой перевода.
 * @param {object} ws
 * @param {string} event_id
 * @returns {{ok: true, fact: object}|{ok: false, reason: 'not_found'|'transfer'}}
 */
export function fixable_fact(ws, event_id) {
  const fact = list(ws, 'facts').find((f) => is_obj(f) && f.event_id === event_id);
  if (fact === undefined) return { ok: false, reason: 'not_found' };
  if (typeof fact.transfer_id === 'string' || fact.kind === 'transfer') return { ok: false, reason: 'transfer' };
  return { ok: true, fact };
}

/** Сумма факта в поле ввода: со знаком «−» у расхода, в формате чисел рабочей области (так её читает `parse_entry_amount`). */
export function amount_field_text(ws, fact, lang) {
  const acc = list(ws, 'accounts').find((a) => a?.account_id === fact.account_id);
  const fmt = resolve_number_format(ws, lang);
  const abs = format_minor(Math.abs(fact.amount_minor), acc === undefined ? 2 : account_exponent(acc), { decimal: fmt.decimal, thousands: '' });
  return (fact.amount_minor < 0 ? '−' : '') + abs;
}

/**
 * Собрать цепочку «убрать прежнюю запись и добавить исправленную» и проверить её на копии рабочей области, ничего не меняя.
 * @param {object} ws
 * @param {string} event_id прежняя запись
 * @param {{amount_text: string, date: string, account_id?: string, tag?: string, note?: string}} form поля формы (пустая метка и заметка убирают поле)
 * @param {{lang: 'ru'|'en', new_id: (prefix: string) => string}} env
 * @returns {{ok: true, edits: object[], ws_after: object, fact: object, old: object, meta: object, changed: boolean}
 *   | {ok: false, error: {code: string, ctx: object|null}}}
 */
export function build_fix(ws, event_id, form, env) {
  const hit = fixable_fact(ws, event_id);
  if (!hit.ok) return fail_with('E_SCHEMA', 'event_id', hit.reason === 'transfer' ? 'transfer_not_fixable' : 'unknown_fact');
  const old = hit.fact;
  const account_id = typeof form.account_id === 'string' && form.account_id !== '' ? form.account_id : old.account_id;
  const acc = list(ws, 'accounts').find((a) => a?.account_id === account_id);
  if (acc === undefined) return fail_with('E_SCHEMA', 'account_id', 'unknown_account');
  const p = parse_entry_amount(form.amount_text, resolve_number_format(ws, env.lang), account_exponent(acc));
  if (!p.ok) return fail_with(p.code, 'amount', p.reason);
  const sign = p.sign !== 0 ? p.sign : (old.amount_minor < 0 ? -1 : 1);
  const date = typeof form.date === 'string' && form.date.trim() !== '' ? form.date.trim() : old.date;
  const kept = Object.fromEntries(FACT_KEYS.filter((k) => Object.hasOwn(old, k)).map((k) => [k, old[k]])); // только поля, которые принимает add_fact
  const fact = { ...kept, event_id: env.new_id('tx'), account_id: acc.account_id, date, amount_minor: sign * p.abs_minor, currency: acc.currency, kind: sign > 0 ? 'income' : 'expense' };
  for (const k of ['tag', 'note']) {
    const v = typeof form[k] === 'string' ? form[k].trim() : (typeof old[k] === 'string' ? old[k] : '');
    if (v === '') delete fact[k]; else fact[k] = v;
  }
  const same = ['account_id', 'date', 'amount_minor', 'kind', 'tag', 'note'].every((k) => fact[k] === old[k]);
  const edits = [{ type: 'void_fact', event_id: old.event_id }, { type: 'add_fact', fact }];
  const r = apply_chain(ws, edits, { new_id: env.new_id, as_of: ws.as_of });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, edits, ws_after: r.ws, fact, old, changed: !same, meta: { kind: 'fact_fix', amount_minor: Math.abs(fact.amount_minor), currency: fact.currency } };
}

/**
 * Записать исправление одним пересчётом.
 * @param {object} ctx
 * @param {string} event_id
 * @param {object} form см. `build_fix`
 * @returns {{ok: true, ws: object, built: object}|{ok: false, error: {code: string, ctx: object|null}}}
 */
export function commit_fix(ctx, event_id, form) {
  const ws = ctx.get_ws();
  if (ws === null || ws === undefined) return fail_with('E_SCHEMA', 'workspace', 'no_workspace');
  if (ctx.read_only() !== null) return fail_with('E_SCHEMA', 'workspace', 'read_only'); // просмотр: правка отклонена с причиной «только чтение»
  const b = build_fix(ws, event_id, form, { lang: ctx.lang(), new_id: ctx.new_id });
  if (!b.ok) return b;
  if (!b.changed) return fail_with('E_SCHEMA', 'form', 'no_change');
  const s = ctx.set_ws(b.ws_after, { reason: FIX_REASON, meta: b.meta });
  return s.ok ? { ok: true, ws: b.ws_after, built: b } : { ok: false, error: s.error };
}

// ── DOM ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Текст отказа: «только чтение», «ничего не изменено», «запись не найдена» — своими словами, остальное — как у быстрого ввода. */
export function fix_error_text(ctx, error, info = {}) {
  const reason = error?.ctx?.reason;
  if (reason === 'read_only') return ctx.tr('ro.refused');
  if (reason === 'no_change') return ctx.tr('feedx.fx_nochange');
  if (reason === 'unknown_fact') return ctx.tr('feedx.fx_not_found');
  if (reason === 'transfer_not_fixable') return ctx.tr('feedx.fx_transfer_only');
  return error_text(ctx, error, info);
}

/**
 * Открыть диалог «Исправить запись».
 * @param {object} ctx
 * @param {string} event_id
 * @param {{focus?: {request: (id: string) => void}}} [deps] хранитель фокуса экрана: после записи кнопка строки заменяется, фокус возвращается на заголовок
 * @returns {{amount: HTMLElement, date: HTMLElement, form: HTMLElement, error: HTMLElement}|null} элементы диалога (для тестов)
 */
export function open_fix_dialog(ctx, event_id, deps = {}) {
  const ws = ctx.get_ws();
  if (ws === null || ws === undefined) { ctx.notify(ctx.tr('entry.no_data'), 'error'); return null; }
  if (ctx.read_only() !== null) { ctx.notify(ctx.tr('ro.refused'), 'error'); return null; } // кнопка в просмотре называет причину, а не открывает форму
  const hit = fixable_fact(ws, event_id);
  if (!hit.ok) { ctx.notify(ctx.tr(hit.reason === 'transfer' ? 'feedx.fx_transfer_only' : 'feedx.fx_not_found'), 'error'); return null; }
  void ctx.journal; // журнал создаётся заранее, чтобы он видел правку и отмену
  const old = hit.fact;
  const lang = ctx.lang();
  const accounts = entry_accounts(ws).filter((a) => a.currency === old.currency || a.account_id === old.account_id);
  const acc0 = accounts.find((a) => a.account_id === old.account_id) ?? accounts[0];
  const fmt = resolve_number_format(ws, lang);
  const name = typeof old.tag === 'string' && old.tag !== '' ? old.tag : account_name(ws, old.account_id, lang);

  const amount = h('input', { type: 'text', id: 'fx-amount', inputmode: 'decimal', autocomplete: 'off', 'aria-describedby': 'fx-hint' });
  amount.value = amount_field_text(ws, old, lang);
  const date = h('input', { type: 'date', id: 'fx-date', max: ws.as_of });
  date.value = old.date;
  const account = h('select', { id: 'fx-account' }, accounts.map((a) => h('option', { value: a.account_id, selected: a.account_id === old.account_id ? true : null, text: account_name(ws, a.account_id, lang) + ' · ' + a.currency })));
  account.value = old.account_id;
  const tag = h('input', { type: 'text', id: 'fx-tag', autocomplete: 'off', maxlength: '100' });
  tag.value = typeof old.tag === 'string' ? old.tag : '';
  const note = h('input', { type: 'text', id: 'fx-note', autocomplete: 'off', maxlength: '1000' });
  note.value = typeof old.note === 'string' ? old.note : '';
  const error = h('p', { class: 'error', id: 'fx-error', role: 'alert' });

  const submit = (ev) => {
    ev.preventDefault();
    error.textContent = '';
    deps.focus?.request('view-title'); // до записи: страница перерисуется внутри set_ws, диалог закроется позже, а кнопка исправленной строки — новый узел
    const r = commit_fix(ctx, event_id, { amount_text: amount.value, date: date.value, account_id: account.value, tag: tag.value, note: note.value });
    if (!r.ok) {
      deps.focus?.clear();
      const cur = ctx.get_ws();
      const acc = list(cur, 'accounts').find((a) => a?.account_id === account.value) ?? acc0;
      error.textContent = fix_error_text(ctx, r.error, { example: example_amount(resolve_number_format(cur, ctx.lang()), account_exponent(acc)), as_of: date_text(ctx.lang(), cur.as_of, cur.as_of, cur.number_format) });
      announce(error.textContent);
      amount.focus();
      return;
    }
    const f = r.built.fact;
    close_dialog();
    const text = ctx.tr('feedx.fx_done', { amount: money_text(ctx.lang(), f.amount_minor, f.currency, r.ws.as_of, r.ws.number_format), date: date_text(ctx.lang(), f.date, r.ws.as_of, r.ws.number_format) });
    ctx.notify(text, 'info');
  };
  const form = h('form', { class: 'entry-form feedx-fix', novalidate: true, onsubmit: submit },
    h('p', { class: 'lead', text: ctx.tr('feedx.fx_lead', { name, date: date_text(lang, old.date, ws.as_of, ws.number_format) }) }),
    h('div', { class: 'field' }, h('label', { for: 'fx-amount', text: ctx.tr('feedx.fx_amount') }), amount,
      h('p', { class: 'muted', id: 'fx-hint', text: ctx.tr('feedx.fx_hint', { example: example_amount(fmt, account_exponent(acc0)) }) })),
    h('div', { class: 'field' }, h('label', { for: 'fx-date', text: ctx.tr('feedx.fx_date') }), date),
    accounts.length > 1 ? h('div', { class: 'field' }, h('label', { for: 'fx-account', text: ctx.tr('feedx.fx_account') }), account) : null,
    h('div', { class: 'field' }, h('label', { for: 'fx-tag', text: ctx.tr('feedx.fx_tag') }), tag),
    h('div', { class: 'field' }, h('label', { for: 'fx-note', text: ctx.tr('feedx.fx_note') }), note),
    error,
    h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'btn primary', text: ctx.tr('feedx.fx_submit') })));
  open_dialog(ctx.tr('feedx.fx_title'), ctx.tr('feedx.close'), form);
  amount.focus();
  return { amount, date, account, tag, note, form, error };
}
