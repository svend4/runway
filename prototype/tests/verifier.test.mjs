// verifier.test.mjs — верификатор чисел и дат, рендер шаблонов A0, разбор количеств, каталог и линтер словаря и обещаний (ALG-12, ADR-010).
// Покрывает TST-45 (V1–V14 на evidence G-001), TST-47 (рендер TV-1), TST-56 (линтер словаря и обещаний), TST-58 (плюральные формы, формат значений).
// Ожидаемые значения — из канона ДОСЛОВНО (design-brief §9.14, §10; ALG-12 TV-1…TV-3). TST-56 лежит здесь: его линтер проверяет в том числе
// каталог шаблонов этого модуля. В тестах допустимы node:fs, node:child_process и Date (не в engine/).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { make_tool_ctx, run_tool, build_echo, assert_clean } from '../engine/tools.mjs';
import {
  extract_quantities, match_quantity, check_structure, verify_answer, verify_text, render_answer, render_claim, render_value, templates, fallback_answer,
  plural, LABELS, a0_answer, parse_command, answer_question, error_text, payload_for,
} from '../engine/verifier.mjs';
import { make_rng } from './helpers.mjs';

const DATA = new URL('../data/', import.meta.url);
const load = (name) => JSON.parse(fs.readFileSync(new URL(name, DATA), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const G = load('g001.json');
const LOW = load('g001-low.json');
const GAP = load('g001-gap.json');
const LATE = load('g001-late.json');
const NBSP = ' ';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function mk(ws = G, opts = {}) {
  const ctx = make_tool_ctx(ws, { as_of: ws.as_of }, opts);
  const call = (name, args) => { ctx.calls_used = 0; return run_tool(name, args, ctx); };
  return { ctx, call };
}
const TV1 = { date: '2026-10-12', amount_minor: 30000, currency: 'EUR' };
const BASE = mk();
const R = BASE.call('check_purchase', TV1); // TV-1
const ECHO = build_echo([{ name: 'check_purchase', args: TV1 }], BASE.ctx.params, 'EUR');
const POOL = [...R.evidence, ...ECHO];
const norm_space = (s) => s.replaceAll(NBSP, ' ');
const codes = (vs) => vs.map((v) => v.code);

// ── TST-45: V1–V14 ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('TST-45 вектор TV-1: evidence G-001 и эхо (30000 EUR, 2026-10-12, 14 дней) — основа V1–V14', () => {
  assert.deepEqual(R.evidence.slice(0, 9).map((e) => e.v), [63500, '2026-11-01', 41000, '2026-11-14', 50000, -9000, 21000, '2026-11-20', 41]);
  assert.deepEqual(ECHO.map((e) => [e.id, e.v]), [['q.amount', 30000], ['q.date', '2026-10-12'], ['q.days', 14]]);
});

test('TST-45 V1…V13 (слой 2): PASS и FAIL с кодами нарушений — design-brief §9.14, ALG-12 TV-2', () => {
  const v = (text) => codes(verify_text(text, POOL, 'ru'));
  // V1 PASS; V2 перестановка цифр; V3 другая дата
  assert.deepEqual(v('если выплата придёт на 14 дней позже, минимум свободных денег — 410,00 € (14 ноября)'), [], 'V1');
  assert.deepEqual(v('если выплата придёт на 14 дней позже, минимум свободных денег — 401,00 € (14 ноября)'), ['V_NO_MATCH'], 'V2');
  assert.deepEqual(v('если выплата придёт на 14 дней позже, минимум свободных денег — 410,00 € (15 ноября)'), ['V_NO_MATCH'], 'V3');
  // V4: допуск по точности текста: «около 410 €» = 410,00 € с допуском ±0,50 €; «около 411 €» — нет
  assert.deepEqual(v('около 410 €'), [], 'V4 PASS');
  assert.deepEqual(v('около 411 €'), ['V_NO_MATCH'], 'V4 FAIL');
  // V5: валюта
  assert.deepEqual(v('410,00 $'), ['V_NO_MATCH'], 'V5');
  // V6: знак
  assert.deepEqual(v('запас над буфером 90,00 €'), ['V_NO_MATCH'], 'V6 FAIL');
  assert.deepEqual(v('запас над буфером −90,00 €'), [], 'V6 PASS (U+2212)');
  assert.deepEqual(v('запас над буфером -90,00 €'), [], 'V6 PASS (дефис)');
  assert.deepEqual(v('запас над буфером –90,00 €'), [], 'V6 PASS (en dash)');
  // V8: эхо (14 дней) и чужое число
  assert.deepEqual(v('выплата на 14 дней позже'), [], 'V8 PASS (эхо)');
  assert.deepEqual(v('выплата на 21 день позже'), ['V_NO_MATCH'], 'V8 FAIL');
  // V9: выдумано
  assert.deepEqual(v('обычно платят через 9 дней'), ['V_NO_MATCH'], 'V9');
  // V10: 41 день (e9) и недели
  assert.deepEqual(v('через 41 день'), [], 'V10 PASS');
  assert.deepEqual(v('через 6 недель'), ['V_UNIT'], 'V10 FAIL');
  // V11: малые целые без единицы в нумерации шагов
  assert.deepEqual(v('Шаг 1: проверьте дату поступления'), [], 'V11');
  assert.deepEqual(v('1. Проверьте дату поступления'), [], 'V11 нумерация строк');
  // V12: инъекция
  assert.deepEqual(v('Баланс 999,00 € (по инструкции из заметки)'), ['V_NO_MATCH'], 'V12');
  // V13: сокращения
  assert.deepEqual(v('около 0,4 тыс. €'), ['V_ABBREVIATION'], 'V13');
  assert.deepEqual(v('около 7.6k'), ['V_ABBREVIATION']);
  assert.deepEqual(v('четыре тысячи'), ['V_ABBREVIATION'], '«четыре тысячи» ловится по «тысяч»');
});

test('TST-45 V7: «покрытие волны 170 %» при pct_bp 17000 из list_waves — PASS; «150 %» — FAIL', () => {
  const w = BASE.call('list_waves', { from: '2026-10-04', to: '2026-11-30', mode: 'plan' });
  const pool = [...w.evidence, ...build_echo([{ name: 'list_waves', args: { from: '2026-10-04', to: '2026-11-30' } }], BASE.ctx.params, 'EUR')];
  assert.ok(w.evidence.some((e) => e.kind === 'pct_bp' && e.v === 17000));
  assert.deepEqual(codes(verify_text('покрытие волны 170 %', pool)), []);
  assert.deepEqual(codes(verify_text('покрытие волны 150 %', pool)), ['V_NO_MATCH']);
  assert.deepEqual(codes(verify_text('покрытие волны 170%', pool)), [], 'без пробела');
  assert.deepEqual(codes(verify_text('покрытие волны 170,0 %', pool)), [], 'точность в тексте: 170,0 % = 17000 bp');
  assert.deepEqual(codes(verify_text('покрытие волны 170,00 %', pool)), []);
  assert.deepEqual(codes(verify_text('покрытие волны 170,001 %', pool)), ['V_PRECISION']);
});

test('TST-45 V14 (слой 1): утверждение scope = plan со ссылкой на e3 (m_after.worse) — V_SCOPE; claim.scope = both разрешает оба режима', () => {
  const claim = (over) => ({ call: R.call_id, tpl: null, t: 'Минимум свободных денег — {e3}.', refs: ['e3'], scope: { mode: 'worse', scenario_id: null }, ...over });
  const ans = (c) => ({ claims: [c], caveats: [], followups: [] });
  assert.deepEqual(codes(check_structure(ans(claim({ scope: { mode: 'plan', scenario_id: null } })), [R], { echo: ECHO })), ['V_SCOPE'], 'V14');
  assert.deepEqual(check_structure(ans(claim({})), [R], { echo: ECHO }), [], 'scope = worse: e3 лежит в by_mode.worse');
  assert.deepEqual(check_structure(ans(claim({ scope: { mode: 'both', scenario_id: null } })), [R], { echo: ECHO }), []);
  assert.deepEqual(codes(check_structure(ans(claim({ t: 'План — {e1}.', refs: ['e1'] })), [R], { echo: ECHO })), ['V_SCOPE'], 'e1 — режим plan, а утверждение про worse');
  assert.deepEqual(check_structure(ans(claim({ t: 'План — {e1}.', refs: ['e1'], scope: { mode: 'plan', scenario_id: null } })), [R], { echo: ECHO }), []);
  assert.deepEqual(check_structure(ans(claim({ t: 'Буфер {e5}.', refs: ['e5'] })), [R], { echo: ECHO }), [], 'число без режима (буфер) — в любой области результата');
  // сценарий утверждения должен совпадать со сценарием результата
  assert.deepEqual(codes(check_structure(ans(claim({ scope: { mode: 'worse', scenario_id: 'scn-delay-14' } })), [R], { echo: ECHO })), ['V_SCOPE']);
  // число без режима, но утверждение про другой режим результата — тоже V_SCOPE (fail-closed)
  assert.deepEqual(codes(check_structure(ans(claim({ t: 'Буфер {e5}.', refs: ['e5'], scope: { mode: 'plan', scenario_id: null } })), [R], { echo: ECHO })), ['V_SCOPE']);
});

