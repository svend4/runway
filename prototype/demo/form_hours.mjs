// form_hours.mjs — доход по часам: поток «ставка × часы» с диапазоном дохода, «отработано N часов», карточка «недоработка» и «выплата получена»
// (FP-08, REQ-075, REQ-108, ALG-07, IDEA-18).
//
// Поток (`IncomeStream`): ставка за час, период (месяц / неделя / две недели), лаг выплаты, политика выходных и диапазон часов `min ≤ exp ≤ max` за период.
// Форма показывает диапазон дохода до записи: те же `gross_pay` движка, одно округление за период (G-001: 80 / 93 / 110 ч по 30,00 € →
// 2 400,00 / 2 790,00 / 3 300,00 €). «Отработано N часов» пишет `hours_by_period[начало периода].actual_minutes`: закрытый период с фактом схлопывается
// в факт, идущий поднимает диапазон снизу (D-19). «Недоработка» — `shortfall` движка: `plan_to_date − actual` в минутах и её денежный эффект
// `mul_div(short, rate, 60)` (G-001, 2026-10-20: факт 52 ч при плане 60 ч → 8 ч, 240,00 €); пересчёт ожидаемого дохода — отображаемая оценка, `exp` и план она
// не меняет (C-033). «Выплата получена» пишет проведённый доход со ссылкой на поток и сразу — запись в налоговый конверт по правилу на дату факта (`tax_hooks`).
// Виды правок `set_stream_hours` и `post_income` регистрирует пакет. Файл: чистая часть и узлы. Расчёт по введённым данным и правилам, не консультация.

import {
  fail, validate_stream, gross_pay, period_bounds, shortfall, plan_to_date, format_date, parse_date, to_epoch_day, currency_exponent,
} from '../engine/index.mjs';
import { pending_posted_allocations } from '../engine/tax_hooks.mjs';
import { h } from './dom.mjs';
import { apply_edit } from './ws_edit.mjs';
import { WEEKDAYS_SHORT } from './i18n.mjs';
import { format_input_amount, resolve_number_format } from './number_format.mjs';
import {
  bad, first_error, list_of, env_of, fmt_of, parse_money, parse_count, parse_hours, parse_date_input, open_accounts, account_label,
  commit_edits, error_text, text_field, select_field, show_field_error, form_card,
} from './forms.mjs';

export const STREAM_PERIODS = Object.freeze(['month', 'week', 'biweek']);
export const STREAM_WEEKENDS = Object.freeze(['keep', 'prev', 'next']);

const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const clone = (x) => JSON.parse(JSON.stringify(x));
const MINUTES_MAX = 31 * 24 * 60;

// ── разбор формы → правка ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Собрать правку `upsert_stream` из текстовых полей. Поля, которых в форме нет (`hours_by_period`, `bonus`, `overtime`, `pace_minutes_per_day`), при правке
 * существующего потока сохраняются.
 * @param {object} ws
 * @param {{stream_id: string, name: string, account_id: string, rate: string, period: string, cutoff_weekday?: string, anchor?: string,
 *   pay_lag_days: string, weekend?: string, min_hours: string, exp_hours: string, max_hours: string}} t
 * @param {{cur: string, lang: 'ru'|'en', nf?: any, as_of: string}} env
 * @returns {{ok: true, edit: {type: 'upsert_stream', stream: object}}|{ok: false, error: object}}
 */
