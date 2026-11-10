// about.test.mjs — FP-12: экран «О программе» (demo/about.mjs, pack_fp12.mjs, i18n/about.mjs, css/about.css). REQ-154 (хэш сборки виден в «О программе»), REQ-117 (состояние офлайн-копии,
// «Проверить обновление» / «Обновить» без тихой подмены), REQ-120 (сведения: после загрузки оболочки сети нет, кроме проверки обновления на своём хосте), REQ-186 (лицензия не выбрана),
// проверка расчёта в фоне (Worker против основного потока). Настоящий app.mjs на заглушке DOM + экран на подделках контроллера PWA и клиента расчёта. Браузера и сети нет.
// Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const DEMO = path.join(PROTO, 'demo');
const read = (...p) => fs.readFileSync(path.join(PROTO, ...p), 'utf8');

class Node_ {
  constructor(tag, ns) {
    this.nodeType = 1; this.tagName = tag; this.ns = ns ?? null; this.attrs = {}; this.children = []; this.listeners = {}; this.className = '';
    this._text = ''; this._value = ''; this._sel = null; this.open = false; this.focused = false; this.checked = false;
  }
  get textContent() { return this.children.length === 0 ? this._text : this.children.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get value() { return this._value; }
  set value(v) { this._value = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return Object.hasOwn(this.attrs, k); }
  append(...kids) { for (const k of kids) this.children.push(k); this._text = ''; }
  replaceChildren(...kids) { this.children = []; this._text = ''; this.append(...kids); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  focus() { this.focused = true; globalThis.document.activeElement = this; }
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
const net = { fetch: [] };
globalThis.document = {
  createElement: (t) => new Node_(t),
  createElementNS: (ns, t) => new Node_(t, ns),
  createTextNode: (data) => ({ nodeType: 3, data }),
  getElementById: (id) => byid.get(id) ?? find_all(byid.get('main'), (n) => n.attrs.id === id)[0] ?? null,
  documentElement: new Node_('html'),
  head: new Node_('head'),
  body: new Node_('body'),
  activeElement: null,
  title: '',
};
globalThis.window = { addEventListener: (t, fn) => { (listeners[t] ??= []).push(fn); }, scrollTo: () => {} };
globalThis.location = { hash: '' };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'ru-RU' }, configurable: true });
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

const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);
const { ext } = await imp('demo', 'ext.mjs');
await imp('demo', 'app.mjs');
await new Promise((r) => setTimeout(r, 700));
const AB = await imp('demo', 'about.mjs');
const PACK = await imp('demo', 'pack_fp12.mjs');
const I18N = await imp('demo', 'i18n.mjs');
const BI = await imp('demo', 'build_info.mjs');
const BM = await imp('tools', 'build_manifest.mjs');
const E = await imp('engine', 'index.mjs');
const MANIFEST = JSON.parse(read('demo', 'shell_manifest.json'));
const ctx = ext.ctx;
const main = () => byid.get('main');
const by_id = (id) => find_all(main(), (n) => n.attrs.id === id)[0];
const text_of = (n) => String(n.textContent).replace(/[  ]/g, ' ');
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const lang_button = (l) => find_all(byid.get('controls'), (n) => n.tagName === 'button' && n.attrs.lang === l)[0];

// ── данные сборки ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-154 build_info.mjs: хэш сборки и число файлов взяты из манифеста; объект заморожен; сокращённый хэш — первые 12 знаков', () => {
  assert.equal(BI.BUILD.format, 'runway-shell/1');
  assert.equal(BI.BUILD.build_hash, MANIFEST.build_hash);
  assert.equal(BI.BUILD.files, BM.precache_list(MANIFEST).length);
  assert.equal(Object.isFrozen(BI.BUILD), true);
  assert.deepEqual(Object.keys(BI.BUILD), ['format', 'build_hash', 'files']);
  assert.equal(AB.short_hash(MANIFEST.build_hash), MANIFEST.build_hash.slice(0, 12));
  assert.deepEqual(AB.build_rows(BI.BUILD, '0.1.0'), [['engine', '0.1.0'], ['hash', MANIFEST.build_hash], ['files', String(BI.BUILD.files)], ['format', 'runway-shell/1']]);
  assert.equal(AB.ABOUT_ORDER, 180);
});

