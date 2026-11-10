// import_v11.test.mjs — FP-29: часы из CSV и строки в чужой валюте с двумя ногами в мастере импорта (чистая модель demo/import_model.mjs + demo/import_v11.mjs, без DOM).
// ALG-07 A07.7, ALG-14 A14.7, REQ-091 REQ-092 REQ-093: профиль «часы» выбирается по заголовку; сухой прогон «распознано · отклонено · дубликатов»; запись партии общим путём;
// откат партии возвращает состояние (для часов — и после перезагрузки: партия лежит в данных); обмен пишется двумя ногами с общим переводом и выведенным курсом; повторный импорт — 0 новых.
// Экран: import_v11_boot.test.mjs; движок: hours_io.test.mjs, io_fx_rows.test.mjs. Расчёт по введённым данным и правилам, не консультация.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/import_v11.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as M from '../demo/import_model.mjs';
import * as V from '../demo/import_v11.mjs';
import { make_id_gen, seeded_ports } from '../demo/ids.mjs';
import { register_edit, list_edit_types, apply_edit } from '../demo/ws_edit.mjs';
import { edit_set_stream_hours } from '../demo/form_hours.mjs';
import { ws_to_journal, journal_to_ws } from '../demo/ws_bridge.mjs';
import { validate_ws } from '../engine/validate_ws.mjs';
import { analyze } from '../engine/index.mjs';
import { HOURS_PROFILE } from '../engine/hours_io.mjs';
import { FX_ROWS_PROFILE } from '../engine/io_fx_rows.mjs';
import catalog from '../demo/i18n/importv11.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const read_json = (p) => JSON.parse(fs.readFileSync(path.join(PROTO, p), 'utf8'));
const enc = (s) => new TextEncoder().encode(s);
if (!list_edit_types().includes('set_stream_hours')) register_edit('set_stream_hours', edit_set_stream_hours);

function deep_freeze(x) {
  if (x === null || typeof x !== 'object' || Object.isFrozen(x)) return x;
  for (const k of Object.keys(x)) deep_freeze(x[k]);
  return Object.freeze(x);
}

const G = deep_freeze(read_json('data/g001.json')); // замороженная: любая мутация мастером упадёт
const GEN = make_id_gen(seeded_ports({ seed: 29, start_ms: 1790000000000, step_ms: 1 }));
const env = () => ({ new_id: (p) => GEN.entity(p) });
const acc = (account_id, currency, liquidity = 'operating') => ({ account_id, name: 'Счёт ' + account_id, kind: 'bank', liquidity, currency, exponent: 2, liquidity_bp: 0 });
/** G-001 с долларовым счётом, курсом USD → EUR и без резервов (валюту решения в этих тестах не меняют). */
const WFX = deep_freeze({ ...G, accounts: [...G.accounts, acc('acc_usd', 'USD')], rates: [{ fx_id: 'fx1', date: '2026-10-01', base: 'USD', quote: 'EUR', num: 9200, den: 10000, source: 'manual' }] });

const HOURS_TEXT = 'date,hours\n2026-09-03,8\n2026-09-04,7.5\n2026-09-05,100\n2026-10-02,6.33\n2026-11-02,5\nxx,3\n2026-09-06,\n';
const FX_TEXT = 'date,amount_minor,currency,note,counter_amount_minor,counter_currency\n2026-10-02,-100000,USD,Обмен в евро,92400,EUR\n2026-10-03,50000,USD,Обратно,-46000,EUR\n2026-10-03,-1000,USD,Нет второй ноги,,\n2026-10-03,-1000,GBP,Фунты,900,EUR\n2026-10-03,1500,EUR,Обычная строка,,\n';

function load(ws, text, name = 'f.csv') {
  const w = M.new_wizard();
  const l = M.wiz_csv_load(w, ws, { name, bytes: enc(text) });
  assert.ok(l.ok, JSON.stringify(l.error));
  return w;
}
function run(ws, text, patch) {
  const w = load(ws, text);
  if (patch !== undefined) M.wiz_csv_set(w, ws, patch);
  const r = M.wiz_csv_run(w, ws);
  assert.ok(r.ok, JSON.stringify(r.error));
  return { w, plan: w.csv.plan, report: w.csv.plan.report };
}
const sum_ok = (rp) => rp.recognized + rp.rejected + rp.duplicates === rp.rows_total;

