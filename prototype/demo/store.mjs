// store.mjs — порт хранилища журнала (FP-05, REQ-122, ADR-005): `Store` с реализациями «в памяти» и «целиком в localStorage»,
// закрепление хранилища (`persist()`), «один писатель» через Web Lock, оповещение вкладок (BroadcastChannel) и журнал, который пишет в хранилище.
// Реализация на IndexedDB — `store_idb.mjs` (тот же порт). Модуль можно импортировать в Node: браузерные объекты приходят аргументами (порты).
//
// Порт `Store` (все методы асинхронные; одна запись — одна транзакция «всё или ничего»):
//   kind                          'memory' | 'idb' | 'local'
//   load()                        → {events, snapshots, meta}: записи по возрастанию `seq`, снимки по `count`, метаданные (копии, не ссылки)
//   stat()                        → {count, last_seq, last_event_id, snapshots, meta_keys}: «голова» журнала без чтения записей
//   append(events)                → голова после записи; `seq` строго больше последнего и строго растёт, иначе `store_conflict`, ничего не записано
//   read_after(seq)               → записи с `seq` больше заданного (для «догнать» чужие записи)
//   put_snapshot(snapshot)        → снимок `{count, seq, state}`; хранятся два последних (больше не нужно: хвост досчитывается журналом)
//   set_meta(key, value) / get_meta()   метаданные: ключ `[a-z][a-z0-9_.]{0,39}`, значение — JSON без опасных ключей
//   replace({events, snapshots, meta})  заменить всё целиком (восстановление из копии): всё или ничего
//   clear()                       стереть записи, снимки и метаданные; destroy() — то же и снять саму базу; close()
// Ошибки — `StoreError` с кодом `store_conflict | store_invalid | store_failed | store_unavailable | store_corrupt` (это коды хранилища,
// не коды движка из REQ-017). В тексте ошибок нет содержимого записей: только имена полей и числа.
// Модуль чистый по слоям: часы и случайность не читает; `Date` и `process` не использует.

import { open_journal } from './journal_log.mjs';
import { FORBIDDEN_KEYS } from './ids.mjs';

// ── ошибки и проверки ─────────────────────────────────────────────────────────────────────────────────────────────

/** Ошибка хранилища. `code` — один из `STORE_CODES`; `ctx` — только имена и числа (без содержимого записей). */
export class StoreError extends Error {
  constructor(code, ctx = null, message) {
    super(message ?? code + (ctx === null ? '' : ' ' + JSON.stringify(ctx)));
    this.name = 'StoreError';
    this.code = code;
    this.ctx = ctx;
  }
}

export const STORE_CODES = Object.freeze(['store_conflict', 'store_invalid', 'store_failed', 'store_unavailable', 'store_corrupt']);

/** Сколько снимков хранится. */
export const KEEP_SNAPSHOTS = 2;

/** Формат записи в localStorage (запасная реализация). */
export const LOCAL_FORMAT = 'runway-store/1';

const META_KEY_RE = /^[a-z][a-z0-9_.]{0,39}$/;
const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Привести любое исключение к `StoreError` (имя исключения браузера — в `ctx.name`; текст сообщения не копируется). */
export function as_store_error(e, fallback = 'store_failed') {
  if (e instanceof StoreError) return e;
  const name = typeof e?.name === 'string' ? e.name.slice(0, 40) : 'Error';
  return new StoreError(fallback, { name });
}

/**
 * Проверенная глубокая копия JSON-значения: null, boolean, конечное число, строка, массив, простой объект.
 * Ключи `__proto__`/`constructor`/`prototype`, функции, `undefined`, NaN и чрезмерная глубина отвергаются (`store_invalid`).
 */
