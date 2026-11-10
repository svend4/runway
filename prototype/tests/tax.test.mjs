// tax.test.mjs — TST-23 (налог: аллокация и округление), TST-24 (версии правил, релиз и true_up), TST-10 (аллокация G-001), TST-57 (срок годности, часть).
// Числа — design-brief §9.2, §9.12, D-17, C-016 (версия по base(e)), C-023 (2·ttl), C-032 (валидация); ALG-06 TV-1…TV-7. Расчёт по введённым правилам, не консультация.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validate_tax_rule, rule_at, allocation_for_income, allocation_range, release_on_payment, allocations_for_events, rule_age_status, next_release,
} from '../engine/tax.mjs';
import { reserve_series } from '../engine/sinking.mjs';
import { mul_div } from '../engine/money.mjs';
import { parse_date, format_date } from '../engine/dates.mjs';
import { make_rng, throws_code } from './helpers.mjs';

const d = parse_date;
const AS_OF = d('2026-10-04');

/** Правило TR-20 из G-001: 2000 bp, с 2026-01-01, half_even, поток S-HOURLY, резерв RES-TAX. */
const TR20 = Object.freeze({
  tax_rule_id: 'TR-20', version: 1, name: 'Налог 20 %', kind: 'percent_of_income', rate_bp: 2000, base: 'gross', applies_to: { stream_ids: ['S-HOURLY'], tags: [] },
  valid_from: '2026-01-01', valid_to: null, rounding: 'half_even', reserve_id: 'RES-TAX', recorded_at: '2026-01-01T00:00:00Z',
});
const rule = (over) => ({ ...TR20, ...over });

const income = (id, date, amount, extra = {}) => ({
  cash_event_id: id, layer: 'planned', kind: 'income', account_id: 'acc_main', currency: 'EUR', date: d(date), plan_date: d(date), amount_minor: amount,
  tag: 'S-HOURLY', rule_id: null, stream_id: 'S-HOURLY', ...extra,
});

// ── TST-23: аллокация и округление ─────────────────────────────────────────────

test('TST-23 allocation_for_income: mul_div(123457, 2100, 10000, half_even) = 25926 (259,26 €); mul_div(279000, 2000, 10000) = 55800', () => {
  assert.equal(allocation_for_income(123457, rule({ rate_bp: 2100 })), 25926);
  assert.equal(allocation_for_income(123457, rule({ rate_bp: 2100 })), mul_div(123457, 2100, 10000, 'half_even'));
  assert.equal(allocation_for_income(279000, TR20), 55800);
  assert.equal(allocation_for_income(288000, TR20), 57600, 'сентябрьская выплата уже в funded_start');
  assert.equal(allocation_for_income(0, TR20), 0);
});

test('TST-23 ничья округления: 12345 · 5000 / 10000 = 6172,5 → half_even 6172, half_up 6173; 4900 · 2250 / 10000 = 1102,5 → 1102 / 1103 / floor 1102 / ceil 1103', () => {
  assert.equal(allocation_for_income(12345, rule({ rate_bp: 5000, rounding: 'half_even' })), 6172);
  assert.equal(allocation_for_income(12345, rule({ rate_bp: 5000, rounding: 'half_up' })), 6173);
  const r = (rounding) => allocation_for_income(4900, rule({ rate_bp: 2250, rounding }));
  assert.deepEqual([r('half_even'), r('half_up'), r('floor'), r('ceil')], [1102, 1103, 1102, 1103]);
  throws_code(() => allocation_for_income(-1, TR20), 'E_SCHEMA');
  throws_code(() => allocation_for_income(10.5, TR20), 'E_NOT_INTEGER');
  throws_code(() => allocation_for_income(100, rule({ rounding: 'банковское' })), 'E_SCHEMA');
});

test('TST-10 allocation_range: диапазон часов 240000…330000 → конверт 48000 / 55800 / 66000; без коридора min = exp = max; min ≤ exp ≤ max', () => {
  assert.deepEqual(allocation_range({ amount_minor: 279000, amount_min_minor: 240000, amount_max_minor: 330000 }, TR20), { min: 48000, exp: 55800, max: 66000 });
  assert.deepEqual(allocation_range({ amount_minor: 279000 }, TR20), { min: 55800, exp: 55800, max: 55800 });
  const rng = make_rng(6);
  for (let k = 0; k < 500; k++) {
    const mid = rng.int(0, 1_000_000);
    const lo = Math.max(0, mid - rng.int(0, 100000));
    const hi = mid + rng.int(0, 100000);
    const r = allocation_range({ amount_minor: mid, amount_min_minor: lo, amount_max_minor: hi }, rule({ rate_bp: rng.int(0, 10000), rounding: rng.pick(['half_even', 'half_up', 'floor', 'ceil']) }));
    assert.ok(r.min <= r.exp && r.exp <= r.max);
  }
});

