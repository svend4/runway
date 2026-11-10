// form_tax.mjs — налоговое правило пользователя: форма с предпросмотром конверта, «подтвердить правило», срок годности и записи по проведённым фактам
// (FP-08, REQ-064, REQ-065, REQ-067, REQ-068, REQ-108, ALG-06, IDEA-16, IDEA-42).
//
// Налог здесь — РАСЧЁТ ПО ВВЕДЁННЫМ ПРАВИЛАМ, не консультация: ставок, лимитов, календарей и шаблонов стран в приложении нет, поле «ставка» пусто, пока его не заполнит
// пользователь. Правило — версия `TaxRule`: смена ставки ДОБАВЛЯЕТ версию с датой начала, прошлые версии и сохранённые аллокации не меняются (REQ-065).
// До записи форма показывает «что будет с конвертом»: ближайшие плановые поступления и аллокация по правилу сейчас и по новому правилу.
// «Подтвердить правило» добавляет версию с отметкой проверки `reviewed_at = сегодня` и тем же `ttl_days`: возраст правила считает движок
// (`fresh` / `stale` / `disabled`, формула единая, C-023); при `disabled` числа, зависящие от правила, заменяются текстом «правило не подтверждено с <даты>:
// подтвердите или измените» (расчёт при этом продолжается, C-024). Проведённый доход или платёж, привязанный к резерву, оставляют запись в конверте
// (`tax_hooks`): кнопка «записать в конверт» — пакетная, повтор безвреден. Вид правки `record_posted_allocations` регистрирует пакет.
// Файл: чистая часть и узлы.

import {
  fail, rule_at, rule_age_status, allocation_for_income, allocation_range, reserve_open, to_epoch_day, format_date,
} from '../engine/index.mjs';
import { pending_posted_allocations } from '../engine/tax_hooks.mjs';
import { h } from './dom.mjs';
import { apply_edit } from './ws_edit.mjs';
import { MONTHS_FULL } from './i18n.mjs';
import { format_input_amount, resolve_number_format } from './number_format.mjs';
import {
  bad, first_error, list_of, env_of, fmt_of, parse_count, parse_percent_bp, parse_date_input, commit_edits, apply_chain, error_text, text_field, select_field,
  show_field_error, form_card, kids,
} from './forms.mjs';
import { stream_income_range, next_payout } from './form_hours.mjs';
import { oldest_review_date } from './rule_age.mjs';

export const TAX_ROUNDINGS = Object.freeze(['half_even', 'half_up', 'floor', 'ceil']);

const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const clone = (x) => JSON.parse(JSON.stringify(x));

/** Все версии всех налоговых правил (плоский список). */
export function tax_versions(ws) {
  return list_of(ws, 'tax_rules').flat();
}

/** Идентификаторы правил (по алфавиту, без повторов). */
export function tax_rule_ids(ws) {
  return [...new Set(tax_versions(ws).map((r) => r.tax_rule_id))].sort();
}

/** Версия правила, действующая на дату; нет такой (правило только начнёт действовать) — версия с наибольшим номером. */
export function active_version(ws, tax_rule_id, date) {
  const all = tax_versions(ws);
  const hit = rule_at(all, tax_rule_id, date);
  if (hit !== null) return hit;
  const mine = all.filter((r) => r.tax_rule_id === tax_rule_id);
  return mine.length === 0 ? null : mine.reduce((m, r) => (r.version > m.version ? r : m));
}

/** Момент записи новой версии: не раньше `as_of` и не раньше записи прошлых версий (порядок версий — по `recorded_at`, ничья — по номеру). */
export function next_recorded_at(ws, tax_rule_id, as_of) {
  let at = as_of + 'T12:00:00Z';
  for (const r of tax_versions(ws)) if (r.tax_rule_id === tax_rule_id && typeof r.recorded_at === 'string' && r.recorded_at > at) at = r.recorded_at;
  return at;
}

// ── разбор формы → правки ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Собрать правки из текстовых полей формы правила: при необходимости — новый налоговый резерв, затем версия правила (`upsert_tax_rule`).
 * Ставку вводит пользователь (процент → bp), предзаполненных значений нет.
 * @param {object} ws
 * @param {{tax_rule_id: string, new_reserve_id?: string, name: string, rate: string, stream_id?: string, tag?: string, valid_from?: string,
 *   rounding?: string, reserve_id?: string, ttl_days?: string}} t
 * @param {{cur: string, lang: 'ru'|'en', nf?: any, as_of: string}} env
 * @returns {{ok: true, edits: object[], rule: object}|{ok: false, error: object}}
 */
