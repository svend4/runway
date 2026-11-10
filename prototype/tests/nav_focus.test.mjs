// nav_focus.test.mjs — S1.4: порядок фокуса клавиатуры в навигации совпадает с видимым порядком (WCAG 2.4.3, замечание из проверки в браузере).
// Было: на широком окне CSS `.nav .nav-action { order: -1 }` ставил кнопки действий визуально первыми, а в DOM они шли последними — Tab и глаза расходились.
// Стало: в DOM два списка подряд — «Разделы приложения» (ul.nav-sections) и «Действия» (ul.nav-actions, li.nav-action); на любой ширине порядок тот же,
// CSS меняет только направление и прокрутку. Здесь:
//   1) статика: style.css и demo/css/*.css — на элементах навигации нет order, обратных направлений, float, grid-размещения; действия не прячутся
//      (display/visibility/position), фокус-кольцо не обрезается прокруткой, цели касания не меньше прежних, цвета — только токены тем; index.html — порядок
//      «пропуск → шапка → навигация → содержимое»;
//   2) настоящий app.mjs на заглушке DOM (по образцу entry_boot.test.mjs): два списка с aria-label, ссылки идут раньше кнопок, все пункты достижимы с клавиатуры,
//      disabled только у «Отменить / Вернуть» и только пока нечего отменять, aria-current переезжает вслед за маршрутом, «К содержимому» ведёт на main, EN.
// Проверки CSS сами себя проверяют: на заведомо плохом CSS (старое правило `order: -1`) они обязаны находить нарушение.
// Браузер и сервер не запускаются; набор данных подменён заглушкой fetch.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(HERE, '..', 'demo');
const read = (...p) => fs.readFileSync(path.join(DEMO, ...p), 'utf8');
const HTML = read('index.html');
const CSS = read('style.css');
const APP_SRC = read('app.mjs');
const CSS_FILES = [['style.css', CSS], ...fs.readdirSync(path.join(DEMO, 'css')).filter((f) => f.endsWith('.css')).sort().map((f) => ['css/' + f, read('css', f)])];

// ── разбор CSS (достаточный для наших файлов: правила, вложенные @media, объявления) ───────────────────────────────────

const strip_comments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const norm = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase();

function parse_decls(body) {
  const out = new Map();
  for (const part of body.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const prop = norm(part.slice(0, i));
    if (prop !== '') out.set(prop, norm(part.slice(i + 1)));
  }
  return out;
}

/** Плоский список правил `{file, media, selectors, decls}`; `@media` разворачивается рекурсивно, прочие `@…` пропускаются. */
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

const ALL_RULES = CSS_FILES.flatMap(([file, css]) => parse_css(css, file));
const is_nav_selector = (sel) => /\.nav(?![a-z0-9_])|#nav(?![\w-])|^nav(?![\w-])|\.undo-group/.test(sel);
const nav_rules = (rules) => rules.filter((r) => r.selectors.some(is_nav_selector));
const has_selector = (r, sel) => r.selectors.includes(sel);
const find_rule = (rules, sel, media_re = null) => rules.filter((r) => has_selector(r, sel) && (media_re === null ? r.media === null : r.media !== null && media_re.test(r.media)));
const decl_of = (rules, prop) => { let v; for (const r of rules) if (r.decls.has(prop)) v = r.decls.get(prop); return v; };
const px = (v) => {
  const m = /^(-?[\d.]+)(px|rem)$/.exec(v ?? '');
  return m === null ? NaN : Number(m[1]) * (m[2] === 'rem' ? 16 : 1);
};

/** Нарушения «порядок на экране переставлен»: order, разворот flex, float, direction, размещение в сетке. */
function find_reorder(rules) {
  const bad = [];
  for (const r of rules) {
    for (const [p, v] of r.decls) {
      const reorder = p === 'order' || p === 'float' || p === 'direction'
        || /^grid-(row|column|area|template-areas)/.test(p)
        || ((p === 'flex-direction' || p === 'flex-flow') && /reverse/.test(v));
      if (reorder) bad.push(`${r.file} ${r.media ?? ''} ${r.selectors.join(', ')} { ${p}: ${v} }`);
    }
  }
  return bad;
}

