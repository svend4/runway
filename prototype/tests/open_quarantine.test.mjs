// open_quarantine.test.mjs — FP-22, REQ-158 (TST-51), Q-22, N-3: открытие чужого файла идёт через inspect_import → validate_ws → карантин записей → analyze_checked.
// Часть 1 — модуль без DOM (open_foreign): чистые файлы (все шесть наборов data/) открываются как есть и побайтно равны прежней рабочей области; один невалидный объект
// (правило с interval = 0, налоговая ставка 99999 bp, факт с неизвестным счётом) отбрасывается и перечисляется, остальное считается; весь файл отвергается только при нарушении схемы
// верхнего уровня; журнал приложения получает по записи идентификатор (до 32 знаков) и код; фаззинг 300 повреждённых файлов не бросает исключений.
// Часть 2 — настоящий app.mjs на заглушке DOM: загрузка файла на экране «Данные» — чистый файл без перечня, файл с плохими записями с перечнем (таблица, сообщение, журнал),
// отказ при нарушении верхнего уровня не трогает открытые данные, перечень исчезает при смене набора, файл новее формата открывается «только для просмотра», EN без русских слов.
// Браузер, сеть и серверы не используются. Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/open_quarantine.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(HERE, '..', 'demo');
const DATA = path.join(HERE, '..', 'data');

class Node_ {
  constructor(tag, ns) {
    this.nodeType = 1; this.tagName = tag; this.ns = ns ?? null; this.attrs = {}; this.children = []; this.listeners = {}; this.className = '';
    this._text = ''; this._value = ''; this._sel = null; this.open = false; this.focused = false;
  }
  get textContent() { return this.children.length === 0 ? this._text : this.children.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get value() {
    if (this.tagName === 'select') {
      if (this._sel !== null) return this._sel;
      const opts = this.children.filter((c) => c.tagName === 'option');
      const hit = opts.find((o) => o.attrs.selected !== undefined) ?? opts[0];
      return hit === undefined ? '' : hit.attrs.value;
    }
    return this._value;
  }
  set value(v) { if (this.tagName === 'select') this._sel = String(v); else this._value = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this._value = String(v); }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return Object.hasOwn(this.attrs, k); }
  append(...kids) { for (const k of kids) this.children.push(k); this._text = ''; }
  replaceChildren(...kids) { this.children = []; this._text = ''; this.append(...kids); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  focus() { this.focused = true; }
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
globalThis.document = {
  createElement: (t) => new Node_(t),
  createElementNS: (ns, t) => new Node_(t, ns),
  createTextNode: (data) => ({ nodeType: 3, data }),
  getElementById: (id) => byid.get(id) ?? find_all(byid.get('main'), (n) => n.attrs.id === id)[0] ?? null,
  documentElement: new Node_('html'),
  head: new Node_('head'),
  body: new Node_('body'),
  title: '',
};
globalThis.window = { addEventListener: (t, fn) => { (listeners[t] ??= []).push(fn); }, scrollTo: () => {} };
globalThis.location = { hash: '' };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'ru-RU' }, configurable: true });
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.ResizeObserver = class { observe() {} };
globalThis.fetch = async (url) => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8')) });

const { ext } = await import(pathToFileURL(path.join(DEMO, 'ext.mjs')).href);
await import(pathToFileURL(path.join(DEMO, 'app.mjs')).href);
await new Promise((r) => setTimeout(r, 700));

const E = await import('../engine/index.mjs');
const Q = await import(pathToFileURL(path.join(DEMO, 'open_quarantine.mjs')).href);
const L = await import(pathToFileURL(path.join(DEMO, 'log.mjs')).href);
const DAA = await import(pathToFileURL(path.join(DEMO, 'data_actions.mjs')).href);
const APP = await import(pathToFileURL(path.join(DEMO, 'app.mjs')).href);
const CATALOG = (await import(pathToFileURL(path.join(DEMO, 'i18n', 'quarantine.mjs')).href)).default;
const V = await import('../engine/validate_ws.mjs');

