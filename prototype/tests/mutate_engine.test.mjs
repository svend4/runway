// mutate_engine.test.mjs — FP-24, REQ-175 (мутационные проверки), REQ-171: каталог мутаций расчётного ядра tools/mutate.mjs (`MUTANTS_ENGINE`: timeline, afford, sinking, tax, fx, verifier;
// не менее 40 мутантов) и результат его единственного полного прогона в _ops/mutation.json (раздел `engine`): убито не менее 90 %, выжившие и эквивалентные названы с причиной.
// Здесь НЕ выполняется полный прогон (≈ 7 минут): проверяются согласованность каталога с кодом, синтаксис каждой порчи, механизм на трёх мутантах, актуальность результата и сводка.
// Прежний каталог money/dates и его результат проверяет tests/quality_tools.test.mjs. Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const MU = await import(pathToFileURL(path.join(PROTO, 'tools', 'mutate.mjs')).href);
const read = (...p) => fs.readFileSync(path.join(PROTO, ...p), 'utf8');
const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), 'runway-me-' + label + '-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const sha = (s) => createHash('sha256').update(s).digest('hex');
const MODULES = ['timeline', 'afford', 'sinking', 'tax', 'fx', 'verifier'];
const L = MU.MUTANTS_ENGINE;

test('REQ-175 каталог мутаций ядра: не менее 40 мутантов, идентификаторы T/A/S/X/F/V + две цифры уникальны, шесть модулей по ≥ 5, фрагмент встречается в коде ровно один раз, порча отличается и описана', () => {
  assert.ok(L.length >= 40, 'мутантов ядра: ' + L.length);
  assert.equal(new Set(L.map((m) => m.id)).size, L.length);
  const src = Object.fromEntries(MODULES.map((m) => [`engine/${m}.mjs`, read('engine', `${m}.mjs`)]));
  const per = Object.fromEntries(MODULES.map((m) => [m, 0]));
  const prefix = { timeline: 'T', afford: 'A', sinking: 'S', tax: 'X', fx: 'F', verifier: 'V' };
  for (const m of L) {
    assert.match(m.id, /^[TASXFV]\d{2}$/);
    assert.ok(m.file in src, `${m.id}: цель ${m.file}`);
    const mod = MU.module_of(m);
    assert.ok(MODULES.includes(mod), m.id);
    assert.equal(m.id[0], prefix[mod], `${m.id}: буква идентификатора соответствует модулю ${mod}`);
    per[mod] += 1;
    assert.equal(MU.count_of(src[m.file], m.find), 1, `${m.id}: фрагмент должен встречаться ровно один раз`);
    assert.notEqual(m.find, m.replace, m.id);
    assert.ok(typeof m.what === 'string' && m.what.length > 20, m.id + ': описание');
    assert.doesNotThrow(() => MU.apply_mutant(src[m.file], m), m.id);
  }
  for (const mod of MODULES) assert.ok(per[mod] >= 5, `${mod}: мутантов ${per[mod]}`);
  assert.ok(per.timeline >= 10 && per.afford >= 10, JSON.stringify(per));
  // виды порч: граница, смена знака, min/max, подмена константы
  const kinds = { cmp: 0, sign: 0, minmax: 0, swap: 0 };
  for (const m of L) {
    if (/\(?[<>≤≥]=? → [<>≤≥]=?\)?|→ [<>≤≥]/.test(m.what)) kinds.cmp += 1;
    if (/знак|минус|плюс|инвертирован|перевёрнут|наоборот/i.test(m.what)) kinds.sign += 1;
    if (/min → max|max → min|max заменён на min|min заменён на max|максимумом|минимум/i.test(m.what)) kinds.minmax += 1;
    if (/вместо|заменён|поменялись|перепутан|на единицу|на один/i.test(m.what)) kinds.swap += 1;
  }
  assert.ok(kinds.cmp >= 10 && kinds.sign >= 8 && kinds.minmax >= 5 && kinds.swap >= 10, JSON.stringify(kinds));
  // хэш каталога: меняется при любой правке порчи, отличается от хэша прежнего каталога; поля-пояснения в хэш не входят
  assert.match(MU.catalog_hash(L), /^[0-9a-f]{64}$/);
  assert.notEqual(MU.catalog_hash(L), MU.catalog_hash(MU.MUTANTS));
  assert.notEqual(MU.catalog_hash(L.slice(1)), MU.catalog_hash(L));
  assert.equal(MU.catalog_hash(L.map((m) => ({ ...m, what: 'иначе', unkilled: 'иначе', equivalent: 'иначе' }))), MU.catalog_hash(L), 'пояснения в хэш не входят: причину можно дописать без нового прогона');
});

