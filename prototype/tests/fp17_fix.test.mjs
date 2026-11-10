// fp17_fix.test.mjs — исправление дефектов независимой проверки FP-17 (значения по умолчанию как данные, «только чтение», версия движка).
// Д1 (medium): в режиме «только чтение» формы называют причину отказа (ro.refused), а не винят ввод.
// Д2 (medium): при сохранённых данных просмотр не стирает журнал («Начать с текущего набора» недоступно).
// Д3 (medium): на экране «Данные» есть плашка «открыт только для просмотра»; копия журнала и выгрузка JSON отключены, напоминание о копии скрыто.
// Д4 (low): таблица «Все параметры» не выдаёт за действующие параметры, которых расчёт не читает («пока не используется»); подпись не называет vocab.json.
// Д5 (low): если из читаемых записей прогноз не построить, диалог не обещает его и называет причину словами.
// Д6 (low): учебный шаг апкастера v1 → v2 (на фикстуре journal-v2-draft.json); реестр по умолчанию не тронут.
// Д7 (low): JSDoc у set_ws на своём месте.
// Заглушка DOM минимальная (как в readonly_boot): проверяется связка app.mjs ↔ ext.mjs ↔ пакет «Данные». Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DEMO = path.join(ROOT, 'demo');

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

const imp = (...p) => import(pathToFileURL(path.join(ROOT, ...p)).href);
const { ext } = await imp('demo', 'ext.mjs');
await imp('demo', 'app.mjs');
const { export_journal_copy, events_of_ws, inspect_import, forecast_probe } = await imp('demo', 'data_actions.mjs');
const { canon, analyze } = await imp('engine', 'index.mjs');
const { t } = await imp('demo', 'i18n.mjs');
await new Promise((r) => setTimeout(r, 500));

const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };
const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const clone = (x) => JSON.parse(JSON.stringify(x));
const G = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'g001.json'), 'utf8'));
const RU = (key, p) => t('ru', key, p);
const EN = (key, p) => t('en', key, p);
const btn_by_text = (root, text) => find_all(root, (n) => n.tagName === 'button' && n.textContent === text);

function newer_copy_obj() {
  const obj = JSON.parse(export_journal_copy(events_of_ws(G)).text);
  obj.format = 'runway-journal/2';
  obj.engine_version = '0.2.0';
  const last = obj.events.at(-1).seq;
  obj.events.push({ actor: 'user', entity_id: 'tx-next', event_id: 'ev-x2', payload: { account_id: 'acc_main', amount: { currency: 'EUR', minor: -1999 }, date: '2026-10-03' }, recorded_at: '2026-10-05T08:00:00Z', seq: last + 1, type: 'tx.posted', v: 2 });
  return obj;
}
const newer_copy_text = () => canon(newer_copy_obj());

async function pick_file(text) {
  await go('#data');
  const input = find_all(byid.get('main'), (n) => n.attrs.id === 'fp05-file')[0];
  input.files = [{ size: text.length, text: async () => text }];
  input.listeners.change[0]();
  await wait();
}

// ── Д1: тексты отказа в режиме «только чтение» ─────────────────────────────────────────────────────────────────────────────

const { create_ext } = await imp('demo', 'ext.mjs');
const { seeded_ports } = await imp('demo', 'ids.mjs');
const { error_text: entry_error_text } = await imp('demo', 'entry.mjs');
const { error_text: forms_error_text, commit_edits } = await imp('demo', 'forms.mjs');
const { error_text: wizard_error_text } = await imp('demo', 'import_wizard.mjs');
const { save_edits } = await imp('demo', 'settings.mjs');

/** Реестр с рабочей областью G-001 в режиме «только чтение» (как после «Открыть только для просмотра»). */
function ro_registry(lang = 'ru') {
  const e = create_ext({ ports: seeded_ports({ seed: 17 }) });
  const st = { ws: clone(G), notes: [] };
  e.bind_host({ get_ws: () => st.ws, get_model: () => null, lang: () => lang, mode: () => 'worse', fmt: () => null, set_ws: (n) => { st.ws = n; return { ok: true }; }, adopt: (n) => { st.ws = n; return { ok: true }; }, render() {}, notify: (m, k) => st.notes.push([k, m]) });
  e.reset(st.ws, { source: 'readonly', read_only: { newer_format: true, format: 'runway-journal/2', format_version: 2, known_version: 1, skipped: 1 } });
  return { e, st };
}

