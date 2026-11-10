// assistant_ext.mjs — ассистент A0: чип происхождения у каждого ответа, «почему» поверх цепочки узкой точки, журнал вызовов (хэши) и примеры новых вопросов (FP-20).
// REQ-132: чип «числа из расчёта c_…» раскрывает режим, версию движка, дату узкой точки и сокращённый `inputs_hash` (`render_origin_chip` из payload_preview.mjs);
//   пометки «ответ ИИ» нет: в A0 языковой модели нет. Рядом с чипом — кнопки «Числа расчёта» (таблица evidence показывает приложение: действие приходит третьим аргументом хука) и «Почему».
// REQ-104: «Почему» у ответа — полная цепочка вкладов узкой точки режима ответа (`narrowest_why` из why_more.mjs: группы, «Остальное», «Поступления», сверка суммы
//   с просадкой), контрфакты, режим, версия движка, сокращённый `inputs_hash` и номер расчёта `c_…` самого ответа.
// REQ-136 (часть без решения владельца): каждый ответ ассистента пишет в журнал страницы запись `assistant.call` ТОЛЬКО с хэшами (engine/call_log.mjs): текста вопроса и
//   значений аргументов в записи нет. Журнал живёт в памяти страницы (как `draft.proposed`), на диск не пишется; повтор расчёта по `call_id` не входит (ждёт решения FP-34).
//   Карточка «Журнал вызовов» показывает последние записи и скачивает CSV (`export_calls_csv`, ячейки через `csv_safe_cell`).
// «Что изменилось с <даты>»: вопрос разбирает engine/verifier.mjs (`parse_ext_intent`), инструмент `what_changed` получает журнал страницы через порты `ask_a0` (хук `assistant`, действие `ports`)
//   в виде `changes_view` (engine/call_log.mjs): основание раньше начала журнала — отказ, «с даты» — с начала дня, «с прошлого раза» — по порядку записей.
// Пояснение допущений ответа (хук `assistant`, действие `note`): какое поступление сдвинуто; чем ограничено сравнение (журнал страницы начинается с даты X); год даты без года.
// Модуль не импортирует app.mjs; узлы строит dom.mjs (текст — textContent). Расчёт по введённым данным и правилам, не консультация.

import { narrowest_point, format_date } from '../engine/index.mjs';
import { LABELS } from '../engine/verifier.mjs';
import { record_call, call_entries, day_port_of, last_hex_of, calls_csv, history_start_of } from '../engine/call_log.mjs';
import { h, table, open_dialog, el_by_id } from './dom.mjs';
import { render_origin_chip } from './payload_preview.mjs';
import { narrowest_why, make_event_namer, render_why_block } from './why_more.mjs';
import { download_text } from './data_view.mjs';
import { make_nf_fmt } from './number_format.mjs';

/** Сколько последних записей журнала вызовов показывает карточка (остальные — только в CSV). */
export const CALLS_SHOWN = 10;

/** Инструменты, чьи числа зависят от изменения «поверх» прогноза (покупка, сдвиг): цепочка «почему» объясняет прогноз без этого изменения. */
export const OVERLAY_TOOLS = Object.freeze(['check_purchase', 'run_scenario']);

const HASH_SHORT = 8;

// ══ 1. Чистые модели ══════════════════════════════════════════════════════════════════════════════════════════════════

/** Результат инструмента в нужной форме (не ошибка, есть evidence, область и хэши). */
export function is_result(r) {
  return r !== null && typeof r === 'object' && r.isError !== true && Array.isArray(r.evidence) && typeof r.call_id === 'string'
    && typeof r.inputs_hash === 'string' && typeof r.engine_version === 'string' && r.scope !== null && typeof r.scope === 'object';
}

/** Режим ответа для чипа и «почему»: режим области результата (`plan` или `worse`). */
export const mode_of_result = (result) => (result.scope.mode === 'plan' ? 'plan' : 'worse');

