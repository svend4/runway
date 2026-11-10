// reconcile.mjs — экран «Сверка» (#reconcile): очередь просроченных и неподтверждённых плановых платежей и все факты с пагинацией (FP-11, REQ-031, REQ-032, REQ-106, TST-40, TST-41).
// Что показывает. Очередь — плановые вхождения от последнего остатка до «сегодня», которым нужно решение человека: (1) ПРОСРОЧЕНО — «Просрочено: ожидали …», факта нет; (2) ВОЗМОЖНОЕ СОВПАДЕНИЕ — факт похож на план, но
// не в допуске, подходит несколько планов или на план претендуют несколько фактов (оба учитываются, пока вы не решили); (3) ОПЛАЧЕНО ЧАСТИЧНО — осталась часть суммы плана. Очередь отсортирована по убыванию суммы (REQ-106).
// Действия: подтвердить (факт ↔ план), привязать к плану (факт ↔ план из списка), не относится к плану, пропустить (вхождение не состоялось), отменить (разовый платёж отменён). Все правки идут общим путём
// `ctx.edit`: привязка — вид правки `set_match` (поля `plan_ref` / `no_plan` у факта; в журнал уходит запись `match.set`, факт не мутирует, C-051), пропуск вхождения правила — `set_occurrence_override` (FP-08),
// разовый платёж — `set_plan_status`. «Отменить» в навигации откатывает любое из них. Сверка необязательна: прогноз считается и без неё; решения влияют на ряды, только если вы их приняли.
// Модель (`reconcile_model`) чистая, без DOM, проверяется в Node; узлы — тонкий слой на `h` из dom.mjs (только `textContent`, без inline-стилей и обработчиков-строк). Расчёт по введённым данным, не консультация.

import { fail, to_epoch_day, normalize_ws, match_plan_to_fact, classify_occurrence } from '../engine/index.mjs';
import { plan_occurrences, plan_window_start } from '../engine/mc_inputs.mjs';
import { h, table, open_dialog, close_dialog } from './dom.mjs';
import { env_of, fmt_of, list_of } from './forms.mjs';
import { skip_edit } from './form_rule.mjs';
import { create_focus_keeper } from './focus_keep.mjs';
import { clock_ports } from './ids.mjs';
import { fixable_fact, open_fix_dialog } from './fact_fix.mjs';

/** Фактов на странице списка «Все факты». */
export const PAGE_SIZE = 15;
/** Сколько фактов-кандидатов предлагается для просроченного платежа. */
export const MAX_CANDIDATES = 8;

const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const sign_of = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const abs_of = (x) => (x < 0 ? -x : x);
const cmp_str = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ── виды правок: привязка факта и статус разового платежа ─────────────────────────────────────────────────────────────

/**
 * Вид правки `set_match` (для `ws_edit.register_edit`): `{type, event_id, plan_ref?, no_plan?}`.
 * `plan_ref` — идентификатор планового вхождения (`occ_key` правила/потока или `plan_id` разового платежа) → факт привязан к плану;
 * `no_plan: true` → «не относится к плану»; ни того, ни другого → привязка снята. Оба сразу — `E_SCHEMA`. Остальные поля факта не меняются.
 * Идентификатор плана проверяется по плановым вхождениям вокруг даты факта: привязка к несуществующему плану вывела бы факт из автосопоставления; счёт, валюта и знак суммы
 * плана должны совпадать с фактом (`plan_currency_or_sign_mismatch`) — так же, как в списке планов диалога привязки.
 * @param {object} ws
 * @param {object} edit
 * @returns {object} новая рабочая область
 * @throws {RunwayError} E_SCHEMA (неизвестное поле, факт, план, оба признака сразу)
 */
