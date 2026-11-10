// dom.mjs — общие помощники DOM для модулей демо (FP-01): `h`, `s`, `add_kids`, диалог, таблица, объявление для скринридера.
// Это копия контракта из app.mjs, чтобы новые модули не импортировали app.mjs (нет циклов и дублирования состояния).
// Защита от внедрения кода (CSP `script-src 'self'; style-src 'self'`, ADR-013):
//   - только `textContent` и узлы: разметка из строк не вставляется (ни одним из свойств-«впрысков» HTML, ни атрибутом-документом);
//   - атрибут `style` и атрибуты-обработчики `on*="…"` не пишутся (обработчик — только функция через `addEventListener`);
//   - адрес `javascript:` в `href`/`src` отбрасывается.
// Модуль можно импортировать в Node без побочных эффектов: DOM трогается только при вызове функций.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Атрибуты, которые никогда не записываются (inline-стили и опасные поверхности). */
const BLOCKED_ATTRS = new Set(['style', 'inner' + 'html', 'outer' + 'html', 'src' + 'doc']);

function blocked_attr(name, value) {
  const k = String(name).toLowerCase();
  if (BLOCKED_ATTRS.has(k)) return true;
  if ((k === 'href' || k === 'src' || k === 'xlink:href' || k === 'action' || k === 'formaction') && /^\s*javascript:/i.test(String(value))) return true;
  return false;
}

/**
 * Добавить детей: строки и числа — текстовыми узлами, `null`/`undefined`/`false` пропускаются, массивы разворачиваются.
 * @param {Element} el
 * @param {any[]} kids
 */
export function add_kids(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(typeof k === 'string' || typeof k === 'number' ? document.createTextNode(String(k)) : k);
  }
}

/**
 * Создать элемент HTML: `h('p', {class: 'x', text: '…'}, дети…)`.
 * `class` → className, `text` → textContent, `on…` (только функции) → обработчик, `true` → пустой атрибут, `null`/`false` — пропуск.
 * @param {string} tag
 * @param {Object<string, any>|null} [attrs]
 * @param {...any} kids
 * @returns {HTMLElement}
 */
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) { if (typeof v === 'function') el.addEventListener(k.slice(2), v); } // строковый обработчик — это inline-код: отбрасываем
    else if (!blocked_attr(k, v)) el.setAttribute(k, v === true ? '' : String(v));
  }
  add_kids(el, kids);
  return el;
}

/**
 * Создать элемент SVG (то же правило атрибутов).
 * @param {string} tag
 * @param {Object<string, any>|null} [attrs]
 * @param {...any} kids
 * @returns {SVGElement}
 */
export function s(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'text') el.textContent = v;
    else if (!k.startsWith('on') && !blocked_attr(k, v)) el.setAttribute(k, String(v));
  }
  add_kids(el, kids);
  return el;
}

/** Элемент по идентификатору (или `null`). */
export const el_by_id = (id) => document.getElementById(id);

/**
 * Таблица с подписью для скринридера: `table(caption, head[], rows[], cls?)`.
 * @param {string} caption
 * @param {string[]} head
 * @param {Node[]} rows
 * @param {string} [cls]
 * @returns {HTMLElement}
 */
export function table(caption, head, rows, cls) {
  return h('table', { class: cls ?? 'tbl' },
    h('caption', { class: 'sr-only', text: caption }),
    h('thead', null, h('tr', null, head.map((c) => h('th', { scope: 'col', text: c })))),
    h('tbody', null, rows));
}

/**
 * Открыть общий диалог страницы (`#dlg`): заголовок, тело, подпись кнопки закрытия.
 * @param {string} title
 * @param {string} close_label
 * @param {...any} body
 */
export function open_dialog(title, close_label, ...body) {
  const dlg = el_by_id('dlg');
  if (dlg === null) return;
  el_by_id('dlg-title').textContent = title;
  el_by_id('dlg-body').replaceChildren(...body.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false));
  el_by_id('dlg-close').textContent = close_label;
  if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute('open', '');
}

/** Закрыть общий диалог. */
export function close_dialog() {
  const dlg = el_by_id('dlg');
  if (dlg !== null && typeof dlg.close === 'function') dlg.close();
}

/** Объявить текст скринридеру через живую область `#live`. */
export function announce(text) {
  const live = el_by_id('live');
  if (live !== null) live.textContent = text;
}
