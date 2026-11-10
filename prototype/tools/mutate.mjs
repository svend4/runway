#!/usr/bin/env node
// mutate.mjs — мутационная проверка арифметики и дат (FP-12, REQ-175, TST-52): каждая мутация (`<` ↔ `≤`, смена знака, режима округления, сдвиг константы) портит ОДНУ строку
// engine/money.mjs или engine/dates.mjs, и хотя бы один тест обязан покраснеть; в первую очередь — замок арифметики tests/arith.lock.json (574 случая) и модульные тесты.
// Работает ТОЛЬКО на копии во временном каталоге (`--work-dir`, обязательный ключ): рабочее дерево не меняется, каталог внутри prototype/ отвергается. Мутанты идут строго по одному,
// каждый — отдельными процессами `node --test` по одному файлу (память). Неубитый мутант не молчит: он попадает в список `survivors` результата (`_ops/mutation.json`) и в задачи.
// Эквивалентный мутант (порча не меняет поведения на достижимых входах) помечается `equivalent: 'почему'`, выживает по замыслу и в `survivors` не попадает; если такой мутант вдруг убит — это ошибка пометки.
//   node tools/mutate.mjs --work-dir <каталог вне проекта> [--only M01,D03] [--limit N] [--dry-run] [--date ГГГГ-ММ-ДД] [--out ../_ops/mutation.json] [--no-write]
// FP-24: ключ `--catalog engine` — каталог мутаций расчётного ядра (timeline, afford, sinking, tax, fx, verifier; `MUTANTS_ENGINE`): та же работа на копии вне проекта, мутанты по одному,
// результат пишется в раздел `engine` файла `_ops/mutation.json` (прежние поля money/dates не меняются); `--annotate` дописывает причины выживших из поля `unkilled` каталога без запуска тестов.
// Исправление D4 (после независимой проверки): `--catalog engine --nets` запускает КАЖДОГО проверяющего независимо (не останавливаясь на первом убившем) и пишет в результат, какая сеть
// (тесты модуля, property-тесты, замок вывода, golden) что убила, какие инварианты TST-31…39 назвали property-тесты и кого не видит ни одна из трёх сетей поперёк модулей (`nets_summary`).
// `--dry-run` только применяет каждую мутацию к копии (проверка, что строка нашлась ровно один раз) и тесты не запускает. Дата — аргумент: часы инструмент не читает.
// Инструмент вне engine/: node:* и process допустимы. Расчёт по введённым данным и правилам, не консультация.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PROTO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Файлы тестов, которые идут в копию (замок арифметики и модульные тесты арифметики и дат). Порядок — порядок проверки: сначала замок. */
export const KILLERS = Object.freeze({
  money: ['tests/arith.test.mjs', 'tests/money.test.mjs', 'tests/adversarial/dates_money.test.mjs'],
  dates: ['tests/dates.test.mjs', 'tests/adversarial/dates_money.test.mjs', 'tests/arith.test.mjs'],
});
const COPY_FILES = ['package.json', 'tests/helpers.mjs', 'tests/arith.lock.json', ...new Set(Object.values(KILLERS).flat())];

const M = 'engine/money.mjs';
const D = 'engine/dates.mjs';

/**
 * Каталог мутаций. `find` — точный фрагмент исходника, который встречается в файле РОВНО один раз; `replace` — его порча; `what` — что именно испорчено.
 * Номера не переиспользуются: убитый и неубитый мутант остаются в каталоге навсегда.
 */
