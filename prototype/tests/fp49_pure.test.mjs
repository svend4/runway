// fp49_pure.test.mjs — FP-49 (мелкие дефекты, найденные независимой проверкой FP-48 и проходом в настоящем браузере 2026-10-28): чистые части без запуска приложения.
// (1) заголовок «Таблицы значений» говорит о строках: «58 строк: день расчёта и 57 дней вперёд» (формы слова «строка», строки каталога RU и EN);
// (3) пояснение к отключённой кнопке «Вернуть выбранный набор» (строка каталога); (4) источник «файл» без имени называется «Загруженный файл» (подпись, следопыт);
// (7) одно выражение «число строк ряда − 1» (demo/horizon.mjs) для шапки, «Запаса хода», листа для печати и «Настроек»: четыре места дают одно число на G-001, при другой дате расчёта и при горизонте 1, 30, 365.
// Приложение запущено на заглушке DOM в fp49_boot.test.mjs (там же — живая область «Купить» при расчёте в Worker с задержкой и кнопка на экране «Данные»); движок — в fuzz_findings.test.mjs.
// Браузер, серверы и сеть не запускаются. Расчёт по введённым данным и правилам, не консультация.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/fp49_pure.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROTO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(PROTO, ...p), 'utf8');
const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);
const clone = (x) => JSON.parse(JSON.stringify(x));
const N = (x) => String(x).replace(/[  ]/g, ' ');

// Модули импортируются без DOM: приложение само не запускается (нет #app-title).
const I18N = await imp('demo', 'i18n.mjs');
const APP = await imp('demo', 'app.mjs');
const HC = await imp('demo', 'home_cards.mjs');
const RP = await imp('demo', 'report.mjs');
const HZ = await imp('demo', 'horizon.mjs');
const DL = await imp('demo', 'dataset_label.mjs');
const E = await imp('engine', 'index.mjs');
const G = JSON.parse(read('data', 'g001.json'));
const catalog_of = async (name) => (await imp('demo', 'i18n', name + '.mjs')).default;
const placeholders = (s) => [...s.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]).sort();

async function tr_of(lang) {
  try { I18N.register_strings('dslabel', await catalog_of('dslabel')); } catch { /* уже принят */ }
  return (key, params) => N(I18N.t(lang, key, params));
}

// ═══ (7) одно выражение «строк ряда − 1» ═══════════════════════════════════════════════════════════════════════════════════

test('REQ-019 TST-58 horizon.mjs: horizon_rows_of — строк ряда, horizon_ahead_of — дней вперёд (строк минус день расчёта, не меньше нуля); мусор не бросает и даёт 0', () => {
  const series = (n) => ({ plan: { close: new Array(n).fill(0) }, worse: { close: new Array(n).fill(0) } });
  assert.deepEqual([HZ.horizon_rows_of(series(58)), HZ.horizon_ahead_of(series(58))], [58, 57], 'G-001: 58 строк, 57 дней вперёд');
  assert.deepEqual([HZ.horizon_rows_of(series(2)), HZ.horizon_ahead_of(series(2))], [2, 1]);
  assert.deepEqual([HZ.horizon_rows_of(series(1)), HZ.horizon_ahead_of(series(1))], [1, 0], 'только день расчёта');
  assert.deepEqual([HZ.horizon_rows_of(series(0)), HZ.horizon_ahead_of(series(0))], [0, 0], 'пустой ряд: не −1');
  for (const junk of [null, undefined, {}, { plan: null }, { plan: {} }, { plan: { close: 'abc' } }, { plan: { close: { length: 5 } } }, { close: 'abc' }, { ctx: {} }, 7, 'x']) {
    assert.deepEqual([HZ.horizon_rows_of(junk), HZ.horizon_ahead_of(junk)], [0, 0], JSON.stringify(junk));
  }
  // аргумент — ряды расчёта (`ctx.series`), но принимается и то, из чего их достают: один ряд, массив `close`, контекст расчёта и модель страницы
  const close = new Array(58).fill(0);
  const container = { plan: { close }, worse: { close } };
  for (const [what, arg] of [['ctx.series', container], ['series.plan', container.plan], ['массив close', close], ['ctx', { series: container }], ['модель страницы', { ctx: { series: container } }]]) {
    assert.deepEqual([HZ.horizon_rows_of(arg), HZ.horizon_ahead_of(arg)], [58, 57], what);
  }
});

