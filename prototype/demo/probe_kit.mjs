// probe_kit.mjs — общие помощники трёх страниц проверки на устройстве (FP-23): bench.html, coldstart.html, compat.html.
// Страницы отдельные (не часть приложения): у них нет реестра расширений, мастера и хранилища; каждая читает свой каталог строк напрямую (`make_tr`) и строит узлы через `h` из dom.mjs
// (только textContent и узлы, ни разметки из строк, ни inline-стилей, ни обработчиков-строк).
// Здесь — строка браузера и сведения об устройстве, дата, карточка «Устройство и дата», навигация между страницами, блок «Скопировать результат».
// Строка браузера (`navigator.userAgent`) показывается только на экране и в копируемом тексте; страницы её никуда не отправляют (у bench.html единственное сетевое обращение — чтение набора G-001
// с того же хоста; у coldstart.html и compat.html сети нет вовсе).
// Все порты внедряются (`env`, `clock`, `clipboard`) — модуль проверяется в Node на заглушках. Расчёт по введённым данным и правилам, не консультация.

import { h } from './dom.mjs';
import catalog from './i18n/probe.mjs';

function fill(table, key, params) {
  const raw = Object.hasOwn(table, key) ? table[key] : undefined;
  if (raw === undefined) return key;
  return params === undefined ? raw : raw.replace(/\{([A-Za-z0-9_]+)\}/g, (m, name) => (Object.hasOwn(params, name) ? String(params[name]) : m));
}

/** Построить `tr(lang, key, params)` над каталогом `{ru, en}`; неизвестный ключ виден как есть, неизвестный язык читается как русский. */
export function make_tr(cat) {
  return (lang, key, params) => fill(cat[lang] ?? cat.ru, key, params);
}

/** Строки общего каталога `probe.*`. */
export const tr = make_tr(catalog);

/** Страницы проверки (и приложение): порядок в навигации. */
export const PAGES = Object.freeze([
  Object.freeze({ id: 'app', href: './index.html', key: 'probe.nav_app' }),
  Object.freeze({ id: 'bench', href: './bench.html', key: 'probe.nav_bench' }),
  Object.freeze({ id: 'cold', href: './coldstart.html', key: 'probe.nav_cold' }),
  Object.freeze({ id: 'compat', href: './compat.html', key: 'probe.nav_compat' }),
]);

/** Язык страницы по языку браузера (как у калькулятора v0): английский только для `en*`. */
export function lang_of(env = globalThis) {
  return /^en/i.test(env?.navigator?.language ?? '') ? 'en' : 'ru';
}

