// call_log.mjs — журнал вызовов ассистента (FP-20, REQ-136 — часть без решения владельца; ADR-010, ADR-013, ALG-12 A12.5).
// Каждый вызов инструмента, давший Result, оставляет запись журнала `assistant.call`, в которой ТОЛЬКО хэши и служебные метки:
// `{call_id, tool, args_hash, inputs_hash, engine_version}`. Текста вопроса, значений аргументов, сумм, дат и заметок в записи нет (политика ADR-013
// «журнал вызовов хранит хэши без текстов»); `args_hash` — хэш канонического вида нормализованных аргументов, по нему аргументы не восстановить
// без самого вопроса. Хранить ли аргументы ради повтора расчёта по `call_id` — решение владельца (FP-34, REQ-136): здесь оно не принято, повтора нет.
// Ошибки инструмента (нет Result, нет `call_id`) в журнал не пишутся: чисел без результата не бывает, а текст ошибки мог бы унести значения.
// Экспорт журнала вызовов в CSV (`export_calls_csv`) идёт через `csv_safe_cell` и выводит только эти пять полей плюс `seq` и момент записи.
// Порт `call_day_port` отдаёт инструменту `what_changed` соответствие `call_id → день записи` для аргумента `since = c_<hex>`.
// `changes_view` (исправление FP-20) строит для `what_changed` представление журнала страницы: основание раньше начала журнала — отказ, «с даты» — с начала дня,
// «с прошлого раза» — по порядку записей (подробности — в комментарии перед функцией).
// Зависимости (tests/purity.test.mjs): money, ledger, io, tools; не реэкспортируется из index.mjs, ядро на модуль не ссылается.
// Модуль чистый: ни часов, ни случайности, ни ввода-вывода; идентификатор, `seq` и время записи приходят портами. Расчёт по введённым данным, не консультация.

import { fail } from './money.mjs';
import { canon, sha256, make_event, effective_events } from './ledger.mjs';
import { csv_safe_cell } from './io.mjs';
import { call_id, call_ref, normalize_args, TOOL_NAMES } from './tools.mjs';

/** Тип записи журнала (канон: v2, `EVENT_TYPES` в ledger.mjs). */
export const CALL_EVENT_TYPE = 'assistant.call';

/** Автор записи: ассистент режима A0 (допустимая форма `assistant:<имя>`). */
export const CALL_ACTOR = 'assistant:a0';

/** Поля записи — ровно эти пять; любое другое поле в `payload` отвергается. */
export const CALL_FIELDS = Object.freeze(['call_id', 'tool', 'args_hash', 'inputs_hash', 'engine_version']);

/** Колонки CSV журнала вызовов (порядок фиксирован). */
export const CALL_CSV_COLUMNS = Object.freeze(['seq', 'recorded_at', 'call_id', 'tool', 'args_hash', 'inputs_hash', 'engine_version']);

const HEX8_RE = /^[0-9a-f]{8}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}$/;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const FIELD_OK = Object.freeze({
  call_id: (v) => typeof v === 'string' && HEX8_RE.test(v),
  tool: (v) => typeof v === 'string' && TOOL_NAMES.includes(v),
  args_hash: (v) => typeof v === 'string' && HEX64_RE.test(v),
  inputs_hash: (v) => typeof v === 'string' && HEX64_RE.test(v),
  engine_version: (v) => typeof v === 'string' && VERSION_RE.test(v),
});

const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/**
 * Хэш аргументов вызова: `sha256(canon(normalize_args(args)))`, 64 hex-знака. Те же нормализованные аргументы входят в `call_id`.
 * @param {object} args аргументы вызова инструмента
 * @returns {string}
 * @throws {RunwayError} E_SCHEMA (аргументы не объект), E_NOT_INTEGER (дробное число)
 */
export function args_hash_of(args) {
  if (!is_obj(args)) fail('E_SCHEMA', { reason: 'args_not_object' });
  return sha256(canon(normalize_args(args)));
}

