// override_idempotent.test.mjs — FP-13 (волна 3а): перенос, своя сумма и пропуск ОДНОГО вхождения правила (REQ-010, REQ-032), идемпотентность записи и журнал. Без DOM и сети.
// Критерии: повторное применение того же set_occurrence_override не меняет canon(ws.overrides) и inputs_hash; при двойном ws_to_events / sync_journal второй записи нет;
// у вхождения есть «перенести на дату» и «изменить сумму» с предпросмотром через expand_all (серия не разрывается, ключ occ_key не меняется); «Отменить» возвращает прежнее состояние.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/override_idempotent.test.mjs. Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const imp = (rel) => import(pathToFileURL(path.join(PROTO, rel)).href);
const G = JSON.parse(fs.readFileSync(path.join(PROTO, 'data', 'g001.json'), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));

const E = await imp('engine/index.mjs');
const WE = await imp('demo/ws_edit.mjs');
const BR = await imp('demo/ws_bridge.mjs');
const JL = await imp('demo/journal_log.mjs');
const IDS = await imp('demo/ids.mjs');
const UNDO = await imp('demo/undo.mjs');
const RULE = await imp('demo/form_rule.mjs');

if (!WE.list_edit_types().includes('set_occurrence_override')) WE.register_edit('set_occurrence_override', RULE.edit_set_occurrence_override);

const ENV = { cur: 'EUR', lang: 'ru', nf: undefined, as_of: G.as_of };
const apply = (ws, edit) => WE.apply_edit(ws, edit, { new_id: (p) => `${p}_t1` });
const must = (r) => { assert.equal(r.ok, true, JSON.stringify(r.error)); return r.ws; };
const hash_of = (ws) => E.analyze(ws, { as_of: ws.as_of }).inputs_hash;
const no_echo = (r, typed) => assert.ok(!JSON.stringify(r).includes(typed), `введённый текст «${typed}» повторён в ошибке: ${JSON.stringify(r)}`);

const RENT = 'R-RENT';
const NOM = '2026-10-25'; // воскресенье: «на рабочий день позже» даёт понедельник 2026-10-26
const SKIP = RULE.skip_edit(RENT, NOM);
const MOVE = RULE.move_edit(RENT, NOM, '2026-10-28');
const AMOUNT = RULE.amount_edit(RENT, NOM, -95000);

function fresh_journal(ws, seed = 1) {
  const gen = IDS.make_id_gen(IDS.seeded_ports({ seed }));
  return JL.create_journal({ events: BR.ws_to_events(ws), ports: JL.ports_from_gen(gen), snapshot_every: 25 });
}

// ── идемпотентность записи ───────────────────────────────────────────────────────────────────────────────────────────

test('REQ-010 повторное применение того же set_occurrence_override не меняет canon(ws.overrides) и inputs_hash — для пропуска, переноса и своей суммы; запись остаётся одна', () => {
  for (const [label, edit] of [['skip', SKIP], ['move', MOVE], ['set_amount', AMOUNT]]) {
    const once = must(apply(G, edit));
    const twice = must(apply(once, edit));
    const thrice = must(apply(twice, edit));
    assert.equal(once.overrides.length, 1, label);
    assert.equal(E.canon(twice.overrides), E.canon(once.overrides), label + ': canon(ws.overrides)');
    assert.equal(E.canon(thrice), E.canon(once), label + ': вся рабочая область');
    assert.equal(hash_of(twice), hash_of(once), label + ': inputs_hash');
    assert.notEqual(hash_of(once), hash_of(G), label + ': правка меняет расчёт');
  }
  // повтор не переставляет записи: A, B, снова A — порядок A, B
  const rent2 = RULE.skip_edit('R-UTIL', NOM);
  const ab = must(apply(must(apply(G, SKIP)), rent2));
  const aba = must(apply(ab, SKIP));
  assert.deepEqual(aba.overrides.map((o) => o.rule_id), [RENT, 'R-UTIL']);
  assert.equal(E.canon(aba.overrides), E.canon(ab.overrides));
  assert.equal(hash_of(aba), hash_of(ab));
});

