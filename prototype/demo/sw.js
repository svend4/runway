/* sw.js — сервис-воркер оболочки Runway (FP-12, REQ-117, REQ-120, REQ-154).
   Что делает: при установке читает demo/shell_manifest.json, скачивает каждый файл оболочки, сверяет sha256 и размер с манифестом и кладёт его
   в кэш `runway-shell-<первые 16 знаков хэша сборки>` (хэш сборки покрывает и текст самого воркера без штампа, поэтому правка логики воркера даёт новое имя кэша;
   при сбое установки удаляется только кэш, созданный этой установкой); дальше отвечает на запросы страницы из этого кэша, поэтому после первой загрузки оболочки
   основные сценарии работают без сети. Данных пользователя воркер не читает и не хранит; рантайм-кэша нет (в кэше только проверенная оболочка).
   Обновление без тихой подмены: новая версия устанавливается «в ожидании» и не вступает в силу, пока страница не пришлёт сообщение
   `runway-skip-waiting` (кнопка «Обновить» в «О программе»). Старые кэши с префиксом `runway-shell-` удаляются при активации; чужие кэши
   общего источника localhost и чужие воркеры не затрагиваются. Классический воркер без импортов: хэш сборки подставляет tools/build_manifest.mjs
   между метками BUILD:BEGIN и BUILD:END (руками не править). Область воркера — каталог demo/ внутри prototype/ (own_scope из «Удалить все данные»). */
'use strict';

/* BUILD:BEGIN */
const BUILD_HASH = '867a0b6b3823f2046f8e06bfcc00ecc9445d0a90ab180d78dfb4009e3db309e4';
/* BUILD:END */

const FORMAT = 'runway-shell/1';
const CACHE_PREFIX = 'runway-shell-';
const CACHE_NAME = CACHE_PREFIX + BUILD_HASH.slice(0, 16);
const SELF_PATH = 'demo/sw.js';
const TOP_DIRS = ['demo', 'engine', 'data'];
const MSG_SKIP = 'runway-skip-waiting';
const MSG_STATUS = 'runway-status';

/** Корень оболочки — каталог prototype/ (на уровень выше demo/), адрес манифеста хэшей — рядом с воркером. */
const ROOT_URL = new URL('../', self.location.href);
const MANIFEST_URL = new URL('shell_manifest.json', self.location.href).href;

/** Файлы для кэша: хэшируемые и штампованные, кроме самого воркера. */
function precache_paths(manifest) {
  return manifest.files.concat(manifest.stamped.filter(function (f) { return f.path !== SELF_PATH; }));
}

async function sha256_hex(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

/** Манифест того же хоста; хэш в нём должен совпадать со штампом воркера, иначе установка не пройдёт (перекос версий на хосте). */
async function load_manifest() {
  const res = await fetch(MANIFEST_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error('manifest_http');
  const m = await res.json();
  if (m === null || typeof m !== 'object' || m.format !== FORMAT || m.build_hash !== BUILD_HASH || !Array.isArray(m.files) || !Array.isArray(m.stamped)) throw new Error('manifest_mismatch');
  return m;
}

/** `run.created` — кэш с этим именем создала именно эта установка (а не работающая версия): при сбое удалять можно только такой. */
async function precache(run) {
  const manifest = await load_manifest();
  run.created = !(await caches.has(CACHE_NAME));
  const cache = await caches.open(CACHE_NAME);
  const list = precache_paths(manifest);
  for (let i = 0; i < list.length; i++) { // по одному: меньше памяти и понятный порядок отказа
    const f = list[i];
    const url = new URL(f.path, ROOT_URL).href;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('file_http');
    const body = await res.clone().arrayBuffer();
    if (body.byteLength !== f.bytes || (await sha256_hex(body)) !== f.sha256) throw new Error('file_hash');
    await cache.put(url, res);
  }
  await cache.put(MANIFEST_URL, new Response(JSON.stringify(manifest), { headers: { 'content-type': 'application/json' } }));
}

self.addEventListener('install', function (event) {
  const run = { created: false };
  event.waitUntil(precache(run).catch(async function (e) {
    // недокачанный кэш не оставляем, но только свой: кэш, который уже был до этой установки, обслуживает работающую версию
    if (run.created) await caches.delete(CACHE_NAME);
    throw e;
  }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    const names = await caches.keys();
    await Promise.all(names.filter(function (n) { return n.startsWith(CACHE_PREFIX) && n !== CACHE_NAME; }).map(function (n) { return caches.delete(n); }));
    await self.clients.claim();
  })());
});

/** Ключ кэша для запроса страницы: адрес без query и якоря внутри demo/, engine/ или data/; `…/demo/` — это index.html. Иначе `null` (запрос не наш). */
function shell_key(url) {
  if (url.origin !== ROOT_URL.origin || !url.pathname.startsWith(ROOT_URL.pathname)) return null;
  let rel = url.pathname.slice(ROOT_URL.pathname.length);
  if (rel === 'demo') rel = 'demo/';
  if (rel.endsWith('/')) rel += 'index.html';
  if (TOP_DIRS.indexOf(rel.split('/')[0]) < 0) return null;
  return new URL(rel, ROOT_URL).href;
}

async function answer(request, key) {
  const hit = await caches.match(key, { cacheName: CACHE_NAME });
  if (hit !== undefined) return hit;
  return fetch(request); // нет в кэше (файл вне оболочки или кэш неполон): обычный запрос; в офлайне он завершится ошибкой, а не подменой ответа
}

self.addEventListener('fetch', function (event) {
  const request = event.request;
  if (request.method !== 'GET') return;
  const key = shell_key(new URL(request.url));
  if (key === null) return;
  event.respondWith(answer(request, key));
});

async function status() {
  let cached = 0;
  let total = 0;
  try {
    if (await caches.has(CACHE_NAME)) {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(MANIFEST_URL);
      if (hit !== undefined) {
        const manifest = await hit.json();
        const wanted = precache_paths(manifest).map(function (f) { return new URL(f.path, ROOT_URL).href; });
        total = wanted.length;
        for (let i = 0; i < wanted.length; i++) if ((await cache.match(wanted[i])) !== undefined) cached += 1;
      }
    }
  } catch (e) { /* ответ «0 из 0» честнее, чем падение */ }
  return { type: MSG_STATUS, format: FORMAT, build: BUILD_HASH, cache: CACHE_NAME, cached: cached, total: total };
}

self.addEventListener('message', function (event) {
  const d = event.data;
  if (d === null || typeof d !== 'object') return;
  if (d.type === MSG_SKIP) { self.skipWaiting(); return; }
  if (d.type === MSG_STATUS && event.ports && event.ports[0]) {
    const port = event.ports[0];
    event.waitUntil(status().then(function (s) { port.postMessage(s); }));
  }
});
