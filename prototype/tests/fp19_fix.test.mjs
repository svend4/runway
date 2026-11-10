// fp19_fix.test.mjs — исправления FP-19 по независимой проверке (fp19_adv.test.mjs): REQ-097, REQ-098, REQ-122, TST-38, TST-56.
// Средний дефект: тихая автозапись по таймеру перерисовывала всю страницу (форма теряла ввод, фокус падал на body) — теперь перерисовка только при изменении видимого
// состояния. Низкие: приостановка автозаписи после «Начать с текущего набора»/«Восстановить» (в файле единственная копия прежнего журнала), пометка файла в записи
// о копии (первая запись в новый файл не удалась — после перезагрузки файл не считается актуальным), сверка ссылки с базой ссылок (файл снят/заменён в другой
// вкладке), предел ожидания ответа файла (очередь страницы и замок не зависают), тексты и возврат фокуса. Браузер, сервер и сеть не нужны: подделки файла,
// таймеров и IndexedDB, заглушка DOM. Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/fp19_fix.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// ── заглушка DOM (тот же приём, что в tests/backup_file_boot.test.mjs) ──────────────────────────────────────────────────
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
const { render_storage_section, render_backup_banner, render_continue_card } = await import('../demo/data_view.mjs');
const { create_memory_store, create_memory_backing, create_lock } = await import('../demo/store.mjs');
const { create_handle_store, FILE_TARGET_KEY } = await import('../demo/store_idb.mjs');
const { hash_of_events, events_of_ws, export_journal_copy, inspect_import } = await import('../demo/data_actions.mjs');
const { write_copy, verify_by_hash, FILE_CODES } = await import('../demo/backup_file.mjs');
const { rights_report } = await import('../demo/rights.mjs');
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
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const AT = '2026-10-05T08:00:00Z';
const utf8 = (s) => new TextEncoder().encode(s).length;
const find = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const button = (root, text) => find(root, (n) => n.tagName === 'button' && n.textContent === text)[0];
const by_id = (root, id) => find(root, (n) => n.attrs.id === id)[0];
const register_ids = (root) => root.walk((n) => { if (n.attrs.id !== undefined) byid.set(n.attrs.id, n); });
const smart_clone = (x) => (x === undefined ? undefined : x?.value?.handle?.kind === 'file' ? x : JSON.parse(JSON.stringify(x)));

// ── подделки ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Подделка FileSystemFileHandle: запись подменяет содержимое при close(); `gate` — createWritable не отвечает; `fail` — create | write; isSameEntry сравнивает `entry`. */
function fake_handle(o = {}) {
  const h = {
    kind: 'file', name: o.name ?? 'copy.json', entry: o.entry ?? o.name ?? 'copy.json', content: o.content ?? '', perm: o.perm ?? 'granted', fail: o.fail ?? null, gate: null,
    creates: 0, aborts: 0, requests: 0,
    async queryPermission() { return h.perm; },
    async requestPermission() { h.requests += 1; h.perm = 'granted'; return h.perm; },
    async isSameEntry(other) { return other?.entry === h.entry; },
    async getFile() { const text = h.content; return { size: utf8(text), text: async () => text }; },
    async createWritable() {
      h.creates += 1;
      if (h.fail === 'create') throw named('NotAllowedError');
      if (h.gate !== null) await h.gate;
      let buf = '';
      return {
        async write(x) { if (h.fail === 'write') throw named('QuotaExceededError'); buf += x; },
        async close() { h.content = buf; },
        async abort() { h.aborts += 1; },
      };
    },
  };
  return h;
}

function fake_timers() {
  let next = 1;
  const live = new Map();
  return {
    set: (fn, ms) => { const id = next++; live.set(id, { fn, ms }); return id; }, clear: (id) => { live.delete(id); },
    count: () => live.size, delays: () => [...live.values()].map((x) => x.ms), fire_all() { const l = [...live.values()]; live.clear(); for (const x of l) x.fn(); },
  };
}

function make_page(ws0, tag = 'p') {
  let n = 0;
  const page = {
    ws: ws0, today: '2026-10-05', renders: 0,
    get_ws: () => page.ws,
    set_ws: (ws) => { page.ws = ws; return { ok: true }; },
    refresh: () => { page.renders += 1; },
    ports: { next_id: () => tag + '~' + (++n), recorded_at: () => AT },
  };
  return page;
}

