// why_more.mjs — «почему» у каждого числа (FP-07, REQ-104, IDEA-29, IDEA-45): у волны, у «можно потратить», у вердикта по плану и в штатном диалоге
// «Почему» — строка «Остальное» и сверка «сумма строк равна просадке».
// Чистая часть (без DOM; проверяется в Node): модели разложения. Всё считает движок (explain_narrowest, sts_breakdown, answer_q1, list_waves_ex),
// модуль только группирует события окна так же, как движок (ключ группы `rule_id ?? stream_id ?? tag:… ?? id`) и доводит сумму до итога:
// строки цепочки (вклады групп) + «Остальное» (группы за обрезкой top_k / share_cutoff) − «Поступления в окне» = просадка. Тождество
// проверяется в моделях (`ok`) и выводится на экран словами («сходится»), а не цветом.
// DOM-часть: блок для хука `show_why`, диалоги волны, вердикта и «можно потратить», карточка на «Обзоре». Узлы строит только dom.mjs (текст — textContent).
// FP-47 (REQ-104): под каждым из трёх диалогов — номер расчёта c_… и версия движка (`calc_origin`: тот же `call_id`, что у вызова инструмента с этими аргументами), а у «можно потратить»
// и волны — ещё «Что было бы без…» (`sts_counterfactuals`, `wave_counterfactuals`: полный пересчёт движка без группы платежей, не больше `CF_LIMIT` групп).
// Расчёт по введённым данным и правилам, не консультация.

import {
  explain_narrowest, safe_to_spend, sts_breakdown, answer_q1, default_sts_horizon, get_param, mul_div, to_epoch_day, format_date,
  analyze, wave_metrics, next_income_day, ENGINE_VERSION,
} from '../engine/index.mjs';
import { call_id, call_ref, normalize_args } from '../engine/tools.mjs';
import { label_of, DATA_LABELS } from './i18n.mjs';
import { h, table, open_dialog } from './dom.mjs';
import { LABELS } from '../engine/verifier.mjs';
import { oldest_review_date } from './rule_age.mjs';

// ══ 1. Чистые модели ══════════════════════════════════════════════════════════════════════════════════════════════════

/** Ключ группы цепочки, как у движка (C-025): `rule_id ?? stream_id ?? 'tag:'+tag ?? cash_event_id`. */
export function group_of(e) {
  if (e.rule_id !== undefined && e.rule_id !== null) return e.rule_id;
  if (e.stream_id !== undefined && e.stream_id !== null) return e.stream_id;
  if (typeof e.tag === 'string' && e.tag !== '') return 'tag:' + e.tag;
  return e.cash_event_id;
}

/**
 * Имена событий и групп на языке интерфейса (правила, потоки, плановые записи рабочей области; подписи наборов данных — через `label_of`).
 * @param {object} ws
 * @param {'ru'|'en'} lang
 * @returns {((e: object) => string) & {by_id: (id: string) => string, group: (g: string) => string}}
 */
export function make_event_namer(ws, lang) {
  const names = new Map();
  for (const x of ws?.rules ?? []) names.set(x.rule_id, x.name);
  for (const x of ws?.plans ?? []) names.set(x.plan_id, x.name);
  for (const x of ws?.streams ?? []) names.set(x.stream_id, x.name);
  const by_id = (id) => label_of(lang, id, names.get(id) ?? id);
  const namer = (e) => {
    const key = e.rule_id ?? e.stream_id ?? (e.layer === 'posted' ? null : String(e.cash_event_id ?? '').split('@')[0]);
    if (key !== null && key !== undefined && key !== '' && (names.has(key) || Object.hasOwn(DATA_LABELS, key))) return by_id(key);
    if (typeof e.tag === 'string' && e.tag !== '') return label_of(lang, e.tag, e.tag);
    return by_id(String(e.cash_event_id ?? e.event_id ?? '').split('@')[0]);
  };
  namer.by_id = by_id;
  namer.group = (g) => (String(g).startsWith('tag:') ? label_of(lang, String(g).slice(4), String(g).slice(4)) : by_id(String(g).split('@')[0]));
  return namer;
}

