// validate_ws.test.mjs — FP-02: проверка чужой рабочей области и журнала до расчёта (REQ-016, REQ-017, REQ-158, К-4, Q-12, Q-22).
// Покрывает: TST-31 (коды ошибок модели REQ-017: по негативному тесту на каждый из восьми кодов), TST-51 (REQ-158: фаззинг повреждённых журналов
// — результат или код, 0 необработанных исключений; число прогонов повышается переменной FUZZ_N / HARDEN_FUZZ_N), TST-54 (horizon_days вне предела
// → E_SCHEMA быстрее 50 мс), TST-38 (журнал: форматы и версии), режим карантина (Q-22).
// Ожидания выведены из канона (design-brief §3, §4; REQ-017; К-4), а не из вывода проверяющего кода. В тестах допустимы node:fs и Date.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { analyze } from '../engine/index.mjs';
import { ERROR_CODES } from '../engine/money.mjs';
import { make_event, EVENT_TYPES } from '../engine/ledger.mjs';
import { read_journal_json } from '../engine/io.mjs';
import { TIMELINE_DEFAULTS, HORIZON_DAYS_MAX } from '../engine/timeline.mjs';
import {
  validate_ws, validate_journal, quarantine_invalid, analyze_checked, check_params, assert_params, param_defaults, PARAM_RANGES, WS_LIMITS,
} from '../engine/validate_ws.mjs';
import { make_rng, throws_code } from './helpers.mjs';
import { fuzz_progress } from './fuzz_progress.mjs'; // FP-24: ход длинного цикла для tools/fuzz_nightly.mjs (без переменной RUNWAY_FUZZ_PROGRESS ничего не делает)

