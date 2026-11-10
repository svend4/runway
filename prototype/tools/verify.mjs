#!/usr/bin/env node
// verify.mjs — проверка манифеста хэшей оболочки и фикстур формата (FP-12, REQ-154, REQ-187, REQ-186).
//   node tools/verify.mjs                      проверить каталог prototype/ против demo/shell_manifest.json (файлы, размеры, sha256, хэш сборки, штампы)
//   node tools/verify.mjs --fixtures           дополнительно: фикстуры формата tests/fixtures/FIXTURES.json (импорт даёт заявленный state_hash)
//   node tools/verify.mjs --url <адрес demo/>  сверить с тем, что отдаёт хост (читает каждый файл по сети — только по этой явной просьбе)
// Код выхода: 0 — всё сошлось; 1 — есть расхождения; 2 — неверный запуск. Инструмент вне engine/: node:fs и process здесь допустимы.
// Это проверка целостности копии, а не подпись релиза: подписанных релизов нет (REQ-154); при первой загрузке пользователь доверяет хосту.
// Расчёт по введённым данным и правилам, не консультация.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  PROTO_ROOT, SHELL_FORMAT, MANIFEST_PATH, INFO_PATH, SW_PATH, STAMPED, collect_shell, build_hash_with_sw, sw_core_sha256, build_info_text, stamp_of_sw, precache_list,
  engine_version_of, sha256_hex,
} from './build_manifest.mjs';

/**
 * Проверить каталог против манифеста.
 * @param {string} [root] каталог prototype/
 * @returns {{ok: boolean, problems: string[], checked: number, build_hash: string|null}}
 */
export function verify_local(root = PROTO_ROOT) {
  const problems = [];
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, MANIFEST_PATH), 'utf8')); } catch { return { ok: false, problems: [MANIFEST_PATH + ': не читается или не JSON'], checked: 0, build_hash: null }; }
  if (manifest.format !== SHELL_FORMAT) problems.push('формат манифеста ' + String(manifest.format) + ', ожидался ' + SHELL_FORMAT);
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.stamped)) return { ok: false, problems: [...problems, 'в манифесте нет files или stamped'], checked: 0, build_hash: null };
  let checked = 0;
  for (const f of [...manifest.files, ...manifest.stamped]) {
    let buf;
    try { buf = fs.readFileSync(path.join(root, f.path)); } catch { problems.push(f.path + ': файла нет'); continue; }
    checked += 1;
    if (buf.length !== f.bytes) problems.push(f.path + ': размер ' + buf.length + ' вместо ' + f.bytes);
    if (sha256_hex(buf) !== f.sha256) problems.push(f.path + ': sha256 не совпадает с манифестом');
  }
  // хэш сборки = файлы оболочки + текст sw.js без штампа (core_sha256 в записи sw.js); оба слагаемых пересчитываются с диска
  const sw_entry = manifest.stamped.find((f) => f.path === SW_PATH);
  const sw_on_disk = fs.existsSync(path.join(root, SW_PATH)) ? fs.readFileSync(path.join(root, SW_PATH), 'utf8') : null;
  let core_on_disk = null;
  try { core_on_disk = sw_on_disk === null ? null : sw_core_sha256(sw_on_disk); } catch { core_on_disk = null; }
  if (sw_entry === undefined || typeof sw_entry.core_sha256 !== 'string') problems.push(SW_PATH + ': в манифесте нет core_sha256 (sha256 текста воркера без штампа)');
  else {
    if (core_on_disk !== sw_entry.core_sha256) problems.push(SW_PATH + ': текст воркера без штампа не совпадает с core_sha256 манифеста (воркер правили без пересборки)');
    if (build_hash_with_sw(manifest.files, sw_entry.core_sha256) !== manifest.build_hash) problems.push('хэш сборки не пересчитывается из списка файлов и core_sha256 воркера');
  }
  const listed = new Set([...manifest.files, ...manifest.stamped].map((f) => f.path));
  const found = collect_shell(root);
  for (const p of found.files) if (!listed.has(p)) problems.push(p + ': файл оболочки (по ссылкам), которого нет в манифесте');
  for (const p of listed) if (!found.files.includes(p)) problems.push(p + ': есть в манифесте, но на него никто не ссылается');
  for (const m of found.missing) problems.push('ссылка на несуществующий файл ' + m.ref + ' (из ' + m.from + ')');
  for (const o of found.outside) problems.push('ссылка за пределы demo/engine/data ' + o.ref + ' (из ' + o.from + ')');
  const stamp = stamp_of_sw(fs.existsSync(path.join(root, SW_PATH)) ? fs.readFileSync(path.join(root, SW_PATH), 'utf8') : '');
  if (stamp !== manifest.build_hash) problems.push(SW_PATH + ': штамп сборки ' + String(stamp) + ' не равен хэшу манифеста');
  const cached = precache_list(manifest).length;
  const info = fs.existsSync(path.join(root, INFO_PATH)) ? fs.readFileSync(path.join(root, INFO_PATH), 'utf8') : '';
  if (info !== build_info_text(manifest.build_hash, cached)) problems.push(INFO_PATH + ': не соответствует манифесту (хэш или число файлов)');
  if (STAMPED.some((p) => manifest.files.some((f) => f.path === p))) problems.push('штампованные файлы не должны входить в files');
  if (manifest.engine_version !== engine_version_of(root)) problems.push('engine_version в манифесте не равен ENGINE_VERSION движка');
  return { ok: problems.length === 0, problems, checked, build_hash: manifest.build_hash };
}

