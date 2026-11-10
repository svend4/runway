// properties_mutation.test.mjs — FP-24, REQ-171 + REQ-175: каждый из девяти инвариантов TST-31…TST-39 краснеет хотя бы на одной мутации.
// Мутация — подмена функции движка заведомо ошибочной обёрткой через объект `api` (внедрение зависимостей, tests/properties_lib.mjs): сам движок не правится и не копируется.
// Для каждого инварианта: (1) настоящий движок на первых журналах серии — зелёный (иначе «красный на мутации» ничего не доказывает); (2) каждая из подмен даёт хотя бы одно
// нарушение (проверка останавливается на первом красном журнале). Исходные мутации самого кода движка (замена «<» на «≤» и т. п.) — tools/mutate.mjs, каталог для timeline,
// afford, sinking, tax, fx и verifier. Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parse_date } from '../engine/dates.mjs';
import { INVARIANTS, REAL_FUNCTIONS as R, make_api, run_invariant } from './properties_lib.mjs';

const BASE_CASES = 40; // настоящий движок: первые журналы серии без нарушений
const MAX_CASES = 300; // мутация должна покраснеть не позже этого журнала

/** Подмены по инвариантам: `over` — какие функции движка заменяются. Каждая имитирует правдоподобную ошибку. */
const MUTATIONS = {
  'TST-31': [
    { name: 'analyze: остаток на конец последнего дня plan завышен на 1 minor', over: { analyze: (ws, q) => { const r = R.analyze(ws, q); const c = r.series.plan.close; c[c.length - 1] += 1; return r; } } },
    { name: 'analyze: trough первого дня worse завышен на 1 minor', over: { analyze: (ws, q) => { const r = R.analyze(ws, q); r.series.worse.trough[0] += 1; return r; } } },
    { name: 'analyze: из списка событий plan пропало последнее событие', over: { analyze: (ws, q) => { const r = R.analyze(ws, q); if (r.events.plan.length > 0) r.events.plan.pop(); return r; } } },
  ],
  'TST-32': [
    { name: 'effective_events: откат отката не возвращает запись', over: { effective_events: (events) => { const rev = new Set(events.filter((e) => e.type === 'revert').map((e) => e.event_id)); return R.effective_events(events.filter((e) => !(e.type === 'revert' && rev.has(e.payload.target)))); } } },
    { name: 'dry_run: ключи дедупликации не учитываются (повторный импорт создаёт дубли)', over: { dry_run: (cands, keys, rejects, existing, params) => R.dry_run(cands, new Set(), rejects, [], params) } },
    { name: 'match_plan_to_fact: при повторном проходе находится лишняя пара', over: { match_plan_to_fact: (plans, facts, params) => { const r = R.match_plan_to_fact(plans, facts, params); if (plans.length > 0 && facts.length > 0) r.matches.push({ plan: plans[0], facts: [facts[0]], by: 'auto' }); return r; } } },
    { name: 'reduce: каждая запись match.set учитывается отдельно (не идемпотентна)', over: { reduce: (events, base, opts) => { const s = R.reduce(events, base, opts); s.match_count = events.filter((e) => e.type === 'match.set').length; return s; } } },
    // FP-24 · D2: две подмены сопоставителя, которые проявляются, ТОЛЬКО когда в журнале есть пары «план ↔ факт» (раньше пары были в 6 журналах из 1000 и инвариант их не видел)
    { name: 'match_plan_to_fact: пара попадает в результат дважды', over: { match_plan_to_fact: (plans, facts, params) => { const r = R.match_plan_to_fact(plans, facts, params); if (r.matches.length > 0) r.matches.push(r.matches[0]); return r; } } },
    { name: 'assign_statuses: сопоставленный план теряет статус matched при повторном проходе', over: { assign_statuses: (planned, facts, as_of, params) => R.assign_statuses(planned, facts, as_of, params).map((e, i) => (e.status === 'matched' && planned[i].status === 'matched' ? { ...e, status: 'expected' } : e)) } },
  ],
  'TST-33': [
    { name: 'analyze: скрытое состояние между вызовами (счётчик меняет результат)', over: (() => { let n = 0; return { analyze: (ws, q) => { const r = R.analyze(ws, q); n += 1; r.series.plan.close[0] += n % 2; return r; } }; })() },
    { name: 'analyze: вывод зависит от порядка ключей рабочей области', over: { analyze: (ws, q) => { const r = R.analyze(ws, q); const first = Object.keys(ws.plans ?? {})[0]; if (first !== undefined && first.charCodeAt(first.length - 1) % 2 === 0) r.inputs_hash = '0'.repeat(64); return r; } } },
    { name: 'effective_events: порядок записей берётся из порядка входа, а не из seq', over: { effective_events: (events) => { const pos = new Map(events.map((e, i) => [e.event_id, i])); return R.effective_events(events).sort((a, b) => pos.get(a.event_id) - pos.get(b.event_id)); } } },
  ],
  'TST-34': [
    { name: 'analyze: правка на день d портит остаток предыдущего дня', over: { analyze: (ws, q) => { const r = R.analyze(ws, q); const e = ws.plans?.['P-EDIT']; if (e !== undefined) { const i = parse_date(e.date) - r.as_of; if (i >= 1 && i < r.series.plan.close.length) r.series.plan.close[i - 1] -= 1; } return r; } } },
    { name: 'analyze: правка сдвигает остаток первого дня', over: { analyze: (ws, q) => { const r = R.analyze(ws, q); if (ws.plans?.['P-EDIT'] !== undefined) r.series.plan.close[0] += 1; return r; } } },
  ],
  'TST-35': [
    { name: 'analyze: остаток worse выше plan', over: { analyze: (ws, q) => { const r = R.analyze(ws, q); r.series.worse.close[0] = r.series.plan.close[0] + 1; return r; } } },
    { name: 'check_purchase: большие суммы получают вердикт OK', over: { check_purchase: (ctx, purchase, B) => { const r = R.check_purchase(ctx, purchase, B); if (r.kind === 'ok' && purchase.parts[0].amount_minor > 200000) r.verdict = 'OK'; return r; } } },
    { name: 'max_amount: S_max(worse) на единицу выше', over: { max_amount: (ctx, D, B, mode) => R.max_amount(ctx, D, B, mode) + (mode === 'worse' ? 1 : 0) } },
    { name: 'analyze: новый расход P-EDIT повышает остатки', over: { analyze: (ws, q) => { const r = R.analyze(ws, q); const e = ws.plans?.['P-EDIT']; if (e !== undefined && e.amount_minor < 0) { const i = Math.max(0, parse_date(e.date) - r.as_of); for (let k = i; k < r.series.plan.close.length; k++) r.series.plan.close[k] += 2 * -e.amount_minor; } return r; } } },
  ],
  'TST-36': [
    // FP-24 · D3: обходим режимы, которые есть в ответе (у запроса со сценарием `modes: ['plan']` режима worse нет): иначе подмена краснела бы собственным TypeError, а не нарушением инварианта
    { name: 'analyze: остаток обрезан сверху (ряды не складываются)', over: { analyze: (ws, q) => { const r = R.analyze(ws, q); for (const m of Object.keys(r.series)) { r.series[m].close = r.series[m].close.map((x) => Math.min(x, 100000)); r.series[m].trough = r.series[m].trough.map((x) => Math.min(x, 100000)); } return r; } } },
    { name: 'analyze: операции сценария игнорируются', over: { analyze: (ws, q) => R.analyze(ws, { ...q, scenario: undefined }) } },
  ],
  'TST-37': [
    { name: 'list_waves: последняя волна потеряна', over: { list_waves: (ctx, mode) => R.list_waves(ctx, mode).slice(0, -1) } },
    { name: 'list_waves: обязательство попадает в две волны', over: { list_waves: (ctx, mode) => { const items = R.list_waves(ctx, mode); if (items.length > 1) items[1] = { ...items[1], wave: { ...items[1].wave, event_ids: [...items[1].wave.event_ids, items[0].wave.event_ids[0]] } }; return items; } } },
    { name: 'list_waves_ex: предупреждение W_OVERRIDE_STALE потеряно', over: { list_waves_ex: (ctx, mode) => { const r = R.list_waves_ex(ctx, mode); return { ...r, warnings: r.warnings.filter((w) => w.code !== 'W_OVERRIDE_STALE') }; } } },
  ],
  'TST-38': [
    { name: 'import_json: последняя запись журнала теряется', over: { import_json: (text) => { const j = JSON.parse(text); j.events.pop(); return R.reduce(R.effective_events(j.events)); } } },
    { name: 'export_json: записи не сортируются по seq (файл зависит от порядка входа)', over: { export_json: (journal) => JSON.stringify({ format: 'runway-journal/1', engine_version: 'unversioned', events: Array.isArray(journal) ? journal : journal.events }) } },
  ],
  'TST-39': [
    { name: 'max_amount: S_max на единицу выше', over: { max_amount: (ctx, D, B, mode) => R.max_amount(ctx, D, B, mode) + 1 } },
    { name: 'safe_to_spend: «можно потратить» на единицу выше', over: { safe_to_spend: (ctx, T, B, mode) => { const r = R.safe_to_spend(ctx, T, B, mode); return r.kind === 'insufficient_data' ? r : { ...r, sts: r.sts + 1 }; } } },
    { name: 'analyze: без резервов free ниже trough на единицу', over: { analyze: (ws, q) => { const r = R.analyze(ws, q); if (Object.keys(ws.reserves ?? {}).length === 0) for (const m of ['plan', 'worse']) r.series[m].free = r.series[m].trough.map((x) => x - 1); return r; } } },
  ],
};