export const MUTANTS = Object.freeze([
  { id: 'M01', file: M, find: '  if (r < 0) q -= 1;\n  return q + 0;', replace: '  if (r > 0) q -= 1;\n  return q + 0;', what: 'floor_div: знак условия поправки отрицательного остатка (< → >)' },
  { id: 'M02', file: M, find: 'return (r < 0 ? r + y : r) + 0;', replace: 'return (r < 0 ? r - y : r) + 0;', what: 'floor_mod: остаток отрицательного числа вычитает делитель вместо прибавления' },
  { id: 'M03', file: M, find: 'return 0 - floor_div(0 - assert_minor(a), b);', replace: 'return floor_div(assert_minor(a), b);', what: 'ceil_div: округление вверх подменено округлением вниз' },
  { id: 'M04', file: M, find: "  if (v <= 0) fail('E_SCHEMA', { reason: 'divisor_not_positive', value: String(b) });", replace: "  if (v < 0) fail('E_SCHEMA', { reason: 'divisor_not_positive', value: String(b) });", what: 'pos_divisor: нулевой делитель допущен (≤ → <)' },
  { id: 'M05', file: M, find: "  if (d <= 0n) fail('E_SCHEMA', { reason: 'divisor_not_positive', value: d.toString() + 'n' });", replace: "  if (d < 0n) fail('E_SCHEMA', { reason: 'divisor_not_positive', value: d.toString() + 'n' });", what: 'round_div_big: нулевой знаменатель допущен (≤ → <)' },
  { id: 'M06', file: M, find: "case 'ceil': return r > 0n ? q + 1n : q;", replace: "case 'ceil': return r >= 0n ? q + 1n : q;", what: 'round_div_big, ceil: точное деление округляется вверх (> → ≥)' },
  { id: 'M07', file: M, find: 'if (t < d) return q;', replace: 'if (t <= d) return q;', what: 'round_div_big, half_even: ничья уходит вниз (< → ≤)' },
  { id: 'M08', file: M, find: 'return q % 2n === 0n ? q : q + 1n;', replace: 'return q % 2n === 0n ? q + 1n : q;', what: 'round_div_big, half_even: ничья к нечётному вместо чётного' },
  { id: 'M09', file: M, find: 'if (t === d) return n >= 0n ? q + 1n : q;', replace: 'if (t === d) return n > 0n ? q + 1n : q;', what: 'round_div_big, half_up: граница знака при ничьей (≥ → >)', equivalent: 'при n = 0 остаток 0 не даёт ничьей (0 < d/2), поэтому «n ≥ 0» и «n > 0» на достижимых входах неотличимы' },
  { id: 'M10', file: M, find: 'if (t > d) return q + 1n;\n      if (t === d) return n >= 0n', replace: 'if (t >= d) return q + 1n;\n      if (t === d) return n >= 0n', what: 'round_div_big, half_up: ничья вверх всегда (> → ≥)' },
  { id: 'M11', file: M, find: 'if (t < y) return q;', replace: 'if (t <= y) return q;', what: 'round_div, half_even: ничья уходит вниз (< → ≤)' },
  { id: 'M12', file: M, find: 'return q % 2 === 0 ? q : q + 1;', replace: 'return q % 2 === 0 ? q + 1 : q;', what: 'round_div, half_even: ничья к нечётному вместо чётного' },
  { id: 'M13', file: M, find: 'if (t === y) return x >= 0 ? q + 1 : q;', replace: 'if (t === y) return x > 0 ? q + 1 : q;', what: 'round_div, half_up: граница знака при ничьей (≥ → >)', equivalent: 'при x = 0 остаток 0 не даёт ничьей (0 < y/2), поэтому «x ≥ 0» и «x > 0» на достижимых входах неотличимы' },
  { id: 'M14', file: M, find: "case 'ceil': return r > 0 ? q + 1 : q;", replace: "case 'ceil': return r >= 0 ? q + 1 : q;", what: 'round_div, ceil: точное деление округляется вверх (> → ≥)' },
  { id: 'M15', file: M, find: 'const t = 2 * r;', replace: 'const t = 2 * r + 1;', what: 'round_div: удвоенный остаток сдвинут на единицу' },
  { id: 'M16', file: M, find: 'to_big(a) * to_big(num), to_big(den), mode', replace: 'to_big(a) * to_big(den), to_big(num), mode', what: 'mul_div: числитель и знаменатель поменяны местами' },
  { id: 'M17', file: M, find: 'const v = k < rem ? base + 1 : base;', replace: 'const v = k <= rem ? base + 1 : base;', what: 'split_equal: лишняя единица достаётся ещё одной части (< → ≤)' },
  { id: 'M18', file: M, find: 'out[k] = neg ? 0 - v : v;', replace: 'out[k] = neg ? v : 0 - v;', what: 'split_equal: знак частей отрицательной суммы перевёрнут' },
  { id: 'M19', file: M, find: '(frac[i] === frac[j] ? i - j :', replace: '(frac[i] === frac[j] ? j - i :', what: 'split_largest_remainder: при равных остатках лишнее достаётся большему индексу' },
  { id: 'M20', file: M, find: 'for (let r = 0; r < rest; r++) base[order[r]] += 1n;', replace: 'for (let r = 0; r <= rest; r++) base[order[r]] += 1n;', what: 'split_largest_remainder: лишних единиц на одну больше (< → ≤)' },
  { id: 'M21', file: M, find: "if (v < 0) fail('E_SCHEMA', { reason: 'weight_negative', value: v });", replace: "if (v <= 0) fail('E_SCHEMA', { reason: 'weight_negative', value: v });", what: 'split_largest_remainder: нулевой вес отвергнут (< → ≤)' },
  { id: 'M22', file: M, find: "if (!Number.isSafeInteger(acc)) fail('E_OVERFLOW', { reason: 'sum' });", replace: "if (false) fail('E_OVERFLOW', { reason: 'sum' });", what: 'sum_minor: проверка переполнения суммы снята' },
  { id: 'M23', file: M, find: 'if (x < 0n) x = -x;', replace: 'if (x > 0n) x = -x;', what: 'gcd: модуль первого аргумента берётся у положительных (< → >)' },
  { id: 'M24', file: M, find: "if (frac.length > exponent) fail('E_NOT_INTEGER', { reason: 'too_many_decimals', input: str });", replace: "if (frac.length >= exponent) fail('E_NOT_INTEGER', { reason: 'too_many_decimals', input: str });", what: 'parse_minor: допустимое число знаков дроби на единицу меньше (> → ≥)' },
  { id: 'M25', file: M, find: "neg = s[0] !== '+';", replace: "neg = s[0] === '+';", what: 'parse_minor: знак «+» читается как минус' },
  { id: 'M26', file: M, find: 'return assert_minor(neg ? -mag : mag);', replace: 'return assert_minor(neg ? mag : -mag);', what: 'parse_minor: итоговый знак перевёрнут' },
  { id: 'M27', file: M, find: 'if (i > 0 && (digits.length - i) % 3 === 0) grouped += thousands;', replace: 'if (i > 0 && (digits.length - i) % 3 === 1) grouped += thousands;', what: 'format_minor: группы тысяч сдвинуты на цифру' },
  { id: 'M28', file: M, find: "return (v < 0 ? '-' : '') + digits +", replace: "return (v <= 0 ? '-' : '') + digits +", what: 'format_minor: у нуля появляется минус (< → ≤)' },
  { id: 'M29', file: M, find: "digits = digits.padStart(exponent + 1, '0');", replace: "digits = digits.padStart(exponent, '0');", what: 'format_minor: нет ведущего нуля у сумм меньше единицы' },
  { id: 'M30', file: M, find: "if (!Number.isSafeInteger(x)) fail('E_OVERFLOW', { value: String(x) });", replace: "if (false) fail('E_OVERFLOW', { value: String(x) });", what: 'assert_minor: проверка безопасного диапазона снята' },
  { id: 'M31', file: M, find: 'if (x > BIG_MAX || x < -BIG_MAX)', replace: 'if (x >= BIG_MAX || x < -BIG_MAX)', what: 'assert_minor: верхняя граница BigInt сдвинута на единицу (> → ≥)' },
  { id: 'M32', file: M, find: "if (parts < 1) fail('E_SCHEMA', { reason: 'parts_lt_1', value: parts });", replace: "if (parts < 0) fail('E_SCHEMA', { reason: 'parts_lt_1', value: parts });", what: 'split_equal: ноль частей допущен (< 1 → < 0)' },
  { id: 'M33', file: M, find: "'[0-9]{3})+$'", replace: "'[0-9]{2})+$'", what: 'parse_minor: группы тысяч по две цифры вместо трёх' },
  { id: 'M34', file: M, find: 'if (t === d) return n >= 0n ? q + 1n : q;', replace: 'if (t === d) return n < 0n ? q + 1n : q;', what: 'round_div_big, half_up: ничья округляется к нулю вместо «от нуля» (знак условия инвертирован)' },
  { id: 'M35', file: M, find: 'if (t === y) return x >= 0 ? q + 1 : q;', replace: 'if (t === y) return x < 0 ? q + 1 : q;', what: 'round_div, half_up: ничья округляется к нулю вместо «от нуля» (знак условия инвертирован)' },
  { id: 'D01', file: D, find: 'return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;', replace: 'return (y % 4 === 0 && y % 100 !== 0);', what: 'is_leap: правило 400 лет снято (2000 не високосный)' },
  { id: 'D02', file: D, find: 'return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;', replace: 'return (y % 4 === 0) || y % 400 === 0;', what: 'is_leap: правило столетий снято (2100 високосный)' },
  { id: 'D03', file: D, find: 'return m === 2 && is_leap(y) ? 29 : DAYS_IN_MONTH[m - 1];', replace: 'return m === 2 && is_leap(y) ? 28 : DAYS_IN_MONTH[m - 1];', what: 'days_in_month: в високосный год февраль без 29-го' },
  { id: 'D04', file: D, find: 'const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];', replace: 'const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 30];', what: 'DAYS_IN_MONTH: в декабре 30 дней' },
  { id: 'D05', file: D, find: 'const yy = y - (m <= 2 ? 1 : 0);', replace: 'const yy = y - (m < 2 ? 1 : 0);', what: 'days_from_civil: февраль относится к своему году (≤ → <)' },
  { id: 'D06', file: D, find: 'const doy = floor_div(153 * (m + (m > 2 ? -3 : 9)) + 2, 5) + d - 1;', replace: 'const doy = floor_div(153 * (m + (m > 3 ? -3 : 9)) + 2, 5) + d - 1;', what: 'days_from_civil: граница марта сдвинута (> 2 → > 3)' },
  { id: 'D07', file: D, find: 'const z = era * 146097 + doe - 719468;', replace: 'const z = era * 146097 + doe - 719469;', what: 'days_from_civil: начало отсчёта сдвинуто на день' },
  { id: 'D08', file: D, find: 'const m = mp + (mp < 10 ? 3 : -9);', replace: 'const m = mp + (mp <= 10 ? 3 : -9);', what: 'civil_from_days: граница месяца года сдвинута (< 10 → ≤ 10)' },
  { id: 'D09', file: D, find: 'const y = y0 + (m <= 2 ? 1 : 0);', replace: 'const y = y0 + (m < 2 ? 1 : 0);', what: 'civil_from_days: год февраля не увеличен (≤ → <)' },
  { id: 'D10', file: D, find: 'return floor_mod(d + 4, 7);', replace: 'return floor_mod(d + 3, 7);', what: 'dow: день недели сдвинут на единицу' },
  { id: 'D11', file: D, find: 'return days_from_civil(y2, m2, clamp_day(y2, m2, day));', replace: 'return days_from_civil(y2, m2, day);', what: 'add_months: день не зажимается до длины месяца' },
  { id: 'D12', file: D, find: 'const t = y * 12 + (m - 1) + n;', replace: 'const t = y * 12 + (m - 1) + n + 1;', what: 'add_months: месяцев на один больше' },
  { id: 'D13', file: D, find: 'return days_from_civil(y, m, days_in_month(y, m));', replace: 'return days_from_civil(y, m, days_in_month(y, m) - 1);', what: 'end_of_month: предпоследний день вместо последнего' },
  { id: 'D14', file: D, find: 'return b - a;', replace: 'return a - b;', what: 'diff_days: знак разности перевёрнут' },
  { id: 'D15', file: D, find: 'for (let i = 0; i < 100000 && !is_business(x, cal); i++) x += 1;', replace: 'for (let i = 0; i < 100000 && !is_business(x, cal); i++) x += 2;', what: 'next_business_day: шаг два дня' },
  { id: 'D16', file: D, find: 'i++) x -= 1;', replace: 'i++) x -= 2;', what: 'prev_business_day: шаг два дня' },
  { id: 'D17', file: D, find: 'if (c === n) return x;', replace: 'if (c === n - 1) return x;', what: 'nth_business_day: n-й рабочий день с начала месяца сдвинут' },
  { id: 'D18', file: D, find: 'if (c === -n) return x;', replace: 'if (c === -n + 1) return x;', what: 'nth_business_day: n-й рабочий день с конца месяца сдвинут' },
  { id: 'D19', file: D, find: "case 'skip': return is_business(d, cal) ? d : null;", replace: "case 'skip': return is_business(d, cal) ? null : d;", what: 'shift_by_policy, skip: рабочий и нерабочий дни поменяны местами' },
  { id: 'D20', file: D, find: 'return !c.weekend.has(dow(d)) && !c.holidays.has(d);', replace: 'return !c.weekend.has(dow(d)) || !c.holidays.has(d);', what: 'is_business: праздник в будний день считается рабочим (&& → ||)' },
  { id: 'D21', file: D, find: 'if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > days_in_month(y, mo)) fail(', replace: 'if (y < 0 || mo < 1 || mo > 12 || d < 1 || d > days_in_month(y, mo)) fail(', what: 'parse_date: год 0000 допущен (< 1 → < 0)' },
  { id: 'D22', file: D, find: 'if (y < 1 || y > 9999) fail(', replace: 'if (y < 0 || y > 9999) fail(', what: 'format_date: год 0000 допущен (< 1 → < 0)' },
  { id: 'D23', file: D, find: 'if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) fail(', replace: 'if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 13) fail(', what: 'days_in_month: месяц 13 допущен (> 12 → > 13)' },
  { id: 'D24', file: D, find: 'if (m < 1 || m > 12 || d < 1 || d > days_in_month(y, m)) fail(', replace: 'if (m < 1 || m > 12 || d < 1 || d > days_in_month(y, m) + 1) fail(', what: 'days_from_civil: на один день больше длины месяца допущено' },
  { id: 'D25', file: D, find: 'return add_months(d, 12 * n);', replace: 'return add_months(d, 11 * n);', what: 'add_years: год — 11 месяцев' },
  { id: 'D26', file: D, find: 'return Math.min(day, days_in_month(y, m));', replace: 'return Math.max(day, days_in_month(y, m));', what: 'clamp_day: min → max' },
]);

