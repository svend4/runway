// worker_contract.test.mjs — FP-12, REQ-117 / REQ-150: расчёт в Worker. Контракт сообщений demo/calc_worker.mjs (handle_message) проверяется напрямую и через клиент
// demo/worker_client.mjs на ЗАГЛУШКЕ воркера (браузера и потоков нет): ответ воркера = ответ расчёта на месте, ошибки движка проходят как есть, сбои воркера (нет воркера, не запустился,
// упал, молчит, чужая версия, данные не копируются) дают откат на главный поток без потери результата и без цикла перезапусков. Плюс запись замера в _ops/bench.json.
// Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PROTO } from './sw_harness.mjs';
import { make_rng } from './helpers.mjs';

const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);
const W = await imp('demo', 'calc_worker.mjs');
const C = await imp('demo', 'worker_client.mjs');
const E = await imp('engine', 'index.mjs');
const load = (name) => JSON.parse(fs.readFileSync(path.join(PROTO, 'data', name), 'utf8'));
const G = load('g001.json');
const DATASETS = ['g001.json', 'g001-low.json', 'g001-gap.json', 'g001-late.json', 'g001-empty.json'].map((n) => [n, load(n)]);
const q_of = (ws) => ({ as_of: ws.as_of });
const json = (x) => JSON.stringify(x);

// ── контракт handle_message ──────────────────────────────────────────────────────────────────────────────────────────

test('REQ-117 контракт воркера: hello → протокол 1 и версия движка; analyze → тот же результат, что analyze на месте, побайтно, на всех наборах G-001; ответ можно скопировать (structuredClone)', () => {
  const hello = W.handle_message({ v: 1, id: 7, op: 'hello' });
  assert.deepEqual(hello, { v: 1, id: 7, ok: true, op: 'hello', engine_version: E.ENGINE_VERSION, result: { protocol: 1, engine_version: E.ENGINE_VERSION } });
  assert.deepEqual(Object.keys(hello), ['v', 'id', 'ok', 'op', 'engine_version', 'result'], 'порядок полей ответа стабилен');
  assert.equal(W.PROTOCOL, 1);
  assert.deepEqual([...W.OPS], ['hello', 'analyze']);
  for (const [name, ws] of DATASETS) {
    const r = W.handle_message({ v: 1, id: 1, op: 'analyze', ws, query: q_of(ws) });
    assert.equal(r.ok, true, name);
    assert.equal(r.id, 1);
    assert.equal(r.op, 'analyze');
    assert.equal(r.engine_version, E.ENGINE_VERSION);
    assert.equal(json(r.result), json(E.analyze(ws, q_of(ws))), name + ': воркер и расчёт на месте дают один и тот же результат');
    assert.equal(json(structuredClone(r)), json(r), name + ': ответ копируется без потерь');
    assert.equal(json(structuredClone({ v: 1, id: 1, op: 'analyze', ws, query: q_of(ws) })), json({ v: 1, id: 1, op: 'analyze', ws, query: q_of(ws) }), name + ': запрос копируется без потерь');
  }
  // числа канона доходят через воркер
  const g = W.handle_message({ v: 1, id: 2, op: 'analyze', ws: G, query: q_of(G) }).result;
  assert.equal(g.series.plan.opening_minor, 400000);
  assert.equal(g.series.plan.close.at(-1), 340000);
  assert.match(g.inputs_hash, /^[0-9a-f]{64}$/);
});

