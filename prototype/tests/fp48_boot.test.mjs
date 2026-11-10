// fp48_boot.test.mjs — FP-48 в настоящем app.mjs на заглушке DOM (браузер, серверы и сеть не запускаются; оснастка — tests/dom_boot.mjs):
// (1) переключатель «Набор данных» после «Продолжить с сохранённого», «Восстановить из файла» и открытия файла называет данные честно, а не «G-001 — эталон»;
// (3) подпись перенесённого вхождения «перенесено с 26 октября (по правилу — 25 октября)»; (4) «Горизонт» в шапке, «Запасе хода», на листе и в «Настройках» — одно число
// (FP-49: и в заголовке «Таблицы значений» — «58 строк: день расчёта и 57 дней вперёд»);
// (5) «Добавлен расход …» и «Отменено: …» на экране «Купить» не затираются поздней перерисовкой, вердикт покупки объявляется только при его изменении.
// Расчёт по введённым данным и правилам, не консультация. Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/fp48_boot.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot_app, find_all, N, DEMO } from './dom_boot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const G = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'data', 'g001.json'), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const A = await boot_app();
const ctx = A.ext.ctx;
const T = (key, params) => N(A.I18N.t(ctx.lang(), key, params));
/** Дать пройти микрозадачам, таймерам хранилища (FP-05) и его поздней перерисовке. */
const settle = async () => { for (let i = 0; i < 5; i++) { await A.tick(); await wait(15); } };

// ── общие помощники ─────────────────────────────────────────────────────────────────────────────────────────────────────

const ds_select = (id = 'ds-top') => find_all(id === 'ds-top' ? A.controls() : A.main(), (n) => n.tagName === 'select' && n.attrs.id === id)[0];
const ds_options = (id) => find_all(ds_select(id), (n) => n.tagName === 'option').map((o) => ({ value: o.attrs.value, text: N(o.textContent), selected: o.attrs.selected !== undefined }));
const chosen = (id) => ds_options(id).filter((o) => o.selected).map((o) => [o.value, o.text]);
const nav_button = (label) => find_all(A.nav(), (n) => n.tagName === 'button' && N(n.textContent) === label)[0];
const live = () => N(A.byid.get('live').textContent);
const reset_g001 = async () => { await A.choose_dataset('g001'); await A.go('#overview'); await settle(); };

/** Выбрать файл на экране «Данные» (как это делает браузер) и дождаться окончания открытия. */
async function pick_file(text, name) {
  await A.go('#data');
  const input = A.by_id('file-in');
  assert.ok(input !== undefined, 'на экране «Данные» есть выбор файла');
  input.files = [{ name, size: text.length, text: async () => text }];
  await input.listeners.change[0]();
  await A.tick();
}

// ═══ (1) переключатель «Набор данных» ═══════════════════════════════════════════════════════════════════════════════════════

test('REQ-125 TST-56 исходное состояние: выбран G-001 — эталон, пять встроенных наборов, пункта-источника нет (прежнее поведение сохранено)', () => {
  assert.deepEqual(chosen(), [['g001', 'G-001 — эталон']]);
  assert.deepEqual(ds_options().map((o) => o.value), ['g001', 'low', 'gap', 'late', 'empty']);
  assert.ok(A.ext.diagnostics().some((d) => d.pack === 'pack_fp05' && d.status === 'ok'));
  assert.deepEqual(A.ext.diagnostics().filter((d) => d.status === 'failed'), [], 'ни один пакет не упал');
});

