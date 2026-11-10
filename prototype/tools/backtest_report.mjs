// backtest_report.mjs — отчёт backtest на СИНТЕТИЧЕСКИХ журналах: FRR, cry-wolf, n, дата (FP-11, REQ-176, REQ-188, ALG-13, TST-55).
// Что делает: прогоняет `engine/backtest.mjs` по двум корпусам `data/synthetic-journals` («обычные» 12 и «стресс» 10), считает гейт релиза `release_gate` (REQ-176) по каждому
// корпусу и для каждого журнала — число волн, долю волн из одного платежа и чувствительность состава волн к `wave.gap_days` ±1 и `wave.max_span_days` ±3 (REQ-188), затем печатает
// сводку и пишет файл `data/backtest-report.json` формата `runway-backtest-report/1`. «Vocab-совместимый»: имена параметров — ключи `params` из `engine/vocab.json`
// (`backtest.h_days`, `wave.gap_days`, …), порядок и словарь вердиктов — оттуда же; `validate_report` проверяет это. Принятые значения `vocab.json` отчёт НЕ меняет:
// решение о правке словаря — за владельцем (канон v1.1 неприкосновенен).
// ВАЖНО: журналы синтетические (не данные пользователей); гейт на них — демонстрация метрики и оснастки, а не свидетельство о качестве прогноза на реальных людях.
// Дата замера передаётся аргументом `--date ГГГГ-ММ-ДД`: инструмент часы не читает, чистые функции модуля (`build_report`, `wave_stats`, `validate_report`) тоже. Запись и чтение файлов — только
// в командной строке. Расчёт по введённым данным, не консультация.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fail, round_div } from '../engine/money.mjs';
import { parse_date, format_date } from '../engine/dates.mjs';
import { canon, sha256 } from '../engine/ledger.mjs';
import { analyze, ENGINE_VERSION } from '../engine/index.mjs';
import { backtest, release_gate, replay_state, BACKTEST_DEFAULTS } from '../engine/backtest.mjs';
import { detect_waves } from '../engine/waves.mjs';
import { flat_params } from '../engine/timeline.mjs';
import { make_journal, journal_hash, regular_corpus, stress_corpus } from '../data/synthetic-journals/generate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');

/** Формат файла отчёта. */
export const REPORT_FORMAT = 'runway-backtest-report/1';
/** Первое начало прогноза и шаг сравнения backtest, дней (как в `tests/backtest.test.mjs`). */
export const BACKTEST_RUN = Object.freeze({ t0: '2026-03-01', h: 14 });
/** Начало и горизонт расчёта волн для REQ-188 (журналы синтетики охватывают 2026-01-01 … 2026-09-30). */
export const WAVE_RUN = Object.freeze({ origin: '2026-06-01', horizon_days: 120 });
/** Отклонения параметров волн по REQ-188: `wave.gap_days` ±1, `wave.max_span_days` ±3. */
export const WAVE_DELTAS = Object.freeze({ gap_days: 1, max_span_days: 3 });

const CORPORA = Object.freeze({ regular: regular_corpus, stress: stress_corpus });

// ── REQ-188: волны ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Доля в bp: `round_div(10000·k, n)`, `null` при `n = 0`. */
const bp_of = (k, n) => (n === 0 ? null : round_div(10000 * k, n));

/** Состав волн как множество строк: идентификаторы платежей по порядку, склеенные через «|». */
function composition(waves) {
  return waves.map((w) => w.event_ids.join('|'));
}

/**
 * Число волн, доля волн из одного платежа и чувствительность состава к `wave.gap_days` ±1 и `wave.max_span_days` ±3 (REQ-188).
 * «Изменилась» — волна базового состава, которой нет (как точного набора платежей) в варианте; «число волн» — длина списка волн варианта.
 * @param {object[]} events эффективные события режима `plan` (`Analysis.events.plan`)
 * @param {object} params действующие параметры (`Analysis.params`: плоские ключи `wave.*`)
 * @returns {{waves: number, single: number, single_share_bp: number|null, payments: number, theta_minor: number,
 *   gap_days: number, max_span_days: number,
 *   sensitivity: Object<string, {gap_days: number, max_span_days: number, waves: number, delta_waves: number, changed_waves: number, changed_share_bp: number|null}>}}
 */
