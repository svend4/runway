// hours_io.test.mjs — FP-29, ALG-07 A07.7: импорт отработанных часов из CSV (engine/hours_io.mjs).
// Профиль «часы» — данные (data/profiles/hours-csv-1.json); разбор поверх parse_csv; сухой прогон «распознано · отклонено · дубликатов» (сумма трёх = строк файла);
// итог периода заменяет записанное «отработано», повторный импорт даёт 0 новых; правки — set_stream_hours; откат возвращает прежнее и не трогает исправленное потом.
// Деньги в модуле не участвуют (время — целые минуты). Расчёт по введённым данным и правилам, не консультация.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/hours_io.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as H from '../engine/hours_io.mjs';
import { period_bounds, format_date, to_epoch_day } from '../engine/index.mjs';
import { apply_edit, register_edit, list_edit_types } from '../demo/ws_edit.mjs';
import { edit_set_stream_hours } from '../demo/form_hours.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const read_json = (p) => JSON.parse(fs.readFileSync(path.join(PROTO, p), 'utf8'));
if (!list_edit_types().includes('set_stream_hours')) register_edit('set_stream_hours', edit_set_stream_hours);

function deep_freeze(x) {
  if (x === null || typeof x !== 'object' || Object.isFrozen(x)) return x;
  for (const k of Object.keys(x)) deep_freeze(x[k]);
  return Object.freeze(x);
}

const G = deep_freeze(read_json('data/g001.json'));
const MONTH = G.streams[0]; // S-HOURLY: месяц, лаг 5 дней, «отработано» за сентябрь = 5760 минут (96 ч)
const { hours_by_period: _hbp, ...NO_HOURS } = MONTH; // поток без записанных периодов (вид правки убирает пустое поле, поэтому в исходных данных его тоже нет)
const WEEK = { ...NO_HOURS, stream_id: 'S-WEEK', name: 'Недельный', period: 'week', cutoff: { kind: 'weekday', weekday: 0 } };
const BIWEEK = { ...NO_HOURS, stream_id: 'S-BI', name: 'Двухнедельный', period: 'biweek', cutoff: { kind: 'weekday', weekday: 0, anchor: '2026-09-06' } };
const STREAMS = deep_freeze([MONTH, WEEK, BIWEEK]);
const BASE = deep_freeze({ ...G, streams: STREAMS }); // рабочая область со всеми тремя потоками
const AS_OF = '2026-10-04'; // воскресенье; идёт октябрь, неделя 28 сентября – 4 октября заканчивается сегодня
const CTX = { streams: STREAMS, stream_id: 'S-HOURLY', as_of: AS_OF };
const P = H.HOURS_PROFILE;

// ── профиль ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test('A07.7 профиль «часы»: файл data/profiles/hours-csv-1.json = HOURS_PROFILE движка; схема принимает его; чужие поля, исполняемые значения и неверные единицы отвергаются', () => {
  assert.deepEqual(read_json('data/profiles/hours-csv-1.json'), H.HOURS_PROFILE);
  assert.deepEqual(H.validate_hours_profile(P), { ok: true, errors: [] });
  assert.equal(H.is_hours_profile(P), true);
  assert.equal(H.is_hours_profile({ ...P, kind: 'facts' }), false);
  assert.equal(H.is_hours_profile(null), false);
  const bad = (patch) => H.validate_hours_profile({ ...P, ...patch });
  for (const [patch, field] of [
    [{ regex: '.*' }, 'regex'], [{ script: 'x' }, 'script'], [{ kind: 'x' }, 'kind'], [{ v: 2 }, 'v'], [{ delimiter: '|' }, 'delimiter'], [{ skip: -1 }, 'skip'],
    [{ date: { col: 'd', fmt: 'DD.MM' } }, 'date.fmt'], [{ date: { col: '', fmt: 'YYYY-MM-DD' } }, 'date.col'], [{ hours: { col: 'h', unit: 'days' } }, 'hours.unit'],
    [{ hours: { col: 'h', unit: 'hours', decimal: ';' } }, 'hours.decimal'], [{ hours: { col: 'h', unit: 'hours', transform: 'x' } }, 'hours.transform'], [{ stream: { col: 3, x: 1 } }, 'stream.x'],
    [{ hours: null }, 'hours'], [{ date: 5 }, 'date'],
  ]) {
    const r = bad(patch);
    assert.equal(r.ok, false, field);
    assert.ok(r.errors.some((e) => e.field === field), field + ': ' + JSON.stringify(r.errors));
  }
  assert.deepEqual(H.validate_hours_profile(null).errors, [{ field: '', reason: 'not_object' }]);
  assert.equal(H.validate_hours_profile({ ...P, stream: undefined }).ok, true, 'колонка потока необязательна');
});

