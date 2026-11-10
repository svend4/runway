// coldstart_page.mjs — страница coldstart.html (FP-23, REQ-152): время от начала навигации (navigationStart) до отрисовки «Обзора» при запуске приложения из кэша.
//
// Как измеряется. Страница открывает приложение (`index.html#overview`) во вложенном окне того же источника и ждёт, пока в нём появится заголовок раздела «Обзор»
// (`#view-title` при `aria-current="page"` на ссылке `#overview` в навигации). Время берётся по часам ВЛОЖЕННОГО окна: `performance.now()` отсчитывается от начала его навигации,
// то есть это и есть «от navigationStart»; затем ждётся второй кадр (`requestAnimationFrame` дважды) — отрисовка. Из `PerformanceNavigationTiming` вложенного окна читаются ответ,
// DOMContentLoaded, размер ответа и `workerStart` (ненулевой — ответил сервис-воркер); «управляется ли окно воркером» — `navigator.serviceWorker.controller`.
// Что это НЕ есть: это повторная загрузка приложения в уже запущенном браузере, а не запуск браузера «с нуля». Самый холодный случай — первый запуск после перезапуска браузера (n = 3 и больше
// показывают первый запуск отдельно). Замер без сети (REQ-152, чек-лист P4) делает человек: страница лишь называет, была ли сеть выключена (`navigator.onLine`).
// Ограничение: сервер, который запрещает вложение страниц (`frame-ancestors 'none'`, так отвечает `node serve.mjs`), не даст открыть приложение во вложенном окне — страница
// скажет об этом, а не придумает число. Под Apache (XAMPP) и на статическом HTTPS-хосте без такого заголовка вложение работает.
// FP-48: страница говорит об этом заранее (`coldpg.h_server`, до кнопки) и сразу после запрета (окно «blocked» `BLOCKED_MS` = 1 с подряд, а не весь тайм-аут 30 с); CSP приложения не ослаблена.
// Отдельную вкладку вместо вложенного окна НЕ используем: повторные запуски серии шли бы без нажатия кнопки, и блокировщик всплывающих окон их отклонил бы;
// не проверить без настоящего браузера; ломает прежние закрепления (вложенное окно, `frame-src`). Для замера служит Apache (XAMPP) или HTTPS-хост — CHECKLIST-release.md, P4.
// Сети у страницы нет (CSP `connect-src 'none'`); строка браузера остаётся на экране и в копируемом тексте. Замеры на устройствах этой страницей не выполнялись — их делают люди (FP-40).
// Цель-гипотеза 2 с — не обещание продукту. Порты (`make_frame`, часы, таймеры) внедряются — модуль проверяется в Node на заглушках. Расчёт по введённым данным и правилам, не консультация.

import { h } from './dom.mjs';
import { percentile, round2 } from './bench_model.mjs';
import {
  make_tr, tr as probe_tr, device_info, device_card, nav_links, copy_card, lang_of, local_date_iso, bind_lang_buttons, mark_lang, ms_text,
} from './probe_kit.mjs';
import catalog from './i18n/coldpg.mjs';

const tr = make_tr(catalog);

/** Адрес приложения относительно страницы: раздел «Обзор». */
export const APP_URL = './index.html#overview';
/** Цель-гипотеза REQ-152, мс (не обещание продукту). */
export const COLD_BUDGET_MS = 2000;
/** Сколько ждать «Обзор» в одном запуске, мс. */
export const RUN_TIMEOUT_MS = 30000;
/** Период опроса вложенного окна, мс. */
export const POLL_MS = 25;
/** Сколько ждать кадр после появления «Обзора», мс (во вкладке в фоне кадров нет). */
export const PAINT_WAIT_MS = 1000;
/** Пауза между запусками, мс. */
export const GAP_MS = 300;
/**
 * Сколько мс подряд окно должно оставаться «blocked», чтобы запуск не ждал весь тайм-аут (FP-48): браузер, который запретил вложение
 * (`frame-ancestors`, так отвечает `node serve.mjs`), показывает в окне страницу ошибки чужого источника, и она не меняется. Приложение того же источника «blocked» не бывает.
 * Предел — по часам, а не по числу опросов: у таймеров на разных системах разный шаг. Для короткого тайм-аута (тесты) предел — четверть тайм-аута (порт `blocked_ms` его задаёт явно).
 */
export const BLOCKED_MS = 1000;
/** Допустимые числа запусков. */
export const RUN_COUNTS = Object.freeze([3, 5, 10]);
export const COLD_FORMAT = 'runway-coldstart/1';

