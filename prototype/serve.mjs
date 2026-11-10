// serve.mjs — мини-сервер статики для демо Runway (node:http, без зависимостей).
// Запуск: `node serve.mjs` → http://localhost:8787/demo/ (корень — каталог prototype/). Для XAMPP сервер не нужен:
// http://localhost/01/301/runway/prototype/demo/. Раздаются только `demo/`, `engine/` и `data/` (страница читает движок и наборы
// G-001 как ES-модули и JSON); слушает только 127.0.0.1; методы GET/HEAD; выход за корень (`..`, `%2e%2e`, NUL) — 400/403/404.
// Файл не входит в `engine/` (там нет node:*), поэтому `node:http` и `node:fs` здесь допустимы.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Порт демо. */
export const PORT = 8787;

/** Корень — каталог `prototype/` (рядом с этим файлом). */
export const ROOT = path.dirname(fileURLToPath(import.meta.url));

/** Каталоги, которые видны снаружи. */
export const PUBLIC_DIRS = Object.freeze(['demo', 'engine', 'data']);

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', // манифест PWA (FP-12); под Apache тип задаёт demo/.htaccess
});

// manifest-src и worker-src — единственное расширение политики в FP-12 (манифест приложения и свой сервис-воркер/воркер расчёта); внешних источников нет.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * Путь запроса → файл на диске внутри `root` (или `null`, если выходит за корень или в закрытый каталог).
 * @param {string} root абсолютный корень
 * @param {string} url_path путь из URL (с процентным кодированием, без query)
 * @returns {{file: string}|{status: 400|403|404}}
 */
export function resolve_path(root, url_path) {
  let decoded;
  try {
    decoded = decodeURIComponent(url_path);
  } catch {
    return { status: 400 };
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return { status: 400 };
  const parts = decoded.split('/').filter((p) => p !== '');
  if (parts.some((p) => p === '..' || p === '.')) return { status: 403 };
  if (parts.length === 0 || !PUBLIC_DIRS.includes(parts[0])) return { status: 404 };
  const file = path.resolve(root, ...parts);
  if (file !== root && !file.startsWith(root + path.sep)) return { status: 403 };
  return { file };
}

/**
 * Создать HTTP-сервер статики.
 * @param {string} [root] корень (по умолчанию `prototype/`)
 * @returns {http.Server}
 */
export function create_server(root = ROOT) {
  const base = path.resolve(root);
  return http.createServer((req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method Not Allowed', { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    const url_path = (req.url ?? '/').split('?')[0].split('#')[0];
    if (url_path === '/' || url_path === '') return send(302, '', { Location: '/demo/' });
    const r = resolve_path(base, url_path);
    if ('status' in r) return send(r.status, 'Error ' + r.status, { 'Content-Type': 'text/plain; charset=utf-8' });
    let file = r.file;
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      const real = fs.realpathSync(file);
      if (!real.startsWith(fs.realpathSync(base) + path.sep)) return send(403, 'Error 403', { 'Content-Type': 'text/plain; charset=utf-8' });
      const body = fs.readFileSync(real);
      const ext = path.extname(real).toLowerCase();
      const headers = { 'Content-Type': MIME[ext] ?? 'application/octet-stream' };
      if (ext === '.html') headers['Content-Security-Policy'] = CSP;
      return send(200, body, headers);
    } catch {
      return send(404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
  });
}

const is_main = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (is_main) {
  const port = Number(process.env.PORT ?? PORT);
  create_server().listen(port, '127.0.0.1', () => {
    process.stdout.write('Runway demo: http://localhost:' + port + '/demo/  (Ctrl+C — остановить)\n'); // не console: тест REQ-124 запрещает вызовы console.* в engine/, cli.mjs и serve.mjs (вывод — только адрес, без данных)
  });
}
