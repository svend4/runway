// s1_3_adv.test.mjs — состязательная проверка единой стопки «Отменить / Вернуть» (S1.3, REQ-090, TST-16): краевые случаи, которых нет в undo_all.test.mjs.
// Реестр с подставной страницей, которая, как настоящий app.mjs, откатывает запись при отказе пересчёта (`analyze` бросает). Браузер, сеть и серверы не используются.
// Три теста «ДЕФЕКТ-1..3» были помечены `todo` (дефекты, найденные проверяющим); дефекты исправлены, пометки сняты — это обычные тесты.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze, canon } from '../engine/index.mjs';
import { create_ext } from '../demo/ext.mjs';
import { seeded_ports } from '../demo/ids.mjs';
import { apply_edit, register_edit, list_edit_types } from '../demo/ws_edit.mjs';
import { edit_set_as_of } from '../demo/as_of.mjs';
import { register as register_fp04 } from '../demo/pack_fp04.mjs';

// вид правки «Сегодня» регистрирует пакет FP-03; здесь пакеты не грузятся, поэтому регистрируем его сами (как это делает пакет)
if (!list_edit_types().includes('set_as_of')) register_edit('set_as_of', edit_set_as_of);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'data');
const load = (name) => JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const SETS = { 'G-001': 'g001.json', 'G-001-low': 'g001-low.json', 'G-001-gap': 'g001-gap.json', 'G-001-late': 'g001-late.json' };

/** Реестр с подставной страницей и пакетом FP-04 (напрямую, чтобы видеть его стопку `deps.undo`). */
function make_page(ws0) {
  const st = { ws: ws0, notes: [], renders: 0 };
  const e = create_ext({ ports: seeded_ports({ seed: 31 }) });
  e.bind_host({
    get_ws: () => st.ws,
    get_model: () => ({ ctx: analyze(st.ws, { as_of: st.ws.as_of }) }),
    lang: () => 'ru',
    mode: () => 'worse',
    fmt: () => null,
    set_ws: (next) => {
      try { analyze(next, { as_of: next.as_of }); } catch (x) { return { ok: false, error: x }; }
      st.ws = next;
      return { ok: true };
    },
    render: () => { st.renders += 1; },
    notify: (m, k) => { st.notes.push([m, k]); },
  });
  const deps = register_fp04({ ctx: e.ctx, register_i18n: () => {}, ensure_css: () => {}, register_hook: e.register_hook, register_slot_item: e.register_slot_item });
  e.reset(ws0);
  return { st, e, ctx: e.ctx, deps };
}

const ih = (ws) => analyze(ws, { as_of: ws.as_of }).inputs_hash;

// ── наборы G-001, -low, -gap, -late: отмена и возврат побайтно ───────────────────────────────────────────────────────

for (const [label, file] of Object.entries(SETS)) {
  test(`TST-16 REQ-090 ${label}: настройка, режим, контрагент, факт и удаление факта отменяются и возвращаются побайтно (canon) и с тем же inputs_hash`, () => {
    const G = load(file);
    const p = make_page(clone(G));
    const ws0 = p.st.ws;
    const h0 = ih(ws0);
    const first_fact = G.facts[Math.min(3, G.facts.length - 1)];
    const steps = [
      { type: 'set_param', key: 'buffer_minor', value: 61000 },
      { type: 'set_param', key: 'headline_mode', value: 'plan' },
      { type: 'add_counterparty', counterparty: { counterparty_id: 'cp_adv', name: 'ИП Икс' } },
      { type: 'add_fact', fact: { event_id: 'tx-adv-1', account_id: first_fact.account_id, date: G.as_of, amount_minor: -123, tag: 'тест' } },
      { type: 'void_fact', event_id: first_fact.event_id },
    ];
    const snaps = [ws0];
    for (const s of steps) {
      const r = p.ctx.edit(s);
      assert.equal(r.ok, true, label + ' ' + s.type + ' ' + JSON.stringify(r.error));
      snaps.push(p.st.ws);
    }
    assert.deepEqual(p.deps.undo.size(), { undo: steps.length, redo: 0 });
    for (let i = steps.length - 1; i >= 0; i--) {
      assert.equal(p.deps.undo.undo(p.ctx).ok, true, label + ' undo ' + i);
      assert.equal(canon(p.st.ws), canon(snaps[i]), label + ' undo ' + i);
      assert.equal(ih(p.st.ws), ih(snaps[i]), label + ' hash ' + i);
    }
    assert.equal(ih(p.st.ws), h0);
    for (let i = 0; i < steps.length; i++) {
      assert.equal(p.deps.undo.redo(p.ctx).ok, true, label + ' redo ' + i);
      assert.equal(canon(p.st.ws), canon(snaps[i + 1]), label + ' redo ' + i);
    }
  });
}

