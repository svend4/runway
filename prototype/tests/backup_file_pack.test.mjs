// backup_file_pack.test.mjs — пакет FP-05 на реестре расширений: блок автозаписи в файл-копию встаёт в раздел хранения (FP-19, REQ-097, TST-56).
// Отдельный файл: каталоги строк пакета регистрируются один раз на процесс (как в приложении), а tests/backup_file_boot.test.mjs регистрирует их сам для проверки экрана.
// Заглушка DOM — тот же приём, что в tests/data_pack.test.mjs. Браузер не нужен.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

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
const { make_runtime, browser_env } = await import('../demo/pack_fp05.mjs');

const G001 = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../data/g001.json', import.meta.url)), 'utf8'));
const find = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };

test('REQ-097 пакет FP-05: строки backupfile.* зарегистрированы, блок автозаписи — в разделе хранения; в Node (нет выбора файла) кнопка отключена, ограничение названо', async () => {
  const page = { ws: JSON.parse(JSON.stringify(G001)) };
  const ext = create_ext({ loaders: { pack_fp05: () => import('../demo/pack_fp05.mjs') } });
  ext.bind_host({
    get_ws: () => page.ws, get_model: () => null, lang: () => 'ru', mode: () => 'worse', fmt: () => null, set_ws: (w) => { page.ws = w; return { ok: true }; },
    render: () => {}, notify: () => {},
  });
  await ext.load_packs();
  assert.ok(ext.diagnostics().some((d) => d.pack === 'pack_fp05' && d.status === 'ok'), JSON.stringify(ext.diagnostics()));
  assert.equal(ext.ctx.tr('backupfile.pick'), 'Выбрать файл-копию');
  assert.equal(ext.ctx.tr('data.store_name_file_target'), 'Ссылка на выбранный файл-копию');
  await ext.run('boot');
  const sec = ext.slot_nodes('data.sections').find((n) => n.attrs.id === 'fp05-storage');
  assert.ok(sec !== undefined);
  const text = sec.textContent;
  assert.ok(text.includes('Автозапись в файл-копию'));
  assert.ok(text.includes('Поведение Safari и iOS не проверялось'));
  const pick = find(sec, (n) => n.attrs.id === 'fp19-pick')[0];
  assert.equal(pick.textContent, 'Выбрать файл-копию');
  assert.equal(pick.attrs.disabled, '', 'в Node нет showSaveFilePicker: выбор недоступен');
  assert.equal(browser_env().file_api, null);
});

test('REQ-097 make_runtime без IndexedDB и без выбора файла: хранилище — память, автозапись недоступна, база ссылок не создаётся', async () => {
  const page = { ws: JSON.parse(JSON.stringify(G001)) };
  const ctx = { new_id: (p) => p + '_0123456789ab', get_ws: () => page.ws, set_ws: (w) => { page.ws = w; return { ok: true }; } };
  const rt = await make_runtime(ctx, { indexedDB: null, IDBKeyRange: null, localStorage: null, sessionStorage: null, caches: null, navigator: null });
  const s = await rt.init();
  assert.deepEqual([s.store_kind, s.file.supported, s.file.phase], ['memory', false, 'unsupported']);
  assert.deepEqual(await rt.file_pick(), { ok: false, reason: 'unsupported' });
});
