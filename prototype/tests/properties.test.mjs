// properties.test.mjs — FP-24, REQ-171: девять именованных property-тестов TST-31…TST-39 (wiki/product/11-testing-strategy.md, «Property-инварианты»).
// Каждый инвариант — отдельный тест на N = 1000 журналах (PROP_N, по умолчанию 1000) с seed из общего генератора tests/journal_gen.mjs (`gen_case(case_seed(3139, i))`,
// mulberry32, без Math.random). Журналы валидны (validate_journal), содержат замены (`supersedes_id`), откаты и откаты откатов; рабочая область — свёртка журнала.
// Инварианты живут в tests/properties_lib.mjs как функции `(api, case) → нарушения`; красными на мутациях они показаны в tests/properties_mutation.test.mjs.
// Файл целиком укладывается в бюджет 120 с на этой машине (замер ≈ 50 с на 1000 журналах); при нехватке — PROP_N меньше, но по умолчанию N = 1000.
// Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';

import { validate_journal } from '../engine/validate_ws.mjs';
import { canon } from '../engine/index.mjs';
import { INVARIANTS, make_api, run_invariant, PROP_N, PROP_SEED, COVERAGE, case_at, reset_coverage } from './properties_lib.mjs';
import { gen_case, case_seed, with_mirror_facts } from './journal_gen.mjs';

const API = make_api();
const BUDGET_MS = Number(process.env.PROP_BUDGET_MS ?? 120000);
const STAT_MIN_N = 200; // с этого числа журналов доли охвата и состава серии проверяются по допускам
let spent_ms = 0;
let ran = 0;
reset_coverage();

const show = (r) => r.violations.map((v) => `  журнал №${v.i} (seed ${v.seed}): ${v.messages.join(' | ')}`).join('\n');

test('REQ-171 общий генератор: все журналы серии валидны (validate_journal), считаются analyze, дают «готовые» и «неготовые» данные; шум журнала (замены, откаты) присутствует', (t) => {
  const t0 = Date.now();
  const stat = { bad: 0, ready: 0, supersede: 0, revert: 0, usd: 0, stream: 0, tax: 0, sinking: 0, buffer_unset: 0, mirror: 0, planted: 0 };
  const seen = new Set();
  for (let i = 0; i < PROP_N; i++) {
    const c = case_at(i);
    seen.add(c.seed);
    const v = validate_journal(c.events);
    if (!v.ok) { stat.bad += 1; if (stat.bad <= 3) assert.fail(`журнал №${i} (seed ${c.seed}) невалиден: ${JSON.stringify(v.errors.slice(0, 2))}`); }
    const ctx = API.analyze(c.ws, c.query);
    if (c.mirrored > 0) stat.mirror += 1; // зеркальные факты и разовые планы к ним (journal_gen.mjs · with_mirror_facts, FP-24 · D2)
    if (c.planted > 0) stat.planted += 1;
    if (ctx.readiness.score === 4) stat.ready += 1;
    if (c.events.some((e) => e.supersedes_id !== undefined)) stat.supersede += 1;
    if (c.events.some((e) => e.type === 'revert')) stat.revert += 1;
    if (c.flags.usd) stat.usd += 1;
    if (c.flags.stream) stat.stream += 1;
    if (c.flags.tax) stat.tax += 1;
    if (c.flags.sinking) stat.sinking += 1;
    if (!c.flags.buffer) stat.buffer_unset += 1;
  }
  spent_ms += Date.now() - t0;
  assert.equal(seen.size, PROP_N, 'seed всех журналов серии различны');
  assert.equal(stat.bad, 0);
  const share = (k) => stat[k] / PROP_N;
  if (PROP_N >= STAT_MIN_N) { // доли — статистика: на малом PROP_N (проверка мутаций) шум больше допусков, там остаются только структурные проверки выше
    assert.ok(share('ready') > 0.7 && share('ready') < 0.98, 'готовых и неготовых данных достаточно: ' + share('ready'));
    assert.ok(share('supersede') > 0.3 && share('revert') > 0.3, 'замены и откаты в журналах встречаются часто');
    assert.ok(share('usd') > 0.05 && share('stream') > 0.15 && share('tax') > 0.4 && share('sinking') > 0.3 && share('buffer_unset') > 0.01, JSON.stringify(stat));
    assert.ok(share('mirror') > 0.4 && share('mirror') < 0.8 && share('planted') > 0.1, 'зеркальные факты есть примерно в половине журналов, часть журналов без них: ' + JSON.stringify(stat));
  }
  t.diagnostic(`REQ-171: журналов ${PROP_N}, seed серии ${PROP_SEED}; ${JSON.stringify(stat)}`);
});

for (const inv of INVARIANTS) {
  test(`${inv.id} Свойство (${PROP_N} журналов, seed ${PROP_SEED}): ${inv.name}`, (t) => {
    const t0 = Date.now();
    const r = run_invariant(inv.check, API);
    const dt = Date.now() - t0;
    spent_ms += dt;
    ran += 1;
    t.diagnostic(`${inv.id}: журналов ${r.checked}, нарушений ${r.failed}, ${dt} мс`);
    assert.equal(r.checked, PROP_N);
    assert.equal(r.failed, 0, `${inv.id}: инвариант нарушен на ${r.failed} из ${r.checked} журналов (первые):\n${show(r)}`);
  });
}