const clone = (x) => JSON.parse(JSON.stringify(x));
const N = (x) => String(x).replace(/[  ]/g, ' ');
const DATASETS = ['g001', 'g001-low', 'g001-gap', 'g001-late', 'g001-empty', 'g001-debt'];
const text_of_dataset = (n) => fs.readFileSync(path.join(DATA, n + '.json'), 'utf8');
const G = JSON.parse(text_of_dataset('g001'));
const with_ws = (fn) => { const w = clone(G); fn(w); return w; };
const silent = () => ({ warn() {}, error() {}, info() {} });
/** Копия набора G-001, «сохранённая более новой версией программы»: формат /2 и две записи, которых эта версия прочитать не может (как в readonly_boot.test). */
function newer_copy_text() {
  const obj = JSON.parse(DAA.export_journal_copy(DAA.events_of_ws(G)).text);
  obj.format = 'runway-journal/2';
  obj.engine_version = '0.2.0';
  const last = obj.events.at(-1).seq;
  obj.events.push(
    { actor: 'user', entity_id: 'cat-food', event_id: 'ev-x1', payload: { category_id: 'cat-food', name: 'Продукты' }, recorded_at: '2026-10-05T08:00:00Z', seq: last + 1, type: 'category.set', v: 1 },
    { actor: 'user', entity_id: 'tx-next', event_id: 'ev-x2', payload: { account_id: 'acc_main', amount: { currency: 'EUR', minor: -1999 }, date: '2026-10-03' }, recorded_at: '2026-10-05T08:00:00Z', seq: last + 2, type: 'tx.posted', v: 2 },
  );
  return JSON.stringify(obj);
}
const main = () => byid.get('main');
const by_id = (id) => find_all(main(), (n) => n.attrs.id === id)[0];
const go = async (hash) => { location.hash = hash; for (const fn of listeners.hashchange ?? []) fn(); await null; };
const ctx = ext.ctx;

// ═══ часть 1: модуль без DOM ═════════════════════════════════════════════════════════════════════════════════════════════════

test('REQ-158 Q-22 N-3 чистые файлы: все шесть наборов data/ открываются как есть — карантина нет, рабочая область побайтно равна прочитанной из файла, журнал приложения молчит', () => {
  for (const name of DATASETS) {
    const lg = L.create_logger({ strict: true });
    const text = text_of_dataset(name);
    const r = Q.open_foreign(text, { logger: lg });
    assert.equal(r.ok, true, name + ' ' + JSON.stringify(r));
    assert.equal(r.kind, 'workspace');
    assert.equal(r.quarantined, false, name);
    assert.deepEqual(r.rejected, []);
    assert.equal(r.read_only, null);
    assert.equal(JSON.stringify(r.ws), JSON.stringify(JSON.parse(text)), name + ': рабочая область равна файлу');
    assert.deepEqual(lg.entries(), [], name + ': журнал не получил записей');
  }
});

test('REQ-158 Q-22 один невалидный объект больше не отвергает весь файл: правило с interval = 0 отброшено и названо, три других правила считаются так, будто его нет; исходный текст файла не меняется', () => {
  const ws = with_ws((w) => { w.rules[1].interval = 0; });
  const text = JSON.stringify(ws);
  assert.throws(() => E.analyze(ws, { as_of: ws.as_of }), (e) => e.code === 'E_RULE_INVALID', 'прежний путь отвергал весь файл');
  const r = Q.open_foreign(text, { logger: silent() });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.quarantined, true);
  assert.deepEqual(r.rejected, [{ kind: 'rules', id: ws.rules[1].rule_id, codes: ['E_RULE_INVALID'], reasons: ['int_ge_1'] }]);
  assert.equal(r.ws.rules.length, 3);
  assert.ok(!r.ws.rules.some((x) => x.rule_id === ws.rules[1].rule_id));
  const clean = clone(G);
  clean.rules.splice(1, 1);
  const a = E.analyze(r.ws, { as_of: r.ws.as_of });
  const b = E.analyze(clean, { as_of: clean.as_of });
  assert.equal(a.inputs_hash, b.inputs_hash, 'считается ровно так, будто правила нет');
  assert.deepEqual(a.series.plan.close, b.series.plan.close);
  assert.equal(JSON.stringify(ws.rules[1].interval), '0', 'исходный объект не изменён');
});

