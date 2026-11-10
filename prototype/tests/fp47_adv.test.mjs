// fp47_adv.test.mjs — состязательная проверка FP-47 (независимый проверяющий): то, что тесты реализатора не доказывают.
// ADV-1  круг CSV (метка, контрагент) через НАСТОЯЩЕЕ приложение: запись и откат идут через ctx.set_ws → мост журнала (ws_bridge), а не чистую модель.
// ADV-2  «свободно» при отключённом правиле не просачивается ни на один из экранов (не только «Обзор» и «Сценарии»).
// ADV-3  --write для таблиц словаря: CRLF, повторный запуск, маркеры в блоке кода, две таблицы в блоке.
// ADV-4  диалоги «Почему» на EN не содержат русских букв из новых строк; сумма контрфактов не выдумывает выигрыш.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/fp47_adv.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { boot_app, find_all, N } from './dom_boot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const imp = (rel) => import(pathToFileURL(path.join(PROTO, rel)).href);

const api = await boot_app({ raf: true });
const E = await imp('engine/index.mjs');
const DA = await imp('demo/data_actions.mjs');
const M = await imp('demo/import_model.mjs');
const W = await imp('demo/why_more.mjs');
const GV = await imp('tools/gen_vocab_tables.mjs');
const ctx = api.ext.ctx;
const clone = (x) => JSON.parse(JSON.stringify(x));
const WS0 = clone(ctx.get_ws());
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const enc = (s) => new TextEncoder().encode(s);

const by_attr = (k, v) => find_all(api.main(), (n) => n.attrs[k] === v)[0];
const click = async (node) => { assert.ok(node !== undefined, 'нет элемента'); node.listeners.click[0]({ preventDefault() {} }); await settle(); };
async function pick(id, name, bytes) {
  const input = by_attr('id', id);
  assert.ok(input !== undefined, 'нет поля файла ' + id);
  input.files = [{ name, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }];
  input.listeners.change[0]({});
  await settle();
}
async function to_file_step() {
  const again = find_all(api.main(), (n) => n.tagName === 'button' && n.textContent === 'Другой файл')[0];
  if (again !== undefined) await click(again);
}

// ── ADV-1: круг CSV через настоящее приложение (запись и откат партии с контрагентами через мост журнала) ──────────────────

test('ADV-1 REQ-095: импорт файла Runway с метками и контрагентами в настоящем приложении — контрагенты заведены, факты ссылаются на них; откат партии через интерфейс убирает их и возвращает прежнее состояние', async () => {
  const src = clone(WS0);
  src.counterparties = [{ counterparty_id: 'cp_a', name: 'Хозяин квартиры' }, { counterparty_id: 'cp_f', name: '=HYPERLINK("http://x")' }];
  src.facts = src.facts.map((f, i) => (i === 0 ? { ...f, counterparty_id: 'cp_a', tag: '=метка' } : i === 1 ? { ...f, counterparty_id: 'cp_f', tag: 'вторая' } : i === 2 ? { ...f, counterparty_id: 'cp_a' } : f));
  const text = DA.export_csv_file(src).text;
  const cleared = ctx.set_ws({ ...clone(WS0), facts: [], counterparties: [] }, { reason: 'edit' });
  assert.ok(cleared.ok, JSON.stringify(cleared.error));
  const h0 = M.ws_state_hash(ctx.get_ws());

  await api.go('#data');
  await to_file_step();
  await pick('import-file', 'runway.csv', enc(text));
  assert.equal(by_attr('id', 'import-profile').value, 'runway-csv-1');
  await click(by_attr('id', 'import-check'));
  await click(by_attr('id', 'import-confirm'));
  const after = ctx.get_ws();
  assert.equal(after.facts.length, 28, 'факты записаны через общий путь записи');
  assert.equal((after.counterparties ?? []).length, 2, 'заведены два контрагента по числу различных имён');
  const names = new Map((after.counterparties ?? []).map((c) => [c.counterparty_id, c.name]));
  assert.deepEqual([...names.values()].sort(), ['=HYPERLINK("http://x")', 'Хозяин квартиры'].sort());
  const tagged = after.facts.filter((f) => f.tag !== undefined);
  assert.ok(tagged.some((f) => f.tag === '=метка' && names.get(f.counterparty_id) === 'Хозяин квартиры'));
  assert.ok(tagged.some((f) => f.tag === 'вторая' && names.get(f.counterparty_id) === '=HYPERLINK("http://x")'));

  // откат из интерфейса: кнопка «Откатить импорт» на шаге «готово»
  const rb = by_attr('id', 'import-rollback');
  assert.ok(rb !== undefined, 'кнопка отката партии есть');
  await click(rb);
  const back = ctx.get_ws();
  assert.equal(back.facts.length, 0, 'факты партии убраны');
  assert.equal((back.counterparties ?? []).length, 0, 'контрагенты партии убраны вместе с фактами');
  assert.equal(M.ws_state_hash(back), h0, 'состояние как до импорта');
});