const edit = (ws, i, tag = 'x') => {
  const r = apply_edit(ws, { type: 'add_fact', fact: { event_id: 'u_' + tag + i, account_id: 'acc_main', date: '2026-10-03', amount_minor: -(100 + i), currency: 'EUR', tag } }, { new_id: (p) => p + '_' + tag + i });
  assert.ok(r.ok, JSON.stringify(r.error));
  return r.ws;
};
async function change(page, rt, i, tag = 'x') {
  page.ws = edit(page.ws, i, tag);
  await rt.on_change({ reason: 'add_fact', ws: page.ws });
  await settle();
}

/** Среда выполнения хранения с автозаписью; общие `backing` и `idb` поднимают «вторую вкладку» или «перезагрузку» над теми же данными. */
function make_rt(page, o = {}) {
  const handle = o.handle ?? fake_handle();
  const timers = o.timers ?? fake_timers();
  const backing = o.backing ?? create_memory_backing();
  const idb = o.idb ?? fake_idb({ clone: smart_clone });
  const rt = create_runtime({
    store: create_memory_store({ backing }), store_kind: 'memory', lock: create_lock({ locks: null }), channel: o.channel ?? null,
    storage_manager: { persisted: async () => true }, installed: () => true, today: () => page.today, ports: page.ports,
    get_ws: page.get_ws, set_ws: page.set_ws, refresh: page.refresh, read_only: o.read_only,
    file: { api: { showSaveFilePicker: async () => handle }, handle_store: create_handle_store({ indexedDB: idb.factory }), timers, every_events: o.every_events ?? 3, every_ms: 60000, op_ms: o.op_ms },
  });
  return { rt, handle, timers, backing, idb };
}
const file_hash = (h) => hash_of_events(read_journal_json(h.content).events);
const store_hash = async (backing) => hash_of_events((await create_memory_store({ backing }).load()).events);

function view_ctx(page, o = {}) {
  const notices = [];
  const view = {
    notices, refreshes: 0,
    ctx: { tr: (k, p) => t(o.lang ?? 'ru', k, p), lang: () => o.lang ?? 'ru', notify: (m, kind) => notices.push([m, kind]), get_ws: page.get_ws, read_only: () => o.ro ?? null, refresh: () => { view.refreshes += 1; } },
  };
  return view;
}

// ── средний дефект: тихая автозапись не перерисовывает страницу ────────────────────────────────────────────────────────

test('FIX-01 [средний] тихая автозапись (по числу правок и по таймеру) не перерисовывает страницу, пока видимое состояние то же; сбой и починка перерисовывают; нажатие пользователя — тоже', async () => {
  const page = make_page(clone(G001));
  const { rt, handle, timers, backing } = make_rt(page, { every_events: 3 });
  await rt.init();
  await rt.file_pick();
  await rt.flush();
  await settle();
  // по числу правок: три правки дают три перерисовки от самих правок; запись в файл на 3-й правке — тихая
  const c0 = handle.creates;
  const r0 = page.renders;
  for (let i = 1; i <= 3; i++) await change(page, rt, i);
  assert.equal(handle.creates, c0 + 1, 'на 3-й правке файл обновлён');
  assert.equal(page.renders, r0 + 3, 'перерисовки только от самих правок: запись в файл их не добавила');
  // по таймеру: никаких нажатий пользователя, страница не перерисовывается (форма не теряет ввод, фокус остаётся)
  await change(page, rt, 4);
  const r1 = page.renders;
  assert.equal(timers.count(), 1, 'таймер ждёт');
  timers.fire_all();
  await settle();
  await rt.flush();
  assert.equal(rt.status().file.pending, 0, 'тихая запись состоялась');
  assert.equal(file_hash(handle), await store_hash(backing), 'файл равен журналу');
  assert.equal(page.renders, r1, 'тихая запись по таймеру не перерисовала страницу');
  // сбой: видимое состояние изменилось (появляется баннер) — перерисовка нужна, и она одна
  handle.fail = 'write';
  await change(page, rt, 5);
  const r2 = page.renders;
  timers.fire_all();
  await settle();
  await rt.flush();
  assert.deepEqual([rt.status().file.phase, rt.status().file.last_error], ['failed', 'quota']);
  assert.equal(page.renders, r2 + 1, 'сбой виден на экране: одна перерисовка');
  timers.fire_all(); // тот же сбой с тем же кодом: на экране ничего не изменилось
  await settle();
  await rt.flush();
  assert.equal(page.renders, r2 + 1, 'повтор того же сбоя страницу не перерисовывает');
  // починка по таймеру: баннер исчезает — перерисовка
  handle.fail = null;
  timers.fire_all();
  await settle();
  await rt.flush();
  assert.equal(rt.status().file.phase, 'ready');
  assert.equal(page.renders, r2 + 2, 'баннер снят: одна перерисовка');
  // действие пользователя («Записать в файл сейчас») перерисовывает, как прежде
  const r3 = page.renders;
  assert.equal((await rt.file_write_now()).ok, true);
  assert.ok(page.renders > r3, 'нажатие пользователя перерисовывает страницу');
});

