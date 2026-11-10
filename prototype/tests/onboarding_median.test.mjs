// onboarding_median.test.mjs — FP-27: медиана времени до первого прогноза и быстрого ввода → запись «measured» в реестр обещаний (REQ-090, REQ-110, REQ-178, REQ-185).
// Проверяется: медиана и пороги (n меньше 5 — отказ без медианы, ниже порога не опустить), чтение файлов `runway-metrics/1` (настоящими `create_metrics`) и листов наблюдателя
// `runway-timing/1`, отсев копий и неверных файлов, запись только с уровнем `measured`, форма и линтер реестра после записи, стиль файла (круг «разобрать — вывести» на настоящем
// `promises.json` побайтно), командная строка (в памяти и отдельным процессом на копии реестра), готовые строки для ручного шага проходят линтер слов. Настоящий реестр тесты НЕ меняют.
// Названия тестов несут REQ-090 и REQ-110: на них ссылаются записи реестра, которые инструмент создаёт после измерения (tests/promises.test.mjs проверяет ссылку).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const RUNWAY = path.join(PROTO, '..');
const imp = (...p) => import(pathToFileURL(path.join(...p)).href);

const OM = await imp(PROTO, 'tools', 'onboarding_median.mjs');
const MX = await imp(PROTO, 'demo', 'metrics.mjs');
const PR = await imp(PROTO, 'demo', 'promises.mjs');
const LINT = await imp(RUNWAY, 'tools', 'lint_vocab.mjs');
const E = await imp(PROTO, 'engine', 'index.mjs');

const REAL_REGISTRY = path.join(PROTO, 'demo', 'promises.json');
const REAL_TEXT = fs.readFileSync(REAL_REGISTRY, 'utf8');
const REAL_ROWS = JSON.parse(REAL_TEXT);
const VOCAB = LINT.load_vocab();
const sha = (t) => createHash('sha256').update(t).digest('hex');

/** Настоящий файл метрик: через `create_metrics`, шаги мастера и отметка «первый прогноз». */
function metrics_file({ steps = [['account', 120], ['obligations', 180]], forecast = true } = {}) {
  const m = MX.create_metrics({ storage: null, day: () => 20000, engine_version: '0.1.0' });
  m.begin_session();
  for (const [step, seconds] of steps) m.record_step({ step, seconds, outcome: 'saved' });
  if (forecast) m.mark_first_forecast();
  return m.package_text();
}
/** Файл человека, у которого суммарное активное время равно `total` секундам. */
const person = (total) => metrics_file({ steps: [['account', Math.floor(total / 2)], ['obligations', total - Math.floor(total / 2)]] });
const files_of = (totals) => totals.map((t, i) => ({ name: `P${i + 1}.json`, text: person(t) }));

/** Входы и выходы в памяти: файлы по ключу-пути, записи и строки вывода. */
function fake_io(files) {
  const writes = [];
  const out = [];
  const err = [];
  return {
    read: (p) => { if (!Object.hasOwn(files, p)) throw Object.assign(new Error('нет файла'), { code: 'ENOENT' }); return files[p]; },
    write: (p, t) => { writes.push([p, t]); files[p] = t; },
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    today: () => '2026-12-31', // часы настоящего запуска (default_io): сверка даты замера; без них и без --today запись не выполняется
    writes, outs: out, errs: err,
  };
}
const REG = path.resolve('registry-test.json');

// ── медиана и порог ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-110 REQ-090 медиана: нечётное и чётное число значений, половина миллисекунды вверх, порядок входа не важен; пустое и нецелое отвергаются', () => {
  assert.equal(OM.median_ms([5000]), 5000);
  assert.equal(OM.median_ms([3000, 1000, 2000]), 2000);
  assert.equal(OM.median_ms([4000, 1000, 2000, 3000]), 2500);
  assert.equal(OM.median_ms([1, 2]), 2, 'полусумма 1,5 мс округляется вверх');
  assert.equal(OM.median_ms([1000, 3000]), 2000);
  assert.deepEqual([OM.median_ms([9, 1, 5, 3, 7]), OM.median_ms([1, 3, 5, 7, 9])], [5, 5]);
  assert.throws(() => OM.median_ms([]), RangeError);
  assert.throws(() => OM.median_ms([1.5]), RangeError);
  assert.throws(() => OM.median_ms([-1]), RangeError);
  assert.throws(() => OM.median_ms('нет'), RangeError);
});