test('REQ-125 REQ-122 TST-56 «Продолжить с сохранённого» (событие restore): шапка и «Данные» называют «Мои данные (с устройства)», а не «G-001 — эталон»; RU и EN; выбор встроенного набора по-прежнему работает', async () => {
  const mine = clone(ctx.get_ws());
  mine.params = { ...mine.params, buffer_minor: 61000 }; // данные уже пользовательские
  assert.equal(ctx.set_ws(mine, { reason: 'restore' }).ok, true);
  assert.deepEqual(chosen(), [['custom', 'Мои данные (с устройства)']]);
  assert.equal(ds_options().length, 6, 'пять встроенных наборов и один пункт-источник');
  assert.equal(ds_select().value, 'custom');
  assert.ok(ds_options().filter((o) => o.value !== 'custom').every((o) => !o.selected), 'ни один встроенный набор не выбран');
  await A.go('#data');
  assert.deepEqual(chosen('ds-sel'), [['custom', 'Мои данные (с устройства)']], 'тот же ответ на экране «Данные»');
  A.set_lang('en');
  assert.deepEqual(chosen(), [['custom', 'My data (from this device)']]);
  assert.deepEqual(chosen('ds-sel'), [['custom', 'My data (from this device)']]);
  A.set_lang('ru');
  // пункт-источник ничего не загружает
  const before = ctx.get_ws();
  await A.choose_dataset('custom');
  assert.equal(ctx.get_ws(), before, 'выбор пункта «Мои данные» данные не меняет');
  assert.equal(ctx.get_ws().params.buffer_minor, 61000);
  // встроенный набор — загружается и подписывается как раньше
  await A.choose_dataset('low');
  assert.deepEqual(chosen(), [['low', 'G-001-low — впритык']]);
  assert.notEqual(ctx.get_ws().params.buffer_minor, 61000, 'загружен встроенный набор, а не прежние данные');
  await A.choose_dataset('g001');
  assert.deepEqual(chosen(), [['g001', 'G-001 — эталон']]);
});

test('REQ-125 TST-56 файл, открытый на экране «Данные»: «Файл: moi.json» (RU и EN), после правки — с пометкой «изменён», «Отменить» её снимает; выбор встроенного набора возвращает прежнюю подпись', async () => {
  await reset_g001();
  const doc = clone(G);
  doc.name = 'Мой набор';
  await pick_file(JSON.stringify(doc), 'moi.json');
  assert.deepEqual(chosen(), [['custom', 'Файл: moi.json']]);
  assert.equal(ds_select().value, 'custom');
  A.set_lang('en');
  assert.deepEqual(chosen(), [['custom', 'File: moi.json']]);
  A.set_lang('ru');
  assert.equal(ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 62000 }).ok, true);
  assert.deepEqual(chosen(), [['custom', 'Файл: moi.json · изменён']]);
  A.click(nav_button('Отменить'));
  assert.deepEqual(chosen(), [['custom', 'Файл: moi.json']], '«Отменить» до принятых данных пометку снимает');
  await A.choose_dataset('g001');
  assert.deepEqual(chosen(), [['g001', 'G-001 — эталон']]);
});

test('REQ-125 REQ-122 TST-56 «Восстановить из файла» (диалог на экране «Данные»): «Файл: copy.json»; имя файла — только текст, управляющие знаки убраны, длина ограничена', async () => {
  await reset_g001();
  const doc = clone(G);
  doc.name = 'Копия';
  doc.params = { ...doc.params, buffer_minor: 65000 };
  const text = JSON.stringify(doc);
  await A.go('#data');
  const pick = async (name) => {
    const fin = A.by_id('fp05-file');
    assert.ok(fin !== undefined, 'на экране «Данные» есть выбор файла копии');
    fin.files = [{ name, size: text.length, text: async () => text }];
    await fin.listeners.change[0]();
    await A.tick();
    const confirm = find_all(A.byid.get('dlg-body'), (n) => n.tagName === 'button' && N(n.textContent) === T('data.restore_confirm'))[0];
    assert.ok(confirm !== undefined, 'в диалоге есть «Заменить данные»: ' + N(A.byid.get('dlg-body').textContent).slice(0, 200));
    await confirm.listeners.click[0]();
    await settle();
  };
  await pick('copy.json');
  assert.equal(ctx.get_ws().params.buffer_minor, 65000);
  assert.deepEqual(chosen(), [['custom', 'Файл: copy.json']]);
  // имя файла — данные от пользователя: в страницу только через textContent, без управляющих знаков и не длиннее предела
  const hostile = '<img src=x onerror=alert(1)>\u0000' + 'я'.repeat(120) + '.json';
  await A.go('#data');
  await pick(hostile);
  const [value, label] = chosen()[0];
  assert.equal(value, 'custom');
  assert.ok(label.startsWith('Файл: <img src=x onerror=alert(1)> я'), label);
  assert.ok(!label.includes('\u0000'));
  assert.ok(label.length <= 'Файл: '.length + 60, 'имя усечено: ' + label.length);
  assert.ok(label.endsWith('…'));
  for (const o of find_all(ds_select(), (n) => n.tagName === 'option')) assert.ok(!Object.keys(o.attrs).some((k) => /^on/i.test(k) || k === 'style'), 'у пункта нет обработчиков и стилей');
  await reset_g001();
});

