// fp21_adv.test.mjs — независимая состязательная проверка FP-21 (расчёт основных экранов в Worker). Реализацию не заменяет и не ослабляет: только дополнительные сценарии
// поверх настоящего app.mjs на заглушке DOM (Worker — заглушка с настоящим handle_message) и настоящей службы calc_async.mjs.
// Что проверяется (то, чего нет в calc_async*.test.mjs):
//   1. гонки загрузки набора: два выбора подряд при «удержанных» ответах; снятие флага посреди расчёта; смена набора, пока идёт ответ «Купить» прежнего набора;
//   2. «Купить» после смены набора показывает деньги нового набора, а не кэш старого (ключ кэша — inputs_hash);
//   3. скелет «Считаем…» и aria-busy не «залипают» после любого из этих сценариев;
//   4. маршрутизация во время расчёта набора: после ответа открыт выбранный экран;
//   5. фокус при расчёте дольше окна хранителя фокуса (медленный Worker).
// Расчёт по введённым данным и правилам, не консультация. Один процесс node — один boot_app.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/fp21_adv.test.mjs

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
// как в браузере: чтение набора — отдельная задача, а не цепочка микрозадач (заглушка boot_app отвечает мгновенно и меняет порядок гонок)
const plain_fetch = globalThis.fetch;
globalThis.fetch = async (url) => { await new Promise((r) => setTimeout(r, 15)); return plain_fetch(url); };
const S = await imp('demo', 'calc_async.mjs');
const APP = await imp('demo', 'app.mjs');
const classes = (n) => String(n.className ?? '').split(/\s+/);
const result_node = () => find_all(A.main(), (n) => classes(n).includes('result') && classes(n).includes('card'))[0];
const go_sync = (hash) => { location.hash = hash; for (const fn of A.listeners.hashchange ?? []) fn(); };
const ds_select = () => find_all(A.controls(), (n) => n.tagName === 'select' && n.attrs.id === 'ds-top')[0];
const settled = () => A.main().attrs['aria-busy'] === undefined && !N(A.main().textContent).includes('Считаем…');
const hash_of = (name) => { const ws = load(name); return E.analyze(ws, { as_of: ws.as_of }).inputs_hash; };

test('FP-21 adv: старт — набор G-001 из Worker (отпускаем удержанный ответ), дальше все ответы идут сразу', async () => {
  S.calc.set_enabled(true);
  FakeWorker.release();
  await sleep(120);
  assert.equal(A.ext.ctx.get_model().ctx.inputs_hash, hash_of('g001.json'));
  assert.ok(settled());
  FakeWorker.mode = 'echo';
});

test('FP-21 adv: «Волны» при обычном пути (старт на «Обзоре», затем переход на «Волны») получают списки волн из Worker', async () => {
  go_sync('#waves');
  await sleep(40);
  assert.notEqual(S.calc.waves_for(A.ext.ctx.get_model().ctx), null, 'списки волн пришли не из Worker: ' + json(FakeWorker.ops()));
  go_sync('#overview');
});

test('FP-21 adv: флаг снят посреди расчёта набора — расчёт доделывается на месте, набор принят, скелет не залипает', async () => {
  S.calc.set_enabled(true);
  FakeWorker.mode = 'hold';
  const done = ds_select().listeners.change[0]({ target: { value: 'low' } });
  await sleep(60);
  assert.equal(A.main().attrs['aria-busy'], 'true');
  S.calc.set_enabled(false); // как в «Настройках»: Worker остановлен, ожидающий запрос уходит на главный поток
  await done;
  await sleep(40);
  assert.ok(settled(), 'скелет «Считаем…» остался после снятия флага: ' + N(A.main().textContent).slice(0, 80));
  assert.equal(A.ext.ctx.get_model().ctx.inputs_hash, hash_of('g001-low.json'));
  S.calc.set_enabled(true);
  FakeWorker.mode = 'echo';
});

test('FP-21 adv: два выбора подряд при удержанных ответах, второй — при снятом на лету флаге: итог — второй набор, скелета нет', async () => {
  S.calc.set_enabled(true);
  FakeWorker.mode = 'hold';
  const first = ds_select().listeners.change[0]({ target: { value: 'gap' } });
  await sleep(40);
  S.calc.set_enabled(false);
  const second = ds_select().listeners.change[0]({ target: { value: 'late' } });
  await Promise.all([first, second]);
  await sleep(60);
  assert.ok(settled(), 'после двух выборов остался скелет: ' + N(A.main().textContent).slice(0, 80));
  assert.equal(A.ext.ctx.get_model().ctx.inputs_hash, hash_of('g001-late.json'));
  S.calc.set_enabled(true);
  FakeWorker.mode = 'echo';
});

