// wave_edit.mjs — правки волн платежей (FP-07, REQ-036, ALG-03, IDEA-09): «объединить / разделить / закрепить», «почему вместе?», порог θ и
// таблица чувствительности. Правка хранится как данные по идентификаторам платежей (`wave_overrides` в рабочей области, в журнале — запись
// `wave_override.set`), переживает пересчёт и не воскрешает исчезнувшие платежи: ссылка на платёж, которого нет, даёт `W_OVERRIDE_STALE`
// и показывается как «устарела» с кнопкой «Снять». Записывает только общий путь `ctx.edit` (вид правки `set_wave_override` из ws_edit.mjs).
// Чистая часть (без DOM; проверяется в Node): построение правок, идемпотентность по содержимому, список правок со статусом, порог и таблица.
// DOM-часть: блок слота `waves.actions` под календарём волн. Цвет смысла не несёт: состояние правки и разница волн — словами.
// Карточка волны (S1.5, слот `waves.card`): в конце КАЖДОЙ карточки экрана «Волны» две компактные кнопки — «Почему так» (штатный диалог
// «Почему волна N», `open_wave_why`) и «Править волну» (диалог с теми же правками merge / split / pin: планы `plan_merge`, `plan_split`, `plan_pin`
// и общая запись `apply_override`, что у блока `waves.actions`). Слот отдаёт `render(ctx, card)`, `card = {wave, mode, index}`.
// Расчёт по введённым данным и правилам, не консультация.

import { list_waves_ex, detect_waves, canon, to_epoch_day, format_date } from '../engine/index.mjs';
import { explain_membership, explain_boundary, sweep_waves, stale_overrides, wave_origin, wave_params_of } from '../engine/wave_sweep.mjs';
import { h, table, open_dialog, close_dialog, el_by_id } from './dom.mjs';
import { make_event_namer, open_wave_why } from './why_more.mjs';
import { parse_amount_text, format_input_amount, resolve_number_format } from './number_format.mjs';

// ══ 1. Чистые модели ══════════════════════════════════════════════════════════════════════════════════════════════════

/** Хэш FNV-1a (32 бита) строки: для устойчивого идентификатора правки. Не криптография. */
function fnv(str, seed) {
  let x = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    x ^= str.charCodeAt(i);
    x = Math.imul(x, 16777619) >>> 0;
  }
  return x.toString(16).padStart(8, '0');
}

/**
 * Идентификатор правки по её содержимому: одна и та же правка всегда получает один идентификатор, поэтому повторное нажатие не плодит записи
 * (запись с тем же идентификатором заменяется, а `already_applied` вовсе не пишет).
 * @param {'merge'|'split'|'pin'} action
 * @param {string[]} event_ids
 * @param {{from: string, to: string}} [pin_range]
 * @returns {string} `wov_` + 12 шестнадцатеричных знаков
 */
export function override_id_for(action, event_ids, pin_range) {
  const body = canon({ action, event_ids: [...event_ids].sort(), pin_range: pin_range ?? null });
  return 'wov_' + fnv(body, 2166136261) + fnv(body, 0x9e3779b1).slice(0, 4);
}

function make_edit(action, event_ids, pin_range) {
  const override = { override_id: override_id_for(action, event_ids, pin_range), action, event_ids: [...event_ids] };
  if (pin_range !== undefined) override.pin_range = { from: pin_range.from, to: pin_range.to };
  return { type: 'set_wave_override', override };
}

/**
 * «Объединить с соседней»: правка `merge` по первым платежам двух волн (движок объединит волны, в которых они лежат).
 * @param {{wave: {event_ids: string[]}}[]} items волны по возрастанию начала
 * @param {number} index номер более ранней волны (0…n−2)
 * @returns {{type: 'set_wave_override', override: object}|null} `null` — нет соседней волны
 */
export function plan_merge(items, index) {
  const a = items[index];
  const b = items[index + 1];
  if (a === undefined || b === undefined) return null;
  return make_edit('merge', [a.wave.event_ids[0], b.wave.event_ids[0]]);
}

/**
 * «Разделить перед платежом»: правка `split`; платёж должен быть в волне и не первым (перед первым резать нечего).
 * @param {{wave: {event_ids: string[]}}} item
 * @param {string} event_id
 * @returns {{type: 'set_wave_override', override: object}|null}
 */
export function plan_split(item, event_id) {
  const pos = item.wave.event_ids.indexOf(event_id);
  return pos > 0 ? make_edit('split', [event_id]) : null;
}