test('REQ-175 прежний каталог money/dates не менялся: 61 мутант, идентификаторы M/D, хэш равен записанному в _ops/mutation.json', () => {
  assert.equal(MU.MUTANTS.length, 61);
  assert.ok(MU.MUTANTS.every((m) => /^[MD]\d{2}$/.test(m.id) && (m.file === 'engine/money.mjs' || m.file === 'engine/dates.mjs')));
  const d = JSON.parse(fs.readFileSync(path.join(PROTO, '..', '_ops', 'mutation.json'), 'utf8'));
  assert.equal(d.catalog_hash, MU.catalog_hash(), 'раздел money/dates результата соответствует прежнему каталогу');
  assert.equal(d.mutants, 61);
});

test('REQ-175 каждая порча ядра — корректный JavaScript-модуль (node --check): порча не ломает синтаксис, мутант убивается поведением, а не ошибкой разбора', () => {
  const dir = tmp('syntax');
  try {
    const src = Object.fromEntries(MODULES.map((m) => [`engine/${m}.mjs`, read('engine', `${m}.mjs`)]));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    for (const m of L) {
      const file = path.join(dir, m.id + '.mjs');
      fs.writeFileSync(file, MU.apply_mutant(src[m.file], m));
      const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', env });
      assert.equal(r.status, 0, `${m.id}: синтаксис порчи: ${r.stderr.slice(0, 200)}`);
    }
  } finally { rm(dir); }
});

