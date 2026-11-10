// metrics_feed.mjs — окна прогноза кормят метрики на устройстве (FP-22, REQ-185, ALG-13, C-055, C-066): ошибка минимума и покрытие коридора «k из n».
//
// Зачем. `metrics.record_min_error` и `record_coverage` (FP-10) существовали, но их вызывали только тесты: экран «Метрики» всегда показывал «нет данных» по этим двум строкам.
// Здесь они получают настоящие значения — из окон прогноза, которые приложение само открывает и закрывает.
//
// Что такое окно. Окно открывается в день расчёта `as_of`, когда прогноз показывается (готовность `s ≥ ready.q1`): приложение запоминает на устройстве три числа
// «как знали тогда» — минимум `trough` режима `plan` за `backtest.min_window_days` дней (14), остаток на конец окна по режимам `plan` и `worse` — и список operating-счетов,
// существовавших в этот день (`accts`: только идентификаторы). Окно закрывается, когда «сегодня» дошло до конца окна (`as_of ≥ начало + 14`) И сверка остатка подтверждает, что
// факты окна полны (`reconciled_through`): КАЖДЫЙ operating-счёт из `accts`, всё ещё открытый, имеет якорь с датой от конца окна до «сегодня», а расхождение (дрейф) каждого якоря
// этого счёта внутри окна и этого якоря с записями — предыдущий якорь плюс внесённые факты — не больше допуска (`tolerance_minor`, по умолчанию 0: в минимальных единицах счёта сумма точная).
// Якорь счёта, которого не было в начале окна (новый счёт с остатком), окно не закрывает; якорь, расходящийся с фактами (в банке на 1 500,00 € меньше, чем следует из записей), тоже:
// окно остаётся открытым, пока недостающие факты не внесены, — иначе минимум окна считался бы по неполным фактам. Закрытие сравнивает прогноз с фактом по полному журналу
// (`backtest.actual_rows`, те же правила, что у backtest ALG-13): ошибка минимума `(факт − прогноз)/|прогноз|` в bp (`metrics.record_min_error`) и «факт в коридоре `plan`–`worse`»
// (`metrics.record_coverage`). Если набор operating-счетов за окно изменился (счёт добавлен внутри окна или перестал быть operating), прогноз и факт несопоставимы: окно закрывается
// без записи в метрики (`accounts_changed`). Затем открывается следующее окно. Встроенные демо-наборы ленту не кормят (решает пакет `pack_fp22`: метрики пользователя не смешиваются с демо).
//
// Что хранится. Пакет `runway-metrics/1` по-прежнему без сумм и дат: в него попадают только bp и «k из n». Рабочее состояние окон (начало, три числа прогноза) — НЕ метрика, а
// служебная запись на этом устройстве под ключом `runway-metrics-feed/1` (префикс `runway`: её стирает «Удалить все данные»; чужие ключи общего localhost не трогаются). Она не уходит
// в журнал, в экспорт и в файл метрик. Окна не пересекаются: `through` (конец последнего закрытого окна) не даёт открыть окно раньше него, поэтому «Отменить» и возврат «сегодня»
// назад не считают один и тот же период дважды. Выключенный счёт метрик (`metrics.enabled() === false`) и остановка метрик после «Удалить все данные» (`metrics.status().halted`) окон не открывают и не закрывают.
//
// Модуль без DOM и без часов: рабочая область, метрики и хранилище приходят аргументами. Расчёт по введённым данным и правилам, не консультация.

import { analyze, to_epoch_day } from '../engine/index.mjs';
import { actual_rows } from '../engine/backtest.mjs';
import { vdefault } from '../engine/param_defaults.mjs';
import { reconcile_preview } from './anchor_dialog.mjs'; // дрейф якоря считается так, как его показывает диалог «Сверить остаток»: предыдущий якорь плюс факты

/** Ключ localStorage с состоянием окон (префикс `runway` — его стирает «Удалить все данные»). */
export const FEED_KEY = 'runway-metrics-feed/1';

/** Длина окна, дней: `backtest.min_window_days` словаря (гипотеза до первого замера на людях, C-055). */
export const WINDOW_DAYS = vdefault('backtest.min_window_days');

