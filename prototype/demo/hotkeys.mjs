// hotkeys.mjs — переходы с клавиатуры (IDEA-92-смежное, доступность TST-58): «g» и затем буква — перейти на экран; «?» — список клавиш.
// Клавиши разбираются по физическому коду (`KeyG`, `KeyO`…), поэтому работают и в русской раскладке. Не срабатывают в полях ввода, при зажатых Ctrl / Alt / Cmd,
// при открытом диалоге и на повторе удержанной клавиши. Переход — через `location.hash` (его ведёт приложение), после перехода приложение переводит фокус на заголовок экрана.
// Чистая часть: `hotkey_step(state, ev)` (без DOM и часов: время — `ev.timeStamp`); DOM-часть: `install_hotkeys`, `open_hotkeys_help`, кнопка в навигации.

import { h, table, open_dialog, announce, el_by_id } from './dom.mjs';

/** Сколько мс после «g» ждём вторую клавишу. */
export const CHORD_WINDOW_MS = 1500;

/** Таблица переходов: физическая клавиша → экран и ключ подписи. Подпись экранов приложения — из каталога приложения, пакетов — из их каталогов. */
export const HOTKEYS = Object.freeze([
  Object.freeze({ code: 'KeyO', letter: 'O', view: 'overview', title_key: 'nav.overview' }),
  Object.freeze({ code: 'KeyB', letter: 'B', view: 'buy', title_key: 'nav.buy' }),
  Object.freeze({ code: 'KeyW', letter: 'W', view: 'waves', title_key: 'nav.waves' }),
  Object.freeze({ code: 'KeyR', letter: 'R', view: 'reserves', title_key: 'nav.reserves' }),
  Object.freeze({ code: 'KeyS', letter: 'S', view: 'scenarios', title_key: 'nav.scenarios' }),
  Object.freeze({ code: 'KeyF', letter: 'F', view: 'feed', title_key: 'nav.feed' }),
  Object.freeze({ code: 'KeyA', letter: 'A', view: 'assistant', title_key: 'nav.assistant' }),
  Object.freeze({ code: 'KeyD', letter: 'D', view: 'data', title_key: 'nav.data' }),
  Object.freeze({ code: 'KeyT', letter: 'T', view: 'settings', title_key: 'settings.nav' }),
  Object.freeze({ code: 'KeyM', letter: 'M', view: 'store', title_key: 'showcase.nav_store' }),
  Object.freeze({ code: 'KeyL', letter: 'L', view: 'ladder', title_key: 'showcase.nav_ladder' }),
  Object.freeze({ code: 'KeyK', letter: 'K', view: 'debts', title_key: 'showcase.nav_debts' }),
  Object.freeze({ code: 'KeyE', letter: 'E', view: 'golden', title_key: 'showcase.nav_golden' }),
  Object.freeze({ code: 'KeyV', letter: 'V', view: 'promises', title_key: 'showcase.nav_promises' }),
  Object.freeze({ code: 'KeyN', letter: 'N', view: 'report', title_key: 'showcase.nav_report' }),
  Object.freeze({ code: 'KeyU', letter: 'U', view: 'payload', title_key: 'showcase.nav_payload' }),
]);

const BY_CODE = new Map(HOTKEYS.map((x) => [x.code, x]));

/** Начальное состояние разбора. */
export const HOTKEY_INIT = Object.freeze({ pending_at: null });

/**
 * Шаг разбора нажатия.
 * @param {{pending_at: number|null}} state
 * @param {{code?: string, key?: string, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, repeat?: boolean, defaultPrevented?: boolean,
 *   timeStamp?: number, editable?: boolean, dialog_open?: boolean}} ev
 * @returns {{state: {pending_at: number|null}, action: {type: 'none'}|{type: 'pending'}|{type: 'go', view: string, letter: string}|{type: 'help'}}}
 */
