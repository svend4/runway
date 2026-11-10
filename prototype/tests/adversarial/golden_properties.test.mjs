// golden_properties.test.mjs — СОСТЯЗАТЕЛЬНЫЙ ТЕСТ, линза B: «числа канона и оракул» (design-brief §9.4–§9.9, §9.15, D-01…D-13, §12 X2, §14).
//
// Что делает файл:
//   1. Независимый НАИВНЫЙ оракул (в этом файле, без импорта timeline/afford/waves/sinking): день за днём считает `trough`/`close`,
//      резервы по D-08, Q1 (D-13), волны (D-09/D-10), «можно ли купить» (D-11) и STS (D-12) по определениям канона, на BigInt там, где есть деление.
//      События G-001 вписаны ВРУЧНУЮ из таблицы §9.1 — не берутся ни из data/*.json, ни из движка.
//   2. Сверяет оракул с каноном (числа §9.4–§9.9 дословно) — ловит расхождения канона с самим собой — и с выводом движка (`analyze` на data/g001.json
//      и на вариантах low/gap/late, которые строятся здесь из g001.json правкой якоря/плана).
//   3. Property-based/фаззинг на случайных рабочих областях (детерминированный ГПСЧ mulberry32): сохранение close, worse ≤ plan, free ≤ trough,
//      S_max(as_of) = STS(horizon_end), монотонность earliest_date по S и check_purchase по S, перестановка записей, нулевое событие,
//      инвариантность резервов для close/trough, префикс-инвариантность горизонта, сдвиг opening, оракул волн/Q1/Q3 на случайных данных.
// Ожидаемые значения выводятся из канона и независимого расчёта; под код ничего не подгоняется. Упавший тест = улика (см. отчёт).
// В тестах допустимы node:fs и Date (purity.test.mjs проверяет только engine/).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { analyze } from '../../engine/index.mjs';
import { list_waves, next_income_day } from '../../engine/waves.mjs';
import { check_purchase, max_amount, earliest_date, safe_to_spend, default_sts_horizon, sts_breakdown, gate } from '../../engine/afford.mjs';
import { answer_q1, runway_days, explain_narrowest } from '../../engine/timeline.mjs';
import { nearest_rank, wilson, shrink_to_prior } from '../../engine/calibration.mjs';
import { make_rng } from '../helpers.mjs';
import { fuzz_progress } from '../fuzz_progress.mjs'; // FP-24: ход длинного цикла для tools/fuzz_nightly.mjs (без переменной RUNWAY_FUZZ_PROGRESS ничего не делает)

