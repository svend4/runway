// data_actions.mjs — действия экрана «Данные» (FP-05): файл-копия «Журнал JSON + state_hash» (runway-journal/1), CSV журнала, hledger,
// разбор файла для «Восстановить» с показом «что будет заменено» и удаление всех данных `erase_all` с квитанцией.
// REQ-094 (экспорт JSON с круговой проверкой), REQ-095 (CSV с защитой от формул), REQ-096 (hledger), REQ-097 (копия), REQ-098 (удаление), TST-38, TST-43, TST-44.
// Всё чистое: тексты файлов строятся функциями от рабочей области `ws` и записей журнала; браузерные объекты (хранилище, localStorage, кэш, сервис-воркер)
// приходят аргументами-портами. Скачивание и чтение файла — в `data_view.mjs`. Расчёт по введённым данным и правилам, не консультация.

import { ENGINE_VERSION, reduce, effective_events, state_hash, to_epoch_day, format_date, build_events, TIMELINE_DEFAULTS, analyze } from '../engine/index.mjs';
import { export_json, read_journal_json, export_csv, export_hledger, MAX_IMPORT_BYTES } from '../engine/io.mjs';
import { open_readonly, engine_version_status, workspace_format_info, KNOWN_FORMAT_VERSION } from '../engine/io_readonly.mjs';
import { ws_to_events, ws_to_state, events_to_ws, assert_safe_json } from './ws_bridge.mjs';

/** Префикс ключей localStorage, которые принадлежат приложению (всё, что оно кладёт в localStorage, начинается с него). */
export const LOCAL_PREFIX = 'runway';

/** Префикс имён кэшей (Cache Storage) приложения: «Удалить всё» трогает только их — источник localhost общий для всех проектов пользователя. */
export const CACHE_PREFIX = LOCAL_PREFIX;

const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const code_of = (e) => (e !== null && typeof e === 'object' && typeof e.code === 'string' ? e.code : 'E_SCHEMA');
const bytes_of = (text) => new TextEncoder().encode(text).length;

// ── имена файлов ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Имя файла: `runway-<вид>-<дата>.<расширение>`; дата — `ГГГГ-ММ-ДД` (иначе без даты). */
export function file_name(kind, day) {
  const ext = { journal: 'json', csv: 'csv', hledger: 'journal' }[kind];
  if (ext === undefined) throw new RangeError('вид файла: journal | csv | hledger');
  const d = typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? '-' + day : '';
  return `runway-${kind}${d}.${ext}`;
}

// ── счётчики ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** «Будет удалено N операций, M правил, K сценариев»: по рабочей области (операции — записанные факты). */
export function counts_of_ws(ws) {
  const n = (k) => (Array.isArray(ws?.[k]) ? ws[k].length : 0);
  return { operations: n('facts'), rules: n('rules'), scenarios: n('scenarios') };
}

/** То же по состоянию `State` (свёртка журнала). */
export function counts_of_state(st) {
  const n = (k) => (is_obj(st?.[k]) ? Object.keys(st[k]).length : 0);
  return { operations: n('facts'), rules: n('rules'), scenarios: n('scenarios') };
}

/** Хэш состояния записей журнала: `state_hash(reduce(effective_events(events)))`, C-071. */
export function hash_of_events(events) {
  return state_hash(reduce(effective_events(events)));
}

// ── файл-копия: журнал JSON + state_hash ─────────────────────────────────────────────────────────────────────────────

/**
 * «Скачать журнал»: файл-копия `runway-journal/1` (канонический JSON, `io.export_json`) и `state_hash` свёртки.
 * Круговая проверка: чтение файла обратно даёт то же `state_hash` (иначе — ошибка, файл не выдаётся).
 * @param {object[]} events записи журнала
 * @returns {{text: string, state_hash: string, count: number, bytes: number, counts: object}}
 * @throws {RunwayError} E_SCHEMA и др. из `export_json`; `E_SCHEMA {reason: 'roundtrip_hash_mismatch'}`, если круг не сошёлся
 */