// ── тексты состояния ──────────────────────────────────────────────────────────────────────────────────────────────────

const tr_of = (lang) => (key, params) => I18N.t(lang, key, params);

test('REQ-117 pwa_text и причины: каждое состояние и каждая причина названы словами на RU и EN; неизвестный код исключения показывается как «код …»; текст не пуст и без необработанных плейсхолдеров', () => {
  for (const lang of ['ru', 'en']) {
    const tr = tr_of(lang);
    const states = [
      { status: 'idle' }, { status: 'registering' }, { status: 'active' }, { status: 'active', cached: 138, total: 138 }, { status: 'update_ready' },
      { status: 'unsupported', reason: 'insecure_origin' }, { status: 'unsupported', reason: 'no_service_worker' }, { status: 'unsupported', reason: 'bad_scope' },
      { status: 'error', reason: 'SecurityError' }, { status: 'error', reason: 'install_failed' },
    ];
    const seen = new Set();
    for (const s of states) {
      const t = AB.pwa_text(tr, s);
      assert.ok(t.trim().length > 8, lang + ' ' + JSON.stringify(s));
      assert.ok(!/\{[a-z_]+\}/.test(t) && !/^about\./.test(t), `${lang}: необработанный ключ или плейсхолдер: ${t}`);
      seen.add(t);
    }
    assert.equal(seen.size, states.length, lang + ': у каждого состояния свой текст');
    assert.match(AB.pwa_text(tr, { status: 'active', cached: 5, total: 9 }), /5/);
    assert.match(AB.pwa_text(tr, { status: 'error', reason: 'SecurityError' }), /SecurityError/);
    assert.ok(AB.reason_text(tr, null) === '' && AB.reason_text(tr, undefined) === '');
    for (const fb of ['no_worker', 'worker_start_failed', 'worker_error', 'timeout', 'version_mismatch', 'clone_failed', 'terminated', 'неизвестная']) {
      assert.ok(AB.fallback_text(tr, fb).length > 3, fb);
    }
    assert.match(AB.fallback_text(tr, 'неизвестная'), /неизвестная/);
  }
  assert.match(AB.pwa_text(tr_of('ru'), { status: 'active', cached: 138, total: 138 }), /138 из 138/);
  assert.match(AB.pwa_text(tr_of('en'), { status: 'active', cached: 138, total: 138 }), /138 of 138/);
});

test('REQ-120 C-062 формулировки: «после первой загрузки оболочки основные сценарии работают без сети»; «всегда офлайн» и «полностью работает без сети» не используются; доверие хосту при первой загрузке названо; лицензия и ревью — «не выполнено»', async () => {
  const cat = (await imp('demo', 'i18n', 'about.mjs')).default;
  for (const lang of ['ru', 'en']) {
    const all = Object.values(cat[lang]).join('\n').toLowerCase();
    for (const bad of ['всегда офлайн', 'полностью работает без сети', 'always offline', 'works fully offline', 'безопасн', 'гарантир', 'guarantee']) assert.ok(!all.includes(bad), `${lang}: «${bad}»`);
  }
  const ru = cat.ru;
  assert.match(ru['about.offline_note'], /После первой загрузки оболочки основные сценарии работают без сети/);
  assert.match(ru['about.net_1'], /не делает сетевых запросов, кроме проверки обновления оболочки на собственном хосте/);
  assert.match(ru['about.net_3'], /доверяете хосту/);
  assert.match(ru['about.net_3'], /подписанных релизов нет/);
  assert.match(ru['about.legal_2'], /не выбрана/);
  assert.match(ru['about.legal_3'], /не выполнены/);
  assert.match(cat.en['about.net_1'], /except a check for a shell update on its own host/);
  assert.match(cat.en['about.legal_2'], /not been chosen/);
  assert.ok(Object.keys(cat.ru).every((k) => k.startsWith('about.')));
});

