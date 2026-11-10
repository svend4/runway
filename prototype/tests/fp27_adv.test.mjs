// fp27_adv.test.mjs — состязательная проверка FP-27 (пакеты для людей: пакет для юриста, медиана замера, документы).
// Файл АДДИТИВНЫЙ: подтверждённые дефекты были помечены `todo` (тест описывает ожидаемое поведение; пока дефект жив, он красный «в счёт todo» и сборку не ломает —
// как в fp11_adv). Дефекты исправлены в проходе исправлений FP-27, пометки `todo` сняты: все тесты файла теперь обычные и закрепляют исправленное и проверенное руками поведение.
// Настоящий demo/promises.json и _ops/people тесты НЕ меняют: реестр — только в памяти, пакет — только читается.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const RUNWAY = path.join(PROTO, '..');
const imp = (...p) => import(pathToFileURL(path.join(...p)).href);

const PP = await imp(PROTO, 'tools', 'people_pack.mjs');
const OM = await imp(PROTO, 'tools', 'onboarding_median.mjs');
const MX = await imp(PROTO, 'demo', 'metrics.mjs');
const WZ = await imp(PROTO, 'demo', 'wizard.mjs');
const DATA = await PP.collect_legal_data();
const PACK = fs.readFileSync(path.join(RUNWAY, '_ops', 'people', 'legal-review-package.md'), 'utf8').replace(/\r\n/g, '\n');
const REAL_REGISTRY_TEXT = fs.readFileSync(path.join(PROTO, 'demo', 'promises.json'), 'utf8');
const display_file = (f) => f.replace(/^prototype\//, '').replace(/^demo\//, '');

/** Файл метрик настоящим `create_metrics`: два шага мастера общей длиной `total` секунд; `forecast = false` — человек до прогноза не дошёл. */
function metrics_file(total, forecast = true) {
  const m = MX.create_metrics({ storage: null, day: () => 20000, engine_version: '0.1.0' });
  m.begin_session();
  m.record_step({ step: 'account', seconds: Math.floor(total / 2), outcome: 'saved' });
  m.record_step({ step: 'obligations', seconds: total - Math.floor(total / 2), outcome: 'saved' });
  if (forecast) m.mark_first_forecast();
  return m.package_text();
}

/** Ввод-вывод в памяти: файлы по ключу-пути, записи и строки вывода. */
function fake_io(files) {
  const outs = [];
  const errs = [];
  return {
    read: (p) => { if (!Object.hasOwn(files, p)) throw Object.assign(new Error('нет файла'), { code: 'ENOENT' }); return files[p]; },
    write: (p, t) => { files[p] = t; },
    out: (s) => outs.push(s),
    err: (s) => errs.push(s),
    outs, errs,
  };
}
const REG = path.resolve('adv-registry.json');

// ── пакет для юриста: полнота ───────────────────────────────────────────────────────────────────────────────────────────

test('REQ-183 ADV полнота (по ключам): строки налогового конверта и правил (ключи *.tax_*) не пропущены выборкой — ВСЕ строки про налоги в пакете', () => {
  const missing = [];
  for (const cat of DATA.catalogs) {
    for (const key of Object.keys(cat.ru)) {
      if (!/(^|[._])tax(_|\.|$)|\.f_rate_tax$|\.f_tax_rule_id$/.test(key)) continue;
      const needle = '| `' + display_file(cat.file) + '` · `' + key + '` |';
      if (!PACK.includes(needle)) missing.push(display_file(cat.file) + ' · ' + key);
    }
  }
  assert.deepEqual(missing, [], 'пропущено строк про налоговые правила и конверт: ' + missing.length + '; первые: ' + missing.slice(0, 5).join(', '));
});

test('REQ-183 ADV полнота (по смыслу): строка «отложено по вашему правилу» (rs.tax_line) и подсказка «приложение ставок не подсказывает» (forms.tax_none) — то, о чём спрашивает Q1 пакета — в нём есть', () => {
  assert.ok(PACK.includes('`rs.tax_line`'), 'rs.tax_line');
  assert.ok(PACK.includes('`forms.tax_none`'), 'forms.tax_none');
});

test('REQ-183 ADV пакет не врёт о методе: шапка называет выборку «по ключевым словам», а Q1 задан про показ суммы «в конверт»', () => {
  assert.match(PACK, /Выборка по ключевым словам с запасом/);
  assert.match(PACK, /\| Q1 \| Считается ли показ суммы «в конверт по правилу пользователя»/);
});

// ── onboarding_median: защита даты ─────────────────────────────────────────────────────────────────────────────────────

test('REQ-110 ADV дата замера: дата из будущего без --today отвергается (иначе измерение никогда не «протухнет» и обойдёт срок 90 дней)', () => {
  const files = { [REG]: REAL_REGISTRY_TEXT };
  const names = [];
  for (let i = 0; i < 5; i++) { files['p' + i] = metrics_file(100 + 10 * i); names.push('p' + i); }
  const io = fake_io(files);
  const code = OM.main([...names, '--date', '2099-01-01', '--registry', REG, '--write'], io);
  assert.equal(code, 1, 'будущая дата должна быть отказом, а не записью: ' + io.outs.slice(-2).join(' | '));
  assert.equal(files[REG], REAL_REGISTRY_TEXT, 'реестр не тронут');
});

// ── onboarding_median: честность медианы ───────────────────────────────────────────────────────────────────────────────

test('REQ-110 ADV предложенный текст для публикации называет, сколько участников до прогноза не дошли (медиана только по дошедшим — иначе время занижено)', () => {
  const files = { [REG]: REAL_REGISTRY_TEXT };
  const names = [];
  for (let i = 0; i < 5; i++) { files['r' + i] = metrics_file(100 + 10 * i); names.push('r' + i); }
  for (let i = 0; i < 5; i++) { files['x' + i] = metrics_file(30 + i, false); names.push('x' + i); }
  const io = fake_io(files);
  const code = OM.main([...names, '--date', '2026-10-23', '--today', '2026-10-23', '--registry', REG, '--write'], io);
  assert.equal(code, 0, io.outs.join('\n'));
  const suggestion = io.outs.filter((s) => s.includes('ru: ')).join('\n');
  assert.match(suggestion, /из 10|не дошли|не получили|дошли 5/, 'в предложенном тексте нет сведений о тех, кто прогноза не получил');
});

test('REQ-090 ADV лист наблюдателя: копия листа с другим порядком ключей не засчитывается второй раз', () => {
  const persons = [1, 2, 3].map((k) => ({ attempts_s: [2 + k, 3 + k, 4 + k] }));
  const a = JSON.stringify({ format: 'runway-timing/1', measure: 'quick_entry', persons });
  const b = JSON.stringify({ persons, measure: 'quick_entry', format: 'runway-timing/1' });
  const r = OM.read_timing_values([{ name: 'a', text: a }, { name: 'b', text: b }]);
  assert.equal(r.used.length, 3, 'копия не должна прибавлять людей');
});

test('REQ-090 ADV лист наблюдателя: человек с одной попыткой не засчитывается (протокол требует полный набор из трёх засчитанных попыток)', () => {
  const sheet = { format: 'runway-timing/1', measure: 'quick_entry', persons: [1, 2, 3, 4, 5].map(() => ({ attempts_s: [3.0] })) };
  const r = OM.read_timing_values([{ name: 's', text: JSON.stringify(sheet) }]);
  assert.ok(r.used.length < 5, 'пять людей с одной попыткой дают n = ' + r.used.length);
});

// ── что действительно измеряется ───────────────────────────────────────────────────────────────────────────────────────

test('REQ-110 ADV «активное время»: пауза в 10 минут засчитывается как 60 секунд (потолок простоя), а не исключается', () => {
  let t = 0;
  const timer = WZ.create_step_timer({ now_ms: () => t });
  timer.enter('account');
  t += 10 * 60 * 1000;
  timer.touch();
  assert.equal(timer.seconds('account'), 60);
});

test('REQ-110 ADV протокол замера описывает «активное время» как время без пауз', () => {
  const doc = fs.readFileSync(path.join(RUNWAY, '_ops', 'people', 'timing-protocol.md'), 'utf8');
  assert.match(doc, /простоя[^.]*60|60[^.]*простоя|урезан|усечён|потолок/i, 'в протоколе не сказано, что каждая пауза засчитывается до 60 секунд');
});

// ── что проверено руками и должно остаться верным ──────────────────────────────────────────────────────────────────────

test('REQ-110 ADV порог: четыре дошедших из десяти — отказ без медианы, реестр не тронут, даже с --write и --today', () => {
  const files = { [REG]: REAL_REGISTRY_TEXT };
  const names = [];
  for (let i = 0; i < 4; i++) { files['r' + i] = metrics_file(100 + 10 * i); names.push('r' + i); }
  for (let i = 0; i < 6; i++) { files['x' + i] = metrics_file(30 + i, false); names.push('x' + i); }
  const io = fake_io(files);
  const code = OM.main([...names, '--date', '2026-10-23', '--today', '2026-10-23', '--registry', REG, '--write'], io);
  assert.equal(code, 1);
  assert.ok(!/Медиана:/.test(io.outs.join('\n')), 'медианы в выводе нет');
  assert.equal(files[REG], REAL_REGISTRY_TEXT);
});

test('REQ-110 ADV запись: с --today запись из будущего и устаревшая отвергаются, нормальная пишется и только как measured', () => {
  const mk = () => {
    const files = { [REG]: REAL_REGISTRY_TEXT };
    const names = [];
    for (let i = 0; i < 5; i++) { files['p' + i] = metrics_file(100 + 10 * i); names.push('p' + i); }
    return { files, names };
  };
  for (const [date, want] of [['2099-01-01', 1], ['2020-01-01', 1], ['2026-10-23', 0]]) {
    const { files, names } = mk();
    const io = fake_io(files);
    assert.equal(OM.main([...names, '--date', date, '--today', '2026-10-23', '--registry', REG, '--write'], io), want, date);
    if (want === 0) {
      const rows = JSON.parse(files[REG]);
      const rec = rows.at(-1);
      assert.equal(rec.level, 'measured');
      assert.equal(rec.n, 5);
      assert.equal(rows.length, JSON.parse(REAL_REGISTRY_TEXT).length + 1);
    } else {
      assert.equal(files[REG], REAL_REGISTRY_TEXT);
    }
  }
});

test('FP-27 ADV настоящий реестр обещаний не содержит цифр времени: нет first_forecast_time и quick_entry_time', () => {
  const ids = JSON.parse(REAL_REGISTRY_TEXT).map((r) => r.id);
  assert.ok(!ids.includes('first_forecast_time') && !ids.includes('quick_entry_time'));
});
