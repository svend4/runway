// open_quarantine.mjs — открытие чужого файла с карантином записей (FP-22, REQ-158, Q-22, N-3, TST-51).
//
// Что было. `app.import_file` разбирал файл сам и отдавал рабочую область прямо в `analyze`: один невалидный объект (правило с `interval = 0`, налоговая ставка 99999 bp, факт
// с неизвестным счётом) ронял расчёт, и отвергался ВЕСЬ файл — хотя в движке уже был режим карантина (`validate_ws.quarantine_invalid`, Q-22).
// Что стало. Файл идёт по цепочке: `inspect_import` (размер, JSON, форма, ключи-«ловушки», журнал или рабочая область, формат новее известного) → `validate_ws` (строгая проверка;
// чистый файл открывается как есть, побайтно прежней рабочей областью) → при нарушении `quarantine_invalid`: невалидные записи исключаются и перечисляются, ссылки на исключённое
// проверяются каскадно, остальное считается → контрольный `analyze_checked`. Файл отвергается целиком только при нарушении схемы верхнего уровня (не объект, формат из будущего без
// читаемого, неверный `as_of`, пределы размеров) или если расчёт невозможен и после карантина — тогда данные в приложении не меняются.
//
// Что видит пользователь. Перечень отброшенного (раздел, идентификатор, код, причина) — на экране «Данные» (`quarantine_node`) и в журнале приложения (`log.mjs`: по записи
// `record_quarantined` с идентификатором до 32 знаков и кодом, итог `file_quarantine` с числом). Текст файла в журнал и в сообщения не попадает; идентификаторы чужого файла выводятся
// только через `textContent`. Файл на диске не меняется.
//
// Модуль не зависит от `app.mjs`. Узел перечня строит `dom.mjs` (без inline-стилей и обработчиков-строк). Расчёт по введённым данным и правилам, не консультация.

import { validate_ws, quarantine_invalid, analyze_checked } from '../engine/validate_ws.mjs';
import { inspect_import } from './data_actions.mjs';
import { h, table } from './dom.mjs';
import { log } from './log.mjs';

/** Сколько отброшенных записей перечисляется на экране (остальные — одной строкой «и ещё N»). */
export const MAX_LISTED = 50;
/** Сколько отброшенных записей пишется в журнал приложения отдельными записями. */
export const MAX_LOGGED = 50;

/** Разделы, для которых есть своя подпись (остальные — «Прочее»). */
export const KINDS = Object.freeze(['accounts', 'calendars', 'reserves', 'rules', 'streams', 'anchors', 'facts', 'plans', 'overrides', 'tax_rules', 'allocations', 'rates', 'scenarios', 'purchases', 'debts', 'wave_overrides', 'counterparties']);

const CODE_OK = /^[A-Za-z][A-Za-z0-9_.:-]{0,31}$/;
const REASON_BAD = /[^A-Za-z0-9_.:-]/g;
const CTRL = /[\u0000-\u001f\u007f-\u009f]/g;

/** Идентификатор чужой записи для показа: без управляющих знаков, не длиннее 60; пусто — `null`. Это текст из недоверенного файла: выводить только через `textContent`. */
function show_id(x) {
  if (typeof x !== 'string') return null;
  const s = x.replace(CTRL, ' ').trim().slice(0, 60);
  return s === '' ? null : s;
}

/** Привести запись карантина движка к виду для показа: известный раздел, код и причина из безопасных знаков. */
export function clean_rejected(list) {
  const out = [];
  for (const r of Array.isArray(list) ? list : []) {
    if (r === null || typeof r !== 'object') continue;
    const codes = (Array.isArray(r.codes) ? r.codes : []).filter((c) => typeof c === 'string' && CODE_OK.test(c)).slice(0, 4);
    const reasons = (Array.isArray(r.reasons) ? r.reasons : []).map((x) => String(x ?? '').replace(REASON_BAD, '?').slice(0, 40)).filter((x) => x !== '').slice(0, 4);
    out.push({ kind: KINDS.includes(r.kind) ? r.kind : 'other', id: show_id(r.id), codes: codes.length === 0 ? ['E_SCHEMA'] : codes, reasons });
  }
  return out;
}

