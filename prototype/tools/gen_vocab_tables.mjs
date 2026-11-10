#!/usr/bin/env node
// gen_vocab_tables.mjs — таблицы режимов и вердиктов в вики и словарь engine/vocab.json (FP-25 и FP-47, REQ-114: «таблицы вердиктов и режимов в вики
// генерируются из vocab.json»). По умолчанию инструмент ничего не пишет в вики: он ПЕЧАТАЕТ эталонные таблицы по словарю и СВЕРЯЕТ с ними то, что стоит
// на страницах. Запись — только по явному флагу `--write` и только в размеченные блоки (см. ниже).
//   node tools/gen_vocab_tables.mjs            напечатать таблицы режимов, вердиктов, слоёв и статусов вхождений по vocab.json (для вставки вручную)
//   node tools/gen_vocab_tables.mjs --check    сверить таблицы вики с vocab.json: код выхода 1 при дрейфе (npm run lint:words)
//   node tools/gen_vocab_tables.mjs --write    обновить по vocab.json размеченные блоки таблиц в wiki/product/*.md; затем --check проходит; повторный запуск ничего не меняет
//   node tools/gen_vocab_tables.mjs --wiki <каталог wiki>   другой корень вики (для тестов)
// Размеченный блок (REQ-114, FP-47): таблица (или несколько), обёрнутая строками-комментариями
//     <!-- vocab:begin verdicts -->
//     …таблица…
//     <!-- vocab:end -->
//   имя блока — `modes` (режимы), `verdicts` (вердикты) или `layers` (слои). `--write` правит ТОЛЬКО строки блока, в которых код (`plan`, `NO`, …) принадлежит группе блока:
//   переписываются ячейки, которые даёт словарь (подпись RU, код с фазой «(v2)» у режима; у таблицы «Вердикт | Подпись» — подпись), остальные ячейки (определения, страницы-владельцы),
//   другие строки смешанной таблицы и текст вне блоков не меняются. Записи словаря, для которых в блоке нет строки, дописываются в конец таблицы с «—» в остальных ячейках.
//   Блок без таблицы, незакрытый или вложенный блок, неизвестное имя — ошибка (код выхода 1), файлы при ошибке не пишутся.
// Что считается «таблицей словаря» на странице (разбор markdown без зависимостей):
//   • глоссарий: таблица с заголовком «Термин | Код / EN | …», строка вида `| Подпись | \`ID\` | … |` (после ID допустим суффикс «(v2)»);
//   • таблица вердиктов: заголовок «Вердикт | Подпись | …», строка вида `| \`ID\` | подпись | … |`.
// Сверяется подпись RU (без учёта регистра и пробельных различий) и, для режимов, фаза: суффикс «(v2)» обязателен у режима фазы v2 и недопустим у режима v1.
// Обязательны (хотя бы одна строка в wiki/product/*.md): все режимы, вердикты и слои из словаря; статусы вхождений проверяются там, где строка есть.
// Необязательно сверяются режимы ассистента A0…A3 (`assistant_modes`: таблица «Режим | …», первая ячейка строки — `` `A2` облако, символьный ``) и уровни инструментов
// T0/T1 (`tool_tiers`: строки с одним кодом в ячейке, если такие появятся). Для этих двух групп подпись сравнивается без знаков препинания: «облако, символьный» против
// словарного «облако (символьный)» — не расхождение, а ЗАМЕТКА (`note`, код выхода не меняется); любое другое различие — расхождение, как у остальных групп.
// Таблицы в wiki/concepts и wiki/algorithms проверяются, если найдены, но не обязательны. Инструмент вне engine/: node:fs и process допустимы.
// Расчёт по введённым данным и правилам, не консультация.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROTO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RUNWAY_ROOT = path.resolve(PROTO, '..');
export const VOCAB_PATH = path.join(PROTO, 'engine', 'vocab.json');
/** Каталоги вики: обязательный (строки должны быть) и дополнительные (сверяются, если строки есть). */
export const REQUIRED_DIR = 'product';
export const EXTRA_DIRS = Object.freeze(['concepts', 'algorithms']);

const GROUPS = Object.freeze(['modes', 'verdicts', 'layers', 'occurrence_statuses']);
const REQUIRED_GROUPS = new Set(['modes', 'verdicts', 'layers']);
/** Необязательные группы (FP-25, исправление после проверки): режимы ассистента и уровни инструментов; сверяются, где строка есть, обязательными не становятся. */
export const OPTIONAL_GROUPS = Object.freeze(['assistant_modes', 'tool_tiers']);

