// metrics.test.mjs — FP-10: метрики на устройстве без слежки (REQ-185, REQ-110, IDEA-54; предварительное решение № 5 владельца).
// Покрывает: схема пакета runway-metrics/1 (НЕТ сумм, НЕТ календарных дат, НЕТ идентификаторов, только агрегаты и порядковые номера) — независимый проверяющий код
// в тесте, а не `validate_package`; дни использования как смещения; ошибка минимума −917 bp (канон C-055); сбои хранилища; «Удалить все данные» (FP-05) стирает ключ метрик
// и не трогает чужие; файл показывается целиком и совпадает со скачиваемым, скачивание — только по кнопке; сетевых вызовов с метриками нет; выключатель.
// DOM подменён заглушкой; браузер и сеть не используются. Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

class FakeNode {
  constructor(tag) { this.nodeType = 1; this.tagName = tag; this.attrs = {}; this.children = []; this.listeners = {}; this.className = ''; this._text = ''; this._value = ''; }
  get textContent() { return this.children.length === 0 ? this._text : this.children.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get value() { return this._value; }
  set value(v) { this._value = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this._value = String(v); }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return Object.hasOwn(this.attrs, k); }
  append(...kids) { for (const k of kids) this.children.push(k); this._text = ''; }
  replaceChildren(...kids) { this.children = []; this._text = ''; this.append(...kids); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  click() { this.clicked = (this.clicked ?? 0) + 1; }
  remove() {}
  focus() { this.focused = true; }
  walk(fn) { fn(this); for (const c of this.children) if (c.nodeType === 1) c.walk(fn); }
}
const body = new FakeNode('body');
globalThis.document = { createElement: (t) => new FakeNode(t), createElementNS: (_n, t) => new FakeNode(t), createTextNode: (data) => ({ nodeType: 3, data }), getElementById: () => null, head: new FakeNode('head'), body };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.resolve(HERE, '..');
const DEMO = path.join(PROTO, 'demo');
const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);
const MX = await imp('demo', 'metrics.mjs');
const VIEW = await imp('demo', 'metrics_view.mjs');
const DA = await imp('demo', 'data_actions.mjs');
const I18N = await imp('demo', 'i18n.mjs');
const CATALOG = (await imp('demo', 'i18n', 'start.mjs')).default;
I18N.register_strings('start', CATALOG);

const tr = (k, p) => I18N.t('ru', k, p);
const find_all = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const by_id = (root, id) => find_all(root, (n) => n.attrs.id === id)[0];
const read = (...p) => fs.readFileSync(path.join(DEMO, ...p), 'utf8');
/** Код без комментариев и строк: в нём ищем обращения к DOM, часам и хранилищу. */
const code_only = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/.*$/gm, '$1')
  .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, '""');

/** Хранилище-заглушка: как localStorage (getItem/setItem/removeItem/key/length). */
function fake_storage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

/** Часы: номер дня устройства задаёт тест. */
function make_mx(storage, start_day = 20730) {
  const clock = { day: start_day };
  const mx = MX.create_metrics({ storage, day: () => clock.day, engine_version: '0.1.0' });
  return { mx, clock };
}

// ── независимый проверяющий схемы (не вызывает validate_package) ───────────────────────────────────────────────────────