const DATA = new URL('../../data/', import.meta.url);
const load = (name) => JSON.parse(fs.readFileSync(new URL(name, DATA), 'utf8'));

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 1. НАИВНЫЙ ОРАКУЛ (никаких импортов из engine/ для расчёта)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** Алгоритм Говарда Хиннанта: гражданская дата → число дней от 1970-01-01 (написан заново, не `dates.mjs`). */
function dfc(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}
/** `YYYY-MM-DD` → EpochDay. */
const D = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return dfc(y, m, d);
};
/** EpochDay → `YYYY-MM-DD` (для сообщений). */
function fmt(z) {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return `${String(y + (m <= 2 ? 1 : 0)).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
/** День недели: 0 = воскресенье (1970-01-01 — четверг). */
const dow = (z) => (((z + 4) % 7) + 7) % 7;

/** Деление с округлением `half_even` на BigInt (d > 0), независимая запись. */
function he(n, d) {
  n = BigInt(n);
  d = BigInt(d);
  let q = n / d;
  let r = n - q * d;
  if (r < 0n) { q -= 1n; r += d; }
  const t = 2n * r;
  if (t < d) return Number(q);
  if (t > d) return Number(q + 1n);
  return Number(q % 2n === 0n ? q : q + 1n);
}
/** Пол-деление на BigInt. */
function fl(n, d) {
  n = BigInt(n);
  d = BigInt(d);
  let q = n / d;
  if (n - q * d < 0n) q -= 1n;
  return Number(q);
}
const cdiv = (a, b) => -fl(-a, b);

/**
 * Модель режима «день за днём» по D-01, D-04, D-08 (без кэшей и без общих функций с движком).
 * @param {object} cfg `{as_of, hz, opening, events[], delay, tax[], res0{}, contribs[]}`; событие: `{id, date, amt, kind, tag, oblig, est, reserve}`.
 * @param {'plan'|'worse'} mode
 */
function naive_model(cfg, mode) {
  const { as_of, hz } = cfg;
  const N = hz - as_of + 1;
  const delay = mode === 'worse' ? cfg.delay : 0;
  const evs = [];
  for (const e of cfg.events) {
    const base = Math.max(e.date, as_of); // D-04: base(e) = max(plan_date, as_of)
    const eff = base + (e.kind === 'income' && e.amt > 0 ? delay : 0);
    if (eff > hz) continue;
    evs.push({ ...e, eff });
  }
  const funded = { ...cfg.res0 };
  const ids = Object.keys(funded).sort();
  const trough = [];
  const close = [];
  const rtrough = [];
  const rclose = [];
  const reserve_open = ids.reduce((s, id) => s + funded[id], 0);
  let bal = cfg.opening;
  for (let i = 0; i < N; i++) {
    const d = as_of + i;
    let out = 0;
    let inn = 0;
    for (const e of evs) {
      if (e.eff !== d) continue;
      if (e.amt < 0) out += e.amt; else inn += e.amt;
    }
    trough.push(bal + out);
    bal = bal + out + inn;
    close.push(bal);
    // резервы: взносы расписания → релиз → резерв «до доходов» → аллокации от доходов дня → резерв «на конец дня»
    for (const c of cfg.contribs) if (c.date === d) funded[c.res] += c.amt;
    for (const id of ids) {
      let pay = 0;
      for (const e of evs) if (e.eff === d && e.reserve === id && e.amt < 0) pay += -e.amt;
      funded[id] -= Math.min(funded[id], pay);
    }
    rtrough.push(ids.reduce((s, id) => s + funded[id], 0));
    for (const e of evs) {
      if (e.eff !== d || !(e.amt > 0) || e.kind !== 'income') continue;
      for (const t of cfg.tax) if ((t.tags ?? []).includes(e.tag) || (t.streams ?? []).includes(e.stream)) funded[t.res] += he(BigInt(e.amt) * BigInt(t.rate_bp), 10000n);
    }
    rclose.push(ids.reduce((s, id) => s + funded[id], 0));
  }
  const free = trough.map((t, i) => t - rtrough[i]);
  return { evs, trough, close, rtrough, rclose, free, opening: cfg.opening, reserve_open, as_of, hz, N };
}

/** Первый минимум на отрезке [lo, hi] (ранняя дата при равенстве, D-02). */
function argmin(xs, lo, hi) {
  let k = lo;
  for (let i = lo + 1; i <= hi; i++) if (xs[i] < xs[k]) k = i;
  return k;
}

/** Q1 по D-13 на пути [as_of, D]. */
function naive_q1(m, Dd, B) {
  const hi = Dd - m.as_of;
  const k = argmin(m.trough, 0, hi);
  const min = m.trough[k];
  let first_breach = null;
  let first_buffer_breach = null;
  for (let i = 0; i <= hi; i++) {
    if (first_breach === null && m.trough[i] < 0) first_breach = m.as_of + i;
    if (first_buffer_breach === null && m.trough[i] < B) first_buffer_breach = m.as_of + i;
  }
  return { min, at: m.as_of + k, ok_cash: min >= 0, ok_buffer: min >= B, first_breach, first_buffer_breach, need: Math.max(0, B - min), close_on_D: m.close[hi] };
}

/** Волны по D-09: жадная кластеризация значимых обязательств (по (eff, amt, id)). */
function naive_waves(m, g, S, theta) {
  const O = m.evs.filter((e) => e.oblig && !e.est && e.amt < 0 && -e.amt >= theta)
    .sort((a, b) => (a.eff - b.eff) || (a.amt - b.amt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const waves = [];
  let w = null;
  for (const e of O) {
    if (w !== null && e.eff - w.end <= g && e.eff - w.start < S) {
      w.ids.push(e.id);
      w.end = e.eff;
      w.total += -e.amt;
    } else {
      w = { start: e.eff, end: e.eff, ids: [e.id], total: -e.amt };
      waves.push(w);
    }
  }
  return waves;
}

/** Метрики волны по D-10 (физические деньги). */
function naive_wave_metrics(m, w, B) {
  let next = null;
  for (const e of m.evs) if (e.kind === 'income' && e.amt > 0 && e.eff > w.end && (next === null || e.eff < next)) next = e.eff;
  const e_ext = next === null ? m.hz : Math.min(m.hz, Math.max(w.end, next - 1));
  const i0 = w.start - m.as_of;
  const i1 = e_ext - m.as_of;
  const cash = i0 === 0 ? m.opening : m.close[i0 - 1];
  const k = argmin(m.trough, i0, i1);
  const R = cash - m.trough[k];
  const need = R + B;
  return {
    window_end: e_ext, cash, min_date: m.as_of + k, min: m.trough[k], R, need, gap: Math.max(0, B - m.trough[k]),
    cov: fl(1000n * BigInt(cash), need), reserved: i0 === 0 ? m.reserve_open : m.rclose[i0 - 1],
  };
}

/** «Хватает ли свободных денег после покупки в индекс i0 на сумму S» — определение D-11 в лоб (O(N)). */
function ok_after(free, i0, S, B) {
  let m = Infinity;
  for (let i = 0; i < free.length; i++) m = Math.min(m, free[i] - (i >= i0 ? S : 0));
  return m >= B;
}
/** Наибольшая S ≥ 1, при которой покупка в день i0 «держится в буфере» (0, если такой нет), бисекцией по монотонному предикату. */
function brute_smax(free, i0, B) {
  if (!ok_after(free, i0, 1, B)) return 0;
  let lo = 1;
  let hi = 1;
  while (ok_after(free, i0, hi, B)) { lo = hi; hi *= 2; }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (ok_after(free, i0, mid, B)) lo = mid; else hi = mid;
  }
  return lo;
}
/** Самая ранняя дата (индекс) ≥ nb, с которой сумма S держится в буфере; `null` — нет. */
function brute_earliest(free, S, nb, B) {
  for (let i0 = nb; i0 < free.length; i0++) if (ok_after(free, i0, S, B)) return i0;
  return null;
}
/** Минимум `free` после покупки `parts` и дата (D-11). */
function naive_after(m, parts) {
  const after = m.free.map((f, i) => f - parts.filter((p) => p.date <= m.as_of + i).reduce((s, p) => s + p.amt, 0));
  const k = argmin(after, 0, after.length - 1);
  const cash = Math.min(...m.trough.map((t, i) => t - parts.filter((p) => p.date <= m.as_of + i).reduce((s, p) => s + p.amt, 0)));
  return { m_after: after[k], at: m.as_of + k, cash_gap: cash < 0, after };
}
const RANK = { OK: 0, FRAGILE: 1, TIGHT: 2, NO: 3 };
function naive_verdict(mp, mw, B) {
  if (mp < 0) return 'NO';
  if (mp < B) return 'TIGHT';
  if (mw < B) return 'FRAGILE';
  return 'OK';
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 2. G-001 ВРУЧНУЮ ПО §9.1
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════

const AS_OF = D('2026-10-04');
const HZ = D('2026-11-30');
const B0 = 50000;

/** События §9.1 (даты вписаны по таблице канона; для списков — «Даты в горизонте»). */
function g001_events() {
  const evs = [];
  const add = (id, date, amt, extra = {}) => evs.push({ id, date: D(date), amt, kind: amt < 0 ? 'expense' : 'income', tag: '', oblig: false, est: false, reserve: null, ...extra });
  for (const d of ['2026-10-26', '2026-11-25']) {
    add(`R-RENT@${d}`, d, -90000, { oblig: true, tag: 'аренда' });
    add(`R-UTIL@${d}`, d, -12000, { oblig: true, tag: 'жкх' });
  }
  add('R-PHONE@2026-10-09', '2026-10-09', -2500, { oblig: true, tag: 'связь' });
  add('R-PHONE@2026-11-09', '2026-11-09', -2500, { oblig: true, tag: 'связь' });
  for (const d of ['2026-10-10', '2026-10-17', '2026-10-24', '2026-10-31', '2026-11-07', '2026-11-14', '2026-11-21', '2026-11-28']) {
    add(`R-GROC@${d}`, d, -10000, { est: true, tag: 'продукты' });
  }
  add('P-TAX1', '2026-10-23', -50000, { oblig: true, tag: 'налог', reserve: 'RES-TAX' });
  add('S-HOURLY@2026-11-05', '2026-11-05', 279000, { stream: 'S-HOURLY', tag: 'S-HOURLY' });
  return evs;
}
/** Конфиг модели G-001 (резервы: RES-TAX 150000 + 20 % от дохода потока; RES-INS: взнос 12000 на 2026-11-01 в горизонте). */
function g001_cfg(over = {}) {
  return {
    as_of: AS_OF, hz: HZ, opening: 400000, delay: 14, events: g001_events(),
    tax: [{ res: 'RES-TAX', rate_bp: 2000, streams: ['S-HOURLY'] }],
    res0: { 'RES-TAX': 150000, 'RES-INS': 0 },
    contribs: [{ res: 'RES-INS', date: D('2026-11-01'), amt: 12000 }],
    ...over,
  };
}
const VARIANTS = {
  base: { opening: 400000 },
  low: { opening: 220000 },
  gap: { opening: 100000 },
  late: { opening: 400000, extra: [{ id: 'P-X', date: D('2026-11-26'), amt: -250000, kind: 'expense', tag: 'прочее', oblig: false, est: false, reserve: null }] },
};
function variant_cfg(name) {
  const v = VARIANTS[name];
  const c = g001_cfg({ opening: v.opening });
  if (v.extra) c.events = [...c.events, ...v.extra];
  return c;
}
/** Рабочая область варианта: g001.json с правкой якоря/плана (НЕ data/g001-low.json и т. п.). */
function variant_ws(name) {
  const ws = structuredClone(load('g001.json'));
  const v = VARIANTS[name];
  ws.anchors[ws.anchors.length - 1].amount_minor = v.opening;
  if (name === 'late') {
    ws.plans.push({ plan_id: 'P-X', account_id: 'acc_main', name: 'P-X', date: '2026-11-26', amount_minor: -250000, currency: 'EUR', kind: 'expense', tag: 'прочее', is_obligation: false, is_estimate: false });
  }
  return ws;
}
const run = (ws, extra = {}) => analyze(ws, { as_of: '2026-10-04', horizon_days: 57, ...extra });

// ── 2.1. канон против самого себя: арифметика, которую можно проверить по числам §9.1–§9.3 без всякого кода ──────────────────────

test('B-01 канон/арифметика §9.1–§9.3: итоги расходов, end_close, подсказка буфера, аллокации, переработка, недоработка, медиана — сходятся вручную', () => {
  assert.equal(204000 + 5000 + 80000 + 50000, 339000);
  assert.equal(400000 - 339000 + 279000, 340000); // end_close
  assert.equal(he(7n * 630000n, 90n), 49000); // buffer_hint
  assert.equal(he(279000n * 2000n, 10000n), 55800); // аллокация с октябрьской выплаты
  assert.equal(he(288000n * 2000n, 10000n), 57600);
  assert.equal(150000 - 50000 + 55800, 155800); // RES-TAX на конец горизонта
  assert.equal(155800 + 12000, 167800); // reserve_close.end
  // доход по часам: gross(5580) = 3000·5580/60; min/max
  assert.equal(he(3000n * 5580n, 60n), 279000);
  assert.equal(he(3000n * 4800n, 60n), 240000);
  assert.equal(he(3000n * 6600n, 60n), 330000);
  assert.equal(he(3000n * 5760n, 60n), 288000);
  // переработка: одно округление
  assert.equal(he(3000n * (2400n * 10000n + 360n * 15000n), 600000n), 147000);
  // ничья округления: 120062,5 → half_even 120062
  assert.equal(he(3000n * (2400n * 10000n + 12500n), 600000n), 120062);
  assert.equal(3000 * (2400 * 10000 + 12500) / 600000, 120062.5);
  // недоработка: темп 5580/31 = 180; 20 дней → 3600; факт 3120; short = 480 → 24000; est = 3120 + 1980 = 5100 → 255000
  assert.equal(5580 / 31, 180);
  assert.equal(20 * 180 - 3120, 480);
  assert.equal(he(480n * 3000n, 60n), 24000);
  assert.equal(he(3000n * BigInt(3120 + (5580 - 3600)), 60n), 255000);
  assert.equal(279000 - 24000, 255000);
  // unlogged_rate = median(1200, 1500) = round_div(2700, 2) = 1350; 1350·9 = 12150
  assert.equal(8400 / 7, 1200);
  assert.equal(15000 / 10, 1500);
  assert.equal(he(2700n, 2n), 1350);
  assert.equal(1350 * 9, 12150);
});

test('B-02 канон/даты §9.1: epoch-дни, дни недели и сдвиги выплат пересчитаны независимо', () => {
  assert.equal(AS_OF, 20730);
  assert.equal(HZ, 20787);
  assert.equal(HZ - AS_OF + 1, 58, 'N = 58 при горизонте 57 дн. (X2)');
  assert.equal(D('2027-03-15'), 20892);
  assert.equal(D('2028-02-29'), 21243);
  assert.equal(D('1970-01-01'), 0);
  assert.equal(dow(AS_OF), 0, '2026-10-04 — воскресенье');
  assert.equal(dow(0), 4, '1970-01-01 — четверг');
  assert.equal(dow(D('2026-10-25')), 0, '25 октября — воскресенье, аренда уходит на 26-е (next)');
  assert.equal(dow(D('2026-10-26')), 1);
  assert.equal(dow(D('2026-11-25')), 3, '25 ноября — среда, без сдвига');
  assert.equal(dow(D('2026-10-09')), 5, 'пятница');
  assert.equal(dow(D('2026-11-09')), 1, 'понедельник');
  assert.equal(dow(D('2026-10-12')), 1, 'дорожка: понедельник');
  assert.equal(dow(D('2026-11-05')), 4, 'выплата за октябрь — четверг');
  assert.equal(dow(D('2026-12-05')), 6, '5 декабря — суббота → выплата 12-07');
  assert.equal(D('2026-10-31') + 5, D('2026-11-05'), '31 окт + 5 дн');
  assert.equal(D('2026-11-05') + 14, D('2026-11-19'));
  // субботы продуктов: каждая суббота 10-10…11-28 — ровно 8, и ни одной лишней
  const sats = [];
  for (let d = AS_OF; d <= HZ; d++) if (dow(d) === 6) sats.push(fmt(d));
  assert.deepEqual(sats, ['2026-10-10', '2026-10-17', '2026-10-24', '2026-10-31', '2026-11-07', '2026-11-14', '2026-11-21', '2026-11-28']);
  // 10-09 и 11-09 — будни: связь без сдвига; обратное преобразование fmt/D
  for (const s of ['2026-10-04', '2026-11-30', '2028-02-29', '1970-01-01']) assert.equal(fmt(D(s)), s);
});

// ── 2.2. §9.4: ряды. Оракул против таблицы канона и против движка ─────────────────────────────────────────────────────────────

/** Таблица §9.4 (дословно): [дата, T план, C план, Rт план, F план, T хуже, C хуже, Rт хуже, F хуже]. */
const CANON_TABLE = [
  ['2026-10-04', 400000, 400000, 150000, 250000, 400000, 400000, 150000, 250000],
  ['2026-10-09', 397500, 397500, 150000, 247500, 397500, 397500, 150000, 247500],
  ['2026-10-10', 387500, 387500, 150000, 237500, 387500, 387500, 150000, 237500],
  ['2026-10-17', 377500, 377500, 150000, 227500, 377500, 377500, 150000, 227500],
  ['2026-10-23', 327500, 327500, 100000, 227500, 327500, 327500, 100000, 227500],
  ['2026-10-24', 317500, 317500, 100000, 217500, 317500, 317500, 100000, 217500],
  ['2026-10-26', 215500, 215500, 100000, 115500, 215500, 215500, 100000, 115500],
  ['2026-10-31', 205500, 205500, 100000, 105500, 205500, 205500, 100000, 105500],
  ['2026-11-01', 205500, 205500, 112000, 93500, 205500, 205500, 112000, 93500],
  ['2026-11-05', 205500, 484500, 112000, 93500, 205500, 205500, 112000, 93500],
  ['2026-11-07', 474500, 474500, 167800, 306700, 195500, 195500, 112000, 83500],
  ['2026-11-09', 472000, 472000, 167800, 304200, 193000, 193000, 112000, 81000],
  ['2026-11-14', 462000, 462000, 167800, 294200, 183000, 183000, 112000, 71000],
  ['2026-11-19', 462000, 462000, 167800, 294200, 183000, 462000, 112000, 71000],
  ['2026-11-21', 452000, 452000, 167800, 284200, 452000, 452000, 167800, 284200],
  ['2026-11-25', 350000, 350000, 167800, 182200, 350000, 350000, 167800, 182200],
  ['2026-11-28', 340000, 340000, 167800, 172200, 340000, 340000, 167800, 172200],
  ['2026-11-30', 340000, 340000, 167800, 172200, 340000, 340000, 167800, 172200],
];

test('B-03 §9.4 оракул против таблицы канона: все 18 строк (T, C, Rт, F; plan и worse) воспроизводятся независимым дневным расчётом', () => {
  const P = naive_model(g001_cfg(), 'plan');
  const W = naive_model(g001_cfg(), 'worse');
  assert.equal(P.N, 58);
  for (const row of CANON_TABLE) {
    const i = D(row[0]) - AS_OF;
    const got = [P.trough[i], P.close[i], P.rtrough[i], P.free[i], W.trough[i], W.close[i], W.rtrough[i], W.free[i]];
    assert.deepEqual(got, row.slice(1), `строка ${row[0]}`);
  }
});

test('B-04 §9.4 КАНОН: оговорка «дни без событий пропущены (значения предыдущей строки сохраняются)» неточна для trough и F после дохода — следующий день отличается (11-06 plan, 11-20 worse)', () => {
  // Это не баг кода, а неточность текста канона (canon_suspect): на 11-06 (plan) trough = close дня дохода = 484500, а не 205500 (значение строки 11-05).
  const P = naive_model(g001_cfg(), 'plan');
  const W = naive_model(g001_cfg(), 'worse');
  const i6 = D('2026-11-06') - AS_OF;
  assert.equal(P.trough[i6], 484500);
  assert.equal(P.rtrough[i6], 167800);
  assert.equal(P.free[i6], 316700);
  const i20 = D('2026-11-20') - AS_OF;
  assert.equal(W.trough[i20], 462000);
  assert.equal(W.free[i20], 294200);
  // и на строках, которые канон УПОМИНАЕТ, значения «сохраняются» только для close
  assert.equal(P.close[i6], P.close[D('2026-11-05') - AS_OF], 'close на 11-06 = close на 11-05 (событий нет)');
});

for (const name of Object.keys(VARIANTS)) {
  test(`B-05 §9.4/§9.9 движок против оракула, вариант «${name}»: close, trough, reserve_trough, reserve_close, free — все 58 дней, оба режима`, () => {
    const ctx = run(variant_ws(name));
    for (const mode of ['plan', 'worse']) {
      const m = naive_model(variant_cfg(name), mode);
      const s = ctx.series[mode];
      assert.equal(s.opening_minor, m.opening);
      assert.equal(s.reserve_opening_minor, m.reserve_open);
      assert.deepEqual(s.close, m.close, `close ${mode}`);
      assert.deepEqual(s.trough, m.trough, `trough ${mode}`);
      assert.deepEqual(s.reserve_trough, m.rtrough, `reserve_trough ${mode}`);
      assert.deepEqual(s.reserve_close, m.rclose, `reserve_close ${mode}`);
      assert.deepEqual(s.free, m.free, `free ${mode}`);
    }
  });
}

test('B-06 §9.4 data/g001*.json — те же ряды, что у вариантов, построенных из g001.json (датасеты low/gap/late не расходятся с каноном)', () => {
  for (const [name, file] of [['low', 'g001-low.json'], ['gap', 'g001-gap.json'], ['late', 'g001-late.json']]) {
    const a = run(load(file));
    const b = run(variant_ws(name));
    for (const mode of ['plan', 'worse']) {
      assert.deepEqual(a.series[mode], b.series[mode], `${file} ${mode}`);
    }
  }
});

test('B-07 §9.4 ключи G-001.*: opening, end_close, min trough/free, reserve_close.end; плюс состав reserve_close на конец (155800 + 12000)', () => {
  const ctx = run(load('g001.json'));
  const s = ctx.series;
  assert.equal(s.plan.opening_minor, 400000);
  assert.equal(s.plan.close.at(-1), 340000);
  assert.equal(s.worse.close.at(-1), 340000);
  assert.equal(s.plan.reserve_close.at(-1), 167800);
  assert.equal(ctx.reserve.plan.by_reserve['RES-TAX'].close.at(-1), 155800);
  assert.equal(ctx.reserve.plan.by_reserve['RES-INS'].close.at(-1), 12000);
  const kp = argmin(s.plan.free, 0, 57);
  const kw = argmin(s.worse.free, 0, 57);
  assert.deepEqual([s.plan.free[kp], fmt(AS_OF + kp)], [93500, '2026-11-01']);
  assert.deepEqual([s.worse.free[kw], fmt(AS_OF + kw)], [71000, '2026-11-14']);
  const tp = argmin(s.plan.trough, 0, 57);
  const tw = argmin(s.worse.trough, 0, 57);
  assert.deepEqual([s.plan.trough[tp], fmt(AS_OF + tp)], [205500, '2026-10-31']);
  assert.deepEqual([s.worse.trough[tw], fmt(AS_OF + tw)], [183000, '2026-11-14']);
});

test('B-08 X2: при horizon_days = 180 числа G-001 ДРУГИЕ: в ряд попадают 2026-12-07 (доход), 12-25 (аренда/ЖКХ), 12-09 (связь); end_close ≠ 340000, N = 181', () => {
  const ctx = analyze(load('g001.json'), { as_of: '2026-10-04', horizon_days: 180 });
  assert.equal(ctx.series.plan.close.length, 181);
  const plan = ctx.events.plan.map((e) => [fmt(e.date), e.amount_minor]);
  const has = (d, a) => plan.some((p) => p[0] === d && p[1] === a);
  assert.ok(has('2026-12-07', 279000), 'выплата за ноябрь на 12-07 (12-05 — суббота, сдвиг next)');
  assert.ok(has('2026-12-25', -90000), 'аренда 12-25 (пятница)');
  assert.ok(has('2026-12-25', -12000));
  assert.ok(has('2026-12-09', -2500), 'связь 12-09 (среда)');
  assert.notEqual(ctx.series.plan.close[57], undefined);
  assert.notEqual(ctx.series.plan.close.at(-1), 340000, 'при горизонте 180 end_close не равен 340000');
  // первые 58 дней ряда плана совпадают с рядом при горизонте 57 (префикс-инвариантность)
  const ctx57 = run(load('g001.json'));
  assert.deepEqual(ctx.series.plan.close.slice(0, 58), ctx57.series.plan.close);
  assert.deepEqual(ctx.series.plan.trough.slice(0, 58), ctx57.series.plan.trough);
  assert.deepEqual(ctx.series.plan.free.slice(0, 58), ctx57.series.plan.free, 'взносы sinking считаются до срока, а не до горизонта');
  assert.deepEqual(ctx.series.worse.free.slice(0, 58), ctx57.series.worse.free);
});

// ── 2.3. Q1 (§9.4 «Q1 на примерах», §9.9 low/gap) ────────────────────────────────────────────────────────────────────────

test('B-09 Q1 §9.4: примеры к 10-26 / 11-05 / 11-30, запас над буфером, runway — оракул, канон, движок', () => {
  const ctx = run(load('g001.json'));
  for (const mode of ['plan', 'worse']) {
    const m = naive_model(g001_cfg(), mode);
    for (const [ds, min, at] of [['2026-10-26', 215500, '2026-10-26'], ['2026-11-05', 205500, '2026-10-31']]) {
      const o = naive_q1(m, D(ds), B0);
      assert.deepEqual([o.min, fmt(o.at)], [min, at], `оракул ${mode} к ${ds}`);
      const e = answer_q1(ctx.series[mode], D(ds), B0);
      assert.deepEqual(e, o, `движок ${mode} к ${ds}`);
    }
  }
  const o30p = naive_q1(naive_model(g001_cfg(), 'plan'), HZ, B0);
  const o30w = naive_q1(naive_model(g001_cfg(), 'worse'), HZ, B0);
  assert.deepEqual([o30p.min, fmt(o30p.at)], [205500, '2026-10-31']);
  assert.deepEqual([o30w.min, fmt(o30w.at)], [183000, '2026-11-14']);
  assert.equal(o30p.min - B0, 155500);
  assert.equal(o30w.min - B0, 133000);
  assert.deepEqual(ctx.q1.plan, o30p);
  assert.deepEqual(ctx.q1.worse, o30w);
  assert.equal(o30p.first_breach, null);
  assert.equal(o30p.need, 0);
  assert.deepEqual(answer_q1(ctx.series.plan, HZ + 1, B0), { beyond_horizon: true });
  for (const mode of ['plan', 'worse']) {
    assert.deepEqual(runway_days(ctx.series[mode], ctx.events[mode]), { with: null, without: null }, 'расходы 339000 < остатка 400000');
  }
});

test('B-10 Q1 §9.9 low/gap: min trough, need, first_breach, runway_with по канону; движок и оракул совпадают', () => {
  // low
  let ctx = run(variant_ws('low'));
  let P = naive_model(variant_cfg('low'), 'plan');
  let W = naive_model(variant_cfg('low'), 'worse');
  let qp = naive_q1(P, HZ, B0);
  let qw = naive_q1(W, HZ, B0);
  assert.deepEqual([qp.min, fmt(qp.at), qp.need, qp.ok_buffer], [25500, '2026-10-31', 24500, false]);
  assert.deepEqual([qw.min, fmt(qw.at), qw.need, qw.ok_buffer], [3000, '2026-11-14', 47000, false]);
  assert.deepEqual(ctx.q1.plan, qp);
  assert.deepEqual(ctx.q1.worse, qw);
  // gap
  ctx = run(variant_ws('gap'));
  P = naive_model(variant_cfg('gap'), 'plan');
  W = naive_model(variant_cfg('gap'), 'worse');
  qp = naive_q1(P, HZ, B0);
  qw = naive_q1(W, HZ, B0);
  assert.deepEqual([qp.min, fmt(qp.at), qp.need], [-94500, '2026-10-31', 144500]);
  assert.deepEqual([qw.min, fmt(qw.at), qw.need], [-117000, '2026-11-14', 167000]);
  assert.equal(fmt(qp.first_breach), '2026-10-26');
  assert.equal(P.trough[D('2026-10-26') - AS_OF], -84500);
  assert.deepEqual(ctx.q1.plan, qp);
  assert.deepEqual(ctx.q1.worse, qw);
  const rw = runway_days(ctx.series.plan, ctx.events.plan);
  assert.equal(rw.with.date, D('2026-10-26'));
  assert.equal(rw.with.days, 22, 'runway_with = 2026-10-26 (через 22 дня)');
});

// ── 2.4. §9.5, §9.9: волны ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Ожидания канона по волнам: [вариант, режим, волна] → {cash, min, need, gap, cov, reserved}. */
const CANON_WAVES = [
  ['base', 'plan', 0, { cash: 377500, min: 205500, min_date: '2026-10-31', R: 172000, need: 222000, gap: 0, cov: 1700, reserved: 150000, end: '2026-11-04' }],
  ['base', 'worse', 0, { cash: 377500, min: 183000, min_date: '2026-11-14', R: 194500, need: 244500, gap: 0, cov: 1543, reserved: 150000, end: '2026-11-18' }],
  ['base', 'plan', 1, { cash: 452000, min: 340000, min_date: '2026-11-28', R: 112000, need: 162000, gap: 0, cov: 2790, reserved: 167800, end: '2026-11-30' }],
  ['base', 'worse', 1, { cash: 452000, min: 340000, min_date: '2026-11-28', R: 112000, need: 162000, gap: 0, cov: 2790, reserved: 167800, end: '2026-11-30' }],
  ['low', 'plan', 0, { cash: 197500, need: 222000, gap: 24500, cov: 889 }],
  ['low', 'worse', 0, { need: 244500, gap: 47000, cov: 807 }],
  ['low', 'plan', 1, { cash: 272000, min: 160000, min_date: '2026-11-28', need: 162000, gap: 0, cov: 1679 }],
  ['gap', 'plan', 0, { cash: 77500, gap: 144500, cov: 349 }],
  ['gap', 'worse', 0, { gap: 167000, cov: 316 }],
  ['gap', 'plan', 1, { cash: 152000, min: 40000, min_date: '2026-11-28', gap: 10000, cov: 938 }],
];

test('B-11 §9.5/§9.9 волны: состав (W1 = налог+аренда+ЖКХ 152000; W2 = аренда+ЖКХ 102000), метрики по канону — оракул и движок', () => {
  for (const [name, mode, idx, exp] of CANON_WAVES) {
    const m = naive_model(variant_cfg(name), mode);
    const ws = naive_waves(m, 3, 10, 3000);
    assert.equal(ws.length, 2, `${name}: две волны`);
    assert.deepEqual([ws[0].total, ws[1].total], [152000, 102000]);
    assert.deepEqual([fmt(ws[0].start), fmt(ws[0].end), fmt(ws[1].start)], ['2026-10-23', '2026-10-26', '2026-11-25']);
    const o = naive_wave_metrics(m, ws[idx], B0);
    for (const [k, v] of Object.entries(exp)) {
      const got = { cash: o.cash, min: o.min, min_date: fmt(o.min_date), R: o.R, need: o.need, gap: o.gap, cov: o.cov, reserved: o.reserved, end: fmt(o.window_end) }[k];
      assert.equal(got, v, `канон/оракул ${name}/${mode}/W${idx + 1}: ${k}`);
    }
    // движок
    const ctx = run(variant_ws(name));
    const items = list_waves(ctx, mode);
    assert.equal(items.length, 2, `движок ${name}/${mode}: две волны`);
    const it = items[idx];
    assert.equal(it.wave.total_out_minor, ws[idx].total);
    assert.deepEqual([it.wave.start, it.wave.end], [ws[idx].start, ws[idx].end]);
    assert.deepEqual(
      [it.metrics.cash_minor, it.metrics.min_trough.amount_minor, it.metrics.min_trough.date, it.metrics.r_minor, it.metrics.need_minor, it.metrics.gap_minor, it.metrics.coverage_pm, it.metrics.reserved_minor, it.metrics.window_end],
      [o.cash, o.min, o.min_date, o.R, o.need, o.gap, o.cov, o.reserved, o.window_end],
      `движок ${name}/${mode}/W${idx + 1}`,
    );
  }
});

test('B-12 §9.5 проверка R_w вручную (канон): W1 plan = 50000+90000+12000+2×10000 = 172000; worse добавляет продукты 11-07, 11-14 и связь 11-09 = 194500; coverage floor(1000·cash/need)', () => {
  assert.equal(50000 + 90000 + 12000 + 2 * 10000, 172000);
  assert.equal(172000 + 20000 + 2500, 194500);
  assert.equal(fl(1000n * 377500n, 222000n), 1700);
  assert.equal(fl(1000n * 377500n, 244500n), 1543);
  assert.equal(fl(1000n * 452000n, 162000n), 2790);
  assert.equal(fl(1000n * 197500n, 222000n), 889);
  assert.equal(fl(1000n * 197500n, 244500n), 807);
  assert.equal(fl(1000n * 272000n, 162000n), 1679);
  assert.equal(fl(1000n * 77500n, 222000n), 349);
  assert.equal(fl(1000n * 77500n, 244500n), 316);
  assert.equal(fl(1000n * 152000n, 162000n), 938);
});

// ── 2.5. §9.6: Q3 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const treadmill = (S, date = '2026-10-12') => ({ currency: 'EUR', parts: [{ date, amount_minor: S }] });

/** Таблица §9.6 «Вердикт по сумме покупки»: [S, m_after plan, m_after worse, вердикт]. */
const CANON_Q3 = [
  [15000, 78500, 56000, 'OK'],
  [21000, 72500, 50000, 'OK'],
  [30000, 63500, 41000, 'FRAGILE'],
  [43500, 50000, 27500, 'FRAGILE'],
  [60000, 33500, 11000, 'TIGHT'],
  [93500, 0, -22500, 'TIGHT'],
  [120000, -26500, -49000, 'NO'],
];

test('B-13 §9.6 Q3: таблица вердиктов по сумме (D = 2026-10-12, B = 50000) — оракул, канон, движок', () => {
  const ctx = run(load('g001.json'));
  const P = naive_model(g001_cfg(), 'plan');
  const W = naive_model(g001_cfg(), 'worse');
  for (const [S, mp, mw, v] of CANON_Q3) {
    const parts = [{ date: D('2026-10-12'), amt: S }];
    const op = naive_after(P, parts);
    const ow = naive_after(W, parts);
    assert.equal(op.m_after, mp, `оракул plan S=${S}`);
    assert.equal(ow.m_after, mw, `оракул worse S=${S}`);
    assert.equal(naive_verdict(op.m_after, ow.m_after, B0), v, `вердикт оракула S=${S}`);
    const r = check_purchase(ctx, treadmill(S), null);
    assert.equal(r.kind, 'ok');
    assert.equal(r.by_mode.plan.m_after, mp, `движок plan S=${S}`);
    assert.equal(r.by_mode.worse.m_after, mw, `движок worse S=${S}`);
    assert.equal(r.verdict, v, `движок вердикт S=${S}`);
    assert.equal(r.flags.worse_gap, mw < 0);
    assert.equal(r.by_mode.plan.margin, mp - B0);
    assert.equal(r.by_mode.worse.margin, mw - B0);
  }
});

test('B-14 §9.6 дорожка 30000: m_after/дата/margin/delta/cash_gap/min trough после покупки — канон дословно', () => {
  const ctx = run(load('g001.json'));
  const r = check_purchase(ctx, treadmill(30000), null);
  assert.deepEqual([r.by_mode.plan.m_after, fmt(r.by_mode.plan.at), r.by_mode.plan.margin, r.by_mode.plan.delta, r.by_mode.plan.cash_gap], [63500, '2026-11-01', 13500, 30000, false]);
  assert.deepEqual([r.by_mode.worse.m_after, fmt(r.by_mode.worse.at), r.by_mode.worse.margin, r.by_mode.worse.delta, r.by_mode.worse.cash_gap], [41000, '2026-11-14', -9000, 30000, false]);
  assert.equal(r.verdict, 'FRAGILE');
  // min trough после покупки (физические деньги): 175500 · 10-31 (plan), 153000 · 11-14 (worse)
  for (const [mode, min, at] of [['plan', 175500, '2026-10-31'], ['worse', 153000, '2026-11-14']]) {
    const m = naive_model(g001_cfg(), mode);
    const after = m.trough.map((t, i) => t - (AS_OF + i >= D('2026-10-12') ? 30000 : 0));
    const k = argmin(after, 0, after.length - 1);
    assert.deepEqual([after[k], fmt(AS_OF + k)], [min, at]);
  }
  assert.deepEqual(r.culprit_event_ids, ['S-HOURLY@2026-11-05'], 'опорное событие — задержанный доход потока');
});

test('B-15 §9.6 границы вердиктов: OK при S ≤ 21000; FRAGILE 21001…43500; TIGHT 43501…93500; NO при S ≥ 93501 (перебор соседних значений)', () => {
  const ctx = run(load('g001.json'));
  const v = (S) => check_purchase(ctx, treadmill(S), null).verdict;
  assert.equal(v(1), 'OK');
  assert.equal(v(21000), 'OK');
  assert.equal(v(21001), 'FRAGILE');
  assert.equal(v(43500), 'FRAGILE');
  assert.equal(v(43501), 'TIGHT');
  assert.equal(v(93500), 'TIGHT');
  assert.equal(v(93501), 'NO');
  const P = naive_model(g001_cfg(), 'plan');
  const W = naive_model(g001_cfg(), 'worse');
  for (const S of [20999, 21000, 21001, 43499, 43500, 43501, 93499, 93500, 93501]) {
    const parts = [{ date: D('2026-10-12'), amt: S }];
    assert.equal(v(S), naive_verdict(naive_after(P, parts).m_after, naive_after(W, parts).m_after, B0), `S=${S}`);
  }
});

test('B-16 §9.6 S_max(D): на 2026-10-12 и сегодня plan 43500, worse 21000; оракул-бисекция по определению «держится в буфере» даёт то же', () => {
  const ctx = run(load('g001.json'));
  for (const ds of ['2026-10-04', '2026-10-12']) {
    const i0 = D(ds) - AS_OF;
    assert.equal(max_amount(ctx, D(ds), B0, 'plan'), 43500, `plan ${ds}`);
    assert.equal(max_amount(ctx, D(ds), B0, 'worse'), 21000, `worse ${ds}`);
    assert.equal(brute_smax(naive_model(g001_cfg(), 'plan').free, i0, B0), 43500);
    assert.equal(brute_smax(naive_model(g001_cfg(), 'worse').free, i0, B0), 21000);
  }
  const r = check_purchase(ctx, treadmill(30000), null);
  assert.deepEqual(r.s_max, { plan: 43500, worse: 21000 });
});

test('B-17 §9.6 earliest(S): таблица (15000 → 10-04/10-04; 30000 → 10-04/2026-11-20; 60000 и 90000 → 11-06/11-20); оракул-перебор и движок', () => {
  const ctx = run(load('g001.json'));
  const CAN = [[15000, '2026-10-04', '2026-10-04'], [30000, '2026-10-04', '2026-11-20'], [60000, '2026-11-06', '2026-11-20'], [90000, '2026-11-06', '2026-11-20']];
  const P = naive_model(g001_cfg(), 'plan');
  const W = naive_model(g001_cfg(), 'worse');
  for (const [S, p, w] of CAN) {
    assert.equal(fmt(AS_OF + brute_earliest(P.free, S, 0, B0)), p, `оракул plan S=${S}`);
    assert.equal(fmt(AS_OF + brute_earliest(W.free, S, 0, B0)), w, `оракул worse S=${S}`);
    assert.equal(fmt(earliest_date(ctx, S, AS_OF, B0, 'plan')), p, `движок plan S=${S}`);
    assert.equal(fmt(earliest_date(ctx, S, AS_OF, B0, 'worse')), w, `движок worse S=${S}`);
  }
  // 11-19: внутридневной порядок «расходы раньше доходов» оставляет минимум 71000 → 11-19 не подходит для S = 30000, 11-20 подходит
  assert.equal(W.free[D('2026-11-19') - AS_OF], 71000);
  assert.ok(!ok_after(W.free, D('2026-11-19') - AS_OF, 30000, B0));
  assert.ok(ok_after(W.free, D('2026-11-20') - AS_OF, 30000, B0));
});

// ── 2.6. §9.7 STS и варианты ────────────────────────────────────────────────────────────────────────────────────────────

test('B-18 §9.7 STS: T по умолчанию = 2026-11-19; STS(10-31) = 55500/55500; STS(11-19) = 43500/21000; STS(horizon_end) = S_max(as_of); подпись: резервы на узкой точке 112000', () => {
  const ctx = run(load('g001.json'));
  assert.equal(fmt(default_sts_horizon(ctx)), '2026-11-19');
  const rows = [['2026-10-31', 55500, 55500], ['2026-11-19', 43500, 21000], ['2026-11-30', 43500, 21000]];
  const P = naive_model(g001_cfg(), 'plan');
  const W = naive_model(g001_cfg(), 'worse');
  for (const [ds, sp, sw] of rows) {
    const hi = D(ds) - AS_OF;
    assert.equal(Math.max(0, Math.min(...P.free.slice(0, hi + 1)) - B0), sp, `оракул plan ${ds}`);
    assert.equal(Math.max(0, Math.min(...W.free.slice(0, hi + 1)) - B0), sw, `оракул worse ${ds}`);
    assert.equal(safe_to_spend(ctx, D(ds), null, 'plan').sts, sp, `движок plan ${ds}`);
    assert.equal(safe_to_spend(ctx, D(ds), null, 'worse').sts, sw, `движок worse ${ds}`);
  }
  const head = safe_to_spend(ctx, default_sts_horizon(ctx), null);
  assert.deepEqual([head.sts, head.min_free, fmt(head.at), head.short_to_buffer, head.sts_horizon], [21000, 71000, '2026-11-14', 0, 21000]);
  assert.equal(W.rtrough[D('2026-11-14') - AS_OF], 112000);
  assert.equal(183000 - 112000 - 50000, 21000);
  assert.equal(W.rtrough[0], 150000, 'на сегодня зарезервировано 150000');
  assert.equal(1830 - 1500 - 500, -170, 'прежняя подпись «при резервах 1 500,00 €» вводила в заблуждение');
});

test('B-19 §9.9 low: min free plan −86500 (11-01), worse −109000 (11-14); STS = 0; short_to_buffer 136500/159000; любая S > 0 → NO; S_max = 0; earliest = null', () => {
  const ctx = run(variant_ws('low'));
  const P = naive_model(variant_cfg('low'), 'plan');
  const W = naive_model(variant_cfg('low'), 'worse');
  const kp = argmin(P.free, 0, 57);
  const kw = argmin(W.free, 0, 57);
  assert.deepEqual([P.free[kp], fmt(AS_OF + kp), W.free[kw], fmt(AS_OF + kw)], [-86500, '2026-11-01', -109000, '2026-11-14']);
  const sp = safe_to_spend(ctx, HZ, null, 'plan');
  const sw = safe_to_spend(ctx, HZ, null, 'worse');
  assert.deepEqual([sp.sts, sp.short_to_buffer, sw.sts, sw.short_to_buffer], [0, 136500, 0, 159000]);
  for (const S of [1, 100, 30000, 120000]) {
    const r = check_purchase(ctx, treadmill(S), null);
    assert.equal(r.verdict, 'NO', `S=${S}`);
    assert.deepEqual(r.s_max, { plan: 0, worse: 0 });
    assert.deepEqual(r.earliest, { plan: null, worse: null });
  }
});

test('B-20 §9.9 gap: min free plan −206500 / worse −229000, short_to_buffer 256500/279000 (v1.1 C-067); Q1 need = 144500/167000 — три разные метрики «не хватает»', () => {
  const ctx = run(variant_ws('gap'));
  const P = naive_model(variant_cfg('gap'), 'plan');
  const W = naive_model(variant_cfg('gap'), 'worse');
  assert.equal(Math.min(...P.free), -206500);
  assert.equal(Math.min(...W.free), -229000);
  assert.equal(B0 - Math.min(...P.free), 256500);
  assert.equal(B0 - Math.min(...W.free), 279000);
  const sp = safe_to_spend(ctx, HZ, null, 'plan');
  const sw = safe_to_spend(ctx, HZ, null, 'worse');
  assert.deepEqual([sp.sts, sp.short_to_buffer, sw.sts, sw.short_to_buffer], [0, 256500, 0, 279000]);
  assert.equal(ctx.q1.plan.need, 144500);
  assert.equal(ctx.q1.worse.need, 167000);
  const r = check_purchase(ctx, treadmill(1000), null);
  assert.equal(r.verdict, 'NO');
  assert.equal(r.by_mode.plan.cash_gap, true, 'кассовый разрыв: trough < 0 после покупки');
});

test('B-21 §9.9 late (C-058): STS(11-19) = 43500/21000, но на всём горизонте min free = −77800 (11-28), sts_horizon = 0, short_to_buffer 127800, baseline_below_buffer = true, S_max = 0, earliest = null, вердикт ≠ OK', () => {
  const ctx = run(variant_ws('late'));
  for (const mode of ['plan', 'worse']) {
    const m = naive_model(variant_cfg('late'), mode);
    const k = argmin(m.free, 0, 57);
    assert.deepEqual([m.free[k], fmt(AS_OF + k), m.trough[k], m.rtrough[k]], [-77800, '2026-11-28', 90000, 167800], `оракул ${mode}`);
    const hi = D('2026-11-19') - AS_OF;
    assert.equal(Math.min(...m.free.slice(0, hi + 1)), mode === 'plan' ? 93500 : 71000);
  }
  const t = D('2026-11-19');
  assert.equal(safe_to_spend(ctx, t, null, 'plan').sts, 43500);
  assert.equal(safe_to_spend(ctx, t, null, 'worse').sts, 21000);
  const full = safe_to_spend(ctx, HZ, null, 'worse');
  assert.deepEqual([full.sts, full.short_to_buffer, full.sts_horizon], [0, 127800, 0]);
  const head = safe_to_spend(ctx, t, null, 'worse');
  assert.equal(head.sts_horizon, 0, 'sts_horizon = STS(horizon_end) = S_max(as_of) = 0 при sts = 21000');
  assert.ok(head.sts_horizon < head.sts);
  assert.equal(max_amount(ctx, AS_OF, B0, 'worse'), 0);
  assert.equal(earliest_date(ctx, 1000, AS_OF, B0, 'worse'), null);
  const r = check_purchase(ctx, treadmill(1000), null);
  assert.notEqual(r.verdict, 'OK');
  assert.equal(r.flags.baseline_below_buffer, true);
});

test('B-22 §9.7 разложение STS: Σ breakdown = min_free − B на G-001 (REQ-057) для обоих режимов и дат T', () => {
  const ctx = run(load('g001.json'));
  for (const mode of ['plan', 'worse']) {
    for (const ds of ['2026-10-12', '2026-10-31', '2026-11-19', '2026-11-30']) {
      const T = D(ds);
      const rows = sts_breakdown(ctx, T, null, mode);
      const sum = rows.reduce((s, r) => s + r.v, 0);
      const m = naive_model(g001_cfg(), mode);
      const mf = Math.min(...m.free.slice(0, T - AS_OF + 1));
      assert.equal(sum, mf - B0, `${mode} ${ds}: ${JSON.stringify(rows)}`);
    }
  }
});

// ── 2.7. §9.8 «почему» ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('B-23 §9.8 explain (worse): узкая точка 183000/11-14, пик 400000/10-04, out_total 217000; цепочка 4147/2765/2304 → 9217; контрфакты по оракулу leave-one-out', () => {
  const ctx = run(load('g001.json'));
  const x = explain_narrowest(ctx.events.worse, ctx.series.worse, ctx.params);
  assert.deepEqual([x.point.amount_minor, fmt(x.point.date), x.peak.amount_minor, fmt(x.peak.date), x.out_total_minor, x.inflow_offset_minor], [183000, '2026-11-14', 400000, '2026-10-04', 217000, 0]);
  assert.deepEqual(x.chain.map((c) => [c.group, c.amount_minor, c.share_bp, c.cum_bp]), [['R-RENT', 90000, 4147, 4147], ['R-GROC', 60000, 2765, 6912], ['tag:налог', 50000, 2304, 9217]]);
  // независимо: доли
  assert.equal(he(10000n * 90000n, 217000n), 4147);
  assert.equal(he(10000n * 60000n, 217000n), 2765);
  assert.equal(he(10000n * 50000n, 217000n), 2304);
  assert.equal(he(10000n * 200000n, 217000n), 9217);
  assert.equal(he(10000n * 12000n, 217000n), 553);
  assert.equal(he(10000n * 5000n, 217000n), 230);
  // контрфакты: пересчёт оракулом без группы (режим worse) → новый min trough
  const base = g001_cfg();
  const without = (pred) => {
    const c = { ...base, events: base.events.filter((e) => !pred(e)) };
    const m = naive_model(c, 'worse');
    const k = argmin(m.trough, 0, m.N - 1);
    return [m.trough[k], fmt(AS_OF + k)];
  };
  const cf = Object.fromEntries(x.counterfactuals.map((c) => [c.kind === 'without' ? c.group : c.kind, [c.new_min.amount_minor, fmt(c.new_min.date)]]));
  assert.deepEqual(cf['R-RENT'], without((e) => e.id.startsWith('R-RENT')));
  assert.deepEqual(cf['R-RENT'], [273000, '2026-11-14']);
  assert.deepEqual(cf['R-GROC'], without((e) => e.id.startsWith('R-GROC')));
  assert.deepEqual(cf['R-GROC'], [243000, '2026-11-09']);
  assert.deepEqual(cf['tag:налог'], without((e) => e.id === 'P-TAX1'));
  assert.deepEqual(cf['tag:налог'], [233000, '2026-11-14']);
  const nodelay = naive_model({ ...base, delay: 0 }, 'worse');
  const k = argmin(nodelay.trough, 0, nodelay.N - 1);
  assert.deepEqual(cf.no_delay, [nodelay.trough[k], fmt(AS_OF + k)]);
  assert.deepEqual(cf.no_delay, [205500, '2026-10-31']);
});

// ── 2.8. §9.15 неопределённость (числа канона) ──────────────────────────────────────────────────────────────────────────────

test('B-24 §9.15: min free по лагам выплаты {0,2,3,5,6,7,9,14} — оракул даёт 93500/83500/83500/81000/81000/81000/71000/71000; движок при worse.income_delay_days = лаг даёт то же', () => {
  const lags = [0, 3, 7, 5, 14, 6, 2, 9];
  const CAN = { 0: 93500, 2: 83500, 3: 83500, 5: 81000, 6: 81000, 7: 81000, 9: 71000, 14: 71000 };
  const mins = [];
  for (const lag of lags) {
    const m = naive_model(g001_cfg({ delay: lag }), 'worse');
    const mf = Math.min(...m.free);
    assert.equal(mf, CAN[lag], `оракул лаг ${lag}`);
    const ws = structuredClone(load('g001.json'));
    ws.params['worse.income_delay_days'] = lag;
    const ctx = run(ws);
    assert.equal(Math.min(...ctx.series.worse.free), CAN[lag], `движок лаг ${lag}`);
    mins.push(mf);
  }
  const sorted = [...mins].sort((a, b) => a - b);
  assert.deepEqual(sorted, [71000, 71000, 81000, 81000, 81000, 83500, 83500, 93500]);
  // p_fail покупки 30000 при B = 50000: min free < 80000 → лаги 9 и 14 → 2/8
  assert.equal(mins.filter((x) => x - 30000 < 50000).length, 2);
  // P10/P50/P90 nearest-rank
  assert.equal(sorted[Math.ceil(0.1 * 8) - 1], 71000);
  assert.equal(sorted[Math.ceil(0.5 * 8) - 1], 81000);
  assert.equal(sorted[Math.ceil(0.9 * 8) - 1], 93500);
  assert.equal(nearest_rank(sorted, 10), 71000);
  assert.equal(nearest_rank(sorted, 50), 81000);
  assert.equal(nearest_rank(sorted, 90), 93500);
  // nearest-rank лагов: p50 = 5, p80 = 9, p90 = 14
  const sl = [...lags].sort((a, b) => a - b);
  assert.deepEqual([nearest_rank(sl, 50), nearest_rank(sl, 80), nearest_rank(sl, 90)], [5, 9, 14]);
});

test('B-25 §9.15: shrink_to_prior(5, 8, 7, 3) = 6; новый клиент (лаги [10,12], n = 2, median 10) → 8; Уилсон 2 из 8 = 7,1–59,1 %', () => {
  assert.equal(he(8n * 5n + 3n * 7n, 11n), 6);
  assert.equal(he(2n * 10n + 3n * 7n, 5n), 8);
  assert.equal(shrink_to_prior(5, 8, 7, 3), 6);
  assert.equal(shrink_to_prior(10, 2, 7, 3), 8);
  const z = 1.96;
  const n = 8;
  const p = 2 / 8;
  const den = 1 + (z * z) / n;
  const ctr = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  assert.equal(Math.round((ctr - half) * 1000) / 10, 7.1);
  assert.equal(Math.round((ctr + half) * 1000) / 10, 59.1);
  const w = wilson(2, 8);
  const lo = w.lo ?? w.lo_pm ?? w[0];
  const hi = w.hi ?? w.hi_pm ?? w[1];
  assert.ok(lo !== undefined && hi !== undefined, `форма wilson: ${JSON.stringify(w)}`);
  const scale = hi > 1 ? (hi > 100 ? 1000 : 100) : 1; // ‰, % или доля
  assert.ok(Math.abs((lo / scale) * 100 - 7.1) < 0.06 || Math.abs((lo / scale) * 100 - 7.15) < 0.1, `lo = ${lo}`);
  assert.ok(Math.abs((hi / scale) * 100 - 59.1) < 0.1, `hi = ${hi}`);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 3. PROPERTY-BASED / ФАЗЗИНГ
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** Случайная рабочая область из одноразовых плановых записей (оракул знает их все) + налоговый/sinking резервы. */
function gen_case(seed) {
  const rng = make_rng(seed * 7919 + 13);
  const as_of = D('2026-01-01') + rng.int(0, 600);
  const horizon_days = rng.next() < 0.15 ? rng.int(0, 3) : rng.int(14, 90); // вырожденные горизонты (N = 1…4) тоже
  const hz = as_of + horizon_days;
  const rich = rng.next() < 0.5; // «богатые» данные: baseline_below_buffer редок, вердикты OK/FRAGILE/TIGHT встречаются чаще
  const opening = rich ? rng.int(400000, 1500000) : rng.int(-20000, 900000);
  const B = rich ? rng.pick([0, 10000, 50000]) : rng.pick([0, 0, 10000, 50000, 120000, 300000]);
  const delay = rng.pick([0, 3, 7, 14, 14, 21]);
  const n = rng.int(0, 26);
  const plans = [];
  const events = [];
  const res_ids = [];
  const use_tax = rng.next() < 0.6;
  const use_tax2 = use_tax && rng.next() < 0.3;
  const use_sink = rng.next() < 0.5;
  if (use_tax) res_ids.push('RES-T1');
  if (use_tax2) res_ids.push('RES-T2');
  if (use_sink) res_ids.push('RES-S');
  for (let i = 0; i < n; i++) {
    const income = rng.next() < 0.35;
    const date = as_of + rng.int(0, horizon_days + 6);
    const amt = income ? rng.int(1, rich ? 250000 : 400000) : -rng.int(1, rich ? 60000 : 250000);
    const e = {
      id: `p${i}`, date, amt, kind: income ? 'income' : 'expense', tag: income ? (rng.next() < 0.8 ? 'work' : 'gift') : rng.pick(['еда', 'аренда', 'прочее']),
      oblig: rng.next() < 0.5, est: rng.next() < 0.2, reserve: !income && res_ids.length > 0 && rng.next() < 0.3 ? rng.pick(res_ids) : null,
    };
    events.push(e);
    plans.push({ plan_id: e.id, account_id: 'acc_main', name: e.id, date: fmt(date), amount_minor: amt, currency: 'EUR', kind: e.kind, tag: e.tag, is_obligation: e.oblig, is_estimate: e.est, ...(e.reserve ? { reserve_id: e.reserve } : {}) });
  }
  const tax = [];
  const tax_rules = [];
  const reserves = [];
  const res0 = {};
  const contribs = [];
  const mk_rule = (id, res, rate_bp) => ({ tax_rule_id: id, version: 1, name: id, kind: 'percent_of_income', rate_bp, base: 'gross', applies_to: { stream_ids: [], tags: ['work'] }, valid_from: '2025-01-01', valid_to: null, rounding: 'half_even', reserve_id: res, recorded_at: '2025-01-02T10:00:00Z' });
  if (use_tax) {
    const f = rng.int(0, 200000);
    const rate = rng.int(0, 5000);
    res0['RES-T1'] = f;
    tax.push({ res: 'RES-T1', rate_bp: rate, tags: ['work'] });
    tax_rules.push(mk_rule('TR-1', 'RES-T1', rate));
    reserves.push({ reserve_id: 'RES-T1', kind: 'tax', name: 'T1', currency: 'EUR', funded_start_minor: f, funded_as_of: fmt(as_of), tax_rule_id: 'TR-1', backed_by_account_id: null });
  }
  if (use_tax2) {
    const f = rng.int(0, 80000);
    const rate = rng.int(0, 4000);
    res0['RES-T2'] = f;
    tax.push({ res: 'RES-T2', rate_bp: rate, tags: ['work'] });
    tax_rules.push(mk_rule('TR-2', 'RES-T2', rate));
    reserves.push({ reserve_id: 'RES-T2', kind: 'tax', name: 'T2', currency: 'EUR', funded_start_minor: f, funded_as_of: fmt(as_of), tax_rule_id: 'TR-2', backed_by_account_id: null });
  }
  if (use_sink) {
    const f = rng.int(0, 30000);
    const target = f + rng.int(-5000, 120000);
    const due = as_of + rng.int(10, 200);
    res0['RES-S'] = f;
    reserves.push({ reserve_id: 'RES-S', kind: 'sinking', name: 'S', currency: 'EUR', funded_start_minor: f, funded_as_of: fmt(as_of), target_minor: target, due_date: fmt(due), cadence: { freq: 'M', day: 1 }, mode: 'refill_to_target', backed_by_account_id: null });
    // взносы по D-18: даты 1-го числа с as_of ≤ d < due; c_k = min(ceil(rem/(n−k)), rem)
    const dates = [];
    const y0 = Number(fmt(as_of).slice(0, 4));
    const m0 = Number(fmt(as_of).slice(5, 7));
    for (let j = 0; j < 40; j++) {
      const yy = y0 + Math.floor((m0 - 1 + j) / 12);
      const mm = ((m0 - 1 + j) % 12) + 1;
      const d = dfc(yy, mm, 1);
      if (d >= due) break;
      if (d >= as_of) dates.push(d);
    }
    let rem = target - f;
    if (rem > 0) {
      for (let k = 0; k < dates.length; k++) {
        const c = Math.min(cdiv(rem, dates.length - k), rem);
        if (c > 0 && dates[k] <= hz) contribs.push({ res: 'RES-S', date: dates[k], amt: c });
        rem -= c;
      }
    }
  }
  const ws = {
    workspace_id: `ws-fuzz-${seed}`, name: `fuzz ${seed}`, locale: 'ru', decision_currency: 'EUR', format: 'runway-journal/1', as_of: fmt(as_of),
    params: { horizon_days, buffer_minor: B, 'worse.income_delay_days': delay, 'wave.gap_days': 3, 'wave.max_span_days': 10, 'wave.threshold_minor': rng.pick([1000, 3000, 20000]), rounding: 'half_even' },
    accounts: [{ account_id: 'acc_main', name: 'Основной', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2, liquidity_bp: 0, opened_on: '2025-01-01' }],
    calendars: [{ calendar_id: 'cal-main', name: 'сб, вс', weekend_dows: [0, 6], holidays: [] }],
    anchors: [{ anchor_id: 'anc-1', account_id: 'acc_main', date: fmt(as_of), amount_minor: opening }],
    facts: [], rules: [], overrides: [], plans, streams: [], tax_rules, reserves, allocations: [], rates: [], scenarios: [], purchases: [], debts: [], wave_overrides: [], counterparties: [],
  };
  const cfg = { as_of, hz, opening, delay, events, tax, res0, contribs };
  return { seed, rng, ws, cfg, B, as_of, hz, horizon_days, horizon_end: hz };
}

const SEEDS = Array.from({ length: Number(process.env.GP_SEEDS ?? 160) }, (_, i) => i + 1 + Number(process.env.GP_SEED0 ?? 0));
const CACHE = new Map();
/** Случай + анализ (кэш; `readiness` поднят до «полный» — гейт тестируется отдельно, здесь проверяется арифметика). */
function the_case(seed) {
  if (!CACHE.has(seed)) {
    const c = gen_case(seed);
    const ctx = analyze(c.ws, { as_of: c.ws.as_of, horizon_days: c.horizon_days });
    ctx.readiness = { score: 4, level: 'full', reasons: [] };
    CACHE.set(seed, { ...c, ctx, naive: { plan: naive_model(c.cfg, 'plan'), worse: naive_model(c.cfg, 'worse') } });
    fuzz_progress('golden:areas', CACHE.size, SEEDS.length);
  }
  return CACHE.get(seed);
}
const MODES = ['plan', 'worse'];

test('B-30 фаззинг: ряды движка = наивный оракул (close, trough, reserve_trough, reserve_close, free, opening) на 160 случайных рабочих областях, оба режима', () => {
  for (const seed of SEEDS) {
    const { ctx, naive } = the_case(seed);
    for (const mode of MODES) {
      const s = ctx.series[mode];
      const m = naive[mode];
      assert.equal(s.opening_minor, m.opening, `seed ${seed} ${mode} opening`);
      assert.deepEqual(s.close, m.close, `seed ${seed} ${mode} close`);
      assert.deepEqual(s.trough, m.trough, `seed ${seed} ${mode} trough`);
      assert.deepEqual(s.reserve_trough, m.rtrough, `seed ${seed} ${mode} reserve_trough`);
      assert.deepEqual(s.reserve_close, m.rclose, `seed ${seed} ${mode} reserve_close`);
      assert.deepEqual(s.free, m.free, `seed ${seed} ${mode} free`);
    }
  }
});

test('B-31 свойство: сохранение close по дням — close[i] − close[i−1] = out_i + in_i (по событиям движка), close[−1] = opening, trough[i] = close[i−1] + out_i, trough ≤ close', () => {
  for (const seed of SEEDS) {
    const { ctx } = the_case(seed);
    for (const mode of MODES) {
      const s = ctx.series[mode];
      const N = s.close.length;
      assert.equal(N, ctx.horizon_end - ctx.as_of + 1);
      const out = new Array(N).fill(0);
      const inn = new Array(N).fill(0);
      for (const e of ctx.events[mode]) {
        const i = e.date - ctx.as_of;
        if (i < 0 || i >= N) continue;
        if (e.amount_minor < 0) out[i] += e.amount_minor; else inn[i] += e.amount_minor;
      }
      let prev = s.opening_minor;
      for (let i = 0; i < N; i++) {
        assert.equal(s.trough[i], prev + out[i], `seed ${seed} ${mode} trough[${i}]`);
        assert.equal(s.close[i] - prev, out[i] + inn[i], `seed ${seed} ${mode} close-diff[${i}]`);
        assert.ok(s.trough[i] <= s.close[i], `seed ${seed} trough ≤ close [${i}]`);
        prev = s.close[i];
      }
    }
  }
});

test('B-32 свойство: worse ≤ plan — trough, close, free, суффиксный минимум free, STS и S_max (D-04, D-17 C-016); при delay = 0 режимы равны', () => {
  for (const seed of SEEDS) {
    const { ctx, B, cfg } = the_case(seed);
    const p = ctx.series.plan;
    const w = ctx.series.worse;
    for (let i = 0; i < p.trough.length; i++) {
      assert.ok(w.trough[i] <= p.trough[i], `seed ${seed} trough[${i}]: worse ${w.trough[i]} > plan ${p.trough[i]}`);
      assert.ok(w.close[i] <= p.close[i], `seed ${seed} close[${i}]`);
      assert.ok(w.free[i] <= p.free[i], `seed ${seed} free[${i}]: worse ${w.free[i]} > plan ${p.free[i]} (резервы: ${JSON.stringify(cfg.tax)})`);
    }
    for (const di of [0, Math.floor(p.free.length / 2), p.free.length - 1]) {
      const D0 = ctx.as_of + di;
      assert.ok(max_amount(ctx, D0, B, 'worse') <= max_amount(ctx, D0, B, 'plan'), `seed ${seed} S_max D+${di}`);
      assert.ok(safe_to_spend(ctx, D0, B, 'worse').sts <= safe_to_spend(ctx, D0, B, 'plan').sts, `seed ${seed} STS D+${di}`);
    }
    if (cfg.delay === 0) assert.deepEqual(p, w, `seed ${seed}: при задержке 0 режимы совпадают`);
  }
});

test('B-33 свойство: free ≤ trough; free = trough − reserve_trough; резервы неотрицательны; без резервов free = trough', () => {
  for (const seed of SEEDS) {
    const { ctx, ws } = the_case(seed);
    for (const mode of MODES) {
      const s = ctx.series[mode];
      for (let i = 0; i < s.free.length; i++) {
        assert.ok(s.reserve_trough[i] >= 0 && s.reserve_close[i] >= 0, `seed ${seed} резерв < 0 [${i}]`);
        assert.equal(s.free[i], s.trough[i] - s.reserve_trough[i]);
        assert.ok(s.free[i] <= s.trough[i], `seed ${seed} free > trough [${i}]`);
      }
      if (ws.reserves.length === 0) assert.deepEqual(s.free, s.trough, `seed ${seed}: без резервов free = trough`);
    }
  }
});

test('B-34 свойство D-07/D-08: резервы НЕ меняют close и trough — тот же ws без резервов и привязок платежей даёт идентичные ряды close/trough и события', () => {
  for (const seed of SEEDS.slice(0, 80)) {
    const { ctx, ws } = the_case(seed);
    const bare = structuredClone(ws);
    bare.reserves = [];
    bare.tax_rules = [];
    for (const p of bare.plans) delete p.reserve_id;
    const c2 = analyze(bare, { as_of: bare.as_of, horizon_days: ctx.horizon_end - ctx.as_of });
    for (const mode of MODES) {
      assert.deepEqual(c2.series[mode].close, ctx.series[mode].close, `seed ${seed} ${mode} close`);
      assert.deepEqual(c2.series[mode].trough, ctx.series[mode].trough, `seed ${seed} ${mode} trough`);
      assert.deepEqual(c2.series[mode].free, c2.series[mode].trough);
    }
  }
});

test('B-35 свойство D-12: S_max(as_of) = STS(horizon_end) = sts_horizon (оба режима) на 160 случайных данных; плюс оракул-бисекция S_max на трёх датах', () => {
  for (const seed of SEEDS) {
    const { ctx, B, naive } = the_case(seed);
    for (const mode of MODES) {
      const smax = max_amount(ctx, ctx.as_of, B, mode);
      const sts = safe_to_spend(ctx, ctx.horizon_end, B, mode);
      assert.equal(sts.kind, undefined, `seed ${seed}: гейт не должен отказывать: ${JSON.stringify(sts)}`);
      assert.equal(smax, sts.sts, `seed ${seed} ${mode}: S_max(as_of) ≠ STS(horizon_end)`);
      assert.equal(sts.sts_horizon, smax, `seed ${seed} ${mode}: sts_horizon`);
      const f = naive[mode].free;
      assert.equal(smax, brute_smax(f, 0, B), `seed ${seed} ${mode}: S_max по оракулу-бисекции`);
      const N = f.length;
      for (const di of [Math.floor(N / 3), N - 1]) {
        assert.equal(max_amount(ctx, ctx.as_of + di, B, mode), brute_smax(f, di, B), `seed ${seed} ${mode} D+${di}`);
      }
    }
  }
});

test('B-36 свойство D-11: S_max_m(D) не убывает с ростом D (суффиксный минимум), S_max_worse ≤ S_max_plan, значения ≥ 0; при baseline_below_buffer — 0', () => {
  for (const seed of SEEDS) {
    const { ctx, B } = the_case(seed);
    const N = ctx.horizon_end - ctx.as_of + 1;
    for (const mode of MODES) {
      let prev = -1;
      const baseline_below = Math.min(...ctx.series[mode].free) < B;
      for (let di = 0; di < N; di++) {
        const v = max_amount(ctx, ctx.as_of + di, B, mode);
        assert.ok(v >= 0, `seed ${seed} ${mode} D+${di} < 0`);
        assert.ok(v >= prev, `seed ${seed} ${mode}: S_max убывает на D+${di}: ${v} < ${prev}`);
        if (baseline_below) assert.equal(v, 0, `seed ${seed} ${mode}: baseline_below_buffer ⇒ 0`);
        prev = v;
      }
    }
    for (let di = 0; di < N; di += 3) {
      assert.ok(max_amount(ctx, ctx.as_of + di, B, 'worse') <= max_amount(ctx, ctx.as_of + di, B, 'plan'), `seed ${seed} D+${di}`);
    }
    assert.equal(max_amount(ctx, ctx.horizon_end + 1, B, 'worse'), null, 'позже горизонта — null');
  }
});

test('B-37 свойство D-11: earliest_date монотонна по S (null = +∞) и равна наивному перебору «с какой даты сумма держится в буфере» — оба режима, несколько not_before', () => {
  for (const seed of SEEDS) {
    const { ctx, B, naive, rng } = the_case(seed);
    const N = ctx.horizon_end - ctx.as_of + 1;
    for (const mode of MODES) {
      const f = naive[mode].free;
      const Ss = [1, 500, 5000, 20000, 60000, 150000, 400000, 1500000].map((x) => x + (rng.int(0, 3)));
      let prev = -1;
      for (const S of Ss.sort((a, b) => a - b)) {
        for (const nbi of [0, Math.floor(N / 2)]) {
          const got = earliest_date(ctx, S, ctx.as_of + nbi, B, mode);
          const exp = brute_earliest(f, S, nbi, B);
          assert.equal(got, exp === null ? null : ctx.as_of + exp, `seed ${seed} ${mode} S=${S} nb=${nbi}`);
        }
        const e = earliest_date(ctx, S, ctx.as_of, B, mode);
        const key = e === null ? Infinity : e;
        assert.ok(key >= prev, `seed ${seed} ${mode}: earliest убывает с ростом S (S=${S}: ${e})`);
        prev = key;
      }
    }
  }
});

test('B-38 свойство D-11: check_purchase монотонна по сумме (вердикт не улучшается, m_after не растёт), согласована с S_max: OK ⇔ S ≤ S_max_worse; FRAGILE ⇔ S_max_worse < S ≤ S_max_plan; = оракул', () => {
  for (const seed of SEEDS) {
    const { ctx, B, naive, rng } = the_case(seed);
    const N = ctx.horizon_end - ctx.as_of + 1;
    const di = rng.int(0, N - 1);
    const Dd = ctx.as_of + di;
    const smax = { plan: max_amount(ctx, Dd, B, 'plan'), worse: max_amount(ctx, Dd, B, 'worse') };
    let prev_rank = -1;
    let prev_mp = Infinity;
    let prev_mw = Infinity;
    const Ss = [1, 100, 2500, 9000, 30000, 70000, 140000, 300000, 900000];
    for (const S of Ss) {
      const r = check_purchase(ctx, treadmill(S, fmt(Dd)), B);
      assert.equal(r.kind, 'ok', `seed ${seed}: ${JSON.stringify(r)}`);
      const parts = [{ date: Dd, amt: S }];
      const op = naive_after(naive.plan, parts);
      const ow = naive_after(naive.worse, parts);
      assert.equal(r.by_mode.plan.m_after, op.m_after, `seed ${seed} S=${S} plan m_after`);
      assert.equal(r.by_mode.worse.m_after, ow.m_after, `seed ${seed} S=${S} worse m_after`);
      assert.equal(r.by_mode.plan.at, op.at);
      assert.equal(r.by_mode.worse.at, ow.at);
      assert.equal(r.by_mode.worse.cash_gap, ow.cash_gap, `seed ${seed} S=${S} cash_gap`);
      assert.equal(r.verdict, naive_verdict(op.m_after, ow.m_after, B), `seed ${seed} S=${S} вердикт`);
      const rank = RANK[r.verdict];
      assert.ok(rank >= prev_rank, `seed ${seed}: вердикт улучшился с ростом S (S=${S})`);
      assert.ok(r.by_mode.plan.m_after <= prev_mp && r.by_mode.worse.m_after <= prev_mw, `seed ${seed}: m_after вырос с ростом S`);
      prev_rank = rank;
      prev_mp = r.by_mode.plan.m_after;
      prev_mw = r.by_mode.worse.m_after;
      // согласованность с S_max (v1.1 C-015)
      if (S <= smax.worse) assert.equal(r.verdict, 'OK', `seed ${seed} S=${S} ≤ S_max_worse=${smax.worse} ⇒ OK`);
      else if (S <= smax.plan) assert.equal(r.verdict, 'FRAGILE', `seed ${seed} S=${S}: S_max_worse=${smax.worse} < S ≤ S_max_plan=${smax.plan} ⇒ FRAGILE (получено ${r.verdict})`);
      else assert.ok(r.verdict === 'TIGHT' || r.verdict === 'NO', `seed ${seed} S=${S} > S_max_plan ⇒ TIGHT/NO`);
      assert.deepEqual(r.s_max, smax);
    }
  }
});

test('B-39 свойство: перестановка записей (plans, reserves, tax_rules, facts, ключи params) не меняет ни ряды, ни Q1, ни волны, ни inputs_hash', () => {
  for (const seed of SEEDS.slice(0, 70)) {
    const { ctx, ws, rng } = the_case(seed);
    const shuffle = (xs) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = rng.int(0, i); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    const w2 = structuredClone(ws);
    w2.plans = shuffle(w2.plans);
    w2.reserves = shuffle(w2.reserves);
    w2.tax_rules = shuffle(w2.tax_rules);
    w2.params = Object.fromEntries(shuffle(Object.entries(w2.params)));
    // старые факты (до якоря) — на проверку заодно: порядок факта не влияет
    w2.facts = shuffle([
      { event_id: 'f1', account_id: 'acc_main', date: fmt(ctx.as_of - 10), amount_minor: -1200, currency: 'EUR', kind: 'expense', tag: 'еда' },
      { event_id: 'f2', account_id: 'acc_main', date: fmt(ctx.as_of - 30), amount_minor: -8800, currency: 'EUR', kind: 'expense', tag: 'еда' },
      { event_id: 'f3', account_id: 'acc_main', date: fmt(ctx.as_of - 45), amount_minor: 90000, currency: 'EUR', kind: 'income', tag: 'work' },
    ]);
    const w1 = structuredClone(ws);
    w1.facts = structuredClone(w2.facts).reverse();
    const c1 = analyze(w1, { as_of: w1.as_of, horizon_days: ctx.horizon_end - ctx.as_of });
    const c2 = analyze(w2, { as_of: w2.as_of, horizon_days: ctx.horizon_end - ctx.as_of });
    for (const mode of MODES) {
      assert.deepEqual(c2.series[mode], c1.series[mode], `seed ${seed} ${mode} series`);
      assert.deepEqual(c2.q1[mode], c1.q1[mode]);
      assert.deepEqual(list_waves(c2, mode), list_waves(c1, mode), `seed ${seed} ${mode} волны`);
    }
    assert.equal(c2.inputs_hash, c1.inputs_hash, `seed ${seed}: inputs_hash зависит от порядка записей`);
    assert.deepEqual(c2.warnings, c1.warnings);
  }
});

test('B-40 свойство: добавление нулевого события (расход/доход 0, в т. ч. is_obligation) не меняет ряды, free, Q1 и волны', () => {
  const failures = [];
  for (const seed of SEEDS.slice(0, 60)) {
    const { ctx, ws, rng } = the_case(seed);
    for (const kind of ['expense', 'income']) {
      const w2 = structuredClone(ws);
      w2.plans.push({ plan_id: 'zero-1', account_id: 'acc_main', name: 'zero', date: fmt(ctx.as_of + rng.int(0, ctx.horizon_end - ctx.as_of)), amount_minor: 0, currency: 'EUR', kind, tag: 'work', is_obligation: true, is_estimate: false });
      let c2;
      try {
        c2 = analyze(w2, { as_of: w2.as_of, horizon_days: ctx.horizon_end - ctx.as_of });
      } catch (e) {
        failures.push(`seed ${seed} ${kind}: analyze бросил ${e.code ?? e.name}: ${e.message}`);
        continue;
      }
      for (const mode of MODES) {
        assert.deepEqual(c2.series[mode], ctx.series[mode], `seed ${seed} ${kind} ${mode} series`);
        assert.deepEqual(c2.q1[mode], ctx.q1[mode], `seed ${seed} ${kind} ${mode} q1`);
        assert.deepEqual(list_waves(c2, mode), list_waves(ctx, mode), `seed ${seed} ${kind} ${mode} волны`);
      }
    }
  }
  assert.deepEqual(failures, [], 'нулевое событие должно быть либо отвергнуто валидацией везде, либо нейтрально везде');
});

test('B-41 свойство: удаление события из набора = оракул без этого события (leave-one-out на случайных данных: trough/close/free)', () => {
  for (const seed of SEEDS.slice(0, 50)) {
    const { ctx, ws, cfg, rng } = the_case(seed);
    if (ws.plans.length === 0) continue;
    const k = rng.int(0, ws.plans.length - 1);
    const id = ws.plans[k].plan_id;
    const w2 = structuredClone(ws);
    w2.plans.splice(k, 1);
    const c2 = analyze(w2, { as_of: w2.as_of, horizon_days: ctx.horizon_end - ctx.as_of });
    // sinking: его график не зависит от платежей → оракул тот же; уберём событие из конфигурации
    const cfg2 = { ...cfg, events: cfg.events.filter((e) => e.id !== id) };
    for (const mode of MODES) {
      const m = naive_model(cfg2, mode);
      assert.deepEqual(c2.series[mode].trough, m.trough, `seed ${seed} -${id} ${mode} trough`);
      assert.deepEqual(c2.series[mode].free, m.free, `seed ${seed} -${id} ${mode} free`);
    }
  }
});

test('B-42 волны на случайных данных: состав, итоги, окно, cash_w, R_w, need, gap, coverage_pm, reserved = наивный оракул (D-09/D-10), в обоих режимах', () => {
  for (const seed of SEEDS) {
    const { ctx, B, naive } = the_case(seed);
    const theta = ctx.params['wave.threshold_minor'];
    for (const mode of MODES) {
      const m = naive[mode];
      const exp = naive_waves(m, 3, 10, theta);
      const got = list_waves(ctx, mode);
      assert.equal(got.length, exp.length, `seed ${seed} ${mode}: число волн`);
      got.forEach((it, i) => {
        const w = exp[i];
        assert.deepEqual([it.wave.start, it.wave.end, it.wave.total_out_minor, [...it.wave.event_ids]], [w.start, w.end, w.total, w.ids], `seed ${seed} ${mode} волна ${i}`);
        const o = naive_wave_metrics(m, w, B);
        if (o.need < 1) return;
        assert.deepEqual(
          [it.metrics.window_end, it.metrics.cash_minor, it.metrics.min_trough.date, it.metrics.min_trough.amount_minor, it.metrics.r_minor, it.metrics.need_minor, it.metrics.gap_minor, it.metrics.coverage_pm, it.metrics.reserved_minor],
          [o.window_end, o.cash, o.min_date, o.min, o.R, o.need, o.gap, o.cov, o.reserved],
          `seed ${seed} ${mode} метрики волны ${i}`,
        );
      });
    }
  }
});

test('B-43 свойство D-04/D-10: состав волн в plan и worse совпадает (обязательства даты не сдвигают); gap_w = max(0, B − min trough в окне)', () => {
  for (const seed of SEEDS) {
    const { ctx } = the_case(seed);
    const key = (mode) => list_waves(ctx, mode).map((x) => JSON.stringify([x.wave.start, x.wave.end, x.wave.event_ids, x.wave.total_out_minor]));
    assert.deepEqual(key('plan'), key('worse'), `seed ${seed}`);
  }
});

test('B-44 Q1 на случайных данных: min/at/ok/first_breach/first_buffer_breach/need/close_on_D = оракул для 4 дат D; min не возрастает с ростом D; runway_days = оракул', () => {
  for (const seed of SEEDS) {
    const { ctx, B, naive } = the_case(seed);
    const N = ctx.horizon_end - ctx.as_of + 1;
    for (const mode of MODES) {
      let prev = Infinity;
      for (const di of [0, Math.floor(N / 4), Math.floor(N / 2), N - 1]) {
        const Dd = ctx.as_of + di;
        const got = answer_q1(ctx.series[mode], Dd, B);
        const exp = naive_q1(naive[mode], Dd, B);
        assert.deepEqual(got, exp, `seed ${seed} ${mode} D+${di}`);
        assert.ok(got.min <= prev, `seed ${seed} ${mode}: min trough вырос с ростом D`);
        prev = got.min;
      }
      // runway
      const m = naive[mode];
      const fneg = (tr) => { const i = tr.findIndex((x) => x < 0); return i < 0 ? null : { date: ctx.as_of + i, days: i }; };
      const only_out = naive_model({ ...naive_cfg_of(seed), events: naive_cfg_of(seed).events.filter((e) => e.amt < 0) }, mode);
      const rw = runway_days(ctx.series[mode], ctx.events[mode]);
      assert.deepEqual(rw, { with: fneg(m.trough), without: fneg(only_out.trough) }, `seed ${seed} ${mode} runway`);
    }
  }
});
function naive_cfg_of(seed) { return the_case(seed).cfg; }

test('B-45 метаморфика: сдвиг opening на Δ сдвигает close/trough/free ровно на Δ, S_max и STS растут на Δ при выполненном буфере, R_w и состав волн не меняются', () => {
  for (const seed of SEEDS.slice(0, 60)) {
    const { ctx, ws, B } = the_case(seed);
    const delta = 123457;
    const w2 = structuredClone(ws);
    w2.anchors[0].amount_minor += delta;
    const c2 = analyze(w2, { as_of: w2.as_of, horizon_days: ctx.horizon_end - ctx.as_of });
    c2.readiness = { score: 4, level: 'full', reasons: [] };
    for (const mode of MODES) {
      ['close', 'trough', 'free'].forEach((k) => assert.deepEqual(c2.series[mode][k], ctx.series[mode][k].map((x) => x + delta), `seed ${seed} ${mode} ${k}`));
      assert.deepEqual(c2.series[mode].reserve_trough, ctx.series[mode].reserve_trough);
      const a = list_waves(ctx, mode);
      const b = list_waves(c2, mode);
      assert.equal(a.length, b.length);
      a.forEach((x, i) => {
        assert.equal(b[i].metrics.r_minor, x.metrics.r_minor, `seed ${seed}: R_w не зависит от остатка`);
        assert.deepEqual(b[i].wave, x.wave);
        assert.equal(b[i].metrics.gap_minor, Math.max(0, x.metrics.gap_minor - delta));
      });
      const s1 = max_amount(ctx, ctx.as_of, B, mode);
      const s2 = max_amount(c2, ctx.as_of, B, mode);
      if (Math.min(...ctx.series[mode].free) >= B) assert.equal(s2, s1 + delta, `seed ${seed} ${mode} S_max`);
      else assert.ok(s2 >= s1);
    }
  }
});

test('B-46 метаморфика: префикс-инвариантность горизонта — ряды при горизонте h1 = префикс рядов при h2 > h1 (close, trough, reserve_*, free) для обоих режимов', () => {
  for (const seed of SEEDS.slice(0, 70)) {
    const { ctx, ws, horizon_days } = the_case(seed);
    const h2 = horizon_days + 37;
    const c2 = analyze(ws, { as_of: ws.as_of, horizon_days: h2 });
    for (const mode of MODES) {
      for (const k of ['close', 'trough', 'reserve_trough', 'reserve_close', 'free']) {
        assert.deepEqual(c2.series[mode][k].slice(0, horizon_days + 1), ctx.series[mode][k], `seed ${seed} ${mode} ${k}`);
      }
    }
  }
});

test('B-47 буфер: query.buffer_minor перекрывает params.buffer_minor ровно так же, как правка params (N6, §14 B3); STS убывает по B на ΔB, пока min free − B ≥ 0', () => {
  for (const seed of SEEDS.slice(0, 40)) {
    const { ctx, ws } = the_case(seed);
    const hd = ctx.horizon_end - ctx.as_of;
    const w2 = structuredClone(ws);
    w2.params.buffer_minor = 77700;
    const c1 = analyze(w2, { as_of: ws.as_of, horizon_days: hd });
    const c2 = analyze(ws, { as_of: ws.as_of, horizon_days: hd, buffer_minor: 77700 });
    assert.equal(c2.buffer_minor, 77700);
    for (const mode of MODES) {
      assert.deepEqual(c2.series[mode], c1.series[mode]);
      assert.deepEqual(c2.q1[mode], c1.q1[mode]);
    }
    for (const mode of MODES) {
      const mf = Math.min(...ctx.series[mode].free);
      const s0 = safe_to_spend({ ...ctx, buffer_minor: 0 }, ctx.horizon_end, 0, mode).sts;
      const s1 = safe_to_spend({ ...ctx, buffer_minor: 1000 }, ctx.horizon_end, 1000, mode).sts;
      assert.equal(s0, Math.max(0, mf));
      assert.equal(s1, Math.max(0, mf - 1000));
    }
  }
});

test('B-48 STS: монотонность по T (не возрастает), short_to_buffer = max(0, B − min_free), sts > 0 ⇒ short_to_buffer = 0, Σ breakdown = min_free − B — на случайных данных', () => {
  for (const seed of SEEDS) {
    const { ctx, B, naive } = the_case(seed);
    const N = ctx.horizon_end - ctx.as_of + 1;
    for (const mode of MODES) {
      let prev = Infinity;
      for (const di of [0, Math.floor(N / 3), Math.floor((2 * N) / 3), N - 1]) {
        const r = safe_to_spend(ctx, ctx.as_of + di, B, mode);
        const mf = Math.min(...naive[mode].free.slice(0, di + 1));
        assert.equal(r.min_free, mf, `seed ${seed} ${mode} D+${di} min_free`);
        assert.equal(r.sts, Math.max(0, mf - B));
        assert.equal(r.short_to_buffer, Math.max(0, B - mf));
        assert.ok(r.sts === 0 || r.short_to_buffer === 0);
        assert.ok(r.sts <= prev, `seed ${seed} ${mode}: STS растёт с T`);
        prev = r.sts;
        const sum = sts_breakdown(ctx, ctx.as_of + di, B, mode).reduce((s, x) => s + x.v, 0);
        assert.equal(sum, mf - B, `seed ${seed} ${mode} D+${di}: Σ breakdown`);
      }
    }
  }
});

test('B-49 sinking на случайных данных: сумма взносов в горизонте не превышает цели; взносы не уменьшают close; reserve_close RES-S не превышает target без платежей (инвариант D-18)', () => {
  for (const seed of SEEDS) {
    const { ctx, ws, cfg } = the_case(seed);
    const r = ws.reserves.find((x) => x.reserve_id === 'RES-S');
    if (!r) continue;
    const by = ctx.reserve.plan.by_reserve['RES-S'];
    const contributed = by.contributed.reduce((s, x) => s + x, 0);
    const need = Math.max(0, r.target_minor - r.funded_start_minor);
    assert.ok(contributed <= need, `seed ${seed}: взносов ${contributed} > цели ${need}`);
    assert.equal(contributed, cfg.contribs.reduce((s, c) => s + c.amt, 0), `seed ${seed}: взносы = оракул`);
    // для режима refill_to_target без пропущенных дат сумма взносов до срока ровно закрывает цель (если срок в горизонте и даты есть)
    const due = D(r.due_date);
    if (due <= ctx.horizon_end && need > 0 && cfg.contribs.length > 0) assert.equal(contributed, need, `seed ${seed}: график должен закрыть цель ровно`);
  }
});

test('B-50 прошедшие плановые записи и якорь старше as_of (D-04, D-22 C-004): вхождение между якорем и as_of считается на as_of; до якоря — не входит; в worse доход сдвигается от as_of', () => {
  // якорь 2026-10-01 = 100000; as_of = 2026-10-04. Плановые: расход −1000 на 10-02 (между якорем и as_of → считается на as_of);
  // расход −2000 на 09-29 (до якоря — учтён в якоре → не входит); доход +50000 на 10-03 (в пределах grace 3 дн.) → на as_of, в worse — на as_of+14.
  const ws = structuredClone(load('g001.json'));
  ws.rules = [];
  ws.streams = [];
  ws.tax_rules = [];
  ws.reserves = [];
  ws.facts = [];
  ws.anchors = [{ anchor_id: 'a1', account_id: 'acc_main', date: '2026-10-01', amount_minor: 100000 }];
  const mk = (id, date, amt) => ({ plan_id: id, account_id: 'acc_main', name: id, date, amount_minor: amt, currency: 'EUR', kind: amt < 0 ? 'expense' : 'income', tag: 'x', is_obligation: false, is_estimate: false });
  ws.plans = [mk('late-exp', '2026-10-02', -1000), mk('before-anchor', '2026-09-29', -2000), mk('late-inc', '2026-10-03', 50000)];
  const ctx = analyze(ws, { as_of: '2026-10-04', horizon_days: 20 });
  const d0 = (mode) => ctx.events[mode].map((e) => [e.cash_event_id, fmt(e.date)]).sort();
  assert.deepEqual(d0('plan'), [['late-exp', '2026-10-04'], ['late-inc', '2026-10-04']], 'plan: прошлые вхождения считаются на as_of, вхождение до якоря не входит');
  assert.deepEqual(d0('worse'), [['late-exp', '2026-10-04'], ['late-inc', '2026-10-18']], 'worse: доход = base(e) + 14 = as_of + 14');
  assert.equal(ctx.series.plan.opening_minor, 100000);
  assert.equal(ctx.series.plan.trough[0], 99000);
  assert.equal(ctx.series.plan.close[0], 149000);
  assert.equal(ctx.series.worse.close[0], 99000);
  assert.equal(ctx.series.worse.close[14], 149000);
});

test('B-51 события на границах: плановая запись на as_of входит в день 0 (расход раньше дохода), на horizon_end — входит, на horizon_end+1 — нет; доход в worse, уходящий за горизонт, выпадает из ряда', () => {
  const ws = structuredClone(load('g001.json'));
  ws.rules = []; ws.streams = []; ws.tax_rules = []; ws.reserves = []; ws.facts = [];
  ws.anchors = [{ anchor_id: 'a1', account_id: 'acc_main', date: '2026-10-04', amount_minor: 10000 }];
  const mk = (id, date, amt) => ({ plan_id: id, account_id: 'acc_main', name: id, date, amount_minor: amt, currency: 'EUR', kind: amt < 0 ? 'expense' : 'income', tag: 'x', is_obligation: false, is_estimate: false });
  ws.plans = [mk('d0-out', '2026-10-04', -3000), mk('d0-in', '2026-10-04', 500), mk('last', '2026-10-14', -700), mk('beyond', '2026-10-15', -999), mk('inc-edge', '2026-10-01', 111)];
  ws.params['worse.income_delay_days'] = 2;
  const ctx = analyze(ws, { as_of: '2026-10-04', horizon_days: 10 }); // horizon_end = 10-14
  const p = ctx.series.plan;
  assert.equal(p.trough[0], 7000, 'расход раньше дохода внутри дня');
  assert.equal(p.close[0], 7500);
  assert.equal(p.close[10], 7500 - 700, '10-14 (горизонт) включён, 10-15 — нет');
  assert.equal(ctx.events.plan.some((e) => e.cash_event_id === 'beyond'), false);
  // доход d0-in: в worse на 10-06
  assert.equal(ctx.series.worse.close[0], 7000);
  assert.equal(ctx.series.worse.close[2], 7500);
});

test('B-52 гейт D-11/C-018: отказ при readiness < 4, при буфере null, при stale-якоре (block), при disabled-правиле; явный буфер 0 — «задан»; Q1 и волны гейтом не блокируются', () => {
  const ctx = run(load('g001.json'));
  assert.equal(gate(ctx, null), null);
  assert.equal(gate({ ...ctx, readiness: { score: 3 } }, 50000).reason, 'readiness');
  assert.equal(gate({ ...ctx, buffer_minor: null }, null).reason, 'no_buffer');
  assert.equal(gate({ ...ctx, buffer_minor: null }, 0), null, 'буфер вызова 0 перекрывает null (N6)');
  assert.equal(gate({ ...ctx, buffer_minor: 0 }, null), null, 'явный 0 — «задан»');
  assert.equal(gate({ ...ctx, rule_status: { 'TR-20': 'disabled' } }, 50000).reason, 'rule_disabled');
  assert.equal(gate({ ...ctx, rule_status: { 'TR-20': 'stale' } }, 50000), null, 'stale — плашка, не отказ');
  assert.equal(gate({ ...ctx, anchor_status: { level: 'block', reason: 'no_anchor' } }, 50000).reason, 'no_anchor');
  assert.equal(gate({ ...ctx, anchor_status: { level: 'banner' } }, 50000), null);
  // stale-якорь по данным: якорь 2026-09-10 (age 24 > 21) → вердикт отказывает, Q1 есть
  const ws = structuredClone(load('g001.json'));
  ws.anchors = [{ anchor_id: 'a', account_id: 'acc_main', date: '2026-09-10', amount_minor: 400000 }];
  ws.facts = [];
  const c2 = run(ws);
  assert.equal(c2.anchor_status.level, 'block');
  assert.equal(check_purchase(c2, treadmill(30000), null).kind, 'insufficient_data');
  assert.equal(safe_to_spend(c2, HZ, null, 'worse').kind, 'insufficient_data');
  assert.ok(c2.q1.plan.min !== undefined, 'Q1 не блокируется гейтом');
  assert.ok(list_waves(c2, 'plan').length >= 1, 'волны не блокируются гейтом');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 4. ДОПОЛНИТЕЛЬНО: сценарии (D-14), explain, горизонт 180 по независимой развёртке, матчинг (D-06), векторы §9.2/§9.11–§9.13
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** Применить операции сценария к конфигурации оракула (семантика D-14 / ALG-02, написана заново). */
function naive_apply_ops(cfg, ops) {
  let evs = cfg.events.map((e) => ({ ...e }));
  let n = 0;
  for (const op of ops) {
    n += 1;
    if (op.op === 'add_purchase') {
      op.parts.forEach((p, k) => evs.push({ id: `scn${n}#${k}`, date: D(p.date), amt: -p.amount_minor, kind: 'expense', tag: 'purchase', oblig: false, est: false, reserve: null }));
    } else if (op.op === 'add_flow') {
      evs.push({ id: `scn${n}`, date: D(op.once.date), amt: op.once.amount_minor, kind: op.once.amount_minor > 0 ? 'income' : 'expense', tag: 'flow', oblig: false, est: false, reserve: null });
    } else if (op.op === 'delay_income' || op.op === 'shift_flow') {
      for (const e of evs) if (e.id === op.event_ref) e.date += op.days;
    } else if (op.op === 'set_amount') {
      for (const e of evs) if (e.id === op.event_ref) e.amt = op.amount_minor;
    } else if (op.op === 'remove_flow') {
      evs = evs.filter((e) => e.id !== op.event_ref);
    } else throw new Error('oracle: op ' + op.op);
  }
  return { ...cfg, events: evs };
}