const DATA = new URL('../data/', import.meta.url);
const load = (name) => JSON.parse(fs.readFileSync(new URL(name, DATA), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const G = load('g001.json');
const REQ017 = ['E_NOT_INTEGER', 'E_OVERFLOW', 'E_BAD_DATE', 'E_FUTURE_POSTED', 'E_RULE_INVALID', 'E_CURRENCY_MISMATCH', 'E_NO_RATE', 'E_SCHEMA'];
const FUZZ_N = Math.max(1200, Number(process.env.FUZZ_N ?? process.env.HARDEN_FUZZ_N ?? 0) || 0);
const reasons = (r) => r.errors.map((e) => e.reason);
const first_code = (r) => r.errors[0]?.code;
const with_ws = (fn) => { const ws = clone(G); fn(ws); return ws; };

// ═══ чистые данные ════════════════════════════════════════════════════════════════════════════════════════════════════

test('REQ-017 validate_ws: эталонные наборы G-001, low, gap, late проходят без ошибок и предупреждений; число записей посчитано', () => {
  for (const name of ['g001.json', 'g001-low.json', 'g001-gap.json', 'g001-late.json']) {
    const r = validate_ws(load(name));
    assert.deepEqual(r.errors, [], name);
    assert.deepEqual(r.warnings, [], name);
    assert.equal(r.ok, true);
    assert.ok(r.stats.records >= 40, name);
  }
});

test('REQ-017 TST-31 по негативному тесту на каждый из восьми кодов ошибок модели: validate_ws называет код, путь записи и Id, но не значение', () => {
  const cases = {
    E_NOT_INTEGER: with_ws((ws) => { ws.facts[0].amount_minor = 19.99; }),
    E_OVERFLOW: with_ws((ws) => { ws.facts[0].amount_minor = 2 ** 53; }),
    E_BAD_DATE: with_ws((ws) => { ws.anchors[0].date = '2026-02-30'; }),
    E_FUTURE_POSTED: with_ws((ws) => { ws.facts[0].date = '2026-10-05'; }),
    E_RULE_INVALID: with_ws((ws) => { ws.rules[0].interval = 0; }),
    E_CURRENCY_MISMATCH: with_ws((ws) => { ws.facts[0].currency = 'USD'; }),
    E_SCHEMA: with_ws((ws) => { ws.facts[0].account_id = 'нет-такого'; }),
  };
  for (const [code, ws] of Object.entries(cases)) {
    const r = validate_ws(ws);
    assert.equal(r.ok, false, code);
    assert.ok(r.errors.some((e) => e.code === code), `${code}: ${JSON.stringify(r.errors)}`);
    for (const e of r.errors) {
      assert.ok(REQ017.includes(e.code), e.code);
      assert.ok(typeof e.path === 'string');
      assert.ok(!JSON.stringify(e).includes('19.99'), 'значение поля в ошибку не попадает');
    }
  }
  // E_NO_RATE — свойство расчёта, не формы: analyze_checked возвращает код, а не исключение
  const usd = with_ws((ws) => {
    ws.accounts.push({ account_id: 'usd', name: 'USD', kind: 'bank', liquidity: 'operating', currency: 'USD', exponent: 2, opened_on: '2026-01-01' });
    ws.anchors.push({ anchor_id: 'a-usd', account_id: 'usd', date: '2026-10-04', amount_minor: 100 });
  });
  assert.equal(validate_ws(usd).ok, true);
  const out = analyze_checked(usd, { as_of: usd.as_of });
  assert.deepEqual([out.ok, out.code], [false, 'E_NO_RATE']);
  assert.ok(ERROR_CODES.includes(out.code));
});

test('REQ-017 TST-31 перевод с ногами −50000 и +49999 в одной валюте отвергается; −50000 и +50000 — норма; одиночная нога — предупреждение, не ошибка', () => {
  const leg = (id, amt) => ({ plan_id: id, account_id: 'acc_main', currency: 'EUR', date: '2026-10-20', amount_minor: amt, kind: 'transfer', transfer_id: 'T1' });
  const bad = with_ws((ws) => { ws.plans.push(leg('o', -50000), leg('i', 49999)); });
  const r = validate_ws(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'E_SCHEMA' && e.reason === 'transfer_legs_not_zero' && e.id === 'T1'));
  assert.equal(validate_ws(with_ws((ws) => { ws.plans.push(leg('o', -50000), leg('i', 50000)); })).ok, true);
  const one = validate_ws(with_ws((ws) => { ws.plans.push(leg('o', -50000)); }));
  assert.equal(one.ok, true);
  assert.deepEqual(one.warnings, [{ code: 'W_TRANSFER_UNPAIRED', transfer_id: 'T1' }]);
});

// ═══ форма, формат, размеры ═══════════════════════════════════════════════════════════════════════════════════════════

test('REQ-158 validate_ws не бросает на любом входе: примитивы, null, массивы, функции, циклы, Map — всегда {ok: false, errors} с кодом из набора', () => {
  const cyc = clone(G);
  cyc.params.self = cyc;
  cyc.facts[0].loop = cyc.facts;
  for (const x of [null, undefined, 0, 'text', true, [], [1, 2], () => 1, Symbol('s'), 10n, new Map(), new Date(0), cyc, Object.create(null)]) {
    let r;
    assert.doesNotThrow(() => { r = validate_ws(x); }, String(typeof x));
    if (x === cyc) { assert.equal(r.ok, false); continue; }
    if (x !== undefined && typeof x === 'object' && x !== null && !Array.isArray(x) && !(x instanceof Map) && !(x instanceof Date)) continue; // пустой объект: ошибок формы нет
    assert.equal(r.ok, false);
    assert.ok(r.errors.every((e) => REQ017.includes(e.code)));
  }
  assert.doesNotThrow(() => validate_journal(cyc));
  assert.doesNotThrow(() => validate_journal(null));
});

test('REQ-016 формат файла: runway-journal/1 принят; /2 — newer_format (только чтение, read_only); мусор вместо формата — bad_format', () => {
  assert.equal(validate_ws(with_ws((ws) => { ws.format = 'runway-journal/1'; })).ok, true);
  const newer = validate_ws(with_ws((ws) => { ws.format = 'runway-journal/2'; }));
  assert.deepEqual([newer.ok, newer.read_only], [false, true]);
  assert.ok(reasons(newer).includes('newer_format'));
  for (const f of ['journal/1', 'runway-journal/0', 'runway-journal/01', 42, {}]) assert.ok(reasons(validate_ws(with_ws((ws) => { ws.format = f; }))).includes('bad_format'), JSON.stringify(f));
});

test('REQ-158 размеры и вложенность: лишние записи, длинные строки и идентификаторы, глубина и узлы сверх пределов — ошибки, а не память и стек; пределы сужаются через opts.limits', () => {
  const big = with_ws((ws) => { ws.facts = Array.from({ length: 50 }, (_, i) => ({ ...ws.facts[0], event_id: 'f' + i })); });
  assert.equal(validate_ws(big).ok, true);
  assert.ok(reasons(validate_ws(big, { limits: { max_records: 10 } })).includes('too_many_records'));
  assert.ok(reasons(validate_ws(with_ws((ws) => { ws.facts[0].note = 'x'.repeat(WS_LIMITS.max_string + 1); }))).includes('string_too_long'));
  assert.ok(reasons(validate_ws(with_ws((ws) => { ws.facts[0].event_id = 'x'.repeat(WS_LIMITS.max_id + 1); }))).includes('id_too_long'));
  let deep = [];
  for (let i = 0; i < 5000; i++) deep = [deep];
  const r = validate_ws(with_ws((ws) => { ws.facts[0].note = deep; }));
  assert.ok(reasons(r).includes('too_deep'));
  assert.ok(reasons(validate_ws(big, { limits: { max_nodes: 100 } })).includes('too_many_nodes'));
  assert.ok(reasons(validate_ws(with_ws((ws) => { ws.facts[0].event_id = 'a\u0000b'; }))).includes('id_control_chars'));
  assert.ok(reasons(validate_ws(with_ws((ws) => { ws.facts[0].note = () => 1; }))).includes('not_json_value'));
  assert.ok(reasons(validate_ws(with_ws((ws) => { ws.facts[0].note = new Date(0); }))).includes('not_plain_object'));
  assert.equal(validate_ws(big, { limits: { max_errors: 3, max_records: 1 } }).errors.length <= 3, true);
});

test('ADR-013 REQ-158 ключ «__proto__» как ИМЯ поля (JSON.parse) — ошибка forbidden_key; как значение идентификатора — допустим', () => {
  const evil = JSON.parse(JSON.stringify(G).replace('"tag":"связь"', '"__proto__":{"admin":true},"tag":"связь"'));
  const r = validate_ws(evil);
  assert.ok(reasons(r).includes('forbidden_key'), JSON.stringify(r.errors));
  assert.equal(({}).admin, undefined);
  const as_value = with_ws((ws) => { ws.facts[0].event_id = '__proto__'; });
  assert.equal(validate_ws(as_value).ok, true);
});

// ═══ уникальность Id ═══════════════════════════════════════════════════════════════════════════════════════════════════

test('REQ-010 REQ-017 уникальность Id: дубли по спискам отвергаются; rule_id и stream_id — одно пространство Id (совпадение отвергается)', () => {
  const dup = (list, mut) => validate_ws(with_ws((ws) => { ws[list].push({ ...ws[list][0], ...(mut ?? {}) }); }));
  for (const list of ['accounts', 'anchors', 'facts', 'rules', 'streams', 'reserves', 'plans', 'calendars', 'scenarios', 'purchases']) {
    const r = dup(list);
    assert.ok(r.errors.some((e) => e.reason === 'duplicate_id' && e.kind === list), list + ': ' + JSON.stringify(r.errors.slice(0, 2)));
  }
  const clash = validate_ws(with_ws((ws) => { ws.streams[0].stream_id = ws.rules[0].rule_id; }));
  assert.ok(reasons(clash).includes('id_space_collision'));
  assert.ok(reasons(validate_ws(with_ws((ws) => { ws.rules[0].rule_id = ''; }))).includes('id_required') || reasons(validate_ws(with_ws((ws) => { ws.rules[0].rule_id = ''; }))).includes('required'));
});

test('REQ-017 ссылки и знаки: неизвестный счёт, календарь, резерв; доход с отрицательной аллокацией; курс с нулевым знаменателем; перевод в чужой валюте резерва', () => {
  assert.ok(reasons(validate_ws(with_ws((ws) => { ws.rules[0].calendar_id = 'нет'; }))).includes('unknown_calendar'));
  assert.ok(reasons(validate_ws(with_ws((ws) => { ws.tax_rules[0].reserve_id = 'нет'; }))).includes('unknown_reserve'));
  assert.ok(reasons(validate_ws(with_ws((ws) => { ws.allocations.push({ allocation_id: 'x', reserve_id: 'RES-TAX', date: '2026-10-05', amount_minor: -1, source: 'income' }); }))).includes('income_allocation_negative'));
  assert.ok(reasons(validate_ws(with_ws((ws) => { ws.rates.push({ fx_id: 'f', date: '2026-10-01', base: 'USD', quote: 'EUR', num: 1, den: 0 }); }))).includes('rate_part_not_positive'));
  const cm = validate_ws(with_ws((ws) => { ws.reserves[0].currency = 'USD'; }));
  assert.ok(cm.errors.some((e) => e.code === 'E_CURRENCY_MISMATCH'));
  assert.ok(reasons(validate_ws(with_ws((ws) => { ws.reserves[1].kind = 'sinking'; delete ws.reserves[1].mode; }))).includes('sinking_needs_mode'));
  const tm = validate_ws(with_ws((ws) => { ws.reserves.push({ reserve_id: 'RT', kind: 'sinking', mode: 'refill_to_target', due_date: '2027-03-15', currency: 'EUR', funded_start_minor: 0 }); }));
  assert.ok(reasons(tm).includes('target_missing'));
  assert.ok(reasons(validate_ws(with_ws((ws) => { ws.accounts[0].liquidity = 'cash'; }))).includes('unknown_liquidity'));
  assert.ok(reasons(validate_ws(with_ws((ws) => { ws.overrides.push({ rule_id: 'R-RENT', nominal_date: '2026-11-01', action: 'set_amount', amount_minor: 5000 }); }))).includes('override_sign'));
});

// ═══ параметры (К-4, Q-12) ════════════════════════════════════════════════════════════════════════════════════════════

test('Q-12 К-4 check_params: horizon_days 3661 / 10^9 / NaN / «abc», income_delay_days 10^9, window_days 99, max_calls 10^9 → значение по умолчанию + предупреждение; допустимые — сохранены', () => {
  const bad = { horizon_days: 3661, 'worse.income_delay_days': 1e9, 'match.window_days': 99, 'tools.max_calls': 1e9, buffer_hint_days: 'abc' };
  const r = check_params(bad);
  assert.equal(r.ok, false);
  assert.deepEqual(r.params, {}, 'ничего недопустимого не осталось: действуют значения по умолчанию');
  assert.deepEqual(r.warnings.map((w) => w.key).sort(), Object.keys(bad).sort());
  for (const v of [3661, 1e9, NaN, 'abc', -1, 0, 1.5, null, Infinity, Number.MAX_SAFE_INTEGER + 2]) assert.equal(check_params({ horizon_days: v }).ok, false, String(v));
  for (const v of [1, 57, 180, 3660]) assert.deepEqual(check_params({ horizon_days: v }).params, { horizon_days: v });
  assert.deepEqual(check_params({ worse: { income_delay_days: 14 }, match: { window_days: 3 } }).params, { 'worse.income_delay_days': 14, 'match.window_days': 3 }, 'вложенная форма разворачивается в плоские ключи');
  assert.deepEqual(check_params({ headline_mode: 'plan', rounding: 'half_up', buffer_minor: 0, decision_currency: 'EUR' }).problems, []);
  assert.equal(check_params({ headline_mode: 'nope' }).ok, false);
  assert.equal(check_params({ buffer_minor: -1 }).ok, false);
  assert.equal(check_params(null).ok, true);
  assert.equal(check_params(JSON.parse('{"__proto__": 1}')).ok, true, '«__proto__» не параметр: пропускается, не ломает');
  // умолчания TIMELINE_DEFAULTS укладываются в собственные диапазоны
  for (const [k, v] of Object.entries(TIMELINE_DEFAULTS)) if (Object.hasOwn(PARAM_RANGES, k)) assert.equal(check_params({ [k]: v }).ok, true, k);
  assert.deepEqual(param_defaults(), { ...TIMELINE_DEFAULTS });
  throws_code(() => assert_params({ horizon_days: 3661 }), 'E_SCHEMA');
  assert.doesNotThrow(() => assert_params({ horizon_days: 3660 }));
});

test('REQ-158 К-4 validate_ws: параметр вне диапазона — E_SCHEMA с путём params.<ключ>; карантин подставляет умолчание и предупреждает W_PARAM_OUT_OF_RANGE', () => {
  const ws = with_ws((w) => { w.params.horizon_days = 1e9; w.params['worse.income_delay_days'] = 'abc'; });
  const r = validate_ws(ws);
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.filter((e) => e.kind === 'params').map((e) => e.path).sort(), ['params.horizon_days', 'params.worse.income_delay_days']);
  const q = quarantine_invalid(ws);
  assert.equal(q.ok, true);
  assert.deepEqual(q.warnings.filter((w) => w.code === 'W_PARAM_OUT_OF_RANGE').map((w) => w.key).sort(), ['horizon_days', 'worse.income_delay_days']);
  assert.ok(!('horizon_days' in q.ws_clean.params));
  const a = analyze_checked(ws, { as_of: ws.as_of }, { quarantine: true });
  assert.equal(a.ok, true);
  assert.equal(a.analysis.horizon_end - a.analysis.series.plan.from + 1, 181, 'по умолчанию 180 дней');
  assert.ok(a.warnings.some((w) => w.code === 'W_PARAM_OUT_OF_RANGE'));
});