/** Нормализация подписи для сравнения: регистр, NBSP, повторные пробелы, ё → е. */
export function norm(s) {
  return String(s).replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase().replaceAll('ё', 'е');
}

/** Мягкая нормализация (только необязательные группы): к `norm` добавлено снятие знаков `( ) , ;` — «облако, символьный» и «облако (символьный)» равны. */
export function norm_loose(s) {
  return norm(String(s).replace(/[(),;]/g, ' '));
}

/**
 * Необязательные записи словаря: режимы ассистента (`assistant_modes`) и уровни инструментов (`tool_tiers`).
 * @param {object} vocab
 * @returns {{group: string, id: string, ru: string, en: null, phase: null, required: false}[]}
 */
export function optional_entries(vocab) {
  const out = [];
  for (const group of OPTIONAL_GROUPS) {
    for (const [id, rec] of Object.entries(vocab[group] ?? {})) out.push({ group, id, ru: String(rec.ru), en: null, phase: null, required: false });
  }
  return out;
}

/**
 * Ожидаемые записи словаря: по группе — идентификатор, подпись RU/EN и (для режимов) фаза.
 * @param {object} vocab содержимое vocab.json
 * @returns {{group: string, id: string, ru: string, en: string|null, phase: string|null, required: boolean}[]}
 */
export function expected_entries(vocab) {
  const out = [];
  for (const group of GROUPS) {
    for (const [id, rec] of Object.entries(vocab[group] ?? {})) {
      out.push({ group, id, ru: String(rec.ru), en: rec.en === undefined ? null : String(rec.en), phase: group === 'modes' ? (rec.phase ?? 'v1') : null, required: REQUIRED_GROUPS.has(group) });
    }
  }
  return out;
}

const split_row = (ln) => ln.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split(/(?<!\\)\|/).map((c) => c.trim()); // «\|» внутри ячейки — не граница
const ID_CELL = /^`([A-Za-z_][A-Za-z0-9_]*)`(?:\s*\((v\d)\))?$/;
/** Первая ячейка таблицы режимов ассистента: код и подпись в одной ячейке — `` `A2` облако, символьный ``. */
const INLINE_CELL = /^`([A-Z][A-Z0-9]*)`\s+(.+)$/;

/**
 * Строки словаря на странице: из таблиц-глоссариев и таблиц вердиктов (см. шапку файла).
 * @param {string} text
 * @param {string} file
 * @returns {{file: string, line: number, id: string, label: string, phase: string|null, shape: 'glossary'|'verdicts'|'inline'}[]}
 */
export function find_vocab_rows(text, file = '<text>') {
  const lines = text.split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (!/^\s*\|/.test(lines[i])) { i++; continue; }
    let j = i;
    while (j < lines.length && /^\s*\|/.test(lines[j])) j++;
    const head = split_row(lines[i]);
    const shape = /^Термин$/i.test(head[0] ?? '') && /Код|EN/i.test(head[1] ?? '') ? 'glossary' : /^Вердикт$/i.test(head[0] ?? '') && /^Подпись$/i.test(head[1] ?? '') ? 'verdicts' : /^Режим$/i.test(head[0] ?? '') ? 'inline' : null;
    if (shape === 'inline') {
      for (let k = i + 2; k < j; k++) {
        const m = INLINE_CELL.exec(split_row(lines[k])[0] ?? '');
        if (m !== null) out.push({ file, line: k + 1, id: m[1], label: m[2].trim(), phase: null, shape });
      }
    } else if (shape !== null) {
      for (let k = i + 2; k < j; k++) {
        const cells = split_row(lines[k]);
        const idc = shape === 'glossary' ? cells[1] : cells[0];
        const m = ID_CELL.exec(idc ?? '');
        if (m === null) continue;
        out.push({ file, line: k + 1, id: m[1], label: shape === 'glossary' ? cells[0] : cells[1], phase: m[2] ?? null, shape });
      }
    }
    i = j;
  }
  return out;
}

/**
 * Эталонные таблицы по словарю (Markdown) — то, что печатает инструмент без флагов.
 * @param {object} vocab
 * @returns {string}
 */
