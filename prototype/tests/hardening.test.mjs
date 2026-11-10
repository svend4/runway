// hardening.test.mjs — FP-02: закрытие P0-хвостов движка и устойчивость к чужому файлу (quality-backlog Q-01…Q-21, Q-29; findings П-17…П-29).
// Покрывает: TST-27 (одиночная нога перевода, нулевой остаток в чужой валюте), TST-45/TST-46 (знак, символы Cf, ссылочная разметка, числа словами),
// TST-51 (строгий разбор групп тысяч), TST-43 (id-колонки CSV), TST-32 (хэш после отката партии, REQ-093), TST-23 (даты взносов, обрезка резерва),
// REQ-014 (факты отдельно от сценариев), REQ-016 (журнал v1 и апкастер), REQ-055 и REQ-068 (запреты в шаблонах и данных), REQ-069 (числа W_RESERVE_BEHIND).
// Ожидания выведены из канона (design-brief, ALG-05/12/14) и независимых оракулов, а не из вывода движка. В тестах допустимы node:fs и Date.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

import { analyze } from '../engine/index.mjs';
import { extract_quantities, verify_text, verify_answer, templates, render_answer, fallback_answer } from '../engine/verifier.mjs';
import { make_tool_ctx, run_tool, build_echo } from '../engine/tools.mjs';
import * as IO from '../engine/io.mjs';
import * as L from '../engine/ledger.mjs';
import * as S from '../engine/sinking.mjs';
import * as R from '../engine/recurrence.mjs';
import * as FX from '../engine/fx.mjs';
import { parse_minor, format_minor } from '../engine/money.mjs';
import { make_calendar, days_from_civil, civil_from_days, format_date, parse_date } from '../engine/dates.mjs';
import { TIMELINE_DEFAULTS } from '../engine/timeline.mjs';
import { EXT_WARNING_CODES, ext_warning_text, is_ext_warning, split_warnings } from '../engine/warnings_ext.mjs';
import { make_rng, throws_code } from './helpers.mjs';
import { fuzz_progress } from './fuzz_progress.mjs'; // FP-24: ход длинного цикла для tools/fuzz_nightly.mjs (без переменной RUNWAY_FUZZ_PROGRESS ничего не делает)

