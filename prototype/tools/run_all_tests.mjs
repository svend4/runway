#!/usr/bin/env node
// run_all_tests.mjs — FP-24, REQ-158/171: сквозной прогон всех tests/**/*.test.mjs ПО ОДНОМУ ФАЙЛУ (один процесс node за раз: память машины мала, параллельный `node --test`
// без аргументов уже подвешивал систему). Итог — сводка JSON и текст. Образец — _ops/impl/run/run_all.mjs, перенесённый сюда с ключом --resume и таймаутом на файл.
//   node tools/run_all_tests.mjs [--fast | --nightly] [--resume [--rerun-failed]] [--timeout 240] [--only подстрока[,подстрока]] [--list]
//                                [--out-json путь] [--out-txt путь] [--no-write] [--root каталог] [--single-process]
// Профили: по умолчанию — все файлы; `--fast` — без тяжёлых (список HEAVY_FILES: сотни мс на тест, десятки секунд на файл или большой объём памяти);
// `--nightly` — все файлы с повышенными объёмами случайных наборов (FUZZ_N, GP_SEEDS, SMALL_N; PROP_N остаётся 1000 — это норма REQ-171).
// `--resume` продолжает прерванный прогон: файлы, уже записанные в --out-json, пропускаются (`--rerun-failed` — красные запускаются заново). Таймаут (`--timeout`, секунды, по умолчанию
// 240) передаётся раннеру (`--test-timeout`) и контролируется снаружи: зависший процесс убивается, файл помечается `timed_out`. Код выхода: 0 — всё зелёное, 1 — есть красные
// или не уложившиеся, 2 — неверный запуск. Часов в движке это не касается: инструмент вне engine/, node:* и process допустимы. Расчёт по введённым данным и правилам, не консультация.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PROTO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Тяжёлые файлы (исключаются профилем `--fast`): измеренное время файла от 7 с на этой машине (сквозные прогоны 2026-10-27, `_ops/impl/run/verify-wave3a4-fp24.json`, и 2026-10-28,
 * `verify-wave3a4-fp24-fix.json`; берётся большее из двух замеров) либо большой объём памяти/случайных наборов. Пути — от prototype/. Порог один для всех: файл медленнее 7 с, которого нет в списке,
 * делает `test:fast` долгим (проверка 2026-10-28 нашла девять таких файлов, повторный замер — ещё два; все ниже).
 * Список проверяет tests/run_all_tests.test.mjs: каждый файл существует, `--fast` их не запускает, названные в проверке 2026-10-28 файлы в списке есть.
 */
export const HEAVY_FILES = Object.freeze([
  'tests/properties.test.mjs', 'tests/properties_mutation.test.mjs', 'tests/engine_lock.test.mjs', 'tests/small_journals.test.mjs', 'tests/validate_ws.test.mjs',
  'tests/build_manifest.test.mjs', 'tests/s1_5_adv.test.mjs', 'tests/quality_report.test.mjs', 'tests/quality_tools.test.mjs', 'tests/mutate_engine.test.mjs',
  'tests/adversarial/dates_money.test.mjs', 'tests/adversarial/verifier_io.test.mjs', 'tests/adversarial/golden_properties.test.mjs', 'tests/backtest.test.mjs', 'tests/import_race.test.mjs',
  'tests/bench_compare.test.mjs',
  // исправление 2026-10-28 (замер: 19,0 / 14,7 / 13,2 / 11,9 / 11,4 / 8,9 / 7,9 / 7,3 с; fp24_adv — ≈ 40 с: независимая проверка поднимает копии проекта)
  'tests/fp48_adv.test.mjs', 'tests/journal_log.test.mjs', 'tests/import_worker_model.test.mjs', 'tests/run_all_tests.test.mjs', 'tests/import_worker.test.mjs', 'tests/bench_pages.test.mjs',
  'tests/fuzz_nightly.test.mjs', 'tests/import_main_thread.test.mjs', 'tests/fp24_adv.test.mjs',
  // повторный замер 2026-10-28 (сквозной прогон после исправления, `_ops/impl/run/verify-wave3a4-fp24-fix.json`): ещё два файла выше порога — 11,1 и 7,4 с
  'tests/reserve_screen.test.mjs', 'tests/check_script.test.mjs',
  // FP-49 (2026-10-28): заглушка Worker держит ответы и ждёт возраст сообщения дольше окна 600 мс — файл идёт ≈ 14 с
  'tests/fp49_boot.test.mjs',
  // FP-49, исправление после проверки (2026-10-28): пять встроенных наборов на экране «Данные», по запуску приложения на заглушке DOM — файл идёт ≈ 11 с
  'tests/fp49_fix.test.mjs',
]);