test('Д1: каждая из общих функций текста отказа отвечает режимом «только чтение» (RU и EN), а не «проверьте ввод» и не кодом', () => {
  const err = { code: 'E_SCHEMA', ctx: { reason: 'read_only' } };
  for (const [lang, tr, expect] of [['ru', RU, /только для просмотра/], ['en', EN, /viewing only/]]) {
    const c = { tr, lang: () => lang };
    const texts = [entry_error_text(c, err, { example: '1,00', as_of: '4 октября' }), forms_error_text(c, err), wizard_error_text(tr, err)];
    for (const x of texts) {
      assert.match(x, expect, lang + ': ' + x);
      assert.equal(x, tr('ro.refused'), 'один и тот же понятный текст');
      assert.doesNotMatch(x, /E_SCHEMA|проверьте|check the/, 'ввод не винят и кода нет: ' + x);
    }
  }
  // прочие отказы не затронуты: тот же код без причины read_only — прежние тексты
  const c = { tr: RU, lang: () => 'ru' };
  assert.notEqual(entry_error_text(c, { code: 'E_SCHEMA', ctx: { reason: 'zero' } }, {}), RU('ro.refused'));
  assert.notEqual(forms_error_text(c, { code: 'E_SCHEMA', ctx: null }), RU('ro.refused'));
});

test('Д1: путь «форма → commit_edits → реестр в режиме только чтение» даёт отказ с причиной read_only, данные не тронуты, текст — ro.refused; после выхода из просмотра правка проходит', () => {
  const { e, st } = ro_registry();
  const before = canon(st.ws);
  const edits = [{ type: 'set_param', key: 'horizon_days', value: 45 }];
  const r = commit_edits(e.ctx, edits, 'forms');
  assert.equal(r.ok, false);
  assert.equal(r.error.ctx.reason, 'read_only');
  assert.equal(forms_error_text(e.ctx, r.error), RU('ro.refused'));
  assert.equal(canon(st.ws), before, 'рабочая область не тронута');
  // настройки тем же путём
  const s = save_edits(e.ctx, edits);
  assert.equal(s.ok, false);
  assert.equal(s.error.ctx.reason, 'read_only');
  assert.equal(canon(st.ws), before);
  // выход из просмотра: выбор набора данных (reset без read_only) возвращает обычный режим
  e.reset(st.ws, { source: 'dataset' });
  assert.equal(e.ctx.read_only(), null);
  assert.equal(commit_edits(e.ctx, edits, 'forms').ok, true);
});

// ── Д2 и Д3 на уровне среды хранения ───────────────────────────────────────────────────────────────────────────────────────

const { create_runtime } = await imp('demo', 'data_runtime.mjs');
const { create_memory_store, create_memory_backing, create_lock } = await imp('demo', 'store.mjs');
const { apply_edit } = await imp('demo', 'ws_edit.mjs');
const AT = '2026-10-05T08:00:00Z';

function make_page(ws0) {
  let n = 0;
  const page = { ws: ws0, today: '2026-10-05', get_ws: () => page.ws, set_ws: (ws) => { page.ws = ws; return { ok: true }; }, refresh() {} };
  page.ports = { next_id: () => 'fix~' + (++n), recorded_at: () => AT };
  return page;
}
function runtime_on(page, store, extra = {}) {
  let rt = null;
  rt = create_runtime({
    store, store_kind: 'memory', lock: create_lock({ locks: null }), channel: null, storage_manager: { persisted: async () => true }, installed: () => true,
    today: () => page.today, ports: page.ports, get_ws: page.get_ws, set_ws: page.set_ws, refresh: page.refresh,
    adopt: (ws, o) => { page.ws = ws; rt.on_change({ reason: 'adopt', ws, source: o?.source }); return { ok: true }; }, ...extra,
  });
  return rt;
}
const fact = (i) => ({ type: 'add_fact', fact: { event_id: 'u_' + i, account_id: 'acc_main', date: '2026-10-03', amount_minor: -(100 + i), currency: 'EUR', tag: 'x' } });

