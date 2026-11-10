// contrast.test.mjs — FP-12, REQ-166 (WCAG 2.2 AA) и REQ-167 (клавиатура): контраст токенов светлой и тёмной тем (tools/contrast.mjs), покрытие пар реальным использованием в CSS,
// чувствительность проверки к порче токена, и «клавиатурный обход» всех экранов на заглушке DOM (у каждого элемента управления есть имя и нет положительного tabindex).
// Настоящий обход клавиатурой и масштаб 200 % в браузере не проверялись. Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const read = (...p) => fs.readFileSync(path.join(PROTO, ...p), 'utf8');

// ── заглушка DOM для обхода экранов ───────────────────────────────────────────────────────────────────────────────────────

class Node_ {
  constructor(tag, ns) {
    this.nodeType = 1; this.tagName = tag; this.ns = ns ?? null; this.attrs = {}; this.children = []; this.listeners = {}; this.className = '';
    this._text = ''; this._value = ''; this._sel = null; this.open = false; this.checked = false;
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
  focus() {}
  click() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() {}
  querySelectorAll() { return []; }
  walk(fn) { fn(this); for (const c of this.children) if (c.nodeType === 1) c.walk(fn); }
}
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const byid = new Map();
for (const id of ['app-title', 'app-sub', 'skip', 'controls', 'nav', 'summary', 'main', 'footer', 'live', 'dlg', 'dlg-title', 'dlg-close', 'dlg-body']) byid.set(id, new Node_(id === 'dlg' ? 'dialog' : 'div'));
const listeners = {};
globalThis.document = {
  createElement: (t) => new Node_(t), createElementNS: (ns, t) => new Node_(t, ns), createTextNode: (data) => ({ nodeType: 3, data }),
  getElementById: (id) => byid.get(id) ?? find_all(byid.get('main'), (n) => n.attrs.id === id)[0] ?? null,
  documentElement: new Node_('html'), head: new Node_('head'), body: new Node_('body'), title: '',
};
globalThis.window = { addEventListener: (t, fn) => { (listeners[t] ??= []).push(fn); }, scrollTo: () => {} };
globalThis.location = { hash: '' };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'ru-RU' }, configurable: true });
const store = new Map();
globalThis.localStorage = { get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null, getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); } };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.ResizeObserver = class { observe() {} };
globalThis.fetch = async (url) => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8')) });

const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);
const CT = await imp('tools', 'contrast.mjs');
const { ext } = await imp('demo', 'ext.mjs');
await imp('demo', 'app.mjs');
await new Promise((r) => setTimeout(r, 700));
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };

const CSS = read('demo', 'style.css');
const OTHER = fs.readdirSync(path.join(PROTO, 'demo', 'css')).filter((f) => f.endsWith('.css')).sort().map((f) => ({ name: f, text: read('demo', 'css', f) }));

// ── формула WCAG ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-166 формула контраста WCAG: чёрное на белом 21:1, одинаковые цвета 1:1, #767676 на белом 4,54:1 проходит порог 4,5, #777777 — 4,48:1 не проходит; краткая запись #rgb', () => {
  const r = (a, b) => Math.round(CT.contrast_ratio(a, b) * 100) / 100;
  assert.equal(r('#000000', '#ffffff'), 21);
  assert.equal(r('#ffffff', '#000000'), 21, 'порядок цветов не важен');
  assert.equal(r('#336699', '#336699'), 1);
  assert.equal(r('#767676', '#ffffff'), 4.54);
  assert.equal(r('#777777', '#ffffff'), 4.48);
  assert.ok(CT.contrast_ratio('#767676', '#ffffff') >= CT.THRESHOLDS.text);
  assert.ok(CT.contrast_ratio('#777777', '#ffffff') < CT.THRESHOLDS.text);
  assert.equal(r('#000', '#fff'), 21);
  assert.deepEqual(CT.parse_hex('#1f5fbf'), [31, 95, 191]);
  assert.equal(CT.parse_hex('rgb(1,2,3)'), null);
  assert.equal(CT.parse_hex('#12345'), null);
  assert.throws(() => CT.contrast_ratio('синий', '#fff'), RangeError);
  assert.deepEqual(CT.THRESHOLDS, { text: 4.5, graphic: 3, ui: 3 });
  // яркость: чёрный 0, белый 1
  assert.equal(CT.relative_luminance([0, 0, 0]), 0);
  assert.equal(CT.relative_luminance([255, 255, 255]), 1);
});

