// fx.test.mjs — TST-27 (FX: перевод, сценарий −5 %, выведенный курс), TST-28 (FX: крипта, сатоши → EUR), TST-51/53 (фаззинг и оракул convert_minor).
// Числа — design-brief §9.12, D-20, ALG-08 TV-1…TV-7; C-034…C-037 (сигнатуры, обратная пара, несократимые производные курсы).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  convert_minor, implied_rate, rate_at, apply_shock, normalize_policy, to_decision, to_decision_events, opening_in_decision,
  exchange_difference, liquid_value, rate_status,
} from '../engine/fx.mjs';
import { parse_date, format_date } from '../engine/dates.mjs';
import { make_rng, throws_code, rand_safe } from './helpers.mjs';

const d = parse_date;
const AS_OF = d('2026-10-04');
const rate = (fx_id, date, base, quote, num, den) => ({ fx_id, date: d(date), base, quote, num, den });
const USD_EUR = rate('fx1', '2026-10-04', 'USD', 'EUR', 9250, 10000);

const EUR = { account_id: 'acc_main', kind: 'bank', liquidity: 'operating', currency: 'EUR' };
const USD = { account_id: 'acc_usd', kind: 'bank', liquidity: 'operating', currency: 'USD' };
const USD_SAVE = { account_id: 'acc_usd_save', kind: 'bank', liquidity: 'savings', currency: 'USD' };
const CTX = { rates: [USD_EUR], decision_currency: 'EUR', policy: 'spot', rounding: 'half_even' };

/** Эталон деления с округлением на BigInt (независимо от money.mjs). */
function oracle_div(n, dd, mode) {
  let q = n / dd;
  let r = n % dd;
  if (r < 0n) { q -= 1n; r += dd; }
  if (mode === 'floor') return q;
  if (mode === 'ceil') return r > 0n ? q + 1n : q;
  const t = 2n * r;
  if (t < dd) return q;
  if (t > dd) return q + 1n;
  if (mode === 'half_up') return n >= 0n ? q + 1n : q;
  return q % 2n === 0n ? q : q + 1n;
}

const same_rate = (a, b) => BigInt(a.num) * BigInt(b.den) === BigInt(b.num) * BigInt(a.den);

// ── TST-27: перевод, сценарий −5 %, выведенный курс ────────────────────────────

test('TST-27 convert_minor: spot 0,9250 — 200000 ($) → 185000 (1 850,00 €), остатка нет', () => {
  assert.equal(convert_minor(200000, 2, 2, 9250, 10000), 185000);
  assert.equal(convert_minor(200000, 2, 2, 9250, 10000, 'half_up'), 185000);
  assert.equal(convert_minor(0, 2, 2, 9250, 10000), 0);
  assert.equal(convert_minor(-200000, 2, 2, 9250, 10000), -185000);
});

test('TST-27 сценарий −5 %: apply_shock({9250/10000}, −500) = 703/800 (gcd 125000); convert → 175750 (−92,50 €)', () => {
  const r = apply_shock({ num: 9250, den: 10000, date: AS_OF }, -500);
  assert.deepEqual(r, { num: 703, den: 800, date: AS_OF });
  assert.equal(convert_minor(200000, 2, 2, r.num, r.den), 175750);
  assert.equal(175750 - 185000, -9250);
  // производный курс — несократимая дробь; введённый хранится как введён (9250/10000 не трогается)
  assert.deepEqual(USD_EUR, { fx_id: 'fx1', date: AS_OF, base: 'USD', quote: 'EUR', num: 9250, den: 10000 });
  // apply_shock(r, 0) равен r по значению; монотонность по bp; bp ≤ −10000 → E_SCHEMA
  assert.ok(same_rate(apply_shock(USD_EUR, 0), USD_EUR));
  assert.ok(apply_shock(USD_EUR, 100).num * apply_shock(USD_EUR, 200).den < apply_shock(USD_EUR, 200).num * apply_shock(USD_EUR, 100).den);
  throws_code(() => apply_shock(USD_EUR, -10000), 'E_SCHEMA');
  throws_code(() => apply_shock(USD_EUR, -20000), 'E_SCHEMA');
  throws_code(() => apply_shock(USD_EUR, 1.5), 'E_SCHEMA');
  throws_code(() => apply_shock({ num: 0, den: 1 }, 5), 'E_SCHEMA');
});