test('REQ-010 REQ-012 журнал: двойной ws_to_events даёт те же записи, повторный sync_journal второй записи не добавляет; изменение той же записи — запись с supersedes_id, снятие — revert цепочки', () => {
  const ws1 = must(apply(G, MOVE));
  assert.equal(E.canon(BR.ws_to_events(ws1)), E.canon(BR.ws_to_events(ws1)), 'ws_to_events детерминирован');
  const j = fresh_journal(G);
  const n0 = j.length;
  const a1 = BR.sync_journal(j, G, ws1);
  assert.deepEqual(a1.map((e) => e.type), ['override.set']);
  assert.deepEqual(a1[0].payload, { rule_id: RENT, nominal_date: NOM, action: 'move', date: '2026-10-28' });
  const ws2 = must(apply(ws1, MOVE));
  assert.deepEqual(BR.sync_journal(j, ws1, ws2), [], 'повтор — без второй записи');
  assert.deepEqual(BR.sync_journal(j, ws2, ws2), []);
  assert.equal(j.length, n0 + 1);
  const state0 = j.state_hash();
  assert.deepEqual(BR.sync_journal(j, ws2, must(apply(ws2, MOVE))), []);
  assert.equal(j.state_hash(), state0, 'состояние журнала не изменилось');
  // другая правка того же вхождения (своя сумма вместо переноса): ключ rule_id@nominal_date тот же — запись заменяется, а не добавляется
  const ws3 = must(apply(ws2, AMOUNT));
  assert.equal(ws3.overrides.length, 1, 'у вхождения одна правка: новая заменяет прежнюю');
  assert.deepEqual(ws3.overrides[0], { rule_id: RENT, nominal_date: NOM, action: 'set_amount', amount_minor: -95000 });
  const a3 = BR.sync_journal(j, ws2, ws3);
  assert.deepEqual(a3.map((e) => e.type), ['override.set']);
  assert.equal(typeof a3[0].supersedes_id, 'string');
  assert.equal(E.canon(BR.events_to_ws(j.events()).overrides), E.canon(ws3.overrides));
  // снятие: revert действующей записи и цепочки замен — вхождение снова идёт по правилу
  const ws4 = must(apply(ws3, RULE.restore_edit(RENT, NOM)));
  const a4 = BR.sync_journal(j, ws3, ws4);
  assert.ok(a4.length >= 1 && a4.every((e) => e.type === 'revert'));
  assert.deepEqual(BR.events_to_ws(j.events()).overrides, []);
  assert.equal(hash_of(BR.events_to_ws(j.events())), hash_of(G), 'числа вернулись');
  assert.equal(j.state_hash(), E.state_hash(E.reduce(E.effective_events(j.events()))));
});

// ── перенос и своя сумма: серия не разрывается ───────────────────────────────────────────────────────────────────────