export function build_tax_edits(ws, t, env) {
  if (!is_obj(t)) return bad('E_SCHEMA', 'form', 'not_object');
  const name = typeof t.name === 'string' ? t.name.trim() : '';
  if (name === '') return bad('E_SCHEMA', 'name', 'empty');
  const rate = parse_percent_bp(t.rate, env, 'rate');
  const from = parse_date_input(t.valid_from === undefined || t.valid_from === '' ? env.as_of : t.valid_from, env, 'valid_from');
  const ttl = typeof t.ttl_days === 'string' && t.ttl_days.trim() !== '' ? parse_count(t.ttl_days, 'ttl_days', 1, 3650) : { ok: true, value: null };
  const err = first_error([rate, from, ttl]);
  if (err !== null) return err;
  const rounding = t.rounding === undefined || t.rounding === '' ? (ws?.params?.rounding ?? 'half_even') : t.rounding;
  if (!TAX_ROUNDINGS.includes(rounding)) return bad('E_SCHEMA', 'rounding', 'not_in_list');
  const stream_ids = [];
  if (typeof t.stream_id === 'string' && t.stream_id !== '') {
    if (!list_of(ws, 'streams').some((s) => s?.stream_id === t.stream_id)) return bad('E_SCHEMA', 'stream_id', 'unknown_stream');
    stream_ids.push(t.stream_id);
  }
  const tags = typeof t.tag === 'string' && t.tag.trim() !== '' ? [t.tag.trim()] : [];
  if (stream_ids.length + tags.length === 0) return bad('E_SCHEMA', 'applies_to', 'empty');
  const edits = [];
  let reserve_id = typeof t.reserve_id === 'string' && t.reserve_id !== '' ? t.reserve_id : null;
  if (reserve_id === null) {
    if (typeof t.new_reserve_id !== 'string' || t.new_reserve_id === '') return bad('E_SCHEMA', 'reserve_id', 'required');
    reserve_id = t.new_reserve_id;
    edits.push({ type: 'upsert_reserve', reserve: {
      reserve_id, kind: 'tax', name, currency: env.cur, funded_start_minor: 0, funded_as_of: env.as_of, tax_rule_id: t.tax_rule_id, backed_by_account_id: null,
    } });
  } else if (!list_of(ws, 'reserves').some((r) => r?.reserve_id === reserve_id && r.kind === 'tax')) return bad('E_SCHEMA', 'reserve_id', 'unknown_reserve');
  const rule = {
    tax_rule_id: t.tax_rule_id, name, kind: 'percent_of_income', rate_bp: rate.value, base: 'gross', applies_to: { stream_ids, tags }, valid_from: from.value,
    valid_to: null, rounding, reserve_id, recorded_at: next_recorded_at(ws, t.tax_rule_id, env.as_of),
  };
  if (ttl.value !== null) { rule.reviewed_at = env.as_of; rule.ttl_days = ttl.value; }
  edits.push({ type: 'upsert_tax_rule', tax_rule: rule });
  return { ok: true, edits, rule };
}

/**
 * Правка «подтвердить правило»: новая версия с теми же ставкой и условиями, `reviewed_at = as_of` и прежним `ttl_days`, действует с `as_of`
 * (прошлые версии и записанные по ним аллокации не меняются). Без `ttl_days` подтверждать нечего: срок годности правила не задан.
 * Уже записанная БУДУЩАЯ версия того же правила (например, смена ставки с 1 декабря) не перекрывается: новая версия действует только до её начала
 * (`valid_to` = начало ближайшей будущей версии), иначе запись с более поздним `recorded_at` молча вытеснила бы запланированную ставку (FP-15, дефект ADV-3).
 * @returns {{ok: true, edit: {type: 'upsert_tax_rule', tax_rule: object}, scheduled_from: string|number|null}|{ok: false, error: object}}
 *   `scheduled_from` — начало ближайшей будущей версии правила, если подтверждение ограничено ею; иначе `null`
 */
