// fp17_adv.test.mjs — независимая состязательная проверка FP-17 (значения по умолчанию как данные, «только чтение» для файла новее, engine_version в снимке).
// Файл добавлен проверяющим, аддитивно. Тесты «ДЕФЕКТ» фиксировали ПОДТВЕРЖДЁННЫЕ дефекты (пока дефект не исправлен, они были todo и падали, не делая набор красным).
// После исправления (tests/fp17_fix.test.mjs) флаг todo снят: теперь это обычные проверки. Д4 и Д5 исправлены другим из допустимых способов, чем предполагал текст теста:
// Д4 — параметр помечен «пока не используется» (а не получил читателя), Д5 — диалог не обещает прогноз, если читаемых данных не хватает (а не доводит открытие до конца).
// Остальные тесты закрепляют границы, которые реализация держит.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(HERE, '..', 'demo');

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
      const hit = opts.find((o) => o.attrs.selected !== undefined) ?? opts[0];
      return hit === undefined ? '' : hit.attrs.value;
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
  focus() { this.focused = true; }
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
  createElement: (t) => new Node_(t),
  createElementNS: (ns, t) => new Node_(t, ns),
  createTextNode: (data) => ({ nodeType: 3, data }),
  getElementById: (id) => byid.get(id) ?? null,
  documentElement: new Node_('html'),
  head: new Node_('head'),
  body: new Node_('body'),
  title: '',
};
globalThis.window = { addEventListener: (t, fn) => { (listeners[t] ??= []).push(fn); }, scrollTo: () => {} };
globalThis.location = { hash: '' };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'ru-RU' }, configurable: true });
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.ResizeObserver = class { observe() {} };
const real_fetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const file = fileURLToPath(url);
  return { ok: true, json: async () => JSON.parse(fs.readFileSync(file, 'utf8')) };
};

const { ext } = await import(pathToFileURL(path.join(DEMO, 'ext.mjs')).href);
await import(pathToFileURL(path.join(DEMO, 'app.mjs')).href);
const { export_journal_copy, events_of_ws } = await import(pathToFileURL(path.join(DEMO, 'data_actions.mjs')).href);
const { canon } = await import(pathToFileURL(path.join(HERE, '..', 'engine', 'index.mjs')).href);
await new Promise((r) => setTimeout(r, 500));

const text_of = (id) => byid.get(id).textContent;
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };
const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const G = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'data', 'g001.json'), 'utf8'));

function newer_copy_text() {
  const obj = JSON.parse(export_journal_copy(events_of_ws(G)).text);
  obj.format = 'runway-journal/2';
  obj.engine_version = '0.2.0';
  const last = obj.events.at(-1).seq;
  obj.events.push(
    { actor: 'user', entity_id: 'tx-next', event_id: 'ev-x2', payload: { account_id: 'acc_main', amount: { currency: 'EUR', minor: -1999 }, date: '2026-10-03' }, recorded_at: '2026-10-05T08:00:00Z', seq: last + 1, type: 'tx.posted', v: 2 },
  );
  return canon(obj);
}

async function open_newer_readonly() {
  await go('#data');
  const input = find_all(byid.get('main'), (n) => n.attrs.id === 'fp05-file')[0];
  const text = newer_copy_text();
  input.files = [{ size: text.length, text: async () => text }];
  input.listeners.change[0]();
  await wait();
  const btn = find_all(byid.get('dlg-body'), (n) => n.tagName === 'button' && n.textContent === 'Открыть только для просмотра')[0];
  btn.listeners.click[0]();
  await wait(150);
}

// ── Д1: режим «только чтение» и форма быстрого ввода ─────────────────────────────────────────────────────────────────────

