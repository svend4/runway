// ext.test.mjs — реестр расширений демо (FP-01): экраны, слоты, хуки, строки, стили, загрузка пакетов, общий путь записи «ws → пересчёт → показ».
// Покрывает: устойчивость реестра (падение одного пакета, экрана, блока, хука не ломает остальное), TST-56 (слияние каталогов строк пакетов),
// TST-59 (ensure_css принимает только css/<имя>.css; узлы строятся только через dom.mjs), REQ-012 (журнал следует за правками через ctx.set_ws/edit).
// DOM в Node подменён минимальной заглушкой: проверяется логика реестра, а не вёрстка.

import test from 'node:test';
import assert from 'node:assert/strict';

// ── минимальная заглушка DOM ─────────────────────────────────────────────────────────────────────────────────────────

class FakeNode {
  constructor(tag) { this.nodeType = 1; this.tagName = tag; this.attrs = {}; this.children = []; this.className = ''; this.textContent = ''; this.listeners = {}; }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  append(...kids) { this.children.push(...kids); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  querySelectorAll() { return this.children.filter((c) => c.tagName === 'link'); }
}
globalThis.document = {
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (data) => ({ nodeType: 3, data }),
  createElementNS: (_ns, tag) => new FakeNode(tag),
  head: new FakeNode('head'),
  getElementById: () => null,
};

import { analyze, canon } from '../engine/index.mjs';
import { create_ext, ext as APP_EXT, SLOTS, HOOKS, CORE_VIEWS, ExtError } from '../demo/ext.mjs';
import { h } from '../demo/dom.mjs';
import { t as tr_of, ext_strings } from '../demo/i18n.mjs';
import { events_to_ws } from '../demo/ws_bridge.mjs';
import { seeded_ports } from '../demo/ids.mjs';
import * as APP from '../demo/app.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const G = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'data', 'g001.json'), 'utf8'));
const el = (text) => h('div', { text });

/** Хост-заглушка: рабочая область, пересчёт движком (отказ — как у страницы), счётчик перерисовок и сообщения. */
function make_host(ws = G, over = {}) {
  const st = { ws, renders: 0, notes: [], lang: 'ru' };
  const host = {
    get_ws: () => st.ws,
    get_model: () => ({ ws: st.ws }),
    lang: () => st.lang,
    mode: () => 'worse',
    fmt: () => null,
    set_ws: (next) => {
      try { analyze(next, { as_of: next.as_of }); } catch (e) { return { ok: false, error: e }; }
      st.ws = next;
      return { ok: true };
    },
    render: () => { st.renders += 1; },
    notify: (m, k) => { st.notes.push([m, k]); },
    ...over,
  };
  return { st, host };
}
function make(ws = G) {
  const e = create_ext({ ports: seeded_ports({ seed: 11 }) });
  const h_ = make_host(ws);
  e.bind_host(h_.host);
  return { e, ...h_ };
}

// ── экраны ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test('ext: register_view — идентификатор, title_key, render, порядок; экраны приложения и повторы недоступны', () => {
  const { e } = make();
  assert.equal(e.register_view({ id: 'settings', title_key: 'zz.nav', order: 25, render: () => el('x') }), 'settings');
  for (const bad of [
    null, 5, {}, { id: 'Settings', title_key: 'zz.nav', render: () => el('x') }, { id: 'a', title_key: 'zz.nav', render: () => el('x') }, { id: 'ok_id', title_key: 'нет', render: () => el('x') },
    { id: 'ok_id', title_key: 'zz.nav' }, { id: 'ok_id', title_key: 'zz.nav', render: () => el('x'), order: NaN }, { id: 'settings', title_key: 'zz.nav', render: () => el('x') },
    ...CORE_VIEWS.map((id) => ({ id, title_key: 'zz.nav', render: () => el('x') })),
  ]) assert.throws(() => e.register_view(bad), ExtError, JSON.stringify(bad));
  assert.equal(e.has_view('settings'), true);
  assert.equal(e.has_view('overview'), false, 'экраны приложения — не экраны пакетов');
});