/** Нарушения «действия спрятаны»: не показываются, вынуты из потока, прозрачны, не принимают указатель. */
function find_hiding(rules, allow = () => false) {
  const bad = [];
  for (const r of rules) {
    if (r.media !== null && /\bprint\b/.test(r.media)) continue; // для печати панель нужна не нужна: в печатном листе навигации нет
    for (const [p, v] of r.decls) {
      const hide = (p === 'display' && v === 'none')
        || (p === 'visibility' && /^(hidden|collapse)$/.test(v))
        || (p === 'position' && /^(absolute|fixed)$/.test(v))
        || (p === 'opacity' && Number(v) === 0)
        || (p === 'pointer-events' && v === 'none')
        || (p === 'clip-path' && v !== 'none')
        || (p === 'clip' && v !== 'auto')
        || ((p === 'height' || p === 'width' || p === 'max-height' || p === 'max-width') && /^0(px|rem)?$/.test(v));
      if (hide && !allow(r, p, v)) bad.push(`${r.file} ${r.media ?? ''} ${r.selectors.join(', ')} { ${p}: ${v} }`);
    }
  }
  return bad;
}

// ── 1. статика: CSS и HTML ───────────────────────────────────────────────────────────────────────────────────────────

test('S1.4 разбор CSS: правила навигации найдены в style.css (разбор не пуст и видит вложенные @media)', () => {
  const style = parse_css(CSS, 'style.css');
  assert.ok(style.length > 60, `правил в style.css: ${style.length}`);
  assert.ok(find_rule(style, '.nav').length >= 1, 'правило .nav вне @media');
  assert.ok(find_rule(style, '.nav', /min-width:\s*1024px/).length >= 1, 'правило .nav в @media (min-width: 1024px)');
  assert.ok(find_rule(style, '.nav', /max-width:\s*599px/).length >= 1, 'правило .nav в @media (max-width: 599px)');
  assert.ok(nav_rules(ALL_RULES).length >= 10, 'правил, затрагивающих навигацию, во всех css');
});

test('S1.4 REQ-доступность: на элементах навигации нет order, обратных направлений, float, direction и grid-размещения — ни вне, ни в одном @media', () => {
  const bad = find_reorder(nav_rules(ALL_RULES));
  assert.deepEqual(bad, [], 'порядок на экране обязан совпадать с порядком в DOM (WCAG 2.4.3)');
  // контрольная проверка: прежнее правило, из-за которого порядок расходился, этим же кодом ловится
  const old = parse_css('@media (min-width: 1024px) { .nav .nav-action { order: -1; } }', 'старое');
  assert.equal(find_reorder(nav_rules(old)).length, 1, 'проверка видит `order: -1` на .nav .nav-action');
  assert.equal(find_reorder(nav_rules(parse_css('.nav ul { flex-direction: column-reverse; }'))).length, 1, 'и разворот колонки');
  assert.equal(find_reorder(nav_rules(parse_css('.nav-actions { grid-row: 1; }'))).length, 1, 'и размещение в сетке');
  assert.equal(find_reorder(nav_rules(parse_css('#nav { float: right; }'))).length, 1, 'и float');
});

test('S1.4 порядок крупных блоков: .top, .nav, .content не переставляются в сетке (grid-column — только у шапки на всю ширину)', () => {
  const shell = ALL_RULES.filter((r) => r.selectors.some((s) => /^\.(shell|top|content)$/.test(s)));
  assert.ok(shell.length >= 3);
  const bad = find_reorder(shell).filter((x) => !/\.top \{ grid-column: 1 \/ -1 \}$/.test(x));
  assert.deepEqual(bad, [], 'порядок блоков на странице задаёт DOM: шапка, навигация, содержимое');
  const top_cols = shell.filter((r) => r.selectors.includes('.top') && r.decls.has('grid-column'));
  assert.equal(top_cols.length, 1);
  assert.equal(top_cols[0].decls.get('grid-column'), '1 / -1', 'шапка занимает обе колонки и остаётся первой строкой');
});