// Место для вложенного окна (`cs-frame-box`) лежит в coldstart.html вне блока, который перерисовывается при смене языка: перенос окна в дереве перезагрузил бы приложение посреди замера.
const IDS = Object.freeze({ runs: 'cs-runs', run: 'cs-run', status: 'cs-status', frame_box: 'cs-frame-box', results: 'cs-results' });
const COPY_IDS = Object.freeze({ out: 'cs-out', btn: 'cs-copy', status: 'cs-copy-status' });

/**
 * Состояние вложенного окна приложения (чистая функция над окном-подобным объектом):
 * `blocked` — окно недоступно (чужой источник или страница ошибки), `blank` — ещё пустой документ, `loading` — приложение грузится,
 * `overview` — «Обзор» отрисован в DOM, `other` — открыт другой раздел.
 * @param {object} win
 * @returns {'blocked'|'blank'|'loading'|'overview'|'other'}
 */
export function frame_state(win) {
  let doc;
  let href;
  try { doc = win.document; href = String(win.location.href); } catch { return 'blocked'; }
  if (doc === null || doc === undefined) return 'blocked';
  if (href === 'about:blank' || href === '') return 'blank';
  if (/^(?:chrome-error|about):/.test(href)) return 'blocked';
  const title = doc.getElementById('view-title');
  if (title === null || title === undefined) return 'loading';
  const cur = doc.querySelector('#nav a[aria-current="page"]');
  const target = cur === null || cur === undefined ? null : cur.getAttribute('href');
  return target === '#overview' ? 'overview' : 'other';
}

const num_or_null = (x) => (typeof x === 'number' && Number.isFinite(x) ? round2(x) : null);

/** Запись `PerformanceNavigationTiming` окна (или `null`, если браузер её не даёт). */
export function read_navigation(win) {
  let e = null;
  try { e = win.performance?.getEntriesByType?.('navigation')?.[0] ?? null; } catch { e = null; }
  if (e === null || e === undefined) return null;
  return {
    type: typeof e.type === 'string' ? e.type : null,
    response_end_ms: num_or_null(e.responseEnd),
    dom_content_loaded_ms: num_or_null(e.domContentLoadedEventEnd),
    load_ms: num_or_null(e.loadEventEnd),
    transfer_size: num_or_null(e.transferSize),
    worker_start_ms: num_or_null(e.workerStart),
  };
}

/** Окно управляется сервис-воркером? `null` — в окне нет `serviceWorker`. */
export function controlled_by_sw(win) {
  try {
    const sw = win.navigator?.serviceWorker;
    if (sw === undefined || sw === null) return null;
    return sw.controller !== null && sw.controller !== undefined;
  } catch { return null; }
}

function wait_paint(win, ports, cb) {
  let done = false;
  let guard = null;
  const end = (v) => { if (done) return; done = true; ports.clear_timeout(guard); cb(v); };
  guard = ports.set_timeout(() => end(null), PAINT_WAIT_MS);
  try {
    win.requestAnimationFrame(() => { win.requestAnimationFrame(() => end(win.performance.now())); });
  } catch { end(null); }
}

/**
 * Один запуск: открыть приложение во вложенном окне, дождаться «Обзора», прочитать время по часам вложенного окна, убрать окно.
 * @param {{make_frame: (url: string, title: string) => any, now: () => number, set_interval: Function, clear_interval: Function, set_timeout: Function, clear_timeout: Function, timeout_ms?: number, poll_ms?: number}} ports
 * @param {string} title подпись вложенного окна для скринридера
 * @returns {Promise<{ok: boolean, state: string, dom_ms: number|null, paint_ms: number|null, nav: object|null, via_sw: boolean|null}>}
 */
