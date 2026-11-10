// import_model.test.mjs — FP-06: чистая модель мастера импорта (demo/import_model.mjs) без DOM и браузера.
// TST-42 (дедупликация, REQ-092), TST-43 (профиль, сухой прогон, откат, REQ-093), REQ-091 (пределы и профиль как данные), REQ-099 (hledger).
// Запуск: node --test --test-timeout=120000 --test-concurrency=1 tests/import_model.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as M from '../demo/import_model.mjs';
import { make_id_gen, seeded_ports } from '../demo/ids.mjs';
import { check_model } from '../demo/ws_edit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const enc = (s) => new TextEncoder().encode(s);
const read_json = (p) => JSON.parse(fs.readFileSync(path.join(PROTO, p), 'utf8'));

function deep_freeze(x) {
  if (x === null || typeof x !== 'object' || Object.isFrozen(x)) return x;
  for (const k of Object.keys(x)) deep_freeze(x[k]);
  return Object.freeze(x);
}

const G = deep_freeze(read_json('data/g001.json')); // замороженная: любая мутация мастером упадёт
const FIXTURE = new Uint8Array(fs.readFileSync(path.join(HERE, 'fixtures', 'import-152.csv')));
const FIXTURE_LINES = Buffer.from(FIXTURE).toString('utf8').split('\n');
// один генератор на весь файл: идентификаторы разных партий не повторяются (повтор — отказ duplicate_id, это проверяется отдельным тестом)
const GEN = make_id_gen(seeded_ports({ seed: 11, start_ms: 1790000000000, step_ms: 1 }));
const env = () => ({ new_id: (p) => GEN.entity(p) });

/** Файл-образец: заголовок и первые `n` строк данных (строки с теми же ключами дедупликации, что в полном файле). */
const head_of = (n) => enc(FIXTURE_LINES.slice(0, n + 1).join('\n') + '\n');

/** Мастер, CSV: загрузить байты, сухой прогон встроенным профилем. */
function run_csv(ws, bytes, patch) {
  const w = M.new_wizard();
  const l = M.wiz_csv_load(w, ws, { name: 'выписка.csv', bytes });
  assert.ok(l.ok, JSON.stringify(l));
  if (patch !== undefined) M.wiz_csv_set(w, ws, patch);
  const r = M.wiz_csv_run(w, ws);
  return { w, r };
}

/** Рабочая область после импорта первых `n` строк файла (источник «уже записанных» дубликатов). */
function with_existing(n) {
  const { w } = run_csv(G, head_of(n));
  const c = M.wiz_commit(w, 'csv', G, env());
  assert.ok(c.ok, JSON.stringify(c.error));
  return c.ws;
}

// ── REQ-092 · TST-42 ────────────────────────────────────────────────────────────────────────────────────────────

test('TST-42 REQ-092: файл на 152 строки даёт «распознано 138 · отклонено 2 · дубликатов 12», сумма трёх равна числу строк', () => {
  assert.equal(FIXTURE_LINES.filter((l) => l.trim() !== '').length, 153, 'заголовок + 152 строки данных');
  const ws = with_existing(12);
  const { w, r } = run_csv(ws, FIXTURE);
  assert.ok(r.ok, JSON.stringify(r.error));
  const rp = w.csv.plan.report;
  assert.deepEqual({ rec: rp.recognized, rej: rp.rejected, dup: rp.duplicates, total: rp.rows_total }, { rec: 138, rej: 2, dup: 12, total: 152 });
  assert.equal(rp.recognized + rp.rejected + rp.duplicates, rp.rows_total);
  assert.equal(rp.sum_ok, true);
  assert.deepEqual(Object.keys(rp.by_reason).sort(), ['bad_amount', 'bad_date']);
  assert.deepEqual(rp.reject_rows.map((x) => x.row), [61, 121]);
});

