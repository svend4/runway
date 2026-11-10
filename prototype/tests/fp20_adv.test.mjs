// fp20_adv.test.mjs — состязательная проверка FP-20 (ассистент A0: чип, «что изменилось», журнал вызовов). Аддитивно: реализацию не меняет.
// Тест ADV-01 и ADV-02 фиксируют проверенные свойства (каждый вопрос пишет ровно одну запись, в записи и CSV нет текста вопроса, чужие записи не попадают в файл).
// Тесты ADV-03…ADV-08 описывали ЖЕЛАЕМОЕ поведение там, где проверка нашла дефект (были `todo`); дефекты исправлены, `todo` снят — теперь это обычные регрессионные тесты.
// Часы страницы детерминированы (день расчёта G-001 — 4 октября), браузер, сервер и сеть не используются.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const imp = (...p) => import(pathToFileURL(path.join(HERE, '..', ...p)).href);
const APP = await imp('demo', 'app.mjs'); // без DOM: приложение не запускается (как в demo.test.mjs)
const CL = await imp('engine', 'call_log.mjs');
const V = await imp('engine', 'verifier.mjs');
const { ws_to_events, sync_journal } = await imp('demo', 'ws_bridge.mjs');
const { make_event } = await imp('engine', 'index.mjs');
const { create_journal, ports_from_gen } = await imp('demo', 'journal_log.mjs');
const { make_id_gen, seeded_ports } = await imp('demo', 'ids.mjs');

const G = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'data', 'g001.json'), 'utf8'));
const MG = APP.build_model(G);
const INCOME = APP.first_income_ref(MG);
const INFO = { as_of: G.as_of, horizon_end: '2026-11-30', currency: 'EUR', income_ref: INCOME };
const norm = (s) => s.replace(/[   ]/g, ' ');

/** Журнал страницы как у реестра расширений (записи из `ws_to_events`, штамп 4 октября), часы страницы — тоже 4 октября (пользователь, у которого «сегодня» = день расчёта). */
function page_journal(start = Date.UTC(2026, 9, 4, 10, 0, 0)) {
  return create_journal({ events: ws_to_events(G), ports: ports_from_gen(make_id_gen(seeded_ports({ start_ms: start, step_ms: 1000 }))) });
}
const ports_of = (journal) => {
  const ev = journal.events();
  return { journal: ev, call_log: CL.call_day_port(ev), last_call: CL.last_call_hex(ev), record: (r, a) => CL.record_call(journal, r, a) };
};

const QUESTIONS = [
  ['можно ли купить за 300 € 12 октября', 'ru'], ['сколько можно потратить 12 октября', 'ru'], ['когда можно купить за 300 €', 'ru'], ['почему узкая точка', 'ru'],
  ['какие волны платежей', 'ru'], ['налоговый конверт', 'ru'], ['если клиент заплатит на 10 дней позже', 'ru'], ['покажи прогноз до 20 ноября', 'ru'],
  ['что изменилось с 4 октября', 'ru'], ['а если сдвинуть платёж на 10 дней', 'ru'], ['что с резервом', 'ru'],
  ['what changed since October 4', 'en'], ['what if we shift the payment by 10 days', 'en'], ['what about the reserve', 'en'],
];

test('ADV-01 каждый ответ с Result пишет ровно одну запись assistant.call (call_id сходится для всех десяти инструментов); в журнале и CSV нет текста вопросов, сумм и дат из вопросов', () => {
  const journal = page_journal();
  const before = journal.length;
  for (const [q, lang] of QUESTIONS) {
    const n = journal.length;
    const r = APP.ask_a0(MG, q, lang, INCOME, ports_of(journal));
    assert.equal(r.ok, true, q);
    assert.equal(journal.length, n + 1, 'одна запись на вопрос: ' + q);
    assert.equal(journal.events().at(-1).payload.call_id, r.ref.slice(2), q);
  }
  const calls = journal.events().slice(before);
  assert.equal(calls.length, QUESTIONS.length);
  for (const e of calls) assert.deepEqual(Object.keys(e.payload).sort(), [...CL.CALL_FIELDS].sort());
  const csv = CL.export_calls_csv(journal.events());
  assert.equal(csv.split('\n').length, QUESTIONS.length + 2);
  for (const raw of ['купить', 'октября', 'October', 'клиент', 'резерв', 'reserve', '300', 'EUR', '2026-10-12']) assert.ok(!csv.includes(raw), 'в CSV нет «' + raw + '»');
  // отказы разбора и ошибки инструмента ничего не пишут
  const n = journal.length;
  for (const q of ['', 'нечто странное', 'что изменилось', 'а если сдвинуть платёж аренды на 5 дней', 'сдвинуть платёж на 100 дней']) APP.ask_a0(MG, q, 'ru', INCOME, ports_of(journal));
  assert.equal(journal.length, n, 'отказы и ошибки инструмента без записи');
});

