// data_actions.test.mjs — действия экрана «Данные» (FP-05): файл-копия «Журнал JSON + state_hash» и «Восстановить» (TST-38, REQ-094, REQ-097),
// CSV с защитой от формул (TST-43, REQ-095), hledger через мост ws (TST-44, REQ-096), список потерь формата, удаление всех данных с квитанцией (REQ-098),
// сквозные сценарии хранения на среде выполнения (REQ-122, REQ-097: «продолжить с сохранённого», копия, напоминание, пауза, сбой записи, две вкладки).
// Хранилище — в памяти, на фейке IndexedDB (tests/fake_idb.mjs) и на localStorage-обёртке; браузер не нужен.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { analyze, state_hash, reduce, effective_events } from '../engine/index.mjs';
import { import_json, parse_with_profile, RUNWAY_CSV_PROFILE, MAX_IMPORT_BYTES } from '../engine/io.mjs';
import { ws_to_events, events_to_ws, ws_to_journal, journal_to_ws } from '../demo/ws_bridge.mjs';
import {
  export_journal_copy, events_of_ws, hash_of_events, export_csv_file, export_hledger_file, format_losses, FORMAT_LOSSES, inspect_import, restore_preview,
  erase_preview, erase_all, counts_of_ws, counts_of_state, file_name, LOCAL_PREFIX,
} from '../demo/data_actions.mjs';
import { create_memory_store, create_memory_backing, create_local_store, create_lock, StoreError } from '../demo/store.mjs';
import { create_idb_store, pick_store, DB_NAME } from '../demo/store_idb.mjs';
import { create_runtime } from '../demo/data_runtime.mjs';
import { apply_edit } from '../demo/ws_edit.mjs';
import { fake_idb } from './fake_idb.mjs';

const load = (name) => JSON.parse(fs.readFileSync(new URL('../data/' + name, import.meta.url), 'utf8'));
const SETS = { g001: load('g001.json'), 'g001-low': load('g001-low.json'), 'g001-gap': load('g001-gap.json'), 'g001-late': load('g001-late.json') };
const clone = (x) => JSON.parse(JSON.stringify(x));
const AT = '2026-10-05T08:00:00Z';

// ── TST-38 REQ-094: файл-копия ─────────────────────────────────────────────────────────────────────────────────────────

for (const [name, ws] of Object.entries(SETS)) {
  test(`TST-38 REQ-094 ${name}: «Скачать журнал» = export_json, «Восстановить» = import_json, state_hash совпадает, числа канона те же`, () => {
    const events = events_of_ws(ws);
    const copy = export_journal_copy(events);
    assert.match(copy.state_hash, /^[0-9a-f]{64}$/);
    assert.equal(copy.count, events.length);
    assert.equal(copy.bytes, new TextEncoder().encode(copy.text).length);
    assert.equal(JSON.parse(copy.text).format, 'runway-journal/1');
    // чтение файла движком даёт то же состояние
    assert.equal(state_hash(import_json(copy.text)), copy.state_hash, 'io.import_json: тот же state_hash');
    // «Восстановить»: разбор файла приложением
    const parsed = inspect_import(copy.text);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.kind, 'journal');
    assert.equal(parsed.hash, copy.state_hash, 'state_hash после восстановления совпадает');
    assert.equal(parsed.format, 'runway-journal/1');
    assert.deepEqual(parsed.counts, copy.counts);
    // рабочая область из файла считается так же, как исходная
    const a1 = analyze(ws, { as_of: ws.as_of });
    const a2 = analyze(parsed.ws, { as_of: parsed.ws.as_of });
    assert.equal(a2.inputs_hash, a1.inputs_hash);
    assert.deepEqual(a2.series.plan.close, a1.series.plan.close);
    // файл детерминирован: тот же набор — те же байты
    assert.equal(export_journal_copy(events_of_ws(ws)).text, copy.text);
    // совпадает с мостом ws → файл (ws_bridge)
    assert.equal(copy.text.includes('"format":"runway-journal/1"'), true);
    assert.equal(journal_to_ws(copy.text).as_of, ws.as_of);
    assert.equal(ws_to_journal(ws, { engine_version: JSON.parse(copy.text).engine_version }), copy.text, 'то же, что даёт ws_to_journal');
  });
}

test('TST-38 REQ-094 G-001 после копии и восстановления: opening = 400000 и end_close = 340000', () => {
  const ws = SETS.g001;
  const copy = export_journal_copy(events_of_ws(ws));
  const back = inspect_import(copy.text);
  const a = analyze(back.ws, { as_of: back.ws.as_of });
  assert.equal(a.series.plan.opening_minor, 400000);
  assert.equal(a.series.plan.close.at(-1), 340000);
});

test('TST-38 REQ-094 журнал с историей правок (замена и откат записей) — круг тоже сохраняет state_hash; изменённый файл даёт другое состояние', () => {
  const ws = clone(SETS.g001);
  const events = ws_to_events(ws);
  const f = events.find((e) => e.type === 'tx.posted');
  // исправление записи (supersedes) и откат другой записи
  const fixed = { ...f, event_id: 'evt~900001', seq: events.length + 1, supersedes_id: f.event_id, payload: { ...f.payload, amount_minor: f.payload.amount_minor - 100 } };
  const last_fact = [...events].reverse().find((e) => e.type === 'tx.posted' && e.event_id !== f.event_id);
  const revert = { ...last_fact, type: 'revert', event_id: 'evt~900002', seq: events.length + 2, payload: { target: last_fact.event_id } };
  const edited = [...events, fixed, revert];
  let copy;
  try { copy = export_journal_copy(edited); } catch (e) { assert.fail('история правок не экспортируется: ' + e.message); }
  assert.equal(inspect_import(copy.text).hash, copy.state_hash);
  const tampered = copy.text.replace('"amount_minor":' + (f.payload.amount_minor - 100), '"amount_minor":' + (f.payload.amount_minor - 101));
  if (tampered !== copy.text) assert.notEqual(inspect_import(tampered).hash, copy.state_hash, 'правка в файле видна по хэшу состояния');
});

