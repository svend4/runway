// quality_tools.test.mjs — FP-12, инструменты качества: tools/mutate.mjs (REQ-175, TST-52), tools/fuzz_nightly.mjs (REQ-171, REQ-174), tools/hledger_oracle.mjs (REQ-173, TST-44).
// Проверяется сам механизм: каталог мутаций согласован с кодом, мутанты применяются только к копии вне проекта и убиваются тестами, результат прогона не устарел; ночной запуск передаёт объём
// наборам и разбирает сводку; оракул hledger печатает команды и ожидаемые остатки, а Docker не запускает. Полный прогон мутаций, полный фаззинг и Docker здесь НЕ выполняются.
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
const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);
const MU = await imp('tools', 'mutate.mjs');
const FZ = await imp('tools', 'fuzz_nightly.mjs');
const HL = await imp('tools', 'hledger_oracle.mjs');
const read = (...p) => fs.readFileSync(path.join(PROTO, ...p), 'utf8');
const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), 'runway-q-' + label + '-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const tool = (name) => path.join(PROTO, 'tools', name);

// ── мутации: каталог ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-175 каталог мутаций: не менее 30, идентификаторы уникальны, фрагмент найден в коде ровно один раз, порча отличается, цели — только money.mjs и dates.mjs; эквивалентные названы с причиной', () => {
  const list = MU.MUTANTS;
  assert.ok(list.length >= 30, 'мутантов: ' + list.length);
  assert.equal(new Set(list.map((m) => m.id)).size, list.length);
  const src = { 'engine/money.mjs': read('engine', 'money.mjs'), 'engine/dates.mjs': read('engine', 'dates.mjs') };
  const kinds = { cmp: 0, sign: 0, round: 0, const: 0 };
  for (const m of list) {
    assert.match(m.id, /^[MD]\d{2}$/);
    assert.ok(m.file in src, m.id + ': цель ' + m.file);
    assert.equal(MU.count_of(src[m.file], m.find), 1, `${m.id}: фрагмент должен встречаться ровно один раз`);
    assert.notEqual(m.find, m.replace, m.id);
    assert.ok(typeof m.what === 'string' && m.what.length > 10, m.id + ': описание');
    assert.doesNotThrow(() => MU.apply_mutant(src[m.file], m), m.id);
    if (/<\s*→|≤|≥|>\s*→/.test(m.what)) kinds.cmp += 1;
    if (/знак|sign|инверт|перевёрнут/i.test(m.what)) kinds.sign += 1;
    if (/half_|ceil|floor|округл|ничь/i.test(m.what)) kinds.round += 1;
    if (/сдвин|константа|на единицу|на день|шаг/i.test(m.what)) kinds.const += 1;
  }
  assert.ok(kinds.cmp >= 10 && kinds.sign >= 5 && kinds.round >= 10 && kinds.const >= 3, JSON.stringify(kinds));
  assert.ok(list.filter((m) => m.file === 'engine/money.mjs').length >= 25 && list.filter((m) => m.file === 'engine/dates.mjs').length >= 20);
  for (const m of list.filter((x) => x.equivalent !== undefined)) assert.ok(m.equivalent.length > 30, m.id + ': причина эквивалентности названа');
  assert.match(MU.catalog_hash(), /^[0-9a-f]{64}$/);
  assert.notEqual(MU.catalog_hash(list.slice(1)), MU.catalog_hash(list));
  // apply_mutant отвергает расхождение каталога с кодом
  assert.throws(() => MU.apply_mutant('нет такого фрагмента', list[0]), /найден 0 раз/);
  assert.throws(() => MU.apply_mutant('aa aa', { id: 'X', find: 'aa', replace: 'bb' }), /найден 2 раз/);
  assert.throws(() => MU.apply_mutant('aa', { id: 'X', find: 'aa', replace: 'aa' }), /равна исходному/);
});

test('REQ-175 каждая порча даёт модуль, который загружается (синтаксис верен): все мутанты money.mjs и dates.mjs импортируются из временного каталога', async () => {
  const root = tmp('load');
  try {
    const src = { 'engine/money.mjs': read('engine', 'money.mjs'), 'engine/dates.mjs': read('engine', 'dates.mjs') };
    let n = 0;
    for (const m of MU.MUTANTS) {
      const dir = path.join(root, m.id, 'engine');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'money.mjs'), m.file === 'engine/money.mjs' ? MU.apply_mutant(src[m.file], m) : src['engine/money.mjs']);
      fs.writeFileSync(path.join(dir, 'dates.mjs'), m.file === 'engine/dates.mjs' ? MU.apply_mutant(src[m.file], m) : src['engine/dates.mjs']);
      const mod = await import(pathToFileURL(path.join(dir, m.file === 'engine/money.mjs' ? 'money.mjs' : 'dates.mjs')).href);
      assert.ok(Object.keys(mod).length > 5, m.id);
      n += 1;
    }
    assert.equal(n, MU.MUTANTS.length);
  } finally { rm(root); }
});

