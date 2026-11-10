// import_worker_model.test.mjs — FP-18, REQ-091, REQ-150: разбор CSV в НАСТОЯЩЕМ потоке (worker_threads; в браузере — Web Worker, у обоих отдельный поток и копирование
// сообщений) и модельный замер блокировки страницы на файле около 5 МБ. Браузер здесь не запускается: это модель, цифры с этой машины на телефон не переносятся.
//
// Что проверяется:
//   1. сквозная работа клиента demo/import_worker_client.mjs с потоком tests/import_worker_thread.mjs: ответ побайтно равен parse_with_profile (в том числе при ответе
//      частями), ошибки движка проходят, падение потока даёт откат на главный поток;
//   2. блокировка: пока файл ~5 МБ разбирается в потоке, главный поток занят заметно меньше, чем при разборе на месте (максимальная задержка цикла событий,
//      monitorEventLoopDelay); отдельно — стоимость ОДНОГО сообщения на стороне страницы (копия запроса и каждой части ответа), потому что браузер обрабатывает
//      каждое сообщение отдельной задачей, а Node отдаёт накопившиеся сообщения порта одной пачкой (поэтому задержка цикла в Node — оценка сверху).
// Что НЕ проверяется здесь: стадии на главном потоке — образец колонок (sniff_csv), сверка с данными (dry_run), отчёт и хэш файла (sha256), запись партии. Стоимость первых
// четырёх на том же файле печатается ниже (по прежним вызовам) и проверяется в tests/import_main_thread.test.mjs (образец по голове файла, стадии отдельными задачами).
// Абсолютные пороги в миллисекундах взяты с четырёхкратным запасом к бюджету ADR-014 (50 мс на задачу): нагрузка и подкачка на слабой машине не должны давать красный
// без регресса; точные числа печатаются в вывод. Относительная проверка (воркер против разбора на месте) осталась строгой.
// Расчёт по введённым данным и правилам, не консультация.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/import_worker_model.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Worker as NodeWorker } from 'node:worker_threads';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

import { PROTO } from './sw_harness.mjs';

const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);
const W = await imp('demo', 'import_worker.mjs');
const C = await imp('demo', 'import_worker_client.mjs');
const M = await imp('demo', 'import_model.mjs');
const IO = await imp('engine', 'io.mjs');
const E = await imp('engine', 'index.mjs');

const PROFILE = M.BUILTIN_PROFILES['csv-generic'];
const CTX = { account_id: 'acc_main', account_currency: 'EUR', as_of: '2026-10-04' };
const HELPER = pathToFileURL(path.join(PROTO, 'tests', 'import_worker_thread.mjs'));
const round1 = (x) => Math.round(x * 10) / 10;

/** Адаптер: поток Node с теми же полями, что у Web Worker для клиента (onmessage, onerror, postMessage, terminate). */
function node_worker() {
  const nw = new NodeWorker(HELPER);
  const a = { onmessage: null, onerror: null, onmessageerror: null, postMessage: (m) => nw.postMessage(m), terminate: () => { nw.terminate(); } };
  nw.on('message', (data) => a.onmessage?.({ data }));
  nw.on('error', () => a.onerror?.({}));
  nw.on('messageerror', () => a.onmessageerror?.({}));
  a.thread = nw;
  return a;
}

/** Файл банка около `target_bytes`: длинные описания, как в выписках (SEPA-текст), строки по ~160 знаков. */
function bank_text(target_bytes) {
  const rows = ['Date,Description,Amount,Currency'];
  let size = rows[0].length + 1;
  for (let i = 0; size < target_bytes - 400; i++) {
    const cents = (i % 997) + 1;
    const r = `2026-0${1 + (i % 9)}-${String(1 + (i % 28)).padStart(2, '0')},"CARD PAYMENT TO MERCHANT ${i % 4093} REF ${String(100000000 + i)} BERLIN DE VALUE DATE 2026 ${i % 97} SEPA ${i % 13}",-${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')},EUR`;
    rows.push(r);
    size += r.length + 1;
  }
  return rows.join('\n') + '\n';
}

test('REQ-091 FP-18 в настоящем потоке: ответ побайтно равен parse_with_profile для малого файла и для ответа частями; ошибка движка идёт тем же кодом; падение потока даёт откат на главный поток', async () => {
  const client = C.create_import_client({ make_worker: node_worker, timeout_ms: 60000 });
  try {
    const small = fs.readFileSync(path.join(PROTO, 'tests', 'fixtures', 'import-152.csv'), 'utf8');
    const a = await client.parse_csv(PROFILE, small, CTX);
    assert.equal(a.via, 'worker');
    assert.equal(JSON.stringify(a.result), JSON.stringify(IO.parse_with_profile(PROFILE, small, CTX)));
    // 5 500 строк: шесть частей кандидатов
    const mid = bank_text(900 * 1024);
    const expected = IO.parse_with_profile(PROFILE, mid, CTX);
    assert.ok(expected.candidates.length > 4000, 'строк: ' + expected.candidates.length);
    const b = await client.parse_csv(PROFILE, mid, CTX);
    assert.equal(b.via, 'worker');
    assert.equal(JSON.stringify(b.result), JSON.stringify(expected));
    // ошибка данных
    const broken = { ...PROFILE, date: { col: 'НетТакой', fmt: 'YYYY-MM-DD' } };
    let d = null;
    try { IO.parse_with_profile(broken, small, CTX); } catch (e) { d = e; }
    await assert.rejects(() => client.parse_csv(broken, small, CTX), (e) => e instanceof E.RunwayError && e.code === d.code && JSON.stringify(e.ctx) === JSON.stringify(d.ctx));
    assert.equal(client.stats().dead, null);
    // поток убит снаружи — следующий вызов откатывается на главный поток без потери результата
    const killer = C.create_import_client({
      make_worker: () => { const w = node_worker(); setTimeout(() => w.thread.terminate(), 0); return w; }, timeout_ms: 300,
    });
    const k = await killer.parse_csv(PROFILE, small, CTX);
    assert.equal(k.via, 'main');
    assert.ok(['timeout', 'worker_error'].includes(k.reason), String(k.reason));
    assert.equal(JSON.stringify(k.result), JSON.stringify(a.result));
    killer.terminate();
  } finally { client.terminate(); }
});

