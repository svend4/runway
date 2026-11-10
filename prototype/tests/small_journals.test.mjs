// small_journals.test.mjs — FP-24, REQ-158 (отказоустойчивость), REQ-174 (крайние значения), TST-51: малые и вырожденные журналы общего генератора tests/journal_gen.mjs.
// Классы: «пустой журнал», «одно событие», «дубли дат» (много записей на один день, одинаковые суммы под разными id, перезапись сущности, дубль записи целиком),
// «крайние значения» 0, ±1, ±(2^53−1). Для каждого класса: проверка журнала, свёртка, `analyze` и `analyze_checked` отвечают результатом или кодом из набора REQ-017 —
// ни TypeError, ни RangeError, ни «внутренней ошибки»; где расчёт возможен, выполняются инварианты сохранения (TST-31) и детерминизма (TST-33).
// Число журналов на класс — SMALL_N (по умолчанию 300). Ожидания в точечных проверках выведены вручную. Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { analyze, canon, effective_events, reduce, state_hash, make_event } from '../engine/index.mjs';
import { ERROR_CODES } from '../engine/money.mjs';
import { export_json, import_json } from '../engine/io.mjs';
import { validate_journal, validate_ws, analyze_checked } from '../engine/validate_ws.mjs';
import { parse_date, format_date } from '../engine/dates.mjs';
import { gen_small, gen_case, case_seed, shuffled, SMALL_KINDS, EDGE_VALUES, GEN_SEED, ws_of } from './journal_gen.mjs';
import { make_api, tst31, tst33 } from './properties_lib.mjs';
import { make_rng } from './helpers.mjs';

const N = Math.max(50, Number(process.env.SMALL_N ?? 300) || 300);
const MAX = Number.MAX_SAFE_INTEGER;
const REQ017 = ['E_NOT_INTEGER', 'E_OVERFLOW', 'E_BAD_DATE', 'E_FUTURE_POSTED', 'E_RULE_INVALID', 'E_CURRENCY_MISMATCH', 'E_NO_RATE', 'E_SCHEMA'];
const API = make_api();

/** Результат analyze: `{ok: true, ctx}` или `{ok: false, code}`; всё, кроме RunwayError с кодом реестра, — провал теста. */
function try_analyze(ws, query) {
  try { return { ok: true, ctx: analyze(ws, query) }; } catch (e) {
    assert.equal(e?.name, 'RunwayError', `необработанное исключение ${e?.name}: ${e?.message}`);
    assert.ok(ERROR_CODES.includes(e.code), 'код вне реестра: ' + e.code);
    return { ok: false, code: e.code, reason: e.ctx?.reason };
  }
}

// ── генератор ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-171 генератор journal_gen: детерминирован (тот же seed — тот же журнал), без Math.random и часов; seed серии различны; классы малых журналов и крайние значения объявлены', () => {
  for (const seed of [1, 2026, 4294967295]) {
    assert.equal(canon(gen_case(seed).events), canon(gen_case(seed).events), 'gen_case детерминирован');
    for (const kind of SMALL_KINDS) assert.equal(canon(gen_small(seed, kind).events), canon(gen_small(seed, kind).events), kind);
  }
  assert.notEqual(canon(gen_case(1).events), canon(gen_case(2).events));
  assert.equal(new Set(Array.from({ length: 5000 }, (_, i) => case_seed(GEN_SEED, i))).size, 5000);
  assert.notEqual(case_seed(2026, 0), case_seed(2027, 0));
  const src = fs.readFileSync(new URL('./journal_gen.mjs', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); // без комментариев: в них эти имена упоминаются
  assert.ok(!/Math\.random|new Date|Date\.now|performance\.now/.test(code), 'генератор не читает часы и не использует Math.random');
  assert.deepEqual([...SMALL_KINDS], ['empty', 'one_event', 'same_date', 'duplicates', 'extreme']);
  for (const v of [0, 1, -1, MAX, -MAX]) assert.ok(EDGE_VALUES.includes(v), 'крайнее значение ' + v);
  assert.throws(() => gen_small(1, 'нет-такого'), /неизвестный класс/);
  const sh = shuffled([1, 2, 3, 4, 5, 6, 7, 8], make_rng(5));
  assert.deepEqual([...sh].sort(), [1, 2, 3, 4, 5, 6, 7, 8]);
});

