// anchor_dialog.mjs — «сверить остаток» одним числом (FP-04, REQ-028, IDEA-91, ALG-13).
//
// Пользователь называет один остаток («сколько сейчас на счёте»): страница записывает якорь `Anchor` на дату расчёта и показывает найденное
// расхождение с записями — дрейф нельзя скрывать. Дрейф считается так же, как в движке (`opening_state`): `drift = якорь − (предыдущий якорь
// + факты после него до даты нового)`; у первого якоря счёта сравнивать не с чем (`first`).
// От плашки «данные устарели» до её исчезновения — три действия, каждое — один вызов модели: `anchor_open` (кнопка «Сверить остаток») →
// `anchor_input` (число) → `anchor_confirm` (Enter). Границы свежести (7/8 и 21/22 дня, TST-57) этот модуль не трогает: уровень плашки считает
// движок (`anchor_status`), здесь он только читается до и после.
//
// Если у счёта уже есть якорь на ту же дату, запись заменяет его (тот же `anchor_id`): два якоря на одну дату движок различил бы только по
// порядку идентификаторов. «Отменить» возвращает прежний якорь. Модель чистая (без DOM); построители DOM — в конце файла.
// Расчёт по введённым данным и правилам, не консультация.

import { anchor_status, sum_minor, parse_date } from '../engine/index.mjs';
import { apply_edit } from './ws_edit.mjs';
import {
  resolve_number_format, parse_entry_amount, account_exponent, account_name, entry_accounts, example_amount, money_text, date_text, error_text,
} from './entry.mjs';
import { h, open_dialog, announce } from './dom.mjs';
import { UNDO_RECORDED } from './undo.mjs';

const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const list = (ws, key) => (Array.isArray(ws?.[key]) ? ws[key] : []);
const fail_with = (code, field, reason) => ({ ok: false, error: { code, ctx: { field, reason } } });

/**
 * Свежесть данных на дату расчёта: `{level, age}` из `anchor_status` (`fresh|banner|block`; возраст в днях или `null`, если якоря нет).
 * Ошибка расчёта не пробрасывается: `null`.
 * @param {object} ws
 * @returns {{level: 'fresh'|'banner'|'block', age: number|null, reason?: string}|null}
 */
export function freshness(ws) {
  try {
    const s = anchor_status(ws, ws.as_of);
    return { level: s.level, age: s.age, ...(s.reason === undefined ? {} : { reason: s.reason }) };
  } catch { return null; }
}

/**
 * Счёт для сверки по умолчанию: самый несвежий открытый счёт (без якоря — в первую очередь), иначе запомненный, иначе первый операционный.
 * Пока плашка «данные устарели» держится из-за одного счёта, кнопка ведёт именно на него, а не на последний использованный.
 * @param {object} ws
 * @param {string|null} [remembered]
 * @returns {string|null}
 */
export function default_anchor_account(ws, remembered = null) {
  const open = entry_accounts(ws);
  const ids = open.map((a) => a.account_id);
  try {
    const stale = anchor_status(ws, ws.as_of).stale_accounts.filter((x) => ids.includes(x.account_id));
    if (stale.length > 0) {
      stale.sort((a, b) => ((b.age ?? Infinity) - (a.age ?? Infinity)) || (a.account_id < b.account_id ? -1 : 1));
      return stale[0].account_id;
    }
  } catch { /* расчёт недоступен: запомненный или первый счёт ниже */ }
  if (remembered !== null && ids.includes(remembered)) return remembered;
  return (open.find((a) => a.liquidity === 'operating') ?? open[0])?.account_id ?? null;
}

/**
 * Что нашла бы сверка: расхождение названного остатка с записями на дату.
 * `expected_minor = предыдущий якорь (дата строго раньше) + факты счёта после него до даты включительно`; без предыдущего якоря — сумма фактов до даты.
 * @param {object} ws
 * @param {{account_id: string, amount_minor: number, date: string}} q
 * @returns {{account_id: string, date: string, currency: string, entered_minor: number, expected_minor: number, drift_minor: number,
 *   first: boolean, prev_date: string|null, replaces: string|null}}
 */
