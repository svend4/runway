// analyze.test.mjs — фасад `analyze(ws, query) → Analysis` (index.mjs; design-brief §3.9, §14 B3, D-21, C-012): форма контекста, состав query,
// горизонт, сценарии, режимы, буфер, резервы (C-020), предупреждения, inputs_hash и детерминизм (TST-33, часть), реэкспорт публичного API.
// Числа G-001 — из §9 ДОСЛОВНО. В тестах допустимы node:fs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { parse_date } from '../engine/dates.mjs';
import { answer_q1, runway_days } from '../engine/timeline.mjs';
import * as engine from '../engine/index.mjs';
import { analyze, ENGINE_VERSION } from '../engine/index.mjs';
import { list_waves } from '../engine/waves.mjs';
import { make_rng, throws_code } from './helpers.mjs';

const DATA = new URL('../data/', import.meta.url);
const load = (name) => JSON.parse(fs.readFileSync(new URL(name, DATA), 'utf8'));
const G = load('g001.json');
const iso = (s) => parse_date(s);
const run = (ws, extra = {}) => analyze(ws, { as_of: ws.as_of, ...extra });
const AG = run(G);

// ── форма контекста ──────────────────────────────────────────────────────────────────────────────────────────────────

test('analyze G-001: поля Analysis (C-012) — as_of 20730, horizon_end 20787 (N = 58), валюта, параметры, буфер, события и ряды обоих режимов, Q1, готовность, свежесть, статусы правил', () => {
  assert.deepEqual(Object.keys(AG), [
    'as_of', 'horizon_end', 'decision_currency', 'params', 'buffer_minor', 'events', 'series', 'reserve', 'q1', 'wave_overrides',
    'readiness', 'anchor_status', 'rule_status', 'warnings', 'inputs_hash', 'engine_version',
  ]);
  assert.equal(AG.as_of, 20730);
  assert.equal(AG.horizon_end, 20787);
  assert.equal(AG.decision_currency, 'EUR');
  assert.equal(AG.buffer_minor, 50000);
  assert.equal(AG.engine_version, ENGINE_VERSION);
  assert.match(AG.inputs_hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(AG.series), ['plan', 'worse']);
  assert.deepEqual(Object.keys(AG.events), ['plan', 'worse']);
  assert.deepEqual(Object.keys(AG.reserve), ['plan', 'worse']);
  assert.deepEqual(Object.keys(AG.q1), ['plan', 'worse']);
  for (const m of ['plan', 'worse']) {
    const s = AG.series[m];
    assert.deepEqual(Object.keys(s), ['from', 'opening_minor', 'reserve_opening_minor', 'close', 'trough', 'reserve_trough', 'reserve_close', 'free']);
    assert.equal(s.from, 20730);
    for (const k of ['close', 'trough', 'reserve_trough', 'reserve_close', 'free']) assert.equal(s[k].length, 58, `${m}.${k}: N = 58`);
    assert.equal(s.opening_minor, 400000);
    assert.equal(s.reserve_opening_minor, 150000);
    assert.deepEqual(Object.keys(AG.reserve[m]).sort(), ['by_reserve', 'reserve_close', 'reserve_trough']);
    assert.deepEqual(AG.reserve[m].reserve_trough, s.reserve_trough);
    assert.ok(AG.events[m].every((e) => e.plan_date !== undefined && e.date >= AG.as_of && e.date <= AG.horizon_end), 'события несут plan_date и лежат в горизонте');
  }
  assert.deepEqual(AG.readiness, { score: 4, level: 'full', reasons: [] });
  assert.equal(AG.anchor_status.level, 'fresh');
  assert.equal(AG.anchor_status.age, 0);
  assert.deepEqual(AG.rule_status, { 'TR-20': 'fresh' });
  assert.deepEqual(AG.wave_overrides, []);
  assert.deepEqual(AG.warnings, []);
  assert.equal(AG.params['wave.threshold_minor'], 3000);
  assert.equal(AG.params['worse.income_delay_days'], 14);
  assert.equal(AG.params.buffer_minor, 50000);
});

