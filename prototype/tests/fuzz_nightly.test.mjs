// fuzz_nightly.test.mjs — FP-24, REQ-158: новые возможности tools/fuzz_nightly.mjs — общий предел времени полного прогона (--limit-min), честная запись остановленного прогона, ход длинных
// циклов (tests/fuzz_progress.mjs), раздел `full` файла результата, порядок наборов. Проверяется механизм на временном проекте из заглушек; настоящий полный фаззинг (10^5) здесь НЕ запускается.
// Прежние проверки инструмента — tests/quality_tools.test.mjs. Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const TOOL = path.join(PROTO, 'tools', 'fuzz_nightly.mjs');
const FZ = await import(pathToFileURL(TOOL).href);
const PROGRESS_URL = pathToFileURL(path.join(HERE, 'fuzz_progress.mjs')).href;
const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), 'runway-fzn-' + label + '-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const cli = (args) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env });
};

const OK_STUB = "import test from 'node:test'; test('ok', () => {});\n";
const LOOP_STUB = `import test from 'node:test';\nimport { fuzz_progress } from '${PROGRESS_URL}';\ntest('цикл', (t) => { for (let i = 1; i <= 7; i++) fuzz_progress('stub:loop', i, 7); t.diagnostic('прогнано 7 шагов'); });\n`;
const SLOW_STUB = `import test from 'node:test';\nimport { fuzz_progress } from '${PROGRESS_URL}';\ntest('долгий', async () => { fuzz_progress('stub:slow', 3, 10); await new Promise((r) => setTimeout(r, 60000)); });\n`;
function stub_root(over = {}) {
  const root = tmp('root');
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  for (const [name, s] of Object.entries(FZ.SUITES)) {
    fs.mkdirSync(path.dirname(path.join(root, s.file)), { recursive: true });
    fs.writeFileSync(path.join(root, s.file), over[name] ?? OK_STUB);
  }
  return root;
}

test('FP-24 fuzz_nightly: полный режим — 10^5 и 1500, предел 60 минут, самый долгий набор (validate_ws) идёт последним; короткий — как прежде', () => {
  assert.deepEqual([FZ.FULL.n, FZ.FULL.seeds, FZ.SHORT.n, FZ.SHORT.seeds, FZ.FULL_LIMIT_MIN], [100000, 1500, 2000, 200, 60]);
  assert.deepEqual([...FZ.FULL_ORDER], ['hardening', 'golden', 'validate_ws']);
  assert.deepEqual([...FZ.FULL_ORDER].sort(), Object.keys(FZ.SUITES).sort(), 'порядок содержит все наборы ровно по разу');
  assert.deepEqual(Object.keys(FZ.SUITES), ['hardening', 'validate_ws', 'golden'], 'прежний порядок и состав SUITES не менялись');
});

test('FP-24 fuzz_nightly: справочные строки теста и названия упавших разбираются из вывода раннера', () => {
  const out = 'ℹ REQ-158: прогнано 100000 повреждённых рабочих областей; {"valid":1}\n✔ тест\n✖ упавший тест (3ms)\nℹ tests 2\nℹ suites 0\nℹ pass 1\nℹ fail 1\nℹ duration_ms 99\n\n✖ failing tests:\n✖ упавший тест (3ms)\n';
  assert.deepEqual(FZ.diagnostics_of(out), ['REQ-158: прогнано 100000 повреждённых рабочих областей; {"valid":1}']);
  assert.deepEqual(FZ.failures_of(out), ['упавший тест (3ms)']);
  assert.deepEqual(FZ.diagnostics_of('ℹ tests 1\nℹ pass 1\n'), []);
});

