// undo_fix.test.mjs — исправления единой стопки «Отменить / Вернуть» после независимой проверки S1.3 (REQ-090, TST-16).
// Пять дефектов и по тесту на каждый (плюс контрольные случаи, чтобы исправление не давало ложных конфликтов):
//   1. «Отменить» создание счёта после импорта оставляла факты-сироты: теперь единица, после которой на убранный элемент ссылалась бы чужая запись,
//      даёт честный `undo_conflict` (ссылки, которые приложение проверяет само: `UNDO_REFS`); уже висевшие ссылки не мешают;
//   2. стопка залипала: отказ страницы, который не пройдёт и при повторе (расчёт на итоговой рабочей области падает так же), снимает единицу как
//      конфликт, и следующая «Отменить» доходит до более ранней единицы; временный отказ по-прежнему возвращает единицу на место;
//   3. чистая перестановка (правка волн, сохранённая заново с теми же значениями) попадает в стопку: единица с пустым `changes` и непустым `order`;
//   4. отмена первого задания параметра пишет в журнал `null`; при чтении журнала `null` необнуляемого параметра снова «ключа нет»
//      (`inputs_hash` после перезагрузки равен сеансовому), параметры с допустимым `null` остаются как есть;
//   5. правило ключа элемента — одно, у моста (`ws_bridge.item_key`, `NON_META_KEYS`): пустая строка — не ключ; стопка свой список не держит.
// Реестр с подставной страницей, которая, как настоящий app.mjs, откатывает запись при отказе пересчёта (`analyze` бросает).
// Браузер, сеть и серверы не используются; тесты не запускают фоновых процессов.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze, canon, reduce, effective_events } from '../engine/index.mjs';
import { make_tool_ctx } from '../engine/tools.mjs';
import { PARAM_RANGES } from '../engine/validate_ws.mjs';
import { create_ext } from '../demo/ext.mjs';
import { seeded_ports } from '../demo/ids.mjs';
import { apply_edit, register_edit, list_edit_types } from '../demo/ws_edit.mjs';
import { edit_set_as_of } from '../demo/as_of.mjs';
import { register as register_fp04, undo_done_handler } from '../demo/pack_fp04.mjs';
import { register_strings } from '../demo/i18n.mjs';
import { t as tr_of } from '../demo/i18n.mjs';
import catalog from '../demo/i18n/entry.mjs';
import { BUCKETS, NON_META_KEYS, item_key, events_to_ws, ws_to_events } from '../demo/ws_bridge.mjs';
import {
  UNDO_ARRAY_BUCKETS, UNDO_EXTRA_BUCKETS, UNDO_REFS, create_undo_stack, diff_unit, apply_unit, refusal_code,
} from '../demo/undo.mjs';

// вид правки «Сегодня» регистрирует пакет FP-03; здесь пакеты не грузятся, поэтому регистрируем его сами (как это делает пакет)
if (!list_edit_types().includes('set_as_of')) register_edit('set_as_of', edit_set_as_of);
register_strings('entry', catalog); // подписи и сообщения пакета: страница в этом тесте их не регистрирует

const HERE = path.dirname(fileURLToPath(import.meta.url));
const G = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'data', 'g001.json'), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const ih = (ws) => analyze(ws, { as_of: ws.as_of }).inputs_hash;
const deep_freeze = (x) => { if (x !== null && typeof x === 'object') { Object.freeze(x); for (const v of Object.values(x)) deep_freeze(v); } return x; };
const BRIDGE = new Map(BUCKETS.map((b) => [b.ws_key, b]));