test('REQ-010 перенос: дата точная (без сдвига по выходным), ключ occ_key и идентификатор события не меняются, соседние вхождения на месте; своя сумма снимает коридор только у этого вхождения', () => {
  const base = E.analyze(G, { as_of: G.as_of }).events.plan;
  const moved = E.analyze(must(apply(G, MOVE)), { as_of: G.as_of }).events.plan;
  const ev = (list, id) => list.find((e) => e.cash_event_id === id);
  assert.equal(E.format_date(ev(base, 'R-RENT@2026-10-25').date), '2026-10-26');
  assert.equal(E.format_date(ev(moved, 'R-RENT@2026-10-25').date), '2026-10-28', 'тот же идентификатор события, новая дата');
  assert.equal(ev(moved, 'R-RENT@2026-10-25').amount_minor, -90000, 'сумма прежняя');
  assert.equal(E.format_date(ev(moved, 'R-RENT@2026-11-25').date), E.format_date(ev(base, 'R-RENT@2026-11-25').date), 'следующее вхождение не затронуто');
  // перенос на выходной остаётся на выходном: дата задана точно
  const sat = E.analyze(must(apply(G, RULE.move_edit(RENT, NOM, '2026-10-31'))), { as_of: G.as_of }).events.plan;
  assert.equal(E.format_date(ev(sat, 'R-RENT@2026-10-25').date), '2026-10-31', 'суббота, сдвига нет');
  // своя сумма: коридор правила снимается у этого вхождения, у других остаётся
  const ws = clone(G);
  ws.rules.find((r) => r.rule_id === 'R-PHONE').amount = { exp_minor: -2500, min_minor: -3000, max_minor: -2000 };
  const edited = must(apply(ws, RULE.amount_edit('R-PHONE', '2026-10-09', -2700)));
  const occ = E.expand_all(edited.rules, { from: E.to_epoch_day('2026-10-01'), to: E.to_epoch_day('2026-12-31') }, edited.calendars, edited.overrides).filter((o) => o.rule_id === 'R-PHONE');
  assert.deepEqual(occ.map((o) => [o.occ_key, o.amount_minor, o.amount_min_minor, o.amount_max_minor, o.overridden]).slice(0, 2),
    [['R-PHONE@2026-10-09', -2700, undefined, undefined, true], ['R-PHONE@2026-11-09', -2500, -3000, -2000, false]]);
});

test('REQ-010 предпросмотр через expand_all: вхождение до и после, ближайшие даты после правки; далёкий перенос находится; отказ правки — код вместо предпросмотра', () => {
  const rule = G.rules.find((r) => r.rule_id === RENT);
  const before = RULE.occurrence_at(G, rule, NOM);
  assert.deepEqual(before, { nominal: NOM, date: '2026-10-26', amount_minor: -90000, currency: 'EUR', overridden: false });
  const p = RULE.override_preview(G, RENT, NOM, MOVE, { as_of: G.as_of });
  assert.equal(p.ok, true);
  assert.deepEqual([p.before.date, p.after.date, p.after.overridden], ['2026-10-26', '2026-10-28', true]);
  assert.deepEqual(p.rows.map((r) => r.date), ['2026-10-28', '2026-11-25', '2026-12-25'], 'серия: остальные вхождения по правилу');
  const far = RULE.override_preview(G, RENT, NOM, RULE.move_edit(RENT, NOM, '2027-04-20'), { as_of: G.as_of });
  assert.equal(far.after.date, '2027-04-20', 'перенос за пределы окна предпросмотра находится');
  const amount = RULE.override_preview(G, RENT, NOM, AMOUNT, { as_of: G.as_of });
  assert.deepEqual([amount.before.amount_minor, amount.after.amount_minor, amount.after.date], [-90000, -95000, '2026-10-26']);
  assert.deepEqual(amount.rows.map((r) => r.amount_minor), [-95000, -90000, -90000], 'своя сумма только у этого вхождения');
  const bad = RULE.override_preview(G, RENT, '2026-10-26', RULE.move_edit(RENT, '2026-10-26', '2026-10-28'), { as_of: G.as_of });
  assert.equal(bad.ok, false, 'номинальной даты 26-го у правила нет');
  assert.equal(bad.error.ctx.reason, 'not_an_occurrence');
  assert.equal(RULE.occurrence_at(G, rule, '2026-10-26'), null);
  assert.equal(RULE.occurrence_at(must(apply(G, SKIP)), rule, NOM), null, 'пропущенное вхождение в ряду не видно');
});

// ── разбор полей «Перенести» и «Другая сумма» ───────────────────────────────────────────────────────────────────────

