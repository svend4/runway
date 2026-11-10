// installment.test.mjs — FP-08: рассрочка по частям и с процентами (TST-29, TST-30; REQ-044, REQ-192; ALG-09, ALG-04).
// 1 200,00 € под 12 % годовых на 6 платежей → части [20706 ×5, 20705], Σ 124235 (120000 + проценты 4235); влияние на «свободно» — через check_purchase по частям.
// Запуск: node --test --test-timeout=120000 --test-concurrency=1 tests/installment.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { analyze, check_purchase, installment_parts } from '../engine/index.mjs';
import { installment_plan, parts_from_debt_plan, purchase_from_parts, move_part_date, split_horizon, INSTALLMENT_KINDS } from '../engine/installment.mjs';
import { throws_code } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const G = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'data', 'g001.json'), 'utf8'));
const amounts = (parts) => parts.map((p) => p.amount_minor);

test('TST-29 REQ-192: 1 200,00 € под 12 % годовых на 6 платежей — части [20706 ×5, 20705], Σ = 124235 (120000 + проценты 4235); даты без сдвига выходных', () => {
  const p = installment_plan({ total_minor: 120000, n: 6, rate_bp: 1200, start: '2026-11-01' });
  assert.deepEqual(amounts(p.parts), [20706, 20706, 20706, 20706, 20706, 20705]);
  assert.equal(p.total_minor, 124235);
  assert.equal(p.interest_minor, 4235);
  assert.equal(p.principal_minor, 120000);
  assert.deepEqual(p.rows.map((r) => r.interest_minor), [1200, 1005, 808, 609, 408, 205]);
  assert.deepEqual(p.rows.map((r) => r.balance_minor), [100494, 80793, 60895, 40798, 20500, 0]);
  assert.deepEqual(p.parts.map((x) => x.date), ['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01', '2027-03-01', '2027-04-01']);
  assert.equal(p.kind, 'annuity');
});

test('TST-30 REQ-192: части из DebtPlan (аннуитет) через check_purchase — вычитаются по датам частей, а не всей суммой сразу; за горизонтом — beyond_horizon_minor', () => {
  const debt = { debt_id: 'd-1', pay_account_id: 'acc_main', currency: 'EUR', kind: 'annuity', principal_minor: 120000, rate_bp: 1200, n: 6, start_date: '2026-11-01' };
  const parts = parts_from_debt_plan(debt);
  assert.deepEqual(amounts(parts), [20706, 20706, 20706, 20706, 20706, 20705]);
  const a = analyze(G, { as_of: G.as_of });
  const r = check_purchase(a, purchase_from_parts(parts, { currency: 'EUR' }), null);
  assert.equal(r.kind, 'ok');
  assert.equal(r.beyond_horizon_minor, 124235 - 20706, 'горизонт G-001 57 дн.: внутри только первая часть 11-01');
  assert.ok(r.warnings.some((w) => w.code === 'W_PART_BEYOND_HORIZON'));
  assert.equal(r.s_max, null, 'для нескольких частей s_max и earliest в v1 — null (C-017)');
  // минимум «свободно» после покупки — по частям: min_i (free[i] − cum[i])
  const free = a.series.plan.free;
  const cum = free.map((_, i) => (a.as_of + i >= 20758 ? 20706 : 0)); // 2026-11-01 = EpochDay 20758
  const expected = Math.min(...free.map((x, i) => x - cum[i]));
  assert.equal(r.by_mode.plan.m_after, expected);
});

test('TST-30 REQ-044: без процентов — installment_parts(110000, 6) = [18334, 18334, 18333 ×4]; installment_plan с нулевой ставкой даёт те же части и ту же сумму', () => {
  const p = installment_plan({ total_minor: 110000, n: 6, start: '2026-11-01' });
  assert.deepEqual(amounts(p.parts), installment_parts(110000, 6));
  assert.deepEqual(amounts(p.parts), [18334, 18334, 18333, 18333, 18333, 18333]);
  assert.equal(p.interest_minor, 0);
  assert.equal(p.kind, 'installment_0');
  assert.equal(installment_plan({ total_minor: 110000, n: 6, start: '2026-11-01', rate_bp: 0, kind: 'annuity' }).kind, 'installment_0', 'аннуитет при 0 % — это рассрочка');
});

