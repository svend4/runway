// fp14_adv.test.mjs — состязательная проверка пакета FP-14 (независимый проверяющий, 2026-10-10). Расчёт по введённым данным и правилам, не консультация.
// Здесь два вида тестов.
//  1) «Страховочные» (зелёные): независимая проверка того, что заявил пакет, другим путём, чем его собственные тесты — числа канона REQ-082/REQ-083 пересчитаны
//     вручную (цикл по остатку, без amortization_schedule/prepay/reanchor), число и сумма платежей за горизонтом посчитаны перебором строк графика (а не
//     beyond_horizon_payments), случайные цепочки правок через настоящий apply_edit проверены на инварианты графика, validate_ws, analyze и «Отменить»/«Вернуть» побайтно.
//  2) «Дефектные» (были todo и красными; после исправления пакета — обычные зелёные тесты): ADV-10 — перенос платежа (move_debt_row) молча терялся (и сдвигал все
//     следующие даты), если после него записать досрочное погашение или сверку с банком на более раннем платеже; ADV-11 (низкий) — «Срок короче» после сверки вверх
//     брал платёж оплаченной строки и удлинял график.
// Браузера, сервера и сети нет; рабочее дерево не меняется. Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/fp14_adv.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyze, canon, format_date, parse_date } from '../engine/index.mjs';
import { build_debt_record, move_row_date, apply_prepay, apply_reanchor, rows_of } from '../engine/debt_ext.mjs';
import { validate_ws } from '../engine/validate_ws.mjs';
import { apply_edit, list_edit_types, register_edit } from '../demo/ws_edit.mjs';
import { diff_unit, apply_unit, describe_unit } from '../demo/undo.mjs';
import { EDITS } from '../demo/debt_edit.mjs';
import { make_rng } from './helpers.mjs';

for (const [type, fn] of Object.entries(EDITS)) if (!list_edit_types().includes(type)) register_edit(type, fn);

