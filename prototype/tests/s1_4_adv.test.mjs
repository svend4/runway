// s1_4_adv.test.mjs — состязательная проверка S1.4 («порядок фокуса в навигации»); аддитивно к nav_focus.test.mjs, ничего в нём не меняет.
// Что проверяется сверх тестов реализатора:
//   1) настоящий каскад CSS (специфичность + порядок правил + @media по ширине окна), а не только «в файле нет order»: итоговые значения свойств у
//      nav, обоих списков, пунктов, ссылок и кнопок на ширинах 320…1920 px, включая css/*.css, которые пакеты подгружают после style.css;
//   2) настоящий app.mjs на заглушке DOM в состояниях, которых нет в nav_focus: пустой слот nav.actions, упавший блок слота, блок с несколькими узлами,
//      текстовый узел вместо элемента, повторные перерисовки (узлы не копятся), все наборы G-001 (low/gap/late), оба режима расчёта, оба языка,
//      сбой загрузки набора данных (плашка ошибки вместо экрана — навигация остаётся целой);
//   3) литеральное использование новых ключей словаря в коде и отсутствие обходных путей (innerHTML, style) у узлов навигации.
// Браузер и сервер не запускаются; набор данных подменён заглушкой fetch (читает файлы из data/).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(HERE, '..', 'demo');
const read = (...p) => fs.readFileSync(path.join(DEMO, ...p), 'utf8');
const APP_SRC = read('app.mjs');
const CSS_FILES = [['style.css', read('style.css')], ...fs.readdirSync(path.join(DEMO, 'css')).filter((f) => f.endsWith('.css')).sort().map((f) => ['css/' + f, read('css', f)])];

// ── 1. каскад CSS ─────────────────────────────────────────────────────────────────────────────────────────────────

const strip_comments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const norm = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase();

function parse_decls(body) {
  const out = new Map();
  for (const part of body.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const prop = norm(part.slice(0, i));
    const raw = norm(part.slice(i + 1));
    const important = /\s*!important$/.test(raw);
    if (prop !== '') out.set(prop, { value: raw.replace(/\s*!important$/, ''), important });
  }
  return out;
}

