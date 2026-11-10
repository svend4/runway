// calc_async_queue.test.mjs — FP-21, REQ-150: ограниченная очередь «Купить» к Worker (исправление дефекта проверки: перетаскивание ползунка копило устаревшие расчёты,
// затем таймаут воркера и подряд-пересчёт всей очереди на главном потоке). Браузера, сети и потоков здесь нет: воркер — РУЧНАЯ заглушка, которая принимает сообщения, а отвечает
// только по команде теста настоящим `handle_message` (demo/calc_worker.mjs); таймеры службы и клиента — вручную. Проверяется:
//   1. «один в полёте и один свежий»: сто кадров правок при медленном воркере дают воркеру одно сообщение, затем (после ответа) ещё одно — последнее; остальные получают SUPERSEDED;
//   2. «новейший побеждает»: ответ из кэша и присоединение к идущему расчёту вытесняют ожидающий свежий запрос; присоединившегося идущий расчёт защищает от пропуска;
//   3. сбой воркера (таймаут): на главном потоке считается только актуальный запрос, вытесненный пропускается, остальные — SUPERSEDED; воркер не перезапускается;
//   4. дорожка к воркеру: одновременно у него один запрос (prepare и «Купить» не копятся), таймер клиента стартует при отправке; вытесненный запрос, ждавший дорожку, не отправляется;
//   5. клиент: необязательный признак `stale` действует только на откате и не меняет ответы воркера.
// Расчёт по введённым данным и правилам, не консультация.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/calc_async_queue.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PROTO } from './sw_harness.mjs';

const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);
const W = await imp('demo', 'calc_worker.mjs');
const C = await imp('demo', 'worker_client.mjs');
const S = await imp('demo', 'calc_async.mjs');
const A = await imp('demo', 'app.mjs');
const E = await imp('engine', 'index.mjs');

const G = JSON.parse(fs.readFileSync(path.join(PROTO, 'data', 'g001.json'), 'utf8'));
const json = (x) => JSON.stringify(x);
const tick = () => new Promise((r) => setImmediate(r));
const parts_of = (shift, amount) => [{ date: E.format_date(E.to_epoch_day(G.as_of) + shift), amount_minor: amount }];
const sync_cash = (parts) => A.cash_after(A.build_model(structuredClone(G)), parts);

/** Воркер-заглушка: сообщения копятся, отвечает тест (`answer(i)` — настоящий расчёт на i-е сообщение). */
function manual_worker() {
  const w = {
    terminated: false, received: [], onmessage: null, onerror: null, onmessageerror: null,
    postMessage(msg) { w.received.push(structuredClone(msg)); },
    terminate() { w.terminated = true; },
    answer(i) { const reply = structuredClone(W.handle_message(structuredClone(w.received[i]))); w.onmessage?.({ data: reply }); },
  };
  return w;
}

/** Служба на ручных таймерах и ручном воркере. */
function rig() {
  const svc_timers = [];
  const client_timers = [];
  const workers = [];
  const svc = S.create_calc_service({
    storage: null,
    has_worker: () => true,
    set_timeout: (fn, ms) => { svc_timers.push({ fn, ms }); return svc_timers.length; },
    make_client: () => C.create_calc_client({
      make_worker: () => { const w = manual_worker(); workers.push(w); return w; },
      set_timeout: (fn, ms) => { client_timers.push({ fn, ms }); return client_timers.length; },
      clear_timeout: () => {},
    }),
  });
  const fire = () => { for (const t of svc_timers.splice(0)) t.fn(); };
  /** Один кадр: запрос, конец кадра, дать микрозадачам отработать. */
  const frame = async (model, parts) => { const job = svc.afford(model, parts); fire(); await tick(); return job; };
  return { svc, fire, frame, workers, client_timers, svc_timers };
}

const model_of = () => A.build_model(structuredClone(G));