test('REQ-175 проверяющие мутантов ядра: у каждого модуля есть список, файлы существуют, первый — тест самого модуля; property-тесты идут на малом N и только девятью инвариантами; замок вывода — одной проверкой', () => {
  assert.deepEqual(Object.keys(MU.KILLERS_ENGINE), MODULES);
  for (const mod of MODULES) {
    const list = MU.KILLERS_ENGINE[mod];
    assert.ok(list.length >= 2, mod);
    assert.equal(list[0].file, `tests/${mod}.test.mjs`, `${mod}: первым идёт быстрый тест самого модуля`);
    for (const k of list) assert.ok(fs.existsSync(path.join(PROTO, k.file)), k.file);
  }
  const prop = MU.KILLERS_ENGINE.timeline.find((k) => k.file === 'tests/properties.test.mjs');
  assert.equal(prop.env.PROP_N, '40');
  assert.match('TST-31 Свойство (40 журналов, seed 3139): сохранение', new RegExp(prop.pattern));
  const lock = MU.KILLERS_ENGINE.timeline.find((k) => k.file === 'tests/engine_lock.test.mjs');
  assert.ok(new RegExp(lock.pattern).test(read('tests', 'engine_lock.test.mjs')), 'фильтр замка находит свой тест');
  assert.ok(MU.KILLERS_ENGINE.sinking.some((k) => k.file === 'tests/hardening.test.mjs'), 'S04: в наборе sinking есть hardening (TST-23 Q-20)');
  // каждый фильтр по имени действительно находит тесты своего файла
  for (const k of Object.values(MU.KILLERS_ENGINE).flat().filter((x) => x.pattern !== undefined)) {
    const names = [...read(k.file).matchAll(/^test\('([^']*)'/gm)].map((x) => x[1]);
    const dynamic = /\btest\(`/.test(read(k.file)); // названия-шаблоны (properties.test.mjs) проверены выше по образцу заголовка
    if (!dynamic) assert.ok(names.some((n) => new RegExp(k.pattern).test(n)), `${k.file}: фильтр ${k.pattern.slice(0, 30)}… не находит ни одного теста`);
  }
  // замер времени исключён из проверяющих timeline (случайные «убийства» под нагрузкой)
  const tl = MU.KILLERS_ENGINE.timeline[0];
  assert.ok(!new RegExp(tl.pattern).test('TST-54 производительность: N·M = 180 · 10³'));
});

test('REQ-175 механизм на копии: три мутанта ядра (два убиты быстрыми тестами, безвредная правка выжила) в каталоге <w>/prototype; рабочее дерево не тронуто; <w>/tools/lint_vocab.mjs рядом', () => {
  const root = tmp('live');
  const work = path.join(root, 'work');
  const files = ['engine/timeline.mjs', 'engine/tax.mjs'];
  const before = Object.fromEntries(files.map((f) => [f, sha(read(...f.split('/')))]));
  try {
    const mutants = [
      L.find((m) => m.id === 'T01'),
      L.find((m) => m.id === 'X02'),
      { id: 'X99', file: 'engine/tax.mjs', find: 'export function release_on_payment(funded_minor, payment_minor) {', replace: 'export function release_on_payment(funded_minor, payment_minor) { // безвредная правка', what: 'безвредная правка (контроль: тесты не краснеют)' },
    ];
    const by_file = { 'engine/timeline.mjs': [{ file: 'tests/g001.golden.test.mjs' }], 'engine/tax.mjs': [{ file: 'tests/tax.test.mjs' }] };
    const r = MU.run_mutants({ work_dir: work, mutants, killers_of: (m) => by_file[m.file], prepare: { mode: 'engine' }, timeout_ms: 60000, single_process: true }); // как в командной строке: тест в процессе раннера
    assert.equal(r.aborted, null, JSON.stringify(r));
    assert.ok(r.baseline.every((b) => b.ok && b.tests > 5), 'контроль зелёный');
    assert.deepEqual(r.results.map((x) => [x.id, x.status, x.killed_by]), [['T01', 'killed', 'tests/g001.golden.test.mjs'], ['X02', 'killed', 'tests/tax.test.mjs'], ['X99', 'survived', null]]);
    assert.ok(fs.existsSync(path.join(work, 'prototype', 'engine', 'timeline.mjs')) && fs.existsSync(path.join(work, 'tools', 'lint_vocab.mjs')) && fs.existsSync(path.join(work, '.runway-mutate')));
    assert.ok(fs.existsSync(path.join(work, 'prototype', 'tests', 'engine.lock.json')) && fs.existsSync(path.join(work, 'prototype', 'data', 'g001.json')), 'тесты и данные в копии есть');
    assert.equal(read('engine', 'tax.mjs'), fs.readFileSync(path.join(work, 'prototype', 'engine', 'tax.mjs'), 'utf8'), 'после прогона копия снова равна оригиналу');
    for (const f of files) assert.equal(sha(read(...f.split('/'))), before[f], f + ': рабочее дерево не менялось');
    // каталог внутри проекта и над ним отвергается и в режиме engine
    assert.throws(() => MU.prepare_work_dir(path.join(PROTO, 'tmp-mutate'), PROTO, { mode: 'engine' }), /внутри prototype/);
  } finally { rm(root); }
});

test('REQ-175 командная строка (каталог ядра): --dry-run применяет все мутации без тестов и без записи; без --work-dir и без --date — код 2; неизвестный каталог — код 2; --annotate без раздела engine — код 2', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = (...a) => spawnSync(process.execPath, [path.join(PROTO, 'tools', 'mutate.mjs'), ...a], { encoding: 'utf8', env });
  const ops = path.join(PROTO, '..', '_ops', 'mutation.json');
  const before = fs.readFileSync(ops);
  const root = tmp('cli');
  try {
    const dry = run('--catalog', 'engine', '--work-dir', path.join(root, 'w'), '--dry-run');
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, new RegExp(`мутантов ядра ${L.length}: убито 0`));
    for (const mod of MODULES) assert.match(dry.stdout, new RegExp(`  ${mod}: 0 из \\d+`));
    assert.equal(run('--catalog', 'engine', '--dry-run').status, 2);
    assert.equal(run('--catalog', 'engine', '--work-dir', path.join(root, 'w2')).status, 2, 'без --date прогон не стартует');
    assert.equal(run('--catalog', 'нет', '--work-dir', path.join(root, 'w3'), '--dry-run').status, 2);
    assert.equal(run('--catalog', 'engine', '--work-dir', PROTO, '--dry-run').status, 2, 'каталог внутри prototype/ отвергается');
    const empty = path.join(root, 'empty.json');
    fs.writeFileSync(empty, '{"format":"runway-mutation/1"}');
    assert.equal(run('--catalog', 'engine', '--annotate', '--out', empty).status, 2);
  } finally { rm(root); }
  assert.ok(before.equals(fs.readFileSync(ops)), '_ops/mutation.json не менялся');
});

test('REQ-175 engine_summary и annotate_engine: доля убитых считается среди неэквивалентных; выживший с пометкой «эквивалентный» переходит в эквивалентные; выживший без причины назван в missing', () => {
  const mk = (id, extra = {}) => ({ id, file: 'engine/timeline.mjs', find: 'a', replace: 'b', what: 'порча ' + id, ...extra });
  const fake = [mk('T01'), mk('T02', { unkilled: 'причина выжившего' }), mk('T03'), mk('T04', { equivalent: 'порча не меняет поведения' }), mk('T05')];
  const res = (status) => (id) => ({ id, file: 'engine/timeline.mjs', status });
  const results = [res('killed')('T01'), res('survived')('T02'), res('survived')('T03'), res('survived')('T04'), res('killed')('T05')];
  const sm = MU.engine_summary(results, fake);
  assert.deepEqual([sm.killed.length, sm.survivors.map((x) => x.id), sm.equivalent.map((x) => x.id), sm.equiv_killed.length], [2, ['T02', 'T03'], ['T04'], 0]);
  assert.equal(sm.kill_rate_pct, 50, '2 из 4 неэквивалентных');
  assert.equal(sm.kill_rate_all_pct, 40);
  assert.deepEqual(sm.by_module, { timeline: { mutants: 5, killed: 2 } });
  assert.equal(MU.engine_summary([res('killed')('T04')], fake).equiv_killed.length, 1, 'эквивалентный, но убитый — ошибка пометки');
  const doc = { mutants: 5, killed: 2, survivors: [{ id: 'T02', file: 'f', what: 'w' }, { id: 'T03', file: 'f', what: 'w' }, { id: 'T04', file: 'f', what: 'w' }], equivalent: [] };
  const { doc: out, missing } = MU.annotate_engine(doc, fake);
  assert.deepEqual(missing, ['T03'], 'T03 без причины');
  assert.deepEqual(out.survivors.map((x) => [x.id, x.reason]), [['T02', 'причина выжившего'], ['T03', null]]);
  assert.deepEqual(out.equivalent.map((x) => [x.id, x.why]), [['T04', 'порча не меняет поведения']]);
  assert.equal(out.kill_rate_pct, 50);
  assert.equal(MU.ENGINE_KILL_RATE_MIN_PCT, 90);
});

test('REQ-175 результат единственного полного прогона _ops/mutation.json → engine: не устарел (хэш каталога), убито не менее 90 % неэквивалентных, выжившие с причиной, эквивалентные с обоснованием, ошибок нет, прежний раздел money/dates на месте', () => {
  const full = JSON.parse(fs.readFileSync(path.join(PROTO, '..', '_ops', 'mutation.json'), 'utf8'));
  const d = full.engine;
  assert.ok(d !== undefined, '_ops/mutation.json: нет раздела engine — node tools/mutate.mjs --catalog engine --work-dir <каталог вне проекта> --date ГГГГ-ММ-ДД');
  assert.equal(d.format, 'runway-mutation-engine/1');
  assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(d.catalog_hash, MU.catalog_hash(L), 'каталог мутаций ядра изменён после прогона: повторите полный прогон');
  assert.equal(d.mutants, L.length);
  assert.deepEqual(d.results.map((r) => r.id), L.map((m) => m.id));
  const killed = d.results.filter((r) => r.status === 'killed');
  assert.equal(d.killed, killed.length);
  assert.deepEqual(d.errors, []);
  assert.ok(d.baseline.length >= 8 && d.baseline.every((b) => b.ok && b.tests > 0), 'контроль на неиспорченной копии зелёный');
  const survived = d.results.filter((r) => r.status === 'survived').map((r) => r.id);
  assert.deepEqual([...d.survivors.map((s) => s.id), ...d.equivalent.map((s) => s.id)].sort(), [...survived].sort(), 'каждый выживший — либо в survivors, либо среди эквивалентных');
  const rate = Math.round((1000 * killed.length) / (d.mutants - d.equivalent.length)) / 10;
  assert.equal(d.kill_rate_pct, rate);
  assert.ok(d.kill_rate_pct >= 90, `убито ${d.kill_rate_pct} % неэквивалентных мутантов (нужно ≥ 90)`);
  assert.equal(d.kill_rate_min_pct, 90);
  for (const s of d.survivors) {
    assert.ok(typeof s.reason === 'string' && s.reason.length > 60, `${s.id}: причина выжившего названа`);
    assert.equal(L.find((m) => m.id === s.id)?.unkilled, s.reason, `${s.id}: причина совпадает с полем unkilled каталога`);
  }
  for (const e of d.equivalent) {
    assert.ok(typeof e.why === 'string' && e.why.length > 60, `${e.id}: обоснование эквивалентности`);
    assert.equal(L.find((m) => m.id === e.id)?.equivalent, e.why);
  }
  assert.deepEqual(Object.keys(d.by_module), MODULES);
  assert.equal(Object.values(d.by_module).reduce((a, v) => a + v.mutants, 0), d.mutants);
  assert.equal(Object.values(d.by_module).reduce((a, v) => a + v.killed, 0), d.killed);
  for (const r of killed) assert.ok(MU.KILLERS_ENGINE[MU.module_of(r)].some((k) => k.file === r.killed_by) || r.killed_by === 'tests/hardening.test.mjs', `${r.id}: убит проверяющим из набора модуля`);
  assert.equal(full.mutants, 61, 'раздел money/dates остался прежним');
  assert.equal(full.catalog_hash, MU.catalog_hash());
});

// ═══ исправление D4 (после независимой проверки): какая сеть что убила — режим --nets ═══════════════════════════════════════════════════════════
// Раньше результат хранил лишь «первого убившего» (почти всегда — тест самого модуля), и по README выходило, что property-тесты и замок вывода ловят порчи ядра сильнее, чем было на самом деле.
// Режим --nets запускает каждого проверяющего независимо и пишет, кого убила какая сеть (тесты модуля, property-тесты, замок вывода, golden) и кого не видит ни одна из трёх сетей поперёк модулей.

test('REQ-175 D4 failed_names и invariants_of: из вывода раннера берутся названия упавших тестов без времени, из них — номера инвариантов TST-31…39; пустой вывод — пустой список', () => {
  const out = '✔ TST-31 Свойство (40 журналов, seed 3139): сохранение (3.2ms)\n✖ TST-35 Свойство (40 журналов, seed 3139): монотонность (12.5ms)\n✖ TST-32 Свойство (40 журналов, seed 3139): идемпотентность (1ms)\n'
    + '✖ другой тест (0.4ms)\nℹ tests 4\n✖ failing tests:\n\n✖ TST-35 Свойство (40 журналов, seed 3139): монотонность (12.5ms)\n';
  const names = MU.failed_names(out);
  assert.deepEqual(names, ['TST-35 Свойство (40 журналов, seed 3139): монотонность', 'TST-32 Свойство (40 журналов, seed 3139): идемпотентность', 'другой тест']);
  assert.deepEqual(MU.invariants_of(names), ['TST-32', 'TST-35']);
  assert.deepEqual(MU.invariants_of(['TST-35 Свойство (1): a', 'TST-35 Свойство (2): b', 'TST-99 Свойство']), ['TST-35']);
  assert.deepEqual(MU.failed_names('ℹ tests 1\nℹ pass 1\n'), []);
  assert.deepEqual(MU.invariants_of([]), []);
  assert.deepEqual(['module', 'properties', 'lock', 'golden'], ['tests/timeline.test.mjs', 'tests/properties.test.mjs', 'tests/engine_lock.test.mjs', 'tests/g001.golden.test.mjs'].map((f) => MU.net_of({ file: f })));
  assert.deepEqual(Object.keys(MU.NETS), ['properties', 'lock', 'golden']);
});

test('REQ-175 D4 nets_summary: счёт мутантов по сетям, «хотя бы одна из трёх», «ни одна из трёх» (убивают только тесты модуля), выжившие и эквивалентные, инварианты с нулями, итоги по модулям', () => {
  const mk = (id, file, status, nets, invariants = []) => ({ id, file: `engine/${file}.mjs`, status, nets, invariants });
  const fake = [{ id: 'V07', equivalent: 'порча не меняет поведения' }];
  const results = [
    mk('T01', 'timeline', 'killed', ['module', 'properties', 'lock', 'golden'], ['TST-31', 'TST-35']),
    mk('T02', 'timeline', 'killed', ['module']),
    mk('X01', 'tax', 'killed', ['module', 'lock']),
    mk('X02', 'tax', 'survived', []),
    mk('V07', 'verifier', 'survived', []),
    { id: 'Z', file: 'engine/fx.mjs', status: 'killed' }, // строка без поля nets (прогон без --nets) не учитывается
  ];
  const s = MU.nets_summary(results, fake);
  assert.equal(s.mutants, 5);
  assert.deepEqual(s.by_net, { module: 3, properties: 1, lock: 2, golden: 1 });
  assert.equal(s.any_of_three, 2);
  assert.deepEqual(s.none_of_three, ['T02', 'X02', 'V07']);
  assert.deepEqual(s.module_only, ['T02']);
  assert.deepEqual(s.survived_everything, ['X02', 'V07']);
  assert.deepEqual(s.equivalent, ['V07']);
  assert.deepEqual(Object.keys(s.by_invariant), MU.INVARIANT_IDS);
  assert.deepEqual(MU.INVARIANT_IDS.map((id) => s.by_invariant[id]), [1, 0, 0, 0, 1, 0, 0, 0, 0], 'инварианты без убитых мутантов видны нулями');
  assert.deepEqual(s.by_module.timeline, { mutants: 2, properties: 1, lock: 1, golden: 1, none_of_three: 1 });
  assert.deepEqual(s.by_module.tax, { mutants: 2, properties: 0, lock: 1, golden: 0, none_of_three: 1 });
  assert.deepEqual(s.by_module.verifier, { mutants: 1, properties: 0, lock: 0, golden: 0, none_of_three: 1 });
  assert.deepEqual(MU.nets_summary([]).by_net, { module: 0, properties: 0, lock: 0, golden: 0 });
});

test('REQ-175 D4 механизм --nets на копии: все проверяющие запускаются независимо (второй работает, хотя первый уже убил), nets называет сети, убившие мутанта; безвредная правка выживает с пустым nets; без all_killers — как раньше, остановка на первом', () => {
  const root = tmp('nets');
  const work = path.join(root, 'work');
  try {
    const mutants = [
      L.find((m) => m.id === 'T01'),
      { id: 'X99', file: 'engine/tax.mjs', find: 'export function release_on_payment(funded_minor, payment_minor) {', replace: 'export function release_on_payment(funded_minor, payment_minor) { // безвредная правка', what: 'безвредная правка (контроль: тесты не краснеют)' },
    ];
    const killers = [MU.NETS.golden, MU.NETS.lock];
    const all = MU.run_mutants({ work_dir: work, mutants, killers_of: () => killers, prepare: { mode: 'engine' }, timeout_ms: 60000, single_process: true, all_killers: true });
    assert.equal(all.aborted, null, JSON.stringify(all));
    const [t01, x99] = all.results;
    assert.deepEqual([t01.id, t01.status, t01.killed_by, t01.nets], ['T01', 'killed', 'tests/g001.golden.test.mjs', ['lock', 'golden']], 'первым убил golden, но замок вывода запущен тоже и убил (порядок сетей в записи — module, properties, lock, golden)');
    assert.deepEqual(t01.invariants, [], 'property-тесты в этом наборе не запускались');
    assert.deepEqual([x99.id, x99.status, x99.killed_by, x99.nets], ['X99', 'survived', null, []]);
    const first_only = MU.run_mutants({ work_dir: work, mutants: [mutants[0]], killers_of: () => killers, prepare: { mode: 'engine' }, timeout_ms: 60000, single_process: true });
    assert.deepEqual([first_only.results[0].status, first_only.results[0].killed_by, first_only.results[0].nets], ['killed', 'tests/g001.golden.test.mjs', undefined], 'без all_killers поля nets нет и остановка на первом');
  } finally { rm(root); }
});

test('REQ-175 D4 командная строка: --nets принимается вместе с --dry-run (тесты не запускаются, сводка по сетям не печатается, _ops/mutation.json не меняется)', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const ops = path.join(PROTO, '..', '_ops', 'mutation.json');
  const before = fs.readFileSync(ops);
  const root = tmp('netscli');
  try {
    const r = spawnSync(process.execPath, [path.join(PROTO, 'tools', 'mutate.mjs'), '--catalog', 'engine', '--nets', '--work-dir', path.join(root, 'w'), '--dry-run'], { encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`мутантов ядра ${L.length}: убито 0`));
    assert.ok(!r.stdout.includes('сети:'), 'в сухом прогоне сводки по сетям нет');
  } finally { rm(root); }
  assert.ok(before.equals(fs.readFileSync(ops)), '_ops/mutation.json не менялся');
});

test('REQ-175 D4 матрица сетей в _ops/mutation.json → engine: у каждого мутанта записаны сети и инварианты, сводка nets_summary пересчитывается из строк и не устарела, убитые не пересчитываются в выжившие; README называет те же числа и не приписывает сетям больше, чем они убили', () => {
  const d = JSON.parse(fs.readFileSync(path.join(PROTO, '..', '_ops', 'mutation.json'), 'utf8')).engine;
  assert.ok(d.nets_summary !== undefined, 'нет nets_summary: node tools/mutate.mjs --catalog engine --nets --work-dir <каталог вне проекта> --date ГГГГ-ММ-ДД');
  assert.equal(d.nets_summary.catalog_hash, d.catalog_hash, 'сводка по сетям относится к тому же каталогу, что и прогон');
  assert.equal(d.catalog_hash, MU.catalog_hash(L), 'каталог не менялся после прогона');
  for (const r of d.results) {
    assert.ok(Array.isArray(r.nets) && Array.isArray(r.invariants), r.id + ': поля nets и invariants');
    assert.ok(r.nets.every((n) => ['module', 'properties', 'lock', 'golden'].includes(n)), r.id);
    assert.equal(r.status === 'killed', r.nets.length > 0, `${r.id}: убит ровно тогда, когда его убила хотя бы одна сеть`);
    if (!r.nets.includes('properties')) assert.deepEqual(r.invariants, [], `${r.id}: инварианты названы только у убитых property-тестами`);
    else assert.ok(r.invariants.length > 0, `${r.id}: property-тесты назвали инвариант`);
  }
  const { catalog_hash: _hash, ...rest } = d.nets_summary;
  assert.deepEqual(rest, MU.nets_summary(d.results, L), 'сводка пересчитывается из строк результата');
  const s = d.nets_summary;
  assert.equal(s.by_net.module, d.killed, 'тесты модуля убивают всех убитых (сети поперёк модулей — дополнительные)');
  assert.deepEqual([...s.none_of_three].sort(), [...s.module_only, ...s.survived_everything].sort(), 'не видит ни одна из трёх сетей = убиты только тестами модуля + не убитые никем');
  assert.deepEqual(s.survived_everything.filter((id) => !d.equivalent.some((e) => e.id === id)), [], 'не убитые никем — только эквивалентные: ' + JSON.stringify(d.survivors));
  assert.equal(s.by_invariant['TST-38'], 0, 'ни один исходный мутант каталога не задевает io и ledger — TST-38 на исходных порчах не красен (красен на подменах api)');
  // README: те же числа, названные в одной фразе; формулировка про замок не обещает ловить порчи, которых замок не видел
  const readme = read('README.md');
  assert.ok(readme.includes(`property-тесты убивают ${s.by_net.properties}, замок вывода — ${s.by_net.lock}, golden G-001 — ${s.by_net.golden}, тесты модулей — ${s.by_net.module}`), 'README: числа сетей совпадают с _ops/mutation.json');
  assert.ok(readme.includes(`ни одна из трёх сетей не видит ${s.none_of_three.length}`), 'README: число мутантов, невидимых трём сетям');
  assert.ok(!/порча, меняющая вывод хотя бы на одном из 500 журналов, не пройдёт мимо него\./.test(readme), 'README: прежняя безусловная фраза про замок заменена');
});
