// fp49_fix.test.mjs — исправление пакета FP-49 после независимой проверки (2026-10-28): три дефекта, найденные проверяющим (тесты проверяющего — fp49_adv.test.mjs).
// (1) средний, ADV-1: кнопка «Вернуть выбранный набор» на экране «Данные» была отключена и для ВСТРОЕННОГО набора с пометкой «· изменён» («G-001 — эталон · изменён») — единственного состояния, в котором
//     она что-то возвращает. Теперь ответ хука `dataset_label` у правленого встроенного набора несёт `builtin` (идентификатор набора), страница (`reset_target`) оставляет кнопку включённой и грузит
//     именно `S.dataset_id`; «Мои данные», «Файл: …» и «Загруженный файл» поля не имеют — для них кнопка по-прежнему отключена, рядом пояснение. Чистая часть (подпись, следопыт) и экран.
// (2) низкий, ADV-2: у отключённой кнопки `.btn` не было вида «отключена» — правила `.btn:disabled` в style.css (статические проверки текста таблицы стилей).
// (3) низкий: тесты с разреженным массивом длиной 2^31 в fuzz_findings.test.mjs теперь идут в дочернем процессе с ограниченной кучей (сами тесты и их проверка — в fuzz_findings.test.mjs,
//     процесс — tests/fuzz_findings_child.mjs; в этом файле их нет).
// Приложение запускается настоящим app.mjs на заглушке DOM (tests/dom_boot.mjs); браузер, серверы и сеть не запускаются. Расчёт по введённым данным и правилам, не консультация.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/fp49_fix.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { boot_app, find_all, N } from './dom_boot.mjs';

