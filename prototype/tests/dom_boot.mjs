// dom_boot.mjs — общая оснастка тестов FP-26 (a11y_static, empty_states, scenario_banner, nav_more): заглушка DOM с родителями узлов, `matchMedia` с переключаемой шириной
// окна и запуск настоящего app.mjs. Это не тест (имя без .test): `node --test tests/<файл>.test.mjs` его только импортирует. Браузер, сеть и серверы не запускаются;
// набор данных читается из data/ файловой функцией fetch. Один процесс node — один вызов `boot_app` (глобальные заглушки ставятся один раз).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEMO = path.join(HERE, '..', 'demo');

const has_class = (n, name) => ((n.className ?? '') + ' ' + (n.attrs?.class ?? '')).split(/\s+/).includes(name); // у узлов SVG класс лежит в атрибуте

export class Node_ {
  constructor(tag, ns) {
    this.nodeType = 1; this.tagName = tag; this.ns = ns ?? null; this.attrs = {}; this.children = []; this.listeners = {}; this.className = '';
    this._text = ''; this._value = ''; this._sel = null; this.open = false; this.parent = null; this.focused = false;
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
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this._value = String(v); if (k === 'open') this.open = true; }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return Object.hasOwn(this.attrs, k); }
  append(...kids) { for (const k of kids) { if (k.nodeType === 1) k.parent = this; this.children.push(k); } this._text = ''; }
  replaceChildren(...kids) {
    // как в браузере: убранный из страницы узел не может держать фокус, он падает на body (включается `api.emulate_focus_loss(true)`; по умолчанию заглушка фокус не трогает)
    if (Node_.drop_focus_on_removal === true) {
      const active = globalThis.document?.activeElement;
      let inside = false;
      if (active !== undefined && active !== null && active !== this) this.walk((n) => { if (n === active) inside = true; });
      if (inside) globalThis.document.activeElement = globalThis.document.body;
    }
    this.children = []; this._text = ''; this.append(...kids);
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter((x) => x !== fn); }
  focus() { this.focused = true; globalThis.document.activeElement = this; }
  click() { this.clicked = (this.clicked ?? 0) + 1; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() {}
  querySelectorAll() { return []; }
  /** Простой селектор из классов: `.a` или `.a.b` (достаточно для кода графика). */
  querySelector(sel) {
    const need = sel.split('.').filter((x) => x !== '');
    let hit = null;
    this.walk((n) => { if (hit === null && n !== this && need.every((c) => has_class(n, c))) hit = n; });
    return hit;
  }
  walk(fn) { fn(this); for (const c of this.children) if (c.nodeType === 1) c.walk(fn); }
}

Node_.drop_focus_on_removal = false;

export const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };

/** Цепочка предков узла от ближайшего к корню. */
export const ancestors_of = (n) => { const out = []; for (let p = n.parent; p !== null && p !== undefined; p = p.parent) out.push(p); return out; };

/** Текст без неразрывных и узких пробелов (числа в приложении записаны с NBSP). */
export const N = (x) => String(x).replace(/[  ]/g, ' ');

/**
 * Запустить настоящий app.mjs на заглушке DOM.
 * @param {{phone?: boolean, raf?: boolean, hold_fetch?: boolean}} [opts] `phone` — начальная ширина окна (≤ 599 px), `raf` — выполнять requestAnimationFrame (график рисуется),
 * `hold_fetch` — чтение набора данных ждёт `api.release()`: пока оно ждёт, страница в состоянии «загрузка» (скелет, `aria-busy`)
 */
