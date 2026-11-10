// wave_edit.test.mjs — FP-07: правки волн «объединить / разделить / закрепить», «почему вместе?», порог θ и таблица чувствительности
// (REQ-036, ALG-03, IDEA-09; TST-37, TST-58). Чистые модели (demo/wave_edit.mjs, engine/wave_sweep.mjs) — на G-001; DOM — в настоящем app.mjs
// на заглушке DOM: правка идёт общим путём ctx.edit (проверка → пересчёт страницей → журнал → показ). Браузер не используется.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(HERE, '..', 'demo');
const DATA = path.join(HERE, '..', 'data');

// ── заглушка DOM ────────────────────────────────────────────────────────────────────────────────────────────────────

class Node_ {
  constructor(tag, ns) {
    this.nodeType = 1; this.tagName = tag; this.ns = ns ?? null; this.attrs = {}; this.children = []; this.listeners = {}; this.className = '';
    this._text = ''; this._value = ''; this._sel = null; this.open = false;
  }
  get textContent() { return this.children.length === 0 ? this._text : this.children.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get value() {
    if (this.tagName === 'select') {
      if (this._sel !== null) return this._sel;
      const opts = this.children.filter((c) => c.tagName === 'option');
      return opts.length === 0 ? '' : opts[0].attrs.value;
    }
    return this._value;
  }
  set value(v) { if (this.tagName === 'select') this._sel = String(v); else this._value = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this._value = String(v); }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  append(...kids) { for (const k of kids) this.children.push(k); this._text = ''; }
  replaceChildren(...kids) { this.children = []; this._text = ''; this.append(...kids); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() {}
  querySelectorAll() { return []; }
  walk(fn) { fn(this); for (const c of this.children) if (c.nodeType === 1) c.walk(fn); }
}
const byid = new Map();
for (const id of ['app-title', 'app-sub', 'skip', 'controls', 'nav', 'summary', 'main', 'footer', 'live', 'dlg', 'dlg-title', 'dlg-close', 'dlg-body']) byid.set(id, new Node_(id === 'dlg' ? 'dialog' : 'div'));
const listeners = {};
globalThis.document = {
  createElement: (t) => new Node_(t), createElementNS: (ns, t) => new Node_(t, ns), createTextNode: (data) => ({ nodeType: 3, data }),
  getElementById: (id) => byid.get(id) ?? null, documentElement: new Node_('html'), head: new Node_('head'), body: new Node_('body'), title: '',
};
globalThis.window = { addEventListener: (t, fn) => { (listeners[t] ??= []).push(fn); }, scrollTo: () => {} };
globalThis.location = { hash: '' };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'ru-RU' }, configurable: true });
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.ResizeObserver = class { observe() {} };
globalThis.fetch = async (url) => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8')) });

const { ext } = await import(pathToFileURL(path.join(DEMO, 'ext.mjs')).href);
await import(pathToFileURL(path.join(DEMO, 'app.mjs')).href);
await new Promise((r) => setTimeout(r, 500));
const WE = await import(pathToFileURL(path.join(DEMO, 'wave_edit.mjs')).href);
const SW = await import('../engine/wave_sweep.mjs');
const { make_tool_ctx } = await import('../engine/tools.mjs');
const { list_waves_ex, detect_waves, analyze, canon } = await import('../engine/index.mjs');
const { apply_edit } = await import(pathToFileURL(path.join(DEMO, 'ws_edit.mjs')).href);
const { ws_to_events } = await import(pathToFileURL(path.join(DEMO, 'ws_bridge.mjs')).href);

