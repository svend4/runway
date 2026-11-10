// home_cards.mjs — карточки «Обзора» FP-03: «Запас хода» (REQ-023) и «Готовность данных» (REQ-029) + буфер как число пользователя (REQ-026).
// Числа считает движок: запас хода — `runway_days` (первый день, когда деньги на счетах после расходов дня уходят ниже нуля; с поступлениями и
// без них), готовность — `readiness` (ступень и причины `reasons`), гейт вердикта — `gate`. Здесь только отбор и текст.
// Чистые модели (`runway_model`, `readiness_model`) не трогают DOM и проверяются в Node; узлы строят `runway_card` и `ready_card`.
// Расчёт по введённым данным и правилам, не консультация.

import { h, table } from './dom.mjs';
import { runway_days, gate } from '../engine/index.mjs';
import { LABELS } from '../engine/verifier.mjs';
import { make_nf_fmt } from './number_format.mjs';
import { horizon_rows_of, horizon_ahead_of } from './horizon.mjs'; // FP-49: «строк ряда» и «дней вперёд» — в одном месте, а не четырьмя копиями выражения

/** Режимы расчёта v1 (как в приложении). */
export const MODES = Object.freeze(['plan', 'worse']);

/** Ступени готовности данных (D-23) → причина из `readiness.reasons`, когда ступень не набрана. */
export const READINESS_STEPS = Object.freeze([
  { id: 'account', reason: 'no_account' },
  { id: 'obligations', reason: 'obligations_lt_3' },
  { id: 'income', reason: 'no_income_45d' },
  { id: 'daily', reason: 'no_daily_spend' },
]);

/** Названия уровней готовности (`readiness.level`): индекс = счёт `s`. */
export const READINESS_LEVELS = Object.freeze(['empty', 'skeleton', 'working', 'working_plus', 'full']);

/** Причины отказа гейта вердикта (REQ-029, C-018). */
export const GATE_REASONS = Object.freeze(['readiness', 'stale', 'no_anchor', 'no_buffer', 'rule_disabled']);

const KNOWN_REASONS = new Set(READINESS_STEPS.map((s) => s.reason));

// ── чистые модели ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * «Запас хода» по обоим режимам: первая дата, когда `trough < 0`, с поступлениями и без них (`null` — «за горизонтом»); `days` — дней от даты расчёта.
 * @param {{ctx: object}} model модель страницы (`build_model`)
 * `horizon_days` — число строк ряда (с днём расчёта); `horizon_ahead` (FP-48) — горизонт в днях вперёд от даты расчёта, то число, которое стоит в «Настройках» и в шапке: его называет карточка.
 * @returns {{as_of: number, horizon_end: number, horizon_days: number, horizon_ahead: number, per_mode: Object<string, {with: {date: number, days: number}|null, without: {date: number, days: number}|null}>}}
 */
export function runway_model(model) {
  const a = model.ctx;
  const per_mode = {};
  for (const m of MODES) {
    const r = runway_days(a.series[m], a.events[m]);
    per_mode[m] = { with: r.with, without: r.without };
  }
  return { as_of: a.as_of, horizon_end: a.horizon_end, horizon_days: horizon_rows_of(a.series), horizon_ahead: horizon_ahead_of(a.series), per_mode };
}

/**
 * Готовность данных и гейт вердикта: ступень `s`, её название, шаги (набран / не набран), перечень недостающего из `readiness.reasons`
 * (порядок движка), показ прогноза (`s ≥ ready.q1`), причины отказа гейта и состояние буфера.
 * @param {{ctx: object}} model
 */
export function readiness_model(model) {
  const a = model.ctx;
  const { score, level } = a.readiness;
  const reasons = [...a.readiness.reasons];
  const q1 = a.params['ready.q1'] ?? 3;
  const q3 = a.params['ready.q3'] ?? 4;
  const g = gate(a);
  const B = a.buffer_minor;
  return {
    score,
    level: READINESS_LEVELS.includes(level) ? level : READINESS_LEVELS[Math.min(Math.max(score, 0), 4)],
    steps: READINESS_STEPS.map((s) => ({ id: s.id, reason: s.reason, ok: !reasons.includes(s.reason) })),
    reasons,
    q1,
    q3,
    forecast_visible: score >= q1,
    verdict_gate: g === null ? null : { reason: g.reason, reasons: [...g.reasons] },
    buffer: { set: B !== null && B !== undefined, value: B ?? null },
  };
}

/** Ключ строки для причины недостающего (`no_account` …); неизвестная причина движка показывается общим текстом. */
export const miss_key = (reason) => 'settings.rd_miss_' + (KNOWN_REASONS.has(reason) ? reason : 'other');

/** Ключ строки для причины отказа гейта. */
export const gate_key = (reason) => 'settings.gt_' + (GATE_REASONS.includes(reason) ? reason : 'other');

// ── узлы ───────────────────────────────────────────────────────────────────────────────────────────────────────────

function fmt_of(ctx, model) {
  return make_nf_fmt(ctx.lang(), model.cur, model.as_of_iso, model.ws?.number_format);
}

