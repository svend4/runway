// readonly_open.test.mjs — FP-17, REQ-016: файл НОВЕЕ известного формата (или с записями новее известных версий) открывается «только для просмотра».
// Покрывает: engine/io_readonly.mjs (open_readonly без апкаста и без записи, format_status, workspace_format_info, event_unreadable_reason, коды отказов);
// учебная фикстура tests/fixtures/journal-v2-draft.json (состояние по читаемым записям = golden v1; SHA-256 файла до и после открытия совпадает);
// inspect_import (read_only, read_only_info, engine, прежний отказ, когда читать нечего); среда хранения (restore отказывает, open_readonly ничего не пишет в
// хранилище, «Продолжить с сохранённого» выводит из режима); реестр расширений (запись отклоняется до страницы и журнала, понятный текст, выход из режима,
// автоопределение набора с полем format новее известного). Браузер не используется.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

import { ENGINE_VERSION, canon, state_hash, analyze } from '../engine/index.mjs';
import { read_journal_json, import_json } from '../engine/io.mjs';
import { open_readonly, format_status, workspace_format_info, event_unreadable_reason, KNOWN_FORMAT_VERSION } from '../engine/io_readonly.mjs';
import { validate_journal } from '../engine/validate_ws.mjs';
import { export_journal_copy, events_of_ws, inspect_import, hash_of_events } from '../demo/data_actions.mjs';
import { create_memory_store, create_memory_backing, create_lock } from '../demo/store.mjs';
import { create_runtime } from '../demo/data_runtime.mjs';
import { create_ext } from '../demo/ext.mjs';
import { t } from '../demo/i18n.mjs';
import { seeded_ports } from '../demo/ids.mjs';
import { apply_edit } from '../demo/ws_edit.mjs';

