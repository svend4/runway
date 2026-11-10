// store.test.mjs — порт `Store` (FP-05): REQ-122 (устойчивое хранилище: IndexedDB / память / localStorage, закрепление, Web Lock «один писатель»,
// оповещение вкладок), TST-38 (восстановление из копии при пустой базе — в data_actions.test.mjs).
// Контрактные тесты прогоняются на трёх реализациях порта: в памяти, на фейке IndexedDB (tests/fake_idb.mjs — в Node IndexedDB нет) и на localStorage-обёртке.
// Двухвкладочный тест использует настоящий navigator.locks (Node 24). Браузер не нужен.

import test from 'node:test';
import assert from 'node:assert/strict';

import { make_event, effective_events, reduce, state_hash } from '../engine/index.mjs';
import {
  StoreError, create_memory_store, create_memory_backing, create_local_store, create_lock, create_sync_channel, request_persistence,
  mirror_events, open_persistent, valid_channel_message, check_append, head_of, EMPTY_HEAD, KEEP_SNAPSHOTS,
} from '../demo/store.mjs';
import { create_idb_store, DB_NAME } from '../demo/store_idb.mjs';
import { open_journal } from '../demo/journal_log.mjs';
import { fake_idb } from './fake_idb.mjs';

// ── материал ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const AT = '2026-10-05T08:00:00Z';
const ev = (seq, type = 'tx.posted', payload = { account_id: 'a1', date: '2026-09-01', amount_minor: seq, currency: 'EUR', tag: 'x' }, extra = {}) =>
  make_event(type, payload, { event_id: 'e' + seq, seq, recorded_at: AT, entity_id: 'f' + seq, ...extra });
const plain = (e) => JSON.parse(JSON.stringify(e));
const batch = (from, n) => Array.from({ length: n }, (_, i) => ev(from + i));
const snap = (count) => ({ count, seq: count, state: { facts: {}, n: count } });
const code_of = async (p) => { try { await p; } catch (e) { return e instanceof StoreError ? e.code : 'other:' + e?.name; } return 'no_error'; };