// ── общий проход по классам ────────────────────────────────────────────────────────────────────────────────────────────────

for (const kind of SMALL_KINDS) {
  test(`REQ-158 TST-51 малые журналы, класс «${kind}»: ${N} журналов — проверка, свёртка и расчёт дают результат или код REQ-017, исключений нет; сохранение и детерминизм там, где расчёт возможен`, () => {
    const stat = { reduce_error: 0, analyzed: 0, coded: 0, valid_journal: 0, invalid_journal: 0 };
    const codes = {};
    for (let i = 0; i < N; i++) {
      const s = gen_small(case_seed(GEN_SEED + 7, i), kind);
      const label = `${kind} #${i} (seed ${s.seed})`;
      let vj;
      assert.doesNotThrow(() => { vj = validate_journal(s.events, { as_of: s.as_of }); }, label + ': validate_journal бросил исключение');
      assert.ok(vj.ok === (vj.errors.length === 0), label);
      for (const e of vj.errors) assert.ok(REQ017.includes(e.code), `${label}: код проверки ${e.code}`);
      assert.ok(!vj.errors.some((e) => String(e.reason).startsWith('validator_internal')), `${label}: внутренняя ошибка проверки журнала ${JSON.stringify(vj.errors[0])}`);
      if (vj.ok) stat.valid_journal += 1; else stat.invalid_journal += 1;
      if (s.ws === null) {
        stat.reduce_error += 1;
        assert.ok(REQ017.includes(s.reduce_error), `${label}: свёртка дала ${s.reduce_error}`);
        assert.equal(vj.ok, false, `${label}: журнал, который не сворачивается, прошёл проверку`);
        continue;
      }
      let vw;
      assert.doesNotThrow(() => { vw = validate_ws(s.ws, { as_of: s.as_of }); }, label + ': validate_ws бросил исключение');
      for (const mode of [{}, { quarantine: true }]) {
        let out;
        assert.doesNotThrow(() => { out = analyze_checked(s.ws, s.query, mode); }, label + ': analyze_checked бросил исключение');
        assert.ok(out.internal !== true, `${label}: внутренняя ошибка движка ${JSON.stringify(out.errors)}`);
        if (!out.ok) assert.ok(REQ017.includes(out.code), `${label}: код ${out.code}`);
        if (mode.quarantine !== true && vw.ok === false) assert.equal(out.ok, false, `${label}: невалидная область не считается в строгом режиме`);
      }
      const r = try_analyze(s.ws, s.query);
      if (!r.ok) { stat.coded += 1; codes[r.code] = (codes[r.code] ?? 0) + 1; continue; }
      stat.analyzed += 1;
      const c = { seed: s.seed, events: s.events, ws: s.ws, query: s.query, as_of_day: parse_date(s.as_of), horizon_days: r.ctx.horizon_end - r.ctx.as_of };
      assert.deepEqual(tst31(API, c), [], label + ': сохранение (TST-31)');
      assert.deepEqual(tst33(API, c), [], label + ': детерминизм (TST-33)');
    }
    // класс действительно породил то, ради чего существует
    if (kind === 'empty') assert.deepEqual([stat.analyzed, stat.coded, stat.reduce_error], [0, N, 0], 'пустой журнал считать нечего: всегда код, свёртка пустая');
    if (kind === 'one_event') assert.ok(stat.analyzed > 0 && stat.coded > 0, JSON.stringify(stat));
    if (kind === 'same_date') assert.equal(stat.analyzed, N, JSON.stringify(stat));
    if (kind === 'duplicates') assert.ok(stat.analyzed > 0 && stat.reduce_error > 0, 'дубль записи целиком делает журнал невалидным: ' + JSON.stringify(stat));
    if (kind === 'extreme') assert.ok(stat.analyzed > 0 && (codes.E_OVERFLOW ?? 0) > 0, 'крайние значения доходят до расчёта и до E_OVERFLOW: ' + JSON.stringify([stat, codes]));
  });
}

// ── точечные проверки (ожидания выведены вручную) ────────────────────────────────────────────────────────────────────────

