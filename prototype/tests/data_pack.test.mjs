// data_pack.test.mjs — пакет FP-05 на реестре расширений и заглушке DOM: подключение через register(ext), блоки экрана «Данные», показ «будет удалено N…»,
// квитанция, выбор хранилища в make_runtime (фейк IndexedDB). REQ-098, REQ-122, REQ-125, TST-56. Браузер не нужен.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// ── заглушка DOM (минимальная: тот же приём, что в tests/ext_boot.test.mjs) ───────────────────────────────────────────────
class Node_ {
  constructor(tag) { this.nodeType = 1; this.tagName = tag; this.attrs = {}; this.children = []; this.listeners = {}; this.className = ''; this._text = ''; this.open = false; }
  get textContent() { return this.children.length === 0 ? this._text : this.children.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  append(...kids) { for (const k of kids) this.children.push(k); this._text = ''; }
  replaceChildren(...kids) { this.children = []; this._text = ''; this.append(...kids); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  querySelectorAll() { return []; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  walk(fn) { fn(this); for (const c of this.children) if (c.nodeType === 1) c.walk(fn); }
}
const byid = new Map();
for (const id of ['dlg', 'dlg-title', 'dlg-close', 'dlg-body', 'live']) byid.set(id, new Node_(id === 'dlg' ? 'dialog' : 'div'));
globalThis.document = {
  createElement: (t) => new Node_(t), createElementNS: (_ns, t) => new Node_(t), createTextNode: (data) => ({ nodeType: 3, data }),
  getElementById: (id) => byid.get(id) ?? null, head: new Node_('head'), body: new Node_('body'),
};

const { create_ext } = await import('../demo/ext.mjs');
const { make_runtime, browser_env, register } = await import('../demo/pack_fp05.mjs');
const { fake_idb } = await import('./fake_idb.mjs');
const { DB_NAME } = await import('../demo/store_idb.mjs');
const { apply_edit } = await import('../demo/ws_edit.mjs');
const { analyze } = await import('../engine/index.mjs');

const G001 = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../data/g001.json', import.meta.url)), 'utf8'));
const find = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const button = (root, text) => find(root, (n) => n.tagName === 'button' && n.textContent === text)[0];

/** Реестр с пакетом FP-05 и страницей-заглушкой. */
async function booted(ws = JSON.parse(JSON.stringify(G001))) {
  const page = { ws, renders: 0 };
  const ext = create_ext({ loaders: { pack_fp05: () => import('../demo/pack_fp05.mjs') } });
  ext.bind_host({
    get_ws: () => page.ws, get_model: () => null, lang: () => 'ru', mode: () => 'worse', fmt: () => null,
    set_ws: (w) => { page.ws = w; return { ok: true }; }, render: () => { page.renders += 1; }, notify: (m) => { page.notice = m; },
  });
  await ext.load_packs();
  return { ext, page };
}

/** Каталог строк пакета регистрируется один раз на процесс (как в приложении), поэтому реестр с пакетом общий для тестов этого файла. */
let SHARED = null;
const shared = async () => (SHARED ??= await booted());

test('REQ-122 пакет FP-05 подключается через register(ext): строки data.* в каталоге, до запуска блоков нет, после boot-хука блоки экрана «Данные» на месте', async () => {
  const { ext, page } = await shared();
  assert.ok(ext.diagnostics().some((d) => d.pack === 'pack_fp05' && d.status === 'ok'), 'пакет загружен: ' + JSON.stringify(ext.diagnostics()));
  assert.equal(ext.ctx.tr('data.storage_title'), 'Хранение и файл-копия');
  assert.deepEqual(ext.slot_nodes('data.sections'), [], 'до запуска хранилища блоков нет (нет данных о хранилище)');
  await ext.run('boot');
  const nodes = ext.slot_nodes('data.sections');
  const text = nodes.map((n) => n.textContent).join('\n');
  for (const need of ['Хранение и файл-копия', 'Где что лежит', 'Удалить все данные', 'Скачать журнал', 'Скачать CSV', 'Скачать hledger', 'Восстановить из файла']) assert.ok(text.includes(need), 'нет «' + need + '»');
  // список потерь формата показан (для G-001: правила, потоки, сценарии…)
  assert.ok(text.includes('В CSV попадают только операции. Не попадёт в файл:'));
  assert.ok(text.includes('правила повторов (4)'), 'число правил G-001');
  assert.ok(text.includes('в виде разовых правил на горизонт'), 'для hledger правила материализуются');
  // отчёт «где что лежит» вычислен из состояния: в Node нет закрепления хранилища → «не сообщил», хранилище — память
  assert.ok(text.includes('Только в памяти открытой вкладки'));
  assert.ok(text.includes('Браузер не сообщил, закреплено ли хранилище'));
  assert.ok(text.includes('Файл-копия ещё не скачивалась') && text.includes('копии нет'));
  // баннер «сделайте файл-копию»: данные только в памяти вкладки
  const banner = ext.slot_nodes('overview.cards').map((n) => n.textContent).join('\n');
  assert.ok(banner.includes('Файл-копия данных') && banner.includes('только в памяти этой вкладки'));
  assert.ok(!text.includes('безопасно'));
  assert.ok(page.renders <= 1, 'пакет перерисовывает страницу только через ctx.refresh (без записи и без рассылки подписчикам), не чаще одного раза на запуск: ' + page.renders);
});

test('REQ-098 «Удалить все данные»: диалог показывает «будет удалено N операций, M правил, K сценариев» по G-001, квитанция с датой, счётчиками и предупреждением о копиях', async () => {
  const { ext } = await shared();
  const erase_section = ext.slot_nodes('data.sections').find((n) => n.attrs.id === 'fp05-erase');
  assert.ok(erase_section !== undefined);
  assert.ok(erase_section.textContent.includes(`Сейчас на странице: ${G001.facts.length} операций, ${G001.rules.length} правил, ${G001.scenarios.length} сценариев.`));
  button(erase_section, 'Удалить все данные…').listeners.click[0]();
  const dlg_text = byid.get('dlg-body').textContent;
  assert.ok(dlg_text.includes(`Будет удалено: ${G001.facts.length} операций, ${G001.rules.length} правил, ${G001.scenarios.length} сценариев.`), dlg_text);
  assert.ok(dlg_text.includes('Файлы-копии, которые вы скачивали, остаются у вас'));
  assert.equal(byid.get('dlg-title').textContent, 'Удалить все данные на этом устройстве');
  await button(byid.get('dlg-body'), 'Удалить без возврата').listeners.click[0]();
  const receipt = byid.get('dlg-body').textContent;
  assert.equal(byid.get('dlg-title').textContent, 'Квитанция об удалении');
  assert.match(receipt, /Данные на этом устройстве удалены\. Дата: \d{4}-\d{2}-\d{2}\./);
  assert.ok(receipt.includes(`Будет удалено: ${G001.facts.length} операций`), 'счётчики в квитанции');
  assert.ok(receipt.includes('Хранилище журнала') && receipt.includes('очищено'));
  assert.ok(receipt.includes('Файлы-копии, которые вы скачивали, остаются у вас'), 'предупреждение о копиях — всегда');
});

test('REQ-122 make_runtime: IndexedDB выбирается первой; правка попадает в базу, переоткрытие видит сохранённое и продолжает с того же расчёта; закрепление запрошено', async () => {
  const f = fake_idb();
  let asked = 0;
  const env = {
    indexedDB: f.factory, IDBKeyRange: f.IDBKeyRange, localStorage: null, sessionStorage: null, caches: null,
    navigator: { storage: { persisted: async () => false, persist: async () => { asked += 1; return true; } } },
  };
  const page = { ws: JSON.parse(JSON.stringify(G001)) };
  const ctx = { new_id: (p) => p + '_0123456789ab', get_ws: () => page.ws, set_ws: (w) => { page.ws = w; return { ok: true }; } };
  const rt = await make_runtime(ctx, env);
  const s0 = await rt.init();
  assert.equal(s0.store_kind, 'idb');
  assert.equal(s0.mode, 'fresh');
  assert.equal(asked, 1, 'navigator.storage.persist() запрошен');
  assert.equal(s0.persisted, true);
  const r = apply_edit(page.ws, { type: 'add_fact', fact: { event_id: 'u_1', account_id: 'acc_main', date: '2026-10-03', amount_minor: -250, currency: 'EUR', tag: 'x' } }, { new_id: (p) => p + '_x' });
  assert.ok(r.ok);
  page.ws = r.ws;
  await rt.on_change({ reason: 'add_fact', ws: r.ws });
  assert.equal(rt.status().mode, 'active');
  assert.ok(f.rows(DB_NAME, 'events') > 40, 'записи в IndexedDB');
  // «после перезагрузки»
  const page2 = { ws: JSON.parse(JSON.stringify(G001)) };
  const ctx2 = { new_id: (p) => p + '_ba9876543210', get_ws: () => page2.ws, set_ws: (w) => { page2.ws = w; return { ok: true }; } };
  const rt2 = await make_runtime(ctx2, env);
  assert.equal((await rt2.init()).mode, 'found');
  assert.equal((await rt2.continue_saved()).ok, true);
  assert.equal(analyze(page2.ws, { as_of: r.ws.as_of }).inputs_hash, analyze(r.ws, { as_of: r.ws.as_of }).inputs_hash);
  // удаление: база снята
  const receipt = await rt2.erase();
  assert.equal(receipt.erased, true);
  assert.equal(f.dbs.has(DB_NAME), false);
});

test('REQ-122 browser_env и register: в Node нет IndexedDB и localStorage → память; register возвращает держатель среды', () => {
  const env = browser_env();
  assert.equal(env.indexedDB, null);
  assert.equal(typeof register, 'function');
});
