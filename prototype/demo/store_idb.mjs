// store_idb.mjs — реализация порта `Store` на IndexedDB (FP-05, REQ-122): записи журнала, снимки и метаданные в трёх хранилищах объектов,
// «голова» журнала — отдельная запись в метаданных, которая обновляется В ТОЙ ЖЕ транзакции, что и записи. Любая запись — одна транзакция:
// сбой запроса или проверки (в том числе `store_conflict`) отменяет её целиком (`tx.abort()`), частичных записей не бывает.
// Порт тот же, что в `store.mjs` (см. заголовок), поэтому контрактные тесты прогоняются на всех реализациях.
//
// База: `runway` (имя можно сменить), версия 1; хранилища объектов: `events` (ключ `seq`), `snapshots` (ключ `count`), `meta` (ключ `key`).
// Ключ метаданных `$head` зарезервирован под «голову»; прочие ключи — `[a-z][a-z0-9_.]{0,39}`.
// Браузерные объекты (`indexedDB`, `IDBKeyRange`) приходят аргументами: в Node модуль импортируется без побочных эффектов, тесты подставляют фейк.
// Тексты ошибок браузера в журнал не попадают: берётся только имя исключения (`ctx.name`).

import {
  StoreError, as_store_error, check_append, check_snapshot, check_meta, checked_replacement, head_of, EMPTY_HEAD, KEEP_SNAPSHOTS, normalize_data,
  create_local_store, create_memory_store,
} from './store.mjs';

/** Имя базы по умолчанию. */
export const DB_NAME = 'runway';
/** Версия схемы базы. */
export const DB_VERSION = 1;
/** Зарезервированный ключ «головы» в хранилище метаданных. */
export const HEAD_KEY = '$head';

const STORES = Object.freeze(['events', 'snapshots', 'meta']);
const KEY_PATHS = Object.freeze({ events: 'seq', snapshots: 'count', meta: 'key' });

/** Запрос IndexedDB → обещание. */
const rq = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(new StoreError('store_failed', { reason: 'request', name: typeof r.error?.name === 'string' ? r.error.name.slice(0, 40) : 'Error' }));
});

/**
 * Хранилище на IndexedDB.
 * @param {{indexedDB: IDBFactory, IDBKeyRange?: any, name?: string}} opts
 */
