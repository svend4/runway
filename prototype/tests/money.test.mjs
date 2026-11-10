// money.test.mjs — TST-16, TST-17, TST-18, TST-19 (+ часть TST-51: суммы 0, ±1, ±(2^53−1), ничьи, ставки 0…10000 bp).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assert_minor, floor_div, floor_mod, ceil_div, round_div, mul_div, split_equal, split_largest_remainder,
  sum_minor, gcd, currency_exponent, currency_kind, register_currency, parse_minor, format_minor, NUMBER_FORMATS,
  fail, RunwayError, ERROR_CODES,
} from '../engine/money.mjs';
import { make_rng, rand_safe, throws_code } from './helpers.mjs';

const MAX = Number.MAX_SAFE_INTEGER;

test('assert_minor: целые проходят, −0 → 0, float и переполнение — коды ошибок', () => {
  assert.equal(assert_minor(5), 5);
  assert.ok(Object.is(assert_minor(-0), 0), '−0 нормализуется в 0');
  assert.equal(assert_minor(10n), 10);
  assert.equal(assert_minor(-MAX), -MAX);
  throws_code(() => assert_minor(1.5), 'E_NOT_INTEGER');
  throws_code(() => assert_minor(NaN), 'E_NOT_INTEGER');
  throws_code(() => assert_minor('5'), 'E_NOT_INTEGER');
  throws_code(() => assert_minor(Infinity), 'E_NOT_INTEGER');
  throws_code(() => assert_minor(MAX + 1), 'E_OVERFLOW');
  throws_code(() => assert_minor(2 ** 60), 'E_OVERFLOW');
  throws_code(() => assert_minor(BigInt(MAX) + 1n), 'E_OVERFLOW');
});

test('fail / RunwayError: код и контекст', () => {
  assert.throws(() => fail('E_SCHEMA', { a: 1 }), (e) => e instanceof RunwayError && e.code === 'E_SCHEMA' && e.ctx.a === 1 && e.message.startsWith('E_SCHEMA'));
  for (const c of ['E_NOT_INTEGER', 'E_OVERFLOW', 'E_BAD_DATE', 'E_FUTURE_POSTED', 'E_RULE_INVALID', 'E_CURRENCY_MISMATCH', 'E_NO_RATE', 'E_SCHEMA',
    'E_UNTRUSTED_LEAK', 'E_NOT_PERMITTED', 'E_CALL_LIMIT', 'E_UNKNOWN_TOOL']) {
    assert.ok(ERROR_CODES.includes(c), `реестр ошибок содержит ${c}`);
  }
});

test('floor_div / floor_mod / ceil_div: знаки и тождество a = b·q + r', () => {
  assert.equal(floor_div(7, 2), 3);
  assert.equal(floor_div(-7, 2), -4);
  assert.equal(floor_div(7, 7), 1);
  assert.equal(floor_div(-7, 7), -1);
  assert.equal(floor_div(0, 5), 0);
  assert.ok(Object.is(floor_div(0, 5), 0));
  assert.equal(floor_mod(-7, 2), 1);
  assert.equal(floor_mod(7, 2), 1);
  assert.ok(Object.is(floor_mod(-6, 3), 0), 'остаток −0 нормализуется');
  assert.equal(ceil_div(7, 2), 4);
  assert.equal(ceil_div(-7, 2), -3);
  assert.equal(ceil_div(6, 3), 2);
  assert.equal(floor_div(MAX, 2), 4503599627370495);
  assert.equal(floor_div(-MAX, 2), -4503599627370496);
  assert.equal(floor_mod(-MAX, MAX), 0);
  throws_code(() => floor_div(1, 0), 'E_SCHEMA');
  throws_code(() => floor_div(1, -2), 'E_SCHEMA');
  throws_code(() => floor_div(1.5, 2), 'E_NOT_INTEGER');
});