/**
 * Модель чипа ответа: режим, версия движка и сокращённый `inputs_hash` берутся из самого результата, дата узкой точки — из текущего прогноза в режиме ответа.
 * Если данные изменились после ответа (хэш входов другой), дата узкой точки не показывается: чип не выдаёт нынешний прогноз за прогноз ответа.
 * @param {object} ctx контекст расширений (`tr`, `fmt`)
 * @param {{ctx: object}} model модель страницы
 * @param {object} result `Result` инструмента
 * @param {string} ref `c_…` ответа
 * @returns {{mode: 'plan'|'worse', engine_version: string, narrow: {date: string, amount_minor: number}|null, hash_short: string, ref: string, ai: false, fresh: boolean, rows: {label: string, value: string}[]}}
 */
export function answer_origin(ctx, model, result, ref) {
  const mode = mode_of_result(result);
  const a = model.ctx;
  const fresh = a.inputs_hash === result.inputs_hash;
  const np = fresh ? narrowest_point(a.series[mode], a.as_of, a.horizon_end) : null;
  const rows = [
    { label: ctx.tr('a0ext.chip_tool'), value: result.tool },
    { label: ctx.tr('a0ext.chip_asof'), value: ctx.fmt().date(result.as_of) },
  ];
  if (!fresh) rows.push({ label: ctx.tr('a0ext.chip_state'), value: ctx.tr('a0ext.chip_stale') });
  return {
    mode, engine_version: result.engine_version,
    narrow: np === null || np === undefined ? null : { date: format_date(np.date), amount_minor: np.amount_minor },
    hash_short: result.inputs_hash.slice(0, HASH_SHORT), ref, ai: false, fresh, rows,
  };
}

/**
 * Модель «почему» у ответа: полная цепочка узкой точки режима ответа и контрфакты (первые три «без группы» и «если бы поступление пришло вовремя»).
 * @param {{ctx: object, ws: object}} model
 * @param {object} result
 * @returns {{mode: 'plan'|'worse', fresh: boolean, overlay: boolean, why: ReturnType<typeof narrowest_why>, counterfactuals: object[]}}
 */
export function answer_why_model(model, result) {
  const mode = mode_of_result(result);
  const why = narrowest_why(model, mode);
  const without = why.counterfactuals.filter((c) => c.kind === 'without').slice(0, 3);
  const others = why.counterfactuals.filter((c) => c.kind !== 'without').slice(0, 2);
  return {
    mode, fresh: model.ctx.inputs_hash === result.inputs_hash, overlay: OVERLAY_TOOLS.includes(result.tool),
    why, counterfactuals: [...without, ...others],
  };
}

/**
 * Модель карточки журнала вызовов: число записей, последние `CALLS_SHOWN` (новые сверху) и текст CSV. Журнал, который не сворачивается, даёт пустую модель.
 * @param {object[]} events записи журнала страницы
 * @returns {{count: number, rows: object[], csv: string}}
 */
export function calls_model(events) {
  try {
    const all = call_entries(events);
    return { count: all.length, rows: all.slice(-CALLS_SHOWN).reverse(), csv: calls_csv(all) };
  } catch {
    return { count: 0, rows: [], csv: calls_csv([]) };
  }
}

/**
 * Пояснения допущений к ответу ассистента (хук `assistant`, действие `note`): строки текста, не числа — числа ответа проверяет верификатор.
 *   · «а если сдвинуть платёж»: какое именно ожидаемое поступление сдвинуто (имя из набора данных и дата);
 *   · «что изменилось»: журнал страницы начинается с даты X, правки до открытия страницы в нём не видны; год даты, перенесённой на прошлый год.
 * @param {object} ctx контекст расширений (`get_model`, `get_ws`, `lang`, `tr`, `fmt`)
 * @param {{intent?: string, command?: object, assumed?: object|null, history_start?: string|null}|null|undefined} info разбор вопроса из ответа `ask_a0`
 * @returns {string[]}
 */