test('ext: nav_items — экраны приложения идут по местам 10…80, экраны пакетов вставляются по order, при равенстве — по порядку регистрации', () => {
  const { e } = make();
  assert.deepEqual(e.nav_items().map((x) => x.id), CORE_VIEWS);
  assert.deepEqual(e.nav_items().map((x) => x.title_key), CORE_VIEWS.map((v) => 'nav.' + v));
  e.register_view({ id: 'late', title_key: 'zz.late', render: () => el('x') }); // order по умолчанию 500
  e.register_view({ id: 'mid', title_key: 'zz.mid', order: 25, render: () => el('x') });
  e.register_view({ id: 'mid2', title_key: 'zz.mid2', order: 25, render: () => el('x') });
  e.register_view({ id: 'first', title_key: 'zz.first', order: 5, render: () => el('x') });
  const items = e.nav_items();
  assert.deepEqual(items.map((x) => x.id), ['first', 'overview', 'buy', 'mid', 'mid2', 'waves', 'reserves', 'scenarios', 'feed', 'assistant', 'data', 'late']);
  assert.deepEqual(items.filter((x) => !x.core).map((x) => x.id).sort(), ['first', 'late', 'mid', 'mid2']);
  assert.deepEqual(e.nav_items(['a', 'b']).map((x) => x.id), ['first', 'a', 'b', 'mid', 'mid2', 'late'], 'приложение передаёт свой список');
});

test('ext: render_view — экран рисуется; исключение, не-элемент и неизвестный экран дают плашку и сообщение, остальное живо', () => {
  const { e, st } = make();
  e.register_view({ id: 'good', title_key: 'zz.good', render: (c) => el('ok ' + typeof c.get_ws) });
  e.register_view({ id: 'boom', title_key: 'zz.boom', render: () => { throw new Error('баг экрана'); } });
  e.register_view({ id: 'noel', title_key: 'zz.noel', render: () => 'строка' });
  const good = e.render_view('good');
  assert.equal(good.textContent, 'ok function', 'экран получает ctx');
  for (const id of ['boom', 'noel', 'нет']) {
    const n = e.render_view(id);
    assert.equal(n.attrs.role, 'alert');
    assert.match(n.textContent, /не открылся/);
  }
  assert.ok(st.notes.length >= 2 && st.notes.every(([m, k]) => /не показан/.test(m) && k === 'error'), JSON.stringify(st.notes));
  assert.ok(e.diagnostics().some((d) => d.status === 'failed' && d.label === 'view:boom' && /баг экрана/.test(d.message)));
  assert.equal(e.render_view('good').textContent, 'ok function', 'после сбоя соседнего экрана этот работает');
});

// ── слоты ───────────────────────────────────────────────────────────────────────────────────────────────────────────

test('ext: слоты — порядок по order, массивы узлов разворачиваются, упавший блок пропускается, неизвестный слот и повтор — ошибка', () => {
  assert.deepEqual([...SLOTS], ['overview.cards', 'reserves.sections', 'data.sections', 'waves.actions', 'nav.actions', 'assistant.extras', 'banner.actions', 'scenarios.after', 'waves.card', 'banner.warning', 'feed.head', 'feed.row', 'buy.form', 'buy.result']);
  const { e, st } = make();
  e.register_slot_item('overview.cards', { id: 'bb', order: 20, render: () => el('B') });
  e.register_slot_item('overview.cards', { id: 'aa', order: 10, render: () => [el('A1'), null, [el('A2')]] });
  e.register_slot_item('overview.cards', { id: 'bad', order: 15, render: () => { throw new TypeError('x'); } });
  e.register_slot_item('overview.cards', { id: 'str', order: 16, render: () => 'не узел' });
  e.register_slot_item('overview.cards', { id: 'nul', order: 17, render: () => null });
  const nodes = e.slot_nodes('overview.cards');
  assert.deepEqual(nodes.map((n) => n.textContent), ['A1', 'A2', 'B']);
  assert.ok(st.notes.length >= 1, 'о сбое блока сообщили');
  assert.deepEqual(e.slot_nodes('reserves.sections'), []);
  assert.deepEqual(e.slot_nodes('нет-слота'), []);
  assert.throws(() => e.register_slot_item('нет-слота', { id: 'x', render: () => el('x') }), ExtError);
  assert.throws(() => e.register_slot_item('overview.cards', { id: 'aa', render: () => el('x') }), ExtError, 'повтор в слоте');
  assert.throws(() => e.register_slot_item('overview.cards', { id: 'Bad Id', render: () => el('x') }), ExtError);
  assert.doesNotThrow(() => e.register_slot_item('data.sections', { id: 'aa', render: () => el('x') }), 'тот же id в другом слоте — можно');
});