test('REQ-019 TST-58 четыре места — одно число: horizon.mjs, app.horizon_ahead_of, «Запас хода» (runway_model) и лист для печати (report_model) на G-001 (57 дней, 58 строк), при другой дате расчёта и при горизонте 1, 30 и 365 дней', () => {
  const cases = [
    { label: 'G-001', params: {}, as_of: null, ahead: 57 },
    { label: 'другая дата расчёта', params: {}, as_of: '2026-10-10', ahead: 57 },
    { label: 'ещё одна дата расчёта', params: {}, as_of: '2026-11-15', ahead: 57 },
    { label: 'горизонт 1', params: { horizon_days: 1 }, as_of: null, ahead: 1 },
    { label: 'горизонт 30', params: { horizon_days: 30 }, as_of: null, ahead: 30 },
    { label: 'горизонт 365', params: { horizon_days: 365 }, as_of: null, ahead: 365 },
    { label: 'горизонт 1, другая дата', params: { horizon_days: 1 }, as_of: '2026-10-10', ahead: 1 },
    { label: 'горизонт 365, другая дата', params: { horizon_days: 365 }, as_of: '2026-10-10', ahead: 365 },
  ];
  for (const c of cases) {
    const ws = clone(G);
    ws.params = { ...ws.params, ...c.params };
    if (c.as_of !== null) ws.as_of = c.as_of;
    const m = APP.build_model(ws);
    const places = {
      'horizon.mjs': HZ.horizon_ahead_of(m.ctx.series),
      'app.horizon_ahead_of (шапка)': APP.horizon_ahead_of(m),
      'runway_model («Запас хода»)': HC.runway_model(m).horizon_ahead,
      'report_model (лист)': RP.report_model(m).horizon_ahead,
    };
    for (const [place, n] of Object.entries(places)) assert.equal(n, c.ahead, `${c.label}: ${place}`);
    const rows = {
      'horizon.mjs': HZ.horizon_rows_of(m.ctx.series),
      'app.horizon_days_of': APP.horizon_days_of(m),
      'runway_model': HC.runway_model(m).horizon_days,
      'report_model': RP.report_model(m).horizon_days,
    };
    for (const [place, n] of Object.entries(rows)) assert.equal(n, c.ahead + 1, `${c.label}: строк ряда — ${place}`);
    assert.equal(E.to_epoch_day(m.as_of_iso) + c.ahead, m.ctx.horizon_end, `${c.label}: дата расчёта плюс число дней вперёд — конец горизонта`);
  }
  // горизонт не задан: умолчание словаря (180) называется одинаково
  const no_horizon = clone(G);
  delete no_horizon.params.horizon_days;
  const m = APP.build_model(no_horizon);
  assert.deepEqual([HZ.horizon_ahead_of(m.ctx.series), APP.horizon_ahead_of(m), HC.runway_model(m).horizon_ahead, RP.report_model(m).horizon_ahead], [180, 180, 180, 180]);
});

test('TST-59 REQ-019 выражение «строк ряда − 1» записано один раз: home_cards, report и settings берут его из horizon.mjs; app.mjs (список его импортов закреплён тестом demo) держит своё, и оно то же самое', () => {
  for (const file of ['home_cards.mjs', 'report.mjs', 'settings.mjs']) {
    const src = read('demo', file);
    assert.ok(/import \{[^}]*horizon_ahead_of[^}]*\} from '\.\/horizon\.mjs'/.test(src), `${file} импортирует horizon_ahead_of из horizon.mjs`);
    assert.ok(/\bhorizon_ahead_of\(/.test(src), `${file} зовёт horizon_ahead_of`);
    assert.ok(!/close\.length\s*-\s*1/.test(src), `${file}: своей копии «close.length − 1» нет`);
  }
  assert.ok(/horizon_rows_of\(a\.series\)/.test(read('demo', 'home_cards.mjs')) && /horizon_rows_of\(a\.series\)/.test(read('demo', 'report.mjs')), 'и число строк ряда тоже из горизонт-модуля');
  const app = read('demo', 'app.mjs');
  assert.ok(!/horizon\.mjs/.test(app), 'app.mjs новым импортом не подключён: список импортов страницы закреплён в tests/demo.test.mjs');
  assert.equal((app.match(/horizon_days_of\(model\) - 1/g) ?? []).length, 1, 'в app.mjs ровно одно собственное выражение, и оно в horizon_ahead_of(model)');
  assert.ok(/export function horizon_ahead_of\(model\) \{\s*return Math\.max\(0, horizon_days_of\(model\) - 1\);\s*\}/.test(app));
  // горизонт-модуль чистый: без DOM, часов, случайности, сети и динамических импортов
  const hz = read('demo', 'horizon.mjs').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const bad of ['document', 'window', 'Date', 'Math.random', 'fetch', 'localStorage', 'import(', 'setTimeout', 'performance']) assert.ok(!hz.includes(bad), `horizon.mjs: ${bad}`);
  assert.deepEqual([...read('demo', 'horizon.mjs').matchAll(/^import .*$/gm)], [], 'и никаких импортов');
});