/** Сколько рабочих областей помнит состояние (старейшая вытесняется). */
export const MAX_ITEMS = 16;

/** Сколько operating-счетов запоминает окно (идентификаторы; лишние отбрасываются). */
export const MAX_ACCTS = 64;

const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const is_int = (x) => Number.isSafeInteger(x);
const is_day = (x) => is_int(x) && x >= 0 && x <= 200_000;
const KEY_BAD = /[^A-Za-z0-9_.:~@/-]/g;
const BAD_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const ID_OK = /^[^\u0000-\u001f\u007f]{1,64}$/u;

/** Ключ рабочей области в состоянии: `workspace_id`, очищенный от знаков вне допустимого набора и не длиннее 64. */
export function ws_key(ws) {
  const raw = typeof ws?.workspace_id === 'string' && ws.workspace_id !== '' ? ws.workspace_id : '-';
  const k = raw.replace(KEY_BAD, '?').slice(0, 64);
  return BAD_NAMES.has(k) ? '?' + k : k;
}

// ── окно: открыть и закрыть ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Минимум массива целых.
 * @param {number[]} xs
 */
function min_of(xs) {
  let m = xs[0];
  for (let i = 1; i < xs.length; i++) if (xs[i] < m) m = xs[i];
  return m;
}

/**
 * Открыть окно прогноза на дату расчёта: прогноз «как знали тогда» — минимум `trough` режима `plan` за первые `days` дней и остаток на конец окна по режимам `plan` и `worse`.
 * Прогноз считается по рабочей области без сценария (сценарий — гипотеза пользователя, а не прогноз приложения). Вместе с прогнозом запоминаются идентификаторы
 * operating-счетов, открытых в день начала (`accts`): сверкой окна считается только якорь такого счёта. Не бросает.
 * @param {object} ws
 * @param {number} [days] длина окна (по умолчанию `WINDOW_DAYS`)
 * @returns {{ok: true, open: {start: number, days: number, f_min: number, f_close: number, w_close: number, accts: string[]}} | {ok: false, reason: string}}
 */
export function open_window(ws, days = WINDOW_DAYS) {
  if (!is_obj(ws) || typeof ws.as_of !== 'string') return { ok: false, reason: 'no_workspace' };
  if (!Number.isSafeInteger(days) || days < 1 || days > 400) return { ok: false, reason: 'bad_days' };
  let start;
  let a;
  try {
    start = to_epoch_day(ws.as_of);
    a = analyze(ws, { as_of: start, horizon_end: start + days });
  } catch (e) { return { ok: false, reason: typeof e?.code === 'string' ? e.code.slice(0, 32) : 'analyze_failed' }; }
  const plan = a.series.plan;
  const worse = a.series.worse;
  // как в backtest: окно ошибки минимума — min(min_window_days, h + 1) дней; здесь шаг h равен длине окна, поэтому ровно `days` дней
  if (plan.trough.length < days || plan.close.length <= days || worse.close.length <= days) return { ok: false, reason: 'horizon_short' };
  const accts = [...new Set(open_operating(ws, start).filter((id) => ID_OK.test(id)))].slice(0, MAX_ACCTS);
  return { ok: true, open: { start, days, f_min: min_of(plan.trough.slice(0, days)), f_close: plan.close[days], w_close: worse.close[days], accts } };
}

/** Идентификаторы operating-счетов, открытых на день `d` (эпохальный день). */
function open_operating(ws, d) {
  const list = Array.isArray(ws?.accounts) ? ws.accounts : [];
  const day_of = (iso) => { try { return typeof iso === 'string' ? to_epoch_day(iso) : null; } catch { return null; } };
  return list.filter((a) => {
    if (!is_obj(a) || a.liquidity !== 'operating' || typeof a.account_id !== 'string') return false;
    const closed = day_of(a.closed_on);
    const opened = day_of(a.opened_on);
    return !(closed !== null && closed <= d) && !(opened !== null && opened > d);
  }).map((a) => a.account_id);
}