test('S1.4 REQ-доступность: действия навигации не прячутся — нет display:none, visibility, absolute/fixed, прозрачности, нулевых размеров; «fixed» — только у всей нижней панели на телефоне', () => {
  const allow = (r, p, v) => p === 'position' && v === 'fixed' && r.selectors.length === 1 && r.selectors[0] === '.nav' && r.media !== null && /max-width:\s*599px/.test(r.media);
  assert.deepEqual(find_hiding(nav_rules(ALL_RULES), allow), []);
  // контрольные проверки
  assert.equal(find_hiding(nav_rules(parse_css('.nav .nav-action { display: none; }'))).length, 1);
  assert.equal(find_hiding(nav_rules(parse_css('@media (min-width: 1024px) { .nav .nav-actions { position: absolute; bottom: 0; } }'))).length, 1);
  assert.equal(find_hiding(nav_rules(parse_css('.nav .nav-action { opacity: 0; }'))).length, 1);
  // панель «fixed» — ровно в одном месте, на телефоне, у самого .nav, прижата к низу и не обрезает содержимое
  const fixed = nav_rules(ALL_RULES).filter((r) => r.decls.get('position') === 'fixed');
  assert.equal(fixed.length, 1);
  assert.ok(fixed[0].media !== null && /max-width:\s*599px/.test(fixed[0].media));
  assert.equal(fixed[0].decls.get('bottom'), '0');
  const nav_all = find_rule(nav_rules(ALL_RULES), '.nav', /./).concat(find_rule(nav_rules(ALL_RULES), '.nav'));
  for (const r of nav_all) assert.ok(!/^(hidden|clip)$/.test(r.decls.get('overflow') ?? ''), `у самой панели нет overflow:hidden (обрезало бы действия): ${r.media}`);
  // для печати панель убирается целиком (в печатном листе навигации нет) — это не «спрятанные действия»
  const print = ALL_RULES.filter((r) => r.media !== null && /\bprint\b/.test(r.media) && r.selectors.includes('.nav'));
  assert.equal(print.length, 1);
});

test('S1.4 раскладки: узкая — нижняя панель в два ряда (разделы, под ними действия); средняя — полоса разделов и ряд действий под ней; широкая — липкая колонка с прокруткой разделов и действиями под ними', () => {
  const style = parse_css(CSS, 'style.css');
  // широкая
  const wide_nav = find_rule(style, '.nav', /min-width:\s*1024px/);
  assert.equal(decl_of(wide_nav, 'position'), 'sticky');
  assert.equal(decl_of(wide_nav, 'top'), '0');
  assert.equal(decl_of(wide_nav, 'display'), 'flex');
  assert.equal(decl_of(wide_nav, 'flex-direction'), 'column');
  assert.equal(decl_of(wide_nav, 'align-self'), 'start');
  assert.match(decl_of(wide_nav, 'max-height'), /^calc\(100vh - var\(--nav-gap\)\)$/, 'панель не выше окна за вычетом запаса на шапку');
  const gaps = style.filter((r) => has_selector(r, '.nav') && r.decls.has('--nav-gap')).map((r) => px(r.decls.get('--nav-gap')));
  assert.ok(gaps.length >= 2, 'запас на шапку задан для 1024–1279 и от 1280 px');
  for (const g of gaps) assert.ok(g >= 80, `запас на шапку ${g}px не меньше её высоты в одну строку (≈ 80 px)`);
  const wide_list = find_rule(style, '.nav .nav-sections', /min-width:\s*1024px/);
  assert.equal(decl_of(wide_list, 'overflow-y'), 'auto', 'разделы прокручиваются внутри панели');
  assert.equal(decl_of(wide_list, 'flex'), '1 1 auto');
  assert.equal(decl_of(wide_list, 'min-height'), '0', 'без этого список не сжимается и действия уезжают за край');
  assert.equal(decl_of(wide_list, 'flex-direction'), 'column');
  const wide_actions = find_rule(style, '.nav .nav-actions', /min-width:\s*1024px/);
  assert.equal(decl_of(wide_actions, 'flex'), '0 0 auto', 'действия не сжимаются и не прокручиваются вместе со списком');
  // без @media: два списка — flex-строки, действия переносятся, а не прячутся за прокрутку
  const base_actions = find_rule(style, '.nav .nav-actions');
  assert.equal(decl_of(base_actions, 'flex-wrap'), 'wrap');
  assert.equal(decl_of(find_rule(style, '.nav ul'), 'display'), 'flex');
  assert.equal(decl_of(find_rule(style, '.nav .nav-sections'), 'overflow-x'), 'auto', 'полоса разделов прокручивается вбок на узких и средних окнах');
  // узкая: действия — второй ряд панели, без переноса (панель не растёт), прокручиваются вбок и не ждут конца списка ссылок
  const phone_actions = find_rule(style, '.nav .nav-actions', /max-width:\s*599px/);
  assert.equal(decl_of(phone_actions, 'flex-wrap'), 'nowrap');
  assert.equal(decl_of(phone_actions, 'overflow-x'), 'auto');
  const phone_content = find_rule(style, '.content', /max-width:\s*599px/);
  const padding = (decl_of(phone_content, 'padding') ?? '').split(' ');
  assert.equal(padding.length, 3);
  assert.ok(px(padding[2]) >= 120, `под двухрядную панель оставлено ${padding[2]}`);
  // при этом sticky — только у .nav и только на широком окне
  const sticky = nav_rules(ALL_RULES).filter((r) => r.decls.get('position') === 'sticky');
  assert.equal(sticky.length, 1);
  assert.deepEqual(sticky[0].selectors, ['.nav']);
  assert.match(sticky[0].media, /min-width:\s*1024px/);
});