const DATA = new URL('../data/', import.meta.url);
const load = (name) => JSON.parse(fs.readFileSync(new URL(name, DATA), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const G = load('g001.json');
const FIXTURES = new URL('./fixtures/', import.meta.url);
const GP_FUZZ = Number(process.env.FUZZ_N ?? process.env.HARDEN_FUZZ_N ?? 0) || 0;

const money = (v, cur = 'EUR') => ({ id: 'e1', kind: 'money', v, cur });
const codes = (vs) => vs.map((v) => v.code);
const code_of = (fn) => { try { fn(); return null; } catch (e) { if (e?.name === 'RunwayError') return e.code; throw e; } };

/** Рабочая область G-001 с добавленными плановыми записями и счетами (копия). */
function ws_with({ plans = [], accounts = [], extra = {} } = {}) {
  const ws = clone(G);
  ws.plans = [...(ws.plans ?? []), ...plans];
  ws.accounts = [...ws.accounts, ...accounts];
  return Object.assign(ws, extra);
}
const leg = (id, account_id, amount_minor, transfer_id, date = '2026-10-20') => ({ plan_id: id, account_id, currency: 'EUR', date, amount_minor, kind: 'transfer', transfer_id });
const SAV = { account_id: 'acc_sav', name: 'Накопительный', kind: 'bank', liquidity: 'savings', currency: 'EUR', exponent: 2, opened_on: '2026-01-01' };
const OP2 = { account_id: 'acc_two', name: 'Второй', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2, opened_on: '2026-01-01' };
const plan_ids = (a) => a.events.plan.map((e) => e.cash_event_id).sort();

// ═══ TST-27 · Q-01: одиночная нога перевода ════════════════════════════════════════════════════════════════════════════

test('TST-27 Q-01 одиночная нога перевода НЕ пропадает молча: расход остаётся в events.plan, служебное предупреждение W_TRANSFER_UNPAIRED с transfer_id', () => {
  const ws = ws_with({ plans: [leg('t-out', 'acc_main', -100000, 'T1')] });
  const a = analyze(ws, { as_of: ws.as_of });
  const e = a.events.plan.find((x) => x.cash_event_id === 't-out');
  assert.ok(e !== undefined, 'нога учтена');
  assert.equal(e.amount_minor, -100000);
  assert.ok(a.warnings.some((w) => w.code === 'W_TRANSFER_UNPAIRED' && w.transfer_id === 'T1'), JSON.stringify(a.warnings));
  const base = analyze(G, { as_of: G.as_of });
  assert.equal(a.series.plan.trough.at(-1) - base.series.plan.trough.at(-1), -100000, 'расход вошёл в ряд');
});

test('TST-27 Q-01 пара operating + operating по-прежнему внутренний перевод: обе ноги исключены, предупреждения нет', () => {
  const ws = ws_with({ accounts: [OP2], plans: [leg('t-out', 'acc_main', -100000, 'T1'), leg('t-in', 'acc_two', 100000, 'T1')] });
  const a = analyze(ws, { as_of: ws.as_of });
  assert.ok(!plan_ids(a).includes('t-out') && !plan_ids(a).includes('t-in'));
  assert.ok(!a.warnings.some((w) => w.code === 'W_TRANSFER_UNPAIRED'));
  const base = analyze(G, { as_of: G.as_of });
  assert.deepEqual(a.series.plan.close.slice(0, base.series.plan.close.length), base.series.plan.close, 'ряд как без перевода');
});

test('TST-27 Q-01 три ноги одного transfer_id на operating-счетах — прежнее поведение (все исключены), одиночной ноги нет; нога на savings + одиночная — обе считаются расходом', () => {
  const three = ws_with({ accounts: [OP2], plans: [leg('a', 'acc_main', -100000, 'T3'), leg('b', 'acc_two', 60000, 'T3'), leg('c', 'acc_two', 40000, 'T3')] });
  const a3 = analyze(three, { as_of: three.as_of });
  assert.ok(!plan_ids(a3).some((id) => ['a', 'b', 'c'].includes(id)));
  assert.ok(!a3.warnings.some((w) => w.code === 'W_TRANSFER_UNPAIRED'));
  const mix = ws_with({ accounts: [SAV], plans: [leg('s-out', 'acc_main', -50000, 'T2'), leg('s-in', 'acc_sav', 50000, 'T2'), leg('u-out', 'acc_main', -70000, 'T9', '2026-10-21')] });
  const am = analyze(mix, { as_of: mix.as_of });
  assert.ok(plan_ids(am).includes('s-out') && plan_ids(am).includes('u-out'), 'перевод на накопительный и одиночная нога — расходы');
  assert.deepEqual(am.warnings.filter((w) => w.code === 'W_TRANSFER_UNPAIRED'), [{ code: 'W_TRANSFER_UNPAIRED', transfer_id: 'T9' }]);
});

test('TST-27 Q-01 предупреждение детерминировано: порядок записей и ключей не меняет ни warnings, ни inputs_hash; несколько одиночных ног — по возрастанию id', () => {
  const plans = [leg('x1', 'acc_main', -1000, 'T-b'), leg('x2', 'acc_main', -2000, 'T-a', '2026-10-21'), leg('x3', 'acc_main', -3000, 'T-c', '2026-10-22')];
  const w1 = ws_with({ plans });
  const w2 = ws_with({ plans: [...plans].reverse() });
  const a1 = analyze(w1, { as_of: w1.as_of });
  const a2 = analyze(w2, { as_of: w2.as_of });
  assert.deepEqual(a1.warnings, a2.warnings);
  assert.equal(a1.inputs_hash, a2.inputs_hash);
  assert.deepEqual(a1.warnings.filter((w) => w.code === 'W_TRANSFER_UNPAIRED').map((w) => w.transfer_id), ['T-a', 'T-b', 'T-c']);
});

test('TST-27 Q-01 golden G-001: на эталонных наборах предупреждения W_TRANSFER_UNPAIRED нет, числа не меняются (ряды совпадают с независимым пересчётом opening)', () => {
  for (const name of ['g001.json', 'g001-low.json', 'g001-gap.json', 'g001-late.json']) {
    const ws = load(name);
    const a = analyze(ws, { as_of: ws.as_of });
    assert.ok(!a.warnings.some((w) => w.code === 'W_TRANSFER_UNPAIRED'), name);
  }
  const a = analyze(G, { as_of: G.as_of });
  assert.equal(a.series.plan.opening_minor, 400000, 'G-001 §9.4: остаток на 2026-10-04');
});

test('служебные предупреждения живут вне vocab.json: реестр warnings_ext (RU/EN), is_ext_warning, split_warnings; неизвестный код — null, не исключение', () => {
  const vocab = JSON.parse(fs.readFileSync(new URL('../engine/vocab.json', import.meta.url), 'utf8'));
  for (const [code, e] of Object.entries(EXT_WARNING_CODES)) {
    assert.match(code, new RegExp(vocab.warning_pattern));
    assert.ok(!Object.hasOwn(vocab.warning_codes, code), code + ' не должен дублировать реестр vocab.json (К-39: реестр закрыт)');
    assert.ok(e.ru.length > 0 && e.en.length > 0 && Array.isArray(e.fields));
    assert.equal(ext_warning_text({ code }, 'ru'), e.ru);
    assert.equal(ext_warning_text(code, 'en'), e.en);
  }
  assert.equal(ext_warning_text('W_NO_SUCH'), null);
  assert.equal(ext_warning_text(null), null);
  assert.equal(is_ext_warning({ code: 'toString' }), false);
  assert.deepEqual(split_warnings([{ code: 'W_BUFFER_UNSET' }, { code: 'W_TRANSFER_UNPAIRED', transfer_id: 'T' }]), { registry: [{ code: 'W_BUFFER_UNSET' }], ext: [{ code: 'W_TRANSFER_UNPAIRED', transfer_id: 'T' }] });
});

// ═══ TST-27 · Q-16: нулевой остаток в чужой валюте ═════════════════════════════════════════════════════════════════════

test('TST-27 Q-16 явный нулевой остаток operating-счёта в USD курса не требует; ненулевой без курса — E_NO_RATE; нулевой при fx_shock — 0', () => {
  const usd = { account_id: 'usd', name: 'USD', kind: 'bank', liquidity: 'operating', currency: 'USD', exponent: 2, opened_on: '2026-01-01' };
  const zero = ws_with({ accounts: [usd], extra: { anchors: [...G.anchors, { anchor_id: 'a-usd', account_id: 'usd', date: '2026-10-04', amount_minor: 0 }] } });
  const a = analyze(zero, { as_of: zero.as_of });
  assert.equal(a.series.plan.opening_minor, analyze(G, { as_of: G.as_of }).series.plan.opening_minor);
  const shock = analyze(zero, { as_of: zero.as_of, scenario: { scenario_id: 's', ops: [{ op: 'fx_shock', currency: 'USD', bp: -500 }] } });
  assert.equal(shock.series.plan.opening_minor, a.series.plan.opening_minor, 'нуль при сдвиге курса — нуль (и курса всё ещё нет)');
  const nonzero = ws_with({ accounts: [usd], extra: { anchors: [...G.anchors, { anchor_id: 'a-usd', account_id: 'usd', date: '2026-10-04', amount_minor: 100 }] } });
  assert.equal(code_of(() => analyze(nonzero, { as_of: nonzero.as_of })), 'E_NO_RATE');
  const accts = [{ account_id: 'a', liquidity: 'operating', currency: 'EUR' }, { account_id: 'u', liquidity: 'operating', currency: 'USD' }];
  const ctx = { rates: [], decision_currency: 'EUR', policy: 'spot' };
  assert.equal(FX.opening_in_decision(accts, new Map([['a', 500], ['u', 0]]), ctx, '2026-10-04'), 500);
  assert.equal(code_of(() => FX.opening_in_decision(accts, new Map([['a', 500], ['u', 1]]), ctx, '2026-10-04')), 'E_NO_RATE');
  assert.equal(code_of(() => FX.opening_in_decision(accts, new Map([['a', 500]]), ctx, '2026-10-04')), 'E_NO_RATE', 'остаток не задан вовсе — по-прежнему сигнал неполных данных');
});

// ═══ TST-45 · Q-02: знак числа ═════════════════════════════════════════════════════════════════════════════════════════

const MINUS_GLYPHS = ['‐', '‑', '‒', '—', '―', '⁻', '₋', '﹘', '﹣', '－', '➖'];

test('TST-45 Q-02 любой глиф минуса вместо «−» не даёт «ok при другом знаке»: при evidence +47000 всегда нарушение; при −47000 — нарушение или тот же вердикт', () => {
  for (const g of MINUS_GLYPHS) {
    for (const tpl of ['остаток {g}470,00 €', '{g}470,00 €', 'EUR {g}470,00', '€{g}470,00', '{g}€470,00', 'около {g}470 €']) {
      const s = tpl.replaceAll('{g}', g);
      assert.notDeepEqual(verify_text(s, [money(47000)], 'ru'), [], JSON.stringify(s) + ' | +47000');
      // при −47000 допустимо и принять (глиф — минус), и отвергнуть; недопустимо лишь принять при противоположном знаке — проверено выше
      const neg = verify_text(s, [money(-47000)], 'ru');
      assert.ok(Array.isArray(neg));
    }
  }
  // контроли: прежние знаки и обычный текст не изменились
  assert.deepEqual(verify_text('−470,00 €', [money(-47000)], 'ru'), []);
  assert.deepEqual(verify_text('-470,00 €', [money(-47000)], 'ru'), []);
  assert.deepEqual(verify_text('– 470,00 €', [money(47000)], 'ru'), [], '«–» через пробел — тире, не знак (прежнее поведение)');
});

test('TST-45 Q-02 «− 470,00 €» (U+2212 с пробелом) — тот же минус; слова «минус»/«negative» и длинное тире вплотную — знак неясен: V_NO_MATCH при любом evidence', () => {
  assert.deepEqual(codes(verify_text('− 470,00 €', [money(47000)])), ['V_NO_MATCH']);
  assert.deepEqual(verify_text('− 470,00 €', [money(-47000)]), []);
  for (const [s, loc] of [['минус 470,00 €', 'ru'], ['в минус 470,00 €', 'ru'], ['минус €470,00', 'ru'], ['negative 470.00 €', 'en'], ['minus 470.00 €', 'en'], ['—470,00 €', 'ru']]) {
    assert.deepEqual(codes(verify_text(s, [money(47000)], loc)), ['V_NO_MATCH'], s + ' | +');
    assert.deepEqual(codes(verify_text(s, [money(-47000)], loc)), ['V_NO_MATCH'], s + ' | −');
  }
  assert.notDeepEqual(verify_text('EUR —470,00', [money(47000)], 'ru'), [], 'код валюты слева, тире вплотную: знак неясен — нарушение');
  // слово без числа рядом — неоднозначность (число не money): fail-closed
  assert.ok(extract_quantities('минус 5 дней').some((q) => q.kind === 'ambiguous'));
});

test('TST-45 Q-02 контроли без ложных тревог: даты, диапазоны, «Шаг 1 — проверьте…», длинное тире между словами, пункты списка', () => {
  for (const s of ['2026-11-14', 'с 14 ноября по 20 ноября', 'Шаг 1 — проверьте дату', 'Шаг 1 — проверьте', 'остаток — это деньги на счетах', '- проверьте дату', 'Горизонт — 14 дней'.replace('14 дней', 'ограничен')]) {
    assert.deepEqual(extract_quantities(s).filter((q) => ['ambiguous', 'markup', 'spelled'].includes(q.kind)), [], s);
  }
  assert.deepEqual(codes(verify_text('Шаг 1 — проверьте дату', [], 'ru')), []);
  assert.deepEqual(codes(verify_text('Остаток — 410,00 €', [money(41000)], 'ru')), [], 'тире с пробелами перед числом — не знак');
});

// ═══ TST-45 · Q-03: символы Cf ═════════════════════════════════════════════════════════════════════════════════════════

test('TST-45 Q-03 символы форматирования Cf (bidi, ZWSP, U+FEFF) → V_MARKUP; обычный текст, NBSP и U+202F — нет', () => {
  const cf = ['‮', '‪', '‬', '⁦', '⁩', '​', '‌', '‍', '‎', '‏', '⁠', '⁤', '﻿', '­'];
  for (const c of cf) {
    for (const s of [c + '470,00 €', '4' + c + '70,00 €', 'остаток 470,00' + c + ' €', 'текст' + c]) {
      assert.ok(codes(verify_text(s, [money(47000)], 'ru')).includes('V_MARKUP'), JSON.stringify(s));
    }
  }
  assert.deepEqual(codes(verify_text('остаток 470,00 €', [money(47000)], 'ru')), []);
  assert.deepEqual(codes(verify_text('остаток 1 470,00 €', [money(147000)], 'ru')), []);
  assert.deepEqual(codes(verify_text('Данных мало для вердикта. Ёжик, café', [], 'ru')), []);
  // ZWJ в эмодзи — осознанный компромисс (К-26): тоже отвергается
  assert.ok(codes(verify_text('семья 👨‍👩‍👧', [], 'ru')).includes('V_MARKUP'));
});

test('TST-45 Q-03 verify_answer: «\\u202e{e1}» отвергается; render_value-вывод (NBSP, U+2212) по-прежнему проходит', () => {
  const ctx = make_tool_ctx(G, { as_of: G.as_of });
  const args = { date: '2026-10-12', amount_minor: 30000, currency: 'EUR' };
  const r = run_tool('check_purchase', args, ctx);
  const echo = build_echo([{ name: 'check_purchase', args }], ctx.params, 'EUR');
  const ans = (t) => ({ claims: [{ call: r.call_id, t, refs: ['e1'], scope: { mode: 'plan', scenario_id: null } }] });
  assert.equal(verify_answer(ans('‮{e1}'), [r], { echo }).ok, false);
  assert.equal(verify_answer(ans('​{e1}'), [r], { echo }).ok, false);
  assert.equal(verify_answer(ans('Минимум {e1}.'), [r], { echo }).ok, true);
});

// ═══ TST-46 · Q-04: ссылочная разметка и URL без схемы ═════════════════════════════════════════════════════════════════

test('TST-46 Q-04 новые формы разметки → V_MARKUP: ссылка-определение, ссылочная картинка и ссылка, //host, голый домен с путём; 12 прежних атак — без изменений', () => {
  const forms = ['[r]: //evil.example/x', '  [r]: https://evil.example/x', '![a][r]', '[a][r]', '![a][]', '//evil.example/pixel.png', 'см. //cdn.evil.example/x?d=1', 'evil.example/pixel.png', 'host.example.org/a/b?c=1', 'x.test/img.gif'];
  for (const s of forms) assert.ok(codes(verify_text(s, [], 'ru')).includes('V_MARKUP'), s);
  const old = ['![](https://evil.example/?d=1)', '[нажмите](https://evil.example)', '<img src=x onerror=alert(1)>', 'https://evil.example/pixel.png', 'http://x', 'www.evil.com/x', '<a href="x">y</a>', '![a](data:image/svg+xml;base64,AAAA)', '<!-- c -->', '<http://x>', '[a](javascript:alert)', '![](//evil.example/x)'];
  for (const s of old) assert.ok(codes(verify_text(s, [], 'ru')).includes('V_MARKUP'), s);
});

test('TST-46 Q-04 без ложных тревог: сокращения, версии и обычная пунктуация не считаются разметкой; шаблоны каталога RU/EN чисты (TST-56)', () => {
  for (const s of ['г. Берлин', 'т.е. завтра', 'и/или', 'км/ч', 'e.g. a/b', 'v1.2 вышла', 'ответ: да/нет', 'до 5 дней/мес', 'Яндекс.Деньги', 'см. раздел 2.1']) {
    assert.ok(!codes(verify_text(s.replace(/\d+/g, ''), [], 'ru')).includes('V_MARKUP'), s);
  }
  for (const loc of ['ru', 'en']) {
    for (const [k, t] of Object.entries(templates(loc))) {
      const bare = t.replace(/\[\[|\]\]/g, '').replace(/\{[^{}]*\}/g, ' ');
      const bad = extract_quantities(bare, loc).filter((q) => ['markup', 'ambiguous', 'spelled'].includes(q.kind));
      assert.deepEqual(bad, [], `${loc} ${k}`);
    }
  }
  // ответы A0 на G-001 (рендер всех инструментов, обе локали) проходят верификатор целиком
  const ctx = make_tool_ctx(G, { as_of: G.as_of });
  for (const [name, args] of [['check_purchase', { date: '2026-10-12', amount_minor: 30000, currency: 'EUR' }], ['get_projection', { to: '2026-11-30' }], ['max_purchase_amount', { date: '2026-10-12' }],
    ['earliest_safe_date', { amount_minor: 30000, currency: 'EUR' }], ['list_waves', { from: '2026-10-04', to: '2026-11-30' }], ['explain_min_point', {}], ['get_tax_envelope', {}]]) {
    ctx.calls_used = 0;
    const r = run_tool(name, args, ctx);
    const echo = build_echo([{ name, args }], ctx.params, 'EUR');
    for (const loc of ['ru', 'en']) assert.equal(verify_answer(fallback_answer(r, loc), [r], { echo, locale: loc }).ok, true, `${loc} ${name}`);
  }
});

test('TST-46 Q-04 время: 100 000 знаков «[a][», «//a.», «a.a.a.», «a-», «[r]: » разбираются < 1 с (линейно, как D-05; прежние проходы «![» и «1,1,» этим тестом не мерятся)', () => {
  for (const unit of ['[a][', '//a.', 'a.a.a.', 'a-', '[r]: ']) {
    const text = unit.repeat(Math.ceil(100000 / unit.length));
    const t0 = Date.now();
    extract_quantities(text, 'ru');
    const dt = Date.now() - t0;
    assert.ok(dt < 1000, `${JSON.stringify(unit)}: ${dt} мс`);
  }
});

// ═══ TST-46 · Q-06: числа словами ══════════════════════════════════════════════════════════════════════════════════════

test('TST-46 Q-06 числительные словами без единицы → V_SPELLED: «девятьсот девяносто девять», «ninety nine», «сто двадцать», «двадцать»; идиомы и шаги — нет', () => {
  for (const s of ['остаток девятьсот девяносто девять', 'остаток nine hundred ninety nine', 'nine hundred and ninety nine', 'ninety nine', 'сто двадцать', 'двадцать', 'остаток шестьсот', 'sixty', 'двадцать пять тридцать']) {
    assert.ok(codes(verify_text(s, [], s.includes('nine') || s.includes('sixty') || s.includes('ninety') ? 'en' : 'ru')).includes('V_SPELLED'), s);
  }
  for (const s of ['одна из причин', 'Шаг три', 'в одном месте', 'two ways', 'one of them', 'это три шага', 'первый шаг']) {
    assert.ok(!codes(verify_text(s, [], 'ru')).includes('V_SPELLED'), s);
  }
});

// ═══ TST-51 · Q-05: строгий разбор групп тысяч ═════════════════════════════════════════════════════════════════════════

test('TST-51 REQ-091 Q-05 «12,50» при thousands «,» отвергается (bad_amount); «1.234,50» и «1,234.50» читаются как раньше', () => {
  const EN = { decimal: '.', thousands: ',' };
  const ES = { decimal: ',', thousands: '.' };
  const P = (s, a, e = 2) => IO.parse_amount_cell(s, a, e);
  assert.equal(P('12,50', EN), null);
  assert.equal(P('1,2,3', EN), null);
  assert.equal(P('1,23', EN), null);
  assert.equal(P('1,2345.50', EN), null);
  assert.equal(P('12.50', ES), null);
  assert.equal(P('1.23,4', ES), null);
  assert.equal(P('1,234.50', EN), 123450);
  assert.equal(P('1.234,50', ES), 123450);
  assert.equal(P('-1,234,567.89', EN), -123456789);
  assert.equal(P('12,345', EN, 0), 12345, 'JPY: «12,345» — группа из трёх цифр');
  assert.equal(P('12.50', EN), 1250);
  assert.equal(P('1234,56', ES), 123456, 'без разделителя тысяч в записи — как раньше');
  assert.equal(P('1 234,56', { decimal: ',', thousands: ' ' }), 123456);
  assert.equal(P('1 23,56', { decimal: ',', thousands: ' ' }), null, 'пробельный разделитель — тоже группы по три');
  assert.equal(P('12 345,67', { decimal: ',', thousands: ' ' }), null, 'обычный пробел при thousands NBSP — как раньше, null');
  assert.equal(P('12 345,67', { decimal: ',', thousands: ' ' }), 1234567);
  assert.equal(P('12 345,67', { decimal: ',', thousands: ' ' }), 1234567);
  assert.equal(P('1,234', { decimal: ',', thousands: ',' }), null, 'десятичный знак совпадает с разделителем: двусмысленно');
});

test('TST-51 Q-05 «12,50» в профиле: строка отклонена как bad_amount (счётчик «отклонено» сухого прогона), а не импортирована как 1250,00', () => {
  const prof = { v: 1, delimiter: ';', date: { col: 'd', fmt: 'YYYY-MM-DD' }, amount: { mode: 'signed', col: 'a', decimal: '.', thousands: ',' }, currency: { fixed: 'EUR' }, desc: { cols: ['n'] } };
  const ctx = { account_id: 'acc', account_currency: 'EUR', as_of: '2026-10-04' };
  const r = IO.parse_with_profile(prof, 'd;a;n\n2026-10-01;12,50;x\n2026-10-02;1,234.50;y\n', ctx);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].amount_minor, 123450);
  assert.deepEqual(r.rejects.map((x) => x.reason), ['bad_amount']);
  const d = IO.dry_run(r.candidates, new Set(), r.rejects, []);
  assert.equal(d.rejected, 1);
  assert.equal(d.recognized, 1);
});