const FIX = (name) => fs.readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8');
const G = JSON.parse(fs.readFileSync(new URL('../data/g001.json', import.meta.url), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const sha = (text) => crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const GOLDEN_V1 = 'f4b11682044eb911add5a6223c88c67b0f07c504321081ac1bfcdfc8ad4dde88'; // hardening.test.mjs (REQ-016), не вывод проверяемого кода
const AT = '2026-10-05T08:00:00Z';

/** Копия набора G-001, «сохранённая более новой версией»: формат /2, версия движка 0.2.0, плюс записи, которых версия 1 прочитать не может. */
function newer_copy({ format = 'runway-journal/2', engine_version = '0.2.0', extra = true, only_extra = false } = {}) {
  const base = export_journal_copy(events_of_ws(G));
  const obj = JSON.parse(base.text);
  obj.format = format;
  obj.engine_version = engine_version;
  const last = obj.events.at(-1).seq;
  if (only_extra) obj.events = [];
  if (extra) {
    obj.events.push(
      { actor: 'user', entity_id: 'cat-food', event_id: 'ev-x1', payload: { category_id: 'cat-food', name: 'Продукты' }, recorded_at: AT, seq: last + 1, type: 'category.set', v: 1 },
      { actor: 'user', entity_id: 'tx-next', event_id: 'ev-x2', payload: { account_id: 'acc_main', amount: { currency: 'EUR', minor: -1999 }, date: '2026-10-03' }, recorded_at: AT, seq: last + 2, type: 'tx.posted', v: 2 },
    );
  }
  return { text: canon(obj), base };
}

// ── engine/io_readonly.mjs ───────────────────────────────────────────────────────────────────────────────────────────

test('REQ-016 FP-17 учебная фикстура runway-journal/2: open_readonly разбирает без апкаста и записи; читаемые записи дают golden-состояние версии 1; файл не меняется', () => {
  const text = FIX('journal-v2-draft.json');
  const hash_before = sha(text);
  const r = open_readonly(text);
  assert.deepEqual([r.read_only, r.newer_format, r.format, r.format_version, r.known_version], [true, true, 'runway-journal/2', 2, 1]);
  assert.equal(KNOWN_FORMAT_VERSION, 1);
  assert.equal(r.engine_version, '0.2.0');
  assert.equal(r.events.length, 16);
  assert.equal(r.usable_events.length, 14, 'читаемы 14 записей версии 1');
  assert.deepEqual(r.skipped, { unknown_type: 1, newer_version: 1, bad_event: 0, total: 2 });
  assert.equal(hash_of_events(r.usable_events), GOLDEN_V1, 'состояние по читаемым записям = golden фикстуры журнала v1');
  assert.deepEqual(r.usable_events.map((e) => e.event_id), JSON.parse(FIX('journal-v1.json')).events.map((e) => e.event_id));
  // «файл не меняется при открытии» (критерий REQ-016): текст и его SHA-256 прежние; сам разбор не мутирует вход
  assert.equal(sha(FIX('journal-v2-draft.json')), hash_before);
  assert.equal(sha(text), hash_before);
  // прежние строгие пути остаются строгими: сворачивать и «импортировать» файл новее известного нельзя
  assert.throws(() => read_journal_json(text), (e) => e.code === 'E_SCHEMA' && e.ctx.reason === 'newer_format');
  assert.throws(() => import_json(text), (e) => e.code === 'E_SCHEMA' && e.ctx.reason === 'newer_format');
  // validate_journal называет тот же случай флагом read_only
  const v = validate_journal(JSON.parse(text));
  assert.equal(v.read_only, true);
});

test('REQ-016 FP-17 open_readonly: файл текущего формата — те же записи, что у read_journal_json, read_only = false; повторный разбор даёт то же', () => {
  const text = FIX('journal-v1.json');
  const r = open_readonly(text);
  assert.deepEqual([r.read_only, r.newer_format, r.format_version, r.skipped.total], [false, false, 1, 0]);
  assert.deepEqual(r.events, read_journal_json(text).events);
  assert.deepEqual(r.usable_events, r.events);
  assert.deepEqual(open_readonly(text), r);
  assert.equal(hash_of_events(r.usable_events), GOLDEN_V1);
  assert.equal(r.engine_version, '0.1.0');
});

test('REQ-016 FP-17 open_readonly: запись новее известной в файле ТЕКУЩЕГО формата → read_only и пропуск; запись без v в текущем формате — повреждение (E_SCHEMA), в новом формате — пропуск', () => {
  const obj = JSON.parse(FIX('journal-v1.json'));
  const with_newer = clone(obj);
  with_newer.events[3].v = 2;
  const r = open_readonly(JSON.stringify(with_newer));
  assert.deepEqual([r.read_only, r.newer_format, r.skipped.newer_version, r.usable_events.length], [true, false, 1, 13]);
  const with_unknown = clone(obj);
  with_unknown.events[3].type = 'budget.plan_set';
  assert.deepEqual([open_readonly(JSON.stringify(with_unknown)).skipped.unknown_type, open_readonly(JSON.stringify(with_unknown)).read_only], [1, true]);
  const no_v = clone(obj);
  delete no_v.events[3].v;
  assert.throws(() => open_readonly(JSON.stringify(no_v)), (e) => e.code === 'E_SCHEMA' && e.ctx.reason === 'bad_event');
  const newer_no_v = clone(no_v);
  newer_no_v.format = 'runway-journal/2';
  const r2 = open_readonly(JSON.stringify(newer_no_v));
  assert.deepEqual([r2.read_only, r2.skipped.bad_event, r2.usable_events.length], [true, 1, 13]);
});

test('REQ-016 FP-17 open_readonly: недоверенный файл — отказ кодом E_SCHEMA с причиной, без текста файла', () => {
  const secret = 'секретная-заметка-4730';
  const reason = (text) => { try { open_readonly(text); } catch (e) { return [e.code, e.ctx.reason]; } return null; };
  assert.deepEqual(reason('{"секрет": ' + secret), ['E_SCHEMA', 'bad_json']);
  assert.deepEqual(reason('[1,2]'), ['E_SCHEMA', 'not_object']);
  assert.deepEqual(reason('null'), ['E_SCHEMA', 'not_object']);
  for (const f of ['runway-journal/0', 'runway-journal/01', 'runway-journal/1.5', 'runway-journal', 'journal/2', 5, null]) assert.deepEqual(reason(JSON.stringify({ format: f, events: [] })), ['E_SCHEMA', 'bad_format'], String(f));
  assert.deepEqual(reason(JSON.stringify({ events: [] })), ['E_SCHEMA', 'bad_format']);
  assert.deepEqual(reason(JSON.stringify({ format: 'runway-journal/2', events: 'нет' })), ['E_SCHEMA', 'events_required']);
  assert.deepEqual(reason(JSON.stringify({ format: 'runway-journal/2', events: [{ type: 'x', event_id: 'e', seq: 1.5 }] })), ['E_SCHEMA', 'seq_required']);
  assert.deepEqual(reason(JSON.stringify({ format: 'runway-journal/2', events: [{ type: 'x', seq: 1 }] })), ['E_SCHEMA', 'bad_event']);
  assert.deepEqual(reason(JSON.stringify({ format: 'runway-journal/2', events: [5] })), ['E_SCHEMA', 'bad_event']);
  try { open_readonly(JSON.stringify({ format: 'runway-journal/9' + secret, events: [] })); } catch (e) { assert.ok(!JSON.stringify(e.ctx).includes(secret) || JSON.stringify(e.ctx).length < 120, 'формат из файла в ошибке обрезан'); }
  // пустой журнал нового формата — не ошибка: читать просто нечего
  const empty = open_readonly(JSON.stringify({ format: 'runway-journal/3', events: [] }));
  assert.deepEqual([empty.read_only, empty.events.length, empty.usable_events.length, empty.format_version], [true, 0, 0, 3]);
});

test('REQ-016 FP-17 format_status, workspace_format_info, event_unreadable_reason', () => {
  assert.deepEqual(format_status('runway-journal/1'), { valid: true, version: 1, newer: false });
  assert.deepEqual(format_status('runway-journal/2'), { valid: true, version: 2, newer: true });
  assert.deepEqual(format_status('runway-journal/12'), { valid: true, version: 12, newer: true });
  for (const bad of ['runway-journal/0', 'runway-journal/-1', 'runway-journal/1 ', 'x', '', undefined, null, 1]) assert.deepEqual(format_status(bad), { valid: false, version: null, newer: false }, String(bad));
  assert.equal(workspace_format_info(G).newer, false);
  assert.equal(workspace_format_info({ ...G, format: 'runway-journal/3' }).newer, true);
  assert.deepEqual(workspace_format_info({ format: 'runway-journal/2' }), { format: 'runway-journal/2', valid: true, version: 2, newer: true });
  assert.equal(workspace_format_info({ format: 'мусор' }).valid, false);
  assert.equal(workspace_format_info({}), null);
  assert.equal(workspace_format_info(null), null);
  assert.equal(workspace_format_info({ format: 'x'.repeat(100) }).format.length, 40);
  assert.equal(event_unreadable_reason({ type: 'tx.posted', v: 1 }), null);
  assert.equal(event_unreadable_reason({ type: 'tx.posted', v: 2 }), 'newer_version');
  assert.equal(event_unreadable_reason({ type: 'category.set', v: 1 }), 'unknown_type');
  assert.equal(event_unreadable_reason({ type: 'tx.posted' }), 'bad_event');
  assert.equal(event_unreadable_reason({ type: 'tx.posted', v: 0 }), 'bad_event');
  assert.equal(event_unreadable_reason({ type: 'tx.posted', v: 1.5 }), 'bad_event');
  assert.equal(event_unreadable_reason(null), 'bad_event');
  assert.equal(event_unreadable_reason({ type: 'toString', v: 1 }), 'unknown_type', 'имя из прототипа объекта — не известный тип');
  assert.equal(event_unreadable_reason({ type: 'tx.posted', v: 2 }, { current: { 'tx.posted': 2 } }), null, 'реестр с шагом v2 читает такую запись');
});

// ── inspect_import ───────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-016 FP-17 inspect_import: копия нового формата открывается «только для просмотра»: прогноз G-001 тот же, записи новее пропущены, версия движка названа', () => {
  const { text, base } = newer_copy();
  const hash_file = sha(text);
  const r = inspect_import(text);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.kind, r.read_only, r.format, r.engine_version], ['journal', true, 'runway-journal/2', '0.2.0']);
  assert.deepEqual(r.read_only_info, { newer_format: true, format: 'runway-journal/2', format_version: 2, known_version: 1, skipped: 2, source: 'file' });
  assert.equal(r.hash, base.state_hash, 'состояние по читаемым записям = состояние исходной копии');
  assert.deepEqual(r.counts, base.counts);
  assert.equal(r.events.length, base.count, 'в events только читаемые записи');
  const a = analyze(r.ws, { as_of: r.ws.as_of });
  const a0 = analyze(G, { as_of: G.as_of });
  assert.equal(a.series.plan.opening_minor, 400000);
  assert.equal(a.series.plan.close.at(-1), 340000);
  assert.deepEqual(a.series.worse.trough, a0.series.worse.trough, 'прогноз «если хуже» тот же');
  assert.deepEqual(r.engine, { status: 'newer', warn: true, file: '0.2.0', current: ENGINE_VERSION }, 'версия движка в файле новее — предупреждение, не отказ');
  assert.equal(sha(text), hash_file, 'текст не менялся');
  // обычный файл тех же данных — без read_only
  assert.equal(inspect_import(base.text).read_only, undefined);
});

