// fp29_adv.test.mjs — состязательная проверка FP-29 (независимый проверяющий): часы из CSV, строки в чужой валюте с двумя ногами, «Валюта решения».
// Два вида тестов.
//  1) Обычные (зелёные): свойства на случайных файлах на уровне мастера (сумма «распознано · отклонено · дубликатов» = строкам, повторный импорт даёт 0 новых,
//     откат возвращает хэш состояния), круг «рабочая область → запись журнала → перезагрузка» для партии часов и валюты решения, враждебные профили не роняют разбор
//     чужим исключением.
//  2) Дефектные (todo — красные, но не ломают прогон): найденные недочёты, см. подписи тестов. Серьёзных (высоких и средних) дефектов проверка не нашла.
// Только Node, без DOM и браузера. Расчёт по введённым данным и правилам, не консультация.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/fp29_adv.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as M from '../demo/import_model.mjs';
import * as V from '../demo/import_v11.mjs';
import * as D from '../demo/decision_currency.mjs';
import * as B from '../demo/ws_bridge.mjs';
import { create_journal, ports_from_gen } from '../demo/journal_log.mjs';
import { make_id_gen, seeded_ports } from '../demo/ids.mjs';
import { register_edit, list_edit_types, apply_edit } from '../demo/ws_edit.mjs';
import { edit_set_stream_hours } from '../demo/form_hours.mjs';
import { validate_ws } from '../engine/validate_ws.mjs';
import { analyze, canon } from '../engine/index.mjs';
import * as H from '../engine/hours_io.mjs';
import * as X from '../engine/io_fx_rows.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const read_json = (p) => JSON.parse(fs.readFileSync(path.join(PROTO, p), 'utf8'));
const enc = (s) => new TextEncoder().encode(s);
if (!list_edit_types().includes('set_stream_hours')) register_edit('set_stream_hours', edit_set_stream_hours);
if (!list_edit_types().includes('set_decision_currency')) register_edit('set_decision_currency', D.edit_set_decision_currency);

const G = read_json('data/g001.json');
const GEN = make_id_gen(seeded_ports({ seed: 2901, start_ms: 1790000000000, step_ms: 1 }));
const env = () => ({ new_id: (p) => GEN.entity(p) });
const acc = (account_id, currency, liquidity = 'operating', kind = 'bank') => ({ account_id, name: account_id, kind, liquidity, currency, exponent: currency === 'JPY' ? 0 : 2, liquidity_bp: 0 });
const RATE_USD = { fx_id: 'fx1', date: '2026-09-01', base: 'USD', quote: 'EUR', num: 9200, den: 10000, source: 'manual' };
const RATE_JPY = { fx_id: 'fx2', date: '2026-09-01', base: 'JPY', quote: 'EUR', num: 6, den: 1000, source: 'manual' };
const WFX = { ...G, accounts: [...G.accounts, acc('acc_usd', 'USD'), acc('acc_jpy', 'JPY', 'savings')], rates: [RATE_USD, RATE_JPY] };

/** Детерминированный генератор случайных чисел (LCG), чтобы красный прогон воспроизводился. */
function make_rnd(seed) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  return { rnd, pick: (a) => a[Math.floor(rnd() * a.length)], int: (n) => Math.floor(rnd() * n) };
}

const { hours_by_period: _hbp, ...NO_HOURS } = G.streams[0];
const WEEK = { ...NO_HOURS, stream_id: 'S-WEEK', name: 'Недельный', period: 'week', cutoff: { kind: 'weekday', weekday: 0 } };
const BIWEEK = { ...NO_HOURS, stream_id: 'S-BI', name: 'Двухнедельный', period: 'biweek', cutoff: { kind: 'weekday', weekday: 0, anchor: '2026-09-06' } };
const WH = { ...G, streams: [NO_HOURS, WEEK, BIWEEK] };

function hours_plan(ws, text, stream_id = 'S-HOURLY') {
  const r = V.plan_hours(ws, { text, profile: H.HOURS_PROFILE, hours_stream_id: stream_id, name: 'h.csv', bytes: enc(text) });
  assert.ok(r.ok, JSON.stringify(r.error));
  return r.plan;
}

// ── обычные: свойства на уровне мастера ──────────────────────────────────────────────────────────────────────────────

