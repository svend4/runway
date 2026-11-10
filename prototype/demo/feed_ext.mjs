// feed_ext.mjs — «Лента»: счётчик «Сверка: N», оговорка об усечении до последних фактов, «Почему» и «Исправить» у строк (FP-28, U06, IDEA-38, IDEA-29, UP-03).
//
// Экран «Лента» принадлежит приложению (`view_feed` в app.mjs); пакет добавляет к нему через слоты, не зная приложения:
//   - слот `feed.head` — под заголовком: ссылка «Сверка: N» на #reconcile (N — решения в очереди сверки: просрочено, возможные совпадения, оплачено частично) и фраза о том,
//     что показаны только последние факты, а остальные лежат в «Сверке», список «Все факты» (усечение оговорено, а не молчит);
//   - слот `feed.row` — в ячейке названия каждой строки: «Почему» (у факта и у планового события) и «Исправить» (только у фактов, кроме ног перевода).
// «Почему» строки — модель из данных движка, без пересказа «своими словами»: у планового события — источник (правило, поток, разовый платёж, долг, гипотеза сценария), номинальная
// и эффективная дата, дата в другом режиме, волна и то, как изменился бы минимум денег на счетах без этой строки (`project` без события); у факта — состояние сверки
// (сопоставлен, часть платежа, возможное совпадение, без плана) и входит ли он в остаток или покрыт последней сверкой остатка.
// Ключ каталога приложения `fd.demo_note` («в демо лента только для чтения») больше не показывается — «+ Факт», «Сверка» и «Исправить» работают; ключ оставлен в каталоге
// (правило аддитивности), а тест следит, что его текста в ленте нет.
// Файл делится на чистые модели (без DOM; проверяет tests/feed_ext.test.mjs) и узлы. Расчёт по введённым данным и правилам, не консультация.

import { project, narrowest_point, list_waves_ex, format_date, to_epoch_day } from '../engine/index.mjs';
import { LABELS } from '../engine/verifier.mjs';
import { h, open_dialog } from './dom.mjs';
import { reconcile_model } from './reconcile.mjs';
import { last_anchor_date, account_name, money_text, date_text } from './entry.mjs';
import { fixable_fact, open_fix_dialog } from './fact_fix.mjs';
import { make_event_namer } from './why_more.mjs';

const list = (ws, key) => (Array.isArray(ws?.[key]) ? ws[key] : []);

/** Ключи каталога приложения, которые больше не показываются (остаются в каталоге; тест проверяет, что их текста нет на экране «Лента»). */
export const RETIRED_KEYS = Object.freeze(['fd.demo_note']);

// ══ 1. Чистые модели ══════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Решения, которые ждут «Сверка»: сумма очереди и её состав.
 * @param {object} ws
 * @returns {{n: number, overdue: number, double: number, partial: number}|null} `null` — очередь собрать нельзя (данные не позволяют)
 */
export function reconcile_counter(ws) {
  try {
    const m = reconcile_model(ws);
    return { n: m.queue.length, overdue: m.counts.overdue, double: m.counts.double, partial: m.counts.partial };
  } catch { return null; }
}

/**
 * «Почему» у планового события ленты.
 * @param {{ws: object, ctx: object}} model модель страницы
 * @param {'plan'|'worse'} mode
 * @param {string} id `cash_event_id`
 * @returns {null | {id: string, mode: string, source: 'rule'|'stream'|'plan'|'debt'|'scenario'|'other', amount_minor: number, date: number, nominal: number,
 *   status: string, other_mode: string, other_date: number|null, wave: number|null, effect: {min: object, without: object, delta_minor: number}}}
 *   `effect.min` — минимум денег на счетах с событием, `effect.without` — без него, `delta_minor = without − min` (больше нуля: событие углубляет минимум)
 */
