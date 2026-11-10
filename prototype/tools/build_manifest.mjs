#!/usr/bin/env node
// build_manifest.mjs — воспроизводимая сборка оболочки: манифест хэшей sha256 (REQ-154) и список файлов, которые сервис-воркер кладёт в кэш (REQ-117, REQ-120).
// «Оболочка» — всё, что страница и воркер расчёта загружают с хоста: demo/, engine/ и data/ ровно в том объёме, до которого доходит обход
// ссылок (index.html, v0.html и страницы проверки на устройстве bench.html, coldstart.html, compat.html → скрипты, стили, манифест → импорты модулей → CSS пакетов, наборы данных, воркер, иконки).
// Никаких меток времени и абсолютных путей: пути относительны prototype/, отсортированы побайтно, хэш считается по содержимому — двойная
// сборка (и сборка из другой копии каталога) даёт тот же манифест побайтно. Файлы, зависящие от хэша сборки, «штампуются» после подсчёта
// и в список `files` не входят (иначе круг): demo/build_info.mjs (страница «О программе») и demo/sw.js (имя кэша). Текст sw.js ВХОДИТ в хэш сборки без штампа
// (строка `demo/sw.js#core`; в манифесте — поле `core_sha256` записи sw.js): правка логики воркера меняет хэш и имя кэша. build_info.mjs — производный файл
// (в нём только хэш и число файлов), в хэш не входит и проверяется отдельно.
//
// Использование (из каталога prototype/):
//   node tools/build_manifest.mjs            записать demo/shell_manifest.json, demo/build_info.mjs и штамп в demo/sw.js
//   node tools/build_manifest.mjs --check    ничего не писать; код выхода 1, если записанное расходится с пересчитанным
//   node tools/build_manifest.mjs --print    напечатать хэш сборки и число файлов
//   node tools/build_manifest.mjs --root <каталог>   другая копия prototype/ (проверка воспроизводимости)
// Модуль можно импортировать: функции чистые относительно переданного корня (читают только файлы под ним).
// Инструмент вне engine/: node:fs, node:crypto и process здесь допустимы. Расчёт по введённым данным и правилам, не консультация.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Формат манифеста хэшей оболочки. */
export const SHELL_FORMAT = 'runway-shell/1';
/** Корень по умолчанию — каталог prototype/ (рядом с tools/). */
export const PROTO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Точки входа обхода: страницы, которые открывает пользователь, и сервис-воркер (его регистрирует pwa.mjs по имени файла, а не импортом). */
// FP-23: страницы замеров и самопроверки (bench, coldstart, compat) — отдельные страницы оболочки: они нужны на устройстве, где идёт проверка, в том числе без сети.
export const SEEDS = Object.freeze(['demo/index.html', 'demo/v0.html', 'demo/bench.html', 'demo/coldstart.html', 'demo/compat.html', 'demo/sw.js']);
/** Каталоги, из которых оболочка вообще может состоять (то же, что раздаёт serve.mjs). */
export const TOP_DIRS = Object.freeze(['demo', 'engine', 'data']);
export const MANIFEST_PATH = 'demo/shell_manifest.json';
export const INFO_PATH = 'demo/build_info.mjs';
export const SW_PATH = 'demo/sw.js';
/** Файлы со штампом: их содержимое зависит от хэша сборки, поэтому они вне списка `files`. */
export const STAMPED = Object.freeze([INFO_PATH, SW_PATH]);
/** Метки блока со штампом в sw.js. */
export const SW_BEGIN = '/* BUILD:BEGIN */';
export const SW_END = '/* BUILD:END */';
/** Начальное значение штампа (до первой сборки). */
export const ZERO_HASH = '0'.repeat(64);

/** sha256 (hex) байтов. */
export function sha256_hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// ── обход ссылок ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Убрать комментарии: сначала строчные (`//` в начале строки или после пробела — адреса вида `http://` не задеваются), потом блочные.
 * Порядок важен: в строчном комментарии бывает текст `../engine/` и маска `.mjs` через звёздочку, который иначе открыл бы «блочный комментарий» до первого закрывающего маркера в файле.
 */
