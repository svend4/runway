// rights.test.mjs — вычисляемый отчёт «где что лежит» (FP-05): REQ-125, TST-56 (запрещённые формулировки), IDEA-80.
// Отчёт зависит от состояния: есть ли копия, её возраст, число записей, закреплено ли хранилище, вид хранилища.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { rights_report, copy_age_days, OUTBOUND_V1 } from '../demo/rights.mjs';
import catalog from '../demo/i18n/data.mjs';

const VOCAB = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../engine/vocab.json', import.meta.url)), 'utf8'));
const norm = (s) => s.toLowerCase().replace(/ё/g, 'е');
const row = (rep, id) => rep.rows.find((r) => r.id === id);

test('REQ-125 rights.report() вычисляется из состояния: копии нет → «копии нет», все записи только на устройстве', () => {
  const rep = rights_report({ store_kind: 'idb', persisted: true, installed: true, count: 120, today: '2026-10-05' });
  assert.equal(rep.flags.has_copy, false);
  assert.equal(rep.flags.copy_age_days, null);
  assert.equal(rep.flags.entries, 120);
  assert.deepEqual(row(rep, 'copy'), { id: 'copy', key: 'data.rights_copy_none', params: { n: 120 } });
  assert.equal(row(rep, 'device').key, 'data.rights_device_idb');
  assert.deepEqual(row(rep, 'device').params, { n: 120 });
  assert.ok(rep.residual.some((r) => r.id === 'device_loss' && r.key === 'data.rights_risk_device_loss_nocopy'), 'потеря устройства без копии названа отдельно');
});

test('REQ-125 есть копия → возраст в днях и число записей после неё; те же данные, другое состояние — другой отчёт', () => {
  const last = { day: '2026-10-01', count: 100 };
  const rep = rights_report({ store_kind: 'idb', persisted: true, count: 130, last_backup: last, today: '2026-10-05' });
  assert.equal(rep.flags.has_copy, true);
  assert.equal(rep.flags.copy_age_days, 4);
  assert.deepEqual(row(rep, 'copy'), { id: 'copy', key: 'data.rights_copy_yes', params: { day: '2026-10-01', age: 4, n_new: 30 } });
  assert.ok(rep.residual.some((r) => r.key === 'data.rights_risk_device_loss'));
  assert.ok(!rep.residual.some((r) => r.key === 'data.rights_risk_device_loss_nocopy'));
  // тот же журнал, позже: возраст растёт
  assert.equal(rights_report({ store_kind: 'idb', persisted: true, count: 130, last_backup: last, today: '2026-10-12' }).flags.copy_age_days, 11);
  // явное число новых записей важнее вычитания
  assert.equal(rights_report({ count: 130, last_backup: last, new_since_copy: 7, today: '2026-10-05' }).flags.new_since_copy, 7);
  assert.equal(copy_age_days(last, 'вчера'), null);
  assert.equal(copy_age_days(null, '2026-10-05'), null);
});

test('REQ-125 закреплено ли хранилище: true / false / неизвестно — три разные строки; без закрепления добавлен риск «очистка браузером»', () => {
  const keys = [true, false, null].map((p) => row(rights_report({ store_kind: 'idb', persisted: p, count: 1 }), 'pin').key);
  assert.deepEqual(keys, ['data.rights_pin_yes', 'data.rights_pin_no', 'data.rights_pin_unknown']);
  assert.ok(!rights_report({ persisted: true }).residual.some((r) => r.id === 'browser_clear'));
  assert.ok(rights_report({ persisted: false }).residual.some((r) => r.id === 'browser_clear'));
  assert.ok(rights_report({}).residual.some((r) => r.id === 'browser_clear'), 'неизвестно — тоже риск');
});

test('REQ-125 вид хранилища: IndexedDB, localStorage, память вкладки и «не открыто» различаются', () => {
  const k = ['idb', 'local', 'memory', null].map((kind) => row(rights_report({ store_kind: kind, count: 3 }), 'device').key);
  assert.deepEqual(k, ['data.rights_device_idb', 'data.rights_device_local', 'data.rights_device_memory', 'data.rights_device_none']);
});

test('REQ-125 отчёт v1: ассистенту уходит ничего, наружу ничего кроме оболочки; остатки: потеря устройства, расширения, хранилище и копия не зашифрованы', () => {
  const rep = rights_report({ store_kind: 'idb', persisted: true, count: 5 });
  assert.deepEqual(rep.outbound, []);
  assert.deepEqual([...OUTBOUND_V1], []);
  assert.equal(row(rep, 'assistant').key, 'data.rights_assistant_none');
  assert.equal(row(rep, 'third').key, 'data.rights_third_shell');
  const ids = rep.residual.map((r) => r.id);
  for (const need of ['device_loss', 'extensions', 'not_encrypted']) assert.ok(ids.includes(need), need);
  // разделы отчёта заданы
  assert.deepEqual(rep.rows.map((r) => r.id), ['device', 'pin', 'copy', 'assistant', 'third']);
  // отчёт не мутирует вход и не зависит от мусора
  assert.equal(rights_report({ count: -4 }).flags.entries, 0);
  assert.equal(rights_report(undefined).flags.entries, 0);
});

test('REQ-125 TST-56 каждый ключ отчёта есть в каталоге RU и EN, а формулировки не содержат запрещённых обещаний (vocab.json → forbidden_phrases)', () => {
  const states = [
    {}, { store_kind: 'idb', persisted: true, count: 3 }, { store_kind: 'local', persisted: false, count: 3, last_backup: { day: '2026-10-01', count: 1 }, today: '2026-10-05' },
    { store_kind: 'memory', persisted: null, count: 9 },
  ];
  const keys = new Set();
  for (const s of states) { const rep = rights_report(s); for (const r of [...rep.rows, ...rep.residual]) keys.add(r.key); }
  for (const k of ['data.rights_title', 'data.rights_residual']) keys.add(k);
  for (const k of keys) {
    assert.ok(typeof catalog.ru[k] === 'string' && typeof catalog.en[k] === 'string', `нет строки ${k}`);
    for (const phrase of VOCAB.forbidden_phrases) {
      assert.ok(!norm(catalog.ru[k]).includes(norm(phrase)) && !norm(catalog.en[k]).includes(norm(phrase)), `${k}: запрещено «${phrase}»`);
    }
  }
  // плейсхолдеры отчёта подставляются (в строке нет «{…}» после подстановки параметров состояния «с копией»)
  const rep = rights_report({ store_kind: 'idb', persisted: true, count: 130, last_backup: { day: '2026-10-01', count: 100 }, today: '2026-10-05' });
  for (const r of rep.rows) {
    const text = catalog.ru[r.key].replace(/\{(\w+)\}/g, (_, n) => { assert.ok(n in r.params, `${r.key}: параметр ${n}`); return String(r.params[n]); });
    assert.ok(!text.includes('{'), r.key);
  }
  // отчёт говорит про остаточные риски словами канона (REQ-125)
  assert.match(catalog.ru['data.rights_third_shell'], /ничего, кроме загрузки оболочки/);
  assert.match(catalog.ru['data.rights_risk_not_encrypted'], /не зашифрованы/);
  assert.match(catalog.ru['data.rights_risk_extensions'], /расширения/i);
});