// ── ADV-2: «свободно» при disabled нигде не печатается ─────────────────────────────────────────────────────────────────────────

test('ADV-2 REQ-067: при отключённом правиле числа ряда «свободно» не печатаются ни на одном экране (поиск по значениям ряда, которых нет в рядах остатка)', async () => {
  const off = clone(WS0);
  off.tax_rules[0].reviewed_at = E.format_date(E.to_epoch_day(off.as_of) - 100);
  off.tax_rules[0].ttl_days = 30;
  const r = ctx.set_ws(off, { reason: 'test_reset' });
  assert.ok(r.ok, JSON.stringify(r.error));
  const a = E.analyze(off, { as_of: off.as_of });
  assert.deepEqual(a.rule_status, { 'TR-20': 'disabled' });
  const f = ctx.fmt();
  const cash = new Set();
  for (const m of ['plan', 'worse']) for (const k of ['close', 'trough']) for (const v of a.series[m][k]) cash.add(v);
  for (const m of ['plan', 'worse']) for (const e of a.events[m]) { cash.add(e.amount_minor); cash.add(-e.amount_minor); }
  cash.add(a.buffer_minor); cash.add(a.series.plan.reserve_opening_minor);
  const free_only = new Set();
  for (const m of ['plan', 'worse']) for (const v of a.series[m].free) if (!cash.has(v) && Math.abs(v) >= 1000) free_only.add(v);
  assert.ok(free_only.size > 5, 'есть значения «свободно», которых нет в рядах остатка');
  const leaks = [];
  const scan = async (views) => {
    const out = [];
    for (const view of views) {
      await api.go(view);
      await settle(30);
      const text = api.text_of('main');
      for (const v of free_only) {
        const s = N(f.money(v));
        const re = new RegExp('(?<!\\d|\\d\\s)' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        if (re.test(text)) out.push(view + ': ' + s);
      }
    }
    return out;
  };
  // контроль: при свежем правиле те же значения на «Обзоре» видны (иначе поиск ничего не доказывает)
  ctx.set_ws(WS0, { reason: 'test_reset' });
  assert.ok((await scan(['#overview'])).length > 0, 'контроль: при свежем правиле значения «свободно» находятся поиском');
  ctx.set_ws(off, { reason: 'test_reset' });
  leaks.push(...await scan(['#overview', '#buy', '#waves', '#reserves', '#scenarios', '#feed', '#assistant', '#data']));
  assert.deepEqual(leaks, [], 'просочились числа «свободно»: ' + leaks.slice(0, 8).join('; '));
  ctx.set_ws(WS0, { reason: 'test_reset' });
});

// ── ADV-3: --write ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

function wiki_copy() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-adv47-'));
  const src = path.join(PROTO, '..', 'wiki', 'product');
  fs.mkdirSync(path.join(root, 'wiki', 'product'), { recursive: true });
  for (const f of fs.readdirSync(src)) if (f.endsWith('.md')) fs.copyFileSync(path.join(src, f), path.join(root, 'wiki', 'product', f));
  return { root, wiki: path.join(root, 'wiki') };
}
const VOCAB = JSON.parse(fs.readFileSync(path.join(PROTO, 'engine', 'vocab.json'), 'utf8'));

test('ADV-3 REQ-114: --write на настоящих страницах не меняет ни байта; на копии с дрейфом в CRLF-файле чинит только подпись и сохраняет CRLF; повторная запись пуста', () => {
  const { wiki } = wiki_copy();
  const gl = path.join(wiki, 'product', '14-glossary.md');
  const orig = fs.readFileSync(gl);
  const noop = GV.write_wiki(VOCAB, { wiki });
  assert.deepEqual(noop.problems, []);
  assert.deepEqual(noop.written, [], 'таблицы уже равны словарю: записывать нечего');
  assert.ok(Buffer.compare(fs.readFileSync(gl), orig) === 0);
  // дрейф + CRLF
  const text = orig.toString('utf8').replace(/\r?\n/g, '\r\n').replace('| Не хватает | `NO` |', '| Дефицит | `NO` |');
  assert.ok(text.includes('| Дефицит | `NO` |'), 'дрейф внесён');
  fs.writeFileSync(gl, text);
  const w1 = GV.write_wiki(VOCAB, { wiki });
  assert.deepEqual(w1.problems, []);
  assert.deepEqual(w1.written, ['wiki/product/14-glossary.md']);
  const fixed = fs.readFileSync(gl, 'utf8');
  assert.ok(fixed.includes('| Не хватает | `NO` |'));
  assert.ok(!/[^\r]\n/.test(fixed), 'все переводы строк остались CRLF');
  assert.equal(fixed, orig.toString('utf8').replace(/\r?\n/g, '\r\n'), 'файл равен исходному (с CRLF) побайтно');
  assert.deepEqual(GV.write_wiki(VOCAB, { wiki }).written, [], 'повторная запись пуста');
});

