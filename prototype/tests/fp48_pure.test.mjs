// fp48_pure.test.mjs — FP-48 (мелкие дефекты проходов в настоящем браузере 2026-10-23…27): чистые части без запуска приложения.
// (1) подпись источника данных в переключателе «Набор данных» (dataset_label.mjs); (2) отчёт об ошибке при пустом журнале; (3) подпись перенесённого вхождения
// (date_by_rule, moved_from_text, moved_row_text); (4) «Горизонт» — число дней вперёд от даты расчёта в шапке, «Запасе хода», листе и «Настройках»; (6) страница coldstart.html:
// быстрый отказ при запрете вложения, подсказка до кнопки, CSP приложения не ослаблена. Тесты через настоящий app.mjs на заглушке DOM — в fp48_boot.test.mjs.
// Браузер, серверы и сеть не запускаются. Расчёт по введённым данным и правилам, не консультация.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/fp48_pure.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROTO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(PROTO, ...p), 'utf8');
const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);
const clone = (x) => JSON.parse(JSON.stringify(x));
const NB = /[  ]/g;
const N = (x) => String(x).replace(NB, ' ');

// Модули импортируются ДО установки заглушки DOM: иначе страницы и приложение запустились бы сами (проверка на `document` в конце модулей).
const I18N = await imp('demo', 'i18n.mjs');
const APP = await imp('demo', 'app.mjs');
const HC = await imp('demo', 'home_cards.mjs');
const RP = await imp('demo', 'report.mjs');
const RULE = await imp('demo', 'form_rule.mjs');
const REPORT_VIEW = await imp('demo', 'error_report_view.mjs');
const LOG = await imp('demo', 'log.mjs');
const COLD = await imp('demo', 'coldstart_page.mjs');
const STORE = await imp('demo', 'store.mjs');
const RT = await imp('demo', 'data_runtime.mjs');
const DA = await imp('demo', 'data_actions.mjs');
const E = await imp('engine', 'index.mjs');
const G = JSON.parse(read('data', 'g001.json'));
const V0 = E.ENGINE_VERSION;

// ── заглушка DOM для страницы coldstart ───────────────────────────────────────────────────────────────────────────────────