test('REQ-125 TST-56 встроенный набор после правки называется «… · изменён», выбран пункт-источник; «Отменить» возвращает «G-001 — эталон» и выбор встроенного пункта', async () => {
  await reset_g001();
  assert.deepEqual(chosen(), [['g001', 'G-001 — эталон']]);
  assert.equal(ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 61500 }).ok, true);
  await settle();
  assert.deepEqual(chosen(), [['custom', 'G-001 — эталон · изменён']]);
  A.set_lang('en');
  assert.deepEqual(chosen(), [['custom', 'G-001 — reference · changed']]);
  A.set_lang('ru');
  // из изменённого состояния «G-001 — эталон» из списка загружает эталон заново
  A.click(nav_button('Отменить'));
  await settle();
  assert.deepEqual(chosen(), [['g001', 'G-001 — эталон']], '«Отменить» вернул основу: пометки нет');
  assert.equal(ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 61500 }).ok, true);
  assert.deepEqual(chosen(), [['custom', 'G-001 — эталон · изменён']]);
  await A.choose_dataset('g001');
  assert.deepEqual(chosen(), [['g001', 'G-001 — эталон']]);
  assert.equal(ctx.get_ws().params.buffer_minor, G.params.buffer_minor, 'эталон загружен заново');
});

// ═══ (4) «Горизонт» ═══════════════════════════════════════════════════════════════════════════════════════════════════════

const header_li = () => find_all(A.summary(), (n) => n.tagName === 'li' && /^(?:горизонт|horizon) \d+ /.test(N(n.textContent)))[0];
const header_n = () => Number(/^(?:горизонт|horizon) (\d+) /.exec(N(header_li().textContent))[1]);

test('REQ-019 TST-58 «Горизонт»: число в шапке равно числу «Сейчас задано» и значению поля на «Настройках», а также числу в «Запасе хода» и на листе для печати (G-001 — 57 дней, до 30 ноября)', async () => {
  await reset_g001();
  assert.equal(header_n(), 57);
  assert.match(N(header_li().textContent), /^горизонт 57 дней, до 30 ноября$/);
  const as_of = ctx.get_model().ctx.as_of;
  assert.equal(as_of + header_n(), ctx.get_model().ctx.horizon_end, 'дата расчёта плюс число из шапки — конец горизонта');
  await A.go('#settings');
  const shown = N(A.by_id('set-horizon-default').textContent);
  assert.equal(shown, 'По умолчанию: 180 дней. Сейчас задано: 57 дней.');
  assert.equal(Number(/Сейчас задано: (\d+) /.exec(shown)[1]), header_n(), 'шапка и «Настройки» называют одно число');
  assert.equal(Number(A.by_id('set-horizon').value), header_n(), 'и в самом поле то же число');
  assert.equal(N(A.by_id('set-horizon-now').textContent), 'Сейчас прогноз идёт на 57 дней вперёд от даты расчёта, до 30 ноября; то же число стоит в шапке.');
  await A.go('#overview');
  const card = N(find_all(A.main(), (n) => n.className === 'card fp03-runway')[0].textContent);
  assert.match(card, /денег на счетах хватает на весь горизонт — 57 дней/);
  assert.match(card, /Горизонт: 57 дней, до 30 ноября\./);
  await A.go('#report');
  assert.match(N(A.main().textContent), /горизонт до 30 ноября \(57 дн\.\)/);
  // английский интерфейс
  A.set_lang('en');
  assert.match(N(header_li().textContent), /^horizon 57 days, to November 30$/);
  await A.go('#settings');
  assert.equal(N(A.by_id('set-horizon-default').textContent), 'Default: 180 days. Currently set: 57 days.');
  assert.match(N(A.by_id('set-horizon-now').textContent), /^The forecast now runs 57 days ahead of the calculation date, to November 30; the header shows the same number\.$/);
  A.set_lang('ru');
});

test('REQ-019 TST-58 «Горизонт» по умолчанию (параметр не задан): шапка и «Настройки» называют 180 дней, а не 181; после возврата числа снова 57', async () => {
  await reset_g001();
  assert.equal(ctx.edit({ type: 'set_param', key: 'horizon_days', reset: true }).ok, true);
  await settle();
  assert.equal(header_n(), 180);
  await A.go('#settings');
  const shown = N(A.by_id('set-horizon-default').textContent);
  assert.equal(shown, 'По умолчанию: 180 дней. Сейчас действует оно.');
  assert.equal(Number(/По умолчанию: (\d+) /.exec(shown)[1]), header_n());
  assert.equal(Number(A.by_id('set-horizon').value), header_n());
  const end = ctx.get_model().ctx.horizon_end;
  assert.equal(ctx.get_model().ctx.as_of + 180, end);
  await reset_g001();
  assert.equal(header_n(), 57);
});

