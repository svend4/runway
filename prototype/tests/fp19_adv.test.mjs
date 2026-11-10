// fp19_adv.test.mjs — состязательная проверка пакета FP-19 (независимый проверяющий, 2026-10-23). Расчёт по введённым данным и правилам, не консультация.
// Два вида тестов.
//  1) «Страховочные» (зелёные): независимая проверка заявленного другим путём, чем собственные тесты пакета — файл хранит БАЙТЫ (UTF-8), а не строку JS (круг хэша на
//     необычном тексте); записи в файл не пересекаются даже при шквале правок и одновременных нажатиях; удаление посреди записи не оставляет записи после себя;
//     вкладка, у которой другая вкладка стёрла хранилище, не воскрешает данные в файл; сходимость: после всех таймеров файл равен журналу; паритет заполнителей RU/EN и
//     запрещённые формулировки каталога сверены напрямую с vocab.json.
//  2) «Дефектные» (todo — красные, но не ломают прогон): найденные недочёты, см. подписи тестов.
// Браузера, сервера и сети нет; рабочее дерево не меняется. Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/fp19_adv.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { create_runtime } from '../demo/data_runtime.mjs';
import { create_memory_store, create_memory_backing, create_lock } from '../demo/store.mjs';
import { create_handle_store, HANDLE_DB_NAME } from '../demo/store_idb.mjs';
import { hash_of_events, events_of_ws, export_journal_copy } from '../demo/data_actions.mjs';
import { write_copy, verify_by_hash } from '../demo/backup_file.mjs';
import { read_journal_json } from '../engine/io.mjs';
import { apply_edit } from '../demo/ws_edit.mjs';
import catalog from '../demo/i18n/backupfile.mjs';
import { fake_idb } from './fake_idb.mjs';

const G001 = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../data/g001.json', import.meta.url)), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const named = (name) => Object.assign(new Error(name), { name });
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const AT = '2026-10-05T08:00:00Z';
const smart_clone = (x) => (x === undefined ? undefined : x?.value?.handle?.kind === 'file' ? x : JSON.parse(JSON.stringify(x)));

// ── подделки ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Файл хранит БАЙТЫ: запись кодируется в UTF-8, чтение декодирует (строка JS не годится: она скрыла бы потери при кодировании). Считает одновременные записи. */
function byte_handle(o = {}) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const h = {
    kind: 'file', name: o.name ?? 'copy.json', bytes: enc.encode(o.content ?? ''), perm: 'granted', gate: null, creates: 0, inflight: 0, max_inflight: 0,
    text: () => dec.decode(h.bytes),
    async queryPermission() { return h.perm; },
    async requestPermission() { h.perm = 'granted'; return h.perm; },
    async getFile() { const b = h.bytes; return { size: b.length, text: async () => dec.decode(b) }; },
    async createWritable() {
      h.creates += 1;
      h.inflight += 1;
      h.max_inflight = Math.max(h.max_inflight, h.inflight);
      if (h.gate !== null) await h.gate;
      let buf = '';
      return {
        async write(t) { buf += t; },
        async close() { h.bytes = enc.encode(buf); h.inflight -= 1; },
        async abort() { h.inflight -= 1; },
      };
    },
  };
  return h;
}