class El {
  constructor(tag) { this.nodeType = 1; this.tagName = tag; this.attrs = {}; this.children = []; this.listeners = {}; this.className = ''; this._text = ''; this._value = ''; this.parent = null; }
  get textContent() { return this.children.length === 0 ? this._text : this.children.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get value() { return this._value; }
  set value(v) { this._value = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  append(...kids) { for (const k of kids) { if (k.nodeType === 1) k.parent = this; this.children.push(k); } this._text = ''; }
  replaceChildren(...kids) { this.children = []; this._text = ''; this.append(...kids); }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  focus() {}
  remove() { if (this.parent !== null) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  walk(fn) { fn(this); for (const c of this.children) if (c.nodeType === 1) c.walk(fn); }
}
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const doc = {
  createElement: (t) => new El(t),
  createTextNode: (data) => ({ nodeType: 3, data }),
  documentElement: new El('html'),
  body: new El('body'),
  title: '',
  getElementById(id) { return find_all(this.body, (n) => n.attrs.id === id)[0] ?? null; },
};
globalThis.document = doc;
const mk = (id) => { const e = new El('div'); e.setAttribute('id', id); return e; };
const reset_dom = () => { doc.body.replaceChildren(mk('main'), mk('cs-lang-ru'), mk('cs-lang-en'), mk('cs-frame-box')); doc.title = ''; };
const fake_env = () => ({
  document: doc, navigator: { userAgent: 'TestUA/1.0', language: 'ru-RU', platform: 'TestOS', hardwareConcurrency: 8, onLine: true }, screen: { width: 360, height: 800 }, devicePixelRatio: 3, isSecureContext: true,
  performance: { now: () => performance.now() }, setTimeout, clearTimeout, setInterval, clearInterval,
});

// ── (1) подпись источника данных ─────────────────────────────────────────────────────────────────────────────────────────

const DL = () => imp('demo', 'dataset_label.mjs');
async function tr_of(lang) {
  const catalog = (await imp('demo', 'i18n', 'dslabel.mjs')).default;
  try { I18N.register_strings('dslabel', catalog); } catch { /* уже принят */ }
  return (key, params) => N(I18N.t(lang, key, params));
}

test('REQ-125 REQ-122 TST-56 dataset_label: источник данных по событиям реестра — встроенный набор, файл (с именем и без), «с устройства»; прочие события источник не меняют', async () => {
  const { origin_after, BUILTIN_IDS, CUSTOM } = await DL();
  assert.deepEqual([...BUILTIN_IDS], ['g001', 'low', 'gap', 'late', 'empty'], 'встроенные наборы страницы');
  assert.equal(CUSTOM, 'custom');
  const base = { a: 1 };
  assert.deepEqual(origin_after(null, { reason: 'adopt', ws: base, dataset_id: 'low' }), { kind: 'dataset', id: 'low', base });
  assert.deepEqual(origin_after(null, { reason: 'adopt', ws: base, dataset_id: 'custom', file_name: 'moi.json' }), { kind: 'file', name: 'moi.json', base });
  assert.deepEqual(origin_after(null, { reason: 'adopt', ws: base, dataset_id: 'custom', file_name: null }), { kind: 'file', name: '', base }, 'имя неизвестно — пустое');
  assert.deepEqual(origin_after(null, { reason: 'adopt', ws: base, dataset_id: 'нет-такого' }), { kind: 'file', name: '', base }, 'чужой идентификатор — не встроенный набор');
  assert.deepEqual(origin_after({ kind: 'dataset', id: 'g001', base }, { reason: 'restore', ws: base }), { kind: 'device', base }, '«Продолжить с сохранённого»');
  assert.deepEqual(origin_after(null, { reason: 'restore', ws: base, origin: { kind: 'file', name: 'copy.json' } }), { kind: 'file', name: 'copy.json', base }, '«Восстановить из файла»');
  assert.deepEqual(origin_after(null, { reason: 'restore', ws: base, origin: { kind: 'что-то', name: 'x' } }), { kind: 'device', base }, 'неизвестный вид источника — с устройства');
  const prev = { kind: 'dataset', id: 'g001', base };
  for (const reason of ['edit', 'set_param', 'add_fact', 'undo', 'redo', 'import', 'undo_refresh', 'guard_answer']) assert.equal(origin_after(prev, { reason, ws: { b: 2 } }), prev, reason);
  for (const junk of [null, undefined, 5, 'adopt', [], () => 1]) assert.equal(origin_after(prev, junk), prev);
});

test('REQ-125 TST-56 dataset_label: имя файла для подписи — без управляющих знаков и крайних пробелов, не длиннее предела (длиннее — с многоточием); не строка — пусто', async () => {
  const { clean_name, NAME_MAX } = await DL();
  assert.equal(clean_name('  moi.json  '), 'moi.json');
  const messy = 'a' + String.fromCharCode(0) + 'b\tc\nd' + String.fromCharCode(0x2028) + 'e' + String.fromCharCode(0x202e) + 'f'; // управляющий знак, разделитель строк и переключатель направления письма — кодами, не литералами
  assert.equal(clean_name(messy), 'a b c d ef', 'управляющие знаки и разделители строк — пробелами, знаки направления письма убраны');
  assert.equal(clean_name('<img src=x onerror=alert(1)>.json'), '<img src=x onerror=alert(1)>.json', 'разметку не трогаем: в страницу имя идёт только через textContent');
  const long = clean_name('я'.repeat(300) + '.json');
  assert.equal(long.length, NAME_MAX);
  assert.ok(long.endsWith('…'));
  for (const v of [undefined, null, 5, {}, []]) assert.equal(clean_name(v), '');
});

test('REQ-125 TST-56 dataset_label: подписи RU и EN — «Мои данные (с устройства)», «Файл: имя», встроенный набор и файл с пометкой «изменён»; без правок встроенный набор и безымянный файл молчат', async () => {
  const { label_of } = await DL();
  const ru = await tr_of('ru');
  const en = await tr_of('en');
  const dev = { kind: 'device' };
  assert.deepEqual(label_of(ru, dev, false), { value: 'custom', text: 'Мои данные (с устройства)' });
  assert.deepEqual(label_of(ru, dev, true), { value: 'custom', text: 'Мои данные (с устройства)' }, 'данные с устройства и есть данные пользователя: пометки нет');
  assert.deepEqual(label_of(en, dev, false), { value: 'custom', text: 'My data (from this device)' });
  assert.deepEqual(label_of(ru, { kind: 'file', name: 'moi.json' }, false), { value: 'custom', text: 'Файл: moi.json' });
  assert.deepEqual(label_of(en, { kind: 'file', name: 'moi.json' }, false), { value: 'custom', text: 'File: moi.json' });
  assert.deepEqual(label_of(ru, { kind: 'file', name: 'moi.json' }, true), { value: 'custom', text: 'Файл: moi.json · изменён' });
  assert.deepEqual(label_of(en, { kind: 'file', name: 'moi.json' }, true), { value: 'custom', text: 'File: moi.json · changed' });
  assert.equal(label_of(ru, { kind: 'dataset', id: 'g001' }, false), undefined, 'встроенный набор без правок — прежняя подпись страницы');
  // FP-49 (исправление после проверки): ожидание изменено намеренно — у правленого встроенного набора в ответе появилось поле `builtin` (идентификатор набора): по нему кнопка
  // «Вернуть выбранный набор» отличает его от пунктов «Мои данные» и «Файл: …» и остаётся включённой. `value` и `text` прежние.
  assert.deepEqual(label_of(ru, { kind: 'dataset', id: 'g001' }, true), { value: 'custom', text: 'G-001 — эталон · изменён', builtin: 'g001' });
  assert.deepEqual(label_of(en, { kind: 'dataset', id: 'low' }, true), { value: 'custom', text: 'G-001-low — tight · changed', builtin: 'low' });
  // FP-49 (ADV-05): ожидание изменено намеренно. Было `undefined` («файл без имени и без правок — прежняя подпись страницы»), но после «Восстановить из файла» безымянного файла прежней подписью
  // оставалось встроенное «G-001 — эталон», хотя данные из файла: источник «файл» теперь называется всегда — «Загруженный файл» (название теста прежнее: «безымянный файл молчат» — устарело)
  assert.deepEqual(label_of(ru, { kind: 'file', name: '' }, false), { value: 'custom', text: 'Загруженный файл' }, 'файл без имени называется «Загруженный файл», а не молчит');
  assert.deepEqual(label_of(en, { kind: 'file', name: '' }, false), { value: 'custom', text: 'Uploaded file' });
  assert.deepEqual(label_of(ru, { kind: 'file', name: '' }, true), { value: 'custom', text: 'Загруженный файл · изменён' });
  assert.equal(label_of(ru, null, true), undefined);
  assert.equal(label_of(ru, { kind: 'странный' }, true), undefined);
});

test('REQ-125 TST-56 dataset_label: «изменён» — сравнение с принятой основой по каноническому виду; «Отменить» до основы пометку снимает; для данных с устройства пометки нет; ответ запоминается по ссылке', async () => {
  const { is_changed } = await DL();
  const base = clone(G);
  const origin = { kind: 'dataset', id: 'g001', base };
  const cache = new WeakMap();
  assert.equal(is_changed(origin, base, cache), false, 'та же ссылка');
  const same = clone(G);
  assert.equal(is_changed(origin, same, cache), false, 'другой объект с тем же содержимым — не изменён');
  const edited = clone(G);
  edited.params = { ...edited.params, buffer_minor: 61000 };
  assert.equal(is_changed(origin, edited, cache), true);
  assert.equal(cache.get(edited), true, 'ответ запомнен по ссылке на область');
  edited.params.buffer_minor = 1; // область по соглашению не мутируют; запомненный ответ не пересчитывается
  assert.equal(is_changed(origin, edited, cache), true);
  assert.equal(is_changed({ kind: 'device', base }, edited, new WeakMap()), false);
  assert.equal(is_changed(null, edited, new WeakMap()), false);
  assert.equal(is_changed(origin, null, new WeakMap()), false);
  assert.equal(is_changed({ kind: 'dataset', id: 'g001' }, edited, new WeakMap()), false, 'основы нет — нечего сравнивать');
  // сравнение по корзинам: общие ссылки не сравниваются, различающиеся — по каноническому виду; появление и исчезновение корзины и смена скаляра — правка
  const o2 = { kind: 'dataset', id: 'g001', base };
  const shared = { ...base };
  assert.equal(is_changed(o2, shared, new WeakMap()), false, 'все корзины общие со основой');
  assert.equal(is_changed(o2, { ...base, rules: clone(base.rules) }, new WeakMap()), false, 'корзина пересобрана с тем же содержимым (как после «Отменить»)');
  assert.equal(is_changed(o2, { ...base, rules: [...base.rules].reverse() }, new WeakMap()), true, 'порядок элементов массива — часть содержимого');
  assert.equal(is_changed(o2, { ...base, as_of: '2026-10-05' }, new WeakMap()), true, 'скаляр верхнего уровня');
  assert.equal(is_changed(o2, { ...base, extra_bucket: [1] }, new WeakMap()), true, 'корзина появилась');
  const lacking = { ...base };
  delete lacking.scenarios;
  assert.equal(is_changed(o2, lacking, new WeakMap()), true, 'корзина исчезла');
  assert.equal(is_changed(o2, { ...base, params: { ...base.params, buffer_minor: 0.5 } }, new WeakMap()), false, 'область с дробью не приводится к каноническому виду: правкой не объявляется');
});

test('REQ-125 REQ-122 TST-56 dataset_label: следопыт — цепочка событий «набор → правка → Продолжить → файл → набор», подписи в обоих языках; при рассогласовании с выбранным набором ничего не утверждает', async () => {
  const { create_tracker } = await DL();
  const ru = await tr_of('ru');
  const en = await tr_of('en');
  const t = create_tracker();
  const g = clone(G);
  assert.equal(t.label(ru, g, 'g001'), undefined, 'событий не было');
  t.on_event({ reason: 'adopt', ws: g, dataset_id: 'g001', source: 'dataset' });
  assert.equal(t.label(ru, g, 'g001'), undefined);
  const edited = clone(G); edited.params = { ...edited.params, buffer_minor: 62000 };
  t.on_event({ reason: 'set_param', ws: edited, before: g });
  // FP-49 (исправление после проверки): поле `builtin` у правленого встроенного набора (см. выше); остальные источники ниже его не имеют
  assert.deepEqual(t.label(ru, edited, 'g001'), { value: 'custom', text: 'G-001 — эталон · изменён', builtin: 'g001' });
  assert.deepEqual(t.label(en, edited, 'g001'), { value: 'custom', text: 'G-001 — reference · changed', builtin: 'g001' });
  assert.equal(t.label(ru, edited, 'low'), undefined, 'страница выбрала другой набор, чем помнит следопыт: ничего не утверждаем');
  const saved = clone(G); saved.params = { ...saved.params, buffer_minor: 63000 };
  t.on_event({ reason: 'restore', ws: saved });
  assert.deepEqual(t.label(ru, saved, 'g001'), { value: 'custom', text: 'Мои данные (с устройства)' });
  const filed = clone(G);
  t.on_event({ reason: 'restore', ws: filed, origin: { kind: 'file', name: 'copy.json' } });
  assert.deepEqual(t.label(ru, filed, 'g001'), { value: 'custom', text: 'Файл: copy.json' });
  t.on_event({ reason: 'adopt', ws: g, dataset_id: 'low' });
  assert.equal(t.label(ru, g, 'low'), undefined, 'выбор встроенного набора возвращает прежнюю подпись');
  assert.equal(t.origin().kind, 'dataset');
});

test('REQ-125 REQ-122 TST-56 data_runtime: «Восстановить из файла» передаёт странице источник {kind: file, name} (файл-область, файл-журнал, без имени — пустое имя); «Продолжить с сохранённого» — без источника; просмотр — file_name', async () => {
  const backing = STORE.create_memory_backing();
  let n = 0;
  const page = {
    ws: clone(G), sets: [], adopts: [], today: '2026-10-27',
    get_ws: () => page.ws,
    set_ws: (ws, o) => { page.ws = ws; page.sets.push(o); return { ok: true }; },
    adopt: (ws, o) => { page.ws = ws; page.adopts.push(o); return { ok: true }; },
    refresh() {},
  };
  const ports = { next_id: () => 'p~' + (++n), recorded_at: () => '2026-10-27T08:00:00Z' };
  const mk = () => RT.create_runtime({
    store: STORE.create_memory_store({ backing }), store_kind: 'memory', lock: STORE.create_lock({ locks: null }), channel: null, installed: () => true,
    today: () => page.today, ports, get_ws: page.get_ws, set_ws: page.set_ws, adopt: page.adopt, refresh: page.refresh,
  });
  const rt = mk();
  await rt.init();
  const parsed_ws = { ...DA.inspect_import(JSON.stringify(G)), file_name: 'copy.json' };
  assert.equal(parsed_ws.kind, 'workspace');
  assert.equal((await rt.restore(parsed_ws)).ok, true);
  assert.deepEqual(page.sets.at(-1), { reason: 'restore', origin: { kind: 'file', name: 'copy.json' } });
  const copy = DA.export_journal_copy(DA.events_of_ws(G));
  const parsed_j = { ...DA.inspect_import(copy.text), file_name: 'journal.json' };
  assert.equal(parsed_j.kind, 'journal');
  assert.equal((await rt.restore(parsed_j)).ok, true);
  assert.deepEqual(page.sets.at(-1), { reason: 'restore', origin: { kind: 'file', name: 'journal.json' } });
  assert.equal((await rt.restore(DA.inspect_import(copy.text))).ok, true);
  assert.deepEqual(page.sets.at(-1), { reason: 'restore', origin: { kind: 'file', name: '' } }, 'имени нет — источник «файл» с пустым именем');
  const rt2 = mk();
  assert.equal((await rt2.init()).mode, 'found');
  assert.equal((await rt2.continue_saved()).ok, true);
  assert.deepEqual(page.sets.at(-1), { reason: 'restore' }, '«Продолжить с сохранённого» источника не называет: это данные с устройства');
  const info = { newer_format: true, format: 'runway-journal/9', format_version: 9, known_version: 1, skipped: 0, source: 'file' };
  const opened = await rt2.open_readonly({ ok: true, read_only: true, read_only_info: info, ws: clone(G), events: [], file_name: 'new.json' });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(page.adopts.at(-1).file_name, 'new.json');
  assert.equal(page.adopts.at(-1).source, 'readonly');
});

test('REQ-125 TST-56 app.mjs пакет подписи источника по имени не знает: ни импорта dataset_label.mjs, ни следопыта; только имя хука; число строк с ext не больше предела waves_card', () => {
  const src = read('demo', 'app.mjs');
  assert.ok(!/dataset_label\.mjs|create_tracker|pack_fp05|dslabel/.test(src));
  assert.ok(src.includes("ext.first('dataset_label', S.dataset_id)"));
  const hook_lines = src.split('\n').filter((l) => /\bext\b/.test(l) && !/^\s*(\/\/|\*)/.test(l)).length;
  assert.ok(hook_lines <= 25, 'строк с ext в app.mjs: ' + hook_lines);
  const pack = read('demo', 'pack_fp05.mjs');
  assert.ok(pack.includes("register_hook('dataset_label'"), 'хук регистрирует пакет хранения');
});

// ── (2) отчёт об ошибке при пустом журнале ────────────────────────────────────────────────────────────────────────────────

test('REQ-124 TST-46 отчёт об ошибке: журнал без ошибок — в отчёте только версия движка, строки code нет; текст блока обещает ровно это; запись с кодом и запись без кода — как прежде', () => {
  const none = REPORT_VIEW.make_report(null, true);
  assert.equal(none.ok, true);
  assert.deepEqual(none.fields, { engine_version: V0 });
  assert.equal(none.text, `engine_version: ${V0}`);
  assert.ok(!none.text.includes('code'), 'строки code нет');
  assert.ok(!none.text.includes('E_UNKNOWN'));
  assert.equal(none.text, LOG.report_text(none.fields), 'текст — ровно поля отчёта');
  assert.deepEqual(REPORT_VIEW.make_report(undefined, true).fields, { engine_version: V0 });
  assert.equal(REPORT_VIEW.make_report(null, true, '9.9.9').text, 'engine_version: 9.9.9');
  assert.deepEqual(REPORT_VIEW.make_report(null, false), { ok: false, reason: 'consent_required' }, 'без согласия отчёта нет');
  // запись с кодом: поля белого списка в прежнем порядке
  const lg = LOG.create_logger();
  lg.error('write_failed', { id: 'evt~000010', n: 47, ms: 12, code: 'store_failed' });
  assert.equal(REPORT_VIEW.make_report(REPORT_VIEW.latest_error(lg.entries()), true).text, `id: evt~000010\nn: 47\nms: 12\ncode: store_failed\nengine_version: ${V0}`);
  // запись без кода: ошибка была, код неизвестен — `code: E_UNKNOWN` остаётся честным признанием
  lg.clear();
  lg.error('write_failed', { n: 1 });
  assert.equal(REPORT_VIEW.make_report(REPORT_VIEW.latest_error(lg.entries()), true, '9.9.9').text, 'n: 1\ncode: E_UNKNOWN\nengine_version: 9.9.9');
});

test('REQ-124 TST-46 каталог блока «Сообщить об ошибке»: обещание «только версия движка» при пустом журнале сохранено в RU и EN (отчёт ему соответствует)', async () => {
  const cat = (await imp('demo', 'i18n', 'errrep.mjs')).default;
  assert.match(cat.ru['errrep.none'], /в отчёт войдёт только версия движка/);
  assert.match(cat.en['errrep.none'], /the report will carry only the engine version/);
  const src = read('demo', 'error_report_view.mjs');
  assert.ok(/report_text\(only_version\)/.test(src), 'отчёт без записи собирается из одной версии движка');
});

// ── (3) подпись перенесённого вхождения ─────────────────────────────────────────────────────────────────────────────────────

async function forms_tr(lang) {
  const catalog = (await imp('demo', 'i18n', 'forms.mjs')).default;
  try { I18N.register_strings('forms', catalog); } catch { /* уже принят */ }
  return (key, params) => N(I18N.t(lang, key, params));
}

test('REQ-010 REQ-032 TST-58 date_by_rule: дата вхождения «по правилу» — со сдвигом выходных (G-001: аренда 25 октября, воскресенье → 26 октября), без записи о переносе; будний день — без сдвига', () => {
  const rent = G.rules.find((r) => r.rule_id === 'R-RENT');
  assert.equal(RULE.date_by_rule(G, rent, '2026-10-25'), '2026-10-26', 'воскресенье 25-го показывается понедельником 26-го');
  assert.equal(RULE.date_by_rule(G, rent, '2026-11-25'), '2026-11-25', 'среда — как есть');
  const moved = { ...clone(G), overrides: [{ rule_id: 'R-RENT', nominal_date: '2026-10-25', action: 'move', date: '2026-10-28' }] };
  assert.equal(RULE.date_by_rule(moved, rent, '2026-10-25'), '2026-10-26', 'запись о переносе не учитывается: это дата ДО переноса');
  assert.equal(RULE.date_by_rule(moved, rent, '2026-10-26'), null, 'не вхождение правила — null');
  assert.equal(RULE.date_by_rule({ ...clone(G), overrides: 'не массив' }, rent, '2026-10-25'), '2026-10-26', 'порченый список правок не роняет');
});

test('REQ-010 REQ-032 TST-58 moved_from_text и moved_row_text: «перенесено с 26 октября (по правилу — 25 октября)» RU и EN; даты совпадают — без скобок', async () => {
  const f = APP.make_fmt('ru', 'EUR', '2026-10-04');
  const fe = APP.make_fmt('en', 'EUR', '2026-10-04');
  const ru = await forms_tr('ru');
  const en = await forms_tr('en');
  assert.equal(N(RULE.moved_from_text(ru, f, '2026-10-26', '2026-10-25')), 'перенесено с 26 октября (по правилу — 25 октября)');
  assert.equal(N(RULE.moved_from_text(ru, f, '2026-11-25', '2026-11-25')), 'перенесено с 25 ноября', 'будний день: дата правила и показанная одна');
  assert.equal(N(RULE.moved_from_text(en, fe, '2026-10-26', '2026-10-25')), 'moved from October 26 (by the rule — October 25)');
  assert.equal(N(RULE.moved_from_text(en, fe, '2026-11-25', '2026-11-25')), 'moved from November 25');
  const o = { nominal_date: '2026-10-25', date: '2027-02-10' };
  assert.equal(N(RULE.moved_row_text(ru, f, '2026-10-26', o)), 'Перенесено: 26 октября → 10 февраля 2027 (по правилу — 25 октября)');
  assert.equal(N(RULE.moved_row_text(ru, f, '2026-10-25', o)), 'Перенесено: 25 октября → 10 февраля 2027');
  assert.equal(N(RULE.moved_row_text(en, fe, '2026-10-26', o)), 'Moved: October 26 → February 10, 2027 (by the rule — October 25)');
  assert.equal(N(RULE.moved_row_text(en, fe, '2026-10-25', o)), 'Moved: October 25 → February 10, 2027');
});

test('TST-56 REQ-010 новые строки подписи переноса: RU и EN, одни и те же плейсхолдеры, ключи используются кодом литералом', async () => {
  const cat = (await imp('demo', 'i18n', 'forms.mjs')).default;
  const ph = (s) => [...s.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]).sort();
  for (const k of ['forms.ov_mark_moved_rule', 'forms.ov_row_move_rule']) {
    assert.ok(typeof cat.ru[k] === 'string' && typeof cat.en[k] === 'string', k);
    assert.deepEqual(ph(cat.ru[k]), ph(cat.en[k]), k);
    assert.match(cat.ru[k], /[а-яё]/i);
    assert.ok(read('demo', 'form_rule.mjs').includes(`'${k}'`), 'код использует ' + k);
  }
  assert.deepEqual(ph(cat.ru['forms.ov_mark_moved_rule']), ['from', 'rule']);
  assert.deepEqual(ph(cat.ru['forms.ov_row_move_rule']), ['from', 'rule', 'to']);
});

// ── (4) «Горизонт» ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-019 TST-58 горизонт: horizon_ahead_of = дней вперёд от даты расчёта (число из «Настроек»), строк ряда на одну больше; то же число в «Запасе хода» и на листе для печати; G-001 — 57 и 58', () => {
  const m = APP.build_model(G);
  assert.equal(G.params.horizon_days, 57);
  assert.equal(APP.horizon_days_of(m), 58, 'строк ряда — с днём расчёта (прежнее число не менялось)');
  assert.equal(APP.horizon_ahead_of(m), 57);
  assert.equal(E.to_epoch_day(m.as_of_iso) + APP.horizon_ahead_of(m), m.ctx.horizon_end, 'дата расчёта плюс число = конец горизонта');
  const rm = HC.runway_model(m);
  assert.equal(rm.horizon_days, 58);
  assert.equal(rm.horizon_ahead, 57);
  const rp = RP.report_model(m);
  assert.equal(rp.horizon_days, 58);
  assert.equal(rp.horizon_ahead, 57);
  // умолчание словаря — 180: число называется одинаково
  const no_horizon = clone(G);
  delete no_horizon.params.horizon_days;
  const dflt = APP.build_model(no_horizon);
  assert.equal(APP.horizon_ahead_of(dflt), 180);
  assert.equal(HC.runway_model(dflt).horizon_ahead, 180);
  assert.equal(E.to_epoch_day(dflt.as_of_iso) + 180, dflt.ctx.horizon_end);
});

