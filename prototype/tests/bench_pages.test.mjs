// bench_pages.test.mjs — FP-23 (REQ-150, REQ-152, REQ-157): страницы bench.html, coldstart.html, compat.html и их модули (bench_page, coldstart_page, compat_page, probe_kit, bench_model).
// Браузера нет: страницы проверяются статически (CSP, нет inline-кода и внешних адресов, одно сетевое обращение), каталоги строк — на полноту семейств ключей,
// а поведение — на заглушке DOM с подменёнными портами (часы, окно, клиент воркера, IndexedDB). Замеры на устройствах эти тесты НЕ выполняют и не заменяют: числа, которые
// они видят, — арифметика заглушек. Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROTO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO = path.join(PROTO, 'demo');
const read = (...p) => fs.readFileSync(path.join(PROTO, ...p), 'utf8');
const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);

// Модули импортируются ДО установки заглушки DOM: иначе страницы запустились бы сами (проверка на `document` в конце каждого модуля).
const MODEL = await imp('demo', 'bench_model.mjs');
const KIT = await imp('demo', 'probe_kit.mjs');
const BENCH = await imp('demo', 'bench_page.mjs');
const COLD = await imp('demo', 'coldstart_page.mjs');
const COMPAT = await imp('demo', 'compat_page.mjs');
const BM = await imp('tools', 'build_manifest.mjs');
const { analyze } = await imp('engine', 'index.mjs');
const { create_calc_client } = await imp('demo', 'worker_client.mjs');
const CAT = {
  probe: (await imp('demo', 'i18n', 'probe.mjs')).default,
  benchpg: (await imp('demo', 'i18n', 'benchpg.mjs')).default,
  coldpg: (await imp('demo', 'i18n', 'coldpg.mjs')).default,
  compatpg: (await imp('demo', 'i18n', 'compatpg.mjs')).default,
};
const VOCAB = JSON.parse(read('engine', 'vocab.json'));
const G001 = JSON.parse(read('data', 'g001.json'));
const UA = 'TestUA/1.0 (Test; <script>alert(1)</script> | x)';

// ── заглушка DOM ────────────────────────────────────────────────────────────────────────────────────────────────────────