/**
 * «Закрепить»: правка `pin` — платежи (и платежи в диапазоне дат `pin_range`) выделяются в отдельную волну. Правка записывается с перечнем платежей
 * (запись без платежей слой записи не принимает), диапазон хранится рядом как введён.
 * @param {string[]} event_ids платежи
 * @param {{from: string, to: string}} [pin_range] ISO-даты, `to ≥ from`
 * @returns {{type: 'set_wave_override', override: object}|null} `null` — нечего закреплять или диапазон перевёрнут
 */
export function plan_pin(event_ids, pin_range) {
  if (event_ids.length === 0) return null;
  if (pin_range !== undefined && pin_range.to < pin_range.from) return null;
  return make_edit('pin', event_ids, pin_range);
}

/**
 * «Закрепить даты»: платежи волн с датами в диапазоне `[from, to]` (включительно) — отдельной волной.
 * @param {{members: {cash_event_id: string, date: number}[]}[]} items волны из `wave_items`
 * @param {string} from ISO-дата
 * @param {string} to ISO-дата
 * @returns {{type: 'set_wave_override', override: object}|null} `null` — диапазон перевёрнут или в нём нет платежей волн
 */
export function plan_pin_range(items, from, to) {
  if (to < from) return null;
  const lo = to_epoch_day(from);
  const hi = to_epoch_day(to);
  const ids = items.flatMap((it) => it.members.filter((e) => e.date >= lo && e.date <= hi).map((e) => e.cash_event_id));
  return plan_pin(ids, { from, to });
}

/** «Снять правку»: удаление записи по идентификатору. */
export function plan_remove(override_id) {
  return { type: 'set_wave_override', override_id, remove: true };
}

/** Такая же правка (тот же идентификатор и содержимое) уже записана? Тогда повторять её не нужно: действие идемпотентно. */
export function already_applied(ws, edit) {
  const o = edit.override;
  if (o === undefined) return false;
  const strip = (x) => { const { seq: _seq, ...rest } = x; return canon(rest); };
  return (ws.wave_overrides ?? []).some((x) => x.override_id === o.override_id && strip(x) === strip(o));
}

/**
 * Правки рабочей области со статусом: `valid` — все платежи на месте, `stale` — часть платежей исчезла (`W_OVERRIDE_STALE`).
 * @param {object} ws
 * @param {{events: object, params: object}} a Analysis
 * @param {'plan'|'worse'} [mode]
 * @returns {{override_id: string, action: string, event_ids: string[], pin_range: object|null, status: 'valid'|'stale', stale_ids: string[]}[]}
 */
export function list_overrides(ws, a, mode = 'plan') {
  const list = ws.wave_overrides ?? [];
  const stale = new Map();
  for (const s of stale_overrides(a.events[mode], a.params, list)) stale.set(s.override_id, s.event_ids);
  return list.map((o) => ({
    override_id: o.override_id ?? '', action: o.action, event_ids: [...(o.event_ids ?? [])], pin_range: o.pin_range ?? null,
    status: stale.has(o.override_id ?? null) ? 'stale' : 'valid', stale_ids: stale.get(o.override_id ?? null) ?? [],
  }));
}

/**
 * Волны для экрана правок: список движка с признаком происхождения (по правилам / изменена правками) и платежами с датами и суммами.
 * @param {{events: object, params: object, series: object}} a Analysis
 * @param {'plan'|'worse'} [mode]
 * @returns {{n: number, wave: object, metrics: object, origin: 'natural'|'edited', members: object[]}[]}
 */
export function wave_items(a, mode = 'plan') {
  const natural = detect_waves(a.events[mode], a.params);
  const by_id = new Map(a.events[mode].map((e) => [e.cash_event_id, e]));
  return list_waves_ex(a, mode).items.map((it, i) => ({
    n: i + 1, wave: it.wave, metrics: it.metrics, origin: wave_origin(natural, it.wave), members: it.wave.event_ids.map((id) => by_id.get(id)),
  }));
}

/** Правка порога волны θ (`set_param`); `null` — вернуть расчёт по умолчанию. */
export function plan_theta(minor) {
  return { type: 'set_param', key: 'wave.threshold_minor', value: minor };
}