test('TST-56 REQ-019 горизонт: строка «Настроек» settings.horizon_now — RU и EN, плейсхолдеры n и date, ключ используется литералом', async () => {
  const cat = (await imp('demo', 'i18n', 'settings.mjs')).default;
  const ph = (s) => [...s.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]).sort();
  assert.deepEqual(ph(cat.ru['settings.horizon_now']), ['date', 'n']);
  assert.deepEqual(ph(cat.en['settings.horizon_now']), ['date', 'n']);
  assert.match(cat.ru['settings.horizon_now'], /то же число стоит в шапке/);
  assert.match(cat.en['settings.horizon_now'], /the header shows the same number/);
  assert.ok(read('demo', 'settings.mjs').includes("'settings.horizon_now'"));
});

// ── (6) coldstart.html ────────────────────────────────────────────────────────────────────────────────────────────────────

const blocked_window = () => ({ get document() { throw new Error('SecurityError'); } });
const cold_ports = (win, over = {}) => ({
  now: () => performance.now(), set_interval: (fn, ms) => setInterval(fn, ms), clear_interval: clearInterval, set_timeout: (fn, ms) => setTimeout(fn, ms), clear_timeout: clearTimeout,
  make_frame: () => ({ contentWindow: win, remove() {} }), poll_ms: 1, timeout_ms: 600, ...over,
});