export function reconcile_preview(ws, q) {
  const acc = list(ws, 'accounts').find((a) => a?.account_id === q.account_id);
  if (acc === undefined) throw new RangeError('reconcile_preview: неизвестный счёт');
  const mine = list(ws, 'anchors').filter((a) => a?.account_id === q.account_id)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.anchor_id < b.anchor_id ? -1 : 1)));
  const prev = mine.filter((a) => a.date < q.date).pop() ?? null;
  const same_day = mine.find((a) => a.date === q.date) ?? null;
  const facts = list(ws, 'facts').filter((f) => f?.account_id === q.account_id && f.date <= q.date && (prev === null || f.date > prev.date));
  const expected_minor = sum_minor([prev === null ? 0 : prev.amount_minor, ...facts.map((f) => f.amount_minor)]);
  return {
    account_id: q.account_id,
    date: q.date,
    currency: acc.currency,
    entered_minor: q.amount_minor,
    expected_minor,
    drift_minor: q.amount_minor - expected_minor,
    first: prev === null,
    prev_date: prev === null ? null : prev.date,
    replaces: same_day === null ? null : same_day.anchor_id,
  };
}

/**
 * Собрать правку `set_anchor` из полей формы: счёт, число, дата (по умолчанию `as_of`). Число читается по формату чисел рабочей области,
 * знак «−» допустим (овердрафт), ноль допустим.
 * @param {object} ws
 * @param {{account_id: string, amount_text: string, date?: string}} form
 * @param {{lang?: 'ru'|'en'}} [env]
 * @returns {{ok: true, edit: object, preview: object} | {ok: false, error: {code: string, ctx: object}}}
 */
export function build_anchor_edit(ws, form, env = {}) {
  if (!is_obj(form)) return fail_with('E_SCHEMA', 'form', 'not_object');
  const acc = list(ws, 'accounts').find((a) => a?.account_id === form.account_id);
  if (acc === undefined) return fail_with('E_SCHEMA', 'account_id', 'unknown_account');
  const p = parse_entry_amount(form.amount_text, resolve_number_format(ws, env.lang ?? 'ru'), account_exponent(acc), { allow_zero: true });
  if (!p.ok) return fail_with(p.code, 'amount', p.reason);
  const date = typeof form.date === 'string' && form.date.trim() !== '' ? form.date.trim() : ws.as_of;
  try { parse_date(date); } catch { return fail_with('E_BAD_DATE', 'date', 'bad_date'); }
  if (date > ws.as_of) return fail_with('E_FUTURE_POSTED', 'date', 'anchor_after_as_of');
  const amount_minor = (p.sign < 0 ? -1 : 1) * p.abs_minor;
  const preview = reconcile_preview(ws, { account_id: acc.account_id, amount_minor, date });
  const anchor = { account_id: acc.account_id, date, amount_minor };
  if (preview.replaces !== null) anchor.anchor_id = preview.replaces;
  return { ok: true, edit: { type: 'set_anchor', anchor }, preview };
}

// ── три действия: открыть → ввести → подтвердить ─────────────────────────────────────────────────────────────────────

/**
 * Действие 1 — «Сверить остаток»: состояние диалога (счёт по умолчанию, дата = `as_of`, пустое поле).
 * @param {object} ctx
 * @param {{memory?: object}} [deps]
 * @returns {{ok: true, state: object} | {ok: false, error: {code: string, ctx: object}}}
 */
export function anchor_open(ctx, deps = {}) {
  const ws = ctx.get_ws();
  if (ws === null || ws === undefined) return fail_with('E_SCHEMA', 'workspace', 'no_workspace');
  const account_id = default_anchor_account(ws, deps.memory?.get(ws) ?? null);
  if (account_id === null) return fail_with('E_SCHEMA', 'account_id', 'no_accounts');
  return { ok: true, state: { account_id, date: ws.as_of, amount_text: '', preview: null, error: null, before: freshness(ws) } };
}

/**
 * Действие 2 — число (и, если нужно, счёт или дата): новое состояние с живым показом найденного расхождения. Неразобранное число — без показа.
 * @param {object} ctx
 * @param {object} state
 * @param {{amount_text?: string, account_id?: string, date?: string}} patch
 */