// ── посторонняя запись (мастер импорта, причина `import`) между действием пользователя и «Отменить» ──────────────────────
// Документация обещает: «прежние единицы после импорта либо остаются валидными, либо дают честный undo_conflict». Три пробы ниже — случаи,
// где это когда-то не выполнялось (исправлено: см. tests/undo_fix.test.mjs).

const foreign = (p, edit, reason = 'import') => {
  const r = apply_edit(p.st.ws, edit, { new_id: p.ctx.new_id });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(p.ctx.set_ws(r.ws, { reason }).ok, true);
  return r.ws;
};
const orphans = (ws) => ws.facts.filter((f) => !ws.accounts.some((a) => a.account_id === f.account_id)).length;

test('TST-16 REQ-090 ДЕФЕКТ-1: счёт создан пользователем, импорт положил на него факты — «Отменить» создание счёта не оставляет факты без счёта (отказ undo_conflict либо факты не висят)', () => {
  const G = load('g001.json');
  const p = make_page(clone(G));
  assert.equal(p.ctx.edit({ type: 'upsert_account', account: { account_id: 'acc_new', name: 'Новый', kind: 'bank', liquidity: 'operating', currency: 'EUR' } }).ok, true);
  foreign(p, { type: 'add_fact', fact: { event_id: 'tx-imp-1', account_id: 'acc_new', date: G.as_of, amount_minor: -100 } });
  const r = p.deps.undo.undo(p.ctx);
  assert.ok(r.ok === false || orphans(p.st.ws) === 0, 'после успешной отмены на несуществующий счёт ссылается фактов: ' + orphans(p.st.ws));
});

test('TST-16 REQ-090 ДЕФЕКТ-2: после отказа страницы из-за постороннего факта («Сегодня» нельзя вернуть раньше него) стопка не залипает — следующая «Отменить» доходит до более ранней единицы', () => {
  const G = load('g001.json');
  const p = make_page(clone(G));
  assert.equal(p.ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 61000 }).ok, true);
  assert.equal(p.ctx.edit({ type: 'set_as_of', date: '2026-10-10' }).ok, true);
  foreign(p, { type: 'add_fact', fact: { event_id: 'tx-imp-2', account_id: 'acc_main', date: '2026-10-09', amount_minor: -100 } });
  const first = p.deps.undo.undo(p.ctx);
  assert.equal(first.ok, false, 'вернуть «Сегодня» раньше проведённой записи нельзя');
  const second = p.deps.undo.undo(p.ctx);
  assert.equal(second.ok, true, 'вторая отмена должна дойти до настройки: ' + JSON.stringify(second.error?.ctx));
  assert.equal(p.st.ws.params.buffer_minor, 50000);
});

test('TST-16 REQ-090 ДЕФЕКТ-3: повторное сохранение правки волн с теми же значениями переставляет её в конец (inputs_hash меняется) — такое действие записывается в стопку и отменяется', () => {
  const G = load('g001.json');
  const p = make_page(clone(G));
  const ov = (id, to) => ({ type: 'set_wave_override', override: { override_id: id, action: 'pin', event_ids: ['tx-g001-01'], pin_range: { from: '2026-10-01', to } } });
  assert.equal(p.ctx.edit(ov('wov_b', '2026-10-02')).ok, true);
  assert.equal(p.ctx.edit(ov('wov_c', '2026-10-04')).ok, true);
  const ws2 = p.st.ws;
  assert.equal(p.ctx.edit(ov('wov_b', '2026-10-02')).ok, true); // те же значения: правка уходит в конец списка
  assert.deepEqual(p.st.ws.wave_overrides.map((o) => o.override_id), ['wov_c', 'wov_b']);
  assert.notEqual(ih(p.st.ws), ih(ws2), 'порядок правок входит в inputs_hash');
  assert.deepEqual(p.deps.undo.size(), { undo: 3, redo: 0 }, 'перестановка — действие пользователя');
  assert.equal(p.deps.undo.undo(p.ctx).ok, true);
  assert.equal(canon(p.st.ws), canon(ws2));
});