export function wave_stats(events, params) {
  const base_params = flat_params(params);
  const g = base_params['wave.gap_days'];
  const S = base_params['wave.max_span_days'];
  const run = (gap, span) => detect_waves(events, { ...base_params, 'wave.gap_days': gap, 'wave.max_span_days': span });
  const base = run(g, S);
  const base_comp = composition(base);
  const variant = (gap, span) => {
    const w = run(gap, span);
    const have = new Set(composition(w));
    const changed = base_comp.filter((c) => !have.has(c)).length;
    return { gap_days: gap, max_span_days: span, waves: w.length, delta_waves: w.length - base.length, changed_waves: changed, changed_share_bp: bp_of(changed, base.length) };
  };
  const single = base.filter((w) => w.event_ids.length === 1).length;
  return {
    waves: base.length,
    single,
    single_share_bp: bp_of(single, base.length),
    payments: base.reduce((s, w) => s + w.event_ids.length, 0),
    theta_minor: base_params['wave.threshold_minor'],
    gap_days: g,
    max_span_days: S,
    sensitivity: {
      'gap_days-1': variant(Math.max(0, g - WAVE_DELTAS.gap_days), S),
      'gap_days+1': variant(g + WAVE_DELTAS.gap_days, S),
      'max_span_days-3': variant(g, Math.max(1, S - WAVE_DELTAS.max_span_days)),
      'max_span_days+3': variant(g, S + WAVE_DELTAS.max_span_days),
    },
  };
}

// ── строки отчёта ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Компактная строка журнала из `Report` backtest. */
export function journal_row(id, r) {
  return {
    id,
    n_origins: r.n_origins,
    frr: { k: r.frr.k, n: r.frr.n, bp: r.frr.bp },
    cry_wolf: { k: r.cry_wolf.k, n: r.cry_wolf.n, bp: r.cry_wolf.bp },
    coverage: { k: r.coverage.k, n: r.coverage.n },
    mae_minor: r.mae_minor,
    bias_minor: r.bias_minor,
    skill_pm: r.skill_pm,
    min_error: { n: r.min_error.n, mean_bp: r.min_error.mean_bp, mae_bp: r.min_error.mae_bp },
    insufficient: r.insufficient,
    n_tight: r.n_tight,
    censored: r.censored,
  };
}

function gate_block(rows) {
  const g = release_gate(rows);
  return { pass: g.pass, reasons: g.reasons, n_journals: g.n_journals, k1: g.k1, n1: g.n1, k2: g.k2, n2: g.n2, frr_bp: g.frr_bp, cry_wolf_bp: g.cry_wolf_bp };
}

function wave_row(id, journal) {
  const t = parse_date(WAVE_RUN.origin);
  const s = replay_state(journal, t);
  const A = analyze(s, { as_of: t, horizon_days: WAVE_RUN.horizon_days, modes: ['plan'] });
  return { id, ...wave_stats(A.events.plan, A.params) };
}

function wave_summary(rows) {
  const waves = rows.reduce((s, r) => s + r.waves, 0);
  const single = rows.reduce((s, r) => s + r.single, 0);
  const sum = (key) => rows.reduce((s, r) => s + r.sensitivity[key].changed_waves, 0);
  const out = { n_journals: rows.length, waves, single, single_share_bp: bp_of(single, waves), changed: {} };
  for (const key of Object.keys(rows[0]?.sensitivity ?? {})) out.changed[key] = { changed_waves: sum(key), changed_share_bp: bp_of(sum(key), waves) };
  return out;
}

/** Значения параметров, к которым привязан отчёт: ключи — из `vocab.json → params`. */
function params_block() {
  return {
    'backtest.h_days': BACKTEST_DEFAULTS['backtest.h_days'],
    'backtest.min_window_days': BACKTEST_DEFAULTS['backtest.min_window_days'],
    'calib.min_origins': BACKTEST_DEFAULTS['calib.min_origins'],
    'wave.gap_days': 3,
    'wave.max_span_days': 10,
  };
}

