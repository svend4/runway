// backtest.test.mjs — backtest «как знали тогда», метрики и гейт релиза (ALG-13 v2, REQ-176, REQ-185): TST-55, TST-60 (слои B4), часть TST-33.
// Ожидаемые числа — из канона ДОСЛОВНО: wiki/algorithms/alg-13 (TV-6), product/11 (TST-55), requirements REQ-176/185, design-brief §14 B4, C-055.
// ВАЖНО о гейте релиза: реальных журналов добровольцев (≥ 10, REQ-176) нет. Здесь гейт «FRR ≤ 5 %, cry-wolf ≤ 50 %» демонстрируется на
// СИНТЕТИЧЕСКИХ журналах из data/synthetic-journals/generate.mjs: это прототипная проверка того, что метрика и гейт считаются верно и ловят
// провал, а не свидетельство качества прогноза на реальных людях. Пороги, окна (30 дн., 14 дн.) и порог проб θ — гипотезы до первого замера (C-055).
// В тестах допустимы node:fs и Date (в engine/ — нет).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import * as bt from '../engine/backtest.mjs';
import { analyze } from '../engine/index.mjs';
import { check_purchase } from '../engine/afford.mjs';
import { make_event, reduce, effective_events } from '../engine/ledger.mjs';
import * as calibration from '../engine/calibration.mjs';
import { parse_date, format_date } from '../engine/dates.mjs';
import { round_div } from '../engine/money.mjs';
import { make_journal, journal_hash, regular_corpus, stress_corpus } from '../data/synthetic-journals/generate.mjs';
import { throws_code } from './helpers.mjs';

const DATA = new URL('../data/', import.meta.url);
const ENGINE = new URL('../engine/', import.meta.url);
const load = (name) => JSON.parse(fs.readFileSync(new URL(name, DATA), 'utf8'));
const G = load('g001.json');

/** Отчёт-заготовка: только счётчики, нужные гейту. */
const rep = (k1, n1, k2, n2) => ({ frr: { k: k1, n: n1, bp: n1 === 0 ? null : round_div(10000 * k1, n1) }, cry_wolf: { k: k2, n: n2, bp: n2 === 0 ? null : round_div(10000 * k2, n2) } });

/** Разложить суммарные счётчики по `parts` журналам (остаток — в первые). */
function spread(k1, n1, k2, n2, parts) {
  const split = (total) => Array.from({ length: parts }, (_, i) => Math.floor(total / parts) + (i < total % parts ? 1 : 0));
  const [a, b, c, d] = [split(k1), split(n1), split(k2), split(n2)];
  return Array.from({ length: parts }, (_, i) => rep(a[i], b[i], c[i], d[i]));
}

// ── TST-55: гейт релиза (арифметика) ──────────────────────────────────────────────────────────────────────────────────

test('TST-55 гейт REQ-176: 200 вердиктов OK, 9 с пробоем → FRR 450 bp — проходит; 120 тревог, 66 зря → cry-wolf 5500 bp — не проходит', () => {
  const ok = bt.release_gate(spread(9, 200, 30, 100, 10));
  assert.equal(ok.frr_bp, 450);
  assert.equal(ok.pass, true);
  assert.deepEqual(ok.reasons, []);
  const bad = bt.release_gate(spread(9, 200, 66, 120, 10));
  assert.equal(bad.frr_bp, 450);
  assert.equal(bad.cry_wolf_bp, 5500);
  assert.equal(bad.pass, false);
  assert.deepEqual(bad.reasons, ['cry_wolf_above_50pct']);
});

test('TST-55 гейт: при n_ok < 20 допустим 0 пробоев — 1 из 19 = 526 bp не проходит, 1 из 20 = 500 bp проходит; границы нестрогие', () => {
  const g19 = bt.release_gate(spread(1, 19, 0, 10, 10));
  assert.equal(g19.frr_bp, 526);
  assert.equal(g19.pass, false);
  assert.deepEqual(g19.reasons, ['frr_above_5pct']);
  const g20 = bt.release_gate(spread(1, 20, 0, 10, 10));
  assert.equal(g20.frr_bp, 500);
  assert.equal(g20.pass, true);
  assert.equal(bt.release_gate(spread(0, 10, 0, 10, 10)).pass, true, '0 пробоев и 0 зря — проходит');
  // cry-wolf ровно 50 % проходит, 51 % — нет
  assert.equal(bt.release_gate(spread(0, 100, 50, 100, 10)).pass, true);
  assert.equal(bt.release_gate(spread(0, 100, 51, 100, 10)).pass, false);
});

test('TST-55 гейт: меньше 10 журналов, N1 = 0 или N2 = 0 — замера нет, гейт не пройден', () => {
  const g9 = bt.release_gate(spread(0, 50, 0, 50, 9));
  assert.equal(g9.pass, false);
  assert.deepEqual(g9.reasons, ['journals_lt_10']);
  assert.equal(g9.n_journals, 9);
  const no_ok = bt.release_gate(spread(0, 0, 3, 20, 10));
  assert.equal(no_ok.pass, false);
  assert.deepEqual(no_ok.reasons, ['no_ok_verdicts']);
  assert.equal(no_ok.frr_bp, null);
  const no_alarm = bt.release_gate(spread(1, 50, 0, 0, 10));
  assert.equal(no_alarm.pass, false);
  assert.deepEqual(no_alarm.reasons, ['no_alarms']);
  assert.equal(no_alarm.cry_wolf_bp, null);
  const empty = bt.release_gate([]);
  assert.equal(empty.pass, false);
  assert.deepEqual(empty.reasons, ['journals_lt_10', 'no_ok_verdicts', 'no_alarms']);
});

