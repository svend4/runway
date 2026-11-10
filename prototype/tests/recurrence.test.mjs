// recurrence.test.mjs — TST-11…14 (ALG-01), validate_rule (C-001, C-002), G-001 TV1, свойства окон, TST-51 (фаззинг правил).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validate_rule, nominal_dates, occ_key, effective_date, expand_rule, expand_all, index_overrides,
} from '../engine/recurrence.mjs';
import { parse_date, format_date, make_calendar, days_in_month, civil_from_days, add_months, dow } from '../engine/dates.mjs';
import { make_rng, mk_rule, g001_rules, G001, throws_code } from './helpers.mjs';

const D = parse_date;
const fmt = (xs) => xs.map(format_date);
const WK = make_calendar({ weekend_dows: [0, 6], holidays: [] });

test('TST-11 nominal_dates: 31-е без дрейфа (01-31, 02-28, 03-31, 04-30, 05-31, 06-30; k = 13 → 2027-02-28; k = 25 → 2028-02-29)', () => {
  const r = mk_rule({ start_date: '2026-01-31' });
  assert.deepEqual(fmt(nominal_dates(r, D('2026-01-01'), D('2026-06-30'))),
    ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);
  assert.deepEqual(fmt(nominal_dates(r, D('2027-02-01'), D('2027-02-28'))), ['2027-02-28'], 'k = 13');
  assert.deepEqual(fmt(nominal_dates(r, D('2028-02-01'), D('2028-02-29'))), ['2028-02-29'], 'k = 25');
  const all = nominal_dates(r, D('2026-01-01'), D('2028-12-31'));
  assert.equal(format_date(all[13]), '2027-02-28');
  assert.equal(format_date(all[25]), '2028-02-29');
  assert.equal(all.length, 36);
});