/** Заголовок раскрывающегося блока «Таблица значений …» на «Обзоре» и числа в нём: [строк, дней вперёд]. */
const table_caption = () => N(find_all(A.main(), (n) => n.tagName === 'summary').map((n) => n.textContent).find((t) => /Таблица значений|Table of values/.test(t)));
const caption_numbers = () => { const m = /\((\d+) [^:()]+: [^\d()]+(\d+) [^:()]+\)$/.exec(table_caption()); return m === null ? null : [Number(m[1]), Number(m[2])]; };

// FP-49 (ADV-09): канон (03-ux-screens.md) называет таблицу «все 58 дней» — правка слов, а не числа: заголовок говорит о строках и сам объясняет разницу с шапкой
test('REQ-019 TST-58 FP-49 «Таблица значений»: заголовок согласован с шапкой — «58 строк: день расчёта и 57 дней вперёд» на G-001 и при другом горизонте и другой дате расчёта; RU и EN', async () => {
  await reset_g001();
  await A.go('#overview');
  await settle();
  assert.equal(table_caption(), 'Таблица значений (58 строк: день расчёта и 57 дней вперёд)');
  assert.deepEqual(caption_numbers(), [58, 57]);
  assert.equal(caption_numbers()[1], header_n(), 'дней вперёд — то же число, что в шапке');
  assert.equal(caption_numbers()[0], header_n() + 1, 'строк на одну больше: день расчёта');
  A.set_lang('en');
  assert.equal(table_caption(), 'Table of values (58 rows: the calculation day and 57 days ahead)');
  assert.equal(caption_numbers()[1], header_n());
  A.set_lang('ru');
  // другой горизонт: «2 строки … 1 день», «31 строка … 30 дней», «366 строк … 365 дней» — склонение и числа следуют за шапкой
  const expect = { 1: 'Таблица значений (2 строки: день расчёта и 1 день вперёд)', 30: 'Таблица значений (31 строка: день расчёта и 30 дней вперёд)', 365: 'Таблица значений (366 строк: день расчёта и 365 дней вперёд)' };
  for (const [days, text] of Object.entries(expect)) {
    assert.equal(ctx.edit({ type: 'set_param', key: 'horizon_days', value: Number(days) }).ok, true, 'горизонт ' + days);
    await settle();
    assert.equal(header_n(), Number(days));
    assert.equal(table_caption(), text);
    assert.deepEqual(caption_numbers(), [Number(days) + 1, header_n()], 'горизонт ' + days + ': числа заголовка и шапки');
    const rows = find_all(find_all(A.main(), (n) => n.tagName === 'details' && n.className === 'card values')[0], (n) => n.tagName === 'tbody')[0].children.length;
    assert.equal(rows, Number(days) + 1, 'и в таблице столько строк, сколько названо в заголовке');
  }
  // другая дата расчёта при том же горизонте — числа те же, шапка и заголовок снова согласованы
  assert.equal(ctx.edit({ type: 'set_param', key: 'horizon_days', value: 57 }).ok, true);
  assert.equal(ctx.edit({ type: 'set_as_of', date: '2026-10-10' }).ok, true);
  await settle();
  assert.equal(header_n(), 57);
  assert.equal(table_caption(), 'Таблица значений (58 строк: день расчёта и 57 дней вперёд)');
  assert.equal(ctx.get_model().ctx.as_of + caption_numbers()[1], ctx.get_model().ctx.horizon_end, 'дата расчёта плюс число из заголовка — конец горизонта');
  // умолчание словаря (параметр не задан): 180 дней вперёд, 181 строка
  assert.equal(ctx.edit({ type: 'set_param', key: 'horizon_days', reset: true }).ok, true);
  await settle();
  assert.equal(header_n(), 180);
  assert.equal(table_caption(), 'Таблица значений (181 строка: день расчёта и 180 дней вперёд)');
  await reset_g001();
});

// ═══ (3) подпись перенесённого вхождения ═══════════════════════════════════════════════════════════════════════════════════