test('TST-23 свойства (инв. 1): 0 ≤ allocation ≤ income при rate_bp ≤ 10000; монотонность по доходу и по rate_bp; оракул на целых (3 000 случаев)', () => {
  const rng = make_rng(23);
  for (let it = 0; it < 3000; it++) {
    const inc = rng.int(0, 5_000_000);
    const bp = rng.int(0, 10000);
    const rounding = rng.pick(['half_even', 'half_up', 'floor', 'ceil']);
    const a = allocation_for_income(inc, rule({ rate_bp: bp, rounding }));
    assert.ok(a >= 0 && a <= inc);
    assert.ok(allocation_for_income(inc + rng.int(0, 1000), rule({ rate_bp: bp, rounding })) >= a);
    assert.ok(allocation_for_income(inc, rule({ rate_bp: Math.min(10000, bp + rng.int(0, 500)), rounding })) >= a);
    // точный остаток: |a·10000 − inc·bp| ≤ 10000 (одно округление)
    assert.ok(Math.abs(a * 10000 - inc * bp) <= 10000);
  }
});

// ── TST-24: версии правил ──────────────────────────────────────────────────────

const V1 = rule({ version: 1, rate_bp: 2000, valid_from: '2026-01-01', recorded_at: '2026-01-01T00:00:00Z' });
const V2 = rule({ version: 2, rate_bp: 2200, valid_from: '2026-07-01', recorded_at: '2026-06-20T00:00:00Z' });

test('TST-24 версии: 2000 bp с 2026-01-01, 2200 bp с 2026-07-01; доход 300000 на 06-30 → 60000, на 07-01 и 07-02 → 66000', () => {
  const rules = [V1, V2];
  const at = (iso) => allocation_for_income(300000, rule_at(rules, 'TR-20', d(iso)));
  assert.equal(at('2026-06-30'), 60000);
  assert.equal(at('2026-07-01'), 66000, 'valid_from включается');
  assert.equal(at('2026-07-02'), 66000);
  assert.equal(rule_at(rules, 'TR-20', d('2026-06-30')).version, 1);
  assert.equal(rule_at(rules, 'TR-20', '2026-07-02').version, 2, 'IsoDate допустим');
  assert.equal(rule_at([...rules].reverse(), 'TR-20', d('2026-07-02')).version, 2, 'порядок rules не влияет (инв. 7)');
  // раньше всех valid_from и неизвестный id — null
  assert.equal(rule_at(rules, 'TR-20', d('2025-12-31')), null);
  assert.equal(rule_at(rules, 'TR-99', d('2026-07-02')), null);
  assert.equal(rule_at([], 'TR-20', d('2026-07-02')), null);
});

test('TST-24 valid_to не включается: v1 до 2026-11-10, v2 с 2026-11-10; границы valid_from ≤ d < valid_to', () => {
  const rules = [rule({ version: 1, valid_to: '2026-11-10' }), rule({ version: 2, rate_bp: 2200, valid_from: '2026-11-10', recorded_at: '2026-10-01T00:00:00Z' })];
  assert.equal(rule_at(rules, 'TR-20', d('2026-11-09')).version, 1);
  assert.equal(rule_at(rules, 'TR-20', d('2026-11-10')).version, 2);
  assert.equal(rule_at([rule({ valid_to: '2026-11-10' })], 'TR-20', d('2026-11-10')), null, 'd = valid_to — правила нет');
});

