// gen_vocab_tables.test.mjs — FP-25, REQ-114 (TST-56): таблицы вердиктов и режимов в вики совпадают с engine/vocab.json; дрейф ловится.
// Инструмент prototype/tools/gen_vocab_tables.mjs ничего не пишет в вики: печатает эталонные таблицы и сверяет страницы (--check, код выхода 1 при расхождении).
// В тестах допустимы node:*; вики во временных каталогах, настоящие страницы не меняются.
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
const TOOL = path.join(PROTO, 'tools', 'gen_vocab_tables.mjs');
const G = await import(pathToFileURL(TOOL).href);
const VOCAB = JSON.parse(fs.readFileSync(path.join(PROTO, 'engine', 'vocab.json'), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));

/** Временная вики: product/*.md из файла-образца (глоссарий) с правками; возвращает корень `…/wiki`. */
function temp_wiki(edit = (s) => s) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vt_'));
  const wiki = path.join(root, 'wiki');
  fs.mkdirSync(path.join(wiki, 'product'), { recursive: true });
  fs.mkdirSync(path.join(wiki, 'concepts'), { recursive: true });
  fs.writeFileSync(path.join(wiki, 'product', '14-glossary.md'), edit(fs.readFileSync(path.join(RUNWAY, 'wiki', 'product', '14-glossary.md'), 'utf8')));
  fs.copyFileSync(path.join(RUNWAY, 'wiki', 'concepts', 'can-i-afford-it.md'), path.join(wiki, 'concepts', 'can-i-afford-it.md'));
  return { root, wiki };
}

test('REQ-114 записи словаря: режимы, вердикты, слои и статусы читаются из vocab.json; обязательны режимы, вердикты и слои', () => {
  const e = G.expected_entries(VOCAB);
  const ids = (g) => e.filter((x) => x.group === g).map((x) => x.id);
  assert.deepEqual(ids('modes'), ['plan', 'worse', 'expected']);
  assert.deepEqual(ids('verdicts').sort(), ['FRAGILE', 'NO', 'OK', 'TIGHT']);
  assert.deepEqual(ids('layers'), ['posted', 'planned', 'hypothetical']);
  assert.deepEqual(ids('occurrence_statuses'), ['expected', 'matched', 'overdue', 'skipped', 'cancelled']);
  assert.ok(e.filter((x) => x.group !== 'occurrence_statuses').every((x) => x.required));
  assert.ok(e.filter((x) => x.group === 'occurrence_statuses').every((x) => !x.required));
  assert.equal(e.find((x) => x.group === 'modes' && x.id === 'expected').phase, 'v2');
  assert.equal(e.find((x) => x.id === 'FRAGILE').ru, 'хрупко', 'подпись FRAGILE по RU — «хрупко» (критерий REQ-114)');
});

test('REQ-114 разбор страниц: строки глоссария «Термин | Код / EN» и таблицы «Вердикт | Подпись»; чужие таблицы с такими же кодами не считаются', () => {
  const md = ['| Термин | Код / EN | Определение |', '|---|---|---|', '| По плану | `plan` | описание |', '| Ожидаемый | `expected` (v2) | описание |', '| Не код | prose | x |', '',
    '| Вердикт | Подпись | Условие |', '|---|---|---|', '| `NO` | не хватает | `m < 0` |', '',
    '| Параметр | Значение |', '|---|---|', '| `plan` | 1 |', '| Вердикт | `OK` |'].join('\n');
  const rows = G.find_vocab_rows(md, 'x.md');
  assert.deepEqual(rows.map((r) => [r.id, r.label, r.phase, r.shape]), [['plan', 'По плану', null, 'glossary'], ['expected', 'Ожидаемый', 'v2', 'glossary'], ['NO', 'не хватает', null, 'verdicts']]);
  assert.equal(rows[0].line, 3);
});

test('REQ-114 --check на настоящих страницах: таблицы вердиктов и режимов в wiki/product совпадают с vocab.json (0 расхождений); обязательные коды покрыты', () => {
  const r = G.check_tables(VOCAB);
  assert.deepEqual(r.problems, []);
  assert.ok(r.rows >= 12, `строк словаря на страницах: ${r.rows}`);
  for (const id of ['plan', 'worse', 'expected', 'OK', 'TIGHT', 'FRAGILE', 'NO', 'posted', 'planned', 'hypothetical']) assert.ok(r.covered.some((c) => c.endsWith(':' + id)), `покрыт ${id}`);
});