test('TST-38 REQ-094 «демо по-прежнему читает прежний JSON рабочей области»: файл набора данных разбирается как workspace, без изменений', () => {
  for (const [name, ws] of Object.entries(SETS)) {
    const text = JSON.stringify(ws, null, 2);
    const r = inspect_import(text);
    assert.equal(r.ok, true, name);
    assert.equal(r.kind, 'workspace', name);
    assert.deepEqual(r.ws, ws, name);
    assert.equal(r.hash, null);
    assert.deepEqual(r.counts, counts_of_ws(ws));
  }
});

test('REQ-094 REQ-017 inspect_import: недоверенный файл — отказ кодом, без текста файла; ключи-«ловушки», слишком большой, новый формат, не копия', () => {
  const secret = 'секретная-заметка-4730';
  const cases = {
    bad_json: '{"секрет": ' + secret,
    not_a_copy: JSON.stringify([1, 2]),
    not_a_copy_2: JSON.stringify({ hello: secret }),
  };
  assert.equal(inspect_import(cases.bad_json).error, 'bad_json');
  assert.equal(inspect_import(cases.not_a_copy).error, 'not_a_copy');
  assert.equal(inspect_import(cases.not_a_copy_2).error, 'not_a_copy');
  assert.equal(inspect_import(42).error, 'bad_json');
  for (const r of [inspect_import(cases.bad_json), inspect_import(cases.not_a_copy_2)]) assert.ok(!JSON.stringify(r).includes(secret), 'в ответе нет содержимого файла');
  // слишком большой
  const big = inspect_import(' '.repeat(MAX_IMPORT_BYTES + 1));
  assert.deepEqual([big.ok, big.error], [false, 'too_big']);
  // формат новее известного
  const newer = inspect_import(JSON.stringify({ format: 'runway-journal/2', events: [] }));
  assert.deepEqual([newer.ok, newer.error, newer.ctx?.reason], [false, 'E_SCHEMA', 'newer_format']);
  assert.equal(inspect_import(JSON.stringify({ format: 'runway-journal/1', events: 'нет' })).error, 'E_SCHEMA');
  assert.equal(inspect_import(JSON.stringify({ format: 'runway-journal/1', events: [{ type: 'x', event_id: 'e', seq: 1.5 }] })).error, 'E_SCHEMA');
  // прототипные ключи в рабочей области
  const evil = inspect_import('{"as_of":"2026-10-05","accounts":[{"__proto__":{"polluted":true},"account_id":"a"}]}');
  assert.deepEqual([evil.ok, evil.error], [false, 'E_SCHEMA']);
  assert.equal({}.polluted, undefined);
  // события с неверной формой: reduce откажет кодом движка
  const bad_ev = inspect_import(JSON.stringify({ format: 'runway-journal/1', events: [{ type: 'нет.такого', event_id: 'e1', seq: 1, v: 1, payload: {} }] }));
  assert.equal(bad_ev.ok, false);
  assert.ok(typeof bad_ev.error === 'string' && bad_ev.error.length > 0);
});

test('REQ-097 «что будет заменено»: счётчики сейчас и в файле; совпадение состояния по хэшу', () => {
  const ws = SETS.g001;
  const copy = export_journal_copy(events_of_ws(ws));
  const parsed = inspect_import(copy.text);
  const same = restore_preview({ counts: counts_of_ws(ws), hash: copy.state_hash }, { counts: parsed.counts, hash: parsed.hash });
  assert.equal(same.same_state, true);
  assert.deepEqual(same.rows.map((r) => r.id), ['operations', 'rules', 'scenarios']);
  assert.ok(same.rows.every((r) => r.now === r.incoming), 'сейчас = в файле');
  const other = restore_preview({ counts: { operations: 5, rules: 1, scenarios: 0 }, hash: 'a'.repeat(64) }, { counts: parsed.counts, hash: parsed.hash });
  assert.equal(other.same_state, false);
  assert.deepEqual(other.rows[0], { id: 'operations', now: 5, incoming: parsed.counts.operations });
  assert.equal(other.replaces_all, true);
  assert.equal(restore_preview({ counts: {} }, { counts: {} }).same_state, false, 'нет хэшей — не утверждаем совпадение');
});

test('REQ-094 file_name: имена файлов по виду и дате', () => {
  assert.equal(file_name('journal', '2026-10-05'), 'runway-journal-2026-10-05.json');
  assert.equal(file_name('csv', '2026-10-05'), 'runway-csv-2026-10-05.csv');
  assert.equal(file_name('hledger', '2026-10-05'), 'runway-hledger-2026-10-05.journal');
  assert.equal(file_name('journal', 'вчера'), 'runway-journal.json');
  assert.throws(() => file_name('exe', '2026-10-05'), RangeError);
});

// ── TST-43 REQ-095: CSV ────────────────────────────────────────────────────────────────────────────────────────────────

test('TST-43 REQ-095 CSV журнала из ws-массивов (через ws_bridge, без E_SCHEMA): формулы экранируются ведущим «\'», сумма -4730 не меняется, текст восстанавливается без префикса', () => {
  const ws = clone(SETS.g001);
  ws.facts.push({ event_id: 'f_evil', account_id: 'acc_main', date: '2026-10-03', amount_minor: -4730, currency: 'EUR', tag: 'x', note: '=HYPERLINK("http://x")' });
  ws.facts.push({ event_id: 'f_plus', account_id: 'acc_main', date: '2026-10-03', amount_minor: 100, currency: 'EUR', tag: '+cmd', note: '@SUM(A1)' });
  const out = export_csv_file(ws);
  const lines = out.text.split('\n');
  assert.equal(lines[0], 'date,account_id,amount_minor,currency,kind,layer,tag,counterparty,note,event_id,dedup_key');
  const evil = lines.find((l) => l.includes('HYPERLINK'));
  assert.ok(evil.includes('"\'=HYPERLINK(""http://x"")"'), 'описание экранировано префиксом: ' + evil);
  assert.ok(evil.includes(',-4730,'), 'числовая колонка без изменений');
  assert.ok(lines.find((l) => l.includes('+cmd')).includes(",'+cmd,"), 'метка экранирована');
  assert.ok(lines.find((l) => l.includes('@SUM')).includes("'@SUM(A1)"));
  for (const l of lines.slice(1)) assert.ok(!/(^|,)[=+@]/.test(l.split(',').slice(0, 3).join(',')) || l.startsWith('date'), 'ни одна ячейка даты/счёта/суммы не начинается с формулы: ' + l);
  assert.equal(out.rows, lines.length - 2);
  assert.ok(out.rows >= 30);
  assert.equal(out.bytes, new TextEncoder().encode(out.text).length);
  // обратно через встроенный профиль runway-csv/1: текстовые поля без префикса, сумма та же
  const r = parse_with_profile(RUNWAY_CSV_PROFILE, out.text, { account_id: 'acc_main', account_currency: 'EUR', as_of: ws.as_of });
  const back = r.candidates.find((c) => c.amount_minor === -4730);
  assert.equal(back.desc, '=HYPERLINK("http://x")');
  assert.equal(r.candidates.find((c) => c.desc === '@SUM(A1)').amount_minor, 100);
});