test('REQ-117 REQ-158 ошибки протокола и данных: ответ с E_SCHEMA и причиной, id возвращается, если он корректен; ошибки движка идут тем же кодом и контекстом, что при расчёте на месте; исключение не вылетает и текст не утекает', () => {
  const bad = (msg, reason, id = null) => {
    const r = W.handle_message(msg);
    assert.equal(r.ok, false, json(msg));
    assert.equal(r.error.code, 'E_SCHEMA');
    assert.equal(r.error.ctx.reason, reason, json(msg));
    assert.equal(r.id, id);
    assert.equal(r.v, 1);
    assert.equal(r.engine_version, E.ENGINE_VERSION);
    return r;
  };
  bad(null, 'not_an_object');
  bad('analyze', 'not_an_object');
  bad([1, 2], 'not_an_object');
  bad(42, 'not_an_object');
  bad({ id: 1, op: 'hello' }, 'bad_version', 1);
  bad({ v: 2, id: 1, op: 'hello' }, 'bad_version', 1);
  bad({ v: 1, op: 'hello' }, 'bad_id');
  for (const id of [-1, 1.5, '3', null, NaN, Infinity, 2 ** 60]) bad({ v: 1, id, op: 'hello' }, 'bad_id');
  bad({ v: 1, id: 5, op: 'rm -rf' }, 'unknown_op', 5);
  bad({ v: 1, id: 5 }, 'unknown_op', 5);
  bad({ v: 1, id: 5, op: 'constructor' }, 'unknown_op', 5);
  for (const ws of [null, 'ws', [], 7, undefined]) bad({ v: 1, id: 3, op: 'analyze', ws, query: { as_of: '2026-10-04' } }, 'bad_arguments', 3);
  for (const query of [null, 'q', [], undefined]) bad({ v: 1, id: 3, op: 'analyze', ws: G, query }, 'bad_arguments', 3);
  // ошибка движка: тот же код и контекст, что при вызове на месте
  const broken = { ...G, as_of: '2026-13-45' };
  let direct = null;
  try { E.analyze(broken, { as_of: broken.as_of }); } catch (e) { direct = e; }
  assert.ok(direct !== null && /^E_[A-Z_]+$/.test(direct.code));
  const r = W.handle_message({ v: 1, id: 9, op: 'analyze', ws: broken, query: { as_of: broken.as_of } });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, direct.code);
  assert.deepEqual(r.error.ctx, direct.ctx);
  assert.ok(E.ERROR_CODES.includes(r.error.code));
  // неожиданное исключение (не из движка): причина названа, текст исключения наружу не уходит
  const hostile = new Proxy({}, { get() { throw new TypeError('секретный-текст-исключения'); }, ownKeys() { throw new TypeError('секретный-текст-исключения'); }, has() { throw new TypeError('секретный-текст-исключения'); } });
  const u = W.handle_message({ v: 1, id: 11, op: 'analyze', ws: hostile, query: { as_of: '2026-10-04' } });
  assert.equal(u.ok, false);
  assert.equal(u.error.code, 'E_SCHEMA');
  assert.equal(u.error.ctx.reason, 'unexpected');
  assert.ok(!json(u).includes('секретный'));
  assert.equal(u.id, 11);
});

test('REQ-158 фаззинг протокола: 2000 случайных сообщений — handle_message всегда отвечает объектом протокола (ok true/false), не бросает исключений, ответ копируется', () => {
  const rng = make_rng(1203);
  const junk = () => rng.pick([null, undefined, 0, -1, 1.5, '', 'x', true, [], {}, { a: 1 }, [1, [2]], { v: 1 }, { v: 1, id: 1 }, 2 ** 53, Symbol.iterator.toString()]);
  let ok_count = 0;
  for (let i = 0; i < 2000; i++) {
    const msg = rng.bool() ? junk() : { v: rng.bool() ? 1 : junk(), id: rng.bool() ? rng.int(0, 99) : junk(), op: rng.pick(['hello', 'analyze', 'zzz', junk()]), ws: rng.bool() ? { ...G, as_of: rng.pick(['2026-10-04', junk()]) } : junk(), query: rng.bool() ? { as_of: rng.pick(['2026-10-04', junk()]) } : junk() };
    const r = W.handle_message(msg);
    assert.ok(r !== null && typeof r === 'object' && r.v === 1 && typeof r.ok === 'boolean', json(msg));
    if (r.ok) ok_count += 1; else { assert.equal(typeof r.error.code, 'string'); assert.ok(/^E_[A-Z_]+$/.test(r.error.code)); }
    structuredClone(r);
  }
  assert.ok(ok_count > 0, 'среди случайных сообщений встречаются и верные');
});

