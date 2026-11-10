// call_log.test.mjs — FP-20, REQ-136 (часть без решения владельца): запись журнала вызовов ассистента `assistant.call` ТОЛЬКО с хэшами,
// порт `call_log` для `what_changed`, CSV журнала вызовов через `csv_safe_cell`. Повтор по `call_id` в пакет не входит (FP-34).
// Ожидания — независимые: хэш аргументов считается `node:crypto` по каноническому тексту из ALG-12 TV-1 (`{"amount_minor":30000,"currency":"EUR","date":"2026-10-12"}`),
// `call_id` TV-1 — `c_131fba11`, начало `inputs_hash` G-001 — `fc9d650d`. В тестах допустимы node:* (в engine/ — нет).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

import { make_tool_ctx, run_tool, call_ref } from '../engine/tools.mjs';
import { make_event, effective_events, reduce, canon } from '../engine/index.mjs';
import {
  CALL_EVENT_TYPE, CALL_ACTOR, CALL_FIELDS, CALL_CSV_COLUMNS, args_hash_of, assert_call_record, call_record, call_event, record_call,
  call_entries, call_day_port, last_call_hex, export_calls_csv, day_port_of, last_hex_of, calls_csv,
} from '../engine/call_log.mjs';
import * as CL from '../engine/call_log.mjs';
import { ws_to_events } from '../demo/ws_bridge.mjs';
import { throws_code } from './helpers.mjs';

const DATA = new URL('../data/', import.meta.url);
const G = JSON.parse(fs.readFileSync(new URL('g001.json', DATA), 'utf8'));
const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const SRC = fs.readFileSync(new URL('../engine/call_log.mjs', import.meta.url), 'utf8');

const TV1 = { date: '2026-10-12', amount_minor: 30000, currency: 'EUR' };
const TV1_CANON = '{"amount_minor":30000,"currency":"EUR","date":"2026-10-12"}';

function mk(ws = G, opts = {}) {
  const ctx = make_tool_ctx(ws, { as_of: ws.as_of }, opts);
  const call = (name, args) => { ctx.calls_used = 0; return run_tool(name, args, ctx); };
  return { ctx, call };
}

/** Порты записи: идентификатор, номер и время приходят снаружи (движок часов не читает). */
const ports = (n, at = '2026-10-04T12:00:00Z') => ({ event_id: 'call~' + String(n).padStart(4, '0'), seq: 1000 + n, recorded_at: at });

/** Журнал-заглушка с методом `append`, как у `demo/journal_log.mjs`. */
function fake_journal() {
  const events = [];
  return {
    events,
    append(type, payload, o) {
      const e = make_event(type, payload, { event_id: 'fj~' + (events.length + 1), seq: events.length + 1, recorded_at: '2026-10-04T12:00:00Z', ...o });
      events.push(e);
      return e;
    },
  };
}

// ── запись: только хэши ──────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-136 call_record: пять полей — call_id, tool, args_hash, inputs_hash, engine_version; args_hash = sha256 канонических аргументов (ALG-12 TV-1)', () => {
  const r = mk().call('check_purchase', TV1);
  assert.equal(call_ref(r.call_id), 'c_131fba11');
  const rec = call_record(r, TV1);
  assert.deepEqual(Object.keys(rec), [...CALL_FIELDS]);
  assert.deepEqual(CALL_FIELDS, ['call_id', 'tool', 'args_hash', 'inputs_hash', 'engine_version']);
  assert.equal(rec.call_id, '131fba11');
  assert.equal(rec.tool, 'check_purchase');
  assert.equal(canon(TV1), TV1_CANON, 'канонический вид аргументов — как в ALG-12');
  assert.equal(rec.args_hash, sha(TV1_CANON), 'args_hash считается независимо node:crypto');
  assert.match(rec.args_hash, /^[0-9a-f]{64}$/);
  assert.ok(rec.inputs_hash.startsWith('fc9d650d'), 'начало inputs_hash G-001');
  assert.equal(rec.inputs_hash, r.inputs_hash);
  assert.equal(rec.engine_version, '0.1.0');
  assert.equal(args_hash_of(TV1), rec.args_hash);
  assert.equal(args_hash_of({ date: '2026-10-12', currency: 'EUR', amount_minor: 30000 }), rec.args_hash, 'порядок ключей не важен (canon)');
});