test('analyze G-001: инварианты рядов — close[i] − close[i−1] = out_i + in_i, free = trough − reserve_trough, reserve_close[i] − reserve_trough[i] = аллокации дня; opening и end_close; worse ≤ plan', () => {
  for (const m of ['plan', 'worse']) {
    const s = AG.series[m];
    assert.equal(s.close.at(-1), 340000); // G-001.end_close
    s.free.forEach((f, i) => assert.equal(f, s.trough[i] - s.reserve_trough[i]));
    s.close.forEach((c, i) => {
      const prev = i === 0 ? s.opening_minor : s.close[i - 1];
      const evs = AG.events[m].filter((e) => e.date === AG.as_of + i);
      assert.equal(c - prev, evs.reduce((x, e) => x + e.amount_minor, 0), `день ${i}`);
    });
    assert.ok(s.reserve_close.every((r, i) => r >= s.reserve_trough[i]));
  }
  AG.series.plan.trough.forEach((t, i) => assert.ok(AG.series.worse.trough[i] <= t));
  assert.equal(AG.series.plan.reserve_close.at(-1), 167800); // RES-TAX 155800 + RES-INS 12000
  assert.equal(AG.reserve.plan.by_reserve['RES-TAX'].close.at(-1), 155800);
  assert.equal(AG.reserve.plan.by_reserve['RES-INS'].close.at(-1), 12000);
});

// ── query: as_of, горизонт, сценарий, режимы, D, буфер (§14 B3) ────────────────────────────────────────────────────────

test('analyze query: as_of — IsoDate или EpochDay (результат тот же); as_of обязателен (E_SCHEMA); валюта решения должна определяться', () => {
  const a = analyze(G, { as_of: 20730 });
  const b = analyze(G, { as_of: '2026-10-04' });
  assert.deepEqual(a, b);
  assert.deepEqual(a, AG);
  throws_code(() => analyze(G, {}), 'E_SCHEMA');
  throws_code(() => analyze(G), 'E_SCHEMA');
  throws_code(() => analyze(G, { as_of: null }), 'E_SCHEMA');
  throws_code(() => analyze({ ...G, decision_currency: undefined, accounts: [] }, { as_of: '2026-10-04' }), 'E_SCHEMA');
});

test('analyze query: горизонт — horizon_end главнее horizon_days; без них — params.horizon_days, иначе 180 (vocab); horizon_end < as_of — E_BAD_DATE', () => {
  assert.equal(run(G).horizon_end, iso('2026-11-30'), 'params.horizon_days = 57');
  assert.equal(run(G, { horizon_days: 10 }).horizon_end, iso('2026-10-14'));
  assert.equal(run(G, { horizon_end: '2026-11-15' }).horizon_end, iso('2026-11-15'));
  assert.equal(run(G, { horizon_end: '2026-11-15', horizon_days: 3 }).horizon_end, iso('2026-11-15'), 'если оба — horizon_end');
  const bare = { ...G, params: Object.fromEntries(Object.entries(G.params).filter(([k]) => k !== 'horizon_days')) };
  assert.equal(run(bare).horizon_end, iso('2026-10-04') + 180, 'по умолчанию 180');
  assert.equal(run(G, { horizon_end: '2026-10-04' }).series.plan.close.length, 1, 'горизонт из одного дня');
  throws_code(() => run(G, { horizon_end: '2026-10-03' }), 'E_BAD_DATE');
  throws_code(() => run(G, { horizon_days: -1 }), 'E_SCHEMA');
  // более короткий горизонт — префикс более длинного (события не зависят от горизонта)
  const shortA = run(G, { horizon_end: '2026-11-15' });
  const n = shortA.series.plan.close.length;
  assert.deepEqual(shortA.series.plan.close, AG.series.plan.close.slice(0, n));
  assert.deepEqual(shortA.series.worse.trough, AG.series.worse.trough.slice(0, n));
});