test('S1.4 фокус-индикатор виден: у ссылок кольцо внутрь (списки прокручиваются), у кнопок поля списка действий не меньше 5 px; общий :focus-visible на токене темы', () => {
  const style = parse_css(CSS, 'style.css');
  const global = find_rule(style, ':focus-visible');
  assert.equal(decl_of(global, 'outline'), '3px solid var(--focus)');
  assert.equal(px(decl_of(global, 'outline-offset')), 2);
  const link = find_rule(style, '.nav a:focus-visible');
  assert.ok(px(decl_of(link, 'outline-offset')) <= -2, 'кольцо ссылки внутри её рамки: overflow списка его не обрежет');
  assert.ok(!link.some((r) => r.decls.has('outline') || r.decls.has('outline-color') || r.decls.has('outline-width')), 'цвет и толщина кольца остаются общими (токен --focus)');
  const actions = find_rule(style, '.nav .nav-actions');
  const pad = decl_of(actions, 'padding').split(' ').map(px);
  const [pt, pr, pb, pl] = pad.length === 2 ? [pad[0], pad[1], pad[0], pad[1]] : pad.length === 4 ? pad : [pad[0], pad[0], pad[0], pad[0]];
  for (const side of [pt, pr, pb, pl]) assert.ok(side >= 5, `поле списка действий ${side}px: кольцо кнопки 3 px + отступ 2 px не должно резаться прокруткой`);
  assert.ok(px(decl_of(actions, 'gap')) >= 4, 'между кнопками есть зазор (цели не слипаются)');
  // у кнопок слота outline не отключается ни в одном css
  for (const r of ALL_RULES) for (const sel of r.selectors) if (/\.nav/.test(sel) || /\.undo-btn/.test(sel)) {
    assert.ok(!/^(none|0)$/.test(r.decls.get('outline') ?? ''), `${r.file}: ${sel} отключает фокус-кольцо`);
  }
});

test('S1.4 цели касания не меньше прежних: ссылки раздела ≥ 44 px, кнопки действий ≥ 36 px (WCAG 2.5.8 требует 24), на телефоне у ссылки min-width 84 px', () => {
  const style = parse_css(CSS, 'style.css');
  assert.equal(px(decl_of(find_rule(style, '.nav a'), 'min-height')), 44);
  assert.equal(px(decl_of(find_rule(style, '.nav a', /max-width:\s*599px/), 'min-width')), 84);
  const entry = parse_css(read('css', 'entry.css'), 'css/entry.css');
  const btn = find_rule(entry, '.nav .nav-action .btn');
  assert.ok(px(decl_of(btn, 'min-height')) >= 36);
  assert.ok(px(decl_of(find_rule(style, '.btn'), 'min-height')) >= 40, 'общие кнопки 40 px');
});

test('S1.4 темы: правила навигации берут цвета только из токенов (var(--…)) — светлая и тёмная темы не ломаются; токены на месте', () => {
  for (const r of nav_rules(ALL_RULES)) {
    for (const [p, v] of r.decls) {
      if (/^(color|background|background-color|border|border-top|border-bottom|border-left|border-right|border-color|outline|outline-color|box-shadow)$/.test(p)) {
        assert.ok(!/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\b(white|black|red|blue|green|gray|grey)\b/.test(v), `${r.file} ${r.selectors.join(', ')} { ${p}: ${v} } — цвет не из токена`);
      }
    }
  }
  for (const token of ['--surface', '--surface-2', '--border', '--accent', '--text', '--focus']) {
    assert.ok(new RegExp(`${token}:`).test(CSS), `токен ${token}`);
    assert.ok(new RegExp(`:root\\[data-theme="dark"\\]\\s*\\{[^}]*${token}:`).test(CSS), `токен ${token} в тёмной теме`);
  }
  assert.match(CSS, /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)/);
  assert.match(CSS, /body\s*\{[^}]*background:\s*var\(--bg\)/);
});

