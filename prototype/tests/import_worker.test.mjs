// import_worker.test.mjs — FP-18, REQ-091: разбор CSV по профилю в Web Worker. Контракт сообщений demo/import_worker.mjs (handle_message, split_reply, join_parts)
// проверяется напрямую и через клиент demo/import_worker_client.mjs на ЗАГЛУШКЕ воркера (браузера и потоков здесь нет): ответ воркера побайтно равен parse_with_profile
// (по образцу проверки analyze в about.mjs), ошибки движка проходят как есть, сбои воркера (нет воркера, не запустился, упал, молчит, чужая версия, битые части ответа,
// данные не копируются) дают откат на главный поток без потери результата и без цикла перезапусков. Плюс связка с plan_csv_async/wiz_csv_run_async: тот же отчёт и план.
// Настоящий поток и замер блокировки — в import_worker_model.test.mjs. Расчёт по введённым данным и правилам, не консультация.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/import_worker.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PROTO } from './sw_harness.mjs';
import { make_rng } from './helpers.mjs';

const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);
const W = await imp('demo', 'import_worker.mjs');
const C = await imp('demo', 'import_worker_client.mjs');
const WC = await imp('demo', 'worker_client.mjs');
const M = await imp('demo', 'import_model.mjs');
const DA = await imp('demo', 'data_actions.mjs');
const IO = await imp('engine', 'io.mjs');
const E = await imp('engine', 'index.mjs');

const load = (name) => JSON.parse(fs.readFileSync(path.join(PROTO, 'data', name), 'utf8'));
const SETS = ['g001.json', 'g001-low.json', 'g001-gap.json', 'g001-late.json'].map((n) => [n, load(n)]);
const BANK_TEXT = fs.readFileSync(path.join(PROTO, 'tests', 'fixtures', 'import-152.csv'), 'utf8');
const BANK = { profile: M.BUILTIN_PROFILES['csv-generic'], text: BANK_TEXT, ctx: { account_id: 'acc_main', account_currency: 'EUR', as_of: '2026-10-04' } };
const json = (x) => JSON.stringify(x);
const enc = (s) => new TextEncoder().encode(s);

/** Выгрузка набора самим приложением и контекст разбора: вход для профиля runway-csv-1. */
const runway_case = (ws) => ({ profile: M.BUILTIN_PROFILES['runway-csv-1'], text: DA.export_csv_file(ws).text, ctx: { account_id: 'acc_main', account_currency: 'EUR', as_of: ws.as_of } });
const direct = (c) => IO.parse_with_profile(c.profile, c.text, c.ctx);

/** Файл банка на `n` строк (формат csv-generic) и одна заведомо плохая строка: кандидаты и отклонённые в нескольких частях ответа. */
function big_bank_case(n) {
  const rows = ['Date,Description,Amount,Currency'];
  for (let i = 0; i < n; i++) {
    const cents = (i % 997) + 1; // целые центы: дробь всегда из двух цифр
    rows.push(`2026-0${1 + (i % 9)}-${String(1 + (i % 28)).padStart(2, '0')},"Покупка №${i % 311}, ""x""",-${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')},EUR`);
  }
  rows.splice(Math.floor(n / 2), 0, '2026-02-30,Неверная дата,-1.00,EUR');
  return { profile: M.BUILTIN_PROFILES['csv-generic'], text: rows.join('\n') + '\n', ctx: BANK.ctx };
}

// ── контракт handle_message ──────────────────────────────────────────────────────────────────────────────────────────

test('REQ-091 FP-18 контракт воркера: hello → протокол 1 и версия движка; parse_csv → тот же результат, что parse_with_profile, побайтно: банковский файл на 152 строки и выгрузки четырёх наборов G-001; ответ копируется', () => {
  const hello = W.handle_message({ v: 1, id: 7, op: 'hello' });
  assert.deepEqual(hello, { v: 1, id: 7, ok: true, op: 'hello', engine_version: E.ENGINE_VERSION, result: { protocol: 1, engine_version: E.ENGINE_VERSION } });
  assert.deepEqual(Object.keys(hello), ['v', 'id', 'ok', 'op', 'engine_version', 'result'], 'порядок полей ответа стабилен');
  assert.equal(W.PROTOCOL, 1);
  assert.deepEqual([...W.OPS], ['hello', 'parse_csv']);
  const cases = [['банк-152', BANK], ...SETS.map(([n, ws]) => [n, runway_case(ws)])];
  for (const [name, c] of cases) {
    const req = { v: 1, id: 1, op: 'parse_csv', profile: c.profile, text: c.text, ctx: c.ctx };
    const r = W.handle_message(req);
    assert.equal(r.ok, true, name);
    assert.equal(r.id, 1);
    assert.equal(r.op, 'parse_csv');
    assert.equal(r.engine_version, E.ENGINE_VERSION);
    assert.deepEqual(Object.keys(r.result), ['candidates', 'rejects', 'rows_total'], 'тот же порядок полей, что у parse_with_profile');
    assert.equal(json(r.result), json(direct(c)), name + ': воркер и разбор на месте дают один и тот же результат');
    assert.equal(json(structuredClone(r)), json(r), name + ': ответ копируется без потерь');
    assert.equal(json(structuredClone(req)), json(req), name + ': запрос копируется без потерь');
  }
  // числа канона: суммы Runway-файла в минимальных единицах, а не в 100 раз больше
  const g = W.handle_message({ v: 1, id: 2, op: 'parse_csv', ...runway_case(SETS[0][1]) }).result;
  assert.equal(g.candidates.reduce((s, c) => s + c.amount_minor, 0), 192000);
  assert.equal(g.rejects.filter((x) => x.reason === 'filtered_out').length, 1, 'строка плана пропущена профилем');
});

