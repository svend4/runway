// calc_settings.mjs — карточка «Расчёт в фоне» на экране «Настройки» (FP-21, REQ-150): флаг устройства, который выключает Worker целиком.
// Флаг — настройка этого устройства (`runway-calc-worker/1` в localStorage, см. calc_async.mjs), а не данные: в рабочую область, журнал и файл-копию он не попадает, поэтому
// карточка не пишет через `ctx.set_ws` и остаётся доступной в режиме «только чтение» (файл новее известного формата): переключение ничего не меняет в данных.
// Состояние обновляется на месте (без перерисовки экрана), поэтому фокус остаётся на отметке.
// Только DOM из dom.mjs (textContent), строки — каталог `calc` (i18n/calc.mjs). Модуль можно импортировать в Node без побочных эффектов.
// Расчёт по введённым данным и правилам, не консультация.

import { h } from './dom.mjs';
import { calc } from './calc_async.mjs';

/** Причина «считаем на основном потоке» → ключ строки (литералы: каждый ключ каталога используется в коде). */
const REASON_KEYS = Object.freeze({
  off: 'calc.reason_off',
  no_worker: 'calc.reason_no_worker',
  worker_start_failed: 'calc.reason_start_failed',
  worker_error: 'calc.reason_worker_error',
  timeout: 'calc.reason_timeout',
  version_mismatch: 'calc.reason_version',
});

/**
 * Строка состояния: где считается сейчас и сколько расчётов сделано в этом сеансе.
 * @param {(key: string, params?: object) => string} tr
 * @param {{stats: () => object}} [svc]
 */
export function state_text(tr, svc = calc) {
  const st = svc.stats();
  if (st.off_reason === null) return tr('calc.state_on', { worker: st.worker_calls, main: st.main_calls });
  return tr('calc.state_main', { reason: tr(REASON_KEYS[st.off_reason] ?? 'calc.reason_other') });
}

/**
 * Карточка с отметкой «Считать в фоне».
 * @param {object} ctx контекст расширений (`tr`)
 * @param {ReturnType<typeof import('./calc_async.mjs').create_calc_service>} [svc]
 * @returns {HTMLElement|null} `null`, если каталог строк пакета не загружен
 */
export function calc_card(ctx, svc = calc) {
  const tr = ctx.tr;
  if (tr('calc.title') === 'calc.title') return null;
  const id = 'set-calc';
  const state = h('p', { id: id + '-state', class: 'muted', role: 'status', text: state_text(tr, svc) });
  const box = h('input', { id, type: 'checkbox', checked: svc.enabled() ? true : null, 'aria-describedby': id + '-hint ' + id + '-state' });
  box.addEventListener('change', () => {
    svc.set_enabled(box.checked === true);
    state.textContent = state_text(tr, svc);
  });
  return h('section', { class: 'card calc-card', id: 'settings-calc', 'aria-labelledby': 'settings-calc-title' },
    h('h3', { id: 'settings-calc-title', text: tr('calc.title') }),
    h('p', { class: 'lead', text: tr('calc.lead') }),
    h('div', { class: 'field check' },
      h('label', { for: id }, box, ' ', tr('calc.flag')),
      h('p', { id: id + '-hint', class: 'muted', text: tr('calc.flag_hint') })),
    state,
    h('p', { class: 'muted', text: tr('calc.restart') }),
    h('p', { class: 'muted', text: tr('calc.writes_note') }));
}
