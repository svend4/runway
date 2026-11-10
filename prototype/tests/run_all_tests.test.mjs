// run_all_tests.test.mjs — FP-24: tools/run_all_tests.mjs (сквозной прогон по одному файлу, сводка JSON и текст, --resume, таймаут на файл, профили --fast и --nightly).
// Проверяется сам механизм на временном проекте из нескольких крошечных тестов (зелёный, красный, вложенный, зависающий); реальные тесты проекта здесь не запускаются.
// Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const TOOL = path.join(PROTO, 'tools', 'run_all_tests.mjs');
const RA = await import(pathToFileURL(TOOL).href);

const GREEN = "import test from 'node:test';\ntest('зелёный', () => {});\ntest('ещё один', () => {});\n";
const RED = "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('красный', () => { assert.equal(1, 2); });\n";
const SLOW = "import test from 'node:test';\ntest('долгий', async () => { await new Promise((r) => setTimeout(r, 20000)); });\n";

function make_root() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-runall-'));
  fs.mkdirSync(path.join(root, 'tests', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tests', 'a.test.mjs'), GREEN);
  fs.writeFileSync(path.join(root, 'tests', 'b.test.mjs'), RED);
  fs.writeFileSync(path.join(root, 'tests', 'sub', 'c.test.mjs'), GREEN);
  fs.writeFileSync(path.join(root, 'tests', 'helper.mjs'), '// не тест\n');
  return root;
}
const cli = (args) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env });
};

