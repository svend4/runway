// properties_lib.mjs — FP-24, REQ-171: девять property-инвариантов TST-31…TST-39 (wiki/product/11-testing-strategy.md, «Property-инварианты») как ЧИСТЫЕ функции
// `(api, case) → string[]` (пустой список — инвариант выполнен). Функции движка приходят через объект `api` (внедрение зависимостей): property-тест
// (properties.test.mjs) даёт настоящий движок, проверка на мутациях (properties_mutation.test.mjs) — обёртку с заведомо ошибочной функцией, без правки движка.
// Журналы — общий генератор journal_gen.mjs (`gen_case`, `case_seed`, mulberry32), N по умолчанию 1000 (переменная PROP_N).
// Только для тестов: допустимы node:fs, canon, структурное клонирование. Расчёт по введённым данным и правилам, не консультация.

import fs from 'node:fs';
import {
  analyze, check_purchase, max_amount, earliest_date, safe_to_spend, list_waves, list_waves_ex, effective_events, reduce, state_hash, make_event, canon,
  normalize_ws, match_plan_to_fact, assign_statuses,
} from '../engine/index.mjs';
import { export_json, import_json, read_journal_json, parse_with_profile, dry_run, import_commit, existing_keys_of } from '../engine/io.mjs';
import { plan_window_start, plan_occurrences } from '../engine/mc_inputs.mjs';
import { format_date } from '../engine/dates.mjs';
import { make_rng } from './helpers.mjs';
import { gen_case, case_seed, shuffled, with_mirror_facts } from './journal_gen.mjs';

/** Число журналов на инвариант (спецификация REQ-171: ≥ 10^3). Меньшее значение допустимо только явным PROP_N (медленная машина). */
export const PROP_N = (() => {
  const v = process.env.PROP_N;
  if (v === undefined || v === '') return 1000;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('PROP_N — положительное целое, получено: ' + v);
  return n;
})();

/** Базовый seed серии property-тестов (замок движка берёт GEN_SEED = 2026, серии не пересекаются). */
export const PROP_SEED = 3139;
export const MODES = Object.freeze(['plan', 'worse']);
const VERDICT_RANK = Object.freeze({ OK: 0, FRAGILE: 1, TIGHT: 2, NO: 3 });
const CSV_PROFILE = JSON.parse(fs.readFileSync(new URL('../data/profiles/csv-generic.json', import.meta.url), 'utf8'));

// ── API: настоящий движок или подмена ────────────────────────────────────────────────────────────────────────────────────

/** Функции движка, которые читают инварианты. */
export const REAL_FUNCTIONS = Object.freeze({
  analyze, check_purchase, max_amount, earliest_date, safe_to_spend, list_waves, list_waves_ex, effective_events, reduce, state_hash, export_json, import_json,
  read_journal_json, match_plan_to_fact, assign_statuses, parse_with_profile, dry_run, import_commit, existing_keys_of, normalize_ws,
  plan_window_start, plan_occurrences, // FP-24 · D2: плановые вхождения окна для проверки сопоставления «план ↔ факт» (TST-32)
});

/**
 * Объект `api` для инвариантов: настоящие функции движка, поверх — подмены `over`. `analyze` запоминает результат по (объект рабочей области, запрос), чтобы девять
 * инвариантов не пересчитывали один и тот же журнал; `analyze_fresh` — без запоминания (для проверки детерминизма, TST-33).
 * @param {Partial<typeof REAL_FUNCTIONS>} [over]
 */
export function make_api(over = {}) {
  const api = { ...REAL_FUNCTIONS, ...over };
  const fresh = api.analyze;
  const memo = new WeakMap();
  api.analyze_fresh = fresh;
  api.analyze = (ws, query) => {
    let m = memo.get(ws);
    if (m === undefined) { m = new Map(); memo.set(ws, m); }
    const k = JSON.stringify(query);
    if (!m.has(k)) m.set(k, fresh(ws, query));
    return m.get(k);
  };
  return api;
}

// ── случаи ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const CASES = [];
/**
 * `i`-й случай серии (создаётся при первом обращении и запоминается: девять тестов делят одни и те же журналы). Журнал `gen_case` дополнен «зеркальными» фактами
 * (`with_mirror_facts`, FP-24 · D2): без них сопоставление «план ↔ факт» находило пару лишь в 6 журналах из 1000 и TST-32 проходил вхолостую.
 */
export function case_at(i) {
  if (CASES[i] === undefined) CASES[i] = { i, ...with_mirror_facts(gen_case(case_seed(PROP_SEED, i))) };
  return CASES[i];
}