test('TST-27 implied_rate: продано 200000 ($), получено 184240 (€) → 184240/200000 = 2303/2500 (0,9212); обратная проверка без потерь', () => {
  const r = implied_rate(200000, 184240, 2, 2);
  assert.deepEqual(r, { num: 2303, den: 2500 });
  assert.equal(convert_minor(200000, 2, 2, r.num, r.den), 184240, 'инв. 4 ALG-08');
  assert.equal(exchange_difference(200000, 184240, 2, 2, { num: 9250, den: 10000 }), 760, '185000 − 184240: получено меньше, чем по spot, на 7,60 €');
  assert.equal(exchange_difference(200000, 185000, 2, 2, { num: 9250, den: 10000 }), 0);
  assert.equal(exchange_difference(200000, 190000, 2, 2, { num: 9250, den: 10000 }), -5000);
  throws_code(() => implied_rate(0, 100, 2, 2), 'E_SCHEMA');
  throws_code(() => implied_rate(100, 0, 2, 2), 'E_SCHEMA');
  throws_code(() => implied_rate(-100, 100, 2, 2), 'E_SCHEMA');
  throws_code(() => implied_rate(100, 100, -1, 2), 'E_SCHEMA');
  // разные экспоненты: 10000 JPY → 6200 minor EUR при 62/10000 за иену (экспоненты 0 и 2)
  const jp = implied_rate(10000, 6200, 0, 2);
  assert.deepEqual(jp, { num: 31, den: 5000 }, '0,0062 EUR за иену');
  assert.equal(convert_minor(10000, 0, 2, jp.num, jp.den), 6200);
  assert.ok(same_rate(jp, { num: 62, den: 10000 }));
  throws_code(() => implied_rate(1, Number.MAX_SAFE_INTEGER, 8, 0), 'E_OVERFLOW');
});