export function clone_json(x, where = 'value', depth = 0) {
  if (depth > 40) throw new StoreError('store_invalid', { reason: 'too_deep', where });
  if (x === null || typeof x === 'boolean' || typeof x === 'string') return x;
  if (typeof x === 'number') {
    if (!Number.isFinite(x)) throw new StoreError('store_invalid', { reason: 'not_finite', where });
    return x;
  }
  if (Array.isArray(x)) return x.map((v) => clone_json(v, where, depth + 1));
  if (is_obj(x)) {
    const proto = Object.getPrototypeOf(x);
    if (proto !== Object.prototype && proto !== null) throw new StoreError('store_invalid', { reason: 'not_plain_object', where });
    const out = {};
    for (const k of Object.getOwnPropertyNames(x)) {
      if (FORBIDDEN_KEYS.includes(k)) throw new StoreError('store_invalid', { reason: 'forbidden_key', key: k, where });
      out[k] = clone_json(x[k], where, depth + 1);
    }
    return out;
  }
  throw new StoreError('store_invalid', { reason: 'not_json', where });
}

/** Пустая «голова» журнала. */
export const EMPTY_HEAD = Object.freeze({ count: 0, last_seq: 0, last_event_id: null });

/** «Голова» массива записей. */
export function head_of(events) {
  if (events.length === 0) return { ...EMPTY_HEAD };
  const last = events[events.length - 1];
  return { count: events.length, last_seq: last.seq, last_event_id: last.event_id };
}

/** Две «головы» совпадают (то же число записей, тот же последний `seq` и `event_id`). */
export function same_head(a, b) {
  return a !== null && b !== null && a.count === b.count && a.last_seq === b.last_seq && a.last_event_id === b.last_event_id;
}

function check_event(e, i) {
  if (!is_obj(e) || typeof e.type !== 'string' || typeof e.event_id !== 'string' || !Number.isSafeInteger(e.seq) || e.seq < 1) {
    throw new StoreError('store_invalid', { reason: 'bad_event', index: i });
  }
  return clone_json(e, 'event');
}

/**
 * Проверить пачку записей перед добавлением к журналу с «головой» `head`: форма, `seq` строго растёт и больше `head.last_seq`, `event_id` не повторяются.
 * @returns {object[]} копии записей (замороженные записи журнала превращаются в обычные объекты)
 * @throws {StoreError} store_invalid (форма), store_conflict (порядок `seq`: чужая запись уже есть)
 */
export function check_append(head, events) {
  if (!Array.isArray(events)) throw new StoreError('store_invalid', { reason: 'events_not_array' });
  const out = [];
  const ids = new Set();
  let last = head.last_seq;
  events.forEach((raw, i) => {
    const e = check_event(raw, i);
    if (e.seq <= last) throw new StoreError('store_conflict', { reason: 'seq_not_after_head', seq: e.seq, last_seq: last });
    if (ids.has(e.event_id)) throw new StoreError('store_invalid', { reason: 'duplicate_event_id', index: i });
    ids.add(e.event_id);
    last = e.seq;
    out.push(e);
  });
  return out;
}

/** Проверить снимок `{count, seq, state}`. */
export function check_snapshot(sn) {
  if (!is_obj(sn) || !Number.isSafeInteger(sn.count) || sn.count < 0 || !(sn.seq === null || Number.isSafeInteger(sn.seq)) || !is_obj(sn.state)) {
    throw new StoreError('store_invalid', { reason: 'bad_snapshot' });
  }
  return clone_json(sn, 'snapshot');
}

/** Проверить ключ и значение метаданных. */
export function check_meta(key, value) {
  if (typeof key !== 'string' || !META_KEY_RE.test(key)) throw new StoreError('store_invalid', { reason: 'bad_meta_key' });
  return clone_json(value, 'meta');
}

/** Нормализовать содержимое хранилища, прочитанное «снаружи» (недоверенные данные): порядок, формы, `seq` строго растёт. */
export function normalize_data(raw) {
  if (!is_obj(raw)) throw new StoreError('store_corrupt', { reason: 'not_object' });
  const events = Array.isArray(raw.events) ? raw.events : [];
  const snapshots = Array.isArray(raw.snapshots) ? raw.snapshots : [];
  const meta = is_obj(raw.meta) ? raw.meta : {};
  let ev;
  try {
    ev = events.map((e, i) => check_event(e, i)).sort((a, b) => a.seq - b.seq);
    for (let i = 1; i < ev.length; i++) if (ev[i].seq === ev[i - 1].seq) throw new StoreError('store_corrupt', { reason: 'duplicate_seq' });
  } catch (e) { throw e instanceof StoreError && e.code === 'store_corrupt' ? e : new StoreError('store_corrupt', { reason: 'bad_events' }); }
  let sn;
  try { sn = snapshots.map(check_snapshot).sort((a, b) => a.count - b.count); } catch { throw new StoreError('store_corrupt', { reason: 'bad_snapshots' }); }
  const mt = {};
  for (const k of Object.keys(meta)) { try { mt[k] = check_meta(k, meta[k]); } catch { /* чужой ключ метаданных: пропускается */ } }
  return { events: ev, snapshots: sn.slice(-KEEP_SNAPSHOTS), meta: mt };
}

