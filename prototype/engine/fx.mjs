// fx.mjs — курсы валют и перевод в валюту решения (ALG-08).
// Канон: design-brief D-20, §9.12, C-034…C-038, X4; canon-decisions «Финальные сигнатуры» (fx.mjs); ADR-012, ADR-002.
// Зависимости: money, dates. Чистые функции: курс — дробь `num/den` из целых, перевод через BigInt, один округляющий шаг на сумму.
// Никаких float: курс хранится как введён (`9250/10000`), производные курсы (`implied_rate`, `apply_shock`) — несократимая дробь.

import { fail, assert_minor, round_div, gcd, sum_minor, currency_exponent } from './money.mjs';
import { to_epoch_day } from './dates.mjs';
import { vdefault as vd } from './param_defaults.mjs';

/** @typedef {import('./money.mjs').Minor} Minor */
/** @typedef {import('./money.mjs').RoundMode} RoundMode */
/** @typedef {import('./dates.mjs').EpochDay} EpochDay */
/**
 * Курс `FxRate`: 1 основная единица `base` = `num/den` основных единиц `quote`.
 * @typedef {object} FxRate
 * @property {string} [fx_id]
 * @property {EpochDay|string} date дата курса (EpochDay или IsoDate)
 * @property {string} base
 * @property {string} quote
 * @property {number} num > 0
 * @property {number} den > 0
 */
/**
 * Найденный курс пары.
 * @typedef {object} RateAt
 * @property {number} num
 * @property {number} den
 * @property {EpochDay} date
 * @property {boolean} inverse `true`, если найдена только обратная пара и дробь перевёрнута (C-036)
 */
/**
 * Политика курса v1: `spot`. Строка `'spot'` приводится к записи `normalize_policy`.
 * @typedef {object} FxPolicy
 * @property {'spot'} kind
 * @property {EpochDay} as_of
 * @property {Object<string, number>} shock сценарий курса: валюта → bp (v1.1); пусто = без сдвига
 * @property {RoundMode} rounding
 */
/**
 * Контекст перевода (C-034).
 * @typedef {object} FxCtx
 * @property {FxRate[]} rates
 * @property {string} decision_currency
 * @property {'spot'|FxPolicy} policy
 * @property {RoundMode} [rounding] по умолчанию — `policy.rounding`
 */

const MODES = ['half_even', 'half_up', 'floor', 'ceil'];

/** Целое > 0 (числитель/знаменатель курса); иначе E_SCHEMA. */
function pos_int(x, what) {
  if (typeof x !== 'number' || !Number.isSafeInteger(x) || x <= 0) fail('E_SCHEMA', { reason: 'not_positive_integer', field: what, value: String(x) });
  return x;
}

/** Экспонента валюты: целое ≥ 0; иначе E_SCHEMA. */
function exp_int(x, what) {
  if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < 0) fail('E_SCHEMA', { reason: 'bad_exponent', field: what, value: String(x) });
  return x;
}

/**
 * Перевод суммы между валютами с разными экспонентами:
 * `round_div(a · num · 10^quote_exp, den · 10^base_exp, mode)`; всё считается в BigInt, результат — safe-integer.
 * @param {Minor} a сумма в minor валюты `base`
 * @param {number} base_exp экспонента `base` (число знаков minor)
 * @param {number} quote_exp экспонента `quote`
 * @param {number} num числитель курса > 0
 * @param {number} den знаменатель курса > 0
 * @param {RoundMode} [mode] по умолчанию `half_even`
 * @returns {Minor}
 * @throws {RunwayError} E_SCHEMA (курс ≤ 0, экспоненты), E_NOT_INTEGER, E_OVERFLOW (результат вне safe-integer)
 */
export function convert_minor(a, base_exp, quote_exp, num, den, mode = 'half_even') {
  const v = assert_minor(a);
  const nu = pos_int(num, 'num');
  const de = pos_int(den, 'den');
  const be = exp_int(base_exp, 'base_exp');
  const qe = exp_int(quote_exp, 'quote_exp');
  const n = BigInt(v) * BigInt(nu) * 10n ** BigInt(qe);
  const d = BigInt(de) * 10n ** BigInt(be);
  return round_div(n, d, mode);
}