// ── ячейка часов ────────────────────────────────────────────────────────────────────────────────────────────────────

test('A07.7 parse_hours_cell: десятичные часы, целые минуты, «ч:мм»; дробь округляется до минуты с пометкой; пусто, знак и мусор — отказ', () => {
  const ok = (cell, unit, dec) => H.parse_hours_cell(cell, unit, dec);
  assert.deepEqual(ok('8', 'hours'), { ok: true, minutes: 480, rounded: false });
  assert.deepEqual(ok(' 7.5 ', 'hours'), { ok: true, minutes: 450, rounded: false });
  assert.deepEqual(ok('7,25', 'hours', ','), { ok: true, minutes: 435, rounded: false });
  assert.deepEqual(ok('0.0167', 'hours'), { ok: true, minutes: 1, rounded: true }, '0,0167 ч = 1,002 мин → 1');
  assert.deepEqual(ok('6.33', 'hours'), { ok: true, minutes: 380, rounded: true }, '6,33 ч = 379,8 мин → 380, помечено');
  assert.deepEqual(ok('0.5', 'hours'), { ok: true, minutes: 30, rounded: false });
  assert.deepEqual(ok('0.0083', 'hours'), { ok: true, minutes: 0, rounded: true }, '0,498 мин → 0 (half_even), помечено');
  assert.deepEqual(ok('0.0084', 'hours'), { ok: true, minutes: 1, rounded: true }, '0,504 мин → 1');
  assert.deepEqual(ok('450', 'minutes'), { ok: true, minutes: 450, rounded: false });
  assert.deepEqual(ok('7:30', 'hm'), { ok: true, minutes: 450, rounded: false });
  assert.deepEqual(ok('93:05', 'hm'), { ok: true, minutes: 5585, rounded: false });
  assert.deepEqual(ok('', 'hours'), { ok: false, reason: 'empty' });
  assert.deepEqual(ok('   ', 'minutes'), { ok: false, reason: 'empty' });
  assert.deepEqual(ok(undefined, 'hm'), { ok: false, reason: 'empty' });
  for (const [cell, unit, dec] of [
    ['-1', 'hours'], ['+2', 'hours'], ['7,5', 'hours', '.'], ['7.5', 'hours', ','], ['1e3', 'hours'], ['7.', 'hours'], ['.5', 'hours'], ['7.12345', 'hours'], ['abc', 'hours'],
    ['7.5', 'minutes'], ['-5', 'minutes'], ['7:60', 'hm'], ['7:5', 'hm'], ['7', 'hm'], ['7:30:00', 'hm'], ['123456', 'hours'], ['8', 'weeks'],
  ]) assert.deepEqual(ok(cell, unit, dec), { ok: false, reason: 'bad' }, `${cell} ${unit}`);
});

// ── разбор файла ────────────────────────────────────────────────────────────────────────────────────────────────────