test('TST-42 REQ-092: state_hash не меняется до «Подтвердить» (сухой прогон, отчёт, выбор решений — рабочая область прежняя)', () => {
  const ws = with_existing(12);
  const h0 = M.ws_state_hash(ws);
  const json0 = JSON.stringify(ws);
  const { w } = run_csv(ws, FIXTURE);
  M.wiz_decide(w, 'csv', 1, 'accept');
  M.importable_count(w.csv.plan, w.csv.decisions);
  assert.equal(M.ws_state_hash(ws), h0);
  assert.equal(JSON.stringify(ws), json0);
  const c = M.wiz_commit(w, 'csv', ws, env());
  assert.ok(c.ok, JSON.stringify(c.error));
  assert.notEqual(M.ws_state_hash(c.ws), h0, 'после «Подтвердить» состояние другое');
  assert.equal(M.ws_state_hash(ws), h0, 'и исходная область осталась прежней (чистое преобразование)');
  assert.equal(c.batch.facts, 138);
});

test('TST-42 REQ-092: решения по двойникам — по умолчанию пропуск, «Записать» добавляет строку', () => {
  const ws = with_existing(12);
  // тот же факт с другим описанием: ключ другой, но сумма и окно дат те же → возможный двойник
  const head = FIXTURE_LINES[1].split(',');
  const dup_like = enc('Date,Description,Amount,Currency\n' + [head[0], 'Другое описание', head[head.length - 2], head[head.length - 1].trim()].join(',') + '\n');
  const { w, r } = run_csv(ws, dup_like);
  assert.ok(r.ok);
  assert.equal(w.csv.plan.report.doubles, 1);
  assert.equal(M.importable_count(w.csv.plan, w.csv.decisions), 0, 'двойник по умолчанию пропускается');
  M.wiz_decide(w, 'csv', w.csv.plan.dry.doubles[0], 'accept');
  assert.equal(M.importable_count(w.csv.plan, w.csv.decisions), 1);
  assert.equal(M.wiz_commit(w, 'csv', ws, env()).batch.facts, 1);
});

// ── REQ-093 · TST-43 ────────────────────────────────────────────────────────────────────────────────────────────

test('TST-43 REQ-093: повторный импорт того же файла даёт 0 новых; «Откатить» возвращает state_hash к значению до импорта', () => {
  const h_before = M.ws_state_hash(G);
  const first = run_csv(G, FIXTURE);
  assert.equal(first.w.csv.plan.report.recognized, 150);
  const c = M.wiz_commit(first.w, 'csv', G, env());
  assert.ok(c.ok, JSON.stringify(c.error));
  M.wiz_committed(first.w, 'csv', c.batch);
  assert.equal(first.w.csv.step, 'done');
  assert.notEqual(M.ws_state_hash(c.ws), h_before);
  // повторный импорт: 0 новых, а «Подтвердить» нечего записывать
  const again = run_csv(c.ws, FIXTURE);
  assert.equal(again.w.csv.plan.report.recognized, 0);
  assert.equal(again.w.csv.plan.report.duplicates, 150);
  assert.equal(again.w.csv.plan.report.rejected, 2);
  const none = M.wiz_commit(again.w, 'csv', c.ws, env());
  assert.equal(none.ok, false);
  assert.equal(none.error.code, 'E_SCHEMA');
  assert.equal(none.error.ctx.reason, 'nothing_to_import');
  // откат партии
  const rb = M.wiz_rollback(first.w, c.ws, c.batch.batch_id);
  assert.ok(rb.ok, JSON.stringify(rb.error));
  assert.equal(rb.removed.facts, 150);
  assert.equal(M.ws_state_hash(rb.ws), h_before, 'state_hash вернулся к значению до импорта');
  assert.equal(rb.ws.facts.length, G.facts.length);
  // откат неизвестной партии — отказ, данные прежние
  const bad = M.wiz_rollback(first.w, rb.ws, c.batch.batch_id);
  assert.equal(bad.ok, false);
  assert.equal(bad.error.ctx.reason, 'unknown_batch');
});