test('ADV-01 обмены на случайных файлах (мастер): сумма «распознано · отклонено · дубликатов» = строкам; запись проходит validate_ws; повторный импорт — 0 новых; откат возвращает хэш состояния', () => {
  const { rnd, pick } = make_rnd(2901);
  void rnd;
  for (let n = 0; n < 60; n++) {
    const rows = [];
    const k = 1 + Math.floor(rnd() * 7);
    for (let i = 0; i < k; i++) {
      const kind = pick(['x', 'x', 'x', 'reg', 'jpy', 'bad']);
      const d = pick(['2026-09-02', '2026-09-20', '2026-10-02', '2026-10-03', '2026-08-15']);
      const a = pick([100000, 50000, 1234, 99900]) * pick([-1, 1]);
      if (kind === 'x') rows.push(`${d},${a},USD,Обмен ${pick(['a', 'b'])},${pick([92400, 46000, 5000])},EUR`);
      else if (kind === 'reg') rows.push(`${d},${a},EUR,Обычная ${pick(['a', 'b'])},,`);
      else if (kind === 'jpy') rows.push(`${d},${Math.abs(a) * 10},JPY,Иена,${pick([-50000, 5000])},EUR`);
      else rows.push(`${d},${a},USD,Без второй ноги,,`);
    }
    const text = 'date,amount_minor,currency,note,counter_amount_minor,counter_currency\n' + rows.join('\n') + '\n';
    const w = M.new_wizard();
    assert.ok(M.wiz_csv_load(w, WFX, { name: 'f.csv', bytes: enc(text) }).ok);
    M.wiz_csv_set(w, WFX, { profile_choice: 'fx-rows-csv-1', account_id: 'acc_main' });
    const r = M.wiz_csv_run(w, WFX);
    assert.ok(r.ok, JSON.stringify(r.error) + '\n' + text);
    const rp = w.csv.plan.report;
    assert.equal(rp.recognized + rp.rejected + rp.duplicates, rp.rows_total, JSON.stringify(rp) + '\n' + text);
    const h0 = M.ws_state_hash(WFX);
    const c = M.wiz_commit(w, 'csv', WFX, env());
    if (!c.ok) { assert.equal(c.error.ctx.reason, 'nothing_to_import', JSON.stringify(c.error) + '\n' + text); continue; }
    assert.equal(validate_ws(c.ws).ok, true, JSON.stringify(validate_ws(c.ws).errors) + '\n' + text);
    const w2 = M.new_wizard();
    M.wiz_csv_load(w2, c.ws, { name: 'f.csv', bytes: enc(text) });
    M.wiz_csv_set(w2, c.ws, { profile_choice: 'fx-rows-csv-1', account_id: 'acc_main' });
    const r2 = M.wiz_csv_run(w2, c.ws);
    assert.ok(r2.ok);
    assert.ok(w2.csv.plan.report.recognized === 0 || w2.csv.plan.dry.doubles.length > 0, 'повторный импорт: ' + JSON.stringify(w2.csv.plan.report) + '\n' + text);
    const rb = M.wiz_rollback(w, c.ws, c.batch.batch_id);
    assert.ok(rb.ok);
    assert.equal(M.ws_state_hash(rb.ws), h0, 'откат вернул состояние\n' + text);
  }
});

test('ADV-02 часы на случайных файлах (мастер): сумма трёх чисел = строкам; повторный импорт — 0 новых; откат возвращает хэш; месяц, неделя и две недели', () => {
  const { pick, int } = make_rnd(77);
  for (let n = 0; n < 60; n++) {
    const rows = ['date,hours,stream'];
    for (let i = 0; i < 1 + int(10); i++) {
      rows.push([pick(['2026-08-03', '2026-09-03', '2026-09-28', '2026-10-02', '2026-10-30', '2026-02-30', 'xx', '']), pick(['8', '7.5', '0.0167', '6,33', '100', '', '-1', '999999']),
        pick(['S-HOURLY', 'Недельный', 'S-BI', 'двухнедельный', 'нет такого', ''])].join(','));
    }
    const text = rows.join('\n') + '\n';
    const p = hours_plan(WH, text);
    const rp = p.report;
    assert.equal(rp.recognized + rp.rejected + rp.duplicates, rp.rows_total, JSON.stringify(rp) + '\n' + text);
    const h0 = M.ws_state_hash(WH);
    const c = V.commit_hours(WH, p, env());
    if (!c.ok) { assert.equal(c.error.ctx.reason, 'nothing_to_import'); continue; }
    const again = hours_plan(c.ws, text);
    assert.equal(again.report.recognized, 0, 'повторный импорт\n' + text);
    const rb = V.rollback_hours(c.ws, c.batch.batch_id);
    assert.ok(rb.ok, JSON.stringify(rb.error));
    assert.equal(M.ws_state_hash(rb.ws), h0, 'откат вернул состояние\n' + text);
  }
});