export function future_why(model, mode, id) {
  const a = model.ctx;
  const evs = a.events[mode] ?? [];
  const e = evs.find((x) => x.cash_event_id === id);
  if (e === undefined) return null;
  const ws = model.ws;
  const s = a.series[mode];
  const min = narrowest_point(s, a.as_of, a.horizon_end);
  const alt = project(evs.filter((x) => x !== e), s.opening_minor, a.as_of, a.horizon_end);
  const without = narrowest_point(alt, a.as_of, a.horizon_end);
  const other_mode = mode === 'plan' ? 'worse' : 'plan';
  const o = (a.events[other_mode] ?? []).find((x) => x.cash_event_id === id);
  let wave = null; // номер волны «по режиму»: платежи рядом по датам считаются вместе
  try { list_waves_ex(a, mode).items.forEach((it, k) => { if (it.wave.event_ids.includes(id)) wave = k + 1; }); } catch { wave = null; }
  let source = 'other';
  if (e.layer === 'hypothetical') source = 'scenario';
  else if (e.rule_id) source = 'rule';
  else if (e.stream_id) source = 'stream';
  else if (list(ws, 'plans').some((p) => p?.plan_id === e.cash_event_id)) source = 'plan';
  else if (list(ws, 'debts').some((d) => typeof d?.debt_id === 'string' && String(e.cash_event_id).startsWith(d.debt_id))) source = 'debt';
  const at = typeof e.occ_key === 'string' ? /@(\d{4}-\d{2}-\d{2})$/.exec(e.occ_key) : null; // номинальная дата вхождения правила — суффикс ключа вхождения (до сдвига выходных и задержки)
  return {
    id, mode, source, amount_minor: e.amount_minor, date: e.date, nominal: at === null ? (e.plan_date ?? e.date) : to_epoch_day(at[1]), status: e.layer === 'hypothetical' ? 'hypothetical' : e.status,
    other_mode, other_date: o !== undefined && o.date !== e.date ? o.date : null, wave,
    effect: { min, without, delta_minor: without.amount_minor - min.amount_minor },
  };
}

/**
 * «Почему» у факта ленты: состояние сверки и вклад в остаток.
 * @param {object} ws
 * @param {string} event_id
 * @returns {null | {fact: object, state: string, plan: object|null, by: string|null, covered_by_anchor: boolean, anchor: string|null, fixable: boolean}}
 */
export function past_why(ws, event_id) {
  const fact = list(ws, 'facts').find((f) => f?.event_id === event_id);
  if (fact === undefined) return null;
  let state = 'unmatched';
  let plan = null;
  let by = null;
  try {
    const row = reconcile_model(ws).facts.find((r) => r.fact.id === event_id);
    if (row !== undefined) { state = row.state; plan = row.plan; by = row.by; }
  } catch { state = 'unmatched'; }
  const anchor = last_anchor_date(ws, fact.account_id);
  return { fact, state, plan, by, covered_by_anchor: anchor !== null && fact.date <= anchor, anchor, fixable: fixable_fact(ws, event_id).ok };
}

// ══ 2. Узлы ═══════════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Блок под заголовком ленты (слот `feed.head`).
 * @param {object} ctx
 * @param {{shown: number, total: number, limit?: number}} info сколько последних фактов показано из скольких
 * @returns {HTMLElement|null}
 */
export function render_feed_head(ctx, info) {
  if (info === null || typeof info !== 'object' || !Number.isSafeInteger(info.shown) || !Number.isSafeInteger(info.total)) return null; // чужое описание места вызова: блок молча пропускается
  const ws = ctx.get_ws();
  if (ws === null || ws === undefined) return null;
  const c = reconcile_counter(ws);
  const kids = [];
  if (c !== null) {
    kids.push(h('p', { class: 'feedx-recon' },
      h('a', { class: 'btn', id: 'feedx-recon-link', href: '#reconcile', text: ctx.tr('feedx.recon_link', { n: c.n }) }), ' ',
      h('span', { class: 'muted', text: c.n === 0 ? ctx.tr('feedx.recon_zero') : ctx.tr('feedx.recon_detail', { overdue: c.overdue, double: c.double, partial: c.partial }) })));
  }
  if (info.total > info.shown) kids.push(h('p', { class: 'muted', id: 'feedx-cut', text: ctx.tr('feedx.cut', { shown: info.shown, total: info.total }) }));
  return kids.length === 0 ? null : h('section', { class: 'feedx-head', 'aria-label': ctx.tr('feedx.head_label') }, kids);
}

const mode_name = (ctx, m) => LABELS.modes[ctx.lang()]?.[m] ?? m;

