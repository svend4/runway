#!/usr/bin/env node
// Проверка «не уменьшая код»: сравнивает prototype/ со снимком ДО изменений.
//   node tools/additive_check.mjs <каталог-снимка> [--json]
// Ошибка (код выхода 1): пропал экспорт, пропал тест (по названию), файл исчез.
// Предупреждение: из файла исчезло много строк (>5 % и >20 строк) — стоит просмотреть.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep, resolve } from 'node:path';
import { ROOT } from './lib.mjs';

const snap = process.argv[2];
const asJson = process.argv.includes('--json');
if (!snap) { console.error('Использование: node tools/additive_check.mjs <каталог-снимка> [--json]'); process.exit(2); }
const SNAP = resolve(snap);
if (!existsSync(join(SNAP, 'prototype'))) { console.error('В снимке нет prototype/: ' + SNAP); process.exit(2); }

const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (n === 'node_modules') continue;
    statSync(p).isDirectory() ? walk(p, out) : /\.(mjs|js|html|css|json)$/.test(n) && out.push(p);
  }
  return out;
};

const EXPORT_RE = /^\s*export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST_RE = /^\s*export\s*\{([^}]*)\}/gm;
const TEST_RE = /^\s*(?:test|it)(?:\.(?:todo|skip|only))?\(\s*(['"`])([\s\S]*?)\1\s*[,)]/gm;

const exportsOf = (src) => {
  const s = new Set();
  for (const m of src.matchAll(EXPORT_RE)) s.add(m[1]);
  for (const m of src.matchAll(EXPORT_LIST_RE)) for (const part of m[1].split(',')) { const n = part.trim().split(/\s+as\s+/).pop(); if (n) s.add(n); }
  return s;
};
const testsOf = (src) => new Set([...src.matchAll(TEST_RE)].map((m) => m[2].trim()));
const linesOf = (src) => src.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

const errors = [], warns = [], stats = { files_old: 0, files_changed: 0, files_added: 0, exports_old: 0, tests_old: 0, lines_added: 0, lines_removed: 0 };
const oldFiles = walk(join(SNAP, 'prototype'));
const oldRel = new Set();
for (const f of oldFiles) {
  const rel = relative(SNAP, f).split(sep).join('/');
  if (/\/(tests\/arith\.lock\.json)$/.test(rel) || /data\/synthetic-journals/.test(rel)) { /* данные сверяем только на существование */ }
  oldRel.add(rel);
  stats.files_old++;
  const cur = join(ROOT, rel);
  if (!existsSync(cur)) { errors.push(`ФАЙЛ ИСЧЕЗ: ${rel}`); continue; }
  const a = readFileSync(f, 'utf8'), b = readFileSync(cur, 'utf8');
  if (a === b) continue;
  stats.files_changed++;
  if (/\.(mjs|js)$/.test(rel)) {
    const ea = exportsOf(a), eb = exportsOf(b);
    stats.exports_old += ea.size;
    for (const x of ea) if (!eb.has(x)) errors.push(`ЭКСПОРТ ПРОПАЛ: ${rel} :: ${x}`);
    const ta = testsOf(a), tb = testsOf(b);
    stats.tests_old += ta.size;
    // переименование (снят todo, расширена проверка) отличаем от удаления: в том же файле есть тест с тем же TST-NN
    // и заметным пересечением слов в названии (Жаккар ≥ 0.4)
    const words = (t) => new Set(t.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((w) => w.length > 2));
    const tstOf = (t) => (t.match(/TST-\d+/) || [''])[0];
    for (const x of ta) {
      if (tb.has(x)) continue;
      const wa = words(x);
      let best = 0, bestTitle = '';
      for (const y of tb) {
        if (ta.has(y) || (tstOf(x) && tstOf(y) && tstOf(x) !== tstOf(y))) continue;
        const wb = words(y); let inter = 0; for (const w of wa) if (wb.has(w)) inter++;
        const j = inter / (wa.size + wb.size - inter || 1);
        if (j > best) { best = j; bestTitle = y; }
      }
      if (best >= 0.4) { stats.tests_renamed = (stats.tests_renamed || 0) + 1; warns.push(`тест переименован (${best.toFixed(2)}): ${rel} :: ${x.slice(0, 70)} → ${bestTitle.slice(0, 70)}`); }
      else errors.push(`ТЕСТ ПРОПАЛ: ${rel} :: ${x.slice(0, 110)}`);
    }
  }
  const la = linesOf(a), lb = new Set(linesOf(b)), lbAll = linesOf(b);
  const laSet = new Set(la);
  const removed = la.filter((l) => !lb.has(l)).length;
  const added = lbAll.filter((l) => !laSet.has(l)).length;
  stats.lines_removed += removed; stats.lines_added += added;
  if (removed > 20 && removed / Math.max(1, la.length) > 0.05) warns.push(`много удалённых строк: ${rel} (−${removed} из ${la.length}, +${added})`);
}
for (const f of walk(join(ROOT, 'prototype'))) {
  const rel = relative(ROOT, f).split(sep).join('/');
  if (!oldRel.has(rel)) stats.files_added++;
}

if (asJson) console.log(JSON.stringify({ stats, errors, warns }, null, 2));
else {
  console.log(`Снимок: ${SNAP}`);
  console.log(`файлов было: ${stats.files_old} · изменено: ${stats.files_changed} · добавлено: ${stats.files_added}`);
  console.log(`экспортов в изменённых было: ${stats.exports_old} · тестов (по названию) было: ${stats.tests_old}`);
  console.log(`строк (уникальных, в изменённых): +${stats.lines_added} / −${stats.lines_removed}`);
  for (const e of errors) console.log('ERROR ' + e);
  for (const w of warns) console.log('warn  ' + w);
  console.log(errors.length ? `\nИтого: ${errors.length} ошибок — код УМЕНЬШИЛСЯ` : '\nИтого: 0 ошибок — ничего не удалено');
}
process.exit(errors.length ? 1 : 0);
