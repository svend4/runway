// offline_inventory.test.mjs — FP-12, REQ-120 / REQ-117: инвентарь сетевых вызовов и полнота списка файлов оболочки.
// 1) статический инвентарь: в файлах оболочки нет сетевых примитивов, кроме разрешённых по списку (один fetch набора данных в app.mjs; воркер и воркер расчёта — в своих модулях);
// 2) настоящий app.mjs на заглушке DOM загружается с ОДНИМ обращением к сети (набор данных), после чего сценарии Q1, Q3, импорт CSV и экспорт (JSON, CSV, hledger) дают 0 сетевых вызовов;
// 3) список файлов оболочки (манифест хэшей) совпадает с ФАКТИЧЕСКИМ списком: модули, реально загруженные загрузчиком Node при импорте приложения, пакетов, v0 и воркера,
//    стили, записанные в страницу, и наборы данных — всё внутри оболочки, а лишних модулей в оболочке нет; всё, что приложение загрузило, воркер отдаёт из кэша без сети.
// Браузера нет; заглушка DOM минимальная. Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import module from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PROTO, load_sw, read_files, ORIGIN, ROOT_PATH } from './sw_harness.mjs';

const read = (...p) => fs.readFileSync(path.join(PROTO, ...p), 'utf8');
const MANIFEST = JSON.parse(read('demo', 'shell_manifest.json'));
const SHELL = new Set([...MANIFEST.files.map((f) => f.path), ...MANIFEST.stamped.map((f) => f.path)]);
const rel_of_url = (u) => { const p = fileURLToPath(u); const r = path.relative(PROTO, p).split(path.sep).join('/'); return r.startsWith('..') ? null : r; };

// ── загрузчик модулей Node: записываем каждый загруженный файл (до импорта приложения) ───────────────────────────────────────

const loaded = new Set();
const HOOKS = typeof module.registerHooks === 'function'
  ? module.registerHooks({ load(url, context, next_load) { if (url.startsWith('file:')) loaded.add(url); return next_load(url, context); } })
  : null;

// ── заглушка DOM, счётчики сети ──────────────────────────────────────────────────────────────────────────────────────

