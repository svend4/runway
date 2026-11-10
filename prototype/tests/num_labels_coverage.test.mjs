// num_labels_coverage.test.mjs — FP-47, часть 5 (REQ-177, TST-56): покрытие вики метками чисел G-001.
// `lint_vocab --coverage` перечисляет числа G-001 без метки `<!--num:G-001.ключ=значение-->` (по умолчанию не включён, код выхода 0), `tools/suggest_num_labels.mjs`
// печатает предложения и ничего не пишет; на страницах алгоритмов, где число G-001 стоит в таблице, поставлено не более 15 меток — каждая со значением из g001.golden.test.mjs.
// Расчёт по введённым данным и правилам, не консультация. В тестах допустимы node:*. Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/num_labels_coverage.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.resolve(HERE, '..');
const RUNWAY = path.resolve(PROTO, '..');
const L = await import(pathToFileURL(path.join(RUNWAY, 'tools', 'lint_vocab.mjs')).href);
const S = await import(pathToFileURL(path.join(PROTO, 'tools', 'suggest_num_labels.mjs')).href);
const GOLDEN_SRC = fs.readFileSync(path.join(HERE, 'g001.golden.test.mjs'), 'utf8');
const GOLDEN = await L.golden_values();
const ALG_DIR = path.join(RUNWAY, 'wiki', 'algorithms');

/** Метка → (фрагмент g001.golden.test.mjs, где канон записан дословно, ожидаемое значение). Значения переписаны из golden-файла, код движка в ожиданиях не участвует. */
const CANON = {
  'G-001.free.min.plan': ["key('G-001.free.min.plan', { amount_minor: 93500,", '93500'],
  'G-001.free.min.worse': ["key('G-001.free.min.worse', { amount_minor: 71000,", '71000'],
  'G-001.safe_to_spend.plan': ["key('G-001.sts.2026-11-19', { plan: 43500, worse: 21000 }", '43500'],
  'G-001.safe_to_spend.worse': ["key('G-001.sts.2026-11-19', { plan: 43500, worse: 21000 }", '21000'],
  'G-001.q3.treadmill.m_after.plan': ["key('G-001.q3.treadmill.m_after.plan', 63500,", '63500'],
  'G-001.q3.treadmill.m_after.worse': ["key('G-001.q3.treadmill.m_after.worse', 41000,", '41000'],
  'G-001.q3.s_max.worse': ["key('G-001.q3.s_max', { plan: 43500, worse: 21000 }", '21000'],
  'G-001.q3.s_max.plan': ["key('G-001.q3.s_max', { plan: 43500, worse: 21000 }", '43500'],
};

const labels_in = (text) => [...text.matchAll(/<!--\s*num:([A-Za-z0-9_.-]+)=([^\s>]*?)\s*-->/g)].map((m) => ({ key: m[1], value: m[2] }));
const alg_pages = () => fs.readdirSync(ALG_DIR).filter((n) => n.endsWith('.md')).sort().map((n) => path.join(ALG_DIR, n));
const run = (script, args, cwd = PROTO) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', timeout: 150000 });

// ── golden-значения и метки на страницах ──────────────────────────────────────────────────────────────────────────

test('REQ-177 FP-47 golden-ключи для меток: старые и новые (q3.s_max.*) считает движок; значения совпадают с каноном из g001.golden.test.mjs', () => {
  for (const [key, [snippet, value]] of Object.entries(CANON)) {
    assert.ok(GOLDEN_SRC.includes(snippet), `канон записан в golden-файле: ${snippet}`);
    assert.equal(GOLDEN[key], value, `${key}: движок даёт канонное значение`);
  }
  assert.ok(Object.keys(GOLDEN).length >= 17, 'прежние 15 ключей на месте и добавлены два новых (q3.s_max.plan, q3.s_max.worse)');
  assert.equal(GOLDEN['G-001.opening'], '400000');
  assert.equal(GOLDEN['G-001.q3.treadmill.verdict'], 'FRAGILE');
});