/**
 * Сверен ли счёт: идём по его якорям с датой после начала окна и не позже «сегодня» по возрастанию; расхождение якоря с записями (`reconcile_preview`: предыдущий якорь плюс факты
 * счёта) больше допуска означает, что факты до этой даты неполны, — счёт не сверен; первый согласованный якорь с датой от конца окна — сверка есть.
 */
function account_reconciled(ws, account_id, start, end, as_of, tolerance_minor) {
  const mine = [];
  for (const x of Array.isArray(ws.anchors) ? ws.anchors : []) {
    if (!is_obj(x) || x.account_id !== account_id || typeof x.date !== 'string') continue;
    let d;
    try { d = to_epoch_day(x.date); } catch { continue; }
    if (d > start && d <= as_of) mine.push({ d, x });
  }
  mine.sort((a, b) => a.d - b.d);
  for (const { d, x } of mine) {
    let drift;
    try { drift = reconcile_preview(ws, { account_id, amount_minor: x.amount_minor, date: x.date }).drift_minor; } catch { return false; }
    if (!Number.isSafeInteger(drift) || Math.abs(drift) > tolerance_minor) return false;
    if (d >= end) return true;
  }
  return false;
}

/**
 * Окно можно закрыть: «сегодня» дошло до его конца и остаток сверен на КАЖДОМ operating-счёте, который был в начале окна (`open.accts`) и ещё открыт: у счёта есть якорь с датой
 * от конца окна до «сегодня», и расхождение якорей счёта внутри окна с внесёнными фактами не больше допуска. Якорь нового счёта (его не было в начале окна) окно не закрывает;
 * якорь, не сходящийся с записями, — тоже (факты окна неполны). Окно прежней версии без списка счетов закрыть нельзя.
 * @param {object} ws
 * @param {{start: number, days: number, accts?: string[]}} open
 * @param {{tolerance_minor?: number}} [opts] допуск расхождения якоря с записями, минимальные единицы счёта (по умолчанию 0)
 * @returns {boolean}
 */
export function reconciled_through(ws, open, opts = {}) {
  if (!is_obj(ws) || typeof ws.as_of !== 'string' || !is_obj(open) || !Array.isArray(open.accts)) return false;
  const tolerance_minor = Number.isSafeInteger(opts?.tolerance_minor) && opts.tolerance_minor >= 0 ? opts.tolerance_minor : 0;
  let as_of;
  try { as_of = to_epoch_day(ws.as_of); } catch { return false; }
  const end = open.start + open.days;
  if (as_of < end) return false;
  const ops_now = new Set(open_operating(ws, as_of));
  const required = open.accts.filter((id) => ops_now.has(id));
  if (required.length === 0) return false;
  return required.every((id) => account_reconciled(ws, id, open.start, end, as_of, tolerance_minor));
}

/**
 * Набор operating-счетов за окно изменился: счёт, которого не было в начале окна, действовал в окне (открыт не позже его конца и не закрыт до начала), либо счёт из начала окна
 * перестал быть operating или исчез. Прогноз «как знали тогда» и факт тогда несопоставимы.
 */
function accounts_changed(ws, open) {
  const end = open.start + open.days;
  const known = new Set(Array.isArray(open.accts) ? open.accts : []);
  const day_of = (iso) => { try { return typeof iso === 'string' ? to_epoch_day(iso) : null; } catch { return null; } };
  const operating = new Set();
  for (const a of Array.isArray(ws?.accounts) ? ws.accounts : []) {
    if (!is_obj(a) || a.liquidity !== 'operating' || typeof a.account_id !== 'string') continue;
    operating.add(a.account_id);
    if (known.has(a.account_id)) continue;
    const opened = day_of(a.opened_on);
    const closed = day_of(a.closed_on);
    if ((opened === null || opened <= end) && !(closed !== null && closed <= open.start)) return true;
  }
  for (const id of known) if (!operating.has(id)) return true;
  return false;
}

/**
 * Сравнить прогноз окна с фактом по полному журналу (правила backtest ALG-13): минимум фактического `trough` за те же дни и остаток на конец окна.
 * Набор operating-счетов за окно изменился (`accounts_changed`) — сравнивать нечего: отказ с кодом, в метрики ничего не пишется.
 * @param {object} ws
 * @param {{start: number, days: number, f_min: number, f_close: number, w_close: number, accts?: string[]}} open
 * @returns {{ok: true, a_min: number, act: number, lo: number, hi: number, inside: boolean} | {ok: false, reason: string}}
 */
