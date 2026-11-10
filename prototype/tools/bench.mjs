#!/usr/bin/env node
// bench.mjs — замеры производительности (FP-12, REQ-150, REQ-151, REQ-153, TST-54): p50/p95 полного пересчёта, блокировка главного потока при расчёте в воркере,
// холодное открытие журнала на 36 500 записей. Результат печатается и записывается в _ops/bench.json (на ЭТОЙ машине: версия Node, система, n и дата замера).
// Дата — обязательный аргумент (`--date ГГГГ-ММ-ДД`): инструмент часов не читает. Бюджеты — гипотезы ADR-014 (p95 ≤ 100 мс, блокировка ≤ 50 мс), а не обещания продукту.
//   node tools/bench.mjs --date 2026-10-09 [--out ../_ops/bench.json] [--samples 30] [--rounds 3] [--blocking-runs 20] [--no-journal] [--no-write]
//   node tools/bench.mjs --compare [--baseline ../_ops/bench.json] [--factor 2] [--attempts 3] [--samples 30] [--rounds 3]   (FP-23, REQ-150)
// Флаг --compare ничего не пишет и часов не читает: он заново замеряет p95 полного пересчёта на том же наборе (≈ 10³ событий, H = 180) и сравнивает с ЗАПИСАННЫМ замером из --baseline
// (по умолчанию _ops/bench.json — «зафиксированный бюджет» REQ-150 до замеров на устройствах). Код выхода 1, если p95 вырос БОЛЕЕ чем вдвое (ровно вдвое ещё допустимо) относительно записанного
// или превысил жёсткий бюджет-гипотезу (100 мс); 2 — нет читаемого базового замера или неверные ключи. На загруженной машине рост бывает шумом, поэтому замер повторяется до --attempts раз
// (по умолчанию 3) и берётся наименьший p95 по каждой метрике — как «лучший из раундов» в TST-54: разовая нагрузка не даёт ложного срабатывания, а настоящий регресс держится во всех попытках.
// Страницы замеров в браузере (demo/bench.html, demo/coldstart.html, demo/compat.html) дают записи для массива `devices` того же файла: этот инструмент при записи их сохраняет.
// Тяжёлая часть — журнал на 36 500 записей (файл ≈ 13 МБ, в памяти в несколько раз больше; расход памяти не измерялся). Запускать, когда машина свободна. Инструмент вне engine/: node:* и process допустимы.
// Расчёт по введённым данным и правилам, не консультация.

import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.resolve(HERE, '..');
const eng = (name) => pathToFileURL(path.join(PROTO, 'engine', name)).href;
const { analyze, ENGINE_VERSION, make_event } = await import(eng('index.mjs'));
const MODEL = await import(pathToFileURL(path.join(PROTO, 'demo', 'bench_model.mjs')).href); // общая часть с demo/bench.html (FP-23): набор, процентили, замер

/** Бюджеты и пороги (гипотезы до первого замера на устройствах; REQ-150, ADR-014). Определены в demo/bench_model.mjs — их читает и страница bench.html. */
export const BUDGET = MODEL.BUDGET;

/** Процентиль «ближайший ранг» (то же определение, что в TST-54). */
export const percentile = MODEL.percentile;

/**
 * Рабочая область из `copies` одинаковых наборов правил (1 ежедневное + 3 еженедельных + 2 ежемесячных ≈ 270 вхождений за 180 дней): при `copies = 4`
 * около 10³ событий на горизонте 180 дней (REQ-150). Тот же состав, что в TST-54 (`tests/timeline.test.mjs`), плюс остаток, буфер и налоговый резерв.
 * Генератор живёт в demo/bench_model.mjs (без часов и случайности), чтобы страница замера в браузере считала ровно тот же набор.
 */
export const make_bench_ws = MODEL.make_bench_ws;

const ms_of = (fn) => { const t0 = performance.now(); fn(); return performance.now() - t0; };
const round2 = (x) => Math.round(x * 100) / 100;

