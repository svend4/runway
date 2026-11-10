// waves.mjs — волны платежей и их метрики (ALG-03): жадная кластеризация значимых обязательств, ручные split/merge/pin,
// окно до ближайшего поступления своего режима, метрики «нужно к волне» / дефицит / покрытие.
// Канон: design-brief D-09, D-10, §3.9 (Wave, WaveMetrics), §5 (waves.mjs), §12 X1/X13, §14 B4; C-012, C-013, C-014, C-018, C-021, C-022;
// canon-decisions «Финальные сигнатуры» (waves.mjs); wiki/algorithms/alg-03-payment-waves-detection.md; ADR-007.
// Зависимости (правило слоёв §14 B4): money, dates, timeline. Модуль чистый: ни часов, ни случайности, ни ввода-вывода.
// Деньги — целые minor; даты — EpochDay. Расчёт по введённым данным, не консультация.
//
// Предупреждения. Канон фиксирует возвращаемые типы `apply_wave_overrides → Wave[]` и `list_waves → [{wave, metrics}]`; предупреждения
// (`W_OVERRIDE_STALE`, `W_BUFFER_UNSET`, `W_WAVE_NEAR_HORIZON`) отдают парные функции `apply_wave_overrides_ex` и `list_waves_ex`
// (тот же приём, что `build_events` / `build_events_ex` в timeline.mjs).

import { fail, assert_minor, mul_div } from './money.mjs';
import { to_epoch_day } from './dates.mjs';
import { get_param, normalize_mode } from './timeline.mjs';

/** @typedef {import('./money.mjs').Minor} Minor */
/** @typedef {import('./dates.mjs').EpochDay} EpochDay */
/** @typedef {import('./timeline.mjs').CashEvent} CashEvent */
/** @typedef {import('./timeline.mjs').Series} Series */
/**
 * Волна платежей (§3.9).
 * @typedef {object} Wave
 * @property {string} wave_id `'wave:' + id первого события волны` (порядок — ключ сортировки `(date, amount_minor, id)`)
 * @property {EpochDay} start дата первого обязательства
 * @property {EpochDay} end дата последнего обязательства
 * @property {string[]} event_ids `cash_event_id` по ключу сортировки
 * @property {Minor} total_out_minor Σ |amount_minor|
 */
/**
 * Метрики волны (D-10): все числа — по физическим деньгам (`trough`); резервы только справочно.
 * @typedef {object} WaveMetrics
 * @property {EpochDay} window_end `e_ext`: день перед ближайшим поступлением своего режима (иначе `horizon_end`)
 * @property {Minor} cash_minor `cash_w = close[start − 1]` (при `start = as_of` — `opening_minor`)
 * @property {{date: EpochDay, amount_minor: Minor}} min_trough первая дата минимума `trough` в окне
 * @property {Minor} r_minor `R_w = cash_w − min trough` — пиковая просадка окна
 * @property {Minor} need_minor `need_w = R_w + B` — «нужно к волне»
 * @property {Minor} gap_minor `gap_w = max(0, B − min trough)` — «дефицит волны (физический)»
 * @property {number} coverage_pm `floor(1000·cash_w / need_w)`, ‰ (при `cash_w < 0` — отрицательное, пол)
 * @property {Minor} reserved_minor `reserve_close[start − 1]` — справочно (без резервов 0)
 */
/**
 * Ручная правка волн (§3.8, C-014).
 * @typedef {object} WaveOverride
 * @property {string} [override_id]
 * @property {'split'|'merge'|'pin'} action
 * @property {string[]} event_ids
 * @property {{from: EpochDay|string, to: EpochDay|string}} [pin_range]
 * @property {number} [seq] порядок применения (эффективные записи журнала, C-072)
 */

// ── служебное ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Сравнение строк по кодовым точкам (не по UTF-16): детерминированный порядок id (ALG-03). */
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