export function run_once(ports, title) {
  return new Promise((resolve) => {
    const frame = ports.make_frame(APP_URL, title);
    const started = ports.now();
    const timeout_ms = ports.timeout_ms ?? RUN_TIMEOUT_MS;
    let finished = false;
    let waiting = false;
    let timer = null;
    let blocked_since = null;
    const finish = (r) => {
      if (finished) return;
      finished = true;
      ports.clear_interval(timer);
      try { frame.remove(); } catch { /* окно уже убрано */ }
      resolve(r);
    };
    const tick = () => {
      if (finished || waiting) return;
      const win = frame.contentWindow;
      const state = win === null || win === undefined ? 'blank' : frame_state(win);
      const at = ports.now();
      blocked_since = state === 'blocked' ? (blocked_since ?? at) : null;
      if (blocked_since !== null && at - blocked_since >= (ports.blocked_ms ?? Math.min(BLOCKED_MS, timeout_ms / 4))) { finish({ ok: false, state, dom_ms: null, paint_ms: null, nav: null, via_sw: null }); return; } // вложение запрещено сервером: объяснение сразу, а не через 30 с
      if (state === 'overview') {
        waiting = true;
        ports.clear_interval(timer);
        const dom_ms = win.performance.now();
        const nav = read_navigation(win);
        const via_sw = controlled_by_sw(win);
        wait_paint(win, ports, (paint_ms) => finish({ ok: true, state, dom_ms: round2(dom_ms), paint_ms: paint_ms === null ? null : round2(paint_ms), nav, via_sw }));
        return;
      }
      if (ports.now() - started > timeout_ms) finish({ ok: false, state, dom_ms: null, paint_ms: null, nav: null, via_sw: null });
    };
    timer = ports.set_interval(tick, ports.poll_ms ?? POLL_MS);
    tick();
  });
}

/** Время запуска для сводки: после кадра, а если кадра не было — по появлению в DOM. */
export const value_of = (r) => r.paint_ms ?? r.dom_ms;

/** Сводка запусков: n, успешные, первый запуск, наименьший, медиана, наибольший, сколько раз ответил сервис-воркер. */
export function summarize_runs(runs) {
  const ok = runs.filter((r) => r.ok);
  const xs = ok.map(value_of);
  return {
    n: runs.length,
    ok_runs: ok.length,
    first_ms: runs.length > 0 && runs[0].ok ? value_of(runs[0]) : null,
    min_ms: xs.length > 0 ? round2(Math.min(...xs)) : null,
    p50_ms: xs.length > 0 ? round2(percentile(xs, 50)) : null,
    max_ms: xs.length > 0 ? round2(Math.max(...xs)) : null,
    via_sw: ok.filter((r) => r.via_sw === true).length,
    painted: ok.filter((r) => r.paint_ms !== null).length,
  };
}

/** Запись для вставки в отчёт (`runway-coldstart/1`). */
export function build_cold_report({ date, device, env, n, runs, online, self_nav, notes = [] }) {
  const summary = summarize_runs(runs);
  return {
    format: COLD_FORMAT,
    date,
    device,
    source: 'demo/coldstart.html',
    n,
    hypothesis_ms: COLD_BUDGET_MS,
    offline: online === false,
    env,
    summary,
    within_hypothesis: summary.p50_ms === null ? null : summary.p50_ms <= COLD_BUDGET_MS,
    runs: runs.map((r) => ({ ok: r.ok, state: r.state, dom_ms: r.dom_ms, paint_ms: r.paint_ms, via_sw: r.via_sw, nav: r.nav })),
    page_navigation: self_nav,
    notes,
  };
}

/** Строка для колонки «Результат» чек-листа (P4). */
export function checklist_line(lang, report) {
  const s = report.summary;
  const dev = report.device.length > 100 ? report.device.slice(0, 100) + '…' : report.device;
  return tr(lang, 'coldpg.line', {
    date: report.date, device: dev === '' ? probe_tr(lang, 'probe.unknown') : dev, n: s.n, p50: ms_text(lang, s.p50_ms), max: ms_text(lang, s.max_ms), sw: s.via_sw, ok: s.ok_runs,
    offline: probe_tr(lang, report.offline ? 'probe.yes' : 'probe.no'),
  });
}

/** Текст для копирования: строка для чек-листа и JSON записи. */
export function report_text(page) {
  if (page.report === null) return '';
  return checklist_line(page.lang, page.report) + '\n\n' + JSON.stringify(page.report, null, 2);
}

// ── страница ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Порты страницы. */
export function make_ports(env = globalThis) {
  const doc = env.document;
  return {
    env, doc,
    now: () => env.performance.now(),
    clock: () => new Date(),
    set_interval: (fn, ms) => env.setInterval(fn, ms),
    clear_interval: (id) => env.clearInterval(id),
    set_timeout: (fn, ms) => env.setTimeout(fn, ms),
    clear_timeout: (id) => env.clearTimeout(id),
    sleep: (ms) => new Promise((r) => { env.setTimeout(r, ms); }),
    make_frame: (url, title) => {
      const box = doc.getElementById(IDS.frame_box);
      const f = h('iframe', { src: url, class: 'probe-frame', title });
      if (box !== null) box.replaceChildren(f); else doc.body.append(f);
      return f;
    },
  };
}