test('REQ-158 Q-22 несколько плохих объектов: налоговое правило с rate_bp = 99999 и факт с неизвестным счётом — оба отброшены и перечислены; параметр вне диапазона заменён по умолчанию и посчитан', () => {
  const ws = with_ws((w) => { w.tax_rules[0].rate_bp = 99999; w.facts[3].account_id = 'призрак'; w.params = { ...(w.params ?? {}), horizon_days: 99999 }; });
  const lg = L.create_logger({ strict: true });
  const r = Q.open_foreign(JSON.stringify(ws), { logger: lg });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.rejected.map((x) => x.kind).sort(), ['facts', 'tax_rules']);
  assert.equal(r.params_replaced, 1);
  assert.equal(r.ws.facts.length, G.facts.length - 1);
  assert.equal(r.ws.tax_rules.length, 0);
  assert.equal(E.analyze(r.ws, { as_of: r.ws.as_of }).as_of, E.to_epoch_day(G.as_of), 'расчёт идёт');
  assert.equal(V.analyze_checked(r.ws, { as_of: r.ws.as_of }).ok, true, 'очищенная область проходит строгую проверку');
});

test('REQ-158 журнал приложения: по каждой отброшенной записи — идентификатор (до 32 знаков, безопасные знаки) и код, итог с числом; текст файла, названия и суммы в журнал не попадают', () => {
  const ws = with_ws((w) => { w.rules[1].interval = 0; w.rules[1].name = 'Секретная аренда 4730'; w.rules[1].rule_id = 'Зарплата октябрь ' + 'x'.repeat(60); w.facts[3].account_id = 'призрак'; });
  const lg = L.create_logger({ strict: true }); // строгий: любое поле вне белого списка или негодное значение было бы исключением
  const r = Q.open_foreign(JSON.stringify(ws), { logger: lg });
  assert.equal(r.ok, true, JSON.stringify(r));
  const e = lg.entries().map((x) => ({ ...x }));
  assert.equal(e.length, 3, JSON.stringify(e));
  assert.deepEqual(e[0], { level: 'warn', event: 'file_quarantine', n: 2 });
  assert.deepEqual(e.slice(1).map((x) => x.event), ['record_quarantined', 'record_quarantined']);
  for (const x of e.slice(1)) {
    assert.ok(typeof x.code === 'string' && /^E_/.test(x.code), x.code);
    if (x.id !== undefined) { assert.ok(String(x.id).length <= L.LOG_MAX_STRING); assert.match(String(x.id), /^[A-Za-z0-9_.:~@/?…-]+$/); }
  }
  const raw = JSON.stringify(e);
  for (const s of ['Секретн', 'аренда', '4730', 'призрак', 'Зарплата']) assert.ok(!raw.includes(s), 'в журнале нет: ' + s);
  assert.equal(lg.dropped(), 0);
  // записей больше предела: отдельные записи только до MAX_LOGGED, итог — с полным числом
  const many = with_ws((w) => { w.rules = w.rules.concat(Array.from({ length: 70 }, (_, i) => ({ ...w.rules[0], rule_id: 'BAD-' + i, interval: 0 }))); });
  const lg2 = L.create_logger({ ring: 500 });
  const r2 = Q.open_foreign(JSON.stringify(many), { logger: lg2 });
  assert.equal(r2.ok, true);
  assert.equal(r2.rejected.length, 70);
  assert.equal(lg2.entries().filter((x) => x.event === 'record_quarantined').length, Q.MAX_LOGGED);
  assert.equal(lg2.entries()[0].n, 70);
});