test('TST-55 гейт считается по сумме счётчиков по журналам, а не по среднему долей (C-055)', () => {
  // 1/1 в одном журнале (10000 bp) и 0/99 в девяти: среднее долей 1000 bp «провалило» бы, сумма — 1/892 = 11 bp
  const a = bt.release_gate([rep(1, 1, 5, 10), ...Array.from({ length: 9 }, () => rep(0, 99, 5, 10))]);
  assert.deepEqual([a.k1, a.n1, a.frr_bp, a.pass], [1, 892, 11, true]);
  // обратный случай: среднее долей по журналам 150 bp, а по сумме 30/290 = 1034 bp — не проходит
  const b = bt.release_gate([rep(30, 200, 5, 10), ...Array.from({ length: 9 }, () => rep(0, 10, 5, 10))]);
  assert.deepEqual([b.k1, b.n1, b.frr_bp, b.pass], [30, 290, 1034, false]);
  assert.deepEqual(b.reasons, ['frr_above_5pct']);
});

test('TST-55 релиз: два журнала ALG-13 TV-6 — cry-wolf = 1 из 2 = 5000 bp, n_ok = 0 → FRR null; журналов 2 < 10 → гейт не оценивается', () => {
  // журнал А — доход пришёл вовремя (пробоя нет, тревога зря: k = 1 из 1); журнал Б — лаг 14 (пробой есть: k = 0 из 1)
  const canon_pool = bt.release_gate([rep(0, 0, 1, 1), rep(0, 0, 0, 1)]);
  assert.deepEqual([canon_pool.k2, canon_pool.n2, canon_pool.cry_wolf_bp], [1, 2, 5000]);
  assert.equal(canon_pool.frr_bp, null);
  assert.equal(canon_pool.pass, false);
  assert.deepEqual(canon_pool.reasons, ['journals_lt_10', 'no_ok_verdicts']);
});

// ── метрики ошибки (ALG-13 TV-6, учебные окна) ────────────────────────────────────────────────────────────────────────

test('TST-55 метрики окон (ALG-13 TV-6): MAE = 6000, bias = 1000, skill = 845 пм, коридор содержит факт в 3 окнах из 4', () => {
  const F = [340000, 300000, 280000, 250000];
  const A = [335000, 310000, 280000, 241000];
  const N0 = [400000, 340000, 300000, 280000];
  const band = [[330000, 340000], [290000, 300000], [270000, 280000], [240000, 250000]];
  const m = bt.window_metrics(F.map((f, i) => ({ forecast: f, actual: A[i], naive: N0[i], lo: band[i][0], hi: band[i][1] })));
  // Σ|F − A| = 5000 + 10000 + 0 + 9000 = 24000; Σ|N0 − A| = 65000 + 30000 + 20000 + 39000 = 154000
  assert.equal(m.n, 4);
  assert.equal(m.mae_minor, 6000);
  assert.equal(m.bias_minor, 1000, 'round_div(5000 − 10000 + 0 + 9000, 4)');
  assert.equal(m.skill_pm, 845, '1000 − floor_div(24000000, 154000) = 1000 − 155');
  assert.equal(m.hits, 3);
  assert.deepEqual(bt.window_metrics([]), { n: 0, mae_minor: null, bias_minor: null, skill_pm: null, hits: 0 });
  assert.equal(bt.window_metrics([{ forecast: 5, actual: 5, naive: 5, lo: 0, hi: 9 }]).skill_pm, null, 'наивный прогноз точен — skill не определён');
});

// ── фактический ряд по полному журналу (C-055) ─────────────────────────────────────────────────────────────────────────

const D = (n) => format_date(parse_date('2026-03-01') + n);
const acc = { account_id: 'A', name: 'Основной', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 };
const fact = (id, n, amount, extra = {}) => ({ event_id: id, account_id: 'A', date: D(n), amount_minor: amount, currency: 'EUR', ...extra });

test('TST-55 actual_rows: close, trough (расходы раньше доходов), reserve_trough и free — ручной расчёт на малом примере', () => {
  const ws = {
    decision_currency: 'EUR',
    accounts: [acc],
    anchors: [{ anchor_id: 'n0', account_id: 'A', date: D(0), amount_minor: 1000 }],
    facts: [fact('f1', 1, -200), fact('f2', 2, 500, { kind: 'income' }), fact('f3', 2, -100), fact('f4', 4, -50)],
    reserves: [{ reserve_id: 'RS', kind: 'sinking', currency: 'EUR', funded_start_minor: 300, funded_as_of: D(0), backed_by_account_id: null }],
    allocations: [{ allocation_id: 'x1', reserve_id: 'RS', date: D(2), amount_minor: 50, source: 'manual' }],
  };
  const r = bt.actual_rows(ws, D(1), D(4));
  assert.equal(r.opening_minor, 1000, 'остаток на конец дня перед окном');
  assert.deepEqual(r.close, [800, 1200, 1200, 1150]);
  assert.deepEqual(r.trough, [800, 700, 1200, 1150], 'день 2: 800 + (−100) = 700 — доход 500 приходит после расходов');
  assert.deepEqual(r.reserve_trough, [300, 350, 350, 350], 'ручная аллокация +50 в начале дня 2');
  assert.deepEqual(r.free, [500, 350, 850, 800]);
  // реестр: отдельные функции дня
  assert.equal(bt.actual_close(ws, D(2)), 1200);
  assert.equal(bt.actual_trough(ws, D(2)), 700);
  assert.equal(bt.reserve_trough(ws, D(2)), 350);
  assert.equal(bt.actual_free(ws, D(2)), 350);
  // результат дня не зависит от того, с какой даты начато окно
  for (let a = 0; a <= 4; a++) {
    for (let b = a; b <= 4; b++) {
      const w = bt.actual_rows(ws, D(Math.max(a, 1)), D(Math.max(b, 1)));
      const d0 = Math.max(a, 1);
      w.free.forEach((f, i) => assert.equal(f, r.free[d0 - 1 + i], `окно ${a}…${b}, день ${d0 + i}`));
    }
  }
  throws_code(() => bt.actual_rows(ws, D(3), D(2)), 'E_BAD_DATE');
});

