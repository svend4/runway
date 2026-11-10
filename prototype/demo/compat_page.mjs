// compat_page.mjs — страница compat.html (FP-23, REQ-157): самопроверка устройства и браузера. Определяет IndexedDB (с пробной записью и чтением), persist(), Web Locks,
// сервис-воркер, Cache Storage, Worker (модульный воркер расчёта через тот же клиент, что в приложении), BroadcastChannel, File System Access, crypto.subtle и режим
// «установленное приложение»; выводит таблицу для копирования в чек-лист (CHECKLIST-release.md, раздел 2).
//
// Чего страница НЕ делает. Не вызывает `persist()` (это может вызвать запрос разрешения и меняет состояние хранилища — только читает `persisted()` и `estimate()`); не регистрирует и не перечисляет
// сервис-воркеры (область общего localhost не трогается); не шлёт сообщений в BroadcastChannel; не проверяет, переживают ли данные перезапуск, установку PWA и офлайн — их проверяют люди по
// чек-листу (P4, P5, P13). Пробная база и замок называются `runway-compat-probe`: пробная база удаляется сразу после проверки, чужие базы, кэши и ключи не затрагиваются.
// Сети у страницы нет (CSP `connect-src 'none'`); строка браузера остаётся на экране и в копируемом тексте. Замеры на устройствах этой страницей не выполнялись — их делают люди (FP-40).
// Порты (`env`, часы, клиент воркера, таймеры) внедряются — модуль проверяется в Node на заглушках. Расчёт по введённым данным и правилам, не консультация.

import { analyze } from '../engine/index.mjs';
import { h } from './dom.mjs';
import { create_calc_client } from './worker_client.mjs';
import { make_bench_ws } from './bench_model.mjs';
import {
  make_tr, tr as probe_tr, device_info, device_card, nav_links, copy_card, lang_of, local_date_iso, bind_lang_buttons, mark_lang,
} from './probe_kit.mjs';
import catalog from './i18n/compatpg.mjs';

const tr = make_tr(catalog);

/** Имя пробной базы и замка (префикс runway; база удаляется сразу после проверки). */
export const PROBE_NAME = 'runway-compat-probe';
/** Сколько ждать пробу, мс (закрытое хранилище в некоторых браузерах не отвечает вовсе). */
export const PROBE_TIMEOUT_MS = 5000;
export const COMPAT_FORMAT = 'runway-compat/1';

/** Возможности в порядке показа. */
export const FEATURES = Object.freeze(['secure', 'indexeddb', 'persist', 'locks', 'sw', 'caches', 'worker', 'broadcast', 'fsa', 'subtle', 'standalone']);
/** Статусы результата. */
export const STATUSES = Object.freeze(['yes', 'no', 'partial', 'unknown']);
/** Закрытый список кодов подробностей: у каждого есть строка `compatpg.d_<код>` в каталоге (проверяет tests/bench_pages.test.mjs). */
export const DETAIL_CODES = Object.freeze([
  'secure_yes', 'secure_no', 'secure_unknown',
  'idb_ok', 'idb_failed', 'idb_absent',
  'persist_present', 'persist_absent',
  'locks_ok', 'locks_busy', 'locks_failed', 'locks_absent',
  'sw_controlled', 'sw_present', 'sw_absent',
  'caches_present', 'caches_absent',
  'worker_ok', 'worker_diff', 'worker_main', 'worker_absent', 'worker_probe_error',
  'bc_ok', 'bc_failed', 'bc_absent',
  'fsa_pickers', 'fsa_opfs', 'fsa_absent',
  'subtle_ok', 'subtle_absent',
  'standalone_yes', 'standalone_no', 'standalone_unknown',
  'probe_error',
]);
/** Причины отката воркера расчёта (закрытый список клиента). */
export const REASON_CODES = Object.freeze(['no_worker', 'worker_start_failed', 'worker_error', 'timeout', 'version_mismatch', 'clone_failed']);

const res = (id, status, code, params = {}) => ({ id, status, code, params });