export function settle_window(ws, open) {
  if (accounts_changed(ws, open)) return { ok: false, reason: 'accounts_changed' };
  let rows;
  try { rows = actual_rows(ws, open.start, open.start + open.days); } catch (e) { return { ok: false, reason: typeof e?.code === 'string' ? e.code.slice(0, 32) : 'actual_failed' }; }
  const a_min = min_of(rows.trough.slice(0, open.days));
  const act = rows.close[open.days];
  const lo = Math.min(open.f_close, open.w_close);
  const hi = Math.max(open.f_close, open.w_close);
  return { ok: true, a_min, act, lo, hi, inside: lo <= act && act <= hi };
}

/** Готов ли прогноз к показу (`s ≥ ready.q1`) по модели страницы (`ctx.get_model()`); без модели — нет. */
export function forecast_ready(model) {
  const a = model?.ctx;
  const score = a?.readiness?.score;
  return Number.isSafeInteger(score) && score >= (a?.params?.['ready.q1'] ?? 3);
}

// ── состояние на устройстве ───────────────────────────────────────────────────────────────────────────────────────────────

function accept_open(x) {
  if (x === null) return null;
  if (!is_obj(x) || !is_day(x.start) || !is_int(x.days) || x.days < 1 || x.days > 400 || !is_int(x.f_min) || !is_int(x.f_close) || !is_int(x.w_close)) return undefined;
  // окно прежней версии без списка счетов: проверить, чья сверка закрывает окно, нечем — окно считается не открытым и откроется заново
  if (x.accts === undefined) return null;
  if (!Array.isArray(x.accts) || x.accts.length > MAX_ACCTS || x.accts.some((id) => typeof id !== 'string' || !ID_OK.test(id))) return undefined;
  return { start: x.start, days: x.days, f_min: x.f_min, f_close: x.f_close, w_close: x.w_close, accts: [...new Set(x.accts)] };
}

/** Привести прочитанное из хранилища к допустимому состоянию; испорченное или чужое — пустое. Записи с негодной формой отбрасываются по одной. */
export function accept_state(raw) {
  let x;
  try { x = JSON.parse(raw); } catch { return { items: [] }; }
  if (!is_obj(x) || x.v !== 1 || !Array.isArray(x.items)) return { items: [] };
  const items = [];
  for (const it of x.items.slice(0, MAX_ITEMS)) {
    if (!is_obj(it) || typeof it.ws !== 'string' || it.ws === '' || it.ws.length > 64 || BAD_NAMES.has(it.ws)) continue;
    const open = accept_open(it.open ?? null);
    const through = it.through === null || it.through === undefined ? null : (is_day(it.through) ? it.through : undefined);
    if (open === undefined || through === undefined) continue;
    if (items.some((p) => p.ws === it.ws)) continue;
    items.push({ ws: it.ws, through, open });
  }
  return { items };
}

/**
 * Лента окон прогноза → метрики.
 * @param {{storage?: {getItem: Function, setItem: Function}|null, metrics: {enabled: Function, record_min_error: Function, record_coverage: Function}, days?: number, tolerance_minor?: number}} deps
 *   `storage` — localStorage (или `null`: состояние живёт в памяти страницы); `metrics` — экземпляр метрик приложения; `tolerance_minor` — допуск расхождения якоря с записями
 *   при сверке окна, минимальные единицы счёта (по умолчанию 0: банковский остаток в целых минимальных единицах сходится точно)
 */