test('REQ-158 весь файл отвергается только при нарушении схемы верхнего уровня: не JSON, не объект, нет as_of, неверная дата, слишком большой, формат без читаемого, расчёт невозможен и после карантина', () => {
  const cases = [
    ['{не json', 'bad_json'],
    ['[1,2,3]', 'not_a_copy'],
    ['42', 'not_a_copy'],
    ['{"accounts":[]}', 'not_a_copy'],
    [JSON.stringify({ ...clone(G), as_of: '2026-13-45' }), 'E_BAD_DATE'],
    [JSON.stringify({ ...clone(G), as_of: '2026-02-30' }), 'E_BAD_DATE'],
    [JSON.stringify({ format: 'runway-journal/9', events: [] }), 'E_SCHEMA'],
    [' '.repeat(6 * 1024 * 1024), 'too_big'],
    ['{"as_of":"2026-10-04","accounts":[{"__proto__":{"polluted":true},"account_id":"a"}]}', 'E_SCHEMA'],
  ];
  for (const [text, code] of cases) {
    const lg = L.create_logger({ strict: true });
    const r = Q.open_foreign(text, { logger: lg });
    assert.equal(r.ok, false, text.slice(0, 40));
    assert.equal(r.error, code, text.slice(0, 40) + ' → ' + JSON.stringify(r));
    assert.equal(r.stage, 'file');
    assert.ok(!JSON.stringify(r).includes('polluted'), 'текст файла в ответ не попадает');
    assert.equal(lg.entries().length, 1, 'отказ записан одной строкой журнала');
    assert.equal(lg.entries()[0].event, 'file_rejected');
  }
  // ответ с причиной — только безопасные знаки
  const bad_date = Q.open_foreign(JSON.stringify({ ...clone(G), as_of: '2026-13-45' }), { logger: silent() });
  assert.match(bad_date.ctx.reason, /^[A-Za-z0-9_.:-]{1,40}$/);
  assert.equal(Q.open_foreign(5, { logger: silent() }).ok, false);
  assert.equal(Q.open_foreign(undefined, { logger: silent() }).ok, false);
  // сломанный журнал не мешает отказу
  assert.equal(Q.open_foreign('{не json', { logger: { warn() { throw new Error('журнал сломан'); } } }).error, 'bad_json');
});

test('REQ-158 файл-копия журнала (runway-journal/1) открывается тем же путём: чистая — как есть, с плохим правилом — с карантином', () => {
  const copy = DAA.export_journal_copy(DAA.events_of_ws(G));
  const r = Q.open_foreign(copy.text, { logger: silent() });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.kind, 'journal');
  assert.equal(r.quarantined, false);
  assert.equal(E.analyze(r.ws, { as_of: r.ws.as_of }).inputs_hash, E.analyze(G, { as_of: G.as_of }).inputs_hash, 'круг без потерь: те же числа');
  const bad = with_ws((w) => { w.rules[1].interval = 0; });
  const events = DAA.events_of_ws(bad);
  const text = DAA.export_journal_copy(events).text;
  const rb = Q.open_foreign(text, { logger: silent() });
  assert.equal(rb.ok, true, JSON.stringify(rb));
  assert.equal(rb.quarantined, true);
  assert.deepEqual(rb.rejected.map((x) => x.kind), ['rules']);
});

test('REQ-158 REQ-016 файл новее известного формата: открывается «только для просмотра» (read_only), проверка записей идёт по копии без поля format; плохая запись и тут отбрасывается', () => {
  const newer = with_ws((w) => { w.format = 'runway-journal/9'; });
  const r = Q.open_foreign(JSON.stringify(newer), { logger: silent() });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.read_only.newer_format, true);
  assert.equal(r.ws.format, 'runway-journal/9', 'рабочая область остаётся как в файле');
  assert.equal(r.quarantined, false);
  const both = with_ws((w) => { w.format = 'runway-journal/9'; w.rules[1].interval = 0; });
  const rb = Q.open_foreign(JSON.stringify(both), { logger: silent() });
  assert.equal(rb.ok, true, JSON.stringify(rb));
  assert.equal(rb.quarantined, true);
  assert.notEqual(rb.read_only, null);
  const fx = newer_copy_text();
  const rf = Q.open_foreign(fx, { logger: silent() });
  assert.equal(rf.ok, true, JSON.stringify(rf));
  assert.equal(rf.kind, 'journal');
  assert.notEqual(rf.read_only, null, 'запись новее известной: просмотр');
});