test('REQ-158 TST-54 horizon_days вне предела → E_SCHEMA быстрее 50 мс (раньше: 37 с на 200 000 дней, 0,75 с до E_BAD_DATE на 3·10^6); предел и ниже — считается', () => {
  for (const days of [HORIZON_DAYS_MAX + 1, 200000, 3000000, 1e9, Number.MAX_SAFE_INTEGER]) {
    for (const where of ['query', 'params']) {
      const ws = clone(G);
      const q = { as_of: ws.as_of };
      if (where === 'query') q.horizon_days = days; else ws.params.horizon_days = days;
      const t0 = performance.now();
      throws_code(() => analyze(ws, q), 'E_SCHEMA');
      const dt = performance.now() - t0;
      assert.ok(dt < 50, `${where}: horizon_days = ${days}: ${dt.toFixed(1)} мс`);
    }
  }
  const t1 = performance.now();
  throws_code(() => analyze(G, { as_of: G.as_of, horizon_end: '2100-01-01' }), 'E_SCHEMA');
  assert.ok(performance.now() - t1 < 50, 'явная дата горизонта сверх предела');
  const ok = analyze(G, { as_of: G.as_of, horizon_days: 90 });
  assert.equal(ok.horizon_end - ok.series.plan.from, 90);
  assert.equal(ok.series.plan.close.length, 91);
});

