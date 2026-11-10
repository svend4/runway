#!/usr/bin/env node
// make_engine_lock.mjs — FP-24, REQ-172, TST-52: замок ВЫВОДА движка. В отличие от tests/arith.lock.json (он закрепляет арифметику money, 574 случая), этот замок хранит
//   sha256(canon(analyze(ws, query)))
// для 500 журналов общего генератора tests/journal_gen.mjs (seed 2026): любое изменение расчёта — рядов, резервов, волн, предупреждений, inputs_hash — меняет хотя бы одну сумму.
// Рядом с суммой вывода записана сумма самого журнала (`journal_sha256`): она отличает «изменился генератор» от «изменился движок».
//
// Политика (REQ-172, ADR-014; файл tests/arith.lock.policy.json, раздел `engine_lock`): ЛЮБОЕ изменение tests/engine.lock.json сопровождается повышением ENGINE_VERSION —
// в `engine_lock.history` добавляется запись с новой суммой файла замка и БОЛЬШЕЙ версией. Проверяет tests/engine_lock.test.mjs. Инструмент сам эту политику соблюдает:
//   node tools/make_engine_lock.mjs --check     сверить файл замка с текущим движком и политикой (код выхода 1 при расхождении)
//   node tools/make_engine_lock.mjs --write     создать замок (первый раз) или перегенерировать его; перегенерация при изменённом выводе ОТКАЗЫВАЕТ, пока ENGINE_VERSION не повышена
//   node tools/make_engine_lock.mjs --print     только показать сводку (замок не читается и не пишется)
// Сбой расчёта на журнале (движок бросил исключение, например после порчи кода) не роняет инструмент стеком: `lock_case` возвращает запись с полем `failed`, `--check` перечисляет такие журналы
// среди расхождений («расчёт упал: код и причина»), `--write` отказывает с тем же перечнем и замок не пишет (FP-24, исправление после проверки).
// Часов и случайности нет: журналы строятся из seed. Инструмент вне engine/: node:* допустимы. Расчёт по введённым данным и правилам, не консультация.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { analyze, canon, ENGINE_VERSION } from '../engine/index.mjs';
import { gen_case, case_seed } from '../tests/journal_gen.mjs';

export const PROTO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LOCK_PATH = path.join(PROTO, 'tests', 'engine.lock.json');
export const POLICY_PATH = path.join(PROTO, 'tests', 'arith.lock.policy.json');
/** Seed серии замка (спецификация REQ-172) и число журналов. */
export const LOCK_SEED = 2026;
export const LOCK_COUNT = 500;
export const LOCK_FORMAT = 'engine.lock/1';

/** Контрольная сумма текста или байтов (node:crypto — независимо от чистой реализации sha256 движка). */
export const sha_hex = (x) => createHash('sha256').update(x).digest('hex');

/** Причина сбоя одной строкой: имя ошибки и сообщение (у `RunwayError` — код и контекст), без стека; длина ограничена. */
export function describe_failure(e) {
  const msg = String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 160);
  return e?.name === undefined || e.name === 'RunwayError' ? msg : `${e.name}: ${msg}`;
}

/** Сбой при построении замка (расчёт упал хотя бы на одном журнале): `failures` — записи `lock_case` с полем `failed`. */
export class LockBuildError extends Error {
  constructor(failures, count) {
    super(`расчёт упал на ${failures.length} из ${count} журналов: ` + failures.slice(0, 5).map((f) => `${f.id} (seed ${f.seed}): ${f.failed}`).join('; '));
    this.name = 'LockBuildError';
    this.failures = failures;
  }
}

/**
 * Один случай замка: журнал `i` серии → рабочая область → `analyze` → сумма канонического JSON результата.
 * Исключение при построении журнала или расчёте не выходит наружу: запись получает поле `failed` (код и причина) вместо сумм, и вызывающий решает, что с ней делать.
 * @param {number} i номер журнала (0…499)
 * @param {{analyze?: Function}} [over] подмена `analyze` (проверка чувствительности теста)
 * @returns {{id: string, i: number, seed: number, events: number, journal_sha256: string, inputs_hash: string, sha256: string} | {id: string, i: number, seed: number, failed: string}}
 */
export function lock_case(i, over = {}) {
  const id = 'j' + String(i + 1).padStart(4, '0');
  const seed = case_seed(LOCK_SEED, i);
  let c;
  try { c = gen_case(seed); } catch (e) { return { id, i, seed, failed: 'не удалось построить журнал: ' + describe_failure(e) }; }
  let out;
  try { out = (over.analyze ?? analyze)(c.ws, c.query); } catch (e) { return { id, i, seed, failed: describe_failure(e) }; }
  return {
    id, i, seed: c.seed, events: c.events.length,
    journal_sha256: sha_hex(canon(c.events)), inputs_hash: out.inputs_hash, sha256: sha_hex(canon(out)),
  };
}

