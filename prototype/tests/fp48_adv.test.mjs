// fp48_adv.test.mjs — FP-48, независимая состязательная проверка (проверяющий, не автор): то, что тесты автора не покрывают. Приложение запускается как в браузере: с Worker (заглушка
// `FakeWorker` в режиме «отвечает»), поэтому расчёт экрана «Купить» и загрузка набора идут асинхронно, а не на месте, как в оснастке автора.
// (1) подпись источника данных: нет ложного «изменён» в покое — ни на одном из пяти встроенных наборов и ни на одном экране; правка с самой загрузки; файл «только для просмотра»;
//     безымянный файл при восстановлении; кнопка «Вернуть выбранный набор» рядом с пунктом «Мои данные».
// (3) подпись переноса: сдвиг назад и праздник календаря, не только воскресенье G-001.
// (4) «Горизонт»: одно число в шапке, «Настройках», «Запасе хода» и на листе при границах 1 и 365 дней и при другой дате расчёта; остаток расхождения — заголовок таблицы на «Обзоре».
// (5) живая область при расчёте в Worker: «+ Факт» и «Отменить» не затираются; действие, меняющее вердикт, — сообщение и вердикт.
// Известные недостатки были записаны тестами с пометкой `todo` (они проходили, когда дефект исправлен). FP-49 исправил все четыре (ADV-05, ADV-06, ADV-09, ADV-11) и снял пометки: названия прежние,
// у ADV-09 тело теперь проверяет заголовок «Таблица значений (58 строк: день расчёта и 57 дней вперёд)» — он сам объясняет разницу со шапкой (название теста допускает «или прямо объясняет разницу»).
// Браузер, серверы и сеть не запускаются.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/fp48_adv.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PROTO } from './sw_harness.mjs';
import { boot_app, find_all, N } from './dom_boot.mjs';

const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);
const W = await imp('demo', 'calc_worker.mjs');
const G = JSON.parse(fs.readFileSync(path.join(PROTO, 'data', 'g001.json'), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Глобальный `Worker`: отвечает в следующем такте таймера (как настоящий, но без потоков). Клиент создаёт его как `new Worker(url, {type: 'module'})`. */
class FakeWorker {
  constructor() { this.onmessage = null; this.onerror = null; this.onmessageerror = null; this.terminated = false; }
  postMessage(msg) {
    const reply = structuredClone(W.handle_message(structuredClone(msg)));
    setTimeout(() => { if (!this.terminated) this.onmessage?.({ data: reply }); }, 0);
  }
  terminate() { this.terminated = true; }
}
globalThis.Worker = FakeWorker;

const A = await boot_app();
const ctx = A.ext.ctx;
const settle = async (n = 6) => { for (let i = 0; i < n; i++) { await A.tick(); await wait(20); } };
const tr = (key, params) => N(A.I18N.t(ctx.lang(), key, params));
const live = () => N(A.byid.get('live').textContent);
const nav_button = (label) => find_all(A.nav(), (n) => n.tagName === 'button' && N(n.textContent) === label)[0];
const ds_select = (id = 'ds-top') => find_all(id === 'ds-top' ? A.controls() : A.main(), (n) => n.tagName === 'select' && n.attrs.id === id)[0];
const chosen = (id) => find_all(ds_select(id), (n) => n.tagName === 'option').filter((o) => o.attrs.selected !== undefined).map((o) => [o.attrs.value, N(o.textContent)]);
const option_count = () => find_all(ds_select(), (n) => n.tagName === 'option').length;
const reset = async (id = 'g001') => { await A.choose_dataset(id); await A.go('#overview'); await settle(); };
const header_li = () => find_all(A.summary(), (n) => n.tagName === 'li' && /^(?:горизонт|horizon) \d+ /.test(N(n.textContent)))[0];
const header_n = () => Number(/^(?:горизонт|horizon) (\d+) /.exec(N(header_li().textContent))[1]);
const BUILTIN = ['g001', 'low', 'gap', 'late', 'empty'];

// ═══ (1) подпись источника данных ═══════════════════════════════════════════════════════════════════════════════════════════

test('ADV-01 (1) правка прямо с загрузки страницы (без выбора набора вручную): «… · изменён» появляется, «Отменить» его снимает — следопыт видит первую загрузку набора', async () => {
  await settle();
  assert.deepEqual(chosen(), [['g001', 'G-001 — эталон']]);
  assert.equal(ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 61000 }).ok, true);
  await settle();
  assert.deepEqual(chosen(), [['custom', 'G-001 — эталон · изменён']]);
  A.click(nav_button('Отменить'));
  await settle();
  assert.deepEqual(chosen(), [['g001', 'G-001 — эталон']]);
});