test('Q-12 tools.max_calls и montecarlo.lag_pool не обходятся параметрами: max_calls 0 / 10^9 → 12; income_delay_days 10^9 → E_SCHEMA без выделения памяти', async () => {
  const { make_tool_ctx, run_tool } = await import('../engine/tools.mjs');
  const { lag_pool } = await import('../engine/montecarlo.mjs');
  for (const bad of [1e9, 0, -3, 13, 'abc', null]) {
    const ctx = make_tool_ctx(G, { as_of: G.as_of });
    ctx.params = { ...ctx.params, 'tools.max_calls': bad };
    ctx.calls_used = 12;
    assert.equal(run_tool('get_tax_envelope', {}, ctx).code, 'E_CALL_LIMIT', `tools.max_calls = ${JSON.stringify(bad)}`);
  }
  const e = { cash_event_id: 'x', plan_date: 20000, date: 20000, kind: 'income', layer: 'planned', status: 'expected', amount_minor: 1000 };
  const t0 = performance.now();
  throws_code(() => lag_pool({ as_of: 20000, lag_obs: {}, params: { 'worse.income_delay_days': 1e9 } }, e), 'E_SCHEMA');
  assert.ok(performance.now() - t0 < 50);
  assert.equal(lag_pool({ as_of: 20000, lag_obs: {}, params: { 'worse.income_delay_days': 14 } }, e).obs.length, 15);
});

// ═══ карантин (Q-22) ═════════════════════════════════════════════════════════════════════════════════════════════════

test('Q-22 карантин: правило с interval = 0 исключено, остальные три правила считаются, предупреждение W_RECORD_QUARANTINED есть; без карантина — строгий отказ с кодом E_RULE_INVALID', () => {
  const ws = with_ws((w) => { w.rules[1].interval = 0; });
  assert.equal(code_of_analyze(ws), 'E_RULE_INVALID', 'прежний analyze бросает');
  const strict = analyze_checked(ws, { as_of: ws.as_of });
  assert.deepEqual([strict.ok, strict.code], [false, 'E_RULE_INVALID']);
  const out = analyze_checked(ws, { as_of: ws.as_of }, { quarantine: true });
  assert.equal(out.ok, true);
  assert.deepEqual(out.rejected.map((r) => [r.kind, r.index, r.id, r.codes]), [['rules', 1, ws.rules[1].rule_id, ['E_RULE_INVALID']]]);
  assert.ok(out.warnings.some((w) => w.code === 'W_RECORD_QUARANTINED' && w.kind === 'rules' && w.id === ws.rules[1].rule_id));
  const clean = clone(G);
  clean.rules.splice(1, 1);
  assert.deepEqual(out.analysis.series.plan.close, analyze(clean, { as_of: clean.as_of }).series.plan.close, 'считается так, будто правила нет');
  assert.equal(ws.rules.length, 4, 'исходная рабочая область не изменена');
  assert.equal(ws.rules[1].interval, 0);
});