export function render_tables(vocab) {
  const rows = expected_entries(vocab);
  const part = (group) => rows.filter((r) => r.group === group);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const out = [];
  // формы строк — те же, что понимает find_vocab_rows: «Термин | Код / EN | …» и «Вердикт | Подпись | …»
  out.push('### Режимы расчёта', '', '| Термин | Код / EN | Подпись EN | Фаза |', '|---|---|---|---|');
  for (const r of part('modes')) out.push(`| ${cap(r.ru)} | \`${r.id}\`${r.phase === 'v1' ? '' : ' (' + r.phase + ')'} | ${r.en} | ${r.phase} |`);
  out.push('', '### Вердикты Q3 (от лучшего к худшему по рангу словаря)', '', '| Вердикт | Подпись | Подпись EN | Ранг |', '|---|---|---|---|');
  const verdicts = Object.entries(vocab.verdicts ?? {}).sort((a, b) => a[1].rank - b[1].rank);
  for (const [id, rec] of verdicts) out.push(`| \`${id}\` | ${rec.ru} | ${rec.en} | ${rec.rank} |`);
  out.push('', '### Слои данных', '', '| Термин | Код / EN | Подпись EN |', '|---|---|---|');
  for (const r of part('layers')) out.push(`| ${cap(r.ru)} | \`${r.id}\` | ${r.en} |`);
  out.push('', '### Статусы вхождений', '', '| Термин | Код / EN | Подпись EN |', '|---|---|---|');
  for (const r of part('occurrence_statuses')) out.push(`| ${cap(r.ru)} | \`${r.id}\` | ${r.en} |`);
  return out.join('\n') + '\n';
}

function md_files(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort().map((n) => path.join(dir, n));
}

/**
 * Сверка: найденные на страницах строки против словаря; обязательные записи без строки в wiki/product — тоже дрейф.
 * @param {object} vocab
 * @param {{wiki?: string}} [opts] корень вики (по умолчанию `<runway>/wiki`)
 * @returns {{problems: {file: string, line: number, msg: string}[], rows: number, covered: string[]}}
 */
export function check_tables(vocab, opts = {}) {
  const wiki = opts.wiki ?? path.join(RUNWAY_ROOT, 'wiki');
  const entries = expected_entries(vocab);
  const labels = new Map(); // id → допустимые подписи RU (идентификатор `expected` есть и у режима, и у статуса)
  for (const e of [...entries, ...optional_entries(vocab)]) {
    if (!labels.has(e.id)) labels.set(e.id, []);
    labels.get(e.id).push(e);
  }
  const problems = [];
  const notes = [];
  const covered = new Set();
  let rows = 0;
  const required_dir = path.join(wiki, REQUIRED_DIR);
  for (const dir of [required_dir, ...EXTRA_DIRS.map((d) => path.join(wiki, d))]) {
    for (const f of md_files(dir)) {
      const rel = path.relative(path.dirname(wiki), f).split(path.sep).join('/');
      for (const r of find_vocab_rows(fs.readFileSync(f, 'utf8'), rel)) {
        // строки «`A2` подпись» относятся только к необязательным группам; остальные формы строк — к обязательным и статусам (так «Режим | …» с кодом вердикта не шумит)
        const cands = labels.get(r.id)?.filter((c) => (r.shape === 'inline') === OPTIONAL_GROUPS.includes(c.group));
        if (cands === undefined || cands.length === 0) continue; // `ID` из других таблиц с таким заголовком (не словарь)
        rows++;
        let hit = cands.find((c) => norm(c.ru) === norm(r.label));
        if (hit === undefined) {
          const loose = cands.find((c) => OPTIONAL_GROUPS.includes(c.group) && norm_loose(c.ru) === norm_loose(r.label));
          if (loose !== undefined) {
            notes.push({ file: rel, line: r.line, msg: `подпись «${r.label}» у \`${r.id}\` отличается от словаря «${loose.ru}» только знаками препинания` });
            hit = loose;
          }
        }
        if (hit === undefined) {
          problems.push({ file: rel, line: r.line, msg: `подпись «${r.label}» у \`${r.id}\` не совпадает со словарём (${cands.map((c) => '«' + c.ru + '»').join(' / ')})` });
          if (dir === required_dir) for (const c of cands) covered.add(c.group + ':' + r.id); // строка есть, подпись неверна: одно расхождение, а не два
          continue;
        }
        if (hit.group === 'modes') {
          const got = r.phase ?? 'v1';
          if (got !== hit.phase) problems.push({ file: rel, line: r.line, msg: `фаза режима \`${r.id}\`: в вики ${got}, в словаре ${hit.phase}` });
        }
        if (dir === required_dir) covered.add(hit.group + ':' + r.id);
      }
    }
  }
  for (const e of entries) {
    if (e.required && !covered.has(e.group + ':' + e.id)) {
      problems.push({ file: 'wiki/' + REQUIRED_DIR + '/*.md', line: 0, msg: `в таблицах нет строки для \`${e.id}\` («${e.ru}», группа ${e.group}): словарь и вики разошлись` });
    }
  }
  return { problems, notes, rows, covered: [...covered].sort() };
}

