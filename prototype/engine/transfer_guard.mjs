// transfer_guard.mjs — предупреждение о двойном вычитании при реальном переводе на неоперационный счёт (FP-04, REQ-063, IDEA-15, ADR-016).
//
// Ловушка: деньги резерва лежат на операционных счетах (v1: `backed_by_account_id = null`, привязку канон откладывает до v1.1).
// Пользователь переводит часть этих денег в копилку: остаток операционных счетов падает, а резерв остаётся прежним, поэтому
// `free = остаток − резервы` вычитает те же деньги дважды. Модуль проверяет перевод и предлагает записать в резерв ручную аллокацию
// со знаком минус (`source = manual`) на сумму перевода; без согласия `free` падает (G-001: 250000 → 150000), после согласия остаётся
// прежним. Модуль ничего не пишет: он возвращает заготовки аллокаций, запись — дело слоя ввода (`demo/entry.mjs`).
//
// Когда предупреждение НЕ выдаётся (во всех случаях `warn = false` и `reason` называет причину):
//   - `unknown_account`, `not_operating_to_nonoperating` (нужна пара «operating → не operating»), `currency_differs` (в той же валюте);
//   - `future` — перевод позже `as_of` (это план, а не проводка);
//   - `covered_by_anchor` — перевод не позже даты последнего якоря счёта-источника: остаток уже включает его, двойного вычитания нет
//     (для плановых ног сравнение нестрогое: план на дату якоря входит в поток, C-004);
//   - `no_funded_reserve` (нет резерва с `funded > 0`), `reserve_backed` (все такие резервы привязаны к счёту);
//   - `before_reserve_snapshot` — перевод не позже даты `funded_as_of` резерва: движок такую аллокацию не учтёл бы (`reserve_open`: только
//     даты строго позже `funded_as_of`), резерв задан уже после перевода;
//   - `declined` — пользователь отказался для этого перевода (запись отказа — `decline_record`), `resolved` — аллокации согласия уже записаны.
//
// Расчёт по введённым данным и правилам, не консультация. Модуль чистый: ни часов, ни случайности, ни ввода-вывода.
// Слой: стоит выше `sinking` (импортирует `reserve_open`); `index` и остальной движок его не импортируют, циклов нет.

import { fail, assert_minor } from './money.mjs';
import { to_epoch_day } from './dates.mjs';
import { reserve_open } from './sinking.mjs';

/** Вид записи отказа в журнале (`draft.proposed`, поле `kind`): сами записи пишет слой ввода. */
export const DECLINE_KIND = 'transfer_guard';

const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const list = (ws, key) => (Array.isArray(ws?.[key]) ? ws[key] : []);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Идентификатор аллокации согласия для пары «перевод, резерв»: детерминирован, запись идемпотентна (`record_allocation` по `allocation_id`). */
export function guard_allocation_id(transfer_id, reserve_id) {
  return 'tg-' + String(transfer_id) + '-' + String(reserve_id);
}

/** Идентификатор записи отказа для перевода. */
export function decline_id(transfer_id) {
  return 'tgd-' + String(transfer_id);
}

/**
 * Запись отказа пользователя: `{entity_id, payload}` для `journal.append('draft.proposed', payload, {entity_id})`.
 * Отказ — это ответ на предложение, а не данные счета: в рабочую область он не попадает, живёт в журнале (`state.extra`).
 * @param {string} transfer_id
 * @returns {{entity_id: string, payload: {draft_id: string, kind: string, decision: 'declined', transfer_id: string}}}
 */
export function decline_record(transfer_id) {
  if (typeof transfer_id !== 'string' || transfer_id === '') fail('E_SCHEMA', { reason: 'transfer_id_required' });
  const id = decline_id(transfer_id);
  return { entity_id: id, payload: { draft_id: id, kind: DECLINE_KIND, decision: 'declined', transfer_id } };
}

/**
 * Переводы, от которых пользователь уже отказался: читает `state.extra` журнала (результат свёртки, ключ `draft.proposed`).
 * Чужие и непонятные записи пропускаются.
 * @param {object|null|undefined} extra `state.extra`
 * @returns {Set<string>} идентификаторы переводов
 */