test('FP-17 ДЕФЕКТ Д1: в режиме «только чтение» форма «+ Факт» принимает ввод и отвечает «Запись не принята: проверьте счёт, дату и сумму» — причина (только чтение) не названа', async () => {
  await open_newer_readonly();
  await go('#overview');
  const add = find_all(byid.get('nav'), (n) => n.tagName === 'button' && /Факт/.test(n.textContent))[0];
  add.listeners.click[0]();
  await wait(50);
  const body = byid.get('dlg-body');
  find_all(body, (n) => n.attrs.id === 'entry-amount')[0].value = '-10';
  const ws_before = ext.ctx.get_ws();
  find_all(body, (n) => n.tagName === 'form')[0].listeners.submit[0]({ preventDefault() {} });
  await wait(50);
  assert.equal(ext.ctx.get_ws(), ws_before, 'данные не тронуты (это держится)');
  const shown = find_all(body, (n) => n.attrs.role === 'alert').map((n) => n.textContent).join(' ') + ' ' + text_of('live');
  assert.match(shown, /только для просмотра/i, 'пользователь должен узнать причину отказа; сейчас: ' + shown);
  assert.doesNotMatch(shown, /проверьте счёт, дату и сумму/, 'ввод валиден — винить его нельзя');
});

// ── среда хранения: режим «только чтение» не должен вести к стиранию сохранённого ─────────────────────────────────────────

const imp = (...p) => import(pathToFileURL(path.join(HERE, '..', ...p)).href);
const { create_runtime } = await imp('demo', 'data_runtime.mjs');
const { create_memory_store, create_memory_backing, create_lock } = await imp('demo', 'store.mjs');
const { inspect_import } = await imp('demo', 'data_actions.mjs');
const { apply_edit } = await imp('demo', 'ws_edit.mjs');
const clone = (x) => JSON.parse(JSON.stringify(x));
const AT = '2026-10-05T08:00:00Z';

function make_page(ws0) {
  let n = 0;
  const page = { ws: ws0, today: '2026-10-05', get_ws: () => page.ws, set_ws: (ws) => { page.ws = ws; return { ok: true }; }, refresh() {} };
  page.ports = { next_id: () => 'adv~' + (++n), recorded_at: () => AT };
  return page;
}
function runtime_on(page, store) {
  let rt = null;
  rt = create_runtime({
    store, store_kind: 'memory', lock: create_lock({ locks: null }), channel: null, storage_manager: { persisted: async () => true }, installed: () => true,
    today: () => page.today, ports: page.ports, get_ws: page.get_ws, set_ws: page.set_ws, refresh: page.refresh,
    adopt: (ws, o) => { page.ws = ws; rt.on_change({ reason: 'adopt', ws, source: o?.source }); return { ok: true }; },
  });
  return rt;
}
const fact = (i) => ({ type: 'add_fact', fact: { event_id: 'u_' + i, account_id: 'acc_main', date: '2026-10-03', amount_minor: -(100 + i), currency: 'EUR', tag: 'x' } });

test('FP-17 ДЕФЕКТ Д2: в режиме «только чтение» при сохранённых данных «Начать с текущего набора» стирает сохранённый журнал, хотя «текущий набор» — просмотр, который записать нельзя', async () => {
  const backing = create_memory_backing();
  const page = make_page(clone(G));
  const rt = runtime_on(page, create_memory_store({ backing }));
  await rt.init();
  const ws1 = apply_edit(page.ws, fact(1), { new_id: (p) => p + '_1' }).ws;
  page.ws = ws1;
  await rt.on_change({ reason: 'add_fact', ws: ws1 });
  assert.equal((await create_memory_store({ backing }).stat()).count > 0, true, 'сохранённый журнал есть');
  // «как после перезагрузки»: хранилище найдено, рабочая область — набор по умолчанию
  const page2 = make_page(clone(G));
  const rt2 = runtime_on(page2, create_memory_store({ backing }));
  assert.equal((await rt2.init()).mode, 'found');
  const parsed = inspect_import(newer_copy_text());
  assert.equal(parsed.read_only, true);
  assert.equal((await rt2.open_readonly(parsed)).ok, true);
  await rt2.flush();
  assert.equal(rt2.status().mode, 'found', 'карточка «Продолжить с сохранённого / Начать с текущего набора» остаётся на экране');
  const before = (await create_memory_store({ backing }).stat()).count;
  const r = await rt2.replace_saved();
  const after = (await create_memory_store({ backing }).stat()).count;
  assert.ok(before > 0);
  assert.equal(r.ok === true && after === 0, false, 'сохранённый журнал (' + before + ' записей) не должен стираться ради просмотра: записать просмотр нельзя');
});

