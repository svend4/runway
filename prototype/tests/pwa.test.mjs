// pwa.test.mjs — FP-12, PWA: манифест приложения, CSP и MIME, регистрация воркера только на localhost/HTTPS в своей области, настоящий demo/sw.js в vm
// (установка с проверкой хэшей, активация только своих кэшей, ответы из кэша без сети, обновление без тихой подмены), «Удалить все данные» не трогает чужие воркеры и кэши.
// REQ-117 (PWA: установка и офлайн), REQ-120 (после загрузки оболочки сети нет), REQ-154 (хэши), решение владельца № 4 (предварительное), урок UI-2 (общий localhost).
// Браузера нет: воркер — vm-заглушка (tests/sw_harness.mjs), навигатор и регистрации — подделки; сервер поднимается на один запрос и гасится.
// Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PROTO, SW_SOURCE, read_files, load_sw, ORIGIN, ROOT_PATH } from './sw_harness.mjs';

const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);
const read = (...p) => fs.readFileSync(path.join(PROTO, ...p), 'utf8');
const PWA = await imp('demo', 'pwa.mjs');
const BM = await imp('tools', 'build_manifest.mjs');
const DA = await imp('demo', 'data_actions.mjs');
const SERVE = await imp('serve.mjs');
const MANIFEST = JSON.parse(read('demo', 'shell_manifest.json'));
const LIST = BM.precache_list(MANIFEST);
const CACHE = 'runway-shell-' + MANIFEST.build_hash.slice(0, 16);
const DEMO_URL = ORIGIN + ROOT_PATH + 'demo/';
const OWN_SCOPE = ORIGIN + ROOT_PATH;

const plain = (x) => JSON.parse(JSON.stringify(x)); // объекты из vm-контекста имеют чужой прототип
const csp_of = (html) => /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';
const csp_map = (csp) => Object.fromEntries(csp.split(';').map((s) => s.trim()).filter(Boolean).map((d) => { const [name, ...vals] = d.split(/\s+/); return [name, vals.join(' ')]; }));

// ── манифест приложения, страница, CSP, MIME ─────────────────────────────────────────────────────────────────────────

test('REQ-117 манифест приложения: имя, область и start_url внутри demo/, иконки — SVG-файлы рядом (бинарных нет), цвета совпадают с токенами светлой темы style.css', () => {
  const m = JSON.parse(read('demo', 'manifest.webmanifest'));
  assert.equal(m.name.startsWith('Runway'), true);
  assert.equal(m.short_name, 'Runway');
  assert.equal(m.display, 'standalone');
  assert.equal(m.scope, './');
  assert.equal(m.start_url, './index.html');
  assert.ok(fs.existsSync(path.join(PROTO, 'demo', m.start_url)), 'start_url существует');
  assert.ok(m.icons.length >= 2 && m.icons.some((i) => i.purpose === 'maskable') && m.icons.some((i) => i.purpose === 'any'));
  for (const i of m.icons) {
    assert.equal(i.type, 'image/svg+xml');
    assert.equal(path.extname(i.src), '.svg');
    const f = path.join(PROTO, 'demo', i.src);
    assert.ok(fs.existsSync(f), 'иконка ' + i.src);
    const svg = fs.readFileSync(f, 'utf8');
    assert.match(svg, /^<svg\b/);
    assert.ok(!/<script|on[a-z]+\s*=|href\s*=|<image|<foreignObject/i.test(svg), 'в иконке нет скриптов, обработчиков и внешних ссылок');
  }
  const css = read('demo', 'style.css');
  const light = /:root\s*\{([^}]*)\}/.exec(css)[1];
  const tok = (name) => new RegExp('--' + name + ':\\s*(#[0-9a-fA-F]{6})').exec(light)[1].toLowerCase();
  assert.equal(m.background_color.toLowerCase(), tok('bg'));
  assert.equal(m.theme_color.toLowerCase(), tok('accent'));
  const dir = path.join(PROTO, 'demo', 'icons');
  for (const f of fs.readdirSync(dir)) assert.equal(path.extname(f), '.svg', 'в demo/icons только SVG: ' + f);
  const html = read('demo', 'index.html');
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(html, /<meta name="theme-color" content="#1f5fbf">/);
  assert.equal(m.theme_color.toLowerCase(), '#1f5fbf');
});

test('решение № 4 CSP: к прежней политике добавлены только manifest-src и worker-src со значением \'self\'; в meta страницы и в заголовке serve.mjs директивы одинаковы; внешних источников нет', () => {
  const page = csp_map(csp_of(read('demo', 'index.html')));
  const served = csp_map(/const CSP = "([^"]+)"/.exec(read('serve.mjs'))[1]);
  const before = { 'default-src': "'none'", 'script-src': "'self'", 'style-src': "'self'", 'img-src': "'self' data:", 'connect-src': "'self'", 'base-uri': "'none'", 'form-action': "'none'" };
  assert.deepEqual(page, { ...before, 'manifest-src': "'self'", 'worker-src': "'self'" });
  assert.deepEqual(served, { ...page, 'frame-ancestors': "'none'" }, 'заголовок сервера = мета + frame-ancestors');
  for (const csp of [page, served]) assert.ok(!/unsafe|\*|https?:/.test(Object.values(csp).join(' ')));
  // v0.html без сети и без воркера: политика прежняя
  const v0 = csp_map(csp_of(read('demo', 'v0.html')));
  assert.equal(v0['connect-src'], "'none'");
  assert.ok(!('worker-src' in v0) && !('manifest-src' in v0), 'v0.html не просит ни воркера, ни манифеста');
});

