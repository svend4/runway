// prob_band.mjs — вероятностная полоса P10–P90 по согласию (FP-11, REQ-054, REQ-055, ADR-008, ADR-015, решение владельца № 3).
// ПО УМОЛЧАНИЮ ВЫКЛЮЧЕНО. Включается только явным согласием на экране «Качество прогноза»: флажок «понимаю: это эксперимент, не обещание» и кнопка подтверждения. Согласие лежит в localStorage под ключом
// `runway-prob-consent/1` (префикс `runway`: «Удалить все данные» стирает его вместе с остальным, чужие ключи общего localhost не трогаются); при недоступном хранилище действует только до перезагрузки.
// Полоса НЕ влияет на вердикты OK/TIGHT/FRAGILE/NO, на числа Q1/Q3 и на ряды plan/worse: это отдельный расчёт `band_adapter.mc_band` поверх готового анализа. Считается по нажатию кнопки, не при каждой
// отрисовке. Честность малых выборок (REQ-055): без истории — отказ с перечнем потоков; число наблюдений n показывается всегда; при n < 20 доли не подаются процентом — счёт «в k из n» (полный перебор) либо
// «мало наблюдений»; квантиль с ceil(q·n) = n подписан «наибольшее из n», с ceil(q·n) = 1 при q < 50 — «наименьшее из n». Везде пометка «эксперимент, не обещание». Расчёт по введённым данным, не консультация.
// Источник «синтетический пример» строит журнал из `data/synthetic-journals` (не данные пользователя) и ничего не пишет в рабочую область.

import { analyze, round_div } from '../engine/index.mjs';
import { mc_band, quantile_label, BAND_DEFAULTS } from '../engine/band_adapter.mjs';
import { make_journal, regular_corpus } from '../data/synthetic-journals/generate.mjs';
import { events_to_ws } from './ws_bridge.mjs';
import { h, s, table } from './dom.mjs';
import { env_of, fmt_of, check_field, is_checked, list_of } from './forms.mjs';
import { create_focus_keeper } from './focus_keep.mjs';
import { clock_ports } from './ids.mjs';

/** Ключ согласия в localStorage (префикс `runway`: стирается «Удалить все данные»). */
export const CONSENT_KEY = 'runway-prob-consent/1';
/** Возможные возмущения сверх задержек платежей: отклонения оценочных трат и курсы. */
export const OPTIONAL_KINDS = Object.freeze(['ratio', 'fx']);
/** Число путей в интерфейсе (полный перебор наблюдений от него не зависит). */
export const UI_PATHS = 600;

// ── согласие ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** localStorage или `null` (приватный режим, запрет хранилища, Node). */
export function local_storage() {
  try {
    const st = globalThis.localStorage;
    return st !== null && st !== undefined && typeof st.getItem === 'function' && typeof st.setItem === 'function' ? st : null;
  } catch { return null; }
}

/**
 * Включено ли согласие. Читает хранилище при каждом вызове: после «Удалить все данные» оно сразу выключено. Любой сбой чтения или неверная форма — «выключено»,
 * если не действует согласие на время сеанса (`fallback.mem`): оно ставится, когда хранилища нет или запись в него не удалась (квота общего localhost),
 * и снимается кнопкой «Выключить эксперимент» либо перезагрузкой страницы.
 * @param {{getItem: Function}|null} storage
 * @param {{mem?: boolean}} [fallback] согласие на время сеанса: хранилища нет или запись не удалась
 */
export function read_consent(storage, fallback = {}) {
  const session = fallback.mem === true;
  if (storage === null || storage === undefined) return session;
  try {
    const text = storage.getItem(CONSENT_KEY);
    if (typeof text !== 'string') return session;
    const v = JSON.parse(text);
    return (v !== null && typeof v === 'object' && v.v === 1 && v.experiment === true) || session;
  } catch { return session; }
}

