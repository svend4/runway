// arith.test.mjs — TST-52 «arith.lock»: корпус входов арифметики money и замок на выходы (ADR-014).
//
// Замок — файл tests/arith.lock.json: для каждого случая хранятся вход (op, args), выход (out) и
// sha256(canon({id, op, args, out})). Тест перевычисляет ВЕСЬ корпус и падает при любом изменении результата.
// Намеренная правка арифметики — отдельный коммит «ARITH-CHANGE: причина»: перегенерировать замок командой
//   ARITH_LOCK_UPDATE=1 node --test tests/arith.test.mjs
// (и повысить engine_version); рефакторинг-PR файл не меняет.
//
// Корпус строится детерминированным ГПСЧ (seed 2026) и ручными векторами канона (design-brief §9.11, §9.12).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto'; // оракул хэша — в тесте допустим
import { fileURLToPath } from 'node:url';
import {
  round_div, mul_div, floor_div, floor_mod, ceil_div, split_equal, split_largest_remainder, sum_minor, gcd,
  parse_minor, format_minor, RunwayError,
} from '../engine/money.mjs';
import { canon } from '../engine/ledger.mjs';
import { make_rng, rand_safe } from './helpers.mjs';

const LOCK_PATH = fileURLToPath(new URL('./arith.lock.json', import.meta.url));
const SEED = 2026;
const MAX = Number.MAX_SAFE_INTEGER;
const MODES = ['half_even', 'half_up', 'floor', 'ceil'];
const FMT = [{ decimal: '.', thousands: '' }, { decimal: ',', thousands: ' ' }, { decimal: '.', thousands: ',' }, { decimal: ',', thousands: '.' }];

/** Операции корпуса: имя → функция. Результат нормализуется `norm_out`. */
const OPS = {
  round_div: (n, d, mode) => round_div(n, d, mode),
  mul_div: (a, num, den, mode) => mul_div(a, num, den, mode),
  floor_div: (a, b) => floor_div(a, b),
  floor_mod: (a, b) => floor_mod(a, b),
  ceil_div: (a, b) => ceil_div(a, b),
  split_equal: (total, n) => split_equal(total, n),
  split_largest_remainder: (total, weights) => split_largest_remainder(total, weights),
  sum_minor: (xs) => sum_minor(xs),
  gcd: (a, b) => gcd(a, b),
  parse_minor: (s, o) => parse_minor(s, o),
  format_minor: (a, e, o) => format_minor(a, e, o),
};

function norm_out(v) {
  if (typeof v === 'bigint') return { bigint: v.toString() };
  if (typeof v === 'number') return v + 0;
  if (Array.isArray(v)) return v.map(norm_out);
  return v;
}

/** Выполнить случай: результат или `{error: code}` (любая НЕ-RunwayError — необработанное исключение, тест падает). */
function run_case(c) {
  try {
    return norm_out(OPS[c.op](...c.args));
  } catch (e) {
    if (e instanceof RunwayError) return { error: e.code };
    throw e;
  }
}

const sha_of = (c, out) => createHash('sha256').update(canon({ id: c.id, op: c.op, args: c.args, out })).digest('hex');