const AS_OF = '2026-10-04';
const j = () => {
  let seq = 0;
  const events = [];
  const add = (type, payload, extra = {}) => { seq += 1; events.push(make_event(type, payload, { event_id: 'e' + seq, seq, recorded_at: '2026-10-04T08:00:00Z', ...extra })); };
  add('account.opened', { account_id: 'acc_main', name: 'A', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 });
  return { events, add };
};
const plan = (id, date, amt) => ({ plan_id: id, account_id: 'acc_main', name: id, date, amount_minor: amt, currency: 'EUR', kind: amt >= 0 ? 'income' : 'expense', tag: 'x' });
const run = (events, params = { horizon_days: 3, buffer_minor: 0 }) => {
  const b = [...events];
  b.push(make_event('params.set', params, { event_id: 'pp', seq: events.length + 1, recorded_at: '2026-10-04T08:00:00Z', entity_id: 'ws1' }));
  return try_analyze(ws_of(b), { as_of: AS_OF });
};

test('REQ-158 «пустой журнал»: свёртка пуста, проверка не бросает, расчёт — код E_SCHEMA (валюта решения неизвестна), круг экспорта сохраняет state_hash пустого состояния', () => {
  const ws = ws_of([]);
  assert.deepEqual(Object.keys(ws.accounts), []);
  assert.deepEqual(try_analyze(ws, { as_of: AS_OF }), { ok: false, code: 'E_SCHEMA', reason: 'decision_currency_unknown' });
  const v = validate_journal([]);
  assert.ok(typeof v.ok === 'boolean' && v.errors.every((e) => REQ017.includes(e.code)));
  const out = analyze_checked(ws, { as_of: AS_OF });
  assert.equal(out.ok, false);
  assert.ok(REQ017.includes(out.code) && out.internal !== true);
  const text = export_json([]);
  assert.equal(state_hash(import_json(text)), state_hash(reduce(effective_events([]))), 'TST-38 на пустом журнале');
  assert.equal(export_json(shuffled([], make_rng(1))), text);
});

test('REQ-158 «одно событие»: один счёт без якоря и планов считается (остаток 0, ряд из нулей); одна запись плана без счёта — код, а не исключение', () => {
  const only_account = j();
  const r = run(only_account.events);
  assert.equal(r.ok, true);
  assert.equal(r.ctx.series.plan.opening_minor, 0);
  assert.deepEqual(r.ctx.series.plan.close, [0, 0, 0, 0]);
  assert.deepEqual(r.ctx.series.worse.trough, [0, 0, 0, 0]);
  const only_plan = [make_event('plan.set', plan('P1', '2026-10-05', -5000), { event_id: 'e1', seq: 1, recorded_at: '2026-10-04T08:00:00Z' })];
  const bad = try_analyze(ws_of(only_plan), { as_of: AS_OF });
  assert.equal(bad.ok, false);
  assert.ok(REQ017.includes(bad.code), bad.code);
  const only_anchor = [make_event('anchor.set', { anchor_id: 'a1', account_id: 'acc_main', date: AS_OF, amount_minor: 100 }, { event_id: 'e1', seq: 1, recorded_at: '2026-10-04T08:00:00Z' })];
  assert.equal(try_analyze(ws_of(only_anchor), { as_of: AS_OF }).ok, false);
});

test('REQ-158 «дубли дат»: две траты по 25,00 € и доход 40,00 € в один день — trough берёт расходы раньше дохода (1000,00 − 50,00), close = 990,00; дубль записи целиком — E_SCHEMA', () => {
  const b = j();
  b.add('anchor.set', { anchor_id: 'a1', account_id: 'acc_main', date: AS_OF, amount_minor: 100000 });
  b.add('plan.set', plan('P0', '2026-10-05', -2500));
  b.add('plan.set', plan('P1', '2026-10-05', -2500)); // та же дата и сумма, другой id
  b.add('plan.set', plan('P2', '2026-10-05', 4000));
  const r = run(b.events);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ctx.series.plan.trough, [100000, 95000, 99000, 99000]);
  assert.deepEqual(r.ctx.series.plan.close, [100000, 99000, 99000, 99000]);
  // доход попадает в worse на 14 дней позже (за горизонт 3 дня): остаётся только расход
  assert.deepEqual(r.ctx.series.worse.close, [100000, 95000, 95000, 95000]);
  assert.equal(r.ctx.series.worse.trough[1], 95000);
  // та же запись дважды (одинаковые event_id и seq): свёртка отказывает кодом, проверка журнала называет duplicate_id
  const dup = [...b.events, { ...b.events[b.events.length - 1] }];
  assert.throws(() => ws_of(dup), (e) => e.name === 'RunwayError' && e.code === 'E_SCHEMA');
  const v = validate_journal(dup);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.reason === 'duplicate_id'), JSON.stringify(v.errors.slice(0, 2)));
  // перезапись сущности: последняя по seq побеждает
  const over = j();
  over.add('anchor.set', { anchor_id: 'a1', account_id: 'acc_main', date: AS_OF, amount_minor: 1000 });
  over.add('anchor.set', { anchor_id: 'a1', account_id: 'acc_main', date: AS_OF, amount_minor: 2000 });
  assert.equal(run(over.events).ctx.series.plan.opening_minor, 2000);
});