test('TST-51 REQ-158 фаззинг: 300 повреждённых файлов — open_foreign не бросает исключений; ответ — открытая область (расчёт идёт) или код из набора REQ-017 и безопасные причины', () => {
  let seed = 20261023;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const junk = [null, 0, -1, 1.5, 2 ** 53, 'x', '', [], {}, { a: 1 }, true, '2026-13-45', 'призрак', [[]], 1e308];
  const lists = ['accounts', 'rules', 'facts', 'anchors', 'plans', 'streams', 'tax_rules', 'reserves', 'allocations', 'rates', 'scenarios', 'debts', 'calendars', 'overrides'];
  const codes = new Set(['E_NOT_INTEGER', 'E_OVERFLOW', 'E_BAD_DATE', 'E_FUTURE_POSTED', 'E_RULE_INVALID', 'E_CURRENCY_MISMATCH', 'E_NO_RATE', 'E_SCHEMA', 'bad_json', 'not_a_copy', 'too_big']);
  let opened = 0; let quarantined = 0; let refused = 0;
  for (let i = 0; i < 300; i++) {
    const w = clone(G);
    const muts = 1 + rnd(3);
    for (let k = 0; k < muts; k++) {
      const name = lists[rnd(lists.length)];
      const list = w[name];
      const mode = rnd(4);
      if (mode === 0) w[name] = junk[rnd(junk.length)];
      else if (Array.isArray(list) && list.length > 0) {
        const rec = list[rnd(list.length)];
        const keys = rec !== null && typeof rec === 'object' ? Object.keys(rec) : [];
        if (mode === 1 && keys.length > 0) rec[keys[rnd(keys.length)]] = junk[rnd(junk.length)];
        else if (mode === 2 && keys.length > 0) delete rec[keys[rnd(keys.length)]];
        else list[rnd(list.length)] = junk[rnd(junk.length)];
      }
    }
    if (rnd(25) === 0) w.as_of = junk[rnd(junk.length)];
    if (rnd(40) === 0) w.params = junk[rnd(junk.length)];
    let r;
    try { r = Q.open_foreign(JSON.stringify(w), { logger: silent() }); } catch (e) { assert.fail(`файл ${i}: исключение ${e?.name}: ${e?.message}`); }
    if (r.ok) {
      opened += 1;
      if (r.quarantined) quarantined += 1;
      assert.doesNotThrow(() => E.analyze(r.ws, { as_of: r.ws.as_of }), `файл ${i}: открытая область должна считаться`);
      for (const x of r.rejected) { assert.ok(x.codes.length > 0); assert.match(x.kind, /^[a-z_]+$/); assert.ok(x.id === null || x.id.length <= 60); }
    } else {
      refused += 1;
      assert.ok(codes.has(r.error), `файл ${i}: код ${r.error}`);
      assert.ok(r.ctx === undefined || /^[A-Za-z0-9_.:-]{0,40}$/.test(r.ctx.reason ?? ''), `файл ${i}: причина ${JSON.stringify(r.ctx)}`);
    }
  }
  assert.equal(opened + refused, 300);
  assert.ok(quarantined > 20, 'карантин спасает заметную часть файлов, которые прежде отвергались: ' + JSON.stringify({ opened, quarantined, refused }));
});