/**
 * Полный пересчёт: `analyze` (развёртка правил, проекция, резервы, Q1, готовность) и «пересчёт страницы + ответ Q3» (контекст инструментов и `check-purchase`).
 * Замер — в demo/bench_model.mjs (общий с bench.html); здесь только часы Node.
 * @param {{ws: object, samples?: number, rounds?: number, warmup?: number}} o
 * @returns {{n: number, analyze: object, recompute_q3: object, events: number}}
 */
export function measure_recompute({ ws, samples = 30, rounds = 3, warmup = 5 }) {
  return MODEL.measure_recompute({ ws, samples, rounds, warmup, now: () => performance.now() });
}

/** Код воркера потока Node: тот же `handle_message`, что в demo/calc_worker.mjs (в браузере — Web Worker, здесь поток Node: у обоих отдельный поток и копирование сообщений). */
function worker_source() {
  const url = pathToFileURL(path.join(PROTO, 'demo', 'calc_worker.mjs')).href;
  return `const { parentPort } = require('node:worker_threads');
import(${JSON.stringify(url)}).then(({ handle_message }) => {
  parentPort.on('message', (m) => parentPort.postMessage(handle_message(m)));
  parentPort.postMessage({ ready: true });
});`;
}

/**
 * Блокировка «главного потока»: максимальная задержка цикла событий (`monitorEventLoopDelay`, разрешение 1 мс), пока `runs` раз считается `analyze`
 * (а) прямо в этом потоке и (б) в воркере. В (б) главный поток платит только копирование запроса и ответа. Это модель браузера, не замер браузера.
 * @param {{ws: object, runs?: number}} o
 */
export async function measure_blocking({ ws, runs = 20 }) {
  const query = { as_of: ws.as_of };
  const lag = (h) => ({ max_ms: round2(h.max / 1e6), p99_ms: round2(h.percentile(99) / 1e6), mean_ms: round2(h.mean / 1e6) });
  // (а) в этом потоке: каждый расчёт держит поток целиком
  for (let i = 0; i < 3; i++) analyze(ws, query);
  const h1 = monitorEventLoopDelay({ resolution: 1 });
  h1.enable();
  const t1 = [];
  for (let i = 0; i < runs; i++) {
    await new Promise((r) => setTimeout(r, 2)); // дать таймеру сработать между расчётами
    t1.push(ms_of(() => analyze(ws, query)));
  }
  await new Promise((r) => setTimeout(r, 5));
  h1.disable();
  // (б) в воркере
  const w = new Worker(worker_source(), { eval: true });
  await new Promise((res, rej) => { w.once('message', res); w.once('error', rej); });
  let next_id = 1;
  const ask = () => new Promise((res, rej) => { const id = next_id++; const on = (m) => { if (m.id === id) { w.off('message', on); m.ok ? res(m) : rej(new Error('воркер: ' + JSON.stringify(m.error))); } }; w.on('message', on); w.postMessage({ v: 1, id, op: 'analyze', ws, query }); });
  for (let i = 0; i < 3; i++) await ask();
  const h2 = monitorEventLoopDelay({ resolution: 1 });
  h2.enable();
  const t2 = [];
  for (let i = 0; i < runs; i++) {
    await new Promise((r) => setTimeout(r, 2));
    const t0 = performance.now();
    await ask();
    t2.push(performance.now() - t0);
  }
  await new Promise((r) => setTimeout(r, 5));
  h2.disable();
  await w.terminate();
  return {
    runs,
    in_thread: { ...lag(h1), compute_p50_ms: round2(percentile(t1, 50)) },
    worker: { ...lag(h2), round_trip_p50_ms: round2(percentile(t2, 50)), round_trip_p95_ms: round2(percentile(t2, 95)) },
    note: 'задержка цикла событий (monitorEventLoopDelay, разрешение 1 мс) — модель блокировки интерфейса; в браузере интерфейс блокируют ещё копирование сообщений и отрисовка',
  };
}