/** Проверенное новое содержимое для `replace`: записи как в `append` (по порядку, `seq` строго растёт), снимки и метаданные — по формам. */
export function checked_replacement(data) {
  if (data !== undefined && data !== null && !is_obj(data)) throw new StoreError('store_invalid', { reason: 'replacement_not_object' });
  const events = check_append(EMPTY_HEAD, data?.events ?? []);
  const snapshots = (data?.snapshots ?? []).map(check_snapshot).sort((a, b) => a.count - b.count).slice(-KEEP_SNAPSHOTS);
  const meta = {};
  const src = data?.meta ?? {};
  if (!is_obj(src)) throw new StoreError('store_invalid', { reason: 'meta_not_object' });
  for (const k of Object.keys(src)) meta[k] = check_meta(k, src[k]);
  return { events, snapshots, meta };
}

export const stat_of = (d) => ({ ...head_of(d.events), snapshots: d.snapshots.length, meta_keys: Object.keys(d.meta).sort() });

// ── общая основа для хранилищ «целиком» (память, localStorage) ──────────────────────────────────────────────────────

/**
 * Хранилище по двум синхронным операциям: `read()` → данные, `write(данные)` → записать целиком (бросает при сбое — тогда прежнее содержимое цело).
 * Каждая операция порта выполняется без пауз между чтением и записью, поэтому внутри одного процесса она неделима.
 */
function whole_store({ kind, read, write, destroy_fn, trusted = false }) {
  // `trusted`: данные уже проверены при записи (хранилище в памяти) — повторная проверка и копирование на каждой операции были бы O(n) впустую
  const get = () => {
    if (!trusted) return normalize_data(read());
    const d = read();
    return { events: d.events, snapshots: d.snapshots.slice(), meta: { ...d.meta } }; // поверхностная копия: правка `d` не задевает базу до `write`
  };
  const out = (x) => (trusted ? JSON.parse(JSON.stringify(x)) : x); // наружу — копии, не внутренние объекты
  return {
    kind,
    async load() { const d = get(); return out({ events: d.events, snapshots: d.snapshots, meta: d.meta }); },
    async stat() { return stat_of(get()); },
    async get_meta() { return out(get().meta); },
    async read_after(seq) {
      if (!Number.isSafeInteger(seq) || seq < 0) throw new StoreError('store_invalid', { reason: 'bad_seq' });
      return out(get().events.filter((e) => e.seq > seq));
    },
    async append(events) {
      const d = get();
      const evs = check_append(head_of(d.events), events);
      if (evs.length === 0) return head_of(d.events);
      d.events = d.events.concat(evs);
      write(d);
      return head_of(d.events);
    },
    async put_snapshot(sn) {
      const d = get();
      const s = check_snapshot(sn);
      d.snapshots = d.snapshots.filter((x) => x.count !== s.count).concat([s]).sort((a, b) => a.count - b.count).slice(-KEEP_SNAPSHOTS);
      write(d);
    },
    async set_meta(key, value) {
      const d = get();
      d.meta[key] = check_meta(key, value);
      write(d);
    },
    async replace(data) {
      const d = checked_replacement(data);
      write(d);
      return head_of(d.events);
    },
    async clear() { write({ events: [], snapshots: [], meta: {} }); },
    async destroy() { destroy_fn(); },
    async close() { /* нечего закрывать */ },
  };
}

// ── в памяти ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Общая «база» для нескольких экземпляров хранилища в памяти (так в тестах изображаются две вкладки одного устройства). */
export function create_memory_backing() {
  return { data: { events: [], snapshots: [], meta: {} } };
}