test('REQ-177 FP-47 метки на страницах алгоритмов: от 7 до 15, у каждой ключ с каноном в golden-файле и точное значение; lint_num_labels не находит расхождений', () => {
  const found = [];
  for (const f of alg_pages()) {
    const text = fs.readFileSync(f, 'utf8');
    for (const l of labels_in(text)) found.push({ ...l, file: path.basename(f) });
    assert.deepEqual(L.lint_num_labels(text, { file: path.basename(f), golden: GOLDEN }), [], path.basename(f));
  }
  assert.ok(found.length >= 7 && found.length <= 15, `меток на страницах алгоритмов: ${found.length} (предел 15, не массово)`);
  for (const l of found) {
    assert.ok(Object.hasOwn(CANON, l.key), `${l.file}: ключ ${l.key} известен тесту с каноном`);
    assert.equal(l.value, CANON[l.key][1], `${l.file}: ${l.key} = ${l.value}`);
    assert.ok(GOLDEN_SRC.includes(CANON[l.key][0]), `${l.file}: канон ключа ${l.key} есть в golden-файле`);
  }
  // метки стоят в таблицах (строка начинается с «|»), а не в прозе
  for (const f of alg_pages()) for (const ln of fs.readFileSync(f, 'utf8').split('\n')) if (/<!--\s*num:/.test(ln)) assert.ok(/^\s*\|/.test(ln), `${path.basename(f)}: метка в строке таблицы: ${ln.slice(0, 60)}`);
  // разные страницы: alg-10 (Монте-Карло), alg-11 (можно потратить), alg-12 (контракт инструментов)
  assert.deepEqual([...new Set(found.map((x) => x.file))].sort(), ['alg-10-uncertainty-monte-carlo.md', 'alg-11-safe-to-spend.md', 'alg-12-llm-tool-contract-and-number-verifier.md']);
});

test('REQ-177 FP-47 метка с неверным значением ловится: ERROR num-mismatch; неизвестный ключ — предупреждение (линтер остаётся строгим)', () => {
  const bad = L.lint_num_labels('| 1 | 63501<!--num:G-001.q3.treadmill.m_after.plan=63501--> |', { file: 'x.md', golden: GOLDEN });
  assert.equal(bad.length, 1);
  assert.equal(bad[0].level, 'error');
  assert.equal(bad[0].rule, 'num-mismatch');
  const unknown = L.lint_num_labels('| 1 | 5<!--num:G-001.no_such_key=5--> |', { file: 'x.md', golden: GOLDEN });
  assert.deepEqual(unknown.map((x) => [x.level, x.rule]), [['warn', 'num-unknown']]);
});

// ── сканер покрытия ───────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-177 FP-47 scan_coverage: число без метки перечисляется, с меткой того же значения — нет; метка со значением другого числа не покрывает; сама метка числом не считается', () => {
  const g = GOLDEN;
  const a = L.scan_coverage('Минимум 183000 на 11-14.', { file: 'a.md', golden: g });
  assert.deepEqual(a.missing.map((m) => [m.value, m.keys[0], m.line]), [['183000', 'G-001.q1.min_trough.worse', 1]]);
  assert.equal(a.found, 1);
  const b = L.scan_coverage('Минимум 183000<!--num:G-001.q1.min_trough.worse=183000--> на 11-14.', { file: 'b.md', golden: g });
  assert.deepEqual([b.found, b.labeled, b.missing.length], [1, 1, 0], 'число покрыто, метка вторым числом не считается');
  const c = L.scan_coverage('Минимум 183000 и 205500<!--num:G-001.q1.min_trough.plan=205500-->.', { file: 'c.md', golden: g });
  assert.deepEqual(c.missing.map((m) => m.value), ['183000'], 'метка другого числа строки покрывает только своё значение');
  const d = L.scan_coverage('| 183000 | 205500 |\n<!--num:G-001.q1.min_trough.worse=183000-->', { file: 'd.md', golden: g });
  assert.equal(d.missing.length, 2, 'метка в следующей строке не покрывает строку выше');
});

test('REQ-177 FP-47 scan_coverage: суммы с группами тысяч и двумя знаками («1 830,00», «1830.00», «1.830,00»), ссылка на ключ и комментарий lint-vocab: ignore; число внутри длинного числа не совпадает', () => {
  const g = GOLDEN;
  for (const text of ['Минимум 1 830,00 € 14 ноября.', 'Минимум 1830,00 €.', 'Min 1830.00 EUR', 'Min 1.830,00 EUR', 'Минимум 1 830,00 евро']) {
    assert.deepEqual(L.scan_coverage(text, { golden: g }).missing.map((m) => m.value), ['183000'], text);
  }
  assert.equal(L.scan_coverage('Ключ `G-001.q1.min_trough.worse` равен 183000.', { golden: g }).missing.length, 0, 'ссылка на ключ с тем же значением — это ссылка на таблицу ключей');
  assert.equal(L.scan_coverage('Ключ `G-001.opening` равен 183000.', { golden: g }).missing.length, 1, 'ключ другого значения не покрывает');
  assert.equal(L.scan_coverage('<!-- lint-vocab: ignore -->\nМинимум 183000.', { golden: g }).missing.length, 0, 'ignore в предыдущей строке');
  assert.equal(L.scan_coverage('Минимум 183000. <!-- lint-vocab: ignore -->', { golden: g }).missing.length, 0, 'ignore в той же строке');
  for (const text of ['Номер 1183000.', 'Номер 1830000.', 'Сумма 183000,5 рубля.', 'Номер 18300.', 'Дата 2026-11-14.', 'Код A183000B']) {
    const m = L.scan_coverage(text, { golden: g }).missing.map((x) => x.value);
    assert.ok(!m.includes('183000') || /A183000B/.test(text), `${text}: не совпало с 183000 (${m})`);
  }
});

