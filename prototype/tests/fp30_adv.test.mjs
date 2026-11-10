// fp30_adv.test.mjs — состязательная проверка FP-30 (независимый проверяющий): синхронизация вики с кодом после волн 1–3а.
// Пакет FP-30 правит только страницы вики; ни lint, ни lint_vocab не сверяют числа страниц с кодом и отчётами прогонов. Здесь это делается тестами.
// ADV-1  числа сквозного прогона на страницах 10, 11, 15, 17 равны числам отчёта, который страницы называют (сумма по строкам отчёта).
// ADV-2  состав кода (модули движка и демо, строки, каталоги строк, стили, пакеты, разделы навигации) равен числам на страницах 10 и 15.
// ADV-3  отчёт полон: каждый файл тестов на диске есть в отчёте и наоборот (кроме этого файла); «190 + 4» на страницах сходится с диском.
// ADV-4  таблица недочётов в 11-testing-strategy: «Помечено» по каждому файлу `fp*_adv` равно числу `todo` в отчёте; 22 + 4 = всего `todo`.
// ADV-5  таблицы Markdown на изменённых страницах: число ячеек в каждой строке равно шапке (экранированный разделитель ячейку не делит).
// ADV-6  якоря: каждая ссылка с `#якорем` на любой странице вики указывает на существующий заголовок.
// ADV-7  реестр рисков: RISK-01…24 по одному заголовку; произведение, класс и ячейка матрицы согласованы с таблицей.
// ADV-8…ADV-14  найденные дефекты (низкая важность): исправлены в FP-51, тесты стали обычными (названия прежние; todo сняты).
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/fp30_adv.test.mjs
// Файл только читает каталоги проекта и ничего не пишет; процессов не запускает. Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const RUNWAY = path.join(PROTO, '..');
const SELF = 'fp30_adv.test.mjs';

const read = (...p) => fs.readFileSync(path.join(RUNWAY, ...p), 'utf8').replace(/\r/g, '');
/** Отчёт прогона, на который опирается страница 11: последний `verify-*.txt` в её `sources` (при новом прогоне страницу и список обновляют вместе). */
function report_rel() {
  const src = /^sources:\s*\[(.*)\]\s*$/m.exec(read('wiki', 'product', '11-testing-strategy.md'));
  assert.ok(src !== null, '11-testing-strategy: нет sources');
  const all = [...src[1].matchAll(/_ops\/impl\/run\/(verify-[A-Za-z0-9._-]+\.txt)/g)].map((m) => m[1]);
  assert.ok(all.length > 0, '11-testing-strategy: в sources нет отчёта прогона');
  return ['_ops', 'impl', 'run', all[all.length - 1]];
}
const REPORT_REL = report_rel();

const ALG_FILES = fs.readdirSync(path.join(RUNWAY, 'wiki', 'algorithms')).filter((f) => f.endsWith('.md')).sort().map((f) => ['wiki', 'algorithms', f]);
const PRODUCT = ['10-roadmap', '11-testing-strategy', '12-risks', '13-metrics', '15-prototype-guide', '16-prototype-findings', '17-start-plan', '18-implementation-gap-analysis'];
const PRODUCT_FILES = PRODUCT.map((n) => ['wiki', 'product', n + '.md']);
const CHANGED = [...ALG_FILES, ...PRODUCT_FILES];
const page = (name) => read('wiki', 'product', name + '.md');

