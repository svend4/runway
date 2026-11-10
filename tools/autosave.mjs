#!/usr/bin/env node
// Фоновое автосохранение: каждые N минут делает снимок, если файлы менялись.
//   node tools/autosave.mjs [--every 10] [--max-hours 12] [--idle-min 120]
// Остановка: создать файл _backups/STOP или завершить процесс. Сам выходит при простое/по таймеру.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib.mjs';

const args = process.argv.slice(2);
const num = (n, d) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) || d : d; };
const everyMin = num('--every', 10), maxHours = num('--max-hours', 12), idleMin = num('--idle-min', 120);
const BACKUPS = join(ROOT, '_backups');
mkdirSync(BACKUPS, { recursive: true });
const stop = join(BACKUPS, 'STOP');
if (existsSync(stop)) rmSync(stop);
const logf = join(BACKUPS, 'autosave.log');
const say = (m) => appendFileSync(logf, `${new Date().toISOString()} ${m}\n`, 'utf8');
writeFileSync(join(BACKUPS, 'autosave.pid'), String(process.pid), 'utf8');
say(`старт pid=${process.pid} every=${everyMin}m max=${maxHours}h idle=${idleMin}m`);

const started = Date.now();
let lastChange = Date.now();
const tick = () => {
  if (existsSync(stop)) { say('STOP-файл — выход'); process.exit(0); }
  if (Date.now() - started > maxHours * 3600e3) { say('лимит времени — выход'); process.exit(0); }
  if (Date.now() - lastChange > idleMin * 60e3) { say('простой — выход'); process.exit(0); }
  const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'snapshot.mjs'), '--if-changed'], { encoding: 'utf8' });
  const out = (r.stdout || '').trim();
  if (out.startsWith('снимок')) { lastChange = Date.now(); say(out); }
  if (r.status !== 0) say(`ошибка snapshot: ${(r.stderr || '').trim().slice(0, 200)}`);
};
tick();
setInterval(tick, everyMin * 60e3);