// ── мутации: безопасность запуска и живой прогон ─────────────────────────────────────────────────────────────────────────────

test('REQ-175 рабочий каталог мутаций: внутри prototype/ и непустой чужой каталог отвергаются, свой каталог (с меткой) пересоздаётся; в копии только engine/ и нужные тесты; рабочее дерево не меняется', () => {
  const before = { money: read('engine', 'money.mjs'), dates: read('engine', 'dates.mjs') };
  assert.throws(() => MU.prepare_work_dir(path.join(PROTO, 'tmp-mutate')), /внутри prototype/);
  assert.throws(() => MU.prepare_work_dir(PROTO), /внутри prototype/);
  assert.throws(() => MU.prepare_work_dir(path.dirname(PROTO)), /внутри prototype|содержать/, 'каталог, содержащий проект, тоже нельзя');
  const foreign = tmp('foreign');
  try {
    fs.writeFileSync(path.join(foreign, 'мои-данные.txt'), 'нельзя стирать');
    assert.throws(() => MU.prepare_work_dir(foreign), /не пуст/);
    assert.equal(fs.readFileSync(path.join(foreign, 'мои-данные.txt'), 'utf8'), 'нельзя стирать', 'чужой каталог не тронут');
  } finally { rm(foreign); }
  const mine = path.join(tmp('mine'), 'work');
  try {
    const w = MU.prepare_work_dir(mine);
    assert.ok(fs.existsSync(path.join(w, '.runway-mutate')));
    assert.ok(fs.existsSync(path.join(w, 'engine', 'money.mjs')) && fs.existsSync(path.join(w, 'tests', 'arith.lock.json')) && fs.existsSync(path.join(w, 'package.json')));
    assert.ok(!fs.existsSync(path.join(w, 'demo')) && !fs.existsSync(path.join(w, 'data')), 'демо и данные в копию не идут');
    fs.writeFileSync(path.join(w, 'engine', 'money.mjs'), '// испорчено');
    MU.prepare_work_dir(mine); // свой каталог можно пересоздать
    assert.equal(fs.readFileSync(path.join(mine, 'engine', 'money.mjs'), 'utf8'), before.money);
  } finally { rm(path.dirname(mine)); }
  assert.equal(read('engine', 'money.mjs'), before.money);
  assert.equal(read('engine', 'dates.mjs'), before.dates);
});

test('REQ-175 живой прогон двух мутантов на копии: порча money.mjs и порча dates.mjs убиты своими тестами, неиспорченная копия зелёная, оригинал не тронут; неубитый мутант определяется как survived', () => {
  const work = path.join(tmp('live'), 'work');
  const orig_money = read('engine', 'money.mjs');
  try {
    const mutants = [
      { ...MU.MUTANTS.find((m) => m.id === 'M01'), tests: ['tests/money.test.mjs'] },
      { ...MU.MUTANTS.find((m) => m.id === 'D10'), tests: ['tests/dates.test.mjs'] },
      { id: 'X99', file: 'engine/money.mjs', find: 'export const ERROR_CODES = Object.freeze([', replace: 'export const ERROR_CODES = Object.freeze([ // безвредная правка\n', what: 'безвредная правка (контроль: тесты не краснеют)', tests: ['tests/money.test.mjs'] },
    ];
    const log = [];
    const r = MU.run_mutants({ work_dir: work, mutants, log: (s) => log.push(s) });
    assert.equal(r.aborted, null, JSON.stringify(r));
    assert.ok(r.baseline.every((b) => b.ok && b.tests > 10), 'контроль зелёный');
    assert.deepEqual(r.results.map((x) => [x.id, x.status]), [['M01', 'killed'], ['D10', 'killed'], ['X99', 'survived']]);
    assert.deepEqual(r.results.map((x) => x.killed_by), ['tests/money.test.mjs', 'tests/dates.test.mjs', null]);
    // после прогона копия снова равна исходной (мутант откатывается), а оригинал не менялся
    assert.equal(fs.readFileSync(path.join(work, 'engine', 'money.mjs'), 'utf8'), orig_money);
    assert.equal(read('engine', 'money.mjs'), orig_money);
    // сухой прогон не запускает тесты
    const dry = MU.run_mutants({ work_dir: work, mutants, dry_run: true });
    assert.deepEqual(dry.results.map((x) => x.status), ['applied', 'applied', 'applied']);
    assert.equal(dry.baseline, null);
  } finally { rm(path.dirname(work)); }
});