/** Отчёт сквозного прогона: строки `tests/<файл>\tтестов\tзелёных\tупавших\tпропущено\ttodo\tвремя`. */
function parse_report() {
  const rows = new Map();
  for (const line of read(...REPORT_REL).split('\n')) {
    if (!line.startsWith('tests/')) continue;
    const p = line.split('\t');
    if (p.length < 6) continue;
    rows.set(p[0], { tests: Number(p[1]), pass: Number(p[2]), fail: Number(p[3]), skip: Number(p[4]), todo: Number(p[5]) });
  }
  return rows;
}
const REPORT = parse_report();
const TOTAL = { files: REPORT.size, tests: 0, pass: 0, fail: 0, skip: 0, todo: 0 };
for (const r of REPORT.values()) for (const k of ['tests', 'pass', 'fail', 'skip', 'todo']) TOTAL[k] += r[k];
/** Имя файла без каталога и без `.test.mjs` → строка отчёта (для `adversarial/…` ищется и по короткому имени). */
const BY_NAME = new Map();
for (const [file, r] of REPORT) {
  const full = file.replace(/^tests\//, '').replace(/\.test\.mjs$/, '');
  BY_NAME.set(full, r);
  const short = full.replace(/^adversarial\//, '');
  if (!BY_NAME.has(short)) BY_NAME.set(short, r);
}

const has_number = (text, n) => new RegExp('(?<![\\d.,])' + String(n) + '(?!\\d)').test(text);
const count_nl = (file) => (fs.readFileSync(file, 'utf8').match(/\n/g) ?? []).length;

// ── ADV-1: числа прогона ──────────────────────────────────────────────────────────────────────────────────────────────

test('FP-30 adv ADV-1: отчёт прогона согласован сам с собой (шапка = сумма строк), а страницы 10, 11, 15, 17 называют те же числа', () => {
  const head = read(...REPORT_REL).split('\n')[0];
  // FP-51 (исправление по проверке 2026-11-09): шапка текущего run_all — «N файлов по одному»; прежние отчёты — «N из M файлов». Принимаются оба формата.
  const m = /(?:(\d+) из )?(\d+) файлов.*тестов (\d+), прошло (\d+), упало (\d+), пропущено (\d+), todo (\d+)/.exec(head);
  assert.ok(m !== null, 'шапка отчёта не разобрана: ' + head);
  assert.deepEqual([TOTAL.files, TOTAL.tests, TOTAL.pass, TOTAL.fail, TOTAL.skip, TOTAL.todo], [m[2], m[3], m[4], m[5], m[6], m[7]].map(Number), 'шапка отчёта расходится с суммой строк');
  for (const name of ['10-roadmap', '11-testing-strategy', '15-prototype-guide', '17-start-plan']) {
    const text = page(name);
    for (const [label, n] of [['файлов', TOTAL.files], ['тестов', TOTAL.tests], ['зелёных', TOTAL.pass], ['todo', TOTAL.todo]]) {
      assert.ok(has_number(text, n), name + ': нет числа ' + label + ' = ' + n);
    }
  }
  assert.ok(page('11-testing-strategy').includes(REPORT_REL[REPORT_REL.length - 1]), '11: текст называет отчёт прогона из sources');
});

// ── ADV-2: состав кода ────────────────────────────────────────────────────────────────────────────────────────────────

test('FP-30 adv ADV-2: модули и строки движка и демо, каталоги строк, стили, пакеты и разделы навигации равны числам страниц 10 и 15', async () => {
  const eng_dir = path.join(PROTO, 'engine');
  const eng = fs.readdirSync(eng_dir).filter((f) => f.endsWith('.mjs'));
  const eng_lines = eng.reduce((s, f) => s + count_nl(path.join(eng_dir, f)), 0);
  const demo_dir = path.join(PROTO, 'demo');
  const demo = fs.readdirSync(demo_dir).filter((f) => f.endsWith('.mjs'));
  const demo_lines = demo.reduce((s, f) => s + count_nl(path.join(demo_dir, f)), 0);
  const i18n = fs.readdirSync(path.join(demo_dir, 'i18n')).filter((f) => f.endsWith('.mjs')).length;
  const css = fs.readdirSync(path.join(demo_dir, 'css')).filter((f) => f.endsWith('.css')).length;
  const { PACKS } = await import(pathToFileURL(path.join(demo_dir, 'ext_manifest.mjs')).href);
  const { CORE_VIEWS } = await import(pathToFileURL(path.join(demo_dir, 'ext.mjs')).href);
  let registered = 0;
  for (const f of fs.readdirSync(demo_dir).filter((n) => /^pack_fp\d+\.mjs$/.test(n))) registered += (fs.readFileSync(path.join(demo_dir, f), 'utf8').match(/ext\.register_view\(/g) ?? []).length;
  const spaced = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  // FP-51 (исправление по проверке 2026-11-09): число с существительным в правильной форме — 1 модуль, 2 модуля, 5 модулей, 121 модуль
  const modules_word = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'модуль' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'модуля' : 'модулей');
  const roadmap = page('10-roadmap');
  const guide = page('15-prototype-guide');
  assert.ok(registered > 0 && PACKS.length > 0 && eng.length > 0, 'каталоги разобраны');
  for (const [label, text] of [['10-roadmap', roadmap], ['15-prototype-guide', guide]]) {
    assert.ok(text.includes(eng.length + ' ' + modules_word(eng.length)), label + ': число модулей движка ' + eng.length);
    assert.ok(text.includes(spaced(eng_lines) + ' строк'), label + ': строк движка ' + spaced(eng_lines));
    assert.ok(text.includes(demo.length + ' ' + modules_word(demo.length)), label + ': модулей демо ' + demo.length);
    assert.ok(text.includes(i18n + ' каталог'), label + ': каталогов строк ' + i18n);
    assert.ok(text.includes(css + ' файл'), label + ': файлов стилей ' + css);
    assert.ok(text.includes(PACKS.length + ' пакетов'), label + ': пакетов ' + PACKS.length);
    assert.ok(text.includes(CORE_VIEWS.length + registered + ' раздела'), label + ': разделов навигации');
  }
  assert.ok(guide.includes(spaced(demo_lines) + ' строк'), '15: строк демо ' + spaced(demo_lines));
});

// ── ADV-3: полнота отчёта ─────────────────────────────────────────────────────────────────────────────────────────────

test('FP-30 adv ADV-3: каждый файл тестов на диске есть в отчёте прогона (кроме этого файла) и наоборот; «N в tests/ и M состязательных» на страницах 10 и 15 равно отчёту', () => {
  const top = fs.readdirSync(HERE).filter((f) => f.endsWith('.test.mjs')).map((f) => 'tests/' + f);
  const adv = fs.readdirSync(path.join(HERE, 'adversarial')).filter((f) => f.endsWith('.test.mjs')).map((f) => 'tests/adversarial/' + f);
  const disk = new Set([...top, ...adv]);
  // FP-51 (исправление по проверке 2026-11-09): файл проверки fp51_adv.test.mjs создан после прогона verify-wave3a5 и в отчёт не входит
  const AFTER_RUN = ['tests/fp51_adv.test.mjs'];
  assert.deepEqual([...disk].filter((f) => !REPORT.has(f) && f !== 'tests/' + SELF && !AFTER_RUN.includes(f)), [], 'файлы тестов вне отчёта (после прогона добавлены новые)');
  assert.deepEqual([...REPORT.keys()].filter((f) => !disk.has(f)), [], 'файлы отчёта, которых нет на диске');
  const keys = [...REPORT.keys()];
  const n_adv = keys.filter((f) => f.startsWith('tests/adversarial/')).length;
  const n_top = keys.length - n_adv;
  for (const name of ['10-roadmap', '15-prototype-guide']) {
    const text = page(name);
    assert.ok(text.includes(n_top + ' в `tests/`'), name + ': ' + n_top + ' в `tests/`');
    assert.ok(text.includes(n_adv + ' состязательных'), name + ': ' + n_adv + ' состязательных');
  }
});

// ── ADV-4: разбор todo ────────────────────────────────────────────────────────────────────────────────────────────────

test('FP-30 adv ADV-4: таблица недочётов в 11-testing-strategy — «Помечено» по каждому fp*_adv равно todo из отчёта; 22 + 4 = всего todo', () => {
  const text = page('11-testing-strategy');
  const rows = [...text.matchAll(/^\| `(fp\d+_adv)` \| (\d+) \| (\d+) \|/gm)].map((m) => ({ name: m[1], marked: Number(m[2]), open: Number(m[3]) }));
  assert.ok(rows.length >= 8, 'строк таблицы: ' + rows.length);
  let marked = 0;
  let open = 0;
  for (const r of rows) {
    const rep = REPORT.get('tests/' + r.name + '.test.mjs');
    assert.ok(rep !== undefined, r.name + ': нет в отчёте');
    assert.equal(r.marked, rep.todo, r.name + ': «Помечено» против todo отчёта');
    assert.ok(r.open <= r.marked, r.name + ': открыто больше, чем помечено');
    marked += r.marked;
    open += r.open;
  }
  const adversarial_todo = [...REPORT].filter(([f]) => f.startsWith('tests/adversarial/')).reduce((s, [, r]) => s + r.todo, 0);
  const all_fp_adv = [...REPORT].filter(([f]) => /^tests\/fp\d+_adv\.test\.mjs$/.test(f)).reduce((s, [, r]) => s + r.todo, 0);
  assert.equal(marked, all_fp_adv, 'таблица не пропускает файлы fp*_adv с todo');
  assert.equal(marked + adversarial_todo, TOTAL.todo, 'todo всего = fp*_adv + adversarial');
  // собственная фраза страницы: «у N помеченных тестов дефект открыт, у M дефект исправлен после проверки»
  const said = /[Уу] (\d+) помеченных тестов дефект открыт[^.]*?у (\d+) дефект исправлен/.exec(text);
  assert.ok(said !== null, 'фраза об открытых и исправленных не найдена');
  assert.equal(open, Number(said[1]), 'сумма столбца «Открыто» равна числу в тексте');
  assert.equal(marked - open, Number(said[2]), 'исправлено без снятия пометки: таблица против текста');
});

// ── ADV-5: таблицы Markdown ───────────────────────────────────────────────────────────────────────────────────────────

const BACKSLASH = String.fromCharCode(92);
function cells_of(line) {
  const t = line.trim();
  let n = 1;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === BACKSLASH) { i++; continue; }
    if (t[i] === '|') n++;
  }
  if (t.startsWith('|')) n--;
  if (t.endsWith('|') && !t.endsWith(BACKSLASH + '|')) n--;
  return n;
}

