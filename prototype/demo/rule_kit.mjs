// rule_kit.mjs — общая сборка правила повторения для мастера «Старт» (wizard.mjs) и калькулятора v0 (v0.mjs), FP-10.
// Правило строится из счёта, названия, вида, суммы, частоты и первой даты; день месяца и день недели берутся из первой даты. Правка проходит ту же проверку
// `upsert_rule` (`ws_edit.mjs` → `validate_rule` движка), что и любое правило приложения. Модуль чистый: без DOM, часов и сети.

import { dow, parse_date, civil_from_days } from '../engine/index.mjs';

/**
 * Правило для `upsert_rule`.
 * @param {{account_id: string, currency: string}} acc счёт
 * @param {string} rule_id
 * @param {string} name
 * @param {'expense'|'income'} kind
 * @param {number} amount_minor положительная сумма (знак ставится по виду)
 * @param {'M'|'W'|'Y'} freq
 * @param {string} start_iso первая дата `YYYY-MM-DD`
 * @param {object} [extra] дополнительные поля правила (`is_obligation`, `count`, `weekend`, `calendar_id`, `delay_days_worse`, `reserve_id`, `tag`…)
 */
export function make_rule(acc, rule_id, name, kind, amount_minor, freq, start_iso, extra = {}) {
  const rule = {
    rule_id, account_id: acc.account_id, name, kind, amount: { exp_minor: kind === 'expense' ? -amount_minor : amount_minor }, currency: acc.currency,
    freq, interval: 1, start_date: start_iso, month_end: 'clamp', weekend: 'keep', exdates: [], is_obligation: false, is_estimate: false, ...extra,
  };
  const d = parse_date(start_iso);
  if (freq === 'M') rule.by_monthday = [civil_from_days(d)[2]];
  else if (freq === 'W') rule.by_weekday = [dow(d)];
  return rule;
}