// ── check_background ──────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-150 check_background: результаты воркера и основного потока сравниваются побайтно; различие, откат на главный поток и ошибка расчёта различаются', async () => {
  const G = JSON.parse(read('data', 'g001.json'));
  const clock = (() => { let t = 100; return () => { t += 7; return t; }; })();
  const same = { analyze: async (ws, q) => ({ result: E.analyze(ws, q), via: 'worker', reason: null }) };
  const r1 = await AB.check_background(same, G, clock);
  assert.deepEqual([r1.same, r1.via, r1.reason, r1.ms], [true, 'worker', null, 7]);
  const main_only = { analyze: async (ws, q) => ({ result: E.analyze(ws, q), via: 'main', reason: 'no_worker' }) };
  assert.deepEqual((await AB.check_background(main_only, G, clock)).reason, 'no_worker');
  const differs = { analyze: async (ws, q) => { const a = E.analyze(ws, q); return { result: { ...a, inputs_hash: '0'.repeat(64) }, via: 'worker', reason: null }; } };
  assert.equal((await AB.check_background(differs, G, clock)).same, false);
  const failing = { analyze: async () => { throw new E.RunwayError('E_BAD_DATE', { reason: 'x' }); } };
  await assert.rejects(() => AB.check_background(failing, G, clock), (e) => e.code === 'E_BAD_DATE');
});

// ── экран в настоящем app.mjs ─────────────────────────────────────────────────────────────────────────────────────────

test('REQ-154 REQ-117 boot: пакет FP-12 подхвачен манифестом пакетов, «О программе» стоит в навигации; app.mjs пакет и PWA не называет; сеть при загрузке — один набор данных', async () => {
  assert.ok(ext.diagnostics().some((d) => d.pack === 'pack_fp12' && d.status === 'ok'), JSON.stringify(ext.diagnostics().filter((d) => d.pack === 'pack_fp12')));
  assert.deepEqual(ext.diagnostics().filter((d) => d.status === 'failed'), []);
  assert.ok(ext.has_view('about'));
  const link = find_all(byid.get('nav'), (n) => n.tagName === 'a' && n.attrs.href === '#about')[0];
  assert.equal(link.textContent, 'О программе');
  const app_src = read('demo', 'app.mjs');
  assert.ok(!/pack_fp12|about\.mjs|pwa|serviceWorker|worker_client|build_info/.test(app_src), 'app.mjs не знает пакет FP-12');
  assert.equal(net.fetch.length, 1);
  assert.match(net.fetch[0], /data\/g001\.json$/);
  assert.equal(typeof PACK.register, 'function');
});

test('REQ-154 экран «О программе» (RU): версия движка, ПОЛНЫЙ хэш сборки из build_info.mjs, число файлов, формат манифеста; в Node воркер не регистрируется, причина названа; «Проверить обновление» недоступна', async () => {
  await go('#about');
  assert.equal(by_id('view-title').textContent, 'О программе');
  const t = text_of(main());
  assert.ok(t.includes(E.ENGINE_VERSION));
  assert.equal(by_id('ab-hash').textContent, MANIFEST.build_hash, 'виден весь хэш');
  assert.equal(by_id('ab-hash').tagName, 'code');
  assert.match(t, new RegExp(`Файлов оболочки${BI.BUILD.files}`));
  assert.match(t, /runway-shell\/1/);
  assert.match(by_id('ab-pwa').textContent, /Офлайн-копия не создаётся: страница открыта не на localhost и не по HTTPS/);
  assert.equal(by_id('ab-check').hasAttribute('disabled'), true, 'без воркера проверять нечего');
  assert.equal(by_id('ab-update'), undefined, 'без ожидающей версии «Обновить» не показывается');
  assert.match(t, /После загрузки оболочки приложение не делает сетевых запросов, кроме проверки обновления оболочки на собственном хосте/);
  assert.match(t, /Лицензия на код приложения пока не выбрана/);
  assert.match(t, /Сторонних компонентов в сборке нет/);
  assert.ok(by_id('ab-pwa').getAttribute('role') === 'status' && by_id('ab-calc-msg').getAttribute('role') === 'status');
  // доступность: у каждого раздела есть заголовок, на который указывает aria-labelledby; у кнопок — текст; inline-стилей нет
  const sections = find_all(main(), (n) => n.tagName === 'section');
  assert.equal(sections.length, 5);
  for (const s of sections) assert.ok(by_id(s.attrs['aria-labelledby']) !== undefined && by_id(s.attrs['aria-labelledby']).tagName === 'h3');
  for (const b of find_all(main(), (n) => n.tagName === 'button')) assert.ok(b.textContent.trim().length > 3 && b.attrs.type === 'button');
  assert.equal(find_all(main(), (n) => n.hasAttribute('style')).length, 0);
});

