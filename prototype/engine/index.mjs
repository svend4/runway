// index.mjs — фасад движка: `analyze(ws, query) → Analysis` (D-21, §3.9 «Analysis», C-012, §14 B3) и реэкспорт публичного API.
// `Analysis` — единый контекст `ctx` для `waves`, `afford`, `tools`, `montecarlo`, `backtest`: ряды обоих режимов с резервами и `free`,
// события, Q1, готовность, свежесть якоря, статусы правил, предупреждения, `inputs_hash`, `engine_version`.
// Канон: design-brief D-01…D-08, D-13, D-20…D-23, §3.9, §5, §14 B3/B4; C-012, C-018, C-020, C-030, C-059, C-065, C-098;
// canon-decisions «Финальные сигнатуры» (index.mjs); wiki/algorithms/alg-02, alg-03, alg-04, alg-05, alg-11.
// Зависимости (правило слоёв §14 B4): всё ниже `index` в цепочке, а также `ledger` (`inputs_hash`). Модуль чистый:
// ни часов, ни случайности, ни ввода-вывода; `as_of` приходит аргументом. Расчёт по введённым данным и правилам, не консультация.

import { fail, assert_minor, sum_minor } from './money.mjs';
import { to_epoch_day, make_calendar, format_date } from './dates.mjs';
import { rate_at, rate_status } from './fx.mjs';
import {
  normalize_ws, opening_state, active_operating_currencies, anchor_status, rule_statuses, readiness, build_events_ex, project, answer_q1,
  default_wave_threshold, normalize_mode, HORIZON_DAYS_MAX,
} from './timeline.mjs';
import { reserve_open, contribution_allocations, contribution_dates, contribution_plan, reserve_series, free_series } from './sinking.mjs';
import { list_waves_ex } from './waves.mjs';
import { canon, inputs_hash as hash_inputs } from './ledger.mjs';
import { vdefault as vd } from './param_defaults.mjs';

export * from './money.mjs';
export * from './dates.mjs';
export * from './recurrence.mjs';
export * from './hourly.mjs';
export * from './fx.mjs';
export * from './tax.mjs';
export * from './debt.mjs';
export * from './calibration.mjs';
export * from './timeline.mjs';
export * from './sinking.mjs';
export * from './waves.mjs';
export * from './afford.mjs';
export * from './ledger.mjs';

/** Версия движка: входит в `inputs_hash` (D-21) и в `seed` Монте-Карло; меняется вместе с намеренной правкой арифметики (замок `arith.lock`). */
export const ENGINE_VERSION = '0.1.0';

/** @typedef {import('./money.mjs').Minor} Minor */
/** @typedef {import('./dates.mjs').EpochDay} EpochDay */
/** @typedef {import('./timeline.mjs').CashEvent} CashEvent */
/** @typedef {import('./timeline.mjs').Q1Answer} Q1Answer */
/**
 * Ряд режима с резервами и свободным остатком (§3.9, C-012): `i ↔ from + i`; `close[−1] := opening_minor`, `reserve_close[−1] := reserve_opening_minor`.
 * @typedef {object} SeriesFull
 * @property {EpochDay} from
 * @property {Minor} opening_minor
 * @property {Minor} reserve_opening_minor `Σ funded_open_minor` резервов не привязанных к счёту (после `reserve_open`, C-020)
 * @property {Minor[]} close остаток на конец дня
 * @property {Minor[]} trough остаток после расходов дня, до его доходов
 * @property {Minor[]} reserve_trough резервы «на момент до доходов дня»
 * @property {Minor[]} reserve_close резервы на конец дня (с аллокациями от доходов дня)
 * @property {Minor[]} free `trough − reserve_trough`
 */