const cmp_str = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Вклады групп в окне `[lo, t]`: расходы по дням `lo…t` включительно (дата `t` — расходы дня до его поступлений) и поступления по дням `lo…t−1`.
 * Цепочка — по убыванию суммы до `explain.top_k` групп или накопленной доли `explain.share_cutoff_bp` (как у движка); всё остальное — «Остальное».
 * Инвариант: `chain + rest − inflow = out_total − offset`.
 * @param {object[]} events эффективные события режима
 * @param {object} params `explain.top_k`, `explain.share_cutoff_bp`
 * @param {number} lo первый день окна (EpochDay)
 * @param {number} t последний день окна — дата узкой точки
 * @returns {{out_total_minor: number, inflow_minor: number, net_minor: number,
 *   chain: {group: string, count: number, amount_minor: number, share_bp: number, cum_bp: number, event_ids: string[], sample: object}[],
 *   rest_minor: number, rest_groups: number}}
 */
export function window_chain(events, params, lo, t) {
  const top_k = get_param(params, 'explain.top_k');
  const cutoff = get_param(params, 'explain.share_cutoff_bp');
  const out = events.filter((e) => e.amount_minor < 0 && to_epoch_day(e.date) >= lo && to_epoch_day(e.date) <= t);
  const inn = events.filter((e) => e.amount_minor > 0 && to_epoch_day(e.date) >= lo && to_epoch_day(e.date) < t);
  const out_total = out.reduce((s, e) => s - e.amount_minor, 0);
  const inflow = inn.reduce((s, e) => s + e.amount_minor, 0);
  const groups = new Map();
  for (const e of [...out].sort((a, b) => (to_epoch_day(a.date) - to_epoch_day(b.date)) || (a.amount_minor - b.amount_minor) || cmp_str(String(a.cash_event_id), String(b.cash_event_id)))) {
    const key = group_of(e);
    if (!groups.has(key)) groups.set(key, { group: key, sum: 0, ids: [], sample: e });
    const g = groups.get(key);
    g.sum += -e.amount_minor;
    g.ids.push(e.cash_event_id);
  }
  const all = [...groups.values()].sort((a, b) => (b.sum - a.sum) || cmp_str(a.group, b.group));
  const chain = [];
  if (out_total > 0) {
    let cum = 0;
    for (const g of all) {
      if (chain.length === top_k) break;
      cum += g.sum;
      const cum_bp = mul_div(cum, 10000, out_total, 'half_even');
      chain.push({ group: g.group, count: g.ids.length, amount_minor: g.sum, share_bp: mul_div(g.sum, 10000, out_total, 'half_even'), cum_bp, event_ids: g.ids, sample: g.sample });
      if (cum_bp >= cutoff) break;
    }
  }
  const chained = chain.reduce((s, c) => s + c.amount_minor, 0);
  return { out_total_minor: out_total, inflow_minor: inflow, net_minor: out_total - inflow, chain, rest_minor: out_total - chained, rest_groups: all.length - chain.length };
}

/**
 * Строки полной цепочки «почему»: группы, «Остальное» (если есть), «Поступления в окне» (если есть); вклад в просадку — со знаком
 * (расходы «+», поступления «−»); `total_minor` — сумма строк; `ok` — она равна `target_minor`.
 * @param {ReturnType<typeof window_chain>} wc
 * @param {number} target_minor ожидаемая просадка
 * @returns {{rows: {kind: 'group'|'rest'|'inflow', group?: string, count?: number, amount_minor: number, share_bp?: number, sample?: object, rest_groups?: number}[],
 *   total_minor: number, target_minor: number, ok: boolean}}
 */
export function reconcile_rows(wc, target_minor) {
  const rows = wc.chain.map((c) => ({ kind: 'group', group: c.group, count: c.count, amount_minor: c.amount_minor, share_bp: c.share_bp, sample: c.sample }));
  if (wc.rest_minor !== 0) rows.push({ kind: 'rest', amount_minor: wc.rest_minor, rest_groups: wc.rest_groups });
  if (wc.inflow_minor !== 0) rows.push({ kind: 'inflow', amount_minor: -wc.inflow_minor });
  const total = rows.reduce((s, r) => s + r.amount_minor, 0);
  return { rows, total_minor: total, target_minor, ok: total === target_minor };
}