const PROTO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);
const read = (...p) => fs.readFileSync(path.join(PROTO, ...p), 'utf8');
const I18N = await imp('demo', 'i18n.mjs');
const DL = await imp('demo', 'dataset_label.mjs');
const G = JSON.parse(read('data', 'g001.json'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const BUILTIN = I18N.DATASETS.map((d) => d.id);
const HINT_RU = 'Нужно выбрать встроенный набор в списке выше.';

const A = await boot_app();
const ctx = A.ext.ctx;
const settle = async (n = 6) => { for (let i = 0; i < n; i++) { await A.tick(); await wait(20); } };
const reset = async (id = 'g001') => { await A.choose_dataset(id); await A.go('#overview'); await settle(); };
const ds_select = (id) => find_all(id === 'ds-top' ? A.controls() : A.main(), (n) => n.tagName === 'select' && n.attrs.id === id)[0];
const chosen = (id = 'ds-top') => find_all(ds_select(id), (n) => n.tagName === 'option').filter((o) => o.attrs.selected !== undefined).map((o) => [o.attrs.value, N(o.textContent)]);
const reset_button = () => find_all(A.main(), (n) => n.tagName === 'button' && n.attrs.id === 'ds-reset')[0];
const reset_hint = () => find_all(A.main(), (n) => n.attrs.id === 'ds-reset-hint')[0];
const is_disabled = (btn) => btn.attrs.disabled !== undefined;
const tr_of = (lang) => (key, params) => N(I18N.t(lang, key, params)); // строки подписи источника («dslabel.*») регистрирует пакет хранения при запуске приложения (оно уже запущено выше)

// ═══ (1) чистая часть: подпись правленого встроенного набора несёт идентификатор набора ═══════════════════════════════════════════════

test('REQ-125 REQ-122 TST-56 (ADV-1) label_of: правленый встроенный набор несёт `builtin` — идентификатор набора (все пять наборов, RU и EN); «Мои данные», «Файл: …», «Загруженный файл» и неизвестный набор поля не имеют', () => {
  for (const lang of ['ru', 'en']) {
    const tr = tr_of(lang);
    for (const id of BUILTIN) {
      const hit = DL.label_of(tr, { kind: 'dataset', id }, true);
      assert.deepEqual(hit, { value: 'custom', text: tr('ds.' + id) + ' · ' + tr('dslabel.changed'), builtin: id }, `${lang}/${id}`);
      assert.equal(DL.label_of(tr, { kind: 'dataset', id }, false), undefined, `${lang}/${id}: без правок прежняя подпись страницы`);
    }
    for (const [what, origin] of [['с устройства', { kind: 'device' }], ['файл с именем', { kind: 'file', name: 'moi.json' }], ['файл без имени', { kind: 'file', name: '' }], ['файл, имя не строка', { kind: 'file', name: 5 }]]) {
      for (const changed of [false, true]) {
        const hit = DL.label_of(tr, origin, changed);
        assert.ok(hit !== undefined && hit.value === 'custom', `${lang}/${what}/${changed}`);
        assert.equal(Object.hasOwn(hit, 'builtin'), false, `${lang}/${what}/${changed}: поля builtin нет`);
        assert.deepEqual(Object.keys(hit).sort(), ['text', 'value'], `${lang}/${what}/${changed}: прежний вид ответа {value, text}`);
      }
    }
  }
  // идентификатор не из встроенных (повреждённый источник) в `builtin` не попадает
  const odd = DL.label_of(tr_of('ru'), { kind: 'dataset', id: 'нет-такого' }, true);
  assert.equal(Object.hasOwn(odd, 'builtin'), false);
  assert.equal(odd.value, 'custom');
});

test('REQ-125 REQ-122 TST-56 (ADV-1) следопыт: «набор → правка» — builtin = набор; «→ Продолжить с сохранённого», «→ файл», «→ открытие файла» — без builtin; новый встроенный набор и его правка — builtin нового набора; рассогласование с выбором страницы молчит', () => {
  const tr = tr_of('ru');
  const t = DL.create_tracker();
  const g = clone(G);
  t.on_event({ reason: 'adopt', ws: g, dataset_id: 'g001', source: 'dataset' });
  assert.equal(t.label(tr, g, 'g001'), undefined, 'без правок — молчит');
  const edited = clone(G); edited.params = { ...edited.params, buffer_minor: 62000 };
  t.on_event({ reason: 'set_param', ws: edited, before: g });
  assert.equal(t.label(tr, edited, 'g001').builtin, 'g001');
  assert.equal(t.label(tr, edited, 'low'), undefined, 'страница выбрала другой набор, чем помнит следопыт: ничего не утверждаем, в том числе builtin');
  const saved = clone(G); saved.params = { ...saved.params, buffer_minor: 63000 };
  t.on_event({ reason: 'restore', ws: saved });
  assert.equal(Object.hasOwn(t.label(tr, saved, 'g001'), 'builtin'), false, 'данные с устройства');
  const filed = clone(G);
  t.on_event({ reason: 'restore', ws: filed, origin: { kind: 'file', name: 'copy.json' } });
  assert.equal(Object.hasOwn(t.label(tr, filed, 'g001'), 'builtin'), false, 'файл-копия');
  const opened = clone(G);
  t.on_event({ reason: 'adopt', ws: opened, dataset_id: 'custom', file_name: 'opened.json' });
  const opened_edit = clone(G); opened_edit.params = { ...opened_edit.params, buffer_minor: 64000 };
  t.on_event({ reason: 'set_param', ws: opened_edit, before: opened });
  const hit = t.label(tr, opened_edit, 'custom');
  assert.deepEqual(hit, { value: 'custom', text: 'Файл: opened.json · изменён' }, 'открытый и правленый файл: подпись «изменён», но не builtin');
  const low = clone(G);
  t.on_event({ reason: 'adopt', ws: low, dataset_id: 'low' });
  const low_edit = clone(G); low_edit.params = { ...low_edit.params, buffer_minor: 65000 };
  t.on_event({ reason: 'set_param', ws: low_edit, before: low });
  assert.equal(t.label(tr, low_edit, 'low').builtin, 'low', 'новый встроенный набор и его правка');
});

// ═══ (1) экран «Данные»: кнопка «Вернуть выбранный набор» ═══════════════════════════════════════════════════════════════════════════

test('REQ-125 TST-58 (ADV-1) правленый встроенный набор («… · изменён») — на каждом из пяти наборов кнопка «Вернуть выбранный набор» включена, пояснения нет, нажатие возвращает ИМЕННО этот набор (а не G-001) и снимает пометку', async () => {
  for (const [i, id] of BUILTIN.entries()) {
    await reset(id);
    const pristine = clone(ctx.get_ws());
    assert.equal(ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 61357 + i }).ok, true, id + ': правка');
    await A.go('#data');
    await settle(2);
    const name = N(I18N.t('ru', 'ds.' + id));
    assert.deepEqual(chosen('ds-sel'), [['custom', name + ' · изменён']], id + ': выбран правленый встроенный набор');
    assert.deepEqual(chosen('ds-top'), [['custom', name + ' · изменён']], id + ': и в шапке');
    const btn = reset_button();
    assert.ok(btn !== undefined, id + ': кнопка на экране');
    assert.equal(N(btn.textContent), 'Вернуть выбранный набор');
    assert.equal(is_disabled(btn), false, id + ': кнопка включена');
    assert.equal(btn.attrs['aria-describedby'], undefined, id + ': связи с пояснением нет');
    assert.equal(reset_hint(), undefined, id + ': пояснения нет');
    assert.match(btn.attrs.class ?? btn.className, /\bbtn\b/, 'обычная кнопка .btn');
    const before = ctx.get_ws();
    await btn.listeners.click[0]();
    await settle();
    assert.notEqual(ctx.get_ws(), before, id + ': набор загружен заново');
    assert.deepEqual(ctx.get_ws(), pristine, id + ': вернулось исходное содержимое именно этого набора');
    assert.deepEqual(chosen('ds-sel'), [[id, name]], id + ': выбран встроенный набор без пометки');
  }
  await reset();
});