// ── хуки ────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('ext: хуки scenario_ops / show_why / boot — первый ответ, сбор узлов, асинхронный запуск; сбой одного хука не останавливает остальные', async () => {
  assert.deepEqual([...HOOKS], ['scenario_ops', 'show_why', 'boot', 'fmt', 'assistant', 'dataset_label']); // FP-20: хук assistant (чип происхождения ответа и порты журнала вызовов); FP-48: хук dataset_label (подпись источника данных в переключателе «Набор данных»)
  const { e } = make();
  assert.throws(() => e.register_hook('нет', () => 1), ExtError);
  assert.throws(() => e.register_hook('boot', 5), ExtError);
  const calls = [];
  e.register_hook('scenario_ops', () => undefined);
  e.register_hook('scenario_ops', () => { throw new Error('упал'); });
  e.register_hook('scenario_ops', (ctx, sc, ws, ref) => { calls.push([typeof ctx.get_ws, sc.kind, ws === G, ref]); return sc.kind === 'shift' ? [{ op: 'shift_flow', event_ref: ref, days: 3 }] : undefined; });
  e.register_hook('scenario_ops', () => [{ op: 'не дойдёт' }]);
  assert.deepEqual(e.first('scenario_ops', { kind: 'shift' }, G, 'S-HOURLY@2026-11-05'), [{ op: 'shift_flow', event_ref: 'S-HOURLY@2026-11-05', days: 3 }]);
  assert.deepEqual(calls, [['function', 'shift', true, 'S-HOURLY@2026-11-05']]);
  assert.equal(e.first('show_why', 'worse'), undefined, 'нет хуков — undefined');
  const off = e.register_hook('show_why', () => el('почему-1'));
  e.register_hook('show_why', (_c, mode) => [el('почему-' + mode), null, 'не узел']);
  assert.deepEqual(e.collect('show_why', 'plan').map((n) => n.textContent), ['почему-1', 'почему-plan']);
  off();
  assert.deepEqual(e.collect('show_why', 'plan').map((n) => n.textContent), ['почему-plan'], 'снятый хук не вызывается');
  const order = [];
  e.register_hook('boot', async () => { await null; order.push('a'); });
  e.register_hook('boot', () => { throw new Error('boot упал'); });
  e.register_hook('boot', () => { order.push('c'); });
  await e.run('boot');
  assert.deepEqual(order, ['a', 'c']);
  assert.ok(e.diagnostics().some((d) => d.label === 'hook:boot' && d.status === 'failed'));
});

test('ext: хук scenario_ops подключён к app.mjs — новый вид сценария из пакета превращается в операции; прежние виды и неизвестные работают как раньше', () => {
  const ops = [{ op: 'shift_flow', event_ref: 'x', days: 1 }];
  assert.deepEqual(APP.scenario_ops({ kind: 'delay', days: 5 }, G, 'S-HOURLY@2026-11-05'), [{ op: 'delay_income', event_ref: 'S-HOURLY@2026-11-05', days: 5 }]);
  assert.equal(APP.scenario_ops({ kind: 'custom_zz' }, G, null), null, 'неизвестный вид без хука — null, как раньше');
  APP_EXT.register_hook('scenario_ops', (_c, sc) => (sc.kind === 'custom_zz' ? ops : undefined));
  assert.deepEqual(APP.scenario_ops({ kind: 'custom_zz' }, G, null), ops);
  assert.equal(APP.scenario_ops({ kind: 'saved', sid: 'scn-delay-14' }, G, null), G.scenarios[0].ops, 'сохранённые сценарии по-прежнему из набора');
});

// ── строки и стили ──────────────────────────────────────────────────────────────────────────────────────────────────