// ── токены style.css ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-166 токены style.css: светлая и тёмная темы (системная и ручная) — одни и те же имена, значения двух тёмных блоков совпадают; все обязательные пары выше порога WCAG 2.2 AA', () => {
  const t = CT.theme_tokens(CSS);
  assert.ok(t.light && t.dark_auto && t.dark_manual);
  assert.deepEqual(Object.keys(t.light).sort(), Object.keys(t.dark_auto).sort(), 'светлая и тёмная темы задают одни и те же токены');
  assert.deepEqual(t.dark_auto, t.dark_manual, 'системная тёмная тема = ручная');
  for (const need of ['bg', 'surface', 'surface-2', 'text', 'muted', 'border', 'control-border', 'accent', 'accent-text', 'plan', 'worse', 'buffer', 'wave', 'focus', 'ok', 'ok-bg', 'fragile', 'fragile-bg', 'tight', 'tight-bg', 'no', 'no-bg', 'banner-bg']) assert.ok(need in t.light, '--' + need);
  const r = CT.check(CSS, OTHER.map((o) => o.text));
  assert.deepEqual(r.problems, []);
  assert.equal(r.consistent, true);
  for (const theme of ['light', 'dark']) {
    assert.equal(r.themes[theme].length, CT.PAIRS.length, theme + ': проверены все пары');
    const enforced = r.themes[theme].filter((p) => p.min !== null);
    assert.ok(enforced.length >= 30 && enforced.every((p) => p.ok && p.ratio >= p.min), theme);
    const text = r.themes[theme].filter((p) => p.kind === 'text');
    assert.ok(text.length >= 24 && text.every((p) => p.ratio >= 4.5), theme + ': текст ≥ 4,5:1');
    assert.ok(r.themes[theme].filter((p) => p.kind === 'ui').every((p) => p.ratio >= 3), theme + ': граница поля ввода ≥ 3:1');
  }
  // известные числа (пересчитаны вручную по формуле WCAG)
  const get = (theme, fg, bg) => r.themes[theme].find((p) => p.fg === fg && p.bg === bg).ratio;
  assert.equal(get('light', 'text', 'surface'), 15.93);
  assert.equal(get('light', 'muted', 'surface-2'), 5.5);
  assert.equal(get('dark', 'accent-text', 'accent'), 8.52);
  assert.equal(get('light', 'border', 'surface'), 1.51, 'разделитель --border справочно: 1,51:1, смысла не несёт');
});

test('REQ-166 покрытие: каждая пара «color + background» из правил style.css и css/*.css есть в списке пар; каждый var(--токен) определён; цвета вне токенов — только подложка диалога', () => {
  const t = CT.theme_tokens(CSS);
  const known = new Set(CT.PAIRS.filter((p) => p.kind === 'text').map((p) => p.fg + '|' + p.bg));
  const uses = new Set();
  const uncovered = [];
  for (const file of [{ name: 'style.css', text: CSS }, ...OTHER]) {
    for (const rule of CT.parse_rules(file.text)) {
      for (const m of Object.values(rule.decls).join(' ').matchAll(/var\(--([a-z0-9-]+)\)/g)) uses.add(m[1]);
      const fg = /^var\(--([a-z0-9-]+)\)$/.exec(rule.decls.color ?? '')?.[1];
      const bg = /^var\(--([a-z0-9-]+)\)$/.exec(rule.decls.background ?? rule.decls['background-color'] ?? '')?.[1];
      if (fg !== undefined && bg !== undefined && !known.has(fg + '|' + bg)) uncovered.push(`${file.name}: «${rule.selector}» ${fg} на ${bg}`);
    }
  }
  assert.deepEqual(uncovered, []);
  for (const u of uses) assert.ok(u in t.light || u === 'nav-gap', 'токен --' + u + ' используется, но не определён');
  // цветовые литералы вне токенов: только dialog::backdrop
  for (const file of [{ name: 'style.css', text: CSS }, ...OTHER]) {
    for (const rule of CT.parse_rules(file.text)) {
      if (rule.selector.startsWith(':root')) continue;
      for (const [prop, value] of Object.entries(rule.decls)) assert.ok(!(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(value) && rule.selector !== 'dialog::backdrop'), `${file.name} «${rule.selector}» ${prop}: ${value}`);
    }
  }
});