export function edit_set_match(ws, edit) {
  for (const k of Object.keys(edit)) if (!['type', 'event_id', 'plan_ref', 'no_plan'].includes(k)) fail('E_SCHEMA', { field: 'edit', reason: 'unknown_field', key: k.slice(0, 40) });
  if (typeof edit.event_id !== 'string' || edit.event_id === '') fail('E_SCHEMA', { field: 'event_id', reason: 'required' });
  const facts = list_of(ws, 'facts');
  const i = facts.findIndex((f) => is_obj(f) && (f.event_id ?? f.cash_event_id) === edit.event_id);
  if (i < 0) fail('E_SCHEMA', { field: 'event_id', reason: 'unknown_fact' });
  const has_ref = edit.plan_ref !== undefined && edit.plan_ref !== null;
  const no_plan = edit.no_plan === true;
  if (edit.no_plan !== undefined && edit.no_plan !== null && typeof edit.no_plan !== 'boolean') fail('E_SCHEMA', { field: 'no_plan', reason: 'not_boolean' });
  if (has_ref && no_plan) fail('E_SCHEMA', { field: 'plan_ref', reason: 'plan_ref_and_no_plan' });
  if (has_ref) {
    if (typeof edit.plan_ref !== 'string' || edit.plan_ref === '' || edit.plan_ref.length > 200 || /[\u0000-\u001f]/.test(edit.plan_ref)) fail('E_SCHEMA', { field: 'plan_ref', reason: 'bad_id' });
    const d = to_epoch_day(facts[i].date);
    const hit = plan_occurrences(ws, d - 400, d + 400, { as_of: ws.as_of ?? d }).find((p) => (p.occ_key ?? p.cash_event_id) === edit.plan_ref);
    if (hit === undefined) fail('E_SCHEMA', { field: 'plan_ref', reason: 'unknown_plan' });
    // тот же счёт, валюта и знак, что и в диалоге привязки (`plans_for_fact`): иначе привязка вывела бы факт из автосопоставления и не сошлась бы по сумме
    const nf = normalize_ws(ws).facts.find((f) => f.cash_event_id === edit.event_id);
    if (nf !== undefined && (hit.account_id !== nf.account_id || hit.currency !== nf.currency || sign_of(hit.amount_minor) !== sign_of(nf.amount_minor))) {
      fail('E_SCHEMA', { field: 'plan_ref', reason: 'plan_currency_or_sign_mismatch' });
    }
  }
  const next = { ...facts[i] };
  delete next.plan_ref;
  delete next.no_plan;
  if (has_ref) next.plan_ref = edit.plan_ref;
  if (no_plan) next.no_plan = true;
  return { ...ws, facts: facts.map((f, j) => (j === i ? next : f)) };
}

/** Статусы разового платежа, которые можно задать: «ожидается» (снимает статус), «пропущен», «отменён». */
export const PLAN_STATUSES = Object.freeze(['expected', 'skipped', 'cancelled']);

/**
 * Вид правки `set_plan_status`: `{type, plan_id, status}` для разового планового платежа (`ws.plans`). `expected` убирает поле `status`;
 * `skipped` и `cancelled` убирают платёж из прогноза, оставляя запись в истории (REQ-032).
 * @param {object} ws
 * @param {object} edit
 * @returns {object}
 * @throws {RunwayError} E_SCHEMA (неизвестное поле, платёж, статус)
 */
export function edit_set_plan_status(ws, edit) {
  for (const k of Object.keys(edit)) if (!['type', 'plan_id', 'status'].includes(k)) fail('E_SCHEMA', { field: 'edit', reason: 'unknown_field', key: k.slice(0, 40) });
  if (typeof edit.plan_id !== 'string' || edit.plan_id === '') fail('E_SCHEMA', { field: 'plan_id', reason: 'required' });
  if (!PLAN_STATUSES.includes(edit.status)) fail('E_SCHEMA', { field: 'status', reason: 'not_in_list' });
  const plans = list_of(ws, 'plans');
  const i = plans.findIndex((p) => is_obj(p) && p.plan_id === edit.plan_id);
  if (i < 0) fail('E_SCHEMA', { field: 'plan_id', reason: 'unknown_plan' });
  const next = { ...plans[i] };
  if (edit.status === 'expected') delete next.status; else next.status = edit.status;
  return { ...ws, plans: plans.map((p, j) => (j === i ? next : p)) };
}

/** Новые виды правок пакета (`ws_edit.register_edit`). */
export const EDITS = Object.freeze({ set_match: edit_set_match, set_plan_status: edit_set_plan_status });

/** Правка «привязать факт к плану» (подтвердить совпадение — та же запись). */
export const link_edit = (event_id, plan_ref) => ({ type: 'set_match', event_id, plan_ref });
/** Правка «не относится к плану». */
export const no_plan_edit = (event_id) => ({ type: 'set_match', event_id, no_plan: true });
/** Правка «снять привязку». */
export const unlink_edit = (event_id) => ({ type: 'set_match', event_id });
/** Правка «пропустить вхождение» плана: правило — исключение вхождения, разовый платёж — статус `skipped`; иначе `null` (поток часов и график долга так не убираются). */
export function skip_plan_edit(plan) {
  if (plan.source === 'rule' && plan.rule_id !== null && plan.nominal !== null) return skip_edit(plan.rule_id, plan.nominal);
  if (plan.source === 'plan') return { type: 'set_plan_status', plan_id: plan.id, status: 'skipped' };
  return null;
}
/** Правка «отменить платёж»: только разовый платёж (`status = cancelled`); повторяющееся правило отменяется в «Формах данных». */
export function cancel_plan_edit(plan) {
  return plan.source === 'plan' ? { type: 'set_plan_status', plan_id: plan.id, status: 'cancelled' } : null;
}