test('S1.4 index.html: порядок «пропуск → шапка с настройками → навигация → содержимое» (как на экране на широком окне); у навигации aria-label; «К содержимому» не прячется display:none', () => {
  const at = (s) => HTML.indexOf(s);
  const order = [at('id="skip"'), at('id="controls"'), at('<nav id="nav"'), at('<main id="main"')];
  assert.ok(order.every((x) => x >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'порядок в DOM');
  assert.match(HTML, /<nav id="nav" class="nav" aria-label="[^"]+">/);
  assert.match(HTML, /<a id="skip" class="skip" href="#main">К содержимому<\/a>/);
  assert.ok(!/tabindex="-1"[^>]*id="skip"|id="skip"[^>]*tabindex="-1"/.test(HTML), 'ссылка-пропуск достижима с клавиатуры');
  const skip = find_rule(parse_css(CSS, 'style.css'), '.skip');
  assert.notEqual(skip[0].decls.get('display'), 'none', 'пропуск уведён за экран, но не скрыт от Tab');
  assert.notEqual(skip[0].decls.get('visibility'), 'hidden');
  assert.equal(skip[0].decls.get('left'), '-999px');
  const focused = find_rule(parse_css(CSS, 'style.css'), '.skip:focus');
  assert.equal(decl_of(focused, 'left'), '8px', 'при фокусе пропуск выходит на экран');
});

test('S1.4 исходник render_nav: два списка с aria-label из словаря, ссылки с aria-current, действия — li.nav-action в отдельном списке; нет inline-стилей и innerHTML; пустой список действий не рисуется', () => {
  const m = /function render_nav\(\) \{([\s\S]*?)\n\}\n/.exec(APP_SRC);
  assert.ok(m !== null, 'render_nav найден');
  const body = m[1];
  assert.match(body, /class: 'nav-sections', 'aria-label': tr\('nav\.list_sections'\)/);
  assert.match(body, /class: 'nav-actions', 'aria-label': tr\('nav\.list_actions'\)/);
  assert.match(body, /'aria-current': S\.view === v\.id \? 'page' : null/);
  assert.match(body, /h\('li', \{ class: 'nav-action' \}, n\)/);
  assert.match(body, /ext\.slot_nodes\('nav\.actions'\)/);
  assert.match(body, /actions\.length > 0/, 'пустой список скринридеру не нужен');
  assert.ok(body.indexOf('nav-sections') < body.indexOf('nav-actions'), 'в коде разделы строятся раньше действий');
  for (const bad of ['style', 'innerHTML', 'outerHTML', 'tabindex', 'tabIndex', 'order', 'aria-hidden', 'inert', 'hidden']) assert.ok(!body.includes(bad), `render_nav: «${bad}»`);
});

// ── 2. настоящий app.mjs на заглушке DOM ────────────────────────────────────────────────────────────────────────────

class Node_ {
  constructor(tag, ns) {
    this.nodeType = 1; this.tagName = tag; this.ns = ns ?? null; this.attrs = {}; this.children = []; this.listeners = {}; this.className = '';
    this._text = ''; this._value = ''; this._sel = null; this.open = false;
  }
  get textContent() { return this.children.length === 0 ? this._text : this.children.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get value() {
    if (this.tagName === 'select') {
      if (this._sel !== null) return this._sel;
      const opts = this.children.filter((c) => c.tagName === 'option');
      const hit = opts.find((o) => o.attrs.selected !== undefined) ?? opts[0];
      return hit === undefined ? '' : hit.attrs.value;
    }
    return this._value;
  }
  set value(v) { if (this.tagName === 'select') this._sel = String(v); else this._value = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this._value = String(v); }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return Object.hasOwn(this.attrs, k); }
  append(...kids) { for (const k of kids) this.children.push(k); this._text = ''; }
  replaceChildren(...kids) { this.children = []; this._text = ''; this.append(...kids); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() {}
  querySelectorAll() { return []; }
  walk(fn) { fn(this); for (const c of this.children) if (c.nodeType === 1) c.walk(fn); }
}
const byid = new Map();
for (const id of ['app-title', 'app-sub', 'skip', 'controls', 'nav', 'summary', 'main', 'footer', 'live', 'dlg', 'dlg-title', 'dlg-close', 'dlg-body']) byid.set(id, new Node_(id === 'dlg' ? 'dialog' : 'div'));
const listeners = {};
globalThis.document = {
  createElement: (t) => new Node_(t),
  createElementNS: (ns, t) => new Node_(t, ns),
  createTextNode: (data) => ({ nodeType: 3, data }),
  getElementById: (id) => byid.get(id) ?? null,
  documentElement: new Node_('html'),
  head: new Node_('head'),
  body: new Node_('body'),
  title: '',
};
globalThis.window = { addEventListener: (t, fn) => { (listeners[t] ??= []).push(fn); }, scrollTo: () => {} };
globalThis.location = { hash: '' };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'ru-RU' }, configurable: true });
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.ResizeObserver = class { observe() {} };
globalThis.fetch = async (url) => {
  const ws = JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8'));
  ws.as_of = '2026-10-26';
  return { ok: true, json: async () => ws };
};