/**
 * Записать согласие (`on = true`) или снять его (ключ удаляется). Без дат и сумм: `{"v":1,"experiment":true}`.
 * @returns {boolean} удалось ли сохранить на устройстве (без хранилища — `false`, согласие действует до перезагрузки)
 */
export function write_consent(storage, on) {
  if (storage === null || storage === undefined) return false;
  try {
    if (on) storage.setItem(CONSENT_KEY, JSON.stringify({ v: 1, experiment: true }));
    else storage.removeItem(CONSENT_KEY);
    return true;
  } catch { return false; }
}

// ── состояние и источники ─────────────────────────────────────────────────────────────────────────────────────────────

/** Зависимости вероятностных блоков на один контекст (общие для полосы и «при уверенности α»). */
export function make_prob_deps(env = {}) {
  const ports = env.ports ?? clock_ports();
  return {
    storage: env.storage === undefined ? local_storage() : env.storage,
    mem: false, // согласие на время сеанса, если хранилища нет
    ui: { agree: false, agree_error: false, source: 'mine', kinds: { ratio: false, fx: false }, confidence: 90 },
    band: { key: null, result: null },
    buy: { key: null, result: null, error: null },
    focus: create_focus_keeper(ports.now_ms),
  };
}

/** Согласие сейчас. */
export function consent_on(deps) {
  return read_consent(deps.storage, { mem: deps.mem });
}

let SYNTH = null;
/**
 * Синтетический пример с историей (15 выплат клиента за 15 месяцев): рабочая область и расчёт на 2026-09-30. Это НЕ данные пользователя; в приложение он не загружается.
 * @returns {{ws: object, analysis: object}}
 */
export function synthetic_example() {
  if (SYNTH === null) {
    const spec = { ...regular_corpus()[1], start: '2025-07-01', end: '2026-09-30' };
    const ws = { ...events_to_ws(make_journal(spec)), as_of: '2026-09-30', decision_currency: 'EUR', locale: 'ru' };
    SYNTH = { ws, analysis: analyze(ws, { as_of: ws.as_of }) };
  }
  return SYNTH;
}

/** Рабочая область и анализ по источнику: свои данные (`mine`) или синтетический пример (`synthetic`). `null`, если своих данных нет. */
export function source_of(ctx, deps) {
  if (deps.ui.source === 'synthetic') return { ...synthetic_example(), synthetic: true };
  const ws = ctx.get_ws();
  const model = ctx.get_model();
  if (ws === null || ws === undefined || model === null || model === undefined) return null;
  return { ws, analysis: model.ctx, synthetic: false };
}

/** Возмущения: задержки платежей всегда, плюс выбранные. */
export function kinds_of(deps) {
  return [...BAND_DEFAULTS.kinds, ...OPTIONAL_KINDS.filter((k) => deps.ui.kinds[k] === true)];
}

/** Ключ расчёта: если он изменился (данные, источник, возмущения), прежний результат не показывается как свежий. */
export function run_key(src, deps) {
  return [src.synthetic ? 'synthetic' : 'mine', src.analysis.inputs_hash, kinds_of(deps).join('+'), UI_PATHS].join('|');
}

// ── тексты по результату ──────────────────────────────────────────────────────────────────────────────────────────────

/** Название потока для людей: правило, поток, контрагент или сам ключ. */
export function flow_name(ws, key) {
  const hit = (list, field) => list_of(ws, list).find((x) => x !== null && typeof x === 'object' && x[field] === key);
  const x = hit('rules', 'rule_id') ?? hit('streams', 'stream_id') ?? hit('counterparties', 'counterparty_id') ?? hit('plans', 'plan_id');
  return typeof x?.name === 'string' && x.name !== '' ? x.name : key;
}