// ── модель ────────────────────────────────────────────────────────────────────────────────────────────────────────────

function name_of(ws, p, source) {
  const by = (list, key, id) => list_of(ws, list).find((x) => is_obj(x) && x[key] === id);
  let hit;
  if (source === 'rule') hit = by('rules', 'rule_id', p.rule_id);
  else if (source === 'stream') hit = by('streams', 'stream_id', p.stream_id);
  else if (source === 'plan') hit = by('plans', 'plan_id', p.cash_event_id);
  else hit = by('debts', 'debt_id', p.debt_id ?? p.plan_id);
  const name = typeof hit?.name === 'string' ? hit.name : '';
  return name !== '' ? name : (typeof p.tag === 'string' && p.tag !== '' ? p.tag : String(p.cash_event_id));
}

function plan_view(ws, plan_ids, p) {
  const id = p.occ_key ?? p.cash_event_id;
  const source = p.rule_id ? 'rule' : (p.occ_key === null || p.occ_key === undefined) && plan_ids.has(p.cash_event_id) ? 'plan' : p.stream_id ? 'stream' : 'debt';
  const nominal = source === 'rule' && typeof p.occ_key === 'string' && p.occ_key.includes('@') ? p.occ_key.slice(p.occ_key.lastIndexOf('@') + 1) : null;
  return {
    id, name: name_of(ws, p, source), date: p.date, amount_minor: p.amount_minor, currency: p.currency, kind: p.kind, source,
    account_id: p.account_id, rule_id: p.rule_id ?? null, nominal,
    can_skip: source === 'plan' || (source === 'rule' && nominal !== null), can_cancel: source === 'plan',
  };
}

function fact_view(f) {
  return {
    id: f.cash_event_id, date: f.date, amount_minor: f.amount_minor, currency: f.currency, account_id: f.account_id,
    tag: typeof f.tag === 'string' ? f.tag : '', note: typeof f.note === 'string' ? f.note : '',
    plan_ref: typeof f.plan_ref === 'string' ? f.plan_ref : null, no_plan: f.no_plan === true,
  };
}

/** Состояния строки в списке «Все факты». */
export const FACT_STATES = Object.freeze(['matched', 'partial', 'double', 'unmatched', 'no_plan', 'outside']);

/**
 * Модель сверки на дату расчёта рабочей области (`ws.as_of`).
 * @param {object} ws
 * @returns {{as_of: number, from: number, window_days: number,
 *   queue: ({kind: 'overdue', plan: object, candidates: object[], sort_amount: number}
 *     | {kind: 'double', reason: string, fact: object, candidates: object[], sort_amount: number}
 *     | {kind: 'partial', plan: object, facts: object[], residual: number, sort_amount: number})[],
 *   counts: {overdue: number, double: number, partial: number},
 *   facts: {fact: object, state: string, plan: object|null, by: string|null}[],
 *   open_plans: object[]}}
 *   `facts` — все факты, новые сверху; `open_plans` — плановые вхождения, к которым можно привязать факт (без сопоставленных)
 * @throws {RunwayError} E_SCHEMA и ошибки данных (форма рабочей области)
 */