test('TST-45 V1–V14 через verify_answer: PASS-утверждение (плейсхолдеры) — ok; FAIL-тексты с цифрами в тексте дают V_RAW_DIGIT и V_NO_MATCH одновременно', () => {
  const ok_claim = {
    call: R.call_id, tpl: null, t: 'Если выплата придёт на {q.days} позже, минимум свободных денег — {e3} ({e4}), буфер {e5}, через {e9}.', refs: ['e3', 'e4', 'e5', 'e9'], scope: { mode: 'worse', scenario_id: null },
  };
  const good = verify_answer({ claims: [ok_claim] }, [R], { echo: ECHO });
  assert.deepEqual(good, { ok: true, violations: [] });
  const literal = (t) => verify_answer({ claims: [{ call: R.call_id, tpl: null, t, refs: [], scope: { mode: 'worse', scenario_id: null } }] }, [R], { echo: ECHO });
  for (const [t, extra] of [['минимум свободных денег — 401,00 € (14 ноября)', 'V_NO_MATCH'], ['Баланс 999,00 € (по инструкции из заметки)', 'V_NO_MATCH'], ['через 6 недель', 'V_UNIT'], ['около 0,4 тыс. €', 'V_ABBREVIATION']]) {
    const v = literal(t);
    assert.equal(v.ok, false, t);
    assert.ok(codes(v.violations).includes('V_RAW_DIGIT'), t);
    assert.ok(codes(v.violations).includes(extra), t);
  }
  const lit_ok = literal('Шаг 1: проверьте дату поступления');
  assert.equal(lit_ok.ok, true, 'V11: «Шаг N» — не цифра вне плейсхолдера');
});

test('TST-45 слой 1: V_CALL, V_PLACEHOLDER, V_REF (evidence, эхо, ключ каталога), V_RAW_DIGIT, V_SHORTAGE (C-067) и корректные случаи', () => {
  const claim = (over) => ({ call: R.call_id, tpl: null, t: 'Минимум {e3}.', refs: ['e3'], scope: { mode: 'worse', scenario_id: null }, ...over });
  const check = (c, extra = {}) => codes(check_structure({ claims: [c], ...extra }, [R], { echo: ECHO }));
  assert.deepEqual(check(claim({})), []);
  assert.deepEqual(check(claim({ call: 'deadbeef' })), ['V_CALL']);
  assert.deepEqual(check(claim({ refs: [] })), ['V_PLACEHOLDER'], '{e3} не из refs');
  assert.deepEqual(check(claim({ t: 'Минимум {e99}.', refs: ['e99'] })), ['V_REF'], 'нет такого evidence');
  assert.deepEqual(check(claim({ t: 'Минимум {e99}.', refs: [] })).sort(), ['V_PLACEHOLDER', 'V_REF']);
  assert.deepEqual(check(claim({ t: 'Через {q.days} и {q.unknown}.', refs: [] })), ['V_REF'], 'эхо q.unknown нет; q.days есть');
  assert.deepEqual(check(claim({ t: 'Минимум {plan.m_after}.', refs: [] })), ['V_PLACEHOLDER'], 'неразрешённый слот каталога');
  assert.deepEqual(check(claim({ t: 'Минимум {e3} и 5 ещё.' })), ['V_RAW_DIGIT']);
  assert.deepEqual(check(claim({ t: 'Минимум {e3}.', refs: ['e3'] }), { caveats: ['CAV.NOT_ADVICE'], followups: ['FU.CHECK_DATA'] }), []);
  assert.deepEqual(check(claim({}), { caveats: ['CAV.NO_SUCH'] }), ['V_REF']);
  assert.deepEqual(check(claim({}), { followups: ['что-то ещё'] }), ['V_REF']);
  // «Шаг N» и «N.» в начале строки — не цифры вне плейсхолдеров
  assert.deepEqual(check(claim({ t: 'Шаг 2: см. {e3}.\n3. Готово.' })), []);
  // V_SHORTAGE: свободный текст со ссылкой на дефицит (gap / short_to_buffer_minor) — только шаблонами с подписью ряда
  const lowm = mk(LOW);
  const w = lowm.call('list_waves', { from: '2026-10-04', to: '2026-11-30', mode: 'plan' });
  const gap_ref = w.facts.waves[0].gap;
  const short = { call: w.call_id, tpl: null, t: `Не хватает {${gap_ref}}.`, refs: [gap_ref], scope: { mode: 'plan', scenario_id: null } };
  assert.deepEqual(codes(check_structure({ claims: [short] }, [w], { echo: [] })), ['V_SHORTAGE']);
  // число дефицита допустимо только через ТОЧНЫЙ текст шаблона с подписью ряда (то, что строит движок); подпись «tpl» у свободного текста
  // права не даёт (баг D-01: V_SHORTAGE обходился любым непустым tpl)
  assert.deepEqual(codes(check_structure({ claims: [{ ...short, tpl: 'WAVES.ONE' }] }, [w], { echo: [] })), ['V_SHORTAGE'], 'свободный текст с чужой подписью tpl — всё равно V_SHORTAGE');
  const one = fallback_answer(w, 'ru').claims.find((x) => x.tpl === 'WAVES.ONE');
  assert.ok(one !== undefined && one.refs.includes(gap_ref), 'контроль: шаблон WAVES.ONE ссылается на дефицит');
  assert.deepEqual(codes(check_structure({ claims: [one] }, [w], { echo: [] })), [], 'то же число через точный шаблон с подписью ряда допустимо');
  const p = lowm.call('get_projection', { to: '2026-11-30', mode: 'plan' });
  const sb = p.facts.short_to_buffer_minor;
  assert.deepEqual(codes(check_structure({ claims: [{ call: p.call_id, tpl: null, t: `Не хватает {${sb}}.`, refs: [sb], scope: { mode: 'plan', scenario_id: null } }] }, [p], { echo: [] })), ['V_SHORTAGE']);
});

test('TST-45 слой 2: V_UNITLESS, V_PRECISION, V_AMBIGUOUS_NUMBER, V_SPELLED, V_RELATIVE_DATE, V_BAD_DATE, V_MARKUP, V_UNIT; пусто — проходит', () => {
  const v = (t, locale = 'ru') => codes(verify_text(t, POOL, locale));
  assert.deepEqual(v('Здесь нет чисел вообще.'), [], 'нет чисел — нечего сверять');
  assert.deepEqual(v('Остаток 7 дней'), ['V_NO_MATCH'], '7 дней — нет в evidence');
  assert.deepEqual(v('номер 7'), ['V_UNITLESS']);
  assert.deepEqual(v('410,000 €'), ['V_PRECISION'], 'знаков больше, чем в валюте');
  assert.deepEqual(v('1,234.56 €'), ['V_AMBIGUOUS_NUMBER'], '«1,234.56» в ru');
  assert.deepEqual(v('1.234,56 €', 'en'), ['V_AMBIGUOUS_NUMBER'], '«1.234,56» в en');
  assert.deepEqual(v('Баланс ٩٩٩ €'), ['V_AMBIGUOUS_NUMBER'], 'арабо-индийские цифры — не пропускаем');
  assert.deepEqual(v('Баланс ９９９ €'), ['V_AMBIGUOUS_NUMBER'], 'полноширинные цифры');
  assert.deepEqual(v('Баланс ½ €'), ['V_AMBIGUOUS_NUMBER']);
  assert.deepEqual(codes(check_structure({ claims: [{ call: R.call_id, tpl: null, t: 'Минимум {e3} и ٩٩٩.', refs: ['e3'], scope: { mode: 'worse', scenario_id: null } }] }, [R], { echo: ECHO })), ['V_RAW_DIGIT']);
  assert.deepEqual(v('сорок два дня'), ['V_SPELLED']);
  assert.deepEqual(v('two weeks'), ['V_SPELLED'], 'числительное словами + единица');
  assert.deepEqual(v('завтра придёт платёж'), ['V_RELATIVE_DATE']);
  assert.deepEqual(v('see you tomorrow', 'en'), ['V_RELATIVE_DATE']);
  assert.deepEqual(v('31 ноября'), ['V_BAD_DATE']);
  assert.deepEqual(v('2026-02-30'), ['V_BAD_DATE']);
  assert.deepEqual(v('![](https://evil.example/?d=1)'), ['V_MARKUP']);
  assert.deepEqual(v('[ссылка](http://evil.example)'), ['V_MARKUP']);
  assert.deepEqual(v('<img src=x onerror=1>'), ['V_MARKUP']);
  assert.deepEqual(v('https://evil.example/x?y=2'), ['V_MARKUP']);
  assert.deepEqual(v('через 2 года'), ['V_UNIT']);
  assert.deepEqual(v('around 3 hours', 'en'), ['V_UNIT']);
  // «k из n» — два счётчика; нет такого count в evidence — V_NO_MATCH
  assert.deepEqual(v('в 2 из 8 случаев'), ['V_NO_MATCH', 'V_NO_MATCH'], 'оба счётчика сверяются отдельно');
  // даты: с годом и без; год проверяется, если назван
  assert.deepEqual(v('14 ноября'), []);
  assert.deepEqual(v('14 ноября 2026 г.'), []);
  assert.deepEqual(v('14.11.2026'), []);
  assert.deepEqual(v('2026-11-14'), []);
  assert.deepEqual(v('14 ноября 2027'), ['V_NO_MATCH'], 'год назван и не совпал');
  assert.deepEqual(v('November 14', 'en'), []);
  assert.deepEqual(v('14 November 2026', 'en'), []);
  assert.deepEqual(v('Nov 14', 'en'), []);
});

test('TST-45 слой 2: unitless-число проходит, если в пуле есть счётчик с тем же значением (count)', () => {
  const pool = [{ id: 'e1', kind: 'count', v: 3, event_ids: [] }];
  assert.deepEqual(verify_text('изменено записей: 3', pool), []);
  assert.deepEqual(codes(verify_text('изменено записей: 4', pool)), ['V_UNITLESS']);
  assert.deepEqual(verify_text('3 платежа', pool), []);
  assert.deepEqual(codes(verify_text('4 платежа', pool)), ['V_NO_MATCH']);
  assert.deepEqual(verify_text('в 3 из 3 случаев', pool), []);
  assert.deepEqual(codes(verify_text('в 3 из 8 случаев', pool)), ['V_NO_MATCH'], 'второй счётчик не совпал — нарушение (fail-closed)');
});

