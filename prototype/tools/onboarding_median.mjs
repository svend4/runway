// onboarding_median.mjs — медиана времени до первого прогноза (REQ-110) и быстрого ввода факта (REQ-090) → запись «measured» в реестр обещаний (FP-27).
//
// Зачем. Цифры «за сколько минут первый прогноз» и «за сколько секунд ввод факта» публично не обещаются, пока их не измерили на людях (REQ-090, REQ-110, REQ-178:
// линтер обещаний блокирует «первый прогноз за N минут» без измерения). Этот инструмент — единственный путь, которым такая цифра попадает в реестр `demo/promises.json`:
//   - считает медиану, n и разброс по файлам; дату замера называет человек (`--date`): в файле метрик календарных дат нет по схеме (REQ-185). Часы инструмент читает ТОЛЬКО для сверки
//     этой даты (CLI берёт дату компьютера, `--today` её заменяет): дата из будущего («2027» вместо «2026») иначе никогда не «протухла» бы и обошла срок годности 90 дней.
//     Без известной сегодняшней даты запись не выполняется (отказ `today_unknown`);
//   - пишет запись ТОЛЬКО с уровнем `measured` и ТОЛЬКО при n ≥ 5 (константа `MIN_N`, ниже её опустить нельзя ни флагом, ни файлом); при n < 5 отказывается и даже не показывает медиану;
//   - честность выборки (смещение выжившего): медиана «до первого прогноза» считается только по тем, кто до него дошёл, поэтому рядом с n всегда стоит число начавших (`started`):
//     запись реестра и предложенные тексты называют «n из started»; при доле дошедших ниже 80 % выводится предупреждение, ниже 50 % — отказ (`REACH_MIN_PCT`, `REACH_WARN_PCT`);
//   - без флага `--write` ничего не пишет: показывает отчёт и то, что записал бы.
// Источники:
//   first_forecast (REQ-110) — файлы `runway-metrics/1`, по одному на человека: берётся `first_forecast.after_seconds` (сумма активного времени шагов мастера «Старт»
//     к моменту первого прогноза; пауза между действиями засчитывается не дольше `IDLE_CAP_SECONDS`, а не исключается). Файл без первого прогноза или без шагов мастера в n не входит
//     (причина называется), но входит в число начавших; одинаковые по содержимому файлы считаются одним (копия файла не прибавляет людей).
//   quick_entry (REQ-090) — листы наблюдателя `runway-timing/1` (секундомер вне приложения): на человека 1…10 попыток в секундах; значение человека — медиана его попыток,
//     затем медиана по людям. В n входят люди с полным набором: не менее `TIMING_LIMITS.min_attempts` (3) попыток, как требует протокол; остальные считаются начавшими, но не вошедшими.
//     Копия листа (с любым порядком ключей) и повтор человека с тем же набором попыток не прибавляют людей. Лист не содержит имён и других полей (схема строгая).
// Что дальше (вручную): запись в `promises.json` — не вся публикация. Зеркало `REGISTRY` в `demo/promises.mjs` и тексты `showcase.cl_<id>` в `demo/i18n/showcase.mjs` инструмент не правит
// (это файлы оболочки приложения): после `--write` он печатает готовые строки, а тесты `promises` и `showcase` остаются красными, пока их не внесут. Так цифра не уходит на экран «мимо людей».
// Честно о границах: инструмент не проверяет, что файлы принадлежат разным людям и настоящим сеансам; он отсекает только копии и неверные файлы. Расчёт по введённым данным, не консультация.
//
// Использование (из каталога prototype/):
//   node tools/onboarding_median.mjs <файл>... [--measure first_forecast|quick_entry] [--date ГГГГ-ММ-ДД] [--today ГГГГ-ММ-ДД] [--registry <promises.json>] [--write]
// Коды выхода: 0 — готово; 1 — отказ (n < 5, доля дошедших ниже половины, неверная или будущая дата, конфликт с записью реестра, ошибка чтения); 2 — неверный запуск.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { to_epoch_day, format_date } from '../engine/index.mjs';
import { validate_package, package_text } from '../demo/metrics.mjs';
import { validate_registry, MEASURE_TTL_DAYS } from '../demo/promises.mjs';
import { lint_promises } from '../../tools/lint_vocab.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');

