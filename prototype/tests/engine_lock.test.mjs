// engine_lock.test.mjs — FP-24, REQ-172, TST-52: замок ВЫВОДА движка tests/engine.lock.json (sha256(canon(analyze(ws, query))) для 500 журналов, seed 2026).
// В отличие от arith.lock.json (арифметика money), здесь закреплён расчёт целиком: ряды, резервы, волны, предупреждения, inputs_hash. Политика (tests/arith.lock.policy.json,
// раздел `engine_lock`): правка замка без повышения ENGINE_VERSION — красный тест; замок создаёт и перегенерирует tools/make_engine_lock.mjs (--write / --check).
// Намеренная правка расчёта: повысить ENGINE_VERSION (engine/index.mjs), затем `node tools/make_engine_lock.mjs --write` отдельным коммитом «ENGINE-CHANGE: причина».
// Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENGINE_VERSION, analyze, canon, sha256 } from '../engine/index.mjs';
import { RunwayError } from '../engine/money.mjs';
// tools/mutate.mjs подключается внутри теста порчи движка (динамический импорт): проверки замка на временных копиях проекта (fp24_adv) копируют только make_engine_lock.mjs
import { gen_case, case_seed } from './journal_gen.mjs';
import {
  LOCK_PATH, POLICY_PATH, LOCK_SEED, LOCK_COUNT, LOCK_FORMAT, lock_case, build_lock, lock_text, verify_lock, policy_problems, write_lock, greater, at_least, sha_hex,
  LockBuildError, describe_failure,
} from '../tools/make_engine_lock.mjs';

const LOCK_BYTES = fs.readFileSync(LOCK_PATH);
const LOCK = JSON.parse(LOCK_BYTES.toString('utf8'));
const POLICY = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));

test('REQ-172 TST-52 engine.lock: формат, seed 2026, ровно 500 журналов, уникальные идентификаторы и seed, суммы — 64 hex, версия движка записана', () => {
  assert.equal(LOCK.format, LOCK_FORMAT);
  assert.equal(LOCK.seed, 2026);
  assert.equal(LOCK_SEED, 2026);
  assert.equal(LOCK.count, 500);
  assert.equal(LOCK.cases.length, LOCK_COUNT);
  assert.equal(new Set(LOCK.cases.map((c) => c.id)).size, 500);
  assert.equal(new Set(LOCK.cases.map((c) => c.seed)).size, 500, 'seed журналов различны');
  assert.equal(new Set(LOCK.cases.map((c) => c.sha256)).size, 500, 'выводы разных журналов различны');
  for (const c of LOCK.cases) {
    assert.match(c.sha256, /^[0-9a-f]{64}$/, c.id);
    assert.match(c.journal_sha256, /^[0-9a-f]{64}$/, c.id);
    assert.match(c.inputs_hash, /^[0-9a-f]{64}$/, c.id);
    assert.equal(c.seed, case_seed(LOCK_SEED, c.i), c.id);
  }
  assert.match(LOCK.engine_version, /^\d+\.\d+\.\d+$/);
});

test('REQ-172 TST-52 engine.lock: журналы воспроизводятся из seed побайтно (генератор не менялся) — сумма канонического журнала каждого случая совпала', () => {
  for (const c of LOCK.cases) {
    const g = gen_case(case_seed(LOCK_SEED, c.i));
    assert.equal(g.seed, c.seed, c.id);
    assert.equal(g.events.length, c.events, `${c.id}: число записей журнала`);
    assert.equal(sha_hex(canon(g.events)), c.journal_sha256, `${c.id}: журнал изменился (генератор journal_gen.mjs правили?) — это не изменение движка`);
  }
});

test('REQ-172 TST-52 engine.lock: замок — вывод analyze каждого из 500 журналов совпал с записанным (падает при любом изменении расчёта)', () => {
  const diffs = verify_lock(LOCK);
  assert.deepEqual(diffs, [], 'расхождения замка вывода движка (нужны ENGINE-CHANGE и повышение ENGINE_VERSION):\n' + diffs.slice(0, 8).join('\n'));
});