const DATA = new URL('../data/', import.meta.url);
const load = (name) => JSON.parse(fs.readFileSync(new URL(name, DATA), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const G = load('g001.json');
const GD = load('g001-debt.json');
const AS_OF = G.as_of;
const SPEC = { debt_id: 'D-LOAN', name: 'Кредит', pay_account_id: 'acc_main', currency: 'EUR', kind: 'annuity', principal_minor: 120000, rate_bp: 1200, n: 6, start_date: '2026-11-05' };
const REC = build_debt_record(SPEC);
const dates_of = (rec) => rec.schedule.map((r) => r.date);

/** Деление с округлением «к чётному» — для проверочного цикла (аргументы целые, делитель > 0). */
function div_half_even(num, den) {
  const q = Math.floor(num / den);
  const r2 = (num - q * den) * 2;
  if (r2 < den) return q;
  if (r2 > den) return q + 1;
  return q % 2 === 0 ? q : q + 1;
}

/** Ручной график: проценты периода `bal·rate_bp/120000`, платёж аннуитета `A` задан, последняя строка закрывает остаток. */
function manual_rows(balance, rate_bp, A, n) {
  const out = [];
  let bal = balance;
  for (let k = 1; k <= n; k++) {
    const interest = div_half_even(bal * rate_bp, 120000);
    const principal = k === n ? bal : A - interest;
    bal -= principal;
    out.push({ payment: principal + interest, interest, balance: bal });
  }
  return out;
}

// ═══ ADV-01: числа канона пересчитаны вручную ════════════════════════════════════════════════════════════════════════

test('ADV-01 REQ-082 числа канона вручную: A = 20706 (вещественная формула с округлением), график build_debt_record равен ручному циклу по остатку', () => {
  const i = 1200 / 120000;
  const A_float = 120000 * i / (1 - (1 + i) ** -6);
  assert.equal(Math.round(A_float), 20706);
  const man = manual_rows(120000, 1200, 20706, 6);
  assert.deepEqual(REC.schedule.map((r) => [r.payment_minor, r.interest_minor, r.balance_minor]), man.map((r) => [r.payment, r.interest, r.balance]));
  assert.deepEqual(man.map((r) => r.interest), [1200, 1005, 808, 609, 408, 205]);
  assert.equal(man.reduce((s, r) => s + r.payment, 0), 124235);
});

test('ADV-01 REQ-083 досрочное и сверка вручную: shorten 300,00 € после платежа 2 — хвост 3 строки (508/306/102), экономия 1114; lower_payment — платёж ≈ 13017,3 → 13017; сверка 809,00 € — платёж ≈ 20733,0', () => {
  const sh = apply_prepay(REC, { date: '2026-12-05', amount_minor: 30000, option: 'shorten', as_of: AS_OF });
  // ручной хвост: остаток 80793 − 30000, платёж прежний 20706, последняя строка закрывает остаток
  let bal = 80793 - 30000;
  const tail = [];
  while (bal > 0) {
    const interest = div_half_even(bal * 1200, 120000);
    const principal = Math.min(20706 - interest, bal);
    bal -= principal;
    tail.push([principal + interest, interest, bal]);
  }
  assert.deepEqual(sh.schedule.slice(2).map((r) => [r.payment_minor, r.interest_minor, r.balance_minor]), tail);
  assert.equal(tail.length, 3);
  assert.equal((808 + 609 + 408 + 205) - tail.reduce((s, r) => s + r[1], 0), 1114);
  const i = 1200 / 120000;
  const A_lo = (80793 - 30000) * i / (1 - (1 + i) ** -4);
  assert.ok(Math.abs(A_lo - 13017.3) < 0.1, String(A_lo));
  assert.equal(apply_prepay(REC, { date: '2026-12-05', amount_minor: 30000, option: 'lower_payment', as_of: AS_OF }).schedule[2].payment_minor, Math.round(A_lo));
  const ra = apply_reanchor(REC, { k: 2, observed_minor: 80900, as_of: AS_OF });
  const A_ra = 80900 * i / (1 - (1 + i) ** -4);
  assert.ok(Math.abs(A_ra - 20733) < 0.5, String(A_ra));
  assert.equal(ra.debt.schedule[2].payment_minor, Math.round(A_ra));
  assert.equal(ra.drift_minor, 80900 - 80793);
});

// ═══ ADV-02: W_DEBT_BEYOND_HORIZON — перебор строк графика ══════════════════════════════════════════════════════════

test('ADV-02 REQ-082 W_DEBT_BEYOND_HORIZON: число и сумма платежей за горизонтом (с внесёнными досрочно) совпадают с ручным перебором строк при 80 случайных долгах и горизонтах', () => {
  const rng = make_rng(20261010);
  const as_of = parse_date(AS_OF);
  for (let c = 0; c < 80; c++) {
    const n = rng.int(2, 18);
    let rec = build_debt_record({ ...SPEC, n, principal_minor: rng.int(n * 100, 900000), rate_bp: rng.pick([0, 300, 1200, 2450]), kind: 'annuity', start_date: format_date(as_of + rng.int(1, 40)) });
    if (rng.bool() && rec.n > 2) {
      const k = rng.int(1, rec.n - 1);
      rec = apply_prepay(rec, { date: rec.schedule[k - 1].date, amount_minor: rng.int(1, rec.schedule[k - 1].balance_minor), option: rng.pick(['shorten', 'lower_payment']), as_of: AS_OF });
    }
    const horizon_end = format_date(as_of + rng.int(0, 400));
    const a = analyze({ ...clone(G), debts: [rec] }, { as_of: AS_OF, horizon_end });
    let count = 0;
    let total = 0;
    for (const r of rec.schedule) {
      if (r.date <= horizon_end) continue;
      if (r.payment_minor > 0) { count += 1; total += r.payment_minor; }
      if ((r.extra_minor ?? 0) > 0) { count += 1; total += r.extra_minor; }
    }
    const w = a.warnings.filter((x) => x.code === 'W_DEBT_BEYOND_HORIZON');
    if (count === 0) assert.deepEqual(w, [], `случай ${c}: за горизонтом ничего нет`);
    else assert.deepEqual(w, [{ code: 'W_DEBT_BEYOND_HORIZON', debt_id: 'D-LOAN', count, total_minor: total, currency: 'EUR' }], `случай ${c}`);
  }
});

// ═══ ADV-03: случайные цепочки правок через настоящий apply_edit ═════════════════════════════════════════════════════

let counter = 0;
const new_id = (prefix) => `${prefix}_adv${++counter}`;
const edit_ok = (ws, edit) => { const r = apply_edit(ws, edit, { new_id }); return r.ok === true ? r.ws : null; };

function check_record(rec, label) {
  const rows = rows_of(rec);
  rows.forEach((r, i) => {
    assert.equal(r.payment_minor, r.principal_minor + r.interest_minor, `${label}: платёж ${i + 1} = часть долга + проценты`);
    assert.ok(r.balance_minor >= 0, `${label}: остаток ${i + 1} не отрицателен`);
    if (i > 0) assert.ok(r.date > rows[i - 1].date, `${label}: даты строго по порядку (строка ${i + 1})`);
  });
  assert.equal(rows.at(-1).balance_minor, 0, `${label}: график закрывается в 0`);
}

test('ADV-03 TST-16 TST-51 случайные цепочки до 6 правок долга (перенос, досрочное, сверка) через apply_edit: инварианты графика, validate_ws, analyze, «Отменить» и «Вернуть» побайтно; 120 цепочек', () => {
  const rng = make_rng(7771);
  let applied = 0;
  for (let c = 0; c < 120; c++) {
    const kind = rng.pick(['annuity', 'differential', 'installment_0']);
    const n = rng.int(3, 20);
    const add = {
      type: 'upsert_debt',
      debt: { debt_id: 'D-F' + c, name: 'Долг', pay_account_id: 'acc_main', kind, principal_minor: rng.int(n * 100, 3000000), rate_bp: kind === 'installment_0' ? 0 : rng.int(1, 2400), n, start_date: '2026-11-05' },
    };
    let ws = edit_ok(G, add);
    assert.ok(ws !== null, 'добавление долга');
    const states = [G, ws];
    const units = [];
    units.push(diff_unit(G, ws, describe_unit('upsert_debt', { changes: [] }, ws)));
    for (let s = 0; s < 6; s++) {
      const debt = ws.debts[0];
      const rows = rows_of(debt);
      const op = rng.int(0, 2);
      let edit;
      if (op === 0) { const k = rng.int(1, rows.length); edit = { type: 'move_debt_row', debt_id: debt.debt_id, k, date: format_date(rows[k - 1].date + rng.int(-6, 6)) }; }
      else if (op === 1) {
        const k = rng.int(1, Math.max(1, rows.length - 1));
        edit = { type: 'apply_prepay', debt_id: debt.debt_id, date: format_date(rows[k - 1].date), amount_minor: rng.int(1, Math.max(1, rows[k - 1].balance_minor)), option: rng.pick(['shorten', 'lower_payment']) };
      } else { const k = rng.int(1, rows.length); edit = { type: 'apply_reanchor', debt_id: debt.debt_id, k, observed_minor: Math.max(0, rows[k - 1].balance_minor + rng.int(-40, 40)) }; }
      const next = edit_ok(ws, edit);
      if (next === null) continue; // отказ — штатное поведение (порядок, границы)
      applied += 1;
      check_record(next.debts[0], `цепочка ${c} шаг ${s} ${edit.type}`);
      const v = validate_ws(next);
      assert.equal(v.ok, true, JSON.stringify(v.errors));
      const a = analyze(next, { as_of: AS_OF });
      assert.ok(Array.isArray(a.series.plan.free));
      units.push(diff_unit(ws, next, describe_unit(edit.type, { changes: [] }, next)));
      ws = next;
      states.push(ws);
    }
    // «Отменить» с конца до начала, затем «Вернуть» с начала до конца
    let cur = ws;
    for (let u = units.length - 1; u >= 0; u--) {
      const r = apply_unit(cur, units[u], 'undo');
      assert.equal(r.ok, true, `цепочка ${c}: отмена ${u}`);
      cur = r.ws;
      assert.equal(canon(cur), canon(states[u]), `цепочка ${c}: после отмены ${u} состояние побайтно прежнее`);
    }
    for (let u = 0; u < units.length; u++) {
      const r = apply_unit(cur, units[u], 'redo');
      assert.equal(r.ok, true, `цепочка ${c}: возврат ${u}`);
      cur = r.ws;
      assert.equal(canon(cur), canon(states[u + 1]), `цепочка ${c}: после возврата ${u} состояние побайтно то же`);
    }
  }
  assert.ok(applied > 150, 'цепочки не выродились в отказы: применено ' + applied);
});

test('ADV-03 REQ-082 удаление и повторное добавление того же долга: после delete_debt область байт-в-байт равна исходной G-001 (корзина debts пуста), а не «почти»', () => {
  const ws = edit_ok(G, { type: 'upsert_debt', debt: { debt_id: 'D-X', name: 'X', pay_account_id: 'acc_main', kind: 'differential', principal_minor: 90000, rate_bp: 900, n: 9, start_date: '2026-11-20' } });
  const moved = edit_ok(ws, { type: 'move_debt_row', debt_id: 'D-X', k: 2, date: '2026-12-22' });
  const gone = edit_ok(moved, { type: 'delete_debt', debt_id: 'D-X' });
  assert.equal(canon(gone), canon(G));
});

// ═══ ADV-04: статический обзор безопасности новых файлов ════════════════════════════════════════════════════════════

test('ADV-04 безопасность интерфейса: в новых файлах пакета нет innerHTML/outerHTML/eval/new Function/inline-стилей/обработчиков-строк/внешних адресов/хранилищ/сети', () => {
  const files = ['demo/debt_edit.mjs', 'demo/pack_fp14.mjs', 'demo/i18n/debtedit.mjs', 'engine/debt_ext.mjs'];
  const bad = /innerHTML|outerHTML|insertAdjacentHTML|\beval\s*\(|new Function|\.style\b|setAttribute\(\s*['"]style|\bon[a-z]+\s*[:=]\s*['"]|https?:\/\/|localStorage|sessionStorage|indexedDB|\bfetch\s*\(|XMLHttpRequest|document\.write|WebSocket|sendBeacon/;
  for (const f of files) {
    const text = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    const hit = text.split('\n').findIndex((line) => bad.test(line.replace(/\/\/.*$/, '')));
    assert.equal(hit, -1, `${f}:${hit + 1} запрещённая конструкция`);
  }
});

// ═══ ADV-10: дефект — перенос платежа теряется ═══════════════════════════════════════════════════════════════════════

test('ADV-10 REQ-082 REQ-083 перенос платежа не теряется молча при досрочном погашении на более раннем платеже: платёж 4 перенесён на 2027-02-20, затем досрочное после платежа 2', () => {
  const moved = move_row_date(REC, 4, '2027-02-20', AS_OF);
  assert.deepEqual(dates_of(moved).slice(3), ['2027-02-20', '2027-03-05', '2027-04-05']);
  for (const option of ['shorten', 'lower_payment']) {
    const next = apply_prepay(moved, { date: '2026-12-05', amount_minor: 10000, option, as_of: AS_OF });
    const d = dates_of(next);
    assert.ok(d.includes('2027-02-20'), `${option}: перенесённая дата 2027-02-20 пропала из графика: ${d.join(' ')}`);
    assert.ok(!d.includes('2027-02-05'), `${option}: платёж вернулся на исходную дату 2027-02-05`);
  }
});

test('ADV-10 REQ-082 REQ-083 перенос платежа не теряется молча при сверке с банком на более раннем платеже', () => {
  const moved = move_row_date(REC, 4, '2027-02-20', AS_OF);
  const r = apply_reanchor(moved, { k: 2, observed_minor: 79000, as_of: AS_OF });
  assert.ok(dates_of(r.debt).includes('2027-02-20'), dates_of(r.debt).join(' '));
});

test('ADV-10 REQ-082 перенос платежа 3 на 20-е число не сдвигает платежи 4–6, если позже записано досрочное погашение на платеже 2', () => {
  const moved = move_row_date(REC, 3, '2027-01-20', AS_OF);
  const next = apply_prepay(moved, { date: '2026-12-05', amount_minor: 10000, option: 'lower_payment', as_of: AS_OF });
  assert.deepEqual(dates_of(next), ['2026-11-05', '2026-12-05', '2027-01-20', '2027-02-05', '2027-03-05', '2027-04-05']);
});

test('ADV-10 REQ-082 «Что применено» не врёт: запись о переносе платежа есть только пока перенос отражён в графике', () => {
  const moved = move_row_date(REC, 4, '2027-02-20', AS_OF);
  const next = apply_prepay(moved, { date: '2026-12-05', amount_minor: 10000, option: 'shorten', as_of: AS_OF });
  for (const h of next.history.filter((e) => e.kind === 'move')) {
    assert.ok(dates_of(next).includes(h.to), `в истории перенос на ${h.to}, а в графике этой даты нет: ${dates_of(next).join(' ')}`);
  }
});

test('ADV-11 REQ-083 «Срок короче» не удлиняет график: после сверки вверх (809→849 €) и досрочного 10,00 € в тот же день вариант shorten даёт не больше платежей, чем «без досрочного»', () => {
  const ra = apply_reanchor(REC, { k: 2, observed_minor: 84900, as_of: AS_OF }).debt;
  const now = rows_of(ra).length - 2;
  const sh = apply_prepay(ra, { date: '2026-12-05', amount_minor: 1000, option: 'shorten', as_of: AS_OF });
  assert.ok(rows_of(sh).length - 2 <= now, `shorten: ${rows_of(sh).length - 2} платежей впереди, без досрочного ${now}`);
});
