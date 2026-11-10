// oracle.mjs — МЕДЛЕННАЯ независимая реализация проекции для сверки с быстрой (TST-53, ADR-014 п. 4).
// Принципы: наивный пересчёт по дням, без кэшей и без общего кода с engine/timeline.mjs; деньги — BigInt;
// на каждый день заново просматриваются ВСЕ события. Здесь нет импортов из engine/: модуль считает «по определениям» D-01…D-08,
// D-13, D-20 design-brief, написанным вручную. Используется только в тестах.

// ── вспомогательное: даты и деление ──────────────────────────────────────────────────────────────────────────────────

/** Округляющее деление BigInt `n / d` (d > 0n) в режиме `half_even`: независимая запись, не `money.round_div`. */
export function big_half_even(n, d) {
  if (d <= 0n) throw new Error('oracle: d <= 0');
  let q = n / d;
  let r = n - q * d;
  if (r < 0n) { q -= 1n; r += d; } // к −∞: 0 ≤ r < d
  const twice = r * 2n;
  if (twice < d) return q;
  if (twice > d) return q + 1n;
  return q % 2n === 0n ? q : q + 1n;
}

// ── ряды close / trough (D-01) ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Дневные ряды по определению D-01: за каждый день заново просматриваются все события.
 * @param {{date: number, amount_minor: number}[]} events
 * @param {number} opening
 * @param {number} as_of
 * @param {number} horizon_end
 * @returns {{close: number[], trough: number[]}}
 */
export function oracle_series(events, opening, as_of, horizon_end) {
  const close = [];
  const trough = [];
  let bal = BigInt(opening);
  for (let d = as_of; d <= horizon_end; d++) {
    let out = 0n;
    let inn = 0n;
    for (const e of events) {
      if (e.date !== d) continue;
      if (e.amount_minor < 0) out += BigInt(e.amount_minor);
      else inn += BigInt(e.amount_minor);
    }
    trough.push(Number(bal + out));
    bal = bal + out + inn;
    close.push(Number(bal));
  }
  return { close, trough };
}

/**
 * Резервы по D-08 «день за днём»: взнос/ручная правка в начале дня → релиз при платеже → резерв «до доходов» → аллокации от доходов дня → резерв «на конец дня».
 * @param {{reserve_id: string, funded_open_minor: number, backed_by_account_id?: string|null}[]} reserves
 * @param {{date: number, amount_minor: number, reserve_id?: string|null}[]} events
 * @param {{reserve_id: string, date: number, amount_minor: number, source: string}[]} allocations
 * @param {number} as_of
 * @param {number} horizon_end
 * @returns {{reserve_trough: number[], reserve_close: number[]}}
 */
export function oracle_reserves(reserves, events, allocations, as_of, horizon_end) {
  const funded = new Map();
  for (const r of reserves) {
    if (r.backed_by_account_id !== undefined && r.backed_by_account_id !== null) continue;
    funded.set(r.reserve_id, BigInt(r.funded_open_minor ?? 0));
  }
  const reserve_trough = [];
  const reserve_close = [];
  for (let d = as_of; d <= horizon_end; d++) {
    for (const id of funded.keys()) {
      let f = funded.get(id);
      for (const a of allocations) {
        if (a.reserve_id === id && a.date === d && a.source !== 'income') f += BigInt(a.amount_minor);
      }
      if (f < 0n) f = 0n;
      let pay = 0n;
      for (const e of events) if (e.reserve_id === id && e.date === d && e.amount_minor < 0) pay += BigInt(-e.amount_minor);
      const released = pay < f ? pay : f;
      funded.set(id, f - released);
    }
    let rt = 0n;
    for (const f of funded.values()) rt += f;
    reserve_trough.push(Number(rt));
    for (const id of funded.keys()) {
      let f = funded.get(id);
      for (const a of allocations) if (a.reserve_id === id && a.date === d && a.source === 'income') f += BigInt(a.amount_minor);
      funded.set(id, f);
    }
    let rc = 0n;
    for (const f of funded.values()) rc += f;
    reserve_close.push(Number(rc));
  }
  return { reserve_trough, reserve_close };
}

/** `free[i] = trough[i] − reserve_trough[i]` (D-08). */
export function oracle_free(trough, reserve_trough) {
  return trough.map((t, i) => t - reserve_trough[i]);
}

// ── Q1 и запас хода (D-13) ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Q1 по определению: перебор дней пути `[as_of, D]`.
 * @param {{close: number[], trough: number[]}} s
 * @param {number} as_of
 * @param {number} D
 * @param {number} B
 */
export function oracle_q1(s, as_of, D, B) {
  const N = s.trough.length;
  if (D > as_of + N - 1) return { beyond_horizon: true };
  let min = null;
  let at = null;
  let first_breach = null;
  let first_buffer_breach = null;
  for (let d = as_of; d <= D; d++) {
    const v = s.trough[d - as_of];
    if (min === null || v < min) { min = v; at = d; } // строго «<»: побеждает первая дата
    if (first_breach === null && v < 0) first_breach = d;
    if (first_buffer_breach === null && v < B) first_buffer_breach = d;
  }
  return { min, at, ok_cash: min >= 0, ok_buffer: min >= B, first_breach, first_buffer_breach, need: Math.max(0, B - min), close_on_D: s.close[D - as_of] };
}

