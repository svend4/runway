// wave_sweep.mjs — чувствительность волн к параметрам и объяснение «почему вместе» (FP-07, REQ-036, ALG-03, IDEA-09).
// Движок кластеризует значимые обязательства жадно (D-09): событие входит в текущую волну, если разрыв до её конца ≤ `g` (wave.gap_days)
// И размах от её начала < `S` (wave.max_span_days); значимое — обязательство не ниже порога `θ` (wave.threshold_minor).
// Модуль ничего не меняет в алгоритме: он повторяет `detect_waves` при других `θ`, `g`, `S` (таблица чувствительности) и показывает по шагам,
// почему платежи оказались в одной волне или в разных. Ручные правки (split/merge/pin) в таблицу чувствительности не входят: это свойство параметров.
// Зависимости: money, dates, timeline, waves. Модуль чистый: ни часов, ни случайности, ни ввода-вывода. Расчёт по введённым данным, не консультация.

import { fail } from './money.mjs';
import { to_epoch_day } from './dates.mjs';
import { flat_params, get_param } from './timeline.mjs';
import { detect_waves, apply_wave_overrides_ex } from './waves.mjs';

/** Предел числа строк таблицы чувствительности. */
export const SWEEP_MAX_ROWS = 200;

/** Сравнение строк по кодовым точкам (как в `waves.mjs`: детерминированный порядок идентификаторов). */
function cmp_code_points(a, b) {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done) return y.done ? 0 : -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0);
    const cy = y.value.codePointAt(0);
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

/** Ключ сортировки обязательств `(date, amount_minor, cash_event_id)`, как в `waves.mjs`. */
function cmp_event(x, y) {
  const dx = to_epoch_day(x.date);
  const dy = to_epoch_day(y.date);
  if (dx !== dy) return dx < dy ? -1 : 1;
  if (x.amount_minor !== y.amount_minor) return x.amount_minor < y.amount_minor ? -1 : 1;
  return cmp_code_points(String(x.cash_event_id), String(y.cash_event_id));
}

/** Параметры волн `{g, S, theta}` из `Analysis.params` (плоские ключи) или вложенного объекта. */
export function wave_params_of(params) {
  const g = get_param(params, 'wave.gap_days');
  const S = get_param(params, 'wave.max_span_days');
  const theta = get_param(params, 'wave.threshold_minor');
  if (!Number.isSafeInteger(g) || g < 0) fail('E_SCHEMA', { reason: 'bad_wave_gap_days', value: String(g) });
  if (!Number.isSafeInteger(S) || S < 1) fail('E_SCHEMA', { reason: 'bad_wave_max_span_days', value: String(S) });
  if (!Number.isSafeInteger(theta) || theta < 1) fail('E_SCHEMA', { reason: 'bad_wave_threshold_minor', value: String(theta) });
  return { g, S, theta };
}

/** Обязательство-кандидат: расход, не оценка, помеченный обязательством. */
const is_candidate = (e) => e.is_obligation === true && e.is_estimate !== true && e.amount_minor < 0;

/**
 * Значения порога, при которых состав значимых обязательств меняется: различные суммы обязательств (порог = сумме включает её).
 * Если их больше `max`, берётся равномерная выборка (крайние значения остаются); текущий порог всегда входит в список.
 * @param {object[]} events эффективные события режима
 * @param {object} params
 * @param {number} [max] не более значений (по умолчанию 8)
 * @returns {number[]} по возрастанию, без повторов
 */
export function candidate_thetas(events, params, max = 8) {
  const { theta } = wave_params_of(params);
  const amounts = [...new Set((events ?? []).filter(is_candidate).map((e) => -e.amount_minor))].filter((v) => v >= 1).sort((a, b) => a - b);
  let pick = amounts;
  if (amounts.length > max) {
    pick = [];
    for (let i = 0; i < max; i++) pick.push(amounts[Math.round(i * (amounts.length - 1) / (max - 1))]);
  }
  return [...new Set([...pick, theta])].sort((a, b) => a - b);
}