test('B-60 фаззинг сценариев (D-14, C-009): ряды plan/worse с операциями delay_income / shift_flow / set_amount / remove_flow / add_purchase / add_flow = оракул, правящий данные ДО режима', () => {
  for (const seed of SEEDS.slice(0, 120)) {
    const { ctx, ws, cfg, rng } = the_case(seed);
    const hz = ctx.horizon_end;
    const visible = cfg.events.filter((e) => e.date <= hz); // спецификация (ALG-02): сценарий правит события окна
    const ops = [];
    const used = new Set();
    const pick = (pred) => { const c = visible.filter((e) => pred(e) && !used.has(e.id)); if (c.length === 0) return null; const e = rng.pick(c); used.add(e.id); return e; };
    const nops = rng.int(1, 4);
    for (let k = 0; k < nops; k++) {
      const kind = rng.pick(['delay', 'shift', 'set', 'remove', 'purchase', 'flow']);
      if (kind === 'delay') { const e = pick((x) => x.kind === 'income'); if (e) ops.push({ op: 'delay_income', event_ref: e.id, days: rng.int(0, 20) }); }
      if (kind === 'shift') { const e = pick(() => true); if (e) ops.push({ op: 'shift_flow', event_ref: e.id, days: rng.int(-10, 15) }); }
      if (kind === 'set') { const e = pick(() => true); if (e) ops.push({ op: 'set_amount', event_ref: e.id, amount_minor: (e.amt < 0 ? -1 : 1) * rng.int(1, 200000) }); }
      if (kind === 'remove') { const e = pick(() => true); if (e) ops.push({ op: 'remove_flow', event_ref: e.id }); }
      if (kind === 'purchase') ops.push({ op: 'add_purchase', parts: [{ date: fmt(ctx.as_of + rng.int(0, hz - ctx.as_of)), amount_minor: rng.int(1, 150000) }] });
      if (kind === 'flow') ops.push({ op: 'add_flow', once: { date: fmt(ctx.as_of + rng.int(0, hz - ctx.as_of)), amount_minor: rng.pick([-1, 1]) * rng.int(1, 120000) } });
    }
    if (ops.length === 0) continue;
    const c2 = analyze(ws, { as_of: ws.as_of, horizon_days: hz - ctx.as_of, scenario: { scenario_id: 'fz', name: 'fz', ops } });
    const cfg2 = naive_apply_ops(cfg, ops);
    for (const mode of MODES) {
      const m = naive_model(cfg2, mode);
      assert.deepEqual(c2.series[mode].trough, m.trough, `seed ${seed} ${mode} trough; ops ${JSON.stringify(ops)}`);
      assert.deepEqual(c2.series[mode].close, m.close, `seed ${seed} ${mode} close; ops ${JSON.stringify(ops)}`);
      assert.deepEqual(c2.series[mode].free, m.free, `seed ${seed} ${mode} free; ops ${JSON.stringify(ops)}`);
    }
  }
});

