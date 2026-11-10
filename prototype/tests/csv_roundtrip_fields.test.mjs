// csv_roundtrip_fields.test.mjs — FP-47, часть 2 (REQ-095, TST-33): круг «экспорт Runway → мастер импорта» восстанавливает МЕТКУ (tag) и КОНТРАГЕНТА (counterparty);
// ячейки с ведущим апострофом (защита от формул в таблицах) возвращаются без апострофа. Номер счёта (account_id) и вид (kind) файла по-прежнему НЕ читаются
// (решение владельца) — экран называет это словами. Профиль runway-csv-1 расширен только аддитивно: новые колонки необязательны (`optional`), поэтому файл
// из пяти базовых колонок читается как раньше, а ключ дедупликации от метки и контрагента не зависит (повторный импорт — 0 новых).
// Чистая модель без DOM (engine/io.mjs, demo/import_model.mjs). Расчёт по введённым данным и правилам, не консультация.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/csv_roundtrip_fields.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as M from '../demo/import_model.mjs';
import { export_csv_file } from '../demo/data_actions.mjs';
import { make_id_gen, seeded_ports } from '../demo/ids.mjs';
import { RUNWAY_CSV_PROFILE, validate_profile, parse_with_profile, parse_csv, csv_safe_cell } from '../engine/io.mjs';
import { validate_ws } from '../engine/validate_ws.mjs';
import { state_hash } from '../engine/index.mjs';
import catalog from '../demo/i18n/import.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const enc = (s) => new TextEncoder().encode(s);
const read_json = (p) => JSON.parse(fs.readFileSync(path.join(PROTO, p), 'utf8'));
const clone = (x) => structuredClone(x);

function deep_freeze(x) {
  if (x === null || typeof x !== 'object' || Object.isFrozen(x)) return x;
  for (const k of Object.keys(x)) deep_freeze(x[k]);
  return Object.freeze(x);
}

const SETS = ['g001', 'g001-low', 'g001-gap', 'g001-late'];
const WS = Object.fromEntries(SETS.map((n) => [n, deep_freeze(read_json(`data/${n}.json`))]));
const GEN = make_id_gen(seeded_ports({ seed: 47, start_ms: 1790000000000, step_ms: 1 }));
const env = () => ({ new_id: (p) => GEN.entity(p) });
const CTX = { account_id: 'acc_main', account_currency: 'EUR', as_of: '2026-10-04' };

/** Исходная область со всеми видами текстовых полей: контрагенты (в том числе с «формульными» именами), метки и описания с ведущими «=», «+», «-», «@» и апострофами. */
function source_ws() {
  const ws = clone(WS.g001);
  ws.counterparties = [
    { counterparty_id: 'cp_owner', name: 'Хозяин квартиры' },
    { counterparty_id: 'cp_formula', name: '=HYPERLINK("http://x")' },
    { counterparty_id: 'cp_plus', name: '+7 shop' },
    { counterparty_id: 'cp_quote', name: "'quoted" },
    { counterparty_id: 'cp_comma', name: 'Иванов, ИП "Весна"' },
  ];
  const set = (i, patch) => { ws.facts[i] = { ...ws.facts[i], ...patch }; };
  set(0, { counterparty_id: 'cp_owner', tag: '=SUM(A1)', note: '@note' });
  set(1, { counterparty_id: 'cp_formula', tag: '+метка', note: '-минус' });
  set(2, { counterparty_id: 'cp_plus', tag: '-метка', note: 'обычное описание' });
  set(3, { counterparty_id: 'cp_quote', tag: "'просто апостроф", note: "'=уже с апострофом" });
  set(4, { counterparty_id: 'cp_comma', tag: 'с, запятой', note: 'с "кавычками"' });
  set(5, { counterparty_id: 'cp_owner' }); // тот же контрагент у второго факта: сущность одна
  return deep_freeze(ws);
}
const SRC = source_ws();

const name_of = (ws, id) => (id === undefined ? null : (ws.counterparties ?? []).find((c) => c.counterparty_id === id)?.name ?? '?' + id);

/** Строки, которые круг обязан сохранить: дата, сумма, описание, метка и ИМЯ контрагента (идентификаторы после импорта другие). */
function field_rows(ws) {
  return ws.facts.map((f) => ({ date: f.date, amount_minor: f.amount_minor, note: f.note ?? null, tag: f.tag ?? null, counterparty: name_of(ws, f.counterparty_id) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.amount_minor - b.amount_minor) || (String(a.note) < String(b.note) ? -1 : String(a.note) > String(b.note) ? 1 : 0)));
}

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