/**
 * Курс, выведенный из двух ног обмена: `implied = leg_b / leg_a` (основные единицы), несократимая дробь.
 * Экспоненты обязательны (C-034): без них курс неверен при разных экспонентах.
 * @param {Minor} leg_a модуль проданной ноги в minor (валюта `base`) > 0
 * @param {Minor} leg_b модуль полученной ноги в minor (валюта `quote`) > 0
 * @param {number} base_exp экспонента валюты проданной ноги
 * @param {number} quote_exp экспонента валюты полученной ноги
 * @returns {{num: number, den: number}}
 * @throws {RunwayError} E_SCHEMA (нога ≤ 0), E_OVERFLOW (дробь не помещается в safe-integer)
 */
export function implied_rate(leg_a, leg_b, base_exp, quote_exp) {
  const a = assert_minor(leg_a);
  const b = assert_minor(leg_b);
  if (a <= 0 || b <= 0) fail('E_SCHEMA', { reason: 'leg_not_positive', leg_a: a, leg_b: b });
  const be = exp_int(base_exp, 'base_exp');
  const qe = exp_int(quote_exp, 'quote_exp');
  const n = BigInt(b) * 10n ** BigInt(be);
  const d = BigInt(a) * 10n ** BigInt(qe);
  const g = gcd(n, d);
  return { num: assert_minor(n / g), den: assert_minor(d / g) };
}

/**
 * Сценарий курса (v1.1): курс × `(10000 + bp)/10000`, результат — несократимая дробь.
 * @param {{num: number, den: number, date?: EpochDay}} rate курс, ориентированный «валюта → валюта решения»
 * @param {number} bp сдвиг в базисных пунктах (−500 = −5 %); `10000 + bp` должно быть > 0
 * @returns {{num: number, den: number, date: EpochDay}}
 * @throws {RunwayError} E_SCHEMA (курс ≤ 0, bp не целое, 10000 + bp ≤ 0), E_OVERFLOW
 */
export function apply_shock(rate, bp) {
  if (typeof bp !== 'number' || !Number.isSafeInteger(bp)) fail('E_SCHEMA', { reason: 'shock_bp_not_integer', value: String(bp) });
  const f = 10000 + bp;
  if (f <= 0) fail('E_SCHEMA', { reason: 'shock_makes_rate_non_positive', bp });
  const n = BigInt(pos_int(rate?.num, 'num')) * BigInt(f);
  const d = BigInt(pos_int(rate?.den, 'den')) * 10000n;
  const g = gcd(n, d);
  return { num: assert_minor(n / g), den: assert_minor(d / g), date: rate.date };
}

/**
 * Привести политику курса к записи: строка `'spot'` → `{kind: 'spot', as_of}`; запись дополняется
 * `shock = {}`, `rounding = 'half_even'`. Идемпотентна: запись возвращается тем же содержимым.
 * @param {'spot'|Partial<FxPolicy>} policy
 * @param {EpochDay|string} [as_of] дата `spot`, если в записи её нет
 * @returns {FxPolicy}
 * @throws {RunwayError} E_SCHEMA (kind ≠ spot — native/adverse это v2), E_BAD_DATE (нет даты)
 */
export function normalize_policy(policy, as_of) {
  const p = policy === 'spot' ? { kind: 'spot' } : policy;
  if (p === null || typeof p !== 'object' || p.kind !== 'spot') fail('E_SCHEMA', { reason: 'unsupported_fx_policy', value: typeof policy === 'string' ? policy : String(p?.kind) });
  const rounding = p.rounding ?? 'half_even';
  if (!MODES.includes(rounding)) fail('E_SCHEMA', { reason: 'unknown_round_mode', value: String(rounding) });
  const shock = p.shock ?? {};
  if (shock === null || typeof shock !== 'object') fail('E_SCHEMA', { reason: 'shock_not_object' });
  for (const [cur, bp] of Object.entries(shock)) {
    if (typeof bp !== 'number' || !Number.isSafeInteger(bp) || 10000 + bp <= 0) fail('E_SCHEMA', { reason: 'bad_shock_bp', currency: cur, value: String(bp) });
  }
  return { kind: 'spot', as_of: to_epoch_day(p.as_of ?? as_of), shock: { ...shock }, rounding };
}

