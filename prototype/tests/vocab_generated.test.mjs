// vocab_generated.test.mjs — FP-17, REQ-019 (TST-56): значения по умолчанию — ДАННЫЕ словаря engine/vocab.json, а не литералы в коде.
// Покрывает: сгенерированный модуль engine/vocab.generated.mjs совпадает со словарём и актуален (tools/gen_vocab.mjs); чтение умолчаний через
// engine/param_defaults.mjs (vdefault, describe_param); числа таблицы REQ-019 не встречаются литералами в engine/*.mjs (кроме сгенерированного файла);
// зеркала TIMELINE_DEFAULTS / CALIBRATION_DEFAULTS / BACKTEST_DEFAULTS / DEBT_DEFAULTS / BACKUP_DEFAULTS собраны из словаря; умолчания проходят проверку диапазонов
// (check_params) и совпадают с набором редактируемых параметров (PARAM_SPECS, PARAM_RANGES); словарь vocab.json генератором не меняется.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.resolve(HERE, '..');
const ENGINE = path.join(PROTO, 'engine');
const imp = (...p) => import(pathToFileURL(path.join(PROTO, ...p)).href);

const GEN = await imp('tools', 'gen_vocab.mjs');
const { VOCAB_PARAMS, VOCAB_FORMAT } = await imp('engine', 'vocab.generated.mjs');
const PD = await imp('engine', 'param_defaults.mjs');
const { TIMELINE_DEFAULTS } = await imp('engine', 'timeline.mjs');
const { CALIBRATION_DEFAULTS } = await imp('engine', 'calibration.mjs');
const { BACKTEST_DEFAULTS } = await imp('engine', 'backtest.mjs');
const { DEBT_DEFAULTS } = await imp('engine', 'debt_ext.mjs');
const { rate_status } = await imp('engine', 'fx.mjs');
const { check_params, PARAM_RANGES } = await imp('engine', 'validate_ws.mjs');
const { PARAM_SPECS, PARAMS_NOT_EDITABLE } = await imp('demo', 'ws_edit.mjs');
const { BACKUP_DEFAULTS } = await imp('demo', 'backup.mjs');

const vocab_text = fs.readFileSync(path.join(ENGINE, 'vocab.json'), 'utf8');
const vocab = JSON.parse(vocab_text);
const clone = (x) => JSON.parse(JSON.stringify(x));

/** Таблица REQ-019 (02-requirements.md, «Критерий приёмки»): независимый оракул — числа переписаны из текста требования, а не из кода. */
const REQ019 = {
  horizon_days: 180, buffer_hint_days: 7, 'worse.income_delay_days': 14, 'match.window_days': 3, 'match.tol_bp': 500, 'wave.gap_days': 3,
  'wave.max_span_days': 10, 'stale.banner_days': 7, 'stale.block_days': 21, 'backup.remind_events': 50, 'backup.remind_days': 7, 'fx.stale_days': 30,
  'backtest.h_days': 30, 'backtest.min_window_days': 14,
};

// ── сгенерированный модуль ───────────────────────────────────────────────────────────────────────────────────────────

test('REQ-019 FP-17: engine/vocab.generated.mjs актуален — текст файла совпадает с тем, что генерирует tools/gen_vocab.mjs из vocab.json', () => {
  assert.equal(GEN.is_fresh(), true, 'файл устарел: node tools/gen_vocab.mjs');
  assert.equal(fs.readFileSync(path.join(ENGINE, 'vocab.generated.mjs'), 'utf8'), GEN.render_vocab_module(vocab));
  assert.equal(VOCAB_FORMAT, vocab.format);
});