// ── профиль: три копии совпадают, схема принимает ───────────────────────────────────────────────────────────────

test('REQ-095 FP-47 профиль runway-csv-1 читает tag и counterparty из необязательных колонок: файл, BUILTIN_PROFILES и RUNWAY_CSV_PROFILE равны; схема принимает; account_id и kind в профиле нет', () => {
  const file = read_json('data/profiles/runway-csv-1.json');
  assert.deepEqual(file, M.BUILTIN_PROFILES['runway-csv-1']);
  assert.deepEqual(file, JSON.parse(JSON.stringify(RUNWAY_CSV_PROFILE)));
  assert.deepEqual(validate_profile(file), { ok: true, errors: [] });
  assert.deepEqual(file.tag, { col: 'tag', csv_safe: true, optional: true });
  assert.deepEqual(file.counterparty, { col: 'counterparty', csv_safe: true, optional: true });
  assert.equal(JSON.stringify(file).includes('account_id'), false, 'номер счёта файла не читается (решение владельца)');
  assert.equal(JSON.stringify(file).includes('"kind"'), false, 'вид файла не читается (решение владельца)');
  assert.equal(Object.isFrozen(RUNWAY_CSV_PROFILE.tag), true);
  // колонки есть в выгрузке
  const header = parse_csv(export_csv_file(SRC).text)[0];
  assert.ok(header.includes('tag') && header.includes('counterparty'));
});

test('REQ-095 FP-47 схема профиля: tag и counterparty — объекты с col, csv_safe и optional; лишние поля, не объекты и пустые колонки отвергаются', () => {
  const ok = (extra) => validate_profile({ ...read_json('data/profiles/runway-csv-1.json'), ...extra });
  assert.equal(ok({}).ok, true);
  assert.equal(ok({ tag: { col: 2 } }).ok, true, 'колонка может быть номером');
  for (const [extra, field, reason] of [
    [{ tag: 'tag' }, 'tag', 'not_object'],
    [{ tag: null }, 'tag', 'not_object'],
    [{ tag: [] }, 'tag', 'not_object'],
    [{ tag: { col: '' } }, 'tag.col', 'bad_column'],
    [{ counterparty: { col: 'c', csv_safe: 'yes' } }, 'counterparty.csv_safe', 'not_boolean'],
    [{ counterparty: { col: 'c', optional: 1 } }, 'counterparty.optional', 'not_boolean'],
    [{ tag: { col: 'tag', run: 'x' } }, 'tag.run', 'unknown_field'],
    [{ account: { col: 'account_id' } }, 'account', 'unknown_field'],
  ]) {
    const r = ok(extra);
    assert.equal(r.ok, false, JSON.stringify(extra));
    assert.ok(r.errors.some((e) => e.field === field && e.reason === reason), JSON.stringify([extra, r.errors]));
  }
});

// ── разбор профилем движка ─────────────────────────────────────────────────────────────────────────────────────────

test('REQ-095 FP-47 разбор: метка и контрагент из своих колонок; ведущий апостроф перед «=», «+», «-», «@», TAB и CR снимается один раз, обычный апостроф остаётся', () => {
  const lines = [
    'date,account_id,amount_minor,currency,kind,layer,tag,counterparty,note,event_id,dedup_key',
    `2026-10-01,a,-100,EUR,expense,posted,'=SUM(A1),"'=HYPERLINK(""http://x"")","'@n",e1,`,
    `2026-10-01,a,-101,EUR,expense,posted,'+t,'+7 shop,'-m,e2,`,
    `2026-10-01,a,-102,EUR,expense,posted,'-t,'@c,'+n,e3,`,
    `2026-10-01,a,-103,EUR,expense,posted,'plain,'quoted,'plain,e4,`,
    `2026-10-01,a,-104,EUR,expense,posted,''=x,''=y,''=z,e5,`,
    `2026-10-01,a,-105,EUR,expense,posted,,,только описание,e6,`,
    `2026-10-01,a,-106,EUR,expense,planned,метка плана,контрагент плана,plan,e7,`,
  ];
  const r = parse_with_profile(RUNWAY_CSV_PROFILE, lines.join('\n') + '\n', CTX);
  assert.equal(r.candidates.length, 6, 'строка плана отфильтрована');
  assert.deepEqual(r.rejects, [{ row: 8, reason: 'filtered_out' }]);
  const by = (i) => r.candidates[i];
  assert.deepEqual([by(0).tag, by(0).counterparty, by(0).desc], ['=SUM(A1)', '=HYPERLINK("http://x")', '@n'], 'критерий приёмки: формула возвращается без апострофа');
  assert.deepEqual([by(1).tag, by(1).counterparty, by(1).desc], ['+t', '+7 shop', '-m']);
  assert.deepEqual([by(2).tag, by(2).counterparty, by(2).desc], ['-t', '@c', '+n']);
  assert.deepEqual([by(3).tag, by(3).counterparty, by(3).desc], ["'plain", "'quoted", "'plain"], 'апостроф не перед формульным знаком — часть текста');
  assert.deepEqual([by(4).tag, by(4).counterparty, by(4).desc], ["'=x", "'=y", "'=z"], 'снимается один апостроф из цепочки');
  assert.equal(by(5).tag, null);
  assert.equal(Object.hasOwn(by(5), 'counterparty'), false, 'пустая ячейка контрагента — поля нет');
  assert.equal(by(5).desc, 'только описание');
});