test('ADV-02 враждебные записи чужого журнала не попадают ни в CSV, ни в порт call_log: формула в tool, лишнее поле, хэш с минусом, версия с формулой', () => {
  const journal = page_journal();
  const r = APP.ask_a0(MG, 'налоговый конверт', 'ru', INCOME, ports_of(journal));
  const good = journal.events().at(-1).payload;
  const base = journal.events();
  const seq0 = base.at(-1).seq;
  const mk = (n, payload, at = '2026-10-07T00:00:00Z') => make_event('assistant.call', payload, { event_id: 'x~' + n, seq: seq0 + n, recorded_at: at, actor: 'assistant:x', entity_id: 'x' + n });
  const hostile = [
    mk(1, { ...good, engine_version: '=cmd|x' }), mk(2, { ...good, tool: '@SUM(1)' }), mk(3, { ...good, call_id: '+1+1' }),
    mk(4, { ...good, question: 'сколько у меня денег' }), mk(6, { ...good, args_hash: '-1' }),
  ];
  const csv = CL.export_calls_csv([...base, ...hostile]);
  assert.equal(csv, CL.export_calls_csv(base), 'ни одна из пяти испорченных записей не попала в файл');
  assert.deepEqual(CL.call_day_port([...base, ...hostile]), { [r.ref.slice(2)]: '2026-10-04' });
  assert.ok(![...csv.split('\n')].some((l) => /^[=+\-@]/.test(l.split(',')[3] ?? '')), 'формульных ячеек нет');
});

test('ADV-03 «что изменилось» не выдаёт за изменения весь набор и «был 0,00 €», когда журнал страницы начинается позже запрошенной даты', () => {
  const journal = page_journal();
  const r = APP.ask_a0(MG, 'что изменилось с 1 октября', 'ru', INCOME, ports_of(journal));
  const t = r.ok ? norm(r.text) : '';
  // желаемое: отказ («журнал начинается 4 октября») либо оговорка; нельзя утверждать «40 записей» и «был 0,00 €»
  assert.ok(!r.ok || !/Изменено записей: 40/.test(t) || /журнал начинается|нет истории|истори/.test(t), t.slice(0, 120));
  assert.ok(!r.ok || !/был 0,00 €/.test(t), 'минимум «был 0,00 €» — это пустое состояние до начала журнала, а не прошлый прогноз');
});

test('ADV-04 «а если сдвинуть платёж по ипотеке/за квартиру/по страховке» не отвечает числами сдвига ожидаемого поступления', () => {
  for (const [q, lang] of [['а если сдвинуть платёж по ипотеке на 10 дней', 'ru'], ['сдвинуть платёж за квартиру на 5 дней', 'ru'], ['а если перенести платёж по страховке', 'ru'], ['what if I move my mortgage payment by 10 days', 'en']]) {
    const r = APP.ask_a0(MG, q, lang, INCOME, null);
    assert.ok(!r.ok || /S-HOURLY|поступлен|receipt|income/i.test(r.text), q + ' → ' + (r.ok ? r.text.slice(0, 80) : r.reason));
  }
});

test('ADV-05 ответ на общий «а если сдвинуть платёж [на N дней]» называет, что именно и на сколько дней сдвинуто', () => {
  const r = APP.ask_a0(MG, 'а если сдвинуть платёж', 'ru', INCOME, null);
  assert.equal(r.ok, true);
  assert.ok(/14/.test(r.text) && /поступлен/.test(r.text), r.text);
});

test('ADV-06 «что изменилось сегодня» видит правку, внесённую сегодня (в тот же день, что и день основания)', () => {
  const journal = page_journal();
  const edited = JSON.parse(JSON.stringify(G));
  edited.params = { ...edited.params, buffer_minor: 60000 };
  sync_journal(journal, G, edited);
  const r = APP.ask_a0(APP.build_model(edited), 'что изменилось сегодня', 'ru', INCOME, ports_of(journal));
  assert.equal(r.ok, true);
  assert.ok(!/Изменено записей: 0/.test(r.text), norm(r.text).slice(0, 80));
});

test('ADV-07 «что изменилось с прошлого раза» после правки в тот же день не отвечает «0 записей»', () => {
  const journal = page_journal();
  APP.ask_a0(MG, 'сколько можно потратить 12 октября', 'ru', INCOME, ports_of(journal));
  const edited = JSON.parse(JSON.stringify(G));
  edited.params = { ...edited.params, buffer_minor: 60000 };
  sync_journal(journal, G, edited);
  const r = APP.ask_a0(APP.build_model(edited), 'что изменилось с прошлого раза', 'ru', INCOME, ports_of(journal));
  assert.equal(r.ok, true);
  assert.ok(!/Изменено записей: 0/.test(r.text) || /того же дня|сегодня/.test(r.text), norm(r.text).slice(0, 100));
});

test('ADV-08 «изменения с 1 октября» (без слова «какие») распознаётся как «что изменилось»', () => {
  const p = APP.parse_assistant_command('изменения с 1 октября', INFO);
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.intent, 'changed');
});

test('ADV-09 разбор: прежние правила побеждают — «сколько в резерве» остаётся вопросом «сколько можно потратить» (характеристика, не дефект пакета)', () => {
  const p = APP.parse_assistant_command('сколько в резерве', INFO);
  assert.equal(p.ok, true);
  assert.equal(p.intent, 'max');
  // а прямой разбор таблицы новых намерений понимает этот вопрос — тесты таблицы не показывают приоритет прежних правил
  assert.equal(V.parse_ext_intent('сколько в резерве', { as_of: G.as_of, income_ref: INCOME }).intent, 'reserve');
});
