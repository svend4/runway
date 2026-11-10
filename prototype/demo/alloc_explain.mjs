// alloc_explain.mjs — «как посчитано» у чисел резервов: цепочка «поступление → правило → сумма» (FP-15, REQ-062, REQ-067, REQ-108, ALG-05, ALG-06, IDEA-29).
//
// Образец — «почему» из FP-07 (`why_more.mjs`): всё считает движок, модуль только раскладывает ряд резерва по дням на строки и доводит их до итога.
// Остаток резерва к концу горизонта = «сейчас в резерве» + отложенное с поступлений по правилу + взносы по графику − высвобождение при платежах
// (ряд `reserve_series`: `allocated`, `contributed`, `released`, `true_up`). Для каждой отложенной суммы показывается её вывод: поступление (gross), правило и версия, ставка,
// округление, возраст правила и формула `mul_div(gross, rate_bp, 10000, режим) = сумма` — те же вызовы движка (`allocations_for_events`, `allocation_for_income`),
// что и в расчёте страницы; совпадение проверяется (`matches`). Если правило не подтверждено дольше двух сроков годности (`disabled`, C-024), числа заменяет текст
// «правило не подтверждено с <даты>: подтвердите или измените» (канон REQ-067): строки цепочки не строятся, остаются правило, версия и возраст.
// Чистая часть (без DOM; проверяется в Node) и диалог. Узлы строит только dom.mjs (текст пользователя — textContent). Ставок и сроков в модуле нет.
// Расчёт по введённым данным и правилам, не консультация.

import {
  reserve_open_ex, allocations_for_events, allocation_for_income, rule_at, to_epoch_day, format_date,
} from '../engine/index.mjs';
import { LABELS } from '../engine/verifier.mjs';
import { label_of } from './i18n.mjs';
import { h, table, open_dialog } from './dom.mjs';
import { make_event_namer } from './why_more.mjs';
import { rule_versions, rule_ids_of_reserve, oldest_review_date } from './rule_age.mjs';

const list = (ws, key) => (Array.isArray(ws?.[key]) ? ws[key] : []);

// ══ 1. Чистые модели ══════════════════════════════════════════════════════════════════════════════════════════════════

/** Идентификаторы правил, которые пополняют резерв: `reserve_id` версии правила или `tax_rule_id` самого резерва. */
export function rules_of_reserve(ws, reserve) {
  return rule_ids_of_reserve(ws, reserve); // одна реализация в rule_age.mjs: её же использует app.mjs для маски накоплений
}

/**
 * Числа резерва для карточки: сколько сейчас, сколько к концу горизонта выбранного режима; под отключённым правилом (`disabled`) вместо чисел — дата проверки.
 * @param {{ws: object, ctx: object}} model модель страницы
 * @param {string} reserve_id
 * @param {'plan'|'worse'} mode
 * @returns {{ok: false, reason: string}|{ok: true, reserve: object, hidden: boolean, since: string|null, now_minor: number|null, end_minor: number|null}}
 */
export function reserve_numbers(model, reserve_id, mode) {
  const a = model.ctx;
  const ws = model.ws;
  const reserve = list(ws, 'reserves').find((r) => r?.reserve_id === reserve_id);
  if (reserve === undefined) return { ok: false, reason: 'unknown_reserve' };
  const rs = a.reserve?.[mode]?.by_reserve?.[reserve_id];
  if (rs === undefined) return { ok: false, reason: 'not_in_series' }; // резерв привязан к счёту: в ряд резервов не входит
  const off = rules_of_reserve(ws, reserve).filter((id) => a.rule_status?.[id] === 'disabled');
  if (off.length > 0) {
    const status = Object.fromEntries(off.map((id) => [id, 'disabled']));
    return { ok: true, reserve, hidden: true, since: oldest_review_date(ws, a.as_of, status, 'disabled'), now_minor: null, end_minor: null };
  }
  const now = reserve_open_ex(reserve, list(ws, 'allocations'), a.as_of).funded_open_minor;
  return { ok: true, reserve, hidden: false, since: null, now_minor: now, end_minor: rs.close[rs.close.length - 1] };
}