const TOP = ['format', 'engine_version', 'sessions', 'active_days', 'steps', 'first_forecast', 'verdict_ready', 'counters', 'min_error_bp', 'coverage'];
const STEPS = ['account', 'obligations', 'income', 'daily', 'buffer'];
const OUTCOMES = ['saved', 'skipped'];
const COUNTERS = ['accounts_saved', 'anchors_set', 'rules_saved', 'facts_added', 'scenarios_saved', 'imports_done', 'undo_used', 'wizard_opened'];
const BAD_KEY = /(^|_)(amount|minor|sum|total|balance|price|date|time|timestamp|id|name|note|email|user|device|token|currency|iso)($|_)/i;
const keys_of = (x) => (x !== null && typeof x === 'object' ? Object.keys(x) : ['<не объект>']);
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** Строгая проверка пакета: только перечисленные ключи, целые числа в границах, строки из закрытых списков; никаких сумм, дат и идентификаторов. */
function strict_problems(pkg) {
  const p = [];
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) return ['not_object'];
  if (!same(Object.keys(pkg), TOP)) p.push('top_keys:' + Object.keys(pkg).join(','));
  const int = (x, lo, hi) => Number.isSafeInteger(x) && x >= lo && x <= hi;
  if (pkg.format !== 'runway-metrics/1') p.push('format');
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(String(pkg.engine_version))) p.push('engine_version');
  if (!int(pkg.sessions, 0, 1e6)) p.push('sessions');
  if (!Array.isArray(pkg.active_days) || !pkg.active_days.every((d, i, a) => int(d, 0, 3650) && (i === 0 || d > a[i - 1]))) p.push('active_days');
  if (!Array.isArray(pkg.steps) || !pkg.steps.every((s) => same(keys_of(s), ['step', 'seconds', 'session', 'outcome']) && STEPS.includes(s.step) && OUTCOMES.includes(s.outcome) && int(s.seconds, 0, 3600) && int(s.session, 1, 1e6))) p.push('steps');
  if (pkg.first_forecast !== null && !(same(keys_of(pkg.first_forecast), ['after_seconds', 'session']) && (pkg.first_forecast.after_seconds === null || int(pkg.first_forecast.after_seconds, 0, 1e9)) && int(pkg.first_forecast.session, 1, 1e6))) p.push('first_forecast');
  if (pkg.verdict_ready !== null && !(same(keys_of(pkg.verdict_ready), ['session']) && int(pkg.verdict_ready.session, 1, 1e6))) p.push('verdict_ready');
  if (!Object.entries(pkg.counters ?? {}).every(([k, v]) => COUNTERS.includes(k) && int(v, 0, 1e9))) p.push('counters');
  if (!same(keys_of(pkg.min_error_bp), ['n', 'values']) || !int(pkg.min_error_bp.n, 0, 1e6) || !pkg.min_error_bp.values.every((v) => int(v, -1e6, 1e6)) || pkg.min_error_bp.values.length > pkg.min_error_bp.n || pkg.min_error_bp.values.length > 100) p.push('min_error_bp');
  if (!same(keys_of(pkg.coverage), ['k', 'n']) || !int(pkg.coverage?.n, 0, 1e6) || !int(pkg.coverage?.k, 0, pkg.coverage?.n)) p.push('coverage');
  // обход всего дерева: ключи не называют сумму, дату, имя или идентификатор; числа целые; строки — только из закрытых списков
  const strings = new Set([pkg.format, pkg.engine_version, ...STEPS, ...OUTCOMES]);
  const walk = (x, at) => {
    if (typeof x === 'number' && !Number.isSafeInteger(x)) p.push('not_integer:' + at);
    if (typeof x === 'string' && !strings.has(x)) p.push('free_string:' + at);
    if (Array.isArray(x)) x.forEach((v, i) => walk(v, at + '[' + i + ']'));
    else if (x !== null && typeof x === 'object') for (const [k, v] of Object.entries(x)) { if (BAD_KEY.test(k)) p.push('bad_key:' + k); walk(v, at + '.' + k); }
  };
  walk(pkg, '');
  const text = JSON.stringify(pkg);
  if (/\d{4}-\d{2}-\d{2}/.test(text) || /\d{1,2}[./]\d{1,2}[./]\d{4}/.test(text) || /T\d{2}:\d{2}/.test(text)) p.push('calendar_date');
  if (/\d{10,}/.test(text)) p.push('big_number');
  return p;
}

/** Сценарий: четыре сеанса в разные дни, шаги мастера с «посторонними» полями, все счётчики, отметки, ошибка минимума, покрытие. */
function run_scenario(mx, clock) {
  mx.begin_session();
  mx.record_step({ step: 'account', seconds: 41.6, outcome: 'saved', amount_minor: 413729, note: 'мой секрет', date: '2026-10-04' });
  mx.record_step({ step: 'obligations', seconds: 95, outcome: 'saved' });
  mx.record_step({ step: 'income', seconds: 7000, outcome: 'saved' }); // больше часа: обрезается до 3600
  mx.record_step({ step: 'daily', seconds: 0, outcome: 'skipped' });
  for (const reason of ['upsert_account', 'set_anchor', 'upsert_rule', 'add_fact', 'post_income', 'save_scenario', 'import', 'undo', 'void_fact', 'неизвестная']) mx.count_reason(reason);
  mx.bump('wizard_opened');
  mx.mark_first_forecast();
  mx.mark_verdict_ready();
  clock.day += 1; mx.begin_session();
  clock.day += 6; mx.begin_session(); mx.begin_session();
  mx.record_min_error(120000, 109000);
  mx.record_min_error(50000, 52500);
  mx.record_coverage(true); mx.record_coverage(false); mx.record_coverage(true);
}

// ── REQ-185: схема ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-185 TST-55 пакет runway-metrics/1 по сценарию проходит строгую схему: нет сумм, календарных дат, идентификаторов и произвольного текста, только агрегаты и порядковые номера', () => {
  const st = fake_storage();
  const { mx, clock } = make_mx(st);
  run_scenario(mx, clock);
  const pkg = mx.package();
  assert.deepEqual(strict_problems(pkg), [], 'независимая схема');
  assert.deepEqual(MX.validate_package(pkg), [], 'схема модуля согласна');
  assert.equal(pkg.format, 'runway-metrics/1');
  assert.equal(pkg.sessions, 4);
  assert.deepEqual(pkg.active_days, [0, 1, 7], 'дни использования — смещения от первого дня: 0, 1, 7');
  assert.deepEqual(pkg.steps.map((s) => [s.step, s.seconds, s.session, s.outcome]), [['account', 42, 1, 'saved'], ['obligations', 95, 1, 'saved'], ['income', 3600, 1, 'saved'], ['daily', 0, 1, 'skipped']]);
  assert.deepEqual(pkg.first_forecast, { after_seconds: 3737, session: 1 }, 'время до первого прогноза = сумма секунд шагов на этот момент (42 + 95 + 3600)');
  assert.deepEqual(pkg.verdict_ready, { session: 1 });
  assert.deepEqual(pkg.counters, { accounts_saved: 1, anchors_set: 1, rules_saved: 1, facts_added: 2, scenarios_saved: 1, imports_done: 1, undo_used: 1, wizard_opened: 1 });
  assert.deepEqual(pkg.min_error_bp, { n: 2, values: [-917, 500] });
  assert.deepEqual(pkg.coverage, { k: 2, n: 3 });
  const text = mx.package_text();
  for (const forbidden of ['413729', 'мой секрет', '2026-10-04', 'amount', 'note']) assert.ok(!text.includes(forbidden), 'в файле нет: ' + forbidden);
  assert.deepEqual(JSON.parse(text), pkg, 'файл = пакет');
  assert.deepEqual(Object.keys(JSON.parse(text)), TOP, 'верхний уровень файла идёт в порядке схемы: формат первым');
  assert.ok(text.startsWith('{\n  "format": "runway-metrics/1",'));
  assert.equal(text, MX.package_text(pkg), 'текст файла — функция пакета');
  assert.ok(text.endsWith('}\n'));
});