const read = (name) => JSON.parse(fs.readFileSync(path.join(DATA, name + '.json'), 'utf8'));
const G = read('g001');
const model_of = (ws) => ({ ws, ctx: make_tool_ctx(ws, { as_of: ws.as_of }, {}) });
const ok_edit = (ws, edit) => { const r = apply_edit(ws, edit, { new_id: (p) => p + '_test' }); assert.equal(r.ok, true, JSON.stringify(r)); return r.ws; };
const waves_of = (ws, mode = 'plan') => list_waves_ex(analyze(ws, { as_of: ws.as_of }), mode);
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };
const text_of = (id) => byid.get(id).textContent;
const press = (label) => {
  const b = find_all(byid.get('main'), (n) => n.tagName === 'button' && (n.textContent === label || n.attrs['aria-label'] === label))[0];
  assert.ok(b !== undefined, 'нет кнопки «' + label + '»');
  b.listeners.click[0]();
};
const field = (id) => find_all(byid.get('main'), (n) => n.attrs.id === id)[0];
const a11y_problems = (root) => {
  const ids = new Set();
  const labels_for = new Set();
  root.walk((n) => { if (n.attrs.id !== undefined) ids.add(n.attrs.id); if (n.tagName === 'label' && n.attrs.for !== undefined) labels_for.add(n.attrs.for); });
  const bad = [];
  root.walk((n) => {
    if (n.attrs.style !== undefined) bad.push('inline style');
    if (n.tagName === 'table' && !n.children.some((c) => c.tagName === 'caption' && c.textContent.trim() !== '')) bad.push('таблица без подписи');
    if (n.attrs['aria-labelledby'] !== undefined && !n.attrs['aria-labelledby'].split(' ').every((i) => ids.has(i))) bad.push('aria-labelledby → нет id: ' + n.attrs['aria-labelledby']);
    if (n.tagName === 'button' && n.textContent.trim() === '' && !n.attrs['aria-label']) bad.push('кнопка без текста');
    if (['input', 'select', 'textarea'].includes(n.tagName) && !labels_for.has(n.attrs.id) && !n.attrs['aria-label']) bad.push('поле без подписи: ' + n.attrs.id);
  });
  return bad;
};
const sig_obligations = (a) => a.events.plan.filter((e) => e.is_obligation === true && e.is_estimate !== true && e.amount_minor < 0 && -e.amount_minor >= a.params['wave.threshold_minor']);

// ── чистые модели: движок и правки ──────────────────────────────────────────────────────────────────────────────────

test('TST-37 REQ-036: объединение двух волн G-001 даёт одну волну с total_out 254000; правка пишется как wave_override.set; без правок состав прежний', () => {
  const a0 = analyze(G, { as_of: G.as_of });
  const items = WE.wave_items(a0, 'plan');
  assert.deepEqual(items.map((i) => i.wave.total_out_minor), [152000, 102000]);
  assert.deepEqual(items.map((i) => i.origin), ['natural', 'natural']);
  const edit = WE.plan_merge(items, 0);
  assert.equal(edit.type, 'set_wave_override');
  assert.equal(edit.override.action, 'merge');
  assert.deepEqual(edit.override.event_ids, ['P-TAX1', 'R-RENT@2026-11-25']);
  const ws = ok_edit(G, edit);
  const merged = waves_of(ws);
  assert.equal(merged.items.length, 1);
  assert.equal(merged.items[0].wave.total_out_minor, 254000);
  assert.equal(WE.wave_items(analyze(ws, { as_of: ws.as_of }), 'plan')[0].origin, 'edited');
  const ev = ws_to_events(ws).filter((e) => e.type === 'wave_override.set');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.action, 'merge');
  assert.equal(ev[0].payload.override_id, edit.override.override_id);
  assert.deepEqual(waves_of(G).items.map((i) => i.wave.total_out_minor), [152000, 102000], 'исходная рабочая область не изменилась');
});

test('TST-37 REQ-036: split режет перед платежом, pin выделяет платёж отдельной волной; Σ total_out по волнам равна Σ значимых обязательств', () => {
  const a0 = analyze(G, { as_of: G.as_of });
  const sig_total = sig_obligations(a0).reduce((s, e) => s - e.amount_minor, 0);
  assert.equal(sig_total, 254000);
  const first = WE.wave_items(a0, 'plan')[0];
  const split = WE.plan_split(first, 'R-RENT@2026-10-25');
  assert.equal(split.override.action, 'split');
  assert.equal(WE.plan_split(first, 'P-TAX1'), null, 'перед первым платежом резать нечего');
  const ws_split = ok_edit(G, split);
  const sp = waves_of(ws_split).items.map((i) => i.wave.event_ids);
  assert.deepEqual(sp, [['P-TAX1'], ['R-RENT@2026-10-25', 'R-UTIL@2026-10-25'], ['R-RENT@2026-11-25', 'R-UTIL@2026-11-25']]);
  const pin = WE.plan_pin(['R-UTIL@2026-10-25']);
  const ws_pin = ok_edit(G, pin);
  const pw = waves_of(ws_pin).items;
  assert.ok(pw.some((i) => i.wave.event_ids.length === 1 && i.wave.event_ids[0] === 'R-UTIL@2026-10-25'));
  for (const w of [ws_split, ws_pin, G]) {
    const a = analyze(w, { as_of: w.as_of });
    const total = list_waves_ex(a, 'plan').items.reduce((s, i) => s + i.wave.total_out_minor, 0);
    assert.equal(total, sig_total, 'каждое значимое обязательство — ровно в одной волне');
  }
  const items = WE.wave_items(a0, 'plan');
  const ranged = WE.plan_pin_range(items, '2026-11-25', '2026-11-25');
  assert.equal(ranged.override.pin_range.from, '2026-11-25');
  assert.deepEqual(ranged.override.event_ids, ['R-RENT@2026-11-25', 'R-UTIL@2026-11-25'], 'платежи диапазона перечислены (запись без платежей слой записи не принимает)');
  assert.equal(WE.plan_pin_range(items, '2026-11-25', '2026-11-01'), null, 'перевёрнутый диапазон — не правка');
  assert.equal(WE.plan_pin_range(items, '2026-12-01', '2026-12-02'), null, 'в диапазоне нет платежей волн');
  assert.equal(WE.plan_pin([]), null);
  assert.ok(waves_of(ok_edit(G, ranged)).items.length >= 2);
});