test('REQ-166 чувствительность проверки: порча токена в светлой или тёмной теме, пропавший токен, расхождение двух тёмных блоков и свой цвет в css пакета дают нарушение с названием пары', () => {
  const bad = (from, to) => { assert.ok(CSS.includes(from), from); return CSS.replace(from, to); }; // первое вхождение: для тёмной темы это блок по предпочтению системы
  const light_muted = bad('--muted: #566176;', '--muted: #9aa3b2;');
  const r1 = CT.check(light_muted);
  assert.ok(r1.problems.some((p) => p.startsWith('light: muted на bg')), r1.problems.join('\n'));
  const dark_text = bad('--text: #e8ecf3;', '--text: #5a6272;');
  const r2 = CT.check(dark_text);
  assert.ok(r2.problems.some((p) => p.startsWith('dark: text на bg')), r2.problems.join('\n'));
  assert.equal(r2.consistent, false, 'системная и ручная тёмные темы разошлись');
  const no_ctl = CSS.replace(/ *--control-border:[^\n]*\n/g, '');
  const r3 = CT.check(no_ctl);
  assert.ok(r3.problems.some((p) => p.startsWith('light: нет цвета для пары control-border / surface')), r3.problems.join('\n'));
  const one_block = CSS.replace('--control-border: #6c7688;\n  --accent: #7fb0ff;', '--accent: #7fb0ff;'); // убран только из ручной тёмной темы
  assert.ok(one_block !== CSS && CT.check(one_block).problems.some((p) => p.includes('--control-border не задан в блоке «dark_manual»')), CT.check(one_block).problems.join('\n'));
  const weak_ctl = bad('--control-border: #7f899a;', '--control-border: #ccd3de;');
  assert.ok(CT.check(weak_ctl).problems.some((p) => p.startsWith('light: control-border на surface')));
  const r4 = CT.check(CSS, ['.x { color: #ff0000; background: var(--bg); }']);
  assert.ok(r4.problems.some((p) => p.includes('«.x» задаёт цвет не токеном')), r4.problems.join('\n'));
  assert.deepEqual(CT.check(CSS, ['dialog::backdrop { background: rgba(10, 14, 22, 0.6); }']).problems, []);
  assert.ok(CT.check('body { color: red; }').problems.length > 0, 'без блоков токенов проверка не проходит молча');
});

