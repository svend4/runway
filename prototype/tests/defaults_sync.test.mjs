// defaults_sync.test.mjs — REQ-019 (TST-56): значения по умолчанию — данные, а не разъехавшиеся литералы. Зеркала в коде (TIMELINE_DEFAULTS,
// CALIBRATION_DEFAULTS, BACKTEST_DEFAULTS и литералы-запасные в index/fx/tools) сверяются с engine/vocab.json; сам vocab.json — с таблицей
// REQ-019 из требований (независимый оракул: числа переписаны из текста требования, а не из кода). Поведение на границах считается от значения
// из vocab.json, а не от «магического числа» в тесте: сменили умолчание в словаре — код обязан следовать (или тест называет расхождение).
// Новый параметр со значением по умолчанию в vocab.json без зеркала и без записи в ожидаемых списках — красный тест: «три определения одного числа».
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { analyze } from '../engine/index.mjs';
import { TIMELINE_DEFAULTS, flat_params, get_param } from '../engine/timeline.mjs';
import { CALIBRATION_DEFAULTS, stale_status } from '../engine/calibration.mjs';
import { BACKTEST_DEFAULTS } from '../engine/backtest.mjs';
import { rate_status } from '../engine/fx.mjs';
import { make_tool_ctx, run_tool } from '../engine/tools.mjs';
import { NUMBER_FORMATS } from '../engine/money.mjs';
import { parse_date, format_date } from '../engine/dates.mjs';

