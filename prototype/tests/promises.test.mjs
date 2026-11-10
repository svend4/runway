// promises.test.mjs — FP-09: страница «обещаем / не обещаем» и реестр обещаний (REQ-184, REQ-178; IDEA-53, IDEA-92; TST-56).
// Проверяется: у каждой строки promises.json есть уровень доказанности и ссылка на тест (файл существует, идентификатор есть в названии теста);
// зеркало REGISTRY в коде равно файлу; линтер `tools/lint_vocab.mjs --registry` принимает файл и отвергает `hypothesis` в интерфейсе и просроченное измерение;
// страница не показывает `hypothesis`; тексты строк есть в RU и EN и не содержат запрещённых формулировок. Браузер и сеть не используются.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const DEMO = path.join(PROTO, 'demo');
const TOOLS = path.join(PROTO, '..', 'tools');

// заглушка DOM: страница строится функциями h(...), им нужны document.createElement и createTextNode
class Node_ {
  constructor(tag, ns) {
    this.nodeType = 1; this.tagName = tag; this.ns = ns ?? null; this.attrs = {}; this.children = []; this.listeners = {}; this.className = ''; this._text = '';
  }
  get textContent() { return this.children.length === 0 ? this._text : this.children.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  append(...kids) { for (const k of kids) this.children.push(k); this._text = ''; }
  replaceChildren(...kids) { this.children = []; this._text = ''; this.append(...kids); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  walk(fn) { fn(this); for (const c of this.children) if (c.nodeType === 1) c.walk(fn); }
}
globalThis.document = {
  createElement: (t) => new Node_(t), createElementNS: (ns, t) => new Node_(t, ns), createTextNode: (data) => ({ nodeType: 3, data }),
  getElementById: () => null, head: new Node_('head'), body: new Node_('body'),
};

const PR = await import(pathToFileURL(path.join(DEMO, 'promises.mjs')).href);
const E = await import('../engine/index.mjs');
const I18N = await import(pathToFileURL(path.join(DEMO, 'i18n.mjs')).href);
const LINT = await import(pathToFileURL(path.join(TOOLS, 'lint_vocab.mjs')).href);
const CATALOG = (await import(pathToFileURL(path.join(DEMO, 'i18n', 'showcase.mjs')).href)).default;
if (I18N.ext_strings().length === 0 || I18N.t('ru', 'showcase.pr_title') === 'showcase.pr_title') I18N.register_strings('showcase', CATALOG);

const FILE = JSON.parse(fs.readFileSync(path.join(DEMO, 'promises.json'), 'utf8'));
const G = JSON.parse(fs.readFileSync(path.join(PROTO, 'data', 'g001.json'), 'utf8'));
const VOCAB = JSON.parse(fs.readFileSync(path.join(PROTO, 'engine', 'vocab.json'), 'utf8'));
const day = (iso) => E.to_epoch_day(iso);
const norm = (s) => s.replace(/[   ]/g, ' ');
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };

function mk_ctx(ws, lang = 'ru') {
  const model = ws === null ? null : { ws, ctx: null, cur: 'EUR', as_of_iso: ws.as_of };
  return {
    get_ws: () => ws, get_model: () => model, tr: (k, p) => I18N.t(lang, k, p), lang: () => lang, mode: () => 'worse',
    fmt: () => ({ date: (x) => (typeof x === 'string' ? x : E.format_date(x)), money: (v) => String(v) }), notify: () => {},
  };
}

// ── REQ-184 · REQ-178: форма реестра ────────────────────────────────────────────────────────────────────────────────

test('REQ-184 REQ-178 реестр: каждая строка promises.json имеет level и test (файл и идентификатор), дату проверки, ключ текста; идентификаторы не повторяются', () => {
  assert.ok(Array.isArray(FILE) && FILE.length >= 10, 'в реестре не меньше десяти утверждений');
  const ids = new Set();
  for (const r of FILE) {
    assert.ok(PR.CLAIM_LEVELS.includes(r.level), r.id + ': level');
    assert.ok(typeof r.test?.file === 'string' && r.test.file !== '' && typeof r.test.id === 'string' && r.test.id !== '', r.id + ': test');
    assert.ok(PR.CLAIM_KINDS.includes(r.kind), r.id + ': kind');
    assert.equal(r.text_key, 'showcase.cl_' + r.id, r.id + ': ключ текста');
    assert.match(r.checked_on, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(!ids.has(r.id), 'дубль ' + r.id);
    ids.add(r.id);
    if (r.level === 'measured') {
      assert.match(r.measured_on, /^\d{4}-\d{2}-\d{2}$/, r.id + ': дата измерения');
      assert.ok(Number.isSafeInteger(r.n) && r.n >= 1, r.id + ': n');
    }
  }
  assert.deepEqual(PR.validate_registry(FILE), []);
  assert.ok(FILE.some((r) => r.kind === 'promise') && FILE.some((r) => r.kind === 'non_promise'), 'есть и «обещаем», и «не обещаем»');
});

test('REQ-184 реестр: ссылка на тест настоящая — файл существует, а идентификатор TST-NN / REQ-NNN стоит в названии одного из его тестов', () => {
  for (const r of FILE) {
    const file = path.join(PROTO, r.test.file);
    assert.ok(fs.existsSync(file), r.id + ': нет файла ' + r.test.file);
    const titles = fs.readFileSync(file, 'utf8').split('\n').filter((l) => /^\s*test(?:\.\w+)?\(/.test(l));
    assert.ok(titles.some((l) => l.includes(r.test.id)), r.id + ': в ' + r.test.file + ' нет теста с ' + r.test.id);
  }
});

test('REQ-184 зеркало: REGISTRY в promises.mjs равно promises.json (порядок строк — порядок на странице); страница не читает JSON сама', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(PR.REGISTRY)), FILE);
  const src = fs.readFileSync(path.join(DEMO, 'promises.mjs'), 'utf8');
  assert.ok(!/fetch\(|import\(|readFile/.test(src));
});

test('REQ-184 validate_registry: находит строку без уровня, без теста, дубль, чужой ключ текста, measured без даты и без n, неверную дату проверки', () => {
  const ok = FILE[0];
  const some = (rows, frag) => assert.ok(PR.validate_registry(rows).some((e) => e.includes(frag)), frag + ' ← ' + JSON.stringify(PR.validate_registry(rows)));
  some([{ ...ok, level: undefined }], 'no_level');
  some([{ ...ok, level: 'proven' }], 'no_level');
  some([{ ...ok, test: undefined }], 'no_test');
  some([{ ...ok, test: { file: 'a.mjs', id: '' } }], 'no_test');
  some([{ ...ok, test: { file: '', id: 'TST-1' } }], 'no_test');
  some([ok, ok], 'duplicate_id');
  some([{ ...ok, text_key: 'showcase.cl_other' }], 'bad_text_key');
  some([{ ...ok, level: 'measured' }], 'measured_without_date');
  some([{ ...ok, level: 'measured', measured_on: '2026-10-05' }], 'measured_without_n');
  some([{ ...ok, level: 'measured', measured_on: '2026-13-40', n: 3 }], 'measured_without_date');
  some([{ ...ok, checked_on: 'сегодня' }], 'no_checked_on');
  some([{ ...ok, kind: 'maybe' }], 'bad_kind');
  some([{ ...ok, surface: 'web' }], 'bad_surface');
  some([{ ...ok, id: 'Плохой Id' }], 'bad_id');
  some([null], 'not_object');
  assert.deepEqual(PR.validate_registry('нет'), ['registry_not_array']);
});

// ── линтер реестра ──────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-184 REQ-178 lint_vocab --registry: файл promises.json принят (0 ошибок реестра); hypothesis в интерфейсе, измерение старше 90 дней и «первый прогноз за N минут» без измерения — ошибки', () => {
  const clean = LINT.lint_promises(FILE, '2026-10-05', 'promises.json');
  assert.deepEqual(clean.filter((f) => f.level === 'error'), []);
  const base = FILE[0];
  const rule = (rows, today = '2026-10-05') => LINT.lint_promises(rows, today).filter((f) => f.level === 'error').map((f) => f.rule);
  assert.deepEqual(rule([{ ...base, level: 'hypothesis', surface: 'ui' }]), ['promise-hypothesis-in-ui']);
  assert.deepEqual(rule([{ ...base, level: 'hypothesis', surface: 'doc' }]), [], 'гипотеза в документе — не ошибка, только не в интерфейсе');
  assert.deepEqual(rule([{ ...base, level: 'measured', measured_on: '2026-04-01', n: 3 }]), ['promise-stale']);
  assert.deepEqual(rule([{ ...base, level: 'measured', n: 3 }]), ['promise-no-date']);
  assert.deepEqual(rule([{ ...base, text: 'Первый прогноз за 5 минут', level: 'verified' }]), ['first-forecast']);
  assert.deepEqual(rule([{ ...base, text: 'Первый прогноз за 5 минут', level: 'measured', measured_on: '2026-10-05', n: 3 }]), []);
});