// ═══ FP-24 (REQ-175, REQ-171): каталог для расчётного ядра — timeline, afford, sinking, tax, fx, verifier ═══════════════════════════════════════════════════════════
// Отдельный каталог: прежний `MUTANTS` (money, dates) и его результат в `_ops/mutation.json` не менялись. Каждая порча — точечная замена в КОПИИ файла во временном каталоге
// (рабочее дерево не трогается): граница `<` ↔ `≤`, смена знака, min ↔ max, подмена константы или переменной. Проверяют мутанта быстрые тесты модуля, затем property-тесты
// (tests/properties.test.mjs на малом N), golden G-001 и замок вывода движка (tests/engine_lock.test.mjs, 500 журналов): замок ловит любую порчу, которая меняет хоть один вывод.
// Поле `unkilled` — причина, по которой выживший мутант допустим (заполняется после прогона; в хэш каталога не входит); `equivalent` — порча не меняет поведения.

const TL = 'engine/timeline.mjs';
const AF = 'engine/afford.mjs';
const SK = 'engine/sinking.mjs';
const TX = 'engine/tax.mjs';
const FXM = 'engine/fx.mjs';
const VR = 'engine/verifier.mjs';

export const MUTANTS_ENGINE = Object.freeze([
  // timeline.mjs — ряды, эффективная дата, готовность, подсказки по истории, Q1, «почему»
  { id: 'T01', file: TL, find: '    trough[i] = assert_minor(bal + out[i]);', replace: '    trough[i] = assert_minor(bal + out[i] + inn[i]);', what: 'project: trough включает доходы того же дня (расходы раньше доходов нарушены)' },
  { id: 'T02', file: TL, find: '    if (amt < 0) out[i] = assert_minor(out[i] + amt);', replace: '    if (amt > 0) out[i] = assert_minor(out[i] + amt);', what: 'project: расходы и доходы поменялись местами (< → >)' },
  { id: 'T03', file: TL, find: 'const base = Math.max(to_epoch_day(e.plan_date ?? e.date), asof);', replace: 'const base = Math.min(to_epoch_day(e.plan_date ?? e.date), asof);', what: 'eff_date: base(e) = max(plan_date, as_of) заменён на min' },
  { id: 'T04', file: TL, find: "  if (e.kind === 'income') {\n    d = e.delay_days_worse", replace: "  if (e.kind === 'expense') {\n    d = e.delay_days_worse", what: 'eff_date: в режиме worse сдвигаются расходы вместо доходов' },
  { id: 'T05', file: TL, find: 'if (xs[i] < xs[idx]) idx = i;', replace: 'if (xs[i] <= xs[idx]) idx = i;', what: 'argmin_first: при равенстве побеждает поздняя дата (< → ≤)' },
  { id: 'T06', file: TL, find: 'if (sources.size >= 3 || significant) score += 1;', replace: 'if (sources.size > 3 || significant) score += 1;', what: 'readiness: порог «обязательств не меньше трёх» сдвинут (≥ → >)' },
  { id: 'T07', file: TL, find: "if (f.date > asof) fail('E_FUTURE_POSTED'", replace: "if (f.date >= asof) fail('E_FUTURE_POSTED'", what: 'opening_state: факт на дату as_of считается «из будущего» (> → ≥)' },
  { id: 'T08', file: TL, find: 'const windowed = planned.filter((e) => e.date >= pf(e.account_id));', replace: 'const windowed = planned.filter((e) => e.date > pf(e.account_id));', what: 'collect_planned: окно плана начинается со дня после якоря (≥ → >)' },
  { id: 'T09', file: TL, find: 'if (d === null || d > horizon_end) continue;', replace: 'if (d === null || d >= horizon_end) continue;', what: 'build_events_ex: событие на последний день горизонта отброшено (> → ≥)' },
  { id: 'T10', file: TL, find: 'return Math.max(base, o === null ? 0 : round_div(o, 300, w.params.rounding));', replace: 'return Math.min(base, o === null ? 0 : round_div(o, 300, w.params.rounding));', what: 'default_wave_threshold: max заменён на min' },
  { id: 'T11', file: TL, find: 'return mul_div(P.buffer_hint_days, o, 90, P.rounding);', replace: 'return mul_div(P.buffer_hint_days, o, 30, P.rounding);', what: 'buffer_hint: деление на 90 дней заменено делением на 30' },
  { id: 'T12', file: TL, find: 'const X = w.facts.filter((f) => f.date >= asof - 90 && f.date < asof && f.amount_minor < 0', replace: 'const X = w.facts.filter((f) => f.date > asof - 90 && f.date < asof && f.amount_minor < 0', what: 'outflow_90: граница 90-го дня исключена (≥ → >)' },
  { id: 'T13', file: TL, find: 'need: Math.max(0, assert_minor(buf - m)), close_on_D: series.close[idx],', replace: 'need: Math.max(0, assert_minor(buf + m)), close_on_D: series.close[idx],', what: 'answer_q1: «не хватает до буфера» считается как B + min вместо B − min' },
  { id: 'T14', file: TL, find: 'const W = events.filter((e) => e.amount_minor < 0 && e.date >= w0 && e.date <= t);', replace: 'const W = events.filter((e) => e.amount_minor < 0 && e.date >= w0 && e.date < t);', what: 'explain_narrowest: расходы самого дня узкой точки не входят в цепочку (≤ → <)' },
  { id: 'T15', file: TL, find: 'const base = last === null ? 0 : last.amount_minor;', replace: 'const base = last === null ? 0 : -last.amount_minor;', what: 'opening_state: знак остатка по якорю перевёрнут' },
  // afford.mjs — вердикт, S_max, earliest, check_purchase, гейт, «можно потратить»
  { id: 'A01', file: AF, find: "  if (m_plan < B) return 'TIGHT';", replace: "  if (m_plan <= B) return 'TIGHT';", what: 'verdict_of: граница буфера в plan исключена (< → ≤)' },
  { id: 'A02', file: AF, find: "  if (m_worse < B) return 'FRAGILE';", replace: "  if (m_worse <= B) return 'FRAGILE';", what: 'verdict_of: граница буфера в worse исключена (< → ≤)' },
  { id: 'A03', file: AF, find: 'return Math.max(0, assert_minor(M[Math.max(d, as_of) - as_of] - b));', replace: 'return Math.max(0, assert_minor(M[Math.max(d, as_of) - as_of] - b + 1));', what: 'max_amount: S_max на единицу выше' },
  { id: 'A04', file: AF, find: 'if (d > as_of + f.length - 1) return null;', replace: 'if (d >= as_of + f.length - 1) return null;', what: 'max_amount: последний день горизонта «вне горизонта» (> → ≥)' },
  { id: 'A05', file: AF, find: 'const need = assert_minor(s + b);', replace: 'const need = assert_minor(s - b);', what: 'earliest_date: буфер вычитается вместо прибавления' },
  { id: 'A06', file: AF, find: 'for (let i = 1; i < N; i++) cum[i] = assert_minor(cum[i] + cum[i - 1]);', replace: 'for (let i = 1; i < N; i++) cum[i] = assert_minor(cum[i] - cum[i - 1]);', what: 'check_purchase: накопление частей покупки считается с минусом' },
  { id: 'A07', file: AF, find: 'after[m] = free.map((x, i) => assert_minor(x - cum[i]));', replace: 'after[m] = free.map((x, i) => assert_minor(x + cum[i]));', what: 'check_purchase: покупка увеличивает свободные деньги вместо уменьшения' },
  { id: 'A08', file: AF, find: 'delta: assert_minor(min_of(free) - m_after)', replace: 'delta: assert_minor(m_after - min_of(free))', what: 'check_purchase: знак delta («насколько покупка снизила минимум») перевёрнут' },
  { id: 'A09', file: AF, find: "if (score < get_param(ctx.params, 'ready.q3')) reasons.push('readiness');", replace: "if (score <= get_param(ctx.params, 'ready.q3')) reasons.push('readiness');", what: 'gate: готовность, равная порогу, считается недостаточной (< → ≤)' },
  { id: 'A10', file: AF, find: 'sts: Math.max(0, assert_minor(min_free - b)),', replace: 'sts: Math.max(0, assert_minor(min_free + b)),', what: 'sts_core: «можно потратить» прибавляет буфер вместо вычитания' },
  { id: 'A11', file: AF, find: 'short_to_buffer: Math.max(0, assert_minor(b - min_free)),', replace: 'short_to_buffer: Math.max(0, assert_minor(b + min_free)),', what: 'sts_core: «не хватает до буфера» считается как B + min вместо B − min' },
  { id: 'A12', file: AF, find: 'Math.min(a + 30, to_epoch_day(ctx.horizon_end))', replace: 'Math.min(a + 31, to_epoch_day(ctx.horizon_end))', what: 'default_sts_horizon: окно по умолчанию 31 день вместо 30' },
  { id: 'A13', file: AF, find: 'M[i] = a[i] < M[i + 1] ? a[i] : M[i + 1];', replace: 'M[i] = a[i] > M[i + 1] ? a[i] : M[i + 1];', what: 'suffix_min: минимум заменён максимумом (< → >)' },
  { id: 'A14', file: AF, find: "{ id: 'buffer', v: 0 - need_buffer(B ?? ctx.buffer_minor) },", replace: "{ id: 'buffer', v: need_buffer(B ?? ctx.buffer_minor) },", what: 'sts_breakdown: строка буфера без знака минус (сумма строк ≠ min free − B)' },
  // sinking.mjs — накопления, ряд резервов, свободный остаток
  { id: 'S01', file: SK, find: 'const c = Math.min(ceil_div(rem, n - k), rem);', replace: 'const c = Math.min(floor_div(rem, n - k), rem);', what: 'contribution_plan: округление взноса вверх заменено округлением вниз' },
  { id: 'S02', file: SK, find: 'const c = rem === null ? fixed : Math.min(fixed, rem);', replace: 'const c = rem === null ? fixed : Math.max(fixed, rem);', what: 'contribution_plan_fixed: цель не ограничивает взнос (min → max)' },
  { id: 'S03', file: SK, find: 'if (from < d && d <= asof) parts.push(assert_minor(a.amount_minor));', replace: 'if (from <= d && d <= asof) parts.push(assert_minor(a.amount_minor));', what: 'reserve_open_ex: запись на дату funded_as_of учитывается повторно (< → ≤)' },
  { id: 'S04', file: SK, find: 'funded_open_minor: Math.max(0, total)', replace: 'funded_open_minor: total', what: 'reserve_open_ex: остаток резерва может уйти ниже нуля (обрезка снята)',
    unkilled: 'Выжил в прогоне 2026-10-27: в наборе проверяющих sinking (sinking.test, property-тесты, golden G-001, замок вывода движка) не было теста, где ручная или release-запись больше накопленного: ни одна из 500 журналов замка и ни один property-журнал не уводит резерв ниже нуля. Порчу убивает tests/hardening.test.mjs (TST-23 Q-20: funded_open_minor = 0 при излишке release); файл добавлен в набор KILLERS_ENGINE.sinking, мутант убит им при отдельном запуске --only S04 без записи в файл. В повторном прогоне 2026-10-28 (--nets) с расширенным набором S04 убит tests/hardening.test.mjs и больше не выживший; поле оставлено как история.' },
  { id: 'S05', file: SK, find: 'b.released[i] = Math.min(funded[id], pay[id][i]);', replace: 'b.released[i] = Math.max(funded[id], pay[id][i]);', what: 'reserve_series: высвобождение больше накопленного (min → max)' },
  { id: 'S06', file: SK, find: 'b.true_up[i] = pay[id][i] - b.released[i];', replace: 'b.true_up[i] = pay[id][i] + b.released[i];', what: 'reserve_series: доплата из свободных денег считается с плюсом' },
  { id: 'S07', file: SK, find: "if (a.source === 'income') tail[a.reserve_id][d - asof] += amt;", replace: "if (a.source !== 'income') tail[a.reserve_id][d - asof] += amt;", what: 'reserve_series: аллокации от доходов и взносы поменялись местами в дне' },
  { id: 'S08', file: SK, find: 'return trough.map((t, i) => assert_minor(t - reserve_trough[i]));', replace: 'return trough.map((t, i) => assert_minor(t + reserve_trough[i]));', what: 'free_series: резервы прибавляются к свободным деньгам' },
  { id: 'S09', file: SK, find: 'if (d !== null && s <= d && d < dd) out.add(d);', replace: 'if (d !== null && s <= d && d <= dd) out.add(d);', what: 'contribution_dates: срок включается в график взносов (< → ≤)' },
  // tax.mjs — налоговый конверт: аллокация, выбор версии, высвобождение, срок годности
  { id: 'X01', file: TX, find: "return mul_div(inc, rule.rate_bp, 10000, rule.rounding ?? 'half_even');", replace: "return mul_div(inc, rule.rate_bp, 1000, rule.rounding ?? 'half_even');", what: 'allocation_for_income: ставка в bp делится на 1000 вместо 10000' },
  { id: 'X02', file: TX, find: 'const released = Math.min(f, p);', replace: 'const released = Math.max(f, p);', what: 'release_on_payment: высвобождается больше накопленного (min → max)' },
  { id: 'X03', file: TX, find: 'return { released, true_up: p - released };', replace: 'return { released, true_up: p + released };', what: 'release_on_payment: доплата считается с плюсом' },
  { id: 'X04', file: TX, find: 'if (c > 0 || (c === 0 && r.version > best.version)) best = r;', replace: 'if (c < 0 || (c === 0 && r.version > best.version)) best = r;', what: 'rule_at: побеждает версия, записанная раньше (> → <)' },
  { id: 'X05', file: TX, find: '|| (e.tag !== null && e.tag !== undefined && (at.tags ?? []).includes(e.tag));', replace: '|| (e.tag !== null && e.tag !== undefined && (at.tags ?? []).includes(e.stream_id));', what: 'applies: правило по метке сверяет идентификатор потока вместо метки' },
  { id: 'X06', file: TX, find: 'if (hit.reduce((s, r) => s + r.rate_bp, 0) > 10000) fail(', replace: 'if (hit.reduce((s, r) => s + r.rate_bp, 0) >= 10000) fail(', what: 'allocations_for_events: сумма ставок ровно 100 % считается ошибкой (> → ≥)' },
  { id: 'X07', file: TX, find: 'const base_of = (e) => Math.max(to_epoch_day(e.plan_date ?? e.date), asof);', replace: 'const base_of = (e) => Math.min(to_epoch_day(e.plan_date ?? e.date), asof);', what: 'allocations_for_events: версия правила выбирается по min(plan_date, as_of)' },
  { id: 'X08', file: TX, find: "if (age <= rule.ttl_days) return 'fresh';", replace: "if (age < rule.ttl_days) return 'fresh';", what: 'rule_age_status: возраст ровно в срок годности уже «устарело» (≤ → <)' },
  { id: 'X09', file: TX, find: 'if (to_epoch_day(r.valid_from) > day) continue;', replace: 'if (to_epoch_day(r.valid_from) >= day) continue;', what: 'rule_at: правило не действует в день valid_from (> → ≥)' },
  // fx.mjs — курс как дробь, перевод, сценарий курса, выбор курса, свежесть
  { id: 'F01', file: FXM, find: 'const n = BigInt(v) * BigInt(nu) * 10n ** BigInt(qe);', replace: 'const n = BigInt(v) * BigInt(nu) * 10n ** BigInt(be);', what: 'convert_minor: экспонента валюты-источника вместо экспоненты результата' },
  { id: 'F02', file: FXM, find: 'const f = 10000 + bp;', replace: 'const f = 10000 - bp;', what: 'apply_shock: сдвиг курса в обратную сторону' },
  { id: 'F03', file: FXM, find: 'if (i === null || (c !== null && c.rd >= i.rd)) {', replace: 'if (i === null || (c !== null && c.rd > i.rd)) {', what: 'rate_at: при равной дате побеждает обратный курс, а не прямой (≥ → >)' },
  { id: 'F04', file: FXM, find: "return { num: pos_int(i.r.den, 'den'), den: pos_int(i.r.num, 'num'), date: i.rd, inverse: true };", replace: "return { num: pos_int(i.r.num, 'num'), den: pos_int(i.r.den, 'den'), date: i.rd, inverse: true };", what: 'rate_at: обратный курс не переворачивается' },
  { id: 'F05', file: FXM, find: 'const n = BigInt(b) * 10n ** BigInt(be);', replace: 'const n = BigInt(b) * 10n ** BigInt(qe);', what: 'implied_rate: экспоненты ног перепутаны' },
  { id: 'F06', file: FXM, find: 'return { age, stale: age > stale_days };', replace: 'return { age, stale: age >= stale_days };', what: 'rate_status: курс возраста ровно stale_days уже устарел (> → ≥)' },
  { id: 'F07', file: FXM, find: 'if (rd > day) continue; // курс из «будущего» — не spot', replace: 'if (rd >= day) continue; // курс из «будущего» — не spot', what: 'rate_at: курс на дату расчёта считается «из будущего» (> → ≥)' },
  // verifier.mjs — проверка чисел и дат в ответе: структура, сверка с evidence, рендер
  { id: 'V01', file: VR, find: "if (!refs.includes(id)) V.push({ code: 'V_PLACEHOLDER', claim: i });", replace: "if (refs.includes(id)) V.push({ code: 'V_PLACEHOLDER', claim: i });", what: 'check_structure: условие нарушения V_PLACEHOLDER инвертировано' },
  { id: 'V02', file: VR, find: "if (has_raw_digit(text)) V.push({ code: 'V_RAW_DIGIT', claim: i });", replace: "if (!has_raw_digit(text)) V.push({ code: 'V_RAW_DIGIT', claim: i });", what: 'check_structure: условие нарушения V_RAW_DIGIT инвертировано' },
  { id: 'V03', file: VR, find: "if ((sc.scenario_id ?? null) !== (r.scope.scenario_id ?? null)) V.push({ code: 'V_SCOPE', claim: i });", replace: "if ((sc.scenario_id ?? null) === (r.scope.scenario_id ?? null)) V.push({ code: 'V_SCOPE', claim: i });", what: 'check_structure: сценарий утверждения сверяется наоборот' },
  { id: 'V04', file: VR, find: "const allowed = sc.mode === 'both' ? new Set(['plan', 'worse']) : new Set([sc.mode]);", replace: "const allowed = sc.mode === 'both' ? new Set(['plan']) : new Set([sc.mode]);", what: 'check_structure: область «оба режима» разрешает только plan' },
  { id: 'V05', file: VR, find: "if (!pool.some((ev) => match_quantity(q, ev))) V.push({ code: 'V_NO_MATCH'", replace: "if (!pool.every((ev) => match_quantity(q, ev))) V.push({ code: 'V_NO_MATCH'", what: 'verify_text: число должно совпасть со всеми доказательствами, а не с одним (some → every)' },
  { id: 'V06', file: VR, find: "if ((q.kind === 'money' && q.dp > currency_exponent(q.cur))", replace: "if ((q.kind === 'money' && q.dp >= currency_exponent(q.cur))", what: 'verify_text: сумма с полным числом знаков считается слишком точной (> → ≥)' },
  { id: 'V07', file: VR, find: "const scale = 10n ** BigInt(exp - q.dp);\n      let m = BigInt(q.digits) * scale;\n      if (q.neg) m = -m;\n      const v = BigInt(ev.v);\n      if (m !== 0n && (m < 0n) !== (v < 0n)) return false;", replace: "const scale = 10n ** BigInt(exp - q.dp);\n      let m = BigInt(q.digits) * scale;\n      if (q.neg) m = -m;\n      const v = BigInt(ev.v);", what: 'match_quantity: знак суммы в тексте не сверяется со знаком доказательства',
    equivalent: 'проверка знака избыточна: при m ≠ 0 число цифр ≥ 1, значит |m| ≥ scale, а при разных знаках |m − v| = |m| + |v| > scale / 2, так что допуск 2·|m − v| ≤ scale всё равно ложен; при v = 0 и m ≠ 0 то же (|m − 0| ≥ scale); при m = 0 проверка пропускалась и прежде' },
  { id: 'V08', file: VR, find: 'return q.m === m && q.d === d && (q.y === null || q.y === y);', replace: 'return q.m === m || q.d === d && (q.y === null || q.y === y);', what: 'match_quantity: дата совпадает при равном месяце ИЛИ дне (&& → ||)' },
  { id: 'V09', file: VR, find: 'const whole = Math.floor(abs / 100);', replace: 'const whole = Math.ceil(abs / 100);', what: 'render_value: целая часть процента округляется вверх' },
  { id: 'V10', file: VR, find: "if (locale === 'ru') return d + ' ' + MONTHS_RU[m - 1] + (show_year ? ' ' + y : '');", replace: "if (locale === 'ru') return d + ' ' + MONTHS_RU[m] + (show_year ? ' ' + y : '');", what: 'render_value: название месяца сдвинуто на один' },
  { id: 'V11', file: VR, find: 'const show_year = as_of === null || as_of === undefined ? false : Number(as_of.slice(0, 4)) !== y;', replace: 'const show_year = as_of === null || as_of === undefined ? false : Number(as_of.slice(0, 4)) === y;', what: 'render_value: год показывается у дат текущего года, а не чужого' },
  { id: 'V12', file: VR, find: "return ev.kind === 'days' && ev.v === q.n;", replace: "return ev.kind === 'days' && ev.v !== q.n;", what: 'match_quantity: число дней совпадает при неравенстве' },
]);