/**
 * Хранилище в памяти. `backing` — общая база; `fault(op)` (для тестов) может бросить исключение перед записью: прежнее содержимое остаётся целым.
 * @param {{backing?: object, fault?: ((op: string) => void)|null}} [opts]
 */
export function create_memory_store(opts = {}) {
  const backing = opts.backing ?? create_memory_backing();
  const fault = opts.fault ?? null;
  return whole_store({
    kind: 'memory',
    trusted: true,
    read: () => backing.data,
    write: (d) => {
      if (fault !== null) { try { fault('write'); } catch (e) { throw as_store_error(e); } }
      backing.data = { events: d.events, snapshots: d.snapshots, meta: d.meta }; // подмена целиком: промежуточного состояния нет
    },
    destroy_fn: () => { backing.data = { events: [], snapshots: [], meta: {} }; },
  });
}

// ── localStorage (запасной вариант) ───────────────────────────────────────────────────────────────────────────────

/**
 * Хранилище в localStorage: всё в одном ключе (`runway-store/1`), запись целиком. Подходит для небольших журналов (квота ≈ 5 МБ):
 * переполнение — `store_failed`, прежнее значение ключа цело.
 * @param {{storage: {getItem: Function, setItem: Function, removeItem: Function}, key?: string}} opts
 */
export function create_local_store({ storage, key = LOCAL_FORMAT }) {
  if (storage === null || typeof storage !== 'object' || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function' || typeof storage.removeItem !== 'function') {
    throw new StoreError('store_unavailable', { reason: 'no_local_storage' });
  }
  return whole_store({
    kind: 'local',
    read: () => {
      let text;
      try { text = storage.getItem(key); } catch (e) { throw as_store_error(e, 'store_unavailable'); }
      if (text === null || text === undefined) return { events: [], snapshots: [], meta: {} };
      let obj;
      try { obj = JSON.parse(text); } catch { throw new StoreError('store_corrupt', { reason: 'bad_json' }); }
      if (!is_obj(obj) || obj.format !== LOCAL_FORMAT) throw new StoreError('store_corrupt', { reason: 'bad_format' });
      return obj;
    },
    write: (d) => {
      const text = JSON.stringify({ format: LOCAL_FORMAT, events: d.events, snapshots: d.snapshots, meta: d.meta });
      try { storage.setItem(key, text); } catch (e) { throw as_store_error(e); }
    },
    destroy_fn: () => { try { storage.removeItem(key); } catch (e) { throw as_store_error(e); } },
  });
}

// ── закрепление хранилища ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Состояние закрепления хранилища (`navigator.storage`): `{supported, persisted, requested}`. `persisted`: true / false / null (браузер не отвечает).
 * @param {{persist?: () => Promise<boolean>, persisted?: () => Promise<boolean>}|null|undefined} sm
 * @param {{request?: boolean}} [opts] `request: false` — только узнать, не просить
 */
export async function request_persistence(sm, opts = {}) {
  if (sm === null || sm === undefined || typeof sm.persisted !== 'function') return { supported: false, persisted: null, requested: false };
  let persisted = null;
  try { persisted = (await sm.persisted()) === true; } catch { return { supported: true, persisted: null, requested: false }; }
  if (persisted || opts.request === false || typeof sm.persist !== 'function') return { supported: true, persisted, requested: false };
  try { persisted = (await sm.persist()) === true; } catch { persisted = false; }
  return { supported: true, persisted, requested: true };
}

// ── один писатель ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Замок «один писатель»: Web Lock (`navigator.locks`) — один на все вкладки устройства; если API нет — очередь внутри страницы
 * (`kind: 'in_process'`: между вкладками замка нет, тогда спасает проверка `seq` хранилища и повтор записи).
 * @param {{locks?: {request: Function}|null, name?: string}} [opts]
 * @returns {{kind: 'web_locks'|'in_process', name: string, run: <T>(fn: () => Promise<T>) => Promise<T>}}
 */