/** Местная календарная дата `ГГГГ-ММ-ДД` (по часам устройства): единственное место, где страницы читают часы для даты. */
export function local_date_iso(clock = () => new Date()) {
  const d = clock();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

const str_or_null = (x) => (typeof x === 'string' && x !== '' ? x : null);
const num_or_null = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/**
 * Сведения об устройстве из окна-подобного объекта (`window` или заглушка). Недоступное — `null`. Ничего не отправляется.
 * @param {object} [env]
 */
export function device_info(env = globalThis) {
  const nav = env?.navigator ?? {};
  const scr = env?.screen ?? {};
  const w = num_or_null(scr.width);
  const hgt = num_or_null(scr.height);
  return {
    user_agent: str_or_null(nav.userAgent),
    language: str_or_null(nav.language),
    platform: str_or_null(nav.userAgentData?.platform) ?? str_or_null(nav.platform),
    cores: num_or_null(nav.hardwareConcurrency),
    memory_gb: num_or_null(nav.deviceMemory),
    screen: w !== null && hgt !== null ? w + '×' + hgt : null,
    pixel_ratio: num_or_null(env?.devicePixelRatio),
    secure_context: typeof env?.isSecureContext === 'boolean' ? env.isSecureContext : null,
    online: typeof nav.onLine === 'boolean' ? nav.onLine : null,
  };
}

const yes_no = (lang, v) => (v === null ? tr(lang, 'probe.unknown') : tr(lang, v ? 'probe.yes' : 'probe.no'));

/** Строки таблицы «Устройство и дата»: пары `[подпись, значение]` (значения — строки для показа). */
export function device_rows(lang, info, date) {
  const val = (x) => (x === null ? tr(lang, 'probe.unknown') : String(x));
  return [
    [tr(lang, 'probe.row_date'), date],
    [tr(lang, 'probe.row_ua'), val(info.user_agent)],
    [tr(lang, 'probe.row_platform'), val(info.platform)],
    [tr(lang, 'probe.row_lang'), val(info.language)],
    [tr(lang, 'probe.row_cores'), val(info.cores)],
    [tr(lang, 'probe.row_memory'), info.memory_gb === null ? tr(lang, 'probe.unknown') : tr(lang, 'probe.memory_val', { gb: info.memory_gb })],
    [tr(lang, 'probe.row_screen'), val(info.screen)],
    [tr(lang, 'probe.row_ratio'), val(info.pixel_ratio)],
    [tr(lang, 'probe.row_secure'), yes_no(lang, info.secure_context)],
    [tr(lang, 'probe.row_online'), yes_no(lang, info.online)],
  ];
}

/** Карточка «Устройство и дата». */
export function device_card(lang, info, date, ids = { title: 'probe-dev-title' }) {
  return h('section', { class: 'card', 'aria-labelledby': ids.title },
    h('h3', { id: ids.title, text: tr(lang, 'probe.s_device') }),
    h('table', { class: 'tbl' },
      h('caption', { class: 'sr-only', text: tr(lang, 'probe.s_device') }),
      h('tbody', null, device_rows(lang, info, date).map(([k, v]) => h('tr', null, h('th', { scope: 'row', text: k }), h('td', { text: v }))))),
    h('p', { class: 'muted', text: tr(lang, 'probe.device_note') }));
}

/** Навигация между страницами проверки и приложением; текущая страница помечена `aria-current`. */
export function nav_links(lang, current) {
  return h('nav', { class: 'probe-nav', 'aria-label': tr(lang, 'probe.nav_label') },
    h('ul', { class: 'plain probe-nav-list' }, PAGES.map((p) => h('li', null, h('a', { href: p.href, 'aria-current': p.id === current ? 'page' : null, text: tr(lang, p.key) })))));
}

/**
 * Записать текст в буфер обмена. `'copied'` — записано; `'manual'` — буфера обмена нет или он отказал (страница выделяет текст, копирует человек).
 * @param {string} text
 * @param {object} [env]
 * @returns {Promise<'copied'|'manual'>}
 */
export async function copy_text(text, env = globalThis) {
  const cb = env?.navigator?.clipboard;
  if (cb === undefined || cb === null || typeof cb.writeText !== 'function') return 'manual';
  try { await cb.writeText(text); return 'copied'; } catch { return 'manual'; }
}

/**
 * Блок «Скопировать результат»: подпись, текстовое поле только для чтения и кнопка. Текст берётся из `get_text` в момент нажатия; результат нажатия
 * показывается в строке состояния (`ids.status`), которую ищут по идентификатору при каждом ответе (узел мог быть пересоздан перерисовкой).
 * @param {string} lang
 * @param {{out: string, btn: string, status: string}} ids
 * @param {() => string} get_text
 * @param {{env?: object, doc?: object}} [ports]
 */
export function copy_card(lang, ids, get_text, ports = {}) {
  const env = ports.env ?? globalThis;
  const area = h('textarea', { id: ids.out, class: 'probe-out', readonly: true, rows: 14, spellcheck: 'false', wrap: 'off' });
  area.value = get_text();
  const doc = ports.doc ?? globalThis.document;
  const on_copy = async () => {
    const text = get_text();
    const field = doc.getElementById(ids.out);
    if (field !== null) field.value = text;
    const how = await copy_text(text, env);
    if (how === 'manual' && field !== null) {
      if (typeof field.focus === 'function') field.focus();
      if (typeof field.select === 'function') field.select();
    }
    const status = doc.getElementById(ids.status);
    if (status !== null) status.textContent = tr(lang, how === 'copied' ? 'probe.copied' : 'probe.copy_manual');
  };
  return h('section', { class: 'card', 'aria-labelledby': ids.out + '-title' },
    h('h3', { id: ids.out + '-title', text: tr(lang, 'probe.s_copy') }),
    h('label', { for: ids.out, class: 'muted', text: tr(lang, 'probe.out_label') }),
    area,
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', id: ids.btn, onclick: on_copy, text: tr(lang, 'probe.copy') })),
    h('p', { id: ids.status, class: 'muted', role: 'status', 'aria-live': 'polite', text: '' }));
}

/** Отдать управление браузеру на один тик (интерфейс успевает перерисоваться между тяжёлыми шагами). */
export function yield_to_ui(set_timeout = (fn, ms) => setTimeout(fn, ms)) {
  return new Promise((resolve) => { set_timeout(resolve, 0); });
}

/** Подписать переключатель RU/EN: кнопки `<префикс>-lang-ru` и `<префикс>-lang-en` в шапке страницы. */
export function bind_lang_buttons(prefix, on_lang, doc = globalThis.document) {
  for (const l of ['ru', 'en']) doc.getElementById(prefix + '-lang-' + l)?.addEventListener('click', () => on_lang(l));
}

/** Отметить нажатую кнопку языка и язык документа. */
export function mark_lang(prefix, lang, doc = globalThis.document) {
  for (const l of ['ru', 'en']) doc.getElementById(prefix + '-lang-' + l)?.setAttribute('aria-pressed', String(l === lang));
  doc.documentElement.lang = lang;
}

/** Показ числа мс в тексте: до сотых, десятичный знак по языку. */
export function ms_text(lang, x) {
  if (x === null || x === undefined || !Number.isFinite(x)) return tr(lang, 'probe.unknown');
  const s = (Math.round(x * 100) / 100).toString();
  return lang === 'ru' ? s.replace('.', ',') : s;
}
