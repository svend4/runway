// calendar_edit.test.mjs — FP-13 (волна 3а): календарь выходных и праздников как данные пользователя, n-й рабочий день в форме правила, разовый платёж. Без DOM и сети.
// REQ-009 (календарь, политика переноса, by_workday), REQ-010 (разовый платёж, «Отменить»), REQ-017 (коды E_* без повтора введённого), REQ-090 («Отменить»), TST-12, TST-13, TST-56.
// Что проверяется: виды правок upsert_calendar / delete_calendar / upsert_plan / delete_plan (проверка движком, отказы, идемпотентность), запись журнала calendar.set и plan.set
// без изменения проведённых фактов, круг «создать — открыть — сохранить» правила с by_workday, разбор формы календаря, предпросмотр, «Отменить» побайтно, строки RU и EN.
// Запуск: node --test --test-timeout=240000 --test-concurrency=1 tests/calendar_edit.test.mjs. Расчёт по введённым данным и правилам, не консультация.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.join(HERE, '..');
const imp = (rel) => import(pathToFileURL(path.join(PROTO, rel)).href);
const G = JSON.parse(fs.readFileSync(path.join(PROTO, 'data', 'g001.json'), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));

const E = await imp('engine/index.mjs');
const WE = await imp('demo/ws_edit.mjs');
const BR = await imp('demo/ws_bridge.mjs');
const JL = await imp('demo/journal_log.mjs');
const IDS = await imp('demo/ids.mjs');
const UNDO = await imp('demo/undo.mjs');
const I18N = await imp('demo/i18n.mjs');
const CAL = await imp('demo/form_calendar.mjs');
const PLAN = await imp('demo/form_plan.mjs');
const RULE = await imp('demo/form_rule.mjs');
const FORMS = await imp('demo/forms.mjs');
const PACK = await imp('demo/pack_fp13.mjs');
const CATALOG = (await imp('demo/i18n/calendars.mjs')).default;
const ENTRY = (await imp('demo/i18n/entry.mjs')).default;
const FORMS_CAT = (await imp('demo/i18n/forms.mjs')).default;

// виды правок пакета — один раз на процесс (как это делает register); пакет FP-08 регистрирует set_occurrence_override
for (const [type, fn] of Object.entries(PACK.EDITS)) if (!WE.list_edit_types().includes(type)) WE.register_edit(type, fn);
if (!WE.list_edit_types().includes('set_occurrence_override')) WE.register_edit('set_occurrence_override', RULE.edit_set_occurrence_override);
// каталоги пространств имён принимаются один раз на процесс (в приложении их регистрируют пакеты)
I18N.register_strings('calendars', CATALOG);
I18N.register_strings('forms', FORMS_CAT);
I18N.register_strings('entry', ENTRY);

const ENV = { cur: 'EUR', lang: 'ru', nf: undefined, as_of: G.as_of };
const ids = (() => { let n = 0; return (p) => `${p}_t${String(++n).padStart(4, '0')}`; })();
const apply = (ws, edit, env = {}) => WE.apply_edit(ws, edit, { new_id: ids, ...env });
const must = (r) => { assert.equal(r.ok, true, JSON.stringify(r.error)); return r.ws; };
const no_echo = (r, typed) => assert.ok(!JSON.stringify(r).includes(typed), `введённый текст «${typed}» повторён в ошибке: ${JSON.stringify(r)}`);
const sha = (x) => E.sha256(E.canon(x));
const tr = (lang) => (key, params) => I18N.t(lang, key, params);
const hash_of = (ws) => E.analyze(ws, { as_of: ws.as_of }).inputs_hash;

const CAL_MAIN = G.calendars[0];
const upsert_cal = (over = {}) => ({ type: 'upsert_calendar', calendar: { calendar_id: 'cal-hol', name: 'Праздники', weekend_dows: [0, 6], holidays: ['2026-10-26'], ...over } });

function fresh_journal(ws, seed = 1) {
  const gen = IDS.make_id_gen(IDS.seeded_ports({ seed }));
  return JL.create_journal({ events: BR.ws_to_events(ws), ports: JL.ports_from_gen(gen), snapshot_every: 25 });
}
/** Хэш состава проведённых фактов: сами записи рабочей области и полезные нагрузки `tx.posted` журнала. */
const facts_hash = (ws, events) => sha({ facts: ws.facts, journal: events.filter((e) => e.type === 'tx.posted').map((e) => e.payload) });

// ── REQ-009: вид правки upsert_calendar ─────────────────────────────────────────────────────────────────────────────

test('REQ-009 TST-12 upsert_calendar: календарь с выходными и праздниками собирается движком (make_calendar); праздник сдвигает вхождение на следующий рабочий день; список хранится по возрастанию без повторов', () => {
  const ws = must(apply(G, upsert_cal({ holidays: ['2026-10-26', '2026-10-26', '2026-01-01'] })));
  const cal = ws.calendars.find((c) => c.calendar_id === 'cal-hol');
  assert.deepEqual(cal, { calendar_id: 'cal-hol', name: 'Праздники', weekend_dows: [0, 6], holidays: ['2026-01-01', '2026-10-26'] }, 'повтор убран, порядок по возрастанию');
  assert.equal(G.calendars.length, 1, 'исходная рабочая область не тронута');
  // правило R-RENT (25-е, «на рабочий день позже») с этим календарём: 25 октября — воскресенье, 26-е — праздник → вторник 27-е
  const rent = { ...G.rules.find((r) => r.rule_id === 'R-RENT'), calendar_id: 'cal-hol' };
  const ws2 = must(apply(ws, { type: 'upsert_rule', rule: rent }));
  const occ = RULE.occurrences_of(ws2, ws2.rules.find((r) => r.rule_id === 'R-RENT'), ws2.as_of, 2);
  assert.deepEqual(occ.map((x) => [x.nominal, x.date]), [['2026-10-25', '2026-10-27'], ['2026-11-25', '2026-11-25']]);
  // тот же результат даёт прогноз страницы
  const ev = E.analyze(ws2, { as_of: ws2.as_of }).events.plan.find((e) => e.cash_event_id === 'R-RENT@2026-10-25');
  assert.equal(E.format_date(ev.date), '2026-10-27');
  // выходные дни недели тоже данные: убрать воскресенье — 25 октября остаётся на месте
  const ws3 = must(apply(ws2, upsert_cal({ weekend_dows: [6], holidays: [] })));
  assert.equal(RULE.occurrences_of(ws3, ws3.rules.find((r) => r.rule_id === 'R-RENT'), ws3.as_of, 1)[0].date, '2026-10-25');
});