export function anchor_input(ctx, state, patch) {
  const ws = ctx.get_ws();
  const next = { ...state, ...patch, error: null, preview: null };
  const b = build_anchor_edit(ws, { account_id: next.account_id, amount_text: next.amount_text, date: next.date }, { lang: ctx.lang() });
  if (b.ok) next.preview = b.preview;
  return next;
}

/**
 * Действие 3 — подтверждение (Enter): якорь записывается через общий путь, плашка пересчитывается движком.
 * @param {object} ctx
 * @param {object} state
 * @param {{undo?: object, memory?: object}} [deps]
 * @returns {{ok: true, ws: object, preview: object, before: object|null, after: object|null}
 *   | {ok: false, error: {code: string, ctx: object|null}}}
 */
export function anchor_confirm(ctx, state, deps = {}) {
  const before_ws = ctx.get_ws();
  if (before_ws === null || before_ws === undefined) return fail_with('E_SCHEMA', 'workspace', 'no_workspace');
  const b = build_anchor_edit(before_ws, { account_id: state.account_id, amount_text: state.amount_text, date: state.date }, { lang: ctx.lang() });
  if (!b.ok) return b;
  const r = apply_edit(before_ws, b.edit, { new_id: ctx.new_id });
  if (!r.ok) return r;
  const rec = deps.undo?.record(before_ws, r.ws, { kind: 'anchor', amount_minor: b.preview.entered_minor, currency: b.preview.currency }); // до записи: страница перерисуется внутри set_ws
  const s = ctx.set_ws(r.ws, { reason: 'set_anchor', undo: rec ? UNDO_RECORDED : undefined }); // «уже записано»: общий подписчик стопки второй раз не пишет
  if (!s.ok) {
    if (rec) rec.rollback();
    return { ok: false, error: s.error };
  }
  deps.memory?.remember(r.ws, b.preview.account_id);
  return { ok: true, ws: r.ws, preview: b.preview, before: freshness(before_ws), after: freshness(r.ws) };
}

/** Сколько действий от плашки до её исчезновения: открыть, ввести число, подтвердить (REQ-028 — не более трёх). */
export const ANCHOR_ACTIONS = 3;

// ── тексты ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Строка о найденном расхождении (до подтверждения). */
export function preview_text(ctx, ws, pv) {
  const lang = ctx.lang();
  const m = (v) => money_text(lang, v, pv.currency, ws.as_of, ws.number_format); // формат чисел и дат пользователя (REQ-112, FP-16)
  const date = date_text(lang, pv.date, ws.as_of, ws.number_format);
  if (pv.first) return ctx.tr('entry.a_preview_first', { entered: m(pv.entered_minor) });
  if (pv.drift_minor === 0) return ctx.tr('entry.a_preview_ok', { date, expected: m(pv.expected_minor) });
  return ctx.tr('entry.a_preview_drift', { date, expected: m(pv.expected_minor), entered: m(pv.entered_minor), drift: m(pv.drift_minor) });
}

/** Итоговая строка после подтверждения: что записано, какое расхождение найдено, исчезла ли плашка. */
export function done_text(ctx, r) {
  const lang = ctx.lang();
  const pv = r.preview;
  const m = (v) => money_text(lang, v, pv.currency, r.ws.as_of, r.ws.number_format);
  const date = date_text(lang, pv.date, r.ws.as_of, r.ws.number_format);
  let t;
  if (pv.first) t = ctx.tr('entry.a_done_first', { entered: m(pv.entered_minor), date });
  else if (pv.drift_minor === 0) t = ctx.tr('entry.a_done_ok', { entered: m(pv.entered_minor), date });
  else t = ctx.tr('entry.a_done_drift', { entered: m(pv.entered_minor), date, drift: m(pv.drift_minor) });
  if (r.before !== null && r.before.level !== 'fresh') {
    t += ' ' + ctx.tr(r.after !== null && r.after.level === 'fresh' ? 'entry.a_banner_gone' : 'entry.a_banner_stays');
  }
  return t;
}

// ── DOM ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Кнопка «Сверить остаток» для слота `nav.actions`; когда данные устарели, она выделена. */
export function render_nav_anchor(ctx, open) {
  const level = ctx.get_model()?.ctx?.anchor_status?.level ?? 'fresh';
  return h('button', { type: 'button', class: level === 'fresh' ? 'btn' : 'btn primary', 'aria-label': ctx.tr('entry.nav_anchor_label'), onclick: open, text: ctx.tr('entry.nav_anchor') });
}

