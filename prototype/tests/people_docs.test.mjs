// people_docs.test.mjs — FP-27: пакеты для людей (_ops/people), страница «если разработчик исчез» и строка в «О программе» (REQ-181, REQ-183, REQ-186, REQ-189, REQ-190, REQ-090, REQ-110, REQ-176, REQ-188).
// Проверяется: файлы на месте и непусты; все относительные ссылки ведут на существующие файлы; тексты не содержат запрещённых формулировок (линтер слов запускается и на них);
// примеры в документах настоящие (лист наблюдателя из протокола проходит схему инструмента, даты напоминания равны шагу 90 дней, условия согласия берут границы множителя из
// анонимизатора, пороги критериев остановки совпадают с дорожной картой); страница вики с frontmatter, таблицами и разделом «Связанные страницы»; строка `about.legal_4` на RU и EN
// выводится на экране «О программе» и называет существующий файл; документация модулей на месте; LICENSE пакет не создаёт (решение владельца, FP-46).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const RUNWAY = path.join(PROTO, '..');
const PEOPLE = path.join(RUNWAY, '_ops', 'people');
const imp = (...p) => import(pathToFileURL(path.join(...p)).href);

const LINT = await imp(RUNWAY, 'tools', 'lint_vocab.mjs');
const LIB = await imp(RUNWAY, 'tools', 'lib.mjs');
const OM = await imp(PROTO, 'tools', 'onboarding_median.mjs');
const AN = await imp(PROTO, 'tools', 'anonymize.mjs');
const E = await imp(PROTO, 'engine', 'index.mjs');
const VOCAB = LINT.load_vocab();

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8').replace(/\r\n/g, '\n');
const PEOPLE_FILES = ['README.md', 'legal-review-package.md', 'interview-guide.md', 'stop-criteria-record.md', 'market-watch.md', 'timing-protocol.md', 'volunteer-journals.md'];
const WIKI_PAGE = path.join(RUNWAY, 'wiki', 'product', '20-if-developer-disappears.md');

// ── файлы и ссылки ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('FP-27 файлы на месте: шесть пакетов для людей, указатель, страница вики; ни одного пустого', () => {
  for (const f of PEOPLE_FILES) {
    const file = path.join(PEOPLE, f);
    assert.ok(fs.existsSync(file), f);
    assert.ok(read(PEOPLE, f).trim().length > 500, f + ': не пустой');
  }
  assert.ok(fs.existsSync(WIKI_PAGE));
  for (const f of ['people_pack.mjs', 'onboarding_median.mjs']) assert.ok(fs.existsSync(path.join(PROTO, 'tools', f)), f);
});

test('FP-27 ссылки: каждая относительная ссылка в документах пакетов и на странице вики ведёт на существующий файл', () => {
  const files = [...PEOPLE_FILES.map((f) => path.join(PEOPLE, f)), WIKI_PAGE];
  let links = 0;
  for (const file of files) {
    const text = read(file);
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^(?:https?:|mailto:|#)/.test(target)) continue;
      const clean = target.split('#')[0];
      if (clean === '') continue;
      links++;
      assert.ok(fs.existsSync(path.resolve(path.dirname(file), clean)), `${path.relative(RUNWAY, file)} → ${target}`);
    }
  }
  assert.ok(links > 30, 'проверено ссылок: ' + links);
});

test('FP-27 тексты проходят линтер слов: ни одной запрещённой формулировки в документах пакетов и на странице вики', () => {
  const files = [...PEOPLE_FILES.map((f) => path.join(PEOPLE, f)), WIKI_PAGE];
  for (const file of files) {
    const rel = path.relative(RUNWAY, file).split(path.sep).join('/');
    const errors = LINT.lint_text(read(file), { file: rel, vocab: VOCAB }).filter((f) => f.level === 'error');
    assert.deepEqual(errors, [], rel);
  }
  // правило «первый прогноз за N минут» входит в линтер слов (first-forecast); пример в таблице «Нельзя» протокола замера он пропускает как запрещённый
  const first_forecast = /первый\s+прогноз\s+за\s+\d+\s+минут/i;
  const protocol = read(PEOPLE, 'timing-protocol.md');
  assert.ok(first_forecast.test(protocol), 'пример запрещённой формулировки в протоколе есть');
  const outside = protocol.split('\n').filter((ln) => !/первый прогноз за 7 минут/.test(ln)).join('\n');
  assert.ok(!first_forecast.test(outside), 'вне примера запрещённой формулировки такой строки нет');
  for (const f of PEOPLE_FILES.filter((x) => x !== 'timing-protocol.md')) assert.ok(!first_forecast.test(read(PEOPLE, f)), f);
});