/** Вывод одной отложенной суммы: поступление, правило и версия, ставка, округление, возраст правила, формула и её результат. */
function allocation_detail(a, rules, alloc, mode) {
  const ev = (a.events?.[mode] ?? []).find((e) => e.cash_event_id === alloc.source_event_id);
  const id = String(alloc.allocation_id);
  const tail = '@' + String(alloc.source_event_id);
  const rule_id = id.startsWith('tax:') && id.endsWith(tail) ? id.slice(4, id.length - tail.length) : null;
  if (ev === undefined || rule_id === null) return null;
  const base = Math.max(to_epoch_day(ev.plan_date ?? ev.date), a.as_of);
  let rule = null;
  try { rule = rule_at(rules, rule_id, base); } catch { rule = null; }
  if (rule === null || rule.version !== alloc.rule_version) rule = rules.find((r) => r.tax_rule_id === rule_id && r.version === alloc.rule_version) ?? null;
  if (rule === null) return null;
  const result = allocation_for_income(ev.amount_minor, rule);
  const reviewed = typeof rule.reviewed_at === 'string' ? rule.reviewed_at : (Number.isSafeInteger(rule.reviewed_at) ? format_date(rule.reviewed_at) : null);
  const marked = reviewed !== null && Number.isSafeInteger(rule.ttl_days);
  return {
    source_event_id: alloc.source_event_id, income_date: ev.date, sample: ev, gross_minor: ev.amount_minor, rule_id, rule_name: rule.name ?? rule_id, version: rule.version,
    rate_bp: rule.rate_bp, rounding: rule.rounding ?? 'half_even', result_minor: result, matches: result === alloc.amount_minor,
    status: a.rule_status?.[rule_id] ?? 'fresh', marked, reviewed_at: marked ? reviewed : null, ttl_days: marked ? rule.ttl_days : null,
    age_days: marked ? a.as_of - to_epoch_day(reviewed) : null,
  };
}

/**
 * Полная цепочка «как посчитано» для резерва в режиме: стартовая сумма, строки по дням горизонта (отложено с поступления / взнос / высвобождение при платеже),
 * итог и сверка («сумма строк равна числу к концу горизонта»). Всё берётся из ряда резерва страницы — пересчёта «по-своему» нет.
 * @param {{ws: object, ctx: object}} model
 * @param {string} reserve_id
 * @param {'plan'|'worse'} mode
 * @returns {{ok: false, reason: string}|{ok: true, reserve: object, hidden: true, since: string|null, rules: object[]}
 *   |{ok: true, reserve: object, hidden: false, start_minor: number, end_minor: number, total_minor: number, matches: boolean, funded_start_minor: number, funded_as_of: string|null,
 *     recorded: {date: string, amount_minor: number, source: string, allocation_id: string}[],
 *     rows: {kind: 'allocation'|'contribution'|'release', date: number, amount_minor: number, detail?: object|null, released_minor?: number, true_up_minor?: number,
 *       payments?: {sample: object, amount_minor: number}[]}[],
 *     details: object[]}}
 */
export function reserve_chain(model, reserve_id, mode) {
  const a = model.ctx;
  const ws = model.ws;
  const nums = reserve_numbers(model, reserve_id, mode);
  if (!nums.ok) return nums;
  const reserve = nums.reserve;
  const rules = rule_versions(ws);
  if (nums.hidden) {
    const rows = rules_of_reserve(ws, reserve).map((id) => ({ rule_id: id, status: a.rule_status?.[id] ?? 'fresh' }));
    return { ok: true, reserve, hidden: true, since: nums.since, rules: rows };
  }
  const rs = a.reserve[mode].by_reserve[reserve_id];
  const N = rs.close.length;
  const open = reserve_open_ex(reserve, list(ws, 'allocations'), a.as_of);
  const recorded_ids = new Set(list(ws, 'allocations').map((x) => x?.allocation_id));
  const from = reserve.funded_as_of === undefined || reserve.funded_as_of === null ? -Infinity : to_epoch_day(reserve.funded_as_of);
  const recorded = list(ws, 'allocations').filter((x) => x?.reserve_id === reserve_id && from < to_epoch_day(x.date) && to_epoch_day(x.date) <= a.as_of)
    .map((x) => ({ date: x.date, amount_minor: x.amount_minor, source: x.source, allocation_id: x.allocation_id }));
  // отложенные суммы тем же вызовом движка, что и расчёт страницы (`build_events_ex`): записанные уже входят в «сейчас в резерве»
  let planned = [];
  try { planned = allocations_for_events(a.events[mode], rules, a.as_of).filter((x) => x.reserve_id === reserve_id && !recorded_ids.has(x.allocation_id)); } catch { planned = []; }
  const by_day = new Map();
  for (const x of planned) {
    const d = to_epoch_day(x.date);
    if (!by_day.has(d)) by_day.set(d, []);
    by_day.get(d).push(x);
  }
  const pay_events = (a.events?.[mode] ?? []).filter((e) => e.reserve_id === reserve_id && e.amount_minor < 0);
  const rows = [];
  const details = [];
  for (let i = 0; i < N; i++) {
    const day = a.as_of + i;
    if (rs.contributed[i] !== 0) rows.push({ kind: 'contribution', date: day, amount_minor: rs.contributed[i] });
    if (rs.released[i] !== 0 || rs.true_up[i] !== 0) {
      const payments = pay_events.filter((e) => to_epoch_day(e.date) === day).map((e) => ({ sample: e, amount_minor: -e.amount_minor }));
      rows.push({ kind: 'release', date: day, amount_minor: 0 - rs.released[i], released_minor: rs.released[i], true_up_minor: rs.true_up[i], payments });
    }
    if (rs.allocated[i] !== 0) {
      const mine = by_day.get(day) ?? [];
      if (mine.length > 0 && mine.reduce((s, x) => s + x.amount_minor, 0) === rs.allocated[i]) {
        for (const x of mine) {
          const detail = allocation_detail(a, rules, x, mode);
          rows.push({ kind: 'allocation', date: day, amount_minor: x.amount_minor, detail });
          if (detail !== null) details.push(detail);
        }
      } else rows.push({ kind: 'allocation', date: day, amount_minor: rs.allocated[i], detail: null });
    }
  }
  const total = open.funded_open_minor + rows.reduce((s, r) => s + r.amount_minor, 0);
  const end = rs.close[N - 1];
  return {
    ok: true, reserve, hidden: false, start_minor: open.funded_open_minor, end_minor: end, total_minor: total, matches: total === end,
    funded_start_minor: reserve.funded_start_minor ?? 0, funded_as_of: reserve.funded_as_of ?? null, recorded, rows, details,
  };
}