test('REQ-016 FP-17 inspect_import: запись новее известной в файле ТЕКУЩЕГО формата — тоже просмотр (newer_format = false)', () => {
  const { text } = newer_copy({ format: 'runway-journal/1', engine_version: ENGINE_VERSION });
  const r = inspect_import(text);
  assert.equal(r.ok, true);
  assert.deepEqual([r.read_only, r.read_only_info.newer_format, r.read_only_info.skipped, r.engine.status], [true, false, 2, 'same']);
});

test('REQ-016 FP-17 inspect_import: читать нечего (новый формат без записей, все записи новее, неизвестные типы) — прежний отказ E_SCHEMA; мусорный формат — E_SCHEMA', () => {
  const r1 = inspect_import(JSON.stringify({ format: 'runway-journal/2', events: [] }));
  assert.deepEqual([r1.ok, r1.error, r1.ctx?.reason], [false, 'E_SCHEMA', 'newer_format']);
  const only_new = clone(JSON.parse(FIX('journal-v1.json')));
  only_new.events = only_new.events.map((e) => ({ ...e, v: 2 }));
  const r2 = inspect_import(JSON.stringify(only_new));
  assert.deepEqual([r2.ok, r2.error, r2.ctx?.reason], [false, 'E_SCHEMA', 'newer_version']);
  const unknown = clone(JSON.parse(FIX('journal-v1.json')));
  unknown.events = unknown.events.map((e) => ({ ...e, type: 'нет.такого' }));
  const r3 = inspect_import(JSON.stringify(unknown));
  assert.deepEqual([r3.ok, r3.error, r3.ctx?.reason], [false, 'E_SCHEMA', 'unknown_type']);
  const r4 = inspect_import(JSON.stringify({ format: 'runway-journal/0', events: [] }));
  assert.deepEqual([r4.ok, r4.error], [false, 'E_SCHEMA']);
});