test('решение № 4 MIME: serve.mjs отдаёт .webmanifest и sw.js с верными типами и CSP на страницу; .htaccess задаёт тип манифеста для Apache и не ломается без mod_headers', async () => {
  assert.equal(SERVE.PUBLIC_DIRS.join(), 'demo,engine,data', 'публичные каталоги прежние');
  const server = SERVE.create_server();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address();
    const get = async (p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, type: r.headers.get('content-type'), csp: r.headers.get('content-security-policy'), body: Buffer.from(await r.arrayBuffer()) }; };
    const man = await get('/demo/manifest.webmanifest');
    assert.equal(man.status, 200);
    assert.match(man.type, /^application\/manifest\+json/);
    assert.deepEqual(JSON.parse(man.body.toString('utf8')), JSON.parse(read('demo', 'manifest.webmanifest')));
    const sw = await get('/demo/sw.js');
    assert.equal(sw.status, 200);
    assert.match(sw.type, /^text\/javascript/);
    assert.equal(sw.body.toString('utf8'), SW_SOURCE);
    const icon = await get('/demo/icons/icon.svg');
    assert.equal(icon.type, 'image/svg+xml');
    const page = await get('/demo/');
    assert.match(page.csp, /manifest-src 'self'/);
    assert.match(page.csp, /worker-src 'self'/);
  } finally {
    await new Promise((r) => server.close(r));
  }
  const ht = read('demo', '.htaccess');
  assert.match(ht, /^AddType application\/manifest\+json \.webmanifest$/m);
  assert.equal((ht.match(/<IfModule mod_headers\.c>/g) ?? []).length, 1);
  assert.equal((ht.match(/<\/IfModule>/g) ?? []).length, 1, 'блок IfModule закрыт: без mod_headers Apache не отвечает 500');
  assert.equal((ht.match(/<FilesMatch/g) ?? []).length, (ht.match(/<\/FilesMatch>/g) ?? []).length);
  assert.ok(!/^\s*(Header|RewriteRule|Require|Deny|Allow)\b/m.test(ht.replace(/<IfModule[\s\S]*<\/IfModule>/, '')), 'вне IfModule нет директив, зависящих от модулей');
});

// ── регистрация: только localhost/HTTPS и только в своей области ────────────────────────────────────────────────────────

test('решение № 4 is_secure_origin: https и петля localhost (127.0.0.1, [::1], *.localhost) — да; http по адресу в сети, file:, пустое — нет', () => {
  const ok = (protocol, hostname) => PWA.is_secure_origin({ protocol, hostname });
  assert.equal(ok('https:', 'example.org'), true);
  assert.equal(ok('http:', 'localhost'), true);
  assert.equal(ok('http:', 'LOCALHOST'), true);
  assert.equal(ok('http:', '127.0.0.1'), true);
  assert.equal(ok('http:', '[::1]'), true);
  assert.equal(ok('http:', 'app.localhost'), true);
  assert.equal(ok('http:', '192.168.1.20'), false);
  assert.equal(ok('http:', 'example.org'), false);
  assert.equal(ok('http:', 'localhost.evil.example'), false);
  assert.equal(ok('http:', 'notlocalhost'), false);
  assert.equal(ok('file:', ''), false);
  assert.equal(ok('ftp:', 'localhost'), false);
  assert.equal(PWA.is_secure_origin(null), false);
  assert.equal(PWA.is_secure_origin(undefined), false);
  assert.equal(PWA.is_secure_origin({}), false);
});

function fake_worker(state = 'activated') {
  const w = { state, posted: [], listeners: {}, postMessage(msg, transfer) { w.posted.push({ msg, transfer }); w.on_post?.(msg, transfer); }, addEventListener(t, fn) { (w.listeners[t] ??= []).push(fn); } };
  return w;
}
function fake_env({ controller = null, waiting = null, active = fake_worker(), fail = null, location = { protocol: 'http:', hostname: 'localhost' }, base_url = DEMO_URL + 'pwa.mjs', own_scope } = {}) {
  const reg = { active, waiting, installing: null, listeners: {}, updates: 0, update_fail: false, addEventListener(t, fn) { (reg.listeners[t] ??= []).push(fn); }, async update() { reg.updates += 1; if (reg.update_fail) throw new Error('offline'); } };
  const sw = { controller, calls: [], listeners: {}, async register(url, opts) { sw.calls.push({ url, opts }); if (fail !== null) throw fail; return reg; }, addEventListener(t, fn) { (sw.listeners[t] ??= []).push(fn); } };
  // другие регистрации того же источника pwa.mjs трогать не вправе: обращение к ним — ошибка теста
  Object.defineProperty(sw, 'getRegistrations', { get() { throw new Error('pwa.mjs не должен перечислять чужие регистрации'); } });
  const channels = [];
  const reloads = [];
  const timers = [];
  const env = {
    navigator: { serviceWorker: sw }, location, base_url, reload: () => reloads.push(1),
    message_channel: () => { const ch = { port1: { onmessage: null }, port2: { id: channels.length } }; channels.push(ch); return ch; },
    set_timeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clear_timeout: () => {},
  };
  if (own_scope !== undefined) env.own_scope = own_scope;
  return { env, reg, sw, channels, reloads, timers, active };
}

