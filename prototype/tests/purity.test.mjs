// purity.test.mjs — TST-60 (часть): чистота engine/ и правило зависимостей модулей (design-brief §5, §14 B4, ADR-001).
//
// 1. Сканер исходников engine/*.mjs: в КОДЕ (вне комментариев и строк) не должно быть Date, Math.random, fetch, process,
//    require, node:-импортов, Intl, toLocale*, performance.now, таймеров, localStorage и Math.round(x * 100).
// 2. Импорты — только относительные `./имя.mjs|json` существующих файлов engine/; node:* и пакеты запрещены.
// 3. Граф зависимостей соответствует правилу слоёв §14 B4 и не содержит циклов.
// 4. Зависимостей пакета нет (ядро — 0 зависимостей).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE_DIR = fileURLToPath(new URL('../engine/', import.meta.url));
const PKG_DIR = fileURLToPath(new URL('../', import.meta.url));

/** Запрещённые обращения в коде engine/ (проверяются на тексте без комментариев и строк). */
const FORBIDDEN = [
  [/\bDate\b/, 'Date (системные часы/таймзоны)'],
  [/\bMath\s*\.\s*random\b/, 'Math.random'],
  [/\bfetch\b/, 'fetch'],
  [/\bprocess\b/, 'process'],
  [/\brequire\s*\(/, 'require()'],
  [/\bperformance\s*\.\s*now\b/, 'performance.now'],
  [/\b(?:setTimeout|setInterval|setImmediate|queueMicrotask)\b/, 'таймеры'],
  [/\b(?:localStorage|sessionStorage|indexedDB)\b/, 'хранилище браузера'],
  [/\bIntl\b/, 'Intl (только на границе интерфейса, ADR-001)'],
  [/\.\s*toLocale\w*\s*\(/, 'toLocale*'],
  [/\bcrypto\s*\.\s*(?:getRandomValues|randomUUID|subtle)\b/, 'crypto (случайность/хэш не из ядра)'],
  [/\bMath\s*\.\s*round\s*\(\s*[^()]*\*\s*100\b/, 'Math.round(x * 100) (деньги через float)'],
  [/\beval\b|\bnew\s+Function\b/, 'eval / new Function'],
  [/\bfs\b\s*\./, 'fs'],
];

/**
 * Убрать из исходника комментарии, строковые и regex-литералы; содержимое `${…}` в шаблонах остаётся кодом.
 * Возвращает «голый» код (длина строк сохраняется — переводы строк остаются).
 * @param {string} src
 * @returns {string}
 */
export function strip_non_code(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  /** Стек режимов: 'code' | 'tpl' (внутри шаблона) ; для `${` в шаблоне запоминаем глубину скобок. */
  const stack = [{ mode: 'code', depth: 0 }];
  let last_sig = ''; // последний значимый символ кода (для различения деления и regex)
  let last_word = '';
  const keep_nl = (ch) => (ch === '\n' ? '\n' : ' ');
  while (i < n) {
    const top = stack[stack.length - 1];
    const ch = src[i];
    const nx = src[i + 1];
    if (top.mode === 'tpl') {
      if (ch === '\\') { out += ' ' + keep_nl(src[i + 1] ?? ' '); i += 2; continue; }
      if (ch === '`') { stack.pop(); out += ' '; last_sig = '`'; i += 1; continue; }
      if (ch === '$' && nx === '{') { stack.push({ mode: 'code', depth: 0, tpl_expr: true }); out += '  '; i += 2; last_sig = '{'; continue; }
      out += keep_nl(ch); i += 1; continue;
    }
    // режим code
    if (ch === '/' && nx === '/') { while (i < n && src[i] !== '\n') { out += ' '; i += 1; } continue; }
    if (ch === '/' && nx === '*') {
      out += '  '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += keep_nl(src[i]); i += 1; }
      out += '  '; i += 2; continue;
    }
    if (ch === '\'' || ch === '"') {
      const q = ch; out += ' '; i += 1;
      while (i < n && src[i] !== q) { if (src[i] === '\\') { out += ' '; i += 1; } out += keep_nl(src[i]); i += 1; }
      out += ' '; i += 1; last_sig = q; continue;
    }
    if (ch === '`') { stack.push({ mode: 'tpl' }); out += ' '; i += 1; continue; }
    if (ch === '/') {
      const regex_ok = last_sig === '' || '(,=:[!&|?{};+-*%<>~^'.includes(last_sig) || ['return', 'typeof', 'case', 'of', 'in'].includes(last_word);
      if (regex_ok) {
        out += ' '; i += 1;
        let in_class = false;
        while (i < n && (in_class || src[i] !== '/')) {
          if (src[i] === '\\') { out += ' '; i += 1; }
          else if (src[i] === '[') in_class = true;
          else if (src[i] === ']') in_class = false;
          out += keep_nl(src[i]); i += 1;
        }
        out += ' '; i += 1;
        while (i < n && /[a-z]/.test(src[i])) { out += ' '; i += 1; } // флаги
        last_sig = '/'; last_word = ''; continue;
      }
    }
    if (ch === '{') top.depth += 1;
    if (ch === '}') {
      if (top.depth === 0 && top.tpl_expr) { stack.pop(); out += ' '; i += 1; last_sig = '}'; continue; }
      top.depth -= 1;
    }
    out += ch;
    if (!/\s/.test(ch)) {
      last_sig = ch;
      if (/[A-Za-z0-9_$]/.test(ch)) last_word = (/[A-Za-z0-9_$]/.test(src[i - 1] ?? '') ? last_word : '') + ch; else last_word = '';
    }
    i += 1;
  }
  return out;
}

/**
 * Найти запрещённые обращения в исходнике модуля.
 * @param {string} src
 * @returns {string[]} описания находок с номером строки
 */
export function scan_source(src) {
  const code = strip_non_code(src);
  const found = [];
  const lines = code.split('\n');
  lines.forEach((line, k) => {
    for (const [re, what] of FORBIDDEN) if (re.test(line)) found.push(`строка ${k + 1}: ${what}`);
  });
  return found;
}

/**
 * Относительные и прочие import-спецификаторы модуля (статические `import … from '…'`, `export … from '…'`, динамические `import('…')`).
 * @param {string} src
 * @returns {string[]}
 */
export function import_specifiers(src) {
  const specs = [];
  // комментарии убираем, строки сохраняем: нужны сами спецификаторы
  const no_comments = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1 ');
  for (const m of no_comments.matchAll(/\b(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])([^'"]+)\1/g)) specs.push(m[2]);
  for (const m of no_comments.matchAll(/(?:^|[\s;])import\s*(['"])([^'"]+)\1/g)) specs.push(m[2]);
  for (const m of no_comments.matchAll(/\bimport\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g)) specs.push(m[2]);
  return specs;
}

// ── правило слоёв §14 B4 ──────────────────────────────────────────────────────

/**
 * Ранги основной цепочки: `money ← dates ← {recurrence, hourly, fx, tax, debt, calibration} ← timeline ← sinking ← {waves, afford}
 * ← index ← {tools ← verifier, backtest}`. Модуль может импортировать только модули строго меньшего ранга.
 */
const RANK = {
  money: 0, dates: 1, recurrence: 2, hourly: 2, fx: 2, tax: 2, debt: 2, calibration: 2,
  timeline: 3, sinking: 4, waves: 5, afford: 5, index: 6, tools: 7, backtest: 7, verifier: 8,
};
/** Особые случаи: `ledger` — только money; `io` — ledger, dates, money; `montecarlo` — от timeline, sinking, afford, calibration (и ниже). */
const SPECIAL = {
  ledger: ['money'],
  io: ['ledger', 'dates', 'money'],
  montecarlo: ['money', 'dates', 'recurrence', 'hourly', 'fx', 'tax', 'debt', 'calibration', 'timeline', 'sinking', 'afford'],
  // Модули волны 1 (FP-02, FP-04, FP-07, FP-08): надстройки над ядром; на них не ссылается ни одно ядровое модуль (иначе тест выше упадёт у самого ядра).
  warnings_ext: [],
  validate_ws: ['money', 'dates', 'recurrence', 'hourly', 'tax', 'debt', 'timeline', 'ledger', 'index'],
  transfer_guard: ['money', 'dates', 'sinking'],
  installment: ['money', 'dates', 'debt'],
  liquidity: ['money', 'dates', 'fx', 'sinking', 'timeline'],
  sinking_report: ['money', 'dates', 'sinking', 'timeline'],
  tax_hooks: ['money', 'dates', 'tax', 'fx', 'sinking', 'timeline', 'ledger'],
  scenario_ext: ['money', 'dates', 'hourly', 'timeline', 'index'],
  wave_sweep: ['money', 'dates', 'timeline', 'waves'],
  // Модули волны 2 (FP-11): надстройки над ядром и montecarlo; не реэкспортируются из index.mjs, ядро на них не ссылается.
  mc_inputs: ['money', 'dates', 'recurrence', 'hourly', 'debt', 'calibration', 'timeline'],
  expected: ['money', 'dates', 'calibration', 'montecarlo'],
  band_adapter: ['money', 'dates', 'montecarlo', 'mc_inputs'],
  // Модули волны 3а (FP-14): долг в прогнозе — надстройка над debt.mjs; не реэкспортируется из index.mjs, ядро на неё не ссылается.
  debt_ext: ['money', 'dates', 'debt'],
  // Модули волны 3а (FP-17): чтение файла новее известного «только для просмотра» и сравнение версий движка — надстройка над io и ledger;
  // не реэкспортируется из index.mjs, ядро на неё не ссылается.
  io_readonly: ['money', 'ledger', 'io'],
  // FP-17 (REQ-019): значения по умолчанию — данные словаря. `vocab.generated` (генерируется из vocab.json) не импортирует ничего, `param_defaults` читает только его;
  // ядро вправе ссылаться на `param_defaults` (список `VOCAB_USERS` ниже), но не на `vocab.generated` напрямую.
  'vocab.generated': [],
  param_defaults: ['vocab.generated'],
  // Модули волны 3а-2 (FP-20): журнал вызовов ассистента (запись `assistant.call` только с хэшами, CSV) — надстройка над ledger, io и tools;
  // не реэкспортируется из index.mjs, ядро и tools/verifier на неё не ссылаются (иначе тест выше упадёт у них).
  call_log: ['money', 'ledger', 'io', 'tools'],
  // Модули волны 3а-2 (FP-28): «с какой даты рассрочка держится в буфере» — надстройка над afford и installment (сдвиг графика через move_part_date + check_purchase);
  // не реэкспортируется из index.mjs, ядро на неё не ссылается.
  installment_earliest: ['money', 'dates', 'afford', 'installment'],
  // Модули волны 3а-2 (FP-29): импорт часов из CSV (надстройка над io и hourly) и строки в чужой валюте с двумя ногами (надстройка над io, ledger и fx);
  // не реэкспортируются из index.mjs, ядро на них не ссылается.
  hours_io: ['money', 'dates', 'hourly', 'io'],
  io_fx_rows: ['money', 'dates', 'ledger', 'io', 'fx'],
};
/** Модули, которые собирают свои умолчания из словаря через `param_defaults` (FP-17, REQ-019). Остальным модулям ядра эта зависимость не нужна. */
const VOCAB_USERS = new Set(['timeline', 'calibration', 'backtest', 'debt_ext', 'fx', 'index', 'io']);
/** Кто из основной цепочки вправе импортировать `ledger` (inputs_hash, call_id, state_at). */
const MAY_IMPORT_LEDGER = new Set(['index', 'tools', 'verifier', 'backtest']);
/** `backtest` зависит от index, afford, ledger, calibration (и от нижележащих money/dates); tools/verifier ему не нужны. */
const BACKTEST_EXTRA_FORBIDDEN = new Set(['tools', 'verifier']);

/** Допустимые зависимости модуля `name` (по правилу слоёв) или `null`, если модуль вне карты. */
export function allowed_deps(name) {
  if (SPECIAL[name]) {
    const sp = new Set(SPECIAL[name]);
    if (VOCAB_USERS.has(name)) sp.add('param_defaults');
    return sp;
  }
  if (RANK[name] === undefined) return null;
  const set = new Set(Object.keys(RANK).filter((m) => RANK[m] < RANK[name]));
  if (VOCAB_USERS.has(name)) set.add('param_defaults');
  if (MAY_IMPORT_LEDGER.has(name)) set.add('ledger');
  if (name === 'backtest') for (const m of BACKTEST_EXTRA_FORBIDDEN) set.delete(m);
  return set;
}

function engine_modules() {
  return fs.readdirSync(ENGINE_DIR).filter((f) => f.endsWith('.mjs')).sort();
}

test('TST-60 в engine/ нет запрещённых API: Date, Math.random, fetch, process, require, node:*, Intl, таймеры, Math.round(x*100)', async (t) => {
  const files = engine_modules();
  assert.ok(files.length >= 4, 'в engine/ есть модули');
  for (const f of ['money.mjs', 'dates.mjs', 'recurrence.mjs', 'ledger.mjs']) assert.ok(files.includes(f), `есть ${f}`);
  for (const f of files) {
    await t.test(`engine/${f}: чистота`, () => {
      const src = fs.readFileSync(path.join(ENGINE_DIR, f), 'utf8');
      const found = scan_source(src);
      assert.deepEqual(found, [], `${f}: ${found.join('; ')}`);
    });
  }
});

test('TST-60 импорты engine/ — только относительные ./имя из engine/ (ни node:*, ни пакетов, ни URL)', async (t) => {
  for (const f of engine_modules()) {
    await t.test(`engine/${f}: импорты`, () => {
      const src = fs.readFileSync(path.join(ENGINE_DIR, f), 'utf8');
      for (const spec of import_specifiers(src)) {
        assert.ok(!spec.startsWith('node:'), `${f}: node:-импорт «${spec}»`);
        assert.match(spec, /^\.\/[A-Za-z0-9_.-]+\.(?:mjs|json)$/, `${f}: допустим только относительный импорт из engine/, получено «${spec}»`);
        assert.ok(fs.existsSync(path.join(ENGINE_DIR, spec)), `${f}: файл «${spec}» не найден`);
      }
    });
  }
});

test('TST-60 граф зависимостей engine/ соответствует правилу слоёв §14 B4 и не содержит циклов', async (t) => {
  const mods = engine_modules().map((f) => f.replace(/\.mjs$/, ''));
  const graph = new Map();
  for (const m of mods) {
    const src = fs.readFileSync(path.join(ENGINE_DIR, m + '.mjs'), 'utf8');
    const deps = [...new Set(import_specifiers(src).filter((s) => s.endsWith('.mjs')).map((s) => s.slice(2, -4)))];
    graph.set(m, deps);
  }
  for (const m of mods) {
    await t.test(`engine/${m}.mjs: зависимости по слоям`, () => {
      const allowed = allowed_deps(m);
      if (allowed === null) return; // модуль вне карты §5: проверяется только отсутствие циклов
      const bad = graph.get(m).filter((d) => !allowed.has(d));
      assert.deepEqual(bad, [], `${m} не вправе импортировать: ${bad.join(', ')} (разрешено: ${[...allowed].join(', ') || '—'})`);
    });
  }
  // циклы: DFS с цветами
  const color = new Map();
  const cycle = [];
  const visit = (m, stack) => {
    color.set(m, 1);
    for (const d of graph.get(m) ?? []) {
      if (color.get(d) === 1) { cycle.push([...stack, m, d].join(' → ')); continue; }
      if (!color.has(d)) visit(d, [...stack, m]);
    }
    color.set(m, 2);
  };
  for (const m of mods) if (!color.has(m)) visit(m, []);
  assert.deepEqual(cycle, [], 'циклы зависимостей');
  // моя зона: ledger — только money; recurrence — money и dates; dates — только money; money — ничего
  assert.deepEqual(graph.get('money'), []);
  assert.deepEqual(graph.get('dates'), ['money']);
  assert.deepEqual([...graph.get('recurrence')].sort(), ['dates', 'money']);
  assert.deepEqual(graph.get('ledger'), ['money']);
});

test('TST-60 ядро без зависимостей: в package.json нет dependencies/devDependencies/optionalDependencies, нет node_modules', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
  for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.ok(!(k in pkg) || Object.keys(pkg[k]).length === 0, `в package.json есть ${k}`);
  }
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.scripts.test, 'node --test');
  assert.ok(!fs.existsSync(path.join(PKG_DIR, 'node_modules')), 'node_modules не должно быть');
});

// ── самопроверка сканера: он обязан падать на нарушениях и не ловить комментарии/строки ─────────

test('TST-60 сканер: находит нарушения в коде', () => {
  const bad = {
    'Date.now()': 'const t = Date.now();',
    'new Date': 'const d = new Date(0);',
    'Math.random': 'const r = Math.random();',
    'Math . random с пробелами': 'const r = Math . random ();',
    fetch: 'await fetch("/x");',
    process: 'const e = process.env.X;',
    require: 'const fs = require("fs");',
    Intl: 'new Intl.NumberFormat("ru").format(1);',
    toLocale: '(5).toLocaleString();',
    'Math.round(x * 100)': 'const c = Math.round(x * 100);',
    'performance.now': 'const p = performance.now();',
    setTimeout: 'setTimeout(() => 1, 1);',
    'в шаблоне ${}': 'const s = `a ${Date.now()} b`;',
    'после regex': 'const re = /"/; const t = Date.now();',
    'после деления': 'const q = a / b / c; const t = Date.now();',
    eval: 'eval("1")',
  };
  for (const [name, src] of Object.entries(bad)) assert.ok(scan_source(src).length > 0, `не найдено: ${name}`);
});

test('TST-60 сканер: не срабатывает на комментарии, строки, regex и похожие идентификаторы', () => {
  const good = [
    '// Date.now() запрещён\nconst x = 1;',
    '/* Math.random() fetch process */ const x = 1;',
    'const s = "Date.now() и fetch";',
    "const s = 'process.env';",
    'const s = `шаблон Date.now() ${1 + 1} fetch`;',
    'const re = /Date|fetch|process/; const x = re.test("a");',
    'const IsoDate = 1; const parse_date = 2; const processed = 3; const fetch_all = 4; const to_epoch_day = 5;',
    'const a = b / c; // Date\nconst d = e / f;',
    'const x = { Date_: 1, process_event: 2 };',
    'const s = "\\" Date \\"";',
    'const t = `a ${`вложенный Date ${1}`} b`;',
  ];
  for (const src of good) assert.deepEqual(scan_source(src), [], src);
});

test('TST-60 import_specifiers: статические, реэкспорт, динамические; комментарии игнорируются', () => {
  const src = `
    import { a } from './a.mjs';
    import b from "./b.mjs";
    import * as c from './c.mjs';
    export { d } from './d.mjs';
    import './e.mjs';
    import fs from 'node:fs';
    const x = await import('./f.mjs');
    // import z from './comment.mjs';
    /* import y from './block.mjs'; */
    const s = "import q from './in_string.mjs'";
  `;
  const got = import_specifiers(src).sort();
  assert.deepEqual(got.filter((s) => !s.includes('in_string')), ['./a.mjs', './b.mjs', './c.mjs', './d.mjs', './e.mjs', './f.mjs', 'node:fs']);
});

test('TST-60 правило слоёв: allowed_deps соответствует §14 B4', () => {
  assert.deepEqual([...allowed_deps('money')], []);
  assert.deepEqual([...allowed_deps('dates')], ['money']);
  assert.deepEqual([...allowed_deps('ledger')], ['money']);
  assert.ok(!allowed_deps('timeline').has('ledger'), 'timeline не импортирует ledger');
  assert.ok(allowed_deps('timeline').has('calibration'), 'timeline ← calibration (assign_statuses)');
  assert.ok(!allowed_deps('calibration').has('timeline'), 'calibration без timeline/index');
  assert.ok(!allowed_deps('calibration').has('index'));
  assert.ok(allowed_deps('backtest').has('index') && allowed_deps('backtest').has('afford') && allowed_deps('backtest').has('ledger') && allowed_deps('backtest').has('calibration'));
  assert.ok(!allowed_deps('backtest').has('tools'));
  assert.ok(!allowed_deps('index').has('tools') && !allowed_deps('index').has('backtest'));
  assert.ok(allowed_deps('verifier').has('tools'));
  assert.ok(!allowed_deps('io').has('timeline'), 'io — ledger, dates, money (§14 B4)');
  assert.ok(allowed_deps('montecarlo').has('timeline') && allowed_deps('montecarlo').has('sinking') && allowed_deps('montecarlo').has('afford') && allowed_deps('montecarlo').has('calibration'));
  assert.ok(!allowed_deps('montecarlo').has('index'));
  assert.equal(allowed_deps('неизвестный'), null);
});

// ── vocab.json (§2.0): словарь согласован с каноном и с кодом ─────────────────────

test('TST-56 (часть) vocab.json: режимы, вердикты, слои, статусы, реестры кодов и параметры §2.0 / N5', async () => {
  const { ERROR_CODES } = await import('../engine/money.mjs');
  const { NUMBER_FORMATS } = await import('../engine/money.mjs');
  const v = JSON.parse(fs.readFileSync(path.join(ENGINE_DIR, 'vocab.json'), 'utf8'));
  assert.deepEqual(Object.keys(v.modes), ['plan', 'worse', 'expected']);
  assert.deepEqual(v.modes.worse.synonyms, ['conservative']);
  assert.equal(v.modes.expected.phase, 'v2');
  assert.deepEqual(v.verdict_order, ['OK', 'FRAGILE', 'TIGHT', 'NO'], 'ранг вердикта: OK < FRAGILE < TIGHT < NO (TST-35)');
  assert.deepEqual(v.verdict_order.map((k) => v.verdicts[k].rank), [0, 1, 2, 3]);
  assert.deepEqual(['OK', 'TIGHT', 'FRAGILE', 'NO'].map((k) => v.verdicts[k].ru), ['выдерживает', 'впритык', 'хрупко', 'не хватает']);
  assert.deepEqual(['OK', 'TIGHT', 'FRAGILE', 'NO'].map((k) => v.verdicts[k].en), ['holds', 'tight', 'fragile', 'short']);
  assert.deepEqual(Object.keys(v.layers), ['posted', 'planned', 'hypothetical']);
  assert.deepEqual(Object.keys(v.occurrence_statuses), ['expected', 'matched', 'overdue', 'skipped', 'cancelled']);
  assert.deepEqual(Object.keys(v.assistant_modes), ['A0', 'A1', 'A2', 'A3']);
  assert.deepEqual(Object.keys(v.tool_tiers), ['T0', 'T1']);
  assert.deepEqual(Object.keys(v.shortfall_metrics), ['need', 'gap_w', 'short_to_buffer']);
  // коды ошибок — те же, что в money.mjs
  assert.deepEqual(Object.keys(v.error_codes).sort(), [...ERROR_CODES].sort());
  // коды предупреждений: 16 штук, маска ^[WE]_[A-Z_]+$
  const warn = Object.keys(v.warning_codes);
  assert.equal(warn.length, 16);
  for (const c of warn) assert.match(c, new RegExp(v.warning_pattern), c);
  for (const c of ['W_OVERRIDE_STALE', 'W_WAVE_NEAR_HORIZON', 'W_DATE_CLAMPED', 'W_PART_BEYOND_HORIZON', 'W_T_CLAMPED', 'W_HOURS_NOT_CONFIRMED', 'W_NO_HISTORY',
    'W_LAG_BEYOND_HISTORY', 'W_BUFFER_UNSET', 'W_RULE_STALE', 'W_RULE_DISABLED', 'W_NO_RESERVES', 'W_RESERVE_BEHIND', 'W_RESERVE_RESIDUAL', 'W_RESERVE_OVERDUE', 'W_RATE_STALE']) {
    assert.ok(warn.includes(c), c);
    assert.ok(v.warning_codes[c].ru.length > 0 && v.warning_codes[c].en.length > 0);
  }
  // значения по умолчанию §2.0 и решение N5
  const d = (k) => v.params[k].default;
  assert.equal(d('horizon_days'), 180); assert.equal(d('buffer_hint_days'), 7); assert.equal(d('headline_mode'), 'worse');
  assert.equal(d('worse.income_delay_days'), 14); assert.equal(d('grace_days.income'), 3); assert.equal(d('grace_days.expense'), 0);
  assert.equal(d('match.window_days'), 3); assert.equal(d('match.tol_bp'), 500); assert.equal(d('wave.gap_days'), 3); assert.equal(d('wave.max_span_days'), 10);
  assert.equal(d('explain.top_k'), 10); assert.equal(d('explain.share_cutoff_bp'), 9000); assert.equal(d('stale.banner_days'), 7); assert.equal(d('stale.block_days'), 21);
  assert.equal(d('rounding'), 'half_even'); assert.equal(d('ready.q1'), 3); assert.equal(d('ready.q3'), 4); assert.equal(d('crypto.liquidity_bp'), 0);
  assert.equal(d('backup.remind_events'), 50); assert.equal(d('backup.remind_days'), 7); assert.equal(d('fx.stale_days'), 30);
  assert.equal(d('backtest.h_days'), 30); assert.equal(d('backtest.min_window_days'), 14); assert.equal(d('debt.drift_tol_bp'), 50);
  assert.equal(d('buffer_minor'), null); assert.equal(d('wave.threshold_minor'), null); assert.equal(d('decision_currency'), null);
  assert.deepEqual(['calib.window', 'calib.prior', 'calib.k', 'calib.alpha_bp', 'calib.min_origins', 'mc.n_paths', 'tools.max_calls'].map(d), [24, 7, 3, 3000, 3, 2000, 12]);
  assert.deepEqual(v.number_formats, JSON.parse(JSON.stringify(NUMBER_FORMATS)));
  // подписи не содержат запрещённых слов §10 (сами фразы живут только в forbidden_phrases)
  const labels = JSON.stringify({ ...v, forbidden_phrases: undefined }).toLowerCase();
  for (const bad of ['без галлюцинаций', 'гарантируем', 'безопасно', 'спокойно', 'только ваши']) assert.ok(!labels.includes(bad), `в словаре есть «${bad}»`);
  assert.ok(v.forbidden_phrases.includes('без галлюцинаций'));
});