test('REQ-091 REQ-158 FP-18 ошибки протокола и данных: ответ с E_SCHEMA и причиной, id возвращается, если он корректен; ошибки движка идут тем же кодом и контекстом, что при разборе на месте; текст исключения не утекает', () => {
  const bad = (msg, reason, id = null) => {
    const r = W.handle_message(msg);
    assert.equal(r.ok, false, json(msg));
    assert.equal(r.error.code, 'E_SCHEMA');
    assert.equal(r.error.ctx.reason, reason, json(msg));
    assert.equal(r.id, id);
    assert.equal(r.v, 1);
    assert.equal(r.engine_version, E.ENGINE_VERSION);
  };
  bad(null, 'not_an_object');
  bad('parse_csv', 'not_an_object');
  bad([1, 2], 'not_an_object');
  bad({ id: 1, op: 'hello' }, 'bad_version', 1);
  bad({ v: 2, id: 1, op: 'hello' }, 'bad_version', 1);
  bad({ v: 1, op: 'hello' }, 'bad_id');
  for (const id of [-1, 1.5, '3', null, NaN, Infinity, 2 ** 60]) bad({ v: 1, id, op: 'hello' }, 'bad_id');
  bad({ v: 1, id: 5, op: 'analyze' }, 'unknown_op', 5);
  bad({ v: 1, id: 5, op: 'constructor' }, 'unknown_op', 5);
  bad({ v: 1, id: 5 }, 'unknown_op', 5);
  const good = { v: 1, id: 3, op: 'parse_csv', profile: BANK.profile, text: BANK.text, ctx: BANK.ctx };
  for (const profile of [null, 'p', [], 7, undefined]) bad({ ...good, profile }, 'bad_arguments', 3);
  for (const text of [null, 5, {}, undefined, enc('x')]) bad({ ...good, text }, 'bad_arguments', 3);
  for (const ctx of [null, 'c', [], undefined, { account_id: 'a' }, { account_id: 1, account_currency: 'EUR', as_of: '2026-10-04' }, { account_id: 'a', account_currency: 'EUR' },
    { account_id: 'a', account_currency: 'EUR', as_of: 1.5 }, { account_id: 'a', account_currency: 5, as_of: '2026-10-04' }]) bad({ ...good, ctx }, 'bad_arguments', 3);
  // ошибки движка: тот же код и контекст
  const engine_error = (profile, text) => {
    let d = null;
    try { IO.parse_with_profile(profile, text, BANK.ctx); } catch (e) { d = e; }
    assert.ok(d !== null && /^E_[A-Z_]+$/.test(d.code));
    const r = W.handle_message({ ...good, profile, text });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, d.code);
    assert.deepEqual(r.error.ctx, d.ctx);
    assert.ok(E.ERROR_CODES.includes(r.error.code));
    return r;
  };
  engine_error({ ...BANK.profile, delimiter: 'x' }, BANK.text); // профиль вне схемы
  engine_error({ ...BANK.profile, date: { col: 'НетТакой', fmt: 'YYYY-MM-DD' } }, BANK.text); // неизвестная колонка
  engine_error(BANK.profile, 'Date,Description,Amount,Currency\n2026-09-01,"не закрыта,1,EUR\n'); // незакрытая кавычка
  engine_error(BANK.profile, ''); // нет строки заголовка
  const big = engine_error(BANK.profile, 'x'.repeat(IO.MAX_IMPORT_BYTES + 1)); // больше 5 МБ
  assert.equal(big.error.ctx.reason, 'file_too_large');
  // неожиданное исключение (не из движка)
  const hostile = new Proxy({}, { get() { throw new TypeError('секретный-текст-исключения'); }, ownKeys() { throw new TypeError('секретный-текст-исключения'); }, has() { throw new TypeError('секретный-текст-исключения'); } });
  const u = W.handle_message({ ...good, profile: hostile, id: 11 });
  assert.equal(u.ok, false);
  assert.equal(u.error.code, 'E_SCHEMA');
  assert.equal(u.error.ctx.reason, 'unexpected');
  assert.ok(!json(u).includes('секретный'));
  assert.equal(u.id, 11);
});