/**
 * Замок целиком (из seed и текущего движка).
 * @throws {LockBuildError} расчёт упал хотя бы на одном журнале: замок из такого вывода не строится
 */
export function build_lock(count = LOCK_COUNT, over = {}) {
  const cases = [];
  for (let i = 0; i < count; i++) cases.push(lock_case(i, over));
  const failures = cases.filter((c) => c.failed !== undefined);
  if (failures.length > 0) throw new LockBuildError(failures, count);
  return {
    format: LOCK_FORMAT, seed: LOCK_SEED, count: cases.length, engine_version: ENGINE_VERSION,
    note: 'ENGINE-CHANGE: правка только вместе с повышением ENGINE_VERSION и записью в tests/arith.lock.policy.json (engine_lock.history); обновление: node tools/make_engine_lock.mjs --write',
    generator: 'tests/journal_gen.mjs: gen_case(case_seed(2026, i)); запрос {as_of}; sha256 = sha256(canon(analyze(ws, query)))',
    cases,
  };
}

/** Сериализация файла замка (формат как у arith.lock.json: отступ в один пробел, перевод строки в конце). */
export const lock_text = (lock) => JSON.stringify(lock, null, 1) + '\n';

/**
 * Сверить замок с текущим выводом: список расхождений (пустой — совпало).
 * @param {object} lock
 * @param {(i: number) => object} [compute] расчёт случая (по умолчанию `lock_case`)
 */
export function verify_lock(lock, compute = lock_case) {
  const diffs = [];
  for (const c of lock.cases) {
    const now = compute(c.i);
    if (now.failed !== undefined) { diffs.push(`${c.id} (seed ${c.seed}): расчёт упал: ${now.failed}`); continue; }
    if (now.seed !== c.seed || now.journal_sha256 !== c.journal_sha256) diffs.push(`${c.id}: журнал стал другим (генератор изменён): seed ${now.seed} ≠ ${c.seed} или сумма журнала не совпала`);
    else if (now.sha256 !== c.sha256) diffs.push(`${c.id} (seed ${c.seed}): вывод движка изменился: inputs_hash ${c.inputs_hash.slice(0, 8)}… → ${now.inputs_hash.slice(0, 8)}…, sha256 ${c.sha256.slice(0, 8)}… → ${now.sha256.slice(0, 8)}…`);
  }
  return diffs;
}

