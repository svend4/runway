// form_sinking.mjs — накопления на редкую трату (sinking funds): форма цели, план взносов, «N взносов на сумму X», пакетное «подтвердить за период»,
// пул целей (FP-08, REQ-069, REQ-070, REQ-071, ALG-05, IDEA-21, IDEA-41).
//
// Цель — резерв `kind = sinking`: целевая сумма, срок, день месяца для взносов (частота в v1 — только месячная) и режим. `refill_to_target`: взнос
// `c_k = min(ceil_div(rem_k, n − k), rem_k)`, сумма цели сходится ровно; `fixed`: взнос задан пользователем, цель может не достигаться, недостача показана числом.
// Плановые взносы автоматически в журнал НЕ пишутся (C-030): накоплено растёт только от записанных взносов. До подтверждения показывается «взносов не подтверждено:
// N на сумму X» (то же число несёт предупреждение `W_RESERVE_BEHIND`); «подтвердить за период» пишет все такие взносы пачкой — одной правкой `confirm_contributions`,
// повтор безвреден. Краевые случаи: цель достигнута — «цель достигнута», взносов нет; до срока нет дат взноса — «до срока нет дат взноса» и недостача числом.
// Все числа — из `engine/sinking_report.mjs` и `engine/sinking.mjs`. Файл: чистая часть и узлы. Расчёт по введённым данным и правилам, не консультация.

import { fail, to_epoch_day, currency_exponent } from '../engine/index.mjs';
import { sinking_plan, reserve_behind_detail, confirm_rows, pool_split_report } from '../engine/sinking_report.mjs';
import { h } from './dom.mjs';
import { apply_edit } from './ws_edit.mjs';
import { format_input_amount, resolve_number_format } from './number_format.mjs';
import {
  bad, first_error, list_of, env_of, fmt_of, parse_money, parse_count, parse_date_input, commit_edits, error_text, text_field, select_field,
  show_field_error, form_card, plural_cat,
} from './forms.mjs';

export const SINKING_MODES = Object.freeze(['refill_to_target', 'fixed']);

const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Резервы `sinking` рабочей области (не привязанные к счёту). */
export function sinking_reserves(ws) {
  return list_of(ws, 'reserves').filter((r) => r?.kind === 'sinking');
}

// ── разбор формы → правка ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Собрать правку `upsert_reserve` для цели накопления из текстовых полей. У существующей цели начальное состояние (`funded_start_minor`, `funded_as_of`)
 * сохраняется: накопленное меняют записи взносов, а не форма.
 * @param {object} ws
 * @param {{reserve_id: string, name: string, mode: string, target?: string, due_date?: string, cadence_day?: string, fixed?: string, funded?: string}} t
 * @param {{cur: string, lang: 'ru'|'en', nf?: any, as_of: string}} env
 * @returns {{ok: true, edit: {type: 'upsert_reserve', reserve: object}}|{ok: false, error: object}}
 */