test('REQ-158 FP-18 фаззинг протокола: 2000 случайных сообщений — handle_message всегда отвечает объектом протокола, не бросает исключений, ответ копируется и режется на части без ошибок', () => {
  const rng = make_rng(1818);
  const junk = () => rng.pick([null, undefined, 0, -1, 1.5, '', 'x', true, [], {}, { a: 1 }, [1, [2]], { v: 1 }, { v: 1, id: 1 }, 2 ** 53, 'Date;;\n"']);
  let ok_count = 0;
  for (let i = 0; i < 2000; i++) {
    const msg = rng.bool() ? junk() : {
      v: rng.bool() ? 1 : junk(), id: rng.bool() ? rng.int(0, 99) : junk(), op: rng.pick(['hello', 'parse_csv', 'zzz', junk()]),
      profile: rng.bool() ? { ...BANK.profile, skip: rng.pick([0, 1, 99, junk()]) } : junk(), text: rng.bool() ? rng.pick([BANK.text, 'a,b\n1,2\n', '"', junk()]) : junk(),
      ctx: rng.bool() ? { ...BANK.ctx, as_of: rng.pick(['2026-10-04', '2026-13-45', junk()]) } : junk(),
    };
    const r = W.handle_message(msg);
    assert.ok(r !== null && typeof r === 'object' && r.v === 1 && typeof r.ok === 'boolean', json(msg));
    if (r.ok) ok_count += 1; else { assert.equal(typeof r.error.code, 'string'); assert.ok(/^E_[A-Z_]+$/.test(r.error.code)); }
    for (const part of W.split_reply(r, 5)) structuredClone(part);
  }
  assert.ok(ok_count > 0, 'среди случайных сообщений встречаются и верные');
});

// ── части ответа: split_reply / join_parts ──────────────────────────────────────────────────────────────────────────────

test('REQ-091 FP-18 split_reply и join_parts: малый ответ — одно сообщение как есть; большой — части по порядку и итог; сборка побайтно равна результату разбора при любом размере части', () => {
  const c = BANK;
  const reply = W.handle_message({ v: 1, id: 4, op: 'parse_csv', ...c });
  assert.equal(W.CHUNK_ROWS, 1000);
  assert.deepEqual(W.split_reply(reply), [reply], 'малый ответ не режется');
  assert.deepEqual(W.split_reply(reply, 152), [reply], 'ровно по границе — одно сообщение');
  const n_c = reply.result.candidates.length;
  const n_r = reply.result.rejects.length;
  assert.equal(n_c + n_r, 152);
  for (const chunk of [1, 2, 7, 50, 151]) {
    const msgs = W.split_reply(reply, chunk);
    const final = msgs.at(-1);
    const parts = msgs.slice(0, -1);
    assert.ok(parts.length >= 2, 'chunk=' + chunk);
    assert.ok(parts.every((p) => p.part !== undefined && p.items.length >= 1 && p.items.length <= chunk && p.ok === true && p.id === 4 && p.v === 1 && p.op === 'parse_csv' && p.engine_version === E.ENGINE_VERSION));
    assert.deepEqual(final.result.chunked, { candidates: Math.ceil(n_c / chunk), rejects: Math.ceil(n_r / chunk) });
    assert.equal(final.result.rows_total, reply.result.rows_total);
    assert.equal(final.part, undefined);
    // сначала кандидаты, потом отклонённые; номера частей идут с нуля внутри вида
    const kinds = parts.map((p) => p.part.kind);
    assert.deepEqual(kinds, [...kinds].sort(), 'candidates раньше rejects');
    assert.deepEqual(parts.filter((p) => p.part.kind === 'candidates').map((p) => p.part.index), [...Array(final.result.chunked.candidates).keys()]);
    // сообщения копируются, сборка — побайтно
    const joined = W.join_parts(parts.map((p) => structuredClone(p)), structuredClone(final));
    assert.equal(json(joined), json(reply.result), 'chunk=' + chunk);
    assert.deepEqual(Object.keys(joined), ['candidates', 'rejects', 'rows_total']);
  }
  // не parse_csv и не успех — одно сообщение
  const hello = W.handle_message({ v: 1, id: 1, op: 'hello' });
  assert.deepEqual(W.split_reply(hello, 1), [hello]);
  const err = W.handle_message({ v: 1, id: 1, op: 'parse_csv', profile: {}, text: '', ctx: c.ctx });
  assert.equal(err.ok, false);
  assert.deepEqual(W.split_reply(err, 1), [err]);
  assert.deepEqual(W.split_reply(null, 1), [null]);
  // пустой разбор (нет ни кандидатов, ни отклонённых): одно сообщение
  const empty = W.handle_message({ v: 1, id: 2, op: 'parse_csv', ...c, text: 'Date,Description,Amount,Currency\n' });
  assert.deepEqual(empty.result, { candidates: [], rejects: [], rows_total: 0 });
  assert.deepEqual(W.split_reply(empty, 1), [empty]);
  // только отклонённые строки
  const rej = W.handle_message({ v: 1, id: 3, op: 'parse_csv', ...c, text: 'Date,Description,Amount,Currency\nплохо,x,1,EUR\nплохо,y,2,EUR\nплохо,z,3,EUR\n' });
  assert.equal(rej.result.candidates.length, 0);
  const rparts = W.split_reply(rej, 2);
  assert.equal(rparts.length, 3);
  assert.equal(json(W.join_parts(rparts.slice(0, -1), rparts.at(-1))), json(rej.result));
});