test('B-61 D-14/C-009 композиция: delay_income 14 в plan = ряд worse; delay_income 7 в worse = delay_income 21 в plan (7 + 14 = 21); аддитивность покупки: ряды trough/close/free минус cum', () => {
  const g = load('g001.json');
  const base = run(g);
  const sc = (days) => ({ scenario_id: 'd', name: 'd', ops: [{ op: 'delay_income', event_ref: 'S-HOURLY@2026-11-05', days }] });
  const a = run(g, { scenario: sc(14) });
  for (const k of ['trough', 'close', 'free', 'reserve_trough']) assert.deepEqual(a.series.plan[k], base.series.worse[k], `plan+14 = worse: ${k}`);
  const b = run(g, { scenario: sc(7) });
  const c = run(g, { scenario: sc(21) });
  for (const k of ['trough', 'close', 'free']) assert.deepEqual(b.series.worse[k], c.series.plan[k], `worse+7 = plan+21: ${k}`);
  assert.equal(b.events.worse.find((e) => e.kind === 'income').date, D('2026-11-26'), '7 + 14 = 21 день: 11-05 → 11-26');
  // аддитивность: покупка 30000 на 10-12 и 5000 на 11-01
  const parts = [{ date: '2026-10-12', amount_minor: 30000 }, { date: '2026-11-01', amount_minor: 5000 }];
  const p = run(g, { scenario: { scenario_id: 'p', name: 'p', ops: [{ op: 'add_purchase', parts }] } });
  for (const mode of MODES) {
    const cum = base.series[mode].close.map((_, i) => parts.filter((x) => D(x.date) <= AS_OF + i).reduce((s, x) => s + x.amount_minor, 0));
    for (const k of ['trough', 'close', 'free']) assert.deepEqual(p.series[mode][k], base.series[mode][k].map((x, i) => x - cum[i]), `${mode} ${k}`);
    assert.deepEqual(p.series[mode].reserve_trough, base.series[mode].reserve_trough, 'покупка резервов не меняет');
  }
  const one = run(g, { scenario: { scenario_id: 'p1', name: 'p1', ops: [{ op: 'add_purchase', parts: [parts[0]] }] } });
  assert.equal(Math.min(...one.series.plan.free), 63500);
  assert.equal(Math.min(...one.series.worse.free), 41000);
});

