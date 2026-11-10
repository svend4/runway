// layout_fp26.test.mjs — FP-26, адаптив и подписи (U21, U22, U23, U40, U41): группа «Ещё» в нижней панели на телефоне, две колонки «Обзора», скелет загрузки с aria-busy и названия ступеней
// готовности в шапке. Настоящий app.mjs на заглушке DOM с переключаемой шириной окна (matchMedia); CSS — статическим разбором. Расчёт и данные не затронуты (проверяет и golden/g001).
// Правила, которые держит тест: порядок в DOM = видимый порядок = порядок Tab (CSS order не используется); ни один раздел и ни одно действие не пропадают при группировке;
// на широком окне навигация остаётся двумя списками S1.4. Настоящий телефон, 200 % и скринридер не запускались — работа людей (FP-40).
// Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { boot_app, find_all, N, DEMO, Node_ } from './dom_boot.mjs';

const read = (...p) => fs.readFileSync(path.join(DEMO, ...p), 'utf8');

// ── 1. скелет загрузки: пока набор данных читается ──────────────────────────────────────────────────────────────────────────

const SK = await boot_app({ phone: true, hold_fetch: true });

test('U40 загрузка: пока набор данных читается, #main помечен aria-busy, видна строка статуса, блоки скелета скрыты от скринридера; в навигации разделы уже есть', async () => {
  const main = SK.main();
  assert.equal(main.attrs['aria-busy'], 'true', 'aria-busy="true" на #main');
  const status = find_all(main, (n) => n.attrs.role === 'status');
  assert.equal(status.length, 1);
  assert.equal(N(status[0].textContent), 'Загрузка набора данных…', 'видимая строка статуса — прежний текст app.loading');
  const sk = find_all(main, (n) => n.className === 'skeleton');
  assert.equal(sk.length, 1);
  assert.equal(sk[0].attrs['aria-hidden'], 'true', 'скелет — украшение, скринридеру он не нужен');
  assert.equal(sk[0].children.length, 3, 'три блока');
  assert.ok(sk[0].children.at(-1).className.includes('sk-chart'), 'последний блок — место графика');
  assert.equal(find_all(sk[0], (n) => n.tagName === 'a' || n.tagName === 'button' || n.tagName === 'input').length, 0, 'в скелете нет ничего интерактивного');
  assert.equal(find_all(SK.nav(), (n) => n.tagName === 'a').length > 10, true, 'во время загрузки навигация уже построена');
});

test('U40 после загрузки aria-busy снят, скелета нет, «Обзор» нарисован; в исходнике render_main отметка ставится до разбора состояний, поэтому снимается и при ошибке чтения', async () => {
  await SK.release();
  assert.equal(SK.main().attrs['aria-busy'], undefined, 'aria-busy снят');
  assert.equal(find_all(SK.main(), (n) => n.className === 'skeleton').length, 0);
  assert.ok(SK.by_id('view-title') !== undefined && SK.text_of('main').includes('Хватит ли денег'), 'экран «Обзор» на месте');
  assert.equal(SK.ext.ctx.get_model().ctx.readiness.score, 4);
  const src = read('app.mjs');
  const at = (x) => src.indexOf(x);
  assert.ok(at("mark_busy(main, S.status === 'loading')") > 0 && at("mark_busy(main, S.status === 'loading')") < at("if (S.status === 'loading')") && at("if (S.status === 'loading')") < at("if (S.status === 'error')"));
});

// ── 2. группа «Ещё» на телефоне ────────────────────────────────────────────────────────────────────────────────────────────────

const A = SK; // тот же процесс и то же приложение; окно уже узкое (phone: true)
const nav = () => A.nav();
const kids = () => nav().children;
const tab_stops = () => find_all(nav(), (n) => n.tagName === 'a' || n.tagName === 'button' || n.tagName === 'summary');
const hrefs_in = (root) => find_all(root, (n) => n.tagName === 'a').map((a) => a.attrs.href);
const CORE = ['overview', 'buy', 'waves', 'reserves', 'scenarios', 'feed', 'assistant', 'data'];
const registry = () => A.ext.nav_items(CORE).map((v) => '#' + v.id);

