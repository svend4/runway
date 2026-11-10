#!/usr/bin/env node
// Генерирует wiki/index.md из frontmatter всех страниц (каталог по категориям).
// Использование: node tools/build_index.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { WIKI, SPECIAL, walk, rel, parsePage } from './lib.mjs';
import { join, relative, sep } from 'node:path';

const GROUPS = [
  ['overview.md', 'Старт'],
  ['sources', 'Источники'],
  ['tools', 'Инструменты (сравнение)'],
  ['comparisons', 'Сравнения и выводы'],
  ['concepts', 'Понятия предметной области'],
  ['product', 'Продукт: требования, UX, архитектура'],
  ['algorithms', 'Алгоритмы (псевдокод)'],
  ['ideas', 'Идеи и замечания'],
  ['decisions', 'Решения (ADR)'],
  ['adoption', 'Что взять в другие проекты'],
];

const rows = [];
for (const f of walk(WIKI)) {
  const p = relative(WIKI, f).split(sep).join('/');
  if (SPECIAL.has(p)) continue;
  const { fm } = parsePage(readFileSync(f, 'utf8'));
  rows.push({ path: p, fm: fm || {} });
}
rows.sort((a, b) => a.path.localeCompare(b.path));

const esc = (s = '') => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const out = [];
out.push('# Индекс вики «Runway»', '');
out.push(`> Файл генерируется \`node tools/build_index.mjs\` — руками не править. Страниц: **${rows.length}**.`, '');
for (const [key, title] of GROUPS) {
  const part = rows.filter((r) => (key.endsWith('.md') ? r.path === key : r.path.startsWith(key + '/')));
  if (!part.length) continue;
  out.push(`## ${title}`, '', '| Страница | Тип | Статус | О чём |', '|---|---|---|---|');
  for (const r of part) {
    out.push(`| [${esc(r.fm.title || r.path)}](${r.path}) | ${esc(r.fm.type)} | ${esc(r.fm.status)} | ${esc(r.fm.summary)} |`);
  }
  out.push('');
}
const rest = rows.filter((r) => !GROUPS.some(([k]) => (k.endsWith('.md') ? r.path === k : r.path.startsWith(k + '/'))));
if (rest.length) {
  out.push('## Прочее', '', '| Страница | Тип | Статус | О чём |', '|---|---|---|---|');
  for (const r of rest) out.push(`| [${esc(r.fm.title || r.path)}](${r.path}) | ${esc(r.fm.type)} | ${esc(r.fm.status)} | ${esc(r.fm.summary)} |`);
  out.push('');
}
writeFileSync(join(WIKI, 'index.md'), out.join('\n'), 'utf8');
console.log(`index.md: ${rows.length} страниц`);