test('REQ-091 FP-18 join_parts отвергает нарушенный порядок, счёт, вид и форму частей: клиент считает это сбоем воркера', () => {
  const reply = W.handle_message({ v: 1, id: 4, op: 'parse_csv', ...BANK });
  const msgs = W.split_reply(reply, 40);
  const parts = msgs.slice(0, -1);
  const final = msgs.at(-1);
  assert.notEqual(W.join_parts(parts, final), null);
  const tweak = (fn) => { const ps = structuredClone(parts); const f = structuredClone(final); fn(ps, f); return W.join_parts(ps, f); };
  assert.equal(tweak((ps) => ps.splice(1, 1)), null, 'потеряна часть');
  assert.equal(tweak((ps) => { [ps[0], ps[1]] = [ps[1], ps[0]]; }), null, 'части не по порядку');
  assert.equal(tweak((ps) => ps.push(structuredClone(ps[0]))), null, 'лишняя повторная часть');
  assert.equal(tweak((ps) => { ps.push(structuredClone(ps.at(-1))); ps.at(-1).part.index += 1; }), null, 'лишняя часть сверх объявленного');
  assert.equal(tweak((ps) => { ps[0].part.kind = 'rejects'; }), null, 'вид части не тот');
  assert.equal(tweak((ps) => { ps[0].part.kind = 'сторонний'; }), null);
  assert.equal(tweak((ps) => { ps[0].items = 'не массив'; }), null);
  assert.equal(tweak((ps) => { delete ps[0].part; }), null);
  assert.equal(tweak((ps, f) => { f.result.chunked.candidates += 1; }), null, 'объявлено больше, чем пришло');
  assert.equal(tweak((ps, f) => { f.result.chunked.rejects = 'x'; }), null);
  assert.equal(tweak((ps, f) => { f.result.rows_total = 1.5; }), null);
  assert.equal(tweak((ps, f) => { delete f.result.chunked; }), null);
  // сначала rejects, потом candidates — тоже нарушение
  const rej_first = [...parts.filter((p) => p.part.kind === 'rejects'), ...parts.filter((p) => p.part.kind === 'candidates')];
  assert.equal(W.join_parts(rej_first, final), null);
  assert.equal(W.join_parts([], final), null);
  assert.equal(W.join_parts(parts, null), null);
});

test('REQ-091 FP-18 import_worker.mjs как обычный модуль не имеет побочных эффектов: вне воркера (нет WorkerGlobalScope) обработчик сообщений не ставится; воркеру нужен только движок', () => {
  assert.equal(typeof globalThis.WorkerGlobalScope, 'undefined');
  assert.equal(typeof globalThis.onmessage, 'undefined');
  const src = fs.readFileSync(path.join(PROTO, 'demo', 'import_worker.mjs'), 'utf8');
  assert.match(src, /scope instanceof scope\.WorkerGlobalScope/);
  const code = src.replace(/\/\/.*$/gm, '');
  assert.ok(!/\bfetch\b|\blocalStorage\b|\bindexedDB\b|\bcaches\b|\bXMLHttpRequest\b|\bnavigator\b|\bimportScripts\b|\bnew Worker\b/.test(code), 'воркеру разбора данные хранилища и сеть не нужны');
  assert.deepEqual([...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]), ['../engine/io.mjs', '../engine/index.mjs'], 'воркер берёт только движок');
});

// ── клиент на заглушке воркера ──────────────────────────────────────────────────────────────────────────────────────────