test('REQ-009 пустой календарь допустим: ни выходных, ни праздников — все дни рабочие, сдвига нет; календаря «по стране» в приложении нет', () => {
  const ws = must(apply(G, upsert_cal({ weekend_dows: [], holidays: [] })));
  assert.deepEqual(ws.calendars.at(-1).weekend_dows, []);
  assert.deepEqual(ws.calendars.at(-1).holidays, []);
  const rent = { ...G.rules.find((r) => r.rule_id === 'R-RENT'), calendar_id: 'cal-hol' };
  const ws2 = must(apply(ws, { type: 'upsert_rule', rule: rent }));
  assert.equal(RULE.occurrences_of(ws2, ws2.rules.find((r) => r.rule_id === 'R-RENT'), ws2.as_of, 1)[0].date, '2026-10-25', 'воскресенье — рабочий день, сдвига нет');
  // без holidays в правке — тот же пустой список
  const ws3 = must(apply(G, { type: 'upsert_calendar', calendar: { calendar_id: 'cal-bare', name: 'Пустой', weekend_dows: [0, 6] } }));
  assert.deepEqual(ws3.calendars.at(-1).holidays, []);
  // шаблонов праздников со странами и ставками в коде пакета нет
  const src = ['form_calendar.mjs', 'form_plan.mjs', 'pack_fp13.mjs', 'i18n/calendars.mjs'].map((f) => fs.readFileSync(path.join(PROTO, 'demo', f), 'utf8')).join('\n');
  assert.ok(!/['"](DE|US|GB|FR|ES|RU)['"]/.test(src) && !/Рождеств|Christmas|Neujahr|country_code|locale_holidays/i.test(src), 'нет списков праздников по странам');
});

test('REQ-009 REQ-017 upsert_calendar: отказы с кодом канона, значения не повторяются; семь выходных — E_RULE_INVALID; неизвестные поля и ключи-ловушки отвергаются', () => {
  const bads = [
    [upsert_cal({ weekend_dows: [0, 1, 2, 3, 4, 5, 6] }), 'E_RULE_INVALID', 'cal_no_business_days', null],
    [upsert_cal({ weekend_dows: [7] }), 'E_SCHEMA', 'not_0_6', null],
    [upsert_cal({ weekend_dows: [1.5] }), 'E_NOT_INTEGER', null, null],
    [upsert_cal({ weekend_dows: 'сб' }), 'E_SCHEMA', 'not_array', 'сб'],
    [upsert_cal({ holidays: ['2026-02-30'] }), 'E_BAD_DATE', 'bad_date', '2026-02-30'],
    [upsert_cal({ holidays: ['26.10.2026'] }), 'E_BAD_DATE', 'bad_date', '26.10.2026'],
    [upsert_cal({ holidays: [20261026] }), 'E_BAD_DATE', 'not_iso_string', null],
    [upsert_cal({ holidays: ['1900-01-01'] }), 'E_BAD_DATE', 'cal_holiday_out_of_range', '1900-01-01'],
    [upsert_cal({ holidays: ['2300-05-05'] }), 'E_BAD_DATE', 'cal_holiday_out_of_range', '2300-05-05'],
    [upsert_cal({ holidays: 'вчера' }), 'E_SCHEMA', 'not_array', 'вчера'],
    [upsert_cal({ name: '   ' }), 'E_SCHEMA', 'empty', null],
    [upsert_cal({ name: 'x'.repeat(121) }), 'E_SCHEMA', 'too_long', null],
    [upsert_cal({ name: 'a\u0007b' }), 'E_SCHEMA', 'control_chars', null],
    [upsert_cal({ calendar_id: 'acc_main' }), 'E_SCHEMA', 'id_taken_by_other_kind', null],
    [upsert_cal({ calendar_id: 'R-RENT' }), 'E_SCHEMA', 'id_taken_by_other_kind', null],
    [upsert_cal({ calendar_id: 'auto:cal:1' }), 'E_SCHEMA', 'bad_id', 'auto:cal:1'],
    [upsert_cal({ extra: 1 }), 'E_SCHEMA', 'unknown_field', null],
    [{ type: 'upsert_calendar', calendar: 'не объект' }, 'E_SCHEMA', 'not_object', 'не объект'],
    [{ type: 'upsert_calendar', calendar: { calendar_id: 'c', name: 'x', weekend_dows: [0], holidays: Array.from({ length: CAL.HOLIDAYS_MAX + 1 }, () => '2026-12-25') } }, 'E_SCHEMA', 'cal_too_many_holidays', null],
  ];
  for (const [edit, code, reason, typed] of bads) {
    const r = apply(G, edit);
    assert.equal(r.ok, false, JSON.stringify(edit).slice(0, 120));
    assert.equal(r.error.code, code, JSON.stringify(edit).slice(0, 120));
    if (reason !== null) assert.equal(r.error.ctx.reason, reason);
    if (typed !== null) no_echo(r, typed);
    assert.ok(WE.apply_edit(G, edit, { new_id: ids }).ok === false);
  }
  const proto = apply(G, JSON.parse('{"type":"upsert_calendar","calendar":{"calendar_id":"c","name":"x","weekend_dows":[],"holidays":[],"__proto__":{"x":1}}}'));
  assert.equal(proto.ok, false);
  assert.equal(proto.error.ctx.reason, 'forbidden_key');
  assert.equal(G.calendars.length, 1, 'после отказов данные не тронуты');
});

test('REQ-009 upsert_calendar идемпотентен и правит на месте: тот же календарь — те же данные и inputs_hash; запись с тем же calendar_id заменяется, поля вне формы (из файла) сохраняются', () => {
  const once = must(apply(G, upsert_cal()));
  const twice = must(apply(once, upsert_cal()));
  assert.equal(E.canon(twice.calendars), E.canon(once.calendars));
  assert.equal(hash_of(twice), hash_of(once));
  assert.deepEqual(once.calendars.map((c) => c.calendar_id), ['cal-main', 'cal-hol'], 'новый — в конец');
  const edited = must(apply(once, upsert_cal({ name: 'Праздники 2026', holidays: ['2026-12-25'] })));
  assert.deepEqual(edited.calendars.map((c) => c.calendar_id), ['cal-main', 'cal-hol'], 'порядок не меняется');
  assert.deepEqual(edited.calendars[1].holidays, ['2026-12-25']);
  const with_extra = clone(G);
  with_extra.calendars[0].source_note = 'из файла';
  const kept = must(apply(with_extra, { type: 'upsert_calendar', calendar: { calendar_id: 'cal-main', name: 'Суббота и воскресенье', weekend_dows: [0, 6], holidays: ['2026-10-26'] } }));
  assert.equal(kept.calendars[0].source_note, 'из файла', 'неизвестное форме поле сохранено');
  // идентификатор создаёт приложение, если не задан
  const auto = must(apply(G, { type: 'upsert_calendar', calendar: { name: 'Без id', weekend_dows: [0, 6] } }));
  assert.match(auto.calendars.at(-1).calendar_id, /^cal_t\d+$/);
  assert.equal(apply(G, { type: 'upsert_calendar', calendar: { name: 'Без id', weekend_dows: [0, 6] } }, { new_id: undefined }).ok, false, 'без создателя идентификаторов и без id — отказ');
});

// ── REQ-009: журнал и «Отменить» ─────────────────────────────────────────────────────────────────────────────────────

test('REQ-009 REQ-012 calendar.set не меняет проведённые факты: смена календаря пишет одну запись журнала, tx.posted и их хэш прежние; двойное применение второй записи не даёт; журнал сворачивается в ту же область', () => {
  let ws = G;
  const j = fresh_journal(ws);
  const h0 = facts_hash(ws, j.events());
  const n0 = j.length;
  const step = (edit) => { const r = apply(ws, edit); assert.equal(r.ok, true, JSON.stringify(r.error)); const added = BR.sync_journal(j, ws, r.ws); ws = r.ws; return added; };
  const a1 = step(upsert_cal());
  assert.deepEqual(a1.map((e) => e.type), ['calendar.set']);
  assert.equal(a1[0].entity_id, 'cal-hol');
  assert.equal(a1[0].supersedes_id, undefined, 'новый календарь — запись set');
  const a2 = step({ type: 'upsert_calendar', calendar: { calendar_id: 'cal-main', name: CAL_MAIN.name, weekend_dows: [0, 6], holidays: ['2026-10-26'] } });
  assert.deepEqual(a2.map((e) => e.type), ['calendar.set']);
  assert.equal(typeof a2[0].supersedes_id, 'string', 'исправление — запись с supersedes_id, а не перезапись');
  assert.equal(facts_hash(ws, j.events()), h0, 'хэш проведённых фактов прежний');
  assert.equal(E.canon(ws.facts), E.canon(G.facts), 'проведённые факты не тронуты');
  // второе применение той же правки: рабочая область не меняется, запись в журнал не добавляется
  const again = apply(ws, { type: 'upsert_calendar', calendar: { calendar_id: 'cal-main', name: CAL_MAIN.name, weekend_dows: [0, 6], holidays: ['2026-10-26'] } });
  assert.equal(E.canon(again.ws), E.canon(ws));
  assert.deepEqual(BR.sync_journal(j, ws, again.ws), [], 'повтор — без новой записи');
  assert.equal(j.length, n0 + 2);
  const back = BR.events_to_ws(j.events());
  assert.equal(E.canon(back.calendars.slice().sort((a, b) => (a.calendar_id < b.calendar_id ? -1 : 1))), E.canon(ws.calendars.slice().sort((a, b) => (a.calendar_id < b.calendar_id ? -1 : 1))));
  assert.equal(hash_of(back), hash_of(ws), 'свёртка журнала даёт те же числа');
  assert.equal(j.state_hash(), E.state_hash(E.reduce(E.effective_events(j.events()))));
  // удаление — откат действующей записи (revert) и всей цепочки замен
  const a3 = step({ type: 'delete_calendar', calendar_id: 'cal-hol' });
  assert.ok(a3.every((e) => e.type === 'revert'));
  assert.ok(!BR.events_to_ws(j.events()).calendars.some((c) => c.calendar_id === 'cal-hol'));
  assert.equal(facts_hash(ws, j.events()), h0);
});

test('REQ-009 delete_calendar: календарь, нужный правилу или потоку часов, не удаляется (cal_in_use); свободный удаляется, круг «создать — удалить» возвращает данные побайтно', () => {
  const used = apply(G, { type: 'delete_calendar', calendar_id: 'cal-main' });
  assert.equal(used.ok, false);
  assert.equal(used.error.code, 'E_SCHEMA');
  assert.equal(used.error.ctx.reason, 'cal_in_use');
  assert.deepEqual(CAL.calendar_usage(G, 'cal-main'), { rules: 4, streams: 1 });
  assert.equal(apply(G, { type: 'delete_calendar', calendar_id: 'нет-такого' }).error.ctx.reason, 'unknown_calendar');
  assert.equal(apply(G, { type: 'delete_calendar', calendar_id: 'cal-main', extra: 1 }).error.ctx.reason, 'unknown_field');
  const ws = must(apply(G, upsert_cal()));
  const back = must(apply(ws, { type: 'delete_calendar', calendar_id: 'cal-hol' }));
  assert.equal(E.canon(back), E.canon(G));
  // правило начинает пользоваться календарём — удалить его уже нельзя
  const rent = { ...G.rules.find((r) => r.rule_id === 'R-GROC'), calendar_id: 'cal-hol' };
  const ws2 = must(apply(ws, { type: 'upsert_rule', rule: rent }));
  assert.equal(apply(ws2, { type: 'delete_calendar', calendar_id: 'cal-hol' }).error.ctx.reason, 'cal_in_use');
});

test('TST-16 REQ-090: «Отменить» возвращает календарь и разовый платёж побайтно, подпись — «изменение календаря» / «изменение разового платежа» (RU и EN); каждый вид правки пакета известен стопке', () => {
  const ws1 = must(apply(G, upsert_cal()));
  const unit = UNDO.diff_unit(G, ws1, UNDO.describe_unit('upsert_calendar', { changes: [{ bucket: 'calendars' }] }, ws1));
  assert.ok(unit !== null);
  const undone = UNDO.apply_unit(ws1, unit, 'undo');
  assert.equal(undone.ok, true);
  assert.equal(E.canon(undone.ws), E.canon(G));
  const redone = UNDO.apply_unit(undone.ws, unit, 'redo');
  assert.equal(E.canon(redone.ws), E.canon(ws1));
  const ws2 = must(apply(G, { type: 'upsert_plan', plan: { plan_id: 'P-GIFT', account_id: 'acc_main', name: 'Подарок', date: '2026-11-15', amount_minor: -12000 } }));
  const u2 = UNDO.diff_unit(G, ws2, { kind: 'plan' });
  assert.equal(E.canon(UNDO.apply_unit(ws2, u2, 'undo').ws), E.canon(G));
  for (const t of Object.keys(PACK.EDITS)) {
    assert.ok(Object.hasOwn(UNDO.REASON_KINDS, t), 'вид правки без вида подписи: ' + t);
    assert.ok(Object.hasOwn(UNDO.UNDO_LABEL_KEYS, UNDO.REASON_KINDS[t]), t);
  }
  assert.equal(UNDO.REASON_KINDS.upsert_calendar, 'calendar');
  assert.equal(UNDO.REASON_KINDS.delete_calendar, 'calendar');
  assert.equal(UNDO.REASON_KINDS.upsert_plan, 'plan');
  assert.equal(UNDO.REASON_KINDS.delete_plan, 'plan');
  assert.equal(UNDO.describe_unit('нет_такой', { changes: [{ bucket: 'calendars' }] }, ws1).kind, 'calendar', 'без причины вид берётся по корзине');
  assert.equal(UNDO.describe_unit('нет_такой', { changes: [{ bucket: 'plans' }] }, ws2).kind, 'plan');
  const money = (minor, cur) => `${minor / 100} ${cur}`;
  assert.equal(UNDO.unit_label({ kind: 'calendar' }, tr('ru'), money), 'изменение календаря');
  assert.equal(UNDO.unit_label({ kind: 'plan' }, tr('ru'), money), 'изменение разового платежа');
  assert.equal(UNDO.unit_label({ kind: 'calendar' }, tr('en'), money), 'calendar change');
  assert.equal(UNDO.unit_label({ kind: 'plan' }, tr('en'), money), 'one-off payment change');
  assert.ok(ENTRY.ru['entry.u_calendar'] && ENTRY.en['entry.u_plan']);
});

// ── REQ-009: разбор формы календаря и предпросмотр ───────────────────────────────────────────────────────────────────

test('REQ-009 разбор формы календаря: даты через пробел, запятую, точку с запятой и с новой строки; ISO и в формате рабочей области; повторы убираются; пусто — допустимо; отказ не повторяет введённое', () => {
  const p = (text, env = ENV) => CAL.parse_holidays_text(text, env);
  assert.deepEqual(p('2026-12-25, 2026-12-26;2026-01-01\n2026-12-25   2026-05-01').value, ['2026-01-01', '2026-05-01', '2026-12-25', '2026-12-26']);
  assert.deepEqual(p('25.12.2026 01.01.2027').value, ['2026-12-25', '2027-01-01'], 'формат даты русского интерфейса');
  assert.deepEqual(p('12/25/2026', { ...ENV, lang: 'en' }).value, ['2026-12-25'], 'формат даты английского интерфейса');
  assert.deepEqual(p('').value, []);
  assert.deepEqual(p('  \n ,; ').value, []);
  assert.deepEqual(p(undefined).value, []);
  for (const [text, code, typed] of [['2026-12-25 вчера', 'E_BAD_DATE', 'вчера'], ['2026-02-30', 'E_BAD_DATE', '2026-02-30'], ['1960-05-05', 'E_BAD_DATE', '1960'], ['32.12.2026', 'E_BAD_DATE', '32.12.2026']]) {
    const r = p(text);
    assert.equal(r.ok, false, text);
    assert.equal(r.error.code, code);
    assert.equal(r.error.ctx.field, 'holidays');
    if (typed !== '1960') no_echo(r, typed);
  }
  assert.equal(p(Array.from({ length: CAL.HOLIDAYS_MAX + 1 }, (_, i) => `2026-${String(1 + (i % 12)).padStart(2, '0')}-15`).join(' ')).error.ctx.reason, 'cal_too_many_holidays');
  const T = { calendar_id: 'cal-new', name: 'Мой', weekend_dows: ['6', '0'], holidays: '2026-12-25' };
  const built = CAL.build_calendar_edit(G, T, ENV);
  assert.equal(built.ok, true, JSON.stringify(built.error));
  assert.deepEqual(built.edit, { type: 'upsert_calendar', calendar: { calendar_id: 'cal-new', name: 'Мой', weekend_dows: [0, 6], holidays: ['2026-12-25'] } });
  for (const [over, code, field] of [[{ name: '  ' }, 'E_SCHEMA', 'name'], [{ weekend_dows: ['0', '1', '2', '3', '4', '5', '6'] }, 'E_RULE_INVALID', 'weekend_dows'], [{ weekend_dows: ['9'] }, 'E_SCHEMA', 'weekend_dows'],
    [{ weekend_dows: 'сб' }, 'E_SCHEMA', 'weekend_dows'], [{ holidays: '2026-13-01' }, 'E_BAD_DATE', 'holidays']]) {
    const r = CAL.build_calendar_edit(G, { ...T, ...over }, ENV);
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.deepEqual([r.error.code, r.error.ctx.field], [code, field], JSON.stringify(over));
  }
  assert.equal(CAL.build_calendar_edit(G, null, ENV).error.ctx.reason, 'not_object');
});

test('REQ-009 предпросмотр календаря: ближайшие нерабочие дни с причиной «праздник» / «выходной» от даты расчёта; правка не принимается — код вместо дат; названия выходных RU и EN', () => {
  const rows = CAL.upcoming_days_off({ weekend_dows: [0, 6], holidays: ['2026-10-07'] }, '2026-10-04');
  assert.deepEqual(rows.slice(0, 4), [{ date: '2026-10-04', why: 'weekend' }, { date: '2026-10-07', why: 'holiday' }, { date: '2026-10-10', why: 'weekend' }, { date: '2026-10-11', why: 'weekend' }]);
  assert.equal(rows.length, CAL.PREVIEW_ROWS);
  assert.deepEqual(CAL.upcoming_days_off({ weekend_dows: [0, 6], holidays: ['2026-10-10'] }, '2026-10-04').filter((x) => x.date === '2026-10-10'), [{ date: '2026-10-10', why: 'holiday' }], 'праздник сильнее выходного');
  assert.deepEqual(CAL.upcoming_days_off({ weekend_dows: [], holidays: [] }, '2026-10-04'), []);
  const built = CAL.build_calendar_edit(G, { calendar_id: 'cal-x', name: 'X', weekend_dows: ['0'], holidays: '2026-10-07' }, ENV);
  const p = CAL.calendar_preview(G, built.edit, { as_of: G.as_of, new_id: ids });
  assert.equal(p.ok, true);
  assert.deepEqual(p.rows.slice(0, 2).map((x) => x.date), ['2026-10-04', '2026-10-07']);
  const bad = CAL.calendar_preview(G, { type: 'upsert_calendar', calendar: { calendar_id: 'acc_main', name: 'X', weekend_dows: [0], holidays: [] } }, { as_of: G.as_of });
  assert.equal(bad.ok, false);
  assert.equal(CAL.weekend_names('ru', [0, 6]), 'Сб, Вс');
  assert.equal(CAL.weekend_names('en', [0, 6]), 'Sat, Sun');
  assert.equal(CAL.weekend_names('ru', [1, 0, 3]), 'Пн, Ср, Вс');
  assert.equal(CAL.weekend_names('ru', []), null);
  assert.equal(CAL.weekend_names('ru', undefined), 'Сб, Вс', 'без поля — умолчание движка');
});

test('REQ-009 REQ-017 тексты отказов: у причин пакета — своя фраза с кодом канона RU и EN, у остальных — общий текст формы; введённое не повторяется', () => {
  for (const lang of ['ru', 'en']) {
    const ctx = { tr: tr(lang) };
    for (const reason of ['cal_in_use', 'cal_no_business_days', 'cal_too_many_holidays', 'cal_holiday_out_of_range', 'plan_has_matches', 'plan_is_transfer']) {
      const text = CAL.reason_text(ctx, { code: 'E_SCHEMA', ctx: { field: 'x', reason } });
      assert.ok(text.includes('E_SCHEMA'), `${lang}/${reason}: в тексте код канона`);
      assert.ok(!text.includes('calendars.r_'), `${lang}/${reason}: строка найдена`);
    }
    const generic = CAL.reason_text(ctx, { code: 'E_BAD_DATE', ctx: { field: 'holidays', reason: 'bad_date' } });
    assert.ok(generic.includes('E_BAD_DATE') && generic.includes(tr(lang)('forms.f_holidays')), generic);
    assert.equal(CAL.reason_text(ctx, { code: 'E_SCHEMA', ctx: { field: 'name', reason: 'zero' } }), FORMS.error_text(ctx, { code: 'E_SCHEMA', ctx: { field: 'name', reason: 'zero' } }), 'чужие причины — как раньше');
    // причина, похожая на пакетную, но без строки, не ломает показ
    assert.ok(CAL.reason_text(ctx, { code: 'E_SCHEMA', ctx: { field: 'name', reason: 'cal_нет_такой' } }).includes('E_SCHEMA'));
  }
});

// ── REQ-009: форма правила — n-й рабочий день, календарь, списки ─────────────────────────────────────────────────────

const RULE_TEXTS = {
  rule_id: 'rule_wd', name: 'Взнос', kind: 'expense', amount: '100', account_id: 'acc_main', freq: 'M', interval: '1', start_date: '2026-10-01',
  monthday: '', workday: '3', weekday: '', weekend: 'keep', calendar_id: 'cal-main', until_date: '', is_obligation: true, is_estimate: false,
};
/** Тексты полей формы для открытого правила — как это делает `fill()` в форме. */
function texts_of_rule(ws, rule) {
  const acc = ws.accounts.find((a) => a.account_id === rule.account_id);
  return {
    rule_id: rule.rule_id, name: rule.name, kind: rule.kind, amount: String(Math.abs(rule.amount.exp_minor) / 100), account_id: rule.account_id, freq: rule.freq, interval: String(rule.interval),
    start_date: rule.start_date, monthday: Array.isArray(rule.by_monthday) ? rule.by_monthday.join(', ') : '', workday: Array.isArray(rule.by_workday) ? rule.by_workday.join(', ') : '',
    weekday: Array.isArray(rule.by_weekday) ? rule.by_weekday.join(',') : '', weekend: rule.weekend ?? 'keep', calendar_id: rule.calendar_id ?? '', until_date: rule.until_date ?? '',
    is_obligation: rule.is_obligation === true, is_estimate: rule.is_estimate === true, _currency: acc.currency,
  };
}

test('REQ-009 TST-13 форма правила не теряет by_workday: «создать — открыть — сохранить» даёт те же данные и ту же версию; даты — n-й рабочий день по календарю, праздник сдвигает счёт', () => {
  const built = RULE.build_rule_edit(G, RULE_TEXTS, ENV);
  assert.equal(built.ok, true, JSON.stringify(built.error));
  assert.deepEqual(built.edit.rule.by_workday, [3]);
  assert.equal(built.edit.rule.by_monthday, undefined);
  const ws1 = must(apply(G, built.edit));
  const rule1 = ws1.rules.find((r) => r.rule_id === 'rule_wd');
  assert.deepEqual(rule1.by_workday, [3]);
  assert.deepEqual(RULE.occurrences_of(ws1, rule1, ws1.as_of, 3).map((x) => x.date), ['2026-10-05', '2026-11-04', '2026-12-03'], 'третий рабочий день месяца');
  // открыть и сохранить без изменений
  const reopened = RULE.build_rule_edit(ws1, texts_of_rule(ws1, rule1), ENV);
  assert.equal(reopened.ok, true, JSON.stringify(reopened.error));
  assert.deepEqual(reopened.edit.rule.by_workday, [3], 'поле не потеряно при сохранении');
  const ws2 = must(apply(ws1, reopened.edit));
  assert.equal(E.canon(ws2), E.canon(ws1), 'ничего не изменилось');
  assert.equal(ws2.rules.find((r) => r.rule_id === 'rule_wd').version, 1, 'версия не повышена');
  // правка суммы сохраняет by_workday и повышает версию
  const raised = RULE.build_rule_edit(ws1, { ...texts_of_rule(ws1, rule1), amount: '120' }, ENV);
  const ws3 = must(apply(ws1, raised.edit));
  assert.deepEqual(ws3.rules.find((r) => r.rule_id === 'rule_wd').by_workday, [3]);
  assert.equal(ws3.rules.find((r) => r.rule_id === 'rule_wd').version, 2);
  // прежние вызовы без поля «workday» тоже его не стирают
  const { workday: _w, ...legacy } = texts_of_rule(ws1, rule1);
  assert.deepEqual(RULE.build_rule_edit(ws1, legacy, ENV).edit.rule.by_workday, [3]);
  // календарь решает, что такое рабочий день: праздник 3 ноября делает третьим рабочим днём 5 ноября
  const ws4 = must(apply(ws1, { type: 'upsert_calendar', calendar: { ...CAL_MAIN, holidays: ['2026-11-03'] } }));
  assert.deepEqual(RULE.occurrences_of(ws4, ws4.rules.find((r) => r.rule_id === 'rule_wd'), ws4.as_of, 2).map((x) => x.date), ['2026-10-05', '2026-11-05']);
  // последний рабочий день месяца и несколько значений
  const last = RULE.build_rule_edit(G, { ...RULE_TEXTS, workday: '-1' }, ENV);
  assert.deepEqual(RULE.rule_preview(G, last.edit, { as_of: G.as_of }).rows.slice(0, 2).map((x) => x.date), ['2026-10-30', '2026-11-30']);
  const two = RULE.build_rule_edit(G, { ...RULE_TEXTS, workday: '1, −1' }, ENV);
  assert.deepEqual(two.edit.rule.by_workday, [1, -1]);
  assert.deepEqual(RULE.rule_preview(G, two.edit, { as_of: G.as_of }).rows.slice(0, 3).map((x) => x.date), ['2026-10-30', '2026-11-02', '2026-11-30']);
});

test('REQ-009 REQ-017 поле «n-й рабочий день»: вместе с днём месяца — E_RULE_INVALID; не для «раз в неделю»; ноль, не число и выход за границы — коды без повтора введённого', () => {
  const r1 = RULE.build_rule_edit(G, { ...RULE_TEXTS, monthday: '25' }, ENV);
  assert.deepEqual([r1.ok, r1.error.code, r1.error.ctx.field, r1.error.ctx.reason], [false, 'E_RULE_INVALID', 'workday', 'exclusive_with_monthday']);
  const r2 = RULE.build_rule_edit(G, { ...RULE_TEXTS, freq: 'W' }, ENV);
  assert.deepEqual([r2.error.code, r2.error.ctx.reason], ['E_RULE_INVALID', 'only_for_M']);
  for (const [text, code] of [['0', 'E_SCHEMA'], ['abc', 'E_NOT_INTEGER'], ['32', 'E_SCHEMA'], ['1, x7', 'E_NOT_INTEGER'], ['-32', 'E_SCHEMA']]) {
    const r = RULE.build_rule_edit(G, { ...RULE_TEXTS, workday: text }, ENV);
    assert.equal(r.ok, false, text);
    assert.equal(r.error.code, code, text);
    assert.equal(r.error.ctx.field, 'workday');
    no_echo(r, 'x7');
    if (text === 'abc') no_echo(r, 'abc');
  }
  // пустое поле — правило без n-го рабочего дня: прежнее by_workday снимается явным пустым значением
  const ws1 = must(apply(G, RULE.build_rule_edit(G, RULE_TEXTS, ENV).edit));
  const cleared = RULE.build_rule_edit(ws1, { ...texts_of_rule(ws1, ws1.rules.at(-1)), workday: '' }, ENV);
  assert.equal(cleared.edit.rule.by_workday, undefined);
  // validate_rule движка остаётся последней проверкой: n-й рабочий день без дня месяца и с политикой — допустим
  assert.equal(apply(G, RULE.build_rule_edit(G, { ...RULE_TEXTS, weekend: 'next' }, ENV).edit).ok, true);
});

test('REQ-009 форма правила не теряет списки: несколько дней месяца («1, 15, −1») и несколько дней недели сохраняются при открытии и сохранении', () => {
  const m = RULE.build_rule_edit(G, { ...RULE_TEXTS, rule_id: 'rule_md', workday: '', monthday: '1, 15' }, ENV);
  assert.deepEqual(m.edit.rule.by_monthday, [1, 15]);
  const ws1 = must(apply(G, m.edit));
  const rule = ws1.rules.find((r) => r.rule_id === 'rule_md');
  assert.deepEqual(RULE.occurrences_of(ws1, rule, ws1.as_of, 3).map((x) => x.date), ['2026-10-15', '2026-11-01', '2026-11-15']);
  const again = must(apply(ws1, RULE.build_rule_edit(ws1, texts_of_rule(ws1, rule), ENV).edit));
  assert.equal(E.canon(again), E.canon(ws1), 'два дня месяца не потеряны');
  const w = RULE.build_rule_edit(G, { ...RULE_TEXTS, rule_id: 'rule_wk', workday: '', freq: 'W', weekday: '1,3', start_date: '2026-10-05' }, ENV);
  assert.deepEqual(w.edit.rule.by_weekday, [1, 3]);
  const ws2 = must(apply(G, w.edit));
  const wk = ws2.rules.find((r) => r.rule_id === 'rule_wk');
  assert.deepEqual(RULE.occurrences_of(ws2, wk, ws2.as_of, 3).map((x) => x.date), ['2026-10-05', '2026-10-07', '2026-10-12']);
  const again2 = must(apply(ws2, RULE.build_rule_edit(ws2, texts_of_rule(ws2, wk), ENV).edit));
  assert.equal(E.canon(again2), E.canon(ws2), 'два дня недели не потеряны');
  assert.equal(RULE.build_rule_edit(G, { ...RULE_TEXTS, workday: '', monthday: '1, 15, 99' }, ENV).error.code, 'E_SCHEMA');
  assert.equal(RULE.build_rule_edit(G, { ...RULE_TEXTS, workday: '', monthday: '1, abc' }, ENV).error.code, 'E_NOT_INTEGER');
});

test('REQ-009 выбор календаря в правиле: явный выбор записывается, «по умолчанию» снимает calendar_id, неизвестный отвергается; поле не передано — календарь правила не меняется, а первый календарь берётся только при политике переноса', () => {
  const base = { ...RULE_TEXTS, workday: '', monthday: '10' };
  assert.equal(RULE.build_rule_edit(G, { ...base, calendar_id: 'cal-main' }, ENV).edit.rule.calendar_id, 'cal-main');
  assert.equal(RULE.build_rule_edit(G, { ...base, calendar_id: '' }, ENV).edit.rule.calendar_id, undefined);
  const unknown = RULE.build_rule_edit(G, { ...base, calendar_id: 'нет' }, ENV);
  assert.deepEqual([unknown.error.code, unknown.error.ctx.reason], ['E_SCHEMA', 'unknown_calendar']);
  no_echo(unknown, 'нет');
  const { calendar_id: _c, ...legacy } = base;
  assert.equal(RULE.build_rule_edit(G, legacy, ENV).edit.rule.calendar_id, undefined, 'правило без политики календаря не получает');
  assert.equal(RULE.build_rule_edit(G, { ...legacy, weekend: 'next' }, ENV).edit.rule.calendar_id, 'cal-main', 'прежнее поведение для вызовов без поля');
  assert.equal(RULE.build_rule_edit(G, { ...legacy, rule_id: 'R-RENT', amount: '900', start_date: '2026-01-25', monthday: '25', weekend: 'next' }, ENV).edit.rule.calendar_id, 'cal-main');
  // «по умолчанию»: правило со сдвигом без календаря считается по субботе и воскресенью
  const ws = must(apply(G, RULE.build_rule_edit(G, { ...base, rule_id: 'R-RENT', amount: '900', start_date: '2026-01-25', monthday: '25', weekend: 'next', calendar_id: '' }, ENV).edit));
  assert.equal(ws.rules.find((r) => r.rule_id === 'R-RENT').calendar_id, undefined);
  assert.equal(RULE.occurrences_of(ws, ws.rules.find((r) => r.rule_id === 'R-RENT'), ws.as_of, 1)[0].date, '2026-10-26', 'воскресенье 25 октября сдвинуто на понедельник');
});

test('REQ-009 политика без календаря больше не молчит: форма называет причину («календаря нет — суббота и воскресенье») и предлагает его создать; текст есть на RU и EN', () => {
  const none = clone(G);
  none.calendars = [];
  for (const r of none.rules) delete r.calendar_id;
  for (const st of none.streams) delete st.calendar_id;
  assert.equal(RULE.calendar_notice(none, { weekend: 'next', calendar_id: '' }), 'no_calendars');
  assert.equal(RULE.calendar_notice(none, { weekend: 'prev', calendar_id: '' }), 'no_calendars');
  assert.equal(RULE.calendar_notice(none, { weekend: 'keep', freq: 'M', workday: '3', calendar_id: '' }), 'no_calendars', 'n-й рабочий день тоже нуждается в календаре');
  assert.equal(RULE.calendar_notice(none, { weekend: 'keep', calendar_id: '' }), 'none');
  assert.equal(RULE.calendar_notice(none, { weekend: 'keep', freq: 'W', workday: '3' }), 'none', 'для недели n-й рабочий день не используется');
  assert.equal(RULE.calendar_notice(G, { weekend: 'next', calendar_id: '' }), 'default_chosen');
  assert.equal(RULE.calendar_notice(G, { weekend: 'next', calendar_id: 'cal-main' }), 'none');
  assert.equal(RULE.calendar_notice(G, { weekend: 'next' }), 'none', 'поле не передано — подменять нечего');
  assert.equal(RULE.calendar_notice(G, null), 'none');
  for (const lang of ['ru', 'en']) {
    for (const k of ['forms.cal_note_none', 'forms.cal_note_default', 'forms.cal_make', 'forms.cal_default']) assert.notEqual(I18N.t(lang, k), k, `${lang}: нет строки ${k}`);
    assert.ok(/суббот|Saturday/i.test(I18N.t(lang, 'forms.cal_note_none')), 'в тексте названо, чем заменён календарь');
  }
  // правило со сдвигом без календаря и без календарей в данных всё же считается (по умолчанию) — молчание заменено словами, расчёт прежний
  const ws = must(apply(none, RULE.build_rule_edit(none, { ...RULE_TEXTS, workday: '', monthday: '25', weekend: 'next', calendar_id: '', start_date: '2026-10-25' }, ENV).edit));
  assert.equal(RULE.occurrences_of(ws, ws.rules.at(-1), ws.as_of, 1)[0].date, '2026-10-26');
});

// ── REQ-010: разовый платёж ──────────────────────────────────────────────────────────────────────────────────────────

const PLAN_TEXTS = { plan_id: 'P-GIFT', name: 'Подарок', kind: 'expense', amount: '120', account_id: 'acc_main', date: '2026-11-15', tag: '', is_obligation: false, is_estimate: false };

test('REQ-010 upsert_plan: разовый платёж входит в прогноз так же, как запись набора; вид и знак согласованы; «изменить» заменяет запись на месте, статус и поля вне формы сохраняются; повтор идемпотентен', () => {
  const built = PLAN.build_plan_edit(G, PLAN_TEXTS, ENV);
  assert.equal(built.ok, true, JSON.stringify(built.error));
  assert.deepEqual(built.edit.plan, { plan_id: 'P-GIFT', account_id: 'acc_main', name: 'Подарок', date: '2026-11-15', amount_minor: -12000, kind: 'expense', is_obligation: false, is_estimate: false, tag: '' });
  const ws1 = must(apply(G, built.edit));
  const plan = ws1.plans.find((p) => p.plan_id === 'P-GIFT');
  assert.deepEqual(plan, { plan_id: 'P-GIFT', account_id: 'acc_main', name: 'Подарок', date: '2026-11-15', amount_minor: -12000, currency: 'EUR', kind: 'expense', is_obligation: false, is_estimate: false });
  assert.equal(G.plans.length, 1);
  const ev = E.analyze(ws1, { as_of: ws1.as_of }).events.plan.find((e) => e.cash_event_id === 'P-GIFT');
  assert.deepEqual([E.format_date(ev.date), ev.amount_minor], ['2026-11-15', -12000]);
  assert.notEqual(hash_of(ws1), hash_of(G));
  // поступление: знак плюс
  const inc = must(apply(G, PLAN.build_plan_edit(G, { ...PLAN_TEXTS, plan_id: 'P-REF', name: 'Возврат', kind: 'income', amount: '45,50', tag: 'возврат' }, ENV).edit));
  assert.deepEqual([inc.plans.at(-1).amount_minor, inc.plans.at(-1).kind, inc.plans.at(-1).tag], [4550, 'income', 'возврат']);
  // повтор той же правки не меняет данные
  const twice = must(apply(ws1, built.edit));
  assert.equal(E.canon(twice), E.canon(ws1));
  assert.equal(hash_of(twice), hash_of(ws1));
  // изменение: сумма другая; статус «отменён» из «Сверки» и поле резерва не теряются
  const marked = clone(ws1);
  Object.assign(marked.plans.find((p) => p.plan_id === 'P-GIFT'), { status: 'cancelled', reserve_id: 'RES-TAX' });
  const edited = must(apply(marked, PLAN.build_plan_edit(marked, { ...PLAN_TEXTS, amount: '150' }, ENV).edit));
  const rec = edited.plans.find((p) => p.plan_id === 'P-GIFT');
  assert.deepEqual([rec.amount_minor, rec.status, rec.reserve_id], [-15000, 'cancelled', 'RES-TAX']);
  assert.deepEqual(edited.plans.map((p) => p.plan_id), ['P-TAX1', 'P-GIFT'], 'на своём месте');
  // метка снимается пустым значением
  const tagged = must(apply(G, PLAN.build_plan_edit(G, { ...PLAN_TEXTS, tag: 'подарки' }, ENV).edit));
  assert.equal(tagged.plans.at(-1).tag, 'подарки');
  const untagged = must(apply(tagged, PLAN.build_plan_edit(tagged, { ...PLAN_TEXTS, tag: '' }, ENV).edit));
  assert.equal(untagged.plans.at(-1).tag, undefined);
});

test('REQ-010 REQ-017 upsert_plan: отказы с кодом канона, значения не повторяются; чужая валюта без курса — E_NO_RATE; нога перевода не правится', () => {
  const bads = [
    [{ ...PLAN_TEXTS, amount: 'abc' }, 'E_NOT_INTEGER', 'abc'], [{ ...PLAN_TEXTS, amount: '' }, 'E_NOT_INTEGER', null], [{ ...PLAN_TEXTS, amount: '0' }, 'E_SCHEMA', null],
    [{ ...PLAN_TEXTS, date: '2026-02-30' }, 'E_BAD_DATE', '2026-02-30'], [{ ...PLAN_TEXTS, date: '' }, 'E_BAD_DATE', null], [{ ...PLAN_TEXTS, date: 'вчера' }, 'E_BAD_DATE', 'вчера'],
    [{ ...PLAN_TEXTS, name: '  ' }, 'E_SCHEMA', null], [{ ...PLAN_TEXTS, account_id: 'нет' }, 'E_SCHEMA', 'нет'], [{ ...PLAN_TEXTS, kind: 'донат' }, 'E_SCHEMA', 'донат'],
  ];
  for (const [t, code, typed] of bads) {
    const r = PLAN.build_plan_edit(G, t, ENV);
    assert.equal(r.ok, false, JSON.stringify(t));
    assert.equal(r.error.code, code, JSON.stringify(t));
    if (typed !== null) no_echo(r, typed);
  }
  const edits = [
    [{ type: 'upsert_plan', plan: { plan_id: 'P-X', account_id: 'acc_main', name: 'x', date: '2026-11-15', amount_minor: 100, kind: 'expense' } }, 'E_SCHEMA', 'sign_mismatch_kind'],
    [{ type: 'upsert_plan', plan: { plan_id: 'P-X', account_id: 'acc_main', name: 'x', date: '2026-11-15', amount_minor: -100, kind: 'income' } }, 'E_SCHEMA', 'sign_mismatch_kind'],
    [{ type: 'upsert_plan', plan: { plan_id: 'P-X', account_id: 'acc_main', name: 'x', date: '2026-11-15', amount_minor: -100, kind: 'transfer' } }, 'E_SCHEMA', 'not_in_list'],
    [{ type: 'upsert_plan', plan: { plan_id: 'P-X', account_id: 'acc_main', name: 'x', date: '2026-11-15', amount_minor: -100, currency: 'USD' } }, 'E_CURRENCY_MISMATCH', 'differs_from_account'],
    [{ type: 'upsert_plan', plan: { plan_id: 'P-X', account_id: 'acc_main', name: 'x', date: '2026-11-15', amount_minor: -1.5 } }, 'E_NOT_INTEGER', null],
    [{ type: 'upsert_plan', plan: { plan_id: 'P-X', account_id: 'acc_main', name: 'x', date: '2026-11-15', amount_minor: 2 ** 60 } }, 'E_OVERFLOW', null],
    [{ type: 'upsert_plan', plan: { plan_id: 'acc_main', account_id: 'acc_main', name: 'x', date: '2026-11-15', amount_minor: -100 } }, 'E_SCHEMA', 'id_taken_by_other_kind'],
    [{ type: 'upsert_plan', plan: { plan_id: 'P-X', account_id: 'acc_main', name: 'x', date: '2026-11-15', amount_minor: -100, status: 'cancelled' } }, 'E_SCHEMA', 'unknown_field'],
    [{ type: 'upsert_plan', plan: { plan_id: 'P-X', account_id: 'acc_main', name: 'x', date: '2026-11-15', amount_minor: -100, transfer_id: 'T' } }, 'E_SCHEMA', 'unknown_field'],
    [{ type: 'upsert_plan', plan: { plan_id: 'P-X', account_id: 'acc_main', name: 'x', date: '2026-11-15', amount_minor: -100, is_obligation: 'да' } }, 'E_SCHEMA', 'not_boolean'],
    [{ type: 'delete_plan', plan_id: 'нет-такого' }, 'E_SCHEMA', 'unknown_plan'],
    [{ type: 'delete_plan', plan_id: 'P-TAX1', extra: 1 }, 'E_SCHEMA', 'unknown_field'],
  ];
  for (const [edit, code, reason] of edits) {
    const r = apply(G, edit);
    assert.equal(r.ok, false, JSON.stringify(edit).slice(0, 140));
    assert.equal(r.error.code, code, JSON.stringify(edit).slice(0, 140));
    if (reason !== null) assert.equal(r.error.ctx.reason, reason);
  }
  assert.equal(apply(G, JSON.parse('{"type":"upsert_plan","plan":{"plan_id":"P-X","account_id":"acc_main","name":"x","date":"2026-11-15","amount_minor":-100,"__proto__":{"a":1}}}')).error.ctx.reason, 'forbidden_key');
  // счёт в чужой валюте без курса к валюте решения
  const usd = clone(G);
  usd.accounts.push({ account_id: 'acc_usd', name: 'Доллары', kind: 'bank', liquidity: 'operating', currency: 'USD' });
  const no_rate = apply(usd, { type: 'upsert_plan', plan: { plan_id: 'P-USD', account_id: 'acc_usd', name: 'x', date: '2026-11-15', amount_minor: -1000 } });
  assert.equal(no_rate.ok, false);
  assert.equal(no_rate.error.code, 'E_NO_RATE');
  const rated = clone(usd);
  rated.rates = [...(rated.rates ?? []), { fx_id: 'fx1', date: '2026-10-01', base: 'USD', quote: 'EUR', num: 92, den: 100 }];
  assert.equal(apply(rated, { type: 'upsert_plan', plan: { plan_id: 'P-USD', account_id: 'acc_usd', name: 'x', date: '2026-11-15', amount_minor: -1000 } }).ok, true);
  // нога перевода: правка и удаление отвергаются
  const tr_ws = clone(G);
  tr_ws.plans.push({ plan_id: 'P-LEG', account_id: 'acc_main', name: 'Перевод', date: '2026-11-20', amount_minor: -5000, currency: 'EUR', transfer_id: 'T-1' });
  assert.equal(apply(tr_ws, { type: 'upsert_plan', plan: { plan_id: 'P-LEG', account_id: 'acc_main', name: 'Перевод', date: '2026-11-21', amount_minor: -5000 } }).error.ctx.reason, 'plan_is_transfer');
  assert.equal(apply(tr_ws, { type: 'delete_plan', plan_id: 'P-LEG' }).error.ctx.reason, 'plan_is_transfer');
  assert.deepEqual(PLAN.plan_rows(tr_ws).upcoming.map((p) => p.plan_id), ['P-TAX1'], 'в списке разовых платежей ног перевода нет');
});

test('REQ-010 delete_plan: платёж без привязанных записей удаляется (журнал — revert), с привязанным фактом — plan_has_matches; круг «ввести — удалить» возвращает данные побайтно; запись журнала plan.set', () => {
  let ws = G;
  const j = fresh_journal(ws);
  const step = (edit) => { const r = apply(ws, edit); assert.equal(r.ok, true, JSON.stringify(r.error)); const added = BR.sync_journal(j, ws, r.ws); ws = r.ws; return added; };
  const a1 = step(PLAN.build_plan_edit(ws, PLAN_TEXTS, ENV).edit);
  assert.deepEqual(a1.map((e) => e.type), ['plan.set']);
  assert.equal(a1[0].entity_id, 'P-GIFT');
  assert.equal(E.canon(BR.events_to_ws(j.events()).plans.find((p) => p.plan_id === 'P-GIFT')), E.canon(ws.plans.find((p) => p.plan_id === 'P-GIFT')));
  // привязанный факт
  const linked = clone(ws);
  linked.facts.push({ event_id: 'tx-gift', account_id: 'acc_main', date: '2026-10-03', amount_minor: -12000, currency: 'EUR', plan_ref: 'P-GIFT' });
  const refused = apply(linked, { type: 'delete_plan', plan_id: 'P-GIFT' });
  assert.equal(refused.error.ctx.reason, 'plan_has_matches');
  const a2 = step({ type: 'delete_plan', plan_id: 'P-GIFT' });
  assert.ok(a2.every((e) => e.type === 'revert'));
  assert.equal(E.canon(ws), E.canon(G));
  assert.ok(!BR.events_to_ws(j.events()).plans.some((p) => p.plan_id === 'P-GIFT'));
});

test('REQ-010 список разовых платежей: ближайшие по дате, прошедшие считаются отдельно; предпросмотр отмечает дату раньше «сегодня»; отказ правки — код вместо предпросмотра', () => {
  const ws = clone(G);
  ws.plans.push(
    { plan_id: 'P-OLD', account_id: 'acc_main', name: 'Было', date: '2026-09-01', amount_minor: -100, currency: 'EUR' },
    { plan_id: 'P-B', account_id: 'acc_main', name: 'Б', date: '2026-12-01', amount_minor: -100, currency: 'EUR' },
    { plan_id: 'P-A', account_id: 'acc_main', name: 'А', date: '2026-12-01', amount_minor: -100, currency: 'EUR' });
  const m = PLAN.plan_rows(ws, 2);
  assert.deepEqual(m.shown.map((p) => p.plan_id), ['P-TAX1', 'P-A'], 'по дате, затем по идентификатору; всего показывается 2');
  assert.deepEqual([m.upcoming.length, m.past], [3, 1]);
  const future = PLAN.build_plan_edit(G, PLAN_TEXTS, ENV);
  assert.deepEqual(PLAN.plan_preview(G, future.edit, { as_of: G.as_of }), { ok: true, past: false, days: 42 });
  const old = PLAN.build_plan_edit(G, { ...PLAN_TEXTS, date: '2026-09-20' }, ENV);
  assert.equal(PLAN.plan_preview(G, old.edit, { as_of: G.as_of }).past, true);
  assert.equal(PLAN.plan_preview(G, { type: 'upsert_plan', plan: { ...future.edit.plan, amount_minor: 0 } }, { as_of: G.as_of }).ok, false);
});

// ── строки RU и EN ───────────────────────────────────────────────────────────────────────────────────────────────────

test('TST-56 строки FP-13: у каждого ключа каталога calendar и добавленных ключей forms есть RU и EN с теми же плейсхолдерами; RU-строка содержит русские буквы; запрещённых формулировок нет', () => {
  const placeholders = (s) => [...s.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]).sort().join(',');
  assert.deepEqual(Object.keys(CATALOG.ru).sort(), Object.keys(CATALOG.en).sort());
  for (const k of Object.keys(CATALOG.ru)) {
    assert.equal(placeholders(CATALOG.ru[k]), placeholders(CATALOG.en[k]), k);
    const letters = (x) => x.replace(/{[A-Za-z0-9_]+}/g, '').replace(/[^A-Za-zА-Яа-яЁё]/g, '');
    if (letters(CATALOG.ru[k]) !== '') assert.match(CATALOG.ru[k], /[а-яё]/i, k);
    assert.ok(CATALOG.en[k].trim() !== '' && !/[а-яё]/i.test(CATALOG.en[k]), 'EN без русских букв: ' + k);
  }
  const added = Object.keys(FORMS_CAT.ru).filter((k) => /^forms\.(f_calendar_id|f_workday|f_holidays|f_weekend_dows|f_ov_amount|cal_|h_rule_calendar|h_rule_workday|rule_edit_label|rule_move|rule_amount|h_ov_|ov_)/.test(k));
  assert.ok(added.length >= 30, 'добавлено ключей forms: ' + added.length);
  for (const k of added) {
    assert.equal(placeholders(FORMS_CAT.ru[k]), placeholders(FORMS_CAT.en[k]), k);
    if (FORMS_CAT.ru[k].replace(/{[A-Za-z0-9_]+}/g, '').replace(/[^A-Za-zА-Яа-яЁё]/g, '') !== '') assert.match(FORMS_CAT.ru[k], /[а-яё]/i, k);
    assert.ok(!/[а-яё]/i.test(FORMS_CAT.en[k]), 'EN без русских букв: ' + k);
  }
  const vocab = JSON.parse(fs.readFileSync(path.join(PROTO, 'engine', 'vocab.json'), 'utf8'));
  const corpus = [...Object.values(CATALOG.ru), ...Object.values(CATALOG.en), ...added.flatMap((k) => [FORMS_CAT.ru[k], FORMS_CAT.en[k]])].join('\n').toLowerCase().replace(/ё/g, 'е');
  for (const phrase of vocab.forbidden_phrases) assert.ok(!corpus.includes(phrase.toLowerCase().replace(/ё/g, 'е')), `запрещено: «${phrase}»`);
  // календарь и платёж не обещают и не советуют: оговорка «не консультация» там, где речь о правилах
  assert.ok(!/налог/i.test(CATALOG.ru['calendars.cal_lead']), 'календарь — не налоговая тема');
});