/** Объёмы профиля `--nightly` (переменные окружения, которые читают тесты). */
export const NIGHTLY_ENV = Object.freeze({ FUZZ_N: '20000', GP_SEEDS: '600', SMALL_N: '1500' });

/** Все файлы `*.test.mjs` под `tests/` (рекурсивно), пути от `root`, по алфавиту. */
export function discover(root = PROTO) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.test.mjs')) out.push(path.relative(root, p).split(path.sep).join('/'));
    }
  };
  const tests = path.join(root, 'tests');
  if (fs.existsSync(tests)) walk(tests);
  return out.sort();
}

/** Сводка раннера `node --test` (строки `ℹ tests N`, …); нет строки — `null`. */
export function parse_summary(text) {
  const n = (k) => { const m = new RegExp('^ℹ ' + k + ' (\\d+)', 'm').exec(text); return m === null ? null : Number(m[1]); };
  return { tests: n('tests'), pass: n('pass'), fail: n('fail'), skipped: n('skipped'), todo: n('todo'), cancelled: n('cancelled') };
}

/** Строки с причиной падения (первые `max`). */
export function failure_tail(text, max = 12) {
  return text.split('\n').filter((l) => /not ok|✖|Error|expected|actual|AssertionError/.test(l)).slice(0, max);
}

/** Строка файла считается красной: не нулевой код, упавшие или отменённые тесты, нет сводки, таймаут. */
export const is_red = (r) => r.timed_out === true || r.status !== 0 || (r.fail ?? 1) !== 0 || (r.cancelled ?? 0) !== 0 || r.tests === null;

/**
 * Запустить один файл отдельным процессом node. `single` (ключ `--single-process`) — `--test-isolation=none`: тест идёт в процессе раннера, и остановка по таймауту убивает всё;
 * по умолчанию раннер запускает файл дочерним процессом, и на Windows после таймаута тот мог бы остаться работать (процесс-сирота).
 * @returns {{file: string, tests: number|null, pass: number|null, fail: number|null, skipped: number|null, todo: number|null, cancelled: number|null, ms: number, status: number|null, timed_out: boolean, tail?: string[]}}
 */
export function run_file(root, rel, { timeout_s = 240, env = {}, single = false, grace_ms = 5000 } = {}) {
  const t0 = Date.now();
  const child_env = { ...process.env, ...env };
  delete child_env.NODE_TEST_CONTEXT; // запуск изнутри теста: дочерний раннер должен писать обычную сводку
  const r = spawnSync(process.execPath, ['--test', ...(single ? ['--test-isolation=none'] : []), '--test-timeout=' + timeout_s * 1000, '--test-concurrency=1', rel], {
    cwd: root, env: child_env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: Math.round(timeout_s * 1000 * 1.25) + grace_ms, // жёсткий предел: раннер получает свой таймаут (--test-timeout) и ещё четверть времени плюс запас на запуск
  });
  const text = (r.stdout ?? '') + (r.stderr ?? '');
  const timed_out = r.error?.code === 'ETIMEDOUT';
  const row = { file: rel, ...parse_summary(text), ms: Date.now() - t0, status: r.status, timed_out };
  if (is_red(row)) row.tail = timed_out ? ['таймаут ' + timeout_s + ' с: процесс остановлен'] : failure_tail(text);
  return row;
}

/** Текст сводки: итоговая строка, красные файлы с причинами, таблица по файлам. */
export function summary_text(rows, { profile, of, finished, started_ms, now_ms }) {
  const sum = (k) => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
  const bad = rows.filter(is_red);
  const head = `Сквозной прогон (профиль «${profile}») ${rows.length} из ${of} файлов по одному${finished ? '' : ' — НЕ завершён'}: тестов ${sum('tests')}, прошло ${sum('pass')}, упало ${sum('fail')}, пропущено ${sum('skipped')}, todo ${sum('todo')}; красных файлов ${bad.length}; время ${Math.round((now_ms - started_ms) / 1000)} с`;
  return [head, ...bad.map((r) => `КРАСНЫЙ ${r.file}: tests=${r.tests} pass=${r.pass} fail=${r.fail} status=${r.status}${r.timed_out ? ' ТАЙМАУТ' : ''}\n  ` + (r.tail ?? []).join('\n  ')),
    ...rows.map((r) => `${r.file}\t${r.tests}\t${r.pass}\t${r.fail}\t${r.skipped}\t${r.todo}\t${r.ms}мс`)].join('\n') + '\n';
}