test('TST-51 Q-05 фаззинг 10^4 случайных ячеек: parse_amount_cell либо отказ, либо ровно значение parse_minor очищенной строки; round-trip format_minor сохраняется', () => {
  const rng = make_rng(5105);
  const alphabet = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ',', '.', ' ', ' ', '-', '−', 'a'];
  const profiles = [{ decimal: '.', thousands: ',' }, { decimal: ',', thousands: '.' }, { decimal: ',', thousands: ' ' }, { decimal: '.', thousands: '' }];
  let accepted = 0;
  for (let i = 0; i < 10000; i++) {
    const len = rng.int(1, 12);
    let s = '';
    for (let k = 0; k < len; k++) s += rng.pick(alphabet);
    const a = rng.pick(profiles);
    const got = IO.parse_amount_cell(s, a, 2);
    if (got === null) continue;
    accepted += 1;
    // независимый оракул: убрать пробелы и разделитель тысяч, затем parse_minor
    const cleaned = s.trim().replace(/−/g, '-').replace(/[  ]/g, '').split(a.thousands === '' ? '\u0000' : a.thousands).join('');
    assert.equal(got, parse_minor(cleaned, { decimal: a.decimal, thousands: '', exponent: 2 }), JSON.stringify([s, a]));
    // и принятая запись с разделителем тысяч имеет группы по три
    if (a.thousands !== '' && a.thousands !== ' ' && s.includes(a.thousands)) {
      const int = s.trim().replace(/^[-−]/, '').split(a.decimal)[0];
      assert.match(int, /^\d{1,3}(?:[,.]\d{3})+$|^\d+$/, JSON.stringify([s, a]));
    }
  }
  assert.ok(accepted > 100, 'выборка содержит и принятые записи (' + accepted + ')');
  for (const x of [0, 5, -5, 1234, 123456, -9999999, 1234567890]) {
    assert.equal(IO.parse_amount_cell(format_minor(x, 2, { decimal: ',', thousands: '.' }), { decimal: ',', thousands: '.' }, 2), x);
    assert.equal(IO.parse_amount_cell(format_minor(x, 2, { decimal: '.', thousands: ',' }), { decimal: '.', thousands: ',' }, 2), x);
  }
});