test('REQ-117 calc_worker.mjs как обычный модуль не имеет побочных эффектов: вне воркера (нет WorkerGlobalScope) обработчик сообщений не ставится', () => {
  assert.equal(typeof globalThis.WorkerGlobalScope, 'undefined');
  assert.equal(typeof globalThis.onmessage, 'undefined');
  const src = fs.readFileSync(path.join(PROTO, 'demo', 'calc_worker.mjs'), 'utf8');
  assert.match(src, /scope instanceof scope\.WorkerGlobalScope/);
  assert.ok(!/\bfetch\b|\blocalStorage\b|\bindexedDB\b|\bcaches\b|\bXMLHttpRequest\b|\bnavigator\b/.test(src.replace(/\/\/.*$/gm, '')), 'воркеру расчёта данные хранилища и сеть не нужны');
  const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports, ['../engine/index.mjs'], 'воркер берёт только движок');
});

// ── клиент на заглушке воркера ──────────────────────────────────────────────────────────────────────────────────────────

/** Заглушка воркера: обрабатывает сообщения настоящим `handle_message` через структурное клонирование; режим задаёт поведение. */
function fake_worker(mode = 'echo', box = {}) {
  const w = {
    terminated: false, received: [], onmessage: null, onerror: null, onmessageerror: null,
    postMessage(msg) {
      if (mode === 'clone_error' && json(msg).length > 0 && msg.ws?.__fn !== undefined) throw new DOMException('нельзя скопировать', 'DataCloneError');
      const copy = structuredClone(msg); // как браузер: запрос копируется; не копируется — исключение
      w.received.push(copy);
      const reply = () => structuredClone(W.handle_message(copy));
      const deliver = (data) => queueMicrotask(() => { if (!w.terminated) w.onmessage?.({ data }); });
      switch (mode) {
        case 'echo': case 'clone_error': deliver(reply()); break;
        case 'reorder': {
          (box.held ??= []).push(() => deliver(reply()));
          if (box.held.length === box.expect) for (const f of box.held.splice(0).reverse()) f();
          break;
        }
        case 'silent': break;
        case 'crash': queueMicrotask(() => w.onerror?.({ message: 'упал' })); break;
        case 'messageerror': queueMicrotask(() => w.onmessageerror?.({})); break;
        case 'garbage': {
          deliver(null); deliver('мусор'); deliver({ v: 2, id: copy.id, ok: true }); deliver({ v: 1, id: copy.id + 1000, ok: true, engine_version: E.ENGINE_VERSION, result: {} }); deliver({ v: 1, ready: true });
          deliver(reply()); deliver(reply()); // повторный ответ на тот же id игнорируется
          break;
        }
        case 'wrong_engine': { const r = reply(); r.engine_version = '9.9.9'; deliver(r); break; }
        case 'broken_reply': deliver({ v: 1, id: copy.id, engine_version: E.ENGINE_VERSION }); break; // ни ok, ни error
        case 'bad_result': deliver({ v: 1, id: copy.id, ok: true, op: 'analyze', engine_version: E.ENGINE_VERSION, ...box.reply_tail }); break; // ok: true, но result не объект расчёта
        default: throw new Error('режим ' + mode);
      }
    },
    terminate() { w.terminated = true; },
  };
  return w;
}
const fake_timers = () => { const t = { list: [], cleared: [] }; t.set_timeout = (fn, ms) => { t.list.push({ fn, ms }); return t.list.length; }; t.clear_timeout = (id) => t.cleared.push(id); return t; };
const client_with = (mode, extra = {}) => { const box = {}; const created = []; const timers = fake_timers(); const c = C.create_calc_client({ make_worker: () => { const w = fake_worker(mode, extra.box ?? box); created.push(w); return w; }, ...timers, ...extra.opts }); return { c, created, timers, box }; };

test('REQ-117 REQ-150 клиент: без воркера (Node, нет Worker) расчёт идёт на главном потоке, результат тот же, причина названа', async () => {
  const { c } = client_with('echo', { opts: { make_worker: () => null } });
  const r = await c.analyze(G, q_of(G));
  assert.equal(r.via, 'main');
  assert.equal(r.reason, 'no_worker');
  assert.equal(json(r.result), json(E.analyze(G, q_of(G))));
  assert.equal(c.stats().main_calls, 1);
  // настоящий клиент по умолчанию в Node: Worker недоступен
  assert.equal(typeof globalThis.Worker, 'undefined');
  const d = C.create_calc_client();
  const r2 = await d.analyze(G, q_of(G));
  assert.deepEqual([r2.via, r2.reason], ['main', 'no_worker']);
  const bad = C.create_calc_client({ make_worker: () => { throw new Error('CSP'); } });
  const r3 = await bad.analyze(G, q_of(G));
  assert.deepEqual([r3.via, r3.reason], ['main', 'worker_start_failed']);
  assert.equal(json(r3.result), json(r.result));
});

