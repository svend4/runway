// sinking_report.mjs — отчёт по накоплениям (sinking funds): план взносов, «N взносов на сумму X», что не подтверждено, пакетное подтверждение
// (FP-08, REQ-069, REQ-070, REQ-071, ALG-05, IDEA-21, IDEA-41).
//
// Правило C-030: плановые взносы в журнал автоматически НЕ пишутся — `funded_open` растёт только от записанных аллокаций (`source = schedule`).
// Поэтому видны два отдельных числа: план вперёд (что ещё предстоит внести) и «не подтверждено» (даты взносов в прошлом, по которым записи нет;
// это то же, что несёт предупреждение `W_RESERVE_BEHIND`: `missed_count`, `missed_minor`). Подтвердить пачкой значит записать эти строки
// как `allocation.recorded` с `allocation_id = sch:<reserve_id>@<дата>` — повтор безвреден.
//
// Модуль ничего не пишет и ничего не решает за пользователя: он возвращает числа и заготовки записей. Частота взносов в v1 — только `M`.
// Краевые случаи ALG-05 (REQ-071): цель достигнута → график пуст, статус `reached`; нет дат взноса до срока → график пуст, `shortfall = rem`,
// статус `no_dates`, исключений нет. Это расчёт по введённым данным, не консультация.
// Зависимости: money, dates, sinking, timeline. Модуль чистый: ни часов, ни случайности, ни ввода-вывода.

import { fail, sum_minor } from './money.mjs';
import { to_epoch_day, format_date, make_calendar } from './dates.mjs';
import {
  reserve_open, contribution_dates, contribution_plan, contribution_plan_fixed, plan_status, periods_to_goal, pool_split,
} from './sinking.mjs';
import { normalize_ws } from './timeline.mjs';

/** Идентификатор записи планового взноса (как в `analyze`): `sch:<reserve_id>@<дата>`. */
export function contribution_id(reserve_id, date) {
  return 'sch:' + reserve_id + '@' + (typeof date === 'string' ? date : format_date(date));
}

/** Календарь взносов: как в `analyze` — `calendar_id` резерва или его `cadence`, иначе первый календарь рабочей области, иначе сб/вс. */
function calendar_of(w, r) {
  const id = r.calendar_id ?? r.cadence?.calendar_id ?? null;
  const spec = id === null ? w.calendars[0] : w.calendars.find((c) => c.calendar_id === id);
  if (id !== null && spec === undefined) fail('E_SCHEMA', { reason: 'unknown_calendar', calendar_id: String(id) });
  return make_calendar(spec === undefined ? {} : spec);
}

const is_sinking = (r) => r.kind === 'sinking' && (r.mode === 'refill_to_target' || r.mode === 'fixed') && (r.backed_by_account_id === null || r.backed_by_account_id === undefined);

function find_reserve(w, reserve_id) {
  const r = w.reserves.find((x) => x.reserve_id === reserve_id);
  if (r === undefined) fail('E_SCHEMA', { reason: 'unknown_reserve', reserve_id: String(reserve_id) });
  if (r.kind !== 'sinking') fail('E_SCHEMA', { reason: 'not_a_sinking_reserve', reserve_id: String(reserve_id) });
  return r;
}

const row_out = (r, d) => ({ date: format_date(d), amount_minor: r.amount_minor });

/**
 * План взносов резерва на `as_of`: даты — `cadence.day`-е число каждого месяца СТРОГО до срока (срок в число дат не входит), без уже записанных
 * взносов; размер — `refill_to_target` (`c_k = min(ceil_div(rem_k, n − k), rem_k)`, сумма цели сходится ровно) или `fixed` (взнос задан, цель может
 * не достигаться, недостача — числом). Пересчёт от текущего `funded_open` и есть «догон».
 * @param {object} ws рабочая область
 * @param {string} reserve_id резерв `sinking`
 * @param {string|number} [as_of] по умолчанию `ws.as_of`
 * @param {{horizon_end?: string|number}} [opts] верхняя граница дат, если у резерва нет `due_date` (по умолчанию `as_of + 365`)
 * @returns {{reserve_id: string, mode: string, funded_open_minor: number, target_minor: number|null, due_date: string|null, n: number,
 *   rows: {date: string, amount_minor: number}[], total_minor: number, projected_minor: number, status: 'ok'|'reached'|'no_dates',
 *   shortfall_minor: number, periods_to_goal: number|null, fixed_minor: number|null}}
 * @throws {RunwayError} E_SCHEMA (нет резерва, не `sinking`, у `refill_to_target` нет цели или срока, у `fixed` нет взноса)
 */
