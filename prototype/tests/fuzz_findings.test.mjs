// fuzz_findings.test.mjs — FP-24, REQ-158, TST-51: находки полного фаззинга 2026-10-27 (`node tools/fuzz_nightly.mjs --full`, результат — ../_ops/fuzz-nightly.json, раздел `full`).
// Пакет FP-24 engine/ не правил: каждая находка была минимальным воспроизведением — проверкой защитной сетки и тестом `todo` с ожидаемым поведением. Исправление FZ-1 сделано отдельным
// пунктом (исправление дефектов после независимой проверки, 2026-10-28): `todo` снят, тест стал обычной проверкой, добавлены тесты на индекс дыры, карантин и строгий режим.
// Расчёт по введённым данным и правилам, не консультация.
//
// FZ-1 · validate_ws / analyze_checked и рабочая область с «дырой» в массиве (разреженный массив) — ИСПРАВЛЕНО.
//   Как найдено: тест «REQ-158 TST-51 фаззинг: N повреждённых рабочих областей» из tests/validate_ws.test.mjs при FUZZ_N = 100000 упал на итерации 57010 потока seed 1582026
//   (повторить: `FUZZ_N=57011 node --test --test-name-pattern="REQ-158 TST-51 фаззинг:" tests/validate_ws.test.mjs`; в потоке дальше ещё два случая того же класса: 62810 и 88017).
//   Откуда дыра: фаззер выбирает пути до порчи, а `splice` сдвигает индексы; позднее присваивание по устаревшему индексу за концом массива оставляет пустое место.
//   Причина: `entries_of` (engine/validate_ws.mjs) строил записи списка через `Array.prototype.map`, который сохраняет дыры разреженного массива; цикл `for (const { key, rec } of …)` получал
//   `undefined` и падал с TypeError. Исключение не уходило наружу (его ловила защитная сетка), но проверка отвечала ошибкой `validator_internal:TypeError…`, а `analyze_checked`
//   с карантином — `{ok: false, internal: true}`. Затрагивало списки facts, accounts, rules, plans, anchors, reserves (tax_rules — нет). Разреженный массив не получается из JSON, файла или
//   IndexedDB — только из кода в памяти, поэтому важность была низкой.
//   Исправление: в `entries_of` вместо `x.map((rec, i) => ({ key: i, rec }))` — `Array.from(x, (rec, i) => ({ key: i, rec }))`: дыра становится записью `undefined`, которую проверка называет
//   `record_not_object`, а карантин исключает.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { validate_ws, analyze_checked, quarantine_invalid, WS_LIMITS } from '../engine/validate_ws.mjs';