test('REQ-175 командная строка мутаций: без --work-dir и без --date отказ (код 2); --dry-run применяет все мутации без тестов; рабочее дерево и _ops не меняются', () => {
  const ops_before = fs.existsSync(path.join(PROTO, '..', '_ops', 'mutation.json')) ? fs.readFileSync(path.join(PROTO, '..', '_ops', 'mutation.json'), 'utf8') : null;
  assert.equal(spawnSync(process.execPath, [tool('mutate.mjs'), '--dry-run'], { encoding: 'utf8' }).status, 2);
  const root = tmp('cli');
  try {
    const w = path.join(root, 'work');
    assert.equal(spawnSync(process.execPath, [tool('mutate.mjs'), '--work-dir', w], { encoding: 'utf8' }).status, 2, 'без --date прогон не стартует');
    const dry = spawnSync(process.execPath, [tool('mutate.mjs'), '--work-dir', w, '--dry-run'], { encoding: 'utf8' });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, new RegExp(`мутантов ${MU.MUTANTS.length}:`));
    const bad = spawnSync(process.execPath, [tool('mutate.mjs'), '--work-dir', PROTO, '--dry-run'], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /внутри prototype/);
  } finally { rm(root); }
  assert.equal(fs.existsSync(path.join(PROTO, '..', '_ops', 'mutation.json')) ? fs.readFileSync(path.join(PROTO, '..', '_ops', 'mutation.json'), 'utf8') : null, ops_before);
});

test('REQ-175 результат полного прогона _ops/mutation.json: не устарел (хэш каталога), не менее 30 мутантов убито, неубитые перечислены, эквивалентные названы с причиной, замок арифметики убил большинство денежных мутантов', () => {
  const file = path.join(PROTO, '..', '_ops', 'mutation.json');
  assert.ok(fs.existsSync(file), '_ops/mutation.json нет: node tools/mutate.mjs --work-dir <каталог вне проекта> --date ГГГГ-ММ-ДД');
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(d.format, 'runway-mutation/1');
  assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(d.catalog_hash, MU.catalog_hash(), 'каталог мутаций изменён после прогона: повторите полный прогон');
  assert.equal(d.mutants, MU.MUTANTS.length);
  assert.deepEqual(d.results.map((r) => r.id), MU.MUTANTS.map((m) => m.id));
  const killed = d.results.filter((r) => r.status === 'killed');
  assert.equal(d.killed, killed.length);
  assert.ok(killed.length >= 30, 'убито: ' + killed.length);
  const equiv_ids = MU.MUTANTS.filter((m) => m.equivalent !== undefined).map((m) => m.id);
  assert.deepEqual(d.equivalent.map((e) => e.id), equiv_ids, 'эквивалентные мутанты выжили и названы');
  assert.deepEqual(d.survivors, [], 'неубитых мутантов нет (иначе они перечислены здесь и в задачах): ' + JSON.stringify(d.survivors));
  assert.deepEqual(d.errors, []);
  assert.equal(d.results.filter((r) => r.status === 'survived').length, equiv_ids.length);
  assert.ok(d.lock_killed >= 20, 'замок arith.lock убил мутантов: ' + d.lock_killed);
  assert.ok(d.baseline.every((b) => b.ok));
});

// ── ночной фаззинг ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-171 REQ-174 fuzz_nightly: наборы существуют, объём передаётся через FUZZ_N и GP_SEEDS, сводка раннера разбирается; короткий режим 2000, полный 100000 (не запускался)', () => {
  assert.deepEqual(Object.keys(FZ.SUITES), ['hardening', 'validate_ws', 'golden']);
  for (const s of Object.values(FZ.SUITES)) assert.ok(fs.existsSync(path.join(PROTO, s.file)), s.file);
  assert.deepEqual([FZ.SHORT.n, FZ.SHORT.seeds, FZ.FULL.n, FZ.FULL.seeds], [2000, 200, 100000, 1500]);
  // переменные, которые читают наборы, действительно есть в их исходниках
  assert.match(read('tests', 'hardening.test.mjs'), /process\.env\.FUZZ_N/);
  assert.match(read('tests', 'validate_ws.test.mjs'), /process\.env\.FUZZ_N/);
  assert.match(read('tests', 'adversarial', 'golden_properties.test.mjs'), /process\.env\.GP_SEEDS/);
  const sum = FZ.parse_summary('ℹ tests 12\nℹ suites 0\nℹ pass 10\nℹ fail 1\nℹ cancelled 0\nℹ skipped 1\nℹ todo 0\nℹ duration_ms 1234.56\n');
  assert.deepEqual(sum, { tests: 12, pass: 10, fail: 1, skipped: 1, todo: 0, duration_ms: 1235 });
  assert.ok(Number.isNaN(FZ.parse_summary('мусор').tests));
});