/** Запас хода: первая дата `trough < 0` на всём горизонте с доходами и без них. */
export function oracle_runway(events, opening, as_of, horizon_end) {
  const first_neg = (evs) => {
    const s = oracle_series(evs, opening, as_of, horizon_end);
    for (let i = 0; i < s.trough.length; i++) if (s.trough[i] < 0) return { date: as_of + i, days: i };
    return null;
  };
  return { with: first_neg(events), without: first_neg(events.filter((e) => e.amount_minor < 0)) };
}

// ── эффективные даты и конвейер «простых» рабочих областей (D-04, D-20, D-22) ────────────────────────────────────────

/** Эффективная дата по D-04 для плановой записи (без статусов). */
export function oracle_eff_date(plan_date, kind, delay, as_of, mode) {
  const base = plan_date > as_of ? plan_date : as_of;
  return mode === 'worse' && kind === 'income' ? base + delay : base;
}

/** Курс «from → to» на дату: самая новая запись пары (прямой или обратной) с датой ≤ d; при равенстве дат прямой приоритетнее. */
function oracle_rate(rates, from, to, d) {
  if (from === to) return { num: 1n, den: 1n };
  let direct = null;
  let inverse = null;
  for (const r of rates) {
    if (r.date > d) continue;
    if (r.base === from && r.quote === to && (direct === null || r.date >= direct.date)) direct = r;
    if (r.base === to && r.quote === from && (inverse === null || r.date >= inverse.date)) inverse = r;
  }
  if (direct === null && inverse === null) throw new Error('oracle: нет курса ' + from + '/' + to);
  if (inverse === null || (direct !== null && direct.date >= inverse.date)) return { num: BigInt(direct.num), den: BigInt(direct.den) };
  return { num: BigInt(inverse.den), den: BigInt(inverse.num) };
}

/** Перевод суммы: `round_half_even(a · num · 10^qe / (den · 10^be))`. */
function oracle_convert(a, from_ccy, to_ccy, exp_of, rates, d) {
  if (from_ccy === to_ccy) return a;
  const r = oracle_rate(rates, from_ccy, to_ccy, d);
  const n = BigInt(a) * r.num * 10n ** BigInt(exp_of[to_ccy]);
  const den = r.den * 10n ** BigInt(exp_of[from_ccy]);
  return Number(big_half_even(n, den));
}

/**
 * Конвейер для простой рабочей области (счета, якоря, факты, разовые плановые записи, курсы) «в лоб»: опорный остаток, окно плана от якоря,
 * эффективные даты режима, перевод в валюту решения, ряды. Сопоставление план↔факт не моделируется — генератор исключает совпадения.
 * @param {object} sim
 * @param {number} as_of
 * @param {number} horizon_end
 * @param {'plan'|'worse'} mode
 * @returns {{opening: number, events: {id: string, date: number, amount_minor: number}[], close: number[], trough: number[]}}
 */
export function oracle_pipeline(sim, as_of, horizon_end, mode) {
  const exp_of = {};
  for (const a of sim.accounts) exp_of[a.currency] = a.exponent;
  exp_of[sim.decision_currency] = sim.decision_exponent;
  // опорный остаток
  let opening = 0;
  const plan_from = new Map();
  for (const a of sim.accounts) {
    let anchor = null;
    for (const x of sim.anchors) {
      if (x.account !== a.id || x.date > as_of) continue;
      if (anchor === null || x.date >= anchor.date) anchor = x;
    }
    let bal = anchor === null ? 0n : BigInt(anchor.amount);
    for (const f of sim.facts) {
      if (f.account !== a.id || f.date > as_of) continue;
      if (anchor === null || f.date > anchor.date) bal += BigInt(f.amount);
    }
    opening += oracle_convert(Number(bal), a.currency, sim.decision_currency, exp_of, sim.rates, as_of);
    plan_from.set(a.id, anchor === null ? as_of : anchor.date);
  }
  // события
  const events = [];
  for (const p of sim.plans) {
    const acc = sim.accounts.find((a) => a.id === p.account);
    if (p.date < plan_from.get(p.account) || p.date > horizon_end) continue;
    if (p.status === 'skipped' || p.status === 'cancelled') continue;
    const d = oracle_eff_date(p.date, p.amount > 0 ? 'income' : 'expense', p.delay ?? sim.worse_delay, as_of, mode);
    if (d > horizon_end) continue;
    events.push({ id: p.id, date: d, amount_minor: oracle_convert(p.amount, acc.currency, sim.decision_currency, exp_of, sim.rates, as_of) });
  }
  return { opening, events, ...oracle_series(events, opening, as_of, horizon_end) };
}