test('analyze query: сценарий — встроенный scenario главнее scenario_id; scn-delay-14 в plan даёт ряд worse (C-009); дорожка — гипотетическое событие; неизвестный scenario_id — E_SCHEMA', () => {
  const delay = run(G, { scenario_id: 'scn-delay-14' });
  assert.deepEqual(delay.series.plan.trough, AG.series.worse.trough, 'delay_income 14 в plan = ряд worse по trough');
  assert.deepEqual(delay.series.plan.close, AG.series.worse.close);
  assert.equal(delay.q1.plan.min, 183000);
  const tm = run(G, { scenario_id: 'scn-treadmill' });
  assert.ok(tm.events.plan.some((e) => e.layer === 'hypothetical' && e.amount_minor === -30000 && e.date === iso('2026-10-12')));
  assert.equal(tm.series.plan.free[iso('2026-11-01') - tm.as_of], 93500 - 30000);
  const inline = { scenario_id: 'inline-1', ops: [{ op: 'add_purchase', parts: [{ date: '2026-10-12', amount_minor: 30000 }] }] };
  assert.deepEqual(run(G, { scenario: inline, scenario_id: 'scn-delay-14' }).series, tm.series, 'scenario главнее scenario_id');
  throws_code(() => run(G, { scenario_id: 'нет такого' }), 'E_SCHEMA');
});

test('analyze query: modes — по умолчанию [plan, worse]; один режим — только он; conservative = worse; expected (v2) — E_SCHEMA', () => {
  const p = run(G, { modes: ['plan'] });
  assert.deepEqual(Object.keys(p.series), ['plan']);
  assert.deepEqual(Object.keys(p.events), ['plan']);
  assert.deepEqual(p.series.plan, AG.series.plan);
  const w = run(G, { modes: ['conservative'] });
  assert.deepEqual(Object.keys(w.series), ['worse']);
  assert.deepEqual(w.series.worse, AG.series.worse);
  assert.deepEqual(Object.keys(run(G, { modes: ['worse', 'plan', 'plan'] }).series), ['worse', 'plan'], 'повторы убираются');
  throws_code(() => run(G, { modes: ['expected'] }), 'E_SCHEMA');
  throws_code(() => run(G, { modes: ['bogus'] }), 'E_SCHEMA');
});

test('analyze query: D — дата Q1 (по умолчанию horizon_end): к 10-26 min 215500 · 10-26 в обоих режимах; к 11-05 — 205500 · 10-31; к 11-30 — 205500 (plan) и 183000 (worse); D за горизонтом — beyond_horizon; D < as_of — E_BAD_DATE', () => {
  const at = (D) => run(G, { D });
  assert.deepEqual([at('2026-10-26').q1.plan.min, at('2026-10-26').q1.plan.at, at('2026-10-26').q1.worse.min], [215500, iso('2026-10-26'), 215500]);
  assert.deepEqual([at('2026-11-05').q1.plan.min, at('2026-11-05').q1.plan.at, at('2026-11-05').q1.worse.min, at('2026-11-05').q1.worse.at], [205500, iso('2026-10-31'), 205500, iso('2026-10-31')]);
  assert.deepEqual([AG.q1.plan.min, AG.q1.worse.min], [205500, 183000]);
  assert.deepEqual([AG.q1.plan.at, AG.q1.worse.at], [iso('2026-10-31'), iso('2026-11-14')]);
  assert.deepEqual([AG.q1.plan.ok_cash, AG.q1.plan.ok_buffer, AG.q1.worse.ok_cash, AG.q1.worse.ok_buffer], [true, true, true, true]);
  assert.equal(AG.q1.plan.first_breach, null);
  assert.deepEqual(at('2026-12-31').q1, { plan: { beyond_horizon: true }, worse: { beyond_horizon: true } });
  assert.deepEqual(at('2026-11-30').q1, AG.q1);
  assert.deepEqual(AG.q1.plan, answer_q1(AG.series.plan, AG.horizon_end, 50000));
  assert.equal(runway_days(AG.series.plan, AG.events.plan).with, null, 'расходы 339000 < остатка 400000: за горизонтом');
  assert.equal(runway_days(AG.series.worse, AG.events.worse).without, null);
  throws_code(() => at('2026-10-03'), 'E_BAD_DATE');
});

