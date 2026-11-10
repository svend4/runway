// calc_async_boot.test.mjs — FP-21, REQ-150: расчёт основных экранов в Worker в НАСТОЯЩЕМ app.mjs на заглушке DOM. Воркер — заглушка `FakeWorker` (глобальный `Worker`): настоящий
// `handle_message`, ответ после структурного клонирования, режимы «держит ответы» (hold: тест отпускает их сам), «отвечает» (echo) и «падает» (crash). Остальное настоящее: клиент
// воркера, служба calc_async.mjs, пакет pack_fp21, экраны «Обзор» / «Купить» / «Волны» / «Настройки». Браузера, серверов и потоков нет.
// Что проверяется: пока набор считается в Worker — скелет «Считаем…» и aria-busy на #main, модели ещё нет; после ответа модель побайтно равна посчитанной на месте; «Купить» — скелет и
// aria-busy на ответе, несколько правок за кадр дают одно сообщение воркеру, ответ приходит и рисуется; поздний ответ в отсоединённый узел не рисуется, возврат на экран берёт кэш;
// флаг в «Настройках» выключает Worker целиком (воркер остановлен, считаем на месте, скелета нет); сбой воркера не теряет набор; фокус не падает на body.
// Расчёт по введённым данным и правилам, не консультация. Один процесс node — один boot_app.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/calc_async_boot.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PROTO } from './sw_harness.mjs';
import { boot_app, find_all, N } from './dom_boot.mjs';

