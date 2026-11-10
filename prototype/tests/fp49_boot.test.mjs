// fp49_boot.test.mjs — FP-49 в настоящем app.mjs на заглушке DOM (оснастка — tests/dom_boot.mjs) с глобальным `Worker`, который отвечает НЕ сразу: ответ расчёта «Купить» приходит в другом такте,
// как в браузере. Браузер, серверы и сеть не запускаются.
// (2) ADV-11: живая область (#live) при расчёте в Worker — сообщение действия и вердикт, пришедший позже, идут вместе, сообщение первым; сообщение старше окна (≈ 600 мс) не дописывается;
//     без повторов; чужой текст в области, смена экрана и смена набора данных сообщение «забывают»; настоящее действие «Сверить остаток» и «Отменить».
//     Заглушка Worker держит ответы, пока тест их не отпустит (`HOLD`): порядок событий не зависит от скорости машины; возраст сообщения создаётся настоящим ожиданием дольше окна.
// (3) ADV-06: кнопка «Вернуть выбранный набор» на экране «Данные» отключена, когда в списке стоит пункт-источник (данные с устройства, файл, набор «· изменён»), рядом пояснение RU и EN.
// (4) ADV-05: «Восстановить из файла» без имени — «Загруженный файл», а не встроенный «G-001 — эталон».
// (7) одно число «дней вперёд» в шапке, «Настройках», «Запасе хода», на листе и в заголовке таблицы значений — то же, что даёт demo/horizon.mjs, при горизонте 1, 30, 365 и другой дате расчёта.
// Расчёт по введённым данным и правилам, не консультация. Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/fp49_boot.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { boot_app, find_all, N } from './dom_boot.mjs';

const PROTO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);
const W = await imp('demo', 'calc_worker.mjs');
const HZ = await imp('demo', 'horizon.mjs');
const clone = (x) => JSON.parse(JSON.stringify(x));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ответы Worker: пока `on`, они копятся в `pending` и уходят в страницу, когда тест их отпускает (`hold_then_release_after`); иначе — в следующем такте таймера, как у настоящего Worker. */
const HOLD = { on: false, pending: [] };

/** Глобальный `Worker`. Клиент создаёт его как `new Worker(url, {type: 'module'})`; сообщения считает настоящий обработчик `calc_worker.mjs`. */
class FakeWorker {
  constructor() { this.onmessage = null; this.onerror = null; this.onmessageerror = null; this.terminated = false; }
  postMessage(msg) {
    const reply = structuredClone(W.handle_message(structuredClone(msg)));
    const deliver = () => { if (!this.terminated) this.onmessage?.({ data: reply }); };
    if (HOLD.on) HOLD.pending.push(deliver); else setTimeout(deliver, 0);
  }
  terminate() { this.terminated = true; }
}
globalThis.Worker = FakeWorker;

const A = await boot_app();
const ctx = A.ext.ctx;
const settle = async (n = 6) => { for (let i = 0; i < n; i++) { await A.tick(); await wait(20); } };
const until = async (pred, ms = 5000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) assert.fail('не дождались'); await wait(5); } };
const live = () => N(A.byid.get('live').textContent);
const nav_button = (label) => find_all(A.nav(), (n) => n.tagName === 'button' && N(n.textContent) === label)[0];
const ds_select = (id = 'ds-top') => find_all(id === 'ds-top' ? A.controls() : A.main(), (n) => n.tagName === 'select' && n.attrs.id === id)[0];
const chosen = (id) => find_all(ds_select(id), (n) => n.tagName === 'option').filter((o) => o.attrs.selected !== undefined).map((o) => [o.attrs.value, N(o.textContent)]);
const shown_verdict = () => find_all(A.main(), (n) => /^verdict verdict-/.test(n.className)).map((n) => N(n.textContent).trim().replace(/^\S+\s/, ''))[0];
const reset = async (id = 'g001') => { HOLD.on = false; HOLD.pending.length = 0; await A.choose_dataset(id); await A.go('#overview'); await settle(); };

