#!/usr/bin/env node
// fuzz_nightly.mjs — ночной фаззинг и property-инварианты одним запуском (FP-12, REQ-171, REQ-174, REQ-158, TST-51): гоняет три набора тестов с повышенными объёмами и
// записывает итог в _ops/fuzz-nightly.json. Наборы и переменные окружения, которые они читают:
//   hardening       tests/hardening.test.mjs              FUZZ_N — расширенный фаззинг парсера сумм и верификатора (по умолчанию пропущен)
//   validate_ws     tests/validate_ws.test.mjs            FUZZ_N — повреждённые рабочие области (минимум 1200), журналы-копии и пул с ±(2^53−1) (FP-24; не более 20000)
//   golden          tests/adversarial/golden_properties.test.mjs   GP_SEEDS — число случайных рабочих областей с seed (по умолчанию 160)
// Короткий режим по умолчанию: FUZZ_N = 2000, GP_SEEDS = 200 (проверка, что ночной режим работает). Полный ночной: `--full` (FUZZ_N = 100000, GP_SEEDS = 1500). Наборы идут строго
// по одному (отдельный процесс `node --test` по одному файлу).
//   node tools/fuzz_nightly.mjs --date 2026-10-09 [--n 2000] [--seeds 200] [--only hardening,golden] [--full] [--limit-min 60] [--root каталог] [--out ../_ops/fuzz-nightly.json] [--no-write]
// Дата — обязательный аргумент: инструмент календарь не читает (длительность он измеряет). FP-24: `--limit-min N` — общий предел времени прогона в минутах (для `--full` по умолчанию 60): набор,
// не уложившийся в остаток, останавливается, его ход (сколько циклов выполнено) берётся из файла хода tests/fuzz_progress.mjs, а в итоге честно записано `complete: false`. Полный прогон
// пишется в раздел `full` файла результата; поля короткого прогона (mode, fuzz_n, results…) он не меняет и наоборот. Наборы идут в порядке hardening → golden → validate_ws:
// самый долгий — последним. Инструмент вне engine/: node:* и process допустимы. Расчёт по введённым данным и правилам, не консультация.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PROTO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Наборы: имя → файл и имя переменной, через которую задаётся объём. */
export const SUITES = Object.freeze({
  hardening: { file: 'tests/hardening.test.mjs', env: 'FUZZ_N', what: 'фаззинг парсера сумм и верификатора (REQ-158, TST-51)' },
  validate_ws: { file: 'tests/validate_ws.test.mjs', env: 'FUZZ_N', what: 'повреждённые рабочие области: результат или код REQ-017, 0 необработанных исключений' },
  golden: { file: 'tests/adversarial/golden_properties.test.mjs', env: 'GP_SEEDS', what: 'property-инварианты на случайных рабочих областях с seed (REQ-171)' },
});

export const SHORT = Object.freeze({ n: 2000, seeds: 200 });
export const FULL = Object.freeze({ n: 100000, seeds: 1500 });
/** Порядок наборов полного прогона: самый долгий (validate_ws) — последним, чтобы лимит времени обрезал только его. */
export const FULL_ORDER = Object.freeze(['hardening', 'golden', 'validate_ws']);
/** Предел времени полного прогона по умолчанию, минут (спецификация FP-24). */
export const FULL_LIMIT_MIN = 60;

/** Разобрать сводку раннера `node --test` (строки `ℹ tests N` и т. д.). */
export function parse_summary(out) {
  const num = (name) => Number(new RegExp('^ℹ ' + name + ' (\\d+)', 'm').exec(out)?.[1] ?? NaN);
  const dur = Number(/^ℹ duration_ms ([\d.]+)/m.exec(out)?.[1] ?? NaN);
  return { tests: num('tests'), pass: num('pass'), fail: num('fail'), skipped: num('skipped'), todo: num('todo'), duration_ms: Math.round(dur) };
}

const SUMMARY_KEYS = /^ℹ (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) /;

/** Справочные строки теста (`t.diagnostic`): всё, что раннер печатает с `ℹ`, кроме итоговой сводки (до 12 строк). */
export function diagnostics_of(out) {
  return out.split('\n').filter((l) => l.startsWith('ℹ ') && !SUMMARY_KEYS.test(l)).map((l) => l.slice(2).trim()).slice(0, 12);
}

/** Названия упавших тестов (строки `✖ …` до блока «failing tests»), до 6. */
export function failures_of(out) {
  const cut = out.indexOf('✖ failing tests');
  const head = cut < 0 ? out : out.slice(0, cut);
  return head.split('\n').filter((l) => l.startsWith('✖ ')).map((l) => l.slice(2).trim().slice(0, 160)).slice(0, 6);
}

