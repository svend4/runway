// sinking_report.test.mjs — FP-08: отчёт по накоплениям (TST-20, TST-21, TST-22; REQ-069, REQ-070, REQ-071; ALG-05, C-030).
// План взносов, «N взносов на сумму X» (то же число несёт W_RESERVE_BEHIND), «цель достигнута», «до срока нет дат взноса», пакетное подтверждение, пул.
// Запуск: node --test --test-timeout=120000 --test-concurrency=1 tests/sinking_report.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { analyze } from '../engine/index.mjs';
import { sinking_plan, reserve_behind_detail, confirm_rows, pool_split_report, contribution_id } from '../engine/sinking_report.mjs';
import { throws_code } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const G = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'data', 'g001.json'), 'utf8'));
const base_reserve = { kind: 'sinking', currency: 'EUR', funded_as_of: '2026-10-04', backed_by_account_id: null, cadence: { freq: 'M', day: 1 }, mode: 'refill_to_target' };
const VAC = { ...base_reserve, reserve_id: 'RES-VAC', name: 'Отпуск', funded_start_minor: 9500, target_minor: 180000, due_date: '2027-07-01' };
const BDAY = { ...base_reserve, reserve_id: 'RES-BDAY', name: 'День рождения', funded_start_minor: 4000, target_minor: 25000, due_date: '2027-03-15' };
const with_reserves = (rs, over = {}) => ({ ...G, reserves: [G.reserves[0], ...rs], ...over });
const amounts = (p) => p.rows.map((r) => r.amount_minor);

test('TST-20 REQ-069: страховка — цель 60000, funded 0, пять дат → [12000 ×5]; даты 1-го числа, срок в число дат не входит', () => {
  const p = sinking_plan(G, 'RES-INS');
  assert.deepEqual(amounts(p), [12000, 12000, 12000, 12000, 12000]);
  assert.deepEqual(p.rows.map((r) => r.date), ['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01', '2027-03-01']);
  assert.equal(p.n, 5);
  assert.equal(p.total_minor, 60000);
  assert.equal(p.status, 'ok');
  assert.equal(p.shortfall_minor, 0);
});

test('TST-21 REQ-069: отпуск — цель 180000, funded 9500, срок 2027-07-01, восемь дат → [21313 ×4, 21312 ×4], Σ 170500; день рождения → [4200 ×5]', () => {
  const ws = with_reserves([VAC, BDAY]);
  const v = sinking_plan(ws, 'RES-VAC');
  assert.deepEqual(amounts(v), [21313, 21313, 21313, 21313, 21312, 21312, 21312, 21312]);
  assert.equal(v.total_minor, 170500);
  assert.equal(v.projected_minor, 180000, 'накоплено к сроку = цель');
  assert.deepEqual(amounts(sinking_plan(ws, 'RES-BDAY')), [4200, 4200, 4200, 4200, 4200]);
});

test('TST-21 REQ-069: догон — первый взнос не подтверждён, пересчёт от текущего funded на 7 дат → [24358, 24357 ×6] (Σ 170500)', () => {
  const ws = with_reserves([VAC], { as_of: '2026-11-02' });
  const p = sinking_plan(ws, 'RES-VAC');
  assert.deepEqual(amounts(p), [24358, 24357, 24357, 24357, 24357, 24357, 24357]);
  assert.equal(p.total_minor, 170500);
});

test('TST-21 REQ-069: пул 37500 по весам ближайших взносов 12000 : 4200 : 21313 → [11996, 4198, 21306], сумма долей = общему взносу', () => {
  const ws = { ...G, reserves: [...G.reserves, VAC, BDAY] };
  const rows = pool_split_report(ws, 37500);
  const by = Object.fromEntries(rows.map((r) => [r.reserve_id, r]));
  assert.deepEqual([by['RES-INS'].weight_minor, by['RES-BDAY'].weight_minor, by['RES-VAC'].weight_minor], [12000, 4200, 21313]);
  assert.deepEqual([by['RES-INS'].share_minor, by['RES-BDAY'].share_minor, by['RES-VAC'].share_minor], [11996, 4198, 21306]);
  assert.equal(rows.reduce((s, r) => s + r.share_minor, 0), 37500);
  assert.deepEqual(pool_split_report({ ...G, reserves: [G.reserves[0]] }, 100), [], 'нет целей — пул пуст');
});

test('TST-22 REQ-070: режим fixed — отпуск, взнос 15000, восемь дат: накоплено 9500 + 8·15000 = 129500, недостача 50500 (505,00 €); цель через 12 мес.', () => {
  const ws = with_reserves([{ ...VAC, mode: 'fixed', fixed_minor: 15000 }]);
  const p = sinking_plan(ws, 'RES-VAC');
  assert.equal(p.mode, 'fixed');
  assert.deepEqual(amounts(p), new Array(8).fill(15000));
  assert.equal(p.projected_minor, 129500);
  assert.equal(p.shortfall_minor, 50500);
  assert.equal(p.status, 'ok');
  assert.equal(p.periods_to_goal, 12, 'ceil(170500 / 15000)');
});

test('TST-22 REQ-071: цель 60000 при funded 60000 — взносов нет, статус «цель достигнута», недостачи нет', () => {
  const ws = with_reserves([{ ...base_reserve, reserve_id: 'RES-OK', name: 'Готово', funded_start_minor: 60000, target_minor: 60000, due_date: '2027-03-15' }]);
  const p = sinking_plan(ws, 'RES-OK');
  assert.equal(p.status, 'reached');
  assert.deepEqual(p.rows, []);
  assert.equal(p.shortfall_minor, 0);
  const fixed = sinking_plan(with_reserves([{ ...base_reserve, mode: 'fixed', fixed_minor: 1000, reserve_id: 'RES-OKF', name: 'Готово', funded_start_minor: 60000, target_minor: 60000, due_date: '2027-03-15' }]), 'RES-OKF');
  assert.equal(fixed.status, 'reached');
});