export function export_journal_copy(events) {
  const text = export_json(events, { engine_version: ENGINE_VERSION });
  const hash = hash_of_events(events);
  const back = hash_of_events(read_journal_json(text).events);
  if (back !== hash) { const e = new Error('E_SCHEMA roundtrip_hash_mismatch'); e.code = 'E_SCHEMA'; e.ctx = { reason: 'roundtrip_hash_mismatch' }; throw e; }
  return { text, state_hash: hash, count: events.length, bytes: bytes_of(text), counts: counts_of_state(reduce(effective_events(events))) };
}

/** Записи журнала для рабочей области без собственного журнала: детерминированные (`ws_to_events`). */
export function events_of_ws(ws) {
  return ws_to_events(ws);
}

// ── CSV и hledger: файл и список потерь формата ──────────────────────────────────────────────────────────────────────

/** Что формат выразить не может: корзины рабочей области, которых нет в файле (`lost`) или которые выгружены материализованными разовыми правилами (`materialized`). */
export const FORMAT_LOSSES = Object.freeze({
  csv: Object.freeze({
    lost: ['accounts', 'rules', 'streams', 'tax_rules', 'reserves', 'allocations', 'scenarios', 'anchors', 'params', 'wave_overrides', 'purchases', 'debts', 'rates', 'calendars', 'overrides'],
    materialized: [],
  }),
  hledger: Object.freeze({
    lost: ['scenarios', 'tax_rules', 'reserves', 'allocations', 'wave_overrides', 'purchases', 'debts', 'overrides', 'calendars'],
    materialized: ['rules', 'streams'],
  }),
});

/**
 * Список потерь формата для конкретной рабочей области: `[{id, count, mode: 'lost'|'materialized'}]`, только корзины с содержимым.
 * @param {'csv'|'hledger'} format
 * @param {object} ws
 */
export function format_losses(format, ws) {
  const spec = FORMAT_LOSSES[format];
  if (spec === undefined) throw new RangeError('формат: csv | hledger');
  const size = (k) => (k === 'params' ? (is_obj(ws?.params) ? Object.keys(ws.params).length : 0) : (Array.isArray(ws?.[k]) ? ws[k].length : 0));
  const out = [];
  for (const id of spec.lost) { const count = size(id); if (count > 0) out.push({ id, count, mode: 'lost' }); }
  for (const id of spec.materialized) { const count = size(id); if (count > 0) out.push({ id, count, mode: 'materialized' }); }
  return out;
}

/**
 * CSV журнала `runway-csv/1` (REQ-095): текстовые ячейки, начинающиеся с `= + - @ TAB CR`, получают ведущий `'`; числовые колонки не меняются.
 * Рабочая область переводится в состояние через мост `ws_bridge` (массивы `ws` → записи журнала → свёртка), поэтому E_SCHEMA на массивах не возникает.
 * @param {object} ws
 * @returns {{text: string, rows: number, bytes: number, losses: object[]}}
 */
export function export_csv_file(ws) {
  const text = export_csv(ws_to_state(ws), 'journal');
  return { text, rows: Math.max(0, text.split('\n').length - 2), bytes: bytes_of(text), losses: format_losses('csv', ws) };
}

/**
 * hledger-журнал (REQ-096, ALG-14): факты, якоря, плановые разовые правила на горизонт. Плановые события берутся из `build_events` (режим `plan`);
 * если расчёт плана отказал, выгружаются только разовые планы, а причина — `planned_error` (код движка).
 * @param {object} ws
 * @param {{horizon_days?: number}} [opts]
 * @returns {{text: string, bytes: number, horizon_end: string, planned: number, planned_error: string|null, losses: object[]}}
 */
