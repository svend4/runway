// fake_idb.mjs — фейк IndexedDB для тестов хранилища (FP-05, REQ-122): в Node IndexedDB нет, а контракт порта `Store` надо проверить и на обёртке.
// Моделируется то, на чём держится `store_idb.mjs`: фабрика `open` / `deleteDatabase`, `onupgradeneeded`, транзакции с откатом при `abort()` и при ошибке запроса
// (повтор ключа в `add` → ConstraintError), хранилища объектов с `keyPath`, запросы `add/put/get/getAll/count/delete/clear`, `IDBKeyRange.lowerBound`.
// Транзакция «живёт», пока в очереди есть запросы; закрепляется отдельным тиком после последнего ответа (как в браузерах: запросы, поставленные
// в микрозадачах внутри обработчика, успевают попасть в ту же транзакцию). Запись идёт в копию («staged») и подменяет базу только при `complete`.
// Сбой для проверки отката: `fault(n, op)` — вернуть true на n-м изменяющем запросе (`add/put/delete/clear`) → ошибка запроса → откат транзакции.
// Только для тестов; в коде демо не используется.

const json_clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
// setImmediate, а не setTimeout(0): на Windows таймер даёт ~15 мс на тик, и тысячи транзакций «зависают» (так прошлый прогон казался зависшим)
const tick = (fn) => setImmediate(fn);

/** Запустить транзакции базы, которых больше не задерживают более ранние. */
function pump(rec) {
  const list = rec.txs;
  list.forEach((tx, i) => {
    if (tx.started || tx.finished) return;
    const blocked = list.slice(0, i).some((e) => !e.finished && e.names.some((n) => tx.names.includes(n)) && (e.mode === 'readwrite' || tx.mode === 'readwrite'));
    if (!blocked) tx.start();
  });
}

