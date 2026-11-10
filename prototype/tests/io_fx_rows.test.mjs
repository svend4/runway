// io_fx_rows.test.mjs — FP-29, ALG-14 A14.7 и ALG-08 A08.3: строка CSV в чужой валюте с двумя ногами больше не отвергается как currency_mismatch —
// она становится обменом с курсом, выведенным из ног, и справочной разницей к курсу из данных (exchange_difference); повторный импорт даёт 0 новых;
// нет курса — E_NO_RATE с парой (строка отклонена как no_rate, пара названа). Основной разбор io.mjs не меняется (engine/io_fx_rows.mjs — надстройка).
// Расчёт по введённым данным и правилам, не консультация.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/io_fx_rows.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as X from '../engine/io_fx_rows.mjs';
import { parse_with_profile, dry_run } from '../engine/io.mjs';
import { implied_rate, exchange_difference } from '../engine/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const read_json = (p) => JSON.parse(fs.readFileSync(path.join(PROTO, p), 'utf8'));

function deep_freeze(x) {
  if (x === null || typeof x !== 'object' || Object.isFrozen(x)) return x;
  for (const k of Object.keys(x)) deep_freeze(x[k]);
  return Object.freeze(x);
}

const acc = (account_id, currency, liquidity = 'operating', extra = {}) => ({ account_id, name: account_id, kind: 'bank', liquidity, currency, exponent: currency === 'JPY' ? 0 : 2, liquidity_bp: 0, ...extra });
const RATE_USD_EUR = { fx_id: 'fx1', date: '2026-10-01', base: 'USD', quote: 'EUR', num: 9200, den: 10000, source: 'manual' };
const ACCOUNTS = deep_freeze([acc('acc_main', 'EUR'), acc('acc_usd', 'USD')]);
const RATES = deep_freeze([RATE_USD_EUR]);
const AS_OF = '2026-10-04';
const { base: BASE, fx: FX } = X.split_fx_profile(X.FX_ROWS_PROFILE);
const CTX = { account_id: 'acc_main', account_currency: 'EUR', as_of: AS_OF, accounts: ACCOUNTS, rates: RATES, decision_currency: 'EUR' };
const HEAD = 'date,amount_minor,currency,note,counter_amount_minor,counter_currency\n';

/** Основной разбор + обмены. */
function run(rows, ctx_patch = {}, profile = BASE, fx = FX, head = HEAD) {
  const text = head + rows.join('\n') + (rows.length > 0 ? '\n' : '');
  const parsed = parse_with_profile(profile, text, { account_id: 'acc_main', account_currency: 'EUR', as_of: AS_OF });
  return { text, parsed, out: X.merge_fx_rows(parsed, profile, fx, text, { ...CTX, ...ctx_patch }) };
}
const reasons = (r) => Object.fromEntries(r.out.rejects.map((x) => [x.row, x.reason]));

// ── профиль ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test('A14.7 профиль строк обмена: data/profiles/fx-rows-csv-1.json = FX_ROWS_PROFILE; обычная часть проходит validate_profile, блок fx — validate_fx_config; чужие поля отвергаются', () => {
  assert.deepEqual(read_json('data/profiles/fx-rows-csv-1.json'), X.FX_ROWS_PROFILE);
  assert.equal(X.has_fx_block(X.FX_ROWS_PROFILE), true);
  assert.equal(X.has_fx_block({ date: 1 }), false);
  assert.equal(X.has_fx_block(null), false);
  assert.equal('fx' in BASE, false, 'обычный профиль CSV без блока fx');
  assert.deepEqual(X.split_fx_profile({ a: 1 }), { base: { a: 1 }, fx: null });
  assert.deepEqual(X.validate_fx_config(FX), { ok: true, errors: [] });
  assert.deepEqual(X.validate_fx_config({ counter_amount: { col: 4, unit: 'major', decimal: ',', thousands: '.' }, counter_currency: { fixed: 'EUR' } }), { ok: true, errors: [] });
  const bad = (patch, field) => {
    const r = X.validate_fx_config({ ...FX, ...patch });
    assert.equal(r.ok, false, field);
    assert.ok(r.errors.some((e) => e.field === field), field + ': ' + JSON.stringify(r.errors));
  };
  bad({ rate: 1 }, 'fx.rate');
  bad({ counter_amount: { col: '' } }, 'fx.counter_amount.col');
  bad({ counter_amount: { col: 'a', unit: 'cents' } }, 'fx.counter_amount.unit');
  bad({ counter_amount: { col: 'a', decimal: 'ab' } }, 'fx.counter_amount.decimal');
  bad({ counter_amount: { col: 'a', thousands: '5' } }, 'fx.counter_amount.thousands');
  bad({ counter_amount: { col: 'a', transform: 'x' } }, 'fx.counter_amount.transform');
  bad({ counter_currency: { col: 'c', fixed: 'EUR' } }, 'fx.counter_currency');
  bad({ counter_currency: {} }, 'fx.counter_currency');
  bad({ counter_currency: { fixed: 'euro' } }, 'fx.counter_currency.fixed');
  bad({ counter_currency: { col: -1 } }, 'fx.counter_currency.col');
  assert.equal(X.validate_fx_config(null).ok, false);
  assert.equal(X.validate_fx_config([]).ok, false);
});