test('ext (TST-56): register_i18n — каталог пакета сливается в одной точке; нарушения паритета, пространства и плейсхолдеров отвергаются целиком', () => {
  const { e } = make();
  const ctx = e.ctx;
  e.register_i18n('extok', { ru: { 'extok.hello': 'Привет, {name}', 'extok.bye': 'Пока' }, en: { 'extok.hello': 'Hello, {name}', 'extok.bye': 'Bye' } });
  assert.equal(ctx.tr('extok.hello', { name: 'Ян' }), 'Привет, Ян');
  assert.equal(tr_of('en', 'extok.hello', { name: 'Jan' }), 'Hello, Jan');
  assert.deepEqual(Object.keys(ext_strings().ru).filter((k) => k.startsWith('extok.')).sort(), ['extok.bye', 'extok.hello']);
  const cat = (ru, en) => ({ ru, en });
  const bad = [
    ['nav', cat({ 'nav.x': 'а' }, { 'nav.x': 'a' })], // пространство приложения
    ['extok', cat({ 'extok.z': 'а' }, { 'extok.z': 'a' })], // уже занято пакетом
    ['extb1', cat({ 'extb1.a': 'а', 'extb1.b': 'б' }, { 'extb1.a': 'a' })], // разные наборы ключей
    ['extb2', cat({ 'extb2.a': 'а {n}' }, { 'extb2.a': 'a {m}' })], // плейсхолдеры
    ['extb3', cat({ 'extb3.a': 'а' }, { 'extb3.a': '  ' })], // пустая строка
    ['extb4', cat({ 'other.a': 'а' }, { 'other.a': 'a' })], // ключ вне пространства
    ['extb5', cat({ 'extb5.': 'а' }, { 'extb5.': 'a' })],
    ['Bad Ns', cat({}, {})],
    ['extb6', { ru: {} }],
  ];
  for (const [ns, c] of bad) assert.throws(() => e.register_i18n(ns, c), Error, ns);
  assert.equal(ctx.tr('extb1.a'), 'extb1.a', 'отвергнутый каталог не принят ни частично');
  assert.equal(ctx.tr('нет.ключа'), 'нет.ключа');
});

test('ext (TST-59): ensure_css принимает только css/<имя>.css; повтор — без повторного подключения; ссылка добавляется в head', () => {
  const { e } = make();
  const before = document.head.children.length;
  assert.equal(e.ensure_css('css/pack_fp03.css'), true);
  assert.equal(e.ensure_css('css/pack_fp03.css'), false);
  assert.equal(document.head.children.length, before + 1);
  const link = document.head.children.at(-1);
  assert.deepEqual([link.tagName, link.attrs.rel, link.attrs.href], ['link', 'stylesheet', 'css/pack_fp03.css']);
  for (const bad of ['../x.css', 'http://x/y.css', 'https://x/y.css', '//x/y.css', 'css/a b.css', 'style.css', 'css/x.js', 'css/../x.css', '/css/x.css', 5, null, 'css/']) assert.throws(() => e.ensure_css(bad), ExtError, String(bad));
});

test('ext (TST-59): dom.h не пишет inline-стили, строковые обработчики и javascript:-адреса; функции-обработчики подключаются; текст — только textContent', () => {
  const n = h('a', { href: 'javascript:alert(1)', style: 'color:red', onclick: 'alert(1)', onmouseover: () => 1, class: 'x', text: '<b>не разметка</b>', 'data-k': 'v' });
  assert.equal(n.attrs.style, undefined);
  assert.equal(n.attrs.href, undefined);
  assert.equal(n.attrs.onclick, undefined);
  assert.equal(typeof n.listeners.mouseover[0], 'function');
  assert.equal(n.className, 'x');
  assert.equal(n.textContent, '<b>не разметка</b>');
  assert.equal(n.attrs['data-k'], 'v');
  assert.equal(h('a', { href: '#buy' }).attrs.href, '#buy');
  assert.equal(h('p', null, 'a', 5, null, false, ['b', [h('i')]]).children.length, 4);
});

// ── загрузка пакетов ────────────────────────────────────────────────────────────────────────────────────────────────

const not_found = (name) => Object.assign(new Error(`Cannot find module '/x/demo/${name}.mjs' imported from /x/demo/ext_manifest.mjs`), { code: 'ERR_MODULE_NOT_FOUND' });

