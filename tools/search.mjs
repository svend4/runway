#!/usr/bin/env node
// Наивный поиск по вики (TF-IDF с заголовком/summary в бонусе). Для «Query» на большом объёме.
// Использование: node tools/search.mjs "могу ли я купить" [--top 8]
import { readFileSync } from 'node:fs';
import { WIKI, SPECIAL, walk, rel, parsePage } from './lib.mjs';
import { relative, sep } from 'node:path';

const args = process.argv.slice(2);
const topIdx = args.indexOf('--top');
const top = topIdx >= 0 ? Number(args.splice(topIdx, 2)[1]) || 8 : 8;
const query = args.join(' ').trim();
if (!query) { console.error('Использование: node tools/search.mjs "запрос" [--top N]'); process.exit(2); }

const tok = (s) => (s.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || []).map(stem);
// Грубый «стемминг»: срезаем длинные окончания, чтобы «платежи/платежей/платеж» совпадали.
function stem(w) { return w.length > 6 ? w.slice(0, Math.max(5, w.length - 2)) : w; }

const docs = [];
for (const f of walk(WIKI)) {
  const p = relative(WIKI, f).split(sep).join('/');
  if (SPECIAL.has(p)) continue;
  const { fm, body } = parsePage(readFileSync(f, 'utf8'));
  const head = `${fm?.title || ''} ${fm?.summary || ''}`;
  docs.push({ p, title: fm?.title || p, body: tok(body), head: tok(head) });
}
const df = new Map();
for (const d of docs) for (const t of new Set([...d.body, ...d.head])) df.set(t, (df.get(t) || 0) + 1);
const N = docs.length;
const q = [...new Set(tok(query))];
const scored = docs.map((d) => {
  let s = 0;
  for (const t of q) {
    const tf = d.body.filter((x) => x === t).length;
    const th = d.head.filter((x) => x === t).length;
    const idf = Math.log(1 + N / (1 + (df.get(t) || 0)));
    s += (Math.log(1 + tf) + 3 * th) * idf;
  }
  return { ...d, s };
}).filter((d) => d.s > 0).sort((a, b) => b.s - a.s).slice(0, top);
for (const d of scored) console.log(`${d.s.toFixed(2).padStart(6)}  wiki/${d.p}  — ${d.title}`);
if (!scored.length) console.log('ничего не найдено');