test('TST-55 actual_rows: платёж, привязанный к резерву, высвобождает min(funded, платёж); превышение (true_up) уходит из свободных денег', () => {
  const base = {
    decision_currency: 'EUR',
    accounts: [acc],
    anchors: [{ anchor_id: 'n0', account_id: 'A', date: D(0), amount_minor: 1000 }],
    reserves: [{ reserve_id: 'RS', kind: 'sinking', currency: 'EUR', funded_start_minor: 300, funded_as_of: D(0), backed_by_account_id: null }],
    allocations: [],
  };
  const ws = { ...base, facts: [fact('p1', 2, -200, { reserve_id: 'RS' })] };
  const r = bt.actual_rows(ws, D(1), D(3));
  assert.deepEqual(r.trough, [1000, 800, 800]);
  assert.deepEqual(r.reserve_trough, [300, 100, 100], 'released = min(300, 200) = 200');
  assert.deepEqual(r.free, [700, 700, 700], 'платёж из резерва свободные деньги не меняет');
  const big = bt.actual_rows({ ...base, facts: [fact('p2', 2, -450, { reserve_id: 'RS' })] }, D(1), D(3));
  assert.deepEqual(big.reserve_trough, [300, 0, 0], 'released = 300');
  assert.deepEqual(big.free, [700, 550, 550], 'true_up = 150 уменьшает free: 1000 − 450 − 0 = 550');
});

test('TST-55 actual_rows: налог по поступившему доходу без записанной аллокации считается на лету; записанная аллокация не задваивается', () => {
  const rule = { tax_rule_id: 'TR', version: 1, kind: 'percent_of_income', rate_bp: 1000, base: 'gross', applies_to: { stream_ids: ['S1'], tags: [] }, valid_from: '2026-01-01', valid_to: null, rounding: 'half_even', reserve_id: 'RT' };
  const mk = (allocations) => ({
    decision_currency: 'EUR',
    accounts: [acc],
    anchors: [{ anchor_id: 'n0', account_id: 'A', date: D(0), amount_minor: 1000 }],
    facts: [fact('f1', 1, -200), fact('f2', 2, 500, { kind: 'income', stream_id: 'S1' }), fact('f3', 2, -100), fact('f4', 4, -50)],
    tax_rules: [rule],
    reserves: [{ reserve_id: 'RT', kind: 'tax', currency: 'EUR', funded_start_minor: 0, funded_as_of: D(0), tax_rule_id: 'TR', backed_by_account_id: null }],
    allocations,
  });
  // без записи: 10 % от 500 = 50, попадает в резерв после доходов дня 2 (D-08), т.е. виден с дня 3
  const derived = bt.actual_rows(mk([]), D(1), D(4));
  assert.deepEqual(derived.trough, [800, 700, 1200, 1150]);
  assert.deepEqual(derived.reserve_trough, [0, 0, 50, 50]);
  assert.deepEqual(derived.free, [800, 700, 1150, 1100]);
  // та же аллокация записана журналом — не задваивается
  const recorded = bt.actual_rows(mk([{ allocation_id: 'tax:TR@f2', reserve_id: 'RT', date: D(2), amount_minor: 50, source: 'income', source_event_id: 'f2' }]), D(1), D(4));
  assert.deepEqual(recorded.reserve_trough, [0, 0, 50, 50]);
  assert.deepEqual(recorded.free, derived.free);
  // записанная другая сумма главнее правила
  const other = bt.actual_rows(mk([{ allocation_id: 'tax:TR@f2', reserve_id: 'RT', date: D(2), amount_minor: 40, source: 'income', source_event_id: 'f2' }]), D(1), D(4));
  assert.deepEqual(other.reserve_trough, [0, 0, 40, 40]);
  // окно, начатое после дохода: состояние резерва на начало окна учитывает доход на лету
  const late = bt.actual_rows(mk([]), D(3), D(4));
  assert.deepEqual(late.reserve_trough, [50, 50]);
  assert.deepEqual(late.free, [1150, 1100]);
});

test('TST-55 actual_rows: якорь сбрасывает остаток (drift виден); счета не operating и переводы между своими счетами в потоки не входят', () => {
  const ws = {
    decision_currency: 'EUR',
    accounts: [acc, { account_id: 'SAV', name: 'Накопительный', kind: 'bank', liquidity: 'reference', currency: 'EUR', exponent: 2 }],
    anchors: [
      { anchor_id: 'n0', account_id: 'A', date: D(0), amount_minor: 1000 },
      { anchor_id: 'n3', account_id: 'A', date: D(3), amount_minor: 1190 }, // факты дали бы 1200 → drift −10
    ],
    facts: [
      fact('f1', 1, -100),
      fact('f2', 2, -80, { transfer_id: 'T1' }), // перевод на справочный (не operating) счёт — обычный расход operating-счёта
      { event_id: 'g1', account_id: 'SAV', date: D(2), amount_minor: 80, currency: 'EUR', transfer_id: 'T1' },
      fact('f4', 4, -40),
    ],
  };
  const r = bt.actual_rows(ws, D(1), D(4));
  assert.deepEqual(r.close, [900, 820, 1190, 1150], 'на день 3 — якорь 1190, не 820 по фактам; накопительный счёт не в остатке');
  assert.deepEqual(r.trough, [900, 820, 820, 1150], 'расходы дня до доходов; на день 3 расхождение якоря на trough ещё не повлияло');
  assert.deepEqual(r.reserve_trough, [0, 0, 0, 0]);
  // перевод между двумя operating-счетами — нетто 0, из расходов исключён (D-20)
  const two = { ...ws, accounts: [acc, { ...acc, account_id: 'B', name: 'Второй' }], anchors: [{ anchor_id: 'n0', account_id: 'A', date: D(0), amount_minor: 1000 }, { anchor_id: 'm0', account_id: 'B', date: D(0), amount_minor: 100 }],
    facts: [fact('f2', 2, -80, { transfer_id: 'T2' }), { event_id: 'g2', account_id: 'B', date: D(2), amount_minor: 80, currency: 'EUR', transfer_id: 'T2' }] };
  const rr = bt.actual_rows(two, D(1), D(3));
  assert.deepEqual(rr.close, [1100, 1100, 1100], 'общий остаток не меняется');
  assert.deepEqual(rr.trough, [1100, 1100, 1100], 'внутренний перевод расходом не считается');
});