export function build_sinking_edit(ws, t, env) {
  if (!is_obj(t)) return bad('E_SCHEMA', 'form', 'not_object');
  const name = typeof t.name === 'string' ? t.name.trim() : '';
  if (name === '') return bad('E_SCHEMA', 'name', 'empty');
  if (!SINKING_MODES.includes(t.mode)) return bad('E_SCHEMA', 'mode', 'not_in_list');
  const has = (x) => typeof x === 'string' && x.trim() !== '';
  const target = has(t.target) ? parse_money(t.target, env, 'target') : (t.mode === 'refill_to_target' ? bad('E_SCHEMA', 'target', 'empty') : { ok: true, value: null });
  const due = has(t.due_date) ? parse_date_input(t.due_date, env, 'due_date') : (t.mode === 'refill_to_target' ? bad('E_BAD_DATE', 'due_date', 'empty') : { ok: true, value: null });
  const day = has(t.cadence_day) ? parse_count(t.cadence_day, 'cadence_day', 1, 31) : { ok: true, value: 1 };
  const fixed = t.mode === 'fixed' ? parse_money(t.fixed ?? '', env, 'fixed') : { ok: true, value: null };
  const funded = has(t.funded) ? parse_money(t.funded, env, 'funded', { zero: true }) : { ok: true, value: 0 };
  const err = first_error([target, due, day, fixed, funded]);
  if (err !== null) return err;
  const old = list_of(ws, 'reserves').find((r) => r?.reserve_id === t.reserve_id);
  const reserve = {
    reserve_id: t.reserve_id, kind: 'sinking', name, currency: env.cur, mode: t.mode, cadence: { freq: 'M', day: day.value },
    funded_start_minor: old === undefined ? funded.value : old.funded_start_minor ?? 0, funded_as_of: old === undefined ? env.as_of : old.funded_as_of,
    backed_by_account_id: old?.backed_by_account_id ?? null,
  };
  if (target.value !== null) reserve.target_minor = target.value;
  if (due.value !== null) reserve.due_date = due.value;
  if (fixed.value !== null) reserve.fixed_minor = fixed.value;
  return { ok: true, edit: { type: 'upsert_reserve', reserve } };
}

// ── модель ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Состояние целей накопления для карточки: план взносов вперёд (`sinking_plan`) и неподтверждённые взносы (`reserve_behind_detail`) по каждой цели.
 * @param {{ws: object, ctx: object}} model модель страницы
 * @returns {{reserve: object, plan: object|null, error: string|null, behind: {missed_count: number, missed_minor: number, rows: object[]}|null}[]}
 */
export function sinking_model(model) {
  const ws = model.ws;
  const as_of = ws.as_of;
  let behind = [];
  try { behind = reserve_behind_detail(ws, as_of); } catch { behind = []; }
  return sinking_reserves(ws).map((reserve) => {
    let plan = null;
    let error = null;
    try { plan = sinking_plan(ws, reserve.reserve_id, as_of, { horizon_end: model.ctx.horizon_end }); } catch (e) { error = typeof e?.code === 'string' ? e.code : 'E_SCHEMA'; }
    return { reserve, plan, error, behind: behind.find((b) => b.reserve_id === reserve.reserve_id) ?? null };
  });
}

// ── вид правки `confirm_contributions` ──────────────────────────────────────────────────────────────────────────────

/**
 * Вид правки `confirm_contributions`: `{type, reserve_id, upto?}` — записать неподтверждённые взносы цели (дата не позже `upto`, по умолчанию все до `as_of`)
 * как аллокации `source = schedule` с `allocation_id = sch:<reserve_id>@<дата>`. Повтор безвреден; нет неподтверждённых — `E_SCHEMA` (`nothing_to_confirm`).
 */
export function edit_confirm_contributions(ws, edit, env) {
  for (const k of Object.keys(edit)) if (!['type', 'reserve_id', 'upto'].includes(k)) fail('E_SCHEMA', { field: 'edit', reason: 'unknown_field', key: k.slice(0, 40) });
  if (typeof edit.reserve_id !== 'string') fail('E_SCHEMA', { field: 'reserve_id', reason: 'required' });
  if (edit.upto !== undefined && edit.upto !== null) {
    if (typeof edit.upto !== 'string') fail('E_BAD_DATE', { field: 'upto', reason: 'not_iso_string' });
    try { to_epoch_day(edit.upto); } catch { fail('E_BAD_DATE', { field: 'upto', reason: 'bad_date' }); }
  }
  const rows = confirm_rows(ws, edit.reserve_id, { as_of: env.as_of, upto: edit.upto ?? undefined });
  if (rows.length === 0) fail('E_SCHEMA', { field: 'reserve_id', reason: 'nothing_to_confirm' });
  let cur = ws;
  for (const allocation of rows) {
    const r = apply_edit(cur, { type: 'record_allocation', allocation }, env);
    if (!r.ok) fail(r.error.code, r.error.ctx ?? { field: 'allocation', reason: 'rejected' });
    cur = r.ws;
  }
  return cur;
}