function fake_timers() {
  let next = 1;
  const live = new Map();
  return { set: (fn, ms) => { const id = next++; live.set(id, { fn, ms }); return id; }, clear: (id) => { live.delete(id); }, count: () => live.size, fire_all() { const l = [...live.values()]; live.clear(); for (const x of l) x.fn(); } };
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

const edit = (ws, i, tag = 'x', id_tag = tag) => {
  const r = apply_edit(ws, { type: 'add_fact', fact: { event_id: 'u_' + id_tag + i, account_id: 'acc_main', date: '2026-10-03', amount_minor: -(100 + i), currency: 'EUR', tag } }, { new_id: (p) => p + '_' + id_tag + i });
  assert.ok(r.ok, JSON.stringify(r.error));
  return r.ws;
};
async function change(page, rt, i, tag) {
  page.ws = edit(page.ws, i, tag);
  await rt.on_change({ reason: 'add_fact', ws: page.ws });
  await settle();
}

/** Среда выполнения хранения с автозаписью. Общие `backing` и `idb` позволяют поднять «вторую вкладку» над теми же данными. */
function make_rt(page, o = {}) {
  const handle = o.handle ?? byte_handle();
  const timers = o.timers ?? fake_timers();
  const backing = o.backing ?? create_memory_backing();
  const idb = o.idb ?? fake_idb({ clone: smart_clone });
  const rt = create_runtime({
    store: create_memory_store({ backing }), store_kind: 'memory', lock: create_lock({ locks: null }), channel: o.channel ?? null,
    storage_manager: { persisted: async () => true }, installed: () => true, today: () => page.today, ports: page.ports,
    get_ws: page.get_ws, set_ws: page.set_ws, refresh: page.refresh, read_only: o.read_only,
    file: { api: { showSaveFilePicker: async () => handle }, handle_store: create_handle_store({ indexedDB: idb.factory }), timers, every_events: o.every_events ?? 3, every_ms: 60000 },
  });
  return { rt, handle, timers, backing, idb };
}
const file_hash = (h) => hash_of_events(read_journal_json(h.text()).events);
/** Хэш журнала в хранилище, прочитанный напрямую (а не через export_copy: тот отмечает «ручную копию» и меняет учёт записи в файл). */
const store_hash = async (backing) => hash_of_events((await create_memory_store({ backing }).load()).events);

// ── страховочные (зелёные) ───────────────────────────────────────────────────────────────────────────────────────────────

test('ADV-01 круг хэша на байтах: файл хранит UTF-8, а не строку JS; необычный текст (кириллица, эмодзи, RTL-знак, кавычки) не ломает проверку', () => {
  const text_tag = 'тест 😀 «кавычки» ü ' + String.fromCodePoint(0x202e); // знак смены направления письма (не C0/DEL): строка, ломающая наивные проверки
  const ws = edit(clone(G001), 1, text_tag, 'ex');
  const copy = export_journal_copy(events_of_ws(ws));
  const h = byte_handle({ content: 'прежнее' });
  return write_copy(h, copy.text, { verify: verify_by_hash(copy.state_hash) }).then((r) => {
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.bytes, new TextEncoder().encode(copy.text).length);
    assert.equal(h.bytes.length, r.bytes, 'в файле ровно столько байт, сколько заявлено');
    assert.equal(hash_of_events(read_journal_json(h.text()).events), copy.state_hash);
  });
});

test('ADV-02 запись не пересекается: шквал правок, «Записать сейчас» несколько раз подряд и выбор файла — в каждый момент не больше одной открытой записи, файл в конце равен журналу', async () => {
  const page = make_page(clone(G001));
  const slow = byte_handle();
  const { rt, handle, timers } = make_rt(page, { handle: slow, every_events: 3 });
  await rt.init();
  await rt.file_pick();
  slow.gate = new Promise((r) => setTimeout(r, 5));
  // 30 правок без ожидания между ними, параллельно — ручные записи
  const jobs = [];
  for (let i = 1; i <= 30; i++) {
    page.ws = edit(page.ws, i);
    jobs.push(rt.on_change({ reason: 'add_fact', ws: page.ws }));
    if (i % 7 === 0) jobs.push(rt.file_write_now());
  }
  await Promise.all(jobs);
  await rt.flush();
  slow.gate = null;
  await settle();
  await rt.flush();
  timers.fire_all();
  await settle();
  await rt.flush();
  assert.equal(handle.max_inflight, 1, 'две записи в один файл одновременно — гонка');
  assert.equal(file_hash(handle), (await rt.export_copy()).state_hash, 'после всех таймеров файл = журнал');
  assert.equal(rt.status().file.pending, 0);
  assert.ok(handle.creates <= 30, 'нет бури записей: ' + handle.creates);
});

