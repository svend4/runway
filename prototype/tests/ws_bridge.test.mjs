// ws_bridge.test.mjs — мост «рабочая область ↔ журнал» (FP-01): TST-38 (REQ-094: круг ws → журнал → ws без потерь, тот же inputs_hash и те же числа
// на g001, g001-low, g001-gap, g001-late), REQ-012 (журнал следует за правками рабочей области: новое — set, изменённое — замена, удалённое — откат),
// REQ-017 (безопасность формы: повтор идентификатора, ключи-«ловушки», float). Тесты — в Node, без DOM.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze, canon, state_hash, reduce, effective_events } from '../engine/index.mjs';
import { export_json, import_json } from '../engine/io.mjs';
import { ws_to_events, events_to_ws, state_to_ws, ws_to_state, ws_to_journal, journal_to_ws, diff_ws_to_specs, sync_journal, META_ID, BUCKETS } from '../demo/ws_bridge.mjs';
import { create_journal, ports_from_gen } from '../demo/journal_log.mjs';
import { make_id_gen, seeded_ports } from '../demo/ids.mjs';
import { apply_edit } from '../demo/ws_edit.mjs';
import { make_rng, throws_code } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(fs.readFileSync(path.join(HERE, '..', 'data', name), 'utf8'));
const SETS = { g001: load('g001.json'), 'g001-low': load('g001-low.json'), 'g001-gap': load('g001-gap.json'), 'g001-late': load('g001-late.json') };

/** Рабочая область в порядко-независимом виде: массивы отсортированы по каноническому JSON элементов. */
function sorted_ws(ws) {
  const out = {};
  for (const k of Object.keys(ws).sort()) {
    const v = ws[k];
    out[k] = Array.isArray(v) ? v.flat().map((x) => canon(x)).sort() : v;
  }
  return canon(out);
}

/** Числа, по которым сравниваем расчёты: ряды, Q1, волны, предупреждения, готовность, хэш входов. */
function numbers_of(ws) {
  const a = analyze(ws, { as_of: ws.as_of });
  return canon(JSON.parse(JSON.stringify({
    h: a.inputs_hash, s: a.series, q1: a.q1, w: a.warnings, r: a.readiness, st: a.anchor_status, p: a.params, ev: a.events,
  }, (_k, v) => (typeof v === 'bigint' ? String(v) : v))));
}

// ── TST-38 REQ-094: круг ws → журнал → ws ────────────────────────────────────────────────────────────────────────────

for (const [name, ws] of Object.entries(SETS)) {
  test(`TST-38 REQ-094 ${name}: ws → журнал → ws → analyze даёт тот же inputs_hash и те же числа`, () => {
    const events = ws_to_events(ws);
    assert.ok(events.length > 40, 'записей: ' + events.length);
    assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1), 'seq монотонен с 1');
    const ws2 = events_to_ws(events);
    const a1 = analyze(ws, { as_of: ws.as_of });
    const a2 = analyze(ws2, { as_of: ws2.as_of });
    assert.equal(a2.inputs_hash, a1.inputs_hash, 'inputs_hash совпадает');
    assert.equal(numbers_of(ws2), numbers_of(ws), 'ряды, Q1, предупреждения и события совпадают');
    assert.equal(sorted_ws(ws2), sorted_ws(ws), 'рабочая область совпадает с точностью до порядка элементов');
    // порядок элементов тоже сохраняется (в наборах G-001 идентификаторы не «числоподобные»)
    for (const b of BUCKETS) if (ws[b.ws_key] !== undefined && ws[b.ws_key].length > 0) assert.deepEqual(ws2[b.ws_key], ws[b.ws_key], 'корзина ' + b.ws_key);
    assert.deepEqual(ws2.params, ws.params);
    for (const k of ['workspace_id', 'name', 'locale', 'decision_currency', 'format', 'as_of']) assert.equal(ws2[k], ws[k], k);
  });

  test(`TST-38 REQ-094 ${name}: файл-копия runway-journal/1 — экспорт и импорт возвращают тот же state_hash и ту же рабочую область`, () => {
    const text = ws_to_journal(ws, { engine_version: 'test' });
    assert.equal(JSON.parse(text).format, 'runway-journal/1');
    const state = import_json(text);
    assert.equal(state_hash(state), state_hash(ws_to_state(ws)), 'state_hash(import(export(ws))) = state_hash(ws)');
    const ws2 = journal_to_ws(text);
    assert.equal(numbers_of(ws2), numbers_of(ws));
    // повторный круг — неподвижная точка: те же записи, тот же файл
    assert.equal(ws_to_journal(ws2, { engine_version: 'test' }), text, 'ws → журнал → ws → журнал: побайтно тот же файл');
    assert.equal(canon(ws_to_events(ws2)), canon(ws_to_events(ws)));
  });
}