export function declined_transfers(extra) {
  const out = new Set();
  const bucket = is_obj(extra) && Object.hasOwn(extra, 'draft.proposed') ? extra['draft.proposed'] : null;
  if (!is_obj(bucket)) return out;
  for (const rec of Object.values(bucket)) {
    if (is_obj(rec) && rec.kind === DECLINE_KIND && rec.decision === 'declined' && typeof rec.transfer_id === 'string') out.add(rec.transfer_id);
  }
  return out;
}

/** Последний якорь счёта с датой ≤ `limit` (EpochDay) или `null`. */
function last_anchor_day(ws, account_id, limit) {
  let best = null;
  for (const a of list(ws, 'anchors')) {
    if (a?.account_id !== account_id) continue;
    const d = to_epoch_day(a.date);
    if (d <= limit && (best === null || d > best)) best = d;
  }
  return best;
}

/**
 * Проверить перевод на двойное вычитание.
 * @param {object} ws рабочая область (`accounts`, `reserves`, `allocations`, `anchors`; не меняется)
 * @param {{transfer_id?: string, from_account_id: string, to_account_id: string, amount_minor: number, date: string, planned?: boolean}} t
 *   перевод: `amount_minor` — положительная сумма в валюте счетов; `planned: true` — плановая нога (иначе проводка)
 * @param {{as_of?: string, declined?: Iterable<string>}} [opts] `as_of` по умолчанию `ws.as_of`; `declined` — переводы с отказом пользователя
 * @returns {{warn: false, reason: string, transfer_id?: string}
 *   | {warn: true, reason: 'double_count', transfer_id?: string, from_account_id: string, to_account_id: string, date: string, currency: string,
 *      amount_minor: number, reduce_total_minor: number, uncovered_minor: number,
 *      candidates: {reserve_id: string, kind: string, funded_minor: number, reduce_minor: number}[],
 *      allocations: {allocation_id?: string, reserve_id: string, date: string, amount_minor: number, source: 'manual', source_event_id?: string}[]}}
 *   `reduce_total_minor` — на сколько предлагается уменьшить резервы (не больше накопленного), `uncovered_minor` — остаток перевода сверх накопленного
 * @throws {RunwayError} E_SCHEMA (вход не объект, сумма не положительна), E_NOT_INTEGER / E_OVERFLOW (сумма), E_BAD_DATE (даты)
 */
