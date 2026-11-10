// anonymize.mjs — анонимизация журнала добровольца перед backtest (FP-11, REQ-176, ALG-13, TST-55).
// Правило REQ-176: даты сдвигаются на число дней, КРАТНОЕ 7 (день недели и выходные сохраняются), суммы умножаются на общий множитель k ∈ [0,5; 2];
// структура журнала и связи записей не меняются. Здесь: `anonymize_journal(journal, opts)` — чистая функция (без часов, без случайности; сдвиг и множитель
// выводятся из `seed` счётчиковым хэшем `u01`, если не заданы явно) и `verify_anonymized` — независимая проверка пары «до / после».
//   - дата — любая подстрока `ГГГГ-ММ-ДД` настоящей календарной даты в ЛЮБОМ строковом значении и в ключах объектов (даты, идентификаторы вида `S-HOURLY@2026-01-05`,
//     `anc-reg02-2026-01-01`, моменты `recorded_at`): сдвиг один и тот же, поэтому ссылки (`plan_ref`, `occ_key`, `supersedes_id`) остаются согласованными;
//   - сумма — целое в поле, чьё имя оканчивается на `_minor` (`amount_minor`, `exp_minor`, `rate_minor`, `buffer_minor`, `wave.threshold_minor`, …): `mul_div(x, k_bp, 10000)`;
//     округление half_even, ненулевая сумма не обращается в ноль (±1), знак сохраняется; доли (`*_bp`), курсы (`num`/`den`), минуты, счётчики и `seq` не меняются;
//   - не меняются идентификаторы без дат, типы записей, `seq`, порядок, валюты и вся структура объектов.
// Что НЕ делается: тексты (названия, заметки) не очищаются от персональных данных; остатки в якорях после округления сумм могут отличаться от суммы фактов на
// несколько minor units (структура и связи сохраняются, арифметика журнала — приблизительно). Сдвиг и множитель знает только владелец журнала: в файл они не попадают.
// Календарные поля правил НЕ сдвигаются: день месяца (`by_monthday`) и граница «конец месяца» (`cutoff.kind = month_end`) остаются прежними, а факты, якоря и `start_date` уходят на 7·N дней —
// план и факт расходятся, и метрики backtest на анонимизированном журнале могут заметно отличаться от метрик исходного (README, «Ограничения FP-11»). Поэтому `anonymize_journal`
// возвращает `notes` (сколько таких полей в журнале), а командная строка предупреждает. Как это устранить — решение владельца (пересчёт полей или самопроверка backtest до и после).
// Модуль можно импортировать без побочных эффектов; чтение и запись файлов — только в командной строке (`node tools/anonymize.mjs …`). Расчёт по введённым данным, не консультация.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fail, mul_div, own_put } from '../engine/money.mjs';
import { parse_date, format_date } from '../engine/dates.mjs';
import { u01 } from '../engine/montecarlo.mjs';
import { canon } from '../engine/ledger.mjs';
import { export_json, read_journal_json } from '../engine/io.mjs';

/** Границы множителя сумм в bp: 0,5 … 2 (REQ-176). */
export const K_BP_MIN = 5000;
export const K_BP_MAX = 20000;
/** Предел сдвига, недель (≈ 100 лет): защита от выхода дат за допустимый календарь. */
export const SHIFT_WEEKS_MAX = 5200;

const DATE_RE = /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g;

/**
 * Сдвиг и множитель по `seed` (счётчиковый хэш, без состояния): `shift_weeks` 1…104, `k_bp` 5000…20000.
 * @param {number} seed целое
 * @returns {{shift_weeks: number, k_bp: number}}
 */
export function derive_params(seed) {
  if (!Number.isSafeInteger(seed)) fail('E_SCHEMA', { reason: 'seed_not_integer', value: String(seed) });
  const s = ((seed % 4294967296) + 4294967296) % 4294967296;
  return {
    shift_weeks: 1 + Math.floor(u01(s, 'anonymize|shift_weeks', 0) * 104),
    k_bp: K_BP_MIN + Math.floor(u01(s, 'anonymize|k_bp', 0) * (K_BP_MAX - K_BP_MIN + 1)),
  };
}

function check_params(shift_weeks, k_bp) {
  if (!Number.isSafeInteger(shift_weeks) || Math.abs(shift_weeks) > SHIFT_WEEKS_MAX) fail('E_SCHEMA', { reason: 'shift_weeks_out_of_range', value: String(shift_weeks) });
  if (!Number.isSafeInteger(k_bp) || k_bp < K_BP_MIN || k_bp > K_BP_MAX) fail('E_SCHEMA', { reason: 'k_bp_out_of_range', value: String(k_bp), min: K_BP_MIN, max: K_BP_MAX });
}