test('TST-24 новая версия «задним числом» и known_at: v3 (2200 bp с 2026-05-01), введённая 2026-10-04, меняет расчёт, но не прошлую проведённую аллокацию (rule_version 1)', () => {
  const V3 = rule({ version: 3, rate_bp: 2200, valid_from: '2026-05-01', recorded_at: '2026-10-04T10:00:00Z' });
  const rules = [V1, V2, V3];
  const posted = { amount_minor: 60000, rule_version: 1 }; // записано 2026-05-15 по версии 1
  assert.equal(allocation_for_income(300000, rule_at(rules, 'TR-20', d('2026-05-15'))), 66000, 'расчёт на ту же дату по v3 дал бы 66000');
  assert.equal(posted.amount_minor, 60000, 'сохранённая аллокация не переписывается: хранит rule_version');
  assert.equal(rule_at(rules, 'TR-20', d('2026-05-15')).version, 3);
  // запрос «что знали тогда»: на 2026-09-01 версии v3 ещё не было
  assert.equal(rule_at(rules, 'TR-20', d('2026-05-15'), '2026-09-01T00:00:00Z').version, 1);
  assert.equal(rule_at(rules, 'TR-20', d('2026-05-15'), '2026-10-04T10:00:00Z').version, 3, 'recorded_at = known_at включается');
  assert.equal(rule_at(rules, 'TR-20', d('2026-07-02'), '2026-09-01T00:00:00Z').version, 2);
  assert.equal(rule_at([V3], 'TR-20', d('2026-05-15'), '2026-09-01T00:00:00Z'), null);
  // при равном recorded_at побеждает наибольшая version; доли секунды сравниваются корректно
  const t1 = rule({ version: 1, recorded_at: '2026-10-04T10:00:00Z' });
  const t2 = rule({ version: 2, rate_bp: 1000, recorded_at: '2026-10-04T10:00:00Z' });
  assert.equal(rule_at([t1, t2], 'TR-20', d('2026-10-04')).version, 2);
  const f1 = rule({ version: 5, recorded_at: '2026-10-04T10:00:00.5Z' });
  const f2 = rule({ version: 1, recorded_at: '2026-10-04T10:00:00Z' });
  assert.equal(rule_at([f1, f2], 'TR-20', d('2026-10-04')).version, 5);
});

// ── релиз резерва ──────────────────────────────────────────────────────────────

test('TST-24 release_on_payment: funded 150000, платёж 50000 → released 50000, true_up 0; funded 30000 → 30000 / 20000; funded 0 → 0 / 50000', () => {
  assert.deepEqual(release_on_payment(150000, 50000), { released: 50000, true_up: 0 });
  assert.deepEqual(release_on_payment(30000, 50000), { released: 30000, true_up: 20000 });
  assert.deepEqual(release_on_payment(0, 50000), { released: 0, true_up: 50000 });
  assert.deepEqual(release_on_payment(60000, 50000), { released: 50000, true_up: 0 }, 'остаток 10000 остаётся в резерве до ручной аллокации (C-059)');
  assert.deepEqual(release_on_payment(50000, 50000), { released: 50000, true_up: 0 });
  assert.deepEqual(release_on_payment(100, 0), { released: 0, true_up: 0 });
  throws_code(() => release_on_payment(-1, 5), 'E_SCHEMA');
  throws_code(() => release_on_payment(5, -1), 'E_SCHEMA');
  const rng = make_rng(24);
  for (let k = 0; k < 2000; k++) {
    const f = rng.int(0, 1_000_000);
    const p = rng.int(0, 1_000_000);
    const r = release_on_payment(f, p);
    assert.equal(r.released + r.true_up, p, 'инв. 3: released + true_up = платёж');
    assert.ok(r.released >= 0 && r.released <= f);
  }
});

