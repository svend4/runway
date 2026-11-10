// import_main_thread.test.mjs — исправления FP-18 после независимой проверки (REQ-091): остальные стадии большого файла не держат страницу одной долгой задачей.
// Дефект D2 (medium): в Worker уходил только разбор, а образец колонок (`sniff_csv`: разбор всего файла ради шести строк, около полусекунды на 5 МБ) и вторая
// половина сухого прогона (сверка, хэш файла, отчёт — одной задачей) оставались на главном потоке. Здесь:
//   - `count_csv_rows` считает записи тем же автоматом, что `parse_csv`, но без строк и массивов (совпадение — на случайных входах);
//   - `sniff_csv` большого файла берёт образец с головы и совпадает с разбором целиком (включая отказ на оборванной кавычке в любом месте файла);
//   - `make_report` форматирует день один раз (отчёт тот же), `plan_csv_async` разносит стадии большого файла по задачам и хэширует вне главного потока;
//   - модель на файле около 5 МБ печатает длительность каждой задачи (строка «# FP-18 исправление: модель задач главного потока»).
// Также: D3 (low) — `terminate()` до первого разбора не создаёт воркер; низкий дефект «amount_scale» при профиле минимальных единиц — нейтральная формулировка.
// Цифры с этой машины на телефон не переносятся; абсолютные пороги в тестах взяты с пятикратным запасом к бюджету ADR-014 (50 мс на задачу), чтобы нагрузка
// машины не давала ложных красных; строгое сравнение — относительное (новый путь против прежнего на том же файле).
// Расчёт по введённым данным и правилам, не консультация.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/import_main_thread.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import * as M from '../demo/import_model.mjs';
import * as WZ from '../demo/import_wizard.mjs';
import * as C from '../demo/import_worker_client.mjs';
import { t, register_strings } from '../demo/i18n.mjs';
import import_catalog from '../demo/i18n/import.mjs';
import { export_csv_file } from '../demo/data_actions.mjs';
import { parse_csv, parse_with_profile } from '../engine/io.mjs';
import { sha256, format_date } from '../engine/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const enc = (s) => new TextEncoder().encode(s);
const read_json = (p) => JSON.parse(fs.readFileSync(path.join(PROTO, p), 'utf8'));
const WS = read_json('data/g001.json');
register_strings('import', import_catalog); // как делает pack_fp06.mjs при запуске приложения (заодно проверяет паритет RU/EN и плейсхолдеры новых строк)
const round1 = (x) => Math.round(x * 10) / 10;