test('REQ-171 fuzz_nightly: run_suites передаёт объём каждому набору (проверено на заглушках-файлах), по одному набору за раз; упавший набор даёт ok = false; CLI без даты и с неизвестным набором — код 2', () => {
  const root = tmp('fuzz');
  try {
    const mk = (file, body) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), body); };
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    mk(FZ.SUITES.hardening.file, "import test from 'node:test'; import assert from 'node:assert/strict'; test('n', () => assert.equal(process.env.FUZZ_N, '123'));");
    mk(FZ.SUITES.validate_ws.file, "import test from 'node:test'; import assert from 'node:assert/strict'; test('n', () => assert.equal(process.env.FUZZ_N, '123'));");
    mk(FZ.SUITES.golden.file, "import test from 'node:test'; import assert from 'node:assert/strict'; test('seeds', () => assert.equal(process.env.GP_SEEDS, '45')); test('второй', () => {});");
    const ok = FZ.run_suites({ n: 123, seeds: 45, root });
    assert.deepEqual(ok.map((r) => [r.suite, r.ok, r.tests, r.fail]), [['hardening', true, 1, 0], ['validate_ws', true, 1, 0], ['golden', true, 2, 0]]);
    assert.deepEqual(ok.map((r) => r.env), [{ FUZZ_N: 123 }, { FUZZ_N: 123 }, { GP_SEEDS: 45 }]);
    const wrong = FZ.run_suites({ n: 124, seeds: 45, root, only: ['hardening'] });
    assert.deepEqual(wrong.map((r) => [r.suite, r.ok, r.fail]), [['hardening', false, 1]]);
  } finally { rm(root); }
  const run = (...a) => spawnSync(process.execPath, [tool('fuzz_nightly.mjs'), ...a], { encoding: 'utf8' });
  assert.equal(run().status, 2);
  assert.equal(run('--date', '2026-10-09', '--only', 'нет').status, 2);
  assert.equal(run('--date', '2026-10-09', '--n', '0').status, 2);
  assert.equal(run('--date', 'вчера').status, 2);
});

test('REQ-171 REQ-174 результат короткого прогона _ops/fuzz-nightly.json: формат, дата, объёмы 2000 и 200, три набора зелёные, полный режим помечен как не запускавшийся', () => {
  const file = path.join(PROTO, '..', '_ops', 'fuzz-nightly.json');
  assert.ok(fs.existsSync(file), '_ops/fuzz-nightly.json нет: node tools/fuzz_nightly.mjs --date ГГГГ-ММ-ДД');
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(d.format, 'runway-fuzz/1');
  assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(d.mode, 'short');
  assert.deepEqual([d.fuzz_n, d.gp_seeds], [2000, 200]);
  assert.deepEqual(d.results.map((r) => r.suite), ['hardening', 'validate_ws', 'golden']);
  for (const r of d.results) assert.ok(r.ok && r.fail === 0 && r.tests > 0, r.suite);
  assert.equal(d.ok, true);
  // FP-24: полный прогон (--full) пишется в раздел `full`, поля короткого прогона остаются прежними; фраза «не запускался» заменяется ссылкой на раздел — намеренное изменение ожидания
  assert.match(d.note, /Короткий прогон проверяет, что ночной режим работает/);
  if (d.full === undefined) assert.match(d.note, /Полный прогон на этой машине не запускался/);
  else {
    assert.match(d.note, /Результат полного прогона — в разделе full/);
    assert.deepEqual([d.full.mode, d.full.fuzz_n, d.full.gp_seeds], ['full', 100000, 1500]);
    assert.match(d.full.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(typeof d.full.complete, 'boolean');
    assert.equal(typeof d.full.exceptions, 'number');
  }
  // расширенный фаззинг в hardening действительно выполнялся, а не был пропущен
  assert.equal(d.results[0].skipped, 0, 'hardening: при FUZZ_N расширенный фаззинг не пропускается');
});

// ── оракул hledger ───────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-173 TST-44 разбор вывода hledger: «2055.00 EUR», «-3,400.00 EUR», «1 234.50 EUR», неразрывный пробел; не число и не евро — null', () => {
  assert.equal(HL.parse_balance_line('2055.00 EUR  assets:bank'), 205500);
  assert.equal(HL.parse_balance_line('   -3,400.00 EUR  assets:bank'), -340000);
  assert.equal(HL.parse_balance_line('1 234.50 EUR'), 123450);
  assert.equal(HL.parse_balance_line('1\u00a0234.50 EUR'), 123450);
  assert.equal(HL.parse_balance_line('0.00 EUR'), 0);
  assert.equal(HL.parse_balance_line('2055.00 USD'), null);
  assert.equal(HL.parse_balance_line('2055 EUR'), null, 'без двух знаков дроби число не принимается');
  assert.equal(HL.parse_balance_line(''), null);
});