test('analyze query: buffer_minor перекрывает ws.params.buffer_minor только для этого вызова; null в params → B = 0 в Q1 и W_BUFFER_UNSET; отрицательный буфер — E_SCHEMA', () => {
  const o = run(G, { buffer_minor: 70000 });
  assert.equal(o.buffer_minor, 70000);
  assert.equal(o.params.buffer_minor, 70000);
  assert.equal(AG.buffer_minor, 50000, 'исходная рабочая область не тронута');
  assert.deepEqual(o.series, AG.series, 'буфер на ряды не влияет');
  assert.equal(o.q1.plan.ok_buffer, true);
  assert.equal(run(G, { buffer_minor: 300000 }).q1.plan.ok_buffer, false);
  assert.equal(run(G, { buffer_minor: 300000 }).q1.plan.need, 300000 - 205500);
  assert.notEqual(o.inputs_hash, AG.inputs_hash);
  const none = run({ ...G, params: { ...G.params, buffer_minor: null } });
  assert.equal(none.buffer_minor, null);
  assert.ok(none.warnings.some((w) => w.code === 'W_BUFFER_UNSET'));
  assert.equal(none.q1.plan.need, 0, 'B = 0');
  assert.equal(run({ ...G, params: { ...G.params, buffer_minor: null } }, { buffer_minor: 0 }).buffer_minor, 0, 'явный 0 — «задан»');
  assert.ok(!run({ ...G, params: { ...G.params, buffer_minor: null } }, { buffer_minor: 0 }).warnings.some((w) => w.code === 'W_BUFFER_UNSET'));
  throws_code(() => run(G, { buffer_minor: -1 }), 'E_SCHEMA');
  throws_code(() => run(G, { buffer_minor: 1.5 }), 'E_NOT_INTEGER');
});

test('analyze: порог волны — params.wave.threshold_minor, если не задан — default_wave_threshold (G-001: max(3000, 2100) = 3000); параметры можно задать вложенным объектом', () => {
  const ws = { ...G, params: { ...G.params } };
  delete ws.params['wave.threshold_minor'];
  assert.equal(run(ws).params['wave.threshold_minor'], 3000);
  assert.deepEqual(list_waves(run(ws), 'plan').map((x) => x.wave.total_out_minor), [152000, 102000]);
  const nested = { ...G, params: { horizon_days: 57, buffer_minor: 50000, wave: { gap_days: 2, max_span_days: 10, threshold_minor: 3000 } } };
  assert.equal(list_waves(run(nested), 'plan').length, 3, 'gap_days = 2 → три волны');
});

// ── резервы (C-020) ────────────────────────────────────────────────────────────────────────────────────────────────────

test('analyze резервы (C-020): funded_open = funded_start + Σ записанных аллокаций с funded_as_of < date ≤ as_of — ряды те же, что при funded_start = 150000; запись на as_of идёт в funded_open', () => {
  const ws = {
    ...G,
    reserves: G.reserves.map((r) => (r.reserve_id === 'RES-TAX' ? { ...r, funded_start_minor: 100000, funded_as_of: '2026-09-01' } : r)),
    allocations: [
      { allocation_id: 'tax:TR-20@sep-1', reserve_id: 'RES-TAX', date: '2026-09-15', amount_minor: 30000, source: 'income' },
      { allocation_id: 'tax:TR-20@sep-2', reserve_id: 'RES-TAX', date: '2026-10-04', amount_minor: 20000, source: 'income' }, // на as_of — входит в funded_open
      { allocation_id: 'tax:TR-20@old', reserve_id: 'RES-TAX', date: '2026-08-01', amount_minor: 999999, source: 'income' }, // до funded_as_of — уже в funded_start
    ],
  };
  const a = run(ws);
  assert.equal(a.series.plan.reserve_opening_minor, 150000);
  assert.deepEqual(a.series.plan.free, AG.series.plan.free);
  assert.deepEqual(a.series.worse.reserve_close, AG.series.worse.reserve_close);
});

test('analyze резервы: привязанный к счёту резерв (backed_by_account_id) в ряд не входит; sinking без mode — E_SCHEMA; резерв не в валюте решения — E_CURRENCY_MISMATCH', () => {
  const backed = run({ ...G, reserves: G.reserves.map((r) => (r.reserve_id === 'RES-TAX' ? { ...r, backed_by_account_id: 'acc_main' } : r)) });
  assert.equal(backed.series.plan.reserve_opening_minor, 0);
  assert.ok(backed.series.plan.reserve_trough.every((x) => x === 0 || x <= 12000), 'остался только RES-INS (взнос 12000)');
  throws_code(() => run({ ...G, reserves: G.reserves.map((r) => (r.reserve_id === 'RES-INS' ? { ...r, mode: undefined } : r)) }), 'E_SCHEMA');
  throws_code(() => run({ ...G, reserves: G.reserves.map((r) => (r.reserve_id === 'RES-TAX' ? { ...r, currency: 'USD' } : r)) }), 'E_CURRENCY_MISMATCH');
});