test('REQ-110 REQ-090 порог: n меньше 5 — отказ БЕЗ медианы, n = 5 — результат; константа порога равна 5 и заморожена в MEASURES-описании', () => {
  assert.equal(OM.MIN_N, 5);
  for (const n of [0, 1, 4]) {
    const ev = OM.evaluate(Array.from({ length: n }, (_, i) => 1000 * (i + 1)));
    assert.equal(ev.ok, false);
    assert.equal(ev.n, n);
    assert.ok(!('median_ms' in ev), 'при n меньше 5 медианы в ответе нет');
  }
  const ok = OM.evaluate([1000, 2000, 3000, 4000, 5000]);
  assert.deepEqual(ok, { ok: true, n: 5, median_ms: 3000, min_ms: 1000, max_ms: 5000 });
  assert.ok(Object.isFrozen(OM.MEASURES) && Object.isFrozen(OM.MEASURES.first_forecast));
  assert.equal(OM.MEASURES.first_forecast.req, 'REQ-110');
  assert.equal(OM.MEASURES.quick_entry.req, 'REQ-090');
  assert.equal(OM.MEASURES.quick_entry.target_ms, 5000, 'цель-гипотеза REQ-090: 5 секунд');
  assert.notEqual(OM.MEASURES.first_forecast.id, OM.MEASURES.quick_entry.id);
});

// ── файлы метрик ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-110 файлы runway-metrics/1: время до первого прогноза берётся из first_forecast.after_seconds; без прогноза, без шагов, не по схеме, не JSON и копии в n не входят', () => {
  const dup = person(300);
  const r = OM.read_metrics_values([
    { name: 'a.json', text: dup },
    { name: 'b.json', text: person(360) },
    { name: 'copy-of-a.json', text: dup },
    { name: 'no-forecast.json', text: metrics_file({ forecast: false }) },
    { name: 'no-steps.json', text: metrics_file({ steps: [], forecast: true }) },
    { name: 'broken.json', text: '{' },
    { name: 'alien.json', text: JSON.stringify({ format: 'runway-metrics/1', total: 1 }) },
  ]);
  assert.deepEqual(r.used, [{ name: 'a.json', ms: 300000 }, { name: 'b.json', ms: 360000 }]);
  const reason = (name) => r.skipped.find((s) => s.name === name)?.reason;
  assert.equal(reason('copy-of-a.json'), 'duplicate');
  assert.equal(r.skipped.find((s) => s.name === 'copy-of-a.json').detail, 'a.json');
  assert.equal(reason('no-forecast.json'), 'first_forecast_not_reached');
  assert.equal(reason('no-steps.json'), 'no_wizard_steps');
  assert.equal(reason('broken.json'), 'not_json');
  assert.equal(reason('alien.json'), 'invalid_package');
});

test('REQ-110 один файл, скопированный пять раз, даёт n = 1: накрутить число людей копией нельзя', () => {
  const one = person(420);
  const r = OM.read_metrics_values(Array.from({ length: 5 }, (_, i) => ({ name: `copy${i}.json`, text: one })));
  assert.equal(r.used.length, 1);
  assert.equal(OM.evaluate(r.used.map((u) => u.ms)).ok, false);
});

// ── листы наблюдателя ───────────────────────────────────────────────────────────────────────────────────────────────────

const sheet = (persons, extra = {}) => JSON.stringify({ format: OM.TIMING_FORMAT, measure: 'quick_entry', persons, ...extra });

