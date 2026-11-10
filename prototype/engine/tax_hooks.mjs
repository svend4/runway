// tax_hooks.mjs — оболочки ALG-06 над `tax.mjs`: аллокации и высвобождения по ПРОВЕДЁННЫМ доходам и платежам (FP-08, REQ-064, REQ-065, IDEA-16, IDEA-42).
//
// `tax.mjs` считает аллокации «на лету» по плановым доходам; проведённый факт должен оставить в журнале запись `allocation.recorded` со своей
// версией правила (`rule_version`): смена ставки прошлое не переписывает. Эти оболочки — тонкий слой над теми же функциями (`rule_at`,
// `allocation_for_income`, `release_on_payment`), он ничего не записывает сам, а возвращает заготовки записей; запись — дело слоя ввода (`demo/`).
//
//   on_posted_income(state, fact, ctx)   доход проведён → аллокации `source = income` по правилу на ФАКТИЧЕСКУЮ дату факта (C-016),
//                                        сумма — в валюте решения по курсу даты факта (C-038);
//   on_posted_payment(state, fact, ctx)  платёж, привязанный к резерву → `released = min(funded, платёж)`, `true_up = платёж − released`;
//                                        запись `source = release` со знаком минус; накоплено берётся ДО аллокаций того же дня (D-08);
//   pending_posted_allocations(ws)       какие проведённые доходы и платежи ещё не оставили записей (для кнопки «записать в конверт»).
//
// Идентификаторы записей детерминированы: `tax:<tax_rule_id>@<event_id>` (как у плановых — запись замещает расчёт на лету, C-020) и
// `rel:<reserve_id>@<event_id>`; повторный вызов записи не дублирует (идемпотентность по `allocation_id`).
// Ставок и сроков в модуле нет: только правила пользователя. Это расчёт по введённым правилам, не консультация.
// Зависимости: money, dates, tax, fx, sinking, timeline, ledger. Модуль чистый: ни часов, ни случайности, ни ввода-вывода (идентификаторы и время — через `ctx`).

import { fail, assert_minor, currency_exponent } from './money.mjs';
import { to_epoch_day, format_date } from './dates.mjs';
import { rule_at, allocation_for_income, release_on_payment } from './tax.mjs';
import { rate_at, convert_minor } from './fx.mjs';
import { reserve_open } from './sinking.mjs';
import { normalize_ws } from './timeline.mjs';
import { make_event } from './ledger.mjs';

/** Идентификатор записи налоговой аллокации по проведённому доходу (совпадает с плановым: запись замещает расчёт на лету). */
export function income_allocation_id(tax_rule_id, event_id) {
  return 'tax:' + tax_rule_id + '@' + event_id;
}

/** Идентификатор записи высвобождения резерва по проведённому платежу. */
export function release_allocation_id(reserve_id, event_id) {
  return 'rel:' + reserve_id + '@' + event_id;
}

const fact_id = (fact) => {
  const id = fact?.event_id ?? fact?.cash_event_id ?? fact?.entity_id;
  if (typeof id !== 'string' || id === '') fail('E_SCHEMA', { reason: 'fact_id_required' });
  return id;
};

/** Применимо ли правило к проведённому доходу: сумма > 0, `stream_id` или `tag` из `applies_to` (C-025). */
function applies(fact, rule) {
  if (!(fact.amount_minor > 0)) return false;
  const at = rule.applies_to ?? {};
  return (fact.stream_id !== null && fact.stream_id !== undefined && (at.stream_ids ?? []).includes(fact.stream_id))
    || (fact.tag !== null && fact.tag !== undefined && (at.tags ?? []).includes(fact.tag));
}

/** Сумма факта в валюте решения по курсу даты факта (C-038): нет курса — `E_NO_RATE`, а не молчаливый ноль. */
function in_decision(state, fact, amount_minor, day) {
  const dec = state.decision_currency;
  const cur = fact.currency ?? dec;
  if (cur === dec) return amount_minor;
  const r = rate_at(state.rates ?? [], cur, dec, day);
  if (r === null) fail('E_NO_RATE', { pair: cur + '/' + dec });
  return convert_minor(amount_minor, currency_exponent(cur), currency_exponent(dec), r.num, r.den, state.rounding ?? 'half_even');
}

