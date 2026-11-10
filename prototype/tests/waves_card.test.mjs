// waves_card.test.mjs — S1.5: слот реестра `waves.card` — кнопки «Почему так» и «Править волну» прямо на карточке волны
// (TST-37, REQ-036 правки волн; REQ-104 «почему» у каждого числа; TST-58 доступность; TST-56 строки RU/EN).
// Слот вызывается приложением для КАЖДОЙ карточки: `render(ctx, card)`, `card = {wave, mode, index}`; у остальных слотов `render` получает один аргумент.
// Пакет FP-07 кладёт в слот две кнопки: «Почему так» (штатный диалог «Почему волна N») и «Править волну» (диалог с теми же правками merge / split / pin,
// запись общим путём ctx.edit). Чистые модели (wave_edit.mjs) — на четырёх наборах G-001; DOM — в настоящем app.mjs на заглушке DOM. Браузер не используется.

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

const EXT = await import(pathToFileURL(path.join(DEMO, 'ext.mjs')).href);
const { ext, SLOTS, create_ext, ExtError } = EXT;

// наблюдатель слота: что приложение отдаёт слоту waves.card (регистрируем ДО запуска; узлов не возвращает, вёрстку не меняет)
const seen_cards = [];
ext.register_slot_item('waves.card', { id: 'wc_probe', order: -1000, render: (...args) => { seen_cards.push({ argc: args.length, ctx: args[0], card: args[1] }); return null; } });

await import(pathToFileURL(path.join(DEMO, 'app.mjs')).href);
await new Promise((r) => setTimeout(r, 500));
const WE = await import(pathToFileURL(path.join(DEMO, 'wave_edit.mjs')).href);
const W = await import(pathToFileURL(path.join(DEMO, 'why_more.mjs')).href);
const SCEN = (await import(pathToFileURL(path.join(DEMO, 'i18n', 'scenarios.mjs')).href)).default;
const { LABELS } = await import('../engine/verifier.mjs');
const { make_tool_ctx } = await import('../engine/tools.mjs');
const { list_waves_ex, analyze, canon } = await import('../engine/index.mjs');
const { apply_edit } = await import(pathToFileURL(path.join(DEMO, 'ws_edit.mjs')).href);

const read = (name) => JSON.parse(fs.readFileSync(path.join(DATA, name + '.json'), 'utf8'));
const G = read('g001');
const model_of = (ws) => ({ ws, ctx: make_tool_ctx(ws, { as_of: ws.as_of }, {}) });
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };
const text_of = (id) => byid.get(id).textContent;
const main = () => byid.get('main');
const dlg_body = () => byid.get('dlg-body');
const cards_on_page = () => find_all(main(), (n) => n.className === 'card wave-card');
const btn_by_id = (root, id) => find_all(root, (n) => n.tagName === 'button' && n.attrs.id === id)[0];
const press_in = (root, label) => {
  const b = find_all(root, (n) => n.tagName === 'button' && (n.textContent === label || n.attrs['aria-label'] === label))[0];
  assert.ok(b !== undefined, 'нет кнопки «' + label + '»');
  b.listeners.click[0]();
  return b;
};
const set_mode = (m) => {
  const label = LABELS.modes.ru[m];
  const b = find_all(byid.get('controls'), (n) => n.tagName === 'button' && n.attrs['aria-pressed'] !== undefined && n.textContent === label)[0];
  assert.ok(b !== undefined, 'нет переключателя режима «' + label + '»');
  b.listeners.click[0]();
};
const set_lang = (l) => {
  const b = find_all(byid.get('controls'), (n) => n.tagName === 'button' && n.attrs.lang === l)[0];
  assert.ok(b !== undefined, 'нет переключателя языка ' + l);
  b.listeners.click[0]();
};
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
    if (/\b(bad|short|tight|current)\b/.test(n.className) && n.textContent.trim() === '' && n.children.length === 0) bad.push('цветовой знак без текста');
  });
  return bad;
};
const strip_seq = (x) => { const { seq: _seq, ...rest } = x; return canon(rest); }; // номер записи ставит свёртка журнала: при сравнении правок не учитывается
const dup_ids = (root) => {
  const seen = new Set();
  const dup = [];
  root.walk((n) => { const id = n.attrs.id; if (id !== undefined) { if (seen.has(id)) dup.push(id); seen.add(id); } });
  return dup;
};

const ORIG = JSON.parse(JSON.stringify(ext.ctx.get_ws()));
const reset = () => {
  const r = ext.ctx.set_ws(JSON.parse(JSON.stringify(ORIG)), { reason: 'test_reset' });
  assert.equal(r.ok, true);
  set_lang('ru');
  set_mode('plan');
};
/** Описание карточки, как его строит приложение (`wave` — волна «по плану», `index` — с нуля). */
const card_of = (a, mode, index) => ({ wave: list_waves_ex(a, 'plan').items[index].wave, mode, index });

// ── реестр: слот и контекст карточки ────────────────────────────────────────────────────────────────────────────────

