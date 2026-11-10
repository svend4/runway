// tst_coverage.mjs — пересчёт `_ops/tst-coverage.json` по сквозному прогону (FP-51, исправление по проверке 2026-11-09:
// прежний пересчёт был выполнен скриптом вне проекта; теперь правило записано здесь и воспроизводимо).
// Что считается:
//   files   — файлы тестов из строк `tests/…` отчёта прогона (`--report`, по умолчанию _ops/impl/run/verify-wave3a5.txt);
//             файлы на диске, которых не было в прогоне (например, файл проверяющего fp51_adv.test.mjs), не считаются
//             и перечисляются в выводе отдельно;
//   tests   — число вызовов `test(` в этих файлах: `test(`, перед которым нет точки, буквы, цифры, `_` или `$`
//             (методы `t.test(…)`, `test.skip(…)` не считаются; комментарии и строки считаются, как и раньше);
//   covered — число упоминаний `TST-NN` в этих файлах для реестра NN = 01…60 (идентификаторы вне реестра, например
//             `TST-99` в фикстурах, не считаются); `missing` — номера реестра без упоминаний.
// Запуск из каталога prototype/ (один процесс node за раз; без зависимостей):
//   node tools/tst_coverage.mjs [--report ../_ops/impl/run/verify-wave3a5.txt] [--out ../_ops/tst-coverage.json] [--check]
// --check: пересчитать и сравнить с --out (файл не пишется); код выхода 1 при расхождении.
// Расчёт по введённым данным и правилам, не консультация.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const RUNWAY = path.join(PROTO, '..');
/** Реестр идентификаторов TST-01…TST-60 (wiki/product/11-testing-strategy.md, раздел «Статус TST»). */
const REGISTRY_MAX = 60;
const TEST_CALL = /(?<![.\w$])test\(/g;
const TST_ID = /TST-(\d{2})(?!\d)/g;

/** Файлы тестов из строк отчёта: первый столбец строк `tests/…` (относительно prototype/). */
export function files_from_report(text) {
  return text.split('\n').filter((l) => l.startsWith('tests/')).map((l) => l.split('\t')[0].trim());
}

/** Число вызовов `test(` (правило — в шапке файла). */
export function count_test_calls(text) {
  return (text.match(TEST_CALL) ?? []).length;
}

/** Добавляет упоминания идентификаторов реестра в карту «номер → число». */
export function count_registry_ids(text, into) {
  for (const m of text.matchAll(TST_ID)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= REGISTRY_MAX) {
      const key = m[1];
      into.set(key, (into.get(key) ?? 0) + 1);
    }
  }
  return into;
}

/** Все `*.test.mjs` под `tests/` (включая `tests/adversarial/`), пути относительно prototype/. */
function walk_test_files(dir, rel = 'tests') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel + '/' + e.name;
    if (e.isDirectory()) out.push(...walk_test_files(path.join(dir, e.name), r));
    else if (e.isFile() && e.name.endsWith('.test.mjs')) out.push(r);
  }
  return out.sort();
}

/** Пересчёт по списку файлов (файлы читаются с диска относительно prototype/). */
export function compute_coverage(files, read) {
  let tests = 0;
  const ids = new Map();
  for (const f of files) {
    const text = read(f);
    tests += count_test_calls(text);
    count_registry_ids(text, ids);
  }
  const covered = {};
  for (let i = 1; i <= REGISTRY_MAX; i++) {
    const key = String(i).padStart(2, '0');
    covered[key] = ids.get(key) ?? 0;
  }
  const missing = Object.keys(covered).filter((k) => covered[k] === 0);
  return { files: files.length, tests, covered, missing };
}

function arg_of(argv, name, def) {
  const i = argv.indexOf(name);
  return i < 0 ? def : argv[i + 1];
}

function main(argv) {
  const report_path = path.resolve(arg_of(argv, '--report', path.join(RUNWAY, '_ops', 'impl', 'run', 'verify-wave3a5.txt')));
  const out_path = path.resolve(arg_of(argv, '--out', path.join(RUNWAY, '_ops', 'tst-coverage.json')));
  const check = argv.includes('--check');
  const listed = files_from_report(fs.readFileSync(report_path, 'utf8').replace(/\r/g, ''));
  const gone = listed.filter((f) => !fs.existsSync(path.join(PROTO, f)));
  if (gone.length > 0) {
    process.stderr.write('нет на диске файлов из отчёта: ' + gone.join(', ') + '\n');
    return 2;
  }
  const doc = compute_coverage(listed, (f) => fs.readFileSync(path.join(PROTO, f), 'utf8'));
  const outside = walk_test_files(path.join(PROTO, 'tests')).filter((f) => !listed.includes(f));
  const report_rel = path.relative(RUNWAY, report_path).split(path.sep).join('/');
  const full = {
    files: doc.files,
    tests: doc.tests,
    covered: doc.covered,
    missing: doc.missing,
    report: report_rel,
    rule: 'files — строки tests/ отчёта; tests — test( не после точки/буквы/цифры/_/$; covered — TST-01…60 по упоминаниям в этих файлах',
  };
  process.stdout.write(`файлов ${doc.files}, вызовов test( ${doc.tests}, идентификаторов реестра с упоминаниями ${Object.keys(doc.covered).length - doc.missing.length} из ${REGISTRY_MAX}, missing ${doc.missing.length}\n`);
  if (outside.length > 0) process.stdout.write('вне отчёта, не учтены: ' + outside.join(', ') + '\n');
  if (check) {
    const old = JSON.parse(fs.readFileSync(out_path, 'utf8'));
    const same = JSON.stringify([old.files, old.tests, old.covered, old.missing]) === JSON.stringify([full.files, full.tests, full.covered, full.missing]);
    process.stdout.write(same ? 'совпадает с ' + path.relative(RUNWAY, out_path).split(path.sep).join('/') + '\n' : 'РАСХОЖДЕНИЕ с ' + path.relative(RUNWAY, out_path).split(path.sep).join('/') + '\n');
    return same ? 0 : 1;
  }
  fs.writeFileSync(out_path, JSON.stringify(full, null, 1) + '\n', 'utf8');
  process.stdout.write('записано: ' + path.relative(RUNWAY, out_path).split(path.sep).join('/') + '\n');
  return 0;
}

const is_main = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (is_main) process.exitCode = main(process.argv.slice(2));
