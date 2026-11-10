// fp24_adv.test.mjs — независимая (состязательная) проверка пакета FP-24 «Тестовая сеть: property-инварианты на 10³ журналах, замок вывода движка, мутации ядра, полный фаззинг».
// Зелёные тесты — свойства, проверенные другим путём, чем тесты реализатора: свой пересчёт замка через node:crypto, свой разбор таблицы подмен, брутфорс эквивалентности мутанта V07,
// сквозной сценарий замка на временной копии (правка замка, правка расчёта, повышение версии), свой зонд сопоставления на журналах с «зеркальными» фактами.
// Тесты с `todo` — найденные дефекты: они падают при проверке и не ломают прогон; после исправления у них снимают пометку.
//   Исправление дефектов (2026-10-28): D2 и D3 исправлены, пометка `todo` снята; D4 не исправлен (причина — у его теста).
//   D2 · сопоставление «план ↔ факт» почти не встречается в журналах генератора (в самом расчёте пара находится в 6 журналах из 1000), поэтому часть TST-32 «повторное сопоставление»
//        проходит вхолостую, а счётчик охвата t32_rematch считает каждый журнал; реалистичные ошибки сопоставителя (двойная пара, потеря статуса matched) инвариант не замечает.
//   D3 · подмена TST-36 «остаток обрезан сверху» краснеет исключением самой подмены (TypeError на режиме worse, которого нет в ответе со сценарием), а не нарушением инварианта.
//   D4 · на исходных (не обёрточных) мутациях ядра property-тесты и замок вывода слепы к части мутантов tax / fx / sinking: версия налогового правила, обратный курс, граница даты резерва.
// Браузер и сеть не нужны; в тестах допустимы node:*. Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENGINE_VERSION, analyze, canon, normalize_ws, match_plan_to_fact, assign_statuses } from '../engine/index.mjs';
import { plan_window_start, plan_occurrences, match_history } from '../engine/mc_inputs.mjs';
import { match_quantity } from '../engine/verifier.mjs';
import { parse_date, format_date } from '../engine/dates.mjs';
import { gen_case, case_seed, GEN_SEED } from './journal_gen.mjs';
import { INVARIANTS, REAL_FUNCTIONS as R, make_api, run_invariant, case_at, tst32, tst36, PROP_SEED } from './properties_lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.resolve(HERE, '..');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const LOCK = JSON.parse(fs.readFileSync(path.join(HERE, 'engine.lock.json'), 'utf8'));

// ── 1. замок вывода: независимый пересчёт и состав журналов ───────────────────────────────────────────────────────────────

test('FP-24 adv: замок вывода пересчитан своим путём (node:crypto, прямой gen_case + analyze) на выборке журналов: суммы вывода, журнала, inputs_hash и версия совпали; индексы 0…499 подряд', () => {
  assert.equal(LOCK.cases.length, 500);
  assert.deepEqual(LOCK.cases.map((c) => c.i), Array.from({ length: 500 }, (_, i) => i), 'индексы без пропусков и повторов');
  const idx = new Set([0, 1, 2, 3, 498, 499]);
  for (let i = 5; i < 500; i += 9) idx.add(i);
  for (const i of idx) {
    const c = gen_case(case_seed(GEN_SEED, i));
    const row = LOCK.cases[i];
    assert.equal(c.seed, row.seed, `j${i + 1}: seed`);
    assert.equal(c.events.length, row.events, `j${i + 1}: число записей`);
    assert.equal(sha(canon(c.events)), row.journal_sha256, `j${i + 1}: сумма журнала`);
    const out = analyze(c.ws, c.query);
    assert.equal(out.inputs_hash, row.inputs_hash, `j${i + 1}: inputs_hash`);
    assert.equal(out.engine_version, LOCK.engine_version);
    assert.equal(sha(canon(out)), row.sha256, `j${i + 1}: сумма вывода analyze`);
  }
  assert.equal(LOCK.engine_version, ENGINE_VERSION);
});

