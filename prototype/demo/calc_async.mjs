// calc_async.mjs — расчёт основных экранов («Обзор», «Купить», «Волны») через клиент воркера `create_calc_client` (FP-21, REQ-150).
// Служба без DOM: порты внедряются (`storage`, `has_worker`, `make_client`, `set_timeout`), модуль проверяется в Node на заглушке воркера и в потоке `worker_threads`.
// Это не замена синхронной модели приложения, а её асинхронный путь рядом с ней:
//   - `prepare(ws, queries, {screen})` заранее считает в Worker модель набора (`screen: 'waves'` — операция `waves`: расчёт плюс списки волн, иначе `project`; приложение просит `waves` всегда, потому что стартует на «Обзоре») и кладёт её в кэш по паре «рабочая область, запрос»;
//     `build_model` приложения берёт готовый расчёт через `take` (ровно один раз) вместо `analyze` на главном потоке. Что в кэше нет — считается на месте, как раньше;
//   - `afford(model, parts)` считает в Worker «деньги после покупки» («Купить», операция `afford`): ответ из кэша — сразу, иначе обещание; несколько запросов за кадр
//     дают один расчёт (последний), остальные получают `SUPERSEDED`. Очередь к Worker ограничена: «один в полёте и один свежий» — пока воркер считает прежний запрос,
//     новые только заменяют ожидающий (старые получают `SUPERSEDED`), воркеру уходит последний после ответа; к воркеру одновременно идёт один запрос (общая дорожка
//     `call_op`), поэтому таймаут клиента отсчитывается от начала обработки, а не от постановки в очередь. Если воркер упал или не ответил, на главном потоке считается
//     только актуальный запрос: вытесненный пропускается (`stale`), а не досчитывается подряд вместе со всей очередью;
//   - флаг устройства (`runway-calc-worker/1`) выключает Worker целиком: клиент останавливается, всё считается на главном потоке; после сбоя Worker (клиент признал его
//     негодным) служба неактивна до конца сеанса, пока флаг не переключат (выключить и включить — новый клиент).
// Результат Worker побайтно равен расчёту на месте (одни и те же чистые функции, `calc_worker.mjs`); при любом сбое Worker клиент считает на главном потоке и ввод не теряется.
// Запись данных через формы по-прежнему проверяется и считается на месте (`set_ws` отвечает отказом или успехом сразу): служба для них не используется.
// Модуль можно импортировать в Node без побочных эффектов: клиент создаётся при первом расчёте, хранилище читается при первом обращении к флагу.
// Расчёт по введённым данным и правилам, не консультация.

import { create_calc_client } from './worker_client.mjs';
import { run_project, run_waves, run_afford } from './calc_worker.mjs';

/** Расчёт на месте тем же кодом, что в воркере (запрос ждал кадра, а флаг успели снять или воркер признали негодным). */
const LOCAL_OPS = Object.freeze({ project: run_project, waves: run_waves, afford: run_afford });

/** Ключ флага на устройстве (префикс `runway`: «Удалить все данные» стирает его вместе с остальным). `'0'` — Worker выключен, всё остальное — включён. */
export const FLAG_KEY = 'runway-calc-worker/1';
/** «Кадр»: окно, в котором несколько запросов одного канала дают один расчёт, мс. */
export const FRAME_MS = 16;
/** Сколько ждать ответа воркера у службы, мс (короче, чем у клиента по умолчанию: пользователь смотрит на «Считаем…»; промах — откат на главный поток до конца сеанса). */
export const WORKER_TIMEOUT_MS = 8000;
/** Сколько ответов «Купить» хранить (повтор тех же суммы и даты отвечает сразу). */
export const CACHE_LIMIT = 32;
/** Ответ запроса, вытесненного более новым запросом того же кадра: рисовать по нему нечего. */
export const SUPERSEDED = Object.freeze({ superseded: true });

