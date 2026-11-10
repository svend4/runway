// about.mjs — экран «О программе» (#about, FP-12, REQ-154, REQ-117, REQ-120): версия движка, хэш сборки и число файлов оболочки, состояние офлайн-копии
// и кнопки «Проверить обновление» / «Обновить», сведения («нет внешних запросов после загрузки оболочки», сторонних компонентов нет, лицензия не выбрана),
// проверка расчёта в фоне (Worker против основного потока). Хэш сборки берётся из demo/build_info.mjs — файла, который генерирует tools/build_manifest.mjs,
// поэтому показан именно тот хэш, чей код сейчас работает в странице; сетевых вызовов у модуля нет.
// Логика (модель строк, тексты состояния) — чистые функции; узлы строит dom.mjs (textContent, без inline-стилей и обработчиков-строк).
// Расчёт по введённым данным и правилам, не консультация.

import { h } from './dom.mjs';
import { analyze, ENGINE_VERSION } from '../engine/index.mjs';
import { BUILD } from './build_info.mjs';
import { create_pwa, UNSUPPORTED } from './pwa.mjs';
import { create_calc_client } from './worker_client.mjs';
import { create_focus_keeper } from './focus_keep.mjs';

/** Места экрана в навигации: после «Метрик» (170), перед концом списка. */
export const ABOUT_ORDER = 180;

/** Причины, для которых есть своя строка; остальные (имена исключений браузера) показываются как «код …». */
const KNOWN_REASONS = new Set([...UNSUPPORTED, 'install_failed']);
const FALLBACK_KNOWN = new Set(['no_worker', 'worker_start_failed', 'worker_error', 'timeout', 'version_mismatch', 'clone_failed', 'terminated']);

/** Сокращённый хэш для заголовков и подписей: первые 12 знаков. */
export const short_hash = (hash) => String(hash).slice(0, 12);

/** Причина отказа словами (RU/EN). */
export function reason_text(tr, reason) {
  if (reason === null || reason === undefined) return '';
  return KNOWN_REASONS.has(reason) ? tr('about.reason_' + reason) : tr('about.reason_other', { code: String(reason) });
}

/** Причина отката расчёта в основной поток словами. */
export function fallback_text(tr, reason) {
  return FALLBACK_KNOWN.has(reason) ? tr('about.fb_' + reason) : tr('about.reason_other', { code: String(reason) });
}

/**
 * Текст состояния офлайн-копии по состоянию контроллера PWA.
 * @param {(key: string, params?: object) => string} tr
 * @param {{status: string, reason?: string|null, cached?: number|null, total?: number|null}} st
 */
export function pwa_text(tr, st) {
  switch (st.status) {
    case 'unsupported': return tr('about.st_unsupported', { reason: reason_text(tr, st.reason) });
    // первая установка не прошла: прежней версии нет, поэтому «работает прежняя» здесь было бы неправдой
    case 'error': return tr('about.st_error', { reason: st.reason === 'install_failed' ? tr('about.reason_first_install_failed') : reason_text(tr, st.reason) });
    case 'update_ready': return tr('about.st_update_ready');
    case 'active': {
      const base = Number.isSafeInteger(st.cached) && Number.isSafeInteger(st.total) && st.total > 0
        ? tr('about.st_active_counts', { cached: st.cached, total: st.total }) : tr('about.st_active');
      // найденная версия ещё устанавливается или не установилась: об этом сказано на экране, а не только в консоли браузера
      if (st.installing === true) return base + ' ' + tr('about.st_installing');
      if (st.reason === 'install_failed') return base + ' ' + tr('about.st_update_failed', { reason: reason_text(tr, st.reason) });
      return base;
    }
    case 'registering': return tr('about.st_registering');
    default: return tr('about.st_idle');
  }
}

/** После `check_update` воркер работает, если состояние не «не поддерживается / ошибка / не запускался». */
function can_check_now(s) {
  return s.status === 'active' || s.status === 'update_ready';
}

/**
 * Итог кнопки «Проверить обновление» по ТЕКУЩЕМУ состоянию воркера, а не по снимку на момент ответа: установка найденной версии идёт и после того,
 * как `update()` вернулся, поэтому сообщение пересчитывается при каждой отрисовке и не противоречит строке состояния.
 */
export function check_result_text(tr, st) {
  if (!can_check_now(st)) return tr('about.check_unavailable');
  if (st.status === 'update_ready') return tr('about.checked_new');
  if (st.installing === true) return tr('about.checked_installing');
  if (st.reason === 'install_failed') return tr('about.checked_failed');
  return tr('about.checked_none');
}

/** Строки таблицы «Версия и сборка»: [ключ строки, значение]. */
export function build_rows(build, engine_version) {
  return [['engine', engine_version], ['hash', build.build_hash], ['files', String(build.files)], ['format', build.format]];
}

/**
 * Сравнить расчёт воркера с расчётом на месте (побайтно, по JSON). Чистая часть проверки «расчёт в фоне».
 * @param {{analyze: (ws: object, q: object) => Promise<{result: object, via: string, reason: string|null}>}} calc
 * @param {object} ws
 * @param {() => number} now_ms
 * @param {(ws: object, q: object) => object} [local]
 * @returns {Promise<{same: boolean, via: 'worker'|'main', reason: string|null, ms: number}>}
 */