test('TST-37 REQ-036: одна и та же правка идемпотентна — тот же идентификатор по содержимому, повтор не меняет ни волны, ни список правок', () => {
  const a0 = analyze(G, { as_of: G.as_of });
  const merge = WE.plan_merge(WE.wave_items(a0, 'plan'), 0);
  assert.equal(WE.override_id_for('merge', ['b', 'a']), WE.override_id_for('merge', ['a', 'b']), 'порядок платежей не важен');
  assert.notEqual(WE.override_id_for('merge', ['a', 'b']), WE.override_id_for('pin', ['a', 'b']));
  assert.match(merge.override.override_id, /^wov_[0-9a-f]{12}$/);
  const once = ok_edit(G, merge);
  assert.equal(WE.already_applied(G, merge), false);
  assert.equal(WE.already_applied(once, merge), true);
  const twice = ok_edit(once, merge); // даже если применить повторно, запись одна и та же
  assert.equal(twice.wave_overrides.length, 1);
  assert.equal(canon(twice.wave_overrides), canon(once.wave_overrides));
  assert.deepEqual(waves_of(twice).items.map((i) => i.wave.event_ids), waves_of(once).items.map((i) => i.wave.event_ids));
  // повторное применение правок движком тоже ничего не меняет (ALG-03)
  const ev = analyze(once, { as_of: once.as_of }).events.plan;
  const nat = detect_waves(ev, analyze(once, { as_of: once.as_of }).params);
  assert.equal(waves_of(once).items.length, 1);
  assert.equal(nat.length, 2);
});

test('TST-37 REQ-036: правка на исчезнувший платёж даёт W_OVERRIDE_STALE и статус «устарела»; снятие правки убирает её; правка переживает пересчёт с новым обязательством', () => {
  const stale = { type: 'set_wave_override', override: { override_id: 'wov_stale', action: 'merge', event_ids: ['P-TAX1', 'R-GONE@2026-12-01'] } };
  const ws = ok_edit(G, stale);
  const r = waves_of(ws);
  assert.ok(r.warnings.some((w) => w.code === 'W_OVERRIDE_STALE' && w.override_id === 'wov_stale' && w.event_ids.includes('R-GONE@2026-12-01')), JSON.stringify(r.warnings));
  const a = analyze(ws, { as_of: ws.as_of });
  assert.deepEqual(WE.list_overrides(ws, a).map((o) => [o.override_id, o.status, o.stale_ids]), [['wov_stale', 'stale', ['R-GONE@2026-12-01']]]);
  assert.deepEqual(SW.stale_overrides(a.events.plan, a.params, ws.wave_overrides).map((s) => s.override_id), ['wov_stale']);
  const removed = ok_edit(ws, WE.plan_remove('wov_stale'));
  assert.deepEqual(removed.wave_overrides, []);
  // правка переживает пересчёт: новое обязательство появилось, правка merge на месте и действует
  const merge = WE.plan_merge(WE.wave_items(analyze(G, { as_of: G.as_of }), 'plan'), 0);
  const with_merge = ok_edit(G, merge);
  const extra = { ...with_merge, plans: [...(with_merge.plans ?? []), { plan_id: 'P-NEW', account_id: 'acc_main', date: '2026-10-26', amount_minor: -20000, currency: 'EUR', kind: 'expense', tag: 'новое', is_obligation: true }] };
  const a2 = analyze(extra, { as_of: extra.as_of });
  assert.equal(extra.wave_overrides.length, 1, 'правка сохранилась');
  const w2 = list_waves_ex(a2, 'plan').items;
  assert.equal(w2.length, 1, 'правка merge действует после пересчёта');
  assert.equal(w2[0].wave.total_out_minor, 254000 + 20000);
  assert.equal(w2[0].wave.total_out_minor, sig_obligations(a2).reduce((s, e) => s - e.amount_minor, 0), 'Σ total_out = Σ значимых обязательств');
  assert.deepEqual(WE.list_overrides(extra, a2).map((o) => o.status), ['valid']);
});