// ── размеченные блоки и запись (--write) ─────────────────────────────────────────────────────────────────────────────

/** Блоки, которые умеет обновлять `--write`: имя блока → группа словаря. Статусы вхождений и необязательные группы блоками не размечаются. */
export const BLOCK_GROUPS = Object.freeze({ modes: 'modes', verdicts: 'verdicts', layers: 'layers' });
/** Блоки, которые должны стоять в wiki/product, чтобы `--write` было что обновлять (отсутствие — заметка в `--check`, не ошибка). */
export const EXPECTED_BLOCKS = Object.freeze(['modes', 'verdicts']);
const BEGIN_RE = /^\s*<!--\s*vocab:begin\s+([A-Za-z_]+)\s*-->\s*$/;
const END_RE = /^\s*<!--\s*vocab:end(?:\s+([A-Za-z_]+))?\s*-->\s*$/;
const SEP_RE = /^\s*\|\s*:?-{3,}/;

/**
 * Размеченные блоки страницы: границы (индексы строк маркеров) и ошибки разметки.
 * @param {string[]} lines
 * @returns {{blocks: {name: string, begin: number, end: number}[], problems: {line: number, msg: string}[]}}
 */
export function find_blocks(lines) {
  const blocks = [];
  const problems = [];
  let open = null;
  lines.forEach((ln, i) => {
    const b = BEGIN_RE.exec(ln);
    const e = END_RE.exec(ln);
    if (b !== null) {
      if (open !== null) { problems.push({ line: i + 1, msg: `вложенный блок: блок «${open.name ?? '?'}» (строка ${open.begin + 1}) не закрыт` }); return; }
      if (!Object.hasOwn(BLOCK_GROUPS, b[1])) {
        problems.push({ line: i + 1, msg: `неизвестное имя блока «${b[1]}» (допустимы: ${Object.keys(BLOCK_GROUPS).join(', ')})` });
        open = { name: null, begin: i };
        return;
      }
      if (blocks.some((x) => x.name === b[1])) problems.push({ line: i + 1, msg: `блок «${b[1]}» на странице уже есть` });
      open = { name: b[1], begin: i };
    } else if (e !== null) {
      if (open === null) { problems.push({ line: i + 1, msg: 'vocab:end без vocab:begin' }); return; }
      if (e[1] !== undefined && open.name !== null && e[1] !== open.name) problems.push({ line: i + 1, msg: `vocab:end «${e[1]}» закрывает блок «${open.name}»` });
      if (open.name !== null) blocks.push({ name: open.name, begin: open.begin, end: i });
      open = null;
    }
  });
  if (open !== null) problems.push({ line: open.begin + 1, msg: `блок «${open.name ?? '?'}» не закрыт: нет vocab:end` });
  return { blocks, problems };
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const join_row = (cells) => '| ' + cells.join(' | ') + ' |';
/** Код ячейки: идентификатор в обратных кавычках, у режима не первой фазы — суффикс «(v2)». */
const code_cell = (e) => '`' + e.id + '`' + (e.group === 'modes' && e.phase !== 'v1' ? ' (' + e.phase + ')' : '');

/**
 * Новая запись таблицы блока: подпись и код по словарю, остальные ячейки — «—».
 * @param {'glossary'|'verdicts'} shape
 * @param {number} width число столбцов таблицы
 * @param {{id: string, ru: string, group: string, phase: string|null}} e
 */
function new_row(shape, width, e) {
  const cells = shape === 'glossary' ? [cap(e.ru), code_cell(e)] : ['`' + e.id + '`', e.ru];
  while (cells.length < width) cells.push('—');
  return join_row(cells);
}

/**
 * Обновить блок по словарю (см. шапку файла): строки группы переписываются в тех ячейках, которые даёт словарь, недостающие записи дописываются.
 * @param {string[]} lines строки страницы
 * @param {{name: string, begin: number, end: number}} block
 * @param {object} vocab
 * @returns {{lines: string[], changes: {line: number, id: string, kind: 'label'|'added'}[], problems: {line: number, msg: string}[]}}
 */
export function update_block(lines, block, vocab) {
  const group = BLOCK_GROUPS[block.name];
  const want = new Map(expected_entries(vocab).filter((e) => e.group === group).map((e) => [e.id, e]));
  const out = lines.slice();
  const changes = [];
  const seen = new Set();
  let last_row = -1;
  let shape = null;
  let width = 0;
  for (let i = block.begin + 1; i < block.end; i++) {
    if (!/^\s*\|/.test(out[i])) continue;
    if (i + 1 < block.end && SEP_RE.test(out[i + 1]) && !SEP_RE.test(out[i])) { // заголовок таблицы
      const head = split_row(out[i]);
      shape = /^Термин$/i.test(head[0] ?? '') && /Код|EN/i.test(head[1] ?? '') ? 'glossary' : /^Вердикт$/i.test(head[0] ?? '') && /^Подпись$/i.test(head[1] ?? '') ? 'verdicts' : null;
      width = head.length;
      i += 1; // строка-разделитель
      last_row = i;
      continue;
    }
    last_row = i;
    if (shape === null) continue;
    const cells = split_row(out[i]);
    const m = ID_CELL.exec((shape === 'glossary' ? cells[1] : cells[0]) ?? '');
    if (m === null || !want.has(m[1])) continue;
    const e = want.get(m[1]);
    seen.add(e.id);
    const next = cells.slice();
    if (shape === 'glossary') { next[0] = cap(e.ru); next[1] = code_cell(e); } else next[1] = e.ru;
    if (next.some((c, k) => c !== cells[k])) { out[i] = join_row(next); changes.push({ line: i + 1, id: e.id, kind: 'label' }); } // строка, уже равная словарю, не переписывается ни побайтно
  }
  if (shape === null) return { lines: out, changes, problems: [{ line: block.begin + 1, msg: `в блоке «${block.name}» нет таблицы «Термин | Код / EN» или «Вердикт | Подпись»` }] };
  const missing = [...want.values()].filter((e) => !seen.has(e.id));
  if (missing.length > 0) {
    out.splice(last_row + 1, 0, ...missing.map((e) => new_row(shape, width, e)));
    missing.forEach((e, k) => changes.push({ line: last_row + 2 + k, id: e.id, kind: 'added' }));
  }
  return { lines: out, changes, problems: [] };
}

/**
 * Обновить все размеченные блоки текста страницы. Переводы строк страницы (LF или CRLF) сохраняются.
 * @param {string} text
 * @param {object} vocab
 * @returns {{text: string, changes: {line: number, id: string, kind: string, block: string}[], problems: {line: number, msg: string}[], blocks: number}}
 */
export function write_blocks(text, vocab) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let lines = text.split(/\r?\n/);
  const found = find_blocks(lines);
  const problems = [...found.problems];
  const changes = [];
  // с конца к началу: вставка строк в нижнем блоке не сдвигает границы верхних
  for (const b of [...found.blocks].sort((x, y) => y.begin - x.begin)) {
    const r = update_block(lines, b, vocab);
    problems.push(...r.problems);
    lines = r.lines;
    changes.push(...r.changes.map((c) => ({ ...c, block: b.name })));
  }
  changes.sort((a, b) => a.line - b.line);
  return { text: lines.join(eol), changes, problems, blocks: found.blocks.length };
}