// ═══ (1) заголовок «Таблицы значений» ═══════════════════════════════════════════════════════════════════════════════════════

test('TST-58 формы слова «строка»: 1 строка, 2–4 строки, 5–20 строк, 21 строка, 22 строки, 58 строк, 101 строка, 111 строк; EN: 1 row, остальные rows', () => {
  const ru = (n) => I18N.word_form('ru', 'row', n);
  assert.deepEqual([1, 2, 3, 4, 5, 11, 12, 14, 20, 21, 22, 25, 58, 101, 111].map(ru),
    ['строка', 'строки', 'строки', 'строки', 'строк', 'строк', 'строк', 'строк', 'строк', 'строка', 'строки', 'строк', 'строк', 'строка', 'строк']);
  assert.deepEqual([1, 2, 58].map((n) => I18N.word_form('en', 'row', n)), ['row', 'rows', 'rows']);
  assert.deepEqual([...I18N.FORMS.row.ru], ['строка', 'строки', 'строк']);
});

test('REQ-019 TST-56 TST-58 строка «Таблица значений»: RU и EN, плейсхолдеры n, rows, ahead, days; заголовок говорит о строках и объясняет разницу со шапкой («58 строк: день расчёта и 57 дней вперёд»)', () => {
  const ru = I18N.STRINGS.ru['ov.table'];
  const en = I18N.STRINGS.en['ov.table'];
  assert.deepEqual(placeholders(ru), ['ahead', 'days', 'n', 'rows']);
  assert.deepEqual(placeholders(en), ['ahead', 'days', 'n', 'rows']);
  const caption = (lang, rows, ahead) => N(I18N.t(lang, 'ov.table', { n: rows, rows: I18N.word_form(lang, 'row', rows), ahead, days: I18N.word_form(lang, 'day', ahead) }));
  assert.equal(caption('ru', 58, 57), 'Таблица значений (58 строк: день расчёта и 57 дней вперёд)', 'G-001');
  assert.equal(caption('en', 58, 57), 'Table of values (58 rows: the calculation day and 57 days ahead)');
  assert.equal(caption('ru', 2, 1), 'Таблица значений (2 строки: день расчёта и 1 день вперёд)', 'горизонт в один день');
  assert.equal(caption('en', 2, 1), 'Table of values (2 rows: the calculation day and 1 day ahead)');
  assert.equal(caption('ru', 22, 21), 'Таблица значений (22 строки: день расчёта и 21 день вперёд)');
  assert.equal(caption('ru', 366, 365), 'Таблица значений (366 строк: день расчёта и 365 дней вперёд)');
  assert.ok(!/58 дн/.test(caption('ru', 58, 57)), 'число 58 не названо днями горизонта: это строки таблицы');
  assert.match(ru, /[а-яё]/i);
  assert.ok(!/[а-яё]/i.test(en), 'в EN-строке русских букв нет');
  const app = read('demo', 'app.mjs');
  assert.ok(app.includes("'ov.table'"), 'ключ используется кодом');
  assert.ok(/tr\('ov\.table', \{ n, rows: word_form\(S\.lang, 'row', n\), ahead, days: word_form\(S\.lang, 'day', ahead\) \}\)/.test(app), 'числа — из тех же данных, что у шапки: n = horizon_days_of(S.model), ahead = horizon_ahead_of(S.model)');
  assert.ok(/const ahead = horizon_ahead_of\(S\.model\);/.test(app) && /const n = horizon_days_of\(S\.model\);/.test(app));
});

// ═══ (3) пояснение к кнопке «Вернуть выбранный набор» ═══════════════════════════════════════════════════════════════════════

test('REQ-125 REQ-046 TST-56 пояснение к отключённой кнопке «Вернуть выбранный набор»: RU «Нужно выбрать встроенный набор в списке выше.» и EN, без повелительной формы (допустимы только «проверьте», «введите», «сверьте»), одни плейсхолдеры (их нет), русские буквы только в RU, ключ используется кодом', async () => {
  const ru = I18N.STRINGS.ru['dt.reset_hint'];
  const en = I18N.STRINGS.en['dt.reset_hint'];
  assert.equal(ru, 'Нужно выбрать встроенный набор в списке выше.');
  assert.equal(en, 'A built-in set must be selected in the list above.');
  assert.match(ru, /встроенный набор в списке выше/);
  const { find_imperatives } = await import(pathToFileURL(path.join(PROTO, '..', 'tools', 'lint_vocab.mjs')).href);
  assert.deepEqual(find_imperatives(ru, 'ru'), [], 'RU: повелительной формы нет');
  assert.deepEqual(find_imperatives(en, 'en'), [], 'EN: повелительной формы нет');
  assert.deepEqual(placeholders(ru), placeholders(en));
  assert.ok(!/[а-яё]/i.test(en));
  assert.ok(read('demo', 'app.mjs').includes("'dt.reset_hint'"));
  assert.equal(I18N.STRINGS.ru['dt.reset'], 'Вернуть выбранный набор', 'подпись самой кнопки прежняя');
});