test('TST-37 REQ-036 слот waves.card: есть в замороженном списке SLOTS; пакет регистрирует в нём блок; неизвестный слот по-прежнему ExtError', () => {
  assert.ok(SLOTS.includes('waves.card'));
  assert.ok(Object.isFrozen(SLOTS), 'список слотов заморожен');
  assert.ok(SLOTS.includes('waves.actions'), 'старый слот на месте');
  const e = create_ext();
  assert.equal(e.register_slot_item('waves.card', { id: 'x_card', render: () => null }), 'x_card');
  assert.throws(() => e.register_slot_item('waves.cards', { id: 'x_card', render: () => null }), ExtError);
  assert.throws(() => e.register_slot_item('waves.card', { id: 'x_card', render: () => null }), ExtError, 'повтор идентификатора в слоте');
  assert.doesNotThrow(() => e.register_slot_item('waves.actions', { id: 'x_card', render: () => null }), 'тот же id в другом слоте — можно');
  assert.deepEqual(e.slot_nodes('waves.card', e.ctx, { index: 0 }), [], 'блок вернул null — узлов нет');
});

test('REQ-036 render слота waves.card получает (ctx, card); у остальных слотов render по-прежнему получает один аргумент; ctx по умолчанию — общий', () => {
  const e = create_ext();
  const calls = [];
  const el = (t) => ({ nodeType: 1, tagName: t });
  // идентификаторы блоков — по правилам реестра: [a-z][a-z0-9_]{1,24}
  e.register_slot_item('waves.card', { id: 'blk_card', order: 1, render: (...args) => { calls.push(['card', args.length, args[0] === e.ctx, args[1]]); return el('A'); } });
  e.register_slot_item('overview.cards', { id: 'blk_over', render: (...args) => { calls.push(['overview', args.length, args[0] === e.ctx]); return el('O'); } });
  e.register_slot_item('waves.actions', { id: 'blk_acts', render: (...args) => { calls.push(['actions', args.length, args[0] === e.ctx]); return el('W'); } });
  assert.throws(() => e.register_slot_item('waves.card', { id: 'a', render: () => null }), ExtError, 'одно-символьный id реестр отвергает (правило не ослаблено)');
  const card = Object.freeze({ wave: { wave_id: 'wave:x' }, mode: 'plan', index: 3 });
  assert.equal(e.slot_nodes('waves.card', e.ctx, card).length, 1);
  assert.equal(e.slot_nodes('overview.cards').length, 1);
  assert.equal(e.slot_nodes('overview.cards', e.ctx).length, 1);
  assert.equal(e.slot_nodes('waves.actions').length, 1);
  assert.deepEqual(calls, [['card', 2, true, card], ['overview', 1, true], ['overview', 1, true], ['actions', 1, true]]);
  assert.equal(calls[0][3], card, 'карточка передаётся как есть, без копии');
});

test('REQ-036 падение блока слота waves.card не ломает остальные блоки той же карточки и другие карточки (safe в ext); сбой — в диагностике, без пользовательских текстов', () => {
  const e = create_ext();
  const el = (t) => ({ nodeType: 1, tagName: t });
  e.register_slot_item('waves.card', { id: 'first', order: 1, render: (_c, card) => el('first-' + card.index) });
  e.register_slot_item('waves.card', { id: 'bad', order: 2, render: (_c, card) => { throw new TypeError('сбой на карточке ' + card.index); } });
  e.register_slot_item('waves.card', { id: 'str', order: 3, render: () => 'не узел' });
  e.register_slot_item('waves.card', { id: 'last', order: 4, render: (_c, card) => [el('last-' + card.index), null] });
  for (const index of [0, 1]) {
    const nodes = e.slot_nodes('waves.card', e.ctx, { wave: {}, mode: 'worse', index });
    assert.deepEqual(nodes.map((n) => n.tagName), ['first-' + index, 'last-' + index], 'упавший и неузловой блоки пропущены, остальные на месте');
  }
  const failed = e.diagnostics().filter((d) => d.status === 'failed');
  assert.equal(failed.length, 2, 'по одному сбою на карточку');
  assert.ok(failed.every((d) => d.label === 'slot:waves.card/bad'));
  const notes = e.diagnostics().filter((d) => d.status === 'notify' && d.kind === 'error');
  assert.equal(notes.length, 2, 'пользователь получает сообщение о блоке');
  assert.ok(notes.every((d) => !/сбой на карточке/.test(d.message)), 'в сообщение пользователю текст исключения не попадает');
});

test('REQ-036 пакет, зарегистрировавший блок в waves.card и упавший в register, откатывается вместе с блоком (load_packs)', async () => {
  const e = create_ext({ loaders: {} });
  await e.load_packs({
    good: async () => ({ register(x) { x.register_slot_item('waves.card', { id: 'good_card', render: () => ({ nodeType: 1, tagName: 'G' }) }); } }),
    broken: async () => ({ register(x) { x.register_slot_item('waves.card', { id: 'half_card', render: () => ({ nodeType: 1, tagName: 'H' }) }); throw new Error('упал'); } }),
  });
  assert.deepEqual(e.slot_nodes('waves.card', e.ctx, {}).map((n) => n.tagName), ['G'], 'блок упавшего пакета снят');
  assert.deepEqual(e.diagnostics().filter((d) => d.pack !== undefined).map((d) => [d.pack, d.status]), [['good', 'ok'], ['broken', 'failed']]);
});