test('REQ-010 REQ-017 «Перенести на дату» и «Другая сумма»: ISO и дата в формате интерфейса; сумма без знака — знак задаёт вид правила; отказы с кодом, введённое не повторяется', () => {
  const mv = (text, env = ENV) => RULE.build_move_edit(G, RENT, NOM, text, env);
  assert.deepEqual(mv('2026-10-28').edit, MOVE);
  assert.deepEqual(mv(' 28.10.2026 ').edit, MOVE, 'формат даты русского интерфейса');
  assert.deepEqual(mv('10/28/2026', { ...ENV, lang: 'en' }).edit, MOVE, 'формат даты английского интерфейса');
  assert.deepEqual(mv('2026-10-28', { ...ENV, nf: { date: 'dmy' } }).edit, MOVE, 'поле type="date" отдаёт ISO даже при формате ДД.ММ.ГГГГ');
  for (const [text, typed] of [['2026-02-30', '2026-02-30'], ['завтра', 'завтра'], ['', null], ['32.10.2026', '32.10.2026']]) {
    const r = mv(text);
    assert.equal(r.ok, false, text);
    assert.deepEqual([r.error.code, r.error.ctx.field], ['E_BAD_DATE', 'move_date']);
    if (typed !== null) no_echo(r, typed);
  }
  assert.equal(RULE.build_move_edit(G, 'нет', NOM, '2026-10-28', ENV).error.ctx.reason, 'unknown_rule');
  const am = (text, rule_id = RENT) => RULE.build_amount_edit(G, rule_id, NOM, text, ENV);
  assert.deepEqual(am('950').edit, AMOUNT, 'расход — отрицательная сумма');
  assert.equal(am('950,50').edit.override.amount_minor, -95050);
  const income = clone(G);
  income.rules.push({ ...clone(G.rules.find((r) => r.rule_id === RENT)), rule_id: 'R-INC', kind: 'income', amount: { exp_minor: 50000 } });
  assert.equal(RULE.build_amount_edit(income, 'R-INC', NOM, '500', ENV).edit.override.amount_minor, 50000, 'поступление — положительная');
  for (const [text, code] of [['abc', 'E_NOT_INTEGER'], ['', 'E_NOT_INTEGER'], ['0', 'E_SCHEMA'], ['950,555', 'E_NOT_INTEGER'], ['99999999999999999999', 'E_OVERFLOW']]) {
    const r = am(text);
    assert.equal(r.ok, false, text);
    assert.deepEqual([r.error.code, r.error.ctx.field], [code, 'amount'], text);
    if (text === 'abc' || text === '950,555') no_echo(r, text);
  }
  assert.equal(RULE.build_amount_edit(G, 'нет', NOM, '5', ENV).error.ctx.reason, 'unknown_rule');
});

test('REQ-010 REQ-017 вид правки: перенос слишком далеко и неверные поля отвергаются кодом; пропуск → перенос → своя сумма на одном вхождении — всегда одна запись', () => {
  const far = apply(G, RULE.move_edit(RENT, NOM, '2046-10-28'));
  assert.equal(far.ok, false);
  assert.deepEqual([far.error.code, far.error.ctx.reason], ['E_BAD_DATE', 'move_too_far']);
  assert.equal(apply(G, { type: 'set_occurrence_override', override: { rule_id: RENT, nominal_date: NOM, action: 'move' } }).ok, false, 'для move нужна дата');
  assert.equal(apply(G, RULE.amount_edit(RENT, NOM, 90000)).error.ctx.reason, 'override_sign', 'знак суммы расхода — отрицательный');
  assert.equal(apply(G, RULE.amount_edit(RENT, NOM, 0)).ok, false);
  assert.equal(apply(G, { type: 'set_occurrence_override', override: { rule_id: RENT, nominal_date: NOM, action: 'move', date: '2026-10-28', amount_minor: -1 } }).ok, true, 'лишнее поле суммы у move отбрасывается');
  let ws = G;
  for (const edit of [SKIP, MOVE, AMOUNT, MOVE, SKIP]) { ws = must(apply(ws, edit)); assert.equal(ws.overrides.length, 1); }
  assert.deepEqual(ws.overrides[0].action, 'skip');
  assert.ok(!E.analyze(ws, { as_of: ws.as_of }).events.plan.some((e) => e.cash_event_id === 'R-RENT@2026-10-25'), 'пропущенное вхождение ушло из ряда');
});