// ── низкий: предел ожидания ответа файла ────────────────────────────────────────────────────────────────────────────

/** Файл, который не отвечает на одной операции (`stage`: get | create | write | close | readback); `late()` — запоздалый ответ createWritable. */
function hang_handle(stage) {
  const h = {
    kind: 'file', name: 'hang.json', content: 'прежнее', aborts: 0, gets: 0, late: null,
    queryPermission: async () => 'granted',
    getFile() {
      h.gets += 1;
      if ((stage === 'get' && h.gets === 1) || (stage === 'readback' && h.gets === 2)) return new Promise(() => {});
      const text = h.content;
      return Promise.resolve({ size: utf8(text), text: async () => text });
    },
    createWritable() {
      if (stage === 'create') return new Promise((resolve) => { h.late = () => resolve(writable()); });
      return Promise.resolve(writable());
    },
  };
  function writable() {
    let buf = '';
    return {
      write(x) { if (stage === 'write') return new Promise(() => {}); buf += x; return Promise.resolve(); },
      close() { if (stage === 'close') return new Promise(() => {}); h.content = buf; return Promise.resolve(); },
      abort() { h.aborts += 1; return Promise.resolve(); },
    };
  }
  return h;
}
const COPY = export_journal_copy(events_of_ws(G001));

test('FIX-02 [низкий] write_copy с пределом ожидания: файл не отвечает на любой операции (чтение, создание, запись, закрытие, чтение обратно) — по истечении код aborted; писатель прерывается; лишних таймеров нет', async () => {
  for (const stage of ['get', 'create', 'write', 'close', 'readback']) {
    const h = hang_handle(stage);
    const timers = fake_timers();
    const p = write_copy(h, COPY.text, { verify: verify_by_hash(COPY.state_hash), timers, op_ms: 1000 });
    await settle();
    assert.deepEqual(timers.delays(), [1000], stage + ': ожидание ответа ограничено');
    timers.fire_all();
    const r = await p;
    assert.deepEqual([r.ok, r.code], [false, 'aborted'], stage);
    assert.equal(timers.count(), 0, stage + ': таймеров не осталось');
    if (stage === 'write' || stage === 'close') assert.equal(h.aborts, 1, stage + ': зависший писатель прерван');
    if (stage === 'readback') assert.equal(h.content, COPY.text, 'запись состоялась, проверить нечем: содержимое файла — новая копия');
    else assert.equal(h.content, 'прежнее', stage + ': прежнее содержимое цело');
    if (stage === 'create') { assert.equal(h.aborts, 0); h.late(); await settle(); assert.equal(h.aborts, 1, 'запоздало открытый писатель закрывается, файл не остаётся занятым'); }
  }
  // быстрые операции: таймеры заводятся и снимаются, итог прежний
  const ok = fake_handle({ content: 'прежнее' });
  const timers = fake_timers();
  const r = await write_copy(ok, COPY.text, { verify: verify_by_hash(COPY.state_hash), timers, op_ms: 1000 });
  assert.equal(r.ok, true);
  assert.equal(timers.count(), 0);
  assert.equal(ok.content, COPY.text);
});

test('FIX-03 [низкий] зависший файл в среде выполнения: запись прерывается по пределу (код aborted), очередь страницы и замок освобождаются, правка доходит до хранилища; баннер и повтор по таймеру', async () => {
  const page = make_page(clone(G001));
  const h = fake_handle();
  const { rt, timers, backing } = make_rt(page, { handle: h, every_events: 1000, op_ms: 5000 });
  await rt.init();
  await rt.file_pick();
  await change(page, rt, 1);
  const in_store = async () => (await create_memory_store({ backing }).load()).events.length;
  const before = await in_store();
  h.gate = new Promise(() => {});
  const w = rt.file_write_now();
  await settle();
  page.ws = edit(page.ws, 2);
  const e = rt.on_change({ reason: 'add_fact', ws: page.ws });
  await settle();
  assert.equal(await in_store(), before, 'пока файл молчит, правка ждёт в очереди — но не дольше предела');
  assert.ok(timers.delays().includes(5000), 'предел ожидания заведён портом таймеров');
  timers.fire_all();
  const r = await w;
  assert.deepEqual([r.ok, r.code], [false, 'aborted']);
  await e;
  await rt.flush();
  assert.ok((await in_store()) > before, 'после предела правка пользователя записана в хранилище');
  const f = rt.status().file;
  assert.deepEqual([f.phase, f.last_error], ['failed', 'aborted']);
  assert.ok(rt.status().banner.reasons.includes('file_failed'), 'ручная выгрузка и баннер остаются');
  // файл ожил: повтор по таймеру
  h.gate = null;
  timers.fire_all();
  await settle();
  await rt.flush();
  assert.equal(rt.status().file.phase, 'ready');
  assert.equal(file_hash(h), await store_hash(backing));
});

