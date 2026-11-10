// fp49_adv.test.mjs — состязательная проверка пакета FP-49 (независимый проверяющий). Приложение запускается настоящим app.mjs на заглушке DOM (оснастка tests/dom_boot.mjs) с глобальным
// `Worker`, который отвечает НЕ сразу (как в fp49_boot.test.mjs). Браузер, серверы и сеть не запускаются.
// Тесты с пометкой `todo` — найденные дефекты: они проходят, когда дефект исправлен; остальные — проверенные свойства, которые реализация обязана сохранять.
// Исправление после проверки (2026-10-28): ADV-1 и ADV-2 исправлены, их пометки `todo` сняты (названия прежние); дефект «тесты 2^31 исчерпают память при регрессии» исправлен в fuzz_findings.test.mjs
// (дочерний процесс с ограниченной кучей). Тесты исправлений — fp49_fix.test.mjs.
//   ADV-1 (средний) кнопка «Вернуть выбранный набор» отключена и тогда, когда в списке встроенный набор с пометкой «· изменён» — единственное состояние, в котором кнопка вообще что-то возвращает.
//   ADV-2 (низкий) у отключённой кнопки `.btn` нет вида «отключена» (в таблицах стилей нет правила `.btn:disabled`): она выглядит, наводится и показывает курсор-руку как включённая.
//   ADV-4…ADV-6 — свойства живой области при расчёте в Worker (два сообщения подряд, смена вердикта дважды, смена языка между сообщением и ответом).
//   ADV-7…ADV-9 — свойства проверки чужого файла (engine/validate_ws.mjs): огромные разреженные массивы во всех местах, где список берётся из рабочей области; список списков `tax_rules`; странные пределы.
// Расчёт по введённым данным и правилам, не консультация. Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/fp49_adv.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { boot_app, find_all, N } from './dom_boot.mjs';

const PROTO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);
const read = (...p) => fs.readFileSync(path.join(PROTO, ...p), 'utf8');
const W = await imp('demo', 'calc_worker.mjs');
const V = await imp('engine', 'validate_ws.mjs');
const G = JSON.parse(read('data', 'g001.json'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ответы Worker копятся, пока `on`, и уходят в страницу, когда тест их отпускает. */
const HOLD = { on: false, pending: [] };
class FakeWorker {
  constructor() { this.onmessage = null; this.onerror = null; this.onmessageerror = null; this.terminated = false; }
  postMessage(msg) {
    const reply = structuredClone(W.handle_message(structuredClone(msg)));
    const deliver = () => { if (!this.terminated) this.onmessage?.({ data: reply }); };
    if (HOLD.on) HOLD.pending.push(deliver); else setTimeout(deliver, 0);
  }
  terminate() { this.terminated = true; }
}
globalThis.Worker = FakeWorker;

const A = await boot_app();
const ctx = A.ext.ctx;
const settle = async (n = 6) => { for (let i = 0; i < n; i++) { await A.tick(); await wait(20); } };
const until = async (pred, ms = 5000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) assert.fail('не дождались'); await wait(5); } };
const live = () => N(A.byid.get('live').textContent);
const nav_button = (label) => find_all(A.nav(), (n) => n.tagName === 'button' && N(n.textContent) === label)[0];
const ds_select = (id) => find_all(id === 'ds-top' ? A.controls() : A.main(), (n) => n.tagName === 'select' && n.attrs.id === id)[0];
const chosen = (id = 'ds-top') => find_all(ds_select(id), (n) => n.tagName === 'option').filter((o) => o.attrs.selected !== undefined).map((o) => [o.attrs.value, N(o.textContent)]);
const shown_verdict = () => find_all(A.main(), (n) => /^verdict verdict-/.test(n.className)).map((n) => N(n.textContent).trim().replace(/^\S+\s/, ''))[0];
const reset = async (id = 'g001') => { HOLD.on = false; HOLD.pending.length = 0; await A.choose_dataset(id); await A.go('#overview'); await settle(); };
let seq = 100000;
const uniq_high = () => (seq += 7); // каждый расчёт «Купить» — с новым буфером: иначе ответ берётся из кэша без Worker
const uniq_low = () => 50000 + ((seq += 3) % 1000);
const reset_button = () => find_all(A.main(), (n) => n.tagName === 'button' && N(n.textContent) === 'Вернуть выбранный набор')[0]; // по подписи, а не по id: тест годится и для кода до FP-49

