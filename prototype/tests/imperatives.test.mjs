// imperatives.test.mjs — FP-25, REQ-046 / REQ-114 / REQ-178 (TST-56): линтер императивов в каталогах строк интерфейса и реестр разобранных предупреждений.
// Покрывает: список допустимых повелительных «проверьте / введите / сверьте» (константа в tools/lint_vocab.mjs, не в vocab.json); разбор RU (-йте/-ьте/-ите) и EN
// (предложения-указания) на примерах; все каталоги demo/i18n.mjs и demo/i18n/*.mjs чисты (0 императивов вне списка), строки нейтральны на обоих языках;
// ошибки императивов нельзя снять реестром; реестр tools/lint_vocab_ignore.json разбирает ровно те предупреждения, что есть (0 ошибок, 0 предупреждений, 0 устаревших записей).
// Браузер и сеть не нужны; в тестах допустимы node:*.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.resolve(HERE, '..');
const RUNWAY = path.resolve(PROTO, '..');
const LINT = await import(pathToFileURL(path.join(RUNWAY, 'tools', 'lint_vocab.mjs')).href);
const I18N = await import(pathToFileURL(path.join(PROTO, 'demo', 'i18n.mjs')).href);
const VOCAB_TEXT = fs.readFileSync(path.join(PROTO, 'engine', 'vocab.json'), 'utf8');

const words = (text, lang) => LINT.find_imperatives(text, lang).map((x) => x.word.toLowerCase());

test('REQ-046 список допустимых императивов: проверьте / введите / сверьте и EN-параллели; живёт в lint_vocab.mjs, а не в vocab.json', () => {
  assert.deepEqual([...LINT.ALLOWED_IMPERATIVES.ru], ['проверьте', 'введите', 'сверьте']);
  for (const w of ['check', 'enter', 'reconcile']) assert.ok(LINT.ALLOWED_IMPERATIVES.en.includes(w), w);
  assert.ok(Object.isFrozen(LINT.ALLOWED_IMPERATIVES) && Object.isFrozen(LINT.ALLOWED_IMPERATIVES.ru), 'константа заморожена');
  for (const w of LINT.ALLOWED_IMPERATIVES.ru) assert.ok(!VOCAB_TEXT.includes(w), `«${w}» не должно быть в vocab.json`);
  assert.equal(JSON.parse(VOCAB_TEXT).allowed_imperatives, undefined);
  const src = fs.readFileSync(path.join(RUNWAY, 'tools', 'lint_vocab.mjs'), 'utf8');
  assert.match(src, /export const ALLOWED_IMPERATIVES/);
});

test('REQ-046 RU: «добавьте …», «Заполните поля», «нажмите …» — императивы; «проверьте», «введите», «сверьте» — допустимы в любом регистре', () => {
  assert.deepEqual(words('Нет дохода: добавьте ожидаемое поступление', 'ru'), ['добавьте']);
  assert.deepEqual(words('Заполните поля: платёж появится здесь.', 'ru'), ['заполните']);
  assert.deepEqual(words('Чтобы сохранить, нажмите «Сохранить».', 'ru'), ['нажмите']);
  assert.deepEqual(words('Откройте набор данных и подтвердите правило.', 'ru'), ['откройте', 'подтвердите']);
  assert.deepEqual(words('Проверьте счёт. Введите сумму. СВЕРЬТЕ остаток.', 'ru'), []);
  assert.deepEqual(words('Сверьтесь по более позднему платежу', 'ru'), ['сверьтесь'], 'возвратная форма — другая форма, не «сверьте»');
  assert.deepEqual(words('Вводите сумму цифрами', 'ru'), ['вводите'], 'несовершенный вид — не «введите»');
  // инфинитивы и существительные — не повеление
  assert.deepEqual(words('Добавить в прогноз. Сохранить. Отменить. Выберите', 'ru'), ['выберите']);
  assert.deepEqual(words('Платежи в календаре, на сайте, в элите', 'ru'), [], 'существительные на -ите/-йте не считаются');
  // изъявительное: «правила, которые вводите вы», «если хотите», «вы платите»
  assert.deepEqual(words('Налоги — только правила, которые вводите вы.', 'ru'), []);
  assert.deepEqual(words('Если хотите поделиться файлом, он передаётся вручную.', 'ru'), []);
  assert.deepEqual(words('Даты вносите вы сами.', 'ru'), []);
});

