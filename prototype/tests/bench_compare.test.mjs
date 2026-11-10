// bench_compare.test.mjs — FP-23 (REQ-150, REQ-151): общая модель замеров (demo/bench_model.mjs), строгая проверка роста времени при удвоении N
// и режим `tools/bench.mjs --compare` (рост p95 более чем вдвое относительно записанного замера = код выхода 1).
// Браузера и процессов нет: инструмент вызывается в этом же процессе с подменой замера (`io.measure`) или с настоящим коротким замером. Файлы пишутся только во временный
// каталог внутри tests/, который удаляется в конце. Расчёт по введённым данным и правилам, не консультация.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROTO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);
const MODEL = await imp('demo', 'bench_model.mjs');
const BENCH = await imp('tools', 'bench.mjs');
const { analyze } = await imp('engine', 'index.mjs');
const BENCH_JSON = path.join(PROTO, '..', '_ops', 'bench.json');
const sha = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const TMP = fs.mkdtempSync(path.join(PROTO, 'tests', '.tmp_bench_compare_'));
after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });
const write_json = (name, obj) => { const f = path.join(TMP, name); fs.writeFileSync(f, JSON.stringify(obj), 'utf8'); return f; };
const baseline_file = (name, a, q, budget = 1e9) => write_json(name, { date: '2026-01-01', budget: { recompute_p95_ms: budget }, recompute: { analyze: { p95_ms: a }, recompute_q3: { p95_ms: q } } });
const quiet = () => { const out = []; return { out, io: { log: (m) => out.push(['log', m]), error: (m) => out.push(['error', m]) } }; };

// ── модель: один и тот же набор в странице и в инструменте ──────────────────────────────────────────────────────────────

test('REQ-150 bench_model: набор синтетических данных детерминирован (без часов и случайности) и общий с tools/bench.mjs; точки 10³, 2·10³, 4·10³ удваивают число событий', () => {
  assert.deepEqual(JSON.stringify(MODEL.make_bench_ws(4)), JSON.stringify(MODEL.make_bench_ws(4)));
  assert.equal(BENCH.make_bench_ws, MODEL.make_bench_ws, 'инструмент использует тот же генератор');
  assert.equal(BENCH.percentile, MODEL.percentile);
  assert.deepEqual(BENCH.BUDGET, { recompute_p95_ms: 100, blocking_ms: 50, journal_open_ms: 2000 });
  assert.deepEqual(MODEL.SYNTH_POINTS.map((p) => [p.id, p.copies, p.nominal_events]), [['n1k', 4, 1000], ['n2k', 8, 2000], ['n4k', 16, 4000]]);
  const counts = MODEL.SYNTH_POINTS.map((p) => { const ws = MODEL.make_bench_ws(p.copies); return analyze(ws, { as_of: ws.as_of }).events.plan.length; });
  assert.ok(counts[0] >= 900 && counts[0] <= 1250, 'около 10³: ' + counts[0]);
  for (let i = 1; i < counts.length; i++) assert.ok(counts[i] / counts[i - 1] >= 1.9 && counts[i] / counts[i - 1] <= 2.1, `удвоение N: ${counts[i - 1]} → ${counts[i]}`);
  for (const [i, p] of MODEL.SYNTH_POINTS.entries()) assert.ok(Math.abs(counts[i] - p.nominal_events) / p.nominal_events <= 0.25, `${p.id}: ${counts[i]} событий против номинала ${p.nominal_events}`);
});