export async function boot_app(opts = {}) {
  const byid = new Map();
  for (const id of ['app-title', 'app-sub', 'skip', 'controls', 'nav', 'summary', 'main', 'footer', 'live', 'dlg', 'dlg-title', 'dlg-close', 'dlg-body']) byid.set(id, new Node_(id === 'dlg' ? 'dialog' : 'div'));
  byid.get('nav').className = 'nav';
  const listeners = {};
  const body = new Node_('body');
  const media = { phone: opts.phone === true, subs: [] };
  globalThis.document = {
    createElement: (t) => new Node_(t),
    createElementNS: (ns, t) => new Node_(t, ns),
    createTextNode: (data) => ({ nodeType: 3, data }),
    // статические узлы страницы и (для фокуса и якорей) любой узел, который сейчас нарисован в #main, #nav и #summary
    getElementById: (id) => byid.get(id) ?? [byid.get('main'), byid.get('nav'), byid.get('summary')].map((r) => find_all(r, (n) => n.attrs.id === id)[0]).find((x) => x !== undefined) ?? null,
    documentElement: new Node_('html'),
    head: new Node_('head'),
    body,
    activeElement: body,
    title: '',
  };
  globalThis.window = {
    addEventListener: (t, fn) => { (listeners[t] ??= []).push(fn); },
    scrollTo: () => {},
    matchMedia: (q) => ({
      media: q,
      get matches() { return media.phone && /max-width:\s*599px/.test(q); },
      addEventListener: (type, fn) => { if (type === 'change') media.subs.push(fn); },
      removeEventListener: (type, fn) => { media.subs = media.subs.filter((x) => x !== fn); },
    }),
  };
  globalThis.location = { hash: '' };
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'ru-RU' }, configurable: true });
  const store = new Map();
  globalThis.localStorage = {
    get length() { return store.size; },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  globalThis.requestAnimationFrame = opts.raf === true ? (fn) => { Promise.resolve().then(() => fn(0)); return 1; } : () => 0;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.ResizeObserver = class { observe() {} };
  let release = () => {};
  const gate = opts.hold_fetch === true ? new Promise((r) => { release = r; }) : null;
  globalThis.fetch = async (url) => {
    if (gate !== null) await gate;
    return { ok: true, json: async () => JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8')) };
  };

  const { ext } = await import(pathToFileURL(path.join(DEMO, 'ext.mjs')).href);
  const I18N = await import(pathToFileURL(path.join(DEMO, 'i18n.mjs')).href);
  await import(pathToFileURL(path.join(DEMO, 'app.mjs')).href); // в #app-title есть узел: boot() запускается сам
  await new Promise((r) => setTimeout(r, opts.hold_fetch === true ? 300 : 700)); // пакеты, набор данных, boot-хук

  const tick = () => new Promise((r) => setImmediate(r));
  const api = {
    byid, listeners, ext, I18N, store, media, tick,
    /** Отпустить чтение набора данных (только при `hold_fetch`) и дождаться окончания загрузки. */
    release: async () => { release(); await new Promise((r) => setTimeout(r, 500)); },
    main: () => byid.get('main'),
    nav: () => byid.get('nav'),
    summary: () => byid.get('summary'),
    controls: () => byid.get('controls'),
    text_of: (id) => N(byid.get(id).textContent),
    click: (n) => n.listeners.click[0]({ preventDefault() {}, target: n }),
    by_id: (id) => find_all(byid.get('main'), (n) => n.attrs.id === id)[0],
    go: async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await tick(); },
    set_lang: (lang) => { find_all(byid.get('controls'), (n) => n.tagName === 'button' && n.attrs.lang === lang)[0].listeners.click[0](); },
    choose_dataset: async (id) => {
      const select = find_all(byid.get('controls'), (n) => n.tagName === 'select' && n.attrs.id === 'ds-top')[0];
      await select.listeners.change[0]({ target: { value: id } });
      await tick();
    },
    /** Включить (true) или выключить повадку браузера: узел, убранный перерисовкой, роняет фокус на body. */
    emulate_focus_loss: (on) => { Node_.drop_focus_on_removal = on === true; },
    /** Сменить ширину окна: `true` — телефон. Подписчики `change` (пакет FP-26) вызываются, как это делает браузер. */
    set_phone: async (on) => { media.phone = on; for (const fn of [...media.subs]) fn({ matches: on }); await tick(); },
  };
  return api;
}
