// s1_5_adv.test.mjs — состязательная проверка этапа S1.5 (слот waves.card: «Почему так» и «Править волну» на карточке волны).
// Проверяющий не подгоняет проверки под реализацию: четыре набора G-001 × два режима × два языка в настоящем app.mjs на заглушке DOM, пустой список волн,
// две волны с одинаковыми датами, случайные последовательности правок с карточки против пересчёта движка, отмена, статика (строки, безопасность).
// Браузер и сеть не используются. Время не меряется.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(HERE, '..', 'demo');
const DATA = path.join(HERE, '..', 'data');

// ── заглушка DOM (как в waves_card.test.mjs) ───────────────────────────────────────────────────────────────────────────

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
  hasAttribute(k) { return Object.hasOwn(this.attrs, k); }
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

const { ext, create_ext, SLOTS } = await import(pathToFileURL(path.join(DEMO, 'ext.mjs')).href);

// счётчик вызовов слота приложением (блок узлов не отдаёт)
const seen = [];
ext.register_slot_item('waves.card', { id: 'adv_probe', order: -1000, render: (...args) => { seen.push(args); return null; } });

await import(pathToFileURL(path.join(DEMO, 'app.mjs')).href);
await new Promise((r) => setTimeout(r, 500));
const WE = await import(pathToFileURL(path.join(DEMO, 'wave_edit.mjs')).href);
const W = await import(pathToFileURL(path.join(DEMO, 'why_more.mjs')).href);
const SCEN = (await import(pathToFileURL(path.join(DEMO, 'i18n', 'scenarios.mjs')).href)).default;
const { LABELS } = await import('../engine/verifier.mjs');
const { make_tool_ctx } = await import('../engine/tools.mjs');
const { list_waves_ex, canon } = await import('../engine/index.mjs');