test('REQ-125 TST-58 (ADV-1) на экране «Данные» кнопка следует за источником без перехода между экранами: набор → правка (включена) → «Продолжить с сохранённого» (отключена, пояснение) → выбор встроенного набора (включена); RU и EN', async () => {
  await reset();
  await A.go('#data');
  await settle(2);
  assert.equal(is_disabled(reset_button()), false, 'встроенный набор без правок');
  assert.equal(ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 66001 }).ok, true);
  await settle();
  assert.deepEqual(chosen('ds-sel'), [['custom', 'G-001 — эталон · изменён']]);
  assert.equal(is_disabled(reset_button()), false, 'после правки на том же экране кнопка остаётся включённой');
  assert.equal(reset_hint(), undefined);
  A.set_lang('en');
  assert.deepEqual(chosen('ds-sel'), [['custom', 'G-001 — reference · changed']]);
  assert.equal(N(reset_button().textContent), 'Reset the selected set');
  assert.equal(is_disabled(reset_button()), false);
  assert.equal(reset_hint(), undefined);
  A.set_lang('ru');
  // «Продолжить с сохранённого»: данные пользователя, не встроенный набор
  const mine = clone(ctx.get_ws()); mine.params = { ...mine.params, buffer_minor: 66002 };
  assert.equal(ctx.set_ws(mine, { reason: 'restore' }).ok, true);
  await settle();
  assert.deepEqual(chosen('ds-sel'), [['custom', 'Мои данные (с устройства)']]);
  assert.equal(is_disabled(reset_button()), true, 'данные с устройства: кнопка отключена');
  assert.equal(N(reset_hint().textContent), HINT_RU);
  assert.equal(reset_button().attrs['aria-describedby'], 'ds-reset-hint');
  const kept = ctx.get_ws();
  await reset_button().listeners.click[0]();
  await settle();
  assert.equal(ctx.get_ws(), kept, 'нажатие данных пользователя не заменило');
  // встроенный набор в списке — кнопка снова включена, пояснение ушло
  const sel = ds_select('ds-sel');
  sel.value = 'low';
  await sel.listeners.change[0]();
  await settle();
  assert.deepEqual(chosen('ds-sel').map((c) => c[0]), ['low']);
  assert.equal(is_disabled(reset_button()), false);
  assert.equal(reset_hint(), undefined);
  await reset();
});