/** Хранилище с сохранённым журналом (через первую же правку) и «перезагрузка»: найденное хранилище + набор по умолчанию. */
async function found_runtime(extra = {}) {
  const backing = create_memory_backing();
  const page = make_page(clone(G));
  const rt = runtime_on(page, create_memory_store({ backing }));
  await rt.init();
  const ws1 = apply_edit(page.ws, fact(1), { new_id: (p) => p + '_1' }).ws;
  page.ws = ws1;
  await rt.on_change({ reason: 'add_fact', ws: ws1 });
  const page2 = make_page(clone(G));
  const rt2 = runtime_on(page2, create_memory_store({ backing }), extra);
  assert.equal((await rt2.init()).mode, 'found');
  const count = async () => (await create_memory_store({ backing }).stat()).count;
  return { rt2, page2, count, backing };
}

test('Д2: в просмотре «Начать с текущего набора» (replace_saved) отказывает кодом read_only, сохранённый журнал цел; признак ведёт open_readonly', async () => {
  const { rt2, count } = await found_runtime();
  const saved = await count();
  assert.ok(saved > 0);
  assert.equal(rt2.status().read_only, false);
  const parsed = inspect_import(newer_copy_text());
  assert.equal((await rt2.open_readonly(parsed)).ok, true);
  await rt2.flush();
  assert.equal(rt2.status().read_only, true);
  const r = await rt2.replace_saved();
  assert.deepEqual([r.ok, r.error], [false, 'read_only']);
  assert.equal(await count(), saved, 'ни одна запись не стёрта');
  assert.equal(rt2.status().mode, 'found', 'карточка «Продолжить с сохранённого» остаётся');
});

test('Д2: выход из просмотра снимает запрет — «Продолжить с сохранённого», выбор набора (adopt) и «Восстановить» открывают replace_saved; без просмотра он работает как раньше', async () => {
  // обычный путь без просмотра — прежнее поведение
  const a = await found_runtime();
  const saved = await a.count();
  assert.equal((await a.rt2.replace_saved()).ok, true);
  assert.equal(await a.count(), 0, 'без просмотра сохранённое стирается по подтверждению, как раньше');
  assert.ok(saved > 0);
  // выбор набора данных
  const b = await found_runtime();
  await b.rt2.open_readonly(inspect_import(newer_copy_text()));
  await b.rt2.flush();
  assert.equal(b.rt2.status().read_only, true);
  await b.rt2.on_change({ reason: 'adopt', ws: clone(G), source: 'dataset' });
  assert.equal(b.rt2.status().read_only, false);
  assert.equal((await b.rt2.replace_saved()).ok, true);
  // «Продолжить с сохранённого»
  const c = await found_runtime();
  await c.rt2.open_readonly(inspect_import(newer_copy_text()));
  await c.rt2.flush();
  assert.equal(c.rt2.status().read_only, true);
  assert.equal((await c.rt2.continue_saved()).ok, true);
  assert.equal(c.rt2.status().read_only, false);
});

test('Д2: если реестр расширений передан средой (deps.read_only), истина — он: реестр сказал «просмотр» — отказ; реестр сказал «нет» — работает', async () => {
  let ro = { newer_format: true };
  const { rt2, count } = await found_runtime({ read_only: () => ro });
  const saved = await count();
  assert.deepEqual([rt2.status().read_only, (await rt2.replace_saved()).error], [true, 'read_only']);
  assert.equal(await count(), saved);
  ro = null;
  assert.equal(rt2.status().read_only, false);
  assert.equal((await rt2.replace_saved()).ok, true);
});

