// promises.mjs — страница «обещаем / не обещаем» с реестром утверждений (REQ-184, REQ-178, IDEA-53, IDEA-92).
// Реестр: `claims{id, text_key, level: verified | measured(n, date) | hypothesis, test}` в `promises.json`; линтер `node tools/lint_vocab.mjs --registry`
// блокирует сборку, если в интерфейсе есть утверждение уровня `hypothesis`, измерение старше 90 дней или запрещённая формулировка.
// Здесь: `REGISTRY` — зеркало `promises.json` (страница не читает JSON: сеть и динамический import разрешены только приложению и манифесту; равенство двух
// копий проверяет tests/promises.test.mjs), проверка формы реестра, отбор строк для показа и сама страница. Строка с уровнем `hypothesis` в интерфейс не попадает.
// Модели чистые (без DOM, без часов: «сегодня» приходит аргументом). Расчёт по введённым данным и правилам, не консультация.

import { to_epoch_day, format_date } from '../engine/index.mjs';
import { h } from './dom.mjs';

/** Уровни доказанности: проверено тестом / измерено (n, дата) / гипотеза (в интерфейсе запрещена). */
export const CLAIM_LEVELS = Object.freeze(['verified', 'measured', 'hypothesis']);

/** Виды строк: что обещаем и чего не обещаем. */
export const CLAIM_KINDS = Object.freeze(['promise', 'non_promise']);

/** Срок годности измерения, дней (REQ-178): старше — строка помечается устаревшей, линтер блокирует сборку. */
export const MEASURE_TTL_DAYS = 90;

const claim = (id, kind, level, test_file, test_id, extra = {}) => Object.freeze({
  id, kind, text_key: 'showcase.cl_' + id, level, surface: 'ui', checked_on: '2026-10-05', ...extra, test: Object.freeze({ file: test_file, id: test_id }),
});

/** Зеркало `demo/promises.json` (порядок строк — порядок на странице). */
export const REGISTRY = Object.freeze([
  claim('golden', 'promise', 'verified', 'tests/g001.test.mjs', 'TST-01'),
  claim('minor_units', 'promise', 'verified', 'tests/money.test.mjs', 'TST-18'),
  claim('deterministic', 'promise', 'verified', 'tests/analyze.test.mjs', 'TST-33'),
  claim('gate', 'promise', 'verified', 'tests/afford.test.mjs', 'TST-04'),
  claim('a0_numbers', 'promise', 'verified', 'tests/verifier.test.mjs', 'TST-45'),
  claim('debt_zero', 'promise', 'verified', 'tests/debt.test.mjs', 'TST-29'),
  claim('journal_append', 'promise', 'verified', 'tests/journal_log.test.mjs', 'TST-16'),
  claim('no_network', 'promise', 'verified', 'tests/demo.test.mjs', 'TST-59'),
  claim('untrusted', 'promise', 'verified', 'tests/injection.test.mjs', 'TST-46'),
  claim('journal_speed', 'promise', 'measured', 'tests/journal_log.test.mjs', 'REQ-153', { measured_on: '2026-10-05', n: 3 }),
  claim('wizard_reasons', 'promise', 'verified', 'tests/wizard.test.mjs', 'REQ-110', { checked_on: '2026-10-09' }),
  claim('v0_same_engine', 'promise', 'verified', 'tests/v0.test.mjs', 'REQ-180', { checked_on: '2026-10-09' }),
  claim('local_metrics', 'promise', 'verified', 'tests/metrics.test.mjs', 'REQ-185', { checked_on: '2026-10-09' }),
  claim('template_no_rates', 'promise', 'verified', 'tests/wizard.test.mjs', 'REQ-068', { checked_on: '2026-10-09' }),
  claim('prob_off_by_default', 'promise', 'verified', 'tests/prob_band.test.mjs', 'TST-49', { checked_on: '2026-10-09' }),
  claim('quality_synthetic', 'promise', 'verified', 'tests/quality_report.test.mjs', 'TST-55', { checked_on: '2026-10-09' }),
  claim('accuracy', 'non_promise', 'verified', 'tests/demo.test.mjs', 'TST-56'),
  claim('advice', 'non_promise', 'verified', 'tests/demo.test.mjs', 'TST-56'),
  claim('bank_sync', 'non_promise', 'verified', 'tests/demo.test.mjs', 'TST-59'),
  claim('migration', 'non_promise', 'verified', 'tests/import_wizard.test.mjs', 'TST-42'),
  claim('first_minutes', 'non_promise', 'verified', 'tests/demo.test.mjs', 'TST-56'),
  claim('buy_advice', 'non_promise', 'verified', 'tests/afford.test.mjs', 'TST-04'),
  claim('human_review_pending', 'non_promise', 'verified', 'tests/wizard.test.mjs', 'REQ-183', { checked_on: '2026-10-09' }),
  claim('prob_not_promise', 'non_promise', 'verified', 'tests/prob_band.test.mjs', 'TST-49', { checked_on: '2026-10-09' }),
]);

/** Ключ строки каталога для утверждения: `showcase.cl_<id>` (динамическая часть — идентификатор). */
export function claim_key(id) {
  return 'showcase.cl_' + id;
}

function valid_iso(s) {
  try { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && format_date(to_epoch_day(s)) === s; } catch { return false; }
}

/**
 * Проверка формы реестра: у каждой строки есть уровень и тест (файл и идентификатор), дата проверки, ключ текста по правилу, `measured` — с `n` и датой;
 * идентификаторы не повторяются.
 * @param {any} rows
 * @returns {string[]} описания нарушений (пусто — реестр в порядке)
 */
