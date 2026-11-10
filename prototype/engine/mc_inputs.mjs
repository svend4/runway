// mc_inputs.mjs — входы вероятностных расчётов из истории пользователя (FP-11, ALG-10 «Не сделано», ALG-13, REQ-054, REQ-055).
// Что делает модуль: (1) `fx_obs_from_rates` — приращения курса пары в bp из `ws.rates` (вход `ctx.fx_obs_bp` для `montecarlo`; страница ALG-10 писала,
// что такого построителя нет); (2) `plan_occurrences` — плановые вхождения окна (правила, потоки часов, разовые записи, график долгов) в той же форме,
// что собирает `timeline` перед сопоставлением, но БЕЗ отбрасывания сопоставленных и пропущенных (нужны сверке и истории); (3) `match_history` и
// `mc_observations` — история «план ↔ факт»: пары, лаги выплат и отношения сумм по потокам (`lag_obs`, `ratio_obs_bp`) и приращения курсов.
// Модуль — надстройка над ядром (не реэкспортируется из `index.mjs`); зависимости: money, dates, recurrence, hourly, debt, calibration, timeline.
// Чистый: ни часов (`as_of` — аргумент), ни случайности, ни ввода-вывода. Деньги и проценты — целые; float нет.
// Расчёт по введённым данным и истории пользователя, не прогноз и не совет; число наблюдений `n` возвращается всегда.

import { fail, assert_minor, round_div, own_put } from './money.mjs';
import { to_epoch_day } from './dates.mjs';
import { expand_all } from './recurrence.mjs';
import { expand_stream_ex } from './hourly.mjs';
import { schedule_to_events } from './debt.mjs';
import { match_plan_to_fact, lag_observations, flow_calibration, CALIBRATION_DEFAULTS } from './calibration.mjs';
import { normalize_ws } from './timeline.mjs';

/** @typedef {import('./money.mjs').Minor} Minor */
/** @typedef {import('./dates.mjs').EpochDay} EpochDay */

/** Окно наблюдений по умолчанию (`calib.window`, зеркало `calibration`). */
export const DEFAULT_WINDOW = CALIBRATION_DEFAULTS['calib.window'];

const cmp_str = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ── курсы → приращения в bp ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Приращения курса пары `base → quote` в bp между соседними по дате записями `ws.rates` (вход `ctx.fx_obs_bp` для `run_paths`, вид `fx`).
 * Курс — дробь `num/den` («1 `base` = `num/den` `quote`», `fx.mjs`); записи обратной пары (`quote → base`) переворачиваются. Две записи с одной датой —
 * одно наблюдение (остаётся последняя по `(fx_id)`; исправление курса не считается движением). Приращение: `round_div(10000·(r₁ − r₀), r₀)` в BigInt,
 * `r = num/den`, без float. Хранятся последние `window` приращений (хронологически); меньше двух записей — наблюдений нет.
 * Ключ результата — валюта `base`: это валюта, чьё значение в `quote` движется (при `quote` = валюте решения — `orig_currency` события).
 * @param {{fx_id?: string, date: EpochDay|string, base: string, quote: string, num: number, den: number}[]} rates
 * @param {string} base
 * @param {string} quote
 * @param {number} [window] сколько последних приращений хранить (по умолчанию 24)
 * @returns {Object<string, number[]>} `{}` или `{[base]: bp[]}`
 * @throws {RunwayError} E_SCHEMA (код валюты не строка, `window` < 1, курс не из положительных целых)
 */
export function fx_obs_from_rates(rates, base, quote, window = DEFAULT_WINDOW) {
  if (typeof base !== 'string' || base === '' || typeof quote !== 'string' || quote === '') fail('E_SCHEMA', { reason: 'fx_obs_currency_not_string' });
  const w = assert_minor(window);
  if (w < 1) fail('E_SCHEMA', { reason: 'window_lt_1', value: w });
  const out = {};
  if (base === quote) return out;
  const by_day = new Map(); // дата → {num, den, id}
  for (const r of rates ?? []) {
    let num;
    let den;
    if (r.base === base && r.quote === quote) { num = r.num; den = r.den; } else if (r.base === quote && r.quote === base) { num = r.den; den = r.num; } else continue;
    if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num <= 0 || den <= 0) fail('E_SCHEMA', { reason: 'rate_not_positive_integers', fx_id: String(r.fx_id) });
    const d = to_epoch_day(r.date);
    const id = String(r.fx_id ?? '');
    const prev = by_day.get(d);
    if (prev === undefined || cmp_str(prev.id, id) <= 0) by_day.set(d, { num, den, id });
  }
  const days = [...by_day.keys()].sort((a, b) => a - b);
  const deltas = [];
  for (let i = 1; i < days.length; i++) {
    const a = by_day.get(days[i - 1]);
    const b = by_day.get(days[i]);
    // r₁/r₀ − 1 = (n₁·d₀ − n₀·d₁) / (n₀·d₁)
    const top = BigInt(b.num) * BigInt(a.den) - BigInt(a.num) * BigInt(b.den);
    const bottom = BigInt(a.num) * BigInt(b.den);
    deltas.push(round_div(10000n * top, bottom, 'half_even'));
  }
  if (deltas.length > 0) own_put(out, base, deltas.slice(-w));
  return out;
}