/**
 * Держать ответы Worker, выполнить `action` (правка и сообщение «в одном ходе»), дождаться, пока расчёт «Купить» дойдёт до Worker, выдержать `age_ms` (возраст сообщения) и отпустить ответы.
 * Возвращает текст живой области ДО ответа Worker; к возврату вердикт уже в области, а поздние перерисовки успели пройти.
 */
async function hold_then_release_after(action, { age_ms = 0 } = {}) {
  HOLD.on = true;
  action();
  await until(() => HOLD.pending.length > 0); // расчёт ушёл к Worker (через кадр ожидания) и ждёт ответа
  const before = live();
  if (age_ms > 0) await wait(age_ms);
  HOLD.on = false;
  const ps = HOLD.pending.splice(0);
  for (const deliver of ps) deliver();
  await until(() => live() !== before, 3000); // ответ → обещание клиента → показ ответа «Купить» → вердикт в живую область
  await wait(40); // и запас на поздние перерисовки: если бы что-то затёрло область, оно успело бы
  return before;
}

// ═══ (2) живая область при расчёте в Worker ═══════════════════════════════════════════════════════════════════════════════════

test('REQ-167 REQ-090 TST-58 (ADV-11) Worker отвечает позже действия: сообщение и новый вердикт идут вместе, сообщение первым; до ответа Worker в области одно сообщение', async () => {
  await reset();
  await A.go('#buy');
  await settle();
  assert.equal(live(), 'Вердикт: хрупко');
  const before = await hold_then_release_after(() => {
    assert.equal(ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 100000 }).ok, true);
    ctx.notify('Сохранено.', 'info');
  });
  assert.equal(before, 'Сохранено.', 'пока Worker не ответил, в области одно сообщение: ' + before);
  assert.notEqual(shown_verdict(), 'хрупко', 'вердикт изменился: проверка не пустая');
  assert.equal(live(), 'Сохранено. Вердикт: ' + shown_verdict(), 'вердикт пришёл позже в другом такте и встал после сообщения: ' + live());
  assert.equal((live().match(/Сохранено\./g) ?? []).length, 1, 'сообщение названо один раз');
  assert.equal((live().match(/Вердикт:/g) ?? []).length, 1, 'вердикт назван один раз');
  // поздняя перерисовка хранилища с тем же вердиктом ничего не добавляет и не убирает
  ctx.refresh();
  await settle();
  assert.equal(live(), 'Сохранено. Вердикт: ' + shown_verdict(), 'после поздней перерисовки: ' + live());
});

test('REQ-167 TST-58 (ADV-11) сообщение старше окна (≈ 600 мс) к вердикту не дописывается: оно уже прозвучало; вердикт называется один', async () => {
  await reset();
  await A.go('#buy');
  await settle();
  assert.equal(live(), 'Вердикт: хрупко');
  const before = await hold_then_release_after(() => {
    assert.equal(ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 100010 }).ok, true);
    ctx.notify('Сохранено.', 'info');
  }, { age_ms: 750 });
  assert.equal(before, 'Сохранено.');
  assert.notEqual(shown_verdict(), 'хрупко');
  assert.equal(live(), 'Вердикт: ' + shown_verdict(), 'Worker ответил через 750 мс: сообщение в область не вернулось: ' + live());
});

test('REQ-167 TST-58 (ADV-11) без повторов: сообщение стоит рядом с вердиктом один раз; следующий вердикт, пришедший в том же окне без нового сообщения, называется один — без повтора сообщения', async () => {
  await reset();
  await A.go('#buy');
  await settle();
  await hold_then_release_after(() => {
    assert.equal(ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 100020 }).ok, true);
    ctx.notify('Сохранено.', 'info');
  });
  const first = shown_verdict();
  assert.equal(live(), 'Сохранено. Вердикт: ' + first);
  // вердикт меняется ещё раз сразу же (в окне 600 мс), нового сообщения нет
  await hold_then_release_after(() => {
    assert.equal(ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 50020 }).ok, true);
  });
  assert.notEqual(shown_verdict(), first, 'вердикт изменился второй раз');
  assert.equal(live(), 'Вердикт: ' + shown_verdict(), 'сообщение уже стояло рядом с вердиктом и не повторяется: ' + live());
  // новое сообщение в следующем ходе заменяет прежнее, как раньше
  ctx.notify('Другое сообщение.', 'info');
  assert.equal(live(), 'Другое сообщение.');
  await settle();
  assert.equal(live(), 'Другое сообщение.');
});