export function confirm_edit(ws, tax_rule_id, as_of) {
  const base = active_version(ws, tax_rule_id, as_of);
  if (base === null) return bad('E_SCHEMA', 'tax_rule_id', 'unknown_rule');
  if (!Number.isSafeInteger(base.ttl_days)) return bad('E_SCHEMA', 'ttl_days', 'required');
  const valid_from = to_epoch_day(base.valid_from) > to_epoch_day(as_of) ? base.valid_from : as_of;
  const from_day = to_epoch_day(valid_from);
  if (base.valid_to !== undefined && base.valid_to !== null && to_epoch_day(base.valid_to) <= from_day) return bad('E_RULE_INVALID', 'valid_to', 'rule_ended');
  // ближайшая версия того же правила, которая начнёт действовать позже новой (запланированная смена): новая версия заканчивается там, где она начинается
  let next = null;
  for (const v of tax_versions(ws)) {
    if (v.tax_rule_id !== tax_rule_id || v === base) continue;
    const d = to_epoch_day(v.valid_from);
    if (d > from_day && (next === null || d < to_epoch_day(next))) next = v.valid_from;
  }
  const rule = clone(base);
  delete rule.version;
  rule.valid_from = valid_from;
  rule.reviewed_at = as_of;
  rule.recorded_at = next_recorded_at(ws, tax_rule_id, as_of);
  const limited = next !== null && (base.valid_to === undefined || base.valid_to === null || to_epoch_day(next) < to_epoch_day(base.valid_to));
  if (limited) rule.valid_to = next;
  return { ok: true, edit: { type: 'upsert_tax_rule', tax_rule: rule }, scheduled_from: limited ? next : null };
}

// ── модели ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Состояние правил для карточки: действующая версия, статус срока годности (`fresh|stale|disabled` на `as_of`), возраст, отметка проверки и числа
 * резерва. При `disabled` числа (`now_minor`, `end_minor`) — `null`: интерфейс заменяет их текстом «правило не подтверждено с <даты>» (REQ-067, C-024).
 * @param {{ws: object, ctx: object}} model модель страницы
 * @returns {{id: string, rule: object, status: 'fresh'|'stale'|'disabled', marked: boolean, reviewed_at: string|null, ttl_days: number|null, age_days: number|null,
 *   hidden: boolean, reserve_id: string, reserve_name: string|null, now_minor: number|null, end_minor: number|null}[]}
 */
export function tax_state_model(model) {
  const ws = model.ws;
  const a = model.ctx;
  const asof = a.as_of;
  const out = [];
  for (const id of tax_rule_ids(ws)) {
    const rule = active_version(ws, id, asof);
    if (rule === null) continue;
    let status = 'fresh';
    try { status = rule_age_status(rule, asof); } catch { status = 'fresh'; }
    const marked = rule.reviewed_at !== undefined && rule.reviewed_at !== null;
    const reserve = list_of(ws, 'reserves').find((r) => r?.reserve_id === rule.reserve_id);
    const by = a.reserve?.plan?.by_reserve?.[rule.reserve_id] ?? null;
    const last = a.series.plan.close.length - 1;
    const hidden = status === 'disabled';
    const now_minor = reserve === undefined ? null : reserve_open(reserve, list_of(ws, 'allocations'), asof);
    out.push({
      id, rule, status, marked, reviewed_at: marked ? rule.reviewed_at : null, ttl_days: marked ? rule.ttl_days : null,
      age_days: marked ? asof - to_epoch_day(rule.reviewed_at) : null, hidden, reserve_id: rule.reserve_id, reserve_name: reserve?.name ?? null,
      now_minor: hidden ? null : now_minor, end_minor: hidden || by === null ? null : by.close[last],
    });
  }
  return out;
}

/** Применимо ли правило к плановому доходу: `stream_id` в `stream_ids` либо `tag` в `tags` (C-025). */
function rule_applies(rule, e) {
  const at = rule.applies_to ?? {};
  return (e.stream_id !== null && e.stream_id !== undefined && (at.stream_ids ?? []).includes(e.stream_id))
    || (e.tag !== null && e.tag !== undefined && (at.tags ?? []).includes(e.tag));
}

/** Аллокация по действующим на дату правилам (кроме `skip_id`) — сумма по всем применимым правилам. */
function current_alloc(ws, e, skip_id) {
  let sum = 0;
  const day = e.date;
  for (const id of tax_rule_ids(ws)) {
    if (id === skip_id) continue;
    const r = rule_at(tax_versions(ws), id, day);
    if (r !== null && rule_applies(r, e)) sum += allocation_for_income(e.amount_minor, r);
  }
  return sum;
}