test('A07.7 import_hours_csv: строки файла → период потока и минуты; поток — из колонки (идентификатор или название без регистра) либо выбранный; причины отказа названы', () => {
  const text = [
    'date,hours,stream',
    '2026-09-03,8,S-HOURLY', // 2
    '2026-09-04,7.5,', // 3: пусто → выбранный поток
    '2026-09-05,6,недельный', // 4: по названию, без регистра
    '2026-09-05,3,Нет такого', // 5
    '2026-09-31,3,S-HOURLY', // 6: нет такой даты
    '2026-09-06,,S-HOURLY', // 7
    '2026-09-06,abc,S-HOURLY', // 8
    '2026-11-02,5,S-HOURLY', // 9: период ещё не начался
    '2026-09-06,5', // 10: короче заголовка
    '',
  ].join('\n');
  const r = H.import_hours_csv(text, P, CTX);
  assert.equal(r.rows_total, 9);
  assert.deepEqual(r.header, ['date', 'hours', 'stream']);
  assert.deepEqual(r.rows.map((x) => [x.row, x.stream_id, x.period_start, x.minutes]), [
    [2, 'S-HOURLY', '2026-09-01', 480],
    [3, 'S-HOURLY', '2026-09-01', 450],
    [4, 'S-WEEK', '2026-08-31', 360], // неделя с понедельника 31 августа по воскресенье 6 сентября
  ]);
  assert.deepEqual(r.rejects.map((x) => [x.row, x.reason]), [[5, 'unknown_stream'], [6, 'bad_date'], [7, 'empty_hours'], [8, 'bad_hours'], [9, 'future_period'], [10, 'short_row']]);
  assert.equal(r.rows.length + r.rejects.length, r.rows_total);
});

test('A07.7 поток: без колонки потока в файле все строки идут в выбранный поток; потока нет ни в файле, ни в выборе — unknown_stream; два потока с одним названием — не угадывается', () => {
  const no_col = 'date,hours\n2026-09-03,8\n2026-09-04,4\n';
  const a = H.import_hours_csv(no_col, P, CTX);
  assert.deepEqual(a.rows.map((x) => x.stream_id), ['S-HOURLY', 'S-HOURLY']);
  const b = H.import_hours_csv(no_col, P, { ...CTX, stream_id: null });
  assert.deepEqual(b.rejects.map((x) => x.reason), ['unknown_stream', 'unknown_stream']);
  const dup = deep_freeze([MONTH, { ...WEEK, name: 'почасовая работа' }, { ...BIWEEK, name: 'Почасовая работа' }]);
  const text = 'date,hours,stream\n2026-09-03,8,почасовая РАБОТА\n2026-09-03,8,S-HOURLY\n2026-09-03,8,Почасовая работа\n';
  const c = H.import_hours_csv(text, P, { streams: dup, stream_id: null, as_of: AS_OF });
  assert.deepEqual(c.rows.map((x) => x.stream_id), ['S-HOURLY'], 'идентификатор точнее названия; название «Почасовая работа» у трёх потоков (без регистра) неоднозначно');
  assert.deepEqual(c.rejects.map((x) => x.reason), ['unknown_stream', 'unknown_stream']);
  assert.equal(H.find_stream(STREAMS, '  ', 'S-WEEK').stream_id, 'S-WEEK');
  assert.equal(H.find_stream(STREAMS, '', 'нет'), null);
  assert.equal(H.find_stream(null, 'x', null), null);
  assert.equal(H.find_stream([null, 5, MONTH], 'S-HOURLY', null).stream_id, 'S-HOURLY', 'мусор в списке потоков не мешает');
});