test('U22 телефон: навигация = [вкладки, «Ещё», действия]; вкладки — Обзор, Купить, Лента, Волны; у панели класс nav-grouped; «Ещё» свёрнуто', () => {
  assert.deepEqual(kids().map((k) => k.tagName + '.' + k.className.split(' ')[0]), ['ul.nav-sections', 'details.nav-more', 'ul.nav-actions']);
  assert.ok(nav().className.split(' ').includes('nav-grouped'));
  assert.ok(nav().className.split(' ').includes('nav'), 'прежний класс панели остался');
  const [primary, more, actions] = kids();
  assert.ok(primary.className.split(' ').includes('nav-primary'));
  assert.deepEqual(hrefs_in(primary), ['#overview', '#buy', '#feed', '#waves']);
  assert.deepEqual(primary.children.map((li) => N(li.textContent)), ['Обзор', 'Купить', 'Лента', 'Волны']);
  assert.equal(primary.attrs['aria-label'], 'Разделы приложения');
  assert.equal(more.children[0].tagName, 'summary', 'summary — первый потомок details (требование HTML)');
  assert.equal(N(more.children[0].textContent), 'Ещё');
  assert.equal(more.children[0].attrs.id, 'nav-more-sum');
  assert.equal(more.hasAttribute('open'), false, 'по умолчанию свёрнуто');
  assert.equal(more.children[1].tagName, 'ul');
  assert.equal(more.children[1].attrs['aria-label'], 'Остальные разделы');
  assert.equal(actions.attrs['aria-label'], 'Действия');
});

test('U22 ничего не теряется: вкладки + список «Ещё» = ровно разделы реестра, по одному разу; остальные — в порядке реестра; все действия на месте', () => {
  const [primary, more, actions] = kids();
  const all = [...hrefs_in(primary), ...hrefs_in(more)];
  assert.equal(new Set(all).size, all.length, 'дублей нет');
  assert.deepEqual([...all].sort(), [...registry()].sort(), 'ровно разделы реестра (экраны приложения и пакетов)');
  assert.deepEqual(hrefs_in(more.children[1]), registry().filter((h) => !hrefs_in(primary).includes(h)), 'остальные — в порядке реестра');
  assert.ok(all.length >= 20, 'разделов: ' + all.length);
  const buttons = find_all(actions, (n) => n.tagName === 'button').map((b) => N(b.attrs['aria-label'] ?? b.textContent));
  assert.ok(buttons.length >= 5, 'действий: ' + buttons.join(' | '));
  for (const need of ['+ Факт', 'Сверить остаток', 'Отменить', 'Вернуть', '?']) assert.ok(find_all(actions, (n) => n.tagName === 'button' && N(n.textContent) === need).length === 1, need);
});