test('REQ-136 call_record: сырых текстов и аргументов в записи нет — ни вопроса, ни суммы, ни даты, ни заметки; ключи и значения только из пяти полей', () => {
  const r = mk().call('check_purchase', TV1);
  const rec = call_record(r, TV1);
  const dump = JSON.stringify(rec);
  for (const raw of ['30000', '2026-10-12', 'EUR', 'amount_minor', 'currency', 'date']) assert.ok(!dump.includes(raw), `в записи нет «${raw}»`);
  // T1 с заметкой: заметка и ссылки на платежи в запись не попадают, хэш аргументов от них зависит
  const open = mk(G, { t1_enabled: true });
  const note_a = { ops: [{ op: 'move_plan', ref: 'P-TAX1', date: '2026-10-30' }], note: 'секретная заметка 777' };
  const note_b = { ops: [{ op: 'move_plan', ref: 'P-TAX1', date: '2026-10-30' }], note: 'другая заметка 888' };
  const ra = open.call('propose_change', note_a);
  const rb = open.call('propose_change', note_b);
  assert.equal(ra.facts.kind, 'ok');
  const ea = call_record(ra, note_a);
  const eb = call_record(rb, note_b);
  const both = JSON.stringify([ea, eb]);
  for (const raw of ['секретная', '777', 'другая', '888', 'P-TAX1', 'move_plan', '2026-10-30']) assert.ok(!both.includes(raw), `в записи нет «${raw}»`);
  assert.notEqual(ea.args_hash, eb.args_hash, 'разные аргументы — разные хэши');
  assert.notEqual(ea.call_id, eb.call_id);
});

test('REQ-136 call_record: псевдоним режима conservative = worse (тот же хэш и тот же call_id); значения по умолчанию не подставляются', () => {
  const m = mk();
  const a = m.call('explain_min_point', { mode: 'conservative' });
  const b = m.call('explain_min_point', { mode: 'worse' });
  assert.equal(a.call_id, b.call_id);
  assert.equal(call_record(a, { mode: 'conservative' }).args_hash, call_record(b, { mode: 'worse' }).args_hash);
  const bare = m.call('explain_min_point', {});
  assert.notEqual(call_record(bare, {}).args_hash, call_record(b, { mode: 'worse' }).args_hash, 'режим по умолчанию в аргументы не подставляется');
});

test('REQ-136 call_record: отказы — ошибка инструмента, чужие аргументы (call_id не сходится), аргументы не объект, лишнее поле, неверная форма хэша или инструмента', () => {
  const m = mk();
  const ok = m.call('check_purchase', TV1);
  const bad_tool = m.call('check_purchase', { date: 'не дата' });
  assert.equal(bad_tool.isError, true);
  throws_code(() => call_record(bad_tool, TV1), 'E_SCHEMA');
  throws_code(() => call_record(null, TV1), 'E_SCHEMA');
  throws_code(() => call_record(ok, { ...TV1, amount_minor: 30001 }), 'E_SCHEMA', 'чужие аргументы');
  throws_code(() => call_record(ok, null), 'E_SCHEMA');
  throws_code(() => call_record(ok, [TV1]), 'E_SCHEMA');
  throws_code(() => call_record(ok, { ...TV1, amount_minor: 1.5 }), 'E_NOT_INTEGER');
  const rec = call_record(ok, TV1);
  throws_code(() => assert_call_record({ ...rec, note: 'вопрос пользователя' }), 'E_SCHEMA');
  throws_code(() => assert_call_record({ ...rec, tool: 'чужой_инструмент' }), 'E_SCHEMA');
  throws_code(() => assert_call_record({ ...rec, args_hash: 'ABC' }), 'E_SCHEMA');
  throws_code(() => assert_call_record({ ...rec, call_id: 'c_131fba11' }), 'E_SCHEMA', 'call_id без префикса c_');
  throws_code(() => assert_call_record({ ...rec, engine_version: '=cmd|x' }), 'E_SCHEMA');
  const lacking = { ...rec };
  delete lacking.engine_version;
  throws_code(() => assert_call_record(lacking), 'E_SCHEMA');
  throws_code(() => assert_call_record([rec]), 'E_SCHEMA');
});