/** Реестр обещаний по умолчанию. */
export const PROMISES_FILE = path.join(PROTO, 'demo', 'promises.json');

/** Наименьшее число людей, при котором цифру можно записать (REQ-090, REQ-110). Опустить нельзя. */
export const MIN_N = 5;

/** Формат листа наблюдателя (секундомер вне приложения). */
export const TIMING_FORMAT = 'runway-timing/1';

/** Пределы листа наблюдателя; `min_attempts` — полный набор засчитанных попыток (протокол замера, часть A): человек с меньшим числом в n не входит. */
export const TIMING_LIMITS = Object.freeze({ persons: 50, attempts: 10, max_seconds: 600, min_attempts: 3 });

/**
 * Потолок простоя в таймере шагов мастера (`create_step_timer` в `demo/wizard.mjs`, по умолчанию минута): пауза между действиями засчитывается не дольше,
 * но НЕ исключается из активного времени. Значение называется в предложенном тексте; тест сверяет его с настоящим таймером.
 */
export const IDLE_CAP_SECONDS = 60;

/** Доля дошедших до результата среди начавших, %: ниже `REACH_WARN_PCT` — предупреждение, ниже `REACH_MIN_PCT` — отказ (медиана только по выжившим смещена вниз). */
export const REACH_MIN_PCT = 50;
export const REACH_WARN_PCT = 80;

/** Предел размера входного файла, байт (файл метрик — единицы килобайт). */
export const MAX_FILE_BYTES = 1_000_000;

const TEST_FILE = 'tests/onboarding_median.test.mjs';

/** Что измеряется: идентификатор записи реестра, требование, источник и тест, на который ссылается запись. */
export const MEASURES = Object.freeze({
  first_forecast: Object.freeze({ id: 'first_forecast_time', req: 'REQ-110', source: 'metrics', target_ms: null, test: Object.freeze({ file: TEST_FILE, id: 'REQ-110' }) }),
  quick_entry: Object.freeze({ id: 'quick_entry_time', req: 'REQ-090', source: 'timing', target_ms: 5000, test: Object.freeze({ file: TEST_FILE, id: 'REQ-090' }) }),
});

/** Отказ инструмента: код и подробности для сообщения. */
export class Refusal extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.name = 'Refusal';
    this.code = code;
    this.detail = detail;
  }
}

const sha = (text) => createHash('sha256').update(text).digest('hex');
const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// ── медиана ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Медиана целых миллисекунд; у чётного числа значений — полусумма двух средних, половина миллисекунды округляется вверх.
 * @param {number[]} values_ms неотрицательные целые
 * @returns {number}
 */
export function median_ms(values_ms) {
  if (!Array.isArray(values_ms) || values_ms.length === 0) throw new RangeError('median_ms: нужен непустой массив');
  for (const v of values_ms) if (!Number.isSafeInteger(v) || v < 0) throw new RangeError('median_ms: значения — неотрицательные целые миллисекунды');
  const s = [...values_ms].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m] : Math.floor((s[m - 1] + s[m] + 1) / 2);
}

/**
 * Итог по значениям: при n < `MIN_N` — отказ без медианы.
 * @param {number[]} values_ms
 * @returns {{ok: false, n: number, min_n: number}|{ok: true, n: number, median_ms: number, min_ms: number, max_ms: number}}
 */
export function evaluate(values_ms) {
  const n = values_ms.length;
  if (n < MIN_N) return { ok: false, n, min_n: MIN_N };
  return { ok: true, n, median_ms: median_ms(values_ms), min_ms: Math.min(...values_ms), max_ms: Math.max(...values_ms) };
}

/**
 * Доля дошедших до результата среди начавших (смещение выжившего): медиана считается только по `reached` из `started`.
 * Целочисленно, без дробей: пороги — проценты `REACH_MIN_PCT` и `REACH_WARN_PCT`.
 * @param {number} started начавшие (разные люди с корректными файлами)
 * @param {number} reached дошедшие до результата и вошедшие в n
 * @returns {{started: number, reached: number, refuse: boolean, warn: boolean}}
 */