test('TST-22 REQ-071: срок 2026-10-20, дата взноса — 1-е число, as_of 2026-10-04: ближайшая дата 11-01 после срока → n = 0, список пуст, shortfall = 60000, исключений нет', () => {
  const ws = with_reserves([{ ...base_reserve, reserve_id: 'RES-LATE', name: 'Поздно', funded_start_minor: 0, target_minor: 60000, due_date: '2026-10-20' }]);
  const p = sinking_plan(ws, 'RES-LATE');
  assert.equal(p.n, 0);
  assert.deepEqual(p.rows, []);
  assert.equal(p.shortfall_minor, 60000);
  assert.equal(p.status, 'no_dates');
});

test('REQ-069 ошибки: нет резерва, не sinking, refill без цели и срока — E_SCHEMA с кодом, а не исключение произвольного вида', () => {
  throws_code(() => sinking_plan(G, 'нет-такого'), 'E_SCHEMA');
  throws_code(() => sinking_plan(G, 'RES-TAX'), 'E_SCHEMA');
  throws_code(() => sinking_plan(with_reserves([{ ...base_reserve, reserve_id: 'RES-X', name: 'X', funded_start_minor: 0 }]), 'RES-X'), 'E_SCHEMA');
});

test('REQ-069 C-030: W_RESERVE_BEHIND несёт число и сумму («2 взноса на 240,00 €»); reserve_behind_detail даёт те же числа и заготовки записей', () => {
  const ws = { ...G, as_of: '2026-12-05' };
  const w = analyze(ws, { as_of: '2026-12-05' }).warnings.find((x) => x.code === 'W_RESERVE_BEHIND');
  assert.deepEqual({ missed_count: w.missed_count, missed_minor: w.missed_minor, reserve_id: w.reserve_id }, { missed_count: 2, missed_minor: 24000, reserve_id: 'RES-INS' });
  const d = reserve_behind_detail(ws);
  assert.equal(d.length, 1);
  assert.equal(d[0].missed_count, w.missed_count);
  assert.equal(d[0].missed_minor, w.missed_minor);
  assert.deepEqual(d[0].rows.map((r) => [r.allocation_id, r.date, r.amount_minor, r.source]), [
    [contribution_id('RES-INS', '2026-11-01'), '2026-11-01', 12000, 'schedule'],
    [contribution_id('RES-INS', '2026-12-01'), '2026-12-01', 12000, 'schedule'],
  ]);
});

test('REQ-069 C-030: числа W_RESERVE_BEHIND и reserve_behind_detail совпадают и в режиме fixed, и при догоне refill (отпуск, первый взнос не подтверждён)', () => {
  for (const [res, as_of] of [[{ ...VAC, mode: 'fixed', fixed_minor: 15000 }, '2026-12-05'], [VAC, '2026-11-02'], [VAC, '2027-01-05']]) {
    const ws = with_reserves([res], { as_of });
    const a = analyze(ws, { as_of });
    const w = a.warnings.find((x) => x.code === 'W_RESERVE_BEHIND' && x.reserve_id === 'RES-VAC');
    const d = reserve_behind_detail(ws).find((x) => x.reserve_id === 'RES-VAC');
    assert.ok(w !== undefined && d !== undefined, as_of);
    assert.deepEqual([d.missed_count, d.missed_minor], [w.missed_count, w.missed_minor], `${res.mode} ${as_of}`);
  }
});

test('REQ-069 пакетное «подтвердить за период»: записанные взносы убирают предупреждение, funded растёт, план пересчитывается; повтор безвреден; upto ограничивает период', () => {
  const ws = { ...G, as_of: '2026-12-05' };
  const rows = confirm_rows(ws, 'RES-INS');
  assert.equal(rows.length, 2);
  assert.equal(confirm_rows(ws, 'RES-INS', { upto: '2026-11-15' }).length, 1, 'только 1 ноября');
  assert.deepEqual(confirm_rows(ws, 'нет-такого'), []);
  const done = { ...ws, allocations: rows };
  const a = analyze(done, { as_of: '2026-12-05' });
  assert.ok(!a.warnings.some((w) => w.code === 'W_RESERVE_BEHIND'), 'после подтверждения предупреждения нет');
  assert.deepEqual(reserve_behind_detail(done), []);
  const p = sinking_plan(done, 'RES-INS');
  assert.equal(p.funded_open_minor, 24000);
  assert.deepEqual(amounts(p), [12000, 12000, 12000], 'осталось три взноса: 2027-01-01, 02-01, 03-01');
  assert.deepEqual(confirm_rows(done, 'RES-INS'), [], 'повтор ничего не добавляет');
});

test('REQ-070 REQ-071: достигнутая цель не даёт «взносов не подтверждено»; fixed не превышает цель при подтверждении', () => {
  const reached = with_reserves([{ ...VAC, funded_start_minor: 180000 }], { as_of: '2027-01-05' });
  assert.ok(!reserve_behind_detail(reached).some((x) => x.reserve_id === 'RES-VAC'));
  const capped = with_reserves([{ ...VAC, mode: 'fixed', fixed_minor: 100000, funded_start_minor: 9500 }], { as_of: '2027-01-05' });
  const d = reserve_behind_detail(capped).find((x) => x.reserve_id === 'RES-VAC');
  assert.deepEqual(d.rows.map((r) => r.amount_minor), [100000, 70500], 'последний взнос урезан до остатка цели: 9500 + 100000 + 70500 = 180000');
});