/** Диалог «Почему» у планового события. */
export function open_future_why(ctx, row) {
  const model = ctx.get_model();
  if (model === null || model === undefined) return;
  const w = future_why(model, row.mode, row.id);
  const f = ctx.fmt();
  if (w === null) { ctx.notify(ctx.tr('feedx.why_gone'), 'error'); return; }
  const ws = ctx.get_ws();
  const namer = make_event_namer(ws, ctx.lang());
  const e = model.ctx.events[row.mode].find((x) => x.cash_event_id === row.id);
  const name = namer(e);
  const lines = [
    h('p', { text: ctx.tr('feedx.wf_line', { name, amount: f.money(w.amount_minor), date: f.date(w.date), mode: mode_name(ctx, row.mode), status: ctx.tr('st.' + w.status) }) }),
    h('p', { text: ctx.tr('feedx.wf_src_' + w.source, { name }) }),
  ];
  if (w.nominal !== w.date) lines.push(h('p', { text: ctx.tr('feedx.wf_date_shift', { nominal: f.date(w.nominal), date: f.date(w.date), mode: mode_name(ctx, row.mode) }) }));
  if (w.wave !== null) lines.push(h('p', { text: ctx.tr('feedx.wf_wave', { n: w.wave }) }));
  if (w.other_date !== null) lines.push(h('p', { text: ctx.tr('feedx.wf_other_mode', { mode: mode_name(ctx, w.other_mode), date: f.date(w.other_date) }) }));
  const ef = w.effect;
  lines.push(h('p', { text: ef.delta_minor === 0
    ? ctx.tr('feedx.wf_effect_none', { mode: mode_name(ctx, row.mode), min: f.money(ef.min.amount_minor), at: f.date(ef.min.date) })
    : ctx.tr('feedx.wf_effect', { mode: mode_name(ctx, row.mode), min: f.money(ef.min.amount_minor), at: f.date(ef.min.date), min2: f.money(ef.without.amount_minor), at2: f.date(ef.without.date), delta: f.money(Math.abs(ef.delta_minor)) }) }));
  lines.push(h('p', { class: 'muted', text: ctx.tr('feedx.wf_foot', { hash: model.ctx.inputs_hash.slice(0, 8) }) }));
  open_dialog(ctx.tr('feedx.w_title', { name }), ctx.tr('feedx.close'), lines);
}

/** Диалог «Почему» у факта. */
export function open_past_why(ctx, row) {
  const ws = ctx.get_ws();
  if (ws === null || ws === undefined) return;
  const w = past_why(ws, row.id);
  if (w === null) { ctx.notify(ctx.tr('feedx.why_gone'), 'error'); return; }
  const lang = ctx.lang();
  const fact = w.fact;
  const money = (v) => money_text(lang, v, fact.currency ?? ctx.get_model()?.cur ?? 'EUR', ws.as_of, ws.number_format);
  const date = (iso) => date_text(lang, iso, ws.as_of, ws.number_format);
  const lines = [
    h('p', { text: ctx.tr('feedx.wp_line', { date: date(fact.date), amount: money(fact.amount_minor), account: account_name(ws, fact.account_id, lang) }) }),
    h('p', { text: w.plan !== null && (w.state === 'matched' || w.state === 'partial' || w.state === 'double')
      ? ctx.tr('feedx.wp_state_' + w.state + '_plan', { plan: w.plan.name, date: date(format_date(w.plan.date)) }) : ctx.tr('feedx.wp_state_' + w.state) }),
    h('p', { text: w.covered_by_anchor ? ctx.tr('feedx.wp_covered', { anchor: date(w.anchor) }) : ctx.tr('feedx.wp_counted', { date: date(ws.as_of) }) }),
  ];
  if (!w.fixable) lines.push(h('p', { class: 'muted', text: ctx.tr('feedx.fx_transfer_only') }));
  lines.push(h('p', { class: 'muted', text: ctx.tr('feedx.wp_foot') }));
  open_dialog(ctx.tr('feedx.w_title', { name: row.name }), ctx.tr('feedx.close'), lines);
}

/**
 * Действия строки (слот `feed.row`): «Почему» у любой строки, «Исправить» у факта.
 * @param {object} ctx
 * @param {{focus?: object}} deps
 * @param {{layer: 'past'|'future', index: number, id: string, name: string, date: string, amount_minor: number, mode: string, transfer: boolean}} row
 * @returns {HTMLElement|null}
 */
export function render_row_actions(ctx, deps, row) {
  if (row === null || typeof row !== 'object' || (row.layer !== 'past' && row.layer !== 'future') || typeof row.id !== 'string') return null; // чужое описание строки: блок молча пропускается
  const f = ctx.fmt();
  const tag = (row.layer === 'past' ? 'p' : 'f') + row.index;
  const who = ctx.tr('feedx.who', { name: row.name, date: f.date(row.date) });
  const kids = [h('button', {
    type: 'button', class: 'link', id: 'feedx-why-' + tag, 'aria-label': ctx.tr('feedx.why_aria', { who }),
    onclick: () => (row.layer === 'past' ? open_past_why(ctx, row) : open_future_why(ctx, row)), text: ctx.tr('feedx.why'),
  })];
  if (row.layer === 'past' && row.transfer !== true) {
    kids.push(h('button', {
      type: 'button', class: 'link', id: 'feedx-fix-' + tag, 'aria-label': ctx.tr('feedx.fix_aria', { who, amount: f.money(row.amount_minor) }),
      onclick: () => open_fix_dialog(ctx, row.id, deps), text: ctx.tr('feedx.fix'),
    }));
  }
  return h('span', { class: 'feedx-acts' }, ' ', ...kids.flatMap((k, i) => (i === 0 ? [k] : [' ', k])));
}
