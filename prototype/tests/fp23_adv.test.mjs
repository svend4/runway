// fp23_adv.test.mjs — независимая проверка FP-23 (состязательные тесты проверяющего): страницы bench / coldstart / compat, bench_model, tools/bench.mjs --compare.
// Аддитивно: файл ничего не меняет в реализации. Проверки со словом «известный дефект» помечены `todo` — они описывают найденное расхождение и не краснят прогон; когда дефект
// исправят, `todo` снимается. Браузера нет: страницы идут на заглушке DOM (как в bench_pages.test.mjs), поэтому тесты про связь страниц с настоящим приложением — статические.
// Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROTO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(PROTO, ...p), 'utf8');
const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);

// модули — ДО установки заглушки DOM (иначе страницы запустились бы сами)
const MODEL = await imp('demo', 'bench_model.mjs');
const BENCH_PAGE = await imp('demo', 'bench_page.mjs');
const COLD = await imp('demo', 'coldstart_page.mjs');
const COMPAT = await imp('demo', 'compat_page.mjs');
const BENCH = await imp('tools', 'bench.mjs');
const { analyze } = await imp('engine', 'index.mjs');
const CAT = {
  probe: (await imp('demo', 'i18n', 'probe.mjs')).default,
  benchpg: (await imp('demo', 'i18n', 'benchpg.mjs')).default,
  coldpg: (await imp('demo', 'i18n', 'coldpg.mjs')).default,
  compatpg: (await imp('demo', 'i18n', 'compatpg.mjs')).default,
};
const G001 = JSON.parse(read('data', 'g001.json'));