/**
 * Полная цепочка узкой точки режима: то же, что штатное «Почему», но с «Остальное» и сверкой с просадкой (REQ-104: сумма строк = просадка).
 * @param {{ctx: object}} model модель страницы (`ctx` — Analysis)
 * @param {'plan'|'worse'} mode
 * @returns {{empty: boolean, point: {date: number, amount_minor: number}, peak: {date: number, amount_minor: number}, drop_minor: number,
 *   rows: ReturnType<typeof reconcile_rows>['rows'], total_minor: number, ok: boolean, counterfactuals: object[]}}
 */
export function narrowest_why(model, mode) {
  const a = model.ctx;
  const ex = explain_narrowest(a.events[mode], a.series[mode], a.params);
  const drop = ex.peak.amount_minor - ex.point.amount_minor;
  const sr = a.series[mode];
  const peak_is_opening = ex.peak.date === sr.from && ex.peak.amount_minor === sr.opening_minor; // пик — остаток на начало (окно начинается в as_of), иначе — после дня пика
  const wc = window_chain(a.events[mode], a.params, ex.peak.date + (peak_is_opening ? 0 : 1), ex.point.date);
  const rec = reconcile_rows(wc, drop);
  return { empty: ex.chain.length === 0, point: ex.point, peak: ex.peak, drop_minor: drop, rows: rec.rows, total_minor: rec.total_minor, ok: rec.ok, counterfactuals: ex.counterfactuals };
}

/**
 * «Почему» у волны: из чего сложилась пиковая просадка окна волны `R = cash − min trough` (D-10): платежи окна по группам до узкой точки окна,
 * «Остальное» и поступления до неё.
 * @param {{ctx: object}} model
 * @param {'plan'|'worse'} mode
 * @param {{wave: object, metrics: object}} item элемент `list_waves_ex(a, mode).items`
 * @returns {{wave_id: string, start: number, end: number, window_end: number, cash_minor: number, point: {date: number, amount_minor: number},
 *   r_minor: number, need_minor: number, gap_minor: number, rows: object[], total_minor: number, ok: boolean}}
 */
export function wave_why(model, mode, item) {
  const a = model.ctx;
  const m = item.metrics;
  const wc = window_chain(a.events[mode], a.params, item.wave.start, m.min_trough.date);
  const rec = reconcile_rows(wc, m.r_minor);
  return {
    wave_id: item.wave.wave_id, start: item.wave.start, end: item.wave.end, window_end: m.window_end, cash_minor: m.cash_minor, point: m.min_trough,
    r_minor: m.r_minor, need_minor: m.need_minor, gap_minor: m.gap_minor, rows: rec.rows, total_minor: rec.total_minor, ok: rec.ok,
  };
}

/**
 * «Почему» у «можно потратить»: разложение движка (`sts_breakdown`) с платежами до узкой точки, раскрытыми по группам.
 * Сумма строк равна «минимум свободных денег − буфер» (до обрезки «не меньше нуля»).
 * @param {{ctx: object}} model
 * @param {'plan'|'worse'} mode
 * @param {number|string} [T] дата, до которой считается; по умолчанию — как на «Обзоре» (`default_sts_horizon`)
 * @returns {{gated: true, reason: string}|{gated: false, T: number, at: number, sts_minor: number, short_to_buffer_minor: number, min_free_minor: number,
 *   buffer_minor: number, rows: {id: string, v: number, groups?: object[], rest_minor?: number}[], total_minor: number, ok: boolean}}
 */