function arg_of(argv, name, def) { const i = argv.indexOf(name); return i < 0 ? def : argv[i + 1]; }

/**
 * Прогнать выбранные файлы. `log` получает строку на каждый файл; `write(rows, finished)` вызывается после каждого файла (устойчивость к обрыву).
 * @returns {{rows: object[], files: string[], skipped_resume: number}}
 */
export function run_all({ root = PROTO, files, resume_rows = [], rerun_failed = false, timeout_s = 240, env = {}, single = false, log = () => {}, write = () => {}, run = run_file }) {
  const wanted = new Set(files);
  const rows = resume_rows.filter((r) => wanted.has(r.file) && !(rerun_failed && is_red(r)));
  const done = new Set(rows.map((r) => r.file));
  for (const f of files) {
    if (done.has(f)) continue;
    const row = run(root, f, { timeout_s, env, single });
    rows.push(row);
    log(`${is_red(row) ? 'КРАСНЫЙ' : 'ok     '} ${f}: ${row.tests} тестов, ${row.ms} мс${row.timed_out ? ' (таймаут)' : ''}`);
    write(rows, false);
  }
  return { rows, files, skipped_resume: done.size };
}

function main(argv) {
  const root = path.resolve(arg_of(argv, '--root', PROTO));
  const profile = argv.includes('--nightly') ? 'nightly' : argv.includes('--fast') ? 'fast' : 'all';
  if (argv.includes('--fast') && argv.includes('--nightly')) { console.error('--fast и --nightly несовместимы'); return 2; }
  const timeout_s = Number(arg_of(argv, '--timeout', 240));
  if (!Number.isFinite(timeout_s) || timeout_s < 1) { console.error('--timeout — число секунд ≥ 1'); return 2; }
  let files = discover(root);
  if (profile === 'fast') files = files.filter((f) => !HEAVY_FILES.includes(f));
  const only = arg_of(argv, '--only', null);
  if (only !== null) { const parts = only.split(','); files = files.filter((f) => parts.some((p) => f.includes(p))); }
  if (argv.includes('--list')) { for (const f of files) console.log(f + (HEAVY_FILES.includes(f) ? '\t(тяжёлый)' : '')); return 0; }
  if (files.length === 0) { console.error('нет файлов тестов под ' + path.join(root, 'tests')); return 2; }
  const stem = path.join(PROTO, '..', '_ops', 'impl', 'run', 'run_all_tests' + (profile === 'all' ? '' : '-' + profile));
  const out_json = path.resolve(arg_of(argv, '--out-json', stem + '.json'));
  const out_txt = path.resolve(arg_of(argv, '--out-txt', stem + '.txt'));
  const no_write = argv.includes('--no-write');
  let resume_rows = [];
  if (argv.includes('--resume') && fs.existsSync(out_json)) {
    try { resume_rows = JSON.parse(fs.readFileSync(out_json, 'utf8')).rows ?? []; } catch { console.error('--resume: не удалось прочитать ' + out_json); return 2; }
  }
  const started = Date.now();
  const env = profile === 'nightly' ? { ...NIGHTLY_ENV } : {};
  console.log(`профиль «${profile}»: ${files.length} файлов, таймаут ${timeout_s} с на файл; Node ${process.version}; свободно ОЗУ ${Math.round(os.freemem() / 2 ** 20)} МБ${resume_rows.length > 0 ? `; продолжение: уже есть ${resume_rows.length}` : ''}`);
  const write = (rows, finished) => {
    if (no_write) return;
    fs.mkdirSync(path.dirname(out_json), { recursive: true });
    fs.writeFileSync(out_json, JSON.stringify({ profile, done: rows.length, of: files.length, finished, node: process.version, rows }, null, 1));
    fs.writeFileSync(out_txt, summary_text(rows, { profile, of: files.length, finished, started_ms: started, now_ms: Date.now() }));
  };
  const { rows } = run_all({ root, files, resume_rows, rerun_failed: argv.includes('--rerun-failed'), timeout_s, env, single: argv.includes('--single-process'), log: (s) => console.log(s), write });
  write(rows, true);
  console.log(summary_text(rows, { profile, of: files.length, finished: true, started_ms: started, now_ms: Date.now() }).split('\n')[0]);
  return rows.some(is_red) ? 1 : 0;
}

const is_main = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (is_main) process.exitCode = main(process.argv.slice(2));