export function reconcile_model(ws) {
  const w = normalize_ws(ws);
  const as_of = to_epoch_day(ws.as_of);
  const win = w.params['match.window_days'];
  const from = plan_window_start(ws, as_of);
  const plan_ids = new Set(list_of(ws, 'plans').filter(is_obj).map((p) => p.plan_id));
  const plans = plan_occurrences(ws, from, as_of + win, { as_of, anchor_cut: true });
  const facts_win = w.facts.filter((f) => f.date >= from - win && f.date <= as_of);
  const M = match_plan_to_fact(plans, facts_win, w.params);
  const pv = (p) => plan_view(ws, plan_ids, p);
  const queue = [];

  for (const d of M.doubles) {
    queue.push({ kind: 'double', reason: d.reason, fact: fact_view(d.fact), candidates: d.candidates.map(pv), sort_amount: abs_of(d.fact.amount_minor) });
  }
  for (const r of M.partials) {
    queue.push({ kind: 'partial', plan: pv(r.plan), facts: r.facts.map(fact_view), residual: r.residual, sort_amount: abs_of(r.residual) });
  }
  for (const p of M.unmatched_plans) {
    if (p.status === 'skipped' || p.status === 'cancelled') continue;
    if (classify_occurrence(p, as_of, w.params) !== 'overdue') continue;
    const cand = M.unmatched_facts
      .filter((f) => f.account_id === p.account_id && f.currency === p.currency && sign_of(f.amount_minor) === sign_of(p.amount_minor) && f.date >= p.date - win)
      .sort((a, b) => (abs_of(a.date - p.date) - abs_of(b.date - p.date)) || cmp_str(a.cash_event_id, b.cash_event_id))
      .slice(0, MAX_CANDIDATES);
    queue.push({ kind: 'overdue', plan: pv(p), candidates: cand.map(fact_view), sort_amount: abs_of(p.amount_minor) });
  }
  const item_date = (q) => (q.kind === 'double' ? q.fact.date : q.plan.date);
  const item_id = (q) => (q.kind === 'double' ? q.fact.id : q.plan.id);
  queue.sort((a, b) => (b.sort_amount - a.sort_amount) || (item_date(a) - item_date(b)) || cmp_str(item_id(a), item_id(b)));

  // состояние каждого факта
  const by_fact = new Map();
  for (const m of M.matches) for (const f of m.facts) by_fact.set(f.cash_event_id, { state: 'matched', plan: pv(m.plan), by: m.by });
  for (const r of M.partials) for (const f of r.facts) by_fact.set(f.cash_event_id, { state: 'partial', plan: pv(r.plan), by: 'user' });
  for (const d of M.doubles) by_fact.set(d.fact.cash_event_id, { state: 'double', plan: d.candidates.length === 1 ? pv(d.candidates[0]) : null, by: null });
  for (const f of M.unmatched_facts) by_fact.set(f.cash_event_id, { state: 'unmatched', plan: null, by: null });
  const in_window = new Set(facts_win.map((f) => f.cash_event_id));
  const rows = [...w.facts].sort((a, b) => (b.date - a.date) || cmp_str(a.cash_event_id, b.cash_event_id)).map((f) => {
    const fv = fact_view(f);
    if (f.no_plan === true) return { fact: fv, state: 'no_plan', plan: null, by: 'user' };
    if (!in_window.has(f.cash_event_id)) return { fact: fv, state: 'outside', plan: null, by: null };
    const s = by_fact.get(f.cash_event_id);
    return { fact: fv, state: s?.state ?? 'unmatched', plan: s?.plan ?? null, by: s?.by ?? null };
  });

  // к каким плановым вхождениям можно привязать факт: всё, что ещё не сопоставлено полностью
  const open = new Map();
  for (const p of [...M.unmatched_plans, ...M.partials.map((r) => r.plan), ...M.doubles.flatMap((d) => d.candidates)]) {
    if (p.status === 'skipped' || p.status === 'cancelled') continue;
    open.set(p.occ_key ?? p.cash_event_id, pv(p));
  }
  const counts = { overdue: 0, double: 0, partial: 0 };
  for (const q of queue) counts[q.kind]++;
  return { as_of, from, window_days: win, queue, counts, facts: rows, open_plans: [...open.values()].sort((a, b) => (a.date - b.date) || cmp_str(a.id, b.id)) };
}

/** Планы, к которым можно привязать факт: тот же счёт, валюта и знак; ближайшие по дате первыми. */
export function plans_for_fact(model, fact) {
  return model.open_plans
    .filter((p) => p.account_id === fact.account_id && p.currency === fact.currency && sign_of(p.amount_minor) === sign_of(fact.amount_minor))
    .sort((a, b) => (abs_of(a.date - fact.date) - abs_of(b.date - fact.date)) || cmp_str(a.id, b.id));
}

/** Страница списка фактов: `{rows, page, pages, total}`; номер страницы с нуля, выходящий за границы — к границе. */
export function facts_page(model, page, size = PAGE_SIZE) {
  const total = model.facts.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(0, Number.isSafeInteger(page) ? page : 0), pages - 1);
  return { rows: model.facts.slice(p * size, p * size + size), page: p, pages, total };
}