export function sinking_plan(ws, reserve_id, as_of, opts = {}) {
  const w = normalize_ws(ws);
  const r = find_reserve(w, reserve_id);
  if (r.mode !== 'refill_to_target' && r.mode !== 'fixed') fail('E_SCHEMA', { reason: 'sinking_needs_mode', reserve_id: String(reserve_id) });
  const asof = to_epoch_day(as_of ?? ws.as_of);
  const has_due = r.due_date !== undefined && r.due_date !== null;
  const has_target = r.target_minor !== undefined && r.target_minor !== null;
  if (r.mode === 'refill_to_target' && !(has_due && has_target)) fail('E_SCHEMA', { reason: 'refill_needs_target_and_due_date', reserve_id: String(reserve_id) });
  if (r.mode === 'fixed' && (r.fixed_minor === undefined || r.fixed_minor === null)) fail('E_SCHEMA', { reason: 'fixed_mode_needs_fixed_minor', reserve_id: String(reserve_id) });
  const funded = reserve_open(r, w.allocations, asof);
  const upper = has_due ? to_epoch_day(r.due_date) : (opts.horizon_end === undefined ? asof + 365 : to_epoch_day(opts.horizon_end)) + 1;
  const recorded = new Set(w.allocations.map((a) => a.allocation_id));
  const dates = contribution_dates(asof, upper, r.cadence ?? { freq: 'M', day: 1 }, calendar_of(w, r))
    .filter((d) => !recorded.has(contribution_id(r.reserve_id, d)));
  const base = {
    reserve_id: r.reserve_id, mode: r.mode, funded_open_minor: funded, target_minor: has_target ? r.target_minor : null,
    due_date: has_due ? format_date(to_epoch_day(r.due_date)) : null, n: dates.length, fixed_minor: r.mode === 'fixed' ? r.fixed_minor : null,
  };
  if (r.mode === 'refill_to_target') {
    const rows = contribution_plan({ target_minor: r.target_minor, funded_open_minor: funded, dates, mode: 'refill_to_target' });
    const st = plan_status({ target_minor: r.target_minor, funded_open_minor: funded, dates });
    const total = sum_minor(rows.map((x) => x.amount_minor));
    return { ...base, rows: rows.map((x) => row_out(x, x.date)), total_minor: total, projected_minor: funded + total, status: st.status, shortfall_minor: st.shortfall_minor, periods_to_goal: null };
  }
  const res = contribution_plan_fixed({ funded_open_minor: funded, fixed_minor: r.fixed_minor, dates, target_minor: has_target ? r.target_minor : null });
  const total = sum_minor(res.rows.map((x) => x.amount_minor));
  const rem = has_target ? r.target_minor - funded : null;
  let status = 'ok';
  if (rem !== null && rem <= 0) status = 'reached';
  else if (dates.length === 0) status = 'no_dates';
  return {
    ...base, rows: res.rows.map((x) => row_out(x, x.date)), total_minor: total, projected_minor: funded + total, status,
    shortfall_minor: res.shortfall_minor, periods_to_goal: rem === null ? null : periods_to_goal(rem, r.fixed_minor),
  };
}

/**
 * Взносы, которые должны были быть внесены до `as_of`, но не подтверждены записью: по каждому резерву `sinking` с невыполненной целью.
 * Числа `missed_count` и `missed_minor` — те же, что в предупреждении `W_RESERVE_BEHIND` (C-030): `missed_minor` — первые `missed_count` строк графика,
 * посчитанного от текущего `funded_open` по ВСЕМ неподтверждённым датам до срока (`refill_to_target`) либо взнос × число дат (`fixed`, но не выше цели).
 * @param {object} ws
 * @param {string|number} [as_of]
 * @returns {{reserve_id: string, missed_count: number, missed_minor: number, rows: {allocation_id: string, reserve_id: string, date: string, amount_minor: number, source: 'schedule'}[]}[]}
 *   только резервы, по которым есть неподтверждённые взносы; `rows` — заготовки записей для пакетного подтверждения
 */