/** Ключ сортировки обязательств `(date, amount_minor, cash_event_id)`: крупнее — раньше, затем по id. */
function cmp_event(x, y) {
  const dx = to_epoch_day(x.date);
  const dy = to_epoch_day(y.date);
  if (dx !== dy) return dx < dy ? -1 : 1;
  if (x.amount_minor !== y.amount_minor) return x.amount_minor < y.amount_minor ? -1 : 1;
  return cmp_code_points(String(x.cash_event_id), String(y.cash_event_id));
}

/** Параметры волн: `g`, `S`, `θ` (плоские ключи `wave.*` или вложенный объект `params.wave`). */
function wave_params(params) {
  const g = get_param(params, 'wave.gap_days');
  const S = get_param(params, 'wave.max_span_days');
  const theta = get_param(params, 'wave.threshold_minor');
  if (!Number.isSafeInteger(g) || g < 0) fail('E_SCHEMA', { reason: 'bad_wave_gap_days', value: String(g) });
  if (!Number.isSafeInteger(S) || S < 1) fail('E_SCHEMA', { reason: 'bad_wave_max_span_days', value: String(S) });
  if (!Number.isSafeInteger(theta) || theta < 1) fail('E_SCHEMA', { reason: 'bad_wave_threshold_minor', value: String(theta) });
  return { g, S, theta };
}

/** Значимое обязательство (D-09): `is_obligation`, не оценка, расход, `|amount| ≥ θ`. */
function is_significant(e, theta) {
  return e.is_obligation === true && e.is_estimate !== true && e.amount_minor < 0 && -e.amount_minor >= theta;
}

/** Поиск события по id: словарь, `Map` или массив событий. */
function make_lookup(by_id) {
  if (by_id instanceof Map) return (id) => by_id.get(id);
  if (Array.isArray(by_id)) {
    const m = new Map();
    for (const e of by_id) m.set(e.cash_event_id, e);
    return (id) => m.get(id);
  }
  if (by_id !== null && typeof by_id === 'object') return (id) => (Object.hasOwn(by_id, id) ? by_id[id] : undefined);
  return fail('E_SCHEMA', { reason: 'by_id_required' });
}

/** Собрать волну из списка id (события берутся из `get`; порядок — ключ сортировки). */
function build_wave(ids, get) {
  const evs = ids.map((id) => {
    const e = get(id);
    if (e === undefined || e === null) fail('E_SCHEMA', { reason: 'wave_event_not_in_by_id', event_id: String(id) });
    return e;
  }).sort(cmp_event);
  let total = 0;
  for (const e of evs) total = assert_minor(total - e.amount_minor);
  return {
    wave_id: 'wave:' + evs[0].cash_event_id,
    start: to_epoch_day(evs[0].date),
    end: to_epoch_day(evs[evs.length - 1].date),
    event_ids: evs.map((e) => e.cash_event_id),
    total_out_minor: total,
  };
}

// ── 1. состав волн ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Жадная кластеризация значимых обязательств (D-09): обязательства по `(date, amount_minor, id)`; событие входит в текущую волну, если
 * разрыв до её конца `≤ g` И размах от её начала `< S`; иначе открывается новая волна. Фон (ниже `θ`, оценки, расходы без `is_obligation`)
 * состав не меняет. Результат не зависит от порядка входного массива. Состав в `plan` и `worse` совпадает (обязательства даты не сдвигают).
 * @param {CashEvent[]} events эффективные события режима (`date` — эффективная, суммы в валюте решения)
 * @param {{wave?: {gap_days: number, max_span_days: number, threshold_minor: Minor}, 'wave.gap_days'?: number, 'wave.max_span_days'?: number, 'wave.threshold_minor'?: Minor}} params
 *   `g = wave.gap_days`, `S = wave.max_span_days`, `θ = wave.threshold_minor` (плоские ключи или вложенный объект)
 * @returns {Wave[]} по возрастанию начала
 * @throws {RunwayError} E_SCHEMA (`g < 0`, `S < 1`, `θ < 1` или параметр не задан)
 */