export function create_lock(opts = {}) {
  const locks = Object.hasOwn(opts, 'locks') ? opts.locks : globalThis.navigator?.locks;
  const name = opts.name ?? 'runway-writer';
  if (locks !== null && locks !== undefined && typeof locks.request === 'function') {
    return { kind: 'web_locks', name, run: (fn) => locks.request(name, { mode: 'exclusive' }, async () => fn()) };
  }
  let tail = Promise.resolve();
  return {
    kind: 'in_process',
    name,
    run(fn) {
      const p = tail.then(() => fn());
      tail = p.then(() => undefined, () => undefined);
      return p;
    },
  };
}

// ── оповещение вкладок ────────────────────────────────────────────────────────────────────────────────────────────

const MSG_TYPES = new Set(['appended', 'replaced', 'erased']);

/** Сообщение другой вкладки годно, если это `{v: 1, type, from, last_seq, count}` с числами и короткой строкой (канал открыт для всей страницы origin). */
export function valid_channel_message(m) {
  return is_obj(m) && m.v === 1 && MSG_TYPES.has(m.type) && typeof m.from === 'string' && m.from.length > 0 && m.from.length <= 64
    && Number.isSafeInteger(m.last_seq) && m.last_seq >= 0 && Number.isSafeInteger(m.count) && m.count >= 0;
}

/**
 * Канал оповещения вкладок. Без `BroadcastChannel` — пустышка (`kind: 'none'`). Свои сообщения не возвращаются; чужие проверяются формой.
 * Канал не удерживает процесс Node (`unref`).
 * @param {{BroadcastChannel?: Function, name?: string, tab_id: string}} opts
 */
export function create_sync_channel(opts) {
  const BC = Object.hasOwn(opts, 'BroadcastChannel') ? opts.BroadcastChannel : globalThis.BroadcastChannel;
  const tab_id = opts.tab_id;
  if (typeof BC !== 'function') return { kind: 'none', post() {}, subscribe() { return () => {}; }, close() {} };
  const ch = new BC(opts.name ?? 'runway-store');
  if (typeof ch.unref === 'function') ch.unref();
  const subs = new Set();
  ch.onmessage = (ev) => {
    const m = ev?.data;
    if (!valid_channel_message(m) || m.from === tab_id) return;
    for (const fn of [...subs]) { try { fn(m); } catch { /* подписчик не должен ломать канал */ } }
  };
  return {
    kind: 'broadcast',
    post(type, head) { try { ch.postMessage({ v: 1, type, from: tab_id, last_seq: head.last_seq, count: head.count }); } catch { /* канал закрыт */ } },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    close() { subs.clear(); try { ch.close(); } catch { /* уже закрыт */ } },
  };
}

// ── зеркало журнала страницы в хранилище ──────────────────────────────────────────────────────────────────────────

/** Позиция записи с данным `seq` в массиве по возрастанию `seq` (бинарный поиск) или -1. */
function index_of_seq(events, seq) {
  let lo = 0;
  let hi = events.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].seq === seq) return mid;
    if (events[mid].seq < seq) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

/**
 * Привести хранилище к журналу страницы: дописать хвост (если хранилище — префикс журнала) или заменить целиком (журнал страницы пересобран).
 * Вызывать под замком записи. Если «голова» хранилища не та, что страница видела при прошлой записи (`known_head`), записала другая вкладка:
 * `store_conflict` — ничего не перезаписывается молча. `force: true` — заменить хранилище намеренно.
 * @param {object} store
 * @param {object[]} events журнал страницы (по возрастанию `seq`)
 * @param {{known_head?: object|null, force?: boolean, snapshots?: object[]}} [opts]
 * @returns {Promise<{head: object, mode: 'append'|'replace'|'noop', appended: number}>}
 */