test('TST-16 round_div: ничьи half_even', () => {
  assert.deepEqual([1, 3, 5, 7].map((n) => round_div(n, 2, 'half_even')), [0, 2, 2, 4]);
  assert.deepEqual([-1, -3].map((n) => round_div(n, 2, 'half_even')), [0, -2]);
  assert.equal(round_div(2, 2, 'half_even'), 1);
  assert.ok(Object.is(round_div(-1, 2, 'half_even'), 0) || round_div(-1, 2, 'half_even') === 0);
  assert.equal(round_div(1, 3), 0, 'режим по умолчанию — half_even');
  assert.equal(round_div(2, 3), 1);
});

test('TST-16 round_div: ничьи half_up (от нуля), floor, ceil', () => {
  assert.deepEqual([1, -1, 3, -3].map((n) => round_div(n, 2, 'half_up')), [1, -1, 2, -2]);
  assert.deepEqual([5, -5, 7, -7, 0].map((n) => round_div(n, 10, 'floor')), [0, -1, 0, -1, 0]);
  assert.deepEqual([5, -5, 7, -7, 0, 10, -10].map((n) => round_div(n, 10, 'ceil')), [1, 0, 1, 0, 0, 1, -1]);
  throws_code(() => round_div(1, 2, 'banana'), 'E_SCHEMA');
  throws_code(() => round_div(1, 0, 'half_even'), 'E_SCHEMA');
  // BigInt-числитель
  assert.equal(round_div(10n ** 18n + 1n, 10n ** 18n), 1);
  throws_code(() => round_div(10n ** 30n, 1), 'E_OVERFLOW');
});

/** Независимый оракул округления: симметричная схема «знак × округление модуля» на BigInt (иная, чем floor-схема движка). */
function oracle_round_div(n, d, mode) {
  const N = BigInt(n); const D = BigInt(d);
  const neg = N < 0n;
  const a = neg ? -N : N;
  const q = a / D; // усечение модуля
  const t = a % D;
  const up = t > 0n; // есть дробная часть
  let mag;
  if (mode === 'half_up') mag = (2n * a + D) / (2n * D);
  else if (mode === 'half_even') mag = 2n * t < D ? q : (2n * t > D ? q + 1n : (q % 2n === 0n ? q : q + 1n)); // на ничьей — чётное (знак чётность не меняет)
  else if (mode === 'floor') return neg ? -(q + (up ? 1n : 0n)) : q;
  else return neg ? -q : q + (up ? 1n : 0n); // ceil
  return neg ? -mag : mag;
}

test('TST-51 round_div: оракул на краевых и случайных значениях, все режимы', () => {
  const rng = make_rng(2026);
  const edge = [0, 1, -1, 2, -2, 3, -3, MAX, -MAX, MAX - 1, -(MAX - 1), 4503599627370495, 9007199254740990];
  const ds = [1, 2, 3, 4, 7, 10, 100, 10000, 6, 600000, MAX, MAX - 1, 4503599627370496];
  let checked = 0;
  for (const mode of ['half_even', 'half_up', 'floor', 'ceil']) {
    for (const n of edge) for (const d of ds) {
      assert.equal(round_div(n, d, mode), Number(oracle_round_div(n, d, mode)), `${mode} ${n}/${d}`);
      checked++;
    }
    for (let i = 0; i < 3000; i++) {
      const n = rand_safe(rng, rng.int(1, 53));
      const d = Math.max(1, Math.abs(rand_safe(rng, rng.int(1, 53))));
      assert.equal(round_div(n, d, mode), Number(oracle_round_div(n, d, mode)), `${mode} ${n}/${d}`);
      checked++;
    }
  }
  assert.ok(checked > 12000);
});

test('TST-51 ничьи округления на сетке: n = (2k+1)·d/2 для чётных d', () => {
  for (const d of [2, 4, 10, 100, 10000]) {
    for (let k = -50; k <= 50; k++) {
      const n = (2 * k + 1) * (d / 2);
      const q = Math.floor(n / d); // floor-значение
      const he = round_div(n, d, 'half_even');
      assert.equal(Math.abs(he) % 2, 0, `half_even даёт чётное при ничьей: ${n}/${d} → ${he}`);
      assert.ok(he === q || he === q + 1);
      const hu = round_div(n, d, 'half_up');
      assert.equal(hu, n >= 0 ? q + 1 : q, `half_up от нуля: ${n}/${d}`);
    }
  }
});