export function detect_waves(events, params) {
  const { g, S, theta } = wave_params(params);
  const O = (events ?? []).filter((e) => is_significant(e, theta)).sort(cmp_event);
  const waves = [];
  let w = null;
  for (const e of O) {
    const d = to_epoch_day(e.date);
    if (w !== null && d - w.end <= g && d - w.start < S) {
      w.event_ids.push(e.cash_event_id);
      w.end = d;
      w.total_out_minor = assert_minor(w.total_out_minor - e.amount_minor);
    } else {
      w = { wave_id: 'wave:' + e.cash_event_id, start: d, end: d, event_ids: [e.cash_event_id], total_out_minor: assert_minor(-e.amount_minor) };
      waves.push(w);
    }
  }
  return waves;
}

// ── 2. ручные правки ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Порядок применения правок: по `seq` (если он задан у всех записей), иначе порядок массива (устойчиво). */
function ordered_overrides(overrides) {
  const list = [...(overrides ?? [])];
  if (list.length > 1 && list.every((o) => Number.isSafeInteger(o?.seq))) {
    return list.map((o, i) => [o, i]).sort((a, b) => (a[0].seq - b[0].seq) || (a[1] - b[1])).map((p) => p[0]);
  }
  return list;
}

/**
 * Ручные правки после алгоритма (D-09, C-014), в порядке эффективных записей журнала (`seq`; иначе порядок массива):
 * `split` режет волну ПЕРЕД указанным событием; `merge` объединяет волны, в которых лежат указанные события; `pin` выделяет указанные
 * события (и события с датой в `pin_range`) в отдельную волну. Ссылка на исчезшее или ставшее фоном событие пропускается
 * с предупреждением `W_OVERRIDE_STALE`; правки переживают пересчёт, но не воскрешают события. Повторное применение тех же правок
 * ничего не меняет; каждое значимое обязательство остаётся ровно в одной волне (TST-37).
 * @param {Wave[]} waves результат `detect_waves`
 * @param {WaveOverride[]} overrides
 * @param {Map<string, CashEvent>|Object<string, CashEvent>|CashEvent[]} by_id `cash_event_id → событие` (даты и суммы для пересчёта)
 * @returns {{waves: Wave[], warnings: {code: 'W_OVERRIDE_STALE', override_id: string|null, event_ids: string[]}[]}}
 * @throws {RunwayError} E_SCHEMA (неизвестное действие, `event_ids` не массив, событие волны не найдено в `by_id`)
 */
export function apply_wave_overrides_ex(waves, overrides, by_id) {
  const get = make_lookup(by_id);
  const by_key = (a, b) => cmp_event(get(a), get(b));
  let ws = (waves ?? []).map((w) => [...w.event_ids]);
  for (const ids of ws) for (const id of ids) if (get(id) === undefined) fail('E_SCHEMA', { reason: 'wave_event_not_in_by_id', event_id: String(id) });
  const known = new Set(ws.flat());
  const warnings = [];
  const where = (id) => ws.findIndex((ids) => ids.includes(id));
  for (const o of ordered_overrides(overrides)) {
    if (o === null || typeof o !== 'object') fail('E_SCHEMA', { reason: 'wave_override_not_object' });
    if (o.action !== 'split' && o.action !== 'merge' && o.action !== 'pin') fail('E_SCHEMA', { reason: 'unknown_wave_override_action', action: String(o.action) });
    if (!Array.isArray(o.event_ids)) fail('E_SCHEMA', { reason: 'wave_override_event_ids_required' });
    const override_id = o.override_id ?? null;
    const unknown = o.event_ids.filter((i) => !known.has(i));
    if (unknown.length > 0) warnings.push({ code: 'W_OVERRIDE_STALE', override_id, event_ids: unknown }); // правка пережила пересчёт, но не воскрешает события
    const ids = [...new Set(o.event_ids.filter((i) => known.has(i)))];
    if (o.action === 'pin') {
      const M = new Set(ids);
      if (o.pin_range !== undefined && o.pin_range !== null) {
        const from = to_epoch_day(o.pin_range.from);
        const to = to_epoch_day(o.pin_range.to);
        for (const i of known) {
          const d = to_epoch_day(get(i).date);
          if (from <= d && d <= to) M.add(i);
        }
      }
      if (M.size === 0) {
        if (unknown.length === 0) warnings.push({ code: 'W_OVERRIDE_STALE', override_id, event_ids: [] });
        continue;
      }
      ws = ws.map((list) => list.filter((i) => !M.has(i))).filter((list) => list.length > 0);
      ws.push([...M].sort(by_key));
      continue;
    }
    if (ids.length === 0) {
      if (unknown.length === 0) warnings.push({ code: 'W_OVERRIDE_STALE', override_id, event_ids: [] });
      continue;
    }
    if (o.action === 'merge') {
      const hit = new Set();
      for (const i of ids) hit.add(where(i));
      const union = [...hit].flatMap((k) => ws[k]).sort(by_key);
      ws = ws.filter((_, k) => !hit.has(k));
      ws.push(union);
    } else { // split: режем перед каждым указанным событием (по ключу сортировки)
      for (const i of [...ids].sort(by_key)) {
        const k = where(i);
        const list = ws[k];
        const pos = list.indexOf(i);
        if (pos > 0) ws.splice(k, 1, list.slice(0, pos), list.slice(pos));
      }
    }
  }
  const out = ws.map((ids) => build_wave(ids, get));
  out.sort((a, b) => (a.start - b.start) || cmp_code_points(a.wave_id, b.wave_id));
  return { waves: out, warnings };
}

