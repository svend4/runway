// fp25_adv.test.mjs — независимая (состязательная) проверка пакета FP-25 «Гейты слов, обещаний, ставок и модели угроз».
// Зелёные тесты — свойства, проверенные другим путём, чем тесты реализатора (свой разбор каталогов и таблицы угроз, не `find_imperatives`).
// Тесты с `todo` — найденные дефекты: они падали при проверке и не ломали прогон; после исправления (проход «исправление дефектов FP-25») они переведены в обычные.
// Todo по подписи режимов A2/A3 в вики снят в FP-51 (вики приведена к словарю); см. также fp25_fix.test.mjs.
// Браузер и сеть не нужны; в тестах допустимы node:*.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.resolve(HERE, '..');
const RUNWAY = path.resolve(PROTO, '..');
const LINT = await import(pathToFileURL(path.join(RUNWAY, 'tools', 'lint_vocab.mjs')).href);
const CATS = await LINT.load_catalogs();

const ph = (s) => [...String(s).matchAll(/\{[A-Za-z_0-9.]+\}/g)].map((m) => m[0]).sort().join(',');

test('FP-25 adv: независимый обход RU-каталогов — все формы на -йте/-ьте/-ите вне «проверьте/введите/сверьте» — только изъявительные («вводите вы», «вы платите»)', () => {
  const RE = /(?<![\p{L}\d])[а-яё]+(?:йте|ьте|ите)(?:сь)?(?![\p{L}\d])/giu;
  const allowed = new Set(['проверьте', 'введите', 'сверьте']);
  const indicative = new Set(['вводите', 'вносите', 'платите', 'хотите', 'видите', 'знаете']);
  const found = [];
  for (const c of CATS) for (const [k, v] of Object.entries(c.ru)) for (const m of String(v).matchAll(RE)) {
    const w = m[0].toLowerCase();
    if (allowed.has(w)) continue;
    found.push(`${c.file}:${k}:${w}`);
    assert.ok(indicative.has(w), `${c.file} ${k}: «${w}» — повелительная форма вне списка, которую линтер пропустил`);
  }
  assert.ok(found.length <= 10, 'эвристика изъявительного не прячет лишнего: ' + found.join(' | '));
});

test('FP-25 adv: плейсхолдеры {…} в каждой паре RU/EN всех каталогов совпадают (независимый разбор)', () => {
  let n = 0;
  for (const c of CATS) for (const k of Object.keys(c.ru)) {
    n++;
    assert.equal(ph(c.ru[k]), ph(c.en[k]), `${c.file} ${k}`);
  }
  assert.ok(n > 2800, `ключей: ${n}`);
});