/** Детерминированный генератор (mulberry32): случайные входы воспроизводимы. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Файл банка около `target_bytes`: описания по ~100 знаков в кавычках, строки по ~160 знаков. */
function bank_text(target_bytes) {
  const rows = ['Date,Description,Amount,Currency'];
  let size = rows[0].length + 1;
  for (let i = 0; size < target_bytes - 400; i++) {
    const cents = (i % 997) + 1;
    const r = `2026-0${1 + (i % 9)}-${String(1 + (i % 28)).padStart(2, '0')},"CARD PAYMENT TO MERCHANT ${i % 4093} REF ${String(100000000 + i)} BERLIN DE VALUE DATE 2026 ${i % 97} SEPA ${i % 13}",-${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')},EUR`;
    rows.push(r);
    size += r.length + 1;
  }
  return rows.join('\n') + '\n';
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 1. count_csv_rows = parse_csv(...).length
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

const expected_count = (text, d) => {
  try { return parse_csv(text, { delimiter: d }).length; } catch (e) { assert.equal(e.ctx?.reason, 'unterminated_quote'); return -1; }
};

test('REQ-091 FP-18 D2 count_csv_rows: число записей равно parse_csv(...).length на крайних случаях и на 6000 случайных входов; оборванная кавычка даёт -1', () => {
  const edge = [
    '', '\n', '\r\n', '\r', ',,,\n', 'a', 'a\n', 'a\r\nb', 'a\rb\r', '"a"', '"a', 'a,"b\nc",d\n', '""\n', '"",""\n', '""""\n', '"a""b"\n', 'a"b,c\n', '"a"b,c\n',
    '﻿a,b\n', '﻿', '﻿"x"\n', 'a,b\n\n\n,\n ,\n', 'x\n"y\nz"\n', '"a",\n', ',"b"\n', 'a,\r\n"b",\r\n', 'a;b\nc;d', '"\n"', '"\n', 'a\n"b', '"a"\n"b"c"',
  ];
  for (const text of edge) for (const d of [',', ';', '\t']) assert.equal(M.count_csv_rows(text, d), expected_count(text, d), JSON.stringify(text) + ' · ' + JSON.stringify(d));
  const rnd = rng(1801);
  const toks = ['"', ',', ';', '\t', '\n', '\r', '\r\n', 'a', 'b', ' ', 'é', '""', '"x"', 'x', '", "', '\n\n'];
  let broken = 0;
  for (let i = 0; i < 2000; i++) {
    let text = rnd() < 0.1 ? '﻿' : '';
    const n = Math.floor(rnd() * 40);
    for (let k = 0; k < n; k++) text += toks[Math.floor(rnd() * toks.length)];
    for (const d of [',', ';', '\t']) {
      const want = expected_count(text, d);
      if (want < 0) broken += 1;
      assert.equal(M.count_csv_rows(text, d), want, JSON.stringify(text) + ' · ' + JSON.stringify(d));
    }
  }
  assert.ok(broken > 100, 'среди случайных входов достаточно оборванных кавычек: ' + broken);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 2. sniff_csv по голове = sniff_csv по целому файлу
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

const FULL = { prefix_min: Infinity };
const OPTS = [{}, { delimiter: ';' }, { delimiter: ',' }, { delimiter: '\t' }, { skip: 2 }, { skip: 1, delimiter: ',' }, { delimiter: 'auto', skip: 4 }];

/** Сравнить образец по голове (малые пороги — голова действительно мала) и по целому файлу для всех наборов настроек. */
function same_as_full(text, label, heads = [150, 900, 5000]) {
  for (const o of OPTS) {
    const full = M.sniff_csv(text, { ...o, ...FULL });
    for (const head_chars of heads) assert.deepEqual(M.sniff_csv(text, { ...o, prefix_min: 1, head_chars }), full, `${label} · ${JSON.stringify(o)} · голова ${head_chars}`);
  }
}

function rows_file(n, o = {}) {
  const nl = o.nl ?? '\n';
  const d = o.d ?? ',';
  const lines = [...(o.preamble ?? []), ['Date', 'Description', 'Amount', 'Currency'].join(d)];
  for (let i = 0; i < n; i++) {
    let desc = `Покупка №${i}`;
    if (i % 7 === 0) desc = `"Покупка, №${i} ""особая"""`;
    if (i % 11 === 0) desc = `"Строка 1 №${i}${nl}строка 2"`;
    lines.push([`2026-0${1 + (i % 9)}-${String(1 + (i % 28)).padStart(2, '0')}`, desc, `-${1 + (i % 90)}${o.dec ?? '.'}${String(i % 100).padStart(2, '0')}`, 'EUR'].join(d));
    if (i % 13 === 0 && o.blank) lines.push('');
  }
  return (o.bom === true ? '﻿' : '') + lines.join(nl) + (o.final_nl === false ? '' : nl);
}

test('REQ-091 FP-18 D2 sniff_csv: образец с головы файла совпадает с разбором целиком (заголовок, шесть строк, образец, число строк, разделитель) на разных файлах и настройках', () => {
  same_as_full(rows_file(400), 'банк LF');
  same_as_full(rows_file(400, { nl: '\r\n' }), 'банк CRLF');
  same_as_full(rows_file(300, { nl: '\r' }), 'банк CR');
  same_as_full(rows_file(300, { bom: true, blank: true }), 'BOM и пустые строки');
  same_as_full(rows_file(300, { d: ';', dec: ',', preamble: ['Выписка за год', 'Счёт 1', '', 'Владелец'] }), 'точка с запятой и преамбула');
  same_as_full(rows_file(300, { d: '\t' }), 'TAB');
  same_as_full(rows_file(300, { final_nl: false }), 'без перевода строки в конце');
  // граница «в файле достаточно записей для образца»: skip + 1 + 60 + 1
  for (const n of [0, 1, 5, 59, 60, 61, 62, 63, 64, 70]) same_as_full(rows_file(n), 'строк с данными ' + n, [150, 400]);
  // заголовок длиннее головы
  const wide = Array.from({ length: 500 }, (_, i) => 'Колонка' + i).join(',');
  same_as_full([wide, ...Array.from({ length: 200 }, (_, i) => Array.from({ length: 500 }, (_, k) => (i + k) % 10).join(','))].join('\n') + '\n', 'широкий заголовок', [150, 900]);
  // пустое и вырожденное
  for (const tx of ['', '\n\n\n', 'Date\n', 'Date,Amount']) same_as_full(tx, JSON.stringify(tx), [3, 150]);
});

/** Строки без единой кавычки: после оборванной кавычки в них нет ничего, что могло бы её закрыть. */
const plain_rows = (n) => Array.from({ length: n }, (_, i) => `2026-0${1 + (i % 9)}-${String(1 + (i % 28)).padStart(2, '0')},Покупка №${i},-${1 + (i % 90)}.${String(i % 100).padStart(2, '0')},EUR`);
const PLAIN_HEAD = 'Date,Description,Amount,Currency';

test('REQ-091 FP-18 D2 sniff_csv: оборванная кавычка в любом месте файла — тот же отказ unterminated_quote, что при разборе целиком; закрытая в пределах файла — не отказ', () => {
  const nl = (parts) => parts.join('\n');
  const at_end = nl([PLAIN_HEAD, ...plain_rows(300), '"оборвано', 'ещё строка', '']);
  const mid = nl([PLAIN_HEAD, ...plain_rows(150), '2026-01-01,"не закрыто,-1.00,EUR', ...plain_rows(150), '']);
  const head = '"' + nl([PLAIN_HEAD, ...plain_rows(300), '']); // кавычка открыта в самом начале файла и не закрывается
  for (const [label, text] of [['в конце', at_end], ['в середине', mid], ['в начале', head]]) {
    const full = M.sniff_csv(text, FULL);
    assert.equal(full.ok, false, label);
    assert.equal(full.error.ctx.reason, 'unterminated_quote', label);
    same_as_full(text, 'оборванная кавычка ' + label, [150, 900]);
  }
  // кавычка, закрытая в пределах файла (в том числе далеко от начала): отказа нет или он тот же, образец тот же
  same_as_full(rows_file(200).replace('\n2026-05', '\n"2026-05') + '"\n', 'кавычка закрыта в конце', [150, 900]);
  // длинное поле в кавычках с переводами строк через границу головы — отказа нет, образец тот же
  const long = nl(['Date,Description,Amount,Currency', '2026-01-01,"' + 'длинное описание\n'.repeat(80) + '",-1.00,EUR', ...rows_file(100).split('\n').slice(1)]);
  assert.equal(M.sniff_csv(long, FULL).ok, true);
  same_as_full(long, 'длинное поле через границу головы', [150, 900]);
  // плохой разделитель от головы не зависит
  assert.deepEqual(M.sniff_csv(rows_file(200), { delimiter: 'x', prefix_min: 1, head_chars: 150 }), M.sniff_csv(rows_file(200), { delimiter: 'x', ...FULL }));
});
test('REQ-091 FP-18 D2 sniff_csv: случайные CSV-подобные файлы (кавычки, переводы строк, пустые строки, BOM) — образец по голове равен образцу по целому', () => {
  const rnd = rng(1802);
  const cells = ['2026-01-05', 'Кофе', '-4,50', 'EUR', '"с, запятой"', '"с ""кавычкой"""', '"два\nряда"', '', ' ', 'a;b', '12.345,67', '"', 'x"y'];
  let ok_n = 0;
  let err_n = 0;
  for (let i = 0; i < 300; i++) {
    const delim = [',', ';', '\t'][Math.floor(rnd() * 3)];
    const nl = ['\n', '\r\n', '\r'][Math.floor(rnd() * 3)];
    const rows = [];
    const n = 20 + Math.floor(rnd() * 160);
    for (let r = 0; r < n; r++) rows.push(Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => cells[Math.floor(rnd() * cells.length)]).join(delim));
    const text = (rnd() < 0.15 ? '﻿' : '') + rows.join(nl) + (rnd() < 0.5 ? nl : '');
    const o = OPTS[Math.floor(rnd() * OPTS.length)];
    const full = M.sniff_csv(text, { ...o, ...FULL });
    if (full.ok) ok_n += 1; else err_n += 1;
    assert.deepEqual(M.sniff_csv(text, { ...o, prefix_min: 1, head_chars: 120 + Math.floor(rnd() * 600) }), full, `случай ${i}: ${JSON.stringify(o)}`);
  }
  assert.ok(ok_n > 50 && err_n > 20, `и успешные, и отказные случаи: ${ok_n} / ${err_n}`);
});

test('REQ-091 FP-18 D2 sniff_csv: файл от WORKER_MIN_BYTES идёт по голове при пороге по умолчанию, результат тот же, что при разборе целиком', () => {
  const text = bank_text(400 * 1024);
  assert.ok(text.length >= M.WORKER_MIN_BYTES);
  const full = M.sniff_csv(text, FULL);
  const fast = M.sniff_csv(text);
  assert.deepEqual(fast, full);
  assert.equal(fast.ok, true);
  assert.equal(fast.rows_total, text.split('\n').length - 2, 'строк с данными: все, кроме заголовка и пустого хвоста');
  assert.equal(fast.samples.length, 60);
  assert.deepEqual(M.sniff_csv(text, { delimiter: ',', skip: 0 }), M.sniff_csv(text, { delimiter: ',', skip: 0, ...FULL }));
  // малый файл не меняется вовсе: прежний путь
  const small = bank_text(20 * 1024);
  assert.ok(small.length < M.WORKER_MIN_BYTES);
  assert.deepEqual(M.sniff_csv(small), M.sniff_csv(small, FULL));
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 3. make_report: тот же отчёт; plan_csv_async: стадии большого файла по задачам, хэш тот же
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

test('REQ-091 FP-18 D2 make_report: «строк не позже последнего якоря» считается по-прежнему (форматирование дня запоминается, результат тот же)', () => {
  let nonzero = 0;
  for (const name of ['g001', 'g001-low', 'g001-gap', 'g001-late']) {
    const ws = read_json(`data/${name}.json`);
    const exp = export_csv_file(ws);
    const w = M.new_wizard();
    assert.ok(M.wiz_csv_load(w, ws, { name: 'r.csv', bytes: enc(exp.text) }).ok);
    assert.ok(M.wiz_csv_run(w, ws).ok);
    const plan = w.csv.plan;
    // прямой счёт: формат каждого дня заново, сравнение строк ISO
    const last = new Map();
    for (const a of ws.anchors) if (!last.has(a.account_id) || a.date > last.get(a.account_id)) last.set(a.account_id, a.date);
    let naive = 0;
    for (const c of plan.dry.recognized_items) { const a = last.get(c.account_id); if (a !== undefined && format_date(c.date) <= a) naive += 1; }
    assert.equal(plan.report.covered_by_anchor, naive, name);
    assert.equal(M.make_report(plan.dry, [], ws).covered_by_anchor, naive, name + ': и вызов напрямую');
    assert.equal(M.make_report(plan.dry, []).covered_by_anchor, 0, name + ': без рабочей области якорей нет');
    nonzero += naive;
  }
  assert.ok(nonzero > 0, 'проверка не пустая: есть строки не позже якоря');
});

function stub_parser() {
  const calls = [];
  return { calls, parse_csv: async (profile, text, ctx) => { calls.push(1); return { result: parse_with_profile(profile, text, ctx), via: 'worker', reason: null }; } };
}

const with_crypto = async (replacement, fn) => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: replacement, configurable: true, writable: true });
  try { return await fn(); } finally { if (saved !== undefined) Object.defineProperty(globalThis, 'crypto', saved); else delete globalThis.crypto; }
};

test('REQ-091 FP-18 D2 plan_csv_async: большой файл — стадии отдельными задачами (две уступки потока), план тот же, что у plan_csv; хэш тот же при SubtleCrypto, без него и при его отказе', async () => {
  const text = rows_file(500);
  const bytes = enc(text);
  const input = { text, bytes, name: 'банк.csv', profile: M.BUILTIN_PROFILES['csv-generic'], account_id: 'acc_main', header: ['Date', 'Description', 'Amount', 'Currency'] };
  const sync_plan = M.plan_csv(WS, input).plan;
  const events = [];
  const parser = stub_parser();
  const pause = async () => { events.push('pause'); await new Promise((r) => { setTimeout(r, 0); }); events.push('resume'); };
  // порог 1 байт: файл «большой», ушёл бы в Worker
  const r = await M.plan_csv_async(WS, { ...input, worker_min_bytes: 1, pause }, parser);
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.equal(parser.calls.length, 1);
  assert.deepEqual(events, ['pause', 'resume', 'pause', 'resume'], 'ровно две уступки: после сверки и после хэша');
  const same = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));
  same(r.plan.report, sync_plan.report);
  same(r.plan.candidates, sync_plan.candidates);
  same(r.plan.dry, sync_plan.dry);
  assert.equal(r.plan.source.hash, sha256(bytes));
  assert.equal(r.plan.source.hash, sync_plan.source.hash);
  assert.deepEqual(r.plan.parse, { via: 'worker', reason: null });
  // малый файл по умолчанию — стадии подряд, уступок нет
  events.length = 0;
  const small = await M.plan_csv_async(WS, { ...input, pause }, parser);
  assert.ok(small.ok);
  assert.deepEqual(events, [], 'малый файл: без уступок');
  same(small.plan.report, sync_plan.report);
  // хэш без SubtleCrypto и при его отказе — тот же (код движка)
  for (const [label, fake] of [['нет crypto', undefined], ['нет subtle', {}], ['subtle.digest отказывает', { subtle: { digest: async () => { throw new Error('нет защищённого контекста'); } } }]]) {
    const got = await with_crypto(fake, () => M.plan_csv_async(WS, { ...input, worker_min_bytes: 1, pause: async () => {} }, parser));
    assert.ok(got.ok, label);
    assert.equal(got.plan.source.hash, sha256(bytes), label);
  }
  // отказ разбора проходит как раньше и до уступок
  const bad = await M.plan_csv_async(WS, { ...input, profile: { ...input.profile, date: { col: 'НетТакой', fmt: 'YYYY-MM-DD' } }, worker_min_bytes: 1, pause }, parser);
  assert.equal(bad.ok, false);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 4. Модель задач главного потока на файле около 5 МБ
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

test('REQ-091 REQ-150 FP-18 D2 модель: на файле около 5 МБ образец колонок и стадии после разбора — короткие задачи, прежний образец (разбор всего файла) заметно дороже; результаты те же', async () => {
  const text = bank_text(5 * 1024 * 1024);
  const bytes = enc(text);
  assert.ok(text.length > 4.9 * 1024 * 1024 && bytes.length <= M.MAX_IMPORT_BYTES, 'размер файла: ' + bytes.length);
  const timed = (fn) => { const s = performance.now(); const v = fn(); return [v, performance.now() - s]; };

  const [decoded, decode_ms] = timed(() => M.decode_bytes(bytes, 'utf-8'));
  assert.ok(decoded.ok);
  // образец: прежний путь (разбор целиком) и новый (голова + счёт записей), дважды — берём меньшее время (первый вызов греет код)
  const [full, full_a] = timed(() => M.sniff_csv(text, FULL));
  const [fast, fast_a] = timed(() => M.sniff_csv(text));
  const [, full_b] = timed(() => M.sniff_csv(text, FULL));
  const [, fast_b] = timed(() => M.sniff_csv(text));
  const full_ms = Math.min(full_a, full_b);
  const fast_ms = Math.min(fast_a, fast_b);
  assert.deepEqual(fast, full, 'файл ~5 МБ: образец по голове равен образцу по целому');

  // стадии после разбора: разбор вынесен (заглушка отвечает сразу), замеряются задачи страницы между уступками потока
  const ctx = { account_id: 'acc_main', account_currency: 'EUR', as_of: WS.as_of };
  const parsed = parse_with_profile(M.BUILTIN_PROFILES['csv-generic'], text, ctx);
  const stamps = {};
  const parser = { parse_csv: async () => { stamps.parsed = performance.now(); return { result: parsed, via: 'worker', reason: null }; } };
  const pause = async () => {
    stamps[stamps.p1 === undefined ? 'p1' : 'p2'] = performance.now();
    await new Promise((r) => { setTimeout(r, 0); });
    stamps[stamps.r1 === undefined ? 'r1' : 'r2'] = performance.now();
  };
  const input = { text, bytes, name: 'год.csv', profile: M.BUILTIN_PROFILES['csv-generic'], account_id: 'acc_main', header: fast.header, pause };
  const res = await M.plan_csv_async(WS, input, parser);
  stamps.end = performance.now();
  assert.ok(res.ok, JSON.stringify(res.error));
  const dry_ms = stamps.p1 - stamps.parsed; // сверка с данными и предупреждения: одна задача
  const hash_wall_ms = stamps.p2 - stamps.r1; // хэш: SubtleCrypto вне главного потока, это время ожидания, а не блокировки
  const report_ms = stamps.end - stamps.r2; // отчёт
  assert.equal(res.plan.source.hash, sha256(bytes), 'хэш файла тот же, что у кода движка');
  const [, engine_hash_ms] = timed(() => sha256(bytes));
  const [, report_again_ms] = timed(() => M.make_report(res.plan.dry, parsed.rejects, WS, res.plan.report.warnings));

  const line = {
    file_mb: round1(bytes.length / 1048576), rows: parsed.candidates.length, decode_ms: round1(decode_ms),
    sniff_old_full_parse_ms: round1(full_ms), sniff_new_head_and_count_ms: round1(fast_ms),
    dry_run_task_ms: round1(dry_ms), hash_wait_ms_off_main_thread: round1(hash_wall_ms), old_sha256_on_main_ms: round1(engine_hash_ms), report_task_ms: round1(report_ms), report_again_ms: round1(report_again_ms),
  };
  console.log('# FP-18 исправление: модель задач главного потока (Node ' + process.version + '): ' + JSON.stringify(line));

  assert.ok(full_ms > 100, 'прежний образец на таком файле занимал заметное время: ' + full_ms);
  assert.ok(fast_ms < 0.5 * full_ms, `образец по голове ${fast_ms} мс против ${full_ms} мс при разборе целиком`);
  // бюджет ADR-014 — 50 мс на задачу (гипотеза); порог проверки — пятикратный: нагрузка машины не должна давать красный без регресса
  for (const [name, ms] of [['образец', fast_ms], ['сверка с данными', dry_ms], ['отчёт', report_ms], ['декодирование', decode_ms]]) assert.ok(ms <= 250, `${name}: ${ms} мс`);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 5. D3: terminate() до первого разбора
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

test('FP-18 D3 клиент воркера: terminate() до первого разбора не создаёт воркер; разбор идёт на главном потоке с причиной terminated; повторный terminate безопасен', async () => {
  let created = 0;
  const fake = () => { created += 1; return { postMessage() {}, terminate() {} }; };
  const c = C.create_import_client({ make_worker: fake });
  c.terminate();
  c.terminate();
  const text = 'Date,Description,Amount,Currency\n2026-09-01,Кофе,-4.50,EUR\n';
  const ctx = { account_id: 'acc_main', account_currency: 'EUR', as_of: '2026-10-04' };
  const r = await c.parse_csv(M.BUILTIN_PROFILES['csv-generic'], text, ctx);
  assert.deepEqual([r.via, r.reason], ['main', 'terminated']);
  assert.equal(created, 0, 'после terminate() воркер не создаётся');
  assert.equal(JSON.stringify(r.result), JSON.stringify(parse_with_profile(M.BUILTIN_PROFILES['csv-generic'], text, ctx)));
  assert.equal(c.stats().pending, 0);
  // без остановки воркер создаётся один раз, как раньше (заглушка не отвечает: остановка освобождает ожидающие вызовы, они разбираются на месте)
  const d = C.create_import_client({ make_worker: fake });
  const p1 = d.parse_csv(M.BUILTIN_PROFILES['csv-generic'], text, ctx);
  const p2 = d.parse_csv(M.BUILTIN_PROFILES['csv-generic'], text, ctx);
  assert.equal(created, 1);
  d.terminate();
  const both = await Promise.all([p1, p2]);
  assert.deepEqual(both.map((x) => [x.via, x.reason]), [['main', 'terminated'], ['main', 'terminated']]);
  assert.equal(created, 1);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 6. Низкий дефект: amount_scale при профиле минимальных единиц
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

test('FP-18 amount_scale: профиль уже читает минимальные единицы — предупреждение помечено unit=minor и говорит нейтрально (счёт и файл), а не «прочитана как основные»', () => {
  // рабочая область, где у счёта якорь 100,00 € и нет фактов: выгрузка G-001 (крупнейшая сумма 2 880,00 €) намного больше
  const ws = { ...WS, facts: [], anchors: WS.anchors.slice(0, 1).map((a) => ({ ...a, amount_minor: 10000 })) };
  const exp = export_csv_file(WS);
  const w = M.new_wizard();
  assert.ok(M.wiz_csv_load(w, ws, { name: 'runway.csv', bytes: enc(exp.text) }).ok);
  assert.equal(w.csv.profile_choice, 'runway-csv-1');
  assert.ok(M.wiz_csv_run(w, ws).ok);
  const warn = w.csv.plan.report.warnings;
  assert.deepEqual(warn.map((x) => x.code), ['amount_scale'], 'название колонки не вводит в заблуждение, масштаб — да');
  assert.equal(warn[0].unit, 'minor');
  assert.equal(warn[0].peak_minor, 288000);
  const money = (m) => WZ.money_text('ru', m, 'EUR', ws.as_of);
  const ru = WZ.warning_text((k, p) => t('ru', k, p), warn[0], money);
  const en = WZ.warning_text((k, p) => t('en', k, p), warn[0], (m) => WZ.money_text('en', m, 'EUR', ws.as_of));
  assert.match(ru, /Единицы суммы заданы как минимальные/);
  assert.match(ru, /нужный счёт/);
  assert.ok(!/прочитана как основные/.test(ru), ru);
  assert.match(en, /amount units are set to minor/);
  assert.ok(!/read as major/.test(en), en);
  // те же числа, что у обычной формулировки
  assert.match(ru, /2\s?880,00.*28 раз.*100,00/);
  // та же рабочая область, колонка прочитана как основные: прежняя формулировка и без пометки
  const m = M.new_wizard();
  assert.ok(M.wiz_csv_load(m, ws, { name: 'runway.csv', bytes: enc(exp.text) }).ok);
  assert.ok(M.wiz_csv_set(m, ws, { profile_choice: 'custom', amount_unit: 'major' }).ok);
  assert.ok(M.wiz_csv_run(m, ws).ok);
  const mw = m.csv.plan.report.warnings.find((x) => x.code === 'amount_scale');
  assert.ok(mw !== undefined);
  assert.equal(mw.unit, undefined);
  assert.match(WZ.warning_text((k, p) => t('ru', k, p), mw, money), /прочитана как основные/);
  // прямой вызов модели не менялся
  assert.deepEqual(M.scale_warning(ws, 'acc_main', [{ amount_minor: 288000 }]), { code: 'amount_scale', ratio: 28, peak_minor: 288000, ref_minor: 10000 });
});