test('B-62 explain на случайных данных: peak − point = out_total − inflow_offset; суммы окна = оракул; Σ цепочки ≤ out_total; контрфакты не ухудшают минимум; point — первая точка минимума trough', () => {
  for (const seed of SEEDS) {
    const { ctx, naive } = the_case(seed);
    for (const mode of MODES) {
      const x = explain_narrowest(ctx.events[mode], ctx.series[mode], ctx.params);
      const m = naive[mode];
      const k = argmin(m.trough, 0, m.N - 1);
      assert.deepEqual([x.point.date, x.point.amount_minor], [m.as_of + k, m.trough[k]], `seed ${seed} ${mode} point`);
      assert.equal(x.peak.amount_minor - x.point.amount_minor, x.out_total_minor - x.inflow_offset_minor, `seed ${seed} ${mode} инвариант`);
      assert.ok(x.peak.date <= x.point.date && x.peak.amount_minor >= x.point.amount_minor);
      // независимый пик: максимум среди opening (дата as_of) и close[0..k−1]; при равенстве — раньше
      let pv = m.opening;
      let pk = -1;
      for (let j = 0; j < k; j++) if (m.close[j] > pv) { pv = m.close[j]; pk = j; }
      assert.deepEqual([x.peak.date, x.peak.amount_minor], [m.as_of + Math.max(pk, 0), pv], `seed ${seed} ${mode} peak`);
      const w0 = m.as_of + pk + 1;
      const out = m.evs.filter((e) => e.amt < 0 && e.eff >= w0 && e.eff <= m.as_of + k).reduce((s, e) => s - e.amt, 0);
      const inn = m.evs.filter((e) => e.amt > 0 && e.eff >= w0 && e.eff < m.as_of + k).reduce((s, e) => s + e.amt, 0);
      assert.equal(x.out_total_minor, out, `seed ${seed} ${mode} out_total`);
      assert.equal(x.inflow_offset_minor, inn, `seed ${seed} ${mode} inflow_offset`);
      assert.ok(x.chain.reduce((s, c) => s + c.amount_minor, 0) <= x.out_total_minor);
      for (let i = 1; i < x.chain.length; i++) assert.ok(x.chain[i - 1].amount_minor >= x.chain[i].amount_minor, 'цепочка по убыванию');
      for (const c of x.counterfactuals) assert.ok(c.delta_minor >= 0 && c.new_min.amount_minor >= x.point.amount_minor, `seed ${seed} ${mode}: контрфакт ухудшил минимум`);
    }
  }
});