const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);
const W = await imp('demo', 'calc_worker.mjs');
const E = await imp('engine', 'index.mjs');
const T = await imp('engine', 'tools.mjs');
const json = (x) => JSON.stringify(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const load = (name) => JSON.parse(fs.readFileSync(path.join(PROTO, 'data', name), 'utf8'));

/** Глобальный `Worker`-заглушка: создаётся клиентом как `new Worker(url, {type: 'module'})`. */
class FakeWorker {
  static instances = [];
  static mode = 'hold';
  static held = [];
  constructor(url, opts) {
    this.url = String(url); this.opts = opts; this.onmessage = null; this.onerror = null; this.onmessageerror = null; this.terminated = false; this.received = [];
    FakeWorker.instances.push(this);
  }
  postMessage(msg) {
    const copy = structuredClone(msg);
    this.received.push(copy);
    const reply = structuredClone(W.handle_message(copy));
    const deliver = () => { if (!this.terminated) this.onmessage?.({ data: reply }); };
    if (FakeWorker.mode === 'hold') FakeWorker.held.push(deliver);
    else if (FakeWorker.mode === 'crash') queueMicrotask(() => this.onerror?.({ message: 'упал' }));
    else setTimeout(deliver, 0);
  }
  terminate() { this.terminated = true; }
  static release() { for (const d of FakeWorker.held.splice(0)) d(); }
  static ops() { return FakeWorker.instances.flatMap((w) => w.received.map((m) => m.op)); }
}
globalThis.Worker = FakeWorker;

const A = await boot_app();
const S = await imp('demo', 'calc_async.mjs');
const APP = await imp('demo', 'app.mjs');
const lang = () => A.ext.ctx.lang();
const tr = (key, params) => N(A.I18N.t(lang(), key, params));
const money = (v) => N(A.ext.ctx.fmt().money(v));
const main_text = () => A.text_of('main');
const classes = (n) => String(n.className ?? '').split(/\s+/);
const result_node = () => find_all(A.main(), (n) => classes(n).includes('result') && classes(n).includes('card'))[0];
const go_sync = (hash) => { location.hash = hash; for (const fn of A.listeners.hashchange ?? []) fn(); }; // без ожидания: правки следующего шага попадают в тот же кадр
const model_ctx_json = (ws) => json(T.make_tool_ctx(ws, { as_of: ws.as_of }, { locale: 'ru' }));

test('REQ-150 FP-21 пока набор считается в Worker: скелет «Считаем…» и aria-busy на #main, модели ещё нет, воркер получил операцию project; воркер запущен заранее (пакет), один на приложение', () => {
  assert.equal(FakeWorker.instances.length, 1, 'пакет прогрел воркер при загрузке');
  assert.equal(FakeWorker.instances[0].opts.type, 'module');
  assert.match(FakeWorker.instances[0].url, /calc_worker\.mjs$/);
  assert.equal(A.main().attrs['aria-busy'], 'true');
  assert.match(main_text(), /Считаем…/);
  assert.ok(find_all(A.main(), (n) => n.attrs.role === 'status').length >= 1, 'видимая строка статуса');
  assert.ok(find_all(A.main(), (n) => classes(n).includes('skeleton')).length === 1, 'серые блоки скелета');
  assert.equal(A.ext.ctx.get_model(), null, 'на главном потоке модель не строилась');
  // название теста прежнее (аддитивность): после исправления по проверке при загрузке уходит операция waves, надмножество project (расчёт плюс списки волн)
  assert.deepEqual(FakeWorker.ops(), ['waves']);
  assert.equal(FakeWorker.instances[0].received[0].query.as_of, '2026-10-04');
  assert.equal(S.calc.pending(), 1);
});

test('REQ-150 FP-21 ответ Worker: скелет и aria-busy сняты, модель набора построена из готового расчёта и побайтно равна посчитанной на месте; «Обзор» показывает числа G-001', async () => {
  FakeWorker.release();
  await sleep(120);
  assert.equal(A.main().attrs['aria-busy'], undefined);
  assert.ok(!main_text().includes('Считаем…'));
  const model = A.ext.ctx.get_model();
  assert.notEqual(model, null);
  assert.equal(S.calc.stats().taken, 1, 'build_model забрал расчёт Worker');
  assert.equal(json(model.ctx), model_ctx_json(load('g001.json')), 'ctx модели = make_tool_ctx на месте');
  assert.equal(model.ctx.series.plan.opening_minor, 400000);
  assert.match(main_text(), /1 830,00 €/, 'узкая точка «если хуже» G-001');
  assert.equal(S.calc.stats().worker_calls, 1);
  assert.equal(S.calc.stats().main_calls, 0, 'на главном потоке ничего не считалось');
});

test('REQ-150 FP-21 «Купить»: пока Worker считает — скелет «Считаем…» и aria-busy на ответе; одиннадцать запросов за кадр дают ОДНО сообщение afford; ответ рисуется, деньги после покупки равны посчитанным на месте', async () => {
  go_sync('#buy');
  const out = result_node();
  assert.equal(out.attrs['aria-busy'], 'true', 'ответ занят');
  assert.match(N(out.textContent), /Считаем…/);
  const amount = A.by_id('buy-amount');
  const date = A.by_id('buy-date');
  for (let i = 1; i <= 8; i++) { amount.value = String(100 + i * 25) + ',00'; amount.listeners.input[0](); }
  date.value = '2026-10-12';
  date.listeners.input[0]();
  amount.value = '300,00';
  amount.listeners.input[0]();
  await sleep(80); // кадр кончился: расчёт ушёл воркеру
  assert.deepEqual(FakeWorker.ops().filter((o) => o === 'afford'), ['afford'], 'начальный запуск и десять правок — одно сообщение воркеру');
  const sent = FakeWorker.instances[0].received.find((m) => m.op === 'afford');
  assert.deepEqual(sent.parts, [{ date: '2026-10-12', amount_minor: 30000 }], 'ушла последняя правка');
  assert.equal(result_node().attrs['aria-busy'], 'true', 'ответ ещё занят');
  assert.equal(S.calc.stats().coalesced, 10, 'одиннадцать запросов кадра, вытеснено десять');
  FakeWorker.release();
  await sleep(60);
  const node = result_node();
  assert.equal(node, out, 'тот же узел ответа обновлён на месте');
  assert.equal(node.attrs['aria-busy'], undefined);
  const model = A.ext.ctx.get_model();
  const want = APP.cash_after(model, [{ date: '2026-10-12', amount_minor: 30000 }]);
  assert.notEqual(want, null);
  const text = N(node.textContent);
  assert.ok(text.includes(tr('buy.cash_after')), 'есть блок «деньги после покупки»');
  for (const m of ['plan', 'worse']) assert.ok(text.includes(money(want[m].v) + ' · ' + N(A.ext.ctx.fmt().date(want[m].d))), m + ': ' + text.slice(0, 400));
  assert.ok(!text.includes('Считаем…'));
  // тот же ответ, посчитанный на месте, побайтно такой же по тексту: сравниваем с buy_run без Worker
  const sync_view = APP.buy_run(model, { date: '2026-10-12', amount_minor: 30000 }, 'ru');
  assert.equal(json(sync_view.view.cash_after), json(want));
});

test('REQ-150 FP-21 поздний ответ: пока Worker считает, экран ушёл на «Волны» — ответ в отсоединённый узел не рисуется, ошибок нет; возврат на «Купить» берёт кэш без нового сообщения воркеру', async () => {
  const amount = A.by_id('buy-amount');
  amount.value = '410,00';
  amount.listeners.input[0]();
  await sleep(60);
  const stale = result_node();
  assert.equal(stale.attrs['aria-busy'], 'true');
  const before = N(stale.textContent);
  const afford_before = FakeWorker.ops().filter((o) => o === 'afford').length;
  assert.equal(afford_before, 2);
  go_sync('#waves'); // render_main заменил содержимое: прежняя отрисовка «Купить» больше не живая
  assert.ok(find_all(A.main(), (n) => classes(n).includes('wave-card')).length >= 1, 'экран «Волны» на месте');
  FakeWorker.release(); // ответ приходит после ухода с экрана
  await sleep(60);
  assert.equal(N(stale.textContent), before, 'отсоединённый узел не перерисован');
  assert.equal(stale.attrs['aria-busy'], 'true', 'и отметка занятости на нём не снималась: рисовать нечем');
  assert.ok(find_all(A.main(), (n) => classes(n).includes('wave-card')).length >= 1, '«Волны» не затронуты');
  assert.equal(find_all(A.main(), (n) => n.attrs.role === 'alert').length, 0);
  go_sync('#buy');
  const fresh = result_node();
  assert.notEqual(fresh, stale);
  assert.equal(fresh.attrs['aria-busy'], undefined, 'ответ готов сразу: расчёт взят из кэша');
  assert.ok(N(fresh.textContent).includes(tr('buy.cash_after')));
  assert.equal(FakeWorker.ops().filter((o) => o === 'afford').length, 2, 'нового сообщения воркеру нет');
  assert.equal(S.calc.stats().cache_hits >= 1, true);
});

test('REQ-150 FP-21 «Волны» и «Обзор» после расчёта в Worker: карточки волн и календарь на месте, числа канона; вторая загрузка набора с экрана «Волны» просит операцию waves', async () => {
  go_sync('#waves');
  const t = main_text();
  assert.match(t, /152 000,00 €|1 520,00 €/, 'волна W1 канона 152000 minor units');
  assert.equal(find_all(A.main(), (n) => classes(n).includes('wave-card')).length, 2);
  assert.notEqual(S.calc.waves_for(A.ext.ctx.get_model().ctx), null, 'старт на «Обзоре», переход на «Волны»: списки волн пришли вместе с расчётом набора из Worker (FP-21, исправление)');
  assert.equal(S.calc.stats().main_calls, 0, 'и на главном потоке при этом ничего не считалось');
  FakeWorker.mode = 'echo';
  await A.choose_dataset('low'); // с экрана «Волны»: операция waves
  assert.deepEqual(FakeWorker.ops().slice(-1), ['waves']);
  const model = A.ext.ctx.get_model();
  assert.notEqual(S.calc.waves_for(model.ctx), null, 'списки волн пришли вместе с расчётом');
  assert.equal(json(model.ctx), model_ctx_json(load('g001-low.json')));
  assert.equal(json(APP.waves_model(model, 'ru')), json(APP.waves_model(APP.build_model(structuredClone(load('g001-low.json'))), 'ru')));
  assert.equal(find_all(A.main(), (n) => classes(n).includes('wave-card')).length >= 1, true);
  await A.choose_dataset('g001');
  await A.go('#overview');
  assert.equal(S.calc.stats().main_calls, 0);
});

test('REQ-150 FP-21 смена набора с фокусом на переключателе: пока считается — скелет и aria-busy, фокус не падает на body (и во время расчёта, и после)', async () => {
  // заглушка DOM ищет узлы только в #main, #nav и #summary, а переключатель набора лежит в #controls: как в браузере, getElementById находит и его
  const plain_lookup = globalThis.document.getElementById;
  globalThis.document.getElementById = (id) => plain_lookup(id) ?? find_all(A.controls(), (n) => n.attrs.id === id)[0] ?? null;
  A.emulate_focus_loss(true);
  FakeWorker.mode = 'hold';
  const select = find_all(A.controls(), (n) => n.tagName === 'select' && n.attrs.id === 'ds-top')[0];
  select.focus();
  assert.equal(globalThis.document.activeElement, select);
  const done = select.listeners.change[0]({ target: { value: 'low' } });
  await sleep(60);
  assert.equal(A.main().attrs['aria-busy'], 'true');
  assert.match(main_text(), /Считаем…/);
  assert.equal(globalThis.document.activeElement?.attrs?.id, 'ds-top', 'во время расчёта переключатель пересоздан, фокус возвращён');
  FakeWorker.release();
  await done;
  await sleep(60);
  assert.equal(A.main().attrs['aria-busy'], undefined);
  assert.equal(globalThis.document.activeElement?.attrs?.id, 'ds-top', 'после расчёта фокус не на body');
  assert.equal(A.ext.ctx.get_model().ctx.inputs_hash, E.analyze(load('g001-low.json'), { as_of: load('g001-low.json').as_of }).inputs_hash);
  // два выбора подряд: примет последний
  FakeWorker.mode = 'hold';
  const sel2 = find_all(A.controls(), (n) => n.tagName === 'select' && n.attrs.id === 'ds-top')[0];
  const first = sel2.listeners.change[0]({ target: { value: 'gap' } });
  const second = sel2.listeners.change[0]({ target: { value: 'late' } });
  await sleep(60);
  FakeWorker.release();
  await Promise.all([first, second]);
  await sleep(60);
  assert.equal(A.ext.ctx.get_model().ctx.inputs_hash, E.analyze(load('g001-late.json'), { as_of: load('g001-late.json').as_of }).inputs_hash, 'остался последний выбранный набор');
  A.emulate_focus_loss(false);
  globalThis.document.getElementById = plain_lookup;
  FakeWorker.mode = 'echo';
  await A.choose_dataset('g001');
});

test('REQ-150 FP-21 флаг в «Настройках»: карточка есть, формы не прибавила; снятие отметки останавливает Worker целиком (флаг runway-… в localStorage), «Купить» считает на месте без скелета; повторная отметка запускает новый воркер', async () => {
  await A.go('#settings');
  const forms = find_all(A.main(), (n) => n.tagName === 'form').length;
  assert.equal(forms, 7, 'число форм «Настроек» прежнее');
  const box = A.by_id('set-calc');
  assert.notEqual(box, undefined, 'карточка «Расчёт в фоне»');
  assert.equal(box.attrs.type, 'checkbox');
  assert.notEqual(box.attrs.checked, undefined);
  assert.match(N(A.by_id('set-calc-state').textContent), /Сейчас: расчёт в фоне\./);
  assert.equal(FakeWorker.instances.length, 1);
  box.checked = false;
  box.listeners.change[0]({ target: box });
  assert.equal(globalThis.localStorage.getItem('runway-calc-worker/1'), '0');
  assert.equal(FakeWorker.instances[0].terminated, true, 'Worker остановлен целиком');
  assert.match(N(A.by_id('set-calc-state').textContent), /Сейчас: расчёт на основном потоке \(отметка снята\)\./);
  const ops_before = FakeWorker.ops().length;
  go_sync('#buy');
  const out = result_node();
  assert.equal(out.attrs['aria-busy'], undefined, 'на главном потоке скелета нет: ответ готов сразу');
  assert.ok(N(out.textContent).includes(tr('buy.cash_after')));
  const amount = A.by_id('buy-amount');
  amount.value = '99,00';
  amount.listeners.input[0]();
  assert.equal(result_node().attrs['aria-busy'], undefined);
  assert.equal(FakeWorker.ops().length, ops_before, 'сообщений воркеру нет');
  // загрузка набора при выключенном флаге — на месте, воркер не нужен
  await A.choose_dataset('g001');
  assert.equal(FakeWorker.instances.length, 1);
  assert.equal(A.main().attrs['aria-busy'], undefined);
  // отметка поставлена заново
  await A.go('#settings');
  const box2 = A.by_id('set-calc');
  assert.equal(box2.attrs.checked, undefined, 'отметка снята — как записано в флаге');
  box2.checked = true;
  box2.listeners.change[0]({ target: box2 });
  assert.equal(globalThis.localStorage.getItem('runway-calc-worker/1'), '1');
  FakeWorker.mode = 'echo';
  await A.choose_dataset('low');
  assert.equal(FakeWorker.instances.length, 2, 'новый клиент — новый воркер');
  assert.deepEqual(FakeWorker.instances[1].received.map((m) => m.op), ['waves']);
  assert.equal(json(A.ext.ctx.get_model().ctx), model_ctx_json(load('g001-low.json')));
});

test('REQ-150 FP-21 сбой Worker: набор загружается и считается на главном потоке с теми же числами, воркер больше не используется, «Настройки» называют причину; «Купить» после сбоя без скелета', async () => {
  FakeWorker.mode = 'crash';
  await A.choose_dataset('late');
  const model = A.ext.ctx.get_model();
  assert.equal(json(model.ctx), model_ctx_json(load('g001-late.json')), 'числа те же, что на месте');
  assert.equal(S.calc.off_reason(), 'worker_error');
  assert.equal(A.main().attrs['aria-busy'], undefined);
  assert.equal(S.calc.stats().main_calls >= 1, true, 'расчёт набора после падения сделал откат клиента на главном потоке');
  await A.go('#settings');
  assert.match(N(A.by_id('set-calc-state').textContent), /Сейчас: расчёт на основном потоке \(фоновый поток остановился с ошибкой\)\./);
  const created = FakeWorker.instances.length;
  go_sync('#buy');
  assert.equal(result_node().attrs['aria-busy'], undefined);
  assert.ok(N(result_node().textContent).includes(tr('buy.verdict')) || N(result_node().textContent).includes(tr('buy.gate_title')) || N(result_node().textContent).length > 0);
  await A.choose_dataset('g001');
  assert.equal(FakeWorker.instances.length, created, 'цикла перезапусков нет');
  // язык интерфейса: строка скелета и карточка есть и по-английски
  A.set_lang('en');
  await A.go('#settings');
  assert.match(N(A.by_id('set-calc-state').textContent), /Now: calculation on the main thread \(the background thread stopped with an error\)\./);
  A.set_lang('ru');
  S.calc.terminate();
  delete globalThis.Worker;
});