// ── профили v1.1 ────────────────────────────────────────────────────────────────────────────────────────────────────

test('FP-29 профили v1.1: реестр V11_PROFILES = файлы data/profiles = профили движка; BUILTIN_PROFILES не менялся; id из прототипа не профиль', () => {
  assert.deepEqual(Object.keys(V.V11_PROFILES), ['hours-csv-1', 'fx-rows-csv-1']);
  assert.deepEqual(read_json('data/profiles/hours-csv-1.json'), V.V11_PROFILES['hours-csv-1']);
  assert.deepEqual(read_json('data/profiles/fx-rows-csv-1.json'), V.V11_PROFILES['fx-rows-csv-1']);
  assert.equal(V.V11_PROFILES['hours-csv-1'], HOURS_PROFILE);
  assert.equal(V.V11_PROFILES['fx-rows-csv-1'], FX_ROWS_PROFILE);
  assert.deepEqual(Object.keys(M.BUILTIN_PROFILES), ['csv-generic', 'csv-semicolon-dmy', 'runway-csv-1'], 'встроенные профили фактов прежние');
  assert.equal(V.is_v11_profile_id('hours-csv-1'), true);
  assert.equal(V.is_v11_profile_id('csv-generic'), false);
  assert.equal(V.is_v11_profile_id('__proto__'), false);
  assert.equal(V.is_v11_profile_id('constructor'), false);
  assert.equal(V.is_v11_profile_id(null), false);
});

test('FP-29 recommend_v11_profile: набор колонок узнаётся по заголовку; обычные выписки и файл Runway профилем v1.1 не считаются; разделитель берётся из файла', () => {
  assert.equal(V.recommend_v11_profile({ header: ['date', 'hours'] }), 'hours-csv-1');
  assert.equal(V.recommend_v11_profile({ header: ['date', 'hours', 'stream', 'note'] }), 'hours-csv-1');
  assert.equal(V.recommend_v11_profile({ header: ['date', 'amount_minor', 'currency', 'note', 'counter_amount_minor', 'counter_currency'] }), 'fx-rows-csv-1');
  assert.equal(V.recommend_v11_profile({ header: ['date', 'amount_minor', 'currency', 'note', 'layer'] }), null, 'файл Runway — профиль runway-csv-1');
  assert.equal(V.recommend_v11_profile({ header: ['date', 'hours', 'amount_minor'] }), null);
  assert.equal(V.recommend_v11_profile({ header: ['Date', 'Description', 'Amount', 'Currency'] }), null);
  const semi = V.v11_profile('hours-csv-1', { delimiter: ';' });
  assert.equal(semi.profile.delimiter, ';');
  assert.equal(semi.fx, null);
  assert.equal(V.V11_PROFILES['hours-csv-1'].delimiter, ',', 'реестр не изменён');
  const fxp = V.v11_profile('fx-rows-csv-1', { delimiter: ';' });
  assert.equal('fx' in fxp.profile, false, 'для разбора фактов блок fx отделён');
  assert.deepEqual(fxp.fx, FX_ROWS_PROFILE.fx);
  // мастер: профиль выбран сам, обычные профили по-прежнему узнаются первыми
  assert.equal(load(G, HOURS_TEXT).csv.profile_choice, 'hours-csv-1');
  assert.equal(load(WFX, FX_TEXT).csv.profile_choice, 'fx-rows-csv-1');
  assert.equal(load(G, 'Date,Description,Amount,Currency\n2026-10-01,Кофе,-3.50,EUR\n').csv.profile_choice, 'csv-generic');
});