test('REQ-016 FP-17 inspect_import: рабочая область (набор данных) с полем format новее известного — просмотр; с форматом /1 — как раньше', () => {
  const v2 = { ...clone(G), format: 'runway-journal/2' };
  const r = inspect_import(JSON.stringify(v2));
  assert.deepEqual([r.ok, r.kind, r.read_only, r.read_only_info.newer_format, r.read_only_info.format_version], [true, 'workspace', true, true, 2]);
  assert.deepEqual(r.ws, v2, 'рабочая область не меняется');
  const v1 = inspect_import(JSON.stringify(G));
  assert.deepEqual([v1.ok, v1.kind, v1.read_only], [true, 'workspace', undefined]);
});

// ── среда хранения ───────────────────────────────────────────────────────────────────────────────────────────────────

function make_page(ws0) {
  let n = 0;
  const page = {
    ws: ws0, renders: 0, today: '2026-10-05', sets: [], adopts: [],
    get_ws: () => page.ws,
    set_ws: (ws, o) => { page.ws = ws; page.sets.push(o?.reason ?? 'edit'); return { ok: true }; },
    refresh: () => { page.renders += 1; },
  };
  page.ports = { next_id: () => 'p~' + (++n), recorded_at: () => AT };
  return page;
}

function runtime_on(page, store) {
  let rt = null;
  rt = create_runtime({
    store, store_kind: 'memory', lock: create_lock({ locks: null }), channel: null, storage_manager: { persisted: async () => true }, installed: () => true,
    today: () => page.today, ports: page.ports, get_ws: page.get_ws, set_ws: page.set_ws, refresh: page.refresh,
    // как ext.ctx.adopt: подмена набора целиком; подписчикам уходит `adopt` с источником (ext.reset)
    adopt: (ws, o) => { page.adopts.push(o); page.ws = ws; rt.on_change({ reason: 'adopt', ws, source: o?.source }); return { ok: true }; },
  });
  return rt;
}

