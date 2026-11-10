// backup_file_boot.test.mjs — автозапись в файл-копию на среде выполнения и на экране «Данные» (FP-19): REQ-097, REQ-098, REQ-122, TST-38, TST-56.
// Среда выполнения хранения (data_runtime) с подделками файла, таймеров и фейком IndexedDB; экран — на заглушке DOM (тот же приём, что в tests/data_pack.test.mjs).
// Покрыто: запись после каждой N-й правки и круг хэша на живом журнале, учёт автозаписи в напоминании (через N записей напоминания нет, без файла — есть),
// откат на ручную выгрузку (баннер, кнопки, копия журнала по-прежнему доступна), цепочка «Удалить все данные» (ссылка снята, база runway-handles удалена, запись остановлена),
// кнопка «Выбрать файл-копию» (в том числе в режиме «только чтение», причина текстом ro.refused) и возврат фокуса после действий. Браузер не нужен.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// ── заглушка DOM ──────────────────────────────────────────────────────────────────────────────────────────────────────
class Node_ {
  constructor(tag) { this.nodeType = 1; this.tagName = tag; this.attrs = {}; this.children = []; this.listeners = {}; this.className = ''; this._text = ''; this.open = false; }
  get textContent() { return this.children.length === 0 ? this._text : this.children.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  append(...kids) { for (const k of kids) this.children.push(k); this._text = ''; }
  replaceChildren(...kids) { this.children = []; this._text = ''; this.append(...kids); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  querySelectorAll() { return []; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { globalThis.__focused = this.attrs.id ?? null; }
  walk(fn) { fn(this); for (const c of this.children) if (c.nodeType === 1) c.walk(fn); }
}
const byid = new Map();
for (const id of ['dlg', 'dlg-title', 'dlg-close', 'dlg-body', 'live']) byid.set(id, new Node_(id === 'dlg' ? 'dialog' : 'div'));
globalThis.document = {
  createElement: (t) => new Node_(t), createElementNS: (_ns, t) => new Node_(t), createTextNode: (data) => ({ nodeType: 3, data }),
  getElementById: (id) => byid.get(id) ?? null, head: new Node_('head'), body: new Node_('body'),
};

const { create_runtime } = await import('../demo/data_runtime.mjs');
const { make_runtime } = await import('../demo/pack_fp05.mjs');
const { render_storage_section, render_backup_banner, render_erase_section } = await import('../demo/data_view.mjs');
const { create_memory_store, create_memory_backing, create_lock } = await import('../demo/store.mjs');
const { create_idb_store, DB_NAME, HANDLE_DB_NAME } = await import('../demo/store_idb.mjs');
const { hash_of_events, events_of_ws } = await import('../demo/data_actions.mjs');
const { read_journal_json } = await import('../engine/io.mjs');
const { apply_edit } = await import('../demo/ws_edit.mjs');
const { t, register_strings } = await import('../demo/i18n.mjs');
const { default: data_catalog } = await import('../demo/i18n/data.mjs');
const { default: file_catalog } = await import('../demo/i18n/backupfile.mjs');
const { fake_idb } = await import('./fake_idb.mjs');
register_strings('data', data_catalog);
register_strings('backupfile', file_catalog);

const G001 = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../data/g001.json', import.meta.url)), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const named = (name) => Object.assign(new Error(name), { name });
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const AT = '2026-10-05T08:00:00Z';
const find = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const button = (root, text) => find(root, (n) => n.tagName === 'button' && n.textContent === text)[0];
const by_id = (root, id) => find(root, (n) => n.attrs.id === id)[0];
const register_ids = (root) => root.walk((n) => { if (n.attrs.id !== undefined) byid.set(n.attrs.id, n); });

/** Подделка FileSystemFileHandle (как в tests/backup_file.test.mjs, в сокращении). */
function fake_handle(o = {}) {
  const h = {
    kind: 'file', name: o.name ?? 'runway-journal-2026-10-05.json', content: o.content ?? '', perm: o.perm ?? 'granted', fail: o.fail ?? null, log: [],
    async queryPermission() { return h.perm; },
    async requestPermission() { h.log.push('request'); h.perm = 'granted'; return h.perm; },
    async getFile() { const text = h.content; return { size: new TextEncoder().encode(text).length, text: async () => text }; },
    async createWritable() {
      h.log.push('createWritable');
      if (h.fail === 'create') throw named('NotAllowedError');
      let buf = '';
      return {
        async write(x) { if (h.fail === 'write') throw named('QuotaExceededError'); buf += x; },
        async close() { h.content = buf; },
        async abort() { h.log.push('abort'); },
      };
    },
  };
  return h;
}
const writes_of = (h) => h.log.filter((x) => x === 'createWritable').length;
function fake_timers() {
  let next = 1;
  const live = new Map();
  return { set: (fn, ms) => { const id = next++; live.set(id, { fn, ms }); return id; }, clear: (id) => { live.delete(id); }, count: () => live.size, fire_all() { const l = [...live.values()]; live.clear(); for (const x of l) x.fn(); } };
}
/** Фейк IndexedDB, который хранит ссылку на файл как есть (структурное клонирование браузера сохраняет живой объект), а остальное копирует как JSON. */
const smart_clone = (x) => (x === undefined ? undefined : x?.value?.handle?.kind === 'file' ? x : JSON.parse(JSON.stringify(x)));

function make_page(ws0) {
  let n = 0;
  const page = {
    ws: ws0, today: '2026-10-05', renders: 0, sets: [],
    get_ws: () => page.ws,
    set_ws: (ws, opts) => { page.ws = ws; page.sets.push(opts?.reason ?? 'edit'); return { ok: true }; },
    refresh: () => { page.renders += 1; },
  };
  page.ports = { next_id: () => 'p~' + (++n), recorded_at: () => AT };
  return page;
}
const edit = (ws, i) => {
  const r = apply_edit(ws, { type: 'add_fact', fact: { event_id: 'u_' + i, account_id: 'acc_main', date: '2026-10-03', amount_minor: -(100 + i), currency: 'EUR', tag: 'x' } }, { new_id: (p) => p + '_' + i });
  assert.ok(r.ok, JSON.stringify(r.error));
  return r.ws;
};
/** Правка страницы + уведомление среды хранения (как делает подписка `ctx.subscribe`). */
async function change(page, rt, i) {
  page.ws = edit(page.ws, i);
  await rt.on_change({ reason: 'add_fact', ws: page.ws });
  await settle();
}

/** Среда выполнения с автозаписью на памяти; `o.file` — порты файла. */
function runtime_with_file(page, o = {}) {
  const handle = o.handle ?? fake_handle();
  const timers = o.timers ?? fake_timers();
  const backing = create_memory_backing();
  const store = create_memory_store({ backing });
  const rt = create_runtime({
    store, store_kind: 'memory', lock: create_lock({ locks: null }), channel: null, storage_manager: { persisted: async () => true }, installed: () => true,
    today: () => page.today, ports: page.ports, get_ws: page.get_ws, set_ws: page.set_ws, refresh: page.refresh, read_only: o.read_only,
    file: o.no_file === true ? null : { api: o.api === undefined ? { showSaveFilePicker: async () => handle } : o.api, handle_store: null, timers, every_events: o.every_events ?? 3, every_ms: 60000 },
  });
  return { rt, handle, timers, store, backing };
}

// ── среда выполнения: запись после N-й правки, круг хэша, учёт в напоминании ──────────────────────────────────────────────

test('REQ-097 среда выполнения: файл выбран → копия записана и проверена; каждая N-я правка обновляет файл, прочитанное обратно даёт тот же state_hash, что и «Скачать журнал»', async () => {
  const page = make_page(clone(G001));
  const { rt, handle, timers } = runtime_with_file(page, { every_events: 3 });
  await rt.init();
  assert.equal(rt.status().file.phase, 'none');
  const picked = await rt.file_pick();
  assert.deepEqual([picked.ok, picked.write.ok], [true, true]);
  assert.equal(picked.write.count, events_of_ws(G001).length);
  assert.equal(hash_of_events(read_journal_json(handle.content).events), hash_of_events(events_of_ws(G001)), 'первая запись: файл = набор данных на странице');
  assert.equal(rt.status().file.phase, 'ready');
  const w0 = writes_of(handle);
  await change(page, rt, 1);
  await change(page, rt, 2);
  assert.equal(writes_of(handle), w0, 'до порога файл не перезаписывается');
  assert.equal(timers.count(), 1);
  await change(page, rt, 3);
  assert.equal(writes_of(handle), w0 + 1, 'на 3-й правке файл обновлён');
  assert.equal(timers.count(), 0);
  // круг: то, что в файле, равно журналу хранилища (набор данных и три правки)
  const now = await rt.export_copy();
  assert.equal(hash_of_events(read_journal_json(handle.content).events), now.state_hash);
  assert.equal(now.count, events_of_ws(G001).length + 3);
  // записи о копии: последняя — ручная (без via), а перед ней автозапись отмечена via = file
  assert.equal(rt.status().last_backup.via, undefined);
  assert.equal(rt.status().file.last_ok.via, 'file');
});

test('REQ-097 учёт автозаписи в напоминании: через N правок копия в файле сбрасывает счётчик — напоминания «пора скачать» нет; без файла те же правки напоминание дают', async () => {
  const ws0 = clone(G001);
  ws0.params = { ...(ws0.params ?? {}), 'backup.remind_events': 5 };
  // с файлом
  const a = make_page(clone(ws0));
  const A = runtime_with_file(a, { every_events: 3 });
  await A.rt.init();
  await A.rt.file_pick();
  for (let i = 1; i <= 5; i++) await change(a, A.rt, i);
  const sa = A.rt.status();
  assert.equal(sa.last_backup.via, 'file', 'последняя копия — автозапись в файл');
  assert.equal(sa.last_backup.count, events_of_ws(G001).length + 3, 'на 3-й правке');
  assert.equal(sa.events_since, 2, 'после неё — две правки');
  assert.equal(sa.due.due, false, 'порог 5 не достигнут: напоминания нет');
  assert.equal(sa.banner.reasons.includes('due'), false);
  // без файла
  const b = make_page(clone(ws0));
  const B = runtime_with_file(b, { no_file: true });
  await B.rt.init();
  assert.equal(B.rt.status().file, null);
  for (let i = 1; i <= 5; i++) await change(b, B.rt, i);
  const sb = B.rt.status();
  assert.equal(sb.events_since, 5);
  assert.equal(sb.due.due, true, 'без файла пять правок — «пора скачать журнал»');
  assert.equal(sb.banner.reasons[0], 'due');
  // отчёт «где что лежит» называет файл
  assert.ok(sa.rights.rows.some((r) => r.id === 'file' && r.key === 'backupfile.rights_ready' && r.params.name === A.handle.name));
  assert.ok(!sb.rights.rows.some((r) => r.id === 'file'), 'без файла отчёт прежний');
});

test('REQ-097 откат на ручную выгрузку: запись в файл не удалась — фаза failed, баннер с ручной выгрузкой, данные в хранилище целы, «Скачать журнал» (копия) работает и отмечается как последняя', async () => {
  const page = make_page(clone(G001));
  const { rt, handle, timers, store } = runtime_with_file(page, { every_events: 2 });
  await rt.init();
  await rt.file_pick();
  handle.fail = 'write';
  const before = handle.content;
  await change(page, rt, 1);
  await change(page, rt, 2);
  const s = rt.status();
  assert.deepEqual([s.file.phase, s.file.last_error], ['failed', 'quota']);
  assert.ok(s.banner.show && s.banner.reasons.includes('file_failed'));
  assert.equal(handle.content, before, 'файл не тронут: запись прервана до подмены');
  assert.equal((await store.stat()).count, events_of_ws(G001).length + 2, 'журнал в хранилище цел');
  assert.equal(timers.count(), 1, 'повтор — по таймеру');
  // ручная выгрузка
  const copy = await rt.export_copy();
  assert.equal(copy.count, events_of_ws(G001).length + 2);
  assert.equal(hash_of_events(read_journal_json(copy.text).events), copy.state_hash);
  assert.equal(rt.status().last_backup.hash, copy.state_hash);
  // починили — таймер повторяет, файл догоняет
  handle.fail = null;
  timers.fire_all();
  await settle();
  assert.equal(rt.status().file.phase, 'ready');
  assert.equal(hash_of_events(read_journal_json(handle.content).events), copy.state_hash);
});

test('REQ-097 «Только чтение» и режимы: выбор файла и запись в просмотре отказывают; автозапись в режимах fresh / found не идёт сама', async () => {
  const page = make_page(clone(G001));
  let ro = null;
  const { rt, handle } = runtime_with_file(page, { read_only: () => ro });
  await rt.init();
  ro = { newer_format: true };
  assert.deepEqual(await rt.file_pick(), { ok: false, reason: 'read_only' });
  assert.equal(writes_of(handle), 0);
  ro = null;
  await rt.file_pick();
  const w = writes_of(handle);
  ro = { newer_format: true };
  assert.deepEqual(await rt.file_write_now(), { ok: false, code: 'read_only' });
  assert.equal(writes_of(handle), w);
  // «found»: сохранённое есть, пока не выбрано — файл не пишется и после выбора файла
  const backing = create_memory_backing();
  const first = create_memory_store({ backing });
  const p1 = make_page(clone(G001));
  const rt1 = create_runtime({ store: first, store_kind: 'memory', lock: create_lock({ locks: null }), channel: null, today: () => p1.today, ports: p1.ports, get_ws: p1.get_ws, set_ws: p1.set_ws });
  await rt1.init();
  await change(p1, rt1, 1);
  const p2 = make_page(clone(G001));
  const h2 = fake_handle();
  const rt2 = create_runtime({
    store: create_memory_store({ backing }), store_kind: 'memory', lock: create_lock({ locks: null }), channel: null, today: () => p2.today, ports: p2.ports,
    get_ws: p2.get_ws, set_ws: p2.set_ws, file: { api: { showSaveFilePicker: async () => h2 }, handle_store: null, timers: fake_timers(), every_events: 1 },
  });
  assert.equal((await rt2.init()).mode, 'found');
  const picked = await rt2.file_pick();
  assert.deepEqual([picked.ok, picked.write.ok, picked.write.code], [true, false, 'not_ready']);
  assert.equal(writes_of(h2), 0, 'пока не выбрано «Продолжить» или «Начать с текущего», файл не трогается');
  const cont = await rt2.continue_saved();
  assert.equal(cont.ok, true);
  await settle();
  assert.ok(writes_of(h2) >= 1, 'после «Продолжить с сохранённого» файл обновлён');
  assert.equal(hash_of_events(read_journal_json(h2.content).events), (await rt2.export_copy()).state_hash);
});

// ── удаление всех данных: ссылка на файл снимается ──────────────────────────────────────────────────────────────────────

/** Страница-заглушка контекста для make_runtime: настоящие IndexedDB-подделка, файл и таймеры. */
function env_with_file(f, handle, timers, extra = {}) {
  return {
    indexedDB: f.factory, IDBKeyRange: f.IDBKeyRange, localStorage: null, sessionStorage: null, caches: null,
    navigator: { storage: { persisted: async () => true, persist: async () => true } },
    file_api: { showSaveFilePicker: async () => handle }, file_timers: timers, file_every_events: 2, file_every_ms: 60000, ...extra,
  };
}
function ctx_for(page) {
  return { new_id: (p) => p + '_0123456789ab', get_ws: page.get_ws, set_ws: page.set_ws, adopt: (ws) => { page.ws = ws; return { ok: true }; }, refresh: page.refresh };
}

test('REQ-098 REQ-097 «Удалить все данные»: запомненная ссылка на файл снята, база runway-handles удалена, автозапись остановлена и в файл больше ничего не пишется; файл у пользователя остаётся', async () => {
  const f = fake_idb({ clone: smart_clone });
  const handle = fake_handle();
  const timers = fake_timers();
  const page = make_page(clone(G001));
  const rt = await make_runtime(ctx_for(page), env_with_file(f, handle, timers));
  await rt.init();
  const picked = await rt.file_pick();
  assert.equal(picked.write.ok, true);
  assert.equal(f.dbs.has(HANDLE_DB_NAME), true, 'ссылка запомнена в отдельной базе');
  await change(page, rt, 1);
  await change(page, rt, 2);
  assert.equal(hash_of_events(read_journal_json(handle.content).events), (await rt.export_copy()).state_hash);
  const content_before = handle.content;
  const w = writes_of(handle);
  await change(page, rt, 3); // ещё одна правка, до порога не дошли: таймер ждёт
  assert.equal(timers.count(), 1);

  const receipt = await rt.erase();
  assert.equal(receipt.erased, true);
  assert.deepEqual(receipt.stores.find((s) => s.name === 'file_target'), { name: 'file_target', cleared: true, removed: 1 });
  assert.equal(receipt.copies_warning, true);
  assert.equal(f.dbs.has(HANDLE_DB_NAME), false, 'база ссылок снята');
  assert.equal(f.dbs.has(DB_NAME), false, 'и база журнала');
  assert.equal(timers.count(), 0, 'таймер остановлен');
  assert.equal(rt.status().file.phase, 'off');
  assert.equal(rt.status().mode, 'erased');
  assert.deepEqual(await rt.file_pick(), { ok: false, reason: 'erased' });
  assert.deepEqual(await rt.file_write_now(), { ok: false, code: 'erased' });
  await change(page, rt, 4);
  timers.fire_all();
  await settle();
  assert.equal(writes_of(handle), w, 'после удаления в файл ничего не пишется');
  assert.equal(handle.content, content_before, 'файл-копия остался у пользователя, как был');
  // «после перезагрузки» ссылки нет
  const rt2 = await make_runtime(ctx_for(make_page(clone(G001))), env_with_file(f, handle, fake_timers()));
  const s2 = await rt2.init();
  assert.deepEqual([s2.file.phase, s2.file.name], ['none', '']);
});

test('REQ-097 ссылка запоминается между сеансами и возвращает запись: новая среда над той же IndexedDB вспоминает файл; без выбора файла в браузере база ссылок не открывается', async () => {
  const f = fake_idb({ clone: smart_clone });
  const handle = fake_handle();
  const page = make_page(clone(G001));
  const rt = await make_runtime(ctx_for(page), env_with_file(f, handle, fake_timers()));
  await rt.init();
  await rt.file_pick();
  await change(page, rt, 1);
  const rt2 = await make_runtime(ctx_for(make_page(clone(G001))), env_with_file(f, handle, fake_timers()));
  const s2 = await rt2.init();
  assert.equal(s2.mode, 'found');
  assert.deepEqual([s2.file.phase, s2.file.name, s2.file.remembered], ['ready', handle.name, true]);
  // браузер без выбора файла (Firefox, Safari, iOS)
  const g = fake_idb({ clone: smart_clone });
  const rt3 = await make_runtime(ctx_for(make_page(clone(G001))), env_with_file(g, handle, fake_timers(), { file_api: null }));
  const s3 = await rt3.init();
  assert.deepEqual([s3.file.supported, s3.file.phase], [false, 'unsupported']);
  assert.equal(g.dbs.has(HANDLE_DB_NAME), false, 'база ссылок не создана');
  assert.deepEqual(await rt3.file_pick(), { ok: false, reason: 'unsupported' });
});

// ── экран «Данные»: кнопка «Выбрать файл-копию», состояния, баннер, фокус ────────────────────────────────────────────────────

function view_ctx(page, o = {}) {
  const notices = [];
  const view = {
    notices, refreshes: 0,
    ctx: {
      tr: (k, p) => t(o.lang ?? 'ru', k, p), lang: () => o.lang ?? 'ru', notify: (m, kind) => notices.push([m, kind]), get_ws: page.get_ws, read_only: () => o.ro ?? null,
      refresh: () => { view.refreshes += 1; },
    },
  };
  return view;
}
const text_of = (node) => node.textContent;

test('REQ-097 экран: в блоке хранения кнопка «Выбрать файл-копию»; в браузере без выбора файла — отключена, причина и ограничение (Safari и iOS не проверялись) названы словами', async () => {
  const page = make_page(clone(G001));
  const { rt } = runtime_with_file(page, { api: null });
  await rt.init();
  const { ctx } = view_ctx(page);
  const sec = render_storage_section(ctx, rt);
  const pick = by_id(sec, 'fp19-pick');
  assert.equal(pick.textContent, 'Выбрать файл-копию');
  assert.equal(pick.attrs.disabled, '');
  assert.equal(pick.attrs['aria-describedby'], 'fp19-note');
  assert.ok(by_id(sec, 'fp19-note').textContent.includes('выбор файла для записи недоступен'));
  assert.ok(text_of(sec).includes('Поведение Safari и iOS не проверялось'));
  assert.ok(text_of(sec).includes('Автозапись в файл-копию'));
  // без портов файла блока нет вовсе (прежний экран)
  const bare = runtime_with_file(make_page(clone(G001)), { no_file: true });
  await bare.rt.init();
  assert.equal(by_id(render_storage_section(ctx, bare.rt), 'fp19-file'), undefined);
  // EN
  const en = view_ctx(page, { lang: 'en' });
  const sec_en = render_storage_section(en.ctx, rt);
  assert.equal(by_id(sec_en, 'fp19-pick').textContent, 'Choose copy file');
  assert.ok(text_of(sec_en).includes('Safari and iOS behaviour was not tested'));
});

test('REQ-097 экран: нажатие «Выбрать файл-копию» выбирает файл и пишет проверенную копию; затем блок показывает файл, последнюю запись и кнопки; «Не использовать файл» снимает ссылку; фокус возвращается после перерисовки', async () => {
  const page = make_page(clone(G001));
  const { rt, handle } = runtime_with_file(page);
  await rt.init();
  const v = view_ctx(page);
  let sec = render_storage_section(v.ctx, rt);
  register_ids(sec);
  const pick = by_id(sec, 'fp19-pick');
  assert.equal(pick.attrs.disabled, undefined);
  assert.equal(by_id(sec, 'fp19-note'), undefined);
  assert.ok(text_of(sec).includes('Файл для автозаписи не выбран'));
  await pick.listeners.click[0]();
  assert.equal(v.notices.length, 1);
  assert.match(v.notices[0][0], /^Файл «runway-journal-2026-10-05\.json» выбран, копия записана и проверена: записей \d+, состояние [0-9a-f]{8}\.$/);
  assert.equal(v.notices[0][1], 'info');
  assert.equal(v.refreshes, 1, 'после ответа браузера страница перерисована общим ctx.refresh');
  assert.equal(hash_of_events(read_journal_json(handle.content).events), hash_of_events(events_of_ws(G001)));
  // перерисовка (как после ctx.refresh): нажатая кнопка заменена новым узлом, фокус был потерян → хранитель возвращает его
  globalThis.__focused = undefined;
  sec = render_storage_section(v.ctx, rt);
  register_ids(sec);
  await new Promise((r) => setImmediate(r));
  assert.equal(globalThis.__focused, 'fp19-pick', 'фокус возвращён на «Выбрать другой файл»');
  assert.equal(by_id(sec, 'fp19-pick').textContent, 'Выбрать другой файл');
  const txt = text_of(sec);
  assert.ok(txt.includes('Автозапись включена: файл «runway-journal-2026-10-05.json».'));
  assert.match(txt, /Последняя запись в файл: 2026-10-05, записей в журнале \d+, состояние [0-9a-f]{8}\./);
  assert.ok(txt.includes('Ссылку на файл не удалось запомнить'), 'в этом тесте хранилища ссылок нет: честно сказано, что после перезагрузки файл выбирать заново');
  for (const id of ['fp19-write', 'fp19-forget']) assert.ok(by_id(sec, id) !== undefined, id);
  assert.equal(by_id(sec, 'fp19-allow'), undefined);
  // «Записать в файл сейчас»
  await by_id(sec, 'fp19-write').listeners.click[0]();
  assert.match(v.notices[1][0], /^Копия записана в файл и проверена: записей \d+, состояние [0-9a-f]{8}\.$/);
  // «Не использовать файл»
  await by_id(sec, 'fp19-forget').listeners.click[0]();
  assert.equal(v.notices[2][0], 'Автозапись остановлена, ссылка на файл снята. Сам файл остался у вас.');
  assert.equal(rt.status().file.phase, 'none');
  assert.ok(text_of(render_storage_section(v.ctx, rt)).includes('Файл для автозаписи не выбран'));
});

test('REQ-097 экран: отмена выбора, режим «только чтение» (кнопка отключена, нажатие называет причину текстом ro.refused, а не кодом) и сбой записи (честное сообщение с причиной)', async () => {
  const page = make_page(clone(G001));
  const v = view_ctx(page);
  // отмена
  const rt_c = runtime_with_file(make_page(clone(G001)), { api: { showSaveFilePicker: async () => { throw named('AbortError'); } } }).rt;
  await rt_c.init();
  await by_id(render_storage_section(v.ctx, rt_c), 'fp19-pick').listeners.click[0]();
  assert.equal(v.notices.at(-1)[0], 'Выбор файла отменён, ничего не изменилось.');
  // только чтение
  let ro = null;
  const r = runtime_with_file(make_page(clone(G001)), { read_only: () => ro });
  await r.rt.init();
  ro = { newer_format: true, format: 'runway-journal/2', known_version: 1, skipped: 1 };
  const vr = view_ctx(page, { ro });
  const sec = render_storage_section(vr.ctx, r.rt);
  const pick = by_id(sec, 'fp19-pick');
  assert.equal(pick.attrs.disabled, '');
  assert.equal(pick.attrs['aria-describedby'], 'fp05-ro-note');
  await pick.listeners.click[0](); // обработчик вызван напрямую: отказ называет причину
  assert.equal(vr.notices.at(-1)[0], t('ru', 'ro.refused'));
  assert.ok(!/read_only|E_/.test(vr.notices.at(-1)[0]), 'не код ошибки');
  assert.equal(writes_of(r.handle), 0);
  // сбой записи при выборе файла
  const bad = runtime_with_file(make_page(clone(G001)), { handle: fake_handle({ fail: 'write' }) });
  await bad.rt.init();
  const vb = view_ctx(page);
  await by_id(render_storage_section(vb.ctx, bad.rt), 'fp19-pick').listeners.click[0]();
  assert.equal(vb.notices.at(-1)[1], 'error');
  assert.match(vb.notices.at(-1)[0], /^Файл «runway-journal-2026-10-05\.json» выбран, но запись не удалась: не хватает места на диске\. Журнал можно скачать вручную\.$/);
  assert.deepEqual([bad.rt.status().file.phase, bad.rt.status().file.last_error], ['failed', 'quota']);
});

test('REQ-097 баннер: запись не удалась — «Скачать журнал» остаётся, рядом «Записать в файл сейчас»; разрешение отозвано — рядом «Разрешить запись» (вопрос браузеру по нажатию); баннера нет, пока всё в порядке', async () => {
  const page = make_page(clone(G001));
  const ok = runtime_with_file(page);
  await ok.rt.init();
  const v = view_ctx(page);
  // память вкладки и «браузер не сообщил» дают общий баннер и без файла; здесь проверяем именно причины автозаписи
  await ok.rt.file_pick();
  assert.equal(ok.rt.status().banner.reasons.some((x) => x.startsWith('file_')), false);
  // сбой
  ok.handle.fail = 'write';
  await ok.rt.file_write_now();
  let banner = render_backup_banner(v.ctx, ok.rt);
  assert.ok(banner !== null);
  assert.ok(text_of(banner).includes('Автозапись в файл-копию не сработала: не хватает места на диске. Остаётся ручная выгрузка.'));
  assert.ok(button(banner, 'Скачать журнал') !== undefined, 'ручная выгрузка остаётся');
  assert.ok(button(banner, 'Записать в файл сейчас') !== undefined);
  assert.equal(button(banner, 'Разрешить запись'), undefined);
  ok.handle.fail = null;
  await button(banner, 'Записать в файл сейчас').listeners.click[0]();
  assert.equal(ok.rt.status().file.phase, 'ready');
  assert.match(v.notices.at(-1)[0], /^Копия записана в файл и проверена/);
  // разрешение отозвано
  ok.handle.perm = 'prompt';
  const w = writes_of(ok.handle);
  await ok.rt.file_write_now();
  assert.equal(ok.rt.status().file.phase, 'permission');
  assert.equal(writes_of(ok.handle), w, 'без разрешения запись не начиналась');
  banner = render_backup_banner(v.ctx, ok.rt);
  assert.ok(text_of(banner).includes('браузер не разрешает запись в выбранный файл'));
  assert.ok(button(banner, 'Скачать журнал') !== undefined);
  assert.equal(button(banner, 'Записать в файл сейчас'), undefined);
  const sec = render_storage_section(v.ctx, ok.rt);
  assert.ok(text_of(sec).includes('браузер ждёт разрешения на запись в файл'));
  await button(banner, 'Разрешить запись').listeners.click[0]();
  assert.deepEqual(ok.handle.log.filter((x) => x === 'request'), ['request'], 'браузер спрошен из обработчика нажатия');
  assert.equal(ok.rt.status().file.phase, 'ready');
  assert.ok(v.notices.some(([m]) => m === 'Разрешение получено, автозапись возобновлена.'));
  // из просмотра баннер скрыт
  assert.equal(render_backup_banner(view_ctx(page, { ro: { newer_format: true } }).ctx, ok.rt), null);
});

test('REQ-098 экран «Удалить все данные»: в квитанции строка «Ссылка на выбранный файл-копию» (очищено, 1), а предупреждение о файлах-копиях остаётся; файл не удаляется', async () => {
  const f = fake_idb({ clone: smart_clone });
  const handle = fake_handle();
  const page = make_page(clone(G001));
  const rt = await make_runtime(ctx_for(page), env_with_file(f, handle, fake_timers()));
  await rt.init();
  await rt.file_pick();
  const content = handle.content;
  const v = view_ctx(page);
  const sec = render_erase_section(v.ctx, rt);
  button(sec, 'Удалить все данные…').listeners.click[0]();
  await button(byid.get('dlg-body'), 'Удалить без возврата').listeners.click[0]();
  await settle();
  const receipt = byid.get('dlg-body');
  assert.equal(byid.get('dlg-title').textContent, 'Квитанция об удалении');
  const row = find(receipt, (n) => n.tagName === 'tr' && n.textContent.startsWith('Ссылка на выбранный файл-копию'))[0];
  assert.ok(row !== undefined, 'строка квитанции: ' + receipt.textContent);
  assert.equal(row.textContent, 'Ссылка на выбранный файл-копиюочищено1');
  assert.ok(receipt.textContent.includes('Файлы-копии, которые вы скачивали, остаются у вас'));
  assert.equal(handle.content, content, 'файл-копия остался нетронутым');
  assert.equal(f.dbs.has(HANDLE_DB_NAME), false);
  // после удаления кнопка выбора файла отключена
  assert.equal(by_id(render_storage_section(v.ctx, rt), 'fp19-pick').attrs.disabled, '');
});

test('REQ-097 состав: кнопка и ключи автозаписи в коде экрана; идентификаторы элементов с приставкой fp19; нет inline-стилей и обработчиков-строк', () => {
  const src = fs.readFileSync(new URL('../demo/data_view.mjs', import.meta.url), 'utf8');
  for (const need of ["'fp19-pick'", "'backupfile.pick'", "'backupfile.limit'", "'ro.refused'", 'create_focus_keeper', 'keeper_of(rt).apply()']) assert.ok(src.includes(need), need);
  assert.ok(!/setAttribute\(\s*['"]style['"]/.test(src));
  assert.ok(!/\bon(click|change)\s*=\s*['"]/.test(src));
  const pack = fs.readFileSync(new URL('../demo/pack_fp05.mjs', import.meta.url), 'utf8');
  assert.ok(pack.includes('create_handle_store') && pack.includes('HANDLE_DB_NAME') && pack.includes("register_i18n('backupfile'"));
});