test('FP-24 adv: 500 журналов замка разнообразны — есть доллары и курс, поток часов, налоговый конверт, накопления, «неготовые» данные, вырожденные горизонты; без этого замок закреплял бы узкий срез расчёта', () => {
  const s = { usd: 0, stream: 0, tax: 0, sinking: 0, unready: 0, tiny: 0, no_buffer: 0 };
  for (let i = 0; i < 500; i++) {
    const c = gen_case(case_seed(GEN_SEED, i));
    if (c.flags.usd) s.usd += 1;
    if (c.flags.stream) s.stream += 1;
    if (c.flags.tax) s.tax += 1;
    if (c.flags.sinking) s.sinking += 1;
    if (!c.flags.ready) s.unready += 1;
    if (!c.flags.buffer) s.no_buffer += 1;
    if (c.horizon_days <= 3) s.tiny += 1;
  }
  assert.ok(s.usd >= 25 && s.stream >= 75 && s.tax >= 200 && s.sinking >= 150 && s.unready >= 15 && s.tiny >= 15 && s.no_buffer >= 5, JSON.stringify(s));
});

// ── 2. сквозной сценарий замка (REQ-172) на временной копии ───────────────────────────────────────────────────────────────

const COPY = ['engine', 'data', 'package.json', 'tools/make_engine_lock.mjs', 'tests/helpers.mjs', 'tests/journal_gen.mjs', 'tests/properties_lib.mjs', 'tests/properties.test.mjs',
  'tests/engine_lock.test.mjs', 'tests/engine.lock.json', 'tests/arith.lock.policy.json'];