// ── запись журнала ───────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-136 call_event: запись assistant.call — актор assistant:a0, entity_id c_<hex>, payload равен записи; свёртка кладёт её в extra и ничего не меняет в данных', () => {
  const m = mk();
  const r = m.call('check_purchase', TV1);
  const rec = call_record(r, TV1);
  const e = call_event(rec, ports(1));
  assert.equal(e.type, CALL_EVENT_TYPE);
  assert.equal(CALL_EVENT_TYPE, 'assistant.call');
  assert.equal(e.actor, CALL_ACTOR);
  assert.equal(CALL_ACTOR, 'assistant:a0');
  assert.equal(e.entity_id, 'c_131fba11');
  assert.deepEqual(e.payload, rec);
  assert.equal(e.recorded_at, '2026-10-04T12:00:00Z');
  const journal = [...ws_to_events(G), e];
  const st = reduce(effective_events(journal));
  assert.deepEqual(st.extra['assistant.call']['c_131fba11'], rec);
  // запись вызова не меняет ни прогноз, ни inputs_hash
  const again = mk().call('check_purchase', TV1);
  assert.equal(again.inputs_hash, r.inputs_hash);
  assert.equal(again.call_id, r.call_id);
  throws_code(() => call_event({ ...rec, note: 'x' }, ports(2)), 'E_SCHEMA');
  throws_code(() => call_event(rec, null), 'E_SCHEMA');
  throws_code(() => call_event(rec, { event_id: 'x', seq: 1, recorded_at: 'вчера' }), 'E_SCHEMA');
});

test('REQ-136 record_call: пишет в журнал через append; сбой журнала и отказ записи не бросают наружу и не несут значений (только код ошибки)', () => {
  const j = fake_journal();
  const m = mk();
  const r = m.call('check_purchase', TV1);
  const ok = record_call(j, r, TV1);
  assert.equal(ok.ok, true);
  assert.equal(j.events.length, 1);
  assert.deepEqual(j.events[0].payload, call_record(r, TV1));
  assert.equal(j.events[0].actor, 'assistant:a0');
  // чужие аргументы
  assert.deepEqual(record_call(j, r, { ...TV1, amount_minor: 5 }), { ok: false, code: 'E_SCHEMA' });
  // ошибка инструмента
  assert.deepEqual(record_call(j, m.call('check_purchase', {}), {}), { ok: false, code: 'E_SCHEMA' });
  // журнал, который падает с текстом
  const broken = { append() { throw new Error('секретный текст вопроса 12345'); } };
  const bad = record_call(broken, r, TV1);
  assert.deepEqual(bad, { ok: false, code: 'E_SCHEMA' });
  assert.ok(!JSON.stringify(bad).includes('секретный'));
  const coded = { append() { const e = new Error('x'); e.code = 'E_SCHEMA'; throw e; } };
  assert.deepEqual(record_call(coded, r, TV1), { ok: false, code: 'E_SCHEMA' });
  const odd = { append() { const e = new Error('x'); e.code = 'не код — свободный текст'; throw e; } };
  assert.deepEqual(record_call(odd, r, TV1), { ok: false, code: 'E_SCHEMA' }, 'нестандартный код заменяется на E_SCHEMA');
  assert.equal(j.events.length, 1, 'отказы ничего не записали');
});