/**
 * Приращения курсов всех иностранных валют к валюте решения: объединение `fx_obs_from_rates` по каждой паре, где участвует `decision`.
 * @param {object[]} rates
 * @param {string} decision валюта решения
 * @param {number} [window]
 * @returns {Object<string, number[]>}
 */
export function fx_obs_all(rates, decision, window = DEFAULT_WINDOW) {
  const cur = new Set();
  for (const r of rates ?? []) {
    if (r.base === decision && typeof r.quote === 'string') cur.add(r.quote);
    if (r.quote === decision && typeof r.base === 'string') cur.add(r.base);
  }
  const out = {};
  for (const c of [...cur].sort(cmp_str)) {
    const part = fx_obs_from_rates(rates, c, decision, window);
    if (Object.hasOwn(part, c)) own_put(out, c, part[c]);
  }
  return out;
}

// ── плановые вхождения ────────────────────────────────────────────────────────────────────────────────────────────────

const OCC_OPTIONAL = ['amount_min_minor', 'amount_max_minor', 'counterparty_id', 'delay_days_worse', 'reserve_id'];
const PLAN_OPTIONAL = [...OCC_OPTIONAL, 'transfer_id'];

/** Счёт открыт на дату и не закрыт (как в `timeline`). */
function active_on(a, d) {
  if (a.opened_on !== undefined && a.opened_on !== null && to_epoch_day(a.opened_on) > d) return false;
  if (a.closed_on !== undefined && a.closed_on !== null && to_epoch_day(a.closed_on) <= d) return false;
  return true;
}

function calendar_spec(calendars, id) {
  if (id === undefined || id === null) return undefined;
  const hit = calendars.find((c) => c.calendar_id === id);
  if (hit === undefined) fail('E_SCHEMA', { reason: 'unknown_calendar', calendar_id: String(id) });
  return hit;
}

/** Начало окна плана каждого счёта (C-004): дата последнего якоря ≤ `as_of`, иначе `as_of`; для не-operating — `as_of`. */
function plan_start_by_account(w, as_of) {
  const out = new Map();
  for (const a of w.accounts) {
    if (a.liquidity !== 'operating' || !active_on(a, as_of)) continue;
    let last = null;
    for (const x of w.anchors) if (x.account_id === a.account_id && x.date <= as_of) last = x; // якоря отсортированы по (date, id)
    out.set(a.account_id, last === null ? as_of : last.date);
  }
  return out;
}

/**
 * Начало окна сверки — как у прогноза (`collect_planned`): наименьшая из дат последнего якоря активных operating-счетов (≤ `as_of`) и `as_of`.
 * План раньше этой даты уже учтён в остатке (C-004); факты раньше неё (минус окно сопоставления) в сверке не участвуют.
 * @param {object} ws
 * @param {EpochDay|string} as_of
 * @returns {EpochDay}
 */
export function plan_window_start(ws, as_of) {
  const w = normalize_ws(ws);
  const asof = to_epoch_day(as_of);
  let f0 = asof;
  for (const d of plan_start_by_account(w, asof).values()) f0 = Math.min(f0, d);
  return f0;
}

/**
 * Плановые вхождения окна `[from, to]` в форме событий `timeline` (`cash_event_id`, `layer = planned`, `date` — EpochDay, `occ_key`, `status`).
 * Берутся правила (`recurrence`), потоки часов (`hourly`), разовые записи `plans` и график долгов; сопоставления с фактом НЕТ, пропущенные вхождения
 * правил исключены самим `expand_all` (`overrides`), разовые записи со статусом `skipped`/`cancelled` остаются (статус виден вызывающему).
 * С `anchor_cut` вхождения раньше начала окна плана счёта (последний якорь, C-004) отбрасываются — именно так их видит прогноз.
 * @param {object} ws рабочая область (форма `analyze`)
 * @param {EpochDay|string} from
 * @param {EpochDay|string} to не раньше `from`
 * @param {{as_of?: EpochDay|string, anchor_cut?: boolean}} [opts] `as_of` — для границы «период закрыт» потоков часов (по умолчанию `to`); `anchor_cut` — окно плана счёта
 * @returns {object[]} по `(date, cash_event_id)`
 * @throws {RunwayError} E_BAD_DATE (`to < from`), E_SCHEMA (неизвестный календарь, нет счёта для события)
 */