test('ext: load_packs — отсутствие файла норма, падение пакета перехвачено с откатом его регистраций, остальные пакеты загружаются', async () => {
  const { e, st } = make();
  const loaders = {
    pack_absent: async () => { throw not_found('pack_absent'); },
    pack_browser_404: async () => { throw new TypeError('Failed to fetch dynamically imported module: http://localhost/demo/pack_b.mjs'); },
    pack_dep_missing: async () => { throw Object.assign(new Error("Cannot find module '/x/demo/нет_зависимости.mjs' imported from /x/demo/pack_dep_missing.mjs"), { code: 'ERR_MODULE_NOT_FOUND' }); },
    pack_syntax: async () => { throw new SyntaxError('Unexpected token'); },
    pack_no_register: async () => ({}),
    pack_half: async () => ({ register: (x) => {
      x.register_view({ id: 'half', title_key: 'zz.half', render: () => el('x') });
      x.register_slot_item('overview.cards', { id: 'half', render: () => el('half') });
      x.register_hook('boot', () => { throw new Error('не должен остаться'); });
      throw new Error('упал посреди регистрации');
    } }),
    pack_ok: async () => ({ register: async (x) => {
      await null;
      assert.equal(x.pack, 'pack_ok');
      assert.equal(x.bind_host, undefined, 'пакет не получает права страницы');
      x.register_view({ id: 'okview', title_key: 'zz.ok', render: () => el('ok') });
      x.register_slot_item('overview.cards', { id: 'okcard', render: () => el('ok-card') });
      x.register_hook('show_why', () => el('ok-why'));
      x.register_i18n('pkok', { ru: { 'pkok.a': 'а' }, en: { 'pkok.a': 'a' } });
      x.ensure_css('css/pkok.css');
    } }),
  };
  await e.load_packs(loaders);
  const status = Object.fromEntries(e.diagnostics().filter((d) => d.pack !== undefined).map((d) => [d.pack, d.status]));
  assert.deepEqual(status, { pack_absent: 'absent', pack_browser_404: 'absent', pack_dep_missing: 'failed', pack_syntax: 'failed', pack_no_register: 'failed', pack_half: 'failed', pack_ok: 'ok' });
  assert.equal(e.has_view('half'), false, 'регистрации упавшего пакета сняты');
  assert.deepEqual(e.slot_nodes('overview.cards').map((n) => n.textContent), ['ok-card']);
  assert.deepEqual(e.collect('show_why', 'plan').map((n) => n.textContent), ['ok-why'], 'хук упавшего пакета снят');
  assert.equal(e.has_view('okview'), true);
  const failed = st.notes.filter(([m]) => /не загрузилось/.test(m));
  assert.equal(failed.length, 4, 'сообщения — только о настоящих сбоях, не об отсутствующих файлах: ' + JSON.stringify(st.notes));
  assert.ok(failed.some(([m]) => m.includes('pack_half')));
  assert.ok(!st.notes.some(([m]) => m.includes('pack_absent') || m.includes('pack_browser_404')));
  assert.equal(e.ctx.tr('pkok.a'), 'а');
});

test('ext: load_packs по манифесту demo/ext_manifest.mjs — файла может не быть; все исходы — ok, absent или failed без исключения наружу', async (t) => {
  const { e } = make();
  await e.load_packs();
  const rows = e.diagnostics().filter((d) => d.pack !== undefined);
  assert.deepEqual(rows.map((r) => r.pack), ['pack_fp03', 'pack_fp04', 'pack_fp05', 'pack_fp06', 'pack_fp07', 'pack_fp08', 'pack_fp09', 'pack_fp10', 'pack_fp11', 'pack_fp12', 'pack_fp13', 'pack_fp14', 'pack_fp15', 'pack_fp16', 'pack_fp20', 'pack_fp21', 'pack_fp22', 'pack_fp26', 'pack_fp28', 'pack_fp29']);
  for (const r of rows) assert.ok(['ok', 'absent', 'failed'].includes(r.status), r.pack + ': ' + r.status);
  t.diagnostic('пакеты: ' + rows.map((r) => `${r.pack}=${r.status}`).join(', '));
});

// ── общий путь записи ───────────────────────────────────────────────────────────────────────────────────────────────

