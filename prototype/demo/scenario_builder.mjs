// scenario_builder.mjs — конструктор сценариев (FP-07, REQ-049, REQ-051, IDEA-23): операции движка `shift_flow`, `set_amount`, `remove_flow`, `add_flow`,
// `fx_shock`, сдвиг выбранного поступления (`delay_income`) и «часы по минимуму» (`hours`, только через engine/scenario_ext.mjs). Сценарий — именованный
// набор операций над данными: в журнал фактов не пишется (REQ-014, REQ-049); «Сохранить в набор» кладёт его в `ws.scenarios` (вид правки `save_scenario`
// из ws_edit.mjs), и тогда он виден на экране «Сценарии» как сохранённый и входит в файл-копию.
// Чистая часть (без DOM; проверяется в Node): список платежей, чипы, построение и проверка операций, черновик, правка сохранения, сводка «что изменится»,
// хук `scenario_ops` для новых видов сценариев. DOM-часть: экран `#scenario_lab`. Результаты показываются числами и словами («лучше», «хуже», «без изменений»),
// а не цветом. Расчёт по введённым данным и правилам, не консультация.

import { analyze, narrowest_point, safe_to_spend, default_sts_horizon, to_epoch_day, format_date, currency_exponent } from '../engine/index.mjs';
import { analyze_ext, has_ext_ops, expand_scenario_ext, validate_hours_op, horizon_end_of, EXT_OPS } from '../engine/scenario_ext.mjs';
import { h, table } from './dom.mjs';
import { make_event_namer } from './why_more.mjs';
import { parse_amount_text, format_input_amount, resolve_number_format } from './number_format.mjs';

// ══ 1. Чистые модели ══════════════════════════════════════════════════════════════════════════════════════════════════

/** Виды операций конструктора (кнопки формы). */
export const OP_KINDS = Object.freeze(['shift_income', 'shift_flow', 'set_amount', 'remove_flow', 'add_flow', 'fx_shock', 'hours']);
/** Операции движка v1, которые знает `apply_scenario`, и их предел на сценарий в наборе (как у `save_scenario`). */
export const ENGINE_OPS = Object.freeze(['delay_income', 'shift_flow', 'set_amount', 'remove_flow', 'add_purchase', 'add_flow', 'fx_shock']);
export const MAX_OPS = 50;
/** Предел списка платежей в форме. */
export const MAX_FLOWS = 400;
/** Чипы курса, базисные пункты. */
export const FX_CHIPS_BP = Object.freeze([-1000, -500, 500, 1000]);

const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const refuse = (field, reason) => ({ ok: false, field, reason });
const clean_text = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

/**
 * Ожидаемые платежи и поступления, к которым можно применить операцию: плановые события режима «по плану» от дня расчёта.
 * Сумма и валюта — исходные (до перевода в валюту решения), как их понимает `set_amount`.
 * @param {{events: object, as_of: number}} a Analysis
 * @returns {{ref: string, date: number, amount_minor: number, currency: string, kind: 'income'|'expense', tag: string, rule_id: string|null, stream_id: string|null, event: object}[]}
 */
export function list_flows(a) {
  const out = [];
  for (const e of a.events.plan) {
    if (e.layer !== 'planned' || e.amount_minor === 0 || to_epoch_day(e.date) < a.as_of) continue;
    out.push({
      ref: e.cash_event_id, date: to_epoch_day(e.date), amount_minor: e.orig_amount_minor ?? e.amount_minor, currency: e.orig_currency ?? e.currency,
      kind: e.amount_minor > 0 ? 'income' : 'expense', tag: e.tag ?? '', rule_id: e.rule_id ?? null, stream_id: e.stream_id ?? null, event: e,
    });
  }
  out.sort((x, y) => (x.date - y.date) || (x.amount_minor - y.amount_minor) || (x.ref < y.ref ? -1 : x.ref > y.ref ? 1 : 0));
  return out.slice(0, MAX_FLOWS);
}

/** Валюты, отличные от валюты решения, которые есть в данных: счета, потоки, события, курсы. По алфавиту. */
export function foreign_currencies(ws, a) {
  const dec = a.decision_currency;
  const set = new Set();
  for (const x of ws.accounts ?? []) if (x.currency !== dec) set.add(x.currency);
  for (const x of ws.streams ?? []) if (x.currency !== dec) set.add(x.currency);
  for (const x of ws.rates ?? []) { if (x.base !== dec) set.add(x.base); if (x.quote !== dec) set.add(x.quote); }
  for (const e of a.events.plan) if (e.orig_currency !== undefined && e.orig_currency !== dec) set.add(e.orig_currency);
  return [...set].filter((c) => typeof c === 'string' && c !== '').sort();
}

/** Чипы «курс ±N bp» по каждой иностранной валюте данных. */
export function fx_chips(ws, a) {
  return foreign_currencies(ws, a).flatMap((currency) => FX_CHIPS_BP.map((bp) => ({ currency, bp })));
}

