// as_of.test.mjs — «сегодня» (дата расчёта ws.as_of): вид правки set_as_of, разбор даты, модель карточки, форма на экране «Настройки», местная дата с часов.
// Покрывает хвост приёмки волны 1 (FP-04 №3, «управление сегодня»): после сдвига даты быстрый ввод пишет факт на нужный день, плашка «данные устарели»
// появляется по канону (возраст остатка > 7 → плашка, > 21 → блок), журнал получает запись метаданных, числа G-001 на исходной дате не меняются.
// TST-16 (журнал), TST-38 (круг ws → журнал → ws), TST-57 (плашка свежести), TST-58 (форма: ввод, ошибки, подпись), TST-59 (нет innerHTML и inline-стилей).
// DOM в Node подменён заглушкой (как в settings.test.mjs): проверяется логика и связка с настоящим ext.mjs/app.mjs, а не вёрстка. Браузер не используется.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ── заглушка DOM ────────────────────────────────────────────────────────────────────────────────────────────────────

class FakeNode {
  constructor(tag) {
    this.nodeType = 1; this.tagName = tag; this.attrs = {}; this.children = []; this.listeners = {}; this.className = ''; this._text = ''; this._value = ''; this._sel = null;
  }
  get textContent() { return this.children.length === 0 ? this._text : this.children.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get value() { return this._value; }
  set value(v) { this._value = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this._value = String(v); }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  append(...kids) { for (const k of kids) this.children.push(k); this._text = ''; }
  replaceChildren(...kids) { this.children = []; this._text = ''; this.append(...kids); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  focus() { this.focused = true; }
  querySelectorAll() { return []; }
  walk(fn) { fn(this); for (const c of this.children) if (c.nodeType === 1) c.walk(fn); }
}
globalThis.document = {
  createElement: (t) => new FakeNode(t),
  createElementNS: (_ns, t) => new FakeNode(t),
  createTextNode: (data) => ({ nodeType: 3, data }),
  getElementById: () => null,
  head: new FakeNode('head'),
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.resolve(HERE, '..');
const DEMO = path.join(PROTO, 'demo');
const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);

const { analyze } = await imp('engine', 'index.mjs');
const APP = await imp('demo', 'app.mjs');
const { create_ext } = await imp('demo', 'ext.mjs');
const { apply_edit, register_edit, list_edit_types } = await imp('demo', 'ws_edit.mjs');
const { seeded_ports, local_today, clock_ports } = await imp('demo', 'ids.mjs');
const { events_to_ws } = await imp('demo', 'ws_bridge.mjs');
const AO = await imp('demo', 'as_of.mjs');
const ST = await imp('demo', 'settings.mjs');

const load = (name) => JSON.parse(fs.readFileSync(path.join(PROTO, 'data', name), 'utf8'));
const G = load('g001.json');
const GAP = load('g001-gap.json');
const MS = (y, m, d, hh = 0, mm = 0) => Date.UTC(y, m - 1, d, hh, mm);

// пакет подключается «как в приложении»: правка set_as_of, строки, экран
const PACK_EXT = create_ext({ ports: seeded_ports({ seed: 3 }) });
await PACK_EXT.load_packs({ pack_fp03: () => import(pathToFileURL(path.join(DEMO, 'pack_fp03.mjs')).href) });

function make_env(ws = G, { lang = 'ru' } = {}) {
  const e = create_ext({ ports: seeded_ports({ seed: 5 }) });
  const st = { ws, lang, renders: 0, notes: [] };
  const build = (w) => APP.build_model(w, { lang: st.lang });
  st.model = build(ws);
  e.bind_host({
    get_ws: () => st.ws,
    get_model: () => st.model,
    lang: () => st.lang,
    mode: () => 'worse',
    fmt: () => APP.make_fmt(st.lang, st.model.cur, st.model.as_of_iso),
    set_ws: (next) => {
      let m;
      try { m = build(next); } catch (err) { return { ok: false, error: err }; }
      st.ws = next;
      st.model = m;
      return { ok: true };
    },
    render: () => { st.renders += 1; },
    notify: (m, k) => { st.notes.push([m, k]); },
  });
  return { e, ctx: e.ctx, st };
}

const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const by_id = (root, id) => find_all(root, (n) => n.attrs.id === id)[0];
const text_of = (n) => n.textContent;
const button_by_text = (root, re) => find_all(root, (n) => n.tagName === 'button' && re.test(n.textContent))[0];
const submit_form = (root, id) => { const f = by_id(root, id); assert.ok(f !== undefined, 'нет формы ' + id); f.listeners.submit[0]({ preventDefault() {} }); };

// ── разбор даты ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('TST-58 as_of: parse_as_of_text читает ГГГГ-ММ-ДД и ДД.ММ.ГГГГ, отвергает мусор, несуществующие и вне диапазона даты', () => {
  const ok = (s) => AO.parse_as_of_text(s);
  assert.deepEqual(ok('2026-10-14'), { ok: true, value: '2026-10-14' });
  assert.deepEqual(ok('  2026-10-14  '), { ok: true, value: '2026-10-14' }, 'пробелы по краям снимаются');
  assert.deepEqual(ok('14.10.2026'), { ok: true, value: '2026-10-14' });
  assert.deepEqual(ok('4.1.2026'), { ok: true, value: '2026-01-04' }, 'день и месяц без нуля');
  assert.deepEqual(ok('29.02.2028'), { ok: true, value: '2028-02-29' }, 'високосный год');
  for (const [text, reason] of [
    ['', 'empty'], ['   ', 'empty'], [null, 'empty'], [undefined, 'empty'], [20261014, 'empty'],
    ['2026-02-30', 'bad_date'], ['2026-13-01', 'bad_date'], ['29.02.2027', 'bad_date'], ['вчера', 'bad_date'], ['2026-1-4', 'bad_date'],
    ['04/10/2026', 'bad_date'], ['2026-10-14T00:00:00Z', 'bad_date'], ['1999-12-31', 'range'], ['2101-01-01', 'range'], ['01.01.1970', 'range'],
  ]) assert.deepEqual(ok(text), { ok: false, reason }, String(text));
  assert.equal(AO.AS_OF_MIN, '2000-01-01');
  assert.equal(AO.AS_OF_MAX, '2100-12-31');
});

