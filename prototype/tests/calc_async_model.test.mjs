// calc_async_model.test.mjs — FP-21, REQ-150: МОДЕЛЬНЫЙ замер блокировки главного потока при расчёте основных экранов в Worker. Это модель, а не замер браузера: воркер — настоящий поток
// Node (`worker_threads`; в браузере — Web Worker, у обоих отдельный поток и копирование сообщений), блокировка — максимальная задержка цикла событий (`monitorEventLoopDelay`,
// разрешение 1 мс) на главном потоке, пока считается ≈ 10³ событий (`make_bench_ws(4)`, около 1 084 событий, горизонт 180 дней). Цифры с этой машины на телефон не переносятся; бюджет ≤ 50 мс
// (ADR-014) в браузере на устройстве подтверждают люди (страница demo/bench.html, REQ-150). Node отдаёт накопившиеся сообщения порта одной пачкой, поэтому задержка цикла в модели —
// оценка сверху для браузера, где каждое сообщение — своя задача.
// Что проверяется:
//   1. сквозная работа службы calc_async.mjs с потоком: «Обзор» (prepare → take → ctx_from_analysis), «Волны» (prepare со screen waves) и «Купить» (afford) на наборе ≈ 10³ событий
//      побайтно равны расчёту на месте;
//   2. блокировка: пока Worker считает модель набора и деньги после покупки, главный поток занят заметно меньше, чем при расчёте на месте, и не дольше бюджета 50 мс
//      (лучшая из трёх попыток: разовая нагрузка машины не даёт ложного красного, настоящий регресс держится во всех попытках);
//   3. подробные числа печатаются строкой «# FP-21 модель блокировки».
// Расчёт по введённым данным и правилам, не консультация.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/calc_async_model.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker as NodeWorker } from 'node:worker_threads';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

import { PROTO } from './sw_harness.mjs';

const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);
const C = await imp('demo', 'worker_client.mjs');
const S = await imp('demo', 'calc_async.mjs');
const A = await imp('demo', 'app.mjs');
const BM = await imp('demo', 'bench_model.mjs');
const T = await imp('engine', 'tools.mjs');
const E = await imp('engine', 'index.mjs');

