// fp51_adv.test.mjs — состязательная проверка FP-51 (независимый проверяющий): вики после FP-24, FP-48, FP-49, FP-50,
// числа прогона verify-wave3a5.txt, повторный аудит REQ (_ops/gap3), бэклог, неизменность кода относительно снимка.
// Тесты ADV-A…ADV-E (название — прежнее) — найденные дефекты: todo сняты после исправления 2026-11-09, тесты стали обычными и проходят.
// Остальные тесты — свойства, которые реализатор FP-51 заявил, проверенные здесь независимым путём (своим разбором файлов).
// Снимок до пакета: _backups/2026-11-09_181351_wave3a5-fp51-before (только чтение).
// Файл только читает каталоги проекта и снимок; процессов не запускает. Расчёт по введённым данным и правилам, не консультация.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/fp51_adv.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const RUNWAY = path.join(PROTO, '..');
const SNAP = path.join(RUNWAY, '_backups', '2026-11-09_181351_wave3a5-fp51-before');

const read = (...p) => fs.readFileSync(path.join(RUNWAY, ...p), 'utf8').replace(/\r/g, '');
const read_snap = (...p) => fs.readFileSync(path.join(SNAP, ...p), 'utf8').replace(/\r/g, '');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** Все файлы поддерева (рекурсивно), пути относительно корня поддерева. */
function walk(root) {
  const out = [];
  const go = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) go(p);
      else if (e.isFile()) out.push(path.relative(root, p).split(path.sep).join('/'));
    }
  };
  go(root);
  return out.sort();
}

/** Этот файл проверяющего не входит в прогон 2026-11-09 (отчёт старше него): при подсчёте дисковых файлов он исключён. */
const SELF_FILE = 'fp51_adv.test.mjs';
/** Число файлов тестов на диске: верхний уровень `tests/*.test.mjs` и `tests/adversarial/*.test.mjs` (без SELF_FILE). */
const top_count = () => fs.readdirSync(path.join(PROTO, 'tests')).filter((f) => f.endsWith('.test.mjs') && f !== SELF_FILE).length;
const adv_count = () => fs.readdirSync(path.join(PROTO, 'tests', 'adversarial')).filter((f) => f.endsWith('.test.mjs')).length;

/** Записи аудита REQ: все файлы `_ops/gap3/req-*.json` (массивы записей). */
function load_gap3() {
  const dir = path.join(RUNWAY, '_ops', 'gap3');
  const map = new Map();
  for (const f of fs.readdirSync(dir).filter((n) => /^req-.*\.json$/.test(n))) {
    for (const r of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) map.set(r.id, { ...r, _file: f });
  }
  return map;
}

/** Статус «status» по записям: объект {implemented, partial, missing, not_code}. */
function count_status(map) {
  const c = { implemented: 0, partial: 0, missing: 0, not_code: 0 };
  for (const r of map.values()) c[r.status] = (c[r.status] ?? 0) + 1;
  return c;
}

/** Страницы, которые FP-51 менял (тексты итоговых сверок и summary). */
const CHANGED_PAGES = [
  'wiki/overview.md',
  'wiki/sources/04-karpathy-llm-wiki.md',
  'wiki/product/06-ai-assistant-spec.md',
  'wiki/product/10-roadmap.md',
  'wiki/product/11-testing-strategy.md',
  'wiki/product/12-risks.md',
  'wiki/product/13-metrics.md',
  'wiki/product/15-prototype-guide.md',
  'wiki/product/16-prototype-findings.md',
  'wiki/product/17-start-plan.md',
  'wiki/product/18-implementation-gap-analysis.md',
  'wiki/product/19-implementation-status-after-wave2.md',
  'wiki/algorithms/alg-09-debt-amortization.md',
  'wiki/algorithms/alg-12-llm-tool-contract-and-number-verifier.md',
];

// ── дефекты (todo): падают на нынешнем состоянии ─────────────────────────────────────────────────────────────────────