// ── часы ────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('A07.7 REQ-092 часы в мастере: профиль «часы» выбран по заголовку; сухой прогон считает периоды; данные не меняются; тот же путь «файл → колонки → отчёт», что у фактов', () => {
  const h0 = M.ws_state_hash(G);
  const w = load(G, HOURS_TEXT);
  assert.equal(w.csv.step, 'columns');
  assert.equal(w.csv.recommended, 'hours-csv-1');
  const r = M.wiz_csv_run(w, G);
  assert.ok(r.ok);
  assert.equal(w.csv.step, 'report');
  const plan = w.csv.plan;
  assert.equal(plan.kind, 'hours');
  assert.equal(plan.profile_id, 'hours-csv/1');
  const rp = plan.report;
  assert.deepEqual([rp.rows_total, rp.recognized, rp.rejected, rp.duplicates], [7, 4, 3, 0]);
  assert.equal(sum_ok(rp), true);
  assert.equal(rp.sum_ok, true);
  assert.deepEqual(rp.by_reason, { future_period: 1, bad_date: 1, empty_hours: 1 });
  assert.deepEqual([rp.from, rp.to], ['2026-09-01', '2026-10-01']);
  assert.deepEqual(rp.warnings, [{ code: 'hours_rounded', n: 1 }]);
  assert.deepEqual(plan.hours.changes, [
    { stream_id: 'S-HOURLY', period_start: '2026-09-01', before: 5760, after: 6930, rows: 3 },
    { stream_id: 'S-HOURLY', period_start: '2026-10-01', before: null, after: 380, rows: 1 },
  ]);
  assert.equal(M.importable_count(plan, {}), 2, 'кнопка «Подтвердить: записать 2» — по числу периодов');
  assert.deepEqual(M.select_items(plan, {}), [], 'фактов в плане нет');
  assert.equal(M.ws_state_hash(G), h0, 'сухой прогон данные не меняет');
});

test('A07.7 REQ-093 часы: «Подтвердить» пишет «отработано» правками set_stream_hours и партию в hours_imports; расчёт проходит; повторный импорт — 0 новых; откат возвращает данные до импорта', () => {
  const { w, plan } = run(G, HOURS_TEXT);
  const c = M.wiz_commit(w, 'csv', G, env());
  assert.ok(c.ok, JSON.stringify(c.error));
  assert.equal(c.batch.what, 'hours');
  assert.equal(c.batch.facts, 2);
  assert.deepEqual(c.events, []);
  assert.deepEqual(c.ws.streams[0].hours_by_period, { '2026-09-01': { exp_minutes: 5760, actual_minutes: 6930 }, '2026-10-01': { actual_minutes: 380 } });
  assert.deepEqual(Object.keys(c.ws.hours_imports), [c.batch.batch_id]);
  assert.deepEqual(c.ws.hours_imports[c.batch.batch_id].changes, [
    { stream_id: 'S-HOURLY', period_start: '2026-09-01', before: 5760, after: 6930 },
    { stream_id: 'S-HOURLY', period_start: '2026-10-01', before: null, after: 380 },
  ]);
  assert.equal(c.ws.hours_imports[c.batch.batch_id].source_hash, plan.source.hash);
  assert.equal(c.ws.facts, G.facts, 'факты не тронуты');
  assert.equal(validate_ws(c.ws).ok, true, JSON.stringify(validate_ws(c.ws).errors));
  assert.ok(analyze(c.ws, { as_of: c.ws.as_of }).decision_currency, 'расчёт проходит');
  M.wiz_committed(w, 'csv', c.batch);
  assert.deepEqual(w.csv.result, { batch_id: c.batch.batch_id, facts: 2, kind: 'csv', what: 'hours' });
  assert.equal(w.csv.step, 'done');
  assert.deepEqual(V.list_hours_batches(c.ws), [{ batch_id: c.batch.batch_id, count: 2, from: '2026-09-01', to: '2026-10-01', at: '2026-10-04' }]);
  assert.deepEqual(M.list_batches(c.ws), [], 'в списке партий фактов её нет');

  // повторный импорт того же файла
  const again = run(c.ws, HOURS_TEXT);
  assert.deepEqual([again.report.recognized, again.report.rejected, again.report.duplicates], [0, 3, 4]);
  assert.equal(sum_ok(again.report), true);
  const none = M.wiz_commit(again.w, 'csv', c.ws, env());
  assert.equal(none.ok, false);
  assert.equal(none.error.ctx.reason, 'nothing_to_import');

  // откат
  const rb = M.wiz_rollback(w, c.ws, c.batch.batch_id);
  assert.ok(rb.ok, JSON.stringify(rb.error));
  assert.deepEqual(rb.removed, { facts: 0, accounts: 0, anchors: 0, rates: 0, hours: 2, kept: 0, gone: 0 });
  assert.deepEqual(rb.ws, G, 'данные точно такие же, как до импорта (поле hours_imports убрано)');
  assert.equal(M.ws_state_hash(rb.ws), M.ws_state_hash(G));
  assert.equal(M.wiz_rollback(w, rb.ws, c.batch.batch_id).ok, false, 'второй откат той же партии — unknown_batch');
});