export function fake_idb(opts = {}) {
  // `opts.clone` (FP-19): как значения уходят в базу и приходят из неё; по умолчанию — JSON-копия, а для ссылки на файл (`FileSystemFileHandle`, структурное клонирование браузера
  // сохраняет живой объект) тест передаёт `(x) => x` — значение хранится как есть
  const clone = typeof opts.clone === "function" ? opts.clone : json_clone;
  const dbs = new Map();
  const log = { tx_started: 0, tx_committed: 0, tx_aborted: 0, writes: 0 };
  let fault = opts.fault ?? null; // (n, op) => boolean
  const state = { writes_seen: 0 };

  const make_request = () => ({ result: undefined, error: null, onsuccess: null, onerror: null });

  class Tx {
    constructor(rec, names, mode) {
      this.rec = rec;
      this.mode = mode;
      this.names = names;
      for (const n of names) if (!rec.stores.has(n)) throw Object.assign(new Error('NotFoundError'), { name: 'NotFoundError' });
      this.staged = new Map();
      this.started = false;
      this.queue = [];
      this.pending = 0;
      this.finished = false;
      this.aborted = false;
      this.error = null;
      this.oncomplete = null;
      this.onabort = null;
      this.onerror = null;
      log.tx_started += 1;
      rec.txs.push(this);
      pump(rec);
    }

    /** Транзакция стартует, когда её не задерживает более ранняя с пересекающимися хранилищами (если одна из двух пишет) — как в IndexedDB. */
    start() {
      this.started = true;
      this.copied = new Set(); // запись идёт в копию хранилища, созданную при первом изменении (значения неизменяемы: наружу уходят клоны)
      for (const n of this.names) this.staged.set(n, this.rec.stores.get(n).rows);
      for (const run of this.queue.splice(0)) run();
      this.schedule();
    }

    schedule() {
      if (!this.started) return;
      tick(() => {
        if (this.finished || this.pending > 0) return;
        this.finished = true;
        if (this.mode === 'readwrite') for (const n of this.copied) this.rec.stores.get(n).rows = this.staged.get(n);
        log.tx_committed += 1;
        this.rec.txs = this.rec.txs.filter((t) => t !== this);
        pump(this.rec);
        this.oncomplete?.({ target: this });
      });
    }

    abort() {
      if (this.finished) throw Object.assign(new Error('InvalidStateError'), { name: 'InvalidStateError' });
      this.finished = true;
      this.aborted = true;
      log.tx_aborted += 1;
      this.rec.txs = this.rec.txs.filter((t) => t !== this);
      pump(this.rec);
      tick(() => this.onabort?.({ target: this }));
    }

    objectStore(name) {
      const tx = this;
      const def = tx.rec.stores.get(name);
      const rows = () => tx.staged.get(name);
      const wrows = () => { if (!tx.copied.has(name)) { tx.staged.set(name, new Map(tx.staged.get(name))); tx.copied.add(name); } return tx.staged.get(name); };
      const key_of = (v) => v[def.keyPath];
      const req_op = (op, writes, fn) => {
        if (tx.finished) throw Object.assign(new Error('TransactionInactiveError'), { name: 'TransactionInactiveError' });
        if (writes && tx.mode !== 'readwrite') throw Object.assign(new Error('ReadOnlyError'), { name: 'ReadOnlyError' });
        const req = make_request();
        tx.pending += 1;
        const exec = () => {
          tx.pending -= 1;
          if (tx.aborted) return;
          let failed = null;
          try {
            if (writes) {
              state.writes_seen += 1;
              log.writes += 1;
              if (fault !== null && fault(state.writes_seen, op) === true) throw Object.assign(new Error('QuotaExceededError'), { name: 'QuotaExceededError' });
            }
            req.result = fn();
          } catch (e) { failed = e; }
          if (failed !== null) {
            req.error = { name: failed.name ?? 'Error' };
            tx.error = req.error;
            req.onerror?.({ target: req });
            if (!tx.finished) { tx.finished = true; tx.aborted = true; log.tx_aborted += 1; tx.rec.txs = tx.rec.txs.filter((t) => t !== tx); pump(tx.rec); tick(() => tx.onabort?.({ target: tx })); }
            return;
          }
          req.onsuccess?.({ target: req });
          tx.schedule();
        };
        if (tx.started) tick(exec); else tx.queue.push(() => tick(exec));
        return req;
      };
      const sorted = (range) => {
        let all = [...rows().entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        if (range !== undefined && range !== null) all = all.filter(([k]) => (range.open ? k > range.lower : k >= range.lower));
        return all.map(([, v]) => clone(v));
      };
      return {
        add: (v) => req_op('add', true, () => {
          const k = key_of(v);
          if (rows().has(k)) throw Object.assign(new Error('ConstraintError'), { name: 'ConstraintError' });
          wrows().set(k, clone(v));
          return k;
        }),
        put: (v) => req_op('put', true, () => { wrows().set(key_of(v), clone(v)); return key_of(v); }),
        get: (k) => req_op('get', false, () => clone(rows().get(k))),
        getAll: (range) => req_op('getAll', false, () => sorted(range)),
        count: () => req_op('count', false, () => rows().size),
        delete: (k) => req_op('delete', true, () => { wrows().delete(k); return undefined; }),
        clear: () => req_op('clear', true, () => { wrows().clear(); return undefined; }),
      };
    }
  }

  const factory = {
    open(name, version) {
      const req = make_request();
      req.onupgradeneeded = null;
      req.onblocked = null;
      tick(() => {
        let rec = dbs.get(name);
        const fresh = rec === undefined;
        if (fresh) { rec = { version: 0, stores: new Map(), txs: [] }; dbs.set(name, rec); }
        const db = {
          onversionchange: null,
          closed: false,
          objectStoreNames: { contains: (n) => rec.stores.has(n) },
          createObjectStore: (n, o) => { rec.stores.set(n, { keyPath: o.keyPath, rows: new Map() }); },
          transaction: (names, mode) => {
            if (db.closed) throw Object.assign(new Error('InvalidStateError'), { name: 'InvalidStateError' });
            return new Tx(rec, Array.isArray(names) ? names : [...names], mode);
          },
          close: () => { db.closed = true; },
        };
        req.result = db;
        if (rec.version < version) { req.onupgradeneeded?.({ target: req }); rec.version = version; }
        req.onsuccess?.({ target: req });
      });
      return req;
    },
    deleteDatabase(name) {
      const req = make_request();
      tick(() => { dbs.delete(name); req.onsuccess?.({ target: req }); });
      return req;
    },
  };

  const IDBKeyRange = { lowerBound: (lower, open = false) => ({ lower, open }) };

  return {
    factory, IDBKeyRange, log, dbs,
    set_fault(f) { fault = f; state.writes_seen = 0; },
    /** Число записей в хранилище объектов (прямо из «диска», мимо транзакций). */
    rows(db_name, store) { const rec = dbs.get(db_name); return rec === undefined || !rec.stores.has(store) ? null : rec.stores.get(store).rows.size; },
  };
}