/** Заглушка воркера: обрабатывает сообщения настоящим `handle_message` и режет ответ настоящим `split_reply`; режим задаёт поведение. */
function fake_worker(mode = 'echo', box = {}) {
  const w = {
    terminated: false, received: [], onmessage: null, onerror: null, onmessageerror: null,
    postMessage(msg) {
      if (mode === 'clone_error' && typeof msg.ctx?.__fn === 'function') throw new DOMException('нельзя скопировать', 'DataCloneError');
      const copy = structuredClone(msg); // как браузер: запрос копируется
      w.received.push(copy);
      const replies = () => W.split_reply(W.handle_message(copy), box.chunk).map((m) => structuredClone(m));
      const deliver = (data) => queueMicrotask(() => { if (!w.terminated) w.onmessage?.({ data }); });
      switch (mode) {
        case 'echo': case 'clone_error': for (const m of replies()) deliver(m); break;
        case 'reorder': {
          (box.held ??= []).push(() => { for (const m of replies()) deliver(m); });
          if (box.held.length === box.expect) for (const f of box.held.splice(0).reverse()) f();
          break;
        }
        case 'silent': break;
        case 'half': { const ms = replies(); for (const m of ms.slice(0, -1)) deliver(m); break; } // присылает части, итога нет: ждём таймер
        case 'crash': queueMicrotask(() => w.onerror?.({ message: 'упал' })); break;
        case 'messageerror': queueMicrotask(() => w.onmessageerror?.({})); break;
        case 'garbage': {
          deliver(null); deliver('мусор'); deliver({ v: 2, id: copy.id, ok: true }); deliver({ v: 1, id: copy.id + 1000, ok: true, engine_version: E.ENGINE_VERSION, result: {} }); deliver({ v: 1, ready: true });
          for (const m of replies()) deliver(m);
          for (const m of replies()) deliver(m); // повторный ответ на тот же id игнорируется
          break;
        }
        case 'wrong_engine': { for (const m of replies()) { m.engine_version = '9.9.9'; deliver(m); } break; }
        case 'broken_reply': deliver({ v: 1, id: copy.id, engine_version: E.ENGINE_VERSION }); break; // ни ok, ни error
        case 'bad_result': deliver({ v: 1, id: copy.id, ok: true, op: 'parse_csv', engine_version: E.ENGINE_VERSION, ...box.reply_tail }); break;
        case 'lost_part': { const ms = replies(); ms.splice(1, 1); for (const m of ms) deliver(m); break; } // потеряна часть ответа
        default: throw new Error('режим ' + mode);
      }
    },
    terminate() { w.terminated = true; },
  };
  return w;
}
const fake_timers = () => { const t = { list: [], cleared: [] }; t.set_timeout = (fn, ms) => { t.list.push({ fn, ms }); return t.list.length; }; t.clear_timeout = (id) => t.cleared.push(id); return t; };
const client_with = (mode, extra = {}) => {
  const box = extra.box ?? {};
  const created = [];
  const timers = fake_timers();
  const c = C.create_import_client({ make_worker: () => { const w = fake_worker(mode, box); created.push(w); return w; }, ...timers, ...extra.opts });
  return { c, created, timers, box };
};
const call = (c, x) => c.parse_csv(x.profile, x.text, x.ctx);

test('REQ-091 FP-18 клиент: без воркера (Node, нет Worker) разбор идёт на главном потоке, результат тот же, причина названа', async () => {
  const { c } = client_with('echo', { opts: { make_worker: () => null } });
  const r = await call(c, BANK);
  assert.equal(r.via, 'main');
  assert.equal(r.reason, 'no_worker');
  assert.equal(json(r.result), json(direct(BANK)));
  assert.equal(c.stats().main_calls, 1);
  assert.equal(typeof globalThis.Worker, 'undefined');
  const d = C.create_import_client();
  const r2 = await call(d, BANK);
  assert.deepEqual([r2.via, r2.reason], ['main', 'no_worker']);
  const bad = C.create_import_client({ make_worker: () => { throw new Error('CSP'); } });
  const r3 = await call(bad, BANK);
  assert.deepEqual([r3.via, r3.reason], ['main', 'worker_start_failed']);
  assert.equal(json(r3.result), json(r.result));
});

test('REQ-091 FP-18 клиент: разбор в воркере = разбор на месте, побайтно; запрос имеет ровно поля протокола; воркер создаётся один раз; терминатор останавливает воркер', async () => {
  const { c, created } = client_with('echo');
  for (const x of [BANK, ...SETS.map(([, ws]) => runway_case(ws))]) {
    const r = await call(c, x);
    assert.equal(r.via, 'worker');
    assert.equal(r.reason, null);
    assert.equal(json(r.result), json(direct(x)));
  }
  assert.equal(created.length, 1, 'воркер один на клиента');
  const req = created[0].received[0];
  assert.deepEqual(Object.keys(req), ['v', 'id', 'op', 'profile', 'text', 'ctx']);
  assert.deepEqual([req.v, req.id, req.op], [1, 1, 'parse_csv']);
  assert.deepEqual(created[0].received.map((m) => m.id), [1, 2, 3, 4, 5], 'идентификаторы возрастают');
  assert.equal(req.text, BANK.text);
  assert.deepEqual(req.ctx, BANK.ctx);
  assert.equal(c.stats().worker_calls, 5);
  assert.equal(c.stats().pending, 0);
  c.terminate();
  assert.equal(created[0].terminated, true);
  const after = await call(c, BANK);
  assert.deepEqual([after.via, after.reason], ['main', 'terminated'], 'после остановки разбираем на месте');
});