export function reach_check(started, reached) {
  if (!Number.isSafeInteger(started) || !Number.isSafeInteger(reached) || reached < 0 || started < reached) throw new RangeError('reach_check: нужны целые started >= reached >= 0');
  return { started, reached, refuse: reached * 100 < started * REACH_MIN_PCT, warn: reached * 100 < started * REACH_WARN_PCT };
}

// ── чтение источников ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Значения «время до первого прогноза» по файлам `runway-metrics/1`.
 * `started` — начавшие: разные люди с корректными файлами, включая тех, кто до первого прогноза не дошёл (они в `skipped`, но не в `used`).
 * @param {{name: string, text: string}[]} files
 * @returns {{used: {name: string, ms: number}[], skipped: {name: string, reason: string, detail?: string}[], started: number}}
 */
export function read_metrics_values(files) {
  const used = [];
  const skipped = [];
  const seen = new Map();
  let not_reached = 0;
  for (const { name, text } of files) {
    let pkg;
    try { pkg = JSON.parse(text); } catch { skipped.push({ name, reason: 'not_json' }); continue; }
    const errors = validate_package(pkg);
    if (errors.length > 0) { skipped.push({ name, reason: 'invalid_package', detail: errors[0] }); continue; }
    const key = sha(package_text(pkg));
    if (seen.has(key)) { skipped.push({ name, reason: 'duplicate', detail: seen.get(key) }); continue; }
    seen.set(key, name);
    if (pkg.first_forecast === null) { skipped.push({ name, reason: 'first_forecast_not_reached' }); not_reached++; continue; }
    if (pkg.first_forecast.after_seconds === null) { skipped.push({ name, reason: 'no_wizard_steps' }); not_reached++; continue; }
    used.push({ name, ms: pkg.first_forecast.after_seconds * 1000 });
  }
  return { used, skipped, started: used.length + not_reached };
}

/** Проверка листа наблюдателя: ровно `format`, `measure`, `persons`; у человека только `attempts_s`. Возвращает нарушение или `null`. */
function timing_problem(sheet) {
  if (!is_obj(sheet)) return 'not_object';
  const keys = Object.keys(sheet);
  if (keys.length !== 3 || !['format', 'measure', 'persons'].every((k) => Object.hasOwn(sheet, k))) return 'keys';
  if (sheet.format !== TIMING_FORMAT) return 'format';
  if (sheet.measure !== 'quick_entry') return 'measure';
  if (!Array.isArray(sheet.persons) || sheet.persons.length === 0 || sheet.persons.length > TIMING_LIMITS.persons) return 'persons';
  for (const p of sheet.persons) {
    if (!is_obj(p) || Object.keys(p).length !== 1 || !Array.isArray(p.attempts_s)) return 'person';
    if (p.attempts_s.length === 0 || p.attempts_s.length > TIMING_LIMITS.attempts) return 'attempts';
    for (const s of p.attempts_s) if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0 || s > TIMING_LIMITS.max_seconds) return 'attempt_value';
  }
  return null;
}

/** Лист в каноническом виде (схема строгая, поэтому ключи известны): порядок ключей и пробелы в исходном файле на отпечаток копии не влияют. */
function canonical_sheet(sheet) {
  return { format: sheet.format, measure: sheet.measure, persons: sheet.persons.map((p) => ({ attempts_s: p.attempts_s })) };
}

/**
 * Значения «быстрый ввод» по листам наблюдателя `runway-timing/1`: на человека — медиана его попыток.
 * В `used` входят люди с полным набором (не менее `TIMING_LIMITS.min_attempts` попыток); остальные — в `skipped` с причиной `incomplete_attempts`, но среди начавших.
 * Копия листа (в том числе с другим порядком ключей) — `duplicate`; человек с тем же набором попыток, что уже учтённый (копия или совпадение), — `duplicate_person`.
 * `started` — начавшие: разные люди на корректных листах, включая людей с неполным набором.
 * @param {{name: string, text: string}[]} files
 * @returns {{used: {name: string, ms: number}[], skipped: {name: string, reason: string, detail?: string}[], started: number}}
 */