// ADV-A: REQ-158 «реализовано» опирается на полный фаззинг 10⁵, записанный ДО последней правки validate_ws.mjs.
// Проверка по времени записи файлов в рабочей копии: `_ops/fuzz-nightly.json` (полный прогон 2026-10-28) и `engine/validate_ws.mjs`
// (правка FP-49 в 03:58 того же дня). Прогон не покрывает текущий код, поэтому статус по правилам аудита — «частично» до повтора `--full`.
test('FP-51 adv [ДЕФЕКТ]: REQ-158 «реализовано» опирается на полный фаззинг, записанный после последней правки движка validate_ws.mjs', () => {
  const r = load_gap3().get('REQ-158');
  assert.ok(r !== undefined, 'REQ-158 есть в gap3');
  const fuzz_ms = fs.statSync(path.join(RUNWAY, '_ops', 'fuzz-nightly.json')).mtimeMs;
  const eng_ms = fs.statSync(path.join(PROTO, 'engine', 'validate_ws.mjs')).mtimeMs;
  if (r.status === 'implemented') {
    assert.ok(eng_ms <= fuzz_ms, `validate_ws.mjs записан ${new Date(eng_ms).toISOString()}, полный прогон — ${new Date(fuzz_ms).toISOString()}: прогон не покрывает текущий код`);
  }
});

// ADV-B: числа файлов тестов на обзоре — не старое «94». Строка «Файлов тестов» должна называть число файлов на диске.
test('FP-51 adv [ДЕФЕКТ]: строка «Файлов тестов» на обзоре равна числу файлов тестов на диске', () => {
  const disk = top_count() + adv_count();
  const row = read('wiki', 'overview.md').split('\n').find((l) => l.startsWith('| Файлов тестов |')) ?? '';
  assert.ok(row.includes(String(disk)), `строка: ${row}; на диске ${disk}`);
});

// ADV-C: карта prototype/README называет число файлов верхнего уровня `tests/` — как на диске.
test('FP-51 adv [ДЕФЕКТ]: карта prototype/README «tests/ *.test.mjs (N)» равна числу файлов верхнего уровня на диске', () => {
  const m = /tests\/\s+\*\.test\.mjs \((\d+)\)/.exec(read('prototype', 'README.md'));
  assert.ok(m !== null, 'строка карты tests/ не найдена');
  assert.equal(Number(m[1]), top_count());
});

// ADV-D: _ops/tst-coverage.json не считает идентификаторов вне реестра TST-01…60 (страница 11 и обзор говорят «60 из 60»).
test('FP-51 adv [ДЕФЕКТ]: _ops/tst-coverage.json не содержит идентификаторов вне реестра TST-01…TST-60', () => {
  const o = JSON.parse(read('_ops', 'tst-coverage.json'));
  const extra = Object.keys(o.covered).filter((k) => !/^(0[1-9]|[1-5]\d|60)$/.test(k));
  assert.deepEqual(extra, []);
});

// ADV-E: согласование числительного и «модуль»: «121 модуль», а не «121 модулей» (ADV-2 fp30 требует прежнюю форму — конфликт, см. notes).
test('FP-51 adv [ДЕФЕКТ]: согласование «N модул…» на страницах 10, 15 и README прототипа: «121 модуль», «39 модулей»', () => {
  const bad = [];
  let seen = 0;
  const pages = [['wiki', 'product', '10-roadmap.md'], ['wiki', 'product', '15-prototype-guide.md'], ['prototype', 'README.md']];
  for (const rel of pages) {
    // \b здесь не годится: без флага u граница слова считается только для ASCII, и после кириллицы она не находится
    for (const m of read(...rel).matchAll(/(\d+) (модул[а-яё]+)(?![а-яё])/g)) {
      seen += 1;
      const n = Number(m[1]);
      const want = n % 10 === 1 && n % 100 !== 11 ? 'модуль' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'модуля' : 'модулей';
      if (m[2] !== want) bad.push(rel[rel.length - 1] + ': «' + m[0] + '»');
    }
  }
  assert.ok(seen >= 3, 'совпадений «N модул…» должно быть не меньше трёх: ' + seen);
  assert.deepEqual(bad, []);
});

// ── свойства, которые FP-51 заявил (должны быть зелёными) ────────────────────────────────────────────────────────────