/** Порядок «новее»: дата, затем fx_id (строка), затем num, den — чтобы результат не зависел от порядка `rates`. */
function newer(r, rd, best) {
  if (rd !== best.rd) return rd > best.rd;
  const a = String(r.fx_id ?? '');
  const b = String(best.r.fx_id ?? '');
  if (a !== b) return a > b;
  if (r.num !== best.r.num) return r.num > best.r.num;
  return r.den > best.r.den;
}

/**
 * Курс пары `base → quote` на дату `d` (политика `spot`): последний курс с датой ≤ `d`.
 * Допускается обратная пара (дробь переворачивается; при равной дате прямой курс приоритетнее, C-036).
 * Триангуляции через третью валюту нет. `base == quote` → `1/1`.
 * @param {FxRate[]} rates
 * @param {string} base
 * @param {string} quote
 * @param {EpochDay|string} d дата `spot` (`as_of`)
 * @param {'spot'|FxPolicy} [_policy] зарезервировано (политика уже нормализована вызывающим)
 * @returns {RateAt|null} `null`, если пары нет ни в прямом, ни в обратном виде
 */
export function rate_at(rates, base, quote, d, _policy) {
  const day = to_epoch_day(d);
  if (base === quote) return { num: 1, den: 1, date: day, inverse: false };
  let c = null;
  let i = null;
  for (const r of rates ?? []) {
    const rd = to_epoch_day(r.date);
    if (rd > day) continue; // курс из «будущего» — не spot
    if (r.base === base && r.quote === quote) {
      if (c === null || newer(r, rd, c)) c = { r, rd };
    } else if (r.base === quote && r.quote === base) {
      if (i === null || newer(r, rd, i)) i = { r, rd };
    }
  }
  if (c === null && i === null) return null;
  if (i === null || (c !== null && c.rd >= i.rd)) {
    return { num: pos_int(c.r.num, 'num'), den: pos_int(c.r.den, 'den'), date: c.rd, inverse: false };
  }
  return { num: pos_int(i.r.den, 'den'), den: pos_int(i.r.num, 'num'), date: i.rd, inverse: true };
}

/**
 * Перевести сумму в валюту решения по `spot` на `as_of` (с учётом сценария курса `policy.shock`).
 * @param {Minor} amount_minor сумма в minor валюты `currency`
 * @param {string} currency валюта суммы
 * @param {EpochDay|string} as_of дата `spot`
 * @param {FxCtx} ctx
 * @returns {{amount_minor: Minor, rate: RateAt|null}} `rate = null`, если валюта уже совпадает с валютой решения
 * @throws {RunwayError} E_NO_RATE (пары нет), E_OVERFLOW
 */
export function to_decision(amount_minor, currency, as_of, ctx) {
  const a = assert_minor(amount_minor);
  const p = normalize_policy(ctx.policy, as_of);
  if (currency === ctx.decision_currency) return { amount_minor: a, rate: null };
  const day = to_epoch_day(as_of);
  let r = rate_at(ctx.rates, currency, ctx.decision_currency, day, p);
  if (r === null) fail('E_NO_RATE', { pair: currency + '/' + ctx.decision_currency });
  const s = Object.hasOwn(p.shock, currency) ? p.shock[currency] : undefined; // код валюты — данные: «constructor» не сдвиг (Q-07)
  if (s !== undefined && s !== null) r = { ...r, ...apply_shock(r, s) };
  const v = convert_minor(a, currency_exponent(currency), currency_exponent(ctx.decision_currency), r.num, r.den, ctx.rounding ?? p.rounding);
  return { amount_minor: v, rate: r };
}

/**
 * События в валюту решения: каждая сумма переводится отдельно (одно округление на событие), курс — `spot`.
 * Справочные счета (не `operating`) в ряд не входят; обе ноги перевода/обмена между своими `operating`-счетами
 * исключаются (D-20). Порядок результата — по `(date, amount_minor, cash_event_id)`; даты и число событий не меняются.
 * К каждому событию добавляются служебные `orig_amount_minor`, `orig_currency`, `rate_used` (в журнал не пишутся);
 * коридор `amount_min_minor`/`amount_max_minor`, если есть, переводится тем же курсом.
 * @param {object[]} events CashEvent[] в валюте счетов
 * @param {object[]} accounts Account[] (`account_id`, `currency`, `liquidity`)
 * @param {FxRate[]} rates
 * @param {string} decision_currency
 * @param {'spot'|FxPolicy} policy
 * @param {EpochDay|string} as_of
 * @param {{external_transfer_ids?: Set<string>}} [opts] `external_transfer_ids` — переводы, у которых есть нога вне переданных `events`
 *   на неоперационном счёте (нога отрезана окном/горизонтом): они НЕ внутренние, operating-нога остаётся расходом/доходом (X12)
 * @returns {object[]}
 * @throws {RunwayError} E_SCHEMA (нет счёта), E_CURRENCY_MISMATCH (валюта события ≠ валюте счёта), E_NO_RATE
 */