test('REQ-150 FP-21 очередь: сто кадров правок при медленном воркере — воркеру ОДНО сообщение, затем (после ответа) ещё одно, последнее; промежуточные — SUPERSEDED; в очереди не больше одного расчёта и одного свежего', async () => {
  const x = rig();
  const model = model_of();
  const jobs = [];
  for (let i = 0; i < 100; i++) jobs.push(await x.frame(model, parts_of(3, 1000 + i)));
  const w = x.workers[0];
  assert.equal(x.workers.length, 1, 'воркер один');
  assert.equal(w.received.length, 1, 'пока воркер считает, новые правки к нему не уходят');
  assert.equal(w.received[0].parts[0].amount_minor, 1000, 'в полёте первый запрос');
  assert.equal(x.svc.pending(), 2, 'в работе один и один свежий ждёт его конца');
  const middle = await Promise.all(jobs.slice(1, 99).map((j) => j.promise));
  assert.ok(middle.every((r) => r === S.SUPERSEDED), 'девяносто восемь промежуточных запросов вытеснены, не дожидаясь воркера');
  assert.equal(x.svc.stats().coalesced, 98);
  // воркер ответил на первый: уходит ровно один — последний
  w.answer(0);
  await tick();
  assert.equal(w.received.length, 2);
  assert.equal(w.received[1].parts[0].amount_minor, 1099, 'следующим уходит последняя сумма');
  assert.deepEqual(w.received.map((m) => m.op), ['afford', 'afford']);
  const first = await jobs[0].promise;
  assert.equal(json(first.value.cash_after), json(sync_cash(parts_of(3, 1000))), 'прежний запрос доведён до конца и верен (его ответ попадёт в кэш)');
  assert.equal(x.svc.pending(), 1);
  w.answer(1);
  const last = await jobs[99].promise;
  assert.equal(json(last.value.cash_after), json(sync_cash(parts_of(3, 1099))), 'последний запрос посчитан верно');
  assert.equal(last.value.via, 'worker');
  assert.equal(w.received.length, 2, 'всего воркеру ушло два сообщения из ста');
  await tick();
  assert.equal(x.svc.pending(), 0);
  assert.equal(x.svc.stats().worker_calls, 2);
  assert.equal(x.svc.stats().main_calls, 0);
});

test('REQ-150 FP-21 очередь: «один в полёте и один свежий» держится и при ответах по ходу жеста — число сообщений воркеру не больше числа ответов плюс один', async () => {
  const x = rig();
  const model = model_of();
  const w_count = () => x.workers[0]?.received.length ?? 0;
  let answered = 0;
  for (let i = 0; i < 60; i++) {
    await x.frame(model, parts_of(2 + (i % 5), 5000 + i));
    if (i % 10 === 9 && w_count() > answered) { x.workers[0].answer(answered); answered += 1; await tick(); }
    assert.ok(w_count() <= answered + 1, 'кадр ' + i + ': сообщений ' + w_count() + ', ответов ' + answered);
  }
  assert.ok(w_count() <= 8, 'за шестьдесят кадров воркеру ушло ' + w_count() + ' сообщений');
});