// ── чистые модели карточки ──────────────────────────────────────────────────────────────────────────────────────────

test('REQ-036 is_wave_card: принимает {wave, mode, index} и отвергает чужие формы (нет волны, режим не plan/worse, индекс не целое ≥ 0)', () => {
  const wave = list_waves_ex(model_of(G).ctx, 'plan').items[0].wave;
  assert.equal(WE.is_wave_card({ wave, mode: 'plan', index: 0 }), true);
  assert.equal(WE.is_wave_card({ wave, mode: 'worse', index: 5 }), true);
  for (const bad of [null, undefined, 7, 'x', {}, { wave, mode: 'plan' }, { wave, mode: 'best', index: 0 }, { wave, mode: 'plan', index: -1 }, { wave, mode: 'plan', index: 0.5 },
    { wave: null, mode: 'plan', index: 0 }, { wave: { ...wave, event_ids: 'P-TAX1' }, mode: 'plan', index: 0 }, { wave: { ...wave, wave_id: 7 }, mode: 'plan', index: 0 },
    { wave: { ...wave, start: 'x' }, mode: 'plan', index: 0 }]) {
    assert.equal(WE.is_wave_card(bad), false, JSON.stringify(bad));
  }
});

test('REQ-104 TST-07 wave_item_of: волна карточки в режиме страницы — метрики режима и разложение «почему» сходится с пиковой просадкой на четырёх наборах G-001', () => {
  for (const name of ['g001', 'g001-low', 'g001-late', 'g001-gap']) {
    const m = model_of(read(name));
    for (const mode of ['plan', 'worse']) {
      const plan_items = list_waves_ex(m.ctx, 'plan').items;
      assert.ok(plan_items.length >= 2, name);
      plan_items.forEach((_, index) => {
        const card = card_of(m.ctx, mode, index);
        const it = WE.wave_item_of(m.ctx, card);
        const expect = list_waves_ex(m.ctx, mode).items.find((x) => x.wave.wave_id === card.wave.wave_id) ?? list_waves_ex(m.ctx, mode).items[index];
        assert.equal(it.n, index + 1);
        assert.equal(it.mode, mode);
        assert.equal(canon(it.metrics), canon(expect.metrics), `${name} ${mode} ${index}: метрики режима`);
        const w = W.wave_why(m, it.mode, it);
        assert.equal(w.ok, true, `${name} ${mode} ${index}`);
        assert.equal(w.total_minor, it.metrics.r_minor, 'сумма строк = просадка окна волны');
      });
    }
  }
  const m = model_of(G);
  assert.equal(WE.wave_item_of(m.ctx, card_of(m.ctx, 'plan', 0)).metrics.r_minor, 172000, 'G-001, волна 1, по плану');
});

test('REQ-036 wave_item_of: нет такой волны в режиме — берётся по номеру в списке, затем «по плану»; нет нигде — null', () => {
  const m = model_of(G);
  const real = card_of(m.ctx, 'worse', 1);
  const renamed = { ...real, wave: { ...real.wave, wave_id: 'wave:нет-такой' } };
  assert.equal(WE.wave_item_of(m.ctx, renamed).wave.wave_id, list_waves_ex(m.ctx, 'worse').items[1].wave.wave_id, 'по номеру в списке режима');
  assert.equal(WE.wave_item_of(m.ctx, { ...renamed, index: 9 }), null, 'нет ни по id, ни по номеру');
  assert.equal(WE.card_edit_plan(m.ctx, { ...renamed, index: 9 }), null);
  assert.equal(WE.card_edit_plan(m.ctx, renamed).index, 1);
});

test('TST-37 REQ-036 card_edit_plan: правки карточки — те же готовые планы (plan_merge), что в блоке waves.actions; на крайних волнах соседа с одной стороны нет', () => {
  const m = model_of(G);
  const items = WE.wave_items(m.ctx, 'plan');
  assert.equal(items.length, 2);
  const first = WE.card_edit_plan(m.ctx, card_of(m.ctx, 'plan', 0));
  const last = WE.card_edit_plan(m.ctx, card_of(m.ctx, 'worse', 1));
  assert.deepEqual([first.merge_prev, last.merge_next], [null, null]);
  assert.equal(canon(first.merge_next), canon(WE.plan_merge(items, 0)));
  assert.equal(canon(last.merge_prev), canon(WE.plan_merge(items, 0)), 'объединение со следующей у первой и с предыдущей у второй — одна и та же правка');
  assert.equal(first.merge_next.override.override_id, last.merge_prev.override.override_id);
  const r = apply_edit(G, first.merge_next, { new_id: (p) => p + '_t' });
  assert.equal(r.ok, true);
  assert.equal(list_waves_ex(analyze(r.ws, { as_of: r.ws.as_of }), 'plan').items.length, 1);
  assert.equal(first.item.members.length, 3);
  assert.equal(WE.plan_split(first.item, first.item.members[0].cash_event_id), null, 'перед первым платежом резать нечего (как в блоке waves.actions)');
});

