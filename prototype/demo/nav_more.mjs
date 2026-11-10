// nav_more.mjs — группа «Ещё» в навигации на телефоне (FP-26, U22): первые разделы остаются вкладками нижней панели, остальные собираются в раскрывающийся список
// (`<details>`: клавиатура и скринридер работают штатно). Чистый DOM и строки: расчёт и данные не затронуты. Правила группы (`.nav-grouped`, `.nav-more`) лежат в `style.css`
// (блок `@media (max-width: 599px)`), а не в `css/layout.css`: css пакетов раскладку навигации не меняет (guard `tests/s1_4_adv.test.mjs`).
//
// Правила, которые держит модуль:
//   - порядок в DOM = видимый порядок = порядок Tab (WCAG 2.4.3): вкладки, затем «Ещё» (и его список, пока он раскрыт), затем действия; CSS ничего не переставляет;
//   - группировка включается только в окне ≤ 599 px (`PHONE_QUERY`) и только если окно умеет `matchMedia`; на других ширинах и в заглушках DOM списки остаются прежними,
//     то есть ровно такими, как их построило приложение (два списка `ul.nav-sections` и `ul.nav-actions`, S1.4);
//   - состояние «раскрыто» живёт здесь, потому что страница перерисовывает навигацию целиком (в том числе поздней перерисовкой от хранилища, FP-05): без этого список
//     захлопывался бы под рукой. Нажатие на любой раздел закрывает список;
//   - фокус: перерисовка заменяет узлы, и фокус падает на body — вкладки, «Ещё» и ссылки списка просят хранитель фокуса (`focus_keep.mjs`), приложение зовёт `nav_keep_focus()`
//     в конце отрисовки; чужой фокус хранитель не отбирает. Тот же хранитель обслуживает действия оболочки, которые убирают нажатую кнопку («Вернуться к базе» в плашке
//     сценария, «Убрать» в сравнении): они просят фокус через `keep_focus_after_render(id)`;
//   - нажатие на ссылку списка закрывает сам `<details>` (а не только флаг модуля), даже если раздел уже открыт и перерисовки не будет, и возвращает фокус на «Ещё»
//     (свёрнутый список не может держать фокус); Escape закрывает список по состоянию узла, а не по флагу — они не расходятся.
// Модуль можно импортировать в Node без побочных эффектов.

import { h, el_by_id } from './dom.mjs';
import { create_focus_keeper } from './focus_keep.mjs';
import { clock_ports } from './ids.mjs';

/** Окно телефона: то же условие, что у нижней панели в `style.css`. */
export const PHONE_QUERY = '(max-width: 599px)';

/** Разделы-вкладки на телефоне (U22: Обзор · Купить · Лента · Волны); если какого-то нет в реестре, он пропускается. */
export const PRIMARY_VIEWS = Object.freeze(['overview', 'buy', 'feed', 'waves']);

/** Идентификатор кнопки «Ещё» (для хранителя фокуса и тестов). */
export const MORE_ID = 'nav-more-sum';

let more_open = false;
const keeper = create_focus_keeper(clock_ports().now_ms);

/** Окно сейчас узкое (телефон)? Без `matchMedia` (заглушки DOM, старые окна) — нет. */
export function is_phone() {
  const w = globalThis.window ?? globalThis;
  if (typeof w.matchMedia !== 'function') return false;
  try { return w.matchMedia(PHONE_QUERY).matches === true; } catch { return false; }
}

/** Подписка на пересечение границы окна телефона: `on_change()` зовётся при смене узкого окна на широкое и обратно. Возвращает отписку (пустую, если подписаться нельзя). */
export function watch_phone(on_change) {
  const w = globalThis.window ?? globalThis;
  if (typeof w.matchMedia !== 'function') return () => {};
  try {
    const mq = w.matchMedia(PHONE_QUERY);
    if (typeof mq?.addEventListener === 'function') {
      mq.addEventListener('change', on_change);
      return () => mq.removeEventListener?.('change', on_change);
    }
    if (typeof mq?.addListener === 'function') { // окна без addEventListener у MediaQueryList
      mq.addListener(on_change);
      return () => mq.removeListener?.(on_change);
    }
    return () => {};
  } catch { return () => {}; }
}

/** Состояние «раскрыто» (для тестов и сброса при смене набора). */
export function more_state() { return { open: more_open }; }
export function reset_more() { more_open = false; keeper.clear(); }