test('analyze: плановые взносы sinking идемпотентны к записанным аллокациям — взнос 11-01 пересчитывается от funded_open; записанная sch:-аллокация на as_of исключает дубль', () => {
  // на as_of = 2026-11-01 запись sch:RES-INS@2026-11-01 (date ≤ as_of) входит в funded_open, будущий взнос на 11-01 не дублируется
  const ws = {
    ...G,
    allocations: [{ allocation_id: 'sch:RES-INS@2026-11-01', reserve_id: 'RES-INS', date: '2026-11-01', amount_minor: 12000, source: 'schedule' }],
    reserves: G.reserves.map((r) => (r.reserve_id === 'RES-INS' ? { ...r, funded_as_of: '2026-10-04' } : r)),
  };
  const a = analyze(ws, { as_of: '2026-11-01', horizon_end: '2026-11-30' });
  const ins = a.reserve.plan.by_reserve['RES-INS'];
  assert.equal(ins.trough[0], 12000, 'запись на as_of — в funded_open');
  assert.equal(ins.contributed[0], 0, 'взнос того же дня не дублируется');
  assert.equal(ins.close.at(-1), 12000 + 12000 * 0, 'следующий взнос — 12-01, вне горизонта');
});

// ── предупреждения ───────────────────────────────────────────────────────────────────────────────────────────────────

test('analyze предупреждения: на G-001 нет; W_NO_RESERVES при доходе без правил и резервов; W_RULE_STALE / W_RULE_DISABLED по сроку годности правила; список уникален и упорядочен', () => {
  assert.deepEqual(AG.warnings, []);
  const bare = run({ ...G, reserves: [], tax_rules: [] });
  assert.deepEqual(bare.warnings, [{ code: 'W_NO_RESERVES' }]);
  const no_income = run({ ...G, reserves: [], tax_rules: [], streams: [] });
  assert.ok(!no_income.warnings.some((w) => w.code === 'W_NO_RESERVES'), 'нет дохода — нет плашки');
  const st = run({ ...G, tax_rules: [{ ...G.tax_rules[0], reviewed_at: '2026-01-01', ttl_days: 200 }] });
  assert.deepEqual(st.warnings, [{ code: 'W_RULE_STALE', rule_id: 'TR-20' }], 'по одному на правило, а не по режиму');
  const dis = run({ ...G, tax_rules: [{ ...G.tax_rules[0], reviewed_at: '2026-01-01', ttl_days: 100 }] });
  assert.deepEqual(dis.warnings, [{ code: 'W_RULE_DISABLED', rule_id: 'TR-20' }]);
  assert.deepEqual(dis.series, AG.series, 'правило disabled: расчёт free продолжается (C-024)');
  const many = run({ ...G, reserves: [], tax_rules: [], params: { ...G.params, buffer_minor: null } });
  const keys = many.warnings.map((w) => JSON.stringify(w));
  assert.equal(new Set(keys).size, keys.length, 'без повторов');
  assert.deepEqual(many.warnings.map((w) => w.code), ['W_BUFFER_UNSET', 'W_NO_RESERVES']);
});