test('REQ-174 REQ-158 значения 0, ±1 и ±(2^53−1): граница безопасных целых проходит расчёт, выход за неё — E_OVERFLOW; ни одного необработанного исключения', () => {
  const case_of = (anchor, amt) => {
    const b = j();
    b.add('anchor.set', { anchor_id: 'a1', account_id: 'acc_main', date: AS_OF, amount_minor: anchor });
    if (amt !== null) b.add('plan.set', plan('P1', '2026-10-05', amt));
    return run(b.events, { horizon_days: 2, buffer_minor: 0 });
  };
  for (const v of [0, 1, -1]) assert.equal(case_of(v, null).ok, true, 'остаток ' + v);
  const top = case_of(MAX, null);
  assert.equal(top.ok, true);
  assert.equal(top.ctx.series.plan.opening_minor, MAX);
  assert.equal(canon(top.ctx).length > 0, true, 'вывод с 2^53−1 канонизируется');
  const bottom = case_of(-MAX, null);
  assert.equal(bottom.ok, true);
  assert.equal(bottom.ctx.series.plan.opening_minor, -MAX);
  const income = case_of(0, MAX);
  assert.equal(income.ok, true);
  assert.equal(income.ctx.series.plan.close.at(-1), MAX, '0 + (2^53−1) = 2^53−1');
  const spend = case_of(0, -MAX);
  assert.equal(spend.ok, true);
  assert.equal(spend.ctx.series.plan.trough[1], -MAX);
  assert.equal(case_of(MAX, -MAX).ctx.series.plan.close.at(-1), 0, '(2^53−1) − (2^53−1) = 0');
  assert.deepEqual([case_of(MAX, 1).ok, case_of(MAX, 1).code], [false, 'E_OVERFLOW']);
  assert.deepEqual([case_of(-MAX, -1).ok, case_of(-MAX, -1).code], [false, 'E_OVERFLOW']);
  // за границей безопасных целых деньги не принимаются совсем: журнал не создаётся
  assert.throws(() => make_event('plan.set', plan('P1', '2026-10-05', 2 ** 53), { event_id: 'x', seq: 1, recorded_at: '2026-10-04T08:00:00Z' }), (e) => e.name === 'RunwayError' && REQ017.includes(e.code));
  assert.throws(() => make_event('plan.set', plan('P1', '2026-10-05', 1.5), { event_id: 'x', seq: 1, recorded_at: '2026-10-04T08:00:00Z' }), (e) => e.name === 'RunwayError' && e.code === 'E_NOT_INTEGER');
});

test('REQ-158 даты на границах: as_of в високосный день 2028-02-29 и 31 декабря 2099 — расчёт даёт ряд нужной длины; журнал с датой плана до якоря и в день якоря не ломает свёртку', () => {
  for (const day of ['2028-02-29', '2099-12-31', '2026-01-01']) {
    const b = j();
    b.add('anchor.set', { anchor_id: 'a1', account_id: 'acc_main', date: day, amount_minor: 5000 });
    b.add('plan.set', plan('P0', day, -100));
    b.add('plan.set', plan('P1', format_date(parse_date(day) - 1), -100)); // до якоря: уже учтён в остатке
    const b2 = [...b.events, make_event('params.set', { horizon_days: 5, buffer_minor: 0 }, { event_id: 'pp', seq: 99, recorded_at: '2026-10-04T08:00:00Z', entity_id: 'w' })];
    const r = try_analyze(ws_of(b2), { as_of: day });
    assert.equal(r.ok, true, day);
    assert.equal(r.ctx.series.plan.close.length, 6, day);
    assert.equal(r.ctx.series.plan.close[0], 4900, `${day}: расход дня якоря учтён, расход до якоря — нет`);
  }
});