test('Д3: копия журнала из просмотра отказывает (код read_only), отметка «последняя копия» и pending_backup не заводятся; вне просмотра копия делается как прежде', async () => {
  const backing = create_memory_backing();
  const page = make_page(clone(G));
  const rt = runtime_on(page, create_memory_store({ backing }));
  await rt.init();
  const before = rt.status().last_backup;
  assert.equal(before, null);
  assert.ok((await rt.export_copy()).count > 0, 'вне просмотра копия делается');
  assert.notEqual(rt.status().last_backup, null, 'и отмечается как последняя');
  const parsed = inspect_import(newer_copy_text());
  await rt.open_readonly(parsed);
  await rt.flush();
  const lb = rt.status().last_backup; // открытие другого набора сбрасывает отложенную отметку: сравниваем с состоянием уже в просмотре
  await assert.rejects(() => rt.export_copy(), (e) => e.code === 'read_only');
  assert.deepEqual(rt.status().last_backup, lb, 'отказ ничего не записал: ни отметки о копии, ни отложенной записи');
});

// ── Д3, Д4: экран на настоящей странице ───────────────────────────────────────────────────────────────────────────────────

test('Д3: экран «Данные» в просмотре — плашка fp05-ro-note с форматом и числом пропущенных, «Скачать журнал» и «Выгрузить JSON» отключены, CSV и hledger работают, напоминания о копии нет', async () => {
  await pick_file(newer_copy_text());
  const btn = btn_by_text(byid.get('dlg-body'), 'Открыть только для просмотра')[0];
  assert.ok(btn !== undefined, 'файл читается: предлагается просмотр');
  btn.listeners.click[0]();
  await wait(150);
  await go('#data');
  const main = byid.get('main');
  const note = find_all(main, (n) => n.attrs.id === 'fp05-ro-note')[0];
  assert.ok(note !== undefined, 'плашка есть');
  assert.equal(note.attrs.role, 'status');
  assert.match(note.textContent, /Открыт только для просмотра/);
  assert.match(note.textContent, /runway-journal\/2/, 'формат файла назван');
  assert.match(note.textContent, /пропустила: 1/, 'число пропущенных записей названо');
  assert.match(note.textContent, /Копию журнала и выгрузку JSON из просмотра сделать нельзя/);
  assert.match(note.textContent, /В выгрузках CSV и hledger будут только записи, которые эта версия прочитала/);
  for (const name of ['Скачать журнал', 'Выгрузить JSON']) {
    const all = btn_by_text(main, name);
    assert.ok(all.length >= 1, name + ' на экране');
    for (const b of all) {
      assert.notEqual(b.attrs.disabled, undefined, name + ' отключена');
      assert.equal(b.attrs['aria-describedby'], 'fp05-ro-note', name + ' связана с плашкой');
    }
  }
  const tables = find_all(main, (n) => n.tagName === 'button' && /CSV|hledger/.test(n.textContent));
  assert.ok(tables.length >= 2, 'кнопки CSV и hledger на экране');
  for (const b of tables) assert.equal(b.attrs.disabled, undefined, 'выгрузка таблиц остаётся: ' + b.textContent);
});

test('Д3: после выхода из просмотра (выбор набора данных) плашка исчезает, а копия журнала и выгрузка JSON снова включены', async () => {
  await go('#data');
  const sel = find_all(byid.get('main'), (n) => n.attrs.id === 'ds-sel')[0];
  sel.value = 'g001';
  for (const fn of sel.listeners.change ?? []) fn();
  await wait(200);
  await go('#data');
  const main = byid.get('main');
  assert.equal(find_all(main, (n) => n.attrs.id === 'fp05-ro-note').length, 0, 'плашки нет');
  for (const name of ['Скачать журнал', 'Выгрузить JSON']) for (const b of btn_by_text(main, name)) assert.equal(b.attrs.disabled, undefined, name + ' включена');
});

// ── Д2: карточка «Продолжить с сохранённого» на уровне узлов ───────────────────────────────────────────────────────────────

const { render_continue_card, render_backup_banner, render_storage_section, read_only_info } = await imp('demo', 'data_view.mjs');