test('REQ-036 порог θ и таблица чувствительности: строки по порогам и сетка «разрыв × размах» показывают, как сложились бы волны; данные не меняются', () => {
  const a = analyze(G, { as_of: G.as_of });
  const before = canon(G);
  const s = WE.sensitivity(a, 'plan');
  assert.equal(canon(G), before, 'таблица ничего не пишет');
  assert.deepEqual(s.current, { theta_minor: 3000, gap_days: 3, max_span_days: 10, wave_count: 2 });
  assert.equal(s.theta_rows.filter((r) => r.current).length, 1);
  const by = new Map(s.theta_rows.map((r) => [r.theta_minor, r]));
  assert.equal(by.get(2500).wave_count, 4, 'ниже порога появляются мелкие платежи: волн больше');
  assert.equal(by.get(2500).delta_waves, 2);
  assert.equal(by.get(90000).wave_count, 2);
  assert.equal(by.get(90000).covered_minor, 180000);
  assert.equal(by.get(3000).covered_minor, 254000);
  const cell = (g, S) => s.grid.find((r) => r.gap_days === g && r.max_span_days === S);
  assert.equal(cell(3, 10).current, true);
  assert.equal(cell(3, 10).wave_count, 2);
  assert.ok(cell(1, 10).wave_count >= cell(10, 10).wave_count, 'больший разрыв сливает волны');
  assert.ok(s.gaps.includes(3) && s.spans.includes(10));
  assert.throws(() => SW.sweep_waves(a.events.plan, a.params, { thetas: Array.from({ length: 30 }, (_, i) => i + 1), gaps: Array.from({ length: 10 }, (_, i) => i) }), /sweep_too_large|E_SCHEMA|слишком/i);
  // порог применяется отдельной правкой set_param и меняет волны
  const ws = ok_edit(G, WE.plan_theta(2500));
  assert.equal(ws.params['wave.threshold_minor'], 2500);
  assert.equal(waves_of(ws).items.length, 4);
  const back = ok_edit(ws, WE.plan_theta(null));
  assert.equal(back.params['wave.threshold_minor'], null);
});

test('REQ-036 «почему вместе?»: шаги платежей волны с разрывом и размахом, правило g и S, причина разделения соседних волн, происхождение волны', () => {
  const a = analyze(G, { as_of: G.as_of });
  const items = WE.wave_items(a, 'plan');
  const m = SW.explain_membership(a.events.plan, a.params, items[0].wave.event_ids);
  assert.deepEqual([m.gap_days_limit, m.max_span_days_limit, m.threshold_minor], [3, 10, 3000]);
  assert.deepEqual(m.steps.map((s) => [s.event_id, s.gap_days, s.span_days]), [['P-TAX1', null, 0], ['R-RENT@2026-10-25', 3, 3], ['R-UTIL@2026-10-25', 0, 3]]);
  assert.equal(m.together_by_rule, true);
  assert.equal(m.total_out_minor, 152000);
  const apart = SW.explain_boundary(a.events.plan, a.params, items[0].wave.event_ids, items[1].wave.event_ids);
  assert.deepEqual([apart.reason, apart.gap_days, apart.gap_days_limit], ['gap', 30, 3]);
  // волна, собранная правкой, правилу не отвечает
  const ws = ok_edit(G, WE.plan_merge(items, 0));
  const a2 = analyze(ws, { as_of: ws.as_of });
  const merged = WE.wave_items(a2, 'plan')[0];
  assert.equal(SW.explain_membership(a2.events.plan, a2.params, merged.wave.event_ids).together_by_rule, false);
  assert.equal(SW.wave_origin(detect_waves(a2.events.plan, a2.params), merged.wave), 'edited');
  // а правка split, сделанная вопреки правилу, помечается «вручную»
  const close = { ...G, params: { ...G.params, 'wave.gap_days': 60, 'wave.max_span_days': 60 } };
  const ac = analyze(close, { as_of: close.as_of });
  assert.equal(list_waves_ex(ac, 'plan').items.length, 1);
  const sp = ok_edit(close, WE.plan_split(WE.wave_items(ac, 'plan')[0], 'R-RENT@2026-11-25'));
  const asp = analyze(sp, { as_of: sp.as_of });
  const [w1, w2] = WE.wave_items(asp, 'plan');
  assert.equal(SW.explain_boundary(asp.events.plan, asp.params, w1.wave.event_ids, w2.wave.event_ids).reason, 'manual');
  assert.throws(() => SW.explain_boundary(a.events.plan, a.params, ['нет-такого'], ['P-TAX1']), /E_SCHEMA|wave_event_not_in_events/);
  assert.equal(model_of(G).ctx.params['wave.max_span_days'], 10);
});