test('REQ-185 в локальном хранилище лежит служебное поле anchor_day (номер первого дня), но в пакет оно не попадает; ключ метрик начинается с runway', () => {
  const st = fake_storage();
  const { mx, clock } = make_mx(st, 20730);
  mx.begin_session();
  clock.day += 3;
  mx.begin_session();
  assert.equal(MX.METRICS_KEY, 'runway-metrics/1');
  assert.ok(MX.METRICS_KEY.startsWith('runway'), 'префикс runway — его стирает «Удалить все данные»');
  const stored = JSON.parse(st.getItem(MX.METRICS_KEY));
  assert.equal(stored.anchor_day, 20730);
  assert.equal(stored.v, 1);
  const pkg = mx.package();
  assert.ok(!('anchor_day' in pkg) && !('v' in pkg) && !('enabled' in pkg));
  assert.ok(!mx.package_text().includes('20730') && !mx.package_text().includes('20733'));
  assert.deepEqual(pkg.active_days, [0, 3]);
});

test('REQ-185 validate_package отвергает: лишний ключ, сумму, дату, идентификатор, текст, дробь, отрицательные и огромные числа, чужие шаги и счётчики', () => {
  const { mx, clock } = make_mx(fake_storage());
  run_scenario(mx, clock);
  const ok = mx.package();
  const clone = () => JSON.parse(JSON.stringify(ok));
  const bad = (mut, frag) => {
    const p = clone();
    mut(p);
    const e = MX.validate_package(p);
    assert.ok(e.length > 0, frag + ': схема должна отвергнуть');
    assert.ok(e.some((x) => x.includes(frag)), frag + ' ← ' + JSON.stringify(e));
    assert.ok(strict_problems(p).length > 0, frag + ': независимая схема тоже отвергает');
  };
  bad((p) => { p.amount_minor = 5000; }, 'unknown_key');
  bad((p) => { p.user_id = 'u1'; }, 'unknown_key');
  bad((p) => { delete p.coverage; }, 'missing_key');
  bad((p) => { p.format = 'runway-metrics/2'; }, 'format');
  bad((p) => { p.engine_version = '2026-10-04'; }, 'engine_version');
  bad((p) => { p.sessions = 1.5; }, 'sessions');
  bad((p) => { p.sessions = -1; }, 'sessions');
  bad((p) => { p.active_days = [0, 20730]; }, 'active_days');
  bad((p) => { p.active_days = [3, 1]; }, 'active_days');
  bad((p) => { p.steps[0].note = 'x'; }, 'steps_item');
  bad((p) => { p.steps[0].step = 'secret'; }, 'steps_item');
  bad((p) => { p.steps[0].seconds = 1.5; }, 'steps_item');
  bad((p) => { p.steps[0].seconds = 99999; }, 'steps_item');
  bad((p) => { p.steps[0].date = '2026-10-04'; }, 'steps_item');
  bad((p) => { p.first_forecast = { after_seconds: 5, session: 1, at: '2026-10-04T10:00:00Z' }; }, 'first_forecast');
  bad((p) => { p.counters.salary = 1; }, 'counters_item');
  bad((p) => { p.counters.facts_added = -1; }, 'counters_item');
  bad((p) => { p.min_error_bp.values = [1e9]; }, 'min_error_bp');
  bad((p) => { p.min_error_bp.values = [1, 2, 3, 4]; }, 'min_error_bp'); // значений больше окон
  bad((p) => { p.coverage = { k: 5, n: 3 }; }, 'coverage');
  assert.deepEqual(MX.validate_package(ok), [], 'исходный пакет допустим');
  assert.ok(MX.validate_package(null).length > 0 && MX.validate_package([]).length > 0 && MX.validate_package('x').length > 0);
  assert.throws(() => MX.package_text({ ...ok, extra: 1 }), RangeError, 'недопустимый пакет не превращается в файл');
});

