// calc_async.test.mjs — FP-21, REQ-150: расчёт основных экранов («Обзор», «Купить», «Волны») через клиент воркера. Браузера, сети и потоков здесь нет: воркер — ЗАГЛУШКА, которая
// обрабатывает сообщения настоящим `handle_message` (demo/calc_worker.mjs) через структурное клонирование, как браузер. Проверяется:
//   1. протокол: прежние операции воркера не менялись, операции экранов `project` / `waves` / `afford` добавлены; ответ воркера побайтно равен расчёту на месте на наборах G-001
//      (основной, low, gap, late, empty, debt) и на 160 случайных областях golden_properties (тот же построитель и те же сиды); ошибки протокола и данных;
//   2. клиент `create_calc_client`: операции экранов с тем же откатом на главный поток при любом сбое воркера, ошибки движка проходят как есть;
//   3. служба demo/calc_async.mjs: флаг устройства, готовые модели (`prepare` → `take`: `build_model` получает расчёт Worker, а не считает сам), «Купить» (`afford`: кэш, один расчёт
//      на кадр, присоединение к идущему расчёту, отказ движка, сбой воркера), контекст `ctx_from_analysis` побайтно равен `make_tool_ctx`;
//   4. статические проверки: нет разметки из строк, inline-стилей, сети и хранилищ вне флага; каталог строк (паритет RU/EN, запрещённые формулировки, ключи используются литералами).
// Расчёт по введённым данным и правилам, не консультация.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/calc_async.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PROTO } from './sw_harness.mjs';
import { make_rng } from './helpers.mjs';
import { Node_, find_all } from './dom_boot.mjs';

const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);
const W = await imp('demo', 'calc_worker.mjs');
const C = await imp('demo', 'worker_client.mjs');
const S = await imp('demo', 'calc_async.mjs');
const CS = await imp('demo', 'calc_settings.mjs');
const A = await imp('demo', 'app.mjs');
const E = await imp('engine', 'index.mjs');
const T = await imp('engine', 'tools.mjs');
const CAT = (await imp('demo', 'i18n', 'calc.mjs')).default;
const I18N = await imp('demo', 'i18n.mjs');

const read = (...p) => fs.readFileSync(path.join(PROTO, ...p), 'utf8');
const load = (name) => JSON.parse(read('data', name));
const json = (x) => JSON.stringify(x);
const NAMES = ['g001.json', 'g001-low.json', 'g001-gap.json', 'g001-late.json', 'g001-empty.json', 'g001-debt.json'];
const DATASETS = NAMES.map((n) => [n, load(n)]);
const G = load('g001.json');
const MODES = ['plan', 'worse'];
const q_of = (ws) => ({ as_of: ws.as_of });
const parts_of = (ws, shift = 2, amount = 12345) => [{ date: E.format_date(E.to_epoch_day(ws.as_of) + shift), amount_minor: amount }];

// ── расчёт на месте: независимый от demo/calc_worker.mjs эталон ───────────────────────────────────────────────────────────

/** «Обзор» на месте: analyze и узкая точка режима (engine/index.mjs, не run_project). */
function sync_project(ws, query = q_of(ws)) {
  const analysis = E.analyze(ws, query);
  const narrow = {};
  for (const m of Object.keys(analysis.series)) { const p = E.narrowest_point(analysis.series[m], analysis.as_of, analysis.horizon_end); narrow[m] = { d: p.date, v: p.amount_minor }; }
  return { analysis, narrow };
}
/** «Волны» на месте: analyze и list_waves_ex по режимам. */
function sync_waves(ws, query = q_of(ws)) {
  const analysis = E.analyze(ws, query);
  const waves = {};
  for (const m of Object.keys(analysis.series)) waves[m] = E.list_waves_ex(analysis, m);
  return { analysis, waves };
}
/** «Купить» на месте: `cash_after` приложения (build_model с покупкой поверх сценария); `null` — отказ расчёта. */
const sync_afford = (ws, parts) => ({ cash_after: A.cash_after(A.build_model(ws), parts) });
/** Исход вызова: значение или код ошибки с контекстом. */
function outcome(fn) {
  try { return { value: fn() }; } catch (e) { return { error: { code: e.code, ctx: e.ctx ?? null } }; }
}

/** Ответ воркера через структурное клонирование туда и обратно (как в браузере). */
const via_worker = (msg) => structuredClone(W.handle_message(structuredClone(msg)));

// ── 1. протокол ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-150 FP-21 протокол: прежние операции воркера (OPS) не менялись, операции экранов (SCREEN_OPS) добавлены; версия протокола 1; hello и analyze отвечают как раньше', () => {
  assert.deepEqual([...W.OPS], ['hello', 'analyze']);
  assert.deepEqual([...W.SCREEN_OPS], ['project', 'afford', 'waves']);
  assert.equal(W.PROTOCOL, 1);
  assert.deepEqual(W.handle_message({ v: 1, id: 7, op: 'hello' }), { v: 1, id: 7, ok: true, op: 'hello', engine_version: E.ENGINE_VERSION, result: { protocol: 1, engine_version: E.ENGINE_VERSION } });
  const r = W.handle_message({ v: 1, id: 1, op: 'analyze', ws: G, query: q_of(G) });
  assert.equal(json(r.result), json(E.analyze(G, q_of(G))));
  assert.deepEqual(Object.keys(r), ['v', 'id', 'ok', 'op', 'engine_version', 'result']);
  // ответы новых операций построены так же: поля и их порядок те же
  for (const msg of [{ op: 'project' }, { op: 'waves' }, { op: 'afford', parts: parts_of(G) }]) {
    const x = via_worker({ v: 1, id: 3, ws: G, query: q_of(G), ...msg });
    assert.deepEqual(Object.keys(x), ['v', 'id', 'ok', 'op', 'engine_version', 'result'], msg.op);
    assert.equal(x.ok, true, msg.op);
    assert.equal(x.op, msg.op);
    assert.equal(x.id, 3);
    assert.equal(x.engine_version, E.ENGINE_VERSION);
  }
});

test('REQ-150 FP-21 «Обзор»: операция project = analyze на месте + узкая точка режима, побайтно, на всех наборах G-001; числа канона доходят через воркер', () => {
  for (const [name, ws] of DATASETS) {
    const got = via_worker({ v: 1, id: 1, op: 'project', ws, query: q_of(ws) });
    assert.equal(got.ok, true, name);
    assert.equal(json(got.result), json(sync_project(ws)), name + ': project через воркер = analyze на месте');
    assert.equal(json(got.result.analysis), json(E.analyze(ws, q_of(ws))), name);
    assert.deepEqual(Object.keys(got.result), ['analysis', 'narrow']);
    assert.deepEqual(Object.keys(got.result.narrow), MODES);
  }
  const g = via_worker({ v: 1, id: 2, op: 'project', ws: G, query: q_of(G) }).result;
  assert.equal(g.analysis.series.plan.opening_minor, 400000);
  assert.equal(g.analysis.series.plan.close.at(-1), 340000);
  assert.equal(g.narrow.worse.v, 183000, 'G-001: узкая точка «если хуже» 1 830,00 €');
  assert.equal(E.format_date(g.narrow.worse.d), '2026-11-14');
  assert.match(g.analysis.inputs_hash, /^[0-9a-f]{64}$/);
});