export function read_timing_values(files) {
  const used = [];
  const skipped = [];
  const seen = new Map();
  const seen_persons = new Map();
  let started = 0;
  for (const { name, text } of files) {
    let sheet;
    try { sheet = JSON.parse(text); } catch { skipped.push({ name, reason: 'not_json' }); continue; }
    const problem = timing_problem(sheet);
    if (problem !== null) { skipped.push({ name, reason: 'invalid_sheet', detail: problem }); continue; }
    const key = sha(JSON.stringify(canonical_sheet(sheet)));
    if (seen.has(key)) { skipped.push({ name, reason: 'duplicate', detail: seen.get(key) }); continue; }
    seen.set(key, name);
    sheet.persons.forEach((p, i) => {
      const label = name + '#' + (i + 1);
      const person_key = JSON.stringify([...p.attempts_s].sort((a, b) => a - b));
      if (seen_persons.has(person_key)) { skipped.push({ name: label, reason: 'duplicate_person', detail: seen_persons.get(person_key) }); return; }
      seen_persons.set(person_key, label);
      started++;
      if (p.attempts_s.length < TIMING_LIMITS.min_attempts) { skipped.push({ name: label, reason: 'incomplete_attempts', detail: String(p.attempts_s.length) }); return; }
      used.push({ name: label, ms: median_ms(p.attempts_s.map((s) => Math.round(s * 1000))) });
    });
  }
  return { used, skipped, started };
}

// ── запись реестра ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Календарная дата `ГГГГ-ММ-ДД` существует. */
export function valid_date(s) {
  try { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && format_date(to_epoch_day(s)) === s; } catch { return false; }
}

/**
 * Запись реестра: уровень всегда `measured`, дата проверки равна дате замера.
 * Если передан `cohort` (`{started}`, число начавших), запись несёт `started` рядом с `n`: «n из started» — защита от смещения выжившего.
 * Начавших должно быть не меньше `n`, а дошедших — не меньше `REACH_MIN_PCT` % (иначе отказ `reach_below_min`).
 * @param {'first_forecast'|'quick_entry'} measure
 * @param {{n: number, median_ms: number}} ev результат `evaluate` с ok = true
 * @param {string} date
 * @param {{started: number}} [cohort]
 */
export function make_record(measure, ev, date, cohort = undefined) {
  const m = MEASURES[measure];
  if (m === undefined) throw new Refusal('unknown_measure', { measure });
  if (!valid_date(date)) throw new Refusal('bad_date', { date: String(date) });
  if (!Number.isSafeInteger(ev.n) || ev.n < MIN_N) throw new Refusal('n_below_min', { n: ev.n, min_n: MIN_N });
  let cohort_part = {};
  if (cohort !== undefined) {
    if (!Number.isSafeInteger(cohort.started) || cohort.started < ev.n) throw new Refusal('cohort_invalid', { started: String(cohort.started), n: ev.n });
    if (reach_check(cohort.started, ev.n).refuse) throw new Refusal('reach_below_min', { started: cohort.started, n: ev.n, min_pct: REACH_MIN_PCT });
    cohort_part = { started: cohort.started };
  }
  return {
    id: m.id,
    kind: 'promise',
    text_key: 'showcase.cl_' + m.id,
    level: 'measured',
    surface: 'ui',
    checked_on: date,
    measured_on: date,
    n: ev.n,
    ...cohort_part,
    median_ms: ev.median_ms,
    test: { file: m.test.file, id: m.test.id },
  };
}

/**
 * Добавить запись к реестру или заменить прежнее измерение того же утверждения (только более поздним или равным по дате).
 * Результат проверяется формой реестра и правилами линтера обещаний; нарушение — отказ, файл не пишется.
 * @param {object[]} rows
 * @param {object} rec
 * @param {{today?: string}} [opts] `today` — если задан, измерение старше 90 дней отвергается (линтер заблокировал бы сборку)
 * @returns {object[]}
 */