/**
 * Подача доли по правилу малых выборок (REQ-055): текст без обещаний. `pres` — результат `present_probability`.
 * @param {(key: string, params?: object) => string} tr
 * @param {{kind: string, reason?: string, k?: number, n?: number, p_pm?: number, lo_pm?: number, hi_pm?: number}} pres
 * @param {(pm: number) => string} pct доля в ‰ → число «12,5» (знак % — в шаблоне строки)
 */
export function present_text(tr, pres, pct) {
  if (pres.kind === 'count') return tr('quality.pres_count', { k: pres.k, n: pres.n });
  if (pres.kind === 'interval') return tr('quality.pres_interval', { p: pct(pres.p_pm), lo: pct(pres.lo_pm), hi: pct(pres.hi_pm), n: pres.n });
  if (pres.reason === 'small_sample') return tr('quality.pres_small', { n: pres.n });
  return tr('quality.pres_none');
}

/** Форматтер доли: ‰ → число «12,5» по формату рабочей области (знак % ставит шаблон строки). `f` — форматтеры `fmt_of`. */
export const pm_number = (f) => (pm) => f.pm(pm).replace(/\s%$/, '');

/** Текст отказа: «нет истории» — с перечнем потоков, остальные причины — своей строкой. */
export function refusal_for(ctx, ws, r) {
  const tr = ctx.tr;
  if (r.reason === 'no_history') {
    const names = (r.flows_without_history ?? []).map((k) => flow_name(ws, k));
    return names.length === 0 ? tr('quality.refuse_nothing') : tr('quality.refuse_no_history', { flows: names.join(', ') });
  }
  if (['no_buffer', 'date_before_as_of', 'beyond_horizon'].includes(r.reason)) return tr('quality.refuse_' + r.reason);
  return tr('quality.refuse_generic');
}

// ── график и таблица ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Лента P10–P90 и линия P50 в SVG (цвета — классами из css/quality.css, без inline-стилей). Текстовая копия — таблица рядом.
 * @param {object} band результат `mc_band` с `ok = true`
 * @param {string} label доступное описание
 */
export function band_svg(band, label) {
  const W = 640;
  const Hh = 180;
  const pad = 8;
  const n = band.close_q.length;
  const lo = Math.min(0, ...band.close_q.map((q) => q.p10));
  const hi = Math.max(0, ...band.close_q.map((q) => q.p90));
  const span = Math.max(1, hi - lo);
  const x = (i) => (n <= 1 ? pad : pad + (i * (W - 2 * pad)) / (n - 1));
  const y = (v) => Hh - pad - ((v - lo) * (Hh - 2 * pad)) / span;
  const r1 = (v) => Math.round(v * 10) / 10;
  const up = band.close_q.map((q, i) => `${r1(x(i))},${r1(y(q.p90))}`);
  const down = band.close_q.map((q, i) => `${r1(x(i))},${r1(y(q.p10))}`).reverse();
  const mid = band.close_q.map((q, i) => `${r1(x(i))},${r1(y(q.p50))}`);
  return s('svg', { class: 'qx-band-svg', viewBox: `0 0 ${W} ${Hh}`, role: 'img', 'aria-label': label, focusable: 'false' },
    s('line', { class: 'qx-zero', x1: pad, x2: W - pad, y1: r1(y(0)), y2: r1(y(0)) }),
    s('polygon', { class: 'qx-area', points: [...up, ...down].join(' ') }),
    s('polyline', { class: 'qx-mid', points: mid.join(' '), fill: 'none' }));
}

function band_table(ctx, ws, band) {
  const tr = ctx.tr;
  const f = fmt_of(env_of(ctx, ws));
  const rows = band.rows.map((r) => h('tr', null, h('td', { text: f.date(r.date) }), h('td', { class: 'num', text: f.money(r.p10) }), h('td', { class: 'num', text: f.money(r.p50) }), h('td', { class: 'num', text: f.money(r.p90) })));
  return h('div', { class: 'table-wrap' }, table(tr('quality.band_caption'), [tr('quality.col_date'), tr('quality.col_p10'), tr('quality.col_p50'), tr('quality.col_p90')], rows, 'tbl qx-table'));
}