export function build_stream_edit(ws, t, env) {
  if (!is_obj(t)) return bad('E_SCHEMA', 'form', 'not_object');
  const name = typeof t.name === 'string' ? t.name.trim() : '';
  if (name === '') return bad('E_SCHEMA', 'name', 'empty');
  const acc = list_of(ws, 'accounts').find((a) => a?.account_id === t.account_id);
  if (acc === undefined) return bad('E_SCHEMA', 'account_id', 'unknown_account');
  if (!STREAM_PERIODS.includes(t.period)) return bad('E_SCHEMA', 'period', 'not_in_list');
  const weekend = t.weekend === undefined || t.weekend === '' ? 'keep' : t.weekend;
  if (!STREAM_WEEKENDS.includes(weekend)) return bad('E_SCHEMA', 'weekend', 'not_in_list');
  const rate = parse_money(t.rate, env, 'rate', { cur: acc.currency });
  const lag = parse_count(t.pay_lag_days, 'pay_lag_days', 0, 60);
  const mn = parse_hours(t.min_hours, env, 'min_hours');
  const ex = parse_hours(t.exp_hours, env, 'exp_hours');
  const mx = parse_hours(t.max_hours, env, 'max_hours');
  const err = first_error([rate, lag, mn, ex, mx]);
  if (err !== null) return err;
  let cutoff = { kind: 'month_end' };
  if (t.period !== 'month') {
    const wd = parse_count(t.cutoff_weekday ?? '', 'cutoff_weekday', 0, 6);
    if (!wd.ok) return wd;
    cutoff = { kind: 'weekday', weekday: wd.value };
    if (t.period === 'biweek') {
      const a = parse_date_input(t.anchor, env, 'anchor');
      if (!a.ok) return a;
      cutoff.anchor = a.value;
    }
  }
  const old = list_of(ws, 'streams').find((s) => s?.stream_id === t.stream_id);
  const stream = {
    ...(old === undefined ? {} : clone(old)),
    stream_id: t.stream_id, account_id: acc.account_id, name, currency: acc.currency, rate_minor: rate.value, period: t.period, cutoff,
    pay_lag_days: lag.value, weekend, hours: { min_minutes: mn.value, exp_minutes: ex.value, max_minutes: mx.value },
  };
  if (old === undefined && list_of(ws, 'calendars').length > 0 && weekend !== 'keep') stream.calendar_id = list_of(ws, 'calendars')[0].calendar_id;
  return { ok: true, edit: { type: 'upsert_stream', stream } };
}

/**
 * Диапазон дохода потока за период по диапазону часов: `min ≤ exp ≤ max`, одно округление за период (`gross_pay`, режим — `ws.params.rounding`).
 * @param {{rate_minor: number, hours: {min_minutes: number, exp_minutes: number, max_minutes: number}, overtime?: object|null}} stream
 * @param {'half_even'|'half_up'|'floor'|'ceil'} [rounding]
 * @returns {{min_minor: number, exp_minor: number, max_minor: number}}
 */
export function stream_income_range(stream, rounding = 'half_even') {
  const ot = stream.overtime ?? null;
  return {
    min_minor: gross_pay(stream.rate_minor, stream.hours.min_minutes, ot, rounding),
    exp_minor: gross_pay(stream.rate_minor, stream.hours.exp_minutes, ot, rounding),
    max_minor: gross_pay(stream.rate_minor, stream.hours.max_minutes, ot, rounding),
  };
}

/** Проверка потока до записи (диапазон, лаг, период): `{ok}` либо первая ошибка в виде кода канона. */
export function check_stream(stream) {
  const v = validate_stream(stream);
  return v.ok ? { ok: true } : bad(v.errors[0].code, v.errors[0].field.split('.')[0], v.errors[0].reason);
}

/**
 * Ближайшая плановая выплата потока по расчёту страницы (`Analysis.events`): дата, сумма «по ожиданию», коридор и период, за который она.
 * @param {{events: Object<string, object[]>}} a результат `analyze`
 * @param {object} stream
 * @param {'plan'|'worse'} [mode]
 * @returns {{event_id: string, date: number, amount_minor: number, min_minor: number, max_minor: number, period: {start: number, end: number}}|null}
 */
