// people_pack.test.mjs — FP-27: пакет для юридического ревью собирается из кода и не расходится с ним (REQ-183).
// Проверяется: выборка по классам «налоги / советы / точность» на примерах; сборка детерминирована (без часов и путей машины), чувствительна к тексту строки и не
// чувствительна к строкам вне выборки; настоящий файл `_ops/people/legal-review-package.md` равен выводу сборщика (после правки строк интерфейса пакет надо пересобрать:
// `node tools/people_pack.mjs legal`); ВСЕ строки каталогов про налоги, «советы» и точность (независимая выборка, не тот же регэксп) и ВСЕ утверждения реестра обещаний в нём есть;
// шаблон записи ревью несёт поля «кто проверял», «дата», «замечания», «принятая правка»; командная строка (в памяти и отдельным процессом) отличает свежий пакет от устаревшего.

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const RUNWAY = path.join(PROTO, '..');
const imp = (...p) => import(pathToFileURL(path.join(...p)).href);

const PP = await imp(PROTO, 'tools', 'people_pack.mjs');
const DATA = await PP.collect_legal_data();
const PACKAGE_PATH = path.join(RUNWAY, '_ops', 'people', 'legal-review-package.md');
const norm = (s) => s.replace(/\r\n/g, '\n');
const display_file = (f) => f.replace(/^prototype\//, '').replace(/^demo\//, '');

// ── выборка ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-183 выборка: налоги, советы и точность находятся по RU и по EN; обычные подписи не попадают; класс может быть не один', () => {
  const c = (ru, en) => PP.classify(ru, en);
  assert.deepEqual(c('Налоговый конверт', 'Tax envelope'), ['tax']);
  assert.deepEqual(c('', 'VAT is set by the user'), ['tax']);
  assert.deepEqual(c('Правила для НДС', ''), ['tax']);
  assert.deepEqual(c('Не даём налоговых советов', 'We give no tax advice'), ['tax', 'advice']);
  assert.deepEqual(c('Это не рекомендация', 'This is not a recommendation'), ['advice', 'accuracy']);
  assert.deepEqual(c('Вердикт', 'Verdict'), ['advice']);
  assert.deepEqual(c('Можно потратить', 'Can spend'), ['advice']);
  assert.deepEqual(c('Не обещаем точность прогноза', 'We do not promise accuracy'), ['accuracy']);
  assert.deepEqual(c('Вероятностная полоса', 'Probability band'), ['accuracy']);
  assert.deepEqual(c('Сохранить', 'Save'), []);
  assert.deepEqual(c('Счёт', 'Account'), []);
  assert.deepEqual(c(undefined, null), []);
  // границы слов: «iva» внутри слова не налог
  assert.deepEqual(c('Активация', 'Activation'), []);
  assert.deepEqual(PP.CLASSES.map((x) => x.id), ['tax', 'advice', 'accuracy']);
  assert.ok(Object.isFrozen(PP.CLASSES));
});

test('REQ-183 оговорка в строке: «не консультация» / «not advice» распознаются, обычный текст — нет', () => {
  assert.equal(PP.has_disclaimer('Расчёт по введённым правилам, не консультация.', ''), true);
  assert.equal(PP.has_disclaimer('', 'Calculated from the rules you entered; not advice.'), true);
  assert.equal(PP.has_disclaimer('Это подсказка, а не рекомендация.', 'It is a hint, not a recommendation.'), true);
  assert.equal(PP.has_disclaimer('Налоговый конверт', 'Tax envelope'), false);
  assert.equal(PP.cell('a | b\nc  d'), 'a \\| b c d');
  assert.equal(PP.cell(undefined), '');
});

// ── сборка на синтетических данных ───────────────────────────────────────────────────────────────────────────────────────