// ── срез «как знали тогда» ────────────────────────────────────────────────────────────────────────────────────────────

test('TST-55/33 replay_state: введённое задним числом невидимо; откат известен только после записи отката; будущие факты не входят', () => {
  const mk = (type, payload, seq, recorded_day, extra = {}) => make_event(type, payload, { event_id: `e${seq}`, seq, recorded_at: `${recorded_day}T12:00:00Z`, ...extra });
  const tx = (seq, date, amount, recorded_day) => mk('tx.posted', { account_id: 'A', date, amount_minor: amount, currency: 'EUR' }, seq, recorded_day, { entity_id: `e${seq}` });
  const journal = [
    mk('account.opened', { ...acc, opened_on: '2026-03-01' }, 1, '2026-03-01'),
    mk('anchor.set', { anchor_id: 'n0', account_id: 'A', date: '2026-03-01', amount_minor: 1000 }, 2, '2026-03-01'),
    tx(3, '2026-03-02', -100, '2026-03-02'),
    tx(4, '2026-03-03', -50, '2026-03-10'), // внесён позже: на 03-05 неизвестен
    tx(5, '2026-03-04', -20, '2026-03-04'),
    mk('revert', { target: 'e5' }, 6, '2026-03-06'),
    tx(7, '2026-03-20', -999, '2026-03-05'), // с датой в будущем: в срез на 03-05 не входит
  ];
  const ids = (t) => Object.values(bt.replay_state(journal, t).facts).map((f) => f.event_id).sort();
  assert.deepEqual(ids('2026-03-02'), ['e3']);
  assert.deepEqual(ids('2026-03-05'), ['e3', 'e5'], 'e4 введён позже, e5 ещё не отменён, e7 — будущая дата');
  assert.deepEqual(ids('2026-03-06'), ['e3'], 'откат e5 известен с 03-06');
  assert.deepEqual(ids('2026-03-10'), ['e3', 'e4']);
  assert.deepEqual(ids('2026-03-20'), ['e3', 'e4', 'e7']);
  // срез по датам не убывает по записям (инвариант ALG-13 п. 8) — число записей
  let prev = 0;
  for (let t = parse_date('2026-03-01'); t <= parse_date('2026-03-25'); t++) {
    const n = Object.keys(bt.replay_state(journal, t).anchors).length + Object.keys(bt.replay_state(journal, t).accounts).length;
    assert.ok(n >= prev);
    prev = n;
  }
});

// ── сквозной пример G-001: исход «пробой буфера» по фактам (ALG-13 TV-6) ──────────────────────────────────────────────────

/** Полный журнал G-001 с «фактами» плана: доходы приходят с лагом `lag`, расходы — по плану, плюс покупка 300,00 € на 10-12. */
function g001_full(lag) {
  const A = analyze(G, { as_of: '2026-10-04' });
  const facts = [...G.facts];
  A.events.plan.forEach((e, i) => {
    facts.push({
      event_id: 'a' + i, account_id: 'acc_main', date: format_date(e.kind === 'income' ? e.date + lag : e.date), amount_minor: e.amount_minor, currency: 'EUR',
      kind: e.kind, tag: e.tag, stream_id: e.stream_id ?? undefined, is_obligation: e.is_obligation, is_estimate: e.is_estimate, reserve_id: e.reserve_id,
    });
  });
  facts.push({ event_id: 'buy', account_id: 'acc_main', date: '2026-10-12', amount_minor: -30000, currency: 'EUR', kind: 'expense', tag: 'покупка' });
  // взнос резерва «страховка» по расписанию записан журналом (ALG-05 TV-1: 12000 на 2026-11-01)
  return { ...G, facts, allocations: [{ allocation_id: 'sch:RES-INS@2026-11-01', reserve_id: 'RES-INS', date: '2026-11-01', amount_minor: 12000, source: 'schedule' }] };
}

test('TST-55 actual_free по фактам совпадает с рядом plan из analyze на всех 58 днях G-001 (доходы вовремя, покупки нет)', () => {
  const A = analyze(G, { as_of: '2026-10-04' });
  const full = g001_full(0);
  full.facts = full.facts.filter((f) => f.event_id !== 'buy');
  const r = bt.actual_rows(full, '2026-10-04', '2026-11-30');
  assert.deepEqual(r.close, A.series.plan.close);
  assert.deepEqual(r.trough, A.series.plan.trough);
  assert.deepEqual(r.reserve_trough, A.series.plan.reserve_trough);
  assert.deepEqual(r.free, A.series.plan.free);
});