/**
 * Предпросмотр «что будет с конвертом» при вводе правила: ближайшие плановые поступления, к которым оно применимо, и аллокация по правилу сейчас и по
 * новому. Рабочая область не меняется. Правило начинает действовать с `valid_from`: до этой даты остаётся прежняя версия.
 * @param {{ws: object, ctx: object}} model
 * @param {object} candidate правило как его соберёт `build_tax_edits` (`tax_rule`)
 * @param {{rows?: number}} [o]
 * @returns {{rows: {date: string, income_minor: number, now_minor: number, next_minor: number}[], total_now_minor: number, total_next_minor: number, count: number}}
 */
export function envelope_preview(model, candidate, o = {}) {
  const ws = model.ws;
  const a = model.ctx;
  const from = to_epoch_day(candidate.valid_from);
  const items = (a.events?.plan ?? []).filter((e) => e.layer === 'planned' && e.kind === 'income' && e.amount_minor > 0 && rule_applies(candidate, e)).sort((x, y) => x.date - y.date);
  const all = items.map((e) => {
    const now = current_alloc(ws, e, null);
    const base = current_alloc(ws, e, candidate.tax_rule_id);
    const own = e.date >= from ? allocation_for_income(e.amount_minor, candidate) : current_alloc_of(ws, e, candidate.tax_rule_id);
    return { date: format_date(e.date), income_minor: e.amount_minor, now_minor: now, next_minor: base + own };
  });
  return {
    rows: all.slice(0, o.rows ?? 5), count: all.length,
    total_now_minor: all.reduce((s, r) => s + r.now_minor, 0), total_next_minor: all.reduce((s, r) => s + r.next_minor, 0),
  };
}

function current_alloc_of(ws, e, id) {
  const r = rule_at(tax_versions(ws), id, e.date);
  return r !== null && rule_applies(r, e) ? allocation_for_income(e.amount_minor, r) : 0;
}

/**
 * Сводка «Налоги и часы» (REQ-108) по потокам часов: период и диапазон дохода, выплата, аллокация в конверт по правилу и её диапазон, статус правила.
 * @param {{ws: object, ctx: object}} model
 * @returns {{stream: object, payout: object|null, range: {min_minor: number, exp_minor: number, max_minor: number}, envelope: {rule: object, status: string, hidden: boolean,
 *   alloc: {min: number, exp: number, max: number}|null}[]}[]}
 */
export function income_envelope_model(model) {
  const ws = model.ws;
  const a = model.ctx;
  const out = [];
  for (const stream of list_of(ws, 'streams')) {
    const payout = next_payout(a, stream);
    let range;
    try { range = stream_income_range(stream, ws.params?.rounding ?? 'half_even'); } catch { continue; }
    const envelope = [];
    if (payout !== null) {
      const e = { stream_id: stream.stream_id, tag: stream.name, date: payout.date, amount_minor: payout.amount_minor, amount_min_minor: payout.min_minor, amount_max_minor: payout.max_minor };
      for (const id of tax_rule_ids(ws)) {
        const r = rule_at(tax_versions(ws), id, payout.date);
        if (r === null || !rule_applies(r, e)) continue;
        let status = 'fresh';
        try { status = rule_age_status(r, a.as_of); } catch { status = 'fresh'; }
        envelope.push({ rule: r, status, hidden: status === 'disabled', alloc: status === 'disabled' ? null : allocation_range(e, r) });
      }
    }
    out.push({ stream, payout, range, envelope });
  }
  return out;
}

// ── вид правки `record_posted_allocations` ───────────────────────────────────────────────────────────────────────────

function delegate(ws, edit, env) {
  const r = apply_edit(ws, edit, env);
  if (!r.ok) fail(r.error.code, r.error.ctx ?? { field: 'edit', reason: 'rejected' });
  return r.ws;
}

/**
 * Вид правки `record_posted_allocations`: `{type, event_ids?}` — записи в резерве по проведённым доходам (`source = income`, версия правила на дату факта)
 * и платежам с `reserve_id` (`source = release`: `released = min(накоплено, платёж)`); без `event_ids` — по всем фактам, у которых записей ещё нет.
 * Повтор ничего не добавляет (идемпотентность по `allocation_id`). Любой отказ (нет курса, правило с суммой ставок больше 100 %) — отказ всей правки.
 */