test('REQ-150 «Проверить расчёт в фоне» в Node (Worker недоступен): результат совпал, воркер не использован, причина названа; сети нет; состояние не залипает', async () => {
  await go('#about');
  const before = net.fetch.length;
  by_id('ab-calc').listeners.click[0]();
  await tick();
  const msg = text_of(by_id('ab-calc-msg'));
  assert.match(msg, /^Результаты совпали: воркер не использован \(воркера нет в этом браузере\), расчёт на основном потоке за \d+ мс\.$/, msg);
  assert.equal(by_id('ab-calc').hasAttribute('disabled'), false, 'кнопка снова доступна');
  assert.equal(net.fetch.length, before, 'сети нет');
});

test('REQ-117 язык: переключение на EN даёт английские подписи экрана и состояния; хэш тот же', async () => {
  lang_button('en').listeners.click[0]();
  await go('#about');
  assert.equal(by_id('view-title').textContent, 'About Runway');
  assert.equal(by_id('ab-hash').textContent, MANIFEST.build_hash);
  assert.match(by_id('ab-pwa').textContent, /No offline copy is made: the page is not opened on localhost or over HTTPS/);
  assert.match(text_of(main()), /Build hash \(sha256\)/);
  assert.match(text_of(main()), /except a check for a shell update on its own host/);
  lang_button('ru').listeners.click[0]();
  await go('#about');
  assert.equal(by_id('view-title').textContent, 'О программе');
});

// ── экран на подделках контроллера и клиента ──────────────────────────────────────────────────────────────────────────

function fake_pwa(initial) {
  const st = { status: 'idle', reason: null, cached: null, total: null, ...initial };
  const calls = { check: 0, apply: 0 };
  const subs = new Set();
  return {
    calls, st,
    snapshot: () => ({ ...st }),
    subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); },
    start: async () => ({ ...st }),
    check_update: async () => { calls.check += 1; if (st.next !== undefined) Object.assign(st, st.next); return { ...st }; },
    apply_update: () => { calls.apply += 1; return st.status === 'update_ready'; },
  };
}
function stub_ctx(lang = 'ru', ws = null) {
  let refreshes = 0;
  return { tr: tr_of(lang), get_ws: () => ws, refresh: () => { refreshes += 1; }, refreshes: () => refreshes };
}

test('REQ-117 «Обновить» без тихой подмены: кнопка есть только при ожидающей версии; нажатие вызывает apply_update и говорит, что страница перезагрузится; «Проверить обновление» сообщает итог', async () => {
  const pwa = fake_pwa({ status: 'update_ready' });
  const deps = AB.make_deps({ pwa, calc: { analyze: async () => ({}) }, build: BI.BUILD });
  const c = stub_ctx();
  let root = AB.render_about(c, deps);
  const find = (id) => find_all(root, (n) => n.attrs.id === id)[0];
  assert.match(find('ab-pwa').textContent, /Доступна новая версия оболочки\. Сама она не применится/);
  assert.ok(find('ab-update') !== undefined);
  assert.equal(find('ab-check').hasAttribute('disabled'), false);
  assert.equal(pwa.calls.apply, 0, 'отрисовка экрана версию не применяет');
  find('ab-update').listeners.click[0]();
  assert.equal(pwa.calls.apply, 1);
  root = AB.render_about(c, deps);
  assert.equal(find_all(root, (n) => n.attrs.id === 'ab-check-msg')[0].textContent, 'Применяю новую версию: страница перезагрузится.');
  // проверка: «новая версия есть» / «нет» / «воркер не работает»
  for (const [initial, expect] of [
    [{ status: 'active', next: { status: 'update_ready' } }, 'Найдена новая версия: кнопка «Обновить» её применит.'],
    [{ status: 'active' }, 'Новой версии нет.'],
    [{ status: 'active', next: { status: 'error', reason: 'X' } }, 'Проверка недоступна: сервис-воркер не работает.'],
  ]) {
    const p = fake_pwa(initial);
    const d = AB.make_deps({ pwa: p, calc: { analyze: async () => ({}) }, build: BI.BUILD });
    const cc = stub_ctx();
    const r = AB.render_about(cc, d);
    find_all(r, (n) => n.attrs.id === 'ab-check')[0].listeners.click[0]();
    await tick();
    assert.equal(p.calls.check, 1);
    const r2 = AB.render_about(cc, d);
    assert.equal(find_all(r2, (n) => n.attrs.id === 'ab-check-msg')[0].textContent, expect);
    assert.ok(cc.refreshes() >= 2, 'экран перерисован после ответа');
  }
  // нет ожидающей версии: «Обновить» не показывается, а apply_update ничего не делает
  const none = fake_pwa({ status: 'active', cached: 138, total: 138 });
  const r3 = AB.render_about(stub_ctx(), AB.make_deps({ pwa: none, calc: { analyze: async () => ({}) } }));
  assert.equal(find_all(r3, (n) => n.attrs.id === 'ab-update').length, 0);
  assert.match(find_all(r3, (n) => n.attrs.id === 'ab-pwa')[0].textContent, /138 из 138 файлов/);
});

