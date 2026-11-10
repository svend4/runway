// backup.test.mjs — когда напомнить о файле-копии и какие баннеры показать (FP-05): REQ-097, REQ-122, TST-38.
// Значения порогов (50 записей, 7 дней) сверяются с engine/vocab.json — гипотезы X10 / C-096.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  BACKUP_DEFAULTS, backup_params, backup_due, backup_counters, make_backup_record, backup_banner, BANNER_REASONS,
} from '../demo/backup.mjs';

const VOCAB = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../engine/vocab.json', import.meta.url)), 'utf8'));

test('REQ-097 значения по умолчанию — зеркало vocab.json: backup.remind_events = 50, backup.remind_days = 7 (гипотезы)', () => {
  assert.equal(BACKUP_DEFAULTS['backup.remind_events'], VOCAB.params['backup.remind_events'].default);
  assert.equal(BACKUP_DEFAULTS['backup.remind_days'], VOCAB.params['backup.remind_days'].default);
  assert.equal(VOCAB.params['backup.remind_events'].default, 50);
  assert.equal(VOCAB.params['backup.remind_days'].default, 7);
  assert.equal(VOCAB.params['backup.remind_events'].hypothesis, true);
  assert.deepEqual(backup_params(undefined), { remind_events: 50, remind_days: 7 });
  assert.deepEqual(backup_params({ 'backup.remind_events': 20, 'backup.remind_days': 3 }), { remind_events: 20, remind_days: 3 });
  assert.deepEqual(backup_params({ 'backup.remind_events': 0, 'backup.remind_days': 'x' }), { remind_events: 50, remind_days: 7 }, 'негодное значение — по умолчанию');
});

test('REQ-097 backup_due: срабатывает на 50-й записи без копии, не срабатывает на 49-й', () => {
  const p = backup_params(undefined);
  assert.equal(backup_due({ events_since: 49, days_since: 0 }, p).due, false, '49 записей');
  const at50 = backup_due({ events_since: 50, days_since: 0 }, p);
  assert.deepEqual([at50.due, at50.reason, at50.by_events], [true, 'events', true], '50-я запись');
  assert.equal(backup_due({ events_since: 51, days_since: 0 }, p).due, true);
});

test('REQ-097 backup_due: срабатывает на 7-й день без копии, не срабатывает на 6-й; день без новых записей напоминания не даёт', () => {
  const p = backup_params(undefined);
  assert.equal(backup_due({ events_since: 3, days_since: 6 }, p).due, false, '6-й день');
  const at7 = backup_due({ events_since: 3, days_since: 7 }, p);
  assert.deepEqual([at7.due, at7.reason, at7.by_days], [true, 'days', true], '7-й день');
  assert.equal(backup_due({ events_since: 0, days_since: 30 }, p).due, false, 'копировать нечего');
  assert.equal(backup_due({ events_since: 60, days_since: 9 }, p).reason, 'events', 'обе причины: первой названа «записи»');
});

test('REQ-097 backup_due: пороги из ws.params; мусор во входе не ломает', () => {
  const p = backup_params({ 'backup.remind_events': 10, 'backup.remind_days': 2 });
  assert.equal(backup_due({ events_since: 10, days_since: 0 }, p).due, true);
  assert.equal(backup_due({ events_since: 9, days_since: 1 }, p).due, false);
  assert.equal(backup_due({ events_since: 1, days_since: 2 }, p).due, true);
  assert.equal(backup_due(undefined).due, false);
  assert.equal(backup_due({ events_since: Number.NaN, days_since: -5 }).due, false);
});

test('REQ-097 backup_counters: записи и дни считаются от последней копии, а без копии — от начала записи в хранилище', () => {
  // копии не было: 47 записей набора данных на старте (origin), сейчас 97, создано 2026-10-01, сегодня 2026-10-08
  assert.deepEqual(backup_counters({ count: 97, origin_count: 47, created_day: '2026-10-01', today: '2026-10-08' }), { events_since: 50, days_since: 7 });
  assert.deepEqual(backup_counters({ count: 96, origin_count: 47, created_day: '2026-10-02', today: '2026-10-08' }), { events_since: 49, days_since: 6 });
  // копия была на 80-й записи 2026-10-05
  assert.deepEqual(backup_counters({ count: 100, origin_count: 47, created_day: '2026-10-01', last_backup: { day: '2026-10-05', count: 80 }, today: '2026-10-08' }), { events_since: 20, days_since: 3 });
  // пустые и негодные входы
  assert.deepEqual(backup_counters({ count: 0, today: '2026-10-08' }), { events_since: 0, days_since: 0 });
  assert.deepEqual(backup_counters({ count: 5, origin_count: 9, today: 'вчера', created_day: '2026-10-01' }), { events_since: 0, days_since: 0 });
});

test('REQ-097 связка: 49-я запись и 6-й день не напоминают, 50-я и 7-й — напоминают (счётчики → backup_due)', () => {
  const run = (count, today) => backup_due(backup_counters({ count, origin_count: 10, created_day: '2026-10-01', today }), backup_params(undefined));
  assert.equal(run(10 + 49, '2026-10-02').due, false);
  assert.equal(run(10 + 50, '2026-10-02').due, true);
  assert.equal(run(10 + 5, '2026-10-07').due, false, '6-й день');
  assert.equal(run(10 + 5, '2026-10-08').due, true, '7-й день');
});

test('REQ-097 make_backup_record: только день, число записей и хэш; негодное — RangeError', () => {
  const hash = 'a'.repeat(64);
  assert.deepEqual(make_backup_record({ day: '2026-10-05', count: 3, hash }), { day: '2026-10-05', count: 3, hash });
  assert.throws(() => make_backup_record({ day: '05.10.2026', count: 3, hash }), RangeError);
  assert.throws(() => make_backup_record({ day: '2026-10-05', count: -1, hash }), RangeError);
  assert.throws(() => make_backup_record({ day: '2026-10-05', count: 3, hash: 'xyz' }), RangeError);
});

test('REQ-122 баннер «сделайте файл-копию»: при persist() = false показан; закреплено и установлено, данные в IndexedDB, копия не нужна — не показан', () => {
  const denied = backup_banner({ due: false, persisted: false, installed: true, store_kind: 'idb' });
  assert.deepEqual([denied.show, denied.reasons], [true, ['persist_denied']]);
  const ok = backup_banner({ due: false, persisted: true, installed: true, store_kind: 'idb' });
  assert.deepEqual([ok.show, ok.reasons], [false, []]);
  assert.deepEqual(backup_banner({ due: false, persisted: true, installed: false, store_kind: 'idb' }).reasons, ['not_installed'], 'не установлено как приложение');
  assert.deepEqual(backup_banner({ due: false, persisted: true, installed: null, store_kind: 'idb' }).reasons, [], 'неизвестно «установлено» — не пугаем');
  assert.deepEqual(backup_banner({ due: false, persisted: null, installed: true, store_kind: 'local' }).reasons, ['persist_unknown'], 'браузер не ответил');
  assert.deepEqual(backup_banner({ due: true, persisted: false, installed: false, store_kind: 'memory' }).reasons, ['due', 'volatile', 'persist_denied', 'not_installed'], 'порядок по важности');
  assert.deepEqual([...BANNER_REASONS], ['due', 'volatile', 'persist_denied', 'persist_unknown', 'not_installed']);
});