test('FP-27 LICENSE пакет не создаёт: выбор лицензии — решение владельца (FP-46); страница это называет', () => {
  const page = read(WIKI_PAGE);
  assert.match(page, /\*\*нет\*\*: лицензия не выбрана/);
  assert.match(page, /FP-46/);
  assert.match(read(PEOPLE, 'README.md'), /LICENSE пакет не создаёт/);
});

// ── содержимое документов ───────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-190 market-watch: напоминание на 2027-01-02, остальные сроки — шаг 90 дней от базы 2026-10-04', () => {
  const text = read(PEOPLE, 'market-watch.md');
  const base = E.to_epoch_day('2026-10-04');
  const dates = [1, 2, 3, 4].map((k) => E.format_date(base + 90 * k));
  assert.equal(dates[0], '2027-01-02');
  for (const d of dates) assert.ok(text.includes('| ' + d + ' |') || text.includes(d), 'дата ' + d);
  assert.match(text, /Ближайшая проверка: не позже 2027-01-02/);
  assert.match(text, /node tools\/log\.mjs "ingest \| Мониторинг рынка/);
  assert.match(text, /критерий остановки № 6/);
  assert.match(text, /без регистрации/);
  const roadmap = read(RUNWAY, 'wiki', 'product', '10-roadmap.md');
  assert.ok(roadmap.includes('2027-01-02'), 'дорожная карта называет ту же дату');
});

