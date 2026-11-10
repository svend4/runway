// backup.mjs — когда напомнить о файле-копии и какие баннеры показать (FP-05, REQ-097, REQ-122, IDEA-61, IDEA-68).
// Чистая модель: считает по числам, которые приходят аргументами (записи без копии, дни без копии, ответ `persist()`, «установлено как приложение»),
// часов не читает. Пороги — `backup.remind_events` (50) и `backup.remind_days` (7): гипотезы из `vocab.json` (X10, C-096), их можно задать в `ws.params`.
// Баннер — не обещание: он говорит о риске потери данных на устройстве и предлагает сделать файл-копию.

import { to_epoch_day } from '../engine/dates.mjs';
import { vdefault } from '../engine/param_defaults.mjs';

/** Значения по умолчанию: читаются из `vocab.json → params` через `vocab.generated.mjs` (FP-17, REQ-019); литералов здесь нет, тест сверяет с файлом. */
export const BACKUP_DEFAULTS = Object.freeze({ 'backup.remind_events': vdefault('backup.remind_events'), 'backup.remind_days': vdefault('backup.remind_days') });

/** Ключ метаданных хранилища: последняя файл-копия `{day, count, hash}`. */
export const META_LAST_BACKUP = 'last_backup';
/** Ключ метаданных: день, когда журнал впервые записан в хранилище. */
export const META_CREATED_DAY = 'created_day';
/** Ключ метаданных: число записей журнала на момент первой записи (то, что пришло не от пользователя: набор данных). */
export const META_ORIGIN_COUNT = 'origin_count';

const pos_int = (x, fallback) => (Number.isSafeInteger(x) && x >= 1 ? x : fallback);

/**
 * Пороги напоминания: `ws.params` важнее значений по умолчанию; негодное значение — значение по умолчанию.
 * @param {object} [ws_params] `ws.params`
 * @returns {{remind_events: number, remind_days: number}}
 */
export function backup_params(ws_params) {
  const p = ws_params !== null && typeof ws_params === 'object' ? ws_params : {};
  return {
    remind_events: pos_int(p['backup.remind_events'], BACKUP_DEFAULTS['backup.remind_events']),
    remind_days: pos_int(p['backup.remind_days'], BACKUP_DEFAULTS['backup.remind_days']),
  };
}

/**
 * Пора ли напомнить о копии. Срабатывает на `remind_events`-й записи без копии и на `remind_days`-й день без копии
 * (на 49-й записи и на 6-й день — нет). День без новых записей напоминания не даёт: копировать нечего.
 * @param {{events_since: number, days_since: number}} st записи и дни с последней копии (или с создания, если копии не было)
 * @param {{remind_events?: number, remind_days?: number}} [params]
 * @returns {{due: boolean, reason: 'events'|'days'|null, by_events: boolean, by_days: boolean, events_since: number, days_since: number, remind_events: number, remind_days: number}}
 */
export function backup_due(st, params) {
  const remind_events = pos_int(params?.remind_events, BACKUP_DEFAULTS['backup.remind_events']);
  const remind_days = pos_int(params?.remind_days, BACKUP_DEFAULTS['backup.remind_days']);
  const events_since = Number.isFinite(st?.events_since) ? Math.max(0, Math.trunc(st.events_since)) : 0;
  const days_since = Number.isFinite(st?.days_since) ? Math.max(0, Math.trunc(st.days_since)) : 0;
  const by_events = events_since >= remind_events;
  const by_days = events_since >= 1 && days_since >= remind_days;
  return { due: by_events || by_days, reason: by_events ? 'events' : by_days ? 'days' : null, by_events, by_days, events_since, days_since, remind_events, remind_days };
}

const day_of = (iso) => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? to_epoch_day(iso) : null);

/**
 * Записи и дни с последней копии из метаданных хранилища.
 * @param {{count: number, today: string, last_backup?: {day: string, count: number}|null, origin_count?: number|null, created_day?: string|null}} s
 *   `count` — записей в журнале сейчас; `today` — сегодня (`ГГГГ-ММ-ДД`, приходит портом)
 * @returns {{events_since: number, days_since: number}}
 */
export function backup_counters(s) {
  const lb = s.last_backup ?? null;
  const base_count = lb !== null && Number.isSafeInteger(lb.count) ? lb.count : (Number.isSafeInteger(s.origin_count) ? s.origin_count : 0);
  const from = day_of(lb !== null ? lb.day : s.created_day);
  const now = day_of(s.today);
  return {
    events_since: Math.max(0, (Number.isSafeInteger(s.count) ? s.count : 0) - base_count),
    days_since: from === null || now === null ? 0 : Math.max(0, now - from),
  };
}

/**
 * Запись о копии для метаданных: день, число записей и хэш состояния. `via: 'file'` (FP-19, REQ-097) помечает копию, записанную автозаписью в выбранный файл:
 * такая запись так же сбрасывает счётчики напоминания (`backup_counters` читает только `day` и `count`), а у ручной выгрузки поля `via` нет — её вид прежний.
 */
export function make_backup_record({ day, count, hash, via }) {
  if (day_of(day) === null) throw new RangeError('день копии: ГГГГ-ММ-ДД');
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('число записей копии');
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw new RangeError('хэш состояния копии');
  if (via !== undefined && via !== 'file') throw new RangeError('способ копии: file');
  return via === 'file' ? { day, count, hash, via } : { day, count, hash };
}

/** Причины баннера «сделайте файл-копию», по важности. */
export const BANNER_REASONS = Object.freeze(['due', 'volatile', 'persist_denied', 'persist_unknown', 'not_installed']);

/**
 * Причины баннера, связанные с автозаписью в файл-копию (FP-19, REQ-097): браузер не даёт писать в выбранный файл (`file_permission`)
 * или запись не удалась (`file_failed`). Они стоят сразу после `due` и входят в `backup_banner`, только если передана фаза автозаписи (`file_phase`).
 * Отдельная константа: перечень `BANNER_REASONS` без автозаписи остаётся прежним.
 */
export const FILE_BANNER_REASONS = Object.freeze(['file_permission', 'file_failed']);

/**
 * Баннер «сделайте файл-копию» (REQ-122, REQ-097): виден, если пора по числам, хранилище не закреплено (`persist() = false`),
 * ответа браузера нет, приложение не установлено или данные лежат только в памяти вкладки; с автозаписью — ещё и когда выбранный файл
 * недоступен для записи (`file_phase`: `permission` — разрешения нет или оно отозвано, `failed` — запись не удалась; другие фазы баннер не вызывают).
 * @param {{due?: boolean, persisted?: boolean|null, installed?: boolean|null, store_kind?: 'idb'|'local'|'memory'|null, file_phase?: string|null}} s
 * @returns {{show: boolean, reasons: string[]}}
 */
export function backup_banner(s) {
  const reasons = [];
  if (s.due === true) reasons.push('due');
  if (s.file_phase === 'permission') reasons.push('file_permission');
  else if (s.file_phase === 'failed') reasons.push('file_failed');
  if (s.store_kind === 'memory') reasons.push('volatile');
  if (s.persisted === false) reasons.push('persist_denied');
  else if (s.persisted === null || s.persisted === undefined) reasons.push('persist_unknown');
  if (s.installed === false) reasons.push('not_installed');
  return { show: reasons.length > 0, reasons };
}