// ── узлы ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Состояние экрана и зависимости на один контекст. */
export function make_deps(env = {}) {
  const ports = env.ports ?? clock_ports();
  return { ui: { page: 0 }, focus: create_focus_keeper(ports.now_ms) };
}

/** Таблица в прокручиваемой обёртке: на узком окне прокручивается она, а не вся страница. */
const wrap_table = (t) => h('div', { class: 'table-wrap' }, t);

function money_of(ctx, ws, cur) {
  return fmt_of(env_of(ctx, ws), cur);
}

function plan_line(ctx, ws, p) {
  const f = money_of(ctx, ws, p.currency);
  return ctx.tr('reconcile.plan_line', { name: p.name, date: f.date(p.date), amount: f.money(p.amount_minor) });
}

function fact_line(ctx, ws, x) {
  const f = money_of(ctx, ws, x.currency);
  const label = x.tag !== '' ? x.tag : ctx.tr('reconcile.no_tag');
  return ctx.tr('reconcile.fact_line', { label, date: f.date(x.date), amount: f.money(x.amount_minor) });
}

function run_edit(ctx, deps, edit, done_text, focus_id) {
  deps.focus.request(focus_id);
  const r = ctx.edit(edit, { reason: edit.type });
  if (r.ok) ctx.notify(done_text, 'info');
  return r;
}

function button(label, id, aria, on_click, cls = 'btn') {
  return h('button', { type: 'button', class: cls, id, 'aria-label': aria, onclick: on_click, text: label });
}

/** Диалог: выбрать план для факта (из списка «Все факты» или кнопки «Привязать к плану…»). */
function open_pick_plan_dialog(ctx, deps, model, ws, fact) {
  const tr = ctx.tr;
  const options = plans_for_fact(model, fact);
  const body = [h('p', { text: fact_line(ctx, ws, fact) })];
  if (options.length === 0) {
    body.push(h('p', { class: 'muted' }, tr('reconcile.pick_plan_none') + ' ', h('a', { class: 'link', href: '#forms', text: tr('reconcile.go_forms') }), '.'));
  } else {
    const select = h('select', { id: 'rc-pick-plan', 'aria-describedby': 'rc-pick-plan-hint' }, options.map((p) => h('option', { value: p.id, text: plan_line(ctx, ws, p) })));
    body.push(
      h('div', { class: 'field' }, h('label', { for: 'rc-pick-plan', text: tr('reconcile.pick_plan_label') }), select, h('p', { id: 'rc-pick-plan-hint', class: 'muted', text: tr('reconcile.pick_plan_hint') })),
      h('div', { class: 'row' }, h('button', {
        type: 'button', class: 'btn primary', id: 'rc-pick-plan-ok', text: tr('reconcile.link'),
        onclick: () => { const r = run_edit(ctx, deps, link_edit(fact.id, select.value), tr('reconcile.done_link'), 'rc-queue-title'); if (r.ok) close_dialog(); },
      })));
  }
  open_dialog(tr('reconcile.pick_plan_title'), tr('reconcile.close'), ...body);
}

/** Диалог: выбрать факт для просроченного платежа. */
function open_pick_fact_dialog(ctx, deps, ws, plan, candidates) {
  const tr = ctx.tr;
  const body = [h('p', { text: plan_line(ctx, ws, plan) })];
  if (candidates.length === 0) {
    body.push(h('p', { class: 'muted', text: tr('reconcile.pick_fact_none') }));
  } else {
    const select = h('select', { id: 'rc-pick-fact', 'aria-describedby': 'rc-pick-fact-hint' }, candidates.map((x) => h('option', { value: x.id, text: fact_line(ctx, ws, x) })));
    body.push(
      h('div', { class: 'field' }, h('label', { for: 'rc-pick-fact', text: tr('reconcile.pick_fact_label') }), select, h('p', { id: 'rc-pick-fact-hint', class: 'muted', text: tr('reconcile.pick_fact_hint') })),
      h('div', { class: 'row' }, h('button', {
        type: 'button', class: 'btn primary', id: 'rc-pick-fact-ok', text: tr('reconcile.link'),
        onclick: () => { const r = run_edit(ctx, deps, link_edit(select.value, plan.id), tr('reconcile.done_link'), 'rc-queue-title'); if (r.ok) close_dialog(); },
      })));
  }
  open_dialog(tr('reconcile.pick_fact_title'), tr('reconcile.close'), ...body);
}