// ── обмен: числа ────────────────────────────────────────────────────────────────────────────────────────────────────

test('A14.7 A08.3 строка в USD с суммой второй ноги в EUR становится обменом: курс выведен из ног (дробь как есть), справочная разница к курсу из данных; основной разбор их отклонял как currency_mismatch', () => {
  const rows = [
    '2026-10-02,-100000,USD,Обмен в евро,92400,EUR', // продано 1000,00 USD, получено 924,00 EUR: курс 0,924, по данным 0,92 → получено на 4,00 EUR больше
    '2026-10-03,50000,USD,Обратно,-46000,EUR', // продано 460,00 EUR, получено 500,00 USD: курс 25/23, по данным (обратная пара) — 1/0,92
  ];
  const { parsed, out } = run(rows);
  assert.deepEqual(parsed.rejects.map((r) => r.reason), ['currency_mismatch', 'currency_mismatch'], 'основной разбор: оба отклонены');
  assert.deepEqual(out.rejects, []);
  assert.equal(out.fx.converted, 2);
  assert.deepEqual([out.fx.mismatch_rows, out.fx.rejected, out.fx.missing_pairs, out.fx.skipped_currencies], [2, 0, [], 0]);
  assert.equal(out.rows_total, 2);
  const [a, b] = out.candidates;
  // первая: нога счёта импорта — получено +924,00 EUR, вторая нога — −1000,00 USD на acc_usd
  assert.deepEqual([a.row, a.account_id, a.amount_minor, a.currency], [2, 'acc_main', 92400, 'EUR']);
  assert.deepEqual(a.exchange, {
    counter_account_id: 'acc_usd', counter_currency: 'USD', counter_amount_minor: -100000, sold: 'counter', sold_currency: 'USD', sold_minor: 100000,
    got_currency: 'EUR', got_minor: 92400, implied: { num: 231, den: 250 }, spot: { num: 9200, den: 10000, inverse: false }, diff_minor: -400,
  });
  assert.deepEqual(a.exchange.implied, implied_rate(100000, 92400, 2, 2), 'курс обмена — implied_rate движка');
  assert.equal(a.exchange.diff_minor, exchange_difference(100000, 92400, 2, 2, { num: 9200, den: 10000 }), 'разница — exchange_difference движка');
  // вторая: продана нога счёта импорта (−460,00 EUR), получено +500,00 USD
  assert.deepEqual([b.row, b.amount_minor, b.currency], [3, -46000, 'EUR']);
  assert.equal(b.exchange.sold, 'target');
  assert.deepEqual(b.exchange.implied, { num: 25, den: 23 });
  assert.deepEqual(b.exchange.spot, { num: 10000, den: 9200, inverse: true });
  assert.equal(b.exchange.diff_minor, 0, '500,00 USD по курсу из данных ровно 460,00 EUR');
  assert.ok(typeof a.dedup_key === 'string' && a.dedup_key.length === 16 && a.dedup_key !== b.dedup_key);
});