const fact = (i) => ({ type: 'add_fact', fact: { event_id: 'u_' + i, account_id: 'acc_main', date: '2026-10-03', amount_minor: -(100 + i), currency: 'EUR', tag: 'x' } });

test('REQ-016 FP-17 «Восстановить» файл нового формата отказывает (read_only), хранилище не трогается; «Открыть только для просмотра» ничего не пишет и приостанавливает запись', async () => {
  const backing = create_memory_backing();
  const page = make_page(clone(G));
  const rt = runtime_on(page, create_memory_store({ backing }));
  await rt.init();
  const ws1 = apply_edit(page.ws, fact(1), { new_id: (p) => p + '_1' }).ws;
  page.ws = ws1;
  await rt.on_change({ reason: 'add_fact', ws: ws1 });
  assert.equal(rt.status().mode, 'active');
  const stored_before = canon(await create_memory_store({ backing }).load());

  const parsed = inspect_import(newer_copy().text);
  assert.equal(parsed.read_only, true);
  const refused = await rt.restore(parsed);
  assert.deepEqual([refused.ok, refused.error], [false, 'read_only']);
  assert.equal(canon(await create_memory_store({ backing }).load()), stored_before, 'restore не записал в хранилище');

  const opened = await rt.open_readonly(parsed);
  await rt.flush();
  assert.deepEqual([opened.ok, opened.skipped], [true, 2]);
  assert.equal(page.adopts.length, 1);
  assert.deepEqual([page.adopts[0].source, page.adopts[0].read_only.newer_format, page.adopts[0].read_only.skipped], ['readonly', true, 2]);
  assert.equal(page.ws, parsed.ws, 'на страницу выставлен набор из файла');
  const st = rt.status();
  assert.deepEqual([st.mode, st.pause_reason], ['paused', 'readonly'], 'запись приостановлена по причине «только просмотр»');
  assert.equal(canon(await create_memory_store({ backing }).load()), stored_before, 'open_readonly тоже ничего не записал');
  assert.equal(st.engine.current, ENGINE_VERSION);

  // выход из режима: «Продолжить с сохранённого» возвращает сохранённое, set_ws идёт с причиной restore
  const cont = await rt.continue_saved();
  assert.equal(cont.ok, true);
  assert.equal(page.sets.at(-1), 'restore');
  assert.equal(rt.status().mode, 'active');

  // обычный (не read_only) разобранный файл в open_readonly не принимается
  const plain = inspect_import(newer_copy().base.text);
  assert.deepEqual(await rt.open_readonly(plain), { ok: false, error: 'bad_file' });
  assert.deepEqual(await rt.open_readonly({ ok: false }), { ok: false, error: 'bad_file' });
});