test('ADV-03 «Удалить все данные» посреди записи: удаление ждёт запись, после него в файл не пишется ничего, а ссылка и база runway-handles сняты', async () => {
  const page = make_page(clone(G001));
  const h = byte_handle();
  const { rt, idb } = make_rt(page, { handle: h, every_events: 1000 });
  await rt.init();
  await rt.file_pick();
  const before = h.text();
  let open_gate;
  h.gate = new Promise((r) => { open_gate = r; });
  page.ws = edit(page.ws, 1);
  await rt.on_change({ reason: 'add_fact', ws: page.ws });
  const writing = rt.file_write_now(); // запись повисла на createWritable
  await settle();
  assert.equal(h.inflight, 1);
  const erasing = rt.erase(); // удаление поставлено в очередь за записью
  await settle();
  assert.equal(rt.status().mode !== 'erased', true, 'пока запись не закончилась, удаление не началось');
  open_gate();
  const w = await writing;
  const receipt = await erasing;
  assert.equal(w.ok, true, 'начатая запись доведена до конца и проверена');
  assert.equal(receipt.erased, true);
  assert.equal(idb.dbs.has(HANDLE_DB_NAME), false);
  const after = h.text();
  assert.notEqual(after, before, 'запись до удаления дошла');
  h.gate = null;
  const creates = h.creates;
  await change(page, rt, 2);
  assert.deepEqual(await rt.file_write_now(), { ok: false, code: 'erased' });
  assert.equal(h.creates, creates, 'после удаления файл не трогается');
  assert.equal(h.text(), after);
});

test('ADV-04 вкладка, у которой другая вкладка стёрла хранилище, не воскрешает данные в файл: режим paused, автозапись и «Записать сейчас» отказывают', async () => {
  const page = make_page(clone(G001));
  let deliver = null;
  const channel = { subscribe: (fn) => { deliver = fn; return () => {}; }, post() {}, close() {} };
  const { rt, handle } = make_rt(page, { channel, every_events: 1 });
  await rt.init();
  await rt.file_pick();
  await change(page, rt, 1);
  const creates = handle.creates;
  deliver({ v: 1, type: 'erased', from: 'other', last_seq: 0, count: 0 });
  assert.equal(rt.status().mode, 'paused');
  await change(page, rt, 2);
  await change(page, rt, 3);
  assert.deepEqual(await rt.file_write_now(), { ok: false, code: 'not_ready', mode: 'paused' });
  assert.equal(handle.creates, creates, 'устаревшее состояние не записано поверх копии');
});

test('ADV-05 после выбора файла и перезапуска «ещё не записано» считается от записи в файл: актуальный файл не переписывается без причины', async () => {
  const backing = create_memory_backing();
  const idb = fake_idb({ clone: smart_clone });
  const h = byte_handle();
  const page1 = make_page(clone(G001));
  const a = make_rt(page1, { backing, idb, handle: h, every_events: 2 });
  await a.rt.init();
  await a.rt.file_pick();
  await change(page1, a.rt, 1);
  await change(page1, a.rt, 2); // порог 2: запись
  assert.equal(file_hash(h), await store_hash(backing));
  // новая «страница» над теми же данными
  const creates = h.creates;
  const page2 = make_page(clone(G001), 'q');
  const b = make_rt(page2, { backing, idb, handle: h, every_events: 2 });
  const s = await b.rt.init();
  assert.equal(s.mode, 'found');
  assert.equal(s.file.phase, 'ready');
  await b.rt.continue_saved();
  await settle();
  assert.equal(h.creates, creates, 'файл уже равен журналу: повторной записи нет');
  assert.equal(b.rt.status().file.pending, 0);
});

test('ADV-06 каталог backupfile: заполнители RU и EN совпадают по каждому ключу; запрещённые формулировки vocab.json не встречаются', () => {
  const vocab = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../engine/vocab.json', import.meta.url)), 'utf8'));
  const ph = (s) => [...s.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]).sort().join(',');
  assert.deepEqual(Object.keys(catalog.ru).sort(), Object.keys(catalog.en).sort());
  for (const k of Object.keys(catalog.ru)) {
    assert.equal(ph(catalog.ru[k]), ph(catalog.en[k]), 'заполнители ' + k);
    assert.match(catalog.ru[k], /[А-Яа-яЁё]/, 'русская строка ' + k);
    for (const lang of ['ru', 'en']) {
      const low = catalog[lang][k].toLowerCase();
      for (const bad of vocab.forbidden_phrases) assert.ok(!low.includes(bad.toLowerCase()), `${lang} ${k}: «${bad}»`);
    }
  }
});