test('REQ-091 REQ-150 FP-18 модель блокировки: файл около 5 МБ — разбор вне главного потока, задержка цикла событий заметно меньше, чем при разборе на месте; одно сообщение стоит странице единицы миллисекунд', async () => {
  const text = bank_text(5 * 1024 * 1024);
  assert.ok(text.length > 4.9 * 1024 * 1024 && text.length <= IO.MAX_IMPORT_BYTES, 'размер файла: ' + text.length);

  // (а) разбор на месте: поток занят на всё время разбора
  let t0 = performance.now();
  const local = IO.parse_with_profile(PROFILE, text, CTX);
  const sync_ms = performance.now() - t0;
  const rows = local.candidates.length;
  const expected_json = JSON.stringify(local);
  const reply = { v: 1, id: 1, ok: true, op: 'parse_csv', engine_version: E.ENGINE_VERSION, result: local }; // ответ, каким его отправил бы воркер

  // (б) стоимость одного сообщения на стороне страницы: копия запроса и копия каждой части ответа
  const request_ms = (() => { const s = performance.now(); structuredClone({ v: 1, id: 1, op: 'parse_csv', profile: PROFILE, text, ctx: CTX }); return performance.now() - s; })();
  const msgs = W.split_reply(reply);
  const per_msg = msgs.map((m) => { const s = performance.now(); structuredClone(m); return performance.now() - s; });
  const max_msg_ms = Math.max(...per_msg);

  // (в) разбор в потоке: максимальная задержка цикла событий, пока идёт вызов клиента
  const client = C.create_import_client({ make_worker: node_worker, timeout_ms: 120000 });
  try {
    await client.parse_csv(PROFILE, 'Date,Description,Amount,Currency\n2026-09-01,x,-1.00,EUR\n', CTX); // прогрев: загрузка модулей в потоке не считается
    const h = monitorEventLoopDelay({ resolution: 1 });
    h.enable();
    t0 = performance.now();
    const r = await client.parse_csv(PROFILE, text, CTX);
    const worker_total_ms = performance.now() - t0;
    await new Promise((res) => setTimeout(res, 20));
    h.disable();
    const worker_block_ms = h.max / 1e6;
    assert.equal(r.via, 'worker');
    assert.equal(JSON.stringify(r.result), expected_json, 'файл ~5 МБ: ответ в потоке побайтно равен разбору на месте');

    // стоимость остальных стадий на главном потоке (для README; не часть замера): сверка с данными, отчёт, хэш файла, образец колонок
    const ws = JSON.parse(fs.readFileSync(path.join(PROTO, 'data', 'g001.json'), 'utf8'));
    const bytes = new TextEncoder().encode(text);
    const stage = (fn) => { const s0 = performance.now(); const v = fn(); return [v, performance.now() - s0]; };
    const [dry, dry_ms] = stage(() => IO.dry_run(local.candidates, new Set(), local.rejects, ws.facts, ws.params));
    const [, report_ms] = stage(() => M.make_report(dry, local.rejects, ws));
    const [, hash_ms] = stage(() => E.sha256(bytes));
    const [, sniff_ms] = stage(() => M.sniff_csv(text));
    const tail_ms = dry_ms + report_ms + hash_ms;

    const line = {
      file_mb: round1(text.length / 1048576), rows, sync_parse_ms: round1(sync_ms), worker_total_ms: round1(worker_total_ms),
      event_loop_max_delay_with_worker_ms: round1(worker_block_ms), request_clone_ms: round1(request_ms), max_message_clone_ms: round1(max_msg_ms), messages: msgs.length,
      sniff_csv_ms: round1(sniff_ms), after_parse_on_main_ms: round1(tail_ms), dry_run_ms: round1(dry_ms), report_ms: round1(report_ms), file_hash_ms: round1(hash_ms),
    };
    console.log('# FP-18 модель блокировки (Node ' + process.version + '): ' + JSON.stringify(line));

    assert.ok(sync_ms > 200, 'на этом размере разбор на месте занимает заметное время: ' + sync_ms);
    // относительная проверка устойчива к нагрузке машины: в потоке главный поток занят в разы меньше
    assert.ok(worker_block_ms < 0.35 * sync_ms, `задержка цикла событий с воркером ${worker_block_ms} мс против ${sync_ms} мс на месте`);
    // бюджет ADR-014 на одну задачу страницы — 50 мс (гипотеза бюджета, не обещание продукту); порог проверки четырёхкратный: копия запроса и любой части ответа
    // в настоящем потоке дают единицы-десятки миллисекунд, а ответ одним сообщением (без нарезки на части) стоил бы сотни
    assert.ok(max_msg_ms <= 200, `одна часть ответа копируется за ${max_msg_ms} мс (бюджет 50)`);
    assert.ok(request_ms <= 200, `запрос копируется за ${request_ms} мс (бюджет 50)`);
    assert.ok(msgs.length >= Math.ceil(rows / W.CHUNK_ROWS), 'ответ режется на части по CHUNK_ROWS');
  } finally { client.terminate(); }
});