test('ADV-02 (1) в покое нет ложного «изменён»: каждый из пяти встроенных наборов на каждом экране приложения называется своей подписью, выбран один пункт; EN тоже', async () => {
  const hrefs = find_all(A.nav(), (n) => n.tagName === 'a' && /^#/.test(n.attrs.href ?? '')).map((n) => n.attrs.href);
  assert.ok(hrefs.length >= 8, 'экранов в навигации: ' + hrefs.length);
  for (const id of BUILTIN) {
    await A.choose_dataset(id);
    await settle(3);
    const want = [[id, N(A.I18N.t('ru', 'ds.' + id))]];
    for (const href of hrefs) {
      await A.go(href);
      await settle(2);
      assert.deepEqual(chosen(), want, id + ' на ' + href);
    }
    assert.equal(option_count(), 5, id + ': пункта-источника нет');
    A.set_lang('en');
    assert.deepEqual(chosen(), [[id, N(A.I18N.t('en', 'ds.' + id))]], id + ' EN');
    A.set_lang('ru');
    await A.go('#data');
    await settle(2);
    assert.deepEqual(chosen('ds-sel'), want, id + ': экран «Данные»');
  }
  await reset();
});

test('ADV-03 (1) файл новее известного формата, открытый «только для просмотра»: «Файл: new.json», пометки «изменён» нет (правки отклонены); выбор встроенного набора возвращает обычный режим', async () => {
  await reset();
  const { export_journal_copy, events_of_ws } = await imp('demo', 'data_actions.mjs');
  const { canon } = await imp('engine', 'index.mjs');
  const obj = JSON.parse(export_journal_copy(events_of_ws(G)).text);
  obj.format = 'runway-journal/2';
  obj.engine_version = '0.2.0';
  const last = obj.events.at(-1).seq;
  obj.events.push({ actor: 'user', entity_id: 'cat-food', event_id: 'ev-x1', payload: { category_id: 'cat-food', name: 'Продукты' }, recorded_at: '2026-10-05T08:00:00Z', seq: last + 1, type: 'category.set', v: 1 });
  const text = canon(obj);
  await A.go('#data');
  const input = A.by_id('fp05-file');
  assert.ok(input !== undefined);
  input.files = [{ name: 'new.json', size: text.length, text: async () => text }];
  await input.listeners.change[0]();
  await settle();
  const btn = find_all(A.byid.get('dlg-body'), (n) => n.tagName === 'button' && N(n.textContent) === 'Открыть только для просмотра')[0];
  assert.ok(btn !== undefined, 'диалог предлагает просмотр');
  await btn.listeners.click[0]();
  await settle();
  assert.notEqual(ctx.read_only(), null, 'режим «только чтение» включён');
  assert.deepEqual(chosen(), [['custom', 'Файл: new.json']]);
  const refused = ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 62000 });
  assert.equal(refused.ok, false);
  await settle();
  assert.deepEqual(chosen(), [['custom', 'Файл: new.json']], 'отклонённая правка область не меняет — пометки нет');
  await A.choose_dataset('g001');
  await settle();
  assert.equal(ctx.read_only(), null);
  assert.deepEqual(chosen(), [['g001', 'G-001 — эталон']]);
});