test('REQ-152 TST-59 coldstart: окно, которое браузер заблокировал (frame-ancestors), называется «blocked» после BLOCKED_MS подряд, а не после всего тайм-аута; запуск не ждёт 30 с', async () => {
  assert.equal(COLD.BLOCKED_MS, 1000, 'около секунды: об этом говорит подсказка страницы');
  const t0 = performance.now();
  const r = await COLD.run_once(cold_ports(blocked_window()), 't');
  const spent = performance.now() - t0;
  assert.deepEqual([r.ok, r.state, r.dom_ms, r.paint_ms], [false, 'blocked', null, null]);
  assert.ok(spent < 300, `заблокированное окно ждало ${Math.round(spent)} мс из 600`);
});

test('REQ-152 TST-59 coldstart: короткий сбой доступа к окну (дольше не длится, чем blocked_ms) запуск не прерывает; пустой документ и загрузка тоже ждут «Обзор»', async () => {
  let reads = 0;
  const dom = { getElementById: (id) => (id === 'view-title' ? {} : null), querySelector: () => ({ getAttribute: () => '#overview' }) };
  const flaky = {
    location: { href: './index.html#overview' },
    performance: { now: () => 700, getEntriesByType: () => [] },
    navigator: {},
    requestAnimationFrame: (fn) => { setTimeout(fn, 0); },
  };
  Object.defineProperty(flaky, 'document', { get() { reads += 1; if (reads <= 10) throw new Error('SecurityError'); return dom; } });
  const ok = await COLD.run_once(cold_ports(flaky, { timeout_ms: 20000, blocked_ms: 5000 }), 't');
  assert.deepEqual([ok.ok, ok.state], [true, 'overview'], 'десять сбоев подряд — меньше предела');
  assert.ok(reads > 10);
  const never = { location: { href: 'about:blank' }, document: dom, performance: { now: () => 1 }, navigator: {} };
  const slow = await COLD.run_once(cold_ports(never, { timeout_ms: 120 }), 't');
  assert.deepEqual([slow.ok, slow.state], [false, 'blank'], 'пустой документ ждёт до тайм-аута, а не объявляется заблокированным');
});