test('A07.7 REQ-093 партия часов лежит в данных: после круга «рабочая область → файл-копия → рабочая область» откат работает; исправленное потом вручную остаётся; повторная запись партии вытесняет старые (не больше 20)', () => {
  const { w } = run(G, HOURS_TEXT);
  const c = M.wiz_commit(w, 'csv', G, env());
  assert.ok(c.ok);
  // перезагрузка: журнал → рабочая область
  const back = journal_to_ws(ws_to_journal(c.ws));
  assert.deepEqual(back.hours_imports, c.ws.hours_imports, 'партия пережила файл-копию');
  assert.equal(V.is_hours_batch(back, c.batch.batch_id), true);
  const rb = M.wiz_rollback(M.new_wizard(), back, c.batch.batch_id);
  assert.ok(rb.ok, JSON.stringify(rb.error));
  assert.equal(M.ws_state_hash(rb.ws), M.ws_state_hash(G), 'после перезагрузки откат тоже возвращает состояние');

  // октябрь исправлен вручную после импорта
  const hand = apply_edit(c.ws, { type: 'set_stream_hours', stream_id: 'S-HOURLY', period_start: '2026-10-01', actual_minutes: 400 }, {}).ws;
  const rb2 = V.rollback_hours(hand, c.batch.batch_id);
  assert.ok(rb2.ok);
  assert.deepEqual([rb2.removed.hours, rb2.removed.kept], [1, 1]);
  assert.equal(rb2.ws.streams[0].hours_by_period['2026-10-01'].actual_minutes, 400, 'исправленное вами остаётся');
  assert.equal(rb2.ws.streams[0].hours_by_period['2026-09-01'].actual_minutes, 5760, 'внесённое импортом возвращено');
  assert.equal('hours_imports' in rb2.ws, false);

  // неизвестные и чужие идентификаторы
  for (const bad of ['', '__proto__', 'нет_такой', 'imp_000000000000', 5, null]) assert.equal(V.rollback_hours(G, bad).ok, false, String(bad));
  assert.equal(V.rollback_hours(G, 'x').error.ctx.reason, 'unknown_batch');
  assert.equal(V.rollback_hours(null, 'x').error.ctx.reason, 'no_workspace');

  // предел партий
  let cur = G;
  const ids = [];
  for (let i = 0; i < V.MAX_HOURS_BATCHES + 3; i++) {
    const text = `date,hours\n2026-09-03,${i + 1}\n`;
    const r = run(cur, text);
    const x = M.wiz_commit(r.w, 'csv', cur, env());
    assert.ok(x.ok, JSON.stringify(x.error));
    ids.push(x.batch.batch_id);
    cur = x.ws;
  }
  assert.equal(Object.keys(cur.hours_imports).length, V.MAX_HOURS_BATCHES);
  assert.deepEqual(Object.keys(cur.hours_imports), ids.slice(-V.MAX_HOURS_BATCHES), 'старые вытеснены, порядок записи сохранён');
});