test('ADV-04 (1) «Продолжить» поверх «изменён», затем возврат: подписи следуют за последним событием, а не за предыдущим (restore → набор → правка → restore)', async () => {
  await reset('low');
  assert.deepEqual(chosen(), [['low', 'G-001-low — впритык']]);
  const a = clone(ctx.get_ws()); a.params = { ...a.params, buffer_minor: 71000 };
  assert.equal(ctx.set_ws(a, { reason: 'restore' }).ok, true);
  assert.deepEqual(chosen(), [['custom', 'Мои данные (с устройства)']]);
  assert.equal(ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 72000 }).ok, true);
  await settle();
  assert.deepEqual(chosen(), [['custom', 'Мои данные (с устройства)']], 'данные с устройства пометки не получают');
  await A.choose_dataset('gap');
  await settle();
  assert.deepEqual(chosen(), [['gap', 'G-001-gap — не хватает']]);
  assert.equal(ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 73000 }).ok, true);
  await settle();
  assert.deepEqual(chosen(), [['custom', 'G-001-gap — не хватает · изменён']]);
  const b = clone(ctx.get_ws());
  assert.equal(ctx.set_ws(b, { reason: 'restore', origin: { kind: 'file', name: 'copy.json' } }).ok, true);
  assert.deepEqual(chosen(), [['custom', 'Файл: copy.json']]);
  await reset();
});

// FP-49: todo снят (label_of для источника «файл» без имени всегда отвечает «Загруженный файл»)
test('ADV-05 (1) «Восстановить из файла» безымянного файла: подпись не должна возвращаться к встроенному «G-001 — эталон» (данные не оттуда)', async () => {
  await reset();
  const w = clone(ctx.get_ws()); w.params = { ...w.params, buffer_minor: 63000 };
  assert.equal(ctx.set_ws(w, { reason: 'restore', origin: { kind: 'file', name: '' } }).ok, true);
  await settle();
  assert.notEqual(chosen()[0][1], 'G-001 — эталон', 'подпись называет встроенный набор, хотя данные из файла: ' + JSON.stringify(chosen()));
  await reset();
});

// FP-49: todo снят (при выбранном пункте-источнике кнопка отключена и рядом сказано «Нужно выбрать встроенный набор в списке выше.»)
test('ADV-06 (1) рядом с пунктом «Мои данные (с устройства)» кнопка «Вернуть выбранный набор» не должна молча подменять данные встроенным набором, которого в списке не выбрано', async () => {
  await reset();
  const mine = clone(ctx.get_ws()); mine.params = { ...mine.params, buffer_minor: 61000 };
  assert.equal(ctx.set_ws(mine, { reason: 'restore' }).ok, true);
  await A.go('#data');
  assert.deepEqual(chosen('ds-sel'), [['custom', 'Мои данные (с устройства)']]);
  const btn = find_all(A.main(), (n) => n.tagName === 'button' && N(n.textContent) === 'Вернуть выбранный набор')[0];
  assert.ok(btn !== undefined);
  if (btn.attrs.disabled === undefined) { await btn.listeners.click[0](); await settle(); }
  assert.equal(ctx.get_ws().params.buffer_minor, 61000, 'данные пользователя заменены встроенным набором: ' + JSON.stringify(chosen('ds-sel')));
  await reset();
});

// ═══ (3) подпись переноса ══════════════════════════════════════════════════════════════════════════════════════════════════

test('ADV-07 (3) date_by_rule: сдвиг назад (weekend: prev) и праздник календаря с переходом вперёд; запись о переносе не мешает; правило без календаря', async () => {
  const RULE = await imp('demo', 'form_rule.mjs');
  const rent = G.rules.find((r) => r.rule_id === 'R-RENT');
  const prev_rule = { ...rent, weekend: 'prev' };
  const ws_prev = { ...clone(G), rules: [prev_rule] };
  assert.equal(RULE.date_by_rule(ws_prev, prev_rule, '2026-10-25'), '2026-10-23', 'воскресенье 25-го при weekend: prev показывается пятницей 23-го');
  const ws_hol = clone(G);
  ws_hol.calendars = [{ ...ws_hol.calendars[0], holidays: ['2026-11-25'] }];
  assert.equal(RULE.date_by_rule(ws_hol, rent, '2026-11-25'), '2026-11-26', 'среда-праздник сдвигается на четверг');
  const moved = { ...ws_hol, overrides: [{ rule_id: 'R-RENT', nominal_date: '2026-11-25', action: 'move', date: '2026-12-02' }] };
  assert.equal(RULE.date_by_rule(moved, rent, '2026-11-25'), '2026-11-26', 'перенос не учитывается');
  const f = (await imp('demo', 'app.mjs')).make_fmt('ru', 'EUR', '2026-10-04');
  const ru = (key, p) => N(A.I18N.t('ru', key, p));
  assert.equal(N(RULE.moved_from_text(ru, f, '2026-11-26', '2026-11-25')), 'перенесено с 26 ноября (по правилу — 25 ноября)');
  const norule = { ...rent, calendar_id: 'нет-такого' };
  const r = RULE.date_by_rule({ ...clone(G), rules: [norule] }, norule, '2026-10-25');
  assert.ok(r === null || /^\d{4}-\d{2}-\d{2}$/.test(r), 'неизвестный календарь не роняет подпись: ' + r);
});