/** Журнал из `n` записей (10 в день, 10 лет), собранный так же, как в REQ-153 (`tests/journal_log.test.mjs`), и холодное открытие: JSON.parse, открытие, свёртка. */
export async function measure_journal_open({ n = 36_500, reps = 3 } = {}) {
  const { create_journal, open_journal } = await import(pathToFileURL(path.join(PROTO, 'demo', 'journal_log.mjs')).href);
  const kinds = ['tx.posted', 'tx.posted', 'tx.posted', 'tx.posted', 'tx.posted', 'tx.posted', 'tx.posted', 'anchor.set', 'rule.set', 'plan.set'];
  let s = 153; // детерминированный ГПСЧ (LCG), чтобы замер не зависел от случайности
  const rnd = (lo, hi) => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return lo + (s % (hi - lo + 1)); };
  const events = [];
  const add = (type, payload, entity_id) => events.push(make_event(type, payload, { event_id: 'e' + (events.length + 1), seq: events.length + 1, recorded_at: '2026-10-01T09:00:00Z', ...(entity_id === undefined ? {} : { entity_id }) }));
  let tx = 0;
  add('account.opened', { account_id: 'acc_main', name: 'A', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 });
  for (let i = 0; events.length < n; i++) {
    const k = kinds[i % kinds.length];
    const day = '2026-' + String(1 + (i % 12)).padStart(2, '0') + '-' + String(1 + (i % 28)).padStart(2, '0');
    if (k === 'tx.posted') { tx += 1; add(k, { account_id: 'acc_main', date: day, amount_minor: rnd(-9000, 9000), currency: 'EUR', kind: 'expense', tag: 'tag' + (i % 40) }, 'tx' + tx); }
    else if (k === 'anchor.set') add(k, { anchor_id: 'anc' + i, account_id: 'acc_main', date: day, amount_minor: rnd(0, 900000) });
    else if (k === 'rule.set') add(k, { rule_id: 'R' + (i % 30), version: 1 + (i % 5), amount: { exp_minor: -rnd(100, 9000) }, tag: 'rule' });
    else add(k, { plan_id: 'P' + (i % 200), date: day, amount_minor: -rnd(100, 9000) });
  }
  const j = create_journal({ events: events.slice(0, events.length - 300), snapshot_every: 500, keep_snapshots: 1 });
  j.take_snapshot();
  for (const e of events.slice(events.length - 300)) j.append_event(e);
  const text = JSON.stringify({ events: j.events(), snapshots: j.snapshots() });
  const plain = JSON.stringify({ events: j.events() });
  const open = (t) => { const t0 = performance.now(); const o = open_journal(JSON.parse(t)); const st = o.state(); return { ms: performance.now() - t0, used_snapshot: st.used_snapshot }; };
  const a = Array.from({ length: reps }, () => open(text));
  const b = Array.from({ length: reps }, () => open(plain));
  return {
    n: events.length, reps, bytes_with_snapshot: Buffer.byteLength(text), bytes_per_event: round2(Buffer.byteLength(plain) / events.length),
    with_snapshot_ms: { best: round2(Math.min(...a.map((x) => x.ms))), worst: round2(Math.max(...a.map((x) => x.ms))), used_snapshot: a.every((x) => x.used_snapshot) },
    without_snapshot_ms: { best: round2(Math.min(...b.map((x) => x.ms))), worst: round2(Math.max(...b.map((x) => x.ms))), used_snapshot: b.some((x) => x.used_snapshot) },
  };
}

/** Проверка формата даты из аргумента. */
export const is_iso_date = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

function arg_of(argv, name, def) { const i = argv.indexOf(name); return i < 0 ? def : argv[i + 1]; }

/** Файл записанного замера по умолчанию: _ops/bench.json рядом с prototype/. */
export const DEFAULT_BASELINE = path.join(PROTO, '..', '_ops', 'bench.json');

/** Сравнение p95 со записанным (чистая функция из demo/bench_model.mjs): рост более чем вдвое или выход за бюджет-гипотезу — не в порядке. */
export const compare_p95 = MODEL.compare_p95;

/**
 * Записанный замер: p95 полного пересчёта (`analyze` и «страница + Q3») и бюджет-гипотеза из файла замера.
 * @param {string} file
 * @returns {{ok: true, date: string|null, budget_ms: number, baseline: {analyze: number, recompute_q3: number}} | {ok: false, reason: 'unreadable'|'no_p95'}}
 */