test('REQ-158 clean_rejected: неизвестный раздел — «other», код и причина из безопасных знаков, идентификатор без управляющих знаков и не длиннее 60; kind_label — подпись раздела', () => {
  const out = Q.clean_rejected([
    { kind: 'rules', id: 'R-1\u0007\n' + 'z'.repeat(100), codes: ['E_RULE_INVALID', 'не код', 5], reasons: ['int_ge_1', 'плохая причина 4730', 'x'.repeat(100)] },
    { kind: '__proto__', id: null, codes: [], reasons: [] },
    null, 5, 'x',
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, 'rules');
  assert.ok(out[0].id.length <= 60 && !/[\u0000-\u001f]/.test(out[0].id));
  assert.deepEqual(out[0].codes, ['E_RULE_INVALID']);
  assert.ok(out[0].reasons.every((x) => /^[A-Za-z0-9_.:?-]{1,40}$/.test(x)), JSON.stringify(out[0].reasons));
  assert.deepEqual(out[1], { kind: 'other', id: null, codes: ['E_SCHEMA'], reasons: [] });
  assert.deepEqual(Q.clean_rejected('нет'), []);
  const tr = (k) => k;
  assert.equal(Q.kind_label(tr, 'facts'), 'quarantine.kind_facts');
  assert.equal(Q.kind_label(tr, 'constructor'), 'quarantine.kind_other');
  assert.deepEqual([...Q.KINDS].sort(), ['accounts', 'allocations', 'anchors', 'calendars', 'counterparties', 'debts', 'facts', 'overrides', 'plans', 'purchases', 'rates', 'reserves', 'rules', 'scenarios', 'streams', 'tax_rules', 'wave_overrides'].sort());
});

test('TST-56 REQ-158 каталог quarantine: RU и EN, ключи используются литералами в коде, плейсхолдеры одинаковы, в RU русские буквы, в EN их нет; подпись есть для каждого раздела', () => {
  assert.deepEqual(Object.keys(CATALOG.ru).sort(), Object.keys(CATALOG.en).sort());
  const code = fs.readFileSync(path.join(DEMO, 'open_quarantine.mjs'), 'utf8');
  for (const k of Object.keys(CATALOG.ru)) {
    // подписи разделов строятся из KINDS по ключу `quarantine.kind_<раздел>`: они используются через kind_label
    if (k.startsWith('quarantine.kind_')) continue;
    assert.ok(code.includes(`'${k}'`), `ключ ${k} не используется литералом`);
  }
  for (const kind of [...Q.KINDS, 'other']) assert.ok(Object.hasOwn(CATALOG.ru, 'quarantine.kind_' + kind), 'подпись раздела ' + kind);
  for (const k of Object.keys(CATALOG.ru)) {
    assert.match(CATALOG.ru[k], /[А-Яа-яЁё]/, k);
    assert.ok(!/[А-Яа-яЁё]/.test(CATALOG.en[k]), 'EN без русских букв: ' + k);
    assert.deepEqual([...CATALOG.ru[k].matchAll(/{(\w+)}/g)].map((m) => m[1]).sort(), [...CATALOG.en[k].matchAll(/{(\w+)}/g)].map((m) => m[1]).sort(), k);
  }
});

// ═══ часть 2: настоящий app.mjs на заглушке DOM ══════════════════════════════════════════════════════════════════════════════

/** Выбрать файл на экране «Данные» (как это делает браузер) и дождаться окончания открытия. */
async function pick_file(text, name = 'moi.json', size = undefined) {
  await go('#data');
  const input = by_id('file-in');
  assert.ok(input !== undefined, 'на экране «Данные» есть выбор файла');
  input.files = [{ name, size: size ?? text.length, text: async () => text }];
  await input.listeners.change[0]();
}
const notice = () => N(find_all(main(), (n) => n.attrs.role === 'status' && n.tagName === 'p').map((n) => n.textContent).join(' | '));

test('REQ-158 boot: app.mjs берёт открытие файла из open_quarantine; пакет FP-22 подхвачен; чистый файл открывается как раньше — без перечня и без записей в журнале', async () => {
  assert.ok(ext.diagnostics().some((d) => d.pack === 'pack_fp22' && d.status === 'ok'));
  const src = fs.readFileSync(path.join(DEMO, 'app.mjs'), 'utf8');
  assert.ok(/from '\.\/open_quarantine\.mjs'/.test(src));
  assert.ok(!/pack_fp22/.test(src), 'app.mjs пакет по имени не знает');
  const before = L.log.entries().length;
  const clean = JSON.parse(text_of_dataset('g001-low'));
  clean.name = 'Мой набор';
  await pick_file(JSON.stringify(clean), 'moi.json');
  assert.ok(notice().includes('Файл загружен: Мой набор.'), notice());
  assert.equal(by_id('quarantine'), undefined, 'перечня нет');
  assert.equal(ctx.get_ws().name, 'Мой набор');
  assert.equal(ctx.get_model().ctx.inputs_hash, E.analyze(clean, { as_of: clean.as_of }).inputs_hash, 'числа как у прямого расчёта');
  assert.equal(L.log.entries().length, before, 'журнал приложения не получил записей');
  assert.equal(by_id('ds-sel').value, 'custom');
});

test('REQ-158 Q-22 файл с плохими записями открывается без них: сообщение с числом, раздел «Отброшено при открытии файла» с таблицей (раздел, запись, код, причина), записи журнала приложения', async () => {
  const bad = with_ws((w) => { w.name = 'С ошибками'; w.rules[1].interval = 0; w.tax_rules[0].rate_bp = 99999; });
  const before = L.log.entries().length;
  await pick_file(JSON.stringify(bad), 'bad.json');
  const t = notice();
  assert.ok(t.includes('Файл загружен: С ошибками.'), t);
  assert.ok(t.includes('Файл открыт без записей, не прошедших проверку (карантин): 2. Перечень ниже.'), t);
  const sec = by_id('quarantine');
  assert.ok(sec !== undefined, 'раздел перечня на экране');
  assert.equal(N(by_id('quarantine-title').textContent), 'Отброшено при открытии файла');
  const rows = find_all(sec, (n) => n.tagName === 'tr').slice(1).map((tr) => find_all(tr, (n) => n.tagName === 'th' || n.tagName === 'td').map((c) => N(c.textContent)));
  assert.deepEqual(rows, [['Правила', bad.rules[1].rule_id, 'E_RULE_INVALID', 'int_ge_1'], ['Налоговые правила', bad.tax_rules[0].tax_rule_id, 'E_RULE_INVALID', 'int_0_10000']]);
  assert.ok(N(sec.textContent).includes('Тот же перечень записан в журнал приложения'));
  // данные в приложении: плохих записей нет, остальное считается
  const ws = ctx.get_ws();
  assert.equal(ws.rules.length, 3);
  assert.equal(ws.tax_rules.length, 0);
  assert.ok(ctx.get_model() !== null && ctx.get_model().ctx.series.plan.close.length > 10);
  // журнал приложения: итог и по записи на каждую
  const added = L.log.entries().slice(before).map((x) => ({ ...x }));
  assert.equal(added[0].event, 'file_quarantine');
  assert.equal(added[0].n, 2);
  assert.deepEqual(added.slice(1).map((x) => [x.event, x.code]), [['record_quarantined', 'E_RULE_INVALID'], ['record_quarantined', 'E_RULE_INVALID']]);
  // «Отменить» и обычная работа после такого открытия живы
  assert.equal(ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 55000 }).ok, true);
});