export function edit_record_posted_allocations(ws, edit, env) {
  for (const k of Object.keys(edit)) if (!['type', 'event_ids'].includes(k)) fail('E_SCHEMA', { field: 'edit', reason: 'unknown_field', key: k.slice(0, 40) });
  let ids = null;
  if (edit.event_ids !== undefined) {
    if (!Array.isArray(edit.event_ids) || edit.event_ids.length > 500 || edit.event_ids.some((x) => typeof x !== 'string')) fail('E_SCHEMA', { field: 'event_ids', reason: 'list_of_ids' });
    ids = new Set(edit.event_ids);
  }
  let cur = ws;
  for (const p of pending_posted_allocations(ws, { as_of: env.as_of }).filter((x) => ids === null || ids.has(x.event_id))) {
    if (p.error !== undefined) fail(p.error.code, { field: 'event_ids', reason: 'cannot_compute' });
    for (const allocation of p.allocations) cur = delegate(cur, { type: 'record_allocation', allocation }, env);
  }
  return cur;
}

// ── узлы ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Подпись периода выплаты: «октябрь» для месяца, «с … по …» для недели и двух недель. */
export function period_label(ctx, ws, stream, period) {
  const env = env_of(ctx, ws);
  if (stream.period === 'month') {
    const m = Number(format_date(period.start).slice(5, 7)) - 1;
    const name = (MONTHS_FULL[ctx.lang()] ?? MONTHS_FULL.ru)[m];
    return ctx.lang() === 'ru' ? name.toLowerCase() : name;
  }
  const f = fmt_of(env);
  return ctx.tr('forms.period_range', { from: f.date(format_date(period.start)), to: f.date(format_date(period.end)) });
}

function status_chip(ctx, status) {
  return h('span', { class: 'state-chip ' + status, text: ctx.tr('forms.state_' + status) });
}

/**
 * Плашка правила (REQ-067): `stale` и `disabled` — «не подтверждено с <даты>»; `disabled` ещё и говорит, что числа скрыты. Правило без отметки проверки —
 * «проверка не отмечена». Даты показываются в формате ISO (однозначно).
 */
export function rule_banner(ctx, state) {
  if (!state.marked) return h('p', { class: 'muted', text: ctx.tr('forms.tax_unmarked') });
  if (state.status === 'fresh') { // отметка есть, срока годности нет (старые данные): не печатаем «срок годности undefined дн.» (FP-15, дефект ADV-2)
    return h('p', { class: 'muted', text: Number.isSafeInteger(state.ttl_days) ? ctx.tr('forms.tax_fresh', { since: state.reviewed_at, ttl: state.ttl_days }) : ctx.tr('reserveui.rule_no_ttl', { since: state.reviewed_at }) });
  }
  return h('p', { class: state.status === 'disabled' ? 'banner short' : 'banner tight', role: 'status',
    text: ctx.tr(state.status === 'disabled' ? 'forms.tax_disabled_text' : 'forms.tax_stale_text', { since: state.reviewed_at }) });
}

/**
 * Карточка «Налоги и часы» (REQ-108): поток дохода (ставка, диапазон часов и дохода), выплата как событие ленты, аллокация в конверт по правилу пользователя
 * и возраст правила; правило `disabled` заменяет числа текстом. Нет ни потоков, ни правил — `null`.
 * @param {object} ctx контекст расширений
 * @returns {HTMLElement|null}
 */
