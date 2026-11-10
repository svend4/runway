// reserve_backing_free.test.mjs — FP-47, часть 7 (REQ-191, TST-02, C-085, D-07): критерий приёмки «после перевода суммы с операционного счёта на счёт, к которому привязан
// резерв, `free` не меняется (нет двойного вычитания)». До этого теста критерий не проверял никто: transfer_guard.test.mjs проверяет только причину `reserve_backed`,
// а не значение `free`. Движок НЕ менялся; расхождения с критерием (частичный перевод, платёж, привязанный к резерву, позже по горизонту) закреплены отдельными
// тестами «ХАРАКТЕРИЗАЦИЯ» и описаны в open_issues пакета. Числа канона G-001 переписаны вручную: RES-TAX.funded = 150000, free на старте 250000, перевод 100000 без привязки
// уводит free в 150000 (transfer_guard.test.mjs, X12). Расчёт по введённым данным и правилам, не консультация. Тесты — в Node, без DOM.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/reserve_backing_free.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze } from '../engine/index.mjs';
import { check_transfer } from '../engine/transfer_guard.mjs';
import { validate_ws } from '../engine/validate_ws.mjs';
import { apply_edit } from '../demo/ws_edit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const G = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'data', 'g001.json'), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));

/** G-001 «на следующий день» (как в transfer_guard.test.mjs): as_of 2026-10-05, якорь 10-04, добавлен накопительный счёт-копилка. */
function day_after() {
  const w = clone(G);
  w.as_of = '2026-10-05';
  w.accounts.push({ account_id: 'acc_sav', name: 'Копилка', kind: 'savings', liquidity: 'savings', currency: 'EUR', exponent: 2, opened_on: '2026-01-01' });
  return w;
}
let n = 0;
const new_id = (p) => p + '_' + (++n);
const run = (ws, edit) => { const r = apply_edit(ws, edit, { new_id }); assert.equal(r.ok, true, JSON.stringify(r.error)); return r.ws; };
/** Реальный перевод `amount` с acc_main на acc_sav: две ноги общего перевода (как делает форма «Перевод»). */
const transfer = (ws, amount, tid = 'trf_1') => run(ws, { type: 'add_fact', transfer_id: tid, legs: [{ account_id: 'acc_main', date: ws.as_of, amount_minor: -amount }, { account_id: 'acc_sav', date: ws.as_of, amount_minor: amount }] });
/** Привязка резерва к счёту обычной правкой `upsert_reserve` (путь интерфейса). */
const bind = (ws, reserve_id = 'RES-TAX', account_id = 'acc_sav') => run(ws, { type: 'upsert_reserve', reserve: { ...clone(ws.reserves.find((r) => r.reserve_id === reserve_id)), backed_by_account_id: account_id } });
const A = (ws) => analyze(ws, { as_of: ws.as_of });
const T = (amount, over = {}) => ({ transfer_id: 'trf_1', from_account_id: 'acc_main', to_account_id: 'acc_sav', amount_minor: amount, date: '2026-10-05', ...over });

const BASE = day_after();
const FUNDED = 150000;

test('REQ-191 канон G-001: до привязки free на старте 250000 по обоим режимам, резерв RES-TAX не привязан (backed_by_account_id = null), деньги резерва лежат на операционном счёте', () => {
  const a = A(BASE);
  assert.equal(a.series.plan.opening_minor, 400000);
  assert.equal(a.series.plan.reserve_opening_minor, FUNDED);
  assert.deepEqual([a.series.plan.free[0], a.series.worse.free[0]], [250000, 250000]);
  assert.ok(BASE.reserves.every((r) => r.backed_by_account_id === null), 'в v1 поле всегда null');
});

test('REQ-191 критерий приёмки: после перевода СУММЫ резерва (150000) с операционного счёта на счёт, к которому привязан резерв, free не меняется — 250000 до и после, оба режима', () => {
  const bound = bind(BASE);
  assert.equal(bound.reserves.find((r) => r.reserve_id === 'RES-TAX').backed_by_account_id, 'acc_sav');
  assert.equal(validate_ws(bound).ok, true, JSON.stringify(validate_ws(bound).errors));
  const moved = transfer(bound, FUNDED);
  assert.equal(validate_ws(moved).ok, true, JSON.stringify(validate_ws(moved).errors));
  const before = A(BASE);
  const after = A(moved);
  assert.equal(after.series.plan.opening_minor, 250000, 'с операционного счёта ушло 150000');
  assert.equal(after.series.plan.reserve_opening_minor, 0, 'резерв, привязанный к неоперационному счёту, в R не входит');
  assert.equal(after.series.plan.free[0], before.series.plan.free[0], 'free по плану не изменился');
  assert.equal(after.series.worse.free[0], before.series.worse.free[0], 'free «если хуже» не изменился');
  assert.deepEqual([after.series.plan.free[0], after.series.worse.free[0]], [250000, 250000]);
  assert.deepEqual(after.warnings.map((w) => w.code).sort(), before.warnings.map((w) => w.code).sort(), 'новых предупреждений нет');
  // исходные данные не тронуты правками (чистые функции)
  assert.equal(BASE.reserves[0].backed_by_account_id, null);
});

