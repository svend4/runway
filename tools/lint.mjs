#!/usr/bin/env node
// Детерминированный lint вики (операция Lint из схемы). Использование:
//   node tools/lint.mjs            — полный отчёт, код выхода 1 при ошибках
//   node tools/lint.mjs --json     — машиночитаемый вывод
// Проверки LLM-уровня (противоречия, устаревшие утверждения) делаются отдельно, см. CLAUDE.md §5.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ROOT, WIKI, TYPES, STATUSES, SPECIAL, walk, rel, parsePage, extractLinks, isExternal, stripAnchor } from './lib.mjs';

const asJson = process.argv.includes('--json');
const errors = [];
const warns = [];
const err = (file, msg) => errors.push({ file, msg });
const warn = (file, msg) => warns.push({ file, msg });

const files = walk(WIKI).filter((f) => !SPECIAL.has(f.slice(WIKI.length + 1).replace(/\\/g, '/')));
const pages = new Map(); // rel path -> {fm, body}
const inbound = new Map(); // rel path -> Set(rel path)
const ids = new Map(); // ID -> rel path

for (const f of files) {
  const r = rel(f);
  const { fm, body } = parsePage(readFileSync(f, 'utf8'));
  pages.set(r, { fm, body, abs: f });
  inbound.set(r, new Set());
}

const ID_DEF = /^#{1,4}\s+((?:REQ|ALG|ADR|RISK|IDEA|TST)-\d+)\b/gm;

for (const [r, { fm, body, abs }] of pages) {
  // --- frontmatter ---
  if (!fm) { err(r, 'нет frontmatter'); continue; }
  for (const k of ['title', 'type', 'status', 'summary', 'updated']) if (!fm[k]) err(r, `frontmatter: нет поля «${k}»`);
  if (fm.type && !TYPES.includes(fm.type)) err(r, `type «${fm.type}» не из списка: ${TYPES.join(', ')}`);
  if (fm.status && !STATUSES.includes(fm.status)) err(r, `status «${fm.status}» не из списка: ${STATUSES.join(', ')}`);
  if (fm.updated && !/^\d{4}-\d{2}-\d{2}$/.test(fm.updated)) err(r, `updated «${fm.updated}» не ISO-дата`);
  if (fm.summary && fm.summary.length > 220) warn(r, `summary длиннее 220 символов (${fm.summary.length})`);
  if (fm.type === 'tool' && fm.status !== 'verified') warn(r, 'страница инструмента не в статусе verified');
  if (['tool', 'source', 'comparison'].includes(fm.type) && !(Array.isArray(fm.sources) && fm.sources.length)) warn(r, 'нет sources у страницы с внешними фактами');

  // --- размер ---
  const words = body.split(/\s+/).filter(Boolean).length;
  if (words < 120) warn(r, `очень короткая страница (${words} слов)`);

  // --- ссылки ---
  const links = extractLinks(body);
  for (const { target } of links) {
    if (isExternal(target)) continue;
    const t = stripAnchor(target);
    if (!t) continue;
    const abs2 = resolve(dirname(abs), t);
    if (!existsSync(abs2)) { err(r, `битая ссылка → ${target}`); continue; }
    const r2 = rel(abs2);
    if (inbound.has(r2) && r2 !== r) inbound.get(r2).add(r);
  }

  // --- раздел «Связанные страницы» ---
  const rm = /^##\s+Связанные страницы\s*$([\s\S]*)$/m.exec(body);
  if (!rm) warn(r, 'нет раздела «Связанные страницы»');
  else if (extractLinks(rm[1]).filter((l) => !isExternal(l.target)).length < 2) warn(r, 'в «Связанные страницы» меньше 2 внутренних ссылок');

  // --- идентификаторы ---
  let m;
  ID_DEF.lastIndex = 0;
  while ((m = ID_DEF.exec(body))) {
    if (ids.has(m[1]) && ids.get(m[1]) !== r) err(r, `ID ${m[1]} уже определён в ${ids.get(m[1])}`);
    else ids.set(m[1], r);
  }
}

// Ссылки из raw/ и CLAUDE.md на вики не считаем; сироты — страницы без входящих от других страниц.
for (const [r, set] of inbound) {
  if (r === 'wiki/overview.md') continue;
  if (set.size === 0) warn(r, 'сирота: нет входящих ссылок от других страниц');
}

// Ссылки на несуществующие ID вида REQ-012 в тексте (определения должны быть заголовками).
const known = new Set(ids.keys());
for (const [r, { body }] of pages) {
  const noCode = body.replace(/```[\s\S]*?```/g, '');
  const used = new Set(noCode.match(/\b(?:REQ|ALG|ADR|RISK|IDEA|TST)-\d+\b/g) || []);
  for (const id of used) if (!known.has(id)) warn(r, `упомянут ${id}, но нигде не определён заголовком`);
}

if (asJson) {
  console.log(JSON.stringify({ pages: pages.size, errors, warns }, null, 2));
} else {
  console.log(`Страниц: ${pages.size} · ID: ${ids.size}`);
  for (const e of errors) console.log(`ERROR ${e.file}: ${e.msg}`);
  for (const w of warns) console.log(`warn  ${w.file}: ${w.msg}`);
  console.log(`\nИтого: ${errors.length} ошибок, ${warns.length} предупреждений`);
}
process.exit(errors.length ? 1 : 0);