test('FP-24 fuzz_nightly: full_summary — завершённый прогон complete = true и 0 исключений; остановленный по пределу — complete = false, остановленные названы, ход циклов сохранён', () => {
  const row = (suite, over = {}) => ({ suite, ok: true, exit: 0, tests: 3, pass: 3, fail: 0, ...over });
  const done = FZ.full_summary({ date: '2026-10-27', results: [row('hardening', { progress: { 'hardening:inputs': { done: 100, of: 100 } } }), row('golden', { progress: { 'golden:areas': { done: 1500, of: 1500 } } }), row('validate_ws', { progress: { 'validate_ws:workspaces': { done: 100000, of: 100000 } } })], n: 100000, seeds: 1500, limit_min: 60, elapsed_ms: 1500000, free_ram_mb: 900, platform: 'win32 x64', node: 'v24' });
  assert.deepEqual([done.complete, done.ok, done.exceptions, done.mode, done.stopped_by_limit], [true, true, 0, 'full', []]);
  assert.deepEqual(done.loops['validate_ws:workspaces'], { done: 100000, of: 100000, finished: true });
  assert.match(done.note, /выполнен целиком за 1500 с/);
  const cut = FZ.full_summary({ date: '2026-10-27', results: [row('hardening'), row('golden'), row('validate_ws', { ok: false, exit: null, tests: null, pass: null, fail: null, timed_out: true, progress: { 'validate_ws:workspaces': { done: 43000, of: 100000 } } })], n: 100000, seeds: 1500, limit_min: 60, elapsed_ms: 3600000, free_ram_mb: 900, platform: 'win32 x64', node: 'v24' });
  assert.deepEqual([cut.complete, cut.ok, cut.exceptions, cut.stopped_by_limit], [false, false, 0, ['validate_ws']]);
  assert.deepEqual(cut.loops['validate_ws:workspaces'], { done: 43000, of: 100000, finished: false });
  assert.match(cut.note, /НЕ завершён/);
  assert.match(cut.note, /validate_ws/);
  const red = FZ.full_summary({ date: '2026-10-27', results: [row('hardening', { ok: false, exit: 1, fail: 2, pass: 1 }), row('golden'), row('validate_ws')], n: 1, seeds: 1, limit_min: 60, elapsed_ms: 1000, free_ram_mb: 1, platform: 'x', node: 'y' });
  assert.deepEqual([red.complete, red.exceptions], [false, 2], 'упавшие тесты считаются исключениями');
  const partial = FZ.full_summary({ date: '2026-10-27', results: [row('hardening')], n: 1, seeds: 1, limit_min: 60, elapsed_ms: 1, free_ram_mb: 1, platform: 'x', node: 'y' });
  assert.equal(partial.complete, false, 'не все три набора — не полный прогон');
});

test('FP-24 fuzz_nightly: run_suites — порядок наборов задаётся, ход цикла и справочные строки попадают в результат, объём передаётся набору', () => {
  const root = stub_root({ golden: LOOP_STUB });
  try {
    const rs = FZ.run_suites({ n: 5, seeds: 6, root, order: FZ.FULL_ORDER });
    assert.deepEqual(rs.map((r) => r.suite), ['hardening', 'golden', 'validate_ws']);
    assert.ok(rs.every((r) => r.ok && r.elapsed_ms >= 0));
    const g = rs.find((r) => r.suite === 'golden');
    assert.deepEqual(g.progress, { 'stub:loop': { done: 7, of: 7 } }, 'файл хода: последнее значение цикла');
    assert.deepEqual(g.diagnostics, ['прогнано 7 шагов']);
    assert.deepEqual(g.env, { GP_SEEDS: 6 });
    assert.equal(rs.find((r) => r.suite === 'hardening').progress, undefined, 'без записи хода поля нет');
    assert.equal(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('runway-fuzz-progress-' + process.pid)).length, 0, 'файлы хода удалены');
  } finally { rm(root); }
});

test('FP-24 fuzz_nightly: общий предел времени — остаток времени не позволяет запуск (набор не запускался), долгий набор останавливается с timed_out и сохранённым ходом, прогон идёт дальше', () => {
  const root = stub_root({ hardening: SLOW_STUB });
  try {
    const t0 = Date.now();
    const rs = FZ.run_suites({ n: 1, seeds: 1, root, order: ['hardening', 'golden'], deadline_ms: Date.now() + 2500 });
    const h = rs[0];
    assert.deepEqual([h.suite, h.ok, h.timed_out, h.exit], ['hardening', false, true, null]);
    assert.deepEqual(h.progress, { 'stub:slow': { done: 3, of: 10 } }, 'ход остановленного набора сохранён: прогнано 3 из 10');
    assert.ok(Date.now() - t0 < 20000, 'остановили по пределу, а не дождались 60 с');
    assert.deepEqual([rs[1].suite, rs[1].ok, rs[1].skipped_by_limit], ['golden', false, true], 'после предела следующий набор не запускается');
    // предел уже исчерпан до начала
    const none = FZ.run_suites({ n: 1, seeds: 1, root, deadline_ms: Date.now() - 1000 });
    assert.ok(none.every((r) => r.skipped_by_limit === true && r.ok === false));
  } finally { rm(root); }
});

test('FP-24 fuzz_nightly: остановка по пределу убивает весь тест (--test-isolation=none): сердцебиение зависшего набора прекращается, процесса-сироты нет', async () => {
  const dir = tmp('beat');
  const beat = path.join(dir, 'beat.txt');
  const root = stub_root({ hardening: `import test from 'node:test';\nimport fs from 'node:fs';\ntest('сердце', async () => { setInterval(() => fs.appendFileSync(${JSON.stringify(beat)}, 'x'), 100); await new Promise((r) => setTimeout(r, 60000)); });\n` });
  try {
    const rs = FZ.run_suites({ n: 1, seeds: 1, root, only: ['hardening'], deadline_ms: Date.now() + 2500 });
    assert.deepEqual([rs[0].ok, rs[0].timed_out], [false, true]);
    assert.ok(fs.existsSync(beat), 'набор успел начать');
    const size = fs.statSync(beat).size;
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(fs.statSync(beat).size, size, 'после остановки сердцебиение не растёт: дочернего процесса теста не осталось');
  } finally { rm(root); rm(dir); }
});