// ── чтение журнала вызовов ───────────────────────────────────────────────────────────────────────────────────────────

test('call_entries / call_day_port / last_call_hex: действующие записи типа assistant.call; повтор вызова обновляет день; откаты и чужие типы не мешают; испорченные записи пропускаются', () => {
  const m = mk();
  const r1 = m.call('check_purchase', TV1);
  const r2 = m.call('explain_min_point', {});
  const base = ws_to_events(G);
  const seq0 = base.at(-1).seq;
  const p = (n, at) => ({ event_id: 'c~' + n, seq: seq0 + n, recorded_at: at });
  const e1 = call_event(call_record(r1, TV1), p(1, '2026-10-05T08:00:00Z'));
  const e2 = call_event(call_record(r2, {}), p(2, '2026-10-06T09:30:00Z'));
  const e3 = call_event(call_record(r1, TV1), p(3, '2026-10-08T23:59:59Z')); // тот же вызов позже
  const journal = [...base, e1, e2, e3];
  const all = call_entries(journal);
  assert.deepEqual(all.map((x) => [x.seq, x.call_id, x.tool, x.recorded_at.slice(0, 10)]), [
    [seq0 + 1, r1.call_id, 'check_purchase', '2026-10-05'], [seq0 + 2, r2.call_id, 'explain_min_point', '2026-10-06'], [seq0 + 3, r1.call_id, 'check_purchase', '2026-10-08'],
  ]);
  assert.deepEqual(call_day_port(journal), { [r1.call_id]: '2026-10-08', [r2.call_id]: '2026-10-06' }, 'день — последней записи вызова');
  assert.equal(last_call_hex(journal), r1.call_id);
  assert.equal(last_call_hex(base), null);
  assert.deepEqual(call_day_port(base), {});
  // откат записи убирает её из действующих
  const rev = make_event('revert', { target: 'c~3' }, { event_id: 'c~rev', seq: seq0 + 4, recorded_at: '2026-10-09T00:00:00Z', entity_id: 'c~3' });
  assert.deepEqual(call_entries([...journal, rev]).map((x) => x.seq), [seq0 + 1, seq0 + 2]);
  assert.equal(last_call_hex([...journal, rev]), r2.call_id);
  // испорченные записи чужого файла: лишнее поле, неверный хэш, момент не в формате — пропускаются, а не ломают порт
  const alien = (n, payload, at = '2026-10-07T00:00:00Z') => make_event(CALL_EVENT_TYPE, payload, { event_id: 'alien~' + n, seq: seq0 + 10 + n, recorded_at: at, actor: 'assistant:x', entity_id: 'alien' + n });
  const hostile = [
    alien(1, { ...call_record(r1, TV1), question: 'сколько у меня денег' }),
    alien(2, { ...call_record(r1, TV1), tool: '=HYPERLINK("http://x")' }),
    alien(3, { ...call_record(r1, TV1), args_hash: 'не хэш' }),
    alien(4, { note: 'только текст' }),
  ];
  assert.equal(call_entries([...journal, ...hostile]).length, 3, 'чужие испорченные записи пропущены');
  assert.deepEqual(call_entries(null), []);
  assert.deepEqual(call_entries('не журнал'), []);
  // порт, последний вызов и CSV строятся и из готовых записей — те же значения без повторного разбора журнала
  assert.deepEqual(day_port_of(all), call_day_port(journal));
  assert.equal(last_hex_of(all), last_call_hex(journal));
  assert.equal(last_hex_of([]), null);
  assert.equal(calls_csv(all), export_calls_csv(journal));
  // журнал из десятков тысяч чужих записей не разбирается целиком: берутся записи вызовов и откаты
  const big = [...base, ...Array.from({ length: 3000 }, (_, i) => make_event('plan.set', { plan_id: 'P-' + i, account_id: 'acc_main', name: 'x', date: '2026-11-20', amount_minor: -1, currency: 'EUR', kind: 'expense', tag: 't', is_obligation: false, is_estimate: false }, { event_id: 'bulk~' + i, seq: seq0 + 100 + i, recorded_at: '2026-10-05T00:00:00Z', entity_id: 'P-' + i })), e1];
  assert.equal(call_entries(big).length, 1, 'вызовы находятся среди тысяч прочих записей');
});