test('REQ-166 командная строка: на рабочих стилях код 0 и таблица двух тем; на файле с плохим токеном код 1 и строка ОШИБКА; --json отдаёт обе темы', () => {
  const tool = path.join(PROTO, 'tools', 'contrast.mjs');
  const ok = spawnSync(process.execPath, [tool], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /светлая тема/);
  assert.match(ok.stdout, /тёмная тема/);
  assert.match(ok.stdout, /все обязательные пары выше порога WCAG 2\.2 AA в обеих темах/);
  const j = JSON.parse(spawnSync(process.execPath, [tool, '--json'], { encoding: 'utf8' }).stdout);
  assert.deepEqual(Object.keys(j.themes), ['light', 'dark']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-contrast-'));
  try {
    const file = path.join(dir, 'bad.css');
    fs.writeFileSync(file, CSS.replace('--muted: #566176;', '--muted: #9aa3b2;'));
    const bad = spawnSync(process.execPath, [tool, '--css', file], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /ОШИБКА light: muted на bg/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── клавиатурный обход на заглушке DOM (REQ-167, часть) ────────────────────────────────────────────────────────────────────

/** Имя элемента управления: текст, aria-label / aria-labelledby, подпись `label[for]` или `label`, внутри которого он лежит. */
function accessible_name(root, el) {
  const txt = (n) => String(n.textContent).replace(/\s+/g, ' ').trim();
  if ((el.attrs['aria-label'] ?? '').trim() !== '') return el.attrs['aria-label'];
  if (el.attrs['aria-labelledby'] !== undefined) {
    const t = el.attrs['aria-labelledby'].split(/\s+/).map((id) => find_all(root, (n) => n.attrs.id === id)[0]).filter(Boolean).map(txt).join(' ').trim();
    if (t !== '') return t;
  }
  if (el.tagName === 'button' || el.tagName === 'a') { if (txt(el) !== '') return txt(el); }
  if ((el.attrs.title ?? '').trim() !== '') return el.attrs.title;
  if (el.attrs.id !== undefined) {
    const lab = find_all(root, (n) => n.tagName === 'label' && n.attrs.for === el.attrs.id)[0];
    if (lab !== undefined && txt(lab) !== '') return txt(lab);
  }
  for (const lab of find_all(root, (n) => n.tagName === 'label')) {
    if (find_all(lab, (n) => n === el).length > 0 && txt(lab) !== '') return txt(lab);
  }
  return '';
}

test('REQ-167 клавиатурный обход (проверка по структуре страницы): на каждом экране и на обоих языках у кнопок, ссылок, полей и списков есть доступное имя, положительного tabindex нет, обработчики не висят на неинтерактивных узлах', async () => {
  const hrefs = find_all(byid.get('nav'), (n) => n.tagName === 'a').map((n) => n.attrs.href);
  assert.ok(hrefs.length >= 20);
  const findings = [];
  const EN = find_all(byid.get('controls'), (n) => n.tagName === 'button' && n.attrs.lang === 'en')[0];
  const RU = find_all(byid.get('controls'), (n) => n.tagName === 'button' && n.attrs.lang === 'ru')[0];
  let controls_seen = 0;
  for (const [lang, btn] of [['ru', RU], ['en', EN]]) {
    btn.listeners.click[0]();
    for (const h of hrefs) {
      await go(h);
      const page = new Node_('div');
      page.children = [byid.get('nav'), byid.get('main'), byid.get('controls')];
      for (const n of find_all(page, () => true)) {
        if (n.attrs.tabindex !== undefined && Number(n.attrs.tabindex) > 0) findings.push(`${lang} ${h}: положительный tabindex у <${n.tagName}>`);
        const interactive = ['button', 'a', 'input', 'select', 'textarea'].includes(n.tagName) && n.attrs.type !== 'hidden';
        if (interactive) {
          controls_seen += 1;
          if (n.tagName === 'a' && n.attrs.href === undefined) findings.push(`${lang} ${h}: <a> без href`);
          if (accessible_name(page, n) === '') findings.push(`${lang} ${h}: <${n.tagName}${n.attrs.id ? ' #' + n.attrs.id : ''}${n.attrs.type ? ' type=' + n.attrs.type : ''}> без доступного имени`);
        }
        if (['div', 'span', 'p', 'li', 'td', 'tr', 'th', 'svg', 'path', 'rect', 'circle', 'img', 'code', 'pre'].includes(n.tagName) && (n.listeners.click ?? []).length > 0 && n.attrs.role === undefined && n.attrs.tabindex === undefined) findings.push(`${lang} ${h}: обработчик клика на <${n.tagName}> без роли и tabindex`);
      }
    }
  }
  RU.listeners.click[0]();
  await go('#overview');
  assert.ok(controls_seen > 300, 'проверено элементов управления: ' + controls_seen);
  assert.deepEqual(findings, [], findings.slice(0, 20).join('\n'));
  assert.ok(ext.nav_items !== undefined);
});

// ── исправление ADV-06: сквозная проверка текста на всех фонах страницы ───────────────────────────────────────────────────

test('REQ-166 исправление ADV-06: цвет текста из каждого правила CSS читается ≥ 4,5:1 на своём фоне или на каждом из четырёх фонов страницы в обеих темах; --wave на подложке surface-2 больше не 4,46:1', () => {
  const t = CT.theme_tokens(CSS);
  const r = CT.check_text_grounds([CSS, ...OTHER.map((o) => o.text)], t);
  assert.deepEqual(r.problems, []);
  assert.ok(r.checked > 150, 'проверено сочетаний: ' + r.checked);
  assert.deepEqual(CT.PAGE_GROUNDS, ['bg', 'surface', 'surface-2', 'banner-bg']);
  assert.ok(CT.PAIRS.some((p) => p.fg === 'wave' && p.bg === 'surface-2' && p.kind === 'text'), 'пара wave / surface-2 есть в списке');
  for (const g of CT.PAGE_GROUNDS) assert.ok(CT.contrast_ratio(t.light.wave, t.light[g]) >= 4.5, 'светлая тема: wave на ' + g);
  for (const g of CT.PAGE_GROUNDS) assert.ok(CT.contrast_ratio(t.dark_auto.wave, t.dark_auto[g]) >= 4.5, 'тёмная тема: wave на ' + g);
  assert.equal(CT.check(CSS, OTHER.map((o) => o.text)).problems.length, 0, 'check() включает сквозную проверку и остаётся зелёной');
  // прежнее значение --wave (4,46:1 на подложке) теперь ловится и списком пар, и сквозной проверкой, и командной строкой
  const old = CSS.replace('--wave: #7556bf;', '--wave: #7a5cc4;');
  assert.notEqual(old, CSS);
  const bad = CT.check(old, OTHER.map((o) => o.text));
  assert.ok(bad.problems.some((p) => p.startsWith('light: wave на surface-2')), bad.problems.join('\n'));
  assert.ok(bad.problems.some((p) => p.startsWith('light: текст --wave на фоне --surface-2') && p.includes('4.46:1')), bad.problems.join('\n'));
  assert.ok(CT.check_text_grounds(OTHER.map((o) => o.text), CT.theme_tokens(old)).problems.some((p) => p.includes('.sc-ai')), 'и в правиле .sc-ai из css/showcase.css');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-contrast-grounds-'));
  try {
    const file = path.join(dir, 'old_wave.css');
    fs.writeFileSync(file, old);
    const cli = spawnSync(process.execPath, [path.join(PROTO, 'tools', 'contrast.mjs'), '--css', file], { encoding: 'utf8' });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /ОШИБКА light: текст --wave на фоне --surface-2/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('REQ-166 check_text_grounds: свой фон правила заменяет перебор фонов страницы; отключённые элементы и подложка диалога пропускаются; неизвестный токен не падает; порог 4,5:1 точный', () => {
  const g = { bg: '#ffffff', surface: '#ffffff', 'surface-2': '#ffffff', 'banner-bg': '#ffffff', dark: '#000000' };
  const toks = { light: { ...g, ok: '#767676', weak: '#777777' }, dark_auto: { ...g, ok: '#767676', weak: '#777777' } };
  const run = (css) => CT.check_text_grounds([css], toks);
  assert.deepEqual(run('.a { color: var(--ok); }'), { problems: [], checked: 8 }, '4 фона × 2 темы');
  const weak = run('.a { color: var(--weak); }');
  assert.equal(weak.problems.length, 8);
  assert.match(weak.problems[0], /^light: текст --weak на фоне --bg — 4\.48:1, нужно не меньше 4\.5:1 \(css #0, «\.a»\)$/);
  assert.equal(run('.b { color: var(--weak); background: var(--bg); }').problems.length, 2, 'свой фон: одна пара на тему');
  assert.equal(run('.b { color: var(--weak); background: var(--dark); }').problems.length, 0, 'на своём тёмном фоне читается');
  assert.deepEqual(run('.c:disabled { color: var(--weak); } .c[disabled] { color: var(--weak); } dialog::backdrop { color: var(--weak); }'), { problems: [], checked: 0 });
  assert.deepEqual(run('.d { color: var(--nope); } .e { color: var(--ok); background: var(--nope); } .f { color: #777777; }'), { problems: [], checked: 0 });
  assert.equal(run('@media (min-width: 800px) { .m { color: var(--weak); } }').problems.length, 8, 'правила внутри @media тоже проверяются');
});