/**
 * Собрать отчёт. Чистая по отношению к часам: дата — аргумент. Журналы строятся детерминированно (`generate.mjs`), прогон занимает десятки секунд.
 * @param {{date: string, corpora?: ('regular'|'stress')[], limit?: number}} opts `limit` — взять только первые N журналов каждого корпуса (для проверок; гейт тогда «журналов < 10»)
 * @returns {object} объект формата `runway-backtest-report/1`
 * @throws {RunwayError} E_BAD_DATE (дата не `ГГГГ-ММ-ДД`), E_SCHEMA (неизвестный корпус)
 */
export function build_report(opts) {
  const date = check_date(opts?.date);
  const names = opts.corpora ?? ['regular', 'stress'];
  const manifest = JSON.parse(fs.readFileSync(path.join(PROTO, 'data', 'synthetic-journals', 'manifest.json'), 'utf8'));
  const corpora = {};
  const waves = {};
  for (const name of names) {
    if (!Object.hasOwn(CORPORA, name)) fail('E_SCHEMA', { reason: 'unknown_corpus', corpus: String(name) });
    const specs = CORPORA[name]().slice(0, opts.limit ?? Infinity);
    const rows = [];
    const wrows = [];
    for (const spec of specs) {
      const j = make_journal(spec);
      const want = manifest.corpora[name].find((x) => x.id === spec.id);
      if (want === undefined || want.sha256 !== journal_hash(j)) fail('E_SCHEMA', { reason: 'journal_differs_from_manifest', id: spec.id });
      rows.push(journal_row(spec.id, backtest(j, BACKTEST_RUN.t0, BACKTEST_RUN.h)));
      wrows.push(wave_row(spec.id, j));
    }
    corpora[name] = { n_journals: rows.length, frr: sum_metric(rows, 'frr'), cry_wolf: sum_metric(rows, 'cry_wolf'), gate: gate_block(rows), journals: rows };
    waves[name] = { n_journals: wrows.length, summary: wave_summary(wrows), journals: wrows };
  }
  return {
    format: REPORT_FORMAT,
    source: 'tools/backtest_report.mjs на data/synthetic-journals; СИНТЕТИКА, не данные пользователей: гейт — демонстрация метрики, не свидетельство о качестве на реальных людях',
    synthetic: true,
    date,
    engine_version: ENGINE_VERSION,
    corpus_sha256: sha256(canon(manifest.corpora)),
    params: params_block(),
    backtest: { ...BACKTEST_RUN },
    n_journals: Object.values(corpora).reduce((s, c) => s + c.n_journals, 0),
    corpora,
    waves: { ...WAVE_RUN, deltas: { ...WAVE_DELTAS }, corpora: waves },
    note: 'Пороги FRR ≤ 5 %, cry-wolf ≤ 50 % и окна — гипотезы до замера на журналах добровольцев (C-055); чувствительность волн на синтетике не доказывает выбор параметров (REQ-188 ждёт ≥ 10 реальных журналов).',
  };
}

function sum_metric(rows, key) {
  const k = rows.reduce((s, r) => s + r[key].k, 0);
  const n = rows.reduce((s, r) => s + r[key].n, 0);
  return { k, n, bp: bp_of(k, n) };
}

function check_date(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('E_BAD_DATE', { reason: 'report_date_not_iso' });
  const d = parse_date(date);
  if (format_date(d) !== date) fail('E_BAD_DATE', { reason: 'report_date_not_canonical' });
  return date;
}

// ── проверка файла отчёта и гейт ─────────────────────────────────────────────────────────────────────────────────────────

let VOCAB = null;
function vocab() {
  if (VOCAB === null) VOCAB = JSON.parse(fs.readFileSync(path.join(PROTO, 'engine', 'vocab.json'), 'utf8'));
  return VOCAB;
}