/** Быстрые проверяющие для мутаций ядра: тесты модуля, property-тесты на малом N, golden G-001, замок вывода движка (только проверка вывода, ≈ 4 с). */
const PROP_FAST = { file: 'tests/properties.test.mjs', env: { PROP_N: '40' }, pattern: 'TST-3[1-9] Свойство' };
const LOCK_FAST = { file: 'tests/engine_lock.test.mjs', pattern: 'вывод analyze каждого из 500 журналов' };
const GOLDEN = { file: 'tests/g001.golden.test.mjs' };
/**
 * Три «сети» поперёк модулей (FP-24, исправление D4): property-тесты, замок вывода движка, golden G-001. Остальные проверяющие — тесты самого модуля (`module`).
 * Режим `--nets` запускает КАЖДОГО проверяющего независимо (не останавливаясь на первом убившем) и записывает, какая сеть что убила: так видно, кого не замечает ни одна из трёх сетей.
 */
export const NETS = Object.freeze({ properties: PROP_FAST, lock: LOCK_FAST, golden: GOLDEN });
/** Имя сети проверяющего: `properties`, `lock`, `golden` либо `module` (тесты модуля, hardening, verifier_io). */
export const net_of = (spec) => (spec.file === PROP_FAST.file ? 'properties' : spec.file === LOCK_FAST.file ? 'lock' : spec.file === GOLDEN.file ? 'golden' : 'module');
/** Имена тестов verifier.test.mjs, кроме TST-56 (линтер слов читает wiki/, её в копии нет): явный перечень по началам названий — отрицательный просмотр вперёд раннер не исключает. */
/** timeline.test.mjs без TST-54 (замер времени: зависит от нагрузки машины и не должен «убивать» мутантов случайно). */
const TIMELINE_NO_PERF = 'project \\(D-01|project:|argmin_first|answer_q1|runway_days|eff_date|параметры: flat_params|purchase_to_events|apply_scenario|opening_state|TST-57|TST-41|build_events|normalize_ws|outflow_90|explain_narrowest|TST-31|TST-34|TST-35|TST-36|TST-53|TST-33';
const VERIFIER_NO_LINT = 'TST-45|TST-47|TST-58|match_quantity|templates:|LABELS|Q3 с частью|verify_answer:|parse_command|a0_answer|answer_question|render';
export const KILLERS_ENGINE = Object.freeze({
  timeline: Object.freeze([{ file: 'tests/timeline.test.mjs', pattern: TIMELINE_NO_PERF }, PROP_FAST, GOLDEN, LOCK_FAST]),
  afford: Object.freeze([{ file: 'tests/afford.test.mjs' }, PROP_FAST, GOLDEN, LOCK_FAST]),
  sinking: Object.freeze([{ file: 'tests/sinking.test.mjs' }, PROP_FAST, GOLDEN, LOCK_FAST, { file: 'tests/hardening.test.mjs' }]), // hardening — TST-23 Q-20: излишек release обрезается до нуля (закрывает S04)
  tax: Object.freeze([{ file: 'tests/tax.test.mjs' }, PROP_FAST, GOLDEN, LOCK_FAST]),
  fx: Object.freeze([{ file: 'tests/fx.test.mjs' }, PROP_FAST, GOLDEN, LOCK_FAST]),
  // verifier.test.mjs без TST-56 (линтер слов читает wiki/, её в копии нет); импорт ../../tools/lint_vocab.mjs копия обеспечивает (режим engine)
  verifier: Object.freeze([{ file: 'tests/verifier.test.mjs', pattern: VERIFIER_NO_LINT }, { file: 'tests/hardening.test.mjs' }, { file: 'tests/adversarial/verifier_io.test.mjs' }]),
});