test('REQ-010 REQ-032 TST-58 перенос аренды (G-001: 25 октября — воскресенье, в списке 26-го): подпись «перенесено с 26 октября (по правилу — 25 октября)»; для будней — без скобок; EN', async () => {
  await reset_g001();
  await A.go('#forms');
  const rule_item = (id) => find_all(A.main(), (n) => n.attrs['data-rule'] === id)[0];
  const row_button = (rule_id, nominal, act) => find_all(rule_item(rule_id), (n) => n.tagName === 'button' && n.attrs['data-act'] === act && n.attrs['data-nominal'] === nominal)[0];
  const type_into = (n, value) => { n.value = value; for (const fn of n.listeners.input ?? []) fn({ target: n }); };
  // до переноса в списке стояло «26 октября»
  assert.match(N(rule_item('R-RENT').textContent), /26 октября: −900,00 €/);
  A.click(row_button('R-RENT', '2026-10-25', 'move'));
  type_into(A.by_id('fp08-mv-0-0-move_date'), '2026-10-28');
  assert.match(N(A.by_id('fp13-ov-mv-0-0-preview').textContent), /«Аренда»: 26 октября → 28 октября\./, 'предпросмотр называет ту же дату, что и список');
  A.by_id('fp13-ov-mv-0-0').listeners.submit[0]({ preventDefault() {} });
  await settle();
  assert.match(N(rule_item('R-RENT').textContent), /28 октября: −900,00 € · перенесено с 26 октября \(по правилу — 25 октября\)/);
  assert.ok(!/перенесено с 25 октября/.test(N(rule_item('R-RENT').textContent)), 'прежней подписи, сбивавшей с толку, нет');
  // будний день (среда 25 ноября): дата правила и показанная совпадают — скобок нет
  A.click(row_button('R-RENT', '2026-11-25', 'move'));
  type_into(A.by_id('fp08-mv-0-1-move_date'), '2026-11-27');
  A.by_id('fp13-ov-mv-0-1').listeners.submit[0]({ preventDefault() {} });
  await settle();
  const text = N(rule_item('R-RENT').textContent);
  assert.match(text, /27 ноября: −900,00 € · перенесено с 25 ноября(?! \()/);
  assert.equal((text.match(/по правилу —/g) ?? []).length, 1, 'пометка про правило — только у воскресного вхождения');
  A.set_lang('en');
  assert.match(N(rule_item('R-RENT').textContent), /moved from October 26 \(by the rule — October 25\)/);
  assert.match(N(rule_item('R-RENT').textContent), /moved from November 25(?! \()/);
  A.set_lang('ru');
  await reset_g001();
});

// ═══ (5) живая область на экране «Купить» ═════════════════════════════════════════════════════════════════════════════════

test('REQ-167 REQ-090 TST-58 «+ Факт» на экране «Купить»: «Добавлен расход …» не затирается вердиктом ни сразу, ни поздней перерисовкой хранилища; «Отменить» — то же с «Отменено: …»', async () => {
  await reset_g001();
  await A.go('#buy');
  await settle();
  assert.equal(live(), 'Вердикт: хрупко', 'при открытии экрана вердикт называется');
  const shown = () => find_all(A.main(), (n) => /^verdict verdict-/.test(n.className)).map((n) => N(n.textContent).trim().replace(/^\S+\s/, ''))[0];
  assert.equal(shown(), 'хрупко');
  const add = async (amount) => {
    A.click(nav_button('+ Факт'));
    const form = A.byid.get('dlg-body').children[0];
    find_all(form, (n) => n.attrs.id === 'entry-amount')[0].value = amount;
    await form.listeners.submit[0]({ preventDefault() {} });
    await settle();
  };
  // небольшой расход: вердикт не меняется
  await add('5,00');
  assert.equal(shown(), 'хрупко');
  assert.match(live(), /^Добавлен расход /, 'сообщение о записи осталось: ' + live());
  assert.ok(!live().includes('Вердикт'), 'вердикт без изменения не объявляется: ' + live());
  ctx.refresh(); // поздняя перерисовка по просьбе хранилища (FP-05) — повтор
  await settle();
  assert.match(live(), /^Добавлен расход /, 'поздняя перерисовка сообщение не затёрла: ' + live());
  // «Отменить»
  A.click(nav_button('Отменить'));
  await settle();
  assert.match(live(), /^Отменено: /, live());
  assert.ok(!live().includes('Вердикт'));
  ctx.refresh();
  await settle();
  assert.match(live(), /^Отменено: /, 'и после поздней перерисовки: ' + live());
});

test('REQ-167 REQ-090 TST-58 вердикт покупки меняется после записи (буфер 1 000 €): он объявляется один раз и ПОСЛЕ сообщения о записи (оба в живой области); «Отменить» — то же в обратную сторону', async () => {
  await reset_g001();
  await A.go('#buy');
  await settle();
  assert.equal(live(), 'Вердикт: хрупко');
  const shown = () => find_all(A.main(), (n) => /^verdict verdict-/.test(n.className)).map((n) => N(n.textContent).trim().replace(/^\S+\s/, ''))[0];
  // запись и сообщение — как в «Настройках» (settings.commit): правка общим путём, затем ctx.notify; факт «+ Факт» на дату расчёта прогноз не меняет (остаток уже включает сумму)
  assert.equal(ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 100000 }).ok, true);
  ctx.notify('Сохранено.', 'info');
  await settle();
  const after = shown();
  assert.notEqual(after, 'хрупко', 'вердикт изменился: проверка не пустая');
  assert.match(live(), /^Сохранено\. /, 'сначала сообщение о записи: ' + live());
  assert.ok(live().endsWith('Вердикт: ' + after), 'затем новый вердикт: ' + live());
  assert.equal((live().match(/Вердикт:/g) ?? []).length, 1, 'вердикт назван один раз');
  ctx.refresh();
  await settle();
  assert.ok(live().endsWith('Вердикт: ' + after) && (live().match(/Вердикт:/g) ?? []).length === 1, 'поздняя перерисовка с тем же вердиктом ничего не добавила: ' + live());
  A.click(nav_button('Отменить'));
  await settle();
  assert.equal(shown(), 'хрупко');
  assert.match(live(), /^Отменено: /);
  assert.ok(live().endsWith('Вердикт: хрупко'), live());
  assert.equal((live().match(/Вердикт:/g) ?? []).length, 1);
  // порядок вызовов в одном ходе не важен: действие объявило сообщение РАНЬШЕ перерисовки — сообщение всё равно стоит первым, вердикт за ним (и виден сразу, без ожидания)
  assert.equal(ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 100000 }).ok, true);
  await settle();
  assert.ok(live().endsWith('Вердикт: впритык'), live());
  ctx.notify('Сначала сообщение.', 'info');
  assert.equal(ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 50000 }).ok, true);
  assert.equal(live(), 'Сначала сообщение. Вердикт: хрупко', 'сразу после хода: ' + live());
  await settle();
  assert.equal(live(), 'Сначала сообщение. Вердикт: хрупко', 'и после микрозадач и поздней перерисовки');
  // следующее объявление в другом ходе заменяет прежнее, как и раньше
  ctx.notify('Другое сообщение.', 'info');
  assert.equal(live(), 'Другое сообщение.');
});

