#!/usr/bin/env node
// gen_vocab.mjs — генератор engine/vocab.generated.mjs из engine/vocab.json (FP-17, REQ-019): значения параметров по умолчанию — ДАННЫЕ словаря,
// а модули движка, интерфейс и тесты читают их из сгенерированного модуля (чистый ES-модуль без import-атрибутов: работает в браузере, Worker и Node).
// vocab.json этим инструментом НЕ меняется — только читается; единственный выход — engine/vocab.generated.mjs.
//   node tools/gen_vocab.mjs           записать engine/vocab.generated.mjs
//   node tools/gen_vocab.mjs --check   только проверить, что файл актуален (код выхода 1, если нет): npm run gen:vocab:check
// Результат детерминирован: тот же vocab.json → те же байты (порядок ключей — как в словаре, переводы строк LF, JSON.stringify для значений).
// Инструмент вне engine/: node:fs и process допустимы. Расчёт по введённым данным и правилам, не консультация.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROTO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VOCAB_PATH = path.join(PROTO, 'engine', 'vocab.json');
export const GENERATED_PATH = path.join(PROTO, 'engine', 'vocab.generated.mjs');

const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Допустимые поля записи параметра: `default` обязателен, остальное — пометки. */
const ENTRY_FIELDS = ['default', 'hypothesis', 'phase', 'note'];

/**
 * Текст сгенерированного модуля по содержимому словаря (объект, разобранный из vocab.json).
 * @param {object} vocab
 * @returns {string}
 * @throws {Error} в словаре нет `params`, у параметра нет `default` или значение не JSON-скаляр
 */
export function render_vocab_module(vocab) {
  if (!is_obj(vocab) || !is_obj(vocab.params)) throw new Error('gen_vocab: в словаре нет params');
  const lines = [];
  for (const [key, p] of Object.entries(vocab.params)) {
    if (!is_obj(p) || !Object.hasOwn(p, 'default')) throw new Error('gen_vocab: у параметра ' + key + ' нет default');
    const d = p.default;
    if (!(d === null || typeof d === 'number' || typeof d === 'string' || typeof d === 'boolean')) throw new Error('gen_vocab: значение по умолчанию ' + key + ' — не скаляр');
    const fields = ENTRY_FIELDS.filter((f) => Object.hasOwn(p, f)).map((f) => `${f}: ${JSON.stringify(p[f])}`);
    lines.push(`  ${JSON.stringify(key)}: Object.freeze({ ${fields.join(', ')} }),`);
  }
  return [
    '// vocab.generated.mjs — ГЕНЕРИРУЕТСЯ tools/gen_vocab.mjs из engine/vocab.json (FP-17, REQ-019). Руками не править: npm run gen:vocab.',
    '// Значения параметров по умолчанию — данные словаря; модули движка и интерфейс читают их отсюда, а не из литералов в коде.',
    '// Актуальность файла проверяет tests/vocab_generated.test.mjs (и `npm run gen:vocab:check`). Модуль чистый: данные без вычислений и импортов.',
    '',
    `export const VOCAB_FORMAT = ${JSON.stringify(vocab.format ?? null)};`,
    '',
    '/** Параметры рабочей области: `ключ → { default, hypothesis?, phase?, note? }` (порядок — как в vocab.json). */',
    'export const VOCAB_PARAMS = Object.freeze({',
    ...lines,
    '});',
    '',
  ].join('\n');
}

/** Прочитать vocab.json и построить текст модуля. */
export function build_from_disk() {
  return render_vocab_module(JSON.parse(fs.readFileSync(VOCAB_PATH, 'utf8')));
}

/** Сгенерированный файл на диске совпадает с тем, что даёт словарь? */
export function is_fresh() {
  let on_disk;
  try { on_disk = fs.readFileSync(GENERATED_PATH, 'utf8'); } catch { return false; }
  return on_disk === build_from_disk();
}

function main(argv) {
  const check = argv.includes('--check');
  const text = build_from_disk();
  if (check) {
    const fresh = is_fresh();
    process.stdout.write(fresh ? 'engine/vocab.generated.mjs актуален\n' : 'engine/vocab.generated.mjs устарел: запустите node tools/gen_vocab.mjs\n');
    return fresh ? 0 : 1;
  }
  fs.writeFileSync(GENERATED_PATH, text, 'utf8');
  process.stdout.write('записан engine/vocab.generated.mjs (' + Object.keys(JSON.parse(fs.readFileSync(VOCAB_PATH, 'utf8')).params).length + ' параметров)\n');
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