test('REQ-167 TST-58 (ADV-11) сообщение забывается: чужой текст в области, уход на другой экран и смена набора данных не дают дописать его к вердикту', async () => {
  // чужой текст в области (другой модуль объявил своё): сообщение не воскресает поверх него
  await reset();
  await A.go('#buy');
  await settle();
  await hold_then_release_after(() => {
    assert.equal(ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 100030 }).ok, true);
    ctx.notify('Сохранено.', 'info');
    A.byid.get('live').textContent = 'чужой текст';
  });
  assert.equal(live(), 'Вердикт: ' + shown_verdict(), 'область уже занята чужим текстом: ' + live());
  // сообщение объявлено на «Обзоре», вердикт называется при входе на «Купить» — это другой экран
  await reset();
  assert.equal(ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 100040 }).ok, true);
  await settle();
  ctx.notify('Сообщение с обзора.', 'info');
  assert.equal(live(), 'Сообщение с обзора.');
  await A.go('#buy');
  await until(() => /Вердикт: /.test(live()));
  await settle();
  assert.equal(live(), 'Вердикт: ' + shown_verdict(), 'сообщение прежнего экрана к вердикту нового не дописано: ' + live());
  // сообщение объявлено, затем выбран другой набор данных: вердикт нового набора называется сам
  await reset();
  await A.go('#buy');
  await settle();
  ctx.notify('Сообщение до смены набора.', 'info');
  await A.choose_dataset('gap');
  await until(() => /Вердикт: /.test(live()));
  await settle();
  assert.match(live(), /^Вердикт: /, live());
  assert.ok(!live().includes('Сообщение до смены набора.'), live());
  await reset();
});

test('REQ-167 REQ-090 TST-58 (ADV-11) настоящее «Сверить остаток» на «Купить» при Worker: «Остаток сверен …» и новый вердикт — вместе; «Отменить» — «Отменено: …» и вердикт, вернувшийся к прежнему', async () => {
  await reset();
  await A.go('#buy');
  await settle();
  assert.equal(live(), 'Вердикт: хрупко');
  const submitted = await hold_then_release_after(() => {
    A.click(nav_button('Сверить остаток'));
    const form = A.byid.get('dlg-body').children[0];
    const amount = find_all(form, (n) => n.attrs.id === 'anchor-amount')[0];
    amount.value = '100,00';
    amount.listeners.input[0]();
    form.listeners.submit[0]({ preventDefault() {} });
  });
  assert.ok(submitted.startsWith('Остаток сверен: ') && !submitted.includes('Вердикт'), 'до ответа Worker — только сообщение о сверке: ' + submitted);
  assert.equal(shown_verdict(), 'не хватает', 'сверка на 100,00 € меняет вердикт');
  assert.match(live(), /^Остаток сверен: .+\. Вердикт: не хватает$/, 'сообщение о сверке не потеряно: ' + live());
  assert.equal((live().match(/Вердикт:/g) ?? []).length, 1);
  assert.equal((live().match(/Остаток сверен/g) ?? []).length, 1, 'и не повторено');
  // «Отменить»: сообщение об отмене и вердикт, вернувшийся к прежнему (ответ для прежних данных Worker уже считал и страница его помнит — вердикт приходит в том же ходе)
  A.click(nav_button('Отменить'));
  await settle();
  assert.equal(shown_verdict(), 'хрупко');
  assert.match(live(), /^Отменено: .+ Вердикт: хрупко$/, live());
  assert.equal((live().match(/Вердикт:/g) ?? []).length, 1);
  await reset();
});

// ═══ (3) кнопка «Вернуть выбранный набор» ══════════════════════════════════════════════════════════════════════════════════