test('REQ-091 FP-18 клиент: большой результат приходит частями (CHUNK_ROWS = 1000) и собирается в тот же JSON; таймер ожидания продлевается с каждой частью', async () => {
  const big = big_bank_case(9500);
  const expected = direct(big);
  assert.equal(expected.candidates.length, 9500);
  assert.equal(expected.rejects.length, 1);
  const { c, timers, created } = client_with('echo', { opts: { timeout_ms: 5000 } });
  const r = await call(c, big);
  assert.equal(r.via, 'worker');
  assert.equal(json(r.result), json(expected), 'побайтно равно parse_with_profile');
  // 10 частей кандидатов (9500 строк по 1000) + 1 часть отклонённых + итог = 12 сообщений; таймер взводился на запрос и после каждой части
  assert.equal(timers.list.length, 1 + 11);
  assert.equal(timers.cleared.length, timers.list.length, 'ни один таймер не остался взведённым');
  assert.equal(timers.list[0].ms, 5000 + C.PER_KB_MS * Math.ceil(big.text.length / 1024), 'ожидание растёт с размером файла');
  assert.equal(created.length, 1);
  // и с небольшой частью, и в параллельных запросах
  const { c: c2 } = client_with('echo', { box: { chunk: 100 } });
  const [a, b] = await Promise.all([call(c2, big), call(c2, BANK)]);
  assert.equal(json(a.result), json(expected));
  assert.equal(json(b.result), json(direct(BANK)));
});

test('REQ-091 FP-18 клиент: параллельные запросы получают каждый свой ответ при любом порядке ответов воркера', async () => {
  const box = { expect: 4, chunk: 30 };
  const { c } = client_with('reorder', { box });
  const xs = [BANK, runway_case(SETS[0][1]), runway_case(SETS[1][1]), runway_case(SETS[3][1])];
  const got = await Promise.all(xs.map((x) => call(c, x)));
  got.forEach((r, i) => {
    assert.equal(r.via, 'worker');
    assert.equal(json(r.result), json(direct(xs[i])), 'ответ №' + i);
  });
});

test('REQ-091 REQ-158 FP-18 клиент: ошибка движка в воркере — RunwayError с тем же кодом и контекстом, что при разборе на месте; воркер остаётся живым', async () => {
  const { c } = client_with('echo');
  const broken = { ...BANK, profile: { ...BANK.profile, date: { col: 'НетТакой', fmt: 'YYYY-MM-DD' } } };
  let d = null;
  try { direct(broken); } catch (e) { d = e; }
  await assert.rejects(() => call(c, broken), (e) => e instanceof E.RunwayError && e.code === d.code && json(e.ctx) === json(d.ctx));
  assert.equal(c.stats().dead, null, 'ошибка данных — не сбой воркера');
  assert.equal(c.stats().engine_errors, 1);
  assert.equal((await call(c, BANK)).via, 'worker');
  // на главном потоке та же ошибка пробрасывается как есть
  const main = C.create_import_client({ make_worker: () => null });
  await assert.rejects(() => call(main, broken), (e) => e instanceof E.RunwayError && e.code === d.code && json(e.ctx) === json(d.ctx));
});

test('REQ-091 FP-18 откат на главный поток: воркер молчит (таймаут), падает (error, messageerror), присылает другую версию движка, ответ без ok, битые части — результат не теряется, воркер больше не используется', async () => {
  const s = client_with('silent', { opts: { timeout_ms: 1234 } });
  const pending = call(s.c, BANK);
  await new Promise((r) => setImmediate(r));
  assert.equal(s.timers.list.length, 1);
  s.timers.list[0].fn();
  const r1 = await pending;
  assert.deepEqual([r1.via, r1.reason], ['main', 'timeout']);
  assert.equal(json(r1.result), json(direct(BANK)));
  assert.equal(s.created[0].terminated, true);
  const r1b = await call(s.c, BANK);
  assert.deepEqual([r1b.via, r1b.reason], ['main', 'timeout'], 'мёртвый воркер не перезапускается');
  assert.equal(s.created.length, 1);

  // части пришли, итога нет: таймер, взведённый после последней части, срабатывает
  const h = client_with('half', { box: { chunk: 30 }, opts: { timeout_ms: 99 } });
  const hp = call(h.c, BANK);
  await new Promise((r) => setImmediate(r));
  assert.ok(h.timers.list.length > 1, 'каждая часть взводит таймер заново');
  h.timers.list.at(-1).fn();
  const rh = await hp;
  assert.deepEqual([rh.via, rh.reason], ['main', 'timeout']);
  assert.equal(json(rh.result), json(direct(BANK)));

  for (const [mode, reason, chunk] of [['crash', 'worker_error'], ['messageerror', 'worker_error'], ['wrong_engine', 'version_mismatch'], ['wrong_engine', 'version_mismatch', 30],
    ['broken_reply', 'worker_error'], ['lost_part', 'worker_error', 30]]) {
    const x = client_with(mode, { box: { chunk } });
    const r = await call(x.c, BANK);
    assert.deepEqual([mode, r.via, r.reason], [mode, 'main', reason]);
    assert.equal(json(r.result), json(direct(BANK)), mode);
    assert.equal(x.c.stats().dead, reason);
    assert.equal(x.created[0].terminated, true, mode + ': воркер остановлен');
    assert.equal(x.created.length, 1);
  }
  // несколько вызовов в полёте при падении воркера: все получают результат
  const y = client_with('crash');
  const many = await Promise.all([1, 2, 3].map(() => call(y.c, BANK)));
  assert.ok(many.every((r) => r.via === 'main' && json(r.result) === json(direct(BANK))));
});