export function merge_record(rows, rec, opts = {}) {
  if (!Array.isArray(rows)) throw new Refusal('registry_not_array');
  if (rec.level !== 'measured') throw new Refusal('level_not_measured', { level: String(rec.level) });
  if (rec.started !== undefined && (!Number.isSafeInteger(rec.started) || rec.started < rec.n)) throw new Refusal('registry_invalid', { problem: 'started_below_n' });
  const i = rows.findIndex((r) => r?.id === rec.id);
  let next;
  if (i < 0) next = [...rows, rec];
  else {
    const old = rows[i];
    if (old.level !== 'measured') throw new Refusal('existing_not_measured', { id: rec.id, level: String(old.level) });
    if (typeof old.measured_on === 'string' && old.measured_on > rec.measured_on) throw new Refusal('older_than_existing', { id: rec.id, existing: old.measured_on, given: rec.measured_on });
    next = rows.map((r, k) => (k === i ? rec : r));
  }
  const form = validate_registry(next);
  if (form.length > 0) throw new Refusal('registry_invalid', { problem: form[0] });
  if (opts.today !== undefined) {
    if (!valid_date(opts.today)) throw new Refusal('bad_date', { date: String(opts.today) });
    const age = to_epoch_day(opts.today) - to_epoch_day(rec.measured_on);
    if (age > MEASURE_TTL_DAYS) throw new Refusal('stale_measurement', { age_days: age, limit_days: MEASURE_TTL_DAYS });
    if (age < 0) throw new Refusal('date_in_future', { measured_on: rec.measured_on, today: opts.today });
  }
  // правила линтера — к новой записи: чужие устаревшие строки реестра не мешают записать свежее измерение (их остановит сам линтер при сборке)
  const lint = lint_promises([rec], opts.today ?? rec.measured_on, 'registry').filter((f) => f.level === 'error');
  if (lint.length > 0) throw new Refusal('lint_rejected', { rule: lint[0].rule });
  return next;
}

/** Значение в строку JSON в стиле файла: объекты в одну строку с пробелами внутри скобок. */
function inline_json(v) {
  if (is_obj(v)) return '{ ' + Object.entries(v).map(([k, x]) => JSON.stringify(k) + ': ' + inline_json(x)).join(', ') + ' }';
  return JSON.stringify(v);
}

/** Текст `promises.json` в принятом стиле: по записи на строке, отступ два пробела, перевод строки в конце. */
export function render_registry(rows) {
  return '[\n' + rows.map((r) => '  ' + inline_json(r)).join(',\n') + '\n]\n';
}

// ── тексты для ручного шага ────────────────────────────────────────────────────────────────────────────────────────────

/** Длительность словами: до минуты — секунды с одним знаком, дальше — минуты и секунды. */
export function format_duration(lang, ms) {
  const ru = lang === 'ru';
  if (ms < 60000) {
    const tenths = Math.round(ms / 100);
    const whole = Math.floor(tenths / 10);
    const frac = tenths % 10;
    const num = frac === 0 ? String(whole) : whole + (ru ? ',' : '.') + frac;
    return num + (ru ? ' с' : ' s');
  }
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + (ru ? ' мин' : ' min') + (s === 0 ? '' : ' ' + s + (ru ? ' с' : ' s'));
}

/**
 * Что надо внести руками после записи в `promises.json`: строка зеркала, тексты RU и EN.
 * @param {'first_forecast'|'quick_entry'} measure
 * @param {object} rec запись реестра
 */