test('TST-24 next_release: G-001 P-TAX1 на 2026-10-23 → {date, payment 50000, released 50000, true_up 0}; при funded_start 30000 → 30000 / 20000', () => {
  const as_of = AS_OF;
  const hz = d('2026-11-30');
  const pay = { cash_event_id: 'P-TAX1', date: d('2026-10-23'), amount_minor: -50000, reserve_id: 'RES-TAX' };
  const other = { cash_event_id: 'R-RENT@2026-10-26', date: d('2026-10-26'), amount_minor: -90000 };
  const rs = (funded) => reserve_series([{ reserve_id: 'RES-TAX', kind: 'tax', funded_open_minor: funded }], [pay, other], [], as_of, hz);
  assert.deepEqual(next_release('RES-TAX', rs(150000), [pay, other], as_of), { date: d('2026-10-23'), payment_minor: 50000, released_minor: 50000, true_up_minor: 0 });
  assert.deepEqual(next_release('RES-TAX', rs(30000), [pay, other], as_of), { date: d('2026-10-23'), payment_minor: 50000, released_minor: 30000, true_up_minor: 20000 });
  // два платежа в один день суммируются; берётся ближайший
  const pay2 = { cash_event_id: 'P2', date: d('2026-10-23'), amount_minor: -1000, reserve_id: 'RES-TAX' };
  const later = { cash_event_id: 'P3', date: d('2026-11-20'), amount_minor: -7000, reserve_id: 'RES-TAX' };
  const r2 = next_release('RES-TAX', reserve_series([{ reserve_id: 'RES-TAX', kind: 'tax', funded_open_minor: 150000 }], [later, pay2, pay], [], as_of, hz), [later, pay2, pay], as_of);
  assert.deepEqual(r2, { date: d('2026-10-23'), payment_minor: 51000, released_minor: 51000, true_up_minor: 0 });
  // нет платежа, неизвестный резерв, платёж за горизонтом — null
  assert.equal(next_release('RES-TAX', rs(1), [other], as_of), null);
  assert.equal(next_release('RES-X', rs(1), [pay], as_of), null);
  const far = { cash_event_id: 'P4', date: d('2027-03-01'), amount_minor: -5, reserve_id: 'RES-TAX' };
  assert.equal(next_release('RES-TAX', rs(1), [far], as_of), null);
});

// ── валидация (C-032) ──────────────────────────────────────────────────────────

test('TST-24 validate_tax_rule: TR-20 корректно; пустой applies_to — E_SCHEMA; rate_bp, base, kind, valid_to, reserve_id, пара reviewed_at/ttl_days (C-032)', () => {
  assert.deepEqual(validate_tax_rule(TR20), { ok: true, errors: [] });
  const bad = (over) => validate_tax_rule(rule(over));
  const codes = (r) => r.errors.map((e) => [e.code, e.field]);
  assert.deepEqual(codes(bad({ applies_to: { stream_ids: [], tags: [] } })), [['E_SCHEMA', 'applies_to']], 'правило «ни к чему» — ошибка валидации');
  assert.deepEqual(codes(bad({ applies_to: {} })), [['E_SCHEMA', 'applies_to']]);
  assert.deepEqual(codes(bad({ applies_to: null })), [['E_SCHEMA', 'applies_to']]);
  assert.equal(bad({ applies_to: { stream_ids: [], tags: ['аренда'] } }).ok, true);
  assert.deepEqual(codes(bad({ applies_to: { stream_ids: 'S-HOURLY' } })), [['E_SCHEMA', 'applies_to']]);
  assert.deepEqual(codes(bad({ rate_bp: 10001 })), [['E_RULE_INVALID', 'rate_bp']]);
  assert.deepEqual(codes(bad({ rate_bp: -1 })), [['E_RULE_INVALID', 'rate_bp']]);
  assert.deepEqual(codes(bad({ rate_bp: 20.5 })), [['E_RULE_INVALID', 'rate_bp']]);
  assert.equal(bad({ rate_bp: 0 }).ok, true, 'rate_bp = 0 — пауза правила');
  assert.equal(bad({ rate_bp: 10000 }).ok, true);
  assert.deepEqual(codes(bad({ kind: 'progressive' })), [['E_RULE_INVALID', 'kind']]);
  assert.deepEqual(codes(bad({ base: 'net' })), [['E_RULE_INVALID', 'base']]);
  assert.deepEqual(codes(bad({ rounding: 'round' })), [['E_RULE_INVALID', 'rounding']]);
  assert.deepEqual(codes(bad({ reserve_id: null })), [['E_RULE_INVALID', 'reserve_id']]);
  assert.deepEqual(codes(bad({ tax_rule_id: '' })), [['E_RULE_INVALID', 'tax_rule_id']]);
  assert.deepEqual(codes(bad({ version: 0 })), [['E_RULE_INVALID', 'version']]);
  assert.deepEqual(codes(bad({ valid_to: '2026-01-01' })), [['E_RULE_INVALID', 'valid_to']], 'valid_to > valid_from');
  assert.deepEqual(codes(bad({ valid_to: '2025-01-01' })), [['E_RULE_INVALID', 'valid_to']]);
  assert.equal(bad({ valid_to: '2026-01-02' }).ok, true);
  assert.deepEqual(codes(bad({ valid_from: '2026-13-01' })), [['E_RULE_INVALID', 'valid_from']]);
  assert.deepEqual(codes(bad({ reviewed_at: '2026-10-04' })), [['E_RULE_INVALID', 'reviewed_at']], 'reviewed_at без ttl_days');
  assert.deepEqual(codes(bad({ ttl_days: 120 })), [['E_RULE_INVALID', 'reviewed_at']], 'ttl_days без reviewed_at');
  assert.equal(bad({ reviewed_at: '2026-10-04', ttl_days: 120 }).ok, true);
  assert.deepEqual(codes(bad({ reviewed_at: '2026-10-04', ttl_days: 0 })), [['E_RULE_INVALID', 'ttl_days']]);
  assert.equal(validate_tax_rule(null).ok, false);
  assert.equal(validate_tax_rule(undefined).ok, false);
});

