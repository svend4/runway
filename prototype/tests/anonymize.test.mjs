// anonymize.test.mjs — анонимизация журнала добровольца (FP-11, REQ-176, TST-55): сдвиг дат кратно 7 дням, суммы × k ∈ [0,5; 2], структура и связи не меняются,
// детерминизм по seed. Оракулы — тестовые: `Date.UTC` для разности дат, BigInt для округления half_even (в tools/ и engine/ их нет).
import test from 'node:test';
import assert from 'node:assert/strict';

import * as an from '../tools/anonymize.mjs';
import { reduce, effective_events, canon } from '../engine/ledger.mjs';
import { backtest } from '../engine/backtest.mjs';
import { read_journal_json, export_json } from '../engine/io.mjs';
import { make_journal, regular_corpus } from '../data/synthetic-journals/generate.mjs';
import { throws_code } from './helpers.mjs';

const SPEC = { ...regular_corpus()[3], start: '2026-01-01', end: '2026-05-31' }; // с налоговым конвертом: есть аллокации, match.set, резервы
const J = make_journal(SPEC);
const deep_freeze = (x) => {
  if (x !== null && typeof x === 'object' && !Object.isFrozen(x)) { Object.freeze(x); for (const k of Object.keys(x)) deep_freeze(x[k]); }
  return x;
};

const day_ms = 86400000;
const epoch_days = (iso) => Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / day_ms);
/** Округление половин к чётному: оракул для `mul_div(x, k_bp, 10000)`. */
function half_even(x, k_bp) {
  const n = BigInt(x) * BigInt(k_bp);
  const d = 10000n;
  let q = n / d;
  let r = n % d;
  if (r < 0n) { r += d; q -= 1n; }
  if (2n * r > d || (2n * r === d && q % 2n !== 0n)) q += 1n;
  return Number(q);
}

test('TST-55 REQ-176 даты сдвигаются ровно на 7·N дней (независимо через Date.UTC), день недели сохраняется; суммы × k по правилу half_even', () => {
  const r = an.anonymize_journal(J, { shift_weeks: 5, k_bp: 15000 });
  assert.equal(r.params.shift_days, 35);
  assert.equal(r.params.shift_days % 7, 0);
  assert.equal(r.journal.length, J.length);
  let dates = 0;
  let amounts = 0;
  J.forEach((e, i) => {
    const a = r.journal[i];
    assert.equal(epoch_days(a.recorded_at.slice(0, 10)) - epoch_days(e.recorded_at.slice(0, 10)), 35);
    assert.equal(a.recorded_at.slice(10), e.recorded_at.slice(10), 'время суток не трогается');
    if (e.type === 'tx.posted' || e.type === 'anchor.set') {
      const diff = epoch_days(a.payload.date) - epoch_days(e.payload.date);
      assert.equal(diff, 35);
      assert.equal(((diff % 7) + 7) % 7, 0, 'день недели сохранён');
      assert.equal(a.payload.amount_minor, half_even(e.payload.amount_minor, 15000));
      dates++; amounts++;
    }
    if (e.type === 'allocation.recorded') {
      assert.equal(a.payload.amount_minor, half_even(e.payload.amount_minor, 15000));
      assert.equal(epoch_days(a.payload.date) - epoch_days(e.payload.date), 35);
    }
    if (e.type === 'rule.set') {
      assert.equal(a.payload.amount.exp_minor, half_even(e.payload.amount.exp_minor, 15000));
      assert.equal(epoch_days(a.payload.start_date) - epoch_days(e.payload.start_date), 35);
    }
    if (e.type === 'stream.set') assert.equal(a.payload.rate_minor, half_even(e.payload.rate_minor, 15000));
    if (e.type === 'params.set') assert.equal(a.payload.buffer_minor, half_even(e.payload.buffer_minor, 15000));
  });
  assert.ok(dates > 30 && amounts > 30, 'в журнале достаточно проверяемых записей');
  assert.deepEqual(an.verify_anonymized(J, r.journal, r.params), []);
});

