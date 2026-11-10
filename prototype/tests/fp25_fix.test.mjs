// fp25_fix.test.mjs — FP-25, проход «исправление дефектов после независимой проверки» (REQ-046, REQ-114).
// По одному тесту на каждый дефект: (1) инструкция к хуку не предлагает заменить core.hooksPath, занятый хуком NEXUS-гейта монорепо, а описывает цепочку
// (строка цепочки проверена запуском sh); (2) предупреждения о необратимой замене и подсказка страницы v0 не обещают скачивания, которого код не делает;
// (3) EN-линтер императивов ловит команды вне закрытого списка («Adjust …», «Do not …», «Never …»), не трогает описательные предложения и охватывает шаблоны
// verifier / start_template; (4) сверка gen_vocab_tables видит режимы ассистента A0…A3 и называет различие знаков препинания заметкой; (5) числа в README.
// Браузер и сеть не нужны; в тестах допустимы node:*; sh и git вызываются только если найдены (иначе проверка пропускается).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.resolve(HERE, '..');
const RUNWAY = path.resolve(PROTO, '..');
const LINT = await import(pathToFileURL(path.join(RUNWAY, 'tools', 'lint_vocab.mjs')).href);
const G = await import(pathToFileURL(path.join(PROTO, 'tools', 'gen_vocab_tables.mjs')).href);
const VERIFIER = await import(pathToFileURL(path.join(PROTO, 'engine', 'verifier.mjs')).href);
const VOCAB = JSON.parse(fs.readFileSync(path.join(PROTO, 'engine', 'vocab.json'), 'utf8'));
const CATS = await LINT.load_catalogs();
const TPL = await LINT.load_template_catalogs();

const README = fs.readFileSync(path.join(PROTO, 'README.md'), 'utf8');
const HOOK_PATH = path.join(RUNWAY, '.githooks', 'pre-commit');
const HOOK = fs.readFileSync(HOOK_PATH, 'utf8');
/** Строка цепочки из инструкции: вызов хука Runway из корневого хука монорепо (после `root=…`, до `staged=…`). */
const CHAIN = '[ -f "$root/301/runway/.githooks/pre-commit" ] && { sh "$root/301/runway/.githooks/pre-commit" || exit $?; }';
const fwd = (p) => p.split(path.sep).join('/');
const sh = (args, opts = {}) => spawnSync('sh', args, { encoding: 'utf8', timeout: 60000, ...opts });
const words = (text, lang) => LINT.find_imperatives(text, lang).map((x) => x.word.toLowerCase());

// ── 1. хук: цепочка вместо замены core.hooksPath ───────────────────────────────────────────────────────────────────────

test('FP-25 fix [документация хука]: README не предлагает заменить core.hooksPath (в монорепо он занят хуком NEXUS-гейта), а описывает цепочку и ручной запуск', () => {
  const at = README.indexOf('**Подключение хука**');
  assert.ok(at > 0, 'раздел «Подключение хука» есть');
  const end = README.indexOf('**Что заменено в строках интерфейса.**', at);
  const para = README.slice(at, end);
  for (const need of ['git config --get core.hooksPath', 'уже задан', 'NEXUS', 'нельзя', 'цепочк', 'до** строки', 'npm run lint:words', CHAIN]) assert.ok(para.includes(need), `в разделе нет «${need}»`);
  // запрещённая команда названа только как запрещённая
  const bad = 'git config core.hooksPath 301/runway/.githooks';
  const i = para.indexOf(bad);
  assert.ok(i >= 0 && para.slice(i, i + bad.length + 60).includes('нельзя'), 'команда замены названа с пометкой «нельзя»');
  assert.equal(para.split(bad).length - 1, 1, 'команда замены упомянута один раз — как запрет');
  // та же цепочка и то же предупреждение — в шапке самого хука
  assert.ok(HOOK.includes(CHAIN), 'в шапке хука та же строка цепочки');
  assert.match(HOOK, /ОДИН путь/);
  assert.match(HOOK, /NEXUS/);
  assert.match(HOOK, /НЕ заменять/);
  assert.doesNotMatch(HOOK, /git config core\.hooksPath <путь/, 'безусловной инструкции «задать путь» в хуке нет');
});