/** Чипы часов: по каждому потоку — «по минимуму», «как ожидается», «по максимуму» (минуты из `hours` потока). */
export function hours_chips(ws) {
  const out = [];
  for (const s of ws.streams ?? []) {
    const hs = s.hours;
    if (!is_obj(hs)) continue;
    for (const [kind, key] of [['min', 'min_minutes'], ['exp', 'exp_minutes'], ['max', 'max_minutes']]) {
      if (Number.isSafeInteger(hs[key])) out.push({ stream_id: s.stream_id, name: s.name, kind, minutes: hs[key] });
    }
  }
  return out;
}

/** Целое из текста поля («14», «−3», «+5», «-3»); иначе `null`. */
export function parse_int_text(text) {
  const s = String(text ?? '').trim().replace(/^−/, '-').replace(/^\+/, '');
  return /^-?\d{1,7}$/.test(s) ? Number(s) : null;
}

/**
 * Построить операцию конструктора. Проверки — до записи: платёж должен быть в списке, дни и суммы — целые, дата — внутри горизонта.
 * @param {typeof OP_KINDS[number]} kind
 * @param {object} input поля формы (см. ниже)
 * @param {{flows: ReturnType<typeof list_flows>, as_of: number, horizon_end: number, currencies?: string[], streams?: object[]}} env
 *   `input`: `shift_income {ref, days}`, `shift_flow {ref, days, scope?: 'one'|'all'}`, `set_amount {ref, amount_minor}` (положительная; знак берётся у платежа),
 *   `remove_flow {ref, scope?}`, `add_flow {when: 'once'|'monthly', kind: 'income'|'expense', amount_minor, date, tag?, n?}`,
 *   `fx_shock {currency, bp}`, `hours {stream_id, minutes, from?, to?}`
 * @returns {{ok: true, op: object}|{ok: false, field: string, reason: string}}
 */
export function build_op(kind, input, env) {
  const x = input ?? {};
  const flow = () => env.flows.find((f) => f.ref === x.ref);
  const need_flow = () => { const f = flow(); return f === undefined ? null : f; };
  switch (kind) {
    case 'shift_income': {
      const f = need_flow();
      if (f === null) return refuse('ref', 'unknown_flow');
      if (f.kind !== 'income') return refuse('ref', 'not_income');
      if (!Number.isSafeInteger(x.days) || x.days < 1 || x.days > 3650) return refuse('days', 'days_1_3650');
      return { ok: true, op: { op: 'delay_income', event_ref: f.ref, days: x.days } };
    }
    case 'shift_flow': {
      const f = need_flow();
      if (f === null) return refuse('ref', 'unknown_flow');
      if (!Number.isSafeInteger(x.days) || x.days === 0 || x.days < -365 || x.days > 365) return refuse('days', 'days_nonzero_365');
      const all = x.scope === 'all';
      const ref = all ? (f.rule_id ?? f.stream_id) : f.ref;
      if (ref === null || ref === undefined) return refuse('scope', 'no_series');
      return { ok: true, op: { op: 'shift_flow', event_ref: ref, days: x.days } };
    }
    case 'set_amount': {
      const f = need_flow();
      if (f === null) return refuse('ref', 'unknown_flow');
      if (!Number.isSafeInteger(x.amount_minor) || x.amount_minor <= 0) return refuse('amount_minor', 'amount_positive');
      return { ok: true, op: { op: 'set_amount', event_ref: f.ref, amount_minor: f.kind === 'expense' ? -x.amount_minor : x.amount_minor } };
    }
    case 'remove_flow': {
      const f = need_flow();
      if (f === null) return refuse('ref', 'unknown_flow');
      const all = x.scope === 'all';
      const ref = all ? (f.rule_id ?? f.stream_id) : f.ref;
      if (ref === null || ref === undefined) return refuse('scope', 'no_series');
      return { ok: true, op: { op: 'remove_flow', event_ref: ref } };
    }
    case 'add_flow': {
      if (x.kind !== 'income' && x.kind !== 'expense') return refuse('kind', 'kind_income_expense');
      if (!Number.isSafeInteger(x.amount_minor) || x.amount_minor <= 0) return refuse('amount_minor', 'amount_positive');
      let d;
      try { d = to_epoch_day(x.date); } catch { return refuse('date', 'bad_date'); }
      if (d < env.as_of || d > env.horizon_end) return refuse('date', 'outside_horizon');
      const signed = x.kind === 'expense' ? -x.amount_minor : x.amount_minor;
      const tag = clean_text(x.tag, 100);
      if (x.when === 'monthly') {
        const day = Number(format_date(d).slice(8, 10));
        const rule = {
          rule_id: 'scn-flow-' + (Number.isSafeInteger(x.n) && x.n > 0 ? x.n : 1), name: tag === '' ? 'flow' : tag, kind: x.kind, amount: { exp_minor: signed },
          freq: 'M', interval: 1, by_monthday: [day], start_date: format_date(d), is_obligation: false, is_estimate: false,
        };
        if (tag !== '') rule.tag = tag;
        return { ok: true, op: { op: 'add_flow', rule } };
      }
      return { ok: true, op: { op: 'add_flow', once: { date: format_date(d), amount_minor: signed, tag: tag === '' ? 'flow' : tag } } };
    }
    case 'fx_shock': {
      if (typeof x.currency !== 'string' || !/^[A-Z0-9]{3,10}$/.test(x.currency)) return refuse('currency', 'bad_currency');
      if (env.currencies !== undefined && !env.currencies.includes(x.currency)) return refuse('currency', 'currency_not_in_data');
      if (!Number.isSafeInteger(x.bp) || x.bp === 0 || x.bp < -10000 || x.bp > 100000) return refuse('bp', 'bp_range');
      return { ok: true, op: { op: 'fx_shock', currency: x.currency, bp: x.bp } };
    }
    case 'hours': {
      if (!(env.streams ?? []).some((s) => s.stream_id === x.stream_id)) return refuse('stream_id', 'unknown_stream');
      const op = { op: 'hours', stream_id: x.stream_id, minutes: x.minutes };
      if (x.from !== undefined) op.from = x.from;
      if (x.to !== undefined) op.to = x.to;
      try { validate_hours_op(op); } catch (e) { return refuse(e?.ctx?.reason === 'bad_minutes' ? 'minutes' : 'hours', e?.ctx?.reason ?? 'bad_hours'); }
      return { ok: true, op };
    }
    default:
      return refuse('kind', 'unknown_kind');
  }
}