test('REQ-172 TST-52 engine.lock: версия движка в замке равна ENGINE_VERSION; сумма вывода считается тем же sha256, что движок (node:crypto и чистая реализация совпадают)', () => {
  assert.equal(LOCK.engine_version, ENGINE_VERSION, 'вывод analyze содержит engine_version и inputs_hash: при повышении версии замок перегенерируют');
  for (const i of [0, 137, 499]) {
    const c = gen_case(case_seed(LOCK_SEED, i));
    const text = canon(analyze(c.ws, c.query));
    assert.equal(sha256(text), createHash('sha256').update(text).digest('hex'));
    assert.equal(sha_hex(text), LOCK.cases[i].sha256);
  }
});

test('REQ-172 TST-52 engine.lock: тест чувствителен — подмена вывода движка, записанной суммы, журнала и версии ловится', () => {
  // 1) движок «изменился»: ряд plan на одной минорной единице другой — меняется сумма каждого журнала
  const part = { ...LOCK, cases: LOCK.cases.slice(0, 40) };
  const bent = verify_lock(part, (i) => lock_case(i, { analyze: (ws, q) => { const r = analyze(ws, q); r.series.plan.close[0] += 1; return r; } }));
  assert.equal(bent.length, 40, 'правка одного значения ряда меняет вывод каждого журнала');
  // 2) изменилась только запись в замке
  const t = clone(part);
  t.cases[7].sha256 = '0'.repeat(64);
  assert.equal(verify_lock(t).length, 1);
  // 3) изменился журнал (генератор): сумма журнала не совпадает
  const j = clone(part);
  j.cases[3].journal_sha256 = 'f'.repeat(64);
  assert.ok(verify_lock(j).some((d) => d.includes('журнал стал другим')));
  // 4) замена режима округления в параметрах журнала меняет вывод: мутация данных, а не кода, ловится тем же замком
  const m = verify_lock(clone(part), (i) => {
    const c = gen_case(case_seed(LOCK_SEED, i));
    const r = analyze({ ...c.ws, params: { ...c.ws.params, rounding: c.ws.params.rounding === 'half_up' ? 'half_even' : 'half_up' } }, c.query);
    return { ...LOCK.cases[i], sha256: sha_hex(canon(r)), inputs_hash: r.inputs_hash };
  });
  assert.ok(m.length > 0, 'смена режима округления меняет хотя бы один вывод');
});

test('REQ-172 политика engine_lock: sha256 файла замка равен последней записи истории, ENGINE_VERSION не ниже версии записи, версия замка равна версии последней записи', () => {
  assert.deepEqual(policy_problems(LOCK_BYTES, ENGINE_VERSION, POLICY), []);
  const hist = POLICY.engine_lock.history;
  assert.ok(hist.length >= 1);
  assert.equal(hist.at(-1).cases, LOCK.count, 'число случаев в записи = число случаев в замке');
  assert.equal(hist.at(-1).engine_version, LOCK.engine_version, 'версия последней записи = версия, под которой записан замок');
  assert.equal(sha_hex(LOCK_BYTES), hist.at(-1).lock_sha256);
  assert.equal(lock_text(LOCK), LOCK_BYTES.toString('utf8'), 'файл замка записан в канонической форме инструмента');
});