/** Модуль мутанта ядра (для выбора проверяющих и сводки): timeline, afford, sinking, tax, fx, verifier. */
export const module_of = (m) => /^engine\/([a-z_]+)\.mjs$/.exec(m.file)?.[1] ?? null;

/** Хэш каталога (путь, фрагмент, порча): меняется при любой правке каталога; результат прогона хранит его, чтобы устаревший отчёт был виден. */
export function catalog_hash(mutants = MUTANTS) {
  const h = createHash('sha256');
  for (const m of mutants) h.update([m.id, m.file, m.find, m.replace].join('\u0000') + '\n');
  return h.digest('hex');
}

/** Сколько раз фрагмент встречается в исходнике. */
export function count_of(source, find) {
  let n = 0;
  for (let i = source.indexOf(find); i >= 0; i = source.indexOf(find, i + find.length)) n += 1;
  return n;
}

/**
 * Применить мутацию к тексту исходника.
 * @param {string} source
 * @param {{id: string, find: string, replace: string}} m
 * @returns {string}
 * @throws {Error} фрагмент не найден или найден не один раз (каталог разошёлся с кодом), порча равна исходному
 */
export function apply_mutant(source, m) {
  const n = count_of(source, m.find);
  if (n !== 1) throw new Error(`${m.id}: фрагмент найден ${n} раз(а), нужен ровно один`);
  if (m.find === m.replace) throw new Error(`${m.id}: порча равна исходному`);
  return source.replace(m.find, () => m.replace);
}