export function to_decision_events(events, accounts, rates, decision_currency, policy, as_of, opts) {
  const p = normalize_policy(policy, as_of);
  const ctx = { rates, decision_currency, policy: p, rounding: p.rounding };
  const acc = new Map();
  for (const a of accounts ?? []) acc.set(a.account_id, a);
  // перевод считается «внутренним», если все его ноги лежат на operating-счетах
  const all_operating = new Map();
  for (const id of opts?.external_transfer_ids ?? []) all_operating.set(id, false);
  for (const e of events) {
    if (e.transfer_id === null || e.transfer_id === undefined) continue;
    const a = acc.get(e.account_id);
    all_operating.set(e.transfer_id, (all_operating.get(e.transfer_id) ?? true) && a !== undefined && a.liquidity === 'operating');
  }
  const sorted = [...events].sort((x, y) => {
    const dx = to_epoch_day(x.date);
    const dy = to_epoch_day(y.date);
    if (dx !== dy) return dx - dy;
    if (x.amount_minor !== y.amount_minor) return x.amount_minor - y.amount_minor;
    const ix = String(x.cash_event_id ?? '');
    const iy = String(y.cash_event_id ?? '');
    return ix < iy ? -1 : ix > iy ? 1 : 0;
  });
  const out = [];
  for (const e of sorted) {
    const a = acc.get(e.account_id);
    if (a === undefined) fail('E_SCHEMA', { reason: 'unknown_account', account_id: String(e.account_id) });
    if (e.currency !== a.currency) fail('E_CURRENCY_MISMATCH', { event: e.cash_event_id, event_currency: e.currency, account_currency: a.currency });
    if (a.liquidity !== 'operating') continue; // справочные счета в ряд не входят
    if (e.transfer_id !== null && e.transfer_id !== undefined && all_operating.get(e.transfer_id) === true) continue;
    const v = to_decision(e.amount_minor, a.currency, as_of, ctx);
    const conv = (x) => (v.rate === null ? x : convert_minor(x, currency_exponent(a.currency), currency_exponent(decision_currency), v.rate.num, v.rate.den, p.rounding));
    const ev = {
      ...e,
      amount_minor: v.amount_minor,
      currency: decision_currency,
      orig_amount_minor: e.amount_minor,
      orig_currency: a.currency,
      rate_used: v.rate === null ? null : { num: v.rate.num, den: v.rate.den, date: v.rate.date },
    };
    if (e.amount_min_minor !== undefined && e.amount_min_minor !== null) ev.amount_min_minor = conv(e.amount_min_minor);
    if (e.amount_max_minor !== undefined && e.amount_max_minor !== null) ev.amount_max_minor = conv(e.amount_max_minor);
    out.push(ev);
  }
  return out;
}

/**
 * Остаток всех `operating`-счетов в валюте решения: каждый счёт переводится отдельно по `spot`.
 * Остаток счёта без записи в `balances` считается нулевым.
 * @param {object[]} accounts
 * @param {Object<string, Minor>|Map<string, Minor>} balances `account_id` → остаток в minor валюты счёта
 * @param {FxCtx} ctx
 * @param {EpochDay|string} as_of
 * @returns {Minor}
 */
export function opening_in_decision(accounts, balances, ctx, as_of) {
  const get = balances instanceof Map ? (k) => balances.get(k) : (k) => balances?.[k];
  const parts = [];
  for (const a of accounts ?? []) {
    if (a.liquidity !== 'operating') continue;
    const b = get(a.account_id);
    // ЯВНЫЙ нулевой остаток в любой валюте равен нулю: курс нужен только для ненулевой суммы (Q-16, D-20). Остаток, которого в `balances`
    // нет (счёт не заведён данными), по-прежнему требует курс: тест timeline «нет курса — E_NO_RATE» закрепляет это как сигнал неполных данных
    if (b === 0) { parts.push(0); continue; }
    parts.push(to_decision(b === undefined || b === null ? 0 : b, a.currency, as_of, ctx).amount_minor);
  }
  return sum_minor(parts);
}