/**
 * `--write`: обновить размеченные блоки во всех страницах wiki/product/*.md. Ошибка разметки на любой странице — ни один файл не пишется.
 * @param {object} vocab
 * @param {{wiki?: string}} [opts]
 * @returns {{files: {file: string, blocks: number, changes: object[]}[], problems: {file: string, line: number, msg: string}[], written: string[]}}
 */
export function write_wiki(vocab, opts = {}) {
  const wiki = opts.wiki ?? path.join(RUNWAY_ROOT, 'wiki');
  const files = [];
  const problems = [];
  const pending = [];
  for (const f of md_files(path.join(wiki, REQUIRED_DIR))) {
    const rel = path.relative(path.dirname(wiki), f).split(path.sep).join('/');
    const before = fs.readFileSync(f, 'utf8');
    const r = write_blocks(before, vocab);
    for (const p of r.problems) problems.push({ file: rel, ...p });
    if (r.blocks > 0 || r.problems.length > 0) files.push({ file: rel, blocks: r.blocks, changes: r.changes });
    if (r.text !== before) pending.push({ f, rel, text: r.text });
  }
  const written = [];
  if (problems.length === 0) {
    for (const w of pending) { fs.writeFileSync(w.f, w.text); written.push(w.rel); }
  }
  return { files, problems, written };
}