test('as_of: latest_posted — самая поздняя дата фактов, остатков и записей в резервы; пусто и мусор не мешают', () => {
  assert.equal(AO.latest_posted(G), '2026-10-04', 'на G-001 последний остаток по якорю 2026-10-04 (факты — по 10-03)');
  assert.equal(AO.latest_posted({}), null);
  assert.equal(AO.latest_posted(null), null);
  const ws = { facts: [{ date: '2026-05-01' }, { date: 'вчера' }, null, { date: '2026-06-02' }], anchors: [{ date: '2026-04-01' }], allocations: [{ date: '2026-07-09' }] };
  assert.equal(AO.latest_posted(ws), '2026-07-09');
  assert.equal(AO.latest_posted({ facts: 'не массив', anchors: [{ date: '2026-01-02' }] }), '2026-01-02');
});

// ── вид правки set_as_of ────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-017 as_of: правка set_as_of подключена пакетом FP-03; применение не мутирует исходник, неизменённые корзины общие, ответ — только as_of', () => {
  assert.ok(list_edit_types().includes('set_as_of'), 'вид правки зарегистрирован пакетом');
  const frozen = Object.freeze({ ...G });
  const r = apply_edit(frozen, { type: 'set_as_of', date: '2026-10-14' });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.ws.as_of, '2026-10-14');
  assert.equal(frozen.as_of, '2026-10-04', 'исходная рабочая область не тронута');
  assert.deepEqual(r.touched, ['as_of']);
  for (const k of ['facts', 'anchors', 'rules', 'accounts', 'params']) assert.equal(r.ws[k], frozen[k], 'корзина ' + k + ' общая со старой');
  const same = apply_edit(G, { type: 'set_as_of', date: '2026-10-04' });
  assert.equal(same.ok, true);
  assert.deepEqual(same.touched, [], 'та же дата — ничего не изменилось');
});