// ── заглушка DOM (своя копия: файл не зависит от bench_pages.test.mjs) ───────────────────────────────────────────────────
class El {
  constructor(tag) { this.nodeType = 1; this.tagName = tag; this.attrs = {}; this.children = []; this.listeners = {}; this.className = ''; this._text = ''; this._value = ''; this.parent = null; }
  get textContent() { return this.children.length === 0 ? this._text : this.children.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get value() { return this._value; }
  set value(v) { this._value = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  append(...kids) { for (const k of kids) { if (k.nodeType === 1) k.parent = this; this.children.push(k); } this._text = ''; }
  replaceChildren(...kids) { this.children = []; this._text = ''; this.append(...kids); }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  focus() {}
  select() {}
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
function reset_dom(prefix, extra = []) {
  const mk = (id) => { const e = new El('div'); e.setAttribute('id', id); return e; };
  doc.body.replaceChildren(mk('main'), mk(prefix + '-lang-ru'), mk(prefix + '-lang-en'), ...extra.map(mk));
  doc.title = '';
}
const by_id = (id) => doc.getElementById(id);
const text_of = (id) => by_id(id)?.textContent ?? null;
const until = async (pred, ms = 8000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) assert.fail('не дождались'); await new Promise((r) => setTimeout(r, 2)); } };
const UA = 'AdvUA/1.0 (X11; <b>bold</b> | y)';
const fake_window = (over = {}) => ({
  document: doc, navigator: { userAgent: UA, language: 'ru-RU', platform: 'P', hardwareConcurrency: 4, onLine: true, clipboard: { writeText: async () => {} } },
  screen: { width: 1, height: 2 }, devicePixelRatio: 1, isSecureContext: true, performance: { now: () => performance.now() }, setTimeout, clearTimeout, setInterval, clearInterval, ...over,
});
const tiny = { tiny: { samples: 2, rounds: 1, warmup: 1 } };
const RAW_KEY = /\b(?:benchpg|coldpg|compatpg|probe)\.[a-z0-9_]+/;
const PLACEHOLDER = /\{[A-Za-z0-9_]+\}/;

// ── 1. связь страниц с настоящим приложением и каталогами (заглушка этого не видит) ────────────────────────────────────────

test('FP-23 adv: селекторы coldstart (#view-title, #nav a[aria-current], href="#overview") существуют в настоящем приложении и index.html', () => {
  const app = read('demo', 'app.mjs');
  const index = read('demo', 'index.html');
  assert.match(index, /<nav id="nav"/);
  assert.match(app, /h\('h2', \{ id: 'view-title'/, 'заголовок раздела с id view-title');
  assert.match(app, /h\('a', \{ href: '#' \+ v\.id, 'aria-current': S\.view === v\.id \? 'page' : null/, 'ссылка раздела с aria-current');
  assert.match(app, /const VIEWS = Object\.freeze\(\['overview'/, 'раздел overview существует');
  const cold = read('demo', 'coldstart_page.mjs');
  assert.ok(cold.includes("getElementById('view-title')") && cold.includes('#nav a[aria-current="page"]') && cold.includes("'#overview'"));
  assert.equal(COLD.APP_URL, './index.html#overview');
  assert.ok(fs.existsSync(path.join(PROTO, 'demo', 'index.html')));
});

test('FP-23 adv: каждый литерал ключа в кодах страниц есть в каталогах обоих языков (опечатка не покажется сырым ключом); динамические семейства полны', () => {
  const all = new Set(Object.values(CAT).flatMap((c) => Object.keys(c.ru)));
  for (const f of ['bench_page.mjs', 'coldstart_page.mjs', 'compat_page.mjs', 'probe_kit.mjs']) {
    const src = read('demo', f).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    const used = [...src.matchAll(/'((?:probe|benchpg|coldpg|compatpg)\.[a-z0-9_]*)'/g)].map((m) => m[1]).filter((k) => !k.endsWith('_') && !k.endsWith('.'));
    for (const k of used) assert.ok(all.has(k), `${f}: ключа нет в каталоге: ${k}`);
  }
  for (const cat of Object.values(CAT)) for (const lang of ['ru', 'en']) for (const v of Object.values(cat[lang])) assert.ok(!/undefined|\[object/.test(v));
});

test('FP-23 adv: страницы в обоих языках не показывают сырых ключей и неподставленных {плейсхолдеров}: bench с полным отчётом, coldstart с неудачным запуском, compat с полным набором', async () => {
  for (const lang of ['ru', 'en']) {
    // bench
    reset_dom('bn');
    const env = fake_window();
    const ports = { ...BENCH_PAGE.make_ports(env), clock: () => new Date(2026, 9, 23), load_g001: async () => structuredClone(G001), yield_ui: async () => {} };
    const page = BENCH_PAGE.make_page(lang, ports);
    page.plans = tiny;
    page.plan = 'tiny';
    BENCH_PAGE.render_page(page);
    await BENCH_PAGE.run_bench(page);
    const bench_text = by_id('main').textContent;
    assert.ok(!RAW_KEY.test(bench_text) && !PLACEHOLDER.test(bench_text), `bench ${lang}: ${(RAW_KEY.exec(bench_text) ?? PLACEHOLDER.exec(bench_text))?.[0]}`);
    // compat
    reset_dom('cp');
    const cenv = fake_window({ indexedDB: undefined, caches: undefined });
    const cports = { ...COMPAT.make_ports(cenv), clock: () => new Date(2026, 9, 23), make_client: () => ({ analyze: async (ws, q) => ({ result: analyze(ws, q), via: 'worker', reason: null }), terminate() {} }), set_timeout: (fn) => setTimeout(fn, 1000) };
    const cpage = COMPAT.make_page(lang, cports);
    COMPAT.render_page(cpage);
    await COMPAT.run_compat(cpage);
    const compat_text = by_id('main').textContent;
    assert.ok(!RAW_KEY.test(compat_text) && !PLACEHOLDER.test(compat_text), `compat ${lang}: ${(RAW_KEY.exec(compat_text) ?? PLACEHOLDER.exec(compat_text))?.[0]}`);
    assert.ok(!RAW_KEY.test(COMPAT.table_text(lang, cpage.report)) && !PLACEHOLDER.test(COMPAT.table_text(lang, cpage.report)));
    // coldstart: окно заблокировано
    reset_dom('cs', ['cs-frame-box']);
    const blocked = { get document() { throw new Error('SecurityError'); } };
    const kports = { ...COLD.make_ports(fake_window()), clock: () => new Date(2026, 9, 23), make_frame: () => ({ contentWindow: blocked, remove() {} }), sleep: async () => {}, timeout_ms: 30, poll_ms: 1, set_interval: (fn, ms) => setInterval(fn, ms), clear_interval: clearInterval, set_timeout: (fn, ms) => setTimeout(fn, ms), clear_timeout: clearTimeout };
    const kpage = COLD.make_page(lang, kports);
    COLD.render_page(kpage);
    await COLD.run_cold(kpage);
    const cold_text = by_id('main').textContent;
    assert.ok(!RAW_KEY.test(cold_text) && !PLACEHOLDER.test(cold_text), `coldstart ${lang}: ${(RAW_KEY.exec(cold_text) ?? PLACEHOLDER.exec(cold_text))?.[0]}`);
  }
});

// ── 2. гонки и поздняя перерисовка ──────────────────────────────────────────────────────────────────────────────────────────

test('FP-23 adv: bench — смена языка ВО ВРЕМЯ замера: страница перерисована, статус на новом языке, на новых узлах кнопка занята; по окончании ответ ложится в новые узлы, исключений нет', async () => {
  reset_dom('bn');
  const env = fake_window();
  let release = null;
  const gate = new Promise((r) => { release = r; });
  let yields = 0;
  const ports = { ...BENCH_PAGE.make_ports(env), clock: () => new Date(2026, 9, 23), load_g001: async () => structuredClone(G001), yield_ui: async () => { yields += 1; if (yields === 2) await gate; } };
  const page = BENCH_PAGE.make_page('ru', ports);
  page.plans = tiny;
  page.plan = 'tiny';
  BENCH_PAGE.render_page(page);
  const old_run = by_id('bn-run');
  const running = BENCH_PAGE.run_bench(page);
  await until(() => yields >= 2);
  page.lang = 'en';
  BENCH_PAGE.render_page(page);
  assert.notEqual(by_id('bn-run'), old_run, 'узел пересоздан перерисовкой (кнопки языка в шапке не затронуты)');
  assert.equal(by_id('bn-run').attrs['aria-disabled'], 'true', 'новая кнопка отражает занятость');
  assert.equal(by_id('bn-stop').attrs['aria-disabled'], 'false');
  assert.match(text_of('bn-status'), /^Benchmark: /, 'статус на английском');
  release();
  const rep = await running;
  assert.ok(rep.sets.length === 4);
  assert.equal(by_id('bn-run').attrs['aria-disabled'], 'false');
  assert.equal(text_of('bn-status'), 'Benchmark finished: 4 sets, n = 2 per set.');
  assert.match(by_id('bn-results').textContent, /Reference G-001/);
  assert.equal(old_run.attrs['aria-disabled'], 'true', 'отсоединённый узел не трогали (ответ идёт через getElementById)');
});

test('FP-23 adv: coldstart — смена языка посреди запуска не трогает вложенное окно (тот же узел в cs-frame-box), окно убрано после запуска', async () => {
  reset_dom('cs', ['cs-frame-box']);
  const env = fake_window();
  let release = null;
  const gate = new Promise((r) => { release = r; });
  const base = COLD.make_ports(env);
  let frame_node = null;
  const win = {
    location: { href: './index.html#overview' },
    performance: { now: () => 500, getEntriesByType: () => [] },
    navigator: {},
    requestAnimationFrame: (fn) => { gate.then(() => setTimeout(fn, 0)); },
  };
  Object.defineProperty(win, 'document', { value: { getElementById: () => ({}), querySelector: () => ({ getAttribute: () => '#overview' }) } });
  const ports = {
    ...base, clock: () => new Date(2026, 9, 23), sleep: async () => {},
    set_timeout: (fn, ms) => setTimeout(fn, ms), clear_timeout: clearTimeout, set_interval: (fn, ms) => setInterval(fn, ms), clear_interval: clearInterval,
    make_frame: (url, title) => { const f = base.make_frame(url, title); f.contentWindow = win; frame_node = f; return f; },
  };
  const page = COLD.make_page('ru', ports);
  page.runs_n = 3;
  COLD.render_page(page);
  const running = COLD.run_cold(page);
  await until(() => frame_node !== null && by_id('cs-frame-box').children.length === 1);
  const box_child = by_id('cs-frame-box').children[0];
  page.lang = 'en';
  COLD.render_page(page);
  assert.equal(by_id('cs-frame-box').children[0], box_child, 'окно приложения не перенесено и не пересоздано при смене языка');
  assert.equal(by_id('cs-run').attrs['aria-disabled'], 'true');
  release();
  const rep = await running;
  assert.equal(rep.summary.ok_runs, 3);
  assert.equal(by_id('cs-frame-box').children.length, 0);
  assert.equal(by_id('cs-run').attrs['aria-disabled'], 'false');
  assert.match(text_of('cs-status'), /^Measurement finished/);
});

// ── 3. числа и сравнение ────────────────────────────────────────────────────────────────────────────────────────────────────

test('FP-23 adv: compare_p95 — свойство на 400 псевдослучайных парах: ok ⇔ p95 ≤ factor·записанное и ≤ бюджет; doubling_check — ok ⇔ все отношения ≤ предел', () => {
  let s = 20261023;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
  for (let i = 0; i < 400; i++) {
    const b = 1 + rnd() * 80;
    const c = rnd() * 220;
    const factor = [1.5, 2, 3][i % 3];
    const r = MODEL.compare_p95({ baseline: { a: b }, current: { a: c }, factor });
    assert.equal(r.ok, c <= b * factor && c <= MODEL.BUDGET.recompute_p95_ms, `b=${b} c=${c} f=${factor}`);
    const pts = [10 + rnd() * 10, 10 + rnd() * 30, 10 + rnd() * 90].map((ms, j) => ({ id: 'p' + j, events: 1000 * 2 ** j, ms }));
    const d = MODEL.doubling_check(pts);
    assert.equal(d.ok, pts[1].ms / pts[0].ms <= 2.5 && pts[2].ms / pts[1].ms <= 2.5);
  }
  assert.equal(MODEL.compare_p95({ baseline: { a: Infinity }, current: { a: 5 } }).rows[0].ok, true, 'бесконечная база: предел роста не срабатывает — только бюджет');
  assert.equal(MODEL.compare_p95({ baseline: { a: NaN }, current: { a: 5 } }).ok, false, 'нечисловая база — не в порядке (отказ в безопасную сторону)');
});

test('FP-23 adv: замер с грубым таймером (целые мс) и с «залипшими» часами не падает; разрешение таймера названо; рост при нулевом времени не засчитывается как «в пределах»', async () => {
  reset_dom('bn');
  const env = fake_window();
  let t = 0;
  const coarse = () => { t += 0.25; return Math.floor(t); }; // шаг часов 1 мс, но не каждый вызов
  const ports = { ...BENCH_PAGE.make_ports(env), now: coarse, clock: () => new Date(2026, 9, 23), load_g001: async () => structuredClone(G001), yield_ui: async () => {} };
  const page = BENCH_PAGE.make_page('ru', ports);
  page.plans = tiny;
  page.plan = 'tiny';
  BENCH_PAGE.render_page(page);
  const rep = await BENCH_PAGE.run_bench(page);
  assert.ok(rep.sets.length >= 1 && Number.isFinite(rep.sets[0].analyze.p95_ms));
  assert.ok(rep.timer_resolution_ms === null || rep.timer_resolution_ms >= 1);
  assert.equal(MODEL.doubling_check([{ id: 'a', events: 1000, ms: 0 }, { id: 'b', events: 2000, ms: 0 }]).ok, false);
  assert.equal(MODEL.stat_of([0, 0, 0]).p95_ms, 0);
});

test('FP-23 adv: --compare не пишет файлов и не меняет _ops/bench.json; ключи — разбор строгий (дробное число замеров, пустое значение коэффициента)', async () => {
  const out = [];
  const io = { log: (m) => out.push(m), error: (m) => out.push(m), measure: async () => ({ n: 1, events: 1, analyze: { p95_ms: 1 }, recompute_q3: { p95_ms: 1 } }) };
  assert.equal(await BENCH.main(['--compare', '--samples', '1.5'], io), 2);
  assert.equal(await BENCH.main(['--compare', '--rounds', '1e1x'], io), 2);
  assert.equal(await BENCH.main(['--compare', '--factor', ''], io), 2);
  assert.equal(await BENCH.main(['--compare', '--factor', '0.5'], io), 2);
  assert.equal(await BENCH.main(['--compare', '--attempts', '-1'], io), 2);
});

// ── 4. известные дефекты (todo: описывают расхождение, прогон не краснят) ──────────────────────────────────────────────────

test('известный дефект FP-23: bench --compare с ключом без значения (--baseline в конце) должен давать код 2, а не падать исключением (код 1 процесса = «регресс»)', { todo: 'path.resolve(undefined) бросает TypeError до проверки ключей' }, async () => {
  const io = { log() {}, error() {}, measure: async () => ({ n: 1, events: 1, analyze: { p95_ms: 1 }, recompute_q3: { p95_ms: 1 } }) };
  let code = null;
  try { code = await BENCH.main(['--compare', '--baseline'], io); } catch { code = 'throw'; }
  assert.equal(code, 2);
});

test('известный дефект FP-23: README называет точки роста 1084 / 2168 / 4336 событий, а настоящие числа движка — 1084 / 2164 / 4329', { todo: 'числа в README и в отчёте реализатора выведены умножением 1084 на 2 и на 4, а не измерены' }, () => {
  const counts = MODEL.SYNTH_POINTS.map((p) => { const ws = MODEL.make_bench_ws(p.copies); return analyze(ws, { as_of: ws.as_of }).events.plan.length; });
  const readme = read('README.md');
  const quoted = /на (\d+) \/ (\d+) \/ (\d+) событиях/.exec(readme);
  assert.ok(quoted, 'в README есть три числа');
  assert.deepEqual(quoted.slice(1).map(Number), counts);
});

test('известный дефект FP-23: остановка замера — верхний n записи равен плану, хотя последний набор измерен не полностью', { todo: 'run_bench кладёт в запись n = samples·rounds даже после «Остановить»' }, async () => {
  reset_dom('bn');
  const env = fake_window();
  let yields = 0;
  let page_ref = null;
  const ports = { ...BENCH_PAGE.make_ports(env), clock: () => new Date(2026, 9, 23), load_g001: async () => structuredClone(G001), yield_ui: async () => { yields += 1; if (yields === 2 && page_ref !== null) page_ref.stop = true; } };
  const page = BENCH_PAGE.make_page('ru', ports);
  page_ref = page;
  page.plans = { two: { samples: 2, rounds: 2, warmup: 1 } };
  page.plan = 'two';
  BENCH_PAGE.render_page(page);
  const rep = await BENCH_PAGE.run_bench(page);
  assert.ok(rep.notes.includes('stopped'));
  const measured = Math.max(...rep.sets.map((s) => s.n));
  const least = Math.min(...rep.sets.map((s) => s.n));
  assert.ok(least < 4, 'один из наборов измерен не полностью');
  assert.equal(rep.n, measured === 4 && least < 4 ? least : measured, 'верхний n должен совпадать с наименьшим n среди наборов или быть пометкой «неполно»');
});

test('известный дефект FP-23: родитель coldstart.html тянет в страницу 18 модулей движка (ради percentile и round2) — те самые файлы, что грузит вложенное приложение; первый запуск теплее настоящего холодного', { todo: 'coldstart_page.mjs импортирует bench_model.mjs, а тот — engine/index.mjs, tools.mjs, verifier.mjs' }, () => {
  const walk = (entry) => {
    const seen = new Set();
    const go = (f) => {
      if (seen.has(f)) return;
      seen.add(f);
      let src = '';
      try { src = fs.readFileSync(f, 'utf8'); } catch { return; }
      src = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
      for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+\.mjs)['"]/g)) go(path.resolve(path.dirname(f), m[1]));
    };
    go(entry);
    return [...seen].map((f) => path.relative(PROTO, f).split(path.sep).join('/'));
  };
  const parent = walk(path.join(PROTO, 'demo', 'coldstart_page.mjs'));
  const engine = parent.filter((f) => f.startsWith('engine/'));
  assert.deepEqual(engine, [], 'страница замера холодного старта не должна загружать движок до замера');
});

// FP-49: todo снят — дефект исправлен пакетом FP-48 (BLOCKED_MS: устойчивое «blocked» замечается за секунду, а не после RUN_TIMEOUT_MS); название прежнее
test('известный дефект FP-23: coldstart — окно, которое браузер заблокировал (frame-ancestors, страница ошибки), называется «blocked» сразу, но запуск ждёт весь тайм-аут (30 с в странице) до объяснения', async () => {
  const blocked = { get document() { throw new Error('SecurityError'); } };
  const ports = {
    now: () => performance.now(), set_interval: (fn, ms) => setInterval(fn, ms), clear_interval: clearInterval, set_timeout: (fn, ms) => setTimeout(fn, ms), clear_timeout: clearTimeout,
    make_frame: () => ({ contentWindow: blocked, remove() {} }), poll_ms: 1, timeout_ms: 400,
  };
  const t0 = performance.now();
  const r = await COLD.run_once(ports, 't');
  const spent = performance.now() - t0;
  assert.equal(r.ok, false);
  assert.equal(r.state, 'blocked');
  assert.ok(spent < 150, `заблокированное окно ждало ${Math.round(spent)} мс из 400`);
});
