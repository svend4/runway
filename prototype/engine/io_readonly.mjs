// io_readonly.mjs — чтение файла НОВЕЕ известного формата «только для просмотра» и сравнение версий движка (FP-17; REQ-016, ALG-14).
// Канон REQ-016: запись с неизвестной более новой версией `v` открывается только для чтения, файл при открытии не меняется. До FP-17 такой файл отвергался
// кодом `E_SCHEMA` (`newer_format` в `io.read_journal_json`, `newer_version` в `ledger.upcast`) — прогноз не показывался вовсе. Теперь:
//   - `open_readonly(text)` разбирает файл БЕЗ апкаста и БЕЗ записи: возвращает записи как есть, те из них, что известная версия может свернуть (`usable_events`),
//     и счётчики пропущенного (`skipped`); `read_only = true`, если формат файла новее известного либо часть записей свернуть нельзя;
//   - `engine_version_status(file, current)` сравнивает версию движка в файле с текущей: расхождение — предупреждение, а не отказ (`warn`).
// Пропущенные записи НЕ угадываются: прогноз по оставшимся записям — оценка по тому, что версия умеет читать, и интерфейс обязан это сказать.
// Модуль чистый: ни часов, ни случайности, ни ввода-вывода; не реэкспортируется из index.mjs. Расчёт по введённым данным и правилам, не консультация.

import { fail } from './money.mjs';
import { DEFAULT_UPCAST_REGISTRY } from './ledger.mjs';
import { JOURNAL_FORMAT } from './io.mjs';

const FORMAT_RE = /^runway-journal\/([1-9]\d*)$/;
const SEMVER_RE = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:[-+][0-9A-Za-z.+-]*)?$/;
const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Версия формата журнала, которую умеет читать эта сборка (из `JOURNAL_FORMAT`: `runway-journal/1` → 1). */
export const KNOWN_FORMAT_VERSION = Number(/\/(\d+)$/.exec(JOURNAL_FORMAT)[1]);

/**
 * Разобрать строку формата `runway-journal/N`.
 * @param {unknown} format
 * @returns {{valid: boolean, version: number|null, newer: boolean}} `newer` — N больше известной версии (файл открывается только для просмотра)
 */
export function format_status(format) {
  const m = typeof format === 'string' ? FORMAT_RE.exec(format) : null;
  if (m === null) return { valid: false, version: null, newer: false };
  const version = Number(m[1]);
  return { valid: true, version, newer: version > KNOWN_FORMAT_VERSION };
}

/**
 * Формат рабочей области (набор данных G-001 несёт то же поле `format`, что и журнал): `null`, если поля нет.
 * @param {object} ws
 * @returns {{format: string, valid: boolean, version: number|null, newer: boolean}|null}
 */
export function workspace_format_info(ws) {
  if (!is_obj(ws) || ws.format === undefined || ws.format === null) return null;
  return { format: String(ws.format).slice(0, 40), ...format_status(ws.format) };
}

/**
 * Может ли известная версия свернуть запись: тип известен, `v` не выше текущей. Апкаст не выполняется.
 * @param {object} e запись журнала
 * @param {{current: Record<string, number>}} [registry]
 * @returns {null|'bad_event'|'unknown_type'|'newer_version'} `null` — запись читаема; иначе причина, по которой её пропускают
 */
export function event_unreadable_reason(e, registry = DEFAULT_UPCAST_REGISTRY) {
  if (!is_obj(e) || typeof e.type !== 'string') return 'bad_event';
  const cur = Object.hasOwn(registry.current, e.type) ? registry.current[e.type] : undefined;
  if (cur === undefined) return 'unknown_type';
  if (!Number.isSafeInteger(e.v) || e.v < 1) return 'bad_event';
  return e.v > cur ? 'newer_version' : null;
}