test('REQ-090 лист наблюдателя runway-timing/1: значение человека — медиана его попыток; строгая схема отвергает имена, лишние поля, неверные секунды', () => {
  const ok = OM.read_timing_values([{ name: 's.json', text: sheet([{ attempts_s: [4.2, 3.9, 5.1] }, { attempts_s: [6.4, 6.0, 7.1] }, { attempts_s: [1, 2, 3.5, 2.2] }]) }]);
  assert.deepEqual(ok.used.map((u) => u.ms), [4200, 6400, 2100]);
  assert.equal(ok.skipped.length, 0);
  assert.equal(ok.started, 3);
  const bad = (text) => OM.read_timing_values([{ name: 'x.json', text }]).skipped[0];
  assert.equal(bad(sheet([{ attempts_s: [4], name: 'Иван' }])).reason, 'invalid_sheet', 'имя участника в листе недопустимо');
  assert.equal(bad(sheet([{ attempts_s: [4], note: 'x' }])).detail, 'person');
  assert.equal(bad(sheet([{ attempts_s: [4] }], { who: 'я' })).detail, 'keys');
  assert.equal(bad(sheet([])).detail, 'persons');
  assert.equal(bad(sheet([{ attempts_s: [] }])).detail, 'attempts');
  assert.equal(bad(sheet([{ attempts_s: Array(11).fill(3) }])).detail, 'attempts');
  assert.equal(bad(sheet([{ attempts_s: [0] }])).detail, 'attempt_value');
  assert.equal(bad(sheet([{ attempts_s: [601] }])).detail, 'attempt_value');
  assert.equal(bad(sheet([{ attempts_s: ['4'] }])).detail, 'attempt_value');
  assert.equal(bad(JSON.stringify({ format: 'runway-timing/2', measure: 'quick_entry', persons: [{ attempts_s: [4] }] })).detail, 'format');
  assert.equal(bad(JSON.stringify({ format: OM.TIMING_FORMAT, measure: 'first_forecast', persons: [{ attempts_s: [4] }] })).detail, 'measure');
  assert.equal(bad('[]').detail, 'not_object');
  assert.equal(bad('}').reason, 'not_json');
  const same = sheet([{ attempts_s: [4, 4.5, 5] }]);
  const twice = OM.read_timing_values([{ name: 'a.json', text: same }, { name: 'b.json', text: same }]);
  assert.equal(twice.used.length, 1);
  assert.equal(twice.skipped[0].reason, 'duplicate');
});

// ── запись реестра ──────────────────────────────────────────────────────────────────────────────────────────────────────

const ev6 = OM.evaluate([300, 360, 420, 480, 540, 600].map((s) => s * 1000));