export function plan_occurrences(ws, from, to, opts = {}) {
  const w = normalize_ws(ws);
  return occurrences_of(w, to_epoch_day(from), to_epoch_day(to), opts);
}

function occurrences_of(w, f0, t1, opts) {
  if (t1 < f0) fail('E_BAD_DATE', { reason: 'plan_occurrences_to_before_from', from: f0, to: t1 });
  const P = w.params;
  const as_of = opts.as_of === undefined || opts.as_of === null ? t1 : to_epoch_day(opts.as_of);
  const acc_by_id = new Map(w.accounts.map((a) => [a.account_id, a]));
  const default_acc = w.accounts.find((a) => a.liquidity === 'operating' && a.currency === w.decision_currency && active_on(a, as_of)) ?? null;
  const cur_of = (account_id) => acc_by_id.get(account_id)?.currency;
  const acc_of = (id) => {
    const account_id = id ?? default_acc?.account_id;
    if (account_id === undefined || account_id === null) fail('E_SCHEMA', { reason: 'no_account_for_event' });
    return account_id;
  };
  const window = { from: f0, to: t1 };
  const planned = [];
  if (w.rules.length > 0) {
    for (const o of expand_all(w.rules, window, w.calendars, w.overrides)) {
      const account_id = acc_of(o.account_id);
      const e = {
        cash_event_id: o.occ_key, layer: 'planned', account_id, date: o.date, amount_minor: o.amount_minor,
        currency: o.currency ?? cur_of(account_id), kind: o.kind, tag: o.tag, status: 'expected', rule_id: o.rule_id, stream_id: null,
        occ_key: o.occ_key, is_obligation: o.is_obligation, is_estimate: o.is_estimate, is_exceptional: false,
      };
      for (const k of OCC_OPTIONAL) if (o[k] !== undefined) e[k] = o[k];
      planned.push(e);
    }
  }
  for (const s of w.streams) {
    const cal = calendar_spec(w.calendars, s.calendar_id);
    planned.push(...expand_stream_ex(s, window, cal, { rounding: P.rounding, as_of }).events);
  }
  for (const p of w.plans) {
    const date = to_epoch_day(p.date);
    if (date < f0 || date > t1) continue;
    const id = p.plan_id ?? p.cash_event_id;
    if (typeof id !== 'string' || id === '') fail('E_SCHEMA', { reason: 'plan_id_required' });
    const amount = assert_minor(p.amount_minor);
    const account_id = acc_of(p.account_id);
    const e = {
      cash_event_id: id, layer: 'planned', account_id, date, amount_minor: amount, currency: p.currency ?? cur_of(account_id),
      kind: p.kind ?? (amount > 0 ? 'income' : 'expense'), tag: p.tag ?? '', status: p.status ?? 'expected', rule_id: null,
      stream_id: p.stream_id ?? null, occ_key: null, is_obligation: p.is_obligation === true, is_estimate: p.is_estimate === true,
      is_exceptional: p.is_exceptional === true,
    };
    for (const k of PLAN_OPTIONAL) if (p[k] !== undefined && p[k] !== null) e[k] = p[k];
    planned.push(e);
  }
  for (const d of w.debts) {
    for (const e of schedule_to_events(d)) if (e.date >= f0 && e.date <= t1) planned.push(e);
  }
  let out = planned;
  if (opts.anchor_cut === true) {
    const start = plan_start_by_account(w, as_of);
    out = planned.filter((e) => e.date >= (start.get(e.account_id) ?? as_of));
  }
  return out.sort((x, y) => (x.date - y.date) || cmp_str(String(x.cash_event_id), String(y.cash_event_id)));
}

// ── история «план ↔ факт» ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Сопоставление фактов с плановыми вхождениями за всю историю до `as_of` (окно планов — от первого факта минус `match.window_days` до `as_of` плюс `match.window_days`).
 * Возвращает результат `match_plan_to_fact` и пары для калибровки. Факты с датой позже `as_of` не участвуют.
 * @param {object} ws
 * @param {EpochDay|string} as_of
 * @returns {{matched: {plan: object, facts: object[], by: string}[], result: object, n_pairs: number}}
 */