test('REQ-017 TST-51 as_of: отказы set_as_of — коды канона без пользовательского текста в контексте', () => {
  const run = (edit, ws = G) => apply_edit(ws, edit);
  const e1 = run({ type: 'set_as_of', date: '2026-10-03' });
  assert.equal(e1.ok, false);
  assert.equal(e1.error.code, 'E_FUTURE_POSTED', 'раньше последнего остатка нельзя');
  assert.deepEqual([e1.error.ctx.reason, e1.error.ctx.latest], ['as_of_before_posted', '2026-10-04']);
  assert.equal(run({ type: 'set_as_of', date: '2026-02-30' }).error.code, 'E_BAD_DATE');
  assert.equal(run({ type: 'set_as_of', date: 20261014 }).error.code, 'E_BAD_DATE');
  assert.equal(run({ type: 'set_as_of' }).error.code, 'E_BAD_DATE');
  const far = run({ type: 'set_as_of', date: '2101-01-01' });
  assert.deepEqual([far.error.code, far.error.ctx.reason], ['E_SCHEMA', 'out_of_range']);
  const extra = run({ type: 'set_as_of', date: '2026-10-14', note: 'лишнее' });
  assert.deepEqual([extra.error.code, extra.error.ctx.reason], ['E_SCHEMA', 'unknown_field']);
  const proto = run(JSON.parse('{"type":"set_as_of","date":"2026-10-14","__proto__":{"x":1}}'));
  assert.equal(proto.ok, false, 'ключ __proto__ отвергается на входе');
  const long = run({ type: 'set_as_of', date: 'x'.repeat(500) });
  assert.equal(long.error.code, 'E_BAD_DATE');
  assert.ok(JSON.stringify(long.error).length < 400, 'значение в контексте обрезано до 40 знаков');
  // без проведённых записей раньше ставить можно: ограничение — только от них
  const bare = { ...G, facts: [], anchors: [] };
  assert.equal(apply_edit(bare, { type: 'set_as_of', date: '2026-01-01' }).ok, true);
});

// ── что меняется в расчёте ──────────────────────────────────────────────────────────────────────────────────────────

test('TST-57 REQ-028 as_of: сдвиг «сегодня» даёт плашку по канону — возраст остатка 7 → свежо, 8 → плашка, 21 → плашка, 22 → блок; G-001 на своей дате не меняется', () => {
  const level_at = (iso) => {
    const r = apply_edit(G, { type: 'set_as_of', date: iso });
    assert.equal(r.ok, true, iso);
    const m = APP.build_model(r.ws);
    return [m.ctx.anchor_status.age, m.ctx.anchor_status.level];
  };
  assert.deepEqual(level_at('2026-10-04'), [0, 'fresh']);
  assert.deepEqual(level_at('2026-10-11'), [7, 'fresh']);
  assert.deepEqual(level_at('2026-10-12'), [8, 'banner']);
  assert.deepEqual(level_at('2026-10-25'), [21, 'banner']);
  assert.deepEqual(level_at('2026-10-26'), [22, 'block']);
  // эталон G-001 на исходной дате воспроизводится как раньше (повторный разбор даты не меняет входы расчёта)
  const base = analyze(G, { as_of: G.as_of });
  const same_ws = apply_edit(G, { type: 'set_as_of', date: '2026-10-04' }).ws;
  const via = analyze(same_ws, { as_of: same_ws.as_of });
  assert.equal(via.inputs_hash, base.inputs_hash);
  // сдвиг вперёд меняет входы расчёта и горизонт
  const moved_ws = apply_edit(G, { type: 'set_as_of', date: '2026-10-14' }).ws;
  const moved = analyze(moved_ws, { as_of: moved_ws.as_of });
  assert.notEqual(moved.inputs_hash, base.inputs_hash);
  assert.equal(moved.as_of - base.as_of, 10);
  assert.equal(moved.horizon_end - base.horizon_end, 10, 'горизонт в днях тот же — конец уехал на те же 10 дней');
});

test('TST-58 REQ-090 as_of: после сдвига «сегодня» факт на новую дату принимается, на дату позже «сегодня» — E_FUTURE_POSTED; на исходной дате набора 14 октября — будущее', () => {
  const { ctx, st } = make_env(G);
  const s = ctx.edit({ type: 'set_as_of', date: '2026-10-14' });
  assert.equal(s.ok, true, JSON.stringify(s.error));
  assert.equal(st.ws.as_of, '2026-10-14');
  const add = (ws, date) => apply_edit(ws, { type: 'add_fact', fact: { account_id: 'acc_main', date, amount_minor: -1250 } }, { new_id: ctx.new_id });
  assert.equal(add(st.ws, '2026-10-14').ok, true, 'на новую дату «сегодня»');
  assert.equal(add(st.ws, '2026-10-15').error.code, 'E_FUTURE_POSTED');
  assert.equal(add(G, '2026-10-14').error.code, 'E_FUTURE_POSTED', 'на исходной дате набора 14 октября — будущее');
});