// ═══ (4) источник «файл» без имени ══════════════════════════════════════════════════════════════════════════════════════════

test('REQ-125 REQ-122 TST-56 dataset_label (ADV-05): источник «файл» без имени называется «Загруженный файл» всегда — без правок и после правки («· изменён»); RU и EN; встроенный набор без правок по-прежнему молчит', async () => {
  const ru = await tr_of('ru');
  const en = await tr_of('en');
  const nameless = { kind: 'file', name: '' };
  assert.deepEqual(DL.label_of(ru, nameless, false), { value: 'custom', text: 'Загруженный файл' });
  assert.deepEqual(DL.label_of(ru, nameless, true), { value: 'custom', text: 'Загруженный файл · изменён' });
  assert.deepEqual(DL.label_of(en, nameless, false), { value: 'custom', text: 'Uploaded file' });
  assert.deepEqual(DL.label_of(en, nameless, true), { value: 'custom', text: 'Uploaded file · changed' });
  for (const junk of [undefined, null, 5, {}, []]) {
    assert.deepEqual(DL.label_of(ru, { kind: 'file', name: junk }, false), { value: 'custom', text: 'Загруженный файл' }, 'имя не строка: ' + JSON.stringify(junk));
  }
  assert.deepEqual(DL.label_of(ru, { kind: 'file', name: 'moi.json' }, false), { value: 'custom', text: 'Файл: moi.json' }, 'файл с именем — как раньше');
  assert.equal(DL.label_of(ru, { kind: 'dataset', id: 'g001' }, false), undefined, 'встроенный набор без правок — прежняя подпись страницы');
  assert.deepEqual(DL.label_of(ru, { kind: 'device' }, false), { value: 'custom', text: 'Мои данные (с устройства)' });
  assert.equal(DL.label_of(ru, null, false), undefined);
  assert.equal(DL.label_of(ru, { kind: 'странный' }, false), undefined);
});

test('REQ-125 REQ-122 TST-56 dataset_label (ADV-05): «Восстановить из файла» без имени (origin {kind: file, name: ""}), имя из одних управляющих знаков и открытие файла без имени — «Загруженный файл»; «Отменить» до принятых данных пометку «изменён» снимает', async () => {
  const ru = await tr_of('ru');
  const t = DL.create_tracker();
  const base = clone(G);
  t.on_event({ reason: 'restore', ws: base, origin: { kind: 'file', name: '' } });
  assert.deepEqual(t.origin(), { kind: 'file', name: '', base });
  assert.deepEqual(t.label(ru, base, 'g001'), { value: 'custom', text: 'Загруженный файл' }, 'страница помнит встроенный g001, а данные из файла');
  const control_only = String.fromCharCode(0, 7, 0x2028);
  t.on_event({ reason: 'restore', ws: base, origin: { kind: 'file', name: control_only } });
  assert.equal(t.origin().name, '', 'имя из одних управляющих знаков очищено до пустого');
  assert.deepEqual(t.label(ru, base, 'g001'), { value: 'custom', text: 'Загруженный файл' });
  t.on_event({ reason: 'adopt', ws: base, dataset_id: 'custom', file_name: null });
  assert.deepEqual(t.label(ru, base, 'custom'), { value: 'custom', text: 'Загруженный файл' }, 'открытие файла без имени');
  const edited = clone(G);
  edited.params = { ...edited.params, buffer_minor: 63000 };
  t.on_event({ reason: 'set_param', ws: edited, before: base });
  assert.deepEqual(t.label(ru, edited, 'custom'), { value: 'custom', text: 'Загруженный файл · изменён' });
  assert.deepEqual(t.label(ru, base, 'custom'), { value: 'custom', text: 'Загруженный файл' }, 'основа без правок — без пометки');
  t.on_event({ reason: 'adopt', ws: base, dataset_id: 'low' });
  assert.equal(t.label(ru, base, 'low'), undefined, 'выбор встроенного набора возвращает прежнюю подпись страницы');
});