test('решение № 4 create_pwa: на http по адресу в сети, без сервис-воркеров и вне своей области регистрации НЕТ (register не вызывается); причины названы кодом', async () => {
  const a = fake_env({ location: { protocol: 'http:', hostname: '192.168.1.20' } });
  const pa = PWA.create_pwa(a.env);
  assert.deepEqual(await pa.start(), { ...pa.snapshot() });
  assert.equal(pa.snapshot().status, 'unsupported');
  assert.equal(pa.snapshot().reason, 'insecure_origin');
  assert.equal(a.sw.calls.length, 0);

  const b = fake_env();
  b.env.navigator = {};
  const pb = PWA.create_pwa(b.env);
  await pb.start();
  assert.equal(pb.snapshot().reason, 'no_service_worker');

  const c = fake_env({ own_scope: 'http://localhost/01/301/runway/other/' });
  const pc = PWA.create_pwa(c.env);
  await pc.start();
  assert.equal(pc.snapshot().reason, 'bad_scope');
  assert.equal(c.sw.calls.length, 0, 'область вне own_scope: не регистрируем');

  const d = fake_env({ location: null });
  await PWA.create_pwa(d.env).start();
  assert.equal(d.sw.calls.length, 0);
  // в Node без браузера модуль сообщает «не поддерживается» и не бросает исключение
  const bare = PWA.create_pwa({ navigator: null, location: null });
  assert.equal((await bare.start()).status, 'unsupported');
});

test('решение № 4 create_pwa: регистрация одна, адрес воркера — demo/sw.js, область — demo/ (внутри prototype/, то есть своя для «Удалить все данные»), классический воркер, updateViaCache none', async () => {
  const e = fake_env();
  const pwa = PWA.create_pwa(e.env);
  await pwa.start();
  await pwa.start(); // повторный запуск ничего не делает
  assert.equal(e.sw.calls.length, 1);
  assert.equal(e.sw.calls[0].url, DEMO_URL + 'sw.js');
  assert.deepEqual(e.sw.calls[0].opts, { scope: DEMO_URL, type: 'classic', updateViaCache: 'none' });
  assert.equal(pwa.snapshot().status, 'active');
  assert.ok(PWA.scope_is_own(e.sw.calls[0].opts.scope, OWN_SCOPE));
  assert.equal(PWA.scope_is_own(ORIGIN + '/01/301/runway/prototype-other/', OWN_SCOPE), false, 'соседний каталог с общим началом имени — не своя область');
  assert.equal(PWA.scope_is_own(ORIGIN + '/01/50/', OWN_SCOPE), false);
  // в настоящем размещении pwa.mjs область считается от import.meta.url модуля
  const real = PWA.create_pwa({ navigator: { serviceWorker: { register: async () => ({}), addEventListener() {} } }, location: { protocol: 'http:', hostname: 'localhost' } });
  assert.match(real.snapshot().scope, /\/demo\/$/);
  assert.match(real.snapshot().sw_url, /\/demo\/sw\.js$/);
  // регистрация отказала (политика, тип файла): состояние «ошибка» с именем исключения, без текста, без исключения наружу
  const bad = fake_env({ fail: Object.assign(new Error('секретный текст'), { name: 'SecurityError' }) });
  const pb = PWA.create_pwa(bad.env);
  await pb.start();
  assert.equal(pb.snapshot().status, 'error');
  assert.equal(pb.snapshot().reason, 'SecurityError');
  assert.ok(!JSON.stringify(pb.snapshot()).includes('секретный'));
});

test('REQ-117 обновление без тихой подмены: ожидающая версия не применяется сама; «Обновить» шлёт сообщение ожидающему воркеру и перезагружает страницу ровно один раз; без нажатия перезагрузки нет', async () => {
  const waiting = fake_worker('installed');
  const e = fake_env({ controller: fake_worker(), waiting });
  const pwa = PWA.create_pwa(e.env);
  const seen = [];
  pwa.subscribe((s) => seen.push(s.status));
  await pwa.start();
  assert.equal(pwa.snapshot().status, 'update_ready');
  assert.ok(seen.includes('update_ready'));
  // смена управляющего воркера без нажатия (другая вкладка применила обновление): страница не перезагружается
  for (const fn of e.sw.listeners.controllerchange ?? []) fn();
  assert.equal(e.reloads.length, 0);
  assert.equal(waiting.posted.length, 0, 'без нажатия ожидающему воркеру ничего не отправлено');
  assert.equal(pwa.apply_update(), true);
  assert.deepEqual(waiting.posted.map((p) => p.msg), [{ type: PWA.MSG_SKIP }]);
  assert.equal(e.reloads.length, 0, 'перезагрузка — когда новый воркер возьмёт управление');
  for (const fn of e.sw.listeners.controllerchange ?? []) fn();
  for (const fn of e.sw.listeners.controllerchange ?? []) fn();
  assert.equal(e.reloads.length, 1, 'ровно одна перезагрузка');
  // нет ожидающей версии — применять нечего
  const none = fake_env({ controller: fake_worker() });
  const p2 = PWA.create_pwa(none.env);
  await p2.start();
  assert.equal(p2.snapshot().status, 'active');
  assert.equal(p2.apply_update(), false);
});