test('TST-38 REQ-094: G-001 после круга — opening 400000 и end_close 340000 (числа канона)', () => {
  const ws2 = events_to_ws(ws_to_events(SETS.g001));
  const a = analyze(ws2, { as_of: '2026-10-04' });
  assert.equal(a.series.plan.opening_minor, 400000);
  assert.equal(a.series.plan.close.at(-1), 340000);
});

test('TST-38 REQ-094: все корзины сразу — курсы, долги, контрагенты, правки волн и поправки правил; элемент без идентификатора не получает чужого id', () => {
  const ws = JSON.parse(JSON.stringify(SETS.g001));
  ws.rates = [{ fx_id: 'fx-1', date: '2026-10-01', base: 'USD', quote: 'EUR', num: 9250, den: 10000, source: 'manual' }, { date: '2026-10-02', base: 'GBP', quote: 'EUR', num: 11500, den: 10000 }];
  ws.counterparties = [{ counterparty_id: 'cp-1', name: 'Клиент', usual_delay_days: 3 }];
  ws.wave_overrides = [{ override_id: 'w1', action: 'pin', event_ids: ['R-RENT@2026-10-25'] }, { action: 'split', event_ids: ['R-UTIL@2026-10-25'] }];
  ws.overrides = [{ rule_id: 'R-PHONE', nominal_date: '2026-11-09', action: 'skip' }];
  ws.profiles = [{ profile_id: 'bank-x', v: 1 }];
  ws.extra_field = { любой: ['ключ', 1, null] }; // прочие поля верхнего уровня хранятся в метаданных
  ws.tax_rules = [...ws.tax_rules, { ...ws.tax_rules[0], version: 2, valid_from: '2026-12-01' }];
  const ws2 = events_to_ws(ws_to_events(ws));
  assert.equal(sorted_ws(ws2), sorted_ws(ws));
  assert.deepEqual(ws2.rates[1], ws.rates[1], 'курс без fx_id возвращается без служебного идентификатора');
  assert.deepEqual(ws2.wave_overrides[1], ws.wave_overrides[1], 'правка волны без override_id — тоже');
  assert.deepEqual(ws2.wave_overrides.map((o) => o.action), ['pin', 'split'], 'порядок правок волн сохраняется');
  assert.deepEqual(ws2.extra_field, ws.extra_field);
  assert.equal(ws2.tax_rules.length, 2, 'обе версии налогового правила');
});

test('REQ-094: метаданные журнала — одна запись profile.set «ws:meta»; параметры — одна запись params.set; факты возвращаются со своими идентификаторами', () => {
  const events = ws_to_events(SETS.g001);
  assert.equal(events[0].type, 'profile.set');
  assert.equal(events[0].payload.profile_id, META_ID);
  assert.equal(events.filter((e) => e.type === 'params.set').length, 1);
  const facts = events.filter((e) => e.type === 'tx.posted');
  assert.equal(facts.length, SETS.g001.facts.length);
  assert.deepEqual(facts.map((e) => e.entity_id), SETS.g001.facts.map((f) => f.event_id));
  assert.equal(new Set(events.map((e) => e.event_id)).size, events.length, 'event_id уникальны');
  // base важнее журнальных метаданных (например, «сегодня»)
  const ws2 = events_to_ws(events, { as_of: '2026-10-05' });
  assert.equal(ws2.as_of, '2026-10-05');
});