test('REQ-172 политика engine_lock ловит нарушения: правка замка без записи, запись без повышения версии, повтор хэша, версия движка ниже записи, пустая история; повышение версии без правки замка допустимо', () => {
  const base = { ...POLICY, engine_lock: clone(POLICY.engine_lock) };
  const V = base.engine_lock.history.at(-1).engine_version;
  const [major, minor, patch] = V.split('.').map(Number);
  const V_up = `${major}.${minor}.${patch + 1}`;
  const V_big = `${major + 1}.0.0`;
  const V_down = '0.0.0';
  assert.ok(greater(V, V_down) && greater(V_up, V) && greater(V_big, V_up));
  const edited = Buffer.concat([LOCK_BYTES, Buffer.from(' ')]);
  const entry = (bytes, v) => ({ lock_sha256: sha_hex(bytes), engine_version: v, cases: 500 });
  const with_hist = (...e) => ({ ...base, engine_lock: { ...base.engine_lock, history: [...base.engine_lock.history, ...e] } });
  assert.ok(policy_problems(edited, V, base).some((p) => p.includes('изменён без новой записи')), 'замок правили, записи нет');
  assert.ok(policy_problems(edited, V, with_hist(entry(edited, V))).some((p) => p.includes('не выше предыдущей')), 'запись есть, версия не повышена');
  assert.deepEqual(policy_problems(edited, V_up, with_hist(entry(edited, V_up))), [], 'замок изменён, запись и версия повышены — политика выполнена');
  assert.ok(policy_problems(edited, V, with_hist(entry(edited, V_up))).some((p) => p.includes('ENGINE_VERSION')), 'движок остался прежней версии, а запись о новой есть');
  assert.ok(policy_problems(edited, V_down, with_hist(entry(edited, V_down))).some((p) => p.includes('не выше предыдущей')));
  assert.ok(policy_problems(LOCK_BYTES, V_big, with_hist({ ...base.engine_lock.history[0], engine_version: V_big })).some((p) => p.includes('повтор хэша')));
  assert.deepEqual(policy_problems(LOCK_BYTES, V, { engine_lock: { history: [] } }), ['история замка вывода пуста']);
  assert.deepEqual(policy_problems(LOCK_BYTES, V, {}), ['история замка вывода пуста']);
  assert.deepEqual(policy_problems(LOCK_BYTES, V_up, base), [], 'версия выше записи, замок не менялся — нарушения нет');
  assert.deepEqual(policy_problems(LOCK_BYTES, V, base), []);
  assert.ok(policy_problems(LOCK_BYTES, V_down, base).some((p) => p.includes('ENGINE_VERSION') && p.includes('ниже')));
  assert.ok(at_least('0.1.0', '0.1.0') && at_least('0.2.0', '0.1.9') && !at_least('0.1.0', '0.1.1'));
  assert.ok(greater('0.10.0', '0.9.9') && greater('1.0.0', '0.99.99') && !greater('0.1.0', '0.1.0'));
});

test('REQ-172 политика engine_lock дополняет, а не заменяет политику арифметики: разделы format и history прежние, arith.lock.json и ключи политики не тронуты', () => {
  assert.equal(POLICY.format, 'arith.lock.policy/1');
  assert.equal(POLICY.history.length, 1);
  assert.equal(POLICY.history[0].cases, 574);
  assert.match(POLICY.rule, /arith\.lock\.json/);
  assert.match(POLICY.engine_lock.rule, /engine\.lock\.json/);
});

