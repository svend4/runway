// engine_stamp.test.mjs — FP-17, REQ-016: версия движка в снимке журнала и в файле-копии; расхождение версий — предупреждение, а не отказ.
// Покрывает: снимок журнала несёт engine_version (и take_snapshot, и снимок самого журнала, и экспорт); снимок ДРУГОЙ версии при открытии не используется и
// пересобирается из записей, записи журнала не меняются; снимок без метки (сохранён до FP-17) принимается; fold(снимок, хвост) = fold(журнал) на 10^3 случайных
// журналах при любой метке; снимок под хранилищем (store.mjs) переживает круг «записать — перечитать» вместе с меткой; файл-копия несёт engine_version и
// сравнивается с текущей версией (engine_version_status): older / newer / different — предупреждение, unknown — заметка; G-001 не меняется.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { ENGINE_VERSION, canon, state_hash, analyze } from '../engine/index.mjs';
import { engine_version_status } from '../engine/io_readonly.mjs';
import {
  create_journal, open_journal, take_snapshot, full_fold, fold_with_snapshot, ports_from_gen,
} from '../demo/journal_log.mjs';
import { make_id_gen, seeded_ports } from '../demo/ids.mjs';
import { ws_to_events } from '../demo/ws_bridge.mjs';
import { export_journal_copy, events_of_ws, inspect_import } from '../demo/data_actions.mjs';
import { create_memory_store, create_memory_backing, create_lock, open_persistent } from '../demo/store.mjs';
import { make_rng } from './helpers.mjs';
import { random_journal } from './journal_gen.mjs';

const G = JSON.parse(fs.readFileSync(new URL('../data/g001.json', import.meta.url), 'utf8'));
const OTHER = '0.0.9';
const ports = (seed = 1) => ports_from_gen(make_id_gen(seeded_ports({ seed })));

// ── метка в снимке ───────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-016 FP-17: снимок журнала несёт engine_version — и снимок самого журнала, и функция take_snapshot; метку можно задать', () => {
  const events = ws_to_events(G);
  assert.equal(take_snapshot(events, 20).engine_version, ENGINE_VERSION);
  assert.equal(take_snapshot(events, 20, '3.4.5').engine_version, '3.4.5');
  const j = create_journal({ events, snapshot_every: 10, ports: ports() });
  const sn = j.take_snapshot();
  assert.equal(sn.engine_version, ENGINE_VERSION);
  assert.deepEqual(j.snapshot_info(), { engine_version: ENGINE_VERSION, held: [{ count: events.length, engine_version: ENGINE_VERSION }], stale: [] });
  assert.equal(j.export().snapshots.every((x) => x.engine_version === ENGINE_VERSION), true, 'в данные для хранилища метка уходит вместе со снимком');
  const custom = create_journal({ events, snapshot_every: 10, engine_version: '9.9.9', ports: ports() });
  assert.equal(custom.take_snapshot().engine_version, '9.9.9', 'журнал ведётся под заданную версию');
});

test('REQ-016 FP-17: автоснимок после записей тоже помечен; новый снимок ложится по обычному правилу «хвост достиг snapshot_every»', () => {
  const j = create_journal({ snapshot_every: 3, keep_snapshots: 2, ports: ports(2) });
  for (let i = 0; i < 7; i++) j.append('anchor.set', { anchor_id: 'a' + i, account_id: 'x', date: '2026-10-04', amount_minor: i + 1 });
  const info = j.snapshot_info();
  assert.ok(info.held.length >= 1 && info.held.length <= 2);
  assert.ok(info.held.every((x) => x.engine_version === ENGINE_VERSION));
  assert.deepEqual(info.stale, []);
});

// ── снимок другой версии ─────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-016 FP-17: снимок ДРУГОЙ версии движка не используется, состояние пересобирается из записей и равно полной свёртке; записи журнала не меняются', () => {
  const events = ws_to_events(G);
  const before = canon(events);
  const snap = { ...take_snapshot(events, 30), engine_version: OTHER };
  const j = open_journal({ events, snapshots: [snap] });
  assert.deepEqual(j.snapshot_info(), { engine_version: ENGINE_VERSION, held: [], stale: [{ count: 30, engine_version: OTHER }] });
  const st = j.state();
  assert.equal(st.used_snapshot, false, 'чужую арифметику не берём');
  assert.equal(canon(st.state), canon(full_fold(events)));
  assert.equal(j.state_hash(), state_hash(full_fold(events)));
  assert.equal(canon(j.events()), before, 'записи не изменились');
  // тот же снимок под своей версией работает
  const own = open_journal({ events, snapshots: [{ ...snap, engine_version: ENGINE_VERSION }] });
  assert.equal(own.state().used_snapshot, true);
  assert.deepEqual(own.snapshot_info().stale, []);
});

