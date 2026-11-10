// decision_currency.mjs — «Валюта решения» в «Настройках» (FP-29, ALG-08 A08.7, REQ-077; правка `set_decision_currency`).
// Валюта решения — валюта, в которой считаются «свободно», узкая точка и вердикт; события и остатки в других валютах переводятся в неё по курсам пользователя
// (`spot`, ADR-012). Движок читает её из поля рабочей области `decision_currency` (раньше параметра `params.decision_currency`, см. `normalize_ws`), поэтому одной правки
// `set_param` мало: при заполненном поле рабочей области расчёт параметра не замечал. Правка `set_decision_currency` пишет параметр через `set_param` (проверка кода
// валюты и границ — та же) и то же значение в поле рабочей области: расчёт, проверки и чтение журнала видят одну и ту же валюту.
// Нет курса пары — `E_NO_RATE` с парой (текст «нет курса … введите его — Формы данных → Курсы и обмен» строит `banner_texts.no_rate_text`), а не молчаливый ноль.
// Суммы с «валютой решения» в названии (буфер, порог волны) не пересчитываются: после смены их нужно проверить (экран говорит об этом).
// Чистый модуль: без DOM и часов (проверяется в Node). Расчёт по введённым данным и правилам, не консультация.

import { rate_at, currency_exponent, fail, format_date, to_epoch_day } from '../engine/index.mjs';
import { apply_edit, decision_currency_of } from './ws_edit.mjs';

const CODE_RE = /^[A-Z][A-Z0-9]{1,9}$/;
const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const list = (ws, key) => (Array.isArray(ws?.[key]) ? ws[key] : []);

/** Виды счетов, суммы которых движок переводит в валюту решения (операционные — в ряд, накопления и активы — в «запас»). */
const CONVERTED_LIQUIDITY = Object.freeze(['operating', 'savings', 'asset']);

/**
 * Вид правки `set_decision_currency`: `{type, value}`, `value` — код валюты. Пишет `params.decision_currency` правкой `set_param` и такое же поле рабочей области.
 * Отказ — исключение с тем же кодом и контекстом, что у `set_param`.
 */
export function edit_set_decision_currency(ws, edit, env) {
  for (const k of Object.keys(edit)) if (!['type', 'value'].includes(k)) fail('E_SCHEMA', { field: 'edit', reason: 'unknown_field', key: k.slice(0, 40) });
  if (typeof edit.value !== 'string') fail('E_SCHEMA', { field: 'value', reason: 'not_string' });
  const r = apply_edit(ws, { type: 'set_param', key: 'decision_currency', value: edit.value }, { ...env, deep: false }); // пересчёт — после записи поля рабочей области, на итоге
  if (!r.ok) fail(r.error.code, r.error.ctx ?? { field: 'value', reason: 'rejected' });
  return { ...r.ws, decision_currency: edit.value };
}

/** Допустимые значения: текущая валюта решения, валюты счетов и валюты введённых курсов (кроме них пересчитать нечем). Коды по шаблону, по алфавиту. */
export function decision_options(ws) {
  const set = new Set();
  const cur = decision_currency_of(ws);
  if (typeof cur === 'string') set.add(cur);
  for (const a of list(ws, 'accounts')) if (is_obj(a) && typeof a.currency === 'string') set.add(a.currency);
  for (const r of list(ws, 'rates')) if (is_obj(r)) { if (typeof r.base === 'string') set.add(r.base); if (typeof r.quote === 'string') set.add(r.quote); }
  return [...set].filter((c) => CODE_RE.test(c) && known(c)).sort();
}

function known(code) {
  try { currency_exponent(code); return true; } catch { return false; }
}

/**
 * Какие курсы нужны, если валютой решения станет `candidate`: по одной паре «валюта → candidate» для каждой валюты счетов (операционных, накопительных, активов),
 * отличной от неё, с курсом на дату расчёта (`null` — курса нет).
 * @param {object} ws
 * @param {string} candidate
 * @returns {{from: string, to: string, rate: {num: number, den: number, date: string, inverse: boolean}|null}[]}
 */
export function candidate_pairs(ws, candidate) {
  const as_of = typeof ws?.as_of === 'string' ? to_epoch_day(ws.as_of) : null;
  const froms = [...new Set(list(ws, 'accounts').filter((a) => is_obj(a) && CONVERTED_LIQUIDITY.includes(a.liquidity) && typeof a.currency === 'string' && a.currency !== candidate).map((a) => a.currency))].sort();
  return froms.map((from) => {
    let r = null;
    if (as_of !== null) { try { r = rate_at(list(ws, 'rates'), from, candidate, as_of); } catch { r = null; } }
    return { from, to: candidate, rate: r === null ? null : { num: r.num, den: r.den, date: format_date(r.date), inverse: r.inverse === true } };
  });
}

/** Состояние раздела: текущая валюта, варианты и курсы для текущей валюты (все ли пары есть). */
export function decision_model(model) {
  const ws = model.ws;
  const current = decision_currency_of(ws) ?? model.cur;
  const pairs = candidate_pairs(ws, current);
  return {
    current, options: decision_options(ws), pairs,
    buffer_minor: Number.isSafeInteger(ws.params?.buffer_minor) ? ws.params.buffer_minor : null,
    threshold_minor: Number.isSafeInteger(ws.params?.['wave.threshold_minor']) ? ws.params['wave.threshold_minor'] : null,
  };
}

/**
 * План правки формы: выбор из вариантов; равный текущему — без правок; иначе правка проверяется вместе с пересчётом (`apply_edit` с `deep`): нет курса пары,
 * резерв в другой валюте и другие отказы расчёта возвращаются сразу, до записи.
 * @param {{ws: object}} model
 * @param {string} value
 * @returns {{ok: true, edits: object[]}|{ok: false, reason: 'bad_currency'|'refused', error?: {code: string, ctx: object|null}, edits: []}}
 */
export function plan_decision_edit(model, value) {
  const ws = model.ws;
  if (typeof value !== 'string' || !decision_options(ws).includes(value)) return { ok: false, reason: 'bad_currency', edits: [] };
  if (value === (decision_currency_of(ws) ?? model.cur)) return { ok: true, edits: [] };
  const edit = { type: 'set_decision_currency', value };
  const r = apply_edit(ws, edit, { deep: true });
  if (!r.ok) return { ok: false, reason: 'refused', error: r.error, edits: [] };
  return { ok: true, edits: [edit] };
}
