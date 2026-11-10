// fuzz_findings_child.mjs — дочерний процесс для tests/fuzz_findings.test.mjs (FP-49, исправление после проверки). Это не тест (имя без .test): `node --test` его не запускает.
// Зачем отдельный процесс. Проверка рабочей области с разреженным массивом длиной 2^31 (`new Array(2 ** 31)`) обязана отвечать отказом `too_many_records` за миллисекунды, не разворачивая массив.
// Если регрессия вернёт разворачивание до сравнения длины с пределом, в процессе теста это исчерпало бы всю память машины (подкачка, зависание), а не покраснело бы. Здесь те же вызовы идут
// под ограниченной кучей (`--max-old-space-size`, её задаёт тест): при регрессии процесс падает с «heap out of memory» за секунды, тест видит ненулевой код выхода и называет причину.
// Процесс только считает и печатает одну строку JSON с наблюдениями; выводы делает тест. Браузер, серверы и сеть не запускаются.
// Запуск тестом: node --max-old-space-size=192 tests/fuzz_findings_child.mjs <сценарий> [списки через запятую]
//   сценарий `facts` — 2^31 пустых мест в `facts` (время, прирост кучи, ответ, число записей чистой области);
//   сценарий `every_list` — 2^31 пустых мест по очереди в каждом из перечисленных списков (ответ проверки, строгий режим, карантин).

import fs from 'node:fs';

import { validate_ws, analyze_checked } from '../engine/validate_ws.mjs';

const G = JSON.parse(fs.readFileSync(new URL('../data/g001.json', import.meta.url), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const TWO_31 = 2 ** 31;
const with_list = (list, value) => { const ws = clone(G); ws[list] = value; return ws; };
const head = (errors) => (Array.isArray(errors) ? errors.slice(0, 20) : []); // при исправном коде ошибка одна; обрезка нужна, чтобы сломанный ответ не раздул вывод

function facts_scenario() {
  const ws = with_list('facts', new Array(TWO_31));
  const heap0 = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  const v = validate_ws(ws);
  const ms = performance.now() - t0;
  const heap_mb = (process.memoryUsage().heapUsed - heap0) / 1e6;
  const clean = validate_ws(G);
  return { facts_len: ws.facts.length, g_facts_len: G.facts.length, ok: v.ok, errors: head(v.errors), records: v.stats.records, clean_records: clean.stats.records, ms, heap_mb };
}

function every_list_scenario(lists) {
  const rows = [];
  for (const list of lists) {
    const ws = with_list(list, new Array(TWO_31));
    const t0 = performance.now();
    const v = validate_ws(ws);
    const strict = analyze_checked(ws, { as_of: ws.as_of });
    const q = analyze_checked(ws, { as_of: ws.as_of }, { quarantine: true });
    rows.push({
      list, errors: head(v.errors), ms: performance.now() - t0,
      strict: { ok: strict.ok, code: strict.code, internal: strict.internal === true },
      quarantine: { ok: q.ok, code: q.code, internal: q.internal === true, errors: head(q.errors) },
    });
  }
  return rows;
}

const [scenario, lists_arg = ''] = process.argv.slice(2);
let result;
if (scenario === 'facts') result = facts_scenario();
else if (scenario === 'every_list') result = every_list_scenario(lists_arg.split(',').filter((s) => s !== ''));
else { process.stderr.write('неизвестный сценарий: ' + String(scenario) + '\n'); process.exit(2); }
process.stdout.write(JSON.stringify(result) + '\n');
