// quality.mjs — экран «Качество прогноза» (#quality, FP-11, REQ-053, REQ-054, REQ-055, REQ-176, REQ-188, решение владельца № 3).
// Что на экране. (1) Проверка на СИНТЕТИЧЕСКИХ журналах: FRR (доля ответов «выдерживает», после которых буфер всё же был пробит), cry-wolf (доля тревог «хрупко» / «не хватает» без пробоя), число
// наблюдений n и дата замера; числа читаются из отчёта `data/backtest-report.json` (зеркало — `quality_report.mjs`, его пишет `tools/backtest_report.mjs`); везде пометка «синтетика»: журналы сгенерированы
// программой, это не данные пользователей и не свидетельство качества на реальных людях. (2) «Привычки платежей» — карточка только при не менее чем 10 сопоставленных наблюдениях потока (REQ-053), плюс
// ряд «ожидаемый» как оценка (не режим расчёта). (3) «Эксперимент»: явное согласие (флажок и кнопка подтверждения), после которого открываются вероятностная полоса P10–P90 (`prob_band.mjs`) и «при уверенности α максимум X»
// (`prob_buy.mjs`). Без согласия ничего вероятностного нет ни здесь, ни на «Обзоре». Модель (отчёт, привычки) чистая, без DOM, проверяется в Node. Расчёт по введённым данным, не консультация.

import { narrowest_point } from '../engine/index.mjs';
import { mc_observations, payment_habits } from '../engine/mc_inputs.mjs';
import { expected_series, EXPECTED_MIN_OBS } from '../engine/expected.mjs';
import { h, table } from './dom.mjs';
import { env_of, fmt_of, is_checked } from './forms.mjs';
import { make_nf_fmt } from './number_format.mjs';
import { SYNTH_REPORT } from './quality_report.mjs';
import { consent_on, write_consent, flow_name, render_band_section, make_prob_deps } from './prob_band.mjs';
import { render_buy_section } from './prob_buy.mjs';

/** Порядок корпусов синтетики на экране. */
export const CORPUS_ORDER = Object.freeze(['regular', 'stress']);
/** Причины, по которым гейт REQ-176 не пройден (словарь `release_gate`). */
export const GATE_REASONS = Object.freeze(['journals_lt_10', 'no_ok_verdicts', 'no_alarms', 'frr_above_5pct', 'cry_wolf_above_50pct']);

/** Создать зависимости экрана (общие с полосой и «при уверенности α»). */
export function make_deps(env = {}) {
  return make_prob_deps(env);
}

// ── модель ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Строки таблицы проверки на синтетике из отчёта: корпус, число журналов, FRR и cry-wolf (k из n, bp), решение гейта и его причины.
 * @param {object} [report] отчёт `runway-backtest-report/1` (по умолчанию зеркало `SYNTH_REPORT`)
 */
export function report_rows(report = SYNTH_REPORT) {
  return CORPUS_ORDER.filter((c) => Object.hasOwn(report.corpora, c)).map((name) => {
    const c = report.corpora[name];
    return { corpus: name, n_journals: c.n_journals, frr: c.frr, cry_wolf: c.cry_wolf, pass: c.gate.pass, reasons: c.gate.reasons };
  });
}

/**
 * Привычки платежей и ряд «ожидаемый» по истории пользователя: потоки с n ≥ 10 (карточка показывается только при них), лучший поток по числу наблюдений,
 * узкая точка ряда «ожидаемый» рядом с планом (оценка, не режим расчёта).
 * @param {object} ws
 * @param {object} analysis результат `analyze` на этой рабочей области
 */
export function habits_model(ws, analysis) {
  const obs = mc_observations(ws, ws.as_of);
  const habits = payment_habits(obs.lag_obs, obs.ratio_obs_bp, { min_n: EXPECTED_MIN_OBS });
  let expected = null;
  if (habits.shown.length > 0) {
    const e = expected_series(ws, analysis, obs);
    const plan = narrowest_point(analysis.series.plan, analysis.as_of, analysis.horizon_end);
    const est = narrowest_point({ from: e.from, trough: e.trough }, analysis.as_of, analysis.horizon_end);
    expected = { shifted: e.shifted.length, same_as_plan: e.same_as_plan, plan, estimate: est };
  }
  return { habits, best_n: obs.flows.length === 0 ? 0 : obs.flows[0].n, n_pairs: obs.n_pairs, expected, min_n: EXPECTED_MIN_OBS };
}

// ── узлы ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

function metric_text(ctx, f, m) {
  return m.n === 0 ? ctx.tr('quality.metric_none') : ctx.tr('quality.metric', { k: m.k, n: m.n, bp: f.bp(m.bp) });
}