test('REQ-185 запись шага отвергает чужой шаг и исход, числа обрезаются; список шагов ограничен 200; неизвестный счётчик не растёт', () => {
  const { mx } = make_mx(fake_storage());
  mx.begin_session();
  assert.equal(mx.record_step({ step: 'secret', seconds: 1, outcome: 'saved' }), false);
  assert.equal(mx.record_step({ step: 'account', seconds: 1, outcome: 'deleted' }), false);
  assert.equal(mx.record_step({ step: 'account', seconds: Number.NaN, outcome: 'saved' }), false);
  assert.equal(mx.record_step({ step: 'account', seconds: -5, outcome: 'saved' }), true);
  assert.equal(mx.package().steps[0].seconds, 0, 'отрицательное время — ноль');
  for (let i = 0; i < 250; i++) mx.record_step({ step: 'buffer', seconds: i % 7, outcome: 'saved' });
  assert.equal(mx.package().steps.length, MX.LIMITS.steps);
  assert.equal(mx.bump('salary'), false);
  assert.equal(mx.bump('facts_added'), true);
  assert.equal(mx.count_reason('add_fact'), true);
  assert.equal(mx.count_reason('__proto__'), false);
  assert.equal(mx.count_reason(null), false);
  assert.equal(mx.package().counters.facts_added, 2);
});

test('REQ-185 отметки «первый прогноз» и «вердикт доступен» ставятся один раз; без шагов мастера секунды — null', () => {
  const { mx } = make_mx(fake_storage());
  mx.begin_session();
  assert.equal(mx.mark_first_forecast(), true);
  assert.equal(mx.mark_first_forecast(), false);
  assert.deepEqual(mx.package().first_forecast, { after_seconds: null, session: 1 });
  assert.equal(mx.mark_verdict_ready(), true);
  assert.equal(mx.mark_verdict_ready(), false);
});

test('REQ-185 ошибка минимума (C-055): прогноз 120000, факт 109000 → −917 bp; нулевой прогноз и нецелые числа — «не определить»; знак и округление', () => {
  assert.equal(MX.min_error_bp(120000, 109000), -917);
  assert.equal(MX.min_error_bp(120000, 120000), 0);
  assert.equal(MX.min_error_bp(50000, 52500), 500);
  assert.equal(MX.min_error_bp(-20000, -10000), 5000, 'отрицательный прогноз: делим на модуль');
  assert.equal(MX.min_error_bp(0, 100), null);
  assert.equal(MX.min_error_bp(100.5, 100), null);
  assert.equal(MX.min_error_bp(100, Number.NaN), null);
  assert.equal(MX.min_error_bp(1, 2 ** 40), null, 'ошибка вне ±1 000 000 bp отвергается');
  const { mx } = make_mx(fake_storage());
  assert.equal(mx.record_min_error(120000, 109000), -917);
  assert.equal(mx.record_min_error(0, 5), null);
  assert.deepEqual(mx.package().min_error_bp, { n: 1, values: [-917] });
});

test('REQ-185 удержание: два сеанса в один день — один день использования; день до первого не уходит в минус', () => {
  const { mx, clock } = make_mx(fake_storage(), 20730);
  mx.begin_session(); mx.begin_session();
  assert.deepEqual(mx.package().active_days, [0]);
  assert.equal(mx.package().sessions, 2);
  clock.day = 20720; // часы ушли назад
  mx.begin_session();
  assert.deepEqual(mx.package().active_days, [0]);
  clock.day = 20730 + 28; mx.begin_session();
  assert.deepEqual(mx.package().active_days, [0, 28]);
});

// ── хранилище ───────────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-185 хранилище недоступно или портится: нет хранилища — метрики в памяти; getItem/setItem бросают — страница живёт; испорченный и чужой JSON — начинаем заново', () => {
  const { mx } = make_mx(null);
  mx.begin_session();
  assert.equal(mx.package().sessions, 1);
  assert.deepEqual(mx.status(), { enabled: true, halted: false, persisted: false, in_memory: true });
  const thrower = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  const t = make_mx(thrower);
  assert.doesNotThrow(() => { t.mx.begin_session(); t.mx.record_step({ step: 'account', seconds: 3, outcome: 'saved' }); });
  assert.equal(t.mx.package().steps.length, 1);
  const quota = fake_storage();
  quota.setItem = () => { throw new Error('quota'); };
  const q = make_mx(quota);
  assert.doesNotThrow(() => q.mx.begin_session());
  for (const junk of ['{', 'null', '[]', '{"v":1}', '{"v":2,"enabled":true}', JSON.stringify({ v: 1, enabled: true, anchor_day: null, format: 'runway-metrics/1', sessions: 'много' })]) {
    const st = fake_storage({ [MX.METRICS_KEY]: junk });
    const m = make_mx(st).mx;
    assert.doesNotThrow(() => m.begin_session(), junk);
    assert.deepEqual(strict_problems(m.package()), [], junk);
    assert.equal(m.package().sessions, 1, 'после испорченной записи — с нуля: ' + junk);
  }
});