/** Счётчики охвата: сколько случаев реально дошли до каждой проверки (тест требует доли, чтобы инварианты не проходили «вхолостую»). */
export const COVERAGE = {};
const hit = (key) => { COVERAGE[key] = (COVERAGE[key] ?? 0) + 1; };
export function reset_coverage() { for (const k of Object.keys(COVERAGE)) delete COVERAGE[k]; }

// ── общие помощники ───────────────────────────────────────────────────────────────────────────────────────────────────────

const rng_of = (c, salt) => make_rng((c.seed ^ salt) >>> 0);
const state_of = (api, events) => api.reduce(api.effective_events(events));
const fp_of = (api, events) => canon(state_of(api, events)); // отпечаток состояния: тот же признак равенства, что у state_hash, без sha256
const min_of = (xs) => xs.reduce((m, x) => (x < m ? x : m), xs[0]);

/** Добавить запись в конец журнала (идентификатор и `seq` — следующие). */
function append(events, type, payload, extra = {}) {
  const seq = events.reduce((m, e) => Math.max(m, e.seq), 0) + 1;
  return [...events, make_event(type, payload, { event_id: 'z' + String(seq).padStart(6, '0'), seq, recorded_at: '2030-01-01T00:00:00Z', ...extra })];
}

/** Рабочая область с ещё одной разовой записью плана. */
export function with_plan(ws, plan) {
  return { ...ws, plans: { ...ws.plans, [plan.plan_id]: plan } };
}

/** Копия, в которой у каждого объекта ключи перечислены в обратном порядке (порядок вставки словарей не должен менять вывод). */
function rekey(x) {
  if (Array.isArray(x)) return x.map(rekey);
  if (x !== null && typeof x === 'object') {
    const o = {};
    for (const k of Object.keys(x).reverse()) o[k] = rekey(x[k]);
    return o;
  }
  return x;
}

/**
 * Разовая правка плана для TST-34/35: дата `as_of + k`, где k ≥ 4 (раньше факты могли бы сопоставиться с планом и скрыть его). Запоминается в случае:
 * объект рабочей области один и тот же, поэтому `api.analyze` считает правку один раз для всех инвариантов.
 */