test('TST-43 REQ-095 список потерь CSV показан: корзины, которых в файле нет (правила, потоки, резервы, сценарии, якоря, параметры…), с числом элементов', () => {
  const ws = SETS.g001;
  const out = export_csv_file(ws);
  const ids = out.losses.map((x) => x.id);
  for (const need of ['rules', 'streams', 'reserves', 'scenarios', 'anchors', 'params', 'tax_rules', 'purchases']) assert.ok(ids.includes(need), 'в списке потерь ' + need);
  for (const x of out.losses) { assert.equal(x.mode, 'lost'); assert.ok(x.count > 0); }
  assert.equal(out.losses.find((x) => x.id === 'rules').count, ws.rules.length);
  assert.equal(out.losses.find((x) => x.id === 'params').count, Object.keys(ws.params).length);
  assert.deepEqual(format_losses('csv', { facts: [] }), [], 'пустая рабочая область — потерь нет');
  assert.throws(() => format_losses('pdf', ws), RangeError);
});

// ── TST-44 REQ-096: hledger ────────────────────────────────────────────────────────────────────────────────────────────

test('TST-44 REQ-096 hledger из ws-массивов без E_SCHEMA: якорь с assertion, плановые разовые правила с датами, горизонт от as_of; повтор даёт те же байты', () => {
  const ws = SETS.g001;
  const out = export_hledger_file(ws);
  assert.equal(out.planned_error, null);
  assert.equal(out.planned, 16);
  assert.equal(out.horizon_end, '2026-11-30', 'горизонт набора данных от as_of');
  const lines = out.text.split('\n');
  assert.ok(lines[0].startsWith('; runway-journal/1'));
  assert.ok(lines.some((l) => l.startsWith('2026-10-04 * якорь')), 'якорь — транзакция с assertion');
  assert.ok(lines.some((l) => l.includes('= 4000.00 EUR')), 'assertion «= остаток»');
  assert.ok(lines.some((l) => l.startsWith('~ 2026-10-09  связь')), 'плановое правило с датой');
  assert.equal(lines.filter((l) => l.startsWith('~ ')).length, 16);
  assert.equal(export_hledger_file(ws).text, out.text);
  assert.equal(out.bytes, new TextEncoder().encode(out.text).length);
  // горизонт короче — меньше плановых строк
  const short = export_hledger_file(ws, { horizon_days: 10 });
  assert.ok(short.planned < out.planned);
});

test('TST-44 REQ-096 список потерь hledger: что не выразить (сценарии, налоги, резервы, покупки), а правила и потоки — «материализованы»', () => {
  const out = export_hledger_file(SETS.g001);
  const by = Object.fromEntries(out.losses.map((x) => [x.id, x.mode]));
  assert.equal(by.scenarios, 'lost');
  assert.equal(by.tax_rules, 'lost');
  assert.equal(by.reserves, 'lost');
  assert.equal(by.rules, 'materialized');
  assert.equal(by.streams, 'materialized');
  for (const id of Object.keys(by)) assert.ok(FORMAT_LOSSES.hledger.lost.includes(id) || FORMAT_LOSSES.hledger.materialized.includes(id), id);
});

test('TST-44 REQ-096 отказ расчёта плана не роняет выгрузку: факты и якоря выгружаются, причина — planned_error (код движка)', () => {
  const ws = clone(SETS.g001);
  ws.rules[0].freq = 'X';
  const out = export_hledger_file(ws);
  assert.equal(out.planned_error, 'E_RULE_INVALID');
  assert.equal(out.planned, 0);
  assert.ok(out.text.includes('якорь'));
});

// ── REQ-098: удаление всех данных ──────────────────────────────────────────────────────────────────────────────────────

function fake_storage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}
const batch = (n) => Array.from({ length: n }, (_, i) => ({ type: 'tx.posted', event_id: 'e' + (i + 1), seq: i + 1, v: 1, recorded_at: AT, payload: { account_id: 'a', date: '2026-09-01', amount_minor: i + 1, currency: 'EUR' }, entity_id: 'f' + i }));

test('REQ-098 erase_preview: «будет удалено N операций, M правил, K сценариев» по рабочей области и числу записей хранилища', () => {
  const ws = SETS.g001;
  const p = erase_preview(ws, { count: 77 });
  assert.deepEqual(p, { operations: ws.facts.length, rules: ws.rules.length, scenarios: ws.scenarios.length, events: 77 });
  assert.deepEqual(erase_preview({}, undefined), { operations: 0, rules: 0, scenarios: 0, events: 0 });
  assert.deepEqual(counts_of_state(reduce(effective_events(events_of_ws(ws)))), counts_of_ws(ws));
});