/**
 * Таблица чувствительности: волны при разных `θ`, `g`, `S` (без ручных правок).
 * @param {object[]} events эффективные события режима
 * @param {object} params действующие параметры (`wave.*`)
 * @param {{thetas?: number[], gaps?: number[], spans?: number[], max_rows?: number}} [opts] списки значений; по умолчанию θ — `candidate_thetas`, `g` и `S` — текущие
 * @returns {{current: {theta_minor: number, gap_days: number, max_span_days: number, wave_count: number},
 *   rows: {theta_minor: number, gap_days: number, max_span_days: number, current: boolean, wave_count: number, delta_waves: number,
 *     obligations: number, covered_minor: number, waves: {start: number, end: number, count: number, total_out_minor: number}[]}[]}}
 * @throws {RunwayError} E_SCHEMA (значение параметра вне допустимого, больше `max_rows` строк)
 */
export function sweep_waves(events, params, opts = {}) {
  const cur = wave_params_of(params);
  const thetas = opts.thetas ?? candidate_thetas(events, params);
  const gaps = opts.gaps ?? [cur.g];
  const spans = opts.spans ?? [cur.S];
  const max_rows = opts.max_rows ?? SWEEP_MAX_ROWS;
  if (thetas.length * gaps.length * spans.length > max_rows) fail('E_SCHEMA', { reason: 'sweep_too_large', rows: thetas.length * gaps.length * spans.length, max: max_rows });
  const base = flat_params(params);
  const run = (theta, g, S) => detect_waves(events, { ...base, 'wave.threshold_minor': theta, 'wave.gap_days': g, 'wave.max_span_days': S });
  const current_waves = run(cur.theta, cur.g, cur.S);
  const rows = [];
  for (const theta of [...thetas].sort((a, b) => a - b)) {
    for (const g of [...gaps].sort((a, b) => a - b)) {
      for (const S of [...spans].sort((a, b) => a - b)) {
        const waves = run(theta, g, S);
        rows.push({
          theta_minor: theta, gap_days: g, max_span_days: S,
          current: theta === cur.theta && g === cur.g && S === cur.S,
          wave_count: waves.length, delta_waves: waves.length - current_waves.length,
          obligations: waves.reduce((acc, w) => acc + w.event_ids.length, 0),
          covered_minor: waves.reduce((acc, w) => acc + w.total_out_minor, 0),
          waves: waves.map((w) => ({ start: w.start, end: w.end, count: w.event_ids.length, total_out_minor: w.total_out_minor })),
        });
      }
    }
  }
  return { current: { theta_minor: cur.theta, gap_days: cur.g, max_span_days: cur.S, wave_count: current_waves.length }, rows };
}

function lookup(events) {
  const m = new Map();
  for (const e of events ?? []) m.set(e.cash_event_id, e);
  return m;
}

/**
 * «Почему вместе?»: платежи волны по шагам с разрывом до предыдущего и размахом от первого; правило: разрыв ≤ `g` и размах < `S`.
 * Волна, собранная вручную (merge/pin), правилу может не отвечать — тогда `together_by_rule = false` (причина — правка пользователя).
 * @param {object[]} events эффективные события режима
 * @param {object} params
 * @param {string[]} event_ids платежи волны
 * @returns {{gap_days_limit: number, max_span_days_limit: number, threshold_minor: number, missing: string[], total_out_minor: number,
 *   largest_gap_days: number, span_days: number, together_by_rule: boolean,
 *   steps: {event_id: string, date: number, amount_minor: number, gap_days: number|null, span_days: number, gap_ok: boolean, span_ok: boolean}[]}}
 */