const reset_button = () => find_all(A.main(), (n) => n.tagName === 'button' && n.attrs.id === 'ds-reset')[0];
const reset_hint = () => find_all(A.main(), (n) => n.attrs.id === 'ds-reset-hint')[0];
const is_disabled = (btn) => btn.attrs.disabled !== undefined;

test('REQ-125 TST-58 (ADV-06) выбран встроенный набор — кнопка «Вернуть выбранный набор» работает как раньше: включена, без пояснения, загружает выбранный набор заново', async () => {
  for (const id of ['g001', 'low']) {
    await reset(id);
    await A.go('#data');
    await settle(2);
    assert.deepEqual(chosen('ds-sel').map((c) => c[0]), [id]);
    const btn = reset_button();
    assert.ok(btn !== undefined, 'кнопка на экране');
    assert.equal(N(btn.textContent), 'Вернуть выбранный набор');
    assert.equal(is_disabled(btn), false, id + ': кнопка включена');
    assert.equal(btn.attrs['aria-describedby'], undefined);
    assert.equal(reset_hint(), undefined, id + ': пояснения нет');
    const before = ctx.get_ws();
    await btn.listeners.click[0]();
    await settle();
    assert.notEqual(ctx.get_ws(), before, id + ': набор загружен заново');
    assert.deepEqual(chosen('ds-sel').map((c) => c[0]), [id], id + ': и выбран тот же');
  }
  await reset();
});

// Исправление после независимой проверки (ADV-1): набор «G-001 — эталон · изменён» — НЕ пункт-источник, а правленая копия встроенного набора, названного в списке; кнопка у него включена и
// возвращает эталон (тесты — fp49_fix.test.mjs и fp49_adv.test.mjs ADV-1). Поэтому четвёртый случай прежней версии этого теста («встроенный набор после правки») убран из списка ниже;
// слова «набор «· изменён»» в названии теста устарели (название прежнее — правило о названиях тестов).
test('REQ-125 TST-58 (ADV-06) выбран пункт-источник — «Мои данные (с устройства)», «Файл: …», файл без имени, набор «· изменён»: кнопка отключена, рядом «Нужно выбрать встроенный набор в списке выше.»; данные не заменяются', async () => {
  const sources = [
    ['данные с устройства', () => { const w = clone(ctx.get_ws()); w.params = { ...w.params, buffer_minor: 61000 }; return ctx.set_ws(w, { reason: 'restore' }); }, 'Мои данные (с устройства)', 61000],
    ['файл с именем', () => { const w = clone(ctx.get_ws()); w.params = { ...w.params, buffer_minor: 62000 }; return ctx.set_ws(w, { reason: 'restore', origin: { kind: 'file', name: 'moi.json' } }); }, 'Файл: moi.json', 62000],
    ['файл без имени', () => { const w = clone(ctx.get_ws()); w.params = { ...w.params, buffer_minor: 63000 }; return ctx.set_ws(w, { reason: 'restore', origin: { kind: 'file', name: '' } }); }, 'Загруженный файл', 63000],
    ['файл после правки', () => { const w = clone(ctx.get_ws()); w.params = { ...w.params, buffer_minor: 64000 }; const r = ctx.set_ws(w, { reason: 'restore', origin: { kind: 'file', name: 'moi.json' } }); return r.ok ? ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 64500 }) : r; }, 'Файл: moi.json · изменён', 64500],
  ];
  for (const [label, make, text, buffer] of sources) {
    await reset();
    assert.equal(make().ok, true, label);
    await A.go('#data');
    await settle(2);
    assert.deepEqual(chosen('ds-sel'), [['custom', text]], label);
    const btn = reset_button();
    assert.equal(is_disabled(btn), true, label + ': кнопка отключена');
    const hint = reset_hint();
    assert.ok(hint !== undefined, label + ': пояснение есть');
    assert.equal(N(hint.textContent), 'Нужно выбрать встроенный набор в списке выше.');
    assert.equal(btn.attrs['aria-describedby'], 'ds-reset-hint', label + ': кнопка связана с пояснением');
    assert.equal(hint.attrs.id, 'ds-reset-hint');
    // даже если обработчик вызвать напрямую, встроенный набор данные не заменит
    const before = ctx.get_ws();
    await btn.listeners.click[0]();
    await settle();
    assert.equal(ctx.get_ws(), before, label + ': данные те же объекты');
    assert.equal(ctx.get_ws().params.buffer_minor, buffer, label + ': данные пользователя на месте');
    assert.deepEqual(chosen('ds-sel'), [['custom', text]], label + ': и подпись прежняя');
  }
  await reset();
});