test('REQ-098 eraseAll: квитанция {erased, date, counts, stores, copies_warning}; хранилище, ключи localStorage приложения, кэш и сервис-воркер очищены; чужие ключи не тронуты; повтор без ошибки', async () => {
  const store = create_memory_store();
  await store.append(batch(5));
  await store.set_meta('last_backup', { day: '2026-10-01', count: 3, hash: 'a'.repeat(64) });
  const storage = fake_storage({ 'runway-demo-lang': 'ru', 'runway-demo-theme': 'dark', 'runway-store/1': '{}', 'other-site-key': 'x' });
  // Источник localhost общий для ВСЕХ проектов пользователя: свои кэши — с префиксом runway, чужие (portal-v9-cache, shell-v1) трогать нельзя.
  const caches = { names: ['runway-shell-v1', 'runway-shell-v2', 'portal-v9-cache', 'shell-v1'], keys: async function () { return [...this.names]; }, delete: async function (n) { this.names = this.names.filter((x) => x !== n); return true; } };
  const OWN = 'http://localhost/01/301/runway/prototype/';
  const mk_reg = (scope) => ({ scope, unregistered: false, unregister: async function () { this.unregistered = true; return true; } });
  const regs = [mk_reg(OWN), mk_reg('http://localhost/50/')]; // свой воркер и чужой
  const sw = { getRegistrations: async () => regs.filter((r) => !r.unregistered) };
  const posted = [];
  const channel = { post: (type, head) => posted.push([type, head.count]) };
  const before = erase_preview(SETS.g001, await store.stat());
  assert.equal(before.events, 5);
  const receipt = await erase_all({ store, storage, caches, service_worker: sw, own_scope: OWN, channel, today: () => '2026-10-05' }, { counts: before, events: before.events });
  assert.equal(receipt.erased, true);
  assert.equal(receipt.date, '2026-10-05');
  assert.deepEqual(receipt.counts, { operations: SETS.g001.facts.length, rules: SETS.g001.rules.length, scenarios: SETS.g001.scenarios.length, events: 5 });
  assert.equal(receipt.copies_warning, true, 'предупреждение о файлах-копиях показывается всегда');
  assert.deepEqual(receipt.errors, []);
  assert.deepEqual(receipt.stores.map((s) => s.name), ['store', 'local_storage', 'cache', 'service_worker']);
  assert.equal(receipt.stores.find((s) => s.name === 'local_storage').removed, 3);
  assert.equal(receipt.stores.find((s) => s.name === 'cache').removed, 2);
  assert.equal(receipt.stores.find((s) => s.name === 'cache').foreign_kept, 2, 'чужие кэши не удалены');
  assert.equal(receipt.stores.find((s) => s.name === 'service_worker').removed, 1);
  assert.equal(receipt.stores.find((s) => s.name === 'service_worker').foreign_kept, 1, 'чужой сервис-воркер не снят');
  // после удаления чтение даёт пусто
  assert.deepEqual(await store.load(), { events: [], snapshots: [], meta: {} });
  assert.deepEqual([...storage.map.keys()], ['other-site-key'], 'остался только чужой ключ');
  assert.deepEqual(caches.names, ['portal-v9-cache', 'shell-v1'], 'остались только чужие кэши');
  assert.equal(regs[0].unregistered, true, 'свой сервис-воркер снят');
  assert.equal(regs[1].unregistered, false, 'чужой сервис-воркер (другой проект на том же источнике) не тронут');
  assert.deepEqual(posted, [['erased', 0]], 'другие вкладки оповещены');
  // повторный запуск не ошибается и тоже отдаёт квитанцию
  const again = await erase_all({ store, storage, caches, service_worker: sw, own_scope: OWN, channel, today: () => '2026-10-06' }, { counts: { operations: 0, rules: 0, scenarios: 0 } });
  assert.equal(again.erased, true);
  assert.equal(again.date, '2026-10-06');
  assert.equal(again.copies_warning, true);
  assert.equal(again.stores.find((s) => s.name === 'local_storage').removed, 0);
  assert.equal(LOCAL_PREFIX, 'runway');
});

test('REQ-098 eraseAll безопасен для общего источника localhost: без own_scope ни один сервис-воркер не снимается, кэши без префикса runway и чужие ключи localStorage целы; похожая чужая область не считается своей', async () => {
  const store = create_memory_store();
  await store.append(batch(1));
  const storage = fake_storage({ 'runway-demo-lang': 'ru', 'portal-v9-state': '{}' });
  const caches = { names: ['portal-v9-cache', 'ad-concepts-v3', 'runway-shell-v1'], keys: async function () { return [...this.names]; }, delete: async function (n) { this.names = this.names.filter((x) => x !== n); return true; } };
  const mk_reg = (scope) => ({ scope, unregistered: false, unregister: async function () { this.unregistered = true; return true; } });
  const portal = mk_reg('http://localhost/50/');
  const lookalike = mk_reg('http://localhost/01/301/runway-other/'); // начинается как «runway», но это другой каталог
  const sw = { getRegistrations: async () => [portal, lookalike].filter((r) => !r.unregistered) };
  const r = await erase_all({ store, storage, caches, service_worker: sw, today: () => '2026-10-05' });
  assert.equal(r.erased, true);
  assert.equal(portal.unregistered, false, 'без own_scope воркеры не снимаются вовсе (безопасное умолчание)');
  assert.equal(lookalike.unregistered, false);
  assert.equal(r.stores.find((s) => s.name === 'service_worker').removed, 0);
  assert.equal(r.stores.find((s) => s.name === 'service_worker').foreign_kept, 2);
  assert.deepEqual(caches.names, ['portal-v9-cache', 'ad-concepts-v3'], 'удалён только кэш runway-shell-v1');
  assert.deepEqual([...storage.map.keys()], ['portal-v9-state'], 'чужой ключ localStorage цел');
  const OWN = 'http://localhost/01/301/runway/prototype/';
  const r2 = await erase_all({ storage, caches, service_worker: sw, own_scope: OWN, today: () => '2026-10-05' });
  assert.equal(r2.erased, true);
  assert.equal(portal.unregistered, false);
  assert.equal(lookalike.unregistered, false, 'область runway-other/ не входит в runway/prototype/');
  assert.equal(r2.stores.find((s) => s.name === 'service_worker').foreign_kept, 2);
});

test('REQ-098 eraseAll на IndexedDB-обёртке: после удаления база снята, чтение из новой вкладки даёт пусто, повтор без ошибки', async () => {
  const f = fake_idb();
  const open = () => create_idb_store({ indexedDB: f.factory, IDBKeyRange: f.IDBKeyRange });
  const store = open();
  await store.append(batch(7));
  await store.put_snapshot({ count: 7, seq: 7, state: { n: 7 } });
  assert.equal(f.rows(DB_NAME, 'events'), 7);
  const r = await erase_all({ store, today: () => '2026-10-05' }, { counts: { operations: 7, rules: 0, scenarios: 0 }, events: 7 });
  assert.equal(r.erased, true);
  assert.equal(f.dbs.has(DB_NAME), false, 'база снята целиком');
  const fresh = open();
  assert.deepEqual(await fresh.load(), { events: [], snapshots: [], meta: {} });
  await fresh.destroy();
  const r2 = await erase_all({ store: fresh, today: () => '2026-10-05' });
  assert.equal(r2.erased, true);
  assert.equal(f.dbs.has(DB_NAME), false);
});