export function export_hledger_file(ws, opts = {}) {
  const st = ws_to_state(ws);
  const as_of = to_epoch_day(ws.as_of);
  const days = Number.isSafeInteger(opts.horizon_days) && opts.horizon_days >= 1 ? opts.horizon_days : (Number.isSafeInteger(ws.params?.horizon_days) && ws.params.horizon_days >= 1 ? ws.params.horizon_days : TIMELINE_DEFAULTS.horizon_days);
  const horizon_end = as_of + days;
  let planned = [];
  let planned_error = null;
  try { planned = build_events(ws, { as_of, horizon_end, mode: 'plan' }); } catch (e) { planned_error = code_of(e); planned = []; }
  const text = export_hledger(st, as_of, horizon_end, { planned });
  return { text, bytes: bytes_of(text), horizon_end: format_date(horizon_end), planned: planned.length, planned_error, losses: format_losses('hledger', ws) };
}

// ── «Восстановить»: разбор файла и показ «что будет заменено» ─────────────────────────────────────────────────────────

/**
 * Разобрать выбранный файл. Понимает файл-копию `runway-journal/N` и прежний JSON рабочей области (набор данных демо).
 * Файл НОВЕЕ известного формата (`runway-journal/N`, N больше известного) и файл с записями новее известных версий (FP-17, REQ-016) не отвергаются:
 * они открываются «только для просмотра» — `read_only: true`, записи, которые эта версия не умеет читать, пропущены (`read_only_info.skipped`), хранилище и
 * журнал не меняются, текст файла не меняется. Исключение — файл, из которого нечего показать (нет ни одной читаемой записи): отказ, как раньше.
 * Версия движка в файле сравнивается с текущей: расхождение — предупреждение (`engine.warn`), а не отказ.
 * @param {string} text содержимое файла
 * @returns {{ok: true, kind: 'journal', ws: object, events: object[], hash: string, counts: object, format: string, engine_version: string|null, bytes: number,
 *     engine: {status: string, warn: boolean, file: string|null, current: string}, read_only?: true,
 *     read_only_info?: {newer_format: boolean, format: string, format_version: number, known_version: number, skipped: number, source: 'file'}}
 *   | {ok: true, kind: 'workspace', ws: object, hash: null, counts: object, bytes: number, read_only?: true, read_only_info?: object}
 *   | {ok: false, error: string, ctx?: object}} ошибки: `too_big`, `bad_json`, `not_a_copy`, коды движка (`E_SCHEMA`, …); текст файла в ошибку не попадает
 */
export function inspect_import(text) {
  if (typeof text !== 'string') return { ok: false, error: 'bad_json' };
  const bytes = bytes_of(text);
  if (bytes > MAX_IMPORT_BYTES) return { ok: false, error: 'too_big', ctx: { bytes, max: MAX_IMPORT_BYTES } };
  let obj;
  try { obj = JSON.parse(text); } catch { return { ok: false, error: 'bad_json' }; }
  if (!is_obj(obj)) return { ok: false, error: 'not_a_copy' };
  try {
    // у файла рабочей области тоже бывает поле `format` (набор G-001 несёт «runway-journal/1»): журнал узнаётся по записям (`events`)
    if (typeof obj.format === 'string' && obj.format.startsWith('runway-journal/') && Object.hasOwn(obj, 'events')) {
      const j = open_readonly(text); // разбор без апкаста и без записи; формат/форма записей проверены так же, как в `read_journal_json`
      const engine = engine_version_status(j.engine_version, ENGINE_VERSION);
      if (j.read_only && j.usable_events.length === 0) {
        // показывать нечего: прежний отказ (формат новее — `newer_format`, записи новее — `newer_version`, неизвестный тип записи — `unknown_type`)
        return { ok: false, error: 'E_SCHEMA', ctx: { reason: j.newer_format ? 'newer_format' : j.skipped.newer_version > 0 ? 'newer_version' : 'unknown_type' } };
      }
      const events = j.read_only ? j.usable_events : j.events;
      const state = reduce(effective_events(events));
      const hash = state_hash(state);
      const ws = events_to_ws(events);
      const out = { ok: true, kind: 'journal', ws, events, hash, counts: counts_of_state(state), format: j.format, engine_version: j.engine_version, engine, bytes };
      if (j.read_only) {
        out.read_only = true;
        out.read_only_info = { newer_format: j.newer_format, format: j.format, format_version: j.format_version, known_version: KNOWN_FORMAT_VERSION, skipped: j.skipped.total, source: 'file' };
        // пропущенная запись может оказаться основной (счёт, профиль): тогда прогноз не построить, и диалог не обещает его, а называет причину словами
        const bad = forecast_probe(ws);
        if (bad !== null) { out.unusable = true; out.read_only_info.unusable = bad.slice(0, 40); }
      }
      return out;
    }
    if (typeof obj.as_of === 'string') {
      assert_safe_json(obj, 'workspace');
      const out = { ok: true, kind: 'workspace', ws: obj, hash: null, counts: counts_of_ws(obj), bytes };
      const fi = workspace_format_info(obj);
      if (fi !== null && fi.newer) {
        out.read_only = true;
        out.read_only_info = { newer_format: true, format: fi.format, format_version: fi.version, known_version: KNOWN_FORMAT_VERSION, skipped: 0, source: 'file' };
        const bad = forecast_probe(obj);
        if (bad !== null) { out.unusable = true; out.read_only_info.unusable = bad.slice(0, 40); }
      }
      return out;
    }
  } catch (e) { return { ok: false, error: code_of(e), ctx: is_obj(e?.ctx) && typeof e.ctx.reason === 'string' ? { reason: e.ctx.reason.slice(0, 40) } : undefined }; }
  return { ok: false, error: 'not_a_copy' };
}