test('FP-51 adv: summary изменённых страниц не длиннее 200 знаков (включая обзор, 04, 06, 16–19 и алгоритмы 09 и 12)', () => {
  const long = [];
  for (const rel of CHANGED_PAGES) {
    const m = /^summary:\s*"(.*)"\s*$/m.exec(read(...rel.split('/')));
    assert.ok(m !== null, rel + ': нет summary');
    if (m[1].length > 200) long.push(rel + ' (' + m[1].length + ')');
  }
  assert.deepEqual(long, []);
});

test('FP-51 adv: записи gap3 пересчитываются в summary.json (all_new и must_v1_new совпадают с записями)', () => {
  const recs = load_gap3();
  assert.equal(recs.size, 155, 'записей REQ: ' + recs.size);
  const c = count_status(recs);
  const must_v1 = [...recs.values()].filter((r) => r.priority === 'Must' && r.phase === 'v1');
  const m = { implemented: 0, partial: 0, missing: 0, not_code: 0 };
  for (const r of must_v1) m[r.status] = (m[r.status] ?? 0) + 1;
  const s = JSON.parse(read('_ops', 'gap3', 'summary.json'));
  assert.equal(s.all_new, `реализовано ${c.implemented} / частично ${c.partial} / нет ${c.missing} / не код ${c.not_code} (всего 155)`);
  assert.equal(s.must_v1_new, `реализовано ${m.implemented} / частично ${m.partial} / нет ${m.missing} / не код ${m.not_code} (всего ${must_v1.length})`);
});

test('FP-51 adv: страница 19 называет итоги после волны 3а-5 теми же числами, что summary.json', () => {
  const p19 = read('wiki', 'product', '19-implementation-status-after-wave2.md');
  assert.ok(p19.includes('реализовано 113 / частично 27 / нет 11 / не код 4'), 'итог 155 REQ на странице 19');
  assert.ok(p19.includes('**66**') && p19.includes('**10**'), 'Must · v1 на странице 19');
});

test('FP-51 adv: статусы бэклога — FP-24, FP-30, FP-47, FP-48, FP-49 done; FP-50, FP-51 review; FP-52 proposed с needs_owner', () => {
  const arr = JSON.parse(read('_ops', 'gap2', 'backlog-wave3.json'));
  const st = (id) => arr.find((e) => e.id === id);
  for (const id of ['FP-24', 'FP-30', 'FP-47', 'FP-48', 'FP-49']) assert.equal(st(id)?.status, 'done', id);
  for (const id of ['FP-50', 'FP-51']) assert.equal(st(id)?.status, 'review', id);
  assert.equal(st('FP-52')?.status, 'proposed');
  assert.equal(st('FP-52')?.needs_owner, true);
});

test('FP-51 adv: FP-51 не добавил запрещённых слов из engine/vocab.json (forbidden_phrases) на изменённые страницы (число вхождений не выросло относительно снимка)', () => {
  const vocab = JSON.parse(fs.readFileSync(path.join(PROTO, 'engine', 'vocab.json'), 'utf8'));
  const phrases = (vocab.forbidden_phrases ?? []).map((p) => (typeof p === 'string' ? p : p.text ?? p.phrase ?? '')).filter(Boolean);
  assert.ok(phrases.length > 0, 'словарь запрещённых фраз пуст или иного вида');
  const count = (txt, ph) => txt.toLowerCase().split(ph.toLowerCase()).length - 1;
  const grew = [];
  for (const rel of CHANGED_PAGES) {
    const now = read(...rel.split('/'));
    const before = read_snap(...rel.split('/'));
    for (const ph of phrases) {
      const a = count(before, ph);
      const b = count(now, ph);
      if (b > a) grew.push(`${rel}: «${ph}» ${a} → ${b}`);
    }
  }
  assert.deepEqual(grew, []);
});