export function followups(measure, rec) {
  const dur = (lang) => format_duration(lang, rec.median_ms);
  // «n из started»: без числа начавших «n = 5» читается как «все пять справились» (смещение выжившего)
  const has_cohort = rec.started !== undefined;
  const all_reached = has_cohort && rec.started === rec.n;
  const cohort = measure === 'first_forecast'
    ? {
      ru: !has_cohort ? '' : all_reached ? `, до первого прогноза дошли все ${rec.n} начавших` : `, в расчёт вошли ${rec.n} из ${rec.started} участников, остальные до первого прогноза не дошли`,
      en: !has_cohort ? '' : all_reached ? `, all ${rec.n} participants who started reached the first forecast` : `, ${rec.n} of ${rec.started} participants are in the calculation, the rest did not reach the first forecast`,
    }
    : {
      ru: has_cohort ? `, полный набор попыток у ${rec.n} из ${rec.started} человек` : '',
      en: has_cohort ? `, ${rec.n} of ${rec.started} people have a full set of attempts` : '',
    };
  const texts = measure === 'first_forecast'
    ? {
      ru: `Время до первого прогноза в мастере «Старт»: медиана ${dur('ru')} активного времени (n = ${rec.n}${cohort.ru}; замер ${rec.measured_on}). Каждая пауза между действиями засчитана не дольше ${IDLE_CAP_SECONDS} с. Это результат замера на небольшой группе, а не обещание для каждого.`,
      en: `Time to the first forecast in the Start wizard: median ${dur('en')} of active time (n = ${rec.n}${cohort.en}; measured ${rec.measured_on}). Each pause between actions counts for at most ${IDLE_CAP_SECONDS} s. This is the result of a measurement on a small group, not a promise for everyone.`,
    }
    : {
      ru: `Быстрый ввод факта: медиана ${dur('ru')} на человека (n = ${rec.n}${cohort.ru}; замер ${rec.measured_on}, секундомер вне приложения). Это результат замера на небольшой группе, а не обещание для каждого.`,
      en: `Quick fact entry: median ${dur('en')} per person (n = ${rec.n}${cohort.en}; measured ${rec.measured_on}, stopwatch outside the app). This is the result of a measurement on a small group, not a promise for everyone.`,
    };
  const started_part = has_cohort ? ` started: ${rec.started},` : '';
  const mirror = `  claim('${rec.id}', '${rec.kind}', 'measured', '${rec.test.file}', '${rec.test.id}', { checked_on: '${rec.checked_on}', measured_on: '${rec.measured_on}', n: ${rec.n},${started_part} median_ms: ${rec.median_ms} }),`;
  return { texts, mirror, key: rec.text_key };
}

// ── командная строка ───────────────────────────────────────────────────────────────────────────────────────────────────

const HELP = `Использование: node tools/onboarding_median.mjs <файл>... [--measure first_forecast|quick_entry] [--date ГГГГ-ММ-ДД] [--today ГГГГ-ММ-ДД] [--registry <promises.json>] [--write]
  first_forecast (по умолчанию, REQ-110) — файлы runway-metrics/1, по одному на человека: время до первого прогноза.
  quick_entry (REQ-090) — листы наблюдателя runway-timing/1: секундомер вне приложения.
  --date     дата замера (обязательна с --write): в файлах метрик календарных дат нет, её называет человек.
  --today    сегодняшняя дата для сверки даты замера: из будущего и старше 90 дней дата отвергается. По умолчанию — дата компьютера;
             если сегодняшняя дата неизвестна, запись не выполняется.
  --write    записать запись measured в реестр (без флага — только отчёт). Записывает при n >= ${MIN_N} и доле дошедших не ниже ${REACH_MIN_PCT} %; иначе отказ.`;

const REFUSAL_TEXT = Object.freeze({
  n_below_min: (d) => `учтено n = ${d.n} из ${d.min_n} обязательных: медиана не вычисляется, цифру публиковать нельзя`,
  bad_date: (d) => `дата «${d.date}» не календарная (нужна ГГГГ-ММ-ДД)`,
  existing_not_measured: (d) => `в реестре уже есть утверждение «${d.id}» уровня «${d.level}»: инструмент не заменяет такие записи`,
  older_than_existing: (d) => `в реестре измерение «${d.id}» от ${d.existing} новее заданной даты ${d.given}`,
  registry_invalid: (d) => `реестр после записи не прошёл бы проверку формы (${d.problem})`,
  stale_measurement: (d) => `измерение старше ${d.limit_days} дней (${d.age_days}): линтер обещаний заблокировал бы сборку`,
  date_in_future: (d) => `дата замера ${d.measured_on} позже сегодняшней ${d.today}`,
  lint_rejected: (d) => `линтер обещаний отверг бы запись (правило ${d.rule})`,
  registry_not_array: () => 'реестр — не массив',
  level_not_measured: (d) => `уровень «${d.level}» записывать нельзя: только measured`,
  unknown_measure: (d) => `неизвестное измерение «${d.measure}»`,
  today_unknown: () => 'не известна сегодняшняя дата, а без неё дату замера не сверить (дата из будущего обошла бы срок годности 90 дней): укажите --today ГГГГ-ММ-ДД',
  reach_below_min: (d) => `до результата дошли ${d.n} из ${d.started} начавших, меньше ${d.min_pct} %: медиана только по дошедшим смещена вниз, цифру публиковать нельзя`,
  cohort_invalid: (d) => `число начавших (${d.started}) меньше n (${d.n})`,
});