/** Структурная проверка готовой операции (для хука и сохранения): известное имя и целые числа; ссылки на события не проверяются. */
export function validate_op(op) {
  if (!is_obj(op)) return refuse('op', 'not_object');
  if (op.op === 'hours') { try { validate_hours_op(op); return { ok: true }; } catch (e) { return refuse('hours', e?.ctx?.reason ?? 'bad_hours'); } }
  if (!ENGINE_OPS.includes(op.op)) return refuse('op', 'unknown_op');
  const ref = op.event_ref ?? op.ref;
  if (['delay_income', 'shift_flow', 'set_amount', 'remove_flow'].includes(op.op) && (typeof ref !== 'string' || ref === '' || ref.length > 200)) return refuse('event_ref', 'required');
  if (op.op === 'delay_income' && !(Number.isSafeInteger(op.days) && op.days >= 0 && op.days <= 3650)) return refuse('days', 'bad_days');
  if (op.op === 'shift_flow' && !(Number.isSafeInteger(op.days) && Math.abs(op.days) <= 3650)) return refuse('days', 'bad_days');
  if (op.op === 'set_amount' && !(Number.isSafeInteger(op.amount_minor) && op.amount_minor !== 0)) return refuse('amount_minor', 'bad_amount');
  if (op.op === 'fx_shock' && !(typeof op.currency === 'string' && Number.isSafeInteger(op.bp) && op.bp >= -10000 && op.bp <= 100000)) return refuse('bp', 'bad_fx');
  if (op.op === 'add_flow' && !(is_obj(op.once) || is_obj(op.rule))) return refuse('add_flow', 'needs_once_or_rule');
  return { ok: true };
}

/** Новый пустой черновик сценария. */
export function new_draft() {
  return { name: '', ops: [] };
}

/** Добавить операцию в черновик; дубль (та же операция) не добавляется; не больше `MAX_OPS`. */
export function draft_add(draft, op) {
  if (draft.ops.length >= MAX_OPS) return { ok: false, reason: 'too_many_ops', draft };
  const key = JSON.stringify(op);
  if (draft.ops.some((x) => JSON.stringify(x) === key)) return { ok: false, reason: 'duplicate_op', draft };
  return { ok: true, draft: { ...draft, ops: [...draft.ops, op] } };
}

/** Убрать операцию по номеру. */
export function draft_remove(draft, index) {
  return { ...draft, ops: draft.ops.filter((_, i) => i !== index) };
}

/**
 * Правка «Сохранить в набор»: `save_scenario` из ws_edit.mjs. Сценарий с операцией расширения (`hours`) в набор не пишется — её знает только
 * `scenario_ext`; такой сценарий остаётся гипотезой на этом экране.
 * @param {{name: string, ops: object[]}} draft
 * @param {string} [scenario_id] для замены сохранённого
 * @returns {{ok: true, edit: object}|{ok: false, reason: 'empty_name'|'no_ops'|'ext_op_not_saved'}}
 */
export function save_edit(draft, scenario_id) {
  const name = clean_text(draft.name, 120);
  if (name === '') return { ok: false, reason: 'empty_name' };
  if (draft.ops.length === 0) return { ok: false, reason: 'no_ops' };
  if (draft.ops.some((o) => EXT_OPS.includes(o.op))) return { ok: false, reason: 'ext_op_not_saved' };
  const scenario = { name, ops: draft.ops.map((o) => JSON.parse(JSON.stringify(o))) };
  if (scenario_id !== undefined) scenario.scenario_id = scenario_id;
  return { ok: true, edit: { type: 'save_scenario', scenario } };
}

/** Правка «Удалить из набора». */
export function delete_edit(scenario_id) {
  return { type: 'delete_scenario', scenario_id };
}