// ── низкий: приостановка автозаписи после замены журнала ─────────────────────────────────────────────────────────────────

/** Страница A с выбранным файлом и шестью правками, затем «новая страница» B над теми же данными (режим found). */
async function two_pages(o = {}) {
  const backing = create_memory_backing();
  const idb = fake_idb({ clone: smart_clone });
  const file = fake_handle({ name: 'copy.json' });
  const page1 = make_page(clone(G001), 'p');
  const a = make_rt(page1, { backing, idb, handle: file, every_events: 2 });
  await a.rt.init();
  await a.rt.file_pick();
  for (let i = 1; i <= 6; i++) await change(page1, a.rt, i);
  const old_text = file.content;
  assert.equal(file_hash(file), await store_hash(backing));
  const page2 = make_page(clone(G001), 'q');
  const b = make_rt(page2, { backing, idb, handle: file, every_events: 2, channel: o.channel });
  assert.equal((await b.rt.init()).mode, 'found');
  return { backing, idb, file, page1, a, page2, b, old_text };
}

test('FIX-04 [низкий] «Начать с текущего набора» при выбранном файле: автозапись приостанавливается и не заменяет копию прежнего журнала; «Записать в файл сейчас» заменяет и снимает приостановку', async () => {
  const { backing, file, page2, b, old_text } = await two_pages();
  assert.equal((await b.rt.replace_saved()).ok, true);
  assert.equal(b.rt.status().file.held, true);
  for (let i = 1; i <= 5; i++) await change(page2, b.rt, 100 + i, 'n');
  b.timers.fire_all();
  await settle();
  await b.rt.flush();
  assert.equal(file.content, old_text, 'прежняя копия в файле цела: автозапись не пишет');
  assert.equal(b.rt.status().file.phase, 'ready');
  assert.equal(await b.rt.file_permission().then((r) => r.write?.code), 'held', 'разрешение само приостановку не снимает');
  const w = await b.rt.file_write_now();
  assert.equal(w.ok, true);
  assert.equal(b.rt.status().file.held, false);
  assert.equal(file_hash(file), await store_hash(backing), 'файл заменён текущим журналом по явному решению');
  const c = file.creates;
  await change(page2, b.rt, 200, 'n');
  await change(page2, b.rt, 201, 'n');
  assert.equal(file.creates, c + 1, 'автозапись снова идёт');
});

test('FIX-05 [низкий] приостановка переживает перезагрузку (пометка при ссылке на файл), «Восстановить» тоже приостанавливает, выбор другого файла и «Не использовать файл» её снимают', async () => {
  const { backing, idb, file, page2, b, old_text } = await two_pages();
  await b.rt.replace_saved();
  // перезагрузка: хранилище пусто (режим fresh), ссылка на файл и пометка вспомнены
  const page3 = make_page(clone(G001), 'z');
  const c = make_rt(page3, { backing, idb, handle: file, every_events: 2 });
  const s = await c.rt.init();
  assert.deepEqual([s.mode, s.file.phase, s.file.held], ['fresh', 'ready', true]);
  await change(page3, c.rt, 300, 'r');
  await change(page3, c.rt, 301, 'r');
  c.timers.fire_all();
  await settle();
  assert.equal(file.content, old_text, 'после перезагрузки файл по-прежнему не заменяется молча');
  // выбор другого файла снимает приостановку (в новом файле прежнего журнала нет)
  const other = fake_handle({ name: 'other.json' });
  const d = make_rt(make_page(clone(G001), 'y'), { backing, idb, handle: other, every_events: 2 });
  await d.rt.init();
  const picked = await d.rt.file_pick();
  assert.equal(picked.ok, true);
  assert.equal(d.rt.status().file.held, false);
  const rec = await create_handle_store({ indexedDB: idb.factory }).get(FILE_TARGET_KEY);
  assert.deepEqual([rec.v, rec.held, rec.handle === other], [1, false, true]);
  await d.rt.file_forget();

  // «Восстановить»: журнал заменяется, файл-копия прежнего журнала не затирается молча
  const backing2 = create_memory_backing();
  const f2 = fake_handle({ name: 'r.json' });
  const page4 = make_page(clone(G001), 'w');
  const e = make_rt(page4, { backing: backing2, handle: f2, every_events: 2 });
  await e.rt.init();
  await e.rt.file_pick();
  for (let i = 1; i <= 4; i++) await change(page4, e.rt, i, 'w');
  const before = f2.content;
  const other_ws = edit(clone(G001), 77, 'other');
  const parsed = inspect_import(export_journal_copy(events_of_ws(other_ws)).text);
  assert.equal(parsed.ok, true);
  assert.equal((await e.rt.restore(parsed)).ok, true);
  assert.equal(e.rt.status().file.held, true);
  for (let i = 1; i <= 3; i++) await change(page4, e.rt, 400 + i, 'w');
  e.timers.fire_all();
  await settle();
  assert.equal(f2.content, before, 'после восстановления файл не заменяется сам');
  assert.equal((await e.rt.file_write_now()).ok, true);
  assert.equal(file_hash(f2), await store_hash(backing2));
});