/**
 * Сверить манифест с тем, что отдаёт хост: каждый файл читается через `fetch_fn` и сравнивается по размеру и sha256.
 * @param {object} manifest
 * @param {string} base_url адрес каталога prototype/ (с косой чертой на конце)
 * @param {(url: string) => Promise<{ok: boolean, status?: number, arrayBuffer: () => Promise<ArrayBuffer>}>} fetch_fn
 * @returns {Promise<{ok: boolean, problems: string[], checked: number}>}
 */
export async function verify_remote(manifest, base_url, fetch_fn) {
  const problems = [];
  let checked = 0;
  const base = base_url.endsWith('/') ? base_url : base_url + '/';
  for (const f of precache_list(manifest)) {
    let res;
    try { res = await fetch_fn(new URL(f.path, base).href); } catch { problems.push(f.path + ': хост недоступен'); continue; }
    if (!res.ok) { problems.push(f.path + ': ответ ' + String(res.status ?? 'ошибка')); continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    checked += 1;
    if (buf.length !== f.bytes || sha256_hex(buf) !== f.sha256) problems.push(f.path + ': отданный файл не совпадает с манифестом');
  }
  return { ok: problems.length === 0, problems, checked };
}

/**
 * Фикстуры формата (REQ-187): для каждой записи `FIXTURES.json` файл читается движком и даёт заявленные формат, число записей и `state_hash`.
 * @param {string} [root]
 * @param {{read_journal_json: Function, import_json: Function, state_hash: Function}} engine функции движка (передаёт вызывающий: инструмент не импортирует engine/ сам)
 * @returns {{ok: boolean, problems: string[], checked: number}}
 */
export function verify_fixtures(root, engine) {
  const problems = [];
  const decl_path = path.join(root, 'tests', 'fixtures', 'FIXTURES.json');
  let decl;
  try { decl = JSON.parse(fs.readFileSync(decl_path, 'utf8')); } catch { return { ok: false, problems: ['tests/fixtures/FIXTURES.json не читается'], checked: 0 }; }
  let checked = 0;
  for (const d of decl.fixtures ?? []) {
    try {
      const text = fs.readFileSync(path.join(root, 'tests', 'fixtures', d.file), 'utf8');
      const j = engine.read_journal_json(text);
      checked += 1;
      if (j.format !== d.format) problems.push(d.file + ': формат ' + j.format + ' вместо ' + d.format);
      if (j.events.length !== d.events) problems.push(d.file + ': записей ' + j.events.length + ' вместо ' + d.events);
      const h = engine.state_hash(engine.import_json(text));
      if (h !== d.state_hash) problems.push(d.file + ': state_hash ' + h + ' вместо заявленного ' + d.state_hash);
    } catch (e) {
      problems.push(d.file + ': не импортируется (' + String(e?.code ?? 'ошибка') + ')');
    }
  }
  if ((decl.fixtures ?? []).length === 0) problems.push('в FIXTURES.json нет ни одной фикстуры');
  return { ok: problems.length === 0, problems, checked };
}

async function main(argv) {
  let root = PROTO_ROOT;
  let fixtures = false;
  let url = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--fixtures') fixtures = true;
    else if (argv[i] === '--url') url = argv[++i] ?? null;
    else if (argv[i] === '--root') root = path.resolve(argv[++i] ?? '');
    else { console.error('неизвестный ключ: ' + argv[i]); return 2; }
  }
  let bad = 0;
  const local = verify_local(root);
  for (const p of local.problems) console.error('ОШИБКА ' + p);
  console.log(local.ok ? `оболочка: ${local.checked} файлов сошлись с манифестом, хэш сборки ${local.build_hash}` : 'оболочка: расхождения (' + local.problems.length + ')');
  if (!local.ok) bad += 1;
  if (fixtures) {
    const io = await import(pathToFileURL(path.join(root, 'engine', 'io.mjs')).href);
    const ledger = await import(pathToFileURL(path.join(root, 'engine', 'ledger.mjs')).href);
    const fx = verify_fixtures(root, { read_journal_json: io.read_journal_json, import_json: io.import_json, state_hash: ledger.state_hash });
    for (const p of fx.problems) console.error('ОШИБКА ' + p);
    console.log(fx.ok ? `фикстуры формата: ${fx.checked} импортируются с заявленным state_hash` : 'фикстуры формата: расхождения');
    if (!fx.ok) bad += 1;
  }
  if (url !== null && local.build_hash !== null) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, MANIFEST_PATH), 'utf8'));
    const rem = await verify_remote(manifest, new URL('../', url).href, (u) => fetch(u, { cache: 'no-store' }));
    for (const p of rem.problems) console.error('ОШИБКА ' + p);
    console.log(rem.ok ? `хост ${url}: ${rem.checked} файлов совпали с манифестом` : 'хост: расхождения');
    if (!rem.ok) bad += 1;
  }
  return bad === 0 ? 0 : 1;
}

const is_main = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (is_main) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