test('REQ-046 EN: предложения-указания (начало, после «:», «;», запятой, «and/or/then») — императивы; подписи кнопок без точки, вопросы и названия элементов — нет', () => {
  assert.deepEqual(words('Fill in the fields: the payment will appear here.', 'en'), ['fill']);
  assert.deepEqual(words('Not accepted: pick another calendar for them first.', 'en'), ['pick']);
  assert.deepEqual(words('The rule is stale: confirm or change it.', 'en'), ['confirm', 'change']);
  assert.deepEqual(words('Open the page through a server, not as a file.', 'en'), ['open']);
  assert.deepEqual(words('Check the rate. Enter a date. Reconcile the balance. Compare the totals.', 'en'), [], 'check / enter / reconcile / compare допустимы');
  assert.deepEqual(words('Add to the forecast', 'en'), [], 'подпись кнопки без точки — название элемента');
  assert.deepEqual(words('Replace the saved data?', 'en'), [], 'вопрос в названии окна — не команда');
  assert.deepEqual(words('“Undo” takes the entry back. Undo restores the previous date.', 'en'), [], 'названия элементов «Undo/Redo» как подлежащее');
  assert.deepEqual(words('The page opens through a server (node serve.mjs), not as a file.', 'en'), []);
  assert.deepEqual(words('Copy of the shell on this device: 5 of 9 files.', 'en'), [], 'Copy of … — существительное');
  assert.deepEqual(words('Review not marked: the rule has no shelf life.', 'en'), [], 'Review not … — существительное');
});

test('REQ-046 каталоги интерфейса (demo/i18n.mjs и demo/i18n/*.mjs): 0 императивов вне списка в RU и EN — линтер читает все каталоги', async () => {
  const cats = await LINT.load_catalogs();
  const files = cats.map((c) => c.file);
  assert.ok(files.includes('prototype/demo/i18n.mjs'));
  assert.ok(cats.length >= 20, `каталогов: ${cats.length}`);
  const total = cats.reduce((n, c) => n + Object.keys(c.ru).length, 0);
  assert.ok(total > 2800, `строк: ${total}`);
  // читаются именно каталоги на диске: число файлов в demo/i18n совпадает
  const on_disk = fs.readdirSync(path.join(PROTO, 'demo', 'i18n')).filter((n) => n.endsWith('.mjs')).length;
  assert.equal(cats.length, on_disk + 1);
  const found = LINT.lint_imperatives(cats);
  assert.deepEqual(found.map((f) => `${f.file}:${f.line} ${f.msg}`), [], 'императивы вне списка в каталогах');
  for (const c of cats) assert.deepEqual(Object.keys(c.ru).sort(), Object.keys(c.en).sort(), `${c.file}: паритет ключей сохранён`);
});

test('REQ-046 найденные аудитом строки заменены нейтральными: «добавьте ожидаемое поступление» → «поступление не внесено», «Заполните поля» → «поля не заполнены»; паритет RU/EN', async () => {
  const cats = await LINT.load_catalogs();
  const cat = (file) => cats.find((c) => c.file === 'prototype/demo/' + file);
  const income = cat('i18n/settings.mjs');
  assert.match(income.ru['settings.rd_miss_no_income_45d'], /ожидаемое поступление не внесено/);
  assert.doesNotMatch(income.ru['settings.rd_miss_no_income_45d'], /добавьте/i);
  assert.match(income.en['settings.rd_miss_no_income_45d'], /no expected income is entered/);
  const wait = cat('i18n/forms.mjs');
  assert.match(wait.ru['forms.rule_preview_wait'], /Поля не заполнены/);
  assert.doesNotMatch(wait.ru['forms.rule_preview_wait'], /Заполните/);
  assert.match(wait.en['forms.rule_preview_wait'], /not filled in/);
  // разрешённые слова на месте: сверка остатка и ввод остаются повелительными
  assert.match(I18N.STRINGS.ru['banner.block'], /Сверьте остаток/);
  assert.match(I18N.STRINGS.ru['err.E_NOT_INTEGER'], /введите/i);
  assert.match(I18N.STRINGS.en['banner.block'], /Reconcile the balance/);
});