const HELPER = pathToFileURL(path.join(PROTO, 'tests', 'calc_worker_thread.mjs'));
const json = (x) => JSON.stringify(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round1 = (x) => Math.round(x * 10) / 10;
const WS = BM.make_bench_ws(4);
const Q = { as_of: WS.as_of };
const parts_of = (i) => [{ date: E.format_date(E.to_epoch_day(WS.as_of) + 3 + (i % 20)), amount_minor: 10000 + i * 137 }];

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
const make_service = () => S.create_calc_service({
  storage: null, has_worker: () => true, make_client: () => C.create_calc_client({ make_worker: node_worker, timeout_ms: 120000 }), frame_ms: 0,
});

test('REQ-150 FP-21 в настоящем потоке: «Обзор» (prepare → take), «Волны» и «Купить» (afford) на наборе ≈ 10³ событий побайтно равны расчёту на месте; ответы идут через Worker', async () => {
  const svc = make_service();
  try {
    const events = E.analyze(WS, Q).events.plan.length;
    assert.ok(events >= 900 && events <= 1250, 'событий: ' + events);
    const r = await svc.prepare(WS, [Q]);
    assert.deepEqual([r.ok, r.via, r.op], [true, 'worker', 'project']);
    const got = svc.take(WS, Q);
    const ctx = S.ctx_from_analysis(got, WS, Q, { locale: 'ru' });
    assert.equal(json(ctx), json(T.make_tool_ctx(WS, Q, { locale: 'ru' })), 'модель из потока = make_tool_ctx на месте');
    const model = { ws: WS, ctx, scenario: null };
    const parts = parts_of(5);
    const job = svc.afford(model, parts);
    assert.notEqual(job, null);
    const res = await job.promise;
    assert.equal(res.value.via, 'worker');
    assert.equal(json(res.value.cash_after), json(A.cash_after(A.build_model(WS), parts)), 'деньги после покупки из потока = на месте');
    const w = await svc.prepare(WS, [Q], { screen: 'waves' });
    assert.equal(w.op, 'waves');
    const a2 = svc.take(WS, Q);
    assert.equal(json(svc.waves_for(a2)), json({ plan: E.list_waves_ex(a2, 'plan'), worse: E.list_waves_ex(a2, 'worse') }), 'списки волн из потока = list_waves_ex на месте');
    assert.equal(svc.stats().main_calls, 0);
    assert.ok(svc.stats().worker_calls >= 3);
  } finally { svc.terminate(); }
});

test('REQ-150 FP-21 МОДЕЛЬ блокировки (не замер браузера): Worker не держит главный поток дольше бюджета 50 мс на ≈ 10³ событий и держит его заметно меньше, чем расчёт на месте', async () => {
  const svc = make_service();
  const RUNS = 12;
  try {
    // прогрев: загрузка модулей в потоке и JIT на главном потоке не считаются
    await svc.prepare(WS, [Q]);
    svc.take(WS, Q);
    for (let i = 0; i < 3; i++) { const m = T.make_tool_ctx(WS, Q, { locale: 'ru' }); A.cash_after({ ws: WS, ctx: m, scenario: null }, parts_of(i)); }

    const lag = async (body) => {
      const h = monitorEventLoopDelay({ resolution: 1 });
      h.enable();
      const t0 = performance.now();
      await body();
      await sleep(10);
      h.disable();
      return { max_ms: h.max / 1e6, total_ms: performance.now() - t0 };
    };
    const in_thread = () => lag(async () => {
      for (let i = 0; i < RUNS; i++) {
        await sleep(2); // дать таймеру сработать между расчётами
        const ctx = T.make_tool_ctx(WS, Q, { locale: 'ru' }); // build_model на месте
        A.cash_after({ ws: WS, ctx, scenario: null }, parts_of(i)); // «Купить» на месте
      }
    });
    const in_worker = () => lag(async () => {
      for (let i = 0; i < RUNS; i++) {
        await sleep(2);
        await svc.prepare(WS, [Q]); // Worker считает модель набора
        const ctx = S.ctx_from_analysis(svc.take(WS, Q), WS, Q, { locale: 'ru' }); // главный поток принимает готовый расчёт
        const job = svc.afford({ ws: WS, ctx, scenario: null }, parts_of(i + 1)); // Worker считает деньги после покупки
        await job.promise;
      }
    });

    let best_thread = null;
    let best_worker = null;
    const tries = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const a = await in_thread();
      const b = await in_worker();
      tries.push([round1(a.max_ms), round1(b.max_ms)]);
      if (best_thread === null || a.max_ms < best_thread.max_ms) best_thread = a;
      if (best_worker === null || b.max_ms < best_worker.max_ms) best_worker = b;
      if (best_worker.max_ms <= BM.BUDGET.blocking_ms && best_worker.max_ms < best_thread.max_ms) break;
    }
    console.log(`# FP-21 модель блокировки (Node ${process.version}, worker_threads, ≈ 10³ событий, ${RUNS} раз «модель набора + деньги после покупки»; это модель, не замер браузера): `
      + `задержка цикла событий на главном потоке — в потоке ${round1(best_thread.max_ms)} мс, при расчёте в Worker ${round1(best_worker.max_ms)} мс (бюджет ≤ ${BM.BUDGET.blocking_ms} мс); `
      + `попытки [в потоке, в Worker]: ${JSON.stringify(tries)}; полное время ${round1(best_thread.total_ms)} / ${round1(best_worker.total_ms)} мс`);
    assert.ok(best_worker.max_ms <= BM.BUDGET.blocking_ms, 'блокировка при расчёте в Worker: ' + round1(best_worker.max_ms) + ' мс > ' + BM.BUDGET.blocking_ms);
    assert.ok(best_worker.max_ms < best_thread.max_ms, 'Worker держит главный поток меньше, чем расчёт на месте: ' + round1(best_worker.max_ms) + ' против ' + round1(best_thread.max_ms));
  } finally { svc.terminate(); }
});