test('TST-11 month_end: skip и next_first на 31-м и 29 февраля (Y)', () => {
  const skip = mk_rule({ start_date: '2026-01-31', month_end: 'skip' });
  assert.deepEqual(fmt(nominal_dates(skip, D('2026-01-01'), D('2026-06-30'))), ['2026-01-31', '2026-03-31', '2026-05-31']);
  const nf = mk_rule({ start_date: '2026-01-31', month_end: 'next_first' });
  assert.deepEqual(fmt(nominal_dates(nf, D('2026-01-01'), D('2026-05-31'))), ['2026-01-31', '2026-03-01', '2026-03-31', '2026-05-01', '2026-05-31']);
  // 29 февраля, ежегодно
  const y = (me) => mk_rule({ freq: 'Y', start_date: '2028-02-29', month_end: me });
  assert.deepEqual(fmt(nominal_dates(y('clamp'), D('2028-01-01'), D('2033-01-01'))), ['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
  assert.deepEqual(fmt(nominal_dates(y('skip'), D('2028-01-01'), D('2033-01-01'))), ['2028-02-29', '2032-02-29']);
  assert.deepEqual(fmt(nominal_dates(y('next_first'), D('2028-01-01'), D('2033-01-01'))), ['2028-02-29', '2029-03-01', '2030-03-01', '2031-03-01', '2032-02-29']);
});

test('TST-11 by_monthday [30, 31] в феврале: одна дата 28-го; отрицательные дни — с конца месяца', () => {
  const r = mk_rule({ start_date: '2026-01-30', by_monthday: [30, 31] });
  assert.deepEqual(fmt(nominal_dates(r, D('2026-01-01'), D('2026-03-31'))),
    ['2026-01-30', '2026-01-31', '2026-02-28', '2026-03-30', '2026-03-31']);
  const last = mk_rule({ start_date: '2026-01-31', by_monthday: [-1] });
  assert.deepEqual(fmt(nominal_dates(last, D('2026-01-01'), D('2026-04-30'))), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  const m2 = mk_rule({ start_date: '2026-01-01', by_monthday: [-2, 1] });
  assert.deepEqual(fmt(nominal_dates(m2, D('2026-02-01'), D('2026-03-02'))), ['2026-02-01', '2026-02-27', '2026-03-01']);
});

test('TST-12 expand_rule + exdates: R-GROC без 10-17 даёт 7 суббот вместо 8', () => {
  const groc = g001_rules().find((r) => r.rule_id === 'R-GROC');
  const win = { from: G001.as_of, to: G001.horizon_end };
  assert.equal(expand_rule(groc, win, WK, []).length, 8);
  const ex = { ...groc, exdates: ['2026-10-17'] };
  const got = expand_rule(ex, win, WK, []);
  assert.equal(got.length, 7);
  assert.ok(!fmt(got.map((o) => o.date)).includes('2026-10-17'));
  assert.deepEqual(fmt(got.map((o) => o.date)), ['2026-10-10', '2026-10-24', '2026-10-31', '2026-11-07', '2026-11-14', '2026-11-21', '2026-11-28']);
});

test('TST-12 count считает номинальные даты до exdates; при count и until побеждает более ранний предел', () => {
  const sat = (over) => mk_rule({ freq: 'W', start_date: '2026-10-10', exdates: ['2026-10-17'], ...over });
  const win = { from: D('2026-10-01'), to: D('2026-12-31') };
  const r = sat({ count: 3 });
  assert.deepEqual(fmt(expand_rule(r, win, WK, []).map((o) => o.date)), ['2026-10-10', '2026-10-24'], 'пропуск не «добирает» четвёртую');
  assert.deepEqual(fmt(nominal_dates(r, win.from, win.to)), ['2026-10-10', '2026-10-17', '2026-10-24'], 'nominal_dates exdates не знает');
  assert.deepEqual(fmt(nominal_dates(sat({ count: 10, until_date: '2026-10-24' }), win.from, win.to)), ['2026-10-10', '2026-10-17', '2026-10-24'], 'until раньше count');
  assert.deepEqual(fmt(nominal_dates(sat({ count: 2, until_date: '2026-12-31' }), win.from, win.to)), ['2026-10-10', '2026-10-17'], 'count раньше until');
  // count с окном, начинающимся позже старта: счёт идёт от начала серии
  assert.deepEqual(fmt(nominal_dates(sat({ count: 3, exdates: [] }), D('2026-10-20'), D('2026-12-31'))), ['2026-10-24']);
  // until раньше from / start позже to → пусто
  assert.deepEqual(nominal_dates(sat({ until_date: '2026-10-12' }), D('2026-11-01'), D('2026-12-31')), []);
  assert.deepEqual(nominal_dates(sat({}), D('2026-01-01'), D('2026-10-01')), []);
});

test('TST-12 validate_rule: знак суммы по kind, exp_minor ≠ 0, by_* по freq, неделя с понедельника (C-001, C-002)', () => {
  const ok = validate_rule(mk_rule());
  assert.deepEqual(ok, { ok: true, errors: [] });
  const bad = (over, field) => {
    const v = validate_rule(mk_rule(over));
    assert.equal(v.ok, false, JSON.stringify(over));
    assert.ok(v.errors.every((e) => e.code === 'E_RULE_INVALID'));
    assert.ok(v.errors.some((e) => e.field === field), `поле ${field} в ${JSON.stringify(v.errors)}`);
  };
  bad({ amount: { exp_minor: 10000 } }, 'amount.exp_minor'); // расход с плюсом
  bad({ kind: 'income', amount: { exp_minor: -10000 } }, 'amount.exp_minor'); // доход с минусом
  bad({ amount: { exp_minor: 0 } }, 'amount.exp_minor');
  bad({ amount: { exp_minor: -1.5 } }, 'amount.exp_minor');
  bad({ amount: { exp_minor: -100, min_minor: 50 } }, 'amount.min_minor');
  bad({ amount: { exp_minor: -100, min_minor: -50 } }, 'amount');
  bad({ amount: { exp_minor: -100, max_minor: -200 } }, 'amount');
  bad({ freq: 'M', by_weekday: [1] }, 'by_weekday'); // by_weekday при M
  bad({ freq: 'W', by_monthday: [5] }, 'by_monthday');
  bad({ freq: 'Y', by_monthday: [5] }, 'by_monthday');
  bad({ freq: 'M', by_monthday: [5], by_workday: [3] }, 'by_workday'); // взаимоисключающи
  bad({ freq: 'M', by_monthday: [0] }, 'by_monthday');
  bad({ freq: 'M', by_monthday: [32] }, 'by_monthday');
  bad({ freq: 'M', by_monthday: [] }, 'by_monthday');
  bad({ freq: 'W', by_weekday: [7] }, 'by_weekday');
  bad({ freq: 'Q' }, 'freq');
  bad({ interval: 0 }, 'interval');
  bad({ interval: 1.5 }, 'interval');
  bad({ start_date: '2026-02-30' }, 'start_date');
  bad({ until_date: '2025-12-31' }, 'until_date');
  bad({ count: 0 }, 'count');
  bad({ month_end: 'round' }, 'month_end');
  bad({ weekend: 'later' }, 'weekend');
  bad({ exdates: ['nope'] }, 'exdates');
  bad({ delay_days_worse: -1 }, 'delay_days_worse');
  bad({ rule_id: '' }, 'rule_id');
  bad({ kind: 'transfer' }, 'kind');
  assert.equal(validate_rule(null).ok, false);
  assert.equal(validate_rule(mk_rule({ kind: 'income', amount: { exp_minor: 5, min_minor: 3, max_minor: 9 } })).ok, true);
  assert.equal(validate_rule(mk_rule({ amount: { exp_minor: -100, min_minor: -120, max_minor: -80 } })).ok, true);
  throws_code(() => nominal_dates(mk_rule({ interval: 0 }), 0, 100), 'E_RULE_INVALID');
  throws_code(() => expand_rule(mk_rule({ amount: { exp_minor: 5 } }), { from: 0, to: 100 }, WK, []), 'E_RULE_INVALID');
});

test('TST-12 неделя для by_weekday начинается с понедельника (interval 2, дни [вс, пн])', () => {
  // старт — воскресенье 2026-10-04; блок = неделя пн 09-28…вс 10-04; воскресенье этой недели — 10-04, а следующая «через одну» неделя
  // начинается с понедельника 10-12: пн 10-12 и вс 10-18
  const r = mk_rule({ freq: 'W', interval: 2, by_weekday: [0, 1], start_date: '2026-10-04' });
  assert.deepEqual(fmt(nominal_dates(r, D('2026-10-01'), D('2026-11-15'))), ['2026-10-04', '2026-10-12', '2026-10-18', '2026-10-26', '2026-11-01', '2026-11-09', '2026-11-15']);
});

test('TST-13 by_workday: 3-й рабочий день ноября 2026 → 11-04; последний рабочий октября 2026 → 10-30; без календаря E_SCHEMA', () => {
  const third = mk_rule({ start_date: '2026-10-01', by_workday: [3] });
  assert.deepEqual(fmt(nominal_dates(third, D('2026-11-01'), D('2026-11-30'), WK)), ['2026-11-04']);
  const lastb = mk_rule({ start_date: '2026-10-01', by_workday: [-1] });
  assert.deepEqual(fmt(nominal_dates(lastb, D('2026-10-01'), D('2026-12-31'), WK)), ['2026-10-30', '2026-11-30', '2026-12-31']);
  throws_code(() => nominal_dates(third, D('2026-11-01'), D('2026-11-30')), 'E_SCHEMA');
  throws_code(() => nominal_dates(third, D('2026-11-01'), D('2026-11-30'), null), 'E_SCHEMA');
  // 31 рабочий день не бывает: месяц без вхождения
  const never = mk_rule({ start_date: '2026-10-01', by_workday: [31] });
  assert.deepEqual(nominal_dates(never, D('2026-10-01'), D('2026-12-31'), WK), []);
  // праздник сдвигает счёт
  const hol = make_calendar({ holidays: ['2026-11-03'] });
  assert.deepEqual(fmt(nominal_dates(third, D('2026-11-01'), D('2026-11-30'), hol)), ['2026-11-05']);
  // два n в одном месяце
  const two = mk_rule({ start_date: '2026-10-01', by_workday: [1, -1] });
  assert.deepEqual(fmt(nominal_dates(two, D('2026-11-01'), D('2026-11-30'), WK)), ['2026-11-02', '2026-11-30']);
});

test('TST-14 «раз в 2 недели» от 2026-10-02 (пятница): 10-02, 10-16, 10-30, 11-13; W по дням [пн, ср] от 2026-10-05', () => {
  const bi = mk_rule({ freq: 'W', interval: 2, start_date: '2026-10-02' });
  assert.deepEqual(fmt(nominal_dates(bi, D('2026-10-01'), D('2026-11-20'))), ['2026-10-02', '2026-10-16', '2026-10-30', '2026-11-13']);
  const r = mk_rule({ freq: 'W', interval: 2, by_weekday: [1, 3], start_date: '2026-10-05' });
  assert.deepEqual(fmt(nominal_dates(r, D('2026-10-01'), D('2026-11-10'))), ['2026-10-05', '2026-10-07', '2026-10-19', '2026-10-21', '2026-11-02', '2026-11-04']);
  // окно начинается позже старта — те же даты (first_block)
  assert.deepEqual(fmt(nominal_dates(r, D('2026-10-20'), D('2026-11-10'))), ['2026-10-21', '2026-11-02', '2026-11-04']);
  // D: каждые 10 дней
  const dd = mk_rule({ freq: 'D', interval: 10, start_date: '2026-10-01' });
  assert.deepEqual(fmt(nominal_dates(dd, D('2026-10-15'), D('2026-11-15'))), ['2026-10-21', '2026-10-31', '2026-11-10']);
});

test('TST-14 override по occ_key: move не меняет ключ; skip; set_amount; повтор ключа — побеждает последний; индекс = массив', () => {
  const rent = g001_rules().find((r) => r.rule_id === 'R-RENT');
  const win = { from: G001.as_of, to: G001.horizon_end };
  const mv = { rule_id: 'R-RENT', nominal_date: '2026-11-25', action: 'move', date: '2026-11-27' };
  const got = expand_rule(rent, win, WK, [mv]);
  assert.deepEqual(got.map((o) => [o.occ_key, format_date(o.date), o.overridden]),
    [['R-RENT@2026-10-25', '2026-10-26', false], ['R-RENT@2026-11-25', '2026-11-27', true]]);
  assert.equal(occ_key('R-RENT', D('2026-11-25')), 'R-RENT@2026-11-25');
  assert.equal(format_date(effective_date(rent, D('2026-11-25'), WK, [mv])), '2026-11-27');
  assert.equal(format_date(effective_date(rent, D('2026-10-25'), WK, [mv])), '2026-10-26', 'без правки — обычный сдвиг выходных');
  // индекс по occ_key (Map и объект) = массив
  const idx = index_overrides([mv]);
  assert.ok(idx instanceof Map && idx.get('R-RENT@2026-11-25') === mv);
  assert.equal(format_date(effective_date(rent, D('2026-11-25'), WK, idx)), '2026-11-27');
  assert.equal(format_date(effective_date(rent, D('2026-11-25'), WK, { 'R-RENT@2026-11-25': mv })), '2026-11-27');
  // повтор ключа — побеждает последний
  const mv2 = { ...mv, date: '2026-11-30' };
  assert.equal(format_date(effective_date(rent, D('2026-11-25'), WK, [mv, mv2])), '2026-11-30');
  assert.equal(format_date(effective_date(rent, D('2026-11-25'), WK, [mv2, mv])), '2026-11-27');
  // move на выходной день — без повторного сдвига
  const to_sat = { ...mv, date: '2026-11-28' };
  assert.equal(format_date(effective_date(rent, D('2026-11-25'), WK, [to_sat])), '2026-11-28');
  // skip
  const sk = { rule_id: 'R-RENT', nominal_date: '2026-10-25', action: 'skip' };
  assert.equal(effective_date(rent, D('2026-10-25'), WK, [sk]), null);
  assert.deepEqual(expand_rule(rent, win, WK, [sk]).map((o) => o.occ_key), ['R-RENT@2026-11-25']);
  // set_amount: дату не трогает, коридор снимается
  const corr = { ...rent, amount: { exp_minor: -90000, min_minor: -95000, max_minor: -85000 } };
  const sa = { rule_id: 'R-RENT', nominal_date: '2026-10-25', action: 'set_amount', amount_minor: -91000 };
  const g2 = expand_rule(corr, win, WK, [sa]);
  assert.equal(g2[0].amount_minor, -91000);
  assert.equal(g2[0].amount_min_minor, undefined);
  assert.equal(format_date(g2[0].date), '2026-10-26');
  assert.equal(g2[1].amount_min_minor, -95000);
  // override чужого правила и несуществующей номинальной даты игнорируется
  const other = { rule_id: 'R-OTHER', nominal_date: '2026-11-25', action: 'skip' };
  const ghost = { rule_id: 'R-RENT', nominal_date: '2026-11-26', action: 'skip' };
  assert.equal(expand_rule(rent, win, WK, [other, ghost]).length, 2);
  throws_code(() => index_overrides([{ rule_id: 'R-RENT', nominal_date: '2026-11-25', action: 'delete' }]), 'E_SCHEMA');
  throws_code(() => effective_date(rent, D('2026-11-25'), WK, [{ ...mv, date: undefined }]), 'E_SCHEMA');
});

test('TST-14 override переносит вхождение через границу окна: перенос в окно и из окна', () => {
  const rule = mk_rule({ start_date: '2026-01-25', by_monthday: [25], weekend: 'keep' });
  // номинальная 12-25 уезжает на 11-20 (внутрь окна ноября), хотя номинальная вне окна
  const mv = { rule_id: 'R-TEST', nominal_date: '2026-12-25', action: 'move', date: '2026-11-20' };
  const nov = { from: D('2026-11-01'), to: D('2026-11-30') };
  assert.deepEqual(expand_rule(rule, nov, WK, [mv]).map((o) => [o.occ_key, format_date(o.date)]),
    [['R-TEST@2026-12-25', '2026-11-20'], ['R-TEST@2026-11-25', '2026-11-25']]);
  // номинальная 11-25 уезжает за окно — исчезает из ноября
  const out = { rule_id: 'R-TEST', nominal_date: '2026-11-25', action: 'move', date: '2027-02-02' };
  assert.deepEqual(expand_rule(rule, nov, WK, [out]), []);
  const feb = { from: D('2027-02-01'), to: D('2027-02-28') };
  assert.deepEqual(expand_rule(rule, feb, WK, [out]).map((o) => [o.occ_key, format_date(o.date)]), [['R-TEST@2026-11-25', '2027-02-02'], ['R-TEST@2027-02-25', '2027-02-25']]);
});

test('TST-14 два вхождения в один день не теряются (суммирует проекция, не развёртка)', () => {
  const rules = g001_rules();
  const got = expand_all(rules, { from: D('2026-10-26'), to: D('2026-10-26') }, {}, []);
  assert.deepEqual(got.map((o) => [o.rule_id, o.amount_minor]), [['R-RENT', -90000], ['R-UTIL', -12000]],
    'порядок внутри дня — по (date, amount_minor, occ_key): −90000 раньше −12000');
  const same = [mk_rule({ rule_id: 'A', start_date: '2026-10-05', by_monthday: [5] }), mk_rule({ rule_id: 'B', start_date: '2026-10-05', by_monthday: [5] })];
  assert.equal(expand_all(same, { from: D('2026-10-05'), to: D('2026-10-05') }, {}, []).length, 2);
});

test('TV1 G-001 (горизонт 57 дн.): 14 вхождений, номинальные и эффективные даты, Σ = −289000', () => {
  const win = { from: G001.as_of, to: G001.horizon_end };
  assert.equal(win.to - win.from + 1, 58, 'N = 58 дней сетки');
  const got = expand_all(g001_rules(), win, {}, []);
  assert.equal(got.length, 14);
  const by = (id) => got.filter((o) => o.rule_id === id);
  assert.deepEqual(by('R-RENT').map((o) => [format_date(o.nominal), format_date(o.date)]), [['2026-10-25', '2026-10-26'], ['2026-11-25', '2026-11-25']]);
  assert.deepEqual(by('R-UTIL').map((o) => [format_date(o.nominal), format_date(o.date)]), [['2026-10-25', '2026-10-26'], ['2026-11-25', '2026-11-25']]);
  assert.deepEqual(by('R-PHONE').map((o) => format_date(o.date)), ['2026-10-09', '2026-11-09']);
  assert.deepEqual(by('R-GROC').map((o) => format_date(o.date)),
    ['2026-10-10', '2026-10-17', '2026-10-24', '2026-10-31', '2026-11-07', '2026-11-14', '2026-11-21', '2026-11-28']);
  assert.equal(got.reduce((a, o) => a + o.amount_minor, 0), -289000);
  assert.equal(got.reduce((a, o) => a + o.amount_minor, 0) - 50000, -339000, 'вместе с налоговым платежом P-TAX1 −50000 итог −339000');
  assert.equal(by('R-RENT')[0].is_obligation, true);
  assert.equal(by('R-GROC')[0].is_estimate, true);
  assert.equal(by('R-GROC')[0].kind, 'expense');
  assert.equal(by('R-RENT')[0].currency, 'EUR');
  assert.equal(by('R-RENT')[0].tag, 'аренда');
  // dow(20751) = 0: 10-25 — воскресенье, 11-25 — среда
  assert.equal(dow(D('2026-10-25')), 0);
  assert.equal(dow(D('2026-11-25')), 3);
  // порядок правил на результат не влияет (детерминизм)
  const rev = expand_all([...g001_rules()].reverse(), win, {}, []);
  assert.deepEqual(rev, got);
  // отсортировано по (date, amount_minor, occ_key)
  for (let i = 1; i < got.length; i++) assert.ok(got[i - 1].date <= got[i].date);
});

test('TV3 выходные и праздники: M, by_monthday [25], декабрь 2026, праздники 12-25 и 12-28 → next 12-29, prev 12-24, keep 12-25, skip — пусто', () => {
  const cal = make_calendar({ holidays: ['2026-12-25', '2026-12-28'] });
  const win = { from: D('2026-12-01'), to: D('2026-12-31') };
  const dates = (weekend) => expand_rule(mk_rule({ start_date: '2026-01-25', by_monthday: [25], weekend }), win, cal, []).map((o) => format_date(o.date));
  assert.deepEqual(dates('next'), ['2026-12-29']);
  assert.deepEqual(dates('prev'), ['2026-12-24']);
  assert.deepEqual(dates('keep'), ['2026-12-25']);
  assert.deepEqual(dates('skip'), []);
  assert.equal(cal.max_shift, 4);
  // by_monthday [24, 25], prev, оба на выходных → два вхождения в один день (ключи разные)
  const two = expand_rule(mk_rule({ start_date: '2026-01-24', by_monthday: [24, 25], weekend: 'prev' }), { from: D('2026-10-01'), to: D('2026-10-31') }, WK, []);
  assert.deepEqual(two.map((o) => [o.occ_key, format_date(o.date)]), [['R-TEST@2026-10-24', '2026-10-23'], ['R-TEST@2026-10-25', '2026-10-23']]);
});

test('TV4 номинальная вне окна, эффективная внутри: 31 октября (суббота), weekend = next → 11-02 в окне ноября (pad)', () => {
  const r = mk_rule({ start_date: '2026-01-31', weekend: 'next' });
  const nov = { from: D('2026-11-01'), to: D('2026-11-30') };
  const got = expand_rule(r, nov, WK, []);
  assert.deepEqual(got.map((o) => [o.occ_key, format_date(o.date)]), [['R-TEST@2026-10-31', '2026-11-02'], ['R-TEST@2026-11-30', '2026-11-30']]);
  // и наоборот: weekend = prev, номинальная 2026-11-01 (воскресенье) уезжает на 10-30 — выпадает из окна ноября
  const p = mk_rule({ start_date: '2026-01-01', weekend: 'prev' });
  assert.deepEqual(expand_rule(p, nov, WK, []), [], '11-01 — воскресенье, prev → 10-30: из окна ноября выпадает');
  assert.equal(expand_rule(p, { from: D('2026-10-30'), to: D('2026-10-30') }, WK, []).length, 1);
  assert.equal(expand_rule(p, { from: D('2026-11-01'), to: D('2026-11-01') }, WK, []).length, 0);
});

test('weekend = skip: нерабочая номинальная дата не даёт вхождения, но занимает номер в count', () => {
  const r = mk_rule({ freq: 'W', start_date: '2026-10-03', weekend: 'skip', count: 3 }); // суббота, суббота, суббота
  assert.deepEqual(expand_rule(r, { from: D('2026-09-01'), to: D('2026-12-31') }, WK, []), []);
  // номер в count занят пропущенной датой: пт+сб, count = 4 → номинальные 10-02, 10-03, 10-09, 10-10; сб пропущены
  const fs = mk_rule({ freq: 'W', by_weekday: [5, 6], start_date: '2026-10-02', weekend: 'skip', count: 4 });
  assert.deepEqual(expand_rule(fs, { from: D('2026-10-01'), to: D('2026-12-31') }, WK, []).map((o) => format_date(o.date)), ['2026-10-02', '2026-10-09']);
  assert.deepEqual(fmt(nominal_dates(fs, D('2026-10-01'), D('2026-12-31'))), ['2026-10-02', '2026-10-03', '2026-10-09', '2026-10-10']);
  const m = mk_rule({ start_date: '2026-01-25', by_monthday: [25], weekend: 'skip' });
  assert.deepEqual(expand_rule(m, { from: D('2026-10-01'), to: D('2026-12-31') }, WK, []).map((o) => format_date(o.date)), ['2026-11-25', '2026-12-25'], '10-25 — воскресенье (пропуск); 11-25 среда и 12-25 пятница — рабочие');
});

test('expand_all: календари по calendar_id (объект / Map / массив), null → суббота и воскресенье, неизвестный → E_SCHEMA', () => {
  const r = mk_rule({ start_date: '2026-01-25', by_monthday: [25], weekend: 'next', calendar_id: 'cal_x' });
  const win = { from: D('2026-12-01'), to: D('2026-12-31') };
  const cal = make_calendar({ holidays: ['2026-12-25', '2026-12-28'] });
  const want = ['2026-12-29'];
  assert.deepEqual(expand_all([r], win, { cal_x: cal }, []).map((o) => format_date(o.date)), want);
  assert.deepEqual(expand_all([r], win, new Map([['cal_x', cal]]), []).map((o) => format_date(o.date)), want);
  assert.deepEqual(expand_all([r], win, [{ ...cal, calendar_id: 'cal_x' }], []).map((o) => format_date(o.date)), want);
  throws_code(() => expand_all([r], win, {}, []), 'E_SCHEMA');
  throws_code(() => expand_all([r], win, null, []), 'E_SCHEMA');
  const none = mk_rule({ start_date: '2026-01-25', by_monthday: [25], weekend: 'next', calendar_id: null });
  assert.deepEqual(expand_all([none], win, {}, []).map((o) => format_date(o.date)), ['2026-12-25']);
  // календарь из состояния журнала: «сырой» объект без max_shift
  const raw = { calendar_id: 'cal_x', weekend_dows: [0, 6], holidays: ['2026-12-25', '2026-12-28'] };
  assert.deepEqual(expand_all([r], win, { cal_x: raw }, []).map((o) => format_date(o.date)), want);
  throws_code(() => nominal_dates(mk_rule({ by_workday: [1] }), 0, 10), 'E_SCHEMA');
  throws_code(() => expand_rule(mk_rule({ weekend: 'next' }), { from: 0, to: 100 }, null, []), 'E_SCHEMA');
});

test('occurrence: поля правила переносятся, коридор суммы и необязательные поля', () => {
  const r = mk_rule({
    kind: 'income', amount: { exp_minor: 279000, min_minor: 240000, max_minor: 330000 }, start_date: '2026-10-05', by_monthday: [5],
    counterparty_id: 'cp1', delay_days_worse: 3, reserve_id: 'RES-X', is_obligation: true, tag: 'доход',
  });
  const [o] = expand_rule(r, { from: D('2026-11-01'), to: D('2026-11-30') }, WK, []);
  assert.equal(o.amount_minor, 279000);
  assert.equal(o.amount_min_minor, 240000);
  assert.equal(o.amount_max_minor, 330000);
  assert.equal(o.counterparty_id, 'cp1');
  assert.equal(o.delay_days_worse, 3);
  assert.equal(o.reserve_id, 'RES-X');
  assert.equal(o.kind, 'income');
  assert.equal(o.is_obligation, true);
  assert.equal(o.overridden, false);
  assert.equal(o.account_id, 'acc_main');
  assert.equal(format_date(o.nominal), '2026-11-05');
  const [p] = expand_rule(mk_rule({ start_date: '2026-10-05', by_monthday: [5] }), { from: D('2026-11-01'), to: D('2026-11-30') }, WK, []);
  assert.ok(!('amount_min_minor' in p) && !('delay_days_worse' in p) && !('reserve_id' in p));
});

// ── TST-51: фаззинг правил против «грубого» оракула (день за днём, Date UTC) ──────

/** Оракул: перебирает каждый день от старта до `to` и применяет определение правила буквально. */
function brute_nominals(r, to) {
  const s = D(r.start_date);
  const out = [];
  const monday_of = (z) => z - ((new Date(z * 86400000).getUTCDay() + 6) % 7);
  const month_index = (z) => { const dt = new Date(z * 86400000); return dt.getUTCFullYear() * 12 + dt.getUTCMonth(); };
  const s_mon = monday_of(s);
  const s_mi = month_index(s);
  for (let z = s; z <= to; z++) {
    const dt = new Date(z * 86400000);
    const dom = dt.getUTCDate();
    const dim = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
    let hit = false;
    if (r.freq === 'D') hit = (z - s) % r.interval === 0;
    else if (r.freq === 'W') {
      if (r.by_weekday == null) hit = (z - s) % (7 * r.interval) === 0;
      else hit = Math.floor((z - s_mon) / 7) % r.interval === 0 && r.by_weekday.includes(dt.getUTCDay());
    } else if (r.freq === 'M' && r.by_monthday == null) {
      const [, , d0] = civil_from_days(s);
      const mdiff = month_index(z) - s_mi;
      hit = mdiff % r.interval === 0 && (dom === d0 || (d0 > dim && dom === dim));
    } else if (r.freq === 'M') {
      const mdiff = month_index(z) - s_mi;
      hit = mdiff % r.interval === 0 && r.by_monthday.some((v) => (v > 0 ? (v <= dim ? dom === v : dom === dim) : dom === dim + 1 + v));
    } else { // Y
      const ydiff = dt.getUTCFullYear() - new Date(s * 86400000).getUTCFullYear();
      const [, ms, d0] = civil_from_days(s);
      hit = ydiff % r.interval === 0 && dt.getUTCMonth() + 1 === ms && (dom === d0 || (d0 > dim && dom === dim));
    }
    if (hit) out.push(z);
  }
  let res = out;
  if (r.until_date != null) res = res.filter((z) => z <= D(r.until_date));
  if (r.count != null) res = res.slice(0, r.count);
  return res;
}

function random_rule(rng) {
  const freq = rng.pick(['D', 'W', 'M', 'Y']);
  const r = mk_rule({ freq, interval: rng.int(1, freq === 'D' ? 40 : 4), start_date: format_date(rng.int(D('2025-01-01'), D('2026-12-31'))) });
  if (freq === 'W' && rng.bool()) r.by_weekday = [...new Set(Array.from({ length: rng.int(1, 4) }, () => rng.int(0, 6)))];
  if (freq === 'M' && rng.bool()) r.by_monthday = [...new Set(Array.from({ length: rng.int(1, 3) }, () => rng.pick([1, 5, 15, 28, 29, 30, 31, -1])))].filter((v) => v !== -1);
  if (r.by_monthday && r.by_monthday.length === 0) delete r.by_monthday;
  if (freq === 'M' && r.by_monthday == null && rng.bool()) r.start_date = `2026-${String(rng.int(1, 12)).padStart(2, '0')}-${String(rng.pick([28, 29, 30, 31])).padStart(2, '0')}`;
  if (r.start_date.slice(5) === '02-29' || !(() => { try { D(r.start_date); return true; } catch { return false; } })()) r.start_date = '2026-01-31';
  if (rng.int(0, 3) === 0) r.count = rng.int(1, 12);
  if (rng.int(0, 3) === 0) { const u = D(r.start_date) + rng.int(0, 900); r.until_date = format_date(u); }
  return r;
}

test('TST-51 nominal_dates против оракула «день за днём» на 600 случайных правилах (D/W/M/Y, interval, by_*, count, until)', () => {
  const rng = make_rng(2026_10_04);
  let non_empty = 0;
  for (let i = 0; i < 600; i++) {
    const r = random_rule(rng);
    const to = D(r.start_date) + 1100;
    const want = brute_nominals(r, to);
    const got = nominal_dates(r, D(r.start_date) - 30, to);
    assert.deepEqual(got, want, `правило ${JSON.stringify(r)}`);
    if (want.length) non_empty++;
  }
  assert.ok(non_empty > 500);
});

test('TST-51 свойства окон: склейка nominal_dates(a, c) = (a, b) ++ (b+1, c) = срез от (−∞, c); строгий порядок; count', () => {
  const rng = make_rng(4004);
  for (let i = 0; i < 400; i++) {
    const r = random_rule(rng);
    const s = D(r.start_date);
    const c = s + rng.int(0, 1200);
    const a = s + rng.int(-60, 600);
    const b = a + rng.int(0, 400);
    const full = nominal_dates(r, a, c);
    const split = [...nominal_dates(r, a, Math.min(b, c)), ...nominal_dates(r, Math.min(b, c) + 1, c)];
    assert.deepEqual(split, full, JSON.stringify(r));
    const from0 = nominal_dates(r, -1e6, c).filter((x) => x >= a);
    assert.deepEqual(from0, full);
    for (let k = 1; k < full.length; k++) assert.ok(full[k] > full[k - 1], 'строго возрастает');
    if (r.count != null) assert.ok(nominal_dates(r, -1e6, 1e6).length <= r.count);
  }
});

test('TST-51 инварианты expand_rule: набор occ_key не зависит от weekend и разбиения окна; локальность override; 0 ≤ d − n ≤ max_shift', () => {
  const rng = make_rng(777);
  const cal = make_calendar({ weekend_dows: [0, 6], holidays: ['2026-12-25', '2026-12-28', '2027-01-01'] });
  for (let i = 0; i < 200; i++) {
    const base = random_rule(rng);
    base.start_date = format_date(D('2026-01-01') + rng.int(0, 300));
    delete base.count; delete base.until_date;
    const win = { from: D('2026-09-01'), to: D('2027-02-28') };
        const next_occ = expand_rule({ ...base, weekend: 'next' }, win, cal, []);
    // 0 ≤ d − n ≤ max_shift и рабочий день
    for (const o of next_occ) assert.ok(o.date - o.nominal >= 0 && o.date - o.nominal <= cal.max_shift);
    // набор occ_key не зависит от политики выходных: во внутренней части окна (отступ max_shift) ключи keep = next = prev
    const inner = (weekend) => expand_rule({ ...base, weekend }, win, cal, [])
      .filter((o) => o.nominal >= win.from + cal.max_shift && o.nominal <= win.to - cal.max_shift && o.date >= win.from && o.date <= win.to)
      .map((o) => o.occ_key);
    const nominal_inner = nominal_dates(base, win.from + cal.max_shift, win.to - cal.max_shift, cal).map((n) => occ_key(base.rule_id, n));
    assert.deepEqual(inner('keep'), nominal_inner);
    assert.deepEqual(inner('next'), nominal_inner);
    assert.deepEqual(inner('prev'), nominal_inner);
    // разбиение окна: объединение вхождений половин = вхождения целого
    const mid = D('2026-12-01');
    const left = expand_rule({ ...base, weekend: 'next' }, { from: win.from, to: mid - 1 }, cal, []);
    const right = expand_rule({ ...base, weekend: 'next' }, { from: mid, to: win.to }, cal, []);
    assert.deepEqual([...left, ...right].map((o) => o.occ_key).sort(), next_occ.map((o) => o.occ_key).sort());
    // локальность override: правка одного ключа меняет только это вхождение
    if (next_occ.length > 0) {
      const target = rng.pick(next_occ);
      const ov = { rule_id: base.rule_id, nominal_date: format_date(target.nominal), action: 'set_amount', amount_minor: -777 };
      const changed = expand_rule({ ...base, weekend: 'next' }, win, cal, [ov]);
      assert.equal(changed.length, next_occ.length);
      const diff = changed.filter((o) => !next_occ.some((p) => JSON.stringify(p) === JSON.stringify(o)));
      assert.equal(diff.length, 1);
      assert.equal(diff[0].occ_key, target.occ_key);
    }
  }
});

test('TST-51 fuzz: ключи вхождений M/31 совпадают с add_months(start, k) на горизонте 10 лет, без исключений', () => {
  for (const start of ['2026-01-31', '2026-03-30', '2024-02-29', '2026-08-29']) {
    const r = mk_rule({ start_date: start });
    const got = nominal_dates(r, D(start), D('2036-12-31'));
    got.forEach((z, k) => assert.equal(z, add_months(D(start), k), `${start} k=${k}`));
    assert.ok(got.length >= 120);
    for (const z of got) assert.ok(civil_from_days(z).d <= days_in_month(civil_from_days(z).y, civil_from_days(z).m));
  }
});
