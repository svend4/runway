// backup_file.test.mjs — автозапись копии журнала в выбранный файл (FP-19): REQ-097, IDEA-68, ADR-005 п.2, TST-38.
// Файл — подделка `FileSystemFileHandle` (createWritable / getFile / queryPermission), время и таймеры — подделки (порты), IndexedDB — фейк с хранением ссылки как есть:
// браузер, сеть и реальное время не нужны. Покрыто: успех, отказ, отзыв разрешения, сбой записи, круг хэша (прочитанное обратно даёт тот же state_hash), откат содержимого,
// запоминание ссылки между сеансами, запись по числу правок и по таймеру, откат на ручную выгрузку (фаза, баннер), снятие ссылки при удалении данных, ссылка в отдельной базе `runway-handles`.
// Сквозные проверки через среду выполнения и экран «Данные» — в tests/backup_file_boot.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  write_copy, create_file_backup, permission_of, classify_error, is_file_handle, safe_name, verify_by_hash, browser_file_api, system_timers,
  AUTO_DEFAULTS, PICKER_ID, FILE_CODES, FILE_PHASES, MAX_PREV_BYTES, NAME_MAX, DEFAULT_FILE_NAME,
} from '../demo/backup_file.mjs';
import { export_journal_copy, events_of_ws, hash_of_events, erase_all } from '../demo/data_actions.mjs';
import { make_backup_record, backup_banner, backup_counters, BANNER_REASONS, FILE_BANNER_REASONS } from '../demo/backup.mjs';
import { create_handle_store, HANDLE_DB_NAME, FILE_TARGET_KEY, DB_NAME } from '../demo/store_idb.mjs';
import { read_journal_json } from '../engine/io.mjs';
import { rights_report } from '../demo/rights.mjs';
import { apply_edit } from '../demo/ws_edit.mjs';
import catalog from '../demo/i18n/backupfile.mjs';
import { fake_idb } from './fake_idb.mjs';