const ENGINE = new URL('../engine/', import.meta.url);
const vocab = JSON.parse(fs.readFileSync(new URL('vocab.json', ENGINE), 'utf8'));
const G = JSON.parse(fs.readFileSync(new URL('../data/g001.json', import.meta.url), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const dflt = (key) => vocab.params[key].default;

/** Таблица REQ-019 (02-requirements.md, «Критерий приёмки»): ключ → значение; пометка «гипотеза» (C-096, C-055) — у последних пяти. */
const REQ019_TABLE = {
  horizon_days: 180, buffer_hint_days: 7, 'worse.income_delay_days': 14, 'match.window_days': 3, 'match.tol_bp': 500, 'wave.gap_days': 3,
  'wave.max_span_days': 10, 'stale.banner_days': 7, 'stale.block_days': 21, 'backup.remind_events': 50, 'backup.remind_days': 7, 'fx.stale_days': 30,
  'backtest.h_days': 30, 'backtest.min_window_days': 14,
};

test('REQ-019 TST-56 vocab.json содержит все значения таблицы REQ-019; последние пять — гипотезы; зарезервированные kdf.iterations/kdf.wrap без значений (C-081)', () => {
  for (const [k, v] of Object.entries(REQ019_TABLE)) {
    assert.ok(Object.hasOwn(vocab.params, k), 'нет параметра ' + k);
    assert.equal(dflt(k), v, k);
  }
  for (const k of ['backup.remind_events', 'backup.remind_days', 'fx.stale_days', 'backtest.h_days', 'backtest.min_window_days']) assert.equal(vocab.params[k].hypothesis, true, k + ' — гипотеза');
  assert.equal(dflt('kdf.iterations'), null);
  assert.equal(dflt('kdf.wrap'), null);
  assert.deepEqual(vocab.number_formats, JSON.parse(JSON.stringify(NUMBER_FORMATS)), 'форматы чисел совпадают с money.NUMBER_FORMATS');
});

test('REQ-019 TIMELINE_DEFAULTS ↔ vocab.json: каждый ключ зеркала есть в словаре с тем же значением; плоская таблица flat_params без параметров даёт то же', () => {
  for (const [k, v] of Object.entries(TIMELINE_DEFAULTS)) {
    assert.ok(Object.hasOwn(vocab.params, k), `${k}: нет в vocab.json`);
    assert.deepEqual(vocab.params[k].default, v, `${k}: код ${JSON.stringify(v)} ≠ словарь ${JSON.stringify(vocab.params[k].default)}`);
  }
  assert.deepEqual(flat_params(undefined), { ...TIMELINE_DEFAULTS });
  assert.deepEqual(flat_params({}), { ...TIMELINE_DEFAULTS });
  for (const k of Object.keys(TIMELINE_DEFAULTS)) assert.deepEqual(get_param(undefined, k), dflt(k), k);
  assert.equal(get_param({}, 'buffer_minor'), null, 'буфер по умолчанию не задан (null), как в словаре');
});

test('REQ-019 CALIBRATION_DEFAULTS и BACKTEST_DEFAULTS ↔ vocab.json (match.*, grace_days.*, stale.*, calib.*, backtest.*)', () => {
  for (const [name, table] of [['CALIBRATION_DEFAULTS', CALIBRATION_DEFAULTS], ['BACKTEST_DEFAULTS', BACKTEST_DEFAULTS]]) {
    for (const [k, v] of Object.entries(table)) {
      assert.ok(Object.hasOwn(vocab.params, k), `${name}.${k}: нет в vocab.json`);
      assert.deepEqual(vocab.params[k].default, v, `${name}.${k}`);
    }
  }
  // зеркала между собой не расходятся (match.window_days, grace_days, stale.* лежат и в timeline, и в calibration)
  for (const [k, v] of Object.entries(CALIBRATION_DEFAULTS)) if (Object.hasOwn(TIMELINE_DEFAULTS, k)) assert.equal(TIMELINE_DEFAULTS[k], v, k);
  for (const [k, v] of Object.entries(BACKTEST_DEFAULTS)) if (Object.hasOwn(TIMELINE_DEFAULTS, k)) assert.equal(TIMELINE_DEFAULTS[k], v, k);
});

test('REQ-019 «три определения одного числа»: каждый параметр vocab.json со значением по умолчанию имеет зеркало в коде или назван вне движка (интерфейс, v2, документ)', () => {
  const mirrored = new Set([...Object.keys(TIMELINE_DEFAULTS), ...Object.keys(CALIBRATION_DEFAULTS), ...Object.keys(BACKTEST_DEFAULTS)]);
  // зеркала, чьё значение проверяется поведением ниже (литерал-запасной в коде): fx.stale_days (index.mjs, fx.rate_status), tools.max_calls (tools.mjs)
  const by_behavior = new Set(['fx.stale_days', 'tools.max_calls']);
  // параметры вне движка: напоминание о копии (интерфейс), допуск дрейфа долга (v2: проверяет вызывающий), число путей (задаёт вызывающий run_paths)
  const outside_engine = new Set(['backup.remind_events', 'backup.remind_days', 'debt.drift_tol_bp', 'mc.n_paths']);
  const unaccounted = Object.entries(vocab.params)
    .filter(([k, p]) => p.default !== null && !mirrored.has(k) && !by_behavior.has(k) && !outside_engine.has(k))
    .map(([k]) => k);
  assert.deepEqual(unaccounted, [], 'параметры без зеркала и без пояснения: ' + unaccounted.join(', '));
  // и наоборот: имя в списках «вне движка» не должно быть фантомом
  for (const k of [...by_behavior, ...outside_engine]) assert.ok(Object.hasOwn(vocab.params, k), k);
  assert.equal(dflt('tools.max_calls'), 12);
  assert.equal(dflt('mc.n_paths'), 2000);
});

test('REQ-019 fx.stale_days: граница W_RATE_STALE и fx.rate_status по умолчанию берутся из vocab.json (возраст ровно stale_days — ещё не устарел, +1 день — устарел)', () => {
  const days = dflt('fx.stale_days');
  const usd = { account_id: 'usd', name: 'USD', kind: 'bank', liquidity: 'operating', currency: 'USD', exponent: 2, opened_on: '2026-01-01' };
  const run = (age) => {
    const ws = clone(G);
    ws.accounts.push(usd);
    ws.anchors.push({ anchor_id: 'a-usd', account_id: 'usd', date: ws.as_of, amount_minor: 0 });
    ws.rates = [{ fx_id: 'r1', date: format_date(parse_date(ws.as_of) - age), base: 'USD', quote: 'EUR', num: 92, den: 100 }];
    return analyze(ws, { as_of: ws.as_of }).warnings.some((w) => w.code === 'W_RATE_STALE');
  };
  assert.equal(run(days), false, `возраст ${days} дн. — не устарел`);
  assert.equal(run(days + 1), true, `возраст ${days + 1} дн. — устарел`);
  assert.deepEqual(rate_status({ date: 100 }, 100 + days).stale, false);
  assert.deepEqual(rate_status({ date: 100 }, 100 + days + 1).stale, true);
});

test('REQ-019 stale.banner_days / stale.block_days: граница плашки и блока по умолчанию берётся из vocab.json (TST-57: 7/8 и 21/22 не меняются)', () => {
  const banner = dflt('stale.banner_days');
  const block = dflt('stale.block_days');
  assert.equal(stale_status(banner, null).level, 'fresh');
  assert.equal(stale_status(banner + 1, null).level, 'banner');
  assert.equal(stale_status(block, null).level, 'banner');
  assert.equal(stale_status(block + 1, null).level, 'block');
  assert.deepEqual([banner, block], [7, 21]);
});

test('REQ-019 tools.max_calls: предел вызовов на вопрос по умолчанию — значение vocab.json (12-й вызов проходит, 13-й — E_CALL_LIMIT)', () => {
  const max = dflt('tools.max_calls');
  const ctx = make_tool_ctx(G, { as_of: G.as_of });
  ctx.params = Object.fromEntries(Object.entries(ctx.params).filter(([k]) => k !== 'tools.max_calls'));
  ctx.calls_used = max - 1;
  assert.notEqual(run_tool('get_tax_envelope', {}, ctx).code, 'E_CALL_LIMIT');
  ctx.calls_used = max;
  assert.equal(run_tool('get_tax_envelope', {}, ctx).code, 'E_CALL_LIMIT');
});

test('REQ-019 horizon_days / worse.income_delay_days / headline_mode / rounding без параметров в рабочей области работают как в vocab.json (analyze на данных без params)', () => {
  const ws = clone(G);
  delete ws.params;
  const a = analyze(ws, { as_of: ws.as_of });
  assert.equal(a.horizon_end - parse_date(ws.as_of), dflt('horizon_days'));
  assert.equal(a.params['worse.income_delay_days'], dflt('worse.income_delay_days'));
  assert.equal(a.params.rounding, dflt('rounding'));
  assert.equal(a.params['grace_days.income'], dflt('grace_days.income'));
  assert.equal(a.params['match.window_days'], dflt('match.window_days'));
  assert.equal(a.params.buffer_minor ?? null, dflt('buffer_minor'));
});

test('REQ-019 FP-17: engine/vocab.generated.mjs актуален — значения по умолчанию, которые читает код (vdefault), равны vocab.json; зеркала собраны из сгенерированного модуля', async () => {
  const { VOCAB_PARAMS } = await import('../engine/vocab.generated.mjs');
  const { vdefault, param_keys } = await import('../engine/param_defaults.mjs');
  assert.deepEqual(param_keys(), Object.keys(vocab.params), 'те же параметры в том же порядке');
  for (const [k, p] of Object.entries(vocab.params)) {
    assert.deepEqual(JSON.parse(JSON.stringify(VOCAB_PARAMS[k])), p, k + ': запись словаря');
    assert.equal(vdefault(k), p.default, k);
  }
  const { is_fresh } = await import('../tools/gen_vocab.mjs');
  assert.equal(is_fresh(), true, 'сгенерированный файл устарел: node tools/gen_vocab.mjs');
});