test('REQ-185 выключатель: выключенные метрики ничего не записывают, собранное остаётся до очистки; очистка стирает ключ и начинает с нуля', () => {
  const st = fake_storage();
  const { mx } = make_mx(st);
  mx.begin_session();
  mx.bump('facts_added');
  assert.equal(mx.enabled(), true);
  assert.equal(mx.set_enabled(false), true);
  assert.equal(mx.enabled(), false);
  assert.equal(mx.begin_session(), null);
  assert.equal(mx.bump('facts_added'), false);
  assert.equal(mx.record_step({ step: 'account', seconds: 1, outcome: 'saved' }), false);
  assert.equal(mx.package().sessions, 1, 'собранное осталось');
  assert.equal(mx.package().counters.facts_added, 1);
  mx.set_enabled(true);
  assert.equal(mx.begin_session(), 2);
  assert.equal(mx.clear(), true);
  assert.equal(st.getItem(MX.METRICS_KEY), null, 'ключ стёрт');
  assert.equal(mx.package().sessions, 0);
  assert.equal(mx.begin_session(), 1, 'после очистки — с нуля, без остановки');
});

// ── REQ-098 · REQ-185: «Удалить все данные» ─────────────────────────────────────────────────────────────────────────────

test('REQ-185 REQ-098 TST-59 «Удалить все данные» (FP-05) стирает ключ метрик вместе с данными и не трогает чужие ключи общего localhost; после стирания метрики не воскресают', async () => {
  const foreign = { 'other-app-state': '{"keep":"me"}', 'portal-v9-theme': 'dark', 'nexus.save': '1', 'metrics': 'чужие метрики без префикса runway', 'Runway-metrics/1': 'другой регистр — не наш ключ' };
  const st = fake_storage({ ...foreign, 'runway-demo-lang': 'ru', 'runway-store/1': '{}' });
  const { mx } = make_mx(st);
  mx.begin_session();
  mx.record_step({ step: 'account', seconds: 9, outcome: 'saved' });
  assert.ok(st.getItem(MX.METRICS_KEY) !== null, 'метрики записаны');
  const ports = { today: () => '2026-10-09', storage: st };
  const receipt = await DA.erase_all(ports, { counts: { operations: 0, rules: 0, scenarios: 0 } });
  assert.equal(receipt.erased, true, JSON.stringify(receipt));
  assert.equal(st.getItem(MX.METRICS_KEY), null, 'ключ метрик стёрт');
  assert.equal(st.getItem('runway-store/1'), null, 'ключи приложения стёрты');
  for (const [k, v] of Object.entries(foreign)) assert.equal(st.getItem(k), v, 'чужое цело: ' + k);
  assert.equal(st.m.size, Object.keys(foreign).length, 'остались только чужие ключи');
  // модуль замечает исчезновение ключа и до перезагрузки ничего не пишет
  assert.equal(mx.bump('facts_added'), false);
  assert.equal(mx.begin_session(), null);
  assert.equal(st.getItem(MX.METRICS_KEY), null, 'метрики не воскресли');
  assert.equal(mx.status().halted, true);
  // страница перезагружена: новый модуль начинает с нуля
  const fresh = make_mx(st).mx;
  assert.equal(fresh.begin_session(), 1);
  assert.equal(fresh.package().steps.length, 0);
});

test('REQ-185 экран показывает остановку после «Удалить все данные»', async () => {
  const st = fake_storage();
  const { mx } = make_mx(st);
  mx.begin_session();
  await DA.erase_all({ today: () => '2026-10-09', storage: st }, {});
  const root = VIEW.render_metrics(make_ctx(), { metrics: mx, metrics_ui: { confirm_clear: false } });
  assert.ok(root.textContent.includes(tr('start.mx_halted')), root.textContent.slice(0, 300));
});

// ── REQ-185: экран ──────────────────────────────────────────────────────────────────────────────────────────────────────

function make_ctx(lang = 'ru') {
  const notes = [];
  const st = { refreshed: 0 };
  return { tr: (k, p) => I18N.t(lang, k, p), lang: () => lang, notify: (m, k) => notes.push([m, k]), refresh: () => { st.refreshed += 1; }, notes, st };
}