/** Ручные векторы канона (design-brief §9.11, §9.12, §9.2) — начало корпуса. */
function hand_cases() {
  return [
    ['round_div', [1, 2, 'half_even']], ['round_div', [3, 2, 'half_even']], ['round_div', [5, 2, 'half_even']], ['round_div', [7, 2, 'half_even']],
    ['round_div', [-1, 2, 'half_even']], ['round_div', [-3, 2, 'half_even']],
    ['round_div', [1, 2, 'half_up']], ['round_div', [-1, 2, 'half_up']], ['round_div', [3, 2, 'half_up']], ['round_div', [-3, 2, 'half_up']],
    ['round_div', [630000 * 7, 90, 'half_even']],
    ['split_equal', [110000, 6]], ['split_equal', [30000, 7]], ['split_equal', [-7, 3]], ['split_equal', [0, 4]],
    ['split_largest_remainder', [37500, [12000, 4200, 21313]]],
    ['mul_div', [3, 2999999999999999, 2, 'half_even']], ['mul_div', [5, 1999999999999999, 4, 'half_even']], ['mul_div', [MAX, 2, 1, 'half_even']],
    ['mul_div', [123457, 2100, 10000, 'half_even']], ['mul_div', [300000, 2000, 10000, 'half_even']], ['mul_div', [300000, 2200, 10000, 'half_even']],
    ['mul_div', [279000, 2000, 10000, 'half_even']], ['mul_div', [288000, 2000, 10000, 'half_even']], ['mul_div', [3000, 5580, 60, 'half_even']],
    ['mul_div', [3000, 2400 * 10000 + 360 * 15000, 600000, 'half_even']],
    ['mul_div', [3000, 2400 * 10000 + 1 * 12500, 600000, 'half_even']], ['mul_div', [3000, 2400 * 10000 + 1 * 12500, 600000, 'half_up']],
    ['mul_div', [200000, 9250, 10000, 'half_even']], ['mul_div', [185000, 9500, 10000, 'half_even']], ['mul_div', [150000, 50000, 1, 'half_even']],
    ['mul_div', [480, 3000, 60, 'half_even']],
    ['parse_minor', ['-1.234,56', { decimal: ',', thousands: '.', exponent: 2 }]], ['parse_minor', ['19.99', { decimal: '.', thousands: '', exponent: 2 }]],
    ['format_minor', [-123456, 2, { decimal: ',', thousands: ' ' }]], ['format_minor', [205500, 2, { decimal: '.', thousands: ',' }]],
    ['gcd', [9250, 10000]], ['gcd', [184240, 200000]], ['gcd', [0, 0]],
    ['sum_minor', [[MAX, -MAX, 5]]], ['sum_minor', [[MAX, 1]]],
    ['floor_div', [-7, 2]], ['floor_mod', [-7, 2]], ['ceil_div', [-7, 2]], ['ceil_div', [7, 2]], ['floor_div', [MAX, 1]], ['floor_div', [-MAX, 3]],
    ['round_div', [MAX, 2, 'half_even']], ['round_div', [-MAX, 2, 'half_even']], ['round_div', [MAX, 2, 'half_up']], ['round_div', [-MAX, 2, 'half_up']],
    ['round_div', [0, 1, 'half_even']], ['round_div', [1, MAX, 'ceil']], ['round_div', [-1, MAX, 'floor']],
  ].map(([op, args]) => ({ op, args }));
}