export function render_tax_hours_card(ctx) {
  const model = ctx.get_model();
  if (model === null || model === undefined) return null;
  const ws = model.ws;
  const env = env_of(ctx, ws);
  const f = fmt_of(env);
  const streams = income_envelope_model(model);
  const rules = tax_state_model(model);
  if (streams.length === 0 && rules.length === 0) return null;
  const nodes = [h('h3', { id: 'fp08-taxhours-title', text: ctx.tr('forms.th_title') })];
  for (const s of streams) {
    const sf = fmt_of(env, s.stream.currency);
    nodes.push(h('p', null, h('strong', { text: s.stream.name }), ' · ', ctx.tr('forms.hours_rate', { rate: sf.money(s.stream.rate_minor) })));
    if (s.payout === null) { nodes.push(h('p', { class: 'muted', text: ctx.tr('forms.th_no_payout') })); continue; }
    const base = {
      period: period_label(ctx, ws, s.stream, s.payout.period), exp: sf.money(s.payout.amount_minor), min: sf.money(s.range.min_minor), max: sf.money(s.range.max_minor),
      date: f.date(format_date(s.payout.date)),
    };
    nodes.push(h('p', { text: ctx.tr('forms.th_income', base) }));
    for (const en of s.envelope) {
      const rate = f.bp(en.rule.rate_bp);
      if (en.hidden) {
        nodes.push(h('p', { class: 'banner short', role: 'status', text: ctx.tr('forms.th_hidden', { rate, since: en.rule.reviewed_at }) }));
      } else {
        nodes.push(h('p', { text: ctx.tr('forms.th_envelope', { rate, exp: f.money(en.alloc.exp), min: f.money(en.alloc.min), max: f.money(en.alloc.max) }) }));
        if (en.status === 'stale') nodes.push(h('p', { class: 'banner tight', role: 'status', text: ctx.tr('forms.tax_stale_text', { since: en.rule.reviewed_at }) }));
      }
    }
  }
  for (const r of rules) {
    nodes.push(h('p', null, h('strong', { text: r.rule.name }), ' · ', ctx.tr('forms.tax_rate', { rate: f.bp(r.rule.rate_bp), version: r.rule.version }), ' ', status_chip(ctx, r.status)));
    nodes.push(rule_banner(ctx, r));
    if (r.hidden) nodes.push(h('p', { text: ctx.tr('forms.tax_hidden_numbers', { since: r.reviewed_at }) }));
    else if (r.now_minor !== null) nodes.push(h('p', { text: ctx.tr('forms.tax_in_envelope', { now: f.money(r.now_minor), end: f.money(r.end_minor ?? r.now_minor) }) }));
  }
  nodes.push(h('p', { class: 'muted', text: ctx.tr('forms.tax_note') }));
  return h('section', { class: 'card fp08-card', id: 'fp08-taxhours', 'aria-labelledby': 'fp08-taxhours-title' }, nodes);
}

/** Резервы, которые пополняет правило со статусом `disabled` (по карте статусов движка): их суммы интерфейс заменяет текстом. */
function rule_ids_disabled(ws, status) {
  const ids = new Set(Object.entries(status).filter(([, st]) => st === 'disabled').map(([id]) => id));
  return tax_versions(ws).filter((r) => ids.has(r.tax_rule_id) && typeof r.reserve_id === 'string').map((r) => r.reserve_id);
}

/**
 * Карточка «проведено, но в конверт не записано»: доходы, подпадающие под правило, и платежи, привязанные к резерву; кнопка пишет все записи сразу.
 * Нет таких фактов — `null`.
 */
export function render_pending_allocations(ctx) {
  const ws = ctx.get_ws();
  if (ws === null || ws === undefined) return null;
  let pending;
  try { pending = pending_posted_allocations(ws); } catch { return null; }
  const rows = pending.filter((p) => p.error === undefined && p.allocations.length > 0);
  if (rows.length === 0) return null;
  const env = env_of(ctx, ws);
  const f = fmt_of(env);
  // FP-15 (REQ-067, C-024): суммы по правилу, не подтверждённому дольше двух сроков годности, заменяются текстом «не подтверждено с <даты>»
  const model = ctx.get_model();
  const status = model?.ctx?.rule_status ?? {};
  const off_reserves = new Set(rule_ids_disabled(ws, status));
  const off_since = off_reserves.size === 0 ? null : (oldest_review_date(ws, model.ctx.as_of, status, 'disabled') ?? ctx.tr('c.na'));
  const is_off = (p) => off_since !== null && p.allocations.some((x) => off_reserves.has(x.reserve_id));
  const sum = rows.filter((p) => !is_off(p)).reduce((s, p) => s + p.allocations.reduce((t, x) => t + x.amount_minor, 0), 0);
  const write = () => {
    const r = commit_edits(ctx, [{ type: 'record_posted_allocations' }], 'record_posted_allocations');
    if (r.ok) ctx.notify(ctx.tr('forms.pend_done', { count: rows.length }), 'info'); else ctx.notify(error_text(ctx, r.error), 'error');
  };
  return h('section', { class: 'card fp08-card', id: 'fp08-pending', 'aria-labelledby': 'fp08-pending-title' },
    h('h3', { id: 'fp08-pending-title', text: ctx.tr('forms.pend_title') }),
    h('p', { class: 'muted', text: ctx.tr('forms.pend_lead') }),
    h('ul', { class: 'plain' }, rows.map((p) => h('li', { text: is_off(p) ? ctx.tr('reserveui.pend_masked', { date: f.date(p.date), since: off_since }) : ctx.tr(p.kind === 'income' ? 'forms.pend_income' : 'forms.pend_payment', {
      date: f.date(p.date), amount: f.money(Math.abs(p.allocations.reduce((t, x) => t + x.amount_minor, 0))),
    }) }))),
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', onclick: write, text: off_since === null ? ctx.tr('forms.pend_write', { sum: f.money(Math.abs(sum)) }) : ctx.tr('reserveui.pend_write_masked') })),
    h('p', { class: 'muted', text: ctx.tr('forms.tax_note') }));
}