function card_ctx(ro) {
  return { tr: RU, lang: () => 'ru', read_only: () => ro, notify() {}, get_ws: () => clone(G) };
}
function rt_stub(status) { return { status: () => ({ mode: 'found', saved: 48, read_only: false, banner: { show: true, reasons: ['due'] }, store_kind: 'memory', count: 48, last_backup: null, engine: { current: '0.2.0', stale: [], held: [] }, counts: {}, ...status }), export_copy: async () => { throw new Error('не должно вызываться'); } }; }

test('Д2: карточка «В этом браузере есть сохранённые данные» в просмотре — без кнопки «Начать с текущего набора», с пояснением; без просмотра кнопка на месте', () => {
  const ro = { newer_format: true, format: 'runway-journal/2', known_version: 1, skipped: 1 };
  const on = render_continue_card(card_ctx(ro), rt_stub({}));
  assert.equal(btn_by_text(on, 'Начать с текущего набора').length, 0);
  assert.equal(btn_by_text(on, 'Продолжить с сохранённого').length, 1, 'продолжить можно');
  assert.match(on.textContent, /стирать сохранённое ради него нельзя/);
  const off = render_continue_card(card_ctx(null), rt_stub({}));
  assert.equal(btn_by_text(off, 'Начать с текущего набора').length, 1);
  assert.doesNotMatch(off.textContent, /стирать сохранённое ради него нельзя/);
  // признак среды хранения заменяет реестр, если реестра нет (заглушки)
  assert.equal(read_only_info({ tr: RU }, rt_stub({ read_only: true })) !== null, true);
  assert.equal(read_only_info({ tr: RU }, rt_stub({ read_only: false })), null);
  // EN
  const en = render_continue_card({ ...card_ctx(ro), tr: EN, lang: () => 'en' }, rt_stub({}));
  assert.equal(btn_by_text(en, 'Start from the current data set').length, 0);
  assert.match(en.textContent, /cannot be erased for it/);
});

test('Д3: напоминание о копии в просмотре скрыто; в разделе хранения — плашка и отключённая «Скачать журнал»; вне просмотра их нет', () => {
  const ro = { newer_format: false, skipped: 2 };
  assert.equal(render_backup_banner(card_ctx(ro), rt_stub({})), null);
  assert.notEqual(render_backup_banner(card_ctx(null), rt_stub({})), null);
  const on = render_storage_section(card_ctx(ro), rt_stub({ mode: 'paused' }));
  assert.match(on.textContent, /в файле есть записи более новой версии/);
  assert.match(on.textContent, /пропустила: 2/);
  assert.notEqual(btn_by_text(on, 'Скачать журнал')[0].attrs.disabled, undefined);
  const off = render_storage_section(card_ctx(null), rt_stub({ mode: 'paused' }));
  assert.equal(find_all(off, (n) => n.attrs.id === 'fp05-ro-note').length, 0);
  assert.equal(btn_by_text(off, 'Скачать журнал')[0].attrs.disabled, undefined);
});

// ── Д4: честность таблицы параметров ──────────────────────────────────────────────────────────────────────────────────────

const sd = await imp('demo', 'settings_defaults.mjs');