test('REQ-150 FP-21 очередь: ответ из кэша и присоединение к идущему расчёту вытесняют ожидающий свежий запрос (новейший побеждает); присоединившегося идущий расчёт защищает от пропуска', async () => {
  const x = rig();
  const model = model_of();
  const a = await x.frame(model, parts_of(3, 2000)); // в полёте
  const b = await x.frame(model, parts_of(3, 2100)); // свежий ждёт
  assert.equal(x.svc.pending(), 2);
  // пользователь вернулся к значению, расчёт которого идёт: свежий запрос больше не нужен, второго сообщения не будет
  const again = x.svc.afford(model, parts_of(3, 2000));
  assert.equal(again.key, a.key);
  assert.equal(await b.promise, S.SUPERSEDED);
  assert.equal(x.svc.pending(), 1);
  x.workers[0].answer(0);
  const [r1, r2] = await Promise.all([a.promise, again.promise]);
  assert.equal(json(r1.value), json(r2.value), 'присоединившийся получил тот же ответ');
  assert.equal(x.workers[0].received.length, 1, 'вытесненный свежий воркеру не уходил');
  // ответ из кэша вытесняет свежий запрос так же
  const c = await x.frame(model, parts_of(4, 3000));
  const d = await x.frame(model, parts_of(4, 3100));
  assert.equal(x.svc.pending(), 2);
  const hit = x.svc.afford(model, parts_of(3, 2000));
  assert.deepEqual(Object.keys(hit), ['key', 'value']);
  assert.equal(await d.promise, S.SUPERSEDED);
  assert.equal(x.svc.pending(), 1);
  x.workers[0].answer(1);
  assert.equal((await c.promise).value.via, 'worker');
  assert.equal(x.workers[0].received.length, 2);
});

test('REQ-150 FP-21 сбой воркера посреди жеста: на главном потоке считается ОДИН актуальный запрос, вытесненный пропускается, остальные — SUPERSEDED; воркер не перезапускается, причина — timeout', async () => {
  const x = rig();
  const model = model_of();
  const jobs = [];
  for (let i = 0; i < 40; i++) jobs.push(await x.frame(model, parts_of(5, 700 + i)));
  assert.equal(x.workers[0].received.length, 1);
  assert.equal(x.client_timers.length, 1, 'таймаут клиента заведён на одно отправленное сообщение, а не на сорок');
  x.client_timers[0].fn(); // воркер не ответил
  const last = await jobs[39].promise;
  assert.equal(await jobs[0].promise, S.SUPERSEDED, 'прежний запрос пропущен: считать устаревшее на главном потоке незачем');
  assert.equal(last.value.via, 'main');
  assert.equal(last.value.reason, 'timeout');
  assert.equal(json(last.value.cash_after), json(sync_cash(parts_of(5, 739))), 'актуальный запрос посчитан верно');
  const st = x.svc.stats();
  assert.equal(st.worker_calls, 0);
  assert.equal(st.skipped, 1, 'пропущен ровно один вытесненный запрос, а не сорок досчитаны подряд');
  assert.equal(st.off_reason, 'timeout');
  assert.equal(x.workers.length, 1, 'цикла перезапусков нет');
  assert.equal(x.workers[0].terminated, true);
  assert.equal(x.svc.afford(model, parts_of(5, 9999)), null, 'после сбоя служба неактивна: приложение считает на месте');
  await tick();
  assert.equal(x.svc.pending(), 0);
});

test('REQ-150 FP-21 сбой воркера, когда к идущему расчёту кто-то присоединился: расчёт не пропускается, даже если после присоединения пришёл ещё более свежий запрос — присоединившийся получает значение, а не SUPERSEDED', async () => {
  const x = rig();
  const model = model_of();
  const a = await x.frame(model, parts_of(6, 4000));
  await x.frame(model, parts_of(6, 4100)); // свежий
  const joined = x.svc.afford(model, parts_of(6, 4000)); // присоединение вытесняет свежий запрос
  const newer = await x.frame(model, parts_of(6, 4200)); // а потом приходит ещё более свежий: идущий расчёт теперь «вытеснен» ровно настолько, насколько к нему никто не присоединялся
  x.client_timers[0].fn();
  const [r1, r2, r3] = await Promise.all([a.promise, joined.promise, newer.promise]);
  assert.notEqual(r1, S.SUPERSEDED, 'идущий расчёт, к которому присоединились, не пропускается');
  assert.notEqual(r2, S.SUPERSEDED, 'присоединившийся получает значение');
  assert.equal(r2.value.via, 'main');
  assert.equal(json(r2.value.cash_after), json(sync_cash(parts_of(6, 4000))));
  assert.equal(json(r3.value.cash_after), json(sync_cash(parts_of(6, 4200))), 'и самый свежий тоже посчитан верно');
  assert.equal(x.svc.stats().skipped, 0);
});