/**
 * Таблица чувствительности по порогу θ: строки (θ, число волн, разница с текущим, покрытие) и матрица «разрыв × размах» при текущем θ.
 * Таблица не меняет данные: порог применяется отдельной правкой.
 * @param {{events: object, params: object}} a
 * @param {'plan'|'worse'} [mode]
 * @param {{gaps?: number[], spans?: number[], thetas?: number[]}} [opts]
 */
export function sensitivity(a, mode = 'plan', opts = {}) {
  const ev = a.events[mode];
  const cur = wave_params_of(a.params);
  const theta_rows = sweep_waves(ev, a.params, opts.thetas === undefined ? {} : { thetas: opts.thetas });
  const gaps = [...new Set([...(opts.gaps ?? [0, 1, 2, 3, 5, 7, 10]), cur.g])].sort((x, y) => x - y);
  const spans = [...new Set([...(opts.spans ?? [5, 7, 10, 14, 21]), cur.S])].sort((x, y) => x - y);
  const grid = sweep_waves(ev, a.params, { thetas: [cur.theta], gaps, spans });
  return { current: theta_rows.current, theta_rows: theta_rows.rows, gaps, spans, grid: grid.rows };
}

// ══ 2. DOM-часть ══════════════════════════════════════════════════════════════════════════════════════════════════════

const iso = (d) => format_date(to_epoch_day(d));

/** Состояние пакета: сообщение о последнем действии (показывается после перерисовки). */
export function create_wave_deps() {
  return { status: null };
}

function member_label(ctx, namer, f, e) {
  return namer(e) + ' · ' + f.short(e.date) + ' · ' + f.money(-e.amount_minor);
}

/**
 * Записать правку волны общим путём: такая же правка уже есть — ничего не пишем (`say` сообщает об этом), иначе `ctx.edit` (проверка → пересчёт
 * страницей → журнал → показ). Сообщение об успехе кладётся в `deps.status` до записи: страница перерисовывается внутри `edit` и показывает его один раз.
 * Один путь для блока `waves.actions` и для кнопок карточки волны.
 * @param {object} ctx
 * @param {{status: string|null}} deps
 * @param {{type: string, override?: object}|null} edit правка из `plan_merge` / `plan_split` / `plan_pin` / `plan_remove`
 * @param {string} done_key ключ строки об успехе
 * @param {(text: string) => void} say куда писать сообщение об уже записанной правке
 * @returns {boolean} `true` — правка записана
 */
export function apply_override(ctx, deps, edit, done_key, say) {
  if (edit === null || edit === undefined) return false;
  if (already_applied(ctx.get_ws(), edit)) { say(ctx.tr('scenarios.we_already')); return false; }
  deps.status = ctx.tr(done_key);
  if (!ctx.edit(edit, { reason: edit.type }).ok) { deps.status = null; return false; }
  return true;
}

/** Диалог «Почему вместе?»: правило (разрыв ≤ g, размах < S), шаги платежей, вывод; для вручную собранной волны — пояснение. */
export function open_together(ctx, item, items, mode = 'plan') {
  const model = ctx.get_model();
  if (model === null) return;
  const a = model.ctx;
  const f = ctx.fmt();
  const namer = make_event_namer(ctx.get_ws(), ctx.lang());
  const m = explain_membership(a.events[mode], a.params, item.wave.event_ids);
  const by_id = new Map(a.events[mode].map((e) => [e.cash_event_id, e]));
  const rows = m.steps.map((s) => h('tr', null,
    h('th', { scope: 'row', text: namer(by_id.get(s.event_id)) }),
    h('td', { text: f.short(s.date) }), h('td', { class: 'num', text: f.money(-s.amount_minor) }),
    h('td', { class: 'num', text: s.gap_days === null ? '—' : ctx.tr('scenarios.we_days', { n: s.gap_days }) }),
    h('td', { text: s.gap_days === null ? '—' : ctx.tr(s.gap_ok ? 'scenarios.we_ok' : 'scenarios.we_break') }),
    h('td', { class: 'num', text: ctx.tr('scenarios.we_days', { n: s.span_days }) }),
    h('td', { text: s.span_days === 0 ? '—' : ctx.tr(s.span_ok ? 'scenarios.we_ok' : 'scenarios.we_break') })));
  const idx = items.indexOf(item);
  const next = items[idx + 1];
  const apart = next === undefined ? null : explain_boundary(a.events[mode], a.params, item.wave.event_ids, next.wave.event_ids);
  open_dialog(ctx.tr('scenarios.we_together_title', { n: item.n }), ctx.tr('scenarios.close'),
    h('p', { text: ctx.tr('scenarios.we_rule', { gap: m.gap_days_limit, span: m.max_span_days_limit, theta: f.money(m.threshold_minor) }) }),
    table(ctx.tr('scenarios.we_together_title', { n: item.n }),
      [ctx.tr('scenarios.we_col_payment'), ctx.tr('scenarios.we_col_date'), ctx.tr('scenarios.we_col_amount'), ctx.tr('scenarios.we_col_gap'), ctx.tr('scenarios.we_col_gap_ok'), ctx.tr('scenarios.we_col_span'), ctx.tr('scenarios.we_col_span_ok')], rows),
    h('p', { class: m.together_by_rule ? 'muted' : 'banner tight', role: 'status',
      text: ctx.tr(m.together_by_rule ? 'scenarios.we_by_rule' : 'scenarios.we_by_edit', { gap: m.largest_gap_days, span: m.span_days }) }),
    apart === null ? null : h('p', { text: ctx.tr('scenarios.we_apart_' + apart.reason, { n: item.n + 1, gap: apart.gap_days, gap_limit: apart.gap_days_limit, span: apart.span_days, span_limit: apart.max_span_days_limit }) }));
}