export function answer_notes(ctx, info) {
  const out = [];
  if (info === null || typeof info !== 'object') return out;
  const model = ctx.get_model();
  if (model === null || model === undefined) return out;
  const f = ctx.fmt();
  if (info.intent === 'shift') {
    const ref = info.command?.args?.ops?.[0]?.event_ref;
    const ev = typeof ref === 'string' ? model.ctx.events.plan.find((e) => e.cash_event_id === ref) : undefined;
    if (ev !== undefined) out.push(ctx.tr('a0ext.note_shift', { name: make_event_namer(ctx.get_ws(), ctx.lang()).by_id(ref.split('@')[0]), date: f.date(ev.date) }));
  }
  if (info.intent === 'changed') {
    if (typeof info.history_start === 'string') out.push(ctx.tr('a0ext.note_scope', { date: f.date(info.history_start) }));
    const since = info.command?.args?.since;
    if (info.assumed?.year_rolled === true && typeof since === 'string') out.push(ctx.tr('a0ext.note_year', { date: f.short(since) }));
  }
  return out;
}

/**
 * Порты вопроса ассистента (хук `assistant`, действие `ports`): записи журнала страницы для `what_changed`, порт `call_log`, hex предыдущего вызова
 * и запись `assistant.call` (только хэши). `null` — журнала нет (страница без рабочей области). В режиме «только чтение» (`ctx.read_only()`) записи вызовов нет:
 * ответы остаются, журнал страницы не пополняется.
 * @param {object} ctx контекст расширений
 * @param {{paint: (() => void)|null}} view карточка журнала вызовов (перерисовывается после записи)
 * @returns {{journal: object[], call_log: object, last_call: string|null, record?: (result: object, args: object) => object}|null}
 */
export function make_ports(ctx, view) {
  let journal = null;
  try { journal = ctx.journal; } catch { journal = null; }
  if (journal === null || journal === undefined) return null;
  let events = [];
  try { events = journal.events(); } catch { return null; }
  let call_log = {};
  let last_call = null;
  try { const entries = call_entries(events); call_log = day_port_of(entries); last_call = last_hex_of(entries); } catch { call_log = {}; last_call = null; }
  const read_only = typeof ctx.read_only === 'function' && ctx.read_only() !== null;
  const record = (result, args) => {
    const r = record_call(journal, result, args);
    if (view !== null && typeof view.paint === 'function') view.paint();
    return r;
  };
  return { journal: events, call_log, last_call, ...(read_only ? {} : { record }) };
}

// ══ 2. DOM ════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** Подпись режима по словарю §2.0. */
const mode_text = (ctx, m) => LABELS.modes[ctx.lang()]?.[m] ?? m;