test('REQ-136 порт call_log для what_changed: since = c_<hex> берёт день записи вызова; изменения после него видны, записи assistant.call изменением данных не считаются', () => {
  const r1 = mk().call('check_purchase', TV1);
  const base = ws_to_events(G); // все записи набора — 2026-10-04T00:00:00Z
  const seq0 = base.at(-1).seq;
  const e_call = call_event(call_record(r1, TV1), { event_id: 'c~1', seq: seq0 + 1, recorded_at: '2026-10-04T12:00:00Z' });
  const later_plan = make_event('plan.set', { plan_id: 'P-NEW', account_id: 'acc_main', name: 'Новый', date: '2026-11-20', amount_minor: -10000, currency: 'EUR', kind: 'expense', tag: 'новое', is_obligation: false, is_estimate: false },
    { event_id: 'c~2', seq: seq0 + 2, recorded_at: '2026-10-06T09:00:00Z', entity_id: 'P-NEW' });
  const another_call = call_event(call_record(r1, TV1), { event_id: 'c~3', seq: seq0 + 3, recorded_at: '2026-10-06T10:00:00Z' });
  const journal = [...base, e_call, later_plan];
  const ctx = mk(G, { journal, call_log: call_day_port(journal) }).ctx;
  ctx.calls_used = 0;
  const r = run_tool('what_changed', { since: call_ref(r1.call_id) }, ctx);
  assert.equal(r.isError, undefined, JSON.stringify(r));
  assert.deepEqual(r.facts.changes, [{ kind: 'plan', entity_id: 'P-NEW' }], 'после дня вызова (2026-10-04) — только плановая запись; сам вызов изменением данных не считается');
  assert.equal(r.facts.since, null, 'для c_… даты в facts нет');
  // вызов, которого в журнале нет, — ошибка схемы, не пустой ответ
  ctx.calls_used = 0;
  const unknown = run_tool('what_changed', { since: 'c_deadbeef' }, ctx);
  assert.deepEqual([unknown.isError, unknown.code], [true, 'E_SCHEMA']);
  // повторный вызов в тот же день, что и изменение, сдвигает основание сравнения
  const journal2 = [...journal, another_call];
  const ctx2 = mk(G, { journal: journal2, call_log: call_day_port(journal2) }).ctx;
  ctx2.calls_used = 0;
  const r2 = run_tool('what_changed', { since: call_ref(r1.call_id) }, ctx2);
  assert.deepEqual(r2.facts.changes, [], 'последний раз вызов был 2026-10-06: плановая запись того же дня уже учтена');
});

// ── «что изменилось»: представление журнала страницы (исправление FP-20: ложные числа, правки того же дня) ──────────────────────

const plan_ev = (id, n, at) => make_event('plan.set', { plan_id: id, account_id: 'acc_main', name: 'Правка ' + id, date: '2026-11-20', amount_minor: -10000, currency: 'EUR', kind: 'expense', tag: 'новое', is_obligation: false, is_estimate: false },
  { event_id: 'v~' + n, seq: n, recorded_at: at, entity_id: id });

/** Журнал страницы: снимок набора (40 записей, 4 октября 00:00:00Z), правка P-A в 10:00, вызов в 10:05, правка P-B в 11:00 — всё 4 октября. */
function page_events() {
  const base = ws_to_events(G);
  const n = base.at(-1).seq;
  const r1 = mk().call('check_purchase', TV1);
  return {
    base, n, r1,
    events: [...base, plan_ev('P-A', n + 1, '2026-10-04T10:00:00Z'),
      call_event(call_record(r1, TV1), { event_id: 'v~call', seq: n + 2, recorded_at: '2026-10-04T10:05:00Z' }), plan_ev('P-B', n + 3, '2026-10-04T11:00:00Z')],
  };
}