export function make_page(lang, ports) {
  return { lang, ports, runs_n: 5, busy: false, status: { key: 'coldpg.status_idle', params: {} }, report: null, info: device_info(ports.env), date: local_date_iso(ports.clock) };
}

function set_status(page, key, params = {}) {
  page.status = { key, params };
  const node = page.ports.doc.getElementById(IDS.status);
  if (node !== null) node.textContent = tr(page.lang, key, params);
}

function fail_note(state) {
  if (state === 'blocked' || state === 'blank') return 'blocked';
  if (state === 'other') return 'other';
  return 'timeout';
}

/**
 * Замер: `runs_n` запусков по очереди; первый неудачный запуск останавливает серию (ждать ещё несколько раз по 30 с незачем).
 * @returns {Promise<object|null>} отчёт или `null`, если замер уже идёт
 */
export async function run_cold(page) {
  if (page.busy) { set_status(page, 'coldpg.status_busy'); return null; }
  page.busy = true;
  page.ports.doc.getElementById(IDS.run)?.setAttribute('aria-disabled', 'true');
  const { ports } = page;
  const runs = [];
  const notes = [];
  try {
    page.date = local_date_iso(ports.clock);
    page.info = device_info(ports.env);
    const title = tr(page.lang, 'coldpg.frame_title');
    for (let i = 0; i < page.runs_n; i++) {
      set_status(page, 'coldpg.status_running', { i: i + 1, n: page.runs_n });
      const r = await run_once(ports, title);
      runs.push(r);
      if (!r.ok) { notes.push(fail_note(r.state)); break; }
      await ports.sleep(GAP_MS);
    }
  } catch {
    notes.push('error');
  }
  const { user_agent, ...env } = page.info;
  page.report = build_cold_report({
    date: page.date, device: user_agent ?? '', env, n: page.runs_n, runs, online: page.info.online, self_nav: read_navigation(ports.env), notes,
  });
  page.ports.doc.getElementById(IDS.frame_box)?.replaceChildren();
  set_status(page, notes.length === 0 ? 'coldpg.status_done' : 'coldpg.status_failed', { ok: page.report.summary.ok_runs, n: page.runs_n });
  page.busy = false;
  page.ports.doc.getElementById(IDS.run)?.setAttribute('aria-disabled', 'false');
  render_results(page);
  return page.report;
}

function runs_card(page) {
  const lang = page.lang;
  const r = page.report;
  const yn = (v) => (v === null || v === undefined ? probe_tr(lang, 'probe.unknown') : probe_tr(lang, v ? 'probe.yes' : 'probe.no'));
  const head = [tr(lang, 'coldpg.th_run'), tr(lang, 'coldpg.th_dom'), tr(lang, 'coldpg.th_paint'), tr(lang, 'coldpg.th_sw'), tr(lang, 'coldpg.th_size'), tr(lang, 'coldpg.th_type')];
  const s = r.summary;
  const lines = [
    tr(lang, 'coldpg.sum_line', { n: s.n, ok: s.ok_runs, first: ms_text(lang, s.first_ms), p50: ms_text(lang, s.p50_ms), max: ms_text(lang, s.max_ms), sw: s.via_sw }),
    r.within_hypothesis === null ? tr(lang, 'coldpg.verdict_none') : tr(lang, r.within_hypothesis ? 'coldpg.verdict_in' : 'coldpg.verdict_out', { limit: COLD_BUDGET_MS }),
    tr(lang, r.offline ? 'coldpg.offline_yes' : (r.env.online === null ? 'coldpg.offline_unknown' : 'coldpg.offline_no')),
  ];
  return h('section', { class: 'card', 'aria-labelledby': 'cs-res-title' },
    h('h3', { id: 'cs-res-title', text: tr(lang, 'coldpg.s_result') }),
    h('ul', null, lines.map((t) => h('li', { text: t }))),
    r.runs.length === 0 ? null : h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': tr(lang, 'coldpg.s_result') },
      h('table', { class: 'tbl' },
        h('caption', { class: 'sr-only', text: tr(lang, 'coldpg.s_result') }),
        h('thead', null, h('tr', null, head.map((c) => h('th', { scope: 'col', text: c })))),
        h('tbody', null, r.runs.map((x, i) => h('tr', null,
          h('th', { scope: 'row', text: String(i + 1) }),
          h('td', { text: x.ok ? ms_text(lang, x.dom_ms) : '—' }),
          h('td', { text: x.ok ? ms_text(lang, x.paint_ms) : '—' }),
          h('td', { text: x.ok ? yn(x.via_sw) : '—' }),
          h('td', { text: x.nav === null ? probe_tr(lang, 'probe.unknown') : ms_text(lang, x.nav.transfer_size) }),
          h('td', { text: x.nav === null || x.nav.type === null ? probe_tr(lang, 'probe.unknown') : x.nav.type })))))));
}