test('B-63 чистота: рабочая область, замороженная целиком, обрабатывается без исключения и не мутируется; ctx не мутируется вызовами afford/waves/Q1; повторный analyze даёт тот же результат', () => {
  const deep_freeze = (x) => { if (x !== null && typeof x === 'object' && !Object.isFrozen(x)) { Object.freeze(x); for (const k of Object.keys(x)) deep_freeze(x[k]); } return x; };
  for (const name of ['g001.json', 'g001-low.json', 'g001-gap.json', 'g001-late.json']) {
    const ws = load(name);
    const copy = structuredClone(ws);
    deep_freeze(ws);
    const c1 = run(ws);
    assert.deepEqual(ws, copy, 'ws не изменён');
    const c2 = run(ws);
    assert.deepEqual(c1, c2, 'детерминизм: два вызова — один результат (включая inputs_hash)');
    const before = structuredClone(c1);
    check_purchase(c1, treadmill(30000), null);
    safe_to_spend(c1, HZ, null, 'worse');
    max_amount(c1, AS_OF, B0, 'plan');
    earliest_date(c1, 1000, AS_OF, B0, 'worse');
    list_waves(c1, 'plan');
    list_waves(c1, 'worse');
    sts_breakdown(c1, HZ, null, 'plan');
    explain_narrowest(c1.events.worse, c1.series.worse, c1.params);
    answer_q1(c1.series.plan, HZ, B0);
    assert.deepEqual(c1, before, 'ctx не изменён функциями потребителей');
  }
  for (const seed of SEEDS.slice(0, 30)) {
    const { ws, horizon_days } = the_case(seed);
    const w = structuredClone(ws);
    deep_freeze(w);
    analyze(w, { as_of: w.as_of, horizon_days });
  }
});

test('B-64 inputs_hash (D-21): 64 hex-знака; меняется при изменении суммы на 1 minor, даты, буфера, ставки, якоря, горизонта, набора режимов, as_of; не меняется при перестановке ключей ws', () => {
  const g = load('g001.json');
  const h0 = run(g).inputs_hash;
  assert.match(h0, /^[0-9a-f]{64}$/);
  assert.equal(run(g).inputs_hash, h0);
  const mut = (f) => { const w = structuredClone(g); f(w); return run(w).inputs_hash; };
  assert.notEqual(mut((w) => { w.plans[0].amount_minor -= 1; }), h0, 'сумма ±1');
  assert.notEqual(mut((w) => { w.plans[0].date = '2026-10-22'; }), h0, 'дата');
  assert.notEqual(mut((w) => { w.params.buffer_minor = 50001; }), h0, 'буфер');
  assert.notEqual(mut((w) => { w.tax_rules[0].rate_bp = 2001; }), h0, 'ставка');
  assert.notEqual(mut((w) => { w.anchors[1].amount_minor += 1; }), h0, 'якорь');
  assert.notEqual(run(g, { horizon_days: 56 }).inputs_hash, h0, 'горизонт');
  assert.notEqual(run(g, { buffer_minor: 1 }).inputs_hash, h0, 'буфер вызова');
  assert.notEqual(run(g, { modes: ['plan'] }).inputs_hash, h0, 'набор режимов');
  assert.notEqual(analyze(g, { as_of: '2026-10-05', horizon_days: 57 }).inputs_hash, h0, 'as_of');
  const rev = Object.fromEntries(Object.entries(g).reverse());
  assert.equal(run(rev).inputs_hash, h0, 'порядок ключей ws не влияет');
});

test('B-65 D-12 T по умолчанию без ожидаемых поступлений = min(as_of + 30, horizon_end); при наличии дохода — ближайший доход режима (worse: +14, plan: 11-05)', () => {
  const g = structuredClone(load('g001.json'));
  g.streams = [];
  g.tax_rules = [];
  g.reserves = g.reserves.filter((r) => r.kind !== 'tax');
  g.plans = g.plans.map((p) => { const q = { ...p }; delete q.reserve_id; return q; });
  const c = run(g);
  assert.equal(default_sts_horizon(c), AS_OF + 30);
  const c10 = run(g, { horizon_days: 10 });
  assert.equal(default_sts_horizon(c10), AS_OF + 10);
  const c2 = run(load('g001.json'));
  assert.equal(default_sts_horizon(c2), D('2026-11-19'));
  assert.equal(default_sts_horizon(c2, AS_OF), D('2026-11-19'));
  const cp = run(load('g001.json'));
  cp.params = { ...cp.params, headline_mode: 'plan' };
  assert.equal(default_sts_horizon(cp), D('2026-11-05'), 'headline_mode = plan → 11-05');
});

test('B-66 горизонт 180 (X2) по независимой развёртке G-001: ряды plan/worse (close, trough, reserve_*, free) = наивный оракул с событиями до 2027-04-02', () => {
  const as_of = AS_OF;
  const hz = as_of + 180;
  const next = (d) => (dow(d) === 0 ? d + 1 : dow(d) === 6 ? d + 2 : d);
  const evs = [];
  const add = (id, d, amt, extra = {}) => { if (d >= as_of && d <= hz) evs.push({ id, date: d, amt, kind: amt < 0 ? 'expense' : 'income', tag: '', oblig: false, est: false, reserve: null, ...extra }); };
  const months = [[2026, 10], [2026, 11], [2026, 12], [2027, 1], [2027, 2], [2027, 3], [2027, 4]];
  for (const [y, m] of months) {
    add(`RENT@${y}-${m}`, next(dfc(y, m, 25)), -90000, { oblig: true, tag: 'аренда' });
    add(`UTIL@${y}-${m}`, next(dfc(y, m, 25)), -12000, { oblig: true, tag: 'жкх' });
    add(`PHONE@${y}-${m}`, next(dfc(y, m, 9)), -2500, { oblig: true, tag: 'связь' });
    const last = dfc(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1) - 1; // конец месяца периода
    add(`INC@${y}-${m}`, next(last + 5), 279000, { stream: 'S-HOURLY', tag: 'S-HOURLY' });
  }
  for (let d = as_of; d <= hz; d++) if (dow(d) === 6) add(`GROC@${d}`, d, -10000, { est: true, tag: 'продукты' });
  add('P-TAX1', D('2026-10-23'), -50000, { oblig: true, tag: 'налог', reserve: 'RES-TAX' });
  const contribs = ['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01', '2027-03-01'].map((d) => ({ res: 'RES-INS', date: D(d), amt: 12000 }));
  const cfg = { as_of, hz, opening: 400000, delay: 14, events: evs, tax: [{ res: 'RES-TAX', rate_bp: 2000, streams: ['S-HOURLY'] }], res0: { 'RES-TAX': 150000, 'RES-INS': 0 }, contribs };
  const ctx = analyze(load('g001.json'), { as_of: '2026-10-04', horizon_days: 180 });
  assert.equal(fmt(hz), '2027-04-02');
  for (const mode of MODES) {
    const m = naive_model(cfg, mode);
    for (const [k, v] of [['close', m.close], ['trough', m.trough], ['reserve_trough', m.rtrough], ['reserve_close', m.rclose], ['free', m.free]]) {
      assert.deepEqual(ctx.series[mode][k], v, `горизонт 180, ${mode}: ${k}`);
    }
  }
});

test('B-67 ручные правки волн (D-09/C-014): split перед событием, merge — состав и метрики = оракул; ссылка на исчезнувшее событие → W_OVERRIDE_STALE', () => {
  const g = load('g001.json');
  const mk = (ov) => { const w = structuredClone(g); w.wave_overrides = ov; return run(w); };
  const m = naive_model(g001_cfg(), 'plan');
  const metrics = (ids) => {
    const oid = (id) => id.replace('2026-10-25', '2026-10-26'); // у оракула id хранит эффективную дату, у движка — номинальную
    const es = m.evs.filter((e) => ids.map(oid).includes(e.id));
    const w = { start: Math.min(...es.map((e) => e.eff)), end: Math.max(...es.map((e) => e.eff)) };
    return naive_wave_metrics(m, w, B0);
  };
  const ids = (c) => list_waves(c, 'plan').map((x) => [...x.wave.event_ids]);
  const split = mk([{ override_id: 'o1', action: 'split', event_ids: ['R-RENT@2026-10-25'], seq: 1 }]);
  assert.deepEqual(ids(split), [['P-TAX1'], ['R-RENT@2026-10-25', 'R-UTIL@2026-10-25'], ['R-RENT@2026-11-25', 'R-UTIL@2026-11-25']]);
  const w1a = list_waves(split, 'plan')[0];
  const o1a = metrics(['P-TAX1']);
  assert.deepEqual([w1a.metrics.cash_minor, w1a.metrics.need_minor, w1a.metrics.window_end], [o1a.cash, o1a.need, o1a.window_end]);
  const w1b = list_waves(split, 'plan')[1];
  const o1b = metrics(['R-RENT@2026-10-25', 'R-UTIL@2026-10-25']);
  assert.deepEqual([w1b.metrics.cash_minor, w1b.metrics.need_minor, w1b.metrics.coverage_pm], [o1b.cash, o1b.need, o1b.cov]);
  const merge = mk([{ override_id: 'o2', action: 'merge', event_ids: ['R-RENT@2026-10-25', 'R-RENT@2026-11-25'], seq: 1 }]);
  const all5 = ['P-TAX1', 'R-RENT@2026-10-25', 'R-UTIL@2026-10-25', 'R-RENT@2026-11-25', 'R-UTIL@2026-11-25'];
  assert.deepEqual(ids(merge), [all5]);
  const wm = list_waves(merge, 'plan')[0];
  const om = metrics(all5);
  assert.deepEqual([wm.wave.total_out_minor, wm.metrics.cash_minor, wm.metrics.need_minor, wm.metrics.window_end], [254000, om.cash, om.need, om.window_end]);
  const stale = mk([{ override_id: 'o3', action: 'split', event_ids: ['NOPE'], seq: 1 }]);
  assert.ok(stale.warnings.some((w) => w.code === 'W_OVERRIDE_STALE'));
  assert.deepEqual(ids(stale), ids(run(g)), 'устаревшая правка состав не меняет');
});