/** Описание правки словами для списка. */
function override_text(ctx, namer, o, by_id) {
  const names = o.event_ids.map((id) => (by_id.has(id) ? namer(by_id.get(id)) : id.split('@')[0])).join(', ');
  const range = o.pin_range === null ? '' : ' · ' + ctx.tr('scenarios.we_range', { from: ctx.fmt().short(o.pin_range.from), to: ctx.fmt().short(o.pin_range.to) });
  return ctx.tr('scenarios.we_action_' + o.action) + ': ' + names + range;
}

/**
 * Блок слота `waves.actions`: правки волн, список правок, порог θ и таблица чувствительности.
 * @param {object} ctx
 * @param {{status: string|null}} deps
 * @returns {HTMLElement[]|null}
 */
export function render_wave_edit(ctx, deps) {
  const model = ctx.get_model();
  if (model === null) return null;
  const a = model.ctx;
  const ws = ctx.get_ws();
  const f = ctx.fmt();
  const namer = make_event_namer(ws, ctx.lang());
  const items = wave_items(a, 'plan');
  const status = h('p', { class: 'muted', role: 'status', 'aria-live': 'polite', text: deps.status ?? '' });
  deps.status = null; // сообщение показано один раз (после правки страница перерисовалась)
  const say = (text) => { status.textContent = text; };
  const apply = (edit, done_key) => { apply_override(ctx, deps, edit, done_key, say); }; // общая запись правки волны (её же использует карточка волны)
  const by_id = new Map(a.events.plan.map((e) => [e.cash_event_id, e]));

  const wave_nodes = items.map((it, i) => {
    const range = it.wave.start === it.wave.end ? f.short(it.wave.start) : f.short(it.wave.start) + ' – ' + f.short(it.wave.end);
    const head = ctx.tr('scenarios.we_wave', { n: it.n, range, count: it.members.length, total: f.money(it.wave.total_out_minor) });
    const sel_split = h('select', { id: 'we-split-' + it.n });
    for (const e of it.members.slice(1)) sel_split.append(h('option', { value: e.cash_event_id, text: member_label(ctx, namer, f, e) }));
    const sel_pin = h('select', { id: 'we-pin-' + it.n });
    for (const e of it.members) sel_pin.append(h('option', { value: e.cash_event_id, text: member_label(ctx, namer, f, e) }));
    return h('li', { class: 'we-wave' },
      h('strong', { id: 'we-wave-h' + it.n, text: head }), ' ',
      h('span', { class: 'tag', text: ctx.tr(it.origin === 'natural' ? 'scenarios.we_origin_natural' : 'scenarios.we_origin_edited') }),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'link', onclick: () => open_together(ctx, it, items), text: ctx.tr('scenarios.we_btn_together') }),
        h('button', { type: 'button', class: 'link', onclick: () => open_wave_why(ctx, it, 'plan'), text: ctx.tr('scenarios.we_btn_why') }),
        i < items.length - 1 ? h('button', { type: 'button', class: 'btn', onclick: () => apply(plan_merge(items, i), 'scenarios.we_done_merge'), text: ctx.tr('scenarios.we_btn_merge', { n: it.n + 1 }) }) : null),
      it.members.length > 1 ? h('div', { class: 'field' },
        h('label', { for: 'we-split-' + it.n, text: ctx.tr('scenarios.we_split_label', { n: it.n }) }), sel_split,
        h('button', { type: 'button', class: 'btn', onclick: () => { const e = plan_split(it, sel_split.value); if (e !== null) apply(e, 'scenarios.we_done_split'); }, text: ctx.tr('scenarios.we_btn_split') })) : null,
      h('div', { class: 'field' },
        h('label', { for: 'we-pin-' + it.n, text: ctx.tr('scenarios.we_pin_label', { n: it.n }) }), sel_pin,
        h('button', { type: 'button', class: 'btn', onclick: () => { const e = plan_pin([sel_pin.value]); if (e !== null) apply(e, 'scenarios.we_done_pin'); }, text: ctx.tr('scenarios.we_btn_pin') })));
  });

  const pin_from = h('input', { id: 'we-pin-from', type: 'date', min: iso(a.as_of), max: iso(a.horizon_end), value: iso(a.as_of) });
  const pin_to = h('input', { id: 'we-pin-to', type: 'date', min: iso(a.as_of), max: iso(a.horizon_end), value: iso(a.as_of) });
  const pin_range = h('div', { class: 'field' },
    h('label', { for: 'we-pin-from', text: ctx.tr('scenarios.we_range_from') }), pin_from,
    h('label', { for: 'we-pin-to', text: ctx.tr('scenarios.we_range_to') }), pin_to,
    h('button', { type: 'button', class: 'btn', text: ctx.tr('scenarios.we_btn_pin_range'), onclick: () => {
      if (pin_to.value < pin_from.value) { say(ctx.tr('scenarios.we_range_bad')); return; }
      const e = plan_pin_range(items, pin_from.value, pin_to.value);
      if (e === null) { say(ctx.tr('scenarios.we_range_empty')); return; }
      apply(e, 'scenarios.we_done_pin');
    } }));

  const list = list_overrides(ws, a, 'plan');
  const ov_rows = list.map((o) => h('tr', null,
    h('th', { scope: 'row', text: override_text(ctx, namer, o, by_id) }),
    h('td', { text: ctx.tr(o.status === 'stale' ? 'scenarios.we_status_stale' : 'scenarios.we_status_valid') }),
    h('td', null, h('button', { type: 'button', class: 'link', 'aria-label': ctx.tr('scenarios.we_btn_remove_label', { what: override_text(ctx, namer, o, by_id) }),
      onclick: () => apply(plan_remove(o.override_id), 'scenarios.we_done_remove'), text: ctx.tr('scenarios.we_btn_remove') }))));

  const edits = h('section', { class: 'card wave-edit', 'aria-labelledby': 'we-h' },
    h('h3', { id: 'we-h', text: ctx.tr('scenarios.we_title') }),
    h('p', { class: 'muted', text: ctx.tr('scenarios.we_lead') }),
    status,
    items.length === 0 ? h('p', { class: 'muted', text: ctx.tr('scenarios.we_none') }) : h('ul', { class: 'plain' }, wave_nodes),
    pin_range,
    h('h4', { id: 'we-list-h', text: ctx.tr('scenarios.we_list') }),
    list.length === 0 ? h('p', { class: 'muted', text: ctx.tr('scenarios.we_list_empty') })
      : table(ctx.tr('scenarios.we_list'), [ctx.tr('scenarios.we_col_edit'), ctx.tr('scenarios.we_col_state'), ctx.tr('scenarios.we_col_action')], ov_rows));

  return [edits, render_threshold(ctx, deps, a, ws, f, say)];
}