export function check_transfer(ws, t, opts = {}) {
  if (!is_obj(ws) || !is_obj(t)) fail('E_SCHEMA', { reason: 'transfer_guard_input' });
  const amount = assert_minor(t.amount_minor);
  if (amount <= 0) fail('E_SCHEMA', { reason: 'transfer_amount_not_positive' });
  const date = to_epoch_day(t.date);
  const as_of = to_epoch_day(opts.as_of ?? ws.as_of);
  const tid = typeof t.transfer_id === 'string' && t.transfer_id !== '' ? t.transfer_id : undefined;
  const no = (reason) => (tid === undefined ? { warn: false, reason } : { warn: false, reason, transfer_id: tid });

  const accounts = list(ws, 'accounts');
  const from = accounts.find((a) => a?.account_id === t.from_account_id);
  const to = accounts.find((a) => a?.account_id === t.to_account_id);
  if (from === undefined || to === undefined) return no('unknown_account');
  if (from.liquidity !== 'operating' || to.liquidity === 'operating') return no('not_operating_to_nonoperating');
  if (from.currency !== to.currency) return no('currency_differs');
  if (date > as_of) return no('future');
  const anchor = last_anchor_day(ws, from.account_id, Infinity);
  if (anchor !== null && (t.planned === true ? date < anchor : date <= anchor)) return no('covered_by_anchor');

  const allocations = list(ws, 'allocations');
  const funded = [];
  let any_backed = false;
  for (const r of list(ws, 'reserves')) {
    if (!is_obj(r) || typeof r.reserve_id !== 'string') continue;
    if (r.currency !== undefined && r.currency !== null && r.currency !== from.currency) continue;
    const f = reserve_open(r, allocations, as_of);
    if (f <= 0) continue;
    if (r.backed_by_account_id !== undefined && r.backed_by_account_id !== null) { any_backed = true; continue; }
    funded.push({ r, funded_minor: f });
  }
  if (funded.length === 0) return no(any_backed ? 'reserve_backed' : 'no_funded_reserve');
  // аллокация на дату перевода учитывается движком только строго после `funded_as_of` резерва
  const effective = funded.filter(({ r }) => r.funded_as_of === undefined || r.funded_as_of === null || to_epoch_day(r.funded_as_of) < date);
  if (effective.length === 0) return no('before_reserve_snapshot');

  effective.sort((a, b) => (b.funded_minor - a.funded_minor) || cmp(a.r.reserve_id, b.r.reserve_id));
  let rest = amount;
  const candidates = [];
  for (const { r, funded_minor } of effective) {
    const reduce_minor = Math.min(rest, funded_minor);
    rest -= reduce_minor;
    candidates.push({ reserve_id: r.reserve_id, kind: String(r.kind ?? ''), funded_minor, reduce_minor });
  }
  const used = candidates.filter((c) => c.reduce_minor > 0);
  const allocs = used.map((c) => {
    const a = { reserve_id: c.reserve_id, date: t.date, amount_minor: -c.reduce_minor, source: 'manual' };
    if (tid !== undefined) { a.allocation_id = guard_allocation_id(tid, c.reserve_id); a.source_event_id = tid; }
    return a;
  });
  if (tid !== undefined) {
    if (opts.declined !== undefined && opts.declined !== null && new Set(opts.declined).has(tid)) return no('declined');
    const have = new Set(allocations.map((a) => a?.allocation_id));
    if (allocs.length > 0 && allocs.every((a) => have.has(a.allocation_id))) return no('resolved');
  }
  return {
    warn: true,
    reason: 'double_count',
    ...(tid === undefined ? {} : { transfer_id: tid }),
    from_account_id: from.account_id,
    to_account_id: to.account_id,
    date: t.date,
    currency: from.currency,
    amount_minor: amount,
    reduce_total_minor: amount - rest,
    uncovered_minor: rest,
    candidates,
    allocations: allocs,
  };
}

/**
 * Переводы рабочей области, которым нужен ответ пользователя: проводки (факты с общим `transfer_id`, две ноги: минус на операционном счёте,
 * плюс на неоперационном), для которых `check_transfer` даёт `warn = true`. Порядок — по дате, затем по идентификатору перевода.
 * Чужой файл не роняет проверку: непонятный перевод пропускается.
 * @param {object} ws
 * @param {{as_of?: string, declined?: Iterable<string>}} [opts]
 * @returns {ReturnType<typeof check_transfer>[]} только результаты с `warn = true`
 */
export function pending_transfers(ws, opts = {}) {
  const groups = new Map();
  for (const f of list(ws, 'facts')) {
    if (!is_obj(f) || typeof f.transfer_id !== 'string') continue;
    if (!groups.has(f.transfer_id)) groups.set(f.transfer_id, []);
    groups.get(f.transfer_id).push(f);
  }
  const out = [];
  for (const [transfer_id, legs] of groups) {
    if (legs.length !== 2) continue;
    const src = legs.find((l) => Number.isSafeInteger(l.amount_minor) && l.amount_minor < 0);
    const dst = legs.find((l) => Number.isSafeInteger(l.amount_minor) && l.amount_minor > 0);
    if (src === undefined || dst === undefined) continue;
    try {
      const r = check_transfer(ws, { transfer_id, from_account_id: src.account_id, to_account_id: dst.account_id, amount_minor: -src.amount_minor, date: src.date }, opts);
      if (r.warn) out.push(r);
    } catch { /* непонятный перевод из чужого файла: пропуск */ }
  }
  return out.sort((a, b) => cmp(a.date, b.date) || cmp(String(a.transfer_id), String(b.transfer_id)));
}
