// debt_forecast.test.mjs — FP-14 (движок): долг, записанный в прогноз (engine/debt_ext.mjs, debt.schedule_to_events с extra_minor, timeline: W_DEBT_BEYOND_HORIZON).
// Покрывает: REQ-082 (сохранённый график, платежи входят в «свободно», перенос строки), REQ-083 (досрочное погашение и ре-якорение, записанные в график и в ряд),
// REQ-019 (умолчание допуска дрейфа сверено с vocab.json), REQ-017 (validate_ws.debts: E_CURRENCY_MISMATCH и ограничения графика), TST-29, TST-30, TST-51, TST-53.
// Числа выведены из канона (REQ-082: A = 20706, платежи [20706 ×5, 20705], Σ 124235; ALG-09 TV-5 и TV-6), а не из вывода проверяемого кода.
// Набор data/g001-debt.json = G-001 + одна запись долга D-LOAN (1 200,00 € под 12 % на 6 платежей с 2026-11-05); горизонт G-001 — 57 дней, до 2026-11-30.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/debt_forecast.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyze, canon, format_date, parse_date, prepay, reanchor, schedule_to_events } from '../engine/index.mjs';
import {
  DEBT_DEFAULTS, HISTORY_MAX, drift_tol_bp, rounding_of, rows_of, stored_rows, build_debt_record, move_row_date, apply_prepay, apply_reanchor, rows_totals,
  beyond_horizon_payments, debt_status,
} from '../engine/debt_ext.mjs';
import { EXT_WARNING_CODES, is_ext_warning, ext_warning_text } from '../engine/warnings_ext.mjs';
import { validate_ws } from '../engine/validate_ws.mjs';
import { throws_code, make_rng } from './helpers.mjs';

