// helpers.mjs — общая оснастка тестов: детерминированный ГПСЧ, проверка кода ошибки, фабрики правил.
// В ТЕСТАХ допустимы Date и node:*, в engine/ — нет (см. purity.test.mjs).

import assert from 'node:assert/strict';

/**
 * Детерминированный ГПСЧ mulberry32 (seed → последовательность). Только для тестов.
 * @param {number} seed
 * @returns {{next: () => number, int: (lo: number, hi: number) => number, pick: <T>(xs: T[]) => T, bool: () => boolean}}
 */
export function make_rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    /** Целое в [lo, hi] включительно (диапазон до 2^32). */
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (xs) => xs[Math.floor(next() * xs.length)],
    bool: () => next() < 0.5,
  };
}

/**
 * Случайное целое во всём безопасном диапазоне: комбинирует два 32-битных куска через BigInt.
 * @param {ReturnType<typeof make_rng>} rng
 * @param {number} [bits] ширина модуля (до 53)
 * @returns {number}
 */
export function rand_safe(rng, bits = 53) {
  const hi = BigInt(Math.floor(rng.next() * 2 ** 21));
  const lo = BigInt(Math.floor(rng.next() * 2 ** 32));
  let v = ((hi << 32n) | lo) >> BigInt(53 - bits); // 0 .. 2^bits − 1
  if (rng.bool()) v = -v;
  return Number(v);
}

/** Проверить, что `fn` бросает RunwayError с кодом `code`. */
export function throws_code(fn, code, msg) {
  assert.throws(fn, (e) => {
    assert.equal(e?.name, 'RunwayError', msg ?? `ожидалась RunwayError(${code}), получено: ${e}`);
    assert.equal(e.code, code, msg ?? `код ошибки: ${e.code} ≠ ${code}`);
    return true;
  });
}

/** Минимальное правило для тестов повторения (со знаком суммы по `kind`). */
export function mk_rule(over = {}) {
  return {
    rule_id: 'R-TEST', account_id: 'acc_main', name: 'Тест', kind: 'expense', amount: { exp_minor: -10000 },
    currency: 'EUR', freq: 'M', interval: 1, start_date: '2026-01-31', month_end: 'clamp', weekend: 'keep',
    calendar_id: null, exdates: [], is_obligation: false, is_estimate: false, tag: 'тест', ...over,
  };
}

/** Правила G-001 (design-brief §9.1, C-011): начала серий — как в каноне. */
export function g001_rules() {
  const base = { account_id: 'acc_main', kind: 'expense', currency: 'EUR', freq: 'M', interval: 1, month_end: 'clamp', weekend: 'next', calendar_id: null, exdates: [] };
  return [
    { ...base, rule_id: 'R-RENT', name: 'Аренда', amount: { exp_minor: -90000 }, by_monthday: [25], start_date: '2026-01-25', is_obligation: true, is_estimate: false, tag: 'аренда' },
    { ...base, rule_id: 'R-UTIL', name: 'ЖКХ', amount: { exp_minor: -12000 }, by_monthday: [25], start_date: '2026-01-25', is_obligation: true, is_estimate: false, tag: 'жкх' },
    { ...base, rule_id: 'R-PHONE', name: 'Связь', amount: { exp_minor: -2500 }, by_monthday: [9], start_date: '2026-01-09', is_obligation: true, is_estimate: false, tag: 'связь' },
    { ...base, rule_id: 'R-GROC', name: 'Продукты', amount: { exp_minor: -10000 }, freq: 'W', by_weekday: [6], start_date: '2026-01-03', weekend: 'keep', is_obligation: false, is_estimate: true, tag: 'продукты' },
  ];
}

/** Числа EpochDay из канона §9.1 / §9.10. */
export const G001 = Object.freeze({
  as_of: 20730, // 2026-10-04
  horizon_end: 20787, // 2026-11-30
});
