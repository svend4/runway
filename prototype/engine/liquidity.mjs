// liquidity.mjs — счета по ликвидности и «запас» (FP-08, REQ-018, REQ-080, IDEA-40, ALG-08).
//
// Счёт относится к `liquidity`: `operating` входит в прогноз; `savings`, `asset` и `debt` показываются справочно. «Запас» — деньги, которых в прогнозе
// нет: Σ savings + Σ asset · `liquidity_bp` / 10^4, где `liquidity_bp` по умолчанию 0 (параметр пользователя, никаких процентов haircut от продукта).
// Крипта — счёт `kind = crypto` (экспонента 8 у BTC): в `operating` не входит, в запас идёт только `liquidity_bp` её оценки, то есть по умолчанию 0.
// Запас показывается ОТДЕЛЬНО от остатка `operating` и от резервов; в «можно потратить» он не входит.
//
// Остаток счёта — от последнего якоря (дата не позже `as_of`) плюс проведённые факты после якоря; нет ни якоря, ни фактов — остаток неизвестен
// (`balance_minor = null`), а не «ноль». Суммы — целые minor, пересчёт в валюту решения — `fx.liquid_value` / `fx.to_decision` (одно округление на сумму;
// нет курса — строка помечается `E_NO_RATE`, итог не молчит об этом: `complete = false`).
// Зависимости: money, dates, fx, sinking, timeline. Модуль чистый: ни часов, ни случайности, ни ввода-вывода. Это расчёт по введённым данным, не консультация.

import { sum_minor, assert_minor } from './money.mjs';
import { to_epoch_day, format_date } from './dates.mjs';
import { liquid_value, to_decision } from './fx.mjs';
import { reserve_open } from './sinking.mjs';
import { normalize_ws } from './timeline.mjs';

/** Группы счетов для показа (порядок — как в интерфейсе). */
export const LIQUIDITY_GROUPS = Object.freeze(['operating', 'savings', 'asset', 'debt']);

/** Счёт открыт на дату и не закрыт (как в расчёте остатков движка). */
function active_on(a, asof) {
  if (a.opened_on !== undefined && a.opened_on !== null && to_epoch_day(a.opened_on) > asof) return false;
  if (a.closed_on !== undefined && a.closed_on !== null && to_epoch_day(a.closed_on) <= asof) return false;
  return true;
}

/**
 * Остаток счёта на `as_of` в валюте счёта: последний якорь (не позже `as_of`) + факты после него, не позже `as_of`.
 * @param {{anchors: {account_id: string, date: number, amount_minor: number}[], facts: {account_id: string, date: number, amount_minor: number}[]}} w нормализованная рабочая область
 * @param {{account_id: string}} account
 * @param {number} asof EpochDay
 * @returns {number|null} `null` — ни якоря, ни фактов: остаток неизвестен
 */
export function account_balance(w, account, asof) {
  let last = null;
  for (const a of w.anchors) if (a.account_id === account.account_id && a.date <= asof && (last === null || a.date >= last.date)) last = a;
  const mine = w.facts.filter((f) => f.account_id === account.account_id && (last === null || f.date > last.date) && f.date <= asof);
  if (last === null && mine.length === 0) return null;
  return sum_minor([last === null ? 0 : last.amount_minor, ...mine.map((f) => f.amount_minor)]);
}

/**
 * Отчёт по счетам и запасу на `as_of`.
 * @param {object} ws рабочая область
 * @param {string|number} [as_of] по умолчанию `ws.as_of`
 * @returns {{as_of: string, decision_currency: string, accounts: {account_id: string, name: string, kind: string, liquidity: string, currency: string,
 *   exponent: number, liquidity_bp: number, balance_minor: number|null, value_minor: number|null, error: string|null}[],
 *   operating_minor: number, stock_minor: number, savings_minor: number, asset_minor: number, crypto_minor: number, reserve_minor: number,
 *   complete: boolean}}
 *   `value_minor`: для `operating` — остаток в валюте решения; для `savings`/`asset`/крипты — вклад в запас; для `debt` — 0 (справочно);
 *   `operating_minor` — остаток операционных счетов в валюте решения; `reserve_minor` — резервы, не привязанные к счёту; `complete` — все нужные курсы есть
 */
export function liquidity_report(ws, as_of) {
  const w = normalize_ws(ws);
  const asof = to_epoch_day(as_of ?? ws.as_of);
  const dec = w.decision_currency;
  const policy = { kind: 'spot', as_of: asof, shock: {}, rounding: w.params.rounding };
  const fx_ctx = { rates: w.rates, decision_currency: dec, policy, rounding: w.params.rounding };
  const rows = [];
  let complete = true;
  const parts = { operating: [], savings: [], asset: [], crypto: [] };
  for (const a of w.accounts) {
    if (!active_on(a, asof)) continue;
    const exponent = Number.isInteger(a.exponent) ? a.exponent : null;
    const balance = account_balance(w, a, asof);
    const row = {
      account_id: a.account_id, name: String(a.name ?? a.account_id), kind: a.kind, liquidity: a.liquidity, currency: a.currency,
      exponent, liquidity_bp: Number.isInteger(a.liquidity_bp) ? a.liquidity_bp : 0, balance_minor: balance, value_minor: null, error: null,
    };
    try {
      if (a.liquidity === 'operating') {
        if (a.kind === 'crypto') throw Object.assign(new Error('crypto_in_operating'), { code: 'E_SCHEMA' }); // крипта в operating недопустима (REQ-080)
        row.value_minor = balance === null ? 0 : to_decision(balance, a.currency, asof, fx_ctx).amount_minor;
        parts.operating.push(row.value_minor);
      } else if (a.liquidity === 'debt') {
        row.value_minor = 0; // долг справочно: в запас не входит
      } else {
        row.value_minor = balance === null ? 0 : liquid_value(a, balance, w.rates, fx_ctx);
        parts[a.kind === 'crypto' ? 'crypto' : a.liquidity].push(row.value_minor);
      }
    } catch (e) {
      row.error = typeof e?.code === 'string' ? e.code : 'E_SCHEMA';
      row.value_minor = null;
      complete = false;
    }
    rows.push(row);
  }
  const reserve_minor = sum_minor(w.reserves.filter((r) => r.backed_by_account_id === null || r.backed_by_account_id === undefined).map((r) => reserve_open(r, w.allocations, asof)));
  const savings = sum_minor(parts.savings);
  const asset = sum_minor(parts.asset);
  const crypto = sum_minor(parts.crypto);
  return {
    as_of: format_date(asof), decision_currency: dec, accounts: rows, operating_minor: sum_minor(parts.operating),
    stock_minor: assert_minor(savings + asset + crypto), savings_minor: savings, asset_minor: asset, crypto_minor: crypto, reserve_minor, complete,
  };
}