test('REQ-017 REQ-094: плохая рабочая область отвергается кодами: повтор идентификатора, ключи-«ловушки», float, не-массив', () => {
  const dup = JSON.parse(JSON.stringify(SETS.g001));
  dup.rules.push({ ...dup.rules[0] });
  throws_code(() => ws_to_events(dup), 'E_SCHEMA', 'повтор rule_id');
  const proto = JSON.parse('{"as_of":"2026-10-04","params":{"__proto__":{"x":1}},"accounts":[],"facts":[]}');
  throws_code(() => ws_to_events(proto), 'E_SCHEMA', 'ключ __proto__ в параметрах');
  const ctor = JSON.parse('{"as_of":"2026-10-04","accounts":[{"account_id":"a","constructor":{"x":1}}]}');
  throws_code(() => ws_to_events(ctor), 'E_SCHEMA', 'ключ constructor');
  const flt = JSON.parse(JSON.stringify(SETS.g001));
  flt.facts[0].amount_minor = 1.5;
  throws_code(() => ws_to_events(flt), 'E_NOT_INTEGER');
  throws_code(() => ws_to_events({ as_of: '2026-10-04', accounts: {} }), 'E_SCHEMA');
  throws_code(() => ws_to_events(null), 'E_SCHEMA');
  const noid = JSON.parse(JSON.stringify(SETS.g001));
  noid.overrides = [{ nominal_date: '2026-11-09' }];
  throws_code(() => ws_to_events(noid), 'E_SCHEMA', 'у правки правила нет ключа');
});