test('FP-17 ДЕФЕКТ Д3: «Скачать журнал» из просмотра отдаёт частичную копию формата /1 (без пропущенных записей) без какой-либо оговорки и без отметки о пропуске', async () => {
  const backing = create_memory_backing();
  const page = make_page(clone(G));
  const rt = runtime_on(page, create_memory_store({ backing }));
  await rt.init();
  const parsed = inspect_import(newer_copy_text());
  await rt.open_readonly(parsed);
  await rt.flush();
  let copy = null;
  try { copy = await rt.export_copy(); } catch { /* отказ — желаемое поведение */ }
  // желаемое: либо отказ, либо в копии виден след пропуска; сейчас — обычная копия /1 с хэшем частичного состояния
  const obj = copy === null ? null : JSON.parse(copy.text);
  assert.ok(copy === null || obj.format !== 'runway-journal/1' || obj.skipped !== undefined, 'копия частичных данных выдана как полноценная runway-journal/1');
});

test('FP-17 ДЕФЕКТ Д5 (исправлен): файл, где новее известной основная запись (счёт), — диалог не обещает прогноз, называет причину словами, кнопки «Открыть» нет и кода E_SCHEMA нет', async () => {
  await go('#data');
  const obj = JSON.parse(newer_copy_text());
  for (const e of obj.events) if (e.type === 'account.opened') e.v = 2;
  const text = canon(obj);
  const input = find_all(byid.get('main'), (n) => n.attrs.id === 'fp05-file')[0];
  input.files = [{ size: text.length, text: async () => text }];
  input.listeners.change[0]();
  await wait();
  const dlg = byid.get('dlg-body').textContent;
  assert.doesNotMatch(dlg, /прогноз будет виден/, 'прогноз не построить: обещать его нельзя');
  assert.match(dlg, /прогноз не построить/, 'причина названа словами: ' + dlg);
  assert.doesNotMatch(dlg, /E_SCHEMA/, 'голого кода в диалоге нет');
  assert.equal(find_all(byid.get('dlg-body'), (n) => n.tagName === 'button' && n.textContent === 'Открыть только для просмотра').length, 0, 'кнопки «Открыть» нет: открывать нечего');
  assert.doesNotMatch(text_of('live'), /E_SCHEMA/, 'и в живой области кода нет: ' + text_of('live'));
});

// ── честность таблицы «Все параметры и значения по умолчанию» ─────────────────────────────────────────────────────────────

test('FP-17 ДЕФЕКТ Д4 (исправлен): параметр, которого не читает ни расчёт, ни интерфейс (mc.n_paths: на экране 2000, в полосе 600 путей), помечен «пока не используется», а не выдан за действующий', async () => {
  const { default_rows } = await imp('demo', 'settings_defaults.mjs');
  const model = { ws: clone(G) };
  const row = default_rows(model).find((r) => r.key === 'mc.n_paths');
  assert.ok(row !== undefined && row.value === 2000, 'на экране «действует 2000»');
  const skip = /^(vocab\.generated|param_defaults|validate_ws|settings_defaults|ws_edit|quality_report)\.mjs$/;
  const readers = [];
  for (const dir of ['engine', 'demo']) {
    for (const f of fs.readdirSync(path.join(HERE, '..', dir), { recursive: true })) {
      if (!f.endsWith('.mjs') || skip.test(path.basename(f)) || f.includes('i18n')) continue;
      if (fs.readFileSync(path.join(HERE, '..', dir, f), 'utf8').includes("'mc.n_paths'")) readers.push(dir + '/' + f);
    }
  }
  assert.ok(readers.length > 0 || row.used === false, 'ни один модуль не читает ws.params["mc.n_paths"], а строка не помечена «пока не используется»');
});

// ── границы, которые реализация держит ─────────────────────────────────────────────────────────────────────────────────────