test('REQ-098 eraseAll: сбой одного шага не мешает остальным, попадает в errors кодом, erased = false; остальное очищено', async () => {
  const store = create_memory_store();
  await store.append(batch(2));
  const storage = fake_storage({ 'runway-demo-lang': 'ru' });
  const broken_caches = { keys: async () => { throw Object.assign(new Error('секрет-кэша'), { code: 'cache_down' }); } };
  const r = await erase_all({ store, storage, caches: broken_caches, today: () => '2026-10-05' });
  assert.equal(r.erased, false);
  assert.deepEqual(r.errors, ['cache:cache_down']);
  assert.ok(!JSON.stringify(r).includes('секрет-кэша'), 'текст ошибки в квитанцию не попадает');
  assert.equal((await store.stat()).count, 0);
  assert.equal(storage.map.size, 0);
  assert.equal(r.stores.find((s) => s.name === 'cache').cleared, false);
  assert.equal(r.copies_warning, true);
  // хранилище, которое отказывает на очистке
  const bad_store = { kind: 'memory', clear: async () => { throw new StoreError('store_failed'); }, stat: async () => ({ count: 1, snapshots: 0, meta_keys: [] }), destroy: async () => {} };
  const r2 = await erase_all({ store: bad_store, today: () => '2026-10-05' });
  assert.deepEqual([r2.erased, r2.errors], [false, ['store:store_failed']]);
});

// ── выбор хранилища ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-122 pick_store: IndexedDB → localStorage → память; отказ кандидата — переход к следующему, причина кодом', async () => {
  const f = fake_idb();
  const a = await pick_store({ indexedDB: f.factory, IDBKeyRange: f.IDBKeyRange, localStorage: fake_storage() });
  assert.deepEqual([a.kind, a.tried], ['idb', []]);
  const broken_idb = { open: () => { throw Object.assign(new Error('SecurityError'), { name: 'SecurityError' }); } };
  const b = await pick_store({ indexedDB: broken_idb, localStorage: fake_storage() });
  assert.equal(b.kind, 'local');
  assert.deepEqual(b.tried, ['idb:store_unavailable']);
  const corrupt = fake_storage({ 'runway-store/1': '{не json' });
  const c = await pick_store({ indexedDB: null, localStorage: corrupt });
  assert.equal(c.kind, 'memory');
  assert.deepEqual(c.tried, ['local:store_corrupt']);
  assert.equal(corrupt.getItem('runway-store/1'), '{не json', 'испорченное не стирается молча');
  const d = await pick_store({});
  assert.deepEqual([d.kind, d.tried], ['memory', []]);
});

// ── сквозные сценарии: среда выполнения хранения ───────────────────────────────────────────────────────────────────────

/** Страница-заглушка: рабочая область, `set_ws`, счётчик перерисовок, «сегодня» и порты записей. */
function make_page(ws0, o = {}) {
  let n = 0;
  const page = {
    ws: ws0, renders: 0, today: o.today ?? '2026-10-05', sets: [],
    get_ws: () => page.ws,
    set_ws: (ws, opts) => { page.ws = ws; page.sets.push(opts?.reason ?? 'edit'); return { ok: true }; },
    refresh: () => { page.renders += 1; },
  };
  page.ports = { next_id: () => 'p~' + (o.tag ?? 'a') + '~' + (++n), recorded_at: () => AT };
  return page;
}
function runtime_on(page, store, store_kind, o = {}) {
  return create_runtime({
    store, store_kind, lock: o.lock ?? create_lock({ locks: null }), channel: o.channel ?? null,
    storage_manager: o.storage_manager ?? { persisted: async () => true },
    installed: () => true, today: () => page.today, ports: page.ports, get_ws: page.get_ws, set_ws: page.set_ws, refresh: page.refresh, erase_ports: o.erase_ports,
  });
}
const edit = (ws, e) => { const r = apply_edit(ws, e, { new_id: (p) => p + '_' + Math.random().toString(16).slice(2, 10) }); assert.ok(r.ok, JSON.stringify(r.error)); return r.ws; };
const fact = (i) => ({ type: 'add_fact', fact: { event_id: 'u_' + i, account_id: 'acc_main', date: '2026-10-03', amount_minor: -(100 + i), currency: 'EUR', tag: 'x' } });

test('REQ-122 «Продолжить с сохранённого»: хранилище пусто → до правки ничего не пишется; первая правка записывает набор и правку; новая вкладка видит сохранённое и продолжает с тем же расчётом', async () => {
  const backing = create_memory_backing();
  const page = make_page(clone(SETS.g001));
  const rt = runtime_on(page, create_memory_store({ backing }), 'memory');
  assert.equal((await rt.init()).mode, 'fresh');
  assert.equal((await create_memory_store({ backing }).stat()).count, 0, 'до правки в хранилище пусто');
  const ws1 = edit(page.ws, fact(1));
  page.ws = ws1;
  await rt.on_change({ reason: 'add_fact', ws: ws1 });
  const st = rt.status();
  assert.equal(st.mode, 'active');
  const stored = await create_memory_store({ backing }).load();
  assert.equal(stored.events.length, ws_to_events(SETS.g001).length + 1, 'набор данных (47 записей) и одна правка');
  assert.equal(st.count, stored.events.length);
  assert.equal(st.last_backup, null);
  // вторая правка — дописывается
  const ws2 = edit(ws1, fact(2));
  page.ws = ws2;
  await rt.on_change({ reason: 'add_fact', ws: ws2 });
  assert.equal((await create_memory_store({ backing }).stat()).count, stored.events.length + 1);

  // «новая вкладка» (страница снова с учебным набором): видит сохранённое, пока не выбрано — ничего не пишет и не меняет
  const page2 = make_page(clone(SETS.g001), { tag: 'b' });
  const rt2 = runtime_on(page2, create_memory_store({ backing }), 'memory');
  const s2 = await rt2.init();
  assert.equal(s2.mode, 'found');
  assert.equal(s2.saved, stored.events.length + 1);
  const ws_other = edit(page2.ws, fact(77));
  await rt2.on_change({ reason: 'add_fact', ws: ws_other });
  assert.equal((await create_memory_store({ backing }).stat()).count, stored.events.length + 1, 'пока не выбрано, хранилище не трогается');
  const cont = await rt2.continue_saved();
  assert.deepEqual([cont.ok, cont.count], [true, stored.events.length + 1]);
  assert.deepEqual(page2.sets, ['restore']);
  const a_saved = analyze(page2.ws, { as_of: page2.ws.as_of });
  const a_orig = analyze(ws2, { as_of: ws2.as_of });
  assert.equal(a_saved.inputs_hash, a_orig.inputs_hash, 'продолжили с того же расчёта, что был до закрытия');
  assert.equal(rt2.status().mode, 'active');
  // следующая правка в «новой вкладке» дописывается к сохранённому
  const ws3 = edit(page2.ws, fact(3));
  page2.ws = ws3;
  await rt2.on_change({ reason: 'add_fact', ws: ws3 });
  assert.equal((await create_memory_store({ backing }).stat()).count, stored.events.length + 2);
});