/**
 * Сводка чисел для «что изменится»: минимум на счетах и минимум свободных по режимам, «можно потратить» до даты `T`.
 * @param {object} a Analysis
 * @param {number} [T] дата «можно потратить»; по умолчанию как на «Обзоре»
 */
export function summarize(a, T) {
  const t = T ?? default_sts_horizon(a);
  // sts_h — «можно потратить» до конца горизонта (D-12: STS(horizon_end)); horizon_end — для подписи даты в оговорке (как `sts_cell_text` на экране «Сценарии»)
  const out = { T: t, horizon_end: a.horizon_end, trough: {}, free: {}, sts: {}, sts_h: {} };
  for (const m of ['plan', 'worse']) {
    const s = a.series[m];
    const np = narrowest_point(s, a.as_of, a.horizon_end);
    out.trough[m] = { date: np.date, amount_minor: np.amount_minor };
    out.free[m] = Math.min(...s.free);
    const sts = safe_to_spend(a, t, null, m);
    out.sts[m] = sts.kind === 'insufficient_data' ? null : sts.sts;
    out.sts_h[m] = sts.kind === 'insufficient_data' ? null : sts.sts_horizon;
  }
  return out;
}

/**
 * «Что изменится»: база против сценария (с операциями расширения). Ошибка расчёта возвращается кодом, не исключением.
 * @param {object} ws
 * @param {object} a_base Analysis базы
 * @param {object[]} ops операции черновика
 * @returns {{ok: true, base: ReturnType<typeof summarize>, scenario: ReturnType<typeof summarize>, rows: {id: string, mode: string, base: number|null, scenario: number|null, delta: number|null, date_base?: number, date_scenario?: number}[]}|{ok: false, code: string}}
 */
export function preview(ws, a_base, ops) {
  let a2;
  try { a2 = analyze_ext(ws, { as_of: ws.as_of, scenario: { ops } }); } catch (e) { return { ok: false, code: typeof e?.code === 'string' ? e.code : 'E_SCHEMA' }; }
  const T = default_sts_horizon(a_base);
  const base = summarize(a_base, T);
  const scenario = summarize(a2, Math.min(T, a2.horizon_end));
  const rows = [];
  for (const m of ['plan', 'worse']) {
    rows.push({ id: 'trough', mode: m, base: base.trough[m].amount_minor, scenario: scenario.trough[m].amount_minor, delta: scenario.trough[m].amount_minor - base.trough[m].amount_minor, date_base: base.trough[m].date, date_scenario: scenario.trough[m].date });
  }
  for (const m of ['plan', 'worse']) rows.push({ id: 'free', mode: m, base: base.free[m], scenario: scenario.free[m], delta: scenario.free[m] - base.free[m] });
  for (const m of ['plan', 'worse']) {
    const b = base.sts[m];
    const s = scenario.sts[m];
    // h_base / h_scenario — то же «можно потратить» до конца горизонта: показывается оговоркой, если денег до конца горизонта меньше (как UI-1 на экране «Сценарии»)
    rows.push({ id: 'sts', mode: m, base: b, scenario: s, delta: b === null || s === null ? null : s - b, h_base: base.sts_h[m], h_scenario: scenario.sts_h[m] });
  }
  return { ok: true, base, scenario, rows };
}

/**
 * Хук `scenario_ops` реестра: новые виды сценариев → операции для `apply_scenario`. Виды: `fx {currency, bp}`, `shift {event_ref, days}`,
 * `ops {ops: [...]}` (готовые операции, в том числе `hours`), `hours {stream_id, minutes}`. Чужой вид — `undefined` (хук не отвечает);
 * неверное описание — `null` («собрать нельзя»). Операции `hours` разворачиваются через `scenario_ext` в `set_amount`.
 * @param {object} _ctx контекст реестра
 * @param {{kind: string}} sc описание сценария страницы
 * @param {object} ws
 * @returns {object[]|null|undefined}
 */
export function scenario_ops_hook(_ctx, sc, ws) {
  let ops;
  if (sc.kind === 'fx') ops = [{ op: 'fx_shock', currency: sc.currency, bp: sc.bp }];
  else if (sc.kind === 'shift') ops = [{ op: 'shift_flow', event_ref: sc.event_ref, days: sc.days }];
  else if (sc.kind === 'hours') ops = [{ op: 'hours', stream_id: sc.stream_id, minutes: sc.minutes }];
  else if (sc.kind === 'ops') ops = sc.ops;
  else return undefined;
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_OPS || !ops.every((o) => validate_op(o).ok)) return null;
  if (!has_ext_ops({ ops })) return ops;
  try { return expand_scenario_ext(ws, { ops }, { as_of: ws.as_of, horizon_end: horizon_end_of(ws, { as_of: ws.as_of }) }).scenario.ops; } catch { return null; }
}

// ══ 2. DOM-часть ══════════════════════════════════════════════════════════════════════════════════════════════════════

/** Порядок экрана в навигации: после экрана «Сценарии» (50). */
export const LAB_ORDER = 55;