test('FP-25 fix [документация хука]: строка цепочки из README работает — отказ хука Runway останавливает корневой хук, отсутствие файла и успех пропускают дальше', (t) => {
  if (sh(['-c', 'exit 0']).error) { t.skip('sh не найден'); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk_'));
  try {
    const root = fwd(tmp);
    fs.mkdirSync(path.join(tmp, '301', 'runway', '.githooks'), { recursive: true });
    const root_hook = path.join(tmp, 'root_pre_commit');
    fs.writeFileSync(root_hook, `#!/bin/sh\nroot="${root}"\n${CHAIN}\necho reached-end\n`);
    const stub = path.join(tmp, '301', 'runway', '.githooks', 'pre-commit');
    fs.writeFileSync(stub, '#!/bin/sh\nexit 7\n');
    const fail = sh([fwd(root_hook)]);
    assert.equal(fail.status, 7, 'код отказа хука Runway возвращается git');
    assert.ok(!fail.stdout.includes('reached-end'), 'после отказа корневой хук дальше не идёт (NEXUS-часть не запускается, коммит остановлен)');
    fs.writeFileSync(stub, '#!/bin/sh\nexit 0\n');
    const ok = sh([fwd(root_hook)]);
    assert.equal(ok.status, 0);
    assert.ok(ok.stdout.includes('reached-end'), 'успех — корневой хук продолжает работу');
    fs.rmSync(stub);
    const none = sh([fwd(root_hook)]);
    assert.equal(none.status, 0, 'файла нет — цепочка молчит (защита `[ -f … ]`)');
    assert.ok(none.stdout.includes('reached-end'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('FP-25 fix [документация хука]: сам хук Runway без затронутых файлов runway/ выходит с 0, не запуская проверку; RUNWAY_HOOK_SKIP=1 отключает его', (t) => {
  if (sh(['-c', 'exit 0']).error) { t.skip('sh не найден'); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk2_'));
  try {
    const run = (env) => sh([fwd(HOOK_PATH)], { cwd: tmp, env: { ...process.env, ...env } });
    const skip = run({ RUNWAY_HOOK_SKIP: '1' });
    assert.equal(skip.status, 0, skip.stderr);
    assert.equal(skip.stdout, '', 'пропуск тихий');
    const none = run({ RUNWAY_HOOK_SKIP: '', RUNWAY_HOOK_ALWAYS: '' });
    assert.equal(none.status, 0, none.stdout + none.stderr);
    assert.ok(!none.stdout.includes('проверка слов'), 'проверка слов не запускалась: коммит не трогает runway/ (или каталог не репозиторий)');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 2. честность предупреждений о необратимой замене ─────────────────────────────────────────────────────────────────────

test('FP-25 fix [честность текста]: предупреждения о замене данных и подсказка v0 называют возможность или обязанность пользователя; код не скачивает копию сам', () => {
  const data = CATS.find((c) => c.file.endsWith('i18n/data.mjs'));
  const v0 = CATS.find((c) => c.file.endsWith('i18n/v0.mjs'));
  // 1) код диалогов действительно ничего не скачивает до замены — иначе текст «диалог ничего не скачивает» стал бы ложным
  const src = fs.readFileSync(path.join(PROTO, 'demo', 'data_view.mjs'), 'utf8');
  const part = (from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return src.slice(a, b); };
  for (const body of [part('const ask_replace', 'return h(\'section\''), part('function open_restore', 'async function on_pick')]) {
    assert.doesNotMatch(body, /export_copy|download_text|save_journal\(/, 'диалог замены не выгружает журнал сам');
  }
  // 2) тексты называют, кто и где скачивает копию
  for (const key of ['data.restore_warn', 'data.replace_warn']) {
    assert.match(data.ru[key], /можно скачать/, key);
    assert.match(data.ru[key], /ничего не скачивает/, key);
    assert.ok(data.ru[key].includes('«' + data.ru['data.save_journal'] + '»'), `${key} (ru): названа кнопка «${data.ru['data.save_journal']}»`);
    assert.ok(data.ru[key].includes('«Данные»'), `${key} (ru): назван экран`);
    assert.match(data.en[key], /can be downloaded/, key);
    assert.match(data.en[key], /downloads nothing/, key);
    assert.ok(data.en[key].includes('“' + data.en['data.save_journal'] + '”'), `${key} (en): названа кнопка “${data.en['data.save_journal']}”`);
    assert.ok(data.en[key].includes('Data screen'), `${key} (en): назван экран`);
    assert.doesNotMatch(data.ru[key], /скачивается/, `${key} (ru): пассив «скачивается» читается как автоматическое действие`);
    assert.doesNotMatch(data.en[key], /is downloaded|are downloaded/, `${key} (en)`);
  }
  assert.match(data.ru['data.replace_warn'], /только после продолжения с сохранённого/);
  assert.match(data.en['data.replace_warn'], /only after continuing from saved/);
  // 3) v0: файл сохраняет сам пользователь
  assert.match(v0.ru['v0.file_hint'], /нужно сохранить самостоятельно/);
  assert.match(v0.en['v0.file_hint'], /has to be saved by you/);
  assert.doesNotMatch(v0.ru['v0.file_hint'], /сохраняется/);
  assert.doesNotMatch(v0.en['v0.file_hint'], /is saved/);
  // 4) плейсхолдеры и паритет не нарушены
  const ph = (s) => [...String(s).matchAll(/\{[A-Za-z_0-9.]+\}/g)].map((m) => m[0]).sort().join(',');
  for (const [cat, key] of [[data, 'data.restore_warn'], [data, 'data.replace_warn'], [v0, 'v0.file_hint']]) assert.equal(ph(cat.ru[key]), ph(cat.en[key]), key);
  assert.equal(ph(data.ru['data.replace_warn']), '{n}');
});

// ── 3. EN-линтер императивов ─────────────────────────────────────────────────────────────────────────────────────────────

test('FP-25 fix [REQ-046 EN]: команды вне закрытого списка находятся — Adjust / Visit / Install / Increase / Put / Let / Be / Never / Do not / Don’t', () => {
  const must = {
    'Adjust the buffer.': 'adjust',
    'Visit the Data screen.': 'visit',
    'Install the app.': 'install',
    'Increase the buffer.': 'increase',
    'Put the file in a safe place.': 'put',
    'Let the page load.': 'let',
    'Be careful with the file.': 'be',
    'Never share the file.': 'never',
    'This is a defect; do not turn it on.': 'do not',
    'Do not turn it on.': 'do not',
    'Don’t share the file.': 'don’t',
    'Please do not close the page.': 'do not',
    // второй заслон: глагола нет ни в одном списке — ловится по форме «слово + артикль/местоимение-дополнение»
    'Frobnicate the buffer.': 'frobnicate',
    'Rebalance your reserves.': 'rebalance',
    'The file is saved. Archive it.': 'archive',
  };
  for (const [text, word] of Object.entries(must)) assert.deepEqual(words(text, 'en'), [word], text);
  // допустимые слова остаются допустимыми и в обобщённой ветке
  assert.deepEqual(words('Check the rate. Enter a date. Reconcile the balance. Compare the totals.', 'en'), []);
  assert.deepEqual(words('Do not turn it on.', 'en').concat(words('Never share it.', 'en')), ['do not', 'never']);
});

test('FP-25 fix [REQ-046 EN]: описательные предложения не считаются командами — подлежащее + сказуемое, герундий, -ed, третье лицо, «never» как наречие', () => {
  const calm = [
    'Never sent to a server.',
    'Payments are listed and never uploaded.',
    'Settings are saved.',
    'Closing the window keeps the data.',
    'Saved the entry at once.',
    'Records the posted income for the stream.',
    'Rows that do not match are skipped.',
    'Payments are listed and do not leave the device.',
    'The rows do not match.',
    'Prices change against the base.',
    'After the rule is saved, the totals update.',
    'Once the file is read, nothing is sent.',
    'If the balance is stale, the free amount is hidden.',
    'Purchase on {date}, buffer {buffer}.',
    'Without the rule the tax envelope stays empty.',
  ];
  for (const text of calm) assert.deepEqual(words(text, 'en'), [], text);
  // подпись кнопки без точки и вопрос — не предложения-указания (как и раньше)
  assert.deepEqual(words('Do not clear', 'en'), []);
  assert.deepEqual(words('Adjust the buffer', 'en'), []);
  assert.deepEqual(words('Replace the saved data?', 'en'), []);
});

test('FP-25 fix [REQ-046 EN]: showcase.pl_leak без «do not» — по образцу RU («облачный режим не включать»); каталоги интерфейса и шаблоны (verifier, start_template) чисты', () => {
  const show = CATS.find((c) => c.file.endsWith('i18n/showcase.mjs'));
  assert.equal(show.en['showcase.pl_leak'], 'Untrusted text found in the result: {ids}. This is a defect; a cloud mode should stay off.');
  assert.doesNotMatch(show.en['showcase.pl_leak'], /do not|don[’']t|never/i);
  assert.match(show.ru['showcase.pl_leak'], /облачный режим не включать/);
  // каталоги интерфейса и шаблоны вместе
  assert.deepEqual(LINT.lint_imperatives([...CATS, ...TPL]).map((f) => `${f.file}:${f.line} ${f.msg}`), []);
  // независимый обход: ни одно EN-предложение-указание не начинается с «Do not / Don’t / Never + глагол»
  const NEG = /(?:^|[.!?:;—]\s+)(?:please\s+)?(?:do not|don['’]t|never)\s+[a-z]+/i;
  for (const c of [...CATS, ...TPL]) for (const [k, v] of Object.entries(c.en)) {
    if (/[.!][\s"”»')]*$/u.test(String(v).trimEnd())) assert.doesNotMatch(String(v), NEG, `${c.file} ${k}`);
  }
});

test('FP-25 fix [REQ-046 охват]: шаблоны ответов verifier и скелет «Старт» читаются линтером; подписи операций черновика EN — герундии, как RU «Перенос / Пропуск / Добавление»', () => {
  const [ver, start] = TPL;
  assert.equal(ver.file, 'prototype/engine/verifier.mjs');
  assert.equal(start.file, 'prototype/demo/start_template.mjs');
  assert.deepEqual(Object.keys(ver.ru).sort(), Object.keys(ver.en).sort(), 'паритет ключей шаблонов');
  assert.ok(Object.keys(ver.ru).length > 40 &&Object.keys(start.ru).length >= 10, `строк: ${Object.keys(ver.ru).length} / ${Object.keys(start.ru).length}`);
  assert.deepEqual(Object.keys(start.ru).sort(), Object.keys(start.en).sort());
  assert.equal(ver.en['DRAFT.MOVE'], VERIFIER.templates('en')['DRAFT.MOVE']);
  assert.match(ver.en['DRAFT.MOVE'], /^Moving the payment to \{d\.to\}\.$/);
  assert.match(ver.en['DRAFT.SKIP'], /^Skipping the payment\.$/);
  assert.match(ver.en['DRAFT.ADD'], /^Adding a payment of \{d\.amount\} on \{d\.date\}\.$/);
  assert.match(ver.ru['DRAFT.MOVE'], /^Перенос платежа/);
  assert.match(ver.ru['DRAFT.SKIP'], /^Пропуск платежа/);
  assert.match(ver.ru['DRAFT.ADD'], /^Добавление платежа/);
  // линтер действительно находит команду в шаблоне
  const out = LINT.lint_imperatives([{ file: 'prototype/engine/verifier.mjs', ru: { 'DRAFT.X': 'Перенос платежа.' }, en: { 'DRAFT.X': 'Move the payment.' } }]);
  assert.equal(out.length, 1);
  assert.match(out[0].msg, /DRAFT\.X \(en\)/);
  // CLI-проход линтера учитывает шаблоны
  const src = fs.readFileSync(path.join(RUNWAY, 'tools', 'lint_vocab.mjs'), 'utf8');
  assert.match(src, /await load_template_catalogs\(\)/);
});

test('FP-25 fix [REQ-046 RU]: изъявительное «пока вы сами не подтвердите» не повеление; «подтвердите» без подлежащего — по-прежнему ERROR', () => {
  assert.deepEqual(words('Он ничего не меняет, пока вы сами не подтвердите его в интерфейсе.', 'ru'), []);
  assert.deepEqual(words('Числа скрыты, если вы ещё не подтвердите правило.', 'ru'), []);
  assert.deepEqual(words('Подтвердите правило.', 'ru'), ['подтвердите']);
  assert.deepEqual(words('Сомневаетесь — не нажимайте кнопку.', 'ru'), ['нажимайте'], 'запрет «не нажимайте» остаётся императивом');
});

// ── 4. сверка таблиц: режимы ассистента ───────────────────────────────────────────────────────────────────────────────────

test('FP-25 fix [REQ-114]: gen_vocab_tables видит режимы ассистента A0…A3 в 06-ai-assistant-spec.md; знаки препинания — заметка, смысл подписи — расхождение; группа необязательна', () => {
  const real = G.check_tables(VOCAB);
  assert.deepEqual(real.problems, [], 'настоящие страницы: расхождений нет');
  for (const id of Object.keys(VOCAB.assistant_modes)) assert.ok(real.covered.includes('assistant_modes:' + id), `покрыт ${id}`);
  assert.deepEqual(real.notes, []); // FP-51: подписи A2/A3 в 06-ai-assistant-spec приведены к словарю, заметок о знаках препинания нет
  // FP-51 (исправление по проверке 2026-11-09): при пустом списке заметок условие ниже истинно всегда; содержательная проверка текста заметки — на непустом примере в конце теста
  assert.ok(real.notes.every((n) => n.file === 'wiki/product/06-ai-assistant-spec.md' && n.line > 0 && /только знаками препинания/.test(n.msg)));
  // разбор строки «`A2` подпись»
  const rows = G.find_vocab_rows(['| Режим | Кто пишет | Фаза |', '|---|---|---|', '| `A0` без LLM | шаблоны | v1 |', '| `A2` облако, символьный | модель | v2 |', '| `x` не код | y | z |'].join('\n'), 'p.md');
  assert.deepEqual(rows.map((r) => [r.id, r.label, r.shape]), [['A0', 'без LLM', 'inline'], ['A2', 'облако, символьный', 'inline']]);
  assert.equal(G.norm_loose('облако (символьный)'), G.norm_loose('Облако,  символьный'));
  assert.notEqual(G.norm_loose('облако (символьный)'), G.norm_loose('облако (агрегаты)'));
  // искажённая и урезанная копии вики
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vt2_'));
  try {
    const wiki = path.join(root, 'wiki');
    fs.mkdirSync(path.join(wiki, 'product'), { recursive: true });
    const glossary = fs.readFileSync(path.join(RUNWAY, 'wiki', 'product', '14-glossary.md'), 'utf8');
    fs.writeFileSync(path.join(wiki, 'product', '14-glossary.md'), glossary);
    assert.deepEqual(G.check_tables(VOCAB, { wiki }).problems, [], 'без страницы про ассистента группа не обязательна');
    const spec = fs.readFileSync(path.join(RUNWAY, 'wiki', 'product', '06-ai-assistant-spec.md'), 'utf8');
    fs.writeFileSync(path.join(wiki, 'product', '06-ai-assistant-spec.md'), spec.replace('| `A1` локальная модель |', '| `A1` удалённая модель |'));
    const bad = G.check_tables(VOCAB, { wiki });
    assert.equal(bad.problems.length, 1, JSON.stringify(bad.problems));
    assert.match(bad.problems[0].msg, /подпись «удалённая модель» у `A1` не совпадает со словарём \(«локальная модель»\)/);
    assert.equal(bad.problems[0].file, 'wiki/product/06-ai-assistant-spec.md');
    assert.ok(bad.problems[0].line > 0);
    // словарь изменили — вики не обновили
    const v2 = JSON.parse(JSON.stringify(VOCAB));
    v2.assistant_modes.A0.ru = 'без модели';
    fs.writeFileSync(path.join(wiki, 'product', '06-ai-assistant-spec.md'), spec);
    const drift = G.check_tables(v2, { wiki });
    assert.equal(drift.problems.length, 1);
    assert.match(drift.problems[0].msg, /«без LLM» у `A0` не совпадает со словарём \(«без модели»\)/);
    // FP-51 (исправление по проверке 2026-11-09): непустой пример заметки — подпись «Облако, символьный» отличается от словаря только знаками препинания
    fs.writeFileSync(path.join(wiki, 'product', '06-ai-assistant-spec.md'), spec.replace('`A2` облако (символьный)', '`A2` Облако, символьный'));
    const punct = G.check_tables(VOCAB, { wiki });
    assert.deepEqual(punct.problems, [], JSON.stringify(punct.problems));
    assert.equal(punct.notes.length, 1, JSON.stringify(punct.notes));
    assert.ok(punct.notes.every((n) => n.file === 'wiki/product/06-ai-assistant-spec.md' && n.line > 0 && /только знаками препинания/.test(n.msg)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── 5. документация ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('FP-25 fix [документация]: README называет 169 ключей (RU 154, EN 143), охват шаблонов и необязательную сверку режимов ассистента', () => {
  assert.match(README, /Найдено 169 ключей каталогов \(RU — 154, EN — 143/);
  assert.doesNotMatch(README, /Найдено 170 ключей/);
  assert.match(README, /load_template_catalogs/);
  assert.match(README, /`A0…A3`/);
  assert.match(README, /fp25_fix\.test\.mjs/);
});