test('REQ-093: откат партии не трогает чужие факты (ручной ввод после импорта остаётся), партии различаются', () => {
  const a = run_csv(G, head_of(5));
  const ca = M.wiz_commit(a.w, 'csv', G, env());
  const manual = { ...ca.ws, facts: [...ca.ws.facts, { event_id: 'tx_manual_1', account_id: 'acc_main', date: '2026-10-01', amount_minor: -1234, currency: 'EUR', kind: 'expense', note: 'руками' }] };
  const b = run_csv(manual, head_of(9));
  assert.equal(b.w.csv.plan.report.duplicates, 5);
  const cb = M.wiz_commit(b.w, 'csv', manual, env());
  assert.equal(cb.batch.facts, 4);
  assert.deepEqual(M.list_batches(cb.ws).map((x) => x.count), [5, 4]);
  const rb = M.wiz_rollback(b.w, cb.ws, ca.batch.batch_id);
  assert.equal(rb.removed.facts, 5);
  assert.ok(rb.ws.facts.some((f) => f.event_id === 'tx_manual_1'));
  assert.equal(M.list_batches(rb.ws).length, 1);
});

test('REQ-093: устаревший план (рабочая область менялась после прогона) не записывается; wiz_refresh пересчитывает с теми же решениями', () => {
  const { w } = run_csv(G, head_of(6));
  const other = { ...G, facts: [...G.facts, { event_id: 'tx_other', account_id: 'acc_main', date: '2026-10-02', amount_minor: -100, currency: 'EUR', kind: 'expense' }] };
  const stale = M.wiz_commit(w, 'csv', other, env());
  assert.equal(stale.ok, false);
  assert.equal(stale.error.ctx.reason, 'stale_plan');
  assert.equal(M.wiz_refresh(w, 'csv', other), true);
  assert.equal(M.plan_is_current(w.csv.plan, other), true);
  assert.equal(M.wiz_commit(w, 'csv', other, env()).ok, true);
});

// ── REQ-091 ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-091: файл больше 5 МБ отклоняется до разбора (E_SCHEMA, file_too_large); ровно 5 МБ допустим', () => {
  assert.equal(M.MAX_IMPORT_BYTES, 5 * 1024 * 1024);
  const big = new Uint8Array(M.MAX_IMPORT_BYTES + 1);
  const r = M.check_size(big.length);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_SCHEMA');
  assert.equal(r.error.ctx.reason, 'file_too_large');
  assert.equal(M.check_size(M.MAX_IMPORT_BYTES).ok, true);
  assert.equal(M.check_size(-1).ok, false);
  assert.equal(M.check_size(Number.NaN).ok, false);
  // «до разбора»: декодирования нет, мастер отказывает по размеру; прежний файл не остаётся
  assert.equal(M.decode_bytes(big).error.ctx.reason, 'file_too_large');
  const w = M.new_wizard();
  const l = M.wiz_csv_load(w, G, { name: 'big.csv', bytes: big });
  assert.equal(l.ok, false);
  assert.equal(w.csv.file, null);
  assert.equal(w.csv.text, null);
  assert.equal(w.csv.step, 'file');
  assert.equal(w.csv.error.ctx.reason, 'file_too_large');
  const h = M.wiz_hl_load(w, G, { name: 'big.journal', bytes: big });
  assert.equal(h.ok, false);
  assert.equal(w.hledger.error.ctx.reason, 'file_too_large');
  // plan_csv сам тоже проверяет размер до parse_with_profile
  const p = M.plan_csv(G, { text: 'x', bytes: big, profile: M.BUILTIN_PROFILES['csv-generic'], account_id: 'acc_main' });
  assert.equal(p.error.ctx.reason, 'file_too_large');
});

