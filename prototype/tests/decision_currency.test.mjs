// decision_currency.test.mjs — FP-29, ALG-08 A08.7: «Валюта решения» в «Настройках» поверх set_param decision_currency (demo/decision_currency.mjs).
// Движок читает валюту решения из поля рабочей области раньше параметра (normalize_ws), поэтому одного set_param мало: правка set_decision_currency пишет и параметр (через set_param),
// и поле — пересчёт идёт в выбранной валюте. Нет курса пары — E_NO_RATE с парой (текст с путём к вводу курса — banner_texts.no_rate_text), данные не меняются.
// Экран «Настройки»: import_v11_boot.test.mjs. Расчёт по введённым данным и правилам, не консультация.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/decision_currency.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as D from '../demo/decision_currency.mjs';
import { apply_edit, register_edit, list_edit_types, decision_currency_of } from '../demo/ws_edit.mjs';
import { diff_unit, apply_unit, REASON_KINDS } from '../demo/undo.mjs';
import { ws_to_journal, journal_to_ws } from '../demo/ws_bridge.mjs';
import { no_rate_text } from '../demo/banner_texts.mjs';
import { analyze } from '../engine/index.mjs';
import { validate_ws } from '../engine/validate_ws.mjs';
import ratechip from '../demo/i18n/ratechip.mjs';
import forms_catalog from '../demo/i18n/forms.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const read_json = (p) => JSON.parse(fs.readFileSync(path.join(PROTO, p), 'utf8'));
if (!list_edit_types().includes('set_decision_currency')) register_edit('set_decision_currency', D.edit_set_decision_currency);

function deep_freeze(x) {
  if (x === null || typeof x !== 'object' || Object.isFrozen(x)) return x;
  for (const k of Object.keys(x)) deep_freeze(x[k]);
  return Object.freeze(x);
}

const G0 = read_json('data/g001.json');
const acc = (account_id, currency, liquidity = 'operating') => ({ account_id, name: account_id, kind: 'bank', liquidity, currency, exponent: 2, liquidity_bp: 0 });
const RATE = { fx_id: 'fx1', date: '2026-10-01', base: 'USD', quote: 'EUR', num: 9200, den: 10000, source: 'manual' };
/** G-001 без резервов (они заведены в евро: пока они такие, расчёт в другой валюте не строится), со счётом в долларах и курсом USD → EUR. */
const NO_RESERVES = { ...G0, reserves: [], allocations: [], tax_rules: [] };
const W = deep_freeze({ ...NO_RESERVES, accounts: [...G0.accounts, acc('acc_usd', 'USD', 'savings')], rates: [RATE] });
const mk = (ws) => ({ ws, cur: decision_currency_of(ws) });
const plan = (ws, v) => D.plan_decision_edit(mk(ws), v);

test('A08.7 причина правки: set_param decision_currency пишет только параметр, а движок читает поле рабочей области — расчёт не меняется; set_decision_currency меняет и то, и другое', () => {
  const only_param = apply_edit(W, { type: 'set_param', key: 'decision_currency', value: 'USD' }, {});
  assert.ok(only_param.ok);
  assert.equal(only_param.ws.params.decision_currency, 'USD');
  assert.equal(analyze(only_param.ws, { as_of: W.as_of }).decision_currency, 'EUR', 'воспроизведение: при заполненном поле рабочей области параметр расчёт не замечает');
  const r = apply_edit(W, { type: 'set_decision_currency', value: 'USD' }, {});
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.equal(r.ws.decision_currency, 'USD');
  assert.equal(r.ws.params.decision_currency, 'USD');
  assert.equal(decision_currency_of(r.ws), 'USD');
  const a = analyze(r.ws, { as_of: r.ws.as_of });
  assert.equal(a.decision_currency, 'USD', 'пересчёт идёт в выбранной валюте');
  assert.equal(validate_ws(r.ws).ok, true, JSON.stringify(validate_ws(r.ws).errors));
  assert.equal(W.decision_currency, 'EUR', 'исходная рабочая область (заморожена) не изменилась');
});