/** Порог θ и таблица чувствительности. */
function render_threshold(ctx, deps, a, ws, f, say) {
  const cur = wave_params_of(a.params);
  const cur_code = a.decision_currency;
  const nf = resolve_number_format(ctx.lang(), ws.number_format);
  const exp = f.exp;
  const input = h('input', { id: 'we-theta', type: 'text', inputmode: 'decimal', autocomplete: 'off', value: format_input_amount(cur.theta, exp, nf, true) });
  const save_theta = (minor) => {
    deps.status = ctx.tr('scenarios.we_theta_saved');
    if (!ctx.edit(plan_theta(minor), { reason: 'set_param' }).ok) deps.status = null;
  };
  const sens = sensitivity(a, 'plan');
  const delta_text = (d) => ctx.tr(d === 0 ? 'scenarios.we_delta_same' : d > 0 ? 'scenarios.we_delta_more' : 'scenarios.we_delta_less', { n: Math.abs(d) });
  const theta_rows = sens.theta_rows.map((r) => h('tr', { class: r.current ? 'current' : null },
    h('th', { scope: 'row', text: f.money(r.theta_minor) + (r.current ? ' · ' + ctx.tr('scenarios.we_current') : '') }),
    h('td', { class: 'num', text: String(r.wave_count) }), h('td', { text: delta_text(r.delta_waves) }), h('td', { class: 'num', text: f.money(r.covered_minor) }),
    h('td', null, r.current ? null : h('button', { type: 'button', class: 'link', onclick: () => save_theta(r.theta_minor), 'aria-label': ctx.tr('scenarios.we_take_label', { value: f.money(r.theta_minor) }), text: ctx.tr('scenarios.we_take') }))));
  const cell = (g, S) => {
    const r = sens.grid.find((x) => x.gap_days === g && x.max_span_days === S);
    return h('td', { class: 'num', text: String(r.wave_count) + (r.current ? ' · ' + ctx.tr('scenarios.we_current') : '') });
  };
  const grid_rows = sens.gaps.map((g) => h('tr', null, h('th', { scope: 'row', text: ctx.tr('scenarios.we_days', { n: g }) }), sens.spans.map((S) => cell(g, S))));
  return h('section', { class: 'card wave-threshold', 'aria-labelledby': 'we-theta-h' },
    h('h3', { id: 'we-theta-h', text: ctx.tr('scenarios.we_theta_title') }),
    h('p', { class: 'muted', text: ctx.tr('scenarios.we_theta_lead', { value: f.money(cur.theta) }) }),
    h('div', { class: 'field' }, h('label', { for: 'we-theta', text: ctx.tr('scenarios.we_theta_label', { cur: cur_code }) }), input,
      h('button', { type: 'button', class: 'btn', text: ctx.tr('scenarios.we_theta_save'), onclick: () => {
        const r = parse_amount_text(input.value, cur_code, ctx.lang(), ws.number_format);
        if (!r.ok || r.value < 1) { say(ctx.tr('scenarios.we_theta_bad')); return; }
        save_theta(r.value);
      } }),
      h('button', { type: 'button', class: 'link', text: ctx.tr('scenarios.we_theta_reset'), onclick: () => save_theta(null) })),
    h('details', { class: 'we-sens' }, h('summary', { text: ctx.tr('scenarios.we_sens_title') }),
      h('p', { class: 'muted', text: ctx.tr('scenarios.we_sens_lead') }),
      h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': ctx.tr('scenarios.we_sens_theta') },
        table(ctx.tr('scenarios.we_sens_theta'), [ctx.tr('scenarios.we_col_theta'), ctx.tr('scenarios.we_col_waves'), ctx.tr('scenarios.we_col_diff'), ctx.tr('scenarios.we_col_covered'), ctx.tr('scenarios.we_col_action')], theta_rows)),
      h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': ctx.tr('scenarios.we_sens_grid') },
        table(ctx.tr('scenarios.we_sens_grid'), [ctx.tr('scenarios.we_col_gap_row'), ...sens.spans.map((S) => ctx.tr('scenarios.we_col_span_head', { n: S }))], grid_rows))));
}