test('REQ-016 FP-17 open_readonly при пустом хранилище: режим «fresh» остаётся, в хранилище по-прежнему пусто', async () => {
  const backing = create_memory_backing();
  const page = make_page(clone(G));
  const rt = runtime_on(page, create_memory_store({ backing }));
  assert.equal((await rt.init()).mode, 'fresh');
  const r = await rt.open_readonly(inspect_import(newer_copy().text));
  await rt.flush();
  assert.equal(r.ok, true);
  assert.equal(rt.status().mode, 'fresh');
  assert.equal((await create_memory_store({ backing }).stat()).count, 0, 'до правки в хранилище пусто');
});

// ── реестр расширений ────────────────────────────────────────────────────────────────────────────────────────────────

function make_ext_env(ws0 = clone(G)) {
  const e = create_ext({ ports: seeded_ports({ seed: 17 }) });
  const st = { ws: ws0, sets: [], notes: [], renders: 0 };
  e.bind_host({
    get_ws: () => st.ws, get_model: () => null, lang: () => 'ru', mode: () => 'worse', fmt: () => null,
    set_ws: (next, o) => { st.sets.push(o?.reason ?? 'edit'); st.ws = next; return { ok: true }; },
    adopt: (next, o) => { st.ws = next; e.reset(next, o); return { ok: true }; },
    render: () => { st.renders += 1; },
    notify: (m, k) => { st.notes.push([m, k]); },
  });
  return { e, ctx: e.ctx, st };
}

test('REQ-016 FP-17 реестр: в режиме «только чтение» запись (ctx.set_ws, ctx.edit) отклоняется до страницы и журнала; текст понятный; данные и журнал прежние', () => {
  const { e, ctx, st } = make_ext_env();
  assert.equal(ctx.read_only(), null);
  const ok = ctx.edit({ type: 'set_param', key: 'horizon_days', value: 90 });
  assert.equal(ok.ok, true);
  assert.deepEqual(st.sets, ['set_param']);
  const journal_len = ctx.journal.length;
  const ws_before = st.ws;

  e.reset(st.ws, { read_only: { newer_format: true, format: 'runway-journal/2', format_version: 2, known_version: 1, skipped: 2, source: 'readonly' } });
  const ro = ctx.read_only();
  assert.deepEqual({ ...ro }, { newer_format: true, format: 'runway-journal/2', format_version: 2, known_version: 1, skipped: 2, source: 'readonly' });
  assert.ok(Object.isFrozen(ro), 'описание режима неизменяемо');

  const r1 = ctx.set_ws({ ...st.ws, params: { ...st.ws.params, horizon_days: 10 } });
  assert.deepEqual([r1.ok, r1.error.code, r1.error.ctx.reason], [false, 'E_SCHEMA', 'read_only']);
  const r2 = ctx.edit({ type: 'set_param', key: 'horizon_days', value: 30 });
  assert.deepEqual([r2.ok, r2.error.code, r2.error.ctx.reason], [false, 'E_SCHEMA', 'read_only'], 'правка отклонена раньше проверки: пользователь не видит технический отказ');
  const r3 = ctx.edit({ type: 'add_fact', fact: { account_id: 'нет такого' } });
  assert.equal(r3.error.ctx.reason, 'read_only', 'даже недопустимая правка получает ответ про режим, а не про поле');
  assert.equal(st.sets.length, 1, 'страница не вызывалась');
  assert.equal(st.ws, ws_before, 'данные прежние');
  assert.equal(ctx.journal.length, journal_len, 'журнал прежний');
  assert.equal(st.notes.filter(([m]) => m === t('ru', 'ro.refused')).length, 3, 'каждый отказ сопровождается понятным текстом');
  assert.match(t('ru', 'ro.refused'), /только для просмотра/);
  assert.match(t('en', 'ro.refused'), /viewing only/);
  assert.ok(st.notes.every(([, k]) => k === 'error'));
});