/** Подстроки-даты строки сдвигаются на `days`; не календарная дата остаётся как есть. */
function shift_text(s, days) {
  if (days === 0) return s;
  return s.replace(DATE_RE, (m) => {
    let d;
    try { d = parse_date(m); } catch { return m; }
    return format_date(d + days);
  });
}

/**
 * Календарные поля, которые сдвиг на 7·N дней не переносит: записи с днём месяца (`by_monthday`) и потоки с границей периода «конец месяца». Только счёт, журнал не меняется.
 * @param {object[]} journal
 * @returns {{by_monthday: number, month_end_cutoff: number}}
 */
export function calendar_notes(journal) {
  const n = { by_monthday: 0, month_end_cutoff: 0 };
  const visit = (v, depth) => {
    if (depth > 60 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const x of v) visit(x, depth + 1); return; }
    if (Array.isArray(v.by_monthday) && v.by_monthday.length > 0) n.by_monthday += 1;
    if (v.cutoff !== null && typeof v.cutoff === 'object' && v.cutoff.kind === 'month_end') n.month_end_cutoff += 1;
    for (const k of Object.keys(v)) visit(v[k], depth + 1);
  };
  if (Array.isArray(journal)) visit(journal, 0);
  return n;
}

function scale_minor(x, k_bp) {
  if (x === 0) return 0;
  const y = mul_div(x, k_bp, 10000, 'half_even');
  return y === 0 ? Math.sign(x) : y;
}

function walk(v, key, days, k_bp, depth) {
  if (depth > 60) fail('E_SCHEMA', { reason: 'journal_too_deep' });
  if (typeof v === 'string') return shift_text(v, days);
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) fail('E_NOT_INTEGER', { reason: 'journal_number_not_safe_integer', key: String(key) });
    return typeof key === 'string' && key.endsWith('_minor') ? scale_minor(v, k_bp) : v;
  }
  if (Array.isArray(v)) return v.map((x) => walk(x, key, days, k_bp, depth + 1)); // массив сумм под именем `*_minor` тоже масштабируется
  if (v !== null && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) own_put(out, shift_text(k, days), walk(v[k], k, days, k_bp, depth + 1));
    return out;
  }
  return v; // boolean, null
}

/**
 * Анонимизировать журнал: сдвиг дат на `7·shift_weeks` дней и умножение сумм на `k_bp/10000`.
 * @param {object[]} journal записи журнала (`ledger.make_event`); не меняется
 * @param {{seed?: number, shift_weeks?: number, k_bp?: number}} [opts] явные значения главнее `seed`; без обоих — `seed` = 0
 * @returns {{journal: object[], params: {shift_days: number, shift_weeks: number, k_bp: number, seed: number|null}, notes: {by_monthday: number, month_end_cutoff: number}}}
 *   `params` знает только владелец журнала; в файл для передачи они не записываются; `notes` — сколько календарных полей сдвиг не переносит (см. `calendar_notes`)
 * @throws {RunwayError} E_SCHEMA (не журнал, множитель вне [0,5; 2], сдвиг вне диапазона), E_NOT_INTEGER (нецелое число в записи)
 */
export function anonymize_journal(journal, opts = {}) {
  if (!Array.isArray(journal)) fail('E_SCHEMA', { reason: 'journal_not_array' });
  const seed = opts.seed ?? 0;
  const derived = opts.shift_weeks === undefined || opts.k_bp === undefined ? derive_params(seed) : null;
  const shift_weeks = opts.shift_weeks ?? derived.shift_weeks;
  const k_bp = opts.k_bp ?? derived.k_bp;
  check_params(shift_weeks, k_bp);
  const days = 7 * shift_weeks;
  const out = journal.map((e, i) => {
    if (e === null || typeof e !== 'object' || Array.isArray(e) || typeof e.type !== 'string' || typeof e.event_id !== 'string') fail('E_SCHEMA', { reason: 'bad_event', index: i });
    canon(e); // нецелое число и не-JSON значения отвергаются
    return walk(e, null, days, k_bp, 0);
  });
  return { journal: out, params: { shift_days: days, shift_weeks, k_bp, seed: opts.seed ?? null }, notes: calendar_notes(journal) };
}

/**
 * Независимая проверка пары «исходный / анонимизированный»: та же структура (число записей, `seq`, типы, ключи), даты сдвинуты ровно на `shift_days`,
 * суммы равны `scale_minor`, всё остальное совпадает. Не использует `anonymize_journal`.
 * @param {object[]} before
 * @param {object[]} after
 * @param {{shift_days: number, k_bp: number}} params
 * @returns {string[]} описания расхождений; пусто — пара согласована
 */