export function create_idb_store(opts) {
  const factory = opts.indexedDB;
  if (factory === null || factory === undefined || typeof factory.open !== 'function') throw new StoreError('store_unavailable', { reason: 'no_indexeddb' });
  const name = opts.name ?? DB_NAME;
  const Range = Object.hasOwn(opts, 'IDBKeyRange') ? opts.IDBKeyRange : globalThis.IDBKeyRange;
  let db_promise = null;
  let db_ref = null;

  const open = () => {
    if (db_promise !== null) return db_promise;
    db_promise = new Promise((resolve, reject) => {
      let req;
      try { req = factory.open(name, DB_VERSION); } catch (e) { reject(as_store_error(e, 'store_unavailable')); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: KEY_PATHS[s] });
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { try { db.close(); } catch { /* уже закрыта */ } db_promise = null; db_ref = null; };
        db_ref = db;
        resolve(db);
      };
      req.onerror = () => reject(new StoreError('store_unavailable', { reason: 'open_error', name: typeof req.error?.name === 'string' ? req.error.name.slice(0, 40) : 'Error' }));
      req.onblocked = () => reject(new StoreError('store_unavailable', { reason: 'open_blocked' }));
    });
    db_promise.catch(() => { db_promise = null; });
    return db_promise;
  };

  /**
   * Одна транзакция: `fn(stores)` получает хранилища объектов и возвращает результат. Исключение внутри `fn` или сбой запроса — `abort()`,
   * обещание отклоняется ошибкой хранилища, изменения отброшены.
   */
  const run = async (mode, names, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction(names, mode); } catch (e) { reject(as_store_error(e)); return; }
      let result;
      let failure = null;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? new StoreError('store_failed', { reason: 'aborted', name: typeof tx.error?.name === 'string' ? tx.error.name.slice(0, 40) : 'Error' }));
      const stores = {};
      for (const n of names) stores[n] = tx.objectStore(n);
      Promise.resolve().then(() => fn(stores)).then((r) => { result = r; }, (e) => {
        failure = as_store_error(e);
        try { tx.abort(); } catch { reject(failure); }
      });
    });
  };

  const head_in = async (meta) => {
    const rec = await rq(meta.get(HEAD_KEY));
    if (rec === undefined || rec === null || rec.value === undefined) return { ...EMPTY_HEAD };
    const v = rec.value;
    return { count: v.count, last_seq: v.last_seq, last_event_id: v.last_event_id };
  };
  const put_head = (meta, head) => rq(meta.put({ key: HEAD_KEY, value: head }));

  const read_all = async (stores) => {
    const [events, snapshots, metas] = await Promise.all([rq(stores.events.getAll()), rq(stores.snapshots.getAll()), rq(stores.meta.getAll())]);
    const meta = {};
    for (const m of metas) if (m.key !== HEAD_KEY) meta[m.key] = m.value;
    return normalize_data({ events, snapshots, meta });
  };

  return {
    kind: 'idb',
    name,

    load: () => run('readonly', STORES, read_all),

    stat: () => run('readonly', STORES, async (s) => {
      const head = await head_in(s.meta);
      const [snaps, metas] = await Promise.all([rq(s.snapshots.count()), rq(s.meta.getAll())]);
      return { ...head, snapshots: snaps, meta_keys: metas.map((m) => m.key).filter((k) => k !== HEAD_KEY).sort() };
    }),

    get_meta: () => run('readonly', ['meta'], async (s) => {
      const out = {};
      for (const m of await rq(s.meta.getAll())) if (m.key !== HEAD_KEY) out[m.key] = m.value;
      return out;
    }),

    read_after: (seq) => {
      if (!Number.isSafeInteger(seq) || seq < 0) return Promise.reject(new StoreError('store_invalid', { reason: 'bad_seq' }));
      return run('readonly', ['events'], async (s) => {
        const all = Range !== undefined && Range !== null && typeof Range.lowerBound === 'function'
          ? await rq(s.events.getAll(Range.lowerBound(seq, true)))
          : (await rq(s.events.getAll())).filter((e) => e.seq > seq);
        return all.sort((a, b) => a.seq - b.seq);
      });
    },

    append: (events) => run('readwrite', ['events', 'meta'], async (s) => {
      const head = await head_in(s.meta);
      const evs = check_append(head, events); // отказ проверки отменяет транзакцию: ничего не записано
      if (evs.length === 0) return head;
      await Promise.all(evs.map((e) => rq(s.events.add(e)))); // повтор ключа — ConstraintError → откат всей пачки
      const last = evs[evs.length - 1];
      const out = { count: head.count + evs.length, last_seq: last.seq, last_event_id: last.event_id };
      await put_head(s.meta, out);
      return out;
    }),

    put_snapshot: (sn) => run('readwrite', ['snapshots'], async (s) => {
      const snap = check_snapshot(sn);
      await rq(s.snapshots.put(snap));
      const all = (await rq(s.snapshots.getAll())).sort((a, b) => a.count - b.count);
      for (const old of all.slice(0, Math.max(0, all.length - KEEP_SNAPSHOTS))) await rq(s.snapshots.delete(old.count));
    }),

    set_meta: (key, value) => run('readwrite', ['meta'], async (s) => {
      const v = check_meta(key, value);
      await rq(s.meta.put({ key, value: v }));
    }),

    replace: (data) => run('readwrite', STORES, async (s) => {
      const d = checked_replacement(data);
      await Promise.all(STORES.map((n) => rq(s[n].clear())));
      await Promise.all(d.events.map((e) => rq(s.events.add(e))));
      await Promise.all(d.snapshots.map((x) => rq(s.snapshots.put(x))));
      await Promise.all(Object.keys(d.meta).map((k) => rq(s.meta.put({ key: k, value: d.meta[k] }))));
      const head = head_of(d.events);
      await put_head(s.meta, head);
      return head;
    }),

    clear: () => run('readwrite', STORES, async (s) => { await Promise.all(STORES.map((n) => rq(s[n].clear()))); }),

    /** Стереть записи и снять саму базу (`deleteDatabase`). Свои соединения закрываются первыми, чтобы удаление не ждало. */
    async destroy() {
      try { await run('readwrite', STORES, async (s) => { await Promise.all(STORES.map((n) => rq(s[n].clear()))); }); } catch { /* базы может не быть: удаление ниже всё равно выполняется */ }
      if (db_ref !== null) { try { db_ref.close(); } catch { /* уже закрыта */ } }
      db_ref = null;
      db_promise = null;
      await new Promise((resolve, reject) => {
        let req;
        try { req = factory.deleteDatabase(name); } catch (e) { reject(as_store_error(e)); return; }
        req.onsuccess = () => resolve();
        req.onerror = () => reject(new StoreError('store_failed', { reason: 'delete_error' }));
        req.onblocked = () => { /* другая вкладка держит соединение: удаление завершится, когда она закроет (onsuccess) */ };
      });
    },

    async close() {
      if (db_ref !== null) { try { db_ref.close(); } catch { /* уже закрыта */ } }
      db_ref = null;
      db_promise = null;
    },
  };
}