/**
 * Ручные правки волн (см. `apply_wave_overrides_ex`); предупреждения опущены.
 * @param {Wave[]} waves
 * @param {WaveOverride[]} overrides
 * @param {Map<string, CashEvent>|Object<string, CashEvent>|CashEvent[]} by_id
 * @returns {Wave[]}
 */
export function apply_wave_overrides(waves, overrides, by_id) {
  return apply_wave_overrides_ex(waves, overrides, by_id).waves;
}

// ── 3. окно и метрики ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Первое поступление строго после `after`: `min{e.date : kind = income, amount_minor > 0, e.date > after}`.
 * @param {CashEvent[]} events эффективные события режима
 * @param {EpochDay|string} after
 * @returns {EpochDay|null} `null` — поступлений нет
 */
export function next_income_day(events, after) {
  const a = to_epoch_day(after);
  let best = null;
  for (const e of events ?? []) {
    if (e.kind !== 'income' || !(e.amount_minor > 0)) continue;
    const d = to_epoch_day(e.date);
    if (d > a && (best === null || d < best)) best = d;
  }
  return best;
}

/**
 * Метрики волны (D-10): окно `[start, e_ext]`, `e_ext = max(end, next_income_day − 1)` (нет поступлений — `horizon_end`);
 * `cash_w = close[start − 1]` (при `start = as_of` — `opening_minor`); `R_w = cash_w − min trough` окна; `need_w = R_w + B`;
 * `gap_w = max(0, B − min trough)`; `coverage_pm = floor(1000·cash_w / need_w)`; `reserved_w = reserve_close[start − 1]` — справочно.
 * Поступление позже горизонта считается отсутствующим (окно до `horizon_end`).
 * @param {Wave} wave
 * @param {Series} series ряды режима: `from`, `opening_minor`, `close`, `trough` (и, если есть, `reserve_opening_minor`, `reserve_close`)
 * @param {Minor} B буфер ≥ 0
 * @param {EpochDay|null} next_income_day первый приход режима строго после `wave.end`
 * @returns {WaveMetrics}
 * @throws {RunwayError} E_BAD_DATE (волна вне ряда), E_SCHEMA (`B < 0`; `need_w < 1` — волна не согласована с рядом)
 */