test('TST-17 split_equal: канонические векторы', () => {
  assert.deepEqual(split_equal(110000, 6), [18334, 18334, 18333, 18333, 18333, 18333]);
  assert.equal(sum_minor(split_equal(110000, 6)), 110000);
  assert.deepEqual(split_equal(30000, 7), [4286, 4286, 4286, 4286, 4286, 4285, 4285]);
  assert.equal(sum_minor(split_equal(30000, 7)), 30000);
  assert.deepEqual(split_equal(0, 3), [0, 0, 0]);
  assert.deepEqual(split_equal(5, 1), [5]);
  assert.deepEqual(split_equal(-7, 3), [-3, -2, -2], 'для total < 0 — по модулю с обратным знаком');
  assert.ok(split_equal(-3, 3).every((x) => Object.is(x, -1)));
  assert.ok(split_equal(-1, 3).every((x, i) => (i === 0 ? x === -1 : Object.is(x, 0))), 'нулевые части без −0');
  throws_code(() => split_equal(10, 0), 'E_SCHEMA');
  throws_code(() => split_equal(10, 2.5), 'E_NOT_INTEGER');
});

test('TST-17 split_largest_remainder: канонический вектор и свойства', () => {
  assert.deepEqual(split_largest_remainder(37500, [12000, 4200, 21313]), [11996, 4198, 21306]);
  assert.equal(sum_minor(split_largest_remainder(37500, [12000, 4200, 21313])), 37500);
  assert.deepEqual(split_largest_remainder(100, [1, 1, 1]), [34, 33, 33], 'ничья остатков — по возрастанию индекса');
  assert.deepEqual(split_largest_remainder(10, [0, 5, 0]), [0, 10, 0], 'нулевой вес не получает остаток');
  assert.deepEqual(split_largest_remainder(-100, [1, 1, 1]), [-34, -33, -33]);
  assert.deepEqual(split_largest_remainder(0, [3, 4]), [0, 0]);
  throws_code(() => split_largest_remainder(10, [0, 0]), 'E_SCHEMA');
  throws_code(() => split_largest_remainder(10, []), 'E_SCHEMA');
  throws_code(() => split_largest_remainder(10, [1, -1]), 'E_SCHEMA');
  const rng = make_rng(17);
  for (let i = 0; i < 2000; i++) {
    const n = rng.int(1, 8);
    const w = Array.from({ length: n }, () => rng.int(0, 1_000_000));
    if (w.every((x) => x === 0)) w[0] = 1;
    const total = rand_safe(rng, rng.int(1, 40));
    const parts = split_largest_remainder(total, w);
    assert.equal(sum_minor(parts), total);
    const sw = w.reduce((a, b) => a + b, 0);
    parts.forEach((p, k) => {
      const exact = (Math.abs(total) * w[k]) / sw;
      assert.ok(Math.abs(Math.abs(p) - exact) < 1 + 1e-6 * exact, 'часть в пределах 1 minor от точной доли');
    });
  }
  // большие значения: total·w выше 2^53 — только через BigInt
  const big = split_largest_remainder(MAX, [MAX, MAX, MAX]);
  assert.equal(sum_minor(big.slice(0, 2)) + big[2], MAX);
});