const is_count = (x) => Number.isSafeInteger(x) && x >= 0;
const is_metric = (m) => m !== null && typeof m === 'object' && is_count(m.k) && is_count(m.n) && m.k <= m.n && (m.bp === null ? m.n === 0 : m.bp === round_div(10000 * m.k, m.n));

/**
 * Проверка файла отчёта: формат и пометка «синтетика», дата, ключи `params` — из `vocab.json`, целые счётчики, согласованные bp, гейт совпадает с пересчётом `release_gate`
 * по строкам журналов, число журналов, сумма счётчиков корпуса равна сумме по журналам.
 * @param {object} report
 * @returns {string[]} описания нарушений; пусто — отчёт корректен
 */
export function validate_report(report) {
  const bad = [];
  if (report === null || typeof report !== 'object') return ['not_object'];
  if (report.format !== REPORT_FORMAT) bad.push('format');
  if (report.synthetic !== true) bad.push('synthetic_flag_missing');
  try { check_date(report.date); } catch { bad.push('date'); }
  if (typeof report.engine_version !== 'string') bad.push('engine_version');
  if (typeof report.corpus_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(report.corpus_sha256)) bad.push('corpus_sha256');
  const v = vocab();
  for (const k of Object.keys(report.params ?? {})) if (!Object.hasOwn(v.params, k)) bad.push('param_not_in_vocab:' + k);
  for (const k of ['backtest.h_days', 'wave.gap_days', 'wave.max_span_days']) if (!Number.isSafeInteger(report.params?.[k])) bad.push('param_missing:' + k);
  let total = 0;
  for (const [name, c] of Object.entries(report.corpora ?? {})) {
    if (!Object.hasOwn(CORPORA, name)) { bad.push('corpus_unknown:' + name); continue; }
    if (!Array.isArray(c.journals) || c.journals.length !== c.n_journals) { bad.push(`${name}:journals`); continue; }
    total += c.n_journals;
    for (const r of c.journals) {
      if (typeof r.id !== 'string' || !is_metric(r.frr) || !is_metric(r.cry_wolf)) bad.push(`${name}:row:${r?.id}`);
    }
    if (!is_metric(c.frr) || !is_metric(c.cry_wolf)) bad.push(`${name}:totals`);
    else if (c.frr.k !== c.journals.reduce((s, r) => s + r.frr.k, 0) || c.frr.n !== c.journals.reduce((s, r) => s + r.frr.n, 0)
      || c.cry_wolf.k !== c.journals.reduce((s, r) => s + r.cry_wolf.k, 0) || c.cry_wolf.n !== c.journals.reduce((s, r) => s + r.cry_wolf.n, 0)) bad.push(`${name}:totals_differ_from_rows`);
    if (canon(c.gate) !== canon(gate_block(c.journals))) bad.push(`${name}:gate_differs_from_release_gate`);
  }
  if (total !== report.n_journals) bad.push('n_journals');
  for (const [name, w] of Object.entries(report.waves?.corpora ?? {})) {
    if (!Array.isArray(w.journals) || w.journals.length !== w.n_journals) { bad.push(`waves:${name}:journals`); continue; }
    for (const r of w.journals) {
      if (!is_count(r.waves) || !is_count(r.single) || r.single > r.waves) bad.push(`waves:${name}:row:${r?.id}`);
      for (const key of ['gap_days-1', 'gap_days+1', 'max_span_days-3', 'max_span_days+3']) if (!is_count(r.sensitivity?.[key]?.waves)) bad.push(`waves:${name}:${r?.id}:${key}`);
    }
  }
  return bad;
}

/**
 * Гейт релиза по файлу отчёта: `release_gate` читает строки журналов корпуса (`frr`/`cry_wolf` — счётчики `{k, n}`), а не готовое решение. Отчёт, не прошедший `validate_report`, — ошибка.
 * @param {object} report объект отчёта (из файла)
 * @param {'regular'|'stress'} corpus
 * @returns {ReturnType<typeof release_gate>}
 * @throws {RunwayError} E_SCHEMA (отчёт некорректен, корпуса нет в отчёте)
 */