test('REQ-094: порты — идентификаторы и время ввода приходят снаружи; без портов результат детерминирован', () => {
  const gen = make_id_gen(seeded_ports({ seed: 5 }));
  const evs = ws_to_events(SETS.g001, { next_id: gen.next, recorded_at: gen.instant });
  assert.match(evs[3].event_id, /^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  assert.equal(canon(ws_to_events(SETS.g001)), canon(ws_to_events(SETS.g001)));
  assert.equal(ws_to_events(SETS.g001)[0].recorded_at, '2026-10-04T00:00:00Z');
  assert.equal(ws_to_events(SETS.g001, { start_seq: 10 })[0].seq, 10);
  assert.equal(canon(events_to_ws(evs)), canon(events_to_ws(ws_to_events(SETS.g001))), 'свёртка не зависит от идентификаторов записей');
});

// ── журнал следует за рабочей областью ───────────────────────────────────────────────────────────────────────────────

function fresh_journal(ws, seed = 1) {
  const gen = make_id_gen(seeded_ports({ seed }));
  return create_journal({ events: ws_to_events(ws), ports: ports_from_gen(gen), snapshot_every: 25 });
}

test('REQ-012 sync: добавление, замена и удаление — set / supersedes / revert; журнал сворачивается обратно в ту же рабочую область', () => {
  let ws = SETS.g001;
  const j = fresh_journal(ws);
  const n0 = j.length;
  const step = (edit) => {
    const r = apply_edit(ws, edit);
    assert.equal(r.ok, true, JSON.stringify(r.error));
    const added = sync_journal(j, ws, r.ws);
    ws = r.ws;
    return added;
  };
  const a1 = step({ type: 'add_fact', fact: { event_id: 'tx-new-1', account_id: 'acc_main', date: '2026-10-03', amount_minor: -1234, tag: 'кофе' } });
  assert.deepEqual(a1.map((e) => e.type), ['tx.posted']);
  assert.equal(a1[0].entity_id, 'tx-new-1');
  const a2 = step({ type: 'upsert_rule', rule: { ...ws.rules.find((r) => r.rule_id === 'R-PHONE'), amount: { exp_minor: -2700 } } });
  assert.deepEqual(a2.map((e) => e.type), ['rule.set']);
  assert.ok(typeof a2[0].supersedes_id === 'string', 'исправление — запись с supersedes_id, а не перезапись');
  const a3 = step({ type: 'void_fact', event_id: 'tx-new-1' });
  assert.deepEqual(a3.map((e) => e.type), ['revert']);
  const a4 = step({ type: 'set_param', key: 'buffer_minor', value: 70000 });
  assert.deepEqual(a4.map((e) => e.type), ['params.set']);
  assert.deepEqual(a4[0].payload, { buffer_minor: 70000 });
  assert.equal(j.length, n0 + 4);
  assert.equal(sorted_ws(events_to_ws(j.events())), sorted_ws(ws));
  assert.equal(analyze(events_to_ws(j.events()), { as_of: ws.as_of }).inputs_hash, analyze(ws, { as_of: ws.as_of }).inputs_hash);
  assert.deepEqual(sync_journal(j, ws, ws), [], 'ничего не изменилось — ничего не пишем');
  // состояние журнала по «снимок + хвост» то же, что полная свёртка
  assert.equal(j.state_hash(), state_hash(reduce(effective_events(j.events()))));
});

test('REQ-012 sync: на 120 случайных последовательностях правок журнал и рабочая область остаются равны (inputs_hash, порядко-независимо)', () => {
  const rng = make_rng(2026);
  let applied = 0;
  let tried = 0;
  for (let t = 0; t < 120; t++) {
    let ws = SETS[rng.pick(Object.keys(SETS))];
    const j = fresh_journal(ws, t + 1);
    const steps = rng.int(3, 14);
    for (let i = 0; i < steps; i++) {
      const edit = random_edit(rng, ws, `${t}-${i}`);
      tried += 1;
      const r = apply_edit(ws, edit);
      if (!r.ok) continue;
      applied += 1;
      sync_journal(j, ws, r.ws);
      ws = r.ws;
    }
    const back = events_to_ws(j.events());
    assert.equal(sorted_ws(back), sorted_ws(ws), 'последовательность #' + t);
    if (t % 6 === 0) assert.equal(analyze(back, { as_of: back.as_of }).inputs_hash, analyze(ws, { as_of: ws.as_of }).inputs_hash, 'inputs_hash #' + t);
    assert.equal(j.state_hash(), state_hash(reduce(effective_events(j.events()))), 'снимок + хвост = полная свёртка, #' + t);
  }
  assert.ok(applied / tried > 0.7, `доля принятых правок ${applied}/${tried}`);
});

test('REQ-012 sync: журнал, не знающий откатываемой записи, сообщает journal_out_of_sync (пересобрать из рабочей области)', () => {
  const ws = SETS.g001;
  const empty = create_journal({ ports: ports_from_gen(make_id_gen(seeded_ports())) });
  const r = apply_edit(ws, { type: 'delete_rule', rule_id: 'R-PHONE' });
  assert.equal(r.ok, true);
  assert.throws(() => diff_ws_to_specs(ws, r.ws, empty.events()), (e) => e.code === 'E_SCHEMA' && e.ctx.reason === 'journal_out_of_sync');
});

test('REQ-094: state_to_ws не возвращает служебных ключей состояния (seq правок волн, entity_id фактов, ws:meta)', () => {
  const ws = JSON.parse(JSON.stringify(SETS.g001));
  ws.wave_overrides = [{ override_id: 'w1', action: 'pin', event_ids: ['x'] }];
  const state = reduce(effective_events(ws_to_events(ws)));
  assert.equal(state.wave_overrides[0].seq > 0, true);
  const back = state_to_ws(state);
  assert.equal(back.wave_overrides[0].seq, undefined);
  assert.equal(back.facts[0].entity_id, undefined);
  assert.equal(back.profiles, undefined);
  assert.ok(!JSON.stringify(back).includes(META_ID));
});

// ── генератор правок для свойств ─────────────────────────────────────────────────────────────────────────────────────

function random_edit(rng, ws, tag) {
  const day = (lo, hi) => {
    const d = rng.int(lo, hi);
    return '2026-09-' + String(d).padStart(2, '0');
  };
  const kind = rng.int(0, 15);
  const facts = ws.facts ?? [];
  switch (kind) {
    case 0: case 1: case 2:
      return { type: 'add_fact', fact: { event_id: `tx-r-${tag}`, account_id: 'acc_main', date: day(1, 30), amount_minor: rng.pick([-1, 1]) * rng.int(100, 9000), tag: rng.pick(['еда', 'такси', '=cmd', 'кофе']) } };
    case 3:
      return facts.length === 0 ? { type: 'void_fact', event_id: 'нет' } : { type: 'void_fact', event_id: rng.pick(facts).event_id };
    case 4:
      return { type: 'set_anchor', anchor: { anchor_id: `anc-r-${tag}`, account_id: 'acc_main', date: day(1, 30), amount_minor: rng.int(50000, 500000) } };
    case 5:
      return { type: 'set_param', key: rng.pick(['buffer_minor', 'horizon_days', 'match.tol_bp', 'worse.income_delay_days']), value: rng.int(1, 90) };
    case 6:
      return { type: 'upsert_rule', rule: { rule_id: `R-X-${tag}`, account_id: 'acc_main', name: 'Подписка', kind: 'expense', amount: { exp_minor: -rng.int(500, 5000) }, freq: 'M', interval: 1, by_monthday: [rng.int(1, 28)], start_date: '2026-01-05', month_end: 'clamp', weekend: 'next', calendar_id: 'cal-main', exdates: [], is_obligation: rng.bool(), is_estimate: false, tag: 'подписка' } };
    case 7: {
      const r = rng.pick(ws.rules ?? []);
      return r === undefined ? { type: 'delete_rule', rule_id: 'нет' } : { type: 'upsert_rule', rule: { ...r, amount: { exp_minor: r.kind === 'income' ? rng.int(1000, 9000) : -rng.int(1000, 9000) } } };
    }
    case 8: {
      const r = rng.pick(ws.rules ?? []);
      return r === undefined ? { type: 'delete_rule', rule_id: 'нет' } : { type: 'delete_rule', rule_id: r.rule_id };
    }
    case 9:
      return { type: 'upsert_fx_rate', rate: { date: day(1, 30), base: 'USD', quote: 'EUR', num: rng.int(8000, 11000), den: 10000 } };
    case 10:
      return { type: 'add_purchase', purchase: { purchase_id: `pur-r-${tag}`, name: 'Покупка', currency: 'EUR', parts: [{ date: '2026-10-12', amount_minor: rng.int(1000, 90000) }] } };
    case 11:
      return { type: 'save_scenario', scenario: { scenario_id: `scn-r-${rng.int(1, 3)}`, name: 'Сценарий', ops: [{ op: 'delay_income', event_ref: 'S-HOURLY@2026-11-05', days: rng.int(1, 30) }] } };
    case 12: {
      const s = rng.pick(ws.scenarios ?? []);
      return s === undefined ? { type: 'delete_scenario', scenario_id: 'нет' } : { type: 'delete_scenario', scenario_id: s.scenario_id };
    }
    case 13:
      return { type: 'set_wave_override', override: { override_id: `wov-${rng.int(1, 3)}`, action: rng.pick(['split', 'pin']), event_ids: ['R-RENT@2026-10-26'] } };
    case 14:
      return { type: 'add_counterparty', counterparty: { counterparty_id: `cp-${rng.int(1, 4)}`, name: 'Клиент ' + rng.int(1, 9), usual_delay_days: rng.int(0, 10) } };
    default:
      return { type: 'upsert_reserve', reserve: { reserve_id: `RES-X-${rng.int(1, 2)}`, kind: 'sinking', name: 'Отпуск', currency: 'EUR', funded_start_minor: rng.int(0, 5000), funded_as_of: '2026-10-04', mode: 'fixed', fixed_minor: 1000, target_minor: 90000, due_date: '2027-03-01' } };
  }
}

test('REQ-094: экспорт журнала (export_json) читается обратно в ту же рабочую область (проверка io-пути без моста)', () => {
  const text = export_json(ws_to_events(SETS['g001-low']), { engine_version: 'test' });
  assert.equal(numbers_of(journal_to_ws(text)), numbers_of(SETS['g001-low']));
});