test('REQ-110 REQ-178 запись: уровень только measured, n и дата рядом с цифрой, ключ текста по правилу реестра, ссылка на тест настоящая', () => {
  const rec = OM.make_record('first_forecast', ev6, '2026-11-02');
  assert.deepEqual(rec, {
    id: 'first_forecast_time', kind: 'promise', text_key: 'showcase.cl_first_forecast_time', level: 'measured', surface: 'ui',
    checked_on: '2026-11-02', measured_on: '2026-11-02', n: 6, median_ms: 450000, test: { file: 'tests/onboarding_median.test.mjs', id: 'REQ-110' },
  });
  const q = OM.make_record('quick_entry', OM.evaluate([3, 4, 5, 6, 7].map((s) => s * 1000)), '2026-11-02');
  assert.equal(q.id, 'quick_entry_time');
  assert.equal(q.test.id, 'REQ-090');
  // ссылка настоящая: файл есть, а в названии теста стоит идентификатор (то, что требует tests/promises.test.mjs)
  const titles = fs.readFileSync(path.join(HERE, 'onboarding_median.test.mjs'), 'utf8').split('\n').filter((l) => /^\s*test(?:\.\w+)?\(/.test(l));
  for (const r of [rec, q]) {
    assert.ok(fs.existsSync(path.join(PROTO, r.test.file)));
    assert.ok(titles.some((l) => l.includes(r.test.id)), r.id);
  }
  assert.deepEqual(PR.validate_registry([...REAL_ROWS, rec, q]), []);
  // отказы
  assert.throws(() => OM.make_record('first_forecast', { n: 4, median_ms: 1 }, '2026-11-02'), (e) => e.code === 'n_below_min');
  assert.throws(() => OM.make_record('first_forecast', { n: 0, median_ms: 1 }, '2026-11-02'), (e) => e.code === 'n_below_min');
  assert.throws(() => OM.make_record('first_forecast', ev6, '2026-02-30'), (e) => e.code === 'bad_date');
  assert.throws(() => OM.make_record('first_forecast', ev6, 'сегодня'), (e) => e.code === 'bad_date');
  assert.throws(() => OM.make_record('first_forecast', ev6, undefined), (e) => e.code === 'bad_date');
  assert.throws(() => OM.make_record('speed', ev6, '2026-11-02'), (e) => e.code === 'unknown_measure');
});

test('REQ-110 REQ-178 слияние: добавляет запись; повторное измерение заменяет прежнее, если не старее; чужой уровень и старое измерение не затираются; реестр после записи проходит форму и линтер', () => {
  const rec = OM.make_record('first_forecast', ev6, '2026-11-02');
  const added = OM.merge_record(REAL_ROWS, rec);
  assert.equal(added.length, REAL_ROWS.length + 1);
  assert.deepEqual(added.slice(0, REAL_ROWS.length), REAL_ROWS, 'прежние строки не тронуты и не переставлены');
  assert.deepEqual(PR.validate_registry(added), []);
  assert.deepEqual(LINT.lint_promises(added, '2026-11-02').filter((f) => f.level === 'error'), []);
  const later = OM.make_record('first_forecast', OM.evaluate([200, 210, 220, 230, 240].map((s) => s * 1000)), '2026-12-01');
  const replaced = OM.merge_record(added, later);
  assert.equal(replaced.length, added.length, 'то же утверждение заменяется, а не дублируется');
  assert.equal(replaced.find((r) => r.id === 'first_forecast_time').median_ms, 220000);
  assert.throws(() => OM.merge_record(replaced, rec), (e) => e.code === 'older_than_existing');
  const verified = [...REAL_ROWS, { ...rec, level: 'verified', measured_on: undefined, n: undefined, median_ms: undefined }].map((r) => JSON.parse(JSON.stringify(r)));
  assert.throws(() => OM.merge_record(verified, later), (e) => e.code === 'existing_not_measured');
  assert.throws(() => OM.merge_record(REAL_ROWS, { ...rec, level: 'verified' }), (e) => e.code === 'level_not_measured');
  assert.throws(() => OM.merge_record(REAL_ROWS, { ...rec, level: 'hypothesis' }), (e) => e.code === 'level_not_measured');
  assert.throws(() => OM.merge_record('нет', rec), (e) => e.code === 'registry_not_array');
  assert.throws(() => OM.merge_record(REAL_ROWS, { ...rec, text_key: 'showcase.cl_other' }), (e) => e.code === 'registry_invalid');
});

test('REQ-110 REQ-178 срок годности: с --today измерение старше 90 дней и дата из будущего отвергаются; ровно 90 дней допустимо', () => {
  const rec = OM.make_record('first_forecast', ev6, '2026-11-02');
  const day = E.to_epoch_day('2026-11-02');
  assert.ok(OM.merge_record(REAL_ROWS, rec, { today: E.format_date(day + 90) }));
  assert.throws(() => OM.merge_record(REAL_ROWS, rec, { today: E.format_date(day + 91) }), (e) => e.code === 'stale_measurement');
  assert.throws(() => OM.merge_record(REAL_ROWS, rec, { today: '2026-11-01' }), (e) => e.code === 'date_in_future');
  assert.throws(() => OM.merge_record(REAL_ROWS, rec, { today: '31.12.2026' }), (e) => e.code === 'bad_date');
  // чужая устаревшая строка реестра не мешает записать свежее измерение (её остановит линтер при сборке)
  const old_row = { ...REAL_ROWS.find((r) => r.level === 'measured'), measured_on: '2026-01-01' };
  assert.ok(OM.merge_record([old_row], rec, { today: '2026-11-03' }));
});

test('REQ-110 стиль файла: настоящий promises.json разбирается и выводится обратно побайтно (запись инструмента не даёт лишних правок строк)', () => {
  assert.equal(OM.render_registry(REAL_ROWS), REAL_TEXT);
  const rec = OM.make_record('first_forecast', ev6, '2026-11-02');
  const text = OM.render_registry(OM.merge_record(REAL_ROWS, rec));
  const old_lines = REAL_TEXT.trimEnd().split('\n');
  const new_lines = text.trimEnd().split('\n');
  assert.equal(new_lines.length, old_lines.length + 1);
  const last = old_lines.length - 2; // индекс последней записи реестра (за ней только «]»)
  assert.deepEqual(new_lines.slice(0, last), old_lines.slice(0, last), 'все прежние строки, кроме последней записи (она получила запятую), без изменений');
  assert.equal(new_lines[last], old_lines[last] + ',');
  assert.equal(new_lines.at(-1), ']');
  assert.match(new_lines.at(-2), /^ {2}\{ "id": "first_forecast_time", .*"test": \{ "file": "tests\/onboarding_median\.test\.mjs", "id": "REQ-110" \} \}$/);
  assert.deepEqual(JSON.parse(text).at(-1), rec);
});

// ── длительность и тексты для ручного шага ──────────────────────────────────────────────────────────────────────────────

test('REQ-110 REQ-090 длительность словами: до минуты — секунды с одним знаком (запятая в RU, точка в EN), дальше — минуты и секунды', () => {
  assert.equal(OM.format_duration('ru', 3800), '3,8 с');
  assert.equal(OM.format_duration('en', 3800), '3.8 s');
  assert.equal(OM.format_duration('ru', 5000), '5 с');
  assert.equal(OM.format_duration('ru', 450000), '7 мин 30 с');
  assert.equal(OM.format_duration('en', 450000), '7 min 30 s');
  assert.equal(OM.format_duration('ru', 300000), '5 мин');
  assert.equal(OM.format_duration('ru', 60000), '1 мин');
  assert.equal(OM.format_duration('ru', 0), '0 с');
});

test('REQ-110 REQ-090 REQ-178 предложенные тексты и строка зеркала: без запрещённых формулировок, без «за N минут», с n, датой и словами «не обещание»; строка зеркала равна форме записи REGISTRY', () => {
  const forbidden = VOCAB.forbidden_phrases.map((p) => p.toLowerCase().replace(/ё/g, 'е'));
  for (const measure of ['first_forecast', 'quick_entry']) {
    const rec = OM.make_record(measure, ev6, '2026-11-02');
    const f = OM.followups(measure, rec);
    assert.equal(f.key, rec.text_key);
    for (const lang of ['ru', 'en']) {
      const text = f.texts[lang];
      assert.ok(text.includes('n = 6') && text.includes('2026-11-02'), lang + ': n и дата рядом с цифрой');
      assert.ok(text.includes(OM.format_duration(lang, rec.median_ms)), lang + ': цифра');
      assert.ok(lang === 'ru' ? /не обещание/.test(text) : /not a promise/.test(text), lang + ': оговорка');
      assert.ok(!/первый\s+прогноз\s+за\s+\d+\s+минут/i.test(text), lang + ': без «за N минут»');
      assert.ok(!/(?:первые|единственн|нет ни у кого|the only|first to|nobody else|no one else)/i.test(text), lang + ': без сравнений');
      const low = text.toLowerCase().replace(/ё/g, 'е');
      for (const p of forbidden) assert.ok(!low.includes(p), lang + ': «' + p + '»');
      assert.deepEqual(LINT.lint_text(text, { file: 'text', vocab: VOCAB }).filter((x) => x.level === 'error'), []);
    }
    assert.ok(/[а-яё]/i.test(f.texts.ru), 'RU-строка содержит русские буквы');
    assert.ok(f.texts.ru.trim().length > 10 && f.texts.en.trim().length > 10);
    // зеркало: строка, выполненная через такой же помощник claim(), даёт ту же запись, что в JSON
    const claim = (id, kind, level, tf, ti, extra = {}) => ({ id, kind, text_key: 'showcase.cl_' + id, level, surface: 'ui', checked_on: '2026-10-05', ...extra, test: { file: tf, id: ti } });
    const m = /^\s*claim\('([^']+)', '([^']+)', '([^']+)', '([^']+)', '([^']+)', \{ checked_on: '([^']+)', measured_on: '([^']+)', n: (\d+), median_ms: (\d+) \}\),$/.exec(f.mirror);
    assert.ok(m !== null, 'строка зеркала в ожидаемой форме: ' + f.mirror);
    assert.deepEqual(claim(m[1], m[2], m[3], m[4], m[5], { checked_on: m[6], measured_on: m[7], n: Number(m[8]), median_ms: Number(m[9]) }), rec);
  }
});