test('TST-56 строки карточки волны: ключи scenarios.wc_* есть в RU и EN, плейсхолдеры совпадают, ни одна строка не пустая', () => {
  const keys = Object.keys(SCEN.ru).filter((k) => k.startsWith('scenarios.wc_'));
  assert.deepEqual(keys.sort(), ['scenarios.wc_edit', 'scenarios.wc_edit_label', 'scenarios.wc_edit_lead', 'scenarios.wc_edit_title', 'scenarios.wc_gone', 'scenarios.wc_why', 'scenarios.wc_why_label']);
  assert.deepEqual(Object.keys(SCEN.en).filter((k) => k.startsWith('scenarios.wc_')).sort(), keys);
  const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort().join(',');
  for (const k of keys) {
    assert.ok(SCEN.ru[k].trim() !== '' && SCEN.en[k].trim() !== '', k);
    assert.equal(ph(SCEN.ru[k]), ph(SCEN.en[k]), k);
  }
  assert.equal(ph(SCEN.ru['scenarios.wc_why_label']), 'n,range');
  assert.equal(ph(SCEN.ru['scenarios.wc_edit_label']), 'n,range');
});

// ── DOM в настоящем приложении ──────────────────────────────────────────────────────────────────────────────────────

test('boot: пакет FP-07 подхвачен; блок fp07_wave_card зарегистрирован в слоте waves.card и отдаёт две кнопки для карточки', () => {
  assert.deepEqual(ext.diagnostics().filter((d) => d.pack === 'pack_fp07').map((d) => d.status), ['ok'], JSON.stringify(ext.diagnostics()));
  const m = ext.ctx.get_model();
  const nodes = ext.slot_nodes('waves.card', ext.ctx, card_of(m.ctx, 'plan', 0));
  assert.equal(nodes.length, 1, 'наблюдатель узлов не даёт, блок FP-07 — один');
  assert.deepEqual(find_all(nodes[0], (n) => n.tagName === 'button').map((b) => b.textContent), ['Почему так', 'Править волну']);
  assert.deepEqual(ext.slot_nodes('waves.card', ext.ctx, { wave: null, mode: 'x' }), [], 'карточка не той формы — блок молча пропущен');
  assert.equal(ext.diagnostics().filter((d) => d.status === 'failed' && /waves\.card/.test(d.label ?? '')).length, 0, 'и сбоем это не считается');
});

test('REQ-036 TST-37 приложение вызывает слот для КАЖДОЙ карточки в обоих режимах: (ctx, {wave, mode, index}), карточка заморожена, номер с нуля', async () => {
  reset();
  for (const mode of ['plan', 'worse']) {
    set_mode(mode);
    await go('#waves');
    seen_cards.length = 0;
    await go('#waves');
    const items = list_waves_ex(ext.ctx.get_model().ctx, 'plan').items;
    assert.equal(seen_cards.length, items.length, `${mode}: по вызову на карточку`);
    assert.equal(cards_on_page().length, items.length);
    seen_cards.forEach((c, i) => {
      assert.equal(c.argc, 2, 'два аргумента: ctx и карточка');
      assert.equal(c.ctx, ext.ctx);
      assert.deepEqual(Object.keys(c.card).sort(), ['index', 'mode', 'wave']);
      assert.equal(c.card.mode, mode);
      assert.equal(c.card.index, i);
      assert.equal(c.card.wave.wave_id, items[i].wave.wave_id);
      assert.deepEqual(c.card.wave.event_ids, items[i].wave.event_ids);
      assert.ok(Object.isFrozen(c.card), 'блок не может подменить карточку приложения');
    });
    assert.equal(seen_cards[0].card.wave.wave_id, 'wave:P-TAX1');
  }
});

test('TST-37 REQ-036 на каждой карточке волны в обоих режимах — кнопки «Почему так» и «Править волну» в конце карточки; идентификаторы с режимом и номером, на странице не повторяются', async () => {
  reset();
  for (const mode of ['plan', 'worse']) {
    set_mode(mode);
    await go('#waves');
    const cards = cards_on_page();
    assert.equal(cards.length, 2, 'две волны G-001');
    cards.forEach((card, i) => {
      const last = card.children.at(-1);
      assert.equal(last.className, 'actions wc-actions', `${mode} ${i}: блок кнопок — последний в карточке`);
      assert.deepEqual(find_all(last, (n) => n.tagName === 'button').map((b) => [b.attrs.id, b.textContent]),
        [[`wc-why-${mode}-${i}`, 'Почему так'], [`wc-edit-${mode}-${i}`, 'Править волну']]);
      assert.ok(card.children.slice(0, -1).some((c) => c.tagName === 'table'), 'таблица карточки на месте');
    });
    assert.deepEqual(dup_ids(main()), [], `${mode}: идентификаторы на странице уникальны`);
    assert.equal(find_all(main(), (n) => n.className === 'card wave-edit').length, 1, 'блок «Правки волн» (слот waves.actions) остался');
    assert.equal(find_all(main(), (n) => n.attrs.id === 'we-split-1').length, 1, 'и его поля с прежними идентификаторами');
  }
  assert.equal(find_all(main(), (n) => n.attrs.id === 'wc-why-plan-0').length, 0, 'чужого режима на странице нет');
});