const G001 = JSON.parse(fs.readFileSync(new URL('../data/g001.json', import.meta.url), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const named = (name) => Object.assign(new Error(name), { name });
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const utf8 = (s) => new TextEncoder().encode(s).length;

// ── подделки ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Подделка FileSystemFileHandle. `createWritable` пишет во временный буфер, настоящее содержимое подменяется только в `close()` (как в браузере).
 * `fail`: 'create' | 'write' | 'close' | 'read'; `corrupt(text)` — искажение при закрытии (первые `corrupt_times` записей).
 */
function fake_handle(o = {}) {
  const h = {
    kind: 'file', name: o.name ?? 'runway-journal-2026-10-23.json', content: o.content ?? '', perm: o.perm ?? 'granted', grant: o.grant ?? true,
    fail: o.fail ?? null, corrupt: o.corrupt ?? null, corrupt_left: o.corrupt_times ?? Infinity, log: [],
    async queryPermission(m) { h.log.push(['query', m.mode]); if (o.query_throws === true) throw named('SecurityError'); return h.perm; },
    async requestPermission(m) { h.log.push(['request', m.mode]); if (h.grant) h.perm = 'granted'; else h.perm = 'denied'; return h.perm; },
    async getFile() {
      h.log.push(['getFile']);
      if (h.fail === 'read') throw named('NotFoundError');
      const text = h.content;
      return { size: utf8(text), text: async () => text };
    },
    async createWritable(opts) {
      h.log.push(['createWritable', opts]);
      if (h.fail === 'create') throw named('NotAllowedError');
      let buf = '';
      return {
        async write(t) { if (h.fail === 'write') throw named('QuotaExceededError'); buf += t; },
        async close() {
          if (h.fail === 'close') throw named('InvalidStateError');
          if (h.corrupt !== null && h.corrupt_left > 0) { h.corrupt_left -= 1; h.content = h.corrupt(buf); } else h.content = buf;
        },
        async abort() { h.log.push(['abort']); },
      };
    },
  };
  return h;
}
const writes_of = (h) => h.log.filter((x) => x[0] === 'createWritable').length;

/** Таймеры-подделки: ничего не срабатывает само, `fire_all()` запускает все живые. */
function fake_timers() {
  let next = 1;
  const live = new Map();
  return {
    set: (fn, ms) => { const id = next++; live.set(id, { fn, ms }); return id; },
    clear: (id) => { live.delete(id); },
    count: () => live.size,
    delays: () => [...live.values()].map((t) => t.ms),
    fire_all() { const fns = [...live.values()]; live.clear(); for (const t of fns) t.fn(); },
  };
}

const edit = (ws, i) => {
  const r = apply_edit(ws, { type: 'add_fact', fact: { event_id: 'u_' + i, account_id: 'acc_main', date: '2026-10-03', amount_minor: -(100 + i), currency: 'EUR', tag: 'x' } }, { new_id: (p) => p + '_' + i });
  assert.ok(r.ok, JSON.stringify(r.error));
  return r.ws;
};

/** Контроллер на подделках. `st` — режим хранения, `page.ws` — рабочая область, `edit_once()` — правка с учётом в контроллере. */
function make_ctl(o = {}) {
  const st = { mode: 'active', read_only: false };
  const page = { ws: clone(G001), n: 0 };
  const records = [];
  const timers = fake_timers();
  const idb = o.idb ?? fake_idb({ clone: (x) => x });
  const handles = o.no_store === true ? null : create_handle_store({ indexedDB: idb.factory });
  const calls = { exclusive: 0, run: 0 };
  const handle = o.handle === undefined ? fake_handle() : o.handle;
  const api = o.api === undefined ? { showSaveFilePicker: async () => handle } : o.api;
  const ctl = create_file_backup({
    api, handle_store: handles, timers, today: () => '2026-10-23', state: () => st, every_events: o.every_events ?? 3, every_ms: o.every_ms ?? 60000,
    get_events: async () => { if (o.gate !== undefined) await o.gate; return { events: events_of_ws(page.ws), ws: page.ws }; },
    record: async (rec, ws) => { records.push({ rec, ws }); },
    run: (fn) => { calls.run += 1; return fn(); }, exclusive: (fn) => { calls.exclusive += 1; return fn(); },
    suggested_name: () => 'runway-journal-2026-10-23.json',
  });
  const count = () => events_of_ws(page.ws).length;
  return {
    ctl, st, page, records, timers, idb, handles, handle, calls, count,
    /** Пользовательская правка: рабочая область меняется, контроллер узнаёт число записей. */
    async edit_once() { page.n += 1; page.ws = edit(page.ws, page.n); ctl.note_change(count()); await settle(); },
  };
}

// ── write_copy: запись без потери, проверка кругом хэша ─────────────────────────────────────────────────────────────

const COPY = export_journal_copy(events_of_ws(G001));

test('REQ-097 write_copy: успех — createWritable({keepExistingData: false}), запись, закрытие, чтение обратно; круг: прочитанное даёт тот же state_hash', async () => {
  const h = fake_handle({ content: 'прежний файл' });
  const r = await write_copy(h, COPY.text, { verify: verify_by_hash(COPY.state_hash) });
  assert.deepEqual(r, { ok: true, bytes: COPY.bytes });
  assert.equal(h.content, COPY.text);
  const w = h.log.find((x) => x[0] === 'createWritable');
  assert.deepEqual(w[1], { keepExistingData: false }, 'прежнее содержимое не дописывается: файл заменяется целиком');
  assert.deepEqual(h.log[0], ['query', 'readwrite'], 'сначала проверено разрешение на запись');
  // круг: файл, как он лежит теперь, читается движком и даёт то же состояние
  assert.equal(hash_of_events(read_journal_json(h.content).events), COPY.state_hash);
  // без verify — точное совпадение текста
  const h2 = fake_handle();
  assert.equal((await write_copy(h2, 'abc')).ok, true);
  assert.equal(h2.content, 'abc');
});

test('REQ-097 verify_by_hash: тот же журнал — да; другой журнал, обрезанный и нечитаемый файл — нет', () => {
  const ok = verify_by_hash(COPY.state_hash);
  assert.equal(ok(COPY.text), true);
  const other = export_journal_copy(events_of_ws(edit(G001, 1)));
  assert.equal(ok(other.text), false, 'в файле другое состояние');
  assert.equal(ok(COPY.text.slice(0, COPY.text.length - 40)), false, 'обрезанный файл');
  assert.equal(ok('не json'), false);
  assert.equal(ok(''), false);
});

test('REQ-097 write_copy: отказ браузера при создании записи — код permission, прежнее содержимое цело, запись не начиналась', async () => {
  const h = fake_handle({ content: 'прежний файл', fail: 'create' });
  const r = await write_copy(h, COPY.text);
  assert.deepEqual([r.ok, r.code], [false, 'permission']);
  assert.equal(h.content, 'прежний файл');
  assert.equal(h.log.some((x) => x[0] === 'abort'), false, 'писателя не было — отменять нечего');
});

test('REQ-097 write_copy: разрешение отозвано (queryPermission = prompt / denied) — запись не начинается, файл цел; requestPermission — только по запросу из жеста', async () => {
  for (const perm of ['prompt', 'denied']) {
    const h = fake_handle({ content: 'прежний файл', perm });
    const r = await write_copy(h, COPY.text);
    assert.deepEqual([r.ok, r.code, r.permission], [false, 'permission', perm]);
    assert.equal(writes_of(h), 0, 'createWritable не вызывался');
    assert.equal(h.log.some((x) => x[0] === 'request'), false, 'без запроса из жеста браузер не спрашивается');
    assert.equal(h.content, 'прежний файл');
  }
  // запрос из жеста: разрешено → запись идёт; отказ → denied
  const yes = fake_handle({ perm: 'prompt', grant: true });
  assert.equal((await write_copy(yes, COPY.text, { request: true })).ok, true);
  assert.deepEqual(yes.log.filter((x) => x[0] === 'request'), [['request', 'readwrite']]);
  const no = fake_handle({ perm: 'prompt', grant: false, content: 'прежний файл' });
  const r = await write_copy(no, COPY.text, { request: true });
  assert.deepEqual([r.ok, r.code, r.permission], [false, 'permission', 'denied']);
  assert.equal(no.content, 'прежний файл');
  // queryPermission бросает — считается отказом; без queryPermission — разрешение есть (запись сама скажет об отказе)
  assert.equal(await permission_of(fake_handle({ query_throws: true })), 'denied');
  assert.equal(await permission_of({ kind: 'file' }), 'granted');
  assert.equal(await permission_of({ queryPermission: async () => 'weird' }), 'prompt');
});

test('REQ-097 write_copy: сбой записи (нет места) и сбой закрытия — запись прервана, прежнее содержимое цело, код причины; abort вызван', async () => {
  const w = fake_handle({ content: 'прежний файл', fail: 'write' });
  const r1 = await write_copy(w, COPY.text);
  assert.deepEqual([r1.ok, r1.code], [false, 'quota']);
  assert.equal(w.content, 'прежний файл', 'файл подменяется только при закрытии: сбой записи его не трогает');
  assert.equal(w.log.some((x) => x[0] === 'abort'), true);
  const c = fake_handle({ content: 'прежний файл', fail: 'close' });
  const r2 = await write_copy(c, COPY.text);
  assert.deepEqual([r2.ok, r2.code], [false, 'write']);
  assert.equal(c.content, 'прежний файл');
  assert.equal(c.log.some((x) => x[0] === 'abort'), true);
});

test('REQ-097 write_copy: после закрытия файл не сошёлся с копией — код verify и откат прежнего содержимого; откат не удался — restored = false', async () => {
  const cut = (t) => t.slice(0, Math.floor(t.length / 2));
  const h = fake_handle({ content: 'прежний файл', corrupt: cut, corrupt_times: 1 });
  const r = await write_copy(h, COPY.text, { verify: verify_by_hash(COPY.state_hash) });
  assert.deepEqual([r.ok, r.code, r.restored], [false, 'verify', true]);
  assert.equal(h.content, 'прежний файл', 'прежнее содержимое возвращено');
  const bad = fake_handle({ content: 'прежний файл', corrupt: cut });
  const r2 = await write_copy(bad, COPY.text, { verify: verify_by_hash(COPY.state_hash) });
  assert.deepEqual([r2.ok, r2.code, r2.restored], [false, 'verify', false], 'откат тоже искажён: честно сообщается');
  // файл не читается после записи: проверка не пройдена
  const gone = fake_handle({ fail: 'read' });
  const r3 = await write_copy(gone, COPY.text);
  assert.deepEqual([r3.ok, r3.code, r3.restored], [false, 'verify', null], 'прежнее содержимое не читалось — откат не готовился');
});

test('REQ-097 write_copy: негодная ссылка (каталог, не файл, не текст) — bad_handle; прежнее содержимое слишком большое — откат не готовится, запись всё равно идёт', async () => {
  assert.equal((await write_copy({ kind: 'directory' }, 'x')).code, 'bad_handle');
  assert.equal((await write_copy(null, 'x')).code, 'bad_handle');
  assert.equal((await write_copy(fake_handle(), 42)).code, 'bad_handle');
  const big = fake_handle({ content: 'x' });
  const real_get = big.getFile;
  let first = true;
  big.getFile = async () => { if (first) { first = false; return { size: MAX_PREV_BYTES + 1, text: async () => { throw new Error('не должно читаться'); } }; } return real_get(); };
  const r = await write_copy(big, 'abc');
  assert.equal(r.ok, true);
  assert.equal(big.content, 'abc');
});

test('REQ-097 классификация сбоев и показ имени файла: код по имени исключения (текст не копируется), имя без управляющих знаков и не длиннее предела', () => {
  assert.deepEqual(['NotAllowedError', 'SecurityError', 'NotFoundError', 'QuotaExceededError', 'AbortError', 'InvalidStateError', undefined].map((n) => classify_error(n === undefined ? null : named(n))),
    ['permission', 'permission', 'not_found', 'quota', 'aborted', 'write', 'write']);
  for (const c of ['permission', 'not_found', 'quota', 'aborted', 'verify', 'write', 'copy', 'bad_handle']) assert.ok(FILE_CODES.includes(c), c);
  assert.equal(is_file_handle(fake_handle()), true);
  assert.equal(is_file_handle({ kind: 'directory', createWritable() {}, getFile() {} }), false);
  assert.equal(is_file_handle(null), false);
  assert.equal(safe_name({ name: 'a\u0000b\nc.json' }), 'abc.json');
  assert.equal(safe_name({ name: 'я'.repeat(500) }).length, NAME_MAX);
  assert.equal(safe_name({ name: '   ' }), DEFAULT_FILE_NAME);
  assert.equal(safe_name(null), DEFAULT_FILE_NAME);
  assert.deepEqual([...FILE_PHASES], ['unsupported', 'none', 'ready', 'permission', 'failed', 'off']);
});

// ── ссылка на файл: отдельная база `runway-handles` ───────────────────────────────────────────────────────────────

test('REQ-097 база ссылок: ключ и имя базы с приставкой runway; значение хранится как есть; плохой ключ — store_invalid; remove и destroy', async () => {
  assert.ok(HANDLE_DB_NAME.startsWith('runway') && HANDLE_DB_NAME !== DB_NAME, 'отдельная база, приставка runway');
  assert.ok(FILE_TARGET_KEY.startsWith('runway.'));
  const f = fake_idb({ clone: (x) => x });
  const hs = create_handle_store({ indexedDB: f.factory });
  assert.equal(await hs.get(FILE_TARGET_KEY), null);
  const h = fake_handle();
  await hs.put(FILE_TARGET_KEY, { v: 1, handle: h });
  const back = await hs.get(FILE_TARGET_KEY);
  assert.equal(back.handle, h, 'живая ссылка, а не JSON-копия');
  assert.equal(f.dbs.has(DB_NAME), false, 'основная база журнала не создавалась и не тронута');
  await assert.rejects(() => hs.get('чужой'), (e) => e.code === 'store_invalid');
  await assert.rejects(() => hs.put('other.key', 1), (e) => e.code === 'store_invalid');
  await hs.remove(FILE_TARGET_KEY);
  assert.equal(await hs.get(FILE_TARGET_KEY), null);
  await hs.put(FILE_TARGET_KEY, { v: 1, handle: h });
  assert.deepEqual(await hs.destroy(), { removed: 1 });
  assert.equal(f.dbs.has(HANDLE_DB_NAME), false, 'база снята целиком');
  assert.deepEqual(await hs.destroy(), { removed: 0 }, 'повтор без ошибки');
  assert.throws(() => create_handle_store({ indexedDB: null }), (e) => e.code === 'store_unavailable');
});

// ── контроллер: выбор файла, запоминание, возобновление ──────────────────────────────────────────────────────────────

test('REQ-097 без API файлов (Firefox, Safari, iOS): фаза unsupported, выбор отказывает, база ссылок не открывается; ручная выгрузка остаётся', async () => {
  const m = make_ctl({ api: null });
  assert.equal(m.ctl.status().phase, 'unsupported');
  assert.equal(m.ctl.status().supported, false);
  assert.deepEqual(await m.ctl.pick_target(), { ok: false, reason: 'unsupported' });
  await m.ctl.init({ known_count: 5 });
  assert.equal(m.idb.dbs.size, 0, 'база ссылок не создавалась');
  assert.deepEqual(await m.ctl.write_now('manual'), { ok: false, code: 'no_target' });
  m.ctl.note_change(100);
  assert.equal(m.timers.count(), 0);
});

test('REQ-097 pick_target: выбор файла вызывается синхронно (жест пользователя), параметры — id, имя, тип; ссылка запоминается в IndexedDB; сброс сведений о прежнем файле', async () => {
  const m = make_ctl();
  let asked = null;
  let sync_seen = false;
  const handle = m.handle;
  const api_pick = (o) => { asked = o; sync_seen = true; return Promise.resolve(handle); };
  const ctl = create_file_backup({
    api: { showSaveFilePicker: api_pick }, handle_store: m.handles, timers: m.timers, today: () => '2026-10-23', state: () => m.st, get_events: async () => ({ events: events_of_ws(G001) }),
    suggested_name: () => 'runway-journal-2026-10-23.json',
  });
  const p = ctl.pick_target();
  assert.equal(sync_seen, true, 'showSaveFilePicker вызван до первого await: иначе браузер не засчитает жест пользователя');
  assert.equal(asked.id, PICKER_ID);
  assert.equal(asked.suggestedName, 'runway-journal-2026-10-23.json');
  assert.deepEqual(asked.types[0].accept, { 'application/json': ['.json'] });
  const r = await p;
  assert.deepEqual(r, { ok: true, name: handle.name, remembered: true });
  assert.equal(ctl.status().phase, 'ready');
  assert.equal(ctl.status().remembered, true);
  const stored = await m.handles.get(FILE_TARGET_KEY);
  assert.equal(stored.v, 1);
  assert.equal(stored.handle, handle);
});

test('REQ-097 pick_target: отмена выбора, не файл, отказ браузера, исключение при вызове, «только чтение» и после удаления — без изменения состояния', async () => {
  const cancel = make_ctl({ api: { showSaveFilePicker: async () => { throw named('AbortError'); } } });
  assert.deepEqual(await cancel.ctl.pick_target(), { ok: false, reason: 'cancelled' });
  assert.equal(cancel.ctl.status().phase, 'none');
  const dir = make_ctl({ api: { showSaveFilePicker: async () => ({ kind: 'directory' }) } });
  assert.deepEqual(await dir.ctl.pick_target(), { ok: false, reason: 'bad_handle' });
  const sec = make_ctl({ api: { showSaveFilePicker: async () => { throw named('SecurityError'); } } });
  assert.deepEqual(await sec.ctl.pick_target(), { ok: false, reason: 'permission' });
  const thrown = make_ctl({ api: { showSaveFilePicker: () => { throw new TypeError('x'); } } });
  assert.deepEqual(await thrown.ctl.pick_target(), { ok: false, reason: 'picker_failed' });
  const ro = make_ctl();
  ro.st.read_only = true;
  assert.deepEqual(await ro.ctl.pick_target(), { ok: false, reason: 'read_only' });
  assert.equal(ro.ctl.status().phase, 'none');
  const gone = make_ctl();
  gone.ctl.stop();
  assert.deepEqual(await gone.ctl.pick_target(), { ok: false, reason: 'erased' });
  // хранилище ссылок недоступно: файл выбран на этот сеанс, но не запомнен
  const broken = make_ctl();
  broken.handles.put = async () => { throw named('QuotaExceededError'); };
  const r = await broken.ctl.pick_target();
  assert.deepEqual([r.ok, r.remembered], [true, false]);
  assert.equal(broken.ctl.status().remembered, false);
});

test('REQ-097 запоминание между сеансами: новая вкладка вспоминает ссылку и разрешение; разрешения нет — фаза permission; негодная запись в базе удаляется', async () => {
  const m = make_ctl();
  await m.ctl.pick_target();
  // «перезагрузка страницы»: новый контроллер над той же базой
  const again = make_ctl({ idb: m.idb, handle: m.handle, api: { showSaveFilePicker: async () => m.handle } });
  const s = await again.ctl.init({ known_count: -1 });
  assert.deepEqual([s.phase, s.name, s.remembered, s.permission, s.last_error], ['ready', m.handle.name, true, 'granted', null]);
  assert.equal((await again.ctl.write_now('manual')).ok, true);
  assert.equal(m.handle.content.includes('runway-journal/1'), true, 'писал в тот же файл: ссылка живая');
  // браузер перезапущен: разрешение вернулось к «спросить»
  m.handle.perm = 'prompt';
  const third = make_ctl({ idb: m.idb, api: { showSaveFilePicker: async () => m.handle } });
  const s3 = await third.ctl.init();
  assert.deepEqual([s3.phase, s3.permission, s3.last_error], ['permission', 'prompt', 'permission']);
  third.page.ws = edit(third.page.ws, 1);
  third.ctl.note_change(third.count());
  await settle();
  assert.equal(third.timers.count(), 0, 'без разрешения таймер не заводится');
  assert.equal(writes_of(m.handle), 1, 'и запись не пробуется (одна запись — из прошлого шага)');
  // негодная запись
  const f = fake_idb({ clone: (x) => x });
  const hs = create_handle_store({ indexedDB: f.factory });
  await hs.put(FILE_TARGET_KEY, { v: 2, handle: m.handle });
  const bad = make_ctl({ idb: f });
  assert.equal((await bad.ctl.init()).phase, 'none');
  assert.equal(await hs.get(FILE_TARGET_KEY), null, 'негодная запись снята');
  await hs.put(FILE_TARGET_KEY, { v: 1, handle: { kind: 'directory' } });
  assert.equal((await make_ctl({ idb: f }).ctl.init()).phase, 'none');
});

test('REQ-097 request_permission: разрешено — фаза ready и запись возможна; отказ — остаётся permission; без файла и после удаления — отказ', async () => {
  const m = make_ctl();
  await m.ctl.pick_target();
  assert.deepEqual(await make_ctl().ctl.request_permission(), { ok: false, reason: 'no_target' });
  m.handle.perm = 'prompt';
  m.handle.grant = false;
  const no = await m.ctl.request_permission();
  assert.deepEqual([no.ok, no.reason, no.permission], [false, 'permission', 'denied']);
  assert.equal(m.ctl.status().phase, 'permission');
  assert.equal(m.ctl.status().permission, 'denied');
  m.handle.grant = true;
  assert.deepEqual(await m.ctl.request_permission(), { ok: true });
  assert.equal(m.ctl.status().phase, 'ready');
  assert.equal((await m.ctl.write_now('permission')).ok, true);
  m.ctl.stop();
  assert.deepEqual(await m.ctl.request_permission(), { ok: false, reason: 'erased' });
});

// ── запись по числу правок и по таймеру ─────────────────────────────────────────────────────────────────────────────

test('REQ-097 запись после каждой N-й правки: до порога только таймер (с заданным сроком), на N-й — запись, круг хэша сходится, запись о копии с via = file сбрасывает счётчик', async () => {
  const m = make_ctl({ every_events: 3, every_ms: 60000 });
  await m.ctl.pick_target();
  await m.ctl.init({ known_count: m.count() }); // файл уже содержит состояние на сегодня
  await m.edit_once();
  await m.edit_once();
  assert.equal(writes_of(m.handle), 0, 'до порога записи нет');
  assert.deepEqual(m.timers.delays(), [60000], 'таймер заведён один раз, на заданный срок');
  assert.equal(m.ctl.status().pending, 2);
  await m.edit_once();
  assert.equal(writes_of(m.handle), 1, 'на 3-й правке — запись');
  assert.equal(m.timers.count(), 0, 'таймер снят');
  assert.equal(hash_of_events(read_journal_json(m.handle.content).events), hash_of_events(events_of_ws(m.page.ws)), 'прочитанное из файла — то же состояние');
  assert.equal(m.records.length, 1);
  assert.deepEqual(m.records[0].rec, make_backup_record({ day: '2026-10-23', count: m.count(), hash: hash_of_events(events_of_ws(m.page.ws)), via: 'file' }));
  const s = m.ctl.status();
  assert.deepEqual([s.phase, s.pending, s.last_error, s.last_ok.count], ['ready', 0, null, m.count()]);
  assert.equal(m.calls.exclusive, 1, 'запись и проверка — под замком «один писатель»');
  assert.ok(m.calls.run >= 1, 'запись идёт через очередь страницы');
  // следующая серия: ещё три правки — ещё одна запись
  await m.edit_once();
  await m.edit_once();
  await m.edit_once();
  assert.equal(writes_of(m.handle), 2);
  assert.equal(m.records.length, 2);
});

test('REQ-097 запись по таймеру: одна правка заводит таймер, срабатывание пишет файл; без правок таймера нет; повторные правки не плодят таймеры', async () => {
  const m = make_ctl({ every_events: 10, every_ms: 90000 });
  await m.ctl.pick_target();
  await m.ctl.init({ known_count: m.count() });
  m.ctl.note_change(m.count());
  assert.equal(m.timers.count(), 0, 'новых записей нет — таймера нет');
  await m.edit_once();
  await m.edit_once();
  assert.equal(m.timers.count(), 1);
  assert.equal(writes_of(m.handle), 0);
  m.timers.fire_all();
  await settle();
  assert.equal(writes_of(m.handle), 1);
  assert.equal(hash_of_events(read_journal_json(m.handle.content).events), hash_of_events(events_of_ws(m.page.ws)));
  assert.equal(m.ctl.status().pending, 0);
  assert.equal(m.timers.count(), 0);
});

test('REQ-097 неизвестное состояние файла (после перезапуска): первая же правка пишет файл целиком; восстановление из копии (force) тоже помечает файл устаревшим', async () => {
  const m = make_ctl({ every_events: 1000 });
  await m.ctl.pick_target();
  await m.ctl.init({ known_count: -1 });
  m.ctl.note_change(m.count());
  assert.equal(m.timers.count(), 1, 'число записей в файле неизвестно: запись по таймеру');
  m.timers.fire_all();
  await settle();
  assert.equal(writes_of(m.handle), 1);
  m.ctl.note_change(m.count());
  assert.equal(m.timers.count(), 0, 'файл актуален');
  m.ctl.note_change(m.count(), { force: true });
  assert.equal(m.timers.count(), 1, 'журнал заменён целиком — файл устарел');
});

// ── откат на ручную выгрузку ────────────────────────────────────────────────────────────────────────────────────────

test('REQ-097 сбой записи: фаза failed с кодом, запись о копии не делается, баннер включает ручную выгрузку; повтор только по таймеру; после починки — снова ready', async () => {
  const m = make_ctl({ every_events: 2 });
  await m.ctl.pick_target();
  await m.ctl.init({ known_count: m.count() });
  m.handle.fail = 'write';
  await m.edit_once();
  await m.edit_once();
  const s = m.ctl.status();
  assert.deepEqual([s.phase, s.last_error], ['failed', 'quota']);
  assert.equal(m.records.length, 0, 'неудачная запись копией не считается: напоминание продолжает считать от прежней копии');
  assert.equal(m.timers.count(), 1, 'повтор заведён по таймеру');
  const banner = backup_banner({ due: false, persisted: true, installed: true, store_kind: 'idb', file_phase: s.phase });
  assert.deepEqual([banner.show, banner.reasons], [true, ['file_failed']]);
  const tries = writes_of(m.handle);
  await m.edit_once();
  await m.edit_once();
  assert.equal(writes_of(m.handle), tries, 'по числу правок неудачная запись не повторяется на каждой правке');
  m.handle.fail = null;
  m.timers.fire_all();
  await settle();
  assert.equal(m.ctl.status().phase, 'ready');
  assert.equal(m.ctl.status().last_error, null);
  assert.equal(m.records.length, 1);
  assert.equal(hash_of_events(read_journal_json(m.handle.content).events), hash_of_events(events_of_ws(m.page.ws)));
});

test('REQ-097 проверка не сошлась: файл возвращён к прежнему содержимому, фаза failed с кодом verify, данные в приложении не затронуты', async () => {
  const m = make_ctl({ handle: fake_handle({ content: 'прежняя копия', corrupt: (t) => t.slice(0, 50), corrupt_times: 1 }) });
  await m.ctl.pick_target();
  const r = await m.ctl.write_now('manual');
  assert.deepEqual([r.ok, r.code, r.restored], [false, 'verify', true]);
  assert.equal(m.handle.content, 'прежняя копия');
  assert.deepEqual([m.ctl.status().phase, m.ctl.status().last_error], ['failed', 'verify']);
  assert.equal(m.records.length, 0);
  // следующая попытка проходит
  const again = await m.ctl.write_now('manual');
  assert.equal(again.ok, true);
  assert.equal(m.ctl.status().phase, 'ready');
});

test('REQ-097 разрешение отозвано посреди сеанса: фаза permission, автозапись не пытается писать и таймер не заводит, баннер просит разрешение; после «Разрешить запись» — запись', async () => {
  const m = make_ctl({ every_events: 2 });
  await m.ctl.pick_target();
  await m.ctl.init({ known_count: m.count() });
  m.handle.perm = 'prompt';
  await m.edit_once();
  await m.edit_once();
  const s = m.ctl.status();
  assert.deepEqual([s.phase, s.permission, s.last_error], ['permission', 'prompt', 'permission']);
  assert.equal(writes_of(m.handle), 0, 'запись в файл не начиналась');
  assert.equal(m.timers.count(), 0);
  await m.edit_once();
  await m.edit_once();
  assert.equal(writes_of(m.handle), 0, 'повторов нет, пока разрешения нет');
  assert.deepEqual(backup_banner({ persisted: true, installed: true, store_kind: 'idb', file_phase: 'permission' }).reasons, ['file_permission']);
  assert.deepEqual(await m.ctl.write_now('timer'), { ok: false, code: 'permission' }, 'автозапись в этой фазе отказывает сразу');
  // жест пользователя
  const g = await m.ctl.request_permission();
  assert.equal(g.ok, true);
  assert.equal((await m.ctl.write_now('permission')).ok, true);
  assert.equal(m.ctl.status().phase, 'ready');
  assert.equal(hash_of_events(read_journal_json(m.handle.content).events), hash_of_events(events_of_ws(m.page.ws)));
});

test('REQ-097 копию журнала собрать не удалось: код copy, файл не тронут; режимы хранения: автозапись только в active, ручная — ещё и в fresh, в «только чтение» — никогда', async () => {
  const m = make_ctl({ handle: fake_handle({ content: 'прежний файл' }) });
  await m.ctl.pick_target();
  const bad = create_file_backup({
    api: { showSaveFilePicker: async () => m.handle }, handle_store: null, timers: fake_timers(), today: () => '2026-10-23', state: () => m.st,
    get_events: async () => ({ events: [{ type: 'nope' }] }),
  });
  await bad.pick_target();
  const r = await bad.write_now('manual');
  assert.deepEqual([r.ok, r.code], [false, 'copy']);
  assert.equal(m.handle.content, 'прежний файл');
  // режимы
  for (const mode of ['found', 'paused', 'erased', 'failed', 'idle']) {
    m.st.mode = mode;
    const x = await m.ctl.write_now('manual');
    assert.deepEqual([x.ok, x.code], [false, 'not_ready'], mode);
  }
  m.st.mode = 'fresh';
  assert.deepEqual(await m.ctl.write_now('timer'), { ok: false, code: 'not_ready', mode: 'fresh' }, 'автозапись в fresh не идёт');
  assert.equal((await m.ctl.write_now('manual')).ok, true, 'ручная запись в fresh идёт (как «Скачать журнал»)');
  m.st.mode = 'active';
  m.st.read_only = true;
  assert.deepEqual(await m.ctl.write_now('manual'), { ok: false, code: 'read_only' });
  m.ctl.note_change(500);
  assert.equal(m.timers.count(), 0, 'в «только чтении» автозапись молчит');
});

// ── снятие ссылки и удаление всех данных ─────────────────────────────────────────────────────────────────────────────

test('REQ-097 замок «один писатель» недоступен или запись упала неожиданно: итог — неудача с кодом, а не исключение; файл не тронут, следующая попытка идёт', async () => {
  const m = make_ctl({ handle: fake_handle({ content: 'прежний файл' }) });
  await m.ctl.pick_target();
  let broken = true;
  const ctl = create_file_backup({
    api: { showSaveFilePicker: async () => m.handle }, handle_store: null, timers: fake_timers(), today: () => '2026-10-23', state: () => m.st,
    get_events: async () => ({ events: events_of_ws(G001) }), exclusive: async (fn) => { if (broken) throw named('NotAllowedError'); return fn(); },
  });
  await ctl.pick_target();
  const r = await ctl.write_now('manual');
  assert.deepEqual([r.ok, r.code], [false, 'permission']);
  assert.equal(m.handle.content, 'прежний файл');
  assert.equal(ctl.status().phase, 'permission');
  broken = false;
  assert.equal((await ctl.write_now('manual')).ok, true);
  assert.equal(ctl.status().phase, 'ready');
});

test('REQ-097 «Не использовать файл»: ссылка снята из памяти и из базы, таймер остановлен, файл у пользователя не тронут', async () => {
  const m = make_ctl({ every_events: 100 });
  await m.ctl.pick_target();
  await m.ctl.init({ known_count: -1 });
  await m.edit_once();
  assert.equal(m.timers.count(), 1);
  const r = await m.ctl.forget();
  assert.deepEqual(r, { ok: true, had: true });
  assert.equal(m.ctl.status().phase, 'none');
  assert.equal(m.timers.count(), 0);
  assert.equal(await m.handles.get(FILE_TARGET_KEY), null);
  assert.equal(writes_of(m.handle), 0);
  assert.deepEqual(await m.ctl.write_now('manual'), { ok: false, code: 'no_target' });
});

test('REQ-097 «Удалить все данные» снимает запомненную ссылку: erase_port останавливает контроллер и снимает базу runway-handles; в квитанции шаг file_target', async () => {
  const m = make_ctl();
  await m.ctl.pick_target();
  assert.equal(m.idb.dbs.has(HANDLE_DB_NAME), true);
  const receipt = await erase_all({ file_target: m.ctl.erase_port(), today: () => '2026-10-23' }, { counts: { operations: 1, rules: 0, scenarios: 0 }, events: 1 });
  assert.equal(receipt.erased, true);
  assert.deepEqual(receipt.stores, [{ name: 'file_target', cleared: true, removed: 1 }]);
  assert.equal(receipt.copies_warning, true, 'предупреждение о файлах-копиях — всегда');
  assert.equal(m.idb.dbs.has(HANDLE_DB_NAME), false, 'ссылка снята вместе с базой');
  assert.equal(m.ctl.status().phase, 'off');
  assert.deepEqual(await m.ctl.write_now('manual'), { ok: false, code: 'erased' });
  m.ctl.note_change(1000);
  assert.equal(m.timers.count(), 0);
  assert.equal(writes_of(m.handle), 0, 'в файл после удаления ничего не пишется');
  // повтор не ошибается
  const again = await erase_all({ file_target: m.ctl.erase_port(), today: () => '2026-10-23' });
  assert.equal(again.erased, true);
  // сбой снятия базы виден в квитанции кодом, а не молча
  const failing = await erase_all({ file_target: { destroy: async () => { throw Object.assign(new Error('x'), { code: 'store_failed' }); } }, today: () => '2026-10-23' });
  assert.deepEqual([failing.erased, failing.errors], [false, ['file_target:store_failed']]);
  assert.deepEqual(failing.stores, [{ name: 'file_target', cleared: false }]);
  // без порта файла прежняя квитанция не меняется
  assert.deepEqual((await erase_all({ today: () => '2026-10-23' })).stores, []);
});

test('REQ-097 ссылку сняли посреди записи: результат target_changed, состояние и запись о копии не трогаются', async () => {
  let open_gate;
  const gate = new Promise((r) => { open_gate = r; });
  const m = make_ctl({ gate });
  await m.ctl.pick_target();
  const pending = m.ctl.write_now('manual');
  await settle();
  await m.ctl.forget();
  open_gate();
  const r = await pending;
  assert.deepEqual(r, { ok: false, code: 'target_changed' });
  assert.equal(m.records.length, 0);
  assert.equal(writes_of(m.handle), 0);
  assert.equal(m.ctl.status().phase, 'none');
});

// ── backup.mjs: учёт автозаписи в напоминании ───────────────────────────────────────────────────────────────────────────

test('REQ-097 backup.mjs: запись о копии с via = file; ручная выгрузка без поля; негодный способ — RangeError; счётчики напоминания считают от записи в файл так же', () => {
  const hash = 'b'.repeat(64);
  assert.deepEqual(make_backup_record({ day: '2026-10-23', count: 60, hash, via: 'file' }), { day: '2026-10-23', count: 60, hash, via: 'file' });
  assert.deepEqual(make_backup_record({ day: '2026-10-23', count: 60, hash }), { day: '2026-10-23', count: 60, hash }, 'вид ручной записи не изменился');
  assert.throws(() => make_backup_record({ day: '2026-10-23', count: 60, hash, via: 'cloud' }), RangeError);
  const rec = make_backup_record({ day: '2026-10-23', count: 60, hash, via: 'file' });
  assert.deepEqual(backup_counters({ count: 63, origin_count: 10, created_day: '2026-10-01', last_backup: rec, today: '2026-10-24' }), { events_since: 3, days_since: 1 });
});

test('REQ-097 backup.mjs: баннер получает фазу автозаписи — permission и failed дают отдельные причины сразу после due; другие фазы баннер не вызывают; перечень прежних причин не менялся', () => {
  assert.deepEqual([...BANNER_REASONS], ['due', 'volatile', 'persist_denied', 'persist_unknown', 'not_installed']);
  assert.deepEqual([...FILE_BANNER_REASONS], ['file_permission', 'file_failed']);
  const ok = { persisted: true, installed: true, store_kind: 'idb' };
  assert.deepEqual(backup_banner({ ...ok, file_phase: 'permission' }).reasons, ['file_permission']);
  assert.deepEqual(backup_banner({ ...ok, file_phase: 'failed' }).reasons, ['file_failed']);
  for (const p of ['unsupported', 'none', 'ready', 'off', null, undefined]) assert.deepEqual(backup_banner({ ...ok, file_phase: p }), { show: false, reasons: [] }, String(p));
  assert.deepEqual(backup_banner({ due: true, persisted: false, installed: false, store_kind: 'memory', file_phase: 'failed' }).reasons, ['due', 'file_failed', 'volatile', 'persist_denied', 'not_installed']);
  assert.ok(Object.isFrozen(FILE_BANNER_REASONS));
});

test('REQ-097 rights: строка про автозапись есть, только когда файл выбран (ready / permission / failed); без файла и в фазах none / unsupported / off отчёт прежний', () => {
  const base = rights_report({ store_kind: 'idb', persisted: true, count: 5 });
  assert.deepEqual(base.rows.map((r) => r.id), ['device', 'pin', 'copy', 'assistant', 'third']);
  for (const phase of ['none', 'unsupported', 'off', undefined]) assert.deepEqual(rights_report({ store_kind: 'idb', persisted: true, count: 5, file: { phase, name: 'a.json' } }).rows, base.rows, String(phase));
  const keys = { ready: 'backupfile.rights_ready', permission: 'backupfile.rights_permission', failed: 'backupfile.rights_failed' };
  for (const [phase, key] of Object.entries(keys)) {
    const rep = rights_report({ store_kind: 'idb', persisted: true, count: 5, file: { phase, name: 'a.json' } });
    assert.deepEqual(rep.rows.map((r) => r.id), ['device', 'pin', 'copy', 'file', 'assistant', 'third']);
    assert.deepEqual(rep.rows[3], { id: 'file', key, params: { name: 'a.json' } });
    assert.ok(Object.hasOwn(catalog.ru, key) && Object.hasOwn(catalog.en, key));
  }
});

test('REQ-097 init: число записей журнала сейчас учитывается — «ещё не записано» не считается от нуля, если файл актуален', async () => {
  const m = make_ctl();
  await m.ctl.pick_target();
  await m.ctl.init({ known_count: 50, count: 50 });
  assert.equal(m.ctl.status().pending, 0);
  await m.ctl.init({ known_count: 50, count: 53 });
  assert.equal(m.ctl.status().pending, 3);
});

// ── порты браузера и состав модуля ────────────────────────────────────────────────────────────────────────────────────

test('REQ-097 порты: browser_file_api сохраняет this и возвращает null без API; system_timers ставит и снимает таймер', async () => {
  const g = { showSaveFilePicker(o) { return this === g ? o : 'потерян this'; } };
  assert.deepEqual(browser_file_api(g).showSaveFilePicker({ a: 1 }), { a: 1 });
  assert.equal(browser_file_api({}), null);
  assert.equal(browser_file_api({ get showSaveFilePicker() { throw new Error('нет доступа'); } }), null);
  assert.equal(AUTO_DEFAULTS.every_events >= 1 && AUTO_DEFAULTS.every_ms >= 1000, true);
  assert.ok(Object.isFrozen(AUTO_DEFAULTS));
  const t = system_timers();
  let fired = 0;
  const cleared = t.set(() => { fired += 1; }, 5);
  t.clear(cleared);
  t.set(() => { fired += 10; }, 5);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(fired, 10, 'снятый таймер не сработал, оставленный — сработал один раз');
});

test('REQ-097 состав модуля: ни Date, ни сети, ни разметки из строк; ключи и имена с приставкой runway; ограничение «Safari и iOS не проверялось» в обоих языках каталога', () => {
  const src = fs.readFileSync(new URL('../demo/backup_file.mjs', import.meta.url), 'utf8');
  for (const bad of ['Date.now', 'new Date', 'fetch(', 'XMLHttpRequest', 'innerHTML', 'eval(', 'localStorage', 'sessionStorage']) assert.ok(!src.includes(bad), bad);
  assert.equal([...src.matchAll(/setTimeout|setInterval/g)].length, 1, 'таймер ставится только в порте system_timers');
  assert.ok(catalog.ru['backupfile.limit'].includes('Safari и iOS не проверялось'));
  assert.ok(/Safari and iOS behaviour was not tested/.test(catalog.en['backupfile.limit']));
  assert.deepEqual(Object.keys(catalog.ru).sort(), Object.keys(catalog.en).sort());
  for (const code of [...FILE_CODES, 'other']) assert.ok(Object.hasOwn(catalog.ru, 'backupfile.reason_' + code), 'нет причины ' + code);
  for (const r of FILE_BANNER_REASONS) assert.ok(Object.hasOwn(catalog.ru, 'backupfile.banner_' + r), 'нет баннера ' + r);
});