// ── командная строка (в памяти) ─────────────────────────────────────────────────────────────────────────────────────────

test('REQ-110 командная строка: n меньше 5 — код 1, медианы в выводе нет, ничего не пишется (даже с --write)', () => {
  for (const extra of [[], ['--date', '2026-11-02', '--write']]) {
    const files = { 'p1.json': person(300), 'p2.json': person(330), 'p3.json': person(360), 'p4.json': person(390), [REG]: REAL_TEXT };
    const io = fake_io(files);
    const code = OM.main(['p1.json', 'p2.json', 'p3.json', 'p4.json', '--registry', REG, ...extra], io);
    assert.equal(code, 1);
    assert.equal(io.writes.length, 0);
    const out = io.outs.join('\n');
    assert.match(out, /Отказ: учтено n = 4 из 5 обязательных/);
    assert.doesNotMatch(out, /Медиана:/);
    assert.doesNotMatch(out, /\d\s*(?:мин|с)(?![\p{L}])/u, 'ни одной длительности в выводе');
    assert.equal(files[REG], REAL_TEXT);
  }
});

test('REQ-110 командная строка: n = 5 без --write — отчёт и «была бы записана», файл не тронут; с --write — запись и список ручных шагов', () => {
  const totals = [300, 360, 420, 480, 540];
  const mk = () => Object.fromEntries([...totals.map((t, i) => [`p${i + 1}.json`, person(t)]), [REG, REAL_TEXT]]);
  const names = totals.map((_, i) => `p${i + 1}.json`);

  const dry_files = mk();
  const dry = fake_io(dry_files);
  assert.equal(OM.main([...names, '--registry', REG, '--date', '2026-11-02'], dry), 0);
  assert.equal(dry.writes.length, 0);
  const dry_out = dry.outs.join('\n');
  assert.match(dry_out, /Медиана: 7 мин \(420000 мс\)/);
  assert.match(dry_out, /Запись не выполнена \(нужен флаг --write\)/);
  assert.match(dry_out, /"level": "measured"/);

  const files = mk();
  const io = fake_io(files);
  assert.equal(OM.main([...names, '--registry', REG, '--date', '2026-11-02', '--write'], io), 0);
  assert.equal(io.writes.length, 1);
  assert.equal(io.writes[0][0], REG);
  const rows = JSON.parse(files[REG]);
  const rec = rows.at(-1);
  assert.deepEqual([rec.id, rec.level, rec.n, rec.median_ms, rec.measured_on], ['first_forecast_time', 'measured', 5, 420000, '2026-11-02']);
  assert.deepEqual(PR.validate_registry(rows), []);
  assert.deepEqual(rows.slice(0, -1), REAL_ROWS);
  const out = io.outs.join('\n');
  assert.match(out, /Записано в .*: first_forecast_time \(level measured, n = 5, 2026-11-02\)/);
  assert.match(out, /demo\/promises\.mjs, массив REGISTRY/);
  assert.match(out, /demo\/i18n\/showcase\.mjs — ключ «showcase\.cl_first_forecast_time»/);
  assert.match(out, /node tools\/build_manifest\.mjs/);
  assert.match(out, /first_minutes/);
});