/** Описание результата для людей: счётчик наблюдений, подача доли, подписи малых выборок. */
function band_notes(ctx, ws, band) {
  const tr = ctx.tr;
  const num = pm_number(fmt_of(env_of(ctx, ws)));
  const n_label = band.enumerated ? band.n_paths : band.n_eff;
  const lines = [
    tr('quality.band_n', { n: band.n_eff, paths: band.n_paths, mode: tr(band.enumerated ? 'quality.mode_enum' : 'quality.mode_sample'), seed: band.seed }),
    tr('quality.band_gap', { text: present_text(tr, band.gap_presentation, num) }),
  ];
  if (quantile_label(10, n_label) === 'min_of_n') lines.push(tr('quality.label_p10_min', { n: n_label }));
  if (quantile_label(90, n_label) === 'max_of_n') lines.push(tr('quality.label_p90_max', { n: n_label }));
  if (band.coarse) lines.push(tr('quality.band_coarse'));
  return lines;
}

// ── расчёт и экран ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Посчитать коридор по источнику; результат кладётся в `deps.band` вместе с ключом. Возвращает результат `mc_band` (с отказом, если истории нет). */
export function compute_band(ctx, deps) {
  const src = source_of(ctx, deps);
  if (src === null) { deps.band = { key: null, result: null }; return null; }
  const result = mc_band(src.ws, src.analysis, { kinds: kinds_of(deps), n_paths: UI_PATHS });
  deps.band = { key: run_key(src, deps), result };
  return result;
}

/** Результат, если он посчитан для текущих данных и настроек; иначе `null` (устарел). */
export function fresh_band(ctx, deps) {
  const src = source_of(ctx, deps);
  return src !== null && deps.band.key === run_key(src, deps) ? deps.band.result : null;
}