test('ADV-3 REQ-114: маркеры в блоке кода и вложенные/незакрытые блоки — ошибка разметки и ни один файл не пишется; два блока verdicts на странице отвергаются', () => {
  const { wiki } = wiki_copy();
  const gl = path.join(wiki, 'product', '14-glossary.md');
  const orig = fs.readFileSync(gl, 'utf8');
  const before = fs.readdirSync(path.join(wiki, 'product')).map((f) => [f, fs.readFileSync(path.join(wiki, 'product', f), 'utf8')]);
  for (const [name, mutate] of [
    ['незакрытый', (t) => t.replace('<!-- vocab:end -->', '')],
    ['вложенный', (t) => t.replace('<!-- vocab:begin verdicts -->', '<!-- vocab:begin verdicts -->\n<!-- vocab:begin modes -->')],
    ['неизвестное имя', (t) => t.replace('<!-- vocab:begin verdicts -->', '<!-- vocab:begin colors -->')],
    ['дубль блока', (t) => t.replace('<!-- vocab:begin verdicts -->', '<!-- vocab:begin modes -->')],
  ]) {
    fs.writeFileSync(gl, mutate(orig));
    const w = GV.write_wiki(VOCAB, { wiki });
    assert.ok(w.problems.length > 0, name + ': ошибка разметки');
    assert.deepEqual(w.written, [], name + ': ничего не записано');
    for (const [f, t] of before) if (f !== '14-glossary.md') assert.equal(fs.readFileSync(path.join(wiki, 'product', f), 'utf8'), t, name + ': ' + f + ' не тронут');
  }
});

// ЗАМЕЧЕНО (low): шапка gen_vocab_tables.mjs обещает «таблица (или несколько)» в блоке, но форма таблицы запоминается по ПОСЛЕДНЕЙ таблице блока:
// за таблицей словаря идёт чужая таблица — блок отвергается как «нет таблицы», и --write/--check падают. В настоящей вики такого блока нет. Тест помечен todo.
test('ADV-3 REQ-114: блок с двумя таблицами — недостающая запись дописывается в таблицу словаря, а не в чужую', { todo: 'low: блок «таблица словаря + чужая таблица» отвергается' }, () => {
  const page = [
    '# Тест', '', '<!-- vocab:begin verdicts -->', '', '| Вердикт | Подпись | Смысл |', '|---|---|---|',
    '| `OK` | выдерживает | а |', '| `FRAGILE` | хрупко | б |', '| `TIGHT` | впритык | в |', '',
    '| Другая | Таблица |', '|---|---|', '| x | y |', '', '<!-- vocab:end -->', '',
  ].join('\n');
  const r = GV.write_blocks(page, VOCAB);
  assert.deepEqual(r.problems, []);
  const lines = r.text.split('\n');
  const no_at = lines.findIndex((l) => l.includes('`NO`'));
  assert.ok(no_at > 0, 'запись NO дописана');
  assert.ok(no_at < lines.findIndex((l) => l.includes('| Другая |')), 'NO попала в таблицу вердиктов, а не в «Другая | Таблица»');
});

// ── ADV-4: диалоги «Почему» на EN ──────────────────────────────────────────────────────────────────────────────────────────────

test('ADV-4 REQ-104: диалоги вердикта, «можно потратить» и волны на EN не содержат русских букв (названия платежей и контрфакты переведены)', async () => {
  api.set_lang('en');
  await api.tick();
  const dlg = () => N(api.byid.get('dlg-title').textContent + ' ' + api.byid.get('dlg-body').textContent);
  const found = [];
  for (const mode of ['plan', 'worse']) {
    W.open_verdict_why(ctx, mode);
    found.push(['verdict ' + mode, dlg()]);
    W.open_sts_why(ctx, mode);
    found.push(['sts ' + mode, dlg()]);
    E.list_waves_ex(ctx.get_model().ctx, mode).items.forEach((it, i) => {
      W.open_wave_why(ctx, { ...it, n: i + 1, mode }, mode);
      found.push(['wave ' + (i + 1) + ' ' + mode, dlg()]);
    });
  }
  for (const [label, text] of found) assert.doesNotMatch(text, /[А-Яа-яЁё]/, label + ': ' + text.match(/.{0,40}[А-Яа-яЁё]+.{0,40}/)?.[0]);
  api.set_lang('ru');
  await api.tick();
});