test('A07.7 часы: устаревший план (данные менялись) не записывается; нет потоков — все строки отклонены и сказано почему; профиль из файла с другими колонками принят; чужие поля профиля — отказ', () => {
  const { w } = run(G, HOURS_TEXT);
  const other = { ...G, name: 'другой' }; // другая рабочая область: план строился по G
  const stale = M.wiz_commit(w, 'csv', other, env());
  assert.equal(stale.ok, false);
  assert.equal(stale.error.ctx.reason, 'stale_plan');

  const nostreams = { ...G, streams: [] };
  const r = run(nostreams, HOURS_TEXT);
  assert.equal(r.plan.hours.no_streams, true);
  assert.deepEqual([r.report.recognized, r.report.rejected], [0, 7]);
  assert.deepEqual(r.report.by_reason, { unknown_stream: 6, bad_date: 1 }, 'сначала дата, потом поток: всё остальное — «поток не найден»');
  assert.equal(M.importable_count(r.plan, {}), 0);
  assert.equal(M.wiz_commit(r.w, 'csv', nostreams, env()).error.ctx.reason, 'nothing_to_import');

  // профиль из файла: свои колонки, «;», единицы «ч:мм»
  const mine = { profile_id: 'my-hours', v: 1, kind: 'hours', encoding: 'utf-8', delimiter: ';', skip: 0, date: { col: 'День', fmt: 'DD.MM.YYYY' }, hours: { col: 'Время', unit: 'hm' } };
  const w2 = load(G, 'День;Время\n03.09.2026;7:30\n04.09.2026;0:45\n');
  const pf = M.wiz_csv_profile_file(w2, G, JSON.stringify(mine));
  assert.ok(pf.ok, JSON.stringify(pf.error));
  assert.equal(w2.csv.profile_choice, 'file');
  assert.ok(M.wiz_csv_run(w2, G).ok);
  assert.equal(w2.csv.plan.kind, 'hours');
  assert.deepEqual(w2.csv.plan.hours.changes, [{ stream_id: 'S-HOURLY', period_start: '2026-09-01', before: 5760, after: 495, rows: 2 }], 'поток один — берётся сам');
  for (const bad of [{ ...mine, regex: 'x' }, { ...mine, hours: { col: 'Время', unit: 'weeks' } }, { ...mine, kind: 'hours', date: { col: 'x' } }]) {
    const w3 = load(G, HOURS_TEXT);
    const e = M.wiz_csv_profile_file(w3, G, JSON.stringify(bad));
    assert.equal(e.ok, false);
    assert.equal(e.error.ctx.reason, 'bad_profile');
  }
  const w4 = load(G, HOURS_TEXT);
  assert.equal(M.wiz_csv_profile_file(w4, G, '{"__proto__": {"kind": "hours"}}').error.ctx.reason, 'forbidden_key');
  assert.equal(M.wiz_csv_profile_file(w4, G, JSON.stringify({ ...mine, encoding: 'koi8-r' })).error.ctx.reason, 'unsupported_encoding');
});

test('A07.7 выбор потока в мастере: v11.hours_stream_id принимает только существующий поток; при двух потоках без выбора строки без колонки потока отклонены', () => {
  const two = { ...G, streams: [...G.streams, { ...G.streams[0], stream_id: 'S-TWO', name: 'Второй', hours_by_period: {} }] };
  const w = load(two, HOURS_TEXT);
  assert.equal(M.wiz_csv_run(w, two).plan.report.recognized, 0, 'потоков два, выбора нет: поток не угадывается');
  M.wiz_csv_set(w, two, { hours_stream_id: 'нет' });
  assert.equal(w.csv.v11.hours_stream_id, null, 'неизвестный поток не принят');
  M.wiz_csv_set(w, two, { hours_stream_id: 'S-TWO' });
  assert.equal(w.csv.v11.hours_stream_id, 'S-TWO');
  assert.equal(w.csv.plan, null, 'настройка сбрасывает отчёт');
  assert.ok(M.wiz_csv_run(w, two).ok);
  assert.deepEqual(w.csv.plan.hours.changes.map((c) => c.stream_id), ['S-TWO', 'S-TWO']);
  M.wiz_csv_set(w, two, { hours_stream_id: null });
  assert.equal(w.csv.v11.hours_stream_id, null);
});

// ── строки обмена ───────────────────────────────────────────────────────────────────────────────────────────────────

