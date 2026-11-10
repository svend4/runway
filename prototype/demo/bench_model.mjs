// bench_model.mjs — общая «чистая» часть замеров (FP-23, REQ-150, REQ-151): набор синтетических рабочих областей на 10³ / 2·10³ / 4·10³ событий, процентили,
// замер полного пересчёта (`analyze` и «пересчёт страницы + ответ Q3») и проверка роста времени при удвоении N. Модуль читают страница `bench.html`
// (bench_page.mjs) и инструмент `tools/bench.mjs` — одна и та же арифметика и один и тот же состав набора в браузере и в Node.
// Здесь нет ни часов, ни случайности, ни сети: время даёт порт `now` (в странице — `performance.now()`, в инструменте — `performance` из `node:perf_hooks`),
// а набор данных строится без случайных чисел, поэтому тот же `copies` всегда даёт ту же рабочую область (проверяет tests/bench_pages.test.mjs).
// Цифры замеров — гипотезы-бюджеты (ADR-014), а не обещания продукту: публикуется только измеренное, с n, датой и устройством.
// Расчёт по введённым данным и правилам, не консультация.

import { analyze, to_epoch_day, format_date } from '../engine/index.mjs';
import { make_tool_ctx } from '../engine/tools.mjs';
import { a0_answer } from '../engine/verifier.mjs';

/** Бюджеты и пороги (гипотезы до первого замера на устройствах; REQ-150, ADR-014). */
export const BUDGET = Object.freeze({ recompute_p95_ms: 100, blocking_ms: 50, journal_open_ms: 2000 });

/** Предел роста времени при удвоении N (REQ-151): строго не более 2,5 раза на каждое удвоение. */
export const DOUBLING_LIMIT = 2.5;

/** Во сколько раз p95 может вырасти относительно записанного замера, прежде чем сравнение сочтёт это регрессом (REQ-150: «более чем вдвое»). */
export const GROWTH_LIMIT = 2;

/**
 * Синтетические наборы: `copies` одинаковых наборов правил (1 ежедневное + 3 еженедельных + 2 ежемесячных ≈ 270 вхождений за 180 дней на копию).
 * Удвоение `copies` удваивает число событий при том же составе — масштабирование измеряется «чисто». `nominal_events` — круглое название точки (10³, 2·10³, 4·10³).
 */
export const SYNTH_POINTS = Object.freeze([
  Object.freeze({ id: 'n1k', copies: 4, nominal_events: 1000 }),
  Object.freeze({ id: 'n2k', copies: 8, nominal_events: 2000 }),
  Object.freeze({ id: 'n4k', copies: 16, nominal_events: 4000 }),
]);

/** Число замеров: `samples` в раунде, `rounds` раундов (n = samples · rounds), `warmup` прогревочных вызовов. Быстрый вариант — n = 30, полный — n = 90 (как в `_ops/bench.json`). */
export const SAMPLE_PLANS = Object.freeze({
  quick: Object.freeze({ samples: 10, rounds: 3, warmup: 5 }),
  full: Object.freeze({ samples: 30, rounds: 3, warmup: 5 }),
});

/** Формат записи устройства, которую страница `bench.html` отдаёт для вставки в `devices` файла `_ops/bench.json`. */
export const DEVICE_FORMAT = 'runway-bench-device/1';

/** Процентиль «ближайший ранг» (то же определение, что в TST-54). */
export function percentile(xs, q) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((q * s.length) / 100) - 1)];
}

/** Округление до сотых мс (только для показа; деньги сюда не попадают). */
export const round2 = (x) => Math.round(x * 100) / 100;

/**
 * Рабочая область из `copies` одинаковых наборов правил: при `copies = 4` около 10³ событий на горизонте 180 дней (REQ-150). Тот же состав,
 * что в TST-54 (`tests/timeline.test.mjs`), плюс остаток, буфер и налоговый резерв. Без случайных чисел и без часов.
 * @param {number} [copies]
 * @returns {object}
 */