test('Q-22 карантин: налоговое правило с rate_bp = 99999 исключено; каскад — факт с неизвестным счётом, затем ссылки на исключённое; golden на чистых данных не меняется', () => {
  const ws = with_ws((w) => { w.tax_rules[0].rate_bp = 99999; w.facts[3].account_id = 'призрак'; });
  const q = quarantine_invalid(ws);
  assert.equal(q.ok, true);
  assert.deepEqual(q.rejected.map((r) => r.kind).sort(), ['facts', 'tax_rules']);
  assert.equal(q.ws_clean.tax_rules.length, 0);
  assert.equal(q.ws_clean.facts.length, G.facts.length - 1);
  assert.equal(validate_ws(q.ws_clean).ok, true);
  const a = analyze_checked(ws, { as_of: ws.as_of }, { quarantine: true });
  assert.equal(a.ok, true);
  // чистые данные: карантин ничего не исключает, результат побайтно равен прямому analyze
  const direct = analyze(G, { as_of: G.as_of });
  const via = analyze_checked(G, { as_of: G.as_of }, { quarantine: true });
  assert.equal(via.ok, true);
  assert.deepEqual(via.rejected, []);
  assert.equal(via.analysis.inputs_hash, direct.inputs_hash);
  assert.deepEqual(via.analysis.series, direct.series);
  const strict = analyze_checked(G, { as_of: G.as_of });
  assert.equal(strict.analysis.inputs_hash, direct.inputs_hash);
});

test('Q-22 карантин: ошибки уровня файла (не объект, формат из будущего, неверный as_of) не исправляются — ws_clean = null и fatal; ответ analyze_checked — код', () => {
  for (const bad of [null, 5, [], 'x']) {
    const q = quarantine_invalid(bad);
    assert.deepEqual([q.ok, q.ws_clean], [false, null]);
    assert.equal(q.fatal[0].code, 'E_SCHEMA');
  }
  const newer = with_ws((w) => { w.format = 'runway-journal/9'; });
  assert.equal(quarantine_invalid(newer).ok, false);
  assert.equal(analyze_checked(newer, { as_of: newer.as_of }, { quarantine: true }).code, 'E_SCHEMA');
  const bad_asof = with_ws((w) => { w.as_of = '2026-02-30'; });
  assert.equal(quarantine_invalid(bad_asof).ok, false);
  assert.equal(analyze_checked(G, { as_of: '2026-13-40' }).code === undefined ? 'ok' : analyze_checked(G, { as_of: '2026-13-40' }).code, 'E_BAD_DATE');
});

test('Q-22 карантин: перевод с несбалансированными ногами — исключаются обе ноги; список вместо словаря и словарь вместо списка принимаются', () => {
  const leg = (id, amt) => ({ plan_id: id, account_id: 'acc_main', currency: 'EUR', date: '2026-10-20', amount_minor: amt, kind: 'transfer', transfer_id: 'TT' });
  const ws = with_ws((w) => { w.plans.push(leg('o', -50000), leg('i', 49999)); });
  const q = quarantine_invalid(ws);
  assert.equal(q.ok, true);
  assert.deepEqual(q.ws_clean.plans.map((p) => p.plan_id), ['P-TAX1']);
  const dict = with_ws((w) => { w.accounts = Object.fromEntries(w.accounts.map((a) => [a.account_id, a])); });
  assert.equal(validate_ws(dict).ok, true);
  assert.equal(analyze_checked(dict, { as_of: dict.as_of }).ok, true);
  const weird = with_ws((w) => { w.reserves = 'не список'; });
  const qw = quarantine_invalid(weird);
  assert.equal(qw.ok, true);
  assert.ok(qw.rejected.some((r) => r.kind === 'reserves' && r.index === null));
});

function code_of_analyze(ws) { try { analyze(ws, { as_of: ws.as_of }); return null; } catch (e) { return e?.code ?? e?.name; } }

// ═══ журнал ═════════════════════════════════════════════════════════════════════════════════════════════════════════════

test('REQ-016 validate_journal: фикстура журнала v1 проходит; дубль event_id, неизвестный тип, запись из будущей версии, float в payload, битый момент и актор — ошибки с кодами', () => {
  const fixture = read_journal_json(fs.readFileSync(new URL('./fixtures/journal-v1.json', import.meta.url), 'utf8'));
  const ok = validate_journal(fixture.events);
  assert.deepEqual(ok.errors, [], JSON.stringify(ok.errors));
  assert.equal(ok.ok, true);
  assert.equal(validate_journal({ format: 'runway-journal/1', events: fixture.events }).ok, true);
  const ev = (patch, i = 0) => fixture.events.map((e, k) => (k === i ? { ...e, ...patch } : e));
  assert.ok(reasons(validate_journal(ev({ event_id: fixture.events[1].event_id }))).includes('duplicate_id'));
  assert.ok(reasons(validate_journal(ev({ type: 'tx.voided' }))).includes('unknown_type'));
  const newer = validate_journal(ev({ v: 2 }));
  assert.deepEqual([newer.ok, newer.read_only], [false, true]);
  assert.ok(reasons(newer).includes('newer_version'));
  assert.ok(reasons(validate_journal(ev({ v: 0 }))).includes('v_required'));
  assert.ok(validate_journal(ev({ payload: { ...fixture.events[0].payload, balance_minor: 1.5 } })).errors.some((e) => e.code === 'E_NOT_INTEGER'));
  assert.ok(validate_journal(ev({ recorded_at: '2026-13-01T00:00:00Z' })).errors.some((e) => e.code === 'E_BAD_DATE'));
  assert.ok(reasons(validate_journal(ev({ actor: 'root' }))).includes('bad_actor'));
  assert.ok(reasons(validate_journal(ev({ seq: 'один' }))).includes('seq_required'));
  assert.ok(reasons(validate_journal(ev({ payload: [] }))).includes('payload_not_object'));
  assert.deepEqual(validate_journal({ format: 'runway-journal/3', events: [] }).read_only, true);
  assert.ok(reasons(validate_journal({ events: 'нет' })).includes('events_required'));
  assert.ok(reasons(validate_journal(fixture.events, { limits: { max_events: 3 } })).includes('too_many_events'));
});