// ── DOM в настоящем приложении ──────────────────────────────────────────────────────────────────────────────────────

const ORIG = JSON.parse(JSON.stringify(ext.ctx.get_ws()));
const reset = () => { const r = ext.ctx.set_ws(JSON.parse(JSON.stringify(ORIG)), { reason: 'test_reset' }); assert.equal(r.ok, true); };

test('TST-37 REQ-036 экран «Волны»: блок правок под календарём; «Объединить с волной 2» пишет wave_override.set общим путём, волна одна, правка видна в списке', async () => {
  reset();
  await go('#waves');
  assert.match(text_of('main'), /Правки волн/);
  assert.equal(find_all(byid.get('main'), (n) => n.className === 'card wave-edit').length, 1);
  const ctx = ext.ctx;
  const n0 = ctx.journal.length;
  press('Объединить с волной 2');
  assert.equal(ctx.get_ws().wave_overrides.length, 1);
  assert.equal(ctx.journal.length, n0 + 1);
  assert.equal(ctx.journal.at(n0).type, 'wave_override.set');
  assert.match(text_of('main'), /Волна 1 · 23 окт – 25 ноя · 5 платежей · 2\s540,00\s€/, 'одна волна с total_out 254000');
  assert.match(text_of('main'), /Волны объединены\./, 'подтверждение — после перерисовки');
  assert.match(text_of('main'), /состав изменён правками/);
  assert.match(text_of('main'), /объединить: .*/);
  assert.match(text_of('main'), /в силе/);
  assert.equal(find_all(byid.get('main'), (n) => n.className === 'card wave-card').length, 1, 'штатный экран приложения показал одну волну');
  press('Снять');
  assert.deepEqual(ctx.get_ws().wave_overrides, []);
  assert.equal(ctx.journal.at(n0 + 1).type, 'revert', 'снятие правки — откат записи журнала');
  assert.match(text_of('main'), /Правка снята\./);
});

test('TST-37 REQ-036 «Разделить» и «Закрепить» в DOM; повторное нажатие той же правки ничего не пишет («уже записана»)', async () => {
  reset();
  await go('#waves');
  const ctx = ext.ctx;
  field('we-pin-1').value = 'R-UTIL@2026-10-25';
  const n0 = ctx.journal.length;
  press('Закрепить отдельно');
  assert.equal(ctx.get_ws().wave_overrides.length, 1);
  assert.equal(ctx.get_ws().wave_overrides[0].action, 'pin');
  assert.equal(ctx.journal.length, n0 + 1);
  assert.match(text_of('main'), /Платёж закреплён отдельной волной\./);
  // та же правка ещё раз
  field('we-pin-1').value = 'R-UTIL@2026-10-25';
  const hash = ctx.get_model().ctx.inputs_hash;
  const found = find_all(byid.get('main'), (n) => n.tagName === 'select' && n.attrs.id?.startsWith('we-pin-'));
  const sel = found.find((s) => s.children.some((o) => o.attrs.value === 'R-UTIL@2026-10-25') && s.attrs.id !== 'we-pin-1') ?? found[0];
  sel.value = 'R-UTIL@2026-10-25';
  const btn = find_all(byid.get('main'), (n) => n.tagName === 'button' && n.textContent === 'Закрепить отдельно');
  let hit = false;
  for (const b of btn) { b.listeners.click[0](); if (/уже записана/.test(text_of('main'))) { hit = true; break; } }
  assert.ok(hit, 'сообщение «уже записана»');
  assert.equal(ctx.get_ws().wave_overrides.length, 1);
  assert.equal(ctx.journal.length, n0 + 1, 'повтор не пишет в журнал');
  assert.equal(ctx.get_model().ctx.inputs_hash, hash);
  reset();
  await go('#waves');
  field('we-split-1').value = 'R-RENT@2026-10-25';
  press('Разделить');
  assert.equal(ctx.get_ws().wave_overrides[0].action, 'split');
  assert.match(text_of('main'), /Волна разделена\./);
  assert.equal(find_all(byid.get('main'), (n) => n.className === 'card wave-card').length, 3);
});