test('A08.7 рабочая область без поля decision_currency: правка добавляет поле, параметр и поле согласованы', () => {
  const { decision_currency: _gone, ...no_field } = W;
  const r = apply_edit(no_field, { type: 'set_decision_currency', value: 'USD' }, {});
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.equal(r.ws.decision_currency, 'USD');
  assert.equal(analyze(r.ws, { as_of: r.ws.as_of }).decision_currency, 'USD');
});

test('A08.7 числа в выбранной валюте: остаток EUR пересчитан в USD по обратному курсу (ровно один шаг округления), даты и число событий те же', () => {
  const eur = analyze(W, { as_of: W.as_of });
  const usd = analyze(apply_edit(W, { type: 'set_decision_currency', value: 'USD' }, {}).ws, { as_of: W.as_of });
  assert.equal(usd.series.plan.close.length, eur.series.plan.close.length, 'тот же горизонт');
  assert.equal(usd.series.plan.close[0], Math.round(eur.series.plan.close[0] * 10000 / 9200), 'остаток на сегодня: евро × 10000/9200');
  assert.ok(usd.series.plan.close.every((v, i) => Math.abs(v - eur.series.plan.close[i] * 10000 / 9200) <= 40), 'ряд сходится с пересчётом курсом в пределах округления событий');
  assert.equal(usd.buffer_minor, eur.buffer_minor, 'буфер — число в валюте решения и не пересчитывается: об этом сказано на экране');
});

test('A08.7 варианты и курсы: валюты счетов и курсов; пары «валюта счёта → кандидат» с курсом и признаком обратной пары; без курса — rate: null', () => {
  assert.deepEqual(D.decision_options(W), ['EUR', 'USD']);
  assert.deepEqual(D.decision_options({ ...W, rates: [...W.rates, { ...RATE, fx_id: 'f2', base: 'GBP', quote: 'EUR' }, { ...RATE, fx_id: 'f3', base: 'XXX', quote: 'EUR' }] }), ['EUR', 'GBP', 'USD'], 'неизвестный код валюты в варианты не попадает');
  assert.deepEqual(D.decision_options({}), []);
  assert.deepEqual(D.candidate_pairs(W, 'EUR'), [{ from: 'USD', to: 'EUR', rate: { num: 9200, den: 10000, date: '2026-10-01', inverse: false } }]);
  assert.deepEqual(D.candidate_pairs(W, 'USD'), [{ from: 'EUR', to: 'USD', rate: { num: 10000, den: 9200, date: '2026-10-01', inverse: true } }]);
  assert.deepEqual(D.candidate_pairs({ ...W, rates: [] }, 'USD'), [{ from: 'EUR', to: 'USD', rate: null }]);
  assert.deepEqual(D.candidate_pairs({ ...W, accounts: [acc('a', 'EUR')] }, 'EUR'), [], 'все счета в этой валюте: курсы не нужны');
  const dm = D.decision_model(mk(W));
  assert.deepEqual([dm.current, dm.options], ['EUR', ['EUR', 'USD']]);
  assert.deepEqual([dm.buffer_minor, dm.threshold_minor], [50000, 3000]);
  assert.deepEqual(D.decision_model(mk({ ...W, params: {} })).buffer_minor, null);
});

test('A08.7 план правки формы: та же валюта — без правок; не из списка — bad_currency; без курса — refused/E_NO_RATE с парой; с курсом — одна правка', () => {
  assert.deepEqual(plan(W, 'EUR'), { ok: true, edits: [] });
  assert.deepEqual(plan(W, 'JPY'), { ok: false, reason: 'bad_currency', edits: [] });
  assert.deepEqual(plan(W, 5), { ok: false, reason: 'bad_currency', edits: [] });
  assert.deepEqual(plan(W, undefined), { ok: false, reason: 'bad_currency', edits: [] });
  assert.deepEqual(plan(W, 'USD'), { ok: true, edits: [{ type: 'set_decision_currency', value: 'USD' }] });
  const norate = plan({ ...W, rates: [] }, 'USD');
  assert.deepEqual([norate.ok, norate.reason], [false, 'refused'], 'без курсов вариант USD остаётся (есть счёт в USD), но расчёт в нём не строится: отказ с причиной');
});