/** Плоский список правил в порядке файла: `{file, media, selectors, decls}`; `@media` разворачивается, прочие `@…` пропускаются. */
function parse_css(css, file, media = null, out = []) {
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

const RULES = CSS_FILES.flatMap(([file, css]) => parse_css(css, file)); // порядок каскада: style.css, затем css/*.css (их подгружают пакеты позже)

/** Выполняется ли условие `@media` при ширине окна `w` px (печать, тёмная тема и «меньше движения» в расчёт не входят — светлый экран). */
function media_ok(media, w) {
  if (media === null) return true;
  return media.split(/\s+and\s+/).every((term) => {
    const mn = /^\(min-width:\s*([\d.]+)px\)$/.exec(term);
    if (mn !== null) return w >= Number(mn[1]);
    const mx = /^\(max-width:\s*([\d.]+)px\)$/.exec(term);
    if (mx !== null) return w <= Number(mx[1]);
    return false;
  });
}

/** Составной селектор → условия; `null`, если в нём состояние (:hover, :focus-visible…) или неподдержанный синтаксис — такое правило в расчёте не участвует. */
function compound(src) {
  const c = { tag: null, id: null, classes: [], attrs: [] };
  let rest = src;
  const t = /^[a-z][a-z0-9]*/.exec(rest);
  if (t !== null) { c.tag = t[0]; rest = rest.slice(t[0].length); }
  while (rest !== '') {
    let m;
    if ((m = /^#([\w-]+)/.exec(rest)) !== null) c.id = m[1];
    else if ((m = /^\.([\w-]+)/.exec(rest)) !== null) c.classes.push(m[1]);
    else if ((m = /^\[([\w-]+)(?:="([^"]*)")?\]/.exec(rest)) !== null) c.attrs.push([m[1], m[2] ?? null]);
    else return null;
    rest = rest.slice(m[0].length);
  }
  return c;
}

function parse_selector(sel) {
  if (/[>+~:*]/.test(sel)) return null;
  const parts = sel.split(' ').map(compound);
  return parts.some((p) => p === null) ? null : parts;
}

const specificity = (parts) => parts.reduce((s, c) => [s[0] + (c.id === null ? 0 : 1), s[1] + c.classes.length + c.attrs.length, s[2] + (c.tag === null ? 0 : 1)], [0, 0, 0]);
const spec_cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);

function el_matches(c, el) {
  if (c.tag !== null && c.tag !== el.tag) return false;
  if (c.id !== null && c.id !== el.id) return false;
  if (!c.classes.every((k) => (el.classes ?? []).includes(k))) return false;
  return c.attrs.every(([k, v]) => Object.hasOwn(el.attrs ?? {}, k) && (v === null || el.attrs[k] === v));
}

/** Селектор (потомки через пробел) подходит к последнему элементу цепочки «предки → элемент». */
function chain_matches(parts, chain) {
  const go = (pi, ci) => {
    if (pi < 0) return true;
    for (let k = ci; k >= 0; k -= 1) if (el_matches(parts[pi], chain[k]) && go(pi - 1, k - 1)) return true;
    return false;
  };
  return el_matches(parts[parts.length - 1], chain[chain.length - 1]) && go(parts.length - 2, chain.length - 2);
}

const BODY = { tag: 'body' };
const SHELL = { tag: 'div', classes: ['shell'] };
const NAV = { tag: 'nav', id: 'nav', classes: ['nav'], attrs: { 'aria-label': 'Разделы' } };
const UL_SECTIONS = { tag: 'ul', classes: ['nav-sections'], attrs: { 'aria-label': 'x' } };
const UL_ACTIONS = { tag: 'ul', classes: ['nav-actions'], attrs: { 'aria-label': 'x' } };
const CHAINS = {
  nav: [BODY, SHELL, NAV],
  sections: [BODY, SHELL, NAV, UL_SECTIONS],
  actions: [BODY, SHELL, NAV, UL_ACTIONS],
  section_li: [BODY, SHELL, NAV, UL_SECTIONS, { tag: 'li' }],
  link: [BODY, SHELL, NAV, UL_SECTIONS, { tag: 'li' }, { tag: 'a', attrs: { href: '#overview' } }],
  link_current: [BODY, SHELL, NAV, UL_SECTIONS, { tag: 'li' }, { tag: 'a', attrs: { href: '#overview', 'aria-current': 'page' } }],
  action_li: [BODY, SHELL, NAV, UL_ACTIONS, { tag: 'li', classes: ['nav-action'] }],
  action_btn: [BODY, SHELL, NAV, UL_ACTIONS, { tag: 'li', classes: ['nav-action'] }, { tag: 'button', classes: ['btn'], attrs: { type: 'button' } }],
};

/** Итоговое значение свойства у элемента при ширине окна `w` (каскад: важность → специфичность → порядок); `undefined` — не задано. */
function resolve(which, prop, w) {
  const chain = CHAINS[which];
  let best = null;
  RULES.forEach((r, order) => {
    if (!media_ok(r.media, w) || !r.decls.has(prop)) return;
    for (const sel of r.selectors) {
      const parts = parse_selector(sel);
      if (parts === null || !chain_matches(parts, chain)) continue;
      const d = r.decls.get(prop);
      const cand = { imp: d.important ? 1 : 0, spec: specificity(parts), order, value: d.value };
      if (best === null || cand.imp > best.imp || (cand.imp === best.imp && (spec_cmp(cand.spec, best.spec) > 0 || (spec_cmp(cand.spec, best.spec) === 0 && cand.order > best.order)))) best = cand;
    }
  });
  return best === null ? undefined : best.value;
}

const WIDTHS = [320, 480, 599, 600, 768, 1023, 1024, 1279, 1280, 1440, 1920];
const px = (v) => { const m = /^(-?[\d.]+)(px|rem)$/.exec(v ?? ''); return m === null ? NaN : Number(m[1]) * (m[2] === 'rem' ? 16 : 1); };

test('S1.4-adv каскад: у навигации на любой ширине нет order, разворотов и размещения в сетке (итоговые значения, а не только текст файла)', () => {
  for (const w of WIDTHS) {
    for (const which of Object.keys(CHAINS)) {
      for (const prop of ['order', 'float', 'direction', 'grid-row', 'grid-column', 'grid-area']) assert.equal(resolve(which, prop, w), undefined, `${w}px ${which}: ${prop}`);
      assert.ok(!/reverse/.test(resolve(which, 'flex-direction', w) ?? ''), `${w}px ${which}: flex-direction`);
    }
  }
});

test('S1.4-adv каскад: порядок «разделы, затем действия» совпадает с DOM на каждой ширине — .nav складывает списки вертикально (блок или колонка), оба списка не прячутся', () => {
  for (const w of WIDTHS) {
    const nav_display = resolve('nav', 'display', w);
    const dir = resolve('nav', 'flex-direction', w);
    if (w >= 1024) { assert.equal(nav_display, 'flex', `${w}px`); assert.equal(dir, 'column', `${w}px: колонка, не строка`); } else assert.ok(nav_display === undefined || nav_display === 'block', `${w}px: .nav — обычный блок, списки друг под другом (display: ${nav_display})`);
    for (const which of ['sections', 'actions']) {
      assert.equal(resolve(which, 'display', w), 'flex', `${w}px ${which}`);
      assert.ok(!['none', 'hidden'].includes(resolve(which, 'visibility', w) ?? ''), `${w}px ${which}: visibility`);
      assert.equal(resolve(which, 'opacity', w), undefined, `${w}px ${which}: opacity`);
      assert.equal(resolve(which, 'position', w), undefined, `${w}px ${which}: список не вынут из потока`);
    }
    assert.equal(resolve('action_li', 'display', w), 'flex', `${w}px: пункт действия виден`);
    assert.equal(resolve('action_li', 'order', w), undefined);
  }
});

test('S1.4-adv каскад: положение панели по ширинам — липкая от 1024, фиксированная внизу до 599, обычная посередине; --nav-gap ≥ высоты шапки в одну строку', () => {
  for (const w of WIDTHS) {
    const want = w >= 1024 ? 'sticky' : w <= 599 ? 'fixed' : undefined;
    assert.equal(resolve('nav', 'position', w), want, `${w}px`);
    if (w >= 1024) {
      assert.equal(resolve('nav', 'top', w), '0');
      assert.equal(resolve('nav', 'align-self', w), 'start');
      assert.match(resolve('nav', 'max-height', w), /^calc\(100vh - var\(--nav-gap\)\)$/);
      assert.ok(px(resolve('nav', '--nav-gap', w)) >= 80, `${w}px: --nav-gap=${resolve('nav', '--nav-gap', w)}`);
    } else assert.equal(resolve('nav', 'max-height', w), undefined, `${w}px: у не липкой панели нет max-height (обрезало бы действия)`);
    if (w <= 599) { assert.equal(resolve('nav', 'bottom', w), '0'); assert.equal(resolve('nav', 'left', w), '0'); assert.equal(resolve('nav', 'right', w), '0'); }
  }
});

test('S1.4-adv каскад: на широком окне разделы прокручиваются, действия не сжимаются; на узком и среднем — разделы прокручиваются вбок, действия переносятся (600–1023) или идут рядом с прокруткой вбок (до 599)', () => {
  for (const w of WIDTHS) {
    if (w >= 1024) {
      assert.equal(resolve('sections', 'overflow-y', w), 'auto', `${w}px`);
      assert.equal(resolve('sections', 'overflow-x', w), 'hidden', `${w}px`);
      assert.equal(resolve('sections', 'flex', w), '1 1 auto');
      assert.equal(resolve('sections', 'min-height', w), '0');
      assert.equal(resolve('sections', 'flex-direction', w), 'column');
      assert.equal(resolve('actions', 'flex', w), '0 0 auto');
      assert.equal(resolve('actions', 'overflow-x', w), undefined, `${w}px: у действий нет прокрутки — кольцо кнопок не режется`);
      assert.equal(resolve('actions', 'flex-wrap', w), 'wrap');
    } else {
      assert.equal(resolve('sections', 'overflow-x', w), 'auto', `${w}px`);
      assert.equal(resolve('sections', 'flex-direction', w), undefined, `${w}px: ссылки в строку`);
      assert.equal(resolve('sections', 'min-height', w), undefined);
      if (w <= 599) { assert.equal(resolve('actions', 'flex-wrap', w), 'nowrap', `${w}px`); assert.equal(resolve('actions', 'overflow-x', w), 'auto', `${w}px`); assert.equal(resolve('action_li', 'flex', w), '0 0 auto'); } else { assert.equal(resolve('actions', 'flex-wrap', w), 'wrap', `${w}px`); assert.equal(resolve('actions', 'overflow-x', w), undefined, `${w}px`); }
    }
  }
});

test('S1.4-adv каскад: цели касания и фокус на каждой ширине — ссылка ≥ 44 px (на телефоне ≥ 84 px шириной), кнопка действия ≥ 36 px, у списка действий поля ≥ 5 px; пакеты не отключают outline', () => {
  for (const w of WIDTHS) {
    assert.ok(px(resolve('link', 'min-height', w)) >= 44, `${w}px link`);
    if (w <= 599) assert.ok(px(resolve('link', 'min-width', w)) >= 84, `${w}px link min-width`);
    assert.ok(px(resolve('action_btn', 'min-height', w)) >= 36, `${w}px btn: ${resolve('action_btn', 'min-height', w)}`);
    assert.equal(resolve('action_btn', 'outline', w), undefined);
    assert.equal(resolve('link', 'outline', w), undefined);
    const pad = (resolve('actions', 'padding', w) ?? '').split(' ').map(px);
    assert.ok(pad.length >= 1 && pad.every((x) => x >= 5), `${w}px: поля списка действий ${pad.join(' ')}`);
    assert.ok(px(resolve('actions', 'gap', w)) >= 4, `${w}px: зазор между кнопками`);
  }
});

test('S1.4-adv каскад: под нижнюю панель на телефоне оставлено не меньше её номинальной высоты (ссылка 44+3, ряд действий 6+36+6+1, рамки) — содержимое не уходит под панель', () => {
  const nominal = 44 + 3 + (6 + 36 + 6 + 1) + 1;
  // .content не входит в CHAINS: берём правило напрямую (в @media (max-width: 599px))
  const phone = RULES.filter((r) => r.media !== null && /max-width:\s*599px/.test(r.media) && r.selectors.includes('.content'));
  assert.equal(phone.length, 1);
  const parts = phone[0].decls.get('padding').value.split(' ');
  assert.equal(parts.length, 3);
  assert.ok(px(parts[2]) >= nominal, `нижний отступ ${parts[2]} < ${nominal} px`);
  // фиксированная панель и отступ содержимого заданы в одном и том же условии @media
  const fixed = RULES.filter((r) => r.selectors.includes('.nav') && r.decls.get('position')?.value === 'fixed');
  assert.equal(fixed.length, 1);
  assert.equal(fixed[0].media, phone[0].media, 'один и тот же @media у панели и у отступа содержимого');
});

test('S1.4-adv css пакетов, подгружаемые после style.css, не меняют раскладку навигации: у .nav-правил в css/*.css только размеры кнопки и группа «Отменить / Вернуть»', () => {
  const allowed = new Set(['min-height', 'padding', 'white-space', 'display', 'gap']);
  for (const r of RULES.filter((x) => x.file !== 'style.css')) {
    for (const sel of r.selectors.filter((s) => /\.nav(?![a-z0-9_])|#nav(?![\w-])/.test(s))) {
      for (const p of r.decls.keys()) assert.ok(allowed.has(p), `${r.file}: ${sel} { ${p} } — пакет не должен менять раскладку навигации`);
      if (r.decls.has('display')) assert.equal(r.decls.get('display').value, 'inline-flex', `${r.file}: ${sel}`);
    }
  }
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
const real_fetch = async (url) => {
  const ws = JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8'));
  ws.as_of = '2026-10-26';
  return { ok: true, json: async () => ws };
};
globalThis.fetch = real_fetch;

const { ext } = await import(pathToFileURL(path.join(DEMO, 'ext.mjs')).href);
const I18N = await import(pathToFileURL(path.join(DEMO, 'i18n.mjs')).href);
await import(pathToFileURL(path.join(DEMO, 'app.mjs')).href);
await new Promise((r) => setTimeout(r, 600)); // boot асинхронный: пакеты, набор данных, boot-хук

const N = (x) => String(x).replace(/[  ]/g, ' ');
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const nav = () => byid.get('nav');
const lists = () => nav().children;
const tab_stops = () => find_all(nav(), (n) => n.tagName === 'a' || n.tagName === 'button');
const all_nodes = () => find_all(nav(), () => true);
const click = (n) => n.listeners.click[0]();

/** Инвариант навигации: два списка в нужном порядке, подписи, ссылки раньше кнопок, ровно одна текущая, ничего лишнего. */
function assert_nav_shape(label, expect = {}) {
  assert.equal(lists().length, 2, `${label}: два списка`);
  assert.deepEqual(lists().map((l) => l.className), ['nav-sections', 'nav-actions'], label);
  const lang = expect.lang ?? 'ru';
  assert.deepEqual(lists().map((l) => l.attrs['aria-label']), [I18N.t(lang, 'nav.list_sections'), I18N.t(lang, 'nav.list_actions')], `${label}: подписи`);
  assert.equal(nav().attrs['aria-label'], I18N.t(lang, 'nav.label'), label);
  const stops = tab_stops();
  const first_button = stops.findIndex((n) => n.tagName === 'button');
  assert.ok(first_button > 0, `${label}: кнопки есть`);
  assert.ok(stops.slice(0, first_button).every((n) => n.tagName === 'a') && stops.slice(first_button).every((n) => n.tagName === 'button'), `${label}: ссылки, затем кнопки`);
  assert.equal(find_all(nav(), (n) => n.tagName === 'a' && n.attrs['aria-current'] === 'page').length, 1, `${label}: одна текущая ссылка`);
  for (const li of lists()[1].children) assert.ok(li.tagName === 'li' && li.className === 'nav-action', `${label}: пункт действий`);
  for (const n of all_nodes()) { assert.ok(!('innerHTML' in n) && !('outerHTML' in n), `${label}: ${n.tagName} без innerHTML`); assert.ok(!n.hasAttribute('style'), `${label}: ${n.tagName} без inline-стиля`); }
  if (expect.links !== undefined) assert.equal(stops.filter((n) => n.tagName === 'a').length, expect.links, `${label}: число ссылок`);
  return stops.length;
}

const BASE_LINKS = find_all(nav(), (n) => n.tagName === 'a').length;
const BASE_STOPS = tab_stops().length;

test('S1.4-adv boot: исходное состояние — два списка, 18+ ссылок, не меньше 5 кнопок, ни одного узла вне двух списков', () => {
  assert.ok(BASE_LINKS >= 18);
  assert.equal(assert_nav_shape('boot', { links: BASE_LINKS }), BASE_STOPS);
  assert.ok(BASE_STOPS - BASE_LINKS >= 5);
});

test('S1.4-adv повторные перерисовки (×6, смена раздела туда-обратно): узлы не копятся, число пунктов навигации не растёт, порядок тот же', () => {
  const count0 = all_nodes().length;
  const names0 = tab_stops().map((n) => n.tagName + ':' + N(n.attrs['aria-label'] ?? n.textContent));
  for (let i = 0; i < 6; i++) ext.ctx.refresh();
  location.hash = '#data'; listeners.hashchange[0]();
  location.hash = '#overview'; listeners.hashchange[0]();
  assert.equal(all_nodes().length, count0, 'число узлов в навигации стабильно');
  assert.deepEqual(tab_stops().map((n) => n.tagName + ':' + N(n.attrs['aria-label'] ?? n.textContent)), names0);
  assert_nav_shape('после перерисовок', { links: BASE_LINKS });
});

test('S1.4-adv наборы G-001 low/gap/late × режимы plan/worse × RU/EN: после каждой перерисовки навигация целая (порядок, подписи, одна текущая ссылка, то же число пунктов)', async () => {
  const ds_ids = I18N.DATASETS.map((d) => d.id);
  assert.ok(ds_ids.includes('low') && ds_ids.includes('gap') && ds_ids.includes('late'), ds_ids.join(','));
  const select = () => find_all(byid.get('controls'), (n) => n.tagName === 'select' && n.attrs.id === 'ds-top')[0];
  const modes = () => find_all(byid.get('controls'), (n) => n.tagName === 'button' && n.attrs['aria-pressed'] !== undefined && n.attrs.lang === undefined);
  const langs = () => find_all(byid.get('controls'), (n) => n.tagName === 'button' && n.attrs.lang !== undefined);
  assert.equal(modes().length, 2);
  for (const id of ['low', 'gap', 'late', 'g001']) {
    await select().listeners.change[0]({ target: { value: id } });
    for (const lang of ['en', 'ru']) {
      click(langs().find((b) => b.attrs.lang === lang));
      for (let i = 0; i < modes().length; i++) {
        click(modes()[i]);
        assert.equal(assert_nav_shape(`${id}/${lang}/режим ${i}`, { lang, links: BASE_LINKS }), BASE_STOPS, `${id}/${lang}/режим ${i}: то же число пунктов`);
      }
    }
  }
  click(modes()[0]);
  assert.equal(nav().attrs['aria-label'], 'Разделы', 'итоговое состояние — русский');
});

test('S1.4-adv сбой загрузки набора данных: вместо экрана — плашка ошибки, а навигация остаётся целой и достижимой (разделы и действия на месте)', async () => {
  const select = () => find_all(byid.get('controls'), (n) => n.tagName === 'select' && n.attrs.id === 'ds-top')[0];
  globalThis.fetch = async () => ({ ok: false });
  try {
    await select().listeners.change[0]({ target: { value: 'gap' } });
    const alert = find_all(byid.get('main'), (n) => n.attrs.role === 'alert');
    assert.ok(alert.length >= 1, 'плашка ошибки');
    assert_nav_shape('после сбоя загрузки');
    assert.equal(tab_stops().filter((n) => n.tagName === 'a').length, BASE_LINKS, 'разделы не пропали');
    for (const b of find_all(nav(), (n) => n.tagName === 'button')) assert.ok(!b.hasAttribute('tabindex'), 'у кнопок нет tabindex');
  } finally {
    globalThis.fetch = real_fetch;
    await select().listeners.change[0]({ target: { value: 'g001' } });
  }
  assert_nav_shape('после восстановления', { links: BASE_LINKS });
});

test('S1.4-adv пустой слот nav.actions: список действий не рисуется вовсе (нет пустого ul для скринридера), список разделов остаётся единственным', () => {
  const real = ext.slot_nodes;
  ext.slot_nodes = (slot, c) => (slot === 'nav.actions' ? [] : real.call(ext, slot, c));
  try {
    ext.ctx.refresh();
    assert.equal(lists().length, 1, 'только список разделов');
    assert.equal(lists()[0].className, 'nav-sections');
    assert.equal(find_all(nav(), (n) => n.className === 'nav-actions' || n.className === 'nav-action').length, 0);
    assert.equal(find_all(nav(), (n) => n.tagName === 'button').length, 0);
    assert.equal(find_all(nav(), (n) => n.tagName === 'a').length, BASE_LINKS, 'ссылки на месте');
  } finally {
    ext.slot_nodes = real;
    ext.ctx.refresh();
  }
  assert_nav_shape('после возврата слота', { links: BASE_LINKS });
});

test('S1.4-adv слот nav.actions: упавший блок пропускается без пустого пункта, блок из нескольких узлов — по пункту на узел, не элементы (текст, null, число) отбрасываются', () => {
  const btn = (t) => { const b = document.createElement('button'); b.setAttribute('type', 'button'); b.textContent = t; return b; };
  ext.register_slot_item('nav.actions', { id: 'adv_throw', order: 5, render: () => { throw new Error('сбой блока'); } });
  ext.register_slot_item('nav.actions', { id: 'adv_multi', order: 6, render: () => [btn('Адв-1'), [btn('Адв-2')], null, undefined, 'просто текст', 42, document.createTextNode('узел-текст')] });
  ext.ctx.refresh();
  assert_nav_shape('с пробными блоками', { links: BASE_LINKS });
  const items = lists()[1].children;
  assert.equal(items.length, ext.slot_nodes('nav.actions').length, 'по пункту на каждый элемент слота');
  for (const li of items) assert.ok(li.children.length === 1 && li.children[0].nodeType === 1, 'в пункте ровно один элемент: нет пустых пунктов и текстовых узлов');
  const texts = tab_stops().filter((n) => n.tagName === 'button').map((b) => N(b.textContent));
  assert.ok(texts.includes('Адв-1') && texts.includes('Адв-2'));
  assert.ok(texts.indexOf('Адв-1') < texts.indexOf('Адв-2'), 'порядок узлов блока сохранён');
  assert.ok(!texts.some((t) => /просто текст|узел-текст|42/.test(t)), 'текст вместо элемента не попал в навигацию');
  const first_btn = tab_stops().findIndex((n) => n.tagName === 'button');
  assert.ok(first_btn >= BASE_LINKS, 'даже блок с order 5 не поднимает кнопку выше ссылок разделов');
});

// ── 3. исходники ───────────────────────────────────────────────────────────────────────────────────────────────────

test('S1.4-adv ключи nav.list_sections и nav.list_actions: ровно один литерал каждого в app.mjs (не динамически), обе строки RU и EN, плейсхолдеров нет', () => {
  const code = APP_SRC.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
  for (const key of ['nav.list_sections', 'nav.list_actions']) {
    const hits = code.split(`'${key}'`).length - 1;
    assert.equal(hits, 1, `${key}: литералов в коде ${hits}`);
    for (const lang of ['ru', 'en']) assert.ok(!/\{[a-z_]+\}/.test(I18N.t(lang, key)), `${key}/${lang}: без плейсхолдеров`);
  }
  assert.ok(!/class: 'nav-actions'[^)]*style/.test(code));
});