test('A14.7 A08.3 обмен в мастере: профиль выбран по заголовку; сухой прогон считает строки (обмен — одна строка), называет отказы и справочную разницу; данные не меняются', () => {
  const h0 = M.ws_state_hash(WFX);
  const { w, plan, report } = run(WFX, FX_TEXT);
  assert.equal(w.csv.profile_choice, 'fx-rows-csv-1');
  assert.equal(plan.profile_id, 'fx-rows-csv/1');
  assert.deepEqual([report.rows_total, report.recognized, report.rejected, report.duplicates], [5, 3, 2, 0]);
  assert.equal(sum_ok(report), true);
  assert.deepEqual(report.by_reason, { fx_no_counter: 1, fx_no_counter_account: 1 });
  assert.equal(report.net_minor, 92400 - 46000 + 1500, 'итог по счёту импорта: обмены считаются ногой этого счёта');
  assert.deepEqual(plan.fx, { mismatch_rows: 4, converted: 2, rejected: 2, missing_pairs: [], errors: [], skipped_currencies: 0 });
  const ex = V.plan_exchanges(plan);
  assert.deepEqual(ex.map((c) => [c.row, c.exchange.diff_minor]), [[2, -400], [3, 0]]);
  assert.equal(M.importable_count(plan, {}), 3);
  assert.equal(M.ws_state_hash(WFX), h0);
});

test('A14.7 REQ-093 обмен записывается двумя ногами одного перевода: выведенный курс на проданной ноге, ключ строки на ноге счёта импорта, партия на обеих; расчёт проходит; повторный импорт — 0 новых; откат убирает обе ноги', () => {
  const { w } = run(WFX, FX_TEXT);
  const c = M.wiz_commit(w, 'csv', WFX, env());
  assert.ok(c.ok, JSON.stringify(c.error));
  assert.equal(c.batch.facts, 5, 'два обмена по две ноги и одна обычная строка');
  assert.equal(c.ws.facts.length, WFX.facts.length + 5);
  const added = c.ws.facts.filter((f) => f.batch_id === c.batch.batch_id);
  const by_trf = new Map();
  for (const f of added.filter((x) => x.transfer_id !== undefined)) { if (!by_trf.has(f.transfer_id)) by_trf.set(f.transfer_id, []); by_trf.get(f.transfer_id).push(f); }
  assert.equal(by_trf.size, 2);
  for (const legs of by_trf.values()) {
    assert.equal(legs.length, 2);
    assert.deepEqual(legs.map((l) => l.kind), ['transfer', 'transfer']);
    assert.deepEqual(legs.map((l) => l.account_id).sort(), ['acc_main', 'acc_usd']);
    assert.equal(legs.filter((l) => l.fx !== undefined).length, 1, 'курс — на одной ноге');
    assert.ok(legs.find((l) => l.fx !== undefined).amount_minor < 0, '…на проданной');
    assert.equal(legs.filter((l) => l.dedup_key !== undefined).length, 1, 'ключ строки — на одной ноге');
    assert.equal(legs.find((l) => l.dedup_key !== undefined).account_id, 'acc_main', '…на ноге счёта импорта');
    assert.equal(new Set(legs.map((l) => l.event_id)).size, 2);
  }
  const usd = added.filter((f) => f.account_id === 'acc_usd').map((f) => f.amount_minor).sort((a, b) => a - b);
  assert.deepEqual(usd, [-100000, 50000]);
  assert.equal(added.find((f) => f.note === 'Обмен в евро' && f.account_id === 'acc_usd').fx.num, 231);
  assert.equal(validate_ws(c.ws).ok, true, JSON.stringify(validate_ws(c.ws).errors));
  assert.ok(analyze(c.ws, { as_of: c.ws.as_of }).decision_currency === 'EUR', 'расчёт принимает обмены');
  assert.deepEqual(V.list_hours_batches(c.ws), [], 'это партия фактов, не часов');
  assert.equal(M.list_batches(c.ws).find((b) => b.batch_id === c.batch.batch_id).count, 5);

  // круг через файл-копию сохраняет ноги и ключи
  const back = journal_to_ws(ws_to_journal(c.ws));
  assert.deepEqual(back.facts.filter((f) => f.batch_id === c.batch.batch_id).map((f) => f.event_id).sort(), added.map((f) => f.event_id).sort());

  // повторный импорт того же файла — 0 новых
  const again = run(c.ws, FX_TEXT);
  assert.deepEqual([again.report.recognized, again.report.rejected, again.report.duplicates], [0, 2, 3]);
  assert.equal(sum_ok(again.report), true);
  assert.equal(M.wiz_commit(again.w, 'csv', c.ws, env()).error.ctx.reason, 'nothing_to_import');

  // откат партии убирает обе ноги каждого обмена
  M.wiz_committed(w, 'csv', c.batch);
  const rb = M.wiz_rollback(w, c.ws, c.batch.batch_id);
  assert.ok(rb.ok);
  assert.equal(rb.removed.facts, 5);
  assert.equal(M.ws_state_hash(rb.ws), M.ws_state_hash(WFX));
});