// ══ 2. Диалог «Как посчитано» ═════════════════════════════════════════════════════════════════════════════════════════

const money_signed = (f, v) => (v > 0 ? '+' : '') + f.money(v);
const mode_text = (ctx, m) => LABELS.modes[ctx.lang()]?.[m] ?? m;

/** Строка таблицы: подпись «что» зависит от вида строки. */
function row_text(ctx, f, namer, row) {
  const tr = ctx.tr;
  if (row.kind === 'contribution') return tr('reserveui.how_row_contrib');
  if (row.kind === 'release') {
    const base = row.payments.length === 1
      ? tr('reserveui.how_row_release', { name: namer(row.payments[0].sample), payment: f.money(row.payments[0].amount_minor), released: f.money(row.released_minor) })
      : tr('reserveui.how_row_release_plain', { released: f.money(row.released_minor) });
    return row.true_up_minor > 0 ? base + ' ' + tr('reserveui.how_true_up', { true_up: f.money(row.true_up_minor) }) : base;
  }
  const d = row.detail;
  if (d === null || d === undefined) return tr('reserveui.how_row_alloc_plain');
  return tr('reserveui.how_row_alloc', { name: namer(d.sample), gross: f.money(d.gross_minor), rule: label_of(ctx.lang(), d.rule_id, d.rule_name), ver: d.version, rate: f.bp(d.rate_bp) });
}

/** Панель вывода одной отложенной суммы: поступление, правило и версия, возраст правила, формула. */
function detail_panel(ctx, f, namer, d, i) {
  const tr = ctx.tr;
  const lines = [
    h('li', { text: tr('reserveui.how_alloc_income', { gross: f.money(d.gross_minor) }) }),
    h('li', { text: tr('reserveui.how_alloc_rule', { rule: label_of(ctx.lang(), d.rule_id, d.rule_name), ver: d.version, rate: f.bp(d.rate_bp), rounding: tr('forms.round_' + d.rounding) }) }),
    h('li', { text: d.marked
      ? tr('reserveui.how_alloc_age', { since: d.reviewed_at, age: d.age_days, ttl: d.ttl_days, state: tr('rs.state_' + d.status) })
      : tr('reserveui.how_alloc_unmarked') }),
    h('li', { text: tr('reserveui.how_alloc_formula', {
      gross_minor: d.gross_minor, rate_bp: d.rate_bp, mode: d.rounding, result_minor: d.result_minor, result: f.money(d.result_minor),
    }) }),
  ];
  if (!d.matches) lines.push(h('li', { class: 'banner short', role: 'alert', text: tr('reserveui.how_alloc_mismatch') }));
  return h('section', { class: 'fp15-alloc', id: 'fp15-alloc-' + i, 'aria-labelledby': 'fp15-alloc-' + i + '-title' },
    h('h4', { id: 'fp15-alloc-' + i + '-title', text: tr('reserveui.how_alloc_head', { date: f.date(d.income_date), name: namer(d.sample) }) }),
    h('ul', { class: 'plain' }, lines));
}