const { ext } = await import(pathToFileURL(path.join(DEMO, 'ext.mjs')).href);
const I18N = await import(pathToFileURL(path.join(DEMO, 'i18n.mjs')).href);
await import(pathToFileURL(path.join(DEMO, 'app.mjs')).href); // document.getElementById('app-title') !== null → boot() запускается сам
await new Promise((r) => setTimeout(r, 600)); // boot асинхронный: пакеты, набор данных, boot-хук

const N = (x) => String(x).replace(/[  ]/g, ' ');
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const nav = () => byid.get('nav');
const lists = () => nav().children;
/** Все пункты, куда попадает Tab, в порядке DOM: ссылки и кнопки навигации (их порядок и есть порядок фокуса). */
const tab_stops = () => find_all(nav(), (n) => n.tagName === 'a' || n.tagName === 'button');
const label_of = (n) => N(n.attrs['aria-label'] ?? n.textContent);
const click = (n) => n.listeners.click[0]();
const submit = (form) => form.listeners.submit[0]({ preventDefault() {} });
const CORE = ['overview', 'buy', 'waves', 'reserves', 'scenarios', 'feed', 'assistant', 'data'];

test('S1.4 boot: в #nav ровно два списка подряд — «Разделы приложения» (ul.nav-sections) и «Действия» (ul.nav-actions); у каждого aria-label, у панели — прежний «Разделы»', () => {
  assert.equal(nav().attrs['aria-label'], 'Разделы');
  assert.equal(lists().length, 2, 'два списка и ничего лишнего (без обёрток и пустых узлов)');
  assert.deepEqual(lists().map((l) => l.tagName), ['ul', 'ul']);
  assert.deepEqual(lists().map((l) => l.className), ['nav-sections', 'nav-actions']);
  assert.deepEqual(lists().map((l) => l.attrs['aria-label']), ['Разделы приложения', 'Действия']);
  assert.notEqual(lists()[0].attrs['aria-label'], nav().attrs['aria-label'], 'подпись списка не повторяет подпись панели');
  for (const li of lists()[0].children) assert.equal(li.tagName, 'li');
  for (const li of lists()[1].children) { assert.equal(li.tagName, 'li'); assert.equal(li.className, 'nav-action', 'класс пункта действий прежний — его ищут тесты пакетов'); }
});

test('S1.4 порядок фокуса = порядок DOM: сначала все ссылки разделов (в порядке реестра), затем кнопки действий (в порядке слота nav.actions)', () => {
  const stops = tab_stops();
  const links = stops.filter((n) => n.tagName === 'a');
  const buttons = stops.filter((n) => n.tagName === 'button');
  assert.ok(links.length >= 18, `разделов: ${links.length}`);
  assert.ok(buttons.length >= 5, `кнопок действий: ${buttons.length}`);
  assert.ok(stops.indexOf(links.at(-1)) < stops.indexOf(buttons[0]), 'последняя ссылка раньше первой кнопки: действия не «выпрыгивают» вперёд');
  assert.deepEqual(stops.map((n) => n.tagName), [...links.map(() => 'a'), ...buttons.map(() => 'button')]);
  // ссылки — ровно разделы реестра, в его порядке
  assert.deepEqual(links.map((a) => a.attrs.href), ext.nav_items(CORE).map((v) => '#' + v.id));
  assert.deepEqual(links.slice(0, 3).map((a) => a.textContent), ['Обзор', 'Купить', 'Волны']);
  // кнопки лежат во втором списке, ссылки — в первом
  assert.equal(find_all(lists()[0], (n) => n.tagName === 'button').length, 0);
  assert.equal(find_all(lists()[1], (n) => n.tagName === 'a').length, 0);
  assert.equal(find_all(lists()[0], (n) => n.tagName === 'a').length, links.length);
  // порядок кнопок — по `order` слота: «+ Факт» (10), «Сверить остаток» (20), «Отменить / Вернуть» (30), «?» (900)
  const names = buttons.map((b) => N(b.textContent));
  const at = (t) => names.indexOf(t);
  assert.ok([at('+ Факт'), at('Сверить остаток'), at('Отменить'), at('Вернуть'), at('?')].every((i) => i >= 0), names.join(' | '));
  assert.ok(at('+ Факт') < at('Сверить остаток') && at('Сверить остаток') < at('Отменить') && at('Отменить') < at('Вернуть') && at('Вернуть') < at('?'), names.join(' | '));
  // каждый узел слота — свой li.nav-action, по одному на узел
  assert.equal(find_all(lists()[1], (n) => n.className === 'nav-action').length, ext.slot_nodes('nav.actions').length, 'каждый узел слота — свой li.nav-action');
});