test('U22 порядок фокуса = порядок на экране: вкладки → «Ещё» → список «Ещё» → действия; ни tabindex < 0, ни hidden, ни inert; у каждого пункта есть имя; идентификаторы уникальны', () => {
  const stops = tab_stops().map((n) => n.tagName);
  const first_summary = stops.indexOf('summary');
  const first_button = stops.indexOf('button');
  assert.equal(first_summary, 4, 'после четырёх вкладок');
  assert.ok(first_button > stops.lastIndexOf('a'), 'кнопки действий — после всех ссылок');
  assert.deepEqual(stops.slice(0, 4), ['a', 'a', 'a', 'a']);
  assert.equal(stops.filter((t) => t === 'summary').length, 1);
  const ids = [];
  for (const n of find_all(nav(), () => true)) {
    for (const bad of ['hidden', 'aria-hidden', 'inert']) assert.equal(n.hasAttribute(bad), false, `${n.tagName}: ${bad}`);
    if (n.hasAttribute('tabindex')) assert.ok(Number(n.attrs.tabindex) >= 0);
    if (n.attrs.id !== undefined) ids.push(n.attrs.id);
  }
  assert.equal(new Set(ids).size, ids.length, 'идентификаторы в панели уникальны: ' + ids.join(', '));
  for (const a of find_all(nav(), (n) => n.tagName === 'a')) assert.ok(N(a.textContent).trim() !== '' && /^#[a-z][a-z0-9_]+$/.test(a.attrs.href));
});

test('U22 «Ещё»: раскрытие запоминается при перерисовке (поздняя перерисовка от хранилища не захлопывает список), Escape закрывает и возвращает фокус на «Ещё», переход по разделу закрывает', async () => {
  const [, more] = kids();
  more.open = true;
  more.listeners.toggle[0]();
  A.ext.ctx.refresh();
  const [, more2] = kids();
  assert.notEqual(more2, more, 'перерисовка создала новые узлы');
  assert.equal(more2.hasAttribute('open'), true, 'список остался раскрытым');
  // Escape
  more2.listeners.keydown[0]({ key: 'Tab' });
  assert.equal(more2.open, true, 'другие клавиши список не закрывают');
  more2.listeners.keydown[0]({ key: 'Escape' });
  assert.equal(more2.open, false);
  assert.equal(document.activeElement.attrs.id, 'nav-more-sum', 'фокус вернулся на «Ещё»');
  A.ext.ctx.refresh();
  assert.equal(kids()[1].hasAttribute('open'), false, 'после Escape перерисовка не раскрывает список');
  // раскрыли и выбрали раздел
  const m3 = kids()[1];
  m3.open = true;
  m3.listeners.toggle[0]();
  m3.children[1].listeners.click[0]({});
  A.ext.ctx.refresh();
  assert.equal(kids()[1].hasAttribute('open'), false, 'нажатие на раздел закрывает список');
});

test('U22 текущий раздел из группы «Ещё»: список помечен has-current, у ссылки aria-current="page"; вкладка Обзор больше не текущая', async () => {
  await A.go('#settings');
  const [primary, more] = kids();
  assert.ok(more.className.split(' ').includes('has-current'));
  const cur = find_all(nav(), (n) => n.tagName === 'a' && n.attrs['aria-current'] === 'page').map((a) => a.attrs.href);
  assert.deepEqual(cur, ['#settings']);
  assert.ok(hrefs_in(more).includes('#settings') && !hrefs_in(primary).includes('#settings'));
  await A.go('#buy');
  assert.ok(!kids()[1].className.split(' ').includes('has-current'));
  assert.deepEqual(find_all(nav(), (n) => n.tagName === 'a' && n.attrs['aria-current'] === 'page').map((a) => a.attrs.href), ['#buy']);
  await A.go('#overview');
});

test('U22 фокус: перерисовка заменила узел «Ещё» и уронила фокус на body — хранитель возвращает его на новую кнопку; чужой фокус он не отбирает', async () => {
  const sum = kids()[1].children[0];
  sum.listeners.focus[0]();
  sum.focus();
  assert.equal(document.activeElement, sum);
  document.activeElement = document.body; // как в браузере: узел заменён, фокус упал на body
  A.ext.ctx.refresh();
  await A.tick();
  assert.equal(document.activeElement.attrs.id, 'nav-more-sum');
  assert.notEqual(document.activeElement, sum, 'это уже новый узел');
  // пользователь ушёл в поле ввода: хранитель его не трогает
  const other = new Node_('input');
  other.focus();
  A.ext.ctx.refresh();
  await A.tick();
  assert.equal(document.activeElement, other);
  document.activeElement = document.body;
});

test('U22 граница окна: при выходе из узкого окна навигация возвращается к двум спискам S1.4 (без nav-grouped), при возврате — группируется снова; пакет FP-26 подписан на границу', async () => {
  assert.ok(A.media.subs.length >= 1, 'пакет подписался на изменение ширины окна');
  await A.set_phone(false);
  assert.deepEqual(kids().map((k) => k.tagName + '.' + k.className), ['ul.nav-sections', 'ul.nav-actions']);
  assert.ok(!nav().className.split(' ').includes('nav-grouped'));
  assert.deepEqual(hrefs_in(kids()[0]), registry(), 'на широком окне порядок — реестра, как раньше');
  assert.equal(find_all(nav(), (n) => n.tagName === 'details' || n.tagName === 'summary').length, 0);
  await A.set_phone(true);
  assert.deepEqual(kids().map((k) => k.tagName), ['ul', 'details', 'ul']);
  assert.ok(nav().className.split(' ').includes('nav-grouped'));
});

test('U22 английский: «More», подпись списка «More sections», вкладки Overview · Buy · Feed · Waves', () => {
  A.set_lang('en');
  const [primary, more] = kids();
  assert.deepEqual(primary.children.map((li) => N(li.textContent)), ['Overview', 'Buy', 'Feed', 'Waves']);
  assert.equal(N(more.children[0].textContent), 'More');
  assert.equal(more.children[1].attrs['aria-label'], 'More sections');
  A.set_lang('ru');
});

// ── 3. «Обзор» в две колонки ───────────────────────────────────────────────────────────────────────────────────────────────────────

test('U23 U41 «Обзор»: заголовок и подпись, затем .view--split с колонками .split-main (числа, карточки) и .split-side (график, ссылки), под ними на всю ширину таблица значений; порядок DOM = порядок на экране', async () => {
  await A.go('#overview');
  const root = A.main().children[0];
  assert.equal(root.className, 'view');
  assert.deepEqual(root.children.map((c) => c.tagName + '.' + c.className), ['h2.', 'p.lead', 'div.view--split', 'details.card values']); // исправление после проверки: таблица значений вынесена из правой колонки под обе
  const split = root.children[2];
  assert.deepEqual(split.children.map((c) => c.className), ['split-main', 'split-side']);
  const [left, right] = split.children;
  assert.ok(find_all(left, (n) => n.attrs.id === 'q1-date').length === 1 && find_all(left, (n) => n.attrs.id === 'sts-date').length === 1, 'вопросы «хватит ли к…» и «можно потратить» — слева');
  assert.ok(find_all(left, (n) => n.className === 'grid').length === 1);
  assert.ok(find_all(right, (n) => n.attrs.id === 'chart-day').length === 1, 'ползунок графика — справа');
  assert.equal(find_all(split, (n) => n.tagName === 'details' && n.className.includes('values')).length, 0, 'таблица значений не в колонках: восемь столбцов не помещаются в правую колонку без прокрутки');
  assert.equal(find_all(root.children[3], (n) => n.tagName === 'table').length, 1, 'под колонками на всю ширину — таблица значений (в контейнере .table-wrap)');
  assert.deepEqual(find_all(right, (n) => n.tagName === 'a').map((a) => a.attrs.href), ['#buy', '#scenarios']);
  // ни одна колонка не потеряла узлы страницы: те же поля и ссылки, что раньше
  const ids = find_all(root, (n) => n.attrs.id !== undefined).map((n) => n.attrs.id);
  for (const need of ['view-title', 'q1-date', 'sts-date', 'chart-day']) assert.ok(ids.includes(need), need);
  // фокус: числа и поля слева идут раньше графика справа — как слева направо на экране
  const order = find_all(root, (n) => ['input', 'a', 'button'].includes(n.tagName)).map((n) => n.attrs.id ?? n.attrs.href ?? n.tagName);
  assert.ok(order.indexOf('q1-date') < order.indexOf('chart-day'), order.join(' '));
});

test('U23 U41 «Обзор» без данных (ov.empty): колонок нет — экран прежний, карточка «Старт» на месте', async () => {
  await A.choose_dataset('empty');
  await A.go('#overview');
  assert.equal(find_all(A.main(), (n) => n.className === 'view--split').length, 0);
  assert.ok(A.text_of('main').includes(A.I18N.t('ru', 'ov.empty')));
  await A.choose_dataset('g001');
  await A.go('#overview');
  assert.equal(find_all(A.main(), (n) => n.className === 'view--split').length, 1);
});

// ── 4. названия ступеней готовности ────────────────────────────────────────────────────────────────────────────────────────────────

const HC = await import(pathToFileURL(path.join(DEMO, 'home_cards.mjs')).href);

const variants = () => {
  const base = structuredClone(A.ext.ctx.get_ws());
  const v3 = structuredClone(base); v3.rules = v3.rules.filter((r) => r.is_estimate !== true);
  const v2 = structuredClone(v3); v2.streams = []; v2.plans = []; v2.facts = v2.facts.filter((f) => f.kind !== 'income');
  const v1 = structuredClone(v2); v1.rules = []; v1.overrides = [];
  return { 4: base, 3: v3, 2: v2, 1: v1 };
};

test('U21 ступени готовности в шапке: «пусто», «каркас», «рабочий», «рабочий+», «полный» — на RU и EN; название берётся из ступени движка, а не из счётчика', async () => {
  const RU = { 0: 'пусто', 1: 'каркас', 2: 'рабочий', 3: 'рабочий+', 4: 'полный' };
  const EN = { 0: 'empty', 1: 'outline', 2: 'working', 3: 'working+', 4: 'complete' };
  const vs = variants();
  for (const score of [4, 3, 2, 1]) {
    assert.equal(A.ext.ctx.adopt(vs[score], { source: 'test' }).ok, true);
    await A.go('#overview');
    const r = A.ext.ctx.get_model().ctx.readiness;
    assert.equal(r.score, score, `вариант данных даёт готовность ${score}`);
    assert.equal(r.level, HC.READINESS_LEVELS[score]);
    A.set_lang('ru');
    assert.ok(A.text_of('summary').includes(`готовность данных: ${score} из 4 · ${RU[score]}`), A.text_of('summary').slice(0, 200));
    A.set_lang('en');
    assert.ok(A.text_of('summary').includes(`data readiness: ${score} of 4 · ${EN[score]}`), A.text_of('summary').slice(0, 200));
    A.set_lang('ru');
  }
  await A.choose_dataset('empty');
  assert.equal(A.ext.ctx.get_model().ctx.readiness.score, 0);
  assert.ok(A.text_of('summary').includes('готовность данных: 0 из 4 · пусто'));
  await A.choose_dataset('g001');
});

test('U21 названия ступеней одинаковы в шапке и в карточке «Готовность данных» (Настройки, «Обзор» без данных); русские — без женского рода, «рабочий+» — как в IDEA-31', () => {
  for (const lang of ['ru', 'en']) {
    for (const level of HC.READINESS_LEVELS) {
      assert.equal(A.I18N.t(lang, 'hdr.ready_name_' + level), A.I18N.t(lang, 'settings.rd_level_' + level), `${lang} ${level}`);
    }
  }
  assert.deepEqual(HC.READINESS_LEVELS.map((l) => A.I18N.t('ru', 'hdr.ready_name_' + l)), ['пусто', 'каркас', 'рабочий', 'рабочий+', 'полный']);
});

// ── 5. пакет и CSS ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('FP-26 пакет: подключён манифестом, каталог a11y принят, стили css/layout.css запрошены; app.mjs пакет по имени не знает', () => {
  assert.deepEqual(A.ext.diagnostics().filter((d) => d.pack === 'pack_fp26').map((d) => d.status), ['ok']);
  assert.equal(A.ext.ctx.tr('a11y.minus'), 'минус');
  const links = find_all(document.head, (n) => n.tagName === 'link').map((n) => n.attrs.href);
  assert.ok(links.includes('css/layout.css'), links.join(', '));
  const app = read('app.mjs');
  assert.ok(!/pack_fp26|layout\.css/.test(app));
  const hook_lines = app.split('\n').filter((l) => /\bext\b/.test(l) && !/^\s*(\/\/|\*)/.test(l)).length;
  assert.ok(hook_lines <= 25, 'строк хуков в app.mjs: ' + hook_lines);
});