test('TST-16 REQ-090: импорт новых счетов и фактов между действиями не мешает отменить независимое действие и вернуть его', () => {
  const G = load('g001.json');
  const p = make_page(clone(G));
  assert.equal(p.ctx.edit({ type: 'add_counterparty', counterparty: { counterparty_id: 'cp_adv', name: 'ИП' } }).ok, true);
  foreign(p, { type: 'upsert_account', account: { account_id: 'acc_imp', name: 'Импорт', kind: 'bank', liquidity: 'operating', currency: 'EUR' } });
  foreign(p, { type: 'add_fact', fact: { event_id: 'tx-imp-3', account_id: 'acc_imp', date: G.as_of, amount_minor: -500 } });
  const r = p.deps.undo.undo(p.ctx);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(p.st.ws.counterparties?.some((c) => c.counterparty_id === 'cp_adv') ?? false, false);
  assert.ok(p.st.ws.accounts.some((a) => a.account_id === 'acc_imp') && p.st.ws.facts.some((f) => f.event_id === 'tx-imp-3'), 'импортированное осталось');
  assert.equal(p.deps.undo.redo(p.ctx).ok, true);
  assert.equal(orphans(p.st.ws), 0);
});

// ── перевод: две ноги одной единицей, удаление из середины и возврат ─────────────────────────────────────────────────────

test('TST-16 REQ-090: удаление перевода (две ноги) — одна единица; отмена возвращает обе ноги на прежние места, возврат убирает снова; подпись — «удаление записи»', () => {
  const G = load('g001.json');
  const w = clone(G);
  w.accounts.push({ account_id: 'acc_sav', name: 'Копилка', kind: 'savings', liquidity: 'savings', currency: 'EUR', exponent: 2, opened_on: '2026-01-01' });
  const p = make_page(w);
  assert.equal(p.ctx.edit({ type: 'add_fact', transfer_id: 'trf-adv', legs: [{ account_id: 'acc_main', date: G.as_of, amount_minor: -15000 }, { account_id: 'acc_sav', date: G.as_of, amount_minor: 15000 }] }).ok, true);
  // ещё факты после перевода, чтобы ноги стояли «в середине»
  assert.equal(p.ctx.edit({ type: 'add_fact', fact: { event_id: 'tx-after-1', account_id: 'acc_main', date: G.as_of, amount_minor: -100 } }).ok, true);
  assert.equal(p.ctx.edit({ type: 'add_fact', fact: { event_id: 'tx-after-2', account_id: 'acc_main', date: G.as_of, amount_minor: -200 } }).ok, true);
  const with_all = p.st.ws;
  const leg = with_all.facts.find((f) => f.transfer_id === 'trf-adv');
  assert.equal(p.ctx.edit({ type: 'void_fact', event_id: leg.event_id }).ok, true);
  assert.equal(p.st.ws.facts.some((f) => f.transfer_id === 'trf-adv'), false, 'удалены обе ноги');
  assert.deepEqual(p.deps.undo.size(), { undo: 4, redo: 0 });
  assert.deepEqual(p.deps.undo.peek_undo(), { kind: 'fact_removed' });
  assert.equal(p.deps.undo.undo(p.ctx).ok, true);
  assert.equal(canon(p.st.ws), canon(with_all), 'обе ноги на прежних местах');
  assert.equal(p.deps.undo.redo(p.ctx).ok, true);
  assert.equal(p.st.ws.facts.some((f) => f.transfer_id === 'trf-adv'), false);
});

// ── случайная последовательность действий, отмен и возвратов против модели «список состояний + указатель» ─────────────────