test('REQ-192: дифференцированные платежи — убывают, Σ платежей = долг + проценты; нулевые части (сумма меньше числа платежей без процентов) в части покупки не попадают', () => {
  const d = installment_plan({ total_minor: 120000, n: 6, rate_bp: 1200, start: '2026-11-01', kind: 'differential' });
  assert.ok(d.rows.every((r, i) => i === 0 || r.payment_minor <= d.rows[i - 1].payment_minor), 'платежи не растут');
  assert.equal(d.total_minor, 120000 + d.interest_minor);
  assert.equal(d.rows.at(-1).balance_minor, 0);
  const tiny = installment_plan({ total_minor: 3, n: 6, start: '2026-11-01' });
  assert.deepEqual(amounts(tiny.parts), [1, 1, 1]);
  assert.equal(tiny.rows.length, 6);
});

test('REQ-192 перенос платежа: меняется дата строки, сумма нет; исходный список цел; несуществующая дата — E_BAD_DATE, номер вне списка — E_SCHEMA', () => {
  const parts = installment_plan({ total_minor: 120000, n: 6, rate_bp: 1200, start: '2026-11-01' }).parts;
  const moved = move_part_date(parts, 2, '2027-01-03');
  assert.equal(moved[2].date, '2027-01-03');
  assert.equal(moved[2].amount_minor, parts[2].amount_minor);
  assert.equal(parts[2].date, '2027-01-01', 'исходный список не меняется');
  throws_code(() => move_part_date(parts, 1, '2027-02-30'), 'E_BAD_DATE');
  throws_code(() => move_part_date(parts, 6, '2027-01-03'), 'E_SCHEMA');
  throws_code(() => move_part_date(parts, -1, '2027-01-03'), 'E_SCHEMA');
});

test('REQ-044 C-017: split_horizon — что внутри горизонта и что за ним; purchase_from_parts проверяет число частей (1…120)', () => {
  const parts = installment_plan({ total_minor: 110000, n: 6, start: '2026-11-01' }).parts;
  const s = split_horizon(parts, '2026-11-30');
  assert.deepEqual(s, { inside_count: 1, inside_minor: 18334, beyond_count: 5, beyond_minor: 91666 });
  throws_code(() => purchase_from_parts([], { currency: 'EUR' }), 'E_SCHEMA');
  throws_code(() => purchase_from_parts(new Array(121).fill({ date: '2026-11-01', amount_minor: 1 }), { currency: 'EUR' }), 'E_SCHEMA');
  assert.deepEqual(purchase_from_parts(parts, { currency: 'EUR', name: 'N', purchase_id: 'p1' }).parts.length, 6);
});

test('REQ-192 C-041: ограничения графика — n от 1 до 600, ставка 0…100000 bp, долг не меньше числа платежей при процентах; неизвестный вид — E_SCHEMA', () => {
  throws_code(() => installment_plan({ total_minor: 120000, n: 0, rate_bp: 1200, start: '2026-11-01' }), 'E_SCHEMA');
  throws_code(() => installment_plan({ total_minor: 120000, n: 6, rate_bp: 100001, start: '2026-11-01' }), 'E_SCHEMA');
  throws_code(() => installment_plan({ total_minor: 5, n: 6, rate_bp: 1200, start: '2026-11-01' }), 'E_SCHEMA');
  throws_code(() => installment_plan({ total_minor: 120000, n: 6, rate_bp: 1200, start: '2026-11-01', kind: 'balloon' }), 'E_SCHEMA');
  throws_code(() => installment_plan({ total_minor: 120000.5, n: 6, rate_bp: 1200, start: '2026-11-01' }), 'E_NOT_INTEGER');
  throws_code(() => installment_plan({ total_minor: 120000, n: 6, rate_bp: 1200, start: '2026-02-30' }), 'E_BAD_DATE');
  assert.deepEqual([...INSTALLMENT_KINDS], ['installment_0', 'annuity', 'differential']);
});