/**
 * Строится ли прогноз по читаемой части файла новее известного формата (FP-17)? Пропущенная запись может оказаться основной (счёт, профиль): тогда открывать нечего,
 * и об этом надо сказать до диалога, а не после нажатия кнопки. Возвращает `null` (строится) или код отказа движка. Файл не меняется, ничего не пишется.
 * @param {object} ws рабочая область из читаемых записей
 * @returns {string|null}
 */
export function forecast_probe(ws) {
  try { analyze(ws, { as_of: ws?.as_of }); return null; } catch (e) { return code_of(e); }
}

/**
 * «Что будет заменено»: счётчики сейчас и в файле, совпадает ли состояние (по `state_hash`, если он известен с обеих сторон).
 * @param {{counts: object, hash?: string|null, count?: number}} current
 * @param {{counts: object, hash?: string|null}} incoming
 */
export function restore_preview(current, incoming) {
  const keys = ['operations', 'rules', 'scenarios'];
  const rows = keys.map((k) => ({ id: k, now: current.counts?.[k] ?? 0, incoming: incoming.counts?.[k] ?? 0 }));
  const same = typeof current.hash === 'string' && typeof incoming.hash === 'string' && current.hash === incoming.hash;
  return { rows, same_state: same, replaces_all: true };
}

// ── удаление всех данных ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * «Будет удалено N операций, M правил, K сценариев»: счётчики перед `erase_all`.
 * @param {object} ws рабочая область страницы
 * @param {{count?: number}} [stat] «голова» журнала в хранилище (число записей)
 */
export function erase_preview(ws, stat) {
  const c = counts_of_ws(ws);
  return { ...c, events: Number.isSafeInteger(stat?.count) ? stat.count : 0 };
}

/** Ключи localStorage, принадлежащие приложению. */
function app_keys(storage) {
  const keys = [];
  const n = Number.isSafeInteger(storage.length) ? storage.length : 0;
  for (let i = 0; i < n; i++) { const k = storage.key(i); if (typeof k === 'string' && k.startsWith(LOCAL_PREFIX)) keys.push(k); }
  return keys;
}

/**
 * Удалить все данные приложения на устройстве (REQ-098): записи, снимки и метаданные хранилища (с базой), ключи localStorage приложения,
 * кэши оболочки и регистрации сервис-воркера. Повторный вызов не ошибается. Файлы-копии у пользователя остаются — об этом квитанция предупреждает всегда.
 * Каждый шаг изолирован: сбой одного не мешает остальным и попадает в `errors` кодом (`erased: false`).
 * @param {{store?: object|null, storage?: object|null, session_storage?: object|null, caches?: object|null, service_worker?: object|null,
 *   file_target?: {destroy: () => Promise<{removed: number}>}|null, channel?: {post: Function}|null, today: () => string}} ports
 * @param {{counts?: {operations: number, rules: number, scenarios: number}, events?: number}} [opts] счётчики, показанные пользователю до удаления
 * @returns {Promise<{erased: boolean, date: string, counts: object, stores: object[], copies_warning: true, errors: string[]}>}
 */