// ═══ TST-43 · Q-10: id-колонки CSV ═════════════════════════════════════════════════════════════════════════════════════

test('TST-43 REQ-095 Q-10 id-колонки export_csv (account_id, event_id, dedup_key, currency) не начинаются с = + - @ TAB CR; round-trip значения не меняется; amount_minor «-4730» без «\'»', () => {
  const acc = L.make_event('account.opened', { account_id: '=cmd|calc', name: 'B', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 }, { event_id: '+ev0', seq: 1, recorded_at: '2026-10-01T10:00:00Z' });
  const mk = (id, seq, acct, cur, dk) => L.make_event('tx.posted', { account_id: acct, date: '2026-10-02', amount_minor: -4730, currency: cur, note: 'n', dedup_key: dk }, { event_id: id, seq, recorded_at: '2026-10-01T10:00:00Z', entity_id: id });
  const ids = ['=1+1', '-ev', '@x', '\tx', '\rx', "'=x", 'plain'];
  const evs = ids.map((id, i) => mk(id, i + 2, ids[i], i % 2 === 0 ? 'EUR' : '@X', ids[(i + 1) % ids.length]));
  const csv = IO.export_csv(L.reduce(L.effective_events([acc, ...evs])), 'journal');
  const rows = IO.parse_csv(csv);
  assert.equal(rows.length, 1 + ids.length);
  for (const r of rows.slice(1)) {
    const [, account_id, amount, currency, , , , , , event_id, dedup_key] = r;
    for (const cell of [account_id, currency, event_id, dedup_key]) assert.ok(cell === '' || !'=+-@\t\r'.includes(cell[0]), JSON.stringify(cell));
    assert.equal(amount, '-4730');
  }
  // round-trip безопасного значения: «plain» остаётся «plain», опасное получает префикс «'» (текст восстанавливается при снятии одного апострофа)
  const plain = rows.find((r) => r[9] === 'plain');
  assert.ok(plain !== undefined && plain[1] === 'plain');
  for (const r of rows.slice(1)) if (r[9] !== 'plain') assert.ok(r[9].startsWith("'"), JSON.stringify(r[9]));
});

test('TST-43 Q-10 round-trip export → import runway-csv/1: факты и суммы без потерь для журнала с безопасными и опасными id; план отфильтрован', () => {
  const acc = L.make_event('account.opened', { account_id: 'acc_main', name: 'B', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 }, { event_id: 'a0', seq: 1, recorded_at: '2026-10-01T10:00:00Z' });
  const mk = (id, seq, amt) => L.make_event('tx.posted', { account_id: 'acc_main', date: '2026-10-02', amount_minor: amt, currency: 'EUR', note: 'n' + seq }, { event_id: id, seq, recorded_at: '2026-10-01T10:00:00Z', entity_id: id });
  const evs = [mk('=a', 2, -100), mk('-b', 3, 250), mk('c', 4, -75)];
  const csv = IO.export_csv(L.reduce(L.effective_events([acc, ...evs])), 'journal');
  const r = IO.parse_with_profile(IO.RUNWAY_CSV_PROFILE, csv, { account_id: 'acc_main', account_currency: 'EUR', as_of: '2026-10-04' });
  assert.deepEqual(r.candidates.map((c) => c.amount_minor).sort((x, y) => x - y), [-100, -75, 250]);
  assert.equal(r.rejects.length, 0);
});

// ═══ TST-32 · Q-21 / REQ-093: хэш после отката партии ═════════════════════════════════════════════════════════════════