/**
 * Проверить полезную нагрузку записи: ровно пять полей, у каждого допустимая форма (hex, имя инструмента из реестра, версия). Возвращает чистую копию.
 * @param {object} rec
 * @returns {{call_id: string, tool: string, args_hash: string, inputs_hash: string, engine_version: string}}
 * @throws {RunwayError} E_SCHEMA (`reason`: `record_not_object`, `extra_field`, `bad_field`)
 */
export function assert_call_record(rec) {
  if (!is_obj(rec)) fail('E_SCHEMA', { reason: 'record_not_object' });
  for (const k of Object.keys(rec)) if (!CALL_FIELDS.includes(k)) fail('E_SCHEMA', { reason: 'extra_field' });
  const out = {};
  for (const k of CALL_FIELDS) {
    if (!Object.hasOwn(rec, k) || !FIELD_OK[k](rec[k])) fail('E_SCHEMA', { reason: 'bad_field', field: k });
    out[k] = rec[k];
  }
  return out;
}

/**
 * Запись о вызове по результату инструмента и аргументам, с которыми он вызван. `call_id` результата сверяется с пересчитанным по тем же аргументам:
 * чужие аргументы (не те, что дали этот результат) не принимаются.
 * @param {object} result `Result` из `run_tool` (не ошибка)
 * @param {object} args аргументы вызова (до или после нормализации)
 * @returns {{call_id: string, tool: string, args_hash: string, inputs_hash: string, engine_version: string}}
 * @throws {RunwayError} E_SCHEMA (`reason`: `result_not_ok`, `bad_field`, `call_id_mismatch`)
 */
export function call_record(result, args) {
  if (!is_obj(result) || result.isError === true) fail('E_SCHEMA', { reason: 'result_not_ok' });
  const rec = assert_call_record({
    call_id: result.call_id, tool: result.tool, args_hash: args_hash_of(args), inputs_hash: result.inputs_hash, engine_version: result.engine_version,
  });
  if (call_id(rec.tool, normalize_args(args), rec.inputs_hash) !== rec.call_id) fail('E_SCHEMA', { reason: 'call_id_mismatch' });
  return rec;
}

/**
 * Запись журнала `assistant.call` из готовой полезной нагрузки. Идентификатор, `seq` и время приходят портами (движок часов не читает).
 * @param {object} rec результат `call_record`
 * @param {{event_id: string, seq: number, recorded_at: string}} ports
 * @returns {object} LedgerEvent
 */
export function call_event(rec, ports) {
  const clean = assert_call_record(rec);
  if (!is_obj(ports)) fail('E_SCHEMA', { reason: 'ports_required' });
  return make_event(CALL_EVENT_TYPE, clean, {
    event_id: ports.event_id, seq: ports.seq, recorded_at: ports.recorded_at, actor: CALL_ACTOR, entity_id: call_ref(clean.call_id),
  });
}

/**
 * Записать вызов в журнал (`journal.append` из `demo/journal_log.mjs` или любой объект с таким методом). Сбой записи не ломает ответ:
 * исключение превращается в `{ok: false, code}`; в `code` — только код ошибки движка, без значений.
 * @param {{append: (type: string, payload: object, opts?: object) => object}} journal
 * @param {object} result
 * @param {object} args
 * @returns {{ok: true, event: object} | {ok: false, code: string}}
 */
export function record_call(journal, result, args) {
  try {
    const rec = call_record(result, args);
    const event = journal.append(CALL_EVENT_TYPE, rec, { entity_id: call_ref(rec.call_id), actor: CALL_ACTOR });
    return { ok: true, event };
  } catch (e) {
    return { ok: false, code: typeof e?.code === 'string' && /^E_[A-Z_]{1,30}$/.test(e.code) ? e.code : 'E_SCHEMA' };
  }
}

/**
 * Записи о вызовах из журнала: только действующие записи типа `assistant.call` с допустимой формой полезной нагрузки, в порядке журнала.
 * Запись с лишним полем, с недопустимым значением или с моментом не в формате `YYYY-MM-DDTHH:MM:SSZ` пропускается (в CSV и порт не попадает).
 * Откаты (`revert`) учитываются: из журнала берутся только записи вызовов и откаты, остальной журнал (десятки тысяч записей) не разбирается.
 * @param {object[]} events записи журнала (в том числе чужие типы)
 * @returns {{seq: number, recorded_at: string, call_id: string, tool: string, args_hash: string, inputs_hash: string, engine_version: string}[]}
 * @throws {RunwayError} E_SCHEMA (у записи вызова или отката нет `seq`)
 */
