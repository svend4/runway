// fp22_adv.test.mjs — состязательная проверка FP-22 (метрики из окон прогноза, «Сообщить об ошибке», карантин записей при открытии чужого файла).
// Файл аддитивный: реализацию он не меняет. Тесты, которые фиксировали найденные дефекты (знак `todo`), после исправления проходят и знак с них снят.
// Часть 1 — метрики (REQ-185): что считается «сверкой остатка».
// Часть 2 — блок «Сообщить об ошибке» (REQ-124): устаревшая отметка «скопировано», глобальные ошибки с экзотическими объектами.
// Часть 3 — карантин (REQ-158): враждебные идентификаторы, инварианты результата на случайных порчах файла.
// Браузер, сеть и серверы не используются. Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/fp22_adv.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(HERE, '..', 'demo');
const DATA = path.join(HERE, '..', 'data');

// ── минимальная заглушка DOM (только то, что нужно dom.mjs h() и блоку «Сообщить об ошибке») ──────────────────────────────
class Node_ {
  constructor(tag) { this.nodeType = 1; this.tagName = tag; this.attrs = {}; this.children = []; this.listeners = {}; this._text = ''; this.className = ''; this.focused = false; }
  get textContent() { return this.children.length === 0 ? this._text : this.children.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return Object.hasOwn(this.attrs, k); }
  append(...kids) { for (const k of kids) this.children.push(k); this._text = ''; }
  replaceChildren(...kids) { this.children = []; this._text = ''; this.append(...kids); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  focus() { this.focused = true; }
  walk(fn) { fn(this); for (const c of this.children) if (c.nodeType === 1) c.walk(fn); }
}
const ROOT = new Node_('div');
const find_one = (id) => { let hit = null; ROOT.walk((n) => { if (hit === null && n.attrs.id === id) hit = n; }); return hit; };
globalThis.document = {
  createElement: (t) => new Node_(t),
  createElementNS: (ns, t) => new Node_(t),
  createTextNode: (data) => ({ nodeType: 3, data }),
  getElementById: (id) => find_one(id),
  body: new Node_('body'),
  documentElement: new Node_('html'),
};

const imp = (rel) => import(pathToFileURL(path.join(DEMO, rel)).href);
const E = await import('../engine/index.mjs');
const V = await import('../engine/validate_ws.mjs');
const FEED = await imp('metrics_feed.mjs');
const MX = await imp('metrics.mjs');
const L = await imp('log.mjs');
const ERV = await imp('error_report_view.mjs');
const Q = await imp('open_quarantine.mjs');

const G = JSON.parse(fs.readFileSync(path.join(DATA, 'g001.json'), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const tick = () => new Promise((r) => setTimeout(r, 5));

function fake_storage() {
  const m = new Map();
  return { m, get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
/** Лента окон над своим хранилищем; окно на G-001 уже открыто (начало 2026-10-04, конец 2026-10-18). */
function opened_feed() {
  const st = fake_storage();
  const metrics = MX.create_metrics({ storage: st, day: () => 0, engine_version: E.ENGINE_VERSION });
  const feed = FEED.create_feed({ storage: st, metrics });
  assert.equal(feed.step(G, { ready: true }).opened, true);
  return { feed, metrics };
}

// ═══ часть 1: метрики ═══════════════════════════════════════════════════════════════════════════════════════════════════════

test('REQ-185 открытие нового операционного счёта с остатком (upsert_account + set_anchor на дату расчёта, формы «Счета» и мастер) не считается сверкой остатка и окно не закрывает (было дефектом)', () => {
  const { feed, metrics } = opened_feed();
  const w = clone(G);
  w.as_of = '2026-10-19';
  w.accounts.push({ account_id: 'acc_new', name: 'Новый счёт', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2, liquidity_bp: 0, opened_on: '2026-10-19' });
  w.anchors.push({ anchor_id: 'anc-new', account_id: 'acc_new', date: '2026-10-19', amount_minor: 10000 });
  const r = feed.step(w, { ready: true });
  assert.equal(r.closed, null, 'основной счёт не сверялся, окно закрывать нельзя: ' + JSON.stringify(r.closed));
  assert.equal(metrics.package().min_error_bp.n, 0);
});

test('REQ-185 якорь позже конца окна, не согласованный с внесёнными фактами (в банке 2 500,00 €, фактов нет), не подтверждает полноту фактов: окно остаётся открытым, в метрики ничего не пишется (было дефектом)', () => {
  const { feed, metrics } = opened_feed();
  const w = clone(G);
  w.as_of = '2026-10-30';
  w.anchors.push({ anchor_id: 'anc-late', account_id: 'acc_main', date: '2026-10-30', amount_minor: 250000 });
  const r = feed.step(w, { ready: true });
  // сегодня запись: ok, error_bp = +596 (факт 4 000,00 € выше прогноза 3 775,00 €), хотя банк показывает на 1 500,00 € меньше ожидаемого
  assert.ok(r.closed === null || r.closed.ok === false, 'окно не должно закрываться с числом, пока якорь расходится с фактами: ' + JSON.stringify(r.closed));
  assert.equal(metrics.package().min_error_bp.n, 0);
});

test('REQ-185 якорь ровно на дату конца окна с остатком ниже ожидаемого: остаток на конец окна берётся из якоря, а минимум окна — только по фактам (после исправления окно без внесённого расхода не закрывается)', () => {
  const { feed, metrics } = opened_feed();
  const w = clone(G);
  w.as_of = '2026-10-18';
  w.anchors.push({ anchor_id: 'anc-end', account_id: 'acc_main', date: '2026-10-18', amount_minor: 250000 });
  assert.equal(feed.step(w, { ready: true }).closed, null, 'в банке на 1 500,00 € меньше, чем следует из записей: факты неполны');
  assert.equal(metrics.package().min_error_bp.n, 0);
  // расход внесён — запись и якорь сходятся, окно закрывается; минимум окна — по фактам, включая внесённый расход
  w.facts.push({ event_id: 'tx-miss', account_id: 'acc_main', date: '2026-10-10', amount_minor: -150000, currency: 'EUR', kind: 'expense', tag: 'прочее' });
  const r = feed.step(w, { ready: true });
  assert.equal(r.closed.ok, true, JSON.stringify(r.closed));
  assert.equal(r.closed.act, 250000, 'остаток на конец окна — из якоря');
  assert.equal(r.closed.a_min, 250000, 'минимум окна — по полным фактам');
  assert.equal(r.closed.error_bp, MX.min_error_bp(377500, 250000));
  assert.deepEqual(metrics.package().min_error_bp, { n: 1, values: [MX.min_error_bp(377500, 250000)] });
});

test('REQ-185 окно на другой рабочей области с тем же workspace_id сравнивается с фактами нового набора (оговорено в README); состояние ключуется только по workspace_id', () => {
  const { feed } = opened_feed();
  const other = clone(G);
  other.name = 'Другой набор с тем же идентификатором';
  assert.deepEqual(feed.peek(other), feed.peek(G), 'ключ — workspace_id');
});

// ═══ часть 2: «Сообщить об ошибке» и глобальные ошибки ═════════════════════════════════════════════════════════════════════

/** Экран блока на заглушке: возвращает ссылки на состояние. */
function mount_report() {
  const logger = L.create_logger();
  const copied = [];
  const ports = { now_ms: () => 0 };
  const deps = ERV.make_deps({ logger, ports, clipboard: () => ({ writeText: async (t) => { copied.push(t); } }) });
  const ctx = { tr: (k, p) => (p === undefined ? k : k + ' ' + JSON.stringify(p)), refresh: () => {} };
  const draw = () => { ROOT.replaceChildren(ERV.render_error_report(ctx, deps)); };
  draw();
  return { logger, deps, ctx, draw, copied };
}

test('REQ-124 после копирования отметка «скопировано» не остаётся, когда в журнале появилась новая ошибка и показанный текст отчёта изменился — она относилась к другому тексту (было дефектом)', async () => {
  const m = mount_report();
  m.logger.error('store_failed', { code: 'E_SCHEMA' });
  m.draw();
  find_one('er-consent').checked = true;
  find_one('er-consent').listeners.change[0]();
  const before = find_one('er-text').textContent;
  find_one('er-copy').listeners.click[0]();
  await tick();
  m.draw(); // общая перерисовка страницы после ответа буфера (ctx.refresh)
  assert.equal(find_one('er-copy-status').textContent, 'errrep.copied', 'сразу после копирования отметка верна');
  assert.deepEqual(m.copied, [before]);
  // позже в журнал попала другая ошибка; страница перерисована (например, по просьбе хранилища)
  m.logger.error('store_failed', { code: 'E_BAD_DATE' });
  m.draw();
  const after = find_one('er-text').textContent;
  assert.notEqual(after, before, 'текст отчёта изменился');
  assert.equal(find_one('er-copy-status').textContent, '', 'отметка «скопировано» относится к прежнему тексту и не должна показываться');
});

test('REQ-124 согласие остаётся на странице, пока она не перезагружена: переход на другой экран и обратно текст отчёта не прячет (документируем текущее поведение)', () => {
  const m = mount_report();
  find_one('er-consent').checked = true;
  find_one('er-consent').listeners.change[0]();
  assert.ok(find_one('er-text') !== null);
  m.draw(); // другой экран → снова «Данные»
  assert.ok(find_one('er-text') !== null, 'согласие живёт в deps.ui весь сеанс');
});

test('REQ-124 глобальные ошибки с экзотическими объектами (бросающие геттеры, замороженные, примитивы, пустое событие, Proxy) никогда не бросают и не кладут текст в журнал', () => {
  const listeners = {};
  const target = { addEventListener: (t, fn) => { (listeners[t] ??= []).push(fn); }, removeEventListener() {} };
  const lg = L.create_logger({ strict: true });
  const off = L.install_global_handlers(target, lg, { engine_version: '9.9.9' });
  const secret = 'СЕКРЕТ-4730';
  const throwing = { get code() { throw new Error(secret); }, get name() { throw new Error(secret); } };
  const frozen = Object.freeze(Object.assign(new RangeError(secret), { code: 'E_NOT_INTEGER' }));
  const fake_name = { name: 'Error', message: secret, stack: secret };
  const proxy = new Proxy({}, { get() { throw new Error(secret); }, has() { throw new Error(secret); }, getPrototypeOf() { throw new Error(secret); } });
  const evs = [
    { error: throwing }, { error: frozen }, { error: secret }, { error: 42 }, { error: null }, { error: fake_name }, { error: proxy }, {}, null, undefined,
    { get error() { throw new Error(secret); } },
  ];
  for (const ev of evs) for (const fn of listeners.error) assert.doesNotThrow(() => fn(ev));
  for (const ev of [{ reason: throwing }, { reason: secret }, { reason: proxy }, {}, null, { get reason() { throw new Error(secret); } }]) for (const fn of listeners.unhandledrejection) assert.doesNotThrow(() => fn(ev));
  const raw = JSON.stringify(lg.entries());
  assert.ok(!raw.includes(secret) && !raw.includes('4730'), 'в журнале нет текста ошибок');
  for (const e of lg.entries()) assert.deepEqual(Object.keys(e).sort(), ['code', 'engine_version', 'event', 'level', 'n'].sort());
  assert.equal(lg.entries().length, 17);
  off();
});

// ═══ часть 3: карантин при открытии чужого файла ═══════════════════════════════════════════════════════════════════════════

function silent() { return { warn() {} }; }

test('REQ-158 враждебные идентификаторы и записи не объекты: разметка, управляющие знаки, очень длинные строки — только текст, журнал в белом списке (строгий логгер), служебное поле __idx не перечисляется', () => {
  const w = clone(G);
  w.rules.push({ rule_id: '<img src=x onerror=alert(1)>', account_id: 'acc_main', amount_minor: -100, currency: 'EUR', interval: 0, kind: 'expense', start: '2026-10-01' });
  w.facts.push({ event_id: 'evt\u0007\nbad', account_id: 'нет-такого', date: '2026-10-02', amount_minor: -100, currency: 'EUR', kind: 'expense' }, null, 7, 'строка');
  const lg = L.create_logger({ strict: true });
  const r = Q.open_foreign(JSON.stringify(w), { logger: lg });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.rejected.length >= 4);
  for (const x of r.rejected) {
    assert.ok(x.id === null || (typeof x.id === 'string' && x.id.length <= 60 && !/[\u0000-\u001f\u007f-\u009f]/.test(x.id)));
    for (const c of x.codes) assert.match(c, /^[A-Za-z][A-Za-z0-9_.:-]{0,31}$/);
    for (const s of x.reasons) assert.match(s, /^[A-Za-z0-9_.:-]{1,40}$/);
  }
  assert.ok(!Object.keys(r.ws).includes('__idx'));
  assert.ok(!JSON.stringify(r.ws).includes('__idx'));
  assert.equal(V.analyze_checked(r.ws, { as_of: r.ws.as_of }).ok, true);
  assert.equal(lg.dropped(), 0);
  for (const e of lg.entries()) for (const k of Object.keys(e)) assert.ok(['level', 'event', 'id', 'n', 'code'].includes(k), k);
});

/** Детерминированный ГПСЧ (LCG): повторяемые порчи. */
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

test('REQ-158 инвариант на случайных порчах: open_foreign не бросает; при ok результат проходит строгую validate_ws и analyze_checked (иначе adopt_workspace упадёт), а число отброшенного не больше числа записей файла', () => {
  const rand = rng(20261023);
  const junk = [null, 0, -1, 1.5, 2 ** 53, '', 'x', 'ΩΩ', [], {}, true, '2026-02-30', 'EUR', 'ZZZ9', 99999, -99999];
  const lists = ['accounts', 'rules', 'facts', 'anchors', 'plans', 'overrides', 'tax_rules', 'reserves', 'allocations', 'rates', 'scenarios', 'purchases', 'debts', 'streams', 'calendars'];
  let ok_n = 0;
  let reject_n = 0;
  for (let i = 0; i < 150; i++) {
    const w = clone(G);
    const muts = 1 + Math.floor(rand() * 3);
    for (let m = 0; m < muts; m++) {
      const name = lists[Math.floor(rand() * lists.length)];
      const list = Array.isArray(w[name]) ? w[name] : null;
      if (list === null || list.length === 0) { w[name] = junk[Math.floor(rand() * junk.length)]; continue; }
      const idx = Math.floor(rand() * list.length);
      const rec = list[idx];
      const mode = Math.floor(rand() * 3);
      if (mode === 0) list[idx] = junk[Math.floor(rand() * junk.length)];
      else if (rec !== null && typeof rec === 'object') {
        const keys = Object.keys(rec);
        if (keys.length === 0) continue;
        const k = keys[Math.floor(rand() * keys.length)];
        if (mode === 1) delete rec[k]; else rec[k] = junk[Math.floor(rand() * junk.length)];
      }
    }
    const total = lists.reduce((a, n) => a + (Array.isArray(w[n]) ? w[n].length : 0), 0);
    const r = Q.open_foreign(JSON.stringify(w), { logger: silent() });
    assert.equal(typeof r.ok, 'boolean');
    if (!r.ok) { reject_n++; assert.match(r.error, /^[A-Za-z][A-Za-z0-9_.:-]{0,31}$/); continue; }
    ok_n++;
    assert.equal(V.validate_ws(r.ws, { as_of: r.ws.as_of }).ok, true, 'результат прошёл строгую проверку, итерация ' + i);
    assert.equal(V.analyze_checked(r.ws, { as_of: r.ws.as_of }).ok, true);
    assert.ok(r.rejected.length <= total + lists.length, 'отброшено не больше, чем было записей');
    assert.doesNotThrow(() => E.analyze(r.ws, { as_of: r.ws.as_of }));
  }
  assert.ok(ok_n > 20, `открытых файлов: ${ok_n}, отвергнутых: ${reject_n}`);
});