/**
 * Заготовки аллокаций по проведённому доходу: для каждого правила, действующего на дату факта и применимого к нему, —
 * `mul_div(gross, rate_bp, 10000, rule.rounding)`. Ноль не пишется; сумма ставок на одно поступление > 10000 — `E_RULE_INVALID` (C-032).
 * @param {{event_id?: string, date: string|number, amount_minor: number, currency?: string, stream_id?: string|null, tag?: string|null}} fact
 * @param {{tax_rules: object[], rates?: object[], decision_currency: string, rounding?: string}} state все версии правил, курсы, валюта решения
 * @returns {{allocation_id: string, reserve_id: string, date: string, amount_minor: number, source: 'income', source_event_id: string, rule_version: number}[]}
 * @throws {RunwayError} E_NO_RATE, E_RULE_INVALID, E_SCHEMA
 */
export function income_allocations(fact, state) {
  const amount = assert_minor(fact.amount_minor);
  if (amount <= 0) return [];
  const id = fact_id(fact);
  const day = to_epoch_day(fact.date);
  const rules = state.tax_rules ?? [];
  const ids = [...new Set(rules.map((r) => r.tax_rule_id))].sort();
  const hit = [];
  for (const rid of ids) {
    const r = rule_at(rules, rid, day); // версия — по фактической дате факта (C-016)
    if (r !== null && applies({ ...fact, amount_minor: amount }, r)) hit.push(r);
  }
  if (hit.length === 0) return [];
  if (hit.reduce((s, r) => s + r.rate_bp, 0) > 10000) fail('E_RULE_INVALID', { reason: 'rate_sum_gt_10000', event: id });
  const gross = in_decision(state, fact, amount, day);
  const out = [];
  for (const r of hit) {
    const a = allocation_for_income(gross, r);
    if (a > 0) {
      out.push({
        allocation_id: income_allocation_id(r.tax_rule_id, id), reserve_id: r.reserve_id, date: format_date(day), amount_minor: a,
        source: 'income', source_event_id: id, rule_version: r.version,
      });
    }
  }
  return out;
}

/** Запись журнала `allocation.recorded` из заготовки; `ctx = {next_event_id(), next_seq(), recorded_at, actor?}` (движок часов не читает). */
function to_event(payload, ctx) {
  return make_event('allocation.recorded', payload, {
    event_id: ctx.next_event_id(), seq: ctx.next_seq(), recorded_at: ctx.recorded_at, actor: ctx.actor ?? 'user',
  });
}

/**
 * Доход проведён: аллокации по правилу на дату факта, ещё не записанные. Версия правила, ставка и округление берутся из правила на ту дату,
 * поэтому правка правила позже прошлых записей не меняет (REQ-065, инвариант 4 ALG-06).
 * @param {{tax_rules: object[], rates?: object[], decision_currency: string, allocations?: object[], rounding?: string}} state
 * @param {object} fact проведённый факт дохода (`event_id`, `date`, `amount_minor`, `currency?`, `stream_id?`, `tag?`)
 * @param {{next_event_id: () => string, next_seq: () => number, recorded_at: string, actor?: string}} [ctx] если задан — ещё и записи журнала
 * @returns {{allocations: object[], events: object[]}} `allocations` — заготовки (`allocation_id`, `reserve_id`, `date`, `amount_minor`, `source`, `source_event_id`, `rule_version`)
 */
export function on_posted_income(state, fact, ctx) {
  const done = new Set((state.allocations ?? []).map((a) => a.allocation_id));
  const allocations = income_allocations(fact, state).filter((p) => !done.has(p.allocation_id));
  return { allocations, events: ctx === undefined || ctx === null ? [] : allocations.map((p) => to_event(p, ctx)) };
}

/**
 * Платёж проведён и привязан к резерву (`fact.reserve_id`): высвобождение `released = min(funded, платёж)`, остальное — `true_up` (уходит из
 * свободных денег). «Накоплено» — состояние резерва на дату платежа БЕЗ аллокаций доходов того же дня (платёж высвобождает резерв до
 * аллокаций дня, D-08) и без собственной записи этого платежа.
 * @param {{reserves: object[], allocations?: object[], rates?: object[], decision_currency: string, rounding?: string}} state
 * @param {object} fact проведённый платёж (`event_id`, `date`, `amount_minor < 0`, `reserve_id`, `currency?`)
 * @param {{next_event_id: () => string, next_seq: () => number, recorded_at: string, actor?: string}} [ctx]
 * @returns {{released_minor: number, true_up_minor: number, funded_before_minor: number, allocation: object|null, events: object[], already: boolean}}
 *   `already` — запись по этому платежу уже есть (повтор ничего не добавляет)
 * @throws {RunwayError} E_SCHEMA (нет резерва), E_NO_RATE
 */