test('REQ-091: профиль — данные. Regex-поле, исполняемое поле, ключи __proto__/constructor/prototype, чужая кодировка и слишком большой файл отвергаются', () => {
  const base = { profile_id: 'x', v: 1, encoding: 'utf-8', delimiter: ',', skip: 0, date: { col: 'Date', fmt: 'YYYY-MM-DD' }, amount: { mode: 'signed', col: 'Amount' }, currency: { fixed: 'EUR' }, desc: { cols: ['Description'] }, rules: [] };
  const ok = M.read_profile_text(JSON.stringify(base));
  assert.equal(ok.ok, true, JSON.stringify(ok.error));
  const bad = (obj_or_text, reason) => {
    const r = M.read_profile_text(typeof obj_or_text === 'string' ? obj_or_text : JSON.stringify(obj_or_text));
    assert.equal(r.ok, false, String(reason));
    assert.equal(r.error.code, 'E_SCHEMA');
    assert.equal(r.error.ctx.reason, reason);
    return r;
  };
  const r1 = bad({ ...base, rules: [{ match: 'a', tag: 'b', regex: '.*' }] }, 'bad_profile');
  assert.ok(r1.error.ctx.errors.some((e) => /regex/.test(e.field) && e.reason === 'unknown_field'), 'поле regex — вне схемы');
  bad({ ...base, script: 'alert(1)' }, 'bad_profile');
  bad({ ...base, transform: 'x => x' }, 'bad_profile');
  bad({ ...base, amount: { ...base.amount, eval: '1+1' } }, 'bad_profile');
  bad('{"__proto__":{"polluted":1},"profile_id":"x"}', 'forbidden_key');
  bad('{"profile_id":"x","amount":{"constructor":{"prototype":{"x":1}}}}', 'forbidden_key');
  bad('{"profile_id":"x","prototype":1}', 'forbidden_key');
  bad('не json', 'bad_json');
  bad({ ...base, encoding: 'utf-7' }, 'unsupported_encoding'); // кодировка — только из списка мастера
  bad(JSON.stringify({ ...base, pad: 'x'.repeat(M.MAX_PROFILE_BYTES) }), 'profile_too_large');
  assert.equal(M.read_profile_text(42).error.ctx.reason, 'profile_not_text');
  assert.equal({}.polluted, undefined, 'Object.prototype не загрязнён');
  // ошибки отказа не несут значений из файла
  assert.ok(!JSON.stringify(r1.error).includes('.*'));
});

test('REQ-091: правила меток — литералы «подстрока = метка»; строка с регулярным выражением остаётся текстом и не исполняется', () => {
  const r = M.parse_rules_text('Mercado = еда\n^Taxi = транспорт\n\n');
  assert.deepEqual(r.rules, [{ match: 'Mercado', tag: 'еда' }, { match: '^Taxi', tag: 'транспорт' }]);
  assert.equal(M.parse_rules_text('без знака равенства').error.ctx.reason, 'bad_rules');
  assert.equal(M.parse_rules_text('a = ').error.ctx.reason, 'bad_rules');
  assert.equal(M.parse_rules_text('a'.repeat(101) + ' = b').error.ctx.reason, 'bad_rules');
  assert.equal(M.parse_rules_text(Array.from({ length: 51 }, (_, i) => `k${i} = t`).join('\n')).error.ctx.reason, 'bad_rules');
  // строка с регулярным выражением — обычный текст: она не исполняется и не вешает разбор (нет катастрофического возврата)
  const bytes = enc('Date,Description,Amount,Currency\n2026-07-01,Cafe Central,-5.00,EUR\n2026-07-02,' + 'a'.repeat(40) + '!,-6.00,EUR\n');
  const t0 = Date.now();
  const { w, r: run } = run_csv(G, bytes, { profile_choice: 'custom', rules_text: '(zq+)+$ = лит\nCafe = кофе' });
  assert.ok(run.ok, JSON.stringify(run.error));
  assert.ok(Date.now() - t0 < 2000, 'разбор быстрый: правила — литералы, не regex');
  assert.deepEqual(w.csv.plan.dry.recognized_items.map((c) => c.tag), ['кофе', null]);
  assert.equal(M.parse_rules_text('.* = лит').error.ctx.reason, 'bad_rules', '«.*» без букв и цифр не годится как подстрока');
});

test('REQ-091: «12,50» при thousands="," не превращается в 1250,00 — строка отклонена как bad_amount, «1,250.00» читается как 1250,00', () => {
  const bytes = enc('Date,Description,Amount,Currency\n2026-07-01,Один,"12,50",EUR\n2026-07-02,Два,"1,250.00",EUR\n2026-07-03,Три,12.50,EUR\n');
  const { w, r } = run_csv(G, bytes);
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.equal(w.csv.mapping.decimal, '.');
  assert.equal(w.csv.mapping.thousands, ',');
  const rp = w.csv.plan.report;
  assert.equal(rp.rejected, 1);
  assert.deepEqual(rp.reject_rows, [{ row: 2, reason: 'bad_amount' }]);
  assert.deepEqual(w.csv.plan.dry.recognized_items.map((c) => c.amount_minor), [125000, 1250]);
  assert.ok(!w.csv.plan.dry.recognized_items.some((c) => c.amount_minor === 1250 && c.row === 2));
});