test('TST-55 G-001: покупка 300,00 € → FRAGILE; доход вовремя — минимум фактического free 63500 (пробоя нет), лаг 14 — 41000 (пробой при H = 49 дн.)', () => {
  const A = analyze(G, { as_of: '2026-10-04' });
  const ans = check_purchase(A, { currency: 'EUR', parts: [{ date: '2026-10-12', amount_minor: 30000 }] });
  assert.equal(ans.kind, 'ok');
  assert.equal(ans.verdict, 'FRAGILE', 'plan: 63500 ≥ 50000, worse: 41000 < 50000');
  const e = { date: '2026-10-12', amount_minor: -30000 };
  const min_free = (full, H) => Math.min(...bt.actual_rows(full, e.date, parse_date(e.date) + H).free);
  const A0 = g001_full(0);
  const B14 = g001_full(14);
  assert.equal(min_free(A0, 49), 63500);
  assert.equal(min_free(B14, 49), 41000);
  assert.equal(bt.default_breach(A0, e, 49, 50000), false, 'журнал А: тревога зря (cry-wolf)');
  assert.equal(bt.default_breach(B14, e, 49, 50000), true, 'журнал Б: пробой 11-14');
  // при рабочем H = 30 окно 10-12…11-11 закончилось до пробоя 11-14 и его не видит — поэтому значение H подлежит замеру (REQ-176)
  assert.equal(bt.default_breach(B14, e, 30, 50000), false);
  assert.equal(format_date(parse_date(e.date) + 30), '2026-11-11');
  // пул из двух журналов: cry-wolf = 1 из 2 (А — без пробоя, Б — с пробоем), n_ok = 0
  const verdicts = [[A0, 49], [B14, 49]].map(([full, H]) => ({ v: ans.verdict, breach: bt.default_breach(full, e, H, 50000) }));
  const k2 = verdicts.filter((x) => (x.v === 'FRAGILE' || x.v === 'NO') && !x.breach).length;
  assert.equal(k2, 1);
  const pool = bt.release_gate([rep(0, 0, k2, verdicts.length)]);
  assert.equal(pool.cry_wolf_bp, 5000);
  assert.equal(pool.frr_bp, null);
  assert.equal(pool.pass, false);
});

test('TST-55 default_breach: окно H = 0 — один день; границы B включительные (free < B — пробой, free = B — нет); неверные аргументы → ошибки', () => {
  const full = g001_full(14);
  const e = { date: '2026-10-12' };
  const day = bt.actual_free(full, '2026-10-12');
  assert.equal(day, 207500, 'уже с покупкой 300,00 € на 10-12: trough 357500 − резервы 150000');
  assert.equal(bt.default_breach(full, e, 0, day), false, 'free = B — буфер держится');
  assert.equal(bt.default_breach(full, e, 0, day + 1), true);
  throws_code(() => bt.default_breach(full, e, -1, 50000), 'E_SCHEMA');
  throws_code(() => bt.default_breach(full, e, 1.5, 50000), 'E_SCHEMA');
  throws_code(() => bt.default_breach(full, e, 30, 1.5), 'E_NOT_INTEGER');
});

// ── синтетические журналы: генератор ──────────────────────────────────────────────────────────────────────────────────

const MANIFEST = load('synthetic-journals/manifest.json');

test('TST-33/55 генератор синтетических журналов детерминирован: повторный вызов даёт тот же журнал, хэши совпадают с manifest.json', () => {
  for (const [name, specs] of [['regular', regular_corpus()], ['stress', stress_corpus()]]) {
    assert.equal(MANIFEST.corpora[name].length, specs.length);
    specs.forEach((spec, i) => {
      const j = make_journal(spec);
      assert.equal(MANIFEST.corpora[name][i].id, spec.id);
      assert.equal(j.length, MANIFEST.corpora[name][i].events, `${spec.id}: число записей`);
      assert.equal(journal_hash(j), MANIFEST.corpora[name][i].sha256, `${spec.id}: хэш — если генератор менялся намеренно, перегенерируйте manifest.json (write_manifest.mjs)`);
    });
  }
  const a = make_journal(regular_corpus()[1]);
  assert.deepEqual(make_journal(regular_corpus()[1]), a);
  assert.notEqual(journal_hash(make_journal({ ...regular_corpus()[1], seed: 1 })), journal_hash(a), 'другой seed — другой журнал');
});

test('TST-55 генератор: размер корпусов (12 «обычных» и 10 «стресс» журналов), «как знали тогда» (запись введена в день события), seq возрастает', () => {
  assert.equal(regular_corpus().length, 12);
  assert.equal(stress_corpus().length, 10);
  const ids = new Set();
  for (const spec of [...regular_corpus(), ...stress_corpus()]) {
    assert.ok(!ids.has(spec.id));
    ids.add(spec.id);
  }
  const j = make_journal(regular_corpus()[1]); // reg02: есть налоговый конверт
  assert.ok(j.some((e) => e.type === 'taxrule.set') && j.some((e) => e.type === 'reserve.set') && j.some((e) => e.type === 'allocation.recorded'));
  j.forEach((e, i) => assert.equal(e.seq, i + 1));
  for (const e of j) {
    if (e.type === 'tx.posted') assert.equal(e.recorded_at.slice(0, 10), e.payload.date, 'факт внесён в день события');
    if (e.type === 'anchor.set') assert.equal(e.recorded_at.slice(0, 10), e.payload.date);
  }
  // нет float и нет задним числом внесённого: reduce проходит без ошибок
  assert.doesNotThrow(() => reduce(effective_events(j)));
});

test('TST-55 генератор согласован с движком: плановые вхождения сопоставляются с фактами — просрочены только ещё не пришедшие доходы; готовность 4, свежесть без блокировки', () => {
  for (const idx of [0, 1]) {
    const j = make_journal(regular_corpus()[idx]);
    for (let t = parse_date('2026-02-01'); t <= parse_date('2026-09-20'); t += 9) {
      const A = analyze(bt.replay_state(j, t), { as_of: t, horizon_end: t + 45 });
      assert.equal(A.readiness.score, 4, `${format_date(t)}: готовность`);
      assert.notEqual(A.anchor_status.level, 'block', `${format_date(t)}: свежесть`);
      const bad = A.events.plan.filter((e) => e.status === 'overdue' && e.kind !== 'income');
      assert.deepEqual(bad.map((e) => e.cash_event_id), [], `${format_date(t)}: просрочены расходы — факт не сопоставился`);
      assert.equal(A.buffer_minor, 50000);
    }
  }
});