function report_section(ctx, report) {
  const tr = ctx.tr;
  const f = ctx.fmt() ?? make_nf_fmt(ctx.lang(), 'EUR', report.date); // до загрузки набора данных форматтеров приложения ещё нет
  const rows = report_rows(report).map((r) => h('tr', { id: 'qx-row-' + r.corpus },
    h('th', { scope: 'row', text: tr('quality.corpus_' + r.corpus) }),
    h('td', { class: 'num', text: String(r.n_journals) }),
    h('td', { text: metric_text(ctx, f, r.frr) }),
    h('td', { text: metric_text(ctx, f, r.cry_wolf) }),
    h('td', { text: r.pass ? tr('quality.gate_pass') : tr('quality.gate_fail', { reasons: r.reasons.map((x) => tr('quality.gate_reason_' + x)).join('; ') }) })));
  const w = report.waves.corpora;
  const wave_rows = CORPUS_ORDER.filter((c) => Object.hasOwn(w, c)).map((c) => {
    const x = w[c];
    const ch = x.changed;
    return h('tr', null,
      h('th', { scope: 'row', text: tr('quality.corpus_' + c) }),
      h('td', { class: 'num', text: String(x.n_journals) }),
      h('td', { class: 'num', text: String(x.waves) }),
      h('td', { text: tr('quality.metric', { k: x.single, n: x.waves, bp: f.bp(x.single_share_bp ?? 0) }) }),
      h('td', { text: tr('quality.waves_changed', {
        g1: ch['gap_days-1'].changed_waves, g2: ch['gap_days+1'].changed_waves, s1: ch['max_span_days-3'].changed_waves, s2: ch['max_span_days+3'].changed_waves, n: x.waves,
      }) }));
  });
  return h('section', { id: 'qx-report', class: 'card qx-report', 'aria-labelledby': 'qx-report-title' },
    h('h3', { id: 'qx-report-title', text: tr('quality.report_title') }),
    h('p', { class: 'banner qx-synth', id: 'qx-synth', role: 'note', text: tr('quality.synth_banner') }),
    h('p', { class: 'muted', id: 'qx-meta', text: tr('quality.report_meta', { date: f.date(report.date), version: report.engine_version, n: report.n_journals, h: report.params['backtest.h_days'] }) }),
    h('div', { class: 'table-wrap' }, table(tr('quality.report_caption'), [tr('quality.col_corpus'), tr('quality.col_journals'), tr('quality.col_frr'), tr('quality.col_cry'), tr('quality.col_gate')], rows, 'tbl qx-table')),
    h('dl', { class: 'qx-defs' },
      h('dt', { text: tr('quality.def_frr_t') }), h('dd', { text: tr('quality.def_frr') }),
      h('dt', { text: tr('quality.def_cry_t') }), h('dd', { text: tr('quality.def_cry') }),
      h('dt', { text: tr('quality.def_n_t') }), h('dd', { text: tr('quality.def_n') })),
    h('h4', { text: tr('quality.waves_title') }),
    h('p', { class: 'muted', text: tr('quality.waves_lead', { g: report.params['wave.gap_days'], s: report.params['wave.max_span_days'], dg: report.waves.deltas.gap_days, ds: report.waves.deltas.max_span_days }) }),
    h('div', { class: 'table-wrap' }, table(tr('quality.waves_caption'), [tr('quality.col_corpus'), tr('quality.col_journals'), tr('quality.col_waves'), tr('quality.col_single'), tr('quality.col_sens')], wave_rows, 'tbl qx-table')),
    h('p', { class: 'muted', text: tr('quality.report_note') }));
}

function habits_section(ctx, ws, analysis) {
  const tr = ctx.tr;
  let m;
  try { m = habits_model(ws, analysis); } catch { return h('p', { class: 'muted', id: 'qx-habits-error', text: tr('quality.habits_error') }); }
  if (m.habits.shown.length === 0) {
    return h('p', { class: 'muted', id: 'qx-habits-hint', text: tr('quality.habits_hint', { min: m.min_n, best: m.best_n }) });
  }
  const f = fmt_of(env_of(ctx, ws));
  const rows = m.habits.shown.map((x) => h('tr', null,
    h('th', { scope: 'row', text: flow_name(ws, x.key) }),
    h('td', { class: 'num', text: String(x.n) }),
    h('td', { class: 'num', text: String(x.p50) }),
    h('td', { class: 'num', text: String(x.p80) }),
    h('td', { class: 'num', text: x.p90_is_max ? tr('quality.p90_max', { v: x.p90, n: x.n }) : String(x.p90) })));
  const sec = h('section', { id: 'qx-habits', class: 'card qx-habits', 'aria-labelledby': 'qx-habits-title' },
    h('h3', { id: 'qx-habits-title', text: tr('quality.habits_title') }),
    h('p', { class: 'lead', text: tr('quality.habits_lead') }),
    h('div', { class: 'table-wrap' }, table(tr('quality.habits_caption'), [tr('quality.col_flow'), tr('quality.col_n'), tr('quality.col_hab_p50'), tr('quality.col_hab_p80'), tr('quality.col_hab_p90')], rows, 'tbl qx-table')));
  if (m.habits.hidden.length > 0) sec.append(h('p', { class: 'muted', text: tr('quality.habits_hidden', { n: m.habits.hidden.length, min: m.min_n }) }));
  if (m.expected !== null) {
    sec.append(h('p', { id: 'qx-expected', class: 'qx-expected', text: m.expected.same_as_plan
      ? tr('quality.expected_same')
      : tr('quality.expected_line', { est: f.money(m.expected.estimate.amount_minor), est_date: f.date(m.expected.estimate.date), plan: f.money(m.expected.plan.amount_minor), plan_date: f.date(m.expected.plan.date) }) }),
    h('p', { class: 'muted', text: tr('quality.expected_note') }));
  }
  return sec;
}