test('REQ-036 устаревшая правка в DOM: «устарела: платежа больше нет» словами, кнопка «Снять» с подписью; закрепление диапазона дат и неверный диапазон', async () => {
  reset();
  const ctx = ext.ctx;
  const r = ctx.edit({ type: 'set_wave_override', override: { override_id: 'wov_gone', action: 'pin', event_ids: ['R-GONE@2026-12-01'] } });
  assert.equal(r.ok, true);
  await go('#waves');
  assert.match(text_of('main'), /устарела: платежа больше нет/);
  press('Снять правку: закрепить: R-GONE');
  assert.deepEqual(ctx.get_ws().wave_overrides, []);
  await go('#waves');
  field('we-pin-from').value = '2026-11-20';
  field('we-pin-to').value = '2026-11-10';
  press('Закрепить даты');
  assert.match(text_of('main'), /Диапазон дат неверен/);
  assert.deepEqual(ctx.get_ws().wave_overrides, []);
  field('we-pin-from').value = '2026-11-25';
  field('we-pin-to').value = '2026-11-25';
  press('Закрепить даты');
  assert.equal(ctx.get_ws().wave_overrides[0].pin_range.from, '2026-11-25');
  assert.match(text_of('main'), /25 ноя – 25 ноя/);
});

test('REQ-036 «Почему вместе?» — диалог с правилом, шагами и выводом; «Почему такая потребность» — диалог волны', async () => {
  reset();
  await go('#waves');
  press('Почему вместе?');
  assert.equal(byid.get('dlg-title').textContent, 'Волна 1: почему вместе');
  const body = text_of('dlg-body');
  assert.match(body, /разрыв до предыдущего не больше 3 дн\. и размах от первого меньше 10 дн\./);
  assert.match(body, /Все платежи укладываются в правило: наибольший разрыв 3 дн\., размах 3 дн\./);
  assert.match(body, /Волна 2 отдельно: разрыв до неё 30 дн\. больше предела 3 дн\./);
  assert.deepEqual(a11y_problems(byid.get('dlg-body')), []);
});

test('REQ-036 порог θ в DOM: сохранение в формате чисел пользователя, отказ на мусоре, таблица чувствительности с подписями; применение порога из таблицы', async () => {
  reset();
  await go('#waves');
  const ctx = ext.ctx;
  field('we-theta').value = 'много';
  press('Сохранить порог');
  assert.match(text_of('main'), /Не удалось прочитать порог/);
  assert.equal(ctx.get_ws().params['wave.threshold_minor'], 3000);
  field('we-theta').value = '25';
  press('Сохранить порог');
  assert.equal(ctx.get_ws().params['wave.threshold_minor'], 2500);
  assert.match(text_of('main'), /Порог волны сохранён\./);
  assert.match(text_of('main'), /Сейчас порог 25,00\s€/);
  assert.equal(find_all(byid.get('main'), (n) => n.className === 'card wave-card').length, 4);
  assert.match(text_of('main'), /Таблица чувствительности/);
  assert.match(text_of('main'), /волн больше на 2|столько же/);
  press('Взять порог 120,00 €');
  assert.equal(ctx.get_ws().params['wave.threshold_minor'], 12000);
  press('Вернуть порог по умолчанию');
  assert.equal(ctx.get_ws().params['wave.threshold_minor'], null);
  reset();
});

test('TST-58 новые блоки правок волн: подписи таблиц и полей, aria-labelledby, состояние правки — словами; нет inline-стилей', async () => {
  reset();
  await go('#waves');
  press('Объединить с волной 2');
  assert.deepEqual(a11y_problems(byid.get('main')), []);
  const status = find_all(byid.get('main'), (n) => n.attrs.role === 'status' && n.attrs['aria-live'] === 'polite');
  assert.ok(status.length >= 1, 'сообщения о действии читает скринридер');
  assert.match(text_of('main'), /в силе/);
  reset();
});