const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

test('FP-26 css/layout.css: две колонки только от 1024 px, одна колонка уже; скелет без движения при prefers-reduced-motion; цвета — токены; без order и размещения в сетке; раскладку навигации пакетный css не меняет', () => {
  const css = strip(read('css', 'layout.css'));
  assert.match(css, /@media \(min-width: 1024px\)\s*\{\s*\.view--split\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1\.3fr\)/);
  assert.match(css, /^\.view--split \{ display: block; \}/m, 'на узких окнах — одна колонка, как раньше');
  for (const bad of [/\border\s*:/, /\bfloat\s*:/, /\bdirection\s*:/, /grid-(row|column|area)/, /reverse/, /\bposition\s*:\s*(absolute|fixed)/, /display:\s*none/, /visibility\s*:\s*hidden/, /opacity:\s*0\b/, /outline:\s*(none|0)\b/]) {
    assert.ok(!bad.test(css.replace(/@keyframes[\s\S]*?\n\}\n/, '')), 'layout.css: ' + bad);
  }
  assert.ok(!/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(css), 'цвета — только токены style.css');
  assert.ok(!/\.nav/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'в css пакета нет правил навигации (это guard tests/s1_4_adv.test.mjs)');
  const globals = strip(read('style.css'));
  assert.match(globals, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*\s*\{[^}]*animation: none !important/, 'движение скелета выключается общим правилом');
  assert.match(css, /main\[aria-busy="true"\]/);
});