export function edit_plan(c, salt, sign) {
  const N = c.horizon_days + 1;
  if (N <= 4) return null;
  c.memo ??= {};
  const key = 'edit' + sign;
  if (c.memo[key] !== undefined) return c.memo[key];
  const rng = rng_of(c, salt);
  const k = rng.int(4, N - 1);
  const income = sign > 0;
  const amount = income ? rng.int(1, 90000) : -rng.int(1, 90000);
  const plan = {
    plan_id: 'P-EDIT', account_id: 'acc_main', name: 'P-EDIT', date: format_date(c.as_of_day + k), amount_minor: amount,
    currency: 'EUR', kind: income ? 'income' : 'expense', tag: income ? 'gift' : 'прочее', is_obligation: false, is_estimate: false,
  };
  c.memo[key] = { plan, k, amount, ws: with_plan(c.ws, plan) };
  return c.memo[key];
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// TST-31 · сохранение: close[i] − close[i−1] = out_i + in_i, close[−1] = opening
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export function tst31(api, c) {
  const v = [];
  const ctx = api.analyze(c.ws, c.query);
  for (const mode of MODES) {
    const s = ctx.series[mode];
    const N = s.close.length;
    if (N !== ctx.horizon_end - ctx.as_of + 1 || s.trough.length !== N) v.push(`${mode}: длина ряда ${N} не равна горизонту`);
    const out = new Array(N).fill(0);
    const inn = new Array(N).fill(0);
    for (const e of ctx.events[mode]) {
      const i = e.date - ctx.as_of;
      if (i < 0 || i >= N) { v.push(`${mode}: событие ${e.cash_event_id} вне ряда (день ${i})`); continue; }
      if (e.amount_minor < 0) out[i] += e.amount_minor; else inn[i] += e.amount_minor;
    }
    let prev = s.opening_minor;
    for (let i = 0; i < N; i++) {
      if (s.trough[i] !== prev + out[i]) v.push(`${mode}: trough[${i}] = ${s.trough[i]}, ожидалось close[${i - 1}] + расходы дня = ${prev + out[i]}`);
      if (s.close[i] - prev !== out[i] + inn[i]) v.push(`${mode}: close[${i}] − close[${i - 1}] = ${s.close[i] - prev}, ожидалось ${out[i] + inn[i]}`);
      if (s.trough[i] > s.close[i]) v.push(`${mode}: trough[${i}] выше close[${i}]`);
      prev = s.close[i];
    }
    hit('t31_days');
  }
  return v;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// TST-32 · идемпотентность: откат отката, замена и её откат, match.set, повторный импорт, повторное сопоставление
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** Небольшой CSV для профиля csv-generic: даты не позже as_of, суммы со знаком, часть строк повторяется (счётчик k дедупликации). */
function csv_of(c, rng) {
  const rows = ['Date,Amount,Currency,Description'];
  const n = rng.int(2, 6);
  const pool = ['Cafe Central', 'Mercadona', 'Zalando', 'Метро'];
  for (let i = 0; i < n; i++) {
    const d = format_date(c.as_of_day - rng.int(0, 15));
    const cents = rng.int(1, 99999);
    const sign = rng.bool() ? '-' : '';
    rows.push(`${d},${sign}${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')},EUR,${rng.pick(pool)}`);
    if (rng.next() < 0.3) rows.push(rows[rows.length - 1]); // та же строка дважды: ключи k = 0 и k = 1
  }
  return rows.join('\n') + '\n';
}

export function tst32(api, c) {
  const v = [];
  const rng = rng_of(c, 0x32);
  const live = api.effective_events(c.events);
  const base = canon(api.reduce(live));

  // 1. откат отката возвращает запись; ещё один откат снова отменяет её
  const target = rng.pick(live);
  const j1 = append(c.events, 'revert', { target: target.event_id });
  const r1 = j1[j1.length - 1];
  const j2 = append(j1, 'revert', { target: r1.event_id });
  if (fp_of(api, j2) !== base) v.push(`откат отката записи ${target.event_id} (${target.type}) не вернул прежнее состояние`);
  const j3 = append(j2, 'revert', { target: j2[j2.length - 1].event_id });
  if (fp_of(api, j3) !== fp_of(api, j1)) v.push(`третий откат (откат отката отката) записи ${target.event_id} не отменил её снова`);
  hit('t32_revert');

  // 2. откат записи-замены возвращает исходную (supersedes_id)
  const orig = rng.pick(live);
  const repl = make_event(orig.type, { ...orig.payload, замена: 1 }, { event_id: 'zrepl', seq: Math.max(...c.events.map((e) => e.seq)) + 1, recorded_at: '2030-01-01T00:00:00Z', entity_id: orig.entity_id, supersedes_id: orig.event_id });
  const j4 = [...c.events, repl];
  const j5 = append(j4, 'revert', { target: 'zrepl' });
  if (fp_of(api, j5) !== base) v.push(`откат записи-замены не вернул исходную запись ${orig.event_id} (${orig.type})`);
  if (fp_of(api, j4) === base) v.push(`запись-замена ${orig.event_id} не изменила состояние (замена не применилась)`);
  hit('t32_supersede');

  // 3. ручное сопоставление match.set идемпотентно
  const facts = live.filter((e) => e.type === 'tx.posted');
  if (facts.length > 0) {
    const f = rng.pick(facts);
    const payload = rng.bool() ? { fact_event_id: f.event_id, no_plan: true } : { fact_event_id: f.event_id, plan_ref: 'P0@2026-01-01' };
    const m1 = append(c.events, 'match.set', payload);
    const m2 = append(m1, 'match.set', payload);
    if (fp_of(api, m2) !== fp_of(api, m1)) v.push(`повторное match.set для ${f.event_id} изменило состояние`);
    hit('t32_match_set');
  }

  // 4. повторный импорт файла — 0 новых записей
  const csv = csv_of(c, rng);
  const st0 = api.reduce(live);
  const p = api.parse_with_profile(CSV_PROFILE, csv, { account_id: 'acc_main', account_currency: 'EUR', as_of: c.as_of });
  const d1 = api.dry_run(p.candidates, api.existing_keys_of(st0), p.rejects, Object.values(st0.facts), {});
  const accept = Object.fromEntries(d1.recognized_items.map((it) => [it.row, 'accept']));
  let n = Math.max(...c.events.map((e) => e.seq));
  const ports = { next_id: () => 'imp' + (n + 1000), next_seq: () => ++n, recorded_at: '2030-01-02T00:00:00Z' };
  const evs = api.import_commit(d1, accept, csv, { ...ports, batch_id: 'b1' });
  const st1 = api.reduce(api.effective_events([...c.events, ...evs]));
  const d2 = api.dry_run(p.candidates, api.existing_keys_of(st1), p.rejects, Object.values(st1.facts), {});
  if (d2.recognized !== 0) v.push(`повторный импорт того же файла дал ${d2.recognized} новых записей (ожидалось 0)`);
  if (d2.duplicates !== p.candidates.length) v.push(`повторный импорт: дубликатов ${d2.duplicates}, ожидалось ${p.candidates.length}`);
  const again = api.import_commit(d2, {}, csv, { ...ports, batch_id: 'b2' });
  if (again.length !== 1) v.push(`повторная партия содержит ${again.length} записей, ожидалась одна (import.started)`);
  hit('t32_import');

  // 5. повторное сопоставление: после первого прохода новых пар нет
  const ctx = api.analyze(c.ws, c.query);
  const left = ctx.events.plan.filter((e) => e.layer === 'planned').map((e) => ({ ...e, date: e.plan_date }));
  const nf = api.normalize_ws(c.ws).facts;
  const r2 = api.match_plan_to_fact(left, nf, ctx.params);
  if (r2.matches.length !== 0) v.push(`повторное сопоставление нашло ${r2.matches.length} новых пар`);
  const a1 = api.assign_statuses(left, nf, ctx.as_of, ctx.params);
  const a2 = api.assign_statuses(a1, nf, ctx.as_of, ctx.params);
  if (canon(a2) !== canon(a1)) v.push('assign_statuses не идемпотентна');

  // 6. сопоставление на ВСЕХ плановых вхождениях окна (до сопоставления): как их видит расчёт. Предыдущий шаг получает уже сопоставленный остаток, где пар по построению нет,
  //    поэтому без этого шага ошибки «пара дважды» и «сопоставленный план теряет статус» остались бы незамеченными (FP-24 · D2). Счёт охвата — только журналы, где пара найдена.
  const win = ctx.params['match.window_days'];
  const f0 = api.plan_window_start(c.ws, c.as_of);
  const planned = api.plan_occurrences(c.ws, f0, ctx.horizon_end, { as_of: ctx.as_of, anchor_cut: true });
  const window_facts = nf.filter((f) => f.date >= f0 - win && f.date <= ctx.as_of);
  const m1 = api.match_plan_to_fact(planned, window_facts, ctx.params);
  const plan_key = (p) => p.occ_key ?? p.cash_event_id;
  const fact_key = (f) => f.cash_event_id ?? f.event_id ?? f.entity_id;
  const used_plans = new Set();
  const used_facts = new Set();
  for (const m of m1.matches) {
    if (used_plans.has(plan_key(m.plan))) v.push(`сопоставление: план ${plan_key(m.plan)} стоит в паре дважды`);
    used_plans.add(plan_key(m.plan));
    for (const f of m.facts) {
      if (used_facts.has(fact_key(f))) v.push(`сопоставление: факт ${fact_key(f)} стоит в паре дважды`);
      used_facts.add(fact_key(f));
    }
  }
  const rest = api.match_plan_to_fact(planned.filter((p) => !used_plans.has(plan_key(p))), window_facts.filter((f) => !used_facts.has(fact_key(f))), ctx.params);
  if (rest.matches.length !== 0) v.push(`повторное сопоставление остатка (без уже сопоставленных планов и фактов) нашло ${rest.matches.length} новых пар`);
  const s1 = api.assign_statuses(planned, window_facts, ctx.as_of, ctx.params);
  const matched_ids = s1.filter((e) => e.status === 'matched').map(plan_key).sort();
  if (canon(matched_ids) !== canon([...used_plans].sort())) v.push('assign_statuses: статус matched стоит не у тех планов, что вошли в пары');
  const s2 = api.assign_statuses(s1, window_facts, ctx.as_of, ctx.params);
  if (canon(s2) !== canon(s1)) v.push('assign_statuses по уже сопоставленным планам не идемпотентна (статус matched потерян или сменился)');
  if (m1.matches.length > 0) hit('t32_rematch');
  return v;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// TST-33 · детерминизм: тот же вход — тот же вывод и inputs_hash; порядок ключей и записей не влияет
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export function tst33(api, c) {
  const v = [];
  const rng = rng_of(c, 0x33);
  const a = api.analyze(c.ws, c.query);
  const ca = canon(a);
  const b = api.analyze_fresh(rekey(c.ws), c.query);
  if (canon(b) !== ca) v.push('обратный порядок ключей рабочей области изменил вывод analyze');
  if (b.inputs_hash !== a.inputs_hash) v.push('обратный порядок ключей изменил inputs_hash');
  if (!/^[0-9a-f]{64}$/.test(a.inputs_hash)) v.push('inputs_hash не 64 hex-знака');
  const events2 = shuffled(c.events, rng);
  const st2 = state_of(api, events2);
  if (canon(st2) !== canon(c.ws)) v.push('порядок записей журнала на входе изменил состояние');
  else if (canon(api.analyze_fresh(st2, c.query)) !== ca) v.push('журнал в другом порядке записей дал другой вывод analyze');
  hit('t33');
  return v;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// TST-34 · локальность: правка на дату d не меняет ряды до idx(d); trough[idx(d)] меняется только при расходе
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

const SERIES_KEYS = ['close', 'trough', 'free', 'reserve_trough', 'reserve_close'];

export function tst34(api, c) {
  const v = [];
  const ctx = api.analyze(c.ws, c.query);
  const N = ctx.series.plan.close.length;
  const delay = ctx.params['worse.income_delay_days'];
  for (const sign of [-1, 1]) {
    const ed = edit_plan(c, sign < 0 ? 0x3401 : 0x3402, sign);
    if (ed === null) continue;
    const ctx2 = api.analyze(ed.ws, c.query);
    for (const mode of MODES) {
      const i_eff = ed.k + (sign > 0 && mode === 'worse' ? delay : 0);
      const s = ctx.series[mode];
      const t = ctx2.series[mode];
      for (const key of SERIES_KEYS) {
        for (let i = 0; i < Math.min(i_eff, N); i++) if (s[key][i] !== t[key][i]) { v.push(`${mode} ${key}[${i}] изменился правкой на день ${i_eff}`); break; }
      }
      if (i_eff < N) {
        if (t.trough[i_eff] - s.trough[i_eff] !== (sign < 0 ? ed.amount : 0)) v.push(`${mode}: trough[${i_eff}] изменился на ${t.trough[i_eff] - s.trough[i_eff]}, ожидалось ${sign < 0 ? ed.amount : 0}`);
        for (let i = i_eff; i < N; i++) if (t.close[i] - s.close[i] !== ed.amount) { v.push(`${mode}: close[${i}] изменился на ${t.close[i] - s.close[i]}, ожидалось ${ed.amount}`); break; }
      }
    }
    hit('t34_edit');
  }
  return v;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// TST-35 · монотонность: worse ≤ plan; новый расход не повышает ряды; вердикт не улучшается с ростом S; границы OK/FRAGILE по S_max
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export function tst35(api, c) {
  const v = [];
  const ctx = api.analyze(c.ws, c.query);
  const p = ctx.series.plan;
  const w = ctx.series.worse;
  const N = p.close.length;
  for (let i = 0; i < N; i++) {
    if (w.trough[i] > p.trough[i]) v.push(`trough[${i}]: worse ${w.trough[i]} выше plan ${p.trough[i]}`);
    if (w.close[i] > p.close[i]) v.push(`close[${i}]: worse ${w.close[i]} выше plan ${p.close[i]}`);
    if (w.free[i] > p.free[i]) v.push(`free[${i}]: worse ${w.free[i]} выше plan ${p.free[i]}`);
  }
  const B = ctx.buffer_minor;
  const rng = rng_of(c, 0x35);
  const D = ctx.as_of + rng.int(0, N - 1);
  let smax_w = null;
  let smax_p = null;
  if (B !== null) {
    for (const d of [ctx.as_of, D, ctx.horizon_end]) {
      if (api.max_amount(ctx, d, B, 'worse') > api.max_amount(ctx, d, B, 'plan')) v.push(`S_max(worse) выше S_max(plan) на ${d - ctx.as_of} дн.`);
    }
    smax_w = api.max_amount(ctx, D, B, 'worse');
    smax_p = api.max_amount(ctx, D, B, 'plan');
  }
  // новый расход не повышает ни один ряд
  const ed = edit_plan(c, 0x3401, -1);
  if (ed !== null) {
    const ctx2 = api.analyze(ed.ws, c.query);
    for (const mode of MODES) {
      for (const key of ['close', 'trough', 'free']) {
        for (let i = 0; i < N; i++) if (ctx2.series[mode][key][i] > ctx.series[mode][key][i]) { v.push(`${mode} ${key}[${i}] вырос после добавления расхода`); break; }
      }
    }
    hit('t35_expense');
  }
  // вердикт по сумме S
  if (B !== null && smax_w !== null) {
    const Ss = [...new Set([1, 2, smax_w, smax_w + 1, smax_p, smax_p + 1, smax_p + 1 + rng.int(1, 500000)].filter((s) => s >= 1))].sort((a, b) => a - b);
    let prev_rank = -1;
    let prev_after = Infinity;
    let gated = false;
    for (const S of Ss) {
      const r = api.check_purchase(ctx, { currency: ctx.decision_currency, parts: [{ date: D, amount_minor: S }] });
      if (r.kind === 'insufficient_data') { gated = true; break; }
      if (r.kind !== 'ok') { v.push(`check_purchase(S=${S}) вернул ${r.kind} внутри горизонта`); break; }
      const rank = VERDICT_RANK[r.verdict];
      if (rank < prev_rank) v.push(`вердикт улучшился с ростом суммы: S=${S} → ${r.verdict}`);
      if (r.by_mode.plan.m_after > prev_after) v.push(`m_after(plan) вырос с ростом суммы S=${S}`);
      if ((S <= smax_w) !== (r.verdict === 'OK')) v.push(`OK ⇔ S ≤ S_max(worse) нарушено: S=${S}, S_max=${smax_w}, вердикт ${r.verdict}`);
      if ((smax_w < S && S <= smax_p) !== (r.verdict === 'FRAGILE')) v.push(`FRAGILE ⇔ S_max(worse) < S ≤ S_max(plan) нарушено: S=${S}, [${smax_w}, ${smax_p}], вердикт ${r.verdict}`);
      prev_rank = rank;
      prev_after = r.by_mode.plan.m_after;
    }
    if (!gated) hit('t35_verdict');
  }
  return v;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// TST-36 · аддитивность: ряды base ⊎ Δ = base + Δ при opening = 0; delay_income{delay} в plan = режим worse
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** Рабочая область с нулевым остатком (якоря 0, фактов нет). */
function zero_open(ws) {
  return { ...ws, anchors: Object.fromEntries(Object.entries(ws.anchors).map(([k, a]) => [k, { ...a, amount_minor: 0 }])), facts: {} };
}

export function tst36(api, c) {
  const v = [];
  const base = zero_open(c.ws);
  const keys = Object.keys(c.ws.plans).sort();
  const part = (pred) => Object.fromEntries(keys.filter((k, i) => pred(i)).map((k) => [k, c.ws.plans[k]]));
  const whole = api.analyze(base, c.query);
  const a = api.analyze({ ...base, plans: part((i) => i % 2 === 0) }, c.query);
  const d = api.analyze({ ...base, rules: {}, streams: {}, debts: {}, plans: part((i) => i % 2 === 1) }, c.query);
  for (const mode of MODES) {
    for (const key of ['close', 'trough']) {
      const x = whole.series[mode][key];
      for (let i = 0; i < x.length; i++) {
        if (x[i] !== a.series[mode][key][i] + d.series[mode][key][i]) { v.push(`${mode} ${key}[${i}]: ряд целого ${x[i]} ≠ сумма частей ${a.series[mode][key][i] + d.series[mode][key][i]}`); break; }
      }
    }
  }
  hit('t36_additive');

  // delay_income по каждому поступлению в plan = режим worse (когда все поступления не раньше as_of: иначе зажим max(·, as_of) по канону C-009 различает пути)
  const ctx = api.analyze(c.ws, c.query);
  const delay = ctx.params['worse.income_delay_days'];
  const incomes = ctx.events.plan.filter((e) => e.kind === 'income' && e.amount_minor > 0);
  if (incomes.every((e) => e.plan_date >= ctx.as_of)) {
    const ops = incomes.map((e) => ({ op: 'delay_income', event_ref: e.cash_event_id, days: delay }));
    const sc = api.analyze(c.ws, { ...c.query, modes: ['plan'], scenario: { scenario_id: 'sc-delay', ops } });
    for (const key of ['close', 'trough']) {
      const got = sc.series.plan[key];
      const exp = ctx.series.worse[key];
      for (let i = 0; i < exp.length; i++) if (got[i] !== exp[i]) { v.push(`delay_income{${delay}} в plan ≠ режим worse: ${key}[${i}] ${got[i]} ≠ ${exp[i]}`); break; }
    }
    hit('t36_delay');
  }
  return v;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// TST-37 · волны — разбиение значимых обязательств; split / merge / pin переживают пересчёт и идемпотентны; ссылка на исчезнувшее — W_OVERRIDE_STALE
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

function wave_shape(items) {
  return canon(items.map((it) => [it.wave.wave_id, it.wave.event_ids, it.wave.total_out_minor]));
}

function partition_problems(label, items, sig) {
  const v = [];
  const count = new Map();
  for (const it of items) for (const id of it.wave.event_ids) count.set(id, (count.get(id) ?? 0) + 1);
  for (const e of sig) if (count.get(e.cash_event_id) !== 1) v.push(`${label}: обязательство ${e.cash_event_id} в ${count.get(e.cash_event_id) ?? 0} волнах (нужно ровно в одной)`);
  if (count.size !== sig.length) v.push(`${label}: в волнах ${count.size} событий, значимых обязательств ${sig.length}`);
  const total = items.reduce((s, it) => s + it.wave.total_out_minor, 0);
  const expect = sig.reduce((s, e) => s - e.amount_minor, 0);
  if (total !== expect) v.push(`${label}: Σ total_out ${total} ≠ Σ обязательств ${expect}`);
  for (let k = 1; k < items.length; k++) if (items[k].wave.start < items[k - 1].wave.start) v.push(`${label}: волны не по возрастанию начала`);
  return v;
}

export function tst37(api, c) {
  const v = [];
  const ctx = api.analyze(c.ws, c.query);
  const theta = ctx.params['wave.threshold_minor'];
  const rng = rng_of(c, 0x37);
  for (const mode of MODES) {
    const sig = ctx.events[mode].filter((e) => e.is_obligation === true && e.is_estimate !== true && e.amount_minor < 0 && -e.amount_minor >= theta);
    const items = api.list_waves(ctx, mode);
    v.push(...partition_problems(mode, items, sig));
    if (items.length === 0) continue;
    const ids = items.flatMap((it) => it.wave.event_ids);
    const multi = items.filter((it) => it.wave.event_ids.length > 1);
    const overrides = [{ override_id: 'o-pin', action: 'pin', event_ids: [rng.pick(ids)] }];
    if (multi.length > 0) {
      const w = rng.pick(multi);
      overrides.push({ override_id: 'o-split', action: 'split', event_ids: [w.wave.event_ids[rng.int(1, w.wave.event_ids.length - 1)]] });
    }
    if (items.length > 1) overrides.push({ override_id: 'o-merge', action: 'merge', event_ids: [items[0].wave.event_ids[0], items[items.length - 1].wave.event_ids[0]] });
    for (const o of overrides) {
      const once = api.list_waves({ ...ctx, wave_overrides: [{ ...o, seq: 1 }] }, mode);
      v.push(...partition_problems(`${mode} ${o.action}`, once, sig));
      const twice = api.list_waves({ ...ctx, wave_overrides: [{ ...o, seq: 1 }, { ...o, override_id: o.override_id + '-2', seq: 2 }] }, mode);
      if (wave_shape(twice) !== wave_shape(once)) v.push(`${mode} ${o.action}: повторное применение той же правки изменило волны`);
      if (wave_shape(api.list_waves({ ...ctx, wave_overrides: [{ ...o, seq: 1 }] }, mode)) !== wave_shape(once)) v.push(`${mode} ${o.action}: пересчёт даёт другие волны`);
      if (o.action === 'pin' && !once.some((it) => it.wave.event_ids.length === 1 && it.wave.event_ids[0] === o.event_ids[0])) v.push(`${mode} pin: событие ${o.event_ids[0]} не выделено в отдельную волну`);
      if (o.action === 'split' && !once.some((it) => it.wave.event_ids[0] === o.event_ids[0])) v.push(`${mode} split: волна не начинается с события ${o.event_ids[0]}`);
      if (o.action === 'merge') {
        const together = once.some((it) => o.event_ids.every((id) => it.wave.event_ids.includes(id)));
        if (!together) v.push(`${mode} merge: указанные события не объединены в одну волну`);
      }
    }
    const ghost = api.list_waves_ex({ ...ctx, wave_overrides: [{ override_id: 'o-ghost', action: 'pin', event_ids: ['нет-такого-события'], seq: 1 }] }, mode);
    if (!ghost.warnings.some((w) => w.code === 'W_OVERRIDE_STALE')) v.push(`${mode}: ссылка на исчезнувшее событие не дала W_OVERRIDE_STALE`);
    hit('t37_' + mode);
  }
  return v;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// TST-38 · круг экспорта: state_hash(import_json(export_json(журнал))) = state_hash(свёртка журнала)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export function tst38(api, c) {
  const v = [];
  const rng = rng_of(c, 0x38);
  const text = api.export_json(c.events);
  const h0 = api.state_hash(state_of(api, c.events));
  if (api.state_hash(api.import_json(text)) !== h0) v.push('state_hash после export_json → import_json не равен state_hash свёртки журнала');
  if (api.export_json(shuffled(c.events, rng)) !== text) v.push('порядок записей на входе export_json изменил файл-копию');
  if (api.export_json(api.read_journal_json(text).events) !== text) v.push('файл-копия не канонична: export_json(read_journal_json(текст)) ≠ текст');
  if (api.state_hash(c.ws) !== h0) v.push('свёртка журнала нестабильна: два вычисления дали разные хэши');
  hit('t38');
  return v;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// TST-39 · S_max(as_of) = STS(horizon_end); без резервов free = trough; OK ⇔ S ≤ S_max(worse)(D)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export function tst39(api, c) {
  const v = [];
  const ctx = api.analyze(c.ws, c.query);
  const B = ctx.buffer_minor;
  const N = ctx.series.plan.close.length;
  const rng = rng_of(c, 0x39);
  if (B !== null) {
    for (const mode of MODES) {
      const smax = api.max_amount(ctx, ctx.as_of, B, mode);
      const sts = api.safe_to_spend(ctx, ctx.horizon_end, B, mode);
      if (sts.kind !== 'insufficient_data') {
        if (sts.sts !== smax) v.push(`${mode}: STS(horizon_end) = ${sts.sts} ≠ S_max(as_of) = ${smax}`);
        if (sts.sts_horizon !== smax) v.push(`${mode}: sts_horizon = ${sts.sts_horizon} ≠ S_max(as_of) = ${smax}`);
        hit('t39_sts_' + mode);
      }
      if (min_of(ctx.series[mode].free) < B) {
        if (smax !== 0) v.push(`${mode}: baseline_below_buffer, а S_max = ${smax} (ожидался 0)`);
        if (api.earliest_date(ctx, 1, ctx.as_of, B, mode) !== null) v.push(`${mode}: baseline_below_buffer, а earliest_date не null`);
      }
    }
    const D = ctx.as_of + rng.int(0, N - 1);
    const smax_w = api.max_amount(ctx, D, B, 'worse');
    let gated = false;
    for (const S of [...new Set([1, smax_w, smax_w + 1])].filter((s) => s >= 1)) {
      const r = api.check_purchase(ctx, { currency: ctx.decision_currency, parts: [{ date: D, amount_minor: S }] });
      if (r.kind === 'insufficient_data') { gated = true; break; }
      if ((r.verdict === 'OK') !== (S <= smax_w)) v.push(`OK ⇔ S ≤ S_max(worse)(D) нарушено: S=${S}, S_max=${smax_w}, вердикт ${r.verdict}`);
    }
    if (!gated) hit('t39_ok_iff');
  }
  // без резервов free = trough
  const plans = Object.fromEntries(Object.entries(c.ws.plans).map(([k, pl]) => { const q = { ...pl }; delete q.reserve_id; return [k, q]; }));
  const bare = api.analyze({ ...c.ws, reserves: {}, tax_rules: {}, plans }, c.query);
  for (const mode of MODES) {
    const s = bare.series[mode];
    for (let i = 0; i < s.free.length; i++) if (s.free[i] !== s.trough[i]) { v.push(`${mode}: без резервов free[${i}] = ${s.free[i]} ≠ trough = ${s.trough[i]}`); break; }
  }
  hit('t39_no_reserves');
  return v;
}

// ── реестр и запуск ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Девять именованных инвариантов в порядке TST-31…TST-39. */
export const INVARIANTS = Object.freeze([
  { id: 'TST-31', name: 'сохранение: close[i] − close[i−1] = out_i + in_i, close[−1] = opening', check: tst31 },
  { id: 'TST-32', name: 'идемпотентность: откат отката, замена и её откат, match.set, повторный импорт, повторное сопоставление', check: tst32 },
  { id: 'TST-33', name: 'детерминизм: тот же вход — тот же вывод и inputs_hash; порядок ключей и записей не влияет', check: tst33 },
  { id: 'TST-34', name: 'локальность: правка на дату d не меняет ряды до idx(d); trough[idx(d)] меняется только при расходе', check: tst34 },
  { id: 'TST-35', name: 'монотонность: worse ≤ plan, новый расход не повышает ряды, вердикт не улучшается с ростом S', check: tst35 },
  { id: 'TST-36', name: 'аддитивность: base ⊎ Δ = base + Δ при opening = 0; delay_income в plan = режим worse', check: tst36 },
  { id: 'TST-37', name: 'волны: разбиение обязательств; split / merge / pin идемпотентны; исчезнувшее событие — W_OVERRIDE_STALE', check: tst37 },
  { id: 'TST-38', name: 'круг экспорта: state_hash(import_json(export_json(журнал))) = state_hash(свёртка журнала)', check: tst38 },
  { id: 'TST-39', name: 'S_max(as_of) = STS(horizon_end); без резервов free = trough; OK ⇔ S ≤ S_max(worse)(D)', check: tst39 },
]);

/**
 * Прогнать инвариант на журналах `[start, start + n)` серии. Нарушения собираются с seed (повторяемость): первые `keep` случаев.
 * Исключение внутри инварианта — тоже нарушение (инвариант обязан быть выполним на любом валидном журнале).
 * `stop_on_first` — остановиться на первом нарушении (проверка на мутациях: достаточно одного красного случая).
 * @returns {{n: number, checked: number, violations: {i: number, seed: number, messages: string[]}[], failed: number}}
 */
export function run_invariant(check, api, { n = PROP_N, start = 0, keep = 5, stop_on_first = false } = {}) {
  const violations = [];
  let failed = 0;
  let checked = 0;
  for (let i = start; i < start + n; i++) {
    const c = case_at(i);
    let messages;
    checked += 1;
    try { messages = check(api, c); } catch (e) { messages = [`исключение: ${e?.name}: ${e?.message}`]; }
    if (messages.length > 0) {
      failed += 1;
      if (violations.length < keep) violations.push({ i, seed: c.seed, messages: messages.slice(0, 3) });
      if (stop_on_first) break;
    }
  }
  return { n, checked, violations, failed };
}
