// fp12_adv.test.mjs — состязательная проверка пакета FP-12 (независимый проверяющий, 2026-10-10). Расчёт по введённым данным и правилам, не консультация.
// Здесь два вида тестов.
//  1) «Страховочные» (зелёные): независимая проверка того, что заявил пакет, другим путём, чем его собственные тесты — полнота списка файлов оболочки по буквальным строкам-путям,
//     пересчёт sha256 и хэша сборки без tools/build_manifest.mjs, гонки клиента воркера расчёта, устойчивость протокола воркера к «__proto__».
//  2) «Дефектные» (были красными до исправления, теперь охраняют его): ADV-03 (неудачная установка новой версии с тем же хэшем сборки стирала кэш работающей версии), ADV-04 («Проверить обновление»
//     отвечало «Новой версии нет.», пока найденная версия ещё устанавливалась), ADV-05 (отказ установки новой версии нигде не был показан), ADV-06 (цвет текста на одном из фонов страницы ниже 4,5:1).
//  3) Бывшие «todo» (низкая серьёзность, исправлены и больше не todo): ADV-07 (политика замка арифметики запрещала любое повышение ENGINE_VERSION без правки замка), ADV-08 (клиент принимал ответ воркера без result).
// Браузера, сервера и сети нет; рабочее дерево не меняется (сборки идут в копиях во временном каталоге).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PROTO, load_sw, read_files } from './sw_harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
void HERE;
const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);
const read = (...p) => fs.readFileSync(path.join(PROTO, ...p), 'utf8');
const MANIFEST = JSON.parse(read('demo', 'shell_manifest.json'));
const SHELL = new Set([...MANIFEST.files, ...MANIFEST.stamped].map((f) => f.path));

// ── минимальная заглушка DOM для экрана «О программе» ───────────────────────────────────────────────────────────────────────