// ── списки и «Отменить» ──────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-010 списки вхождений: перенесённое и «со своей суммой» видны отдельно и возвращаются «как по правилу», даже если ушли за ближайшие даты; пропуск — в своём списке', () => {
  const ws0 = must(apply(must(apply(G, RULE.move_edit(RENT, NOM, '2027-02-10'))), RULE.amount_edit('R-UTIL', '2026-11-25', -13000)));
  const ws = must(apply(ws0, RULE.skip_edit('R-PHONE', '2026-10-09')));
  const changed = RULE.changed_of(ws, RENT, ws.as_of);
  assert.deepEqual(changed, [{ rule_id: RENT, nominal_date: NOM, action: 'move', date: '2027-02-10' }]);
  assert.deepEqual(RULE.changed_of(ws, 'R-UTIL', ws.as_of).map((o) => [o.nominal_date, o.action, o.amount_minor]), [['2026-11-25', 'set_amount', -13000]]);
  assert.deepEqual(RULE.changed_of(ws, 'R-PHONE', ws.as_of), [], 'пропуск — не «перенос» и не «своя сумма»');
  assert.deepEqual(RULE.skipped_of(ws, 'R-PHONE', ws.as_of), ['2026-10-09']);
  assert.deepEqual(RULE.changed_of(ws, RENT, '2027-03-01'), [], 'прошедшие правки в список «вернуть» не попадают');
  assert.equal(RULE.override_of(ws, RENT, NOM).action, 'move');
  assert.equal(RULE.override_of(ws, RENT, '2026-11-25'), undefined);
  const shown = RULE.occurrences_of(ws, ws.rules.find((r) => r.rule_id === RENT), ws.as_of, 3).map((x) => x.nominal);
  assert.ok(!shown.includes(NOM), 'перенесённое вхождение вышло за ближайшие три — только поэтому нужен отдельный список');
  const back = must(apply(ws, RULE.restore_edit(RENT, NOM)));
  assert.deepEqual(RULE.changed_of(back, RENT, back.as_of), []);
  assert.equal(RULE.occurrences_of(back, back.rules.find((r) => r.rule_id === RENT), back.as_of, 1)[0].date, '2026-10-26');
});

test('TST-16 REQ-090 REQ-010 «Отменить» и «Вернуть» возвращают перенос и свою сумму побайтно (inputs_hash), подпись — «изменение правила платежа»; последовательность пропуск → перенос → сумма откатывается по одной', () => {
  const chain = [G];
  for (const edit of [MOVE, AMOUNT, SKIP]) chain.push(must(apply(chain.at(-1), edit)));
  const kinds = [];
  const units = chain.slice(1).map((after, i) => {
    const meta = UNDO.describe_unit('set_occurrence_override', { changes: [{ bucket: 'overrides' }] }, after);
    kinds.push(meta.kind);
    return UNDO.diff_unit(chain[i], after, meta);
  });
  assert.deepEqual(kinds, ['rule', 'rule', 'rule']);
  let ws = chain.at(-1);
  for (let i = units.length - 1; i >= 0; i--) {
    const r = UNDO.apply_unit(ws, units[i], 'undo');
    assert.equal(r.ok, true, 'шаг ' + i);
    ws = r.ws;
    assert.equal(E.canon(ws), E.canon(chain[i]), 'шаг ' + i + ': побайтно');
    assert.equal(hash_of(ws), hash_of(chain[i]), 'шаг ' + i + ': inputs_hash');
  }
  assert.equal(hash_of(ws), hash_of(G));
  for (let i = 0; i < units.length; i++) {
    const r = UNDO.apply_unit(ws, units[i], 'redo');
    assert.equal(r.ok, true);
    ws = r.ws;
    assert.equal(E.canon(ws), E.canon(chain[i + 1]));
  }
  const money = (minor, cur) => `${minor / 100} ${cur}`;
  assert.equal(UNDO.unit_label({ kind: 'rule' }, (k) => ({ 'entry.u_rule': 'изменение правила платежа' })[k] ?? k, money), 'изменение правила платежа');
});