test('REQ-090 командная строка quick_entry: листы наблюдателя, цель 5 секунд — достигнута и не достигнута (измерение публикуется в обоих случаях); без --date записи нет', () => {
  const mk_sheet = (attempts) => sheet(attempts.map((a) => ({ attempts_s: a })));
  const fast = mk_sheet([[3.1, 3.5, 3.9], [4.2, 4.0, 4.4], [2.8, 2.9, 3.0], [5.0, 4.8, 4.9], [3.7, 3.6, 3.3]]);
  const io = fake_io({ 'a.json': fast, [REG]: REAL_TEXT });
  assert.equal(OM.main(['a.json', '--measure', 'quick_entry', '--registry', REG, '--date', '2026-11-02', '--write'], io), 0);
  const rec = JSON.parse(io.writes[0][1]).at(-1);
  assert.deepEqual([rec.id, rec.n, rec.median_ms, rec.test.id], ['quick_entry_time', 5, 3600, 'REQ-090']);
  assert.match(io.outs.join('\n'), /Цель REQ-090 — не более 5 с: достигнута/);

  const slow = mk_sheet([[7, 7.5, 6.5], [8, 8.5, 7.5], [9, 9.5, 8.5], [6, 6.5, 5.5], [10, 10.5, 9.5]]);
  const io2 = fake_io({ 'b.json': slow, [REG]: REAL_TEXT });
  assert.equal(OM.main(['b.json', '--measure', 'quick_entry', '--registry', REG, '--date', '2026-11-02', '--write'], io2), 0);
  assert.match(io2.outs.join('\n'), /не достигнута \(измерение можно публиковать как есть, требование не закрыто\)/);
  assert.equal(JSON.parse(io2.writes[0][1]).at(-1).median_ms, 8000);

  const io3 = fake_io({ 'a.json': fast, [REG]: REAL_TEXT });
  assert.equal(OM.main(['a.json', '--measure', 'quick_entry', '--registry', REG], io3), 0);
  assert.equal(io3.writes.length, 0);
  assert.match(io3.outs.join('\n'), /дата замера не задана/);
});