test('TST-32 REQ-093 Q-21 state_hash до импорта = state_hash после отката партии с опцией omit [imports] (и core_hash); без опции хэш прежний (vector arith.lock не затронут)', () => {
  const prof = { v: 1, delimiter: ',', date: { col: 'd', fmt: 'YYYY-MM-DD' }, amount: { mode: 'signed', col: 'a', unit: 'minor' }, currency: { fixed: 'EUR' }, desc: { cols: ['n'] } };
  const r = IO.parse_with_profile(prof, 'd,a,n\n2026-10-01,-500,x\n2026-10-02,-700,y\n', { account_id: 'acc_bank', account_currency: 'EUR', as_of: '2026-10-04' });
  const d = IO.dry_run(r.candidates, new Set(), r.rejects, []);
  const acc = L.make_event('account.opened', { account_id: 'acc_bank', name: 'B', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 }, { event_id: 'a0', seq: 1, recorded_at: '2026-10-01T10:00:00Z' });
  let n = 1;
  const ports = { batch_id: 'b1', next_id: () => 'x' + (++n), next_seq: () => ++n, recorded_at: '2026-10-04T10:00:00Z' };
  const c = IO.import_commit(d, {}, 'bytes', ports);
  const rb = IO.import_rollback('b1', [acc, ...c], ports);
  const before = L.reduce(L.effective_events([acc]));
  const mid = L.reduce(L.effective_events([acc, ...c]));
  const after = L.reduce(L.effective_events([acc, ...c, ...rb]));
  assert.notEqual(L.state_hash(mid, { omit: ['imports'] }), L.state_hash(before, { omit: ['imports'] }), 'после импорта факты появились');
  assert.equal(L.state_hash(after, { omit: ['imports'] }), L.state_hash(before, { omit: ['imports'] }));
  assert.equal(L.core_hash(after), L.core_hash(before));
  assert.notEqual(L.state_hash(after), L.state_hash(before), 'полный хэш различается: реестр imports хранит след партии (К-31)');
  assert.equal(L.state_hash(before), L.state_hash(before, undefined));
  // повторный импорт того же файла — 0 новых
  const d2 = IO.dry_run(r.candidates, new Set(L.effective_events([acc, ...c]).filter((e) => e.type === 'tx.posted').map((e) => e.payload.dedup_key)), r.rejects, []);
  assert.equal(d2.recognized, 0);
  assert.equal(d2.duplicates, 2);
});

// ═══ REQ-014: факты отдельно от сценариев ════════════════════════════════════════════════════════════════════════════

test('REQ-014 TST-35 хэш журнала фактов не меняется при сохранении и удалении сценария и покупки (state_hash с omit scenarios/purchases)', () => {
  const ev = (type, payload, n, extra = {}) => L.make_event(type, payload, { event_id: 'e' + n, seq: n, recorded_at: '2026-10-01T10:00:00Z', ...extra });
  const base = [
    ev('account.opened', { account_id: 'acc_main', name: 'B', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 }, 1),
    ev('anchor.set', { anchor_id: 'an1', account_id: 'acc_main', date: '2026-10-01', amount_minor: 100000 }, 2),
    ev('tx.posted', { account_id: 'acc_main', date: '2026-10-02', amount_minor: -2500, currency: 'EUR' }, 3, { entity_id: 'tx1' }),
  ];
  const scen = ev('scenario.set', { scenario_id: 'sc1', name: 'S', ops: [{ op: 'fx_shock', currency: 'USD', bp: -500 }] }, 4);
  const purch = ev('purchase.saved', { purchase_id: 'p1', name: 'P', currency: 'EUR', parts: [{ date: '2026-10-12', amount_minor: 30000 }] }, 5);
  const revert = ev('revert', { target: 'e4' }, 6, { entity_id: 'e4' });
  const OMIT = { omit: ['scenarios', 'purchases'] };
  const h = (events) => L.state_hash(L.reduce(L.effective_events(events)), OMIT);
  assert.equal(h([...base, scen, purch]), h(base), 'сохранение сценария и покупки не меняет хэш фактов');
  assert.equal(h([...base, scen, revert]), h(base), 'удаление (откат) сценария — тоже');
  assert.notEqual(L.state_hash(L.reduce(L.effective_events([...base, scen]))), L.state_hash(L.reduce(L.effective_events(base))), 'полный хэш сценарий учитывает');
  const fact2 = ev('tx.posted', { account_id: 'acc_main', date: '2026-10-03', amount_minor: -1, currency: 'EUR' }, 7, { entity_id: 'tx2' });
  assert.notEqual(h([...base, fact2]), h(base), 'новый факт хэш меняет');
});

// ═══ REQ-016: версии схемы и апкастеры ═══════════════════════════════════════════════════════════════════════════════════

const JOURNAL_V1_PATH = new URL('journal-v1.json', FIXTURES);
const sha_file = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
/** state_hash фикстуры journal-v1.json (golden): записан при создании фикстуры и сверяется при каждом прогоне (REQ-016). */
const JOURNAL_V1_STATE_HASH = 'f4b11682044eb911add5a6223c88c67b0f07c504321081ac1bfcdfc8ad4dde88';

test('REQ-016 TST-38 фикстура журнала runway-journal/1: читается, число записей и состояние совпадают с golden state_hash', () => {
  const text = fs.readFileSync(JOURNAL_V1_PATH, 'utf8');
  const j = IO.read_journal_json(text);
  assert.equal(j.format, 'runway-journal/1');
  assert.ok(j.events.length >= 10);
  const state = IO.import_json(text);
  assert.equal(L.state_hash(state), JOURNAL_V1_STATE_HASH, 'state_hash фикстуры (golden) изменился: формат журнала или свёртка поменялись');
  assert.equal(L.state_hash(L.reduce(L.effective_events(j.events))), JOURNAL_V1_STATE_HASH);
  // экспорт назад: канонический вид стабилен (round-trip байт в байт для канонической записи)
  assert.equal(IO.export_json(j.events, { engine_version: j.engine_version }), L.canon(JSON.parse(text)));
});

test('REQ-016 учебный апкастер v1 → v2: запись с «amount: 19.99» даёт amount_minor 1999 (без float-арифметики); текущая версия без изменений; цепочка v → v+1', () => {
  const j = IO.read_journal_json(fs.readFileSync(JOURNAL_V1_PATH, 'utf8'));
  const tx = j.events.find((e) => e.type === 'tx.posted');
  assert.ok(tx !== undefined);
  const legacy = { ...tx, payload: { ...tx.payload, amount: 19.99 } };
  delete legacy.payload.amount_minor;
  const registry = {
    current: { ...L.DEFAULT_UPCAST_REGISTRY.current, 'tx.posted': 2 },
    steps: { 'tx.posted': { 1: (e) => {
      const p = { ...e.payload };
      p.amount_minor = parse_minor(String(p.amount), { decimal: '.', thousands: '', exponent: 2 });
      delete p.amount;
      return { ...e, v: 2, payload: p };
    } } },
  };
  const up = L.upcast(legacy, registry);
  assert.equal(up.v, 2);
  assert.equal(up.payload.amount_minor, 1999);
  assert.equal(up.payload.amount, undefined);
  assert.equal(legacy.v, 1, 'на диске (во входной записи) ничего не меняется');
  assert.equal(legacy.payload.amount, 19.99);
  assert.equal(L.upcast(up, registry), up, 'текущая версия — та же запись');
  // шаг обязан поднимать версию ровно на 1
  const bad = { current: registry.current, steps: { 'tx.posted': { 1: (e) => ({ ...e, v: 3 }) } } };
  throws_code(() => L.upcast(legacy, bad), 'E_SCHEMA');
  // нет апкастера для версии — E_SCHEMA
  throws_code(() => L.upcast({ ...legacy, v: 1 }, { current: registry.current, steps: {} }), 'E_SCHEMA');
});

test('REQ-016 файл с версией выше известной открывается только для чтения и не меняется: SHA-256 до и после совпадает; запись с новой v не сворачивается', () => {
  const before = sha_file(JOURNAL_V1_PATH);
  const text = fs.readFileSync(JOURNAL_V1_PATH, 'utf8');
  const newer = text.replace('"format":"runway-journal/1"', '"format":"runway-journal/2"');
  assert.notEqual(newer, text);
  throws_code(() => IO.read_journal_json(newer), 'E_SCHEMA');
  throws_code(() => IO.import_json(newer), 'E_SCHEMA');
  const j = IO.read_journal_json(text);
  const e = { ...j.events[0], v: 2 };
  throws_code(() => L.upcast(e), 'E_SCHEMA');
  throws_code(() => L.reduce([e]), 'E_SCHEMA');
  assert.equal(sha_file(JOURNAL_V1_PATH), before, 'файл фикстуры не тронут');
  assert.equal(crypto.createHash('sha256').update(text).digest('hex'), before);
});

// ═══ TST-23 · Q-18, Q-20, Q-29: sinking ═════════════════════════════════════════════════════════════════════════════════