/** Удержать ответы Worker, выполнить `action`, дождаться, пока расчёт «Купить» дойдёт до Worker, отпустить ответы. Возвращает текст области ДО ответа. */
async function hold_then_release(action) {
  HOLD.on = true;
  action();
  await until(() => HOLD.pending.length > 0);
  const before = live();
  HOLD.on = false;
  for (const deliver of HOLD.pending.splice(0)) deliver();
  await until(() => live() !== before, 3000);
  await wait(40);
  return before;
}

// ═══ (3) кнопка «Вернуть выбранный набор» ══════════════════════════════════════════════════════════════════════════════════

// FP-49 (исправление после проверки): todo снят. Ответ хука `dataset_label` у правленого встроенного набора несёт `builtin` (идентификатор набора), и страница (`reset_target`) оставляет кнопку
// включённой: она возвращает набор, названный в списке. «Мои данные» и «Файл: …» поля не имеют — для них кнопка по-прежнему отключена (ADV-1б).
test('ADV-1 [ДЕФЕКТ, средний] «Вернуть выбранный набор» при правленом встроенном наборе («G-001 — эталон · изменён»): кнопка включена и возвращает эталон — как до FP-49 (спецификация: «при выбранном встроенном наборе — как прежде»)',
  async () => {
    await reset();
    const pristine = clone(ctx.get_ws());
    assert.equal(ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 64000 }).ok, true);
    await A.go('#data');
    await settle(2);
    assert.deepEqual(chosen('ds-sel'), [['custom', 'G-001 — эталон · изменён']], 'в списке выбран встроенный набор с пометкой');
    const btn = reset_button();
    assert.ok(btn !== undefined);
    assert.equal(btn.attrs.disabled, undefined, 'кнопка включена: «Вернуть выбранный набор» = вернуть G-001, который назван в списке');
    await btn.listeners.click[0]();
    await settle();
    assert.equal(ctx.get_ws().params.buffer_minor, pristine.params.buffer_minor, 'правка отброшена, эталон возвращён');
    assert.deepEqual(chosen('ds-sel'), [['g001', 'G-001 — эталон']]);
    await reset();
  });

test('ADV-1б контроль: при «Мои данные (с устройства)» и «Файл: …» кнопка по-прежнему отключена и данные не заменяются (защита от ADV-06 осталась)', async () => {
  for (const [label, origin, text] of [['устройство', undefined, 'Мои данные (с устройства)'], ['файл', { kind: 'file', name: 'moi.json' }, 'Файл: moi.json']]) {
    await reset();
    const w = clone(ctx.get_ws()); w.params = { ...w.params, buffer_minor: 61234 };
    assert.equal(ctx.set_ws(w, { reason: 'restore', ...(origin === undefined ? {} : { origin }) }).ok, true, label);
    await A.go('#data');
    await settle(2);
    assert.deepEqual(chosen('ds-sel'), [['custom', text]], label);
    assert.notEqual(reset_button().attrs.disabled, undefined, label + ': отключена');
    const before = ctx.get_ws();
    await reset_button().listeners.click[0]();
    await settle();
    assert.equal(ctx.get_ws(), before, label + ': данные те же');
  }
  await reset();
});