test('REQ-017 validate_journal: ошибка свёртки (ссылка на запись из будущего, откат неизвестного) — код из набора, не исключение; состояние проходит проверки рабочей области', () => {
  const fixture = read_journal_json(fs.readFileSync(new URL('./fixtures/journal-v1.json', import.meta.url), 'utf8'));
  const bad_account = fixture.events.map((e) => (e.type === 'tx.posted' && e.entity_id === 'tx-001' ? { ...e, payload: { ...e.payload, account_id: 'нет-счёта' } } : e));
  const r = validate_journal(bad_account);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.kind === 'state.facts' && e.reason === 'unknown_account'), JSON.stringify(r.errors));
  const future_ref = fixture.events.map((e) => (e.type === 'revert' ? { ...e, payload: { target: 'ev-099' } } : e));
  assert.doesNotThrow(() => validate_journal(future_ref));
  const types = new Set(EVENT_TYPES);
  assert.ok(types.has('tx.posted'));
  const one = make_event('tx.posted', { account_id: 'a', date: '2026-10-02', amount_minor: -1, currency: 'EUR' }, { event_id: 'x', seq: 1, recorded_at: '2026-10-01T10:00:00Z', entity_id: 'x' });
  assert.equal(validate_journal([one]).ok, false, 'факт на неизвестный счёт');
});

// ═══ фаззинг повреждённых журналов (REQ-158) ══════════════════════════════════════════════════════════════════════════

const POOL = [0, -1, 1, 2, 2 ** 53, -(2 ** 53), 1.5, NaN, Infinity, -Infinity, 1e21, '', 'x', '2026-02-30', '2026-13-01', '2026-10-05', '0000-00-00', [], {}, true, false, '__proto__', 'constructor',
  'toString', 'a'.repeat(300), [1, 2], { a: 1 }, '1e3', '12,50', null, 10 ** 9, -(10 ** 9), 3661, 99999, 'USD', 'ZZZ', 'EUR', 'half_up', 'weird'];

function collect_paths(node, path, out, depth) {
  if (depth > 4 || node === null || typeof node !== 'object') return;
  const keys = Array.isArray(node) ? node.map((_, i) => i) : Object.keys(node);
  for (const k of keys) {
    out.push([...path, k]);
    collect_paths(node[k], [...path, k], out, depth + 1);
  }
}

function mutate(ws, rng, pool = POOL) { // pool — необязательный пул значений (FP-24: пул с ±(2^53−1)); по умолчанию прежний POOL, поведение прежних тестов не меняется
  const paths = [];
  collect_paths(ws, [], paths, 0);
  const n_mut = rng.int(1, 3);
  for (let m = 0; m < n_mut; m++) {
    const path = rng.pick(paths);
    let parent = ws;
    for (let i = 0; i < path.length - 1; i++) { parent = parent?.[path[i]]; if (parent === null || typeof parent !== 'object') break; }
    if (parent === null || typeof parent !== 'object') continue;
    const key = path[path.length - 1];
    switch (rng.int(0, 8)) {
      case 0: if (Array.isArray(parent)) parent.splice(key, 1); else delete parent[key]; break;
      case 1: parent[key] = null; break;
      case 2: case 3: case 4: parent[key] = clone_val(rng.pick(pool)); break;
      case 5: if (Array.isArray(parent)) parent.push(clone_val(parent[key])); else parent[rng.pick(['extra', 'tag', 'note', 'id'])] = clone_val(rng.pick(pool)); break;
      case 6: if (!Array.isArray(parent)) Object.defineProperty(parent, '__proto__', { value: { polluted: true }, enumerable: true, writable: true, configurable: true }); break;
      case 7: { // список → словарь по индексу или строка
        if (Array.isArray(parent[key])) parent[key] = rng.bool() ? Object.fromEntries(parent[key].map((x, i) => [String(i), x])) : 'не список';
        break;
      }
      case 8: { let d = 'x'; for (let i = 0; i < rng.int(2, 60); i++) d = [d]; parent[key] = d; break; }
      default: break;
    }
  }
  return ws;
}
const clone_val = (v) => (typeof v === 'object' && v !== null ? JSON.parse(JSON.stringify(v)) : v);