test('ext: ctx — только чтение без страницы; без хоста запись отвергается кодом E_SCHEMA, а не исключением; ctx заморожен', () => {
  const e = create_ext();
  const c = e.ctx;
  assert.ok(Object.isFrozen(c));
  assert.equal(c.get_ws(), null);
  assert.equal(c.get_model(), null);
  assert.equal(c.fmt(), null);
  assert.equal(c.lang(), 'ru');
  assert.equal(c.mode(), 'worse');
  assert.equal(c.journal, null);
  assert.deepEqual(c.set_ws(G), { ok: false, error: { code: 'E_SCHEMA', ctx: { reason: 'no_host' } } });
  assert.equal(c.edit({ type: 'set_param', key: 'buffer_minor', value: 1 }).ok, false);
  assert.doesNotThrow(() => c.notify('сообщение'));
  assert.equal(c.tr('ext.edit_rejected', { code: 'E_X' }), 'Правка отклонена (E_X): данные не изменены.');
  assert.equal(typeof c.subscribe(() => 1), 'function');
});

test('ext (REQ-012): ctx.edit — правка применяется через ws_edit, страница пересчитывает, подписчики и журнал узнают, страница перерисовывается', () => {
  const { e, st } = make();
  const seen = [];
  const off = e.ctx.subscribe((info) => seen.push([info.reason, info.ws.facts.length]));
  e.ctx.subscribe(() => { throw new Error('плохой подписчик'); });
  const j0 = e.ctx.journal;
  assert.ok(j0 !== null);
  const n0 = j0.length;
  const r = e.ctx.edit({ type: 'add_fact', fact: { account_id: 'acc_main', date: '2026-10-03', amount_minor: -1500, tag: 'кофе' } });
  assert.equal(r.ok, true);
  assert.equal(st.ws.facts.length, G.facts.length + 1);
  assert.match(st.ws.facts.at(-1).event_id, /^tx_[0-9a-f]{12}$/, 'идентификатор создало приложение (порт ids.mjs)');
  assert.deepEqual(seen, [['add_fact', G.facts.length + 1]]);
  assert.equal(st.renders, 1);
  assert.equal(e.ctx.journal.length, n0 + 1, 'журнал дописан разностью');
  assert.equal(e.ctx.journal.at(n0).type, 'tx.posted');
  assert.equal(canon(events_to_ws(e.ctx.journal.events()).facts.map((f) => f.event_id)), canon(st.ws.facts.map((f) => f.event_id)));
  assert.equal(e.ctx.journal.state_hash().length, 64);
  // отказ правки: данные, журнал и подписчики не тронуты, пользователь получает сообщение
  const bad = e.ctx.edit({ type: 'add_fact', fact: { account_id: 'acc_main', date: '2026-10-05', amount_minor: -1 } });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'E_FUTURE_POSTED');
  assert.equal(st.ws.facts.length, G.facts.length + 1);
  assert.equal(seen.length, 1);
  assert.equal(e.ctx.journal.length, n0 + 1);
  assert.equal(st.renders, 1);
  assert.ok(st.notes.some(([m, k]) => /E_FUTURE_POSTED/.test(m) && k === 'error'));
  // отписка
  off();
  e.ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 61000 });
  assert.equal(seen.length, 1);
  assert.equal(st.ws.params.buffer_minor, 61000);
  assert.equal(e.ctx.journal.length, n0 + 2);
});

test('ext (REQ-012): ctx.set_ws — отказ пересчёта страницей откатывает всё: рабочая область, журнал, подписчики, перерисовка; код ошибки сохраняется', () => {
  const { e, st } = make();
  const seen = [];
  e.ctx.subscribe((i) => seen.push(i.reason));
  const n0 = e.ctx.journal.length;
  const broken = { ...G, params: { ...G.params, horizon_days: -5 } }; // движок такой набор не принимает
  const r = e.ctx.set_ws(broken, { reason: 'тест' });
  assert.equal(r.ok, false);
  assert.equal(typeof r.error.code, 'string');
  assert.equal(st.ws, G);
  assert.deepEqual(seen, []);
  assert.equal(e.ctx.journal.length, n0);
  assert.equal(st.renders, 0);
  const throwing = make_host(G, { set_ws: () => { throw new Error('хост упал'); } });
  const e2 = create_ext();
  e2.bind_host(throwing.host);
  const r2 = e2.ctx.set_ws(G);
  assert.deepEqual(r2, { ok: false, error: { code: 'E_SCHEMA', ctx: { reason: 'host_error' } } });
  assert.equal(e.ctx.set_ws(null).ok, false);
  assert.equal(e.ctx.set_ws([]).ok, false);
  const ok = e.ctx.set_ws({ ...G, name: 'Другое имя' }, { reason: 'rename' });
  assert.equal(ok.ok, true);
  assert.deepEqual(seen, ['rename']);
  assert.equal(e.ctx.journal.length, n0 + 1, 'смена метаданных — одна запись profile.set');
});