export function match_history(ws, as_of) {
  const w = normalize_ws(ws);
  const asof = to_epoch_day(as_of);
  const facts = w.facts.filter((f) => f.date <= asof);
  if (facts.length === 0) return { matched: [], result: { matches: [], doubles: [], partials: [], unmatched_plans: [], unmatched_facts: [] }, n_pairs: 0 };
  const win = w.params['match.window_days'];
  const first = facts.reduce((m, f) => Math.min(m, f.date), Infinity);
  // план за пределами as_of, но в допуске окна сопоставления, тоже участвует: выплата, пришедшая раньше срока, даёт отрицательный лаг (как в прогнозе)
  const plans = occurrences_of(w, first - win, asof + win, { as_of: asof });
  const result = match_plan_to_fact(plans, facts, w.params);
  return { matched: result.matches, result, n_pairs: result.matches.length };
}

/**
 * Входы Монте-Карло из истории пользователя: лаги выплат и отношения сумм по потокам (`lag_obs`, `ratio_obs_bp` — формат `ctx.lag_obs`) и приращения
 * курсов (`fx_obs_bp`). Это ВХОДЫ: сам расчёт — `montecarlo.run_paths`; здесь только подготовка. Поток без сопоставленных пар в таблицах отсутствует
 * (для него `montecarlo` возьмёт prior и предупредит `W_NO_HISTORY`).
 * @param {object} ws
 * @param {EpochDay|string} as_of
 * @param {{window?: number}} [opts] `window` — сколько последних наблюдений хранить по потоку (24)
 * @returns {{lag_obs: Object<string, number[]>, ratio_obs_bp: Object<string, number[]>, fx_obs_bp: Object<string, number[]>,
 *   flows: {key: string, n: number}[], n_pairs: number}} `flows` — число наблюдений по потоку, по убыванию `n`, затем по ключу
 */
export function mc_observations(ws, as_of, opts = {}) {
  const w = normalize_ws(ws);
  const window = opts.window ?? DEFAULT_WINDOW;
  const h = match_history(ws, as_of);
  const obs = lag_observations(h.matched, window);
  const lag_obs = {};
  const ratio_obs_bp = {};
  const flows = [];
  for (const key of Object.keys(obs)) {
    own_put(lag_obs, key, [...obs[key].lags]);
    own_put(ratio_obs_bp, key, [...obs[key].ratios_bp]);
    flows.push({ key, n: obs[key].lags.length });
  }
  flows.sort((a, b) => (b.n - a.n) || cmp_str(a.key, b.key));
  const fx_obs_bp = w.decision_currency === null ? {} : fx_obs_all(w.rates, w.decision_currency, window);
  return { lag_obs, ratio_obs_bp, fx_obs_bp, flows, n_pairs: h.n_pairs };
}

/**
 * Привычки платежей: по потокам с не менее чем `min_n` сопоставленными наблюдениями (по умолчанию 10, REQ-053) — медиана, p80, p90 лага в днях,
 * признак «p90 — наибольшее из n» и сжатое к prior значение; остальные потоки считаются, но не показываются (`hidden`).
 * Функция чистая и ничего не решает за интерфейс; подписи — дело показа.
 * @param {Object<string, number[]>} lag_obs
 * @param {Object<string, number[]>} [ratio_obs_bp]
 * @param {{min_n?: number}} [opts]
 * @returns {{shown: {key: string, n: number, p50: number, p80: number, p90: number, p90_is_max: boolean, shrunk_days: number}[], hidden: {key: string, n: number}[]}}
 */
export function payment_habits(lag_obs, ratio_obs_bp = {}, opts = {}) {
  const min_n = opts.min_n ?? 10;
  const shown = [];
  const hidden = [];
  for (const key of Object.keys(lag_obs).sort(cmp_str)) {
    const lags = lag_obs[key];
    if (!Array.isArray(lags)) continue;
    if (lags.length < min_n) { hidden.push({ key, n: lags.length }); continue; }
    const c = flow_calibration(lags, Object.hasOwn(ratio_obs_bp, key) ? ratio_obs_bp[key] : []);
    shown.push({ key, n: c.n, p50: c.p50, p80: c.p80, p90: c.p90, p90_is_max: c.p90_label !== null && c.p90_label !== undefined, shrunk_days: c.shrunk_days });
  }
  shown.sort((a, b) => (b.n - a.n) || cmp_str(a.key, b.key));
  hidden.sort((a, b) => (b.n - a.n) || cmp_str(a.key, b.key));
  return { shown, hidden };
}