test('A08.3 ноги: exchange_legs отдаёт ногу счёта импорта и ногу второго счёта; выведенный курс лежит на проданной ноге (как у формы обмена)', () => {
  const { out } = run(['2026-10-02,-100000,USD,Обмен,92400,EUR', '2026-10-03,50000,USD,Обратно,-46000,EUR']);
  const [la, lb] = out.candidates.map((c) => X.exchange_legs(c));
  assert.deepEqual(la, [
    { role: 'target', account_id: 'acc_main', currency: 'EUR', amount_minor: 92400 },
    { role: 'counter', account_id: 'acc_usd', currency: 'USD', amount_minor: -100000, fx: { num: 231, den: 250 } },
  ]);
  assert.deepEqual(lb, [
    { role: 'target', account_id: 'acc_main', currency: 'EUR', amount_minor: -46000, fx: { num: 25, den: 23 } },
    { role: 'counter', account_id: 'acc_usd', currency: 'USD', amount_minor: 50000 },
  ]);
  for (const legs of [la, lb]) {
    assert.equal(Math.sign(legs[0].amount_minor), -Math.sign(legs[1].amount_minor), 'знаки ног противоположны');
    assert.equal(legs.filter((l) => l.fx !== undefined).length, 1, 'курс — на одной ноге');
    assert.ok(legs.find((l) => l.fx !== undefined).amount_minor < 0, '…на проданной');
  }
  assert.equal(X.exchange_date(out.candidates[0]), '2026-10-02');
});

test('A08.3 разные знаки после запятой: иена (0 знаков) и евро — курс выведен с учётом экспонент, не 100 раз мимо', () => {
  const accounts = [acc('acc_main', 'EUR'), acc('acc_jpy', 'JPY')];
  const rates = [{ fx_id: 'fx9', date: '2026-10-01', base: 'JPY', quote: 'EUR', num: 6, den: 1000, source: 'manual' }];
  const { out } = run(['2026-10-02,-15000,JPY,Иены,9000,EUR'], { accounts, rates });
  assert.equal(out.fx.converted, 1, JSON.stringify(out.rejects));
  const x = out.candidates[0].exchange;
  assert.deepEqual(x.implied, { num: 3, den: 500 }, '90,00 EUR / 15 000 JPY = 0,006');
  assert.deepEqual(x.implied, implied_rate(15000, 9000, 0, 2));
  assert.equal(x.diff_minor, 0, 'курс из данных 0,006: разницы нет');
});

test('A08.3 нет курса пары в данных — обмен всё равно принят, если ноги не на операционных счетах с чужой валютой; справочной разницы нет (spot: null)', () => {
  const accounts = [acc('acc_main', 'EUR'), acc('acc_usd', 'USD', 'savings')];
  const { out } = run(['2026-10-02,-100000,USD,Обмен,92400,EUR'], { accounts, rates: [] });
  assert.equal(out.fx.converted, 1, 'нога на накопительном счёте курса для записи не требует (как add_fact)');
  assert.equal(out.candidates[0].exchange.spot, null);
  assert.equal(out.candidates[0].exchange.diff_minor, null);
});

// ── отказы с причинами ──────────────────────────────────────────────────────────────────────────────────────────────

test('A14.7 причины отклонения строки обмена названы: нет второй ноги, чужая валюта второй ноги, плохая сумма, знаки, нет счёта', () => {
  const rows = [
    '2026-10-02,-1000,USD,без второй ноги,,', // 2
    '2026-10-02,-1000,USD,нет суммы,,EUR', // 3
    '2026-10-02,-1000,USD,нет валюты,900,', // 4
    '2026-10-02,-1000,USD,неизвестная валюта,900,ZZZ', // 5
    '2026-10-02,-1000,USD,не в валюте счёта,900,GBP', // 6
    '2026-10-02,-1000,USD,мусор,abc,EUR', // 7
    '2026-10-02,-1000,USD,ноль,0,EUR', // 8
    '2026-10-02,-1000,USD,дробь,9.0,EUR', // 9: единицы minor — только целые
    '2026-10-02,-1000,USD,знак совпал,-900,EUR', // 10
    '2026-10-02,1000,USD,знак совпал плюс,+900,EUR', // 11
    '2026-10-02,-1000,GBP,нет счёта,900,EUR', // 12
    '2026-10-02,abc,USD,плохая сумма,900,EUR', // 13
    '2026-10-02,0,USD,нулевая сумма,900,EUR', // 14
    '2026-10-02,-1000,USD,будущая дата,900,EUR', // 15
    '2026-10-02,-1000,USD,знак без числа,-,EUR', // 16
  ];
  rows[13] = '2026-10-09,-1000,USD,будущая дата,900,EUR';
  const { out } = run(rows);
  assert.deepEqual(reasons({ out }), {
    2: 'fx_no_counter', 3: 'fx_no_counter', 4: 'fx_no_counter', 5: 'unknown_currency', 6: 'fx_not_account_currency', 7: 'fx_bad_counter', 8: 'fx_bad_counter', 9: 'fx_bad_counter',
    10: 'fx_sign', 11: 'fx_sign', 12: 'fx_no_counter_account', 13: 'bad_amount', 14: 'zero_amount', 15: 'future_date', 16: 'fx_bad_counter',
  });
  assert.equal(out.candidates.length, 0);
  assert.equal(out.rejects.length, rows.length);
  assert.equal(out.rows_total, rows.length);
});