test('ext (REQ-012): ctx.reset — набор данных заменён: журнал пересобирается из новой рабочей области, подписчики получают adopt; журнал, разошедшийся с рабочей областью, пересобирается сам', () => {
  const { e, st } = make();
  const seen = [];
  e.ctx.subscribe((i) => seen.push(i.reason));
  const first = e.ctx.journal;
  const other = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'data', 'g001-low.json'), 'utf8'));
  st.ws = other; // страница подменила набор данных
  e.reset(other);
  assert.deepEqual(seen, ['adopt']);
  const second = e.ctx.journal;
  assert.notEqual(second, first);
  assert.equal(canon(events_to_ws(second.events()).anchors), canon(other.anchors));
  // расхождение: хост получил правило мимо ctx, журнал о нём не знает; пользователь это правило удаляет → журнал пересобирается, а не ломается
  e.ctx.journal; // создан из набора low
  const extra = { ...other.rules[0], rule_id: 'R-EXTRA', name: 'Лишнее' };
  st.ws = { ...other, rules: [...other.rules, extra] };
  const r = e.ctx.set_ws({ ...other, name: 'после удаления' });
  assert.equal(r.ok, true);
  assert.ok(e.ctx.journal !== null);
  assert.equal(canon(events_to_ws(e.ctx.journal.events()).rules.map((x) => x.rule_id)), canon(other.rules.map((x) => x.rule_id)), 'журнал пересобран из рабочей области');
  assert.ok(e.diagnostics().some((d) => d.label === 'journal_sync' && d.status === 'failed'));
});

test('ext (интегратор, FP-05/FP-03): ctx.refresh перерисовывает без рассылки, ctx.adopt подменяет набор через хост и сообщает источник, хук fmt — первый ответ не undefined', () => {
  const { e, st } = make();
  const seen = [];
  e.ctx.subscribe((i) => seen.push([i.reason, i.source ?? null]));
  const r0 = st.renders;
  e.ctx.refresh();
  assert.equal(st.renders, r0 + 1, 'перерисовка выполнена');
  assert.deepEqual(seen, [], 'подписчики не уведомлены');
  assert.equal(e.ctx.adopt(G).ok, false, 'хост без adopt: отказ no_host');
  const other = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'data', 'g001-low.json'), 'utf8'));
  e.bind_host({ ...make_host().host, adopt: (ws, o) => { st.ws = ws; e.reset(ws, o); return { ok: true }; }, get_ws: () => st.ws });
  const a = e.ctx.adopt(other, { source: 'restore' });
  assert.equal(a.ok, true);
  assert.deepEqual(seen, [['adopt', 'restore']], 'событие adopt несёт источник');
  assert.equal(e.ctx.adopt(null).ok, false, 'не объект — отказ');
  const nf = { decimal: ',', thousands: '.' };
  e.register_hook('fmt', () => undefined);
  e.register_hook('fmt', (ctx, lang, cur, as_of, n) => (n === undefined ? undefined : { tag: lang + cur + as_of + n.decimal }));
  assert.equal(e.first('fmt', 'ru', 'EUR', '2026-10-04', undefined), undefined, 'без настройки — хук не отвечает');
  assert.deepEqual(e.first('fmt', 'ru', 'EUR', '2026-10-04', nf), { tag: 'ruEUR2026-10-04,' });
});

test('ext: синглтон приложения — навигация по умолчанию = экраны приложения; без пакетов приложение ведёт себя как раньше', () => {
  assert.deepEqual(APP_EXT.nav_items().filter((x) => x.core).map((x) => x.id), CORE_VIEWS);
  assert.deepEqual(APP_EXT.slot_nodes('overview.cards'), []);
  assert.deepEqual(APP_EXT.collect('show_why', 'worse'), []);
});