test('TST-38 REQ-122 восстановление из копии при пустой базе: база очищена браузером → «Восстановить» из файла-копии → хранилище и показ имеют тот же state_hash', async () => {
  const backing = create_memory_backing();
  const page = make_page(clone(SETS.g001));
  const rt = runtime_on(page, create_memory_store({ backing }), 'memory');
  await rt.init();
  const ws1 = edit(page.ws, fact(1));
  page.ws = ws1;
  await rt.on_change({ reason: 'add_fact', ws: ws1 });
  const copy = await rt.export_copy();
  assert.equal(copy.count, rt.status().count);
  const hash_before = hash_of_events((await create_memory_store({ backing }).load()).events);
  assert.equal(copy.state_hash, hash_before, 'файл-копия = состояние хранилища');
  // браузер стёр базу
  backing.data = { events: [], snapshots: [], meta: {} };
  const page2 = make_page(clone(SETS.g001), { tag: 'b' });
  const rt2 = runtime_on(page2, create_memory_store({ backing }), 'memory');
  assert.equal((await rt2.init()).mode, 'fresh', 'база пуста');
  const parsed = inspect_import(copy.text);
  assert.equal(parsed.ok, true);
  const r = await rt2.restore(parsed);
  assert.deepEqual([r.ok, r.kind, r.hash], [true, 'journal', copy.state_hash]);
  const after = await create_memory_store({ backing }).load();
  assert.equal(hash_of_events(after.events), copy.state_hash, 'state_hash в хранилище совпал с файлом');
  assert.deepEqual(after.events.map((e) => e.event_id), parsed.events.map((e) => e.event_id), 'те же записи, а не пересобранные');
  assert.equal(after.meta.last_backup.hash, copy.state_hash, 'восстановление считается копией');
  assert.equal(analyze(page2.ws, { as_of: page2.ws.as_of }).inputs_hash, analyze(ws1, { as_of: ws1.as_of }).inputs_hash, 'показ — тот же расчёт');
  // повторная выгрузка из восстановленного даёт тот же файл
  assert.equal((await rt2.export_copy()).text, copy.text);
  // файл-рабочая область: хранилище не трогается
  const page3 = make_page(clone(SETS['g001-low']), { tag: 'c' });
  const rt3 = runtime_on(page3, create_memory_store({ backing: create_memory_backing() }), 'memory');
  await rt3.init();
  const rw = await rt3.restore(inspect_import(JSON.stringify(SETS.g001)));
  assert.deepEqual([rw.ok, rw.kind], [true, 'workspace']);
  assert.equal(page3.ws.name, SETS.g001.name);
  assert.equal(rt3.status().mode, 'fresh');
  assert.equal((await rt3.restore({ ok: false })).ok, false);
});

test('TST-38 REQ-122 копия до первой записи в хранилище детерминирована: тот же набор — тот же файл и хэш; а после первой правки копия берётся из журнала хранилища', async () => {
  const page = make_page(clone(SETS.g001));
  const rt = runtime_on(page, create_memory_store(), 'memory');
  await rt.init();
  const c1 = await rt.export_copy();
  const c2 = await rt.export_copy();
  assert.equal(c1.text, c2.text);
  assert.equal(c1.state_hash, export_journal_copy(events_of_ws(SETS.g001)).state_hash);
  assert.deepEqual(rt.status().last_backup, { day: '2026-10-05', count: ws_to_events(SETS.g001).length, hash: c1.state_hash }, 'копия учтена и до первой записи');
  // первая правка: набор и правка пишутся; последняя копия сохраняется в метаданных, записей после неё — одна
  const ws1 = edit(page.ws, fact(1));
  page.ws = ws1;
  await rt.on_change({ reason: 'add_fact', ws: ws1 });
  const st = rt.status();
  assert.equal(st.events_since, 1);
  assert.equal(st.last_backup.hash, c1.state_hash);
  const c3 = await rt.export_copy();
  assert.notEqual(c3.state_hash, c1.state_hash);
  assert.equal(rt.status().events_since, 0);
});

test('REQ-097 напоминание на живой среде: 49 правок — не пора, 50-я — пора; после копии счётчик с нуля; 6-й день — не пора, 7-й — пора', async () => {
  const page = make_page(clone(SETS.g001), { today: '2026-10-05' });
  const rt = runtime_on(page, create_memory_store(), 'memory');
  await rt.init();
  let ws = page.ws;
  const push = async (i) => { ws = edit(ws, fact(i)); page.ws = ws; await rt.on_change({ reason: 'add_fact', ws }); };
  for (let i = 1; i <= 49; i++) await push(i);
  let st = rt.status();
  assert.equal(st.events_since, 49);
  assert.deepEqual([st.due.due, st.banner.reasons.includes('due')], [false, false], '49-я запись');
  await push(50);
  st = rt.status();
  assert.equal(st.events_since, 50);
  assert.deepEqual([st.due.due, st.due.reason, st.banner.reasons.includes('due')], [true, 'events', true], '50-я запись');
  // копия: счётчик с нуля, баннер «пора» снят
  await rt.export_copy();
  st = rt.status();
  assert.deepEqual([st.events_since, st.due.due], [0, false]);
  // дни: одна новая запись после копии
  await push(51);
  page.today = '2026-10-11';
  assert.equal(rt.status().due.due, false, '6-й день после копии');
  page.today = '2026-10-12';
  const at7 = rt.status();
  assert.deepEqual([at7.days_since, at7.due.due, at7.due.reason], [7, true, 'days'], '7-й день');
});