/** Ограничить ожидание: если проба не ответила за `ms`, результат — `fallback`. */
function with_timeout(promise, ms, ports, fallback) {
  return new Promise((resolve) => {
    const t = ports.set_timeout(() => resolve(fallback), ms);
    promise.then((v) => { ports.clear_timeout(t); resolve(v); }, () => { ports.clear_timeout(t); resolve(fallback); });
  });
}

function probe_secure(env) {
  if (typeof env.isSecureContext !== 'boolean') return res('secure', 'unknown', 'secure_unknown');
  return env.isSecureContext ? res('secure', 'yes', 'secure_yes') : res('secure', 'no', 'secure_no');
}

/** IndexedDB: открыть пробную базу, записать и прочитать значение, закрыть и удалить базу. */
async function probe_idb(env, ports) {
  const idb = env.indexedDB;
  if (idb === undefined || idb === null || typeof idb.open !== 'function') return res('indexeddb', 'no', 'idb_absent');
  const work = (async () => {
    const db = await new Promise((resolve, reject) => {
      const rq = idb.open(PROBE_NAME, 1);
      rq.onupgradeneeded = () => { rq.result.createObjectStore('probe'); };
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
      rq.onblocked = () => reject(new Error('blocked'));
    });
    let same = false;
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('probe', 'readwrite');
        tx.objectStore('probe').put('ok', 'k');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      const got = await new Promise((resolve, reject) => {
        const rq = db.transaction('probe', 'readonly').objectStore('probe').get('k');
        rq.onsuccess = () => resolve(rq.result);
        rq.onerror = () => reject(rq.error);
      });
      same = got === 'ok';
    } finally {
      db.close();
      await new Promise((resolve) => {
        const rq = idb.deleteDatabase(PROBE_NAME);
        rq.onsuccess = () => resolve();
        rq.onerror = () => resolve();
        rq.onblocked = () => resolve();
      });
    }
    return same;
  })();
  const ok = await with_timeout(work, PROBE_TIMEOUT_MS, ports, false);
  return ok ? res('indexeddb', 'yes', 'idb_ok') : res('indexeddb', 'no', 'idb_failed');
}

/** persist(): наличие функции; состояние `persisted()` и оценка квоты только читаются (сам `persist()` не вызывается). */
async function probe_persist(env, ports) {
  const sm = env.navigator?.storage;
  if (sm === undefined || sm === null || typeof sm.persist !== 'function') return res('persist', 'no', 'persist_absent');
  const read = async () => {
    let persisted = null;
    let quota_mb = null;
    try { if (typeof sm.persisted === 'function') persisted = (await sm.persisted()) === true; } catch { persisted = null; }
    try { if (typeof sm.estimate === 'function') { const e = await sm.estimate(); if (Number.isFinite(e?.quota)) quota_mb = Math.round(e.quota / 1048576); } } catch { quota_mb = null; }
    return { persisted, quota_mb };
  };
  const got = await with_timeout(read(), PROBE_TIMEOUT_MS, ports, { persisted: null, quota_mb: null });
  return res('persist', 'yes', 'persist_present', got);
}

/** Web Locks: запросить замок без ожидания. */
async function probe_locks(env, ports) {
  const locks = env.navigator?.locks;
  if (locks === undefined || locks === null || typeof locks.request !== 'function') return res('locks', 'no', 'locks_absent');
  let asked;
  try { asked = locks.request(PROBE_NAME, { ifAvailable: true }, async (lock) => lock !== null); } catch { return res('locks', 'no', 'locks_failed'); }
  const got = await with_timeout(asked, PROBE_TIMEOUT_MS, ports, 'failed');
  if (got === true) return res('locks', 'yes', 'locks_ok');
  if (got === false) return res('locks', 'partial', 'locks_busy');
  return res('locks', 'no', 'locks_failed');
}

function probe_sw(env) {
  const sw = env.navigator?.serviceWorker;
  if (sw === undefined || sw === null) return res('sw', 'no', 'sw_absent');
  return sw.controller !== null && sw.controller !== undefined ? res('sw', 'yes', 'sw_controlled') : res('sw', 'yes', 'sw_present');
}