test('REQ-117 клиент: расчёт в воркере = расчёт на месте; запросы копируются, воркер создаётся один раз; замороженная рабочая область проходит; терминатор останавливает воркер', async () => {
  const { c, created } = client_with('echo');
  const frozen = structuredClone(G);
  const deep_freeze = (o) => { if (o !== null && typeof o === 'object') { Object.freeze(o); for (const v of Object.values(o)) deep_freeze(v); } return o; };
  deep_freeze(frozen);
  const r = await c.analyze(frozen, q_of(frozen));
  assert.equal(r.via, 'worker');
  assert.equal(r.reason, null);
  assert.equal(json(r.result), json(E.analyze(G, q_of(G))));
  for (const [, ws] of DATASETS) assert.equal(json((await c.analyze(ws, q_of(ws))).result), json(E.analyze(ws, q_of(ws))));
  assert.equal(created.length, 1, 'воркер один на клиента');
  assert.deepEqual(created[0].received.slice(0, 2).map((m) => [m.v, m.id, m.op]), [[1, 1, 'analyze'], [1, 2, 'analyze']], 'идентификаторы возрастают');
  assert.equal(c.stats().worker_calls, 1 + DATASETS.length);
  assert.equal(c.stats().pending, 0);
  c.terminate();
  assert.equal(created[0].terminated, true);
  const after = await c.analyze(G, q_of(G));
  assert.deepEqual([after.via, after.reason], ['main', 'terminated'], 'после остановки считаем на месте');
});

test('REQ-117 клиент: параллельные запросы получают каждый свой ответ при любом порядке ответов воркера', async () => {
  const box = { expect: 4 };
  const { c } = client_with('reorder', { box });
  const wss = [4, 9, 14, 21].map((buf) => ({ ...structuredClone(G), params: { ...structuredClone(G.params), buffer_minor: buf * 10000 } }));
  const got = await Promise.all(wss.map((ws) => c.analyze(ws, q_of(ws))));
  got.forEach((r, i) => {
    assert.equal(r.via, 'worker');
    assert.equal(json(r.result), json(E.analyze(wss[i], q_of(wss[i]))), 'ответ №' + i);
  });
  assert.equal(new Set(got.map((r) => r.result.inputs_hash)).size, 4, 'четыре разные рабочие области → четыре разных хэша входов');
});

test('REQ-158 клиент: ошибка движка в воркере — это RunwayError с тем же кодом и контекстом, что при расчёте на месте; воркер остаётся живым и считает дальше', async () => {
  const { c } = client_with('echo');
  const broken = { ...G, as_of: '2026-13-45' };
  let direct = null;
  try { E.analyze(broken, q_of(broken)); } catch (e) { direct = e; }
  await assert.rejects(() => c.analyze(broken, q_of(broken)), (e) => e instanceof E.RunwayError && e.code === direct.code && json(e.ctx) === json(direct.ctx));
  assert.equal(c.stats().dead, null, 'ошибка данных — не сбой воркера');
  assert.equal(c.stats().engine_errors, 1);
  const ok = await c.analyze(G, q_of(G));
  assert.equal(ok.via, 'worker');
  // и на главном потоке та же ошибка пробрасывается как есть
  const main = C.create_calc_client({ make_worker: () => null });
  await assert.rejects(() => main.analyze(broken, q_of(broken)), (e) => e instanceof E.RunwayError && e.code === direct.code);
});