test('REQ-177 FP-47 golden_numbers: только положительные целые не короче трёх знаков, у значения все его ключи; вердикт и текстовые значения числами не считаются', () => {
  const nums = L.golden_numbers(GOLDEN);
  assert.ok(nums.has('21000') && nums.has('400000'));
  assert.deepEqual(nums.get('21000'), ['G-001.q3.s_max.worse', 'G-001.safe_to_spend.worse'], 'одно значение — два ключа, по алфавиту');
  assert.ok(![...nums.keys()].some((v) => /\D/.test(v)), 'только цифры');
  assert.ok(![...nums.values()].flat().includes('G-001.q3.treadmill.verdict'));
  assert.equal(L.golden_numbers({ 'G-001.x': '-5', 'G-001.y': '12', 'G-001.z': 'FRAGILE', 'G-001.w': '1000' }).size, 1, 'остаётся только 1000');
});

test('REQ-177 FP-47 coverage_project на настоящей вики: числа найдены, часть покрыта, есть непокрытые; отчёт читается и режет число строк по limit; вики не меняется', () => {
  const before = alg_pages().map((f) => fs.readFileSync(f, 'utf8')).join('\0');
  const r = L.coverage_project({ golden: GOLDEN });
  assert.ok(r.pages > 50 && r.found > 300, `страниц ${r.pages}, чисел ${r.found}`);
  assert.ok(r.labeled >= 20, `с меткой или ссылкой на ключ: ${r.labeled}`);
  assert.ok(r.missing > 0 && r.missing + r.labeled === r.found, 'найдено = с меткой + без метки');
  const alg11 = r.files.find((f) => f.file === 'wiki/algorithms/alg-11-safe-to-spend.md');
  assert.ok(alg11 !== undefined);
  const row = fs.readFileSync(path.join(ALG_DIR, 'alg-11-safe-to-spend.md'), 'utf8').split('\n').findIndex((l) => l.startsWith('| **2026-11-19**')) + 1;
  assert.ok(row > 0 && !alg11.missing.some((m) => m.line === row), 'строка таблицы с метками покрыта целиком');
  const text = L.format_coverage(r, { limit: 5 });
  assert.match(text, /Числа G-001 без метки num:/);
  assert.match(text, /… показано 5 из \d+/);
  assert.match(text, /Режим только перечисляет: код выхода 0/);
  assert.equal(alg_pages().map((f) => fs.readFileSync(f, 'utf8')).join('\0'), before, 'ничего не записано');
});