test(`REQ-158 TST-51 фаззинг: ${FUZZ_N} повреждённых рабочих областей — validate_ws и analyze_checked ВСЕГДА дают результат или код REQ-017; 0 необработанных исключений; карантин тоже`, (t) => {
  const rng = make_rng(1582026);
  const base = clone(G);
  base.params.horizon_days = 14;
  const counts = { valid: 0, rejected: 0, analyzed: 0, coded: 0, quarantine_ok: 0, quarantine_fatal: 0 };
  const proto_before = Object.getOwnPropertyNames(Object.prototype).sort().join();
  for (let i = 0; i < FUZZ_N; i++) {
    fuzz_progress('validate_ws:workspaces', i + 1, FUZZ_N);
    const ws = mutate(clone(base), rng);
    const query = { as_of: rng.int(0, 9) === 0 ? rng.pick(POOL) : base.as_of };
    if (rng.int(0, 9) === 0) query.horizon_days = rng.pick(POOL);
    const label = `#${i}`;
    let v;
    try { v = validate_ws(ws, { as_of: query.as_of }); } catch (e) { assert.fail(`${label}: validate_ws бросил ${e?.name}: ${e?.message}`); }
    assert.equal(typeof v.ok, 'boolean', label);
    assert.ok(v.ok === (v.errors.length === 0), label);
    for (const e of v.errors) assert.ok(REQ017.includes(e.code), `${label}: код ${e.code}`);
    assert.ok(!v.errors.some((e) => String(e.reason).startsWith('validator_internal')), `${label}: внутренняя ошибка проверяющего: ${JSON.stringify(v.errors.find((e) => String(e.reason).startsWith('validator_internal')))}`);
    let out;
    try { out = analyze_checked(ws, query); } catch (e) { assert.fail(`${label}: analyze_checked бросил ${e?.name}: ${e?.message}`); }
    assert.ok(out.internal !== true, `${label}: внутренняя ошибка движка: ${JSON.stringify(out.errors)}`);
    if (out.ok) counts.analyzed += 1;
    else { assert.ok(REQ017.includes(out.code), `${label}: код ${out.code}`); counts.coded += 1; }
    if (v.ok) counts.valid += 1; else { counts.rejected += 1; assert.equal(out.ok, false, `${label}: отвергнутое не считается в строгом режиме`); }
    let qo;
    try { qo = analyze_checked(ws, query, { quarantine: true }); } catch (e) { assert.fail(`${label}: карантин бросил ${e?.name}: ${e?.message}`); }
    assert.ok(qo.internal !== true, `${label}: внутренняя ошибка в карантине: ${JSON.stringify(qo.errors)}`);
    if (qo.ok) { counts.quarantine_ok += 1; assert.match(qo.analysis.inputs_hash, /^[0-9a-f]{64}$/, label); } else { assert.ok(REQ017.includes(qo.code), `${label}: код карантина ${qo.code}`); counts.quarantine_fatal += 1; }
  }
  assert.equal(Object.getOwnPropertyNames(Object.prototype).sort().join(), proto_before, 'Object.prototype не изменён');
  assert.equal(({}).polluted, undefined);
  assert.ok(counts.valid > 50 && counts.rejected > 200, JSON.stringify(counts));
  assert.ok(counts.quarantine_ok > counts.analyzed, 'карантин спасает часть областей, которые строгий режим отвергает: ' + JSON.stringify(counts));
  t.diagnostic(`REQ-158: прогнано ${FUZZ_N} повреждённых рабочих областей; ${JSON.stringify(counts)}`);
});

test('REQ-158 фаззинг журналов: 1000+ случайно повреждённых файлов-копий — validate_journal всегда {ok, errors} с кодами из набора, без исключений', (t) => {
  const text = fs.readFileSync(new URL('./fixtures/journal-v1.json', import.meta.url), 'utf8');
  const base = JSON.parse(text);
  const rng = make_rng(77158);
  let rejected = 0;
  let accepted = 0;
  const n = Math.max(1000, FUZZ_N);
  for (let i = 0; i < n; i++) {
    fuzz_progress('validate_ws:journals', i + 1, n);
    const j = mutate(clone(base), rng);
    let r;
    try { r = validate_journal(j); } catch (e) { assert.fail(`#${i}: validate_journal бросил ${e?.name}: ${e?.message}`); }
    assert.ok(r.ok === (r.errors.length === 0), `#${i}`);
    for (const e of r.errors) assert.ok(REQ017.includes(e.code), `#${i}: ${e.code}`);
    assert.ok(!r.errors.some((e) => String(e.reason).startsWith('validator_internal')), `#${i}: ${JSON.stringify(r.errors.find((e) => String(e.reason).startsWith('validator_internal')))}`);
    if (r.ok) accepted += 1; else rejected += 1;
  }
  assert.ok(rejected > 100, 'повреждения отвергаются: ' + rejected);
  t.diagnostic(`REQ-158 журналы: ${n} файлов; принято ${accepted}, отвергнуто ${rejected}`);
});

// ═══ FP-24: фаззинг с крайними значениями ±(2^53−1) в пуле (REQ-158, REQ-174) ════════════════════════════════════════════════════════
// Пул POOL выше содержит ±2^53 (за границей безопасных целых), но не саму границу ±(2^53−1): значение, которое ещё допустимо как деньги и ломает расчёт арифметикой, а не формой.
// Здесь пул расширен границей и соседними значениями; прежние фаззинг-тесты выше не менялись (их поток случайных чисел прежний).

const POOL_EDGE = [...POOL, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1, -(Number.MAX_SAFE_INTEGER - 1), Number.MAX_SAFE_INTEGER - 2, 2 ** 52, -(2 ** 52)];
const FUZZ_EDGE_N = Math.max(1200, Math.min(Number(process.env.FUZZ_N ?? process.env.HARDEN_FUZZ_N ?? 0) || 0, 20000));