test('REQ-122 баннер: persist() = false показан, закреплено — нет; память вкладки — «данные только в памяти»; не закреплено — отчёт «где что лежит» это говорит', async () => {
  const mk = async (persisted, kind, installed = true) => {
    const page = make_page(clone(SETS.g001));
    const rt = create_runtime({
      store: create_memory_store(), store_kind: kind, lock: create_lock({ locks: null }), storage_manager: { persisted: async () => persisted, persist: async () => persisted },
      installed: () => installed, today: () => page.today, ports: page.ports, get_ws: page.get_ws, set_ws: page.set_ws,
    });
    await rt.init();
    return rt.status();
  };
  assert.deepEqual((await mk(false, 'idb')).banner.reasons, ['persist_denied']);
  assert.equal((await mk(true, 'idb')).banner.show, false);
  assert.deepEqual((await mk(true, 'memory')).banner.reasons, ['volatile']);
  assert.deepEqual((await mk(true, 'idb', false)).banner.reasons, ['not_installed']);
  const s = await mk(false, 'idb');
  assert.equal(s.rights.flags.persisted, false);
  assert.ok(s.rights.rows.some((r) => r.key === 'data.rights_pin_no'));
  assert.ok(s.rights.residual.some((r) => r.id === 'browser_clear'));
});

test('REQ-122 пауза: смена набора данных останавливает запись и не затирает сохранённое; «Начать с текущего» стирает сохранённое только по явному вызову', async () => {
  const backing = create_memory_backing();
  const page = make_page(clone(SETS.g001));
  const rt = runtime_on(page, create_memory_store({ backing }), 'memory');
  await rt.init();
  let ws = edit(page.ws, fact(1));
  page.ws = ws;
  await rt.on_change({ reason: 'add_fact', ws });
  const saved = (await create_memory_store({ backing }).stat()).count;
  // набор данных сменили
  const other = clone(SETS['g001-low']);
  page.ws = other;
  await rt.on_change({ reason: 'adopt', ws: other });
  assert.equal(rt.status().mode, 'paused');
  assert.equal(rt.status().pause_reason, 'adopt');
  const ws_b = edit(other, fact(9));
  page.ws = ws_b;
  await rt.on_change({ reason: 'add_fact', ws: ws_b });
  assert.equal((await create_memory_store({ backing }).stat()).count, saved, 'пока на паузе, сохранённое не меняется');
  // явное решение: начать с текущего → хранилище стёрто, режим fresh, запись с первой правки
  const r = await rt.replace_saved();
  assert.equal(r.ok, true);
  assert.equal(rt.status().mode, 'fresh');
  assert.equal((await create_memory_store({ backing }).stat()).count, 0);
  const ws_c = edit(ws_b, fact(10));
  page.ws = ws_c;
  await rt.on_change({ reason: 'add_fact', ws: ws_c });
  assert.equal(rt.status().mode, 'active');
  assert.equal((await create_memory_store({ backing }).stat()).count, ws_to_events(ws_b).length + 1, 'записан текущий набор (низкий остаток) и одна правка, прежнее не примешано');
  assert.equal(analyze(events_to_ws((await create_memory_store({ backing }).load()).events), { as_of: ws_c.as_of }).inputs_hash, analyze(ws_c, { as_of: ws_c.as_of }).inputs_hash);
});

test('REQ-122 сбой записи откатывает запись целиком: в хранилище прежнее, write_failed виден, следующая правка допишет накопленную разность; в журнале хранилища нет дублей', async () => {
  const shared = { fail_in: null };
  const backing = create_memory_backing();
  const store = create_memory_store({ backing, fault: () => { if (shared.fail_in !== null && --shared.fail_in <= 0) { shared.fail_in = null; throw new Error('QuotaExceededError'); } } });
  const page = make_page(clone(SETS.g001));
  const rt = runtime_on(page, store, 'memory');
  await rt.init();
  let ws = edit(page.ws, fact(1));
  page.ws = ws;
  await rt.on_change({ reason: 'add_fact', ws });
  const n1 = (await store.stat()).count;
  shared.fail_in = 1;
  const ws2 = edit(ws, fact(2));
  page.ws = ws2;
  await rt.on_change({ reason: 'add_fact', ws: ws2 });
  assert.equal((await store.stat()).count, n1, 'запись не прошла, прежнее цело');
  assert.equal(rt.status().write_failed, true);
  assert.equal(rt.status().error, 'store_failed');
  const ws3 = edit(ws2, fact(3));
  page.ws = ws3;
  await rt.on_change({ reason: 'add_fact', ws: ws3 });
  assert.equal(rt.status().write_failed, false);
  const data = await store.load();
  assert.equal(data.events.length, n1 + 2, 'обе правки (и пропущенная) записаны по одному разу');
  assert.equal(new Set(data.events.map((e) => e.event_id)).size, data.events.length);
  assert.equal(analyze(events_to_ws(data.events), { as_of: ws3.as_of }).inputs_hash, analyze(ws3, { as_of: ws3.as_of }).inputs_hash);
});

test('REQ-122 две вкладки на одном хранилище под замком: обе «пустые» — набор данных записан один раз, вторая видит сохранённое и не дублирует; правки обеих вкладок без потерь', async () => {
  const backing = create_memory_backing();
  const lock = create_lock({ name: 'runway-test-' + Math.random().toString(36).slice(2) });
  const pa = make_page(clone(SETS.g001), { tag: 'a' });
  const pb = make_page(clone(SETS.g001), { tag: 'b' });
  const A = runtime_on(pa, create_memory_store({ backing }), 'memory', { lock });
  const B = runtime_on(pb, create_memory_store({ backing }), 'memory', { lock });
  await A.init();
  await B.init();
  assert.deepEqual([A.status().mode, B.status().mode], ['fresh', 'fresh']);
  const wa = edit(pa.ws, fact(1));
  const wb = edit(pb.ws, fact(2));
  pa.ws = wa; pb.ws = wb;
  await Promise.all([A.on_change({ reason: 'add_fact', ws: wa }), B.on_change({ reason: 'add_fact', ws: wb })]);
  const modes = [A.status().mode, B.status().mode].sort();
  assert.deepEqual(modes, ['active', 'found'], 'одна вкладка записала, другая увидела чужое и не затёрла');
  const data = await create_memory_store({ backing }).load();
  const base = ws_to_events(SETS.g001).length;
  assert.equal(data.events.length, base + 1, 'набор данных записан один раз');
  assert.equal(new Set(data.events.map((e) => e.event_id)).size, data.events.length, 'без дублей');
  assert.deepEqual(data.events.map((e) => e.seq), data.events.map((_, i) => i + 1), 'seq без дыр');
});