test('ADV-07 безопасность разметки: в коде автозаписи и экрана нет innerHTML, outerHTML, insertAdjacentHTML, eval, new Function, fetch, внешних адресов', () => {
  const files = ['backup_file.mjs', 'data_view.mjs', 'data_runtime.mjs', 'i18n/backupfile.mjs', 'store_idb.mjs', 'pack_fp05.mjs'];
  for (const f of files) {
    const src = fs.readFileSync(fileURLToPath(new URL('../demo/' + f, import.meta.url)), 'utf8');
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'eval(', 'new Function', 'fetch(', 'XMLHttpRequest', 'document.write', 'https://', 'http://']) assert.ok(!src.includes(bad), f + ': ' + bad);
  }
});

// ── дефектные (todo) ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('ADV-10 [СРЕДНИЙ] автозапись по таймеру без участия пользователя перерисовывает всю страницу: ctx.refresh → render() → main.replaceChildren(...), и недозаполненная форма раздела «Формы» (FP-08, без черновика) теряет введённое и фокус', { todo: 'changed() → on_state → ping() → ctx.refresh() после КАЖДОЙ записи, в том числе тихой, по таймеру через 5 минут после правки; app.render() пересоздаёт main целиком. Нужно: не перерисовывать, если видимое состояние не изменилось или открыт не экран «Данные»' }, async () => {
  const page = make_page(clone(G001));
  const { rt, timers } = make_rt(page, { every_events: 1000 });
  await rt.init();
  await rt.file_pick();
  await change(page, rt, 1); // правка пользователя: перерисовка от хранилища ожидаема
  await rt.flush();
  await settle();
  assert.equal(timers.count(), 1, 'таймер ждёт');
  const before = page.renders;
  timers.fire_all(); // прошло 5 минут: пользователь в это время мог печатать в форме
  await settle();
  await rt.flush();
  assert.equal(rt.status().file.pending, 0, 'тихая запись состоялась');
  assert.equal(page.renders, before, 'тихая автозапись не должна перерисовывать страницу; перерисовок добавилось: ' + (page.renders - before));
});

test('ADV-11 [НИЗКИЙ] «Начать с текущего набора» при выбранном файле: первая же правка молча заменяет файл-копию прежнего журнала новым, а окно подтверждения про файл молчит', { todo: 'replace_saved не сообщает контроллеру автозаписи; written_count остаётся от прежнего журнала, |count − written| ≥ порога — запись немедленно. Файл, в котором лежала единственная копия стёртого, заменён без предупреждения (data.replace_warn про файл не говорит)' }, async () => {
  const backing = create_memory_backing();
  const idb = fake_idb({ clone: smart_clone });
  const h = byte_handle();
  const page1 = make_page(clone(G001));
  const a = make_rt(page1, { backing, idb, handle: h, every_events: 2 });
  await a.rt.init();
  await a.rt.file_pick();
  for (let i = 1; i <= 6; i++) await change(page1, a.rt, i);
  const old_text = h.text();
  const old_hash = file_hash(h);
  assert.equal(old_hash, await store_hash(backing));
  // новая страница: в хранилище есть журнал; пользователь выбирает «Начать с текущего набора»
  const page2 = make_page(clone(G001), 'q');
  const b = make_rt(page2, { backing, idb, handle: h, every_events: 2 });
  assert.equal((await b.rt.init()).mode, 'found');
  assert.equal((await b.rt.replace_saved()).ok, true);
  await change(page2, b.rt, 100, 'new');
  await b.rt.flush();
  await settle();
  assert.equal(h.text(), old_text, 'прежняя копия в файле не должна исчезать молча после стирания сохранённого');
});

