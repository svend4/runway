// io.test.mjs — ALG-14: CSV, профили, дедупликация, сухой прогон, партия/откат, JSON-копия, CSV журнала, hledger.
// Покрывает: TST-19 (часть: разбор сумм профиля), TST-32 (идемпотентность импорта, откат), TST-38 (round-trip state_hash),
// TST-42 (dedup_key), TST-43 (профиль, сухой прогон, CSV журнала), TST-44 (hledger: экспорт G-001, независимая сверка, оракул hledger при наличии).
// Ожидаемые числа — ДОСЛОВНО из design-brief §9.13, ALG-14 «Тест-векторы» TV-1…TV-5 и 11-testing-strategy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse_date, format_date } from '../engine/dates.mjs';
import { expand_all } from '../engine/recurrence.mjs';
import { make_event, effective_events, reduce, state_hash, dedup_key, norm, canon } from '../engine/ledger.mjs';
import {
  parse_csv, detect_delimiter, parse_date_fmt, parse_amount_cell, rule_matches, validate_profile, parse_with_profile, dry_run,
  import_commit, import_rollback, existing_keys_of, export_json, import_json, read_journal_json, csv_safe_cell, export_csv,
  export_hledger, import_hledger, RUNWAY_CSV_PROFILE, JOURNAL_FORMAT,
} from '../engine/io.mjs';
import { make_rng, rand_safe, throws_code, g001_rules, G001 } from './helpers.mjs';

const D = (iso) => parse_date(iso);

// ── оснастка ──────────────────────────────────────────────────────────────────

/** Журнал-конструктор: ids и seq — порты. */
function journal_builder(start_seq = 1) {
  let seq = start_seq - 1;
  const events = [];
  const add = (type, payload, extra = {}) => {
    seq += 1;
    const e = make_event(type, payload, { event_id: `ev${String(seq).padStart(4, '0')}`, seq, recorded_at: '2026-10-04T08:00:00Z', ...extra });
    events.push(e);
    return e;
  };
  return { events, add, next_seq: () => ++seq, peek: () => seq };
}

/** Журнал G-001: счёт, якорь 400000, правила, разовый налоговый план. */
function g001_journal() {
  const j = journal_builder();
  j.add('account.opened', { account_id: 'acc_main', name: 'bank', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 });
  j.add('anchor.set', { anchor_id: 'anc_main_20261004', account_id: 'acc_main', date: '2026-10-04', amount_minor: 400000 });
  for (const r of g001_rules()) j.add('rule.set', { ...r, version: 1 });
  j.add('plan.set', { plan_id: 'P-TAX1', account_id: 'acc_main', date: '2026-10-23', amount_minor: -50000, currency: 'EUR', tag: 'налог', is_obligation: true });
  return j;
}

/** Плановые события G-001 в режиме plan (то, что дал бы build_events): 16 штук. */
function g001_planned(tag_map = {}) {
  const occ = expand_all(g001_rules(), { from: G001.as_of, to: G001.horizon_end }, {}, []);
  const out = occ.map((o) => ({
    layer: 'planned', cash_event_id: o.occ_key, occ_key: o.occ_key, rule_id: o.rule_id, account_id: o.account_id, currency: o.currency,
    date: o.date, amount_minor: o.amount_minor, name: o.tag, tag: tag_map[o.tag] ?? o.tag, status: 'expected',
  }));
  out.push({ layer: 'planned', cash_event_id: 'P-TAX1', account_id: 'acc_main', currency: 'EUR', date: D('2026-10-23'), amount_minor: -50000, name: 'налог', tag: tag_map['налог'] ?? 'налог', status: 'expected' });
  out.push({ layer: 'planned', cash_event_id: 'S-HOURLY@2026-11-05', stream_id: 'S-HOURLY', account_id: 'acc_main', currency: 'EUR', date: D('2026-11-05'), amount_minor: 279000, name: 'почасовой доход', tag: tag_map['почасовой доход'] ?? 'почасовой доход', status: 'expected' });
  return out;
}

const state_of = (events) => reduce(effective_events(events));

// ── CSV: разбор ───────────────────────────────────────────────────────────────