export function read_baseline(file) {
  let b;
  try { b = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { ok: false, reason: 'unreadable' }; }
  const a = b?.recompute?.analyze?.p95_ms;
  const q = b?.recompute?.recompute_q3?.p95_ms;
  if (!Number.isFinite(a) || !(a > 0) || !Number.isFinite(q) || !(q > 0)) return { ok: false, reason: 'no_p95' };
  const budget = b?.budget?.recompute_p95_ms;
  return { ok: true, date: typeof b.date === 'string' ? b.date : null, budget_ms: Number.isFinite(budget) && budget > 0 ? budget : BUDGET.recompute_p95_ms, baseline: { analyze: a, recompute_q3: q } };
}

/**
 * Режим --compare (FP-23, REQ-150): свежий замер p95 против записанного. Ничего не пишет. Код выхода: 0 — в пределах, 1 — рост более чем вдвое или выход за бюджет, 2 — неверный запуск или нет базового замера.
 * @param {string[]} argv
 * @param {{log?: Function, error?: Function, measure?: Function}} [io] порты (в тестах подменяются)
 */
export async function run_compare(argv, io = {}) {
  const log = io.log ?? console.log;
  const error = io.error ?? console.error;
  const measure = io.measure ?? measure_recompute;
  const file = path.resolve(arg_of(argv, '--baseline', DEFAULT_BASELINE));
  const factor = Number(arg_of(argv, '--factor', MODEL.GROWTH_LIMIT));
  const samples = Number(arg_of(argv, '--samples', 30));
  const rounds = Number(arg_of(argv, '--rounds', 3));
  const attempts = Number(arg_of(argv, '--attempts', 3));
  if (!(factor > 1) || !Number.isInteger(samples) || samples < 1 || !Number.isInteger(rounds) || rounds < 1 || !Number.isInteger(attempts) || attempts < 1) { error('неверные ключи: --factor > 1, --samples, --rounds и --attempts — целые от 1'); return 2; }
  const base = read_baseline(file);
  if (!base.ok) {
    error(base.reason === 'unreadable' ? 'нет читаемого базового замера: ' + file + ' (сначала node tools/bench.mjs --date ГГГГ-ММ-ДД)' : 'в базовом замере нет p95 пересчёта (recompute.analyze.p95_ms и recompute.recompute_q3.p95_ms): ' + file);
    return 2;
  }
  // Попытки: пока не уложились, замеряем снова; в сравнение идёт наименьший p95 по каждой метрике. Настоящий регресс держится во всех попытках.
  let rec = null;
  let best = null;
  let cmp = null;
  const tries = [];
  for (let i = 0; i < attempts; i++) {
    rec = await measure({ ws: make_bench_ws(4), samples, rounds });
    const now_p95 = { analyze: rec.analyze.p95_ms, recompute_q3: rec.recompute_q3.p95_ms };
    tries.push(now_p95);
    best = best === null ? { ...now_p95 } : { analyze: Math.min(best.analyze, now_p95.analyze), recompute_q3: Math.min(best.recompute_q3, now_p95.recompute_q3) };
    cmp = compare_p95({ baseline: base.baseline, current: best, factor, budget_ms: base.budget_ms });
    if (cmp.ok) break;
  }
  log(`сравнение с записанным замером${base.date === null ? '' : ' от ' + base.date} (n = ${rec.n}, событий ≈ ${rec.events}, H = 180; попыток ${tries.length} из ${attempts}, берётся наименьший p95): допустимый рост — не более чем в ${factor} раза, бюджет-гипотеза ${base.budget_ms} мс`);
  if (tries.length > 1) log('  p95 по попыткам: ' + tries.map((t, i) => `${i + 1}) analyze ${t.analyze}, страница + Q3 ${t.recompute_q3}`).join('; '));
  for (const r of cmp.rows) {
    const verdict = r.ok ? 'в пределах' : (r.over_growth ? 'РОСТ БОЛЕЕ ЧЕМ В ' + factor + ' РАЗА' : 'ВЫШЕ БЮДЖЕТА');
    log(`  ${r.metric}: p95 сейчас ${r.current_ms} мс, записано ${r.baseline_ms} мс, рост ×${r.ratio}, предел роста ${r.limit_ms} мс — ${verdict}`);
  }
  if (!cmp.ok) error('ОШИБКА p95 пересчёта вырос более чем вдвое относительно записанного замера или вышел за бюджет; на загруженной машине повторите замер, когда она свободна');
  return cmp.ok ? 0 : 1;
}