test('REQ-095 FP-47 экспорт ↔ разбор: защита от формул при экспорте и снятие апострофа взаимно обратны для тегов и имён с формульными знаками, кавычками, запятыми и переводами строк', () => {
  const samples = ['=1+1', '+7', '-x', '@a', "'=x", "''=x", "'a", 'a', 'а, б', 'с "кавычкой"', '\tтаб', 'строка\nвторая'];
  for (const raw of samples) {
    const ws = clone(WS.g001);
    ws.counterparties = [{ counterparty_id: 'cp_x', name: raw }];
    ws.facts = [{ ...ws.facts[0], tag: raw, note: raw, counterparty_id: 'cp_x' }];
    const text = export_csv_file(ws).text;
    const r = parse_with_profile(RUNWAY_CSV_PROFILE, text, CTX);
    assert.equal(r.candidates.length, 1, JSON.stringify(raw));
    const norm = (s) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    assert.equal(r.candidates[0].tag, norm(raw), 'метка: ' + JSON.stringify(raw));
    assert.equal(r.candidates[0].counterparty, norm(raw), 'контрагент: ' + JSON.stringify(raw));
    assert.equal(r.candidates[0].desc, norm(raw), 'описание: ' + JSON.stringify(raw));
  }
  assert.equal(csv_safe_cell('=1+1'), "'=1+1");
});

test('REQ-095 FP-47 аддитивность: файл из пяти базовых колонок читается как раньше (колонок tag и counterparty нет — это не ошибка), ключ дедупликации не зависит от метки и контрагента', () => {
  const core = 'date,amount_minor,currency,note,layer\n2026-10-01,-100,EUR,кофе,posted\n2026-10-02,-200,EUR,обед,posted\n';
  const r = parse_with_profile(RUNWAY_CSV_PROFILE, core, CTX);
  assert.equal(r.candidates.length, 2);
  assert.equal(r.rejects.length, 0);
  assert.ok(r.candidates.every((c) => c.tag === null && !Object.hasOwn(c, 'counterparty')), 'без колонок — поля пусты');
  // строка короче заголовка в необязательной колонке не отвергается как short_row
  const short = 'date,account_id,amount_minor,currency,kind,layer,tag,counterparty,note\n2026-10-01,a,-100,EUR,expense,posted,метка\n';
  const s = parse_with_profile(RUNWAY_CSV_PROFILE, short, CTX);
  assert.equal(s.rejects.length, 1, 'короткая строка: note обязательна');
  assert.equal(s.rejects[0].reason, 'short_row');
  // тот же факт с меткой и без неё — один и тот же dedup_key
  const a = parse_with_profile(RUNWAY_CSV_PROFILE, 'date,amount_minor,currency,note,layer,tag,counterparty\n2026-10-01,-100,EUR,кофе,posted,метка,Кафе\n', CTX).candidates[0];
  const b = parse_with_profile(RUNWAY_CSV_PROFILE, core, CTX).candidates[0];
  assert.equal(a.dedup_key, b.dedup_key, 'метка и контрагент в ключ дедупликации не входят');
  assert.equal(a.tag, 'метка');
  assert.equal(a.counterparty, 'Кафе');
});