test('REQ-117 REQ-150 откат на главный поток: воркер молчит (таймаут), падает (error, messageerror), присылает другую версию движка или ответ без ok — результат не теряется, воркер больше не используется', async () => {
  // молчит: сработал таймер ожидания
  const s = client_with('silent', { opts: { timeout_ms: 1234 } });
  const pending = s.c.analyze(G, q_of(G));
  await new Promise((r) => setImmediate(r));
  assert.equal(s.timers.list.length, 1);
  assert.equal(s.timers.list[0].ms, 1234);
  s.timers.list[0].fn();
  const r1 = await pending;
  assert.deepEqual([r1.via, r1.reason], ['main', 'timeout']);
  assert.equal(json(r1.result), json(E.analyze(G, q_of(G))));
  assert.equal(s.created[0].terminated, true);
  const r1b = await s.c.analyze(G, q_of(G));
  assert.deepEqual([r1b.via, r1b.reason], ['main', 'timeout'], 'мёртвый воркер не перезапускается');
  assert.equal(s.created.length, 1);

  for (const [mode, reason] of [['crash', 'worker_error'], ['messageerror', 'worker_error'], ['wrong_engine', 'version_mismatch'], ['broken_reply', 'worker_error']]) {
    const x = client_with(mode);
    const r = await x.c.analyze(G, q_of(G));
    assert.deepEqual([mode, r.via, r.reason], [mode, 'main', reason]);
    assert.equal(json(r.result), json(E.analyze(G, q_of(G))), mode);
    assert.equal(x.c.stats().dead, reason);
    assert.equal(x.created[0].terminated, true, mode + ': воркер остановлен');
    assert.equal(x.created.length, 1);
  }
  // несколько вызовов в полёте при падении воркера: все получают результат
  const y = client_with('crash');
  const many = await Promise.all([1, 2, 3].map(() => y.c.analyze(G, q_of(G))));
  assert.ok(many.every((r) => r.via === 'main' && json(r.result) === json(E.analyze(G, q_of(G)))));
});

test('REQ-117 исправление ADV-08 клиент: ответ ok:true без объекта result (поля нет, null, строка, число, массив) — сбой воркера, а не расчёт: откат на главный поток с настоящим результатом', async () => {
  for (const tail of [{}, { result: null }, { result: 'расчёт' }, { result: 42 }, { result: [1, 2] }, { result: true }]) {
    const x = client_with('bad_result', { box: { reply_tail: tail } });
    const r = await x.c.analyze(G, q_of(G));
    assert.deepEqual([r.via, r.reason], ['main', 'worker_error'], json(tail));
    assert.equal(json(r.result), json(E.analyze(G, q_of(G))), json(tail));
    assert.equal(x.c.stats().dead, 'worker_error');
    assert.equal(x.created[0].terminated, true);
  }
  // и обычный ответ воркера по-прежнему принимается
  const ok = await client_with('echo').c.analyze(G, q_of(G));
  assert.equal(ok.via, 'worker');
  assert.equal(typeof ok.result, 'object');
});

test('REQ-117 клиент: мусорные, повторные и чужие ответы игнорируются; данные, которые не копируются, дают откат ТОЛЬКО для этого вызова — воркер остаётся рабочим', async () => {
  const g = client_with('garbage');
  const r = await g.c.analyze(G, q_of(G));
  assert.equal(r.via, 'worker');
  assert.equal(json(r.result), json(E.analyze(G, q_of(G))));
  const r2 = await g.c.analyze(G, q_of(G));
  assert.equal(r2.via, 'worker', 'после мусора воркер жив');
  assert.equal(g.c.stats().pending, 0);

  const cl = client_with('clone_error');
  const poisoned = { ...structuredClone(G), __fn: () => 1 };
  const bad = await cl.c.analyze(poisoned, q_of(G));
  assert.deepEqual([bad.via, bad.reason], ['main', 'clone_failed']);
  assert.equal(cl.c.stats().dead, null, 'воркер не помечен мёртвым');
  const good = await cl.c.analyze(G, q_of(G));
  assert.equal(good.via, 'worker');
  assert.equal(cl.c.stats().pending, 0);
  assert.deepEqual(C.FALLBACK_REASONS.slice().sort(), ['clone_failed', 'no_worker', 'timeout', 'version_mismatch', 'worker_error', 'worker_start_failed'].sort());
});