test('REQ-150 bench_model: percentile (ближайший ранг), stat_of, замер с подменёнными часами и разрешение таймера', () => {
  assert.equal(MODEL.percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(MODEL.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.deepEqual(MODEL.stat_of([4, 1, 3, 2]), { n: 4, p50_ms: 2, p95_ms: 4, min_ms: 1, max_ms: 4 });
  // часы-счётчик: каждый вызов now() сдвигает время на 1, поэтому каждый замер ровно 1 мс
  let c = 0;
  const now = () => c++;
  const ws = MODEL.make_bench_ws(1);
  const r = MODEL.measure_recompute({ ws, now, samples: 3, rounds: 2, warmup: 1 });
  assert.equal(r.n, 6);
  assert.ok(r.events > 200 && r.events < 400, 'событий на копию: ' + r.events);
  assert.deepEqual([r.analyze.p50_ms, r.analyze.p95_ms, r.recompute_q3.p50_ms, r.recompute_q3.p95_ms], [1, 1, 1, 1]);
  let k = 0;
  assert.equal(MODEL.timer_resolution_ms(() => Math.floor(k++ / 3) * 0.5), 0.5, 'шаг часов 0,5 мс');
  assert.equal(MODEL.timer_resolution_ms(() => 7, 2), null, 'часы стоят — шаг не виден');
});

test('REQ-150 bench_model: замерщик считает набор G-001 (analyze и ответ Q3) без исключений; событий по плану столько же, сколько в analyze', () => {
  const g = JSON.parse(fs.readFileSync(path.join(PROTO, 'data', 'g001.json'), 'utf8'));
  let c = 0;
  const s = MODEL.make_sampler(g, () => c++);
  assert.equal(s.events, analyze(g, { as_of: g.as_of }).events.plan.length);
  assert.ok(s.events > 10, 'событий по плану в G-001: ' + s.events);
  s.warm(1);
  const x = s.sample();
  assert.deepEqual([x.analyze_ms, x.q3_ms], [1, 1]);
});

// ── REQ-151: строго ≤ 2,5 на каждое удвоение ─────────────────────────────────────────────────────────────────────────────

test('REQ-151 doubling_check: предел 2,5 на КАЖДОЕ удвоение — 2,5 ещё в пределах, 2,51 уже нет; квадратичный рост и одиночная точка не проходят', () => {
  const pts = (ms) => ms.map((m, i) => ({ id: 'p' + i, events: 1000 * 2 ** i, ms: m }));
  assert.equal(MODEL.DOUBLING_LIMIT, 2.5);
  assert.deepEqual(MODEL.doubling_check(pts([10, 20, 40])).steps.map((s) => s.t_ratio), [2, 2]);
  assert.equal(MODEL.doubling_check(pts([10, 20, 40])).ok, true);
  assert.equal(MODEL.doubling_check(pts([10, 25, 62.5])).ok, true, 'ровно 2,5 на каждом шаге');
  assert.equal(MODEL.doubling_check(pts([10, 25.1, 50])).ok, false, 'первое удвоение 2,51');
  assert.equal(MODEL.doubling_check(pts([10, 20, 51])).ok, false, 'второе удвоение 2,55: мягкая проверка «≤ 6,25 на два шага» его пропустила бы');
  assert.equal(MODEL.doubling_check(pts([10, 24, 60.5])).ok, false, 'два шага по 2,4 и 2,52');
  assert.equal(MODEL.doubling_check(pts([1, 4, 16])).ok, false, 'квадратичный рост: ×4 на шаг');
  assert.equal(MODEL.doubling_check(pts([10])).ok, false, 'одной точки мало');
  assert.equal(MODEL.doubling_check(pts([0, 5, 10])).ok, false, 'нулевое время — не измерено');
  assert.equal(MODEL.doubling_check(pts([10, NaN, 10])).ok, false);
  assert.equal(MODEL.doubling_check(pts([10, 20, 40]), 1.9).ok, false, 'предел можно ужесточить');
});

test('REQ-151 TST-54 строго: полный пересчёт (analyze) на 10³, 2·10³ и 4·10³ событий растёт не более чем в 2,5 раза на каждое удвоение (минимум по повторам, до пяти попыток; сверхлинейный алгоритм не пройдёт ни одну)', () => {
  const sets = MODEL.SYNTH_POINTS.map((p) => {
    const ws = MODEL.make_bench_ws(p.copies);
    return { id: p.id, ws, events: analyze(ws, { as_of: ws.as_of }).events.plan.length };
  });
  const ms = (f) => { const t0 = performance.now(); f(); return performance.now() - t0; };
  const min_of = (s) => Math.min(...Array.from({ length: 9 }, () => ms(() => analyze(s.ws, { as_of: s.ws.as_of }))));
  for (const s of sets) min_of(s); // прогрев
  let last = '';
  let ok = false;
  for (let attempt = 0; attempt < 5 && !ok; attempt++) {
    const r = MODEL.doubling_check(sets.map((s) => ({ id: s.id, events: s.events, ms: min_of(s) })));
    last = r.steps.map((s) => `${s.from}→${s.to}: ×${s.t_ratio}`).join('; ');
    ok = r.ok;
  }
  assert.ok(ok, 'рост времени при удвоении N выше ×2,5 (последняя попытка: ' + last + ')');
});

// ── сравнение с записанным замером ───────────────────────────────────────────────────────────────────────────────────────

test('REQ-150 compare_p95: рост более чем вдвое — не в порядке, ровно вдвое — допустимо; выход за бюджет-гипотезу тоже; нет числа — не в порядке', () => {
  const base = { analyze: 17.34, recompute_q3: 16.37 };
  const ok = MODEL.compare_p95({ baseline: base, current: { analyze: 34.68, recompute_q3: 32.74 } });
  assert.equal(ok.ok, true, 'ровно вдвое');
  assert.deepEqual(ok.rows.map((r) => r.ratio), [2, 2]);
  const grown = MODEL.compare_p95({ baseline: base, current: { analyze: 34.69, recompute_q3: 16 } });
  assert.equal(grown.ok, false);
  assert.deepEqual(grown.rows.map((r) => [r.metric, r.over_growth, r.over_budget, r.ok]), [['analyze', true, false, false], ['recompute_q3', false, false, true]]);
  const budget = MODEL.compare_p95({ baseline: { analyze: 80, recompute_q3: 80 }, current: { analyze: 120, recompute_q3: 90 } });
  assert.deepEqual(budget.rows.map((r) => [r.over_growth, r.over_budget]), [[false, true], [false, false]], 'рост ×1,5, но выше 100 мс');
  assert.equal(MODEL.compare_p95({ baseline: base, current: { analyze: 10 } }).ok, false, 'нет числа по второй метрике');
  assert.equal(MODEL.compare_p95({ baseline: base, current: { analyze: NaN, recompute_q3: 10 } }).ok, false);
  assert.equal(MODEL.compare_p95({ baseline: {}, current: {} }).ok, false, 'нечего сравнивать');
  assert.equal(MODEL.compare_p95({ baseline: base, current: { analyze: 30, recompute_q3: 30 }, factor: 1.5 }).ok, false, 'допустимый рост можно ужесточить');
  assert.equal(BENCH.compare_p95, MODEL.compare_p95);
});

test('REQ-150 read_baseline: записанный замер _ops/bench.json читается (p95 и бюджет); нет файла, не JSON, нет p95 — отказ с причиной', () => {
  const b = BENCH.read_baseline(BENCH_JSON);
  assert.equal(b.ok, true);
  assert.ok(b.baseline.analyze > 0 && b.baseline.recompute_q3 > 0 && b.budget_ms === 100, JSON.stringify(b));
  assert.match(b.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(BENCH.read_baseline(path.join(TMP, 'нет-такого.json')), { ok: false, reason: 'unreadable' });
  assert.deepEqual(BENCH.read_baseline(path.join(PROTO, 'demo', 'sw.js')), { ok: false, reason: 'unreadable' }, 'не JSON');
  assert.deepEqual(BENCH.read_baseline(path.join(PROTO, 'engine', 'vocab.json')), { ok: false, reason: 'no_p95' });
  assert.equal(BENCH.read_baseline(write_json('zero.json', { recompute: { analyze: { p95_ms: 0 }, recompute_q3: { p95_ms: 5 } } })).reason, 'no_p95', 'нулевой p95 — не база');
});

test('REQ-150 bench.mjs --compare: подменённый замер — 1,99 раза от записанного даёт код 0, 2,01 раза — код 1 (и сообщение об ошибке); числа печатаются', async () => {
  const f = baseline_file('base.json', 10, 20, 1000);
  const fake = (a, q) => async () => ({ n: 90, events: 1084, analyze: { p95_ms: a }, recompute_q3: { p95_ms: q } });
  {
    const { out, io } = quiet();
    assert.equal(await BENCH.main(['--compare', '--baseline', f], { ...io, measure: fake(19.9, 39.8) }), 0);
    assert.ok(out.some(([k, m]) => k === 'log' && /analyze: p95 сейчас 19\.9 мс, записано 10 мс, рост ×1\.99/.test(m)), JSON.stringify(out));
    assert.ok(!out.some(([k]) => k === 'error'));
  }
  {
    const { out, io } = quiet();
    assert.equal(await BENCH.main(['--compare', '--baseline', f], { ...io, measure: fake(20.1, 20) }), 1);
    assert.ok(out.some(([k, m]) => k === 'log' && /РОСТ БОЛЕЕ ЧЕМ В 2 РАЗА/.test(m)));
    assert.ok(out.some(([k, m]) => k === 'error' && /вырос более чем вдвое/.test(m)));
  }
  {
    const { io } = quiet();
    assert.equal(await BENCH.main(['--compare', '--baseline', f], { ...io, measure: fake(10, 41) }), 1, 'вторая метрика выросла в 2,05 раза');
    assert.equal(await BENCH.main(['--compare', '--baseline', f, '--factor', '1.5'], { ...io, measure: fake(15.1, 20) }), 1, '--factor ужесточает предел');
    assert.equal(await BENCH.main(['--compare', '--baseline', f, '--factor', '3'], { ...io, measure: fake(29, 59) }), 0, '--factor ослабляет предел');
  }
  {
    const f2 = baseline_file('base-budget.json', 80, 80, 100);
    const { io } = quiet();
    assert.equal(await BENCH.main(['--compare', '--baseline', f2], { ...io, measure: fake(101, 80) }), 1, 'рост ×1,26, но выше бюджета 100 мс');
    assert.equal(await BENCH.main(['--compare', '--baseline', f2], { ...io, measure: fake(99, 80) }), 0);
  }
});

test('REQ-150 bench.mjs --compare: неверный запуск и нет базового замера — код 2, замер не запускается', async () => {
  let measured = 0;
  const { out, io } = quiet();
  const measure = async () => { measured += 1; return { n: 1, events: 1, analyze: { p95_ms: 1 }, recompute_q3: { p95_ms: 1 } }; };
  assert.equal(await BENCH.main(['--compare', '--baseline', path.join(TMP, 'нет.json')], { ...io, measure }), 2);
  assert.equal(await BENCH.main(['--compare', '--baseline', path.join(PROTO, 'engine', 'vocab.json')], { ...io, measure }), 2);
  assert.equal(await BENCH.main(['--compare', '--baseline', BENCH_JSON, '--factor', '1'], { ...io, measure }), 2);
  assert.equal(await BENCH.main(['--compare', '--baseline', BENCH_JSON, '--samples', '0'], { ...io, measure }), 2);
  assert.equal(await BENCH.main(['--compare', '--baseline', BENCH_JSON, '--rounds', 'x'], { ...io, measure }), 2);
  assert.equal(await BENCH.main(['--compare', '--baseline', BENCH_JSON, '--attempts', '0'], { ...io, measure }), 2);
  assert.equal(measured, 0, 'до проверки базы и ключей замер не идёт');
  assert.ok(out.filter(([k]) => k === 'error').length === 6);
});

test('REQ-150 bench.mjs --compare: попытки — разовая нагрузка не даёт ложного срабатывания (берётся наименьший p95 по каждой метрике), настоящий регресс держится во всех попытках', async () => {
  const f = baseline_file('base-attempts.json', 10, 20, 1000);
  const seq = (list) => { let calls = 0; return { get calls() { return calls; }, measure: async () => { const [a, q] = list[Math.min(calls, list.length - 1)]; calls += 1; return { n: 90, events: 1084, analyze: { p95_ms: a }, recompute_q3: { p95_ms: q } }; } }; };
  {
    const s = seq([[40, 40], [12, 25]]); // первая попытка под нагрузкой, вторая спокойная
    const { out, io } = quiet();
    assert.equal(await BENCH.main(['--compare', '--baseline', f], { ...io, measure: s.measure }), 0);
    assert.equal(s.calls, 2, 'остановились сразу, как уложились');
    assert.ok(out.some(([k, m]) => k === 'log' && /попыток 2 из 3/.test(m)));
    assert.ok(out.some(([k, m]) => k === 'log' && /p95 по попыткам: 1\) analyze 40, страница \+ Q3 40; 2\) analyze 12, страница \+ Q3 25/.test(m)));
  }
  {
    const s = seq([[11, 60], [60, 21]]); // наименьший p95 берётся по каждой метрике отдельно
    assert.equal(await BENCH.main(['--compare', '--baseline', f], { ...quiet().io, measure: s.measure }), 0);
    assert.equal(s.calls, 2);
  }
  {
    const s = seq([[40, 40]]); // регресс во всех попытках
    assert.equal(await BENCH.main(['--compare', '--baseline', f], { ...quiet().io, measure: s.measure }), 1);
    assert.equal(s.calls, 3, 'по умолчанию три попытки');
  }
  {
    const s = seq([[40, 40], [12, 25]]);
    assert.equal(await BENCH.main(['--compare', '--baseline', f, '--attempts', '1'], { ...quiet().io, measure: s.measure }), 1);
    assert.equal(s.calls, 1, '--attempts 1 — одна попытка');
  }
  {
    const s = seq([[10, 20]]);
    assert.equal(await BENCH.main(['--compare', '--baseline', f], { ...quiet().io, measure: s.measure }), 0);
    assert.equal(s.calls, 1, 'уложились с первого раза — повторов нет');
  }
});

test('REQ-150 bench.mjs --compare с настоящим коротким замером: записанный p95 в 0,01 мс — код 1 (рост многократный); щедрая база — код 0; файл замера не меняется', async () => {
  const before = sha(BENCH_JSON);
  const tiny = baseline_file('tiny.json', 0.01, 0.01, 1e9);
  const generous = baseline_file('generous.json', 100000, 100000, 1e9);
  const { out, io } = quiet();
  assert.equal(await BENCH.main(['--compare', '--baseline', tiny, '--samples', '3', '--rounds', '1'], io), 1);
  assert.equal(await BENCH.main(['--compare', '--baseline', generous, '--samples', '3', '--rounds', '1'], io), 0);
  const lines = out.filter(([k]) => k === 'log').map(([, m]) => m).join('\n');
  assert.match(lines, /n = 3, событий ≈ 1084/);
  assert.match(lines, /analyze: p95 сейчас [\d.]+ мс/);
  assert.match(lines, /recompute_q3: p95 сейчас [\d.]+ мс/);
  // против настоящего _ops/bench.json — только чтение
  const rc = await BENCH.main(['--compare', '--samples', '3', '--rounds', '1'], quiet().io);
  assert.ok(rc === 0 || rc === 1, 'код выхода ' + rc);
  assert.equal(sha(BENCH_JSON), before, '--compare ничего не пишет');
});

test('REQ-150 FP-23 запись замера сохраняет массив devices (записи со страницы bench.html) и не добавляет его, если его не было', async () => {
  const out_file = path.join(TMP, 'out.json');
  const saved = { log: console.log };
  console.log = () => {};
  try {
    const args = (f) => ['--date', '2026-10-23', '--out', f, '--samples', '2', '--rounds', '1', '--blocking-runs', '2', '--no-journal'];
    fs.writeFileSync(out_file, JSON.stringify({ format: 'runway-bench/1', devices: [{ device: 'тестовый телефон', date: '2026-10-23' }] }), 'utf8');
    assert.equal(await BENCH.main(args(out_file)), 0);
    const kept = JSON.parse(fs.readFileSync(out_file, 'utf8'));
    assert.deepEqual(kept.devices, [{ device: 'тестовый телефон', date: '2026-10-23' }]);
    assert.equal(kept.format, 'runway-bench/1');
    assert.equal(kept.date, '2026-10-23');
    assert.ok(kept.recompute.analyze.p95_ms > 0 && kept.recompute.n === 2);
    const fresh = path.join(TMP, 'fresh.json');
    assert.equal(await BENCH.main(args(fresh)), 0);
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(fresh, 'utf8')), 'devices'), false);
  } finally {
    console.log = saved.log;
  }
});