test('TST-18 mul_div: BigInt выше 2^53', () => {
  assert.equal(mul_div(3, 2999999999999999, 2, 'half_even'), 4499999999999998);
  assert.equal(mul_div(5, 1999999999999999, 4), 2499999999999999);
  assert.ok(5 * 1999999999999999 > 2 ** 53, 'произведение действительно выше 2^53');
  throws_code(() => mul_div(MAX, 2, 1), 'E_OVERFLOW');
  assert.equal(mul_div(MAX, 2, 2), MAX);
  assert.equal(mul_div(-MAX, 3, 3), -MAX);
  throws_code(() => mul_div(1, 1, 0), 'E_SCHEMA');
  // налог и FX из §9.12
  assert.equal(mul_div(123457, 2100, 10000, 'half_even'), 25926);
  assert.equal(mul_div(200000, 9250, 10000), 185000);
  assert.equal(mul_div(279000, 2000, 10000), 55800);
  assert.equal(mul_div(3000, 5580, 60), 279000);
  assert.equal(mul_div(3000, 2400 * 10000 + 360 * 15000, 600000), 147000);
  assert.equal(mul_div(3000, 2400 * 10000 + 1 * 12500, 600000, 'half_even'), 120062);
  assert.equal(mul_div(3000, 2400 * 10000 + 1 * 12500, 600000, 'half_up'), 120063);
});

test('TST-51 mul_div: оракул BigInt, переполнение — только E_OVERFLOW', () => {
  const rng = make_rng(18);
  const nums = [0, 1, -1, MAX, -MAX, 10000, 9999, 2100, 15000];
  for (const mode of ['half_even', 'half_up', 'floor', 'ceil']) {
    for (let i = 0; i < 2500; i++) {
      const a = rng.bool() ? rng.pick(nums) : rand_safe(rng, rng.int(1, 53));
      const num = rng.bool() ? rng.pick(nums) : rand_safe(rng, rng.int(1, 53));
      const den = rng.bool() ? rng.pick([1, 2, 10000, 600000, MAX]) : Math.max(1, Math.abs(rand_safe(rng, rng.int(1, 53))));
      const want = oracle_round_div(BigInt(a) * BigInt(num), BigInt(den), mode);
      if (want > BigInt(MAX) || want < -BigInt(MAX)) throws_code(() => mul_div(a, num, den, mode), 'E_OVERFLOW');
      else assert.equal(mul_div(a, num, den, mode), Number(want), `${mode}: ${a}·${num}/${den}`);
    }
  }
  // ставки 0…10000 bp
  for (let bp = 0; bp <= 10000; bp += 137) {
    for (const a of [0, 1, -1, MAX, -MAX, 999999999999]) {
      assert.equal(mul_div(a, bp, 10000), Number(oracle_round_div(BigInt(a) * BigInt(bp), 10000n, 'half_even')));
    }
  }
});

test('sum_minor: сумма и переполнение; gcd: BigInt', () => {
  assert.equal(sum_minor([]), 0);
  assert.equal(sum_minor([1, 2, 3, -6]), 0);
  assert.equal(sum_minor([MAX, -MAX, 5]), 5);
  throws_code(() => sum_minor([MAX, 1]), 'E_OVERFLOW');
  throws_code(() => sum_minor([MAX, MAX]), 'E_OVERFLOW');
  throws_code(() => sum_minor([1, 1.5]), 'E_NOT_INTEGER');
  assert.equal(gcd(12, 18), 6n);
  assert.equal(gcd(-12, 18), 6n);
  assert.equal(gcd(0, 5), 5n);
  assert.equal(gcd(0, 0), 0n);
  assert.equal(gcd(9250, 10000), 250n);
  assert.equal(typeof gcd(1, 1), 'bigint');
  assert.equal(gcd(MAX, MAX - 1), 1n);
});

test('реестр валют: показатели, крипта, регистрация', () => {
  assert.equal(currency_exponent('EUR'), 2);
  assert.equal(currency_exponent('JPY'), 0);
  assert.equal(currency_exponent('BTC'), 8);
  assert.equal(currency_kind('BTC'), 'crypto');
  assert.equal(currency_kind('USD'), 'fiat');
  throws_code(() => currency_exponent('XXX9'), 'E_SCHEMA');
  register_currency('TSTCOIN', 6, 'crypto');
  assert.equal(currency_exponent('TSTCOIN'), 6);
  register_currency('TSTCOIN', 6, 'crypto'); // идемпотентно
  throws_code(() => register_currency('TSTCOIN', 7, 'crypto'), 'E_SCHEMA');
  throws_code(() => register_currency('eur', 2, 'fiat'), 'E_SCHEMA');
  throws_code(() => register_currency('TSTX', 99, 'fiat'), 'E_SCHEMA');
  throws_code(() => register_currency('TSTX', 2, 'gold'), 'E_SCHEMA');
});