test('REQ-095 FP-47 необязательность: у профиля без optional отсутствующая колонка метки — отказ unknown_column; метка из колонки главнее правил по описанию, пустая ячейка отдаёт правилу', () => {
  const csv = 'date,amount_minor,currency,note,layer,tag\n2026-10-01,-100,EUR,кофе в кафе,posted,\n2026-10-02,-200,EUR,такси,posted,свой\n';
  const strict = { ...JSON.parse(JSON.stringify(RUNWAY_CSV_PROFILE)), tag: { col: 'meta' } };
  assert.throws(() => parse_with_profile(strict, csv, CTX), (e) => e.code === 'E_SCHEMA' && e.ctx.reason === 'unknown_column' && e.ctx.where === 'tag');
  const with_rules = { ...JSON.parse(JSON.stringify(RUNWAY_CSV_PROFILE)), rules: [{ match: 'кафе', tag: 'еда' }, { match: 'такси', tag: 'транспорт' }] };
  const r = parse_with_profile(with_rules, csv, CTX);
  assert.deepEqual(r.candidates.map((c) => c.tag), ['еда', 'свой'], 'пустая ячейка — правило; непустая — ячейка');
  const no_col = parse_with_profile(with_rules, 'date,amount_minor,currency,note,layer\n2026-10-01,-100,EUR,кофе в кафе,posted\n', CTX);
  assert.deepEqual(no_col.candidates.map((c) => c.tag), ['еда'], 'нет колонки — как раньше, только правила');
});

// ── круг через мастер ───────────────────────────────────────────────────────────────────────────────────────────────

test('REQ-095 FP-47 круг «экспорт → мастер → импорт»: метка, контрагент и описание всех фактов вернулись (в том числе с формульными знаками); контрагента нет в данных — партия заводит одного на имя', () => {
  assert.equal(validate_ws(SRC).ok, true, JSON.stringify(validate_ws(SRC).errors));
  const target = deep_freeze({ ...clone(SRC), facts: [], counterparties: [] });
  const h_target = M.ws_state_hash(target);
  const { w, exp, report } = through_wizard(SRC, target);
  assert.ok(exp.text.includes(`'=SUM(A1)`), 'в файле метка защищена апострофом');
  assert.ok(exp.text.includes(`"'=HYPERLINK(""http://x"")"`), 'и имя контрагента тоже');
  assert.equal(report.recognized, SRC.facts.length);
  assert.equal(report.duplicates, 0);
  assert.equal(M.ws_state_hash(target), h_target, 'сухой прогон данные не меняет');
  const c = M.wiz_commit(w, 'csv', target, env());
  assert.ok(c.ok, JSON.stringify(c.error));
  assert.deepEqual(field_rows(c.ws), field_rows(SRC), 'метка, контрагент и описание каждого факта вернулись');
  // контрагентов — по числу различных имён в файле (5 имён, у шестого факта то же имя, что у первого)
  const used = [...new Set(SRC.facts.filter((f) => f.counterparty_id !== undefined).map((f) => name_of(SRC, f.counterparty_id)))];
  assert.equal(c.ws.counterparties.length, used.length);
  assert.deepEqual(c.ws.counterparties.map((x) => x.name).sort(), [...used].sort());
  assert.ok(c.ws.counterparties.every((x) => /^cp_[0-9a-f]{12}$/.test(x.counterparty_id) && x.batch_id === c.batch.batch_id));
  assert.deepEqual([...c.batch.counterparties].sort(), c.ws.counterparties.map((x) => x.counterparty_id).sort());
  const owner = c.ws.facts.filter((f) => name_of(c.ws, f.counterparty_id) === 'Хозяин квартиры');
  assert.equal(owner.length, 2);
  assert.equal(owner[0].counterparty_id, owner[1].counterparty_id, 'одно имя — одна сущность');
  assert.equal(validate_ws(c.ws).ok, true, JSON.stringify(validate_ws(c.ws).errors));
  // account_id и kind файла не читаются: счёт — выбранный, вид — по знаку суммы
  assert.deepEqual([...new Set(c.ws.facts.map((f) => f.account_id))], ['acc_main']);
  assert.ok(c.ws.facts.every((f) => f.kind === (f.amount_minor > 0 ? 'income' : 'expense')));
  // откат партии убирает факты и заведённых ею контрагентов: состояние как до импорта
  M.wiz_committed(w, 'csv', c.batch);
  const rb = M.wiz_rollback(w, c.ws, c.batch.batch_id);
  assert.ok(rb.ok, JSON.stringify(rb.error));
  assert.equal(rb.removed.facts, SRC.facts.length);
  assert.equal(rb.removed.counterparties, used.length);
  assert.equal(M.ws_state_hash(rb.ws), h_target, 'откат вернул прежний state_hash');
  // откат по одному batch_id (после перезагрузки страницы список партии в памяти пуст) убирает тех же контрагентов
  const rb2 = M.rollback_batch(c.ws, c.batch.batch_id);
  assert.ok(rb2.ok);
  assert.equal(rb2.ws.counterparties.length, 0);
  assert.equal(M.ws_state_hash(rb2.ws), h_target);
});