test('TST-55 множитель ровно 2 и ровно 0,5: суммы вдвое больше / вдвое меньше с округлением к чётному; ненулевая сумма не обращается в ноль, знак сохраняется', () => {
  const x2 = an.anonymize_journal(J, { shift_weeks: 0, k_bp: 20000 }).journal;
  const half = an.anonymize_journal(J, { shift_weeks: 0, k_bp: 5000 }).journal;
  J.forEach((e, i) => {
    if (e.type !== 'tx.posted') return;
    assert.equal(x2[i].payload.amount_minor, 2 * e.payload.amount_minor);
    assert.equal(half[i].payload.amount_minor, half_even(e.payload.amount_minor, 5000));
    assert.equal(Math.sign(half[i].payload.amount_minor), Math.sign(e.payload.amount_minor));
  });
  const tiny = [{ event_id: 'e1', type: 'tx.posted', v: 1, entity_id: 't', payload: { amount_minor: 1, date: '2026-01-05' }, recorded_at: '2026-01-05T12:00:00Z', seq: 1, actor: 'user' },
    { event_id: 'e2', type: 'tx.posted', v: 1, entity_id: 't2', payload: { amount_minor: -1, date: '2026-01-05' }, recorded_at: '2026-01-05T12:00:00Z', seq: 2, actor: 'user' },
    { event_id: 'e3', type: 'tx.posted', v: 1, entity_id: 't3', payload: { amount_minor: 0, date: '2026-01-05' }, recorded_at: '2026-01-05T12:00:00Z', seq: 3, actor: 'user' }];
  assert.deepEqual(an.anonymize_journal(tiny, { shift_weeks: 0, k_bp: 5000 }).journal.map((e) => e.payload.amount_minor), [1, -1, 0], '0,5 · 1 = 0,5 → 0 → но не ноль: ±1; ноль остаётся нулём');
});

test('TST-55 структура и связи сохраняются: те же типы, seq, порядок, ключи; ссылки plan_ref и supersedes согласованы со сдвинутыми датами; свёртка даёт те же корзины и размеры', () => {
  const r = an.anonymize_journal(J, { seed: 11 });
  assert.deepEqual(r.journal.map((e) => [e.type, e.seq, e.v, e.actor]), J.map((e) => [e.type, e.seq, e.v, e.actor]));
  assert.deepEqual(r.journal.map((e) => Object.keys(e.payload).sort()), J.map((e) => Object.keys(e.payload).sort()));
  // связь «факт ↔ план»: plan_ref = ключ вхождения с датой; после сдвига ссылается на вхождение того же потока со сдвинутой датой
  const shift = r.params.shift_days;
  J.forEach((e, i) => {
    if (e.type !== 'match.set') return;
    const [stream, date] = e.payload.plan_ref.split('@');
    const moved = r.journal[i].payload.plan_ref.split('@');
    assert.equal(moved[0], stream);
    assert.equal(epoch_days(moved[1]) - epoch_days(date), shift);
    assert.equal(r.journal[i].payload.fact_event_id, e.payload.fact_event_id, 'идентификатор факта без даты не меняется');
  });
  // свёртка: те же корзины и то же число записей в каждой
  const s0 = reduce(effective_events(J));
  const s1 = reduce(effective_events(r.journal));
  for (const k of Object.keys(s0)) {
    if (Array.isArray(s0[k])) assert.equal(s1[k].length, s0[k].length, k);
    else if (s0[k] !== null && typeof s0[k] === 'object') assert.equal(Object.keys(s1[k]).length, Object.keys(s0[k]).length, k);
  }
  // идентификаторы с датой внутри (якоря, ручные освобождения резерва) сдвигаются согласованно и остаются уникальными
  const ids = r.journal.filter((e) => e.type === 'anchor.set').map((e) => e.payload.anchor_id);
  assert.equal(new Set(ids).size, ids.length);
  r.journal.filter((e) => e.type === 'anchor.set').forEach((e) => assert.equal(e.entity_id, e.payload.anchor_id));
  assert.deepEqual(an.verify_anonymized(J, r.journal, r.params), []);
});

test('TST-55 детерминизм: один seed — побайтно один результат; другие seed — другой сдвиг или множитель; параметры из seed всегда в допустимых границах', () => {
  const a = an.anonymize_journal(J, { seed: 2026 });
  const b = an.anonymize_journal(J, { seed: 2026 });
  assert.equal(canon(a.journal), canon(b.journal));
  assert.deepEqual(a.params, b.params);
  assert.notEqual(canon(an.anonymize_journal(J, { seed: 2027 }).journal), canon(a.journal));
  let k_min = Infinity; let k_max = -Infinity; const weeks = new Set();
  for (let s = 0; s < 300; s++) {
    const p = an.derive_params(s);
    assert.ok(p.k_bp >= 5000 && p.k_bp <= 20000, `k_bp ${p.k_bp}`);
    assert.ok(p.shift_weeks >= 1 && p.shift_weeks <= 104);
    k_min = Math.min(k_min, p.k_bp); k_max = Math.max(k_max, p.k_bp); weeks.add(p.shift_weeks);
  }
  assert.ok(k_min < 8000 && k_max > 17000, `множитель разнообразен: ${k_min}…${k_max}`);
  assert.ok(weeks.size > 40, 'сдвиг разнообразен');
  // явные значения главнее seed
  assert.deepEqual(an.anonymize_journal(J, { seed: 5, shift_weeks: 2, k_bp: 10000 }).params, { shift_days: 14, shift_weeks: 2, k_bp: 10000, seed: 5 });
});