const read = (name) => JSON.parse(fs.readFileSync(path.join(DATA, name + '.json'), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const model_of = (ws) => ({ ws, ctx: make_tool_ctx(ws, { as_of: ws.as_of }, {}) });
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const settle = () => new Promise((r) => setTimeout(r, 15));
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; await settle(); };
const text_of = (id) => byid.get(id).textContent;
const main = () => byid.get('main');
const dlg_body = () => byid.get('dlg-body');
const cards_on_page = () => find_all(main(), (n) => n.className === 'card wave-card');
const btn_by_id = (root, id) => find_all(root, (n) => n.tagName === 'button' && n.attrs.id === id)[0];
const click = (n) => n.listeners.click[0]();
const nav_button = (label) => find_all(byid.get('nav'), (n) => n.tagName === 'button' && n.textContent === label)[0];
const set_mode = (m) => {
  const label = LABELS.modes.ru[m];
  const b = find_all(byid.get('controls'), (n) => n.tagName === 'button' && n.attrs['aria-pressed'] !== undefined && (n.textContent === label || n.textContent === LABELS.modes.en?.[m]))[0];
  assert.ok(b !== undefined, 'нет переключателя режима ' + m);
  click(b);
};
const set_lang = (l) => {
  const b = find_all(byid.get('controls'), (n) => n.tagName === 'button' && n.attrs.lang === l)[0];
  assert.ok(b !== undefined, 'нет переключателя языка ' + l);
  click(b);
};
const dup_ids = (root) => {
  const s = new Set(); const d = [];
  root.walk((n) => { const id = n.attrs.id; if (id !== undefined) { if (s.has(id)) d.push(id); s.add(id); } });
  return d;
};
const DATASETS = ['g001', 'g001-low', 'g001-gap', 'g001-late'];
const fresh = (name) => { const r = ext.ctx.adopt(clone(read(name)), { source: 'test' }); assert.equal(r.ok, true, name); set_lang('ru'); set_mode('plan'); };
const money_of = (f, minor) => f.money(minor);
const range_of = (f, w) => (w.start === w.end ? f.short(w.start) : f.short(w.start) + ' – ' + f.short(w.end));

// ── 1. четыре набора × два режима × два языка: всё на каждой карточке ───────────────────────────────────────────────────

for (const name of DATASETS) {
  test(`S1.5 adv: набор ${name} — на КАЖДОЙ карточке в обоих режимах и обоих языках две кнопки, диалоги открываются и сходятся с карточкой`, async () => {
    fresh(name);
    for (const lang of ['ru', 'en']) {
      set_lang(lang);
      for (const mode of ['plan', 'worse']) {
        set_mode(mode);
        seen.length = 0;
        await go('#waves');
        const a = ext.ctx.get_model().ctx;
        const items = list_waves_ex(a, 'plan').items;
        const f = ext.ctx.fmt();
        const cards = cards_on_page();
        if (items.length === 0) { assert.equal(cards.length, 0); assert.equal(seen.length, 0, 'слот не вызывается без карточек'); continue; }
        assert.equal(cards.length, items.length, `${name} ${lang} ${mode}`);
        assert.ok(seen.length >= items.length && seen.length % items.length === 0, 'вызов слота на каждую карточку (возможны повторные перерисовки)');
        assert.deepEqual(dup_ids(main()), [], `${name} ${lang} ${mode}: id страницы`);
        for (const [i, card] of cards.entries()) {
          const last = card.children.at(-1);
          assert.equal(last.className, 'actions wc-actions');
          const btns = find_all(last, (n) => n.tagName === 'button');
          assert.deepEqual(btns.map((b) => b.attrs.id), [`wc-why-${mode}-${i}`, `wc-edit-${mode}-${i}`]);
          const range = range_of(f, items[i].wave);
          for (const b of btns) {
            assert.ok(b.attrs['aria-label'].includes(range) && b.attrs['aria-label'].includes(String(i + 1)), b.attrs['aria-label']);
            assert.ok(b.attrs['aria-label'].startsWith(b.textContent), 'WCAG 2.5.3');
          }
          // заголовок карточки и заголовок диалога правки: тот же номер, диапазон и итог
          const h3 = find_all(card, (n) => n.tagName === 'h3')[0].textContent;
          click(btns[1]);
          const dlg_head = find_all(dlg_body(), (n) => n.tagName === 'strong')[0].textContent;
          assert.ok(h3.includes(range) && dlg_head.includes(range), `${name} ${mode} ${i}: диапазон «${range}» в «${h3}» и «${dlg_head}»`);
          assert.ok(h3.includes(money_of(f, items[i].wave.total_out_minor)) && dlg_head.includes(money_of(f, items[i].wave.total_out_minor)), 'итог волны');
          assert.equal(byid.get('dlg').open, true);
          assert.deepEqual(dup_ids(dlg_body()), []);
          const page_ids = new Set(find_all(main(), (n) => n.attrs.id !== undefined).map((n) => n.attrs.id));
          for (const n of find_all(dlg_body(), (x) => x.attrs.id !== undefined)) assert.ok(!page_ids.has(n.attrs.id), 'id диалога повторяет id страницы ' + n.attrs.id);
          // «Почему так»
          click(btns[0]);
          const model = ext.ctx.get_model();
          const it = list_waves_ex(model.ctx, mode).items.find((x) => x.wave.wave_id === items[i].wave.wave_id) ?? list_waves_ex(model.ctx, mode).items[i];
          const wy = W.wave_why(model, mode, { ...it, n: i + 1 });
          assert.equal(wy.ok, true);
          assert.equal(wy.total_minor, it.metrics.r_minor);
          assert.equal(byid.get('dlg-title').textContent, (lang === 'ru' ? 'Почему волна ' : 'Why wave ') + (i + 1));
          assert.ok(text_of('dlg-body').includes(money_of(f, wy.r_minor)), 'в диалоге — потребность волны режима страницы');
        }
        byid.get('dlg').close();
      }
    }
    set_lang('ru'); set_mode('plan');
  });
}

// ── 2. пустой список волн ───────────────────────────────────────────────────────────────────────────────────────────────

test('S1.5 adv: порог θ выше любых сумм — волн нет: экран «пусто», слот не вызывается, кнопок нет, устаревшая карточка не падает', async () => {
  fresh('g001');
  await go('#waves');
  const stale_card = { wave: list_waves_ex(ext.ctx.get_model().ctx, 'plan').items[0].wave, mode: 'plan', index: 0 };
  const r = ext.ctx.edit({ type: 'set_param', key: 'wave.threshold_minor', value: 90000000000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  for (const mode of ['plan', 'worse']) {
    set_mode(mode);
    seen.length = 0;
    await go('#waves');
    assert.equal(cards_on_page().length, 0);
    assert.equal(find_all(main(), (n) => /^wc-/.test(n.attrs.id ?? '')).length, 0);
    assert.equal(seen.length, 0);
    assert.equal(find_all(main(), (n) => n.attrs.role === 'alert' && n.className.includes('short')).length, 0, 'не плашка ошибки');
  }
  const failed0 = ext.diagnostics().filter((d) => d.status === 'failed').length;
  assert.equal(WE.open_card_why(ext.ctx, stale_card), false);
  assert.equal(WE.open_card_edit(ext.ctx, { status: null }, stale_card), false);
  assert.equal(ext.diagnostics().filter((d) => d.status === 'failed').length, failed0);
  fresh('g001');
});

// ── 3. две волны с одинаковыми датами ───────────────────────────────────────────────────────────────────────────────────

test('S1.5 adv: две волны с одинаковым диапазоном дат — идентификаторы и подписи различаются; правка и «почему» относятся к своей карточке', async () => {
  fresh('g001');
  await go('#waves');
  // закрепляем по отдельности аренду и ЖКХ (оба на 26 окт)
  for (const id of ['R-RENT@2026-10-25', 'R-UTIL@2026-10-25']) {
    const r = ext.ctx.edit(WE.plan_pin([id]), { reason: 'set_wave_override' });
    assert.equal(r.ok, true, id);
  }
  await go('#waves');
  const a = ext.ctx.get_model().ctx;
  const items = list_waves_ex(a, 'plan').items;
  const f = ext.ctx.fmt();
  const same = items.filter((x, i) => items.some((y, j) => j !== i && y.wave.start === x.wave.start && y.wave.end === x.wave.end));
  console.log('волн всего', items.length, 'с совпадающими датами', same.length, items.map((x) => range_of(f, x.wave)).join(' | '));
  assert.ok(same.length >= 2, 'не удалось получить две волны с одинаковыми датами этим способом');
  assert.deepEqual(dup_ids(main()), []);
  const all_labels = find_all(main(), (n) => n.tagName === 'button' && /^wc-/.test(n.attrs.id ?? '')).map((b) => b.attrs['aria-label']);
  assert.equal(new Set(all_labels).size, all_labels.length, 'доступные имена различаются: ' + all_labels.join(' / '));
  const idx = items.map((x, i) => [x, i]).filter(([x]) => same.includes(x)).map(([, i]) => i);
  for (const i of idx) {
    click(btn_by_id(main(), `wc-why-plan-${i}`));
    assert.equal(byid.get('dlg-title').textContent, `Почему волна ${i + 1}`);
    const wy = W.wave_why(ext.ctx.get_model(), 'plan', { ...items[i], n: i + 1 });
    assert.equal(wy.ok, true);
    click(btn_by_id(main(), `wc-edit-plan-${i}`));
    assert.equal(byid.get('dlg-title').textContent, `Править волну ${i + 1}`);
    assert.ok(find_all(dlg_body(), (n) => n.attrs.id === `wcd-pin-plan-${i}`).length === 1);
  }
  fresh('g001');
});

// ── 4. случайные последовательности правок с карточки против пересчёта ─────────────────────────────────────────────────────

function prng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

for (const name of DATASETS) {
  test(`S1.5 adv: ${name} — случайные правки с карточек (merge/split/pin, снять, отменить): страница, id, «почему», хэш входов и журнал согласованы`, async () => {
    fresh(name);
    const rnd = prng(0xC0FFEE ^ name.length);
    const ws0 = clone(ext.ctx.get_ws());
    let applied = 0;
    for (let step = 0; step < 40; step++) {
      const mode = rnd() < 0.5 ? 'plan' : 'worse';
      set_mode(mode);
      await go('#waves');
      const cards = cards_on_page();
      if (cards.length === 0) break;
      assert.deepEqual(dup_ids(main()), []);
      assert.equal(cards.length, list_waves_ex(ext.ctx.get_model().ctx, 'plan').items.length, `шаг ${step}: число карточек = число волн`);
      cards.forEach((card, i) => assert.deepEqual(find_all(card.children.at(-1), (n) => n.tagName === 'button').map((b) => b.attrs.id), [`wc-why-${mode}-${i}`, `wc-edit-${mode}-${i}`]));
      const i = Math.floor(rnd() * cards.length);
      const n0 = ext.ctx.journal.length;
      const ov0 = (ext.ctx.get_ws().wave_overrides ?? []).length;
      const pick = rnd();
      click(btn_by_id(main(), `wc-edit-${mode}-${i}`));
      const btns = find_all(dlg_body(), (n) => n.tagName === 'button');
      const label_of = (b) => b.textContent;
      let target;
      if (pick < 0.34) target = btns.filter((b) => /^Объединить/.test(label_of(b)))[Math.floor(rnd() * 2)] ?? btns.find((b) => /^Объединить/.test(label_of(b)));
      else if (pick < 0.67) {
        target = btns.find((b) => label_of(b) === 'Разделить');
        const sel = find_all(dlg_body(), (n) => n.attrs.id === `wcd-split-${mode}-${i}`)[0];
        if (target !== undefined) { const opts = sel.children; sel.value = opts[Math.floor(rnd() * opts.length)].attrs.value; }
      } else {
        target = btns.find((b) => label_of(b) === 'Закрепить отдельно');
        const sel = find_all(dlg_body(), (n) => n.attrs.id === `wcd-pin-${mode}-${i}`)[0];
        sel.value = sel.children[Math.floor(rnd() * sel.children.length)].attrs.value;
      }
      if (target === undefined) { byid.get('dlg').close(); continue; }
      click(target);
      await settle();
      const ws = ext.ctx.get_ws();
      const ov1 = (ws.wave_overrides ?? []).length;
      if (ov1 > ov0 || (ov1 === ov0 && ext.ctx.journal.length > n0)) applied++;
      // согласованность
      assert.equal(ext.ctx.get_model().ctx.inputs_hash, model_of(ws).ctx.inputs_hash, `шаг ${step}: хэш входов страницы = хэш пересчёта`);
      assert.ok(ext.ctx.journal.length >= n0, 'журнал только дописывается');
      await go('#waves');
      const items = list_waves_ex(ext.ctx.get_model().ctx, 'plan').items;
      assert.equal(cards_on_page().length, items.length);
      for (const [k, it] of items.entries()) {
        const model = ext.ctx.get_model();
        const wy = W.wave_why(model, 'plan', { ...it, n: k + 1 });
        assert.equal(wy.ok, true, `шаг ${step} волна ${k + 1}: разложение сходится`);
      }
      if (rnd() < 0.15) { const rm = find_all(main(), (n) => n.tagName === 'button' && n.textContent === 'Снять')[0]; if (rm !== undefined) { click(rm); await settle(); } }
      if (rnd() < 0.15 && !nav_button('Отменить').hasAttribute('disabled')) { click(nav_button('Отменить')); await settle(); }
    }
    assert.ok(applied >= 1, 'хотя бы одна правка записана');
    // отменить всё: рабочая область как была
    let guard = 0;
    while (!nav_button('Отменить').hasAttribute('disabled') && guard++ < 200) { click(nav_button('Отменить')); await settle(); }
    assert.equal(canon(ext.ctx.get_ws()), canon(ws0), 'после отмены всех действий набор как был');
    assert.equal(ext.ctx.get_model().ctx.inputs_hash, model_of(ws0).ctx.inputs_hash);
    fresh('g001');
  });
}

// ── 5. «Отменить» после правки с карточки ───────────────────────────────────────────────────────────────────────────────────

test('S1.5 adv: правка с карточки отменяется кнопкой «Отменить» с подписью «правка волн платежей»; «Вернуть» повторяет', async () => {
  fresh('g001');
  await go('#waves');
  const ws0 = clone(ext.ctx.get_ws());
  click(btn_by_id(main(), 'wc-edit-plan-0'));
  click(find_all(dlg_body(), (n) => n.tagName === 'button' && /^Объединить/.test(n.textContent))[0]);
  assert.equal(nav_button('Отменить').hasAttribute('disabled'), false);
  assert.match(nav_button('Отменить').attrs['aria-label'], /правка волн платежей/);
  const ws1 = clone(ext.ctx.get_ws());
  click(nav_button('Отменить'));
  assert.equal(canon(ext.ctx.get_ws()), canon(ws0));
  assert.equal(cards_on_page().length, 2);
  click(nav_button('Вернуть'));
  assert.equal(canon(ext.ctx.get_ws()), canon(ws1));
  assert.equal(cards_on_page().length, 1);
  fresh('g001');
});

// ── 6. устаревший диалог ────────────────────────────────────────────────────────────────────────────────────────────────

test('S1.5 adv: кнопка устаревшего диалога «Править волну» (набор изменился, пока диалог был открыт) не ломает страницу и не пишет мусор', async () => {
  fresh('g001');
  await go('#waves');
  click(btn_by_id(main(), 'wc-edit-plan-0'));
  const merge = find_all(dlg_body(), (n) => n.tagName === 'button' && /^Объединить/.test(n.textContent))[0];
  const split_sel = find_all(dlg_body(), (n) => n.attrs.id === 'wcd-split-plan-0')[0];
  const split = find_all(dlg_body(), (n) => n.tagName === 'button' && n.textContent === 'Разделить')[0];
  // набор меняется «из-под» открытого диалога: удалён платёж, на который ссылалась правка
  const r = ext.ctx.edit(WE.plan_merge(WE.wave_items(ext.ctx.get_model().ctx, 'plan'), 0), { reason: 'set_wave_override' });
  assert.equal(r.ok, true);
  const n0 = ext.ctx.journal.length;
  click(merge); // та же правка уже записана
  assert.match(find_all(dlg_body(), (n) => n.attrs.role === 'status')[0].textContent, /уже записана/);
  assert.equal(ext.ctx.journal.length, n0);
  split_sel.value = split_sel.children[0].attrs.value;
  click(split); // разделение по платежу, который ещё существует — допустимая правка, страница цела
  await settle();
  assert.equal(find_all(main(), (n) => n.attrs.role === 'alert' && n.className.includes('short')).length, 0);
  assert.deepEqual(dup_ids(main()), []);
  assert.equal(ext.ctx.get_model().ctx.inputs_hash, model_of(ext.ctx.get_ws()).ctx.inputs_hash);
  fresh('g001');
});

// ── 7. один аргумент у остальных слотов; общий ctx ─────────────────────────────────────────────────────────────────────────

test('S1.5 adv: слоты с одним аргументом — в настоящем приложении ни один блок других слотов не получает лишнего аргумента', async () => {
  const e = create_ext();
  const got = {};
  for (const slot of SLOTS) e.register_slot_item(slot, { id: 'adv_' + slot.replace('.', '_'), render: (...args) => { got[slot] = args.length; return null; } });
  for (const slot of SLOTS) e.slot_nodes(slot);
  for (const slot of SLOTS) assert.equal(got[slot], 1, slot);
  e.slot_nodes('waves.card', e.ctx, { index: 0 });
  assert.equal(got['waves.card'], 2);
  e.slot_nodes('waves.card', e.ctx, { index: 0 }, 'ещё', 3);
  assert.equal(got['waves.card'], 4, 'произвольное число дополнительных аргументов передаётся как есть');
  e.slot_nodes('overview.cards', e.ctx, { index: 0 });
  assert.equal(got['overview.cards'], 2, 'слот не различает: extra передаётся любому слоту, если вызывающий его дал');
});

// ── 8. статика ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('S1.5 adv: статика — каждый ключ scenarios.wc_* используется литералом, паритет RU/EN, нет запрещённых слов, безопасность DOM', () => {
  const code = ['wave_edit.mjs', 'pack_fp07.mjs', 'why_more.mjs'].map((f) => fs.readFileSync(path.join(DEMO, f), 'utf8')).join('\n');
  const keys = Object.keys(SCEN.ru).filter((k) => k.startsWith('scenarios.wc_'));
  assert.equal(keys.length, 7);
  for (const k of keys) assert.ok(code.includes("'" + k + "'"), 'ключ не используется литералом: ' + k);
  assert.deepEqual(Object.keys(SCEN.en).filter((k) => k.startsWith('scenarios.wc_')).sort(), keys.sort());
  const vocab = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'engine', 'vocab.json'), 'utf8'));
  const forb = (vocab.forbidden_phrases ?? []).map((x) => (typeof x === 'string' ? x : x.phrase ?? x.text ?? '')).filter(Boolean);
  for (const k of keys) for (const lang of ['ru', 'en']) for (const p of forb) assert.ok(!SCEN[lang][k].toLowerCase().includes(p.toLowerCase()), `${lang} ${k}: «${p}»`);
  const all = ['wave_edit.mjs', 'pack_fp07.mjs'].map((f) => fs.readFileSync(path.join(DEMO, f), 'utf8')).join('\n');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|\beval\(|new Function|fetch\(|XMLHttpRequest|setAttribute\(\s*'style'|\bstyle:/.test(all));
  const css = fs.readFileSync(path.join(DEMO, 'css', 'scenarios.css'), 'utf8');
  assert.match(css, /\.wave-card \.wc-actions/);
  // пользовательские тексты не попадают в контекст ошибок: блок не кладёт ничего в запись диагностики сам
  assert.ok(!/record\(/.test(all));
});

// ── 9. глубокая неизменяемость карточки ───────────────────────────────────────────────────────────────────────────────────

test('S1.5 adv: карточка заморожена поверхностно — документируем: чужой блок не может подменить поля карточки, но объект волны внутри не заморожен', async () => {
  fresh('g001');
  let wave_frozen = null;
  let top_frozen = null;
  ext.register_slot_item('waves.card', { id: 'adv_freeze', order: -900, render: (_c, card) => { top_frozen = Object.isFrozen(card); wave_frozen = Object.isFrozen(card.wave); return null; } });
  await go('#waves');
  console.log('карточка заморожена:', top_frozen, '· объект волны заморожен:', wave_frozen);
  assert.equal(top_frozen, true);
});

// ── 10. наблюдения (не падают: фиксируют поведение для отчёта) ─────────────────────────────────────────────────────────────

test('S1.5 adv: наблюдение — после правки с карточки итог остаётся в общем уведомлении приложения (S.notice) и всплывает на «Сценариях» / «Данных»', async () => {
  fresh('g001');
  await go('#waves');
  click(btn_by_id(main(), 'wc-edit-plan-0'));
  click(find_all(dlg_body(), (n) => n.tagName === 'button' && /^Объединить/.test(n.textContent))[0]);
  const live = text_of('live');
  await go('#scenarios');
  const on_scen = /Волны объединены\./.test(text_of('main'));
  await go('#data');
  const on_data = /Волны объединены\./.test(text_of('main'));
  await go('#overview');
  await go('#data');
  const on_data_again = /Волны объединены\./.test(text_of('main'));
  console.log('live:', live, '· на «Сценарии»:', on_scen, '· на «Данные»:', on_data, '· на «Данные» повторно:', on_data_again);
  await go('#waves');
  fresh('g001');
});

test('S1.5 adv: наблюдение — чужой блок слота может изменить объект волны карточки (заморожена только оболочка) и испортить календарь и подписи соседей', async () => {
  fresh('g001');
  const unreg = [];
  ext.register_slot_item('waves.card', { id: 'adv_mutate', order: -800, render: (_c, card) => { try { card.wave.end = card.wave.start; card.wave.event_ids.length = 1; } catch { unreg.push('threw'); } return null; } });
  await go('#waves');
  const label = btn_by_id(main(), 'wc-why-plan-0')?.attrs['aria-label'];
  const real = list_waves_ex(ext.ctx.get_model().ctx, 'plan').items[0].wave;
  console.log('aria-label после мутации чужим блоком:', label, '· волна движка при следующем расчёте:', real.start, real.end, real.event_ids.length, unreg.join());
  assert.ok(true);
});