test('REQ-184 REQ-178 командная строка: `node tools/lint_vocab.mjs --registry <файл>` — файл FP-09 не даёт ошибок реестра; файл с hypothesis в интерфейсе — код выхода 1 и правило promise-hypothesis-in-ui', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-reg-'));
  try {
    const run = (file) => spawnSync(process.execPath, [path.join(TOOLS, 'lint_vocab.mjs'), '--registry', file, '--today', '2026-10-05'], { encoding: 'utf8', timeout: 100000 });
    const good = run(path.join(DEMO, 'promises.json'));
    assert.ok(!/\[promise-/.test(good.stdout), 'ошибок реестра нет: ' + good.stdout.split('\n').filter((l) => /\[promise-/.test(l)).join('\n'));
    const bad_file = path.join(dir, 'bad.json');
    fs.writeFileSync(bad_file, JSON.stringify([...FILE, { id: 'speed', kind: 'promise', text_key: 'showcase.cl_speed', level: 'hypothesis', surface: 'ui', checked_on: '2026-10-05', test: { file: 'tests/x.test.mjs', id: 'TST-99' } }]));
    const bad = run(bad_file);
    assert.equal(bad.status, 1, bad.stdout.slice(-400));
    assert.match(bad.stdout, /\[promise-hypothesis-in-ui\]/);
    const stale_file = path.join(dir, 'stale.json');
    fs.writeFileSync(stale_file, JSON.stringify(FILE.map((r) => (r.level === 'measured' ? { ...r, measured_on: '2026-01-01' } : r))));
    const stale = run(stale_file);
    assert.equal(stale.status, 1);
    assert.match(stale.stdout, /\[promise-stale\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── страница ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-178 страница не показывает hypothesis: такая строка отбрасывается при отборе, не попадает в списки и в разметку; строки surface = doc не показываются', () => {
  const base = { ...FILE[0], id: 'speed', text_key: 'showcase.cl_speed' };
  const rows = [...PR.REGISTRY, { ...base, level: 'hypothesis' }, { ...base, id: 'doc_only', text_key: 'showcase.cl_doc_only', level: 'verified', surface: 'doc' }];
  const vis = PR.visible_rows(rows);
  assert.equal(vis.length, PR.REGISTRY.length);
  assert.ok(vis.every((r) => r.level !== 'hypothesis' && r.surface === 'ui'));
  const m = PR.promises_model(day('2026-10-05'), rows);
  assert.equal(m.hidden, 2);
  assert.equal(m.promise.length + m.non_promise.length, PR.REGISTRY.length);
  assert.ok(![...m.promise, ...m.non_promise].some((r) => r.id === 'speed'));
  // страница на живом реестре: ни одной строки hypothesis
  assert.ok(PR.REGISTRY.every((r) => r.level !== 'hypothesis'));
  assert.equal(PR.promises_model(day('2026-10-05')).hidden, 0);
});

test('REQ-178 REQ-184 срок годности измерения: 90 дней включительно; claim_status и линтер согласованы (0, 89, 90, 91, 200 дней)', () => {
  const row = FILE.find((r) => r.level === 'measured');
  assert.equal(PR.MEASURE_TTL_DAYS, 90);
  const from = day(row.measured_on);
  for (const age of [0, 89, 90, 91, 200]) {
    const today = E.format_date(from + age);
    const st = PR.claim_status(row, from + age);
    const lint_stale = LINT.lint_promises([row], today).some((f) => f.rule === 'promise-stale');
    assert.equal(st.state === 'stale', age > 90, 'возраст ' + age);
    assert.equal(lint_stale, st.state === 'stale', 'линтер и страница согласны: ' + age);
    assert.equal(st.age_days, age);
  }
  assert.deepEqual(PR.claim_status(FILE.find((r) => r.level === 'verified'), from + 500), { state: 'ok', age_days: null });
});

test('REQ-184 страница (экран): два раздела — «обещаем» и «не обещаем»; у строки уровень, тест и дата; измерение — с n и датой; RU и EN; доступность', () => {
  for (const lang of ['ru', 'en']) {
    const ctx = mk_ctx(G, lang);
    const root = PR.render_promises(ctx);
    const t = norm(root.textContent);
    const sections = find_all(root, (n) => n.tagName === 'section');
    assert.equal(sections.length, 2);
    const counts = sections.map((s) => find_all(s, (n) => n.tagName === 'tbody')[0].children.length);
    assert.deepEqual(counts, [FILE.filter((r) => r.kind === 'promise').length, FILE.filter((r) => r.kind === 'non_promise').length]);
    for (const r of FILE) {
      assert.ok(t.includes(CATALOG[lang]['showcase.cl_' + r.id]), lang + ' ' + r.id + ': текст утверждения');
      assert.ok(t.includes(r.test.file + ' · ' + r.test.id), lang + ' ' + r.id + ': ссылка на тест');
    }
    assert.ok(t.includes(I18N.t(lang, 'showcase.pr_level_measured', { n: 3, date: '2026-10-05' })), lang + ' измерение с n и датой');
    assert.ok(t.includes(I18N.t(lang, 'showcase.pr_level_verified')));
    assert.ok(t.includes(I18N.t(lang, 'showcase.tax_note')));
    assert.ok(!t.includes(lang === 'ru' ? 'старше срока' : 'past its term'), 'свежее измерение не помечено устаревшим');
    assert.equal(find_all(root, (n) => n.attrs.role === 'alert').length, 0, 'нарушений реестра нет');
    for (const n of find_all(root, (x) => x.tagName === 'table')) assert.ok(n.children.some((c) => c.tagName === 'caption' && c.textContent.trim() !== ''), 'таблица подписана');
    find_all(root, () => true).forEach((n) => assert.ok(n.attrs.style === undefined && !Object.keys(n.attrs).some((k) => /^on/i.test(k))));
  }
});

test('REQ-178 страница (экран): измерение старше 90 дней от даты расчёта помечается устаревшим; без данных страница всё равно открывается', () => {
  const late = { ...G, as_of: '2027-02-01' }; // 119 дней после измерения 2026-10-05
  const t = norm(PR.render_promises(mk_ctx(late, 'ru')).textContent);
  assert.ok(t.includes(I18N.t('ru', 'showcase.pr_stale', { days: 119 })), t.slice(0, 200));
  const fresh = norm(PR.render_promises(mk_ctx(G, 'ru')).textContent);
  assert.ok(!fresh.includes('старше срока'));
  const none = PR.render_promises(mk_ctx(null, 'ru'));
  assert.equal(find_all(none, (n) => n.tagName === 'section').length, 2);
});

// ── TST-56: тексты обещаний ─────────────────────────────────────────────────────────────────────────────────────────

test('TST-56 REQ-184 тексты утверждений есть в RU и EN для каждой строки реестра, не пустые и без запрещённых формулировок §10; «не обещаем» говорит о границах, а не о превосходстве', () => {
  const forbidden = VOCAB.forbidden_phrases.map((p) => p.toLowerCase().replace(/ё/g, 'е'));
  for (const lang of ['ru', 'en']) {
    for (const r of FILE) {
      const text = CATALOG[lang]['showcase.cl_' + r.id];
      assert.ok(typeof text === 'string' && text.trim().length > 10, lang + ' ' + r.id);
      const low = text.toLowerCase().replace(/ё/g, 'е');
      for (const p of forbidden) assert.ok(!low.includes(p), lang + ' ' + r.id + ': «' + p + '»');
      assert.ok(!/(?:первые|единственн|нет ни у кого|the only|first to|nobody else|no one else)/i.test(text), lang + ' ' + r.id + ': сравнение с другими без источника');
      assert.ok(!/первый\s+прогноз\s+за\s+\d+\s+минут/i.test(text), 'без числа минут: измерения нет');
    }
  }
  // все ключи страницы и строки утверждений — в каталоге; лишних утверждений в каталоге нет
  const claim_keys = Object.keys(CATALOG.ru).filter((k) => k.startsWith('showcase.cl_')).sort();
  assert.deepEqual(claim_keys, FILE.map((r) => 'showcase.cl_' + r.id).sort());
});

test('REQ-184 утверждения реестра не нарушают границ продукта: расчёт по введённым правилам — не консультация; обещание точности отсутствует, «не обещаем точность» и «не даём советов» есть', () => {
  const ru = CATALOG.ru;
  assert.match(ru['showcase.cl_accuracy'], /^Не обещаем точность/);
  assert.ok(FILE.some((r) => r.id === 'advice' && r.kind === 'non_promise'));
  assert.ok(FILE.some((r) => r.id === 'accuracy' && r.kind === 'non_promise'));
  assert.ok(FILE.some((r) => r.id === 'golden' && r.kind === 'promise' && r.level === 'verified'));
  assert.ok(CATALOG.ru['showcase.tax_note'].includes('не консультация'));
});