/** Причина отказа файла для сообщения: только безопасные знаки, до 40. */
function reason_of(f) {
  const r = typeof f?.reason === 'string' ? f.reason.replace(REASON_BAD, '?').slice(0, 40) : '';
  return r === '' ? 'schema' : r;
}

/** Записать перечень отброшенного в журнал приложения: итог и записи (идентификатор до 32 знаков, код). Не бросает. */
function write_log(logger, rejected) {
  try {
    logger.warn('file_quarantine', { n: rejected.length });
    for (const r of rejected.slice(0, MAX_LOGGED)) logger.warn('record_quarantined', { ...(r.id === null ? {} : { id: r.id }), code: r.codes[0] });
  } catch { /* журнал не должен ломать открытие файла */ }
}

/**
 * Открыть недоверенный файл (текст) по цепочке «разбор → проверка → карантин». Не бросает.
 * @param {string} text содержимое файла
 * @param {{logger?: {warn: Function}}} [opts] `logger` — журнал приложения (по умолчанию `log.mjs`)
 * @returns {{ok: true, ws: object, kind: 'journal'|'workspace', quarantined: boolean, rejected: {kind: string, id: string|null, codes: string[], reasons: string[]}[], params_replaced: number,
 *     warnings: object[], read_only: object|null}
 *   | {ok: false, error: string, ctx?: object, stage: 'file'|'calc'}} ошибки: `too_big`, `bad_json`, `not_a_copy`, коды движка (`E_SCHEMA`, …); текст файла в ошибку не попадает
 */
export function open_foreign(text, opts = {}) {
  const logger = opts.logger ?? log;
  // stage: 'file' — нарушена схема верхнего уровня или файл не разобран; 'calc' — файл разобран, но расчёт невозможен и после карантина
  const refuse = (error, ctx, stage = 'file') => {
    try { logger.warn('file_rejected', { code: CODE_OK.test(error) ? error : 'E_SCHEMA' }); } catch { /* журнал не обязателен */ }
    return ctx === undefined ? { ok: false, error, stage } : { ok: false, error, ctx, stage };
  };
  try {
    const parsed = inspect_import(text);
    if (!parsed.ok) return refuse(parsed.error, parsed.ctx);
    const ws = parsed.ws;
    if (ws === null || typeof ws !== 'object' || Array.isArray(ws) || typeof ws.as_of !== 'string') return refuse('E_SCHEMA', { reason: 'as_of' });
    const read_only = parsed.read_only === true && parsed.read_only_info !== undefined ? parsed.read_only_info : null;
    const base = { kind: parsed.kind, read_only };

    // файл новее известного формата открывается только для просмотра (FP-17): поле `format` из будущего проверку записей не должно останавливать, поэтому проверяется копия без него
    const probe = read_only !== null && Object.hasOwn(ws, 'format') ? Object.fromEntries(Object.entries(ws).filter(([k]) => k !== 'format')) : ws;
    const strict = validate_ws(probe, { as_of: ws.as_of });
    if (strict.ok) {
      const direct = analyze_checked(probe, { as_of: ws.as_of }); // расчёт невозможен и на чистых данных (нет счёта, курса): отказ с кодом, а не исключение при показе
      if (!direct.ok) return refuse(CODE_OK.test(direct.code) ? direct.code : 'E_SCHEMA', { reason: 'calc' }, 'calc');
      return { ok: true, ws, ...base, quarantined: false, rejected: [], params_replaced: 0, warnings: strict.warnings ?? [] };
    }

    const q = quarantine_invalid(probe, { as_of: ws.as_of });
    if (!q.ok) {
      const f = q.fatal[0];
      return refuse(typeof f?.code === 'string' && CODE_OK.test(f.code) ? f.code : 'E_SCHEMA', { reason: reason_of(f) });
    }
    const check = analyze_checked(q.ws_clean, { as_of: ws.as_of });
    if (!check.ok) return refuse(CODE_OK.test(check.code) ? check.code : 'E_SCHEMA', { reason: 'after_quarantine' }, 'calc');
    const rejected = clean_rejected(q.rejected);
    const params_replaced = q.warnings.filter((w) => w?.code === 'W_PARAM_OUT_OF_RANGE').length;
    if (rejected.length > 0) write_log(logger, rejected);
    return { ok: true, ws: q.ws_clean, ...base, quarantined: rejected.length > 0 || params_replaced > 0, rejected, params_replaced, warnings: q.warnings };
  } catch (e) {
    return refuse(typeof e?.code === 'string' && CODE_OK.test(e.code) ? e.code : 'E_SCHEMA', { reason: 'internal' });
  }
}