test('REQ-185 экран «Метрики на устройстве»: файл показан ЦЕЛИКОМ и совпадает с тем, что скачивается; скачивание — только по кнопке, приложение само ничего не отправляет', () => {
  const st = fake_storage();
  const { mx, clock } = make_mx(st);
  run_scenario(mx, clock);
  const shown_blobs = [];
  const real = { Blob: globalThis.Blob, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  globalThis.Blob = class { constructor(parts, opts) { this.text = parts.join(''); this.type = opts?.type; shown_blobs.push(this); } };
  URL.createObjectURL = (b) => 'blob:test/' + shown_blobs.indexOf(b);
  URL.revokeObjectURL = () => {};
  try {
    const ctx = make_ctx();
    const ui = { confirm_clear: false };
    const root = VIEW.render_metrics(ctx, { metrics: mx, metrics_ui: ui });
    const pre = by_id(root, 'mx-file');
    assert.ok(pre !== undefined, 'блок с файлом');
    assert.equal(pre.tagName, 'pre');
    assert.equal(pre.textContent, mx.package_text(), 'на экране ровно текст файла: целиком, без сокращений');
    assert.equal(pre.attrs.tabindex, '0', 'длинный блок доступен с клавиатуры');
    assert.ok(pre.attrs['aria-label'].length > 3);
    assert.equal(shown_blobs.length, 0, 'пока кнопка не нажата, файл не создаётся');
    assert.equal(body.children.length, 0);
    const btn = by_id(root, 'mx-download');
    btn.listeners.click[0]();
    assert.equal(shown_blobs.length, 1, 'по нажатию — один файл');
    assert.equal(shown_blobs[0].text, pre.textContent, 'скачивается ровно то, что показано');
    assert.equal(shown_blobs[0].type, 'application/json');
    assert.equal(VIEW.METRICS_FILE_NAME, 'runway-metrics-1.json');
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(VIEW.METRICS_FILE_NAME), 'в имени файла нет календарной даты');
    assert.match(by_id(root, 'mx-status').textContent, /runway-metrics-1\.json/);
    // даже если метрики изменились после отрисовки, скачивается то, что было показано
    mx.bump('facts_added');
    btn.listeners.click[0]();
    assert.equal(shown_blobs[1].text, pre.textContent);
    // таблица «то же словами» и подписи
    const t = root.textContent;
    assert.ok(t.includes(tr('start.mx_row_sessions')) && t.includes(tr('start.mx_row_error')) && t.includes(tr('start.mx_coverage', { k: 2, n: 3 })));
    assert.ok(t.includes(tr('start.mx_c_facts_added') + ' = 2') && !t.includes('facts_added ='), 'счётчики в таблице названы словами, а не идентификаторами');
    assert.ok(t.includes(tr('start.mx_error', { n: 2, bp: -917 })) || t.includes(tr('start.mx_error', { n: 2, bp: 500 })));
  } finally {
    globalThis.Blob = real.Blob; URL.createObjectURL = real.create; URL.revokeObjectURL = real.revoke;
  }
});

test('REQ-185 экран: выключатель, двухшаговая очистка и доступность (подписи, живая область, заголовок с фокусом); RU и EN', () => {
  const st = fake_storage();
  const { mx } = make_mx(st);
  mx.begin_session();
  for (const lang of ['ru', 'en']) {
    const ctx = make_ctx(lang);
    const ui = { confirm_clear: false };
    const root = VIEW.render_metrics(ctx, { metrics: mx, metrics_ui: ui });
    const title = by_id(root, 'view-title');
    assert.equal(title.tagName, 'h2');
    assert.equal(title.attrs.tabindex, '-1', 'заголовок принимает фокус при переходе на экран');
    assert.equal(title.textContent, I18N.t(lang, 'start.mx_title'));
    const box = by_id(root, 'mx-enabled');
    assert.equal(box.attrs.type, 'checkbox');
    assert.ok(find_all(root, (n) => n.tagName === 'label' && n.attrs.for === 'mx-enabled').length === 1, 'у выключателя есть подпись');
    assert.ok(by_id(root, 'mx-enabled-hint') !== undefined && box.attrs['aria-describedby'] === 'mx-enabled-hint');
    for (const n of find_all(root, () => true)) {
      assert.equal(n.attrs.style, undefined, 'нет inline-стилей');
      for (const k of Object.keys(n.attrs)) assert.ok(!/^on/i.test(k), 'нет обработчиков-атрибутов');
    }
    if (lang === 'en') assert.ok(!/[А-Яа-яЁё]/.test(root.textContent), 'EN-страница без русских слов');
    // очистка — через подтверждение
    by_id(root, 'mx-clear').listeners.click[0]();
    assert.equal(ui.confirm_clear, true);
    assert.equal(ctx.st.refreshed, 1);
    ui.confirm_clear = true;
    const asking = VIEW.render_metrics(ctx, { metrics: mx, metrics_ui: ui });
    assert.ok(by_id(asking, 'mx-clear-yes') !== undefined && by_id(asking, 'mx-clear-no') !== undefined && by_id(asking, 'mx-clear') === undefined);
    by_id(asking, 'mx-clear-no').listeners.click[0]();
    assert.equal(ui.confirm_clear, false);
    assert.ok(st.getItem(MX.METRICS_KEY) !== null, '«Не очищать» ничего не стёрло');
  }
  const ctx = make_ctx();
  const ui = { confirm_clear: true };
  const asking = VIEW.render_metrics(ctx, { metrics: mx, metrics_ui: ui });
  by_id(asking, 'mx-clear-yes').listeners.click[0]();
  assert.equal(st.getItem(MX.METRICS_KEY), null, '«Да, очистить» стёрло ключ');
  assert.equal(ui.confirm_clear, false);
  assert.ok(ctx.notes.some(([m]) => m === tr('start.mx_cleared')));
  // выключатель
  const root = VIEW.render_metrics(make_ctx(), { metrics: mx, metrics_ui: { confirm_clear: false } });
  by_id(root, 'mx-enabled').listeners.change[0]({ target: { checked: false } });
  assert.equal(mx.enabled(), false);
});