/** Построить корпус заново (детерминированно, seed 2026). */
export function build_corpus() {
  const rng = make_rng(SEED);
  const cases = hand_cases();
  const any = () => rand_safe(rng, rng.int(1, 53));
  const pos = () => Math.max(1, Math.abs(rand_safe(rng, rng.int(1, 53))));
  for (let i = 0; i < 130; i++) cases.push({ op: 'round_div', args: [any(), pos(), rng.pick(MODES)] });
  for (let i = 0; i < 110; i++) cases.push({ op: 'mul_div', args: [any(), any(), pos(), rng.pick(MODES)] });
  for (let i = 0; i < 20; i++) cases.push({ op: 'mul_div', args: [any(), rng.int(0, 10000), 10000, rng.pick(MODES)] });
  for (let i = 0; i < 20; i++) cases.push({ op: rng.pick(['floor_div', 'floor_mod', 'ceil_div']), args: [any(), pos()] });
  for (let i = 0; i < 30; i++) cases.push({ op: rng.pick(['floor_div', 'floor_mod', 'ceil_div']), args: [any(), rng.int(1, 100000)] });
  for (let i = 0; i < 40; i++) cases.push({ op: 'split_equal', args: [rand_safe(rng, rng.int(1, 40)), rng.int(1, 40)] });
  for (let i = 0; i < 45; i++) {
    const n = rng.int(1, 8);
    cases.push({ op: 'split_largest_remainder', args: [rand_safe(rng, rng.int(1, 45)), Array.from({ length: n }, (_, k) => (k === 0 ? rng.int(1, 100000) : rng.int(0, 100000)))] });
  }
  for (let i = 0; i < 25; i++) cases.push({ op: 'sum_minor', args: [Array.from({ length: rng.int(0, 12) }, () => rand_safe(rng, rng.int(1, 50)))] });
  for (let i = 0; i < 20; i++) cases.push({ op: 'gcd', args: [any(), any()] });
  for (let i = 0; i < 40; i++) {
    const fmt = rng.pick(FMT); const exp = rng.pick([0, 2, 2, 3, 8]);
    const a = rand_safe(rng, rng.int(1, 53));
    cases.push({ op: 'format_minor', args: [a, exp, fmt] });
    // строка для парсинга — результат форматирования (round-trip) либо испорченная
    const s = format_minor(a, exp, fmt);
    cases.push({ op: 'parse_minor', args: [rng.int(0, 5) === 0 ? s + fmt.decimal + '5' : s, { ...fmt, exponent: exp }] });
  }
  return cases.map((c, i) => ({ id: 'c' + String(i + 1).padStart(4, '0'), ...c }));
}

/** Собрать замок: для каждого случая — выход и контрольная сумма. */
function build_lock() {
  const cases = build_corpus().map((c) => {
    const out = run_case(c);
    return { ...c, out, sha256: sha_of(c, out) };
  });
  return { format: 'arith.lock/1', seed: SEED, count: cases.length, note: 'ARITH-CHANGE: правка только отдельным коммитом (ADR-014); обновление: ARITH_LOCK_UPDATE=1 node --test tests/arith.test.mjs', cases };
}

/** Сверить замок с текущей арифметикой: список расхождений (пустой — совпало). */
export function verify_lock(lock) {
  const diffs = [];
  for (const c of lock.cases) {
    const out = run_case(c);
    const got = sha_of(c, out);
    if (canon(out) !== canon(c.out)) diffs.push(`${c.id} ${c.op}(${JSON.stringify(c.args)}): было ${JSON.stringify(c.out)}, стало ${JSON.stringify(out)}`);
    else if (got !== c.sha256) diffs.push(`${c.id}: контрольная сумма записи не совпала`);
  }
  return diffs;
}

if (process.env.ARITH_LOCK_UPDATE === '1') {
  fs.writeFileSync(LOCK_PATH, JSON.stringify(build_lock(), null, 1) + '\n', 'utf8');
}

const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));

test('TST-52 arith.lock: корпус не короче 500 случаев и покрывает все операции money', () => {
  assert.equal(lock.format, 'arith.lock/1');
  assert.equal(lock.seed, SEED);
  assert.ok(lock.cases.length >= 500, `в корпусе ${lock.cases.length} случаев`);
  assert.equal(lock.count, lock.cases.length);
  const ops = new Set(lock.cases.map((c) => c.op));
  for (const op of Object.keys(OPS)) assert.ok(ops.has(op), `нет случаев для ${op}`);
  assert.equal(new Set(lock.cases.map((c) => c.id)).size, lock.cases.length, 'идентификаторы уникальны');
  assert.ok(lock.cases.some((c) => c.out?.error === 'E_OVERFLOW'), 'в корпусе есть переполнения');
  assert.ok(lock.cases.some((c) => c.out?.error === 'E_NOT_INTEGER'), 'в корпусе есть отказы разбора');
});

test('TST-52 arith.lock: корпус входов воспроизводится из seed 2026 побайтно (генератор не менялся)', () => {
  const fresh = build_corpus();
  assert.equal(fresh.length, lock.cases.length);
  fresh.forEach((c, i) => {
    const l = lock.cases[i];
    assert.equal(canon({ id: c.id, op: c.op, args: c.args }), canon({ id: l.id, op: l.op, args: l.args }), `вход ${c.id} изменился`);
  });
});