test('analyze предупреждения по резервам sinking (C-030, C-059): W_RESERVE_BEHIND — не записан взнос до as_of; W_RESERVE_OVERDUE — срок прошёл, платежа нет; W_RESERVE_RESIDUAL — платёж был, остаток остаётся', () => {
  const base = {
    ...G,
    reserves: [{ reserve_id: 'RES-INS', kind: 'sinking', name: 'Страховка', currency: 'EUR', funded_start_minor: 5000, funded_as_of: '2026-08-01', target_minor: 60000,
      due_date: '2026-09-15', cadence: { freq: 'M', day: 1 }, mode: 'refill_to_target', backed_by_account_id: null }],
    tax_rules: [], streams: [],
  };
  // срок прошёл, привязанного платежа нет → OVERDUE; взносы 09-01 и 10-01 (< as_of) не записаны, но 10-01 после срока → отстают 09-01
  const a = run(base);
  assert.ok(a.warnings.some((w) => w.code === 'W_RESERVE_OVERDUE' && w.reserve_id === 'RES-INS'));
  assert.ok(a.warnings.some((w) => w.code === 'W_RESERVE_BEHIND' && w.reserve_id === 'RES-INS'), 'взнос 09-01 не записан');
  // записаны взносы 09-01 → не отстаёт
  const rec = run({ ...base, allocations: [{ allocation_id: 'sch:RES-INS@2026-09-01', reserve_id: 'RES-INS', date: '2026-09-01', amount_minor: 5000, source: 'schedule' }] });
  assert.ok(!rec.warnings.some((w) => w.code === 'W_RESERVE_BEHIND'), 'записанный взнос закрывает отставание');
  // был привязанный платёж (posted) после funded_as_of → RESIDUAL вместо OVERDUE
  const paid = run({ ...base, facts: [...G.facts, { event_id: 'f-ins', account_id: 'acc_main', date: '2026-09-10', amount_minor: -3000, currency: 'EUR', reserve_id: 'RES-INS', kind: 'expense' }] });
  assert.ok(paid.warnings.some((w) => w.code === 'W_RESERVE_RESIDUAL' && w.reserve_id === 'RES-INS'));
  assert.ok(!paid.warnings.some((w) => w.code === 'W_RESERVE_OVERDUE'));
  // срок не прошёл — предупреждений OVERDUE/RESIDUAL нет
  const future = run({ ...base, reserves: [{ ...base.reserves[0], due_date: '2027-03-15', funded_as_of: '2026-10-04' }] });
  assert.ok(!future.warnings.some((w) => w.code === 'W_RESERVE_OVERDUE' || w.code === 'W_RESERVE_RESIDUAL'));
});

// ── inputs_hash и детерминизм (TST-33, часть) ────────────────────────────────────────────────────────────────────────

test('TST-33 analyze: тот же ws и query → тот же результат побайтно и тот же inputs_hash; порядок записей в массивах рабочей области и ключей на хэш не влияет', () => {
  const again = run(G);
  assert.equal(JSON.stringify(again), JSON.stringify(AG));
  assert.equal(again.inputs_hash, AG.inputs_hash);
  const rev = (xs) => [...xs].reverse();
  const shuffled = {
    ...G, accounts: rev(G.accounts), anchors: rev(G.anchors), facts: rev(G.facts), rules: rev(G.rules), plans: rev(G.plans), streams: rev(G.streams),
    tax_rules: rev(G.tax_rules), reserves: rev(G.reserves), calendars: rev(G.calendars), scenarios: rev(G.scenarios), purchases: rev(G.purchases),
    params: Object.fromEntries(Object.entries(G.params).reverse()),
  };
  const s = run(shuffled);
  assert.equal(s.inputs_hash, AG.inputs_hash);
  assert.deepEqual(s.series, AG.series);
  assert.deepEqual(s.warnings, AG.warnings);
  // словарь «id → запись» вместо массива даёт тот же результат (форма ledger.reduce)
  const dict = { ...G, rules: Object.fromEntries(G.rules.map((r) => [r.rule_id, r])), reserves: Object.fromEntries(G.reserves.map((r) => [r.reserve_id, r])) };
  assert.equal(run(dict).inputs_hash, AG.inputs_hash);
  assert.deepEqual(run(dict).series, AG.series);
});

test('TST-33 inputs_hash: смена as_of, горизонта, params, буфера, версии правила, записи, сценария, режимов или D меняет хэш; engine_version входит в окно', () => {
  const h = (ws, q) => run(ws, q).inputs_hash;
  const seen = new Set([AG.inputs_hash]);
  const variants = [
    h(G, { horizon_end: '2026-11-29' }), h(G, { buffer_minor: 50001 }), h(G, { scenario_id: 'scn-treadmill' }), h(G, { modes: ['plan'] }), h(G, { D: '2026-11-01' }),
    h({ ...G, params: { ...G.params, 'worse.income_delay_days': 15 } }),
    h({ ...G, tax_rules: [{ ...G.tax_rules[0], rate_bp: 2001 }] }),
    h({ ...G, facts: [...G.facts, { event_id: 'f-new', account_id: 'acc_main', date: '2026-10-03', amount_minor: -1, currency: 'EUR', kind: 'expense' }] }),
    h({ ...G, wave_overrides: [{ override_id: 'w', action: 'split', event_ids: ['P-TAX1'], seq: 1 }] }),
  ];
  for (const v of variants) {
    assert.match(v, /^[0-9a-f]{64}$/);
    assert.ok(!seen.has(v), 'хэш изменился');
    seen.add(v);
  }
  const later = analyze({ ...G, anchors: G.anchors }, { as_of: '2026-10-05' });
  assert.ok(!seen.has(later.inputs_hash), 'as_of меняет хэш');
});

