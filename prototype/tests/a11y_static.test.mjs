// a11y_static.test.mjs — FP-26, REQ-167 (клавиатура, масштаб 200 %, скринридер полным предложением): что можно проверить без браузера.
//   1) фраза для скринридера у ползунка графика: «остаток 31 октября 2 055,00 евро» на G-001 (RU) и её английский вид; слова вместо знаков (валюта, «минус», месяц) — чистые функции
//      demo/speech.mjs, плюс сквозная проверка настоящего app.mjs на заглушке DOM;
//   2) статический разбор CSS на 200 %: шрифты в rem/em/% (px только у подписей SVG-графиков), нет фиксированных высот у текстовых блоков (высота в px/vh — только у
//      блоков, которые прокручиваются сами), нет `maximum-scale`/`user-scalable=no` в метаданных страниц, таблицы лежат в прокручиваемых контейнерах (`.table-wrap` или
//      карточка), текст переносится (`overflow-wrap`), а не уходит за край;
//   3) обход всех экранов на заглушке DOM: каждая таблица стоит в таком контейнере.
// Не проверено и не заявляется: настоящий масштаб 200 % в браузере, обход клавиатурой, чтение скринридером (работа людей, FP-40). Соответствие WCAG 2.2 AA как факт не заявляется.
// Расчёт по введённым данным и правилам, не консультация. Браузер, сеть и серверы не запускаются.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { boot_app, find_all, ancestors_of, N, DEMO } from './dom_boot.mjs';

const read = (...p) => fs.readFileSync(path.join(DEMO, ...p), 'utf8');
const CSS_FILES = [['style.css', read('style.css')], ...fs.readdirSync(path.join(DEMO, 'css')).filter((f) => f.endsWith('.css')).sort().map((f) => ['css/' + f, read('css', f)])];

// ── разбор CSS (правила, вложенные @media, объявления; @keyframes и прочие @-блоки пропускаются) ────────────────────────────

const strip_comments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const norm = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase();

function parse_decls(body) {
  const out = new Map();
  for (const part of body.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const prop = norm(part.slice(0, i));
    if (prop !== '') out.set(prop, part.slice(i + 1).trim().replace(/\s+/g, ' '));
  }
  return out;
}

function parse_css(css, file = '', media = null, out = []) {
  const text = strip_comments(css);
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    const head = text.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth > 0) { if (text[j] === '{') depth += 1; else if (text[j] === '}') depth -= 1; j += 1; }
    const body = text.slice(open + 1, j - 1);
    if (/^@media/i.test(head)) parse_css(body, file, norm(head.replace(/^@media/i, '')), out);
    else if (!head.startsWith('@')) out.push({ file, media, selectors: head.split(',').map(norm), decls: parse_decls(body) });
    i = j;
  }
  return out;
}