test('TST-16 TST-38 as_of: смена даты расчёта записывается в журнал одной записью метаданных и возвращается из журнала в ws', () => {
  const { ctx, st } = make_env(G);
  const j = ctx.journal;
  const n0 = j.length;
  assert.equal(ctx.edit({ type: 'set_as_of', date: '2026-10-14' }).ok, true);
  assert.equal(j.length, n0 + 1, 'ровно одна запись');
  const last = j.at(n0);
  assert.equal(last.type, 'profile.set');
  assert.equal(last.payload.profile_id, 'ws:meta');
  assert.equal(last.payload.as_of, '2026-10-14');
  const back = events_to_ws(j.events());
  assert.equal(back.as_of, '2026-10-14', 'из журнала возвращается новая дата');
  assert.equal(analyze(back, { as_of: back.as_of }).inputs_hash, analyze(st.ws, { as_of: st.ws.as_of }).inputs_hash, 'расчёт по ws из журнала совпадает с расчётом по рабочей области');
  // отказ правки ничего не пишет
  const n1 = j.length;
  assert.equal(ctx.edit({ type: 'set_as_of', date: '2026-10-01' }).ok, false);
  assert.equal(j.length, n1);
  assert.equal(st.ws.as_of, '2026-10-14');
});

// ── модель и план ───────────────────────────────────────────────────────────────────────────────────────────────────

test('as_of: as_of_model — возраст остатка, дни до плашки, дата на часах и сдвиг; без часов поля часов пусты', () => {
  const m = APP.build_model(G);
  assert.deepEqual(AO.as_of_model(m, '2026-10-14'), {
    as_of: '2026-10-04', clock: '2026-10-14', shift_days: 10, anchor_age: 0, level: 'fresh', left_to_banner: 8, latest_posted: '2026-10-04',
  });
  const late = AO.as_of_model(APP.build_model(apply_edit(G, { type: 'set_as_of', date: '2026-10-09' }).ws), '2026-10-01');
  assert.equal(late.anchor_age, 5);
  assert.equal(late.left_to_banner, 3, 'возраст 5: плашка с 8-го дня — через 3 дня');
  assert.equal(late.shift_days, -8, 'часы раньше даты расчёта');
  const stale = AO.as_of_model(APP.build_model(apply_edit(G, { type: 'set_as_of', date: '2026-10-26' }).ws), null);
  assert.deepEqual([stale.level, stale.left_to_banner, stale.clock, stale.shift_days], ['block', null, null, null]);
  assert.equal(AO.as_of_model(m, 'не дата').clock, null);
  const no_anchor = AO.as_of_model(APP.build_model({ ...G, anchors: [] }), null);
  assert.equal(no_anchor.anchor_age, null);
});

test('TST-58 as_of: plan_as_of_edit — пусто при той же дате, причина при ошибке, одна правка при новой дате', () => {
  const m = APP.build_model(G);
  assert.deepEqual(AO.plan_as_of_edit(m, '2026-10-04'), { ok: true, edits: [] });
  assert.deepEqual(AO.plan_as_of_edit(m, '04.10.2026'), { ok: true, edits: [] });
  assert.deepEqual(AO.plan_as_of_edit(m, '14.10.2026'), { ok: true, edits: [{ type: 'set_as_of', date: '2026-10-14' }] });
  assert.deepEqual(AO.plan_as_of_edit(m, ''), { ok: false, reason: 'empty' });
  assert.deepEqual(AO.plan_as_of_edit(m, 'abc'), { ok: false, reason: 'bad_date' });
  assert.deepEqual(AO.plan_as_of_edit(m, '2026-10-01'), { ok: false, reason: 'before_posted', latest: '2026-10-04' });
  assert.deepEqual(AO.plan_as_of_edit(m, '1999-01-01'), { ok: false, reason: 'range' });
});

// ── форма на экране «Настройки» ────────────────────────────────────────────────────────────────────────────────────