test('B-68 §9.13 сопоставление план↔факт (окно 3 дня, tol 500 bp): −90000, −94500, −85500 → matched (план исчезает); −95000, −85000 → возможный двойник; −100000 → не сопоставлен; инвариант D-06: Δbalance = F − P', () => {
  const g = load('g001.json');
  const scen = (facts, as_of = '2026-11-28') => {
    const ws = structuredClone(g);
    ws.rules = [g.rules[0]]; ws.streams = []; ws.tax_rules = []; ws.reserves = []; ws.plans = []; ws.allocations = [];
    ws.anchors = [{ anchor_id: 'a', account_id: 'acc_main', date: '2026-11-20', amount_minor: 500000 }];
    ws.facts = facts.map((f, i) => ({ event_id: 'f' + i, account_id: 'acc_main', date: f[0], amount_minor: f[1], currency: 'EUR', kind: 'expense', tag: 'аренда' }));
    return analyze(ws, { as_of, horizon_days: 10 });
  };
  const none = scen([]);
  assert.deepEqual(none.events.plan.map((e) => [e.cash_event_id, e.status, fmt(e.date)]), [['R-RENT@2026-11-25', 'overdue', '2026-11-28']], 'без факта: просрочено, считается на as_of (D-04)');
  for (const [amt, matched] of [[-90000, true], [-94500, true], [-85500, true], [-95000, false], [-85000, false], [-100000, false]]) {
    const c = scen([['2026-11-27', amt]]);
    assert.equal(c.events.plan.length === 0, matched, `факт ${amt}: matched = ${matched}`);
    if (matched) {
      // D-06: при d ≥ max(F.date, as_of) баланс меняется ровно на F.amount − P.amount
      for (let i = 0; i < c.series.plan.close.length; i++) assert.equal(c.series.plan.close[i] - none.series.plan.close[i], amt - -90000, `Δ close[${i}] при факте ${amt}`);
    }
  }
  for (const d of ['2026-11-22', '2026-11-23', '2026-11-24', '2026-11-26', '2026-11-27', '2026-11-28']) {
    assert.equal(scen([[d, -90000]]).events.plan.length, 0, `факт ${d} в окне ±3 дн. от 11-25 → matched`);
  }
  assert.equal(scen([['2026-11-21', -90000]]).events.plan.length, 1, 'факт 11-21 — вне окна (4 дн.) → не сопоставлен');
  assert.equal(scen([['2026-11-27', -90000], ['2026-11-26', -90000]]).events.plan.length, 1, 'два кандидата → очередь подтверждения, автосопоставления нет');
});

test('B-69 §9.2 доход по часам: gross_pay (переработка, ничья округления), недоработка на 10-20, оценка по темпу, дата выплаты', async () => {
  const hourly = await import('../../engine/hourly.mjs');
  const { make_calendar } = await import('../../engine/dates.mjs');
  const g = load('g001.json');
  const s = g.streams[0];
  assert.equal(hourly.gross_pay(3000, 5580, null, 'half_even'), 279000);
  assert.equal(hourly.gross_pay(3000, 4800, null, 'half_even'), 240000);
  assert.equal(hourly.gross_pay(3000, 6600, null, 'half_even'), 330000);
  assert.equal(hourly.gross_pay(3000, 2760, { threshold_minutes: 2400, mult_bp: 15000 }, 'half_even'), 147000, '46 ч, порог 40 ч, ×1,5');
  assert.equal(hourly.gross_pay(3000, 2401, { threshold_minutes: 2400, mult_bp: 12500 }, 'half_even'), 120062);
  assert.equal(hourly.gross_pay(3000, 2401, { threshold_minutes: 2400, mult_bp: 12500 }, 'half_up'), 120063);
  const b = hourly.period_bounds(s, '2026-10-20');
  assert.deepEqual([fmt(b.start), fmt(b.end)], ['2026-10-01', '2026-10-31']);
  assert.equal(hourly.plan_to_date(s, b, '2026-10-20', { rounding: 'half_even' }), 3600);
  const sf = hourly.shortfall(s, b, '2026-10-20', 3120, { rounding: 'half_even' });
  assert.deepEqual([sf.short_minutes, sf.effect_minor, sf.est_minutes, sf.est_gross_minor], [480, 24000, 5100, 255000]);
  const cal = make_calendar({ weekend_dows: [0, 6], holidays: [] });
  assert.equal(fmt(hourly.pay_date(D('2026-10-31'), s, cal)), '2026-11-05');
  assert.equal(fmt(hourly.pay_date(D('2026-11-30'), s, cal)), '2026-12-07', '12-05 — суббота, сдвиг next');
});

test('B-70 §9.11–§9.12 векторы денег, sinking, налогов, FX, долга: независимый BigInt-расчёт совпадает с каноном и с движком', async () => {
  const money = await import('../../engine/money.mjs');
  const sink = await import('../../engine/sinking.mjs');
  const tax = await import('../../engine/tax.mjs');
  const fx = await import('../../engine/fx.mjs');
  const debt = await import('../../engine/debt.mjs');
  assert.deepEqual([1, 3, 5, 7].map((n) => money.round_div(n, 2, 'half_even')), [0, 2, 2, 4]);
  assert.deepEqual([-1, -3].map((n) => money.round_div(n, 2, 'half_even')), [0, -2]);
  assert.deepEqual([1, -1, 3, -3].map((n) => money.round_div(n, 2, 'half_up')), [1, -1, 2, -2]);
  assert.deepEqual(money.split_equal(110000, 6), [18334, 18334, 18333, 18333, 18333, 18333]);
  assert.deepEqual(money.split_equal(30000, 7), [4286, 4286, 4286, 4286, 4286, 4285, 4285]);
  assert.deepEqual(money.split_largest_remainder(37500, [12000, 4200, 21313]), [11996, 4198, 21306]);
  assert.equal(money.mul_div(3, 2999999999999999, 2, 'half_even'), 4499999999999998);
  assert.equal(he(3n * 2999999999999999n, 2n), 4499999999999998);
  assert.equal(money.mul_div(5, 1999999999999999, 4), 2499999999999999);
  assert.equal(money.parse_minor('-1.234,56', { decimal: ',', thousands: '.', exponent: 2 }), -123456);
  assert.equal(money.format_minor(-123456, 2, { decimal: ',', thousands: ' ' }), '-1 234,56');
  assert.throws(() => money.mul_div(9007199254740991, 2, 1), (e) => e.code === 'E_OVERFLOW');
  // sinking: отпуск и недостача fixed; пул
  const vac_dates = ['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01', '2027-03-01', '2027-04-01', '2027-05-01', '2027-06-01'].map(D);
  const rows = sink.contribution_plan({ target_minor: 180000, funded_open_minor: 9500, dates: vac_dates, mode: 'refill_to_target' });
  let rem = 170500;
  const naive_rows = [];
  for (let k = 0; k < 8; k++) { const c = Math.min(cdiv(rem, 8 - k), rem); naive_rows.push(c); rem -= c; }
  assert.deepEqual(naive_rows, [21313, 21313, 21313, 21313, 21312, 21312, 21312, 21312]);
  assert.deepEqual(rows.map((r) => r.amount_minor), naive_rows);
  assert.equal(rows.reduce((s, r) => s + r.amount_minor, 0), 170500);
  const fx_plan = sink.contribution_plan_fixed({ funded_open_minor: 9500, fixed_minor: 15000, dates: vac_dates, target_minor: 180000 });
  assert.equal(fx_plan.shortfall_minor, 50500, '95,00 + 8·150,00 = 1 295,00 €; недостача 505,00 €');
  assert.deepEqual(sink.pool_split(37500, [12000, 4200, 21313]), [11996, 4198, 21306]);
  // налоги
  const rule = { rate_bp: 2100, rounding: 'half_even', base: 'gross', kind: 'percent_of_income' };
  assert.equal(tax.allocation_for_income(123457, rule), 25926);
  assert.equal(he(123457n * 2100n, 10000n), 25926);
  assert.deepEqual(tax.release_on_payment(150000, 50000), { released: 50000, true_up: 0 });
  assert.deepEqual(tax.release_on_payment(30000, 50000), { released: 30000, true_up: 20000 });
  // FX
  assert.equal(fx.convert_minor(200000, 2, 2, 9250, 10000, 'half_even'), 185000);
  assert.equal(fx.convert_minor(150000, 8, 2, 50000, 1, 'half_even'), 7500);
  assert.deepEqual(fx.implied_rate(200000, 184240, 2, 2), { num: 2303, den: 2500 }, '184240/200000 = 0,9212 = 2303/2500');
  assert.equal(2303 / 2500, 0.9212);
  const sh = fx.apply_shock({ base: 'USD', quote: 'EUR', num: 9250, den: 10000, date: 0 }, -500);
  assert.equal(fx.convert_minor(200000, 2, 2, sh.num, sh.den, 'half_even'), 175750);
  // долг: независимый график аннуитета 1 200,00 €, 1 %/мес, 6 платежей
  assert.equal(debt.annuity_payment(120000, 1200, 6, 'half_even'), 20706);
  const sched = debt.amortization_schedule({ principal: 120000, rate_bp: 1200, n: 6, start: '2026-11-01', cadence: { freq: 'M', interval: 1 }, kind: 'annuity', rounding: 'half_even' });
  let bal = 120000;
  const exp_int = [];
  const exp_bal = [];
  for (let k = 0; k < 6; k++) {
    const i = he(BigInt(bal) * 100n, 10000n);
    const pay = k < 5 ? 20706 : bal + i;
    bal = bal + i - pay;
    exp_int.push(i);
    exp_bal.push(bal);
  }
  assert.deepEqual(exp_int, [1200, 1005, 808, 609, 408, 205]);
  assert.deepEqual(exp_bal, [100494, 80793, 60895, 40798, 20500, 0]);
  assert.deepEqual(sched.map((r) => r.interest_minor), exp_int);
  assert.deepEqual(sched.map((r) => r.balance_minor), exp_bal);
  assert.deepEqual(sched.map((r) => r.payment_minor), [20706, 20706, 20706, 20706, 20706, 20705]);
  assert.equal(exp_int.reduce((a, b) => a + b, 0), 4235);
  assert.deepEqual(debt.installment_parts(110000, 6), [18334, 18334, 18333, 18333, 18333, 18333]);
});

test('B-71 §9.4 TV3: first_buffer_breach варианта G-001-gap = 2026-10-23 (27500 < 50000), first_breach = 10-26; close[10-24] = 17500', () => {
  const ctx = run(variant_ws('gap'));
  const P = naive_model(variant_cfg('gap'), 'plan');
  const q = naive_q1(P, HZ, B0);
  assert.equal(fmt(q.first_buffer_breach), '2026-10-23');
  assert.equal(P.trough[D('2026-10-23') - AS_OF], 27500);
  assert.equal(fmt(q.first_breach), '2026-10-26');
  assert.equal(ctx.q1.plan.first_buffer_breach, D('2026-10-23'));
  assert.equal(ctx.q1.plan.first_breach, D('2026-10-26'));
  assert.equal(P.close[D('2026-10-24') - AS_OF], 17500);
});

// ── 4.1. Правила повторения в конвейере: независимая развёртка M/W правил + праздники + налог/релиз ─────────────────────────────

/** Календарь оракула. */
function naive_cal(weekend_dows, holidays) {
  const bus = (d) => !weekend_dows.includes(dow(d)) && !holidays.includes(d);
  const shift = (d, policy) => {
    if (policy === 'keep') return d;
    let x = d;
    if (policy === 'next') { while (!bus(x)) x++; return x; }
    if (policy === 'prev') { while (!bus(x)) x--; return x; }
    throw new Error('policy');
  };
  return { bus, shift };
}
const ymd = (z) => { const s = fmt(z); return [Number(s.slice(0, 4)), Number(s.slice(5, 7)), Number(s.slice(8, 10))]; };
const dim_of = (y, m) => dfc(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1) - dfc(y, m, 1);

/** Номинальные даты правила M (by_monthday = [v], clamp) или W (by_weekday = [w], Пн-недели) без `count`/`until`/`exdates`. */
function naive_nominals(rule, limit) {
  const start = D(rule.start_date);
  const out = [];
  if (rule.freq === 'M') {
    const [sy, sm] = ymd(start);
    for (let k = 0; k < 400; k++) {
      const t = sy * 12 + (sm - 1) + k * rule.interval;
      const y = Math.floor(t / 12);
      const m = (t % 12) + 1;
      const d = dfc(y, m, Math.min(rule.by_monthday[0], dim_of(y, m)));
      if (d > limit) break;
      if (d >= start) out.push(d);
    }
  } else {
    const monday = (d) => d - ((((dow(d) - 1) % 7) + 7) % 7);
    for (let k = 0; k < 400; k++) {
      const b = monday(start) + 7 * rule.interval * k;
      const d = b + ((((rule.by_weekday[0] - 1) % 7) + 7) % 7);
      if (b > limit) break;
      if (d >= start && d <= limit) out.push(d);
    }
  }
  return out;
}

test('B-72 фаззинг конвейера с правилами M/W (clamp, keep/next/prev, праздники, interval, выплата с налогом): ряды и волны движка = наивный оракул с независимой развёрткой дат', () => {
  let with_rules = 0;
  for (const seed of SEEDS.slice(0, 150)) {
    const base = the_case(seed);
    const rng = make_rng(seed * 104729 + 7);
    const { as_of, hz } = base.cfg;
    const holidays = Array.from({ length: rng.int(0, 3) }, () => as_of + rng.int(0, base.horizon_days));
    const cal = naive_cal([0, 6], holidays);
    const ws = structuredClone(base.ws);
    ws.calendars = [{ calendar_id: 'cal-main', name: 'cal', weekend_dows: [0, 6], holidays: holidays.map(fmt) }];
    const events = base.cfg.events.map((e) => ({ ...e }));
    const nr = rng.int(1, 3);
    for (let r = 0; r < nr; r++) {
      const income = rng.next() < 0.3;
      const freq = rng.pick(['M', 'M', 'W']);
      const start = as_of - rng.int(-20, 300);
      const rule = {
        rule_id: `R${r}`, version: 1, account_id: 'acc_main', name: `R${r}`, kind: income ? 'income' : 'expense',
        amount: { exp_minor: income ? rng.int(1000, 200000) : -rng.int(500, 60000) }, currency: 'EUR', freq, interval: freq === 'M' ? rng.pick([1, 1, 2, 3]) : rng.pick([1, 1, 2]),
        month_end: 'clamp', weekend: rng.pick(['keep', 'next', 'prev']), calendar_id: 'cal-main', exdates: [], start_date: fmt(start),
        is_obligation: rng.next() < 0.5, is_estimate: rng.next() < 0.2, tag: income ? 'work' : 'еда',
      };
      if (freq === 'M') rule.by_monthday = [rng.int(1, 31)]; else rule.by_weekday = [rng.int(0, 6)];
      ws.rules.push(rule);
      for (const n of naive_nominals(rule, hz + 40)) {
        const eff = cal.shift(n, rule.weekend);
        if (eff < as_of || eff > hz) continue;
        events.push({ id: `${rule.rule_id}@${fmt(n)}`, date: eff, amt: rule.amount.exp_minor, kind: rule.kind, tag: rule.tag, oblig: rule.is_obligation, est: rule.is_estimate, reserve: null, stream: null });
      }
    }
    with_rules++;
    const cfg = { ...base.cfg, events };
    const ctx = analyze(ws, { as_of: ws.as_of, horizon_days: base.horizon_days });
    for (const mode of MODES) {
      const m = naive_model(cfg, mode);
      const s = ctx.series[mode];
      assert.deepEqual(s.trough, m.trough, `seed ${seed} ${mode} trough; rules ${JSON.stringify(ws.rules.map((r) => [r.freq, r.interval, r.by_monthday ?? r.by_weekday, r.weekend, r.start_date]))} holidays ${holidays.map(fmt)}`);
      assert.deepEqual(s.close, m.close, `seed ${seed} ${mode} close`);
      assert.deepEqual(s.reserve_trough, m.rtrough, `seed ${seed} ${mode} reserve_trough`);
      assert.deepEqual(s.free, m.free, `seed ${seed} ${mode} free`);
      const theta = ctx.params['wave.threshold_minor'];
      const exp = naive_waves(m, 3, 10, theta);
      const got = list_waves(ctx, mode);
      assert.equal(got.length, exp.length, `seed ${seed} ${mode} волны`);
      got.forEach((it, i) => assert.deepEqual([it.wave.start, it.wave.end, it.wave.total_out_minor], [exp[i].start, exp[i].end, exp[i].total], `seed ${seed} ${mode} волна ${i}`));
    }
  }
  assert.equal(with_rules, 150);
});

// ── 4.2. Мультивалюта: spot на as_of ко всем событиям и остаткам (D-20, ALG-08 TV-5/TV-6) ───────────────────────────────────────

/** Рабочая область G-001 + счёт USD (операционный) с якорем 200000 и курсом 9250/10000 (иллюстрация ALG-08 TV-5). */
function g001_with_usd(extra_events = []) {
  const ws = structuredClone(load('g001.json'));
  ws.accounts.push({ account_id: 'acc_usd', name: 'USD', kind: 'bank', liquidity: 'operating', currency: 'USD', exponent: 2, liquidity_bp: 0, opened_on: '2026-01-01' });
  ws.anchors.push({ anchor_id: 'a-usd', account_id: 'acc_usd', date: '2026-10-04', amount_minor: 200000 });
  ws.rates = [{ fx_id: 'fx1', base: 'USD', quote: 'EUR', num: 9250, den: 10000, date: '2026-10-04' }];
  ws.plans.push(...extra_events);
  return ws;
}
const SHOCK_M5 = { scenario_id: 'shock', name: 'USD −5 %', ops: [{ op: 'fx_shock', currency: 'USD', bp: -500 }] };

test('B-73 ALG-08 TV-5 / D-20: сценарий fx_shock{USD, −500} применяется и к ОСТАТКУ счёта USD: opening = 400000 + 175750 = 575750, min trough = 381250 (Δ = −9250), end_close = 340000 + 175750', () => {
  const ws = g001_with_usd();
  const base = run(ws);
  assert.equal(base.series.plan.opening_minor, 585000, 'без шока: 400000 + 185000');
  assert.equal(Math.min(...base.series.plan.trough), 390500);
  assert.equal(base.series.plan.close.at(-1), 525000);
  const s = run(ws, { scenario: SHOCK_M5 });
  assert.equal(s.series.plan.opening_minor, 575750, 'остаток USD пересчитан по курсу × 9500/10000: 200000 · 0,87875 = 175750');
  assert.equal(Math.min(...s.series.plan.trough), 381250);
  assert.equal(s.series.plan.close.at(-1), 340000 + 175750);
  assert.equal(Math.min(...s.series.plan.trough) - Math.min(...base.series.plan.trough), -9250);
});