export function hotkey_step(state, ev) {
  const none = { state: HOTKEY_INIT, action: { type: 'none' } };
  if (ev.ctrlKey === true || ev.metaKey === true || ev.altKey === true || ev.repeat === true || ev.defaultPrevented === true) return none;
  if (ev.editable === true || ev.dialog_open === true) return none;
  const now = Number.isFinite(ev.timeStamp) ? ev.timeStamp : 0;
  const live = state.pending_at !== null && now - state.pending_at >= 0 && now - state.pending_at <= CHORD_WINDOW_MS;
  if (live && ev.key !== '?') {
    const hit = BY_CODE.get(ev.code);
    if (hit !== undefined) return { state: HOTKEY_INIT, action: { type: 'go', view: hit.view, letter: hit.letter } };
    if (ev.code === 'Escape') return none;
  }
  if (ev.key === '?') return { state: HOTKEY_INIT, action: { type: 'help' } };
  if (ev.code === 'KeyG') return { state: { pending_at: now }, action: { type: 'pending' } };
  return none;
}

// ── DOM ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const installed = new WeakSet();

function is_editable(t) {
  if (t === null || t === undefined) return false;
  const tag = String(t.tagName ?? '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable === true;
}

/** Список клавиш в общем диалоге страницы. */
export function open_hotkeys_help(ctx) {
  const tr = ctx.tr;
  const rows = HOTKEYS.map((x) => h('tr', null,
    h('td', null, h('kbd', { text: 'G' }), ' ', tr('showcase.hk_then'), ' ', h('kbd', { text: x.letter })),
    h('td', { text: tr(x.title_key) })));
  open_dialog(tr('showcase.hk_title'), tr('showcase.hk_close'),
    h('p', { text: tr('showcase.hk_lead') }),
    table(tr('showcase.hk_caption'), [tr('showcase.hk_col_keys'), tr('showcase.hk_col_view')], rows, 'tbl'),
    h('p', { class: 'muted', text: tr('showcase.hk_note') }));
}

/**
 * Подключить обработчик нажатий к окну (один раз на окно).
 * @param {object} ctx
 * @param {{addEventListener: Function}} [win]
 * @returns {boolean} подключён ли обработчик
 */
export function install_hotkeys(ctx, win = typeof window === 'undefined' ? null : window) {
  if (win === null || typeof win.addEventListener !== 'function' || installed.has(win)) return false;
  installed.add(win);
  let state = HOTKEY_INIT;
  win.addEventListener('keydown', (ev) => {
    const dlg = el_by_id('dlg');
    const r = hotkey_step(state, {
      code: ev.code, key: ev.key, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey, altKey: ev.altKey, repeat: ev.repeat, defaultPrevented: ev.defaultPrevented,
      timeStamp: ev.timeStamp, editable: is_editable(ev.target), dialog_open: dlg !== null && dlg !== undefined && dlg.open === true,
    });
    state = r.state;
    const act = r.action;
    if (act.type === 'pending') { announce(ctx.tr('showcase.hk_pending')); return; }
    if (act.type === 'help') { if (typeof ev.preventDefault === 'function') ev.preventDefault(); open_hotkeys_help(ctx); return; }
    if (act.type === 'go') {
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      if (typeof location !== 'undefined') location.hash = '#' + act.view;
      const hit = BY_CODE.get('Key' + act.letter);
      announce(ctx.tr('showcase.hk_went', { view: hit === undefined ? act.view : ctx.tr(hit.title_key) }));
    }
  });
  return true;
}

/** Кнопка «Клавиши» для слота `nav.actions`: открывает список (клавиатурный путь — «?»). */
export function render_nav_help(ctx) {
  const btn = h('button', { type: 'button', class: 'btn', 'aria-label': ctx.tr('showcase.hk_button_label'), title: ctx.tr('showcase.hk_button_label'), text: '?' });
  btn.addEventListener('click', () => open_hotkeys_help(ctx));
  return btn;
}
