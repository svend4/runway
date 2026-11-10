#!/usr/bin/env node
// Снимки проекта для защиты от потери данных (лимиты, сбои, случайные перезаписи агентами).
//   node tools/snapshot.mjs [--label текст] [--if-changed] [--quiet]   — сделать снимок в _backups/<метка>/
//   node tools/snapshot.mjs --list                                      — показать снимки
// Политика: ручные снимки (с --label) хранятся всегда; автоснимки (папки auto_*) — последние 36.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT } from './lib.mjs';

const BACKUPS = join(ROOT, '_backups');
const KEEP_AUTO = 36;
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const quiet = flag('--quiet');
const log = (...a) => { if (!quiet) console.log(...a); };

const skip = (abs) => {
  const r = relative(ROOT, abs).split(sep);
  return r[0] === '_backups' || r.includes('node_modules') || r.includes('.git');
};

function listFiles(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (skip(p)) continue;
    const st = statSync(p);
    if (st.isDirectory()) listFiles(p, out); else out.push([relative(ROOT, p), st.size, Math.floor(st.mtimeMs)]);
  }
  return out;
}

function fingerprint(files) {
  const h = createHash('sha1');
  for (const [p, s, m] of files.sort((a, b) => a[0].localeCompare(b[0]))) h.update(`${p}|${s}|${m}\n`);
  return h.digest('hex');
}

const stamp = () => {
  const d = new Date(); const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
};

if (flag('--list')) {
  if (!existsSync(BACKUPS)) { console.log('снимков нет'); process.exit(0); }
  for (const n of readdirSync(BACKUPS).filter((x) => statSync(join(BACKUPS, x)).isDirectory()).sort()) console.log(n);
  process.exit(0);
}

if (flag('--verify')) {
  // Сравнивает рабочие файлы с последним снимком: что новее/изменено/отсутствует в копии.
  if (!existsSync(BACKUPS)) { console.log('снимков нет'); process.exit(1); }
  // «последний» — по времени создания, а не по имени (иначе auto_* всегда сортируются после ручных)
  const dirs = readdirSync(BACKUPS).filter((x) => statSync(join(BACKUPS, x)).isDirectory())
    .sort((a, b) => statSync(join(BACKUPS, a)).mtimeMs - statSync(join(BACKUPS, b)).mtimeMs);
  if (!dirs.length) { console.log('снимков нет'); process.exit(1); }
  const last = dirs[dirs.length - 1];
  const sha = (p) => createHash('sha1').update(readFileSync(p)).digest('hex');
  let same = 0; const changed = [], missing = [];
  for (const [relPath] of listFiles(ROOT)) {
    const b = join(BACKUPS, last, relPath);
    if (!existsSync(b)) { missing.push(relPath); continue; }
    if (sha(b) === sha(join(ROOT, relPath))) same++; else changed.push(relPath);
  }
  console.log(`последний снимок: ${last}\nсовпадает: ${same} · изменено после снимка: ${changed.length} · нет в снимке: ${missing.length}`);
  for (const c of changed.slice(0, 40)) console.log('  изменён  ' + c);
  for (const m of missing.slice(0, 40)) console.log('  новый    ' + m);
  process.exit(0);
}

mkdirSync(BACKUPS, { recursive: true });
const files = listFiles(ROOT);
const fp = fingerprint(files);
const fpFile = join(BACKUPS, '.last_fingerprint');
if (flag('--if-changed') && existsSync(fpFile) && readFileSync(fpFile, 'utf8') === fp) {
  log('без изменений — снимок пропущен');
  process.exit(0);
}

const label = val('--label');
const name = label ? `${stamp()}_${label.replace(/[^\p{L}\p{N}_-]+/gu, '-')}` : `auto_${stamp()}`;
const dest = join(BACKUPS, name);
// cpSync нельзя использовать: он запрещает копировать папку внутрь самой себя (_backups лежит в ROOT)
for (const [relPath] of files) {
  const to = join(dest, relPath);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(ROOT, relPath), to);
}
writeFileSync(fpFile, fp, 'utf8');
appendFileSync(join(BACKUPS, 'INDEX.txt'), `${name}\t${files.length} файлов\n`, 'utf8');
log(`снимок: _backups/${name} (${files.length} файлов)`);

// ротация только автоснимков, созданных этим инструментом
const autos = readdirSync(BACKUPS).filter((x) => x.startsWith('auto_') && statSync(join(BACKUPS, x)).isDirectory()).sort();
for (const old of autos.slice(0, Math.max(0, autos.length - KEEP_AUTO))) { rmSync(join(BACKUPS, old), { recursive: true, force: true }); log(`ротация: удалён ${old}`); }