export function make_bench_ws(copies = 4) {
  const rules = [];
  const base = { account_id: 'a', currency: 'EUR', interval: 1, month_end: 'clamp', weekend: 'keep', calendar_id: null, exdates: [], is_obligation: false, is_estimate: true, tag: 'p' };
  for (let c = 0; c < copies; c++) {
    rules.push({ ...base, rule_id: `D${c}`, name: 'd', kind: 'expense', amount: { exp_minor: -(100 + c) }, freq: 'D', start_date: '2026-01-01' });
    for (let k = 0; k < 3; k++) {
      const income = (c + k) % 3 === 0;
      rules.push({ ...base, rule_id: `W${c}_${k}`, name: 'w', kind: income ? 'income' : 'expense', amount: { exp_minor: (income ? 1 : -1) * (1000 + 7 * c + k) }, freq: 'W', by_weekday: [(c + k) % 7], start_date: '2026-01-04' });
    }
    for (let k = 0; k < 2; k++) rules.push({ ...base, rule_id: `M${c}_${k}`, name: 'm', kind: 'expense', amount: { exp_minor: -(5000 + 11 * c + k) }, freq: 'M', by_monthday: [1 + ((c * 5 + k * 9) % 28)], start_date: '2026-01-01', is_obligation: true, is_estimate: false });
  }
  return {
    as_of: '2026-10-04', decision_currency: 'EUR', params: { horizon_days: 180, buffer_minor: 50000 },
    accounts: [{ account_id: 'a', name: 'Счёт', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 }],
    anchors: [{ anchor_id: 'x', account_id: 'a', date: '2026-10-04', amount_minor: 5_000_000 }],
    facts: [], rules, overrides: [], calendars: [], streams: [], plans: [], tax_rules: [],
    reserves: [{ reserve_id: 'RT', kind: 'tax', currency: 'EUR', funded_start_minor: 100000, backed_by_account_id: null }],
    rates: [], scenarios: [], debts: [],
  };
}

/** Сводка ряда замеров: n, p50, p95, min, max (мс, до сотых). */
export function stat_of(xs) {
  return { n: xs.length, p50_ms: round2(percentile(xs, 50)), p95_ms: round2(percentile(xs, 95)), min_ms: round2(Math.min(...xs)), max_ms: round2(Math.max(...xs)) };
}

/**
 * Разрешение таймера `now`: наименьший положительный шаг между соседними показаниями (по нескольким пробам). Грубый таймер (1 мс и крупнее)
 * делает p50 быстрых наборов ступенчатым — число показывается рядом с результатом.
 * @param {() => number} now
 * @param {number} [probes]
 * @returns {number|null} мс или `null`, если шаг не удалось увидеть
 */
export function timer_resolution_ms(now, probes = 5) {
  let best = null;
  for (let i = 0; i < probes; i++) {
    const t0 = now();
    let t1 = t0;
    for (let spin = 0; spin < 2_000_000 && t1 === t0; spin++) t1 = now();
    if (t1 > t0 && (best === null || t1 - t0 < best)) best = t1 - t0;
  }
  return best === null ? null : round2(best);
}

/**
 * Замерщик одной рабочей области: один шаг — это один `analyze` и один «пересчёт страницы + ответ Q3» (контекст инструментов и `check-purchase` на 16-й день).
 * @param {object} ws
 * @param {() => number} now часы в мс (порт)
 */
export function make_sampler(ws, now) {
  const query = { as_of: ws.as_of };
  const buy_date = format_date(to_epoch_day(ws.as_of) + 16);
  const run_analyze = () => analyze(ws, query);
  const run_q3 = () => {
    const ctx = make_tool_ctx(ws, query, { locale: 'ru' });
    const r = a0_answer(['check-purchase', buy_date, '30000', ws.decision_currency], ctx, { locale: 'ru' });
    if (!r.ok) throw new Error('Q3 не ответил');
  };
  const timed = (fn) => { const t0 = now(); fn(); return now() - t0; };
  return {
    /** Событий по плану на горизонте (для подписи набора). */
    events: analyze(ws, query).events.plan.length,
    /** Прогрев: `times` раз и расчёт, и ответ Q3 (не измеряется). */
    warm(times = 5) { for (let i = 0; i < times; i++) { run_analyze(); run_q3(); } },
    /** Один шаг замера: сначала `analyze`, затем «страница + Q3» — оба ряда в одинаковых условиях нагрузки. */
    sample() { return { analyze_ms: timed(run_analyze), q3_ms: timed(run_q3) }; },
  };
}

/**
 * Полный пересчёт синхронно (инструмент в Node): прогрев, затем `rounds` раундов по `samples` шагов.
 * @param {{ws: object, now: () => number, samples?: number, rounds?: number, warmup?: number}} o
 * @returns {{n: number, events: number, analyze: object, recompute_q3: object}}
 */