test('REQ-150 «Проверить расчёт в фоне» на подделке клиента: воркер → «за N мс в воркере»; расхождение и ошибка расчёта названы; без данных — «Нет данных»', async () => {
  const G = JSON.parse(read('data', 'g001.json'));
  const run = async (calc, ws = G) => {
    const deps = AB.make_deps({ pwa: fake_pwa({ status: 'active' }), calc, build: BI.BUILD, now_ms: (() => { let t = 0; return () => { t += 12; return t; }; })() });
    const c = stub_ctx('ru', ws);
    const root = AB.render_about(c, deps);
    find_all(root, (n) => n.attrs.id === 'ab-calc')[0].listeners.click[0]();
    await tick();
    return find_all(AB.render_about(c, deps), (n) => n.attrs.id === 'ab-calc-msg')[0].textContent;
  };
  assert.equal(await run({ analyze: async (ws, q) => ({ result: E.analyze(ws, q), via: 'worker', reason: null }) }), 'Результаты совпали: расчёт выполнен в воркере за 12 мс.');
  assert.match(await run({ analyze: async (ws, q) => ({ result: { ...E.analyze(ws, q), x: 1 }, via: 'worker', reason: null }) }), /^Результаты расходятся: расчёт воркера не принят/);
  assert.equal(await run({ analyze: async () => { throw new E.RunwayError('E_NO_RATE', {}); } }), 'Расчёт не выполнен: код E_NO_RATE.');
  assert.equal(await run({ analyze: async () => { throw new Error('что-то'); } }), 'Расчёт не выполнен: код E_SCHEMA.');
  assert.equal(await run({ analyze: async (ws, q) => ({ result: E.analyze(ws, q), via: 'main', reason: 'timeout' }) }), 'Результаты совпали: воркер не использован (воркер не ответил вовремя), расчёт на основном потоке за 12 мс.');
  assert.equal(await run({ analyze: async () => ({}) }, null), 'Нет данных для расчёта.');
  // кнопка недоступна, пока расчёт идёт
  let release;
  const slow = { analyze: () => new Promise((r) => { release = () => r({ result: E.analyze(G, { as_of: G.as_of }), via: 'worker', reason: null }); }) };
  const deps = AB.make_deps({ pwa: fake_pwa({ status: 'active' }), calc: slow, build: BI.BUILD });
  const c = stub_ctx('ru', G);
  find_all(AB.render_about(c, deps), (n) => n.attrs.id === 'ab-calc')[0].listeners.click[0]();
  const busy = AB.render_about(c, deps);
  assert.equal(find_all(busy, (n) => n.attrs.id === 'ab-calc')[0].hasAttribute('disabled'), true);
  assert.equal(find_all(busy, (n) => n.attrs.id === 'ab-calc-msg')[0].textContent, 'Считаю…');
  release();
  await tick();
  assert.equal(find_all(AB.render_about(c, deps), (n) => n.attrs.id === 'ab-calc')[0].hasAttribute('disabled'), false);
});