const ALL = CSS_FILES.flatMap(([file, css]) => parse_css(css, file));
const label = (r, prop) => `${r.file}${r.media === null ? '' : ' @' + r.media} ${r.selectors.join(', ')} { ${prop}: ${r.decls.get(prop)} }`;
const ABS_UNIT = /(?:^|[\s(,/])-?[\d.]+(?:px|pt|pc|cm|mm|in|vh|vw|vmin|vmax)\b/;

// ── 1. фраза для скринридера ─────────────────────────────────────────────────────────────────────────────────────────

const SP = await import(pathToFileURL(path.join(DEMO, 'speech.mjs')).href);
const NF = await import(pathToFileURL(path.join(DEMO, 'number_format.mjs')).href);
const { parse_date } = await import(pathToFileURL(path.join(DEMO, '..', 'engine', 'index.mjs')).href);

test('REQ-167 speech.spoken_money: сумма словами — название валюты в нужной форме вместо знака, «минус» вместо «−», цифры и разделители как на экране', () => {
  const ru = (minor, cur, nf) => { const f = NF.make_nf_fmt('ru', cur, '2026-10-04', nf); return N(SP.spoken_money('ru', minor, cur, f.money(minor))); };
  const en = (minor, cur, nf) => { const f = NF.make_nf_fmt('en', cur, '2026-10-04', nf); return N(SP.spoken_money('en', minor, cur, f.money(minor))); };
  assert.equal(ru(205500, 'EUR'), '2 055,00 евро', 'эталон REQ-167 (G-001, 31 октября)');
  assert.equal(en(205500, 'EUR'), '2,055.00 euros');
  assert.equal(ru(-120000, 'EUR'), 'минус 1 200,00 евро', 'знак «−» заменён словом');
  assert.equal(en(-120000, 'EUR'), 'minus 1,200.00 euros');
  assert.equal(ru(0, 'EUR'), '0,00 евро', 'ноль без «минус»');
  assert.equal(ru(-0, 'EUR'), '0,00 евро');
  // русское склонение: сумма с десятичным знаком («21,00», «2,50») — родительный падеж единственного числа при любой целой части и при нулевой дробной
  // (исправление после проверки FP-26: прежний тест закреплял «21,00 доллар», «5,00 долларов»)
  const usd = (m) => ru(m, 'USD');
  assert.deepEqual([100, 200, 400, 500, 1100, 1200, 2100, 2200, 11100, 250].map(usd),
    ['1,00 доллара', '2,00 доллара', '4,00 доллара', '5,00 доллара', '11,00 доллара', '12,00 доллара', '21,00 доллара', '22,00 доллара', '111,00 доллара', '2,50 доллара']);
  assert.deepEqual([100, 300, 500, 250].map((m) => ru(m, 'RUB')), ['1,00 рубля', '3,00 рубля', '5,00 рубля', '2,50 рубля']);
  assert.deepEqual([100, 200, 500, 250].map((m) => ru(m, 'GBP')), ['1,00 фунта стерлингов', '2,00 фунта стерлингов', '5,00 фунта стерлингов', '2,50 фунта стерлингов']);
  // сумма без десятичного знака (формат без копеек, `money0`) склоняется по целому числу: 1, 2…4, 5 и больше, 11…14
  const ru0 = (minor, cur) => N(SP.spoken_money('ru', minor, cur, NF.make_nf_fmt('ru', cur, '2026-10-04', null).money0(minor)));
  assert.deepEqual([100, 200, 500, 1100, 2100, 2200].map((m) => ru0(m, 'USD')), ['1 доллар', '2 доллара', '5 долларов', '11 долларов', '21 доллар', '22 доллара']);
  assert.deepEqual([100, 300, 500].map((m) => ru0(m, 'RUB')), ['1 рубль', '3 рубля', '5 рублей']);
  // эталон REQ-167 (евро не склоняется) от выбора формы не зависит
  assert.equal(ru(205500, 'EUR'), '2 055,00 евро');
  // английский: единственное число только у ровно одной единицы
  assert.deepEqual([100, 200, 250].map((m) => en(m, 'USD')), ['1.00 dollar', '2.00 dollars', '2.50 dollars']);
  // формат чисел пользователя (REQ-112) сохраняется: цифры берутся из строки форматтера
  assert.equal(ru(123450, 'EUR', { decimal: ',', thousands: '.' }), '1.234,50 евро');
  assert.equal(ru(123450, 'EUR', { decimal: '.', thousands: ',' }), '1,234.50 евро');
  assert.equal(ru(123450, 'EUR', { decimal: ',', thousands: '' }), '1234,50 евро');
  // валюта вне каталога читается с кодом ISO 4217, без выдуманных названий
  assert.equal(ru(100000, 'CHF'), '1 000,00 CHF');
  assert.equal(en(100000, 'CHF'), '1,000.00 CHF');
  assert.equal(ru(-5000, 'JPY'), 'минус 5 000 JPY', 'валюта без дробной части (exp = 0)');
  // неожиданная строка форматтера не ломает фразу: читается как есть
  assert.equal(SP.spoken_money('ru', 100, 'EUR', 'около сотни'), 'около сотни евро');
});

test('REQ-167 speech.spoken_date: дата с названием месяца; год — только если он не совпадает с годом расчёта; числовой стиль даты на слух не передаётся', () => {
  assert.equal(SP.spoken_date('ru', '2026-10-31', '2026-10-04'), '31 октября');
  assert.equal(SP.spoken_date('en', '2026-10-31', '2026-10-04'), 'October 31');
  assert.equal(SP.spoken_date('ru', '2027-01-05', '2026-10-04'), '5 января 2027 года');
  assert.equal(SP.spoken_date('en', '2027-01-05', '2026-10-04'), 'January 5, 2027');
  assert.equal(SP.spoken_date('ru', '2026-10-31'), '31 октября', 'без даты расчёта год не добавляется');
  const nf_date = NF.make_nf_fmt('ru', 'EUR', '2026-10-04', { date: 'dmy' }).date('2026-10-31');
  assert.equal(nf_date, '31.10.2026', 'на экране числовой стиль остаётся как выбран');
  assert.equal(SP.spoken_date('ru', '2026-10-31', '2026-10-04'), '31 октября', 'а для скринридера — слова');
});

const CAT = (await import(pathToFileURL(path.join(DEMO, 'i18n', 'a11y.mjs')).href)).default;

test('REQ-167 каталог a11y: паритет RU/EN; названия валют заданы по четырём формам; в строках нет цифр и знаков валют', () => {
  assert.deepEqual(Object.keys(CAT.ru).sort(), Object.keys(CAT.en).sort());
  for (const cur of ['eur', 'usd', 'gbp', 'rub']) for (const form of ['one', 'few', 'many', 'frac']) {
    const k = `a11y.cur_${cur}_${form}`;
    assert.ok(CAT.ru[k] !== undefined && CAT.en[k] !== undefined, k);
    assert.match(CAT.ru[k], /^[а-яё ]+$/i, k);
    assert.match(CAT.en[k], /^[a-z ]+$/i, k);
  }
  for (const v of [...Object.values(CAT.ru), ...Object.values(CAT.en)]) assert.ok(!/[\d€$£₽−]/.test(v), v);
});

const A = await boot_app({ raf: true });

test('REQ-167 aria-valuetext у ползунка графика на G-001: 31 октября — «остаток 31 октября 2 055,00 евро» (RU) и «balance on October 31: 2,055.00 euros» (EN)', () => {
  const diag = A.ext.diagnostics().filter((d) => d.pack === 'pack_fp26');
  assert.deepEqual(diag.map((d) => d.status), ['ok'], 'пакет FP-26 подключён манифестом');
  const idx = parse_date('2026-10-31') - parse_date('2026-10-04');
  assert.equal(idx, 27);
  const day = () => A.by_id('chart-day');
  assert.ok(day() !== undefined, 'ползунок дня на «Обзоре»');
  // подпись у поля — для скринридера; значение читается полным предложением
  const label = find_all(A.main(), (n) => n.tagName === 'label' && n.attrs.for === 'chart-day')[0];
  assert.ok(label !== undefined && label.textContent === 'День графика');
  day().value = String(idx);
  day().listeners.input[0]();
  const ru = N(day().attrs['aria-valuetext']);
  assert.equal(ru, 'остаток 31 октября 2 055,00 евро');
  assert.ok(!/[€:−]/.test(ru), 'ни знака валюты, ни двоеточия, ни знака минус');
  A.set_lang('en');
  assert.ok(day() !== undefined);
  day().value = String(idx);
  day().listeners.input[0]();
  const en = N(day().attrs['aria-valuetext']);
  assert.equal(en, 'balance on October 31: 2,055.00 euros');
  assert.ok(!/[€$]/.test(en));
  A.set_lang('ru');
});

test('REQ-167 aria-valuetext 31 октября на G-001 в режиме plan и в режиме «если хуже» (по умолчанию D-04): режим выбран явно, фраза одна и та же — 2 055,00 евро — на RU и EN', () => {
  const idx = parse_date('2026-10-31') - parse_date('2026-10-04');
  const initial = A.ext.ctx.mode();
  const pick = (mode) => {
    const seg = find_all(A.controls(), (n) => n.tagName === 'div' && n.className === 'seg')[0];
    A.click(seg.children[mode === 'plan' ? 0 : 1]);
    assert.equal(A.ext.ctx.mode(), mode, 'режим выбран на странице');
  };
  const say = (lang) => {
    A.set_lang(lang);
    const day = A.by_id('chart-day');
    day.value = String(idx);
    day.listeners.input[0]();
    return N(A.by_id('chart-day').attrs['aria-valuetext']);
  };
  try {
    for (const mode of ['plan', 'worse']) {
      pick(mode);
      assert.equal(say('ru'), 'остаток 31 октября 2 055,00 евро', 'RU, режим ' + mode);
      assert.equal(say('en'), 'balance on October 31: 2,055.00 euros', 'EN, режим ' + mode);
    }
  } finally {
    A.set_lang('ru');
    pick(initial);
  }
});

test('REQ-167 aria-valuetext в другие дни и режимы: сумма на конец дня по режиму страницы, минус — словом; при смене режима фраза пересчитывается', async () => {
  const day = () => A.by_id('chart-day');
  const read = (i) => { day().value = String(i); day().listeners.input[0](); return N(day().attrs['aria-valuetext']); };
  const first = read(0);
  assert.match(first, /^остаток 4 октября \d[\d ]*,\d\d евро$/, first);
  const last = read(57);
  assert.match(last, /^остаток 30 ноября \d[\d ]*,\d\d евро$/, last);
  // набор «не хватает»: на графике есть отрицательные дни → «минус»
  await A.choose_dataset('gap');
  await A.go('#overview');
  const texts = [];
  for (let i = 0; i < 58; i += 1) texts.push(read(i));
  assert.ok(texts.some((t) => t.includes('минус ')), 'на наборе «не хватает» есть отрицательный остаток: ' + texts.slice(0, 3).join(' | '));
  for (const t of texts) assert.ok(!/[−€]/.test(t), t);
  await A.choose_dataset('g001');
  await A.go('#overview');
});

// ── 2. статический разбор CSS на 200 % ───────────────────────────────────────────────────────────────────────────────────

/** px у подписей SVG-графиков: единицы системы координат рисунка, который перерисовывается по ширине контейнера; те же значения читаются в таблице значений (в rem). */
const SVG_TEXT_PX = Object.freeze({
  'style.css': ['.chart .axis', '.buffer-label', '.today-label', '.wave-label', '.narrow-label'],
  'css/showcase.css': ['.lad-label', '.lad-num'],
});

const font_size_of = (r) => {
  const fs_ = r.decls.get('font-size');
  if (fs_ !== undefined) return fs_;
  const sh = r.decls.get('font');
  if (sh === undefined || /^(inherit|initial|unset)$/.test(sh)) return undefined;
  return sh.split(/\s+/).find((t) => /^[\d.]/.test(t))?.split('/')[0];
};

test('REQ-167 разбор CSS видит правила, @media и размеры шрифтов; проверки сами себя проверяют на заведомо плохом CSS', () => {
  assert.ok(ALL.length > 250, `правил: ${ALL.length}`);
  assert.ok(ALL.some((r) => r.file === 'style.css' && r.media !== null && r.selectors.includes('.nav')), '@media разворачивается');
  assert.ok(ALL.some((r) => r.file === 'css/layout.css'), 'css/layout.css разобран');
  const bad = parse_css('p { font-size: 14px; } q { font: 12px/1.4 serif; } r { height: 200px; } s { height: 200px; overflow: auto; } t { height: calc(100vh - 3px); }');
  assert.deepEqual(bad.map((r) => font_size_of(r)), ['14px', '12px', undefined, undefined, undefined]);
  assert.ok(ABS_UNIT.test('200px') && ABS_UNIT.test('calc(100vh - 24px)') && !ABS_UNIT.test('24rem') && !ABS_UNIT.test('2.8em') && !ABS_UNIT.test('auto'));
});

test('REQ-167 200 %: все размеры шрифта в rem, em или % (px — только у подписей SVG-графиков из явного перечня); базовый шрифт страницы — 1rem', () => {
  const px_rules = [];
  for (const r of ALL) {
    const size = font_size_of(r);
    if (size === undefined) continue;
    assert.ok(!/(?:pt|pc|cm|mm|in)$/.test(size), label(r, r.decls.has('font-size') ? 'font-size' : 'font'));
    if (/px$/.test(size)) px_rules.push({ r, size });
  }
  const allowed = new Set(Object.entries(SVG_TEXT_PX).flatMap(([file, sels]) => sels.map((s) => `${file}|${s}`)));
  const found = new Set();
  const bad = [];
  for (const { r, size } of px_rules) {
    for (const sel of r.selectors) {
      const key = `${r.file}|${sel}`;
      if (allowed.has(key)) found.add(key);
      else bad.push(`${r.file} ${sel} { font-size: ${size} }`);
    }
  }
  assert.deepEqual(bad, [], 'размер шрифта в px вне подписей SVG — при 200 % текста (настройка размера шрифта в браузере) он не вырастет');
  assert.deepEqual([...allowed].filter((k) => !found.has(k)), [], 'в перечне нет «лишних» записей: каждая подпись SVG действительно в px');
  const body = ALL.find((r) => r.file === 'style.css' && r.media === null && r.selectors.includes('body'));
  assert.match(body.decls.get('font'), /^1rem\//, 'body { font: 1rem/1.5 … }');
  const phone_body = ALL.find((r) => r.file === 'style.css' && r.media !== null && /max-width:\s*599px/.test(r.media) && r.selectors.includes('body'));
  assert.match(phone_body.decls.get('font-size'), /rem$/, 'на телефоне — rem, не px');
  // межстрочный интервал — безразмерный или относительный
  for (const r of ALL) { const lh = r.decls.get('line-height'); if (lh !== undefined) assert.ok(!/px|pt|cm|mm|in$/.test(lh), label(r, 'line-height')); }
});

test('REQ-167 200 %: у текстовых блоков нет фиксированной высоты — height/max-height в px, vh и т. п. допустимы только у блоков, которые прокручиваются сами, и у перечисленных не-текстовых узлов', () => {
  // не-текстовые узлы и особые случаи (причина в значении)
  const EXEMPT = new Map([
    ['style.css|.sr-only', 'скрытый для глаз текст: 1×1 px по определению приёма'],
    ['css/probe.css|.probe-page .probe-frame', 'вложенное окно iframe страницы замера coldstart.html, не текстовый блок'],
    ['style.css|.nav', 'панель от 1024 px: высота ограничена окном, а список разделов внутри неё прокручивается (.nav .nav-sections, overflow-y: auto)'],
  ]);
  const bad = [];
  const used = new Set();
  for (const r of ALL) {
    for (const prop of ['height', 'max-height']) {
      const v = r.decls.get(prop);
      if (v === undefined || !ABS_UNIT.test(v)) continue;
      const scrolls = ['overflow', 'overflow-y'].some((p) => /^(auto|scroll)$/.test(r.decls.get(p) ?? ''));
      const sel_key = r.selectors.map((s) => `${r.file}|${s}`).find((k) => EXEMPT.has(k));
      if (sel_key !== undefined) used.add(sel_key);
      else if (!scrolls) bad.push(label(r, prop));
    }
  }
  assert.deepEqual(bad, [], 'фиксированная высота обрежет текст при увеличении шрифта');
  assert.deepEqual([...EXEMPT.keys()].filter((k) => !used.has(k)), [], 'перечень исключений без «лишних» записей');
  // блоки со своей прокруткой найдены (диалог, предпросмотры): разбор не пуст
  const own = ALL.filter((r) => ['height', 'max-height'].some((p) => ABS_UNIT.test(r.decls.get(p) ?? '')) && ['overflow', 'overflow-y'].some((p) => /^(auto|scroll)$/.test(r.decls.get(p) ?? '')));
  assert.ok(own.length >= 2, `блоков с ограниченной высотой и прокруткой: ${own.length}`);
  assert.ok(own.some((r) => r.selectors.includes('dialog')), 'диалог прокручивается сам');
  assert.ok(own.some((r) => r.selectors.includes('.nav.nav-grouped .nav-more-list')), 'список «Ещё» на телефоне прокручивается сам');
});

test('REQ-167 200 %: обрезка и переполнение — перечни известных мест (новые не появляются молча); body переносит длинные слова; страница не скрывает горизонтальную прокрутку', () => {
  const hidden = new Set();
  const ellipsis = new Set();
  for (const r of ALL) {
    for (const sel of r.selectors) {
      for (const p of ['overflow', 'overflow-x']) if (/^(hidden|clip)$/.test(r.decls.get(p) ?? '')) hidden.add(`${r.file}|${sel}|${p}`);
      if (/ellipsis/.test(r.decls.get('text-overflow') ?? '')) ellipsis.add(`${r.file}|${sel}`);
    }
  }
  assert.deepEqual([...hidden].sort(), [
    // .chart-wrap — рисунок графика (текста нет: числа продублированы таблицей значений); .seg — скругление кнопок переключателя; .sr-only — скрытый текст;
    // .nav .nav-sections — только по оси X на ≥ 1024 px (вертикальная прокрутка включена); подписи там переносятся (white-space: normal), а колонка задана в rem —
    // обрезать нечего и при крупном шрифте; сочетание «nowrap + скрытое по X» ловит следующий тест
    'css/import.css|.import-wizard .import-sample td|overflow',
    'style.css|.chart-wrap|overflow',
    'style.css|.nav .nav-sections|overflow-x',
    'style.css|.seg|overflow',
    'style.css|.sr-only|overflow',
  ]);
  // известное ограничение: предпросмотр CSV в мастере импорта обрезает длинное значение ячейки многоточием (css/import.css); файл и данные при этом целы
  assert.deepEqual([...ellipsis], ['css/import.css|.import-wizard .import-sample td']);
  const body = ALL.find((r) => r.file === 'style.css' && r.media === null && r.selectors.includes('body'));
  assert.equal(body.decls.get('overflow-wrap'), 'anywhere', 'длинные слова и числа переносятся, а не уходят за край');
  for (const sel of ['html', 'body', '.shell', '.content', 'main', '#main']) {
    for (const r of ALL.filter((x) => x.selectors.includes(sel))) for (const p of ['overflow', 'overflow-x']) assert.ok(!/^(hidden|clip)$/.test(r.decls.get(p) ?? ''), `${sel} прячет горизонтальную прокрутку: ${label(r, p)}`);
  }
});

// ── боковая навигация от 1024 px при крупном шрифте (исправление после проверки FP-26) ───────────────────────────────────────

/** Условие `@media` выполняется при ширине окна `w` px? Разбираются только min-width/max-width; прочие условия (высота, печать) считаются невыполненными. */
const media_applies = (media, w) => media === null || media.split(/\s+and\s+/).every((term) => {
  const mn = /^\(min-width:\s*([\d.]+)px\)$/.exec(term);
  if (mn !== null) return w >= Number(mn[1]);
  const mx = /^\(max-width:\s*([\d.]+)px\)$/.exec(term);
  return mx !== null && w <= Number(mx[1]);
});
/** Итоговое объявление свойства для селектора при ширине `w`: последнее подходящее правило в порядке файла (для правил одной специфичности). */
const effective_decl = (rules, sel, prop, w) => {
  let v;
  for (const r of rules) if (r.selectors.includes(sel) && r.decls.has(prop) && media_applies(r.media, w)) v = r.decls.get(prop);
  return v;
};
/** Первая дорожка `grid-template-columns` (с учётом скобок: `min(13.75rem, 40vw)` — одна дорожка). */
const first_track = (cols) => {
  let depth = 0;
  for (let i = 0; i < cols.length; i += 1) {
    if (cols[i] === '(') depth += 1;
    else if (cols[i] === ')') depth -= 1;
    else if (cols[i] === ' ' && depth === 0) return cols.slice(0, i);
  }
  return cols;
};
/** Что в CSS при ширине `w` обрежет подписи боковой навигации при крупном шрифте: «в одну строку» вместе со скрытым переполнением по X и колонка только в px. */
function nav_clip_problems(rules, w) {
  const out = [];
  const white_space = effective_decl(rules, '.nav a', 'white-space', w) ?? 'normal';
  const overflow_x = effective_decl(rules, '.nav .nav-sections', 'overflow-x', w) ?? effective_decl(rules, '.nav .nav-sections', 'overflow', w) ?? 'visible';
  if (/^(nowrap|pre)$/.test(white_space) && /^(hidden|clip)$/.test(overflow_x)) out.push(`${w}px: .nav a { white-space: ${white_space} } при .nav .nav-sections { overflow-x: ${overflow_x} } — подпись обрезается без прокрутки`);
  const cols = effective_decl(rules, '.shell', 'grid-template-columns', w);
  if (cols !== undefined && w >= 1024 && !/rem|em/.test(first_track(cols))) out.push(`${w}px: колонка навигации «${first_track(cols)}» не растёт вместе со шрифтом`);
  return out;
}

test('REQ-167 200 %: боковая навигация от 1024 px не обрезает подписи при крупном шрифте — колонка в rem (не шире 40 % окна), подписи переносятся; «в одну строку» + скрытое по X не встречаются (проверка видит прежний CSS)', () => {
  for (const w of [1024, 1100, 1279, 1280, 1440, 1920]) assert.deepEqual(nav_clip_problems(ALL, w), [], `${w}px`);
  // эффективные значения от 1024 px
  assert.equal(effective_decl(ALL, '.nav a', 'white-space', 1024), 'normal', 'на широком окне подпись раздела переносится');
  assert.equal(effective_decl(ALL, '.nav a', 'white-space', 800), 'nowrap', 'на средних окнах полоса прокручивается вбок, подписи в одну строку (там overflow-x: auto)');
  assert.equal(effective_decl(ALL, '.nav .nav-sections', 'overflow-x', 800), 'auto');
  assert.equal(effective_decl(ALL, '.nav a', 'overflow-wrap', 1024), undefined, 'длинное слово переносится по правилу body (overflow-wrap: anywhere), навигация его не отменяет');
  assert.equal(effective_decl(ALL, '.nav a', 'word-break', 1024), undefined);
  assert.equal(first_track(effective_decl(ALL, '.shell', 'grid-template-columns', 1280)), 'min(13.75rem, 40vw)', '220 px при шрифте 16 px, растёт со шрифтом, потолок — 40 % окна');
  assert.equal(effective_decl(ALL, '.shell', 'grid-template-columns', 1023), 'minmax(0, 1fr)', 'до 1024 px колонки навигации нет');
  // самопроверка: прежние правила (колонка 220 px, nowrap, скрытое по X) эта проверка ловит
  const old_rules = parse_css('.shell { grid-template-columns: minmax(0, 1fr); } .nav a { white-space: nowrap; } .nav .nav-sections { overflow-x: auto; } '
    + '@media (min-width: 1024px) { .shell { grid-template-columns: 220px minmax(0, 1fr); } .nav .nav-sections { overflow-x: hidden; } }');
  assert.equal(nav_clip_problems(old_rules, 1280).length, 2, nav_clip_problems(old_rules, 1280).join(' | '));
  assert.equal(nav_clip_problems(old_rules, 800).length, 0, 'на средних окнах полоса прокручивается — обрезки нет');
});

test('REQ-167 200 %: низкое узкое окно (200 % на телефоне, телефон набок) — нижняя панель перестаёт быть фиксированной (обычный блок, порядок DOM тот же), отступа под неё не нужно; обычный телефон остаётся с фиксированной панелью', () => {
  const short = ALL.filter((r) => r.file === 'style.css' && r.media === '(max-width: 599px) and (max-height: 480px)');
  assert.ok(short.length >= 2, 'правила низкого окна есть: ' + short.length);
  assert.equal(short.find((r) => r.selectors.includes('.nav')).decls.get('position'), 'static');
  const pad = short.find((r) => r.selectors.includes('.shell .nav ~ .content')).decls.get('padding-bottom');
  assert.match(pad, /^\d+px$/, 'отступ под фиксированную панель не нужен: ' + pad);
  assert.ok(Number.parseInt(pad, 10) <= 48);
  // порядок в файле: правило низкого окна идёт после отступа 12 rem и переопределяет его при той же специфичности
  const order = ALL.filter((r) => r.file === 'style.css');
  const i_rem = order.findIndex((r) => r.selectors.includes('.nav.nav-grouped ~ .content') && r.media === '(max-width: 599px)');
  const i_short = order.findIndex((r) => r.selectors.includes('.shell .nav ~ .content') && r.media === '(max-width: 599px) and (max-height: 480px)');
  assert.ok(i_rem >= 0 && i_short > i_rem);
  // обычный телефон: панель по-прежнему фиксирована (условие по высоте в расчёт ширины не входит)
  assert.equal(effective_decl(ALL, '.nav', 'position', 375), 'fixed');
  assert.equal(effective_decl(ALL, '.nav', 'position', 1280), 'sticky');
  // нигде внутри низкого окна нет order, разворота и размещения в сетке (порядок фокуса = порядок на экране)
  for (const r of short) for (const p of r.decls.keys()) assert.ok(!/^(order|float|grid-row|grid-column|grid-area|direction)$/.test(p), p);
});

test('REQ-167 200 %: нижний отступ содержимого под фиксированную панель телефона — в rem (растёт вместе со шрифтом); в метаданных страниц масштаб не запрещён', () => {
  const phone_content = ALL.filter((r) => r.file === 'style.css' && /max-width:\s*599px/.test(r.media ?? '') && r.selectors.includes('.content'));
  const pad = phone_content.map((r) => r.decls.get('padding')).find((x) => x !== undefined).split(' ');
  assert.match(pad[2], /rem$/);
  const grouped = ALL.find((r) => r.file === 'style.css' && r.selectors.includes('.nav.nav-grouped ~ .content'));
  assert.match(grouped.decls.get('padding-bottom'), /^1[2-9]rem$/, 'под панель с группой «Ещё» и двумя рядами действий');
  for (const f of fs.readdirSync(DEMO).filter((x) => x.endsWith('.html'))) {
    const html = read(f);
    const meta = /<meta name="viewport" content="([^"]*)">/.exec(html);
    assert.ok(meta !== null, f + ': метаданные viewport');
    assert.match(meta[1], /width=device-width/);
    assert.ok(!/maximum-scale|user-scalable\s*=\s*(no|0)/.test(meta[1]), f + ': масштаб страницы не запрещён');
  }
});