test('FIX-06 [низкий] окна подтверждения «Начать с текущего набора» и «Восстановить» называют выбранный файл-копию; без файла предупреждения нет', async () => {
  const { page2, b } = await two_pages();
  const v = view_ctx(page2);
  const card = render_continue_card(v.ctx, b.rt);
  button(card, 'Начать с текущего набора').listeners.click[0]();
  const dlg = byid.get('dlg-body').textContent;
  assert.ok(dlg.includes('Выбран файл-копия «copy.json»: в нём лежит копия прежнего журнала.'), dlg);
  assert.ok(dlg.includes('Автозапись в него приостановится'));
  const en = view_ctx(page2, { lang: 'en' });
  button(render_continue_card(en.ctx, b.rt), 'Start from the current data set').listeners.click[0]();
  assert.ok(byid.get('dlg-body').textContent.includes('The copy file “copy.json” is chosen'));
  // без файла в окне только прежний текст
  const bare = create_runtime({
    store: create_memory_store({ backing: b.backing }), store_kind: 'memory', lock: create_lock({ locks: null }), channel: null, today: () => page2.today, ports: page2.ports,
    get_ws: page2.get_ws, set_ws: page2.set_ws,
  });
  assert.equal((await bare.init()).mode, 'found');
  button(render_continue_card(v.ctx, bare), 'Начать с текущего набора').listeners.click[0]();
  assert.ok(!byid.get('dlg-body').textContent.includes('Выбран файл-копия'));
  // «Восстановить из файла» при выбранном файле: предупреждение в диалоге
  await b.rt.continue_saved();
  const sec = render_storage_section(v.ctx, b.rt);
  const input = by_id(sec, 'fp05-file');
  const text = export_journal_copy(events_of_ws(edit(clone(G001), 55, 'z'))).text;
  input.files = [{ size: utf8(text), text: async () => text }];
  await input.listeners.change[0]();
  const rest = byid.get('dlg-body').textContent;
  assert.ok(rest.includes('Выбран файл-копия «copy.json»: в нём может лежать копия журнала, который сейчас заменяется.'), rest);
});

// ── низкий: пометка файла в записи о последней копии ────────────────────────────────────────────────────────────────────

test('FIX-07 [низкий] первая запись в НОВЫЙ файл не удалась, страница перезагружена: пометка via = file с записи о копии снята при выборе файла, новый файл не считается актуальным и дописывается', async () => {
  const backing = create_memory_backing();
  const idb = fake_idb({ clone: smart_clone });
  const first = fake_handle({ name: 'a.json' });
  const page1 = make_page(clone(G001), 'p');
  const a = make_rt(page1, { backing, idb, handle: first, every_events: 2 });
  await a.rt.init();
  await a.rt.file_pick();
  await change(page1, a.rt, 1);
  await change(page1, a.rt, 2);
  const lb = a.rt.status().last_backup;
  assert.equal(lb.via, 'file');
  // выбран другой файл, первая запись в него не удалась (диск полон)
  const second = fake_handle({ name: 'b.json', fail: 'write' });
  const page2 = make_page(clone(G001), 'q');
  const b = make_rt(page2, { backing, idb, handle: second, every_events: 2 });
  await b.rt.init();
  await b.rt.continue_saved();
  const r = await b.rt.file_pick();
  assert.equal(r.write.ok, false);
  const lb2 = b.rt.status().last_backup;
  assert.deepEqual([lb2.day, lb2.count, lb2.hash, lb2.via], [lb.day, lb.count, lb.hash, undefined], 'день, число записей и хэш остались, пометка снята: напоминание считает по-прежнему');
  // перезагрузка: диск освободился
  second.fail = null;
  const page3 = make_page(clone(G001), 'z');
  const c = make_rt(page3, { backing, idb, handle: second, every_events: 2 });
  const s = await c.rt.init();
  assert.equal(s.file.phase, 'ready');
  assert.notEqual(s.file.pending, 0, 'в новый файл ещё ничего не записано, а счётчик не говорит «записано всё»');
  await c.rt.continue_saved();
  await settle();
  c.timers.fire_all();
  await settle();
  await c.rt.flush();
  assert.equal(file_hash(second), await store_hash(backing), 'новый файл догнал журнал');
  assert.equal(c.rt.status().last_backup.via, 'file', 'после удачной записи копия отмечена заново');
});