test('REQ-110 командная строка: неверный запуск — код 2 и ничего не пишется; конфликты с реестром и дата — код 1', () => {
  const base = { 'p.json': person(300), [REG]: REAL_TEXT };
  const run = (argv, files = base) => { const io = fake_io({ ...files }); return { code: OM.main(argv, io), io }; };
  assert.equal(run([]).code, 2, 'нет файлов');
  assert.equal(run(['p.json', '--write', '--registry', REG]).code, 2, '--write без --date');
  assert.equal(run(['p.json', '--measure', 'speed']).code, 2);
  assert.equal(run(['p.json', '--bogus']).code, 2, 'неизвестный флаг');
  assert.equal(run(['p.json', '--min-n', '1']).code, 2, 'порог флагом не меняется');
  assert.equal(run(['p.json', '--date']).code, 2, 'нет значения');
  assert.equal(run(['p.json', '--date', '2026-02-30']).code, 2, 'дата не календарная');
  assert.equal(run(['p.json', '--today', 'завтра']).code, 2);
  assert.equal(run(['--help']).code, 0);
  const missing = run(['absent.json']);
  assert.equal(missing.code, 1, 'нет файла');
  assert.match(missing.io.errs.join('\n'), /Ошибка чтения файла/);
  for (const r of [run([]), run(['p.json', '--bogus'])]) assert.equal(r.io.writes.length, 0);
  // реестр не читается / сломан — код 1
  const five = Object.fromEntries([300, 330, 360, 390, 420].map((s, i) => [`q${i}.json`, person(s)]));
  const broken = run(Object.keys(five).concat(['--registry', REG, '--date', '2026-11-02', '--write']), { ...five, [REG]: '{' });
  assert.equal(broken.code, 1);
  assert.match(broken.io.errs.join('\n'), /Ошибка чтения реестра/);
  assert.equal(broken.io.writes.length, 0);
  const missing_reg = run(Object.keys(five).concat(['--registry', REG, '--date', '2026-11-02', '--write']), five);
  assert.equal(missing_reg.code, 1, 'реестра нет');
});

test('REQ-110 командная строка: запись не перезаписывает чужое — измерение старше существующего и утверждение другого уровня отвергаются с названной причиной', () => {
  const names = ['a', 'b', 'c', 'd', 'e'].map((x) => x + '.json');
  const base = Object.fromEntries(names.map((n, i) => [n, person(300 + 60 * i)]));
  const first = fake_io({ ...base, [REG]: REAL_TEXT });
  assert.equal(OM.main([...names, '--registry', REG, '--date', '2026-12-01', '--write'], first), 0);
  const after = first.writes[0][1];
  const older = fake_io({ ...base, [REG]: after });
  assert.equal(OM.main([...names, '--registry', REG, '--date', '2026-11-01', '--write'], older), 1);
  assert.match(older.outs.join('\n'), /измерение «first_forecast_time» от 2026-12-01 новее заданной даты 2026-11-01/);
  assert.equal(older.writes.length, 0);
  const rows = JSON.parse(after).map((r) => (r.id === 'first_forecast_time' ? { ...r, level: 'verified' } : r));
  const other = fake_io({ ...base, [REG]: JSON.stringify(rows) });
  assert.equal(OM.main([...names, '--registry', REG, '--date', '2026-12-05', '--write'], other), 1);
  assert.match(other.outs.join('\n'), /уже есть утверждение «first_forecast_time» уровня «verified»/);
  const stale = fake_io({ ...base, [REG]: REAL_TEXT });
  assert.equal(OM.main([...names, '--registry', REG, '--date', '2026-01-10', '--today', '2026-11-02', '--write'], stale), 1);
  assert.match(stale.outs.join('\n'), /старше 90 дней/);
  assert.equal(stale.writes.length, 0);
});