/** Какие тесты проверяют мутанта: свои (`m.tests`, для проверок самого инструмента) либо общий список по файлу, замок арифметики первым. */
export const killers_for = (m) => m.tests ?? (m.file === M ? KILLERS.money : KILLERS.dates);

const inside = (child, parent) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

/**
 * Подготовить рабочий каталог-копию (engine/ и нужные тесты). Каталог внутри prototype/ отвергается; непустой чужой каталог — тоже.
 * @param {string} work_dir
 * @param {string} [root] откуда копировать (по умолчанию prototype/)
 * @param {{mode?: 'engine'}} [opts] `mode: 'engine'` (FP-24) — проект кладётся в `<w>/prototype`: engine/, ВСЕ tests/, tools/, data/ и package.json (тесты ядра читают наборы данных и общие помощники),
 *   рядом `<w>/tools/lint_vocab.mjs`; по умолчанию — прежний узкий набор прямо в `<w>`
 * @returns {string} каталог, где лежит копия проекта (`<w>` или `<w>/prototype`)
 */
export function prepare_work_dir(work_dir, root = PROTO, opts = {}) {
  const w = path.resolve(work_dir);
  if (inside(w, root) || inside(root, w)) throw new Error('рабочий каталог не должен лежать внутри prototype/ (и содержать его): ' + w);
  const sentinel = path.join(w, '.runway-mutate');
  if (fs.existsSync(w) && fs.readdirSync(w).length > 0 && !fs.existsSync(sentinel)) throw new Error('каталог не пуст и не создан этим инструментом: ' + w);
  fs.rmSync(w, { recursive: true, force: true });
  fs.mkdirSync(w, { recursive: true });
  // режим engine: проект лежит в <w>/prototype, рядом <w>/tools/lint_vocab.mjs (тест verifier.test.mjs импортирует ../../tools/lint_vocab.mjs)
  const top = opts.mode === 'engine' ? path.join(w, 'prototype') : w;
  fs.mkdirSync(top, { recursive: true });
  fs.cpSync(path.join(root, 'engine'), path.join(top, 'engine'), { recursive: true });
  if (opts.mode === 'engine') {
    for (const d of ['tests', 'tools', 'data']) fs.cpSync(path.join(root, d), path.join(top, d), { recursive: true });
    fs.copyFileSync(path.join(root, 'package.json'), path.join(top, 'package.json'));
    fs.mkdirSync(path.join(w, 'tools'), { recursive: true });
    for (const f of ['lint_vocab.mjs', 'lint_vocab_ignore.json']) fs.copyFileSync(path.join(root, '..', 'tools', f), path.join(w, 'tools', f));
  } else {
    for (const f of COPY_FILES) {
      fs.mkdirSync(path.dirname(path.join(w, f)), { recursive: true });
      fs.copyFileSync(path.join(root, f), path.join(w, f));
    }
  }
  fs.writeFileSync(sentinel, 'копия для tools/mutate.mjs; можно удалять\n');
  return top;
}

/** Окружение дочернего `node --test`: без NODE_TEST_CONTEXT, который раннер выставляет вложенным процессам (иначе внутри теста дочерний раннер пишет не текст, а служебный поток). */
function clean_env() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/**
 * Один запуск файла тестов в копии: `{ok, ms, tests, fail}`; тест-раннер — отдельный процесс, по одному файлу. `spec` — путь (как раньше) либо `{file, env?, pattern?}`
 * (FP-24: переменные окружения и фильтр имён тестов `--test-name-pattern`; фильтр, под который не подошёл ни один тест, — не «зелёный», а ошибка настройки).
 * `kill_ms` — жёсткий предел жизни процесса (по умолчанию `timeout_ms * 4`, как раньше). `single` (FP-24) — `--test-isolation=none`: тест идёт в процессе раннера, и остановка
 * по пределу времени убивает всё (иначе на Windows порча с бесконечным циклом оставила бы работающий процесс теста-сироту).
 */
function run_test_file(work, spec_in, timeout_ms, kill_ms, single = false) {
  const spec = typeof spec_in === 'string' ? { file: spec_in } : spec_in;
  const t0 = Date.now();
  const args = ['--test', ...(single ? ['--test-isolation=none'] : []), '--test-timeout=' + timeout_ms, '--test-concurrency=1'];
  if (spec.pattern !== undefined) args.push('--test-name-pattern=' + spec.pattern);
  args.push(spec.file);
  const r = spawnSync(process.execPath, args, { cwd: work, env: { ...clean_env(), ...(spec.env ?? {}) }, encoding: 'utf8', timeout: kill_ms ?? timeout_ms * 4, maxBuffer: 20 * 1024 * 1024 });
  const out = r.stdout ?? '';
  const num = (name) => Number(new RegExp('^ℹ ' + name + ' (\\d+)', 'm').exec(out)?.[1] ?? NaN);
  const tests = num('tests');
  return { ok: r.status === 0 && (spec.pattern === undefined || tests > 0), status: r.status, ms: Date.now() - t0, tests, fail: num('fail'), timed_out: r.error?.code === 'ETIMEDOUT', failed: failed_names(out) };
}

/** Названия упавших тестов (строки `✖ …` до блока «failing tests», без времени), до 20: по ним видно, какой из инвариантов property-тестов убил мутанта. */
export function failed_names(out) {
  const cut = out.indexOf('✖ failing tests');
  return (cut < 0 ? out : out.slice(0, cut)).split('\n').filter((l) => l.startsWith('✖ ')).map((l) => l.slice(2).replace(/ \([\d.]+ms\)\s*$/, '').trim().slice(0, 120)).slice(0, 20);
}

/** Какие инварианты TST-31…39 назвал упавший прогон property-тестов (`TST-35 Свойство …` → `TST-35`), по возрастанию. */
export const invariants_of = (names) => [...new Set(names.map((n) => /^(TST-3\d) Свойство/.exec(n)?.[1]).filter((x) => x !== undefined))].sort();

/**
 * Прогнать мутации по одной.
 * @param {{work_dir: string, only?: string[], limit?: number, dry_run?: boolean, timeout_ms?: number, root?: string, mutants?: object[], log?: (s: string) => void,
 *   killers_of?: (m: object) => (string|object)[], prepare?: {mode?: 'engine'}, kill_ms?: number, mutant_budget_ms?: number, single_process?: boolean, all_killers?: boolean}} o
 *   FP-24: `killers_of` — проверяющие мутанта (по умолчанию `killers_for`), `prepare` — режим копирования, `kill_ms` — предел жизни процесса на файл, `mutant_budget_ms` — предел времени на мутанта;
 *   исправление D4: `all_killers` — не останавливаться на первом убившем, а запустить каждого проверяющего: строка результата получает `nets` (имена сетей, убивших мутанта:
 *   `module`, `properties`, `lock`, `golden`) и `invariants` (какие инварианты TST-31…39 назвали property-тесты); `killed_by` остаётся первым убившим в порядке списка
 */
export function run_mutants(o) {
  const log = o.log ?? (() => {});
  const mutants = (o.mutants ?? MUTANTS).filter((m) => o.only === undefined || o.only.includes(m.id)).slice(0, o.limit ?? Infinity);
  const work = prepare_work_dir(o.work_dir, o.root, o.prepare ?? {});
  const timeout_ms = o.timeout_ms ?? 120000;
  const killers_of = o.killers_of ?? killers_for;
  const spec_of = (x) => (typeof x === 'string' ? { file: x } : x);
  const results = [];
  // контроль: на неиспорченной копии все тесты зелёные (иначе «убит» ничего не значит)
  let baseline = null;
  if (o.dry_run !== true) {
    const uniq = new Map(mutants.flatMap(killers_of).map((x) => [JSON.stringify(spec_of(x)), spec_of(x)]));
    baseline = [...uniq.values()].map((sp) => ({ file: sp.file, ...(sp.pattern === undefined ? {} : { pattern: sp.pattern }), ...run_test_file(work, sp, timeout_ms, o.kill_ms, o.single_process === true) }));
    for (const b of baseline) log(`контроль ${b.ok ? 'зелёный' : 'КРАСНЫЙ'}: ${b.file}${b.pattern === undefined ? '' : ' [' + b.pattern + ']'} (${b.tests} тестов, ${b.ms} мс)`);
    if (baseline.some((b) => !b.ok)) return { baseline, results, aborted: 'контроль на неиспорченной копии красный: мутации не проверялись' };
  }
  for (const m of mutants) {
    const target = path.join(work, m.file);
    const original = fs.readFileSync(target, 'utf8');
    let status = 'survived';
    let killed_by = null;
    let note = null;
    let ms = 0;
    const nets = new Set();
    let invariants = [];
    try {
      const mutated = apply_mutant(original, m);
      if (o.dry_run === true) { status = 'applied'; results.push({ id: m.id, file: m.file, what: m.what, status, killed_by, ms }); log(`${m.id} применён (сухой прогон)`); continue; }
      fs.writeFileSync(target, mutated, 'utf8');
      for (const sp_in of killers_of(m)) {
        const sp = spec_of(sp_in);
        if (o.mutant_budget_ms !== undefined && ms > o.mutant_budget_ms) { note = 'бюджет времени на мутанта исчерпан: не все проверяющие успели'; break; }
        const r = run_test_file(work, sp, timeout_ms, o.kill_ms, o.single_process === true);
        ms += r.ms;
        if (!r.ok) {
          if (status !== 'killed') { status = 'killed'; killed_by = sp.file; note = r.timed_out ? 'таймаут' : `упало тестов: ${Number.isNaN(r.fail) ? 'неизвестно' : r.fail}`; }
          if (o.all_killers !== true) break;
          nets.add(net_of(sp));
          if (sp.file === PROP_FAST.file) invariants = invariants_of(r.failed ?? []);
        }
      }
    } catch (e) {
      status = 'error';
      note = String(e.message);
    } finally {
      fs.writeFileSync(target, original, 'utf8');
    }
    const row = { id: m.id, file: m.file, what: m.what, status, killed_by, note, ms };
    if (o.all_killers === true) { row.nets = ['module', 'properties', 'lock', 'golden'].filter((n) => nets.has(n)); row.invariants = invariants; }
    results.push(row);
    log(`${m.id} ${status}${killed_by === null ? '' : ' ← ' + killed_by}${o.all_killers === true ? ' [' + row.nets.join(', ') + ']' : ''}`);
  }
  return { baseline, results, aborted: null };
}