test('FP-17: возврат по умолчанию доходит до журнала — повтор журнала даёт те же params (9 параметров разных видов)', async () => {
  const { create_ext } = await imp('demo', 'ext.mjs');
  const { seeded_ports } = await imp('demo', 'ids.mjs');
  const { events_to_ws } = await imp('demo', 'ws_bridge.mjs');
  const e = create_ext({ ports: seeded_ports({ seed: 17 }) });
  const st = { ws: clone(G) };
  e.bind_host({ get_ws: () => st.ws, get_model: () => null, lang: () => 'ru', mode: () => 'worse', fmt: () => null, set_ws: (n) => { st.ws = n; return { ok: true }; }, render() {}, notify() {} });
  for (const key of ['horizon_days', 'buffer_minor', 'wave.threshold_minor', 'wave.gap_days', 'headline_mode', 'rounding', 'fx.stale_days', 'explain.top_k', 'worse.income_delay_days']) {
    const value = key === 'headline_mode' ? 'plan' : key === 'rounding' ? 'floor' : key.endsWith('minor') ? 777 : 11;
    assert.equal(e.ctx.edit({ type: 'set_param', key, value }).ok, true, key);
    assert.equal(e.ctx.edit({ type: 'set_param', key, reset: true }).ok, true, key + ' reset');
    const replay = events_to_ws(e.ctx.journal.events());
    assert.equal(canon(replay.params), canon(st.ws.params), key + ': журнал и рабочая область расходятся');
  }
});

test('FP-17: файл нового формата, где читаемая запись зависит от пропущенной (revert на пропущенную запись, любой тип пропущен по одному), открывается; 1500 случайных порч не дают исключений', () => {
  const base = JSON.parse(export_journal_copy(events_of_ws(G)).text);
  const mk = (mut) => { const o = clone(base); o.format = 'runway-journal/2'; mut(o); return canon(o); };
  const last = base.events.at(-1).seq;
  const r = inspect_import(mk((o) => {
    o.events.push({ actor: 'user', event_id: 'ev-n1', payload: { foo: 1 }, recorded_at: AT, seq: last + 1, type: 'zzz.new', v: 1 });
    o.events.push({ actor: 'user', event_id: 'ev-n2', payload: { target: 'ev-n1' }, recorded_at: AT, seq: last + 2, type: 'revert', v: 1 });
  }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.read_only_info.skipped, 1);
  for (const t of new Set(base.events.map((e) => e.type))) {
    const ev = base.events.find((e) => e.type === t);
    const rr = inspect_import(mk((o) => { o.events.find((x) => x.event_id === ev.event_id).v = 99; }));
    assert.equal(rr.ok, true, t + ' пропущен: ' + JSON.stringify(rr));
  }
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const vals = [null, undefined, 0, -1, 1.5, '2', 'x', [], {}, true, 1e21, '__proto__', 99, 2, 3];
  for (let i = 0; i < 1500; i++) {
    const o = clone(base);
    o.format = pick(['runway-journal/1', 'runway-journal/2', 'runway-journal/7', 'runway-journal/0', 'x']);
    for (let k = 0; k < 1 + Math.floor(rnd() * 4); k++) {
      const ev = pick(o.events);
      const field = pick(['v', 'type', 'seq', 'event_id', 'payload', 'actor', 'entity_id', 'recorded_at']);
      const val = pick(vals);
      if (val === undefined) delete ev[field]; else ev[field] = val;
    }
    if (rnd() < 0.1) o.events = pick(vals);
    assert.doesNotThrow(() => inspect_import(JSON.stringify(o)), 'порча #' + i);
  }
});

test('FP-17: канонические файлы не тронуты — vocab.json, g001.json, arith.lock и golden совпадают с контрольными суммами, снятыми проверяющим со снимка wave3a-fp17-before', () => {
  const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(path.join(HERE, '..', p))).digest('hex');
  assert.equal(sha('engine/vocab.json').slice(0, 16), '374b6c5823c574f3');
  assert.equal(sha('data/g001.json').slice(0, 16), '0b9a9e3cae8a9f78');
  assert.equal(sha('tests/arith.lock.json').slice(0, 16), '0938d3628c9dedd9');
  assert.equal(sha('tests/g001.golden.test.mjs').slice(0, 16), '2e85e35378354aca');
});

test('завершение: заглушки сняты', () => {
  globalThis.fetch = real_fetch;
  assert.ok(true);
});