// ── низкий: ссылку сняли или заменили в другой вкладке ────────────────────────────────────────────────────────────────────

test('FIX-08 [низкий] «Не использовать файл» или выбор другого файла в одной вкладке: вторая вкладка перед записью сверяет ссылку с базой ссылок и не пишет в снятый файл', async () => {
  // снятие
  {
    const backing = create_memory_backing();
    const idb = fake_idb({ clone: smart_clone });
    const h = fake_handle();
    const p1 = make_page(clone(G001), 'p');
    const a = make_rt(p1, { backing, idb, handle: h, every_events: 1 });
    await a.rt.init();
    await a.rt.file_pick();
    await change(p1, a.rt, 1);
    const p2 = make_page(clone(G001), 'q');
    const b = make_rt(p2, { backing, idb, handle: h, every_events: 1 });
    assert.equal((await b.rt.init()).file.phase, 'ready');
    await b.rt.continue_saved();
    await a.rt.file_forget();
    const creates = h.creates;
    await change(p2, b.rt, 50, 'b');
    await b.rt.flush();
    assert.equal(h.creates, creates, 'в снятый файл вторая вкладка не пишет');
    assert.equal(b.rt.status().file.phase, 'none', 'ссылка снята и здесь');
    assert.deepEqual(await b.rt.file_write_now(), { ok: false, code: 'no_target' });
  }
  // замена другим файлом: вкладка переходит на новый файл
  {
    const backing = create_memory_backing();
    const idb = fake_idb({ clone: smart_clone });
    const old = fake_handle({ name: 'old.json' });
    const fresh = fake_handle({ name: 'new.json' });
    const p1 = make_page(clone(G001), 'p');
    const a = make_rt(p1, { backing, idb, handle: old, every_events: 1 });
    await a.rt.init();
    await a.rt.file_pick();
    await change(p1, a.rt, 1);
    const p2 = make_page(clone(G001), 'q');
    const b = make_rt(p2, { backing, idb, handle: old, every_events: 1 });
    await b.rt.init();
    await b.rt.continue_saved();
    // в первой вкладке выбран новый файл
    const a2 = make_rt(p1, { backing, idb, handle: fresh, every_events: 1 });
    await a2.rt.init();
    assert.equal((await a2.rt.file_pick()).ok, true);
    const c_old = old.creates;
    await change(p2, b.rt, 60, 'b');
    await settle();
    assert.equal(old.creates, c_old, 'прежний файл больше не пишется');
    assert.equal(b.rt.status().file.name, 'new.json', 'вкладка перешла на выбранный файл');
    await b.rt.flush();
    b.timers.fire_all();
    await settle();
    assert.equal(file_hash(fresh), await store_hash(backing), 'новый файл получил журнал');
  }
  // та же запись другим объектом (структурное клонирование): isSameEntry — не смена файла
  {
    const backing = create_memory_backing();
    const idb = fake_idb({ clone: smart_clone });
    const h = fake_handle();
    const p1 = make_page(clone(G001), 'p');
    const a = make_rt(p1, { backing, idb, handle: h, every_events: 1 });
    await a.rt.init();
    await a.rt.file_pick();
    await change(p1, a.rt, 1);
    const twin = Object.create(h);
    await create_handle_store({ indexedDB: idb.factory }).put(FILE_TARGET_KEY, { v: 1, handle: twin, held: false });
    const creates = h.creates;
    await change(p1, a.rt, 2);
    assert.equal(h.creates, creates + 1, 'тот же файл: запись идёт');
    assert.equal(a.rt.status().file.phase, 'ready');
  }
});

// ── низкий: тексты, разрешение, фокус ────────────────────────────────────────────────────────────────────────────────