function arg_of(argv, name, def) { const i = argv.indexOf(name); return i < 0 ? def : argv[i + 1]; }

function main(argv) {
  const catalog = arg_of(argv, '--catalog', 'legacy');
  if (catalog === 'engine') return main_engine(argv);
  if (catalog !== 'legacy') { console.error('--catalog: legacy (money, dates; по умолчанию) или engine (timeline, afford, sinking, tax, fx, verifier)'); return 2; }
  const work_dir = arg_of(argv, '--work-dir', null);
  if (work_dir === null) { console.error('нужен ключ --work-dir <каталог вне проекта>: мутации применяются только к копии'); return 2; }
  const date = arg_of(argv, '--date', null);
  const dry = argv.includes('--dry-run');
  if (!dry && !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) { console.error('нужен аргумент --date ГГГГ-ММ-ДД (инструмент часов не читает)'); return 2; }
  const only = arg_of(argv, '--only', null)?.split(',');
  const limit = arg_of(argv, '--limit', null);
  let r;
  try { r = run_mutants({ work_dir, only, limit: limit === null ? undefined : Number(limit), dry_run: dry, log: (s) => console.log(s) }); } catch (e) { console.error('ОШИБКА ' + e.message); return 2; }
  if (r.aborted !== null) { console.error(r.aborted); return 1; }
  const killed = r.results.filter((x) => x.status === 'killed');
  const equiv_ids = new Set(MUTANTS.filter((m) => m.equivalent !== undefined).map((m) => m.id));
  const survivors = r.results.filter((x) => x.status === 'survived' && !equiv_ids.has(x.id));
  const equivalent = r.results.filter((x) => x.status === 'survived' && equiv_ids.has(x.id));
  const equiv_killed = r.results.filter((x) => x.status === 'killed' && equiv_ids.has(x.id));
  const errors = r.results.filter((x) => x.status === 'error');
  console.log(`мутантов ${r.results.length}: убито ${killed.length}, не убито ${survivors.length}, эквивалентных (выжили, как и должны) ${equivalent.length}, ошибок ${errors.length}`);
  for (const e of equiv_killed) console.error(`  ОШИБКА ${e.id} помечен эквивалентным, но убит: снимите пометку`);
  for (const s of survivors) console.log(`  НЕ УБИТ ${s.id} ${s.file}: ${s.what}`);
  for (const e of errors) console.error(`  ОШИБКА ${e.id}: ${e.note}`);
  if (!dry && !argv.includes('--no-write') && only === undefined && limit === null) {
    const out = path.resolve(arg_of(argv, '--out', path.join(PROTO, '..', '_ops', 'mutation.json')));
    const lock_kills = killed.filter((x) => x.killed_by === 'tests/arith.test.mjs').length;
    const doc = {
      format: 'runway-mutation/1', date, node: process.version, catalog_hash: catalog_hash(), mutants: r.results.length, killed: killed.length, lock_killed: lock_kills,
      survivors: survivors.map((s) => ({ id: s.id, file: s.file, what: s.what })),
      equivalent: equivalent.map((s) => ({ id: s.id, file: s.file, what: s.what, why: MUTANTS.find((m) => m.id === s.id).equivalent })), errors: errors.map((e) => ({ id: e.id, note: e.note })),
      baseline: r.baseline.map((b) => ({ file: b.file, tests: b.tests, ok: b.ok })),
      results: r.results.map((x) => ({ id: x.id, file: x.file, status: x.status, killed_by: x.killed_by })),
      note: 'Мутации применялись к копии во временном каталоге; рабочее дерево не менялось. Неубитые мутанты — задачи (REQ-175).',
    };
    const prev = read_json(out);
    if (prev?.engine !== undefined) doc.engine = prev.engine; // FP-24: результат прогона мутаций ядра не теряется при перезаписи money/dates
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    console.log('записано: ' + out);
  }
  return errors.length === 0 && survivors.length === 0 && equiv_killed.length === 0 ? 0 : 1;
}

// ── FP-24: прогон каталога ядра ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Не менее такой доли неэквивалентных мутантов ядра должно быть убито (спецификация FP-24: 90 %). */
export const ENGINE_KILL_RATE_MIN_PCT = 90;