test('TST-52 arith.lock: замок — любой выход арифметики совпадает с записанным (падает при любом изменении результата)', () => {
  const diffs = verify_lock(lock);
  assert.deepEqual(diffs, [], 'расхождения замка арифметики (ARITH-CHANGE нужен отдельным коммитом):\n' + diffs.slice(0, 10).join('\n'));
});

test('TST-52 arith.lock: тест чувствителен — подмена выхода, входа или контрольной суммы ловится', () => {
  const clone = () => JSON.parse(JSON.stringify(lock));
  // 1) изменился результат (как если бы кто-то поменял режим округления)
  let t = clone();
  const i = t.cases.findIndex((c) => c.op === 'round_div' && typeof c.out === 'number');
  t.cases[i].out += 1;
  assert.equal(verify_lock(t).length, 1);
  // 2) изменился вход — выход «по-старому» уже не совпадёт для большинства случаев
  t = clone();
  const j = t.cases.findIndex((c) => c.op === 'mul_div' && typeof c.out === 'number' && c.args[0] > 1);
  t.cases[j].args[0] -= 1;
  assert.ok(verify_lock(t).length >= 1);
  // 3) подмена только контрольной суммы
  t = clone();
  t.cases[0].sha256 = '0'.repeat(64);
  assert.equal(verify_lock(t).length, 1);
  // 4) мутация режима: имитируем «half_even заменён на half_up» — число расхождений на корпусе не нулевое
  const mutated = (c) => (c.op === 'round_div' && c.args[2] === 'half_even' ? { ...c, args: [c.args[0], c.args[1], 'half_up'] } : c);
  const bad = lock.cases.filter((c) => canon(run_case(mutated(c))) !== canon(c.out));
  assert.ok(bad.length > 0, 'замена режима округления должна менять хотя бы один результат корпуса');
  // 5) мутация знака: floor_div вместо ceil_div
  const swapped = lock.cases.filter((c) => c.op === 'ceil_div' && canon(run_case({ ...c, op: 'floor_div' })) !== canon(c.out));
  assert.ok(swapped.length > 0);
});

test('TST-52 arith.lock: корпус содержит дословные векторы канона §9.11 и §9.12', () => {
  const find = (op, args) => lock.cases.find((c) => c.op === op && canon(c.args) === canon(args));
  assert.deepEqual(find('split_equal', [110000, 6]).out, [18334, 18334, 18333, 18333, 18333, 18333]);
  assert.deepEqual(find('split_largest_remainder', [37500, [12000, 4200, 21313]]).out, [11996, 4198, 21306]);
  assert.equal(find('mul_div', [3, 2999999999999999, 2, 'half_even']).out, 4499999999999998);
  assert.equal(find('mul_div', [5, 1999999999999999, 4, 'half_even']).out, 2499999999999999);
  assert.deepEqual(find('mul_div', [MAX, 2, 1, 'half_even']).out, { error: 'E_OVERFLOW' });
  assert.equal(find('mul_div', [123457, 2100, 10000, 'half_even']).out, 25926);
  assert.equal(find('mul_div', [200000, 9250, 10000, 'half_even']).out, 185000);
  assert.equal(find('mul_div', [185000, 9500, 10000, 'half_even']).out, 175750);
  assert.equal(find('mul_div', [150000, 50000, 1, 'half_even']).out, 7500000000);
  assert.equal(find('parse_minor', ['-1.234,56', { decimal: ',', thousands: '.', exponent: 2 }]).out, -123456);
  assert.equal(find('format_minor', [-123456, 2, { decimal: ',', thousands: ' ' }]).out, '-1 234,56');
  assert.deepEqual(find('gcd', [9250, 10000]).out, { bigint: '250' });
});