test('ADV-03 журнал: партия часов и её откат, валюта решения переживают «запись журнала → перезагрузка» (sync_journal / events_to_ws); круг EUR → USD → EUR возвращает прежний расчёт', () => {
  const { hours_by_period: _h, ...no_h } = G.streams[0];
  const base = { ...G, streams: [no_h] };
  const ports = ports_from_gen(make_id_gen(seeded_ports({ seed: 9, start_ms: 1790000000000, step_ms: 1 })));
  const journal = create_journal({ events: B.ws_to_events(base), ports });
  const p = hours_plan(base, 'date,hours\n2026-09-03,8\n2026-10-02,6\n');
  const c = V.commit_hours(base, p, env());
  assert.ok(c.ok);
  B.sync_journal(journal, base, c.ws);
  assert.equal(canon(B.events_to_ws(journal.events(), base)), canon(c.ws), 'после записи партии');
  const rb = V.rollback_hours(c.ws, c.batch.batch_id);
  B.sync_journal(journal, c.ws, rb.ws);
  const reloaded = B.events_to_ws(journal.events());
  assert.equal(reloaded.hours_imports, undefined, 'партия снята и в журнале');
  assert.equal(M.ws_state_hash(reloaded), M.ws_state_hash(base));
  // валюта решения
  const W = { ...G, reserves: [], allocations: [], tax_rules: [], accounts: [...G.accounts, acc('acc_usd', 'USD', 'savings')], rates: [RATE_USD] };
  const j2 = create_journal({ events: B.ws_to_events(W), ports });
  const to_usd = apply_edit(W, { type: 'set_decision_currency', value: 'USD' }, {});
  assert.ok(to_usd.ok, JSON.stringify(to_usd.error));
  B.sync_journal(j2, W, to_usd.ws);
  const w3 = B.events_to_ws(j2.events());
  assert.deepEqual([w3.decision_currency, w3.params.decision_currency, analyze(w3, { as_of: w3.as_of }).decision_currency], ['USD', 'USD', 'USD']);
  const back = apply_edit(to_usd.ws, { type: 'set_decision_currency', value: 'EUR' }, {});
  assert.ok(back.ok);
  B.sync_journal(j2, to_usd.ws, back.ws);
  const w4 = B.events_to_ws(j2.events());
  assert.equal(canon(analyze(w4, { as_of: W.as_of }).series.plan.close), canon(analyze(W, { as_of: W.as_of }).series.plan.close), 'круг валют вернул тот же ряд');
});

test('ADV-04 враждебные профили: случайные порчи профилей «часы» и строк обмена либо отвергаются схемой, либо разбор бросает только RunwayError', () => {
  const { pick, int } = make_rnd(404);
  const junk = [null, undefined, 0, -1, 1.5, '', 'x', '__proto__', [], {}, { col: 'a' }, true, NaN, 1e21];
  const keys = ['date', 'hours', 'stream', 'delimiter', 'skip', 'kind', 'v', 'encoding', 'profile_id'];
  const text = 'date,hours,stream\n2026-09-03,8,S-HOURLY\n';
  const ctx = { streams: [NO_HOURS], stream_id: 'S-HOURLY', as_of: '2026-10-04' };
  for (let n = 0; n < 300; n++) {
    const p = JSON.parse(JSON.stringify(H.HOURS_PROFILE));
    for (let i = 0; i < 1 + int(3); i++) p[pick(keys)] = pick(junk);
    let v;
    try { v = H.validate_hours_profile(p); } catch (e) { assert.fail('validate_hours_profile бросил ' + e); }
    if (!v.ok) continue;
    try { H.import_hours_csv(text, p, ctx); } catch (e) { assert.equal(e?.name, 'RunwayError', 'чужое исключение: ' + e + ' ' + JSON.stringify(p)); }
  }
  for (let n = 0; n < 200; n++) {
    const fx = JSON.parse(JSON.stringify(X.FX_ROWS_PROFILE.fx));
    fx[pick(['counter_amount', 'counter_currency', 'x'])] = pick(junk);
    try { X.validate_fx_config(fx); } catch (e) { assert.fail('validate_fx_config бросил ' + e); }
  }
});