/** Реестр с подставной страницей и пакетом FP-04 (напрямую, чтобы видеть его стопку `deps.undo`). `st.host_throws` — страница бросает не-канонное исключение, `st.force_refuse` — отказывает без причин расчёта. */
function make_page(ws0) {
  const st = { ws: ws0, notes: [], renders: 0, host_throws: false, force_refuse: false };
  const e = create_ext({ ports: seeded_ports({ seed: 17 }) });
  e.bind_host({
    get_ws: () => st.ws,
    get_model: () => ({ ctx: analyze(st.ws, { as_of: st.ws.as_of }) }),
    lang: () => 'ru',
    mode: () => 'worse',
    fmt: () => null,
    set_ws: (next) => {
      if (st.host_throws) throw new Error('страница недоступна');
      if (st.force_refuse) return { ok: false, error: { code: 'E_SCHEMA', ctx: { reason: 'forced_refusal' } } };
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

/** Посторонняя запись помимо стопки: причина `import` (мастер импорта в стопку не пишет). */
const foreign = (p, edit, reason = 'import') => {
  const r = apply_edit(p.st.ws, edit, { new_id: p.ctx.new_id });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(p.ctx.set_ws(r.ws, { reason }).ok, true);
  return r.ws;
};
const ed = (p, edit) => { const r = p.ctx.edit(edit); assert.equal(r.ok, true, JSON.stringify(r.error)); return r; };
const orphans = (ws) => ws.facts.filter((f) => !ws.accounts.some((a) => a.account_id === f.account_id)).length;
const NEW_ACCOUNT = { account_id: 'acc_new', name: 'Новый', kind: 'bank', liquidity: 'operating', currency: 'EUR' };

// ── 1. ссылочная целостность ─────────────────────────────────────────────────────────────────────────────────────────

test('TST-16 REQ-090 дефект 1: счёт создан пользователем, импорт положил на него факт — «Отменить» создание счёта отказывает undo_conflict, данные не тронуты, единица снята', () => {
  const p = make_page(clone(G));
  ed(p, { type: 'upsert_account', account: NEW_ACCOUNT });
  foreign(p, { type: 'add_fact', fact: { event_id: 'tx-imp-1', account_id: 'acc_new', date: G.as_of, amount_minor: -100 } });
  const now = p.st.ws;
  const r = p.deps.undo.undo(p.ctx);
  assert.equal(r.ok, false);
  assert.equal(r.error.ctx.reason, 'undo_conflict');
  assert.equal(r.error.ctx.cause, 'dangling_ref');
  assert.equal(r.error.ctx.bucket, 'facts', 'названа корзина записи, которая осталась бы без счёта');
  assert.equal(p.st.ws, now, 'рабочая область не тронута');
  assert.equal(orphans(p.st.ws), 0);
  assert.ok(p.st.ws.accounts.some((a) => a.account_id === 'acc_new'));
  assert.deepEqual(p.deps.undo.size(), { undo: 0, redo: 0 }, 'устаревшая единица снята со стопки');
});

test('TST-16 REQ-090 дефект 1: после конфликта по ссылке следующая «Отменить» доходит до более ранней единицы; сообщение пользователю — «данные изменились»', () => {
  const p = make_page(clone(G));
  ed(p, { type: 'set_param', key: 'buffer_minor', value: 61000 });
  ed(p, { type: 'upsert_account', account: NEW_ACCOUNT });
  foreign(p, { type: 'add_fact', fact: { event_id: 'tx-imp-1', account_id: 'acc_new', date: G.as_of, amount_minor: -100 } });
  const done = undo_done_handler(p.ctx);
  const first = p.deps.undo.undo(p.ctx);
  done('undo', first);
  assert.deepEqual(p.st.notes.at(-1), [tr_of('ru', 'entry.undo_conflict'), 'error']);
  const second = p.deps.undo.undo(p.ctx);
  assert.equal(second.ok, true, JSON.stringify(second.error));
  assert.equal(p.st.ws.params.buffer_minor, 50000);
  assert.ok(p.st.ws.accounts.some((a) => a.account_id === 'acc_new') && orphans(p.st.ws) === 0, 'счёт и факт импорта остались');
});

test('TST-16 REQ-090 дефект 1: возврат (redo) тоже не оставляет висячих ссылок — правило удалено, пока чужой пропуск вхождения ссылается на него', () => {
  const p = make_page(clone(G));
  const rule = G.rules[0];
  ed(p, { type: 'delete_rule', rule_id: rule.rule_id });
  assert.equal(p.deps.undo.undo(p.ctx).ok, true, 'правило вернулось');
  assert.equal(p.ctx.set_ws({ ...p.st.ws, overrides: [{ rule_id: rule.rule_id, nominal_date: '2026-11-15', action: 'skip' }] }, { reason: 'import' }).ok, true);
  assert.ok((p.st.ws.overrides ?? []).some((o) => o.rule_id === rule.rule_id), 'чужой пропуск добавлен');
  const now = p.st.ws;
  const r = p.deps.undo.redo(p.ctx);
  assert.equal(r.ok, false);
  assert.equal(r.error.ctx.reason, 'undo_conflict');
  assert.equal(r.error.ctx.bucket, 'overrides');
  assert.equal(p.st.ws, now);
  assert.deepEqual(p.deps.undo.size(), { undo: 0, redo: 0 });
});

test('TST-16 REQ-090 дефект 1: контрагент, добавленный пользователем и использованный чужим фактом, не отменяется (undo_conflict); без чужих ссылок отменяется как раньше', () => {
  const p = make_page(clone(G));
  ed(p, { type: 'add_counterparty', counterparty: { counterparty_id: 'cp_adv', name: 'ИП Икс' } });
  foreign(p, { type: 'add_fact', fact: { event_id: 'tx-imp-cp', account_id: 'acc_main', date: G.as_of, amount_minor: -100, counterparty_id: 'cp_adv' } });
  const r = p.deps.undo.undo(p.ctx);
  assert.equal(r.error.ctx.reason, 'undo_conflict');
  assert.equal(r.error.ctx.cause, 'dangling_ref');
  const q = make_page(clone(G));
  ed(q, { type: 'add_counterparty', counterparty: { counterparty_id: 'cp_adv', name: 'ИП Икс' } });
  ed(q, { type: 'add_fact', fact: { event_id: 'tx-own', account_id: 'acc_main', date: G.as_of, amount_minor: -100, counterparty_id: 'cp_adv' } });
  assert.equal(q.deps.undo.undo(q.ctx).ok, true, 'собственный факт пользователя отменяется первым');
  assert.equal(q.deps.undo.undo(q.ctx).ok, true, 'затем и контрагент');
  assert.equal(canon(q.st.ws), canon(G));
});

test('TST-16 REQ-090 дефект 1: единица, которая убирает и сам элемент, и ссылающиеся на него записи (счёт + остаток одной правкой), отменяется без конфликта', () => {
  const p = make_page(clone(G));
  const ws0 = p.st.ws;
  const w = { ...ws0, accounts: [...ws0.accounts, NEW_ACCOUNT], anchors: [...ws0.anchors, { anchor_id: 'anc_new', account_id: 'acc_new', date: G.as_of, amount_minor: 1000 }] };
  assert.equal(p.ctx.set_ws(w, { reason: 'commit_edits' }).ok, true);
  assert.deepEqual(p.deps.undo.size(), { undo: 1, redo: 0 });
  assert.equal(p.deps.undo.undo(p.ctx).ok, true);
  assert.equal(canon(p.st.ws), canon(ws0));
  assert.equal(p.deps.undo.redo(p.ctx).ok, true);
  assert.equal(canon(p.st.ws), canon(w));
});

test('TST-16 REQ-090 дефект 1: уже висевшие ссылки (до действия) отмене не мешают — считаются только новые', () => {
  const ghost = clone(G);
  ghost.facts = [...ghost.facts, { event_id: 'tx-ghost', account_id: 'acc_ghost', date: G.as_of, amount_minor: -1 }]; // чужой файл: счёта нет
  const w1 = { ...ghost, params: { ...ghost.params, buffer_minor: 61000 } };
  const unit = diff_unit(ghost, w1);
  const r = apply_unit(w1, unit, 'undo');
  assert.equal(r.ok, true, 'прежняя висячая ссылка не считается');
  assert.equal(r.ws.params.buffer_minor, 50000);
  // и убрать ещё один, ничем не занятый счёт можно
  const w2 = { ...ghost, accounts: [...ghost.accounts, NEW_ACCOUNT] };
  assert.equal(apply_unit(w2, diff_unit(ghost, w2), 'undo').ok, true);
});

test('TST-16 REQ-090 дефект 1: каждая ссылка из UNDO_REFS ловится — единица убирает цель, источник ссылается на неё (undo_conflict, названа корзина источника); если единица убирает и источник — без конфликта', () => {
  assert.ok(UNDO_REFS.length >= 14, 'таблица ссылок не пуста: ' + UNDO_REFS.length);
  const ids = new Map(BUCKETS.map((b) => [b.ws_key, b.id_field]));
  const make = (bucket, id) => {
    if (bucket === 'overrides') return { rule_id: id, nominal_date: '2026-10-10' };
    if (bucket === 'tax_rules') return { tax_rule_id: id, version: 1 };
    return { [ids.get(bucket)]: id };
  };
  const set_path = (obj, p, v) => {
    const parts = p.split('.');
    let o = obj;
    for (const part of parts.slice(0, -1)) o = (o[part] ??= {});
    o[parts.at(-1)] = v;
    return obj;
  };
  const seen = new Set();
  for (const [src, field, target] of UNDO_REFS) {
    assert.ok(UNDO_ARRAY_BUCKETS.some(([b]) => b === src) && UNDO_ARRAY_BUCKETS.some(([b]) => b === target), `корзины ссылки известны: ${src}.${field} → ${target}`);
    seen.add(src + '.' + field);
    const tgt_item = make(target, 'T1');
    const src_item = set_path(make(src, 'S1'), field, field.endsWith('stream_ids') ? ['T1'] : 'T1');
    const ws = { [target]: [tgt_item], [src]: [src_item] };
    const src_key = item_key(BRIDGE.get(src), src_item);
    const tgt_unit = { changes: [{ bucket: target, key: 'T1', before: tgt_item, after: null }] };
    const r = apply_unit(ws, tgt_unit, 'redo');
    assert.equal(r.ok, false, `${src}.${field} → ${target}: висячая ссылка должна отказать`);
    assert.equal(r.reason, 'undo_conflict');
    assert.equal(r.cause, 'dangling_ref');
    assert.equal(r.bucket, src);
    assert.equal(r.key, src_key);
    // контроль: единица убирает и источник — ссылка не остаётся
    const both = { changes: [...tgt_unit.changes, { bucket: src, key: src_key, before: src_item, after: null }] };
    assert.equal(apply_unit(ws, both, 'redo').ok, true, `${src}.${field}: источник тоже убран — конфликта нет`);
  }
  assert.equal(seen.size, UNDO_REFS.length, 'в таблице нет повторов');
});

test('TST-16 REQ-090 дефект 1: apply_unit не мутирует вход — на замороженной рабочей области отказ по ссылке проходит без исключения', () => {
  const p = make_page(clone(G));
  ed(p, { type: 'upsert_account', account: NEW_ACCOUNT });
  const unit = diff_unit(G, p.st.ws);
  const w = deep_freeze(clone({ ...p.st.ws, facts: [...p.st.ws.facts, { event_id: 'tx-imp-fz', account_id: 'acc_new', date: G.as_of, amount_minor: -5 }] }));
  const r = apply_unit(w, unit, 'undo');
  assert.equal(r.ok, false);
  assert.equal(r.cause, 'dangling_ref');
});

// ── 2. стопка не залипает ────────────────────────────────────────────────────────────────────────────────────────────

const stick = () => {
  const p = make_page(clone(G));
  ed(p, { type: 'set_param', key: 'buffer_minor', value: 61000 });
  ed(p, { type: 'set_as_of', date: '2026-10-10' });
  foreign(p, { type: 'add_fact', fact: { event_id: 'tx-imp-2', account_id: 'acc_main', date: '2026-10-09', amount_minor: -100 } });
  return p;
};

test('TST-16 REQ-090 дефект 2: отказ страницы, который не пройдёт и при повторе («Сегодня» раньше проведённой чужой записи), снимает единицу как undo_conflict — стопка не залипает', () => {
  const p = stick();
  const now = p.st.ws;
  const first = p.deps.undo.undo(p.ctx);
  assert.equal(first.ok, false);
  assert.equal(first.error.ctx.reason, 'undo_conflict');
  assert.equal(first.error.ctx.cause, 'refused');
  assert.equal(first.error.ctx.code, 'E_FUTURE_POSTED', 'назван код отказа канона, без пользовательских текстов');
  assert.equal(p.st.ws, now, 'данные прежние');
  assert.deepEqual(p.deps.undo.size(), { undo: 1, redo: 0 }, 'единица «Сегодня» снята, не перенесена в «Вернуть»');
  const second = p.deps.undo.undo(p.ctx);
  assert.equal(second.ok, true, JSON.stringify(second.error));
  assert.equal(p.st.ws.params.buffer_minor, 50000);
  assert.ok(p.st.ws.facts.some((f) => f.event_id === 'tx-imp-2'), 'чужая запись осталась');
  assert.equal(p.st.ws.as_of, '2026-10-10', '«Сегодня» не вернули: единица устарела');
  assert.deepEqual(p.deps.undo.size(), { undo: 0, redo: 1 });
});

test('TST-16 REQ-090 дефект 2: сообщение пользователю при детерминированном отказе — «данные изменились», а не общее «не удалось»; кнопки перерисованы', () => {
  const p = stick();
  const done = undo_done_handler(p.ctx);
  const renders = p.st.renders;
  done('undo', p.deps.undo.undo(p.ctx));
  assert.deepEqual(p.st.notes.at(-1), [tr_of('ru', 'entry.undo_conflict'), 'error']);
  assert.ok(p.st.renders > renders, 'после снятия единицы страница перерисована (служебная запись)');
  assert.equal(p.deps.undo.can_undo(), true, 'более ранняя единица доступна');
});

test('TST-16 REQ-090 дефект 2: временный отказ страницы (рабочая область годная, отказ не из расчёта) возвращает единицу на место — как прежде', () => {
  const p = make_page(clone(G));
  ed(p, { type: 'set_param', key: 'buffer_minor', value: 61000 });
  const now = p.st.ws;
  p.st.force_refuse = true;
  const r = p.deps.undo.undo(p.ctx);
  assert.equal(r.ok, false);
  assert.equal(r.error.ctx.reason, 'forced_refusal', 'ошибка страницы отдана как есть');
  assert.equal(p.st.ws, now);
  assert.deepEqual(p.deps.undo.size(), { undo: 1, redo: 0 }, 'единица осталась на вершине');
  p.st.force_refuse = false;
  p.st.host_throws = true; // исключение хозяина (не из расчёта)
  const r2 = p.deps.undo.undo(p.ctx);
  assert.equal(r2.ok, false);
  assert.deepEqual(p.deps.undo.size(), { undo: 1, redo: 0 });
  p.st.host_throws = false;
  assert.equal(p.deps.undo.undo(p.ctx).ok, true, 'после того как страница снова работает, отмена проходит');
  assert.equal(p.st.ws.params.buffer_minor, 50000);
});

test('TST-16 REQ-090 дефект 2: refusal_code — код отказа расчёта для итоговой рабочей области, null для годной; страница и проба считают одинаково (make_tool_ctx)', () => {
  assert.equal(refusal_code(clone(G)), null);
  const bad = clone(G);
  bad.facts = [...bad.facts, { event_id: 'tx-fut', account_id: 'acc_main', date: '2026-12-31', amount_minor: -100 }];
  assert.equal(refusal_code(bad), 'E_FUTURE_POSTED');
  let code = null;
  try { make_tool_ctx(bad, { as_of: bad.as_of }, { locale: 'ru' }); } catch (e) { code = e.code; }
  assert.equal(code, 'E_FUTURE_POSTED', 'страница (app.build_model → make_tool_ctx) отказывает тем же кодом');
  const weird = clone(G);
  weird.accounts = 7; // мусор: любое исключение расчёта — отказ, код только из канона
  const c = refusal_code(weird);
  assert.ok(c === null || /^E_[A-Z_]+$/.test(c), 'код отказа без пользовательских текстов: ' + c);
});

test('TST-16 REQ-090 дефект 2: возврат (redo), который страница отвергает детерминированно, тоже снимает единицу — «Вернуть» не залипает', () => {
  const w0 = clone(G);
  const w_bad = { ...w0, facts: [...w0.facts, { event_id: 'tx-fut', account_id: 'acc_main', date: '2026-12-31', amount_minor: -100 }] };
  const stack = create_undo_stack();
  assert.ok(stack.record(w0, w_bad, { kind: 'other' }) !== false);
  const cur = { ws: w_bad };
  const ctx = {
    get_ws: () => cur.ws,
    set_ws: (next) => { try { analyze(next, { as_of: next.as_of }); } catch (x) { return { ok: false, error: x }; } cur.ws = next; return { ok: true }; },
  };
  assert.equal(stack.undo(ctx).ok, true);
  assert.deepEqual(stack.size(), { undo: 0, redo: 1 });
  const r = stack.redo(ctx);
  assert.equal(r.ok, false);
  assert.equal(r.error.ctx.reason, 'undo_conflict');
  assert.equal(r.error.ctx.code, 'E_FUTURE_POSTED');
  assert.deepEqual(stack.size(), { undo: 0, redo: 0 }, 'единица снята и не осталась ни в одной стопке');
  assert.equal(canon(cur.ws), canon(w0), 'данные прежние');
});

// ── 3. чистая перестановка ───────────────────────────────────────────────────────────────────────────────────────────

const wov = (id, to) => ({ type: 'set_wave_override', override: { override_id: id, action: 'pin', event_ids: ['tx-g001-01'], pin_range: { from: '2026-10-01', to } } });

test('TST-16 REQ-090 дефект 3: повторное сохранение правки волн с теми же значениями — единица с пустым changes и порядком; отмена и возврат возвращают порядок побайтно и с inputs_hash', () => {
  const p = make_page(clone(G));
  ed(p, wov('wov_b', '2026-10-02'));
  ed(p, wov('wov_c', '2026-10-04'));
  const ws2 = p.st.ws;
  const h2 = ih(ws2);
  ed(p, wov('wov_b', '2026-10-02')); // те же значения: правка уходит в конец списка
  const ws3 = p.st.ws;
  assert.deepEqual(ws3.wave_overrides.map((o) => o.override_id), ['wov_c', 'wov_b']);
  assert.notEqual(ih(ws3), h2, 'порядок правок входит в inputs_hash');
  assert.deepEqual(p.deps.undo.size(), { undo: 3, redo: 0 });
  assert.deepEqual(p.deps.undo.peek_undo(), { kind: 'wave_override' });
  assert.equal(p.deps.undo.undo(p.ctx).ok, true);
  assert.equal(canon(p.st.ws), canon(ws2));
  assert.equal(ih(p.st.ws), h2);
  assert.equal(p.deps.undo.redo(p.ctx).ok, true);
  assert.equal(canon(p.st.ws), canon(ws3));
  assert.equal(ih(p.st.ws), ih(ws3));
});

test('TST-16 REQ-090 дефект 3: diff_unit — пустой changes + order только при смене порядка; тот же порядок в новом массиве — единицы нет; формат прежних единиц не изменился', () => {
  const a = { ...clone(G), wave_overrides: [{ override_id: 'a', action: 'pin', event_ids: ['x'] }, { override_id: 'b', action: 'pin', event_ids: ['y'] }] };
  const swapped = { ...a, wave_overrides: [a.wave_overrides[1], a.wave_overrides[0]] };
  const u = diff_unit(a, swapped, { kind: 'wave_override' });
  assert.deepEqual(u.changes, []);
  assert.deepEqual(u.order, { wave_overrides: { before: ['a', 'b'], after: ['b', 'a'] } });
  assert.equal(u.presence, undefined);
  const same_order = { ...a, wave_overrides: a.wave_overrides.slice() };
  assert.equal(diff_unit(a, same_order), null, 'новая ссылка на массив без смены порядка — не действие');
  // обычная правка по-прежнему без лишнего order
  const plain = { ...a, wave_overrides: [...a.wave_overrides, { override_id: 'c', action: 'pin', event_ids: ['z'] }] };
  const u2 = diff_unit(a, plain);
  assert.equal(u2.order, undefined);
  assert.equal(u2.changes.length, 1);
});

test('TST-16 REQ-090 дефект 3: перестановка применяется в обе стороны; порядок, изменённый помимо стопки, — undo_conflict; чужой элемент едет со своим соседом', () => {
  const a = { ...clone(G), wave_overrides: [{ override_id: 'a', action: 'pin', event_ids: ['x'] }, { override_id: 'b', action: 'pin', event_ids: ['y'] }, { override_id: 'c', action: 'pin', event_ids: ['z'] }] };
  const moved = { ...a, wave_overrides: [a.wave_overrides[1], a.wave_overrides[2], a.wave_overrides[0]] }; // a ушла в конец
  const u = diff_unit(a, moved);
  const back = apply_unit(moved, u, 'undo');
  assert.equal(back.ok, true);
  assert.equal(canon(back.ws), canon(a));
  const fwd = apply_unit(a, u, 'redo');
  assert.equal(fwd.ok, true);
  assert.equal(canon(fwd.ws), canon(moved));
  // порядок после действия кто-то поменял (импорт перекладывает записи): отмена перестановки отказывает
  const meddled = { ...moved, wave_overrides: [moved.wave_overrides[2], moved.wave_overrides[0], moved.wave_overrides[1]] };
  const r = apply_unit(meddled, u, 'undo');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'undo_conflict');
  assert.equal(r.bucket, 'wave_overrides');
  // чужой элемент, добавленный в конец, не мешает и остаётся при своём соседе
  const plus = { ...moved, wave_overrides: [...moved.wave_overrides, { override_id: 'x', action: 'pin', event_ids: ['q'] }] };
  const ok = apply_unit(plus, u, 'undo');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ws.wave_overrides.map((o) => o.override_id), ['a', 'x', 'b', 'c'], 'чужая «x» стояла за «a» и едет вместе с ней');
});

test('TST-16 REQ-090 дефект 3: перестановка в любой корзине (правила), записанная общим путём, — действие пользователя; вместе с правкой в другой корзине — одна единица', () => {
  const p = make_page(clone(G));
  const ws0 = p.st.ws;
  const reversed = { ...ws0, rules: ws0.rules.slice().reverse() };
  assert.equal(p.ctx.set_ws(reversed, { reason: 'upsert_rule' }).ok, true);
  assert.deepEqual(p.deps.undo.size(), { undo: 1, redo: 0 }, 'перестановка записана');
  assert.deepEqual(p.deps.undo.peek_undo(), { kind: 'rule' });
  assert.equal(p.deps.undo.undo(p.ctx).ok, true);
  assert.equal(canon(p.st.ws), canon(ws0));
  assert.equal(p.deps.undo.redo(p.ctx).ok, true);
  assert.equal(canon(p.st.ws), canon(reversed));
  // перестановка + правка параметра за один шаг
  const both = { ...reversed, rules: reversed.rules.slice().reverse(), params: { ...reversed.params, buffer_minor: 61000 } };
  assert.equal(p.ctx.set_ws(both, { reason: 'commit_edits' }).ok, true);
  assert.deepEqual(p.deps.undo.size(), { undo: 2, redo: 0 });
  assert.equal(p.deps.undo.undo(p.ctx).ok, true);
  assert.equal(canon(p.st.ws), canon(reversed));
});

// ── 4. null параметра при чтении журнала ──────────────────────────────────────────────────────────────────────────────

test('TST-16 REQ-090 дефект 4: параметр, заданный впервые и отменённый, пишется в журнал null — при чтении журнала ключа нет, inputs_hash после перезагрузки равен сеансовому', () => {
  const p = make_page(clone(G));
  void p.ctx.journal; // журнал создан до правок: он видит и действие, и его отмену
  ed(p, { type: 'set_param', key: 'fx.stale_days', value: 5 });
  assert.equal(p.deps.undo.undo(p.ctx).ok, true);
  assert.equal(Object.hasOwn(p.st.ws.params, 'fx.stale_days'), false, 'в сеансе ключа нет');
  const events = p.ctx.journal.events();
  const state = reduce(effective_events(events));
  assert.equal(state.params['fx.stale_days'], null, 'журнал не умеет удалять ключ: в его состоянии null (state_hash журнала — отдельная оговорка)');
  const back = events_to_ws(events, p.st.ws);
  assert.equal(Object.hasOwn(back.params, 'fx.stale_days'), false, 'после чтения журнала ключа нет');
  assert.equal(canon(back.params), canon(p.st.ws.params));
  assert.equal(ih(back), ih(p.st.ws), 'inputs_hash после перезагрузки равен сеансовому');
});

test('TST-16 REQ-090 дефект 4: каждый параметр из PARAM_RANGES — необнуляемый возвращается из журнала без ключа, с допустимым null (буфер, порог волны, валюта решения) остаётся null; чужие ключи не трогаем', () => {
  const nullable = Object.entries(PARAM_RANGES).filter(([, r]) => r.nullable === true).map(([k]) => k).sort();
  assert.deepEqual(nullable, ['buffer_minor', 'decision_currency', 'wave.threshold_minor'], 'допустимый null — у трёх параметров');
  const w = clone(G);
  w.params = { ...w.params };
  for (const k of Object.keys(PARAM_RANGES)) w.params[k] = null;
  const back = events_to_ws(ws_to_events(w));
  for (const k of Object.keys(PARAM_RANGES)) {
    if (nullable.includes(k)) assert.equal(back.params[k], null, k + ' — допустимый null сохранён');
    else assert.equal(Object.hasOwn(back.params, k), false, k + ' — «параметра нет»');
  }
  // параметр не из таблицы диапазонов (чужой) не трогаем
  const w2 = clone(G);
  w2.params = { ...w2.params, 'custom.thing': null };
  assert.equal(events_to_ws(ws_to_events(w2)).params['custom.thing'], null);
});

test('TST-16 REQ-090 дефект 4: допустимый null и обычные значения параметров проходят «действие → отмена → возврат → чтение журнала» без изменений', () => {
  const p = make_page(clone(G));
  void p.ctx.journal;
  ed(p, { type: 'set_param', key: 'buffer_minor', value: null });
  ed(p, { type: 'set_param', key: 'horizon_days', value: 40 });
  assert.equal(p.deps.undo.undo(p.ctx).ok, true);
  assert.equal(p.deps.undo.redo(p.ctx).ok, true);
  const back = events_to_ws(p.ctx.journal.events(), p.st.ws);
  assert.equal(canon(back.params), canon(p.st.ws.params));
  assert.equal(back.params.buffer_minor, null);
  assert.equal(ih(back), ih(p.st.ws));
});

// ── 5. одно правило ключа — у моста ──────────────────────────────────────────────────────────────────────────────────

test('TST-16 REQ-090 дефект 5: мост экспортирует item_key и NON_META_KEYS; поля идентификаторов в UNDO_*_BUCKETS совпадают с мостом', () => {
  assert.equal(typeof item_key, 'function');
  assert.ok(NON_META_KEYS instanceof Set);
  assert.deepEqual([...NON_META_KEYS].sort(), ['params', ...BUCKETS.map((b) => b.ws_key)].sort());
  for (const [bucket, field] of UNDO_ARRAY_BUCKETS) {
    const b = BRIDGE.get(bucket);
    assert.ok(b !== undefined, 'корзина есть в мосте: ' + bucket);
    if (typeof field === 'string') assert.equal(field, b.id_field, 'поле идентификатора корзины ' + bucket);
    else assert.ok(['overrides', 'tax_rules'].includes(bucket), 'функцию ключа имеют только составные корзины: ' + bucket);
  }
  assert.ok(UNDO_EXTRA_BUCKETS.length > 0);
});

test('TST-16 REQ-090 дефект 5: стопка ключует элементы как мост — пустой идентификатор, не-строка, версия налогового правила не целая, пропуск без даты не отслеживаются', () => {
  const cases = [
    ['accounts', { account_id: 'a1' }, 'a1'],
    ['accounts', { account_id: '' }, null],
    ['rules', { rule_id: 7 }, null],
    ['rules', {}, null],
    ['facts', { event_id: '' , id: 'via_id' }, null],
    ['facts', { cash_event_id: 'c1' }, 'c1'],
    ['facts', { entity_id: 'e1' }, 'e1'],
    ['overrides', { rule_id: 'r1', nominal_date: '2026-10-10' }, 'r1@2026-10-10'],
    ['overrides', { rule_id: 'r1' }, null],
    ['tax_rules', { tax_rule_id: 't1', version: 2 }, 't1@2'],
    ['tax_rules', { tax_rule_id: 't1', version: 1.5 }, null],
    ['tax_rules', { tax_rule_id: '', version: 1 }, null],
  ];
  for (const [bucket, item, want] of cases) {
    assert.equal(item_key(BRIDGE.get(bucket), item), want, `мост: ${bucket} ${JSON.stringify(item)}`);
    const w = { ...clone(G), [bucket]: [item] };
    const u = diff_unit({ ...clone(G), [bucket]: [] }, w);
    if (want === null) assert.equal(u?.changes.some((c) => c.bucket === bucket) ?? false, false, `${bucket} ${JSON.stringify(item)} — не ключ: единицы по корзине нет`);
    else {
      assert.equal(u.changes.filter((c) => c.bucket === bucket).length, 1, `${bucket} ${JSON.stringify(item)} — отслеживается`);
      assert.equal(u.changes.find((c) => c.bucket === bucket).key, want);
    }
  }
});

test('TST-16 REQ-090 дефект 5: метаполя — все не-корзинные поля верхнего уровня по списку моста; корзины из моста (в том числе debts, profiles) метаполями не считаются', () => {
  const w0 = clone(G);
  const w1 = { ...w0, as_of: '2026-10-04', brand_new_field: 'x', debts: [{ debt_id: 'd1' }], profiles: [{ profile_id: 'p1' }] };
  const u = diff_unit(w0, w1);
  const meta = u.changes.filter((c) => c.bucket === 'meta').map((c) => c.key);
  assert.deepEqual(meta, ['brand_new_field']);
  assert.ok(u.changes.some((c) => c.bucket === 'debts') && u.changes.some((c) => c.bucket === 'profiles'));
  assert.equal(apply_unit(w1, { changes: [{ bucket: 'meta', key: 'debts', before: null, after: { value: [] } }] }, 'redo').ok, false, 'корзина — не метаполе');
});

test('TST-16 REQ-090 дефект 5: в undo.mjs нет собственных копий правила ключа моста (составные ключи и список не-метаполей берутся из ws_bridge)', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'demo', 'undo.mjs'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/**')).join('\n');
  assert.equal(/\+\s*'@'\s*\+/.test(src), false, 'нет сборки составного ключа вручную');
  assert.equal(/const NON_META_KEYS\s*=/.test(src), false, 'нет своего списка не-метаполей');
  assert.match(src, /item_key as bridge_item_key/);
  assert.match(src, /NON_META_KEYS\s*\}\s*from '\.\/ws_bridge\.mjs'/);
});