test('A08.2 E_NO_RATE в мастере: нет курса USD → EUR — обмены не записываются, отчёт называет пару; "Подтвердить" недоступна; после ввода курса отчёт пересчитывается', () => {
  const norate = { ...WFX, rates: [] };
  const { w, plan, report } = run(norate, FX_TEXT);
  assert.deepEqual(plan.fx.missing_pairs, ['USD/EUR']);
  assert.deepEqual(plan.fx.errors.map((e) => [e.code, e.ctx.pair]), [['E_NO_RATE', 'USD/EUR']]);
  assert.equal(report.by_reason.no_rate, 2);
  assert.deepEqual([report.recognized, report.rejected], [1, 4], 'остаётся только обычная строка');
  assert.equal(M.importable_count(plan, {}), 1);
  const fixed = { ...norate, rates: WFX.rates };
  assert.equal(M.wiz_refresh(w, 'csv', fixed), true, 'данные изменились — план устарел и пересчитан');
  assert.equal(w.csv.plan.fx.converted, 2);
  assert.deepEqual(w.csv.plan.fx.missing_pairs, []);
});

test('A14.7 свои колонки: переключатель «строки в другой валюте» и колонки второй ноги в основных единицах; без переключателя строки по-прежнему currency_mismatch', () => {
  const text = 'Datum;Betrag;Währung;Text;Gegenwert;Währung 2\n02.10.2026;-1.000,00;USD;Tausch;924,00;EUR\n03.10.2026;-12,50;EUR;Kaffee;;\n';
  const w = load(WFX, text);
  assert.equal(w.csv.recommended, null);
  assert.equal(w.csv.profile_choice, 'custom');
  assert.equal(w.csv.mapping.currency_col, 2);
  assert.deepEqual([w.csv.mapping.amount_col, w.csv.mapping.decimal, w.csv.mapping.thousands], [1, ',', '.']);
  // без переключателя: прежнее поведение
  assert.ok(M.wiz_csv_run(w, WFX).ok);
  assert.deepEqual(w.csv.plan.report.by_reason, { currency_mismatch: 1 });
  assert.equal(w.csv.plan.fx, undefined);
  // с переключателем и колонками второй ноги
  M.wiz_csv_set(w, WFX, { fx_on: true, fx_amount_col: 4, fx_currency_col: 5 });
  assert.deepEqual([w.csv.v11.fx_on, w.csv.v11.fx_amount_col, w.csv.v11.fx_currency_col], [true, 4, 5]);
  assert.ok(M.wiz_csv_run(w, WFX).ok);
  assert.deepEqual(w.csv.plan.report.by_reason, {});
  assert.equal(w.csv.plan.fx.converted, 1);
  assert.deepEqual(V.plan_exchanges(w.csv.plan).map((c) => [c.amount_minor, c.exchange.counter_amount_minor, c.exchange.implied]), [[92400, -100000, { num: 231, den: 250 }]]);
  // колонка не выбрана — понятный отказ мастера, а не исключение
  M.wiz_csv_set(w, WFX, { fx_currency_col: -1 });
  const bad = M.wiz_csv_run(w, WFX);
  assert.equal(bad.ok, false);
  assert.equal(bad.error.ctx.reason, 'bad_mapping');
  // значения настроек проверяются
  M.wiz_csv_set(w, WFX, { fx_on: 'да', fx_amount_col: 1.5, fx_amount_unit: 'cents', counter_account_id: 'нет такого' });
  assert.deepEqual(w.csv.v11, { hours_stream_id: null, fx_on: true, fx_amount_col: 4, fx_currency_col: -1, fx_amount_unit: 'major', counter_account_id: null });
});