function plan_actions(ctx, deps, ws, q, i, extra = []) {
  const tr = ctx.tr;
  const p = q.plan;
  const f = money_of(ctx, ws, p.currency);
  const who = tr('reconcile.who', { name: p.name, date: f.date(p.date) });
  const skip = skip_plan_edit(p);
  const cancel = cancel_plan_edit(p);
  const row = h('div', { class: 'row rc-actions' }, ...extra);
  if (skip !== null) row.append(button(tr('reconcile.skip'), `rc-skip-${i}`, `${tr('reconcile.skip')}: ${who}`, () => run_edit(ctx, deps, skip, tr('reconcile.done_skip', { name: p.name, date: f.date(p.date) }), 'rc-queue-title')));
  if (cancel !== null) row.append(button(tr('reconcile.cancel'), `rc-cancel-${i}`, `${tr('reconcile.cancel')}: ${who}`, () => run_edit(ctx, deps, cancel, tr('reconcile.done_cancel', { name: p.name, date: f.date(p.date) }), 'rc-queue-title')));
  const nodes = [row];
  if (skip === null) nodes.push(h('p', { class: 'muted rc-note', text: tr(p.source === 'stream' ? 'reconcile.no_skip_stream' : 'reconcile.no_skip_debt') }));
  else if (cancel === null) nodes.push(h('p', { class: 'muted rc-note' }, tr('reconcile.cancel_rule_hint') + ' ', h('a', { class: 'link', href: '#forms', text: tr('reconcile.go_forms') }), '.'));
  return nodes;
}

function queue_item(ctx, deps, model, ws, q, i) {
  const tr = ctx.tr;
  const li = h('li', { class: 'rc-item rc-' + q.kind, id: `rc-item-${i}` });
  if (q.kind === 'overdue') {
    const p = q.plan;
    const f = money_of(ctx, ws, p.currency);
    li.append(
      h('p', { class: 'rc-head' }, h('strong', { text: p.name }), ' · ', f.money(p.amount_minor)),
      h('p', { class: 'rc-state', text: tr('reconcile.overdue', { date: f.date(p.date) }) }),
      h('p', { class: 'muted', text: tr(q.candidates.length === 0 ? 'reconcile.overdue_nofact' : 'reconcile.overdue_cands', { n: q.candidates.length }) }));
    const link = button(tr('reconcile.link_fact'), `rc-link-${i}`, `${tr('reconcile.link_fact')}: ${tr('reconcile.who', { name: p.name, date: f.date(p.date) })}`, () => open_pick_fact_dialog(ctx, deps, ws, p, q.candidates));
    li.append(...plan_actions(ctx, deps, ws, q, i, [link]));
  } else if (q.kind === 'double') {
    const x = q.fact;
    const f = money_of(ctx, ws, x.currency);
    const many = q.candidates.length > 1;
    li.append(
      h('p', { class: 'rc-head' }, h('strong', { text: x.tag !== '' ? x.tag : tr('reconcile.no_tag') }), ' · ', f.money(x.amount_minor), ' · ', f.date(x.date)),
      h('p', { class: 'rc-state', text: tr('reconcile.double_' + q.reason) }));
    let select = null;
    if (many) {
      select = h('select', { id: `rc-plan-${i}`, 'aria-label': tr('reconcile.pick_plan_label') }, q.candidates.map((p) => h('option', { value: p.id, text: plan_line(ctx, ws, p) })));
      li.append(h('div', { class: 'field' }, h('label', { for: `rc-plan-${i}`, text: tr('reconcile.pick_plan_label') }), select));
    } else li.append(h('p', { text: tr('reconcile.double_plan', { plan: plan_line(ctx, ws, q.candidates[0]) }) }));
    const who = fact_line(ctx, ws, x);
    li.append(h('div', { class: 'row rc-actions' },
      button(tr('reconcile.confirm'), `rc-confirm-${i}`, `${tr('reconcile.confirm')}: ${who}`, () => run_edit(ctx, deps, link_edit(x.id, select === null ? q.candidates[0].id : select.value), tr('reconcile.done_link'), 'rc-queue-title'), 'btn primary'),
      button(tr('reconcile.not_related'), `rc-norel-${i}`, `${tr('reconcile.not_related')}: ${who}`, () => run_edit(ctx, deps, no_plan_edit(x.id), tr('reconcile.done_norel'), 'rc-queue-title'))));
  } else {
    const p = q.plan;
    const f = money_of(ctx, ws, p.currency);
    li.append(
      h('p', { class: 'rc-head' }, h('strong', { text: p.name }), ' · ', f.date(p.date)),
      h('p', { class: 'rc-state', text: tr('reconcile.partial', { paid: f.money(p.amount_minor - q.residual), planned: f.money(p.amount_minor), rest: f.money(q.residual) }) }));
    li.append(h('ul', { class: 'plain rc-sub' }, q.facts.map((x) => h('li', { text: fact_line(ctx, ws, x) }))));
    const cands = model.facts.filter((r) => r.state === 'unmatched' && r.fact.account_id === p.account_id && r.fact.currency === p.currency && sign_of(r.fact.amount_minor) === sign_of(p.amount_minor)).map((r) => r.fact).slice(0, MAX_CANDIDATES);
    const link = button(tr('reconcile.link_fact'), `rc-link-${i}`, `${tr('reconcile.link_fact')}: ${tr('reconcile.who', { name: p.name, date: f.date(p.date) })}`, () => open_pick_fact_dialog(ctx, deps, ws, p, cands));
    li.append(...plan_actions(ctx, deps, ws, q, i, [link]));
  }
  return li;
}