test('REQ-158 отказ при нарушении схемы верхнего уровня: сообщение называет причину, открытые данные и перечень прежнего файла не тронуты; не JSON и слишком большой файл — прежние сообщения', async () => {
  const hash = ctx.get_model().ctx.inputs_hash;
  const ws0 = ctx.get_ws();
  await pick_file(JSON.stringify({ ...clone(G), as_of: '2026-13-45' }), 'x.json');
  assert.ok(notice().startsWith('Файл не открыт: нарушена структура верхнего уровня ('), notice());
  assert.ok(notice().endsWith('Данные в приложении не изменены.'), notice());
  assert.equal(ctx.get_ws(), ws0, 'рабочая область — тот же объект');
  assert.equal(ctx.get_model().ctx.inputs_hash, hash);
  assert.ok(by_id('quarantine') !== undefined, 'перечень относится к ещё открытым данным и остаётся');
  await pick_file('{не json', 'x.json');
  assert.ok(notice().includes('Файл не соответствует формату'), notice());
  await pick_file('{}', 'x.json', 6 * 1024 * 1024);
  assert.ok(notice().includes('Файл больше 5 МБ'), notice());
  await pick_file('[1]', 'x.json');
  assert.ok(notice().includes('Файл не соответствует формату'), notice());
  assert.equal(ctx.get_ws(), ws0);
});