const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Канонический ключ значения: порядок ключей объекта не влияет. */
export function canon(x) {
  if (x === null || typeof x !== 'object') return JSON.stringify(x) ?? 'null';
  if (Array.isArray(x)) return '[' + x.map(canon).join(',') + ']';
  return '{' + Object.keys(x).filter((k) => x[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canon(x[k])).join(',') + '}';
}

/**
 * Запрос `analyze` для модели экрана: дата расчёта набора и (при сценарии) его операции — ровно то, что строит `build_model` приложения.
 * @param {object} ws
 * @param {{ops: object[]}|null} [scenario]
 */
export function model_query(ws, scenario = null) {
  const query = { as_of: ws.as_of };
  if (scenario !== null && scenario !== undefined) query.scenario = { ops: scenario.ops };
  return query;
}

/**
 * Контекст инструментов поверх готового расчёта — то же, что `make_tool_ctx(ws, query, opts)` делает после `analyze` (engine/tools.mjs): поля те же и в том же порядке
 * (проверяет tests/calc_async.test.mjs, JSON побайтно). Расчёт `analysis` дополняется на месте и возвращается.
 * @param {object} analysis результат `analyze` (в том числе из воркера)
 * @param {object} ws
 * @param {object} query запрос, по которому посчитан `analysis`
 * @param {{journal?: object[], call_log?: object, t1_enabled?: boolean, locale?: 'ru'|'en'}} [opts]
 */
export function ctx_from_analysis(analysis, ws, query, opts = {}) {
  return Object.assign(analysis, {
    ws,
    query: { ...query },
    journal: opts.journal ?? null,
    call_log: opts.call_log ?? {},
    tier: opts.t1_enabled === true ? 'T1' : 'T0',
    t1_enabled: opts.t1_enabled === true,
    calls_used: 0,
    locale: opts.locale ?? ws?.locale ?? 'ru',
    echo: [],
  });
}

/**
 * Служба расчёта экранов.
 * @param {{storage?: {getItem: Function, setItem: Function}|null, has_worker?: () => boolean, make_client?: () => object, set_timeout?: (fn: () => void, ms: number) => any,
 *   frame_ms?: number, timeout_ms?: number}} [deps]
 */
export function create_calc_service(deps = {}) {
  const get_storage = () => {
    if (deps.storage !== undefined) return deps.storage;
    try { return globalThis.localStorage ?? null; } catch { return null; }
  };
  const has_worker = deps.has_worker ?? (() => typeof globalThis.Worker === 'function');
  const make_client = deps.make_client ?? (() => create_calc_client({ timeout_ms: deps.timeout_ms ?? WORKER_TIMEOUT_MS }));
  const set_timer = deps.set_timeout ?? ((fn, ms) => setTimeout(fn, ms));
  const frame_ms = deps.frame_ms ?? FRAME_MS;

  let flag = null; // null — хранилище ещё не читали
  let client = null;
  let running = 0;
  const prepared = new WeakMap(); // рабочая область → Map(ключ запроса → расчёт)
  const waves_by_analysis = new WeakMap(); // расчёт → списки волн по режимам (операция `waves`)
  const afford_cache = new Map();
  const started = new Map(); // ключ → { promise, item } начатого расчёта «Купить» (повтор того же ключа присоединяется к нему)
  /** Канал очереди: `waiting` — запросы текущего кадра, `inflight` — расчёт, который сейчас у воркера, `fresh` — единственный ожидающий его конца (только у `single`-каналов). */
  const make_channel = (single) => ({ single, timer: null, waiting: [], inflight: null, fresh: null });
  const prepare_ch = make_channel(false);
  const afford_ch = make_channel(true);
  const channels = [prepare_ch, afford_ch];
  const stat = { requests: 0, coalesced: 0, cache_hits: 0, prepared: 0, taken: 0, skipped: 0 };

  const read_flag = () => {
    if (flag === null) {
      flag = true;
      try { if (get_storage()?.getItem(FLAG_KEY) === '0') flag = false; } catch { /* хранилище недоступно: по умолчанию включено */ }
    }
    return flag;
  };

  /** Почему служба не работает: `null` — работает; `'off'` (флаг), `'no_worker'` (в окружении нет Worker) или причина сбоя клиента (`FALLBACK_REASONS`, `'terminated'`). */
  function off_reason() {
    if (!read_flag()) return 'off';
    if (!has_worker()) return 'no_worker';
    return client === null ? null : client.stats().dead;
  }

  const ensure_client = () => { client ??= make_client(); return client; };

  let lane = Promise.resolve(); // дорожка к воркеру: одновременно у него один запрос, следующий уходит после ответа на прежний
  const no_op = () => {};
  /**
   * Операция в Worker или, если за время ожидания кадра и дорожки служба стала неактивной, на месте: флаг, снятый между запросом и расчётом, не должен запускать новый воркер.
   * Запросы идут по дорожке строго по одному, поэтому таймаут клиента считает время обработки, а не очереди. `o.stale()` — запрос уже вытеснен более новым: ни воркеру, ни главному
   * потоку он не нужен (результат `{result: null, skipped: true}`).
   * @param {'project'|'waves'|'afford'} op
   * @param {object[]} args аргументы операции клиента (`ws, query[, parts]`)
   * @param {{stale?: () => boolean}} [o]
   * @returns {Promise<{result: object, via: 'worker'|'main', reason: string|null} | {result: null, via: 'main', reason: string|null, skipped: true}>}
   */
  function call_op(op, args, o = {}) {
    const run = () => {
      if (typeof o.stale === 'function' && o.stale() === true) return { result: null, via: 'main', reason: null, skipped: true };
      const why = off_reason();
      if (why === null) return ensure_client()[op](...args, o);
      return { result: LOCAL_OPS[op](...args), via: 'main', reason: why };
    };
    const p = lane.then(run);
    lane = p.then(no_op, no_op);
    return p;
  }

  function drop_client() {
    const c = client;
    client = null;
    try { c?.terminate(); } catch { /* уже остановлен */ }
  }

  // ── кадр: несколько запросов канала дают один расчёт ─────────────────────────────────────────────────────────────

  /** Начать расчёт запроса канала; по его окончании (любом) начинается ожидающий свежий. */
  function start(ch, item) {
    running += 1;
    ch.inflight = item;
    Promise.resolve().then(() => item.job(item)).then(item.resolve, item.reject).finally(() => {
      running -= 1;
      ch.inflight = null;
      const next = ch.fresh;
      ch.fresh = null;
      if (next !== null) start(ch, next);
    });
  }

  function flush(ch) {
    ch.timer = null;
    const batch = ch.waiting;
    ch.waiting = [];
    if (batch.length === 0) return; // кадр опустел: ответ из кэша или присоединение к идущему расчёту вытеснили всё, что в нём стояло
    const last = batch[batch.length - 1];
    stat.coalesced += batch.length - 1;
    for (const w of batch.slice(0, -1)) w.resolve(SUPERSEDED);
    if (ch.single && ch.inflight !== null) { // воркер ещё считает прежний запрос: свежий ждёт его конца, следующий свежий заменит ожидающего
      if (ch.fresh !== null) { stat.coalesced += 1; ch.fresh.resolve(SUPERSEDED); }
      ch.fresh = last;
      return;
    }
    start(ch, last);
  }

  /** Поставить расчёт в канал: за `delay` мс побеждает последний запрос, остальные получают `SUPERSEDED`. Задача получает запись запроса (`item`). */
  function submit(ch, delay, job) {
    stat.requests += 1;
    return new Promise((resolve, reject) => {
      ch.waiting.push({ job, resolve, reject, joined: false });
      if (ch.timer === null) ch.timer = set_timer(() => flush(ch), delay);
    });
  }

  /** Пришёл более новый запрос, не требующий расчёта (ответ из кэша или присоединение к идущему): всё, что стояло в очереди канала, старше его и не нужно. */
  function drop_older(ch) {
    const older = ch.waiting.splice(0);
    if (ch.fresh !== null) { older.push(ch.fresh); ch.fresh = null; }
    stat.coalesced += older.length;
    for (const w of older) w.resolve(SUPERSEDED);
  }

  // ── готовые модели ───────────────────────────────────────────────────────────────────────────────────────────────

  function remember(ws, query, result) {
    const a = result?.analysis;
    if (!is_obj(a)) return;
    let m = prepared.get(ws);
    if (m === undefined) { m = new Map(); prepared.set(ws, m); }
    m.set(canon(query), a);
    if (is_obj(result.waves)) waves_by_analysis.set(a, result.waves);
    stat.prepared += 1;
  }

  /**
   * Посчитать в Worker модели набора и положить их в кэш («Обзор» — `project`, «Волны» — `waves`).
   * @param {object} ws рабочая область (тот же объект потом получит `build_model`)
   * @param {object[]} queries запросы `analyze`, например `[{as_of}]`
   * @param {{screen?: string}} [o] `screen: 'waves'` — операция `waves` (вместе с расчётом приходят списки волн), иначе `project`
   * @returns {Promise<{ok: true, op: string, n: number, via: 'worker'|'main', reason: string|null}|{ok: false, off: true}|typeof SUPERSEDED>}
   * @throws {RunwayError} ошибка движка (как при расчёте на месте; приложение тогда считает на месте и получает ту же ошибку)
   */
  function prepare(ws, queries, o = {}) {
    if (off_reason() !== null || !is_obj(ws) || !Array.isArray(queries) || queries.length === 0) return Promise.resolve({ ok: false, off: true });
    const op = o.screen === 'waves' ? 'waves' : 'project';
    return submit(prepare_ch, 0, async () => {
      const res = { ok: true, op, n: 0, via: 'worker', reason: null };
      for (const q of queries) {
        const got = await call_op(op, [ws, q]);
        remember(ws, q, got.result);
        res.n += 1;
        if (got.via !== 'worker') { res.via = 'main'; res.reason = got.reason; }
      }
      return res;
    });
  }

  /** Забрать готовый расчёт для пары «рабочая область, запрос» (один раз: следующий вызов вернёт `null`, и модель посчитается на месте). */
  function take(ws, query) {
    if (!is_obj(ws)) return null;
    const m = prepared.get(ws);
    if (m === undefined) return null;
    const key = canon(query);
    const a = m.get(key);
    if (a === undefined) return null;
    m.delete(key);
    stat.taken += 1;
    return a;
  }

  /** Списки волн по режимам, которые пришли вместе с расчётом (`null`, если расчёт посчитан без них или на месте). */
  const waves_for = (analysis) => (is_obj(analysis) ? (waves_by_analysis.get(analysis) ?? null) : null);

  // ── «Купить» ─────────────────────────────────────────────────────────────────────────────────────────────────────

  function cache_put(key, value) {
    afford_cache.delete(key);
    afford_cache.set(key, value);
    while (afford_cache.size > CACHE_LIMIT) afford_cache.delete(afford_cache.keys().next().value);
  }

  /**
   * «Деньги после покупки» в Worker.
   * @param {{ws: object, scenario?: {ops: object[]}|null, ctx: {inputs_hash: string}}} model модель экрана
   * @param {{date: string, amount_minor: number}[]} parts части покупки
   * @returns {null | {key: string, value: object} | {key: string, promise: Promise<{value: object}|typeof SUPERSEDED>}}
   *   `null` — служба неактивна (считать на месте); `value` — ответ из кэша; `promise` — расчёт идёт. `value = {cash_after, via, reason}`; `cash_after: null` — движок отказал,
   *   как `cash_after` приложения при ошибке.
   */
  function afford(model, parts) {
    if (off_reason() !== null || !is_obj(model) || !is_obj(model.ws) || !is_obj(model.ctx) || !Array.isArray(parts) || parts.length === 0) return null;
    const key = 'afford|' + String(model.ctx.inputs_hash) + '|' + canon(parts);
    if (afford_cache.has(key)) {
      stat.cache_hits += 1;
      const v = afford_cache.get(key);
      cache_put(key, v);
      drop_older(afford_ch);
      return { key, value: v };
    }
    const joined = started.get(key); // тот же расчёт уже идёт
    if (joined !== undefined) {
      joined.item.joined = true; // к расчёту присоединились: при откате пропускать его уже нельзя
      drop_older(afford_ch);
      return { key, promise: joined.promise.then((value) => (value === SUPERSEDED ? SUPERSEDED : { value })) };
    }
    const query = model_query(model.ws, model.scenario ?? null);
    const promise = submit(afford_ch, frame_ms, async (item) => {
      // вытеснен, если за время ожидания дорожки или откатом клиента после сбоя воркера уже стоит более свежий запрос, к которому никто не присоединился
      const stale = () => {
        if (afford_ch.fresh === null || item.joined) return false;
        if (started.get(key)?.item === item) started.delete(key); // решение и снятие записи неделимы: присоединиться к пропущенному расчёту уже нельзя
        return true;
      };
      const inner = (async () => {
        try {
          const got = await call_op('afford', [model.ws, query, parts], { stale });
          if (got.skipped === true) { stat.skipped += 1; return SUPERSEDED; } // вытеснен более свежим: до воркера не дошёл или после сбоя воркера не досчитывается на главном потоке
          const v = { cash_after: got.result.cash_after, via: got.via, reason: got.reason };
          cache_put(key, v);
          return v;
        } catch (e) {
          const v = { cash_after: null, via: 'main', reason: typeof e?.code === 'string' ? e.code : 'failed' };
          if (typeof e?.code === 'string' && e.code.startsWith('E_')) cache_put(key, v); // отказ движка детерминирован; сбой иного рода не запоминаем
          return v;
        }
      })();
      started.set(key, { promise: inner, item });
      try { return await inner; } finally { if (started.get(key)?.item === item) started.delete(key); }
    }).then((r) => (r === SUPERSEDED ? SUPERSEDED : { value: r }), () => ({ value: { cash_after: null, via: 'main', reason: 'failed' } }));
    return { key, promise };
  }

  // ── флаг и состояние ─────────────────────────────────────────────────────────────────────────────────────────────

  return {
    /** Флаг включён (по умолчанию да). */
    enabled: () => read_flag(),
    /** Записать флаг устройства. Выключение останавливает Worker целиком; включение после сбоя даёт новый клиент. */
    set_enabled(on) {
      flag = on === true;
      try { get_storage()?.setItem(FLAG_KEY, flag ? '1' : '0'); } catch { /* без хранилища флаг живёт до перезагрузки страницы */ }
      if (!flag || (client !== null && client.stats().dead !== null)) drop_client();
      return flag;
    },
    off_reason,
    /** Worker сейчас можно использовать: флаг включён, в окружении он есть и клиент его не отверг. */
    active: () => off_reason() === null,
    /** Запустить Worker заранее (холодный старт модуля — секунды на слабом телефоне); `false` — служба неактивна или Worker не запустился. */
    warm() {
      if (off_reason() !== null) return false;
      try { return ensure_client().warm(); } catch { return false; }
    },
    prepare,
    take,
    waves_for,
    afford,
    /** Расчёты в очереди и в работе. */
    pending: () => running + channels.reduce((n, ch) => n + ch.waiting.length + (ch.fresh === null ? 0 : 1), 0),
    /** Остановить Worker (страница закрывается, тест кончился). */
    terminate: drop_client,
    /** Сводка для экрана и тестов. */
    stats() {
      const c = client === null ? null : client.stats();
      return {
        enabled: read_flag(), active: off_reason() === null, off_reason: off_reason(), requests: stat.requests, coalesced: stat.coalesced, cache_hits: stat.cache_hits,
        prepared: stat.prepared, taken: stat.taken, skipped: stat.skipped, worker_calls: c?.worker_calls ?? 0, main_calls: c?.main_calls ?? 0, engine_errors: c?.engine_errors ?? 0, started: c?.started ?? false,
      };
    },
  };
}

/** Служба приложения (одна на страницу): app.mjs и экран «Настройки» обращаются к ней. */
export const calc = create_calc_service();