/** Значение факта: ссылка вида `e3` раскрывается в число или дату из evidence результата. */
const fact = (r, key) => { const x = r.facts[key]; return typeof x === 'string' && /^e\d+$/.test(x) ? r.evidence.find((e) => e.id === x).v : x; };

/** Что отвечает инструмент what_changed на представлении журнала. */
function changed_on(view, since) {
  const ctx = mk(G, { journal: view.journal, call_log: view.call_log }).ctx;
  ctx.calls_used = 0;
  const r = run_tool('what_changed', { since }, ctx);
  assert.equal(r.isError, undefined, JSON.stringify(r));
  return r;
}

test('FP-20 исправление: history_start_of — первый день журнала; журнал без записей и не журнал — null; записи без допустимого момента не считаются', () => {
  const { events } = page_events();
  assert.equal(CL.history_start_of(events), '2026-10-04');
  assert.equal(CL.history_start_of([]), null);
  assert.equal(CL.history_start_of('не журнал'), null);
  assert.equal(CL.history_start_of([{ recorded_at: 'вчера' }, null, { recorded_at: 5 }]), null);
  assert.equal(CL.history_start_of([...events, plan_ev('P-OLD', 900, '2026-09-30T23:59:59Z')]), '2026-09-30', 'правка с более ранним моментом сдвигает начало журнала');
});

test('FP-20 исправление (high): основание раньше начала журнала — отказ no_history с первым днём журнала; прежний ответ «изменено 40 записей, был 0,00 €» был пустым состоянием до начала журнала', () => {
  const { events, n } = page_events();
  assert.deepEqual(CL.changes_view(events, '2026-10-01'), { ok: false, reason: 'no_history', history_start: '2026-10-04' });
  assert.deepEqual(CL.changes_view(events, '2026-10-03'), { ok: false, reason: 'no_history', history_start: '2026-10-04' });
  assert.equal(CL.changes_view(events, '2026-10-04').ok, true, 'первый день журнала — допустимое основание');
  // без представления инструмент отвечает именно этим артефактом: весь снимок «изменён», минимум «был» пустым
  const raw = mk(G, { journal: events, call_log: {} }).ctx;
  raw.calls_used = 0;
  const bad = run_tool('what_changed', { since: '2026-10-01' }, raw);
  assert.equal(bad.facts.changes.length >= n - 5, true, 'сырой журнал: ' + bad.facts.changes.length + ' «изменений» — весь снимок набора');
  assert.throws(() => CL.changes_view('не журнал', '2026-10-04'), (e) => e.code === 'E_SCHEMA');
});

test('FP-20 исправление (high): снимок открытия никогда не считается изменением — «с 4 октября» видит только правки, а не записи набора; снимок с будущим моментом (часы страницы отстают от as_of) тоже', () => {
  const { events } = page_events();
  const view = CL.changes_view(events, '2026-10-04');
  const r = changed_on(view, '2026-10-04');
  assert.deepEqual(r.facts.changes, [{ kind: 'plan', entity_id: 'P-A' }, { kind: 'plan', entity_id: 'P-B' }], 'только две правки; записи снимка и вызов assistant.call изменениями не названы');
  assert.equal(fact(r, 'since'), '2026-10-04');
  // день расчёта в будущем относительно часов страницы: снимок записан «позже» правок, но остаётся снимком
  const future = ws_to_events(G, { recorded_at: '2027-01-01T00:00:00Z' });
  const j2 = [...future, plan_ev('P-C', future.length + 1, '2026-10-10T10:00:00Z')];
  assert.equal(CL.history_start_of(j2), '2026-10-10');
  assert.equal(CL.changes_view(j2, '2026-10-09').reason, 'no_history');
  assert.deepEqual(changed_on(CL.changes_view(j2, '2026-10-10'), '2026-10-10').facts.changes, [{ kind: 'plan', entity_id: 'P-C' }]);
});