test('TST-58 кнопки карточки: aria-label с номером и датами волны (текст кнопки — начало подписи), нет inline-стилей, смысл не цветом; страница без замечаний', async () => {
  reset();
  for (const mode of ['plan', 'worse']) {
    set_mode(mode);
    await go('#waves');
    const f = ext.ctx.fmt();
    const items = list_waves_ex(ext.ctx.get_model().ctx, 'plan').items;
    items.forEach((it, i) => {
      const range = it.wave.start === it.wave.end ? f.short(it.wave.start) : f.short(it.wave.start) + ' – ' + f.short(it.wave.end);
      const why = btn_by_id(main(), `wc-why-${mode}-${i}`);
      const edit = btn_by_id(main(), `wc-edit-${mode}-${i}`);
      assert.equal(why.attrs['aria-label'], `Почему так: волна ${i + 1}, ${range}`);
      assert.equal(edit.attrs['aria-label'], `Править волну ${i + 1}, ${range}`);
      for (const b of [why, edit]) {
        assert.ok(b.attrs['aria-label'].startsWith(b.textContent), 'видимый текст входит в доступное имя (WCAG 2.5.3)');
        assert.equal(b.attrs.type, 'button');
        assert.equal(b.attrs.style, undefined);
      }
    });
    assert.deepEqual(a11y_problems(main()), [], mode);
  }
});

test('REQ-104 «Почему так» на карточке: открывает штатный диалог «Почему волна N» с цепочкой; сумма строк равна пиковой просадке окна — для каждой волны в обоих режимах', async () => {
  reset();
  for (const mode of ['plan', 'worse']) {
    set_mode(mode);
    await go('#waves');
    const model = ext.ctx.get_model();
    const f = ext.ctx.fmt();
    const items = list_waves_ex(model.ctx, mode).items;
    for (const [i] of items.entries()) {
      btn_by_id(main(), `wc-why-${mode}-${i}`).listeners.click[0]();
      assert.equal(byid.get('dlg-title').textContent, `Почему волна ${i + 1}`);
      assert.equal(byid.get('dlg').open, true);
      const body = text_of('dlg-body');
      const w = W.wave_why(model, mode, { ...items[i], n: i + 1 });
      assert.equal(w.ok, true);
      assert.equal(w.total_minor, items[i].metrics.r_minor);
      assert.match(body, /Из чего сложилась потребность волны/);
      assert.ok(body.includes(`Сходится: сумма строк ${f.money(w.r_minor)} равна пиковой просадке окна ${f.money(w.r_minor)}.`), `${mode} ${i}: ${body.slice(0, 400)}`);
      assert.deepEqual(a11y_problems(dlg_body()), []);
    }
  }
  set_mode('plan');
  await go('#waves');
  btn_by_id(main(), 'wc-why-plan-0').listeners.click[0]();
  assert.match(text_of('dlg-body'), /Сходится: сумма строк 1\s720,00\s€ равна пиковой просадке окна 1\s720,00\s€/, 'G-001, волна 1, по плану: 1 720,00 €');
  // тот же диалог, что у кнопки «Почему такая потребность» блока waves.actions
  const via_card = text_of('dlg-body');
  press_in(main(), 'Почему такая потребность');
  assert.equal(text_of('dlg-body'), via_card, 'один и тот же диалог, а не копия');
});