test('REQ-125 TST-58 (ADV-1) «Файл: …» и «Загруженный файл» после правки по-прежнему пункты-источники: кнопка отключена (в `builtin` они не попадают), данные пользователя не заменяются', async () => {
  for (const [label, origin, text] of [['файл с именем', { kind: 'file', name: 'moi.json' }, 'Файл: moi.json · изменён'], ['файл без имени', { kind: 'file', name: '' }, 'Загруженный файл · изменён']]) {
    await reset();
    const w = clone(ctx.get_ws()); w.params = { ...w.params, buffer_minor: 67001 };
    assert.equal(ctx.set_ws(w, { reason: 'restore', origin }).ok, true, label);
    assert.equal(ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 67002 }).ok, true, label);
    await A.go('#data');
    await settle(2);
    assert.deepEqual(chosen('ds-sel'), [['custom', text]], label);
    assert.equal(is_disabled(reset_button()), true, label + ': кнопка отключена');
    assert.equal(N(reset_hint().textContent), HINT_RU, label);
    const before = ctx.get_ws();
    await reset_button().listeners.click[0]();
    await settle();
    assert.equal(ctx.get_ws(), before, label + ': данные те же объекты');
    assert.equal(ctx.get_ws().params.buffer_minor, 67002, label + ': данные пользователя на месте');
  }
  await reset();
});

test('REQ-125 TST-58 (ADV-1) кнопка всегда грузит набор страницы (`S.dataset_id`), а не то, что назвал хук: чужое или неверное поле `builtin` кнопку не включает и другой набор не загружает', async () => {
  // хук следопыта молчит, пока набор не правили, и тогда отвечает чужой хук, зарегистрированный позже (первый ответ не `undefined` побеждает)
  const answers = [
    ['builtin другого набора', { value: 'custom', text: 'Чужая подпись', builtin: 'low' }, true],
    ['builtin неизвестного набора', { value: 'custom', text: 'Чужая подпись', builtin: 'нет-такого' }, true],
    ['builtin не строка', { value: 'custom', text: 'Чужая подпись', builtin: 5 }, true],
    ['без builtin', { value: 'custom', text: 'Чужая подпись' }, true],
    ['builtin набора страницы', { value: 'custom', text: 'Чужая подпись', builtin: 'g001' }, false],
  ];
  for (const [label, answer, disabled] of answers) {
    await reset();
    const pristine = clone(ctx.get_ws());
    const off = A.ext.register_hook('dataset_label', () => answer);
    try {
      await A.go('#data');
      await settle(2);
      assert.deepEqual(chosen('ds-sel'), [['custom', 'Чужая подпись']], label);
      assert.equal(is_disabled(reset_button()), disabled, label + ': кнопка ' + (disabled ? 'отключена' : 'включена'));
      assert.equal(reset_hint() !== undefined, disabled, label + ': пояснение ' + (disabled ? 'есть' : 'нет'));
      const before = ctx.get_ws();
      await reset_button().listeners.click[0]();
      await settle();
      if (disabled) assert.equal(ctx.get_ws(), before, label + ': ничего не загружено');
      else {
        // чужой хук ещё отвечает, поэтому подпись в списке прежняя; важно, что загружен набор страницы (g001), а не какой-то другой
        assert.notEqual(ctx.get_ws(), before, label + ': набор загружен заново');
        assert.deepEqual(ctx.get_ws(), pristine, label + ': и это набор страницы g001');
      }
    } finally { off(); }
    await reset('g001');
  }
});