test('REQ-173 TST-44 оракул hledger: журнал G-001 записан, ожидаемые остатки 2 055,00 и 3 400,00 € взяты из ряда close и равны канону; команды docker — без сети, каталог только для чтения; Docker не запускается', async () => {
  const dir = path.join(tmp('hl'), 'case');
  try {
    const c = await HL.prepare_case(dir);
    assert.deepEqual(c.expected, { '2026-11-01': 205500, '2026-12-01': 340000 }, 'канон G-001: 2055,00 и 3400,00');
    assert.equal(c.planned, 16, 'разовых плановых правил — 16, как в TST-44');
    const text = fs.readFileSync(path.join(dir, 'g001.journal'), 'utf8');
    assert.equal(text, c.text);
    assert.equal(c.account, 'assets:основной-счёт', 'имя счёта взято из самого журнала (слаг от названия счёта)');
    assert.ok(text.includes('    ' + c.account + '  4000.00 EUR = 4000.00 EUR'), 'якорь на счёте');
    const cmds = HL.build_commands({ dir: '/tmp/x y', image: 'пример/образ@sha256:abc', account: c.account, as_of: c.as_of, horizon_end: c.horizon_end });
    assert.equal(cmds.length, 2);
    for (const x of cmds) {
      assert.deepEqual(x.args.slice(0, 7), ['run', '--rm', '--network', 'none', '--entrypoint', 'hledger', '-v']);
      assert.equal(x.args[7], '/tmp/x y:/data:ro', 'каталог монтируется только для чтения');
      assert.equal(x.args[8], 'пример/образ@sha256:abc');
      assert.deepEqual(x.args.slice(9, 12), ['-f', '/data/g001.journal', 'bal']);
      assert.ok(x.args.includes(c.account) && x.args.includes('--forecast=2026-10-04..2026-11-30') && x.args.includes(x.end));
      assert.match(x.text, /^docker run --rm --network none --entrypoint hledger -v "\/tmp\/x y:\/data:ro" /);
    }
    assert.deepEqual(cmds.map((x) => x.end), [...HL.CHECK_DAYS]);
    assert.equal(HL.DEFAULT_IMAGE, 'dastapov/hledger');
    assert.match(read('tools', 'hledger_oracle.mjs'), /не подтверждено/, 'про образ по умолчанию сказано, что он не проверен');
    // выход за горизонт — понятная ошибка
    const E = await imp('engine', 'index.mjs');
    const a = E.analyze(c.ws, { as_of: c.ws.as_of });
    assert.throws(() => HL.expected_balance(a, '2030-01-01', E), RangeError);
    assert.throws(() => HL.expected_balance(a, '2026-10-04', E), RangeError, 'день перед началом расчёта — вне ряда');
  } finally { rm(path.dirname(dir)); }
});

test('REQ-173 оракул hledger в командной строке: без --run только печать (код 0, «Docker не запускался»); с --run при пустом PATH Docker не найден (код 2) и ничего не запускается', () => {
  const root = tmp('hlcli');
  try {
    const dir = path.join(root, 'case');
    const plain = spawnSync(process.execPath, [tool('hledger_oracle.mjs'), '--dir', dir], { encoding: 'utf8' });
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, /Docker не запускался/);
    assert.match(plain.stdout, /--network none/);
    assert.match(plain.stdout, /205500/);
    const json = JSON.parse(spawnSync(process.execPath, [tool('hledger_oracle.mjs'), '--dir', dir, '--json'], { encoding: 'utf8' }).stdout);
    assert.equal(json.commands.length, 2);
    assert.equal(json.planned_rules, 16);
    assert.equal(json.account, 'assets:основной-счёт');
    const run = spawnSync(process.execPath, [tool('hledger_oracle.mjs'), '--dir', dir, '--run'], { encoding: 'utf8', env: { PATH: '', Path: '', PATHEXT: '' } });
    assert.equal(run.status, 2, run.stdout + run.stderr);
    assert.match(run.stderr, /Docker не найден/);
  } finally { rm(root); }
});