// ── узлы ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Слово «взносов» с числом: «3 взноса». */
export function contributions_text(ctx, n) {
  return ctx.tr('forms.contrib_n_' + plural_cat(ctx.lang(), n), { n });
}

/** Строки состояния цели: статус графика, взносы вперёд, недостача, «цель через N мес.». */
function plan_lines(ctx, f, x) {
  const p = x.plan;
  if (p === null) return [h('p', { class: 'error', text: ctx.tr('forms.sink_error', { code: x.error ?? 'E_SCHEMA' }) })];
  const lines = [];
  if (p.status === 'reached') lines.push(h('p', { class: 'fp08-ok', text: ctx.tr('forms.sink_reached') }));
  else if (p.status === 'no_dates') lines.push(h('p', { class: 'banner tight', text: ctx.tr('forms.sink_no_dates', { shortfall: f.money(p.shortfall_minor) }) }));
  else {
    lines.push(h('p', { text: ctx.tr('forms.sink_plan', { count: contributions_text(ctx, p.n), total: f.money(p.total_minor) }) }));
    if (p.rows.length > 0) lines.push(h('p', { class: 'muted', text: ctx.tr('forms.sink_next', { date: f.date(p.rows[0].date), amount: f.money(p.rows[0].amount_minor) }) }));
  }
  if (p.mode === 'fixed') {
    lines.push(h('p', { text: ctx.tr('forms.sink_fixed', { fixed: f.money(p.fixed_minor), projected: f.money(p.projected_minor) }) }));
    if (p.shortfall_minor > 0 && p.status !== 'no_dates') lines.push(h('p', { class: 'banner tight', text: ctx.tr('forms.sink_shortfall', { shortfall: f.money(p.shortfall_minor) }) }));
    if (p.periods_to_goal !== null && p.periods_to_goal > 0) lines.push(h('p', { class: 'muted', text: ctx.tr('forms.sink_periods', { n: p.periods_to_goal }) }));
  }
  return lines;
}

/**
 * Карточка «Накопления: план взносов»: по каждой цели — накоплено, цель и срок, план («N взносов на сумму X» или «цель достигнута» / «до срока нет дат взноса»),
 * неподтверждённые взносы и кнопка «Подтвердить за период». Нет целей — `null`.
 * @param {object} ctx контекст расширений
 * @returns {HTMLElement|null}
 */
export function render_sinking_card(ctx) {
  const model = ctx.get_model();
  if (model === null || model === undefined) return null;
  const ws = model.ws;
  const items = sinking_model(model);
  if (items.length === 0) return null;
  const env = env_of(ctx, ws);
  const f = fmt_of(env);
  const nodes = [h('h3', { id: 'fp08-card-sink-title', text: ctx.tr('forms.sink_title') })];
  for (const x of items) {
    const r = x.reserve;
    nodes.push(h('div', { class: 'fp08-sink', 'data-reserve': r.reserve_id },
      h('p', null, h('strong', { text: r.name }), ' · ', ctx.tr('forms.sink_head', {
        funded: f.money(x.plan?.funded_open_minor ?? r.funded_start_minor ?? 0), target: r.target_minor === undefined ? ctx.tr('forms.sink_no_target') : f.money(r.target_minor),
        due: r.due_date === undefined ? ctx.tr('forms.sink_no_due') : f.date(r.due_date),
      })),
      ...plan_lines(ctx, f, x),
      x.behind === null ? null : behind_node(ctx, f, x)));
  }
  nodes.push(h('p', { class: 'muted', text: ctx.tr('forms.sink_note') }));
  return h('section', { class: 'card fp08-card', id: 'fp08-card-sink', 'aria-labelledby': 'fp08-card-sink-title' }, nodes);
}

