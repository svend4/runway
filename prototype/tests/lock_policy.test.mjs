// lock_policy.test.mjs — FP-12, REQ-172: политика «правка arith.lock ⇒ повышение ENGINE_VERSION». История замка лежит в tests/arith.lock.policy.json: у каждого изменения замка своя запись
// с sha256 файла и версией движка, версии строго растут. Тест красный, если замок изменён без новой записи, запись добавлена без повышения версии или ENGINE_VERSION ниже версии
// последней записи. Повышение ENGINE_VERSION БЕЗ правки замка допустимо (правило ADR-014 — «правка замка ⇒ повышение версии», а не обратное). Сам замок не меняется.
// Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { ENGINE_VERSION } = await import(pathToFileURL(path.join(HERE, '..', 'engine', 'index.mjs')).href);
const LOCK = fs.readFileSync(path.join(HERE, 'arith.lock.json'));
const POLICY = JSON.parse(fs.readFileSync(path.join(HERE, 'arith.lock.policy.json'), 'utf8'));
const sha = (b) => createHash('sha256').update(b).digest('hex');

const ver = (v) => v.split('.').map(Number);
/** Версия a строго больше b (мажор.минор.патч). */
const greater = (a, b) => { const [x, y] = [ver(a), ver(b)]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
/** Версия a не ниже b. */
const at_least = (a, b) => greater(a, b) || ver(a).join('.') === ver(b).join('.');

/** Нарушения политики для данного замка (байты), версии движка и истории. */
function problems_of(lock_bytes, engine_version, policy) {
  const out = [];
  const h = policy.history;
  if (!Array.isArray(h) || h.length === 0) return ['история пуста'];
  for (const e of h) if (!/^[0-9a-f]{64}$/.test(e.lock_sha256) || !/^\d+\.\d+\.\d+$/.test(e.engine_version)) out.push('запись истории с неверным хэшем или версией');
  if (new Set(h.map((e) => e.lock_sha256)).size !== h.length) out.push('повтор хэша замка в истории');
  for (let i = 1; i < h.length; i++) if (!greater(h[i].engine_version, h[i - 1].engine_version)) out.push(`запись ${i + 1}: версия ${h[i].engine_version} не выше предыдущей ${h[i - 1].engine_version} (замок менялся без повышения engine_version)`);
  const last = h.at(-1);
  if (sha(lock_bytes) !== last.lock_sha256) out.push('arith.lock.json изменён без новой записи в arith.lock.policy.json (и без повышения ENGINE_VERSION)');
  if (!at_least(engine_version, last.engine_version)) out.push(`ENGINE_VERSION ${engine_version} ниже версии последней записи ${last.engine_version}`);
  return out;
}

test('REQ-172 замок арифметики: sha256 arith.lock.json равен последней записи истории, ENGINE_VERSION не ниже версии этой записи; рабочее дерево согласовано с политикой', () => {
  assert.deepEqual(problems_of(LOCK, ENGINE_VERSION, POLICY), []);
  assert.equal(POLICY.format, 'arith.lock.policy/1');
  const lock = JSON.parse(LOCK.toString('utf8'));
  assert.equal(lock.format, 'arith.lock/1');
  assert.equal(POLICY.history.at(-1).cases, lock.count, 'число случаев в записи = число случаев в замке');
});

test('REQ-172 политика ловит нарушения: правка замка без записи, запись без повышения версии, повтор хэша, версия движка ниже записи, пустая история; повышение версии без правки замка допустимо', () => {
  // версии строятся от последней записи истории, а не от живого ENGINE_VERSION: обычный релиз движка (0.1.0 → 0.1.1) этот тест не ломает
  const base = POLICY;
  const V = base.history.at(-1).engine_version;
  const [major, minor, patch] = ver(V);
  const V_up = `${major}.${minor}.${patch + 1}`;
  const V_big = `${major + 1}.0.0`;
  const V_down = '0.0.0';
  assert.ok(greater(V, V_down) && greater(V_up, V) && greater(V_big, V_up));
  const edited = Buffer.concat([LOCK, Buffer.from(' ')]);
  assert.ok(problems_of(edited, V, base).some((p) => p.includes('изменён без новой записи')), 'замок правили, записи нет');
  const same_version = { ...base, history: [...base.history, { lock_sha256: sha(edited), engine_version: V, cases: 574 }] };
  assert.ok(problems_of(edited, V, same_version).some((p) => p.includes('не выше предыдущей')), 'запись есть, версия не повышена');
  const bumped = { ...base, history: [...base.history, { lock_sha256: sha(edited), engine_version: V_up, cases: 574 }] };
  assert.deepEqual(problems_of(edited, V_up, bumped), [], 'замок изменён, запись и версия повышены — политика выполнена');
  assert.ok(problems_of(edited, V, bumped).some((p) => p.includes('ENGINE_VERSION')), 'движок остался прежней версии, а запись о новой есть');
  const lower = { ...base, history: [...base.history, { lock_sha256: sha(edited), engine_version: V_down, cases: 574 }] };
  assert.ok(problems_of(edited, V_down, lower).some((p) => p.includes('не выше предыдущей')));
  const dup = { ...base, history: [...base.history, { ...base.history[0], engine_version: V_big }] };
  assert.ok(problems_of(LOCK, V_big, dup).some((p) => p.includes('повтор хэша')));
  assert.deepEqual(problems_of(LOCK, V, { history: [] }), ['история пуста']);
  // повышение версии движка без правки замка — обычный релиз движка: политика его не запрещает (дефект ADV-07)
  assert.deepEqual(problems_of(LOCK, V_up, base), [], 'версия выше записи, замок не менялся — нарушения нет');
  assert.deepEqual(problems_of(LOCK, V_big, base), []);
  assert.deepEqual(problems_of(LOCK, V, base), [], 'версия равна записи — нарушения нет');
  assert.ok(problems_of(LOCK, V_down, base).some((p) => p.includes('ENGINE_VERSION') && p.includes('ниже')), 'версия ниже записи — нарушение');
  assert.ok(at_least('0.1.0', '0.1.0') && at_least('0.2.0', '0.1.9') && !at_least('0.1.0', '0.1.1'));
  assert.ok(greater('0.10.0', '0.9.9') && greater('1.0.0', '0.99.99') && !greater('0.1.0', '0.1.0'));
});