/** Реализации порта: `shared()` — общая «база» (устройство), `open(shared)` → хранилище, `arm(shared, k)` — k-й изменяющий шаг следующей записи завершится сбоем. */
function fake_local_storage() {
  const map = new Map();
  const st = { map, fail_in: null };
  st.getItem = (k) => (map.has(k) ? map.get(k) : null);
  st.setItem = (k, v) => { if (st.fail_in !== null && --st.fail_in <= 0) { st.fail_in = null; throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' }); } map.set(k, String(v)); };
  st.removeItem = (k) => { map.delete(k); };
  return st;
}
const IMPLS = [
  {
    name: 'memory',
    shared: () => ({ backing: create_memory_backing(), fail_in: null }),
    open: (s) => create_memory_store({ backing: s.backing, fault: () => { if (s.fail_in !== null && --s.fail_in <= 0) { s.fail_in = null; throw new Error('QuotaExceededError'); } } }),
    arm: (s, k) => { s.fail_in = k; },
  },
  {
    name: 'idb (фейк)',
    shared: () => { const f = fake_idb(); return { f }; },
    open: (s) => create_idb_store({ indexedDB: s.f.factory, IDBKeyRange: s.f.IDBKeyRange }),
    arm: (s, k) => { s.f.set_fault((n) => n === k); },
  },
  {
    name: 'localStorage',
    shared: () => ({ storage: fake_local_storage() }),
    open: (s) => create_local_store({ storage: s.storage }),
    arm: (s, k) => { s.storage.fail_in = k; },
  },
];

// ── контракт порта Store ────────────────────────────────────────────────────────────────────────────────────────────────

for (const impl of IMPLS) {
  const T = (name, fn) => test(`REQ-122 контракт Store [${impl.name}]: ${name}`, fn);

  T('пусто: load и stat без записей, kind назван', async () => {
    const st = impl.open(impl.shared());
    assert.ok(['memory', 'idb', 'local'].includes(st.kind));
    assert.deepEqual(await st.load(), { events: [], snapshots: [], meta: {} });
    const s = await st.stat();
    assert.deepEqual([s.count, s.last_seq, s.last_event_id, s.snapshots, s.meta_keys], [0, 0, null, 0, []]);
    assert.deepEqual(await st.read_after(0), []);
  });

  T('append → load: записи по возрастанию seq, «голова» верна, копии не ссылки, переживает «закрытие и открытие»', async () => {
    const shared = impl.shared();
    const st = impl.open(shared);
    const h1 = await st.append(batch(1, 3));
    assert.deepEqual(h1, { count: 3, last_seq: 3, last_event_id: 'e3' });
    await st.append([ev(4)]);
    const data = await st.load();
    assert.deepEqual(data.events.map((e) => e.seq), [1, 2, 3, 4]);
    assert.deepEqual(data.events[0], plain(ev(1)));
    data.events[0].payload.amount_minor = 99999; // правка копии не меняет хранилище
    assert.equal((await st.load()).events[0].payload.amount_minor, 1);
    await st.close();
    const st2 = impl.open(shared); // «вкладка открыта заново»: данные на месте
    assert.equal((await st2.stat()).count, 4);
    assert.deepEqual((await st2.read_after(2)).map((e) => e.seq), [3, 4]);
  });

  T('append отказывает, если seq не больше головы или не растёт внутри пачки, и если event_id повторён: ничего не записано, код store_conflict / store_invalid', async () => {
    const st = impl.open(impl.shared());
    await st.append(batch(1, 3));
    assert.equal(await code_of(st.append([ev(3, undefined, undefined, { event_id: 'dup' })])), 'store_conflict', 'seq равен голове');
    assert.equal(await code_of(st.append([ev(2)])), 'store_conflict', 'seq меньше головы');
    assert.equal(await code_of(st.append([ev(5), ev(4)])), 'store_conflict', 'внутри пачки seq не растёт');
    assert.equal(await code_of(st.append([ev(4), ev(5, undefined, undefined, { event_id: 'e4' })])), 'store_invalid', 'event_id повторён в пачке');
    assert.equal(await code_of(st.append([{ type: 'x', event_id: 'q', seq: 1.5 }])), 'store_invalid', 'seq не целое');
    assert.equal(await code_of(st.append('не массив')), 'store_invalid');
    assert.equal((await st.stat()).count, 3, 'после отказов в хранилище те же три записи');
    assert.deepEqual(await st.append([]), { count: 3, last_seq: 3, last_event_id: 'e3' }, 'пустая пачка — не запись');
  });

  T('сбой записи откатывает транзакцию целиком: пачка из 10 записей не остаётся «наполовину»; следующая запись проходит', async () => {
    const shared = impl.shared();
    const st = impl.open(shared);
    await st.append(batch(1, 2));
    impl.arm(shared, 1);
    assert.equal(await code_of(st.append(batch(3, 10))), 'store_failed');
    const s = await st.stat();
    assert.deepEqual([s.count, s.last_seq], [2, 2], 'ни одной из десяти записей');
    assert.equal((await st.load()).events.length, 2);
    await st.append(batch(3, 10)); // сбой разовый: хранилище в порядке
    assert.equal((await st.stat()).count, 12);
  });

  T('снимки: хранятся два последних (KEEP_SNAPSHOTS), повтор той же длины заменяет, неверная форма отвергается', async () => {
    const st = impl.open(impl.shared());
    assert.equal(KEEP_SNAPSHOTS, 2);
    for (const c of [10, 20, 30]) await st.put_snapshot(snap(c));
    await st.put_snapshot({ ...snap(30), state: { facts: {}, n: 'новый' } });
    const data = await st.load();
    assert.deepEqual(data.snapshots.map((s) => s.count), [20, 30]);
    assert.equal(data.snapshots[1].state.n, 'новый');
    assert.equal(await code_of(st.put_snapshot({ count: -1, seq: 0, state: {} })), 'store_invalid');
    assert.equal(await code_of(st.put_snapshot({ count: 5, seq: 5, state: 'не объект' })), 'store_invalid');
    assert.equal((await st.stat()).snapshots, 2);
  });

  T('метаданные: запись и чтение, ключ по шаблону, значения без опасных ключей и без не-JSON', async () => {
    const st = impl.open(impl.shared());
    await st.set_meta('last_backup', { day: '2026-10-05', hash: 'abc', n: 3 });
    await st.set_meta('pending', 7);
    assert.deepEqual(await st.get_meta(), { last_backup: { day: '2026-10-05', hash: 'abc', n: 3 }, pending: 7 });
    assert.deepEqual((await st.stat()).meta_keys, ['last_backup', 'pending']);
    for (const k of ['Bad', '1x', '$head', '', 'a'.repeat(41), '__proto__']) assert.equal(await code_of(st.set_meta(k, 1)), 'store_invalid', 'ключ ' + k);
    assert.equal(await code_of(st.set_meta('ok', JSON.parse('{"__proto__": {"x": 1}}'))), 'store_invalid');
    assert.equal(await code_of(st.set_meta('ok', JSON.parse('{"a": {"constructor": 1}}'))), 'store_invalid');
    assert.equal(await code_of(st.set_meta('ok', undefined)), 'store_invalid');
    assert.equal(await code_of(st.set_meta('ok', Number.NaN)), 'store_invalid');
    assert.equal(await code_of(st.set_meta('ok', () => 1)), 'store_invalid');
    assert.equal(Object.prototype.x, undefined, 'прототип не загрязнён');
  });

  T('replace: заменяет всё целиком (записи, снимки, метаданные); неверная пачка не трогает прежнее; clear и destroy очищают', async () => {
    const shared = impl.shared();
    const st = impl.open(shared);
    await st.append(batch(1, 5));
    await st.put_snapshot(snap(5));
    await st.set_meta('pending', 5);
    const head = await st.replace({ events: batch(1, 2), snapshots: [snap(2)], meta: { pending: 0, created_day: '2026-10-05' } });
    assert.deepEqual(head, { count: 2, last_seq: 2, last_event_id: 'e2' });
    const d = await st.load();
    assert.deepEqual([d.events.length, d.snapshots.length, d.meta], [2, 1, { pending: 0, created_day: '2026-10-05' }]);
    assert.equal(await code_of(st.replace({ events: [ev(2), ev(1)] })), 'store_conflict', 'seq не растёт');
    assert.equal(await code_of(st.replace({ events: batch(1, 2), meta: { 'Плохой': 1 } })), 'store_invalid');
    assert.equal((await st.stat()).count, 2, 'прежнее цело');
    impl.arm(shared, 1);
    assert.equal(await code_of(st.replace({ events: batch(1, 9) })), 'store_failed');
    assert.equal((await st.stat()).count, 2, 'сбой замены: прежнее цело');
    await st.clear();
    assert.deepEqual(await st.load(), { events: [], snapshots: [], meta: {} });
    await st.append(batch(1, 1));
    await st.destroy();
    assert.deepEqual((await impl.open(shared).load()).events, [], 'после destroy новая вкладка видит пустую базу');
  });

  T('read_after: только записи после заданного seq; отрицательное и нецелое отвергаются', async () => {
    const st = impl.open(impl.shared());
    await st.append(batch(1, 6));
    assert.deepEqual((await st.read_after(4)).map((e) => e.seq), [5, 6]);
    assert.deepEqual(await st.read_after(6), []);
    assert.equal(await code_of(st.read_after(-1)), 'store_invalid');
    assert.equal(await code_of(st.read_after(1.2)), 'store_invalid');
  });

  T('запись замороженных записей журнала (как отдаёт create_journal) и ключей-ловушек: заморозка не мешает, __proto__ в записи отвергается', async () => {
    const st = impl.open(impl.shared());
    const frozen = Object.freeze({ ...ev(1), payload: Object.freeze({ ...ev(1).payload }) });
    await st.append([frozen]);
    assert.equal((await st.stat()).count, 1);
    const evil = JSON.parse('{"type":"tx.posted","event_id":"x","seq":2,"payload":{"__proto__":{"polluted":true}}}');
    assert.equal(await code_of(st.append([evil])), 'store_invalid');
    assert.equal({}.polluted, undefined);
  });
}

// ── особенности IndexedDB-обёртки ─────────────────────────────────────────────────────────────────────────────────────────

test('REQ-122 IndexedDB: сбой на 5-м из 10 запросов отменяет транзакцию — в базе 0 записей, голова прежняя, ошибка store_failed без текста браузера', async () => {
  const f = fake_idb();
  const st = create_idb_store({ indexedDB: f.factory, IDBKeyRange: f.IDBKeyRange });
  await st.append(batch(1, 2));
  f.set_fault((n) => n === 5);
  let err = null;
  try { await st.append(batch(3, 10)); } catch (e) { err = e; }
  assert.equal(err?.code, 'store_failed');
  assert.deepEqual(err.ctx.name, 'QuotaExceededError', 'в контексте только имя исключения');
  assert.equal(f.rows(DB_NAME, 'events'), 2, 'в хранилище объектов по-прежнему 2 записи');
  assert.ok(f.log.tx_aborted >= 1);
  f.set_fault(null);
  assert.deepEqual((await st.stat()).count, 2);
});

test('REQ-122 IndexedDB: две «вкладки» без замка читают одну голову, обе пишут seq 3 — вторая получает откат целиком (ConstraintError), потерь и дублей нет', async () => {
  const f = fake_idb();
  const a = create_idb_store({ indexedDB: f.factory, IDBKeyRange: f.IDBKeyRange });
  const b = create_idb_store({ indexedDB: f.factory, IDBKeyRange: f.IDBKeyRange });
  await a.append(batch(1, 2));
  const results = await Promise.allSettled([
    a.append([ev(3, undefined, undefined, { event_id: 'a3' }), ev(4, undefined, undefined, { event_id: 'a4' })]),
    b.append([ev(3, undefined, undefined, { event_id: 'b3' }), ev(4, undefined, undefined, { event_id: 'b4' })]),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  assert.equal(ok, 1, 'записала ровно одна вкладка');
  const data = await a.load();
  assert.deepEqual(data.events.map((e) => e.seq), [1, 2, 3, 4]);
  assert.equal(new Set(data.events.map((e) => e.event_id)).size, 4);
  const ids = data.events.slice(2).map((e) => e.event_id[0]);
  assert.equal(new Set(ids).size, 1, 'обе новые записи — от одной вкладки (пачка не смешана)');
});

test('REQ-122 IndexedDB: без IDBKeyRange read_after читает все записи и фильтрует; destroy снимает базу, повторное открытие даёт пустую; нет indexedDB — store_unavailable', async () => {
  const f = fake_idb();
  const st = create_idb_store({ indexedDB: f.factory, IDBKeyRange: null });
  await st.append(batch(1, 4));
  assert.deepEqual((await st.read_after(2)).map((e) => e.seq), [3, 4]);
  await st.destroy();
  assert.equal(f.dbs.has(DB_NAME), false, 'база снята');
  const again = create_idb_store({ indexedDB: f.factory });
  assert.equal((await again.stat()).count, 0);
  await again.destroy();
  await again.destroy(); // повтор не ошибается
  assert.throws(() => create_idb_store({ indexedDB: undefined }), (e) => e.code === 'store_unavailable');
  assert.throws(() => create_local_store({ storage: null }), (e) => e.code === 'store_unavailable');
});

test('REQ-122 localStorage: переполнение квоты — store_failed, прежний ключ цел; испорченный текст в ключе — store_corrupt без содержимого в ошибке', async () => {
  const storage = fake_local_storage();
  const st = create_local_store({ storage });
  await st.append(batch(1, 2));
  const before = storage.getItem('runway-store/1');
  storage.fail_in = 1;
  assert.equal(await code_of(st.append(batch(3, 3))), 'store_failed');
  assert.equal(storage.getItem('runway-store/1'), before, 'ключ не тронут');
  storage.setItem('runway-store/1', '{"секрет": 1');
  let err = null;
  try { await st.load(); } catch (e) { err = e; }
  assert.equal(err.code, 'store_corrupt');
  assert.ok(!String(err.message).includes('секрет'), 'в сообщении нет содержимого');
  storage.setItem('runway-store/1', JSON.stringify({ format: 'чужой' }));
  assert.equal(await code_of(st.stat()), 'store_corrupt');
});

// ── закрепление, замок, канал ───────────────────────────────────────────────────────────────────────────────────────────

test('REQ-122 REQ-097 persist(): не поддерживается → persisted null; уже закреплено → не просим; не закреплено → просим один раз; отказ браузера → persisted false; request:false только узнаёт', async () => {
  assert.deepEqual(await request_persistence(undefined), { supported: false, persisted: null, requested: false });
  assert.deepEqual(await request_persistence({}), { supported: false, persisted: null, requested: false });
  let asked = 0;
  assert.deepEqual(await request_persistence({ persisted: async () => true, persist: async () => { asked++; return true; } }), { supported: true, persisted: true, requested: false });
  assert.equal(asked, 0);
  assert.deepEqual(await request_persistence({ persisted: async () => false, persist: async () => { asked++; return true; } }), { supported: true, persisted: true, requested: true });
  assert.deepEqual(await request_persistence({ persisted: async () => false, persist: async () => false }), { supported: true, persisted: false, requested: true });
  assert.deepEqual(await request_persistence({ persisted: async () => false, persist: async () => { throw new Error('x'); } }), { supported: true, persisted: false, requested: true });
  assert.deepEqual(await request_persistence({ persisted: async () => false, persist: async () => { asked++; return true; } }, { request: false }), { supported: true, persisted: false, requested: false });
  assert.deepEqual(await request_persistence({ persisted: async () => { throw new Error('x'); } }), { supported: true, persisted: null, requested: false });
});

test('REQ-122 замок «один писатель»: Web Locks (navigator.locks Node 24) не пускает два участка одновременно; без API — очередь в странице, тот же порядок', async () => {
  for (const [kind, lock] of [['web_locks', create_lock({ name: 'runway-test-' + Math.random().toString(36).slice(2) })], ['in_process', create_lock({ locks: null })]]) {
    assert.equal(lock.kind, kind);
    let inside = 0;
    let overlap = 0;
    const order = [];
    const task = (id) => lock.run(async () => {
      inside += 1;
      if (inside > 1) overlap += 1;
      order.push('start' + id);
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
      order.push('end' + id);
      inside -= 1;
      return id;
    });
    assert.deepEqual(await Promise.all([task(1), task(2), task(3)]), [1, 2, 3]);
    assert.equal(overlap, 0, kind + ': участки не пересекались');
    assert.deepEqual(order, ['start1', 'end1', 'start2', 'end2', 'start3', 'end3'], kind + ': порядок очереди');
  }
  const lock = create_lock({ locks: null });
  await assert.rejects(lock.run(async () => { throw new Error('сбой участка'); }), /сбой участка/);
  assert.equal(await lock.run(async () => 'жив'), 'жив', 'сбой участка не ломает очередь');
});

test('REQ-122 канал вкладок: чужие сообщения доходят, свои — нет, мусор отбрасывается; без BroadcastChannel — пустышка', () => {
  const peers = [];
  class FakeBC {
    constructor(name) { this.name = name; this.onmessage = null; peers.push(this); }
    postMessage(data) { for (const p of peers) if (p !== this && p.name === this.name) p.onmessage?.({ data }); }
    close() { const i = peers.indexOf(this); if (i >= 0) peers.splice(i, 1); }
  }
  const a = create_sync_channel({ BroadcastChannel: FakeBC, tab_id: 'tab-a' });
  const b = create_sync_channel({ BroadcastChannel: FakeBC, tab_id: 'tab-b' });
  const got = [];
  b.subscribe((m) => got.push(m));
  a.post('appended', { count: 3, last_seq: 3 });
  assert.deepEqual(got, [{ v: 1, type: 'appended', from: 'tab-a', last_seq: 3, count: 3 }]);
  b.post('erased', { count: 0, last_seq: 0 });
  assert.equal(got.length, 1, 'свои сообщения не возвращаются');
  const raw = peers.find((p) => p !== peers[0]);
  for (const bad of [null, 'x', { v: 2 }, { v: 1, type: 'boom', from: 'x', last_seq: 1, count: 1 }, { v: 1, type: 'appended', from: 'x', last_seq: 1.5, count: 1 }, { v: 1, type: 'appended', from: 'x'.repeat(65), last_seq: 1, count: 1 }]) {
    assert.equal(valid_channel_message(bad), false);
    raw.onmessage({ data: bad });
  }
  assert.equal(got.length, 1, 'мусор отброшен');
  a.close(); b.close();
  const none = create_sync_channel({ BroadcastChannel: undefined, tab_id: 't' });
  assert.equal(none.kind, 'none');
  none.post('appended', { count: 0, last_seq: 0 });
  none.close();
});

// ── зеркало журнала страницы ────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-122 mirror_events: пустое хранилище → запись; хвост → дописывается; журнал пересобран → замена; чужая запись → store_conflict, ничего не затёрто; force заменяет намеренно', async () => {
  for (const impl of IMPLS) {
    const shared = impl.shared();
    const st = impl.open(shared);
    const evs = batch(1, 5);
    let r = await mirror_events(st, evs.slice(0, 3));
    assert.deepEqual([r.mode, r.appended, r.head.count], ['append', 3, 3], impl.name);
    r = await mirror_events(st, evs, { known_head: r.head });
    assert.deepEqual([r.mode, r.appended, r.head.count], ['append', 2, 5], impl.name);
    assert.equal((await mirror_events(st, evs, { known_head: r.head })).mode, 'noop', impl.name);
    // журнал страницы пересобран (другие event_id при тех же seq): хранилище — не префикс, значит замена
    const rebuilt = Array.from({ length: 6 }, (_, i) => ev(i + 1, undefined, undefined, { event_id: 'n' + (i + 1) }));
    r = await mirror_events(st, rebuilt, { known_head: head_of(evs) });
    assert.deepEqual([r.mode, r.head.count], ['replace', 6], impl.name);
    // другая вкладка дописала запись → голова не та, что мы видели
    await impl.open(shared).append([ev(7)]);
    assert.equal(await code_of(mirror_events(st, rebuilt, { known_head: r.head })), 'store_conflict', impl.name);
    assert.equal((await st.stat()).count, 7, 'запись другой вкладки не затёрта');
    // страница не знает состояния непустого хранилища (не выбрала «продолжить») — не пишем
    assert.equal(await code_of(mirror_events(st, rebuilt, { known_head: null })), 'store_conflict', impl.name);
    r = await mirror_events(st, rebuilt, { force: true });
    assert.deepEqual([r.mode, r.head.count], ['replace', 6], impl.name);
  }
});

// ── REQ-122: две вкладки по 1000 записей ──────────────────────────────────────────────────────────────────────────────

function writer_ports(tag) {
  let n = 0;
  return { next_id: () => tag + '~' + (++n), recorded_at: () => AT };
}
const fact_spec = (tag, i) => ({ type: 'tx.posted', payload: { account_id: 'a1', date: '2026-09-' + String((i % 28) + 1).padStart(2, '0'), amount_minor: -(i + 1), currency: 'EUR', tag: 'w' + tag }, opts: { entity_id: tag + '-' + i } });

async function two_writers(open_store, { n, lock_a, lock_b }) {
  const lock_shared = create_lock({ name: 'runway-test-' + Math.random().toString(36).slice(2) });
  const A = await open_persistent({ store: open_store(), lock: lock_a ?? lock_shared, ports: writer_ports('A'), snapshot_every: 500 });
  const B = await open_persistent({ store: open_store(), lock: lock_b ?? lock_shared, ports: writer_ports('B'), snapshot_every: 500 });
  await A.write([{ type: 'account.opened', payload: { account_id: 'a1', name: 'A', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 } }]);
  await B.refresh();
  const run = async (w, tag) => { for (let i = 0; i < n; i++) await w.write([fact_spec(tag, i)]); };
  await Promise.all([run(A, 'a'), run(B, 'b')]);
  await A.refresh();
  await B.refresh();
  return { A, B };
}

/** Состояние без служебного `event_id` фактов: он зависит от порядка записи (кто из писателей успел раньше), а сами операции — нет. */
function order_free_hash(state) {
  const copy = JSON.parse(JSON.stringify(state));
  for (const f of Object.values(copy.facts ?? {})) delete f.event_id;
  return state_hash(copy);
}

function expected_hash(n) {
  const evs = [make_event('account.opened', { account_id: 'a1', name: 'A', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 }, { event_id: 'x0', seq: 1, recorded_at: AT })];
  let seq = 1;
  for (const tag of ['a', 'b']) for (let i = 0; i < n; i++) { const s = fact_spec(tag, i); seq += 1; evs.push(make_event(s.type, s.payload, { event_id: 'x' + seq, seq, recorded_at: AT, ...s.opts })); }
  return order_free_hash(reduce(effective_events(evs)));
}

for (const impl of [IMPLS[0], IMPLS[1]]) {
  test(`REQ-122 две вкладки по 1000 записей под Web Lock [${impl.name}]: в журнале 2000+1 записей без потерь и дублей, один state_hash у обеих и у свежего чтения`, async () => {
    const shared = impl.shared();
    const N = 1000;
    const { A, B } = await two_writers(() => impl.open(shared), { n: N });
    const fresh = await impl.open(shared).load();
    assert.equal(fresh.events.length, 2 * N + 1, 'всего записей');
    assert.deepEqual(fresh.events.map((e) => e.seq), Array.from({ length: 2 * N + 1 }, (_, i) => i + 1), 'seq без дыр и повторов');
    assert.equal(new Set(fresh.events.map((e) => e.event_id)).size, 2 * N + 1, 'event_id без повторов');
    assert.equal(fresh.events.filter((e) => e.type === 'tx.posted').length, 2 * N);
    assert.equal(new Set(fresh.events.filter((e) => e.type === 'tx.posted').map((e) => e.entity_id)).size, 2 * N, 'каждая операция записана ровно один раз');
    assert.equal(A.stats.conflicts + B.stats.conflicts, 0, 'под замком конфликтов не было');
    const h_a = A.journal.state_hash();
    const h_b = B.journal.state_hash();
    const h_fresh = state_hash(reduce(effective_events(fresh.events)));
    assert.equal(h_a, h_b, 'вкладки сходятся');
    assert.equal(h_a, h_fresh, 'и со свежим чтением хранилища');
    assert.equal(order_free_hash(reduce(effective_events(fresh.events))), expected_hash(N), 'и с порядко-независимой свёрткой тех же операций (факты те же; event_id зависит от очереди записи и не сравнивается)');
    assert.ok(fresh.snapshots.length >= 1 && fresh.snapshots.length <= KEEP_SNAPSHOTS, 'снимки сохранены, не больше двух');
    // открытие по снимку даёт то же состояние (снимок проверяется хэшем)
    const reopened = open_journal(fresh, { verify: true });
    assert.equal(reopened.state_hash(), h_fresh);
  });
}

test('REQ-122 без межвкладочного замка (нет navigator.locks): записи не теряются — хранилище отказывает по seq, журнал перечитывается, запись повторяется; итог тот же state_hash', async () => {
  const shared = IMPLS[0].shared();
  const N = 150;
  const { A, B } = await two_writers(() => IMPLS[0].open(shared), { n: N, lock_a: create_lock({ locks: null }), lock_b: create_lock({ locks: null }) });
  const fresh = await IMPLS[0].open(shared).load();
  assert.equal(fresh.events.length, 2 * N + 1);
  assert.deepEqual(fresh.events.map((e) => e.seq), Array.from({ length: 2 * N + 1 }, (_, i) => i + 1));
  assert.ok(A.stats.conflicts + B.stats.conflicts > 0, 'гонка действительно была и была поймана проверкой seq');
  assert.equal(A.journal.state_hash(), B.journal.state_hash());
  assert.equal(order_free_hash(A.journal.state().state), expected_hash(N));
});

test('REQ-122 open_persistent: неверное описание записи — исключение, хранилище не тронуто; сбой записи — журнал в памяти возвращается к записанному', async () => {
  const shared = IMPLS[0].shared();
  const W = await open_persistent({ store: IMPLS[0].open(shared), lock: create_lock({ locks: null }), ports: writer_ports('W') });
  await W.write([{ type: 'account.opened', payload: { account_id: 'a1', name: 'A', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 } }]);
  await assert.rejects(W.write([{ type: 'нет такого вида', payload: {} }]));
  assert.equal((await IMPLS[0].open(shared).stat()).count, 1);
  IMPLS[0].arm(shared, 1);
  assert.equal(await code_of(W.write([fact_spec('w', 1)])), 'store_failed');
  assert.equal(W.journal.length, 1, 'журнал страницы не ушёл вперёд хранилища');
  await W.write([fact_spec('w', 2)]);
  assert.equal((await IMPLS[0].open(shared).stat()).count, 2);
  assert.equal(W.journal.length, 2);
});

test('REQ-122 check_append и head_of: «голова» пустого журнала и последняя запись; пачка проверяется до записи', () => {
  assert.deepEqual(head_of([]), { ...EMPTY_HEAD });
  assert.deepEqual(head_of(batch(1, 3)), { count: 3, last_seq: 3, last_event_id: 'e3' });
  assert.equal(check_append(EMPTY_HEAD, batch(1, 3)).length, 3);
  assert.throws(() => check_append({ count: 3, last_seq: 3, last_event_id: 'e3' }, [ev(3)]), (e) => e.code === 'store_conflict');
});

test('REQ-122 open_persistent.write {if_empty: true}: под замком непустое хранилище — store_conflict без записи (набор данных не пишется дважды); пустое — запись проходит', async () => {
  const shared = IMPLS[0].shared();
  const lock = create_lock({ locks: null });
  const A = await open_persistent({ store: IMPLS[0].open(shared), lock, ports: writer_ports('A') });
  const B = await open_persistent({ store: IMPLS[0].open(shared), lock, ports: writer_ports('B') });
  const first = [{ type: 'account.opened', payload: { account_id: 'a1', name: 'A', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 } }];
  await A.write(first, { if_empty: true });
  assert.equal(await code_of(B.write(first, { if_empty: true, retries: 0 })), 'store_conflict');
  assert.equal((await IMPLS[0].open(shared).stat()).count, 1, 'второй раз набор не записан');
  await B.write([fact_spec('b', 1)]); // обычная запись после «догнать» проходит
  assert.equal((await IMPLS[0].open(shared).stat()).count, 2);
});