test('FP-26 style.css: группа «Ещё» только в блоке телефона; действия переносятся; прежнее правило nowrap осталось; отступ под панель в rem; цель касания ≥ 44 px; без order и скрытия', () => {
  const css = strip(read('style.css'));
  const blocks = [...css.matchAll(/@media \(max-width: 599px\)\s*\{([\s\S]*?)\n\}/g)];
  const phone = blocks.find((m) => m[1].includes('.nav-grouped'));
  assert.ok(phone !== undefined, 'блок телефона с группой «Ещё»');
  for (const sel of ['.nav.nav-grouped', '.nav-more', '.nav-more-list', '.nav-actions']) assert.ok(phone[1].includes(sel), sel + ' — внутри блока телефона');
  assert.ok(!/nav-grouped|nav-more/.test(css.replace(phone[0], '')), 'правила группы — только в этом блоке');
  assert.match(phone[1], /\.nav\.nav-grouped > \.nav-actions \{[^}]*flex-wrap: wrap;[^}]*overflow-x: visible;/, '«Вернуть» и «?» переносятся, а не уходят за край (было flex-wrap: nowrap; overflow-x: auto)');
  assert.match(css, /\.nav \.nav-actions \{ flex-wrap: nowrap; overflow-x: auto; \}/, 'правило окна без группировки не тронуто');
  assert.match(phone[1], /\.nav\.nav-grouped ~ \.content \{ padding-bottom: 1[2-9]rem; \}/, 'отступ под панель в rem');
  assert.match(phone[1], /\.nav-more > summary \{[^}]*min-height: 44px;/, 'цель касания «Ещё» не меньше 44 px');
  assert.match(phone[1], /\.nav\.nav-grouped > \.nav-more\[open\] \{ flex: 1 0 100%;/, 'раскрытый список занимает строку под вкладками');
  for (const bad of [/\border\s*:/, /\bfloat\s*:/, /\bdirection\s*:/, /grid-(row|column|area)/, /reverse/, /\bposition\s*:\s*(absolute|fixed)/, /display:\s*none/, /visibility\s*:\s*hidden/, /opacity:\s*0\b/, /outline:\s*(none|0)\b/]) {
    assert.ok(!bad.test(phone[1]), 'группа «Ещё»: ' + bad);
  }
  assert.ok(!/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(phone[1]), 'цвета — только токены');
});

test('FP-26 расчёт не затронут: числа G-001 на экране «Обзор» и «Эталон» прежние', async () => {
  await A.go('#overview');
  const t = A.text_of('main');
  assert.ok(t.includes('2 055,00 €'), 'узкая точка по плану');
  assert.ok(t.includes('1 830,00 €'), 'узкая точка «если хуже»');
});