/** Состояние экрана: черновик сценария, номер новой записи, сообщение. Живёт между перерисовками страницы. */
export function create_lab_deps() {
  return { draft: new_draft(), n: 1, status: null };
}

function hm_text(ctx, minutes) {
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return mm === 0 ? ctx.tr('scenarios.hm0', { h: hh }) : ctx.tr('scenarios.hm', { h: hh, m: mm });
}

function flow_text(ctx, namer, f) {
  const fm = ctx.fmt();
  const sign = f.amount_minor > 0 ? '+' : '';
  return namer(f.event) + ' · ' + fm.short(f.date) + ' · ' + sign + fm.money(f.amount_minor);
}

/** Описание операции черновика словами. Операция над серией (правило или поток) помечается «все платежи». */
export function describe_op(ctx, op, flows, namer) {
  const fm = ctx.fmt();
  const ref = op.event_ref ?? op.ref;
  const flow = flows.find((x) => x.ref === ref);
  const series = flow === undefined && ref !== undefined;
  const name = flow !== undefined ? namer(flow.event) : namer.by_id(String(ref ?? '').split('@')[0]);
  const date = flow !== undefined ? fm.short(flow.date) : series ? ctx.tr('scenarios.op_all_suffix') : '';
  switch (op.op) {
    case 'delay_income': return ctx.tr('scenarios.op_delay_income', { name, date, days: fm.days(op.days) });
    case 'shift_flow': return ctx.tr(op.days > 0 ? 'scenarios.op_shift_later' : 'scenarios.op_shift_earlier', { name, date, days: fm.days(Math.abs(op.days)) });
    case 'set_amount': return ctx.tr('scenarios.op_set_amount', { name, date, amount: fm.money(Math.abs(op.amount_minor)) });
    case 'remove_flow': return ctx.tr('scenarios.op_remove_flow', { name, date });
    case 'add_flow':
      if (op.once !== undefined) return ctx.tr(op.once.amount_minor > 0 ? 'scenarios.op_add_once_income' : 'scenarios.op_add_once_expense', { amount: fm.money(Math.abs(op.once.amount_minor)), date: fm.date(op.once.date), tag: op.once.tag });
      return ctx.tr(op.rule.kind === 'income' ? 'scenarios.op_add_monthly_income' : 'scenarios.op_add_monthly_expense', { amount: fm.money(Math.abs(op.rule.amount.exp_minor)), day: op.rule.by_monthday[0], date: fm.date(op.rule.start_date) });
    case 'fx_shock': return ctx.tr(op.bp > 0 ? 'scenarios.op_fx_up' : 'scenarios.op_fx_down', { currency: op.currency, pct: fm.bp(Math.abs(op.bp)) });
    case 'hours': return ctx.tr('scenarios.op_hours', { stream: make_event_namer(ctx.get_ws(), ctx.lang()).by_id(op.stream_id), hours: hm_text(ctx, op.minutes) });
    default: return op.op;
  }
}

/** Слово для изменения числа: лучше, хуже, без изменений (текст вместо цвета). */
function delta_text(ctx, f, delta) {
  if (delta === null) return ctx.tr('scenarios.pv_na');
  if (delta === 0) return ctx.tr('scenarios.pv_same');
  return ctx.tr(delta > 0 ? 'scenarios.pv_better' : 'scenarios.pv_worse', { value: f.money(Math.abs(delta)) });
}

/**
 * Экран «Конструктор сценариев».
 * @param {object} ctx
 * @param {ReturnType<typeof create_lab_deps>} deps
 * @returns {HTMLElement}
 */