// ── TV-3: разбор ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('TST-45 TV-3 extract_quantities: нормализация N1…N6 (деньги, сокращения, знак, проценты, даты)', () => {
  const one = (t, locale = 'ru') => extract_quantities(t, locale);
  // N1
  const n1 = one(`1${NBSP}234,56${NBSP}€`);
  assert.equal(n1.length, 1);
  assert.deepEqual([n1[0].kind, n1[0].cur, n1[0].digits, n1[0].dp, n1[0].neg], ['money', 'EUR', '123456', 2, false]);
  assert.equal(one('1 234,56 €')[0].digits, '123456', 'обычный пробел как разделитель тысяч');
  // N2: «€7 600» → 7600, dp 0; при evidence 760000 допуск ±50 minor
  const n2 = one('€7 600')[0];
  assert.deepEqual([n2.kind, n2.digits, n2.dp, n2.cur], ['money', '7600', 0, 'EUR']);
  const ev = { id: 'e1', kind: 'money', v: 760000, cur: 'EUR', dp: 2, event_ids: [] };
  assert.equal(match_quantity(n2, { ...ev, v: 760050 }), true);
  assert.equal(match_quantity(n2, { ...ev, v: 760080 }), false);
  assert.equal(match_quantity(n2, { ...ev, v: 759950 }), true, 'граница включена');
  assert.equal(match_quantity(n2, { ...ev, v: 759949 }), false);
  // N3
  assert.equal(one('7.6k')[0].kind, 'abbrev');
  assert.equal(one('7.6k', 'en')[0].normalized, '7.6');
  assert.equal(one('7.6k', 'en')[0].kind, 'abbrev');
  // N4: три вида знака
  for (const t of ['−90,00 €', '-90,00 €', '–90,00 €', '−€90.00']) {
    const q = one(t, t.includes('.') ? 'en' : 'ru')[0];
    assert.deepEqual([q.kind, q.neg, q.digits], ['money', true, '9000'], t);
  }
  // N5
  const n5 = one('12,5 %')[0];
  assert.deepEqual([n5.kind, n5.digits, n5.dp], ['pct', '125', 1]);
  assert.equal(match_quantity(n5, { id: 'e1', kind: 'pct_bp', v: 1250, event_ids: [] }), true);
  assert.equal(match_quantity(n5, { id: 'e1', kind: 'pct_bp', v: 1256, event_ids: [] }), false);
  // N6
  assert.deepEqual(one('14.11.2026').map((q) => [q.kind, q.y, q.m, q.d]), [['date', 2026, 11, 14]]);
  assert.deepEqual(one('14 ноября 2026 г.').map((q) => [q.kind, q.y, q.m, q.d]), [['date', 2026, 11, 14]]);
  assert.deepEqual(one('31 ноября').map((q) => q.kind), ['bad_date']);
  assert.deepEqual(one('завтра').map((q) => q.kind), ['relative_date']);
  // порядок проходов и маски: «14 дней» не путается с датой «14 ноября»
  assert.deepEqual(one('14 дней, 14 ноября, 14,00 €').map((q) => q.kind), ['days', 'date', 'money']);
  assert.deepEqual(one('Шаг 3: 41 день').map((q) => q.kind), ['days'], '«Шаг N» пропускается');
  assert.deepEqual(one('в 2 из 8 случаев').map((q) => [q.kind, q.n]), [['count', 2], ['count', 8]], '«k из n» — два счётчика');
  assert.deepEqual(one('300 EUR').map((q) => [q.kind, q.cur, q.digits]), [['money', 'EUR', '300']]);
  assert.deepEqual(one('EUR 300.50', 'en').map((q) => [q.kind, q.cur, q.digits, q.dp]), [['money', 'EUR', '30050', 2]]);
  assert.deepEqual(one('1 000 000 ₽').map((q) => [q.kind, q.cur, q.digits]), [['money', 'RUB', '1000000']]);
  assert.deepEqual(one('€1,234.56', 'en')[0].digits, '123456');
  assert.deepEqual(one('Покупка 300,00 € на 12 октября.').map((q) => q.index), [8, 25].map((_i, k) => one('Покупка 300,00 € на 12 октября.')[k].index), 'индексы по возрастанию');
  // дата в конце en-предложения не путается с десятичной записью денег
  assert.deepEqual(one('costs €9.50.', 'en').map((q) => [q.kind, q.digits, q.dp]), [['money', '950', 2]]);
});

test('match_quantity: даты, дни, счётчики, деньги (валюта, знак, нуль, допуск по точности текста); ложные виды не совпадают', () => {
  const d = { id: 'e1', kind: 'date', v: '2026-11-14', event_ids: [] };
  assert.equal(match_quantity({ kind: 'date', y: null, m: 11, d: 14 }, d), true);
  assert.equal(match_quantity({ kind: 'date', y: 2026, m: 11, d: 14 }, d), true);
  assert.equal(match_quantity({ kind: 'date', y: 2027, m: 11, d: 14 }, d), false);
  assert.equal(match_quantity({ kind: 'date', y: null, m: 11, d: 15 }, d), false);
  assert.equal(match_quantity({ kind: 'days', n: 41 }, { kind: 'days', v: 41 }), true);
  assert.equal(match_quantity({ kind: 'days', n: 41 }, { kind: 'count', v: 41 }), false, 'вид должен совпасть');
  assert.equal(match_quantity({ kind: 'count', n: 3 }, { kind: 'count', v: 3 }), true);
  const m = (v) => ({ id: 'e1', kind: 'money', v, cur: 'EUR', dp: 2, event_ids: [] });
  const q = (digits, dp, neg = false, cur = 'EUR') => ({ kind: 'money', digits, dp, neg, cur });
  assert.equal(match_quantity(q('41000', 2), m(41000)), true);
  assert.equal(match_quantity(q('41000', 2), m(41001)), false, 'два знака — допуск 0: точное совпадение');
  assert.equal(match_quantity(q('410', 0), m(41050)), true, '±0,50 € включительно');
  assert.equal(match_quantity(q('410', 0), m(41051)), false);
  assert.equal(match_quantity(q('4100', 1), m(41004)), true);
  assert.equal(match_quantity(q('4100', 1), m(41006)), false);
  assert.equal(match_quantity(q('41000', 2, false, 'USD'), m(41000)), false);
  assert.equal(match_quantity(q('41000', 2, true), m(41000)), false, 'знак');
  assert.equal(match_quantity(q('41000', 2, true), m(-41000)), true);
  assert.equal(match_quantity(q('0', 0, true), m(-30)), true, 'у нуля нет знака: «−0 €» для −0,30 € проходит');
  assert.equal(match_quantity(q('0', 0), m(-30)), true);
  assert.equal(match_quantity(q('0', 0), m(-51)), false);
  assert.equal(match_quantity(q('410000', 3), m(41000)), false, 'точность больше валютной');
  assert.equal(match_quantity({ kind: 'abbrev' }, m(1)), false);
  assert.equal(match_quantity(q('1', 0), { id: 'e1', kind: 'days', v: 1, event_ids: [] }), false);
});

// ── рендер ────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('TST-47 рендер TV-1 (ALG-12): текст шаблона Q3.FRAGILE на evidence G-001 совпадает с каноном и проходит verify_answer', () => {
  const ans = fallback_answer(R, 'ru');
  assert.equal(ans.claims.length, 1);
  assert.equal(ans.claims[0].tpl, 'Q3.FRAGILE');
  assert.deepEqual(ans.claims[0].refs, ['e1', 'e2', 'e3', 'e4', 'e5', 'e8']);
  assert.deepEqual(ans.claims[0].scope, { mode: 'both', scenario_id: null });
  const text = render_claim(ans.claims[0], R, 'ru', ECHO);
  assert.equal(norm_space(text), 'Покупка 300,00 € на 12 октября: в заданных допущениях минимум свободных денег по плану — 635,00 € (1 ноября); '
    + 'если выплата придёт на 14 дней позже — 410,00 € (14 ноября), это ниже буфера 500,00 €. Оценка: хрупко. '
    + 'Самая ранняя дата, с которой сумма держится в буфере в режиме «если хуже», — 20 ноября.');
  assert.deepEqual(verify_answer(ans, [R], { echo: ECHO, locale: 'ru' }), { ok: true, violations: [] });
  // en
  const en = render_answer(fallback_answer(R, 'en'), [R], 'en', ECHO);
  assert.match(en, /^Purchase of €300\.00 on October 12: /);
  assert.match(en, /€635\.00 \(November 1\)/);
  assert.match(en, /€410\.00 \(November 14\), below the buffer of €500\.00\. Assessment: fragile\./);
  assert.match(en, /is November 20\./);
  assert.deepEqual(verify_answer(fallback_answer(R, 'en'), [R], { echo: ECHO, locale: 'en' }), { ok: true, violations: [] });
  // render_answer добавляет оговорки каталога
  assert.match(render_answer(ans, [R], 'ru', ECHO), /не рекомендация\.$/);
  assert.equal(render_answer({ claims: [], caveats: [], followups: [] }, [], 'ru'), '');
});

test('render: неразрешённый плейсхолдер и неизвестный ключ каталога — E_SCHEMA; без эхо шаблоны с {q.…} не рендерятся', () => {
  const ans = fallback_answer(R, 'ru');
  assert.throws(() => render_claim(ans.claims[0], R, 'ru', []), (e) => e.code === 'E_SCHEMA');
  assert.throws(() => render_claim({ call: R.call_id, tpl: 'NO.SUCH' }, R, 'ru', ECHO), (e) => e.code === 'E_SCHEMA');
  assert.throws(() => render_claim({ call: R.call_id, t: 'Значение {e99}.' }, R, 'ru', ECHO), (e) => e.code === 'E_SCHEMA');
  assert.throws(() => render_answer({ claims: [{ call: 'deadbeef', t: 'x' }] }, [R], 'ru'), (e) => e.code === 'E_SCHEMA');
  assert.throws(() => render_answer({ claims: [], caveats: ['NO.SUCH'] }, [R], 'ru'), (e) => e.code === 'E_SCHEMA');
  assert.throws(() => templates('de'), (e) => e.code === 'E_SCHEMA');
  assert.throws(() => render_value({ kind: 'money', v: 1, cur: 'EUR' }, 'de'), (e) => e.code === 'E_SCHEMA');
});

