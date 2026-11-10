// as_of.mjs — управление «сегодня» (дата расчёта `ws.as_of`): правка `set_as_of`, разбор введённой даты, модель карточки и план правок.
// Зачем: в демо `as_of` задаёт набор данных (у G-001 это 2026-10-04), поэтому «+ Факт» на дату набора остаток не меняет, а плашка «данные устарели»
// никогда не появляется сама. Экран «Настройки» (settings.mjs) даёт сдвинуть «сегодня» вперёд, вернуть назад (но не раньше последней проведённой записи)
// или взять дату с часов компьютера. Запись — только общим путём: `apply_edit` (вид правки `set_as_of`, регистрирует пакет FP-03) → `ctx.set_ws`.
// Чистый модуль: ни DOM, ни часов, ни сети (часы приходят аргументом). Расчёт по введённым данным и правилам, не консультация.

import { fail, parse_date } from '../engine/index.mjs';

/** Допустимые границы даты расчёта: разумный календарный диапазон (движок проверен на 1970–2100). */
export const AS_OF_MIN = '2000-01-01';
export const AS_OF_MAX = '2100-12-31';

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const DMY = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;
const clip = (x) => String(x).slice(0, 40);
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Разобрать дату из поля ввода: `ГГГГ-ММ-ДД` (так отдаёт `<input type="date">`) или `ДД.ММ.ГГГГ`.
 * @param {string} text
 * @returns {{ok: true, value: string} | {ok: false, reason: 'empty'|'bad_date'|'range'}}
 */
export function parse_as_of_text(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (raw === '') return { ok: false, reason: 'empty' };
  let iso;
  let m = ISO.exec(raw);
  if (m !== null) iso = raw;
  else if ((m = DMY.exec(raw)) !== null) iso = `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;
  else return { ok: false, reason: 'bad_date' };
  try { parse_date(iso); } catch { return { ok: false, reason: 'bad_date' }; }
  if (iso < AS_OF_MIN || iso > AS_OF_MAX) return { ok: false, reason: 'range' };
  return { ok: true, value: iso };
}

/**
 * Самая поздняя дата проведённой записи: факты, остатки по якорю и записи в резервы не бывают позже «сегодня» (E_FUTURE_POSTED).
 * @param {object} ws
 * @returns {string|null} `YYYY-MM-DD` или `null`, если проведённых записей нет
 */
export function latest_posted(ws) {
  let latest = null;
  for (const bucket of ['facts', 'anchors', 'allocations']) {
    for (const x of Array.isArray(ws?.[bucket]) ? ws[bucket] : []) {
      const d = x?.date;
      if (typeof d === 'string' && ISO.test(d) && (latest === null || d > latest)) latest = d;
    }
  }
  return latest;
}

/**
 * Вид правки `set_as_of` для `ws_edit.register_edit`: `{type: 'set_as_of', date: 'YYYY-MM-DD'}`.
 * Отказы: чужие поля — `E_SCHEMA`; не дата — `E_BAD_DATE`; раньше последней проведённой записи — `E_FUTURE_POSTED`.
 * Остальное (общая проверка модели) выполняют зарегистрированные проверки `apply_edit`.
 * @param {object} ws
 * @param {{type: string, date: string}} edit
 * @returns {object} новая рабочая область
 */
export function edit_set_as_of(ws, edit) {
  for (const k of Object.keys(edit)) if (k !== 'type' && k !== 'date') fail('E_SCHEMA', { field: 'edit', reason: 'unknown_field', key: clip(k) });
  if (typeof edit.date !== 'string') fail('E_BAD_DATE', { field: 'date', reason: 'not_iso_string' });
  try { parse_date(edit.date); } catch { fail('E_BAD_DATE', { field: 'date', reason: 'bad_date', value: clip(edit.date) }); }
  if (edit.date < AS_OF_MIN || edit.date > AS_OF_MAX) fail('E_SCHEMA', { field: 'date', reason: 'out_of_range', value: edit.date });
  const latest = latest_posted(ws);
  if (latest !== null && edit.date < latest) fail('E_FUTURE_POSTED', { field: 'date', reason: 'as_of_before_posted', value: edit.date, latest });
  return { ...ws, as_of: edit.date };
}

/**
 * План правок формы «Сегодня»: пусто, если дата не изменилась; отказ с причиной, если введено не то.
 * @param {{ws: object}} model модель страницы (`build_model`)
 * @param {string} text поле ввода
 * @returns {{ok: true, edits: {type: 'set_as_of', date: string}[]} | {ok: false, reason: 'empty'|'bad_date'|'range'|'before_posted', latest?: string}}
 */
export function plan_as_of_edit(model, text) {
  const r = parse_as_of_text(text);
  if (!r.ok) return r;
  const latest = latest_posted(model.ws);
  if (latest !== null && r.value < latest) return { ok: false, reason: 'before_posted', latest };
  if (r.value === model.ws.as_of) return { ok: true, edits: [] };
  return { ok: true, edits: [{ type: 'set_as_of', date: r.value }] };
}

/**
 * Модель карточки «Сегодня»: действующая дата, возраст остатка по якорю и сколько дней до плашки «данные устарели» (`left_to_banner`, только у свежих
 * данных), дата на часах и сдвиг относительно действующей даты.
 * @param {{ws: object, as_of_iso: string, ctx: {anchor_status?: {level: string, age: number|null}, params: object}}} model
 * @param {string|null} clock_iso местная дата с часов компьютера (или `null`, если часов нет)
 * @returns {{as_of: string, clock: string|null, shift_days: number|null, anchor_age: number|null, level: string, left_to_banner: number|null, latest_posted: string|null}}
 */
export function as_of_model(model, clock_iso) {
  const st = model.ctx.anchor_status ?? { level: 'fresh', age: null };
  const banner_days = model.ctx.params?.['stale.banner_days'];
  const clock = typeof clock_iso === 'string' && parse_as_of_text(clock_iso).ok ? clock_iso : null;
  return {
    as_of: model.as_of_iso,
    clock,
    shift_days: clock === null ? null : parse_date(clock) - parse_date(model.as_of_iso),
    anchor_age: Number.isSafeInteger(st.age) ? st.age : null,
    level: st.level,
    // плашка появляется, когда возраст остатка больше `stale.banner_days` (канон: 7 → с 8-го дня); у свежих данных это ещё `banner_days + 1 − возраст` дней
    left_to_banner: st.level === 'fresh' && Number.isSafeInteger(st.age) && Number.isSafeInteger(banner_days) ? Math.max(1, banner_days + 1 - st.age) : null,
    latest_posted: latest_posted(model.ws),
  };
}