test('FP-30 adv ADV-5: во всех таблицах изменённых страниц число ячеек строки равно шапке (иначе таблица рассыпается при показе)', () => {
  const bad = [];
  let tables = 0;
  for (const rel of CHANGED) {
    const lines = read(...rel).split('\n');
    let in_code = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^```/.test(lines[i])) { in_code = !in_code; continue; }
      if (in_code || !/^\|/.test(lines[i]) || i + 1 >= lines.length || !/^\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) continue;
      tables += 1;
      const head = cells_of(lines[i]);
      let j = i + 2;
      while (j < lines.length && /^\|/.test(lines[j])) {
        if (cells_of(lines[j]) !== head) bad.push(rel[rel.length - 1] + ':' + (j + 1));
        j += 1;
      }
      i = j - 1;
    }
  }
  assert.ok(tables > 150, 'таблиц разобрано: ' + tables);
  assert.deepEqual(bad, []);
});

// ── ADV-6: якоря ──────────────────────────────────────────────────────────────────────────────────────────────────────

function walk_md(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk_md(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}
const slug = (h) => h.trim().toLowerCase().replace(/<[^>]*>/g, '').replace(/[`*_~]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');

test('FP-30 adv ADV-6: ссылки с #якорем на всех страницах вики указывают на существующий заголовок (линтер вики якоря не проверяет)', () => {
  const pages = walk_md(path.join(RUNWAY, 'wiki'));
  const heads = new Map();
  for (const p of pages) {
    const set = new Set();
    const seen = new Map();
    let in_code = false;
    for (const line of fs.readFileSync(p, 'utf8').replace(/\r/g, '').split('\n')) {
      if (/^```/.test(line)) { in_code = !in_code; continue; }
      const m = in_code ? null : /^#{1,6}\s+(.*)$/.exec(line);
      if (m === null) continue;
      const s = slug(m[1]);
      const k = seen.get(s) ?? 0;
      seen.set(s, k + 1);
      set.add(k === 0 ? s : s + '-' + k);
    }
    heads.set(path.resolve(p), set);
  }
  const bad = [];
  let total = 0;
  for (const p of pages) {
    for (const m of fs.readFileSync(p, 'utf8').replace(/\r/g, '').matchAll(/\]\(([^)\s]*?)#([^)\s]+)\)/g)) {
      total += 1;
      const target = path.resolve(m[1] === '' ? p : path.resolve(path.dirname(p), m[1]));
      let anchor = m[2];
      try { anchor = decodeURIComponent(anchor); } catch { /* оставляем как есть */ }
      if (!(heads.get(target)?.has(anchor) ?? false)) bad.push(path.relative(RUNWAY, p) + ' → ' + m[1] + '#' + anchor);
    }
  }
  assert.ok(total >= 40, 'ссылок с якорем: ' + total);
  assert.deepEqual(bad, []);
});

// ── ADV-7: реестр рисков ──────────────────────────────────────────────────────────────────────────────────────────────

test('FP-30 adv ADV-7: реестр рисков — RISK-01…24 по одному заголовку, произведение В×У, класс и ячейка матрицы согласованы', () => {
  const text = page('12-risks');
  const ids = [...text.matchAll(/^### RISK-(\d\d) /gm)].map((m) => m[1]);
  assert.deepEqual(ids, Array.from({ length: ids.length }, (_, i) => String(i + 1).padStart(2, '0')), 'номера подряд без дыр и повторов');
  assert.ok(ids.length >= 24, 'рисков: ' + ids.length);
  const rows = [...text.matchAll(/^\| (\d\d) \| (\d) \| (\d) \| (\d+) \| (критический|высокий|средний) \|/gm)].map((m) => ({ id: m[1], p: Number(m[2]), d: Number(m[3]), prod: Number(m[4]), cls: m[5] }));
  assert.equal(rows.length, ids.length, 'строк сводной таблицы');
  const matrix = new Map();
  for (const m of text.matchAll(/^\| ([2-5]) \| ([^|]*) \| ([^|]*) \| ([^|]*) \|$/gm)) {
    const d = Number(m[1]);
    [2, 3, 4].forEach((p, i) => {
      const cell = m[2 + i];
      const ids_in = new Set([...cell.matchAll(/(?:RISK-)?(\d\d)\b/g)].map((x) => x[1]));
      for (const id of ids_in) matrix.set(id, `${d}/${p}`);
    });
  }
  for (const r of rows) {
    assert.equal(r.prod, r.p * r.d, 'RISK-' + r.id + ': произведение');
    const cls = r.prod >= 15 ? 'критический' : r.prod >= 10 ? 'высокий' : 'средний';
    assert.equal(r.cls, cls, 'RISK-' + r.id + ': класс');
    assert.equal(matrix.get(r.id), `${r.d}/${r.p}`, 'RISK-' + r.id + ': ячейка матрицы (У/В)');
  }
  assert.equal(matrix.size, ids.length, 'в матрице все риски');
});

// ── найденные дефекты (низкая важность): тесты todo ───────────────────────────────────────────────────────────────────

// ADV-8 — найденный дефект (низкая важность), исправлен в FP-51: summary изменённых страниц сокращены до 200 знаков (10, 11, 12, 15, alg-09); подробности перенесены в тело страниц. Название теста прежнее.
test('FP-30 adv ADV-8 [ДЕФЕКТ]: summary изменённых страниц не длиннее 200 знаков (CLAUDE.md §4); линтер терпит до 220', () => {
  const long = [];
  for (const rel of CHANGED) {
    const m = /^summary:\s*"(.*)"\s*$/m.exec(read(...rel));
    assert.ok(m !== null, rel[rel.length - 1] + ': нет summary');
    if (m[1].length > 200) long.push(rel[rel.length - 1] + ' (' + m[1].length + ')');
  }
  assert.deepEqual(long, []);
});

// ADV-9 — найденный дефект (низкая важность), исправлен в FP-51: число тестов у названных файлов на страницах равно отчёту прогона (15: scenario_builder 19; 13: v0 22). Название теста прежнее.
test('FP-30 adv ADV-9 [ДЕФЕКТ]: число тестов у названного файла на страницах равно отчёту прогона (во всех изменённых страницах, кроме явно историчных)', () => {
  const re = /`(?:prototype\/)?(?:tests\/)?(?:adversarial\/)?([a-z0-9_]+)(?:\.test\.mjs)?`\s*\((\d+)(?=[,;)\s])/g;
  const bad = [];
  let checked = 0;
  for (const rel of [...ALG_FILES, ['wiki', 'product', '13-metrics.md'], ['wiki', 'product', '15-prototype-guide.md']]) {
    for (const m of read(...rel).matchAll(re)) {
      const r = BY_NAME.get(m[1]);
      if (r === undefined) continue;
      checked += 1;
      if (r.tests !== Number(m[2])) bad.push(rel[rel.length - 1] + ': ' + m[1] + ' страница ' + m[2] + ', отчёт ' + r.tests);
    }
  }
  assert.ok(checked > 150, 'сверено названий: ' + checked);
  assert.deepEqual(bad, []);
});

// ADV-10 — найденный дефект (низкая важность), исправлен в FP-51: на ALG-12 записано «12 порч: 11 убиты тестами модуля, одна (V07) эквивалентна», строка «все убиты» снята. Название теста прежнее.
test('FP-30 adv ADV-10 [ДЕФЕКТ]: «у verifier.mjs 12 порч; все убиты» на ALG-12 — по _ops/mutation.json убито 11, одна (V07) эквивалентна', () => {
  const mutation = JSON.parse(read('_ops', 'mutation.json'));
  const v = mutation.engine.by_module.verifier;
  const alg12 = read('wiki', 'algorithms', 'alg-12-llm-tool-contract-and-number-verifier.md');
  const line = alg12.split('\n').find((l) => l.includes('Мутации ядра')) ?? '';
  assert.ok(line.includes(v.mutants + ' порч'), 'число порч названо верно: ' + v.mutants);
  if (v.killed < v.mutants) assert.ok(!/все убиты/.test(line), 'убито ' + v.killed + ' из ' + v.mutants + ', а страница пишет «все убиты»');
});

// ADV-11 — найденный дефект (низкая важность), исправлен в FP-51: в js-блоках ALG-12 у render_value, render_claim, render_answer, extract_quantities, verify_text, a0_answer добавлен необязательный number_format?. Название теста прежнее.
test('FP-30 adv ADV-11 [ДЕФЕКТ]: сигнатуры в js-блоках ALG содержат все параметры экспортов (число аргументов равно коду)', () => {
  const eng = path.join(PROTO, 'engine');
  const exports = new Map();
  const split_top = (raw) => {
    const parts = [];
    let depth = 0;
    let cur = '';
    for (const ch of raw) {
      if ('([{'.includes(ch)) depth += 1;
      if (')]}'.includes(ch)) depth -= 1;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
    }
    if (cur.trim() !== '') parts.push(cur);
    return parts.map((p) => p.trim()).filter(Boolean);
  };
  for (const f of fs.readdirSync(eng).filter((n) => n.endsWith('.mjs'))) {
    for (const m of fs.readFileSync(path.join(eng, f), 'utf8').matchAll(/^export (?:async )?function\*? ([A-Za-z0-9_]+)\s*\(([^)]*)\)/gm)) {
      if (!exports.has(m[1])) exports.set(m[1], []);
      exports.get(m[1]).push(split_top(m[2]).length);
    }
  }
  const bad = [];
  let checked = 0;
  for (const rel of ALG_FILES) {
    const text = read(...rel);
    const start = text.indexOf('## Реализация в прототипе');
    if (start < 0) continue;
    const code = [...text.slice(start).matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
    for (const line0 of code.split('\n')) {
      const line = line0.replace(/\/\/.*$/, '');
      for (const m of line.matchAll(/(?:^|[;\s])([a-z_][a-z_0-9]*)\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*(?:->|;|$)/g)) {
        if (!exports.has(m[1])) continue;
        checked += 1;
        const n = split_top(m[2]).length;
        if (!exports.get(m[1]).includes(n)) bad.push(rel[rel.length - 1] + ': ' + m[1] + ' (' + n + ' арг.) против кода ' + exports.get(m[1]).join('/'));
      }
    }
  }
  assert.ok(checked > 150, 'сверено сигнатур: ' + checked);
  assert.deepEqual(bad, []);
});

// ADV-12 — найденный дефект (низкая важность), исправлен в FP-51: замеры p50/p95 на 10 и 11 названы с датой (2026-10-09) и n = 90 из _ops/bench.json. Название теста прежнее.
test('FP-30 adv ADV-12 [ДЕФЕКТ]: замеры p50/p95 в строках «Факт на 2026-10-28» названы с датой замера и числом n (правило страницы 11: «публикуются p50 и p95 с n и датой»)', () => {
  const bench = JSON.parse(read('_ops', 'bench.json'));
  const date = bench.date;
  const n = String(bench.recompute.n);
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
  for (const name of ['10-roadmap', '11-testing-strategy']) {
    const lines = page(name).split('\n').filter((l) => l.includes('17,34'));
    assert.ok(lines.length > 0, name + ': замер не найден');
    for (const l of lines) assert.ok(l.includes(date) && has_number(l, n), name + ': в строке с замером нет даты ' + date + ' и n = ' + n);
  }
});

// ADV-13 — найденный дефект (низкая важность), исправлен в FP-51: столбец «Основные TST» на 15: FP-17 — 56, 57; FP-28 — «—». Название теста прежнее.
test('FP-30 adv ADV-13 [ДЕФЕКТ]: в карте модулей 15-prototype-guide столбец «Основные TST» строк волны 3а называет только TST, которые есть в названиях перечисленных файлов', () => {
  const text = page('15-prototype-guide');
  const rows = text.split('\n').filter((l) => /^\| `[^|]*` \(волна 3а/.test(l));
  assert.ok(rows.length >= 5, 'строк волны 3а: ' + rows.length);
  const bad = [];
  for (const l of rows) {
    const cols = l.split(' | ');
    const tests_col = cols[cols.length - 2] ?? '';
    const tst_col = (cols[cols.length - 1] ?? '').replace(/\s*\|\s*$/, '');
    const named = new Set();
    for (const m of tests_col.matchAll(/`([a-z0-9_]+)`\s*\(\d+/g)) {
      const file = path.join(HERE, m[1] + '.test.mjs');
      if (!fs.existsSync(file)) continue;
      for (const t of fs.readFileSync(file, 'utf8').matchAll(/TST-(\d\d)/g)) named.add(t[1]);
    }
    const claimed = tst_col.split(',').map((x) => x.trim()).filter((x) => /^\d\d$/.test(x));
    const extra = claimed.filter((x) => !named.has(x));
    if (extra.length > 0) bad.push(l.slice(0, 60) + ' → лишние TST: ' + extra.join(', '));
  }
  assert.deepEqual(bad, []);
});

// ADV-14 — найденный дефект (низкая важность), исправлен в FP-51: RISK-24 исправлен: UI-1 найден до волны 1 (проход 2026-10-05), UI-2…UI-6 — после неё. Название теста прежнее.
test('FP-30 adv ADV-14 [ДЕФЕКТ]: RISK-24 пишет «UI-1…UI-6 после волны 1», а UI-1 найден проходом 2026-10-05 до волны 1 (журнал вики)', () => {
  const log = read('wiki', 'log.md');
  const ui1 = /^## \[(\d{4}-\d{2}-\d{2})\] prototype \| Проверка демо в браузере[^\n]*UI-1/m.exec(log);
  const wave1 = /^## \[(\d{4}-\d{2}-\d{2})\] prototype \| Волна 1, фаза A/m.exec(log);
  assert.ok(ui1 !== null && wave1 !== null, 'записи журнала найдены');
  const risk24 = page('12-risks').split('### RISK-24')[1] ?? '';
  const fact = risk24.split('\n').find((l) => l.includes('Факт прототипа')) ?? '';
  // журнал только дописывается: запись раньше по тексту — раньше по времени
  if (log.indexOf(ui1[0]) < log.indexOf(wave1[0])) assert.ok(!/UI-1…UI-6 после волны 1/.test(fact), 'UI-1 найден ' + ui1[1] + ' до волны 1, а страница относит его к «после волны 1»');
});