test('REQ-177 FP-47 временная вики: непокрытое перечисляется, после вставки метки число покрыто; coverage_project читает только wiki/**/*.md', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cov_'));
  try {
    fs.mkdirSync(path.join(root, 'wiki', 'algorithms'), { recursive: true });
    fs.mkdirSync(path.join(root, 'raw'));
    const page = path.join(root, 'wiki', 'algorithms', 'x.md');
    fs.writeFileSync(page, '# x\n\n| a | b |\n|---|---|\n| минимум | 183000 |\n');
    fs.writeFileSync(path.join(root, 'raw', 'y.md'), 'вне вики: 183000\n');
    const r1 = L.coverage_project({ root, golden: GOLDEN });
    assert.deepEqual([r1.pages, r1.found, r1.missing], [1, 1, 1], 'raw/ не читается');
    fs.writeFileSync(page, '# x\n\n| a | b |\n|---|---|\n| минимум | 183000<!--num:G-001.q1.min_trough.worse=183000--> |\n');
    const r2 = L.coverage_project({ root, golden: GOLDEN });
    assert.deepEqual([r2.found, r2.labeled, r2.missing], [1, 1, 0]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── командная строка ──────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-177 FP-47 lint_vocab --coverage: код выхода 0 при непокрытых числах, печатает перечень и итог; без флага режим не включён, а линт даёт 0 ошибок', () => {
  const cov = run('../tools/lint_vocab.mjs', ['--coverage', '--limit', '3']);
  assert.equal(cov.status, 0, cov.stdout.slice(-500) + cov.stderr);
  assert.match(cov.stdout, /Числа G-001 без метки num:/);
  assert.match(cov.stdout, /Итого: чисел G-001 на страницах вики — \d+, с меткой или ссылкой на ключ — \d+, без метки — [1-9]\d*/);
  assert.match(cov.stdout, /… показано 3 из/);
  const js = run('../tools/lint_vocab.mjs', ['--coverage', '--json']);
  assert.equal(js.status, 0);
  const j = JSON.parse(js.stdout);
  assert.ok(j.found > 0 && j.missing > 0 && Array.isArray(j.files) && j.files.every((f) => f.missing.length > 0));
  // по умолчанию режим не включён: обычный запуск перечня не печатает и остаётся линтом (0 ошибок, 0 предупреждений)
  // «сегодня» фиксировано (FP-50, RISK-22): правило «измерение старше 90 дней» сверяется с опорной датой, а не с часами машины
  const plain = run('../tools/lint_vocab.mjs', ['--registry', 'demo/promises.json', '--today', '2026-10-28']);
  assert.equal(plain.status, 0, plain.stdout.slice(-500));
  assert.doesNotMatch(plain.stdout, /Числа G-001 без метки/);
  assert.match(plain.stdout, /Итого: 0 ошибок, 0 предупреждений/);
});

test('REQ-177 FP-47 suggest_num_labels: предлагает метки по ключам golden, выбирает ключ по словам строки, помечает неоднозначность, ничего не пишет', () => {
  const g = GOLDEN;
  const one = S.suggest_for_text('| e7 | money | 21000 EUR | `s_max.worse` | максимум на дату |', { file: 'x.md', golden: g });
  assert.equal(one.length, 1);
  assert.equal(one[0].key, 'G-001.q3.s_max.worse', 'слова строки (s_max, worse, максимум на дату) выбирают ключ');
  assert.deepEqual(one[0].others, ['G-001.safe_to_spend.worse']);
  assert.equal(one[0].label, '<!--num:G-001.q3.s_max.worse=21000-->');
  const sts = S.suggest_for_text('| можно потратить, если хуже | 21000 |', { file: 'x.md', golden: g });
  assert.equal(sts[0].key, 'G-001.safe_to_spend.worse');
  const tie = S.suggest_for_text('| значение | 21000 |', { file: 'x.md', golden: g });
  assert.equal(tie[0].ambiguous, true, 'нет слов-подсказок: решает человек');
  assert.equal(S.suggest_for_text('| значение | 21000<!--num:G-001.safe_to_spend.worse=21000--> |', { file: 'x.md', golden: g }).length, 0, 'число с меткой не предлагается');
  assert.equal(S.hint_score('G-001.q3.treadmill.m_after.plan', 'минимум по плану после покупки'), 2, 'две подсказки: «после покупки» (m_after) и «по плану» (plan)');
  // каждое предложение — корректная метка: проходит lint_num_labels
  const r = S.suggest_project({ golden: g });
  assert.ok(r.suggestions.length > 20 && r.pages >= 14);
  for (const s of r.suggestions) assert.deepEqual(L.lint_num_labels(s.label, { file: s.file, golden: g }), [], s.file + ':' + s.line);
  // «ничего не пишет»: в коде нет записи; файлы вики до и после запуска побайтно равны
  const src = fs.readFileSync(path.join(PROTO, 'tools', 'suggest_num_labels.mjs'), 'utf8');
  assert.ok(!/writeFileSync|appendFileSync|renameSync|unlinkSync|rmSync|mkdirSync|createWriteStream|\.writeFile\(/.test(src), 'инструмент ничего не пишет');
  const before = alg_pages().map((f) => fs.readFileSync(f, 'utf8')).join('\0');
  const cli = run('tools/suggest_num_labels.mjs', ['--file', 'wiki/algorithms/alg-04-can-i-afford.md', '--max', '4']);
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /инструмент ничего не пишет/);
  assert.match(cli.stdout, /alg-04-can-i-afford\.md:\d+: \d+ → <!--num:G-001\.[^>]+=\d+-->/);
  assert.match(cli.stdout, /… показано 4 из \d+/);
  assert.equal(alg_pages().map((f) => fs.readFileSync(f, 'utf8')).join('\0'), before);
  const js = run('tools/suggest_num_labels.mjs', ['--all', '--json']);
  const parsed = JSON.parse(js.stdout);
  assert.ok(parsed.pages > 50 && parsed.suggestions.length > r.suggestions.length, '--all шире, чем wiki/algorithms');
});

test('REQ-177 FP-47 lint_vocab --registry остаётся чистым и после меток: 0 ошибок, 0 предупреждений; сверка таблиц словаря тоже проходит', () => {
  const r = run('../tools/lint_vocab.mjs', ['--registry', 'demo/promises.json', '--today', '2026-10-28', '--json']); // «сегодня» фиксировано (FP-50, RISK-22)
  assert.equal(r.status, 0, r.stdout.slice(-400));
  const j = JSON.parse(r.stdout);
  assert.deepEqual([j.errors.length, j.warns.length], [0, 0]);
  const t = run('tools/gen_vocab_tables.mjs', ['--check']);
  assert.equal(t.status, 0, t.stdout);
});