test('FP-51 adv: код не менялся относительно снимка: engine/, demo/, data/ совпадают побайтно (правило FP-51 «код не менять»)', () => {
  const diffs = [];
  for (const sub of ['engine', 'demo', 'data']) {
    const a = walk(path.join(SNAP, 'prototype', sub));
    const b = walk(path.join(PROTO, sub));
    assert.ok(a.length >= 10, sub + ': в снимке файлов ' + a.length);
    if (a.join('\n') !== b.join('\n')) diffs.push(sub + ': набор файлов отличается');
    for (const f of a) {
      const pb = path.join(PROTO, sub, f);
      if (!fs.existsSync(pb) || sha(path.join(SNAP, 'prototype', sub, f)) !== sha(pb)) diffs.push(sub + '/' + f);
    }
  }
  assert.deepEqual(diffs, []);
});

test('FP-51 adv: канон не тронут: data/g001*.json, tests/g001.golden.test.mjs, tests/arith.lock.json, engine/vocab.json — побайтно как в снимке', () => {
  const files = [
    ...fs.readdirSync(path.join(PROTO, 'data')).filter((f) => /^g001.*\.json$/.test(f)).map((f) => path.join('data', f)),
    path.join('tests', 'g001.golden.test.mjs'),
    path.join('tests', 'arith.lock.json'),
    path.join('engine', 'vocab.json'),
  ];
  const diffs = files.filter((f) => sha(path.join(PROTO, f)) !== sha(path.join(SNAP, 'prototype', f)));
  assert.deepEqual(diffs, []);
});

test('FP-51 adv: имена тестов fp30_adv, fp25_adv, fp25_fix из снимка сохранены (todo сняты, названия прежние)', () => {
  const names = (txt) => [...txt.matchAll(/^test\(\s*'([^']+)'/gm)].map((m) => m[1]);
  for (const f of ['fp30_adv', 'fp25_adv', 'fp25_fix']) {
    const now = new Set(names(read('prototype', 'tests', f + '.test.mjs')));
    const before = names(read_snap('prototype', 'tests', f + '.test.mjs'));
    assert.ok(before.length >= 5, f + ': в снимке найдено имён тестов ' + before.length);
    const lost = before.filter((n) => !now.has(n));
    assert.deepEqual(lost, [], f + ': пропавшие или переименованные тесты');
  }
});

test('FP-51 adv: обзор и корневой README называют 3535 тестов прогона verify-wave3a5 и «закрыты 52, частично 8» по странице 11', () => {
  const ov = read('wiki', 'overview.md');
  assert.ok(ov.includes('3535 тестов'), 'обзор: 3535 тестов');
  assert.ok(read('README.md').includes('3535 тестов'), 'корневой README: 3535 тестов');
  assert.ok(ov.includes('закрыты 52, частично 8'), 'обзор: закрыты 52, частично 8');
  const sect = read('wiki', 'product', '11-testing-strategy.md').split('## Статус TST в прототипе')[1]?.split('### Тесты todo')[0] ?? '';
  const st = { покрыт: 0, частично: 0 };
  for (const line of sect.split('\n').filter((l) => /^\| \d+ \|/.test(l))) {
    const cell = line.split('|')[5]?.trim() ?? '';
    if (cell.startsWith('покрыт')) st.покрыт += 1;
    else if (cell.startsWith('частично')) st.частично += 1;
  }
  assert.deepEqual(st, { покрыт: 52, частично: 8 });
});

test('FP-51 adv: 04-karpathy называет RISK-01…24 и 12-risks содержит ровно RISK-01…24', () => {
  assert.ok(read('wiki', 'sources', '04-karpathy-llm-wiki.md').includes('RISK-01…24'));
  const ids = [...read('wiki', 'product', '12-risks.md').matchAll(/^### RISK-(\d\d) /gm)].map((m) => Number(m[1]));
  assert.deepEqual(ids, Array.from({ length: 24 }, (_, i) => i + 1));
});

test('FP-51 adv: число файлов в шапке отчёта прогона совпадает с числом строк отчёта и с числом файлов на диске', () => {
  const txt = read('_ops', 'impl', 'run', 'verify-wave3a5.txt');
  const head = txt.split('\n')[0];
  const rows = txt.split('\n').filter((l) => l.startsWith('tests/'));
  assert.equal(rows.length, top_count() + adv_count(), 'строк отчёта против файлов на диске');
  assert.ok(head.includes('201 из 201 файлов'), head);
});