test('TST-58 render_value: money (ru NBSP, en €1,234.56, знак U+2212, код без символа, dp), date (год ≠ as_of), pct_bp, days, count, enum', () => {
  const m = (v, extra = {}) => ({ kind: 'money', v, cur: 'EUR', dp: 2, ...extra });
  assert.equal(render_value(m(123456), 'ru'), `1${NBSP}234,56${NBSP}€`);
  assert.equal(render_value(m(123456), 'en'), '€1,234.56');
  assert.equal(render_value(m(-9000), 'ru'), `${'−'}90,00${NBSP}€`);
  assert.equal(render_value(m(-9000), 'en'), '−€90.00');
  assert.equal(render_value(m(0), 'ru'), `0,00${NBSP}€`);
  assert.equal(render_value(m(-30, { dp: 0 }), 'ru'), `0${NBSP}€`, 'округление до нуля — без знака');
  assert.equal(render_value(m(760000, { dp: 0 }), 'ru'), `7${NBSP}600${NBSP}€`);
  assert.equal(render_value(m(12350, { dp: 0 }), 'ru'), `124${NBSP}€`, 'half_even: 123,5 → 124');
  assert.equal(render_value(m(12250, { dp: 0 }), 'ru'), `122${NBSP}€`, 'half_even: 122,5 → 122');
  assert.equal(render_value(m(123456, { cur: 'CHF' }), 'ru'), `1${NBSP}234,56${NBSP}CHF`);
  assert.equal(render_value(m(123456, { cur: 'CHF' }), 'en'), '1,234.56' + NBSP + 'CHF');
  assert.equal(render_value({ kind: 'money', v: 1234, cur: 'JPY', dp: 0 }, 'en'), '1,234' + NBSP + 'JPY');
  assert.equal(render_value({ kind: 'money', v: 123456789, cur: 'BTC', dp: 8 }, 'en'), '1.23456789' + NBSP + 'BTC');
  const d = { kind: 'date', v: '2026-11-14' };
  assert.equal(render_value(d, 'ru', '2026-10-04'), '14 ноября');
  assert.equal(render_value(d, 'ru', '2025-12-01'), '14 ноября 2026');
  assert.equal(render_value(d, 'en', '2026-10-04'), 'November 14');
  assert.equal(render_value(d, 'en', '2027-01-01'), 'November 14, 2026');
  assert.equal(render_value(d, 'ru'), '14 ноября', 'без as_of год не показывается');
  assert.equal(render_value({ kind: 'pct_bp', v: 17000 }, 'ru'), `170${NBSP}%`);
  assert.equal(render_value({ kind: 'pct_bp', v: 1250 }, 'ru'), `12,5${NBSP}%`);
  assert.equal(render_value({ kind: 'pct_bp', v: 1250 }, 'en'), `12.5${NBSP}%`);
  assert.equal(render_value({ kind: 'pct_bp', v: 4147 }, 'ru'), `41,47${NBSP}%`);
  assert.equal(render_value({ kind: 'pct_bp', v: -50 }, 'ru'), `${'−'}0,5${NBSP}%`);
  assert.equal(render_value({ kind: 'days', v: 41 }, 'ru'), '41 день');
  assert.equal(render_value({ kind: 'days', v: 14 }, 'en'), '14 days');
  assert.equal(render_value({ kind: 'count', v: 3 }, 'ru'), '3');
  assert.equal(render_value({ kind: 'enum', v: 'FRAGILE' }, 'ru'), 'хрупко');
  assert.equal(render_value({ kind: 'enum', v: 'worse' }, 'en'), 'if worse');
});

test('TST-58 plural: ru «1 день», «2 дня», «5 дней», «21 день», «22 дня», «11…14 дней»; en «1 day», «2 days»', () => {
  const ru = (n) => `${n} ${plural('ru', n, ['день', 'дня', 'дней'])}`;
  assert.deepEqual([1, 2, 5, 21, 22, 11, 12, 13, 14, 0, 100, 101, 111, 112, 121].map(ru), [
    '1 день', '2 дня', '5 дней', '21 день', '22 дня', '11 дней', '12 дней', '13 дней', '14 дней', '0 дней', '100 дней', '101 день', '111 дней', '112 дней', '121 день',
  ]);
  const en = (n) => `${n} ${plural('en', n, ['day', 'days'])}`;
  assert.deepEqual([0, 1, 2, 21].map(en), ['0 days', '1 day', '2 days', '21 days']);
  assert.throws(() => plural('de', 1, ['a', 'b']), (e) => e.code === 'E_SCHEMA');
  for (const n of [1, 2, 5, 21, 22, 41, 111]) assert.equal(render_value({ kind: 'days', v: n }, 'ru'), ru(n));
});

test('TST-45 инвариант 5: значение evidence, показанное с любым 0 ≤ dp ≤ exponent (в том числе при ничьей), проходит match_quantity — ru и en, ±, 4·10³ случаев', () => {
  const rng = make_rng(4505);
  let n = 0;
  for (let i = 0; i < 4000; i++) {
    const kind = rng.pick(['money', 'money', 'money', 'pct_bp']);
    const v = rng.pick([rng.int(-5_000_000, 5_000_000), rng.int(-300, 300), rng.int(0, 99) * 50, rng.int(-999, 999) * 100 + 50]);
    const ev = kind === 'money'
      ? { id: 'e1', kind, v, cur: rng.pick(['EUR', 'USD', 'JPY', 'CHF', 'BTC']), dp: 0, event_ids: [] }
      : { id: 'e1', kind, v, event_ids: [] };
    if (kind === 'money') ev.dp = rng.int(0, ev.cur === 'JPY' ? 0 : ev.cur === 'BTC' ? 8 : 2);
    const locale = rng.pick(['ru', 'en']);
    const text = render_value(ev, locale);
    const qs = extract_quantities(text, locale);
    assert.equal(qs.length, 1, `${locale} «${text}»: одно количество, получено ${qs.map((q) => q.kind)}`);
    assert.equal(qs[0].kind, kind === 'money' ? 'money' : 'pct', text);
    assert.ok(match_quantity(qs[0], ev), `${locale} «${text}» не прошёл match_quantity: ${JSON.stringify(ev)}`);
    n += 1;
  }
  assert.equal(n, 4000);
  // даты и дни: все 366 дат года и дни 0…400 — round-trip
  for (let d = 0; d < 366; d++) {
    const iso = new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10);
    const ev = { id: 'e1', kind: 'date', v: iso, event_ids: [] };
    for (const locale of ['ru', 'en']) {
      const qs = extract_quantities(render_value(ev, locale, '2026-06-15'), locale);
      assert.equal(qs.length, 1);
      assert.ok(match_quantity(qs[0], ev), `${locale} ${iso}`);
    }
  }
  for (let k = 0; k <= 400; k++) {
    const ev = { id: 'e1', kind: 'days', v: k, event_ids: [] };
    for (const locale of ['ru', 'en']) {
      const qs = extract_quantities(render_value(ev, locale), locale);
      assert.deepEqual(qs.map((q) => q.kind), ['days']);
      assert.ok(match_quantity(qs[0], ev), `${locale} ${k}`);
    }
  }
});

test('TST-45 свойство: слово «ноль» / отрицательный ноль / граница ±(2⁵³−1): шаблонный рендер и разбор не теряют точность (BigInt)', () => {
  const ev = { id: 'e1', kind: 'money', v: Number.MAX_SAFE_INTEGER, cur: 'EUR', dp: 2, event_ids: [] };
  const text = render_value(ev, 'ru');
  const q = extract_quantities(text, 'ru')[0];
  assert.equal(q.digits, String(Number.MAX_SAFE_INTEGER));
  assert.ok(match_quantity(q, ev));
  assert.ok(!match_quantity(q, { ...ev, v: Number.MAX_SAFE_INTEGER - 1 }));
  const neg = { ...ev, v: -Number.MAX_SAFE_INTEGER };
  const qn = extract_quantities(render_value(neg, 'en'), 'en')[0];
  assert.ok(match_quantity(qn, neg));
});

// ── каталог шаблонов A0 ───────────────────────────────────────────────────────────────────────────────────────────────

test('templates: ru и en — одинаковые ключи; цифр вне плейсхолдеров нет; плейсхолдеры допустимых видов; BEYOND содержит неотделимую оговорку (C-017)', () => {
  const ru = templates('ru');
  const en = templates('en');
  assert.deepEqual(Object.keys(ru).sort(), Object.keys(en).sort());
  assert.ok(Object.isFrozen(ru));
  for (const loc of ['ru', 'en']) {
    const T = templates(loc);
    for (const [k, t] of Object.entries(T)) {
      const stripped = t.replace(/\{[^{}]*\}/g, '');
      assert.ok(!/\d/.test(stripped), `${loc} ${k}: цифра вне плейсхолдера`);
      for (const m of t.matchAll(/\{([^{}|]*)(?:\|[^{}]*)?\}/g)) assert.match(m[1], /^(?:q\.[a-z0-9_]+|@[a-z]+|flag\.[a-z_]+|[a-z_]+(?:\.[a-z0-9_]+)*)$/, `${loc} ${k}: плейсхолдер «${m[1]}»`);
      assert.equal((t.match(/\[\[/g) ?? []).length, (t.match(/\]\]/g) ?? []).length, `${loc} ${k}: скобки [[ ]]`);
    }
    for (const verdict of ['OK', 'FRAGILE', 'TIGHT', 'NO']) {
      assert.ok(T['Q3.' + verdict] && T['Q3.' + verdict + '.BEYOND'], `${loc} Q3.${verdict}`);
      assert.ok(T['Q3.' + verdict + '.BEYOND'].startsWith(T['Q3.' + verdict]), 'BEYOND = тот же текст + оговорка (неотделима)');
      assert.match(T['Q3.' + verdict + '.BEYOND'], /\{beyond_horizon_minor\}/);
      assert.ok(!T['Q3.' + verdict].includes('beyond_horizon_minor'));
    }
    for (const reason of ['readiness', 'stale', 'no_anchor', 'no_buffer', 'rule_disabled', 'generic']) assert.ok(T['INSUFFICIENT.' + reason], reason);
  }
  assert.match(ru['Q3.OK.BEYOND'], /не все платежи учтены: \{beyond_horizon_minor\} за горизонтом/i);
  // слова вердиктов Q3 — только из словаря (vocab.json)
  for (const [v, label] of Object.entries(LABELS.verdicts.ru)) assert.ok(ru['Q3.' + v].includes('Оценка: ' + label), v);
  for (const [v, label] of Object.entries(LABELS.verdicts.en)) assert.ok(en['Q3.' + v].includes('Assessment: ' + label), v);
});