// ── ссылка на файл-копию (FP-19, REQ-097) ────────────────────────────────────────────────────────────────────────────

/** Имя отдельной базы для ссылки на выбранный файл-копию (приставка `runway` общая для всех хранилищ приложения: чужое источник `localhost` не затрагивается). */
export const HANDLE_DB_NAME = 'runway-handles';
/** Ключ записи со ссылкой на файл-копию в хранилище объектов `meta` базы ссылок. */
export const FILE_TARGET_KEY = 'runway.file_target';

const HANDLE_STORE = 'meta';
const HANDLE_KEY_RE = /^runway\.[a-z][a-z0-9_.]{0,30}$/;

const check_handle_key = (key) => {
  if (typeof key !== 'string' || !HANDLE_KEY_RE.test(key)) throw new StoreError('store_invalid', { reason: 'bad_handle_key' });
  return key;
};

/**
 * Хранилище ссылок на файлы (`FileSystemFileHandle`) на IndexedDB: отдельная маленькая база с одним хранилищем объектов `meta` (ключ `key`).
 * Ссылка на файл не JSON: она хранится структурным клонированием браузера, поэтому лежит не в метаданных журнала (там только JSON, и
 * `replace` / «Восстановить» очищали бы её вместе с копиями), а отдельно. Значение приходит и уходит как есть; проверку формы делает вызывающий.
 * Удаление всех данных снимает базу целиком (`destroy`).
 * @param {{indexedDB: IDBFactory, name?: string}} opts
 * @returns {{kind: 'idb_handles', name: string, get: (key: string) => Promise<any>, put: (key: string, value: any) => Promise<void>,
 *   remove: (key: string) => Promise<void>, destroy: () => Promise<{removed: number}>, close: () => Promise<void>}}
 */