// ═══ (4) «Горизонт» ═══════════════════════════════════════════════════════════════════════════════════════════════════════

test('ADV-08 (4) «Горизонт»: шапка = «Сейчас задано» = поле = «Запас хода» = лист для печати при 1, 30 и 365 днях и при другой дате расчёта; RU и EN', async () => {
  await reset();
  for (const days of [1, 30, 365]) {
    assert.equal(ctx.edit({ type: 'set_param', key: 'horizon_days', value: days }).ok, true, 'горизонт ' + days);
    await settle();
    assert.equal(header_n(), days, 'шапка при горизонте ' + days);
    assert.equal(ctx.get_model().ctx.as_of + days, ctx.get_model().ctx.horizon_end);
    await A.go('#settings');
    await settle(2);
    assert.match(N(A.by_id('set-horizon-default').textContent), new RegExp('Сейчас задано: ' + days + ' ') );
    assert.equal(Number(A.by_id('set-horizon').value), days);
    assert.match(N(A.by_id('set-horizon-now').textContent), new RegExp('на ' + days + ' '));
    await A.go('#overview');
    await settle(2);
    const card = N(find_all(A.main(), (n) => n.className === 'card fp03-runway')[0].textContent);
    assert.match(card, new RegExp('Горизонт: ' + days + ' '));
    await A.go('#report');
    await settle(2);
    assert.match(N(A.main().textContent), new RegExp('горизонт до [^(]+\\(' + days + ' дн\\.\\)'));
    A.set_lang('en');
    assert.equal(header_n(), days, 'EN шапка');
    A.set_lang('ru');
  }
  // другая дата расчёта: тот же отрезок, тоже одно число
  assert.equal(ctx.edit({ type: 'set_param', key: 'horizon_days', value: 57 }).ok, true);
  assert.equal(ctx.edit({ type: 'set_as_of', date: '2026-10-10' }).ok, true);
  await settle();
  assert.equal(header_n(), 57);
  assert.equal(ctx.get_model().ctx.as_of + 57, ctx.get_model().ctx.horizon_end);
  await reset();
});

// FP-49: todo снят. Канон (03-ux-screens.md) называет таблицу «все 58 дней», поэтому поправлены слова, а не число: заголовок говорит о строках и сам объясняет разницу со шапкой —
// «Таблица значений (58 строк: день расчёта и 57 дней вперёд)»; число дней вперёд — то же, что в шапке, строк на одну больше (день расчёта). Прежнее тело теста сравнивало первое число скобки
// с шапкой и требовало бы «Таблица значений (57 …)»; название теста допускает «или прямо объясняет разницу», и тело проверяет именно это.
test('ADV-09 (4) на «Обзоре» заголовок таблицы значений называет то же число дней, что шапка (или прямо объясняет разницу)', async () => {
  await reset();
  await A.go('#overview');
  await settle();
  const caption = find_all(A.main(), (n) => n.tagName === 'summary').map((n) => N(n.textContent)).find((t) => /Таблица значений/.test(t));
  assert.ok(caption !== undefined);
  const parts = /\((\d+) [^:()]+: день расчёта и (\d+) [^:()]+ вперёд\)/.exec(caption);
  assert.ok(parts !== null, 'заголовок говорит о строках и объясняет разницу: «' + caption + '»');
  const [rows, ahead] = [Number(parts[1]), Number(parts[2])];
  assert.equal(ahead, header_n(), 'дней вперёд в заголовке таблицы — то же число, что в шапке: «' + caption + '», шапка: «' + N(header_li().textContent) + '»');
  assert.equal(rows, header_n() + 1, 'строк на одну больше дней вперёд: день расчёта');
});