test('REQ-019 FP-17: VOCAB_PARAMS равен vocab.json → params поле в поле (default, hypothesis, phase, note), порядок ключей тот же, объекты заморожены', () => {
  assert.deepEqual(Object.keys(VOCAB_PARAMS), Object.keys(vocab.params));
  for (const [k, p] of Object.entries(vocab.params)) {
    assert.deepEqual(clone(VOCAB_PARAMS[k]), p, k);
    assert.ok(Object.isFrozen(VOCAB_PARAMS[k]), k + ': заморожен');
  }
  assert.ok(Object.isFrozen(VOCAB_PARAMS));
  for (const [k, v] of Object.entries(REQ019)) assert.equal(VOCAB_PARAMS[k].default, v, 'таблица REQ-019: ' + k);
});

test('REQ-019 FP-17: генератор детерминирован, только читает vocab.json и отвергает неполный словарь', () => {
  const a = GEN.render_vocab_module(vocab);
  assert.equal(a, GEN.render_vocab_module(JSON.parse(vocab_text)), 'тот же словарь — те же байты');
  assert.ok(!a.includes('\r'), 'переводы строк LF');
  assert.throws(() => GEN.render_vocab_module({}), /нет params/);
  assert.throws(() => GEN.render_vocab_module({ params: { x: { hypothesis: true } } }), /нет default/);
  assert.throws(() => GEN.render_vocab_module({ params: { x: { default: { a: 1 } } } }), /не скаляр/);
  const src = fs.readFileSync(path.join(PROTO, 'tools', 'gen_vocab.mjs'), 'utf8');
  const writes = [...src.matchAll(/writeFileSync\(([^,]+),/g)].map((m) => m[1].trim());
  assert.deepEqual(writes, ['GENERATED_PATH'], 'единственная запись — сгенерированный модуль; vocab.json только читается');
  // дополнительный вариант: словарь с новым параметром порождает запись в модуле (дрейф «словарь ↔ модуль» красный)
  const extra = clone(vocab);
  extra.params['new.param_days'] = { default: 5, hypothesis: true };
  assert.notEqual(GEN.render_vocab_module(extra), a);
  assert.match(GEN.render_vocab_module(extra), /"new\.param_days": Object\.freeze\(\{ default: 5, hypothesis: true \}\)/);
});

// ── чтение умолчаний как данных ──────────────────────────────────────────────────────────────────────────────────────

test('REQ-019 FP-17 param_defaults: vdefault читает словарь; неизвестный ключ — ошибка, а не молчаливый undefined; param_entry и param_keys', () => {
  for (const [k, p] of Object.entries(vocab.params)) assert.equal(PD.vdefault(k), p.default, k);
  assert.throws(() => PD.vdefault('horizon_day'), RangeError);
  assert.throws(() => PD.vdefault(undefined), RangeError);
  assert.throws(() => PD.vdefault('__proto__'), RangeError);
  assert.throws(() => PD.vdefault('toString'), RangeError);
  assert.deepEqual(PD.param_keys(), Object.keys(vocab.params));
  assert.deepEqual(PD.param_entry('fx.stale_days'), { key: 'fx.stale_days', default: 30, hypothesis: true, phase: null, note: null });
  assert.deepEqual(PD.param_entry('debt.drift_tol_bp'), { key: 'debt.drift_tol_bp', default: 50, hypothesis: true, phase: 'v2', note: null });
  assert.equal(PD.param_entry('buffer_minor').default, null);
  assert.match(PD.param_entry('buffer_minor').note, /не задан/);
  assert.equal(PD.param_entry('нет такого'), null);
  assert.equal(PD.param_entry(5), null);
});

test('REQ-019 FP-17 describe_param: умолчание, свой ключ, свой ключ равный умолчанию, явный null, мусор вместо params', () => {
  const d = (k, params) => PD.describe_param(k, params);
  assert.deepEqual(d('horizon_days', {}), { key: 'horizon_days', default: 180, explicit: false, value: 180, is_default: true, hypothesis: false, phase: null, note: null });
  assert.deepEqual([d('horizon_days', { horizon_days: 57 }).value, d('horizon_days', { horizon_days: 57 }).explicit, d('horizon_days', { horizon_days: 57 }).is_default], [57, true, false]);
  assert.deepEqual([d('horizon_days', { horizon_days: 180 }).explicit, d('horizon_days', { horizon_days: 180 }).is_default], [true, true], 'свой ключ, но число то же');
  assert.deepEqual([d('buffer_minor', {}).value, d('buffer_minor', {}).is_default], [null, true], 'буфер по умолчанию не задан');
  assert.deepEqual([d('buffer_minor', { buffer_minor: 0 }).value, d('buffer_minor', { buffer_minor: 0 }).is_default], [0, false], '0 — «задан», не умолчание');
  assert.deepEqual([d('buffer_minor', { buffer_minor: null }).explicit, d('buffer_minor', { buffer_minor: null }).is_default], [true, true]);
  for (const bad of [undefined, null, [], 'x', 5]) assert.equal(d('horizon_days', bad).value, 180, 'params не объект — действует умолчание');
  assert.equal(d('rounding', { rounding: 'floor' }).is_default, false);
  assert.equal(d('нет такого', {}), null);
  assert.equal(d('horizon_days', { __proto__: { horizon_days: 7 } }).explicit, false, 'унаследованное свойство — не собственное значение');
  const all = PD.describe_params({ horizon_days: 57 });
  assert.equal(all.length, Object.keys(vocab.params).length);
  assert.deepEqual(all.filter((x) => !x.is_default).map((x) => x.key), ['horizon_days']);
  assert.deepEqual(PD.describe_params({}, ['rounding', 'нет такого', 'horizon_days']).map((x) => x.key), ['rounding', 'horizon_days']);
});

// ── литералов нет ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Исходник без комментариев (строки остаются: ищутся записи вида `'ключ': число`). */
function code_of(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1 ');
}

test('REQ-019 FP-17: числа таблицы REQ-019 не встречаются литералами в engine/*.mjs (кроме сгенерированного файла): ни «ключ: число», ни «ключ ?? число», ни запасное «stale_days = 30»', () => {
  const files = fs.readdirSync(ENGINE).filter((f) => f.endsWith('.mjs') && f !== 'vocab.generated.mjs');
  assert.ok(files.length >= 30);
  const found = [];
  for (const f of files) {
    const code = code_of(fs.readFileSync(path.join(ENGINE, f), 'utf8'));
    for (const [key, value] of Object.entries(REQ019)) {
      const k = key.replace(/\./g, '\\.');
      const re = new RegExp(`(?:^|[^\\w.])['"]?${k}['"]?\\]?\\s*(?:[:=]|\\?\\?|\\|\\|)\\s*${value}(?![\\d.\\w])`);
      if (re.test(code)) found.push(`${f}: ${key} = ${value}`);
    }
    if (/stale_days\s*=\s*30\b/.test(code)) found.push(f + ': stale_days = 30');
    if (/['"]fx\.stale_days['"]\]\s*:\s*30\b/.test(code)) found.push(f + ': запасное 30 для fx.stale_days');
    if (/\?\?\s*3;\s*$/m.test(code) && /match\.window_days/.test(code)) found.push(f + ': запасное 3 для match.window_days');
  }
  assert.deepEqual(found, [], 'литералы умолчаний: ' + found.join('; '));
  // проверка самой проверки: на старой форме литерал находится
  const old_form = "export const D = { horizon_days: 180, 'wave.gap_days': 3 }; function rate_status(r, a, stale_days = 30) {}";
  assert.ok(/(?:^|[^\w.])['"]?horizon_days['"]?\]?\s*(?:[:=]|\?\?|\|\|)\s*180(?![\d.\w])/.test(code_of(old_form)));
  assert.ok(/stale_days\s*=\s*30\b/.test(code_of(old_form)));
});

test('REQ-019 FP-17: зеркала умолчаний собраны из словаря — TIMELINE/CALIBRATION/BACKTEST/DEBT/BACKUP_DEFAULTS равны vocab.json, каждое значение читается через vdefault', () => {
  for (const [name, table] of [['TIMELINE_DEFAULTS', TIMELINE_DEFAULTS], ['CALIBRATION_DEFAULTS', CALIBRATION_DEFAULTS], ['BACKTEST_DEFAULTS', BACKTEST_DEFAULTS], ['DEBT_DEFAULTS', DEBT_DEFAULTS], ['BACKUP_DEFAULTS', BACKUP_DEFAULTS]]) {
    assert.ok(Object.keys(table).length > 0, name);
    for (const [k, v] of Object.entries(table)) assert.equal(v, VOCAB_PARAMS[k].default, `${name}.${k}`);
  }
  for (const [file, names] of [['timeline.mjs', ['TIMELINE_DEFAULTS']], ['calibration.mjs', ['CALIBRATION_DEFAULTS']], ['backtest.mjs', ['BACKTEST_DEFAULTS']], ['debt_ext.mjs', ['DEBT_DEFAULTS']], ['../demo/backup.mjs', ['BACKUP_DEFAULTS']]]) {
    const src = fs.readFileSync(path.join(ENGINE, file), 'utf8');
    assert.match(src, /param_defaults\.mjs/, file + ' читает param_defaults');
    for (const n of names) assert.match(src, new RegExp(`${n} = Object\\.freeze\\(\\{[^}]*(?:vd|vdefault)\\(`), `${file}: ${n} собран через vdefault`);
  }
});

test('REQ-019 FP-17: предел «курс устарел» берётся из словаря — rate_status без третьего аргумента: ровно fx.stale_days дней ещё не устарел, +1 — устарел', () => {
  const days = vocab.params['fx.stale_days'].default;
  assert.equal(rate_status({ date: 100 }, 100 + days).stale, false);
  assert.equal(rate_status({ date: 100 }, 100 + days + 1).stale, true);
  assert.equal(rate_status({ date: 100 }, 100 + days + 1, days + 5).stale, false, 'явный предел побеждает умолчание');
});

// ── умолчания и проверка диапазонов ──────────────────────────────────────────────────────────────────────────────────

test('REQ-019 FP-17: все значения по умолчанию проходят check_params (диапазоны К-4) и входят в границы PARAM_SPECS', () => {
  const defaults = {};
  for (const k of PD.param_keys()) {
    if (PARAMS_NOT_EDITABLE.includes(k)) continue;
    const v = PD.vdefault(k);
    if (v !== null) defaults[k] = v;
  }
  const res = check_params(defaults);
  assert.deepEqual(res.problems, [], 'умолчания не нарушают собственные диапазоны');
  for (const [k, v] of Object.entries(defaults)) {
    const sp = PARAM_SPECS[k];
    assert.ok(sp !== undefined, k + ' есть в PARAM_SPECS');
    if (sp.kind === 'int') assert.ok(v >= sp.min && v <= sp.max, `${k}=${v} в границах ввода [${sp.min}; ${sp.max}]`);
    if (sp.kind === 'enum') assert.ok(sp.values.includes(v), `${k}=${v} из перечисления`);
  }
});

test('REQ-019 FP-17: наборы ключей согласованы — параметры словаря (кроме kdf.*) = PARAM_SPECS = PARAM_RANGES; kdf.* зарезервированы и не редактируются', () => {
  const vocab_keys = Object.keys(vocab.params).filter((k) => !k.startsWith('kdf.')).sort();
  assert.deepEqual(Object.keys(PARAM_SPECS).sort(), vocab_keys, 'PARAM_SPECS (ввод) ↔ словарь');
  assert.deepEqual(Object.keys(PARAM_RANGES).sort(), vocab_keys, 'PARAM_RANGES (проверка файла) ↔ словарь');
  assert.deepEqual([...PARAMS_NOT_EDITABLE], ['kdf.iterations', 'kdf.wrap']);
  for (const k of PARAMS_NOT_EDITABLE) assert.equal(PD.vdefault(k), null, k + ' — без значения');
  // допустимость «не задан» у PARAM_RANGES и PARAM_SPECS одна и та же
  for (const k of vocab_keys) assert.equal(PARAM_RANGES[k].nullable === true, PARAM_SPECS[k].nullable === true, k + ': nullable');
});