/**
 * Открыть файл-копию «только для просмотра»: без апкаста, без записи, текст файла не меняется.
 * Принимает журнал любой версии формата `runway-journal/N`, N ≥ 1.
 * @param {string} text содержимое файла
 * @param {{current: Record<string, number>}} [registry] реестр версий записей (по умолчанию — известный этой сборке)
 * @returns {{read_only: boolean, newer_format: boolean, format: string, format_version: number, known_version: number, engine_version: string|null,
 *   events: object[], usable_events: object[], skipped: {unknown_type: number, newer_version: number, bad_event: number, total: number}}}
 * @throws {RunwayError} E_SCHEMA: `bad_json`, `not_object`, `bad_format` (поле `format` не `runway-journal/N`), `events_required`, `bad_event`, `seq_required`
 */
export function open_readonly(text, registry = DEFAULT_UPCAST_REGISTRY) {
  let obj;
  try { obj = JSON.parse(text); } catch { return fail('E_SCHEMA', { reason: 'bad_json' }); }
  if (!is_obj(obj)) fail('E_SCHEMA', { reason: 'not_object' });
  const st = format_status(obj.format);
  if (!st.valid) fail('E_SCHEMA', { reason: 'bad_format', format: String(obj.format).slice(0, 40) });
  if (!Array.isArray(obj.events)) fail('E_SCHEMA', { reason: 'events_required' });
  for (const e of obj.events) {
    if (!is_obj(e) || typeof e.type !== 'string' || typeof e.event_id !== 'string') fail('E_SCHEMA', { reason: 'bad_event' });
    if (!Number.isSafeInteger(e.seq)) fail('E_SCHEMA', { reason: 'seq_required', event_id: e.event_id.slice(0, 80) });
  }
  const skipped = { unknown_type: 0, newer_version: 0, bad_event: 0, total: 0 };
  const usable_events = [];
  for (const e of obj.events) {
    const why = event_unreadable_reason(e, registry);
    if (why === null) usable_events.push(e);
    else { skipped[why] += 1; skipped.total += 1; }
  }
  // запись без `v` или без формы в файле ТЕКУЩЕГО формата — повреждение, а не «новая версия»: такой файл отвергается, как и раньше
  if (!st.newer && skipped.bad_event > 0) fail('E_SCHEMA', { reason: 'bad_event' });
  return {
    read_only: st.newer || skipped.total > 0,
    newer_format: st.newer,
    format: obj.format,
    format_version: st.version,
    known_version: KNOWN_FORMAT_VERSION,
    engine_version: typeof obj.engine_version === 'string' && obj.engine_version !== '' ? obj.engine_version : null,
    events: obj.events,
    usable_events,
    skipped,
  };
}

/** Версия движка `X.Y.Z` → тройка чисел или `null`. */
function semver(v) {
  const m = typeof v === 'string' ? SEMVER_RE.exec(v) : null;
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Сравнить версию движка, записанную в файле или снимке, с текущей. Расхождение — предупреждение (`warn`), а не отказ: числа файла могли быть получены
 * другой арифметикой, поэтому интерфейс говорит об этом и показывает контрольный `state_hash`, но открывает файл.
 * @param {string|null|undefined} file_version версия в файле (`null` — не записана; `'unversioned'` — запись о том, что версии нет)
 * @param {string} current_version текущая версия движка
 * @returns {{status: 'same'|'older'|'newer'|'different'|'unknown', warn: boolean, file: string|null, current: string}}
 *   `unknown` — версия в файле не указана (предупреждения нет, но интерфейс может сказать, что версия не записана)
 */
export function engine_version_status(file_version, current_version) {
  const current = String(current_version);
  if (typeof file_version !== 'string' || file_version === '' || file_version === 'unversioned') return { status: 'unknown', warn: false, file: null, current };
  const file = file_version.slice(0, 40);
  if (file === current) return { status: 'same', warn: false, file, current };
  const a = semver(file);
  const b = semver(current);
  if (a === null || b === null) return { status: 'different', warn: true, file, current };
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return { status: 'older', warn: true, file, current };
    if (a[i] > b[i]) return { status: 'newer', warn: true, file, current };
  }
  return { status: 'different', warn: true, file, current }; // одинаковые числа, разный хвост (пометка сборки)
}