/**
 * Запустить наборы по одному.
 * @param {{n: number, seeds: number, only?: string[], order?: string[], timeout_ms?: number, deadline_ms?: number, root?: string, log?: (s: string) => void, extra_env?: object}} o
 *   FP-24: `order` — порядок наборов (по умолчанию порядок `SUITES`), `deadline_ms` — абсолютный предел общего времени (мс от эпохи): набору дают остаток, не уложившийся останавливается
 */
export function run_suites(o) {
  const log = o.log ?? (() => {});
  const names = (o.order ?? Object.keys(SUITES)).filter((k) => o.only === undefined || o.only.includes(k));
  const results = [];
  for (const name of names) {
    const s = SUITES[name];
    const volume = s.env === 'GP_SEEDS' ? o.seeds : o.n;
    const left = o.deadline_ms === undefined ? Infinity : o.deadline_ms - Date.now();
    if (left < 1000) { // времени не осталось: набор не запускался
      results.push({ suite: name, file: s.file, env: { [s.env]: volume }, ok: false, exit: null, skipped_by_limit: true });
      log(`НЕТ ${name}: общий предел времени исчерпан до запуска`);
      continue;
    }
    const progress_file = path.join(os.tmpdir(), `runway-fuzz-progress-${process.pid}-${name}.json`);
    fs.rmSync(progress_file, { force: true });
    const env = { ...process.env, ...(o.extra_env ?? {}), [s.env]: String(volume), RUNWAY_FUZZ_PROGRESS: progress_file };
    delete env.NODE_TEST_CONTEXT; // вложенный запуск изнутри теста: дочерний раннер должен писать обычную сводку
    const per_test = Math.min(o.timeout_ms ?? 3_600_000, Math.max(1000, Math.floor(left)));
    const t0 = Date.now();
    // --test-isolation=none: тест идёт в самом процессе раннера, и остановка по пределу времени убивает всё; иначе на Windows дочерний процесс теста остался бы работать после остановки раннера
    const r = spawnSync(process.execPath, ['--test', '--test-isolation=none', '--test-timeout=' + per_test, '--test-concurrency=1', s.file], {
      cwd: o.root ?? PROTO, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: Number.isFinite(left) ? Math.floor(left) : (o.timeout_ms ?? 3_600_000) * 2,
    });
    const out = r.stdout ?? '';
    const sum = parse_summary(out);
    const timed_out = r.error?.code === 'ETIMEDOUT';
    let progress = null;
    try { progress = JSON.parse(fs.readFileSync(progress_file, 'utf8')); } catch { progress = null; }
    fs.rmSync(progress_file, { force: true });
    const res = { suite: name, file: s.file, env: { [s.env]: Number(env[s.env]) }, ok: r.status === 0 && !timed_out, exit: r.status, ...sum, elapsed_ms: Date.now() - t0 };
    if (timed_out) res.timed_out = true;
    if (progress !== null) res.progress = progress;
    const diag = diagnostics_of(out);
    if (diag.length > 0) res.diagnostics = diag;
    if (!res.ok && !timed_out) res.failures = failures_of(out);
    results.push(res);
    log(`${res.ok ? 'ok ' : 'НЕТ'} ${name}: ${s.env}=${env[s.env]} — тестов ${sum.tests}, прошло ${sum.pass}, упало ${sum.fail}, пропущено ${sum.skipped}, ${res.elapsed_ms} мс${timed_out ? ' (ОСТАНОВЛЕН ПО ПРЕДЕЛУ ВРЕМЕНИ)' : ''}`);
  }
  return results;
}

/**
 * Раздел `full` файла результата: честная сводка полного прогона. `complete` — все три набора завершились сами и зелёные; `exceptions` — число упавших тестов
 * (тест фаззинга падает на первом необработанном исключении, поэтому 0 — «исключений нет»); `journals` — сколько циклов реально выполнено (по файлам хода и концу циклов).
 */
export function full_summary({ date, results, n, seeds, limit_min, elapsed_ms, free_ram_mb, platform, node }) {
  const done = {};
  for (const r of results) for (const [label, v] of Object.entries(r.progress ?? {})) done[label] = { done: v.done, of: v.of, finished: v.done === v.of };
  const complete = results.length === Object.keys(SUITES).length && results.every((r) => r.ok && r.timed_out !== true && r.skipped_by_limit !== true);
  const exceptions = results.reduce((a, r) => a + (Number.isFinite(r.fail) ? r.fail : 0), 0);
  const stopped = results.filter((r) => r.timed_out === true || r.skipped_by_limit === true).map((r) => r.suite);
  return {
    date, node, platform, mode: 'full', fuzz_n: n, gp_seeds: seeds, limit_min, complete, ok: complete, exceptions, elapsed_ms, free_ram_mb_before: free_ram_mb,
    stopped_by_limit: stopped, loops: done, results,
    note: complete
      ? `Полный прогон выполнен целиком за ${Math.round(elapsed_ms / 1000)} с: FUZZ_N = ${n}, GP_SEEDS = ${seeds}; необработанных исключений ${exceptions}. Поле loops — сколько шагов выполнил каждый цикл.`
      : `Полный прогон НЕ завершён${stopped.length > 0 ? ' (остановлены или не запущены по пределу ' + limit_min + ' мин: ' + stopped.join(', ') + ')' : ''}; необработанных исключений в завершённых наборах ${exceptions}. Поле loops — сколько шагов цикл успел выполнить.`,
  };
}