// ── allocations_for_events ─────────────────────────────────────────────────────

test('TST-10 ALG-06 TV-1: S-HOURLY@2026-11-05 +279000 → аллокация 55800 на 11-05; в worse та же сумма на 11-19; rule_version 1; нетто после резерва 223200', () => {
  const plan = income('S-HOURLY@2026-11-05', '2026-11-05', 279000, { amount_min_minor: 240000, amount_max_minor: 330000 });
  const worse = { ...plan, date: d('2026-11-19') }; // plan_date остаётся 11-05
  const a = allocations_for_events([plan], [TR20], AS_OF);
  assert.deepEqual(a, [{ allocation_id: 'tax:TR-20@S-HOURLY@2026-11-05', reserve_id: 'RES-TAX', date: d('2026-11-05'), amount_minor: 55800, source: 'income', source_event_id: 'S-HOURLY@2026-11-05', rule_version: 1 }]);
  const b = allocations_for_events([worse], [TR20], AS_OF);
  assert.equal(b[0].amount_minor, 55800);
  assert.equal(b[0].date, d('2026-11-19'), 'date — эффективная дата режима (D-08: попадает в reserve_close дня прихода)');
  assert.equal(279000 - a[0].amount_minor, 223200);
  assert.equal(a[0].rule_version, 1);
});

test('TST-24 ALG-06 TV-7 (C-016): версия по base(e) = max(plan_date, as_of), а не по сдвинутой дате режима — аллокации plan и worse равны', () => {
  const v1 = rule({ version: 1, valid_to: '2026-11-10' });
  const v2 = rule({ version: 2, rate_bp: 2200, valid_from: '2026-11-10', recorded_at: '2026-10-01T00:00:00Z' });
  const plan = income('S-HOURLY@2026-11-05', '2026-11-05', 279000);
  const worse = { ...plan, date: d('2026-11-19') };
  const a_plan = allocations_for_events([plan], [v1, v2], AS_OF)[0];
  const a_worse = allocations_for_events([worse], [v1, v2], AS_OF)[0];
  assert.equal(a_plan.amount_minor, 55800);
  assert.equal(a_worse.amount_minor, 55800, 'не 61380 (по v2 на сдвинутой дате)');
  assert.equal(a_worse.rule_version, 1);
  assert.equal(mul_div(279000, 2200, 10000), 61380);
  assert.deepEqual([a_plan.date, a_worse.date], [d('2026-11-05'), d('2026-11-19')]);
  // просроченный доход (plan_date раньше as_of): версия по as_of, не по давней plan_date
  const overdue = income('S-HOURLY@2026-10-01', '2026-10-04', 100000, { plan_date: d('2026-09-30') });
  const rules = [rule({ version: 1, valid_to: '2026-10-02' }), rule({ version: 2, rate_bp: 2500, valid_from: '2026-10-02', recorded_at: '2026-09-01T00:00:00Z' })];
  const o = allocations_for_events([overdue], rules, AS_OF)[0];
  assert.deepEqual([o.rule_version, o.amount_minor], [2, 25000]);
  // без plan_date берётся date
  const no_pd = { ...plan };
  delete no_pd.plan_date;
  assert.equal(allocations_for_events([no_pd], [v1, v2], AS_OF)[0].rule_version, 1);
});