test('A14.7 профиль строк обмена из файла (обычный профиль + блок fx) принят; чужое поле в fx или в профиле — отказ; счёт второй ноги выбирается явно', () => {
  const mine = {
    profile_id: 'my-fx', v: 1, encoding: 'utf-8', delimiter: ',', skip: 0, date: { col: 'date', fmt: 'YYYY-MM-DD' }, amount: { mode: 'signed', col: 'amount_minor', unit: 'minor' },
    currency: { col: 'currency' }, desc: { cols: ['note'] }, rules: [], fx: { counter_amount: { col: 'counter_amount_minor', unit: 'minor' }, counter_currency: { fixed: 'EUR' } },
  };
  const two = deep_freeze({ ...WFX, accounts: [...WFX.accounts, acc('acc_usd2', 'USD')] });
  const w = load(two, FX_TEXT);
  assert.ok(M.wiz_csv_profile_file(w, two, JSON.stringify(mine)).ok);
  assert.equal(w.csv.profile_choice, 'file');
  assert.ok(M.wiz_csv_run(w, two).ok);
  assert.equal(w.csv.plan.fx.converted, 0, 'два долларовых счёта: счёт второй ноги не угадывается');
  assert.equal(w.csv.plan.report.by_reason.fx_no_counter_account, 3);
  M.wiz_csv_set(w, two, { counter_account_id: 'acc_usd2' });
  assert.ok(M.wiz_csv_run(w, two).ok);
  assert.equal(w.csv.plan.fx.converted, 2);
  assert.ok(V.plan_exchanges(w.csv.plan).every((c) => c.exchange.counter_account_id === 'acc_usd2'));
  for (const bad of [{ ...mine, fx: { ...mine.fx, rate: 1 } }, { ...mine, regex: 'x' }, { ...mine, fx: { counter_amount: { col: '' }, counter_currency: { fixed: 'EUR' } } }]) {
    const e = M.wiz_csv_profile_file(load(two, FX_TEXT), two, JSON.stringify(bad));
    assert.equal(e.ok, false);
    assert.equal(e.error.ctx.reason, 'bad_profile');
  }
});

test('FP-29 без блока fx и профиля «часы» поведение мастера прежнее: тот же отчёт и те же кандидаты, что у основного разбора; фильтры и воркер не затронуты', () => {
  const text = fs.readFileSync(path.join(HERE, 'fixtures', 'import-152.csv'), 'utf8');
  const w = load(G, text);
  assert.ok(M.wiz_csv_run(w, G).ok);
  const rp = w.csv.plan.report;
  assert.deepEqual([rp.rows_total, rp.recognized, rp.rejected, rp.duplicates], [152, 150, 2, 0]);
  assert.equal(w.csv.plan.fx, undefined, 'поля fx в плане фактов без обменов нет');
  assert.equal(w.csv.plan.hours, undefined);
  assert.ok(w.csv.plan.dry.recognized_items.every((c) => c.exchange === undefined));
});

// ── строки каталога ─────────────────────────────────────────────────────────────────────────────────────────────────

test('FP-29 каталог importv11: у каждой причины, профиля и единицы есть строка RU (русские буквы) и EN; плейсхолдеры одинаковы', () => {
  const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  assert.deepEqual(Object.keys(catalog.ru).sort(), Object.keys(catalog.en).sort(), 'паритет ключей');
  for (const lang of ['ru', 'en']) {
    for (const r of V.V11_REJECT_REASONS) assert.ok(catalog[lang]['importv11.rj_' + r], `${lang}: rj_${r}`);
    for (const id of Object.keys(V.V11_PROFILES)) assert.ok(catalog[lang]['importv11.pf_' + id.replaceAll('-', '_')], `${lang}: pf_${id}`);
    for (const u of ['hours', 'minutes', 'hm', 'major', 'minor']) assert.ok(catalog[lang]['importv11.u_' + u], `${lang}: u_${u}`);
  }
  for (const k of Object.keys(catalog.ru)) {
    assert.match(catalog.ru[k], /[А-Яа-яЁё]/, `RU без русских букв: ${k}`);
    assert.equal(ph(catalog.ru[k]), ph(catalog.en[k]), `плейсхолдеры: ${k}`);
  }
  assert.deepEqual([...V.V11_REJECT_REASONS], ['short_row', 'bad_date', 'future_period', 'unknown_stream', 'empty_hours', 'bad_hours', 'over_period',
    'fx_no_counter', 'fx_bad_counter', 'fx_not_account_currency', 'fx_sign', 'fx_no_counter_account', 'no_rate']);
});