test('REQ-117 первая установка не предлагает «Обновить»; найденное обновление (updatefound → installed при уже управляющем воркере) предлагает; сбой установки не меняет версию', async () => {
  const first = fake_env({ controller: null });
  const p1 = PWA.create_pwa(first.env);
  await p1.start();
  const w1 = fake_worker('installing');
  first.reg.installing = w1;
  for (const fn of first.reg.listeners.updatefound ?? []) fn();
  w1.state = 'installed';
  for (const fn of w1.listeners.statechange ?? []) fn();
  assert.equal(p1.snapshot().status, 'active', 'без прежнего воркера обновлять нечего');

  const upd = fake_env({ controller: fake_worker() });
  const p2 = PWA.create_pwa(upd.env);
  await p2.start();
  assert.equal(p2.snapshot().status, 'active');
  const w2 = fake_worker('installing');
  upd.reg.installing = w2;
  for (const fn of upd.reg.listeners.updatefound ?? []) fn();
  upd.reg.waiting = w2;
  w2.state = 'installed';
  for (const fn of w2.listeners.statechange ?? []) fn();
  assert.equal(p2.snapshot().status, 'update_ready');

  const fail = fake_env({ controller: fake_worker() });
  const p3 = PWA.create_pwa(fail.env);
  await p3.start();
  const w3 = fake_worker('installing');
  fail.reg.installing = w3;
  for (const fn of fail.reg.listeners.updatefound ?? []) fn();
  w3.state = 'redundant';
  for (const fn of w3.listeners.statechange ?? []) fn();
  assert.equal(p3.snapshot().status, 'active');
  assert.equal(p3.snapshot().reason, 'install_failed');
});

test('REQ-120 check_update — единственный сетевой повод модуля: reg.update() на собственном хосте; при сбое сети состояние не ломается', async () => {
  const e = fake_env({ controller: fake_worker() });
  const pwa = PWA.create_pwa(e.env);
  await pwa.start();
  const s = await pwa.check_update();
  assert.equal(e.reg.updates, 1);
  assert.equal(s.status, 'active');
  e.reg.update_fail = true;
  const s2 = await pwa.check_update();
  assert.equal(e.reg.updates, 2);
  assert.equal(s2.status, 'active', 'сеть недоступна — остаёмся на текущей версии');
  const idle = PWA.create_pwa(fake_env().env);
  assert.equal((await idle.check_update()).status, 'idle', 'до start проверять нечего');
});

test('REQ-117 состояние офлайн-копии: воркер отвечает на runway-status через MessageChannel; нет ответа за 3 с — состояние не меняется', async () => {
  const active = fake_worker();
  const e = fake_env({ active });
  active.on_post = (msg) => {
    if (msg.type !== PWA.MSG_STATUS) return;
    const ch = e.channels.at(-1);
    queueMicrotask(() => ch.port1.onmessage({ data: { type: PWA.MSG_STATUS, build: MANIFEST.build_hash, cached: 5, total: 7 } }));
  };
  const pwa = PWA.create_pwa(e.env);
  await pwa.start();
  await pwa.refresh_status();
  assert.deepEqual([pwa.snapshot().cached, pwa.snapshot().total, pwa.snapshot().build], [5, 7, MANIFEST.build_hash]);
  assert.deepEqual(e.active.posted[0].msg, { type: PWA.MSG_STATUS });
  assert.equal(e.active.posted[0].transfer.length, 1, 'порт передан воркеру');

  const mute = fake_worker();
  const m = fake_env({ active: mute });
  const pm = PWA.create_pwa(m.env);
  await pm.start(); // start не ждёт воркера
  const pending = pm.refresh_status();
  assert.equal(m.timers.at(-1).ms, PWA.STATUS_TIMEOUT_MS);
  for (const t of m.timers) t.fn();
  assert.equal(await pending, null);
  assert.equal(pm.snapshot().cached, null);
  assert.equal(pm.snapshot().status, 'active');
});

test('REQ-117 первая установка: после «activated» узнаём «k из n» у активного воркера; если первая установка не прошла — состояние «ошибка» (офлайн-копии нет), а не «работает»', async () => {
  const installing = fake_worker('installing');
  const e = fake_env({ controller: null, active: null });
  e.reg.installing = installing;
  const active = fake_worker();
  active.on_post = (msg) => {
    if (msg.type !== PWA.MSG_STATUS) return;
    const ch = e.channels.at(-1);
    queueMicrotask(() => ch.port1.onmessage({ data: { type: PWA.MSG_STATUS, build: MANIFEST.build_hash, cached: 7, total: 7 } }));
  };
  const pwa = PWA.create_pwa(e.env);
  await pwa.start();
  assert.equal(pwa.snapshot().status, 'active');
  assert.equal(pwa.snapshot().cached, null, 'активного воркера ещё нет — спросить некого');
  e.reg.installing = null;
  e.reg.active = active;
  installing.state = 'activated';
  for (const fn of installing.listeners.statechange ?? []) fn();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([pwa.snapshot().cached, pwa.snapshot().total], [7, 7]);

  const failing = fake_worker('installing');
  const f = fake_env({ controller: null, active: null });
  f.reg.installing = failing;
  const pf = PWA.create_pwa(f.env);
  await pf.start();
  failing.state = 'redundant';
  for (const fn of failing.listeners.statechange ?? []) fn();
  assert.deepEqual([pf.snapshot().status, pf.snapshot().reason], ['error', 'install_failed']);
});

// ── настоящий sw.js в vm ───────────────────────────────────────────────────────────────────────────────────────────

const SERVER_PATHS = [...LIST.map((f) => f.path), 'demo/shell_manifest.json'];
const fresh_server = () => read_files(SERVER_PATHS);