export function sts_why(model, mode, T) {
  const a = model.ctx;
  const t = to_epoch_day(T ?? default_sts_horizon(a));
  const s = safe_to_spend(a, t, null, mode);
  if (s.kind === 'insufficient_data') return { gated: true, reason: s.reason };
  const base = sts_breakdown(a, t, null, mode);
  const wc = window_chain(a.events[mode], a.params, a.as_of, s.at);
  const pay = base.find((r) => r.id === 'payments').v; // отрицательная сумма платежей до узкой точки включительно
  const rows = [];
  for (const r of base) {
    if (r.id !== 'payments') { rows.push({ id: r.id, v: r.v }); continue; }
    for (const c of wc.chain) rows.push({ id: 'payment_group', v: -c.amount_minor, group: c.group, count: c.count, sample: c.sample });
    if (wc.rest_minor !== 0) rows.push({ id: 'payment_rest', v: -wc.rest_minor, rest_groups: wc.rest_groups });
  }
  const total = rows.reduce((x, r) => x + r.v, 0);
  const expected = base.reduce((x, r) => x + r.v, 0);
  return {
    gated: false, T: t, at: s.at, sts_minor: s.sts, short_to_buffer_minor: s.short_to_buffer, min_free_minor: s.min_free,
    buffer_minor: a.buffer_minor, rows, total_minor: total, ok: total === expected && -wc.out_total_minor === pay,
  };
}

/**
 * «Почему» у вердикта режима (ответ на «хватит ли к концу горизонта»): `ok` / `tight` / `short`, минимум на счетах, буфер и полная цепочка узкой точки.
 * @param {{ctx: object}} model
 * @param {'plan'|'worse'} mode
 * @returns {{status: 'ok'|'tight'|'short'|'beyond', point: {date: number, amount_minor: number}|null, buffer_minor: number, need_minor: number, why: ReturnType<typeof narrowest_why>|null}}
 */
export function verdict_why(model, mode) {
  const a = model.ctx;
  const B = a.buffer_minor;
  const q = answer_q1(a.series[mode], a.horizon_end, B);
  if (q.beyond_horizon === true) return { status: 'beyond', point: null, buffer_minor: B ?? 0, need_minor: 0, why: null };
  const status = !q.ok_cash ? 'short' : !q.ok_buffer ? 'tight' : 'ok';
  return { status, point: { date: q.at, amount_minor: q.min }, buffer_minor: B ?? 0, need_minor: q.need, why: narrowest_why(model, mode) };
}

// ── происхождение числа: версия движка и номер расчёта c_… (REQ-104) ────────────────────────────────────────────────────────

/**
 * Происхождение числа в диалоге «Почему»: версия движка и номер расчёта `c_…` — тот же, что у вызова инструмента движка с этими аргументами
 * (`call_id(инструмент, аргументы, inputs_hash)`), поэтому номер совпадает с чипом ответа ассистента, если задан тот же вопрос. Инструмент не запускается:
 * номер зависит только от имени, нормализованных аргументов и хэша входов (D-21).
 * @param {{ctx: object}} model
 * @param {string} tool имя инструмента движка
 * @param {object} args аргументы вызова
 * @returns {{tool: string, ref: string, version: string, hash: string}} `hash` — сокращённый `inputs_hash` (8 знаков)
 */
export function calc_origin(model, tool, args) {
  const a = model.ctx;
  return { tool, ref: call_ref(call_id(tool, normalize_args(args), a.inputs_hash)), version: a.engine_version ?? ENGINE_VERSION, hash: a.inputs_hash.slice(0, 8) };
}

/** Происхождение «почему» у вердикта: цепочка и контрфакты берутся из `explain_min_point` режима (как в диалоге узкой точки — один и тот же номер). */
export const verdict_origin = (model, mode) => calc_origin(model, 'explain_min_point', { mode });

/** Происхождение «почему» у «можно потратить»: `get_projection` до даты `T` — в его фактах те же `sts_minor`, `min_free`, `short_to_buffer_minor`. */
export function sts_origin(model, mode, T) {
  const a = model.ctx;
  return calc_origin(model, 'get_projection', { to: format_date(to_epoch_day(T ?? default_sts_horizon(a))), mode });
}