function read_json(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const NOT_RUN = 'Полный прогон на этой машине не запускался.';
const SEE_FULL = 'Результат полного прогона — в разделе full.';

function arg_of(argv, name, def) { const i = argv.indexOf(name); return i < 0 ? def : argv[i + 1]; }

function main(argv) {
  const date = arg_of(argv, '--date', null);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) { console.error('нужен аргумент --date ГГГГ-ММ-ДД (календарь инструмент не читает)'); return 2; }
  const full = argv.includes('--full');
  const base = full ? FULL : SHORT;
  const n = Number(arg_of(argv, '--n', process.env.FUZZ_N ?? base.n));
  const seeds = Number(arg_of(argv, '--seeds', process.env.GP_SEEDS ?? base.seeds));
  if (!Number.isSafeInteger(n) || n < 1 || !Number.isSafeInteger(seeds) || seeds < 1) { console.error('--n и --seeds — положительные целые'); return 2; }
  const only = arg_of(argv, '--only', null)?.split(',');
  if (only !== undefined && only.some((x) => !(x in SUITES))) { console.error('неизвестный набор; доступны: ' + Object.keys(SUITES).join(', ')); return 2; }
  const limit_arg = arg_of(argv, '--limit-min', null);
  const limit_min = limit_arg === null ? (full ? FULL_LIMIT_MIN : null) : Number(limit_arg);
  if (limit_min !== null && !(limit_min > 0)) { console.error('--limit-min — положительное число минут'); return 2; }
  const root = path.resolve(arg_of(argv, '--root', PROTO)); // каталог с tests/ (по умолчанию prototype/; в тестах инструмента — временный проект с заглушками)
  const free_ram_mb = Math.round(os.freemem() / 2 ** 20);
  console.log(`ночной фаззинг (${full ? 'полный' : 'короткий'} режим) на ${date}: FUZZ_N = ${n}, GP_SEEDS = ${seeds}${limit_min === null ? '' : ', предел ' + limit_min + ' мин'}; Node ${process.version}, свободно ОЗУ ${free_ram_mb} МБ`);
  const t0 = Date.now();
  const results = run_suites({ n, seeds, only, root, order: full ? FULL_ORDER : undefined, deadline_ms: limit_min === null ? undefined : t0 + limit_min * 60000, log: (s) => console.log(s) });
  const elapsed_ms = Date.now() - t0;
  const out = path.resolve(arg_of(argv, '--out', path.join(PROTO, '..', '_ops', 'fuzz-nightly.json')));
  const write = !argv.includes('--no-write') && only === undefined;
  let ok;
  if (full) {
    const sum = full_summary({ date, results, n, seeds, limit_min, elapsed_ms, free_ram_mb, platform: os.platform() + ' ' + os.arch(), node: process.version });
    ok = sum.ok;
    console.log(sum.note);
    if (write) {
      const doc = read_json(out) ?? {};
      doc.full = sum;
      if (typeof doc.note === 'string') doc.note = doc.note.replace(NOT_RUN, SEE_FULL);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n', 'utf8');
      console.log('записано: ' + out + ' (раздел full)');
    }
  } else {
    ok = results.every((r) => r.ok);
    if (write) {
      const prev = read_json(out);
      const doc = {
        format: 'runway-fuzz/1', date, node: process.version, platform: os.platform() + ' ' + os.arch(), mode: 'short', fuzz_n: n, gp_seeds: seeds, ok, results,
        note: 'Короткий прогон проверяет, что ночной режим работает; целевые объёмы — FUZZ_N = 100000 и GP_SEEDS = 1500 (--full). ' + (prev?.full === undefined ? NOT_RUN : SEE_FULL),
      };
      if (prev?.full !== undefined) doc.full = prev.full; // результат полного прогона не теряется при перезаписи короткого
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n', 'utf8');
      console.log('записано: ' + out);
    }
  }
  console.log(ok ? 'всё зелёное' : 'есть упавшие или не завершённые наборы');
  return ok ? 0 : 1;
}

const is_main = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (is_main) process.exitCode = main(process.argv.slice(2));