test('TST-37 REQ-036 «Править волну»: диалог с объединением, разделением и закреплением; соседей предлагает только существующих; поля подписаны, идентификаторы с режимом и номером', async () => {
  reset();
  for (const mode of ['plan', 'worse']) {
    set_mode(mode);
    await go('#waves');
    btn_by_id(main(), `wc-edit-${mode}-0`).listeners.click[0]();
    assert.equal(byid.get('dlg-title').textContent, 'Править волну 1');
    assert.equal(byid.get('dlg').open, true);
    let body = text_of('dlg-body');
    // Волна 1 G-001 (golden `G-001.waves.w1.composition`): 23 окт – 26 окт, 152 000 минорных единиц. Аренда и ЖКХ по правилу «25-го» падают на воскресенье,
    // правило `weekend: next` переносит платёж на понедельник 26 окт — конец волны 26 окт, а не 25 окт (код верен; дата в прежнем ожидании теста была ошибкой).
    assert.match(body, /Волна 1 · 23 окт – 26 окт · платежей 3 · 1\s520,00\s€/);
    assert.match(body, /состав по правилам/);
    const labels = (root) => find_all(root, (n) => n.tagName === 'button').map((b) => b.textContent);
    assert.deepEqual(labels(dlg_body()), ['Объединить с волной 2', 'Разделить', 'Закрепить отдельно'], 'у первой волны предыдущей нет');
    assert.ok(find_all(dlg_body(), (n) => n.tagName === 'select' && n.attrs.id === `wcd-split-${mode}-0`).length === 1);
    assert.ok(find_all(dlg_body(), (n) => n.tagName === 'select' && n.attrs.id === `wcd-pin-${mode}-0`).length === 1);
    assert.deepEqual(a11y_problems(dlg_body()), []);
    assert.deepEqual(dup_ids(dlg_body()), []);
    btn_by_id(main(), `wc-edit-${mode}-1`).listeners.click[0]();
    assert.equal(byid.get('dlg-title').textContent, 'Править волну 2');
    body = text_of('dlg-body');
    assert.deepEqual(labels(dlg_body()), ['Объединить с волной 1', 'Разделить', 'Закрепить отдельно'], 'у последней волны следующей нет');
    assert.deepEqual(find_all(dlg_body(), (n) => n.tagName === 'select' && n.attrs.id === `wcd-split-${mode}-1`).map((s) => s.children.length), [1], 'резать можно перед вторым платежом');
    // идентификаторы диалога не пересекаются с идентификаторами страницы
    const page = new Set(find_all(main(), (n) => n.attrs.id !== undefined).map((n) => n.attrs.id));
    for (const n of find_all(dlg_body(), (x) => x.attrs.id !== undefined)) assert.ok(!page.has(n.attrs.id), 'id диалога повторяет id страницы: ' + n.attrs.id);
  }
});

test('TST-37 REQ-036 «Объединить» из карточки пишет ту же правку set_wave_override общим путём ctx.edit (журнал, подписчики, перерисовка); диалог закрывается, итог читает скринридер', async () => {
  for (const mode of ['plan', 'worse']) {
    reset();
    set_mode(mode);
    await go('#waves');
    const events = [];
    const off = ext.ctx.subscribe((e) => events.push(e));
    const n0 = ext.ctx.journal.length;
    const expect = WE.plan_merge(WE.wave_items(ext.ctx.get_model().ctx, 'plan'), 0);
    btn_by_id(main(), `wc-edit-${mode}-0`).listeners.click[0]();
    press_in(dlg_body(), 'Объединить с волной 2');
    off();
    assert.deepEqual(events.map((e) => e.reason), ['set_wave_override'], `${mode}: вид правки`);
    assert.equal(events[0].before.wave_overrides?.length ?? 0, 0);
    const ws = ext.ctx.get_ws();
    assert.equal(ws.wave_overrides.length, 1);
    assert.equal(strip_seq(ws.wave_overrides[0]), strip_seq(expect.override), 'та же правка, что строит блок waves.actions');
    assert.equal(ext.ctx.journal.length, n0 + 1);
    assert.equal(ext.ctx.journal.at(n0).type, 'wave_override.set');
    assert.equal(byid.get('dlg').open, false, 'диалог закрыт: его кнопки после перерисовки устарели');
    assert.equal(cards_on_page().length, 1, 'страница перерисована: одна волна');
    assert.match(text_of('main'), /Волна 1 · 23 окт – 25 ноя · 5 платежей · 2\s540,00\s€/);
    assert.equal(text_of('live'), 'Волны объединены.', 'итог — в живой области для скринридера');
    assert.match(text_of('main'), /Волны объединены\./, 'и словами на странице (блок «Правки волн»)');
    assert.deepEqual(a11y_problems(main()), []);
    assert.equal(btn_by_id(main(), `wc-edit-${mode}-0`) !== undefined && btn_by_id(main(), `wc-edit-${mode}-1`) === undefined, true, 'у единственной волны одна пара кнопок');
    assert.ok(find_all(main(), (n) => n.tagName === 'button' && n.textContent === 'Снять').length === 1, 'правка видна в списке и снимается там же');
    press_in(main(), 'Снять');
    assert.deepEqual(ext.ctx.get_ws().wave_overrides, []);
  }
});