/** Диалог «Почему» у ответа: цепочка вкладов (поверх `narrowest_why`), контрфакты, режим, версия движка, сокращённый `inputs_hash`, номер расчёта ответа. */
export function open_answer_why(ctx, result, ref) {
  const model = ctx.get_model();
  if (model === null || model === undefined) return;
  const f = ctx.fmt();
  const m = answer_why_model(model, result);
  const mode = m.mode;
  const w = m.why;
  const namer = make_event_namer(ctx.get_ws(), ctx.lang());
  const cf_rows = m.counterfactuals.map((c) => h('tr', null,
    h('th', { scope: 'row', text: c.kind === 'without' ? ctx.tr('wy.without', { name: namer.group(c.group) }) : ctx.tr('wy.no_delay', { name: namer.by_id(String(c.event_id).split('@')[0]) }) }),
    h('td', { class: 'num', text: f.money(c.new_min.amount_minor) + ' · ' + f.short(c.new_min.date) }),
    h('td', { class: 'num', text: '+' + f.money(c.delta_minor) })));
  const chain = w.empty ? null : render_why_block(ctx, mode);
  open_dialog(ctx.tr('wy.title', { value: f.money(w.point.amount_minor), date: f.date(w.point.date) }), ctx.tr('c.close'),
    h('p', { class: 'muted', text: ctx.tr('wy.mode', { mode: mode_text(ctx, mode) }) + ' · ' + ctx.tr('a0ext.why_answer', { ref, tool: result.tool }) }),
    m.overlay ? h('p', { class: 'muted', text: ctx.tr('a0ext.why_overlay') }) : null,
    m.fresh ? null : h('p', { class: 'banner short', role: 'status', text: ctx.tr('a0ext.why_stale') }),
    w.empty ? h('p', { text: ctx.tr('wy.empty') })
      : h('p', { text: ctx.tr('wy.peak', { value: f.money(w.peak.amount_minor), date: f.date(w.peak.date), drop: f.money(w.drop_minor) }) }),
    chain,
    cf_rows.length === 0 ? null : h('section', { class: 'a0-cf' },
      h('h3', { text: ctx.tr('wy.counter') }),
      table(ctx.tr('wy.counter'), [ctx.tr('c.name'), ctx.tr('wy.col_new_min'), ctx.tr('wy.col_delta')], cf_rows)),
    h('p', { class: 'muted', text: ctx.tr('wy.footer', { ref, version: result.engine_version, hash: result.inputs_hash.slice(0, HASH_SHORT) }) }));
}

/**
 * Чип происхождения ответа: `render_origin_chip` (режим, версия движка, дата узкой точки, хэш) и кнопки «Числа расчёта» и «Почему». В A0 пометки «ответ ИИ» нет.
 * @param {object} ctx
 * @param {object} result `Result` ответа
 * @param {string} ref `c_…`
 * @param {(() => void)|undefined} open_numbers действие «Числа расчёта» (таблица evidence, её показывает приложение); без него кнопки «Числа расчёта» нет
 * @returns {HTMLElement|null} `null` — прогноза или результата нет: приложение покажет прежнюю кнопку
 */
export function render_answer_chip(ctx, result, ref, open_numbers) {
  const model = ctx.get_model();
  if (model === null || model === undefined || !is_result(result) || typeof ref !== 'string') return null;
  const om = answer_origin(ctx, model, result, ref);
  return h('span', { class: 'a0-origin', 'data-ref': ref },
    render_origin_chip(ctx, om),
    h('span', { class: 'a0-actions' },
      typeof open_numbers === 'function' ? h('button', { type: 'button', class: 'btn a0-numbers', title: ctx.tr('c.chip_hint'), onclick: () => open_numbers(), text: ctx.tr('a0ext.btn_numbers') }) : null,
      h('button', { type: 'button', class: 'btn a0-why', 'aria-label': ctx.tr('a0ext.why_aria', { ref }), onclick: () => open_answer_why(ctx, result, ref), text: ctx.tr('ov.why') })));
}

/** Имя файла CSV журнала вызовов: день расчёта в имени, как у остальных выгрузок. */
export function calls_file_name(as_of_iso) {
  return 'runway-assistant-calls-' + (typeof as_of_iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(as_of_iso) ? as_of_iso : 'unknown') + '.csv';
}

/**
 * Карточка «Журнал вызовов» (слот `assistant.extras`): сколько вызовов записано, последние записи (только хэши) и кнопка «Скачать CSV».
 * Карточка сама перерисовывается после записи вызова (`view.paint`); перерисовка идёт синхронно в обработчике вопроса, без таймеров.
 * @param {object} ctx
 * @param {{paint: (() => void)|null}} view
 * @returns {HTMLElement}
 */