test('TST-27 ALG-08 TV-6: выбор курса — прямой ≤ as_of 10-01 уступает более позднему обратному 10-03; запись 10-10 игнорируется; результат не зависит от порядка rates', () => {
  const rates = [
    rate('a', '2026-08-20', 'USD', 'EUR', 9250, 10000),
    rate('b', '2026-10-01', 'USD', 'EUR', 9100, 10000),
    rate('c', '2026-10-03', 'EUR', 'USD', 10900, 10000),
    rate('e', '2026-10-10', 'USD', 'EUR', 9300, 10000),
  ];
  const r = rate_at(rates, 'USD', 'EUR', AS_OF, 'spot');
  assert.deepEqual(r, { num: 10000, den: 10900, date: d('2026-10-03'), inverse: true });
  assert.equal(convert_minor(200000, 2, 2, r.num, r.den), 183486, '2 000 000 000 / 10900 = 183486,24');
  const rng = make_rng(3);
  for (let k = 0; k < 20; k++) {
    const sh = rates.map((x) => [rng.next(), x]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
    assert.deepEqual(rate_at(sh, 'USD', 'EUR', AS_OF, 'spot'), r, 'инв. 7: порядок rates не влияет');
  }
  // на дату 10-10 побеждает новый прямой; на 10-02 — прямой 10-01 (обратный 10-03 «из будущего»)
  assert.deepEqual(rate_at(rates, 'USD', 'EUR', d('2026-10-10'), 'spot'), { num: 9300, den: 10000, date: d('2026-10-10'), inverse: false });
  assert.deepEqual(rate_at(rates, 'USD', 'EUR', d('2026-10-02'), 'spot'), { num: 9100, den: 10000, date: d('2026-10-01'), inverse: false });
  // при равной дате прямой курс приоритетнее обратного (C-036)
  const tie = [rate('x', '2026-10-03', 'USD', 'EUR', 9000, 10000), rate('y', '2026-10-03', 'EUR', 'USD', 10000, 9000)];
  assert.deepEqual(rate_at(tie, 'USD', 'EUR', AS_OF, 'spot'), { num: 9000, den: 10000, date: d('2026-10-03'), inverse: false });
  // из двух курсов одной даты побеждает больший fx_id; даты в виде IsoDate допустимы
  const two = [{ fx_id: 'a1', date: '2026-10-03', base: 'USD', quote: 'EUR', num: 1, den: 2 }, { fx_id: 'a2', date: '2026-10-03', base: 'USD', quote: 'EUR', num: 3, den: 4 }];
  assert.deepEqual(rate_at(two, 'USD', 'EUR', '2026-10-04', 'spot'), { num: 3, den: 4, date: d('2026-10-03'), inverse: false });
  assert.deepEqual(rate_at([...two].reverse(), 'USD', 'EUR', AS_OF, 'spot'), { num: 3, den: 4, date: d('2026-10-03'), inverse: false });
});

test('TST-27 rate_at: валюта = валюте → 1/1; нет пары, курс «из будущего», триангуляция → null; to_decision кидает E_NO_RATE (REQ-077)', () => {
  assert.deepEqual(rate_at([], 'EUR', 'EUR', AS_OF, 'spot'), { num: 1, den: 1, date: AS_OF, inverse: false });
  assert.equal(rate_at([], 'USD', 'EUR', AS_OF, 'spot'), null);
  assert.equal(rate_at([rate('f', '2026-10-05', 'USD', 'EUR', 9, 10)], 'USD', 'EUR', AS_OF, 'spot'), null, 'курс датирован после as_of');
  // USD→RUB через EUR: триангуляции нет
  const tri = [rate('1', '2026-10-01', 'USD', 'EUR', 9, 10), rate('2', '2026-10-01', 'EUR', 'RUB', 100, 1)];
  assert.equal(rate_at(tri, 'USD', 'RUB', AS_OF, 'spot'), null);
  throws_code(() => to_decision(100, 'USD', AS_OF, { ...CTX, rates: tri, decision_currency: 'RUB' }), 'E_NO_RATE');
  throws_code(() => to_decision(100, 'USD', AS_OF, { ...CTX, rates: [] }), 'E_NO_RATE');
  throws_code(() => rate_at([rate('z', '2026-10-01', 'USD', 'EUR', 0, 1)], 'USD', 'EUR', AS_OF, 'spot'), 'E_SCHEMA');
});

test('normalize_policy: строка spot → запись; идемпотентна; shock и rounding; native/adverse — E_SCHEMA (v2)', () => {
  const p = normalize_policy('spot', AS_OF);
  assert.deepEqual(p, { kind: 'spot', as_of: AS_OF, shock: {}, rounding: 'half_even' });
  assert.deepEqual(normalize_policy(p, d('2027-01-01')), p, 'идемпотентна: as_of записи сохраняется');
  assert.deepEqual(normalize_policy({ kind: 'spot', shock: { USD: -500 }, rounding: 'half_up' }, '2026-10-04'), { kind: 'spot', as_of: AS_OF, shock: { USD: -500 }, rounding: 'half_up' });
  throws_code(() => normalize_policy({ kind: 'native' }, AS_OF), 'E_SCHEMA');
  throws_code(() => normalize_policy('adverse', AS_OF), 'E_SCHEMA');
  throws_code(() => normalize_policy(null, AS_OF), 'E_SCHEMA');
  throws_code(() => normalize_policy({ kind: 'spot', rounding: 'banker' }, AS_OF), 'E_SCHEMA');
  throws_code(() => normalize_policy({ kind: 'spot', shock: { USD: -10000 } }, AS_OF), 'E_SCHEMA');
  throws_code(() => normalize_policy('spot'), 'E_BAD_DATE');
  const src = { kind: 'spot', as_of: AS_OF, shock: { USD: 5 } };
  normalize_policy(src, AS_OF).shock.USD = 99;
  assert.equal(src.shock.USD, 5, 'вход не мутируется');
});

test('to_decision: валюта решения — без курса; spot с as_of; сценарий курса policy.shock; режим округления ctx.rounding', () => {
  assert.deepEqual(to_decision(12345, 'EUR', AS_OF, CTX), { amount_minor: 12345, rate: null });
  const r = to_decision(200000, 'USD', AS_OF, CTX);
  assert.equal(r.amount_minor, 185000);
  assert.deepEqual(r.rate, { num: 9250, den: 10000, date: AS_OF, inverse: false });
  const shocked = to_decision(200000, 'USD', AS_OF, { ...CTX, policy: { kind: 'spot', as_of: AS_OF, shock: { USD: -500 } } });
  assert.equal(shocked.amount_minor, 175750);
  assert.deepEqual([shocked.rate.num, shocked.rate.den], [703, 800]);
  assert.equal(to_decision(200000, 'EUR', AS_OF, { ...CTX, policy: { kind: 'spot', as_of: AS_OF, shock: { USD: -500 } } }).amount_minor, 200000, 'сдвиг только указанной валюты');
  // ничья: 1 · 1/2 → 0,5
  const half = { ...CTX, rates: [rate('h', '2026-10-01', 'USD', 'EUR', 1, 2)] };
  assert.equal(to_decision(1, 'USD', AS_OF, { ...half, rounding: 'half_even' }).amount_minor, 0);
  assert.equal(to_decision(1, 'USD', AS_OF, { ...half, rounding: 'half_up' }).amount_minor, 1);
  assert.equal(to_decision(-1, 'USD', AS_OF, { ...half, rounding: 'half_up' }).amount_minor, -1);
  throws_code(() => to_decision(1.5, 'USD', AS_OF, CTX), 'E_NOT_INTEGER');
});

// ── TST-28: крипта ─────────────────────────────────────────────────────────────

test('TST-28 крипта: convert_minor(150000, 8, 2, 50000, 1) = 7500 (0,0015 BTC × 50 000,00 €/BTC → 75,00 €); 150001 сатоши → 7500,05 → 7500', () => {
  assert.equal(convert_minor(150000, 8, 2, 50000, 1), 7500);
  assert.equal(convert_minor(150001, 8, 2, 50000, 1), 7500);
  assert.equal(convert_minor(150001, 8, 2, 50000, 1, 'ceil'), 7501);
  assert.equal(convert_minor(1, 8, 2, 50000, 1), 0, '1 сатоши — меньше цента');
  assert.equal(convert_minor(100_000_000, 8, 2, 50000, 1), 5_000_000, '1 BTC = 50 000,00 €');
});

test('TST-28 liquid_value: liquidity_bp крипты по умолчанию 0 (free не входит); при 3000 bp → 2250; savings — 100 %; asset — liquidity_bp', () => {
  const btc = { account_id: 'btc', currency: 'BTC', exponent: 8, kind: 'crypto', liquidity: 'asset' };
  const rates = [rate('b', '2026-10-01', 'BTC', 'EUR', 50000, 1)];
  const ctx = { rates, decision_currency: 'EUR', policy: normalize_policy('spot', AS_OF), rounding: 'half_even' };
  assert.equal(liquid_value(btc, 150000, rates, ctx), 0, 'crypto.liquidity_bp = 0 по умолчанию');
  assert.equal(liquid_value({ ...btc, liquidity_bp: 3000 }, 150000, rates, ctx), 2250, 'n = 2,25·10^15, d = 10^12');
  assert.equal(liquid_value({ ...btc, liquidity_bp: 10000 }, 150000, rates, ctx), 7500);
  // крипта на накопительном счёте — по-прежнему только liquidity_bp (D-20)
  assert.equal(liquid_value({ ...btc, liquidity: 'savings' }, 150000, rates, ctx), 0);
  // накопительный фиат — 100 %, актив — liquidity_bp, operating — 0 (он уже в ряде)
  const ctx2 = { ...ctx, rates: [USD_EUR] };
  assert.equal(liquid_value(USD_SAVE, 200000, [USD_EUR], ctx2), 185000);
  assert.equal(liquid_value({ ...USD_SAVE, liquidity: 'asset', liquidity_bp: 5000 }, 200000, [USD_EUR], ctx2), 92500);
  assert.equal(liquid_value({ ...USD_SAVE, liquidity: 'asset' }, 200000, [USD_EUR], ctx2), 0);
  assert.equal(liquid_value({ ...USD, liquidity: 'operating' }, 200000, [USD_EUR], ctx2), 0);
  // сценарий курса учитывается; нет курса — E_NO_RATE; крипта в operating — E_SCHEMA; liquidity_bp вне 0…10000
  const shock = { ...ctx2, policy: normalize_policy({ kind: 'spot', shock: { USD: -500 } }, AS_OF) };
  assert.equal(liquid_value(USD_SAVE, 200000, [USD_EUR], shock), 175750);
  throws_code(() => liquid_value(USD_SAVE, 200000, [], ctx2), 'E_NO_RATE');
  throws_code(() => liquid_value({ ...btc, liquidity: 'operating' }, 1, rates, ctx), 'E_SCHEMA');
  throws_code(() => liquid_value({ ...btc, liquidity_bp: 10001 }, 1, rates, ctx), 'E_SCHEMA');
  // экспонента счёта берётся из реестра, если не задана
  assert.equal(liquid_value({ currency: 'BTC', kind: 'crypto', liquidity: 'asset', liquidity_bp: 10000 }, 150000, rates, ctx), 7500);
});

// ── ALG-08 TV-7, TV-1: экспоненты, ничьи, BigInt ───────────────────────────────

test('ALG-08 TV-7 экспоненты и ничьи: 10000 JPY × 62/10000 → 6200; 0,5 minor — half_even/half_up с симметрией знака; BigInt и E_OVERFLOW', () => {
  assert.equal(convert_minor(10000, 0, 2, 62, 10000), 6200, '(JPY, exponent 0 → EUR, exponent 2)');
  const t = (a, mode) => convert_minor(a, 2, 2, 1, 2, mode);
  assert.deepEqual([t(1, 'half_even'), t(1, 'half_up'), t(-1, 'half_even'), t(-1, 'half_up')], [0, 1, 0, -1]);
  assert.deepEqual([t(5, 'half_even'), t(5, 'half_up'), t(3, 'half_even'), t(3, 'half_up')], [2, 3, 2, 2], '2,5 → 2 / 3; 1,5 → 2 / 2');
  assert.deepEqual([t(1, 'floor'), t(1, 'ceil'), t(-1, 'floor'), t(-1, 'ceil')], [0, 1, -1, 0]);
  assert.equal(convert_minor(2 * 10 ** 12, 2, 2, 9250, 10000), 1_850_000_000_000, 'a·9250·100 = 1,85·10^18 > 2^53 — только через BigInt');
  throws_code(() => convert_minor(9007199254740991, 2, 2, 2, 1), 'E_OVERFLOW');
  throws_code(() => convert_minor(100, 2, 2, 0, 1), 'E_SCHEMA');
  throws_code(() => convert_minor(100, 2, 2, 1, 0), 'E_SCHEMA');
  throws_code(() => convert_minor(100, 2, 2, -1, 1), 'E_SCHEMA');
  throws_code(() => convert_minor(100, 2, 2, 1.5, 1), 'E_SCHEMA');
  throws_code(() => convert_minor(100, -1, 2, 1, 1), 'E_SCHEMA');
  throws_code(() => convert_minor(100, 2, 2.5, 1, 1), 'E_SCHEMA');
  throws_code(() => convert_minor(100.5, 2, 2, 1, 1), 'E_NOT_INTEGER');
  throws_code(() => convert_minor(100, 2, 2, 1, 1, 'round'), 'E_SCHEMA');
});

// ── to_decision_events / opening_in_decision ───────────────────────────────────

const ev = (id, date, account_id, currency, amount, extra = {}) => ({ cash_event_id: id, layer: 'planned', account_id, date: d(date), amount_minor: amount, currency, kind: amount < 0 ? 'expense' : 'income', tag: 't', ...extra });

test('TST-27 ALG-08 TV-5: G-001 в EUR — to_decision_events не меняет суммы и даты, пар курса нет; вариант «+ счёт USD 200000»: opening 585000 / 575750', () => {
  const events = [
    ev('R-RENT@2026-10-26', '2026-10-26', 'acc_main', 'EUR', -90000),
    ev('R-PHONE@2026-10-09', '2026-10-09', 'acc_main', 'EUR', -2500),
    ev('S-HOURLY@2026-11-05', '2026-11-05', 'acc_main', 'EUR', 279000, { amount_min_minor: 240000, amount_max_minor: 330000 }),
  ];
  const out = to_decision_events(events, [EUR], [], 'EUR', 'spot', AS_OF);
  assert.deepEqual(out.map((e) => [e.cash_event_id, e.date, e.amount_minor, e.currency]), [
    ['R-PHONE@2026-10-09', d('2026-10-09'), -2500, 'EUR'], ['R-RENT@2026-10-26', d('2026-10-26'), -90000, 'EUR'], ['S-HOURLY@2026-11-05', d('2026-11-05'), 279000, 'EUR'],
  ], 'порядок — по (date, amount_minor, cash_event_id), даты и суммы те же');
  assert.ok(out.every((e) => e.rate_used === null && e.orig_currency === 'EUR' && e.orig_amount_minor === e.amount_minor));
  assert.equal(out[2].amount_min_minor, 240000);
  assert.equal(out[2].amount_max_minor, 330000);
  // opening: 400000 + 2 000,00 $ по 0,9250 = 585000; при −5 % — 575750 (Δ −9250)
  const accounts = [EUR, USD];
  const balances = { acc_main: 400000, acc_usd: 200000 };
  assert.equal(opening_in_decision(accounts, balances, CTX, AS_OF), 585000);
  const shock = { ...CTX, policy: { kind: 'spot', as_of: AS_OF, shock: { USD: -500 } } };
  assert.equal(opening_in_decision(accounts, balances, shock, AS_OF), 575750);
  // иллюстрация TV-5: min trough 205500 сдвигается на оценку USD-счёта
  assert.equal(205500 + 185000, 390500);
  assert.equal(205500 + 175750, 381250);
  // Map-вариант балансов; отсутствующий остаток = 0; справочные счета в opening не входят
  assert.equal(opening_in_decision([EUR, USD, USD_SAVE], new Map([['acc_main', 400000], ['acc_usd', 200000], ['acc_usd_save', 999]]), CTX, AS_OF), 585000);
  assert.equal(opening_in_decision([EUR, USD], { acc_main: 400000 }, CTX, AS_OF), 400000);
});

test('to_decision_events: события в USD → EUR по spot (одно округление на событие), служебные поля orig_*/rate_used, коридор переводится тем же курсом', () => {
  const events = [ev('e1', '2026-10-20', 'acc_usd', 'USD', 10001, { amount_min_minor: 9000, amount_max_minor: 12000 }), ev('e2', '2026-10-21', 'acc_usd', 'USD', -333)];
  const out = to_decision_events(events, [EUR, USD], [USD_EUR], 'EUR', 'spot', AS_OF);
  assert.equal(out[0].amount_minor, 9251, '10001 · 0,925 = 9250,925 → 9251');
  assert.equal(out[0].orig_amount_minor, 10001);
  assert.equal(out[0].orig_currency, 'USD');
  assert.deepEqual(out[0].rate_used, { num: 9250, den: 10000, date: AS_OF });
  assert.equal(out[0].currency, 'EUR');
  assert.deepEqual([out[0].amount_min_minor, out[0].amount_max_minor], [8325, 11100]);
  assert.ok(out[0].amount_min_minor <= out[0].amount_minor && out[0].amount_minor <= out[0].amount_max_minor);
  assert.equal(out[1].amount_minor, -308, '−333 · 0,925 = −308,025 → −308');
  // сценарий курса и режим округления
  const sh = to_decision_events(events, [EUR, USD], [USD_EUR], 'EUR', { kind: 'spot', shock: { USD: -500 }, rounding: 'half_even' }, AS_OF);
  assert.equal(sh[0].amount_minor, 8788, '10001 · 703/800 = 8788,38 → 8788');
  assert.deepEqual([sh[0].rate_used.num, sh[0].rate_used.den], [703, 800]);
  // вход не мутируется; порядок входа не влияет
  assert.equal(events[0].amount_minor, 10001);
  assert.deepEqual(to_decision_events([...events].reverse(), [EUR, USD], [USD_EUR], 'EUR', 'spot', AS_OF), out);
});

test('to_decision_events D-20: обмен между своими operating — обе ноги исключены; перевод на накопительный счёт — operating-нога остаётся расходом; справочные счета не входят', () => {
  const accounts = [EUR, USD, USD_SAVE, { account_id: 'acc_debt', kind: 'debt', liquidity: 'debt', currency: 'EUR' }];
  const events = [
    ev('x-a', '2026-10-10', 'acc_usd', 'USD', -200000, { kind: 'transfer', transfer_id: 'T1' }), // обмен 2 000,00 $ → 1 842,40 €
    ev('x-b', '2026-10-10', 'acc_main', 'EUR', 184240, { kind: 'transfer', transfer_id: 'T1' }),
    ev('s-a', '2026-10-11', 'acc_main', 'EUR', -50000, { kind: 'transfer', transfer_id: 'T2' }), // operating → savings
    ev('s-b', '2026-10-11', 'acc_usd_save', 'USD', 54000, { kind: 'transfer', transfer_id: 'T2' }),
    ev('debt-1', '2026-10-12', 'acc_debt', 'EUR', 777),
    ev('plain', '2026-10-13', 'acc_main', 'EUR', -100),
  ];
  const out = to_decision_events(events, accounts, [USD_EUR], 'EUR', 'spot', AS_OF);
  assert.deepEqual(out.map((e) => e.cash_event_id), ['s-a', 'plain']);
  assert.equal(out[0].amount_minor, -50000);
  // курсовая разница обмена — справочно (в trough не входит): spot даёт 185000 за 200000, получено 184240
  assert.equal(exchange_difference(200000, 184240, 2, 2, implied_rate_to_spot(USD_EUR)), 760);
});

function implied_rate_to_spot(r) { return { num: r.num, den: r.den }; } // курс «проданная → полученная» как spot

test('to_decision_events: ошибки — неизвестный счёт (E_SCHEMA), валюта события ≠ валюте счёта (E_CURRENCY_MISMATCH), нет курса (E_NO_RATE)', () => {
  throws_code(() => to_decision_events([ev('e', '2026-10-10', 'ghost', 'EUR', 1)], [EUR], [], 'EUR', 'spot', AS_OF), 'E_SCHEMA');
  throws_code(() => to_decision_events([ev('e', '2026-10-10', 'acc_main', 'USD', 1)], [EUR], [USD_EUR], 'EUR', 'spot', AS_OF), 'E_CURRENCY_MISMATCH');
  throws_code(() => to_decision_events([ev('e', '2026-10-10', 'acc_usd', 'USD', 1)], [USD], [], 'EUR', 'spot', AS_OF), 'E_NO_RATE');
  assert.deepEqual(to_decision_events([], [EUR], [], 'EUR', 'spot', AS_OF), []);
});

test('rate_status: возраст курса в днях и признак «устарел» (плашка W_RATE_STALE, fx.stale_days = 30 — гипотеза), расчёт не блокируется', () => {
  assert.deepEqual(rate_status(USD_EUR, AS_OF), { age: 0, stale: false });
  assert.deepEqual(rate_status({ date: d('2026-09-04') }, AS_OF), { age: 30, stale: false }, 'ровно 30 дней — не старше');
  assert.deepEqual(rate_status({ date: d('2026-09-03') }, AS_OF), { age: 31, stale: true });
  assert.deepEqual(rate_status({ date: d('2026-08-20') }, AS_OF), { age: 45, stale: true }, 'курс не обновлялся 45 дн.');
  assert.deepEqual(rate_status({ date: '2026-08-20' }, '2026-10-04', 60), { age: 45, stale: false });
  assert.equal(format_date(AS_OF), '2026-10-04');
});

// ── TST-51/53: фаззинг и оракул ────────────────────────────────────────────────

test('TST-53 оракул convert_minor: BigInt-эталон на 20 000 случаев (все режимы, экспоненты 0…8, суммы до ±(2^53−1)); E_OVERFLOW вместо молчаливого переполнения', () => {
  const rng = make_rng(8);
  const modes = ['half_even', 'half_up', 'floor', 'ceil'];
  for (let it = 0; it < 20000; it++) {
    const a = rng.int(0, 5) === 0 ? rand_safe(rng, rng.int(1, 53)) : rng.int(-5_000_000, 5_000_000);
    const be = rng.int(0, 8);
    const qe = rng.int(0, 8);
    const num = rng.int(1, 2_000_000);
    const den = rng.int(1, 2_000_000);
    const mode = rng.pick(modes);
    const want = oracle_div(BigInt(a) * BigInt(num) * 10n ** BigInt(qe), BigInt(den) * 10n ** BigInt(be), mode);
    if (want > BigInt(Number.MAX_SAFE_INTEGER) || want < -BigInt(Number.MAX_SAFE_INTEGER)) {
      throws_code(() => convert_minor(a, be, qe, num, den, mode), 'E_OVERFLOW');
    } else {
      assert.equal(convert_minor(a, be, qe, num, den, mode), Number(want));
    }
  }
});

test('TST-51 свойства ALG-08: convert(0) = 0, нечётность для half_even/half_up, монотонность по a, |conv(a+b) − conv(a) − conv(b)| ≤ 1, валюта решения — без изменений (3 000 случаев)', () => {
  const rng = make_rng(81);
  for (let it = 0; it < 3000; it++) {
    const be = rng.int(0, 8);
    const qe = Math.max(0, be + rng.int(-2, 2)); // разность экспонент ≤ 2: результат остаётся в safe-диапазоне
    const num = rng.int(1, 100000);
    const den = rng.int(1, 100000);
    const a = rng.int(-3_000_000, 3_000_000);
    const b = rng.int(-3_000_000, 3_000_000);
    const c = (x, m = 'half_even') => convert_minor(x, be, qe, num, den, m);
    assert.equal(c(0), 0);
    for (const m of ['half_even', 'half_up']) assert.equal(c(-a, m), -c(a, m) + 0, 'convert(−a) = −convert(a)');
    const hi = Math.max(a, b);
    const lo = Math.min(a, b);
    assert.ok(c(lo) <= c(hi), 'монотонность');
    assert.ok(Math.abs(c(a + b) - c(a) - c(b)) <= 1, 'аддитивность до 1 minor');
    // при ≥ ½ minor ошибки на слагаемое сумма ограничена: проверка на сумму трёх слагаемых (≤ 3/2·… → не более 2)
    assert.ok(Math.abs(c(a + b + 7) - c(a) - c(b) - c(7)) <= 2);
  }
  // валюта события = валюте решения → сумма не меняется, курс не нужен
  for (let it = 0; it < 200; it++) {
    const a = rand_safe(rng, 53);
    assert.deepEqual(to_decision(a, 'EUR', AS_OF, { rates: [], decision_currency: 'EUR', policy: 'spot' }), { amount_minor: a, rate: null });
  }
  // implied_rate: обратное преобразование ног без потерь для произвольных экспонент
  for (let it = 0; it < 1000; it++) {
    const la = rng.int(1, 5_000_000);
    const lb = rng.int(1, 5_000_000);
    const be = rng.int(0, 8);
    const qe = rng.int(0, 8);
    const r = implied_rate(la, lb, be, qe);
    assert.equal(convert_minor(la, be, qe, r.num, r.den), lb, 'инв. 4 ALG-08');
    assert.equal(oracle_gcd(BigInt(r.num), BigInt(r.den)), 1n, 'дробь несократима (C-037)');
  }
});

function oracle_gcd(a, b) { while (b !== 0n) [a, b] = [b, a % b]; return a; }

test('TST-33 (часть) детерминизм fx: to_decision_events и opening_in_decision не зависят от порядка events, rates и accounts', () => {
  const rng = make_rng(4);
  const rates = [rate('1', '2026-09-01', 'USD', 'EUR', 9, 10), rate('2', '2026-10-01', 'USD', 'EUR', 92, 100), rate('3', '2026-10-02', 'EUR', 'USD', 108, 100)];
  const accounts = [EUR, USD, USD_SAVE];
  const events = Array.from({ length: 30 }, (_, k) => ev('e' + k, '2026-10-' + String(5 + (k % 20)).padStart(2, '0'), rng.pick(['acc_main', 'acc_usd']), 'X', rng.int(-5000, 5000)))
    .map((e) => ({ ...e, currency: e.account_id === 'acc_usd' ? 'USD' : 'EUR' }));
  const shuffle = (xs) => xs.map((x) => [rng.next(), x]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
  const base = to_decision_events(events, accounts, rates, 'EUR', 'spot', AS_OF);
  for (let k = 0; k < 10; k++) assert.deepEqual(to_decision_events(shuffle(events), shuffle(accounts), shuffle(rates), 'EUR', 'spot', AS_OF), base);
  const ctx = { rates, decision_currency: 'EUR', policy: 'spot' };
  const o = opening_in_decision(accounts, { acc_main: 1, acc_usd: 12345 }, ctx, AS_OF);
  for (let k = 0; k < 10; k++) assert.equal(opening_in_decision(shuffle(accounts), { acc_main: 1, acc_usd: 12345 }, { ...ctx, rates: shuffle(rates) }, AS_OF), o);
});