function probe_caches(env) {
  const c = env.caches;
  return c !== undefined && c !== null && typeof c.open === 'function' ? res('caches', 'yes', 'caches_present') : res('caches', 'no', 'caches_absent');
}

/** Модульный воркер расчёта: тот же клиент, что в приложении; ответ воркера сравнивается с расчётом на месте. */
async function probe_worker(env, ports) {
  const has_worker = typeof env.Worker === 'function';
  let client = null;
  try {
    client = ports.make_client();
    const ws = make_bench_ws(1);
    const query = { as_of: ws.as_of };
    const t0 = ports.now();
    const got = await client.analyze(ws, query);
    const ms = Math.round(ports.now() - t0);
    if (got.via === 'worker') return JSON.stringify(got.result) === JSON.stringify(analyze(ws, query)) ? res('worker', 'yes', 'worker_ok', { ms }) : res('worker', 'no', 'worker_diff');
    const reason = REASON_CODES.includes(got.reason) ? got.reason : 'worker_error';
    return has_worker ? res('worker', 'partial', 'worker_main', { reason }) : res('worker', 'no', 'worker_absent');
  } catch {
    return res('worker', 'unknown', 'worker_probe_error');
  } finally {
    try { client?.terminate(); } catch { /* воркер уже закрыт */ }
  }
}

function probe_broadcast(env) {
  if (typeof env.BroadcastChannel !== 'function') return res('broadcast', 'no', 'bc_absent');
  try { const ch = new env.BroadcastChannel(PROBE_NAME); ch.close(); return res('broadcast', 'yes', 'bc_ok'); } catch { return res('broadcast', 'no', 'bc_failed'); }
}

function probe_fsa(env) {
  if (typeof env.showOpenFilePicker === 'function') return res('fsa', 'yes', 'fsa_pickers');
  if (typeof env.navigator?.storage?.getDirectory === 'function') return res('fsa', 'partial', 'fsa_opfs');
  return res('fsa', 'no', 'fsa_absent');
}

function probe_subtle(env) {
  return typeof env.crypto?.subtle?.digest === 'function' ? res('subtle', 'yes', 'subtle_ok') : res('subtle', 'no', 'subtle_absent');
}

function probe_standalone(env) {
  let media = null;
  try { if (typeof env.matchMedia === 'function') media = env.matchMedia('(display-mode: standalone)').matches === true; } catch { media = null; }
  const ios = env.navigator?.standalone;
  if (media === true || ios === true) return res('standalone', 'yes', 'standalone_yes');
  if (media === null && ios === undefined) return res('standalone', 'unknown', 'standalone_unknown');
  return res('standalone', 'no', 'standalone_no');
}

/**
 * Все пробы по порядку. Исключений наружу нет: сбой пробы — результат «не определено».
 * @param {object} env окно или заглушка
 * @param {{set_timeout: Function, clear_timeout: Function, make_client: () => object, now: () => number}} ports
 * @returns {Promise<{id: string, status: string, code: string, params: object}[]>}
 */
export async function probe_all(env, ports) {
  const safe = async (id, fn) => { try { return await fn(); } catch { return res(id, 'unknown', id === 'worker' ? 'worker_probe_error' : 'probe_error'); } };
  return [
    await safe('secure', () => probe_secure(env)),
    await safe('indexeddb', () => probe_idb(env, ports)),
    await safe('persist', () => probe_persist(env, ports)),
    await safe('locks', () => probe_locks(env, ports)),
    await safe('sw', () => probe_sw(env)),
    await safe('caches', () => probe_caches(env)),
    await safe('worker', () => probe_worker(env, ports)),
    await safe('broadcast', () => probe_broadcast(env)),
    await safe('fsa', () => probe_fsa(env)),
    await safe('subtle', () => probe_subtle(env)),
    await safe('standalone', () => probe_standalone(env)),
  ];
}