test('TST-23 Q-18 contribution_dates: номинал предыдущего месяца, сдвинутый weekend=next в окно, учитывается (31 окт, суббота → 2 ноя); свойство против независимого оракула', () => {
  const cal = make_calendar({});
  const got = S.contribution_dates(parse_date('2026-11-01'), parse_date('2026-12-15'), { freq: 'M', day: 31, weekend: 'next' }, cal).map(format_date);
  assert.deepEqual(got, ['2026-11-02', '2026-11-30']);
  // оракул: перебрать ВСЕ даты календаря, выбрать сдвинутые номиналы (без общего кода с реализацией)
  const rng = make_rng(2318);
  const dow = (d) => ((d % 7) + 11) % 7; // 1970-01-01 = четверг (4)
  for (let it = 0; it < 400; it++) {
    const start = parse_date('2026-01-01') + rng.int(0, 700);
    const due = start + rng.int(1, 400);
    const day = rng.int(1, 31);
    const weekend = rng.pick(['keep', 'prev', 'next']);
    const out = S.contribution_dates(start, due, { freq: 'M', day, weekend }, cal);
    const expect = new Set();
    for (let m = -2; m < 40; m++) {
      const [y0, m0] = civil_from_days(start);
      const tm = (y0 * 12 + (m0 - 1)) + m;
      const ty = Math.floor(tm / 12);
      const mo = ((tm % 12) + 12) % 12 + 1;
      const dim = civil_from_days(days_from_civil(mo === 12 ? ty + 1 : ty, mo === 12 ? 1 : mo + 1, 1) - 1)[2];
      let nom = days_from_civil(ty, mo, Math.min(day, dim));
      let d = nom;
      const w = dow(nom);
      if (w === 6 || w === 0) { // сб, вс
        if (weekend === 'next') d = nom + (w === 6 ? 2 : 1);
        else if (weekend === 'prev') d = nom - (w === 6 ? 1 : 2);
      }
      if (start <= d && d < due) expect.add(d);
    }
    assert.deepEqual(out, [...expect].sort((a, b) => a - b), JSON.stringify({ start: format_date(start), due: format_date(due), day, weekend }));
  }
});

test('TST-23 Q-20 reserve_open_ex: записи с date > as_of и date ≤ funded_as_of попадают в ignored; излишек release обрезается и виден в clipped_minor; reserve_open — прежнее число', () => {
  const r = { reserve_id: 'R', funded_start_minor: 600, funded_as_of: '2026-09-01' };
  const al = (id, d, a, rid = 'R', source = 'manual') => ({ allocation_id: id, reserve_id: rid, date: d, amount_minor: a, source });
  const allocs = [al('past', '2026-09-01', 500), al('x1', '2026-09-02', 200), al('future', '2026-10-05', 9999), al('other', '2026-09-10', 7777, 'R2'), al('rel', '2026-09-20', -1500, 'R', 'release')];
  const ex = S.reserve_open_ex(r, allocs, '2026-10-04');
  assert.deepEqual(ex.ignored, [{ allocation_id: 'past', reason: 'before_funded_as_of' }, { allocation_id: 'future', reason: 'future' }]);
  assert.equal(ex.funded_open_minor, 0);
  assert.equal(ex.clipped_minor, 700, '600 + 200 − 1500 = −700 → обрезано 700');
  assert.equal(S.reserve_open(r, allocs, '2026-10-04'), ex.funded_open_minor);
  const ok = S.reserve_open_ex(r, [al('x1', '2026-09-02', 200)], '2026-10-04');
  assert.deepEqual([ok.funded_open_minor, ok.ignored, ok.clipped_minor], [800, [], 0]);
});

test('TST-23 Q-29 refill_to_target без target_minor → E_SCHEMA (target_missing), а не E_NOT_INTEGER; fixed без target — как прежде', () => {
  const cal = make_calendar({});
  const base = { reserve_id: 'R', kind: 'sinking', mode: 'refill_to_target', due_date: '2027-03-15', cadence: { freq: 'M', day: 1 } };
  const e = (() => { try { S.contribution_allocations(base, 0, '2026-10-04', '2026-12-31', cal, []); return null; } catch (x) { return x; } })();
  assert.equal(e?.code, 'E_SCHEMA');
  assert.equal(e.ctx.reason, 'target_missing');
  throws_code(() => S.contribution_plan({ funded_open_minor: 0, dates: [1, 2], mode: 'refill_to_target' }), 'E_SCHEMA');
  const fixed = { reserve_id: 'F', kind: 'sinking', mode: 'fixed', fixed_minor: 1000, cadence: { freq: 'M', day: 1 } };
  assert.equal(S.contribution_allocations(fixed, 0, '2026-10-04', '2026-12-31', cal, []).length, 2, 'даты 11-01 и 12-01');
});

// ═══ REQ-069 · Q-09: числа в W_RESERVE_BEHIND ═════════════════════════════════════════════════════════════════════════

test('REQ-069 Q-09 W_RESERVE_BEHIND несёт missed_count и missed_minor: 2 пропущенных взноса по 5000 → 2 и 10000; записанные взносы уменьшают число; прежние поля сохранены', () => {
  const R1 = { reserve_id: 'RF', kind: 'sinking', mode: 'fixed', fixed_minor: 5000, currency: 'EUR', funded_start_minor: 0, funded_as_of: '2026-08-15', cadence: { freq: 'M', day: 1 } };
  const sch = (d) => ({ allocation_id: 'sch:RF@' + d, reserve_id: 'RF', date: d, amount_minor: 5000, source: 'schedule' });
  const behind = (allocs) => {
    const ws = clone(G);
    ws.reserves = [...ws.reserves, R1];
    ws.allocations = allocs;
    return analyze(ws, { as_of: ws.as_of }).warnings.filter((w) => w.code === 'W_RESERVE_BEHIND' && w.reserve_id === 'RF');
  };
  // взносы 09-01 и 10-01 до as_of (10-04) не записаны
  assert.deepEqual(behind([]), [{ code: 'W_RESERVE_BEHIND', reserve_id: 'RF', missed_count: 2, missed_minor: 10000 }]);
  assert.deepEqual(behind([sch('2026-09-01')]), [{ code: 'W_RESERVE_BEHIND', reserve_id: 'RF', missed_count: 1, missed_minor: 5000 }]);
  assert.deepEqual(behind([sch('2026-09-01'), sch('2026-10-01')]), []);
  // refill_to_target: сумма пропущенных долей графика (цель 60000, срок 2027-03-15)
  const R2 = { reserve_id: 'RT2', kind: 'sinking', mode: 'refill_to_target', target_minor: 60000, due_date: '2027-03-15', currency: 'EUR', funded_start_minor: 0, funded_as_of: '2026-08-15', cadence: { freq: 'M', day: 1 } };
  const ws = clone(G);
  ws.reserves = [...ws.reserves, R2];
  const w = analyze(ws, { as_of: ws.as_of }).warnings.find((x) => x.code === 'W_RESERVE_BEHIND' && x.reserve_id === 'RT2');
  assert.equal(w.missed_count, 2);
  // даты взносов 09-01 … 03-01 (7 дат), c_k = min(ceil_div(rem_k, n − k), rem_k): 60000/7 → 8572 (rem 51428), 51428/6 → 8572; пропущены две первые
  assert.equal(w.missed_minor, 8572 + 8572);
});

// ═══ Q-17: знак правки суммы ═════════════════════════════════════════════════════════════════════════════════════════════