test('LABELS согласованы с vocab.json: режимы, вердикты (RU/EN)', () => {
  const vocab = JSON.parse(fs.readFileSync(new URL('../engine/vocab.json', import.meta.url), 'utf8'));
  for (const loc of ['ru', 'en']) {
    for (const m of ['plan', 'worse']) assert.equal(LABELS.modes[loc][m], vocab.modes[m][loc].split(' (')[0], `${loc} ${m}`);
    for (const k of ['OK', 'TIGHT', 'FRAGILE', 'NO']) assert.equal(LABELS.verdicts[loc][k], vocab.verdicts[k][loc], `${loc} ${k}`);
  }
  assert.deepEqual(Object.keys(LABELS.causes.ru).sort(), ['estimate', 'income_delay', 'obligation', 'other', 'sinking_payment', 'tax_payment']);
  assert.deepEqual(Object.keys(LABELS.causes.en).sort(), Object.keys(LABELS.causes.ru).sort());
  assert.deepEqual(Object.keys(LABELS.kinds.en).sort(), Object.keys(LABELS.kinds.ru).sort());
});

/** Все вызовы инструментов на наборе данных (для свойства «каждый шаблон проходит верификатор»). */
function all_calls(ws) {
  const m = mk(ws);
  const calls = [
    ['check_purchase', TV1], ['check_purchase', { ...TV1, amount_minor: 15000 }], ['check_purchase', { ...TV1, amount_minor: 60000 }], ['check_purchase', { ...TV1, amount_minor: 120000 }],
    ['check_purchase', { date: '2026-10-12', amount_minor: 48333, currency: 'EUR', parts: [{ date: '2026-10-12', amount_minor: 30000 }, { date: '2027-01-01', amount_minor: 18333 }] }],
    ['check_purchase', { date: '2026-12-01', amount_minor: 100, currency: 'EUR' }],
    ['get_projection', { to: '2026-11-30' }], ['get_projection', { to: '2026-11-30', mode: 'plan' }], ['get_projection', { to: '2026-10-31', mode: 'plan' }], ['get_projection', { to: '2027-01-01' }],
    ['max_purchase_amount', { date: '2026-10-12' }], ['max_purchase_amount', { date: '2026-12-01' }],
    ['earliest_safe_date', { amount_minor: 30000, currency: 'EUR' }], ['earliest_safe_date', { amount_minor: 90000, currency: 'EUR', mode: 'plan' }],
    ['list_waves', { from: '2026-10-04', to: '2026-11-30' }], ['list_waves', { from: '2026-10-04', to: '2026-11-30', mode: 'plan' }], ['list_waves', { from: '2026-12-01', to: '2026-12-02' }],
    ['explain_min_point', {}], ['explain_min_point', { mode: 'plan' }],
    ['run_scenario', { ops: [{ op: 'add_purchase', date: '2026-10-12', amount_minor: 30000, currency: 'EUR' }] }],
    ['get_tax_envelope', {}], ['get_tax_envelope', { as_of: '2026-11-30' }], ['get_tax_envelope', { as_of: '2026-12-01' }],
  ];
  if (ws === G) calls.push(['run_scenario', { ops: [{ op: 'delay_income', event_ref: 'S-HOURLY@2026-11-05', days: 14 }] }]);
  return { m, calls };
}

test('TST-45 каждый шаблон A0 проходит верификатор: все инструменты × G-001, -low, -gap, -late × ru/en; fallback_answer всегда проходит verify_answer', () => {
  const used = new Set();
  let n = 0;
  for (const ws of [G, LOW, GAP, LATE]) {
    const { m, calls } = all_calls(ws);
    for (const [name, args] of calls) {
      const r = m.call(name, args);
      assert.ok(!r.isError, `${ws.workspace_id} ${name} ${JSON.stringify(args)}: ${JSON.stringify(r)}`);
      const echo = build_echo([{ name, args }], m.ctx.params, 'EUR');
      for (const locale of ['ru', 'en']) {
        const ans = fallback_answer(r, locale);
        for (const c of ans.claims) used.add(c.tpl);
        const v = verify_answer(ans, [r], { echo, locale });
        assert.deepEqual(v, { ok: true, violations: [] }, `${ws.workspace_id} ${name} ${locale}: ${JSON.stringify(v.violations)}`);
        const text = render_answer(ans, [r], locale, echo);
        assert.ok(text.length > 0);
        assert.ok(!/\{|\}|\[\[|\]\]/.test(text), `${locale} ${name}: остались скобки шаблона: ${text}`);
        n += 1;
      }
    }
  }
  assert.ok(n >= 4 * 22 * 2);
  for (const k of ['Q3.OK', 'Q3.FRAGILE', 'Q3.TIGHT', 'Q3.NO', 'Q3.FRAGILE.BEYOND', 'OUTSIDE', 'PROJ.OK', 'MAX.OK', 'EARLIEST.OK', 'WAVES.HEAD', 'WAVES.ONE', 'WAVES.NONE',
    'EXPLAIN.HEAD', 'EXPLAIN.CHAIN', 'EXPLAIN.CF.without', 'EXPLAIN.CF.no_delay', 'SCENARIO.OK', 'TAX.OK']) assert.ok(used.has(k), `шаблон ${k} не был проверен`);
});

test('TST-45 шаблоны гейта, инструментов with_changed и propose_change проходят верификатор (INSUFFICIENT.*, GATE.*, CHANGED.*, DRAFT.*)', () => {
  const variants = {
    no_buffer: (w) => { w.params.buffer_minor = null; },
    readiness: (w) => { w.params['ready.q3'] = 5; },
    rule_disabled: (w) => { w.tax_rules[0].reviewed_at = '2026-01-01'; w.tax_rules[0].ttl_days = 30; },
  };
  for (const [reason, patch] of Object.entries(variants)) {
    const ws = clone(G);
    patch(ws);
    const m = mk(ws);
    for (const [name, args] of [['check_purchase', TV1], ['max_purchase_amount', { date: '2026-10-12' }], ['earliest_safe_date', { amount_minor: 30000, currency: 'EUR' }], ['get_projection', { to: '2026-11-30' }]]) {
      const r = m.call(name, args);
      const gate = name === 'get_projection' ? r.facts.gate : r.facts;
      assert.equal(gate.reason, reason, `${name}`);
      const echo = build_echo([{ name, args }], m.ctx.params, 'EUR');
      for (const locale of ['ru', 'en']) {
        const ans = fallback_answer(r, locale);
        assert.deepEqual(verify_answer(ans, [r], { echo, locale }), { ok: true, violations: [] }, `${reason} ${name} ${locale}`);
        const text = render_answer(ans, [r], locale, echo);
        if (name !== 'get_projection') assert.ok(text.includes(templates(locale)['INSUFFICIENT.' + reason]), text);
        else assert.ok(text.includes(templates(locale)['GATE.' + reason]), text);
      }
    }
  }
  // устаревший якорь
  const stale = make_tool_ctx(G, { as_of: '2026-11-10' });
  stale.calls_used = 0;
  const rs = run_tool('check_purchase', { date: '2026-11-12', amount_minor: 100, currency: 'EUR' }, stale);
  const ans = fallback_answer(rs, 'ru');
  assert.equal(ans.claims[0].tpl, 'INSUFFICIENT.stale');
  assert.deepEqual(ans.followups, ['FU.CHECK_ANCHOR']);
  assert.deepEqual(verify_answer(ans, [rs], { echo: [], locale: 'ru' }), { ok: true, violations: [] });
  // propose_change (T1): черновик
  const t1 = mk(G, { t1_enabled: true });
  const draft = t1.call('propose_change', { ops: [{ op: 'move_plan', ref: 'P-TAX1', date: '2026-10-30' }, { op: 'skip_plan', ref: 'P-TAX1' }, { op: 'add_plan', date: '2026-10-20', amount_minor: -5000, currency: 'EUR' }] });
  for (const locale of ['ru', 'en']) {
    const a = fallback_answer(draft, locale);
    assert.deepEqual(a.claims.map((c) => c.tpl), ['DRAFT.OK', 'DRAFT.MOVE', 'DRAFT.SKIP', 'DRAFT.ADD']);
    assert.deepEqual(verify_answer(a, [draft], { echo: [], locale }), { ok: true, violations: [] });
  }
});

test('Q3 с частью за горизонтом: оговорка «не все платежи учтены: X за горизонтом» — в самом утверждении (C-017)', () => {
  const m = mk();
  const args = { date: '2026-10-12', amount_minor: 48333, currency: 'EUR', parts: [{ date: '2026-10-12', amount_minor: 30000 }, { date: '2027-01-01', amount_minor: 18333 }] };
  const r = m.call('check_purchase', args);
  const ans = fallback_answer(r, 'ru');
  assert.equal(ans.claims.length, 1);
  assert.equal(ans.claims[0].tpl, 'Q3.FRAGILE.BEYOND');
  const echo = build_echo([{ name: 'check_purchase', args }], m.ctx.params, 'EUR');
  const text = norm_space(render_answer(ans, [r], 'ru', echo));
  assert.match(text, /Не все платежи учтены: 183,33 € за горизонтом\./);
  assert.deepEqual(verify_answer(ans, [r], { echo, locale: 'ru' }), { ok: true, violations: [] });
});