export function render_lab(ctx, deps) {
  const root = h('div', { class: 'view lab' }, h('h2', { id: 'view-title', tabindex: '-1', text: ctx.tr('scenarios.lab_title') }), h('p', { class: 'lead', text: ctx.tr('scenarios.lab_lead') }));
  const model = ctx.get_model();
  const ws = ctx.get_ws();
  if (model === null || ws === null) { root.append(h('p', { class: 'banner', role: 'status', text: ctx.tr('scenarios.lab_no_data') })); return root; }
  // база для сравнения — данные без активного сценария страницы (иначе «база» была бы уже сценарием)
  const a = model.scenario === null || model.scenario === undefined ? model.ctx : analyze(ws, { as_of: ws.as_of });
  const fm = ctx.fmt();
  const namer = make_event_namer(ws, ctx.lang());
  const flows = list_flows(a);
  const env = { flows, as_of: a.as_of, horizon_end: a.horizon_end, currencies: foreign_currencies(ws, a), streams: ws.streams ?? [] };
  const nf = resolve_number_format(ctx.lang(), ws.number_format);
  const cur = a.decision_currency;
  const status = h('p', { class: 'muted', role: 'status', 'aria-live': 'polite', text: deps.status ?? '' });
  deps.status = null; // сообщение показано один раз (после записи страница перерисовалась)
  const say = (text) => { status.textContent = text; };
  const REASON = (r) => ctx.tr('scenarios.err_' + (['unknown_flow', 'not_income', 'days_1_3650', 'days_nonzero_365', 'amount_positive', 'kind_income_expense', 'bad_date', 'outside_horizon', 'bad_currency', 'currency_not_in_data', 'bp_range', 'unknown_stream', 'no_series', 'bad_minutes'].includes(r) ? r : 'other'));

  const ops_box = h('div', { class: 'lab-ops' });
  const preview_box = h('div', { class: 'lab-preview', 'aria-live': 'polite' });
  const paint = () => {
    paint_ops();
    paint_preview();
  };
  function paint_ops() {
    const items = deps.draft.ops.map((op, i) => h('li', null, describe_op(ctx, op, flows, namer), ' ',
      h('button', { type: 'button', class: 'link', 'aria-label': ctx.tr('scenarios.lab_remove_label', { what: describe_op(ctx, op, flows, namer) }), text: ctx.tr('scenarios.lab_remove'),
        onclick: () => { deps.draft = draft_remove(deps.draft, i); paint(); } })));
    // replaceChildren не пропускает null (в браузере он стал бы текстом «null»): в список идут только узлы
    ops_box.replaceChildren(...[
      h('h4', { id: 'lab-ops-h', text: ctx.tr('scenarios.lab_ops_title', { n: deps.draft.ops.length }) }),
      items.length === 0 ? h('p', { class: 'muted', text: ctx.tr('scenarios.lab_ops_empty') }) : h('ol', { 'aria-labelledby': 'lab-ops-h' }, items),
      has_ext_ops({ ops: deps.draft.ops }) ? h('p', { class: 'muted', text: ctx.tr('scenarios.lab_ext_note') }) : null,
    ].filter((n) => n !== null));
  }
  function paint_preview() {
    if (deps.draft.ops.length === 0) { preview_box.replaceChildren(h('p', { class: 'muted', text: ctx.tr('scenarios.pv_empty') })); return; }
    const r = preview(ws, a, deps.draft.ops);
    if (!r.ok) { preview_box.replaceChildren(h('p', { class: 'banner short', role: 'alert', text: ctx.tr('scenarios.pv_error', { code: r.code }) })); return; }
    const label = (row) => ctx.tr('scenarios.pv_row_' + row.id) + ', ' + ctx.tr('scenarios.pv_mode_' + row.mode);
    // «Можно потратить» всегда с оговоркой про конец горизонта, если до него денег меньше (design-brief §10, D-12): иначе число рядом с минимумом свободных вводит в заблуждение
    const cell = (v, extra = '') => h('td', { class: 'num', text: v === null ? ctx.tr('scenarios.pv_na') : fm.money(v) + (extra === '' ? '' : ' · ' + extra) });
    const horizon_note = (v, hz, end) => (v !== null && hz !== null && hz !== undefined && hz < v ? ctx.tr('scenarios.pv_sts_horizon', { date: fm.date(end), value: fm.money(hz) }) : '');
    const rows = r.rows.map((row) => h('tr', null, h('th', { scope: 'row', text: label(row) }),
      cell(row.base, row.id === 'sts' ? horizon_note(row.base, row.h_base, r.base.horizon_end) : ''),
      cell(row.scenario, row.id === 'sts' ? horizon_note(row.scenario, row.h_scenario, r.scenario.horizon_end) : ''),
      h('td', { text: delta_text(ctx, fm, row.delta) + (row.id === 'trough' && row.date_scenario !== row.date_base ? ' · ' + ctx.tr('scenarios.pv_moved', { date: fm.short(row.date_scenario) }) : '') })));
    preview_box.replaceChildren(
      h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': ctx.tr('scenarios.pv_title') },
        table(ctx.tr('scenarios.pv_title'), [ctx.tr('scenarios.pv_col_item'), ctx.tr('scenarios.pv_col_base'), ctx.tr('scenarios.pv_col_scenario'), ctx.tr('scenarios.pv_col_change')], rows, 'tbl wide')),
      h('p', { class: 'muted', text: ctx.tr('scenarios.pv_note', { date: fm.date(r.base.T) }) }));
  }
  const add = (kind, input) => {
    const r = build_op(kind, input, env);
    if (!r.ok) { say(ctx.tr('scenarios.lab_rejected', { what: ctx.tr('scenarios.lab_field_' + r.field.replace(/[^a-z_]/g, '')), why: REASON(r.reason) })); return; }
    const d = draft_add(deps.draft, r.op);
    if (!d.ok) { say(ctx.tr(d.reason === 'duplicate_op' ? 'scenarios.lab_duplicate' : 'scenarios.lab_too_many', { max: MAX_OPS })); return; }
    deps.draft = d.draft;
    if (kind === 'add_flow') deps.n += 1;
    say(ctx.tr('scenarios.lab_added'));
    paint();
  };

  // ── платёж или поступление ──
  const flow_sel = h('select', { id: 'lab-flow' }, flows.map((f) => h('option', { value: f.ref, text: flow_text(ctx, namer, f) })));
  const act_sel = h('select', { id: 'lab-action' }, ['shift_income', 'shift_flow', 'set_amount', 'remove_flow'].map((k) => h('option', { value: k, text: ctx.tr('scenarios.act_' + k) })));
  const num_in = h('input', { id: 'lab-number', type: 'text', inputmode: 'numeric', autocomplete: 'off', value: '7' });
  const num_label = h('label', { for: 'lab-number', text: ctx.tr('scenarios.lab_days') });
  const scope_sel = h('select', { id: 'lab-scope' }, h('option', { value: 'one', text: ctx.tr('scenarios.scope_one') }), h('option', { value: 'all', text: ctx.tr('scenarios.scope_all') }));
  const scope_row = h('div', { class: 'field' }, h('label', { for: 'lab-scope', text: ctx.tr('scenarios.lab_scope') }), scope_sel);
  const sync_form = () => {
    const k = act_sel.value;
    num_label.textContent = ctx.tr(k === 'set_amount' ? 'scenarios.lab_amount' : 'scenarios.lab_days', { cur });
    num_in.disabled = k === 'remove_flow';
    scope_row.hidden = !(k === 'shift_flow' || k === 'remove_flow');
  };
  act_sel.addEventListener('change', sync_form);
  sync_form();
  const add_flow_op = () => {
    const kind = act_sel.value;
    const base = { ref: flow_sel.value, scope: scope_sel.value };
    if (kind === 'set_amount') {
      const f = flows.find((x) => x.ref === base.ref);
      const p = parse_amount_text(num_in.value, f === undefined ? cur : f.currency, ctx.lang(), ws.number_format);
      add(kind, { ...base, amount_minor: p.ok ? p.value : null });
    } else if (kind === 'remove_flow') add(kind, base);
    else add(kind, { ...base, days: parse_int_text(num_in.value) });
  };
  const flow_form = h('section', { class: 'card', 'aria-labelledby': 'lab-flow-h' },
    h('h3', { id: 'lab-flow-h', text: ctx.tr('scenarios.lab_flow_title') }),
    flows.length === 0 ? h('p', { class: 'muted', text: ctx.tr('scenarios.lab_no_flows') }) : h('div', null,
      h('div', { class: 'field' }, h('label', { for: 'lab-flow', text: ctx.tr('scenarios.lab_flow') }), flow_sel),
      h('div', { class: 'field' }, h('label', { for: 'lab-action', text: ctx.tr('scenarios.lab_action') }), act_sel),
      h('div', { class: 'field' }, num_label, num_in), scope_row,
      h('p', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onclick: add_flow_op, text: ctx.tr('scenarios.lab_add') }))));

  // ── чипы курса и часов ──
  const fx = fx_chips(ws, a);
  const hrs = hours_chips(ws);
  const chip = (text, fn, label) => h('button', { type: 'button', class: 'chip', onclick: fn, 'aria-label': label ?? null, text });
  const chips = h('section', { class: 'card', 'aria-labelledby': 'lab-chips-h' },
    h('h3', { id: 'lab-chips-h', text: ctx.tr('scenarios.lab_chips_title') }),
    h('h4', { text: ctx.tr('scenarios.lab_fx_title') }),
    fx.length === 0 ? h('p', { class: 'muted', text: ctx.tr('scenarios.lab_fx_none') })
      : h('div', { class: 'chips' }, fx.map((c) => chip(ctx.tr(c.bp > 0 ? 'scenarios.chip_fx_up' : 'scenarios.chip_fx_down', { currency: c.currency, pct: fm.bp(Math.abs(c.bp)), bp: Math.abs(c.bp) }), () => add('fx_shock', c)))),
    h('h4', { text: ctx.tr('scenarios.lab_hours_title') }),
    hrs.length === 0 ? h('p', { class: 'muted', text: ctx.tr('scenarios.lab_hours_none') })
      : h('div', { class: 'chips' }, hrs.map((c) => chip(ctx.tr('scenarios.chip_hours_' + c.kind, { stream: namer.by_id(c.stream_id), hours: hm_text(ctx, c.minutes) }), () => add('hours', { stream_id: c.stream_id, minutes: c.minutes })))),
    hrs.length === 0 ? null : h('p', { class: 'muted', text: ctx.tr('scenarios.lab_hours_note') }));

  // ── новая запись ──
  const kind_sel = h('select', { id: 'lab-new-kind' }, h('option', { value: 'expense', text: ctx.tr('scenarios.kind_expense') }), h('option', { value: 'income', text: ctx.tr('scenarios.kind_income') }));
  const when_sel = h('select', { id: 'lab-new-when' }, h('option', { value: 'once', text: ctx.tr('scenarios.when_once') }), h('option', { value: 'monthly', text: ctx.tr('scenarios.when_monthly') }));
  const amount_in = h('input', { id: 'lab-new-amount', type: 'text', inputmode: 'decimal', autocomplete: 'off', value: format_input_amount(10000, currency_exponent(cur), nf, true) });
  const date_in = h('input', { id: 'lab-new-date', type: 'date', min: format_date(a.as_of), max: format_date(a.horizon_end), value: format_date(Math.min(a.as_of + 7, a.horizon_end)) });
  const tag_in = h('input', { id: 'lab-new-tag', type: 'text', maxlength: 100, autocomplete: 'off' });
  const new_form = h('section', { class: 'card', 'aria-labelledby': 'lab-new-h' },
    h('h3', { id: 'lab-new-h', text: ctx.tr('scenarios.lab_new_title') }),
    h('div', { class: 'field' }, h('label', { for: 'lab-new-kind', text: ctx.tr('scenarios.lab_new_kind') }), kind_sel),
    h('div', { class: 'field' }, h('label', { for: 'lab-new-amount', text: ctx.tr('scenarios.lab_amount', { cur }) }), amount_in),
    h('div', { class: 'field' }, h('label', { for: 'lab-new-date', text: ctx.tr('scenarios.lab_new_date') }), date_in),
    h('div', { class: 'field' }, h('label', { for: 'lab-new-when', text: ctx.tr('scenarios.lab_new_when') }), when_sel),
    h('div', { class: 'field' }, h('label', { for: 'lab-new-tag', text: ctx.tr('scenarios.lab_new_tag') }), tag_in),
    h('p', { class: 'actions' }, h('button', { type: 'button', class: 'btn', text: ctx.tr('scenarios.lab_add'), onclick: () => {
      const p = parse_amount_text(amount_in.value, cur, ctx.lang(), ws.number_format);
      add('add_flow', { when: when_sel.value, kind: kind_sel.value, amount_minor: p.ok ? p.value : null, date: date_in.value, tag: tag_in.value.trim() === '' ? ctx.tr('scenarios.lab_tag_default') : tag_in.value, n: deps.n });
    } })));

  // ── сценарий, сохранение, предпросмотр ──
  const name_in = h('input', { id: 'lab-name', type: 'text', maxlength: 120, autocomplete: 'off', value: deps.draft.name });
  name_in.addEventListener('input', () => { deps.draft = { ...deps.draft, name: name_in.value }; });
  const save = () => {
    deps.draft = { ...deps.draft, name: name_in.value };
    const r = save_edit(deps.draft);
    if (!r.ok) { say(ctx.tr('scenarios.lab_save_' + r.reason)); return; }
    const prev = deps.draft;
    deps.draft = new_draft();
    deps.status = ctx.tr('scenarios.lab_saved'); // страница перерисовывается внутри edit и показывает сообщение один раз
    if (!ctx.edit(r.edit, { reason: 'save_scenario' }).ok) { deps.draft = prev; deps.status = null; }
  };
  const scen = h('section', { class: 'card', 'aria-labelledby': 'lab-scn-h' },
    h('h3', { id: 'lab-scn-h', text: ctx.tr('scenarios.lab_scn_title') }),
    h('div', { class: 'field' }, h('label', { for: 'lab-name', text: ctx.tr('scenarios.lab_name') }), name_in),
    ops_box, status,
    h('p', { class: 'actions' },
      h('button', { type: 'button', class: 'btn primary', onclick: save, text: ctx.tr('scenarios.lab_save') }),
      h('button', { type: 'button', class: 'btn', onclick: () => { deps.draft = new_draft(); say(ctx.tr('scenarios.lab_cleared')); name_in.value = ''; paint(); }, text: ctx.tr('scenarios.lab_clear') })),
    h('p', { class: 'muted', text: ctx.tr('scenarios.lab_not_ledger') }));
  const pv = h('section', { class: 'card', 'aria-labelledby': 'lab-pv-h' }, h('h3', { id: 'lab-pv-h', text: ctx.tr('scenarios.pv_title') }), preview_box);

  // ── сохранённые ──
  const saved = ws.scenarios ?? [];
  const saved_rows = saved.map((s) => h('tr', null, h('th', { scope: 'row', text: s.name }), h('td', { class: 'num', text: String(s.ops.length) }),
    h('td', null, h('button', { type: 'button', class: 'link', 'aria-label': ctx.tr('scenarios.lab_delete_label', { name: s.name }), text: ctx.tr('scenarios.lab_delete'),
      onclick: () => { deps.status = ctx.tr('scenarios.lab_deleted'); if (!ctx.edit(delete_edit(s.scenario_id), { reason: 'delete_scenario' }).ok) deps.status = null; } }))));
  const saved_box = h('section', { class: 'card', 'aria-labelledby': 'lab-saved-h' },
    h('h3', { id: 'lab-saved-h', text: ctx.tr('scenarios.lab_saved_title') }),
    saved.length === 0 ? h('p', { class: 'muted', text: ctx.tr('scenarios.lab_saved_none') })
      : table(ctx.tr('scenarios.lab_saved_title'), [ctx.tr('scenarios.lab_col_name'), ctx.tr('scenarios.lab_col_ops'), ctx.tr('scenarios.lab_col_action')], saved_rows),
    h('p', null, h('a', { href: '#scenarios', text: ctx.tr('scenarios.lab_go_scn') })));

  paint();
  root.append(flow_form, chips, new_form, scen, pv, saved_box);
  return root;
}