test('TST-14 REQ-010 Q-17 validate_override: set_amount с неверным знаком, нулём или не целым — ошибка; −5000 для расхода и +5000 для дохода — норма; без правила — только форма', () => {
  const rule = (kind) => ({ rule_id: 'R', kind, amount: { exp_minor: kind === 'expense' ? -100 : 100 } });
  const o = (a) => ({ rule_id: 'R', nominal_date: '2026-11-01', action: 'set_amount', amount_minor: a });
  assert.equal(R.validate_override(o(-5000), rule('expense')).ok, true);
  assert.equal(R.validate_override(o(5000), rule('income')).ok, true);
  assert.deepEqual(R.validate_override(o(5000), rule('expense')).errors.map((e) => e.reason), ['override_sign']);
  assert.deepEqual(R.validate_override(o(-5000), rule('income')).errors.map((e) => e.reason), ['override_sign']);
  assert.deepEqual(R.validate_override(o(0), rule('expense')).errors.map((e) => e.reason), ['zero']);
  assert.deepEqual(R.validate_override(o(1.5), rule('expense')).errors.map((e) => e.reason), ['not_safe_integer']);
  assert.equal(R.validate_override(o(5000)).ok, true, 'без правила — форма');
  assert.equal(R.validate_override({ rule_id: 'R', nominal_date: '2026-13-01', action: 'skip' }).ok, false);
  assert.equal(R.validate_override({ rule_id: 'R', nominal_date: '2026-11-01', action: 'move' }).ok, false, 'move без даты');
  assert.equal(R.validate_override({ rule_id: 'R', nominal_date: '2026-11-01', action: 'move', date: '2026-11-03' }).ok, true);
  assert.equal(R.validate_override({ rule_id: 'R', nominal_date: '2026-11-01', action: 'nope' }).ok, false);
  assert.equal(R.validate_override(null).ok, false);
  // движок на уже записанных журналах поведение не меняет: +5000 у расхода раскрывается как прежде (решение К-5 — за владельцем)
  const exp = R.expand_rule({ ...R_RULE }, { from: parse_date('2026-11-01'), to: parse_date('2026-11-30') }, make_calendar({}), [o(5000)]);
  assert.equal(exp[0].amount_minor, 5000);
});
const R_RULE = { rule_id: 'R', account_id: 'acc_main', name: 'x', kind: 'expense', amount: { exp_minor: -100 }, currency: 'EUR', freq: 'M', interval: 1, start_date: '2026-01-01', month_end: 'clamp', weekend: 'keep', exdates: [], is_obligation: false, is_estimate: false, tag: 't' };

// ═══ REQ-055, REQ-068: запреты в шаблонах и данных (тесты без правки кода) ═════════════════════════════════════════════