test('REQ-171 with_mirror_facts (FP-24 · D2): детерминирован и не меняет исходный случай; журнал gen_case остаётся префиксом дополненного (поток gen_case и замок вывода прежние); новые записи — только факты mir* и план P-MIRR с новыми идентификаторами; без зеркал случай возвращается как есть', () => {
  const n = Math.min(PROP_N, 150);
  let enriched = 0;
  let planted = 0;
  for (let i = 0; i < n; i++) {
    const seed = case_seed(PROP_SEED, i);
    const base = gen_case(seed);
    const before = canon(base.events);
    const a = with_mirror_facts(base);
    assert.equal(canon(base.events), before, `журнал №${i}: исходный случай изменён`);
    assert.equal(canon(with_mirror_facts(gen_case(seed)).events), canon(a.events), `журнал №${i}: повторное построение даёт другой журнал`);
    assert.equal(canon(a.events.slice(0, base.events.length)), before, `журнал №${i}: исходный журнал — не префикс дополненного`);
    const added = a.events.slice(base.events.length);
    assert.equal(added.length > 0, a.mirrored + a.planted > 0, `журнал №${i}: счётчики не согласованы с записями`);
    assert.equal(added.filter((e) => e.type === 'plan.set').length, a.planted, `журнал №${i}: число добавленных планов`);
    assert.equal(added.filter((e) => e.type === 'tx.posted').length, a.mirrored, `журнал №${i}: число добавленных фактов`);
    const used = new Set(base.events.map((e) => e.event_id));
    let last_seq = Math.max(...base.events.map((e) => e.seq));
    for (const e of added) {
      assert.ok(e.type === 'tx.posted' || e.type === 'plan.set', `журнал №${i}: неожиданный вид записи ${e.type}`);
      assert.ok(!used.has(e.event_id), `журнал №${i}: идентификатор ${e.event_id} уже занят`);
      assert.ok(e.seq > last_seq, `журнал №${i}: seq не возрастает`);
      used.add(e.event_id);
      last_seq = e.seq;
      if (e.type === 'tx.posted') assert.match(String(e.entity_id), /^mir\d+$/, `журнал №${i}: факт-зеркало`);
      else assert.equal(e.payload.plan_id, 'P-MIRR');
    }
    if (added.length === 0) assert.equal(a.events, base.events, `журнал №${i}: без зеркал журнал возвращается как есть`);
    else enriched += 1;
    planted += a.planted > 0 ? 1 : 0;
  }
  if (n >= 100) { // доли — статистика: на малом PROP_N (проверка мутаций, быстрый прогон) остаются только структурные проверки выше
    assert.ok(enriched >= 0.4 * n && enriched <= 0.8 * n, `дополнено ${enriched} из ${n}`);
    assert.ok(planted >= 0.1 * n, `с разовым планом ${planted} из ${n}`);
  } else assert.ok(enriched > 0 || n < 5, `дополнено ${enriched} из ${n}`);
});

test('REQ-171 охват: инварианты реально дошли до своих проверок (доля журналов, а не только «не упало»)', (t) => {
  assert.equal(ran, INVARIANTS.length, 'охват считается после всех девяти тестов');
  const need = {
    // t32_rematch считается ТОЛЬКО на журналах, где сопоставление «план ↔ факт» нашло хотя бы одну пару (FP-24 · D2: раньше счёт шёл по всем 1000, а пара находилась в 6 из них);
    // норма 0,4 — при измеренных ≈ 0,53: «зеркальные» факты (journal_gen.mjs · with_mirror_facts) дают пары в каждом втором журнале
    t31_days: 1.9, t32_revert: 1, t32_supersede: 1, t32_match_set: 0.8, t32_import: 1, t32_rematch: 0.4, t33: 1, t34_edit: 1.6, t35_expense: 0.85, t35_verdict: 0.8,
    t36_additive: 1, t36_delay: 0.75, t37_plan: 0.8, t37_worse: 0.8, t38: 1, t39_sts_plan: 0.8, t39_sts_worse: 0.8, t39_ok_iff: 0.8, t39_no_reserves: 1,
  };
  for (const [key, share] of Object.entries(need)) {
    if (PROP_N >= STAT_MIN_N) assert.ok((COVERAGE[key] ?? 0) >= share * PROP_N - 1e-9, `${key}: ${COVERAGE[key] ?? 0} из ${PROP_N} (нужно ≥ ${share})`);
    else assert.ok((COVERAGE[key] ?? 0) > 0, `${key}: проверка не выполнялась ни разу из ${PROP_N}`);
  }
  t.diagnostic('охват: ' + JSON.stringify(COVERAGE));
});

test('REQ-171 N по умолчанию — 1000 журналов на инвариант; весь файл укладывается в бюджет времени (120 с на этой машине)', (t) => {
  if (process.env.PROP_N === undefined || process.env.PROP_N === '') assert.equal(PROP_N, 1000);
  t.diagnostic(`REQ-171: сумма замеров ${spent_ms} мс при бюджете ${BUDGET_MS} мс; N = ${PROP_N}`);
  assert.ok(spent_ms <= BUDGET_MS, `тесты свойств заняли ${spent_ms} мс при бюджете ${BUDGET_MS} мс: уменьшите PROP_N или освободите машину`);
});