function queue_section(ctx, deps, model, ws) {
  const tr = ctx.tr;
  const n = model.queue.length;
  const f = fmt_of(env_of(ctx, ws));
  const sec = h('section', { id: 'rc-queue', class: 'card rc-queue', 'aria-labelledby': 'rc-queue-title' },
    h('h3', { id: 'rc-queue-title', tabindex: '-1', text: tr('reconcile.queue_title', { n }) }));
  if (n === 0) {
    sec.append(h('p', { class: 'banner', role: 'status', id: 'rc-empty', text: tr('reconcile.queue_empty', { date: f.date(model.as_of) }) }),
      h('p', { class: 'muted', id: 'rc-empty-hint' }, tr('reconcile.queue_empty_hint') + ' ', h('a', { class: 'link', href: '#settings', text: tr('reconcile.go_settings') }), '.'));
    return sec;
  }
  sec.append(
    h('p', { class: 'muted', text: tr('reconcile.queue_lead', { overdue: model.counts.overdue, double: model.counts.double, partial: model.counts.partial }) }),
    h('ol', { class: 'plain rc-list', 'aria-labelledby': 'rc-queue-title' }, model.queue.map((q, i) => queue_item(ctx, deps, model, ws, q, i))));
  return sec;
}

function state_text(ctx, ws, r) {
  const tr = ctx.tr;
  if (r.state === 'matched' || r.state === 'partial') {
    const f = r.plan === null ? null : money_of(ctx, ws, r.plan.currency);
    return r.plan === null ? tr('reconcile.state_' + r.state + '_noplan') : tr('reconcile.state_' + r.state, { name: r.plan.name, date: f.date(r.plan.date), by: tr(r.by === 'user' ? 'reconcile.by_user' : 'reconcile.by_auto') });
  }
  if (r.state === 'double' && r.plan !== null) return tr('reconcile.state_double_plan', { name: r.plan.name });
  return tr('reconcile.state_' + r.state);
}