// ══ 3. Карточка волны: слот `waves.card` (S1.5) ════════════════════════════════════════════════════════════════════════════

/**
 * Описание карточки, которое приложение отдаёт слоту `waves.card`: `{wave, mode, index}`. `wave` — волна движка (`list_waves_ex`; карточки строятся
 * по списку «по плану», у каждой метрики обоих режимов), `mode` — режим страницы `plan|worse`, `index` — номер карточки в списке с нуля (номер волны
 * на экране — `index + 1`). Чужую форму (нет волны, режима, индекса) блок молча пропускает.
 * @param {any} card
 * @returns {boolean}
 */
export function is_wave_card(card) {
  const w = card?.wave;
  return card !== null && typeof card === 'object' && w !== null && typeof w === 'object' && Array.isArray(w.event_ids) && typeof w.wave_id === 'string'
    && Number.isFinite(w.start) && Number.isFinite(w.end) && (card.mode === 'plan' || card.mode === 'worse') && Number.isInteger(card.index) && card.index >= 0;
}

/**
 * Волна карточки в режиме страницы: `{n, wave, metrics, mode}` для диалога «Почему волна N». Волна ищется по `wave_id`, а если в режиме её нет — по номеру
 * в списке (так же, как экран «Волны» подбирает метрики режима); нет и там — берётся режим «по плану». Совсем нет волны — `null`.
 * @param {{events: object, params: object, series: object}} a Analysis
 * @param {{wave: object, mode: 'plan'|'worse', index: number}} card
 * @returns {{n: number, wave: object, metrics: object, mode: 'plan'|'worse'}|null}
 */