export function on_posted_payment(state, fact, ctx) {
  const empty = { released_minor: 0, true_up_minor: 0, funded_before_minor: 0, allocation: null, events: [], already: false };
  const amt = assert_minor(fact.amount_minor);
  if (!(amt < 0) || typeof fact.reserve_id !== 'string' || fact.reserve_id === '') return empty;
  const id = fact_id(fact);
  const reserve = (state.reserves ?? []).find((r) => r.reserve_id === fact.reserve_id);
  if (reserve === undefined) fail('E_SCHEMA', { reason: 'unknown_reserve', reserve_id: String(fact.reserve_id) });
  const day = to_epoch_day(fact.date);
  const alloc_id = release_allocation_id(reserve.reserve_id, id);
  const all = state.allocations ?? [];
  if (all.some((a) => a.allocation_id === alloc_id)) return { ...empty, already: true };
  const prior = all.filter((a) => !(a.source === 'income' && to_epoch_day(a.date) === day)); // D-08: аллокации доходов дня — после платежа
  const funded = reserve_open(reserve, prior, day);
  const pay = -in_decision(state, fact, amt, day);
  const { released, true_up } = release_on_payment(funded, pay);
  let allocation = null;
  if (released > 0) {
    allocation = { allocation_id: alloc_id, reserve_id: reserve.reserve_id, date: format_date(day), amount_minor: -released, source: 'release', source_event_id: id };
  }
  return {
    released_minor: released, true_up_minor: true_up, funded_before_minor: funded, allocation, already: false,
    events: allocation === null || ctx === undefined || ctx === null ? [] : [to_event(allocation, ctx)],
  };
}

/**
 * Проведённые факты, которые ещё не оставили записей в резерве: доходы, подпадающие под правило, и платежи с `reserve_id`.
 * Факты не позже даты `funded_as_of` резерва уже учтены в его начальном состоянии (`reserve_open` их игнорирует) и сюда не попадают.
 * Платежи и доходы разбираются по порядку дат, каждая следующая запись видит предыдущие (два платежа одного дня не высвобождают одни деньги дважды).
 * Ошибка по одному факту (например, нет курса) не прерывает остальные: у такой строки `error = {code}` и пустые заготовки.
 * @param {object} ws рабочая область
 * @param {{as_of?: string|number}} [opts] по умолчанию `ws.as_of`
 * @returns {{event_id: string, date: string, kind: 'income'|'payment', allocations: object[], released_minor?: number, true_up_minor?: number, error?: {code: string}}[]}
 */
export function pending_posted_allocations(ws, opts = {}) {
  const w = normalize_ws(ws);
  const asof = to_epoch_day(opts.as_of ?? ws.as_of);
  const state = { tax_rules: w.tax_rules, rates: w.rates, decision_currency: w.decision_currency, rounding: w.params.rounding, reserves: w.reserves, allocations: [...w.allocations] };
  const funded_from = new Map(w.reserves.map((r) => [r.reserve_id, r.funded_as_of === undefined || r.funded_as_of === null ? -Infinity : to_epoch_day(r.funded_as_of)]));
  const facts = [...w.facts].sort((a, b) => (a.date - b.date) || (a.cash_event_id < b.cash_event_id ? -1 : a.cash_event_id > b.cash_event_id ? 1 : 0));
  const out = [];
  for (const f of facts) {
    if (f.date > asof || (f.transfer_id !== undefined && f.transfer_id !== null)) continue;
    const event_id = f.event_id ?? f.cash_event_id;
    try {
      if (f.amount_minor > 0) {
        const items = on_posted_income(state, { ...f, event_id }).allocations.filter((p) => f.date > (funded_from.get(p.reserve_id) ?? -Infinity));
        if (items.length === 0) continue;
        state.allocations.push(...items);
        out.push({ event_id, date: format_date(f.date), kind: 'income', allocations: items });
      } else if (f.amount_minor < 0 && typeof f.reserve_id === 'string' && f.reserve_id !== '') {
        if (f.date <= (funded_from.get(f.reserve_id) ?? -Infinity)) continue;
        const r = on_posted_payment(state, { ...f, event_id });
        if (r.already) continue;
        if (r.allocation !== null) state.allocations.push(r.allocation);
        out.push({
          event_id, date: format_date(f.date), kind: 'payment', allocations: r.allocation === null ? [] : [r.allocation],
          released_minor: r.released_minor, true_up_minor: r.true_up_minor,
        });
      }
    } catch (e) {
      out.push({ event_id, date: format_date(f.date), kind: f.amount_minor > 0 ? 'income' : 'payment', allocations: [], error: { code: typeof e?.code === 'string' ? e.code : 'E_SCHEMA' } });
    }
  }
  return out;
}