test('A14.7 вторая сумма без знака берёт знак, противоположный первой; явный противоположный знак принят; явный одинаковый — fx_sign', () => {
  const { out } = run(['2026-10-02,-100000,USD,а,92400,EUR', '2026-10-02,-100000,USD,б,+92400,EUR', '2026-10-02,100000,USD,в,92400,EUR', '2026-10-02,100000,USD,г,-92400,EUR']);
  assert.equal(out.candidates.length, 4, JSON.stringify(out.rejects));
  assert.deepEqual(out.candidates.map((c) => c.amount_minor), [92400, 92400, -92400, -92400]);
  assert.equal(new Set(out.candidates.map((c) => c.dedup_key)).size, 4, 'ключи различны (описания разные)');
});

test('A14.7 счёт второй ноги: единственный открытый счёт в валюте операции; два счёта — нужно указать; указанный счёт принят; закрытый счёт не считается', () => {
  const two = [...ACCOUNTS, acc('acc_usd2', 'USD')];
  const row = ['2026-10-02,-100000,USD,Обмен,92400,EUR'];
  assert.deepEqual(reasons(run(row, { accounts: two })), { 2: 'fx_no_counter_account' });
  const own = run(row, { accounts: two, counter_account_id: 'acc_usd2' });
  assert.equal(own.out.candidates[0].exchange.counter_account_id, 'acc_usd2');
  assert.deepEqual(reasons(run(row, { accounts: two, counter_account_id: 'acc_main' })), { 2: 'fx_no_counter_account' }, 'указан не тот счёт (другая валюта / счёт импорта)');
  assert.deepEqual(reasons(run(row, { accounts: two, counter_account_id: 'нет' })), { 2: 'fx_no_counter_account' });
  const closed = [acc('acc_main', 'EUR'), acc('acc_usd', 'USD', 'operating', { closed_on: '2026-09-30' }), acc('acc_usd2', 'USD')];
  assert.equal(run(row, { accounts: closed }).out.candidates[0].exchange.counter_account_id, 'acc_usd2', 'закрытый счёт пропущен, остаётся единственный');
  assert.deepEqual(reasons(run(row, { accounts: [acc('acc_main', 'EUR')] })), { 2: 'fx_no_counter_account' });
  assert.equal(run(row, { accounts: [acc('acc_usd', 'USD')] }).out.candidates.length, 1, 'счёт импорта среди счетов не найден — нога его счёта берётся из контекста разбора (валюта и идентификатор)');
});

test('A08.2 E_NO_RATE: нет курса «валюта → валюта решения» для ноги на операционном счёте — строка отклонена как no_rate, пара названа; require_rate бросает E_NO_RATE с парой', () => {
  const rows = ['2026-10-02,-100000,USD,Обмен,92400,EUR', '2026-10-03,-5000,USD,Ещё обмен,4600,EUR'];
  const { out } = run(rows, { rates: [] });
  assert.deepEqual(reasons({ out }), { 2: 'no_rate', 3: 'no_rate' });
  assert.deepEqual(out.fx.missing_pairs, ['USD/EUR']);
  assert.deepEqual(out.fx.errors, [{ code: 'E_NO_RATE', ctx: { pair: 'USD/EUR', reason: 'no_rate' } }], 'код канона E_NO_RATE с парой — в плане, не только причина строки');
  assert.equal(out.fx.converted, 0);
  assert.throws(() => X.require_rate([], 'USD', 'EUR', '2026-10-02'), (e) => e.code === 'E_NO_RATE' && e.ctx.pair === 'USD/EUR' && e.ctx.reason === 'no_rate');
  assert.equal(X.require_rate([], 'EUR', 'EUR', '2026-10-02'), null, 'валюта решения курса не требует');
  assert.equal(X.require_rate([], 'USD', null, '2026-10-02'), null, 'валюты решения нет — проверять нечего');
  assert.equal(X.require_rate(RATES, 'USD', 'EUR', '2026-10-02').num, 9200);
  assert.equal(X.require_rate(RATES, 'EUR', 'USD', '2026-10-02').inverse, true, 'обратная пара подходит');
  assert.throws(() => X.require_rate(RATES, 'USD', 'EUR', '2026-09-01'), (e) => e.code === 'E_NO_RATE', 'курс из будущего — не spot');
  // курс введён позже даты строки — на дату строки его не было
  assert.deepEqual(reasons(run(['2026-09-20,-100000,USD,Раньше курса,92400,EUR'])), { 2: 'no_rate' });
  // валюта решения — USD: нога в EUR на операционном счёте требует курс EUR → USD (обратная пара есть)
  assert.equal(run(rows, { decision_currency: 'USD' }).out.candidates.length, 2);
  // валюта решения — GBP: курсов в GBP нет, обе валюты ног требуют курса
  const g = run(rows, { decision_currency: 'GBP' });
  assert.deepEqual(g.out.fx.missing_pairs, ['EUR/GBP', 'USD/GBP']);
});