test('B-74a fx_shock к СОБЫТИЯМ в USD работает: −100000 USD при −5 % → −87875 EUR, без шока −92500', () => {
  const ws = g001_with_usd([{ plan_id: 'usd-exp', account_id: 'acc_usd', name: 'x', date: '2026-10-10', amount_minor: -100000, currency: 'USD', kind: 'expense', tag: 'x' }]);
  const s = run(ws, { scenario: SHOCK_M5 });
  assert.equal(s.events.plan.find((e) => e.cash_event_id === 'usd-exp').amount_minor, -87875, 'событие пересчитано по шоку');
  const b = run(ws);
  assert.equal(b.events.plan.find((e) => e.cash_event_id === 'usd-exp').amount_minor, -92500);
});

test('B-74b fx_shock: согласованность остатка и потока в одном сценарии — USD-остаток после платежа при шоке = (200000 − 100000) USD · 0,87875 = 87875 EUR (сейчас остаток не шокируется: 185000 − 87875 = 97125; см. B-73)', () => {
  const ws = g001_with_usd([{ plan_id: 'usd-exp', account_id: 'acc_usd', name: 'x', date: '2026-10-10', amount_minor: -100000, currency: 'USD', kind: 'expense', tag: 'x' }]);
  const s = run(ws, { scenario: SHOCK_M5 });
  const usd_after = s.series.plan.opening_minor - 400000 + s.events.plan.find((e) => e.cash_event_id === 'usd-exp').amount_minor;
  assert.equal(usd_after, 87875, 'остаток USD после платежа при шоке должен быть 100000 USD · 0,87875 = 87875 EUR');
});

test('B-75 фаззинг мультивалюты (USD exp 2, JPY exp 0; прямой и обратный курс; будущие и старые записи курса): ряды движка = наивная конвертация BigInt «один раз на событие», остаток каждого счёта — отдельно', () => {
  for (const seed of SEEDS.slice(0, 100)) {
    const base = the_case(seed);
    const rng = make_rng(seed * 31337 + 5);
    const { as_of, hz } = base.cfg;
    const ws = structuredClone(base.ws);
    // курсы: USD→EUR прямой (две записи: старая и новая ≤ as_of, плюс «из будущего»), JPY — только обратный EUR→JPY
    const usd_n = rng.int(7000, 12000);
    const jpy_den = rng.int(1, 5000);
    const jpy_num = rng.int(100, 20000); // 1 EUR = jpy_num/jpy_den JPY (в основных единицах)
    ws.rates = [
      { fx_id: 'a', base: 'USD', quote: 'EUR', num: usd_n + 500, den: 10000, date: fmt(as_of - 30) },
      { fx_id: 'b', base: 'USD', quote: 'EUR', num: usd_n, den: 10000, date: fmt(as_of - rng.int(0, 5)) },
      { fx_id: 'c', base: 'USD', quote: 'EUR', num: usd_n + 3000, den: 10000, date: fmt(as_of + 1) },
      { fx_id: 'd', base: 'EUR', quote: 'JPY', num: jpy_num, den: jpy_den, date: fmt(as_of - 2) },
    ];
    ws.accounts.push({ account_id: 'acc_usd', name: 'USD', kind: 'bank', liquidity: 'operating', currency: 'USD', exponent: 2, liquidity_bp: 0, opened_on: '2025-01-01' });
    ws.accounts.push({ account_id: 'acc_jpy', name: 'JPY', kind: 'bank', liquidity: 'operating', currency: 'JPY', exponent: 0, liquidity_bp: 0, opened_on: '2025-01-01' });
    const usd_open = rng.int(0, 300000);
    const jpy_open = rng.int(0, 5000000);
    ws.anchors.push({ anchor_id: 'a-usd', account_id: 'acc_usd', date: fmt(as_of), amount_minor: usd_open }, { anchor_id: 'a-jpy', account_id: 'acc_jpy', date: fmt(as_of), amount_minor: jpy_open });
    // конвертеры оракула (BigInt, независимая запись формулы §9.12/D-20)
    const usd = (a) => he(BigInt(a) * BigInt(usd_n) * 100n, 10000n * 100n);
    const jpy = (a) => he(BigInt(a) * BigInt(jpy_den) * 100n, BigInt(jpy_num) * 1n); // JPY→EUR = den/num, экспоненты 0 → 2
    const events = base.cfg.events.map((e) => ({ ...e }));
    const nplans = rng.int(1, 8);
    for (let i = 0; i < nplans; i++) {
      const cur = rng.pick(['USD', 'JPY']);
      const income = rng.next() < 0.3;
      const raw = income ? rng.int(1, cur === 'USD' ? 150000 : 3000000) : -rng.int(1, cur === 'USD' ? 100000 : 2000000);
      const date = as_of + rng.int(0, base.horizon_days);
      const id = `fx${i}`;
      ws.plans.push({ plan_id: id, account_id: cur === 'USD' ? 'acc_usd' : 'acc_jpy', name: id, date: fmt(date), amount_minor: raw, currency: cur, kind: income ? 'income' : 'expense', tag: 'gift', is_obligation: false, is_estimate: false });
      events.push({ id, date, amt: cur === 'USD' ? usd(raw) : jpy(raw), kind: income ? 'income' : 'expense', tag: 'gift', oblig: false, est: false, reserve: null, stream: null });
    }
    const cfg = { ...base.cfg, events, opening: base.cfg.opening + usd(usd_open) + jpy(jpy_open) };
    const ctx = analyze(ws, { as_of: ws.as_of, horizon_days: base.horizon_days });
    assert.equal(ctx.series.plan.opening_minor, cfg.opening, `seed ${seed}: opening = EUR + USD·курс + JPY·курс (каждый счёт округляется отдельно)`);
    for (const mode of MODES) {
      const m = naive_model(cfg, mode);
      assert.deepEqual(ctx.series[mode].trough, m.trough, `seed ${seed} ${mode} trough`);
      assert.deepEqual(ctx.series[mode].close, m.close, `seed ${seed} ${mode} close`);
      assert.deepEqual(ctx.series[mode].free, m.free, `seed ${seed} ${mode} free`);
    }
  }
});

test('B-76 ALG-08 TV-6: выбор курса — прямой ≤ as_of (10-01: 9100), обратный EUR→USD 10900/10000 (10-03, позже прямого) → выбран обратный; запись 10-10 (из будущего) игнорируется; 200000 USD → 183486 EUR', () => {
  const ws = g001_with_usd();
  ws.rates = [
    { fx_id: 'r1', base: 'USD', quote: 'EUR', num: 9250, den: 10000, date: '2026-08-20' },
    { fx_id: 'r2', base: 'USD', quote: 'EUR', num: 9100, den: 10000, date: '2026-10-01' },
    { fx_id: 'r3', base: 'EUR', quote: 'USD', num: 10900, den: 10000, date: '2026-10-03' },
    { fx_id: 'r4', base: 'USD', quote: 'EUR', num: 9300, den: 10000, date: '2026-10-10' },
  ];
  const ctx = run(ws);
  assert.equal(he(200000n * 10000n * 100n, 10900n * 100n), 183486);
  assert.equal(ctx.series.plan.opening_minor, 400000 + 183486);
  // порядок записей не влияет
  const rev = structuredClone(ws);
  rev.rates.reverse();
  assert.equal(run(rev).series.plan.opening_minor, 400000 + 183486);
  // без обратной пары: прямой 10-01 (9100) → 182000
  const w2 = structuredClone(ws);
  w2.rates = [ws.rates[0], ws.rates[1], ws.rates[3]];
  assert.equal(run(w2).series.plan.opening_minor, 400000 + 182000);
  // нет пары → E_NO_RATE
  const w3 = structuredClone(ws);
  w3.rates = [];
  assert.throws(() => run(w3), (e) => e.code === 'E_NO_RATE');
});

// ── 4.3. Монте-Карло/неопределённость как продолжение golden-чисел (§9.15) и свежесть курса (D-20, X11) ────────────────────────

test('B-77 §9.15 сквозной: наблюдения лага [0,3,7,5,14,6,2,9] → полный перебор n = 8; m_free = [71000,71000,81000,81000,81000,83500,83500,93500]; p_fail(30000, 50000) = 2/8; P10/P50/P90 = 71000/81000/93500; подача «в 2 из 8»', async () => {
  const mc = await import('../../engine/montecarlo.mjs');
  const g = load('g001.json');
  const ctx = run(g);
  const m = mc.mc_context(g, ctx, { lag_obs: { 'S-HOURLY': [0, 3, 7, 5, 14, 6, 2, 9] } });
  const P = mc.run_paths(m, 2000, { kinds: ['lag'] }, mc.make_seed('0.1.0', ctx.inputs_hash, 0));
  assert.equal(P.enumerated, true);
  assert.equal(P.n_paths, 8);
  assert.equal(P.n_eff, 8);
  assert.deepEqual([...P.m_free].sort((a, b) => a - b), [71000, 71000, 81000, 81000, 81000, 83500, 83500, 93500]);
  assert.deepEqual(mc.p_fail(P.m_free, 30000, 50000), { k: 2, n: 8 });
  assert.deepEqual([mc.q_alpha(P.m_free, 10), mc.q_alpha(P.m_free, 50), mc.q_alpha(P.m_free, 90)], [71000, 81000, 93500]);
  assert.deepEqual(mc.present_probability(2, P), { kind: 'count', k: 2, n: 8 });
  assert.deepEqual(P.p_gap_any, { k: 0, n: 8 });
});

test('B-78 порт evaluate Монте-Карло = ряды analyze: evaluate(events.plan) = series.plan и evaluate(events.worse) = series.worse (close, trough, free) на случайных данных с резервами', async () => {
  const mc = await import('../../engine/montecarlo.mjs');
  for (const seed of SEEDS.slice(0, 80)) {
    const { ctx, ws } = the_case(seed);
    const m = mc.mc_context(ws, ctx, {});
    for (const mode of MODES) {
      const ev = m.evaluate(ctx.events[mode]);
      assert.deepEqual(ev.close, ctx.series[mode].close, `seed ${seed} ${mode} close`);
      assert.deepEqual(ev.trough, ctx.series[mode].trough, `seed ${seed} ${mode} trough`);
      assert.deepEqual(ev.free, ctx.series[mode].free, `seed ${seed} ${mode} free`);
    }
  }
});

test('B-78b полный перебор лагов на случайных данных с одним доходом: m_free путей = min free по оракулу при задержке, равной лагу (мультимножество)', async () => {
  const mc = await import('../../engine/montecarlo.mjs');
  let checked = 0;
  for (const seed of SEEDS.slice(0, 120)) {
    const base = the_case(seed);
    const rng = make_rng(seed * 2711 + 3);
    const incomes = base.cfg.events.filter((e) => e.kind === 'income' && e.date <= base.hz);
    if (incomes.length === 0) continue;
    const keep = incomes[0];
    const ws = structuredClone(base.ws);
    ws.plans = ws.plans.filter((p) => p.amount_minor < 0 || p.plan_id === keep.id);
    const events = base.cfg.events.filter((e) => e.amt < 0 || e.id === keep.id);
    const ctx = analyze(ws, { as_of: ws.as_of, horizon_days: base.horizon_days });
    const lags = Array.from({ length: rng.int(2, 9) }, () => rng.int(0, 20));
    const m = mc.mc_context(ws, ctx, { lag_obs: { [keep.id]: lags } });
    const P = mc.run_paths(m, 2000, { kinds: ['lag'] }, 1);
    assert.equal(P.enumerated, true, `seed ${seed}`);
    const exp = lags.map((lag) => Math.min(...naive_model({ ...base.cfg, events, delay: lag }, 'worse').free));
    assert.deepEqual([...P.m_free].sort((a, b) => a - b), exp.sort((a, b) => a - b), `seed ${seed}: лаги ${JSON.stringify(lags)}`);
    checked++;
  }
  assert.ok(checked >= 40, `проверено только ${checked} случаев`);
});

test('B-79 D-20/X11/§2.0: курс spot старше fx.stale_days (30) → W_RATE_STALE в warnings расчёта; ровно 30 дней — нет; свежий — нет; расчёт не блокируется', () => {
  const at = (date) => { const w = g001_with_usd(); w.rates = [{ fx_id: 'fx1', base: 'USD', quote: 'EUR', num: 9250, den: 10000, date }]; return run(w); };
  const codes = (c) => c.warnings.map((w) => w.code);
  assert.ok(!codes(at('2026-10-04')).includes('W_RATE_STALE'), 'свежий курс');
  assert.ok(!codes(at('2026-09-04')).includes('W_RATE_STALE'), 'возраст ровно 30 дней — ещё не старше');
  assert.ok(codes(at('2026-09-03')).includes('W_RATE_STALE'), 'возраст 31 день — плашка');
  const old = at('2026-06-01');
  assert.ok(codes(old).includes('W_RATE_STALE'), 'возраст 125 дней — плашка');
  assert.equal(old.series.plan.opening_minor, 400000 + 185000, 'расчёт не блокируется');
});

// ── 4.4. as_of позже даты якоря: «прошлые» вхождения и «догон» sinking (D-04, C-004, D-18, C-030) ──────────────────────────────────

/** Взносы sinking «1-го числа» по D-18 от `as_of` (включительно) до срока (не включая); хвост после `hz` отбрасывается после расчёта. */
function naive_sink_contribs(spec, as_of, hz) {
  const dates = [];
  const [y0, m0] = ymd(as_of);
  for (let j = 0; j < 60; j++) {
    const yy = y0 + Math.floor((m0 - 1 + j) / 12);
    const mm = ((m0 - 1 + j) % 12) + 1;
    const d = dfc(yy, mm, 1);
    if (d >= spec.due) break;
    if (d >= as_of) dates.push(d);
  }
  const rows = [];
  let rem = spec.target - spec.funded;
  if (rem > 0) {
    for (let k = 0; k < dates.length; k++) {
      const c = Math.min(cdiv(rem, dates.length - k), rem);
      if (c > 0 && dates[k] <= hz) rows.push({ res: spec.res, date: dates[k], amt: c });
      rem -= c;
    }
  }
  return rows;
}

test('B-80 as_of позже даты якоря на k дней: вхождения между якорем и as_of считаются на as_of (D-04), в worse доход = as_of + delay; sinking пересчитан от as_of («догон»); ряды = оракул', () => {
  let checked = 0;
  for (const seed of SEEDS.slice(0, 120)) {
    const base = the_case(seed);
    const rng = make_rng(seed * 6007 + 11);
    const k = rng.int(1, 9);
    const anchor_day = base.cfg.as_of;
    const as_of = anchor_day + k;
    const hz = base.cfg.hz + k; // тот же горизонт_дней
    const ws = structuredClone(base.ws);
    const hd = base.horizon_days;
    ws.as_of = fmt(as_of);
    const spec = ws.reserves.find((r) => r.reserve_id === 'RES-S');
    const contribs = spec ? naive_sink_contribs({ res: 'RES-S', target: spec.target_minor, funded: spec.funded_start_minor, due: D(spec.due_date) }, as_of, hz) : [];
    const cfg = { ...base.cfg, as_of, hz, contribs };
    // оракул: опорный остаток — якорь (никаких фактов после него), события с датой ≥ якоря считаются с зажимом на as_of
    const ctx = analyze(ws, { as_of: fmt(as_of), horizon_days: hd });
    for (const mode of MODES) {
      const m = naive_model(cfg, mode);
      assert.deepEqual(ctx.series[mode].trough, m.trough, `seed ${seed} k=${k} ${mode} trough`);
      assert.deepEqual(ctx.series[mode].close, m.close, `seed ${seed} k=${k} ${mode} close`);
      assert.deepEqual(ctx.series[mode].reserve_trough, m.rtrough, `seed ${seed} k=${k} ${mode} reserve_trough`);
      assert.deepEqual(ctx.series[mode].free, m.free, `seed ${seed} k=${k} ${mode} free`);
    }
    checked++;
  }
  assert.equal(checked, 120);
});

test('B-81 §9.3 свежесть якоря: прошлые расхождения 8400 за 7 дн. и 15000 за 10 дн. → unlogged_rate = 1350; age 9 → «не учтено» 12150 (плашка); границы: age 7 — fresh, 8 — banner, 21 — banner, 22 — block (stale)', () => {
  const g = load('g001.json');
  const at = (k) => {
    const ws = structuredClone(g);
    ws.facts = [];
    ws.anchors = [
      { anchor_id: 'a1', account_id: 'acc_main', date: '2026-09-01', amount_minor: 100000 },
      { anchor_id: 'a2', account_id: 'acc_main', date: '2026-09-08', amount_minor: 108400 },
      { anchor_id: 'a3', account_id: 'acc_main', date: '2026-09-18', amount_minor: 123400 },
    ];
    return analyze(ws, { as_of: fmt(D('2026-09-18') + k), horizon_days: 30 }).anchor_status;
  };
  assert.equal(he(2700n, 2n), 1350);
  const exp = [[0, 'fresh'], [7, 'fresh'], [8, 'banner'], [9, 'banner'], [21, 'banner'], [22, 'block']];
  for (const [k, level] of exp) {
    const s = at(k);
    assert.equal(s.level, level, `age ${k}`);
    assert.equal(s.rate_minor, 1350);
    assert.equal(s.unaccounted_minor, 1350 * k, `age ${k}: не учтено = rate · age`);
    assert.equal(s.age, k);
  }
  assert.equal(at(9).unaccounted_minor, 12150);
  assert.equal(at(22).reason, 'stale');
});

test('B-82 инвариантность представления: рабочая область «словарём id → запись» (как у ledger.reduce) и вложенные params дают те же ряды и тот же inputs_hash, что массивы и плоские ключи', () => {
  const byid = (xs, k) => Object.fromEntries(xs.map((x) => [x[k], x]));
  const as_dict = (ws) => {
    const w = structuredClone(ws);
    w.accounts = byid(ws.accounts, 'account_id');
    w.anchors = byid(ws.anchors, 'anchor_id');
    w.plans = byid(ws.plans, 'plan_id');
    w.rules = byid(ws.rules, 'rule_id');
    w.reserves = byid(ws.reserves, 'reserve_id');
    w.calendars = byid(ws.calendars, 'calendar_id');
    w.tax_rules = Object.fromEntries(ws.tax_rules.map((t) => [t.tax_rule_id, [t]]));
    return w;
  };
  const g = load('g001.json');
  const a = run(g);
  const b = run(Object.assign(as_dict(g), { streams: byid(g.streams, 'stream_id'), facts: byid(g.facts, 'event_id') }));
  assert.deepEqual(b.series, a.series);
  assert.equal(b.inputs_hash, a.inputs_hash);
  const nested = structuredClone(g);
  nested.params = { horizon_days: 57, buffer_minor: 50000, worse: { income_delay_days: 14 }, wave: { gap_days: 3, max_span_days: 10, threshold_minor: 3000 } };
  assert.deepEqual(run(nested).series, a.series);
  for (const seed of SEEDS.slice(0, 40)) {
    const { ctx, ws, horizon_days } = the_case(seed);
    const c = analyze(as_dict(ws), { as_of: ws.as_of, horizon_days });
    for (const mode of MODES) assert.deepEqual(c.series[mode], ctx.series[mode], `seed ${seed} ${mode}`);
  }
});