test('TST-58 as_of: форма «Сегодня» — поле с текущей датой, возраст остатка, подсказка с часов; запись общим путём, подтверждение после перерисовки', () => {
  const { ctx, st } = make_env(G);
  const root = ST.render_settings(ctx, { clock: () => '2026-10-14' });
  const form = by_id(root, 'settings-today');
  assert.ok(form !== undefined, 'форма есть');
  const input = by_id(root, 'set-today');
  assert.equal(input.getAttribute('type'), 'date');
  assert.equal(input.value, '2026-10-04');
  assert.equal(input.getAttribute('min'), '2000-01-01');
  assert.match(text_of(form), /Сегодня \(дата расчёта\)/);
  assert.match(text_of(form), /Сейчас расчёт идёт на 4 октября./);
  assert.match(text_of(form), /Остатку по якорю 0 дней\. Плашка «данные устарели» появится через 8 дней\./);
  assert.match(text_of(form), /Часы компьютера: 14 октября — на 10 дней позже даты расчёта/);
  // кнопка «Взять дату с часов» подставляет дату в поле и ничего не сохраняет
  const take = button_by_text(form, /Взять дату с часов/);
  assert.ok(take !== undefined && take.attrs.disabled === undefined);
  take.listeners.click[0]();
  assert.equal(input.value, '2026-10-14');
  assert.match(text_of(form), /Дата с часов подставлена в поле/);
  assert.equal(st.ws.as_of, '2026-10-04', 'до «Сохранить» данные не тронуты');
  // сохранение: правка set_as_of, пересчёт страницей, уведомление
  submit_form(root, 'settings-today');
  assert.equal(st.ws.as_of, '2026-10-14');
  assert.equal(st.model.ctx.anchor_status.age, 10);
  assert.equal(st.model.ctx.anchor_status.level, 'banner');
  assert.ok(st.renders >= 1, 'страница перерисована');
  assert.deepEqual(st.notes.at(-1), ['Сохранено.', 'info']);
  // после перерисовки раздел показывает подтверждение и новое состояние плашки
  const root2 = ST.render_settings(ctx, { clock: () => '2026-10-14' });
  const form2 = by_id(root2, 'settings-today');
  assert.match(text_of(form2), /Сохранено\./);
  assert.match(text_of(form2), /Остатку по якорю 10 дней: плашка «данные устарели» уже показана\./);
  assert.match(text_of(form2), /Часы компьютера показывают ту же дату: 14 октября\./);
  assert.equal(by_id(root2, 'set-today').value, '2026-10-14');
});

test('TST-58 as_of: ошибки формы «Сегодня» — текст рядом с полем, данные не меняются, введённый текст в сообщении не повторяется', () => {
  const { ctx, st } = make_env(G);
  const root = ST.render_settings(ctx, { clock: () => null });
  const input = by_id(root, 'set-today');
  const err = by_id(root, 'set-today-err');
  const check = (text, re) => {
    input.value = text;
    submit_form(root, 'settings-today');
    assert.match(text_of(err), re, text);
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.equal(st.ws.as_of, '2026-10-04', 'данные не тронуты');
  };
  check('', /Введите дату/);
  check('<script>alert(1)</script>', /Не удалось прочитать дату/);
  assert.ok(!text_of(err).includes('<script>'), 'введённый текст не повторяется');
  check('1999-05-05', /Дата должна быть от 2000-01-01 до 2100-12-31/);
  check('2026-10-03', /Раньше 4 октября нельзя: на эту дату уже есть проведённая запись или остаток/);
  assert.match(text_of(by_id(root, 'settings-today')), /Отмеченные поля содержат ошибки: ничего не сохранено/);
  // верное значение снимает ошибку; та же дата — «значения не изменились»
  input.value = '2026-10-04';
  submit_form(root, 'settings-today');
  assert.equal(text_of(err), '');
  assert.equal(input.getAttribute('aria-invalid'), 'false');
  assert.match(text_of(by_id(root, 'settings-today')), /Значения не изменились/);
  // без часов кнопка «Взять дату с часов» недоступна, строки про часы нет
  const take = button_by_text(by_id(root, 'settings-today'), /Взять дату с часов/);
  assert.ok(take.attrs.disabled !== undefined && take.attrs.disabled !== 'false', 'кнопка выключена');
  assert.ok(!/Часы компьютера/.test(text_of(by_id(root, 'settings-today'))));
});