// ── дефектные (todo) ─────────────────────────────────────────────────────────────────────────────────────────────────

test('ADV-05 [НИЗКИЙ] откат партии часов «всё или ничего»: если после импорта у потока сменили тип периода (месяц → неделя), откат отказывает целиком, партия остаётся навсегда', { todo: 'rollback_edits не проверяет, что период_start всё ещё настоящее начало периода потока; set_stream_hours отвечает not_a_period_start, rollback_hours возвращает ошибку validation_failed на всю партию. Нужно: такие периоды считать пропущенными (kept/gone), остальные откатывать' }, () => {
  const p = hours_plan(WH, 'date,hours\n2026-09-03,8\n2026-10-02,6\n');
  const c = V.commit_hours(WH, p, env());
  assert.ok(c.ok);
  const week = { ...c.ws.streams[0], period: 'week', cutoff: { kind: 'weekday', weekday: 0 } };
  const changed = apply_edit(c.ws, { type: 'upsert_stream', stream: week }, {});
  assert.ok(changed.ok, JSON.stringify(changed.error));
  const rb = V.rollback_hours(changed.ws, c.batch.batch_id);
  assert.equal(rb.ok, true, 'откат должен пройти хотя бы частично: ' + JSON.stringify(rb.error));
});

test('ADV-06 [НИЗКИЙ] порядок партий часов держится на порядке ключей объекта: идентификаторы случайные, журнал хранит ключи в алфавитном порядке (canon), поэтому после перезагрузки «старые» и «новые» партии перепутаны (список, вытеснение сверх 20)', { todo: 'hours_imports[batch_id] без номера записи; commit_hours вытесняет Object.keys(prev).slice(-(MAX-1)), list_hours_batches идёт в порядке ключей. Нужно: хранить порядковый номер (seq) или массив' }, () => {
  let ws = WH;
  const ids = [];
  for (let i = 0; i < 6; i++) {
    const p = hours_plan(ws, `date,hours\n2026-0${3 + i}-03,${5 + i}\n`);
    const c = V.commit_hours(ws, p, env());
    ws = c.ws;
    ids.push(c.batch.batch_id);
  }
  const reloaded = JSON.parse(canon(ws)); // как после перезагрузки: ключи в порядке canon
  assert.deepEqual(V.list_hours_batches(reloaded).map((b) => b.batch_id), ids, 'порядок записи сохранился');
});

test('ADV-07 [НИЗКИЙ] обмен записывает вторую ногу на долговой счёт, если он единственный в валюте операции (обмен — между своими денежными счетами)', { todo: 'merge_fx_rows берёт counters из всех открытых счетов валюты, без отбора по liquidity; долговой счёт принимается как «счёт второй ноги». Нужно: исключить liquidity debt (и, возможно, asset) → fx_no_counter_account' }, () => {
  const ws = { ...G, accounts: [...G.accounts, acc('acc_loan_usd', 'USD', 'debt', 'loan')], rates: [RATE_USD] };
  const text = 'date,amount_minor,currency,note,counter_amount_minor,counter_currency\n2026-10-02,-100000,USD,Обмен,92400,EUR\n';
  const w = M.new_wizard();
  assert.ok(M.wiz_csv_load(w, ws, { name: 'f.csv', bytes: enc(text) }).ok);
  M.wiz_csv_set(w, ws, { profile_choice: 'fx-rows-csv-1', account_id: 'acc_main' });
  assert.ok(M.wiz_csv_run(w, ws).ok);
  assert.equal(w.csv.plan.report.rejected, 1, 'обмен на долговой счёт не должен приниматься');
});

test('ADV-08 [НИЗКИЙ] строка часов с датой после «сегодня» внутри текущего периода принимается молча как «отработано» (у фактов такая строка — future_date)', { todo: 'import_hours_csv отвергает только период, начавшийся позже as_of (future_period); строка 30 октября при as_of 4 октября попадает в итог октября без предупреждения. Нужно: отвергать строку с датой позже as_of (или предупреждать)' }, () => {
  const p = hours_plan(WH, 'date,hours\n2026-10-30,200\n');
  assert.equal(p.report.rejected, 1, 'строка из будущего не должна попадать в «отработано»');
});
