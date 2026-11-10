// clock_matrix.test.mjs — FP-50 (RISK-22): самопроверка инструмента матрицы часов и поясов (tools/clock_matrix.mjs, tools/clock_shift_preload.mjs).
// Проверяет: без переменных предзагрузка тождественна (Date родной, пояс машины); сдвиг меняет new Date() и Date.now(), интервалы и performance.now
// идут как прежде; Date.UTC, Date.parse, instanceof и Date.prototype прежние; пояс меняется (смещение и местное время заданы точно); профили описаны полностью;
// окружение профиля не тащит чужие переменные; разбор (tools/clock_matrix_known.json) валиден. Полной матрицы тест не запускает: несколько коротких процессов node.
// Дочерние процессы получают окружение без переменных родителя (NODE_OPTIONS и RUNWAY_CLOCK_*), чтобы проверка не зависела от того, под каким профилем запущен файл.
// Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.resolve(HERE, '..');
const RUNWAY = path.resolve(PROTO, '..');
const PRELOAD = path.join(PROTO, 'tools', 'clock_shift_preload.mjs');
const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);
const M = await imp('tools', 'clock_matrix.mjs');
const P = await imp('tools', 'clock_shift_preload.mjs');

const DAY = 86400000;
const JAN_1_2026 = 1767225600000;

/** Программа дочернего процесса: моменты, пояс, сдвиг, интервал на таймере (200 мс) и признаки подмены Date. */
const CHILD = `
const d = new Date();
const out = {
  real: performance.timeOrigin + performance.now(), now: Date.now(), ctor: d.getTime(),
  native: /\\[native code\\]/.test(Function.prototype.toString.call(Date)),
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone, off: d.getTimezoneOffset(), h: d.getHours(), mi: d.getMinutes(),
  ymd: [d.getFullYear(), d.getMonth() + 1, d.getDate()],
  utc: Date.UTC(2026, 0, 1), parse: Date.parse('2026-01-01T00:00:00Z'), inst: d instanceof Date, proto: Object.getPrototypeOf(d) === Date.prototype,
};
const t0 = Date.now(), p0 = performance.now();
setTimeout(() => { out.dt = Date.now() - t0; out.dperf = performance.now() - p0; console.log(JSON.stringify(out)); }, 200);
`;

/** Окружение дочернего процесса без переменных родителя (NODE_OPTIONS, RUNWAY_CLOCK_*, TZ); `extra` — переменные теста; `preload` — подключать ли предзагрузку. */
function clean_env(extra = {}, { preload = true } = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('RUNWAY_CLOCK_') || k === 'NODE_OPTIONS' || k === 'TZ') delete env[k];
  Object.assign(env, extra);
  if (preload) env.NODE_OPTIONS = '--import=' + pathToFileURL(PRELOAD).href;
  return env;
}