test('FP-25 adv: таблица угроз 07-privacy-security.md — независимый подсчёт: 15 строк, в смягчении каждой REQ, ссылки существуют', () => {
  const md = fs.readFileSync(path.join(RUNWAY, 'wiki', 'product', '07-privacy-security.md'), 'utf8');
  const sec = md.split(/^## Модель угроз\s*$/m)[1].split(/^#{2,3} /m)[0];
  const rows = sec.split('\n').filter((l) => l.startsWith('|')).slice(2);
  assert.equal(rows.length, 15);
  const defined = new Set([...fs.readFileSync(path.join(RUNWAY, 'wiki', 'product', '02-requirements.md'), 'utf8').matchAll(/^### (REQ-\d{3})/gm)].map((m) => m[1]));
  for (const r of rows) {
    const cells = r.split('|').map((c) => c.trim());
    const refs = cells[3].match(/REQ-\d{3}/g) ?? [];
    assert.ok(refs.length > 0, `нет REQ: ${cells[1]}`);
    for (const x of refs) assert.ok(defined.has(x), `${x} не определён`);
  }
});

test('FP-25 adv: канон не тронут — в data/ ровно пять наборов G-001 с демо-правилом 20 %, golden и arith.lock на месте', () => {
  const g = JSON.parse(fs.readFileSync(path.join(PROTO, 'data', 'g001.json'), 'utf8'));
  assert.equal(g.tax_rules[0].rate_bp, 2000);
  assert.ok(fs.existsSync(path.join(PROTO, 'tests', 'g001.golden.test.mjs')) && fs.existsSync(path.join(PROTO, 'tests', 'arith.lock.json')));
  const vocab = fs.readFileSync(path.join(PROTO, 'engine', 'vocab.json'), 'utf8');
  assert.ok(!/allowed_imperatives|проверьте/.test(vocab), 'список императивов не в vocab.json');
});

// ── найденные дефекты (исправлены и переведены в обычные тесты; один todo — правка вики) ────────────────────────────────────────

test('FP-25 adv [ДЕФЕКТ REQ-046]: в EN-каталогах нет отрицательной команды «do not …» / «don’t …» / «never …» (сегодня showcase.pl_leak: «do not turn a cloud mode on»)', () => {
  // предложение-указание: начало строки или после «. ! ? : ;», строка кончается точкой/«!»; подписи кнопок («Do not clear») и описательное «they do not change» не в счёт
  const NEG = /(?:^|[.!?:;—]\s+)(?:please\s+)?(?:do not|don['’]t|never)\s+[a-z]+/i;
  const bad = [];
  for (const c of CATS) for (const [k, v] of Object.entries(c.en)) if (/[.!][\s"”»')]*$/u.test(v.trimEnd()) && NEG.test(v)) bad.push(`${c.file} ${k}: ${v.slice(0, 90)}`);
  assert.deepEqual(bad, []);
});

test('FP-25 adv [ДЕФЕКТ REQ-046]: EN-детектор находит команды вне закрытого списка: Adjust / Visit / Install / Increase / Put / Let / Be / Never / Do not', () => {
  const missed = ['Adjust the buffer.', 'Visit the Data screen.', 'Install the app.', 'Increase the buffer.', 'Put the file in a safe place.', 'Let the page load.', 'Be careful with the file.', 'Never share the file.', 'This is a defect; do not turn it on.']
    .filter((s) => LINT.find_imperatives(s, 'en').length === 0);
  assert.deepEqual(missed, []);
});

test('FP-25 adv [ДЕФЕКТ честность текста]: предупреждения о необратимой замене не должны читаться как автоматическое скачивание копии (data.restore_warn, data.replace_warn, v0.file_hint)', () => {
  const data = CATS.find((c) => c.file.endsWith('i18n/data.mjs'));
  const v0 = CATS.find((c) => c.file.endsWith('i18n/v0.mjs'));
  const modal_ru = /можно|нужно|следует|вручную|самостоятельно/i;
  const modal_en = /\bcan\b|\bhas to\b|\bneeds?\b|\bby hand\b|\byourself\b|\bmanually\b/i;
  for (const [cat, key] of [[data, 'data.restore_warn'], [data, 'data.replace_warn'], [v0, 'v0.file_hint']]) {
    assert.match(cat.ru[key], modal_ru, `${key} (ru): ${cat.ru[key]}`);
    assert.match(cat.en[key], modal_en, `${key} (en): ${cat.en[key]}`);
  }
});

test('FP-25 adv [ДЕФЕКТ документация хука]: инструкция README учитывает, что в объемлющем репозитории уже задан core.hooksPath (хук NEXUS-гейта), и не предлагает его заменить', () => {
  const readme = fs.readFileSync(path.join(PROTO, 'README.md'), 'utf8');
  const at = readme.indexOf('Подключение хука');
  assert.ok(at > 0);
  const para = readme.slice(at, at + 900);
  assert.match(para, /уже задан|уже настро|существующ|цепочк|вызов[а-я]* из|не заменя|вместо/i, para.slice(0, 300));
});

test('FP-25 adv [ПРОБЕЛ REQ-114 закрыт]: таблица режимов ассистента A0…A3 в 06-ai-assistant-spec.md использует подписи словаря с точностью до знаков препинания — и сверка gen_vocab_tables её теперь видит', async () => {
  const vocab = JSON.parse(fs.readFileSync(path.join(PROTO, 'engine', 'vocab.json'), 'utf8'));
  const md = fs.readFileSync(path.join(RUNWAY, 'wiki', 'product', '06-ai-assistant-spec.md'), 'utf8');
  const norm = (s) => s.toLowerCase().replace(/[(),]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [id, rec] of Object.entries(vocab.assistant_modes)) {
    const m = new RegExp('^\\| `' + id + '` ([^|]+)\\|', 'm').exec(md);
    assert.ok(m, `строка ${id} есть`);
    assert.equal(norm(m[1]), norm(rec.ru));
  }
  const G = await import(pathToFileURL(path.join(PROTO, 'tools', 'gen_vocab_tables.mjs')).href);
  const r = G.check_tables(vocab);
  assert.deepEqual(r.problems, []);
  assert.ok(r.rows >= 16, `строк словаря на страницах (вместе с A0…A3): ${r.rows}`);
  assert.deepEqual(r.notes, [], 'FP-51: подписи A2/A3 приведены к словарю, заметок о знаках препинания не осталось');
});

// Найденный дефект: подписи A2/A3 в вики расходились со словарём. FP-51 привёл их к словарю буква в букву, todo снят (название прежнее).
test('FP-25 adv [ДЕФЕКТ вики, остаётся]: подпись режимов ассистента A2/A3 в 06-ai-assistant-spec.md совпадает со словарём буква в букву', () => {
  const vocab = JSON.parse(fs.readFileSync(path.join(PROTO, 'engine', 'vocab.json'), 'utf8'));
  const md = fs.readFileSync(path.join(RUNWAY, 'wiki', 'product', '06-ai-assistant-spec.md'), 'utf8');
  for (const [id, rec] of Object.entries(vocab.assistant_modes)) {
    const m = new RegExp('^\\| `' + id + '` ([^|]+)\\|', 'm').exec(md);
    assert.ok(m, `строка ${id} есть`);
    assert.equal(m[1].trim(), rec.ru, `подпись ${id} в вики совпадает со словарём буква в букву`);
  }
});