export function measure_recompute({ ws, now, samples = 30, rounds = 3, warmup = 5 }) {
  const s = make_sampler(ws, now);
  s.warm(warmup);
  const a_ms = [];
  const q_ms = [];
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < samples; i++) { const x = s.sample(); a_ms.push(x.analyze_ms); q_ms.push(x.q3_ms); }
  }
  return { n: samples * rounds, events: s.events, analyze: stat_of(a_ms), recompute_q3: stat_of(q_ms) };
}

/**
 * Рост времени при удвоении N (REQ-151): отношение времени соседних точек, предел `limit` (по умолчанию 2,5) на КАЖДОЕ удвоение.
 * @param {{id: string, events: number, ms: number}[]} points точки по возрастанию N
 * @param {number} [limit]
 * @returns {{ok: boolean, limit: number, steps: {from: string, to: string, n_ratio: number|null, t_ratio: number|null, ok: boolean}[]}}
 */
export function doubling_check(points, limit = DOUBLING_LIMIT) {
  const steps = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const valid = Number.isFinite(a.ms) && Number.isFinite(b.ms) && a.ms > 0 && b.ms >= 0 && a.events > 0;
    const t_ratio = valid ? b.ms / a.ms : null;
    steps.push({
      from: a.id, to: b.id,
      n_ratio: a.events > 0 ? round2(b.events / a.events) : null,
      t_ratio: t_ratio === null ? null : round2(t_ratio),
      ok: t_ratio !== null && t_ratio <= limit,
    });
  }
  return { ok: steps.length > 0 && steps.every((s) => s.ok), limit, steps };
}

/**
 * Сравнение свежего замера с записанным (REQ-150: рост p95 более чем вдвое = регресс). Чистая функция: числа приходят аргументами.
 * @param {{baseline: Record<string, number>, current: Record<string, number>, factor?: number, budget_ms?: number}} o
 *   baseline/current — `{ имя_метрики: p95_мс }`; factor — допустимый рост (по умолчанию 2); budget_ms — жёсткий бюджет гипотезы (по умолчанию 100 мс)
 * @returns {{ok: boolean, factor: number, rows: {metric: string, baseline_ms: number, current_ms: number, ratio: number, limit_ms: number, over_growth: boolean, over_budget: boolean, ok: boolean}[]}}
 */
export function compare_p95({ baseline, current, factor = GROWTH_LIMIT, budget_ms = BUDGET.recompute_p95_ms }) {
  const rows = Object.keys(baseline).map((metric) => {
    const b = baseline[metric];
    const c = current[metric];
    const limit_ms = b * factor;
    const over_growth = !(Number.isFinite(c) && c <= limit_ms); // «более чем вдвое»: ровно в два раза ещё допустимо
    const over_budget = !(Number.isFinite(c) && c <= budget_ms);
    return { metric, baseline_ms: b, current_ms: c, ratio: Number.isFinite(c) && b > 0 ? round2(c / b) : Infinity, limit_ms: round2(limit_ms), over_growth, over_budget, ok: !over_growth && !over_budget };
  });
  return { ok: rows.length > 0 && rows.every((r) => r.ok), factor, rows };
}

/**
 * Запись для `_ops/bench.json` (массив `devices`), собранная страницей `bench.html`. Поле `device` — строка браузера как есть (она остаётся на экране и в копируемом тексте).
 * @param {{date: string, device: string, env: object, engine_version: string, timer_ms: number|null, sets: object[], n: number, doubling: object|null, notes?: string[]}} o
 */
export function build_device_report({ date, device, env, engine_version, timer_ms, sets, n, doubling, notes = [] }) {
  return {
    format: DEVICE_FORMAT,
    device,
    date,
    source: 'demo/bench.html',
    engine_version,
    n,
    timer_resolution_ms: timer_ms,
    env,
    budget: { ...BUDGET },
    sets,
    doubling,
    within_budget: within_budget(sets),
    notes,
  };
}

/** Наборы, к которым относится бюджет p95 ≤ 100 мс (REQ-150: журнал порядка 10³ событий): эталон G-001 и синтетический набор на 10³ событий. Наборы больше — только для роста времени. */
export const BUDGET_SET_IDS = Object.freeze(['g001', 'n1k']);

/** Уложились ли наборы бюджета p95 (`null`, если ни одного набора бюджета не измерено). */
export function within_budget(sets) {
  const own = sets.filter((s) => BUDGET_SET_IDS.includes(s.id));
  if (own.length === 0) return null;
  return own.every((s) => s.recompute_q3.p95_ms <= BUDGET.recompute_p95_ms && s.analyze.p95_ms <= BUDGET.recompute_p95_ms);
}