test('REQ-117 worker_client: настоящий Worker создаётся модульным и рядом с модулем (new URL(…, import.meta.url), type module); без внешних адресов и хранилищ', () => {
  const src = fs.readFileSync(path.join(PROTO, 'demo', 'worker_client.mjs'), 'utf8');
  assert.match(src, /new globalThis\.Worker\(new URL\('calc_worker\.mjs', import\.meta\.url\), \{ type: 'module' \}\)/);
  assert.ok(!/https?:\/\//.test(src) && !/localStorage|indexedDB|caches/.test(src.replace(/\/\/.*$/gm, '')));
  // тот же файл воркера, что описан контрактом
  assert.ok(fs.existsSync(path.join(PROTO, 'demo', 'calc_worker.mjs')));
});

// ── замер: _ops/bench.json ───────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-150 TST-54 REQ-153 замер _ops/bench.json: формат, n и дата, p50 ≤ p95, блокировка при расчёте в воркере не больше блокировки в потоке; бюджеты из ADR-014 (p95 ≤ 100 мс, блокировка ≤ 50 мс, журнал ≤ 2 с) выполнены на той машине, где замер сделан', async () => {
  const file = path.join(PROTO, '..', '_ops', 'bench.json');
  assert.ok(fs.existsSync(file), '_ops/bench.json нет: node tools/bench.mjs --date ГГГГ-ММ-ДД');
  const b = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(b.format, 'runway-bench/1');
  assert.match(b.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(b.node, /^v\d+\./);
  assert.equal(b.engine_version, E.ENGINE_VERSION);
  assert.ok(b.recompute.n >= 30 && b.recompute.events >= 900 && b.recompute.events <= 1250, 'около 10³ событий: ' + b.recompute.events);
  for (const k of ['analyze', 'recompute_q3']) {
    const s = b.recompute[k];
    assert.ok(s.n >= 30 && s.p50_ms > 0 && s.p50_ms <= s.p95_ms && s.p95_ms <= s.max_ms && s.min_ms <= s.p50_ms, k);
  }
  assert.deepEqual(b.budget, { recompute_p95_ms: 100, blocking_ms: 50, journal_open_ms: 2000 });
  assert.ok(b.recompute.recompute_q3.p95_ms <= b.budget.recompute_p95_ms, 'p95 пересчёта + Q3: ' + b.recompute.recompute_q3.p95_ms);
  assert.ok(b.recompute.analyze.p95_ms <= b.budget.recompute_p95_ms);
  assert.ok(b.blocking.worker.max_ms <= b.budget.blocking_ms, 'блокировка в воркере: ' + b.blocking.worker.max_ms);
  assert.ok(b.blocking.runs >= 10);
  assert.ok(b.blocking.worker.max_ms <= b.blocking.in_thread.max_ms + 5, 'воркер блокирует не больше, чем расчёт в потоке');
  assert.deepEqual(Object.keys(b.within_budget), ['recompute_p95', 'blocking_worker', 'journal_open']);
  assert.equal(b.within_budget.recompute_p95 && b.within_budget.blocking_worker, true);
  if (b.journal !== null) {
    assert.equal(b.journal.n, 36500);
    assert.equal(b.journal.with_snapshot_ms.used_snapshot, true);
    assert.equal(b.journal.without_snapshot_ms.used_snapshot, false);
    assert.ok(b.journal.with_snapshot_ms.best <= b.budget.journal_open_ms, 'открытие журнала: ' + b.journal.with_snapshot_ms.best);
    assert.ok(Math.abs(b.journal.bytes_per_event - 250) / 250 <= 0.5, 'размер записи отличается от допущения 250 байт не более чем на 50 %: ' + b.journal.bytes_per_event);
  }
  // функции замера доступны для повторной проверки и не читают часы сами: дата — аргумент
  const BENCH = await imp('tools', 'bench.mjs');
  assert.equal(BENCH.is_iso_date('2026-10-09'), true);
  assert.equal(BENCH.is_iso_date('2026-13-09'), false);
  assert.equal(BENCH.is_iso_date(undefined), false);
  assert.equal(BENCH.percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(BENCH.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  const ws = BENCH.make_bench_ws(4);
  const a = E.analyze(ws, q_of(ws));
  assert.ok(a.events.plan.length >= 900 && a.events.plan.length <= 1250);
  assert.equal(a.readiness.score, 4);
});