export function explain_membership(events, params, event_ids) {
  const { g, S, theta } = wave_params_of(params);
  const by_id = lookup(events);
  const missing = event_ids.filter((id) => !by_id.has(id));
  const evs = event_ids.filter((id) => by_id.has(id)).map((id) => by_id.get(id)).sort(cmp_event);
  const steps = [];
  let total = 0;
  for (let i = 0; i < evs.length; i++) {
    const d = to_epoch_day(evs[i].date);
    const prev = i === 0 ? null : to_epoch_day(evs[i - 1].date);
    const gap = prev === null ? null : d - prev;
    const span = d - to_epoch_day(evs[0].date);
    total += -evs[i].amount_minor;
    steps.push({ event_id: evs[i].cash_event_id, date: d, amount_minor: evs[i].amount_minor, gap_days: gap, span_days: span, gap_ok: gap === null || gap <= g, span_ok: i === 0 || span < S });
  }
  return {
    gap_days_limit: g, max_span_days_limit: S, threshold_minor: theta, missing, total_out_minor: total,
    largest_gap_days: steps.reduce((m, s) => Math.max(m, s.gap_days ?? 0), 0),
    span_days: steps.length === 0 ? 0 : steps[steps.length - 1].span_days,
    together_by_rule: steps.every((s) => s.gap_ok && s.span_ok),
    steps,
  };
}

/**
 * «Почему врозь?»: граница между двумя соседними волнами. `reason`: `gap` — разрыв больше `g`; `span` — размах с первой волной не меньше `S`;
 * `manual` — по правилам платежи сошлись бы в одну волну, их развела правка пользователя.
 * @param {object[]} events
 * @param {object} params
 * @param {string[]} ids_a платежи более ранней волны
 * @param {string[]} ids_b платежи более поздней волны
 * @returns {{gap_days: number, gap_days_limit: number, span_days: number, max_span_days_limit: number, reason: 'gap'|'span'|'manual'}}
 * @throws {RunwayError} E_SCHEMA (платёж не найден среди событий)
 */
export function explain_boundary(events, params, ids_a, ids_b) {
  const { g, S } = wave_params_of(params);
  const by_id = lookup(events);
  const day = (id) => {
    const e = by_id.get(id);
    if (e === undefined) fail('E_SCHEMA', { reason: 'wave_event_not_in_events', event_id: String(id) });
    return to_epoch_day(e.date);
  };
  const da = ids_a.map(day);
  const db = ids_b.map(day);
  const a_start = Math.min(...da);
  const a_end = Math.max(...da);
  const b_first = Math.min(...db);
  const gap = b_first - a_end;
  const span = b_first - a_start;
  const reason = gap > g ? 'gap' : span >= S ? 'span' : 'manual';
  return { gap_days: gap, gap_days_limit: g, span_days: span, max_span_days_limit: S, reason };
}

/**
 * Откуда волна: `natural` — такой же состав даёт алгоритм без правок; `edited` — состав изменён правками (merge/split/pin).
 * @param {{event_ids: string[]}[]} natural результат `detect_waves`
 * @param {{event_ids: string[]}} wave волна после правок
 * @returns {'natural'|'edited'}
 */
export function wave_origin(natural, wave) {
  const key = (ids) => [...ids].sort(cmp_code_points).join('\u0000');
  const k = key(wave.event_ids);
  return natural.some((w) => key(w.event_ids) === k) ? 'natural' : 'edited';
}

/**
 * Устаревшие правки: ссылаются на платёж, которого уже нет среди значимых обязательств (`W_OVERRIDE_STALE`, C-014).
 * Правки в порядке записей, как их применяет движок.
 * @param {object[]} events
 * @param {object} params
 * @param {object[]} overrides
 * @returns {{override_id: string|null, event_ids: string[]}[]} по одной записи на предупреждение движка
 */
export function stale_overrides(events, params, overrides) {
  const r = apply_wave_overrides_ex(detect_waves(events, params), overrides, events);
  return r.warnings.filter((w) => w.code === 'W_OVERRIDE_STALE').map((w) => ({ override_id: w.override_id, event_ids: w.event_ids }));
}