/** Тело диалога: вводная, таблица строк, сверка, записанное ранее и панели вывода отложенных сумм. */
export function how_nodes(ctx, model, reserve_id, mode) {
  const tr = ctx.tr;
  const f = ctx.fmt();
  const chain = reserve_chain(model, reserve_id, mode);
  if (!chain.ok) return [h('p', { class: 'muted', text: tr('reserveui.how_no_flow') })];
  const is_tax = chain.reserve.kind === 'tax';
  const horizon = f.date(model.ctx.horizon_end);
  const head = [h('p', { text: tr(is_tax ? 'reserveui.how_lead_tax' : 'reserveui.how_lead_sinking', { date: horizon }) })];
  if (chain.hidden) {
    const rules = chain.rules.map((r) => h('li', { text: label_of(ctx.lang(), r.rule_id, r.rule_id) + ' — ' + tr('rs.state_' + r.status) }));
    return [...head, h('p', { class: 'banner short', role: 'status', text: tr('reserveui.how_hidden', { since: chain.since ?? tr('c.na') }) }), h('ul', { class: 'plain' }, rules),
      h('p', { class: 'muted', text: tr('c.tax_note') })];
  }
  const namer = make_event_namer(ctx.get_ws(), ctx.lang());
  const body = [h('tr', null, h('td', { text: '' }), h('th', { scope: 'row', text: tr('reserveui.how_row_start') }), h('td', { class: 'num', text: f.money(chain.start_minor) }))];
  for (const r of chain.rows) {
    body.push(h('tr', null, h('td', { text: f.date(r.date) }), h('th', { scope: 'row', text: row_text(ctx, f, namer, r) }), h('td', { class: 'num', text: money_signed(f, r.amount_minor) })));
  }
  body.push(h('tr', { class: 'total' }, h('td', { text: f.date(model.ctx.horizon_end) }), h('th', { scope: 'row', text: tr('reserveui.how_row_end') }), h('td', { class: 'num', text: f.money(chain.total_minor) })));
  const out = [...head];
  if (chain.rows.length === 0) out.push(h('p', { class: 'muted', text: tr('reserveui.how_no_flow') }));
  out.push(table(tr('reserveui.how_table'), [tr('reserveui.how_col_date'), tr('reserveui.how_col_what'), tr('reserveui.how_col_amount')], body));
  out.push(h('p', { class: chain.matches ? 'muted how-check ok' : 'banner short how-check', role: chain.matches ? null : 'alert',
    text: tr(chain.matches ? 'reserveui.how_sum_ok' : 'reserveui.how_sum_bad', { sum: f.money(chain.total_minor), end: f.money(chain.end_minor) }) }));
  if (chain.recorded.length > 0 || chain.funded_start_minor !== 0) {
    const items = [];
    if (chain.funded_as_of !== null) items.push(h('li', { text: tr('reserveui.how_rec_start', { date: f.date(chain.funded_as_of), amount: f.money(chain.funded_start_minor) }) }));
    for (const x of chain.recorded) items.push(h('li', { text: tr('reserveui.how_rec_row', { date: f.date(x.date), amount: money_signed(f, x.amount_minor), source: tr('reserveui.src_' + x.source) }) }));
    out.push(h('h4', { text: tr('reserveui.how_rec_title') }), h('ul', { class: 'plain' }, items));
  }
  if (chain.details.length > 0) {
    out.push(h('h3', { text: tr('reserveui.how_alloc_title') }), ...chain.details.map((d, i) => detail_panel(ctx, f, namer, d, i)));
  }
  if (is_tax) out.push(h('p', { class: 'muted', text: tr('c.tax_note') }));
  out.push(h('p', { class: 'muted', text: tr('reserveui.how_foot', { mode: mode_text(ctx, mode), hash: model.ctx.inputs_hash.slice(0, 8) }) }));
  return out;
}

/**
 * Открыть диалог «Как посчитано» для резерва.
 * @param {object} ctx контекст расширений
 * @param {string} reserve_id
 * @param {'plan'|'worse'} [mode] по умолчанию режим страницы
 */
export function open_how(ctx, reserve_id, mode) {
  const model = ctx.get_model();
  if (model === null || model === undefined) return;
  const m = mode === 'plan' || mode === 'worse' ? mode : ctx.mode();
  const reserve = list(model.ws, 'reserves').find((r) => r?.reserve_id === reserve_id);
  const name = reserve === undefined ? reserve_id : label_of(ctx.lang(), reserve.reserve_id, reserve.name ?? reserve.reserve_id);
  open_dialog(ctx.tr('reserveui.how_title', { name }), ctx.tr('reserveui.close'), ...how_nodes(ctx, model, reserve_id, m));
}