export async function mirror_events(store, events, opts = {}) {
  const head = await store.stat();
  const known = opts.known_head ?? null;
  if (opts.force !== true) {
    if (known === null && head.count > 0) throw new StoreError('store_conflict', { reason: 'store_not_empty_unknown_state' });
    if (known !== null && !same_head(head, known)) throw new StoreError('store_conflict', { reason: 'foreign_write' });
  }
  let mode = 'append';
  let from = 0;
  if (head.count > 0 && opts.force !== true) {
    const idx = index_of_seq(events, head.last_seq);
    const prefix = idx >= 0 && idx + 1 === head.count && events[idx].event_id === head.last_event_id;
    if (prefix) from = idx + 1; else mode = 'replace';
  } else if (head.count > 0) mode = 'replace';
  const snaps = (opts.snapshots ?? []).slice(-KEEP_SNAPSHOTS);
  let out;
  if (mode === 'replace') {
    out = await store.replace({ events, snapshots: snaps, meta: await store.get_meta() });
    return { head: out, mode, appended: events.length };
  }
  const tail = events.slice(from);
  if (tail.length === 0) return { head, mode: 'noop', appended: 0 };
  out = await store.append(tail);
  for (const sn of snaps.slice(-1)) { try { await store.put_snapshot(sn); } catch { /* снимок — ускорение, не данные */ } }
  return { head: out, mode, appended: tail.length };
}

// ── журнал, который пишет в хранилище (несколько писателей) ───────────────────────────────────────────────────────

/**
 * Журнал поверх хранилища. Запись — под замком: «догнать» чужие записи → добавить свои → записать пачкой. Если замка между вкладками нет
 * и кто-то успел раньше, хранилище откажет (`store_conflict`): журнал перечитывается из хранилища и запись повторяется (до `retries` раз).
 * @param {{store: object, lock: object, channel?: object|null, ports: {next_id: Function, recorded_at: Function}, snapshot_every?: number}} opts
 */
export async function open_persistent(opts) {
  const { store, lock } = opts;
  const channel = opts.channel ?? null;
  const stats = { conflicts: 0, writes: 0 };
  let journal = null;
  let stored_snapshots = 0;

  const make = (data) => {
    const j_opts = { ports: opts.ports, snapshot_every: opts.snapshot_every };
    try { return open_journal(data, { ...j_opts, verify: true }); } catch { return open_journal({ events: data.events, snapshots: [] }, j_opts); }
  };
  const reload = async () => {
    const data = await store.load();
    journal = make(data);
    stored_snapshots = data.snapshots.length === 0 ? 0 : data.snapshots[data.snapshots.length - 1].count;
  };
  const catch_up = async () => {
    const head = await store.stat();
    if (head.count === journal.length && head.last_seq === journal.last_seq) return;
    if (head.count < journal.length || head.last_seq < journal.last_seq) { await reload(); return; } // хранилище очищено или заменено
    for (const e of await store.read_after(journal.last_seq)) journal.append_event(e);
  };
  await reload();

  return {
    get journal() { return journal; },
    stats,
    /** Дописать записи по описаниям `{type, payload, opts?}`; возвращает созданные записи. `if_empty: true` — только если хранилище пусто (иначе `store_conflict`). */
    write(specs, w_opts = {}) {
      const retries = w_opts.retries ?? 5;
      return lock.run(async () => {
        for (let attempt = 0; ; attempt++) {
          await catch_up();
          // «только в пустое»: под замком журнал уже не пуст — записал кто-то другой, повтор не нужен (иначе набор данных записался бы дважды)
          if (w_opts.if_empty === true && journal.length > 0) throw new StoreError('store_conflict', { reason: 'store_not_empty' });
          const evs = journal.append_many(specs); // неверное описание — исключение, ничего не записано
          try {
            const head = await store.append(evs);
            const sn = journal.snapshots();
            const last = sn.length === 0 ? null : sn[sn.length - 1];
            if (last !== null && last.count > stored_snapshots) {
              try { await store.put_snapshot(last); stored_snapshots = last.count; } catch { /* снимок — ускорение */ }
            }
            stats.writes += evs.length;
            if (channel !== null) channel.post('appended', head);
            return evs;
          } catch (e) {
            await reload(); // журнал в памяти разошёлся с хранилищем: берём то, что реально записано
            if (e instanceof StoreError && e.code === 'store_conflict' && attempt < retries) { stats.conflicts += 1; continue; }
            throw e;
          }
        }
      });
    },
    /** Подтянуть записи, которые добавили другие вкладки. */
    refresh() { return lock.run(() => catch_up()); },
  };
}