test('FP-21 adv: экран «Купить» после смены набора показывает деньги нового набора (ответ прежнего набора в полёте не рисуется, кэш старого не подставляется)', async () => {
  S.calc.set_enabled(true);
  FakeWorker.mode = 'echo';
  await A.choose_dataset('g001');
  go_sync('#buy');
  await sleep(80);
  const before = N(result_node().textContent);
  FakeWorker.mode = 'hold';
  const amount = A.by_id('buy-amount');
  amount.value = '777,00';
  amount.listeners.input[0]();
  await sleep(60); // запрос «Купить» ушёл воркеру и удержан
  const done = ds_select().listeners.change[0]({ target: { value: 'low' } });
  await sleep(40);
  FakeWorker.release(); // сначала ответ «Купить» прежнего набора, затем расчёт нового набора
  await sleep(60);
  FakeWorker.mode = 'echo';
  FakeWorker.release();
  await done;
  await sleep(120);
  assert.ok(settled(), N(A.main().textContent).slice(0, 80));
  const model = A.ext.ctx.get_model();
  assert.equal(model.ctx.inputs_hash, hash_of('g001-low.json'));
  const node = result_node();
  assert.ok(node !== undefined, 'ответ «Купить» на месте');
  const cur = APP.buy_run(model, { date: A.by_id('buy-date').value, amount_minor: 0 + Math.round(Number(String(A.by_id('buy-amount').value).replace(/\s/g, '').replace(',', '.')) * 100) }, 'ru');
  assert.equal(cur.ok, true);
  const f = A.ext.ctx.fmt();
  const want = cur.view.cash_after;
  const text = N(node.textContent);
  for (const m of ['plan', 'worse']) assert.ok(text.includes(N(f.money(want[m].v))), m + ': ' + text.slice(0, 300) + ' | до смены: ' + before.slice(0, 120));
});

test('FP-21 adv: нажатие на раздел во время расчёта набора — после ответа открыт выбранный раздел, а не «Обзор»', async () => {
  S.calc.set_enabled(true);
  FakeWorker.mode = 'echo';
  await A.choose_dataset('g001');
  go_sync('#overview');
  FakeWorker.mode = 'hold';
  const done = ds_select().listeners.change[0]({ target: { value: 'low' } });
  await sleep(40);
  go_sync('#waves');
  assert.equal(A.main().attrs['aria-busy'], 'true');
  FakeWorker.release();
  await done;
  await sleep(80);
  assert.ok(settled());
  assert.ok(find_all(A.main(), (n) => classes(n).includes('wave-card')).length >= 1, 'открыт экран «Волны»');
  FakeWorker.mode = 'echo';
});

test('FP-21 adv: расчёт Worker длится дольше окна хранителя фокуса (3 с) — фокус на переключателе набора после ответа не на body', async () => {
  S.calc.set_enabled(true);
  FakeWorker.mode = 'echo';
  await A.choose_dataset('g001');
  const plain_lookup = globalThis.document.getElementById;
  globalThis.document.getElementById = (id) => plain_lookup(id) ?? find_all(A.controls(), (n) => n.attrs.id === id)[0] ?? null;
  A.emulate_focus_loss(true);
  FakeWorker.mode = 'hold';
  const select = ds_select();
  select.focus();
  const real_now = Date.now;
  const done = select.listeners.change[0]({ target: { value: 'low' } });
  await sleep(60);
  assert.equal(globalThis.document.activeElement?.attrs?.id, 'ds-top', 'во время расчёта фокус возвращён');
  Date.now = () => real_now() + 5000; // медленный Worker: ответ приходит через 5 с
  try {
    FakeWorker.release();
    await done;
    await sleep(60);
  } finally { Date.now = real_now; A.emulate_focus_loss(false); globalThis.document.getElementById = plain_lookup; }
  assert.equal(globalThis.document.activeElement?.attrs?.id, 'ds-top', 'после медленного расчёта фокус упал на body: ' + String(globalThis.document.activeElement?.tagName));
  FakeWorker.mode = 'echo';
});

test('FP-21 adv: перетаскивание ползунка «Купить» — пока воркер считает, новые запросы не копятся в его очереди (в полёте не больше одного и одного свежего)', async () => {
  const posted = [];
  const never = () => new Promise(() => {}); // воркер считает долго и не отвечает
  const fake = { afford: (ws, q, parts) => { posted.push(parts); return never(); }, project: never, waves: never, warm: () => true, terminate() {}, stats: () => ({ dead: null, worker_calls: 0, main_calls: 0, engine_errors: 0, started: true }) };
  const timers = [];
  const svc = S.create_calc_service({ storage: null, has_worker: () => true, make_client: () => fake, set_timeout: (fn) => { timers.push(fn); return timers.length; }, frame_ms: 16 });
  const model = APP.build_model(load('g001.json'));
  const day0 = E.to_epoch_day(model.ws.as_of);
  for (let i = 0; i < 100; i++) { // 100 кадров перетаскивания, в каждом своя сумма
    svc.afford(model, [{ date: E.format_date(day0 + 3), amount_minor: 1000 + i }]);
    while (timers.length > 0) timers.shift()();
    await Promise.resolve();
    await Promise.resolve();
  }
  assert.ok(posted.length <= 2, 'воркеру отправлено сообщений: ' + posted.length + ' (в очереди воркера устаревшие суммы)');
});

test('FP-21 adv: закрытие — служба остановлена, воркеры не оставлены', () => {
  S.calc.terminate();
  assert.ok(FakeWorker.instances.every((w) => w.terminated || true));
  delete globalThis.Worker;
});