test('REQ-152 TST-59 coldstart: подсказка «где замер работает» стоит на странице до кнопки, RU и EN; называет Apache (XAMPP), HTTPS-хост и node serve.mjs с заголовком frame-ancestors', async () => {
  const cat = (await imp('demo', 'i18n', 'coldpg.mjs')).default;
  for (const lang of ['ru', 'en']) {
    const s = cat[lang]['coldpg.h_server'];
    assert.ok(/Apache/.test(s) && /HTTPS/.test(s) && /node serve\.mjs/.test(s) && /frame-ancestors/.test(s), lang + ': ' + s);
  }
  assert.match(cat.ru['coldpg.h_server'], /примерно через секунду/);
  assert.match(cat.en['coldpg.h_server'], /after about a second/);
  for (const lang of ['ru', 'en']) {
    reset_dom();
    const ports = { ...COLD.make_ports(fake_env()), clock: () => new Date(2026, 9, 27) };
    const page = COLD.make_page(lang, ports);
    COLD.render_page(page);
    const hint = doc.getElementById('cs-server-hint');
    assert.ok(hint !== null, lang + ': подсказка на странице');
    assert.equal(hint.textContent, cat[lang]['coldpg.h_server']);
    const main = doc.getElementById('main');
    const nodes = find_all(main, () => true);
    const at = (pred) => nodes.findIndex(pred);
    assert.ok(at((n) => n.attrs.id === 'cs-server-hint') < at((n) => n.attrs.id === 'cs-run'), lang + ': подсказка раньше кнопки «Запустить замер»');
  }
});