test('REQ-046 lint_imperatives: недопустимые императивы дают ERROR с ключом и языком; допустимые — нет; номер строки — место ключа в исходнике', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imp_'));
  try {
    fs.mkdirSync(path.join(tmp, 'prototype', 'demo', 'i18n'), { recursive: true });
    const file = 'prototype/demo/i18n/x.mjs';
    fs.writeFileSync(path.join(tmp, file), "export default {\n  ru: {\n    'x.a': 'Добавьте платёж.',\n    'x.b': 'Проверьте счёт.',\n  },\n  en: {\n    'x.a': 'Add a payment.',\n    'x.b': 'Check the account.',\n  },\n};\n");
    const cat = { file, ru: { 'x.a': 'Добавьте платёж.', 'x.b': 'Проверьте счёт.' }, en: { 'x.a': 'Add a payment.', 'x.b': 'Check the account.' } };
    const out = LINT.lint_imperatives([cat], { root: tmp });
    assert.equal(out.length, 2, JSON.stringify(out));
    assert.deepEqual(out.map((f) => [f.level, f.rule]), [['error', 'imperative'], ['error', 'imperative']]);
    assert.ok(out[0].msg.includes('x.a') && out[0].msg.includes('(ru)') && out[0].msg.includes('добавьте'), out[0].msg);
    assert.ok(out[1].msg.includes('(en)') && out[1].msg.includes('add'), out[1].msg);
    assert.equal(out[0].line, 3, 'номер строки ключа в RU-разделе');
    assert.equal(out[1].line, 7, 'номер строки ключа в EN-разделе — второе вхождение');
    assert.ok(out.every((f) => !f.msg.includes('x.b')), 'допустимое «Проверьте» не найдено');
    // lint_project с каталогами: ошибка попадает в общий отчёт; реестр исключений ошибки не снимает
    const r = LINT.lint_project({ root: tmp, vocab: LINT.load_vocab(), golden: null, catalogs: [cat], ignore: [{ file, rule: 'imperative', count: 2, reason: 'попытка скрыть ошибку реестром исключений' }] });
    assert.equal(r.findings.filter((f) => f.rule === 'imperative' && f.level === 'error').length, 2);
    const report = LINT.format_report(r);
    assert.match(report, /ERROR prototype\/demo\/i18n\/x\.mjs:3: \[imperative\]/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('REQ-178 реестр исключений: проверка формы записей, лишние сверх count остаются предупреждениями, недостающие дают ignore-stale, ошибки не снимаются', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ign_'));
  try {
    const bad = path.join(tmp, 'bad.json');
    for (const entry of [{ file: 'a.md', rule: 'we-first', count: 0, reason: 'причина достаточной длины для проверки' }, { file: 'a.md', rule: 'we-first', count: 1, reason: 'коротко' }, { rule: 'x', count: 1, reason: 'причина достаточной длины для проверки' }]) {
      fs.writeFileSync(bad, JSON.stringify({ entries: [entry] }));
      assert.throws(() => LINT.load_ignore(bad), /lint_vocab_ignore/);
    }
    assert.deepEqual(LINT.load_ignore(path.join(tmp, 'нет.json')), [], 'нет файла — пустой реестр');
    const f = (line, rule = 'we-first', level = 'warn', file = 'a.md') => ({ file, line, rule, level, msg: 'm' });
    const entries = [{ file: 'a.md', rule: 'we-first', count: 2, reason: 'причина достаточной длины для проверки' }, { file: 'b.md', rule: 'calm-verdict', count: 1, reason: 'причина достаточной длины для проверки' }];
    const r = LINT.apply_ignore([f(9), f(3), f(5), f(1, 'we-first', 'error')], entries);
    assert.deepEqual(r.ignored.map((x) => x.line), [3, 5], 'первые count по порядку строк');
    assert.ok(r.ignored.every((x) => x.reason.length > 20));
    assert.deepEqual(r.kept.map((x) => [x.line, x.level]), [[9, 'warn'], [1, 'error']], 'лишнее предупреждение и ошибка остаются');
    assert.deepEqual(r.stale.map((x) => [x.rule, x.level]), [['ignore-stale', 'warn']], 'запись для b.md устарела');
    assert.match(r.stale[0].msg, /b\.md/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('REQ-178 REQ-114 вики и интерфейс целиком: реестр tools/lint_vocab_ignore.json разбирает все предупреждения — 0 ошибок, 0 предупреждений; без реестра их ровно столько, сколько в записях', async () => {
  const entries = LINT.load_ignore();
  assert.ok(entries.length >= 10);
  for (const e of entries) {
    assert.ok(e.file.startsWith('wiki/ideas/'), `${e.file}: исключения только для черновиков предложений`);
    assert.ok(e.reason.trim().length >= 40, `${e.file} [${e.rule}]: причина записана`);
    assert.ok(fs.existsSync(path.join(RUNWAY, e.file)), `${e.file} существует`);
  }
  const golden = await LINT.golden_values();
  const catalogs = await LINT.load_catalogs();
  const registry = JSON.parse(fs.readFileSync(path.join(PROTO, 'demo', 'promises.json'), 'utf8'));
  const raw = LINT.lint_project({ golden, catalogs, registry, today: '2026-10-23' });
  const raw_errors = raw.findings.filter((f) => f.level === 'error');
  const raw_warns = raw.findings.filter((f) => f.level !== 'error');
  assert.deepEqual(raw_errors.map((f) => `${f.file}:${f.line} [${f.rule}]`), [], 'ошибок нет и без реестра');
  const total = entries.reduce((n, e) => n + e.count, 0);
  assert.equal(raw_warns.length, total, 'число предупреждений без реестра равно сумме count: записи не устарели и ничего не пропущено');
  const done = LINT.lint_project({ golden, catalogs, registry, today: '2026-10-23', ignore: entries });
  assert.deepEqual(done.findings.map((f) => `${f.file}:${f.line} [${f.rule}]`), [], 'с реестром не осталось ни ошибок, ни предупреждений');
  assert.equal(done.ignored.length, total);
  const report = LINT.format_report(done);
  assert.match(report, /\nИтого: 0 ошибок, 0 предупреждений\n$/);
  assert.match(report, /Разобрано реестром исключений/);
  assert.match(LINT.format_report(done, { show_ignored: true }), /\nskip {2}wiki\/ideas\//);
});