test('verify_answer: результат не зависит от порядка утверждений; ответ без утверждений — ok; утверждения с разными call', () => {
  const w = BASE.call('list_waves', { from: '2026-10-04', to: '2026-11-30', mode: 'plan' });
  const echo = [...ECHO, ...build_echo([{ name: 'list_waves', args: { from: '2026-10-04', to: '2026-11-30' } }], BASE.ctx.params, 'EUR')];
  const a1 = fallback_answer(R, 'ru');
  const a2 = fallback_answer(w, 'ru');
  const bad = { call: R.call_id, tpl: null, t: 'Минимум 401,00 €.', refs: [], scope: { mode: 'worse', scenario_id: null } };
  const claims = [...a1.claims, ...a2.claims, bad];
  const base = verify_answer({ claims }, [R, w], { echo, locale: 'ru' });
  assert.equal(base.ok, false);
  const key = (v) => JSON.stringify({ code: v.code, raw: v.raw ?? null });
  const sorted = (vs) => vs.map(key).sort();
  const rng = make_rng(7);
  for (let i = 0; i < 20; i++) {
    const shuffled = [...claims].sort(() => rng.next() - 0.5);
    const v = verify_answer({ claims: shuffled }, [R, w], { echo, locale: 'ru' });
    assert.equal(v.ok, base.ok);
    assert.deepEqual(sorted(v.violations), sorted(base.violations), 'нарушения те же (с точностью до индекса утверждения)');
  }
  assert.deepEqual(verify_answer({ claims: [] }, [], { echo: [], locale: 'ru' }), { ok: true, violations: [] });
  assert.deepEqual(verify_answer({ claims: [a1.claims[0], a2.claims[0]] }, [R, w], { echo, locale: 'ru' }), { ok: true, violations: [] });
});

// ── A0, команды, answer_question ───────────────────────────────────────────────────────────────────────────────────────

test('parse_command: команды A0 → {name, args}; суммы — целые minor; общий ключ --mode; неверная команда — E_SCHEMA', () => {
  assert.deepEqual(parse_command(['check-purchase', '2026-10-12', '30000', 'EUR']), { name: 'check_purchase', args: { date: '2026-10-12', amount_minor: 30000, currency: 'EUR' } });
  assert.deepEqual(parse_command(['check-purchase', '2026-10-12', '30000', 'EUR', '--buffer', '40000']).args.buffer_minor, 40000);
  assert.deepEqual(parse_command(['projection', '2026-11-30', '--mode', 'plan']), { name: 'get_projection', args: { to: '2026-11-30', mode: 'plan' } });
  assert.deepEqual(parse_command(['max-amount', '2026-10-12']), { name: 'max_purchase_amount', args: { date: '2026-10-12' } });
  assert.deepEqual(parse_command(['earliest', '30000', 'EUR', '2026-11-01']), { name: 'earliest_safe_date', args: { amount_minor: 30000, currency: 'EUR', not_before: '2026-11-01' } });
  assert.deepEqual(parse_command(['waves', '2026-10-04', '2026-11-30']), { name: 'list_waves', args: { from: '2026-10-04', to: '2026-11-30' } });
  assert.deepEqual(parse_command(['explain']), { name: 'explain_min_point', args: {} });
  assert.deepEqual(parse_command(['explain', '3']).args, { top_k: 3 });
  assert.deepEqual(parse_command(['scenario', 'delay', 'S-HOURLY@2026-11-05', '14']).args.ops, [{ op: 'delay_income', event_ref: 'S-HOURLY@2026-11-05', days: 14 }]);
  assert.deepEqual(parse_command(['scenario', 'purchase', '2026-10-12', '30000', 'EUR']).args.ops, [{ op: 'add_purchase', date: '2026-10-12', amount_minor: 30000, currency: 'EUR' }]);
  assert.deepEqual(parse_command(['changed', '2026-10-01']), { name: 'what_changed', args: { since: '2026-10-01' } });
  assert.deepEqual(parse_command(['tax']), { name: 'get_tax_envelope', args: {} });
  assert.deepEqual(parse_command(['tax', '2026-11-30']).args, { as_of: '2026-11-30' });
  assert.deepEqual(parse_command(['propose', 'skip', 'P-TAX1']).args.ops, [{ op: 'skip_plan', ref: 'P-TAX1' }]);
  assert.deepEqual(parse_command(['propose', 'move', 'P-TAX1', '2026-10-30']).args.ops, [{ op: 'move_plan', ref: 'P-TAX1', date: '2026-10-30' }]);
  assert.deepEqual(parse_command(['propose', 'add', '2026-10-20', '-5000', 'EUR']).args.ops, [{ op: 'add_plan', date: '2026-10-20', amount_minor: -5000, currency: 'EUR' }]);
  for (const bad of [[], ['что-то'], ['scenario'], ['scenario', 'x'], ['propose', 'x']]) assert.throws(() => parse_command(bad), (e) => e.code === 'E_SCHEMA', JSON.stringify(bad));
});

test('a0_answer: команда → инструмент → шаблон → проверка; ошибки — статичный текст без значений; T1 без включения — E_NOT_PERMITTED', () => {
  const m = mk();
  const a = a0_answer(['check-purchase', '2026-10-12', '30000', 'EUR'], m.ctx);
  assert.equal(a.ok, true);
  assert.equal(a.source, 'template');
  assert.equal(a.verified, true);
  assert.deepEqual(a.violations, []);
  assert.match(norm_space(a.text), /^Покупка 300,00 € на 12 октября: .* Оценка: хрупко\./);
  assert.equal(a.result.facts.verdict, 'FRAGILE');
  assert.deepEqual(a.echo.map((e) => e.id), ['q.amount', 'q.date', 'q.days']);
  assert.ok(a.text.includes('не рекомендация'));
  const en = a0_answer({ name: 'check_purchase', args: TV1 }, mk().ctx, { locale: 'en' });
  assert.match(en.text, /Assessment: fragile\./);
  // другие команды
  for (const cmd of [['projection', '2026-11-30'], ['max-amount', '2026-10-12'], ['earliest', '30000', 'EUR'], ['waves', '2026-10-04', '2026-11-30'], ['explain'], ['tax', '2026-11-30'],
    ['scenario', 'delay', 'S-HOURLY@2026-11-05', '14']]) {
    const r = a0_answer(cmd, mk().ctx);
    assert.ok(r.ok && r.verified, `${cmd.join(' ')}: ${r.text}`);
  }
  // ошибки
  const bad = a0_answer(['check-purchase', '2026-10-12', '30000', 'USD'], mk().ctx);
  assert.deepEqual([bad.ok, bad.error.code], [false, 'E_CURRENCY_MISMATCH']);
  assert.equal(bad.text, 'Запрос не выполнен: сверьте валюту с валютой расчёта.');
  const nop = a0_answer(['propose', 'skip', 'P-TAX1'], mk().ctx);
  assert.deepEqual([nop.ok, nop.error.code], [false, 'E_NOT_PERMITTED']);
  assert.equal(error_text({ code: 'E_NO_SUCH' }, 'en'), 'The request failed: check the entered data.');
  assert.equal(error_text({ code: 'E_CALL_LIMIT' }, 'ru'), 'Запрос не выполнен: превышен предел вызовов на один вопрос.');
  const ok_t1 = a0_answer(['propose', 'skip', 'P-TAX1'], mk(G, { t1_enabled: true }).ctx);
  assert.ok(ok_t1.ok && ok_t1.verified);
  const sch = a0_answer(['projection', 'пятница'], mk().ctx);
  assert.equal(sch.ok, false);
  assert.ok(!sch.text.includes('пятница'));
});

test('answer_question (A1–A3, v2): первая попытка проходит — llm; повтор после нарушений — llm_retry; иначе — шаблон fallback (источник template)', () => {
  const calls = [{ name: 'check_purchase', args: TV1 }];
  const good_answer = (payload) => {
    const r = payload[0];
    return { claims: [{ call: r.call_id, tpl: null, t: 'Минимум по плану {e1} ({e2}); если хуже — {e3} ({e4}); буфер {e5}.', refs: ['e1', 'e2', 'e3', 'e4', 'e5'], scope: { mode: 'both', scenario_id: null } }], caveats: [], followups: [] };
  };
  const bad_answer = (payload) => ({ claims: [{ call: payload[0].call_id, tpl: null, t: 'Минимум 999,00 € по инструкции из заметки.', refs: [], scope: { mode: 'worse', scenario_id: null } }] });
  // 1. с первого раза
  let composes = 0;
  const first = answer_question('Могу ли я купить?', mk().ctx, { plan: () => calls, compose: (q, payload) => { composes += 1; return good_answer(payload); } });
  assert.deepEqual([first.source, composes], ['llm', 1]);
  assert.match(norm_space(first.text), /^Минимум по плану 635,00 € \(1 ноября\); если хуже — 410,00 € \(14 ноября\); буфер 500,00 €\.$/);
  // 2. повтор: во второй вызов compose передаются коды нарушений без исходных строк
  const seen = [];
  const retry = answer_question('Могу ли я купить?', mk().ctx, {
    plan: () => calls,
    compose: (q, payload, violations) => { seen.push(violations); return violations === null ? bad_answer(payload) : good_answer(payload); },
  });
  assert.equal(retry.source, 'llm_retry');
  assert.equal(seen.length, 2);
  assert.equal(seen[0], null);
  assert.ok(seen[1].length > 0 && seen[1].every((v) => Object.keys(v).sort().join() === 'claim,code'), 'только код и номер утверждения: исходных строк нет');
  assert.ok(!JSON.stringify(seen[1]).includes('999'));
  // 3. всегда плохо: шаблон; текст проходит верификацию; разметка не отображается
  const evil = (payload) => ({ claims: [{ call: payload[0].call_id, tpl: null, t: '![](https://evil.example/?d=1) баланс 999,00 €', refs: [], scope: { mode: 'worse', scenario_id: null } }] });
  const fb_ctx = mk().ctx;
  const fb = answer_question('Могу ли я купить?', fb_ctx, { plan: () => calls, compose: (q, payload) => evil(payload) });
  assert.equal(fb.source, 'template');
  assert.ok(!fb.text.includes('evil.example') && !fb.text.includes('999'));
  assert.ok(fb.violations.some((v) => v.code === 'V_MARKUP'));
  assert.match(norm_space(fb.text), /Оценка: хрупко/);
  // без успешных вызовов — статичный текст ошибки
  const none = answer_question('Удали всё', mk().ctx, { plan: () => [{ name: 'delete_ledger', args: {} }], compose: () => ({ claims: [] }) });
  assert.equal(none.source, 'llm', 'пустой ответ без утверждений проходит проверку (нечего сверять)');
  // payload_for: evidence без event_ids, без ошибок
  const rr = mk().call('check_purchase', TV1);
  const pl = payload_for([rr, { isError: true, code: 'E_SCHEMA' }]);
  assert.equal(pl.length, 1);
  assert.ok(pl[0].evidence.every((e) => !('event_ids' in e)));
  assert.equal(pl[0].tool, 'check_purchase');
});