test('REQ-114 дрейф ловится: изменённая подпись вердикта, режима и слоя, лишняя фаза, удалённая строка, новый вердикт в словаре — каждое даёт расхождение; страницы вики не меняются', () => {
  const real = fs.readFileSync(path.join(RUNWAY, 'wiki', 'product', '14-glossary.md'), 'utf8');
  const cases = [
    ['подпись вердикта', (s) => s.replace('| Хрупко | `FRAGILE` |', '| Ломко | `FRAGILE` |'), /«Ломко» у `FRAGILE`/],
    ['подпись режима', (s) => s.replace('| Если хуже (консервативный) | `worse` |', '| Если плохо | `worse` |'), /«Если плохо» у `worse`/],
    ['подпись слоя', (s) => s.replace('| Факт | `posted` |', '| Реальность | `posted` |'), /«Реальность» у `posted`/],
    ['фаза режима v2 потеряна', (s) => s.replace('`expected` (v2)', '`expected`'), /фаза режима `expected`: в вики v1, в словаре v2/],
    ['лишняя фаза у режима v1', (s) => s.replace('| По плану | `plan` |', '| По плану | `plan` (v2) |'), /фаза режима `plan`: в вики v2, в словаре v1/],
    ['удалена строка NO', (s) => s.split('\n').filter((l) => !l.startsWith('| Не хватает | `NO` |')).join('\n'), /нет строки для `NO`/],
  ];
  assert.ok(real.includes('| Хрупко | `FRAGILE` |') && real.includes('`expected` (v2)'), 'образец содержит ожидаемые строки');
  for (const [name, edit, msg] of cases) {
    const { root, wiki } = temp_wiki(edit);
    try {
      const r = G.check_tables(VOCAB, { wiki });
      assert.ok(r.problems.some((p) => msg.test(p.msg)), `${name}: ${JSON.stringify(r.problems)}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  // словарь вырос, страница — нет: новый вердикт без строки в вики
  const grown = clone(VOCAB);
  grown.verdicts.MAYBE = { ru: 'возможно', en: 'maybe', rank: 4 };
  assert.ok(G.check_tables(grown).problems.some((p) => /нет строки для `MAYBE`/.test(p.msg)));
  // словарь изменил подпись — страница отстала
  const renamed = clone(VOCAB);
  renamed.verdicts.TIGHT.ru = 'на грани';
  assert.ok(G.check_tables(renamed).problems.some((p) => /«Впритык» у `TIGHT`/.test(p.msg)));
  // FP-47 (намеренное изменение ожидания): раньше тест требовал, чтобы в коде инструмента вообще не было записи; теперь есть режим `--write`, поэтому закреплено другое —
  // единственная запись в файлы стоит в write_wiki (её вызывает только `--write`), а проверка и печать вики не меняют (см. тест «по умолчанию вики не пишется»)
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.equal((src.match(/writeFileSync|appendFileSync|renameSync|unlinkSync|rmSync/g) ?? []).length, 1, 'одно место записи');
  assert.ok(src.indexOf('writeFileSync') > src.indexOf('export function write_wiki') && src.indexOf('writeFileSync') < src.indexOf('export function check_blocks'), 'запись — внутри write_wiki');
});

test('REQ-114 таблица в concepts/can-i-afford-it.md (дополнительный каталог): подпись сверяется, если строка есть, но не обязательна', () => {
  const { root, wiki } = temp_wiki((s) => s);
  try {
    const p = path.join(wiki, 'concepts', 'can-i-afford-it.md');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('| `TIGHT` | впритык |', '| `TIGHT` | тесно |'));
    assert.ok(G.check_tables(VOCAB, { wiki }).problems.some((x) => /«тесно» у `TIGHT`/.test(x.msg) && x.file.includes('concepts')));
    fs.rmSync(p);
    assert.deepEqual(G.check_tables(VOCAB, { wiki }).problems, [], 'без страницы в concepts — не ошибка');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('REQ-114 печать эталонных таблиц: режимы, вердикты по рангу, слои, статусы — в формах, которые понимает сам разбор (круг: вставка эталона проходит --check)', () => {
  const text = G.render_tables(VOCAB);
  assert.match(text, /### Режимы расчёта/);
  assert.match(text, /\| Ожидаемый \| `expected` \(v2\) \| expected \| v2 \|/);
  assert.match(text, /\| `OK` \| выдерживает \| holds \| 0 \|\n\| `FRAGILE` \| хрупко \| fragile \| 1 \|\n\| `TIGHT` \| впритык \| tight \| 2 \|\n\| `NO` \| не хватает \| short \| 3 \|/);
  const rows = G.find_vocab_rows(text, 'эталон');
  assert.equal(rows.length, 3 + 4 + 3 + 5, 'каждая запись словаря понята разбором');
  // эталон, положенный вместо страницы, проходит сверку
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vt_'));
  try {
    fs.mkdirSync(path.join(root, 'wiki', 'product'), { recursive: true });
    fs.writeFileSync(path.join(root, 'wiki', 'product', '14-glossary.md'), text);
    assert.deepEqual(G.check_tables(VOCAB, { wiki: path.join(root, 'wiki') }).problems, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('REQ-114 командная строка: --check на настоящей вики — код 0; на искажённой — код 1 с файлом и строкой; без флагов печатает таблицы', () => {
  const run = (...args) => spawnSync(process.execPath, [TOOL, ...args], { cwd: PROTO, encoding: 'utf8', timeout: 100000 });
  const ok = run('--check');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /таблицы вердиктов и режимов в вики совпадают с engine\/vocab\.json/);
  const { root, wiki } = temp_wiki((s) => s.replace('| Хрупко | `FRAGILE` |', '| Ломко | `FRAGILE` |'));
  try {
    const bad = run('--check', '--wiki', wiki);
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /ERROR wiki\/product\/14-glossary\.md:\d+: подпись «Ломко» у `FRAGILE`/);
    assert.match(bad.stdout, /Итого: 1 расхождений/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  const print = run();
  assert.equal(print.status, 0);
  assert.equal(print.stdout, G.render_tables(VOCAB));
});

// ── FP-47, REQ-114: режим --write и размеченные блоки ──────────────────────────────────────────────────────────

const GLOSSARY = path.join(RUNWAY, 'wiki', 'product', '14-glossary.md');
const real_glossary = () => fs.readFileSync(GLOSSARY, 'utf8');
const run_tool = (...args) => spawnSync(process.execPath, [TOOL, ...args], { cwd: PROTO, encoding: 'utf8', timeout: 100000 });
const tree_bytes = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath ?? e.path, e.name)).sort()
  .map((f) => f + ':' + fs.readFileSync(f, 'utf8')).join('\n');

test('REQ-114 FP-47 размеченные блоки стоят в настоящей вики: <!-- vocab:begin modes --> и <!-- vocab:begin verdicts --> вокруг существующих таблиц', () => {
  const text = real_glossary();
  const found = G.find_blocks(text.split('\n'));
  assert.deepEqual(found.problems, []);
  assert.deepEqual(found.blocks.map((b) => b.name), ['modes', 'verdicts']);
  assert.deepEqual([...G.EXPECTED_BLOCKS], ['modes', 'verdicts'], 'таблицы вердиктов и режимов, как в бэклоге REQ-114');
  assert.deepEqual(G.check_blocks(VOCAB).problems, []);
  assert.deepEqual(G.check_blocks(VOCAB).notes, [], 'оба ожидаемых блока на месте');
  // внутри блока режимов — три режима словаря, внутри блока вердиктов — четыре вердикта
  const lines = text.split('\n');
  const rows_in = (b) => G.find_vocab_rows(lines.slice(b.begin, b.end + 1).join('\n')).map((r) => r.id);
  assert.ok(['plan', 'worse', 'expected'].every((id) => rows_in(found.blocks[0]).includes(id)));
  assert.ok(['OK', 'TIGHT', 'FRAGILE', 'NO'].every((id) => rows_in(found.blocks[1]).includes(id)));
  // маркеры (и пустые строки вокруг них) — единственная правка страницы
  assert.equal(lines.filter((l) => /^<!-- vocab:/.test(l)).length, 4);
});

test('REQ-114 FP-47 по умолчанию вики не пишется: печать и --check не меняют ни одного байта временной вики, --write на актуальной вики тоже ничего не пишет', () => {
  const { root, wiki } = temp_wiki();
  try {
    const before = tree_bytes(wiki);
    assert.equal(run_tool().status, 0);
    assert.equal(tree_bytes(wiki), before);
    assert.equal(run_tool('--check', '--wiki', wiki).status, 0);
    assert.equal(tree_bytes(wiki), before);
    const w = run_tool('--write', '--wiki', wiki);
    assert.equal(w.status, 0, w.stdout + w.stderr);
    assert.match(w.stdout, /уже совпадают с engine\/vocab\.json: записывать нечего/);
    assert.equal(tree_bytes(wiki), before, 'актуальная вики: ни байта');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('REQ-114 FP-47 --write исправляет дрейф в размеченных блоках, --check после него проходит, повторный --write ничего не меняет, страница возвращается к исходной побайтно', () => {
  const real = real_glossary();
  const cases = [
    ['подпись вердикта', (s) => s.replace('| Хрупко | `FRAGILE` |', '| Ломко | `FRAGILE` |')],
    ['подпись режима', (s) => s.replace('| Если хуже (консервативный) | `worse` |', '| Если плохо | `worse` |')],
    ['фаза режима v2 потеряна', (s) => s.replace('`expected` (v2)', '`expected`')],
    ['лишняя фаза у режима v1', (s) => s.replace('| По плану | `plan` |', '| По плану | `plan` (v2) |')],
    ['пробелы вокруг подписи', (s) => s.replace('| Впритык | `TIGHT` |', '|  Тесно  | `TIGHT` |')],
  ];
  for (const [name, edit] of cases) {
    const { root, wiki } = temp_wiki(edit);
    try {
      assert.ok(G.check_tables(VOCAB, { wiki }).problems.length > 0, name + ': дрейф есть до записи');
      const w = G.write_wiki(VOCAB, { wiki });
      assert.deepEqual(w.problems, [], name);
      assert.deepEqual(w.written, ['wiki/product/14-glossary.md'], name);
      assert.equal(fs.readFileSync(path.join(wiki, 'product', '14-glossary.md'), 'utf8'), real, name + ': после записи страница равна исходной');
      assert.deepEqual(G.check_tables(VOCAB, { wiki }).problems, [], name + ': --check проходит');
      assert.deepEqual(G.write_wiki(VOCAB, { wiki }).written, [], name + ': повторная запись — без изменений');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('REQ-114 FP-47 --write правит только ячейки словаря в строках группы: определения, страницы-владельцы, чужие строки смешанной таблицы и текст вне блоков остаются', () => {
  const { root, wiki } = temp_wiki((s) => s.replace('| Хрупко | `FRAGILE` |', '| Ломко | `FRAGILE` |').replace('| Ожидаемый | `expected` (v2) |', '| Ожидаемое | `expected` |')
    .replace('## Время, ряды и режимы', '## Время, ряды и режимы (правка вне блока)'));
  try {
    const file = path.join(wiki, 'product', '14-glossary.md');
    const edited = fs.readFileSync(file, 'utf8');
    G.write_wiki(VOCAB, { wiki });
    const after = fs.readFileSync(file, 'utf8');
    const a = edited.split('\n');
    const b = after.split('\n');
    assert.equal(a.length, b.length, 'строки не добавлены и не удалены');
    const changed = a.map((l, i) => [l, b[i]]).filter(([x, y]) => x !== y);
    assert.equal(changed.length, 2, 'две строки: FRAGILE и expected');
    for (const [x, y] of changed) assert.deepEqual(x.split('|').slice(3), y.split('|').slice(3), 'определение и страница-владелец те же');
    assert.ok(after.includes('## Время, ряды и режимы (правка вне блока)'), 'текст вне блока не тронут');
    // правка подписи ВНЕ блока не исправляется: --write обновляет только размеченное
    fs.writeFileSync(file, after.replace('| Факт | `posted` |', '| Реальность | `posted` |'));
    assert.deepEqual(G.write_wiki(VOCAB, { wiki }).written, [], 'слои блоком не размечены: писать нечего');
    assert.ok(fs.readFileSync(file, 'utf8').includes('| Реальность | `posted` |'), 'подпись слоя осталась');
    assert.ok(G.check_tables(VOCAB, { wiki }).problems.some((p) => /«Реальность» у `posted`/.test(p.msg)), '--check её по-прежнему ловит');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('REQ-114 FP-47 новая запись словаря: --write дописывает строку в конец таблицы блока (подпись и код по словарю, остальные ячейки «—»), --check после этого проходит', () => {
  const grown = clone(VOCAB);
  grown.verdicts.MAYBE = { ru: 'возможно', en: 'maybe', rank: 4 };
  grown.modes.median = { ru: 'медианный', en: 'median', phase: 'v2' };
  const { root, wiki } = temp_wiki();
  try {
    assert.ok(G.check_tables(grown, { wiki }).problems.some((p) => /нет строки для `MAYBE`/.test(p.msg)));
    const w = G.write_wiki(grown, { wiki });
    assert.deepEqual(w.problems, []);
    assert.deepEqual(w.files[0].changes.map((c) => [c.kind, c.id, c.block]).sort(), [['added', 'MAYBE', 'verdicts'], ['added', 'median', 'modes']].sort());
    const text = fs.readFileSync(path.join(wiki, 'product', '14-glossary.md'), 'utf8');
    assert.ok(text.includes('| Медианный | `median` (v2) | — | — |'), 'режим v2 с суффиксом фазы');
    assert.ok(text.includes('| Возможно | `MAYBE` | — | — |'));
    const lines = text.split('\n');
    const end_modes = lines.findIndex((l) => /^<!-- vocab:end -->/.test(l));
    assert.ok(lines.findIndex((l) => l.startsWith('| Медианный')) < end_modes, 'строка внутри блока');
    assert.deepEqual(G.check_tables(grown, { wiki }).problems, []);
    assert.deepEqual(G.check_blocks(grown, { wiki }).problems, []);
    assert.deepEqual(G.write_wiki(grown, { wiki }).written, [], 'идемпотентно');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('REQ-114 FP-47 таблица «Вердикт | Подпись | …» в блоке: меняется только подпись, условие остаётся; строки CRLF сохраняются; «\\|» внутри ячейки не граница', () => {
  const md = ['# Тест', '', '<!-- vocab:begin verdicts -->', '', '| Вердикт | Подпись | Условие |', '|---|---|---|', '| `NO` | не хватает? | `m < 0` |', '| `TIGHT` | впритык | `0 ≤ m < B` |', '', '<!-- vocab:end -->', '', 'хвост'].join('\r\n');
  const r = G.write_blocks(md, VOCAB);
  assert.deepEqual(r.problems, []);
  assert.ok(r.text.includes('| `NO` | не хватает | `m < 0` |'));
  assert.ok(r.text.includes('| `TIGHT` | впритык | `0 ≤ m < B` |'), 'равная словарю строка не переписана');
  assert.equal(r.text.replace(/\r\n/g, '').includes('\n'), false, 'везде CRLF');
  assert.equal(r.text.split('\r\n').length, md.split('\r\n').length + 2, 'дописаны OK и FRAGILE');
  assert.ok(r.text.includes('| `OK` | выдерживает | — |') && r.text.includes('| `FRAGILE` | хрупко | — |'));
  assert.equal(r.changes.filter((c) => c.kind === 'label').length, 1);
  const pipe = ['<!-- vocab:begin modes -->', '', '| Термин | Код / EN | Определение |', '|---|---|---|', '| Если плохо | `worse` | a \\| b |', '', '<!-- vocab:end -->'].join('\n');
  const rp = G.write_blocks(pipe, VOCAB);
  assert.ok(rp.text.includes('| Если хуже (консервативный) | `worse` | a \\| b |'), rp.text);
});

test('REQ-114 FP-47 ошибки разметки: вложенный, незакрытый и неизвестный блок, vocab:end без begin, блок без таблицы — код 1, ни один файл не записан', () => {
  const t = (md) => G.write_blocks(md, VOCAB).problems.map((p) => p.msg);
  assert.match(t('<!-- vocab:begin modes -->\n| Термин | Код / EN |\n|---|---|\n')[0], /не закрыт/);
  assert.match(t('<!-- vocab:begin modes -->\n<!-- vocab:begin verdicts -->\n<!-- vocab:end -->')[0], /вложенный блок/);
  assert.match(t('<!-- vocab:begin colors -->\n<!-- vocab:end -->')[0], /неизвестное имя блока «colors»/);
  assert.match(t('<!-- vocab:end -->')[0], /vocab:end без vocab:begin/);
  assert.match(t('<!-- vocab:begin modes -->\nпросто текст\n<!-- vocab:end -->')[0], /нет таблицы/);
  assert.match(t('<!-- vocab:begin modes -->\n| Термин | Код / EN |\n|---|---|\n<!-- vocab:end verdicts -->')[0], /закрывает блок «modes»/);
  assert.match(t('<!-- vocab:begin modes -->\n<!-- vocab:end -->\n<!-- vocab:begin modes -->\n<!-- vocab:end -->').join(' '), /уже есть/);
  const { root, wiki } = temp_wiki((s) => s.replace('<!-- vocab:end -->', '<!-- vocab:begin layers -->').replace('| Хрупко | `FRAGILE` |', '| Ломко | `FRAGILE` |'));
  try {
    const before = tree_bytes(wiki);
    const w = run_tool('--write', '--wiki', wiki);
    assert.equal(w.status, 1, w.stdout);
    assert.match(w.stdout, /ERROR wiki\/product\/14-glossary\.md:\d+: вложенный блок/);
    assert.match(w.stdout, /файлы не записаны/);
    assert.equal(tree_bytes(wiki), before, 'при ошибке разметки страница не записана, дрейф не «починен» наполовину');
    const c = run_tool('--check', '--wiki', wiki);
    assert.equal(c.status, 1, '--check ловит ту же ошибку разметки');
    assert.match(c.stdout, /вложенный блок/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('REQ-114 FP-47 командная строка --write: исправляет временную вики (код 0, список изменённых строк), затем --check — код 0; настоящая вики актуальна', () => {
  const { root, wiki } = temp_wiki((s) => s.replace('| Хрупко | `FRAGILE` |', '| Ломко | `FRAGILE` |').replace('| Впритык | `TIGHT` |', '| Тесно | `TIGHT` |'));
  try {
    assert.equal(run_tool('--check', '--wiki', wiki).status, 1);
    const w = run_tool('--write', '--wiki', wiki);
    assert.equal(w.status, 0, w.stdout + w.stderr);
    assert.match(w.stdout, /update wiki\/product\/14-glossary\.md:\d+: блок «verdicts», `FRAGILE`/);
    assert.match(w.stdout, /update wiki\/product\/14-glossary\.md:\d+: блок «verdicts», `TIGHT`/);
    assert.match(w.stdout, /записано файлов: 1, строк обновлено или добавлено: 2/);
    const c = run_tool('--check', '--wiki', wiki);
    assert.equal(c.status, 0, c.stdout);
    assert.equal(fs.readFileSync(path.join(wiki, 'product', '14-glossary.md'), 'utf8'), real_glossary());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(run_tool('--check').status, 0);
});

test('REQ-114 FP-47 --write пишет только в wiki/product: размеченный блок в concepts игнорируется, файлы вне product не меняются', () => {
  const { root, wiki } = temp_wiki();
  try {
    const p = path.join(wiki, 'concepts', 'can-i-afford-it.md');
    const marked = '<!-- vocab:begin verdicts -->\n' + fs.readFileSync(p, 'utf8').replace('| `TIGHT` | впритык |', '| `TIGHT` | тесно |') + '\n<!-- vocab:end -->\n';
    fs.writeFileSync(p, marked);
    const w = G.write_wiki(VOCAB, { wiki });
    assert.deepEqual(w.problems, []);
    assert.equal(fs.readFileSync(p, 'utf8'), marked, 'concepts не тронут');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