test('REQ-117 фокус: после нажатия кнопки перерисовка возвращает фокус на кнопку, если он потерян (WCAG 2.4.3)', async () => {
  const pwa = fake_pwa({ status: 'active' });
  const deps = AB.make_deps({ pwa, calc: { analyze: async () => ({}) }, build: BI.BUILD });
  const c = stub_ctx();
  const root = AB.render_about(c, deps);
  find_all(root, (n) => n.attrs.id === 'ab-check')[0].listeners.click[0]();
  document.activeElement = document.body;
  // реальная страница заменит узлы и вернёт фокус: проверяем, что хранитель знает, куда
  assert.equal(deps.focus.pending(), 'ab-check');
});

test('REQ-154 pack_fp12.register: экран и хук boot регистрируются один раз; PWA стартует в boot и не обращается к чужим регистрациям; обновление состояния перерисовывает только экран «О программе»', async () => {
  const added = { views: [], hooks: [], css: [], i18n: [] };
  const fake_ext = {
    ctx: { tr: (k) => k, refresh() { added.refreshes = (added.refreshes ?? 0) + 1; } },
    register_i18n: (ns) => added.i18n.push(ns), ensure_css: (h) => added.css.push(h), register_view: (d) => added.views.push(d), register_hook: (n, f) => added.hooks.push([n, f]),
  };
  const pwa = fake_pwa({ status: 'idle' });
  let subscribed = null;
  pwa.subscribe = (fn) => { subscribed = fn; return () => {}; };
  let started = 0;
  pwa.start = async () => { started += 1; return {}; };
  const deps = PACK.register(fake_ext, { pwa, calc: { analyze: async () => ({}) }, build: BI.BUILD });
  assert.deepEqual(added.i18n, ['about']);
  assert.deepEqual(added.css, ['css/about.css']);
  assert.equal(added.views.length, 1);
  assert.deepEqual([added.views[0].id, added.views[0].title_key, added.views[0].order], ['about', 'about.nav', 180]);
  assert.deepEqual(added.hooks.map((h) => h[0]), ['boot']);
  assert.equal(started, 0, 'до boot воркер не запускается');
  added.hooks[0][1]();
  assert.equal(started, 1);
  location.hash = '#data';
  subscribed({});
  assert.equal(added.refreshes ?? 0, 0, 'на других экранах перерисовки нет (ввод в формах не трогаем)');
  location.hash = '#about';
  subscribed({});
  assert.equal(added.refreshes, 1);
  location.hash = '';
  assert.equal(typeof deps.pwa.snapshot, 'function');
  // стили пакета: только токены тем, без цвета-литералов, без скрытия и перестановки порядка
  const css = read('demo', 'css', 'about.css');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(|!important|display:\s*none(?!\s*;\s*})|\border\s*:/.test(css.replace(/#ab-\w+:empty[^}]*\}/g, '')), css);
  assert.ok(!/https?:|@import|url\(/.test(css));
});

// ── исправления после независимой проверки (ADV-04, ADV-05, тексты о сети и хэше) ──────────────────────────────────────────

test('REQ-117 исправление ADV-05: установка найденной версии и её отказ названы на экране (RU и EN); отказ первой установки не обещает, что «работает прежняя»', () => {
  for (const lang of ['ru', 'en']) {
    const tr = tr_of(lang);
    const base = { status: 'active', cached: 138, total: 138 };
    const plain_text = AB.pwa_text(tr, base);
    const installing = AB.pwa_text(tr, { ...base, installing: true });
    const failed = AB.pwa_text(tr, { ...base, reason: 'install_failed' });
    assert.ok(installing.startsWith(plain_text) && installing.length > plain_text.length + 30, lang + ': к «k из n» добавлено, что версия устанавливается');
    assert.ok(failed.startsWith(plain_text) && failed.length > plain_text.length + 30, lang + ': к «k из n» добавлено, что установка не прошла');
    assert.notEqual(installing, failed);
    for (const t of [installing, failed]) assert.ok(!/\{[a-z_]+\}/.test(t) && !/^about\./.test(t), lang + ': ' + t);
    assert.match(failed, lang === 'ru' ? /установка новой версии не прошла, работает прежняя/ : /installing the new version failed, the previous one keeps working/);
    // первая установка не прошла: прежней версии нет
    const first = AB.pwa_text(tr, { status: 'error', reason: 'install_failed' });
    assert.ok(!/работает прежняя|previous one keeps working/.test(first), lang + ': ' + first);
    assert.match(first, lang === 'ru' ? /офлайн-копии на устройстве пока нет/ : /no offline copy on this device yet/);
    // найденная версия ждёт применения: отказ и установка не затеняют «Обновить»
    assert.equal(AB.pwa_text(tr, { status: 'update_ready', installing: false, reason: 'install_failed' }), AB.pwa_text(tr, { status: 'update_ready' }));
  }
});

test('REQ-117 исправление ADV-04: итог «Проверить обновление» считается по ТЕКУЩЕМУ состоянию воркера и меняется сам, без нового нажатия: «идёт установка» → «найдена новая версия»; отказ установки — «не установилась»; «Новой версии нет.» только когда её правда нет', async () => {
  const msg_of = (root) => find_all(root, (n) => n.attrs.id === 'ab-check-msg')[0].textContent;
  const state_of = (root) => find_all(root, (n) => n.attrs.id === 'ab-pwa')[0].textContent;
  // check_update вернулся, а найденная версия ещё устанавливается (так ведёт себя registration.update())
  const pwa = fake_pwa({ status: 'active', cached: 138, total: 138 });
  pwa.check_update = async () => { pwa.calls.check += 1; pwa.st.installing = true; return { ...pwa.st }; };
  const deps = AB.make_deps({ pwa, calc: { analyze: async () => ({}) }, build: BI.BUILD });
  const c = stub_ctx();
  find_all(AB.render_about(c, deps), (n) => n.attrs.id === 'ab-check')[0].listeners.click[0]();
  await tick();
  let root = AB.render_about(c, deps);
  assert.equal(msg_of(root), 'Найдена новая версия, идёт её установка: состояние обновится на этом экране.');
  assert.notEqual(msg_of(root), 'Новой версии нет.');
  assert.match(state_of(root), /Идёт установка найденной версии/);
  // установка закончилась: экран перерисован по подписке (без нажатия кнопки) — итог тот же, что и в строке состояния
  pwa.st.installing = false;
  pwa.st.status = 'update_ready';
  root = AB.render_about(c, deps);
  assert.equal(msg_of(root), 'Найдена новая версия: кнопка «Обновить» её применит.');
  assert.match(state_of(root), /Доступна новая версия оболочки/);
  assert.ok(find_all(root, (n) => n.attrs.id === 'ab-update').length === 1);
  // установка не прошла
  pwa.st.status = 'active';
  pwa.st.reason = 'install_failed';
  root = AB.render_about(c, deps);
  assert.equal(msg_of(root), 'Новая версия найдена, но не установилась. Проверьте ещё раз позже.');
  assert.match(state_of(root), /Найдена новая версия, но установка новой версии не прошла, работает прежняя/);
  // и только когда новой версии нет, так и сказано
  pwa.st.reason = null;
  assert.equal(msg_of(AB.render_about(c, deps)), 'Новой версии нет.');
  // нажатие «Обновить»/новая проверка заменяют итог своим сообщением, а не пересчитанным
  pwa.st.status = 'update_ready';
  find_all(AB.render_about(c, deps), (n) => n.attrs.id === 'ab-update')[0].listeners.click[0]();
  assert.equal(msg_of(AB.render_about(c, deps)), 'Применяю новую версию: страница перезагрузится.');
  // EN
  const en = stub_ctx('en');
  pwa.st.status = 'active';
  pwa.st.installing = true;
  pwa.check_update = async () => ({ ...pwa.st });
  const d2 = AB.make_deps({ pwa, calc: { analyze: async () => ({}) }, build: BI.BUILD });
  find_all(AB.render_about(en, d2), (n) => n.attrs.id === 'ab-check')[0].listeners.click[0]();
  await tick();
  assert.equal(msg_of(AB.render_about(en, d2)), 'A new version was found and is being installed: this screen will update.');
  // чистая функция итога
  for (const lang of ['ru', 'en']) {
    const tr = tr_of(lang);
    const cases = [{ status: 'error' }, { status: 'update_ready' }, { status: 'active', installing: true }, { status: 'active', reason: 'install_failed' }, { status: 'active' }];
    const texts = cases.map((s) => AB.check_result_text(tr, s));
    assert.equal(new Set(texts).size, cases.length, lang + ': у каждого итога свой текст');
    for (const t of texts) assert.ok(t.length > 8 && !/^about\./.test(t) && !/\{[a-z_]+\}/.test(t), lang + ': ' + t);
  }
});

test('REQ-120 REQ-154 исправление: тексты о сети и хэше сборки не сильнее кода — названы чтение файлов оболочки и наборов данных с того же хоста; хэш охватывает воркер без штампа, build_info.mjs назван отдельно', async () => {
  const cat = (await imp('demo', 'i18n', 'about.mjs')).default;
  assert.match(cat.ru['about.net_1'], /кроме проверки обновления оболочки на собственном хосте и чтения файлов самой оболочки \(например, выбранного набора данных\) с него же/);
  assert.match(cat.en['about.net_1'], /except a check for a shell update on its own host and reading shell files \(for example, a chosen dataset\) from that same host/);
  assert.match(cat.ru['about.build_note'], /текста воркера sw\.js без штампа/);
  assert.match(cat.ru['about.build_note'], /build_info\.mjs[^.]*в хэш не входит/);
  assert.match(cat.en['about.build_note'], /text of the sw\.js worker without its stamp/);
  assert.match(cat.en['about.build_note'], /build_info\.mjs[^.]*is not part of the hash/);
  // подвал страницы больше не утверждает «сеть не используется»: страница читает файлы со своего хоста
  const i18n = read('demo', 'i18n.mjs');
  assert.ok(!/сеть не используется|the network is not used/.test(i18n), 'старая формулировка подвала убрана');
  for (const lang of ['ru', 'en']) {
    const footer = I18N.t(lang, 'app.footer', { version: '0.1.0', hash: 'abcd1234' });
    assert.match(footer, lang === 'ru' ? /данные никуда не отправляются, файлы страница читает только с собственного хоста/ : /not sent anywhere, and the page reads files only from its own host/);
  }
  // каждый новый ключ каталога есть в обоих языках и используется кодом экрана литералом
  const src = read('demo', 'about.mjs');
  for (const key of ['about.st_installing', 'about.st_update_failed', 'about.reason_first_install_failed', 'about.checked_installing', 'about.checked_failed']) {
    assert.ok(key in cat.ru && key in cat.en, key);
    assert.ok(src.includes("'" + key + "'"), key + ' используется литералом');
    assert.match(cat.ru[key], /[А-Яа-яЁё]/);
  }
  assert.equal(cat.ru['about.st_update_failed'].match(/\{[a-z_]+\}/g).join(), cat.en['about.st_update_failed'].match(/\{[a-z_]+\}/g).join());
});

// ── FP-27: строка о плане «если разработчик исчез» (REQ-186) ──────────────────────────────────────────────────────────────

test('REQ-186 FP-27 экран «О программе» показывает строку о плане «если разработчик исчез» (about.legal_4) на RU и EN рядом с прежними тремя; путь к странице вики назван текстом, ссылок на вики нет', async () => {
  for (const lang of ['ru', 'en']) {
    lang_button(lang).listeners.click[0]();
    await go('#about');
    const legal = by_id('ab-legal-title');
    assert.ok(legal !== undefined, lang + ': раздел «Лицензии и сведения»');
    const section = find_all(main(), (n) => n.tagName === 'section' && n.attrs['aria-labelledby'] === 'ab-legal-title')[0];
    const items = find_all(section, (n) => n.tagName === 'li').map((n) => text_of(n));
    assert.equal(items.length, 4, lang + ': четыре строки блока');
    const cat = (await imp('demo', 'i18n', 'about.mjs')).default[lang];
    assert.deepEqual(items, [1, 2, 3, 4].map((i) => cat['about.legal_' + i].replace(/[  ]/g, ' ')));
    assert.match(items[3], /wiki\/product\/20-if-developer-disappears\.md/);
    assert.equal(find_all(main(), (n) => n.tagName === 'a').length, 0, lang + ': на экране нет ссылок (вики не входит в оболочку)');
  }
  lang_button('ru').listeners.click[0]();
  await go('#about');
});