test('A08.2 нет курса — отказ E_NO_RATE с парой и понятным текстом (пара и путь «Формы данных → Курсы и обмен»); данные не меняются', () => {
  const ws = deep_freeze({ ...W, rates: [] });
  const p = plan(ws, 'USD');
  assert.equal(p.ok, false);
  assert.equal(p.reason, 'refused');
  assert.equal(p.error.code, 'E_NO_RATE');
  assert.equal(p.error.ctx.pair, 'EUR/USD');
  // та же правка напрямую
  const r = apply_edit(ws, { type: 'set_decision_currency', value: 'USD' }, { deep: true });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_NO_RATE');
  // текст сообщения — из каталога FP-16: называет пару и место ввода курса
  const flat = { ...forms_catalog.ru, ...ratechip.ru };
  const tr = (k, params = {}) => String(flat[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => String(params[n]));
  const text = no_rate_text(tr, p.error.ctx);
  assert.match(text, /Нет курса EUR → USD/);
  assert.match(text, /Формы данных/);
  assert.match(text, /Курсы и обмен/);
  assert.equal(ws.decision_currency, 'EUR');
});

test('A08.7 резерв в прежней валюте мешает смене: отказ E_CURRENCY_MISMATCH (reserve_not_in_decision_currency) до записи', () => {
  const withres = deep_freeze({ ...G0, accounts: [...G0.accounts, acc('acc_usd', 'USD', 'savings')], rates: [RATE] });
  const p = plan(withres, 'USD');
  assert.equal(p.ok, false);
  assert.equal(p.reason, 'refused');
  assert.equal(p.error.code, 'E_CURRENCY_MISMATCH');
  assert.equal(p.error.ctx.reason, 'reserve_not_in_decision_currency');
});

test('A08.7 проверки самой правки: чужие поля, не строка, неизвестная валюта (как у set_param) — E_SCHEMA; журнал не нужен для проверки', () => {
  const bad = (edit) => apply_edit(W, edit, {});
  assert.equal(bad({ type: 'set_decision_currency', value: 'ZZZ' }).error.code, 'E_SCHEMA');
  assert.equal(bad({ type: 'set_decision_currency', value: 5 }).error.ctx.reason, 'not_string');
  assert.equal(bad({ type: 'set_decision_currency', value: 'USD', key: 'x' }).error.ctx.reason, 'unknown_field');
  assert.equal(bad({ type: 'set_decision_currency' }).error.code, 'E_SCHEMA');
  assert.equal(bad({ type: 'set_decision_currency', value: null }).error.code, 'E_SCHEMA');
  assert.equal(bad({ type: 'set_decision_currency', value: 'usd' }).ok, false, 'код в верхнем регистре');
});

test('A08.7 «Отменить»: правка относится к виду «настройки»; разность охватывает параметр и поле рабочей области; применение отката возвращает исходное', () => {
  assert.equal(REASON_KINDS.set_decision_currency, 'settings');
  const after = apply_edit(W, { type: 'set_decision_currency', value: 'USD' }, {}).ws;
  const unit = diff_unit(W, after, { kind: 'settings' });
  assert.deepEqual(unit.changes.map((c) => [c.bucket, c.key]).sort(), [['meta', 'decision_currency'], ['params', 'decision_currency']]);
  const undone = apply_unit(after, unit, 'undo');
  assert.ok(undone.ok, JSON.stringify(undone.error));
  assert.equal(undone.ws.decision_currency, 'EUR');
  assert.equal(undone.ws.params.decision_currency, undefined, 'ключа параметра не было — его нет');
  assert.deepEqual(undone.ws, JSON.parse(JSON.stringify(W)));
});

test('A08.7 журнал: валюта решения переживает круг «рабочая область → файл-копия → рабочая область» и в поле, и в параметре; расчёт после перезагрузки в USD', () => {
  const after = apply_edit(W, { type: 'set_decision_currency', value: 'USD' }, {}).ws;
  const back = journal_to_ws(ws_to_journal(after));
  assert.equal(back.decision_currency, 'USD');
  assert.equal(back.params.decision_currency, 'USD');
  assert.equal(analyze(back, { as_of: back.as_of }).decision_currency, 'USD');
  assert.equal(analyze(back, { as_of: back.as_of }).inputs_hash, analyze(after, { as_of: after.as_of }).inputs_hash, 'те же входные данные');
});