test('FIX-09 [низкий] отказ браузера без сведений о разрешении — «ждёт разрешения» (prompt), а не «отозвано»; отозванное разрешение (denied) — «отозвано»', async () => {
  const page = make_page(clone(G001));
  const h = fake_handle();
  const { rt } = make_rt(page, { handle: h, every_events: 1 });
  await rt.init();
  await rt.file_pick();
  h.fail = 'create'; // NotAllowedError при открытии записи, хотя queryPermission отвечает granted
  await rt.file_write_now();
  const f = rt.status().file;
  assert.deepEqual([f.phase, f.permission, f.last_error], ['permission', 'prompt', 'permission']);
  const v = view_ctx(page);
  const txt = render_storage_section(v.ctx, rt).textContent;
  assert.ok(txt.includes('браузер ждёт разрешения на запись в файл'), txt);
  assert.ok(!txt.includes('разрешение отозвано'));
  h.fail = null;
  h.perm = 'denied';
  await rt.file_write_now();
  assert.equal(rt.status().file.permission, 'denied');
  assert.ok(render_storage_section(v.ctx, rt).textContent.includes('разрешение отозвано'));
});

test('FIX-10 [низкий] сообщения не обещают лишнего: режим found — «после Продолжить…», прочие режимы — «запись журнала не ведётся»; «автозапись возобновлена» только после состоявшейся записи', async () => {
  // found: выбор файла, запись не начата
  const { page2, b, file } = await two_pages();
  const v = view_ctx(page2);
  let sec = render_storage_section(v.ctx, b.rt);
  register_ids(sec);
  await by_id(sec, 'fp19-pick').listeners.click[0]();
  assert.match(v.notices.at(-1)[0], /^Файл «copy\.json» выбран\. Запись начнётся после выбора «Продолжить с сохранённого»/);
  // разрешение в режиме found: запись ещё не идёт
  file.perm = 'prompt';
  await b.rt.init();
  sec = render_storage_section(v.ctx, b.rt);
  register_ids(sec);
  assert.ok(by_id(sec, 'fp19-allow') !== undefined);
  await by_id(sec, 'fp19-allow').listeners.click[0]();
  assert.match(v.notices.at(-1)[0], /^Разрешение получено\. Запись в файл начнётся после выбора «Продолжить с сохранённого»/);
  assert.ok(!v.notices.some(([m]) => m.includes('автозапись возобновлена')));
  // отчёт «где что лежит»: файл выбран, но не записан — «ещё не выполнялась»
  const row = (rep) => rep.rows.find((r) => r.id === 'file').key;
  assert.equal(row(b.rt.status().rights), 'backupfile.rights_chosen');

  // paused (другая вкладка очистила хранилище): кнопок «Продолжить…» нет — текст про них не обещает
  let deliver = null;
  const channel = { subscribe: (fn) => { deliver = fn; return () => {}; }, post() {}, close() {} };
  const page = make_page(clone(G001), 'c');
  const h = fake_handle({ name: 'paused.json' });
  const c = make_rt(page, { channel, handle: h, every_events: 1 });
  await c.rt.init();
  await c.rt.file_pick();
  await change(page, c.rt, 1);
  assert.equal(row(c.rt.status().rights), 'backupfile.rights_ready', 'запись состоялась: «копия обновляется»');
  deliver({ v: 1, type: 'erased', from: 'other', last_seq: 0, count: 0 });
  assert.equal(c.rt.status().mode, 'paused');
  const vc = view_ctx(page);
  sec = render_storage_section(vc.ctx, c.rt);
  register_ids(sec);
  await by_id(sec, 'fp19-pick').listeners.click[0]();
  assert.match(vc.notices.at(-1)[0], /запись журнала на странице сейчас не ведётся/);
  assert.ok(!vc.notices.at(-1)[0].includes('Продолжить'));
  sec = render_storage_section(vc.ctx, c.rt);
  register_ids(sec);
  await by_id(sec, 'fp19-write').listeners.click[0]();
  assert.match(vc.notices.at(-1)[0], /^Запись в файл сейчас недоступна: запись журнала на странице не ведётся/);
});