test('REQ-016 FP-17 реестр: выход из режима — подмена набора (reset/adopt) и «restore»; обычная правка снова проходит', () => {
  const { e, ctx, st } = make_ext_env();
  const info = { newer_format: true, format: 'runway-journal/2', format_version: 2, known_version: 1, skipped: 0, source: 'readonly' };
  e.reset(st.ws, { read_only: info });
  assert.notEqual(ctx.read_only(), null);
  // restore — не правка: заменяет открытый набор сохранёнными данными и снимает режим
  const other = clone(G);
  const r = ctx.set_ws(other, { reason: 'restore' });
  assert.equal(r.ok, true);
  assert.equal(ctx.read_only(), null);
  assert.equal(ctx.edit({ type: 'set_param', key: 'horizon_days', value: 40 }).ok, true);
  // подмена набора целиком
  e.reset(st.ws, { read_only: info });
  assert.notEqual(ctx.read_only(), null);
  e.reset(clone(G), { source: 'dataset' });
  assert.equal(ctx.read_only(), null, 'новый набор данных — обычный режим');
  // ctx.adopt проходит через хост
  assert.equal(ctx.adopt(clone(G), { source: 'readonly', read_only: info }).ok, true);
  assert.notEqual(ctx.read_only(), null);
  assert.equal(ctx.read_only().source, 'readonly');
  // restore, не прошедший на странице, режим не снимает
  const failing = create_ext({ ports: seeded_ports({ seed: 18 }) });
  failing.bind_host({ get_ws: () => G, get_model: () => null, lang: () => 'ru', mode: () => 'worse', set_ws: () => ({ ok: false, error: { code: 'E_NO_RATE', ctx: null } }), render() {}, notify() {} });
  failing.reset(G, { read_only: info });
  assert.equal(failing.ctx.set_ws(G, { reason: 'restore' }).ok, false);
  assert.notEqual(failing.ctx.read_only(), null, 'режим остался: набор не заменён');
});

test('REQ-016 FP-17 реестр: набор с полем format новее известного определяется сам (reset без read_only); значения режима очищаются и ограничиваются', () => {
  const { e, ctx } = make_ext_env();
  e.reset({ ...clone(G), format: 'runway-journal/2' }, { source: 'file' });
  assert.deepEqual({ ...ctx.read_only() }, { newer_format: true, format: 'runway-journal/2', format_version: 2, known_version: 1, skipped: 0, source: 'workspace' });
  e.reset(clone(G), {});
  assert.equal(ctx.read_only(), null, 'формат /1 — обычный режим');
  e.reset({ ...clone(G), format: 'runway-journal/zzz' }, {});
  assert.equal(ctx.read_only(), null, 'нечитаемое поле format режим «только чтение» не включает (его ловит validate_ws)');
  e.reset(clone(G), { read_only: { newer_format: 'да', format: 'x'.repeat(100), format_version: 1.5, known_version: 'a', skipped: -5, source: 'y'.repeat(50) } });
  const ro = ctx.read_only();
  assert.deepEqual([ro.newer_format, ro.format.length, ro.format_version, ro.known_version, ro.skipped, ro.source.length], [false, 40, null, 1, 0, 20]);
});

test('REQ-016 FP-17 «правка отклонена» вне режима работает как раньше: недопустимая правка — код движка, текст «Правка отклонена»', () => {
  const { ctx, st } = make_ext_env();
  const r = ctx.edit({ type: 'add_fact', fact: { account_id: 'нет такого', date: '2026-10-03', amount_minor: -1 } });
  assert.equal(r.ok, false);
  assert.notEqual(r.error.ctx?.reason, 'read_only');
  assert.ok(st.notes.some(([m]) => m.startsWith('Правка отклонена')));
});
