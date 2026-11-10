// check_script.test.mjs — FP-25, REQ-114 / REQ-177 / REQ-178: гейты слов, обещаний и сборки собраны в команды и подключены к pre-commit.
// Покрывает: scripts в prototype/package.json (lint, lint:vocab, lint:tables, lint:words, check) — состав, порядок, `&&` (первая ошибка останавливает цепочку), файлы существуют,
// зависимостей нет; pre-commit хук .githooks/pre-commit (запускает lint:words, настроек git и файлов не трогает); файла конфигурации CI нет (ждёт решения о хостинге, FP-40);
// каждый ключ showcase.cl_* есть в реестре обещаний demo/promises.json и наоборот. В тестах допустимы node:*.
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
const PKG = JSON.parse(fs.readFileSync(path.join(PROTO, 'package.json'), 'utf8'));
const HOOK_PATH = path.join(RUNWAY, '.githooks', 'pre-commit');

/**
 * Развернуть npm-скрипт в плоский список шагов (`node …`): `npm run X` подставляется рекурсивно; допускается только оператор `&&`.
 * @param {string} name
 * @param {string[]} [seen]
 * @returns {string[]}
 */
function steps_of(name, seen = []) {
  assert.ok(Object.hasOwn(PKG.scripts, name), `скрипт ${name} определён`);
  assert.ok(!seen.includes(name), `цикл скриптов: ${[...seen, name].join(' → ')}`);
  const cmd = PKG.scripts[name];
  assert.ok(!/\|\||;|\|(?!\|)|`|\$\(/.test(cmd), `${name}: только «&&» — иначе ошибка шага может быть проглочена: ${cmd}`);
  return cmd.split('&&').map((s) => s.trim()).flatMap((part) => {
    const m = /^npm run (\S+)$/.exec(part);
    return m ? steps_of(m[1], [...seen, name]) : [part];
  });
}

test('REQ-177 REQ-178 npm run check: lint, lint_vocab (с --registry demo/promises.json), сверка таблиц словаря, build:check, verify, contrast — по порядку, через «&&»', () => {
  const steps = steps_of('check');
  assert.deepEqual(steps, [
    'node ../tools/lint.mjs',
    'node ../tools/lint_vocab.mjs --registry demo/promises.json',
    'node tools/gen_vocab_tables.mjs --check',
    'node tools/build_manifest.mjs --check',
    'node tools/verify.mjs --fixtures',
    'node tools/contrast.mjs',
  ]);
  // файлы шагов существуют (путь — от prototype/, где npm запускает скрипты)
  for (const s of steps) {
    const file = /^node (\S+)/.exec(s)[1];
    assert.ok(fs.existsSync(path.resolve(PROTO, file)), `${s}: файл ${file} есть`);
  }
  assert.ok(fs.existsSync(path.resolve(PROTO, 'demo', 'promises.json')), 'реестр обещаний на месте');
  // прежние скрипты не потеряны
  for (const k of ['test', 'build', 'build:check', 'gen:vocab', 'gen:vocab:check', 'verify', 'contrast', 'bench', 'mutate', 'fuzz', 'oracle:hledger', 'typecheck']) assert.ok(Object.hasOwn(PKG.scripts, k), `скрипт ${k} сохранён`);
});

test('REQ-114 npm run lint:words = lint_vocab (с реестром обещаний) + gen_vocab_tables --check; lint:vocab и lint:tables — по отдельности', () => {
  assert.deepEqual(steps_of('lint:words'), ['node ../tools/lint_vocab.mjs --registry demo/promises.json', 'node tools/gen_vocab_tables.mjs --check']);
  assert.deepEqual(steps_of('lint:vocab'), ['node ../tools/lint_vocab.mjs --registry demo/promises.json']);
  assert.deepEqual(steps_of('lint:tables'), ['node tools/gen_vocab_tables.mjs --check']);
  assert.deepEqual(steps_of('lint'), ['node ../tools/lint.mjs']);
});

test('REQ-177 пакет без зависимостей и без скриптов-ловушек: нет dependencies, devDependencies, preinstall/postinstall/prepare', () => {
  for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) assert.ok(!(k in PKG) || Object.keys(PKG[k]).length === 0, k);
  for (const k of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish']) assert.ok(!Object.hasOwn(PKG.scripts, k), `скрипт ${k} не нужен`);
  assert.equal(PKG.type, 'module');
});

test('REQ-178 «падает при ошибке»: команда lint_vocab из check/lint:words завершается кодом 1 на реестре с гипотезой в интерфейсе и на запрещённой фразе во временном каталоге, код 0 на настоящем реестре', () => {
  const run = (args, cwd = PROTO) => spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 100000 });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chk_'));
  try {
    const bad = path.join(tmp, 'bad.json');
    const reg = JSON.parse(fs.readFileSync(path.join(PROTO, 'demo', 'promises.json'), 'utf8'));
    fs.writeFileSync(bad, JSON.stringify([...reg, { id: 'speed', kind: 'promise', text_key: 'showcase.cl_speed', level: 'hypothesis', surface: 'ui', checked_on: '2026-10-23', test: { file: 'tests/g001.test.mjs', id: 'TST-01' } }]));
    const r = run(['../tools/lint_vocab.mjs', '--registry', bad, '--today', '2026-10-23']);
    assert.equal(r.status, 1, r.stdout.slice(-400));
    assert.match(r.stdout, /ERROR registry:\d+: \[promise-hypothesis-in-ui\]/);
    const dir = path.join(tmp, 'ui');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'x.html'), '<p>Мы гарантируем точность. Всегда офлайн.</p>\n');
    const r2 = run(['../tools/lint_vocab.mjs', '--registry', 'demo/promises.json', '--dir', dir, '--today', '2026-10-23']);
    assert.equal(r2.status, 1);
    assert.match(r2.stdout, /ERROR .*x\.html:1: \[(?:we-guarantee|always-offline|forbidden:[^\]]+)\]/);
    const ok = run(['../tools/lint_vocab.mjs', '--registry', 'demo/promises.json', '--today', '2026-10-23']);
    assert.equal(ok.status, 0, ok.stdout.slice(-600));
    assert.match(ok.stdout, /Итого: 0 ошибок, 0 предупреждений/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('REQ-114 pre-commit хук .githooks/pre-commit: sh-скрипт с LF, запускает lint:words (с запасным путём через node), не трогает git config и файлы', () => {
  const text = fs.readFileSync(HOOK_PATH, 'utf8');
  assert.ok(text.startsWith('#!/bin/sh\n'), 'shebang sh');
  assert.ok(!text.includes('\r'), 'только LF: иначе sh на Linux/macOS не запустит хук');
  assert.match(text, /npm run --silent lint:words/);
  // запасной путь без npm — те же шаги, что у lint:words
  const fallback = /node \.\.\/tools\/lint_vocab\.mjs --registry demo\/promises\.json && node tools\/gen_vocab_tables\.mjs --check/.exec(text);
  assert.ok(fallback !== null, 'запасной путь через node');
  assert.equal(fallback[0], steps_of('lint:words').join(' && '), 'хук и npm-скрипт запускают одно и то же');
  assert.match(text, /cd "\$RUNWAY_DIR\/prototype"/);
  // хук только читает: никаких записей и правок git
  const body = text.replace(/^\s*#.*$/gm, '').replace(/\d?>\s*\/dev\/null/g, '').replace(/\d?>&\d/g, '');
  assert.doesNotMatch(body, /git\s+(?:config|add|stash|checkout|reset|apply|rm|mv)|sed\s+-i|\bchmod\b|\brm\s|\bmv\s|\btee\b/);
  assert.doesNotMatch(body, />/, 'перенаправлений в файлы нет (кроме /dev/null и >&2)');
  assert.match(text, /exit "\$status"/, 'код выхода проверки возвращается git — коммит останавливается');
  assert.match(text, /RUNWAY_HOOK_SKIP/);
  if (process.platform !== 'win32') assert.ok((fs.statSync(HOOK_PATH).mode & 0o111) !== 0, 'хук исполняемый');
  // инструкция по подключению — в README прототипа и в самом хуке
  const readme = fs.readFileSync(path.join(PROTO, 'README.md'), 'utf8');
  assert.match(readme, /core\.hooksPath/);
  assert.match(readme, /\.githooks\/pre-commit/);
  assert.match(text, /core\.hooksPath/);
});

test('FP-25 файла конфигурации CI нет (ждёт решения о хостинге, FP-40): ни GitHub Actions, ни GitLab, ни Azure, ни CircleCI, ни Jenkins в runway/', () => {
  const names = ['.github', '.gitlab-ci.yml', 'azure-pipelines.yml', '.circleci', 'Jenkinsfile', '.travis.yml', 'bitbucket-pipelines.yml', 'appveyor.yml', '.drone.yml', 'buildkite.yml', '.buildkite', 'cloudbuild.yaml'];
  for (const dir of [RUNWAY, PROTO]) for (const n of names) assert.ok(!fs.existsSync(path.join(dir, n)), `${path.relative(RUNWAY, path.join(dir, n)) || n}: файл CI не создаётся`);
});

test('REQ-178 каждый ключ showcase.cl_* есть в реестре обещаний, и каждая запись реестра ссылается на существующий ключ', async () => {
  const cat = (await import(pathToFileURL(path.join(PROTO, 'demo', 'i18n', 'showcase.mjs')).href)).default;
  const keys = Object.keys(cat.ru).filter((k) => k.startsWith('showcase.cl_')).sort();
  const reg = JSON.parse(fs.readFileSync(path.join(PROTO, 'demo', 'promises.json'), 'utf8'));
  const reg_keys = reg.map((r) => r.text_key).sort();
  assert.ok(keys.length >= 20, `ключей showcase.cl_*: ${keys.length}`);
  assert.deepEqual(keys, reg_keys, 'ключи каталога и реестра совпадают');
  for (const k of keys) assert.ok(typeof cat.en[k] === 'string' && cat.en[k] !== '', `${k}: есть EN`);
  for (const r of reg) assert.ok(r.test && fs.existsSync(path.join(PROTO, r.test.file)), `${r.id}: тест ${r.test?.file} существует`);
});

// ── FP-47, REQ-178: ворота перед релизом ─────────────────────────────────────────────────────────────────────────────

test('REQ-178 FP-47 npm run build:gate = lint:words (слова + таблицы словаря) и затем build_manifest --check; npm run build остаётся сборкой манифеста без линтера слов', () => {
  assert.deepEqual(steps_of('build:gate'), [
    'node ../tools/lint_vocab.mjs --registry demo/promises.json',
    'node tools/gen_vocab_tables.mjs --check',
    'node tools/build_manifest.mjs --check',
  ]);
  assert.equal(PKG.scripts['build:gate'], 'npm run lint:words && node tools/build_manifest.mjs --check', 'слова раньше манифеста, обе части через «&&»');
  // манифест-дисциплина не менялась: build — только сборка манифеста, build:check — сверка
  assert.equal(PKG.scripts.build, 'node tools/build_manifest.mjs');
  assert.equal(PKG.scripts['build:check'], 'node tools/build_manifest.mjs --check');
  assert.deepEqual(steps_of('build'), ['node tools/build_manifest.mjs']);
  // build:gate — подмножество check в том же порядке (lint вики и verify/contrast в ворота не входят)
  const check = steps_of('check');
  const gate = steps_of('build:gate');
  let at = -1;
  for (const s of gate) { const i = check.indexOf(s, at + 1); assert.ok(i > at, `шаг ворот есть в check по порядку: ${s}`); at = i; }
  for (const s of steps_of('build:gate')) assert.ok(fs.existsSync(path.resolve(PROTO, /^node (\S+)/.exec(s)[1])), `${s}: файл есть`);
});

test('REQ-178 FP-47 «падает при ошибке»: первая часть ворот (слова) останавливает цепочку — вторая не запускается; хук pre-commit и CI не менялись', () => {
  const cmd = PKG.scripts['build:gate'];
  assert.ok(!/\|\||;|\|(?!\|)/.test(cmd), 'только «&&»: ошибка слов не проглатывается');
  assert.ok(cmd.indexOf('lint:words') < cmd.indexOf('build_manifest'), 'слова проверяются до манифеста');
  // хук по-прежнему запускает только lint:words (build:gate в него не вошёл)
  const hook = fs.readFileSync(HOOK_PATH, 'utf8');
  assert.ok(!hook.includes('build:gate') && !hook.includes('build_manifest'), 'pre-commit не менялся');
  // команда слов из ворот падает на запрещённой фразе (временный каталог) — значит и ворота упадут; манифест при этом не запускается
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate_'));
  try {
    const dir = path.join(tmp, 'ui');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'x.html'), '<p>Мы гарантируем точность.</p>\n');
    const first = steps_of('lint:words')[0].replace(/^node /, '').split(' ');
    const r = spawnSync(process.execPath, [...first, '--dir', dir, '--today', '2026-10-24'], { cwd: PROTO, encoding: 'utf8', timeout: 100000 });
    assert.equal(r.status, 1, r.stdout.slice(-300));
    // шаги разделены «&&»: при коде 1 первой части оболочка вторую часть не запускает (проверяем настоящей оболочкой на безопасных заменах)
    const probe = spawnSync(process.execPath, ['-e', 'process.exit(1)'], { encoding: 'utf8' });
    assert.equal(probe.status, 1);
    const chain = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', process.platform === 'win32' ? ['/c', 'exit 1 && echo SECOND'] : ['-c', 'exit 1 && echo SECOND'], { encoding: 'utf8' });
    assert.equal(chain.status, 1);
    assert.ok(!chain.stdout.includes('SECOND'), 'после ошибки первой части вторая не запускается');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('REQ-178 FP-47 документы: «перед релизом npm run build:gate» есть в README прототипа и в CHECKLIST-release.md (строка R4a), оба называют, что npm run build слов не проверяет', () => {
  const readme = fs.readFileSync(path.join(PROTO, 'README.md'), 'utf8');
  const list = fs.readFileSync(path.join(PROTO, 'CHECKLIST-release.md'), 'utf8');
  assert.match(readme, /перед релизом `npm run build:gate`/);
  assert.match(list, /перед релизом `npm run build:gate`/);
  const row = list.split('\n').find((l) => l.startsWith('| R4a '));
  assert.ok(row !== undefined, 'строка R4a в списке выпуска');
  assert.match(row, /`npm run build` слов не проверяет/);
  assert.match(readme, /`npm run build` остаётся сборкой манифеста и слов не проверяет/);
  // порядок строк выпуска не нарушен: R4, R4a, R5
  const ids = list.split('\n').filter((l) => /^\| R\d+a? /.test(l)).map((l) => /^\| (R\d+a?) /.exec(l)[1]);
  assert.deepEqual(ids.slice(ids.indexOf('R4'), ids.indexOf('R4') + 3), ['R4', 'R4a', 'R5']);
});