test('REQ-016 FP-17: после открытия со снимком другой версии первая же запись при достижении порога кладёт новый снимок текущей версии; fold(снимок, хвост) = fold(журнал)', () => {
  const all = ws_to_events(G);
  const head = all.slice(0, 20);
  const stale = { ...take_snapshot(head, 20), engine_version: OTHER };
  const j = open_journal({ events: head, snapshots: [stale] }, { snapshot_every: 5, ports: ports(3) });
  assert.equal(j.snapshots().length, 0, 'чужого снимка в рабочем наборе нет');
  for (let i = 0; i < 6; i++) j.append('anchor.set', { anchor_id: 'n' + i, account_id: 'acc_main', date: '2026-10-04', amount_minor: i });
  const info = j.snapshot_info();
  assert.deepEqual(info.stale, [{ count: 20, engine_version: OTHER }], 'отброшенное при открытии помнится');
  assert.ok(info.held.length >= 1 && info.held.every((x) => x.engine_version === ENGINE_VERSION && x.count > 20), 'новый снимок — текущей версии');
  assert.equal(canon(j.state().state), canon(full_fold(j.events())));
  const sn = j.snapshots().at(-1);
  assert.equal(canon(fold_with_snapshot(sn, j.events()).state), canon(full_fold(j.events())));
});

test('REQ-016 FP-17: снимок без метки (сохранён до FP-17) принимается как раньше; метка не строка — тоже «нет метки»; сверка state_hash снимка другой версии не требуется', () => {
  const events = ws_to_events(G);
  const legacy = take_snapshot(events, 25);
  delete legacy.engine_version;
  const j = open_journal({ events, snapshots: [legacy] });
  assert.equal(j.state().used_snapshot, true);
  assert.deepEqual(j.snapshot_info().held, [{ count: 25, engine_version: null }]);
  const odd = open_journal({ events, snapshots: [{ ...legacy, engine_version: 5 }] });
  assert.deepEqual(odd.snapshot_info().held, [{ count: 25, engine_version: null }], 'не строка — метки нет');
  // хэш снимка чужой версии может быть другим: verify его не проверяет, а снимок не используется
  const wrong_hash = { ...take_snapshot(events, 25), engine_version: OTHER, state_hash: 'f'.repeat(64) };
  assert.doesNotThrow(() => open_journal({ events, snapshots: [wrong_hash] }, { verify: true }));
  // а снимок своей версии с неверным хэшем отвергается, как и прежде
  assert.throws(() => open_journal({ events, snapshots: [{ ...take_snapshot(events, 25), state_hash: 'f'.repeat(64) }] }, { verify: true }), (e) => e.code === 'E_SCHEMA');
  // форма снимка проверяется и у чужой версии
  assert.throws(() => open_journal({ events, snapshots: [{ count: 'x', engine_version: OTHER }] }), (e) => e.code === 'E_SCHEMA');
  assert.throws(() => open_journal({ events, snapshots: [{ ...take_snapshot(events, 25), engine_version: OTHER, seq: 999 }] }), (e) => e.code === 'E_SCHEMA', 'снимок не от этого журнала');
});

test('TST-16 REQ-016 FP-17: fold(снимок, хвост) = fold(журнал) на 1000 случайных журналах (seed 17) при любой метке снимка; чужая версия снимок не использует', () => {
  const rng = make_rng(17);
  let journals = 0;
  let stale_checked = 0;
  let own_fast = 0;
  for (let j = 0; journals < 1000 && j < 1600; j++) {
    const events = random_journal(rng, rng.int(4, 34));
    let full;
    try { full = full_fold(events); } catch { continue; }
    journals += 1;
    const c = rng.int(1, events.length);
    let snap;
    try { snap = take_snapshot(events, c); } catch { continue; }
    for (const stamp of [ENGINE_VERSION, OTHER, undefined]) {
      const sn = { ...snap };
      if (stamp === undefined) delete sn.engine_version; else sn.engine_version = stamp;
      const jr = open_journal({ events, snapshots: [sn] });
      const st = jr.state();
      assert.equal(canon(st.state), canon(full), `журнал #${j}, метка ${String(stamp)}`);
      if (stamp === OTHER) {
        stale_checked += 1;
        assert.equal(st.used_snapshot, false, 'чужая метка — полная свёртка');
        assert.equal(jr.snapshot_info().stale.length, 1);
      } else if (st.used_snapshot) own_fast += 1;
    }
  }
  assert.equal(journals, 1000);
  assert.equal(stale_checked, 1000);
  assert.ok(own_fast > 400, 'снимок своей версии применялся: ' + own_fast);
});

// ── хранилище: метка переживает запись и чтение ──────────────────────────────────────────────────────────────────────