test('REQ-191 без привязки тот же перевод даёт двойное вычитание: free 250000 → 100000 (минус перевод), поэтому REQ-063 просит согласие; с привязкой запроса нет — причина reserve_backed', () => {
  const unbound = transfer(BASE, FUNDED);
  assert.equal(A(unbound).series.plan.free[0], 100000, 'двойное вычитание без привязки');
  const g = check_transfer(unbound, T(FUNDED));
  assert.equal(g.warn, true);
  assert.equal(g.reason, 'double_count');
  const bound = transfer(bind(BASE), FUNDED);
  assert.deepEqual(check_transfer(bound, T(FUNDED)), { warn: false, reason: 'reserve_backed', transfer_id: 'trf_1' });
  assert.equal(A(bound).series.plan.free[0], 250000);
});

test('REQ-191 порядок действий не важен: сначала перевод, потом привязка — тот же free (250000), что и сначала привязка, потом перевод', () => {
  const a = A(bind(transfer(BASE, FUNDED)));
  const b = A(transfer(bind(BASE), FUNDED));
  assert.equal(a.series.plan.free[0], 250000);
  assert.equal(b.series.plan.free[0], 250000);
  assert.deepEqual(a.series.plan.free, b.series.plan.free, 'ряд free одинаков');
});

test('REQ-191 до первого платежа, привязанного к резерву, ряд free после привязки и перевода совпадает с рядом до них день в день (нет двойного вычитания на всём отрезке)', () => {
  const base = A(BASE);
  const moved = A(transfer(bind(BASE), FUNDED));
  const first = base.events.plan.findIndex((e) => e.reserve_id === 'RES-TAX' && e.amount_minor < 0);
  assert.ok(first >= 0);
  const day = base.events.plan[first].date - base.as_of; // индекс дня первого платежа из резерва (налог 10-23)
  assert.equal(day, 18);
  for (let i = 0; i < day; i++) assert.equal(moved.series.plan.free[i], base.series.plan.free[i], `день ${i}: free плана`);
  for (let i = 0; i < day; i++) assert.equal(moved.series.worse.free[i], base.series.worse.free[i], `день ${i}: free «если хуже»`);
});

test('REQ-191 привязка пустого резерва (RES-INS, funded 0) к копилке free не меняет: из R нечего убирать', () => {
  const bound = bind(BASE, 'RES-INS');
  assert.equal(A(bound).series.plan.free[0], 250000, 'пустой резерв из R ничего не убирает');
});

// ── ХАРАКТЕРИЗАЦИЯ: где поведение движка НЕ совпадает с буквой критерия (код движка не менялся; расхождения описаны в open_issues) ─────────────────────────────

test('REQ-191 ХАРАКТЕРИЗАЦИЯ расхождения (1): перевод МЕНЬШЕ суммы резерва — free растёт на разницу, потому что привязанный резерв выходит из R целиком (деньги резерва, оставшиеся на операционном счёте, перестают вычитаться)', () => {
  const part = 100000;
  const after = A(transfer(bind(BASE), part));
  assert.equal(after.series.plan.opening_minor, 300000);
  assert.equal(after.series.plan.reserve_opening_minor, 0);
  assert.equal(after.series.plan.free[0], 300000, 'free 300000, а не 250000');
  assert.equal(after.series.plan.free[0] - A(BASE).series.plan.free[0], FUNDED - part, 'free выше прежнего ровно на недопереведённую часть резерва');
});

test('REQ-191 ХАРАКТЕРИЗАЦИЯ расхождения (2): платёж, привязанный к резерву (налог 10-23, −50000), после привязки по-прежнему идёт с операционного счёта и уменьшает free; взносы в резерв из поступлений free не уменьшают', () => {
  const base = A(BASE);
  const moved = A(transfer(bind(BASE), FUNDED));
  const d = moved.series.plan.free.map((v, i) => v - base.series.plan.free[i]);
  assert.equal(d.findIndex((x) => x !== 0), 18, 'первое расхождение в день налогового платежа 10-23');
  assert.deepEqual([...new Set(d)].sort((x, y) => x - y), [-50000, 0, 5800], 'сначала −50000 (платёж не высвобождается из резерва), позже +5800 (взнос 55800 не вычитается из free, платёж −50000)');
});

test('REQ-191 ХАРАКТЕРИЗАЦИЯ расхождения (3): движок не проверяет, что счёт привязки неоперационный, в валюте резерва и не закрыт — привязка к операционному счёту принимается и убирает резерв из R, хотя деньги из операционных счетов не ушли', () => {
  const to_main = run(BASE, { type: 'upsert_reserve', reserve: { ...clone(BASE.reserves[0]), backed_by_account_id: 'acc_main' } });
  const a = A(to_main);
  assert.equal(validate_ws(to_main).ok, true, 'проверок вида счёта нет (validate_ws проверяет только существование)');
  assert.equal(a.series.plan.reserve_opening_minor, 0);
  assert.equal(a.series.plan.free[0], 400000, 'free вырос с 250000 до 400000 без единого перевода: двойного вычитания нет, зато резерв «исчез»');
});