test('REQ-167 TST-58 (урок 10) правленый встроенный набор: нажатие «Вернуть выбранный набор» заменяет экран вместе с кнопкой — фокус возвращается на новую кнопку, а не падает на body', async () => {
  await reset();
  assert.equal(ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 68001 }).ok, true);
  await A.go('#data');
  await settle(2);
  const btn = reset_button();
  assert.equal(is_disabled(btn), false);
  btn.focus();
  assert.equal(globalThis.document.activeElement, btn);
  A.emulate_focus_loss(true); // как в браузере: узел, убранный перерисовкой, роняет фокус на body
  try {
    await btn.listeners.click[0]();
    await settle();
    const now = reset_button();
    assert.ok(now !== undefined && now !== btn, 'экран перерисован: кнопка новая');
    assert.equal(globalThis.document.activeElement, now, 'фокус на новой кнопке');
    assert.deepEqual(chosen('ds-sel'), [['g001', 'G-001 — эталон']]);
  } finally { A.emulate_focus_loss(false); }
  await reset();
});

// ═══ (2) вид отключённой кнопки `.btn` ═══════════════════════════════════════════════════════════════════════════════════════════════

/** Тело правила таблицы стилей по точному селектору (последнее такое правило в тексте). */
function css_body(css, selector) {
  const re = new RegExp('(?:^|\\})\\s*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g');
  let body = null;
  for (const m of css.matchAll(re)) body = m[1];
  return body;
}

test('TST-58 (ADV-2) style.css: у отключённой кнопки `.btn` есть вид «отключена» — полупрозрачность и курсор «нельзя»; подсветки при наведении у неё нет (у `.btn.primary` фон остаётся акцентным); прежние правила `.btn` на месте', () => {
  const css = read('demo', 'style.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const disabled = css_body(css, '.btn:disabled');
  assert.ok(disabled !== null, 'правило `.btn:disabled` есть');
  assert.match(disabled, /opacity:\s*0?\.\d+/, 'полупрозрачность');
  assert.ok(Number(/opacity:\s*(0?\.\d+)/.exec(disabled)[1]) < 1);
  assert.match(disabled, /cursor:\s*not-allowed/, 'курсор «нельзя», а не рука');
  assert.match(css_body(css, '.btn:disabled:hover') ?? '', /background:\s*var\(--surface\)/, 'наведение на отключённую кнопку фон не меняет');
  assert.match(css_body(css, '.btn.primary:disabled:hover') ?? '', /background:\s*var\(--accent\)/, 'у отключённой основной кнопки при наведении фон остаётся акцентным');
  // правила, которые перекрывает вид «отключена», не изменены
  assert.match(css_body(css, '.btn:hover, .chip:hover, .seg button:hover') ?? '', /background:\s*var\(--surface-2\)/);
  assert.match(css_body(css, '.btn.primary') ?? '', /background:\s*var\(--accent\)/);
  assert.match(css_body(css, '.chip:disabled') ?? '', /opacity:\s*0\.55;\s*cursor:\s*not-allowed/, 'соседнее правило для .chip прежнее');
  // новые правила стоят ПОСЛЕ `.btn:hover` и `.btn.primary` (при равной специфичности решает порядок; здесь специфичность выше, но порядок тоже читается сверху вниз)
  const at = (s) => css.indexOf(s);
  assert.ok(at('.btn:disabled {') > at('.btn.primary {') && at('.btn:disabled:hover {') > at('.btn:disabled {') && at('.btn.primary:disabled:hover {') > at('.btn:disabled:hover {'));
});

test('TST-58 (ADV-2) правило отключённой кнопки не использует ничего, что запрещает политика страницы: ни внешних адресов, ни `url(`, ни `@import`; и оно общее для всех экранов (style.css подключён страницей)', () => {
  const css = read('demo', 'style.css');
  const block = css.slice(css.indexOf('.btn:disabled'), css.indexOf('.chips {'));
  assert.ok(block.length > 0);
  assert.ok(!/url\(|@import|https?:|expression\(/i.test(block));
  assert.match(read('demo', 'index.html'), /style\.css/);
});