const DATA = new URL('../data/', import.meta.url);
const load = (name) => JSON.parse(fs.readFileSync(new URL(name, DATA), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const deep_freeze = (x) => { if (x !== null && typeof x === 'object') { Object.freeze(x); for (const v of Object.values(x)) deep_freeze(v); } return x; };
const G = load('g001.json');
const GD = load('g001-debt.json');
const SPEC = { debt_id: 'D-LOAN', name: 'Кредит на технику', pay_account_id: 'acc_main', currency: 'EUR', kind: 'annuity', principal_minor: 120000, rate_bp: 1200, n: 6, start_date: '2026-11-05' };
const AS_OF = '2026-10-04';
const run = (ws, o = {}) => analyze(ws, { as_of: ws.as_of, ...o });
const day = (iso) => parse_date(iso);
const payments = (rec) => rec.schedule.map((r) => r.payment_minor);
/** Набор с долгом и длинным горизонтом: все шесть платежей (до 2027-04-05) внутри ряда. */
const long_ws = (debt) => ({ ...clone(G), params: { ...G.params, horizon_days: 200 }, debts: [debt] });
const free_last = (a, mode = 'plan') => a.series[mode].free.at(-1);

// ═══ набор данных g001-debt.json ══════════════════════════════════════════════════════════════════════════════════════

test('REQ-082 g001-debt.json — это G-001 плюс одна запись долга из build_debt_record; остальные корзины и параметры G-001 не тронуты', () => {
  const { workspace_id: _a, name: _b, debts, ...rest } = GD;
  const { workspace_id: _c, name: _d, debts: g_debts, ...g_rest } = G;
  assert.deepEqual(g_debts, []);
  assert.deepEqual(rest, g_rest, 'всё, кроме идентификатора, названия и долгов, как в g001.json');
  assert.deepEqual(debts, [build_debt_record(SPEC)]);
  assert.equal(GD.workspace_id, 'ws-g001-debt');
  assert.equal(validate_ws(GD).ok, true, JSON.stringify(validate_ws(GD).errors));
});

// ═══ REQ-082: график, сохранённый в записи ═══════════════════════════════════════════════════════════════════════════

test('TST-29 REQ-082 build_debt_record: 1 200,00 € под 12 % на 6 платежей — платежи [20706 ×5, 20705], проценты 1200/1005/808/609/408/205, остатки 100494…0; даты ISO без сдвига выходных', () => {
  const rec = build_debt_record(SPEC);
  assert.deepEqual(payments(rec), [20706, 20706, 20706, 20706, 20706, 20705]);
  assert.deepEqual(rec.schedule.map((r) => r.interest_minor), [1200, 1005, 808, 609, 408, 205]);
  assert.deepEqual(rec.schedule.map((r) => r.balance_minor), [100494, 80793, 60895, 40798, 20500, 0]);
  assert.deepEqual(rec.schedule.map((r) => r.date), ['2026-11-05', '2026-12-05', '2027-01-05', '2027-02-05', '2027-03-05', '2027-04-05']);
  assert.deepEqual(rec.schedule.map((r) => r.k), [1, 2, 3, 4, 5, 6]);
  assert.equal(rec.schedule.reduce((s, r) => s + r.payment_minor, 0), 124235, 'Σ платежей = долг + проценты');
  assert.deepEqual([rec.n, rec.start_date, rec.principal_minor, rec.kind, rec.rounding, rec.currency], [6, '2026-11-05', 120000, 'annuity', 'half_even', 'EUR']);
  assert.equal(rec.history, undefined, 'история появляется с первой правкой');
  assert.ok(rec.schedule.every((r) => Object.keys(r).sort().join() === 'balance_minor,date,interest_minor,k,payment_minor,principal_minor'), 'в строке только поля канона C-039');
  // сохранённый график — то же, что расчёт по условиям записи
  const terms = { ...rec }; delete terms.schedule;
  assert.deepEqual(stored_rows(rows_of(terms)), rec.schedule);
});

test('TST-29 REQ-082 аннуитет под 0 % записывается как installment_0; дифференцированный и рассрочка закрываются в 0; ограничения графика C-041 — E_SCHEMA с причиной', () => {
  assert.equal(build_debt_record({ ...SPEC, rate_bp: 0 }).kind, 'installment_0');
  const diff = build_debt_record({ ...SPEC, kind: 'differential' });
  assert.deepEqual(payments(diff), [21200, 21000, 20800, 20600, 20400, 20200]);
  assert.equal(diff.schedule.at(-1).balance_minor, 0);
  const inst = build_debt_record({ ...SPEC, kind: 'installment_0', rate_bp: 0 });
  assert.equal(inst.schedule.reduce((s, r) => s + r.payment_minor, 0), 120000);
  const reason = (spec) => { try { build_debt_record(spec); } catch (e) { return [e.code, e.ctx.reason]; } return null; };
  assert.deepEqual(reason({ ...SPEC, principal_minor: 5 }), ['E_SCHEMA', 'principal_lt_n']);
  assert.deepEqual(reason({ ...SPEC, n: 0 }), ['E_SCHEMA', 'n_out_of_1_600']);
  assert.deepEqual(reason({ ...SPEC, n: 601, principal_minor: 10 ** 7 }), ['E_SCHEMA', 'n_out_of_1_600']);
  assert.deepEqual(reason({ ...SPEC, rate_bp: 100001 }), ['E_SCHEMA', 'rate_bp_out_of_0_100000']);
  assert.deepEqual(reason({ ...SPEC, kind: 'installment_0' }), ['E_SCHEMA', 'installment_needs_zero_rate']);
  assert.deepEqual(reason({ ...SPEC, kind: 'взрыв' }), ['E_SCHEMA', 'unknown_debt_kind']);
  throws_code(() => build_debt_record({ ...SPEC, principal_minor: 1200.5 }), 'E_NOT_INTEGER');
  throws_code(() => build_debt_record({ ...SPEC, start_date: '2026-02-30' }), 'E_BAD_DATE');
});

test('REQ-082 платёж долга меняет «свободно» в ряду на сумму платежа: G-001 + D-LOAN, горизонт 57 дн. — с 2026-11-05 минус 20706 в обоих режимах; до платежа ряды совпадают; golden G-001 не затронут', () => {
  const base = run(G);
  const withd = run(GD);
  assert.equal(base.horizon_end, withd.horizon_end);
  assert.deepEqual([Math.min(...base.series.plan.free), Math.min(...base.series.worse.free)], [93500, 71000], 'числа G-001 прежние');
  for (const mode of ['plan', 'worse']) {
    const diff = withd.series[mode].free.map((x, i) => x - base.series[mode].free[i]);
    const from = day('2026-11-05') - base.as_of;
    assert.ok(diff.slice(0, from).every((d) => d === 0), mode + ': до платежа без изменений');
    assert.ok(diff.slice(from).every((d) => d === -20706), mode + ': с 5 ноября свободно меньше на платёж');
    assert.equal(withd.series[mode].trough[from] - base.series[mode].trough[from], -20706);
  }
  assert.equal(Math.min(...withd.series.plan.free), 93500 - 20706);
  assert.equal(Math.min(...withd.series.worse.free), 71000 - 20706);
  const ev = withd.events.plan.filter((e) => e.cash_event_id.startsWith('D-LOAN@'));
  assert.deepEqual(ev.map((e) => [format_date(e.date), e.amount_minor, e.is_obligation, e.tag]), [['2026-11-05', -20706, true, 'debt']]);
  assert.ok(!base.warnings.some((w) => w.code === 'W_DEBT_BEYOND_HORIZON'), 'у G-001 долгов нет — предупреждения нет');
});

test('REQ-082 платежи долга в обоих режимах не сдвигаются «если хуже» (обязательство): дата платежа та же, что в плане', () => {
  const a = run(GD);
  const plan = a.events.plan.find((e) => e.cash_event_id === 'D-LOAN@2026-11-05');
  const worse = a.events.worse.find((e) => e.cash_event_id === 'D-LOAN@2026-11-05');
  assert.equal(plan.date, worse.date);
  assert.equal(plan.amount_minor, worse.amount_minor);
});

// ═══ W_DEBT_BEYOND_HORIZON ═══════════════════════════════════════════════════════════════════════════════════════════

test('REQ-082 W_DEBT_BEYOND_HORIZON: платежи за горизонтом не отбрасываются молча — по долгу число 5, сумма 103529, валюта; то же даёт beyond_horizon_payments', () => {
  const a = run(GD);
  const w = a.warnings.filter((x) => x.code === 'W_DEBT_BEYOND_HORIZON');
  assert.deepEqual(w, [{ code: 'W_DEBT_BEYOND_HORIZON', debt_id: 'D-LOAN', count: 5, total_minor: 103529, currency: 'EUR' }]);
  const rec = GD.debts[0];
  assert.deepEqual(beyond_horizon_payments(rec, a.horizon_end), { count: 5, total_minor: 103529, first_date: '2026-12-05' });
  assert.equal(124235 - 103529, 20706, 'внутри горизонта один платёж');
  // горизонт длиннее графика — предупреждения нет; ровно до последнего платежа — тоже
  assert.ok(!run(long_ws(rec)).warnings.some((x) => x.code === 'W_DEBT_BEYOND_HORIZON'));
  const exact = run(GD, { horizon_end: '2027-04-05' });
  assert.ok(!exact.warnings.some((x) => x.code === 'W_DEBT_BEYOND_HORIZON'), 'платёж в последний день горизонта входит в ряд');
  const short = run(GD, { horizon_end: '2027-04-04' });
  assert.deepEqual(short.warnings.filter((x) => x.code === 'W_DEBT_BEYOND_HORIZON').map((x) => [x.count, x.total_minor]), [[1, 20705]], 'на день короче — последний платёж за горизонтом');
});

test('REQ-082 W_DEBT_BEYOND_HORIZON: служебный код расширения (вне vocab.json), текст RU и EN, поля; два долга — два предупреждения; одно на режим (без дублей)', () => {
  const vocab = load('../engine/vocab.json');
  assert.ok(Object.hasOwn(EXT_WARNING_CODES, 'W_DEBT_BEYOND_HORIZON'));
  assert.ok(!Object.hasOwn(vocab.warning_codes, 'W_DEBT_BEYOND_HORIZON'), 'реестр vocab.json закрыт (К-39)');
  assert.ok(is_ext_warning('W_DEBT_BEYOND_HORIZON'));
  assert.deepEqual([...EXT_WARNING_CODES.W_DEBT_BEYOND_HORIZON.fields], ['debt_id', 'count', 'total_minor', 'currency']);
  assert.match(ext_warning_text('W_DEBT_BEYOND_HORIZON', 'ru'), /за горизонтом/);
  assert.match(ext_warning_text('W_DEBT_BEYOND_HORIZON', 'en'), /beyond the forecast horizon/);
  const two = { ...clone(GD), debts: [GD.debts[0], build_debt_record({ ...SPEC, debt_id: 'D-TWO', start_date: '2026-11-20', n: 3, principal_minor: 30000, rate_bp: 0, kind: 'installment_0' })] };
  const w = run(two).warnings.filter((x) => x.code === 'W_DEBT_BEYOND_HORIZON');
  assert.deepEqual(w.map((x) => [x.debt_id, x.count]).sort(), [['D-LOAN', 5], ['D-TWO', 2]], 'по предупреждению на долг, в обоих режимах один раз');
});

test('REQ-082 прошедшие строки графика (дата раньше начала окна плана) за горизонтом не считаются: предупреждения нет, в ряд входят только строки впереди', () => {
  const ws = {
    ...clone(G), as_of: '2027-01-10', debts: [REC], params: { ...G.params, horizon_days: 120 },
    anchors: [...G.anchors, { anchor_id: 'anc-x', account_id: 'acc_main', date: '2027-01-10', amount_minor: 300000 }],
  };
  const a = run(ws);
  assert.ok(!a.warnings.some((x) => x.code === 'W_DEBT_BEYOND_HORIZON'), JSON.stringify(a.warnings));
  assert.deepEqual(a.events.plan.filter((e) => e.tag === 'debt').map((e) => format_date(e.date)), ['2027-02-05', '2027-03-05', '2027-04-05']);
});

// ═══ REQ-083: досрочное погашение, записанное в график ═══════════════════════════════════════════════════════════════

const REC = build_debt_record(SPEC);
const PP = { date: '2026-12-05', amount_minor: 30000, as_of: AS_OF };

test('TST-29 REQ-083 apply_prepay shorten: 300,00 € после платежа 2 — 5 строк, платёж прежний 20706, проценты хвоста 916/613/306…, последняя строка 10297; extra_minor и остаток строки 2 записаны', () => {
  const d = apply_prepay(REC, { ...PP, option: 'shorten' });
  assert.deepEqual(d.schedule.map((r) => [r.k, r.date, r.payment_minor, r.balance_minor]), [
    [1, '2026-11-05', 20706, 100494], [2, '2026-12-05', 20706, 50793], [3, '2027-01-05', 20706, 30595], [4, '2027-02-05', 20706, 10195], [5, '2027-03-05', 10297, 0],
  ]);
  assert.equal(d.schedule[1].extra_minor, 30000);
  assert.equal(d.schedule.filter((r) => r.extra_minor !== undefined).length, 1);
  assert.deepEqual([d.n, d.start_date], [5, '2026-11-05']);
  assert.deepEqual(d.history, [{ kind: 'prepay', k: 2, date: '2026-12-05', amount_minor: 30000, option: 'shorten', on: AS_OF }]);
  // инвариант ALG-09: платежи + внесённое = долг + проценты
  const interest = d.schedule.reduce((s, r) => s + r.interest_minor, 0);
  assert.equal(d.schedule.reduce((s, r) => s + r.payment_minor + (r.extra_minor ?? 0), 0), 120000 + interest);
  assert.equal(interest, 1200 + 1005 + 508 + 306 + 102, 'проценты хвоста TV-5: 508/306/102');
  // исходная запись не изменена
  assert.equal(REC.schedule.length, 6);
  assert.equal(REC.history, undefined);
});

test('TST-29 REQ-083 apply_prepay lower_payment: срок прежний (6 строк), платёж ниже 13017, последний 13018; shorten и lower_payment дают разное число платежей при одном остатке', () => {
  const lo = apply_prepay(REC, { ...PP, option: 'lower_payment' });
  const sh = apply_prepay(REC, { ...PP, option: 'shorten' });
  assert.deepEqual(payments(lo), [20706, 20706, 13017, 13017, 13017, 13018]);
  assert.deepEqual(lo.schedule.map((r) => r.balance_minor), [100494, 50793, 38284, 25650, 12889, 0]);
  assert.notEqual(lo.schedule.length, sh.schedule.length);
  assert.equal(lo.schedule[1].balance_minor, sh.schedule[1].balance_minor, 'остаток после внесения один и тот же');
  assert.equal(lo.schedule.reduce((s, r) => s + r.interest_minor, 0), 1200 + 1005 + 508 + 383 + 256 + 129, 'проценты хвоста TV-5: 508/383/256/129');
});

test('TST-29 REQ-083 apply_prepay совпадает с prepay ядра на свежем графике: те же даты, платежи, проценты и части долга всех строк, остатки хвоста', () => {
  const terms = { debt_id: 'T', pay_account_id: 'acc_main', currency: 'EUR', kind: 'annuity', principal_minor: 120000, rate_bp: 1200, n: 6, start_date: '2026-11-05' };
  for (const option of ['shorten', 'lower_payment']) {
    const core = prepay(terms, 30000, day('2026-12-05'), option);
    const mine = apply_prepay(REC, { ...PP, option }).schedule;
    assert.equal(mine.length, core.length, option);
    core.forEach((r, i) => {
      assert.deepEqual([mine[i].date, mine[i].payment_minor, mine[i].interest_minor, mine[i].principal_minor], [format_date(r.date), r.payment_minor, r.interest_minor, r.principal_minor], `${option} строка ${i + 1}`);
      if (i >= 2) assert.equal(mine[i].balance_minor, r.balance_minor, `${option} остаток ${i + 1}`);
    });
    assert.equal(mine[1].balance_minor, core[1].balance_minor - 30000, 'строка погашения: остаток уже без внесённой суммы');
  }
});

test('REQ-083 apply_prepay: второе погашение после «платёж ниже» берёт действующий платёж 13017, а не платёж первой строки; повтор в тот же день складывает extra_minor', () => {
  const lo = apply_prepay(REC, { ...PP, option: 'lower_payment' });
  const again = apply_prepay(lo, { date: '2027-01-05', amount_minor: 10000, option: 'shorten', as_of: AS_OF });
  assert.deepEqual(payments(again), [20706, 20706, 13017, 13017, 13017, 2716], 'платёж остался действующим (13017), а не 20706 первой строки; последний впитал остаток');
  assert.equal(again.schedule[2].extra_minor, 10000);
  assert.equal(again.schedule.at(-1).balance_minor, 0);
  assert.equal(again.history.length, 2);
  const twice = apply_prepay(apply_prepay(REC, { ...PP, amount_minor: 10000, option: 'shorten' }), { ...PP, amount_minor: 5000, option: 'shorten' });
  assert.equal(twice.schedule[1].extra_minor, 15000);
  assert.equal(twice.schedule[1].balance_minor, 80793 - 15000);
});

test('REQ-083 apply_prepay: полное погашение закрывает долг (график кончается строкой погашения, остаток 0); не в день платежа, на последнем платеже, 0 и больше остатка — E_SCHEMA с причиной', () => {
  const full = apply_prepay(REC, { date: '2026-12-05', amount_minor: 80793, option: 'shorten', as_of: AS_OF });
  assert.deepEqual([full.n, full.schedule.at(-1).balance_minor, full.schedule.at(-1).extra_minor], [2, 0, 80793]);
  assert.deepEqual(schedule_to_events(full).map((e) => [e.cash_event_id, e.amount_minor]), [
    ['D-LOAN@2026-11-05', -20706], ['D-LOAN@2026-12-05', -20706], ['D-LOAN@2026-12-05#extra', -80793],
  ]);
  const why = (args) => { try { apply_prepay(REC, { ...PP, option: 'shorten', ...args }); } catch (e) { return [e.code, e.ctx.reason]; } return null; };
  assert.deepEqual(why({ date: '2026-12-06' }), ['E_SCHEMA', 'prepay_only_on_payment_date_before_last']);
  assert.deepEqual(why({ date: '2027-04-05' }), ['E_SCHEMA', 'prepay_only_on_payment_date_before_last']);
  assert.deepEqual(why({ amount_minor: 0 }), ['E_SCHEMA', 'prepay_amount_out_of_range']);
  assert.deepEqual(why({ amount_minor: 80794 }), ['E_SCHEMA', 'prepay_amount_out_of_range']);
  assert.deepEqual(why({ option: 'как-нибудь' }), ['E_SCHEMA', 'unknown_prepay_option']);
  throws_code(() => apply_prepay(REC, { ...PP, amount_minor: 1.5, option: 'shorten' }), 'E_NOT_INTEGER');
  // действующий платёж (первой строки после погашения) меньше процентов хвоста (запись из чужого файла) — отказ ядра с причиной, а не бесконечный или нулевой график
  // (после исправления дефекта «срок короче удлиняет график» «платёж прежний» берётся у первой пересчитываемой строки, а не у оплаченной строки погашения)
  const odd = clone(REC); odd.schedule[2].payment_minor = 100;
  try { apply_prepay(odd, { ...PP, option: 'shorten' }); assert.fail('ожидался отказ'); } catch (e) { assert.deepEqual([e.code, e.ctx.reason], ['E_SCHEMA', 'payment_does_not_cover_interest']); }
});

test('REQ-083 досрочное погашение в ряду «свободно»: внесённая сумма уходит со счёта в день платежа отдельным обязательством #extra; конец ряда выше только на сэкономленные проценты (1114 и 754)', () => {
  const base = run(long_ws(REC));
  const sh = run(long_ws(apply_prepay(REC, { ...PP, option: 'shorten' })));
  const lo = run(long_ws(apply_prepay(REC, { ...PP, option: 'lower_payment' })));
  assert.equal(free_last(sh) - free_last(base), 1114, 'без extra разница была бы 31114: деньги, внесённые досрочно, не пропадают из прогноза');
  assert.equal(free_last(lo) - free_last(base), 754);
  const i = day('2026-12-05') - base.as_of;
  assert.equal(sh.series.plan.free[i] - base.series.plan.free[i], -30000, 'в день погашения свободно меньше на внесённую сумму');
  assert.equal(sh.series.plan.free[i - 1], base.series.plan.free[i - 1]);
  const ev = sh.events.plan.filter((e) => e.cash_event_id.startsWith('D-LOAN@2026-12-05'));
  assert.deepEqual(ev.map((e) => [e.cash_event_id, e.amount_minor, e.is_obligation]), [['D-LOAN@2026-12-05#extra', -30000, true], ['D-LOAN@2026-12-05', -20706, true]], 'порядок событий дня — по сумме, затем по идентификатору');
  // сумма расходов по долгу = платежи + внесённое
  assert.equal(sh.events.plan.filter((e) => e.tag === 'debt').reduce((s, e) => s - e.amount_minor, 0), 123121);
});

test('REQ-083 досрочное в день за горизонтом: W_DEBT_BEYOND_HORIZON считает и платежи, и внесённую сумму (число событий и сумма совпадают с beyond_horizon_payments)', () => {
  const d = apply_prepay(REC, { ...PP, option: 'shorten' });
  const a = run({ ...clone(GD), debts: [d] });
  const w = a.warnings.find((x) => x.code === 'W_DEBT_BEYOND_HORIZON');
  const b = beyond_horizon_payments(d, a.horizon_end);
  assert.deepEqual([w.count, w.total_minor], [b.count, b.total_minor]);
  assert.deepEqual([w.count, w.total_minor], [5, 20706 * 3 + 10297 + 30000]);
});

test('REQ-083 extra_minor в строке графика: нецелое — E_NOT_INTEGER в schedule_to_events и в validate_ws; без extra_minor строка ведёт себя как прежде', () => {
  const bad = clone(REC); bad.schedule[1].extra_minor = 10.5;
  throws_code(() => schedule_to_events(bad), 'E_NOT_INTEGER');
  assert.equal(validate_ws({ ...clone(GD), debts: [bad] }).ok, false);
  assert.ok(validate_ws({ ...clone(GD), debts: [bad] }).errors.some((e) => e.code === 'E_NOT_INTEGER'));
  assert.equal(schedule_to_events(REC).length, 6);
  assert.deepEqual(schedule_to_events(REC).map((e) => e.cash_event_id), REC.schedule.map((r) => 'D-LOAN@' + r.date));
});

// ═══ REQ-083: ре-якорение по факту, записанное в график ═══════════════════════════════════════════════════════════════

const RA = { k: 2, observed_minor: 80900, as_of: AS_OF };

test('TST-29 REQ-083 apply_reanchor: после платежа 2 банк показал 809,00 € против модельных 807,93 € — дрейф +107, остаток строки 2 = наблюдаемому, хвост 4 платежа по 20733 (последний 20734)', () => {
  const r = apply_reanchor(REC, RA);
  assert.deepEqual([r.drift_minor, r.modeled_minor], [107, 80793]);
  assert.deepEqual(payments(r.debt), [20706, 20706, 20733, 20733, 20733, 20734]);
  assert.deepEqual(r.debt.schedule.map((x) => x.balance_minor), [100494, 80900, 60976, 40853, 20529, 0]);
  assert.deepEqual(r.debt.history, [{ kind: 'reanchor', k: 2, date: '2026-12-05', observed_minor: 80900, drift_minor: 107, on: AS_OF }]);
  // хвост — ровно то, что вернуло ядро
  const core = reanchor({ ...REC, schedule: undefined, principal_minor: 120000, n: 6, start_date: '2026-11-05' }, 2, 80900);
  assert.equal(core.drift, 107);
  core.schedule.slice(2).forEach((row, i) => assert.deepEqual([r.debt.schedule[i + 2].date, r.debt.schedule[i + 2].payment_minor, r.debt.schedule[i + 2].interest_minor], [format_date(row.date), row.payment_minor, row.interest_minor]));
  // «сумма платежей хвоста всегда равна остатку плюс проценты»
  const tail = r.debt.schedule.slice(2);
  assert.equal(tail.reduce((s, x) => s + x.payment_minor, 0), 80900 + tail.reduce((s, x) => s + x.interest_minor, 0));
  assert.equal(r.debt.n, 6, 'срок не меняется');
});

test('REQ-083 сквозной тест: после ре-якорения «свободно» считается по новому хвосту — на 2027-01-05 минус 27 (20733 против 20706), в конце ряда минус 110 (Σ хвоста 82933 против 82823)', () => {
  const base = run(long_ws(REC));
  const re = run(long_ws(apply_reanchor(REC, RA).debt));
  const idx = (iso) => day(iso) - base.as_of;
  const diff = (i) => re.series.plan.free[i] - base.series.plan.free[i];
  assert.equal(diff(idx('2026-12-05')), 0, 'выполненные строки не меняются');
  assert.equal(diff(idx('2027-01-04')), 0);
  assert.equal(diff(idx('2027-01-05')), -27);
  assert.equal(diff(idx('2027-02-05')), -54);
  assert.equal(free_last(re) - free_last(base), -110);
  assert.equal(free_last(re, 'worse') - free_last(base, 'worse'), -110);
  assert.notEqual(run(long_ws(apply_reanchor(REC, RA).debt)).inputs_hash, base.inputs_hash, 'хэш входов видит новый график');
});

test('REQ-083 apply_reanchor: остаток 0 закрывает долг; k вне 1…n, отрицательный остаток, остаток после последнего платежа и досрочное в заменяемом хвосте — E_SCHEMA вместо молчаливой потери', () => {
  const closed = apply_reanchor(REC, { ...RA, observed_minor: 0 });
  assert.deepEqual([closed.debt.n, closed.debt.schedule.at(-1).balance_minor, closed.drift_minor], [2, 0, -80793]);
  const why = (d, args) => { try { apply_reanchor(d, { ...RA, ...args }); } catch (e) { return [e.code, e.ctx.reason]; } return null; };
  assert.deepEqual(why(REC, { k: 0 }), ['E_SCHEMA', 'k_out_of_1_n']);
  assert.deepEqual(why(REC, { k: 7 }), ['E_SCHEMA', 'k_out_of_1_n']);
  assert.deepEqual(why(REC, { observed_minor: -1 }), ['E_SCHEMA', 'observed_negative']);
  assert.deepEqual(why(REC, { k: 6, observed_minor: 100 }), ['E_SCHEMA', 'balance_after_last_payment']);
  assert.equal(why(REC, { k: 6, observed_minor: 0 }), null, 'после последнего платежа остаток 0 — просто сверка');
  const pre = apply_prepay(REC, { ...PP, option: 'shorten' });
  assert.deepEqual(why(pre, { k: 1, observed_minor: 100494 }), ['E_SCHEMA', 'planned_prepay_after_k']);
  assert.equal(why(pre, { k: 2, observed_minor: 50793 }), null, 'сверка на самом платеже погашения допустима');
  assert.equal(why(pre, { k: 3, observed_minor: 30595 }), null);
  throws_code(() => apply_reanchor(REC, { ...RA, observed_minor: 80900.5 }), 'E_NOT_INTEGER');
  // маленький остаток при большом числе оставшихся платежей: хвост не строится (ограничение P ≥ n)
  assert.deepEqual(why(REC, { k: 1, observed_minor: 3 }), ['E_SCHEMA', 'principal_lt_n']);
});

test('REQ-083 apply_reanchor после досрочного: остаток строки погашения — основа сверки, extra_minor выполненных строк сохраняется', () => {
  const pre = apply_prepay(REC, { ...PP, option: 'shorten' });
  const r = apply_reanchor(pre, { k: 3, observed_minor: 30600, as_of: AS_OF });
  assert.equal(r.modeled_minor, 30595);
  assert.equal(r.drift_minor, 5);
  assert.equal(r.debt.schedule[1].extra_minor, 30000);
  assert.equal(r.debt.schedule[2].balance_minor, 30600);
  assert.equal(r.debt.schedule.length, 5);
});

// ═══ REQ-082: перенос даты строки графика ════════════════════════════════════════════════════════════════════════════

test('REQ-082 move_row_date: платёж 2 переносится с 5 на 7 декабря — сумма та же, сдвиг выходных не применяется, событие и ряд меняют дату; в истории — откуда и куда', () => {
  const d = move_row_date(REC, 2, '2026-12-07', AS_OF);
  assert.equal(d.schedule[1].date, '2026-12-07');
  assert.equal(d.schedule[1].payment_minor, 20706);
  assert.deepEqual(d.schedule.map((r, i) => (i === 1 ? null : r)).filter(Boolean), REC.schedule.filter((_, i) => i !== 1), 'остальные строки те же');
  assert.deepEqual(d.history, [{ kind: 'move', k: 2, from: '2026-12-05', to: '2026-12-07', on: AS_OF }]);
  assert.equal(REC.schedule[1].date, '2026-12-05', 'исходная запись не изменена');
  const a = run(long_ws(d));
  const e = a.events.plan.find((x) => x.cash_event_id === 'D-LOAN@2026-12-07');
  assert.equal(format_date(e.date), '2026-12-07');
  assert.ok(!a.events.plan.some((x) => x.cash_event_id === 'D-LOAN@2026-12-05'));
  const base = run(long_ws(REC));
  const i5 = day('2026-12-05') - base.as_of;
  assert.equal(a.series.plan.free[i5] - base.series.plan.free[i5], 20706, '5 декабря платежа уже нет');
  assert.equal(a.series.plan.free[i5 + 2] - base.series.plan.free[i5 + 2], 0, 'с 7 декабря снова вместе');
  assert.equal(free_last(a), free_last(base), 'итог не меняется: платёж лишь передвинут');
});

test('REQ-082 move_row_date: дата не раньше сегодня, строго позже предыдущего платежа и раньше следующего, не та же; нет строки — отказ с причиной; выходной день не сдвигается', () => {
  const why = (k, date, as_of = AS_OF) => { try { move_row_date(REC, k, date, as_of); } catch (e) { return [e.code, e.ctx.reason]; } return null; };
  assert.deepEqual(why(2, '2026-10-03'), ['E_BAD_DATE', 'row_date_before_as_of']);
  assert.deepEqual(why(2, '2026-11-05'), ['E_SCHEMA', 'row_date_not_after_previous']);
  assert.deepEqual(why(2, '2027-01-05'), ['E_SCHEMA', 'row_date_not_before_next']);
  assert.deepEqual(why(2, '2026-12-05'), ['E_SCHEMA', 'row_date_unchanged']);
  assert.deepEqual(why(0, '2026-12-07'), ['E_SCHEMA', 'row_out_of_range']);
  assert.deepEqual(why(7, '2026-12-07'), ['E_SCHEMA', 'row_out_of_range']);
  assert.equal(why(1, '2026-10-04'), null, 'первая строка — можно на сегодня');
  assert.equal(why(6, '2027-12-31'), null, 'последнюю можно сдвигать сколь угодно вперёд');
  throws_code(() => move_row_date(REC, 2, '2026-12-32', AS_OF), 'E_BAD_DATE');
  const sat = move_row_date(REC, 2, '2026-12-06', AS_OF); // суббота
  assert.equal(sat.schedule[1].date, '2026-12-06', 'договорная дата не двигается политикой выходных');
});

// ═══ состояние, история, чистота ═════════════════════════════════════════════════════════════════════════════════════

test('REQ-082 debt_status: остаток по модели на дату, ближайший платёж, платежи впереди, итоги и за горизонтом; после платежей меняется вместе с «Сегодня»', () => {
  const st = debt_status(REC, AS_OF, '2026-11-30');
  assert.deepEqual([st.count, st.past_count, st.outstanding_minor, st.next.k], [6, 0, 120000, 1]);
  assert.deepEqual([st.upcoming.count, st.upcoming.total_minor, st.upcoming.interest_minor, st.upcoming.last_date], [6, 124235, 4235, '2027-04-05']);
  assert.deepEqual(st.beyond, { count: 5, total_minor: 103529, first_date: '2026-12-05' });
  const later = debt_status(REC, '2027-01-10', '2027-04-30');
  assert.deepEqual([later.past_count, later.outstanding_minor, later.next.k, later.upcoming.count, later.beyond.count], [3, 60895, 4, 3, 0]);
  const done = debt_status(REC, '2027-05-01', '2027-12-31');
  assert.deepEqual([done.outstanding_minor, done.next, done.upcoming], [0, null, null]);
  const pre = debt_status(apply_prepay(REC, { ...PP, option: 'shorten' }), AS_OF, '2027-12-31');
  assert.equal(pre.upcoming.extra_minor, 30000);
  assert.equal(rows_totals([]), null);
});

test('TST-53 REQ-083 чистота: apply_prepay, apply_reanchor, move_row_date не меняют вход (в том числе замороженный), повтор даёт побайтно тот же результат', () => {
  const frozen = deep_freeze(clone(REC));
  const a1 = canon(apply_prepay(frozen, { ...PP, option: 'shorten' }));
  const a2 = canon(apply_prepay(frozen, { ...PP, option: 'shorten' }));
  assert.equal(a1, a2);
  assert.equal(canon(apply_reanchor(frozen, RA).debt), canon(apply_reanchor(frozen, RA).debt));
  assert.equal(canon(move_row_date(frozen, 3, '2027-01-07', AS_OF)), canon(move_row_date(frozen, 3, '2027-01-07', AS_OF)));
  assert.equal(canon(frozen), canon(REC));
});

test('REQ-083 история ограничена HISTORY_MAX: старые записи вытесняются, последняя остаётся', () => {
  let d = REC;
  for (let i = 0; i < HISTORY_MAX + 5; i++) d = move_row_date(d, 6, format_date(day('2027-04-05') + i + 1), AS_OF);
  assert.equal(d.history.length, HISTORY_MAX);
  assert.equal(d.history.at(-1).to, format_date(day('2027-04-05') + HISTORY_MAX + 5));
});

test('REQ-083 долг из файла без сохранённого графика (только условия) тоже правится: график материализуется из условий', () => {
  const legacy = { debt_id: 'D-OLD', pay_account_id: 'acc_main', currency: 'EUR', kind: 'annuity', principal_minor: 120000, rate_bp: 1200, n: 6, start_date: '2026-11-05' };
  assert.equal(rows_of(legacy).length, 6);
  const d = apply_prepay(legacy, { ...PP, option: 'shorten' });
  assert.deepEqual(payments(d), [20706, 20706, 20706, 20706, 10297]);
  assert.equal(d.debt_id, 'D-OLD');
  assert.equal(legacy.schedule, undefined);
});

// ═══ REQ-017: validate_ws.debts ═════════════════════════════════════════════════════════════════════════════════════

test('REQ-017 REQ-082 validate_ws.debts: валюта долга ≠ валюте платёжного счёта — E_CURRENCY_MISMATCH (прямой тест; записи с графиком и без)', () => {
  const plain = { debt_id: 'D-USD', pay_account_id: 'acc_main', currency: 'USD', kind: 'installment_0', principal_minor: 1000, rate_bp: 0, n: 2, start_date: '2026-11-01' };
  const r = validate_ws({ ...clone(G), debts: [plain] });
  assert.equal(r.ok, false);
  const e = r.errors.find((x) => x.code === 'E_CURRENCY_MISMATCH');
  assert.ok(e !== undefined, JSON.stringify(r.errors));
  assert.deepEqual([e.kind, e.field, e.reason, e.id], ['debts', 'currency', 'currency_differs_from_account', 'D-USD']);
  const stored = { ...clone(REC), debt_id: 'D-USD2', currency: 'USD' };
  assert.ok(validate_ws({ ...clone(G), debts: [stored] }).errors.some((x) => x.code === 'E_CURRENCY_MISMATCH' && x.id === 'D-USD2'), 'запись со сохранённым графиком проверяется так же');
  assert.equal(validate_ws({ ...clone(G), debts: [REC] }).ok, true);
});

test('REQ-017 REQ-082 validate_ws.debts: платёжный счёт неизвестен, ограничения графика (P < n, n = 0, ставка), дубль debt_id — коды и причины; значения в ошибку не попадают', () => {
  const no_sched = (patch) => { const d = { ...clone(SPEC), ...patch }; return validate_ws({ ...clone(G), debts: [d] }); };
  assert.ok(no_sched({ pay_account_id: 'нет-такого' }).errors.some((e) => e.code === 'E_SCHEMA' && e.kind === 'debts'));
  assert.ok(no_sched({ principal_minor: 5 }).errors.some((e) => e.code === 'E_SCHEMA' && e.reason === 'principal_lt_n'));
  assert.ok(no_sched({ n: 0 }).errors.some((e) => e.code === 'E_SCHEMA' && e.reason === 'n_out_of_1_600'));
  assert.ok(no_sched({ rate_bp: 100001 }).errors.some((e) => e.code === 'E_SCHEMA' && e.reason === 'rate_bp_out_of_0_100000'));
  assert.ok(no_sched({ start_date: '2026-13-01' }).errors.some((e) => e.code === 'E_BAD_DATE'));
  const dup = validate_ws({ ...clone(G), debts: [REC, REC] });
  assert.equal(dup.ok, false);
  assert.ok(!JSON.stringify(no_sched({ principal_minor: 5 }).errors).includes('Кредит на технику'), 'названия долга в ошибке нет');
});

// ═══ REQ-019: умолчание допуска дрейфа ═══════════════════════════════════════════════════════════════════════════════

test('REQ-019 REQ-083 DEBT_DEFAULTS: допуск дрейфа сверен с vocab.json; drift_tol_bp берёт параметр рабочей области (целое ≥ 0), иначе умолчание; rounding_of знает только half_even и half_up', () => {
  const vocab = load('../engine/vocab.json');
  for (const [k, v] of Object.entries(DEBT_DEFAULTS)) {
    assert.ok(Object.hasOwn(vocab.params, k), k);
    assert.deepEqual(vocab.params[k].default, v, k);
  }
  assert.equal(drift_tol_bp(undefined), 50);
  assert.equal(drift_tol_bp(null), 50);
  assert.equal(drift_tol_bp({}), 50);
  assert.equal(drift_tol_bp({ 'debt.drift_tol_bp': 5 }), 5);
  assert.equal(drift_tol_bp({ 'debt.drift_tol_bp': 0 }), 0);
  assert.equal(drift_tol_bp({ 'debt.drift_tol_bp': -1 }), 50);
  assert.equal(drift_tol_bp({ 'debt.drift_tol_bp': 1.5 }), 50);
  assert.equal(drift_tol_bp({ 'debt.drift_tol_bp': '5' }), 50);
  assert.equal(rounding_of({ rounding: 'half_up' }), 'half_up');
  for (const r of ['floor', 'ceil', 'half_even', undefined]) assert.equal(rounding_of({ rounding: r }), 'half_even');
  assert.equal(rounding_of(undefined), 'half_even');
  assert.ok(Object.isFrozen(DEBT_DEFAULTS));
});

// ═══ TST-51: свойства на случайных долгах ═══════════════════════════════════════════════════════════════════════════

test('TST-51 REQ-082 REQ-083 свойства: 400 случайных долгов и до пяти случайных правок (перенос, досрочное, ре-якорение) — график всегда закрывается в 0, даты строго по порядку, платёж = часть долга + проценты, Σ(часть долга + внесённое) = долг + Σ дрейфов, платежи и #extra в событиях = Σ графика, область проходит validate_ws', () => {
  const rng = make_rng(1403);
  let applied = 0;
  let refused = 0;
  for (let t = 0; t < 400; t++) {
    const kind = rng.pick(['annuity', 'differential', 'installment_0']);
    const n = rng.int(2, 40);
    const principal = rng.int(n * 100, 4_000_000);
    const rate_bp = kind === 'installment_0' ? 0 : rng.int(50, 9000);
    let debt = build_debt_record({ ...SPEC, kind, n, principal_minor: principal, rate_bp, start_date: format_date(day('2026-10-04') + rng.int(0, 40)) });
    let drift_total = 0;
    const steps = rng.int(1, 5);
    for (let s = 0; s < steps; s++) {
      const rows = rows_of(debt);
      const pick = rng.int(0, 2);
      try {
        if (pick === 0 && rows.length >= 2) {
          const i = rng.int(0, rows.length - 2);
          const amount = rng.int(1, Math.max(1, rows[i].balance_minor));
          debt = apply_prepay(debt, { date: format_date(rows[i].date), amount_minor: amount, option: rng.pick(['shorten', 'lower_payment']), as_of: AS_OF });
        } else if (pick === 1) {
          const i = rng.int(0, rows.length - 1);
          const modeled = rows[i].balance_minor;
          const observed = i === rows.length - 1 ? 0 : (rng.int(0, 9) === 0 ? 0 : Math.max(1, modeled + rng.int(-Math.floor(modeled / 20), Math.floor(modeled / 20))));
          const r = apply_reanchor(debt, { k: i + 1, observed_minor: observed, as_of: AS_OF });
          drift_total += r.drift_minor;
          debt = r.debt;
        } else {
          const i = rng.int(0, rows.length - 1);
          const lo = i === 0 ? day(AS_OF) : rows[i - 1].date + 1;
          const hi = i === rows.length - 1 ? rows[i].date + 60 : rows[i + 1].date - 1;
          debt = move_row_date(debt, i + 1, format_date(rng.int(Math.min(lo, hi), hi)), AS_OF);
        }
        applied += 1;
      } catch (e) {
        assert.equal(e.name, 'RunwayError', 'только коды канона, не необработанные исключения: ' + e);
        assert.ok(['E_SCHEMA', 'E_BAD_DATE'].includes(e.code), e.code);
        refused += 1;
      }
      // инварианты после каждого шага
      const r = debt.schedule;
      assert.equal(debt.n, r.length);
      assert.equal(debt.start_date, r[0].date);
      assert.equal(r.at(-1).balance_minor, 0, `закрывается в 0 (долг #${t})`);
      r.forEach((row, i) => {
        assert.equal(row.k, i + 1);
        assert.equal(row.payment_minor, row.principal_minor + row.interest_minor, 'платёж = часть долга + проценты');
        assert.ok(row.payment_minor >= 0 && row.interest_minor >= 0 && row.principal_minor >= 0 && row.balance_minor >= 0);
        if (i > 0) assert.ok(day(row.date) > day(r[i - 1].date), 'даты строго по порядку');
      });
      const flow = r.reduce((sum, row) => sum + row.principal_minor + (row.extra_minor ?? 0), 0);
      assert.equal(flow, principal + drift_total, `Σ(часть долга + внесённое) = долг + Σ дрейфов (долг #${t}, шаг ${s})`);
      const events = schedule_to_events(debt);
      assert.equal(-events.reduce((sum, e) => sum + e.amount_minor, 0), r.reduce((sum, row) => sum + row.payment_minor + (row.extra_minor ?? 0), 0));
      assert.equal(events.length, r.filter((row) => row.payment_minor > 0).length + r.filter((row) => (row.extra_minor ?? 0) > 0).length);
    }
    if (t % 25 === 0) {
      const v = validate_ws({ ...clone(G), debts: [debt] });
      assert.equal(v.ok, true, JSON.stringify(v.errors));
      assert.doesNotThrow(() => run({ ...clone(G), params: { ...G.params, horizon_days: 400 }, debts: [debt] }));
    }
  }
  assert.ok(applied >= 600, `принято правок: ${applied}, отказов: ${refused}`);
});

test('REQ-083 порядок правок: досрочное или сверка раньше уже записанных досрочного/сверки отвергаются (иначе пересчёт хвоста молча затёр бы их); на том же и более позднем платеже — можно', () => {
  const why = (d, fn) => { try { fn(d); } catch (e) { return [e.code, e.ctx.reason]; } return null; };
  const prepay_at = (date, amount = 5000) => (d) => apply_prepay(d, { date, amount_minor: amount, option: 'shorten', as_of: AS_OF });
  const reanchor_at = (k, observed) => (d) => apply_reanchor(d, { k, observed_minor: observed, as_of: AS_OF });
  // досрочное записано на платеже 3 (2027-01-05)
  const p3 = prepay_at('2027-01-05', 10000)(REC);
  assert.deepEqual(why(p3, prepay_at('2026-12-05')), ['E_SCHEMA', 'later_prepay_exists'], 'раньше записанного досрочного');
  assert.deepEqual(why(p3, prepay_at('2026-11-05')), ['E_SCHEMA', 'later_prepay_exists']);
  assert.equal(why(p3, prepay_at('2027-01-05')), null, 'на том же платеже — добавляется к прежнему');
  assert.equal(why(p3, prepay_at('2027-02-05', 1000)), null, 'позже — можно');
  assert.deepEqual(why(p3, reanchor_at(2, 80793)), ['E_SCHEMA', 'planned_prepay_after_k']);
  // сверка записана на платеже 3
  const r3 = apply_reanchor(REC, { k: 3, observed_minor: 61000, as_of: AS_OF }).debt;
  assert.deepEqual(why(r3, prepay_at('2026-12-05')), ['E_SCHEMA', 'later_reanchor_exists'], 'досрочное раньше записанной сверки');
  assert.deepEqual(why(r3, reanchor_at(2, 80793)), ['E_SCHEMA', 'later_reanchor_exists'], 'сверка раньше записанной сверки');
  assert.equal(why(r3, reanchor_at(3, 60900)), null, 'повторная сверка на том же платеже заменяет прежнюю');
  assert.equal(why(r3, reanchor_at(4, 40800)), null, 'сверка позже — можно');
  assert.equal(why(r3, prepay_at('2027-01-05')), null, 'досрочное на платеже сверки — остаток уже наблюдаемый');
  assert.equal(why(r3, prepay_at('2027-02-05')), null);
  assert.equal(r3.history.length, 1, 'отказ историю не меняет');
  // перенос даты порядок правок не нарушает
  assert.equal(why(p3, (d) => move_row_date(d, 2, '2026-12-07', AS_OF)), null);
});

// ═══ исправления после независимой проверки (FP-14): перенос платежа не теряется; «срок короче» не удлиняет график ═══════════════════════════

const dates_of = (rec) => rec.schedule.map((r) => r.date);
const sums_of = (rec) => rec.schedule.map((r) => [r.payment_minor, r.interest_minor, r.principal_minor, r.balance_minor, r.extra_minor ?? 0]);

test('REQ-082 REQ-083 перенос платежа не теряется при досрочном погашении на более раннем платеже: даты хвоста прежние (платёж 4 остаётся на 20 февраля), суммы — как без переноса', () => {
  const moved = move_row_date(REC, 4, '2027-02-20', AS_OF);
  assert.deepEqual(dates_of(moved), ['2026-11-05', '2026-12-05', '2027-01-05', '2027-02-20', '2027-03-05', '2027-04-05']);
  for (const option of ['shorten', 'lower_payment']) {
    const args = { date: '2026-12-05', amount_minor: 10000, option, as_of: AS_OF };
    const a = apply_prepay(moved, args);
    const plain = apply_prepay(REC, args);
    assert.equal(a.n, 6, option);
    assert.deepEqual(dates_of(a), ['2026-11-05', '2026-12-05', '2027-01-05', '2027-02-20', '2027-03-05', '2027-04-05'], option + ': перенесённая дата на месте, остальные не сдвинулись');
    assert.deepEqual(sums_of(a), sums_of(plain), option + ': суммы считает ядро, перенос их не меняет');
    assert.deepEqual(a.history.map((e) => e.kind), ['move', 'prepay']);
  }
});

test('REQ-082 REQ-083 перенос одного платежа не сдвигает следующие: платёж 3 на 20 января, затем досрочное «платёж ниже» на платеже 2 — платежи 4–6 остаются на 5-е число', () => {
  const moved = move_row_date(REC, 3, '2027-01-20', AS_OF);
  const next = apply_prepay(moved, { date: '2026-12-05', amount_minor: 10000, option: 'lower_payment', as_of: AS_OF });
  assert.deepEqual(dates_of(next), ['2026-11-05', '2026-12-05', '2027-01-20', '2027-02-05', '2027-03-05', '2027-04-05']);
  assert.deepEqual(payments(next), payments(apply_prepay(REC, { date: '2026-12-05', amount_minor: 10000, option: 'lower_payment', as_of: AS_OF })), 'суммы хвоста — как без переноса');
});

test('REQ-082 REQ-083 перенос платежа не теряется при сверке с банком на более раннем платеже; сверка с переносом даёт те же суммы, что без переноса', () => {
  const moved = move_row_date(REC, 4, '2027-02-20', AS_OF);
  const r = apply_reanchor(moved, { k: 2, observed_minor: 79000, as_of: AS_OF });
  assert.deepEqual(dates_of(r.debt), ['2026-11-05', '2026-12-05', '2027-01-05', '2027-02-20', '2027-03-05', '2027-04-05']);
  assert.deepEqual(sums_of(r.debt), sums_of(apply_reanchor(REC, { k: 2, observed_minor: 79000, as_of: AS_OF }).debt));
  assert.deepEqual(r.debt.history.map((e) => e.kind), ['move', 'reanchor']);
  // перенос платежа 3 на 20-е число и сверка после платежа 2: платежи 4–6 остаются на 5-е
  const m3 = move_row_date(REC, 3, '2027-01-20', AS_OF);
  assert.deepEqual(dates_of(apply_reanchor(m3, { k: 2, observed_minor: 80900, as_of: AS_OF }).debt), ['2026-11-05', '2026-12-05', '2027-01-20', '2027-02-05', '2027-03-05', '2027-04-05']);
});

test('REQ-082 перенос платежа и события прогноза: после «перенос + досрочное» платёж в событиях стоит на перенесённой дате, а не на прежней', () => {
  const moved = move_row_date(REC, 4, '2027-02-20', AS_OF);
  const next = apply_prepay(moved, { date: '2026-12-05', amount_minor: 10000, option: 'shorten', as_of: AS_OF });
  const ids = schedule_to_events(next).map((e) => e.cash_event_id);
  assert.ok(ids.includes('D-LOAN@2027-02-20') && !ids.includes('D-LOAN@2027-02-05'), ids.join(' '));
  assert.deepEqual(ids, ['D-LOAN@2026-11-05', 'D-LOAN@2026-12-05', 'D-LOAN@2026-12-05#extra', 'D-LOAN@2027-01-05', 'D-LOAN@2027-02-20', 'D-LOAN@2027-03-05', 'D-LOAN@2027-04-05']);
});

test('REQ-082 «Что применено»: запись о переносе остаётся, пока строка в графике; «срок короче» или закрытие сверкой, убравшие эту строку, убирают и запись; другие записи на месте', () => {
  // перенос строки 6 и строки 4; «срок короче» с 300,00 € на платеже 2 даёт 5 строк: строки 6 больше нет, строка 4 на месте
  const m = move_row_date(move_row_date(REC, 6, '2027-04-20', AS_OF), 4, '2027-02-20', AS_OF);
  assert.deepEqual(m.history.map((e) => [e.kind, e.k]), [['move', 6], ['move', 4]]);
  const sh = apply_prepay(m, { date: '2026-12-05', amount_minor: 30000, option: 'shorten', as_of: AS_OF });
  assert.equal(sh.n, 5);
  assert.deepEqual(sh.history.map((e) => [e.kind, e.k]), [['move', 4], ['prepay', 2]], 'запись о строке 6, которой нет, ушла');
  assert.equal(dates_of(sh)[3], '2027-02-20');
  for (const h of sh.history.filter((e) => e.kind === 'move')) assert.equal(dates_of(sh)[h.k - 1], h.to, 'каждый оставшийся перенос отражён в графике');
  // сверка с остатком 0 закрывает долг после платежа 5: запись о строке 6 уходит, запись о строке 4 остаётся
  const closed = apply_reanchor(m, { k: 5, observed_minor: 0, as_of: AS_OF }).debt;
  assert.equal(closed.n, 5);
  assert.deepEqual(closed.history.map((e) => [e.kind, e.k]), [['move', 4], ['reanchor', 5]]);
  // исходная запись не изменена
  assert.equal(m.n, 6);
  assert.equal(m.history.length, 2);
});

test('REQ-082 REQ-083 хвост длиннее прежнего графика (запись из чужого файла с малым платежом): даты прежних строк на месте, добавленные идут помесячно от последней прежней даты (в том числе перенесённой), порядок строгий', () => {
  const foreign = clone(REC);
  foreign.schedule[2].payment_minor = 5000; // действующий платёж после погашения — малый: «срок короче» даёт хвост длиннее
  for (const [debt, last, next_dates] of [
    [foreign, '2027-04-05', ['2027-05-05', '2027-06-05', '2027-07-05']],
    [move_row_date(foreign, 6, '2027-04-20', AS_OF), '2027-04-20', ['2027-05-20', '2027-06-20', '2027-07-20']],
  ]) {
    const a = apply_prepay(debt, { date: '2026-12-05', amount_minor: 10000, option: 'shorten', as_of: AS_OF });
    assert.ok(a.n > 6, 'хвост длиннее: ' + a.n);
    const d = dates_of(a);
    assert.deepEqual(d.slice(0, 6), dates_of(debt), 'прежние строки — на прежних датах');
    assert.equal(d[5], last);
    assert.deepEqual(d.slice(6, 9), next_dates);
    d.forEach((x, i) => { if (i > 0) assert.ok(x > d[i - 1], `строго по порядку: ${d[i - 1]} → ${x}`); });
    assert.equal(a.schedule.at(-1).balance_minor, 0);
  }
});

test('REQ-083 «Срок короче» берёт действующий платёж: после сверки вверх в тот же день хвост не длиннее прежнего (платёж хвоста, а не меньший платёж оплаченной строки), экономия на процентах не отрицательна', () => {
  const ra = apply_reanchor(REC, { k: 2, observed_minor: 84900, as_of: AS_OF }).debt;
  const eff = ra.schedule[2].payment_minor;
  assert.ok(eff > REC.schedule[1].payment_minor, 'после сверки вверх платёж хвоста больше платежа оплаченной строки: ' + eff);
  const now_tail = ra.n - 2;
  const sh = apply_prepay(ra, { date: '2026-12-05', amount_minor: 1000, option: 'shorten', as_of: AS_OF });
  assert.ok(sh.n - 2 <= now_tail, `платежей впереди ${sh.n - 2}, без досрочного ${now_tail}`);
  assert.equal(sh.schedule[2].payment_minor, eff, 'платёж прежний — действующий платёж хвоста');
  const interest = (d) => d.schedule.slice(2).reduce((s, r) => s + r.interest_minor, 0);
  assert.ok(interest(ra) - interest(sh) >= 0, 'экономия на процентах не отрицательна');
  // «платёж ниже», затем «срок короче» в тот же день: действующий платёж 13 017, а не 20 706
  const lo = apply_prepay(REC, { ...PP, option: 'lower_payment' });
  const sh2 = apply_prepay(lo, { ...PP, amount_minor: 5000, option: 'shorten' });
  assert.equal(lo.schedule[2].payment_minor, 13017);
  assert.equal(sh2.schedule[2].payment_minor, 13017, 'повтор в тот же день не возвращает платёж 20 706');
  assert.ok(sh2.n <= lo.n);
});

test('TST-51 REQ-082 REQ-083 свойства: 400 случайных долгов, переносы вперемешку с досрочными погашениями и сверками — даты прежних строк после пересчёта не меняются, «срок короче» не удлиняет график и не даёт отрицательной экономии, записи о переносе есть только для существующих строк', () => {
  const rng = make_rng(1414);
  const as_of = day(AS_OF);
  let moves = 0;
  let recalcs = 0;
  let shortens = 0;
  for (let t = 0; t < 400; t++) {
    const kind = rng.pick(['annuity', 'annuity', 'differential', 'installment_0']);
    const n = rng.int(3, 30);
    let debt = build_debt_record({ ...SPEC, kind, n, principal_minor: rng.int(n * 100, 3_000_000), rate_bp: kind === 'installment_0' ? 0 : rng.int(50, 6000), start_date: format_date(as_of + rng.int(1, 40)) });
    for (let s = 0; s < 7; s++) {
      const rows = rows_of(debt);
      const before = rows.map((r) => format_date(r.date));
      const pick = rng.int(0, 2);
      let next = null;
      let option = null;
      try {
        if (pick === 0) {
          const i = rng.int(0, rows.length - 1);
          const lo = Math.max(i === 0 ? as_of : rows[i - 1].date + 1, as_of);
          const hi = i === rows.length - 1 ? rows[i].date + 60 : rows[i + 1].date - 1;
          if (lo > hi) continue;
          next = move_row_date(debt, i + 1, format_date(rng.int(lo, hi)), AS_OF);
        } else if (pick === 1 && rows.length >= 2) {
          const i = rng.int(0, rows.length - 2);
          option = rng.pick(['shorten', 'lower_payment']);
          next = apply_prepay(debt, { date: before[i], amount_minor: rng.int(1, Math.max(1, Math.min(rows[i].balance_minor, rng.pick([100, 5000, 100_000_000])))), option, as_of: AS_OF });
        } else {
          const i = rng.int(0, rows.length - 1);
          next = apply_reanchor(debt, { k: i + 1, observed_minor: i === rows.length - 1 ? 0 : Math.max(1, rows[i].balance_minor + rng.int(-40, 40)), as_of: AS_OF }).debt;
        }
      } catch (e) { assert.equal(e.name, 'RunwayError'); continue; }
      const after = next.schedule.map((r) => r.date);
      if (pick === 0) {
        moves += 1;
        assert.equal(after.filter((d, j) => d !== before[j]).length, 1, 'перенос меняет ровно одну дату');
      } else {
        recalcs += 1;
        for (let j = 0; j < Math.min(before.length, after.length); j++) assert.equal(after[j], before[j], `долг #${t}: пересчёт хвоста не меняет дату строки ${j + 1}`);
      }
      after.forEach((d, j) => { if (j > 0) assert.ok(d > after[j - 1], 'даты строго по порядку'); });
      assert.equal(next.schedule.at(-1).balance_minor, 0);
      if (option === 'shorten') {
        shortens += 1;
        assert.ok(next.n <= rows.length, `долг #${t}: «срок короче» не удлиняет график (${rows.length} → ${next.n})`);
        const k = next.history.at(-1).k;
        const saved = rows.slice(k).reduce((sum, r) => sum + r.interest_minor, 0) - next.schedule.slice(k).reduce((sum, r) => sum + r.interest_minor, 0);
        assert.ok(saved >= 0, `долг #${t}: экономия на процентах не отрицательна (${saved})`);
      }
      for (const h of next.history.filter((e) => e.kind === 'move')) assert.ok(h.k <= next.n, 'запись о переносе — для существующей строки');
      debt = next;
    }
  }
  assert.ok(moves > 200 && recalcs > 300 && shortens > 100, `выборка не выродилась: переносов ${moves}, пересчётов ${recalcs}, «срок короче» ${shortens}`);
});
