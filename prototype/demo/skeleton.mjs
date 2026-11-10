// skeleton.mjs — скелет загрузки (FP-26, U40): пока набор данных читается и считается, экран показывает серые блоки на месте карточек, а не пустую страницу.
// Скелет — украшение: блоки скрыты от скринридера (`aria-hidden`), а о ходе загрузки сообщают видимая строка со статусом и атрибут `aria-busy` на `#main`.
// Движение (мерцание) отключается общим правилом `prefers-reduced-motion` в `style.css`. Только DOM и строка от вызывающего: данных и расчёта нет.
// Модуль можно импортировать в Node без побочных эффектов.

import { h } from './dom.mjs';

/** Сколько серых блоков рисовать (карточка узкой точки, «Хватит ли к…», график). */
export const SKELETON_BLOCKS = 3;

/**
 * Узлы экрана загрузки: строка статуса (`role="status"`, видимая) и блоки скелета (`aria-hidden`).
 * @param {string} label текст статуса («Загрузка набора данных…»)
 * @returns {HTMLElement[]}
 */
export function skeleton_nodes(label) {
  const blocks = [];
  for (let i = 0; i < SKELETON_BLOCKS; i += 1) blocks.push(h('div', { class: 'sk-block' + (i === SKELETON_BLOCKS - 1 ? ' sk-chart' : '') }));
  return [h('p', { class: 'lead', role: 'status', text: label }), h('div', { class: 'skeleton', 'aria-hidden': 'true' }, blocks)];
}

/**
 * Пометить область занятой (`aria-busy="true"`) или снять отметку. Не трогает ничего, кроме этого атрибута.
 * @param {HTMLElement} el
 * @param {boolean} busy
 */
export function mark_busy(el, busy) {
  if (busy) el.setAttribute('aria-busy', 'true');
  else el.removeAttribute('aria-busy');
}