function behind_node(ctx, f, x) {
  const upto = text_field(ctx, 'confirm-' + x.reserve.reserve_id.replace(/[^A-Za-z0-9_-]/g, '_'), 'upto', { type: 'date', hint: ctx.tr('forms.h_confirm_upto') });
  const run = () => {
    const edit = { type: 'confirm_contributions', reserve_id: x.reserve.reserve_id };
    if (upto.input.value !== '') edit.upto = upto.input.value;
    const r = commit_edits(ctx, [edit], 'confirm_contributions');
    if (r.ok) ctx.notify(ctx.tr('forms.sink_confirmed', { name: x.reserve.name }), 'info'); else ctx.notify(error_text(ctx, r.error), 'error');
  };
  return h('div', { class: 'banner tight fp08-behind', role: 'status' },
    h('p', { text: ctx.tr('forms.sink_behind', { count: contributions_text(ctx, x.behind.missed_count), sum: f.money(x.behind.missed_minor) }) }),
    upto.wrap,
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', 'data-act': 'confirm', onclick: run, text: ctx.tr('forms.sink_confirm') })));
}

/**
 * Раздел «Накопления»: карточка плана, форма цели и пул («разделить общий взнос по целям»).
 * @param {object} ctx контекст расширений
 * @returns {HTMLElement}
 */
export function render_sinking(ctx) {
  const ws = ctx.get_ws();
  const model = ctx.get_model();
  const root = h('section', { class: 'fp08-section', id: 'fp08-sec-sinking', 'aria-labelledby': 'fp08-sec-sinking-title' }, h('h3', { id: 'fp08-sec-sinking-title', text: ctx.tr('forms.sinking_title') }));
  if (ws === null || ws === undefined || model === null || model === undefined) { root.append(h('p', { class: 'muted', text: ctx.tr('forms.no_data') })); return root; }
  const env = env_of(ctx, ws);
  const f = fmt_of(env);
  root.append(h('p', { class: 'lead', text: ctx.tr('forms.sinking_lead') }));
  const card = render_sinking_card(ctx);
  root.append(card === null ? h('p', { class: 'muted', text: ctx.tr('forms.sinking_none') }) : card);

  // форма цели
  let editing = null;
  const new_id = ctx.new_id('res');
  const existing = sinking_reserves(ws);
  const sel = select_field(ctx, 'sink', 'reserve_id', [{ value: '', text: ctx.tr('forms.sink_new') }, ...existing.map((r) => ({ value: r.reserve_id, text: r.name }))], '');
  const name = text_field(ctx, 'sink', 'name', { hint: ctx.tr('forms.h_sink_name') });
  const mode = select_field(ctx, 'sink', 'mode', SINKING_MODES.map((m) => ({ value: m, text: ctx.tr('forms.mode_' + m) })), 'refill_to_target', { hint: ctx.tr('forms.h_sink_mode') });
  const target = text_field(ctx, 'sink', 'target', { inputmode: 'decimal', hint: ctx.tr('forms.h_sink_target') });
  const due = text_field(ctx, 'sink', 'due_date', { type: 'date', hint: ctx.tr('forms.h_sink_due') });
  const day = text_field(ctx, 'sink', 'cadence_day', { inputmode: 'numeric', value: '1', hint: ctx.tr('forms.h_sink_day') });
  const fixed = text_field(ctx, 'sink', 'fixed', { inputmode: 'decimal', hint: ctx.tr('forms.h_sink_fixed') });
  const funded = text_field(ctx, 'sink', 'funded', { inputmode: 'decimal', hint: ctx.tr('forms.h_sink_funded') });
  const preview = h('div', { id: 'fp08-sink-preview', class: 'fp08-preview', 'aria-live': 'polite' });
  const texts = () => ({
    reserve_id: editing ?? new_id, name: name.input.value, mode: mode.input.value, target: target.input.value, due_date: due.input.value,
    cadence_day: day.input.value, fixed: fixed.input.value, funded: funded.input.value,
  });
  const draw = () => {
    const built = build_sinking_edit(ws, texts(), env);
    if (!built.ok) { preview.replaceChildren(h('p', { class: 'muted', text: ctx.tr('forms.sink_preview_wait') })); return built; }
    const r = apply_edit(ws, built.edit, { new_id: ctx.new_id, as_of: ws.as_of });
    if (!r.ok) { preview.replaceChildren(h('p', { class: 'error', text: error_text(ctx, r.error) })); return r; }
    let p = null;
    try { p = sinking_plan(r.ws, built.edit.reserve.reserve_id, ws.as_of, { horizon_end: model.ctx.horizon_end }); } catch { p = null; }
    preview.replaceChildren(h('p', { class: 'muted', text: ctx.tr('forms.sink_preview_title') }), ...(p === null ? [] : plan_lines(ctx, f, { plan: p, error: null })));
    return r;
  };
  const fields = [sel, name, mode, target, due, day, fixed, funded];
  sel.input.addEventListener('change', () => {
    editing = sel.input.value === '' ? null : sel.input.value;
    const r = existing.find((x) => x.reserve_id === editing);
    if (r === undefined) return;
    const nf = resolve_number_format(env.lang, env.nf);
    const exp = currency_exponent(r.currency);
    name.input.value = r.name ?? '';
    mode.input.value = r.mode;
    target.input.value = r.target_minor === undefined ? '' : format_input_amount(r.target_minor, exp, nf, true);
    due.input.value = r.due_date ?? '';
    day.input.value = String(r.cadence?.day ?? 1);
    fixed.input.value = r.fixed_minor === undefined ? '' : format_input_amount(r.fixed_minor, exp, nf, true);
    funded.input.value = format_input_amount(r.funded_start_minor ?? 0, exp, nf, true);
    draw();
  });

  for (const x of fields) { x.input.addEventListener('input', draw); x.input.addEventListener('change', draw); }
  const submit = () => {
    const built = build_sinking_edit(ws, texts(), env);
    if (!built.ok) { show_field_error(ctx, fields.find((x) => x.id.endsWith('-' + (built.error.ctx.field ?? ''))) ?? name, built.error); return built; }
    const r = commit_edits(ctx, [built.edit], 'upsert_reserve');
    if (r.ok) ctx.notify(ctx.tr('forms.sink_saved', { name: built.edit.reserve.name }), 'info');
    return r;
  };
  root.append(form_card(ctx, 'sink', ctx.tr('forms.sink_form_title'), ctx.tr('forms.sink_form_lead'), fields, ctx.tr('forms.save'), submit, [preview]).form);

  // пул
  const pool_total = text_field(ctx, 'pool', 'total', { inputmode: 'decimal', hint: ctx.tr('forms.h_pool') });
  const pool_out = h('div', { id: 'fp08-pool-out', class: 'fp08-preview', 'aria-live': 'polite' });
  const pool_submit = () => {
    const m = parse_money(pool_total.input.value, env, 'total');
    if (!m.ok) { show_field_error(ctx, pool_total, m.error); pool_out.replaceChildren(); return m; }
    let rows = [];
    try { rows = pool_split_report(ws, m.value, ws.as_of); } catch { rows = []; }
    if (rows.length === 0) { pool_out.replaceChildren(h('p', { class: 'muted', text: ctx.tr('forms.pool_none') })); return { ok: true }; }
    const name_of = (id) => existing.find((x) => x.reserve_id === id)?.name ?? id;
    pool_out.replaceChildren(h('ul', { class: 'plain' }, rows.map((x) => h('li', { text: ctx.tr('forms.pool_row', { name: name_of(x.reserve_id), weight: f.money(x.weight_minor), share: f.money(x.share_minor) }) }))));
    return { ok: true };
  };
  root.append(form_card(ctx, 'pool', ctx.tr('forms.pool_title'), ctx.tr('forms.pool_lead'), [pool_total], ctx.tr('forms.pool_split'), pool_submit, [pool_out]).form);
  return root;
}