test('REQ-091 FP-18 клиент: ответ ok:true без объекта result нужной формы (нет поля, null, строка, массив, без кандидатов, rows_total не число) — сбой воркера, а не разбор: откат с настоящим результатом', async () => {
  const shapes = [{}, { result: null }, { result: 'разбор' }, { result: 42 }, { result: [1, 2] }, { result: true }, { result: {} },
    { result: { candidates: [], rejects: [] } }, { result: { candidates: 'x', rejects: [], rows_total: 0 } }, { result: { candidates: [], rejects: [], rows_total: 1.5 } }];
  for (const tail of shapes) {
    const x = client_with('bad_result', { box: { reply_tail: tail } });
    const r = await call(x.c, BANK);
    assert.deepEqual([r.via, r.reason], ['main', 'worker_error'], json(tail));
    assert.equal(json(r.result), json(direct(BANK)), json(tail));
    assert.equal(x.c.stats().dead, 'worker_error');
    assert.equal(x.created[0].terminated, true);
  }
  const ok = await call(client_with('echo').c, BANK);
  assert.equal(ok.via, 'worker');
});

test('REQ-091 FP-18 клиент: мусорные, повторные и чужие ответы игнорируются; данные, которые не копируются, дают откат ТОЛЬКО для этого вызова — воркер остаётся рабочим', async () => {
  const g = client_with('garbage');
  const r = await call(g.c, BANK);
  assert.equal(r.via, 'worker');
  assert.equal(json(r.result), json(direct(BANK)));
  assert.equal((await call(g.c, BANK)).via, 'worker', 'после мусора воркер жив');
  assert.equal(g.c.stats().pending, 0);

  const cl = client_with('clone_error');
  const poisoned = { ...BANK, ctx: { ...BANK.ctx, __fn: () => 1 } }; // лишнее поле контекста движок не читает, а копированию мешает
  const bad = await call(cl.c, poisoned);
  assert.deepEqual([bad.via, bad.reason], ['main', 'clone_failed']);
  assert.equal(cl.c.stats().dead, null, 'воркер не помечен мёртвым');
  assert.equal((await call(cl.c, BANK)).via, 'worker');
  assert.equal(cl.c.stats().pending, 0);
  assert.deepEqual(C.FALLBACK_REASONS.slice().sort(), ['clone_failed', 'no_worker', 'terminated', 'timeout', 'version_mismatch', 'worker_error', 'worker_start_failed'].sort());
});