// ── политика версий ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const ver = (v) => v.split('.').map(Number);
/** Версия a строго больше b (мажор.минор.патч). */
export const greater = (a, b) => { const [x, y] = [ver(a), ver(b)]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
/** Версия a не ниже b. */
export const at_least = (a, b) => greater(a, b) || ver(a).join('.') === ver(b).join('.');

/**
 * Нарушения политики для данного файла замка (байты), версии движка и политики (раздел `engine_lock.history`).
 * @returns {string[]} пусто — политика выполнена
 */
export function policy_problems(lock_bytes, engine_version, policy) {
  const out = [];
  const h = policy?.engine_lock?.history;
  if (!Array.isArray(h) || h.length === 0) return ['история замка вывода пуста'];
  for (const e of h) if (!/^[0-9a-f]{64}$/.test(e.lock_sha256) || !/^\d+\.\d+\.\d+$/.test(e.engine_version)) out.push('запись истории с неверным хэшем или версией');
  if (new Set(h.map((e) => e.lock_sha256)).size !== h.length) out.push('повтор хэша замка в истории');
  for (let i = 1; i < h.length; i++) if (!greater(h[i].engine_version, h[i - 1].engine_version)) out.push(`запись ${i + 1}: версия ${h[i].engine_version} не выше предыдущей ${h[i - 1].engine_version} (замок менялся без повышения engine_version)`);
  const last = h.at(-1);
  if (sha_hex(lock_bytes) !== last.lock_sha256) out.push('engine.lock.json изменён без новой записи в arith.lock.policy.json (и без повышения ENGINE_VERSION)');
  if (!at_least(engine_version, last.engine_version)) out.push(`ENGINE_VERSION ${engine_version} ниже версии последней записи ${last.engine_version}`);
  return out;
}

// ── командная строка ────────────────────────────────────────────────────────────────────────────────────────────────────────

const read_policy = () => JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
const policy_text = (p) => JSON.stringify(p, null, 2) + '\n';

function cmd_check() {
  if (!fs.existsSync(LOCK_PATH)) { console.error('замка нет: node tools/make_engine_lock.mjs --write'); return 1; }
  const bytes = fs.readFileSync(LOCK_PATH);
  const lock = JSON.parse(bytes.toString('utf8'));
  const problems = [];
  if (lock.format !== LOCK_FORMAT || lock.seed !== LOCK_SEED || lock.count !== lock.cases.length || lock.count !== LOCK_COUNT) problems.push('заголовок замка: формат, seed или число случаев не совпали со спецификацией');
  problems.push(...verify_lock(lock));
  problems.push(...policy_problems(bytes, ENGINE_VERSION, read_policy()));
  for (const p of problems.slice(0, 20)) console.error('  ' + p);
  console.log(problems.length === 0 ? `замок вывода движка совпал: ${lock.count} журналов, ENGINE_VERSION ${ENGINE_VERSION}` : `расхождений: ${problems.length}`);
  return problems.length === 0 ? 0 : 1;
}

/**
 * Записать замок и запись политики. Правила (REQ-172): совпадает с последней записью истории — только восстановить файл; вывод изменился — нужна БОЛЬШАЯ версия, иначе отказ;
 * иначе файл замка пишется и в `engine_lock.history` добавляется запись. Пути и версия передаются аргументами (тест работает во временном каталоге).
 * @param {{lock: object, version?: string, lock_path?: string, policy_path?: string, note?: string}} o
 * @returns {{code: number, message: string, changed: boolean}}
 */
export function write_lock({ lock, version = ENGINE_VERSION, lock_path = LOCK_PATH, policy_path = POLICY_PATH, note }) {
  const text = lock_text(lock);
  const policy = JSON.parse(fs.readFileSync(policy_path, 'utf8'));
  const hist = policy.engine_lock?.history ?? [];
  const last = hist.at(-1);
  if (last !== undefined && last.lock_sha256 === sha_hex(text)) {
    // вывод движка тот же, что записан в политике: при необходимости восстановить файл (его могли править руками), запись в историю не нужна
    if (!fs.existsSync(lock_path) || fs.readFileSync(lock_path, 'utf8') !== text) {
      fs.writeFileSync(lock_path, text, 'utf8');
      return { code: 0, message: 'файл замка восстановлен по текущему выводу движка (он совпадает с записью политики)', changed: true };
    }
    return { code: 0, message: 'замок не изменился: перезапись не нужна', changed: false };
  }
  if (last !== undefined && !greater(version, last.engine_version)) {
    return { code: 1, message: `ОТКАЗ: вывод движка изменился, а ENGINE_VERSION (${version}) не выше версии последней записи замка (${last.engine_version}). Повысьте ENGINE_VERSION в engine/index.mjs и повторите (политика REQ-172).`, changed: false };
  }
  fs.writeFileSync(lock_path, text, 'utf8');
  policy.engine_lock = {
    rule: policy.engine_lock?.rule ?? 'Любое изменение tests/engine.lock.json сопровождается повышением ENGINE_VERSION (REQ-172, ADR-014): в history добавляется запись с новой суммой файла замка и БОЛЬШЕЙ версией движка. Проверяет tests/engine_lock.test.mjs; перегенерация — node tools/make_engine_lock.mjs --write.',
    history: [...hist, { lock_sha256: sha_hex(text), engine_version: version, cases: lock.count, note: note ?? 'замок вывода движка: sha256(canon(analyze(ws, query))) на 500 журналах, seed 2026 (FP-24, REQ-172)' }],
  };
  fs.writeFileSync(policy_path, policy_text(policy), 'utf8');
  return { code: 0, message: `записано: ${path.basename(lock_path)} (${lock.count} журналов, ENGINE_VERSION ${version}) и запись в ${path.basename(policy_path)}`, changed: true };
}

/** Построить замок или сообщить о сбое расчёта одной строкой «ОТКАЗ…» (без стека); `null` — замок не построен. */
function build_or_report() {
  try { return build_lock(); } catch (e) {
    if (!(e instanceof LockBuildError)) throw e;
    console.error('ОТКАЗ: ' + e.message + '. Замок не записан: исправьте расчёт (или откатите правку движка) и повторите.');
    return null;
  }
}

function cmd_write(note) {
  const lock = build_or_report();
  if (lock === null) return 1;
  const r = write_lock({ lock, note });
  (r.code === 0 ? console.log : console.error)(r.message);
  return r.code;
}

function main(argv) {
  const i = argv.indexOf('--note');
  const note = i >= 0 ? argv[i + 1] : undefined;
  if (argv.includes('--check')) return cmd_check();
  if (argv.includes('--write')) return cmd_write(note);
  if (argv.includes('--print')) {
    const lock = build_or_report();
    if (lock === null) return 1;
    console.log(`журналов ${lock.count}, первый: ${JSON.stringify(lock.cases[0])}, последний: ${JSON.stringify(lock.cases.at(-1))}, сумма файла ${sha_hex(lock_text(lock))}`);
    return 0;
  }
  console.error('нужен один из ключей: --check | --write | --print');
  return 2;
}

const is_main = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (is_main) process.exitCode = main(process.argv.slice(2));