// ═══ (5) живая область при расчёте в Worker ═══════════════════════════════════════════════════════════════════════════════

async function add_fact(amount) {
  A.click(nav_button('+ Факт'));
  const form = A.byid.get('dlg-body').children[0];
  find_all(form, (n) => n.attrs.id === 'entry-amount')[0].value = amount;
  await form.listeners.submit[0]({ preventDefault() {} });
}

test('ADV-10 (5) расчёт «Купить» в Worker (ответ приходит в другом такте): «+ Факт» и «Отменить» не затёрты вердиктом ни сразу, ни после ответа Worker и поздней перерисовки', async () => {
  await reset();
  await A.go('#buy');
  await settle();
  assert.equal(live(), 'Вердикт: хрупко');
  await add_fact('5,00');
  assert.match(live(), /^Добавлен расход /);
  await settle();
  assert.match(live(), /^Добавлен расход /, 'после ответа Worker: ' + live());
  assert.ok(!live().includes('Вердикт'));
  ctx.refresh();
  await settle();
  assert.match(live(), /^Добавлен расход /, 'после поздней перерисовки: ' + live());
  A.click(nav_button('Отменить'));
  await settle();
  assert.match(live(), /^Отменено: /, live());
  assert.ok(!live().includes('Вердикт'));
});

// FP-49: todo снят (страница помнит последнее сообщение и время его объявления: вердикт, пришедший позже в другом такте, встаёт после сообщения, если оно моложе 600 мс)
test('ADV-11 (5) расчёт в Worker: действие, меняющее вердикт, оставляет в живой области и сообщение, и новый вердикт (при расчёте на месте они идут вместе — при Worker вердикт приходит позже и заменяет сообщение)', async () => {
  await reset();
  await A.go('#buy');
  await settle();
  assert.equal(ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 100000 }).ok, true);
  ctx.notify('Сохранено.', 'info');
  await settle();
  assert.ok(live().includes('Сохранено.') && live().includes('Вердикт: впритык'), 'в живой области: «' + live() + '»');
  await reset();
});

test('ADV-12 (5) уход с «Купить» и возврат под Worker: вердикт называется заново один раз; смена набора данных — тоже; возврат не затирает сообщение, объявленное до перехода в том же такте', async () => {
  await reset();
  await A.go('#buy');
  await settle();
  assert.equal(live(), 'Вердикт: хрупко');
  await A.go('#overview');
  await settle();
  A.byid.get('live').textContent = 'сторожевое сообщение';
  await A.go('#buy');
  await settle();
  assert.equal(live(), 'Вердикт: хрупко', 'вернулись: вердикт назван заново');
  await A.choose_dataset('low');
  await settle();
  assert.match(live(), /^Вердикт: /);
  assert.equal((live().match(/Вердикт:/g) ?? []).length, 1);
  await reset();
});

// ═══ (2) отчёт об ошибке ══════════════════════════════════════════════════════════════════════════════════════════════════

test('ADV-13 (2) блок «Сообщить об ошибке» на экране: по согласию при пустом журнале — ровно «engine_version: …»; ошибка без кода — «code: E_UNKNOWN» остаётся', async () => {
  const { log } = await imp('demo', 'log.mjs');
  const { ENGINE_VERSION } = await imp('engine', 'index.mjs');
  log.clear();
  await A.go('#data');
  await settle(2);
  const agree = A.by_id('er-consent');
  assert.ok(agree !== undefined, 'блок есть на экране «Данные»');
  agree.checked = true;
  agree.listeners.change[0]();
  await settle(2);
  assert.equal(A.by_id('er-text').textContent, 'engine_version: ' + ENGINE_VERSION);
  assert.match(N(A.by_id('er-state').textContent), /ошибок не было|нет|пуст/i, 'состояние называет пустой журнал: ' + N(A.by_id('er-state').textContent));
  log.error('probe_failed', { n: 3 });
  ctx.refresh();
  await settle(2);
  assert.equal(A.by_id('er-text').textContent, 'n: 3\ncode: E_UNKNOWN\nengine_version: ' + ENGINE_VERSION);
  log.clear();
});
