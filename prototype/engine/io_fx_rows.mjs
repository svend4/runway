// io_fx_rows.mjs — строки CSV в чужой валюте с двумя ногами: обмен вместо отказа `currency_mismatch` (ALG-14 A14.7, ALG-08 A08.3, IDEA-19; волна 3а-2, FP-29).
// Строка выписки счёта в валюте A, у которой валюта операции C1 ≠ A, но есть вторая пара колонок «сумма · валюта» (нога в валюте счёта), — это обмен между двумя
// собственными счетами: нога C1 лежит на втором счёте в C1, нога A — на счёте импорта. Курс обмена выводится из ног (`implied_rate`, дробь как есть, без округления),
// курс из данных (`rate_at`) нужен для справочной разницы (`exchange_difference`): она в расчёт «свободно» не входит.
// Модуль надстройка над `parse_with_profile`: основной разбор io.mjs не меняется, строки `currency_mismatch` получают второй шанс (`merge_fx_rows`).
//
// Правила. Профиль строк обмена — данные: обычный профиль CSV (проверяется `validate_profile`) плюс блок `fx` (проверяется `validate_fx_config`):
//   fx: { counter_amount: { col, unit?: 'major'|'minor', decimal?, thousands? }, counter_currency: { col } | { fixed } }.
// Нога A обязана быть в валюте счёта импорта (иначе `fx_not_account_currency`); знаки ног противоположны (явный знак второй ноги, совпадающий со знаком первой, —
// `fx_sign`; сумма без знака берёт противоположный); счёт второй ноги — единственный открытый счёт в C1 либо заданный явно (`fx_no_counter_account`).
// Курс пары «валюта → валюта решения» нужен для каждой ноги на операционном счёте (как у `add_fact`): нет курса — строка отклонена (`no_rate`), пара названа в
// `fx.missing_pairs` (код канона `E_NO_RATE`, `require_rate`), а не молчаливый ноль. Повторный импорт того же файла даёт дубликаты: ключ строки (`dedup_key`)
// считается от ноги счёта импорта и состава обмена и записывается в эту ногу.
// Зависимости: money, dates, ledger, io, fx. Модуль чистый; из index.mjs не реэкспортируется. Расчёт по введённым данным и правилам, не консультация.

import { fail, currency_exponent } from './money.mjs';
import { to_epoch_day, format_date } from './dates.mjs';
import { parse_csv, parse_with_profile, parse_amount_cell, validate_profile } from './io.mjs';
import { dedup_key, norm } from './ledger.mjs';
import { implied_rate, exchange_difference, rate_at } from './fx.mjs';

/** Идентификатор встроенного профиля строк обмена. */
export const FX_ROWS_PROFILE_ID = 'fx-rows-csv/1';
/** Причины отклонения строки обмена. Для каждой есть строка `importv11.rj_<причина>` в каталоге демо. */
export const FX_REJECT_REASONS = Object.freeze([
  'fx_no_counter', 'fx_bad_counter', 'fx_not_account_currency', 'fx_sign', 'fx_no_counter_account', 'no_rate',
]);
/** Сколько разных чужих валют разбирается за один прогон; строки остальных остаются отклонёнными как `currency_mismatch`. */
export const MAX_FX_CURRENCIES = 8;

/**
 * Встроенный профиль строк обмена: собственные колонки Runway (`amount_minor`, `currency`, `counter_amount_minor`, `counter_currency`, `note`).
 * Совпадает с data/profiles/fx-rows-csv-1.json (тест сверки).
 */
export const FX_ROWS_PROFILE = Object.freeze({
  profile_id: FX_ROWS_PROFILE_ID,
  v: 1,
  encoding: 'utf-8',
  delimiter: ',',
  skip: 0,
  date: Object.freeze({ col: 'date', fmt: 'YYYY-MM-DD' }),
  amount: Object.freeze({ mode: 'signed', col: 'amount_minor', unit: 'minor' }),
  currency: Object.freeze({ col: 'currency' }),
  desc: Object.freeze({ cols: Object.freeze(['note']), csv_safe: true }),
  rules: Object.freeze([]),
  fx: Object.freeze({
    counter_amount: Object.freeze({ col: 'counter_amount_minor', unit: 'minor' }),
    counter_currency: Object.freeze({ col: 'counter_currency' }),
  }),
});