const G = JSON.parse(fs.readFileSync(new URL('../data/g001.json', import.meta.url), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const REQ017 = ['E_NOT_INTEGER', 'E_OVERFLOW', 'E_BAD_DATE', 'E_FUTURE_POSTED', 'E_RULE_INVALID', 'E_CURRENCY_MISMATCH', 'E_NO_RATE', 'E_SCHEMA'];
const LISTS = ['facts', 'accounts', 'rules', 'plans', 'anchors', 'reserves', 'tax_rules'];
/** Списки, у которых дыра раньше приводила к внутренней ошибке (tax_rules обрабатывался правильно). */
const AFFECTED = LISTS.filter((l) => l !== 'tax_rules');
const internal_of = (v) => v.errors.find((e) => String(e.reason).startsWith('validator_internal'));

/** Рабочая область G-001, у которой в списке `list` удалён нулевой элемент оператором `delete`: длина прежняя, на месте 0 — дыра. */
function with_hole(list) {
  const ws = clone(G);
  delete ws[list][0];
  assert.equal(0 in ws[list], false, 'на месте нулевого элемента дыра');
  assert.equal(ws[list].length, G[list].length, 'длина списка прежняя');
  return ws;
}

/** Рабочая область G-001 с лишней дырой в конце списка: все настоящие записи на месте, в хвосте пустое место (`length += 1`). */
function with_tail_hole(list) {
  const ws = clone(G);
  ws[list].length += 1;
  assert.equal(ws[list].length, G[list].length + 1);
  assert.equal(G[list].length in ws[list], false, 'в конце списка дыра');
  return ws;
}

test('REQ-158 FZ-1 защитная сетка: рабочая область с дырой в массиве — validate_ws и analyze_checked (строго и с карантином) не бросают исключений и отвечают кодом из набора REQ-017', () => {
  for (const list of LISTS) {
    const ws = with_hole(list);
    let v;
    assert.doesNotThrow(() => { v = validate_ws(ws); }, `${list}: validate_ws бросил`);
    assert.equal(v.ok, false, `${list}: область с дырой не принимается как целая`);
    for (const e of v.errors) assert.ok(REQ017.includes(e.code), `${list}: код ${e.code}`);
    for (const opts of [{}, { quarantine: true }]) {
      let out;
      assert.doesNotThrow(() => { out = analyze_checked(ws, { as_of: ws.as_of }, opts); }, `${list}: analyze_checked бросил`);
      if (!out.ok) assert.ok(REQ017.includes(out.code), `${list}: код ${out.code}`);
    }
  }
});

// FZ-1 исправлен (entries_of): пометка todo снята, название прежнее
test('REQ-158 FZ-1 дыра в массиве — запись «не объект» (record_not_object), а не внутренняя ошибка проверяющего; карантин исключает дыру и считает остальное (todo: дефект entries_of в engine/validate_ws.mjs, фаззинг 2026-10-27)', () => {
  for (const list of LISTS.filter((l) => l !== 'tax_rules')) {
    const ws = with_hole(list);
    const v = validate_ws(ws);
    assert.ok(!v.errors.some((e) => String(e.reason).startsWith('validator_internal')), `${list}: внутренняя ошибка проверяющего: ${JSON.stringify(v.errors.find((e) => String(e.reason).startsWith('validator_internal')))}`);
    assert.ok(v.errors.some((e) => e.reason === 'record_not_object'), `${list}: дыра названа записью «не объект»`);
    const q = analyze_checked(ws, { as_of: ws.as_of }, { quarantine: true });
    assert.ok(q.internal !== true, `${list}: карантин — внутренняя ошибка движка`);
  }
});

test('REQ-158 FZ-1 список tax_rules с дырой уже обрабатывается правильно: запись «не объект», карантин исключает её и считает остальное (контроль для todo выше)', () => {
  const ws = with_hole('tax_rules');
  const v = validate_ws(ws);
  assert.ok(v.errors.some((e) => e.reason === 'record_not_object'));
  assert.ok(!v.errors.some((e) => String(e.reason).startsWith('validator_internal')));
  const q = analyze_checked(ws, { as_of: ws.as_of }, { quarantine: true });
  assert.equal(q.ok, true);
});

// ── после исправления: подробности ответа ───────────────────────────────────────────────────────────────────────────────────────

test('REQ-158 FZ-1 исправление: ошибка «не объект» называет список и индекс дыры (kind, index, путь), код E_SCHEMA; других ошибок у области с одной дырой в хвосте списка нет', () => {
  for (const list of AFFECTED) {
    const ws = with_tail_hole(list);
    const v = validate_ws(ws);
    assert.equal(internal_of(v), undefined, `${list}: внутренняя ошибка проверяющего`);
    assert.equal(v.ok, false, list);
    assert.equal(v.errors.length, 1, `${list}: ровно одна ошибка — дыра: ${JSON.stringify(v.errors)}`);
    const e = v.errors[0];
    assert.deepEqual([e.code, e.kind, e.index, e.reason], ['E_SCHEMA', list, G[list].length, 'record_not_object'], list);
    assert.equal(e.path, `${list}[${G[list].length}]`, `${list}: путь к дыре`);
  }
});

test('REQ-158 FZ-1 исправление: лишняя дыра в хвосте списка — карантин исключает только её, остальные записи целы, ряды расчёта те же, что у чистой области G-001; в отчёте карантина дыра с индексом и кодом', () => {
  const clean = analyze_checked(G, { as_of: G.as_of });
  assert.equal(clean.ok, true);
  for (const list of AFFECTED) {
    const ws = with_tail_hole(list);
    const q = analyze_checked(ws, { as_of: ws.as_of }, { quarantine: true });
    assert.equal(q.ok, true, `${list}: карантин считает остальное`);
    assert.ok(q.internal !== true, list);
    assert.deepEqual(q.rejected.map((r) => [r.kind, r.index, r.codes, r.reasons]), [[list, G[list].length, ['E_SCHEMA'], ['record_not_object']]], `${list}: в отчёте только дыра`);
    assert.ok(q.warnings.some((w) => w.code === 'W_RECORD_QUARANTINED' && w.kind === list), `${list}: предупреждение карантина`);
    for (const mode of ['plan', 'worse']) {
      for (const key of ['close', 'trough', 'free']) assert.deepEqual(q.analysis.series[mode][key], clean.analysis.series[mode][key], `${list}: ряд ${mode}.${key} после исключения дыры тот же, что у чистой области`);
    }
    // строгий режим: область не принимается, ответ — код из набора и список ошибок, внутренней ошибки нет
    const strict = analyze_checked(ws, { as_of: ws.as_of });
    assert.deepEqual([strict.ok, strict.code, strict.internal === true], [false, 'E_SCHEMA', false], `${list}: строгий режим`);
    assert.ok(strict.errors.some((e) => e.reason === 'record_not_object' && e.kind === list), list);
  }
});

test('REQ-158 FZ-1 исправление: несколько дыр, дыры подряд и массив из одних дыр — по ошибке на каждую, индексы возрастают, внутренних ошибок нет, карантин не падает', () => {
  const ws = clone(G);
  delete ws.facts[1];
  delete ws.facts[2];
  delete ws.facts[10];
  ws.facts.length += 2; // две дыры в хвосте
  const v = validate_ws(ws);
  assert.equal(internal_of(v), undefined);
  const holes = v.errors.filter((e) => e.reason === 'record_not_object' && e.kind === 'facts').map((e) => e.index);
  assert.deepEqual(holes, [1, 2, 10, G.facts.length, G.facts.length + 1]);
  const q = analyze_checked(ws, { as_of: ws.as_of }, { quarantine: true });
  assert.ok(q.internal !== true);
  assert.deepEqual(q.rejected.filter((r) => r.kind === 'facts').map((r) => r.index).sort((a, b) => a - b), [1, 2, 10, G.facts.length, G.facts.length + 1], 'индексы в отчёте — исходные');
  // массив из одних дыр
  const bare = clone(G);
  bare.facts = new Array(4);
  const vb = validate_ws(bare);
  assert.equal(internal_of(vb), undefined);
  assert.deepEqual(vb.errors.filter((e) => e.kind === 'facts').map((e) => [e.index, e.reason]), [0, 1, 2, 3].map((i) => [i, 'record_not_object']));
  const qb = analyze_checked(bare, { as_of: bare.as_of }, { quarantine: true });
  assert.ok(qb.internal !== true);
  if (qb.ok) assert.deepEqual(qb.rejected.filter((r) => r.kind === 'facts').map((r) => r.index), [0, 1, 2, 3]);
});

test('REQ-158 FZ-1 исправление: словарь по Id и обычный массив читаются как раньше — исправление затронуло только дыры (G-001 принимается, число записей то же)', () => {
  const v = validate_ws(G);
  assert.deepEqual([v.ok, v.errors.length], [true, 0]);
  const as_dict = clone(G);
  as_dict.facts = Object.fromEntries(G.facts.map((f, i) => ['f' + String(i).padStart(3, '0'), f]));
  const vd = validate_ws(as_dict);
  assert.deepEqual([vd.ok, vd.stats.records], [true, v.stats.records]);
});

// ── хвост FZ-1 (FP-49): разреженный массив огромной длины ────────────────────────────────────────────────────────────────────────────
// После исправления дыр остался второй хвост того же класса: `entries_of` разворачивал массив (`Array.from` обходит каждую дыру) ДО проверки `limits.max_records`. Длина разреженного массива не связана
// с памятью: массив длиной 3 000 000 без записей стоил 183 МБ и 812 мс (до исправления FZ-1 — 24 МБ и 67 мс), а длиной до 2^32−1 — нехватку памяти вместо отказа. Теперь массив длиннее предела
// не разворачивается: ответ прежний — E_SCHEMA, причина `too_many_records`, список `kind`, индекса нет. То же для `tax_rules` (в том числе вложенный разреженный массив), для карантина
// (`quarantine_invalid`, `analyze_checked(…, {quarantine: true})`) и для сужения предела через `opts.limits`. Плотные списки и вывод `analyze` не меняются.
// Исправление после независимой проверки: два теста на длину 2^31 («в facts» и «в КАЖДОМ списке») раньше шли в процессе теста и при возврате ошибки исчерпали бы память машины вместо того, чтобы
// покраснеть. Теперь они идут в дочернем процессе с ограниченной кучей (`tests/fuzz_findings_child.mjs`, `--max-old-space-size`): при регрессии процесс падает за секунды, тест называет причину.
// Детерминированная проверка «не разворачивали» — через Proxy, который бросает при чтении любого элемента (на старом коде она краснеет сразу и без расхода памяти), и тест на 3 000 000 дыр
// (≈ 183 МБ на старом коде) остались в процессе теста.

const ALL_LISTS = ['accounts', 'calendars', 'reserves', 'rules', 'streams', 'anchors', 'facts', 'plans', 'overrides', 'tax_rules', 'allocations', 'rates', 'scenarios', 'purchases', 'debts', 'wave_overrides', 'counterparties'];
const TWO_31 = 2 ** 31;
const too_many_of = (v) => v.errors.filter((e) => e.reason === 'too_many_records');

const CHILD = fileURLToPath(new URL('./fuzz_findings_child.mjs', import.meta.url));
/** Куча дочернего процесса, МБ: исправному коду хватает с большим запасом (прирост единицы МБ), а при регрессии потолок достигается за секунды. */
const CHILD_HEAP_MB = 192;

/**
 * Выполнить сценарий `tests/fuzz_findings_child.mjs` в дочернем процессе node с ограниченной кучей и вернуть его наблюдения (одна строка JSON в stdout).
 * Нехватка памяти, зависание (предел 30 с, процесс убивается) и любой ненулевой код выхода — отказ теста с понятной причиной, а не исчерпание памяти машины.
 * @param {string} scenario `facts` или `every_list`
 * @param {string[]} [lists] списки для сценария `every_list`
 */
function in_child(scenario, lists = []) {
  const r = spawnSync(process.execPath, [`--max-old-space-size=${CHILD_HEAP_MB}`, CHILD, scenario, lists.join(',')], { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (r.error !== undefined) assert.fail(`дочерний процесс (${scenario}) не отработал: ${r.error.message} — если это тайм-аут, массив длиной 2^31 разворачивали`);
  if (r.status !== 0) {
    const err = String(r.stderr);
    const why = (/FATAL ERROR[^\r\n]*/.exec(err) ?? [err.slice(-300).replace(/\s+/g, ' ')])[0]; // строка V8 о нехватке памяти, а не хвост машинной трассировки
    assert.fail(`дочерний процесс (${scenario}) завершился с кодом ${r.status}${r.signal === null ? '' : ' (сигнал ' + r.signal + ')'} при куче ${CHILD_HEAP_MB} МБ — вероятно, массив длиной 2^31 разворачивали: ${why}`);
  }
  return JSON.parse(r.stdout);
}

/** Массив огромной длины, любое чтение элемента которого бросает: если проверка его разворачивает, она отвечает `validator_internal` вместо `too_many_records`. */
function untouchable(length) {
  const bad = (key) => typeof key === 'string' && /^\d+$/.test(key);
  return new Proxy(new Array(length), {
    get(target, key, receiver) { if (bad(key)) throw new Error('элемент ' + key + ' прочитан: массив разворачивали'); return Reflect.get(target, key, receiver); },
    has(target, key) { if (bad(key)) throw new Error('наличие элемента ' + key + ' проверено: массив разворачивали'); return Reflect.has(target, key); },
  });
}

const with_list = (list, value) => { const ws = clone(G); ws[list] = value; return ws; };

test('REQ-158 FZ-1 хвост: разреженный массив длиной 2^31 в facts отвергается быстро и с прежним кодом — E_SCHEMA, too_many_records, список facts, индекса нет; остальные списки считаются как обычно', { timeout: 30000 }, () => {
  // сам массив создаётся и проверяется в дочернем процессе с ограниченной кучей (см. in_child): при регрессии тест краснеет, а не исчерпывает память машины
  const o = in_child('facts');
  assert.equal(o.facts_len, TWO_31, 'длина — 2^31, записей нет');
  const v = { ok: o.ok, errors: o.errors };
  assert.equal(v.ok, false);
  assert.equal(internal_of(v), undefined, 'внутренней ошибки проверяющего нет');
  assert.deepEqual(too_many_of(v).map((e) => [e.code, e.kind, e.index, e.field, e.path]), [['E_SCHEMA', 'facts', null, null, 'facts']], 'код, причина и место — те же, что у плотного списка длиннее предела');
  assert.ok(o.ms < 1000, `проверка заняла ${Math.round(o.ms)} мс`);
  assert.ok(o.heap_mb < 64, `проверка заняла ${Math.round(o.heap_mb)} МБ кучи`);
  assert.equal(o.records, o.clean_records - o.g_facts_len, 'в счёт записей список не попал: развёрнутого списка нет');
  assert.equal(o.g_facts_len, G.facts.length, 'чистая область в дочернем процессе та же');
});

test('REQ-158 FZ-1 хвост: разреженный массив длиной 2^31 в КАЖДОМ списке рабочей области — too_many_records этого списка, быстро; строгий режим и карантин отвечают E_SCHEMA без внутренней ошибки', { timeout: 60000 }, () => {
  const rows = in_child('every_list', ALL_LISTS); // каждый список проверяется в дочернем процессе с ограниченной кучей (см. in_child)
  assert.deepEqual(rows.map((r) => r.list), ALL_LISTS, 'дочерний процесс прошёл по всем спискам');
  for (const { list, errors, ms, strict, quarantine: q } of rows) {
    const v = { errors };
    assert.equal(internal_of(v), undefined, `${list}: внутренняя ошибка проверяющего`);
    assert.ok(too_many_of(v).some((e) => e.kind === list && e.index === null && e.code === 'E_SCHEMA'), `${list}: too_many_records: ${JSON.stringify(errors.slice(0, 3))}`);
    assert.deepEqual([strict.ok, strict.code, strict.internal], [false, 'E_SCHEMA', false], `${list}: строгий режим`);
    assert.deepEqual([q.ok, q.code, q.internal], [false, 'E_SCHEMA', false], `${list}: карантин`);
    assert.ok(q.errors.some((e) => e.reason === 'too_many_records' && e.kind === list), `${list}: карантин называет причину`);
    assert.ok(ms < 2000, `${list}: быстро`);
  }
});

test('REQ-158 FZ-1 хвост: массив длиннее предела НЕ разворачивается — Proxy, бросающий при чтении любого элемента, не задет (строгий режим, карантин, tax_rules, вложенный разреженный массив tax_rules)', () => {
  for (const list of ['facts', 'accounts', 'tax_rules']) {
    const ws = with_list(list, untouchable(TWO_31));
    const v = validate_ws(ws);
    assert.equal(internal_of(v), undefined, `${list}: массив разворачивали: ${JSON.stringify(internal_of(v))}`);
    assert.ok(too_many_of(v).some((e) => e.kind === list), list);
    const q = quarantine_invalid(ws);
    assert.equal(q.ok, false, `${list}: карантин`);
    assert.ok(q.fatal.some((e) => e.reason === 'too_many_records' && e.kind === list), `${list}: ${JSON.stringify(q.fatal.slice(0, 2))}`);
  }
  const nested = with_list('tax_rules', [untouchable(TWO_31)]);
  const vn = validate_ws(nested);
  assert.equal(internal_of(vn), undefined, `вложенный: ${JSON.stringify(internal_of(vn))}`);
  assert.ok(too_many_of(vn).some((e) => e.kind === 'tax_rules'), 'вложенный разреженный массив в tax_rules');
  const out = analyze_checked(nested, { as_of: nested.as_of }, { quarantine: true });
  assert.deepEqual([out.ok, out.code, out.internal === true], [false, 'E_SCHEMA', false]);
  // сужение предела: массив короче предела по умолчанию, но длиннее суженного — тоже не разворачивается
  const small = with_list('facts', untouchable(1000));
  const vs = validate_ws(small, { limits: { max_records: 100 } });
  assert.equal(internal_of(vs), undefined);
  assert.ok(too_many_of(vs).some((e) => e.kind === 'facts'));
});

test('REQ-158 FZ-1 хвост: длина 3 000 000 без записей (число из находки: 183 МБ и 812 мс до исправления) — отказ за миллисекунды', () => {
  const ws = with_list('facts', new Array(3000000));
  const t0 = performance.now();
  const v = validate_ws(ws);
  const ms = performance.now() - t0;
  assert.deepEqual(too_many_of(v).map((e) => [e.kind, e.reason]), [['facts', 'too_many_records']]);
  assert.ok(ms < 150, `проверка заняла ${Math.round(ms)} мс (до исправления — 365…812 мс)`);
  assert.ok(WS_LIMITS.max_records < 3000000, 'длина превышает предел по умолчанию');
});

test('REQ-158 FZ-1 хвост: граница предела — список ровно в max_records принимается, на одну запись длиннее отвергается (плотный); разреженный массив длины max_records — по записи «не объект» на дыру, длины max_records+1 — отказ без разворачивания', () => {
  const M = Math.max(...ALL_LISTS.map((l) => (Array.isArray(G[l]) ? G[l].length : 0))); // самый длинный список G-001 (facts); предел M пропускает все списки
  const facts_n = (n) => with_list('facts', Array.from({ length: n }, (_, i) => ({ ...G.facts[0], event_id: 'f-fz' + i })));
  const limits = { limits: { max_records: M } };
  assert.deepEqual(too_many_of(validate_ws(facts_n(M), limits)), [], 'ровно предел: принято');
  assert.deepEqual(too_many_of(validate_ws(facts_n(M + 1), limits)).map((e) => [e.kind, e.reason, e.index]), [['facts', 'too_many_records', null]], 'на одну запись длиннее: отказ, как до исправления');
  const holes = validate_ws(with_list('facts', new Array(M)), limits);
  assert.deepEqual(too_many_of(holes), [], 'разреженный массив длины ровно в предел не отвергнут по длине');
  assert.equal(holes.errors.filter((e) => e.kind === 'facts' && e.reason === 'record_not_object').length, M, 'каждая дыра — запись «не объект»');
  const holes_over = validate_ws(with_list('facts', new Array(M + 1)), limits);
  assert.deepEqual(too_many_of(holes_over).map((e) => e.kind), ['facts']);
  assert.equal(holes_over.errors.filter((e) => e.reason === 'record_not_object').length, 0, 'длиннее предела дыры не перечисляются: массив не разворачивался');
  // плотный список длиннее предела в карантине: прежний ответ — область не принимается, без внутренней ошибки
  const q = analyze_checked(facts_n(M + 1), { as_of: G.as_of }, { quarantine: true, limits: { max_records: M } });
  assert.deepEqual([q.ok, q.code, q.internal === true], [false, 'E_SCHEMA', false]);
  assert.ok(q.errors.some((e) => e.kind === 'facts' && e.reason === 'too_many_records'));
  // tax_rules: плоская длина после разворачивания вложенных списков считается по-прежнему
  const nested = (n) => with_list('tax_rules', [Array.from({ length: n }, () => clone(G.tax_rules[0]))]);
  assert.deepEqual(too_many_of(validate_ws(nested(M + 1), limits)).map((e) => e.kind), ['tax_rules'], 'список списков длиннее предела');
  assert.deepEqual(too_many_of(validate_ws(nested(M), limits)), [], 'и ровно в предел');
});

test('REQ-158 FZ-1 хвост: контроль — дыра внутри КОРОТКОГО массива по-прежнему запись «не объект» (record_not_object), без too_many_records; карантин исключает её; G-001 принимается', () => {
  for (const list of AFFECTED) {
    const ws = with_hole(list);
    const v = validate_ws(ws);
    assert.deepEqual(too_many_of(v), [], `${list}: слишком длинным короткий массив не объявлен`);
    assert.ok(v.errors.some((e) => e.reason === 'record_not_object' && e.kind === list && e.index === 0), `${list}: дыра названа записью «не объект» с индексом 0`);
    assert.equal(internal_of(v), undefined, list);
    const q = analyze_checked(ws, { as_of: ws.as_of }, { quarantine: true });
    assert.ok(q.internal !== true, list);
  }
  const clean = validate_ws(G);
  assert.deepEqual([clean.ok, clean.errors.length], [true, 0], 'G-001 принимается');
  const q = analyze_checked(G, { as_of: G.as_of }, { quarantine: true });
  assert.equal(q.ok, true, 'и в карантине');
});