// ── backtest на синтетическом журнале ─────────────────────────────────────────────────────────────────────────────────

const T0 = '2026-03-01';
const H_STEP = 14;
const J2 = make_journal(regular_corpus()[1]); // reg02: 12 % налоговый конверт, «обычный» клиент

function last_fact_day(journal) {
  return Math.max(...journal.filter((e) => e.type === 'tx.posted').map((e) => parse_date(e.payload.date)));
}

test('TST-55 backtest: форма отчёта, число начал t0 + j·h ≤ последний факт − h, определённость метрик', () => {
  const r = bt.backtest(J2, T0, H_STEP);
  const last = last_fact_day(J2);
  const expect_n = Math.floor((last - H_STEP - parse_date(T0)) / H_STEP) + 1;
  assert.equal(r.n_origins, expect_n);
  assert.equal(r.hidden, false);
  assert.equal(r.skipped_origins, 0);
  assert.deepEqual(Object.keys(r).sort(), ['bias_minor', 'censored', 'coverage', 'cry_wolf', 'frr', 'hidden', 'insufficient', 'mae_minor', 'min_error', 'n_origins', 'n_tight', 'skill_pm', 'skipped_origins'].sort());
  assert.equal(r.coverage.n, r.n_origins);
  assert.ok(r.coverage.k >= 0 && r.coverage.k <= r.coverage.n);
  assert.ok(Number.isInteger(r.mae_minor) && r.mae_minor >= 0);
  assert.ok(Number.isInteger(r.bias_minor));
  assert.ok(Number.isInteger(r.skill_pm));
  for (const m of [r.frr, r.cry_wolf]) {
    assert.ok(m.k >= 0 && m.k <= m.n);
    assert.equal(m.bp, m.n === 0 ? null : round_div(10000 * m.k, m.n));
  }
  assert.equal(r.min_error.n, r.n_origins);
  assert.ok(r.censored >= 0);
});

test('TST-55 backtest: метрики совпадают с независимым пересчётом (analyze на срезе «как знали тогда» против фактического остатка на t + h)', () => {
  const r = bt.backtest(J2, T0, H_STEP);
  const full = reduce(effective_events(J2));
  const last = last_fact_day(J2);
  let err = 0; let abs_err = 0; let abs_naive = 0; let hits = 0; let n = 0;
  for (let t = parse_date(T0); t + H_STEP <= last; t += H_STEP) {
    const A = analyze(bt.replay_state(J2, t), { as_of: t, horizon_end: t + H_STEP });
    const F = A.series.plan.close[H_STEP];
    const W = A.series.worse.close[H_STEP];
    const act = bt.actual_close(full, t + H_STEP);
    err += F - act; abs_err += Math.abs(F - act); abs_naive += Math.abs(A.series.plan.opening_minor - act);
    if (Math.min(F, W) <= act && act <= Math.max(F, W)) hits++;
    n++;
  }
  assert.equal(r.n_origins, n);
  assert.equal(r.mae_minor, round_div(abs_err, n));
  assert.equal(r.bias_minor, round_div(err, n));
  assert.equal(r.skill_pm, 1000 - Math.floor((1000 * abs_err) / abs_naive));
  assert.equal(r.coverage.k, hits);
});

test('TST-55 backtest детерминирован (повторный запуск — тот же отчёт); hidden при n_origins < min_origins; min_origins настраивается', () => {
  const a = bt.backtest(J2, T0, H_STEP);
  assert.deepEqual(bt.backtest(J2, T0, H_STEP), a);
  const sparse = bt.backtest(J2, T0, 120);
  assert.ok(sparse.n_origins < 3 && sparse.n_origins >= 1);
  assert.equal(sparse.hidden, true, 'до 2–3 окон метрики скрыты');
  assert.equal(bt.backtest(J2, T0, 120, { min_origins: 1 }).hidden, false);
  assert.equal(bt.BACKTEST_DEFAULTS['calib.min_origins'], 3);
});

test('TST-55 backtest: opts.breach подменяет определение исхода — «всегда пробой» → FRR k = n, cry-wolf k = 0; «никогда» → FRR k = 0, cry-wolf k = n', () => {
  const calls = [];
  const yes = bt.backtest(J2, T0, H_STEP, { breach: (full, e, H, B) => { calls.push({ H, B, id: e.id, date: e.date }); return true; } });
  const no = bt.backtest(J2, T0, H_STEP, { breach: () => false });
  assert.equal(yes.frr.k, yes.frr.n);
  assert.equal(yes.cry_wolf.k, 0);
  assert.equal(no.frr.k, 0);
  assert.equal(no.cry_wolf.k, no.cry_wolf.n);
  assert.equal(yes.frr.n + yes.cry_wolf.n + yes.n_tight, calls.length, 'исход спрашивается по каждой пробе с ответом ok');
  assert.ok(calls.length > 0);
  assert.ok(calls.every((c) => c.H === 30 && c.B === 50000 && Number.isInteger(c.date) && typeof c.id === 'string'), 'H = backtest.h_days = 30; B(t) — буфер журнала на момент вопроса');
  assert.deepEqual([yes.frr.n, yes.cry_wolf.n], [no.frr.n, no.cry_wolf.n], 'вердикты от определения исхода не зависят');
});

test('TST-55 backtest: коридор покрытия задаётся функцией (P10–P90 по ALG-10 подставляет вызывающий); окно H = 0 даёт меньше цензурированных проб, H = 60 — больше', () => {
  const all = bt.backtest(J2, T0, H_STEP, { band: () => ({ lo: -1e12, hi: 1e12 }) });
  assert.equal(all.coverage.k, all.n_origins);
  const none = bt.backtest(J2, T0, H_STEP, { band: () => ({ lo: 0, hi: 0 }) });
  assert.equal(none.coverage.k, 0);
  const h0 = bt.backtest(J2, T0, H_STEP, { H: 0 });
  const h30 = bt.backtest(J2, T0, H_STEP);
  const h60 = bt.backtest(J2, T0, H_STEP, { H: 60 });
  assert.ok(h0.censored <= h30.censored && h30.censored <= h60.censored);
  assert.equal(h60.frr.n + h60.cry_wolf.n + h60.n_tight + h60.insufficient + h60.censored >= 0, true);
});