/** Происхождение «почему» у волны: `list_waves` на весь горизонт режима — в его фактах `need`, `cash`, `gap` каждой волны (тот же вызов, что у вопроса о волнах). */
export function wave_origin(model, mode) {
  const a = model.ctx;
  return calc_origin(model, 'list_waves', { from: format_date(a.as_of), to: format_date(a.horizon_end), mode });
}

// ── контрфакты «что было бы без…» для «можно потратить» и волны ───────────────────────────────────────────────────────────────

/** Сколько групп платежей получают контрфакт (как в диалоге вердикта). */
export const CF_LIMIT = 3;

/**
 * Расчёт движка без одной группы платежей: все события группы по всему горизонту убираются операцией сценария `remove_flow` (поверх сценария страницы),
 * дальше работает обычный `analyze` — резервы, налоговые взносы и высвобождение пересчитываются так же, как в основном расчёте.
 * @param {{ws: object, scenario?: object|null, ctx: object}} model
 * @param {'plan'|'worse'} mode
 * @param {string} group ключ группы (`group_of`)
 * @returns {object} `Analysis` только по этому режиму
 */
function analysis_without(model, mode, group) {
  const a = model.ctx;
  const ids = a.events[mode].filter((e) => group_of(e) === group).map((e) => e.cash_event_id);
  const base_ops = a.query?.scenario?.ops ?? [];
  return analyze(model.ws ?? a.ws, { ...a.query, scenario: { ops: [...base_ops, ...ids.map((id) => ({ op: 'remove_flow', event_ref: id }))] }, modes: [mode] });
}

/**
 * Контрфакты «можно потратить»: для первых `CF_LIMIT` групп платежей до узкой точки — сколько можно было бы потратить без группы (полный пересчёт движка).
 * Ряд пуст, если группы пересчитать не удалось.
 * @param {{ws: object, ctx: object}} model
 * @param {'plan'|'worse'} mode
 * @param {{T: number, at: number, sts_minor: number}} w результат `sts_why` (не `gated`)
 * @returns {{group: string, count: number, sts_minor: number, delta_minor: number}[]}
 */
export function sts_counterfactuals(model, mode, w) {
  const a = model.ctx;
  const wc = window_chain(a.events[mode], a.params, a.as_of, w.at);
  const rows = [];
  for (const c of wc.chain.slice(0, CF_LIMIT)) {
    try {
      const s = safe_to_spend(analysis_without(model, mode, c.group), w.T, null, mode);
      if (s.kind === 'insufficient_data') continue;
      rows.push({ group: c.group, count: c.count, sts_minor: s.sts, delta_minor: s.sts - w.sts_minor });
    } catch { /* группа не пересчитывается — строки нет */ }
  }
  return rows;
}

/**
 * Контрфакты волны: окно и состав волны те же, пересчитывается ряд без группы — потребность волны (`R + буфер`) и дефицит стали бы такими.
 * Если без группы потребности не остаётся (меньше 1), показывается 0.
 * @param {{ws: object, ctx: object}} model
 * @param {'plan'|'worse'} mode
 * @param {{wave: object, metrics: object}} item элемент `list_waves_ex(a, mode).items`
 * @returns {{group: string, count: number, need_minor: number, gap_minor: number, delta_minor: number}[]}
 */
export function wave_counterfactuals(model, mode, item) {
  const a = model.ctx;
  const m = item.metrics;
  const wc = window_chain(a.events[mode], a.params, item.wave.start, m.min_trough.date);
  const B = a.buffer_minor ?? 0;
  const rows = [];
  for (const c of wc.chain.slice(0, CF_LIMIT)) {
    try {
      const a2 = analysis_without(model, mode, c.group);
      let need = 0;
      let gap = 0;
      try {
        const m2 = wave_metrics(item.wave, a2.series[mode], B, next_income_day(a2.events[mode], item.wave.end));
        need = m2.need_minor;
        gap = m2.gap_minor;
      } catch (e) {
        if (e?.code !== 'E_SCHEMA' || e?.ctx?.reason !== 'need_not_positive') throw e;
      }
      rows.push({ group: c.group, count: c.count, need_minor: need, gap_minor: gap, delta_minor: need - m.need_minor });
    } catch { /* группа не пересчитывается — строки нет */ }
  }
  return rows;
}