test('A07.7 период строки по настройке потока: месяц, неделя (граница — воскресенье) и две недели (по якорю); совпадает с period_bounds движка', () => {
  const days = ['2026-08-31', '2026-09-01', '2026-09-06', '2026-09-07', '2026-09-13', '2026-09-14', '2026-09-20', '2026-09-27', '2026-10-01', '2026-10-04'];
  for (const stream of STREAMS) {
    const text = 'date,hours\n' + days.map((d) => `${d},1`).join('\n') + '\n';
    const r = H.import_hours_csv(text, P, { streams: STREAMS, stream_id: stream.stream_id, as_of: AS_OF });
    assert.equal(r.rows.length, days.length, stream.stream_id);
    r.rows.forEach((x, i) => assert.equal(x.period_start, format_date(period_bounds(stream, to_epoch_day(days[i])).start), `${stream.stream_id} ${days[i]}`));
  }
  const bi = H.import_hours_csv('date,hours\n2026-09-06,1\n2026-09-07,1\n2026-09-20,1\n', P, { streams: STREAMS, stream_id: 'S-BI', as_of: AS_OF });
  assert.deepEqual(bi.rows.map((x) => x.period_start), ['2026-08-24', '2026-09-07', '2026-09-07'], 'две недели: 24.08–06.09 и 07.09–20.09');
});

test('A07.7 варианты профиля: «;» и «ДД.ММ.ГГГГ», десятичная запятая; единицы minutes и hm; колонки по номеру; BOM и CRLF', () => {
  const semi = { ...P, delimiter: ';', date: { col: 'Дата', fmt: 'DD.MM.YYYY' }, hours: { col: 'Часы', unit: 'hours', decimal: ',' }, stream: { col: 'Поток' } };
  const a = H.import_hours_csv('﻿Дата;Часы;Поток\r\n03.09.2026;7,5;S-HOURLY\r\n04.09.2026;0,25;S-HOURLY\r\n', semi, CTX);
  assert.deepEqual(a.rows.map((x) => x.minutes), [450, 15]);
  const mins = { ...P, hours: { col: 'minutes', unit: 'minutes' }, stream: undefined };
  const b = H.import_hours_csv('date,minutes\n2026-09-03,450\n2026-09-04,45\n', mins, CTX);
  assert.deepEqual(b.rows.map((x) => x.minutes), [450, 45]);
  const hm = { ...P, hours: { col: 1, unit: 'hm' }, stream: { col: 2 } };
  const c = H.import_hours_csv('d,t,s\n2026-09-03,7:30,S-HOURLY\n2026-09-04,0:45,S-HOURLY\n', { ...hm, date: { col: 0, fmt: 'YYYY-MM-DD' } }, CTX);
  assert.deepEqual(c.rows.map((x) => x.minutes), [450, 45]);
  const skip = H.import_hours_csv('Отчёт за сентябрь\ndate,hours\n2026-09-03,8\n', { ...P, skip: 1, stream: undefined }, CTX);
  assert.equal(skip.rows.length, 1);
  assert.equal(skip.rows[0].row, 3, 'номер строки — запись файла с 1, преамбула учтена');
});

test('A07.7 отказы всего файла: неизвестная колонка, пустой файл, незакрытая кавычка, плохой профиль, файл больше 5 МБ — E_SCHEMA с причиной, текст файла в контексте не светится', () => {
  const code_reason = (fn) => { try { fn(); } catch (e) { return [e.code, e.ctx.reason]; } return null; };
  assert.deepEqual(code_reason(() => H.import_hours_csv('date,minutes\n2026-09-03,1\n', P, CTX)), ['E_SCHEMA', 'unknown_column']);
  assert.deepEqual(code_reason(() => H.import_hours_csv('', P, CTX)), ['E_SCHEMA', 'no_header_row']);
  assert.deepEqual(code_reason(() => H.import_hours_csv('date,hours\n"2026-09-03,1\n', P, CTX)), ['E_SCHEMA', 'unterminated_quote']);
  assert.deepEqual(code_reason(() => H.import_hours_csv('date,hours\n', { ...P, exec: 'x' }, CTX)), ['E_SCHEMA', 'bad_profile']);
  assert.deepEqual(code_reason(() => H.import_hours_csv(5, P, CTX)), ['E_SCHEMA', 'text_not_string']);
  assert.deepEqual(code_reason(() => H.import_hours_csv('date,hours\n', P, { as_of: AS_OF })), ['E_SCHEMA', 'ctx_required']);
  assert.deepEqual(code_reason(() => H.import_hours_csv('x'.repeat(5 * 1024 * 1024 + 1), P, CTX)), ['E_SCHEMA', 'file_too_large']);
  assert.deepEqual(code_reason(() => H.import_hours_csv('date,hours\n', { ...P, hours: { col: 5, unit: 'hours' } }, CTX)), ['E_SCHEMA', 'column_index_out_of_header']);
});