// ── тексты ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Текст подробности результата: код → строка каталога, параметры → слова («да», «нет», «неизвестно»). */
export function detail_text(lang, r) {
  const p = {};
  for (const [k, v] of Object.entries(r.params ?? {})) {
    if (k === 'reason') p[k] = tr(lang, 'compatpg.reason_' + v);
    else if (typeof v === 'boolean') p[k] = probe_tr(lang, v ? 'probe.yes' : 'probe.no');
    else p[k] = v === null || v === undefined ? probe_tr(lang, 'probe.unknown') : String(v);
  }
  return tr(lang, 'compatpg.d_' + r.code, p);
}

export const status_text = (lang, status) => tr(lang, 'compatpg.st_' + status);
export const feature_text = (lang, id) => tr(lang, 'compatpg.f_' + id);

const cell = (s) => String(s).replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

/**
 * Текст для копирования: таблица «возможность — результат — подробность» и строка для таблицы устройств чек-листа (раздел 2). Столбцы, которые страница
 * определить не может (установка PWA, офлайн, воркер импорта), помечены «вручную» с номером пункта.
 */
export function table_text(lang, report) {
  const by = Object.fromEntries(report.results.map((r) => [r.id, r]));
  const st = (id) => (by[id] === undefined ? probe_tr(lang, 'probe.unknown') : status_text(lang, by[id].status));
  const manual = (p) => tr(lang, 'compatpg.md_manual', { p });
  const dev = report.device === '' ? probe_tr(lang, 'probe.unknown') : (report.device.length > 90 ? report.device.slice(0, 90) + '…' : report.device);
  const lines = [
    tr(lang, 'compatpg.md_head', { date: report.date }),
    '',
    `| ${tr(lang, 'compatpg.md_feature')} | ${tr(lang, 'compatpg.md_result')} | ${tr(lang, 'compatpg.md_detail')} |`,
    '|---|---|---|',
    ...report.results.map((r) => `| ${cell(feature_text(lang, r.id))} | ${cell(status_text(lang, r.status))} | ${cell(detail_text(lang, r))} |`),
    '',
    tr(lang, 'compatpg.md_cols'),
    '|---|---|---|---|---|---|---|---|---|',
    `| ${cell(dev)} (${report.date}) | ${st('indexeddb')} | ${st('persist')} | ${st('locks')} | ${manual('P5')} | ${st('sw')} | ${manual('P4')} | ${st('worker')} | ${manual('P13')} |`,
    '',
    tr(lang, 'compatpg.md_note'),
  ];
  return lines.join('\n');
}

// ── страница ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const IDS = Object.freeze({ run: 'cp-run', status: 'cp-status', results: 'cp-results' });
const COPY_IDS = Object.freeze({ out: 'cp-out', btn: 'cp-copy', status: 'cp-copy-status' });

/** Порты страницы. */
export function make_ports(env = globalThis) {
  return {
    env, doc: env.document,
    now: () => env.performance.now(),
    clock: () => new Date(),
    set_timeout: (fn, ms) => env.setTimeout(fn, ms),
    clear_timeout: (id) => env.clearTimeout(id),
    make_client: () => create_calc_client({ timeout_ms: PROBE_TIMEOUT_MS }),
  };
}

export function make_page(lang, ports) {
  return { lang, ports, busy: false, status: { key: 'compatpg.status_idle', params: {} }, report: null, info: device_info(ports.env), date: local_date_iso(ports.clock) };
}

function set_status(page, key, params = {}) {
  page.status = { key, params };
  const node = page.ports.doc.getElementById(IDS.status);
  if (node !== null) node.textContent = tr(page.lang, key, params);
}

/** Текст для копирования текущего отчёта. */
export function report_text(page) {
  return page.report === null ? '' : table_text(page.lang, page.report);
}

/**
 * Проверка устройства. Повторное нажатие во время проверки отвергается.
 * @returns {Promise<object|null>} отчёт `runway-compat/1` или `null`
 */