/**
 * Контекст расчёта `Analysis` (= `ctx` потребителей, C-012). Режимы — по `query.modes` (по умолчанию `plan` и `worse`).
 * @typedef {object} Analysis
 * @property {EpochDay} as_of
 * @property {EpochDay} horizon_end
 * @property {string} decision_currency
 * @property {Object<string, any>} params плоские параметры §2.0 с умолчаниями; `wave.threshold_minor` и `buffer_minor` — действующие в этом вызове
 * @property {Minor|null} buffer_minor `query.buffer_minor ?? ws.params.buffer_minor`; `null` — не задан (Q3 и «можно потратить» не отвечают)
 * @property {{plan?: CashEvent[], worse?: CashEvent[]}} events эффективные события режимов (`date` — эффективная, `plan_date` — до режима)
 * @property {{plan?: SeriesFull, worse?: SeriesFull}} series
 * @property {{plan?: {reserve_trough: Minor[], reserve_close: Minor[], by_reserve: object}, worse?: object}} reserve результат `sinking.reserve_series`
 * @property {{plan?: Q1Answer|{beyond_horizon: true}, worse?: Q1Answer|{beyond_horizon: true}}} q1 ответ Q1 на `query.D` (по умолчанию `horizon_end`)
 * @property {object[]} wave_overrides ручные правки волн в порядке применения (`seq`)
 * @property {{score: number, level: string, reasons: string[]}} readiness готовность данных (D-23)
 * @property {{level: 'fresh'|'banner'|'block', reason?: string, age: number|null, unaccounted_minor: Minor|null, rate_minor: Minor|null, stale_accounts: object[]}} anchor_status
 * @property {Object<string, 'fresh'|'stale'|'disabled'>} rule_status `tax_rule_id → статус` на `as_of` (C-023)
 * @property {{code: string}[]} warnings уникальные предупреждения (`W_*`), по `(code, содержимое)`
 * @property {string} inputs_hash `sha256(canon(окно входов))`, 64 hex-знака (D-21)
 * @property {string} engine_version
 */

const MODES_DEFAULT = ['plan', 'worse'];