test('REQ-167 200 %: таблицы прокручиваются сами — .table-wrap и карточка (.card) имеют overflow-x/auto, широкая таблица (.tbl.wide) всегда лежит в .table-wrap', () => {
  const rule_of = (file, sel) => ALL.filter((r) => r.file === file && r.media === null && r.selectors.includes(sel));
  const wrap = rule_of('style.css', '.table-wrap');
  assert.equal(wrap.length, 1);
  assert.equal(wrap[0].decls.get('overflow'), 'auto');
  assert.equal(wrap[0].decls.get('max-width'), '100%');
  const card = rule_of('css/layout.css', '.card');
  assert.equal(card.length, 1);
  assert.equal(card[0].decls.get('overflow-x'), 'auto', 'карточка прокручивает широкое содержимое по горизонтали сама');
  assert.ok(card[0].selectors.includes('.rep-sheet'), 'и лист для печати («Отчёт»)');
  const print = ALL.filter((r) => r.file === 'css/layout.css' && /\bprint\b/.test(r.media ?? '') && r.selectors.includes('.card'));
  assert.equal(print[0].decls.get('overflow'), 'visible', 'на бумаге лист печатается целиком');
  const dlg = ALL.filter((r) => r.file === 'style.css' && r.selectors.includes('dialog'));
  assert.ok(dlg.some((r) => r.decls.get('overflow') === 'auto'), 'диалог прокручивается');
  // таблицы с минимальной шириной в CSS: .tbl.wide (в коде — только внутри .table-wrap) и таблица значений по умолчанию в «Настройках» (внутри .fp17-defaults с overflow-x: auto)
  const min_w = ALL.filter((r) => r.decls.has('min-width') && /\.tbl|table/.test(r.selectors.join(' '))).map((r) => r.selectors.join(', '));
  assert.deepEqual(min_w, ['.tbl.wide', '.settings .fp17-defaults .tbl']);
  assert.equal(ALL.find((r) => r.selectors.includes('.settings .fp17-defaults')).decls.get('overflow-x'), 'auto');
  for (const f of fs.readdirSync(DEMO).filter((x) => x.endsWith('.mjs'))) {
    const src = read(f);
    for (const m of src.matchAll(/tbl wide/g)) {
      const before = src.slice(Math.max(0, m.index - 400), m.index);
      assert.match(before, /table-wrap/, `${f}: «tbl wide» вне .table-wrap`);
    }
  }
});