function tmp_project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-fp24adv-'));
  for (const rel of COPY) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.cpSync(path.join(PROTO, rel), path.join(dir, rel), { recursive: true }); }
  return dir;
}
function node(dir, args, env = {}) {
  const e = { ...process.env, ...env };
  delete e.NODE_TEST_CONTEXT; // вложенный запуск: дочерний раннер должен писать обычную сводку
  return spawnSync(process.execPath, args, { cwd: dir, env: e, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
}
const LOCK_TESTS = ['--test', '--test-concurrency=1', '--test-name-pattern=вывод analyze каждого из 500 журналов|политика engine_lock: sha256 файла замка', 'tests/engine_lock.test.mjs'];
const red_names = (r) => {
  const out = r.stdout ?? '';
  const cut = out.indexOf('✖ failing tests');
  return (cut < 0 ? out : out.slice(0, cut)).split('\n').filter((l) => l.startsWith('✖ ')).map((l) => l.slice(2));
};

test('FP-24 adv: REQ-172 сквозной сценарий на копии — зелёная база; правка замка без записи политики, правка расчёта без повышения версии и повышение версии без перегенерации краснят тест; --write отказывает без версии и проходит с ней', () => {
  const dir = tmp_project();
  try {
    const lock_path = path.join(dir, 'tests', 'engine.lock.json');
    const pol_path = path.join(dir, 'tests', 'arith.lock.policy.json');
    const lock_text = fs.readFileSync(lock_path, 'utf8');
    // база
    const base = node(dir, LOCK_TESTS);
    assert.equal(base.status, 0, base.stdout.slice(-600) + base.stderr);
    assert.match(base.stdout, /ℹ pass 2/);
    // 1) правка одной суммы в замке без записи в политику
    fs.writeFileSync(lock_path, lock_text.replace(/("sha256": ")([0-9a-f])/, (m, a, b) => a + (b === '0' ? '1' : '0')));
    const tampered = node(dir, LOCK_TESTS);
    assert.notEqual(tampered.status, 0, 'правка замка краснит тест');
    assert.ok(red_names(tampered).some((n) => n.includes('политика engine_lock')), 'красна политика (сумма файла не равна записи): ' + red_names(tampered).join(' | ').slice(0, 300));
    assert.ok(red_names(tampered).some((n) => n.includes('вывод analyze')), 'красна и сверка вывода');
    fs.writeFileSync(lock_path, lock_text);
    // 2) правка расчёта (мутант S08: свободные деньги считают резервы со знаком плюс) без повышения ENGINE_VERSION
    const tl_path = path.join(dir, 'engine', 'sinking.mjs');
    const tl = fs.readFileSync(tl_path, 'utf8');
    const find = 'return trough.map((t, i) => assert_minor(t - reserve_trough[i]));';
    assert.equal(tl.split(find).length - 1, 1);
    fs.writeFileSync(tl_path, tl.replace(find, () => 'return trough.map((t, i) => assert_minor(t + reserve_trough[i]));'));
    const changed = node(dir, LOCK_TESTS);
    assert.notEqual(changed.status, 0, 'изменённый расчёт краснит замок');
    const refused = node(dir, ['tools/make_engine_lock.mjs', '--write']);
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stderr + refused.stdout, /ОТКАЗ/);
    assert.equal(fs.readFileSync(lock_path, 'utf8'), lock_text, 'отказ не меняет замок');
    assert.equal(JSON.parse(fs.readFileSync(pol_path, 'utf8')).engine_lock.history.length, 1, 'отказ не пишет в политику');
    fs.writeFileSync(tl_path, tl);
    // 3) повышение версии без перегенерации: вывод содержит engine_version, поэтому красно
    const ix_path = path.join(dir, 'engine', 'index.mjs');
    const ix = fs.readFileSync(ix_path, 'utf8');
    assert.equal(ix.split("export const ENGINE_VERSION = '0.1.0';").length - 1, 1);
    fs.writeFileSync(ix_path, ix.replace("export const ENGINE_VERSION = '0.1.0';", "export const ENGINE_VERSION = '0.1.1';"));
    const bumped = node(dir, LOCK_TESTS);
    assert.notEqual(bumped.status, 0, 'версия повышена, замок не перегенерирован — красно');
    // 4) перегенерация с повышенной версией: новая запись истории, тест зелёный
    const written = node(dir, ['tools/make_engine_lock.mjs', '--write']);
    assert.equal(written.status, 0, written.stdout + written.stderr);
    const pol = JSON.parse(fs.readFileSync(pol_path, 'utf8'));
    assert.deepEqual(pol.engine_lock.history.map((e) => e.engine_version), ['0.1.0', '0.1.1']);
    assert.equal(pol.history.length, 1, 'раздел арифметики не тронут');
    const green = node(dir, LOCK_TESTS);
    assert.equal(green.status, 0, green.stdout.slice(-600) + green.stderr);
    const check = node(dir, ['tools/make_engine_lock.mjs', '--check']);
    assert.equal(check.status, 0, check.stdout + check.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── 3. подмены property-тестов: красные ли по существу ────────────────────────────────────────────────────────────────────

const MUT_SRC = fs.readFileSync(path.join(HERE, 'properties_mutation.test.mjs'), 'utf8');
function load_mutations() {
  const a = MUT_SRC.indexOf('const MUTATIONS = ');
  const b = MUT_SRC.indexOf('\n};\n', a);
  assert.ok(a > 0 && b > a, 'таблица подмен найдена в properties_mutation.test.mjs');
  return new Function('R', 'parse_date', 'return (' + MUT_SRC.slice(a + 'const MUTATIONS = '.length, b + 2) + ')')(R, parse_date);
}
/** Подмены, добавленные исправлением D2 (2026-10-28): они проявляются только на журналах с парами «план ↔ факт». */
const D2_MUTATIONS = new Set(['match_plan_to_fact: пара попадает в результат дважды', 'assign_statuses: сопоставленный план теряет статус matched при повторном проходе']);
let REDS = null;
function first_reds() {
  if (REDS !== null) return REDS;
  const MUT = load_mutations();
  REDS = [];
  for (const inv of INVARIANTS) {
    for (const m of MUT[inv.id]) {
      const r = run_invariant(inv.check, make_api(m.over), { n: 300, stop_on_first: true });
      REDS.push({ id: inv.id, name: m.name, red: r.failed > 0, at: r.violations[0]?.i ?? null, msg: r.violations[0]?.messages[0] ?? null });
    }
  }
  return REDS;
}

test('FP-24 adv: все 26 подмен property-тестов краснеют (своя загрузка таблицы подмен); красных исключением самой подмены не больше одной (TST-36) — регрессия, если появится ещё', () => {
  const rows = first_reds().filter((r) => !D2_MUTATIONS.has(r.name)); // 26 исходных подмен; две подмены сопоставителя (исправление D2) — в тесте ниже
  assert.equal(rows.length, 26);
  assert.deepEqual(rows.filter((r) => !r.red).map((r) => r.name), [], 'подмены, которых инвариант не заметил');
  const crash_only = rows.filter((r) => r.msg.startsWith('исключение:'));
  assert.ok(crash_only.length <= 1 && crash_only.every((r) => r.id === 'TST-36'), JSON.stringify(crash_only.map((r) => [r.id, r.msg])));
});

// D3 исправлен 2026-10-28: подмена TST-36 обходит Object.keys(r.series); пометка todo снята, название прежнее
test('FP-24 adv [ДЕФЕКТ D3, todo]: ни одна подмена property-тестов не краснеет только потому, что упала сама подмена (исключение вместо нарушения инварианта)', () => {
  const crash_only = first_reds().filter((r) => r.msg.startsWith('исключение:'));
  assert.deepEqual(crash_only.map((r) => `${r.id}: ${r.name}`), []);
});

test('FP-24 adv: сам инвариант TST-36 чувствителен к обрезке ряда сверху — исправленная подмена (без падения) краснит большинство журналов нарушением «ряд целого ≠ сумма частей»', () => {
  const clip = (ws, q) => {
    const r = R.analyze(ws, q);
    for (const m of Object.keys(r.series)) { r.series[m].close = r.series[m].close.map((x) => Math.min(x, 100000)); r.series[m].trough = r.series[m].trough.map((x) => Math.min(x, 100000)); }
    return r;
  };
  const r = run_invariant(tst36, make_api({ analyze: clip }), { n: 100, keep: 100 });
  assert.ok(r.failed >= 50, 'красных журналов: ' + r.failed);
  assert.ok(r.violations.every((v) => !v.messages[0].startsWith('исключение:')), 'нарушения по существу, без исключений');
  assert.match(r.violations[0].messages[0], /ряд целого/);
});

// ── 4. сопоставление «план ↔ факт» в property-тестах ──────────────────────────────────────────────────────────────────────

test('FP-24 adv: на журналах с «зеркальными» фактами (факт = вхождение правила) сопоставитель настоящего движка находит пары, детерминирован, идемпотентен после снятия пар, assign_statuses идемпотентна; analyze не падает', () => {
  const stat = { logs: 0, mirrored: 0, pairs: 0, again: 0, status_bad: 0 };
  for (let i = 0; i < 300; i++) {
    const c = gen_case(case_seed(PROP_SEED, i)); // исходные журналы серии: case_at после исправления D2 уже содержит собственные зеркальные факты, и две копии зеркал спорили бы за один план
    const asof = parse_date(c.as_of);
    const from = plan_window_start(c.ws, c.as_of);
    const occ = plan_occurrences(c.ws, from, asof, { as_of: asof, anchor_cut: true }).filter((e) => e.date <= asof - 1 && e.amount_minor !== 0);
    const mirror = occ.filter((e, k) => k % 2 === 0).slice(0, 6);
    if (mirror.length === 0) continue;
    const facts2 = { ...c.ws.facts };
    mirror.forEach((e, k) => { facts2['mirror' + k] = { account_id: e.account_id, amount_minor: e.amount_minor, currency: e.currency ?? 'EUR', date: format_date(e.date), tag: e.tag ?? 'x', entity_id: 'mirror' + k, event_id: 'zm' + k }; });
    const ws2 = { ...c.ws, facts: facts2 };
    const ctx = analyze(ws2, c.query); // не должен падать
    const facts = normalize_ws(ws2).facts.filter((f) => f.date <= asof);
    const r1 = match_plan_to_fact(occ, facts, ctx.params);
    assert.equal(canon(match_plan_to_fact(occ, facts, ctx.params)), canon(r1), 'сопоставление детерминировано');
    stat.logs += 1;
    stat.mirrored += mirror.length;
    stat.pairs += r1.matches.length;
    const used_plan = new Set(r1.matches.map((m) => m.plan.occ_key ?? m.plan.cash_event_id));
    const used_fact = new Set(r1.matches.flatMap((m) => m.facts.map((f) => f.cash_event_id)));
    const r2 = match_plan_to_fact(occ.filter((p) => !used_plan.has(p.occ_key ?? p.cash_event_id)), facts.filter((f) => !used_fact.has(f.cash_event_id)), ctx.params);
    stat.again += r2.matches.length;
    const a1 = assign_statuses(occ, facts, asof, ctx.params);
    if (canon(assign_statuses(a1, facts, asof, ctx.params)) !== canon(a1)) stat.status_bad += 1;
  }
  assert.ok(stat.logs >= 80 && stat.mirrored >= 100, JSON.stringify(stat));
  assert.ok(stat.pairs >= 0.8 * stat.mirrored, 'почти каждый зеркальный факт нашёл свой план: ' + JSON.stringify(stat));
  assert.deepEqual([stat.again, stat.status_bad], [0, 0], JSON.stringify(stat));
});

// D2 исправлен 2026-10-28: журналы серии получают зеркальные факты (journal_gen.mjs · with_mirror_facts), шаг 6 в TST-32; пометка todo снята, название прежнее
test('FP-24 adv [ДЕФЕКТ D2, todo]: журналы property-тестов содержат сопоставимые пары «план ↔ факт» (не менее четверти журналов), иначе проверка «повторное сопоставление» TST-32 идёт вхолостую', () => {
  const N = 400;
  let with_pair = 0;
  for (let i = 0; i < N; i++) if (match_history(case_at(i).ws, case_at(i).as_of).n_pairs > 0) with_pair += 1;
  assert.ok(with_pair / N >= 0.25, `журналов с хотя бы одной парой: ${with_pair} из ${N}`);
});

// D2 исправлен 2026-10-28 (подмены «пара дважды» и «потеря matched» добавлены в properties_mutation.test.mjs); пометка todo снята, название прежнее
test('FP-24 adv [ДЕФЕКТ D2, todo]: реалистичные ошибки сопоставителя (пара в результате дважды; сопоставленный план теряет статус matched при повторном проходе) краснят TST-32', () => {
  const dup_pair = (plans, facts, params) => { const r = R.match_plan_to_fact(plans, facts, params); if (r.matches.length > 0) r.matches.push(r.matches[0]); return r; };
  const flip = (planned, facts, as_of, params) => R.assign_statuses(planned, facts, as_of, params).map((e, i) => (e.status === 'matched' && planned[i].status === 'matched' ? { ...e, status: 'expected' } : e));
  for (const [name, over] of [['пара дважды', { match_plan_to_fact: dup_pair }], ['потеря статуса matched', { assign_statuses: flip }]]) {
    const r = run_invariant(tst32, make_api(over), { n: 200 });
    assert.ok(r.failed > 0, `${name}: инвариант TST-32 не заметил ошибку ни на одном из ${r.checked} журналов`);
  }
});

// ── 5. мутант V07: брутфорс эквивалентности ───────────────────────────────────────────────────────────────────────────────

test('FP-24 adv: мутант V07 (знак суммы в match_quantity не сверяется) действительно эквивалентен — перебор 3 × 15 × 2 × 6001 случаев: ответ с проверкой знака и без неё совпадает; случаи с разными знаками и совпадения присутствуют', () => {
  const no_sign = (q, ev) => { // ветка money без строки со знаком
    if (q.word_sign === true) return false;
    if (ev.kind !== 'money' || q.cur !== ev.cur) return false;
    const exp = 2;
    if (q.dp > exp) return false;
    const scale = 10n ** BigInt(exp - q.dp);
    let m = BigInt(q.digits) * scale;
    if (q.neg) m = -m;
    const v = BigInt(ev.v);
    const diff = m > v ? m - v : v - m;
    return 2n * diff <= scale;
  };
  let n = 0;
  let diff_sign = 0;
  let matched = 0;
  for (const dp of [0, 1, 2]) {
    for (const digits of ['0', '1', '2', '3', '5', '9', '10', '11', '50', '99', '100', '101', '250', '1000', '12345']) {
      for (const neg of [false, true]) {
        for (let v = -3000; v <= 3000; v++) {
          const q = { kind: 'money', cur: 'EUR', dp, digits, neg, word_sign: false };
          const ev = { kind: 'money', cur: 'EUR', v };
          const a = match_quantity(q, ev);
          assert.equal(no_sign(q, ev), a, `dp=${dp} digits=${digits} neg=${neg} v=${v}`);
          n += 1;
          if (a) matched += 1;
          const m_neg = neg && digits !== '0';
          if (digits !== '0' && (m_neg !== (v < 0))) diff_sign += 1;
        }
      }
    }
  }
  assert.equal(n, 3 * 15 * 2 * 6001);
  assert.ok(matched > 200 && diff_sign > 20000, JSON.stringify({ matched, diff_sign }));
});

// ── 6. честность записи полного фаззинга ──────────────────────────────────────────────────────────────────────────────────

test('FP-24 adv: раздел full в _ops/fuzz-nightly.json согласован сам с собой — complete = все наборы зелёные и все циклы завершены; единственный незавершённый цикл — основная проверка областей; находка FZ-1 названа с итерацией', () => {
  const FUZZ = JSON.parse(fs.readFileSync(path.join(PROTO, '..', '_ops', 'fuzz-nightly.json'), 'utf8'));
  const f = FUZZ.full;
  assert.equal(f.mode, 'full');
  assert.deepEqual([f.fuzz_n, f.gp_seeds, f.limit_min], [100000, 1500, 60]);
  const unfinished = Object.entries(f.loops).filter(([, v]) => v.finished !== true).map(([k]) => k);
  for (const [k, v] of Object.entries(f.loops)) assert.equal(v.finished, v.done === v.of, k);
  assert.equal(f.complete, f.results.every((r) => r.ok) && unfinished.length === 0);
  assert.equal(f.ok, f.complete);
  assert.equal(f.exceptions, f.results.reduce((a, r) => a + r.fail, 0), 'exceptions — число упавших тестов');
  if (f.complete === false) {
    assert.deepEqual(unfinished, ['validate_ws:workspaces']);
    assert.deepEqual(f.findings.map((x) => x.id), ['FZ-1']);
    assert.ok(f.findings[0].iteration - f.loops['validate_ws:workspaces'].done < 500, 'ход записывается раз в of/200 = 500 шагов');
    assert.deepEqual(f.results.filter((r) => !r.ok).map((r) => r.suite), ['validate_ws']);
  }
  assert.equal(FUZZ.mode, 'short', 'поля короткого прогона прежние');
  assert.deepEqual([FUZZ.fuzz_n, FUZZ.gp_seeds], [2000, 200]);
});

// ── 7. слепые пятна на исходных мутациях ядра ─────────────────────────────────────────────────────────────────────────────

test('FP-24 adv (исправление 2026-10-28): всего 28 подмен — 26 исходных и две подмены сопоставителя D2; каждая краснеет по существу (нарушение инварианта), ни одна — исключением самой подмены', () => {
  const rows = first_reds();
  assert.equal(rows.length, 28);
  assert.deepEqual(rows.filter((r) => !r.red).map((r) => r.name), []);
  assert.deepEqual([...D2_MUTATIONS].filter((n) => !rows.some((r) => r.name === n && r.id === 'TST-32' && r.red)), [], 'обе подмены D2 краснят TST-32');
  assert.deepEqual(rows.filter((r) => r.msg.startsWith('исключение:')).map((r) => `${r.id}: ${r.name}`), []);
});

test('FP-24 adv [ДЕФЕКТ D4, todo]: на исходных мутациях ядра, не менявших вывод analyze на журналах генератора (X04 версия налогового правила, F04 обратный курс, S03 граница даты резерва), краснеют property-тесты или замок вывода', { todo: 'D4 (исправлен частично 2026-10-28: матрица сетей записана в _ops/mutation.json → engine.nets_summary, формулировки README смягчены; слепота замка и property-тестов к X04, F04 и S03 остаётся, потому что расширение gen_case меняет сумму журнала в engine.lock.json и требует повышения ENGINE_VERSION — вынесено отдельным пунктом): X04, F04 и S03 не замечают ни девять property-тестов (PROP_N=40), ни замок вывода (500 журналов), ни golden G-001 — их убивают только модульные тесты; всего из 66 мутантов property-тесты убивают 16, замок — 19, golden — 23, 34 мутанта не видит ни одна из трёх сетей. Генератор не порождает несколько версий налогового правила, обратные курсы, срок годности правила, превышение резерва' }, () => {
  const dir = tmp_project();
  try {
    const MU = fs.readFileSync(path.join(PROTO, 'tools', 'mutate.mjs'), 'utf8');
    const take = (id) => { // строка каталога мутанта -> {file, find, replace}
      const m = new RegExp(`\\{ id: '${id}', file: (\\w+), find: ("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'), replace: ("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`).exec(MU);
      assert.ok(m !== null, id);
      const file = { TX: 'engine/tax.mjs', FXM: 'engine/fx.mjs', SK: 'engine/sinking.mjs' }[m[1]];
      return { id, file, find: new Function('return ' + m[2])(), replace: new Function('return ' + m[3])() };
    };
    const blind = [];
    for (const id of ['X04', 'F04', 'S03']) {
      const m = take(id);
      const target = path.join(dir, m.file);
      const original = fs.readFileSync(target, 'utf8');
      assert.equal(original.split(m.find).length - 1, 1, id);
      fs.writeFileSync(target, original.replace(m.find, () => m.replace));
      try {
        const p = node(dir, ['--test', '--test-isolation=none', '--test-concurrency=1', '--test-name-pattern=TST-3[1-9] Свойство', 'tests/properties.test.mjs'], { PROP_N: '40' });
        const l = node(dir, LOCK_TESTS.slice(0, 2).concat(['--test-name-pattern=вывод analyze каждого из 500 журналов', 'tests/engine_lock.test.mjs']));
        if (p.status === 0 && l.status === 0) blind.push(id);
      } finally { fs.writeFileSync(target, original); }
    }
    assert.deepEqual(blind, [], 'мутанты, не замеченные property-тестами и замком');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