test('REQ-150 FP-21 «Волны»: операция waves = analyze + list_waves_ex по режимам, побайтно, на всех наборах G-001; состав волн канона', () => {
  for (const [name, ws] of DATASETS) {
    const got = via_worker({ v: 1, id: 1, op: 'waves', ws, query: q_of(ws) });
    assert.equal(got.ok, true, name);
    assert.equal(json(got.result), json(sync_waves(ws)), name + ': waves через воркер = list_waves_ex на месте');
  }
  const g = via_worker({ v: 1, id: 2, op: 'waves', ws: G, query: q_of(G) }).result;
  assert.equal(g.waves.plan.items.length, 2, 'G-001: две волны');
  assert.equal(g.waves.plan.items[0].wave.total_out_minor, 152000, 'W1 = налог + аренда + ЖКХ');
  assert.equal(g.waves.plan.items[1].wave.total_out_minor, 102000, 'W2 = аренда + ЖКХ');
  // список волн приложения (waves_model) не меняется от того, откуда пришли волны
  assert.equal(json(A.waves_model(A.build_model(G), 'ru')), json(A.waves_model(A.build_model(structuredClone(G)), 'ru')));
});

test('REQ-150 FP-21 «Купить»: операция afford = cash_after приложения, побайтно, на всех наборах и нескольких покупках; сценарий запроса учитывается; отказ расчёта — ошибка с кодом движка', () => {
  for (const [name, ws] of DATASETS) {
    for (const parts of [parts_of(ws, 0, 100), parts_of(ws, 2, 12345), parts_of(ws, 10, 300000), [...parts_of(ws, 3, 5000), ...parts_of(ws, 9, 7000)]]) {
      const got = via_worker({ v: 1, id: 1, op: 'afford', ws, query: q_of(ws), parts });
      const want = sync_afford(ws, parts);
      if (want.cash_after === null) { assert.equal(got.ok, false, name + ' ' + json(parts)); assert.match(got.error.code, /^E_[A-Z_]+$/); continue; }
      assert.equal(got.ok, true, name + ' ' + json(parts));
      assert.equal(json(got.result), json(want), name + ' ' + json(parts));
    }
  }
  // канон: покупка поверх сценария «клиент платит позже» — сценарий входит в запрос, как у модели экрана
  const ref = A.first_income_ref(A.build_model(G));
  const scenario = { ops: [{ op: 'delay_income', event_ref: ref, days: 14 }] };
  const parts = parts_of(G, 5, 30000);
  const model = A.build_model(G, { scenario });
  const want = { cash_after: A.cash_after(model, parts) };
  assert.notEqual(want.cash_after, null);
  const got = via_worker({ v: 1, id: 4, op: 'afford', ws: G, query: A.build_model(G, { scenario }).ctx.query, parts });
  assert.equal(json(got.result), json(want), 'сценарий в запросе');
  const plain = via_worker({ v: 1, id: 5, op: 'afford', ws: G, query: q_of(G), parts }).result;
  assert.notEqual(json(plain), json(want), 'без сценария ответ другой: сценарий действительно учтён');
});

test('REQ-158 FP-21 ошибки операций экранов: ws, query и parts не того вида — E_SCHEMA/bad_arguments с id; ошибка движка идёт тем же кодом и контекстом; исключение не вылетает, текст не утекает', () => {
  const bad = (msg, id = 3) => {
    const r = W.handle_message({ v: 1, id, ...msg });
    assert.equal(r.ok, false, json(msg));
    assert.equal(r.error.code, 'E_SCHEMA');
    assert.equal(r.error.ctx.reason, 'bad_arguments', json(msg).slice(0, 80));
    assert.equal(r.id, id);
    structuredClone(r);
  };
  for (const op of W.SCREEN_OPS) {
    for (const ws of [null, 'ws', [], 7, undefined]) bad({ op, ws, query: q_of(G), parts: parts_of(G) });
    for (const query of [null, 'q', [], undefined]) bad({ op, ws: G, query, parts: parts_of(G) });
  }
  for (const parts of [undefined, null, 'p', {}, [], [1], [null], [[]], ['x']]) bad({ op: 'afford', ws: G, query: q_of(G), parts });
  // project и waves parts не требуют
  assert.equal(W.handle_message({ v: 1, id: 1, op: 'project', ws: G, query: q_of(G) }).ok, true);
  // ошибки движка: тот же код и контекст, что при расчёте на месте
  const broken = { ...G, as_of: '2026-13-45' };
  for (const [op, direct] of [['project', () => sync_project(broken, { as_of: broken.as_of })], ['waves', () => sync_waves(broken, { as_of: broken.as_of })], ['afford', () => E.analyze(broken, { as_of: broken.as_of })]]) {
    const d = outcome(direct).error;
    assert.ok(d !== undefined && /^E_[A-Z_]+$/.test(d.code), op);
    const r = W.handle_message({ v: 1, id: 9, op, ws: broken, query: { as_of: broken.as_of }, parts: parts_of(G) });
    assert.equal(r.ok, false, op);
    assert.equal(r.error.code, d.code, op);
    assert.deepEqual(r.error.ctx, d.ctx, op);
  }
  // неожиданное исключение (не из движка): причина названа, текст исключения наружу не уходит
  const hostile = new Proxy({}, { get() { throw new TypeError('секретный-текст-исключения'); }, ownKeys() { throw new TypeError('секретный-текст-исключения'); }, has() { throw new TypeError('секретный-текст-исключения'); } });
  for (const op of W.SCREEN_OPS) {
    const u = W.handle_message({ v: 1, id: 11, op, ws: hostile, query: { as_of: '2026-10-04' }, parts: parts_of(G) });
    assert.equal(u.ok, false, op);
    assert.equal(u.error.ctx.reason, 'unexpected', op);
    assert.ok(!json(u).includes('секретный'), op);
  }
  // фаззинг: операции экранов на случайных сообщениях не бросают исключений
  const rng = make_rng(2101);
  const junk = () => rng.pick([null, undefined, 0, -1, 1.5, '', 'x', true, [], {}, { a: 1 }, [1, [2]], { v: 1 }, 2 ** 53]);
  for (let i = 0; i < 1500; i++) {
    const msg = { v: 1, id: rng.int(0, 50), op: rng.pick(W.SCREEN_OPS), ws: rng.bool() ? G : junk(), query: rng.bool() ? { as_of: rng.pick(['2026-10-04', junk()]) } : junk(), parts: rng.bool() ? parts_of(G, rng.int(0, 60), rng.pick([100, 12345, junk()])) : junk() };
    const r = W.handle_message(msg);
    assert.ok(r !== null && typeof r === 'object' && r.v === 1 && typeof r.ok === 'boolean', json(msg).slice(0, 100));
    if (!r.ok) assert.match(r.error.code, /^E_[A-Z_]+$/);
  }
});

