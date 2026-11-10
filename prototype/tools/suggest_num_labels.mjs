#!/usr/bin/env node
// suggest_num_labels.mjs — предложения меток <!--num:G-001.ключ=значение--> для чисел G-001 в вики (FP-47, REQ-177). Инструмент ТОЛЬКО ПЕЧАТАЕТ: ни одного файла он не пишет
// и не правит — метку вставляет человек (или координатор) рядом с числом, а `node ../tools/lint_vocab.mjs` затем сверяет её значение с golden-выводом движка.
//   node tools/suggest_num_labels.mjs                       числа G-001 без метки в wiki/algorithms/*.md, предложения по ключам golden (до 40 строк)
//   node tools/suggest_num_labels.mjs --all                 вся вики (wiki/**/*.md)
//   node tools/suggest_num_labels.mjs --file <путь.md>      одна страница (путь от корня runway/ или абсолютный; флаг можно повторять)
//   node tools/suggest_num_labels.mjs --max N               сколько строк печатать (по умолчанию 40)
//   node tools/suggest_num_labels.mjs --json                машиночитаемый вывод
// Откуда берутся числа и ключи: те же `golden_values()` и `scan_coverage()`, что у `lint_vocab --coverage` (значения считает движок на prototype/data/g001.json, это не копии).
// У числа несколько подходящих ключей (одно значение у разных величин, например 21000 у «можно потратить» и у максимума на дату) — первым печатается ключ, чьи слова
// (plan/worse, «по плану», «если хуже», m_after, sts…) встречаются в той же строке; остальные названы «ещё». Лишних меток инструмент не придумывает: числа без ключа golden не показываются.
// Без зависимостей, Node >= 24. Вне engine/: node:fs и process допустимы. Расчёт по введённым данным и правилам, не консультация.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROOT, golden_values, scan_coverage } from '../../tools/lint_vocab.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const RUNWAY_ROOT = resolve(HERE, '..', '..');
/** Сколько строк предложений печатается по умолчанию. */
export const DEFAULT_MAX = 40;

/** Слова строки, которые указывают на ключ: последний сегмент ключа или близкая по смыслу фраза (нижний регистр). */
const HINTS = Object.freeze({
  plan: ['plan', 'по плану'],
  worse: ['worse', 'если хуже', 'консерватив'],
  m_after: ['m_after', 'после покупки', 'минимум по плану', 'минимум «если хуже»'],
  safe_to_spend: ['sts', 'можно потратить', 'safe-to-spend'],
  s_max: ['s_max', 'максимум на дату', 'максимальная сумма'],
  min_trough: ['trough', 'узкая точка', 'q1'],
  free: ['free', 'свободн'],
  opening: ['opening', 'остаток на начало'],
  end_close: ['close', 'конец горизонта'],
  need: ['need', 'потребность'],
  reserve_close: ['reserve', 'резерв'],
});

/**
 * Предложения для одного ключа golden по тексту строки: чем больше слов-подсказок ключа есть в строке, тем выше он стоит.
 * @param {string} key `G-001.…`
 * @param {string} line
 * @returns {number} число совпавших подсказок
 */
export function hint_score(key, line) {
  const low = line.toLowerCase();
  const parts = key.replace(/^G-001\./, '').split('.');
  let score = 0;
  for (const part of parts) for (const h of HINTS[part] ?? [part]) if (low.includes(h)) { score += 1; break; }
  return score;
}

/**
 * Предложения меток для текста страницы (только чтение): по каждому числу G-001 без метки — подходящие ключи и готовая метка для вставки после числа.
 * @param {string} text
 * @param {{file?: string, golden: Object<string, string>}} opts
 * @returns {{file: string, line: number, shown: string, value: string, key: string, others: string[], label: string, ambiguous: boolean}[]}
 */
export function suggest_for_text(text, opts) {
  const cov = scan_coverage(text, opts);
  return cov.missing.map((m) => {
    const ranked = m.keys.map((k) => ({ k, s: hint_score(k, m.text) })).sort((a, b) => (b.s - a.s) || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
    const key = ranked[0].k;
    return {
      file: cov.file, line: m.line, shown: m.shown, value: m.value, key, others: ranked.slice(1).map((r) => r.k),
      label: `<!--num:${key}=${m.value}-->`, ambiguous: ranked.length > 1 && ranked[0].s === ranked[1].s,
    };
  });
}

function md_in(dir) {
  const out = [];
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...md_in(p));
    else if (n.endsWith('.md')) out.push(p);
  }
  return out;
}

/**
 * Предложения по странице или каталогу вики.
 * @param {{golden: Object<string, string>, root?: string, files?: string[], all?: boolean}} opts `files` — страницы; иначе wiki/algorithms (или вся вики при `all`)
 * @returns {{pages: number, suggestions: object[]}}
 */
export function suggest_project(opts) {
  const root = opts.root ?? RUNWAY_ROOT;
  const targets = opts.files !== undefined && opts.files.length > 0
    ? opts.files.map((f) => (isAbsolute(f) ? f : join(root, f)))
    : md_in(join(root, 'wiki', opts.all === true ? '' : 'algorithms'));
  const suggestions = [];
  for (const f of targets) {
    suggestions.push(...suggest_for_text(readFileSync(f, 'utf8'), { file: relative(root, f).split(sep).join('/'), golden: opts.golden }));
  }
  return { pages: targets.length, suggestions };
}

/** Текст отчёта: строка на число, готовая метка и «ещё» — другие ключи с тем же значением. */
export function format_suggestions(r, max = DEFAULT_MAX) {
  const out = [`Предложения меток чисел G-001 (страниц: ${r.pages}); инструмент ничего не пишет — метку вставляют вручную сразу после числа`];
  for (const s of r.suggestions.slice(0, max)) {
    out.push(`${s.file}:${s.line}: ${s.shown} → ${s.label}${s.others.length > 0 ? ` (ещё: ${s.others.join(', ')}${s.ambiguous ? '; выберите по смыслу' : ''})` : ''}`);
  }
  if (r.suggestions.length > max) out.push(`… показано ${max} из ${r.suggestions.length} (--max N — больше)`);
  out.push(`\nИтого: чисел без метки — ${r.suggestions.length}. После вставки: node ../tools/lint_vocab.mjs (метка сверяется с golden-выводом) и node ../tools/lint_vocab.mjs --coverage`);
  return out.join('\n') + '\n';
}

async function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; };
  const files = argv.flatMap((a, i) => (a === '--file' ? [argv[i + 1]] : []));
  const max = Number(arg('--max'));
  const golden = await golden_values(ROOT);
  const r = suggest_project({ golden, files, all: argv.includes('--all') });
  if (argv.includes('--json')) console.log(JSON.stringify({ pages: r.pages, suggestions: r.suggestions }, null, 2));
  else process.stdout.write(format_suggestions(r, Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX));
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