test('ADV-12 [НИЗКИЙ] первая запись в НОВЫЙ файл не удалась, страница перезагружена: число записей «в файле» берётся из записи о копии ПРЕЖНЕГО файла, и новый файл остаётся пустым до следующей правки', { todo: 'known_count берётся из last_backup с via = file, а запись не знает, КАКОГО файла: после сбоя первой записи в новый файл pending = 0, автозапись «включена», файл пуст' }, async () => {
  const backing = create_memory_backing();
  const idb = fake_idb({ clone: smart_clone });
  const first = byte_handle({ name: 'a.json' });
  const page1 = make_page(clone(G001));
  const a = make_rt(page1, { backing, idb, handle: first, every_events: 2 });
  await a.rt.init();
  await a.rt.file_pick();
  await change(page1, a.rt, 1);
  await change(page1, a.rt, 2);
  assert.equal(a.rt.status().last_backup.via, 'file');
  // пользователь выбирает другой файл, и первая запись в него не удаётся (диск полон)
  const second = byte_handle({ name: 'b.json' });
  second.createWritable = async () => { throw named('QuotaExceededError'); };
  a.rt.status();
  const rt_pick = create_runtime({
    store: create_memory_store({ backing }), store_kind: 'memory', lock: create_lock({ locks: null }), channel: null, storage_manager: { persisted: async () => true }, installed: () => true,
    today: () => page1.today, ports: page1.ports, get_ws: page1.get_ws, set_ws: page1.set_ws, refresh: page1.refresh,
    file: { api: { showSaveFilePicker: async () => second }, handle_store: create_handle_store({ indexedDB: idb.factory }), timers: fake_timers(), every_events: 2, every_ms: 60000 },
  });
  await rt_pick.init();
  await rt_pick.continue_saved();
  const r = await rt_pick.file_pick();
  assert.equal(r.write.ok, false);
  // перезагрузка: новая страница, файл b.json запомнен
  const good_second = second;
  good_second.createWritable = byte_handle().createWritable; // диск освободился
  const page3 = make_page(clone(G001), 'z');
  const c = make_rt(page3, { backing, idb, handle: good_second, every_events: 2 });
  await c.rt.init();
  await c.rt.continue_saved();
  await settle();
  await c.rt.flush();
  assert.notEqual(c.rt.status().file.pending, 0, 'в новый файл ещё ничего не записано, а счётчик говорит «записано всё»');
});

test('ADV-13 [НИЗКИЙ] «Не использовать файл» в одной вкладке не останавливает автозапись в другой открытой вкладке: ссылка снята только в базе и в памяти первой', { todo: 'канал оповещения вкладок знает только appended / replaced / erased; о снятии или смене файла вторая вкладка не узнаёт и продолжает писать в файл, о котором первая сказала «остановлено»' }, async () => {
  const backing = create_memory_backing();
  const idb = fake_idb({ clone: smart_clone });
  const h = byte_handle();
  const page1 = make_page(clone(G001));
  const a = make_rt(page1, { backing, idb, handle: h, every_events: 1 });
  await a.rt.init();
  await a.rt.file_pick();
  await change(page1, a.rt, 1);
  const page2 = make_page(clone(G001), 'q');
  const b = make_rt(page2, { backing, idb, handle: h, every_events: 1 });
  assert.equal((await b.rt.init()).file.phase, 'ready');
  await b.rt.continue_saved();
  await a.rt.file_forget();
  const creates = h.creates;
  await change(page2, b.rt, 50, 'b');
  await b.rt.flush();
  assert.equal(h.creates, creates, 'после «Не использовать файл» запись в него не должна идти из другой вкладки');
});

test('ADV-14 [НИЗКИЙ] зависшая запись в файл (недоступный сетевой диск, облачная заглушка) без тайм-аута держит общую очередь страницы и замок «один писатель»: правки перестают попадать в основное хранилище', { todo: 'write_now ждёт createWritable / close без ограничения времени и идёт через enqueue + lock.run; пока файл не ответил, handle_change (запись журнала в IndexedDB) стоит в той же очереди. Нужен предел времени на операции с файлом (отказ с кодом aborted, повтор по таймеру)' }, async () => {
  const page = make_page(clone(G001));
  const h = byte_handle();
  const { rt, backing } = make_rt(page, { handle: h, every_events: 1000 });
  await rt.init();
  await rt.file_pick();
  await change(page, rt, 1); // журнал в хранилище начат
  const count_in_store = async () => (await create_memory_store({ backing }).load()).events.length;
  const before = await count_in_store();
  h.gate = new Promise(() => {}); // файл не отвечает
  rt.file_write_now();
  await settle();
  page.ws = edit(page.ws, 2);
  rt.on_change({ reason: 'add_fact', ws: page.ws });
  await settle();
  assert.ok((await count_in_store()) > before, 'правка пользователя должна попасть в хранилище, даже если файл-копия не отвечает; в хранилище записей: ' + (await count_in_store()) + ' (было ' + before + ')');
});