for (const inv of INVARIANTS) {
  test(`${inv.id} красный на мутации (REQ-171, REQ-175): настоящий движок зелёный, каждая из ${MUTATIONS[inv.id].length} подмен краснеет`, () => {
    const base = run_invariant(inv.check, make_api(), { n: BASE_CASES });
    assert.equal(base.failed, 0, `${inv.id}: на настоящем движке нарушения:\n` + JSON.stringify(base.violations));
    const survived = [];
    const crashed = [];
    for (const m of MUTATIONS[inv.id]) {
      const r = run_invariant(inv.check, make_api(m.over), { n: MAX_CASES, stop_on_first: true });
      if (r.failed === 0) survived.push(m.name);
      // FP-24 · D3: красный должен быть по существу (нарушение инварианта), а не из-за того, что упала сама подмена (run_invariant записывает исключение как «исключение: …»)
      else if (r.violations[0].messages[0].startsWith('исключение:')) crashed.push(`${m.name} — ${r.violations[0].messages[0]}`);
    }
    assert.deepEqual(survived, [], `${inv.id}: подмены, которые инвариант не заметил (за ${MAX_CASES} журналов)`);
    assert.deepEqual(crashed, [], `${inv.id}: подмены краснеют собственным исключением, а не нарушением инварианта (исправьте подмену)`);
  });
}

test('REQ-171 у каждого из девяти инвариантов есть хотя бы одна мутация, подмены подменяют только известные функции движка', () => {
  assert.equal(INVARIANTS.length, 9);
  assert.deepEqual(INVARIANTS.map((i) => i.id), ['TST-31', 'TST-32', 'TST-33', 'TST-34', 'TST-35', 'TST-36', 'TST-37', 'TST-38', 'TST-39']);
  for (const inv of INVARIANTS) {
    assert.ok((MUTATIONS[inv.id] ?? []).length >= 1, inv.id);
    for (const m of MUTATIONS[inv.id]) {
      assert.ok(m.name.length > 15, m.name);
      for (const k of Object.keys(m.over)) assert.ok(k in R, `${inv.id}: подмена неизвестной функции ${k}`);
    }
  }
});