/**
 * Курсовая разница обмена (справочно, в `trough` не входит): сколько `spot` дал бы за проданную ногу минус
 * фактически полученная нога. `> 0` — получено меньше, чем по `spot`.
 * @param {Minor} leg_a модуль проданной ноги (minor)
 * @param {Minor} leg_b модуль полученной ноги (minor)
 * @param {number} a_exp экспонента проданной валюты
 * @param {number} b_exp экспонента полученной валюты
 * @param {{num: number, den: number}} spot курс «проданная → полученная»
 * @param {RoundMode} [mode]
 * @returns {Minor}
 */
export function exchange_difference(leg_a, leg_b, a_exp, b_exp, spot, mode = 'half_even') {
  return convert_minor(leg_a, a_exp, b_exp, spot.num, spot.den, mode) - assert_minor(leg_b);
}

/**
 * Вклад счёта в «запас» (не в `operating`-ряд) в валюте решения: `savings` — 100 %, `asset` и крипта —
 * `liquidity_bp / 10000` (по умолчанию 0, C13), остальные — 0. Один шаг округления на всё выражение.
 * Крипта на `operating`-счёте недопустима. Курс — `ctx.policy.as_of` (нужна запись политики, не строка), сценарий курса учитывается.
 * @param {object} account `{currency, exponent?, kind, liquidity, liquidity_bp?}`
 * @param {Minor} balance остаток в minor валюты счёта
 * @param {FxRate[]} rates
 * @param {FxCtx} ctx
 * @returns {Minor}
 * @throws {RunwayError} E_SCHEMA (крипта в operating), E_NO_RATE
 */
export function liquid_value(account, balance, rates, ctx) {
  if (account.kind === 'crypto' && account.liquidity === 'operating') fail('E_SCHEMA', { reason: 'crypto_in_operating', account_id: String(account.account_id) });
  // D-20: у крипты в запас идёт только liquidity_bp (по умолчанию 0), даже если счёт помечен как накопительный
  const w = account.kind === 'crypto' ? (account.liquidity_bp ?? 0)
    : account.liquidity === 'savings' ? 10000
      : account.liquidity === 'asset' ? (account.liquidity_bp ?? 0) : 0;
  if (typeof w !== 'number' || !Number.isSafeInteger(w) || w < 0 || w > 10000) fail('E_SCHEMA', { reason: 'bad_liquidity_bp', value: String(w) });
  if (w === 0) return 0;
  const bal = assert_minor(balance);
  const p = normalize_policy(ctx.policy, ctx.policy?.as_of);
  let r = rate_at(rates, account.currency, ctx.decision_currency, p.as_of, p);
  if (r === null) fail('E_NO_RATE', { pair: account.currency + '/' + ctx.decision_currency });
  const s = Object.hasOwn(p.shock, account.currency) ? p.shock[account.currency] : undefined;
  if (s !== undefined && s !== null) r = { ...r, ...apply_shock(r, s) };
  const acc_exp = account.exponent ?? currency_exponent(account.currency);
  const n = BigInt(bal) * BigInt(r.num) * 10n ** BigInt(currency_exponent(ctx.decision_currency)) * BigInt(w);
  const d = BigInt(r.den) * 10n ** BigInt(exp_int(acc_exp, 'exponent')) * 10000n;
  return round_div(n, d, ctx.rounding ?? p.rounding);
}

/**
 * Свежесть курса: возраст в днях и признак «устарел» (плашка, не блок расчёта; X11, `fx.stale_days` — гипотеза словаря).
 * @param {{date: EpochDay|string}} rate
 * @param {EpochDay|string} as_of
 * @param {number} [stale_days] по умолчанию — `fx.stale_days` из словаря (`vocab.json`, FP-17)
 * @returns {{age: number, stale: boolean}}
 */
export function rate_status(rate, as_of, stale_days = vd('fx.stale_days')) {
  const age = to_epoch_day(as_of) - to_epoch_day(rate.date);
  return { age, stale: age > stale_days };
}