/**
 * Раздел «Налог»: правила со статусом и «Подтвердить», форма правила с предпросмотром конверта, записи по проведённым фактам.
 * @param {object} ctx контекст расширений
 * @returns {HTMLElement}
 */
export function render_tax(ctx) {
  const ws = ctx.get_ws();
  const root = h('section', { class: 'fp08-section', id: 'fp08-sec-tax', 'aria-labelledby': 'fp08-sec-tax-title' }, h('h3', { id: 'fp08-sec-tax-title', text: ctx.tr('forms.tax_title') }));
  const model = ctx.get_model();
  if (ws === null || ws === undefined || model === null || model === undefined) { root.append(h('p', { class: 'muted', text: ctx.tr('forms.no_data') })); return root; }
  const env = env_of(ctx, ws);
  const f = fmt_of(env);
  root.append(h('p', { class: 'lead', text: ctx.tr('forms.tax_lead') }), h('p', { class: 'banner', text: ctx.tr('forms.tax_note') }));

  // правила
  const states = tax_state_model(model);
  if (states.length === 0) root.append(h('p', { class: 'muted', text: ctx.tr('forms.tax_none') }));
  else {
    root.append(h('ul', { class: 'plain fp08-taxrules' }, states.map((r) => h('li', { class: 'fp08-taxrule', 'data-rule': r.id },
      h('p', null, h('strong', { text: r.rule.name }), ' · ', ctx.tr('forms.tax_rate', { rate: f.bp(r.rule.rate_bp), version: r.rule.version }), ' ', status_chip(ctx, r.status)),
      rule_banner(ctx, r),
      h('div', { class: 'row' }, h('button', {
        type: 'button', class: 'btn small', 'data-act': 'confirm', disabled: r.ttl_days === null,
        onclick: () => {
          const c = confirm_edit(ctx.get_ws(), r.id, ctx.get_ws().as_of);
          if (!c.ok) { ctx.notify(error_text(ctx, c.error), 'error'); return; }
          const w = commit_edits(ctx, [c.edit], 'upsert_tax_rule');
          if (w.ok) ctx.notify(ctx.tr('forms.tax_confirmed', { name: r.rule.name }), 'info'); else ctx.notify(error_text(ctx, w.error), 'error');
        },
        text: ctx.tr('forms.tax_confirm') }), r.ttl_days === null ? h('span', { class: 'muted', text: ctx.tr('forms.tax_confirm_needs_ttl') }) : null)))));
  }

  // форма
  const tax_streams = list_of(ws, 'streams');
  const tax_reserves = list_of(ws, 'reserves').filter((r) => r?.kind === 'tax');
  const rule_id = ctx.new_id('trl');
  const new_reserve_id = ctx.new_id('res');
  let editing = null;
  const rule_sel = select_field(ctx, 'tax', 'tax_rule_id', [{ value: '', text: ctx.tr('forms.tax_new_rule') }, ...tax_rule_ids(ws).map((id) => ({ value: id, text: active_version(ws, id, ws.as_of)?.name ?? id }))], '');
  const name = text_field(ctx, 'tax', 'name', { hint: ctx.tr('forms.h_tax_name') });
  const rate = text_field(ctx, 'tax', 'rate', { label: ctx.tr('forms.f_rate_tax'), inputmode: 'decimal', hint: ctx.tr('forms.h_tax_rate') });
  const stream = select_field(ctx, 'tax', 'stream_id', [{ value: '', text: ctx.tr('forms.tax_no_stream') }, ...tax_streams.map((s) => ({ value: s.stream_id, text: s.name }))], '');
  const tag = text_field(ctx, 'tax', 'tag', { hint: ctx.tr('forms.h_tax_tag') });
  const valid_from = text_field(ctx, 'tax', 'valid_from', { type: 'date', value: ws.as_of, hint: ctx.tr('forms.h_tax_from') });
  const rounding = select_field(ctx, 'tax', 'rounding', TAX_ROUNDINGS.map((x) => ({ value: x, text: ctx.tr('forms.round_' + x) })), ws.params?.rounding ?? 'half_even');
  const reserve = select_field(ctx, 'tax', 'reserve_id', [{ value: '', text: ctx.tr('forms.tax_new_reserve') }, ...tax_reserves.map((r) => ({ value: r.reserve_id, text: r.name }))], tax_reserves[0]?.reserve_id ?? '');
  const ttl = text_field(ctx, 'tax', 'ttl_days', { inputmode: 'numeric', hint: ctx.tr('forms.h_tax_ttl') });
  const preview = h('div', { id: 'fp08-tax-preview', class: 'fp08-preview', 'aria-live': 'polite' });
  const texts = () => ({
    tax_rule_id: editing ?? rule_id, new_reserve_id, name: name.input.value, rate: rate.input.value, stream_id: stream.input.value, tag: tag.input.value,
    valid_from: valid_from.input.value, rounding: rounding.input.value, reserve_id: reserve.input.value, ttl_days: ttl.input.value,
  });
  const draw = () => {
    const built = build_tax_edits(ws, texts(), env);
    if (!built.ok) { preview.replaceChildren(h('p', { class: 'muted', text: ctx.tr('forms.tax_preview_wait') })); return built; }
    const chk = apply_chain(ws, built.edits, { new_id: ctx.new_id, as_of: ws.as_of });
    if (!chk.ok) { preview.replaceChildren(h('p', { class: 'error', text: error_text(ctx, chk.error) })); return chk; }
    const p = envelope_preview(model, built.rule);
    preview.replaceChildren(...kids(h('p', { class: 'muted', text: ctx.tr('forms.tax_preview_title') }),
      p.count === 0 ? h('p', { text: ctx.tr('forms.tax_preview_none') })
        : h('ul', { class: 'plain' }, p.rows.map((x) => h('li', { text: ctx.tr('forms.tax_preview_row', { date: f.date(x.date), income: f.money(x.income_minor), now: f.money(x.now_minor), next: f.money(x.next_minor) }) }))),
      p.count === 0 ? null : h('p', { text: ctx.tr('forms.tax_preview_total', { now: f.money(p.total_now_minor), next: f.money(p.total_next_minor) }) }),
      h('p', { class: 'muted', text: ctx.tr('forms.tax_note') })));
    return p;
  };
  const fields = [rule_sel, name, rate, stream, tag, valid_from, rounding, reserve, ttl];
  rule_sel.input.addEventListener('change', () => {
    const id = rule_sel.input.value;
    editing = id === '' ? null : id;
    const v = id === '' ? null : active_version(ws, id, ws.as_of);
    if (v === null) return;
    const nf = resolve_number_format(env.lang, env.nf);
    name.input.value = v.name ?? '';
    rate.input.value = format_input_amount(v.rate_bp, 2, nf, true);
    stream.input.value = v.applies_to?.stream_ids?.[0] ?? '';
    tag.input.value = v.applies_to?.tags?.[0] ?? '';
    rounding.input.value = v.rounding;
    reserve.input.value = v.reserve_id;
    ttl.input.value = Number.isSafeInteger(v.ttl_days) ? String(v.ttl_days) : '';
    draw();
  });

  for (const x of fields) { x.input.addEventListener('input', draw); x.input.addEventListener('change', draw); }
  const submit = () => {
    const built = build_tax_edits(ws, texts(), env);
    if (!built.ok) { show_field_error(ctx, fields.find((x) => x.id.endsWith('-' + (built.error.ctx.field ?? ''))) ?? name, built.error); return built; }
    const r = commit_edits(ctx, built.edits, 'upsert_tax_rule');
    if (r.ok) ctx.notify(ctx.tr('forms.tax_saved', { name: built.rule.name }), 'info');
    return r;
  };
  root.append(form_card(ctx, 'tax', ctx.tr('forms.tax_form_title'), ctx.tr('forms.tax_form_lead'), fields, ctx.tr('forms.save'), submit, [preview]).form);
  const pending = render_pending_allocations(ctx);
  if (pending !== null) root.append(pending);
  return root;
}