test(`REQ-158 REQ-174 TST-51 фаззинг с пулом ±(2^53−1): ${FUZZ_EDGE_N} повреждённых рабочих областей — validate_ws и analyze_checked ВСЕГДА дают результат или код REQ-017; 0 необработанных исключений; Object.prototype цел`, (t) => {
  assert.ok(POOL_EDGE.includes(Number.MAX_SAFE_INTEGER) && POOL_EDGE.includes(-Number.MAX_SAFE_INTEGER), 'в пуле есть ±(2^53−1)');
  const rng = make_rng(1582027);
  const base = clone(G);
  base.params.horizon_days = 14;
  const counts = { valid: 0, rejected: 0, analyzed: 0, coded: 0, overflow: 0, quarantine_ok: 0 };
  const proto_before = Object.getOwnPropertyNames(Object.prototype).sort().join();
  for (let i = 0; i < FUZZ_EDGE_N; i++) {
    fuzz_progress('validate_ws:edge_pool', i + 1, FUZZ_EDGE_N);
    const ws = mutate(clone(base), rng, POOL_EDGE);
    const query = { as_of: rng.int(0, 9) === 0 ? rng.pick(POOL_EDGE) : base.as_of };
    if (rng.int(0, 9) === 0) query.horizon_days = rng.pick(POOL_EDGE);
    const label = `#${i}`;
    let v;
    try { v = validate_ws(ws, { as_of: query.as_of }); } catch (e) { assert.fail(`${label}: validate_ws бросил ${e?.name}: ${e?.message}`); }
    assert.ok(v.ok === (v.errors.length === 0), label);
    for (const e of v.errors) assert.ok(REQ017.includes(e.code), `${label}: код ${e.code}`);
    assert.ok(!v.errors.some((e) => String(e.reason).startsWith('validator_internal')), `${label}: внутренняя ошибка проверяющего: ${JSON.stringify(v.errors.find((e) => String(e.reason).startsWith('validator_internal')))}`);
    let out;
    try { out = analyze_checked(ws, query); } catch (e) { assert.fail(`${label}: analyze_checked бросил ${e?.name}: ${e?.message}`); }
    assert.ok(out.internal !== true, `${label}: внутренняя ошибка движка: ${JSON.stringify(out.errors)}`);
    if (out.ok) counts.analyzed += 1; else { assert.ok(REQ017.includes(out.code), `${label}: код ${out.code}`); counts.coded += 1; if (out.code === 'E_OVERFLOW') counts.overflow += 1; }
    if (v.ok) counts.valid += 1; else { counts.rejected += 1; assert.equal(out.ok, false, `${label}: отвергнутое не считается в строгом режиме`); }
    let qo;
    try { qo = analyze_checked(ws, query, { quarantine: true }); } catch (e) { assert.fail(`${label}: карантин бросил ${e?.name}: ${e?.message}`); }
    assert.ok(qo.internal !== true, `${label}: внутренняя ошибка в карантине: ${JSON.stringify(qo.errors)}`);
    if (qo.ok) { counts.quarantine_ok += 1; assert.match(qo.analysis.inputs_hash, /^[0-9a-f]{64}$/, label); } else assert.ok(REQ017.includes(qo.code), `${label}: код карантина ${qo.code}`);
  }
  assert.equal(Object.getOwnPropertyNames(Object.prototype).sort().join(), proto_before, 'Object.prototype не изменён');
  assert.equal(({}).polluted, undefined);
  assert.ok(counts.valid > 50 && counts.rejected > 200, JSON.stringify(counts));
  t.diagnostic(`REQ-158: пул с ±(2^53−1), прогнано ${FUZZ_EDGE_N} повреждённых рабочих областей; ${JSON.stringify(counts)}`);
});

test('REQ-174 REQ-158 суммы ровно ±(2^53−1) в рабочей области G-001: проверка принимает как допустимое целое, расчёт — результат либо E_OVERFLOW; ни одного необработанного исключения', () => {
  const MAXI = Number.MAX_SAFE_INTEGER;
  const spots = [['facts', 0, 'amount_minor'], ['anchors', 1, 'amount_minor'], ['plans', 0, 'amount_minor'], ['rules', 0, 'amount'], ['reserves', 0, 'funded_start_minor'], ['params', null, 'buffer_minor']];
  const seen = { ok: 0, coded: 0 };
  for (const [list, idx, field] of spots) {
    for (const v of [MAXI, -MAXI, MAXI - 1, 1, -1, 0]) {
      const ws = clone(G);
      if (list === 'params') ws.params[field] = v;
      else if (field === 'amount') ws[list][idx].amount = { exp_minor: v === 0 ? -1 : -Math.abs(v) };
      else ws[list][idx][field] = v;
      let r;
      assert.doesNotThrow(() => { r = validate_ws(ws); }, `${list}.${field}=${v}: validate_ws бросил`);
      for (const e of r.errors) assert.ok(REQ017.includes(e.code), `${list}.${field}=${v}: код ${e.code}`);
      let out;
      assert.doesNotThrow(() => { out = analyze_checked(ws, { as_of: ws.as_of }); }, `${list}.${field}=${v}: analyze_checked бросил`);
      assert.ok(out.internal !== true, `${list}.${field}=${v}: ${JSON.stringify(out.errors)}`);
      if (out.ok) seen.ok += 1; else { assert.ok(REQ017.includes(out.code)); seen.coded += 1; }
    }
  }
  assert.ok(seen.ok > 0 && seen.coded > 0, JSON.stringify(seen));
});