/**
 * Проверка разметки блоков в вики: ошибки (незакрытый, вложенный, неизвестный блок, блок без таблицы) и заметки (в wiki/product нет блока `modes` или `verdicts`).
 * @param {object} vocab
 * @param {{wiki?: string}} [opts]
 * @returns {{problems: {file: string, line: number, msg: string}[], notes: {file: string, line: number, msg: string}[], blocks: string[]}}
 */
export function check_blocks(vocab, opts = {}) {
  const wiki = opts.wiki ?? path.join(RUNWAY_ROOT, 'wiki');
  const problems = [];
  const names = [];
  for (const f of md_files(path.join(wiki, REQUIRED_DIR))) {
    const rel = path.relative(path.dirname(wiki), f).split(path.sep).join('/');
    const text = fs.readFileSync(f, 'utf8');
    const r = write_blocks(text, vocab); // пробная запись в памяти: находит те же ошибки разметки, что и `--write`
    for (const p of r.problems) problems.push({ file: rel, ...p });
    names.push(...find_blocks(text.split(/\r?\n/)).blocks.map((b) => b.name));
  }
  const notes = EXPECTED_BLOCKS.filter((n) => !names.includes(n)).map((n) => ({ file: 'wiki/' + REQUIRED_DIR + '/*.md', line: 0, msg: `нет блока <!-- vocab:begin ${n} -->: --write эту таблицу не обновит` }));
  return { problems, notes, blocks: names };
}

function main(argv) {
  const vocab = JSON.parse(fs.readFileSync(VOCAB_PATH, 'utf8'));
  const wi = argv.indexOf('--wiki');
  const wiki = wi >= 0 ? path.resolve(argv[wi + 1]) : undefined;
  if (argv.includes('--write')) {
    const w = write_wiki(vocab, { wiki });
    for (const p of w.problems) process.stdout.write(`ERROR ${p.file}:${p.line}: ${p.msg}\n`);
    if (w.problems.length > 0) {
      process.stdout.write(`\nИтого: ${w.problems.length} ошибок разметки блоков; файлы не записаны\n`);
      return 1;
    }
    for (const f of w.files) for (const c of f.changes) process.stdout.write(`${c.kind === 'added' ? 'added  ' : 'update '}${f.file}:${c.line}: блок «${c.block}», \`${c.id}\`\n`);
    const n = w.files.reduce((x, f) => x + f.changes.length, 0);
    const blocks = w.files.reduce((x, f) => x + f.blocks, 0);
    process.stdout.write(w.written.length === 0
      ? `таблицы в ${blocks} размеченных блоках уже совпадают с engine/vocab.json: записывать нечего\n`
      : `записано файлов: ${w.written.length}, строк обновлено или добавлено: ${n} (блоков: ${blocks}); проверка: node tools/gen_vocab_tables.mjs --check\n`);
    return 0;
  }
  if (!argv.includes('--check')) {
    process.stdout.write(render_tables(vocab));
    return 0;
  }
  const r = check_tables(vocab, { wiki });
  const b = check_blocks(vocab, { wiki });
  const problems = [...r.problems, ...b.problems];
  for (const p of problems) process.stdout.write(`ERROR ${p.file}${p.line > 0 ? ':' + p.line : ''}: ${p.msg}\n`);
  for (const n of [...r.notes, ...b.notes]) process.stdout.write(`note  ${n.file}:${n.line}: ${n.msg}\n`);
  if (problems.length > 0) {
    process.stdout.write(`\nИтого: ${problems.length} расхождений таблиц с engine/vocab.json (эталон: node tools/gen_vocab_tables.mjs; размеченные блоки обновляет --write)\n`);
    return 1;
  }
  process.stdout.write(`таблицы вердиктов и режимов в вики совпадают с engine/vocab.json (строк словаря на страницах: ${r.rows})\n`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
