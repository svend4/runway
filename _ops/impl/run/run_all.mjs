// Сквозной прогон всех tests/**/*.test.mjs по одному файлу (один процесс node за раз). Итог — в JSON и текст.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PROTO = 'C:/xampp/htdocs/01/301/runway/prototype';
const out_json = process.argv[2];
const out_txt = process.argv[3];

function walk(dir) {
  const r = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) r.push(...walk(p));
    else if (e.name.endsWith('.test.mjs')) r.push(p);
  }
  return r;
}
const files = walk(path.join(PROTO, 'tests')).sort();
const rows = [];
const started = Date.now();
if (process.argv[4] === 'resume' && fs.existsSync(out_json)) rows.push(...JSON.parse(fs.readFileSync(out_json, 'utf8')).rows);
const done_set = new Set(rows.map((r) => r.file));
for (const f of files) {
  const rel = path.relative(PROTO, f).replace(/\\/g, '/');
  if (done_set.has(rel)) continue;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['--test', '--test-timeout=240000', '--test-concurrency=1', rel], { cwd: PROTO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const text = (r.stdout ?? '') + (r.stderr ?? '');
  const n = (k) => { const m = text.match(new RegExp('^ℹ ' + k + ' (\\d+)', 'm')); return m === null ? null : Number(m[1]); };
  const row = { file: rel, tests: n('tests'), pass: n('pass'), fail: n('fail'), skipped: n('skipped'), todo: n('todo'), ms: Date.now() - t0, status: r.status };
  if (row.fail !== 0 || row.fail === null) row.tail = text.split('\n').filter((l) => /not ok|✖|Error|expected|actual/.test(l)).slice(0, 12);
  rows.push(row);
  fs.writeFileSync(out_json, JSON.stringify({ done: rows.length, of: files.length, rows }, null, 1));
}
const sum = (k) => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
const bad = rows.filter((r) => r.fail !== 0 || r.status !== 0);
const lines = [
  `Сквозной прогон ${files.length} файлов по одному: тестов ${sum('tests')}, прошло ${sum('pass')}, упало ${sum('fail')}, пропущено ${sum('skipped')}, todo ${sum('todo')}; время ${Math.round((Date.now() - started) / 1000)} с`,
  ...bad.map((r) => `КРАСНЫЙ ${r.file}: tests=${r.tests} pass=${r.pass} fail=${r.fail} status=${r.status}\n  ` + (r.tail ?? []).join('\n  ')),
  ...rows.map((r) => `${r.file}\t${r.tests}\t${r.pass}\t${r.fail}\t${r.skipped}\t${r.todo}\t${r.ms}мс`),
];
fs.writeFileSync(out_txt, lines.join('\n') + '\n');
fs.writeFileSync(out_json, JSON.stringify({ done: rows.length, of: files.length, finished: true, rows }, null, 1));
console.log(lines[0]);