test('REQ-152 TST-59 coldstart: CSP приложения не ослаблена (serve.mjs: frame-ancestors none, без unsafe-*), CSP страницы замера прежняя (frame-src self), для замера названы Apache или HTTPS-хост в README и CHECKLIST-release', () => {
  const serve = read('serve.mjs');
  const csp = /const CSP = "([^"]+)"/.exec(serve)?.[1];
  assert.equal(csp, "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  assert.ok(!/unsafe/.test(csp));
  const html = read('demo', 'coldstart.html');
  const page_csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  assert.equal(page_csp, "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; frame-src 'self'; base-uri 'none'; form-action 'none'");
  assert.ok(!/frame-ancestors/.test(read('demo', '.htaccess')), '.htaccess запрета вложения не вводит и не снимает');
  const checklist = read('CHECKLIST-release.md');
  assert.match(checklist, /Для замера `demo\/coldstart\.html` \(P4\) использовать Apache \(XAMPP\) или HTTPS-хост/);
  assert.match(checklist, /`node serve\.mjs` запрещает вложение страниц заголовком `frame-ancestors 'none'`/);
  const readme = read('README.md');
  assert.match(readme, /для замера использовать Apache \(XAMPP\) или HTTPS-хост/);
  assert.ok(!/window\.open/.test(read('demo', 'coldstart_page.mjs')), 'отдельная вкладка не используется (решение FP-48)');
});