export function render_calls_card(ctx, view) {
  const summary = h('p', { role: 'status' });
  const body = h('tbody', null);
  const csv_btn = h('button', { type: 'button', class: 'btn', id: 'a0-calls-csv', text: ctx.tr('a0ext.csv_btn') });
  let csv_text = '';
  let shown = 0;
  const paint = () => {
    let events = [];
    try { events = ctx.journal?.events() ?? []; } catch { events = []; }
    const m = calls_model(events);
    csv_text = m.csv;
    shown = m.count;
    summary.textContent = m.count === 0 ? ctx.tr('a0ext.calls_none') : ctx.tr('a0ext.calls_count', { n: m.count });
    body.replaceChildren(...m.rows.map((x) => h('tr', null,
      h('th', { scope: 'row', text: 'c_' + x.call_id }), h('td', { text: x.tool }),
      h('td', { class: 'num', text: x.args_hash.slice(0, HASH_SHORT) }), h('td', { class: 'num', text: x.inputs_hash.slice(0, HASH_SHORT) }), h('td', { text: x.engine_version }))));
    if (m.count === 0) csv_btn.setAttribute('disabled', ''); else csv_btn.removeAttribute('disabled');
  };
  csv_btn.addEventListener('click', () => {
    if (shown === 0) return;
    const ws = ctx.get_ws();
    download_text(calls_file_name(typeof ws?.as_of === 'string' ? ws.as_of : null), csv_text, 'text/csv');
    ctx.notify(ctx.tr('a0ext.csv_done'), 'info');
  });
  view.paint = paint;
  paint();
  return h('section', { class: 'card a0-calls', 'aria-labelledby': 'a0-calls-h' },
    h('h3', { id: 'a0-calls-h', text: ctx.tr('a0ext.calls_title') }),
    h('p', { class: 'muted', text: ctx.tr('a0ext.calls_lead') }),
    summary,
    h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('caption', { class: 'sr-only', text: ctx.tr('a0ext.calls_title') }),
      h('thead', null, h('tr', null, ['a0ext.col_ref', 'a0ext.col_tool', 'a0ext.col_args', 'a0ext.col_inputs', 'a0ext.col_engine'].map((k) => h('th', { scope: 'col', text: ctx.tr(k) })))),
      body)),
    h('div', { class: 'actions' }, csv_btn),
    h('p', { class: 'muted', text: ctx.tr('a0ext.calls_note') }));
}

/**
 * Примеры новых вопросов по-русски и по-английски в форме, которую разбирает ассистент. Дата «что изменилось с …» — день, с которого журнал страницы можно сравнивать (его первый день,
 * для страницы без журнала — день расчёта): более ранняя дата получила бы отказ `no_history`.
 * @param {object} ctx
 * @param {string} since_iso `YYYY-MM-DD`
 * @returns {string[]}
 */
export function example_questions(ctx, since_iso) {
  const when = make_nf_fmt(ctx.lang(), 'EUR', since_iso, null).date(since_iso); // язык по умолчанию: формат пользователя поле вопроса не разбирает
  return [ctx.tr('a0ext.ex_changed', { date: when }), ctx.tr('a0ext.ex_shift'), ctx.tr('a0ext.ex_reserve')];
}

/**
 * Карточка «Новые вопросы» (слот `assistant.extras`): примеры, которые подставляются в поле вопроса.
 * @param {object} ctx
 * @returns {HTMLElement|null}
 */
export function render_examples_card(ctx) {
  const model = ctx.get_model();
  if (model === null || model === undefined) return null;
  let events = [];
  try { events = ctx.journal?.events() ?? []; } catch { events = []; }
  const list = example_questions(ctx, history_start_of(events) ?? format_date(model.ctx.as_of));
  const put = (text) => {
    const input = el_by_id('as-q');
    if (input === null) return;
    input.value = text;
    if (typeof input.focus === 'function') input.focus();
  };
  return h('section', { class: 'card a0-examples', 'aria-labelledby': 'a0-ex-h' },
    h('h3', { id: 'a0-ex-h', text: ctx.tr('a0ext.ex_title') }),
    h('p', { class: 'muted', text: ctx.tr('a0ext.ex_lead') }),
    h('div', { class: 'chips' }, list.map((text) => h('button', { type: 'button', class: 'chip', onclick: () => put(text), text }))));
}