/** Читатели параметра: строки кода (не комментарии, не определения умолчаний), где ключ назван литералом; модули словаря, проверки диапазонов и тексты не считаются. */
function readers_of(key) {
  const skip = /^(vocab\.generated|param_defaults|validate_ws|settings_defaults|ws_edit|quality_report)\.mjs$/;
  const hits = [];
  for (const dir of ['engine', 'demo']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir), { recursive: true })) {
      const rel = String(f).split('\\').join('/');
      if (!rel.endsWith('.mjs') || skip.test(path.basename(rel)) || rel.includes('i18n')) continue;
      const lines = fs.readFileSync(path.join(ROOT, dir, rel), 'utf8').split('\n');
      for (const [i, l] of lines.entries()) {
        if (/^\s*(\/\/|\*|\/\*)/.test(l)) continue;
        if (/\bvd\(|vdefault\(|DEFAULTS\b/.test(l) && !/\bP\[|params/.test(l)) continue;
        if (l.includes("'" + key + "'") || l.includes('"' + key + '"') || (!key.includes('.') && new RegExp('\\.' + key + '\\b').test(l))) hits.push(dir + '/' + rel + ':' + (i + 1));
      }
    }
  }
  return hits;
}

test('Д4: список «пока не используется» совпадает с кодом — у каждого такого параметра нет читателя (кроме показа собственных параметров отчёта), у остальных он есть', () => {
  const display_only = /^demo\/quality\.mjs:/; // показывает параметры своего отчёта (report.params), а не рабочей области
  for (const key of sd.LISTED_KEYS) {
    const hits = readers_of(key).filter((x) => !display_only.test(x));
    if (sd.NOT_YET_USED.includes(key)) assert.equal(hits.length, 0, key + ': появился читатель (' + hits.join(', ') + ') — уберите параметр из NOT_YET_USED');
    else assert.ok(hits.length > 0, key + ': читателя нет — добавьте параметр в NOT_YET_USED или подключите его к расчёту');
  }
  for (const key of sd.NOT_YET_USED) assert.ok(sd.LISTED_KEYS.includes(key), key + ' — в таблице');
});

test('Д4: строки таблицы — used: false у mc.n_paths и ещё восьми; у horizon_days и прочих used: true; значение G-001 по умолчанию остаётся данными словаря', () => {
  const model = { ws: clone(G) };
  const rows = sd.default_rows(model);
  assert.deepEqual(rows.filter((r) => !r.used).map((r) => r.key).sort(), [...sd.NOT_YET_USED].sort());
  assert.equal(rows.find((r) => r.key === 'mc.n_paths').default, 2000);
  assert.equal(rows.find((r) => r.key === 'horizon_days').used, true);
  assert.equal(sd.default_row(model, 'mc.n_paths').used, false);
});

test('Д4: карточка «Все параметры» — у «не используется» нет значения «действует», состояние названо словами, у остальных всё как прежде (RU и EN)', () => {
  const model = { ws: clone(G), cur: 'EUR', as_of_iso: G.as_of };
  for (const [lang, tr, unused_cell, state_text] of [['ru', RU, 'не используется', 'пока не используется расчётом'], ['en', EN, 'not used', 'not used by the calculation yet']]) {
    const c = { tr, lang: () => lang };
    const sec = sd.defaults_section(c, model, { on_reset() {} });
    const rows = find_all(sec, (n) => n.tagName === 'tr');
    const row_of = (name) => rows.find((r) => r.textContent.includes(name));
    const n_paths = row_of(tr('defaults.p_mc_n_paths'));
    assert.ok(n_paths !== undefined);
    assert.ok(n_paths.textContent.includes(unused_cell), lang + ': ' + n_paths.textContent);
    assert.ok(n_paths.textContent.includes(state_text), lang + ': ' + n_paths.textContent);
    const horizon = row_of(tr('defaults.p_horizon_days'));
    assert.ok(!horizon.textContent.includes(unused_cell), lang + ': у используемого параметра этой пометки нет');
    assert.ok(!horizon.textContent.includes(state_text), lang + ': у используемого параметра нет пометки «не используется»');
    // подпись не называет внутренний файл и не обещает «не зашито»
    const lead = tr('defaults.l_all');
    assert.doesNotMatch(lead, /vocab\.json/);
    assert.doesNotMatch(lead, /не зашиты|not hard-coded/);
  }
});

// ── Д5: прогноз по читаемой части ─────────────────────────────────────────────────────────────────────────────────────────

test('Д5: inspect_import проверяет, строится ли прогноз по читаемой части: пропущен счёт или профиль — unusable (ok: true, диалог без обещания); пропущена проводка — прогноз строится', () => {
  const mk = (mut) => { const o = newer_copy_obj(); mut(o); return inspect_import(canon(o)); };
  const good = mk(() => {});
  assert.deepEqual([good.ok, good.read_only, good.unusable, good.read_only_info.unusable], [true, true, undefined, undefined]);
  assert.equal(forecast_probe(good.ws), null);
  const no_accounts = mk((o) => { for (const e of o.events) if (e.type === 'account.opened') e.v = 2; });
  assert.deepEqual([no_accounts.ok, no_accounts.read_only, no_accounts.unusable], [true, true, true]);
  assert.equal(typeof no_accounts.read_only_info.unusable, 'string');
  assert.ok(no_accounts.read_only_info.skipped >= 1);
  const types = new Set(newer_copy_obj().events.map((e) => e.type));
  // для каждого типа записи: если из-за пропуска его одного прогноз не построить, файл помечен unusable ровно тогда, когда analyze не справляется
  for (const type of types) {
    const o = newer_copy_obj();
    for (const e of o.events) if (e.type === type) e.v = 99;
    const r = inspect_import(canon(o));
    if (r.ok !== true) continue; // нечего читать вовсе — прежний отказ
    let builds = true;
    try { analyze(r.ws, { as_of: r.ws.as_of }); } catch { builds = false; }
    assert.equal(r.unusable === true, !builds, type + ': пометка unusable должна совпадать с тем, что страница действительно не построит прогноз');
  }
  // та же проверка для набора данных с полем format новее известного
  const ws2 = clone(G); ws2.format = 'runway-journal/2'; delete ws2.accounts;
  const w = inspect_import(JSON.stringify(ws2));
  assert.deepEqual([w.ok, w.kind, w.read_only, w.unusable], [true, 'workspace', true, true]);
  const w_ok = inspect_import(JSON.stringify({ ...clone(G), format: 'runway-journal/2' }));
  assert.deepEqual([w_ok.ok, w_ok.read_only, w_ok.unusable], [true, true, undefined]);
});

test('Д5: среда хранения не открывает «неиспользуемый» файл: open_readonly отвечает unusable, рабочая область не подменяется', async () => {
  const o = newer_copy_obj();
  for (const e of o.events) if (e.type === 'account.opened') e.v = 2;
  const parsed = inspect_import(canon(o));
  const page = make_page(clone(G));
  const before = canon(page.ws);
  const rt = runtime_on(page, create_memory_store({ backing: create_memory_backing() }));
  await rt.init();
  const r = await rt.open_readonly(parsed);
  assert.deepEqual([r.ok, r.error], [false, 'unusable']);
  assert.equal(canon(page.ws), before);
  assert.equal(rt.status().read_only, false);
});

test('Д5: диалог «Восстановить» для такого файла (RU и EN) — причина словами, без кнопок «Открыть» и «Заменить», без кода', async () => {
  const o = newer_copy_obj();
  for (const e of o.events) if (e.type === 'account.opened') e.v = 2;
  await pick_file(canon(o));
  const dlg = byid.get('dlg-body');
  assert.match(dlg.textContent, /прогноз не построить: нет основных данных, например счетов или профиля \(пропущено записей: \d+\)/);
  assert.doesNotMatch(dlg.textContent, /прогноз будет виден|E_SCHEMA/);
  assert.equal(btn_by_text(dlg, 'Открыть только для просмотра').length + btn_by_text(dlg, 'Заменить данные').length, 0);
  assert.match(EN('data.readonly_unusable', { n: 2 }), /no forecast can be built.*records skipped: 2/);
});

// ── Д6: учебный шаг апкастера ─────────────────────────────────────────────────────────────────────────────────────────────

test('Д6: учебный шаг апкастера tx.posted v1 → v2 (черновой реестр): запись v1 поднимается ровно на 1, вход не меняется, запись фикстуры v2 принимается; реестр по умолчанию по-прежнему отвергает v2', async () => {
  const L = await imp('engine', 'ledger.mjs');
  const fixture = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'journal-v2-draft.json'), 'utf8'));
  // черновая схема v2 записи «проводка»: к payload добавлено необязательное поле note (его несёт запись ev-016 фикстуры); шаг v1 → v2 только поднимает версию
  const draft = {
    current: { ...L.DEFAULT_UPCAST_REGISTRY.current, 'tx.posted': 2 },
    steps: { 'tx.posted': { 1: (e) => ({ ...e, v: 2, payload: { ...e.payload } }) } },
  };
  const v1_tx = fixture.events.find((e) => e.type === 'tx.posted' && e.v === 1);
  const v2_tx = fixture.events.find((e) => e.type === 'tx.posted' && e.v === 2);
  assert.ok(v1_tx !== undefined && v2_tx !== undefined && typeof v2_tx.payload.note === 'string');
  const frozen = JSON.parse(JSON.stringify(v1_tx));
  const up = L.upcast(v1_tx, draft);
  assert.equal(up.v, 2);
  assert.deepEqual(v1_tx, frozen, 'запись на диске (вход) не изменилась');
  assert.deepEqual(up.payload, v1_tx.payload, 'шаг не теряет полей');
  assert.equal(L.upcast(v2_tx, draft), v2_tx, 'запись текущей версии черновой схемы — та же');
  // черновой читатель принимает ВСЕ записи фикстуры: каждая приведена к текущей версии своей схемы
  // (запись неизвестного типа — category.set — апкастер не лечит: такая запись пропускается и считается, это уже проверено в readonly_open)
  for (const e of fixture.events) {
    if (draft.current[e.type] === undefined) assert.throws(() => L.upcast(e, draft), (err) => err.ctx.reason === 'unknown_type');
    else assert.equal(L.upcast(e, draft).v, draft.current[e.type]);
  }
  // реестр по умолчанию: v2 неизвестна — поэтому файл и открывается только для просмотра (запись пропускается, а не угадывается)
  assert.throws(() => L.upcast(v2_tx), (err) => err.code === 'E_SCHEMA' && err.ctx.reason === 'newer_version');
  assert.deepEqual(Object.keys(L.DEFAULT_UPCAST_REGISTRY.steps), [], 'реального шага в реестре по умолчанию нет: появится вместе с повышением версии формата');
  assert.ok(Object.values(L.DEFAULT_UPCAST_REGISTRY.current).every((v) => v === 1));
  // шаг обязан поднимать версию ровно на 1
  const bad = { current: draft.current, steps: { 'tx.posted': { 1: (e) => ({ ...e, v: 3 }) } } };
  assert.throws(() => L.upcast(v1_tx, bad), (err) => err.ctx.reason === 'upcaster_must_raise_v_by_1');
});