/** Подпись раздела отброшенной записи. */
export function kind_label(tr, kind) {
  return tr('quarantine.kind_' + (KINDS.includes(kind) ? kind : 'other'));
}

/**
 * Сообщение о том, что файл открыт с карантином (одна строка для заметки экрана «Данные»); пусто, если нечего сказать.
 * @param {(key: string, params?: object) => string} tr
 * @param {{rejected: object[], params_replaced?: number}} r результат `open_foreign`
 */
export function quarantine_notice(tr, r) {
  const n = r.rejected.length;
  if (n === 0) return '';
  const text = tr('quarantine.notice', { n });
  return text === 'quarantine.notice' ? '' : text; // каталог пакета не загружен: перечня нет, файл всё равно открыт
}

/**
 * Сообщение об отказе открыть файл при нарушении схемы верхнего уровня (код движка и причина из безопасных знаков).
 * @param {(key: string, params?: object) => string} tr
 * @param {{ctx?: {reason?: string}}} r
 */
export function refused_notice(tr, r) {
  const text = tr('quarantine.refused', { reason: typeof r.ctx?.reason === 'string' ? r.ctx.reason : 'schema' });
  return text === 'quarantine.refused' ? tr('dt.import_bad') : text; // каталог пакета не загружен: прежнее общее сообщение
}

/**
 * Раздел «Отброшено при открытии файла» для экрана «Данные»: таблица (раздел, запись, код, причина), число лишних, замена параметров, пометка о журнале.
 * @param {(key: string, params?: object) => string} tr
 * @param {{rejected: object[], params_replaced?: number}|null} q результат карантина (`rejected` пуст и параметров не заменено — раздела нет)
 * @returns {HTMLElement|null}
 */
export function quarantine_node(tr, q) {
  if (q === null || q === undefined) return null;
  const rejected = Array.isArray(q.rejected) ? q.rejected : [];
  const params = Number.isSafeInteger(q.params_replaced) ? q.params_replaced : 0;
  if (rejected.length === 0 && params === 0) return null;
  const rows = rejected.slice(0, MAX_LISTED).map((r) => h('tr', null,
    h('th', { scope: 'row', text: kind_label(tr, r.kind) }),
    h('td', { text: r.id === null ? tr('quarantine.id_none') : r.id }),
    h('td', { text: r.codes.join(', ') }),
    h('td', { text: r.reasons.join(', ') })));
  return h('section', { id: 'quarantine', class: 'card quarantine', 'aria-labelledby': 'quarantine-title' },
    h('h3', { id: 'quarantine-title', text: tr('quarantine.title') }),
    h('p', { text: tr('quarantine.lead') }),
    rejected.length === 0 ? null : h('div', { class: 'table-wrap' },
      table(tr('quarantine.caption'), [tr('quarantine.col_kind'), tr('quarantine.col_id'), tr('quarantine.col_code'), tr('quarantine.col_reason')], rows, 'tbl')),
    rejected.length > MAX_LISTED ? h('p', { class: 'muted', text: tr('quarantine.more', { n: rejected.length - MAX_LISTED }) }) : null,
    params === 0 ? null : h('p', { class: 'muted', text: tr('quarantine.params', { n: params }) }),
    rejected.length === 0 ? null : h('p', { class: 'muted', text: tr('quarantine.logged') }));
}
