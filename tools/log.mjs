#!/usr/bin/env node
// Дописывает запись в wiki/log.md (append-only).
// Использование: node tools/log.mjs "ingest | Название" ["Описание, 1–5 строк"]
// Формат: ## [YYYY-MM-DD] op | title  — парсится grep "^## \[" wiki/log.md | tail -5
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WIKI } from './lib.mjs';

const [head, body = ''] = process.argv.slice(2);
if (!head || !/^(ingest|query|lint|build|decision|prototype)\s*\|/.test(head)) {
  console.error('Использование: node tools/log.mjs "<ingest|query|lint|build|decision|prototype> | Название" ["описание"]');
  process.exit(2);
}
const file = join(WIKI, 'log.md');
if (!existsSync(file)) writeFileSync(file, '# Журнал вики\n\n> Только добавление. Префикс `## [YYYY-MM-DD] op | title` фиксирован.\n\n', 'utf8');
const d = new Date();
const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
appendFileSync(file, `## [${date}] ${head}\n${body ? body + '\n' : ''}\n`, 'utf8');
console.log(`log.md ← [${date}] ${head}`);