export function call_entries(events) {
  const mine = Array.isArray(events) ? events.filter((e) => e !== null && typeof e === 'object' && (e.type === CALL_EVENT_TYPE || e.type === 'revert')) : [];
  const out = [];
  for (const e of effective_events(mine)) {
    if (e.type !== CALL_EVENT_TYPE || typeof e.recorded_at !== 'string' || !INSTANT_RE.test(e.recorded_at)) continue;
    let rec;
    try { rec = assert_call_record(e.payload); } catch { continue; }
    out.push({ seq: e.seq, recorded_at: e.recorded_at, ...rec });
  }
  return out;
}

/**
 * Порт для `what_changed` из готовых записей: `{<hex call_id>: 'YYYY-MM-DD'}` — день последней записи этого вызова (по `recorded_at`, UTC).
 * @param {ReturnType<typeof call_entries>} entries
 * @returns {Object<string, string>}
 */
export function day_port_of(entries) {
  const port = {};
  for (const x of entries) port[x.call_id] = x.recorded_at.slice(0, 10);
  return port;
}

/**
 * Последний вызов из готовых записей (hex без `c_`) или `null`.
 * @param {ReturnType<typeof call_entries>} entries
 * @returns {string|null}
 */
export function last_hex_of(entries) {
  return entries.length === 0 ? null : entries[entries.length - 1].call_id;
}

/**
 * Порт для `what_changed` из журнала: см. `day_port_of`.
 * @param {object[]} events
 * @returns {Object<string, string>}
 */
export function call_day_port(events) {
  return day_port_of(call_entries(events));
}

/**
 * Последний вызов в журнале (hex без `c_`) или `null`.
 * @param {object[]} events
 * @returns {string|null}
 */
export function last_call_hex(events) {
  return last_hex_of(call_entries(events));
}

// ══ «Что изменилось»: представление журнала страницы для инструмента `what_changed` (исправление FP-20) ═══════════════════════
// Инструмент `what_changed` (канон ALG-12) сравнивает `state_at(журнал, день)` — состояние на КОНЕЦ дня — с нынешним. Журнал страницы устроен иначе, чем настоящая история:
//   · при открытии страницы он собирается из рабочей области (`ws_to_events`): все записи набора стоят одним моментом `<as_of>T00:00:00Z` — это снимок «как открыли»,
//     а не история; что было до открытия, журнал не знает;
//   · правки в сеансе и записи вызовов (`assistant.call`) получают настоящие моменты часов страницы.
// Поэтому ответ строится по правилам, которые не выдают снимок за изменения и не теряют правки того же дня:
//   1. Основание раньше начала журнала (`history_start_of`) — отказ `no_history`: сравнивать не с чем (раньше ответ «изменено 40 записей, минимум был 0,00 €» был пустым состоянием).
//   2. Основание-дата D означает «с начала дня D»: записи до начала D и снимок открытия (первые записи с одним моментом) — «до», остальные — «после».
//   3. Основание «с прошлого раза» (`c_<hex>`) считается по порядку записей (`seq`), а не по дню: правка после вызова в тот же день видна.
// Инструмент и его канон не меняются: ему отдаётся ПРЕДСТАВЛЕНИЕ журнала (копии записей с условными моментами «до» и «после»; `event_id`, `seq`, содержимое прежние).

/** Условные моменты представления: всё «до» основания стоит на `BEFORE_STAMP`, всё «после» — на `AFTER_STAMP`. */
const BEFORE_STAMP = '0001-01-01T00:00:00Z';
const AFTER_STAMP = '9999-12-31T00:00:00Z';
const BEFORE_DAY = '0001-01-01';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CALL_REF_RE = /^c_([0-9a-f]{8})$/;

const has_stamp = (e) => e !== null && typeof e === 'object' && typeof e.recorded_at === 'string' && INSTANT_RE.test(e.recorded_at);