test('S1.4 достижимость: ни у ссылок, ни у кнопок, ни у списков нет tabindex < 0, hidden, aria-hidden, inert; у каждого пункта есть имя; кнопки — type="button"', () => {
  const all = find_all(nav(), () => true);
  assert.ok(all.length > 30);
  for (const n of all) {
    const tag = `${n.tagName}${n.className === '' ? '' : '.' + n.className}`;
    if (n.hasAttribute('tabindex')) assert.ok(Number(n.attrs.tabindex) >= 0, `${tag}: tabindex=${n.attrs.tabindex}`);
    for (const bad of ['hidden', 'aria-hidden', 'inert']) assert.equal(n.hasAttribute(bad), false, `${tag}: ${bad}`);
  }
  for (const a of find_all(nav(), (n) => n.tagName === 'a')) {
    assert.match(a.attrs.href, /^#[a-z][a-z0-9_]+$/);
    assert.ok(N(a.textContent).trim().length > 0, 'у ссылки есть видимый текст');
    assert.equal(a.hasAttribute('disabled'), false);
  }
  for (const b of find_all(nav(), (n) => n.tagName === 'button')) {
    assert.equal(b.attrs.type, 'button', label_of(b));
    assert.ok(label_of(b).trim().length > 0, 'у кнопки есть имя (текст или aria-label)');
  }
});

test('S1.4 disabled только с причиной: на старте выключены лишь «Отменить» и «Вернуть» (отменять нечего); после записи «Отменить» оживает; остальные кнопки доступны всегда', () => {
  const buttons = () => find_all(nav(), (n) => n.tagName === 'button');
  const by = (t) => buttons().find((b) => N(b.textContent) === t);
  assert.deepEqual(buttons().filter((b) => b.hasAttribute('disabled')).map((b) => N(b.textContent)).sort(), ['Вернуть', 'Отменить'], 'выключены только кнопки стопки отмены');
  for (const t of ['+ Факт', 'Сверить остаток', '?']) assert.equal(by(t).hasAttribute('disabled'), false, t);
  // записали факт — отменять есть что: причина снята, кнопка доступна
  click(by('+ Факт'));
  const form = byid.get('dlg-body').children[0];
  const amount = find_all(form, (n) => n.attrs.id === 'entry-amount')[0];
  amount.value = '12,50';
  submit(form);
  assert.equal(by('Отменить').hasAttribute('disabled'), false, 'есть что отменять — кнопка доступна');
  assert.equal(by('Вернуть').hasAttribute('disabled'), true, 'возвращать пока нечего');
  click(by('Отменить'));
  assert.equal(by('Вернуть').hasAttribute('disabled'), false, 'после «Отменить» доступна «Вернуть»');
  assert.equal(by('Отменить').hasAttribute('disabled'), true, 'стопка пуста — «Отменить» снова выключена');
  // перерисовка не меняет порядок и состав
  const stops = tab_stops();
  assert.ok(stops.findIndex((n) => n.tagName === 'button') > stops.findLastIndex((n) => n.tagName === 'a'));
});

test('S1.4 aria-current: ровно у одной ссылки (текущий раздел) и переезжает вслед за маршрутом; порядок пунктов при этом не меняется', () => {
  const current = () => find_all(nav(), (n) => n.tagName === 'a' && n.attrs['aria-current'] === 'page').map((a) => a.attrs.href);
  const order_before = tab_stops().map((n) => n.tagName + ':' + label_of(n));
  assert.deepEqual(current(), ['#overview']);
  location.hash = '#settings';
  listeners.hashchange[0]();
  assert.deepEqual(current(), ['#settings'], 'раздел пакета отмечен как текущий');
  location.hash = '#buy';
  listeners.hashchange[0]();
  assert.deepEqual(current(), ['#buy']);
  location.hash = '#overview';
  listeners.hashchange[0]();
  assert.deepEqual(current(), ['#overview']);
  assert.deepEqual(tab_stops().map((n) => n.tagName + ':' + label_of(n)), order_before, 'смена раздела не переставляет пункты навигации');
});

test('S1.4 «К содержимому»: ссылка-пропуск подписана, по нажатию переводит фокус на main (в обход навигации) и не отменена', () => {
  const skip = byid.get('skip');
  assert.equal(N(skip.textContent), 'К содержимому');
  assert.ok(skip.listeners.click.length >= 1);
  let prevented = false;
  skip.listeners.click[0]({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(byid.get('main').focused, true, 'фокус на main');
  assert.equal(find_all(nav(), (n) => n === skip).length, 0, 'ссылка-пропуск стоит перед навигацией, а не внутри неё');
});

test('S1.4 словарь: подписи списков есть на RU и EN и отличаются от подписи панели; на EN панель перерисовывается в том же порядке', () => {
  for (const key of ['nav.list_sections', 'nav.list_actions']) {
    const ru = I18N.t('ru', key);
    const en = I18N.t('en', key);
    assert.ok(ru.trim() !== '' && en.trim() !== '' && ru !== en, key);
    assert.match(ru, /[а-яё]/i);
    assert.ok(!/[а-яё]/i.test(en), `${key}: EN без кириллицы`);
  }
  assert.notEqual(I18N.t('ru', 'nav.list_sections'), I18N.t('ru', 'nav.label'));
  assert.notEqual(I18N.t('en', 'nav.list_sections'), I18N.t('en', 'nav.label'));
  const before = tab_stops().map((n) => n.tagName);
  const en_button = find_all(byid.get('controls'), (n) => n.tagName === 'button' && n.attrs.lang === 'en')[0];
  assert.ok(en_button !== undefined, 'кнопка языка EN');
  click(en_button);
  assert.equal(nav().attrs['aria-label'], 'Sections');
  assert.deepEqual(lists().map((l) => l.attrs['aria-label']), ['App sections', 'Actions']);
  assert.deepEqual(lists().map((l) => l.className), ['nav-sections', 'nav-actions']);
  assert.deepEqual(tab_stops().map((n) => n.tagName), before, 'на EN тот же порядок: сначала ссылки, затем кнопки');
  assert.equal(N(find_all(nav(), (n) => n.tagName === 'a')[0].textContent), 'Overview');
  assert.ok(find_all(nav(), (n) => n.tagName === 'button').some((b) => /^\+ [A-Za-z]/.test(N(b.textContent))), 'кнопки действий на EN на месте');
  assert.equal(byid.get('skip').textContent, 'Skip to content');
  // вернуть русский, чтобы порядок тестов не влиял на результат
  const ru_button = find_all(byid.get('controls'), (n) => n.tagName === 'button' && n.attrs.lang === 'ru')[0];
  click(ru_button);
  assert.equal(nav().attrs['aria-label'], 'Разделы');
});

test('S1.4 кнопка пакета с самым ранним order слота nav.actions встаёт первой среди действий, но не выше ссылок разделов (то, что раньше делал CSS order: -1, теперь невозможно)', () => {
  const probe = () => {
    const b = document.createElement('button');
    b.setAttribute('type', 'button');
    b.textContent = 'Проба порядка';
    return b;
  };
  ext.register_slot_item('nav.actions', { id: 'nf_probe', order: -100, render: probe });
  ext.ctx.refresh(); // страница перерисована хозяином: render() → render_nav()
  const stops = tab_stops();
  const first_button = stops.findIndex((n) => n.tagName === 'button');
  const last_link = stops.findLastIndex((n) => n.tagName === 'a');
  assert.equal(N(stops[first_button].textContent), 'Проба порядка', 'в списке действий она первая — по order слота');
  assert.ok(first_button > last_link, 'но все ссылки разделов остаются раньше любой кнопки');
  assert.equal(find_all(lists()[0], (n) => n.tagName === 'button').length, 0, 'в списке разделов кнопок нет');
  assert.equal(find_all(lists()[1], (n) => N(n.textContent) === 'Проба порядка').length >= 1, true, 'кнопка лежит во втором списке');
  assert.deepEqual(stops.map((n) => n.tagName), [...stops.filter((n) => n.tagName === 'a').map(() => 'a'), ...stops.filter((n) => n.tagName === 'button').map(() => 'button')]);
});