const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const is_col = (c) => (typeof c === 'string' && c !== '') || (Number.isInteger(c) && c >= 0);
const CODE_RE = /^[A-Z][A-Z0-9]{1,9}$/;
/** Условный счёт первой ноги при разборе: идентификатор без `|` (`dedup_key` их не принимает), в результат не попадает. */
const MAIN_ACCOUNT = 'fx~main';

/** Профиль строк обмена несёт блок `fx`. */
export function has_fx_block(p) {
  return is_obj(p) && is_obj(p.fx);
}

/**
 * Проверка блока `fx`: только известные поля, колонки, единицы суммы. Не бросает исключений.
 * @param {object} fx
 * @returns {{ok: boolean, errors: {field: string, reason: string}[]}}
 */
export function validate_fx_config(fx) {
  const errors = [];
  const bad = (field, reason) => errors.push({ field, reason });
  const only = (obj, allowed, where) => { for (const k of Object.keys(obj)) if (!allowed.has(k)) bad(where + '.' + k, 'unknown_field'); };
  if (!is_obj(fx)) return { ok: false, errors: [{ field: 'fx', reason: 'not_object' }] };
  only(fx, new Set(['counter_amount', 'counter_currency']), 'fx');
  const a = fx.counter_amount;
  if (!is_obj(a)) bad('fx.counter_amount', 'required_object');
  else {
    only(a, new Set(['col', 'unit', 'decimal', 'thousands']), 'fx.counter_amount');
    if (!is_col(a.col)) bad('fx.counter_amount.col', 'bad_column');
    if (a.unit !== undefined && a.unit !== 'major' && a.unit !== 'minor') bad('fx.counter_amount.unit', 'must_be_major_or_minor');
    if (a.decimal !== undefined && (typeof a.decimal !== 'string' || a.decimal.length !== 1 || /[0-9+\-−]/.test(a.decimal))) bad('fx.counter_amount.decimal', 'bad_char');
    if (a.thousands !== undefined && (typeof a.thousands !== 'string' || a.thousands.length > 1 || /[0-9+\-−]/.test(a.thousands) || (a.thousands !== '' && a.thousands === (a.decimal ?? '.')))) bad('fx.counter_amount.thousands', 'bad_char');
  }
  const c = fx.counter_currency;
  if (!is_obj(c)) bad('fx.counter_currency', 'required_object');
  else {
    only(c, new Set(['fixed', 'col']), 'fx.counter_currency');
    const has_fixed = c.fixed !== undefined;
    const has_col = c.col !== undefined;
    if (has_fixed === has_col) bad('fx.counter_currency', 'exactly_one_of_fixed_col');
    else if (has_fixed && !(typeof c.fixed === 'string' && CODE_RE.test(c.fixed))) bad('fx.counter_currency.fixed', 'bad_code');
    else if (has_col && !is_col(c.col)) bad('fx.counter_currency.col', 'bad_column');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Разделить профиль строк обмена на обычный профиль CSV (для `parse_with_profile`) и блок `fx`. Профиль без блока — `fx: null`.
 * @param {object} profile
 * @returns {{base: object, fx: object|null}}
 */
export function split_fx_profile(profile) {
  if (!has_fx_block(profile)) return { base: profile, fx: null };
  const { fx, ...base } = profile;
  return { base, fx };
}

/**
 * Курс «валюта → валюта решения» на дату: есть — вернуть, нет — `E_NO_RATE` с парой (как `to_decision` движка).
 * @param {object[]} rates курсы рабочей области
 * @param {string} currency
 * @param {string|null} decision_currency
 * @param {number|string} date
 * @returns {{num: number, den: number, date: number, inverse: boolean}|null} `null`, если валюта совпадает с валютой решения (курс не нужен)
 * @throws {RunwayError} E_NO_RATE
 */
export function require_rate(rates, currency, decision_currency, date) {
  if (decision_currency === null || decision_currency === undefined || currency === decision_currency) return null;
  let r = null;
  try { r = rate_at(rates ?? [], currency, decision_currency, date); } catch (e) { if (e?.name !== 'RunwayError') throw e; r = null; }
  if (r === null) fail('E_NO_RATE', { pair: currency + '/' + decision_currency, reason: 'no_rate' });
  return r;
}

const account_exp = (a) => (Number.isInteger(a?.exponent) ? a.exponent : currency_exponent(a.currency));

/** Счёт открыт на дату расчёта. */
function is_open(a, as_of) {
  if (!is_obj(a) || typeof a.account_id !== 'string') return false;
  if (typeof a.closed_on !== 'string') return true;
  try { return to_epoch_day(a.closed_on) > as_of; } catch { return false; }
}

/** Ячейка второй суммы (не пустая) → величина (> 0) и явный знак (−1, 0 — знака нет, +1) либо `null`. */
function parse_counter(cell, spec, currency) {
  const raw = String(cell ?? '').trim().replace(/−/g, '-');
  const sign = raw[0] === '-' ? -1 : raw[0] === '+' ? 1 : 0;
  const body = sign === 0 ? raw : raw.slice(1).trim();
  let v;
  if (spec.unit === 'minor') {
    if (!/^\d{1,15}$/.test(body)) return null;
    v = Number(body);
  } else {
    v = parse_amount_cell(body, { decimal: spec.decimal ?? '.', thousands: spec.thousands ?? '' }, currency_exponent(currency));
  }
  if (v === null || !Number.isSafeInteger(v) || v <= 0) return null;
  return { magnitude: v, sign };
}

/** Индекс колонки по имени или номеру; нет в заголовке — `E_SCHEMA` (как у `parse_with_profile`). */
function column_index(header, ref, where) {
  if (typeof ref === 'number') {
    if (ref >= header.length) fail('E_SCHEMA', { reason: 'column_index_out_of_header', where, col: ref });
    return ref;
  }
  const i = header.indexOf(ref);
  if (i < 0) fail('E_SCHEMA', { reason: 'unknown_column', where, col: ref });
  return i;
}

/**
 * Вторая попытка для строк `currency_mismatch` результата `parse_with_profile`: строка с парой «сумма · валюта» второй ноги становится обменом
 * (кандидат с полем `exchange`), остальные получают точную причину. Остальные кандидаты и отказы не меняются. Обмен — одна строка файла: в отчёте сухого прогона
 * она считается один раз (`recognized + rejected + duplicates = rows_total`), в журнал пишутся две ноги.
 * @param {{candidates: object[], rejects: {row: number, reason: string}[], rows_total: number}} parsed результат основного разбора
 * @param {object} profile обычный профиль CSV (без блока `fx`)
 * @param {object} fx блок `fx` (`validate_fx_config`)
 * @param {string} text тот же текст файла
 * @param {{account_id: string, account_currency: string, as_of: string|number, accounts: object[], rates: object[], decision_currency?: string|null,
 *   counter_account_id?: string|null, rounding?: string}} ctx
 * @returns {{candidates: object[], rejects: {row: number, reason: string}[], rows_total: number,
 *   fx: {mismatch_rows: number, converted: number, rejected: number, missing_pairs: string[], errors: {code: 'E_NO_RATE', ctx: {pair: string, reason: string}}[], skipped_currencies: number}}}
 * @throws {RunwayError} E_SCHEMA — плохой профиль или блок `fx`, неизвестная колонка
 */
export function merge_fx_rows(parsed, profile, fx, text, ctx) {
  const vp = validate_profile(profile);
  if (!vp.ok) fail('E_SCHEMA', { reason: 'bad_profile', errors: vp.errors });
  const vf = validate_fx_config(fx);
  if (!vf.ok) fail('E_SCHEMA', { reason: 'bad_fx_config', errors: vf.errors });
  if (!is_obj(ctx) || typeof ctx.account_id !== 'string' || typeof ctx.account_currency !== 'string') fail('E_SCHEMA', { reason: 'ctx_required', need: 'account_id, account_currency, as_of, accounts, rates' });
  const info = { mismatch_rows: 0, converted: 0, rejected: 0, missing_pairs: [], errors: [], skipped_currencies: 0 };
  const mism = parsed.rejects.filter((r) => r.reason === 'currency_mismatch');
  info.mismatch_rows = mism.length;
  if (mism.length === 0) return { candidates: parsed.candidates, rejects: parsed.rejects, rows_total: parsed.rows_total, fx: info };

  const as_of = to_epoch_day(ctx.as_of);
  const A = ctx.account_currency;
  const skip = profile.skip ?? 0;
  const table = parse_csv(text, { delimiter: profile.delimiter });
  const header = table[skip].map((h) => h.trim());
  const data = table.slice(skip + 1);
  const ix = {
    cur: profile.currency.col !== undefined ? column_index(header, profile.currency.col, 'currency') : -1,
    amount: column_index(header, fx.counter_amount.col, 'fx.counter_amount'),
    ccur: fx.counter_currency.col !== undefined ? column_index(header, fx.counter_currency.col, 'fx.counter_currency') : -1,
  };
  const cells_of = (row) => data[row - skip - 2] ?? [];
  const cur_of = (row) => (profile.currency.fixed ?? String(cells_of(row)[ix.cur] ?? '').trim().toUpperCase());

  // чужие валюты строк, по порядку первого появления; сверх предела строки остаются отклонёнными как были
  const by_cur = new Map();
  for (const r of mism) { const c = cur_of(r.row); if (!by_cur.has(c)) by_cur.set(c, new Set()); by_cur.get(c).add(r.row); }
  const handled = new Set();
  const taken = [...by_cur.keys()].slice(0, MAX_FX_CURRENCIES);
  info.skipped_currencies = by_cur.size - taken.length;

  const open = (Array.isArray(ctx.accounts) ? ctx.accounts : []).filter((a) => is_open(a, as_of));
  const target = open.find((a) => a.account_id === ctx.account_id) ?? { account_id: ctx.account_id, currency: A, liquidity: 'operating' };
  const dec = ctx.decision_currency ?? null;
  const rates = Array.isArray(ctx.rates) ? ctx.rates : [];
  const out_cands = [];
  const out_rejects = [];
  const missing = new Set();
  const seen = new Map();

  for (const C1 of taken) {
    const rows = by_cur.get(C1);
    const pc = parse_with_profile(profile, text, { account_id: MAIN_ACCOUNT, account_currency: C1, as_of });
    for (const r of pc.rejects) if (rows.has(r.row) && r.reason !== 'currency_mismatch') { out_rejects.push({ row: r.row, reason: r.reason }); handled.add(r.row); }
    const counters = open.filter((a) => a.currency === C1 && a.account_id !== target.account_id);
    for (const c of pc.candidates) {
      if (!rows.has(c.row)) continue;
      handled.add(c.row);
      const reject = (reason) => { out_rejects.push({ row: c.row, reason }); };
      const cells = cells_of(c.row);
      const A2 = fx.counter_currency.fixed ?? String(cells[ix.ccur] ?? '').trim().toUpperCase();
      if (String(cells[ix.amount] ?? '').trim() === '' || A2 === '') { reject('fx_no_counter'); continue; }
      try { currency_exponent(A2); } catch (e) { if (e?.name === 'RunwayError') { reject('unknown_currency'); continue; } throw e; }
      if (A2 !== A) { reject('fx_not_account_currency'); continue; }
      const amt = parse_counter(cells[ix.amount], fx.counter_amount, A);
      if (amt === null) { reject('fx_bad_counter'); continue; }
      const sgn = -Math.sign(c.amount_minor);
      if (amt.sign !== 0 && amt.sign !== sgn) { reject('fx_sign'); continue; }
      const own = ctx.counter_account_id ?? null;
      const counter = own !== null ? counters.find((a) => a.account_id === own) : (counters.length === 1 ? counters[0] : undefined);
      if (counter === undefined) { reject('fx_no_counter_account'); continue; }
      // курсы: каждая нога на операционном счёте должна переводиться в валюту решения (как `add_fact`)
      let no_rate = false;
      for (const [acc, cur] of [[target, A], [counter, C1]]) {
        if (acc.liquidity !== 'operating') continue;
        try { require_rate(rates, cur, dec, c.date); } catch (e) { if (e?.code === 'E_NO_RATE') { missing.add(e.ctx.pair); no_rate = true; } else throw e; }
      }
      if (no_rate) { reject('no_rate'); continue; }
      const target_minor = sgn * amt.magnitude;
      const sold_target = target_minor < 0;
      const sold = sold_target ? { acc: target, minor: -target_minor, cur: A } : { acc: counter, minor: -c.amount_minor, cur: C1 };
      const got = sold_target ? { acc: counter, minor: c.amount_minor, cur: C1 } : { acc: target, minor: target_minor, cur: A };
      let implied;
      try { implied = implied_rate(sold.minor, got.minor, account_exp(sold.acc), account_exp(got.acc)); } catch (e) { if (e?.name === 'RunwayError') { reject('fx_bad_counter'); continue; } throw e; }
      let spot = null;
      try { spot = rate_at(rates, sold.cur, got.cur, c.date); } catch (e) { if (e?.name !== 'RunwayError') throw e; spot = null; }
      const diff = spot === null ? null : exchange_difference(sold.minor, got.minor, account_exp(sold.acc), account_exp(got.acc), spot, ctx.rounding ?? 'half_even');
      // ключ строки: нога счёта импорта и состав обмена (иначе обычная строка с той же датой, суммой и описанием дала бы тот же ключ)
      const key_desc = c.desc + ' fx ' + C1 + ' ' + Math.abs(c.amount_minor);
      const g = c.date + '|' + target_minor + '|' + A + '|' + norm(key_desc);
      const k = seen.get(g) ?? 0;
      seen.set(g, k + 1);
      out_cands.push({
        row: c.row, account_id: target.account_id, date: c.date, amount_minor: target_minor, currency: A, desc: c.desc, tag: c.tag, k,
        dedup_key: dedup_key(target.account_id, c.date, target_minor, A, key_desc, k),
        exchange: {
          counter_account_id: counter.account_id, counter_currency: C1, counter_amount_minor: c.amount_minor, sold: sold_target ? 'target' : 'counter',
          sold_currency: sold.cur, sold_minor: sold.minor, got_currency: got.cur, got_minor: got.minor, implied: { num: implied.num, den: implied.den },
          spot: spot === null ? null : { num: spot.num, den: spot.den, inverse: spot.inverse === true }, diff_minor: diff,
        },
      });
    }
  }
  info.converted = out_cands.length;
  info.rejected = out_rejects.length;
  info.missing_pairs = [...missing].sort();
  info.errors = info.missing_pairs.map((pair) => ({ code: 'E_NO_RATE', ctx: { pair, reason: 'no_rate' } })); // код канона для экрана и вызывающего кода: нет курса пары
  const rejects = [...parsed.rejects.filter((r) => !handled.has(r.row)), ...out_rejects].sort((a, b) => a.row - b.row);
  const candidates = [...parsed.candidates, ...out_cands].sort((a, b) => a.row - b.row);
  return { candidates, rejects, rows_total: parsed.rows_total, fx: info };
}

/**
 * Две ноги обмена кандидата (`exchange`): нога счёта импорта и нога второго счёта; выведенный курс (`fx`) лежит на проданной ноге, как у формы обмена.
 * @param {{account_id: string, currency: string, amount_minor: number, exchange: object}} c кандидат из `merge_fx_rows`
 * @returns {{role: 'target'|'counter', account_id: string, currency: string, amount_minor: number, fx?: {num: number, den: number}}[]}
 */
export function exchange_legs(c) {
  const x = c.exchange;
  const target = { role: 'target', account_id: c.account_id, currency: c.currency, amount_minor: c.amount_minor };
  const counter = { role: 'counter', account_id: x.counter_account_id, currency: x.counter_currency, amount_minor: x.counter_amount_minor };
  (x.sold === 'target' ? target : counter).fx = { num: x.implied.num, den: x.implied.den };
  return [target, counter];
}

/** Дата обмена кандидата ISO (для записи ног). */
export function exchange_date(c) {
  return format_date(c.date);
}