// FP-49 (исправление после проверки): todo снят. В style.css добавлены `.btn:disabled` (полупрозрачность, курсор «нельзя»), `.btn:disabled:hover` и `.btn.primary:disabled:hover` (подсветки при наведении нет).
test('ADV-2 [ДЕФЕКТ, низкий] у отключённой кнопки `.btn` есть вид «отключена» в таблицах стилей (`:disabled` или `[disabled]`): иначе она выглядит как включённая, наводится и показывает курсор-руку',
  () => {
    const css = [read('demo', 'style.css'), ...fs.readdirSync(path.join(PROTO, 'demo', 'css')).filter((f) => f.endsWith('.css')).map((f) => read('demo', 'css', f))].join('\n');
    const rules = css.split('}').map((r) => r.split('{')[0].trim()).filter((s) => s !== '');
    const covers = rules.some((sel) => sel.split(',').some((part) => /(^|[\s>+~])(\.btn|button)(\.[\w-]+)*(:disabled|\[disabled\])/.test(part.trim()) || /\.btn(\.[\w-]+)*\[aria-disabled/.test(part.trim())));
    assert.ok(covers, 'нет правила для отключённой кнопки `.btn`: ' + rules.filter((s) => /disabled/.test(s)).join(' | '));
  });

// ═══ (2) живая область при расчёте в Worker ═════════════════════════════════════════════════════════════════════════════════

test('ADV-4 два сообщения подряд до ответа Worker: к вердикту встаёт ПОСЛЕДНЕЕ, первое не воскресает', async () => {
  await reset();
  await A.go('#buy');
  await settle();
  const before = await hold_then_release(() => {
    assert.equal(ctx.edit({ type: 'set_param', key: 'buffer_minor', value: uniq_high() }).ok, true);
    ctx.notify('Первое.', 'info');
    ctx.notify('Второе.', 'info');
  });
  assert.equal(before, 'Второе.');
  assert.equal(live(), 'Второе. Вердикт: ' + shown_verdict());
  assert.ok(!live().includes('Первое'));
  await reset();
});

test('ADV-5 сообщение, затем два разных вердикта подряд внутри окна: сообщение остаётся только рядом с первым, второй называется один (без повтора сообщения), а третье сообщение снова работает', async () => {
  await reset();
  await A.go('#buy');
  await settle();
  await hold_then_release(() => {
    assert.equal(ctx.edit({ type: 'set_param', key: 'buffer_minor', value: uniq_high() }).ok, true);
    ctx.notify('Сохранено.', 'info');
  });
  const first = shown_verdict();
  assert.equal(live(), 'Сохранено. Вердикт: ' + first);
  await hold_then_release(() => { assert.equal(ctx.edit({ type: 'set_param', key: 'buffer_minor', value: uniq_low() }).ok, true); });
  assert.notEqual(shown_verdict(), first);
  assert.equal(live(), 'Вердикт: ' + shown_verdict());
  const before = await hold_then_release(() => {
    assert.equal(ctx.edit({ type: 'set_param', key: 'buffer_minor', value: uniq_high() }).ok, true);
    ctx.notify('Снова сохранено.', 'info');
  });
  assert.equal(before, 'Снова сохранено.');
  assert.equal(live(), 'Снова сохранено. Вердикт: ' + shown_verdict());
  await reset();
});

test('ADV-6 смена языка между сообщением и ответом Worker не ломает область: вердикт называется на новом языке, сообщение прежнее не дублируется', async () => {
  await reset();
  await A.go('#buy');
  await settle();
  HOLD.on = true;
  assert.equal(ctx.edit({ type: 'set_param', key: 'buffer_minor', value: uniq_high() }).ok, true);
  ctx.notify('Сохранено.', 'info');
  await until(() => HOLD.pending.length > 0);
  A.set_lang('en');
  await settle(2);
  HOLD.on = false;
  for (const deliver of HOLD.pending.splice(0)) deliver();
  await settle();
  const text = live();
  assert.equal((text.match(/Сохранено\./g) ?? []).length <= 1, true, text);
  assert.equal((text.match(/Verdict:|Вердикт:/g) ?? []).length <= 1, true, text);
  A.set_lang('ru');
  await reset();
});

// ═══ (6) проверка чужого файла ═══════════════════════════════════════════════════════════════════════════════════════════════

const with_value = (path_, value) => { const ws = clone(G); if (path_ === 'js.facts') { delete ws.facts; ws.js = { facts: value }; } else if (path_ === 'planned_one_offs') { delete ws.plans; ws.planned_one_offs = value; } else if (path_ === 'fx') { delete ws.rates; ws.fx = value; } else ws[path_] = value; return ws; };

test('ADV-7 разреженный массив длиной 2^31 и 2^32−1 везде, где список берётся из рабочей области (facts, plans через planned_one_offs, js.facts, rates через fx, вложенный tax_rules): отказ too_many_records за миллисекунды, строгий режим и карантин', { timeout: 60000 }, () => {
  const cases = [['facts', 2 ** 31], ['facts', 2 ** 32 - 1], ['planned_one_offs', 2 ** 31], ['js.facts', 2 ** 31], ['fx', 2 ** 32 - 1], ['tax_rules', 2 ** 31]];
  for (const [where, len] of cases) {
    const ws = with_value(where, new Array(len));
    const t0 = performance.now();
    const v = V.validate_ws(ws);
    const q = V.quarantine_invalid(ws);
    const out = V.analyze_checked(ws, { as_of: ws.as_of }, { quarantine: true });
    const ms = performance.now() - t0;
    assert.equal(v.ok, false, where);
    assert.ok(v.errors.every((e) => !String(e.reason).startsWith('validator_internal')), where + ': ' + JSON.stringify(v.errors.slice(0, 2)));
    assert.ok(v.errors.some((e) => e.reason === 'too_many_records'), where + ': ' + JSON.stringify(v.errors.slice(0, 3)));
    assert.equal(q.ok, false, where);
    assert.deepEqual([out.ok, out.code, out.internal === true], [false, 'E_SCHEMA', false], where);
    assert.ok(ms < 3000, `${where}[${len}]: ${Math.round(ms)} мс (на исправленном коде — единицы миллисекунд)`);
  }
  for (const len of [2 ** 31, 2 ** 32 - 1]) {
    const ws = clone(G); ws.tax_rules = [clone(G.tax_rules[0]), new Array(len)];
    const t0 = performance.now();
    const v = V.validate_ws(ws);
    assert.ok(v.errors.some((e) => e.kind === 'tax_rules' && e.reason === 'too_many_records'), 'вложенный разреженный массив рядом с настоящим правилом: ' + JSON.stringify(v.errors.slice(0, 3)));
    assert.ok(performance.now() - t0 < 3000);
  }
});

test('ADV-8 список списков tax_rules: допустимый вид (как принимает normalize_ws) даёт тот же результат проверки и тот же расчёт, что плоский список; пустые вложенные списки не мешают', () => {
  const flat = clone(G);
  for (const nested of [[flat.tax_rules], [[], flat.tax_rules, []], [flat.tax_rules[0]]]) {
    const ws = clone(G); ws.tax_rules = nested;
    const a = V.validate_ws(flat);
    const b = V.validate_ws(ws);
    assert.deepEqual([b.ok, b.errors, b.stats.records], [a.ok, a.errors, a.stats.records], JSON.stringify(nested).slice(0, 40));
    const ra = V.analyze_checked(flat, { as_of: flat.as_of });
    const rb = V.analyze_checked(ws, { as_of: ws.as_of });
    assert.equal(rb.ok, true);
    assert.deepEqual(rb.analysis.series.plan.close, ra.analysis.series.plan.close, 'ряды те же');
    assert.deepEqual(rb.analysis.series.worse.close, ra.analysis.series.worse.close);
  }
});

test('ADV-9 пределы необычного вида (0, −1, NaN, строка, Infinity, дробное, null): проверка не бросает и не зависает; предел 0 отвергает непустые списки, пустые принимает', () => {
  const ws = clone(G);
  for (const max of [0, -1, NaN, '3', '50', Infinity, 1.5, null, undefined, 'abc', true]) {
    let v; let q;
    assert.doesNotThrow(() => { v = V.validate_ws(ws, { limits: { max_records: max } }); q = V.quarantine_invalid(ws, { limits: { max_records: max } }); }, String(max));
    assert.equal(typeof v.ok, 'boolean');
    assert.equal(typeof q.ok, 'boolean');
  }
  const empty = { ...clone(G), facts: [], plans: [], rules: [], streams: [], accounts: [], calendars: [], reserves: [], anchors: [], overrides: [], tax_rules: [], allocations: [], rates: [], scenarios: [], purchases: [], debts: [], wave_overrides: [], counterparties: [] };
  const v0 = V.validate_ws(empty, { limits: { max_records: 0 } });
  assert.ok(!v0.errors.some((e) => e.reason === 'too_many_records'), 'пустые списки при пределе 0: ' + JSON.stringify(v0.errors.slice(0, 2)));
  const v1 = V.validate_ws(G, { limits: { max_records: 0 } });
  assert.ok(v1.errors.some((e) => e.reason === 'too_many_records' && e.kind === 'facts'));
});