export function reserve_behind_detail(ws, as_of) {
  const w = normalize_ws(ws);
  const asof = to_epoch_day(as_of ?? ws.as_of);
  const out = [];
  for (const r of w.reserves) {
    if (!is_sinking(r)) continue;
    const funded = reserve_open(r, w.allocations, asof);
    const from = r.funded_as_of === undefined || r.funded_as_of === null ? -Infinity : to_epoch_day(r.funded_as_of);
    const due = r.due_date === undefined || r.due_date === null ? null : to_epoch_day(r.due_date);
    const reached = r.target_minor !== undefined && r.target_minor !== null && funded >= r.target_minor;
    if (reached) continue;
    const start = Number.isFinite(from) ? from + 1 : asof;
    const cad = r.cadence ?? { freq: 'M', day: 1 };
    const cal = calendar_of(w, r);
    const recorded = new Set(w.allocations.map((a) => a.allocation_id));
    const unconfirmed = contribution_dates(start, due ?? asof, cad, cal).filter((d) => !recorded.has(contribution_id(r.reserve_id, d)));
    const missed = unconfirmed.filter((d) => d < asof);
    if (missed.length === 0) continue;
    let rows;
    if (r.mode === 'fixed') {
      const target = r.target_minor === undefined ? null : r.target_minor;
      rows = contribution_plan_fixed({ funded_open_minor: funded, fixed_minor: r.fixed_minor ?? 0, dates: missed, target_minor: target }).rows;
    } else {
      rows = contribution_plan({ target_minor: r.target_minor, funded_open_minor: funded, dates: unconfirmed, mode: 'refill_to_target' }).filter((x) => x.date < asof);
    }
    const items = rows.map((x) => ({ allocation_id: contribution_id(r.reserve_id, x.date), reserve_id: r.reserve_id, date: format_date(x.date), amount_minor: x.amount_minor, source: 'schedule' }));
    out.push({ reserve_id: r.reserve_id, missed_count: missed.length, missed_minor: sum_minor(items.map((x) => x.amount_minor)), rows: items });
  }
  return out;
}

/**
 * Заготовки записей «подтвердить взносы за период»: неподтверждённые взносы резерва с датой не позже `upto` (по умолчанию — все до `as_of`).
 * Записи идемпотентны по `allocation_id`; подтверждённые строки сразу уходят из `W_RESERVE_BEHIND`.
 * @param {object} ws
 * @param {string} reserve_id
 * @param {{as_of?: string|number, upto?: string|number}} [opts]
 * @returns {{allocation_id: string, reserve_id: string, date: string, amount_minor: number, source: 'schedule'}[]}
 */
export function confirm_rows(ws, reserve_id, opts = {}) {
  const hit = reserve_behind_detail(ws, opts.as_of).find((x) => x.reserve_id === reserve_id);
  if (hit === undefined) return [];
  if (opts.upto === undefined || opts.upto === null) return hit.rows;
  const upto = to_epoch_day(opts.upto);
  return hit.rows.filter((x) => to_epoch_day(x.date) <= upto);
}

/**
 * Общий взнос в пул целей: сумма делится по весам — ближайшим плановым взносам режима `refill_to_target` — методом наибольших остатков
 * (`split_largest_remainder`): сумма долей равна общему взносу, разброс ≤ 1 minor (REQ-069: 37500 по 12000 : 4200 : 21313 → [11996, 4198, 21306]).
 * Цели без ближайшего взноса (достигнуты, нет дат) в пул не входят.
 * @param {object} ws
 * @param {number} total_minor общий взнос (> 0)
 * @param {string|number} [as_of]
 * @returns {{reserve_id: string, weight_minor: number, share_minor: number}[]}
 */
export function pool_split_report(ws, total_minor, as_of) {
  const w = normalize_ws(ws);
  const items = [];
  for (const r of w.reserves) {
    if (!is_sinking(r) || r.mode !== 'refill_to_target') continue;
    const p = sinking_plan(ws, r.reserve_id, as_of);
    if (p.rows.length > 0) items.push({ reserve_id: r.reserve_id, weight_minor: p.rows[0].amount_minor });
  }
  if (items.length === 0) return [];
  const shares = pool_split(total_minor, items.map((x) => x.weight_minor));
  return items.map((x, i) => ({ ...x, share_minor: shares[i] }));
}