export async function erase_all(ports, opts = {}) {
  const errors = [];
  const stores = [];
  const step = async (name, fn) => {
    try { stores.push({ name, ...(await fn()) }); } catch (e) {
      errors.push(name + ':' + (typeof e?.code === 'string' ? e.code : 'failed'));
      stores.push({ name, cleared: false });
    }
  };
  const counts = { operations: opts.counts?.operations ?? 0, rules: opts.counts?.rules ?? 0, scenarios: opts.counts?.scenarios ?? 0, events: opts.events ?? 0 };

  if (ports.store !== undefined && ports.store !== null) {
    await step('store', async () => {
      await ports.store.clear();
      const after = await ports.store.stat(); // проверка до снятия базы: чтение даёт пусто (после снятия чтение заново создало бы пустую базу)
      if (after.count !== 0 || after.snapshots !== 0 || after.meta_keys.length !== 0) throw Object.assign(new Error('not_empty'), { code: 'store_not_empty' });
      await ports.store.destroy();
      return { kind: ports.store.kind, cleared: true };
    });
  }
  // ссылка на файл-копию (FP-19, REQ-097): отдельная база `runway-handles` с запомненным `FileSystemFileHandle`; сам файл у пользователя остаётся (квитанция предупреждает о копиях всегда)
  if (ports.file_target !== undefined && ports.file_target !== null && typeof ports.file_target.destroy === 'function') {
    await step('file_target', async () => {
      const r = await ports.file_target.destroy();
      return { cleared: true, removed: Number.isSafeInteger(r?.removed) ? r.removed : 0 };
    });
  }
  for (const [name, storage] of [['local_storage', ports.storage], ['session_storage', ports.session_storage]]) {
    if (storage === undefined || storage === null) continue;
    await step(name, async () => {
      const keys = app_keys(storage);
      for (const k of keys) storage.removeItem(k);
      return { removed: keys.length, cleared: app_keys(storage).length === 0 };
    });
  }
  // Источник (origin) у страниц на localhost общий для ВСЕХ проектов пользователя: удаляем только СВОЁ.
  // Кэши — по префиксу CACHE_PREFIX; сервис-воркеры — только из области own_scope (без неё не снимаем ни одного).
  if (ports.caches !== undefined && ports.caches !== null && typeof ports.caches.keys === 'function') {
    await step('cache', async () => {
      const all = await ports.caches.keys();
      const names = all.filter((n) => typeof n === 'string' && n.startsWith(CACHE_PREFIX));
      for (const n of names) await ports.caches.delete(n);
      return { removed: names.length, cleared: true, foreign_kept: all.length - names.length };
    });
  }
  if (ports.service_worker !== undefined && ports.service_worker !== null && typeof ports.service_worker.getRegistrations === 'function') {
    await step('service_worker', async () => {
      const all = await ports.service_worker.getRegistrations();
      const own_scope = typeof ports.own_scope === 'string' && ports.own_scope !== '' ? ports.own_scope : null;
      const own = all.filter((r) => own_scope !== null && typeof r?.scope === 'string' && r.scope.startsWith(own_scope));
      for (const r of own) await r.unregister();
      return { removed: own.length, cleared: true, foreign_kept: all.length - own.length };
    });
  }
  if (ports.channel !== undefined && ports.channel !== null) { try { ports.channel.post('erased', { count: 0, last_seq: 0 }); } catch { /* вкладки узнают при следующем чтении */ } }

  return { erased: errors.length === 0, date: typeof ports.today === 'function' ? ports.today() : null, counts, stores, copies_warning: true, errors };
}