export async function main(argv, io = {}) {
  if (argv.includes('--compare')) return run_compare(argv, io);
  const date = arg_of(argv, '--date', null);
  if (!is_iso_date(date)) { console.error('нужен аргумент --date ГГГГ-ММ-ДД (инструмент часов не читает)'); return 2; }
  const out = path.resolve(arg_of(argv, '--out', path.join(PROTO, '..', '_ops', 'bench.json')));
  const samples = Number(arg_of(argv, '--samples', 30));
  const rounds = Number(arg_of(argv, '--rounds', 3));
  const runs = Number(arg_of(argv, '--blocking-runs', 20));
  const ws = make_bench_ws(4);
  console.log(`замер на ${date}: Node ${process.version}, ${os.platform()} ${os.arch()}, процессоров ${os.cpus().length}, свободно ОЗУ ${Math.round(os.freemem() / 2 ** 20)} МБ`);
  const rec = measure_recompute({ ws, samples, rounds });
  console.log(`пересчёт (n = ${rec.n}, событий ≈ ${rec.events}, H = 180): analyze p50 ${rec.analyze.p50_ms} мс, p95 ${rec.analyze.p95_ms} мс; пересчёт страницы + Q3 p50 ${rec.recompute_q3.p50_ms} мс, p95 ${rec.recompute_q3.p95_ms} мс`);
  const blocking = await measure_blocking({ ws, runs });
  console.log(`блокировка потока (макс. задержка цикла событий): в потоке ${blocking.in_thread.max_ms} мс, при расчёте в воркере ${blocking.worker.max_ms} мс (бюджет ≤ ${BUDGET.blocking_ms} мс)`);
  let journal = null;
  if (!argv.includes('--no-journal')) {
    journal = await measure_journal_open({});
    console.log(`журнал ${journal.n} записей: открытие со снимком ${journal.with_snapshot_ms.best} мс, без снимка ${journal.without_snapshot_ms.best} мс (цель ≤ ${BUDGET.journal_open_ms} мс), ${journal.bytes_per_event} байт на запись`);
  }
  const result = {
    format: 'runway-bench/1',
    note: 'Замер на ЭТОЙ машине (не на эталонном телефоне): цифры — гипотезы-бюджеты ADR-014, а не обещания продукту. Дата — аргумент запуска.',
    date, node: process.version, platform: os.platform() + ' ' + os.arch(), cpus: os.cpus().length, cpu_model: os.cpus()[0]?.model ?? null, free_mem_mb: Math.round(os.freemem() / 2 ** 20), total_mem_mb: Math.round(os.totalmem() / 2 ** 20),
    engine_version: ENGINE_VERSION, budget: BUDGET,
    recompute: { workspace: 'make_bench_ws(4): 20 правил, горизонт 180 дней, ≈ 10³ событий', ...rec },
    blocking, journal,
    within_budget: {
      recompute_p95: rec.recompute_q3.p95_ms <= BUDGET.recompute_p95_ms && rec.analyze.p95_ms <= BUDGET.recompute_p95_ms,
      blocking_worker: blocking.worker.max_ms <= BUDGET.blocking_ms,
      journal_open: journal === null ? null : journal.with_snapshot_ms.best <= BUDGET.journal_open_ms,
    },
  };
  // Записи устройств, вставленные людьми со страницы demo/bench.html (массив devices), при перезаписи файла сохраняются.
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { previous = null; }
  if (Array.isArray(previous?.devices)) result.devices = previous.devices;
  if (!argv.includes('--no-write')) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n', 'utf8'); console.log('записано: ' + out); }
  return 0;
}

const is_main = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (is_main) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