export function next_payout(a, stream, mode = 'plan') {
  const evs = (a.events?.[mode] ?? []).filter((e) => e.stream_id === stream.stream_id && e.kind === 'income' && e.layer === 'planned' && !String(e.occ_key ?? e.cash_event_id).includes('@bonus@'));
  if (evs.length === 0) return null;
  const e = [...evs].sort((x, y) => (x.date - y.date) || (x.amount_minor - y.amount_minor))[0];
  const nominal = to_epoch_day(String(e.occ_key ?? e.cash_event_id).split('@').pop());
  const period = period_bounds(stream, nominal - stream.pay_lag_days);
  return {
    event_id: e.cash_event_id, date: e.date, amount_minor: e.amount_minor, min_minor: e.amount_min_minor ?? e.amount_minor,
    max_minor: e.amount_max_minor ?? e.amount_minor, period,
  };
}

/**
 * «Недоработка»: на дату `as_of` часы по плану к этому дню, часы по факту и разница в минутах с денежным эффектом (`shortfall` движка).
 * Факт — `hours_by_period[начало периода].actual_minutes`, либо `o.actual_minutes`. Нет факта — состояние `no_fact` (число не выдумывается).
 * `short_minutes > 0` — недоработка, `< 0` — опережение.
 * @returns {{state: 'no_fact'|'short'|'ahead'|'even', period: {start: number, end: number}, plan_minutes: number, actual_minutes: number|null,
 *   short_minutes: number, effect_minor: number, est_minutes: number, est_gross_minor: number}}
 */
export function shortfall_model(ws, stream, as_of, o = {}) {
  const period = period_bounds(stream, as_of);
  const key = format_date(period.start);
  const actual = o.actual_minutes ?? stream.hours_by_period?.[key]?.actual_minutes ?? null;
  const rounding = ws?.params?.rounding ?? 'half_even';
  const plan = plan_to_date(stream, period, as_of, { rounding });
  if (actual === null || actual === undefined) {
    return { state: 'no_fact', period, plan_minutes: plan, actual_minutes: null, short_minutes: 0, effect_minor: 0, est_minutes: 0, est_gross_minor: 0 };
  }
  const s = shortfall(stream, period, as_of, actual, { rounding, as_of });
  return {
    state: s.short_minutes > 0 ? 'short' : s.short_minutes < 0 ? 'ahead' : 'even', period, plan_minutes: plan, actual_minutes: actual,
    short_minutes: s.short_minutes, effect_minor: s.effect_minor, est_minutes: s.est_minutes, est_gross_minor: s.est_gross_minor,
  };
}

/** Правка «отработано N минут за период» (`actual_minutes = null` — снять факт). */
export function actual_hours_edit(stream_id, period_start, actual_minutes) {
  return { type: 'set_stream_hours', stream_id, period_start, actual_minutes };
}

// ── виды правок ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Применить правку-делегата и вернуть рабочую область; отказ — исключение с тем же кодом и контекстом. */
function delegate(ws, edit, env) {
  const r = apply_edit(ws, edit, env);
  if (!r.ok) fail(r.error.code, r.error.ctx ?? { field: 'edit', reason: 'rejected' });
  return r.ws;
}

/**
 * Вид правки `set_stream_hours`: `{type, stream_id, period_start, actual_minutes}`. Начало периода — настоящее начало периода потока (иначе `E_SCHEMA`),
 * минуты — целое от 0 до 31 суток либо `null` (снять факт). Запись идёт через `upsert_stream`, поэтому действуют все его проверки.
 */