test('FIX-11 [низкий] фокус после «Записать в файл сейчас», «Разрешить запись» и «Не использовать файл» возвращается на нажатую кнопку (или на соседнюю, если нажатая исчезла); баннер имеет свои идентификаторы', async () => {
  const page = make_page(clone(G001));
  const h = fake_handle();
  const { rt } = make_rt(page, { handle: h, every_events: 1000 });
  await rt.init();
  await rt.file_pick();
  const v = view_ctx(page);
  const rerender = async () => { globalThis.__focused = undefined; const s = render_storage_section(v.ctx, rt); register_ids(s); await settle(); return s; };
  let sec = await rerender();
  // «Записать в файл сейчас» в блоке: кнопка остаётся — фокус на ней
  await by_id(sec, 'fp19-write').listeners.click[0]();
  sec = await rerender();
  assert.equal(globalThis.__focused, 'fp19-write');
  // сбой записи: баннер с «Записать в файл сейчас» (свой id), повторное нажатие при том же сбое возвращает фокус на кнопку баннера
  h.fail = 'write';
  await rt.file_write_now();
  let banner = render_backup_banner(v.ctx, rt);
  register_ids(banner);
  assert.ok(by_id(banner, 'fp19-banner-write') !== undefined);
  assert.equal(by_id(banner, 'fp19-write'), undefined);
  await by_id(banner, 'fp19-banner-write').listeners.click[0]();
  globalThis.__focused = undefined;
  banner = render_backup_banner(v.ctx, rt);
  register_ids(banner);
  await settle();
  assert.equal(globalThis.__focused, 'fp19-banner-write', 'запись снова не удалась: баннер на месте, фокус на его кнопке');
  // починили: баннер исчезает — фокус на соседней кнопке блока
  h.fail = null;
  await by_id(banner, 'fp19-banner-write').listeners.click[0]();
  globalThis.__focused = undefined;
  assert.equal(render_backup_banner(v.ctx, rt)?.textContent.includes('Автозапись в файл-копию не сработала') ?? false, false);
  sec = await rerender();
  assert.equal(globalThis.__focused, 'fp19-write');
  // «Разрешить запись» в блоке: при успехе кнопка исчезает — фокус на «Записать в файл сейчас»
  h.perm = 'prompt';
  await rt.file_write_now();
  sec = await rerender();
  assert.ok(by_id(sec, 'fp19-allow') !== undefined);
  await by_id(sec, 'fp19-allow').listeners.click[0]();
  sec = await rerender();
  assert.equal(by_id(sec, 'fp19-allow'), undefined);
  assert.equal(globalThis.__focused, 'fp19-write');
  // «Не использовать файл»: кнопка исчезает — фокус на «Выбрать файл-копию»
  await by_id(sec, 'fp19-forget').listeners.click[0]();
  sec = await rerender();
  assert.equal(by_id(sec, 'fp19-forget'), undefined);
  assert.equal(globalThis.__focused, 'fp19-pick');
});

test('FIX-12 состав: код пакета без разметки из строк и без внешних адресов; ключи новых строк используются литералами; новый код причины target_changed есть в каталоге обоих языков; rights различает «выбран», «обновляется», «приостановлена»', () => {
  for (const f of ['backup_file.mjs', 'data_view.mjs', 'data_runtime.mjs', 'rights.mjs', 'pack_fp05.mjs', 'i18n/backupfile.mjs']) {
    const src = fs.readFileSync(fileURLToPath(new URL('../demo/' + f, import.meta.url)), 'utf8');
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'eval(', 'new Function', 'fetch(', 'XMLHttpRequest', 'document.write', 'https://', 'http://']) assert.ok(!src.includes(bad), f + ': ' + bad);
  }
  const view = fs.readFileSync(fileURLToPath(new URL('../demo/data_view.mjs', import.meta.url)), 'utf8');
  const rights = fs.readFileSync(fileURLToPath(new URL('../demo/rights.mjs', import.meta.url)), 'utf8');
  for (const k of ['backupfile.picked_idle', 'backupfile.write_idle', 'backupfile.allowed_wait', 'backupfile.allowed_idle', 'backupfile.held', 'backupfile.written_before', 'backupfile.replace_file_warn', 'backupfile.restore_file_warn']) {
    assert.ok(view.includes("'" + k + "'"), k);
    assert.ok(Object.hasOwn(file_catalog.ru, k) && Object.hasOwn(file_catalog.en, k), k);
  }
  for (const k of ['backupfile.rights_chosen', 'backupfile.rights_held']) assert.ok(rights.includes("'" + k + "'") && Object.hasOwn(file_catalog.ru, k) && Object.hasOwn(file_catalog.en, k), k);
  assert.ok(FILE_CODES.includes('target_changed'));
  assert.ok(Object.hasOwn(file_catalog.ru, 'backupfile.reason_target_changed') && Object.hasOwn(file_catalog.en, 'backupfile.reason_target_changed'));
  const key = (file) => rights_report({ store_kind: 'idb', persisted: true, count: 5, file }).rows.find((r) => r.id === 'file').key;
  assert.equal(key({ phase: 'ready', name: 'a.json' }), 'backupfile.rights_ready', 'поля written нет — строка прежняя');
  assert.equal(key({ phase: 'ready', name: 'a.json', written: true }), 'backupfile.rights_ready');
  assert.equal(key({ phase: 'ready', name: 'a.json', written: false }), 'backupfile.rights_chosen');
  assert.equal(key({ phase: 'ready', name: 'a.json', written: true, held: true }), 'backupfile.rights_held');
  assert.equal(key({ phase: 'failed', name: 'a.json', written: false }), 'backupfile.rights_failed');
});