test('REQ-091: описание операции — только значение поля: управляющие знаки убираются, разметка остаётся текстом (в разметку идёт через textContent)', () => {
  const evil = '<img src=x onerror=alert(1)>\u0007 Cafe';
  const bytes = enc('Date,Description,Amount,Currency\n2026-07-01,"' + evil + '",-5.00,EUR\n');
  const { w } = run_csv(G, bytes);
  const c = M.wiz_commit(w, 'csv', G, env());
  assert.ok(c.ok, JSON.stringify(c.error));
  const fact = c.ws.facts.at(-1);
  assert.equal(typeof fact.note, 'string');
  assert.ok(!/[\u0000-\u001f]/.test(fact.note));
  assert.ok(fact.note.includes('<img'), 'текст сохранён как есть: экранирует не данные, а способ вставки (textContent)');
  const src = fs.readFileSync(path.join(PROTO, 'demo', 'import_wizard.mjs'), 'utf8');
  assert.ok(!/inner\s*HTML|outer\s*HTML|insertAdjacent/i.test(src), 'нет вставки разметки из строк');
  assert.ok(!/setAttribute\(\s*'style'/.test(src));
});

test('REQ-091: кодировка и разделитель — выбор пользователя; windows-1251 читается, `;` и запятая в сумме определяются по образцу', () => {
  const txt = 'Дата;Описание;Сумма;Валюта\n01.07.2026;Магазин;-1.234,50;EUR\n02.07.2026;Кафе;-12,00;EUR\n';
  // кодируем в windows-1251 вручную
  const map = new Map([...'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя'].map((ch, i) => [ch, 0xc0 + i]));
  const bytes = Uint8Array.from([...txt].map((ch) => (map.has(ch) ? map.get(ch) : ch.charCodeAt(0))));
  const w = M.new_wizard();
  M.wiz_csv_load(w, G, { name: 'банк.csv', bytes });
  assert.notEqual(w.csv.sniff.header[0], 'Дата', 'в utf-8 кириллица портится — пользователь выбирает кодировку');
  M.wiz_csv_set(w, G, { encoding: 'windows-1251' });
  assert.deepEqual(w.csv.sniff.header, ['Дата', 'Описание', 'Сумма', 'Валюта']);
  assert.equal(w.csv.sniff.delimiter, ';');
  assert.equal(w.csv.mapping.date_fmt, 'DD.MM.YYYY');
  assert.equal(w.csv.mapping.decimal, ',');
  assert.equal(w.csv.mapping.thousands, '.');
  assert.equal(w.csv.recommended, null);
  const r = M.wiz_csv_run(w, G);
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.deepEqual(w.csv.plan.dry.recognized_items.map((c) => c.amount_minor), [-123450, -1200]);
  assert.deepEqual(w.csv.plan.dry.recognized_items.map((c) => c.desc), ['Магазин', 'Кафе']);
  assert.equal(M.decode_bytes(bytes, 'klingon').error.ctx.reason, 'unsupported_encoding');
  assert.equal(M.sniff_csv('a,b\n1,2', { delimiter: '|' }).error.ctx.reason, 'bad_delimiter');
  assert.equal(M.sniff_csv('a,b\n1,2', { skip: 5 }).error.ctx.reason, 'no_header_row');
});

test('REQ-091: колонки «расход / приход», пропуск строк преамбулы, валюта счёта — профиль собирается из сопоставления и проходит схему движка', () => {
  const txt = 'Выписка за июль\nСчёт 1234\nДата;Расход;Приход;Назначение\n01/07/2026;12,50;;Кофе\n02/07/2026;;100,00;Возврат\n';
  const w = M.new_wizard();
  M.wiz_csv_load(w, G, { name: 'x.csv', bytes: enc(txt) });
  M.wiz_csv_set(w, G, { skip: 2 });
  assert.deepEqual(w.csv.sniff.header, ['Дата', 'Расход', 'Приход', 'Назначение']);
  assert.equal(w.csv.mapping.amount_mode, 'debit_credit');
  M.wiz_csv_set(w, G, { currency_mode: 'account' });
  const p = M.wiz_csv_profile(w, G);
  assert.ok(p.ok, JSON.stringify(p.error));
  assert.deepEqual(p.profile.currency, { fixed: 'EUR' });
  assert.equal(p.profile.skip, 2);
  const r = M.wiz_csv_run(w, G);
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.deepEqual(w.csv.plan.dry.recognized_items.map((c) => c.amount_minor), [-1250, 10000]);
  // неполное сопоставление — отказ, а не молчаливая подстановка
  M.wiz_csv_set(w, G, { amount_mode: 'signed', amount_col: -1 });
  assert.equal(M.wiz_csv_run(w, G).error.ctx.reason, 'bad_mapping');
  assert.equal(w.csv.plan, null);
  // неизвестные ключи не попадают в состояние
  M.wiz_csv_set(w, G, { __proto__: { x: 1 }, nonsense: 1, account_id: 'нет_такого' });
  assert.equal(w.csv.account_id, 'acc_main');
  assert.equal(Object.hasOwn(w.csv, 'nonsense'), false);
});

test('REQ-091: профиль из файла пользователя — принят целиком или отвергнут; встроенные профили совпадают с data/profiles/*.json', () => {
  for (const id of Object.keys(M.BUILTIN_PROFILES)) assert.deepEqual(read_json(`data/profiles/${id}.json`), M.BUILTIN_PROFILES[id], 'копия профиля разошлась с файлом: ' + id);
  const w = M.new_wizard();
  M.wiz_csv_load(w, G, { name: 'a.csv', bytes: FIXTURE });
  const good = M.wiz_csv_profile_file(w, G, JSON.stringify(M.BUILTIN_PROFILES['csv-generic']));
  assert.ok(good.ok, JSON.stringify(good));
  assert.equal(w.csv.profile_choice, 'file');
  assert.ok(M.wiz_csv_run(w, G).ok);
  const bad = M.wiz_csv_profile_file(w, G, '{"__proto__":{"a":1}}');
  assert.equal(bad.ok, false);
  assert.equal(w.csv.error.ctx.reason, 'forbidden_key');
  assert.equal(w.csv.profile_choice, 'file', 'прежний выбор не испорчен отказом');
});

// ── REQ-099 ─────────────────────────────────────────────────────────────────────────────────────────────────────

const HL_OK = [
  'commodity EUR 1.000,00',
  '',
  '2026-09-01 Зарплата',
  '    assets:bank    1000,00 EUR',
  '    income:salary',
  '',
  '2026-09-02 Кофе',
  '    expenses:food    3,50 EUR',
  '    assets:bank',
  '',
  '2026-09-03 Перевод на накопления',
  '    assets:savings    200,00 EUR',
  '    assets:bank',
  '',
].join('\n');

function hl(ws, text) {
  const w = M.new_wizard();
  const r = M.wiz_hl_load(w, ws, { name: 'j.journal', bytes: enc(text) });
  return { w, r };
}

test('REQ-099: hledger-журнал с двумя ногами импортируется через сухой прогон; перевод — одно целое, партия откатывается вместе с новыми счетами', () => {
  const h0 = M.ws_state_hash(G);
  const { w, r } = hl(G, HL_OK);
  assert.ok(r.ok, JSON.stringify(w.hledger.error));
  const rp = w.hledger.plan.report;
  assert.equal(rp.recognized + rp.rejected + rp.duplicates, rp.rows_total, 'те же три числа, что у CSV');
  assert.equal(rp.rejected, 0);
  assert.equal(M.ws_state_hash(G), h0, 'сухой прогон данные не меняет');
  assert.ok(w.hledger.plan.extras.counts.accounts_new >= 2, 'новые счета названы в отчёте');
  assert.equal(w.hledger.plan.pairs.size, 1, 'перевод на накопления — одна пара ног');
  const c = M.wiz_commit(w, 'hledger', G, env());
  assert.ok(c.ok, JSON.stringify(c.error));
  assert.ok(c.batch.facts >= 3);
  assert.ok(c.ws.accounts.length > G.accounts.length);
  assert.equal(check_model(c.ws).ok, true, JSON.stringify(check_model(c.ws).errors?.slice(0, 3)));
  const trf = c.ws.facts.filter((f) => f.batch_id === c.batch.batch_id && f.kind === 'transfer');
  assert.equal(trf.length, 2);
  assert.equal(trf[0].transfer_id, trf[1].transfer_id);
  assert.equal(trf[0].amount_minor + trf[1].amount_minor, 0);
  // повтор — 0 новых
  const again = hl(c.ws, HL_OK);
  assert.equal(again.w.hledger.plan.report.recognized, 0);
  assert.equal(M.wiz_commit(again.w, 'hledger', c.ws, env()).error.ctx.reason, 'nothing_to_import');
  // откат партии убирает факты и внесённые ею счета
  M.wiz_committed(w, 'hledger', c.batch);
  const rb = M.wiz_rollback(w, c.ws, c.batch.batch_id);
  assert.ok(rb.ok, JSON.stringify(rb.error));
  assert.equal(M.ws_state_hash(rb.ws), h0);
  assert.equal(rb.ws.accounts.length, G.accounts.length);
});

test('REQ-099: «@» и «@@» дают явный отказ E_SCHEMA и строку «не поддержано» с номером строки; ничего не записывается', () => {
  const cases = [
    ['unit', '2026-09-01 Покупка\n    assets:bank    -100 EUR\n    assets:broker  10 STK @ 10 EUR\n', 3, 'price_unit'],
    ['total', '2026-09-01 Покупка\n    assets:bank    -100 EUR\n    assets:broker  10 STK @@ 100 EUR\n', 3, 'price_total'],
  ];
  for (const [name, text, line, reason] of cases) {
    const { w, r } = hl(G, text);
    assert.equal(r.ok, false, name);
    assert.equal(w.hledger.plan, null, name);
    assert.equal(w.hledger.error.code, 'E_SCHEMA', name);
    assert.equal(w.hledger.error.ctx.reason, 'unsupported_constructs', name);
    assert.deepEqual(w.hledger.unsupported, [{ line, reason }], name);
    assert.equal(M.wiz_commit(w, 'hledger', G, env()).ok, false, 'записывать нечего');
  }
});

test('REQ-099: больше двух активных ног — отказ с номером строки; все места названы разом, а не по одному; молчаливой потери нет', () => {
  const text = [
    '2026-09-01 Три ноги', '    assets:a   -30 EUR', '    assets:b   -30 EUR', '    assets:c   60 EUR', '',
    '2026-09-02 Цена', '    assets:a   -10 EUR', '    assets:x   1 STK @@ 10 EUR', '',
    '2026-09-03 Нормальная', '    expenses:food   5 EUR', '    assets:a', '',
  ].join('\n');
  const { w, r } = hl(G, text);
  assert.equal(r.ok, false);
  assert.deepEqual(w.hledger.unsupported, [{ line: 1, reason: 'more_than_two_assets' }, { line: 8, reason: 'price_total' }]);
  assert.equal(w.hledger.error.ctx.count, 2);
  for (const u of w.hledger.unsupported) assert.ok(M.HL_REASONS.includes(u.reason), 'для каждой причины есть строка каталога');
  // тексты строк журнала в отказ не попадают
  assert.ok(!JSON.stringify(w.hledger.error).includes('Три ноги'));
  // журнал только с поддержанным подмножеством — проходит
  assert.ok(hl(G, '2026-09-03 Нормальная\n    expenses:food   5 EUR\n    assets:a\n').r.ok);
  // якорь «=» с несколькими ногами не считается лишней ногой
  assert.equal(M.scan_hledger('2026-09-01 X\n    assets:a   -30 EUR = 100 EUR\n    assets:b   -30 EUR\n    assets:c   60 EUR\n').length, 0);
});

test('REQ-099: прочие отказы hledger (битая дата, сумма без валюты) — строка «не поддержано» с причиной из списка, а не исключение', () => {
  const a = hl(G, '2026-13-45 Плохая дата\n    expenses:food   5 EUR\n    assets:a\n');
  assert.equal(a.r.ok, false);
  assert.equal(a.w.hledger.error.code, 'E_SCHEMA');
  assert.equal(a.w.hledger.unsupported[0].reason, 'bad_date');
  const b = hl(G, '2026-09-03 Без валюты\n    expenses:food   5\n    assets:a\n');
  assert.equal(b.r.ok, false);
  assert.ok(M.HL_REASONS.includes(b.w.hledger.unsupported[0].reason));
});

test('REQ-099: перевод, у которого одна нога уже в данных, не записывается одноногим; будущая дата — отказ строки', () => {
  const first = hl(G, HL_OK);
  const c = M.wiz_commit(first.w, 'hledger', G, env());
  // убираем из данных одну ногу перевода (как будто её удалили руками)
  const trf = c.ws.facts.filter((f) => f.kind === 'transfer');
  const damaged = { ...c.ws, facts: c.ws.facts.filter((f) => f.event_id !== trf[0].event_id) };
  const again = hl(damaged, HL_OK);
  assert.ok(again.r.ok, JSON.stringify(again.w.hledger.error));
  const rp = again.w.hledger.plan.report;
  assert.equal(rp.recognized + rp.rejected + rp.duplicates, rp.rows_total);
  assert.ok(rp.rejected >= 1, 'вторая нога отклонена: перевод не станет одноногим');
  assert.ok(again.w.hledger.plan.dry.recognized_items.every((x) => x.transfer_ref === undefined));
  const future = hl(G, '2027-01-01 Будущее\n    expenses:food   5 EUR\n    assets:bank\n');
  assert.ok(future.r.ok);
  assert.equal(future.w.hledger.plan.report.rejected, 1);
  assert.ok(Object.keys(future.w.hledger.plan.report.by_reason).includes('future_date'));
});

// ── сопутствующее ───────────────────────────────────────────────────────────────────────────────────────────────

test('TST-42 TST-43: все причины отказа, отклонения и «не поддержано» имеют строки каталога RU и EN (ключи import.err_*, import.rj_*, import.hl_why_*)', async () => {
  const catalog = (await import('../demo/i18n/import.mjs')).default;
  for (const lang of ['ru', 'en']) {
    for (const r of M.ERROR_REASONS) assert.ok(catalog[lang]['import.err_' + r], `${lang}: err_${r}`);
    for (const r of [...M.REJECT_REASONS, 'other']) assert.ok(catalog[lang]['import.rj_' + r], `${lang}: rj_${r}`);
    for (const r of M.HL_REASONS) assert.ok(catalog[lang]['import.hl_why_' + r], `${lang}: hl_why_${r}`);
    for (const id of Object.keys(M.BUILTIN_PROFILES)) assert.ok(catalog[lang]['import.pf_' + id.replaceAll('-', '_')], `${lang}: pf_${id}`);
    for (const s of M.STEPS) assert.ok(catalog[lang]['import.step_' + s], `${lang}: step_${s}`);
    for (const t of M.TABS) assert.ok(catalog[lang]['import.tab_' + t], `${lang}: tab_${t}`);
  }
  assert.equal(M.reason_id({ ctx: { reason: 'что-то новое' } }), 'other');
  assert.equal(M.reason_id({ ctx: { reason: 'file_too_large' } }), 'file_too_large');
});

test('err_of: исключение движка превращается в {code, ctx} без значений из файла', () => {
  const e = Object.assign(new Error('x'), { code: 'E_SCHEMA', ctx: { reason: 'unterminated_quote', line: 7, value: 'секретный текст', errors: [{ field: 'f', reason: 'r', value: 'секрет' }] } });
  const r = M.err_of(e);
  assert.equal(r.code, 'E_SCHEMA');
  assert.equal(r.ctx.reason, 'unterminated_quote');
  assert.equal(r.ctx.line, 7);
  assert.ok(!JSON.stringify(r).includes('секрет'));
  assert.deepEqual(M.err_of(new Error('boom')), { code: 'E_SCHEMA', ctx: { reason: 'other' } });
});