/**
 * Открыть диалог сверки. Поле суммы в фокусе; Enter — подтверждение.
 * @param {object} ctx
 * @param {{undo?: object, memory?: object}} deps
 */
export function open_anchor_dialog(ctx, deps) {
  const o = anchor_open(ctx, deps);
  if (!o.ok) { ctx.notify(ctx.tr('entry.no_data'), 'error'); return null; }
  void ctx.journal; // журнал создаётся заранее, чтобы он видел правку и отмену
  let state = o.state;
  const ws = ctx.get_ws();
  const lang = ctx.lang();
  const accounts = entry_accounts(ws);
  const fmt = resolve_number_format(ws, lang);
  const acc_of = (id) => accounts.find((a) => a.account_id === id) ?? accounts[0];

  const amount = h('input', { type: 'text', id: 'anchor-amount', inputmode: 'decimal', autocomplete: 'off', enterkeyhint: 'done', 'aria-describedby': 'anchor-hint anchor-preview' });
  amount.value = '';
  const account = h('select', { id: 'anchor-account' }, accounts.map((a) => h('option', {
    value: a.account_id, selected: a.account_id === state.account_id ? true : null, text: account_name(ws, a.account_id, lang) + ' · ' + a.currency,
  })));
  account.value = state.account_id;
  const date = h('input', { type: 'date', id: 'anchor-date', max: ws.as_of });
  date.value = ws.as_of;
  const hint = h('p', { class: 'muted', id: 'anchor-hint', text: ctx.tr('entry.a_hint', { example: example_amount(fmt, account_exponent(acc_of(state.account_id))) }) });
  const preview = h('p', { id: 'anchor-preview', 'aria-live': 'polite' });
  const error = h('p', { class: 'error', id: 'anchor-error', role: 'alert' });
  const result = h('div', { id: 'anchor-result', role: 'status' });
  const submit = h('button', { type: 'submit', class: 'btn primary', text: ctx.tr('entry.a_submit') });

  const refresh = () => {
    state = anchor_input(ctx, state, { amount_text: amount.value, account_id: account.value, date: date.value });
    error.textContent = '';
    preview.textContent = state.preview === null ? '' : preview_text(ctx, ctx.get_ws(), state.preview);
  };
  amount.addEventListener('input', refresh);
  account.addEventListener('change', refresh);
  date.addEventListener('change', refresh);

  const form = h('form', { class: 'entry-form anchor-form', novalidate: true, onsubmit: (ev) => {
    ev.preventDefault();
    refresh();
    const cur = ctx.get_ws();
    const r = anchor_confirm(ctx, state, deps);
    if (!r.ok) {
      const f = resolve_number_format(cur, ctx.lang());
      error.textContent = error_text(ctx, r.error, { example: example_amount(f, account_exponent(acc_of(account.value))), as_of: date_text(ctx.lang(), cur.as_of, cur.as_of, cur.number_format) });
      announce(error.textContent);
      amount.focus();
      return;
    }
    const text = done_text(ctx, r);
    preview.textContent = '';
    result.replaceChildren(h('p', { class: 'banner', text }));
    announce(text);
    ctx.notify(text, 'info');
    submit.setAttribute('disabled', '');
    amount.setAttribute('disabled', '');
  } },
  h('p', { class: 'lead', text: ctx.tr('entry.a_intro') }),
  h('div', { class: 'field' }, h('label', { for: 'anchor-amount', text: ctx.tr('entry.a_amount') }), amount, hint),
  preview,
  error,
  result,
  h('details', { class: 'entry-more', open: accounts.length > 1 ? true : null },
    h('summary', { text: ctx.tr('entry.a_more') }),
    h('div', { class: 'field' }, h('label', { for: 'anchor-account', text: ctx.tr('entry.a_account') }), account),
    h('div', { class: 'field' }, h('label', { for: 'anchor-date', text: ctx.tr('entry.a_date') }), date)),
  h('div', { class: 'actions' }, submit));

  open_dialog(ctx.tr('entry.a_title'), ctx.tr('entry.close'), form);
  amount.focus();
  return { amount, account, date, preview, error, result, form, submit };
}