test('TST-19 parse_minor / format_minor: канонические векторы', () => {
  assert.equal(parse_minor('-1.234,56', { decimal: ',', thousands: '.', exponent: 2 }), -123456);
  assert.equal(format_minor(-123456, 2, { decimal: ',', thousands: ' ' }), '-1 234,56');
  assert.equal(parse_minor('19.99', { decimal: '.', thousands: '', exponent: 2 }), 1999, '19.99 без float');
  assert.equal(parse_minor('1.234,56', { decimal: ',', thousands: '.', exponent: 2 }), 123456);
  assert.equal(parse_minor('1,234.56', { decimal: '.', thousands: ',', exponent: 2 }), 123456);
  assert.equal(parse_minor('1 234,56', { decimal: ',', thousands: ' ', exponent: 2 }), 123456);
  assert.equal(parse_minor('1 234,56', { decimal: ',', thousands: ' ', exponent: 2 }), 123456, 'неразрывный пробел как разделитель тысяч');
  assert.equal(parse_minor('0,5', { decimal: ',', thousands: '.', exponent: 2 }), 50);
  assert.equal(parse_minor(',5', { decimal: ',', thousands: '.', exponent: 2 }), 50);
  assert.equal(parse_minor('+12', { decimal: ',', thousands: '', exponent: 2 }), 1200);
  assert.equal(parse_minor('−12,30', { decimal: ',', thousands: '', exponent: 2 }), -1230);
  assert.equal(parse_minor('  45 ', { decimal: '.', thousands: '', exponent: 2 }), 4500);
  assert.equal(parse_minor('1234', { decimal: ',', thousands: '.', exponent: 2 }), 123400, 'без разделителей тоже можно');
  assert.equal(parse_minor('100', { decimal: '.', thousands: '', exponent: 0 }), 100);
  assert.equal(parse_minor('0.0015', { decimal: '.', thousands: '', exponent: 8 }), 150000);
  assert.ok(Object.is(parse_minor('-0', { decimal: '.', thousands: '', exponent: 2 }), 0), '−0 → 0');
  assert.equal(parse_minor('90071992547409.91', { decimal: '.', thousands: '', exponent: 2 }), MAX);
});

test('TST-19 parse_minor: отказы (мусор, лишние знаки, переполнение)', () => {
  const o = { decimal: ',', thousands: '.', exponent: 2 };
  for (const bad of ['', '   ', '-', 'abc', '1,2,3', '1,234', '1.23.4', '12,', '1..234,00', '1.2345,00', '12.34.567,00', '--1', '1-', '1e3', '١٢٣']) {
    throws_code(() => parse_minor(bad, o), 'E_NOT_INTEGER', JSON.stringify(bad));
  }
  throws_code(() => parse_minor('1.5', { decimal: '.', thousands: '', exponent: 0 }), 'E_NOT_INTEGER');
  throws_code(() => parse_minor('90071992547409.92', { decimal: '.', thousands: '', exponent: 2 }), 'E_OVERFLOW');
  throws_code(() => parse_minor(5, { decimal: '.', exponent: 2 }), 'E_NOT_INTEGER');
  throws_code(() => parse_minor('1', { decimal: '.', thousands: '.', exponent: 2 }), 'E_SCHEMA');
  throws_code(() => parse_minor('1', { decimal: '.', exponent: -1 }), 'E_SCHEMA');
  throws_code(() => parse_minor('1', { decimal: '.' }), 'E_SCHEMA');
});