export function validate_registry(rows) {
  const errors = [];
  if (!Array.isArray(rows)) return ['registry_not_array'];
  const seen = new Set();
  rows.forEach((r, i) => {
    const at = 'row ' + i + (typeof r?.id === 'string' ? ' (' + r.id + ')' : '');
    if (r === null || typeof r !== 'object') { errors.push(at + ': not_object'); return; }
    if (typeof r.id !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/.test(r.id)) errors.push(at + ': bad_id');
    else if (seen.has(r.id)) errors.push(at + ': duplicate_id');
    else seen.add(r.id);
    if (!CLAIM_KINDS.includes(r.kind)) errors.push(at + ': bad_kind');
    if (!CLAIM_LEVELS.includes(r.level)) errors.push(at + ': no_level');
    if (r.text_key !== claim_key(r.id)) errors.push(at + ': bad_text_key');
    if (r.test === null || typeof r.test !== 'object' || typeof r.test.file !== 'string' || r.test.file === '' || typeof r.test.id !== 'string' || r.test.id === '') errors.push(at + ': no_test');
    if (!valid_iso(r.checked_on)) errors.push(at + ': no_checked_on');
    if (r.level === 'measured') {
      if (!valid_iso(r.measured_on)) errors.push(at + ': measured_without_date');
      if (!Number.isSafeInteger(r.n) || r.n < 1) errors.push(at + ': measured_without_n');
    }
    if (r.surface !== 'ui' && r.surface !== 'doc') errors.push(at + ': bad_surface');
  });
  return errors;
}

/** Строки для показа в интерфейсе: только `surface = ui`, и никогда не `hypothesis` (REQ-178: гипотеза в интерфейсе — отказ линтера). */
export function visible_rows(rows) {
  return rows.filter((r) => r.surface === 'ui' && r.level !== 'hypothesis');
}

/**
 * Состояние строки на день `today` (epoch day): `measured` старше 90 дней — `stale`; остальное — `ok`.
 * @returns {{state: 'ok'|'stale', age_days: number|null}}
 */
export function claim_status(row, today) {
  if (row.level !== 'measured') return { state: 'ok', age_days: null };
  const age = today - to_epoch_day(row.measured_on);
  return { state: age > MEASURE_TTL_DAYS ? 'stale' : 'ok', age_days: age };
}

/**
 * Модель страницы: два списка («обещаем», «не обещаем») и признак нарушений реестра.
 * @param {number} today epoch day (в демо — дата расчёта рабочей области: часов у страницы для этого нет)
 * @param {readonly object[]} [rows]
 */
export function promises_model(today, rows = REGISTRY) {
  const vis = visible_rows(rows).map((r) => ({ ...r, status: claim_status(r, today) }));
  return {
    promise: vis.filter((r) => r.kind === 'promise'),
    non_promise: vis.filter((r) => r.kind === 'non_promise'),
    problems: validate_registry(rows),
    hidden: rows.length - vis.length,
  };
}

// ── DOM ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

function level_text(ctx, r) {
  if (r.level === 'measured') return ctx.tr('showcase.pr_level_measured', { n: r.n, date: ctx.fmt().date(r.measured_on) });
  return ctx.tr('showcase.pr_level_verified');
}

function section(ctx, kind_key, rows) {
  const tr = ctx.tr;
  const f = ctx.fmt();
  const body = rows.map((r) => h('tr', null,
    h('th', { scope: 'row', text: tr(claim_key(r.id)) }),
    h('td', null, h('span', { text: level_text(ctx, r) }), r.status.state === 'stale' ? h('span', { class: 'bad', text: ' · ' + tr('showcase.pr_stale', { days: r.status.age_days }) }) : null),
    h('td', { class: 'muted', text: r.test.file + ' · ' + r.test.id }),
    h('td', { class: 'muted', text: f.date(r.checked_on) })));
  return h('section', { class: 'card' }, h('h3', { text: tr(kind_key) }),
    h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('caption', { class: 'sr-only', text: tr(kind_key) }),
      h('thead', null, h('tr', null, ['showcase.pr_col_claim', 'showcase.pr_col_level', 'showcase.pr_col_test', 'showcase.pr_col_date'].map((k) => h('th', { scope: 'col', text: tr(k) })))),
      h('tbody', null, body))));
}

/**
 * Страница «Обещаем / не обещаем».
 * @param {object} ctx
 * @returns {HTMLElement}
 */
export function render_promises(ctx) {
  const tr = ctx.tr;
  const ws = ctx.get_ws();
  const today = ws === null ? to_epoch_day('2026-10-05') : to_epoch_day(ws.as_of);
  const m = promises_model(today);
  return h('div', { class: 'view sc-view' },
    h('h2', { id: 'view-title', tabindex: '-1', text: tr('showcase.pr_title') }),
    h('p', { class: 'lead', text: tr('showcase.pr_lead') }),
    m.problems.length > 0 ? h('p', { class: 'banner short', role: 'alert', text: tr('showcase.pr_problems', { n: m.problems.length }) }) : null,
    section(ctx, 'showcase.pr_promise', m.promise),
    section(ctx, 'showcase.pr_non_promise', m.non_promise),
    h('p', { class: 'muted', text: tr('showcase.pr_rules', { days: MEASURE_TTL_DAYS }) }),
    h('p', { class: 'muted', text: tr('showcase.tax_note') }));
}