test('REQ-167 TST-58 перерисовка экрана «Купить» с тем же вердиктом живую область не трогает; уход с экрана и возвращение — вердикт называется заново; ввод суммы на экране — сразу', async () => {
  await reset_g001();
  await A.go('#buy');
  await settle();
  assert.equal(live(), 'Вердикт: хрупко');
  A.byid.get('live').textContent = 'сторожевое сообщение';
  ctx.refresh();
  ctx.refresh();
  await settle();
  assert.equal(live(), 'сторожевое сообщение', 'перерисовка без смены вердикта живую область не перезаписывает');
  await A.go('#overview');
  await settle();
  A.byid.get('live').textContent = 'сторожевое сообщение';
  location.hash = '#buy'; // переход без ожидания: вердикт должен быть в живой области сразу
  for (const fn of A.listeners.hashchange ?? []) fn();
  assert.equal(live(), 'Вердикт: хрупко', 'вернулись на экран: вердикт назван заново и виден сразу');
  await settle();
  assert.equal(live(), 'Вердикт: хрупко');
  // ввод в поле суммы на экране: смена вердикта объявляется сразу (без микрозадачи)
  const amount = A.by_id('buy-amount');
  amount.value = '3 900,00';
  for (const fn of amount.listeners.input ?? []) fn({ target: amount });
  const verdict_now = find_all(A.main(), (n) => /^verdict verdict-/.test(n.className)).map((n) => N(n.textContent).trim().replace(/^\S+\s/, ''))[0];
  assert.notEqual(verdict_now, 'хрупко', 'вердикт для 3 900 € другой');
  assert.equal(live(), 'Вердикт: ' + verdict_now, 'объявлен синхронно с вводом');
  // смена набора данных — вердикт покупки по новому набору называется заново, даже если слово то же
  await A.choose_dataset('g001');
  await A.go('#buy');
  await settle();
  assert.equal(live(), 'Вердикт: хрупко');
});