// ── Д7: порядок JSDoc в ext.mjs; каталоги ──────────────────────────────────────────────────────────────────────────────────

test('Д7: в ext.mjs блок документации «Заменить рабочую область» стоит прямо над set_ws, а отказ режима чтения — отдельно выше', () => {
  const src = fs.readFileSync(path.join(DEMO, 'ext.mjs'), 'utf8');
  const doc = src.indexOf('Заменить рабочую область: страница пересчитывает модель');
  const set_ws = src.indexOf('const set_ws = (ws, o = {}) => {');
  const deny = src.indexOf('const deny_read_only = () => {');
  assert.ok(doc > 0 && set_ws > doc && deny > 0 && deny < doc, 'порядок: deny_read_only → JSDoc set_ws → set_ws');
  assert.equal(src.slice(doc, set_ws).includes('const '), false, 'между документацией и set_ws нет других объявлений');
});

test('RU и EN: новые строки пары (паритет, русские буквы в RU, плейсхолдеры совпадают)', async () => {
  const data = (await imp('demo', 'i18n', 'data.mjs')).default;
  const defaults = (await imp('demo', 'i18n', 'defaults.mjs')).default;
  const keys = ['data.readonly_state_format', 'data.readonly_state_records', 'data.readonly_no_copy', 'data.readonly_exports', 'data.readonly_no_replace', 'data.readonly_unusable'];
  for (const [cat, list] of [[data, keys], [defaults, ['defaults.st_unused', 'defaults.v_not_used', 'defaults.l_all']]]) {
    for (const k of list) {
      assert.equal(typeof cat.ru[k], 'string', k);
      assert.equal(typeof cat.en[k], 'string', k);
      assert.match(cat.ru[k], /[а-яё]/i, k + ': в RU нет русских букв');
      const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
      assert.equal(ph(cat.ru[k]), ph(cat.en[k]), k + ': плейсхолдеры');
    }
  }
});

test('завершение: заглушки сняты', () => {
  globalThis.fetch = real_fetch;
  assert.ok(true);
});