test('REQ-095 FP-47 контрагент с таким именем уже есть в данных — берётся его counterparty_id, новый не заводится; повторный импорт того же файла — 0 новых', () => {
  const target = deep_freeze({ ...clone(SRC), facts: [] }); // справочник контрагентов цел, фактов нет
  const { w, report } = through_wizard(SRC, target);
  assert.equal(report.recognized, SRC.facts.length);
  const c = M.wiz_commit(w, 'csv', target, env());
  assert.ok(c.ok, JSON.stringify(c.error));
  assert.deepEqual(field_rows(c.ws), field_rows(SRC));
  assert.equal(c.ws.counterparties.length, SRC.counterparties.length, 'новых контрагентов нет');
  assert.equal(c.batch.counterparties, undefined, 'партия никого не завела');
  assert.deepEqual(c.ws.facts.map((f) => f.counterparty_id).filter((x) => x !== undefined).sort(), SRC.facts.map((f) => f.counterparty_id).filter((x) => x !== undefined).sort(), 'ссылки на прежние идентификаторы');
  // повторный импорт: всё дубликаты
  const again = through_wizard(SRC, c.ws);
  assert.equal(again.report.recognized, 0);
  assert.equal(again.report.duplicates, SRC.facts.length);
  // откат не трогает чужих контрагентов
  M.wiz_committed(w, 'csv', c.batch);
  const rb = M.wiz_rollback(w, c.ws, c.batch.batch_id);
  assert.ok(rb.ok);
  assert.equal(rb.ws.counterparties.length, SRC.counterparties.length);
  assert.equal(rb.removed.counterparties, undefined);
});

test('REQ-095 FP-47 контрагент, на которого после импорта сослалась другая запись, откат партии оставляет; имена из файла — недоверенный текст (длина, управляющие знаки, «__proto__»)', () => {
  const base = deep_freeze({ ...clone(WS.g001), facts: [], counterparties: [] });
  const src = clone(WS.g001);
  src.counterparties = [{ counterparty_id: 'cp_p', name: '__proto__' }, { counterparty_id: 'cp_l', name: 'Д'.repeat(300) }];
  src.facts = [{ ...src.facts[0], counterparty_id: 'cp_p' }, { ...src.facts[1], counterparty_id: 'cp_l' }];
  const { w } = through_wizard(src, base);
  const c = M.wiz_commit(w, 'csv', base, env());
  assert.ok(c.ok, JSON.stringify(c.error));
  const names = c.ws.counterparties.map((x) => x.name);
  assert.ok(names.includes('__proto__'));
  assert.ok(names.includes('Д'.repeat(120)), 'имя режется до 120 знаков, как в форме контрагента');
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.getPrototypeOf(c.ws.counterparties[0]), Object.prototype);
  // пользователь привязал заведённого партией контрагента к своему правилу — откат его не удаляет
  const keep = c.ws.counterparties[0].counterparty_id;
  const linked = { ...c.ws, plans: [...(c.ws.plans ?? []), { plan_id: 'plan_keep', account_id: 'acc_main', date: '2026-11-01', amount_minor: -100, currency: 'EUR', counterparty_id: keep }] };
  const rb = M.rollback_batch(linked, c.batch.batch_id, { counterparties: c.batch.counterparties });
  assert.ok(rb.ok);
  assert.deepEqual(rb.ws.counterparties.map((x) => x.counterparty_id), [keep], 'на него ссылается план: остаётся');
  assert.equal(rb.removed.counterparties, 1);
});