const SKIP_TEXT = Object.freeze({
  not_json: 'не JSON',
  invalid_package: 'не проходит схему runway-metrics/1',
  invalid_sheet: 'не проходит схему листа runway-timing/1',
  duplicate: 'копия уже учтённого файла',
  first_forecast_not_reached: 'первый прогноз не получен',
  no_wizard_steps: 'мастер «Старт» не проходился (нет шагов)',
  incomplete_attempts: `неполный набор попыток (нужно не менее ${TIMING_LIMITS.min_attempts}); человек начал, но в n не входит`,
  duplicate_person: 'набор попыток совпадает с уже учтённым человеком (копия листа или совпадение): не засчитан',
});

function parse_args(argv) {
  const out = { files: [], measure: 'first_forecast', date: undefined, today: undefined, registry: PROMISES_FILE, write: false, help: false };
  const value = (i, name) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Refusal('usage', { why: `после ${name} нужно значение` });
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help') out.help = true;
    else if (a === '--write') out.write = true;
    else if (a === '--measure') { out.measure = value(i, a); i++; }
    else if (a === '--date') { out.date = value(i, a); i++; }
    else if (a === '--today') { out.today = value(i, a); i++; }
    else if (a === '--registry') { out.registry = path.resolve(value(i, a)); i++; }
    else if (a.startsWith('--')) throw new Refusal('usage', { why: `неизвестный флаг ${a}` });
    else out.files.push(a);
  }
  return out;
}

function default_io() {
  return {
    read: (p) => {
      if (fs.statSync(p).size > MAX_FILE_BYTES) throw new Refusal('file_too_big', { file: p });
      return fs.readFileSync(p, 'utf8');
    },
    write: (p, text) => {
      const tmp = p + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, p);
    },
    out: (s) => process.stdout.write(s + '\n'),
    err: (s) => process.stderr.write(s + '\n'),
    today: local_today,
  };
}