test('FP-20 исправление (medium): «с даты» означает «с начала дня» — правки самого дня основания видны; дата после всех записей даёт пустой список', () => {
  const { events } = page_events();
  // 4 октября: обе правки (10:00 и 11:00) — после начала дня
  assert.equal(fact(changed_on(CL.changes_view(events, '2026-10-04'), '2026-10-04'), 'changes_count'), 2);
  // 5 октября — после всех записей: изменений нет, а не «весь набор»
  const later = CL.changes_view(events, '2026-10-05');
  assert.equal(later.ok, true);
  const r = changed_on(later, '2026-10-05');
  assert.deepEqual(r.facts.changes, []);
  assert.equal(fact(r, 'min_before'), fact(r, 'min_after'));
});

test('FP-20 исправление (medium): «с прошлого раза» считается по порядку записей, а не по дню: правка после вызова в тот же день видна, правка до вызова — нет, сам вызов — не изменение', () => {
  const { events, r1 } = page_events();
  const ref = call_ref(r1.call_id);
  const view = CL.changes_view(events, ref);
  assert.equal(view.ok, true);
  assert.equal(Object.keys(view.call_log).length, 1);
  const r = changed_on(view, ref);
  assert.deepEqual(r.facts.changes, [{ kind: 'plan', entity_id: 'P-B' }], 'P-A записана до вызова (10:00 < 10:05), P-B — после (11:00)');
  assert.equal(r.facts.since, null, 'для c_… даты в facts нет');
  // два вызова подряд: основание — последняя запись с этим номером
  const second = call_event(call_record(r1, TV1), { event_id: 'v~call2', seq: events.at(-1).seq + 1, recorded_at: '2026-10-04T12:00:00Z' });
  const j2 = [...events, second];
  assert.deepEqual(changed_on(CL.changes_view(j2, ref), ref).facts.changes, [], 'после второго вызова изменений нет');
  // вызова нет в журнале — журнал отдаётся как есть, ответ инструмента: ошибка схемы, не пустой список
  const unknown = CL.changes_view(events, 'c_deadbeef');
  assert.deepEqual([unknown.ok, unknown.journal === events, unknown.call_log], [true, true, {}]);
  const ctx = mk(G, { journal: unknown.journal, call_log: unknown.call_log }).ctx;
  ctx.calls_used = 0;
  assert.deepEqual([run_tool('what_changed', { since: 'c_deadbeef' }, ctx).isError], [true]);
  // не дата и не номер вызова — журнал как есть (инструмент сам отвергнет основание)
  assert.equal(CL.changes_view(events, 'вчера').journal, events);
});

test('FP-20 исправление: представление — копии записей с условными моментами; исходный журнал, event_id, seq и содержимое не меняются; записи без момента остаются как были', () => {
  const { events } = page_events();
  const odd = { event_id: 'odd~1', seq: 9999, type: 'plan.set', recorded_at: 'неизвестно', payload: {} };
  const before = JSON.stringify(events);
  const view = CL.changes_view([...events, odd], '2026-10-04');
  assert.equal(JSON.stringify(events), before, 'исходные записи не тронуты');
  assert.equal(view.journal.length, events.length + 1);
  view.journal.slice(0, events.length).forEach((e, i) => {
    assert.deepEqual([e.event_id, e.seq, e.type, e.payload], [events[i].event_id, events[i].seq, events[i].type, events[i].payload]);
    assert.notEqual(e, events[i], 'копия, не та же запись');
    assert.ok(['0001-01-01T00:00:00Z', '9999-12-31T00:00:00Z'].includes(e.recorded_at));
  });
  assert.equal(view.journal.at(-1), odd, 'запись без допустимого момента отдаётся как есть — инструмент сам сообщит об ошибке');
});