// ── отдельный процесс ───────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-110 REQ-090 процесс: настоящий запуск на копии реестра — отказ при n = 4 (код 1), запись при n = 5 (код 0); настоящий demo/promises.json не меняется', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-om-'));
  const real_before = sha(fs.readFileSync(REAL_REGISTRY));
  try {
    const reg = path.join(dir, 'promises.json');
    fs.writeFileSync(reg, REAL_TEXT, 'utf8');
    const files = [300, 360, 420, 480, 540].map((t, i) => { const f = path.join(dir, `P0${i + 1}.json`); fs.writeFileSync(f, person(t), 'utf8'); return f; });
    const run = (list, extra) => spawnSync(process.execPath, [path.join(PROTO, 'tools', 'onboarding_median.mjs'), ...list, '--registry', reg, ...extra], { encoding: 'utf8', timeout: 100000 });
    const refused = run(files.slice(0, 4), ['--date', '2026-11-02', '--today', '2026-11-02', '--write']);
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stdout, /Отказ: учтено n = 4 из 5 обязательных/);
    assert.equal(fs.readFileSync(reg, 'utf8'), REAL_TEXT);
    const done = run(files, ['--date', '2026-11-02', '--today', '2026-11-02', '--write']);
    assert.equal(done.status, 0, done.stdout + done.stderr);
    const rows = JSON.parse(fs.readFileSync(reg, 'utf8'));
    assert.equal(rows.at(-1).median_ms, 420000);
    assert.deepEqual(PR.validate_registry(rows), []);
    const usage = run([], []);
    assert.equal(usage.status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(sha(fs.readFileSync(REAL_REGISTRY)), real_before, 'настоящий реестр не тронут');
});

// ── цифры до измерения не публикуются ───────────────────────────────────────────────────────────────────────────────────

test('REQ-110 REQ-090 REQ-178 цифры до измерения нет: записи инструмента в реестре либо отсутствуют, либо measured с n не меньше 5, датой и медианой; в каталогах строк нет «за N минут» без измерения', async () => {
  for (const m of Object.values(OM.MEASURES)) {
    const row = REAL_ROWS.find((r) => r.id === m.id);
    if (row === undefined) continue; // измерения ещё не было: цифры нет
    assert.equal(row.level, 'measured', m.id);
    assert.ok(Number.isSafeInteger(row.n) && row.n >= OM.MIN_N, m.id + ': n не меньше 5');
    assert.ok(OM.valid_date(row.measured_on), m.id + ': дата замера');
    assert.ok(Number.isSafeInteger(row.median_ms) && row.median_ms > 0, m.id + ': медиана');
  }
  const catalogs = [...(await LINT.load_catalogs(RUNWAY)), ...(await LINT.load_template_catalogs(RUNWAY))];
  const measured_ids = new Set(REAL_ROWS.filter((r) => r.level === 'measured').map((r) => 'showcase.cl_' + r.id));
  for (const c of catalogs) {
    for (const lang of ['ru', 'en']) {
      for (const [k, v] of Object.entries(c[lang])) {
        if (measured_ids.has(k)) continue;
        assert.ok(!/первый\s+прогноз\s+за\s+\d+\s+минут/i.test(v), `${c.file}:${k}: «первый прогноз за N минут» без измерения`);
        assert.ok(!/(?:first forecast|forecast)\s+in\s+\d+\s+minutes/i.test(v), `${c.file}:${k}: «forecast in N minutes» без измерения`);
      }
    }
  }
  // линтер обещаний: «первый прогноз за N минут» без измерения — ошибка, с измерением — нет
  const base = REAL_ROWS[0];
  const rule = (rows) => LINT.lint_promises(rows, '2026-11-02').filter((f) => f.level === 'error').map((f) => f.rule);
  assert.deepEqual(rule([{ ...base, text: 'Первый прогноз за 7 минут', level: 'verified' }]), ['first-forecast']);
  assert.deepEqual(rule([OM.make_record('first_forecast', ev6, '2026-11-02')]), []);
});
