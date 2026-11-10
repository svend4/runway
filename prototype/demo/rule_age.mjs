// rule_age.mjs — дата последней проверки налогового правила для текстов «не подтверждено с <даты>» (FP-15, REQ-067, REQ-108, C-023, C-024).
//
// Статус правила (`fresh` / `stale` / `disabled`) считает движок (`rule_age_status`, карта `Analysis.rule_status`); здесь только дата `reviewed_at` действующей версии,
// чтобы плашка, предупреждение и текст гейта «правило не подтверждено» называли её (канон: «правило не подтверждено с <даты>: подтвердите или измените»).
// Даты показываются в формате ISO (однозначно, как в форме «Налог»). Модуль чистый: без DOM, часов и случайности. Ставок и сроков в нём нет.
// Расчёт по введённым данным и правилам, не консультация.

import { rule_at, format_date } from '../engine/index.mjs';

const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Все версии налоговых правил плоским списком (корзина допускает и старую вложенную форму «список списков»). */
export function rule_versions(ws) {
  return (Array.isArray(ws?.tax_rules) ? ws.tax_rules : []).flat().filter(is_obj);
}

/** Идентификаторы правил, которые пополняют резерв: `reserve_id` версии правила или `tax_rule_id` самого резерва (по алфавиту). */
export function rule_ids_of_reserve(ws, reserve) {
  const ids = new Set();
  if (typeof reserve?.tax_rule_id === 'string' && reserve.tax_rule_id !== '') ids.add(reserve.tax_rule_id);
  for (const r of rule_versions(ws)) if (r.reserve_id === reserve?.reserve_id && typeof r.tax_rule_id === 'string') ids.add(r.tax_rule_id);
  return [...ids].sort();
}

/**
 * Резерв пополняет правило со статусом `disabled`: с какой даты оно не подтверждено (числа резерва тогда заменяет текст, C-024). Для резерва вида `sinking`, который
 * пополняет отключённое правило, это то же самое, что для налогового конверта (FP-15, дефект ADV-12).
 * @param {object} ws
 * @param {object} reserve запись резерва
 * @param {string|number} as_of
 * @param {Object<string, 'fresh'|'stale'|'disabled'>} rule_status карта движка
 * @returns {string|null} ISO-дата самой давней проверки среди отключённых правил резерва; `null` — резерв не зависит от отключённых правил
 *   (если дату определить нельзя — пустая строка, и числа всё равно скрыты)
 */
export function reserve_off_since(ws, reserve, as_of, rule_status) {
  const off = rule_ids_of_reserve(ws, reserve).filter((id) => rule_status?.[id] === 'disabled');
  if (off.length === 0) return null;
  return oldest_review_date(ws, as_of, Object.fromEntries(off.map((id) => [id, 'disabled'])), 'disabled') ?? '';
}

/**
 * Дата проверки (`reviewed_at`, ISO) версии правила, действующей на `as_of`.
 * @param {object} ws рабочая область
 * @param {string} rule_id `tax_rule_id`
 * @param {string|number} as_of дата расчёта
 * @returns {string|null} `null` — правила нет, оно ещё не действует или проверка не отмечена
 */
export function review_date(ws, rule_id, as_of) {
  let rule = null;
  try { rule = rule_at(rule_versions(ws), rule_id, as_of); } catch { return null; }
  if (rule === null) return null;
  const at = rule.reviewed_at;
  if (typeof at === 'string' && at !== '') return at;
  return Number.isSafeInteger(at) ? format_date(at) : null;
}

/**
 * Самая давняя дата проверки среди правил в заданном статусе (по карте `Analysis.rule_status`): с неё правило «не подтверждено».
 * @param {object} ws
 * @param {string|number} as_of
 * @param {Object<string, 'fresh'|'stale'|'disabled'>} rule_status карта движка
 * @param {'stale'|'disabled'} [status]
 * @returns {string|null} ISO-дата или `null`, если таких правил нет
 */
export function oldest_review_date(ws, as_of, rule_status, status = 'disabled') {
  let best = null;
  for (const [id, st] of Object.entries(rule_status ?? {})) {
    if (st !== status) continue;
    const d = review_date(ws, id, as_of);
    if (d !== null && (best === null || d < best)) best = d;
  }
  return best;
}

/**
 * «Свободно» зависит от резервов, а резервы — от налоговых правил: пока хоть одно правило в статусе `disabled`, число «свободно» не печатается, а вместо него стоит текст
 * «не подтверждено с <даты>» (REQ-067, C-024; FP-47: «Обзор» и «Сценарии» — тот же гейт, что на «Резервах»).
 * @param {object} ws
 * @param {string|number} as_of
 * @param {Object<string, 'fresh'|'stale'|'disabled'>} rule_status карта движка (`Analysis.rule_status`)
 * @returns {string|null} `null` — отключённых правил нет, «свободно» печатать можно; иначе ISO-дата самой давней проверки отключённого правила
 *   (пустая строка, если дату определить нельзя: «проверка не отмечена»), и «свободно» всё равно скрыто
 */
export function free_masked_since(ws, as_of, rule_status) {
  if (!Object.values(rule_status ?? {}).some((st) => st === 'disabled')) return null;
  return oldest_review_date(ws, as_of, rule_status, 'disabled') ?? '';
}