/**
 * Первый день журнала: наименьший день `recorded_at` среди записей с допустимым моментом; `null` — записей нет.
 * Для журнала страницы это день снимка открытия (`as_of` рабочей области) либо более ранний день правки, если часы страницы отстают от `as_of`.
 * @param {object[]} events
 * @returns {string|null} `YYYY-MM-DD`
 */
export function history_start_of(events) {
  if (!Array.isArray(events)) return null;
  let first = null;
  for (const e of events) {
    if (!has_stamp(e)) continue;
    const day = e.recorded_at.slice(0, 10);
    if (first === null || day < first) first = day;
  }
  return first;
}

/** Номер `seq` последней записи снимка открытия: самый длинный начальный отрезок журнала (по `seq`) с одним и тем же моментом; `-1` — записей нет. */
function opening_seq_of(events) {
  const sorted = events.filter((e) => has_stamp(e) && Number.isSafeInteger(e.seq)).sort((a, b) => a.seq - b.seq);
  if (sorted.length === 0) return -1;
  let last = sorted[0].seq;
  for (const e of sorted) {
    if (e.recorded_at !== sorted[0].recorded_at) break;
    last = e.seq;
  }
  return last;
}

/**
 * Представление журнала страницы для `what_changed(since)`.
 * @param {object[]} events записи журнала страницы
 * @param {string} since `YYYY-MM-DD` (с начала этого дня) либо `c_<hex>` (после вызова с таким номером)
 * @returns {{ok: true, journal: object[], call_log: Object<string, string>, history_start: string|null}
 *   | {ok: false, reason: 'no_history', history_start: string}}
 *   `journal` и `call_log` подставляются в контекст инструментов на время вызова; неизвестный номер вызова отдаёт журнал как есть (инструмент ответит `since_call_unknown`)
 */
export function changes_view(events, since) {
  if (!Array.isArray(events)) fail('E_SCHEMA', { reason: 'journal_not_array' });
  const history_start = history_start_of(events);
  const restamp = (before) => events.map((e) => (has_stamp(e) ? { ...e, recorded_at: before(e) ? BEFORE_STAMP : AFTER_STAMP } : e));
  if (typeof since === 'string' && DATE_RE.test(since)) {
    if (history_start !== null && since < history_start) return { ok: false, reason: 'no_history', history_start };
    const open = opening_seq_of(events);
    const cut = since + 'T00:00:00';
    return { ok: true, journal: restamp((e) => e.seq <= open || e.recorded_at.slice(0, 19) <= cut), call_log: {}, history_start };
  }
  const m = typeof since === 'string' ? CALL_REF_RE.exec(since) : null;
  if (m === null) return { ok: true, journal: events, call_log: {}, history_start };
  const entries = call_entries(events).filter((x) => x.call_id === m[1]);
  if (entries.length === 0) return { ok: true, journal: events, call_log: {}, history_start };
  const seq = entries[entries.length - 1].seq;
  return { ok: true, journal: restamp((e) => e.seq <= seq), call_log: { [m[1]]: BEFORE_DAY }, history_start };
}

/** Закавычить поле CSV, если нужно (`,`, `"`, LF, CR внутри); `"` удваивается. */
function csv_quote(s) {
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * CSV из готовых записей: колонки `CALL_CSV_COLUMNS`, разделитель `,`, перевод строки LF. Текстовые ячейки проходят `csv_safe_cell` (формульные символы),
 * сырых текстов и аргументов в файле нет — только то, что лежит в записи.
 * @param {ReturnType<typeof call_entries>} entries
 * @returns {string}
 */
export function calls_csv(entries) {
  const lines = [CALL_CSV_COLUMNS.join(',')];
  for (const x of entries) {
    lines.push(CALL_CSV_COLUMNS.map((c) => (c === 'seq' ? String(x.seq) : csv_quote(csv_safe_cell(x[c])))).join(','));
  }
  return lines.join('\n') + '\n';
}

/**
 * CSV журнала вызовов: см. `calls_csv`.
 * @param {object[]} events записи журнала
 * @returns {string}
 */
export function export_calls_csv(events) {
  return calls_csv(call_entries(events));
}