function read_json(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Сводка прогона каталога ядра: убитые, выжившие (без пометки «эквивалентный»), эквивалентные, ошибки, доля убитых среди неэквивалентных, итоги по модулям.
 * @param {{id: string, file: string, status: string}[]} results
 * @param {object[]} [mutants]
 */
export function engine_summary(results, mutants = MUTANTS_ENGINE) {
  const equiv_ids = new Set(mutants.filter((m) => m.equivalent !== undefined).map((m) => m.id));
  const killed = results.filter((x) => x.status === 'killed');
  const survived = results.filter((x) => x.status === 'survived');
  const survivors = survived.filter((x) => !equiv_ids.has(x.id));
  const equivalent = survived.filter((x) => equiv_ids.has(x.id));
  const equiv_killed = killed.filter((x) => equiv_ids.has(x.id));
  const errors = results.filter((x) => x.status === 'error');
  const denominator = results.length - equivalent.length;
  const pct = (a, b) => (b === 0 ? 100 : Math.round((1000 * a) / b) / 10);
  const by_module = {};
  for (const x of results) {
    const mod = module_of(x) ?? '?';
    by_module[mod] ??= { mutants: 0, killed: 0 };
    by_module[mod].mutants += 1;
    if (x.status === 'killed') by_module[mod].killed += 1;
  }
  return { killed, survivors, equivalent, equiv_killed, errors, kill_rate_pct: pct(killed.length, denominator), kill_rate_all_pct: pct(killed.length, results.length), by_module };
}

/** Девять инвариантов property-тестов (для сводки по сетям: нулевые счётчики видны явно). */
export const INVARIANT_IDS = Object.freeze(['TST-31', 'TST-32', 'TST-33', 'TST-34', 'TST-35', 'TST-36', 'TST-37', 'TST-38', 'TST-39']);

/**
 * Сводка по сетям (режим `--nets`, FP-24 · D4): какая сеть сколько мутантов убила и кого не видит ни одна из трёх сетей поперёк модулей (property-тесты, замок вывода, golden) —
 * таких убивают только тесты самого модуля. Строки без поля `nets` (прогон без `--nets`) не учитываются.
 * @param {{id: string, file: string, status: string, nets?: string[], invariants?: string[]}[]} results
 * @param {object[]} [mutants]
 */
export function nets_summary(results, mutants = MUTANTS_ENGINE) {
  const equiv_ids = new Set(mutants.filter((m) => m.equivalent !== undefined).map((m) => m.id));
  const rows = results.filter((r) => Array.isArray(r.nets));
  const three = (r) => r.nets.filter((n) => n !== 'module');
  const by_net = { module: 0, properties: 0, lock: 0, golden: 0 };
  for (const r of rows) for (const n of r.nets) by_net[n] += 1;
  const by_invariant = Object.fromEntries(INVARIANT_IDS.map((id) => [id, 0]));
  for (const r of rows) for (const id of r.invariants ?? []) by_invariant[id] = (by_invariant[id] ?? 0) + 1;
  const by_module = {};
  for (const r of rows) {
    const mod = module_of(r) ?? '?';
    const s = (by_module[mod] ??= { mutants: 0, properties: 0, lock: 0, golden: 0, none_of_three: 0 });
    s.mutants += 1;
    for (const n of three(r)) s[n] += 1;
    if (three(r).length === 0) s.none_of_three += 1;
  }
  return {
    mutants: rows.length, by_net, any_of_three: rows.filter((r) => three(r).length > 0).length, none_of_three: rows.filter((r) => three(r).length === 0).map((r) => r.id),
    module_only: rows.filter((r) => r.status === 'killed' && three(r).length === 0).map((r) => r.id),
    survived_everything: rows.filter((r) => r.status !== 'killed').map((r) => r.id), equivalent: rows.filter((r) => equiv_ids.has(r.id)).map((r) => r.id), by_invariant, by_module,
  };
}

/** Причины выживших и эквивалентных из каталога (поля `unkilled` и `equivalent`); выживший без причины попадает в `missing`. */
export function annotate_engine(doc, mutants = MUTANTS_ENGINE) {
  const by_id = new Map(mutants.map((m) => [m.id, m]));
  const order = new Map(mutants.map((m, i) => [m.id, i]));
  const missing = [];
  const survivors = [];
  const equivalent = doc.equivalent.map((s) => ({ id: s.id, file: s.file, what: s.what, why: by_id.get(s.id)?.equivalent ?? s.why ?? null }));
  for (const s of doc.survivors) {
    const m = by_id.get(s.id);
    // выживший, которого разбор признал эквивалентным (поле `equivalent` каталога), переходит в список эквивалентных: порча не меняет поведения, убить её нельзя
    if (m?.equivalent !== undefined) { equivalent.push({ id: s.id, file: s.file, what: s.what, why: m.equivalent }); continue; }
    const reason = m?.unkilled ?? null;
    if (reason === null) missing.push(s.id);
    survivors.push({ id: s.id, file: s.file, what: s.what, reason });
  }
  equivalent.sort((a, b) => order.get(a.id) - order.get(b.id));
  doc.survivors = survivors;
  doc.equivalent = equivalent;
  const denominator = doc.mutants - equivalent.length;
  doc.kill_rate_pct = denominator === 0 ? 100 : Math.round((1000 * doc.killed) / denominator) / 10;
  return { doc, missing };
}

/** Записать раздел `engine` в файл результатов, не трогая остальные поля (money, dates). */
function write_engine_section(out, engine) {
  const doc = read_json(out) ?? { format: 'runway-mutation/1' };
  doc.engine = engine;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n', 'utf8');
}

function main_engine(argv) {
  const out = path.resolve(arg_of(argv, '--out', path.join(PROTO, '..', '_ops', 'mutation.json')));
  if (argv.includes('--annotate')) {
    const doc = read_json(out)?.engine;
    if (doc === undefined) { console.error('в ' + out + ' нет раздела engine: сначала полный прогон'); return 2; }
    if (doc.catalog_hash !== catalog_hash(MUTANTS_ENGINE)) { console.error('каталог мутаций ядра изменён после прогона: повторите полный прогон'); return 1; }
    const { missing } = annotate_engine(doc);
    write_engine_section(out, doc);
    console.log('причины выживших записаны: ' + out);
    for (const id of missing) console.error('  БЕЗ ПРИЧИНЫ ' + id + ': добавьте поле unkilled в каталог');
    return missing.length === 0 ? 0 : 1;
  }
  const work_dir = arg_of(argv, '--work-dir', null);
  if (work_dir === null) { console.error('нужен ключ --work-dir <каталог вне проекта>: мутации применяются только к копии'); return 2; }
  const date = arg_of(argv, '--date', null);
  const dry = argv.includes('--dry-run');
  if (!dry && !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) { console.error('нужен аргумент --date ГГГГ-ММ-ДД (инструмент часов не читает)'); return 2; }
  const only = arg_of(argv, '--only', null)?.split(',');
  const limit = arg_of(argv, '--limit', null);
  const timeout_s = Number(arg_of(argv, '--timeout-s', 60));
  const budget_s = Number(arg_of(argv, '--budget-s', 300));
  if (!(timeout_s >= 1) || !(budget_s >= timeout_s)) { console.error('--timeout-s ≥ 1 (на файл), --budget-s ≥ --timeout-s (на мутанта)'); return 2; }
  const nets_mode = argv.includes('--nets'); // FP-24 · D4: каждого проверяющего запускать независимо и записать, какая сеть что убила
  /** Проверяющие в режиме --nets: свои тесты модуля, затем три сети поперёк модулей (если их там ещё нет). */
  const with_nets = (m) => {
    const own = KILLERS_ENGINE[module_of(m)];
    const have = new Set(own.map((k) => k.file));
    return [...own, ...Object.values(NETS).filter((n) => !have.has(n.file))];
  };
  let r;
  try {
    r = run_mutants({
      work_dir, only, limit: limit === null ? undefined : Number(limit), dry_run: dry, mutants: MUTANTS_ENGINE, killers_of: nets_mode ? with_nets : (m) => KILLERS_ENGINE[module_of(m)], prepare: { mode: 'engine' },
      timeout_ms: timeout_s * 1000, kill_ms: timeout_s * 1500, mutant_budget_ms: budget_s * 1000, single_process: true, all_killers: nets_mode, log: (s) => console.log(s),
    });
  } catch (e) { console.error('ОШИБКА ' + e.message); return 2; }
  if (r.aborted !== null) { console.error(r.aborted); return 1; }
  const sm = engine_summary(r.results);
  console.log(`мутантов ядра ${r.results.length}: убито ${sm.killed.length} (${sm.kill_rate_pct} % неэквивалентных), не убито ${sm.survivors.length}, эквивалентных ${sm.equivalent.length}, ошибок ${sm.errors.length}`);
  for (const [mod, v] of Object.entries(sm.by_module)) console.log(`  ${mod}: ${v.killed} из ${v.mutants}`);
  const ns = nets_mode && !dry ? nets_summary(r.results) : null;
  if (ns !== null) {
    console.log(`сети: тесты модуля ${ns.by_net.module}, property-тесты ${ns.by_net.properties}, замок вывода ${ns.by_net.lock}, golden ${ns.by_net.golden}; хотя бы одна из трёх сетей — ${ns.any_of_three}; ни одна из трёх — ${ns.none_of_three.length}`);
    console.log('  инварианты: ' + INVARIANT_IDS.map((id) => `${id}:${ns.by_invariant[id]}`).join(' '));
  }
  for (const e of sm.equiv_killed) console.error(`  ОШИБКА ${e.id} помечен эквивалентным, но убит: снимите пометку`);
  for (const s of sm.survivors) console.log(`  НЕ УБИТ ${s.id} ${s.file}: ${s.what}`);
  for (const e of sm.errors) console.error(`  ОШИБКА ${e.id}: ${e.note}`);
  if (!dry && !argv.includes('--no-write') && only === undefined && limit === null) {
    const doc = {
      format: 'runway-mutation-engine/1', date, node: process.version, catalog_hash: catalog_hash(MUTANTS_ENGINE), mutants: r.results.length, killed: sm.killed.length,
      kill_rate_pct: sm.kill_rate_pct, kill_rate_all_pct: sm.kill_rate_all_pct, kill_rate_min_pct: ENGINE_KILL_RATE_MIN_PCT, by_module: sm.by_module,
      survivors: sm.survivors.map((x) => ({ id: x.id, file: x.file, what: x.what })), equivalent: sm.equivalent.map((x) => ({ id: x.id, file: x.file, what: x.what })),
      errors: sm.errors.map((e) => ({ id: e.id, note: e.note })),
      baseline: r.baseline.map((b) => ({ file: b.file, ...(b.pattern === undefined ? {} : { pattern: b.pattern }), tests: b.tests, ok: b.ok })),
      results: r.results.map((x) => ({ id: x.id, file: x.file, module: module_of(x), status: x.status, killed_by: x.killed_by, ms: x.ms, ...(nets_mode ? { nets: x.nets, invariants: x.invariants } : {}) })),
      note: 'Мутации применялись к копии во временном каталоге (по одному мутанту, один процесс node за раз); рабочее дерево не менялось. Проверяющие: тесты модуля, property-тесты (PROP_N=40), golden G-001, замок вывода движка. Выжившие перечислены с причиной (REQ-175).'
        + (nets_mode ? ' Режим --nets: каждый проверяющий запущен независимо (без остановки на первом убившем), поле nets каждого мутанта — какие сети его убили (module, properties, lock, golden), invariants — какие инварианты TST-31…39 назвали property-тесты; сводка — поле nets_summary.' : ''),
    };
    if (ns !== null) doc.nets_summary = { catalog_hash: doc.catalog_hash, ...ns };
    annotate_engine(doc);
    write_engine_section(out, doc);
    console.log('записано: ' + out + ' (раздел engine)');
    for (const x of doc.survivors.filter((y) => y.reason === null)) console.error(`  БЕЗ ПРИЧИНЫ ${x.id}: после разбора добавьте поле unkilled в каталог и выполните --annotate`);
  }
  if (dry) return sm.errors.length === 0 ? 0 : 1; // сухой прогон тестов не запускает: доля убитых не определена
  return sm.errors.length === 0 && sm.equiv_killed.length === 0 && sm.kill_rate_pct >= ENGINE_KILL_RATE_MIN_PCT && sm.survivors.every((x) => MUTANTS_ENGINE.find((m) => m.id === x.id)?.unkilled !== undefined) ? 0 : 1;
}

const is_main = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (is_main) process.exitCode = main(process.argv.slice(2));
