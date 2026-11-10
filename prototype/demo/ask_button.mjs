// ask_button.mjs — кнопка «Спросить ассистента» для карточек пакетов (FP-28, U13): заготовка вопроса попадает в поле «Ассистента», сам вопрос не отправляется.
// Страница открывает экран через `ctx.ask(вопрос)`; текст заготовки берётся из каталога приложения (`ask.q_*`), поэтому на русском и английском вопрос понятен разбору A0.
// Подпись для скринридера называет тему карточки. Узлы строит dom.mjs (текст — textContent).

import { h } from './dom.mjs';

/**
 * @param {object} ctx контекст расширений
 * @param {string} question заготовка вопроса (уже на языке интерфейса)
 * @param {string} topic тема карточки для подписи скринридера
 * @returns {HTMLElement}
 */
export function ask_button(ctx, question, topic) {
  return h('button', { type: 'button', class: 'link', 'aria-label': ctx.tr('c.ask_for', { topic }), onclick: () => { ctx.ask(question); }, text: ctx.tr('c.ask') });
}