test('A14.7 основные отказы и кандидаты не меняются: прежние кандидаты на месте, прочие отказы сохранены, порядок строк — по возрастанию; без чужих валют результат тот же', () => {
  const rows = [
    '2026-10-01,-4500,EUR,обычный расход,,', // 2
    '2026-10-02,-100000,USD,обмен,92400,EUR', // 3
    '2026-10-02,xx,EUR,плохая дата,,', // 4 → в данных: плохая сумма? дата 2026-10-02 корректна, сумма 'xx'
    '2026-10-03,1500,EUR,доход,,', // 5
    '2026-10-04,-300,USD,обмен без ноги,,', // 6
    '2026-10-04,-0,EUR,нулевая,,', // 7
  ];
  const { parsed, out } = run(rows);
  assert.deepEqual(out.candidates.map((c) => c.row), [2, 3, 5]);
  for (const c of out.candidates.filter((x) => x.exchange === undefined)) assert.deepEqual(c, parsed.candidates.find((p) => p.row === c.row), 'обычные кандидаты — те же объекты данных');
  assert.deepEqual(out.rejects, [{ row: 4, reason: 'bad_amount' }, { row: 6, reason: 'fx_no_counter' }, { row: 7, reason: 'zero_amount' }]);
  assert.equal(out.rows_total, parsed.rows_total);
  assert.equal(out.candidates.length + out.rejects.length, out.rows_total);
  // файл без чужих валют: ни одной строки currency_mismatch — результат тот же, блок fx пуст
  const plain = run(['2026-10-01,-4500,EUR,обычный расход,,']);
  assert.deepEqual(plain.out.candidates, plain.parsed.candidates);
  assert.deepEqual(plain.out.rejects, plain.parsed.rejects);
  assert.deepEqual(plain.out.fx, { mismatch_rows: 0, converted: 0, rejected: 0, missing_pairs: [], errors: [], skipped_currencies: 0 });
});

test('A14.7 сухой прогон с обменами: распознано + отклонено + дубликатов = строк; повторный импорт — 0 новых; одинаковые обмены в один день различимы ключом (k), обычная строка с теми же датой, суммой и описанием ключ не делит', () => {
  const rows = [
    '2026-10-02,-100000,USD,Обмен,92400,EUR',
    '2026-10-02,-100000,USD,Обмен,92400,EUR', // второй такой же в тот же день
    '2026-10-02,92400,EUR,Обмен,,', // обычная строка: дата, сумма, валюта, описание те же
    '2026-10-02,-1,USD,нет ноги,,',
  ];
  const { out } = run(rows);
  assert.equal(out.candidates.length, 3);
  assert.deepEqual(out.candidates.slice(0, 2).map((c) => c.k), [0, 1]);
  assert.equal(new Set(out.candidates.map((c) => c.dedup_key)).size, 3, 'три разных ключа');
  const dry = dry_run(out.candidates, new Set(), out.rejects, []);
  assert.equal(dry.recognized + dry.rejected + dry.duplicates, dry.rows_total);
  assert.deepEqual([dry.recognized, dry.rejected, dry.duplicates, dry.rows_total], [3, 1, 0, 4]);
  // «записаны»: ключи обмена известны — второй раз все три — дубликаты
  const again = dry_run(out.candidates, new Set(out.candidates.map((c) => c.dedup_key)), out.rejects, []);
  assert.deepEqual([again.recognized, again.rejected, again.duplicates], [0, 1, 3]);
});

// ── настройка блока fx и ограничения ──────────────────────────────────────────────────────────────────────────────────