test('REQ-091 FP-18 make_import_worker: воркер модульный, рядом с модулем (new URL(…, import.meta.url), type module); без Worker — null; воркеры создаёт только worker_client.mjs', () => {
  assert.equal(typeof globalThis.Worker, 'undefined');
  assert.equal(WC.make_import_worker(), null);
  const src = fs.readFileSync(path.join(PROTO, 'demo', 'worker_client.mjs'), 'utf8');
  assert.match(src, /new globalThis\.Worker\(new URL\('import_worker\.mjs', import\.meta\.url\), \{ type: 'module' \}\)/);
  assert.ok(fs.existsSync(path.join(PROTO, 'demo', 'import_worker.mjs')));
  const made = [];
  globalThis.Worker = class { constructor(url, opts) { made.push([String(url), opts]); } };
  try {
    const w = WC.make_import_worker();
    assert.ok(w !== null);
    assert.equal(made.length, 1);
    assert.match(made[0][0], /\/demo\/import_worker\.mjs$/);
    assert.deepEqual(made[0][1], { type: 'module' });
    // клиент по умолчанию создаёт именно такой воркер, и только при первом разборе
    made.length = 0;
    C.create_import_client({ timeout_ms: 1 });
    assert.equal(made.length, 0, 'воркер запускается лениво');
  } finally { delete globalThis.Worker; }
  const client_src = fs.readFileSync(path.join(PROTO, 'demo', 'import_worker_client.mjs'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/\bnew\s+(?:globalThis\.)?Worker\s*\(/.test(client_src), 'клиент сам воркер не создаёт');
  assert.ok(!/https?:\/\//.test(client_src) && !/localStorage|indexedDB|caches|fetch/.test(client_src));
});

// ── связка с моделью мастера ────────────────────────────────────────────────────────────────────────────────────────────

/** Заметные для сравнения части плана: без base_ws (ссылка), поля parse и байтов источника. */
const plan_view = (plan) => json({ ...plan, base_ws: null, parse: null, source: { ...plan.source, bytes: null } });

test('REQ-091 FP-18 plan_csv_async через клиент на заглушке воркера: тот же план и отчёт, что у plan_csv; при любом сбое воркера — откат, план тот же, причина в plan.parse', async () => {
  const ws = load('g001.json');
  const target = { ...ws, facts: [] };
  const cases = [['банк-152', BANK.text, M.BUILTIN_PROFILES['csv-generic'], ws], ['Runway', DA.export_csv_file(ws).text, M.BUILTIN_PROFILES['runway-csv-1'], target], ['банк-9500', big_bank_case(9500).text, M.BUILTIN_PROFILES['csv-generic'], ws]];
  for (const [name, text, profile, base] of cases) {
    const input = { text, bytes: enc(text), name: 'f.csv', profile, account_id: 'acc_main', worker_min_bytes: 0 };
    const sync = M.plan_csv(base, input);
    assert.ok(sync.ok, name);
    const via_worker = await M.plan_csv_async(base, input, client_with('echo').c);
    assert.ok(via_worker.ok, name);
    assert.deepEqual(via_worker.plan.parse, { via: 'worker', reason: null }, name);
    assert.equal(plan_view(via_worker.plan), plan_view(sync.plan), name + ': план тот же');
    assert.equal(json(via_worker.plan.report), json(sync.plan.report), name + ': отчёт тот же');
    for (const [mode, reason] of [['crash', 'worker_error'], ['wrong_engine', 'version_mismatch'], ['lost_part', 'worker_error']]) {
      const fb = await M.plan_csv_async(base, input, client_with(mode, { box: { chunk: name === 'банк-9500' ? undefined : 5 } }).c);
      assert.deepEqual(fb.plan.parse, { via: 'main', reason }, name + ' ' + mode);
      assert.equal(plan_view(fb.plan), plan_view(sync.plan), name + ' ' + mode + ': откат не меняет результат');
    }
    const none = await M.plan_csv_async(base, input, client_with('echo', { opts: { make_worker: () => null } }).c);
    assert.deepEqual(none.plan.parse, { via: 'main', reason: 'no_worker' }, name);
    assert.equal(plan_view(none.plan), plan_view(sync.plan));
  }
});

test('REQ-091 FP-18 plan_csv_async: ошибка разбора в воркере даёт тот же отказ, что plan_csv (код и контекст без текстов файла)', async () => {
  const ws = load('g001.json');
  const text = 'Date,Description,Amount,Currency\n2026-09-01,"не закрыта,1,EUR\n';
  const input = { text, bytes: enc(text), profile: M.BUILTIN_PROFILES['csv-generic'], account_id: 'acc_main', worker_min_bytes: 0 };
  const sync = M.plan_csv(ws, input);
  assert.equal(sync.ok, false);
  const a = await M.plan_csv_async(ws, input, client_with('echo').c);
  assert.deepEqual(a, sync);
  assert.equal(a.error.ctx.reason, 'unterminated_quote');
  const unknown = { ...input, profile: { ...input.profile, date: { col: 'Нет', fmt: 'YYYY-MM-DD' } } };
  assert.deepEqual(await M.plan_csv_async(ws, unknown, client_with('echo').c), M.plan_csv(ws, unknown));
});

test('REQ-091 FP-18 wiz_csv_run_async с настоящим клиентом на заглушке воркера: большой файл разобран «в воркере», состояние мастера и отчёт те же, что после wiz_csv_run', async () => {
  const ws = load('g001.json');
  const target = { ...ws, facts: [] };
  const text = DA.export_csv_file(ws).text + '\n'.repeat(M.WORKER_MIN_BYTES);
  const make = () => { const w = M.new_wizard(); const l = M.wiz_csv_load(w, target, { name: 'runway.csv', bytes: enc(text) }); assert.ok(l.ok); return w; };
  const w1 = make();
  M.wiz_csv_run(w1, target);
  const w2 = make();
  const cl = client_with('echo');
  const r = await M.wiz_csv_run_async(w2, target, cl.c);
  assert.ok(r.ok);
  assert.deepEqual(w2.csv.plan.parse, { via: 'worker', reason: null });
  assert.equal(cl.c.stats().worker_calls, 1);
  assert.equal(json(w2.csv.plan.report), json(w1.csv.plan.report));
  assert.equal(json(w2.csv.plan.candidates), json(w1.csv.plan.candidates));
  assert.equal(w2.csv.step, 'report');
  assert.equal(w2.csv.checking, false);
});