// ── 3. все экраны на заглушке DOM: каждая таблица в прокручиваемом контейнере ───────────────────────────────────────────────

test('REQ-167 200 %: на каждом экране (RU и EN) каждая таблица лежит внутри .table-wrap или карточки (оба прокручиваются сами); таблицы без подписи нет', async () => {
  const hrefs = find_all(A.nav(), (n) => n.tagName === 'a').map((a) => a.attrs.href);
  assert.ok(hrefs.length >= 20, 'экранов: ' + hrefs.length);
  const problems = [];
  let tables = 0;
  for (const lang of ['ru', 'en']) {
    A.set_lang(lang);
    for (const href of hrefs) {
      await A.go(href);
      for (const t of find_all(A.main(), (n) => n.tagName === 'table')) {
        tables += 1;
        const chain = ancestors_of(t);
        const ok = chain.some((p) => /(^|\s)(table-wrap|card|rep-sheet|fp17-defaults)(\s|$)/.test(p.className ?? ''));
        if (!ok) problems.push(`${lang} ${href}: <table class="${t.className}"> вне прокручиваемого контейнера`);
        const caption = t.children.find((c) => c.tagName === 'caption');
        if (t.className !== 'cal' && (caption === undefined || caption.textContent.trim() === '')) problems.push(`${lang} ${href}: таблица без caption`);
      }
    }
  }
  A.set_lang('ru');
  await A.go('#overview');
  assert.ok(tables > 40, 'таблиц на экранах: ' + tables);
  assert.deepEqual(problems, [], problems.slice(0, 10).join('\n'));
});

test('REQ-167 ключи каталога a11y и строки FP-26 используются кодом; RU-строки с русскими буквами, EN без кириллицы', () => {
  const code = fs.readdirSync(DEMO).filter((f) => f.endsWith('.mjs')).map((f) => read(f)).join('\n');
  assert.ok(/'a11y\.minus'/.test(code) && /'a11y\.cur_'\s*\+/.test(code));
  for (const [k, v] of Object.entries(CAT.ru)) assert.match(v, /[а-яё]/i, k);
  for (const [k, v] of Object.entries(CAT.en)) assert.ok(!/[а-яё]/i.test(v), k);
});