test('REQ-158 перечень отброшенного исчезает при смене набора данных; английский интерфейс рисует сообщение и перечень из каталога EN без русских слов', async () => {
  const bad = with_ws((w) => { w.name = 'With errors'; w.rules[1].interval = 0; });
  find_all(byid.get('controls'), (n) => n.attrs.lang === 'en')[0].listeners.click[0]();
  await pick_file(JSON.stringify(bad), 'bad.json');
  const t = notice();
  assert.ok(t.includes('File loaded: With errors.') && t.includes('quarantine): 1.'), t);
  const sec = by_id('quarantine');
  assert.equal(N(by_id('quarantine-title').textContent), 'Dropped while opening the file');
  assert.ok(!/[А-Яа-яЁё]/.test(sec.textContent), sec.textContent.match(/[^\n]{0,30}[А-Яа-яЁё][^\n]{0,20}/)?.[0]);
  const rows = find_all(sec, (n) => n.tagName === 'tr').slice(1).map((tr) => find_all(tr, (n) => n.tagName === 'td' || n.tagName === 'th').map((c) => N(c.textContent)));
  assert.equal(rows[0][0], 'Rules');
  // отказ в EN
  await pick_file(JSON.stringify({ ...clone(G), as_of: '2026-13-45' }), 'x.json');
  assert.ok(notice().startsWith('The file is not opened: its top-level structure is broken ('), notice());
  find_all(byid.get('controls'), (n) => n.attrs.lang === 'ru')[0].listeners.click[0]();
  // смена набора: перечень уходит
  await go('#data');
  const sel = by_id('ds-sel');
  sel.value = 'g001';
  await sel.listeners.change[0]();
  await go('#data');
  assert.equal(by_id('quarantine'), undefined, 'перечень прежнего файла не относится к новому набору');
  assert.equal(by_id('ds-sel').value, 'g001');
});

test('REQ-158 REQ-016 файл новее известного формата, выбранный на экране «Данные», открывается «только для просмотра»; выбор встроенного набора выходит из режима', async () => {
  await pick_file(newer_copy_text(), 'draft.json');
  assert.notEqual(ctx.read_only(), null, 'режим «только чтение» включён');
  assert.ok(notice().startsWith('Файл загружен'), notice());
  assert.equal(ctx.edit({ type: 'set_param', key: 'buffer_minor', value: 1000 }).ok, false, 'правка отклонена');
  await go('#data');
  const sel = by_id('ds-sel');
  sel.value = 'g001';
  await sel.listeners.change[0]();
  assert.equal(ctx.read_only(), null, 'встроенный набор снимает режим');
  assert.equal(APP.MAX_FILE_BYTES, 5 * 1024 * 1024);
});

test('REQ-158 файл, выгруженный самим приложением после правок (счёт, факт, сверка, буфер, «Сегодня», сценарий), открывается как есть: без карантина и побайтно равен выгрузке', async () => {
  await go('#data');
  const sel = by_id('ds-sel');
  sel.value = 'g001';
  await sel.listeners.change[0]();
  const edits = [
    { type: 'set_as_of', date: '2026-10-10' },
    { type: 'upsert_account', account: { account_id: 'acc_cash', name: 'Наличные', kind: 'cash', liquidity: 'operating', currency: 'EUR', exponent: 2, opened_on: '2026-01-01' } },
    { type: 'add_fact', fact: { account_id: 'acc_cash', date: '2026-10-09', amount_minor: -500, currency: 'EUR', kind: 'expense', tag: 'кофе' } },
    { type: 'set_anchor', anchor: { account_id: 'acc_main', date: '2026-10-10', amount_minor: 395000 } },
    { type: 'set_param', key: 'buffer_minor', value: 50000 },
    { type: 'save_scenario', scenario: { name: 'Проба', ops: [] } },
  ];
  for (const e of edits) assert.equal(ctx.edit(e).ok, true, JSON.stringify(e));
  const exported = JSON.stringify(ctx.get_ws(), null, 2); // ровно то, что отдаёт «Выгрузить» на экране «Данные»
  const r = Q.open_foreign(exported, { logger: silent() });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.quarantined, false);
  assert.deepEqual(r.rejected, []);
  assert.equal(JSON.stringify(r.ws), JSON.stringify(JSON.parse(exported)), 'рабочая область равна файлу');
  // и тем же путём через экран: загруженный файл даёт ту же рабочую область
  await pick_file(exported, 'runway-state-2026-10-10.json');
  assert.equal(by_id('quarantine'), undefined);
  assert.equal(JSON.stringify(ctx.get_ws()), JSON.stringify(JSON.parse(exported)));
});