export function wave_metrics(wave, series, B, next_income_day) {
  const buf = assert_minor(B);
  if (buf < 0) fail('E_SCHEMA', { reason: 'buffer_negative', value: buf });
  const horizon_end = series.from + series.trough.length - 1;
  let e_ext = horizon_end;
  if (next_income_day !== null && next_income_day !== undefined) {
    const n = to_epoch_day(next_income_day);
    if (n - 1 <= horizon_end) e_ext = Math.max(wave.end, n - 1);
  }
  const i0 = wave.start - series.from;
  const i1 = e_ext - series.from;
  if (!(0 <= i0 && i0 <= i1 && i1 < series.trough.length)) fail('E_BAD_DATE', { reason: 'wave_outside_series', start: wave.start, window_end: e_ext, from: series.from, horizon_end });
  const cash = i0 === 0 ? series.opening_minor : series.close[i0 - 1];
  const reserved = i0 === 0 ? (series.reserve_opening_minor ?? 0) : (series.reserve_close?.[i0 - 1] ?? 0);
  let k = i0;
  for (let i = i0 + 1; i <= i1; i++) if (series.trough[i] < series.trough[k]) k = i; // первый минимум: при равенстве — ранняя дата (D-02)
  const m = series.trough[k];
  const r = assert_minor(cash - m);
  const need = assert_minor(r + buf);
  if (need < 1) fail('E_SCHEMA', { reason: 'need_not_positive', wave_id: wave.wave_id, need });
  return {
    window_end: e_ext,
    cash_minor: cash,
    min_trough: { date: series.from + k, amount_minor: m },
    r_minor: r,
    need_minor: need,
    gap_minor: Math.max(0, assert_minor(buf - m)),
    coverage_pm: mul_div(cash, 1000, need, 'floor'),
    reserved_minor: reserved,
  };
}

// ── 4. список для экрана и инструмента list_waves ────────────────────────────────────────────────────────────────────

/**
 * Список волн режима с метриками и предупреждениями (`ctx` — `Analysis` из `analyze()`, C-012). Буфер не задан (`null`) —
 * `B = 0` и `W_BUFFER_UNSET` (волны не блокируются, C-018); волна у границы горизонта (`end + g > horizon_end`) — `W_WAVE_NEAR_HORIZON`.
 * @param {{events: object, series: object, params: object, buffer_minor?: Minor|null, wave_overrides?: WaveOverride[], horizon_end?: EpochDay}} ctx
 * @param {'plan'|'worse'|'conservative'} mode
 * @returns {{items: {wave: Wave, metrics: WaveMetrics}[], warnings: {code: string}[]}}
 * @throws {RunwayError} E_SCHEMA (нет рядов/событий режима в `ctx`, режим не v1)
 */
export function list_waves_ex(ctx, mode) {
  const m = normalize_mode(mode);
  const ev = ctx?.events?.[m];
  const s = ctx?.series?.[m];
  if (ev === undefined || s === undefined) fail('E_SCHEMA', { reason: 'mode_not_in_ctx', mode: m });
  const warnings = [];
  const unset = ctx.buffer_minor === null || ctx.buffer_minor === undefined;
  const B = unset ? 0 : ctx.buffer_minor;
  if (unset) warnings.push({ code: 'W_BUFFER_UNSET' });
  const { g } = wave_params(ctx.params);
  const horizon_end = s.from + s.trough.length - 1;
  const applied = apply_wave_overrides_ex(detect_waves(ev, ctx.params), ctx.wave_overrides ?? [], ev);
  warnings.push(...applied.warnings);
  const items = applied.waves.map((w) => {
    if (w.end + g > horizon_end) warnings.push({ code: 'W_WAVE_NEAR_HORIZON', wave_id: w.wave_id });
    return { wave: w, metrics: wave_metrics(w, s, B, next_income_day(ev, w.end)) };
  });
  return { items, warnings };
}

/**
 * Список волн режима для экрана и инструмента `list_waves`: `[{wave, metrics}]` (см. `list_waves_ex` — с предупреждениями).
 * @param {object} ctx `Analysis`
 * @param {'plan'|'worse'|'conservative'} mode
 * @returns {{wave: Wave, metrics: WaveMetrics}[]}
 */
export function list_waves(ctx, mode) {
  return list_waves_ex(ctx, mode).items;
}