// ── итоги периодов и сухой прогон ──────────────────────────────────────────────────────────────────────────────────────

test('A07.7 aggregate_hours: часы потока за период складываются; итог больше 31 суток отвергает все строки периода (over_period); порядок — по потоку и началу периода', () => {
  const rows = [
    { row: 2, stream_id: 'B', period_start: '2026-09-01', minutes: 60, rounded: false },
    { row: 3, stream_id: 'A', period_start: '2026-10-01', minutes: 120, rounded: true },
    { row: 4, stream_id: 'A', period_start: '2026-09-01', minutes: 30, rounded: false },
    { row: 5, stream_id: 'A', period_start: '2026-09-01', minutes: 40, rounded: true },
    { row: 6, stream_id: 'C', period_start: '2026-09-01', minutes: 44000, rounded: false },
    { row: 7, stream_id: 'C', period_start: '2026-09-01', minutes: 1000, rounded: false },
  ];
  const a = H.aggregate_hours(rows);
  assert.deepEqual(a.groups.map((g) => [g.stream_id, g.period_start, g.minutes, g.rows, g.rounded]), [
    ['A', '2026-09-01', 70, [4, 5], 1], ['A', '2026-10-01', 120, [3], 1], ['B', '2026-09-01', 60, [2], 0],
  ]);
  assert.deepEqual(a.rejects, [{ row: 6, reason: 'over_period' }, { row: 7, reason: 'over_period' }]);
  assert.equal(H.MAX_PERIOD_MINUTES, 44640);
  assert.equal(H.aggregate_hours([{ row: 2, stream_id: 'A', period_start: '2026-09-01', minutes: 44640, rounded: false }]).groups.length, 1, 'ровно 31 сутки допустимо');
});

const FILE_A = 'date,hours\n2026-09-03,8\n2026-09-04,7.5\n2026-09-05,100\n2026-10-02,6.33\n2026-11-02,5\n2026-09-31,3\n2026-09-06,\n';

test('A07.7 dry_run_hours: «распознано · отклонено · дубликатов» сходится со строками файла; итог периода заменяет записанное; число округлённых строк названо; рабочая область не меняется', () => {
  const r = H.dry_run_hours(FILE_A, P, CTX); // потоки заморожены: любая мутация упадёт
  assert.equal(r.rows_total, 7);
  assert.deepEqual([r.recognized, r.rejected, r.duplicates], [4, 3, 0]);
  assert.equal(r.sum_ok, true);
  assert.deepEqual(r.by_reason, { future_period: 1, bad_date: 1, empty_hours: 1 });
  assert.deepEqual(r.changes, [
    { stream_id: 'S-HOURLY', period_start: '2026-09-01', before: 5760, after: 6930, rows: 3 },
    { stream_id: 'S-HOURLY', period_start: '2026-10-01', before: null, after: 380, rows: 1 },
  ]);
  assert.equal(r.replaced, 1, 'сентябрь заменяет уже записанные 5760 минут');
  assert.equal(r.rounded_rows, 1);
  assert.equal(r.unchanged, 0);
  assert.equal(r.from, '2026-09-01');
  assert.equal(r.to, '2026-10-01');
  assert.deepEqual(H.hours_edits(r.changes), [
    { type: 'set_stream_hours', stream_id: 'S-HOURLY', period_start: '2026-09-01', actual_minutes: 6930 },
    { type: 'set_stream_hours', stream_id: 'S-HOURLY', period_start: '2026-10-01', actual_minutes: 380 },
  ]);
  assert.equal(JSON.stringify(H.dry_run_hours(FILE_A, P, CTX)), JSON.stringify(r), 'детерминирован');
});