class Node_ {
  constructor(tag) { this.nodeType = 1; this.tagName = tag; this.attrs = {}; this.children = []; this.listeners = {}; this.className = ''; this._text = ''; }
  get textContent() { return this.children.length === 0 ? this._text : this.children.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  hasAttribute(k) { return Object.hasOwn(this.attrs, k); }
  append(...kids) { for (const k of kids) this.children.push(k); this._text = ''; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  focus() {}
  walk(fn) { fn(this); for (const c of this.children) if (c.nodeType === 1) c.walk(fn); }
}
globalThis.document = {
  createElement: (t) => new Node_(t), createElementNS: (_ns, t) => new Node_(t), createTextNode: (data) => ({ nodeType: 3, data }),
  getElementById: () => null, activeElement: null, body: new Node_('body'), documentElement: new Node_('html'),
};
const find_by_id = (root, id) => { let hit; root.walk((n) => { if (n.attrs.id === id) hit = n; }); return hit; };

const PWA = await imp('demo', 'pwa.mjs');
const AB = await imp('demo', 'about.mjs');
const BI = await imp('demo', 'build_info.mjs');
const BM = await imp('tools', 'build_manifest.mjs');
const CT = await imp('tools', 'contrast.mjs');
const W = await imp('demo', 'calc_worker.mjs');
const C = await imp('demo', 'worker_client.mjs');
const E = await imp('engine', 'index.mjs');
const ABOUT_CAT = (await imp('demo', 'i18n', 'about.mjs')).default;
const tr_ru = (key, params) => { let s = ABOUT_CAT.ru[key] ?? key; for (const [k, v] of Object.entries(params ?? {})) s = s.replaceAll('{' + k + '}', String(v)); return s; };

const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const sha = (b) => createHash('sha256').update(b).digest('hex');

// ── 1. страховочные ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('ADV-01 независимая полнота оболочки: ни один файл оболочки не ссылается буквальной строкой-путём на существующий файл demo/engine/data вне оболочки; вне оболочки лежат только известные файлы', () => {
  const walk = (d, out = []) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); fs.statSync(p).isDirectory() ? walk(p, out) : out.push(p); } return out; };
  const all = ['demo', 'engine', 'data'].flatMap((d) => walk(path.join(PROTO, d))).map((p) => path.relative(PROTO, p).split(path.sep).join('/'));
  const outside = all.filter((p) => !SHELL.has(p) && !p.endsWith('.md')).sort();
  assert.deepEqual(outside, [
    'data/backtest-report.json', 'data/g001-debt.json', 'data/golden-g001.json', 'data/profiles/csv-generic.json', 'data/profiles/csv-semicolon-dmy.json', 'data/profiles/fx-rows-csv-1.json', 'data/profiles/hours-csv-1.json', 'data/profiles/runway-csv-1.json', 'data/synthetic-journals/manifest.json',
    'data/synthetic-journals/write_manifest.mjs', 'data/templates/freelancer-skeleton.json', 'demo/.htaccess', 'demo/promises.json', 'demo/shell_manifest.json',
    'engine/vocab.json', // FP-22: engine/backtest.mjs теперь в оболочке (его читает demo/metrics_feed.mjs — фактический ряд окна прогноза)
  ].sort(), 'состав «вне оболочки» изменился: проверьте, не нужен ли новый файл офлайн');
  const missed = [];
  for (const f of SHELL) {
    if (!['.mjs', '.js', '.html', '.css'].includes(path.extname(f))) continue;
    const src = read(...f.split('/'));
    // буквальные строки-пути в любых кавычках, комментарии НЕ вырезаются (в отличие от tools/build_manifest.mjs)
    for (const lit of src.matchAll(/(['"`])((?:\.\.?\/|css\/|icons\/|i18n\/)[A-Za-z0-9_./-]+\.(?:mjs|js|json|css|svg|html|webmanifest))\1/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), lit[2]));
      if (all.includes(target) && !SHELL.has(target)) missed.push(`${f} → ${target}`);
    }
  }
  assert.deepEqual(missed, []);
});

test('ADV-02 независимый пересчёт: sha256 и размер каждого файла манифеста, хэш сборки и штамп sw.js пересчитаны без tools/build_manifest.mjs', () => {
  for (const f of [...MANIFEST.files, ...MANIFEST.stamped]) {
    const b = fs.readFileSync(path.join(PROTO, f.path));
    assert.equal(sha(b), f.sha256, f.path);
    assert.equal(b.length, f.bytes, f.path);
  }
  // хэш сборки = файлы оболочки + последней строкой текст sw.js без штампа (исправление ADV-03); штамп обнуляется здесь независимо от tools/build_manifest.mjs
  const sw_text = read('demo', 'sw.js');
  const core = sw_text.replace(/(\/\* BUILD:BEGIN \*\/)[\s\S]*?(\/\* BUILD:END \*\/)/, '$1\nconst BUILD_HASH = \'' + '0'.repeat(64) + '\';\n$2');
  assert.notEqual(core, sw_text);
  const core_sha = sha(Buffer.from(core, 'utf8'));
  assert.equal(MANIFEST.stamped.find((f) => f.path === 'demo/sw.js').core_sha256, core_sha);
  const text = 'runway-shell/1\n' + MANIFEST.files.map((f) => f.path + '\t' + f.sha256 + '\n').join('') + 'demo/sw.js#core\t' + core_sha + '\n';
  assert.equal(sha(Buffer.from(text, 'utf8')), MANIFEST.build_hash);
  assert.ok(read('demo', 'sw.js').includes("const BUILD_HASH = '" + MANIFEST.build_hash + "';"));
  assert.equal(BI.BUILD.build_hash, MANIFEST.build_hash);
});

// ── 2. дефектные ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test('ADV-03 (дефект, средняя серьёзность) релиз, меняющий только логику sw.js, получает тот же хэш сборки и то же имя кэша; сбой установки новой версии НЕ должен стирать кэш работающей версии', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-adv-'));
  try {
    for (const d of ['demo', 'engine', 'data']) fs.cpSync(path.join(PROTO, d), path.join(root, d), { recursive: true });
    const old_manifest = BM.write_build(root).manifest;
    const grab = (manifest) => new Map([...BM.precache_list(manifest).map((f) => f.path), 'demo/shell_manifest.json'].map((p) => [p, fs.readFileSync(path.join(root, p))]));
    const old_files = grab(old_manifest);
    const old_sw = fs.readFileSync(path.join(root, 'demo', 'sw.js'), 'utf8');
    fs.appendFileSync(path.join(root, 'demo', 'sw.js'), '\n// исправление логики воркера: релиз, в котором другие файлы оболочки не менялись\n');
    const new_manifest = BM.write_build(root).manifest;
    const new_sw = fs.readFileSync(path.join(root, 'demo', 'sw.js'), 'utf8');
    assert.notEqual(new_sw, old_sw, 'байты sw.js изменились: браузер увидит новую версию воркера');

    const active = load_sw({ files: old_files, source: old_sw });
    assert.equal((await active.install()).ok, true);
    assert.equal((await active.activate()).ok, true);
    const live = active.cache_names();
    assert.equal(live.length, 1);
    const live_size = active.stores.get(live[0]).size;
    assert.ok(live_size > 100);

    // новая версия воркера ставится поверх; сеть обрывается в середине установки (то же хранилище кэшей, что у работающей версии)
    const next = load_sw({ files: grab(new_manifest), source: new_sw });
    for (const [name, entries] of active.stores) next.stores.set(name, entries);
    next.state.online = false;
    assert.equal((await next.install()).ok, false, 'установка без сети не проходит — это ожидаемо');
    assert.ok(next.stores.has(live[0]), 'кэш работающей версии удалён неудачной установкой новой: оффлайн-копия потеряна (имя кэша не зависит от sw.js, хэш сборки его не покрывает)');
    assert.equal(next.stores.get(live[0])?.size, live_size);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function fake_worker(state) {
  const w = { state, listeners: {}, posted: [], postMessage(msg, transfer) { w.posted.push({ msg, transfer }); }, addEventListener(t, fn) { (w.listeners[t] ??= []).push(fn); } };
  return w;
}
function update_env({ install_outcome }) {
  const w_old = fake_worker('activated');
  const w_new = fake_worker('installing');
  const reg = {
    active: w_old, waiting: null, installing: null, listeners: {},
    addEventListener(t, fn) { (reg.listeners[t] ??= []).push(fn); },
    // как в спецификации: update() завершается, когда новая версия НАЧАЛА устанавливаться, а не когда установилась
    async update() {
      reg.installing = w_new;
      for (const fn of reg.listeners.updatefound ?? []) fn();
      setImmediate(() => {
        reg.installing = null;
        if (install_outcome === 'installed') { reg.waiting = w_new; w_new.state = 'installed'; } else { w_new.state = 'redundant'; }
        for (const fn of w_new.listeners.statechange ?? []) fn();
      });
    },
  };
  const sw = { controller: w_old, async register() { return reg; }, addEventListener() {} };
  const env = {
    navigator: { serviceWorker: sw }, location: { protocol: 'http:', hostname: 'localhost' }, base_url: 'http://localhost/01/301/runway/prototype/demo/pwa.mjs',
    set_timeout: () => 1, clear_timeout() {}, message_channel: () => ({ port1: {}, port2: {} }),
  };
  return { env, reg, w_new };
}
const stub_ctx = () => ({ tr: tr_ru, get_ws: () => null, refresh() {} });

test('ADV-04 (дефект, низкая серьёзность) «Проверить обновление»: пока найденная версия ещё устанавливается, экран не должен утверждать «Новой версии нет.» (update() завершается до конца установки)', async () => {
  const e = update_env({ install_outcome: 'installed' });
  const pwa = PWA.create_pwa(e.env);
  await pwa.start();
  assert.equal(pwa.snapshot().status, 'active');
  const deps = AB.make_deps({ pwa, calc: { analyze: async () => ({}) }, build: BI.BUILD });
  const c = stub_ctx();
  find_by_id(AB.render_about(c, deps), 'ab-check').listeners.click[0]();
  await tick();
  const root = AB.render_about(c, deps);
  assert.equal(pwa.snapshot().status, 'update_ready', 'новая версия установилась и ждёт');
  assert.match(find_by_id(root, 'ab-pwa').textContent, /Доступна новая версия оболочки/);
  assert.notEqual(find_by_id(root, 'ab-check-msg').textContent, 'Новой версии нет.', 'на одном экране сказано и «доступна новая версия», и «Новой версии нет.»');
});

test('ADV-05 (дефект, низкая серьёзность) отказ установки найденной версии: прежняя версия работает, но экран должен сказать, что новая не установилась (в тексте есть готовая строка about.reason_install_failed)', async () => {
  const e = update_env({ install_outcome: 'redundant' });
  const pwa = PWA.create_pwa(e.env);
  await pwa.start();
  await pwa.check_update();
  await tick();
  const snap = pwa.snapshot();
  assert.deepEqual([snap.status, snap.reason], ['active', 'install_failed']);
  assert.match(AB.pwa_text(tr_ru, snap), /установка новой версии не прошла/, 'состояние «работает» не упоминает отказ установки');
});

test('ADV-06 (дефект, низкая серьёзность) контраст: каждый цвет текста из правил CSS, у которого нет собственного фона, читается на каждом из четырёх фонов страницы (bg, surface, surface-2, banner-bg) не хуже 4,5:1 в обеих темах', () => {
  const css_files = [['style.css', read('demo', 'style.css')], ...fs.readdirSync(path.join(PROTO, 'demo', 'css')).filter((f) => f.endsWith('.css')).sort().map((f) => ['css/' + f, read('demo', 'css', f)])];
  const tokens = CT.theme_tokens(read('demo', 'style.css'));
  const grounds = ['bg', 'surface', 'surface-2', 'banner-bg'];
  const bad = [];
  let checked = 0;
  for (const [name, text] of css_files) {
    for (const rule of CT.parse_rules(text)) {
      const fg = /^var\(--([a-z0-9-]+)\)$/.exec(rule.decls.color ?? '')?.[1];
      if (fg === undefined || /:disabled|\[disabled\]|::backdrop/.test(rule.selector)) continue;
      const own_bg = /^var\(--([a-z0-9-]+)\)$/.exec(rule.decls.background ?? rule.decls['background-color'] ?? '')?.[1];
      for (const [theme, t] of [['light', tokens.light], ['dark', tokens.dark_auto]]) {
        for (const g of own_bg === undefined ? grounds : [own_bg]) {
          if (t[fg] === undefined || t[g] === undefined) continue;
          checked += 1;
          const ratio = CT.contrast_ratio(t[fg], t[g]);
          if (ratio < 4.5) bad.push(`${theme} ${name} «${rule.selector}»: --${fg} на --${g} = ${ratio.toFixed(2)}:1`);
        }
      }
    }
  }
  assert.ok(checked > 150, 'проверено сочетаний: ' + checked);
  assert.deepEqual(bad, []);
});

// ── 3. todo (низкая серьёзность) ─────────────────────────────────────────────────────────────────────────────────────────

test('ADV-07 политика замка арифметики запрещает повысить ENGINE_VERSION без правки замка (правило ADR-014 — только «правка замка ⇒ повышение версии»)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-adv-lock-'));
  try {
    fs.cpSync(path.join(PROTO, 'engine'), path.join(root, 'engine'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    for (const f of ['lock_policy.test.mjs', 'arith.lock.json', 'arith.lock.policy.json']) fs.copyFileSync(path.join(PROTO, 'tests', f), path.join(root, 'tests', f));
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    const idx = path.join(root, 'engine', 'index.mjs');
    const src = fs.readFileSync(idx, 'utf8');
    const bumped = src.replace(/export const ENGINE_VERSION = '0\.1\.0'/, "export const ENGINE_VERSION = '0.1.1'");
    assert.notEqual(bumped, src, 'ENGINE_VERSION найден');
    fs.writeFileSync(idx, bumped);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', 'tests/lock_policy.test.mjs'], { cwd: root, env, encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, 0, 'повышение версии движка при неизменном замке не должно ломать политику:\n' + (r.stdout ?? '').split('\n').filter((l) => /ENGINE_VERSION|✖/.test(l)).slice(0, 4).join('\n'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function fake_reply_worker(make_reply) {
  const w = {
    postMessage(m) { queueMicrotask(() => w.onmessage({ data: make_reply(m) })); }, terminate() {},
  };
  return w;
}

test('ADV-08 клиент воркера расчёта: ответ ok:true без result должен считаться сбоем воркера (откат на главный поток), а не отдаваться вызывающему как расчёт', async () => {
  const G = JSON.parse(read('data', 'g001.json'));
  const q = { as_of: G.as_of };
  const w = fake_reply_worker((m) => ({ v: 1, id: m.id, ok: true, op: 'analyze', engine_version: E.ENGINE_VERSION }));
  const c = C.create_calc_client({ make_worker: () => w, set_timeout: () => 1, clear_timeout() {} });
  const r = await c.analyze(G, q);
  assert.equal(typeof r.result, 'object');
  assert.notEqual(r.result, null);
  assert.equal(r.via, 'main');
});

// ── страховочные гонки воркера расчёта ───────────────────────────────────────────────────────────────────────────────────

test('ADV-09 клиент воркера расчёта: terminate() при зависшем запросе, поздний ответ после таймаута и «__proto__» в рабочей области не ломают результат и не загрязняют прототип', async () => {
  const G = JSON.parse(read('data', 'g001.json'));
  const q = { as_of: G.as_of };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // terminate при зависшем запросе
  {
    const w = { postMessage() {}, terminate() { w.stopped = true; } };
    const c = C.create_calc_client({ make_worker: () => w, set_timeout: () => 1, clear_timeout() {} });
    const p = c.analyze(G, q);
    await tick(2);
    c.terminate();
    const r = await p;
    assert.deepEqual([r.via, r.reason, w.stopped], ['main', 'terminated', true]);
    assert.ok(same(r.result, E.analyze(G, q)));
  }
  // поздний ответ после таймаута
  {
    let held = null;
    let fire = null;
    const w = { postMessage(m) { held = m; }, terminate() {} };
    const c = C.create_calc_client({ make_worker: () => w, set_timeout: (fn) => { fire = fn; return 1; }, clear_timeout() {} });
    const p = c.analyze(G, q);
    await tick(2);
    fire();
    const r = await p;
    assert.deepEqual([r.via, r.reason], ['main', 'timeout']);
    w.onmessage({ data: W.handle_message(held) });
    assert.equal(c.stats().pending, 0);
    const r2 = await c.analyze(G, q);
    assert.deepEqual([r2.via, r2.reason], ['main', 'timeout'], 'после таймаута воркер мёртв до конца сеанса');
  }
  // «__proto__» в рабочей области
  const evil = JSON.parse('{"__proto__":{"polluted_by_adv":1},"as_of":"2026-10-04"}');
  const out = W.handle_message({ v: 1, id: 1, op: 'analyze', ws: evil, query: { as_of: '2026-10-04' } });
  assert.equal(out.ok, false);
  assert.equal(({}).polluted_by_adv, undefined);
  void read_files;
});