test('TST-24 allocations_for_events: только planned/hypothetical доходы > 0, подпадающие под applies_to (stream_id или tag, C-025); posted и расходы не аллоцируются', () => {
  const evs = [
    income('s1', '2026-11-05', 100000),
    income('s2', '2026-11-06', 100000, { stream_id: 'OTHER', tag: 'другое' }), // не подпадает
    income('s3', '2026-11-07', 100000, { stream_id: null, tag: 'фриланс' }), // по тегу
    income('s4', '2026-11-08', 100000, { layer: 'posted' }), // факт фиксируется записью allocation.recorded
    income('s5', '2026-11-09', -5000), // возврат — не аллоцируется
    income('s6', '2026-11-10', 100000, { kind: 'expense' }),
    income('s7', '2026-11-11', 100000, { layer: 'hypothetical' }), // сценарий честен про конверт
    income('s8', '2025-12-01', 100000), // plan_date давно позади: base(e) = max(plan_date, as_of) = as_of → правило действует
    income('s9', '2026-11-12', 1), // 1 minor · 20 % = 0 — аллокация 0 не выводится
  ];
  const rules = [rule({ applies_to: { stream_ids: ['S-HOURLY'], tags: ['фриланс'] } })];
  const out = allocations_for_events(evs, rules, AS_OF);
  assert.deepEqual(out.map((a) => [a.source_event_id, a.amount_minor]), [['s8', 20000], ['s1', 20000], ['s3', 20000], ['s7', 20000]], 'порядок — по plan_date');
  // дата выбора версии раньше всех valid_from — правила нет, аллокации нет (прошлого не выдумываем)
  assert.deepEqual(allocations_for_events([income('late', '2026-11-05', 100000)], [rule({ valid_from: '2027-01-01' })], AS_OF), []);
  assert.deepEqual(allocations_for_events(evs, [], AS_OF), [], 'нет ставок по умолчанию (REQ-068)');
  assert.deepEqual(allocations_for_events([], rules, AS_OF), []);
  assert.deepEqual(allocations_for_events([income('z', '2026-11-05', 1000)], [rule({ rate_bp: 0 })], AS_OF), [], 'rate_bp = 0 — пауза, аллокация 0 не выводится');
});

test('TST-24 C-032: Σ rate_bp правил на одно поступление > 10000 — E_RULE_INVALID на событии; ровно 10000 допустимо; разные потоки не суммируются', () => {
  const r1 = rule({ tax_rule_id: 'A', rate_bp: 6000, reserve_id: 'RES-A' });
  const r2 = rule({ tax_rule_id: 'B', rate_bp: 5000, reserve_id: 'RES-B' });
  const e = income('e', '2026-11-05', 100000);
  assert.throws(() => allocations_for_events([e], [r1, r2], AS_OF), (err) => err.code === 'E_RULE_INVALID' && err.ctx.event === 'e');
  const ok = allocations_for_events([e], [r1, rule({ tax_rule_id: 'B', rate_bp: 4000, reserve_id: 'RES-B' })], AS_OF);
  assert.deepEqual(ok.map((a) => [a.allocation_id, a.reserve_id, a.amount_minor]), [['tax:A@e', 'RES-A', 60000], ['tax:B@e', 'RES-B', 40000]]);
  assert.equal(ok.reduce((s, a) => s + a.amount_minor, 0) <= 100000, true);
  // правило B относится к другому потоку — не суммируется с A
  const other = rule({ tax_rule_id: 'B', rate_bp: 5000, reserve_id: 'RES-B', applies_to: { stream_ids: ['OTHER'], tags: [] } });
  assert.equal(allocations_for_events([e], [r1, other], AS_OF).length, 1);
});