test('REQ-154 sw.js: штамп сборки совпадает с манифестом, имя кэша — runway-shell- и 16 знаков хэша; воркер классический, без импортов и без чужих кэшей', () => {
  assert.equal(BM.stamp_of_sw(SW_SOURCE), MANIFEST.build_hash);
  assert.match(SW_SOURCE, /const CACHE_PREFIX = 'runway-shell-';/);
  assert.ok(!/\bimport\b|importScripts|\beval\b|new Function/.test(SW_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')), 'классический воркер без импортов и eval');
  const code = SW_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/caches\.delete\(\s*['"]/.test(code), 'кэши удаляются только по вычисленному имени своего префикса');
  assert.equal((code.match(/\bfetch\(/g) ?? []).length, 3, 'сеть в воркере: манифест, файл оболочки, запрос-проход для файла вне кэша');
  const fp = new Set(LIST.map((f) => f.path));
  assert.ok(fp.has('demo/build_info.mjs') && !fp.has('demo/sw.js'), 'build_info.mjs в кэше, сам воркер — нет');
  assert.equal(LIST.length, MANIFEST.files.length + 1);
});

test('REQ-117 REQ-154 sw.js установка: каждый файл манифеста скачан, sha256 и размер сверены, кэш содержит ровно список оболочки и манифест; повреждённый файл или перекос версий — установка отвергнута, кэша не остаётся', async () => {
  const w = load_sw({ files: fresh_server() });
  const r = await w.install();
  assert.equal(r.ok, true, String(r.error));
  assert.deepEqual(w.cache_names(), [CACHE]);
  const keys = (await (await w.caches.open(CACHE)).keys()).map((k) => k.url);
  const base = ORIGIN + ROOT_PATH;
  assert.deepEqual(keys.sort(), [...LIST.map((f) => base + f.path), base + 'demo/shell_manifest.json'].sort());
  assert.equal(w.log.network.filter((u) => !u.endsWith('shell_manifest.json')).length, LIST.length, 'каждый файл скачан один раз');

  const tampered = fresh_server();
  tampered.set('engine/money.mjs', Buffer.from('export const x = 1;\n'));
  const t = load_sw({ files: tampered });
  const tr = await t.install();
  assert.equal(tr.ok, false);
  assert.equal(tr.error.message, 'file_hash');
  assert.deepEqual(t.cache_names(), [], 'недокачанный кэш удалён');

  const wrong_manifest = fresh_server();
  wrong_manifest.set('demo/shell_manifest.json', Buffer.from(JSON.stringify({ ...MANIFEST, build_hash: 'ab'.repeat(32) })));
  const wm = await load_sw({ files: wrong_manifest }).install();
  assert.equal(wm.error?.message, 'manifest_mismatch', 'перекос версий sw.js и манифеста на хосте');

  const skew = load_sw({ files: fresh_server(), source: BM.stamp_sw(SW_SOURCE, 'cd'.repeat(32)) });
  assert.equal((await skew.install()).error?.message, 'manifest_mismatch');

  const missing = fresh_server();
  missing.delete('data/g001.json');
  const mi = await load_sw({ files: missing }).install();
  assert.equal(mi.error?.message, 'file_http');

  const down = load_sw({ files: fresh_server() });
  down.state.online = false;
  assert.equal((await down.install()).ok, false, 'без сети первая установка невозможна — это ожидаемо');
});

test('REQ-117 sw.js активация: удаляются только устаревшие кэши с префиксом runway-shell-; кэши других проектов того же источника целы; управление берётся сразу', async () => {
  const w = load_sw({ files: fresh_server() });
  for (const name of ['runway-shell-0123456789abcdef', 'runway-shell-old', 'portal-v9-cache', 'ad-concepts-v3', 'runway-notes', 'shell-v1']) await w.caches.open(name);
  await w.install();
  const r = await w.activate();
  assert.equal(r.ok, true);
  assert.deepEqual(w.cache_names().sort(), ['ad-concepts-v3', CACHE, 'portal-v9-cache', 'runway-notes', 'shell-v1'].sort());
  assert.deepEqual(w.log.deleted.sort(), ['runway-shell-0123456789abcdef', 'runway-shell-old'].sort());
  assert.equal(w.log.claimed, 1);
  assert.equal(w.log.skip_waiting, 0, 'активация не пропускает ожидание сама');
});

test('REQ-120 sw.js ответы: после установки КАЖДЫЙ файл оболочки отдаётся из кэша без сети побайтно как в манифесте; …/demo/ — это index.html', async () => {
  const w = load_sw({ files: fresh_server() });
  await w.install();
  await w.activate();
  w.state.online = false; // сети нет
  w.log.network.length = 0;
  const base = ORIGIN + ROOT_PATH;
  for (const f of LIST) {
    const r = await w.request(base + f.path);
    assert.equal(r.handled, true, f.path);
    assert.equal(r.response.status, 200, f.path);
    const body = Buffer.from(await r.response.arrayBuffer());
    assert.equal(BM.sha256_hex(body), f.sha256, f.path);
  }
  const dir = await w.request(base + 'demo/');
  assert.equal(BM.sha256_hex(Buffer.from(await dir.response.arrayBuffer())), MANIFEST.files.find((f) => f.path === 'demo/index.html').sha256);
  const dir2 = await w.request(base + 'demo');
  assert.equal(dir2.response.status, 200);
  const q = await w.request(base + 'demo/app.mjs?v=3#x');
  assert.equal(q.response.status, 200, 'query отбрасывается при поиске в кэше');
  assert.deepEqual(w.log.network, [], 'ни одного сетевого вызова за все ответы');
});

test('REQ-120 sw.js не вмешивается в чужое: не GET, другой источник, другой каталог того же хоста, каталоги prototype/ вне demo-engine-data; файл вне кэша идёт в сеть (в офлайне — ошибка, а не подмена)', async () => {
  const w = load_sw({ files: fresh_server() });
  await w.install();
  const base = ORIGIN + ROOT_PATH;
  assert.equal((await w.request(base + 'demo/app.mjs', { method: 'POST' })).handled, false);
  assert.equal((await w.request('https://example.org/demo/app.mjs')).handled, false);
  assert.equal((await w.request(ORIGIN + '/01/50/portal-v9-3d-simulator.html')).handled, false, 'соседний проект на том же localhost');
  assert.equal((await w.request(ORIGIN + '/01/301/runway/prototype-other/demo/app.mjs')).handled, false, 'похожий префикс пути');
  assert.equal((await w.request(base + 'tests/helpers.mjs')).handled, false);
  assert.equal((await w.request(base + 'package.json')).handled, false);
  assert.equal((await w.request(ORIGIN + '/')).handled, false);
  // файл внутри demo/, которого нет в оболочке: вмешательство есть, но ответ — сеть
  w.log.network.length = 0;
  const readme = await w.request(base + 'demo/README_ext.md');
  assert.equal(readme.handled, true);
  assert.deepEqual(w.log.network, [base + 'demo/README_ext.md']);
  w.state.online = false;
  await assert.rejects(async () => (await w.request(base + 'demo/README_ext.md')).response, TypeError);
});

test('REQ-117 sw.js сообщения: runway-skip-waiting вызывает skipWaiting только по сообщению; runway-status отвечает «k из n»; прочие сообщения игнорируются', async () => {
  const w = load_sw({ files: fresh_server() });
  assert.deepEqual(plain((await w.message({ type: 'runway-status' }))[0]), { type: 'runway-status', format: 'runway-shell/1', build: MANIFEST.build_hash, cache: CACHE, cached: 0, total: 0 }, 'до установки кэша нет');
  await w.install();
  const s = (await w.message({ type: 'runway-status' }))[0];
  assert.deepEqual([s.cached, s.total, s.build, s.cache], [LIST.length, LIST.length, MANIFEST.build_hash, CACHE]);
  assert.equal(w.log.skip_waiting, 0);
  await w.message({ type: 'другое' });
  await w.message('строка');
  await w.message(null);
  assert.equal(w.log.skip_waiting, 0);
  await w.message({ type: 'runway-skip-waiting' });
  assert.equal(w.log.skip_waiting, 1);
  // частично повреждённый кэш: «k из n» честно показывает недостающее
  const store = w.stores.get(CACHE);
  store.delete(ORIGIN + ROOT_PATH + 'engine/money.mjs');
  const s2 = (await w.message({ type: 'runway-status' }))[0];
  assert.deepEqual([s2.cached, s2.total], [LIST.length - 1, LIST.length]);
});

// ── «Удалить все данные» не трогает чужие воркеры и кэши ──────────────────────────────────────────────────────────────

test('REQ-098 решение № 4 «Удалить все данные» после FP-12: снимается ТОЛЬКО воркер demo/ и кэш runway-shell-…; чужие воркеры и кэши общего localhost, похожие области и ключи целы', async () => {
  // own_scope считает pack_fp05 как каталог prototype/ от адреса своего модуля; область воркера pwa.mjs считает от адреса своего модуля — каталог demo/ рядом
  const pack05_src = read('demo', 'pack_fp05.mjs');
  assert.ok(pack05_src.includes("own_scope: new URL('../', import.meta.url).href"), 'pack_fp05 считает свою область как каталог prototype/');
  const file_demo = pathToFileURL(path.join(PROTO, 'demo')).href + '/';
  const rel = PWA.create_pwa({ navigator: { serviceWorker: { register: async () => ({}), addEventListener() {} } }, location: { protocol: 'http:', hostname: 'localhost' }, base_url: file_demo + 'pwa.mjs' });
  assert.ok(rel.snapshot().scope.startsWith(new URL('../', file_demo + 'pack_fp05.mjs').href), 'область воркера внутри own_scope при настоящем размещении файлов');
  // то же отношение в адресах браузера: страница http://localhost/01/301/runway/prototype/demo/
  const own_scope = OWN_SCOPE;
  const e = fake_env({ base_url: DEMO_URL + 'pwa.mjs', location: { protocol: 'http:', hostname: 'localhost' }, own_scope });
  const pwa = PWA.create_pwa(e.env);
  await pwa.start();
  const mine = e.sw.calls[0].opts.scope;
  assert.equal(mine, DEMO_URL);
  assert.ok(mine.startsWith(own_scope), 'область воркера лежит внутри own_scope: ' + mine);

  const regs = [];
  const mk = (scope) => { const r = { scope, unregistered: false, async unregister() { r.unregistered = true; return true; } }; regs.push(r); return r; };
  const ours = mk(mine);
  const foreign = [mk(ORIGIN + '/01/50/'), mk(ORIGIN + '/01/301/runway/prototype-other/demo/'), mk(ORIGIN + '/01/301/'), mk(ORIGIN + '/01/301/runway/'), mk(ORIGIN + '/')];
  const names = [CACHE, 'runway-shell-old', 'portal-v9-cache', 'nexus-shell-v2', 'shell-v1', 'ad-concepts-v3'];
  const caches = { names: [...names], async keys() { return [...caches.names]; }, async delete(n) { caches.names = caches.names.filter((x) => x !== n); return true; } };
  const store = new Map([['runway-metrics/1', '{}'], ['runway-prob-consent/1', '{}'], ['portal-v9-theme', 'dark'], ['nexus.save', '{"keep":1}']]);
  const storage = { get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null, getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); } };
  const r = await DA.erase_all({ storage, caches, service_worker: { async getRegistrations() { return regs; } }, own_scope, today: () => '2026-10-09' });
  assert.equal(r.erased, true, JSON.stringify(r.errors));
  assert.equal(ours.unregistered, true, 'свой воркер снят');
  for (const f of foreign) assert.equal(f.unregistered, false, 'чужой воркер не тронут: ' + f.scope);
  assert.deepEqual(caches.names, ['portal-v9-cache', 'nexus-shell-v2', 'shell-v1', 'ad-concepts-v3'], 'удалены только кэши runway…');
  assert.deepEqual([...store.keys()].sort(), ['nexus.save', 'portal-v9-theme'], 'ключи runway… стёрты, чужие целы');
  const sw_step = r.stores.find((s) => s.name === 'service_worker');
  assert.equal(sw_step.removed, 1);
  assert.equal(sw_step.foreign_kept, foreign.length);
  assert.equal(r.stores.find((s) => s.name === 'cache').foreign_kept, 4);
});

// ── исправления после независимой проверки (ADV-03, ADV-04, ADV-05) ───────────────────────────────────────────────────────

test('REQ-117 исправление ADV-03: сбой установки стирает ТОЛЬКО кэш, созданный этой же установкой; кэш того же имени, существовавший до неё, и его содержимое остаются нетронутыми', async () => {
  // работающая версия: установлена и активирована
  const live = load_sw({ files: fresh_server() });
  assert.equal((await live.install()).ok, true);
  assert.equal((await live.activate()).ok, true);
  assert.deepEqual(live.cache_names(), [CACHE]);
  const size = live.stores.get(CACHE).size;
  assert.ok(size > 100, 'в кэше работающей версии файлы оболочки: ' + size);

  // повторная установка с тем же именем кэша (общее хранилище кэшей): файл оболочки на хосте повреждён → установка отвергнута, кэш цел
  const tampered = fresh_server();
  tampered.set('engine/money.mjs', Buffer.from('export const x = 1;\n'));
  const next = load_sw({ files: tampered });
  for (const [name, entries] of live.stores) next.stores.set(name, entries);
  const r = await next.install();
  assert.equal(r.ok, false);
  assert.equal(r.error.message, 'file_hash');
  assert.ok(next.stores.has(CACHE), 'кэш работающей версии не удалён');
  assert.equal(next.stores.get(CACHE).size, size, 'и не усечён');
  assert.deepEqual(next.log.deleted, [], 'удалений кэшей не было вовсе');

  // обрыв сети до первого файла и перекос манифеста: то же
  const offline = load_sw({ files: fresh_server() });
  for (const [name, entries] of live.stores) offline.stores.set(name, entries);
  offline.state.online = false;
  assert.equal((await offline.install()).ok, false);
  assert.equal(offline.stores.get(CACHE).size, size);
  const skewed = fresh_server();
  skewed.set('demo/shell_manifest.json', Buffer.from(JSON.stringify({ ...MANIFEST, build_hash: 'ab'.repeat(32) })));
  const sk = load_sw({ files: skewed });
  for (const [name, entries] of live.stores) sk.stores.set(name, entries);
  assert.equal((await sk.install()).error?.message, 'manifest_mismatch');
  assert.equal(sk.stores.get(CACHE).size, size);

  // а недокачанный кэш, который создала именно эта установка, по-прежнему убирается
  const own = load_sw({ files: tampered });
  assert.equal((await own.install()).ok, false);
  assert.deepEqual(own.cache_names(), [], 'свой недокачанный кэш удалён');
  assert.deepEqual(own.log.deleted, [CACHE]);

  // успешная установка поверх кэша того же имени ничего не ломает
  const again = load_sw({ files: fresh_server() });
  for (const [name, entries] of live.stores) again.stores.set(name, entries);
  assert.equal((await again.install()).ok, true);
  assert.deepEqual(again.cache_names(), [CACHE]);
});

test('REQ-117 исправление ADV-03: имя кэша следует за текстом воркера — релиз, в котором изменился только sw.js, ставится в другой кэш и при сбое оставляет кэш работающей версии целым', async () => {
  const sw_core = MANIFEST.stamped.find((f) => f.path === 'demo/sw.js').core_sha256;
  assert.match(sw_core, /^[0-9a-f]{64}$/);
  assert.equal(BM.sw_core_sha256(SW_SOURCE), sw_core, 'core_sha256 манифеста = текст воркера без штампа');
  // «следующий» релиз: тот же набор файлов, воркер с правкой логики; хэш сборки и имя кэша получаются по настоящей формуле сборки
  const next_core = SW_SOURCE + '\n// правка логики воркера\n';
  const next_hash = BM.build_hash_with_sw(MANIFEST.files, BM.sw_core_sha256(next_core));
  assert.notEqual(next_hash, MANIFEST.build_hash, 'правка воркера меняет хэш сборки');
  const next_cache = 'runway-shell-' + next_hash.slice(0, 16);
  assert.notEqual(next_cache, CACHE, 'и имя кэша');
  assert.equal(BM.build_hash_with_sw(MANIFEST.files, sw_core), MANIFEST.build_hash, 'формула сборки воспроизводит хэш манифеста');

  const live = load_sw({ files: fresh_server() });
  await live.install();
  await live.activate();
  const size = live.stores.get(CACHE).size;
  const next_manifest = { ...MANIFEST, build_hash: next_hash };
  const server = fresh_server();
  server.set('demo/shell_manifest.json', Buffer.from(JSON.stringify(next_manifest)));
  server.set('engine/money.mjs', Buffer.from('export const x = 1;\n')); // установка новой версии не дойдёт до конца
  const nxt = load_sw({ files: server, source: BM.stamp_sw(next_core, next_hash) });
  for (const [name, entries] of live.stores) nxt.stores.set(name, entries);
  assert.equal((await nxt.install()).ok, false);
  assert.equal(nxt.stores.get(CACHE).size, size, 'кэш работающей версии цел');
  assert.equal(nxt.stores.has(next_cache), false, 'недокачанный кэш новой версии убран');
});

const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

test('REQ-117 исправление ADV-04: check_update ждёт конца установки найденной версии (update() возвращается, когда установка только началась); installing виден в состоянии; итог — «ждёт обновления»', async () => {
  const e = fake_env({ controller: fake_worker() });
  const pwa = PWA.create_pwa(e.env);
  await pwa.start();
  assert.equal(pwa.snapshot().installing, false);
  const w = fake_worker('installing');
  e.reg.update = async () => { e.reg.updates += 1; e.reg.installing = w; for (const fn of e.reg.listeners.updatefound ?? []) fn(); }; // как в спецификации: вернулся, пока версия ещё устанавливается
  let answered = null;
  const p = pwa.check_update().then((s) => { answered = s; return s; });
  await settle();
  assert.equal(answered, null, 'ответ не отдан, пока версия устанавливается');
  assert.deepEqual([pwa.snapshot().status, pwa.snapshot().installing], ['active', true]);
  assert.equal(e.timers.at(-1).ms, PWA.SETTLE_TIMEOUT_MS, 'ожидание ограничено по времени');
  e.reg.installing = null;
  e.reg.waiting = w;
  w.state = 'installed';
  for (const fn of w.listeners.statechange ?? []) fn();
  const s = await p;
  assert.deepEqual([s.status, s.installing, s.reason], ['update_ready', false, null]);
});

test('REQ-117 исправление ADV-04: если установка не закончилась за SETTLE_TIMEOUT_MS, ответ возвращается с installing:true, а позже состояние само переходит в «ждёт обновления» и подписчики узнают об этом', async () => {
  const e = fake_env({ controller: fake_worker() });
  const pwa = PWA.create_pwa(e.env);
  await pwa.start();
  const seen = [];
  pwa.subscribe((st) => seen.push([st.status, st.installing]));
  const w = fake_worker('installing');
  e.reg.update = async () => { e.reg.installing = w; for (const fn of e.reg.listeners.updatefound ?? []) fn(); };
  const p = pwa.check_update();
  await settle();
  e.timers.at(-1).fn(); // истёк срок ожидания
  const s = await p;
  assert.deepEqual([s.status, s.installing], ['active', true], 'установка идёт: об этом честно сказано');
  e.reg.installing = null;
  e.reg.waiting = w;
  w.state = 'installed';
  for (const fn of w.listeners.statechange ?? []) fn();
  assert.deepEqual([pwa.snapshot().status, pwa.snapshot().installing], ['update_ready', false]);
  assert.ok(seen.some(([st, inst]) => st === 'update_ready' && inst === false), 'подписчик получил переход: ' + JSON.stringify(seen));
});

test('REQ-117 исправление ADV-05: отказ установки найденной версии виден в состоянии (reason install_failed, installing false) и сбрасывается новой попыткой; обычная проверка без новой версии не ждёт', async () => {
  const e = fake_env({ controller: fake_worker() });
  const pwa = PWA.create_pwa(e.env);
  await pwa.start();
  const w1 = fake_worker('installing');
  e.reg.update = async () => { e.reg.installing = w1; for (const fn of e.reg.listeners.updatefound ?? []) fn(); };
  const p = pwa.check_update();
  await settle();
  w1.state = 'redundant';
  e.reg.installing = null;
  for (const fn of w1.listeners.statechange ?? []) fn();
  const s = await p;
  assert.deepEqual([s.status, s.reason, s.installing], ['active', 'install_failed', false]);
  // новая попытка установки: прежняя причина устарела
  const w2 = fake_worker('installing');
  e.reg.installing = w2;
  for (const fn of e.reg.listeners.updatefound ?? []) fn();
  assert.deepEqual([pwa.snapshot().reason, pwa.snapshot().installing], [null, true]);
  w2.state = 'installed';
  e.reg.installing = null;
  e.reg.waiting = w2;
  for (const fn of w2.listeners.statechange ?? []) fn();
  assert.deepEqual([pwa.snapshot().status, pwa.snapshot().reason, pwa.snapshot().installing], ['update_ready', null, false]);
  // обычная проверка, новой версии нет: не ждём и не зависаем
  const calm = fake_env({ controller: fake_worker() });
  const pc = PWA.create_pwa(calm.env);
  await pc.start();
  const sc = await pc.check_update();
  assert.deepEqual([sc.status, sc.installing, sc.reason], ['active', false, null]);
  assert.equal(calm.timers.filter((t) => t.ms === PWA.SETTLE_TIMEOUT_MS).length, 0, 'нечего ждать — таймер не заводился');
});
