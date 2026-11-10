// import_runway_csv.test.mjs — FP-18, REQ-095 и REQ-091: собственный CSV Runway, выгруженный приложением (export_csv_file), читается мастером импорта с теми же суммами.
// Ошибка аудита: мастер читал колонку amount_minor как основные единицы, и сумма получалась в 100 раз больше. Здесь: воспроизведение причины, круг
// «экспорт → мастер → импорт → тот же состав фактов» на четырёх наборах G-001 (g001, low, gap, late), встроенный профиль runway-csv-1 и его автоопределение
// по заголовку, единицы суммы в своих колонках, предупреждения сухого прогона (название колонки и масштаб сумм), ограничения круга.
// Чистая модель без DOM (demo/import_model.mjs); экран и воркер — в import_runway_boot.test.mjs и import_worker.test.mjs.
// Расчёт по введённым данным и правилам, не консультация.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/import_runway_csv.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as M from '../demo/import_model.mjs';
import { export_csv_file } from '../demo/data_actions.mjs';
import { make_id_gen, seeded_ports } from '../demo/ids.mjs';
import { RUNWAY_CSV_PROFILE, validate_profile, parse_csv, parse_with_profile } from '../engine/io.mjs';
import { state_hash } from '../engine/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const enc = (s) => new TextEncoder().encode(s);
const read_json = (p) => JSON.parse(fs.readFileSync(path.join(PROTO, p), 'utf8'));

function deep_freeze(x) {
  if (x === null || typeof x !== 'object' || Object.isFrozen(x)) return x;
  for (const k of Object.keys(x)) deep_freeze(x[k]);
  return Object.freeze(x);
}

const SETS = ['g001', 'g001-low', 'g001-gap', 'g001-late'];
const WS = Object.fromEntries(SETS.map((n) => [n, deep_freeze(read_json(`data/${n}.json`))])); // замороженные: любая мутация мастером упадёт
const GEN = make_id_gen(seeded_ports({ seed: 18, start_ms: 1790000000000, step_ms: 1 }));
const env = () => ({ new_id: (p) => GEN.entity(p) });

const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const norm_note = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().normalize('NFC');

/**
 * Хэш состава фактов: `state_hash` над фактами, приведёнными к тому, что CSV Runway переносит (счёт, дата, сумма, валюта, описание), в порядке
 * (дата, сумма, описание). Идентификаторы, метки, контрагенты, ключи дедупликации и партии не входят: после импорта они другие.
 */
function facts_hash(ws) {
  const rows = ws.facts.map((f) => ({ account_id: f.account_id, date: f.date, amount_minor: f.amount_minor, currency: f.currency, note: norm_note(f.note) }));
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.amount_minor - b.amount_minor) || (a.note < b.note ? -1 : a.note > b.note ? 1 : 0)));
  return state_hash({ facts: Object.fromEntries(rows.map((r, i) => ['f' + String(i).padStart(5, '0'), r])) });
}

/** Выгрузка `ws_src` самим приложением → мастер (загрузка, профиль по умолчанию, сухой прогон) на рабочей области `target`. */
function through_wizard(ws_src, target, patch) {
  const exp = export_csv_file(ws_src);
  const w = M.new_wizard();
  const l = M.wiz_csv_load(w, target, { name: 'runway-csv.csv', bytes: enc(exp.text) });
  assert.ok(l.ok, JSON.stringify(l.error));
  if (patch !== undefined) M.wiz_csv_set(w, target, patch);
  const r = M.wiz_csv_run(w, target);
  assert.ok(r.ok, JSON.stringify(r.error));
  return { w, exp, plan: w.csv.plan, report: w.csv.plan.report };
}

// ── шаг 1: воспроизведение ошибки и её причина ───────────────────────────────────────────────────────────────────