test('TST-37 REQ-036 «Разделить» и «Закрепить» из карточки: правки split и pin; повтор той же правки ничего не пишет («уже записана»), как в блоке waves.actions', async () => {
  reset();
  await go('#waves');
  const ctx = ext.ctx;
  btn_by_id(main(), 'wc-edit-plan-0').listeners.click[0]();
  find_all(dlg_body(), (n) => n.attrs.id === 'wcd-split-plan-0')[0].value = 'R-RENT@2026-10-25';
  press_in(dlg_body(), 'Разделить');
  assert.equal(ctx.get_ws().wave_overrides.length, 1);
  assert.deepEqual([ctx.get_ws().wave_overrides[0].action, ctx.get_ws().wave_overrides[0].event_ids], ['split', ['R-RENT@2026-10-25']]);
  assert.equal(cards_on_page().length, 3, 'волна разделена: три карточки, у каждой свои кнопки');
  assert.deepEqual(cards_on_page().map((c) => find_all(c, (n) => n.tagName === 'button').map((b) => b.attrs.id)),
    [['wc-why-plan-0', 'wc-edit-plan-0'], ['wc-why-plan-1', 'wc-edit-plan-1'], ['wc-why-plan-2', 'wc-edit-plan-2']]);
  assert.equal(text_of('live'), 'Волна разделена.');

  reset();
  await go('#waves');
  const n0 = ctx.journal.length;
  btn_by_id(main(), 'wc-edit-plan-0').listeners.click[0]();
  find_all(dlg_body(), (n) => n.attrs.id === 'wcd-pin-plan-0')[0].value = 'R-UTIL@2026-10-25';
  const pin = press_in(dlg_body(), 'Закрепить отдельно');
  assert.deepEqual([ctx.get_ws().wave_overrides.length, ctx.get_ws().wave_overrides[0].action], [1, 'pin']);
  assert.equal(ctx.journal.length, n0 + 1);
  assert.equal(text_of('live'), 'Платёж закреплён отдельной волной.');
  const hash = ctx.get_model().ctx.inputs_hash;
  // кнопка того же диалога нажата ещё раз: правка уже записана
  byid.get('dlg').showModal();
  const status = find_all(dlg_body(), (n) => n.attrs.role === 'status')[0];
  pin.listeners.click[0]();
  assert.match(status.textContent, /уже записана/);
  assert.equal(ctx.get_ws().wave_overrides.length, 1);
  assert.equal(ctx.journal.length, n0 + 1, 'повтор не пишет в журнал');
  assert.equal(ctx.get_model().ctx.inputs_hash, hash);
  assert.equal(byid.get('dlg').open, true, 'при отказе записи диалог остаётся открытым, сообщение — в нём');
  reset();
});

test('REQ-036 правка с карточки и правка блока waves.actions — взаимозаменяемы: одна и та же правка по любому пути получает один и тот же идентификатор', async () => {
  reset();
  await go('#waves');
  const ctx = ext.ctx;
  btn_by_id(main(), 'wc-edit-plan-0').listeners.click[0]();
  press_in(dlg_body(), 'Объединить с волной 2');
  const n1 = ctx.journal.length;
  // та же правка из блока «Правки волн»: после объединения кнопки «Объединить» уже нет, снимаем и применяем заново из блока
  press_in(main(), 'Снять');
  assert.deepEqual(ctx.get_ws().wave_overrides, []);
  press_in(main(), 'Объединить с волной 2');
  assert.equal(ctx.get_ws().wave_overrides.length, 1);
  assert.equal(ctx.journal.length, n1 + 2, 'снятие и повторная запись');
  const id_block = ctx.get_ws().wave_overrides[0].override_id;
  press_in(main(), 'Снять');
  btn_by_id(main(), 'wc-edit-plan-0').listeners.click[0]();
  press_in(dlg_body(), 'Объединить с волной 2');
  assert.equal(ctx.get_ws().wave_overrides[0].override_id, id_block, 'тот же идентификатор по содержимому');
  reset();
});

test('REQ-036 «Править волну»/«Почему так» для исчезнувшей волны: диалога нет, пользователь получает сообщение; блок не падает', async () => {
  reset();
  await go('#waves');
  const m = ext.ctx.get_model();
  const gone = { wave: { ...card_of(m.ctx, 'plan', 0).wave, wave_id: 'wave:нет-такой' }, mode: 'plan', index: 9 };
  byid.get('dlg').close();
  assert.equal(WE.open_card_why(ext.ctx, gone), false);
  assert.equal(text_of('live'), 'Этой волны больше нет в расчёте.');
  assert.equal(WE.open_card_edit(ext.ctx, { status: null }, gone), false);
  assert.equal(byid.get('dlg').open, false, 'диалог не открыт');
  assert.equal(ext.diagnostics().filter((d) => d.status === 'failed' && /waves\.card/.test(d.label ?? '')).length, 0);
});

test('TST-56 RU и EN: подписи кнопок, aria-label и диалоги на обоих языках; возврат на русский', async () => {
  reset();
  set_lang('en');
  await go('#waves');
  const f = ext.ctx.fmt();
  const w0 = list_waves_ex(ext.ctx.get_model().ctx, 'plan').items[0].wave;
  const range = f.short(w0.start) + ' – ' + f.short(w0.end);
  const why = btn_by_id(main(), 'wc-why-plan-0');
  const edit = btn_by_id(main(), 'wc-edit-plan-0');
  assert.deepEqual([why.textContent, edit.textContent], ['Why this?', 'Edit wave']);
  assert.deepEqual([why.attrs['aria-label'], edit.attrs['aria-label']], [`Why this? Wave 1, ${range}`, `Edit wave 1, ${range}`]);
  assert.ok(/Oct/.test(range), range);
  why.listeners.click[0]();
  assert.equal(byid.get('dlg-title').textContent, 'Why wave 1');
  assert.match(text_of('dlg-body'), /It adds up: the sum of the rows/);
  edit.listeners.click[0]();
  assert.equal(byid.get('dlg-title').textContent, 'Edit wave 1');
  assert.deepEqual(find_all(dlg_body(), (n) => n.tagName === 'button').map((b) => b.textContent), ['Merge with wave 2', 'Split', 'Pin separately']);
  assert.match(text_of('dlg-body'), /composition by the rules/);
  assert.deepEqual(a11y_problems(dlg_body()), []);
  assert.deepEqual(a11y_problems(main()), []);
  set_lang('ru');
  await go('#waves');
  assert.equal(btn_by_id(main(), 'wc-why-plan-0').textContent, 'Почему так');
  assert.equal(btn_by_id(main(), 'wc-edit-plan-0').textContent, 'Править волну');
});