test('REQ-150 FP-21 дорожка к воркеру: у воркера одновременно один запрос (prepare и «Купить» не копятся), таймер клиента заводится при отправке; вытесненный запрос, ждавший дорожку, воркеру не уходит', async () => {
  const x = rig();
  const model = model_of();
  const ws = structuredClone(G);
  const prep = x.svc.prepare(ws, [{ as_of: ws.as_of }]);
  const a = x.svc.afford(model, parts_of(2, 1111)); // другой канал, свой кадр
  x.fire();
  await tick();
  const w = x.workers[0];
  assert.deepEqual(w.received.map((m) => m.op), ['project'], 'пока prepare считается, «Купить» ждёт дорожку');
  assert.equal(x.client_timers.length, 1);
  // за время ожидания дорожки пришёл более свежий запрос «Купить»: прежний вытеснен и воркеру не нужен
  const b = x.svc.afford(model, parts_of(2, 2222));
  x.fire();
  await tick();
  assert.equal(x.svc.pending() >= 2, true);
  w.answer(0);
  await prep;
  await tick();
  assert.deepEqual(w.received.map((m) => m.op), ['project', 'afford'], 'после prepare воркеру ушёл один «Купить»');
  assert.equal(w.received[1].parts[0].amount_minor, 2222, 'и это свежий, а не вытесненный');
  assert.equal(x.client_timers.length, 2, 'таймер второго запроса заведён только при его отправке');
  assert.equal(x.svc.stats().skipped, 1);
  w.answer(1);
  assert.equal(await a.promise, S.SUPERSEDED);
  assert.equal(json((await b.promise).value.cash_after), json(sync_cash(parts_of(2, 2222))));
  assert.equal(json(x.svc.take(ws, { as_of: ws.as_of }).inputs_hash), json(E.analyze(ws, { as_of: ws.as_of }).inputs_hash));
});

test('REQ-150 FP-21 клиент воркера: признак stale действует только на откате — ответ воркера отдаётся как раньше, откат вытесненного запроса пропускается без расчёта и без счёта main_calls', async () => {
  const q = { as_of: G.as_of };
  const parts = parts_of(3, 1500);
  // воркер жив: stale не мешает
  const live = (() => { const w = manual_worker(); const c = C.create_calc_client({ make_worker: () => w, set_timeout: () => 1, clear_timeout: () => {} }); return { w, c }; })();
  const p = live.c.afford(G, q, parts, { stale: () => true });
  await tick();
  live.w.answer(0);
  const ok = await p;
  assert.deepEqual([ok.via, ok.reason, ok.skipped], ['worker', null, undefined]);
  assert.equal(json(ok.result), json({ cash_after: sync_cash(parts) }));
  // воркера нет: stale() === true — пропуск; false или без признака — расчёт на месте
  const none = () => C.create_calc_client({ make_worker: () => null });
  for (const [name, call] of [['project', (c, o) => c.project(G, q, o)], ['waves', (c, o) => c.waves(G, q, o)], ['afford', (c, o) => c.afford(G, q, parts, o)]]) {
    const skipped = none();
    const s = await call(skipped, { stale: () => true });
    assert.deepEqual([s.result, s.via, s.reason, s.skipped], [null, 'main', 'no_worker', true], name);
    assert.equal(skipped.stats().main_calls, 0, name + ': пропущенный запрос не считается');
    const c1 = none();
    const r1 = await call(c1, { stale: () => false });
    assert.equal(r1.skipped, undefined, name);
    assert.equal(typeof r1.result, 'object', name);
    assert.equal(c1.stats().main_calls, 1, name);
    const r2 = await call(none(), undefined);
    assert.equal(json(r2.result), json(r1.result), name + ': без признака то же, что раньше');
  }
});