/** Блок «Коридор остатка (эксперимент)» для экрана «Качество прогноза»: выбор источника, возмущений, кнопка расчёта и результат. */
export function render_band_section(ctx, deps) {
  const tr = ctx.tr;
  const sec = h('section', { id: 'qx-band', class: 'card qx-band', 'aria-labelledby': 'qx-band-title' },
    h('h3', { id: 'qx-band-title', text: tr('quality.band_title') }),
    h('p', { class: 'qx-badge', text: tr('quality.badge') }),
    h('p', { class: 'lead', text: tr('quality.band_lead') }));
  const src_select = h('select', { id: 'qx-source', 'aria-describedby': 'qx-source-hint', onchange: (ev) => {
    const v = ev?.target?.value ?? src_select.value;
    deps.ui.source = v === 'synthetic' ? 'synthetic' : 'mine';
    deps.focus.request('qx-source');
    ctx.refresh();
  } },
  h('option', { value: 'mine', selected: deps.ui.source === 'mine' ? true : null, text: tr('quality.source_mine') }),
  h('option', { value: 'synthetic', selected: deps.ui.source === 'synthetic' ? true : null, text: tr('quality.source_synth') }));
  src_select.value = deps.ui.source;
  sec.append(h('div', { class: 'field' }, h('label', { for: 'qx-source', text: tr('quality.source_label') }), src_select, h('p', { id: 'qx-source-hint', class: 'muted', text: tr('quality.source_hint') })));
  const kinds = h('fieldset', { class: 'qx-kinds' }, h('legend', { text: tr('quality.kinds_label') }),
    h('div', { class: 'field check' }, h('label', null, h('input', { type: 'checkbox', id: 'qx-kind-lag', checked: true, disabled: true }), ' ', tr('quality.kind_lag'))));
  for (const k of OPTIONAL_KINDS) {
    const c = check_field(ctx, 'qxk', k, deps.ui.kinds[k] === true, { label: tr('quality.kind_' + k) });
    c.input.addEventListener('change', () => { deps.ui.kinds[k] = is_checked(c.input); });
    kinds.append(c.wrap);
  }
  sec.append(kinds);
  sec.append(h('div', { class: 'row' }, h('button', {
    type: 'button', class: 'btn primary', id: 'qx-band-run', text: tr('quality.band_run'),
    onclick: () => { deps.focus.request('qx-band-result'); compute_band(ctx, deps); ctx.refresh(); },
  })));
  const out = h('div', { id: 'qx-band-result', class: 'qx-result', tabindex: '-1', role: 'region', 'aria-label': tr('quality.band_result_label') });
  const src = source_of(ctx, deps);
  const res = src === null ? null : fresh_band(ctx, deps);
  if (src === null) out.append(h('p', { class: 'muted', text: tr('quality.no_data') }));
  else if (res === null) out.append(h('p', { class: 'muted', id: 'qx-band-hint', text: deps.band.result === null ? tr('quality.band_not_run') : tr('quality.band_stale') }));
  else if (res.ok !== true) out.append(h('p', { class: 'banner', role: 'status', id: 'qx-band-refusal', text: refusal_for(ctx, src.ws, res) }));
  else {
    if (src.synthetic) out.append(h('p', { class: 'banner', id: 'qx-band-synth', text: tr('quality.synth_note') }));
    const f = fmt_of(env_of(ctx, src.ws));
    const last = res.rows[res.rows.length - 1];
    out.append(
      h('p', { class: 'qx-badge', text: tr('quality.badge') }),
      band_svg(res, tr('quality.band_svg_label', { from: f.date(res.rows[0].date), to: f.date(last.date), lo: f.money(Math.min(...res.close_q.map((q) => q.p10))), hi: f.money(Math.max(...res.close_q.map((q) => q.p90))) })),
      h('ul', { class: 'plain qx-notes', id: 'qx-band-notes' }, band_notes(ctx, src.ws, res).map((t) => h('li', { text: t }))),
      band_table(ctx, src.ws, res));
  }
  sec.append(out);
  return sec;
}

/**
 * Карточка «Обзора» с коридором — только при согласии. Не считает сама: показывает последний результат для текущих данных или ведёт на экран «Качество прогноза».
 * Без согласия возвращает `null`: на «Обзоре» ничего не меняется.
 */
export function render_band_card(ctx, deps) {
  if (!consent_on(deps)) return null;
  const tr = ctx.tr;
  const card = h('section', { id: 'qx-card', class: 'card qx-card', 'aria-labelledby': 'qx-card-title' },
    h('h3', { id: 'qx-card-title', text: tr('quality.card_title') }), h('p', { class: 'qx-badge', text: tr('quality.badge') }));
  const src = deps.ui.source === 'mine' ? source_of(ctx, deps) : null;
  const res = src === null ? null : fresh_band(ctx, deps);
  if (res !== null && res.ok === true) {
    const f = fmt_of(env_of(ctx, src.ws));
    const last = res.rows[res.rows.length - 1];
    card.append(band_svg(res, tr('quality.band_svg_label', { from: f.date(res.rows[0].date), to: f.date(last.date), lo: f.money(Math.min(...res.close_q.map((q) => q.p10))), hi: f.money(Math.max(...res.close_q.map((q) => q.p90))) })),
      h('p', { class: 'muted', text: tr('quality.band_n', { n: res.n_eff, paths: res.n_paths, mode: tr(res.enumerated ? 'quality.mode_enum' : 'quality.mode_sample'), seed: res.seed }) }));
  } else if (res !== null && res.ok !== true) {
    card.append(h('p', { class: 'muted', text: refusal_for(ctx, src.ws, res) }));
  } else card.append(h('p', { class: 'muted', text: tr('quality.card_run') }));
  card.append(h('p', null, h('a', { class: 'btn', href: '#quality', text: tr('quality.card_go') })));
  return card;
}