for (const name of SETS) {
  test(`REQ-095 FP-47 круг на наборе ${name}: метки всех фактов вернулись, суммы и состав те же, повторный импорт — 0 новых`, () => {
    const ws = WS[name];
    const target = { ...ws, facts: [] };
    const { w, report } = through_wizard(ws, target);
    assert.equal(report.recognized, ws.facts.length);
    const c = M.wiz_commit(w, 'csv', target, env());
    assert.ok(c.ok, JSON.stringify(c.error));
    assert.deepEqual(field_rows(c.ws), field_rows(ws));
    assert.ok(c.ws.facts.some((f) => typeof f.tag === 'string'), 'метки есть');
    assert.equal(c.batch.counterparties, undefined, 'в наборе контрагентов нет');
    assert.equal(state_hash({ f: c.ws.facts.map((f) => [f.date, f.amount_minor]).sort() }), state_hash({ f: ws.facts.map((f) => [f.date, f.amount_minor]).sort() }));
    assert.equal(through_wizard(ws, c.ws).report.recognized, 0);
  });
}

// ── экран называет границы круга ───────────────────────────────────────────────────────────────────────────────────

test('REQ-095 FP-47 подсказка мастера на RU и EN: метки и контрагенты возвращаются; номер счёта (account_id) и вид (kind) файла не читаются; для полной копии — JSON', () => {
  for (const [lang, rx] of [['ru', /возвращаются из своих колонок/], ['en', /are read back from their columns/]]) {
    const t = catalog[lang]['import.runway_hint'];
    assert.match(t, rx, lang);
    assert.ok(t.includes('account_id') && t.includes('kind'), lang + ': названы account_id и kind');
    assert.match(t, lang === 'ru' ? /не читаются/ : /are not read/, lang);
    assert.match(t, /JSON/);
  }
  assert.doesNotMatch(catalog.ru['import.runway_hint'], /Метки, контрагенты и переводы CSV не переносит/, 'прежнее утверждение снято: оно стало неверным');
  const holders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  assert.equal(holders(catalog.ru['import.runway_hint']), holders(catalog.en['import.runway_hint']));
});

test('REQ-095 FP-47 безопасность: модуль разбора и модель не используют innerHTML, eval, new Function и внешние адреса; имена из файла в контекст ошибок не попадают', () => {
  for (const f of ['engine/io.mjs', 'demo/import_model.mjs']) {
    const code = fs.readFileSync(path.join(PROTO, f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.ok(!/\.innerHTML|outerHTML|\beval\(|new Function|https?:\/\//.test(code), f);
  }
  const bad = 'date,amount_minor,currency,note,layer,tag\n2026-10-01,-100,EUR,x,posted,СЕКРЕТНАЯ МЕТКА\n';
  const strict = { ...JSON.parse(JSON.stringify(RUNWAY_CSV_PROFILE)), counterparty: { col: 'нет_такой_СЕКРЕТ' } };
  try { parse_with_profile(strict, bad, CTX); assert.fail('ожидался отказ'); } catch (e) {
    assert.equal(e.code, 'E_SCHEMA');
    assert.ok(!JSON.stringify(e.ctx).includes('СЕКРЕТНАЯ МЕТКА'), 'значения ячеек в контекст ошибки не попадают');
  }
});

// ── разбор в Worker даёт то же, что на месте ─────────────────────────────────────────────────────────────────────────

test('REQ-095 FP-47 Worker: контракт import_worker (handle_message → split_reply → join_parts) возвращает кандидатов с меткой и контрагентом побайтно так же, как синхронный разбор', async () => {
  const W = await import('../demo/import_worker.mjs');
  const text = export_csv_file(SRC).text;
  const sync = parse_with_profile(RUNWAY_CSV_PROFILE, text, CTX);
  assert.ok(sync.candidates.some((c) => c.counterparty !== undefined && c.tag !== null), 'в файле есть и метки, и контрагенты');
  const reply = W.handle_message({ v: 1, id: 1, op: 'parse_csv', profile: JSON.parse(JSON.stringify(RUNWAY_CSV_PROFILE)), text, ctx: CTX });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(JSON.stringify(reply.result), JSON.stringify(sync), 'ответ воркера равен синхронному разбору');
  const parts = W.split_reply(reply, 5); // мелкие части: контрагент переживает разбиение на сообщения
  assert.ok(parts.length > 1);
  const joined = W.join_parts(parts.slice(0, -1), parts.at(-1));
  assert.equal(JSON.stringify(joined.result ?? joined), JSON.stringify(sync), 'склейка частей равна исходному результату');
});