test('REQ-016 FP-17 хранилище: снимок с меткой записывается и читается; при чтении «чужой» снимок отбрасывается, журнал открывается и пишется дальше', async () => {
  const backing = create_memory_backing();
  const store = create_memory_store({ backing });
  const lock = create_lock({ locks: null });
  const pj = await open_persistent({ store, lock, ports: ports(4), snapshot_every: 3 });
  const specs = Array.from({ length: 9 }, (_, i) => ({ type: 'anchor.set', payload: { anchor_id: 'a' + i, account_id: 'x', date: '2026-10-04', amount_minor: i + 1 } }));
  await pj.write(specs);
  const stored = await store.load();
  assert.ok(stored.snapshots.length >= 1);
  assert.ok(stored.snapshots.every((s) => s.engine_version === ENGINE_VERSION), 'метка легла в хранилище');
  // «обновление движка»: снимки в хранилище помечены прежней версией
  backing.data = { ...backing.data, snapshots: backing.data.snapshots.map((s) => ({ ...s, engine_version: OTHER })) };
  const pj2 = await open_persistent({ store: create_memory_store({ backing }), lock, ports: ports(5), snapshot_every: 3 });
  const info = pj2.journal.snapshot_info();
  assert.ok(info.stale.length >= 1 && info.stale.every((x) => x.engine_version === OTHER));
  assert.deepEqual(info.held, []);
  assert.equal(pj2.journal.state_hash(), state_hash(full_fold(pj2.journal.events())));
  await pj2.write([{ type: 'anchor.set', payload: { anchor_id: 'z', account_id: 'x', date: '2026-10-04', amount_minor: 5 } }]);
  const again = await create_memory_store({ backing }).load();
  assert.equal(again.events.length, 10, 'запись после пересборки прошла, записи прежние на месте');
  assert.ok(again.snapshots.some((s) => s.engine_version === ENGINE_VERSION), 'новый снимок текущей версии');
});

// ── файл-копия ───────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-016 FP-17: файл-копия несёт engine_version; inspect_import возвращает сравнение с текущей версией; совпадение — без предупреждения', () => {
  const copy = export_journal_copy(events_of_ws(G));
  assert.equal(JSON.parse(copy.text).engine_version, ENGINE_VERSION);
  const parsed = inspect_import(copy.text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.engine_version, ENGINE_VERSION);
  assert.deepEqual(parsed.engine, { status: 'same', warn: false, file: ENGINE_VERSION, current: ENGINE_VERSION });
  assert.equal(parsed.read_only, undefined, 'обычный файл открывается как раньше');
});

for (const [file_version, status, warn] of [['0.0.1', 'older', true], ['9.0.0', 'newer', true], ['0.1.0-rc1', 'different', true], ['abc', 'different', true], [undefined, 'unknown', false], ['unversioned', 'unknown', false]]) {
  test(`REQ-016 FP-17: версия движка в файле «${String(file_version)}» против текущей — ${status}; файл открывается (предупреждение, а не отказ), хэш состояния тот же`, () => {
    const copy = export_journal_copy(events_of_ws(G));
    const obj = JSON.parse(copy.text);
    if (file_version === undefined) delete obj.engine_version; else obj.engine_version = file_version;
    const parsed = inspect_import(canon(obj));
    assert.equal(parsed.ok, true, 'не отказ');
    assert.equal(parsed.kind, 'journal');
    assert.equal(parsed.engine.status, status);
    assert.equal(parsed.engine.warn, warn);
    assert.equal(parsed.hash, copy.state_hash, 'состояние то же, что в исходной копии');
    assert.equal(analyze(parsed.ws, { as_of: parsed.ws.as_of }).series.plan.close.at(-1), analyze(G, { as_of: G.as_of }).series.plan.close.at(-1), 'числа G-001 не меняются');
  });
}

test('REQ-016 FP-17 engine_version_status: сравнение X.Y.Z по числам (0.10.0 новее 0.9.0), хвост сборки — different, граничные значения', () => {
  const s = (f, c = '0.1.0') => engine_version_status(f, c);
  assert.deepEqual(s('0.1.0'), { status: 'same', warn: false, file: '0.1.0', current: '0.1.0' });
  assert.equal(s('0.9.0', '0.10.0').status, 'older');
  assert.equal(s('0.10.0', '0.9.0').status, 'newer');
  assert.equal(s('1.0.0', '0.99.99').status, 'newer');
  assert.equal(s('0.1.0+build5').status, 'different');
  assert.equal(s('0.1.1').status, 'newer');
  assert.equal(s('0.0.9').status, 'older');
  for (const none of [null, undefined, '', 'unversioned', 5, {}]) assert.deepEqual(s(none), { status: 'unknown', warn: false, file: null, current: '0.1.0' });
  assert.equal(s('x'.repeat(100)).file.length, 40, 'длинная строка из файла обрезается');
});
