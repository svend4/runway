// Общие функции для инструментов вики. Без зависимостей, Node >= 18.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WIKI = join(ROOT, 'wiki');

export const TYPES = ['overview', 'source', 'tool', 'concept', 'product', 'algorithm', 'comparison', 'idea', 'decision', 'critique', 'adoption', 'glossary'];
export const STATUSES = ['draft', 'reviewed', 'verified'];
export const SPECIAL = new Set(['index.md', 'log.md']);

export function walk(dir, ext = '.md') {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, ext));
    else if (name.endsWith(ext)) out.push(p);
  }
  return out;
}

export const rel = (p) => relative(ROOT, p).split(sep).join('/');

// Минимальный разбор frontmatter: `key: value` в одну строку, списки `[a, b]`.
export function parsePage(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { fm: null, body: text };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      v = v.slice(1, -1).split(',').map((s) => unq(s.trim())).filter(Boolean);
    } else v = unq(v);
    fm[kv[1]] = v;
  }
  return { fm, body: m[2] };
}

function unq(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

// Ссылки markdown `[text](target)`; блоки кода и инлайн-код исключаются.
export function extractLinks(body) {
  const noCode = body.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  const links = [];
  const re = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = re.exec(noCode))) links.push({ text: m[1], target: m[2] });
  return links;
}

export const isExternal = (t) => /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('#');

export function stripAnchor(t) {
  const i = t.indexOf('#');
  return i === -1 ? t : t.slice(0, i);
}
