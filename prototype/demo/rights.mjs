// rights.mjs — честный отчёт «где что лежит» (FP-05, REQ-125, IDEA-80, TST-56): вычисляется из состояния, а не из статичного текста.
// Вход — факты о хранилище и копии (вид хранилища, закреплено ли оно, установлено ли приложение, число записей, последняя копия, сегодня);
// выход — строки отчёта `{id, key, params}` (ключи строк — каталоги `i18n/data.mjs` и, для строки про автозапись в файл, `i18n/backupfile.mjs`) и перечень остаточных рисков.
// Формулировки не содержат запрещённых обещаний (design-brief §10; тест сверяет каталог с `vocab.json → forbidden_phrases`).
// Отчёт v1: наружу не уходит ничего, кроме загрузки оболочки; хранилище и файл-копия не шифруются (защищённый паролем экспорт — v1.1, C-081).

import { to_epoch_day } from '../engine/dates.mjs';

/** Что уходит ассистенту в v1 — ничего (ассистент работает на устройстве). */
export const OUTBOUND_V1 = Object.freeze([]);

const day_of = (iso) => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? to_epoch_day(iso) : null);

/** Строки «на устройстве» по виду хранилища. */
const DEVICE_KEYS = Object.freeze({
  idb: 'data.rights_device_idb',
  local: 'data.rights_device_local',
  memory: 'data.rights_device_memory',
});

/** Строка про автозапись в файл-копию (FP-19, REQ-097) по фазе: показывается, только когда файл выбран. */
const FILE_KEYS = Object.freeze({
  ready: 'backupfile.rights_ready',
  permission: 'backupfile.rights_permission',
  failed: 'backupfile.rights_failed',
});

/**
 * Ключ строки про автозапись: по фазе; при фазе `ready` — точнее: приостановлена (`held`: в файле копия прежнего журнала) или в файл ещё не записывали
 * (`written === false`; поля нет — строка прежняя). Фраза «копия обновляется» верна, только когда запись в этот файл уже состоялась.
 */
function file_key_of(file) {
  const key = FILE_KEYS[file?.phase];
  if (key === undefined || file.phase !== 'ready') return key;
  if (file.held === true) return 'backupfile.rights_held';
  if (file.written === false) return 'backupfile.rights_chosen';
  return key;
}

/**
 * Возраст копии в днях (или `null`, если копии нет / даты нечитаемы).
 * @param {{day: string}|null} last_backup
 * @param {string} today
 */
export function copy_age_days(last_backup, today) {
  const a = day_of(last_backup?.day);
  const b = day_of(today);
  return a === null || b === null ? null : Math.max(0, b - a);
}

/**
 * Отчёт «где что лежит», вычисленный из состояния.
 * @param {{store_kind?: 'idb'|'local'|'memory'|null, persisted?: boolean|null, installed?: boolean|null, count?: number, new_since_copy?: number,
 *   last_backup?: {day: string, count: number}|null, today?: string, file?: {phase?: string, name?: string, held?: boolean, written?: boolean}|null}} s
 * @returns {{rows: {id: string, key: string, params: object}[], residual: {id: string, key: string}[],
 *   flags: {has_copy: boolean, copy_age_days: number|null, entries: number, new_since_copy: number, persisted: boolean|null, installed: boolean|null, store_kind: string|null}, outbound: string[]}}
 */
export function rights_report(s = {}) {
  const store_kind = s.store_kind ?? null;
  const entries = Number.isSafeInteger(s.count) && s.count >= 0 ? s.count : 0;
  const last = s.last_backup ?? null;
  const has_copy = last !== null && typeof last.day === 'string';
  const age = has_copy ? copy_age_days(last, s.today) : null;
  const new_since = Number.isSafeInteger(s.new_since_copy) && s.new_since_copy >= 0 ? s.new_since_copy : (has_copy ? Math.max(0, entries - (last.count ?? 0)) : entries);
  const persisted = s.persisted === true ? true : s.persisted === false ? false : null;
  const installed = s.installed === true ? true : s.installed === false ? false : null;

  const rows = [];
  rows.push({ id: 'device', key: DEVICE_KEYS[store_kind] ?? 'data.rights_device_none', params: { n: entries } });
  rows.push({ id: 'pin', key: persisted === true ? 'data.rights_pin_yes' : persisted === false ? 'data.rights_pin_no' : 'data.rights_pin_unknown', params: {} });
  rows.push(has_copy
    ? { id: 'copy', key: 'data.rights_copy_yes', params: { day: last.day, age: age ?? 0, n_new: new_since } }
    : { id: 'copy', key: 'data.rights_copy_none', params: { n: entries } });
  // автозапись в выбранный файл (FP-19): строка есть, только если файл выбран; без поля `file` отчёт прежний
  const file_key = file_key_of(s.file);
  if (file_key !== undefined) rows.push({ id: 'file', key: file_key, params: { name: typeof s.file.name === 'string' ? s.file.name : '' } });
  rows.push({ id: 'assistant', key: 'data.rights_assistant_none', params: {} });
  rows.push({ id: 'third', key: 'data.rights_third_shell', params: {} });

  const residual = [];
  residual.push({ id: 'device_loss', key: has_copy ? 'data.rights_risk_device_loss' : 'data.rights_risk_device_loss_nocopy' });
  residual.push({ id: 'extensions', key: 'data.rights_risk_extensions' });
  residual.push({ id: 'not_encrypted', key: 'data.rights_risk_not_encrypted' });
  if (persisted !== true) residual.push({ id: 'browser_clear', key: 'data.rights_risk_browser_clear' });

  return {
    rows, residual,
    flags: { has_copy, copy_age_days: age, entries, new_since_copy: new_since, persisted, installed, store_kind },
    outbound: [...OUTBOUND_V1],
  };
}