// ── CSV ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-136 export_calls_csv: колонки seq, recorded_at, call_id, tool, args_hash, inputs_hash, engine_version; только хэши и метки; формульные символы нейтрализуются csv_safe_cell', () => {
  assert.deepEqual(CALL_CSV_COLUMNS, ['seq', 'recorded_at', 'call_id', 'tool', 'args_hash', 'inputs_hash', 'engine_version']);
  const m = mk();
  const r1 = m.call('check_purchase', TV1);
  const r2 = m.call('get_tax_envelope', {});
  const base = ws_to_events(G);
  const seq0 = base.at(-1).seq;
  const journal = [...base,
    call_event(call_record(r1, TV1), { event_id: 'c~1', seq: seq0 + 1, recorded_at: '2026-10-05T08:00:00Z' }),
    call_event(call_record(r2, {}), { event_id: 'c~2', seq: seq0 + 2, recorded_at: '2026-10-05T08:01:00Z' }),
  ];
  const csv = export_calls_csv(journal);
  const lines = csv.split('\n');
  assert.equal(lines.at(-1), '', 'файл заканчивается переводом строки LF');
  assert.equal(lines[0], CALL_CSV_COLUMNS.join(','));
  assert.equal(lines.length, 4);
  const cells = lines[1].split(',');
  assert.equal(cells.length, 7);
  assert.deepEqual(cells, [String(seq0 + 1), '2026-10-05T08:00:00Z', r1.call_id, 'check_purchase', sha(TV1_CANON), r1.inputs_hash, '0.1.0']);
  assert.deepEqual(lines[2].split(',').slice(2, 4), [r2.call_id, 'get_tax_envelope']);
  for (const raw of ['30000', '2026-10-12', 'EUR', 'amount_minor']) assert.ok(!csv.includes(raw), `в CSV нет «${raw}»`);
  // чужой журнал с текстом в полях: такие записи в файл не попадают вовсе
  const alien = make_event(CALL_EVENT_TYPE, { ...call_record(r1, TV1), tool: '=HYPERLINK("http://evil")', question: 'вопрос' },
    { event_id: 'alien~1', seq: seq0 + 5, recorded_at: '2026-10-05T09:00:00Z', actor: 'assistant:x', entity_id: 'alien' });
  const csv2 = export_calls_csv([...journal, alien]);
  assert.equal(csv2, csv, 'испорченная запись не меняет файл');
  assert.ok(!csv2.includes('HYPERLINK') && !csv2.includes('вопрос'));
  // журнал без вызовов — только заголовок
  assert.equal(export_calls_csv(base), CALL_CSV_COLUMNS.join(',') + '\n');
  assert.equal(export_calls_csv([]), CALL_CSV_COLUMNS.join(',') + '\n');
  // защита от формул стоит в коде модуля: ячейки проходят csv_safe_cell из io.mjs
  assert.match(SRC, /import \{ csv_safe_cell \} from '\.\/io\.mjs'/);
  assert.match(SRC, /csv_safe_cell\(x\[c\]\)/);
});

// ── чистота и границы пакета ─────────────────────────────────────────────────────────────────────────────────────────

test('модуль call_log.mjs чистый и не расширяет ядро: нет часов, случайности, ввода-вывода; не реэкспортируется из index.mjs; повтора по call_id нет', () => {
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const bad of ['Date', 'Math.random', 'fetch(', 'localStorage', 'setTimeout', 'process.', 'node:', 'Intl']) assert.ok(!code.includes(bad), `call_log.mjs: ${bad}`);
  const index_src = fs.readFileSync(new URL('../engine/index.mjs', import.meta.url), 'utf8');
  assert.ok(!/call_log/.test(index_src), 'index.mjs модуль не реэкспортирует');
  assert.deepEqual(Object.keys(CL).filter((k) => /replay|repeat|rerun/i.test(k)), [], 'повтора расчёта по call_id в пакете нет (решение FP-34)');
});