export function verify_anonymized(before, after, params) {
  const problems = [];
  const { shift_days, k_bp } = params;
  if (shift_days % 7 !== 0) problems.push('shift_not_multiple_of_7');
  if (k_bp < K_BP_MIN || k_bp > K_BP_MAX) problems.push('k_out_of_range');
  if (before.length !== after.length) { problems.push('length_differs'); return problems; }
  const cmp = (a, b, where, key) => {
    if (typeof a === 'string') {
      if (typeof b !== 'string' || b !== shift_text(a, shift_days)) problems.push(`${where}: text`);
    } else if (typeof a === 'number') {
      const want = typeof key === 'string' && key.endsWith('_minor') ? scale_minor(a, k_bp) : a;
      if (b !== want) problems.push(`${where}: number`);
    } else if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) { problems.push(`${where}: array`); return; }
      a.forEach((x, i) => cmp(x, b[i], `${where}[${i}]`, key));
    } else if (a !== null && typeof a === 'object') {
      if (b === null || typeof b !== 'object' || Array.isArray(b)) { problems.push(`${where}: object`); return; }
      const ka = Object.keys(a).map((k) => shift_text(k, shift_days)).sort();
      const kb = Object.keys(b).sort();
      if (ka.join('\u0000') !== kb.join('\u0000')) { problems.push(`${where}: keys`); return; }
      for (const k of Object.keys(a)) cmp(a[k], b[shift_text(k, shift_days)], `${where}.${k}`, k);
    } else if (a !== b) problems.push(`${where}: value`);
  };
  before.forEach((e, i) => cmp(e, after[i], `#${i}`, null));
  return problems;
}

// ── командная строка ────────────────────────────────────────────────────────────────────────────────────────────────────

const HELP = `Использование: node tools/anonymize.mjs <вход.json> <выход.json> [--seed N] [--shift-weeks N] [--k-bp N]
  вход/выход — файл-копия runway-journal/1; даты сдвигаются на 7·N дней, суммы умножаются на k_bp/10000 (0,5…2).
  Без --shift-weeks и --k-bp они выводятся из --seed (по умолчанию 0). Сдвиг и множитель печатаются на экран и в файл НЕ записываются.
  Выходной файл должен отличаться от входного: исходный журнал инструмент не перезаписывает.
  День месяца правил и граница «конец месяца» не сдвигаются: при наличии таких полей инструмент предупреждает, что метрики backtest на результате могут отличаться.`;

/** Один и тот же файл по разобранному пути (на Windows без учёта регистра). */
function same_file(a, b) {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function arg_value(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = Number(argv[i + 1]);
  if (!Number.isSafeInteger(v)) fail('E_SCHEMA', { reason: 'cli_option_not_integer', option: name });
  return v;
}

/** Командная строка; возвращает код выхода (0 — готово, 2 — неверный запуск). */
export function main(argv, io = { read: (p) => fs.readFileSync(p, 'utf8'), write: (p, t) => fs.writeFileSync(p, t, 'utf8'), out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') }) {
  const files = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
  if (argv.includes('--help') || files.length !== 2) { (argv.includes('--help') ? io.out : io.err)(HELP); return argv.includes('--help') ? 0 : 2; }
  if (same_file(files[0], files[1])) { io.err('Входной и выходной файлы совпадают: исходный журнал не перезаписывается. Укажите другой выходной файл.'); return 2; }
  try {
    const j = read_journal_json(io.read(files[0]));
    const r = anonymize_journal(j.events, { seed: arg_value(argv, '--seed'), shift_weeks: arg_value(argv, '--shift-weeks'), k_bp: arg_value(argv, '--k-bp') });
    const problems = verify_anonymized(j.events, r.journal, r.params);
    if (problems.length > 0) { io.err('Проверка пары «до / после» не прошла: ' + problems.slice(0, 5).join('; ')); return 1; }
    io.write(files[1], export_json(r.journal, { engine_version: j.engine_version ?? undefined }) + '\n');
    io.out(JSON.stringify({ written: files[1], events: r.journal.length, shift_days: r.params.shift_days, k_bp: r.params.k_bp, calendar_notes: r.notes }));
    if (r.notes.by_monthday > 0 || r.notes.month_end_cutoff > 0) {
      io.err(`Предупреждение: в журнале записей с днём месяца (by_monthday) — ${r.notes.by_monthday}, потоков с границей «конец месяца» — ${r.notes.month_end_cutoff}. `
        + 'Даты сдвинуты на 7·N дней, а день месяца и конец месяца остались прежними, поэтому метрики backtest на анонимизированном журнале могут отличаться от метрик исходного. '
        + 'Для гейта REQ-176 сравните метрики до и после (см. «Ограничения FP-11» в README).');
    }
    return 0;
  } catch (e) {
    io.err('Ошибка: ' + (e?.code ?? 'E_UNKNOWN') + (e?.ctx?.reason === undefined ? '' : ' (' + e.ctx.reason + ')'));
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