const view_of = (li) => {
  const a = li?.children?.[0];
  const href = a !== undefined && typeof a.getAttribute === 'function' ? a.getAttribute('href') : null;
  return typeof href === 'string' && href.startsWith('#') ? href.slice(1) : '';
};

const set_class = (el, name, on) => {
  const has = new RegExp('(^|\\s)' + name + '(\\s|$)').test(el.className ?? '');
  if (on && !has) el.className = ((el.className ?? '') + ' ' + name).trim();
  if (!on && has) el.className = (el.className ?? '').replace(new RegExp('(^|\\s)' + name + '(?=\\s|$)', 'g'), '').trim();
};

/**
 * Собрать содержимое навигации. Принимает списки, которые построило приложение (`[ul.nav-sections, ul.nav-actions?]`), и возвращает узлы для `nav.replaceChildren`.
 * На телефоне: вкладки (`PRIMARY_VIEWS`) в `ul.nav-sections.nav-primary`, затем `details.nav-more` («Ещё» и список остальных разделов в порядке реестра), затем действия;
 * у `#nav` ставится класс `nav-grouped`. Иначе — списки без изменений (класс снимается).
 * @param {HTMLElement} nav узел `#nav`
 * @param {HTMLElement[]} lists
 * @param {(key: string) => string} tr
 * @param {string} current идентификатор текущего раздела
 * @returns {HTMLElement[]}
 */
export function group_nav(nav, lists, tr, current) {
  const sections = lists[0];
  const items = sections !== undefined ? [...sections.children] : [];
  const primary = PRIMARY_VIEWS.map((id) => items.find((li) => view_of(li) === id)).filter((li) => li !== undefined);
  const rest = items.filter((li) => !primary.includes(li));
  if (!is_phone() || primary.length === 0 || rest.length === 0) {
    set_class(nav, 'nav-grouped', false);
    return lists;
  }
  set_class(nav, 'nav-grouped', true);
  let details = null;
  let summary = null;
  /**
   * Закрыть список: и флаг модуля, и сам узел (раздел мог быть уже открыт — тогда перерисовки не будет и узел остался бы раскрытым).
   * `refocus` — нажатие было на ссылке внутри списка: свёрнутый список не держит фокус, он уходит на «Ещё». Нажатие на вкладку фокус не трогает.
   */
  const close = (refocus) => {
    more_open = false;
    if (details !== null && details.open === true) {
      details.open = false;
      if (refocus === true && typeof summary.focus === 'function') summary.focus();
    }
  };
  const tag = (li) => {
    const a = li.children[0];
    const id = 'nav-a-' + view_of(li);
    a.setAttribute('id', id);
    a.addEventListener('focus', () => keeper.request(id));
    return li;
  };
  const has_current = rest.some((li) => view_of(li) === current);
  summary = h('summary', { id: MORE_ID, class: 'nav-more-sum', text: tr('nav.more') });
  summary.addEventListener('focus', () => keeper.request(MORE_ID));
  details = h('details', { class: 'nav-more' + (has_current ? ' has-current' : ''), open: more_open ? true : null }, summary,
    h('ul', { class: 'nav-more-list', 'aria-label': tr('nav.more_list'), onclick: () => close(true) }, rest.map(tag)));
  details.addEventListener('toggle', () => { more_open = details.open === true; });
  details.addEventListener('keydown', (ev) => { // Escape закрывает список и возвращает фокус на «Ещё»; смотрим на узел, а не на флаг модуля
    if (ev?.key === 'Escape' && (details.open === true || more_open)) { more_open = false; details.open = false; summary.focus(); }
  });
  const primary_list = h('ul', { class: 'nav-sections nav-primary', 'aria-label': tr('nav.list_sections'), onclick: () => close(false) }, primary.map(tag));
  return [primary_list, details, ...lists.slice(1)];
}

/** Вернуть фокус на вкладку или «Ещё», если перерисовка уронила его на body (звать в конце отрисовки страницы). */
export function nav_keep_focus() {
  keeper.apply();
}

/**
 * Попросить хранитель фокуса вернуть фокус на узел `id` после перерисовки, если действие убирает или заменяет нажатую кнопку (урок 10: фокус падает на body).
 * Если узла с таким `id` на странице больше нет (кнопка исчезла совсем), фокус получает заголовок экрана `view-title`. Чужой фокус хранитель не отбирает.
 * @param {string} id
 */
export function keep_focus_after_render(id) {
  keeper.request(id);
}

/** Для тестов: узел кнопки «Ещё» в текущей навигации. */
export const more_button = () => el_by_id(MORE_ID);