test('REQ-055 TST-49 в v1 ни один шаблон ответа не содержит ключа или слова probability / вероятность; границы Уилсона — только через calibration, не в каталоге', () => {
  for (const loc of ['ru', 'en']) {
    for (const [k, t] of Object.entries(templates(loc))) {
      assert.ok(!/probab|вероятн/i.test(k), `${loc} ключ ${k}`);
      assert.ok(!/probab|вероятн|%\s*\(95/i.test(t), `${loc} ${k}`);
    }
  }
});

test('REQ-068 TST-46 0 ставок по умолчанию: ни vocab.json, ни TIMELINE_DEFAULTS, ни рабочая область без правил не содержат rate_bp/ставок; без правил аллокаций нет; шаблон налога несёт оговорку', () => {
  const vocab = JSON.parse(fs.readFileSync(new URL('../engine/vocab.json', import.meta.url), 'utf8'));
  for (const k of [...Object.keys(vocab.params), ...Object.keys(TIMELINE_DEFAULTS)]) assert.ok(!/rate|tax|ставк|налог/i.test(k), k);
  assert.ok(!JSON.stringify(vocab.params).includes('rate_bp'));
  const bare = { ...clone(G), tax_rules: [], reserves: [], allocations: [] };
  const a = analyze(bare, { as_of: bare.as_of });
  assert.equal(a.reserve.plan.by_reserve && Object.keys(a.reserve.plan.by_reserve).length, 0);
  assert.equal(a.series.plan.reserve_opening_minor, 0);
  const tax_tpl = Object.entries(templates('ru')).filter(([k]) => /^TAX\./.test(k));
  assert.ok(tax_tpl.length > 0);
  assert.ok(tax_tpl.some(([, t]) => /не консультац/i.test(t)), 'RU-шаблон налога несёт оговорку');
  assert.ok(Object.entries(templates('en')).filter(([k]) => /^TAX\./.test(k)).some(([, t]) => /not (tax )?advice/i.test(t)), 'EN-шаблон налога несёт оговорку');
  // предзаполненных шаблонов стран нет в данных пакета
  for (const name of fs.readdirSync(new URL('./', DATA))) {
    if (!name.endsWith('.json')) continue;
    const ws = JSON.parse(fs.readFileSync(new URL(name, DATA), 'utf8'));
    for (const r of ws.tax_rules ?? []) assert.ok(/правило пользователя|user/i.test(r.name ?? ''), name + ': налоговое правило помечено как правило пользователя');
  }
});

// ═══ расширенный фаззинг (по флагу FUZZ_N) ═══════════════════════════════════════════════════════════════════════════════

test('TST-51 REQ-158 расширенный фаззинг парсера сумм и верификатора: FUZZ_N случайных входов — 0 необработанных исключений (по умолчанию пропускается)', { skip: GP_FUZZ === 0 ? 'FUZZ_N не задан (ночной режим: FUZZ_N=100000)' : false }, (t) => {
  const rng = make_rng(158);
  const chars = '0123456789,. -−–—‐ €$%абв[]()!<>/:​‮ minusнегатив';
  let n = 0;
  for (let i = 0; i < GP_FUZZ; i++) {
    const len = rng.int(0, 24);
    let s = '';
    for (let k = 0; k < len; k++) s += chars[rng.int(0, chars.length - 1)];
    IO.parse_amount_cell(s, { decimal: rng.pick([',', '.']), thousands: rng.pick(['', ',', '.', ' ']) }, 2);
    extract_quantities(s, rng.pick(['ru', 'en']));
    n += 1;
    fuzz_progress('hardening:inputs', n, GP_FUZZ);
  }
  t.diagnostic(`TST-51 фаззинг: прогнано ${n} входов`);
});

// ═══ TST-25 · Q-19: план часов при заданном темпе ═════════════════════════════════════════════════════════════════════════

test('TST-25 ALG-07 Q-19 plan_to_date: закрытый период при заданном темпе — ровно exp (200·31 = 6200 → 5580); открытый — min(pace·elapsed, exp); без темпа — прежняя формула; граница as_of = end и end + 1', async () => {
  const H = await import('../engine/hourly.mjs');
  const stream = { ...G.streams[0], hours: { min_minutes: 4800, exp_minutes: 5580, max_minutes: 6600 }, pace_minutes_per_day: 200 };
  const period = H.period_bounds(stream, parse_date('2026-10-20'));
  const P = parse_date;
  assert.equal(H.plan_to_date(stream, period, P('2026-12-20')), 5580, 'закрытый период');
  assert.equal(H.plan_to_date(stream, period, P('2026-10-20')), 4000, 'открытый: 200·20 < 5580');
  assert.equal(H.plan_to_date(stream, period, P('2026-10-31')), 5580, 'as_of = end: min(200·31 = 6200, 5580)');
  assert.equal(H.plan_to_date(stream, period, period.end + 1), 5580, 'as_of = end + 1: закрыт');
  const slow = { ...stream, pace_minutes_per_day: 100 };
  assert.equal(H.plan_to_date(slow, period, P('2026-10-31')), 3100, 'малый темп на последний день: min даёт 3100');
  assert.equal(H.plan_to_date(slow, period, period.end + 1), 5580, 'закрытый период — exp, а не 3100');
  assert.equal(H.plan_to_date(slow, period, P('2026-09-20')), 0);
  const nopace = { ...stream, pace_minutes_per_day: null };
  assert.equal(H.plan_to_date(nopace, period, P('2026-10-20')), 3600, 'без темпа — exp·elapsed/days');
  assert.equal(H.shortfall(stream, period, period.end + 1, 5000).short_minutes, 580);
});

// ═══ TST-55 · Q-28: метрики backtest без потери точности ════════════════════════════════════════════════════════════════

test('TST-55 ALG-13 Q-28 window_metrics: skill по BigInt совпадает с прежней формулой на обычных входах и остаётся точным при Σ|F − A| ≈ 10^13; abs_naive = 0 → null', async () => {
  const { window_metrics } = await import('../engine/backtest.mjs');
  const rng = make_rng(2828);
  const old_skill = (ws) => {
    let e = 0; let n = 0;
    for (const w of ws) { e += Math.abs(w.forecast - w.actual); n += Math.abs(w.naive - w.actual); }
    return n === 0 ? null : 1000 - Math.floor((1000 * e) / n);
  };
  for (let i = 0; i < 1000; i++) {
    const ws = Array.from({ length: rng.int(1, 8) }, () => ({ forecast: rng.int(-1000000, 1000000), actual: rng.int(-1000000, 1000000), naive: rng.int(-1000000, 1000000), lo: 0, hi: 0 }));
    assert.equal(window_metrics(ws).skill_pm, old_skill(ws), JSON.stringify(ws));
  }
  // крупные суммы: 1000·Σ|F−A| > 2^53; точный ответ считаем независимо через BigInt
  const big = [{ forecast: 10 ** 13, actual: 0, naive: 3 * 10 ** 12, lo: 0, hi: 1 }, { forecast: 1, actual: 0, naive: 0, lo: 0, hi: 1 }];
  const exact = Number(1000n - (1000n * (10n ** 13n + 1n)) / (3n * 10n ** 12n));
  assert.equal(window_metrics(big).skill_pm, exact);
  assert.equal(window_metrics([{ forecast: 5, actual: 5, naive: 5, lo: 0, hi: 9 }]).skill_pm, null);
  assert.equal(window_metrics([]).skill_pm, null);
  assert.equal(window_metrics([{ forecast: 7, actual: 5, naive: 6, lo: 4, hi: 6 }]).hits, 1, "факт 5 внутри коридора 4…6");
});

// ═══ Q-30: служебный код W_HOURS_KEY_IGNORED ════════════════════════════════════════════════════════════════════════════

test('Q-30 К-39 W_HOURS_KEY_IGNORED выдаётся движком, но не входит в vocab.json: зарегистрирован в warnings_ext с текстом RU/EN; общий split_warnings отделяет его от реестровых', () => {
  const ws = clone(G);
  ws.streams[0].hours_by_period = { '2026-10-02': { actual_minutes: 100 } };
  const a = analyze(ws, { as_of: ws.as_of });
  const w = a.warnings.find((x) => x.code === 'W_HOURS_KEY_IGNORED');
  assert.ok(w !== undefined, JSON.stringify(a.warnings));
  assert.equal(is_ext_warning(w), true);
  assert.ok(ext_warning_text(w, 'ru').length > 0 && ext_warning_text(w, 'en').length > 0);
  const vocab = JSON.parse(fs.readFileSync(new URL('../engine/vocab.json', import.meta.url), 'utf8'));
  assert.ok(!Object.hasOwn(vocab.warning_codes, 'W_HOURS_KEY_IGNORED'));
  const { registry, ext } = split_warnings(a.warnings);
  assert.ok(ext.some((x) => x.code === 'W_HOURS_KEY_IGNORED'));
  for (const x of registry) assert.ok(Object.hasOwn(vocab.warning_codes, x.code), x.code);
  // все служебные коды, которые движок способен выдать из рабочей области, описаны: прочие коды — из реестра vocab.json
  for (const x of analyze(ws, { as_of: ws.as_of }).warnings) assert.ok(Object.hasOwn(vocab.warning_codes, x.code) || is_ext_warning(x), x.code);
});

// ═══ TST-38 · REQ-094, запрос FP-01: свёртка «снимок + хвост» и круг JSON-копии на 10^3 журналах ═════════════════════════════

/** Случайный журнал из событий разных видов (включая revert и supersedes). Независимый от io.test.mjs генератор. */
function random_journal(rng, size) {
  let n = 0;
  const ev = (type, payload, x = {}) => { n += 1; return L.make_event(type, payload, { event_id: 'e' + n, seq: n, recorded_at: '2026-10-0' + rng.int(1, 4) + 'T10:00:00Z', ...x }); };
  const out = [ev('account.opened', { account_id: 'acc1', name: 'Main', kind: 'bank', liquidity: 'operating', currency: 'EUR', exponent: 2 })];
  const NOTES = ['кофе', 'Café', 'a"b', 'x,y', 'line\nbreak', '=1+1', '😀', '', 'a|b', "o'neil"];
  for (let i = 0; i < size; i++) {
    const t = rng.int(0, 7);
    if (t <= 2) out.push(ev('tx.posted', { account_id: 'acc1', date: '2026-10-0' + rng.int(1, 4), amount_minor: rng.int(-100000, 100000), currency: 'EUR', note: rng.pick(NOTES) }, { entity_id: 'tx' + i }));
    else if (t === 3) out.push(ev('anchor.set', { anchor_id: 'anc' + i, account_id: 'acc1', date: '2026-09-' + String(rng.int(10, 28)), amount_minor: rng.int(0, 500000) }));
    else if (t === 4) out.push(ev('params.set', { buffer_minor: rng.int(0, 100000), headline_mode: rng.pick(['plan', 'worse']) }, { entity_id: 'params' }));
    else if (t === 5 && out.length > 2) { const target = rng.pick(out.slice(1)); out.push(ev('revert', { target: target.event_id }, { entity_id: target.event_id })); }
    else if (t === 6) out.push(ev('rule.set', { rule_id: 'R' + rng.int(1, 3), kind: 'expense', amount: { exp_minor: -rng.int(1, 5000) } }));
  }
  return out;
}

test('TST-38 REQ-094 state_hash(import_json(export_json(j))) = state_hash(свёртка j) на 1000 случайных журналах (seed), порядок записей на входе не влияет', () => {
  const rng = make_rng(9401);
  for (let i = 0; i < 1000; i++) {
    const j = random_journal(rng, rng.int(0, 12));
    const direct = L.state_hash(L.reduce(L.effective_events(j)));
    assert.equal(L.state_hash(IO.import_json(IO.export_json(j))), direct, 'журнал #' + i);
  }
});

test('TST-16 REQ-012 reduce(хвост, снимок, {own: true}): снимок принадлежит вызывающему и меняется на месте; результат равен полной свёртке на 300 случайных журналах; без опции снимок не мутируется', () => {
  const rng = make_rng(1612);
  for (let i = 0; i < 300; i++) {
    const j = L.effective_events(random_journal(rng, rng.int(2, 14)));
    const cut = rng.int(0, j.length);
    const full = L.reduce(j);
    const snap = L.reduce(j.slice(0, cut));
    const snap_hash = L.state_hash(snap);
    const pure = L.reduce(j.slice(cut), snap);
    assert.equal(L.state_hash(snap), snap_hash, 'без опции снимок не мутируется');
    assert.equal(L.state_hash(pure), L.state_hash(full), 'журнал #' + i);
    const own = L.reduce(j.slice(cut), L.reduce(j.slice(0, cut)), { own: true });
    assert.equal(L.state_hash(own), L.state_hash(full), 'own: журнал #' + i);
  }
  const base = L.empty_state();
  assert.equal(L.reduce([], base, { own: true }), base, 'own: тот же объект');
  assert.notEqual(L.reduce([], base), base, 'без own — копия');
});

test('TST-56 TST-46 Q-02…Q-06 ни одной новой ложной тревоги: ответы A0 на четырёх эталонных наборах (G-001, low, gap, late), все инструменты, RU и EN — verify_answer ok', () => {
  const tools = [['check_purchase', { date: '2026-10-12', amount_minor: 30000, currency: 'EUR' }], ['check_purchase', { date: '2026-10-12', amount_minor: 900000, currency: 'EUR' }], ['get_projection', { to: '2026-11-30' }],
    ['max_purchase_amount', { date: '2026-10-12' }], ['earliest_safe_date', { amount_minor: 30000, currency: 'EUR' }], ['list_waves', { from: '2026-10-04', to: '2026-11-30' }],
    ['explain_min_point', {}], ['get_tax_envelope', {}]];
  let checked = 0;
  for (const name of ['g001.json', 'g001-low.json', 'g001-gap.json', 'g001-late.json']) {
    const ws = load(name);
    const ctx = make_tool_ctx(ws, { as_of: ws.as_of });
    for (const [tool, args] of tools) {
      ctx.calls_used = 0;
      const r = run_tool(tool, args, ctx);
      if (r.isError === true) continue; // ошибка инструмента — отдельный статичный текст (error_text), проверяется в verifier.test.mjs
      const echo = build_echo([{ name: tool, args }], ctx.params, ws.decision_currency);
      for (const loc of ['ru', 'en']) {
        const v = verify_answer(fallback_answer(r, loc), [r], { echo, locale: loc });
        assert.deepEqual(v.violations, [], `${name} ${tool} ${loc}`);
        checked += 1;
      }
    }
  }
  assert.ok(checked >= 40, 'проверено ответов: ' + checked);
});