function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function random_walk(seed, steps) {
  const G = load('g001.json');
  const p = make_page(clone(G));
  const rnd = prng(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const states = [p.st.ws];
  let ptr = 0;
  let n = 0;
  const uid = (pre) => pre + '_' + seed + '_' + (n += 1);
  const edits = [
    () => ({ type: 'set_param', key: 'buffer_minor', value: int(1, 90) * 1000 }),
    () => ({ type: 'set_param', key: 'buffer_minor', value: null }),
    () => ({ type: 'set_param', key: 'horizon_days', value: int(30, 90) }),
    () => ({ type: 'set_param', key: pick(['fx.stale_days', 'calib.window', 'mc.n_paths']), value: int(1, 9) }),
    () => ({ type: 'add_fact', fact: { event_id: uid('tx'), account_id: 'acc_main', date: p.st.ws.as_of, amount_minor: -int(1, 50) * 100, tag: 'т' } }),
    () => ({ type: 'void_fact', event_id: pick(p.st.ws.facts).event_id }),
    () => ({ type: 'add_counterparty', counterparty: { counterparty_id: uid('cp'), name: 'К' } }),
    () => ({ type: 'upsert_rule', rule: { rule_id: uid('R'), version: 1, account_id: 'acc_main', name: 'Правило', kind: 'expense', amount: { exp_minor: -int(1, 40) * 100 }, currency: 'EUR', freq: 'M', interval: 1, month_end: 'clamp', weekend: 'next', calendar_id: 'cal-main', exdates: [], is_obligation: true, is_estimate: false, tag: 'п', by_monthday: [int(1, 28)], start_date: '2026-10-15' } }),
    () => ({ type: 'delete_rule', rule_id: pick(p.st.ws.rules).rule_id }),
    () => ({ type: 'save_scenario', scenario: { scenario_id: uid('scn'), name: 'С', ops: [{ op: 'delay_income', event_ref: 'S-HOURLY@2026-11-05', days: int(1, 9) }] } }),
    () => ({ type: 'delete_scenario', scenario_id: pick(p.st.ws.scenarios ?? [{ scenario_id: 'нет' }]).scenario_id }),
    () => {
      const id = pick(['wov_a', 'wov_b', 'wov_c', uid('wov')]);
      const to = '2026-10-' + String(int(2, 28)).padStart(2, '0');
      // повторное сохранение правки с теми же значениями — чистая перестановка (ДЕФЕКТ-3): теперь это обычное действие и входит в ходьбу
      return { type: 'set_wave_override', override: { override_id: id, action: 'pin', event_ids: ['tx-g001-01'], pin_range: { from: '2026-10-01', to } } };
    },
    () => ({ type: 'set_wave_override', override_id: pick((p.st.ws.wave_overrides ?? [{ override_id: 'нет' }]).map((o) => o.override_id)), remove: true }),
    () => ({ type: 'set_as_of', date: '2026-10-' + String(int(4, 20)).padStart(2, '0') }),
    () => ({ type: 'upsert_stream', stream: { ...pick(p.st.ws.streams), rate_minor: int(20, 40) * 100 } }),
    () => ({ type: 'add_purchase', purchase: { purchase_id: uid('pur'), name: 'Т', currency: 'EUR', parts: [{ date: '2026-10-20', amount_minor: int(1, 90) * 100 }] } }),
  ];
  const log = [];
  const check = (what) => {
    assert.equal(canon(p.st.ws), canon(states[ptr]), `seed ${seed}: ${what}; указатель ${ptr}; ${log.join(' ')}`);
    assert.deepEqual(p.deps.undo.size(), { undo: ptr, redo: states.length - 1 - ptr }, `seed ${seed}: размер стопки после ${what}`);
  };
  for (let i = 0; i < steps; i++) {
    const roll = rnd();
    if (roll < 0.25 && ptr > 0) {
      log.push('U');
      assert.equal(p.deps.undo.undo(p.ctx).ok, true, `seed ${seed}: undo ${log.join(' ')}`);
      ptr -= 1;
      check('отмена');
    } else if (roll < 0.4 && ptr < states.length - 1) {
      log.push('R');
      assert.equal(p.deps.undo.redo(p.ctx).ok, true, `seed ${seed}: redo ${log.join(' ')}`);
      ptr += 1;
      check('возврат');
    } else {
      let edit;
      try { edit = pick(edits)(); } catch { continue; }
      const before = p.st.ws;
      const r = p.ctx.edit(edit);
      if (!r.ok) { assert.equal(p.st.ws, before); check('отказ ' + edit.type); continue; }
      if (r.ws === before || canon(r.ws) === canon(before)) { check('без изменений ' + edit.type); continue; }
      log.push(edit.type + (edit.key ? ':' + edit.key : ''));
      states.length = ptr + 1;
      states.push(p.st.ws);
      ptr += 1;
      check('действие ' + edit.type);
    }
  }
  // всё откатывается до начала и возвращается до конца
  while (ptr > 0) { assert.equal(p.deps.undo.undo(p.ctx).ok, true); ptr -= 1; check('откат до начала'); }
  assert.equal(canon(p.st.ws), canon(states[0]));
  while (ptr < states.length - 1) { assert.equal(p.deps.undo.redo(p.ctx).ok, true); ptr += 1; check('возврат до конца'); }
  return states.length - 1;
}

for (const seed of [19, 41, 109]) {
  test(`TST-16 REQ-090 случайная последовательность (seed ${seed}): состояние после каждой отмены и возврата совпадает с моделью побайтно, размеры стопки верны`, () => {
    const n = random_walk(seed, 60);
    assert.ok(n >= 8, 'в последовательности были действия: ' + n);
  });
}
