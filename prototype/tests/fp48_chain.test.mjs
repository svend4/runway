// fp48_chain.test.mjs — FP-48 на настоящей цепочке хранилища (FP-05) в настоящем app.mjs на заглушке DOM (оснастка — tests/dom_boot.mjs, localStorage-двойник):
// запись факта запускает настоящую среду хранилища, и она САМА просит страницу перерисоваться (ctx.refresh) — поздняя перерисовка экрана «Купить» раньше затирала
// «Добавлен расход …» и «Отменено: …» словами «Вердикт: …» (5); «Продолжить с сохранённого» и «Начать с текущего набора» оставляют в переключателе «Набор данных» честную подпись (1).
// Файл отдельный от fp48_boot: среда хранилища здесь начинает с пустого хранилища, и тесты идут по порядку (каждый опирается на состояние предыдущего).
// Браузер, серверы и сеть не запускаются. Расчёт по введённым данным и правилам, не консультация. Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/fp48_chain.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { boot_app, find_all, N, DEMO } from './dom_boot.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const A = await boot_app();
const ctx = A.ext.ctx;
const settle = async () => { for (let i = 0; i < 6; i++) { await A.tick(); await wait(20); } };
const nav_button = (label) => find_all(A.nav(), (n) => n.tagName === 'button' && N(n.textContent) === label)[0];
const live = () => N(A.byid.get('live').textContent);
const ds_options = () => find_all(find_all(A.controls(), (n) => n.tagName === 'select' && n.attrs.id === 'ds-top')[0], (n) => n.tagName === 'option').map((o) => ({ value: o.attrs.value, text: N(o.textContent), selected: o.attrs.selected !== undefined }));
const chosen = () => ds_options().filter((o) => o.selected).map((o) => [o.value, o.text]);

/** Записать расход через «+ Факт»; возвращает, перерисовала ли страница ещё раз ПОЗЖЕ записи (так делает хранилище: ctx.refresh после каждой записи). */
async function add_expense(amount) {
  A.click(nav_button('+ Факт'));
  const form = A.byid.get('dlg-body').children[0];
  find_all(form, (n) => n.attrs.id === 'entry-amount')[0].value = amount;
  form.listeners.submit[0]({ preventDefault() {} }); // синхронно: запись, перерисовка страницей и сообщение — в этом ходе
  const right_after = A.by_id('buy-amount');
  await settle();
  return { late_render: A.by_id('buy-amount') !== right_after };
}

test('REQ-167 REQ-090 REQ-122 TST-58 настоящее хранилище: «+ Факт» на экране «Купить» — «Добавлен расход …» остаётся в живой области после поздней перерисовки, которую хранилище просит само; «Отменить» — то же', async () => {
  await A.choose_dataset('g001');
  await A.go('#buy');
  await settle();
  assert.equal(live(), 'Вердикт: хрупко', 'при открытии экрана вердикт называется');
  const { late_render } = await add_expense('5,00');
  assert.equal(late_render, true, 'хранилище попросило перерисовать страницу позже записи (иначе проверка пустая)');
  assert.match(live(), /^Добавлен расход /, 'сообщение о записи осталось после поздней перерисовки хранилища: ' + live());
  assert.ok(!live().includes('Вердикт'), live());
  A.click(nav_button('Отменить'));
  await settle();
  assert.match(live(), /^Отменено: /, live());
  assert.ok(!live().includes('Вердикт'), live());
});

test('REQ-122 REQ-125 TST-56 «Продолжить с сохранённого» настоящей средой хранилища: правка записана на устройство → набор сменили → continue_saved() → «Мои данные (с устройства)»; выбор встроенного набора работает', async () => {
  const PK = await import(pathToFileURL(path.join(DEMO, 'pack_fp05.mjs')).href);
  const env = PK.browser_env(); // тот же localStorage-двойник, что у приложения
  assert.equal(ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 64000 }).ok, true);
  await settle(); // среда приложения дописала правку в хранилище
  assert.deepEqual(chosen(), [['custom', 'G-001 — эталон · изменён']], 'правленый встроенный набор назван правленым');
  await A.choose_dataset('low');
  assert.deepEqual(chosen(), [['low', 'G-001-low — впритык']]);
  assert.notEqual(ctx.get_ws().params.buffer_minor, 64000);
  const now = await PK.make_runtime(ctx, env); // «после перезагрузки страницы»: новая среда видит журнал в хранилище
  await now.init();
  assert.equal(now.status().mode, 'found', JSON.stringify(now.status().mode));
  assert.deepEqual(chosen(), [['low', 'G-001-low — впритык']], 'пока пользователь не ответил, данные — встроенный набор как есть');
  const r = await now.continue_saved();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(ctx.get_ws().params.buffer_minor, 64000, 'данные — из хранилища');
  assert.deepEqual(chosen(), [['custom', 'Мои данные (с устройства)']]);
  assert.equal(find_all(find_all(A.controls(), (n) => n.tagName === 'select' && n.attrs.id === 'ds-top')[0], (n) => n.tagName === 'option').length, 6);
  A.set_lang('en');
  assert.deepEqual(chosen(), [['custom', 'My data (from this device)']]);
  A.set_lang('ru');
  await A.choose_dataset('empty');
  assert.deepEqual(chosen(), [['empty', 'G-001-empty — пустой, с нуля']], 'после «Продолжить» встроенный набор выбирается как раньше');
});

test('REQ-122 REQ-125 TST-56 «Начать с текущего набора» (replace_saved): сохранённое стёрто, переключатель по-прежнему называет встроенный набор; после правки — «… · изменён», а не «Мои данные»', async () => {
  const PK = await import(pathToFileURL(path.join(DEMO, 'pack_fp05.mjs')).href);
  const env = PK.browser_env();
  assert.equal(ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 65000 }).ok, true); // в хранилище есть журнал, даже если тест запущен один
  await settle();
  await A.choose_dataset('g001');
  const again = await PK.make_runtime(ctx, env);
  await again.init();
  assert.equal(again.status().mode, 'found', 'в хранилище есть журнал с прошлого шага');
  const r = await again.replace_saved();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(again.status().mode, 'fresh');
  assert.deepEqual(chosen(), [['g001', 'G-001 — эталон']], 'данные — встроенный набор как есть: подпись прежняя');
  assert.equal(ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 66000 }).ok, true);
  await settle();
  assert.deepEqual(chosen(), [['custom', 'G-001 — эталон · изменён']]);
  await A.choose_dataset('g001');
  assert.deepEqual(chosen(), [['g001', 'G-001 — эталон']]);
});