export function gate_from_report(report, corpus) {
  const problems = validate_report(report);
  if (problems.length > 0) fail('E_SCHEMA', { reason: 'report_invalid', first: problems[0] });
  const c = report.corpora?.[corpus];
  if (c === undefined) fail('E_SCHEMA', { reason: 'corpus_not_in_report', corpus: String(corpus) });
  return release_gate(c.journals);
}

/** Прочитать файл отчёта (по умолчанию `data/backtest-report.json`). */
export function read_report(file = path.join(PROTO, 'data', 'backtest-report.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ── зеркало для демо ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Путь зеркала отчёта для страницы: демо не читает JSON (сеть разрешена только приложению), поэтому нужные числа лежат модулем рядом с экраном. */
export const MIRROR_FILE = path.join(PROTO, 'demo', 'quality_report.mjs');

/**
 * Сжатое представление отчёта для экрана «Качество прогноза»: те же числа, без метрик ошибки по журналам (они на экране не нужны).
 * Равенство зеркала и файла проверяет `tests/quality_report.test.mjs`.
 * @param {object} report
 * @returns {object}
 */
export function compact_report(report) {
  const corpora = {};
  for (const [name, c] of Object.entries(report.corpora)) {
    corpora[name] = {
      n_journals: c.n_journals, frr: { ...c.frr }, cry_wolf: { ...c.cry_wolf }, gate: { ...c.gate, reasons: [...c.gate.reasons] },
      journals: c.journals.map((r) => ({ id: r.id, n_origins: r.n_origins, frr: { ...r.frr }, cry_wolf: { ...r.cry_wolf } })),
    };
  }
  const waves = {};
  for (const [name, w] of Object.entries(report.waves.corpora)) {
    waves[name] = { n_journals: w.n_journals, waves: w.summary.waves, single: w.summary.single, single_share_bp: w.summary.single_share_bp, changed: structuredClone(w.summary.changed) };
  }
  return {
    format: report.format, synthetic: report.synthetic, date: report.date, engine_version: report.engine_version, n_journals: report.n_journals,
    params: { ...report.params }, backtest: { ...report.backtest }, corpora, waves: { origin: report.waves.origin, horizon_days: report.waves.horizon_days, deltas: { ...report.waves.deltas }, corpora: waves },
  };
}

/** Исходный текст модуля-зеркала (файл `demo/quality_report.mjs` создаёт командная строка, руками он не правится). */
export function mirror_source(report) {
  return `// quality_report.mjs — ЗЕРКАЛО data/backtest-report.json для экрана «Качество прогноза» (FP-11). СГЕНЕРИРОВАНО tools/backtest_report.mjs, руками не править.
// Числа получены на СИНТЕТИЧЕСКИХ журналах (data/synthetic-journals), это не данные пользователей. Страница JSON не читает: сеть разрешена только приложению.
export const SYNTH_REPORT = ${JSON.stringify(compact_report(report), null, 1)};
`;
}

// ── печать и командная строка ───────────────────────────────────────────────────────────────────────────────────────────

const NAMES = { regular: 'обычные', stress: 'стресс' };
const pct = (bp) => (bp === null ? '—' : (bp / 100).toFixed(2).replace('.', ',') + ' %');

/** Строки сводки для печати. */
export function summary_lines(report) {
  const out = [`Backtest на СИНТЕТИЧЕСКИХ журналах (не данные пользователей) · замер ${report.date} · движок ${report.engine_version} · журналов ${report.n_journals}`];
  for (const [name, c] of Object.entries(report.corpora)) {
    const g = c.gate;
    out.push(`${NAMES[name] ?? name}: журналов ${c.n_journals}; FRR ${c.frr.k} из ${c.frr.n} = ${c.frr.bp ?? '—'} bp (${pct(c.frr.bp)}); cry-wolf ${c.cry_wolf.k} из ${c.cry_wolf.n} = ${c.cry_wolf.bp ?? '—'} bp (${pct(c.cry_wolf.bp)}); гейт ${g.pass ? 'проходит' : 'не проходит (' + g.reasons.join(', ') + ')'}`);
  }
  for (const [name, w] of Object.entries(report.waves.corpora)) {
    const s = w.summary;
    const sens = Object.entries(s.changed).map(([k, v]) => `${k}: изменилось ${v.changed_waves} (${pct(v.changed_share_bp)})`).join('; ');
    out.push(`волны (${NAMES[name] ?? name}, ${w.n_journals} журналов): волн ${s.waves}, из одного платежа ${s.single} (${pct(s.single_share_bp)}); ${sens}`);
  }
  return out;
}

const HELP = `Использование: node tools/backtest_report.mjs --date ГГГГ-ММ-ДД [--out файл] [--corpus regular|stress|all] [--check]
  --date    дата замера (обязательна: инструмент часы не читает)
  --out     куда записать отчёт (по умолчанию data/backtest-report.json; при --corpus regular|stress обязателен и не может указывать на канонический файл)
  --corpus  какой корпус синтетики прогнать (по умолчанию оба; неполный прогон — только в отдельный файл через --out, зеркало для демо не пишется)
  --mirror  куда записать зеркало для демо (по умолчанию demo/quality_report.mjs); --no-mirror — не писать
  --check   ничего не писать: пересчитать и сравнить с файлом и зеркалом (код выхода 1, если не совпало)`;

export function main(argv, io = { read: (p) => fs.readFileSync(p, 'utf8'), write: (p, t) => fs.writeFileSync(p, t, 'utf8'), out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') }) {
  const val = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
  if (argv.includes('--help')) { io.out(HELP); return 0; }
  const date = val('--date');
  if (date === undefined) { io.err('Не задана дата замера: --date ГГГГ-ММ-ДД\n' + HELP); return 2; }
  const corpus = val('--corpus') ?? 'all';
  if (!['regular', 'stress', 'all'].includes(corpus)) { io.err(HELP); return 2; }
  // Канонический файл и зеркало для демо описывают ОБА корпуса. Неполный прогон (--corpus regular|stress) затёр бы файл, оставив зеркало от полного отчёта и расхождение
  // между файлом и экраном: поэтому для него путь записи задаётся явно, а канонический файл отказывается принимать неполный отчёт даже по явному пути.
  const canonical = path.join(PROTO, 'data', 'backtest-report.json');
  const out_arg = val('--out');
  if (corpus !== 'all' && out_arg === undefined) { io.err('Неполный прогон (--corpus ' + corpus + ') не пишет в канонический data/backtest-report.json: задайте другой файл через --out.\n' + HELP); return 2; }
  const out = out_arg ?? canonical;
  const same_path = (a, b) => (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
  if (corpus !== 'all' && same_path(out, canonical)) { io.err('Неполный отчёт (--corpus ' + corpus + ') нельзя записать в канонический data/backtest-report.json: задайте другой файл через --out.'); return 2; }
  const mirror = argv.includes('--no-mirror') || corpus !== 'all' ? null : (val('--mirror') ?? MIRROR_FILE);
  try {
    const report = build_report({ date, corpora: corpus === 'all' ? ['regular', 'stress'] : [corpus] });
    const problems = validate_report(report);
    if (problems.length > 0) { io.err('Отчёт не прошёл проверку: ' + problems.slice(0, 5).join('; ')); return 1; }
    for (const line of summary_lines(report)) io.out(line);
    const text = JSON.stringify(report, null, 2) + '\n';
    const mirror_text = mirror === null ? null : mirror_source(report);
    if (argv.includes('--check')) {
      const same = io.read(out) === text && (mirror === null || io.read(mirror) === mirror_text);
      io.out(same ? 'Файл и зеркало совпадают с пересчётом.' : 'Файл или зеркало НЕ совпадают с пересчётом: ' + out);
      return same ? 0 : 1;
    }
    io.write(out, text);
    io.out('Отчёт записан: ' + out);
    if (mirror !== null) { io.write(mirror, mirror_text); io.out('Зеркало для демо записано: ' + mirror); }
    return 0;
  } catch (e) {
    io.err('Ошибка: ' + (e?.code ?? 'E_UNKNOWN') + (e?.ctx?.reason === undefined ? '' : ' (' + e.ctx.reason + ')'));
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