test('parse_csv: RFC 4180 — кавычки, "" внутри, разделитель и перевод строки внутри поля, CRLF/LF/CR, BOM, пустые строки', () => {
  assert.deepEqual(parse_csv('a,b,c\n1,2,3\n'), [['a', 'b', 'c'], ['1', '2', '3']]);
  assert.deepEqual(parse_csv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']], 'CRLF — один разрыв');
  assert.deepEqual(parse_csv('a,b\r1,2\r'), [['a', 'b'], ['1', '2']], 'одиночный CR');
  assert.deepEqual(parse_csv('"a,b","c""d","e\nf"\n'), [['a,b', 'c"d', 'e\nf']]);
  assert.deepEqual(parse_csv('﻿x,y\n1,2'), [['x', 'y'], ['1', '2']], 'BOM снимается; хвост без перевода строки');
  assert.deepEqual(parse_csv('a,b\n\n,\n1,2\n'), [['a', 'b'], ['1', '2']], 'пустые строки и строки из пустых полей отбрасываются');
  assert.deepEqual(parse_csv('a,,c\n,,\n,x,'), [['a', '', 'c'], ['', 'x', '']], 'пустые поля внутри строки сохраняются');
  assert.deepEqual(parse_csv('a"b,c\n'), [['a"b', 'c']], 'кавычка не в начале поля — литерал');
  assert.deepEqual(parse_csv('"",x\n'), [['', 'x']], 'пустое поле в кавычках');
  assert.deepEqual(parse_csv(''), []);
});

test('parse_csv: разделители ; , TAB и автоопределение', () => {
  assert.deepEqual(parse_csv('a;b;"c;d"\n1;2;3', { delimiter: ';' }), [['a', 'b', 'c;d'], ['1', '2', '3']]);
  assert.deepEqual(parse_csv('a\tb\tc\n1\t2\t3', { delimiter: '\t' }), [['a', 'b', 'c'], ['1', '2', '3']]);
  assert.equal(detect_delimiter('Fecha;Concepto;Cargo\n1;2;3'), ';');
  assert.equal(detect_delimiter('a\tb\tc\n'), '\t');
  assert.equal(detect_delimiter('a,b;c\n'), ',', 'при равенстве — запятая');
  assert.equal(detect_delimiter('"a;b;c",d\n'), ',', 'разделители внутри кавычек не считаются');
  assert.deepEqual(parse_csv('x;y\n1;2', { delimiter: 'auto' }), [['x', 'y'], ['1', '2']]);
  throws_code(() => parse_csv('a', { delimiter: '"' }), 'E_SCHEMA');
  throws_code(() => parse_csv('a', { delimiter: ';;' }), 'E_SCHEMA');
});

test('parse_csv: незакрытая кавычка — E_SCHEMA (иначе сдвиг всех строк)', () => {
  throws_code(() => parse_csv('a,b\n"1,2\n3,4'), 'E_SCHEMA');
  assert.throws(() => parse_csv('"abc'), (e) => e.ctx.reason === 'unterminated_quote');
});

test('parse_csv: свойство — запись → разбор возвращает исходные поля (случайные поля со спецсимволами, три разделителя)', () => {
  const rng = make_rng(4180);
  const atoms = ['a', 'б', ' ', '"', ',', ';', '\t', '\n', '\r\n', '=', '12', '😀', '\'', ''];
  const write = (rows, d) => rows.map((r) => r.map((f) => (/["\n\r]/.test(f) || f.includes(d) ? '"' + f.replace(/"/g, '""') + '"' : f)).join(d)).join('\n') + '\n';
  for (let t = 0; t < 300; t++) {
    const d = rng.pick([',', ';', '\t']);
    const nc = rng.int(1, 5);
    const rows = Array.from({ length: rng.int(1, 6) }, () => Array.from({ length: nc }, () => Array.from({ length: rng.int(0, 4) }, () => rng.pick(atoms)).join('')));
    const expect = rows.filter((r) => r.some((f) => f !== ''));
    const text = write(rows, d);
    assert.deepEqual(parse_csv(text, { delimiter: d }), expect, JSON.stringify(text));
  }
});

// ── Даты и суммы ячеек (TST-19, часть) ─────────────────────────────────────────

test('parse_date_fmt: DD/MM/YYYY, YYYY-MM-DD, M/D/YYYY; несуществующие даты и хвосты — null (31/02/2026)', () => {
  assert.equal(parse_date_fmt('03/10/2026', 'DD/MM/YYYY'), D('2026-10-03'));
  assert.equal(parse_date_fmt('2026-10-03', 'YYYY-MM-DD'), D('2026-10-03'));
  assert.equal(parse_date_fmt('3/9/2026', 'D/M/YYYY'), D('2026-09-03'));
  assert.equal(parse_date_fmt('10/3/2026', 'M/D/YYYY'), D('2026-10-03'));
  assert.equal(parse_date_fmt('03.10.2026', 'DD.MM.YYYY'), D('2026-10-03'));
  assert.equal(parse_date_fmt('31/02/2026', 'DD/MM/YYYY'), null, 'нет такой даты');
  assert.equal(parse_date_fmt('29/02/2028', 'DD/MM/YYYY'), D('2028-02-29'));
  assert.equal(parse_date_fmt('29/02/2026', 'DD/MM/YYYY'), null);
  assert.equal(parse_date_fmt('03/13/2026', 'DD/MM/YYYY'), null, 'месяц 13');
  assert.equal(parse_date_fmt('03/10/2026 ', 'DD/MM/YYYY'), null, 'остался хвост');
  assert.equal(parse_date_fmt('03-10-2026', 'DD/MM/YYYY'), null, 'литерал не совпал');
  assert.equal(parse_date_fmt('3/10/26', 'D/MM/YYYY'), null, 'год из 2 цифр');
  assert.equal(parse_date_fmt('', 'DD/MM/YYYY'), null);
  assert.equal(parse_date_fmt('03/10/0000', 'DD/MM/YYYY'), null);
});

test('TST-19 (часть): parse_amount_cell — «-1.234,56» → −123456; «12,345» при двух знаках → null; U+2212, NBSP, пробел-разделитель', () => {
  const ru = { decimal: ',', thousands: '.' };
  assert.equal(parse_amount_cell('-1.234,56', ru, 2), -123456);
  assert.equal(parse_amount_cell('1.234,56', ru, 2), 123456);
  assert.equal(parse_amount_cell('47,30', ru, 2), 4730);
  assert.equal(parse_amount_cell('12,345', ru, 2), null, 'знаков больше exponent — не округляется');
  assert.equal(parse_amount_cell('', ru, 2), null);
  assert.equal(parse_amount_cell('abc', ru, 2), null);
  assert.equal(parse_amount_cell('−5,00', ru, 2), -500, 'U+2212');
  assert.equal(parse_amount_cell('1 234,56', { decimal: ',', thousands: ' ' }, 2), 123456, 'NBSP внутри числа');
  assert.equal(parse_amount_cell('1 234,56', { decimal: ',', thousands: '' }, 2), 123456, 'узкий NBSP');
  assert.equal(parse_amount_cell('1,234.56', { decimal: '.', thousands: ',' }, 2), 123456);
  assert.equal(parse_amount_cell('1500', { decimal: '.', thousands: '' }, 0), 1500, 'JPY: exponent 0');
  assert.equal(parse_amount_cell('0.5', { decimal: '.', thousands: '' }, 8), 50000000, 'BTC');
  assert.equal(parse_amount_cell('9007199254740992', { decimal: '.' }, 0), null, 'переполнение — null, а не исключение');
});

// ── TST-42: ключи ─────────────────────────────────────────────────────────────

test('TST-42 TV-1: dedup_key — векторы канона, norm', () => {
  assert.equal(norm('MERCADONA  *1234 Valencia, ES'), 'mercadona 1234 valencia es');
  assert.equal(dedup_key('acc_bank', '2026-10-03', -4730, 'EUR', 'MERCADONA  *1234 Valencia, ES', 0), 'f78f01e9751c5f66');
  assert.equal(dedup_key('acc_bank', '2026-10-03', -450, 'EUR', 'Cafe Central', 0), '9d82db80ee854a7c');
  assert.equal(dedup_key('acc_bank', '2026-10-03', -450, 'EUR', 'Cafe Central', 1), 'b9f6b8bb563b3b40');
  assert.equal(dedup_key('acc_bank', '2026-10-04', 123456, 'EUR', 'Transferencia cliente', 0), 'd371042d2b343ddb');
});

// ── TST-43: профиль, сухой прогон ─────────────────────────────────────────────

const PROFILE_X = {
  profile_id: 'bank-x-semicolon', v: 1, encoding: 'utf-8', delimiter: ';', skip: 0,
  date: { col: 'Fecha', fmt: 'DD/MM/YYYY' },
  amount: { mode: 'debit_credit', debit: 'Cargo', credit: 'Abono', decimal: ',', thousands: '.' },
  currency: { fixed: 'EUR' }, desc: { cols: ['Concepto'] }, rules: [{ match: '^MERCADONA', tag: 'продукты' }],
};
const FILE_X = [
  'Fecha;Concepto;Cargo;Abono',
  '03/10/2026;MERCADONA  *1234 Valencia, ES;47,30;',
  '03/10/2026;Cafe Central;4,50;',
  '03/10/2026;Cafe Central;4,50;',
  '04/10/2026;Transferencia cliente;;1.234,56',
  '31/02/2026;Error fecha;10,00;',
  '01/10/2026;Doble columna;5,00;5,00',
].join('\n');
const CTX_X = { account_id: 'acc_bank', account_currency: 'EUR', as_of: '2026-10-04' };

test('TST-43 TV-2: профиль и сухой прогон — распознано 2 · отклонено 2 · дубликатов 2, 2 + 2 + 2 = 6, сумма распознанных 123006', () => {
  const r = parse_with_profile(PROFILE_X, FILE_X, CTX_X);
  assert.equal(r.rows_total, 6);
  assert.deepEqual(r.candidates.map((c) => [c.row, c.amount_minor, c.k]), [[2, -4730, 0], [3, -450, 0], [4, -450, 1], [5, 123456, 0]]);
  assert.deepEqual(r.rejects, [{ row: 6, reason: 'bad_date' }, { row: 7, reason: 'both_debit_credit' }]);
  assert.equal(r.candidates[0].dedup_key, 'f78f01e9751c5f66');
  assert.equal(r.candidates[1].dedup_key, '9d82db80ee854a7c');
  assert.equal(r.candidates[2].dedup_key, 'b9f6b8bb563b3b40');
  assert.equal(r.candidates[3].dedup_key, 'd371042d2b343ddb');
  assert.equal(r.candidates[0].tag, 'продукты', 'литеральное правило ^MERCADONA');
  assert.equal(r.candidates[1].tag, null);
  assert.equal(r.candidates[0].date, D('2026-10-03'));
  assert.equal(r.candidates[0].desc, 'MERCADONA  *1234 Valencia, ES');

  const existing = new Set(['f78f01e9751c5f66', '9d82db80ee854a7c']);
  const d = dry_run(r.candidates, existing, r.rejects, [], {});
  assert.equal(d.recognized, 2);
  assert.equal(d.rejected, 2);
  assert.equal(d.duplicates, 2);
  assert.equal(d.rows_total, 6);
  assert.equal(d.recognized + d.rejected + d.duplicates, d.rows_total);
  assert.equal(d.recognized_items.reduce((s, c) => s + c.amount_minor, 0), 123006, '−450 + 123456');
  assert.deepEqual(d.recognized_items.map((c) => c.dedup_key), ['b9f6b8bb563b3b40', 'd371042d2b343ddb']);
  assert.deepEqual(d.doubles, []);
  assert.equal(d.from, D('2026-10-03'));
  assert.equal(d.to, D('2026-10-04'));
});

test('TST-32 / TST-43: повторный импорт после записи — распознано 0, дубликатов 4, отклонено 2; откат партии освобождает ключи', () => {
  const j = journal_builder();
  j.add('account.opened', { account_id: 'acc_bank', name: 'bank', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 });
  const parsed = parse_with_profile(PROFILE_X, FILE_X, CTX_X);
  const dry = dry_run(parsed.candidates, existing_keys_of(state_of(j.events)), parsed.rejects, [], {});
  assert.equal(dry.recognized, 4);
  const ports = { next_id: (() => { let n = 100; return () => `ev${++n}`; })(), next_seq: j.next_seq, recorded_at: '2026-10-04T09:00:00Z' };
  const evs = import_commit(dry, {}, FILE_X, { ...ports, batch_id: 'batch-1', profile_id: 'bank-x-semicolon' });
  j.events.push(...evs);
  assert.equal(evs[0].type, 'import.started');
  assert.equal(evs[0].payload.counts.recognized, 4);
  assert.match(evs[0].payload.source_hash, /^[0-9a-f]{64}$/);
  assert.equal(evs.length, 5);
  assert.ok(evs.slice(1).every((e) => e.type === 'tx.posted' && e.actor === 'import:batch-1'));

  const s1 = state_of(j.events);
  assert.equal(Object.keys(s1.facts).length, 4);
  const again = dry_run(parsed.candidates, existing_keys_of(s1), parsed.rejects, Object.values(s1.facts), {});
  assert.deepEqual([again.recognized, again.duplicates, again.rejected], [0, 4, 2], 'идемпотентность: 0 новых записей');
  assert.equal(import_commit(again, {}, FILE_X, { ...ports, batch_id: 'batch-2' }).length, 1, 'только import.started, фактов нет');

  // откат партии
  const rb = import_rollback('batch-1', j.events, ports);
  assert.equal(rb.length, 5, '4 revert + import.rolled_back');
  assert.deepEqual(rb.slice(0, 4).map((e) => e.type), ['revert', 'revert', 'revert', 'revert']);
  assert.equal(rb[4].type, 'import.rolled_back');
  j.events.push(...rb);
  const s2 = state_of(j.events);
  assert.equal(Object.keys(s2.facts).length, 0, 'факты откатаны');
  // state_hash возвращается к значению до импорта везде, кроме журнала партий: import.rolled_back оставляет в state.imports запись об откате (см. spec_issues)
  assert.equal(state_hash({ ...s2, imports: {} }), state_hash({ ...state_of(j.events.slice(0, 1)), imports: {} }), 'проекция без реестра партий совпадает с исходной');
  assert.equal(existing_keys_of(s2).size, 0, 'ключи откатанных записей не считаются существующими');
  assert.equal(s2.imports['batch-1'].rolled_back, true);
  assert.deepEqual(import_rollback('batch-1', j.events, ports), [], 'повторный откат ничего не добавляет');
  const re = dry_run(parsed.candidates, existing_keys_of(s2), parsed.rejects, Object.values(s2.facts), {});
  assert.equal(re.recognized, 4, 'после отката файл импортируется снова');
  // откат отката возвращает записи (TST-32)
  const undo = journal_builder(j.peek() + 1);
  const target = rb[0];
  j.events.push(make_event('revert', { target: target.event_id }, { event_id: 'undo-1', seq: undo.next_seq(), recorded_at: '2026-10-04T10:00:00Z' }));
  assert.equal(Object.keys(state_of(j.events).facts).length, 1, 'откат отката возвращает одну запись');
});

test('TST-43 TV-2 + существующие записи: второй кофе (k = 1) не считается двойником первого (k = 0)', () => {
  const parsed = parse_with_profile(PROFILE_X, FILE_X, CTX_X);
  const ex = [
    { event_id: 'x1', type: 'tx.posted', payload: { account_id: 'acc_bank', date: '2026-10-03', amount_minor: -4730, currency: 'EUR', dedup_key: 'f78f01e9751c5f66' } },
    { event_id: 'x2', type: 'tx.posted', payload: { account_id: 'acc_bank', date: '2026-10-03', amount_minor: -450, currency: 'EUR', dedup_key: '9d82db80ee854a7c' } },
  ];
  const d = dry_run(parsed.candidates, new Set(['f78f01e9751c5f66', '9d82db80ee854a7c']), parsed.rejects, ex, {});
  assert.deepEqual([d.recognized, d.rejected, d.duplicates], [2, 2, 2]);
  assert.deepEqual(d.doubles, [], 'записи, объяснённые ключами файла, двойниками не являются');
  assert.equal(d.overlap_days, 1, 'последняя импортированная запись 10-03, выписка начинается 10-03: 10-03 − 10-03 + 1');
  assert.equal(d.gap_days, 0);
});

test('TST-43 TV-3: возможный двойник — ручная запись без dedup_key (−4730 на 10-02) vs кандидат MERCADONA (10-03); запись закрепляется за первым', () => {
  const manual = { event_id: 'm1', type: 'tx.posted', payload: { account_id: 'acc_bank', date: '2026-10-02', amount_minor: -4730, currency: 'EUR' } };
  const file = [
    'Fecha;Concepto;Cargo;Abono',
    '03/10/2026;MERCADONA  *1234 Valencia, ES;47,30;',
    '03/10/2026;Otro comercio;47,30;',
    '20/10/2026;Muy lejos;47,30;',
  ].join('\n');
  const r = parse_with_profile(PROFILE_X, file, { ...CTX_X, as_of: '2026-12-01' });
  const d = dry_run(r.candidates, new Set(), r.rejects, [manual], {});
  assert.equal(d.recognized, 3);
  assert.deepEqual(d.doubles, [2], 'только первая строка (по номеру записи); вторая той же суммы флага не получает');
  assert.equal(d.recognized_items[0].double, 'm1');
  assert.equal(d.recognized_items[1].double, null);
  assert.equal(d.recognized_items[2].double, null, 'вне окна ±3 дня');
  // решение пользователя: без решения — skip, с accept — запись
  const ports = { next_id: (() => { let n = 0; return () => `n${++n}`; })(), next_seq: (() => { let n = 0; return () => ++n; })(), recorded_at: '2026-10-04T09:00:00Z' };
  const skip = import_commit(d, {}, file, { ...ports, batch_id: 'b' });
  assert.equal(skip.filter((e) => e.type === 'tx.posted').length, 2, 'двойник пропущен без решения');
  const acc = import_commit(d, { 2: 'accept' }, file, { ...ports, batch_id: 'b' });
  assert.equal(acc.filter((e) => e.type === 'tx.posted').length, 3);
  const mp = new Map([[2, 'accept']]);
  assert.equal(import_commit(d, mp, file, { ...ports, batch_id: 'b' }).filter((e) => e.type === 'tx.posted').length, 3, 'решения — и Map');
});

test('dry_run: окно двойника ±match.window_days включительно (Δ = 3 — двойник, Δ = 4 — нет), окно настраивается параметром', () => {
  const mk = (iso) => parse_with_profile({ ...PROFILE_X, rules: [] }, `Fecha;Concepto;Cargo;Abono
${iso};Tienda;47,30;`, { ...CTX_X, as_of: '2027-01-01' }).candidates;
  const manual = { event_id: 'm1', type: 'tx.posted', payload: { account_id: 'acc_bank', date: '2026-10-02', amount_minor: -4730, currency: 'EUR' } };
  assert.deepEqual(dry_run(mk('05/10/2026'), new Set(), [], [manual], {}).doubles, [2], 'Δ = +3');
  assert.deepEqual(dry_run(mk('29/09/2026'), new Set(), [], [manual], {}).doubles, [2], 'Δ = −3');
  assert.deepEqual(dry_run(mk('06/10/2026'), new Set(), [], [manual], {}).doubles, [], 'Δ = +4');
  assert.deepEqual(dry_run(mk('06/10/2026'), new Set(), [], [manual], { 'match.window_days': 4 }).doubles, [2], 'окно 4');
  assert.deepEqual(dry_run(mk('06/10/2026'), new Set(), [], [manual], { match: { window_days: 4 } }).doubles, [2], 'вложенная форма params');
  throws_code(() => dry_run(mk('06/10/2026'), new Set(), [], [manual], { 'match.window_days': -1 }), 'E_SCHEMA');
  // другая валюта и другой счёт — не двойник
  const other = { ...manual, payload: { ...manual.payload, currency: 'USD' } };
  assert.deepEqual(dry_run(mk('03/10/2026'), new Set(), [], [other], {}).doubles, []);
});

test('dry_run: пересечение и разрыв выписок (overlap_days, gap_days); коллизия ключа с другими полями — не дубликат', () => {
  const mk = (iso, amount, desc) => parse_with_profile({ ...PROFILE_X, rules: [] }, `Fecha;Concepto;Cargo;Abono\n${iso};${desc};${amount};`, { ...CTX_X, as_of: '2027-01-01' }).candidates[0];
  const c = mk('10/10/2026', '5,00', 'Tienda');
  const old = (iso) => ({ event_id: 'e', type: 'tx.posted', payload: { account_id: 'acc_bank', date: iso, amount_minor: -1, currency: 'EUR', dedup_key: 'aaaaaaaaaaaaaaaa' } });
  assert.deepEqual([dry_run([c], new Set(), [], [old('2026-10-12')], {}).overlap_days, dry_run([c], new Set(), [], [old('2026-10-12')], {}).gap_days], [3, 0], '12 − 10 + 1');
  const gap = dry_run([c], new Set(), [], [old('2026-10-05')], {});
  assert.deepEqual([gap.overlap_days, gap.gap_days], [0, 4], 'с 10-06 по 10-09 — 4 дня без данных');
  const none = dry_run([c], new Set(), [], [], {});
  assert.deepEqual([none.overlap_days, none.gap_days], [0, 0]);
  // ключ есть в existing_keys, но запись с этим ключом — другая (коллизия 64 бит): не дубликат
  const collide = { event_id: 'z', type: 'tx.posted', payload: { account_id: 'acc_bank', date: '2020-01-01', amount_minor: 777, currency: 'EUR', dedup_key: c.dedup_key } };
  assert.equal(dry_run([c], new Set([c.dedup_key]), [], [collide], {}).recognized, 1);
  assert.equal(dry_run([c], new Set([c.dedup_key]), [], [], {}).duplicates, 1, 'без записи с этим ключом — дубликат');
  assert.deepEqual(dry_run([], new Set(), [{ row: 2, reason: 'x' }], [], {}), {
    recognized: 0, rejected: 1, duplicates: 0, rows_total: 1, doubles: [], from: null, to: null, overlap_days: 0, gap_days: 0, recognized_items: [], duplicate_items: [],
  });
});

test('TST-43: причины отклонения — short_row, bad_date, future_date, unknown_currency, currency_mismatch, bad_amount, empty_amount, both_debit_credit, sign_in_debit_credit, zero_amount', () => {
  const p = { ...PROFILE_X, currency: { col: 'Moneda' }, rules: [] };
  const text = [
    'Fecha;Concepto;Cargo;Abono;Moneda',
    '03/10/2026;a;1,00;',
    '03/10/2026;b;1,00;;EUR',
    'xx;c;1,00;;EUR',
    '05/10/2026;d;1,00;;EUR',
    '03/10/2026;e;1,00;;XXX',
    '03/10/2026;f;1,00;;USD',
    '03/10/2026;g;12,345;;EUR',
    '03/10/2026;h;;;EUR',
    '03/10/2026;i;1,00;2,00;EUR',
    '03/10/2026;j;-1,00;;EUR',
    '03/10/2026;k;0,00;;EUR',
    '03/10/2026;l;1,00;;eur',
    '03/10/2026;m;+1,00;;EUR',
    '03/10/2026;n;abc;;EUR',
  ].join('\n');
  const r = parse_with_profile(p, text, CTX_X);
  assert.deepEqual(r.rejects.map((x) => x.reason), [
    'short_row', null, 'bad_date', 'future_date', 'unknown_currency', 'currency_mismatch', 'bad_amount', 'empty_amount', 'both_debit_credit',
    'sign_in_debit_credit', 'zero_amount', null, 'sign_in_debit_credit', 'bad_amount',
  ].filter((x) => x !== null));
  assert.equal(r.candidates.length, 2, 'b и l (код валюты приводится к верхнему регистру)');
  assert.equal(r.rows_total, 14);
  assert.equal(r.candidates.length + r.rejects.length, r.rows_total);
});

test('TST-43: signed-режим, skip преамбулы, колонки по индексу, desc из нескольких колонок, управляющие символы, будущая дата', () => {
  const profile = {
    delimiter: ',', skip: 2, date: { col: 0, fmt: 'YYYY-MM-DD' }, amount: { mode: 'signed', col: 3, decimal: '.', thousands: ',' },
    currency: { fixed: 'EUR' }, desc: { cols: [1, 2] }, rules: [{ match: 'coffee', tag: 'кофе' }, { match: 'x', tag: 'иное' }],
  };
  const text = '﻿Banco Ejemplo,,,\nExtracto octubre,,,\nFecha,Desc,Ref,Importe\n2026-10-01,Blue Coffee,\tref\u0007 1,-3.50\n2026-10-02,Salary,,"1,500.00"\n2026-10-04,Late,,5.00\n2026-12-01,Future,,5.00\n';
  const r = parse_with_profile(profile, text, CTX_X);
  assert.equal(r.rows_total, 4);
  assert.deepEqual(r.candidates.map((c) => [c.row, c.amount_minor, c.desc, c.tag]), [
    [4, -350, 'Blue Coffee ref  1', 'кофе'], [5, 150000, 'Salary', null], [6, 500, 'Late', null],
  ]);
  assert.deepEqual(r.rejects, [{ row: 7, reason: 'future_date' }]);
  // заголовок обязателен: файл короче преамбулы
  throws_code(() => parse_with_profile(profile, 'a,b\n', CTX_X), 'E_SCHEMA');
  // неизвестная колонка по имени / индекс за пределами заголовка
  throws_code(() => parse_with_profile({ ...profile, skip: 0, date: { col: 'Nope', fmt: 'YYYY-MM-DD' } }, text, CTX_X), 'E_SCHEMA');
  throws_code(() => parse_with_profile({ ...profile, skip: 2, amount: { mode: 'signed', col: 9 } }, text, CTX_X), 'E_SCHEMA');
});

test('TST-43: профиль — только данные; неизвестные поля, функции и regex отвергаются; метки — литералы без ReDoS', () => {
  const ok = validate_profile(PROFILE_X);
  assert.deepEqual(ok, { ok: true, errors: [] });
  const bad = (patch) => validate_profile({ ...PROFILE_X, ...patch });
  assert.equal(bad({ transform: 'x => x' }).ok, false, 'неизвестное поле');
  assert.equal(bad({ delimiter: '|' }).ok, false);
  assert.equal(bad({ date: { col: 'Fecha', fmt: 'DD/MM' } }).ok, false, 'в шаблоне нет года');
  assert.equal(bad({ date: { col: 'Fecha', fmt: 'DD/MM/YYYY', fn: 'eval' } }).ok, false);
  assert.equal(bad({ amount: { mode: 'debit_credit', debit: 'a', credit: 'b', col: 'c' } }).ok, false);
  assert.equal(bad({ amount: { mode: 'signed' } }).ok, false, 'нет col');
  assert.equal(bad({ amount: { mode: 'debit_credit', debit: 'a', credit: 'b', decimal: ',', thousands: ',' } }).ok, false, 'одинаковые знаки');
  assert.equal(bad({ currency: { fixed: 'EUR', col: 'M' } }).ok, false);
  assert.equal(bad({ currency: { fixed: 'eur' } }).ok, false);
  assert.equal(bad({ desc: { cols: [] } }).ok, false);
  assert.equal(bad({ rules: [{ match: '.*', tag: 'x' }] }).ok, false, '«.*» после norm пусто — не правило');
  assert.equal(bad({ rules: [{ match: 'a', tag: 'x', regex: true }] }).ok, false);
  assert.equal(bad({ skip: -1 }).ok, false);
  assert.equal(validate_profile(null).ok, false);
  throws_code(() => parse_with_profile({ ...PROFILE_X, transform: 1 }, FILE_X, CTX_X), 'E_SCHEMA');
  // литералы: ведущий ^ — префикс, иначе подстрока; по norm(desc)
  assert.equal(rule_matches({ match: '^MERCADONA' }, norm('MERCADONA  *1234')), true);
  assert.equal(rule_matches({ match: '^1234' }, norm('MERCADONA  *1234')), false);
  assert.equal(rule_matches({ match: '1234' }, norm('MERCADONA  *1234')), true);
  assert.equal(rule_matches({ match: 'ÁÉ' }, norm('xáéx')), true, 'регистр и диакритика — как в norm');
  assert.equal(rule_matches({ match: '' }, 'abc'), false);
  const evil = '(a+)+$';
  const t0 = Date.now();
  assert.equal(rule_matches({ match: evil }, 'a'.repeat(5000) + '!'), true, 'литерал norm → «a»: подстрока, никакого regex');
  assert.ok(Date.now() - t0 < 200, 'ReDoS невозможен');
});

test('TST-43: файл больше 5 МБ отвергается ДО разбора; граница ровно 5 МБ допустима; незакрытая кавычка — E_SCHEMA', () => {
  const big = 'a'.repeat(5 * 1024 * 1024 + 1);
  assert.throws(() => parse_with_profile(PROFILE_X, big, CTX_X), (e) => e.code === 'E_SCHEMA' && e.ctx.reason === 'file_too_large');
  const wide = 'я'.repeat(3 * 1024 * 1024); // 3 Mi символов = 6 МиБ в UTF-8
  assert.throws(() => parse_with_profile(PROFILE_X, wide, CTX_X), (e) => e.ctx.reason === 'file_too_large');
  const exact = 'Fecha;Concepto;Cargo;Abono\n' + ' '.repeat(5 * 1024 * 1024 - 27);
  assert.equal(exact.length, 5 * 1024 * 1024);
  assert.doesNotThrow(() => parse_with_profile(PROFILE_X, exact, CTX_X));
  assert.throws(() => parse_with_profile(PROFILE_X, 'Fecha;Concepto;Cargo;Abono\n03/10/2026;"abc;1,00;', CTX_X), (e) => e.ctx.reason === 'unterminated_quote');
  throws_code(() => parse_with_profile(PROFILE_X, FILE_X, { account_id: 'a' }), 'E_SCHEMA');
});

test('TST-32 инв. 3–4: ключи в партии уникальны, мультимножество не зависит от порядка строк, разбор детерминирован', () => {
  const rng = make_rng(32);
  const descs = ['Cafe', 'Tienda', 'Banco', 'Cafe '];
  const rows = Array.from({ length: 40 }, () => `0${rng.int(1, 3)}/10/2026;${rng.pick(descs)};${rng.pick(['1,00', '2,50', '3,00'])};`);
  const head = 'Fecha;Concepto;Cargo;Abono';
  const base = parse_with_profile({ ...PROFILE_X, rules: [] }, [head, ...rows].join('\n'), CTX_X);
  const keys = base.candidates.map((c) => c.dedup_key);
  assert.equal(new Set(keys).size, keys.length, 'ключи внутри партии уникальны');
  const again = parse_with_profile({ ...PROFILE_X, rules: [] }, [head, ...rows].join('\n'), CTX_X);
  assert.deepEqual(again, base, 'побайтно равные кандидаты');
  for (let t = 0; t < 20; t++) {
    const sh = [...rows];
    for (let i = sh.length - 1; i > 0; i--) { const j = rng.int(0, i); [sh[i], sh[j]] = [sh[j], sh[i]]; }
    const r = parse_with_profile({ ...PROFILE_X, rules: [] }, [head, ...sh].join('\n'), CTX_X);
    assert.deepEqual(r.candidates.map((c) => c.dedup_key).sort(), [...keys].sort(), 'мультимножество ключей не зависит от порядка строк');
  }
});

// ── CSV журнала, csv_safe_cell (X5) ───────────────────────────────────────────

test('TST-43 TV-4: csv_safe_cell — формулы экранируются только префиксом «\'»', () => {
  assert.equal(csv_safe_cell('=HYPERLINK("http://x")'), '\'=HYPERLINK("http://x")');
  assert.equal(csv_safe_cell('-5 coffee'), '\'-5 coffee');
  assert.equal(csv_safe_cell('+1'), '\'+1');
  assert.equal(csv_safe_cell('@SUM(A1)'), '\'@SUM(A1)');
  assert.equal(csv_safe_cell('\tx'), '\'\tx');
  assert.equal(csv_safe_cell('\rx'), '\'\rx');
  assert.equal(csv_safe_cell('кофе'), 'кофе');
  assert.equal(csv_safe_cell('a=b'), 'a=b', 'только первый символ');
  assert.equal(csv_safe_cell(''), '');
  assert.equal(csv_safe_cell(null), '');
});

function csv_state() {
  const j = journal_builder();
  j.add('account.opened', { account_id: 'acc_bank', name: 'bank', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 });
  j.add('counterparty.set', { counterparty_id: 'cp1', name: '=Evil, Corp' });
  j.add('tx.posted', { account_id: 'acc_bank', date: '2026-10-03', amount_minor: -4730, currency: 'EUR', tag: 'продукты', note: '=HYPERLINK("http://x")', dedup_key: 'f78f01e9751c5f66', counterparty_id: 'cp1' }, { entity_id: 'tx_1' });
  j.add('tx.posted', { account_id: 'acc_bank', date: '2026-10-03', amount_minor: -450, currency: 'EUR', tag: '-5 coffee', note: 'Cafe, "Central"\nline2' }, { entity_id: 'tx_2' });
  j.add('tx.posted', { account_id: 'acc_bank', date: '2026-10-04', amount_minor: 123456, currency: 'EUR', note: 'Transferencia' }, { entity_id: 'tx_3' });
  j.add('plan.set', { plan_id: 'P-TAX1', account_id: 'acc_bank', date: '2026-10-23', amount_minor: -50000, currency: 'EUR', tag: 'налог' });
  return j;
}

test('TST-43: export_csv(journal) — колонки, LF, числа без изменений, текстовые экранируются, кавычки; формат C-045', () => {
  const st = state_of(csv_state().events);
  const out = export_csv(st, 'journal');
  assert.ok(out.endsWith('\n') && !out.includes('\r\n'));
  const rows = parse_csv(out);
  assert.deepEqual(rows[0], ['date', 'account_id', 'amount_minor', 'currency', 'kind', 'layer', 'tag', 'counterparty', 'note', 'event_id', 'dedup_key']);
  assert.equal(rows.length, 1 + 3 + 1, 'три факта и один план');
  const by_id = Object.fromEntries(rows.slice(1).map((r) => [r[9], r]));
  const tx1 = by_id.ev0003;
  assert.deepEqual(tx1.slice(0, 6), ['2026-10-03', 'acc_bank', '-4730', 'EUR', 'expense', 'posted'], 'amount_minor «-4730» не экранируется');
  assert.equal(tx1[6], 'продукты');
  assert.equal(tx1[7], '\'=Evil, Corp', 'контрагент (имя) — текстовая колонка');
  assert.equal(tx1[8], '\'=HYPERLINK("http://x")');
  assert.equal(tx1[10], 'f78f01e9751c5f66');
  const tx2 = by_id.ev0004;
  assert.equal(tx2[6], '\'-5 coffee');
  assert.equal(tx2[8], 'Cafe, "Central"\nline2', 'запятая, кавычки и LF внутри поля сохраняются кавычками CSV');
  assert.equal(by_id.ev0005[4], 'income');
  const plan = rows.find((r) => r[5] === 'planned');
  assert.deepEqual(plan.slice(0, 3), ['2026-10-23', 'acc_bank', '-50000']);
  assert.equal(plan[9], 'P-TAX1');
  // ни одна текстовая ячейка не начинается с = + - @ TAB CR
  for (const r of rows.slice(1)) for (const c of [6, 7, 8]) assert.ok(!/^[=+\-@\t\r]/.test(r[c]), `колонка ${c}: ${JSON.stringify(r[c])}`);
  // порядок детерминирован (date, amount_minor, id)
  assert.equal(export_csv(st, 'journal'), out);
  throws_code(() => export_csv(st, 'rules'), 'E_SCHEMA');
});

test('TST-43: runway-csv/1 при импорте снимает ведущий «\'» (только факты; планы отфильтровываются)', () => {
  const st = state_of(csv_state().events);
  const csv = export_csv(st, 'journal');
  assert.equal(validate_profile(RUNWAY_CSV_PROFILE).ok, true);
  const r = parse_with_profile(RUNWAY_CSV_PROFILE, csv, { account_id: 'acc_bank', account_currency: 'EUR', as_of: '2026-12-31' });
  assert.equal(r.rows_total, 4);
  assert.deepEqual(r.rejects.map((x) => x.reason), ['filtered_out'], 'строка плана не становится фактом');
  assert.deepEqual(r.candidates.map((c) => [c.amount_minor, c.desc]), [
    [-4730, '=HYPERLINK("http://x")'], [-450, 'Cafe, "Central" line2'], [123456, 'Transferencia'],
  ]);
  assert.equal(Object.isFrozen(RUNWAY_CSV_PROFILE), true);
});

// ── TST-38: JSON-копия ────────────────────────────────────────────────────────

test('TST-38: export_json — каноническая форма, события по seq; import_json возвращает состояние с тем же state_hash (G-001)', () => {
  const j = g001_journal();
  const text = export_json(j.events, { engine_version: '0.1.0' });
  const obj = JSON.parse(text);
  assert.equal(obj.format, 'runway-journal/1');
  assert.equal(obj.format, JOURNAL_FORMAT);
  assert.equal(obj.engine_version, '0.1.0');
  assert.deepEqual(obj.events.map((e) => e.seq), obj.events.map((_, i) => i + 1));
  assert.equal(text, canon(obj), 'текст — канонический JSON');
  const back = import_json(text);
  assert.equal(state_hash(back), state_hash(state_of(j.events)));
  assert.equal(back.anchors.anc_main_20261004.amount_minor, 400000, 'opening G-001 сохраняется');
  assert.equal(Object.keys(back.rules).length, 4);
  // порядок записей на входе не влияет на файл
  assert.equal(export_json([...j.events].reverse(), { engine_version: '0.1.0' }), text);
  // контейнер {events} и стабильность повторного экспорта
  assert.equal(export_json({ events: j.events, engine_version: '0.1.0' }), text);
  assert.equal(export_json(read_journal_json(text).events, { engine_version: '0.1.0' }), text, 'экспорт(импорт(экспорт)) совпадает побайтно');
});

test('TST-38: свойство — state_hash(import_json(export_json(j))) = state_hash(свёртка j) на случайных журналах (откаты, правки, NFC, юникод)', () => {
  const rng = make_rng(38);
  const texts = ['кофе', 'Café', 'Café', 'a"b', 'line\nbreak', '=cmd', '😀', '', 'tab\tx', '\\back'];
  for (let t = 0; t < 400; t++) {
    const j = journal_builder();
    j.add('account.opened', { account_id: 'acc_a', name: 'a', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 });
    j.add('account.opened', { account_id: 'acc_b', name: 'b', kind: 'cash', liquidity: 'operating', currency: 'USD', exponent: 2 });
    const ids = [];
    const n = rng.int(0, 25);
    for (let i = 0; i < n; i++) {
      const kind = rng.int(0, 9);
      const day = format_date(D('2026-01-01') + rng.int(0, 400));
      const acc = rng.pick(['acc_a', 'acc_b']);
      let e;
      if (kind <= 3) {
        e = j.add('tx.posted', { account_id: acc, date: day, amount_minor: rand_safe(rng, 40), currency: acc === 'acc_a' ? 'EUR' : 'USD', tag: rng.pick(texts), note: rng.pick(texts) }, { entity_id: `tx${i}`, ...(rng.int(0, 4) === 0 && ids.length > 0 ? { supersedes_id: rng.pick(ids) } : {}) });
      } else if (kind === 4) e = j.add('anchor.set', { anchor_id: `anc${i}`, account_id: acc, date: day, amount_minor: rand_safe(rng, 40) });
      else if (kind === 5) e = j.add('plan.set', { plan_id: `pl${i}`, account_id: acc, date: day, amount_minor: -rand_safe(rng, 30) - 1, currency: 'EUR', tag: rng.pick(texts) });
      else if (kind === 6) e = j.add('params.set', { buffer_minor: rng.int(0, 100000), 'match.tol_bp': rng.int(0, 1000) }, { entity_id: 'ws1' });
      else if (kind === 7 && ids.length > 0) e = j.add('revert', { target: rng.pick(ids) });
      else if (kind === 8 && ids.length > 0) e = j.add('match.set', { fact_event_id: rng.pick(ids), no_plan: rng.bool() });
      else e = j.add('rule.set', { ...g001_rules()[rng.int(0, 3)], version: rng.int(1, 5) });
      if (e.type === 'tx.posted') ids.push(e.event_id);
      else if (e.type !== 'revert' && rng.bool()) ids.push(e.event_id);
    }
    const text = export_json(j.events, { engine_version: 'test' });
    const expect = state_hash(state_of(j.events));
    assert.equal(state_hash(import_json(text)), expect, `журнал #${t}`);
    assert.equal(export_json(read_journal_json(text).events, { engine_version: 'test' }), text, 'формат стабилен');
  }
});

test('TST-38: ошибки формата — не JSON, чужой format, новее известного (только чтение), нет seq, float, State вместо журнала', () => {
  const j = g001_journal();
  const text = export_json(j.events);
  assert.throws(() => import_json('{oops'), (e) => e.code === 'E_SCHEMA' && e.ctx.reason === 'bad_json');
  assert.throws(() => import_json('[]'), (e) => e.ctx.reason === 'not_object');
  assert.throws(() => import_json(JSON.stringify({ format: 'other/1', events: [] })), (e) => e.ctx.reason === 'bad_format');
  assert.throws(() => import_json(JSON.stringify({ format: 'runway-journal/2', events: [] })), (e) => e.ctx.reason === 'newer_format', 'формат новее — только чтение');
  assert.throws(() => import_json(JSON.stringify({ format: 'runway-journal/1' })), (e) => e.ctx.reason === 'events_required');
  const no_seq = JSON.parse(text);
  delete no_seq.events[0].seq;
  assert.throws(() => import_json(JSON.stringify(no_seq)), (e) => e.ctx.reason === 'seq_required');
  const newer_v = JSON.parse(text);
  newer_v.events[0].v = 99;
  assert.throws(() => import_json(JSON.stringify(newer_v)), (e) => e.code === 'E_SCHEMA' && e.ctx.reason === 'newer_version', 'запись новее известной схемы');
  const flt = JSON.parse(text);
  flt.events[1].payload.amount_minor = 1.5;
  throws_code(() => import_json(JSON.stringify(flt)), 'E_NOT_INTEGER');
  throws_code(() => export_json(state_of(j.events)), 'E_SCHEMA', 'состояние вместо журнала');
  throws_code(() => export_json([{ type: 'x', payload: {} }]), 'E_SCHEMA', 'без seq');
});

// ── TST-44: hledger ───────────────────────────────────────────────────────────

/** Независимая «мини-hledger»: сумма счёта по обычным транзакциям и разовым правилам `~ ДАТА` (в прогнозе) до даты `end_excl`. */
function mini_bal(text, account, forecast_from, end_excl) {
  const lines = text.split('\n');
  let total = 0;
  let cur = null;
  const parse_amt = (s) => {
    const m = /(-?\d+(?:\.\d+)?)\s+[A-Z]+/.exec(s);
    return Math.round(Number(m[1]) * 100);
  };
  for (const line of lines) {
    let m;
    if ((m = /^(\d{4}-\d{2}-\d{2}) /.exec(line)) !== null) cur = { kind: 'tx', date: m[1] };
    else if ((m = /^~ (\d{4}-\d{2}-\d{2})\s/.exec(line)) !== null) cur = { kind: 'periodic', date: m[1] };
    else if (/^\S/.test(line)) cur = null;
    else if (cur !== null && line.startsWith('    ') && line.slice(4).startsWith(account + '  ')) {
      const amount_part = line.slice(4 + account.length).trim().split(' = ')[0];
      const d = cur.date;
      const ok = cur.kind === 'tx' ? d < end_excl : (d >= forecast_from && d < end_excl);
      if (ok) total += parse_amt(amount_part);
    }
  }
  return total;
}

test('TST-44 TV-5: G-001 → hledger — шапка, commodity, якорь через delta, равно 16 разовых правил (фрагмент канона побайтно)', () => {
  const j = g001_journal();
  const st = state_of(j.events);
  const planned = g001_planned({ связь: 'phone', 'почасовой доход': 'hourly' }); // name — описание правила, tag — метка (счёт расходов)
  const text = export_hledger(st, '2026-10-04', '2026-11-30', { planned });
  const lines = text.split('\n');
  assert.equal(lines[0], '; runway-journal/1 · as_of 2026-10-04 · horizon_end 2026-11-30');
  assert.equal(lines[1], 'commodity 1000.00 EUR');
  assert.equal(lines[2], '');
  assert.deepEqual(lines.slice(3, 7), [
    '2026-10-04 * якорь',
    '    assets:bank  4000.00 EUR = 4000.00 EUR',
    '    equity:opening  -4000.00 EUR',
    '',
  ]);
  const periodic = lines.filter((l) => l.startsWith('~ '));
  assert.equal(periodic.length, 16, '8 продуктов, 2 связь, 2 аренда, 2 ЖКХ, налог, доход');
  const i = lines.indexOf('~ 2026-10-09  связь');
  assert.deepEqual(lines.slice(i, i + 3), ['~ 2026-10-09  связь', '    assets:bank  -25.00 EUR', '    expenses:phone  25.00 EUR']);
  const j2 = lines.indexOf('~ 2026-11-05  почасовой доход');
  assert.deepEqual(lines.slice(j2, j2 + 3), ['~ 2026-11-05  почасовой доход', '    assets:bank  2790.00 EUR', '    income:hourly  -2790.00 EUR']);
  assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'));
  // порядок планов — по (дата, id); детерминизм
  const dates = periodic.map((l) => l.slice(2, 12));
  assert.deepEqual(dates, [...dates].sort());
  assert.equal(export_hledger(st, D('2026-10-04'), D('2026-11-30'), { planned: [...planned].reverse() }), text, 'порядок входа не влияет, даты принимаются и как EpochDay');
  // 16 правил: 8·(−100) + 2·(−25) + 2·(−900) + 2·(−120) + (−500) + 2790 → −339000 + 279000
  const sum = planned.reduce((s, e) => s + e.amount_minor, 0);
  assert.equal(sum, -60000);
});

test('TST-44: независимая сверка — bal assets:bank на 2026-10-31 = 2 055,00 € (close движка 205500), на конец горизонта = 3 400,00 € (end_close 340000)', () => {
  const st = state_of(g001_journal().events);
  const text = export_hledger(st, '2026-10-04', '2026-11-30', { planned: g001_planned() });
  assert.equal(mini_bal(text, 'assets:bank', '2026-10-04', '2026-11-01'), 205500, '-e 2026-11-01');
  assert.equal(mini_bal(text, 'assets:bank', '2026-10-04', '2026-12-01'), 340000, '-e 2026-12-01');
  // «планы на as_of не теряются»: правило на as_of входит, если интервал начинается с as_of
  const edge = { layer: 'planned', cash_event_id: 'X@as_of', account_id: 'acc_main', currency: 'EUR', date: D('2026-10-04'), amount_minor: -100, tag: 'x', status: 'expected' };
  const t2 = export_hledger(st, '2026-10-04', '2026-11-30', { planned: [edge] });
  assert.ok(t2.includes('~ 2026-10-04  x'));
});

test('TST-44: фильтры плана — только expected/overdue, окно [as_of, horizon_end], валюта счёта; matched/skipped/cancelled и чужая валюта не экспортируются', () => {
  const st = state_of(g001_journal().events);
  let n = 0;
  const mk = (over) => ({ layer: 'planned', cash_event_id: 'E' + (n += 1), account_id: 'acc_main', currency: 'EUR', date: D('2026-10-10'), amount_minor: -100, tag: 'x', status: 'expected', ...over });
  const planned = [
    mk({ cash_event_id: 'a' }), mk({ cash_event_id: 'b', status: 'overdue' }), mk({ cash_event_id: 'c', status: 'matched' }),
    mk({ cash_event_id: 'd', status: 'skipped' }), mk({ cash_event_id: 'e', status: 'cancelled' }), mk({ cash_event_id: 'f', currency: 'USD' }),
    mk({ cash_event_id: 'g', date: D('2026-10-03') }), mk({ cash_event_id: 'h', date: D('2026-12-01') }), mk({ cash_event_id: 'i', layer: 'hypothetical' }),
    mk({ cash_event_id: 'j', account_id: 'acc_unknown' }), mk({ cash_event_id: 'k', date: D('2026-11-30') }),
  ];
  const text = export_hledger(st, '2026-10-04', '2026-11-30', { planned });
  assert.equal(text.split('\n').filter((l) => l.startsWith('~ ')).length, 3, 'a, b, k');
  // без opts.planned берутся разовые планы state.plans (P-TAX1), если они не закрыты фактом по plan_ref
  const t2 = export_hledger(st, '2026-10-04', '2026-11-30');
  assert.deepEqual(t2.split('\n').filter((l) => l.startsWith('~ ')), ['~ 2026-10-23  налог']);
  const j = g001_journal();
  const f = j.add('tx.posted', { account_id: 'acc_main', date: '2026-10-03', amount_minor: -50000, currency: 'EUR', tag: 'налог' }, { entity_id: 'tx_tax' });
  j.add('match.set', { fact_event_id: f.event_id, plan_ref: 'P-TAX1' });
  const t3 = export_hledger(state_of(j.events), '2026-10-05', '2026-11-30');
  assert.equal(t3.split('\n').filter((l) => l.startsWith('~ ')).length, 0, 'план закрыт фактом');
  throws_code(() => export_hledger(st, '2026-11-30', '2026-10-04'), 'E_BAD_DATE');
  throws_code(() => export_hledger(st, '2026-10-04', '2026-11-30', { history: 'x' }), 'E_SCHEMA');
});

test('TST-44: якорь через delta — equity:opening для первой записи счёта, equity:drift дальше; assertion = A; from_anchor опускает проводки до якоря', () => {
  const j = journal_builder();
  j.add('account.opened', { account_id: 'acc_main', name: 'bank', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 });
  j.add('tx.posted', { account_id: 'acc_main', date: '2026-09-01', amount_minor: 100000, currency: 'EUR', tag: 'зарплата', note: 'sept; pay' }, { entity_id: 't1' });
  j.add('anchor.set', { anchor_id: 'a1', account_id: 'acc_main', date: '2026-09-10', amount_minor: 90000 });
  j.add('tx.posted', { account_id: 'acc_main', date: '2026-09-15', amount_minor: -5000, currency: 'EUR', tag: 'еда' }, { entity_id: 't2' });
  j.add('anchor.set', { anchor_id: 'a2', account_id: 'acc_main', date: '2026-10-04', amount_minor: 80000 });
  j.add('tx.posted', { account_id: 'acc_main', date: '2026-10-02', amount_minor: -1000, currency: 'EUR' }, { entity_id: 't3' });
  const st = state_of(j.events);
  const full = export_hledger(st, '2026-10-04', '2026-10-31', { history: 'full' });
  // 100000 (t1) → якорь 90000: delta −10000 (drift) → −5000 (t2) → 85000... → t3 (−1000, 10-02) → 84000 → якорь 80000: delta −4000
  assert.ok(full.includes('2026-09-01 * sept pay\n    assets:bank  1000.00 EUR\n    income:зарплата  -1000.00 EUR'), '«;» в описании → пробел');
  assert.ok(full.includes('2026-09-10 * якорь\n    assets:bank  -100.00 EUR = 900.00 EUR\n    equity:drift  100.00 EUR'), 'первая запись счёта была транзакцией → drift');
  assert.ok(full.includes('2026-10-04 * якорь\n    assets:bank  -40.00 EUR = 800.00 EUR\n    equity:drift  40.00 EUR'));
  assert.ok(full.includes('    expenses:еда  50.00 EUR'));
  assert.ok(full.includes('    expenses:unsorted  10.00 EUR'), 'нет метки → unsorted');
  const from = export_hledger(st, '2026-10-04', '2026-10-31');
  assert.equal(from.includes('2026-09-01'), false, 'до последнего якоря — опущено');
  assert.equal(from.includes('2026-09-10'), false, 'прежние якоря опущены');
  assert.ok(from.includes('2026-10-04 * якорь\n    assets:bank  800.00 EUR = 800.00 EUR\n    equity:opening  -800.00 EUR'), 'первая запись счёта — opening');
  assert.equal(from.includes('2026-10-02'), false, 'проводка до якоря уже внутри якоря');
  // после последнего якоря факты идут в хронологии, баланс по assertion сходится
  j.add('tx.posted', { account_id: 'acc_main', date: '2026-10-04', amount_minor: -700, currency: 'EUR', tag: 'такси' }, { entity_id: 't5' });
  j.add('tx.posted', { account_id: 'acc_main', date: '2026-10-05', amount_minor: -300, currency: 'EUR', tag: 'кофе' }, { entity_id: 't4' });
  const st2 = state_of(j.events);
  const t2 = export_hledger(st2, '2026-10-06', '2026-10-31');
  assert.ok(t2.indexOf('якорь') < t2.indexOf('кофе'), 'факт после якоря — после него в журнале');
  assert.equal(t2.includes('такси'), false, 'факт на дату якоря уже учтён в якоре (D-22) и в from_anchor опускается');
  assert.equal(mini_bal(t2, 'assets:bank', '2026-10-06', '2026-11-01'), 80000 - 300);
  // в режиме full на ту же дату tx идёт раньше якоря (в якоре тогда delta учитывает его)
  const full2 = export_hledger(st2, '2026-10-06', '2026-10-31', { history: 'full' });
  assert.ok(full2.indexOf('такси') < full2.indexOf('2026-10-04 * якорь'), 'tx раньше якоря той же даты');
  assert.ok(full2.includes('2026-10-04 * якорь\n    assets:bank  -33.00 EUR = 800.00 EUR\n    equity:drift  33.00 EUR'), 'баланс журнала 84000 − 700 = 83300 → delta = 80000 − 83300 = −3300');
});

test('TST-44: переводы — одна транзакция с двумя ногами; разные валюты — «@@»; обрезанная нога → equity:transfers; курсы P; commodity для всех валют', () => {
  const j = journal_builder();
  j.add('account.opened', { account_id: 'acc_eur', name: 'Main EUR', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 });
  j.add('account.opened', { account_id: 'acc_usd', name: 'Main USD', kind: 'bank', liquidity: 'operating', currency: 'USD', exponent: 2 });
  j.add('account.opened', { account_id: 'acc_loan', name: 'Loan', kind: 'debt', liquidity: 'debt', currency: 'EUR', exponent: 2 });
  j.add('account.opened', { account_id: 'acc_jpy', name: 'Yen', kind: 'cash', liquidity: 'operating', currency: 'JPY', exponent: 0 });
  j.add('tx.posted', { account_id: 'acc_eur', date: '2026-10-01', amount_minor: -20000, currency: 'EUR', transfer_id: 'T1', note: 'обмен' }, { entity_id: 'x1' });
  j.add('tx.posted', { account_id: 'acc_usd', date: '2026-10-01', amount_minor: 18500, currency: 'USD', transfer_id: 'T1' }, { entity_id: 'x2' });
  j.add('tx.posted', { account_id: 'acc_eur', date: '2026-10-02', amount_minor: -5000, currency: 'EUR', transfer_id: 'T2' }, { entity_id: 'x3' });
  j.add('tx.posted', { account_id: 'acc_loan', date: '2026-10-02', amount_minor: 5000, currency: 'EUR', transfer_id: 'T2' }, { entity_id: 'x4' });
  j.add('tx.posted', { account_id: 'acc_jpy', date: '2026-10-03', amount_minor: 1000, currency: 'JPY', transfer_id: 'T3' }, { entity_id: 'x5' });
  j.add('fx.set', { fx_id: 'fx1', date: '2026-10-01', base: 'EUR', quote: 'USD', num: 9250, den: 10000, source: 'manual' });
  j.add('fx.set', { fx_id: 'fx2', date: '2026-10-02', base: 'BTC', quote: 'EUR', num: 50000, den: 1, source: 'manual' });
  j.add('fx.set', { fx_id: 'fx3', date: '2026-10-03', base: 'EUR', quote: 'BTC', num: 1, den: 3, source: 'manual' });
  const text = export_hledger(state_of(j.events), '2026-10-05', '2026-10-31', { history: 'full' });
  assert.ok(text.includes('2026-10-01 * обмен\n    assets:main-eur  -200.00 EUR @@ 185.00 USD\n    assets:main-usd  185.00 USD\n'));
  assert.ok(text.includes('2026-10-02 * без описания\n    assets:main-eur  -50.00 EUR\n    liabilities:loan  50.00 EUR\n'), 'одна транзакция из двух ног, долг — liabilities');
  assert.ok(text.includes('2026-10-03 * без описания\n    assets:yen  1000 JPY\n    equity:transfers  -1000 JPY\n'), 'нога без пары, exponent 0');
  const head = text.split('\n\n')[0].split('\n');
  assert.deepEqual(head.filter((l) => l.startsWith('commodity')),
    ['commodity 1000.00000000 BTC', 'commodity 1000.00 EUR', 'commodity 1000 JPY', 'commodity 1000.00 USD'], 'по коду валюты; валюта из курса — со своим exponent');
  assert.deepEqual(head.filter((l) => l.startsWith('P ')), ['P 2026-10-01 EUR 0.925 USD', 'P 2026-10-02 BTC 50000 EUR', 'P 2026-10-03 EUR 0.3333333333 BTC']);
});

test('TST-44: экспорт безопасен для hledger — «;» и управляющие символы вычищены, описание ≤ 200 символов, нет двойных пробелов в именах счетов', () => {
  const j = journal_builder();
  j.add('account.opened', { account_id: 'a1', name: 'My  Bank: main', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 });
  j.add('account.opened', { account_id: 'a2', name: 'my bank main', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 });
  j.add('tx.posted', { account_id: 'a1', date: '2026-10-01', amount_minor: -100, currency: 'EUR', tag: 'a ; b: c', note: 'x;y\u0007\nz  ' + 'я'.repeat(300) }, { entity_id: 'x1' });
  j.add('tx.posted', { account_id: 'a2', date: '2026-10-02', amount_minor: -200, currency: 'EUR', tag: 'b' }, { entity_id: 'x2' });
  const text = export_hledger(state_of(j.events), '2026-10-05', '2026-10-31', { history: 'full' });
  const line = text.split('\n').find((l) => l.startsWith('2026-10-01'));
  assert.ok(!line.includes(';'));
  assert.ok(line.length <= '2026-10-01 * '.length + 200);
  assert.ok(line.startsWith('2026-10-01 * x y z я'));
  assert.ok(text.includes('assets:my-bank-main  -1.00 EUR'), 'имя счёта: slug');
  assert.ok(text.includes('assets:my-bank-main-a2'), 'коллизия имён разрешается идентификатором');
  assert.ok(text.includes('expenses:a-b-c  1.00 EUR'));
});

test('TST-44: opts.rules = native — простое ежемесячное правило одной строкой «~ monthly from … to …», вхождения не дублируются', () => {
  const j = journal_builder();
  j.add('account.opened', { account_id: 'acc_main', name: 'bank', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 });
  j.add('anchor.set', { anchor_id: 'a', account_id: 'acc_main', date: '2026-10-04', amount_minor: 100000 });
  const rule = { rule_id: 'R-SUB', version: 1, account_id: 'acc_main', name: 'Подписка', kind: 'expense', amount: { exp_minor: -999 }, currency: 'EUR', freq: 'M', interval: 1, by_monthday: [5], start_date: '2026-01-05', month_end: 'clamp', weekend: 'keep', calendar_id: null, exdates: [], tag: 'подписка' };
  j.add('rule.set', rule);
  j.add('rule.set', { ...rule, rule_id: 'R-RENT', by_monthday: [25], weekend: 'next', name: 'Аренда' });
  const planned = [
    ...expand_all([rule], { from: D('2026-10-04'), to: D('2026-12-31') }, {}, []),
    ...expand_all([{ ...rule, rule_id: 'R-RENT', by_monthday: [25], weekend: 'next' }], { from: D('2026-10-04'), to: D('2026-12-31') }, {}, []),
  ].map((o) => ({ layer: 'planned', cash_event_id: o.occ_key, rule_id: o.rule_id, account_id: 'acc_main', currency: 'EUR', date: o.date, amount_minor: o.amount_minor, tag: o.tag, status: 'expected' }));
  const st = state_of(j.events);
  const text = export_hledger(st, '2026-10-04', '2026-12-31', { planned, rules: 'native' });
  const periodic = text.split('\n').filter((l) => l.startsWith('~ '));
  assert.equal(periodic[0], '~ monthly from 2026-10-05 to 2027-01-01  Подписка');
  assert.equal(periodic.filter((l) => l.includes('monthly')).length, 1);
  assert.equal(periodic.filter((l) => /^~ \d{4}/.test(l)).length, 3, 'аренда (weekend = next) — не нативна: 3 материализованных вхождения');
  throws_code(() => export_hledger(st, '2026-10-04', '2026-12-31', { rules: 'x' }), 'E_SCHEMA');
});

// Оракул hledger: запускается только при наличии бинаря (child_process — в тесте, не в engine/).
const HLEDGER = (() => {
  try {
    const r = spawnSync('hledger', ['--version'], { encoding: 'utf8', timeout: 5000 });
    return r.status === 0 ? String(r.stdout).trim() : null;
  } catch { return null; }
})();

test('TST-44 оракул: hledger bal assets:bank --forecast=2026-10-04..2026-11-30 -e 2026-11-01 = 2055.00 EUR (= close движка 205500) и -e 2026-12-01 = 3400.00 EUR',
  { skip: HLEDGER === null ? 'бинарь hledger не найден в PATH: оракул не запускался (в проекте на hledger не проверялось — C-042); независимая сверка выполнена мини-вычислителем выше' : false },
  () => {
    const st = state_of(g001_journal().events);
    const text = export_hledger(st, '2026-10-04', '2026-11-30', { planned: g001_planned() });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-hl-'));
    const file = path.join(dir, 'g001.journal');
    fs.writeFileSync(file, text, 'utf8');
    for (const [end, expect] of [['2026-11-01', '2055.00'], ['2026-12-01', '3400.00']]) {
      const r = spawnSync('hledger', ['-f', file, 'bal', 'assets:bank', '--forecast=2026-10-04..2026-11-30', '-e', end], { encoding: 'utf8', timeout: 20000 });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, new RegExp(expect.replace('.', '\\.') + ' EUR'), `-e ${end}: ${r.stdout}`);
    }
  });

// ── hledger: импорт подмножества (v1.1) ───────────────────────────────────────

test('import_hledger (v1.1): round-trip экспорта — счета, якорь, факты, разовые планы; баланс счёта сохраняется', () => {
  const j = journal_builder();
  j.add('account.opened', { account_id: 'acc_main', name: 'bank', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 });
  j.add('account.opened', { account_id: 'acc_loan', name: 'loan', kind: 'debt', liquidity: 'debt', currency: 'EUR', exponent: 2 });
  j.add('anchor.set', { anchor_id: 'a1', account_id: 'acc_main', date: '2026-10-01', amount_minor: 400000 });
  j.add('tx.posted', { account_id: 'acc_main', date: '2026-10-02', amount_minor: -4730, currency: 'EUR', tag: 'продукты', note: 'Mercadona' }, { entity_id: 'f1' });
  j.add('tx.posted', { account_id: 'acc_main', date: '2026-10-03', amount_minor: 123456, currency: 'EUR', note: 'Transferencia' }, { entity_id: 'f2' });
  j.add('tx.posted', { account_id: 'acc_main', date: '2026-10-03', amount_minor: -5000, currency: 'EUR', transfer_id: 'T' }, { entity_id: 'f3' });
  j.add('tx.posted', { account_id: 'acc_loan', date: '2026-10-03', amount_minor: 5000, currency: 'EUR', transfer_id: 'T' }, { entity_id: 'f4' });
  j.add('fx.set', { fx_id: 'fx1', date: '2026-10-01', base: 'EUR', quote: 'USD', num: 9250, den: 10000, source: 'manual' });
  const st = state_of(j.events);
  const planned = [
    { layer: 'planned', cash_event_id: 'P-TAX1', account_id: 'acc_main', currency: 'EUR', date: D('2026-10-23'), amount_minor: -50000, tag: 'налог', status: 'expected' },
    { layer: 'planned', cash_event_id: 'S@11-05', account_id: 'acc_main', currency: 'EUR', date: D('2026-11-05'), amount_minor: 279000, tag: 'доход', name: 'Почасовой доход', status: 'expected' },
  ];
  const text = export_hledger(st, '2026-10-05', '2026-11-30', { planned, history: 'full' });
  const back = import_hledger(text);
  assert.deepEqual(Object.values(back.accounts).map((a) => [a.account_id, a.kind, a.liquidity, a.currency, a.exponent]).sort(), [
    ['acc_bank', 'bank', 'operating', 'EUR', 2], ['acc_loan', 'debt', 'debt', 'EUR', 2],
  ]);
  assert.deepEqual(Object.values(back.anchors).map((a) => [a.account_id, a.date, a.amount_minor]), [['acc_bank', '2026-10-01', 400000]]);
  const facts = Object.values(back.facts).sort((p, q) => p.date.localeCompare(q.date) || p.amount_minor - q.amount_minor);
  assert.deepEqual(facts.map((f) => [f.account_id, f.date, f.amount_minor, f.tag ?? null, f.note]), [
    ['acc_bank', '2026-10-02', -4730, 'продукты', 'Mercadona'],
    ['acc_bank', '2026-10-03', -5000, null, 'без описания'],
    ['acc_loan', '2026-10-03', 5000, null, 'без описания'],
    ['acc_bank', '2026-10-03', 123456, null, 'Transferencia'],
  ]);
  const tr = facts.filter((f) => f.transfer_id !== undefined);
  assert.equal(tr.length, 2);
  assert.equal(tr[0].transfer_id, tr[1].transfer_id, 'две ноги перевода связаны');
  assert.deepEqual(Object.values(back.plans).map((p) => [p.date, p.amount_minor, p.tag, p.account_id]).sort(), [
    ['2026-10-23', -50000, 'налог', 'acc_bank'], ['2026-11-05', 279000, 'доход', 'acc_bank'],
  ]);
  assert.deepEqual(Object.values(back.fx).map((r) => [r.date, r.base, r.quote, r.num, r.den]), [['2026-10-01', 'EUR', 'USD', 925, 1000]]);
  // баланс счёта: якорь + факты после него = то же, что в исходном состоянии
  const bal = (s, id) => Object.values(s.anchors).filter((a) => a.account_id === id).reduce((x, a) => a.amount_minor, 0)
    + Object.values(s.facts).filter((f) => f.account_id === id && f.date > '2026-10-01').reduce((x, f) => x + f.amount_minor, 0);
  assert.equal(bal(back, 'acc_bank'), bal(st, 'acc_main'));
  // импорт детерминирован
  assert.equal(state_hash(import_hledger(text)), state_hash(back));
});

test('import_hledger (v1.1): периодические правила → Rule, утверждение без equity — и факт, и якорь, пропущенная сумма, ccy-префикс, ошибки', () => {
  const text = [
    '; comment',
    'commodity 1000.00 EUR',
    'P 2026-10-01 EUR 1.08 USD',
    '',
    '~ monthly from 2026-10-05 to 2027-01-01  Подписка',
    '    assets:bank  -9.99 EUR',
    '    expenses:подписка',
    '~ weekly from 2026-10-10  Продукты ; шум',
    '    assets:bank  -100.00 EUR',
    '    expenses:продукты',
    '~ every 2 months from 2026-10-31  Налог',
    '    assets:bank  -500.00 EUR',
    '    expenses:налог',
    '',
    '2026-10-04 * Зарплата',
    '    assets:bank  EUR 1,500.00 = 2,000.00 EUR',
    '    income:salary',
    '',
    '2026-10-05 ! Без метки',
    '    assets:bank  -3.50 EUR',
    '    equity:misc',
    '',
    '2026-10-06 Не активы',
    '    expenses:x  1.00 EUR',
    '    income:y  -1.00 EUR',
  ].join('\n');
  const s = import_hledger(text);
  const rules = Object.values(s.rules).sort((a, b) => a.rule_id.localeCompare(b.rule_id));
  assert.equal(rules.length, 3);
  assert.deepEqual([rules[0].freq, rules[0].interval, rules[0].by_monthday, rules[0].start_date, rules[0].until_date, rules[0].amount.exp_minor, rules[0].kind, rules[0].tag, rules[0].name],
    ['M', 1, [5], '2026-10-05', '2026-12-31', -999, 'expense', 'подписка', 'Подписка'], '`to` в hledger исключающий');
  assert.deepEqual([rules[1].freq, rules[1].by_weekday, rules[1].until_date, rules[1].name], ['W', [6], undefined, 'Продукты'], '2026-10-10 — суббота');
  assert.deepEqual([rules[2].freq, rules[2].interval, rules[2].by_monthday], ['M', 2, [31]]);
  assert.equal(Object.keys(s.accounts).length, 1);
  // утверждение на asset с income-ногой: и факт (+1500.00), и якорь (= 2000.00)
  assert.deepEqual(Object.values(s.anchors).map((a) => [a.date, a.amount_minor]), [['2026-10-04', 200000]]);
  const facts = Object.values(s.facts).sort((a, b) => a.date.localeCompare(b.date));
  assert.deepEqual(facts.map((f) => [f.date, f.amount_minor, f.tag ?? null]), [['2026-10-04', 150000, 'salary'], ['2026-10-05', -350, null]]);
  assert.equal(facts.length, 2, 'проводка без активных счетов — не денежный поток Runway');
  assert.deepEqual(Object.values(s.fx)[0].num / Object.values(s.fx)[0].den, 1.08);

  // ошибки: неподдерживаемое → E_SCHEMA, а не молчаливая порча
  throws_code(() => import_hledger('2026-10-04 x\n    assets:a  1 EUR @ 2 USD\n    income:b'), 'E_SCHEMA');
  throws_code(() => import_hledger('~ monthly  x\n    assets:a  1.00 EUR\n    income:b'), 'E_SCHEMA');
  throws_code(() => import_hledger('~ fortnightly from 2026-01-01  x\n    assets:a  1.00 EUR\n    income:b'), 'E_SCHEMA');
  throws_code(() => import_hledger('2026-13-01 x\n    assets:a  1.00 EUR\n    income:b'), 'E_SCHEMA');
  throws_code(() => import_hledger('2026-10-04 x\n    assets:a  1.00 EUR\n    assets:b  1.00 EUR\n    assets:c  -2.00 EUR'), 'E_SCHEMA');
  throws_code(() => import_hledger('2026-10-04 x\n    assets:a  1.005 EUR\n    income:b'), 'E_NOT_INTEGER', 'знаков больше exponent: деньги не округляются молча');
  throws_code(() => import_hledger('2026-10-04 x\n    assets:a  1.00\n    income:b'), 'E_SCHEMA', 'без валюты');
  assert.deepEqual(Object.keys(import_hledger('')).length > 0, true);
});

test('TST-60 (часть): io не использует node:/Date — сигнатура экспортов соответствует канону', async () => {
  const m = await import('../engine/io.mjs');
  for (const name of ['parse_csv', 'parse_with_profile', 'dry_run', 'import_commit', 'import_rollback', 'validate_profile', 'parse_date_fmt',
    'parse_amount_cell', 'rule_matches', 'export_json', 'import_json', 'export_csv', 'export_hledger', 'import_hledger', 'csv_safe_cell']) {
    assert.equal(typeof m[name], 'function', name);
  }
  assert.equal(m.parse_csv.length, 2);
  assert.equal(m.parse_with_profile.length, 3);
  assert.equal(m.dry_run.length, 2, 'rejects, existing_events, params — необязательные (по умолчанию)');
  assert.equal(m.import_commit.length, 4);
  assert.equal(m.export_hledger.length, 3);
});