test('TST-55 backtest: «данных мало» (нет буфера) уходит в insufficient и не входит ни в FRR, ни в cry-wolf (D-22)', () => {
  const no_buffer = J2.filter((e) => e.type !== 'params.set');
  const r = bt.backtest(no_buffer, T0, H_STEP);
  assert.ok(r.insufficient > 0);
  assert.deepEqual([r.frr.n, r.cry_wolf.n, r.n_tight], [0, 0, 0]);
  assert.equal(r.frr.bp, null);
  assert.equal(r.cry_wolf.bp, null);
  assert.equal(bt.release_gate(Array.from({ length: 10 }, () => r)).pass, false);
});

test('TST-55 backtest: начала до открытия счёта пропускаются (skipped_origins), ошибки аргументов → E_SCHEMA', () => {
  const early = bt.backtest(J2, '2025-12-01', H_STEP);
  assert.equal(early.skipped_origins, 3, '2025-12-01, 12-15, 12-29 — журнала ещё нет');
  throws_code(() => bt.backtest(J2, T0, 0), 'E_SCHEMA');
  throws_code(() => bt.backtest(J2, T0, 1.5), 'E_SCHEMA');
  throws_code(() => bt.backtest(J2, T0, H_STEP, { H: -1 }), 'E_SCHEMA');
  throws_code(() => bt.backtest(J2.filter((e) => e.type !== 'tx.posted'), T0, H_STEP), 'E_SCHEMA', 'нет ни одного факта');
});

test('TST-55 min_error (REQ-185): ошибка минимума — (факт − прогноз)/|прогноз| в bp по плану и физическому trough, окно 14 дн.', () => {
  const r = bt.backtest(J2, T0, H_STEP);
  assert.equal(r.min_error.n, r.n_origins);
  assert.ok(Number.isInteger(r.min_error.mean_bp) && Number.isInteger(r.min_error.mae_bp));
  assert.ok(r.min_error.mae_bp >= Math.abs(r.min_error.mean_bp));
  // независимый расчёт на первом начале
  const t = parse_date(T0);
  const A = analyze(bt.replay_state(J2, t), { as_of: t, horizon_end: t + H_STEP });
  const full = reduce(effective_events(J2));
  const rows = bt.actual_rows(full, t, t + H_STEP);
  const f_min = Math.min(...A.series.plan.trough.slice(0, 14));
  const a_min = Math.min(...rows.trough.slice(0, 14));
  assert.ok(f_min !== 0);
  const one = bt.backtest(J2, T0, H_STEP, { min_origins: 1 });
  assert.ok(Number.isInteger(round_div(10000 * (a_min - f_min), Math.abs(f_min))));
  assert.equal(one.min_error.n, r.min_error.n);
  // каноническая иллюстрация REQ-185: прогноз 120000, факт 109000 → −917 bp
  assert.equal(round_div(10000 * (109000 - 120000), 120000), -917);
});

// ── TST-55: гейт на синтетических корпусах ────────────────────────────────────────────────────────────────────────────

const memo = new Map();
function corpus_reports(name, specs) {
  if (!memo.has(name)) memo.set(name, specs.map((spec) => bt.backtest(make_journal(spec), T0, H_STEP)));
  return memo.get(name);
}

test('TST-55 гейт релиза на СИНТЕТИЧЕСКИХ «обычных» журналах (12 шт.): FRR ≤ 5 %, cry-wolf ≤ 50 % — проходит (демонстрация метрики, не данные пользователей)', (t) => {
  const reports = corpus_reports('regular', regular_corpus());
  const g = bt.release_gate(reports);
  t.diagnostic(`regular: журналов ${g.n_journals}, FRR ${g.k1}/${g.n1} = ${g.frr_bp} bp, cry-wolf ${g.k2}/${g.n2} = ${g.cry_wolf_bp} bp`);
  assert.equal(reports.length, 12);
  assert.ok(g.n1 > 0 && g.n2 > 0, 'есть и вердикты OK, и тревоги');
  assert.ok(10000 * g.k1 <= 500 * g.n1, `FRR ${g.frr_bp} bp`);
  assert.ok(10000 * g.k2 <= 5000 * g.n2, `cry-wolf ${g.cry_wolf_bp} bp`);
  assert.deepEqual(g.reasons, []);
  assert.equal(g.pass, true);
  // зафиксированные счётчики корпуса (замок: сдвиг означает изменение генератора или арифметики движка)
  assert.deepEqual([g.k1, g.n1, g.k2, g.n2], [1, 117, 7, 18]);
  for (const r of reports) assert.equal(r.skipped_origins, 0);
});

test('TST-55 гейт релиза на СИНТЕТИЧЕСКИХ «стресс»-журналах (10 шт., клиент платит на 30–60 дней позже): FRR > 5 % — гейт не проходит', (t) => {
  const reports = corpus_reports('stress', stress_corpus());
  const g = bt.release_gate(reports);
  t.diagnostic(`stress: журналов ${g.n_journals}, FRR ${g.k1}/${g.n1} = ${g.frr_bp} bp, cry-wolf ${g.k2}/${g.n2} = ${g.cry_wolf_bp} bp`);
  assert.equal(reports.length, 10);
  assert.equal(g.pass, false);
  assert.deepEqual(g.reasons, ['frr_above_5pct'], 'ложное спокойствие: «выдерживает» с последующим пробоем буфера');
  assert.deepEqual([g.k1, g.n1, g.k2, g.n2], [7, 32, 3, 72]);
  assert.ok(g.cry_wolf_bp <= 5000, 'тревог зря мало: клиент действительно опаздывает');
});