class El {
  constructor(tag) { this.nodeType = 1; this.tagName = tag; this.attrs = {}; this.children = []; this.listeners = {}; this.className = ''; this._text = ''; this._value = ''; this.parent = null; this.focused = false; this.selected = false; }
  get textContent() { return this.children.length === 0 ? this._text : this.children.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get value() { return this._value; }
  set value(v) { this._value = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  append(...kids) { for (const k of kids) { if (k.nodeType === 1) k.parent = this; this.children.push(k); } this._text = ''; }
  replaceChildren(...kids) { this.children = []; this._text = ''; this.append(...kids); }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  focus() { this.focused = true; }
  select() { this.selected = true; }
  remove() { if (this.parent !== null) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  walk(fn) { fn(this); for (const c of this.children) if (c.nodeType === 1) c.walk(fn); }
}
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const doc = {
  createElement: (t) => new El(t),
  createTextNode: (data) => ({ nodeType: 3, data }),
  documentElement: new El('html'),
  body: new El('body'),
  title: '',
  getElementById(id) { return find_all(this.body, (n) => n.attrs.id === id)[0] ?? null; },
};
globalThis.document = doc;

/** Каркас страницы: main, кнопки языка, при необходимости место для вложенного окна. */
function reset_dom(prefix, extra = []) {
  const mk = (id) => { const e = new El('div'); e.setAttribute('id', id); return e; };
  doc.body.replaceChildren(mk('main'), mk(prefix + '-lang-ru'), mk(prefix + '-lang-en'), ...extra.map(mk));
  doc.title = '';
}
const by_id = (id) => doc.getElementById(id);
const text_of = (id) => by_id(id)?.textContent ?? null;
const value_of = (id) => by_id(id)?.value ?? null; // значение текстового поля (его textContent у заглушки пуст)
const click = async (id) => { const el = by_id(id); assert.ok(el, 'нет элемента ' + id); for (const fn of el.listeners.click ?? []) await fn(); };
const until = async (pred, ms = 8000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) assert.fail('не дождались'); await new Promise((r) => setTimeout(r, 2)); } };

function fake_window({ ua = UA, lang = 'ru-RU', clipboard = 'ok', over = {} } = {}) {
  const written = [];
  const nav = {
    userAgent: ua, language: lang, platform: 'TestOS', hardwareConcurrency: 8, deviceMemory: 4, onLine: true,
    clipboard: clipboard === 'ok' ? { writeText: async (t) => { written.push(t); } } : clipboard === 'deny' ? { writeText: async () => { throw new Error('denied'); } } : undefined,
  };
  return { document: doc, navigator: nav, screen: { width: 360, height: 800 }, devicePixelRatio: 3, isSecureContext: true, performance: { now: () => performance.now() }, setTimeout, clearTimeout, setInterval, clearInterval, written, ...over };
}

// ── 1. статика: страницы ────────────────────────────────────────────────────────────────────────────────────────────────

const PAGES = [
  { file: 'bench.html', mod: 'bench_page.mjs', csp: { 'default-src': "'none'", 'script-src': "'self'", 'style-src': "'self'", 'img-src': "'self' data:", 'connect-src': "'self'", 'base-uri': "'none'", 'form-action': "'none'" } },
  { file: 'coldstart.html', mod: 'coldstart_page.mjs', csp: { 'default-src': "'none'", 'script-src': "'self'", 'style-src': "'self'", 'img-src': "'self' data:", 'connect-src': "'none'", 'frame-src': "'self'", 'base-uri': "'none'", 'form-action': "'none'" } },
  { file: 'compat.html', mod: 'compat_page.mjs', csp: { 'default-src': "'none'", 'script-src': "'self'", 'style-src': "'self'", 'img-src': "'self' data:", 'connect-src': "'none'", 'worker-src': "'self'", 'base-uri': "'none'", 'form-action': "'none'" } },
];
const csp_map = (csp) => Object.fromEntries(csp.split(';').map((s) => s.trim()).filter(Boolean).map((d) => { const [name, ...vals] = d.split(/\s+/); return [name, vals.join(' ')]; }));

test('REQ-150 REQ-152 REQ-157 TST-59 страницы замеров: CSP только self (ровно перечисленные директивы), нет inline-кода, обработчиков, внешних адресов; ссылки только на свои файлы', () => {
  for (const p of PAGES) {
    const html = read('demo', p.file);
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1];
    assert.ok(csp, p.file + ': есть мета CSP');
    assert.deepEqual(csp_map(csp), p.csp, p.file + ': политика');
    assert.ok(!/unsafe|\*|https?:/.test(csp), p.file + ': CSP без unsafe-* и внешних источников');
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) { assert.match(m[1], /\bsrc="[^"]+"/); assert.equal(m[2].trim(), '', p.file + ': inline-скрипта нет'); }
    assert.ok(!/<style\b/i.test(html) && !/\sstyle\s*=/.test(html), p.file + ': нет inline-стилей');
    assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(html), p.file + ': нет атрибутов-обработчиков');
    assert.ok(!/https?:\/\/(?!www\.w3\.org\/2000\/svg)/.test(html.replace(/<!--[\s\S]*?-->/g, '')), p.file + ': внешних адресов нет');
    const refs = [...html.matchAll(/\b(?:src|href)="([^"#]+)"/g)].map((m) => m[1]).filter((v) => v !== 'data:,' && !v.startsWith('#'));
    assert.deepEqual(refs.sort(), ['css/probe.css', p.mod, 'style.css'].sort(), p.file + ': ссылки');
    for (const r of refs) assert.ok(fs.existsSync(path.join(DEMO, r)), p.file + ': нет файла ' + r);
    assert.match(html, /<html lang="ru">/);
    assert.match(html, new RegExp(`id="${{ 'bench.html': 'bn', 'coldstart.html': 'cs', 'compat.html': 'cp' }[p.file]}-title-bar"`));
    assert.match(html, /<noscript>[\s\S]*Loading|<noscript>/);
  }
  // страница замера холодного старта: место для вложенного окна вне перерисовываемого блока
  assert.match(read('demo', 'coldstart.html'), /<div id="cs-frame-box" class="probe-frame-box"><\/div>/);
  // страницы не просят ни манифеста, ни лишних директив: у compat — воркер, у coldstart — окно, у bench — только свой хост
  assert.ok(!('worker-src' in csp_map(/content="([^"]+)"/.exec(read('demo', 'bench.html').match(/http-equiv="Content-Security-Policy"[^>]*>/)[0])[1])));
});

test('REQ-120 REQ-154 страницы замеров входят в список оболочки: точки входа сборки, манифест хэшей, обход ссылок без пропущенных и внешних файлов', () => {
  for (const p of ['demo/bench.html', 'demo/coldstart.html', 'demo/compat.html']) assert.ok(BM.SEEDS.includes(p), 'SEEDS: ' + p);
  const man = JSON.parse(read('demo', 'shell_manifest.json'));
  const names = new Set([...man.files.map((f) => f.path), ...man.stamped.map((f) => f.path)]);
  for (const f of ['demo/bench.html', 'demo/coldstart.html', 'demo/compat.html', 'demo/bench_page.mjs', 'demo/coldstart_page.mjs', 'demo/compat_page.mjs', 'demo/bench_model.mjs', 'demo/probe_kit.mjs',
    'demo/i18n/probe.mjs', 'demo/i18n/benchpg.mjs', 'demo/i18n/coldpg.mjs', 'demo/i18n/compatpg.mjs', 'demo/css/probe.css', 'data/g001.json']) assert.ok(names.has(f), 'в манифесте: ' + f);
  const c = BM.collect_shell(PROTO);
  assert.deepEqual(c.missing, []);
  assert.deepEqual(c.outside, []);
  assert.equal(BM.check_build(PROTO).ok, true, 'манифест актуален');
});

test('REQ-120 TST-59 модули страниц замеров: нет innerHTML, eval, inline-стилей, хранилищ, создания воркеров; ровно одно сетевое обращение — чтение G-001 в bench_page; строка браузера читается только в probe_kit', () => {
  const files = ['bench_model.mjs', 'probe_kit.mjs', 'bench_page.mjs', 'coldstart_page.mjs', 'compat_page.mjs'];
  const code_of = (src) => src.replace(/(^|\s)\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const f of files) {
    const src = read('demo', f);
    const code = code_of(src);
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'srcdoc', 'eval(', 'new Function', 'document.write', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'EventSource', 'importScripts', 'localStorage', 'sessionStorage', 'document.cookie', 'new Worker', 'serviceWorker.register', 'getRegistrations', 'caches.delete', 'caches.keys', '.persist()']) {
      assert.ok(!code.includes(bad), `demo/${f}: ${bad}`);
    }
    assert.ok(!/setAttribute\(\s*['"]style['"]/.test(code) && !/\.style\.cssText|\.insertRule\(/.test(code), f + ': нет правки стилей из кода');
    assert.ok(!/https?:\/\//.test(code), f + ': внешних адресов нет');
    assert.ok(!/(?<![\w.])import\(/.test(code), f + ': динамического import() нет');
    assert.equal((code.match(/\bfetch\s*\(/g) ?? []).length, f === 'bench_page.mjs' ? 1 : 0, f + ': число вызовов fetch');
    assert.equal(/\buserAgent\b/.test(code), f === 'probe_kit.mjs', f + ': строка браузера читается только в probe_kit');
  }
  // единственный fetch — набор G-001 с того же хоста
  assert.match(read('demo', 'bench_page.mjs'), /new URL\('\.\.\/data\/g001\.json', base\)/);
  // общая арифметика замеров — чистая: ни часов, ни случайности, ни процесса, ни сети (время даёт порт now)
  const model = code_of(read('demo', 'bench_model.mjs'));
  for (const bad of ['Date', 'Math.random', 'performance', 'process', 'node:', 'fetch', 'setTimeout', 'navigator', 'document', 'window']) assert.ok(!new RegExp('\\b' + bad.replace('.', '\\.')).test(model), 'bench_model: ' + bad);
  // пробная база и замок — с префиксом runway; чужие базы, кэши и ключи страницы не трогают
  assert.match(COMPAT.PROBE_NAME, /^runway-/);
  const compat_code = code_of(read('demo', 'compat_page.mjs'));
  assert.deepEqual([...compat_code.matchAll(/deleteDatabase\(([^)]*)\)/g)].map((m) => m[1]), ['PROBE_NAME']);
  assert.ok(!/\.persist\(\)/.test(compat_code), 'persist() не вызывается');
});

test('FP-23 TST-56 каталоги probe, benchpg, coldpg, compatpg: паритет RU/EN и плейсхолдеров, русские буквы в RU, семейства ключей полны и без лишних, нет запрещённых формулировок и обещаний времени', () => {
  const ph = (s) => [...s.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]).sort();
  const src = ['bench_page.mjs', 'coldstart_page.mjs', 'compat_page.mjs', 'probe_kit.mjs'].map((f) => read('demo', f)).join('\n');
  for (const [ns, cat] of Object.entries(CAT)) {
    assert.deepEqual(Object.keys(cat.ru).sort(), Object.keys(cat.en).sort(), ns + ': наборы ключей RU и EN');
    for (const k of Object.keys(cat.ru)) {
      assert.ok(k.startsWith(ns + '.'), `${ns}: ключ ${k} вне пространства`);
      assert.deepEqual(ph(cat.ru[k]), ph(cat.en[k]), 'плейсхолдеры ' + k);
      assert.ok(cat.ru[k].trim() !== '' && cat.en[k].trim() !== '', 'пустая строка ' + k);
      const letters = cat.ru[k].replace(/\{[A-Za-z0-9_]+\}/g, '').replace(/[^A-Za-zА-Яа-яЁё]/g, '');
      if (letters !== '') assert.match(cat.ru[k], /[А-Яа-яЁё]/, 'RU без русских букв: ' + k);
      for (const lang of ['ru', 'en']) assert.ok(!/(за|in)\s+\d+\s+(минут|minutes)/i.test(cat[lang][k]), 'обещание времени: ' + k);
      assert.ok(src.includes(`'${k}'`) || Object.keys(CAT).some(() => [...src.matchAll(/'([a-z0-9]+\.[a-z0-9_]*)'\s*\+/g)].some((m) => k.startsWith(m[1]))), 'ключ без использования: ' + k);
    }
  }
  const family = (ns, prefix) => Object.keys(CAT[ns].ru).filter((k) => k.startsWith(ns + '.' + prefix));
  assert.deepEqual(family('compatpg', 'f_').map((k) => k.slice(11)).sort(), [...COMPAT.FEATURES].sort(), 'названия возможностей');
  assert.deepEqual(family('compatpg', 'st_').map((k) => k.slice(12)).sort(), [...COMPAT.STATUSES].sort());
  assert.deepEqual(family('compatpg', 'd_').map((k) => k.slice(11)).sort(), [...COMPAT.DETAIL_CODES].sort(), 'подробности');
  assert.deepEqual(family('compatpg', 'reason_').map((k) => k.slice(16)).sort(), [...COMPAT.REASON_CODES].sort(), 'причины отката');
  assert.deepEqual(family('benchpg', 'set_').map((k) => k.slice(12)).sort(), ['g001', ...MODEL.SYNTH_POINTS.map((p) => p.id)].sort(), 'названия наборов');
  assert.deepEqual(family('benchpg', 'nc_').map((k) => k.slice(11)).sort(), ['error', 'g001_unavailable', 'stopped']);
  assert.deepEqual(family('coldpg', 'nc_').map((k) => k.slice(10)).sort(), ['blocked', 'error', 'other', 'timeout']);
  // запрещённые формулировки (vocab.json) и оговорка
  const corpus = [...Object.values(CAT).flatMap((c) => [...Object.values(c.ru), ...Object.values(c.en)]), ...PAGES.map((p) => read('demo', p.file)), src].join('\n').toLowerCase().replace(/ё/g, 'е');
  for (const phrase of VOCAB.forbidden_phrases) assert.ok(!corpus.includes(phrase.toLowerCase().replace(/ё/g, 'е')), `запрещено: «${phrase}»`);
  for (const w of ['спокойно', 'hallucinat', 'guarantee', 'risk-free', 'exact figures']) assert.ok(!corpus.includes(w), w);
  assert.match(CAT.probe.ru['probe.disclaimer'], /не консультация/);
  assert.match(CAT.probe.en['probe.disclaimer'], /not advice/);
  assert.match(CAT.probe.ru['probe.disclaimer'], /ничего не измеряет, пока вы не нажмёте/);
});

// ── 2. общие помощники ───────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-150 probe_kit: сведения об устройстве (недоступное — null), местная дата, язык, число в мс по языку; строка браузера остаётся строкой как есть', () => {
  const info = KIT.device_info(fake_window());
  assert.equal(info.user_agent, UA);
  assert.deepEqual([info.cores, info.memory_gb, info.screen, info.pixel_ratio, info.secure_context, info.online, info.platform, info.language], [8, 4, '360×800', 3, true, true, 'TestOS', 'ru-RU']);
  assert.deepEqual(Object.values(KIT.device_info({})), [null, null, null, null, null, null, null, null, null]);
  assert.equal(KIT.device_info({ navigator: { userAgent: '', hardwareConcurrency: NaN } }).user_agent, null);
  assert.equal(KIT.local_date_iso(() => new Date(2026, 0, 5, 23, 59)), '2026-01-05', 'местная дата, не UTC');
  assert.equal(KIT.local_date_iso(() => new Date(2026, 11, 31, 0, 0)), '2026-12-31');
  assert.equal(KIT.lang_of({ navigator: { language: 'en-GB' } }), 'en');
  assert.equal(KIT.lang_of({ navigator: { language: 'ru-RU' } }), 'ru');
  assert.equal(KIT.lang_of({}), 'ru');
  assert.equal(KIT.ms_text('ru', 12.346), '12,35');
  assert.equal(KIT.ms_text('en', 12.3), '12.3');
  assert.equal(KIT.ms_text('ru', null), 'неизвестно');
  assert.equal(KIT.ms_text('en', NaN), 'unknown');
  assert.equal(KIT.tr('ru', 'probe.unknown'), 'неизвестно');
  assert.equal(KIT.tr('xx', 'probe.yes'), 'да', 'неизвестный язык читается как русский');
  assert.equal(KIT.tr('ru', 'probe.нет-такого'), 'probe.нет-такого', 'неизвестный ключ виден как есть');
  assert.equal(KIT.tr('ru', 'probe.memory_val', { gb: 4 }), 'около 4 ГБ');
});

test('REQ-150 probe_kit: буфер обмена — записано, отказ и отсутствие дают понятный итог; при отказе поле выделено, а не молча пусто', async () => {
  const ok = fake_window();
  assert.equal(await KIT.copy_text('abc', ok), 'copied');
  assert.deepEqual(ok.written, ['abc']);
  assert.equal(await KIT.copy_text('abc', fake_window({ clipboard: 'deny' })), 'manual');
  assert.equal(await KIT.copy_text('abc', fake_window({ clipboard: 'none' })), 'manual');
  assert.equal(await KIT.copy_text('abc', {}), 'manual');
  reset_dom('bn');
  const env = fake_window({ clipboard: 'deny' });
  const card = KIT.copy_card('ru', { out: 'x-out', btn: 'x-btn', status: 'x-st' }, () => 'ТЕКСТ', { env, doc });
  by_id('main').append(card);
  assert.equal(by_id('x-out').value, 'ТЕКСТ');
  assert.equal(by_id('x-out').attrs.readonly, '', 'поле только для чтения');
  await click('x-btn');
  assert.equal(by_id('x-out').selected, true);
  assert.equal(by_id('x-out').focused, true);
  assert.equal(text_of('x-st'), CAT.probe.ru['probe.copy_manual']);
  const env2 = fake_window();
  by_id('main').replaceChildren(KIT.copy_card('en', { out: 'y-out', btn: 'y-btn', status: 'y-st' }, () => 'TEXT', { env: env2, doc }));
  await click('y-btn');
  assert.deepEqual(env2.written, ['TEXT']);
  assert.equal(text_of('y-st'), CAT.probe.en['probe.copied']);
});

// ── 3. bench.html ──────────────────────────────────────────────────────────────────────────────────────────────────────

const bench_ports = (env, over = {}) => ({ ...BENCH.make_ports(env), clock: () => new Date(2026, 9, 23, 12), load_g001: async () => structuredClone(G001), yield_ui: async () => {}, ...over });
const tiny_plan = { tiny: { samples: 2, rounds: 1, warmup: 1 } };

test('REQ-150 load_g001: читает набор с того же хоста по относительному адресу; ответ не ok — исключение (страница отметит «G-001 недоступен»)', async () => {
  const seen = [];
  const got = await BENCH.load_g001(async (u) => { seen.push(String(u)); return { ok: true, json: async () => ({ x: 1 }) }; }, 'http://localhost/01/301/runway/prototype/demo/bench_page.mjs');
  assert.deepEqual(got, { x: 1 });
  assert.deepEqual(seen, ['http://localhost/01/301/runway/prototype/data/g001.json']);
  await assert.rejects(BENCH.load_g001(async () => ({ ok: false, json: async () => ({}) })), /g001_http/);
});

test('REQ-150 REQ-151 bench.html: замер на G-001 и трёх синтетических наборах — запись runway-bench-device/1 с устройством, датой, n, p50/p95 и ростом при удвоении; текст для копирования — тот же JSON', async () => {
  reset_dom('bn');
  const env = fake_window();
  const page = BENCH.make_page('ru', bench_ports(env));
  page.plans = tiny_plan;
  page.plan = 'tiny';
  BENCH.render_page(page);
  assert.equal(by_id('bn-run').attrs['aria-disabled'], 'false');
  assert.equal(by_id('bn-stop').attrs['aria-disabled'], 'true');
  assert.equal(text_of('bn-status'), CAT.benchpg.ru['benchpg.status_idle']);
  assert.equal(by_id('bn-results').children.length, 0, 'до нажатия кнопки ничего не измерено');
  const rep = await BENCH.run_bench(page);
  assert.equal(rep.format, 'runway-bench-device/1');
  assert.equal(MODEL.DEVICE_FORMAT, rep.format);
  assert.equal(rep.device, UA, 'строка браузера как есть');
  assert.equal(rep.date, '2026-10-23');
  assert.equal(rep.n, 2);
  assert.equal(rep.engine_version, (await imp('engine', 'index.mjs')).ENGINE_VERSION);
  assert.deepEqual(rep.sets.map((s) => s.id), ['g001', 'n1k', 'n2k', 'n4k']);
  for (const s of rep.sets) {
    assert.equal(s.n, 2);
    assert.ok(s.events > 0, s.id);
    for (const k of ['analyze', 'recompute_q3']) assert.ok(s[k].p50_ms >= 0 && s[k].p50_ms <= s[k].p95_ms && s[k].min_ms <= s[k].max_ms, s.id + ' ' + k);
  }
  assert.equal(rep.sets[0].events, analyze(G001, { as_of: G001.as_of }).events.plan.length, 'G-001 — настоящий набор канона');
  assert.deepEqual(rep.budget, MODEL.BUDGET);
  assert.equal(rep.doubling.steps.length, 2);
  assert.equal(rep.doubling.limit, 2.5);
  assert.ok(rep.env.cores === 8 && rep.env.screen === '360×800' && !('user_agent' in rep.env), 'env без строки браузера (она в поле device)');
  assert.deepEqual(rep.notes, []);
  assert.equal(page.busy, false);
  assert.equal(by_id('bn-run').attrs['aria-disabled'], 'false', 'кнопка снова доступна, тот же узел');
  assert.equal(text_of('bn-status'), 'Замер закончен: наборов 4, n = 2 на набор.');
  assert.equal(value_of('bn-out'), JSON.stringify(rep, null, 2), 'в поле — тот же JSON, что получит буфер обмена');
  // экран: четыре строки наборов, таблица роста, устройство и заметки
  const tables = find_all(by_id('bn-results'), (n) => n.tagName === 'table');
  assert.equal(tables.length, 3, 'устройство, наборы, рост');
  assert.equal(find_all(tables[1], (n) => n.tagName === 'tr').length, 1 + 4);
  assert.equal(find_all(tables[2], (n) => n.tagName === 'tr').length, 1 + 2);
  const shown = by_id('bn-results').textContent;
  assert.ok(shown.includes(UA), 'строка браузера показана на экране как текст');
  assert.equal(find_all(doc.body, (n) => n.tagName === 'script').length, 0, 'разметка из строки не вставлялась');
  assert.match(shown, /Бюджет p95 не более 100 мс относится к набору около 10³/);
  // копирование
  await click('bn-copy');
  assert.deepEqual(env.written, [JSON.stringify(rep, null, 2)]);
  assert.equal(text_of('bn-copy-status'), CAT.probe.ru['probe.copied']);
});

test('REQ-150 bench.html: бюджет оценивается только по наборам около 10³ событий; наборы больше нужны для роста; within_budget — null без таких наборов', () => {
  const set = (id, a, q) => ({ id, events: 1, n: 1, analyze: { p95_ms: a }, recompute_q3: { p95_ms: q } });
  assert.equal(MODEL.within_budget([set('g001', 5, 5), set('n1k', 99, 100), set('n4k', 900, 900)]), true, 'большой набор бюджет не портит');
  assert.equal(MODEL.within_budget([set('g001', 5, 5), set('n1k', 99, 100.01)]), false);
  assert.equal(MODEL.within_budget([set('n4k', 1, 1)]), null);
  assert.equal(MODEL.within_budget([]), null);
});

test('REQ-150 bench.html: G-001 недоступен — измерены синтетические наборы и в записи пометка; повторный запуск во время замера отвергается; «Остановить» даёт неполный результат с пометкой', async () => {
  reset_dom('bn');
  const env = fake_window();
  const page = BENCH.make_page('ru', bench_ports(env, { load_g001: async () => { throw new Error('нет сети'); } }));
  page.plans = tiny_plan;
  page.plan = 'tiny';
  BENCH.render_page(page);
  const rep = await BENCH.run_bench(page);
  assert.deepEqual(rep.sets.map((s) => s.id), ['n1k', 'n2k', 'n4k']);
  assert.deepEqual(rep.notes, ['g001_unavailable']);
  assert.match(by_id('bn-results').textContent, /Набор G-001 не удалось прочитать с этого хоста/);
  assert.equal(by_id('bn-results').textContent.includes('нет сети'), false, 'текст исключения на экран не попадает');

  // повторный запуск и остановка
  let release = null;
  const gate = new Promise((r) => { release = r; });
  let yields = 0;
  const page2 = BENCH.make_page('en', bench_ports(env, { yield_ui: async () => { yields += 1; if (yields === 1) await gate; } }));
  page2.plans = tiny_plan;
  page2.plan = 'tiny';
  BENCH.render_page(page2);
  const first = BENCH.run_bench(page2);
  await until(() => yields >= 1);
  assert.equal(page2.busy, true);
  assert.equal(by_id('bn-run').attrs['aria-disabled'], 'true');
  assert.equal(by_id('bn-stop').attrs['aria-disabled'], 'false');
  assert.equal(await BENCH.run_bench(page2), null, 'второй запуск отвергнут');
  assert.equal(text_of('bn-status'), CAT.benchpg.en['benchpg.status_busy']);
  await click('bn-stop');
  assert.equal(page2.stop, true);
  release();
  const rep2 = await first;
  assert.ok(rep2.notes.includes('stopped'));
  assert.ok(rep2.sets.length < 4, 'остановка: наборов ' + rep2.sets.length);
  assert.equal(page2.busy, false);
  assert.equal(text_of('bn-status'), CAT.benchpg.en['benchpg.status_stopped']);
  assert.match(by_id('bn-results').textContent, /The run was stopped/);
});

test('REQ-150 bench.html: переключение языка не пересоздаёт результат и не ломает замер; кнопка языка отмечена; boot_bench читает язык браузера', async () => {
  reset_dom('bn');
  const env = fake_window({ lang: 'en-US' });
  env.document = doc;
  const page = BENCH.boot_bench(env);
  assert.equal(page.lang, 'en', 'язык по браузеру');
  assert.equal(doc.title, CAT.benchpg.en['benchpg.doc_title']);
  assert.equal(by_id('bn-lang-en').attrs['aria-pressed'], 'true');
  assert.equal(doc.documentElement.lang, 'en');
  page.ports = { ...page.ports, clock: () => new Date(2026, 9, 23), load_g001: async () => structuredClone(G001), yield_ui: async () => {} };
  page.plans = tiny_plan;
  page.plan = 'tiny';
  await click('bn-run');
  await until(() => !page.busy && page.report !== null);
  assert.match(by_id('bn-results').textContent, /Reference G-001/);
  await click('bn-lang-ru');
  assert.equal(page.lang, 'ru');
  assert.equal(by_id('bn-lang-ru').attrs['aria-pressed'], 'true');
  assert.equal(doc.title, CAT.benchpg.ru['benchpg.doc_title']);
  assert.match(by_id('bn-results').textContent, /Эталон G-001/, 'результат перерисован на русском, а не потерян');
  assert.equal(text_of('bn-status'), 'Замер закончен: наборов 4, n = 2 на набор.');
  // выбор плана замера
  const select = by_id('bn-plan');
  select.listeners.change[0]({ target: { value: 'tiny' } });
  assert.equal(page.plan, 'tiny');
  select.listeners.change[0]({ target: { value: '__proto__' } });
  assert.equal(page.plan, 'tiny', 'чужое значение не принимается');
});

// ── 4. coldstart.html ────────────────────────────────────────────────────────────────────────────────────────────────────

function fake_frame_window({ href = './index.html#overview', has_title = true, current = '#overview', now = 812.3456, raf = true, nav = true, sw = true, throws = false } = {}) {
  const dom = {
    getElementById: (id) => (id === 'view-title' && has_title ? {} : null),
    querySelector: (sel) => (sel === '#nav a[aria-current="page"]' && current !== null ? { getAttribute: (k) => (k === 'href' ? current : null) } : null),
  };
  const w = {
    location: { href },
    performance: {
      now: () => now,
      getEntriesByType: (t) => (t === 'navigation' && nav ? [{ type: 'navigate', responseEnd: 30.1234, domContentLoadedEventEnd: 410.5, loadEventEnd: 0, transferSize: 0, workerStart: 12.5 }] : []),
    },
    navigator: sw ? { serviceWorker: { controller: {} } } : {},
    requestAnimationFrame: raf ? (fn) => { setTimeout(fn, 0); } : undefined,
  };
  Object.defineProperty(w, 'document', { get() { if (throws) throw new Error('SecurityError'); return dom; } });
  return w;
}

test('REQ-152 frame_state: blocked, blank, loading, other, overview — по DOM вложенного окна; read_navigation и controlled_by_sw читают PerformanceNavigationTiming', () => {
  assert.equal(COLD.frame_state(fake_frame_window({ throws: true })), 'blocked');
  assert.equal(COLD.frame_state(fake_frame_window({ href: 'about:blank' })), 'blank');
  assert.equal(COLD.frame_state(fake_frame_window({ href: 'chrome-error://chromewebdata/' })), 'blocked');
  assert.equal(COLD.frame_state(fake_frame_window({ has_title: false })), 'loading');
  assert.equal(COLD.frame_state(fake_frame_window({ current: '#buy' })), 'other');
  assert.equal(COLD.frame_state(fake_frame_window({ current: null })), 'other');
  assert.equal(COLD.frame_state(fake_frame_window()), 'overview');
  assert.deepEqual(COLD.read_navigation(fake_frame_window()), { type: 'navigate', response_end_ms: 30.12, dom_content_loaded_ms: 410.5, load_ms: 0, transfer_size: 0, worker_start_ms: 12.5 });
  assert.equal(COLD.read_navigation(fake_frame_window({ nav: false })), null);
  assert.equal(COLD.read_navigation({}), null);
  assert.equal(COLD.controlled_by_sw(fake_frame_window()), true);
  assert.equal(COLD.controlled_by_sw(fake_frame_window({ sw: false })), null);
  assert.equal(COLD.controlled_by_sw({ navigator: { serviceWorker: { controller: null } } }), false);
});

const cold_ports = (frames, over = {}) => {
  const made = [];
  return {
    made,
    now: () => performance.now(), set_interval: (fn, ms) => setInterval(fn, ms), clear_interval: clearInterval, set_timeout: (fn) => setTimeout(fn, 30), clear_timeout: clearTimeout, // охранный таймер кадра заведомо дольше двух тиков заглушки requestAnimationFrame
    poll_ms: 1, timeout_ms: 60, sleep: async () => {},
    make_frame: (url, title) => { const f = { url, title, removed: false, contentWindow: frames.shift(), remove() { this.removed = true; } }; made.push(f); return f; },
    ...over,
  };
};

test('REQ-152 run_once: «Обзор» появился — время по часам вложенного окна (от его navigationStart), затем кадр; окно убрано; нет кадра — paint_ms null; таймаут и заблокированное окно — ok: false с состоянием', async () => {
  let polls = 0;
  const win = fake_frame_window();
  Object.defineProperty(win, 'location', { get() { polls += 1; return { href: polls < 3 ? 'about:blank' : './index.html#overview' }; } });
  const ports = cold_ports([win]);
  const r = await COLD.run_once(ports, 'заголовок окна');
  assert.deepEqual([r.ok, r.state, r.dom_ms, r.paint_ms, r.via_sw], [true, 'overview', 812.35, 812.35, true]);
  assert.equal(r.nav.transfer_size, 0);
  assert.equal(ports.made[0].url, './index.html#overview');
  assert.equal(ports.made[0].title, 'заголовок окна');
  assert.equal(ports.made[0].removed, true);
  assert.ok(polls >= 3, 'ждали, пока документ сменит пустой');
  const no_raf = await COLD.run_once(cold_ports([fake_frame_window({ raf: false })]), 't');
  assert.deepEqual([no_raf.ok, no_raf.dom_ms, no_raf.paint_ms], [true, 812.35, null], 'кадра нет — отрисовка не выдумывается');
  const slow = cold_ports([fake_frame_window({ has_title: false })]);
  const t = await COLD.run_once(slow, 't');
  assert.deepEqual([t.ok, t.state, t.dom_ms], [false, 'loading', null]);
  assert.equal(slow.made[0].removed, true, 'окно убрано и после таймаута');
  const blocked = await COLD.run_once(cold_ports([fake_frame_window({ throws: true })]), 't');
  assert.deepEqual([blocked.ok, blocked.state], [false, 'blocked']);
  const none = await COLD.run_once(cold_ports([undefined]), 't');
  assert.deepEqual([none.ok, none.state], [false, 'blank'], 'окна ещё нет');
});

test('REQ-152 summarize_runs, build_cold_report, checklist_line: n, первый запуск, медиана, наибольший; гипотеза 2 с по медиане (граница включена); строка для чек-листа RU и EN', () => {
  const run = (dom, paint, sw = true) => ({ ok: true, state: 'overview', dom_ms: dom, paint_ms: paint, via_sw: sw, nav: null });
  const runs = [run(900, 950), run(700, 800), run(600, null), run(1000, 1100, false), { ok: false, state: 'loading', dom_ms: null, paint_ms: null, nav: null, via_sw: null }];
  const s = COLD.summarize_runs(runs);
  assert.deepEqual(s, { n: 5, ok_runs: 4, first_ms: 950, min_ms: 600, p50_ms: 800, max_ms: 1100, via_sw: 3, painted: 3 });
  assert.equal(COLD.summarize_runs([{ ok: false, state: 'blocked' }]).first_ms, null);
  assert.equal(COLD.summarize_runs([]).p50_ms, null);
  const rep = (p50) => COLD.build_cold_report({ date: '2026-10-23', device: UA, env: { online: false }, n: 3, runs: [run(p50, p50), run(p50, p50), run(p50, p50)], online: false, self_nav: null });
  assert.equal(rep(2000).within_hypothesis, true, 'ровно 2000 мс — в пределах');
  assert.equal(rep(2000.01).within_hypothesis, false);
  assert.equal(COLD.build_cold_report({ date: 'd', device: '', env: {}, n: 1, runs: [], online: true, self_nav: null }).within_hypothesis, null);
  assert.equal(rep(1000).format, 'runway-coldstart/1');
  assert.equal(rep(1000).offline, true);
  assert.equal(COLD.COLD_BUDGET_MS, 2000);
  const line_ru = COLD.checklist_line('ru', rep(812.3));
  assert.match(line_ru, /^2026-10-23; TestUA\/1\.0 .*; n = 3; медиана 812,3 мс; наибольший 812,3 мс; сервис-воркер: 3 из 3; без сети: да$/);
  assert.match(COLD.checklist_line('en', rep(812.3)), /; n = 3; median 812\.3 ms; largest 812\.3 ms; service worker: 3 of 3; without network: yes$/);
  const long = COLD.build_cold_report({ date: 'd', device: 'x'.repeat(300), env: {}, n: 1, runs: [run(1, 1)], online: true, self_nav: null });
  assert.ok(COLD.checklist_line('ru', long).length < 300, 'длинная строка браузера сокращена в строке чек-листа');
});

test('REQ-152 coldstart.html: серия запусков на заглушке окна — отчёт, таблица, строка чек-листа и JSON в поле; первый неудачный запуск останавливает серию с понятным объяснением (сервер запрещает вложение)', async () => {
  reset_dom('cs', ['cs-frame-box']);
  const env = fake_window();
  const frames = [fake_frame_window({ now: 900 }), fake_frame_window({ now: 700 }), fake_frame_window({ now: 800 })];
  const ports = { ...COLD.make_ports(env), ...cold_ports(frames), clock: () => new Date(2026, 9, 23), sleep: async () => {} };
  ports.doc = doc;
  const page = COLD.make_page('ru', ports);
  page.runs_n = 3;
  COLD.render_page(page);
  assert.equal(doc.title, CAT.coldpg.ru['coldpg.doc_title']);
  assert.equal(text_of('cs-status'), CAT.coldpg.ru['coldpg.status_idle']);
  const rep = await COLD.run_cold(page);
  assert.equal(rep.summary.n, 3);
  assert.equal(rep.summary.ok_runs, 3);
  assert.deepEqual([rep.summary.first_ms, rep.summary.p50_ms, rep.summary.max_ms], [900, 800, 900]);
  assert.equal(rep.date, '2026-10-23');
  assert.equal(rep.device, UA);
  assert.equal(rep.within_hypothesis, true);
  assert.equal(text_of('cs-status'), 'Замер закончен: успешных запусков 3 из 3.');
  assert.equal(by_id('cs-run').attrs['aria-disabled'], 'false');
  assert.equal(page.busy, false);
  const out = value_of('cs-out');
  assert.equal(out.split('\n')[0], COLD.checklist_line('ru', rep));
  assert.deepEqual(JSON.parse(out.split('\n\n').slice(1).join('\n\n')), rep);
  assert.match(by_id('cs-results').textContent, /повторная загрузка приложения во вложенном окне|повторная загрузка приложения/i);
  assert.equal(by_id('cs-frame-box').children.length, 0, 'место для окна очищено');
  await click('cs-copy');
  assert.equal(env.written[0], out);

  // окно заблокировано: серия останавливается после первого запуска
  const blocked_ports = { ...ports, ...cold_ports([fake_frame_window({ throws: true }), fake_frame_window()]) };
  const page2 = COLD.make_page('en', blocked_ports);
  page2.runs_n = 5;
  reset_dom('cs', ['cs-frame-box']);
  COLD.render_page(page2);
  const bad = await COLD.run_cold(page2);
  assert.equal(bad.runs.length, 1, 'после первой неудачи серия остановлена');
  assert.deepEqual(bad.notes, ['blocked']);
  assert.equal(bad.within_hypothesis, null);
  assert.equal(text_of('cs-status'), 'Measurement not completed: 0 of 5 runs succeeded.');
  assert.match(by_id('cs-results').textContent, /server forbids framing pages/);
  // повторное нажатие во время замера
  const never = cold_ports([fake_frame_window({ has_title: false })], { timeout_ms: 40 });
  const page3 = COLD.make_page('ru', { ...ports, ...never });
  page3.runs_n = 3;
  reset_dom('cs', ['cs-frame-box']);
  COLD.render_page(page3);
  const running = COLD.run_cold(page3);
  assert.equal(await COLD.run_cold(page3), null);
  assert.equal(text_of('cs-status'), CAT.coldpg.ru['coldpg.status_busy']);
  const r3 = await running;
  assert.deepEqual(r3.notes, ['timeout']);
});

// ── 5. compat.html ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Крошечная IndexedDB: открыть, создать хранилище, put/get, deleteDatabase; режимы отказа. */
function tiny_idb(mode = 'ok') {
  const dbs = new Map();
  const log = { opened: [], deleted: [], closed: 0 };
  const later = (fn) => setImmediate(fn); // как в fake_idb: таймер Windows даёт ~15 мс на тик, и цепочка запросов упирается в охранный таймер пробы
  return {
    log,
    indexedDB: {
      open(name) {
        log.opened.push(name);
        const rq = {};
        if (mode === 'hang') return rq;
        later(() => {
          if (mode === 'open_error') { rq.error = new Error('x'); rq.onerror?.(); return; }
          const fresh = !dbs.has(name);
          if (fresh) dbs.set(name, new Map());
          const data = dbs.get(name);
          rq.result = {
            createObjectStore() {},
            close() { log.closed += 1; },
            transaction() {
              const tx = {};
              tx.objectStore = () => ({
                put(v, k) { later(() => { if (mode === 'write_error') { tx.error = new Error('q'); tx.onerror?.(); } else { data.set(k, v); tx.oncomplete?.(); } }); return {}; },
                get(k) { const r = {}; later(() => { r.result = data.get(k); r.onsuccess?.(); }); return r; },
              });
              return tx;
            },
          };
          if (fresh) rq.onupgradeneeded?.();
          rq.onsuccess?.();
        });
        return rq;
      },
      deleteDatabase(name) { log.deleted.push(name); dbs.delete(name); const rq = {}; later(() => rq.onsuccess?.()); return rq; },
    },
  };
}

function compat_env(over = {}, idb_mode = 'ok') {
  const idb = tiny_idb(idb_mode);
  const persist_calls = [];
  const env = {
    isSecureContext: true, indexedDB: idb.indexedDB,
    navigator: {
      userAgent: UA, language: 'ru-RU', platform: 'TestOS', hardwareConcurrency: 8, onLine: true,
      storage: { persist: async () => { persist_calls.push(1); return true; }, persisted: async () => false, estimate: async () => ({ quota: 500 * 1048576, usage: 1 }), getDirectory: async () => ({}) },
      locks: { request: async (name, opts, cb) => cb({ name }) },
      serviceWorker: { controller: null },
    },
    caches: { open: async () => ({}) }, Worker: class {}, BroadcastChannel: class { constructor(n) { this.name = n; } close() { this.closed = true; } },
    showOpenFilePicker: () => {}, crypto: { subtle: { digest: async () => new ArrayBuffer(32) } }, matchMedia: () => ({ matches: false }),
    ...over,
  };
  return { env, idb, persist_calls };
}
const compat_ports = (client, timeout_ms = 1000) => ({ set_timeout: (fn) => setTimeout(fn, timeout_ms), clear_timeout: clearTimeout, // охранный таймер проб: щедрый, кроме проверки «не отвечает»
  now: () => performance.now(), make_client: client ?? (() => create_calc_client({ make_worker: () => null })) });
const worker_ok_client = () => ({ terminated: false, analyze: async (ws, q) => ({ result: analyze(ws, q), via: 'worker', reason: null }), terminate() { this.terminated = true; } });
const status_of = (results) => Object.fromEntries(results.map((r) => [r.id, r.status + ':' + r.code]));

test('REQ-157 compat: устройство с полным набором — все возможности «да»; пробная база создана и удалена, persist() не вызывался, чужое не затронуто', async () => {
  const { env, idb, persist_calls } = compat_env();
  const client = worker_ok_client();
  const results = await COMPAT.probe_all(env, compat_ports(() => client));
  assert.deepEqual(results.map((r) => r.id), [...COMPAT.FEATURES]);
  assert.deepEqual(status_of(results), {
    secure: 'yes:secure_yes', indexeddb: 'yes:idb_ok', persist: 'yes:persist_present', locks: 'yes:locks_ok', sw: 'yes:sw_present', caches: 'yes:caches_present',
    worker: 'yes:worker_ok', broadcast: 'yes:bc_ok', fsa: 'yes:fsa_pickers', subtle: 'yes:subtle_ok', standalone: 'no:standalone_no',
  });
  assert.deepEqual(idb.log.opened, ['runway-compat-probe']);
  assert.deepEqual(idb.log.deleted, ['runway-compat-probe'], 'пробная база удалена');
  assert.equal(idb.log.closed, 1);
  assert.deepEqual(persist_calls, [], 'persist() страница не вызывает');
  assert.deepEqual(results.find((r) => r.id === 'persist').params, { persisted: false, quota_mb: 500 });
  assert.equal(client.terminated, true, 'клиент воркера закрыт');
  for (const r of results) { assert.ok(COMPAT.STATUSES.includes(r.status), r.id); assert.ok(COMPAT.DETAIL_CODES.includes(r.code), r.code); }
});

test('REQ-157 compat: старый или урезанный браузер — «нет» и «не определено» без исключений; каждый код подробности имеет строку RU и EN', async () => {
  const empty = await COMPAT.probe_all({}, compat_ports(() => create_calc_client({ make_worker: () => null })));
  assert.deepEqual(status_of(empty), {
    secure: 'unknown:secure_unknown', indexeddb: 'no:idb_absent', persist: 'no:persist_absent', locks: 'no:locks_absent', sw: 'no:sw_absent', caches: 'no:caches_absent',
    worker: 'no:worker_absent', broadcast: 'no:bc_absent', fsa: 'no:fsa_absent', subtle: 'no:subtle_absent', standalone: 'unknown:standalone_unknown',
  });
  // каждый код подробности из закрытого списка читается на обоих языках; параметры подставляются словами
  for (const code of COMPAT.DETAIL_CODES) {
    for (const lang of ['ru', 'en']) {
      const t = COMPAT.detail_text(lang, { code, params: { persisted: null, quota_mb: 5, ms: 12, reason: 'timeout' } });
      assert.ok(t.length > 5 && !/\{[a-z_]+\}/.test(t) && !t.startsWith('compatpg.'), `${lang} ${code}: ${t}`);
    }
  }
  assert.match(COMPAT.detail_text('ru', { code: 'persist_present', params: { persisted: false, quota_mb: null } }), /закрепление уже предоставлено: нет; оценка квоты хранилища, МБ: неизвестно/);
  assert.match(COMPAT.detail_text('en', { code: 'worker_main', params: { reason: 'worker_start_failed' } }), /the worker did not start/);
});

test('REQ-157 compat: отказы проб — IndexedDB (открытие, запись, зависание), замок (занят, сбой), канал, воркер (откат, расхождение, сбой), режим установленного приложения, OPFS без выбора файлов', async () => {
  const run = async (over, idb_mode, client, timeout_ms) => status_of(await COMPAT.probe_all(compat_env(over, idb_mode).env, compat_ports(client, timeout_ms)));
  const ok_client = () => worker_ok_client();
  assert.equal((await run({}, 'open_error', ok_client)).indexeddb, 'no:idb_failed');
  {
    const e = compat_env({}, 'write_error');
    const r = status_of(await COMPAT.probe_all(e.env, compat_ports(ok_client)));
    assert.equal(r.indexeddb, 'no:idb_failed');
    assert.deepEqual(e.idb.log.deleted, ['runway-compat-probe'], 'база удалена и после сбоя записи');
  }
  assert.equal((await run({}, 'hang', ok_client, 40)).indexeddb, 'no:idb_failed', 'не отвечает — не зависаем');
  const locks = (request) => ({ navigator: { ...compat_env().env.navigator, locks: { request } } });
  assert.equal((await run(locks(async (n, o, cb) => cb(null)), 'ok', ok_client)).locks, 'partial:locks_busy');
  assert.equal((await run(locks(() => { throw new Error('x'); }), 'ok', ok_client)).locks, 'no:locks_failed');
  assert.equal((await run(locks(async () => { throw new Error('x'); }), 'ok', ok_client)).locks, 'no:locks_failed');
  assert.equal((await run({ BroadcastChannel: class { constructor() { throw new Error('x'); } } }, 'ok', ok_client)).broadcast, 'no:bc_failed');
  assert.equal((await run({}, 'ok', () => create_calc_client({ make_worker: () => null }))).worker, 'partial:worker_main', 'Worker есть, воркер не запустился → откат');
  assert.equal((await run({}, 'ok', () => ({ analyze: async () => ({ result: { x: 1 }, via: 'worker', reason: null }), terminate() {} }))).worker, 'no:worker_diff');
  assert.equal((await run({}, 'ok', () => ({ analyze: async () => { throw new Error('x'); }, terminate() {} }))).worker, 'unknown:worker_probe_error');
  assert.equal((await run({}, 'ok', () => { throw new Error('x'); })).worker, 'unknown:worker_probe_error');
  assert.equal((await run({ isSecureContext: false }, 'ok', ok_client)).secure, 'no:secure_no');
  assert.equal((await run({ matchMedia: () => ({ matches: true }) }, 'ok', ok_client)).standalone, 'yes:standalone_yes');
  assert.equal((await run({ matchMedia: undefined, navigator: { ...compat_env().env.navigator, standalone: true } }, 'ok', ok_client)).standalone, 'yes:standalone_yes');
  assert.equal((await run({ showOpenFilePicker: undefined }, 'ok', ok_client)).fsa, 'partial:fsa_opfs');
  assert.equal((await run({ navigator: { ...compat_env().env.navigator, serviceWorker: { controller: {} } } }, 'ok', ok_client)).sw, 'yes:sw_controlled');
  const worker_reason = status_of(await COMPAT.probe_all(compat_env().env, compat_ports(() => ({ analyze: async () => ({ result: {}, via: 'main', reason: 'неизвестная причина' }), terminate() {} }))));
  assert.equal(worker_reason.worker, 'partial:worker_main');
});

test('REQ-157 compat.html: таблица для копирования — разметка Markdown, 11 возможностей, строка для таблицы устройств чек-листа с девятью столбцами и пометками «вручную» (P4, P5, P13); вертикальная черта в строке браузера не ломает таблицу', async () => {
  reset_dom('cp');
  const env = fake_window();
  const { env: probed } = compat_env();
  Object.assign(env, { ...probed, document: doc, navigator: { ...probed.navigator, clipboard: env.navigator.clipboard }, performance: env.performance });
  const ports = { ...COMPAT.make_ports(env), clock: () => new Date(2026, 9, 23), make_client: worker_ok_client, set_timeout: (fn) => setTimeout(fn, 1000) };
  const page = COMPAT.make_page('ru', ports);
  COMPAT.render_page(page);
  assert.equal(by_id('cp-results').children.length, 0, 'до нажатия кнопки проверок нет');
  assert.equal(await COMPAT.run_compat(page).then((r) => r.format), 'runway-compat/1');
  assert.equal(page.busy, false);
  assert.equal(text_of('cp-status'), 'Проверка закончена: возможностей — 11.');
  const out = value_of('cp-out');
  assert.equal(out, COMPAT.table_text('ru', page.report));
  const lines = out.split('\n');
  assert.equal(lines[0], 'Совместимость устройства, проверка от 2026-10-23');
  assert.equal(lines[2], '| Возможность | Результат | Подробность |');
  const feature_rows = lines.filter((l) => /^\| (Защищённый|IndexedDB|persist|Web Locks|Сервис|Cache|Worker|BroadcastChannel|File System|crypto|Запуск)/.test(l));
  assert.equal(feature_rows.length, 11);
  const device_row = lines.find((l) => l.startsWith('| TestUA'));
  assert.ok(device_row, 'строка устройства');
  assert.equal(device_row.split(' | ').length, 9, 'девять столбцов таблицы устройств');
  assert.ok(device_row.includes('вручную (P5)') && device_row.includes('вручную (P4)') && device_row.includes('вручную (P13)'));
  assert.ok(!device_row.slice(2).includes('| x)'), 'вертикальная черта из строки браузера заменена');
  assert.ok(device_row.includes('(2026-10-23)'));
  const header = lines.find((l) => l.startsWith('| Устройство и версия'));
  assert.equal(header.split(' | ').length, 9);
  assert.match(out, /Это проверка наличия возможностей на одном устройстве, а не результат прохода чек-листа\./);
  // экран: строки возможностей, устройство; строка браузера — текст
  const tables = find_all(by_id('cp-results'), (n) => n.tagName === 'table');
  assert.equal(tables.length, 2);
  assert.equal(find_all(tables[1], (n) => n.tagName === 'tr').length, 1 + 11);
  assert.ok(by_id('cp-results').textContent.includes(UA));
  assert.equal(find_all(doc.body, (n) => n.tagName === 'script').length, 0);
  // английский вариант того же отчёта
  const en = COMPAT.table_text('en', page.report);
  assert.match(en, /\| Device and version \| IndexedDB \| persist\(\) \| Web Locks \| PWA install \| Service worker \| Offline \(P4\) \| Calc worker \(P12\) \| Import worker \(P13\) \|/);
  assert.match(en, /by hand \(P5\)/);
  await click('cp-copy');
  assert.deepEqual(env.written, [out], 'в буфер обмена ушёл тот же текст, что в поле');
});

test('REQ-157 compat.html: повторное нажатие во время проверки отвергается; язык переключается без потери результата; кнопка не пересоздаётся', async () => {
  reset_dom('cp');
  const { env: probed } = compat_env();
  const env = fake_window();
  Object.assign(env, { ...probed, document: doc, navigator: { ...probed.navigator, clipboard: env.navigator.clipboard }, performance: env.performance });
  let release = null;
  const gate = new Promise((r) => { release = r; });
  const slow_client = () => ({ analyze: async (ws, q) => { await gate; return { result: analyze(ws, q), via: 'worker', reason: null }; }, terminate() {} });
  const page = COMPAT.make_page('en', { ...COMPAT.make_ports(env), clock: () => new Date(2026, 9, 23), make_client: slow_client, set_timeout: (fn) => setTimeout(fn, 1000) });
  COMPAT.render_page(page);
  const button = by_id('cp-run');
  const first = COMPAT.run_compat(page);
  assert.equal(page.busy, true);
  assert.equal(by_id('cp-run').attrs['aria-disabled'], 'true');
  assert.equal(await COMPAT.run_compat(page), null);
  assert.equal(text_of('cp-status'), CAT.compatpg.en['compatpg.status_busy']);
  release();
  await first;
  assert.equal(by_id('cp-run'), button, 'кнопка — тот же узел');
  assert.equal(by_id('cp-run').attrs['aria-disabled'], 'false');
  assert.match(by_id('cp-results').textContent, /Web Locks \(lock between tabs\)/);
  page.lang = 'ru';
  COMPAT.render_page(page);
  assert.match(by_id('cp-results').textContent, /Web Locks \(замок между вкладками\)/, 'результат на русском, не потерян');
  assert.equal(doc.title, CAT.compatpg.ru['compatpg.doc_title']);
});

// ── 6. документы ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test('FP-23 документы: чек-лист ссылается на страницы в P4 и в таблице устройств; README честно называет, что замеры на устройствах не выполнялись', () => {
  const list = read('CHECKLIST-release.md');
  const p4 = list.split('\n').find((l) => l.startsWith('| P4 '));
  assert.ok(p4.includes('demo/coldstart.html'), 'P4 → coldstart.html');
  const devices = list.slice(list.indexOf('## 2.'), list.indexOf('## 3.'));
  for (const f of ['demo/compat.html', 'demo/bench.html', 'demo/coldstart.html']) assert.ok(devices.includes(f), '§2 → ' + f);
  assert.ok(list.split('\n').find((l) => l.startsWith('| R6 ')).includes('demo/bench.html'), 'R6 → bench.html');
  assert.match(list, /ни одна строка ниже не выполнена/);
  const readme = read('README.md');
  assert.match(readme, /замеры на устройствах не выполнялись/i);
  assert.match(read('demo', 'README_ext.md'), /bench\.html/);
  assert.match(read('tools', 'README.md'), /--compare/);
});