/** Дочерний процесс с программой CHILD; возвращает разобранную строку JSON. */
function child(extra = {}, { preload = true } = {}) {
  const r = spawnSync(process.execPath, ['-e', CHILD], { env: clean_env(extra, { preload }), encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const ymd_text = ([y, m, d]) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

test('FP-50 без переменных RUNWAY_CLOCK_* предзагрузка тождественна: Date родной, сдвига нет, пояс тот же, что без предзагрузки', () => {
  const with_pre = child({}, { preload: true });
  const without = child({}, { preload: false });
  assert.equal(with_pre.native, true, 'Date остался родным');
  assert.ok(Math.abs(with_pre.now - with_pre.real) < 2000, 'сдвига нет');
  assert.equal(with_pre.tz, without.tz, 'пояс тот же');
  assert.equal(with_pre.off, without.off, 'смещение то же');
  assert.equal(P.clock_requested({}), false);
  assert.deepEqual(P.activate({}), { active: false, shift_ms: 0, zone: null, zone_ok: true, native_date: true });
});

test('FP-50 RUNWAY_CLOCK_SHIFT_MS +400 суток: new Date() и Date.now() на сдвиг; интервалы и performance.now идут как прежде; UTC, parse, instanceof, prototype — прежние', () => {
  const c = child({ RUNWAY_CLOCK_SHIFT_MS: String(400 * DAY) });
  assert.equal(c.native, false, 'Date подменён');
  assert.ok(Math.abs((c.now - c.real) - 400 * DAY) < 2000, `Date.now() на сдвиг (получено ${c.now - c.real} мс)`);
  assert.ok(Math.abs((c.ctor - c.real) - 400 * DAY) < 2000, `new Date() на сдвиг (получено ${c.ctor - c.real} мс)`);
  assert.ok(c.dt >= 150 && c.dt < 5000, `таймер 200 мс по Date.now() идёт (получено ${c.dt})`);
  assert.ok(c.dperf >= 150 && c.dperf < 5000, `таймер 200 мс по performance.now() идёт (получено ${c.dperf})`);
  assert.equal(c.utc, JAN_1_2026, 'Date.UTC прежний');
  assert.equal(c.parse, JAN_1_2026, 'Date.parse прежний');
  assert.equal(c.inst, true, 'instanceof Date');
  assert.equal(c.proto, true, 'prototype прежний');
});

test('FP-50 RUNWAY_CLOCK_LOCAL «2026-10-23 12:00» в поясе машины: «сейчас» начинается с 12:00 того дня, затем часы идут', () => {
  const c = child({ RUNWAY_CLOCK_LOCAL: '2026-10-23 12:00' });
  assert.deepEqual(c.ymd, [2026, 10, 23], 'дата');
  assert.equal(c.h, 12, 'час');
  assert.equal(c.mi, 0, 'минута в начале');
  assert.ok(c.dt >= 150, 'часы идут');
});

test('FP-50 пояс Pacific/Kiritimati + RUNWAY_CLOCK_LOCAL 00:30: пояс сменился (смещение −840 мин сейчас), местное время 00:30, дата — сегодняшняя местная дата пояса', () => {
  const c = child({ TZ: 'Pacific/Kiritimati', RUNWAY_CLOCK_TZ: 'Pacific/Kiritimati', RUNWAY_CLOCK_LOCAL: '00:30' });
  assert.equal(c.tz, 'Pacific/Kiritimati', 'пояс процесса');
  assert.equal(c.off, -840, 'смещение UTC+14 (getTimezoneOffset)');
  assert.equal(c.h, 0, 'час');
  assert.equal(c.mi, 30, 'минута');
  assert.equal(ymd_text(c.ymd), P.local_date_in('Pacific/Kiritimati', c.real), 'дата — местная дата пояса в реальный момент');
  assert.ok(Math.abs((c.now - c.real) - P.clock_shift_ms({ RUNWAY_CLOCK_TZ: 'Pacific/Kiritimati', RUNWAY_CLOCK_LOCAL: '00:30' }, c.real, 'Europe/Berlin')) < 2000, 'сдвиг совпадает с расчётом предзагрузки');
});

test('FP-50 пояс Pacific/Pago_Pago + RUNWAY_CLOCK_LOCAL 23:30: смещение 660 мин, местное время 23:30, дата — местная', () => {
  const c = child({ TZ: 'Pacific/Pago_Pago', RUNWAY_CLOCK_TZ: 'Pacific/Pago_Pago', RUNWAY_CLOCK_LOCAL: '23:30' });
  assert.equal(c.tz, 'Pacific/Pago_Pago');
  assert.equal(c.off, 660, 'смещение UTC−11');
  assert.equal(c.h, 23);
  assert.equal(c.mi, 30);
  assert.equal(ymd_text(c.ymd), P.local_date_in('Pacific/Pago_Pago', c.real));
});

test('FP-50 расчёт предзагрузки: местное время в поясе переводится в момент (летнее и зимнее время), ошибки ввода — отказ с текстом', () => {
  assert.equal(P.wall_to_utc_ms('Europe/Berlin', 2026, 10, 23, 12, 0), Date.UTC(2026, 9, 23, 10, 0), 'CEST: 12:00 местного = 10:00 UTC');
  assert.equal(P.wall_to_utc_ms('Europe/Berlin', 2026, 11, 9, 12, 0), Date.UTC(2026, 10, 9, 11, 0), 'CET: 12:00 местного = 11:00 UTC');
  assert.equal(P.zone_offset_ms('Pacific/Kiritimati', Date.parse('2026-11-09T00:00:00Z')), 14 * 3600000, 'Кирибати UTC+14');
  assert.equal(P.zone_offset_ms('Pacific/Pago_Pago', Date.parse('2026-11-09T00:00:00Z')), -11 * 3600000, 'Самоа UTC−11');
  assert.deepEqual(P.parse_local('2026-10-23 12:00'), { date: '2026-10-23', h: 12, mi: 0 });
  assert.deepEqual(P.parse_local('00:30'), { date: null, h: 0, mi: 30 });
  assert.throws(() => P.parse_local('2026-13-40 12:00'), RangeError);
  assert.throws(() => P.parse_local('2026-02-30 12:00'), RangeError, 'несуществующая дата');
  assert.throws(() => P.parse_local('12:60'), RangeError);
  assert.throws(() => P.parse_local('завтра'), RangeError);
  assert.throws(() => P.clock_shift_ms({ RUNWAY_CLOCK_SHIFT_MS: '5', RUNWAY_CLOCK_LOCAL: '00:30' }, 0, 'UTC'), RangeError, 'обе переменные сдвига');
  assert.throws(() => P.clock_shift_ms({ RUNWAY_CLOCK_SHIFT_MS: '1.5' }, 0, 'UTC'), RangeError, 'не целое');
  assert.throws(() => new Intl.DateTimeFormat('en-US', { timeZone: 'Mars/Olympus' }), RangeError, 'неизвестный пояс — отказ Intl');
});

test('FP-50 профили описаны полностью: пять имён по порядку, у каждого заголовок и переменные; значения совпадают с заданием', () => {
  assert.deepEqual(M.PROFILE_ORDER, ['base', 'shift_far', 'shift_past', 'midnight_east', 'midnight_west']);
  assert.deepEqual(Object.keys(M.PROFILES), M.PROFILE_ORDER);
  for (const name of M.PROFILE_ORDER) {
    assert.equal(typeof M.PROFILES[name].title, 'string', `заголовок у ${name}`);
    assert.ok(M.PROFILES[name].title.length > 20, `заголовок у ${name} содержательный`);
    assert.equal(typeof M.PROFILES[name].env, 'object', `переменные у ${name}`);
  }
  assert.deepEqual(M.PROFILES.base.env, {});
  assert.deepEqual(M.PROFILES.shift_far.env, { RUNWAY_CLOCK_SHIFT_MS: String(400 * DAY) });
  assert.deepEqual(M.PROFILES.shift_past.env, { RUNWAY_CLOCK_LOCAL: '2026-10-23 12:00' });
  assert.deepEqual(M.PROFILES.midnight_east.env, { RUNWAY_CLOCK_TZ: 'Pacific/Kiritimati', RUNWAY_CLOCK_LOCAL: '00:30' });
  assert.deepEqual(M.PROFILES.midnight_west.env, { RUNWAY_CLOCK_TZ: 'Pacific/Pago_Pago', RUNWAY_CLOCK_LOCAL: '23:30' });
  assert.throws(() => M.profile_env('нет-такого'), RangeError);
});

test('FP-50 окружение профиля: чужие переменные убраны, предзагрузка подключена с прежними NODE_OPTIONS, TZ только у поясов', () => {
  const west = M.spawn_env('midnight_west', { RUNWAY_CLOCK_SHIFT_MS: '5', NODE_OPTIONS: '--max-old-space-size=300' });
  assert.equal(west.RUNWAY_CLOCK_SHIFT_MS, undefined, 'чужой сдвиг убран');
  assert.equal(west.RUNWAY_CLOCK_TZ, 'Pacific/Pago_Pago');
  assert.equal(west.TZ, 'Pacific/Pago_Pago');
  assert.ok(west.NODE_OPTIONS.includes('--max-old-space-size=300'), 'прежние опции сохранены');
  assert.ok(west.NODE_OPTIONS.includes('--import=file:///') && west.NODE_OPTIONS.includes('clock_shift_preload.mjs'), 'предзагрузка подключена');
  const base = M.spawn_env('base', {});
  assert.equal(base.TZ, undefined, 'у base пояс не задан');
  assert.equal(Object.keys(base).filter((k) => k.startsWith('RUNWAY_CLOCK_')).length, 0);
  assert.equal(M.spawn_env('shift_far', {}).RUNWAY_CLOCK_SHIFT_MS, String(400 * DAY));
});

test('FP-50 проверка профиля base в этом процессе: предзагрузка подключена, Date родной, сдвиг нулевой (без полной матрицы)', () => {
  const p = M.probe_profile('base');
  assert.equal(p.fatal, false, p.why ?? '');
  assert.equal(p.ok, true, p.why ?? '');
  assert.equal(p.native, true);
  assert.ok(Math.abs(p.shift_ms) < 2000);
});

test('FP-50 проверка профилей со сдвигом: смещение пояса берётся в момент, который показывает процесс (shift_past — летнее время 23 октября, восточный и западный пояс)', () => {
  for (const name of ['shift_past', 'midnight_east', 'midnight_west']) {
    const p = M.probe_profile(name);
    assert.equal(p.fatal, false, `${name}: ${p.why ?? ''}`);
    assert.equal(p.zone_skip, false, `${name}: ${p.why ?? ''}`);
    assert.equal(p.ok, true, `${name}: ${p.why ?? ''}`);
  }
  const past = M.probe_profile('shift_past');
  const at = P.wall_to_utc_ms(past.system_zone, 2026, 10, 23, 12, 0); // 12:00 23 октября в поясе машины — момент, который должен показать процесс
  assert.equal(past.off_min, -P.zone_offset_ms(past.system_zone, at) / 60000, 'смещение пояса в этот момент (для Берлина — летнее время, −120)');
});

test('FP-50 lint_vocab: «сегодня» по умолчанию — местная дата машины, а не UTC-дата: измерение старше 90 дней по местной дате отмечено, по UTC-дате — нет', () => {
  // Пояс Pacific/Kiritimati (UTC+14), местное 2026-11-10 00:30 — UTC-дата 2026-11-09. Измерение 2026-08-11 — 91 день по местной дате (старое), 90 по UTC (не старое);
  // 2026-08-12 — 90 дней по местной дате (не старое). Каталог проверки пустой (`--dir`), прогон быстрый; только правило сроков.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-lint-today-'));
  try {
    const registry = path.join(dir, 'registry.json');
    const empty = path.join(dir, 'empty');
    fs.mkdirSync(empty);
    fs.writeFileSync(registry, JSON.stringify([
      { id: 'stale_local', text: 'тест старого измерения', level: 'measured', measured_on: '2026-08-11' },
      { id: 'fresh_local', text: 'тест свежего измерения', level: 'measured', measured_on: '2026-08-12' },
    ]));
    const env = clean_env({ TZ: 'Pacific/Kiritimati', RUNWAY_CLOCK_TZ: 'Pacific/Kiritimati', RUNWAY_CLOCK_LOCAL: '2026-11-10 00:30' });
    const r = spawnSync(process.execPath, [path.join(RUNWAY, 'tools', 'lint_vocab.mjs'), '--json', '--registry', registry, '--dir', empty], { cwd: PROTO, env, encoding: 'utf8', timeout: 120000 });
    const out = JSON.parse(r.stdout);
    const stale = out.errors.filter((e) => e.rule === 'promise-stale');
    assert.equal(stale.length, 1, 'ровно одно старое измерение: ' + JSON.stringify(stale));
    assert.match(stale[0].msg, /2026-08-11/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FP-50 разбор (tools/clock_matrix_known.json) валиден: каждая запись — существующий файл, известные профили и обоснование от 40 знаков; без файла разбор пуст', () => {
  const known = M.load_known();
  assert.deepEqual(M.check_known(known), []);
  assert.equal(M.known_for({ entries: [{ file: 'tests/x.test.mjs', profiles: ['shift_far'], reason: 'x'.repeat(40) }], verdicts: {} }, 'tests/x.test.mjs', 'base'), null, 'запись не применяется к другому профилю');
  assert.ok(M.known_for({ entries: [{ file: 'tests/x.test.mjs', profiles: '*', reason: 'x'.repeat(40) }], verdicts: {} }, 'tests/x.test.mjs', 'base') !== null, 'звёздочка — все профили');
  assert.ok(M.check_known({ entries: [{ file: 'tests/clock_matrix.test.mjs', profiles: ['base'], reason: 'коротко' }], verdicts: {} }).length > 0, 'короткое обоснование отвергается');
});

test('FP-50 предзагрузка без TZ в окружении: пояс из RUNWAY_CLOCK_TZ ставится в process.env.TZ (запасной путь), смещение и местное время заданы точно', () => {
  const c = child({ RUNWAY_CLOCK_TZ: 'Pacific/Pago_Pago', RUNWAY_CLOCK_LOCAL: '23:30' }); // clean_env убирает TZ из окружения: работает только запасной путь
  assert.equal(c.tz, 'Pacific/Pago_Pago', 'пояс процесса из RUNWAY_CLOCK_TZ');
  assert.equal(c.off, 660, 'смещение UTC−11 (getTimezoneOffset)');
  assert.equal(c.h, 23, 'час');
  assert.equal(c.mi, 30, 'минута');
});

// Раньше ручной комментарий в allowlist подменял вычисленный вердикт (разбор матрицы, FP-50): теперь вердикт вычисляется, комментарий — отдельным полем `note`.
test('FP-50 свод: вердикт вычисляется по данным, ручной комментарий выводится отдельно; неразобранный красный сверх base — «НЕ РАЗОБРАНО» даже при ручном тексте', () => {
  const ok = (file) => ({ file, status: 0, tests: 2, pass: 2, fail: 0, skipped: 0, todo: 0, cancelled: 0, ms: 1 });
  const bad = (file) => ({ file, status: 1, tests: 2, pass: 1, fail: 1, skipped: 0, todo: 0, cancelled: 0, ms: 1 });
  const results = {
    base: { rows: [ok('tests/a.test.mjs')], finished: true, files_total: 1 },
    shift_far: { rows: [ok('tests/a.test.mjs'), bad('tests/c.test.mjs')], finished: true, files_total: 2 },
  };
  const manual = 'Датозависимых сбоев нет (ручной текст).';
  const s = M.build_summary({ results, known: { entries: [], verdicts: { shift_far: manual } }, now_iso: '2026-11-09T12:00:00.000Z', node: 'v24', machine_zone: 'Europe/Berlin' });
  assert.deepEqual(s.profiles.shift_far.unexplained, ['tests/c.test.mjs']);
  assert.match(s.profiles.shift_far.verdict, /^НЕ РАЗОБРАНО: 1/, 'вердикт — вычисленный, а не ручной текст');
  assert.equal(s.profiles.shift_far.note, manual, 'ручной комментарий — отдельным полем');
  assert.equal(M.summary_ok(s), false, 'неразобранный красный — свод не зелёный');
  const reason = 'Датозависимость закономерна: требование само сравнивает дату с сегодняшней, поэтому красный объяснён записью разбора в тесте свода.';
  const s2 = M.build_summary({ results, known: { entries: [{ file: 'tests/c.test.mjs', profiles: ['shift_far'], reason }], verdicts: {} }, now_iso: '2026-11-09T12:00:00.000Z' });
  assert.deepEqual(s2.profiles.shift_far.unexplained, [], 'записью разбора объяснён');
  assert.equal(s2.profiles.shift_far.verdict, 'все красные сверх base объяснены записями разбора');
  assert.equal(M.summary_ok(s2), true, 'база без красных и всё объяснено — свод зелёный');
});

// Раньше повтор перезаписывал сведения о первом прогоне и не хранил историю (разбор матрицы, FP-50): теперь каждый прогон — в `attempts`, первый — в `retried`.
test('FP-50 матрица: повтор записывает историю прогонов (attempts); первый прогон сохраняется в retried, строки вне выборки не теряются', () => {
  const probe = { ok: true, fatal: false, zone_skip: false, zone: 'UTC', system_zone: 'UTC' };
  const row = (file, red) => ({ file, status: red ? 1 : 0, tests: 1, pass: red ? 0 : 1, fail: red ? 1 : 0, skipped: 0, todo: 0, cancelled: 0, ms: 5, timed_out: false });
  const calls = new Map();
  const runner = (root, file) => { const n = (calls.get(file) ?? 0) + 1; calls.set(file, n); return row(file, file === 'tests/a.test.mjs' && n === 1); };
  const first = M.run_profile({ name: 'base', files: ['tests/a.test.mjs', 'tests/b.test.mjs'], runner, write: false, probe, log: () => {} });
  assert.equal(first.rows.find((r) => r.file === 'tests/a.test.mjs').status, 1, 'первый прогон: a красный');
  const second = M.run_profile({ name: 'base', files: ['tests/a.test.mjs'], runner, write: false, probe, resume: true, force: true, prev_state: first, log: () => {} });
  const a2 = second.rows.find((r) => r.file === 'tests/a.test.mjs');
  assert.equal(a2.status, 0, 'повтор зелёный');
  assert.equal(a2.retried.red, true, 'первый прогон (красный) сохранён в retried');
  assert.equal(a2.attempts.length, 2, 'два прогона в истории');
  assert.ok(second.rows.some((r) => r.file === 'tests/b.test.mjs'), 'строка вне выборки сохранена');
  const third = M.run_profile({ name: 'base', files: ['tests/a.test.mjs'], runner, write: false, probe, resume: true, force: true, prev_state: second, log: () => {} });
  const a3 = third.rows.find((r) => r.file === 'tests/a.test.mjs');
  assert.equal(a3.attempts.length, 3, 'третий прогон добавлен в историю');
  assert.equal(a3.retried.red, true, 'первый прогон не перезаписан вторым');
  const s = M.build_summary({ results: { base: third }, known: { entries: [], verdicts: {} } });
  assert.deepEqual(s.profiles.base.retried_ok.map((x) => x.file), ['tests/a.test.mjs'], 'свод: первый прогон красный, последний зелёный — повтор зелёный');
});

test('FP-50 CLI матрицы: флаг без значения — код выхода 2 и строка с объяснением, а не необработанная ошибка', () => {
  const r = spawnSync(process.execPath, [path.join(PROTO, 'tools', 'clock_matrix.mjs'), '--list', '--files'], { env: clean_env(), encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 2, 'код выхода 2 (неверный запуск)');
  assert.match(r.stderr, /--files: нужно значение/, 'объяснение в строке');
  assert.doesNotMatch(r.stderr, /TypeError/, 'не необработанная ошибка');
});