test('A07.7 повторный импорт того же файла: записанные периоды — дубликаты (0 новых), отклонённые строки остаются отклонёнными', () => {
  const first = H.dry_run_hours(FILE_A, P, CTX);
  let cur = G;
  for (const e of H.hours_edits(first.changes)) { const r = apply_edit(cur, e, {}); assert.ok(r.ok, JSON.stringify(r.error)); cur = r.ws; }
  const again = H.dry_run_hours(FILE_A, P, { ...CTX, streams: cur.streams });
  assert.deepEqual([again.recognized, again.rejected, again.duplicates], [0, 3, 4]);
  assert.equal(again.sum_ok, true);
  assert.equal(again.changes.length, 0);
  assert.equal(again.unchanged, 2);
});

test('A07.7 тот же итог периода другим набором строк — дубликат; иной итог — изменение с прежним значением', () => {
  const cur = apply_edit(G, { type: 'set_stream_hours', stream_id: 'S-HOURLY', period_start: '2026-09-01', actual_minutes: 6930 }, {}).ws;
  const same = H.dry_run_hours('date,hours\n2026-09-10,50\n2026-09-11,65.5\n', P, { ...CTX, streams: cur.streams });
  assert.deepEqual([same.recognized, same.duplicates], [0, 2]);
  assert.equal(same.changes.length, 0);
  const diff = H.dry_run_hours('date,hours\n2026-09-10,50\n', P, { ...CTX, streams: cur.streams });
  assert.deepEqual(diff.changes, [{ stream_id: 'S-HOURLY', period_start: '2026-09-01', before: 6930, after: 3000, rows: 1 }]);
  assert.equal(diff.replaced, 1);
});

test('A07.7 set_stream_hours принимает правки импорта; период — настоящее начало периода потока; откат возвращает прежние значения, а исправленное потом не трогает', () => {
  const r = H.dry_run_hours(FILE_A, P, CTX);
  let cur = G;
  for (const e of H.hours_edits(r.changes)) { const x = apply_edit(cur, e, {}); assert.ok(x.ok, JSON.stringify(x.error)); cur = x.ws; }
  assert.equal(cur.streams[0].hours_by_period['2026-09-01'].actual_minutes, 6930);
  assert.equal(cur.streams[0].hours_by_period['2026-09-01'].exp_minutes, 5760, 'остальные поля периода сохранены');
  assert.equal(cur.streams[0].hours_by_period['2026-10-01'].actual_minutes, 380);

  // откат: оба периода на месте
  const rb = H.rollback_edits(r.changes, cur.streams);
  assert.equal(rb.kept, 0);
  assert.equal(rb.gone, 0);
  assert.deepEqual(rb.edits.map((e) => [e.period_start, e.actual_minutes]), [['2026-09-01', 5760], ['2026-10-01', null]]);
  let back = cur;
  for (const e of rb.edits) { const x = apply_edit(back, e, {}); assert.ok(x.ok, JSON.stringify(x.error)); back = x.ws; }
  assert.deepEqual(back.streams, G.streams, 'откат вернул потоки к исходным (октябрь снят целиком)');

  // октябрь исправлен вручную после импорта: не трогается
  const hand = apply_edit(cur, { type: 'set_stream_hours', stream_id: 'S-HOURLY', period_start: '2026-10-01', actual_minutes: 400 }, {}).ws;
  const rb2 = H.rollback_edits(r.changes, hand.streams);
  assert.deepEqual([rb2.kept, rb2.gone, rb2.edits.length], [1, 0, 1]);
  // поток исчез
  const rb3 = H.rollback_edits(r.changes, []);
  assert.deepEqual([rb3.kept, rb3.gone, rb3.edits.length], [0, 2, 0]);
  assert.deepEqual(H.rollback_edits([], null), { edits: [], kept: 0, gone: 0 });

  // начало периода — не начало: правка отвергается, мусора в данные нет
  const bad = apply_edit(G, { type: 'set_stream_hours', stream_id: 'S-HOURLY', period_start: '2026-09-02', actual_minutes: 60 }, {});
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'E_SCHEMA');
});

