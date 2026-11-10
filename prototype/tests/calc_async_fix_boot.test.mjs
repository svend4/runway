// calc_async_fix_boot.test.mjs — FP-21, REQ-150: исправления по независимой проверке в НАСТОЯЩЕМ app.mjs на заглушке DOM (Worker — заглушка с настоящим `handle_message`, как в
// calc_async_boot.test.mjs: режимы «держит ответы» hold и «отвечает» echo). Проверяется:
//   1. «Волны» при обычном пути (приложение стартует на «Обзоре», потом переход на «Волны»): списки волн пришли из Worker вместе с расчётом набора (операция waves — надмножество
//      project), второго расчёта нет, на главном потоке ничего не считалось, числа канона на месте и побайтно равны посчитанным на месте;
//   2. устаревшая загрузка не оставляет скелет «Считаем…»: если новая загрузка закончилась раньше старой, последняя из параллельных перерисовывает экран;
//   3. исключение при отрисовке скелета не оставляет счётчик «занято» поднятым: набор принимается, скелета нет;
//   4. тексты: карточка «Расчёт в фоне» называет, что идёт в фон, а что остаётся на основном потоке (RU и EN); экран «О проекте» больше не утверждает, что основные экраны считают
//      на основном потоке.
// Расчёт по введённым данным и правилам, не консультация. Один процесс node — один boot_app.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/calc_async_fix_boot.test.mjs

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
const json = (x) => JSON.stringify(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const load = (name) => JSON.parse(fs.readFileSync(path.join(PROTO, 'data', name), 'utf8'));

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
const classes = (n) => String(n.className ?? '').split(/\s+/);
const ds_select = () => find_all(A.controls(), (n) => n.tagName === 'select' && n.attrs.id === 'ds-top')[0];
const settled = () => A.main().attrs['aria-busy'] === undefined && !N(A.main().textContent).includes('Считаем…');
const hash_of = (name) => { const ws = load(name); return E.analyze(ws, { as_of: ws.as_of }).inputs_hash; };

test('REQ-150 FP-21 «Волны» при обычном пути: старт на «Обзоре», переход на «Волны» — списки волн из Worker вместе с расчётом набора (waves), второго расчёта нет, на главном потоке ничего не считалось', async () => {
  assert.deepEqual(FakeWorker.ops(), ['waves'], 'при загрузке набора просят надмножество project: расчёт и списки волн');
  FakeWorker.release();
  await sleep(120);
  assert.ok(settled());
  const model = A.ext.ctx.get_model();
  assert.notEqual(S.calc.waves_for(model.ctx), null, 'списки волн пришли вместе с расчётом набора (экран при загрузке был «Обзор»)');
  assert.match(N(A.main().textContent), /1 830,00 €/, '«Обзор»: узкая точка «если хуже» канона');
  await A.go('#waves');
  const cards = find_all(A.main(), (n) => classes(n).includes('wave-card'));
  assert.equal(cards.length, 2, 'две волны канона');
  assert.match(N(A.main().textContent), /152 000,00 €|1 520,00 €/, 'волна W1 канона');
  assert.deepEqual(FakeWorker.ops(), ['waves'], 'переход на «Волны» нового сообщения воркеру не потребовал');
  assert.equal(S.calc.stats().main_calls, 0, 'клиент ничего не считал на главном потоке');
  assert.equal(json(APP.waves_model(model, 'ru')), json(APP.waves_model(APP.build_model(structuredClone(load('g001.json'))), 'ru')), 'списки волн из Worker = посчитанные на месте, побайтно');
  await A.go('#overview');
  FakeWorker.mode = 'echo';
});

test('REQ-150 FP-21 устаревшая загрузка: новая закончилась раньше старой (флаг снят на лету) — экран не остаётся на скелете «Считаем…», итог — последний выбранный набор', async () => {
  S.calc.set_enabled(true);
  FakeWorker.mode = 'hold';
  const first = ds_select().listeners.change[0]({ target: { value: 'gap' } });
  await sleep(40); // расчёт первой загрузки идёт у воркера и держится
  assert.equal(A.main().attrs['aria-busy'], 'true');
  S.calc.set_enabled(false); // воркер остановлен, ожидающий расчёт первой загрузки уходит на главный поток
  const second = ds_select().listeners.change[0]({ target: { value: 'late' } }); // без Worker: принимается без расчёта в фоне
  await Promise.all([first, second]);
  await sleep(40);
  assert.ok(settled(), 'после двух загрузок остался скелет: ' + N(A.main().textContent).slice(0, 80));
  assert.equal(A.ext.ctx.get_model().ctx.inputs_hash, hash_of('g001-late.json'));
  S.calc.set_enabled(true);
  FakeWorker.mode = 'echo';
});

test('REQ-150 FP-21 исключение при отрисовке скелета: счётчик «занято» снимается, набор принимается, экран не остаётся на «Считаем…» и не показывает ошибку загрузки', async () => {
  FakeWorker.mode = 'echo';
  const doc = globalThis.document;
  let boom = true;
  let title = doc.title;
  Object.defineProperty(doc, 'title', { configurable: true, get: () => title, set: (v) => { if (boom) { boom = false; throw new Error('сбой отрисовки'); } title = v; } });
  try {
    await A.choose_dataset('low');
    await sleep(60);
  } finally { Object.defineProperty(doc, 'title', { configurable: true, writable: true, value: title }); }
  assert.equal(boom, false, 'сбой был: первая отрисовка в prepare_model бросила исключение');
  assert.ok(settled(), 'скелет остался: ' + N(A.main().textContent).slice(0, 80));
  assert.equal(find_all(A.main(), (n) => n.attrs.role === 'alert').length, 0, 'ошибки загрузки на экране нет');
  assert.equal(A.ext.ctx.get_model().ctx.inputs_hash, hash_of('g001-low.json'), 'набор принят');
  await A.choose_dataset('g001');
});

test('REQ-150 FP-21 тексты: карточка «Расчёт в фоне» называет, что идёт в фон и что остаётся на основном потоке (RU и EN); «О проекте» не утверждает, что основные экраны считают на основном потоке', async () => {
  const calc_cat = (await imp('demo', 'i18n', 'calc.mjs')).default;
  const about_cat = (await imp('demo', 'i18n', 'about.mjs')).default;
  const ru = calc_cat.ru['calc.lead'];
  for (const word of ['загрузка и смена набора', 'импорт файла', '«Купить»', 'Восстановление данных из хранилища', 'правки через формы', 'сценарии', '«Отменить»', 'основном потоке']) assert.ok(ru.includes(word), 'RU: нет «' + word + '»');
  const en = calc_cat.en['calc.lead'];
  for (const word of ['loading and switching a data set', 'importing a file', 'purchase check', 'Restoring data from storage', 'edits through the forms', 'scenarios', 'Undo', 'main thread']) assert.ok(en.includes(word), 'EN: нет «' + word + '»');
  assert.ok(!/по-прежнему считают/.test(about_cat.ru['about.calc_lead']), 'RU: прежнее утверждение убрано');
  assert.ok(!/still calculate/.test(about_cat.en['about.calc_lead']), 'EN: прежнее утверждение убрано');
  assert.match(about_cat.ru['about.calc_lead'], /считают в фоне/);
  assert.match(about_cat.en['about.calc_lead'], /calculate in the background/);
  S.calc.terminate();
  delete globalThis.Worker;
});