function strip_comments(src) {
  return src.replace(/(^|\s)\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Относительные адреса из исходника модуля: импорты, динамические импорты, `new URL('…', import.meta.url)`, CSS пакетов, наборы данных. */
export function refs_of_module(src) {
  const code = strip_comments(src);
  const out = new Set();
  const modules = new Set();
  for (const m of code.matchAll(/\b(?:import|export)\s*(?:[^'"();]*?\s*from\s*)?'([^']+)'/g)) modules.add(m[1]);
  for (const m of code.matchAll(/\bimport\(\s*'([^']+)'\s*\)/g)) modules.add(m[1]);
  for (const s of modules) if (/^\.{1,2}\//.test(s)) out.add(s); // только относительные: node:* и пакетов в оболочке нет
  for (const m of code.matchAll(/new\s+URL\(\s*'([^']+)'\s*,\s*import\.meta\.url\s*\)/g)) {
    if (!m[1].endsWith('/') && !/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(m[1])) out.add(m[1]);
  }
  for (const m of code.matchAll(/\bensure_css\(\s*'(css\/[a-z0-9_-]+\.css)'\s*\)/g)) out.add(m[1]);
  for (const m of code.matchAll(/'((?:\.\.\/)+data\/[A-Za-z0-9_./-]+\.json)'/g)) out.add(m[1]);
  return [...out];
}

function refs_of_html(src) {
  const out = [];
  for (const m of src.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
    const v = m[1].split('#')[0].split('?')[0];
    if (v === '' || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(v)) continue;
    out.push(v);
  }
  return out;
}

function refs_of_css(src) {
  const out = [];
  for (const m of src.matchAll(/url\(\s*['"]?([^)'"]+)['"]?\s*\)/g)) {
    const v = m[1].trim();
    if (v !== '' && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(v)) out.push(v);
  }
  return out;
}

function refs_of_webmanifest(src) {
  let j;
  try { j = JSON.parse(src); } catch { return []; }
  const out = [];
  for (const i of Array.isArray(j?.icons) ? j.icons : []) if (typeof i?.src === 'string') out.push(i.src);
  if (typeof j?.start_url === 'string' && /\.[a-z0-9]+$/i.test(j.start_url)) out.push(j.start_url);
  return out;
}

const posix = (p) => p.split(path.sep).join('/');

/** Файл существует и написан с тем же регистром, что и на диске (на Linux различие имеет значение, на Windows — нет). */
function exact_case_exists(root, rel) {
  let cur = root;
  for (const part of rel.split('/')) {
    let names;
    try { names = fs.readdirSync(cur); } catch { return false; }
    if (!names.includes(part)) return false;
    cur = path.join(cur, part);
  }
  return fs.statSync(cur).isFile();
}

/**
 * Обойти ссылки от точек входа и вернуть файлы оболочки.
 * @param {string} [root] каталог prototype/
 * @returns {{files: string[], missing: {from: string, ref: string}[], outside: {from: string, ref: string}[]}}
 *   `files` — пути относительно prototype/ (разделитель `/`), отсортированы; `missing` — ссылки на несуществующие файлы;
 *   `outside` — ссылки за пределы demo/engine/data.
 */
export function collect_shell(root = PROTO_ROOT) {
  const seen = new Set();
  const missing = [];
  const outside = [];
  const visit = (rel, from) => {
    if (seen.has(rel)) return;
    if (!exact_case_exists(root, rel)) { missing.push({ from, ref: rel }); return; }
    seen.add(rel);
    const ext = path.posix.extname(rel).toLowerCase();
    if (!['.html', '.mjs', '.js', '.css', '.webmanifest'].includes(ext)) return;
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    const refs = ext === '.html' ? refs_of_html(src) : ext === '.css' ? refs_of_css(src) : ext === '.webmanifest' ? refs_of_webmanifest(src) : ext === '.js' ? [] : refs_of_module(src);
    for (const ref of refs) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), ref));
      if (target.startsWith('../') || !TOP_DIRS.includes(target.split('/')[0])) { outside.push({ from: rel, ref }); continue; }
      visit(target, rel);
    }
  };
  for (const s of SEEDS) visit(s, '(точка входа)');
  return { files: [...seen].sort(), missing, outside };
}

// ── сборка ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Версия движка из исходника (без запуска модуля). */
export function engine_version_of(root = PROTO_ROOT) {
  const m = /export const ENGINE_VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(root, 'engine', 'index.mjs'), 'utf8'));
  if (m === null) throw new Error('ENGINE_VERSION не найден в engine/index.mjs');
  return m[1];
}

/** Хэш сборки: sha256 от строк «путь, табуляция, sha256 файла» в порядке путей, с меткой формата. */
export function build_hash_of(files) {
  const text = SHELL_FORMAT + '\n' + files.map((f) => f.path + '\t' + f.sha256 + '\n').join('');
  return sha256_hex(Buffer.from(text, 'utf8'));
}

/** Условный путь строки «текст воркера без штампа» в исходных данных хэша сборки (не файл: на диске такого пути нет). */
export const SW_CORE_PATH = 'demo/sw.js#core';

/** sha256 текста sw.js с обнулённым штампом: не зависит от хэша сборки, но следует за любой правкой логики воркера. */
export function sw_core_sha256(sw_src) {
  return sha256_hex(Buffer.from(stamp_sw(sw_src, ZERO_HASH), 'utf8'));
}

/**
 * Хэш сборки оболочки: файлы оболочки (кроме штампованных) и, последней строкой, текст sw.js без штампа.
 * Без последней строки релиз, меняющий только воркер, получил бы прежние хэш и имя кэша (дефект ADV-03): воркер ставился бы поверх работающей версии в тот же кэш.
 */
export function build_hash_with_sw(files, core_sha256) {
  return build_hash_of([...files, { path: SW_CORE_PATH, sha256: core_sha256 }]);
}

/** Текст demo/build_info.mjs для данного хэша и числа файлов в кэше воркера. */
export function build_info_text(build_hash, cached_files) {
  return [
    '// build_info.mjs — ГЕНЕРИРУЕТСЯ tools/build_manifest.mjs, руками не править (FP-12, REQ-154).',
    '// Хэш сборки — sha256 от списка «путь + sha256 файла» оболочки (манифест — demo/shell_manifest.json); число файлов — сколько их хранит кэш воркера.',
    '// Проверить: node tools/verify.mjs. Пересобрать после любой правки demo/, engine/ или data/: node tools/build_manifest.mjs.',
    '',
    'export const BUILD = Object.freeze({',
    `  format: '${SHELL_FORMAT}',`,
    `  build_hash: '${build_hash}',`,
    `  files: ${cached_files},`,
    '});',
    '',
  ].join('\n');
}

/** Подставить хэш в блок штампа sw.js. */
export function stamp_sw(sw_src, build_hash) {
  const a = sw_src.indexOf(SW_BEGIN);
  const b = sw_src.indexOf(SW_END);
  if (a < 0 || b < a) throw new Error('в sw.js нет блока ' + SW_BEGIN + ' … ' + SW_END);
  return sw_src.slice(0, a) + SW_BEGIN + "\nconst BUILD_HASH = '" + build_hash + "';\n" + sw_src.slice(b);
}

/** Хэш, записанный в штампе sw.js (или `null`). */
export function stamp_of_sw(sw_src) {
  const m = /\/\* BUILD:BEGIN \*\/\s*const BUILD_HASH = '([0-9a-f]{64})';\s*\/\* BUILD:END \*\//.exec(sw_src);
  return m === null ? null : m[1];
}

/** Файлы, которые воркер кладёт в кэш: все хэшируемые и штампованные, кроме самого sw.js. */
export function precache_list(manifest) {
  return [...manifest.files, ...manifest.stamped.filter((f) => f.path !== SW_PATH)];
}

const entry_of = (root, rel) => {
  const buf = fs.readFileSync(path.join(root, rel));
  return { path: rel, sha256: sha256_hex(buf), bytes: buf.length };
};

/**
 * Собрать всё, что нужно записать, не трогая диск.
 * @param {string} [root]
 * @returns {{manifest: object, manifest_text: string, info_text: string, sw_text: string, collected: ReturnType<typeof collect_shell>}}
 */
export function compute_build(root = PROTO_ROOT) {
  const collected = collect_shell(root);
  if (!collected.files.includes(INFO_PATH) || !collected.files.includes(SW_PATH)) {
    throw new Error('в оболочку не вошли ' + INFO_PATH + ' или ' + SW_PATH + ': проверьте ссылки из about.mjs и pwa.mjs');
  }
  const hashed = collected.files.filter((f) => !STAMPED.includes(f)).map((f) => entry_of(root, f));
  const sw_src = fs.readFileSync(path.join(root, SW_PATH), 'utf8');
  const core_sha256 = sw_core_sha256(sw_src);
  const build_hash = build_hash_with_sw(hashed, core_sha256);
  const cached = hashed.length + 1; // + build_info.mjs; sw.js в кэш не кладётся
  const info_text = build_info_text(build_hash, cached);
  const sw_text = stamp_sw(sw_src, build_hash);
  const stamped = [
    { path: INFO_PATH, sha256: sha256_hex(Buffer.from(info_text, 'utf8')), bytes: Buffer.byteLength(info_text, 'utf8') },
    { path: SW_PATH, sha256: sha256_hex(Buffer.from(sw_text, 'utf8')), bytes: Buffer.byteLength(sw_text, 'utf8'), core_sha256 },
  ];
  const manifest = { format: SHELL_FORMAT, engine_version: engine_version_of(root), build_hash, files: hashed, stamped };
  return { manifest, manifest_text: JSON.stringify(manifest, null, 2) + '\n', info_text, sw_text, collected };
}

const read_or_null = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);

/**
 * Записать манифест, build_info.mjs и штамп sw.js (только то, что изменилось).
 * @param {string} [root]
 * @returns {{manifest: object, written: string[], collected: object}}
 */
export function write_build(root = PROTO_ROOT) {
  // build_info.mjs нужен для обхода (его импортирует about.mjs); при первой сборке файла может не быть — создаём заготовку.
  const info_abs = path.join(root, INFO_PATH);
  if (!fs.existsSync(info_abs)) fs.writeFileSync(info_abs, build_info_text(ZERO_HASH, 0), 'utf8');
  const b = compute_build(root);
  const written = [];
  for (const [rel, text] of [[INFO_PATH, b.info_text], [SW_PATH, b.sw_text], [MANIFEST_PATH, b.manifest_text]]) {
    const abs = path.join(root, rel);
    if (read_or_null(abs) !== text) { fs.writeFileSync(abs, text, 'utf8'); written.push(rel); }
  }
  return { manifest: b.manifest, written, collected: b.collected };
}

/**
 * Сравнить записанное с пересчитанным.
 * @param {string} [root]
 * @returns {{ok: boolean, problems: string[], build_hash: string}}
 */
export function check_build(root = PROTO_ROOT) {
  const problems = [];
  const b = compute_build(root);
  for (const [rel, text] of [[MANIFEST_PATH, b.manifest_text], [INFO_PATH, b.info_text], [SW_PATH, b.sw_text]]) {
    const have = read_or_null(path.join(root, rel));
    if (have === null) problems.push(rel + ': файла нет');
    else if (have !== text) problems.push(rel + ': расходится с пересчитанным (запустите node tools/build_manifest.mjs)');
  }
  for (const m of b.collected.missing) problems.push(`ссылка на несуществующий файл: ${m.ref} (из ${m.from})`);
  for (const o of b.collected.outside) problems.push(`ссылка за пределы demo/engine/data: ${o.ref} (из ${o.from})`);
  return { ok: problems.length === 0, problems, build_hash: b.manifest.build_hash };
}

// ── командная строка ─────────────────────────────────────────────────────────────────────────────────────────────────

function main(argv) {
  let root = PROTO_ROOT;
  let mode = 'write';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') mode = 'check';
    else if (argv[i] === '--print') mode = 'print';
    else if (argv[i] === '--root') root = path.resolve(argv[++i] ?? '');
    else { console.error('неизвестный ключ: ' + argv[i]); return 2; }
  }
  if (mode === 'check') {
    const r = check_build(root);
    for (const p of r.problems) console.error('ОШИБКА ' + p);
    console.log(r.ok ? 'манифест оболочки актуален, хэш сборки ' + r.build_hash : 'манифест оболочки НЕ актуален');
    return r.ok ? 0 : 1;
  }
  if (mode === 'print') {
    const b = compute_build(root);
    console.log(b.manifest.build_hash + '  файлов в манифесте: ' + b.manifest.files.length + ', в кэше воркера: ' + precache_list(b.manifest).length);
    return 0;
  }
  const r = write_build(root);
  for (const m of r.collected.missing) console.error('внимание: ссылка на несуществующий файл ' + m.ref + ' (из ' + m.from + ')');
  for (const o of r.collected.outside) console.error('внимание: ссылка за пределы demo/engine/data ' + o.ref + ' (из ' + o.from + ')');
  console.log('хэш сборки ' + r.manifest.build_hash);
  console.log('файлов в манифесте ' + r.manifest.files.length + ', в кэше воркера ' + precache_list(r.manifest).length + '; записано: ' + (r.written.length === 0 ? 'ничего (всё актуально)' : r.written.join(', ')));
  return r.collected.missing.length + r.collected.outside.length === 0 ? 0 : 1;
}

const is_main = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (is_main) process.exitCode = main(process.argv.slice(2));