const synthetic = () => ({
  engine_version: '9.9.9',
  catalogs: [
    { file: 'prototype/demo/i18n.mjs', ru: { 'a.tax': 'Налог | с чертой', 'a.plain': 'Сохранить', 'a.buy': 'Вердикт: {verdict}' }, en: { 'a.tax': 'Tax | bar', 'a.plain': 'Save', 'a.buy': 'Verdict: {verdict}' } },
    { file: 'prototype/demo/i18n/x.mjs', ru: { 'x.cl_one': 'Не обещаем точность', 'x.other': 'Счёт' }, en: { 'x.cl_one': 'No accuracy promised', 'x.other': 'Account' } },
  ],
  vocab: { tax_disclaimer: { ru: 'не консультация', en: 'not advice' }, verdicts: { OK: { ru: 'выдерживает', en: 'holds' } }, forbidden_phrases: ['фраза один', 'фраза два'] },
  registry: [{ id: 'one', kind: 'non_promise', level: 'verified', surface: 'ui', text_key: 'x.cl_one', checked_on: '2026-10-05', test: { file: 'tests/t.test.mjs', id: 'TST-1' } }],
});

test('REQ-183 сборка: разделы, нумерация строк, ячейки без вертикальных черт, счётчики, реестр с текстами RU и EN, словарь, шаблон ревью; LF и один перевод строки в конце', () => {
  const text = PP.build_legal_package(synthetic());
  for (const h of ['# Пакет для юридического ревью формулировок (REQ-183)', '## 1. Зачем этот пакет', '## 2. Как устроен пакет', '## 3. Строки интерфейса', '## 4. Реестр обещаний', '## 5. Канонические формулировки словаря', '### 5.1.', '### 5.2.', '### 5.3. Запрещённые формулировки', '## 6. Шаблон записи ревью', '## Связанные страницы']) {
    assert.ok(text.includes(h), h);
  }
  assert.ok(!text.includes('\r'));
  assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'));
  assert.match(text, /\| Строк в выборке \(§3\) \| 3 \(налоги — 1, советы — 1, точность — 1;/);
  assert.match(text, /\| Каталогов строк · строк всего \| 2 · 5 \|/);
  assert.match(text, /\| 1 \| `i18n\.mjs` · `a\.tax` \| н \| Налог \\\| с чертой \| Tax \\\| bar \| нет \|/);
  assert.match(text, /\| 2 \| `i18n\.mjs` · `a\.buy` \| с \| Вердикт: \{verdict\} \| Verdict: \{verdict\} \| нет \|/);
  assert.match(text, /\| 3 \| `i18n\/x\.mjs` · `x\.cl_one` \| т \| Не обещаем точность \| No accuracy promised \| нет \|/);
  assert.ok(!text.includes('a.plain') && !text.includes('x.other'), 'строки вне выборки не выгружаются');
  assert.match(text, /\| 1 \| `one` \| не обещаем \| проверено тестом \| — \| Не обещаем точность \| No accuracy promised \| `tests\/t\.test\.mjs · TST-1` \|/);
  assert.match(text, /\| `OK` \| выдерживает \| holds \|/);
  assert.match(text, /\| 1 \| фраза один \|/);
  assert.match(text, /\| RU \| не консультация \|/);
});

test('REQ-183 сборка детерминирована: часы не читаются (Date подменён), результат равен; изменение строки выборки меняет текст и отпечаток, строки вне выборки — нет', () => {
  const a = PP.build_legal_package(synthetic());
  mock.timers.enable({ apis: ['Date'], now: 1_900_000_000_000 });
  let b;
  try { b = PP.build_legal_package(synthetic()); } finally { mock.timers.reset(); }
  assert.equal(a, b);
  const fp = (t) => /Отпечаток выгрузки \(sha256, 16 знаков\) \| `([0-9a-f]{16})`/.exec(t)[1];
  const changed = synthetic();
  changed.catalogs[0].ru['a.tax'] = 'Налог иначе';
  const c = PP.build_legal_package(changed);
  assert.notEqual(fp(a), fp(c));
  assert.notEqual(a, c);
  const outside = synthetic();
  outside.catalogs[0].ru['a.plain'] = 'Сохранить всё';
  assert.equal(PP.build_legal_package(outside), a, 'строка вне выборки пакет не меняет');
  const added_registry = synthetic();
  added_registry.registry.push({ ...added_registry.registry[0], id: 'two' });
  assert.notEqual(fp(PP.build_legal_package(added_registry)), fp(a));
  assert.equal(PP.fingerprint({ x: 1 }).length, 16);
});

// ── настоящий пакет ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-183 пакет равен коду: _ops/people/legal-review-package.md совпадает с выводом сборщика (устарел — пересобрать: node tools/people_pack.mjs legal)', () => {
  assert.ok(fs.existsSync(PACKAGE_PATH), 'файл пакета есть');
  const have = norm(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  const want = PP.build_legal_package(DATA);
  assert.equal(have === want, true, 'пакет для юриста устарел: пересобрать командой «node tools/people_pack.mjs legal» из prototype/');
  assert.ok(!/[A-Z]:[\\/]|\/Users\/|\\Users\\/.test(want), 'в пакете нет путей этой машины');
});