function cmp_str(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Горизонт запроса (§14 B3): `horizon_end`, иначе `as_of + horizon_days` (запрос → параметры → 180). */
function resolve_horizon(P, as_of, query) {
  let hz;
  if (query.horizon_end !== undefined && query.horizon_end !== null) {
    hz = to_epoch_day(query.horizon_end);
    if (hz - as_of > HORIZON_DAYS_MAX) fail('E_SCHEMA', { reason: 'horizon_end_out_of_range', days: hz - as_of, max: HORIZON_DAYS_MAX });
  } else {
    const days = query.horizon_days ?? P.horizon_days;
    if (!Number.isSafeInteger(days) || days < 0) fail('E_SCHEMA', { reason: 'bad_horizon_days', value: String(days) });
    if (days > HORIZON_DAYS_MAX) fail('E_SCHEMA', { reason: 'horizon_days_out_of_range', value: String(days), max: HORIZON_DAYS_MAX }); // К-4 (Q-12, REQ-158)
    hz = as_of + days;
  }
  if (hz < as_of) fail('E_BAD_DATE', { reason: 'horizon_end_before_as_of', as_of, horizon_end: hz });
  return hz;
}

/** Список в каноническом порядке (множество): по каноническому JSON элементов. */
function as_set(list) {
  return list.map((x) => [canon(x), x]).sort((p, q) => cmp_str(p[0], q[0])).map((p) => p[1]);
}

/** Ручные правки волн в порядке `seq` (если он задан у всех записей), иначе порядок входа. */
function ordered_wave_overrides(list) {
  if (list.length > 1 && list.every((o) => Number.isSafeInteger(o?.seq))) {
    return list.map((o, i) => [o, i]).sort((a, b) => (a[0].seq - b[0].seq) || (a[1] - b[1])).map((p) => p[0]);
  }
  return [...list];
}

/** Календарь резерва: `calendar_id` резерва или его `cadence`, иначе первый календарь рабочей области, иначе выходные сб/вс. */
function reserve_calendar(w, r) {
  const id = r.calendar_id ?? r.cadence?.calendar_id ?? null;
  const spec = id === null ? w.calendars[0] : w.calendars.find((c) => c.calendar_id === id);
  if (id !== null && spec === undefined) fail('E_SCHEMA', { reason: 'unknown_calendar', calendar_id: String(id) });
  return make_calendar(spec === undefined ? {} : spec);
}

/** Уникальные предупреждения: по каноническому JSON, порядок — `(code, содержимое)`. */
function unique_warnings(list) {
  const seen = new Map();
  for (const x of list) seen.set(canon(x), x);
  return [...seen.entries()].sort((p, q) => cmp_str(p[0], q[0])).map((p) => p[1]);
}

/**
 * Предупреждения по резервам `sinking` (ALG-05, C-030, C-059): `W_RESERVE_BEHIND` — плановые взносы до `as_of`, которые не записаны;
 * `W_RESERVE_RESIDUAL` — срок прошёл, платёж, привязанный к резерву, был, а остаток остаётся (освобождается только вручную);
 * `W_RESERVE_OVERDUE` — срок прошёл, привязанного платежа нет, а деньги зарезервированы.
 */
function reserve_warnings(w, reserves, as_of, recorded_ids) {
  const out = [];
  for (const r of reserves) {
    if (r.kind !== 'sinking' || (r.backed_by_account_id !== null && r.backed_by_account_id !== undefined)) continue;
    const from = r.funded_as_of === undefined || r.funded_as_of === null ? -Infinity : to_epoch_day(r.funded_as_of);
    const due = r.due_date === undefined || r.due_date === null ? null : to_epoch_day(r.due_date);
    const reached = r.target_minor !== undefined && r.target_minor !== null && r.funded_open_minor >= r.target_minor;
    if ((r.mode === 'refill_to_target' || r.mode === 'fixed') && !reached) {
      const start = Number.isFinite(from) ? from + 1 : as_of;
      const stop = due === null ? as_of : Math.min(as_of, due);
      const dates = contribution_dates(start, stop, r.cadence ?? { freq: 'M', day: 1 }, reserve_calendar(w, r));
      const prefix = 'sch:' + r.reserve_id + '@';
      const missed = dates.filter((d) => d < as_of && !recorded_ids.has(prefix + format_date(d)));
      if (missed.length > 0) {
        // числа предупреждения (Q-09, C-030): сколько взносов не подтверждено и на какую сумму; прежние поля не меняются
        let missed_minor;
        if (r.mode === 'fixed') {
          missed_minor = assert_minor((r.fixed_minor ?? 0) * missed.length);
        } else {
          // refill_to_target: доли графика от текущего funded_open по ВСЕМ неподтверждённым датам до срока; считаются первые missed.length строк
          const all = contribution_dates(start, due ?? as_of, r.cadence ?? { freq: 'M', day: 1 }, reserve_calendar(w, r)).filter((d) => !recorded_ids.has(prefix + format_date(d)));
          const rows = contribution_plan({ target_minor: r.target_minor, funded_open_minor: r.funded_open_minor ?? 0, dates: all, mode: 'refill_to_target' });
          missed_minor = sum_minor(rows.filter((x) => x.date < as_of).map((x) => x.amount_minor));
        }
        out.push({ code: 'W_RESERVE_BEHIND', reserve_id: r.reserve_id, missed_count: missed.length, missed_minor });
      }
    }
    if (due !== null && due <= as_of && r.funded_open_minor > 0) {
      const paid = w.facts.some((f) => f.reserve_id === r.reserve_id && f.amount_minor < 0 && f.date > from && f.date <= as_of);
      out.push({ code: paid ? 'W_RESERVE_RESIDUAL' : 'W_RESERVE_OVERDUE', reserve_id: r.reserve_id });
    }
  }
  return out;
}

/**
 * `W_RATE_STALE` (D-20, X11, REQ-079): курс spot валюты operating-счёта старше `fx.stale_days` (по умолчанию из словаря `vocab.json`, FP-17) — плашка, расчёт не блокируется.
 * Возраст — `as_of − date` найденного курса пары `валюта → валюта решения`; ровно `stale_days` — ещё не устарел. Пары без курса здесь молчат
 * (их отсутствие — `E_NO_RATE` в самом расчёте).
 */
function rate_warnings(w, as_of, P) {
  const stale_days = Number.isSafeInteger(P['fx.stale_days']) && P['fx.stale_days'] >= 0 ? P['fx.stale_days'] : vd('fx.stale_days');
  const out = [];
  for (const cur of active_operating_currencies(w, as_of)) {
    if (cur === w.decision_currency) continue;
    const r = rate_at(w.rates, cur, w.decision_currency, as_of);
    if (r !== null && rate_status(r, as_of, stale_days).stale) out.push({ code: 'W_RATE_STALE', currency: cur });
  }
  return out;
}

/**
 * Фасад движка: единый расчёт рабочей области на `as_of` (D-21). Шаги: опорный остаток и свежесть якоря → для каждого режима события
 * (`build_events_ex`: правила, потоки, разовые, долги, сценарий, валюта решения, режим), ряды `close`/`trough` (`project`), резервы
 * (`reserve_open` → взносы `sinking` + налоговые аллокации → `reserve_series`) и `free` → Q1 на `D`; готовность, статусы правил,
 * предупреждения, `inputs_hash`.
 *
 * `query` (§14 B3): `as_of` — обязателен (IsoDate или EpochDay); горизонт — `horizon_end` или `horizon_days` (если оба — `horizon_end`;
 * по умолчанию `ws.params.horizon_days`, иначе 180); `scenario` — встроенный объект сценария, `scenario_id` — ссылка на сохранённый
 * (если оба — `scenario`); `D` — дата для `q1` (по умолчанию `horizon_end`); `buffer_minor` перекрывает `ws.params.buffer_minor` только
 * для этого вызова; `modes` — по умолчанию `['plan', 'worse']`.
 *
 * Условия: буфер не задан (`null`) — Q1 и волны считают `B = 0` и несут `W_BUFFER_UNSET`, а гейт Q3/«можно потратить» отвечает `no_buffer`;
 * нет ни налоговых правил, ни резервов, но есть доход — `W_NO_RESERVES` (число посчитано по физическим деньгам, `free = trough`).
 * Числа G-001 воспроизводятся при явном горизонте 57 дн. (`params.horizon_days = 57`, §12 X2).
 * @param {object} ws рабочая область (форма — в заголовке timeline.mjs; поля Workspace и проекции журнала)
 * @param {{as_of: EpochDay|string, horizon_end?: EpochDay|string, horizon_days?: number, scenario?: object, scenario_id?: string,
 *   D?: EpochDay|string, buffer_minor?: Minor|null, modes?: ('plan'|'worse'|'conservative')[]}} query
 * @returns {Analysis}
 * @throws {RunwayError} E_SCHEMA, E_BAD_DATE (`D < as_of`, горизонт раньше `as_of`), E_FUTURE_POSTED, E_NO_RATE, E_CURRENCY_MISMATCH,
 *   E_RULE_INVALID, E_NOT_INTEGER (нецелое число в данных, `inputs_hash` не строится от float)
 */
export function analyze(ws, query) {
  if (query === null || typeof query !== 'object' || query.as_of === undefined || query.as_of === null) fail('E_SCHEMA', { reason: 'query_as_of_required' });
  const w = normalize_ws(ws);
  if (w.decision_currency === null) fail('E_SCHEMA', { reason: 'decision_currency_unknown' });
  const as_of = to_epoch_day(query.as_of);
  const P = { ...w.params };
  const horizon_end = resolve_horizon(P, as_of, query);
  const modes = [...new Set((query.modes ?? MODES_DEFAULT).map(normalize_mode))];
  const D = query.D === undefined || query.D === null ? horizon_end : to_epoch_day(query.D);
  let buffer = query.buffer_minor !== undefined && query.buffer_minor !== null ? query.buffer_minor : (P.buffer_minor ?? null);
  if (buffer !== null) {
    buffer = assert_minor(buffer);
    if (buffer < 0) fail('E_SCHEMA', { reason: 'buffer_negative', value: buffer });
  }
  P.buffer_minor = buffer;
  if (P['wave.threshold_minor'] === undefined || P['wave.threshold_minor'] === null) P['wave.threshold_minor'] = default_wave_threshold(ws, as_of);
  P.decision_currency = w.decision_currency;

  // сценарий курса (fx_shock) действует и на остатки счетов: остаток и поток одного сценария — по одному курсу (B-BUG-1)
  const scenario_obj = query.scenario ?? (query.scenario_id === undefined || query.scenario_id === null ? null
    : (w.scenarios.find((x) => x.scenario_id === query.scenario_id) ?? null));
  const os = opening_state(ws, as_of, scenario_obj);
  const recorded = w.allocations;
  const recorded_ids = new Set(recorded.map((a) => a.allocation_id));
  const reserves = w.reserves.map((r) => ({ ...r, funded_open_minor: reserve_open(r, recorded, as_of) }));
  const open_reserves = reserves.filter((r) => r.backed_by_account_id === null || r.backed_by_account_id === undefined);
  const reserve_opening_minor = sum_minor(open_reserves.map((r) => r.funded_open_minor));
  const scheduled = reserves.filter((r) => r.kind === 'sinking')
    .flatMap((r) => contribution_allocations(r, r.funded_open_minor, as_of, horizon_end, reserve_calendar(w, r), recorded_ids));

  const events = {};
  const series = {};
  const reserve = {};
  const q1 = {};
  const warnings = [];
  for (const mode of modes) {
    const bx = build_events_ex(ws, { as_of, horizon_end, mode, scenario: query.scenario, scenario_id: query.scenario_id });
    const base = project(bx.events, os.opening_minor, as_of, horizon_end);
    const taxes = bx.allocations.filter((a) => !recorded_ids.has(a.allocation_id)); // записанные уже в funded_open (идемпотентность, C-020)
    const rs = reserve_series(reserves, bx.events, [...taxes, ...scheduled], as_of, horizon_end);
    events[mode] = bx.events;
    series[mode] = {
      from: base.from,
      opening_minor: base.opening_minor,
      reserve_opening_minor,
      close: base.close,
      trough: base.trough,
      reserve_trough: rs.reserve_trough,
      reserve_close: rs.reserve_close,
      free: free_series(base.trough, rs.reserve_trough),
    };
    reserve[mode] = rs;
    q1[mode] = answer_q1(series[mode], D, buffer);
    warnings.push(...bx.warnings);
  }

  const ctx = {
    as_of,
    horizon_end,
    decision_currency: w.decision_currency,
    params: P,
    buffer_minor: buffer,
    events,
    series,
    reserve,
    q1,
    wave_overrides: ordered_wave_overrides(w.wave_overrides),
    readiness: readiness(ws, as_of),
    anchor_status: anchor_status(ws, as_of),
    rule_status: rule_statuses(ws, as_of),
    warnings: [],
    inputs_hash: '',
    engine_version: ENGINE_VERSION,
  };

  if (buffer === null) warnings.push({ code: 'W_BUFFER_UNSET' });
  const has_income = modes.some((m) => events[m].some((e) => e.kind === 'income' && e.amount_minor > 0));
  if (has_income && w.tax_rules.length === 0 && w.reserves.length === 0) warnings.push({ code: 'W_NO_RESERVES' });
  warnings.push(...reserve_warnings(w, reserves, as_of, recorded_ids));
  warnings.push(...rate_warnings(w, as_of, P));
  for (const mode of modes) warnings.push(...list_waves_ex(ctx, mode).warnings);
  ctx.warnings = unique_warnings(warnings);

  ctx.inputs_hash = hash_inputs({
    events: {
      accounts: as_set(w.accounts), anchors: as_set(w.anchors), facts: as_set(w.facts), plans: as_set(w.plans), overrides: as_set(w.overrides),
      allocations: as_set(w.allocations), rates: as_set(w.rates), debts: as_set(w.debts), purchases: as_set(w.purchases),
    },
    rules: {
      rules: as_set(w.rules), streams: as_set(w.streams), tax_rules: as_set(w.tax_rules), reserves: as_set(w.reserves),
      calendars: as_set(w.calendars), scenarios: as_set(w.scenarios), wave_overrides: ctx.wave_overrides,
    },
    params: P,
    as_of,
    horizon_end,
    D,
    modes,
    scenario: query.scenario ?? null,
    scenario_id: query.scenario_id ?? null,
    engine_version: ENGINE_VERSION,
  });
  return ctx;
}