test('REQ-095 FP-18 воспроизведение: CSV, выгруженный приложением, при чтении колонки amount_minor «как основные единицы» даёт сумму в 100 раз больше; движок тут ни при чём', () => {
  const ws = WS.g001;
  const exp = export_csv_file(ws);
  const first = exp.text.split('\n')[1];
  assert.equal(first, '2026-07-09,acc_main,-2500,EUR,expense,posted,связь,,,evt~000020,', 'в файле сумма в минимальных единицах: -2500 означает -25,00 €');
  const orig_net = sum(ws.facts.map((f) => f.amount_minor));
  assert.equal(orig_net, 192000);

  // причина: сопоставление колонок «как основные единицы» (так мастер читал файл до исправления)
  const target = { ...ws, facts: [] };
  const sn = M.sniff_csv(exp.text);
  const mapping = { ...M.suggest_mapping(sn), amount_unit: 'major' };
  const built = M.build_profile(mapping, sn, { currency: 'EUR' });
  assert.ok(built.ok, JSON.stringify(built.error));
  assert.equal(built.profile.amount.unit, undefined, 'профиль без единиц = основные');
  const wrong = M.plan_csv(target, { text: exp.text, bytes: enc(exp.text), profile: built.profile, account_id: 'acc_main', header: sn.header });
  assert.ok(wrong.ok);
  assert.equal(wrong.plan.report.net_minor, 100 * orig_net, 'расхождение: 192000 → 19200000, ровно в 100 раз');
  assert.equal(wrong.plan.candidates[0].amount_minor, -250000, '-2500 прочитано как -2500,00 = -250000 minor');
  assert.equal(Math.max(...wrong.plan.candidates.map((c) => Math.abs(c.amount_minor))), 100 * 288000);

  // движок со встроенным профилем движка читает тот же текст верно
  const eng = parse_with_profile(RUNWAY_CSV_PROFILE, exp.text, { account_id: 'acc_main', account_currency: 'EUR', as_of: ws.as_of });
  assert.equal(sum(eng.candidates.map((c) => c.amount_minor)), orig_net, 'профиль движка runway-csv/1 даёт верные суммы');

  // и именно на этом пути сухой прогон теперь предупреждает: название колонки и масштаб сумм
  const codes = wrong.plan.report.warnings.map((x) => x.code);
  assert.deepEqual(codes, ['minor_as_major', 'amount_scale']);
  assert.deepEqual(wrong.plan.report.warnings[0], { code: 'minor_as_major', col: 'amount_minor', factor: 100 });
  assert.equal(wrong.plan.report.warnings[1].ratio, 72, '28 800 000 / 400 000 (последний якорь) = 72');
  assert.equal(wrong.plan.report.warnings[1].peak_minor, 28800000);
  assert.equal(wrong.plan.report.warnings[1].ref_minor, 400000);
});

// ── шаг 2: круг «экспорт → мастер → импорт» на четырёх наборах ──────────────────────────────────────────────────────

for (const name of SETS) {
  test(`REQ-095 FP-18 круг на наборе ${name}: экспорт → мастер (профиль runway-csv-1 по заголовку) → импорт даёт тот же состав фактов и те же суммы; повторный импорт — 0 новых; откат возвращает state_hash`, () => {
    const ws = WS[name];
    const target = { ...ws, facts: [] }; // те же счета и якоря, фактов нет: файл Runway переносят в «чистую» область
    const h_target = M.ws_state_hash(target);
    const { w, exp, plan, report } = through_wizard(ws, target);

    // профиль определён по заголовку и выбран сам
    assert.equal(w.csv.recommended, 'runway-csv-1');
    assert.equal(w.csv.profile_choice, 'runway-csv-1');
    assert.equal(plan.profile_id, 'runway-csv/1');
    // отчёт: все факты распознаны, строки плана названы пропущенными профилем, предупреждений нет
    assert.equal(exp.rows, ws.facts.length + ws.plans.length);
    assert.equal(report.recognized, ws.facts.length);
    assert.equal(report.duplicates, 0);
    assert.equal(report.rejected, ws.plans.length);
    assert.deepEqual(report.by_reason, { filtered_out: ws.plans.length });
    assert.equal(report.sum_ok, true);
    assert.deepEqual(report.warnings, []);
    assert.equal(report.net_minor, sum(ws.facts.map((f) => f.amount_minor)), 'итог файла равен итогу фактов, а не в 100 раз больше');
    assert.equal(M.ws_state_hash(target), h_target, 'сухой прогон данные не меняет');

    // запись
    const c = M.wiz_commit(w, 'csv', target, env());
    assert.ok(c.ok, JSON.stringify(c.error));
    assert.equal(c.ws.facts.length, ws.facts.length);
    assert.equal(facts_hash(c.ws), facts_hash(ws), 'тот же state_hash состава фактов (счёт, дата, сумма, валюта, описание)');
    assert.equal(sum(c.ws.facts.map((f) => f.amount_minor)), sum(ws.facts.map((f) => f.amount_minor)));
    assert.equal(Math.max(...c.ws.facts.map((f) => Math.abs(f.amount_minor))), 288000, 'самая крупная сумма — 2 880,00 €, а не 288 000,00 €');
    for (const f of c.ws.facts) assert.equal(typeof f.dedup_key, 'string');

    // повторный импорт того же файла: 0 новых
    const again = through_wizard(ws, c.ws);
    assert.equal(again.report.recognized, 0);
    assert.equal(again.report.duplicates, ws.facts.length);
    assert.equal(again.report.rejected, ws.plans.length);
    assert.equal(again.report.recognized + again.report.rejected + again.report.duplicates, again.report.rows_total);
    const none = M.wiz_commit(again.w, 'csv', c.ws, env());
    assert.equal(none.ok, false);
    assert.equal(none.error.ctx.reason, 'nothing_to_import');

    // откат партии возвращает состояние до импорта
    const rb = M.wiz_rollback(w, c.ws, c.batch.batch_id);
    assert.ok(rb.ok, JSON.stringify(rb.error));
    assert.equal(M.ws_state_hash(rb.ws), h_target);
  });
}