function experiment_section(ctx, deps) {
  const tr = ctx.tr;
  const on = consent_on(deps);
  const sec = h('section', { id: 'qx-exp', class: 'card qx-exp', 'aria-labelledby': 'qx-exp-title' },
    h('h3', { id: 'qx-exp-title', text: tr('quality.exp_title') }),
    h('p', { class: 'qx-badge', text: tr('quality.badge') }),
    h('p', { class: 'lead', text: tr('quality.exp_lead') }),
    h('p', { id: 'qx-exp-state', role: 'status', text: tr(on ? 'quality.exp_on' : 'quality.exp_off') }));
  // согласие на время сеанса: хранилища нет или запись в него не удалась (deps.mem) — честно говорим, что до перезагрузки
  if (deps.storage === null || deps.mem === true) sec.append(h('p', { class: 'muted', id: 'qx-exp-nostorage', text: tr('quality.exp_nostorage') }));
  if (!on) {
    const agree = h('input', { type: 'checkbox', id: 'qx-agree', checked: deps.ui.agree ? true : null, 'aria-describedby': 'qx-agree-err' });
    const err = h('p', { id: 'qx-agree-err', class: 'error', role: 'alert', text: deps.ui.agree_error ? tr('quality.agree_needed') : '' });
    agree.addEventListener('change', () => { deps.ui.agree = is_checked(agree); });
    sec.append(
      h('div', { class: 'field check' }, h('label', { for: 'qx-agree' }, agree, ' ', tr('quality.agree_label'))), err,
      h('div', { class: 'row' }, h('button', {
        type: 'button', class: 'btn primary', id: 'qx-enable', text: tr('quality.enable'),
        onclick: () => {
          deps.ui.agree = is_checked(agree);
          if (!deps.ui.agree) { deps.ui.agree_error = true; deps.focus.request('qx-agree'); ctx.refresh(); return; }
          deps.ui.agree_error = false;
          if (!write_consent(deps.storage, true)) deps.mem = true;
          deps.focus.request('qx-exp-title');
          ctx.notify(tr('quality.enabled_note'), 'info');
          ctx.refresh();
        },
      })));
    return sec;
  }
  sec.append(h('div', { class: 'row' }, h('button', {
    type: 'button', class: 'btn', id: 'qx-disable', text: tr('quality.disable'),
    onclick: () => {
      write_consent(deps.storage, false);
      deps.mem = false;
      deps.ui.agree = false;
      deps.band = { key: null, result: null };
      deps.buy = { key: null, result: null, error: null };
      deps.focus.request('qx-exp-title');
      ctx.notify(tr('quality.disabled_note'), 'info');
      ctx.refresh();
    },
  })));
  return sec;
}

/**
 * Экран «Качество прогноза» (#quality).
 * @param {object} ctx контекст расширений
 * @param {ReturnType<typeof make_deps>} deps
 * @param {object} [report] отчёт для таблицы (по умолчанию зеркало)
 */
export function render_quality(ctx, deps, report = SYNTH_REPORT) {
  const tr = ctx.tr;
  const root = h('div', { class: 'view quality' }, h('h2', { id: 'view-title', tabindex: '-1', text: tr('quality.title') }), h('p', { class: 'lead', text: tr('quality.lead') }));
  root.append(report_section(ctx, report));
  const ws = ctx.get_ws();
  const model = ctx.get_model();
  if (ws !== null && ws !== undefined && model !== null && model !== undefined) root.append(habits_section(ctx, ws, model.ctx));
  const exp = experiment_section(ctx, deps);
  root.append(exp);
  if (consent_on(deps)) root.append(render_band_section(ctx, deps), render_buy_section(ctx, deps));
  root.append(h('p', { class: 'muted qx-note', text: tr('quality.disclaimer') }));
  deps.focus.apply();
  return root;
}