test('FP-24 run_all_tests: discover находит только *.test.mjs (рекурсивно, по алфавиту); parse_summary читает сводку раннера; is_red различает зелёное, красное, таймаут и отсутствие сводки', () => {
  const root = make_root();
  try {
    assert.deepEqual(RA.discover(root), ['tests/a.test.mjs', 'tests/b.test.mjs', 'tests/sub/c.test.mjs']);
    assert.deepEqual(RA.discover(path.join(root, 'нет-такого')), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  const sum = RA.parse_summary('ℹ tests 12\nℹ suites 0\nℹ pass 10\nℹ fail 1\nℹ cancelled 0\nℹ skipped 1\nℹ todo 2\nℹ duration_ms 99\n');
  assert.deepEqual(sum, { tests: 12, pass: 10, fail: 1, skipped: 1, todo: 2, cancelled: 0 });
  assert.deepEqual(RA.parse_summary('мусор'), { tests: null, pass: null, fail: null, skipped: null, todo: null, cancelled: null });
  const ok = { tests: 2, pass: 2, fail: 0, cancelled: 0, status: 0, timed_out: false };
  assert.equal(RA.is_red(ok), false);
  assert.equal(RA.is_red({ ...ok, fail: 1, status: 1 }), true);
  assert.equal(RA.is_red({ ...ok, timed_out: true }), true);
  assert.equal(RA.is_red({ ...ok, tests: null, fail: null }), true, 'нет сводки — красный');
  assert.equal(RA.is_red({ ...ok, cancelled: 1 }), true);
  assert.deepEqual(RA.failure_tail('a\n✖ упал\nb\nAssertionError x', 5), ['✖ упал', 'AssertionError x']);
});

test('FP-24 run_all_tests: файлы идут по одному в отдельных процессах; красный файл виден с причиной, зелёные — с числами; вложенный каталог запускается', () => {
  const root = make_root();
  try {
    const calls = [];
    const { rows } = RA.run_all({ root, files: RA.discover(root), timeout_s: 60, run: (r, f, o) => { calls.push(f); return RA.run_file(r, f, o); } });
    assert.deepEqual(calls, ['tests/a.test.mjs', 'tests/b.test.mjs', 'tests/sub/c.test.mjs']);
    const by = Object.fromEntries(rows.map((r) => [r.file, r]));
    assert.deepEqual([by['tests/a.test.mjs'].tests, by['tests/a.test.mjs'].pass, by['tests/a.test.mjs'].fail], [2, 2, 0]);
    assert.equal(RA.is_red(by['tests/a.test.mjs']), false);
    assert.equal(RA.is_red(by['tests/b.test.mjs']), true);
    assert.equal(by['tests/b.test.mjs'].fail, 1);
    assert.ok(by['tests/b.test.mjs'].tail.length > 0, 'у красного файла есть причина');
    assert.equal(RA.is_red(by['tests/sub/c.test.mjs']), false);
    const text = RA.summary_text(rows, { profile: 'all', of: 3, finished: true, started_ms: 0, now_ms: 5000 });
    assert.match(text.split('\n')[0], /3 из 3 файлов по одному: тестов 5, прошло 4, упало 1, пропущено 0, todo 0; красных файлов 1; время 5 с/);
    assert.match(text, /КРАСНЫЙ tests\/b\.test\.mjs/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('FP-24 run_all_tests: таймаут на файл — зависший процесс останавливается, файл помечен timed_out и красный, остальные файлы идут дальше', () => {
  const root = make_root();
  try {
    fs.writeFileSync(path.join(root, 'tests', 'slow.test.mjs'), SLOW);
    const t0 = Date.now();
    const row = RA.run_file(root, 'tests/slow.test.mjs', { timeout_s: 1 });
    assert.equal(RA.is_red(row), true);
    assert.ok(row.timed_out === true || row.fail > 0 || row.cancelled > 0, JSON.stringify(row));
    assert.ok(Date.now() - t0 < 15000, 'ждали не до конца 20-секундного теста');
    // остальные файлы идут дальше: зависший файл подставлен готовой строкой, чтобы не ждать второй раз
    const { rows } = RA.run_all({ root, files: ['tests/slow.test.mjs', 'tests/a.test.mjs'], timeout_s: 1, run: (r, f, o) => (f === 'tests/slow.test.mjs' ? row : RA.run_file(r, f, o)) });
    assert.deepEqual(rows.map((r) => RA.is_red(r)), [true, false]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('FP-24 run_all_tests: --single-process (--test-isolation=none) — результат тот же, а остановка по таймауту убивает весь тест: сердцебиение зависшего теста прекращается', async () => {
  const root = make_root();
  try {
    const beat = path.join(root, 'beat.txt');
    fs.writeFileSync(path.join(root, 'tests', 'beat.test.mjs'), `import test from 'node:test';\nimport fs from 'node:fs';\ntest('сердце', async () => { setInterval(() => fs.appendFileSync(${JSON.stringify(beat)}, 'x'), 100); await new Promise((r) => setTimeout(r, 60000)); });\n`);
    const green = RA.run_file(root, 'tests/a.test.mjs', { timeout_s: 60, single: true });
    assert.deepEqual([green.tests, green.pass, green.fail, RA.is_red(green)], [2, 2, 0, false]);
    const red = RA.run_file(root, 'tests/b.test.mjs', { timeout_s: 60, single: true });
    assert.deepEqual([red.tests, red.fail, RA.is_red(red)], [1, 1, true]);
    const row = RA.run_file(root, 'tests/beat.test.mjs', { timeout_s: 1, single: true, grace_ms: 300 });
    assert.equal(RA.is_red(row), true);
    assert.ok(fs.existsSync(beat), 'тест успел начать');
    const size = fs.statSync(beat).size;
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(fs.statSync(beat).size, size, 'после остановки по таймауту процесса-сироты нет: сердцебиение не растёт');
    // ключ командной строки принимается
    const cli_run = cli(['--root', root, '--only', 'a.test', '--no-write', '--single-process', '--timeout', '60']);
    assert.equal(cli_run.status, 0, cli_run.stdout + cli_run.stderr);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('FP-24 run_all_tests: --resume продолжает прерванный прогон — записанные файлы не запускаются заново; --rerun-failed повторяет красные; запись после каждого файла', () => {
  const root = make_root();
  try {
    const files = RA.discover(root);
    const calls = [];
    const run = (r, f, o) => { calls.push(f); return RA.run_file(r, f, o); };
    const writes = [];
    const first = RA.run_all({ root, files: files.slice(0, 2), timeout_s: 60, run, write: (rows, fin) => writes.push([rows.length, fin]) });
    assert.deepEqual(writes, [[1, false], [2, false]], 'сводка пишется после каждого файла (обрыв не теряет сделанное)');
    calls.length = 0;
    const second = RA.run_all({ root, files, resume_rows: first.rows, timeout_s: 60, run });
    assert.deepEqual(calls, ['tests/sub/c.test.mjs'], 'a и b уже записаны');
    assert.equal(second.rows.length, 3);
    assert.equal(second.skipped_resume, 2);
    calls.length = 0;
    RA.run_all({ root, files, resume_rows: second.rows, rerun_failed: true, timeout_s: 60, run });
    assert.deepEqual(calls, ['tests/b.test.mjs'], 'повторяется только красный');
    calls.length = 0;
    const narrowed = RA.run_all({ root, files: ['tests/a.test.mjs'], resume_rows: second.rows, timeout_s: 60, run });
    assert.deepEqual([calls.length, narrowed.rows.map((r) => r.file)], [0, ['tests/a.test.mjs']], 'лишние строки прежнего прогона отбрасываются');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('FP-24 run_all_tests: командная строка — JSON и текст пишутся, код выхода 1 при красном файле, --resume дописывает, неверные ключи — код 2', () => {
  const root = make_root();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-runall-out-'));
  try {
    const json = path.join(out, 'r.json');
    const txt = path.join(out, 'r.txt');
    const part = cli(['--root', root, '--only', 'a.test,b.test', '--out-json', json, '--out-txt', txt, '--timeout', '60']);
    assert.equal(part.status, 1, part.stdout + part.stderr);
    let doc = JSON.parse(fs.readFileSync(json, 'utf8'));
    assert.deepEqual([doc.done, doc.finished, doc.profile], [2, true, 'all']);
    assert.match(fs.readFileSync(txt, 'utf8'), /КРАСНЫЙ tests\/b\.test\.mjs/);
    // продолжение без --only: a и b уже записаны, дописывается только c
    const rest = cli(['--root', root, '--resume', '--out-json', json, '--out-txt', txt, '--timeout', '60']);
    assert.equal(rest.status, 1);
    assert.match(rest.stdout, /продолжение: уже есть 2/);
    doc = JSON.parse(fs.readFileSync(json, 'utf8'));
    assert.deepEqual(doc.rows.map((r) => r.file), ['tests/a.test.mjs', 'tests/b.test.mjs', 'tests/sub/c.test.mjs']);
    // только зелёное — код 0
    const green = cli(['--root', root, '--only', 'a.test', '--no-write', '--timeout', '60']);
    assert.equal(green.status, 0, green.stdout + green.stderr);
    assert.deepEqual([cli(['--root', root, '--timeout', 'x']).status, cli(['--root', root, '--fast', '--nightly']).status, cli(['--root', root, '--only', 'нет-такого']).status], [2, 2, 2]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true }); }
});

test('FP-24 run_all_tests: --fast не запускает тяжёлые файлы (все они существуют), --list показывает профиль, --nightly поднимает объёмы фаззинга, но не меняет N property-тестов (1000)', () => {
  const all = RA.discover(PROTO);
  for (const f of RA.HEAVY_FILES) assert.ok(all.includes(f) || f === 'tests/mutate_engine.test.mjs', 'тяжёлый файл существует: ' + f);
  const fast = cli(['--fast', '--list']);
  assert.equal(fast.status, 0);
  const listed = fast.stdout.trim().split('\n').map((l) => l.split('\t')[0]);
  for (const f of RA.HEAVY_FILES) assert.ok(!listed.includes(f), 'в --fast нет ' + f);
  assert.ok(listed.length > 100 && listed.includes('tests/arith.test.mjs') && listed.includes('tests/g001.golden.test.mjs'), 'ядро в быстром профиле остаётся');
  const full = cli(['--list']).stdout.trim().split('\n').map((l) => l.split('\t')[0]);
  assert.ok(full.includes('tests/properties.test.mjs') && full.includes('tests/engine_lock.test.mjs'));
  assert.ok(full.length > listed.length);
  assert.equal(RA.NIGHTLY_ENV.PROP_N, undefined, 'N property-тестов в ночном профиле прежнее: 1000 — это норма, а не повышенный объём');
  assert.ok(Number(RA.NIGHTLY_ENV.FUZZ_N) > 2000 && Number(RA.NIGHTLY_ENV.GP_SEEDS) > 200);
  const pkg = JSON.parse(fs.readFileSync(path.join(PROTO, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['test:fast'], /run_all_tests\.mjs --fast/);
  assert.match(pkg.scripts['test:nightly'], /run_all_tests\.mjs --nightly/);
  assert.equal(pkg.scripts.test, 'node --test', 'прежний скрипт test не менялся');
});

test('FP-24 run_all_tests: файлы медленнее 7 с, названные независимой проверкой 2026-10-28 (fp48_adv, journal_log, import_worker_model, run_all_tests, import_worker, bench_pages, fuzz_nightly, import_main_thread, fp24_adv), входят в HEAVY_FILES и не попадают в --fast; в списке нет повторов', () => {
  const named = ['tests/fp48_adv.test.mjs', 'tests/journal_log.test.mjs', 'tests/import_worker_model.test.mjs', 'tests/run_all_tests.test.mjs', 'tests/import_worker.test.mjs',
    'tests/bench_pages.test.mjs', 'tests/fuzz_nightly.test.mjs', 'tests/import_main_thread.test.mjs', 'tests/fp24_adv.test.mjs',
    'tests/reserve_screen.test.mjs', 'tests/check_script.test.mjs']; // последние два — по повторному замеру 2026-10-28 (11,1 и 7,4 с)
  assert.equal(new Set(RA.HEAVY_FILES).size, RA.HEAVY_FILES.length, 'в HEAVY_FILES нет повторов');
  const listed = cli(['--fast', '--list']).stdout.trim().split('\n').map((l) => l.split('\t')[0]);
  for (const f of named) {
    assert.ok(fs.existsSync(path.join(PROTO, f)), 'файл существует: ' + f);
    assert.ok(RA.HEAVY_FILES.includes(f), 'в HEAVY_FILES: ' + f);
    assert.ok(!listed.includes(f), 'в --fast нет ' + f);
  }
  assert.ok(listed.length > 100, 'быстрый профиль остаётся широким: ' + listed.length);
});