export async function check_background(calc, ws, now_ms, local = analyze) {
  const query = { as_of: ws.as_of };
  const t0 = now_ms();
  const got = await calc.analyze(ws, query);
  const ms = Math.max(0, Math.round(now_ms() - t0));
  const same = JSON.stringify(got.result) === JSON.stringify(local(ws, query));
  return { same, via: got.via, reason: got.reason, ms };
}

/**
 * Зависимости экрана (состояние страницы и порты).
 * @param {{pwa?: object, calc?: object, build?: object, now_ms?: () => number}} [env] в приложении не передаётся; в тестах подменяется
 */
export function make_deps(env = {}) {
  const now_ms = env.now_ms ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  return {
    pwa: env.pwa ?? create_pwa(),
    calc: env.calc ?? create_calc_client(),
    build: env.build ?? BUILD,
    now_ms,
    ui: { check_msg: '', check_done: false, calc_msg: '', calc_busy: false },
    focus: create_focus_keeper(now_ms),
  };
}

/**
 * Экран «О программе».
 * @param {object} ctx контекст расширений
 * @param {ReturnType<typeof make_deps>} deps
 */
export function render_about(ctx, deps) {
  const tr = ctx.tr;
  const st = deps.pwa.snapshot();
  const ui = deps.ui;
  const can_check = st.status === 'active' || st.status === 'update_ready';

  const rows = build_rows(deps.build, ENGINE_VERSION).map(([k, v]) => h('tr', null,
    h('th', { scope: 'row', text: tr('about.row_' + k) }),
    h('td', null, k === 'hash' ? h('code', { class: 'ab-hash', id: 'ab-hash', text: v }) : v)));

  const check = () => {
    deps.focus.request('ab-check');
    ui.check_done = false;
    ui.check_msg = tr('about.checking');
    ctx.refresh();
    Promise.resolve(deps.pwa.check_update()).then(() => {
      ui.check_done = true; // дальше текст итога берётся из состояния воркера при каждой отрисовке (check_result_text)
      ctx.refresh();
    });
  };
  const apply = () => {
    deps.focus.request('ab-update');
    ui.check_done = false;
    ui.check_msg = deps.pwa.apply_update() ? tr('about.updating') : tr('about.update_none');
    ctx.refresh();
  };
  const run_calc = () => {
    const ws = ctx.get_ws();
    deps.focus.request('ab-calc');
    if (ws === null || ws === undefined) { ui.calc_msg = tr('about.calc_no_data'); ctx.refresh(); return; }
    ui.calc_busy = true;
    ui.calc_msg = tr('about.calc_running');
    ctx.refresh();
    check_background(deps.calc, ws, deps.now_ms).then((r) => {
      ui.calc_msg = !r.same ? tr('about.calc_differs')
        : r.via === 'worker' ? tr('about.calc_same_worker', { ms: r.ms })
          : tr('about.calc_same_main', { reason: fallback_text(tr, r.reason), ms: r.ms });
    }, (e) => {
      ui.calc_msg = tr('about.calc_error', { code: typeof e?.code === 'string' ? e.code : 'E_SCHEMA' });
    }).then(() => { ui.calc_busy = false; ctx.refresh(); });
  };

  const root = h('div', { class: 'view about' },
    h('h2', { id: 'view-title', tabindex: '-1', text: tr('about.title') }),
    h('p', { class: 'lead', text: tr('about.lead') }),
    h('section', { class: 'card', 'aria-labelledby': 'ab-build-title' },
      h('h3', { id: 'ab-build-title', text: tr('about.build_title') }),
      h('table', { class: 'tbl' }, h('caption', { class: 'sr-only', text: tr('about.build_title') }), h('tbody', null, rows)),
      h('p', { class: 'muted', text: tr('about.build_note') })),
    h('section', { class: 'card', 'aria-labelledby': 'ab-shell-title' },
      h('h3', { id: 'ab-shell-title', text: tr('about.shell_title') }),
      h('p', { id: 'ab-pwa', role: 'status', text: pwa_text(tr, st) }),
      h('p', { class: 'muted', text: tr('about.offline_note') }),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn', id: 'ab-check', disabled: can_check ? null : true, onclick: check, text: tr('about.btn_check') }),
        st.status === 'update_ready' ? h('button', { type: 'button', class: 'btn primary', id: 'ab-update', onclick: apply, text: tr('about.btn_update') }) : null),
      h('p', { id: 'ab-check-msg', class: 'muted', role: 'status', text: ui.check_done ? check_result_text(tr, st) : ui.check_msg })),
    h('section', { class: 'card', 'aria-labelledby': 'ab-net-title' },
      h('h3', { id: 'ab-net-title', text: tr('about.net_title') }),
      h('ul', null, [1, 2, 3, 4].map((i) => h('li', { text: tr('about.net_' + i) })))),
    h('section', { class: 'card', 'aria-labelledby': 'ab-calc-title' },
      h('h3', { id: 'ab-calc-title', text: tr('about.calc_title') }),
      h('p', { class: 'muted', text: tr('about.calc_lead') }),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', id: 'ab-calc', disabled: ui.calc_busy ? true : null, onclick: run_calc, text: tr('about.btn_calc') })),
      h('p', { id: 'ab-calc-msg', class: 'muted', role: 'status', text: ui.calc_msg })),
    h('section', { class: 'card', 'aria-labelledby': 'ab-legal-title' },
      h('h3', { id: 'ab-legal-title', text: tr('about.legal_title') }),
      h('ul', null, [1, 2, 3, 4].map((i) => h('li', { text: tr('about.legal_' + i) })))));
  deps.focus.apply();
  return root;
}