export function wave_item_of(a, card) {
  for (const m of card.mode === 'plan' ? ['plan'] : [card.mode, 'plan']) {
    const items = list_waves_ex(a, m).items;
    const it = items.find((x) => x.wave.wave_id === card.wave.wave_id) ?? items[card.index];
    if (it !== undefined) return { n: card.index + 1, wave: it.wave, metrics: it.metrics, mode: m };
  }
  return null;
}

/**
 * Правки для «Править волну»: волна карточки среди волн «по плану» (правки хранятся по платежам плана, как и в блоке `waves.actions`) и готовые
 * правки: объединить с предыдущей волной, объединить со следующей. «Разделить» и «Закрепить» строятся по выбранному платежу (`plan_split`, `plan_pin`).
 * @param {{events: object, params: object, series: object}} a Analysis
 * @param {{wave: object, index: number}} card
 * @returns {{items: object[], index: number, item: object, merge_prev: object|null, merge_next: object|null}|null} `null` — волны больше нет
 */
export function card_edit_plan(a, card) {
  const items = wave_items(a, 'plan');
  let i = items.findIndex((x) => x.wave.wave_id === card.wave.wave_id);
  if (i < 0) i = card.index;
  const item = items[i];
  if (item === undefined) return null;
  return { items, index: i, item, merge_prev: i > 0 ? plan_merge(items, i - 1) : null, merge_next: plan_merge(items, i) };
}

const wave_range = (f, w) => (w.start === w.end ? f.short(w.start) : f.short(w.start) + ' – ' + f.short(w.end));

/** «Почему так»: штатный диалог «Почему волна N» (разложение потребности волны, сумма строк равна пиковой просадке окна). */
export function open_card_why(ctx, card) {
  const model = ctx.get_model();
  if (model === null || model === undefined) return false;
  const it = wave_item_of(model.ctx, card);
  if (it === null) { ctx.notify(ctx.tr('scenarios.wc_gone'), 'info'); return false; }
  open_wave_why(ctx, it, it.mode);
  return true;
}

/**
 * «Править волну»: диалог с теми же правками, что в блоке `waves.actions` — объединить с соседней, разделить перед платежом, закрепить платёж.
 * Запись — `apply_override` (общий путь `ctx.edit`); после успеха диалог закрывается (страница перерисовалась, его кнопки устарели) и сообщение
 * об итоге читает скринридер. Идентификаторы полей включают режим и номер карточки.
 * @param {object} ctx
 * @param {{status: string|null}} deps
 * @param {{wave: object, mode: 'plan'|'worse', index: number}} card
 * @returns {boolean} `true` — диалог открыт
 */
