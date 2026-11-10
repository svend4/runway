// threat_model.test.mjs — FP-25, REQ-126 (TST-46): модель угроз версионируема и проверяется каждый релиз.
// Критерий приёмки REQ-126: в документе не менее 11 строк «угроза → смягчение → остаток»; чек-лист релиза содержит пункт пересмотра (R14);
// каждая строка со смягчением ссылается на требование. Документ — раздел «Модель угроз» страницы wiki/product/07-privacy-security.md.
// В тестах допустимы node:*.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.resolve(HERE, '..');
const RUNWAY = path.resolve(PROTO, '..');
const PAGE = path.join(RUNWAY, 'wiki', 'product', '07-privacy-security.md');
const REQS = path.join(RUNWAY, 'wiki', 'product', '02-requirements.md');
const CHECKLIST = path.join(PROTO, 'CHECKLIST-release.md');

const MIN_ROWS = 11;
const REQ_REF = /REQ-\d{3}/g;

/**
 * Строки таблицы угроз: раздел `## Модель угроз`, первая таблица в нём (до следующего заголовка).
 * @param {string} md
 * @returns {{line: number, threat: string, vector: string, mitigation: string, residual: string}[]}
 */
export function threat_rows(md) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Модель угроз\s*$/.test(l));
  if (start < 0) return [];
  const rows = [];
  let in_table = false;
  for (let i = start + 1; i < lines.length; i++) {
    const ln = lines[i];
    if (/^#{1,6}\s/.test(ln)) break; // следующий заголовок — конец раздела
    if (!/^\s*\|/.test(ln)) { if (in_table) break; continue; }
    in_table = true;
    const cells = ln.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue; // разделитель
    rows.push({ line: i + 1, threat: cells[0] ?? '', vector: cells[1] ?? '', mitigation: cells[2] ?? '', residual: cells[3] ?? '' });
  }
  return rows.slice(1); // первая строка — заголовок таблицы
}

/** Нарушения критерия REQ-126 в тексте страницы: пустая таблица, мало строк, нет ссылки на REQ в смягчении, пустой остаток. */
export function threat_problems(md) {
  const rows = threat_rows(md);
  const out = [];
  if (rows.length < MIN_ROWS) out.push(`строк в таблице угроз ${rows.length} < ${MIN_ROWS}`);
  for (const r of rows) {
    if (!(r.mitigation.match(REQ_REF) ?? []).length) out.push(`строка ${r.line} «${r.threat}»: в смягчении нет ссылки на REQ`);
    if (r.residual === '') out.push(`строка ${r.line} «${r.threat}»: не заполнен остаток (если его нет — «—»)`);
  }
  return out;
}

test('REQ-126 разбор таблицы угроз: заголовок, разделитель и конец раздела; находит строку без REQ и пустой остаток', () => {
  const ok = ['## Модель угроз', '', '| Угроза | Вектор | Митигация | Остаток |', '|---|---|---|---|', '| А | б | в (REQ-001) | — |', '', '## Дальше', '| X | Y | Z | W |'].join('\n');
  assert.deepEqual(threat_rows(ok).map((r) => r.threat), ['А']);
  assert.deepEqual(threat_problems(ok), [`строк в таблице угроз 1 < ${MIN_ROWS}`]);
  const body = (n, mit) => Array.from({ length: n }, (_, i) => `| Угроза ${i} | в | ${mit(i)} | остаток |`).join('\n');
  const page = (rows) => `## Модель угроз\n\n| Угроза | Вектор | Митигация | Остаток |\n|---|---|---|---|\n${rows}\n\n### Проверки\n`;
  assert.deepEqual(threat_problems(page(body(11, (i) => `смягчение (REQ-${100 + i})`))), [], 'ровно 11 строк со ссылками — проходит');
  assert.deepEqual(threat_problems(page(body(10, (i) => `смягчение (REQ-${100 + i})`))), [`строк в таблице угроз 10 < ${MIN_ROWS}`]);
  assert.match(threat_problems(page(body(11, (i) => (i === 4 ? 'без ссылки (C22)' : 'ссылка (REQ-154)'))))[0], /строка \d+ «Угроза 4»: в смягчении нет ссылки на REQ/);
  assert.match(threat_problems(page(body(11, () => 'ссылка (REQ-154)').replace('| остаток |', '|  |')))[0], /не заполнен остаток/);
  assert.deepEqual(threat_rows('# Нет раздела'), []);
});

test('REQ-126 таблица угроз в wiki/product/07-privacy-security.md: не менее 11 строк «угроза → смягчение → остаток», в смягчении каждой — ссылка на REQ', () => {
  const md = fs.readFileSync(PAGE, 'utf8');
  const rows = threat_rows(md);
  assert.ok(rows.length >= MIN_ROWS, `строк: ${rows.length}`);
  assert.deepEqual(threat_problems(md), []);
  // три строки, у которых ссылки не было, получили REQ-154 и REQ-134 (правка вики пакета FP-25)
  const by = (re) => rows.find((r) => re.test(r.threat));
  assert.match(by(/Подмена кода доставки/).mitigation, /REQ-154/);
  assert.match(by(/Подбор пароля/).mitigation, /REQ-134/);
  assert.match(by(/зависимост/).mitigation, /REQ-154/);
});

test('REQ-126 ссылки таблицы угроз ведут на существующие требования; темы REQ-126 (потеря устройства, XSS и расширения, файл импорта, CSV-инъекция, логи, тихая потеря данных, prompt injection) охвачены', () => {
  const reqs = fs.readFileSync(REQS, 'utf8');
  const defined = new Set([...reqs.matchAll(/^###\s+(REQ-\d{3})\b/gm)].map((m) => m[1]));
  assert.ok(defined.size >= 150, `определено требований: ${defined.size}`);
  const rows = threat_rows(fs.readFileSync(PAGE, 'utf8'));
  for (const r of rows) for (const ref of r.mitigation.match(REQ_REF) ?? []) assert.ok(defined.has(ref), `${r.threat}: ${ref} нет в 02-requirements.md`);
  const topics = [/Потеря или кража устройства/, /XSS/, /Вредоносный файл импорта/, /CSV-инъекция/, /Утечка через логи/, /Тихая потеря данных/, /Prompt injection/];
  for (const re of topics) assert.ok(rows.some((r) => re.test(r.threat)), `нет строки про ${re}`);
  assert.match(fs.readFileSync(PAGE, 'utf8'), /пересматривается в чек-листе каждого релиза \(REQ-126\)/, 'страница сама называет пересмотр в чек-листе');
});

test('REQ-126 чек-лист релиза: есть строка R14 «Пересмотр модели угроз» со ссылкой на страницу и на этот тест', () => {
  const md = fs.readFileSync(CHECKLIST, 'utf8');
  const row = md.split(/\r?\n/).find((l) => /^\|\s*R14\s*\|/.test(l));
  assert.ok(row !== undefined, 'строка R14 есть');
  assert.match(row, /Пересмотр модели угроз/);
  assert.match(row, /REQ-126/);
  assert.match(row, /07-privacy-security\.md/);
  assert.match(row, /threat_model\.test\.mjs/);
  // нумерация R1…R14 без пропусков и повторов
  const ids = md.split(/\r?\n/).map((l) => /^\|\s*R(\d+)\s*\|/.exec(l)?.[1]).filter(Boolean).map(Number);
  assert.deepEqual(ids, Array.from({ length: ids.length }, (_, i) => i + 1));
  assert.ok(ids.length >= 14);
});