export function create_handle_store(opts) {
  const factory = opts?.indexedDB;
  if (factory === null || factory === undefined || typeof factory.open !== 'function') throw new StoreError('store_unavailable', { reason: 'no_indexeddb' });
  const name = opts.name ?? HANDLE_DB_NAME;
  let db_promise = null;
  let db_ref = null;

  const open = () => {
    if (db_promise !== null) return db_promise;
    db_promise = new Promise((resolve, reject) => {
      let req;
      try { req = factory.open(name, DB_VERSION); } catch (e) { reject(as_store_error(e, 'store_unavailable')); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(HANDLE_STORE)) db.createObjectStore(HANDLE_STORE, { keyPath: 'key' });
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { try { db.close(); } catch { /* уже закрыта */ } db_promise = null; db_ref = null; };
        db_ref = db;
        resolve(db);
      };
      req.onerror = () => reject(new StoreError('store_unavailable', { reason: 'open_error', name: typeof req.error?.name === 'string' ? req.error.name.slice(0, 40) : 'Error' }));
      req.onblocked = () => reject(new StoreError('store_unavailable', { reason: 'open_blocked' }));
    });
    db_promise.catch(() => { db_promise = null; });
    return db_promise;
  };

  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction([HANDLE_STORE], mode); } catch (e) { reject(as_store_error(e)); return; }
      let result;
      let failure = null;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? new StoreError('store_failed', { reason: 'aborted', name: typeof tx.error?.name === 'string' ? tx.error.name.slice(0, 40) : 'Error' }));
      const s = tx.objectStore(HANDLE_STORE);
      Promise.resolve().then(() => fn(s)).then((r) => { result = r; }, (e) => {
        failure = as_store_error(e);
        try { tx.abort(); } catch { reject(failure); }
      });
    });
  };

  const close_own = () => {
    if (db_ref !== null) { try { db_ref.close(); } catch { /* уже закрыта */ } }
    db_ref = null;
    db_promise = null;
  };

  return {
    kind: 'idb_handles',
    name,
    /** Значение по ключу или `null`. */
    get: async (key) => { check_handle_key(key); return run('readonly', async (s) => { const rec = await rq(s.get(key)); return rec === undefined || rec === null || rec.value === undefined ? null : rec.value; }); },
    /** Записать значение (одна транзакция: прежнее значение заменяется целиком или остаётся). */
    put: async (key, value) => { check_handle_key(key); return run('readwrite', async (s) => { await rq(s.put({ key, value })); }); },
    remove: async (key) => { check_handle_key(key); return run('readwrite', async (s) => { await rq(s.delete(key)); }); },
    /** Снять базу ссылок (`deleteDatabase`); `removed` — 1, если ссылка была. Свои соединения закрываются первыми, чтобы удаление не ждало. */
    async destroy() {
      let removed = 0;
      try { removed = (await run('readonly', async (s) => rq(s.count()))) > 0 ? 1 : 0; } catch { /* базы может не быть: удаление ниже всё равно выполняется */ }
      close_own();
      await new Promise((resolve, reject) => {
        let req;
        try { req = factory.deleteDatabase(name); } catch (e) { reject(as_store_error(e)); return; }
        req.onsuccess = () => resolve();
        req.onerror = () => reject(new StoreError('store_failed', { reason: 'delete_error' }));
        req.onblocked = () => { /* другая вкладка держит соединение: удаление завершится, когда она закроет (onsuccess) */ };
      });
      return { removed };
    },
    async close() { close_own(); },
  };
}

// ── выбор хранилища ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Выбрать лучшее доступное хранилище: IndexedDB → localStorage → память вкладки. Каждое кандидатное хранилище пробуется чтением «головы»;
 * отказ (приватный режим, запрет, испорченный ключ) — переход к следующему. Причины отказов — `tried` (`вид:код`), без текстов браузера.
 * @param {{indexedDB?: any, IDBKeyRange?: any, localStorage?: any, name?: string}} [env] браузерные объекты (порты)
 * @returns {Promise<{store: object, kind: 'idb'|'local'|'memory', tried: string[]}>}
 */
export async function pick_store(env = {}) {
  const tried = [];
  if (env.indexedDB !== undefined && env.indexedDB !== null) {
    const st = create_idb_store({ indexedDB: env.indexedDB, IDBKeyRange: env.IDBKeyRange, name: env.name });
    try { await st.stat(); return { store: st, kind: 'idb', tried }; } catch (e) { tried.push('idb:' + (e?.code ?? 'failed')); try { await st.close(); } catch { /* закрытие необязательно */ } }
  }
  if (env.localStorage !== undefined && env.localStorage !== null) {
    try {
      const st = create_local_store({ storage: env.localStorage });
      await st.stat();
      return { store: st, kind: 'local', tried };
    } catch (e) { tried.push('local:' + (e?.code ?? 'failed')); }
  }
  return { store: create_memory_store(), kind: 'memory', tried };
}