test('TST-19 format_minor: формы, нули и знаки', () => {
  assert.equal(format_minor(0, 2), '0.00');
  assert.equal(format_minor(5, 2), '0.05');
  assert.equal(format_minor(-5, 2, { decimal: ',' }), '-0,05');
  assert.equal(format_minor(100, 0), '100');
  assert.equal(format_minor(1234567, 2, { decimal: '.', thousands: ',' }), '12,345.67');
  assert.equal(format_minor(123, 2, { decimal: ',', thousands: ' ' }), '1,23');
  assert.equal(format_minor(100000, 2, { decimal: ',', thousands: ' ' }), '1 000,00');
  assert.equal(format_minor(150000, 8), '0.00150000');
  assert.equal(format_minor(MAX, 2), '90071992547409.91');
  assert.equal(format_minor(-MAX, 0, { thousands: ' ' }), '-9 007 199 254 740 991');
  assert.equal(format_minor(NUMBER_FORMATS.ru && 205500, 2, NUMBER_FORMATS.ru), '2 055,00');
  assert.equal(format_minor(205500, 2, NUMBER_FORMATS.en), '2,055.00');
  throws_code(() => format_minor(1.5, 2), 'E_NOT_INTEGER');
  throws_code(() => format_minor(1, 99), 'E_SCHEMA');
});

test('TST-19 / TST-51 round-trip parse(format(x)) = x для ru и en на классах 0, ±1, ±(2^53−1), случайные', () => {
  const rng = make_rng(19);
  const xs = [0, 1, -1, 99, -99, 100, -100, 101, 999, 1000, 100000, MAX, -MAX, MAX - 1, 1 - MAX];
  for (let i = 0; i < 3000; i++) xs.push(rand_safe(rng, rng.int(1, 53)));
  for (const x of xs) {
    for (const exp of [0, 2, 3, 8]) {
      for (const fmt of [NUMBER_FORMATS.ru, NUMBER_FORMATS.en, { decimal: '.', thousands: '' }, { decimal: ',', thousands: '.' }]) {
        const s = format_minor(x, exp, fmt);
        assert.equal(parse_minor(s, { ...fmt, exponent: exp }), x, `${x} exp=${exp} → «${s}»`);
      }
    }
  }
});

test('TST-51 суммы 0, ±1, ±(2^53−1) во всех операциях money не бросают необработанных исключений', () => {
  const vals = [0, 1, -1, MAX, -MAX];
  const run = (fn) => {
    try { return fn(); } catch (e) {
      assert.ok(e instanceof RunwayError, `необработанное исключение: ${e}`);
      return e.code;
    }
  };
  for (const a of vals) for (const b of vals) {
    run(() => floor_div(a, b)); run(() => ceil_div(a, b)); run(() => floor_mod(a, b));
    for (const mode of ['half_even', 'half_up', 'floor', 'ceil']) { run(() => round_div(a, b, mode)); run(() => mul_div(a, b, 1, mode)); run(() => mul_div(a, b, 10000, mode)); }
    run(() => split_equal(a, Math.abs(b) || 1));
    run(() => split_largest_remainder(a, [Math.abs(b), 1]));
    run(() => sum_minor([a, b]));
    run(() => gcd(a, b));
  }
  assert.equal(sum_minor(split_equal(MAX, 7)), MAX);
  assert.equal(sum_minor(split_equal(-MAX, 7)), -MAX);
  assert.equal(sum_minor(split_largest_remainder(-MAX, [1, 2, 3])), -MAX);
});

// FP-12 (REQ-175, мутация M32): число частей split_equal проверяется собственной причиной, а не побочным отказом деления на ноль.
test('REQ-175 TST-17 split_equal: ноль, отрицательное и чрезмерное число частей — E_SCHEMA со своей причиной (parts_lt_1, too_many_parts), а не отказ деления', () => {
  for (const [n, reason] of [[0, 'parts_lt_1'], [-1, 'parts_lt_1'], [-1000, 'parts_lt_1'], [10_000_001, 'too_many_parts']]) {
    assert.throws(() => split_equal(100, n), (e) => e.name === 'RunwayError' && e.code === 'E_SCHEMA' && e.ctx.reason === reason && e.ctx.value === n, `n = ${n}`);
  }
  assert.deepEqual(split_equal(100, 1), [100]);
  assert.deepEqual(split_equal(0, 3), [0, 0, 0]);
});