test('REQ-181 критерии остановки: шесть строк с теми же порогами, что в дорожной карте; шаблон decision принимается tools/log.mjs; опросник приглашённых есть', () => {
  const doc = read(PEOPLE, 'stop-criteria-record.md');
  const roadmap = read(RUNWAY, 'wiki', 'product', '10-roadmap.md');
  const tokens = [['30 приглашённых', '7 дней'], ['неделе 12', 'неделе 16'], ['FRR', '5 %'], ['D28', '25 %'], ['юридическое ревью', 'консультацией'], ['PocketSmith', '2027-01-02']];
  tokens.forEach((pair, i) => {
    for (const t of pair) {
      assert.ok(roadmap.toLowerCase().includes(t.toLowerCase()), `дорожная карта: ${t}`);
      assert.ok(doc.toLowerCase().includes(t.toLowerCase()), `критерий ${i + 1}: ${t}`);
    }
    assert.match(doc, new RegExp('\\| ' + (i + 1) + ' \\|'), 'строка календаря № ' + (i + 1));
  });
  assert.match(doc, /node tools\/log\.mjs "decision \|/);
  assert.ok(/\(ingest\|query\|lint\|build\|decision\|prototype\)/.test(read(RUNWAY, 'tools', 'log.mjs')), 'tools/log.mjs принимает операцию decision');
  assert.match(doc, /## 3\. Опросник приглашённых/);
  assert.match(doc, /Через 7 дней/);
  assert.match(doc, /Через 28 дней/);
  assert.match(doc, /не заменяет/);
});

test('REQ-189 гайд интервью: 8–10 человек, скринер, план встречи, вопросы, шаблон записи и запись decision; чего не делаем — сказано', () => {
  const doc = read(PEOPLE, 'interview-guide.md');
  for (const s of ['8–10', 'REQ-189', '## 2. Кого звать', '## 4. План встречи', '## 6. Вопросы', '## 7. Запись результатов', '## 8. Запись `decision`', 'Чего не делаем на интервью', 'node tools/log.mjs "decision |', 'гипотеза']) {
    assert.ok(doc.includes(s), s);
  }
  const questions = doc.match(/^\d+\. .+\?/gm) ?? [];
  assert.ok(questions.length >= 15, 'вопросов (скринер и основной список): ' + questions.length);
  assert.match(doc, /Не даём финансовых, налоговых и юридических советов/);
  assert.match(doc, /Имена не записываются/);
});

test('REQ-090 REQ-110 протокол замера: секундомер вне приложения, n не менее 5, команда инструмента; пример листа наблюдателя проходит схему инструмента', () => {
  const doc = read(PEOPLE, 'timing-protocol.md');
  for (const s of ['секундомером **вне приложения**', 'не менее 5', 'node tools/onboarding_median.mjs', '--write', '--measure quick_entry', '--date ГГГГ-ММ-ДД', 'при n меньше 5 отказывается', 'runway-timing/1', 'первый прогноз за 7 минут']) {
    assert.ok(doc.includes(s), s);
  }
  assert.equal(OM.MIN_N, 5);
  const block = /```json\n([\s\S]*?)```/.exec(doc);
  assert.ok(block !== null, 'в протоколе есть пример листа');
  const r = OM.read_timing_values([{ name: 'example.json', text: block[1] }]);
  assert.deepEqual(r.skipped, []);
  assert.equal(r.used.length, 2);
  assert.deepEqual(r.used.map((u) => u.ms), [4200, 5800]);
  // «нельзя» в таблице формулировок — именно та, которую блокирует линтер обещаний
  assert.ok(LINT.lint_text('первый прогноз за 7 минут', { file: 'x', vocab: VOCAB }).some((f) => f.rule === 'first-forecast'));
  assert.match(doc, /активное время шагов мастера/);
  assert.match(doc, /Реальные данные участника не используются/);
});

test('REQ-176 REQ-188 журналы добровольцев: согласие называет границы анонимизации из кода, инструкция — команду инструмента, вопрос ADV-6 и варианты ответа записаны владельцу', () => {
  const doc = read(PEOPLE, 'volunteer-journals.md');
  assert.equal(AN.K_BP_MIN, 5000);
  assert.equal(AN.K_BP_MAX, 20000);
  assert.match(doc, /от 0,5 до 2/, 'границы множителя из anonymize.mjs (5000…20000 bp)');
  assert.match(doc, /кратное 7/);
  assert.match(doc, /node tools\/anonymize\.mjs вход\.json выход\.json --seed 12345/);
  const help = [];
  AN.main(['--help'], { out: (s) => help.push(s), err: () => {}, read: () => '', write: () => {} });
  assert.match(help.join('\n'), /\[--seed N\]/, 'флаг --seed существует в справке инструмента');
  for (const s of ['ADV-6', '(а)', '(б)', '(в)', 'by_monthday', 'не проходил юридическое ревью', 'не менее 10 журналов', 'FRR', 'cry-wolf', 'shift_days', 'не отправлять']) {
    assert.ok(doc.includes(s), s);
  }
  assert.match(doc, /Исходный файл программа не перезаписывает/);
  assert.match(doc, /Рекомендации и выбор в этих вопросах пакет не делает/);
});

test('FP-27 указатель _ops/people/README.md перечисляет все файлы пакетов и называет, что остаётся за людьми', () => {
  const doc = read(PEOPLE, 'README.md');
  for (const f of PEOPLE_FILES.filter((x) => x !== 'README.md')) assert.ok(doc.includes('(' + f + ')'), f);
  assert.ok(doc.includes('20-if-developer-disappears.md'));
  assert.match(doc, /не заменяют/);
  assert.match(doc, /Что остаётся за людьми/);
  assert.match(doc, /публиковать цифру времени/);
});

// ── страница «если разработчик исчез» ───────────────────────────────────────────────────────────────────────────────────

test('REQ-186 страница вики: frontmatter по CLAUDE.md, «работает всегда» (копия, экспорт, SPEC-format, verify), «прекратится» (синхронизация, облачный ассистент), предупреждение, раздел «Связанные страницы»', () => {
  const raw = fs.readFileSync(WIKI_PAGE, 'utf8');
  const { fm, body } = LIB.parsePage(raw);
  assert.ok(fm !== null && fm !== undefined, 'frontmatter разобран');
  for (const k of ['title', 'type', 'status', 'summary', 'updated']) assert.ok(fm[k], 'поле ' + k);
  assert.ok(LIB.TYPES.includes(fm.type) && LIB.STATUSES.includes(fm.status));
  assert.equal(fm.type, 'product');
  assert.match(fm.updated, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(fm.summary.length <= 200, 'summary не длиннее 200 знаков: ' + fm.summary.length);
  assert.ok(Array.isArray(fm.sources) && fm.sources.length >= 3);
  for (const s of ['## Что работает всегда', '## Что прекратится', '## Предупреждение', '## Состояние по критериям REQ-186', '**Локальная копия данных**', '**Экспорт**', '**Спецификация формата**', '**Проверка `verify`**', '**Синхронизация**', '**Облачный ассистент**', 'SPEC-format.md', 'verify.mjs', 'LICENSE', 'IDEA-98', 'Ключи подписи']) {
    assert.ok(body.includes(s) || raw.includes(s), s);
  }
  const rm = /^##\s+Связанные страницы\s*$([\s\S]*)$/m.exec(body);
  assert.ok(rm !== null);
  assert.ok(LIB.extractLinks(rm[1]).filter((l) => !LIB.isExternal(l.target)).length >= 2);
  assert.ok(body.split(/\s+/).filter(Boolean).length >= 120);
  assert.match(body, /В v1 синхронизации и облачного ассистента \*\*нет\*\*/, 'честно: будущих функций в v1 нет');
  assert.match(body, /не принято/, 'срок уведомления — решение владельца, не принято');
  assert.match(body, /не гарантия|не юридическая оговорка/);
  assert.match(body, /расчёт по введённым данным и правилам, не консультация/i);
});

// ── строка в «О программе» ─────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-186 «О программе»: строка about.legal_4 есть на RU и EN, называет существующий файл страницы, не обещает лишнего, в коде экрана список из четырёх строк (сам экран на настоящем app.mjs — в about.test)', async () => {
  const cat = (await imp(PROTO, 'demo', 'i18n', 'about.mjs')).default;
  for (const lang of ['ru', 'en']) {
    const text = cat[lang]['about.legal_4'];
    assert.ok(typeof text === 'string' && text.length > 80, lang);
    const m = /(wiki\/product\/[\w.-]+\.md)/.exec(text);
    assert.ok(m !== null, lang + ': путь к странице');
    assert.ok(fs.existsSync(path.join(RUNWAY, m[1])), lang + ': файл ' + m[1] + ' существует');
    assert.ok(text.includes('node tools/verify.mjs'));
    assert.ok(/JSON/.test(text) && /CSV/.test(text) && /hledger/.test(text));
    const low = text.toLowerCase();
    for (const bad of ['безопасн', 'гарантир', 'guarantee', 'всегда офлайн', 'always offline', 'данные не пропадут']) assert.ok(!low.includes(bad), lang + ': ' + bad);
    assert.deepEqual(LINT.lint_text(text, { file: 'about', vocab: VOCAB }).filter((f) => f.level === 'error'), []);
  }
  assert.match(cat.ru['about.legal_4'], /синхронизации и облачного ассистента в этой версии нет/);
  assert.match(cat.en['about.legal_4'], /no sync and no cloud assistant/);
  assert.deepEqual(Object.keys(cat.ru).sort(), Object.keys(cat.en).sort());
  // экран выводит четыре строки блока «Лицензии и сведения» (литералом ключ в коде не стоит: семейство about.legal_<i>)
  const src = read(PROTO, 'demo', 'about.mjs');
  assert.ok(src.includes("[1, 2, 3, 4].map((i) => h('li', { text: tr('about.legal_' + i) }))"), 'четыре строки блока');
  // прежние строки блока не тронуты
  assert.match(cat.ru['about.legal_2'], /не выбрана/);
  assert.match(cat.ru['about.legal_3'], /не выполнены/);
});

// ── документация модулей ────────────────────────────────────────────────────────────────────────────────────────────────

test('FP-27 документация: README прототипа, README инструментов и README_ext называют пакет, инструменты и тесты', () => {
  const readme = read(PROTO, 'README.md');
  assert.match(readme, /Волна 3а-2 · FP-27/);
  for (const s of ['people_pack.mjs', 'onboarding_median.mjs', 'people_pack.test.mjs', 'onboarding_median.test.mjs', 'people_docs.test.mjs', 'legal-review-package.md', '20-if-developer-disappears.md', 'about.legal_4']) {
    assert.ok(readme.includes(s), 'README прототипа: ' + s);
  }
  const tools = read(PROTO, 'tools', 'README.md');
  assert.ok(tools.includes('people_pack.mjs') && tools.includes('onboarding_median.mjs'));
  const ext = read(PROTO, 'demo', 'README_ext.md');
  assert.match(ext, /FP-27/);
  assert.ok(ext.includes('onboarding_median'));
});