test('FP-24 fuzz_nightly: tests/fuzz_progress.mjs без переменной RUNWAY_FUZZ_PROGRESS ничего не делает и не бросает; с переменной пишет ход всех циклов процесса', () => {
  const dir = tmp('progress');
  try {
    const script = path.join(dir, 'p.mjs');
    fs.writeFileSync(script, `import { fuzz_progress } from '${PROGRESS_URL}';\nfuzz_progress('a', 1, 1000);\nfuzz_progress('a', 2, 1000);\nfuzz_progress('a', 500, 1000);\nfuzz_progress('b', 4, 4);\n`);
    const env = { ...process.env };
    delete env.RUNWAY_FUZZ_PROGRESS;
    const off = spawnSync(process.execPath, [script], { encoding: 'utf8', env });
    assert.equal(off.status, 0, off.stderr);
    assert.deepEqual(fs.readdirSync(dir), ['p.mjs'], 'без переменной файлов нет');
    const file = path.join(dir, 'progress.json');
    const on = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...env, RUNWAY_FUZZ_PROGRESS: file } });
    assert.equal(on.status, 0, on.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: { done: 500, of: 1000 }, b: { done: 4, of: 4 } }, 'шаг 2 пропущен (чаще раза в of/200 не пишется), 500 и конец цикла — записаны');
    const bad = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...env, RUNWAY_FUZZ_PROGRESS: path.join(dir, 'нет', 'такого', 'p.json') } });
    assert.equal(bad.status, 0, 'сбой записи хода тест не роняет');
  } finally { rm(dir); }
});

test('FP-24 fuzz_nightly: командная строка — полный прогон пишет раздел full и не трогает поля короткого, короткий прогон не теряет full; --limit-min проверяется; без даты — код 2', () => {
  const root = stub_root({ golden: LOOP_STUB });
  const out_dir = tmp('out');
  try {
    const out = path.join(out_dir, 'fuzz.json');
    const short_doc = { format: 'runway-fuzz/1', date: '2026-10-09', mode: 'short', fuzz_n: 2000, gp_seeds: 200, ok: true, results: [{ suite: 'hardening', ok: true }], note: 'Короткий прогон проверяет, что ночной режим работает; целевые объёмы — FUZZ_N = 100000 и GP_SEEDS = 1500 (--full). Полный прогон на этой машине не запускался.' };
    fs.writeFileSync(out, JSON.stringify(short_doc, null, 2) + '\n');
    const full = cli(['--full', '--date', '2026-10-27', '--root', root, '--out', out, '--limit-min', '2']);
    assert.equal(full.status, 0, full.stdout + full.stderr);
    let doc = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.deepEqual([doc.mode, doc.fuzz_n, doc.gp_seeds, doc.date, doc.ok], ['short', 2000, 200, '2026-10-09', true], 'поля короткого прогона прежние');
    assert.deepEqual(doc.results, short_doc.results);
    assert.match(doc.note, /Результат полного прогона — в разделе full/);
    assert.doesNotMatch(doc.note, /не запускался/);
    assert.deepEqual([doc.full.mode, doc.full.date, doc.full.fuzz_n, doc.full.gp_seeds, doc.full.limit_min, doc.full.complete, doc.full.exceptions], ['full', '2026-10-27', 100000, 1500, 2, true, 0]);
    assert.deepEqual(doc.full.results.map((r) => r.suite), ['hardening', 'golden', 'validate_ws'], 'полный прогон идёт в порядке FULL_ORDER');
    assert.deepEqual(doc.full.loops['stub:loop'], { done: 7, of: 7, finished: true });
    // короткий прогон поверх: раздел full сохраняется
    const short = cli(['--date', '2026-10-28', '--n', '5', '--seeds', '5', '--root', root, '--out', out]);
    assert.equal(short.status, 0, short.stdout + short.stderr);
    doc = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.deepEqual([doc.mode, doc.date, doc.fuzz_n], ['short', '2026-10-28', 5]);
    assert.equal(doc.full.date, '2026-10-27', 'результат полного прогона не потерян');
    assert.match(doc.note, /Результат полного прогона — в разделе full/);
    // неверные ключи
    assert.equal(cli(['--full', '--date', '2026-10-27', '--limit-min', '0', '--root', root, '--no-write']).status, 2);
    assert.equal(cli(['--full', '--limit-min', '5']).status, 2, 'без даты');
  } finally { rm(root); rm(out_dir); }
});