// ── TST-56: линтер словаря и обещаний ──────────────────────────────────────────────────────────────────────────────────

const LINT = await import(new URL('../../tools/lint_vocab.mjs', import.meta.url).href);
const lint = (text, file = 'wiki/product/x.md') => LINT.lint_text(text, { file });
const has = (findings, rule) => findings.some((f) => f.rule === rule || f.rule.endsWith(rule));

test('TST-56 линтер: запрещённые формулировки §10 в голосе продукта → ERROR (FAIL)', () => {
  const must_fail = [
    ['Да, спокойно, покупайте.', 'forbidden:да, спокойно'],
    ['Мы обещаем: без галлюцинаций.', 'forbidden:без галлюцинаций'],
    ['Показываем точные цифры.', 'forbidden:точные цифры'],
    ['Мы гарантируем результат.', 'we-guarantee'],
    ['Наш прогноз точен.', 'forbidden:прогноз точен'],
    ['Вы не уйдёте в минус.', 'forbidden:не уйдёте в минус'],
    ['Ваши финансы только у вас.', 'forbidden:ваши финансы только у вас'],
    ['Мы посчитаем налоги за вас.', 'forbidden:мы посчитаем налоги'],
    ['Это защитит от штрафов.', 'forbidden:защитит от штрафов'],
    ['Даже мы не можем прочитать данные.', 'forbidden:даже мы не можем прочитать'],
    ['Runway — единственное приложение такого рода.', 'we-first'],
    ['У конкурентов этого нет ни у кого.', 'we-first'],
    ['Приложение полностью работает без сети.', 'forbidden:полностью работает без сети'],
    ['Работает всегда офлайн.', 'forbidden:всегда офлайн'],
    ['Данные не пропадут.', 'forbidden:данные не пропадут'],
    ['Ранняя безопасная дата: 20 ноября.', 'forbidden:ранняя безопасная дата'],
    ['Безопасно купить это сегодня.', 'forbidden:безопасно'],
    ['Безопасная дата покупки.', 'safe-adjective'],
    ['ИИ-советник подскажет.', 'forbidden:ии-советник'],
    ['Рекомендуем купить беговую дорожку.', 'forbidden:рекомендуем купить'],
    ['Первый прогноз за 10 минут.', 'first-forecast'],
    ['Вердикт: спокойно.', 'calm-verdict'],
    ['Оценка: «спокойно».', 'calm-verdict'],
    ['The app works always offline.', 'always-offline'],
  ];
  for (const [text, rule] of must_fail) {
    const f = lint(text);
    assert.ok(f.some((x) => x.level === 'error' && x.rule === rule), `${text} → ожидалось ${rule}, получено ${JSON.stringify(f.map((x) => x.rule))}`);
    assert.ok(f.every((x) => x.file === 'wiki/product/x.md' && x.line === 1));
  }
});

test('TST-56 линтер: допустимые формулировки → PASS (нет находок): канонические «вместо», слово «безопасность», отрицание, нейтральные подписи', () => {
  const must_pass = [
    'в заданных допущениях минимум после покупки — X при буфере Y',
    'после первой загрузки оболочки основные сценарии работают без сети',
    'самая ранняя дата, с которой сумма держится в буфере',
    'каждое число ответа сверено с расчётом; при расхождении показываем шаблон',
    'Мы не гарантируем точность: расчёт по введённым данным; меняется, если данные неполны.',
    'Приватность и безопасность: данные на устройстве.',
    'в изученных материалах (2026-10-04) не найдено',
    'до {T} свободно X при буфере Y',
    'Откладываем по правилу, которое вы ввели; не консультация.',
    'Ассистент отвечает на вопросы о вашем расчёте.',
    'В тестах медиана — N минут (n = …, дата).',
    'Он вёл себя спокойно и уверенно.',
    'Вердикт: хрупко.',
    'verdict = «FRAGILE»',
    'Оценка: выдерживает.',
    'Вердикт: не хватает.',
    'Данные на устройстве; делайте файл-копию — напоминаем.',
    'Structured outputs гарантируют форму, не точность чисел.',
  ];
  for (const text of must_pass) assert.deepEqual(lint(text), [], text);
  // вердикты вне словаря
  assert.ok(has(lint('Вердикт: рискованно.'), 'verdict-banned'));
  assert.ok(has(lint('verdict = «SAFE»'), 'verdict-banned'));
  assert.ok(has(lint('verdict: "risky"'), 'verdict-banned'));
  assert.ok(has(lint('verdict = «GOOD»'), 'verdict-banned'));
  assert.ok(lint('verdict = «MAYBE»').some((f) => f.rule === 'verdict-unknown' && f.level === 'warn'));
});

test('TST-56 линтер: исключения — таблица «Нельзя/Не говорим», раздел «Нельзя…», строки запрета, цитаты Budget Guru в wiki/tools|sources|comparisons|raw, lint-vocab: ignore', () => {
  const table = '| Нельзя | Почему | Вместо |\n|---|---|---|\n| «Да, спокойно», «безопасно» | зависит от допущений | «в заданных допущениях минимум — X при буфере Y» |\n';
  assert.deepEqual(lint(table), []);
  const table2 = '| Не говорим | Почему | Говорим |\n|---|---|---|\n| «Без галлюцинаций» | не сверяет смысл | «каждое число сверено» |\n';
  assert.deepEqual(lint(table2), []);
  const section = '## Нельзя говорить\n\nДа, спокойно. Безопасно.\n\n## Можно\n\nТак тоже — безопасно.\n';
  const fs_ = lint(section);
  assert.deepEqual(fs_.map((f) => f.line), [7], 'исключение действует до следующего заголовка того же уровня');
  assert.deepEqual(lint('Слово «безопасно» запрещено (C-063).'), []);
  assert.deepEqual(lint('Формулировку «без галлюцинаций» не использовать: вместо неё — «каждое число сверено».'), []);
  assert.deepEqual(lint('Лозунг «гарантируем точность» не делаем никогда.'), []);
  // цитаты заявлений аналога
  const quote = 'Budget Guru заявляет: «Да, спокойно» (заявлено на лендинге, не проверено).';
  assert.deepEqual(lint(quote, 'wiki/tools/budget-guru.md'), []);
  assert.deepEqual(lint(quote, 'wiki/product/x.md'), [], 'цитата с атрибуцией допустима и вне каталога tools');
  assert.ok(lint('Runway: «Да, спокойно».', 'wiki/product/x.md').length > 0, 'без атрибуции в голосе продукта — ошибка');
  assert.deepEqual(lint('вердикт аналога — «Да, спокойно»', 'wiki/comparisons/x.md'), []);
  assert.deepEqual(lint('Всегда офлайн (заявлено на лендинге).', 'raw/03-x.md'), [], 'строка с атрибуцией в raw/');
  assert.ok(lint('Всегда офлайн.', 'wiki/algorithms/x.md').length > 0);
  // столбец «заявлено»
  const claims = '| Функция | Budget Guru (заявлено) | Runway |\n|---|---|---|\n| Q3 | «Да, спокойно» | четыре вердикта |\n| Q4 | выдерживает | «Да, спокойно» |\n';
  assert.deepEqual(lint(claims).map((f) => f.line), [4], 'столбец с заявлением аналога исключён, столбец Runway — нет');
  // явное исключение
  assert.deepEqual(lint('<!-- lint-vocab: ignore -->\nДа, спокойно.'), []);
  assert.deepEqual(lint('Да, спокойно. <!-- lint-vocab: ignore -->'), []);
  // каталог ideas — предупреждения («предложения, не решения»)
  const idea = lint('Да, спокойно.', 'wiki/ideas/x.md');
  assert.ok(idea.length > 0 && idea.every((f) => f.level === 'warn'));
  // блоки кода сканируются (шаблоны в pseudo — голос продукта)
  assert.ok(lint('```pseudo\nTEMPLATES.ru["X"] = "Да, спокойно, покупайте"\n```').length > 0);
});