export function edit_set_stream_hours(ws, edit, env) {
  for (const k of Object.keys(edit)) if (!['type', 'stream_id', 'period_start', 'actual_minutes'].includes(k)) fail('E_SCHEMA', { field: 'edit', reason: 'unknown_field', key: k.slice(0, 40) });
  const stream = list_of(ws, 'streams').find((s) => s?.stream_id === edit.stream_id);
  if (stream === undefined) fail('E_SCHEMA', { field: 'stream_id', reason: 'unknown_stream' });
  if (typeof edit.period_start !== 'string') fail('E_BAD_DATE', { field: 'period_start', reason: 'not_iso_string' });
  let d;
  try { d = parse_date(edit.period_start); } catch { fail('E_BAD_DATE', { field: 'period_start', reason: 'bad_date' }); }
  if (format_date(d) !== edit.period_start || period_bounds(stream, d).start !== d) fail('E_SCHEMA', { field: 'period_start', reason: 'not_a_period_start' });
  const m = edit.actual_minutes;
  if (m !== null && (!Number.isSafeInteger(m) || m < 0 || m > MINUTES_MAX)) fail('E_SCHEMA', { field: 'actual_minutes', reason: 'range' });
  const by = { ...(is_obj(stream.hours_by_period) ? stream.hours_by_period : {}) };
  const cur = { ...(is_obj(by[edit.period_start]) ? by[edit.period_start] : {}) };
  if (m === null) delete cur.actual_minutes; else cur.actual_minutes = m;
  if (Object.keys(cur).length === 0) delete by[edit.period_start]; else by[edit.period_start] = cur;
  const next = { ...clone(stream), hours_by_period: by };
  if (Object.keys(by).length === 0) delete next.hours_by_period;
  return delegate(ws, { type: 'upsert_stream', stream: next }, env);
}

/**
 * Вид правки `post_income`: `{type, fact}` — проведённый доход (как `add_fact`) и в той же правке записи в налоговый конверт по правилу на дату факта
 * (`on_posted_income`: `source = income`, `rule_version`). Нет применимого правила — просто факт. Всё или ничего.
 */
export function edit_post_income(ws, edit, env) {
  for (const k of Object.keys(edit)) if (!['type', 'fact'].includes(k)) fail('E_SCHEMA', { field: 'edit', reason: 'unknown_field', key: k.slice(0, 40) });
  let cur = delegate(ws, { type: 'add_fact', fact: edit.fact }, env);
  const added = list_of(cur, 'facts').at(-1);
  for (const p of pending_posted_allocations(cur, { as_of: env.as_of }).filter((x) => x.event_id === added.event_id)) {
    for (const allocation of p.allocations) cur = delegate(cur, { type: 'record_allocation', allocation }, env);
  }
  return cur;
}

// ── узлы ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Часы для людей: «93 ч», «93 ч 30 мин» (минус — перед числом). */
export function hours_text(ctx, minutes) {
  const neg = minutes < 0;
  const m = Math.abs(minutes);
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  const s = mm === 0 ? ctx.tr('forms.hours_h', { h: hh }) : ctx.tr('forms.hours_hm', { h: hh, m: mm });
  return (neg ? '−' : '') + s;
}

/** Поле часов при открытии: целые часы — «93», иначе «93:30». */
export function hours_input(minutes) {
  return minutes % 60 === 0 ? String(minutes / 60) : Math.floor(minutes / 60) + ':' + String(minutes % 60).padStart(2, '0');
}

function weekday_options(ctx) {
  const names = WEEKDAYS_SHORT[ctx.lang()] ?? WEEKDAYS_SHORT.ru;
  return [1, 2, 3, 4, 5, 6, 0].map((d) => ({ value: String(d), text: names[(d + 6) % 7] }));
}

/** Строка «ставка × часы» потока в списке: имя, ставка за час, диапазон часов, диапазон дохода. */
function stream_lines(ctx, ws, stream, a) {
  const env = env_of(ctx, ws);
  const f = fmt_of(env, stream.currency);
  const range = stream_income_range(stream, ws.params?.rounding ?? 'half_even');
  const nodes = [
    h('p', null, h('strong', { text: stream.name }), ' · ', ctx.tr('forms.hours_rate', { rate: f.money(stream.rate_minor) })),
    h('p', { text: ctx.tr('forms.hours_range', {
      min_h: hours_text(ctx, stream.hours.min_minutes), exp_h: hours_text(ctx, stream.hours.exp_minutes), max_h: hours_text(ctx, stream.hours.max_minutes),
      min: f.money(range.min_minor), exp: f.money(range.exp_minor), max: f.money(range.max_minor),
    }) }),
  ];
  const p = a === null ? null : next_payout(a, stream);
  if (p !== null) nodes.push(h('p', { text: ctx.tr('forms.hours_payout', { date: fmt_of(env).date(format_date(p.date)), amount: f.money(p.amount_minor) }) }));
  return nodes;
}