export function create_feed(deps) {
  const storage = deps.storage ?? null;
  const metrics = deps.metrics;
  const days = deps.days ?? WINDOW_DAYS;
  const tolerance_minor = deps.tolerance_minor ?? 0;
  let mem = null;
  let seen = false; // ключ уже был записан и прочитан обратно этой страницей

  const load = () => {
    if (storage === null) { mem ??= { items: [] }; return mem; }
    let raw = null;
    try { raw = storage.getItem(FEED_KEY); } catch { raw = null; }
    if (typeof raw === 'string') { seen = true; mem = accept_state(raw); return mem; }
    if (seen) { seen = false; mem = { items: [] }; return mem; } // ключ исчез после записи («Удалить все данные»): начинаем заново, ничего не воскрешая
    mem ??= { items: [] }; // ключа не было (или хранилище-заглушка не хранит): состояние живёт в памяти страницы
    return mem;
  };
  const save = (st) => {
    mem = st;
    if (storage === null) return;
    const text = JSON.stringify({ v: 1, items: st.items });
    try {
      storage.setItem(FEED_KEY, text);
      seen = storage.getItem(FEED_KEY) === text; // заглушка, которая не хранит, остаётся «памятью страницы»
    } catch { seen = false; /* места нет: состояние остаётся в памяти страницы */ }
  };
  const put = (st, item) => {
    const rest = st.items.filter((p) => p.ws !== item.ws);
    return { items: [...rest, item].slice(-MAX_ITEMS) };
  };

  return {
    /** Состояние окна рабочей области: `{through, open}` (копия) или `null`. */
    peek(ws) {
      const it = load().items.find((p) => p.ws === ws_key(ws));
      return it === undefined ? null : { through: it.through, open: it.open === null ? null : { ...it.open } };
    },

    /**
     * Шаг ленты: вызывается после записи, смены набора данных и при запуске. Закрывает окно, если оно готово, открывает следующее, если прогноз показывается.
     * Не бросает. Выключенные метрики — ничего не делает.
     * @param {object} ws рабочая область после записи
     * @param {{ready?: boolean}} [opts] `ready` — прогноз показывается (`forecast_ready`)
     * @returns {{closed: null | {ok: true, error_bp: number|null, inside: boolean, a_min: number, act: number} | {ok: false, reason: string}, opened: boolean, skipped: string|null}}
     */
    step(ws, opts = {}) {
      const out = { closed: null, opened: false, skipped: null };
      try {
        if (!is_obj(ws) || typeof ws.as_of !== 'string') { out.skipped = 'no_workspace'; return out; }
        const status = typeof metrics.status === 'function' ? metrics.status() : null; // читает ключ метрик: исчезновение после записи («Удалить все данные») отмечает остановку
        if (status !== null && status.halted === true) { out.skipped = 'metrics_halted'; return out; } // данные удалены: до перезагрузки ничего не воскрешаем
        if (metrics.enabled() !== true) { out.skipped = 'metrics_off'; return out; }
        const as_of = to_epoch_day(ws.as_of);
        const key = ws_key(ws);
        let st = load();
        const had = st.items.find((p) => p.ws === key) ?? { ws: key, through: null, open: null };
        let item = { ws: key, through: had.through, open: had.open };
        let changed = false;
        if (item.open !== null && as_of < item.open.start) { item = { ...item, open: null }; changed = true; } // «сегодня» вернули раньше начала окна: окна из несуществующего будущего нет
        if (item.open !== null && reconciled_through(ws, item.open, { tolerance_minor })) {
          const s = settle_window(ws, item.open);
          if (s.ok) {
            const bp = metrics.record_min_error(item.open.f_min, s.a_min);
            metrics.record_coverage(s.inside);
            out.closed = { ok: true, error_bp: bp, inside: s.inside, a_min: s.a_min, act: s.act };
          } else out.closed = { ok: false, reason: s.reason };
          item = { ...item, through: item.open.start + item.open.days, open: null };
          changed = true;
        }
        if (item.open === null && opts.ready === true && (item.through === null || as_of >= item.through)) {
          const r = open_window(ws, days);
          if (r.ok) { item = { ...item, open: r.open }; out.opened = true; changed = true; } else out.skipped = r.reason;
        }
        if (changed) { st = put(st, item); save(st); }
      } catch (e) { out.skipped = typeof e?.code === 'string' ? e.code.slice(0, 32) : 'feed_failed'; }
      return out;
    },

    /** Забыть состояние страницы (хранилище не трогается: его стирает «Удалить все данные»). */
    reset_memory() { mem = null; },
  };
}