function facts_section(ctx, deps, model, ws) {
  const tr = ctx.tr;
  const pg = facts_page(model, deps.ui.page);
  deps.ui.page = pg.page;
  const sec = h('section', { id: 'rc-facts', class: 'card rc-facts', 'aria-labelledby': 'rc-facts-title' }, h('h3', { id: 'rc-facts-title', text: tr('reconcile.facts_title', { n: pg.total }) }));
  if (pg.total === 0) { sec.append(h('p', { class: 'muted', text: tr('reconcile.facts_none') })); return sec; }
  const rows = pg.rows.map((r, k) => {
    const x = r.fact;
    const f = money_of(ctx, ws, x.currency);
    const who = fact_line(ctx, ws, x);
    const acts = [];
    const idx = pg.page * PAGE_SIZE + k;
    const norel = () => button(tr('reconcile.not_related'), `rc-fn-${idx}`, `${tr('reconcile.not_related')}: ${who}`, () => run_edit(ctx, deps, no_plan_edit(x.id), tr('reconcile.done_norel'), 'rc-facts-title'));
    if (r.state === 'unmatched') {
      acts.push(button(tr('reconcile.link_plan'), `rc-fl-${idx}`, `${tr('reconcile.link_plan')}: ${who}`, () => open_pick_plan_dialog(ctx, deps, model, ws, x)), ' ', norel());
    } else if (r.state === 'matched' && r.by === 'auto') {
      acts.push(norel());
    } else if (r.state === 'matched' || r.state === 'partial' || r.state === 'no_plan') {
      acts.push(button(tr('reconcile.unlink'), `rc-fu-${idx}`, `${tr('reconcile.unlink')}: ${who}`, () => run_edit(ctx, deps, unlink_edit(x.id), tr('reconcile.done_unlink'), 'rc-facts-title')));
    } else if (r.state === 'double') acts.push(h('span', { class: 'muted', text: tr('reconcile.see_queue') }));
    // FP-28: «Исправить» есть и у фактов старше последних, что показывает «Лента» (оговорка об усечении отправляет сюда); перевод (две ноги) не правится
    if (fixable_fact(ws, x.id).ok) acts.push(...(acts.length > 0 ? [' '] : []), button(tr('reconcile.fix'), `rc-fx-${idx}`, `${tr('reconcile.fix')}: ${who}`, () => open_fix_dialog(ctx, x.id, deps)));
    return h('tr', { id: `rc-fact-${idx}` },
      h('td', { text: f.date(x.date) }), h('td', { class: 'num', text: f.money(x.amount_minor) }), h('td', { text: x.tag !== '' ? x.tag : tr('reconcile.no_tag') }),
      h('td', { text: state_text(ctx, ws, r) }), h('td', null, acts));
  });
  sec.append(wrap_table(table(tr('reconcile.facts_caption'), [tr('reconcile.col_date'), tr('reconcile.col_amount'), tr('reconcile.col_label'), tr('reconcile.col_state'), tr('reconcile.col_action')], rows, 'tbl rc-table')));
  const go = (p) => { deps.ui.page = p; deps.focus.request('rc-facts-title'); ctx.refresh(); };
  sec.append(h('div', { class: 'row rc-pager', role: 'group', 'aria-label': tr('reconcile.pager_label') },
    h('button', { type: 'button', class: 'btn', id: 'rc-prev', disabled: pg.page === 0 ? true : null, onclick: () => go(pg.page - 1), text: tr('reconcile.prev') }),
    h('span', { id: 'rc-page', role: 'status', text: tr('reconcile.page', { page: pg.page + 1, pages: pg.pages }) }),
    h('button', { type: 'button', class: 'btn', id: 'rc-next', disabled: pg.page >= pg.pages - 1 ? true : null, onclick: () => go(pg.page + 1), text: tr('reconcile.next') })));
  return sec;
}

/**
 * Экран «Сверка» (#reconcile).
 * @param {object} ctx контекст расширений
 * @param {ReturnType<typeof make_deps>} deps
 * @returns {HTMLElement}
 */
export function render_reconcile(ctx, deps) {
  const tr = ctx.tr;
  const root = h('div', { class: 'view reconcile' }, h('h2', { id: 'view-title', tabindex: '-1', text: tr('reconcile.title') }), h('p', { class: 'lead', text: tr('reconcile.lead') }));
  const ws = ctx.get_ws();
  if (ws === null || ws === undefined) { root.append(h('p', { class: 'muted', text: tr('reconcile.no_data') })); return root; }
  let model;
  try { model = reconcile_model(ws); } catch { root.append(h('p', { class: 'banner', role: 'alert', text: tr('reconcile.model_error') })); return root; }
  const f = fmt_of(env_of(ctx, ws));
  root.append(
    h('p', { class: 'muted', id: 'rc-window', text: tr('reconcile.window', { as_of: f.date(model.as_of), from: f.date(model.from) }) }),
    queue_section(ctx, deps, model, ws), facts_section(ctx, deps, model, ws),
    h('p', { class: 'muted rc-note', text: tr('reconcile.disclaimer') }));
  deps.focus.apply();
  return root;
}

/** Карточка «Обзора»: сколько решений ждёт сверка; пустая очередь — ничего. */
export function render_reconcile_card(ctx) {
  const ws = ctx.get_ws();
  if (ws === null || ws === undefined) return null;
  let model;
  try { model = reconcile_model(ws); } catch { return null; }
  if (model.queue.length === 0) return null;
  const tr = ctx.tr;
  return h('section', { class: 'card rc-card', 'aria-labelledby': 'rc-card-title' },
    h('h3', { id: 'rc-card-title', text: tr('reconcile.card_title') }),
    h('p', { text: tr('reconcile.card_text', { n: model.queue.length, overdue: model.counts.overdue }) }),
    h('p', null, h('a', { class: 'btn primary', href: '#reconcile', text: tr('reconcile.card_go') })));
}