/**
 * Карточка «Запас хода в днях» для слота `overview.cards`: заголовок по главному режиму и таблица «режим × (с поступлениями / без)».
 * @param {object} ctx контекст расширений (`ext.ctx`)
 * @returns {HTMLElement|null}
 */
export function runway_card(ctx) {
  const model = ctx.get_model();
  if (model === null) return null;
  const f = fmt_of(ctx, model);
  const lang = ctx.lang();
  const tr = ctx.tr;
  const rd = readiness_model(model);
  if (!rd.forecast_visible) { // прогноз ещё не показывается (s < ready.q1): запас хода по пустым данным был бы ложным спокойствием
    return h('section', { class: 'card fp03-runway', 'aria-labelledby': 'fp03-runway-title' },
      h('h3', { id: 'fp03-runway-title', text: tr('settings.rw_title') }),
      h('p', { class: 'muted', role: 'status', text: tr('settings.rw_hidden', { q1: rd.q1 }) }));
  }
  const rm = runway_model(model);
  const main = MODES.includes(ctx.mode()) ? ctx.mode() : 'worse';
  const head = rm.per_mode[main].with;
  const mode_name = LABELS.modes[lang][main];
  const headline = head === null
    ? tr('settings.rw_head_none', { mode: mode_name, horizon: f.days(rm.horizon_ahead) })
    : head.days === 0
      ? tr('settings.rw_head_today', { mode: mode_name, date: f.date(head.date) })
      : tr('settings.rw_head', { mode: mode_name, n: f.days(head.days), date: f.date(head.date) });
  const cell = (p) => (p === null ? tr('settings.rw_beyond') : f.days(p.days) + ' · ' + f.date(p.date));
  const rows = MODES.map((m) => h('tr', { class: m === main ? 'mark' : null },
    h('th', { scope: 'row', text: LABELS.modes[lang][m] }),
    h('td', { text: cell(rm.per_mode[m].with) }),
    h('td', { text: cell(rm.per_mode[m].without) })));
  return h('section', { class: 'card fp03-runway', 'aria-labelledby': 'fp03-runway-title' },
    h('h3', { id: 'fp03-runway-title', text: tr('settings.rw_title') }),
    h('p', { class: 'fp03-big', role: 'status', text: headline }),
    table(tr('settings.rw_caption'), [tr('settings.rw_col_mode'), tr('settings.rw_col_with'), tr('settings.rw_col_without')], rows, 'tbl'),
    h('p', { class: 'muted', text: tr('settings.rw_note', { horizon: f.days(rm.horizon_ahead), date: f.date(rm.horizon_end) }) }));
}

/**
 * Карточка «Готовность данных» для слота `overview.cards` и экрана настроек: ступень, четыре условия, плашка «Не учтено: …» с причиной по каждому
 * недостающему, состояние прогноза и вердикта, буфер со ссылкой на настройки.
 * @param {object} ctx
 * @returns {HTMLElement|null}
 */
export function ready_card(ctx) {
  const model = ctx.get_model();
  if (model === null) return null;
  const rd = readiness_model(model);
  const f = fmt_of(ctx, model);
  const tr = ctx.tr;
  const steps = rd.steps.map((s) => h('li', null,
    h('span', { 'aria-hidden': 'true', class: 'fp03-glyph', text: s.ok ? '✓' : '○' }),
    h('span', { text: ' ' + tr('settings.rd_step_' + s.id) + ' — ' + (s.ok ? tr('settings.rd_counted') : tr('settings.rd_not_counted')) })));
  const nodes = [
    h('h3', { id: 'fp03-ready-title', text: tr('settings.rd_title') }),
    h('p', null, h('strong', { text: tr('settings.rd_score', { score: rd.score, level: tr('settings.rd_level_' + rd.level) }) })),
    h('ul', { class: 'plain' }, steps),
  ];
  if (rd.reasons.length > 0) {
    nodes.push(h('div', { class: 'banner', role: 'status' },
      h('p', { text: tr('settings.rd_missing_head') }),
      h('ul', null, rd.reasons.map((r) => h('li', { text: tr(miss_key(r)) })))));
  }
  nodes.push(h('p', { text: rd.forecast_visible ? tr('settings.rd_forecast_on', { q1: rd.q1 }) : tr('settings.rd_forecast_off', { q1: rd.q1 }) }));
  nodes.push(h('p', { text: rd.verdict_gate === null
    ? tr('settings.rd_verdict_on')
    : tr('settings.rd_verdict_off', { reasons: rd.verdict_gate.reasons.map((r) => tr(gate_key(r), { q3: rd.q3 })).join('; ') }) }));
  nodes.push(h('p', { class: rd.buffer.set ? 'muted' : null },
    rd.buffer.set ? tr('settings.rd_buffer_set', { value: f.money(rd.buffer.value) }) : tr('settings.rd_buffer_unset'), ' ',
    h('a', { class: 'link', href: '#settings', text: rd.buffer.set ? tr('settings.rd_buffer_change') : tr('settings.rd_buffer_go') })));
  return h('section', { class: 'card fp03-ready', 'aria-labelledby': 'fp03-ready-title' }, ...nodes);
}