// ══ 2. DOM-часть ══════════════════════════════════════════════════════════════════════════════════════════════════════

/** Подпись режима по словарю §2.0 («по плану», «если хуже»). */
const mode_text = (ctx, m) => LABELS.modes[ctx.lang()]?.[m] ?? m;

/** Подпись строки цепочки. */
function row_label(ctx, namer, r) {
  if (r.kind === 'rest' || r.id === 'payment_rest') return ctx.tr('scenarios.why_rest', { n: r.rest_groups ?? 0 });
  if (r.kind === 'inflow') return ctx.tr('scenarios.why_inflow');
  if (r.kind === 'group' || r.id === 'payment_group') return namer.group(r.group) + (r.count > 1 ? ' × ' + r.count : '');
  return ctx.tr('bd.' + r.id);
}

/** Знаковая сумма вклада: «+» и «−» словами не нужны — знак виден в числе, а смысл строки — в её подписи. */
const money_signed = (f, v) => (v > 0 ? '+' : '') + f.money(v);

/** Строка происхождения под диалогом (REQ-104): номер расчёта `c_…`, версия движка, режим и сокращённый `inputs_hash`. */
function origin_line(ctx, mode, origin) {
  return h('p', { class: 'muted why-origin', text: ctx.tr('scenarios.why_origin', { ref: origin.ref, version: origin.version }) + ' · ' + ctx.tr('scenarios.why_foot', { mode: mode_text(ctx, mode), hash: origin.hash }) });
}

/** Блок «Что было бы без…»: заголовок и список; строк нет — блока нет. */
function cf_section(ctx, items) {
  return items.length === 0 ? null : h('div', { class: 'why-cf' }, h('h4', { text: ctx.tr('scenarios.verdict_cf_title') }), h('ul', { class: 'plain' }, items));
}

/** Строки контрфактов «можно потратить» (пересчёт движка без группы). */
function sts_cf_items(ctx, model, mode, w) {
  const f = ctx.fmt();
  const namer = make_event_namer(ctx.get_ws(), ctx.lang());
  return sts_counterfactuals(model, mode, w).map((c) => h('li', null,
    ctx.tr('scenarios.sts_cf', { name: namer.group(c.group), value: f.money(c.sts_minor), delta: money_signed(f, c.delta_minor) })));
}

/** Строки контрфактов волны (пересчёт движка без группы при том же окне волны). */
function wave_cf_items(ctx, model, mode, item) {
  const f = ctx.fmt();
  const namer = make_event_namer(ctx.get_ws(), ctx.lang());
  return wave_counterfactuals(model, mode, item).map((c) => h('li', null,
    ctx.tr('scenarios.wave_cf', { name: namer.group(c.group), need: f.money(c.need_minor), delta: money_signed(f, c.delta_minor), gap: f.money(c.gap_minor) })));
}

/**
 * Таблица разложения: подпись (для скринридера), строки, итог и словесная сверка. Цвет смысл не несёт: «сходится / не сходится» — текстом.
 * @param {object} ctx
 * @param {string} caption
 * @param {{kind?: string, id?: string, amount_minor?: number, v?: number}[]} rows
 * @param {number} total
 * @param {boolean} ok
 * @param {string} target_label что сверяется («просадка», «минимум свободных минус буфер»)
 * @param {number} target
 */