test('TST-56 as_of: форма «Сегодня» на английском; набор без якоря и набор с плашкой «блок» показывают свои подсказки', () => {
  const { ctx } = make_env(G, { lang: 'en' });
  const form = by_id(ST.render_settings(ctx, { clock: () => '2026-10-02' }), 'settings-today');
  assert.match(text_of(form), /Today \(calculation date\)/);
  assert.match(text_of(form), /The anchor balance is 0 days old\./);
  assert.match(text_of(form), /Computer clock: October 2, 2 days earlier than the calculation date\./);
  const none = make_env({ ...G, anchors: [] });
  assert.match(text_of(by_id(ST.render_settings(none.ctx, { clock: () => null }), 'settings-today')), /Остатка по якорю нет: сверьте остаток/);
  const stale = make_env(apply_edit(G, { type: 'set_as_of', date: '2026-10-26' }).ws);
  assert.match(text_of(by_id(ST.render_settings(stale.ctx, { clock: () => null }), 'settings-today')), /Остатку по якорю 22 дня: плашка «данные устарели» уже показана/);
  assert.equal(GAP.as_of, GAP.anchors.at(-1).date, 'набор gap задаёт «сегодня» = дата последнего остатка: возраст 0, плашки нет');
});

// ── местная дата с часов ────────────────────────────────────────────────────────────────────────────────────────────

test('as_of: local_today — местная дата по порту часов и смещению пояса (возле полуночи не даёт вчерашний день); смещение вне диапазона отвергается', () => {
  const at = (ms, off) => local_today({ now_ms: () => ms, tz_offset_min: () => off });
  assert.equal(at(MS(2026, 10, 6, 23, 30), 0), '2026-10-06');
  assert.equal(at(MS(2026, 10, 6, 23, 30), 120), '2026-10-07', 'Германия летом: UTC 23:30 — уже 01:30 следующего дня');
  assert.equal(at(MS(2026, 10, 6, 23, 30), 60), '2026-10-07');
  assert.equal(at(MS(2026, 10, 7, 0, 30), -300), '2026-10-06', 'Нью-Йорк: ещё вчера');
  assert.equal(at(MS(2026, 12, 31, 23, 59), 60), '2027-01-01', 'смена года');
  assert.equal(local_today({ now_ms: () => MS(2026, 10, 6, 12) }), '2026-10-06', 'без смещения — UTC');
  assert.throws(() => at(MS(2026, 10, 6), 15 * 60), RangeError);
  assert.throws(() => at(MS(2026, 10, 6), 1.5), RangeError);
  // боевые порты: функции, без обращения к хранилищу и сети
  const p = clock_ports();
  assert.equal(typeof p.now_ms(), 'number');
  assert.ok(Number.isInteger(p.tz_offset_min()));
  assert.match(local_today(p), /^\d{4}-\d{2}-\d{2}$/);
});

// ── безопасность интерфейса ─────────────────────────────────────────────────────────────────────────────────────────

test('TST-59 as_of: новый код без innerHTML, inline-стилей, сети, eval и записи в params/ws в обход apply_edit', () => {
  for (const f of ['as_of.mjs', 'settings.mjs']) {
    const src = fs.readFileSync(path.join(DEMO, f), 'utf8');
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'srcdoc', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'eval(', 'new Function', 'document.write', 'localStorage']) {
      assert.ok(!src.includes(bad), `${f}: ${bad}`);
    }
    assert.ok(!/\bfetch\(|\bimport\(/.test(src), `${f}: сеть или динамический импорт`);
    assert.ok(!/setAttribute\(\s*['"]style['"]/.test(src), `${f}: атрибут style`);
  }
  const ao = fs.readFileSync(path.join(DEMO, 'as_of.mjs'), 'utf8');
  assert.ok(!/\bDate\b/.test(ao.replace(/^\s*(\/\/|\*).*$/gm, '')), 'as_of.mjs не читает часы: дата приходит аргументом');
  assert.ok(!/from '\.\/app\.mjs'/.test(ao));
  assert.ok(list_edit_types().includes('set_as_of'));
  // регистрация идемпотентна: повторная загрузка пакета не падает
  const again = create_ext({ ports: seeded_ports({ seed: 9 }) });
  assert.doesNotReject(again.load_packs({ pack_fp03: () => import(pathToFileURL(path.join(DEMO, 'pack_fp03.mjs')).href) }));
  assert.throws(() => register_edit('set_as_of', () => ({})), /уже зарегистрирован/, 'чужая регистрация того же имени отвергается');
});