test('TST-55 тождество и обратимость: сдвиг 0 и k = 1 возвращают тот же журнал; сдвиг вперёд и назад возвращает исходные даты; вход не меняется', () => {
  const frozen = deep_freeze(structuredClone(J));
  const id = an.anonymize_journal(frozen, { shift_weeks: 0, k_bp: 10000 }).journal;
  assert.equal(canon(id), canon(J));
  const there = an.anonymize_journal(frozen, { shift_weeks: 9, k_bp: 10000 }).journal;
  assert.notEqual(canon(there), canon(J));
  const back = an.anonymize_journal(there, { shift_weeks: -9, k_bp: 10000 }).journal;
  assert.equal(canon(back), canon(J));
});

test('TST-55 ошибки: множитель вне [0,5; 2], сдвиг не целый или слишком большой, не журнал, нецелое число в записи, неверная запись', () => {
  throws_code(() => an.anonymize_journal(J, { shift_weeks: 1, k_bp: 4999 }), 'E_SCHEMA');
  throws_code(() => an.anonymize_journal(J, { shift_weeks: 1, k_bp: 20001 }), 'E_SCHEMA');
  throws_code(() => an.anonymize_journal(J, { shift_weeks: 1.5, k_bp: 10000 }), 'E_SCHEMA');
  throws_code(() => an.anonymize_journal(J, { shift_weeks: 5201, k_bp: 10000 }), 'E_SCHEMA');
  throws_code(() => an.anonymize_journal(J, { seed: 1.5 }), 'E_SCHEMA');
  throws_code(() => an.anonymize_journal({ events: J }, { seed: 1 }), 'E_SCHEMA');
  throws_code(() => an.anonymize_journal([{ type: 'tx.posted' }], { seed: 1 }), 'E_SCHEMA');
  const bad = structuredClone(J);
  bad[10].payload.amount_minor = 12.5;
  throws_code(() => an.anonymize_journal(bad, { seed: 1 }), 'E_NOT_INTEGER');
});

test('TST-55 verify_anonymized находит подмену: сумма не по множителю, дата не на тот сдвиг, лишняя запись, сдвиг не кратен 7', () => {
  const r = an.anonymize_journal(J, { shift_weeks: 3, k_bp: 12000 });
  const tamper = (f) => { const c = structuredClone(r.journal); f(c); return an.verify_anonymized(J, c, r.params); };
  const first_tx = r.journal.findIndex((e) => e.type === 'tx.posted');
  assert.ok(tamper((c) => { c[first_tx].payload.amount_minor += 1; }).length > 0);
  assert.ok(tamper((c) => { c[first_tx].payload.date = '2030-01-01'; }).length > 0);
  assert.ok(tamper((c) => { c.pop(); }).includes('length_differs'));
  assert.ok(tamper((c) => { c[first_tx].payload.surprise = 1; }).length > 0);
  assert.ok(an.verify_anonymized(J, r.journal, { shift_days: 20, k_bp: 12000 }).includes('shift_not_multiple_of_7'));
  assert.ok(an.verify_anonymized(J, r.journal, { shift_days: 21, k_bp: 30000 }).includes('k_out_of_range'));
});

test('TST-55 анонимизированный журнал пригоден для backtest (прогон без ошибок, те же начала прогноза)', () => {
  const r = an.anonymize_journal(J, { shift_weeks: 4, k_bp: 15000 });
  const base = backtest(J, '2026-03-01', 14);
  const anon = backtest(r.journal, '2026-03-29', 14); // начало сдвинуто на те же 28 дней
  assert.equal(anon.n_origins, base.n_origins);
  assert.ok(anon.n_origins >= 3);
  assert.ok(Number.isInteger(anon.frr.n) && Number.isInteger(anon.cry_wolf.n));
});