// ── 160 областей golden_properties ─────────────────────────────────────────────────────────────────────────────────────────

/** Алгоритм Говарда Хиннанта: гражданская дата → число дней от 1970-01-01 (копия из tests/adversarial/golden_properties.test.mjs). */
function dfc(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}
const D = (s) => { const [y, m, d] = s.split('-').map(Number); return dfc(y, m, d); };
function fmt(z) {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return `${String(y + (m <= 2 ? 1 : 0)).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Рабочая область случайного случая golden_properties (`gen_case`): тот же построитель, те же сиды и порядок вызовов ГПСЧ; оракул и взносы накоплений опущены — нужна только область. */
function gen_ws(seed) {
  const rng = make_rng(seed * 7919 + 13);
  const as_of = D('2026-01-01') + rng.int(0, 600);
  const horizon_days = rng.next() < 0.15 ? rng.int(0, 3) : rng.int(14, 90);
  const rich = rng.next() < 0.5;
  const opening = rich ? rng.int(400000, 1500000) : rng.int(-20000, 900000);
  const B = rich ? rng.pick([0, 10000, 50000]) : rng.pick([0, 0, 10000, 50000, 120000, 300000]);
  const delay = rng.pick([0, 3, 7, 14, 14, 21]);
  const n = rng.int(0, 26);
  const plans = [];
  const res_ids = [];
  const use_tax = rng.next() < 0.6;
  const use_tax2 = use_tax && rng.next() < 0.3;
  const use_sink = rng.next() < 0.5;
  if (use_tax) res_ids.push('RES-T1');
  if (use_tax2) res_ids.push('RES-T2');
  if (use_sink) res_ids.push('RES-S');
  for (let i = 0; i < n; i++) {
    const income = rng.next() < 0.35;
    const date = as_of + rng.int(0, horizon_days + 6);
    const amt = income ? rng.int(1, rich ? 250000 : 400000) : -rng.int(1, rich ? 60000 : 250000);
    const kind = income ? 'income' : 'expense';
    const tag = income ? (rng.next() < 0.8 ? 'work' : 'gift') : rng.pick(['еда', 'аренда', 'прочее']);
    const oblig = rng.next() < 0.5;
    const est = rng.next() < 0.2;
    const reserve = !income && res_ids.length > 0 && rng.next() < 0.3 ? rng.pick(res_ids) : null;
    plans.push({ plan_id: `p${i}`, account_id: 'acc_main', name: `p${i}`, date: fmt(date), amount_minor: amt, currency: 'EUR', kind, tag, is_obligation: oblig, is_estimate: est, ...(reserve ? { reserve_id: reserve } : {}) });
  }
  const tax_rules = [];
  const reserves = [];
  const mk_rule = (id, res, rate_bp) => ({ tax_rule_id: id, version: 1, name: id, kind: 'percent_of_income', rate_bp, base: 'gross', applies_to: { stream_ids: [], tags: ['work'] }, valid_from: '2025-01-01', valid_to: null, rounding: 'half_even', reserve_id: res, recorded_at: '2025-01-02T10:00:00Z' });
  if (use_tax) {
    const f = rng.int(0, 200000);
    const rate = rng.int(0, 5000);
    tax_rules.push(mk_rule('TR-1', 'RES-T1', rate));
    reserves.push({ reserve_id: 'RES-T1', kind: 'tax', name: 'T1', currency: 'EUR', funded_start_minor: f, funded_as_of: fmt(as_of), tax_rule_id: 'TR-1', backed_by_account_id: null });
  }
  if (use_tax2) {
    const f = rng.int(0, 80000);
    const rate = rng.int(0, 4000);
    tax_rules.push(mk_rule('TR-2', 'RES-T2', rate));
    reserves.push({ reserve_id: 'RES-T2', kind: 'tax', name: 'T2', currency: 'EUR', funded_start_minor: f, funded_as_of: fmt(as_of), tax_rule_id: 'TR-2', backed_by_account_id: null });
  }
  if (use_sink) {
    const f = rng.int(0, 30000);
    const target = f + rng.int(-5000, 120000);
    const due = as_of + rng.int(10, 200);
    reserves.push({ reserve_id: 'RES-S', kind: 'sinking', name: 'S', currency: 'EUR', funded_start_minor: f, funded_as_of: fmt(as_of), target_minor: target, due_date: fmt(due), cadence: { freq: 'M', day: 1 }, mode: 'refill_to_target', backed_by_account_id: null });
  }
  return {
    workspace_id: `ws-fuzz-${seed}`, name: `fuzz ${seed}`, locale: 'ru', decision_currency: 'EUR', format: 'runway-journal/1', as_of: fmt(as_of),
    params: { horizon_days, buffer_minor: B, 'worse.income_delay_days': delay, 'wave.gap_days': 3, 'wave.max_span_days': 10, 'wave.threshold_minor': rng.pick([1000, 3000, 20000]), rounding: 'half_even' },
    accounts: [{ account_id: 'acc_main', name: 'Основной', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2, liquidity_bp: 0, opened_on: '2025-01-01' }],
    calendars: [{ calendar_id: 'cal-main', name: 'сб, вс', weekend_dows: [0, 6], holidays: [] }],
    anchors: [{ anchor_id: 'anc-1', account_id: 'acc_main', date: fmt(as_of), amount_minor: opening }],
    facts: [], rules: [], overrides: [], plans, streams: [], tax_rules, reserves, allocations: [], rates: [], scenarios: [], purchases: [], debts: [], wave_overrides: [], counterparties: [],
  };
}

test('REQ-150 FP-21 160 областей golden_properties: project, waves и afford через воркер побайтно равны расчёту на месте (160 сидов, тот же построитель; оба режима, вырожденные горизонты, налоговые и накопительные резервы)', () => {
  let afford_ok = 0;
  let afford_refused = 0;
  const seen = { horizon0: 0, tax: 0, sinking: 0 };
  for (let seed = 1; seed <= 160; seed++) {
    const ws = gen_ws(seed);
    const q = q_of(ws);
    if (ws.params.horizon_days <= 3) seen.horizon0 += 1;
    if (ws.tax_rules.length > 0) seen.tax += 1;
    if (ws.reserves.some((r) => r.kind === 'sinking')) seen.sinking += 1;
    const p = via_worker({ v: 1, id: 1, op: 'project', ws, query: q });
    assert.equal(p.ok, true, 'seed ' + seed);
    assert.equal(json(p.result), json(sync_project(ws)), 'seed ' + seed + ' project');
    const w = via_worker({ v: 1, id: 2, op: 'waves', ws, query: q });
    assert.equal(json(w.result), json(sync_waves(ws)), 'seed ' + seed + ' waves');
    for (const parts of [parts_of(ws, 1, 12345), parts_of(ws, 20, 90000)]) {
      const a = via_worker({ v: 1, id: 3, op: 'afford', ws, query: q, parts });
      const want = sync_afford(ws, parts);
      if (want.cash_after === null) { assert.equal(a.ok, false, 'seed ' + seed + ' afford отказ'); afford_refused += 1; } else { assert.equal(json(a.result), json(want), 'seed ' + seed + ' afford'); afford_ok += 1; }
    }
  }
  assert.ok(afford_ok >= 250, 'ответов «Купить»: ' + afford_ok + ', отказов ' + afford_refused);
  assert.ok(seen.horizon0 >= 10 && seen.tax >= 50 && seen.sinking >= 50, JSON.stringify(seen));
});

// ── 2. клиент ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Заглушка воркера: настоящий `handle_message`, ответ после структурного клонирования; режимы — как в worker_contract.test. */
function fake_worker(mode = 'echo') {
  const w = {
    terminated: false, received: [], onmessage: null, onerror: null, onmessageerror: null,
    postMessage(msg) {
      const copy = structuredClone(msg);
      w.received.push(copy);
      const reply = () => structuredClone(W.handle_message(copy));
      const deliver = (data) => queueMicrotask(() => { if (!w.terminated) w.onmessage?.({ data }); });
      switch (mode) {
        case 'echo': deliver(reply()); break;
        case 'silent': break;
        case 'crash': queueMicrotask(() => w.onerror?.({ message: 'упал' })); break;
        case 'wrong_engine': { const r = reply(); r.engine_version = '9.9.9'; deliver(r); break; }
        case 'broken_reply': deliver({ v: 1, id: copy.id, engine_version: E.ENGINE_VERSION }); break;
        default: throw new Error('режим ' + mode);
      }
    },
    terminate() { w.terminated = true; },
  };
  return w;
}
const fake_timers = () => { const t = { list: [] }; t.set_timeout = (fn, ms) => { t.list.push({ fn, ms }); return t.list.length; }; t.clear_timeout = () => {}; return t; };
const client_with = (mode) => { const created = []; const timers = fake_timers(); const c = C.create_calc_client({ make_worker: () => { const w = fake_worker(mode); created.push(w); return w; }, ...timers }); return { c, created, timers }; };

test('REQ-150 FP-21 клиент: project, waves и afford в воркере = расчёт на месте; запросы идут тем же протоколом (v, id, op, ws, query[, parts]); воркер один; warm() запускает его заранее', async () => {
  const { c, created } = client_with('echo');
  assert.equal(c.stats().started, false);
  assert.equal(c.warm(), true);
  assert.equal(created.length, 1, 'warm запустил воркер до первого расчёта');
  const parts = parts_of(G);
  const p = await c.project(G, q_of(G));
  const w = await c.waves(G, q_of(G));
  const a = await c.afford(G, q_of(G), parts);
  for (const r of [p, w, a]) assert.deepEqual([r.via, r.reason], ['worker', null]);
  assert.equal(json(p.result), json(sync_project(G)));
  assert.equal(json(w.result), json(sync_waves(G)));
  assert.equal(json(a.result), json(sync_afford(G, parts)));
  assert.deepEqual(created[0].received.map((m) => [m.v, m.id, m.op]), [[1, 1, 'project'], [1, 2, 'waves'], [1, 3, 'afford']]);
  assert.deepEqual(Object.keys(created[0].received[2]), ['v', 'id', 'op', 'ws', 'query', 'parts']);
  assert.equal(created.length, 1);
  assert.equal(c.stats().worker_calls, 3);
  assert.equal(c.stats().pending, 0);
  // analyze работает как раньше
  const an = await c.analyze(G, q_of(G));
  assert.equal(an.via, 'worker');
  assert.equal(json(an.result), json(E.analyze(G, q_of(G))));
  c.terminate();
  assert.equal(created[0].terminated, true);
  assert.equal(c.warm(), false, 'после остановки воркер не запускается');
  const after = await c.project(G, q_of(G));
  assert.deepEqual([after.via, after.reason], ['main', 'terminated']);
  assert.equal(json(after.result), json(sync_project(G)));
  // без воркера: warm сообщает, что считать придётся на месте
  assert.equal(C.create_calc_client({ make_worker: () => null }).warm(), false);
});

test('REQ-150 FP-21 откат на главный поток: нет воркера, не запустился, молчит, упал, чужая версия движка, ответ без ok — операции экранов дают тот же результат без потери, воркер больше не используется', async () => {
  const parts = parts_of(G);
  const calls = [['project', (c) => c.project(G, q_of(G)), sync_project(G)], ['waves', (c) => c.waves(G, q_of(G)), sync_waves(G)], ['afford', (c) => c.afford(G, q_of(G), parts), sync_afford(G, parts)]];
  const cases = [['crash', 'worker_error'], ['wrong_engine', 'version_mismatch'], ['broken_reply', 'worker_error']];
  for (const [op, run, want] of calls) {
    for (const [mode, reason] of cases) {
      const x = client_with(mode);
      const r = await run(x.c);
      assert.deepEqual([op, mode, r.via, r.reason], [op, mode, 'main', reason]);
      assert.equal(json(r.result), json(want), op + ' ' + mode);
      assert.equal(x.c.stats().dead, reason);
      assert.equal(x.created[0].terminated, true);
      const again = await run(x.c);
      assert.deepEqual([again.via, again.reason], ['main', reason], 'мёртвый воркер не перезапускается');
      assert.equal(x.created.length, 1);
    }
    // молчит: таймер ожидания
    const s = client_with('silent');
    const pending = run(s.c);
    await new Promise((r) => setImmediate(r));
    assert.equal(s.timers.list.length, 1);
    s.timers.list[0].fn();
    const r1 = await pending;
    assert.deepEqual([r1.via, r1.reason], ['main', 'timeout']);
    assert.equal(json(r1.result), json(want), op + ' timeout');
    // нет воркера и воркер не запустился
    const none = await run(C.create_calc_client({ make_worker: () => null }));
    assert.deepEqual([none.via, none.reason], ['main', 'no_worker']);
    assert.equal(json(none.result), json(want));
    const boom = await run(C.create_calc_client({ make_worker: () => { throw new Error('CSP'); } }));
    assert.deepEqual([boom.via, boom.reason], ['main', 'worker_start_failed']);
    assert.equal(json(boom.result), json(want));
  }
});

test('REQ-158 FP-21 клиент: ошибка движка в операции экрана — RunwayError с тем же кодом и контекстом, что на месте; воркер остаётся живым; на главном потоке то же', async () => {
  const { c } = client_with('echo');
  const broken = { ...G, as_of: '2026-13-45' };
  const d = outcome(() => E.analyze(broken, { as_of: broken.as_of })).error;
  for (const run of [(x) => x.project(broken, { as_of: broken.as_of }), (x) => x.waves(broken, { as_of: broken.as_of }), (x) => x.afford(broken, { as_of: broken.as_of }, parts_of(G))]) {
    await assert.rejects(() => run(c), (e) => e instanceof E.RunwayError && e.code === d.code && json(e.ctx) === json(d.ctx));
    await assert.rejects(() => run(C.create_calc_client({ make_worker: () => null })), (e) => e instanceof E.RunwayError && e.code === d.code);
  }
  assert.equal(c.stats().dead, null, 'ошибка данных — не сбой воркера');
  assert.equal(c.stats().engine_errors, 3);
  assert.equal((await c.project(G, q_of(G))).via, 'worker');
});

// ── 3. служба ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Служба на заглушках: хранилище в словаре, воркер-заглушка, таймеры службы — вручную (`fire` запускает их). */
function make_service(mode = 'echo', deps = {}) {
  const timers = [];
  const fire = () => { for (const t of timers.splice(0)) t.fn(); };
  const store = new Map();
  const created = [];
  const svc = S.create_calc_service({
    storage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); } },
    has_worker: () => true,
    make_client: () => C.create_calc_client({ make_worker: () => { const w = fake_worker(mode); created.push(w); return w; }, ...fake_timers() }),
    set_timeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    ...deps,
  });
  return { svc, timers, fire, store, created };
}

test('REQ-150 FP-21 флаг устройства: по умолчанию включён; ключ с префиксом runway; снятие останавливает Worker целиком и служба неактивна; включение — новый клиент; без хранилища и без Worker', () => {
  const x = make_service();
  assert.equal(S.FLAG_KEY, 'runway-calc-worker/1');
  assert.ok(S.FLAG_KEY.startsWith('runway'), 'стирается вместе с остальными данными приложения (LOCAL_PREFIX)');
  assert.equal(x.svc.enabled(), true);
  assert.equal(x.svc.active(), true);
  assert.equal(x.svc.off_reason(), null);
  assert.equal(x.svc.warm(), true);
  assert.equal(x.created.length, 1);
  x.svc.set_enabled(false);
  assert.equal(x.store.get(S.FLAG_KEY), '0');
  assert.equal(x.created[0].terminated, true, 'выключение останавливает воркер');
  assert.deepEqual([x.svc.enabled(), x.svc.active(), x.svc.off_reason()], [false, false, 'off']);
  assert.equal(x.svc.warm(), false);
  assert.equal(x.created.length, 1, 'выключенная служба воркер не запускает');
  assert.equal(x.svc.afford({ ws: G, ctx: { inputs_hash: 'h' } }, parts_of(G)), null, 'неактивная служба: считать на месте');
  x.svc.set_enabled(true);
  assert.equal(x.store.get(S.FLAG_KEY), '1');
  assert.equal(x.svc.warm(), true);
  assert.equal(x.created.length, 2, 'после включения — новый воркер');
  // флаг читается из хранилища при первом обращении
  const y = make_service();
  y.store.set(S.FLAG_KEY, '0');
  assert.equal(y.svc.enabled(), false);
  assert.equal(y.svc.stats().off_reason, 'off');
  // хранилище недоступно (бросает или его нет): по умолчанию включено, переключатель живёт до перезагрузки страницы
  const z = make_service('echo', { storage: { getItem() { throw new Error('заблокировано'); }, setItem() { throw new Error('заблокировано'); } } });
  assert.equal(z.svc.enabled(), true);
  assert.equal(z.svc.set_enabled(false), false);
  assert.equal(z.svc.enabled(), false);
  assert.equal(make_service('echo', { storage: null }).svc.enabled(), true);
  // в окружении нет Worker (Node, старый браузер)
  const n = make_service('echo', { has_worker: () => false });
  assert.deepEqual([n.svc.active(), n.svc.off_reason(), n.svc.warm()], [false, 'no_worker', false]);
  assert.equal(n.created.length, 0);
  // без внедрения портов служба приложения в Node неактивна (Worker нет), а клиент не создаётся
  assert.equal(typeof globalThis.Worker, 'undefined');
  assert.deepEqual([S.calc.active(), S.calc.off_reason()], [false, 'no_worker']);
});

test('REQ-150 FP-21 prepare → take: модель набора из Worker; контекст ctx_from_analysis побайтно равен make_tool_ctx; расчёт отдаётся один раз; чужая рабочая область и чужой запрос — null', async () => {
  const x = make_service();
  for (const [name, base] of DATASETS) {
    const ws = structuredClone(base);
    const p = x.svc.prepare(ws, [q_of(ws)]);
    x.fire();
    const r = await p;
    assert.deepEqual([r.ok, r.op, r.n, r.via], [true, 'project', 1, 'worker'], name);
    assert.equal(x.svc.take(structuredClone(ws), q_of(ws)), null, name + ': другая рабочая область (тот же текст, другой объект) — расчёта нет');
    assert.equal(x.svc.take(ws, { as_of: '1999-01-01' }), null, name + ': другой запрос');
    const got = x.svc.take(ws, q_of(ws));
    assert.notEqual(got, null, name);
    assert.equal(x.svc.take(ws, q_of(ws)), null, name + ': один раз');
    // контекст: поля и их порядок, как у make_tool_ctx (engine/tools.mjs)
    const ctx = S.ctx_from_analysis(got, ws, q_of(ws), { locale: 'ru' });
    assert.equal(ctx, got, 'аналитика дополняется на месте');
    assert.equal(json(ctx), json(T.make_tool_ctx(ws, q_of(ws), { locale: 'ru' })), name + ': ctx_from_analysis = make_tool_ctx');
    assert.deepEqual(Object.keys(ctx).slice(-9), ['ws', 'query', 'journal', 'call_log', 'tier', 't1_enabled', 'calls_used', 'locale', 'echo']);
  }
  assert.equal(x.svc.stats().taken, DATASETS.length);
  assert.equal(x.svc.stats().prepared, DATASETS.length);
  // несколько запросов за раз: сценарий и база
  const ws = structuredClone(G);
  const ref = A.first_income_ref(A.build_model(structuredClone(G)));
  const sc = { ops: [{ op: 'delay_income', event_ref: ref, days: 7 }] };
  const p = x.svc.prepare(ws, [q_of(ws), S.model_query(ws, sc)]);
  x.fire();
  assert.equal((await p).n, 2);
  assert.equal(json(x.svc.take(ws, S.model_query(ws, sc))), json(E.analyze(ws, { as_of: ws.as_of, scenario: sc })), 'модель сценария из Worker = analyze со сценарием');
  assert.equal(json(x.svc.take(ws, q_of(ws))), json(E.analyze(ws, q_of(ws))));
  // порядок ключей объекта в запросе не важен
  assert.equal(S.canon({ b: 1, a: { d: [2, { y: 1, x: undefined }], c: null } }), S.canon({ a: { c: null, d: [2, { y: 1 }] }, b: 1 }));
  assert.deepEqual(S.model_query({ as_of: '2026-10-04' }), { as_of: '2026-10-04' });
  assert.deepEqual(S.model_query({ as_of: '2026-10-04' }, sc), { as_of: '2026-10-04', scenario: { ops: sc.ops } });
});

test('REQ-150 FP-21 «Волны»: prepare со screen waves приносит списки волн вместе с расчётом; waves_for отдаёт их только для того расчёта, с которым они пришли', async () => {
  const x = make_service();
  const ws = structuredClone(G);
  const p = x.svc.prepare(ws, [q_of(ws)], { screen: 'waves' });
  x.fire();
  const r = await p;
  assert.deepEqual([r.ok, r.op], [true, 'waves']);
  const a = x.svc.take(ws, q_of(ws));
  assert.equal(json(x.svc.waves_for(a)), json(sync_waves(ws).waves));
  assert.equal(x.svc.waves_for(structuredClone(a)), null, 'копия расчёта — другой объект');
  assert.equal(x.svc.waves_for(null), null);
  // расчёт для «Обзора» списков волн не несёт
  const ws2 = structuredClone(G);
  const p2 = x.svc.prepare(ws2, [q_of(ws2)], { screen: 'overview' });
  x.fire();
  assert.equal((await p2).op, 'project');
  assert.equal(x.svc.waves_for(x.svc.take(ws2, q_of(ws2))), null);
});

test('REQ-150 FP-21 build_model получает расчёт Worker вместо analyze: модель побайтно равна посчитанной на месте, на всех наборах; waves_model и buy_run (cash_after) дают те же ответы', async () => {
  class EchoWorker {
    constructor() { this.onmessage = null; this.onerror = null; this.onmessageerror = null; this.terminated = false; EchoWorker.count += 1; }
    postMessage(msg) { const r = structuredClone(W.handle_message(structuredClone(msg))); queueMicrotask(() => { if (!this.terminated) this.onmessage?.({ data: r }); }); }
    terminate() { this.terminated = true; }
  }
  EchoWorker.count = 0;
  globalThis.Worker = EchoWorker;
  try {
    assert.equal(S.calc.active(), true);
    for (const [name, base] of DATASETS) {
      const ws = structuredClone(base);
      const ref = await S.calc.prepare(ws, [q_of(ws)], { screen: 'waves' });
      assert.equal(ref.ok, true, name);
      const taken_before = S.calc.stats().taken;
      const model = A.build_model(ws, { lang: 'ru' });
      assert.equal(S.calc.stats().taken, taken_before + 1, name + ': модель собрана из расчёта Worker');
      const want = A.build_model(structuredClone(base), { lang: 'ru' }); // на месте: расчёта в службе нет
      assert.equal(json(model.ctx), json(want.ctx), name + ': ctx');
      assert.equal(json({ ...model, ws: null, ctx: null }), json({ ...want, ws: null, ctx: null }), name + ': остальные поля модели');
      assert.equal(json(A.waves_model(model, 'ru')), json(A.waves_model(want, 'ru')), name + ': waves_model');
      assert.notEqual(S.calc.waves_for(model.ctx), null, name + ': списки волн пришли из Worker');
      assert.equal(S.calc.stats().taken, taken_before + 1);
      // повторная сборка той же рабочей области считает на месте (расчёт отдаётся один раз)
      assert.equal(json(A.build_model(ws, { lang: 'ru' }).ctx), json(want.ctx), name + ': повтор');
      assert.equal(S.calc.stats().taken, taken_before + 1);
      // «Купить»: ответ с деньгами после покупки из Worker равен ответу, посчитанному на месте
      const parts = parts_of(base, 3, 25000);
      const job = S.calc.afford(model, parts);
      assert.notEqual(job, null, name);
      const res = await job.promise;
      const input = { date: parts[0].date, amount_minor: parts[0].amount_minor };
      const via = A.buy_run(model, input, 'ru', res.value);
      const local = A.buy_run(want, input, 'ru');
      assert.equal(res.value.cash_after === null ? 'null' : 'ok', local.view?.cash_after === null || local.view?.cash_after === undefined ? 'null' : 'ok', name);
      assert.equal(json({ ...via, result: null, ref: null }), json({ ...local, result: null, ref: null }), name + ': buy_run');
    }
    assert.equal(EchoWorker.count, 1, 'воркер один на всё приложение');
  } finally { S.calc.terminate(); delete globalThis.Worker; }
});

test('REQ-150 FP-21 «Купить»: ответ из кэша — сразу; несколько запросов за кадр дают один расчёт (последний), остальные получают SUPERSEDED; повтор идущего расчёта присоединяется к нему', async () => {
  const x = make_service();
  const model = A.build_model(structuredClone(G));
  const amounts = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000];
  const jobs = amounts.map((v) => x.svc.afford(model, parts_of(G, 4, v)));
  assert.ok(jobs.every((j) => j !== null && j.promise !== undefined && typeof j.key === 'string'));
  assert.equal(new Set(jobs.map((j) => j.key)).size, 10, 'ключи разные');
  assert.equal(x.timers.length, 1, 'один таймер кадра на десять запросов');
  assert.equal(x.timers[0].ms, S.FRAME_MS);
  assert.equal(x.svc.pending(), 10);
  x.fire();
  const got = await Promise.all(jobs.map((j) => j.promise));
  assert.equal(got.filter((r) => r === S.SUPERSEDED).length, 9);
  assert.equal(got[9].value.cash_after !== undefined, true);
  assert.equal(json(got[9].value.cash_after), json(sync_afford(G, parts_of(G, 4, 10000)).cash_after), 'последний запрос посчитан верно');
  assert.equal(x.created[0].received.filter((m) => m.op === 'afford').length, 1, 'воркер получил один расчёт «Купить»');
  assert.equal(x.svc.stats().coalesced, 9);
  assert.equal(x.svc.pending(), 0);
  // повтор — из кэша, без обращения к воркеру
  const again = x.svc.afford(model, parts_of(G, 4, 10000));
  assert.deepEqual(Object.keys(again), ['key', 'value']);
  assert.equal(json(again.value.cash_after), json(got[9].value.cash_after));
  assert.equal(x.svc.stats().cache_hits, 1);
  assert.equal(x.created[0].received.filter((m) => m.op === 'afford').length, 1);
  // вытесненный запрос можно повторить: теперь это последний
  const redo = x.svc.afford(model, parts_of(G, 4, 3000));
  x.fire();
  assert.equal((await redo.promise).value.cash_after.plan.v, sync_afford(G, parts_of(G, 4, 3000)).cash_after.plan.v);
  // идущий расчёт: тот же ключ присоединяется, второй расчёт не запускается
  const slow = make_service('echo');
  const m2 = A.build_model(structuredClone(G));
  const first = slow.svc.afford(m2, parts_of(G, 6, 777));
  slow.fire(); // кадр кончился: расчёт начат, но ответ воркера ещё в микрозадачах
  await Promise.resolve();
  const joined = slow.svc.afford(m2, parts_of(G, 6, 777));
  assert.equal(slow.timers.length, 0, 'новый кадр не открыт: расчёт присоединён');
  const [r1, r2] = await Promise.all([first.promise, joined.promise]);
  assert.equal(json(r1.value), json(r2.value));
  assert.equal(slow.created[0].received.filter((m) => m.op === 'afford').length, 1);
});

test('REQ-150 FP-21 «Купить»: отказ движка — cash_after null, как у cash_after приложения, и ответ запоминается; нечитаемые части — null без исключения; сценарий модели входит в ключ', async () => {
  const x = make_service();
  const model = A.build_model(structuredClone(G));
  const odd = [{ date: '2026-13-45', amount_minor: 100 }];
  assert.equal(A.cash_after(model, odd), null);
  const j = x.svc.afford(model, odd);
  x.fire();
  const r = await j.promise;
  assert.equal(r.value.cash_after, null);
  const hit = x.svc.afford(model, odd);
  assert.equal(hit.value.cash_after, null, 'отказ детерминирован: из кэша');
  // сценарий меняет модель — и ключ
  const ref = A.first_income_ref(model);
  const scn = A.build_model(structuredClone(G), { scenario: { ops: [{ op: 'delay_income', event_ref: ref, days: 21 }] } });
  const parts = parts_of(G, 5, 30000);
  const ja = x.svc.afford(model, parts);
  const jb = x.svc.afford(scn, parts);
  assert.notEqual(ja.key, jb.key);
  x.fire();
  const [ra, rb] = await Promise.all([ja.promise, jb.promise]);
  assert.equal(ra, S.SUPERSEDED, 'второй запрос кадра вытеснил первый');
  assert.equal(json(rb.value.cash_after), json(A.cash_after(scn, parts)), 'считается поверх сценария модели');
  assert.notEqual(json(rb.value.cash_after), json(A.cash_after(model, parts)));
  // негодные аргументы — считать на месте
  assert.equal(x.svc.afford(null, parts), null);
  assert.equal(x.svc.afford(model, []), null);
  assert.equal(x.svc.afford({ ws: G }, parts), null);
});

test('REQ-150 FP-21 сбой Worker: расчёт «Купить» и prepare всё равно возвращают верный результат (откат клиента), служба становится неактивной; снятие и повторная постановка флага запускают нового клиента', async () => {
  const bad = make_service('crash');
  const model = A.build_model(structuredClone(G));
  const j = bad.svc.afford(model, parts_of(G, 5, 4321));
  bad.fire();
  const r = await j.promise;
  assert.equal(json(r.value.cash_after), json(sync_afford(G, parts_of(G, 5, 4321)).cash_after), 'ответ верный и после падения воркера');
  assert.equal(r.value.via, 'main');
  assert.equal(bad.svc.active(), false);
  assert.equal(bad.svc.off_reason(), 'worker_error');
  assert.equal(bad.svc.afford(model, parts_of(G, 5, 9999)), null, 'после сбоя считаем на месте, без цикла перезапусков');
  assert.equal(bad.created.length, 1);
  const ws = structuredClone(G);
  const p = await bad.svc.prepare(ws, [q_of(ws)]);
  assert.deepEqual([p.ok, p.off], [false, true]);
  assert.equal(bad.svc.take(ws, q_of(ws)), null);
  // prepare, начатый до сбоя, тоже заканчивается верным результатом
  const mid = make_service('crash');
  const ws2 = structuredClone(G);
  const pp = mid.svc.prepare(ws2, [q_of(ws2)]);
  mid.fire();
  const pr = await pp;
  assert.deepEqual([pr.ok, pr.via, pr.reason], [true, 'main', 'worker_error']);
  assert.equal(json(mid.svc.take(ws2, q_of(ws2))), json(E.analyze(ws2, q_of(ws2))), 'расчёт, сделанный откатом, равен analyze на месте');
  // новая попытка по флагу
  bad.svc.set_enabled(false);
  bad.svc.set_enabled(true);
  assert.equal(bad.svc.active(), true);
  assert.equal(bad.svc.stats().started, false, 'клиент новый, воркер ещё не запущен');
  // ошибка движка в prepare проходит наружу как есть: приложение посчитает на месте и получит тот же код
  const eng = make_service();
  const broken = { ...G, as_of: '2026-13-45' };
  const pe = eng.svc.prepare(broken, [{ as_of: broken.as_of }]);
  eng.fire();
  await assert.rejects(() => pe, (e) => e instanceof E.RunwayError && /^E_[A-Z_]+$/.test(e.code));
  assert.equal(eng.svc.take(broken, { as_of: broken.as_of }), null);
});

test('REQ-150 FP-21 флаг снят, пока запросы ждали кадра: новый воркер не запускается, оба расчёта («Купить» и prepare) заканчиваются верным результатом на месте с причиной off', async () => {
  const x = make_service();
  const model = A.build_model(structuredClone(G));
  const parts = parts_of(G, 4, 8888);
  const ws = structuredClone(G);
  const job = x.svc.afford(model, parts);
  const prep = x.svc.prepare(ws, [q_of(ws)]); // другой канал: свой таймер
  assert.equal(x.timers.length, 2);
  x.svc.set_enabled(false); // между запросом и расчётом
  x.fire();
  const r = await job.promise;
  assert.equal(r.value.via, 'main');
  assert.equal(r.value.reason, 'off');
  assert.equal(json(r.value.cash_after), json(sync_afford(G, parts).cash_after), 'ответ верен');
  const p = await prep;
  assert.deepEqual([p.ok, p.via, p.reason], [true, 'main', 'off']);
  assert.equal(json(x.svc.take(ws, q_of(ws))), json(E.analyze(ws, q_of(ws))), 'расчёт на месте равен analyze');
  assert.equal(x.created.length, 0, 'выключенная служба воркер не создаёт');
  assert.equal(x.svc.stats().started, false);
});

test('REQ-150 FP-21 prepare: вызовы одного кадра дают один расчёт (последний), остальные — SUPERSEDED; без Worker и с неверными аргументами — off', async () => {
  const x = make_service();
  const a = structuredClone(G);
  const b = structuredClone(load('g001-low.json'));
  const pa = x.svc.prepare(a, [q_of(a)]);
  const pb = x.svc.prepare(b, [q_of(b)]);
  assert.equal(x.timers.length, 1);
  x.fire();
  assert.equal(await pa, S.SUPERSEDED);
  assert.equal((await pb).ok, true);
  assert.equal(x.svc.take(a, q_of(a)), null, 'вытесненный набор не считался');
  assert.notEqual(x.svc.take(b, q_of(b)), null);
  assert.equal(x.created[0].received.filter((m) => m.op === 'project').length, 1);
  for (const args of [[null, [{}]], [G, []], [G, null], [G, 'q']]) assert.deepEqual(await x.svc.prepare(...args), { ok: false, off: true }, String(args[1]));
  const off = make_service('echo', { has_worker: () => false });
  assert.deepEqual(await off.svc.prepare(G, [q_of(G)]), { ok: false, off: true });
});

// ── 4. карточка флага, статические проверки, строки ───────────────────────────────────────────────────────────────────────

test('REQ-150 FP-21 карточка «Расчёт в фоне» в «Настройках»: отметка отражает флаг, снятие пишет флаг и останавливает Worker, состояние обновляется на месте; без каталога строк карточки нет; формы нет', () => {
  globalThis.document = { createElement: (t) => new Node_(t), createTextNode: (data) => ({ nodeType: 3, data }) };
  try {
    const x = make_service();
    const tr = (key, params) => I18N.t('ru', key, params);
    const ctx = { tr };
    // каталог пакета ещё не зарегистрирован — карточки нет
    assert.equal(CS.calc_card(ctx, x.svc), null);
    I18N.register_strings('calc', CAT);
    const card = CS.calc_card(ctx, x.svc);
    assert.equal(card.tagName, 'section');
    assert.equal(find_all(card, (n) => n.tagName === 'form').length, 0, 'не форма: число форм «Настроек» прежнее');
    assert.equal(find_all(card, (n) => n.tagName === 'button').length, 0, 'кнопки «Сохранить» нет: отметка действует сразу');
    const box = find_all(card, (n) => n.tagName === 'input')[0];
    assert.equal(box.attrs.type, 'checkbox');
    assert.equal(box.attrs.id, 'set-calc');
    assert.notEqual(box.attrs.checked, undefined, 'флаг включён — отметка стоит');
    const label = find_all(card, (n) => n.tagName === 'label')[0];
    assert.equal(label.attrs.for, 'set-calc');
    assert.match(label.textContent, /Считать в фоне \(Web Worker\)/);
    const state = find_all(card, (n) => n.attrs.id === 'set-calc-state')[0];
    assert.equal(state.attrs.role, 'status');
    assert.match(state.textContent, /Сейчас: расчёт в фоне\. В этом сеансе в фоне посчитано 0, на основном потоке — 0\./);
    assert.match(box.attrs['aria-describedby'], /set-calc-hint/);
    // снять отметку
    box.checked = false;
    box.listeners.change[0]({ target: box });
    assert.equal(x.store.get(S.FLAG_KEY), '0');
    assert.equal(x.svc.active(), false);
    assert.match(state.textContent, /Сейчас: расчёт на основном потоке \(отметка снята\)\./);
    // поставить заново
    box.checked = true;
    box.listeners.change[0]({ target: box });
    assert.equal(x.store.get(S.FLAG_KEY), '1');
    assert.match(state.textContent, /расчёт в фоне/);
    // причины сбоя названы словами
    const bad = make_service('crash');
    bad.svc.afford(A.build_model(structuredClone(G)), parts_of(G));
    bad.fire();
    return bad.svc.stats(), new Promise((r) => setTimeout(r, 20)).then(() => {
      assert.match(CS.state_text(tr, bad.svc), /\(фоновый поток остановился с ошибкой\)/);
      const en = CS.state_text((k, p) => I18N.t('en', k, p), bad.svc);
      assert.match(en, /Now: calculation on the main thread \(the background thread stopped with an error\)\./);
    });
  } finally { delete globalThis.document; }
});

test('REQ-150 FP-21 безопасность и устройство файлов: нет разметки из строк, inline-стилей, eval, сети и IndexedDB; Worker создаёт только клиент; хранилище — один ключ флага с префиксом runway', () => {
  const FILES = ['calc_async.mjs', 'calc_settings.mjs', 'pack_fp21.mjs', 'calc_worker.mjs', 'worker_client.mjs'];
  for (const f of FILES) {
    const code = read('demo', f).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'srcdoc', 'document.write', 'eval(', 'new Function', 'fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'indexedDB', 'sessionStorage', 'document.cookie', 'importScripts', "setAttribute('style'", 'http://', 'https://']) {
      assert.ok(!code.includes(bad), `${f}: ${bad}`);
    }
    if (f !== 'worker_client.mjs') assert.ok(!/\bnew\s+(?:globalThis\.)?Worker\s*\(/.test(code), `${f}: воркеры создаёт только клиент воркера расчёта`);
  }
  // localStorage — только в службе и только для флага
  const svc_code = read('demo', 'calc_async.mjs').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal((svc_code.match(/localStorage/g) ?? []).length, 1);
  assert.equal((svc_code.match(/getItem|setItem/g) ?? []).length, 2);
  assert.ok(!/localStorage/.test(read('demo', 'calc_settings.mjs').replace(/\/\/.*$/gm, '')), 'карточка ходит в хранилище через службу');
  // app.mjs не знает клиента воркера по имени (проверка about.test) и не создаёт Worker
  const app = read('demo', 'app.mjs');
  assert.ok(!/worker_client|new\s+Worker/.test(app));
  assert.match(app, /from '\.\/calc_async\.mjs'/);
  // воркер расчёта берёт только движок
  const imports = [...read('demo', 'calc_worker.mjs').matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports, ['../engine/index.mjs']);
  // в файлах пакета нет inline-обработчиков строкой и инлайновых стилей
  for (const f of ['calc_settings.mjs', 'pack_fp21.mjs']) assert.ok(!/\bon[a-z]+\s*=\s*["']|style\s*:/.test(read('demo', f).replace(/\/\/.*$/gm, '')), f);
  assert.ok(!/style\s*=|<style|@import|url\(/.test(read('demo', 'css', 'calc.css')), 'css/calc.css без внешних адресов и инлайна');
});

test('TST-56 FP-21 каталог calc: паритет ключей RU/EN, одинаковые плейсхолдеры, ключи в пространстве calc, русские буквы в RU, запрещённых формулировок нет; каждый ключ используется литералом в коде; app.calc есть на обоих языках', () => {
  assert.deepEqual(Object.keys(CAT.ru).sort(), Object.keys(CAT.en).sort());
  const placeholders = (s) => [...s.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]).sort();
  const vocab = JSON.parse(read('engine', 'vocab.json'));
  const code = ['calc_settings.mjs', 'pack_fp21.mjs'].map((f) => read('demo', f)).join('\n');
  for (const k of Object.keys(CAT.ru)) {
    assert.ok(k.startsWith('calc.'), k);
    assert.deepEqual(placeholders(CAT.ru[k]), placeholders(CAT.en[k]), k);
    assert.match(CAT.ru[k], /[а-яё]/i, k);
    assert.ok(CAT.en[k].trim() !== '', k);
    assert.ok(code.includes("'" + k + "'"), 'ключ ' + k + ' не используется литералом в коде пакета');
    for (const phrase of vocab.forbidden_phrases) {
      for (const lang of ['ru', 'en']) assert.ok(!CAT[lang][k].toLowerCase().replace(/ё/g, 'е').includes(phrase.toLowerCase().replace(/ё/g, 'е')), `${k}: «${phrase}»`);
    }
  }
  assert.equal(I18N.t('ru', 'app.calc'), 'Считаем…');
  assert.equal(I18N.t('en', 'app.calc'), 'Calculating…');
  const app_src = read('demo', 'app.mjs');
  assert.match(app_src, /if \(S\.calc_busy > 0\) \{ mark_busy\(main, true\); main\.replaceChildren\(\.\.\.skeleton_nodes\(tr\('app\.calc'\)\)\)/);
  assert.match(app_src, /skeleton_nodes\(tr\('app\.loading'\)\)/, 'прежний скелет загрузки на месте');
  assert.ok(app_src.indexOf("mark_busy(main, S.status === 'loading')") < app_src.indexOf('S.calc_busy > 0'), 'прежняя отметка занятости стоит раньше FP-21');
  // пакет подключён в манифесте после FP-20 и перед FP-22
  const man = read('demo', 'ext_manifest.mjs');
  assert.match(man, /'pack_fp20', 'pack_fp21', 'pack_fp22'/);
  assert.match(man, /pack_fp21: \(\) => import\('\.\/pack_fp21\.mjs'\)/);
});