/** Сегодняшняя дата компьютера (местная) в виде `ГГГГ-ММ-ДД`; единственное место, где инструмент читает часы: только для сверки даты замера. */
function local_today() {
  const d = new Date();
  return String(d.getFullYear()).padStart(4, '0') + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** Командная строка; возвращает код выхода. `io.today()` (необязательна) — сегодняшняя дата, когда нет `--today`. */
export function main(argv, io = default_io()) {
  let args;
  try { args = parse_args(argv); } catch (e) {
    if (e instanceof Refusal) { io.err(`Ошибка запуска: ${e.detail.why}.\n${HELP}`); return 2; }
    throw e;
  }
  if (args.help) { io.out(HELP); return 0; }
  const m = MEASURES[args.measure];
  if (m === undefined) { io.err(`Ошибка запуска: неизвестное измерение «${args.measure}».\n${HELP}`); return 2; }
  if (args.files.length === 0) { io.err(`Ошибка запуска: не указано ни одного файла.\n${HELP}`); return 2; }
  if (args.write && args.date === undefined) { io.err('Ошибка запуска: для --write нужна --date ГГГГ-ММ-ДД (дату замера называет человек).'); return 2; }
  if (args.date !== undefined && !valid_date(args.date)) { io.err(`Ошибка: дата «${args.date}» не календарная (нужна ГГГГ-ММ-ДД).`); return 2; }
  if (args.today !== undefined && !valid_date(args.today)) { io.err(`Ошибка: дата «${args.today}» не календарная (нужна ГГГГ-ММ-ДД).`); return 2; }

  let inputs;
  try { inputs = args.files.map((f) => ({ name: path.basename(f), text: io.read(f) })); } catch (e) {
    io.err(`Ошибка чтения файла: ${e instanceof Refusal ? e.code : (e?.code ?? 'ошибка')}`);
    return 1;
  }
  const { used, skipped, started } = m.source === 'metrics' ? read_metrics_values(inputs) : read_timing_values(inputs);
  const what = m.source === 'metrics' ? 'время до первого прогноза (активное время шагов мастера «Старт»), файлы runway-metrics/1' : 'быстрый ввод факта, листы наблюдателя runway-timing/1';
  io.out(`Измерение: ${args.measure} (${m.req}) — ${what}`);
  io.out(`Файлов: ${inputs.length} · начали: ${started} · учтено людей (n): ${used.length} · пропущено файлов: ${skipped.length}`);
  for (const s of skipped) io.out(`  пропущен «${s.name}»: ${SKIP_TEXT[s.reason] ?? s.reason}${s.detail === undefined ? '' : ' (' + s.detail + ')'}`);

  const ev = evaluate(used.map((u) => u.ms));
  if (!ev.ok) {
    io.out(`Отказ: ${REFUSAL_TEXT.n_below_min({ n: ev.n, min_n: ev.min_n })} (${m.req}: замер на не менее чем ${MIN_N} людях).`);
    return 1;
  }
  const reach = reach_check(started, ev.n);
  if (reach.refuse) {
    io.out(`Отказ: ${REFUSAL_TEXT.reach_below_min({ n: ev.n, started, min_pct: REACH_MIN_PCT })}.`);
    return 1;
  }
  io.out(`Медиана: ${format_duration('ru', ev.median_ms)} (${ev.median_ms} мс) · минимум ${format_duration('ru', ev.min_ms)} · максимум ${format_duration('ru', ev.max_ms)}`);
  io.out(`Дошли до результата: ${ev.n} из ${started}. Медиана считается только по ним.`);
  if (reach.warn) io.out(`Предупреждение: дошли меньше ${REACH_WARN_PCT} % начавших. Медиана только по дошедшим занижена: публикуйте её вместе со словами «${ev.n} из ${started}», а причины, по которым остальные не дошли, разберите отдельно.`);
  if (m.target_ms !== null) io.out(`Цель ${m.req} — не более ${format_duration('ru', m.target_ms)}: ${ev.median_ms <= m.target_ms ? 'достигнута' : 'не достигнута (измерение можно публиковать как есть, требование не закрыто)'}.`);
  if (args.date === undefined) {
    io.out('Запись не выполнена: дата замера не задана (--date ГГГГ-ММ-ДД), флаг --write не указан.');
    return 0;
  }
  let rec;
  let rows;
  try {
    const today = args.today ?? io.today?.();
    if (today === undefined || !valid_date(today)) throw new Refusal('today_unknown');
    rec = make_record(args.measure, ev, args.date, { started });
    rows = JSON.parse(io.read(args.registry));
    rows = merge_record(rows, rec, { today });
  } catch (e) {
    if (e instanceof Refusal) { io.out(`Отказ: ${(REFUSAL_TEXT[e.code] ?? (() => e.code))(e.detail)}.`); return 1; }
    io.err(`Ошибка чтения реестра «${args.registry}»: ${e?.code ?? e?.message ?? 'ошибка'}`);
    return 1;
  }
  if (!args.write) {
    io.out('Запись не выполнена (нужен флаг --write). Была бы записана:');
    io.out('  ' + inline_json(rec));
    return 0;
  }
  io.write(args.registry, render_registry(rows));
  io.out(`Записано в ${args.registry}: ${rec.id} (level measured, n = ${rec.n}, ${rec.measured_on}).`);
  const f = followups(args.measure, rec);
  io.out('Теперь вручную (инструмент эти файлы не правит; пока не внесено, тесты promises и showcase красные):');
  io.out(`  1. demo/promises.mjs, массив REGISTRY — добавить строку:\n${f.mirror}`);
  io.out(`  2. demo/i18n/showcase.mjs — ключ «${f.key}» в ru и en (текст предложен):\n     ru: ${f.texts.ru}\n     en: ${f.texts.en}`);
  io.out('  3. из prototype/: node tools/build_manifest.mjs (оболочка изменилась), затем тесты promises, showcase, onboarding_median и node ../tools/lint_vocab.mjs.');
  io.out('  4. строка first_minutes («время до первого прогноза не заявляем») после публикации цифры устаревает: решает владелец (заменить или оставить).');
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