for (const name of SETS) {
  test(`REQ-095 FP-18 круг на наборе ${name} с опасными описаниями: «=», «+», «-», «@», апострофы, кавычки, запятые, юникод — описание возвращается без ведущего «'», состав фактов тот же`, () => {
    const notes = ['=HYPERLINK("http://x")', '-5 coffee', '+1 bonus', '@SUM(A1)', "'=x", "''=y", 'Cafe, "Central"', 'кофе — «эспрессо» ☕', 'Café', 'line1\nline2', '\tтаб', ' пробелы '];
    const ws = deep_freeze({ ...structuredClone(WS[name]), facts: structuredClone(WS[name]).facts.map((f, i) => (i < notes.length ? { ...f, note: notes[i] } : f)) });
    const target = { ...ws, facts: [] };
    const { plan, report } = through_wizard(ws, target);
    assert.equal(report.recognized, ws.facts.length);
    assert.deepEqual(report.warnings, []);
    const got = new Map(plan.candidates.map((c) => [c.row, c.desc]));
    const descs = [...got.values()].filter((d) => d !== '');
    assert.ok(descs.includes('=HYPERLINK("http://x")') && descs.includes('-5 coffee') && descs.includes('+1 bonus') && descs.includes('@SUM(A1)'), 'формулы без апострофа');
    assert.ok(descs.includes("'=x") && descs.includes("''=y"), 'апостроф самого текста сохранён');
    assert.ok(descs.includes('line1 line2'), 'перевод строки внутри ячейки становится пробелом (как у любого импорта)');
    assert.equal(descs.filter((d) => /^'[=+\-@]/.test(d)).length, 1, "апостроф остался только у текста, который сам начинался с «'=»");
    const c = M.wiz_commit(through_wizard(ws, target).w, 'csv', target, env());
    assert.ok(c.ok, JSON.stringify(c.error));
    assert.equal(facts_hash(c.ws), facts_hash(ws));
  });
}

test('REQ-095 FP-18 критерий приёмки REQ-095: описание =HYPERLINK("http://x") выгружается с апострофом и возвращается без него, сумма -4730 остаётся -4730 (не -4730,00)', () => {
  const ws = deep_freeze({
    ...structuredClone(WS.g001),
    facts: [{ event_id: 'tx-req095', account_id: 'acc_main', date: '2026-10-03', amount_minor: -4730, currency: 'EUR', kind: 'expense', note: '=HYPERLINK("http://x")' }],
  });
  const rows = parse_csv(export_csv_file(ws).text);
  const posted = rows.filter((r) => r[5] === 'posted');
  assert.equal(posted.length, 1);
  assert.equal(posted[0][2], '-4730', 'колонка суммы без изменений');
  assert.equal(posted[0][8], '\'=HYPERLINK("http://x")', 'описание экранировано апострофом');
  const target = { ...ws, facts: [] };
  const { plan, report } = through_wizard(ws, target);
  assert.equal(report.recognized, 1);
  assert.equal(plan.candidates[0].amount_minor, -4730, '-4730 минимальных единиц = -47,30 €, а не -4730,00 €');
  assert.equal(plan.candidates[0].desc, '=HYPERLINK("http://x")');
  const c = M.wiz_commit(through_wizard(ws, target).w, 'csv', target, env());
  assert.ok(c.ok);
  assert.equal(c.ws.facts[0].amount_minor, -4730);
  assert.equal(c.ws.facts[0].note, '=HYPERLINK("http://x")');
  assert.equal(facts_hash(c.ws), facts_hash(ws));
});

test('REQ-095 FP-18 импорт собственной выгрузки в те же данные: все строки — возможные двойники уже записанных фактов, по умолчанию не записываются (ничего не удваивается)', () => {
  const ws = WS.g001;
  const { w, report, plan } = through_wizard(ws, ws);
  assert.equal(report.recognized, ws.facts.length);
  assert.equal(report.doubles, ws.facts.length);
  assert.equal(M.importable_count(plan, w.csv.decisions), 0);
  const c = M.wiz_commit(w, 'csv', ws, env());
  assert.equal(c.ok, false);
  assert.equal(c.error.ctx.reason, 'nothing_to_import');
});

test('REQ-095 FP-18 FP-47 ограничения круга закреплены тестом: метки возвращаются (контрагентов в наборе нет), виды и номер счёта файла не читаются (для полной копии — JSON), все счета пишутся в выбранный', () => {
  // FP-47 (намеренное изменение ожидания): раньше тест фиксировал, что метки после импорта пропадают (f.tag === undefined); теперь профиль читает колонку tag.
  const ws = WS.g001;
  assert.ok(ws.facts.some((f) => typeof f.tag === 'string'), 'в наборе есть метки');
  const target = { ...ws, facts: [] };
  const { w } = through_wizard(ws, target);
  const c = M.wiz_commit(w, 'csv', target, env());
  assert.ok(c.ok);
  const tags = (x) => x.facts.filter((f) => typeof f.tag === 'string').map((f) => f.date + '|' + f.amount_minor + '|' + f.tag).sort();
  assert.deepEqual(tags(c.ws), tags(ws), 'метки вернулись к тем же фактам');
  assert.ok(c.ws.facts.every((f) => f.counterparty_id === undefined), 'контрагентов в наборе нет: и в импорте их нет');
  assert.ok(c.ws.facts.every((f) => f.kind === 'income' || f.kind === 'expense'), 'вид файла (kind) не читается: вид выводится из знака суммы');
  // два счёта в одной валюте: строки обоих пишутся в выбранный счёт (профиль не различает account_id файла)
  const two = deep_freeze({
    ...structuredClone(ws),
    accounts: [...structuredClone(ws.accounts), { ...structuredClone(ws.accounts[0]), account_id: 'acc_two', name: 'Второй счёт' }],
    facts: [...structuredClone(ws.facts).slice(0, 3), { event_id: 'tx_two_1', account_id: 'acc_two', date: '2026-09-20', amount_minor: -7777, currency: 'EUR', kind: 'expense' }],
  });
  const t2 = { ...two, facts: [] };
  const r2 = through_wizard(two, t2);
  const c2 = M.wiz_commit(r2.w, 'csv', t2, env());
  assert.ok(c2.ok);
  assert.deepEqual([...new Set(c2.ws.facts.map((f) => f.account_id))], ['acc_main'], 'ограничение: счёт выбирается в мастере, а не берётся из файла');
});

// ── профиль-данные и его копии ─────────────────────────────────────────────────────────────────────────────────

test('REQ-091 REQ-095 FP-18 профиль runway-csv-1: файл data/profiles = копия в BUILTIN_PROFILES = RUNWAY_CSV_PROFILE движка; схема принимает; остальные профили не затронуты', () => {
  const file = read_json('data/profiles/runway-csv-1.json');
  assert.deepEqual(file, M.BUILTIN_PROFILES['runway-csv-1'], 'копия в мастере совпадает с файлом');
  assert.deepEqual(file, JSON.parse(JSON.stringify(RUNWAY_CSV_PROFILE)), 'и с профилем движка runway-csv/1 (канон C-045)');
  assert.deepEqual(validate_profile(file), { ok: true, errors: [] });
  assert.equal(file.amount.unit, 'minor');
  assert.deepEqual(file.filter, { col: 'layer', equals: 'posted' });
  assert.equal(file.desc.csv_safe, true);
  assert.deepEqual(Object.keys(M.BUILTIN_PROFILES), ['csv-generic', 'csv-semicolon-dmy', 'runway-csv-1']);
  assert.equal(Object.isFrozen(M.BUILTIN_PROFILES['runway-csv-1']), true);
  // первый столбец-заголовок выгрузки содержит все колонки профиля: профиль и экспорт не разойдутся незаметно
  const header = parse_csv(export_csv_file(WS.g001).text)[0];
  const need = [file.date.col, file.amount.col, file.currency.col, ...file.desc.cols, file.filter.col];
  for (const col of need) assert.ok(header.includes(col), 'колонка профиля есть в выгрузке: ' + col);
  assert.deepEqual(header, ['date', 'account_id', 'amount_minor', 'currency', 'kind', 'layer', 'tag', 'counterparty', 'note', 'event_id', 'dedup_key']);
});

test('REQ-095 FP-18 автоопределение по заголовку: выгрузка Runway → runway-csv-1 (в том числе с другим разделителем); банковские файлы — прежние профили; без колонки layer профиль не предлагается', () => {
  const text = export_csv_file(WS.g001).text;
  assert.equal(M.recommend_profile(M.sniff_csv(text)), 'runway-csv-1');
  // пересохранено в таблице с «;»: колонки те же, разделитель другой
  const semi = text.split('\n').map((l) => l.replace(/,/g, ';')).join('\n'); // в G-001 нет запятых внутри ячеек
  const sn = M.sniff_csv(semi);
  assert.equal(sn.delimiter, ';');
  assert.equal(M.recommend_profile(sn), 'runway-csv-1');
  const w = M.new_wizard();
  M.wiz_csv_load(w, WS.g001, { name: 'таблица.csv', bytes: enc(semi) });
  assert.equal(w.csv.profile_choice, 'runway-csv-1');
  assert.equal(M.wiz_csv_profile(w, WS.g001).profile.delimiter, ';', 'разделитель берётся из файла');
  assert.equal(M.BUILTIN_PROFILES['runway-csv-1'].delimiter, ',', 'сам встроенный профиль не изменился');
  const target = { ...WS.g001, facts: [] };
  const w2 = M.new_wizard();
  M.wiz_csv_load(w2, target, { name: 'таблица.csv', bytes: enc(semi) });
  const r = M.wiz_csv_run(w2, target);
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.equal(r.plan.report.net_minor, 192000);
  // банковский файл: прежний профиль, не Runway
  const bank = new Uint8Array(fs.readFileSync(path.join(HERE, 'fixtures', 'import-152.csv')));
  assert.equal(M.recommend_profile(M.sniff_csv(new TextDecoder().decode(bank))), 'csv-generic');
  assert.equal(M.recommend_profile(M.sniff_csv('Date;Description;Amount;Currency\n01/09/2026;x;-1,50;EUR\n')), 'csv-semicolon-dmy');
  // есть amount_minor, но нет layer: это не выгрузка Runway — профиль не предлагается, колонки сопоставляются вручную (единицы определяются по названию)
  const partial = 'date,amount_minor,currency,note\n2026-09-01,-4730,EUR,кофе\n';
  assert.equal(M.recommend_profile(M.sniff_csv(partial)), null);
});

// ── единицы суммы в своих колонках ─────────────────────────────────────────────────────────────────────────────

test('REQ-095 FP-18 looks_minor и suggest_mapping: amount_minor / cents → минимальные единицы, Amount → основные', () => {
  for (const n of ['amount_minor', 'Amount_Minor', 'AmountMinor', 'minor_units', 'Minor units', 'amount (cents)', 'cents', 'Cent', 'sum_in_cents']) assert.equal(M.looks_minor(n), true, n);
  for (const n of ['Amount', 'amount', 'Betrag', 'Сумма', 'minority', 'Description', 'incent', 'recent', '', null, undefined, 5]) assert.equal(M.looks_minor(n), false, String(n));
  const sug = (csv) => M.suggest_mapping(M.sniff_csv(csv));
  assert.equal(sug('date,amount_minor,currency,note\n2026-09-01,-4730,EUR,x\n').amount_unit, 'minor');
  assert.equal(sug('Date,Amount,Currency,Description\n2026-09-01,-47.30,EUR,x\n').amount_unit, 'major');
  assert.equal(sug('Date,Debit,Credit,Description\n2026-09-01,47.30,,x\n').amount_unit, 'major', 'расход/приход — всегда основные');
});

test('REQ-095 FP-18 «Свои колонки» на файле Runway: единицы определились как минимальные — суммы верные; ручной выбор «основные» возвращает старую ошибку, но с предупреждением', () => {
  const ws = WS.g001;
  const target = { ...ws, facts: [] };
  const custom = through_wizard(ws, target, { profile_choice: 'custom' });
  assert.equal(custom.w.csv.profile_choice, 'custom');
  assert.equal(custom.w.csv.mapping.amount_unit, 'minor');
  assert.equal(custom.report.net_minor, 192000);
  assert.deepEqual(custom.report.warnings, []);
  assert.equal(custom.plan.candidates.length, ws.facts.length);
  // выбрали «основные» вручную: ошибка в 100 раз видна в предупреждениях
  const manual = through_wizard(ws, target, { profile_choice: 'custom', amount_unit: 'major' });
  assert.equal(manual.report.net_minor, 19200000);
  assert.deepEqual(manual.report.warnings.map((x) => x.code), ['minor_as_major', 'amount_scale']);
  // и обратно
  M.wiz_csv_set(manual.w, target, { amount_unit: 'minor' });
  const fixed = M.wiz_csv_run(manual.w, target);
  assert.equal(fixed.plan.report.net_minor, 192000);
  assert.deepEqual(fixed.plan.report.warnings, []);
  // профиль, собранный из сопоставления, несёт unit только для минимальных единиц
  assert.equal(M.wiz_csv_profile(manual.w, target).profile.amount.unit, 'minor');
  M.wiz_csv_set(manual.w, target, { amount_unit: 'major' });
  assert.equal(M.wiz_csv_profile(manual.w, target).profile.amount.unit, undefined);
});

test('REQ-095 FP-18 build_profile: единицы — только major | minor; минимальные единицы требуют одной колонки со знаком; переключение на расход/приход сбрасывает единицы', () => {
  const sn = M.sniff_csv('date,amount_minor,debit,credit,currency,note\n2026-09-01,-4730,,,EUR,x\n');
  const base = M.suggest_mapping(sn);
  assert.equal(base.amount_unit, 'minor');
  const bad = (m) => M.build_profile(m, sn, { currency: 'EUR' });
  assert.equal(bad({ ...base, amount_unit: 'cents' }).error.ctx.field, 'amount_unit');
  assert.equal(bad({ ...base, amount_mode: 'debit_credit', debit_col: 2, credit_col: 3, amount_unit: 'minor' }).error.ctx.field, 'amount_unit');
  const ok = bad({ ...base, amount_unit: undefined });
  assert.ok(ok.ok);
  assert.equal(ok.profile.amount.unit, undefined, 'без поля — основные, как раньше');
  const w = M.new_wizard();
  M.wiz_csv_load(w, WS.g001, { name: 'a.csv', bytes: enc('date,amount_minor,debit,credit,currency,note\n2026-09-01,-4730,,,EUR,x\n') });
  assert.equal(w.csv.mapping.amount_unit, 'minor');
  M.wiz_csv_set(w, WS.g001, { amount_mode: 'debit_credit' });
  assert.equal(w.csv.mapping.amount_unit, 'major');
  assert.equal(M.MAPPING_FIELDS.includes('amount_unit'), true);
});

// ── предупреждения сухого прогона ─────────────────────────────────────────────────────────────────────────────

test('REQ-091 FP-18 scale_warning: сравнение с остатком, якорями и крупнейшей операцией на счёте; ровно в SCALE_RATIO раз — ещё не предупреждение; нет базы — нет предупреждения', () => {
  assert.equal(M.SCALE_RATIO, 20);
  const ws = {
    as_of: '2026-10-04',
    accounts: [{ account_id: 'a', name: 'a', kind: 'bank', liquidity: 'operating', currency: 'EUR' }],
    anchors: [{ anchor_id: 'x1', account_id: 'a', date: '2026-10-01', amount_minor: 100000 }],
    facts: [{ event_id: 'f1', account_id: 'a', date: '2026-10-02', amount_minor: -5000, currency: 'EUR' }],
  };
  const w = (peak) => M.scale_warning(ws, 'a', [{ amount_minor: 10 }, { amount_minor: -peak }]);
  assert.equal(w(2000000), null, 'ровно 20 × 100 000 — не больше порога');
  assert.deepEqual(w(2000001), { code: 'amount_scale', ratio: 20, peak_minor: 2000001, ref_minor: 100000 });
  assert.equal(w(1200000), null, 'обычный крупный платёж (12 000 € при остатке ≈ 1 000 €) не повод для тревоги');
  assert.equal(M.scale_warning(ws, 'a', []), null);
  assert.equal(M.scale_warning({ ...ws, anchors: [], facts: [] }, 'a', [{ amount_minor: 10 ** 12 }]), null, 'сравнивать не с чем');
  assert.equal(M.scale_warning(ws, 'other', [{ amount_minor: 10 ** 12 }]), null, 'чужой счёт не считается базой');
  // остаток = последний якорь + факты после него; факты до якоря в остаток не входят
  const ws2 = { ...ws, facts: [{ event_id: 'f0', account_id: 'a', date: '2026-09-01', amount_minor: 9 * 10 ** 6, currency: 'EUR' }, { event_id: 'f2', account_id: 'a', date: '2026-10-03', amount_minor: 300000, currency: 'EUR' }] };
  assert.deepEqual(M.scale_warning(ws2, 'a', [{ amount_minor: 9 * 10 ** 8 }]), { code: 'amount_scale', ratio: 100, peak_minor: 9 * 10 ** 8, ref_minor: 9 * 10 ** 6 }, 'крупнейшая величина на счёте — старый факт');
  assert.equal(M.scale_warning(ws2, 'a', [{ amount_minor: 9 * 10 ** 7 }]), null, 'всего в 10 раз больше старого факта — не тревога');
  // большие числа: сравнение целочисленное
  const huge = M.scale_warning(ws, 'a', [{ amount_minor: Number.MAX_SAFE_INTEGER }]);
  assert.equal(huge.ratio, Number(BigInt(Number.MAX_SAFE_INTEGER) / 100000n));
});

test('REQ-091 REQ-095 FP-18 minor_warning: название колонки суммы указывает на минимальные единицы, а профиль читает основные; колонка задана номером — имя берётся из заголовка; валюта без дробной части — без предупреждения', () => {
  const prof = (amount) => ({ profile_id: 'x', v: 1, delimiter: ',', date: { col: 0, fmt: 'YYYY-MM-DD' }, amount, currency: { fixed: 'EUR' }, desc: { cols: [3] } });
  assert.deepEqual(M.minor_warning(prof({ mode: 'signed', col: 'amount_minor' }), undefined, 2), { code: 'minor_as_major', col: 'amount_minor', factor: 100 });
  assert.deepEqual(M.minor_warning(prof({ mode: 'signed', col: 1 }), ['date', 'amount_minor', 'x', 'y'], 2), { code: 'minor_as_major', col: 'amount_minor', factor: 100 });
  assert.equal(M.minor_warning(prof({ mode: 'signed', col: 1 }), undefined, 2), null, 'номер колонки без заголовка — имени нет');
  assert.equal(M.minor_warning(prof({ mode: 'signed', col: 'amount_minor', unit: 'minor' }), undefined, 2), null);
  assert.equal(M.minor_warning(prof({ mode: 'signed', col: 'Amount' }), undefined, 2), null);
  assert.equal(M.minor_warning(prof({ mode: 'signed', col: 'amount_minor' }), undefined, 0), null, 'JPY: минимальные и основные единицы совпадают');
  assert.equal(M.minor_warning(prof({ mode: 'signed', col: 'amount_minor' }), undefined, 3).factor, 1000);
  assert.deepEqual(M.minor_warning(prof({ mode: 'debit_credit', debit: 'debit_minor', credit: 'credit' }), undefined, 2), { code: 'minor_as_major', col: 'debit_minor', factor: 100 });
  assert.equal(M.minor_warning(null, undefined, 2), null);
  const long = 'amount_minor_' + 'x'.repeat(100);
  assert.equal(M.minor_warning(prof({ mode: 'signed', col: long }), undefined, 2).col.length, 40, 'имя колонки из файла обрезается');
});

test('REQ-091 FP-18 ложных тревог нет: банковский файл на 152 строки и обычные суммы G-001 проходят сухой прогон без предупреждений; отчёт гибридного файла hledger несёт пустой список', () => {
  const fixture = new Uint8Array(fs.readFileSync(path.join(HERE, 'fixtures', 'import-152.csv')));
  const w = M.new_wizard();
  M.wiz_csv_load(w, WS.g001, { name: 'выписка.csv', bytes: fixture });
  const r = M.wiz_csv_run(w, WS.g001);
  assert.ok(r.ok);
  assert.deepEqual(r.plan.report.warnings, []);
  assert.equal(r.plan.report.recognized, 150);
  assert.deepEqual(r.plan.parse, { via: 'main', reason: null });
  const hl = M.plan_hledger(WS.g001, { text: '2026-09-01 Зарплата\n    assets:bank    1000,00 EUR\n    income:salary\n' });
  assert.ok(hl.ok);
  assert.deepEqual(hl.plan.report.warnings, []);
});

// ── состояние мастера: фоновый прогон ─────────────────────────────────────────────────────────────────────────

/** Заглушка клиента воркера: возвращает то, что вернул бы `parse_with_profile`, но отвечает по команде теста. */
function stub_parser() {
  const calls = [];
  const gates = [];
  return {
    calls,
    release: (i = 0) => gates[i](),
    parse_csv(profile, text, ctx) {
      calls.push({ profile, ctx, size: text.length });
      return new Promise((resolve) => { gates.push(() => resolve({ result: parse_with_profile(profile, text, ctx), via: 'worker', reason: null })); });
    },
  };
}

test('REQ-091 FP-18 wiz_csv_run_async: пока идёт разбор, csv.checking = true; результат тот же, что у wiz_csv_run; рабочая область не меняется', async () => {
  const ws = WS.g001;
  const target = { ...ws, facts: [] };
  const exp = export_csv_file(ws);
  const sync = through_wizard(ws, target);
  const w = M.new_wizard();
  M.wiz_csv_load(w, target, { name: 'a.csv', bytes: enc(exp.text) });
  const p = stub_parser();
  const h0 = M.ws_state_hash(target);
  const run = M.wiz_csv_run_async(w, target, p, { });
  assert.equal(w.csv.checking, true);
  assert.equal(w.csv.plan, null);
  assert.equal(p.calls.length, 0, 'файл меньше порога WORKER_MIN_BYTES: воркер не нужен');
  const r = await run;
  assert.equal(w.csv.checking, false);
  assert.ok(r.ok);
  assert.equal(JSON.stringify(w.csv.plan.report), JSON.stringify(sync.report), 'отчёт тот же');
  assert.deepEqual(w.csv.plan.candidates, sync.plan.candidates);
  assert.deepEqual(w.csv.plan.parse, { via: 'main', reason: null });
  assert.equal(M.ws_state_hash(target), h0);
  assert.equal(w.csv.step, 'report');
});

test('REQ-091 FP-18 plan_csv_async: от порога размера разбор уходит в клиент воркера, ответ тот же; параметры воркеру — профиль, текст и контекст без рабочей области', async () => {
  const ws = WS.g001;
  const target = { ...ws, facts: [] };
  const text = export_csv_file(ws).text;
  const bytes = enc(text);
  const p = stub_parser();
  const input = { text, bytes, name: 'a.csv', profile: M.BUILTIN_PROFILES['runway-csv-1'], account_id: 'acc_main', worker_min_bytes: 0 };
  const run = M.plan_csv_async(target, input, p);
  p.release(0);
  const r = await run;
  assert.ok(r.ok);
  assert.deepEqual(r.plan.parse, { via: 'worker', reason: null });
  assert.equal(p.calls.length, 1);
  assert.deepEqual(p.calls[0].ctx, { account_id: 'acc_main', account_currency: 'EUR', as_of: '2026-10-04' });
  assert.equal(p.calls[0].size, text.length);
  const sync = M.plan_csv(target, input);
  const strip = (x) => JSON.stringify({ ...x.plan, base_ws: null, parse: null, dry: x.plan.dry, source: { ...x.plan.source, bytes: null } });
  assert.equal(strip(r), strip(sync), 'план тот же, отличается только поле parse');
  // порог по умолчанию
  assert.equal(M.WORKER_MIN_BYTES, 128 * 1024);
  const small = M.plan_csv_async(target, { ...input, worker_min_bytes: undefined }, p);
  assert.ok((await small).ok);
  assert.equal(p.calls.length, 1, 'малый файл разобран на месте');
  // отказы до разбора те же, что у синхронного
  assert.equal((await M.plan_csv_async(target, { ...input, account_id: 'нет' }, p)).error.ctx.reason, 'unknown_account');
  assert.equal((await M.plan_csv_async({ ...target, as_of: undefined }, input, p)).error.ctx.reason, 'no_workspace');
  assert.equal((await M.plan_csv_async(target, { ...input, bytes: new Uint8Array(M.MAX_IMPORT_BYTES + 1) }, p)).error.ctx.reason, 'file_too_large');
  assert.equal(p.calls.length, 1, 'до разбора воркер не вызывается');
});

/** Байты «большого» файла: выгрузка Runway плюс пустые строки до порога WORKER_MIN_BYTES (пустые строки разбор отбрасывает, результат тот же). */
const big_bytes_of = (ws) => enc(export_csv_file(ws).text + '\n'.repeat(M.WORKER_MIN_BYTES));

test('REQ-091 FP-18 фоновый прогон устаревает при любом изменении входных данных: «Назад», новый файл, смена настроек, сброс — результат отбрасывается, состояние не портится', async () => {
  const ws = WS.g001;
  const target = { ...ws, facts: [] };
  const big_bytes = big_bytes_of(ws);
  assert.ok(big_bytes.length >= M.WORKER_MIN_BYTES);
  for (const [label, act] of [
    ['Назад', (w) => M.wiz_csv_back(w)],
    ['смена настроек', (w) => M.wiz_csv_set(w, target, { amount_unit: 'major' })],
    ['новый файл', (w) => M.wiz_csv_load(w, target, { name: 'b.csv', bytes: big_bytes })],
    ['сброс вкладки', (w) => M.wiz_reset(w, 'csv')],
  ]) {
    const w = M.new_wizard();
    M.wiz_csv_load(w, target, { name: 'big.csv', bytes: big_bytes });
    const p = stub_parser();
    const run = M.wiz_csv_run_async(w, target, p);
    assert.equal(w.csv.checking, true, label);
    assert.equal(p.calls.length, 1, label + ': большой файл ушёл в клиент воркера');
    act(w);
    assert.equal(w.csv.checking, false, label + ': пометка «идёт разбор» снята сразу');
    p.release(0);
    const r = await run;
    assert.equal(r.cancelled, true, label);
    assert.equal(w.csv.plan, null, label + ': отчёт устаревшего прогона не появился');
    assert.equal(w.csv.checking, false, label);
    if (label === 'Назад') assert.equal(w.csv.step, 'columns');
  }
  // без изменений прогон завершается нормально и принимает сохранённые решения
  const w = M.new_wizard();
  M.wiz_csv_load(w, target, { name: 'big.csv', bytes: big_bytes });
  const p = stub_parser();
  const run = M.wiz_csv_run_async(w, target, p, { keep_decisions: { 5: 'accept' } });
  p.release(0);
  const r = await run;
  assert.ok(r.ok);
  assert.deepEqual(w.csv.decisions, { 5: 'accept' });
  assert.deepEqual(w.csv.plan.parse, { via: 'worker', reason: null });
  assert.equal(w.csv.checking, false);
  assert.equal(w.csv.step, 'report');
});

test('REQ-091 FP-18 wiz_refresh_async: пересчитывает только устаревший отчёт, решения о двойниках сохраняются; свежий отчёт и повторный вызов во время пересчёта — null', async () => {
  const ws = WS.g001;
  const target = { ...ws, facts: [] };
  const big_bytes = enc(export_csv_file(ws).text + '\n'.repeat(M.WORKER_MIN_BYTES));
  const w = M.new_wizard();
  M.wiz_csv_load(w, target, { name: 'big.csv', bytes: big_bytes });
  const p = stub_parser();
  assert.equal(M.wiz_refresh_async(w, target, p), null, 'плана ещё нет');
  const first = M.wiz_csv_run_async(w, target, p);
  p.release(0);
  await first;
  assert.equal(M.wiz_refresh_async(w, target, p), null, 'отчёт свежий');
  M.wiz_decide(w, 'csv', 3, 'accept');
  const changed = { ...target, facts: [{ event_id: 'tx_new', account_id: 'acc_main', date: '2026-10-01', amount_minor: -100, currency: 'EUR', kind: 'expense' }] };
  const again = M.wiz_refresh_async(w, changed, p);
  assert.ok(again instanceof Promise);
  assert.equal(M.wiz_refresh_async(w, changed, p), null, 'пересчёт уже идёт');
  p.release(1);
  await again;
  assert.equal(M.plan_is_current(w.csv.plan, changed), true);
  assert.deepEqual(w.csv.decisions, { 3: 'accept' });
});

test('REQ-091 FP-18 фоновый разбор: ошибка клиента не оставляет мастер в состоянии «Проверяю» — это отказ с кодом, а не зависший экран', async () => {
  const ws = WS.g001;
  const target = { ...ws, facts: [] };
  const big_bytes = enc(export_csv_file(ws).text + '\n'.repeat(M.WORKER_MIN_BYTES));
  const w = M.new_wizard();
  M.wiz_csv_load(w, target, { name: 'big.csv', bytes: big_bytes });
  const boom = { parse_csv: async () => { const e = new Error('сбой'); e.code = 'E_SCHEMA'; e.ctx = { reason: 'bad_profile' }; throw e; } };
  const r = await M.wiz_csv_run_async(w, target, boom);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_SCHEMA');
  assert.equal(r.error.ctx.reason, 'bad_profile');
  assert.equal(w.csv.checking, false);
  assert.equal(w.csv.plan, null);
  assert.equal(w.csv.error.ctx.reason, 'bad_profile');
  // непредвиденное исключение: тоже отказ, экран не зависает
  const w2 = M.new_wizard();
  M.wiz_csv_load(w2, target, { name: 'big.csv', bytes: big_bytes });
  const r2 = await M.wiz_csv_run_async(w2, target, { parse_csv: async () => { throw new TypeError('внезапно'); } });
  assert.equal(r2.ok, false);
  assert.equal(w2.csv.checking, false);
  assert.ok(!JSON.stringify(r2).includes('внезапно'), 'текст исключения наружу не уходит');
});