test('REQ-183 полнота: каждая строка каталогов про налоги, «советы» и точность (независимая выборка) и каждое утверждение реестра обещаний есть в пакете', () => {
  const pack = norm(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  const independent = {
    tax: /налог|(?<![\p{L}\d])tax/iu,
    advice: /консульт|совет|advice|рекоменд|recommend/iu,
    accuracy: /точност|accura|обещ|promis/iu,
  };
  let checked = 0;
  for (const cat of DATA.catalogs) {
    for (const key of Object.keys(cat.ru)) {
      const text = cat.ru[key] + '\n' + (cat.en[key] ?? '');
      const hit = Object.entries(independent).filter(([, re]) => re.test(text)).map(([id]) => id);
      if (hit.length === 0) continue;
      checked++;
      const needle = '| `' + display_file(cat.file) + '` · `' + key + '` |';
      assert.ok(pack.includes(needle), `нет в пакете (${hit.join(', ')}): ${cat.file} · ${key}`);
    }
  }
  assert.ok(checked > 50, 'проверено строк: ' + checked);
  for (const r of DATA.registry) assert.ok(pack.includes('| `' + r.id + '` |'), 'утверждение реестра: ' + r.id);
  // тексты утверждений реестра — настоящие (из каталога showcase), а не пустые
  const section = pack.slice(pack.indexOf('## 4. Реестр обещаний'), pack.indexOf('## 5. Канонические'));
  for (const r of DATA.registry) {
    const ru = DATA.catalogs.map((c) => c.ru[r.text_key]).find((x) => typeof x === 'string');
    assert.ok(typeof ru === 'string' && ru !== '', r.id + ': есть русский текст');
    assert.ok(section.includes(PP.cell(ru)), r.id + ': русский текст утверждения в пакете');
  }
  // источники: шаблоны ответов и шаблон-скелет входят
  assert.ok(pack.includes('`engine/verifier.mjs`') && pack.includes('`start_template.mjs`'));
  // словарь: все запрещённые формулировки и все подписи вердиктов
  for (const p of DATA.vocab.forbidden_phrases) assert.ok(pack.includes('| ' + PP.cell(p) + ' |'), 'запрещено: ' + p);
  for (const [code, v] of Object.entries(DATA.vocab.verdicts)) assert.ok(pack.includes('| `' + code + '` | ' + PP.cell(v.ru) + ' | ' + PP.cell(v.en) + ' |'), 'вердикт ' + code);
  assert.ok(pack.includes(PP.cell(DATA.vocab.tax_disclaimer.ru)) && pack.includes(PP.cell(DATA.vocab.tax_disclaimer.en)));
});

test('REQ-183 шаблон записи ревью лежит в пакете: кто проверял, юрисдикция, дата, замечания, принятая правка, решение по налоговой части, вопросы Q1–Q8; создаёт запись человек', () => {
  const pack = norm(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  const tpl = pack.slice(pack.indexOf('## 6. Шаблон записи ревью'));
  for (const f of ['Кто проверял', 'Юрисдикция', 'Дата начала ревью', 'Дата завершения', 'ЗАМЕЧАНИЯ', 'Замечание', 'Принятая правка', 'Статус', 'РЕШЕНИЕ ПО НАЛОГОВОЙ ЧАСТИ', 'ПРАВКИ ВНЕСЕНЫ В КОД', 'Отпечаток выгрузки пакета', 'about.legal_3', 'human_review_pending', 'Подпись и дата']) {
    assert.ok(tpl.includes(f), f);
  }
  for (let q = 1; q <= 8; q++) assert.ok(pack.includes(`| Q${q} |`), 'вопрос Q' + q);
  assert.match(tpl, /Запись создаёт человек, а не агент/);
  assert.match(pack, /не юридическая консультация/);
  const fp = /Отпечаток выгрузки \(sha256, 16 знаков\) \| `([0-9a-f]{16})`/.exec(pack)[1];
  assert.ok(tpl.includes('Отпечаток выгрузки пакета (из шапки):    ' + fp), 'шаблон несёт тот же отпечаток, что шапка');
});

// ── командная строка ────────────────────────────────────────────────────────────────────────────────────────────────────

function fake_io(files) {
  const writes = [];
  const outs = [];
  const errs = [];
  return {
    read: (p) => files[p], write: (p, t) => { writes.push([p, t]); files[p] = t; }, exists: (p) => Object.hasOwn(files, p),
    out: (s) => outs.push(s), err: (s) => errs.push(s), writes, outs, errs,
  };
}

test('REQ-183 командная строка (в памяти): --check — 0 при совпадении, 1 при устаревшем и при отсутствующем файле; без --check пишет файл и ничего больше; неверный запуск — 2', async () => {
  const want = PP.build_legal_package(DATA);
  const target = path.resolve('legal-test.md');
  const same = fake_io({ [target]: want });
  assert.equal(await PP.main(['legal', '--check', '--out', target], same), 0);
  assert.equal(same.writes.length, 0);
  const crlf = fake_io({ [target]: want.replace(/\n/g, '\r\n') });
  assert.equal(await PP.main(['legal', '--check', '--out', target], crlf), 0, 'переводы строк CRLF не считаются расхождением');
  const stale = fake_io({ [target]: want.replace('Q1', 'Qx') });
  assert.equal(await PP.main(['legal', '--check', '--out', target], stale), 1);
  assert.match(stale.errs.join('\n'), /устарел.*node tools\/people_pack\.mjs legal/s);
  assert.equal(stale.writes.length, 0, '--check ничего не пишет');
  const absent = fake_io({});
  assert.equal(await PP.main(['legal', '--check', '--out', target], absent), 1);
  assert.match(absent.errs.join('\n'), /не найден/);
  const fresh = fake_io({});
  assert.equal(await PP.main(['legal', '--out', target], fresh), 0);
  assert.deepEqual(fresh.writes, [[target, want]]);
  for (const bad of [[], ['unknown'], ['legal', '--out'], ['legal', '--out', '--check']]) {
    const io = fake_io({});
    assert.equal(await PP.main(bad, io), 2, JSON.stringify(bad));
    assert.equal(io.writes.length, 0);
  }
  assert.equal(await PP.main(['--help'], fake_io({})), 0);
});

test('REQ-183 командная строка (процесс): node tools/people_pack.mjs legal --check на настоящем пакете — код 0', () => {
  const r = spawnSync(process.execPath, [path.join(PROTO, 'tools', 'people_pack.mjs'), 'legal', '--check'], { encoding: 'utf8', timeout: 100000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Пакет совпадает с кодом/);
});