test('TST-33 analyze: случайные рабочие области (200 случаев, seed 3301) — повторный вызов и перестановка планов дают тот же хэш и ряды; ошибки: float в данных — E_NOT_INTEGER, posted позже as_of — E_FUTURE_POSTED', () => {
  const rng = make_rng(3301);
  for (let c = 0; c < 200; c++) {
    const as_of = 20000 + rng.int(0, 500);
    const plans = Array.from({ length: rng.int(1, 14) }, (_, k) => {
      const income = rng.bool();
      return { plan_id: 'p' + k, account_id: 'a', date: as_of + rng.int(0, 60), amount_minor: income ? rng.int(1, 8000) : -rng.int(1, 8000), currency: 'EUR', kind: income ? 'income' : 'expense', tag: 't' };
    });
    const ws = {
      decision_currency: 'EUR', params: { horizon_days: 61 }, accounts: [{ account_id: 'a', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 }],
      anchors: [{ anchor_id: 'an', account_id: 'a', date: as_of, amount_minor: rng.int(0, 15000) }], plans,
    };
    const a = analyze(ws, { as_of });
    const b = analyze({ ...ws, plans: [...plans].sort(() => rng.next() - 0.5) }, { as_of });
    assert.equal(b.inputs_hash, a.inputs_hash, `случай ${c}`);
    assert.deepEqual(b.series, a.series, `случай ${c}`);
    assert.equal(a.buffer_minor, null);
    assert.ok(a.warnings.some((w) => w.code === 'W_BUFFER_UNSET'));
  }
  const bad = { ...G, facts: [...G.facts, { event_id: 'future', account_id: 'acc_main', date: '2026-10-05', amount_minor: -1, currency: 'EUR', kind: 'expense' }] };
  throws_code(() => run(bad), 'E_FUTURE_POSTED');
  throws_code(() => run({ ...G, plans: [{ ...G.plans[0], amount_minor: -500.5 }] }), 'E_NOT_INTEGER');
});

// ── реэкспорт публичного API ───────────────────────────────────────────────────────────────────────────────────────────

test('index.mjs реэкспортирует публичный API: money, dates, recurrence, hourly, fx, tax, debt, calibration, timeline, sinking, waves, afford, ledger + analyze и ENGINE_VERSION', () => {
  const need = [
    'analyze', 'ENGINE_VERSION',
    'assert_minor', 'mul_div', 'round_div', 'split_equal', 'parse_date', 'format_date', 'expand_all', 'gross_pay', 'convert_minor', 'allocations_for_events', 'annuity_payment',
    'match_plan_to_fact', 'opening_state', 'build_events', 'project', 'narrowest_point', 'answer_q1', 'purchase_to_events', 'readiness', 'explain_narrowest',
    'reserve_series', 'free_series', 'contribution_allocations', 'reserve_open',
    'detect_waves', 'apply_wave_overrides', 'next_income_day', 'wave_metrics', 'list_waves',
    'suffix_min', 'gate', 'normalize_parts', 'verdict_of', 'check_purchase', 'max_amount', 'earliest_date', 'binding_events', 'safe_to_spend', 'sts_breakdown', 'default_sts_horizon',
    'canon', 'sha256', 'inputs_hash',
  ];
  for (const name of need) assert.ok(name in engine, `index.mjs экспортирует ${name}`);
  assert.equal(typeof engine.analyze, 'function');
  assert.match(ENGINE_VERSION, /^\d+\.\d+\.\d+$/);
  // engine_version совпадает с версией пакета
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(ENGINE_VERSION, pkg.version);
});