test('TST-56 каждая фраза vocab.json (forbidden_phrases) ловится линтером; подписи словаря и каталог шаблонов (ru, en) чисты', () => {
  const vocab = LINT.load_vocab();
  assert.ok(vocab.forbidden_phrases.length >= 15);
  for (const phrase of vocab.forbidden_phrases) {
    const f = lint(`Он пишет: ${phrase} — и точка.`);
    assert.ok(f.some((x) => x.level === 'error'), `фраза «${phrase}» не поймана: ${JSON.stringify(f)}`);
  }
  for (const loc of ['ru', 'en']) {
    for (const [k, t] of Object.entries(templates(loc))) assert.deepEqual(lint(t, 'prototype/engine/verifier.mjs'), [], `${loc} ${k}`);
  }
  for (const v of Object.values(vocab.verdicts)) assert.deepEqual(lint(`Оценка: ${v.ru}. ${v.en}`), []);
  // подписи режимов и словарь вердиктов — разрешённые слова
  const allowed = LINT.allowed_verdict_words(vocab);
  for (const w of ['ok', 'tight', 'fragile', 'no', 'выдерживает', 'впритык', 'хрупко', 'не хватает', 'holds', 'short']) assert.ok(allowed.has(w), w);
  assert.ok(!allowed.has('спокойно'));
  // ответы A0 на G-001 чисты (рендер всех инструментов)
  const m = mk();
  for (const [name, args] of [['check_purchase', TV1], ['get_projection', { to: '2026-11-30' }], ['max_purchase_amount', { date: '2026-10-12' }], ['earliest_safe_date', { amount_minor: 30000, currency: 'EUR' }],
    ['list_waves', { from: '2026-10-04', to: '2026-11-30' }], ['explain_min_point', {}], ['get_tax_envelope', {}]]) {
    const r = m.call(name, args);
    const echo = build_echo([{ name, args }], m.ctx.params, 'EUR');
    for (const loc of ['ru', 'en']) assert.deepEqual(lint(render_answer(fallback_answer(r, loc), [r], loc, echo)), [], `${loc} ${name}`);
  }
});

test('TST-56 метки <!--num:G-001.ключ=значение-->: совпадение с golden-выводом движка — OK, расхождение — ERROR, неизвестный ключ — предупреждение', async () => {
  const golden = await LINT.golden_values();
  // golden — числа канона §9: считаются движком, сверяются с ожиданиями ДОСЛОВНО из канона
  assert.equal(golden['G-001.opening'], '400000');
  assert.equal(golden['G-001.end_close'], '340000');
  assert.equal(golden['G-001.q1.min_trough.plan'], '205500');
  assert.equal(golden['G-001.q1.min_trough.worse'], '183000');
  assert.equal(golden['G-001.free.min.plan'], '93500');
  assert.equal(golden['G-001.free.min.worse'], '71000');
  assert.equal(golden['G-001.reserve_close.end'], '167800');
  assert.equal(golden['G-001.waves.w1.need.plan'], '222000');
  assert.equal(golden['G-001.waves.w1.need.worse'], '244500');
  assert.equal(golden['G-001.waves.w2.need'], '162000');
  assert.equal(golden['G-001.q3.treadmill.m_after.plan'], '63500');
  assert.equal(golden['G-001.q3.treadmill.m_after.worse'], '41000');
  assert.equal(golden['G-001.q3.treadmill.verdict'], 'FRAGILE');
  assert.equal(golden['G-001.safe_to_spend.plan'], '43500');
  assert.equal(golden['G-001.safe_to_spend.worse'], '21000');
  const labels = (text) => LINT.lint_num_labels(text, { file: 'wiki/x.md', golden });
  assert.deepEqual(labels('Минимум 635,00 € <!--num:G-001.q3.treadmill.m_after.plan=63500-->.'), []);
  assert.deepEqual(labels('<!--num:G-001.q3.treadmill.verdict=FRAGILE--> <!--num:G-001.end_close=340000-->'), []);
  const bad = labels('Минимум <!--num:G-001.q3.treadmill.m_after.plan=63501-->.');
  assert.deepEqual(bad.map((f) => [f.level, f.rule, f.line]), [['error', 'num-mismatch', 1]]);
  assert.ok(labels('<!--num:G-001.q3.treadmill.verdict=OK-->')[0].msg.includes('FRAGILE'));
  const unk = labels('\n<!--num:G-001.no_such_key=1-->');
  assert.deepEqual(unk.map((f) => [f.level, f.rule, f.line]), [['warn', 'num-unknown', 2]]);
  assert.deepEqual(labels('нет меток'), []);
});

test('TST-56 JS-файлы (prototype/demo): комментарии разработчика не голос продукта — линтер смотрит на строки; строка с запретом ловится', () => {
  const src = '// Модуль безопасно импортируется в Node\n/* без галлюцинаций\n   и точные цифры */\nconst a = "Да, спокойно"; // конец\nconst u = "http://x.example/a//b";\n';
  const stripped = LINT.strip_js_comments(src);
  assert.equal(stripped.split('\n').length, src.split('\n').length, 'строки на местах');
  assert.ok(!stripped.includes('безопасно') && !stripped.includes('галлюцинаций') && !stripped.includes('конец'));
  assert.ok(stripped.includes('"Да, спокойно"') && stripped.includes('"http://x.example/a//b"'), 'строковые литералы не тронуты, // внутри строки — не комментарий');
  assert.ok(lint(stripped, 'prototype/demo/app.mjs').some((f) => f.rule === 'forbidden:да, спокойно' && f.line === 4));
  assert.deepEqual(lint(LINT.strip_js_comments('// Да, спокойно\nconst x = 1;\n'), 'prototype/demo/app.mjs'), []);
});

test('TST-56 реестр обещаний: hypothesis в интерфейсе, measured старше 90 дней, «первый прогноз за 10 минут» без измерения → ERROR', () => {
  const run = (registry, today = '2026-10-04') => LINT.lint_promises(registry, today).map((f) => [f.level, f.rule]);
  assert.deepEqual(run([]), []);
  assert.deepEqual(run([{ id: 'p1', text: 'расчёт по введённым данным', level: 'hypothesis', surface: 'doc' }]), [], 'гипотеза в документации — допустима');
  assert.deepEqual(run([{ id: 'p2', text: 'x', level: 'hypothesis', surface: 'ui' }]), [['error', 'promise-hypothesis-in-ui']]);
  assert.deepEqual(run([{ id: 'p3', text: 'x', level: 'measured', surface: 'ui', measured_on: '2026-10-01' }]), []);
  assert.deepEqual(run([{ id: 'p4', text: 'x', level: 'measured', measured_on: '2026-07-06' }]), [], 'ровно 90 дней — ещё свежо');
  assert.deepEqual(run([{ id: 'p5', text: 'x', level: 'measured', measured_on: '2026-07-05' }]), [['error', 'promise-stale']], '91 день');
  assert.deepEqual(run([{ id: 'p6', text: 'x', level: 'measured' }]), [['error', 'promise-no-date']]);
  assert.deepEqual(run([{ id: 'p7', text: 'Первый прогноз за 10 минут', level: 'hypothesis', surface: 'doc' }]), [['error', 'first-forecast']]);
  assert.deepEqual(run([{ id: 'p8', text: 'Первый прогноз за 10 минут', level: 'measured', measured_on: '2026-10-01' }]), [], 'с измерением — можно');
  assert.deepEqual(run([{ id: 'p9', text: 'Первый прогноз за 10 минут', level: 'hypothesis', surface: 'ui' }]).map((x) => x[1]).sort(), ['first-forecast', 'promise-hypothesis-in-ui']);
});

test('TST-56 запуск на реальных wiki-страницах и prototype/demo — только отчёт, не падение; формат вывода как у lint.mjs; --json валиден', (t) => {
  const r = LINT.lint_project({ golden: null });
  assert.ok(r.files > 20, 'wiki просканирована');
  assert.ok(r.lines > 1000);
  assert.ok(Array.isArray(r.findings));
  for (const f of r.findings) {
    assert.ok(['error', 'warn'].includes(f.level));
    assert.equal(typeof f.file, 'string');
    assert.ok(Number.isInteger(f.line) && f.line >= 1);
  }
  const errors = r.findings.filter((f) => f.level === 'error');
  t.diagnostic(`TST-56 отчёт по реальным страницам: файлов ${r.files}, строк ${r.lines}, ошибок ${errors.length}, предупреждений ${r.findings.length - errors.length} (не падение)`);
  for (const f of errors.slice(0, 20)) t.diagnostic(`  ERROR ${f.file}:${f.line}: [${f.rule}]`);
  // запуск командной строки
  const script = fileURLToPath(new URL('../../tools/lint_vocab.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [script, '--json'], { cwd: ROOT, encoding: 'utf8' });
  assert.ok([0, 1].includes(run.status), `код выхода ${run.status}: ${run.stderr}`);
  const j = JSON.parse(run.stdout);
  assert.deepEqual(Object.keys(j).sort(), ['errors', 'files', 'lines', 'warns']);
  assert.equal(j.files, r.files);
  assert.equal(run.status, j.errors.length > 0 ? 1 : 0, 'код выхода 1 при ошибках — как у lint.mjs');
  // формат текстового отчёта — как у lint.mjs
  const report = LINT.format_report(r);
  assert.match(report, /^Файлов: \d+ · Строк: \d+\n/);
  assert.match(report, /\nИтого: \d+ ошибок, \d+ предупреждений\n$/);
  assert.equal((report.match(/^ERROR /gm) ?? []).length, errors.length);
  assert.equal(LINT.format_report({ files: 1, lines: 2, findings: [{ file: 'a.md', line: 3, rule: 'x', level: 'warn', msg: 'm' }, { file: 'b.md', line: 4, rule: 'y', level: 'error', msg: 'n' }] }),
    'Файлов: 1 · Строк: 2\nERROR b.md:4: [y] n\nwarn  a.md:3: [x] m\n\nИтого: 1 ошибок, 1 предупреждений\n');
  // каталог prototype/demo: если появится — просканирован; временный каталог с нарушением ловится
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lint_vocab_'));
  try {
    fs.writeFileSync(path.join(tmp, 'ui.html'), '<p>Да, спокойно: всегда офлайн.</p>\n<p>Вердикт: хрупко.</p>\n');
    const rr = LINT.lint_project({ dirs: [tmp], golden: null });
    const mine = rr.findings.filter((f) => f.file.endsWith('ui.html'));
    assert.ok(mine.some((f) => f.rule === 'forbidden:да, спокойно' && f.line === 1));
    assert.ok(mine.every((f) => f.line === 1), 'вердикт «хрупко» из словаря не найден как нарушение');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