export async function run_compat(page) {
  if (page.busy) { set_status(page, 'compatpg.status_busy'); return null; }
  page.busy = true;
  page.ports.doc.getElementById(IDS.run)?.setAttribute('aria-disabled', 'true');
  set_status(page, 'compatpg.status_running');
  let results = [];
  try {
    page.date = local_date_iso(page.ports.clock);
    page.info = device_info(page.ports.env);
    results = await probe_all(page.ports.env, page.ports);
  } catch {
    results = [];
  }
  page.report = { format: COMPAT_FORMAT, date: page.date, device: page.info.user_agent ?? '', results };
  set_status(page, 'compatpg.status_done', { n: results.length });
  page.busy = false;
  page.ports.doc.getElementById(IDS.run)?.setAttribute('aria-disabled', 'false');
  render_results(page);
  return page.report;
}

function table_card(page) {
  const lang = page.lang;
  return h('section', { class: 'card', 'aria-labelledby': 'cp-table-title' },
    h('h3', { id: 'cp-table-title', text: tr(lang, 'compatpg.s_table') }),
    h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': tr(lang, 'compatpg.s_table') },
      h('table', { class: 'tbl' },
        h('caption', { class: 'sr-only', text: tr(lang, 'compatpg.s_table') }),
        h('thead', null, h('tr', null,
          h('th', { scope: 'col', text: tr(lang, 'compatpg.md_feature') }), h('th', { scope: 'col', text: tr(lang, 'compatpg.md_result') }), h('th', { scope: 'col', text: tr(lang, 'compatpg.md_detail') }))),
        h('tbody', null, page.report.results.map((r) => h('tr', null,
          h('th', { scope: 'row', text: feature_text(lang, r.id) }),
          h('td', { text: status_text(lang, r.status) }),
          h('td', { text: detail_text(lang, r) })))))),
    h('p', { class: 'muted', text: tr(lang, 'compatpg.note_manual') }));
}

/** Перерисовать только блок результатов. */
export function render_results(page) {
  const box = page.ports.doc.getElementById(IDS.results);
  if (box === null) return;
  if (page.report === null) { box.replaceChildren(); return; }
  box.replaceChildren(
    device_card(page.lang, page.info, page.report.date, { title: 'cp-dev-title' }),
    table_card(page),
    copy_card(page.lang, COPY_IDS, () => report_text(page), { env: page.ports.env, doc: page.ports.doc }));
}

export function render_page(page) {
  const doc = page.ports.doc;
  const lang = page.lang;
  const controls = h('section', { class: 'card', 'aria-labelledby': 'cp-run-title' },
    h('h3', { id: 'cp-run-title', text: tr(lang, 'compatpg.s_run') }),
    h('p', { text: tr(lang, 'compatpg.lead') }),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn primary', id: IDS.run, 'aria-disabled': page.busy ? 'true' : 'false', onclick: () => { if (page.busy) { set_status(page, 'compatpg.status_busy'); return; } void run_compat(page); }, text: tr(lang, 'compatpg.btn_run') })),
    h('p', { id: IDS.status, class: 'muted', role: 'status', 'aria-live': 'polite', text: tr(lang, page.status.key, page.status.params) }));
  doc.getElementById('main').replaceChildren(
    nav_links(lang, 'compat'),
    h('h2', { id: 'view-title', tabindex: '-1', text: tr(lang, 'compatpg.title') }),
    controls,
    h('div', { id: IDS.results }),
    h('p', { class: 'muted', text: probe_tr(lang, 'probe.disclaimer') }));
  mark_lang('cp', lang, doc);
  doc.title = tr(lang, 'compatpg.doc_title');
  render_results(page);
}

export function boot_compat(env = globalThis) {
  const ports = make_ports(env);
  const page = make_page(lang_of(env), ports);
  bind_lang_buttons('cp', (l) => { page.lang = l; render_page(page); }, ports.doc);
  render_page(page);
  return page;
}

if (typeof document !== 'undefined' && document.getElementById('cp-title-bar') !== null) boot_compat();