test('TST-55 командная строка: файл runway-journal/1 → файл; сдвиг и множитель печатаются на экран и в файл не попадают; коды выхода 0, 1, 2', () => {
  const files = new Map([['in.json', export_json(J)]]);
  const out = []; const err = [];
  const io = { read: (p) => { if (!files.has(p)) throw new Error('нет файла'); return files.get(p); }, write: (p, t) => files.set(p, t), out: (s) => out.push(s), err: (s) => err.push(s) };
  assert.equal(an.main(['in.json', 'out.json', '--seed', '7'], io), 0);
  const p = an.derive_params(7);
  const line = JSON.parse(out[0]);
  assert.equal(line.shift_days, 7 * p.shift_weeks);
  assert.equal(line.k_bp, p.k_bp);
  const text = files.get('out.json');
  assert.ok(!text.includes('shift_days') && !text.includes('k_bp'), 'параметры анонимизации в файл не записываются');
  const back = read_journal_json(text);
  assert.equal(canon(back.events), canon(an.anonymize_journal(J, { seed: 7 }).journal));
  assert.equal(an.main(['in.json', 'out2.json', '--shift-weeks', '2', '--k-bp', '10000'], io), 0);
  assert.equal(an.main(['in.json'], io), 2);
  assert.equal(an.main(['--help'], io), 0);
  assert.equal(an.main(['missing.json', 'x.json'], io), 1);
  assert.equal(an.main(['in.json', 'x.json', '--k-bp', '3'], io), 1);
  assert.ok(err.length >= 3);
});

// ── исправления после независимой проверки FP-11 ───────────────────────────────────────────────────────────────────────────

test('FP-11 исправление: командная строка не перезаписывает исходный журнал — совпадающие входной и выходной пути отвергаются (код 2), файл остаётся прежним, ничего не записано', () => {
  const text = export_json(J);
  const files = new Map([['in.json', text]]);
  const writes = []; const err = [];
  const io = { read: (p) => files.get(p), write: (p, t) => { writes.push(p); files.set(p, t); }, out: () => {}, err: (s) => err.push(s) };
  for (const out of ['in.json', './in.json', 'sub/../in.json']) {
    assert.equal(an.main(['in.json', out, '--seed', '3'], io), 2, out);
  }
  assert.deepEqual(writes, [], 'запись не выполнялась');
  assert.equal(files.get('in.json'), text, 'исходный журнал не тронут');
  assert.ok(err.length === 3 && err.every((s) => s.includes('совпадают')), err.join('|'));
  // с отдельным выходным файлом всё работает
  assert.equal(an.main(['in.json', 'other.json', '--seed', '3'], io), 0);
  assert.deepEqual(writes, ['other.json']);
});

test('FP-11 исправление (ADV-6, частично): календарные поля, которые сдвиг на 7·N дней не переносит, считаются (notes) и о них предупреждает командная строка; журнал без таких полей — без предупреждения', () => {
  const json = JSON.stringify(J);
  const want_monthday = (json.match(/"by_monthday":\[/g) ?? []).length;
  const want_cutoff = (json.match(/"cutoff":\{"kind":"month_end"/g) ?? []).length;
  assert.ok(want_monthday > 0 && want_cutoff > 0, 'в журнале есть и день месяца, и конец месяца');
  const r = an.anonymize_journal(J, { shift_weeks: 3, k_bp: 10000 });
  assert.deepEqual(r.notes, { by_monthday: want_monthday, month_end_cutoff: want_cutoff });
  assert.deepEqual(an.calendar_notes(J), r.notes);
  // потоки с границей «конец недели» и правила без дня месяца счётчик не затрагивают; не журнал — нули
  const plain = [{ type: 'x', event_id: 'e1', payload: { by_weekday: [1], cutoff: { kind: 'weekday', weekday: 5 }, by_monthday: [] } }];
  assert.deepEqual(an.calendar_notes(plain), { by_monthday: 0, month_end_cutoff: 0 });
  assert.deepEqual(an.calendar_notes(null), { by_monthday: 0, month_end_cutoff: 0 });
  assert.deepEqual(an.calendar_notes([]), { by_monthday: 0, month_end_cutoff: 0 });
  // командная строка: итоговая строка JSON называет счётчики, на stderr — предупреждение с оговоркой про backtest
  const files = new Map([['in.json', export_json(J)]]);
  const out = []; const err = [];
  const io = { read: (p) => files.get(p), write: (p, t) => files.set(p, t), out: (s) => out.push(s), err: (s) => err.push(s) };
  assert.equal(an.main(['in.json', 'out.json', '--shift-weeks', '3', '--k-bp', '10000'], io), 0);
  assert.deepEqual(JSON.parse(out[0]).calendar_notes, { by_monthday: want_monthday, month_end_cutoff: want_cutoff });
  assert.equal(err.length, 1);
  assert.ok(err[0].startsWith('Предупреждение') && err[0].includes('by_monthday') && err[0].includes('backtest') && err[0].includes('могут отличаться'), err[0]);
  assert.ok(!files.get('out.json').includes('Предупреждение'), 'предупреждение в файл не попадает');
  // анонимизированный журнал по-прежнему согласован с исходным (предупреждение ничего не меняет)
  assert.deepEqual(an.verify_anonymized(J, r.journal, r.params), []);
});