test('TST-33 (часть) allocations_for_events детерминизм: порядок events и rules не влияет; результат отсортирован по (plan_date, amount, id) и правилу; вход не мутируется', () => {
  const rng = make_rng(61);
  const rules = [
    rule({ tax_rule_id: 'TR-20', rate_bp: 2000 }),
    rule({ tax_rule_id: 'TR-OTHER', rate_bp: 1000, reserve_id: 'RES-2', applies_to: { stream_ids: ['S-HOURLY'], tags: [] } }),
    rule({ tax_rule_id: 'TR-20', version: 2, rate_bp: 2500, valid_from: '2026-12-01', recorded_at: '2026-11-01T00:00:00Z' }),
  ];
  const evs = Array.from({ length: 40 }, (_, k) => income('e' + String(k).padStart(2, '0'), '2026-11-' + String(1 + (k % 28)).padStart(2, '0'), rng.int(1000, 900000)));
  const copy = JSON.stringify(evs);
  const shuffle = (xs) => xs.map((x) => [rng.next(), x]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
  const base = allocations_for_events(evs, rules, AS_OF);
  for (let k = 0; k < 10; k++) assert.deepEqual(allocations_for_events(shuffle(evs), shuffle(rules), AS_OF), base);
  assert.equal(JSON.stringify(evs), copy);
  // 0 ≤ Σ аллокаций события ≤ дохода
  for (const e of evs) assert.ok(base.filter((a) => a.source_event_id === e.cash_event_id).reduce((s, a) => s + a.amount_minor, 0) <= e.amount_minor);
});

// ── срок годности (C-023): TST-57 (часть) ──────────────────────────────────────

test('TST-57/C-023 rule_age_status: reviewed_at 2026-10-04, ttl 120 — fresh по 2027-02-01 (age 120), stale с 02-02 (121) по 2027-06-01 (240 = 2·ttl), disabled с 2027-06-02 (241)', () => {
  const r = rule({ reviewed_at: '2026-10-04', ttl_days: 120 });
  const at = (iso) => rule_age_status(r, d(iso));
  assert.equal(at('2026-10-04'), 'fresh');
  assert.equal(at('2027-02-01'), 'fresh');
  assert.equal(at('2027-02-02'), 'stale');
  assert.equal(at('2027-06-01'), 'stale');
  assert.equal(at('2027-06-02'), 'disabled');
  assert.equal(rule_age_status(r, '2027-06-02'), 'disabled', 'IsoDate допустим');
  // ttl = 90: disabled с 2027-04-03 (age 181)
  const r90 = rule({ reviewed_at: '2026-10-04', ttl_days: 90 });
  assert.equal(rule_age_status(r90, d('2027-04-02')), 'stale');
  assert.equal(rule_age_status(r90, d('2027-04-03')), 'disabled');
  assert.equal(rule_age_status(r90, d('2027-01-02')), 'fresh', 'age 90');
  assert.equal(rule_age_status(r90, d('2027-01-03')), 'stale', 'age 91');
});

test('TST-57 rule_age_status: без reviewed_at/ttl_days — fresh («проверка не отмечена»); reviewed_at в будущем — E_BAD_DATE; монотонность fresh → stale → disabled', () => {
  assert.equal(rule_age_status(TR20, d('2030-01-01')), 'fresh');
  assert.equal(rule_age_status(rule({ reviewed_at: null, ttl_days: null }), d('2030-01-01')), 'fresh');
  throws_code(() => rule_age_status(rule({ reviewed_at: '2026-10-05', ttl_days: 10 }), AS_OF), 'E_BAD_DATE');
  const rank = { fresh: 0, stale: 1, disabled: 2 };
  const rng = make_rng(57);
  for (let it = 0; it < 300; it++) {
    const ttl = rng.int(1, 400);
    const rv = rule({ reviewed_at: d('2026-01-01'), ttl_days: ttl });
    let prev = 0;
    for (let age = 0; age <= 2 * ttl + 5; age += rng.int(1, 7)) {
      const s = rank[rule_age_status(rv, d('2026-01-01') + age)];
      assert.ok(s >= prev, 'не возвращается к более свежему статусу');
      const want = age <= ttl ? 0 : age <= 2 * ttl ? 1 : 2;
      assert.equal(s, want, `age=${age}, ttl=${ttl}`);
      prev = s;
    }
  }
  assert.equal(format_date(d('2027-06-02')), '2027-06-02');
});

test('TST-10 (G-001) Σ аллокаций в reserve_close: RES-TAX = 150000 − 50000 + 55800 = 155800 (через allocations_for_events и reserve_series)', () => {
  const e = income('S-HOURLY@2026-11-05', '2026-11-05', 279000);
  const alloc = allocations_for_events([e], [TR20], AS_OF);
  const pay = { cash_event_id: 'P-TAX1', date: d('2026-10-23'), amount_minor: -50000, reserve_id: 'RES-TAX' };
  const rs = reserve_series([{ reserve_id: 'RES-TAX', kind: 'tax', funded_open_minor: 150000 }], [pay], alloc, AS_OF, d('2026-11-30'));
  assert.equal(rs.reserve_close.at(-1), 155800);
  assert.equal(rs.reserve_trough[d('2026-11-05') - AS_OF], 100000, 'аллокация в reserve_trough — со следующего дня');
  assert.equal(rs.reserve_trough[d('2026-11-06') - AS_OF], 155800);
});