test('A07.7 recorded_minutes: только целое «отработано» периода; нет потока, нет периода, мусор — null', () => {
  assert.equal(H.recorded_minutes(MONTH, '2026-09-01'), 5760);
  assert.equal(H.recorded_minutes(MONTH, '2026-08-01'), null);
  assert.equal(H.recorded_minutes(undefined, '2026-09-01'), null);
  assert.equal(H.recorded_minutes({ hours_by_period: { '2026-09-01': { actual_minutes: '5' } } }, '2026-09-01'), null);
  assert.equal(H.recorded_minutes({ hours_by_period: { '2026-09-01': { exp_minutes: 5 } } }, '2026-09-01'), null);
});

// ── свойства на случайных файлах ───────────────────────────────────────────────────────────────────────────────────────

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

test('A07.7 свойства (300 случайных файлов): распознано + отклонено + дубликатов = строк; порядок строк не влияет на изменения; применение правок и повторный разбор дают 0 новых; откат возвращает потоки', () => {
  const rnd = lcg(29);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const days = ['2026-08-30', '2026-09-01', '2026-09-06', '2026-09-07', '2026-09-15', '2026-09-30', '2026-10-01', '2026-10-04', '2026-10-05', '2026-12-01', '2026-02-30'];
  const hours = ['0', '1', '7.5', '8', '12.25', '6.33', '', 'x', '-3', '100', '0.5'];
  const streams_cells = ['', 'S-HOURLY', 'S-WEEK', 'S-BI', 'нет', 'недельный'];
  for (let iter = 0; iter < 300; iter++) {
    const n = Math.floor(rnd() * 14);
    const lines = [];
    for (let i = 0; i < n; i++) lines.push([pick(days), pick(hours), pick(streams_cells)].join(','));
    const text = 'date,hours,stream\n' + lines.join('\n') + (n > 0 ? '\n' : '');
    const r = H.dry_run_hours(text, P, CTX);
    assert.equal(r.rows_total, n, `iter ${iter}`);
    assert.equal(r.recognized + r.rejected + r.duplicates, n, `iter ${iter}: сумма`);
    assert.equal(r.sum_ok, true);
    const shuffled = [...lines].sort(() => rnd() - 0.5);
    const r2 = H.dry_run_hours('date,hours,stream\n' + shuffled.join('\n') + (n > 0 ? '\n' : ''), P, CTX);
    assert.deepEqual(r2.changes.map((c) => [c.stream_id, c.period_start, c.after]), r.changes.map((c) => [c.stream_id, c.period_start, c.after]), `iter ${iter}: порядок строк`);
    let cur = BASE;
    for (const e of H.hours_edits(r.changes)) { const x = apply_edit(cur, e, {}); assert.ok(x.ok, `iter ${iter}: ${JSON.stringify(x.error)} ${JSON.stringify(e)}`); cur = x.ws; }
    const again = H.dry_run_hours(text, P, { ...CTX, streams: cur.streams });
    assert.equal(again.changes.length, 0, `iter ${iter}: повтор`);
    assert.equal(again.recognized, 0);
    assert.equal(again.duplicates, r.recognized + r.duplicates);
    let back = cur;
    for (const e of H.rollback_edits(r.changes, cur.streams).edits) { const x = apply_edit(back, e, {}); assert.ok(x.ok); back = x.ws; }
    assert.deepEqual(back.streams, BASE.streams, `iter ${iter}: откат`);
  }
});