test('REQ-172 запись замка (write_lock): первый замок создаётся; тот же вывод — без записи; изменённый вывод без повышения версии — отказ; с повышением — новая запись истории; правленый вручную файл восстанавливается', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-elock-'));
  try {
    const lock_path = path.join(dir, 'engine.lock.json');
    const policy_path = path.join(dir, 'policy.json');
    fs.writeFileSync(policy_path, JSON.stringify({ format: 'arith.lock.policy/1', rule: 'x', history: [] }, null, 2) + '\n');
    const lock_a = build_lock(3);
    // 1) первый замок
    const first = write_lock({ lock: lock_a, version: '0.1.0', lock_path, policy_path });
    assert.deepEqual([first.code, first.changed], [0, true]);
    let pol = JSON.parse(fs.readFileSync(policy_path, 'utf8'));
    assert.equal(pol.engine_lock.history.length, 1);
    assert.deepEqual(pol.history, [], 'раздел арифметики не тронут');
    assert.equal(pol.engine_lock.history[0].lock_sha256, sha_hex(fs.readFileSync(lock_path)));
    // 2) тот же вывод — ничего не пишется
    const again = write_lock({ lock: lock_a, version: '0.1.0', lock_path, policy_path });
    assert.deepEqual([again.code, again.changed], [0, false]);
    // 3) вывод изменился, версия прежняя — отказ, файлы целы
    const lock_b = { ...lock_a, cases: lock_a.cases.map((c, k) => (k === 0 ? { ...c, sha256: '1'.repeat(64) } : c)) };
    const before = [fs.readFileSync(lock_path, 'utf8'), fs.readFileSync(policy_path, 'utf8')];
    const refused = write_lock({ lock: lock_b, version: '0.1.0', lock_path, policy_path });
    assert.equal(refused.code, 1);
    assert.match(refused.message, /ОТКАЗ/);
    assert.deepEqual([fs.readFileSync(lock_path, 'utf8'), fs.readFileSync(policy_path, 'utf8')], before);
    // 4) версия ниже — тоже отказ; выше — запись и новая запись истории
    assert.equal(write_lock({ lock: lock_b, version: '0.0.9', lock_path, policy_path }).code, 1);
    const bumped = write_lock({ lock: lock_b, version: '0.1.1', lock_path, policy_path });
    assert.deepEqual([bumped.code, bumped.changed], [0, true]);
    pol = JSON.parse(fs.readFileSync(policy_path, 'utf8'));
    assert.deepEqual(pol.engine_lock.history.map((e) => e.engine_version), ['0.1.0', '0.1.1']);
    assert.deepEqual(policy_problems(fs.readFileSync(lock_path), '0.1.1', pol), []);
    // 5) файл замка правили руками: тот же вывод движка восстанавливает его, история не растёт
    fs.writeFileSync(lock_path, fs.readFileSync(lock_path, 'utf8') + ' ');
    assert.ok(policy_problems(fs.readFileSync(lock_path), '0.1.1', pol).length > 0, 'правка без записи видна политике');
    const restored = write_lock({ lock: lock_b, version: '0.1.1', lock_path, policy_path });
    assert.deepEqual([restored.code, restored.changed], [0, true]);
    assert.equal(JSON.parse(fs.readFileSync(policy_path, 'utf8')).engine_lock.history.length, 2);
    assert.deepEqual(policy_problems(fs.readFileSync(lock_path), '0.1.1', JSON.parse(fs.readFileSync(policy_path, 'utf8'))), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('REQ-172 командная строка make_engine_lock: --check зелёный на чистом дереве и ничего не меняет; без ключа — код 2', () => {
  const tool = fileURLToPath(new URL('../tools/make_engine_lock.mjs', import.meta.url));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const none = spawnSync(process.execPath, [tool], { encoding: 'utf8', env });
  assert.equal(none.status, 2);
  const before = [fs.readFileSync(LOCK_PATH), fs.readFileSync(POLICY_PATH)];
  const chk = spawnSync(process.execPath, [tool, '--check'], { encoding: 'utf8', env });
  assert.equal(chk.status, 0, chk.stdout + chk.stderr);
  assert.match(chk.stdout, /замок вывода движка совпал: 500 журналов/);
  assert.ok(before[0].equals(fs.readFileSync(LOCK_PATH)) && before[1].equals(fs.readFileSync(POLICY_PATH)), 'файлы замка и политики не изменились');
  assert.equal(build_lock(3).cases.length, 3, 'build_lock принимает число журналов');
});

// ── сбой расчёта на журнале замка: понятное сообщение, а не стек (FP-24, исправление после проверки) ───────────────────────────────────────────────

test('REQ-172 сбой расчёта на журнале замка: lock_case не бросает, а возвращает запись с failed (код и причина); verify_lock называет такие журналы «расчёт упал»; build_lock отказывает LockBuildError со списком', () => {
  const broken = () => { throw new RunwayError('E_SCHEMA', { reason: 'need_not_positive', value: '0' }); };
  const row = lock_case(7, { analyze: broken });
  assert.deepEqual(Object.keys(row), ['id', 'i', 'seed', 'failed']);
  assert.equal(row.id, 'j0008');
  assert.match(row.failed, /^E_SCHEMA: .*need_not_positive/);
  assert.ok(row.failed.length <= 160 && !row.failed.includes('\n'), 'причина короткая, одной строкой');
  assert.deepEqual(Object.keys(lock_case(7)), ['id', 'i', 'seed', 'events', 'journal_sha256', 'inputs_hash', 'sha256'], 'успешная запись прежней формы');
  assert.equal(describe_failure(new TypeError('x y')), 'TypeError: x y');
  assert.equal(describe_failure('просто строка'), 'просто строка');
  // verify_lock: каждое упавшее — расхождение с причиной; остальные журналы сверяются как раньше
  const part = { ...LOCK, cases: LOCK.cases.slice(0, 5) };
  const diffs = verify_lock(part, (i) => (i === 1 || i === 3 ? lock_case(i, { analyze: broken }) : lock_case(i)));
  assert.equal(diffs.length, 2);
  assert.match(diffs[0], new RegExp(`^${part.cases[1].id} \\(seed ${part.cases[1].seed}\\): расчёт упал: E_SCHEMA`));
  assert.match(diffs[1], /^j0004 .*расчёт упал/);
  // build_lock: замок из упавшего расчёта не строится
  let err = null;
  try { build_lock(4, { analyze: broken }); } catch (e) { err = e; }
  assert.ok(err instanceof LockBuildError, 'LockBuildError');
  assert.equal(err.failures.length, 4);
  assert.match(err.message, /расчёт упал на 4 из 4 журналов: j0001 \(seed \d+\): E_SCHEMA/);
  assert.equal(build_lock(2).cases.length, 2, 'без сбоев замок строится как раньше');
  // сбой при построении самого журнала (порча ledger.mjs роняет свёртку) — тоже запись с причиной
  assert.match(lock_case(0, { analyze: () => { throw new Error('boom'); } }).failed, /^Error: boom$/);
});

test('REQ-172 командная строка при порче движка: --check и --write на копии с испорченным timeline.mjs (мутант T01) отвечают кодом 1 и строкой «расчёт упал» / «ОТКАЗ», без стека; файлы замка и политики не меняются', async () => {
  const { MUTANTS_ENGINE, apply_mutant } = await import('../tools/mutate.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-elock-broken-'));
  try {
    const proto = fileURLToPath(new URL('..', import.meta.url));
    for (const rel of ['engine', 'tools/make_engine_lock.mjs', 'tests/helpers.mjs', 'tests/journal_gen.mjs', 'tests/engine.lock.json', 'tests/arith.lock.policy.json']) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.cpSync(path.join(proto, rel), path.join(dir, rel), { recursive: true });
    }
    const t01 = MUTANTS_ENGINE.find((m) => m.id === 'T01');
    const target = path.join(dir, t01.file);
    fs.writeFileSync(target, apply_mutant(fs.readFileSync(target, 'utf8'), t01));
    const before = [fs.readFileSync(path.join(dir, 'tests', 'engine.lock.json'), 'utf8'), fs.readFileSync(path.join(dir, 'tests', 'arith.lock.policy.json'), 'utf8')];
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = (arg) => spawnSync(process.execPath, [path.join(dir, 'tools', 'make_engine_lock.mjs'), arg], { cwd: dir, encoding: 'utf8', env, timeout: 120000 });
    const no_stack = (r) => { assert.ok(!/Node\.js v\d/.test(r.stderr) && !/\n\s+at /.test(r.stderr), 'стека нет: ' + r.stderr.slice(0, 300)); };
    const check = run('--check');
    assert.equal(check.status, 1, check.stdout + check.stderr);
    no_stack(check);
    assert.match(check.stderr, /расчёт упал: /);
    assert.match(check.stdout, /расхождений: \d+/);
    const write = run('--write');
    assert.equal(write.status, 1, write.stdout + write.stderr);
    no_stack(write);
    assert.match(write.stderr, /ОТКАЗ: расчёт упал на \d+ из 500 журналов: j\d{4} \(seed \d+\): /);
    assert.match(write.stderr, /Замок не записан/);
    assert.deepEqual([fs.readFileSync(path.join(dir, 'tests', 'engine.lock.json'), 'utf8'), fs.readFileSync(path.join(dir, 'tests', 'arith.lock.policy.json'), 'utf8')], before, 'отказ ничего не пишет');
    const print = run('--print');
    assert.equal(print.status, 1);
    no_stack(print);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
