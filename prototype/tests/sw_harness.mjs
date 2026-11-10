// sw_harness.mjs — заглушка среды сервис-воркера для тестов (FP-12): настоящий текст demo/sw.js выполняется в vm-контексте с поддельными `self`, `caches`, `fetch`.
// «Сеть» — файлы prototype/ на диске (или подмена из теста), «кэш» — словарь в памяти. Браузера, сервера и сети нет. Только для тестов.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

export const PROTO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ORIGIN = 'http://localhost';
export const ROOT_PATH = '/01/301/runway/prototype/';
export const SW_URL = ORIGIN + ROOT_PATH + 'demo/sw.js';
export const SW_SOURCE = fs.readFileSync(path.join(PROTO, 'demo', 'sw.js'), 'utf8');

const TYPES = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

/** Файлы prototype/ по относительным путям: `Map<путь, Buffer>` (читаются с диска). */
export function read_files(paths) {
  const m = new Map();
  for (const p of paths) m.set(p, fs.readFileSync(path.join(PROTO, p)));
  return m;
}

/**
 * Поднять воркер в vm.
 * @param {{files?: Map<string, Buffer>, source?: string, sw_url?: string, origin_path?: string}} [opts]
 *   `files` — «сервер хоста» (путь от prototype/ → байты; по умолчанию пусто), `source` — текст воркера (по умолчанию настоящий sw.js)
 */
export function load_sw(opts = {}) {
  const sw_url = opts.sw_url ?? SW_URL;
  const server = opts.files ?? new Map();
  const listeners = {};
  const log = { skip_waiting: 0, claimed: 0, network: [], deleted: [] };
  const state = { online: true };
  const stores = new Map(); // имя кэша → Map(url → {status, headers, bytes})

  const to_url = (x) => (typeof x === 'string' ? new URL(x) : new URL(x.url));
  const store_entry = async (res) => ({ status: res.status, headers: [...res.headers.entries()], bytes: Buffer.from(await res.arrayBuffer()) });
  const revive = (e) => new Response(e.bytes, { status: e.status, headers: e.headers });
  const make_cache = (map) => ({
    async put(req, res) { map.set(to_url(req).href, await store_entry(res)); },
    async match(req) { const e = map.get(to_url(req).href); return e === undefined ? undefined : revive(e); },
    async keys() { return [...map.keys()].map((u) => new Request(u)); },
  });
  const caches = {
    async open(name) { if (!stores.has(name)) stores.set(name, new Map()); return make_cache(stores.get(name)); },
    async has(name) { return stores.has(name); },
    async keys() { return [...stores.keys()]; },
    async delete(name) { log.deleted.push(name); return stores.delete(name); },
    async match(req, o = {}) {
      const names = o.cacheName === undefined ? [...stores.keys()] : [o.cacheName];
      for (const n of names) { const e = stores.get(n)?.get(to_url(req).href); if (e !== undefined) return revive(e); }
      return undefined;
    },
  };
  const base_dir = new URL('../', sw_url);
  const network = async (req, init) => {
    const u = to_url(req);
    log.network.push(u.href);
    if (!state.online) throw new TypeError('Failed to fetch');
    if (u.origin !== base_dir.origin || !u.pathname.startsWith(base_dir.pathname)) return new Response('нет', { status: 404 });
    const rel = decodeURIComponent(u.pathname.slice(base_dir.pathname.length));
    const key = rel.endsWith('/') ? rel + 'index.html' : rel;
    const body = server.get(key);
    if (body === undefined) return new Response('нет', { status: 404 });
    return new Response(body, { status: 200, headers: { 'content-type': TYPES[path.extname(key)] ?? 'application/octet-stream' } });
  };
  const self = {
    location: new URL(sw_url),
    addEventListener(type, fn) { listeners[type] = fn; },
    skipWaiting() { log.skip_waiting += 1; },
    clients: { async claim() { log.claimed += 1; } },
  };
  const sandbox = { self, caches, fetch: network, Response, Request, URL, crypto: webcrypto, JSON, Promise, Error, TypeError, Array, Uint8Array, Object, String, Number };
  vm.runInNewContext(opts.source ?? SW_SOURCE, sandbox, { filename: 'sw.js' });

  /** Выполнить событие install/activate: вернуть `{ok, error}` после завершения `waitUntil`. */
  const lifecycle = async (type) => {
    let p = Promise.resolve();
    listeners[type]({ waitUntil(x) { p = x; } });
    try { await p; return { ok: true }; } catch (e) { return { ok: false, error: e }; }
  };
  /** Запрос страницы: `{handled, response}`; `handled=false`, если воркер не вмешался. */
  const request = async (url, init = {}) => {
    let responded = null;
    const ev = { request: new Request(url, init), respondWith(p) { responded = p; } };
    listeners.fetch(ev);
    return responded === null ? { handled: false } : { handled: true, response: await responded };
  };
  /** Сообщение воркеру; для `runway-status` возвращает ответ порта. */
  const message = async (data) => {
    const sent = [];
    const port = { postMessage(x) { sent.push(x); } };
    let p = Promise.resolve();
    listeners.message({ data, ports: [port], waitUntil(x) { p = x; } });
    await p;
    return sent;
  };
  return {
    listeners, log, state, stores, caches, self, lifecycle, request, message,
    install: () => lifecycle('install'),
    activate: () => lifecycle('activate'),
    cache_names: () => [...stores.keys()],
  };
}