// ── сеть и безопасность ─────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-185 ADR-005 TST-59 сетевых вызовов с метриками нет: ни fetch, ни XMLHttpRequest, ни sendBeacon, ни WebSocket в модулях метрик и мастера; нет внешних адресов; нет innerHTML', () => {
  for (const f of ['metrics.mjs', 'metrics_view.mjs', 'wizard.mjs', 'pack_fp10.mjs', 'start_template.mjs', 'rule_kit.mjs']) {
    const src = read(f);
    for (const bad of ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'EventSource', 'importScripts', 'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'eval(', 'new Function', 'document.write']) {
      assert.ok(!src.includes(bad), `${f}: ${bad}`);
    }
    assert.ok(!/https?:\/\//.test(src), `${f}: внешний адрес`);
    assert.ok(!/setAttribute\(\s*['"]style['"]/.test(src), `${f}: атрибут style`);
    assert.ok(!/\bconsole\s*\./.test(src.replace(/\/\/.*$/gm, '')), `${f}: console`);
  }
  const mx_src = read('metrics.mjs');
  assert.ok(!/\bdocument\b|\bwindow\b|\blocalStorage\b|\bDate\b|Math\.random/.test(code_only(mx_src)), 'metrics.mjs: хранилище и часы приходят портами, DOM не трогается');
  const imports = [...mx_src.matchAll(/import[^;]*from\s*'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports, ['../engine/index.mjs'], 'модуль метрик зависит только от движка (арифметика)');
});

test('REQ-185 TST-56 тексты метрик: в RU и EN нет запрещённых формулировок и обещаний времени; сказано, что наружу ничего не уходит и что «Удалить все данные» стирает метрики', () => {
  const VOCAB = JSON.parse(fs.readFileSync(path.join(PROTO, 'engine', 'vocab.json'), 'utf8'));
  const forbidden = VOCAB.forbidden_phrases.map((p) => p.toLowerCase().replace(/ё/g, 'е'));
  for (const lang of ['ru', 'en']) {
    for (const [k, v] of Object.entries(CATALOG[lang])) {
      const low = v.toLowerCase().replace(/ё/g, 'е');
      for (const p of forbidden) assert.ok(!low.includes(p), `${lang} ${k}: «${p}»`);
      assert.ok(!/за\s+\d+\s+минут|in\s+\d+\s+minutes/i.test(v), `${lang} ${k}: обещание времени без измерения`);
    }
  }
  assert.match(CATALOG.ru['start.mx_lead'], /Ничего не отправляется/);
  assert.match(CATALOG.en['start.mx_lead'], /Nothing is sent/);
  assert.match(CATALOG.ru['start.mx_note_erase'], /Удалить все данные/);
  assert.match(CATALOG.ru['start.mx_in_3'], /Нет: сумм, календарных дат/);
});

// ── исправление после проверки: «Очистить метрики» не отменяет отказ пользователя ──────────────────────────────────────────

test('REQ-185 выключатель переживает «Очистить метрики»: выключить → очистить → остаётся выключенным, begin_session()/bump()/record_step() ничего не пишут; собранное действительно стёрто', () => {
  const st = fake_storage();
  const { mx } = make_mx(st);
  mx.begin_session(); mx.bump('facts_added'); mx.record_step({ step: 'account', seconds: 4, outcome: 'saved' });
  assert.equal(mx.set_enabled(false), true);
  assert.equal(mx.clear(), true);
  assert.equal(mx.enabled(), false, 'отказ пользователя очистка не снимает');
  assert.equal(mx.status().enabled, false);
  // собранное стёрто, ключ остался как пустой пакет с отказом (иначе отказ пришлось бы хранить где-то ещё)
  const stored = JSON.parse(st.getItem(MX.METRICS_KEY));
  assert.equal(stored.enabled, false);
  assert.equal(stored.sessions, 0);
  assert.deepEqual([stored.steps, stored.counters, stored.active_days], [[], {}, []]);
  assert.equal(stored.first_forecast, null);
  assert.deepEqual(strict_problems(mx.package()), []);
  assert.equal(mx.package().sessions, 0);
  // выключенный модуль ничего не пишет: ни сеанс, ни счётчик, ни шаг, ни отметки
  const before = st.getItem(MX.METRICS_KEY);
  assert.equal(mx.begin_session(), null);
  assert.equal(mx.bump('facts_added'), false);
  assert.equal(mx.count_reason('upsert_rule'), false);
  assert.equal(mx.record_step({ step: 'account', seconds: 1, outcome: 'saved' }), false);
  assert.equal(mx.mark_first_forecast(), false);
  assert.equal(mx.mark_verdict_ready(), false);
  assert.equal(mx.record_coverage(true), false);
  assert.equal(st.getItem(MX.METRICS_KEY), before, 'хранилище не изменилось');
  // перезагрузка страницы: новый модуль на том же хранилище тоже выключен
  const reborn = make_mx(st).mx;
  assert.equal(reborn.enabled(), false);
  assert.equal(reborn.begin_session(), null);
  assert.equal(st.getItem(MX.METRICS_KEY), before, 'после перезагрузки счёт не возобновился');
  // пользователь сам включил — счёт идёт с нуля
  assert.equal(reborn.set_enabled(true), true);
  assert.equal(reborn.begin_session(), 1);
  assert.equal(reborn.package().sessions, 1);
});

test('REQ-185 очистка включённых метрик, как прежде, стирает ключ (счёт остаётся включённым); очистка выключенных без хранилища (память страницы) тоже не включает счёт', () => {
  const st = fake_storage();
  const { mx } = make_mx(st);
  mx.begin_session();
  assert.equal(mx.clear(), true);
  assert.equal(st.getItem(MX.METRICS_KEY), null, 'включённые: ключ стёрт');
  assert.equal(mx.enabled(), true);
  assert.equal(mx.begin_session(), 1, 'и счёт идёт с нуля');
  // нет хранилища: метрики в памяти страницы, отказ тоже живёт в памяти
  const mem = make_mx(null).mx;
  mem.begin_session();
  mem.set_enabled(false);
  assert.equal(mem.clear(), true);
  assert.equal(mem.enabled(), false);
  assert.equal(mem.begin_session(), null);
  assert.equal(mem.package().sessions, 0);
  // хранилище без removeItem: пустой пакет с отказом пишется setItem
  const old = fake_storage();
  delete old.removeItem;
  const o = make_mx(old).mx;
  o.begin_session(); o.set_enabled(false);
  assert.equal(o.clear(), true);
  assert.equal(o.enabled(), false);
  // хранилище отказало в записи при очистке отказа: очистка сообщает о неудаче, отказ не теряется
  const quota = fake_storage();
  const q = make_mx(quota).mx;
  q.begin_session(); q.set_enabled(false);
  quota.setItem = () => { throw new Error('quota'); };
  assert.equal(q.clear(), false);
  assert.equal(q.enabled(), false, 'отказ сохранён');
});

test('REQ-185 экран: выключатель снят → «Очистить метрики» → «Да, очистить» → галочка по-прежнему снята, а счёт не возобновляется от следующего действия', () => {
  const st = fake_storage();
  const { mx } = make_mx(st);
  mx.begin_session();
  const ctx = make_ctx();
  const ui = { confirm_clear: false };
  const deps = { metrics: mx, metrics_ui: ui };
  by_id(VIEW.render_metrics(ctx, deps), 'mx-enabled').listeners.change[0]({ target: { checked: false } });
  assert.equal(mx.enabled(), false);
  assert.equal(by_id(VIEW.render_metrics(ctx, deps), 'mx-enabled').attrs.checked, undefined, 'галочка снята');
  ui.confirm_clear = true;
  by_id(VIEW.render_metrics(ctx, deps), 'mx-clear-yes').listeners.click[0]();
  const after = VIEW.render_metrics(ctx, deps);
  assert.equal(by_id(after, 'mx-enabled').attrs.checked, undefined, 'после очистки галочка осталась снятой');
  assert.equal(mx.begin_session(), null, 'следующая загрузка страницы ничего не пишет');
  assert.equal(mx.bump('rules_saved'), false);
  // включённый счёт: галочка стоит до и после очистки
  mx.set_enabled(true);
  assert.notEqual(by_id(VIEW.render_metrics(ctx, deps), 'mx-enabled').attrs.checked, undefined);
  ui.confirm_clear = true;
  by_id(VIEW.render_metrics(ctx, deps), 'mx-clear-yes').listeners.click[0]();
  assert.notEqual(by_id(VIEW.render_metrics(ctx, deps), 'mx-enabled').attrs.checked, undefined);
  // экран говорит, что очистка выключатель не меняет, а «Удалить все данные» возвращает его в исходное положение
  assert.match(tr('start.mx_enabled_hint'), /Очистка выключатель не меняет/);
  assert.match(CATALOG.en['start.mx_enabled_hint'], /Clearing does not change the switch/);
  assert.match(tr('start.mx_note_erase'), /выключатель возвращается в исходное положение/);
  assert.match(CATALOG.en['start.mx_note_erase'], /switch returns to its initial position/);
});

test('REQ-185 REQ-098 решение: «Удалить все данные» (FP-05) стирает и выключатель — после стирания и перезагрузки счёт в исходном положении (включён), чужие ключи целы', async () => {
  const foreign = { 'other-app-state': '{"keep":"me"}' };
  const st = fake_storage(foreign);
  const { mx } = make_mx(st);
  mx.begin_session(); mx.set_enabled(false);
  assert.equal(JSON.parse(st.getItem(MX.METRICS_KEY)).enabled, false);
  const receipt = await DA.erase_all({ today: () => '2026-10-09', storage: st }, {});
  assert.equal(receipt.erased, true, JSON.stringify(receipt));
  assert.equal(st.getItem(MX.METRICS_KEY), null, 'ключ с отказом тоже стёрт: «все данные» — это и настройки');
  assert.equal(st.getItem('other-app-state'), foreign['other-app-state']);
  const reborn = make_mx(st).mx;
  assert.equal(reborn.enabled(), true, 'исходное положение: счёт на устройстве включён, наружу ничего не уходит');
  assert.equal(reborn.begin_session(), 1);
});