test('REQ-125 TST-58 (ADV-06) пояснение и подпись кнопки — RU и EN; выбор встроенного набора в списке включает кнопку и убирает пояснение; пункт-источник в списке ничего не загружает', async () => {
  await reset();
  const w = clone(ctx.get_ws());
  w.params = { ...w.params, buffer_minor: 65000 };
  assert.equal(ctx.set_ws(w, { reason: 'restore' }).ok, true);
  await A.go('#data');
  await settle(2);
  A.set_lang('en');
  assert.equal(N(reset_button().textContent), 'Reset the selected set');
  assert.equal(is_disabled(reset_button()), true);
  assert.equal(N(reset_hint().textContent), 'A built-in set must be selected in the list above.');
  assert.deepEqual(chosen('ds-sel'), [['custom', 'My data (from this device)']]);
  A.set_lang('ru');
  assert.equal(N(reset_hint().textContent), 'Нужно выбрать встроенный набор в списке выше.');
  // пункт-источник ничего не загружает
  const sel = ds_select('ds-sel');
  sel.value = 'custom';
  const before = ctx.get_ws();
  await sel.listeners.change[0]();
  await settle();
  assert.equal(ctx.get_ws(), before);
  assert.equal(is_disabled(reset_button()), true, 'кнопка по-прежнему отключена');
  // выбран встроенный набор — кнопка включается, пояснения нет
  const sel2 = ds_select('ds-sel');
  sel2.value = 'low';
  await sel2.listeners.change[0]();
  await settle();
  assert.deepEqual(chosen('ds-sel').map((c) => c[0]), ['low']);
  assert.equal(is_disabled(reset_button()), false);
  assert.equal(reset_hint(), undefined);
  assert.notEqual(ctx.get_ws().params.buffer_minor, 65000, 'загружен встроенный набор');
  await reset();
});

test('REQ-167 TST-58 (урок 10) «Вернуть выбранный набор» заменяет экран вместе с кнопкой: фокус возвращается на новую кнопку, а не падает на body — и при расчёте в Worker, и при расчёте на месте', async () => {
  const { calc } = await imp('demo', 'calc_async.mjs'); // та же служба, что у приложения (один модуль)
  try {
    // сначала расчёт на месте: запрос фокуса живёт 3 с (FOCUS_WINDOW_MS) и иначе «достался» бы от прогона с Worker, где его делает сама загрузка набора
    for (const worker_on of [false, true]) {
      calc.set_enabled(worker_on);
      await reset();
      await A.go('#data');
      await settle(2);
      const btn = reset_button();
      btn.focus();
      assert.equal(globalThis.document.activeElement, btn);
      A.emulate_focus_loss(true); // как в браузере: узел, убранный перерисовкой, роняет фокус на body
      try {
        await btn.listeners.click[0]();
        await settle();
        const now = reset_button();
        assert.ok(now !== undefined && now !== btn, 'экран перерисован: кнопка новая (Worker ' + worker_on + ')');
        assert.equal(globalThis.document.activeElement, now, 'фокус на новой кнопке (Worker ' + worker_on + ')');
      } finally { A.emulate_focus_loss(false); }
    }
  } finally { calc.set_enabled(true); }
  await reset();
});

// ═══ (4) «Восстановить из файла» без имени ═══════════════════════════════════════════════════════════════════════════════════