test('REQ-098 erase на среде выполнения: квитанция со счётчиками, запись отключена, чтение пусто; повтор без ошибки', async () => {
  const backing = create_memory_backing();
  const storage = fake_storage({ 'runway-demo-lang': 'en', keep: '1' });
  const page = make_page(clone(SETS.g001));
  const rt = runtime_on(page, create_memory_store({ backing }), 'memory', { erase_ports: { storage } });
  await rt.init();
  const ws = edit(page.ws, fact(1));
  page.ws = ws;
  await rt.on_change({ reason: 'add_fact', ws });
  const prev = rt.erase_preview();
  assert.equal(prev.operations, ws.facts.length);
  assert.equal(prev.events, rt.status().count);
  const receipt = await rt.erase();
  assert.deepEqual([receipt.erased, receipt.copies_warning, receipt.date], [true, true, '2026-10-05']);
  assert.equal(receipt.counts.events, prev.events);
  assert.equal(receipt.counts.rules, SETS.g001.rules.length);
  assert.deepEqual(await create_memory_store({ backing }).load(), { events: [], snapshots: [], meta: {} });
  assert.deepEqual([...storage.map.keys()], ['keep']);
  assert.equal(rt.status().mode, 'erased');
  // после удаления правки в хранилище не попадают
  const ws2 = edit(ws, fact(2));
  page.ws = ws2;
  await rt.on_change({ reason: 'add_fact', ws: ws2 });
  assert.equal((await create_memory_store({ backing }).stat()).count, 0, 'после eraseAll запись отключена');
  const again = await rt.erase();
  assert.equal(again.erased, true);
});

test('REQ-122 хранилище недоступно: режим failed с кодом, работа страницы не ломается; отчёт и баннер отражают «только память»', async () => {
  const page = make_page(clone(SETS.g001));
  const bad = { kind: 'memory', stat: async () => { throw new StoreError('store_unavailable', { reason: 'down' }); } };
  const rt = runtime_on(page, bad, 'memory');
  const s = await rt.init();
  assert.deepEqual([s.mode, s.error], ['failed', 'store_unavailable']);
  const ws = edit(page.ws, fact(1));
  await rt.on_change({ reason: 'add_fact', ws });
  assert.equal(rt.status().mode, 'failed');
  assert.equal((await rt.continue_saved()).ok, false);
});

test('REQ-122 localStorage-хранилище на среде выполнения: журнал переживает «перезагрузку» (новый storage-объект поверх тех же ключей)', async () => {
  const storage = fake_storage();
  const page = make_page(clone(SETS.g001));
  const rt = runtime_on(page, create_local_store({ storage }), 'local');
  await rt.init();
  const ws = edit(page.ws, fact(1));
  page.ws = ws;
  await rt.on_change({ reason: 'add_fact', ws });
  assert.ok(storage.getItem('runway-store/1').length > 1000);
  const page2 = make_page(clone(SETS.g001), { tag: 'b' });
  const rt2 = runtime_on(page2, create_local_store({ storage }), 'local');
  assert.equal((await rt2.init()).mode, 'found');
  assert.equal((await rt2.continue_saved()).ok, true);
  assert.equal(analyze(page2.ws, { as_of: ws.as_of }).inputs_hash, analyze(ws, { as_of: ws.as_of }).inputs_hash);
});

test('REQ-122 оповещение вкладок: запись другой вкладки видна как «foreign», «Обновить из хранилища» подтягивает её; очистка другой вкладкой ставит запись на паузу', async () => {
  const peers = [];
  class FakeBC {
    constructor(name) { this.name = name; this.onmessage = null; peers.push(this); }
    postMessage(data) { for (const p of peers) if (p !== this && p.name === this.name) p.onmessage?.({ data }); }
    close() {}
  }
  const { create_sync_channel } = await import('../demo/store.mjs');
  const backing = create_memory_backing();
  const lock = create_lock({ name: 'runway-test-' + Math.random().toString(36).slice(2) });
  const pa = make_page(clone(SETS.g001), { tag: 'a' });
  const pb = make_page(clone(SETS.g001), { tag: 'b' });
  const A = runtime_on(pa, create_memory_store({ backing }), 'memory', { lock, channel: create_sync_channel({ BroadcastChannel: FakeBC, tab_id: 'tab-a' }) });
  const B = runtime_on(pb, create_memory_store({ backing }), 'memory', { lock, channel: create_sync_channel({ BroadcastChannel: FakeBC, tab_id: 'tab-b' }) });
  await A.init();
  const wa = edit(pa.ws, fact(1));
  pa.ws = wa;
  await A.on_change({ reason: 'add_fact', ws: wa });
  await B.init(); // вкладка B открыта после записи A: видит сохранённое
  assert.equal((await B.continue_saved()).ok, true);
  assert.equal(B.status().foreign, false);
  const wa2 = edit(wa, fact(2));
  pa.ws = wa2;
  await A.on_change({ reason: 'add_fact', ws: wa2 });
  assert.equal(B.status().foreign, true, 'B узнала о записи A');
  assert.equal((await B.reload_foreign()).ok, true);
  assert.equal(B.status().foreign, false);
  assert.equal(analyze(pb.ws, { as_of: wa2.as_of }).inputs_hash, analyze(wa2, { as_of: wa2.as_of }).inputs_hash, 'B показывает то же, что A');
  // A стирает всё → B останавливает запись, чтобы не воскресить стёртое
  await A.erase();
  assert.equal(B.status().mode, 'paused');
  assert.equal(B.status().pause_reason, 'foreign_reset');
  const wb = edit(pb.ws, fact(9));
  pb.ws = wb;
  await B.on_change({ reason: 'add_fact', ws: wb });
  assert.equal((await create_memory_store({ backing }).stat()).count, 0, 'после очистки другой вкладкой запись не идёт');
});