function rows_table(ctx, caption, rows, total, ok, target_label, target) {
  const f = ctx.fmt();
  const namer = make_event_namer(ctx.get_ws(), ctx.lang());
  const body = rows.map((r) => {
    const v = r.amount_minor ?? r.v;
    return h('tr', null, h('th', { scope: 'row', text: row_label(ctx, namer, r) }), h('td', { class: 'num', text: money_signed(f, v) }),
      h('td', { class: 'num', text: r.share_bp === undefined ? '' : f.bp(r.share_bp) }));
  });
  body.push(h('tr', { class: 'total' }, h('th', { scope: 'row', text: ctx.tr('scenarios.why_total') }), h('td', { class: 'num', text: f.money(total) }), h('td', { class: 'num', text: '' })));
  return [
    table(caption, [ctx.tr('scenarios.why_col_item'), ctx.tr('scenarios.why_col_amount'), ctx.tr('scenarios.why_col_share')], body),
    h('p', { class: ok ? 'muted why-check ok' : 'banner short why-check', role: ok ? null : 'alert',
      text: ctx.tr(ok ? 'scenarios.why_sum_ok' : 'scenarios.why_sum_bad', { sum: f.money(total), what: target_label, target: f.money(target) }) }),
  ];
}

/**
 * Блок для хука `show_why` (диалог «Почему» у узкой точки): полная цепочка с «Остальное» и «Поступлениями», итог равен просадке.
 * @param {object} ctx
 * @param {'plan'|'worse'} mode
 * @returns {HTMLElement|null}
 */
export function render_why_block(ctx, mode) {
  const model = ctx.get_model();
  if (model === null || model === undefined) return null;
  const w = narrowest_why(model, mode);
  if (w.empty) return null;
  return h('section', { class: 'why-more', 'aria-labelledby': 'why-more-h' },
    h('h3', { id: 'why-more-h', text: ctx.tr('scenarios.why_full') }),
    h('p', { class: 'muted', text: ctx.tr('scenarios.why_full_lead') }),
    ...rows_table(ctx, ctx.tr('scenarios.why_full'), w.rows, w.total_minor, w.ok, ctx.tr('scenarios.why_target_drop'), w.drop_minor));
}

/** Диалог «Почему» у волны: окно волны, узкая точка окна, из чего сложилась потребность. */
export function open_wave_why(ctx, item, mode = 'plan') {
  const model = ctx.get_model();
  if (model === null) return;
  const f = ctx.fmt();
  const w = wave_why(model, mode, item);
  open_dialog(ctx.tr('scenarios.wave_why_title', { n: item.n ?? 1 }), ctx.tr('scenarios.close'),
    h('p', { text: ctx.tr('scenarios.wave_why_lead', {
      cash: f.money(w.cash_minor), date: f.date(w.start), min: f.money(w.point.amount_minor), at: f.date(w.point.date), r: f.money(w.r_minor), need: f.money(w.need_minor),
    }) }),
    w.gap_minor > 0 ? h('p', { class: 'banner short', role: 'status', text: ctx.tr('scenarios.wave_why_gap', { value: f.money(w.gap_minor) }) }) : h('p', { class: 'muted', text: ctx.tr('scenarios.wave_why_nogap') }),
    ...rows_table(ctx, ctx.tr('scenarios.wave_why_chain'), w.rows, w.total_minor, w.ok, ctx.tr('scenarios.why_target_need'), w.r_minor),
    cf_section(ctx, wave_cf_items(ctx, model, mode, item)),
    origin_line(ctx, mode, wave_origin(model, mode)));
}

/** Диалог «Почему» у «можно потратить»: платежи до узкой точки по группам, резервы, буфер. */
export function open_sts_why(ctx, mode) {
  const model = ctx.get_model();
  if (model === null) return;
  const f = ctx.fmt();
  const w = sts_why(model, mode);
  if (w.gated) {
    open_dialog(ctx.tr('scenarios.sts_why_title'), ctx.tr('scenarios.close'), h('p', { class: 'banner', role: 'status', text: ctx.tr('scenarios.sts_why_gated', { reason: ctx.tr('gate.' + w.reason, { since: oldest_review_date(model.ws, model.ctx.as_of, model.ctx.rule_status, 'disabled') ?? ctx.tr('c.na') }) }) }));
    return;
  }
  open_dialog(ctx.tr('scenarios.sts_why_title'), ctx.tr('scenarios.close'),
    h('p', { text: ctx.tr('scenarios.sts_why_lead', { mode: mode_text(ctx, mode), date: f.date(w.T), at: f.date(w.at), min: f.money(w.min_free_minor), value: f.money(w.sts_minor) }) }),
    w.short_to_buffer_minor > 0 ? h('p', { class: 'banner short', role: 'status', text: ctx.tr('scenarios.sts_why_short', { value: f.money(w.short_to_buffer_minor) }) }) : null,
    ...rows_table(ctx, ctx.tr('scenarios.sts_why_chain'), w.rows, w.total_minor, w.ok, ctx.tr('scenarios.why_target_sts'), w.min_free_minor - (w.buffer_minor ?? 0)),
    cf_section(ctx, sts_cf_items(ctx, model, mode, w)),
    origin_line(ctx, mode, sts_origin(model, mode, w.T)));
}