test('A14.7 свой профиль: «;», «ДД.ММ.ГГГГ», суммы в основных единицах с десятичной запятой, валюта второй ноги задана одна на файл, колонки по номеру', () => {
  const profile = {
    profile_id: 'my', v: 1, encoding: 'utf-8', delimiter: ';', skip: 0,
    date: { col: 'Datum', fmt: 'DD.MM.YYYY' }, amount: { mode: 'signed', col: 'Betrag', decimal: ',', thousands: '.' }, currency: { col: 'Währung' },
    desc: { cols: ['Text'] }, rules: [],
  };
  const fx = { counter_amount: { col: 4, decimal: ',', thousands: '.' }, counter_currency: { fixed: 'EUR' } };
  const text = 'Datum;Betrag;Währung;Text;Gegenwert\n02.10.2026;-1.000,00;USD;Tausch;924,00\n03.10.2026;-10,00;USD;kleiner;9,24\n';
  const parsed = parse_with_profile(profile, text, { account_id: 'acc_main', account_currency: 'EUR', as_of: AS_OF });
  const out = X.merge_fx_rows(parsed, profile, fx, text, CTX);
  assert.equal(out.candidates.length, 2, JSON.stringify(out.rejects));
  assert.deepEqual(out.candidates.map((c) => [c.amount_minor, c.exchange.counter_amount_minor, c.exchange.implied]), [[92400, -100000, { num: 231, den: 250 }], [924, -1000, { num: 231, den: 250 }]]);
  assert.throws(() => X.merge_fx_rows(parsed, profile, { ...fx, counter_amount: { col: 'нет такой' } }, text, CTX), (e) => e.code === 'E_SCHEMA' && e.ctx.reason === 'unknown_column');
  assert.throws(() => X.merge_fx_rows(parsed, profile, { ...fx, counter_amount: { col: 9 } }, text, CTX), (e) => e.ctx.reason === 'column_index_out_of_header');
  assert.throws(() => X.merge_fx_rows(parsed, profile, { counter_amount: { col: 4, rate: 1 }, counter_currency: { fixed: 'EUR' } }, text, CTX), (e) => e.ctx.reason === 'bad_fx_config');
  assert.throws(() => X.merge_fx_rows(parsed, { ...profile, regex: 'x' }, fx, text, CTX), (e) => e.ctx.reason === 'bad_profile');
  assert.throws(() => X.merge_fx_rows(parsed, profile, fx, text, { as_of: AS_OF }), (e) => e.ctx.reason === 'ctx_required');
});

test('A14.7 пределы: не больше MAX_FX_CURRENCIES чужих валют за прогон (остальные строки остаются currency_mismatch), без счёта импорта в списке счетов работает по ctx', () => {
  const cur = ['USD', 'GBP', 'CHF', 'PLN', 'CZK', 'SEK', 'NOK', 'DKK', 'CAD', 'AUD'];
  const accounts = [acc('acc_main', 'EUR'), ...cur.map((c) => acc('acc_' + c.toLowerCase(), c, 'savings'))];
  const rows = cur.map((c, i) => `2026-10-0${(i % 3) + 1},-1000,${c},обмен ${c},900,EUR`);
  const { out } = run(rows, { accounts });
  assert.equal(X.MAX_FX_CURRENCIES, 8);
  assert.equal(out.fx.converted, 8);
  assert.equal(out.fx.skipped_currencies, 2);
  assert.deepEqual(out.rejects.map((r) => r.reason), ['currency_mismatch', 'currency_mismatch']);
  assert.equal(out.candidates.length + out.rejects.length, rows.length);
});

test('A14.7 данные не мутируются: профиль, блок fx, счета и курсы заморожены, результат — новые объекты', () => {
  const profile = deep_freeze(structuredClone(BASE));
  const fx = deep_freeze(structuredClone(FX));
  const text = HEAD + '2026-10-02,-100000,USD,Обмен,92400,EUR\n';
  const parsed = parse_with_profile(profile, text, { account_id: 'acc_main', account_currency: 'EUR', as_of: AS_OF });
  const frozen = deep_freeze(structuredClone(parsed));
  const out = X.merge_fx_rows(frozen, profile, fx, text, { ...CTX, accounts: deep_freeze(structuredClone(ACCOUNTS)), rates: deep_freeze(structuredClone(RATES)) });
  assert.equal(out.candidates.length, 1);
  assert.equal(frozen.rejects.length, 1, 'вход не изменён');
});