export function open_card_edit(ctx, deps, card) {
  const model = ctx.get_model();
  const f = ctx.fmt();
  if (model === null || model === undefined || f === null) return false;
  const plan = card_edit_plan(model.ctx, card);
  if (plan === null) { ctx.notify(ctx.tr('scenarios.wc_gone'), 'info'); return false; }
  const { item } = plan;
  const namer = make_event_namer(ctx.get_ws(), ctx.lang());
  const key = card.mode + '-' + card.index;
  const status = h('p', { class: 'muted', role: 'status', 'aria-live': 'polite', text: '' });
  const say = (text) => { status.textContent = text; };
  // страница перерисовалась внутри ctx.edit: кнопка-открыватель стала новым узлом, поэтому после закрытия диалога фокус возвращается на неё
  // (если такой волны уже нет — на заголовок экрана), иначе пользователь клавиатуры и скринридера теряет место
  // Страница может перерисоваться ещё раз сразу после записи (хранилище просит ctx.refresh() через microtask) и снова заменить узел: поэтому фокус
  // возвращается дважды — сразу и в следующем такте, если за это время он ушёл на body (замечено при проверке в настоящем браузере).
  const restore_focus = (only_if_lost = false) => {
    const doc = globalThis.document;
    const active = doc?.activeElement;
    if (only_if_lost && active !== undefined && active !== null && active !== doc.body) return;
    const el = el_by_id('wc-edit-' + key) ?? el_by_id('view-title');
    if (el !== null && el !== undefined && typeof el.focus === 'function') el.focus();
  };
  const apply = (edit, done_key) => {
    if (!apply_override(ctx, deps, edit, done_key, say)) return;
    close_dialog();
    restore_focus();
    setTimeout(() => restore_focus(true), 0);
    ctx.notify(ctx.tr(done_key), 'info');
  };
  const merge_btn = (edit, n) => (edit === null ? null : h('button', { type: 'button', class: 'btn', onclick: () => apply(edit, 'scenarios.we_done_merge'), text: ctx.tr('scenarios.we_btn_merge', { n }) }));
  const sel_split = h('select', { id: 'wcd-split-' + key });
  for (const e of item.members.slice(1)) sel_split.append(h('option', { value: e.cash_event_id, text: member_label(ctx, namer, f, e) }));
  const sel_pin = h('select', { id: 'wcd-pin-' + key });
  for (const e of item.members) sel_pin.append(h('option', { value: e.cash_event_id, text: member_label(ctx, namer, f, e) }));
  open_dialog(ctx.tr('scenarios.wc_edit_title', { n: item.n }), ctx.tr('scenarios.close'),
    h('p', null, h('strong', { text: ctx.tr('scenarios.we_wave', { n: item.n, range: wave_range(f, item.wave), count: item.members.length, total: f.money(item.wave.total_out_minor) }) }), ' ',
      h('span', { class: 'tag', text: ctx.tr(item.origin === 'natural' ? 'scenarios.we_origin_natural' : 'scenarios.we_origin_edited') })),
    h('p', { class: 'muted', text: ctx.tr('scenarios.wc_edit_lead') }),
    status,
    plan.merge_prev === null && plan.merge_next === null ? null
      : h('div', { class: 'actions' }, merge_btn(plan.merge_prev, item.n - 1), merge_btn(plan.merge_next, item.n + 1)),
    item.members.length > 1 ? h('div', { class: 'field' },
      h('label', { for: 'wcd-split-' + key, text: ctx.tr('scenarios.we_split_label', { n: item.n }) }), sel_split,
      h('button', { type: 'button', class: 'btn', onclick: () => { const e = plan_split(item, sel_split.value); if (e !== null) apply(e, 'scenarios.we_done_split'); }, text: ctx.tr('scenarios.we_btn_split') })) : null,
    h('div', { class: 'field' },
      h('label', { for: 'wcd-pin-' + key, text: ctx.tr('scenarios.we_pin_label', { n: item.n }) }), sel_pin,
      h('button', { type: 'button', class: 'btn', onclick: () => { const e = plan_pin([sel_pin.value]); if (e !== null) apply(e, 'scenarios.we_done_pin'); }, text: ctx.tr('scenarios.we_btn_pin') })));
  return true;
}

/**
 * Блок слота `waves.card`: две кнопки в конце карточки волны. У каждой — `aria-label` с номером и датами волны (текст кнопки — начало подписи),
 * идентификатор включает режим и номер карточки (`wc-why-plan-0`, `wc-edit-worse-1`), поэтому на странице они не повторяются.
 * @param {object} ctx
 * @param {{status: string|null}} deps общее состояние пакета (сообщение о правке)
 * @param {{wave: object, mode: 'plan'|'worse', index: number}} card
 * @returns {HTMLElement|null} `null` — карточка не в той форме или данных ещё нет
 */
export function render_wave_card(ctx, deps, card) {
  if (!is_wave_card(card)) return null;
  const f = ctx.fmt();
  if (f === null || f === undefined) return null;
  const params = { n: card.index + 1, range: wave_range(f, card.wave) };
  const key = card.mode + '-' + card.index;
  return h('div', { class: 'actions wc-actions' },
    h('button', { type: 'button', class: 'btn', id: 'wc-why-' + key, 'aria-label': ctx.tr('scenarios.wc_why_label', params), onclick: () => open_card_why(ctx, card), text: ctx.tr('scenarios.wc_why') }),
    h('button', { type: 'button', class: 'btn', id: 'wc-edit-' + key, 'aria-label': ctx.tr('scenarios.wc_edit_label', params), onclick: () => open_card_edit(ctx, deps, card), text: ctx.tr('scenarios.wc_edit') }));
}