/**
 * Карточка «Недоработка» по потокам с фактом часов (`shortfall`): план к сегодняшнему дню, факт, разница с денежным эффектом и оценка за период.
 * Нет потоков — `null`.
 */
export function render_shortfall(ctx) {
  const ws = ctx.get_ws();
  const streams = list_of(ws, 'streams');
  if (ws === null || ws === undefined || streams.length === 0) return null;
  const env = env_of(ctx, ws);
  const rows = streams.map((s) => {
    const f = fmt_of(env, s.currency);
    let m;
    try { m = shortfall_model(ws, s, ws.as_of); } catch { return null; }
    const lines = [h('p', null, h('strong', { text: s.name }))];
    if (m.state === 'no_fact') {
      lines.push(h('p', { class: 'muted', text: ctx.tr('forms.short_no_fact', { plan: hours_text(ctx, m.plan_minutes) }) }));
    } else if (m.state === 'even') {
      lines.push(h('p', { text: ctx.tr('forms.short_even', { plan: hours_text(ctx, m.plan_minutes), actual: hours_text(ctx, m.actual_minutes) }) }));
    } else {
      lines.push(h('p', { class: m.state === 'short' ? 'banner tight' : null, text: ctx.tr(m.state === 'short' ? 'forms.short_short' : 'forms.short_ahead', {
        plan: hours_text(ctx, m.plan_minutes), actual: hours_text(ctx, m.actual_minutes), hours: hours_text(ctx, Math.abs(m.short_minutes)), effect: f.money(Math.abs(m.effect_minor)),
      }) }));
      lines.push(h('p', { class: 'muted', text: ctx.tr('forms.short_estimate', { gross: f.money(m.est_gross_minor), hours: hours_text(ctx, m.est_minutes) }) }));
    }
    return h('div', { class: 'fp08-short', 'data-stream': s.stream_id }, lines);
  }).filter((x) => x !== null);
  if (rows.length === 0) return null;
  return h('section', { class: 'card fp08-card', id: 'fp08-shortfall', 'aria-labelledby': 'fp08-shortfall-title' },
    h('h3', { id: 'fp08-shortfall-title', text: ctx.tr('forms.short_title') }), rows, h('p', { class: 'muted', text: ctx.tr('forms.short_note') }));
}

/**
 * Раздел «Часы»: потоки с диапазоном дохода, форма потока, «отработано N часов» и «выплата получена».
 * @param {object} ctx контекст расширений
 * @returns {HTMLElement}
 */