test('REQ-036 строки хуков приложения: слот waves.card — одна строка в app.mjs; app.mjs пакет по имени не знает, а блок пакета не импортирует app.mjs', () => {
  const app = fs.readFileSync(path.join(DEMO, 'app.mjs'), 'utf8').split('\n');
  const hooks = app.filter((l) => /waves\.card/.test(l) && !/^\s*(\/\/|\*)/.test(l));
  assert.equal(hooks.length, 1);
  // карточка отдаётся слоту копией волны с замороженными массивами (frozen_wave): чужой блок не может подменить данные соседям (замечание проверки S1.5)
  assert.match(hooks[0], /ext\.slot_nodes\('waves\.card', ext\.ctx, Object\.freeze\(\{ wave: frozen_wave\(it\.wave\), mode: S\.mode, index: it\.n - 1 \}\)\)/);
  const app_src = app.join('\n');
  assert.ok(!/wave_edit|pack_fp07|why_more/.test(app_src), 'app.mjs не знает пакет FP-07');
  const hook_lines = app.filter((l) => /\bext\b/.test(l) && !/^\s*(\/\/|\*)/.test(l)).length;
  assert.ok(hook_lines <= 25, `строк хуков в app.mjs: ${hook_lines}`);
  const we = fs.readFileSync(path.join(DEMO, 'wave_edit.mjs'), 'utf8');
  assert.ok(!/from '\.\/app\.mjs'/.test(we));
});

test('REQ-036 падение сторонних блоков слота waves.card не ломает карточку: кнопки FP-07 на месте, страница не заменяется плашкой ошибки, сбой — в диагностике', async () => {
  reset();
  // Сколько раз упавший блок вызван (boom_calls): страница может перерисоваться не один раз за переход (например, пакет хранилища FP-05 после записи
  // просит ctx.refresh() через microtask), поэтому «по одному сбою» считаем на каждый вызов блока, а не «ровно по числу карточек».
  let boom_calls = 0;
  ext.register_slot_item('waves.card', { id: 'wc_boom', order: -500, render: () => { boom_calls += 1; throw new TypeError('сбой блока'); } });
  ext.register_slot_item('waves.card', { id: 'wc_tail', order: 900, render: (_c, card) => h_text('Хвост ' + (card.index + 1)) });
  const boom_failed = () => ext.diagnostics().filter((d) => d.status === 'failed' && d.label === 'slot:waves.card/wc_boom').length;
  for (const mode of ['plan', 'worse']) {
    set_mode(mode);
    await new Promise((r) => setTimeout(r, 20)); // отложенные перерисовки других пакетов успевают выполниться до замера
    const before = boom_failed();
    const calls_before = boom_calls;
    await go('#waves');
    const cards = cards_on_page();
    assert.equal(cards.length, 2, 'обе карточки на месте');
    cards.forEach((card, i) => {
      assert.ok(btn_by_id(card, `wc-why-${mode}-${i}`) !== undefined && btn_by_id(card, `wc-edit-${mode}-${i}`) !== undefined, 'кнопки FP-07 на месте');
      assert.equal(card.children.at(-1).textContent, 'Хвост ' + (i + 1), 'блоки после упавшего показаны в порядке order');
    });
    assert.equal(find_all(main(), (n) => n.attrs.role === 'alert').length, 0, 'экран не заменён плашкой ошибки');
    const new_calls = boom_calls - calls_before;
    assert.ok(new_calls >= cards.length && new_calls % cards.length === 0, `${mode}: блок вызван для каждой карточки целое число раз (${new_calls})`);
    assert.equal(boom_failed() - before, new_calls, `${mode}: по одному сбою на каждый вызов упавшего блока (то есть на каждую карточку при каждой перерисовке)`);
    assert.equal(find_all(main(), (n) => n.className === 'card wave-edit').length, 1);
    btn_by_id(main(), `wc-why-${mode}-0`).listeners.click[0]();
    assert.equal(byid.get('dlg-title').textContent, 'Почему волна 1', 'кнопки рабочие');
  }
  set_mode('plan');
  reset();
});

function h_text(text) {
  const el = document.createElement('p');
  el.textContent = text;
  return el;
}