function notes_card(page) {
  const lang = page.lang;
  const r = page.report;
  const self = r.page_navigation;
  const lines = [
    self === null ? tr(lang, 'coldpg.self_none') : tr(lang, 'coldpg.self_line', { dcl: ms_text(lang, self.dom_content_loaded_ms), sw: ms_text(lang, self.worker_start_ms) }),
    tr(lang, 'coldpg.note_embedded'),
    tr(lang, 'coldpg.note_cold'),
    tr(lang, 'coldpg.note_hyp'),
    ...r.notes.map((code) => tr(lang, 'coldpg.nc_' + code, { s: RUN_TIMEOUT_MS / 1000 })),
  ];
  return h('section', { class: 'card', 'aria-labelledby': 'cs-notes-title' },
    h('h3', { id: 'cs-notes-title', text: tr(lang, 'coldpg.s_notes') }),
    h('ul', null, lines.map((t) => h('li', { text: t }))),
    h('p', { class: 'muted', text: tr(lang, 'coldpg.copy_how') }));
}

/** Перерисовать только блок результатов. */
export function render_results(page) {
  const box = page.ports.doc.getElementById(IDS.results);
  if (box === null) return;
  if (page.report === null) { box.replaceChildren(); return; }
  box.replaceChildren(
    device_card(page.lang, page.info, page.report.date, { title: 'cs-dev-title' }),
    runs_card(page), notes_card(page),
    copy_card(page.lang, COPY_IDS, () => report_text(page), { env: page.ports.env, doc: page.ports.doc }));
}

export function render_page(page) {
  const doc = page.ports.doc;
  const lang = page.lang;
  const select = h('select', { id: IDS.runs, 'aria-describedby': 'cs-runs-hint', onchange: (ev) => { const v = Number(ev?.target?.value); if (RUN_COUNTS.includes(v)) page.runs_n = v; } },
    RUN_COUNTS.map((n) => h('option', { value: String(n), selected: page.runs_n === n ? true : null, text: tr(lang, 'coldpg.runs_opt', { n }) })));
  const controls = h('section', { class: 'card', 'aria-labelledby': 'cs-run-title' },
    h('h3', { id: 'cs-run-title', text: tr(lang, 'coldpg.s_run') }),
    h('p', { text: tr(lang, 'coldpg.lead') }),
    h('p', { id: 'cs-server-hint', class: 'muted', text: tr(lang, 'coldpg.h_server') }), // где замер работает, а где нет, — до нажатия кнопки (FP-48)
    h('div', { class: 'field' }, h('label', { for: IDS.runs, text: tr(lang, 'coldpg.f_runs') }), select, h('p', { id: 'cs-runs-hint', class: 'muted', text: tr(lang, 'coldpg.h_runs') })),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn primary', id: IDS.run, 'aria-disabled': page.busy ? 'true' : 'false', onclick: () => { if (page.busy) { set_status(page, 'coldpg.status_busy'); return; } void run_cold(page); }, text: tr(lang, 'coldpg.btn_run') })),
    h('p', { id: IDS.status, class: 'muted', role: 'status', 'aria-live': 'polite', text: tr(lang, page.status.key, page.status.params) }));
  doc.getElementById('main').replaceChildren(
    nav_links(lang, 'cold'),
    h('h2', { id: 'view-title-cold', tabindex: '-1', text: tr(lang, 'coldpg.title') }),
    controls,
    h('div', { id: IDS.results }),
    h('p', { class: 'muted', text: probe_tr(lang, 'probe.disclaimer') }));
  mark_lang('cs', lang, doc);
  doc.title = tr(lang, 'coldpg.doc_title');
  render_results(page);
}

export function boot_coldstart(env = globalThis) {
  const ports = make_ports(env);
  const page = make_page(lang_of(env), ports);
  bind_lang_buttons('cs', (l) => { page.lang = l; render_page(page); }, ports.doc);
  render_page(page);
  return page;
}

if (typeof document !== 'undefined' && document.getElementById('cs-title-bar') !== null) boot_coldstart();