class Node_ {
  constructor(tag, ns) {
    this.nodeType = 1; this.tagName = tag; this.ns = ns ?? null; this.attrs = {}; this.children = []; this.listeners = {}; this.className = '';
    this._text = ''; this._value = ''; this._sel = null; this.open = false; this.focused = false; this.checked = false;
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
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this._value = String(v); if (k === 'checked') this.checked = true; }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return Object.hasOwn(this.attrs, k); }
  append(...kids) { for (const k of kids) this.children.push(k); this._text = ''; }
  replaceChildren(...kids) { this.children = []; this._text = ''; this.append(...kids); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  focus() { this.focused = true; }
  click() { this.clicked = (this.clicked ?? 0) + 1; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() {}
  querySelectorAll() { return []; }
  walk(fn) { fn(this); for (const c of this.children) if (c.nodeType === 1) c.walk(fn); }
}
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const byid = new Map();
for (const id of ['app-title', 'app-sub', 'skip', 'controls', 'nav', 'summary', 'main', 'footer', 'live', 'dlg', 'dlg-title', 'dlg-close', 'dlg-body']) byid.set(id, new Node_(id === 'dlg' ? 'dialog' : 'div'));
const listeners = {};
globalThis.document = {
  createElement: (t) => new Node_(t),
  createElementNS: (ns, t) => new Node_(t, ns),
  createTextNode: (data) => ({ nodeType: 3, data }),
  getElementById: (id) => byid.get(id) ?? find_all(byid.get('main'), (n) => n.attrs.id === id)[0] ?? null,
  documentElement: new Node_('html'),
  head: new Node_('head'),
  body: new Node_('body'),
  title: '',
};
globalThis.window = { addEventListener: (t, fn) => { (listeners[t] ??= []).push(fn); }, scrollTo: () => {} };
globalThis.location = { hash: '' };
const net = { fetch: [], other: [], workers: [] }; // workers (FP-21): попытки создать Web Worker расчёта — не сеть, но фиксируются отдельно
Object.defineProperty(globalThis, 'navigator', { value: { language: 'ru-RU', sendBeacon: () => { net.other.push('sendBeacon'); return false; } }, configurable: true });
const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.ResizeObserver = class { observe() {} };
globalThis.fetch = async (url) => { net.fetch.push(String(url)); return { ok: true, json: async () => JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8')) }; };
for (const name of ['XMLHttpRequest', 'WebSocket', 'EventSource', 'SharedWorker']) {
  globalThis[name] = class { constructor() { net.other.push(name); throw new Error('сеть запрещена в тесте'); } };
}
// FP-21: приложение прогревает воркер расчёта при загрузке (pack_fp21) — это не сетевой вызов, но воркера в тесте нет: конструктор записывает попытку и отказывает, клиент откатывается на главный поток
globalThis.Worker = class { constructor() { net.workers.push('Worker'); throw new Error('воркера в тесте нет'); } };

const { ext } = await import(pathToFileURL(path.join(PROTO, 'demo', 'ext.mjs')).href);
await import(pathToFileURL(path.join(PROTO, 'demo', 'app.mjs')).href);
await new Promise((r) => setTimeout(r, 700));
const boot_fetches = [...net.fetch];
net.fetch.length = 0;

const EXTRA_ROOTS = ['demo/v0.mjs', 'demo/calc_worker.mjs', 'demo/worker_client.mjs', 'demo/about.mjs', 'demo/bench_page.mjs', 'demo/coldstart_page.mjs', 'demo/compat_page.mjs']; // FP-23: страницы замеров и самопроверки
for (const r of EXTRA_ROOTS) await import(pathToFileURL(path.join(PROTO, r)).href);

const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);
const ENGINE = await imp('engine', 'index.mjs');
const TOOLS = await imp('engine', 'tools.mjs');
const VERIFIER = await imp('engine', 'verifier.mjs');
const DATES = await imp('engine', 'dates.mjs');
const IM = await imp('demo', 'import_model.mjs');
const DA = await imp('demo', 'data_actions.mjs');
const BM = await imp('tools', 'build_manifest.mjs');
const ctx = ext.ctx;
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };

// ── 1. статический инвентарь ────────────────────────────────────────────────────────────────────────────────────────

const TEXT_EXT = new Set(['.mjs', '.js', '.html', '.css', '.webmanifest', '.json', '.svg']);
const shell_text = [...SHELL].filter((p) => TEXT_EXT.has(path.posix.extname(p))).map((p) => ({ rel: p, src: read(...p.split('/')) }));
const code_of = (src) => src.replace(/(^|\s)\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
const count = (src, re) => (code_of(src).match(re) ?? []).length;

test('REQ-120 инвентарь сетевых вызовов в файлах оболочки: fetch — один в app.mjs (набор данных) и три в sw.js (манифест, файл оболочки, проход); других сетевых примитивов нет', () => {
  const fetches = shell_text.map((f) => [f.rel, count(f.src, /\bfetch\s*\(/g)]).filter(([, n]) => n > 0);
  // FP-23: страница замера demo/bench_page.mjs читает набор G-001 с того же хоста (ровно один вызов); у coldstart.html и compat.html сети нет
  assert.deepEqual(fetches.sort(), [['demo/app.mjs', 1], ['demo/bench_page.mjs', 1], ['demo/sw.js', 3]].sort());
  for (const f of shell_text) {
    for (const bad of ['XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'importScripts', 'SharedWorker', 'window.open', 'location.assign', 'location.replace', 'new Image(', 'RTCPeerConnection', 'navigator.connection']) {
      assert.equal(count(f.src, new RegExp(bad.replace(/[.()]/g, '\\$&'), 'g')), 0, `${f.rel}: ${bad}`);
    }
  }
  assert.deepEqual(shell_text.filter((f) => count(f.src, /\bnew\s+(?:globalThis\.)?Worker\s*\(/g) > 0).map((f) => f.rel), ['demo/worker_client.mjs'], 'воркер создаёт только клиент воркера расчёта');
  assert.deepEqual(shell_text.filter((f) => count(f.src, /serviceWorker\s*\.\s*register\s*\(|\.register\s*\(\s*sw_url/g) > 0).map((f) => f.rel), ['demo/pwa.mjs'], 'сервис-воркер регистрирует только pwa.mjs');
  assert.deepEqual(shell_text.filter((f) => f.rel.startsWith('engine/')).filter((f) => count(f.src, /\bfetch\b|\bWorker\b|\bnavigator\b|\blocation\b/g) > 0).map((f) => f.rel), [], 'в engine/ нет сети (REQ-120)');
  // внешних адресов нет: единственное исключение — идентификатор пространства имён SVG
  for (const f of shell_text) {
    const urls = (f.src.match(/https?:\/\/[^\s'"`)<>]+/g) ?? []).filter((u) => u !== 'http://www.w3.org/2000/svg');
    assert.deepEqual(urls, [], `${f.rel}: внешний адрес`);
  }
  // страницы: только свои скрипты, стили и манифест
  for (const page of ['demo/index.html', 'demo/v0.html', 'demo/bench.html', 'demo/coldstart.html', 'demo/compat.html']) {
    const html = read(...page.split('/'));
    for (const m of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) assert.ok(m[1] === 'data:,' || !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(m[1]), `${page}: внешняя ссылка ${m[1]}`);
  }
});

// ── 2. сценарии без сети ────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-120 загрузка приложения: ровно одно обращение к сети — набор данных G-001 с того же хоста', () => {
  assert.equal(boot_fetches.length, 1, JSON.stringify(boot_fetches));
  assert.equal(rel_of_url(boot_fetches[0]), 'data/g001.json');
  assert.deepEqual(net.other, [], 'остальные сетевые примитивы не вызывались');
  assert.deepEqual(net.workers, ['Worker'], 'FP-21: одна попытка запустить воркер расчёта (прогрев пакета); воркер не запустился — приложение считает на главном потоке');
});

test('REQ-120 TST-59 сценарии Q1, Q3, импорт CSV и экспорт (JSON, CSV, hledger) после загрузки оболочки: 0 сетевых вызовов; результаты — настоящие числа G-001', async () => {
  const before = net.fetch.length + net.other.length;
  // проход по всем разделам приложения (навигация из реестра)
  const hrefs = find_all(byid.get('nav'), (n) => n.tagName === 'a').map((n) => n.attrs.href);
  assert.ok(hrefs.length >= 20, 'разделов: ' + hrefs.length);
  for (const h of hrefs) await go(h);
  assert.ok(hrefs.includes('#about') && hrefs.includes('#start') && hrefs.includes('#reconcile'));
  await go('#overview');

  const ws = ctx.get_ws();
  const model = ctx.get_model();
  // Q1: узкая точка денег — настоящие числа канона G-001 (2 055,00 € на 31 октября по плану, 1 830,00 € на 14 ноября «если хуже») и ответ A0 тем же путём,
  // что и Q3 (инструмент движка → шаблон → проверка); Q3: «могу ли я купить»
  const q1 = model.ctx.q1;
  assert.deepEqual([q1.plan.min, q1.plan.at, q1.worse.min, q1.worse.at], [205500, DATES.parse_date('2026-10-31'), 183000, DATES.parse_date('2026-11-14')], 'Q1 G-001: узкие точки по канону');
  const q1_plan = VERIFIER.a0_answer(['explain', '--mode', 'plan'], TOOLS.make_tool_ctx(ws, { as_of: ws.as_of }, { locale: 'ru' }), { locale: 'ru' });
  assert.equal(q1_plan.ok, true, JSON.stringify(q1_plan.error));
  assert.equal(q1_plan.verified, true);
  assert.match(q1_plan.text, /самая узкая точка денег на счетах — 2\s055,00\s€ \(31 октября\)/, 'Q1 по плану');
  const q1_worse = VERIFIER.a0_answer(['explain'], TOOLS.make_tool_ctx(ws, { as_of: ws.as_of }, { locale: 'ru' }), { locale: 'ru' });
  assert.equal(q1_worse.ok, true, JSON.stringify(q1_worse.error));
  assert.match(q1_worse.text, /самая узкая точка денег на счетах — 1\s830,00\s€ \(14 ноября\)/, 'Q1 «если хуже»');
  const tctx = TOOLS.make_tool_ctx(ws, { as_of: ws.as_of }, { locale: 'ru' });
  const proj = VERIFIER.a0_answer(['projection', '2026-11-30'], tctx, { locale: 'ru' });
  assert.equal(proj.ok, true, JSON.stringify(proj.error));
  const q3 = VERIFIER.a0_answer(['check-purchase', '2026-10-12', '30000', 'EUR'], TOOLS.make_tool_ctx(ws, { as_of: ws.as_of }, { locale: 'ru' }), { locale: 'ru' });
  assert.equal(q3.ok, true, JSON.stringify(q3.error));
  assert.match(q3.text, /хрупко/i, 'G-001: покупка 300 € на 12 октября — «хрупко»');
  assert.equal(q3.verified, true);

  // импорт CSV: сухой прогон и запись общим путём приложения
  const csv = fs.readFileSync(path.join(PROTO, 'tests', 'fixtures', 'import-152.csv'), 'utf8');
  const plan = IM.plan_csv(ws, { text: csv, bytes: csv, name: 'import-152.csv', profile: IM.BUILTIN_PROFILES['csv-generic'], account_id: 'acc_main' });
  assert.equal(plan.ok, true, JSON.stringify(plan.error));
  const done = IM.commit_plan(ws, plan.plan, {}, { new_id: ctx.new_id });
  assert.equal(done.ok, true, JSON.stringify(done.error));
  assert.ok(done.batch.facts > 100, 'принято фактов: ' + done.batch.facts);
  const wrote = ctx.set_ws(done.ws, { reason: 'import' });
  assert.equal(wrote.ok, true, JSON.stringify(wrote.error));

  // экспорт: JSON-копия, CSV, hledger
  const ws2 = ctx.get_ws();
  const json_copy = DA.export_journal_copy(DA.events_of_ws(ws2));
  assert.ok(json_copy.bytes > 1000 && JSON.parse(json_copy.text).format === 'runway-journal/1');
  const csv_out = DA.export_csv_file(ws2);
  assert.ok(csv_out.rows > 100 && csv_out.text.includes('2026-07-01'), 'CSV: строк ' + csv_out.rows);
  const hl = DA.export_hledger_file(ws2);
  assert.ok(hl.planned > 0 && hl.text.includes('2026-10-04'), 'hledger: плановых ' + hl.planned);
  assert.equal(ENGINE.ENGINE_VERSION, MANIFEST.engine_version);

  assert.deepEqual([net.fetch.length + net.other.length - before, net.fetch, net.other], [0, [], []], 'после загрузки оболочки ни одного сетевого вызова');
});

// ── 3. список файлов оболочки = фактический ─────────────────────────────────────────────────────────────────────────────

test('REQ-120 REQ-154 список файлов оболочки совпадает с манифестом хэшей и с обходом ссылок; в манифесте нет ссылок на несуществующее, за пределы demo-engine-data и повторов', () => {
  const c = BM.collect_shell(PROTO);
  assert.deepEqual(c.missing, []);
  assert.deepEqual(c.outside, []);
  assert.deepEqual([...c.files], [...SHELL].sort(), 'файлы, найденные обходом ссылок = файлы манифеста (хэшируемые и штампованные)');
  assert.equal(new Set(MANIFEST.files.map((f) => f.path)).size, MANIFEST.files.length, 'повторов в манифесте нет');
  assert.deepEqual(MANIFEST.files.map((f) => f.path), [...MANIFEST.files.map((f) => f.path)].sort(), 'пути отсортированы');
  assert.equal(HOOKS !== null, true, 'в этой версии Node есть module.registerHooks — фактический список модулей получен загрузчиком');
});

test('REQ-120 фактический список: все модули, загруженные Node при импорте приложения, пакетов, v0 и воркера, лежат в оболочке, а в оболочке нет модулей, которые никто не загружает', () => {
  const loaded_rel = new Set([...loaded].map(rel_of_url).filter((r) => r !== null && /^(demo|engine|data)\//.test(r)));
  assert.ok(loaded_rel.size > 100, 'загружено модулей: ' + loaded_rel.size);
  const outside_shell = [...loaded_rel].filter((r) => !SHELL.has(r));
  assert.deepEqual(outside_shell, [], 'загружено, но нет в оболочке');
  const dead = [...SHELL].filter((p) => p.endsWith('.mjs') && !loaded_rel.has(p));
  assert.deepEqual(dead, [], 'в оболочке, но никто не загружает');
  // каждый пакет из манифеста пакетов загружен
  const MAN = fs.readFileSync(path.join(PROTO, 'demo', 'ext_manifest.mjs'), 'utf8');
  for (const m of MAN.matchAll(/import\('\.\/(pack_fp\d\d\.mjs)'\)/g)) assert.ok(loaded_rel.has('demo/' + m[1]), m[1]);
});

test('REQ-120 стили и наборы данных, которые приложение действительно запросило, лежат в оболочке; все наборы из списка DATASETS — тоже', async () => {
  const links = find_all(document.head, (n) => n.tagName === 'link' && n.attrs.rel === 'stylesheet').map((n) => n.attrs.href);
  assert.ok(links.length >= 10, 'подключено стилей пакетов: ' + links.length);
  for (const href of links) assert.ok(SHELL.has('demo/' + href), 'стиль вне оболочки: ' + href);
  for (const u of boot_fetches) assert.ok(SHELL.has(rel_of_url(u)), u);
  const { DATASETS } = await imp('demo', 'i18n.mjs');
  for (const d of DATASETS) assert.ok(SHELL.has(path.posix.normalize('demo/' + d.file)), 'набор данных вне оболочки: ' + d.file);
  // ресурсы страницы
  for (const p of ['demo/index.html', 'demo/v0.html', 'demo/bench.html', 'demo/coldstart.html', 'demo/compat.html', 'demo/css/probe.css', 'demo/style.css', 'demo/manifest.webmanifest', 'demo/icons/icon.svg', 'demo/icons/icon-maskable.svg', 'demo/css/v0.css']) assert.ok(SHELL.has(p), p);
});

test('REQ-117 REQ-120 всё, что приложение загрузило, воркер отдаёт из кэша без сети (установка → офлайн → запрос каждого загруженного файла)', async () => {
  const paths = new Set([...loaded].map(rel_of_url).filter((r) => r !== null && /^(demo|engine|data)\//.test(r) && r.endsWith('.mjs')));
  for (const href of find_all(document.head, (n) => n.tagName === 'link' && n.attrs.rel === 'stylesheet').map((n) => n.attrs.href)) paths.add('demo/' + href);
  for (const u of boot_fetches) paths.add(rel_of_url(u));
  for (const p of ['demo/index.html', 'demo/style.css', 'demo/manifest.webmanifest', 'demo/icons/icon.svg']) paths.add(p);
  const list = BM.precache_list(MANIFEST);
  const w = load_sw({ files: read_files([...list.map((f) => f.path), 'demo/shell_manifest.json']) });
  assert.equal((await w.install()).ok, true);
  w.state.online = false;
  w.log.network.length = 0;
  for (const p of [...paths].sort()) {
    const r = await w.request(ORIGIN + ROOT_PATH + p);
    assert.equal(r.handled, true, p);
    assert.equal(r.response.status, 200, p);
  }
  assert.deepEqual(w.log.network, [], 'офлайн: ни одного обращения к сети');
});