/** Диалог «Почему» у вердикта режима: статус словами, минимум, буфер, полная цепочка и что изменилось бы без главных платежей. */
export function open_verdict_why(ctx, mode) {
  const model = ctx.get_model();
  if (model === null) return;
  const f = ctx.fmt();
  const v = verdict_why(model, mode);
  const status = ctx.tr('sc.q1_' + (v.status === 'beyond' ? 'ok' : v.status));
  if (v.status === 'beyond' || v.why === null) {
    open_dialog(ctx.tr('scenarios.verdict_why_title', { mode: mode_text(ctx, mode) }), ctx.tr('scenarios.close'), h('p', { class: 'muted', text: ctx.tr('scenarios.verdict_why_beyond') }));
    return;
  }
  const namer = make_event_namer(ctx.get_ws(), ctx.lang());
  const cf = v.why.counterfactuals.filter((c) => c.kind === 'without').slice(0, 3).map((c) => h('li', null,
    ctx.tr('scenarios.verdict_cf', { name: namer.group(c.group), min: f.money(c.new_min.amount_minor), date: f.short(c.new_min.date), delta: f.money(c.delta_minor) })));
  open_dialog(ctx.tr('scenarios.verdict_why_title', { mode: mode_text(ctx, mode) }), ctx.tr('scenarios.close'),
    h('p', null, h('strong', { text: ctx.tr('scenarios.verdict_status') + ': ' }), status),
    h('p', { text: ctx.tr('scenarios.verdict_why_lead', { min: f.money(v.point.amount_minor), date: f.date(v.point.date), buffer: f.money(v.buffer_minor), need: f.money(v.need_minor) }) }),
    ...(v.why.empty ? [h('p', { class: 'muted', text: ctx.tr('scenarios.verdict_why_flat') })]
      : [...rows_table(ctx, ctx.tr('scenarios.why_full'), v.why.rows, v.why.total_minor, v.why.ok, ctx.tr('scenarios.why_target_drop'), v.why.drop_minor),
        cf.length === 0 ? null : h('div', null, h('h4', { text: ctx.tr('scenarios.verdict_cf_title') }), h('ul', { class: 'plain' }, cf))]),
    origin_line(ctx, mode, verdict_origin(model, mode)));
}

/**
 * Карточка «Почему» на «Обзоре»: переходы к объяснению вердикта «по плану», вердикта «если хуже» и «можно потратить» одним нажатием.
 * @param {object} ctx
 * @returns {HTMLElement|null}
 */
export function render_why_card(ctx) {
  if (ctx.get_model() === null) return null;
  const btn = (key, fn, params) => h('button', { type: 'button', class: 'btn', onclick: fn, text: ctx.tr(key, params) });
  return h('section', { class: 'card why-card', 'aria-labelledby': 'why-card-h' },
    h('h3', { id: 'why-card-h', text: ctx.tr('scenarios.why_card_title') }),
    h('p', { class: 'muted', text: ctx.tr('scenarios.why_card_lead') }),
    h('div', { class: 'actions' },
      btn('scenarios.why_btn_plan', () => open_verdict_why(ctx, 'plan')),
      btn('scenarios.why_btn_worse', () => open_verdict_why(ctx, 'worse')),
      btn('scenarios.why_btn_sts', () => open_sts_why(ctx, ctx.mode()))));
}

/** Дата узкой точки текстом ISO — для тестов и подписей без форматтера. */
export const iso_day = (d) => format_date(d);