test('REQ-125 REQ-122 TST-56 (ADV-05) безымянный файл при восстановлении: переключатель «Набор данных» называет «Загруженный файл» (EN — «Uploaded file»), после правки — «· изменён»; выбор встроенного набора возвращает его подпись', async () => {
  await reset();
  const w = clone(ctx.get_ws());
  w.params = { ...w.params, buffer_minor: 66000 };
  assert.equal(ctx.set_ws(w, { reason: 'restore', origin: { kind: 'file', name: '' } }).ok, true);
  await settle();
  assert.deepEqual(chosen(), [['custom', 'Загруженный файл']], 'не встроенный «G-001 — эталон»');
  A.set_lang('en');
  assert.deepEqual(chosen(), [['custom', 'Uploaded file']]);
  A.set_lang('ru');
  assert.equal(ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 66500 }).ok, true);
  await settle();
  assert.deepEqual(chosen(), [['custom', 'Загруженный файл · изменён']]);
  A.click(nav_button('Отменить'));
  await settle();
  assert.deepEqual(chosen(), [['custom', 'Загруженный файл']], '«Отменить» до принятых данных пометку снимает');
  await A.choose_dataset('g001');
  await settle();
  assert.deepEqual(chosen(), [['g001', 'G-001 — эталон']]);
});

// ═══ (7) одно число «дней вперёд» ═══════════════════════════════════════════════════════════════════════════════════════════

const header_li = () => find_all(A.summary(), (n) => n.tagName === 'li' && /^(?:горизонт|horizon) \d+ /.test(N(n.textContent)))[0];
const header_n = () => Number(/^(?:горизонт|horizon) (\d+) /.exec(N(header_li().textContent))[1]);
const caption_text = () => find_all(A.main(), (n) => n.tagName === 'summary').map((n) => N(n.textContent)).find((t) => /Таблица значений|Table of values/.test(t));

test('REQ-019 TST-58 FP-49: горизонт-модуль, шапка, «Настройки» (текст и поле), «Запас хода», лист для печати и заголовок таблицы значений называют одно число дней вперёд при 1, 30, 365 днях и другой дате расчёта; строк в таблице на одну больше', async () => {
  await reset();
  const cases = [{ days: 1 }, { days: 30 }, { days: 365 }, { days: 57, as_of: '2026-10-10' }];
  for (const c of cases) {
    assert.equal(ctx.edit({ type: 'set_param', key: 'horizon_days', value: c.days }).ok, true, 'горизонт ' + c.days);
    if (c.as_of !== undefined) assert.equal(ctx.edit({ type: 'set_as_of', date: c.as_of }).ok, true);
    await settle();
    const n = HZ.horizon_ahead_of(ctx.get_model().ctx.series);
    assert.equal(n, c.days, 'горизонт-модуль');
    assert.equal(header_n(), n, 'шапка');
    await A.go('#settings');
    await settle(2);
    assert.equal(Number(/на (\d+) /.exec(N(A.by_id('set-horizon-now').textContent))[1]), n, '«Настройки»: сейчас прогноз идёт на N дней вперёд');
    assert.equal(Number(A.by_id('set-horizon').value), n, '«Настройки»: поле');
    await A.go('#overview');
    await settle(2);
    const card = N(find_all(A.main(), (x) => x.className === 'card fp03-runway')[0].textContent);
    assert.equal(Number(/Горизонт: (\d+) /.exec(card)[1]), n, '«Запас хода»');
    const cap = caption_text();
    assert.ok(cap !== undefined, 'заголовок таблицы значений');
    const parts = /\((\d+) [^:()]+: день расчёта и (\d+) [^:()]+ вперёд\)/.exec(cap);
    assert.ok(parts !== null, 'заголовок: ' + cap);
    assert.equal(Number(parts[2]), n, 'заголовок таблицы: дней вперёд');
    assert.equal(Number(parts[1]), n + 1, 'заголовок таблицы: строк на одну больше');
    const values = find_all(A.main(), (x) => x.tagName === 'details' && x.className === 'card values')[0];
    assert.equal(find_all(values, (x) => x.tagName === 'tbody')[0].children.length, n + 1, 'и в таблице столько строк');
    await A.go('#report');
    await settle(2);
    assert.match(N(A.main().textContent), new RegExp('горизонт до [^(]+\\(' + n + ' дн\\.\\)'), 'лист для печати');
  }
  await reset();
});