test('TST-55 гейт: отчёты по журналам сохраняют сумму счётчиков; перестановка журналов результат не меняет', () => {
  const reports = corpus_reports('regular', regular_corpus());
  const g = bt.release_gate(reports);
  const sum = (f) => reports.reduce((s, r) => s + f(r), 0);
  assert.equal(g.k1, sum((r) => r.frr.k));
  assert.equal(g.n1, sum((r) => r.frr.n));
  assert.equal(g.k2, sum((r) => r.cry_wolf.k));
  assert.equal(g.n2, sum((r) => r.cry_wolf.n));
  assert.deepEqual(bt.release_gate([...reports].reverse()), g);
  // 11 из 12 журналов — гейт тот же вердикт, 9 из 12 — «журналов меньше 10»
  assert.equal(bt.release_gate(reports.slice(0, 10)).n_journals, 10);
  assert.deepEqual(bt.release_gate(reports.slice(0, 9)).reasons, ['journals_lt_10']);
});

// ── TST-60: слои модулей и чистота (B4) ───────────────────────────────────────────────────────────────────────────────

const src = (name) => fs.readFileSync(new URL(name, ENGINE), 'utf8');
const imports_of = (name) => [...src(name).matchAll(/from\s+'\.\/([a-z0-9_]+)\.mjs'/g)].map((m) => m[1]);

test('TST-60 слои §14 B4: backtest зависит от index, afford, ledger, calibration и нижележащих — не от tools/verifier/montecarlo; ни один модуль ниже index не импортирует backtest', () => {
  const allowed = new Set(['money', 'dates', 'recurrence', 'hourly', 'fx', 'tax', 'debt', 'calibration', 'timeline', 'sinking', 'waves', 'afford', 'index', 'ledger', 'param_defaults']); // FP-17 (REQ-019): умолчания читаются из словаря через param_defaults (низший слой)
  const deps = [...new Set(imports_of('backtest.mjs'))];
  assert.deepEqual(deps.filter((d) => !allowed.has(d)), []);
  for (const need of ['index', 'afford', 'ledger']) assert.ok(deps.includes(need), `backtest.mjs использует ${need}`);
  assert.ok(!deps.includes('tools') && !deps.includes('verifier') && !deps.includes('montecarlo'));
  const files = fs.readdirSync(ENGINE).filter((f) => f.endsWith('.mjs'));
  for (const f of files) {
    if (f === 'backtest.mjs') continue;
    assert.ok(!imports_of(f).includes('backtest'), `${f} не импортирует backtest (цикл index → backtest запрещён)`);
  }
  // montecarlo: от timeline, sinking, afford, calibration (и ниже); не от index, ledger, backtest
  const mc_allowed = new Set(['money', 'dates', 'recurrence', 'hourly', 'fx', 'tax', 'debt', 'calibration', 'timeline', 'sinking', 'afford']);
  assert.deepEqual([...new Set(imports_of('montecarlo.mjs'))].filter((d) => !mc_allowed.has(d)), []);
  assert.ok(!imports_of('montecarlo.mjs').includes('index'));
});

test('TST-60 B4: backtest/release_gate/default_breach вынесены из calibration; calibration не зависит от timeline/index; index их не реэкспортирует', () => {
  for (const name of ['backtest', 'release_gate', 'default_breach', 'state_at']) assert.ok(!(name in calibration), `calibration.${name} удалён`);
  for (const name of ['backtest', 'release_gate', 'default_breach']) assert.equal(typeof bt[name], 'function');
  assert.deepEqual([...new Set(imports_of('calibration.mjs'))].sort(), ['dates', 'money', 'param_defaults']); // FP-17: умолчания калибровки — из словаря; выше, чем dates и money, calibration по-прежнему ничего не импортирует
  assert.ok(!/export\s+\*\s+from\s+'\.\/backtest\.mjs'/.test(src('index.mjs')));
});

test('TST-60 чистота montecarlo.mjs и backtest.mjs: нет Date, Math.random, fetch, process, require, node:*, Intl, таймеров, fs', () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1 ').replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');
  const forbidden = [/\bDate\b/, /\bMath\s*\.\s*random\b/, /\bfetch\b/, /\bprocess\b/, /\brequire\s*\(/, /\bnode:/, /\bIntl\b/, /\b(?:setTimeout|setInterval|performance)\b/, /\bfs\b\s*\./, /\bMath\s*\.\s*round\s*\(\s*[^()]*\*\s*100\b/];
  for (const f of ['montecarlo.mjs', 'backtest.mjs']) {
    const code = strip(src(f));
    for (const re of forbidden) assert.ok(!re.test(code), `${f}: ${re}`);
  }
  // импорты — только относительные ./имя.mjs
  for (const f of ['montecarlo.mjs', 'backtest.mjs']) {
    for (const m of src(f).matchAll(/from\s+'([^']+)'/g)) assert.match(m[1], /^\.\/[a-z0-9_]+\.mjs$/, `${f}: ${m[1]}`);
  }
});

test('TST-60 параметры backtest совпадают с vocab.json: backtest.h_days = 30, backtest.min_window_days = 14, calib.min_origins = 3 (гипотезы)', () => {
  const vocab = JSON.parse(src('vocab.json'));
  assert.equal(vocab.params['backtest.h_days'].default, bt.BACKTEST_DEFAULTS['backtest.h_days']);
  assert.equal(vocab.params['backtest.min_window_days'].default, bt.BACKTEST_DEFAULTS['backtest.min_window_days']);
  assert.equal(vocab.params['calib.min_origins'].default, bt.BACKTEST_DEFAULTS['calib.min_origins']);
  assert.equal(vocab.params['backtest.h_days'].hypothesis, true);
});