export function render_hours(ctx) {
  const ws = ctx.get_ws();
  const root = h('section', { class: 'fp08-section', id: 'fp08-sec-hours', 'aria-labelledby': 'fp08-sec-hours-title' }, h('h3', { id: 'fp08-sec-hours-title', text: ctx.tr('forms.hours_title') }));
  if (ws === null || ws === undefined) { root.append(h('p', { class: 'muted', text: ctx.tr('forms.no_data') })); return root; }
  const env = env_of(ctx, ws);
  const model = ctx.get_model();
  const a = model === null ? null : model.ctx;
  const accounts = open_accounts(ws).filter((x) => x.liquidity === 'operating');
  const streams = list_of(ws, 'streams');
  root.append(h('p', { class: 'lead', text: ctx.tr('forms.hours_lead') }));

  // форма потока
  let editing = null;
  const new_id = ctx.new_id('stream');
  const name = text_field(ctx, 'stream', 'name', { hint: ctx.tr('forms.h_stream_name') });
  const account = select_field(ctx, 'stream', 'account_id', accounts.map((x) => ({ value: x.account_id, text: account_label(ws, x.account_id) + ' · ' + x.currency })), accounts[0]?.account_id);
  const rate = text_field(ctx, 'stream', 'rate', { label: ctx.tr('forms.f_rate_hour'), inputmode: 'decimal', hint: ctx.tr('forms.h_stream_rate') });
  const period = select_field(ctx, 'stream', 'period', STREAM_PERIODS.map((p) => ({ value: p, text: ctx.tr('forms.period_' + p) })), 'month');
  const cutoff_wd = select_field(ctx, 'stream', 'cutoff_weekday', weekday_options(ctx), '0', { hint: ctx.tr('forms.h_stream_cutoff') });
  const anchor = text_field(ctx, 'stream', 'anchor', { type: 'date', hint: ctx.tr('forms.h_stream_anchor') });
  const lag = text_field(ctx, 'stream', 'pay_lag_days', { inputmode: 'numeric', value: '0', hint: ctx.tr('forms.h_stream_lag') });
  const weekend = select_field(ctx, 'stream', 'weekend', STREAM_WEEKENDS.map((p) => ({ value: p, text: ctx.tr('forms.weekend_' + p) })), 'next');
  const min_h = text_field(ctx, 'stream', 'min_hours', { inputmode: 'decimal', hint: ctx.tr('forms.h_stream_hours') });
  const exp_h = text_field(ctx, 'stream', 'exp_hours', { inputmode: 'decimal' });
  const max_h = text_field(ctx, 'stream', 'max_hours', { inputmode: 'decimal' });
  const range_line = h('p', { id: 'fp08-stream-range', class: 'fp08-preview', 'aria-live': 'polite' });
  const texts = () => ({
    stream_id: editing ?? new_id, name: name.input.value, account_id: account.input.value, rate: rate.input.value, period: period.input.value,
    cutoff_weekday: cutoff_wd.input.value, anchor: anchor.input.value, pay_lag_days: lag.input.value, weekend: weekend.input.value,
    min_hours: min_h.input.value, exp_hours: exp_h.input.value, max_hours: max_h.input.value,
  });
  const draw_range = () => {
    const built = build_stream_edit(ws, texts(), env);
    if (!built.ok) { range_line.textContent = ctx.tr('forms.hours_preview_wait'); return built; }
    const chk = check_stream(built.edit.stream);
    if (!chk.ok) { range_line.textContent = error_text(ctx, chk.error); return chk; }
    const s = built.edit.stream;
    const g = stream_income_range(s, ws.params?.rounding ?? 'half_even');
    const ff = fmt_of(env, s.currency);
    range_line.textContent = ctx.tr('forms.hours_preview', { min: ff.money(g.min_minor), exp: ff.money(g.exp_minor), max: ff.money(g.max_minor) });
    return built;
  };
  const fields = [name, account, rate, period, cutoff_wd, anchor, lag, weekend, min_h, exp_h, max_h];
  for (const x of fields) { x.input.addEventListener('input', draw_range); x.input.addEventListener('change', draw_range); }
  const submit = () => {
    const built = build_stream_edit(ws, texts(), env);
    if (!built.ok) { show_field_error(ctx, fields.find((x) => x.id.endsWith('-' + (built.error.ctx.field ?? ''))) ?? name, built.error); return built; }
    const r = commit_edits(ctx, [built.edit], 'upsert_stream');
    if (r.ok) ctx.notify(ctx.tr(editing === null ? 'forms.stream_saved' : 'forms.stream_updated', { name: built.edit.stream.name }), 'info');
    return r;
  };
  const stream_form = form_card(ctx, 'stream', ctx.tr('forms.stream_form_title'), ctx.tr('forms.stream_form_lead'), fields, ctx.tr('forms.save'), submit, [range_line]);
  const fill = (s) => {
    editing = s.stream_id;
    const nf = resolve_number_format(env.lang, env.nf);
    name.input.value = s.name ?? '';
    account.input.value = s.account_id;
    rate.input.value = format_input_amount(s.rate_minor, currency_exponent(s.currency), nf, true);
    period.input.value = s.period;
    cutoff_wd.input.value = String(s.cutoff?.weekday ?? 0);
    anchor.input.value = s.cutoff?.anchor ?? '';
    lag.input.value = String(s.pay_lag_days ?? 0);
    weekend.input.value = s.weekend ?? 'keep';
    min_h.input.value = hours_input(s.hours.min_minutes);
    exp_h.input.value = hours_input(s.hours.exp_minutes);
    max_h.input.value = hours_input(s.hours.max_minutes);
    draw_range();
    if (typeof name.input.focus === 'function') name.input.focus();
  };

  // потоки
  if (streams.length === 0) root.append(h('p', { class: 'muted', text: ctx.tr('forms.hours_none') }));
  else {
    root.append(h('ul', { class: 'plain fp08-streams' }, streams.map((s) => h('li', { class: 'fp08-stream', 'data-stream': s.stream_id },
      stream_lines(ctx, ws, s, a), h('button', { type: 'button', class: 'btn small', 'data-act': 'edit', onclick: () => fill(s), text: ctx.tr('forms.rule_edit') })))));
  }
  root.append(stream_form.form);

  if (streams.length > 0) {
    // «отработано N часов»
    const st_options = streams.map((s) => ({ value: s.stream_id, text: s.name }));
    const act_stream = select_field(ctx, 'actual', 'stream_id', st_options, streams[0].stream_id);
    const act_hours = text_field(ctx, 'actual', 'hours', { inputmode: 'decimal', hint: ctx.tr('forms.h_actual') });
    const act_submit = () => {
      const s = streams.find((x) => x.stream_id === act_stream.input.value);
      if (s === undefined) return bad('E_SCHEMA', 'stream_id', 'unknown_stream');
      const m = parse_hours(act_hours.input.value, env, 'hours');
      if (!m.ok) { show_field_error(ctx, act_hours, m.error); return m; }
      const per = period_bounds(s, ws.as_of);
      const r = commit_edits(ctx, [actual_hours_edit(s.stream_id, format_date(per.start), m.value)], 'set_stream_hours');
      if (r.ok) ctx.notify(ctx.tr('forms.actual_saved', { name: s.name, hours: hours_text(ctx, m.value) }), 'info');
      return r;
    };
    root.append(form_card(ctx, 'actual', ctx.tr('forms.actual_title'), ctx.tr('forms.actual_lead'), [act_stream, act_hours], ctx.tr('forms.save'), act_submit).form);

    // «выплата получена»
    const pay_stream = select_field(ctx, 'payout', 'stream_id', st_options, streams[0].stream_id);
    const pay_date = text_field(ctx, 'payout', 'date', { type: 'date', value: ws.as_of, max: ws.as_of, hint: ctx.tr('forms.h_payout_date') });
    const pay_amount = text_field(ctx, 'payout', 'amount', { inputmode: 'decimal', hint: ctx.tr('forms.h_payout_amount') });
    const pay_submit = () => {
      const s = streams.find((x) => x.stream_id === pay_stream.input.value);
      if (s === undefined) return bad('E_SCHEMA', 'stream_id', 'unknown_stream');
      const amt = parse_money(pay_amount.input.value, env, 'amount', { cur: s.currency });
      const dt = parse_date_input(pay_date.input.value, env, 'date');
      const err = first_error([amt, dt]);
      if (err !== null) { show_field_error(ctx, err.error.ctx.field === 'date' ? pay_date : pay_amount, err.error); return err; }
      const edit = { type: 'post_income', fact: { account_id: s.account_id, date: dt.value, amount_minor: amt.value, kind: 'income', stream_id: s.stream_id, tag: s.name } };
      const r = commit_edits(ctx, [edit], 'post_income');
      if (r.ok) ctx.notify(ctx.tr('forms.payout_saved', { name: s.name, amount: fmt_of(env, s.currency).money(amt.value) }), 'info');
      return r;
    };
    root.append(form_card(ctx, 'payout', ctx.tr('forms.payout_title'), ctx.tr('forms.payout_lead'), [pay_stream, pay_date, pay_amount], ctx.tr('forms.payout_save'), pay_submit).form);
  }
  return root;
}
