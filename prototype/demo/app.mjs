// app.mjs — демо-интерфейс Runway: одна страница, чистый JS, без зависимостей и CDN (REQ-109, ux-screens, ADR-006).
// Расчёт идёт в этой странице: движок `../engine/*.mjs` (analyze, инструменты, верификатор) вызывается напрямую; сеть нужна только
// для чтения набора данных `../data/g001*.json` с того же хоста. FP-21: модель набора при загрузке и импорте, «деньги после покупки» и списки волн могут считаться в Web Worker
// (calc_async.mjs) с откатом на главный поток; запись через формы проверяется и считается на месте. Ассистент A0 — простые правила разбора + инструмент движка + шаблон
// каталога верификатора (без LLM): число в текст ответа попадает только из результата инструмента.
//
// Структура файла:
//   1. Форматирование (render_value верификатора: числа и даты по локали).
//   2. Модель расчёта: `build_model` (рабочая область → контекст движка) и чистые модели экранов (без DOM; их проверяет tests/demo.test.mjs).
//   3. Разбор вопросов ассистента A0 (`parse_assistant_command`, `ask_a0`).
//   4. DOM-слой: построители `h`/`s`, экраны, диалоги, загрузка/выгрузка, запуск `boot`.
// Модуль можно импортировать в Node без побочных эффектов (DOM не трогается, пока не вызван `boot`). Тексты интерфейса — только из i18n.mjs;
// данные пользователя попадают в страницу только через textContent и атрибуты. Расчёт по введённым данным и правилам, не консультация.

import {
  analyze, ENGINE_VERSION, narrowest_point, answer_q1, explain_narrowest, default_sts_horizon, safe_to_spend, sts_breakdown,
  list_waves_ex, next_income_day, next_release, reserve_open, parse_date, format_date, to_epoch_day, civil_from_days, days_from_civil, dow,
  parse_minor, format_minor, currency_exponent,
} from '../engine/index.mjs';
import { make_tool_ctx, run_tool, call_ref, cause_class_of } from '../engine/tools.mjs';
import { is_ext_warning, ext_warning_text } from '../engine/warnings_ext.mjs';
import { a0_answer, render_value, LABELS, parse_ext_intent } from '../engine/verifier.mjs';
import { changes_view } from '../engine/call_log.mjs'; // FP-20: представление журнала страницы для «что изменилось» (основание раньше журнала — отказ; «с даты» — с начала дня; «с прошлого раза» — по порядку записей)
import { LANGS, DEFAULT_LANG, MONTHS_SHORT, MONTHS_FULL, WEEKDAYS_SHORT, DATASETS, STRINGS, t, label_of, word_form } from './i18n.mjs';
import { ext } from './ext.mjs';
import { review_date, oldest_review_date, reserve_off_since, free_masked_since } from './rule_age.mjs';
import { open_foreign, quarantine_notice, refused_notice, quarantine_node } from './open_quarantine.mjs'; // FP-22: чужой файл — разбор, проверка, карантин записей (REQ-158, Q-22)
import { make_env, fx_by_event, rate_uses, chip_node, answer_note_text, money_in, wave_line_text, dedupe_fx, balance_fx, balance_note_text, note_node } from './rate_chip.mjs'; // FP-16: подпись курса и возраста у пересчитанной суммы
import { rate_stale_text, no_rate_text } from './banner_texts.mjs'; // FP-16: плашка «курс устарел» и сообщение «нет курса» (валюта, возраст, путь к вводу)
import { spoken_date, spoken_money } from './speech.mjs'; // FP-26 (REQ-167): фраза для скринридера — дата и сумма словами
import { group_nav, nav_keep_focus, keep_focus_after_render } from './nav_more.mjs'; // FP-26 (U22): на телефоне разделы за первыми четырьмя уходят в группу «Ещё»; хранитель фокуса для кнопок сценария
import { skeleton_nodes, mark_busy } from './skeleton.mjs'; // FP-26 (U40): скелет загрузки и aria-busy на #main
import { nearest_income, first_below } from './shortage.mjs'; // FP-28 (REQ-046): ближайшее ожидаемое поступление и первая дата нарушения буфера в сообщениях о нехватке
import { calc, ctx_from_analysis, SUPERSEDED } from './calc_async.mjs'; // FP-21 (REQ-150): «Обзор», «Купить» и «Волны» считают в Worker с откатом на главный поток; готовый расчёт берёт build_model

/** Режимы расчёта v1 (D-04). */
export const MODES = Object.freeze(['plan', 'worse']);

/** Сколько дней факта слева от «шва сегодня» показывает график. */
export const PAST_DAYS = 14;

/** Сколько последних фактов показывает «Лента» (остальные — в «Сверке», список «Все факты»; усечение оговорено на экране, FP-28). */
export const FEED_PAST_LIMIT = 8;

/** Предел размера загружаемого файла состояния (REQ-091: отказ до разбора). */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 1. Форматирование
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Форматтеры интерфейса для языка, валюты решения и даты расчёта. Числа и даты — через `render_value` верификатора,
 * поэтому совпадают с текстами ассистента (минус U+2212, NBSP, «€» по правилам языка).
 * @param {'ru'|'en'} lang
 * @param {string} cur код валюты решения
 * @param {string} as_of_iso дата расчёта `YYYY-MM-DD` (год даты показывается, только если он отличается)
 * @returns {{money: Function, money0: Function, date: Function, short: Function, pm: Function, bp: Function, days: Function, exp: number}}
 */
export function make_fmt(lang, cur, as_of_iso) {
  const exp = currency_exponent(cur);
  const iso_of = (x) => (typeof x === 'number' ? format_date(x) : x);
  const money = (v) => render_value({ kind: 'money', v, cur, dp: exp }, lang, as_of_iso);
  const money0 = (v) => render_value({ kind: 'money', v, cur, dp: 0 }, lang, as_of_iso);
  const date = (x) => render_value({ kind: 'date', v: iso_of(x) }, lang, as_of_iso);
  const short = (x) => {
    const iso = iso_of(x);
    const y = Number(iso.slice(0, 4));
    const m = Number(iso.slice(5, 7));
    const d = Number(iso.slice(8, 10));
    const mon = MONTHS_SHORT[lang][m - 1];
    const tail = String(y) === as_of_iso.slice(0, 4) ? '' : (lang === 'ru' ? ' ' : ', ') + y;
    return (lang === 'ru' ? d + ' ' + mon : mon + ' ' + d) + tail;
  };
  // Покрытие волны (промилле): всегда один знак дроби, как в UX («170,0 %», «154,3 %»); без float — целочисленное деление.
  const pm = (v) => (v < 0 ? '−' : '') + Math.floor(Math.abs(v) / 10) + (lang === 'ru' ? ',' : '.') + (Math.abs(v) % 10) + ' %';
  const bp = (v) => render_value({ kind: 'pct_bp', v }, lang, as_of_iso);
  const days = (n) => n + ' ' + word_form(lang, 'day', n);
  return { money, money0, date, short, pm, bp, days, exp };
}

/**
 * Разобрать сумму без float в minor units: пробелы (в т. ч. NBSP) игнорируются, десятичный знак — `,` или `.`
 * (последний из двух; единственный разделитель — дробь, если после него 1…exp цифр, иначе — группы тысяч по три цифры).
 * Знак не допускается. Нецелое число знаков дроби, мусор, ноль и отрицательные — `null`.
 * @param {string} str
 * @param {number} [exponent] знаков дроби валюты
 * @returns {number|null} положительная сумма в minor units
 */
export function parse_amount_lenient(str, exponent = 2) {
  const s = String(str ?? '').replace(/[\s  ]/g, '');
  if (!/^\d[\d.,]*$/.test(s)) return null;
  const dot = s.lastIndexOf('.');
  const com = s.lastIndexOf(',');
  let decimal = '.';
  let thousands = '';
  if (dot >= 0 && com >= 0) {
    decimal = dot > com ? '.' : ',';
    thousands = decimal === '.' ? ',' : '.';
  } else if (dot >= 0 || com >= 0) {
    const sep = dot >= 0 ? '.' : ',';
    const parts = s.split(sep);
    const tail = parts[parts.length - 1];
    if (parts.length === 2 && tail.length >= 1 && tail.length <= exponent) {
      decimal = sep;
    } else if (parts.slice(1).every((p) => p.length === 3)) {
      thousands = sep;
      decimal = sep === '.' ? ',' : '.';
    } else return null;
  }
  try {
    const v = parse_minor(s, { decimal, thousands, exponent });
    return v > 0 ? v : null;
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 2. Модель расчёта и чистые модели экранов
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Построить модель расчёта: контекст инструментов поверх `analyze` (сценарий — гипотеза поверх данных, в `ws` не пишется).
 * @param {object} ws рабочая область (формат `runway-journal/1`, как в data/g001.json)
 * @param {{scenario?: {ops: object[]}|null, lang?: 'ru'|'en'}} [opts]
 * @returns {{ws: object, ctx: object, scenario: object|null, cur: string, as_of_iso: string}}
 * @throws {RunwayError} E_SCHEMA и прочие коды движка
 */
export function build_model(ws, opts = {}) {
  const query = { as_of: ws.as_of };
  const scenario = opts.scenario ?? null;
  if (scenario !== null) query.scenario = { ops: scenario.ops };
  const env = { locale: opts.lang ?? ws.locale ?? DEFAULT_LANG };
  const ready = calc.take(ws, query); // FP-21: расчёт, который Worker уже сделал для этой рабочей области и этого запроса (отдаётся один раз); нет его — считаем на месте
  const ctx = ready === null ? make_tool_ctx(ws, query, env) : ctx_from_analysis(ready, ws, query, env);
  return { ws, ctx, scenario, cur: ctx.decision_currency, as_of_iso: format_date(ctx.as_of) };
}

/** Число дней горизонта (включая день расчёта). */
export function horizon_days_of(model) {
  return model.ctx.series.plan.close.length;
}

/**
 * Горизонт в днях ВПЕРЁД от даты расчёта (FP-48): то число, которое вводят в «Настройках» (`horizon_days`) и которое называют шапка, «Запас хода» и лист для печати.
 * Строк в ряду на одну больше (`horizon_days_of`): в нём есть и сам день расчёта; подпись «57 дней, до 30 ноября» и «Сейчас задано: 57 дней» поэтому сходятся.
 */
export function horizon_ahead_of(model) {
  return Math.max(0, horizon_days_of(model) - 1);
}

/**
 * Имя события для людей: подпись из словаря данных по `rule_id`/`stream_id`/id плана или тегу, иначе имя из рабочей области, иначе тег.
 * @param {object} ws
 * @param {'ru'|'en'} lang
 * @returns {(e: object) => string}
 */
export function make_namer(ws, lang) {
  const names = new Map();
  for (const x of ws.rules ?? []) names.set(x.rule_id, x.name);
  for (const x of ws.plans ?? []) names.set(x.plan_id, x.name);
  for (const x of ws.streams ?? []) names.set(x.stream_id, x.name);
  for (const x of ws.debts ?? []) if (typeof x?.name === 'string' && x.name !== '') names.set(x.debt_id, x.name); // платежи записанного долга (FP-14) — под его названием
  const by_id = (id) => label_of(lang, id, names.get(id) ?? id);
  const namer = (e) => {
    const key = e.rule_id ?? e.stream_id ?? (e.layer === 'posted' ? null : String(e.cash_event_id ?? '').split('@')[0]);
    if (key !== null && key !== undefined && key !== '' && (names.has(key) || Object.hasOwn(NAMED, key))) return by_id(key);
    if (typeof e.tag === 'string' && e.tag !== '') return label_of(lang, e.tag, e.tag);
    return by_id(String(e.cash_event_id ?? e.event_id ?? '').split('@')[0]);
  };
  namer.by_id = by_id;
  namer.group = (g) => (g.startsWith('tag:') ? label_of(lang, g.slice(4), g.slice(4)) : by_id(g));
  return namer;
}

const NAMED = Object.freeze({ 'R-RENT': 1, 'R-UTIL': 1, 'R-PHONE': 1, 'R-GROC': 1, 'P-TAX1': 1, 'P-X': 1, 'S-HOURLY': 1 });

/**
 * Ряд факта до дня расчёта: остаток на конец дня за `PAST_DAYS` дней, восстановленный назад от опорного остатка по фактам.
 * Только когда это однозначно: один операционный счёт, факты в валюте решения, нет фактов на день расчёта и позже.
 * @param {{ws: object, ctx: object}} model
 * @returns {{d: number, v: number}[]} по возрастанию даты; пусто, если восстановить нельзя
 */
export function past_series(model) {
  const { ws, ctx } = model;
  const facts = ws.facts ?? [];
  const operating = (ws.accounts ?? []).filter((a) => a.liquidity === 'operating');
  if (operating.length !== 1 || facts.length === 0) return [];
  const today = format_date(ctx.as_of);
  if (facts.some((f) => f.currency !== ctx.decision_currency || f.account_id !== operating[0].account_id || f.date >= today)) return [];
  const by_day = new Map();
  for (const f of facts) {
    const d = parse_date(f.date);
    by_day.set(d, (by_day.get(d) ?? 0) + f.amount_minor);
  }
  const out = [];
  let v = ctx.series.plan.opening_minor;
  for (let d = ctx.as_of - 1; d >= ctx.as_of - PAST_DAYS; d--) {
    out.push({ d, v });
    v -= by_day.get(d) ?? 0;
  }
  return out.reverse();
}

/**
 * «Красивые» значения оси Y: шаг 1·2·5·10^k целых денежных единиц, границы кратны шагу.
 * @param {number} vmin минимум в minor units
 * @param {number} vmax максимум в minor units
 * @param {number} exp знаков дроби валюты
 * @param {number} [target] желаемое число делений
 * @returns {{ticks: number[], lo: number, hi: number}} значения в minor units
 */
export function nice_ticks(vmin, vmax, exp, target = 5) {
  const unit = 10 ** exp;
  const lo = Math.floor(vmin / unit);
  const hi = Math.ceil(vmax / unit);
  const span = Math.max(hi - lo, 1);
  const raw = span / target;
  const mag = 10 ** Math.max(0, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const start = Math.floor(lo / step) * step;
  const end = Math.max(Math.ceil(hi / step) * step, start + step); // минимум два деления даже у вырожденного диапазона
  const ticks = [];
  for (let v = start; v <= end; v += step) ticks.push(v * unit + 0);
  return { ticks, lo: start * unit + 0, hi: end * unit + 0 };
}

/**
 * Геометрия графика остатка (без DOM): пути `plan`/`worse` для `trough` и `close`, факт слева от «шва сегодня», линия буфера,
 * нуль, штриховка волн, узкие точки, подписи осей. Координаты — в пикселях видового окна `w × h`.
 * @param {{ws: object, ctx: object}} model
 * @param {'plan'|'worse'} mode режим, чья волновая разметка и узкая точка выделяются
 * @param {{w?: number, h?: number}} [size]
 * @returns {object}
 */
export function chart_model(model, mode, size = {}) {
  const a = model.ctx;
  const w = size.w ?? 760;
  const h = size.h ?? 340;
  const exp = currency_exponent(a.decision_currency);
  const margin = { l: w < 480 ? 54 : 66, r: 14, t: 24, b: 30 };
  const plot = { x0: margin.l, x1: w - margin.r, y0: margin.t, y1: h - margin.b };
  const past = past_series(model);
  const first = past.length > 0 ? past[0].d : a.as_of;
  const last = a.horizon_end;
  const span = Math.max(last - first, 1);
  const x = (d) => plot.x0 + ((d - first) * (plot.x1 - plot.x0)) / span;
  const B = a.buffer_minor;
  const vals = [0];
  for (const m of MODES) vals.push(...a.series[m].close, ...a.series[m].trough);
  for (const p of past) vals.push(p.v);
  if (B !== null) vals.push(B);
  const scale = nice_ticks(Math.min(...vals), Math.max(...vals), exp);
  const y = (v) => plot.y1 - ((v - scale.lo) * (plot.y1 - plot.y0)) / Math.max(scale.hi - scale.lo, 1);
  const path = (pts) => 'M' + pts.map(([px, py]) => px.toFixed(1) + ' ' + py.toFixed(1)).join('L');
  const series_path = (m, key) => path(a.series[m][key].map((v, i) => [x(a.series[m].from + i), y(v)]));
  const narrow = {};
  for (const m of MODES) {
    const np = narrowest_point(a.series[m], a.as_of, a.horizon_end);
    narrow[m] = { d: np.date, v: np.amount_minor, x: x(np.date), y: y(np.amount_minor) };
  }
  const waves = list_waves_ex(a, mode).items.map((it, i) => ({
    n: i + 1, start: it.wave.start, end: it.wave.end, x: x(it.wave.start - 0.5), w: x(it.wave.end + 0.5) - x(it.wave.start - 0.5),
  }));
  const xticks = [];
  for (let d = a.as_of - Math.floor((a.as_of - first) / 14) * 14; d <= last; d += 14) xticks.push({ d, x: x(d) });
  return {
    w, h, plot, first, last, exp, x, y, scale,
    paths: {
      plan_trough: series_path('plan', 'trough'), plan_close: series_path('plan', 'close'),
      worse_trough: series_path('worse', 'trough'), worse_close: series_path('worse', 'close'),
      past: past.length > 0 ? path(past.map((p) => [x(p.d), y(p.v)])) : null,
    },
    buffer: B === null ? null : { v: B, y: y(B) },
    zero: { y: y(0) },
    today_x: x(a.as_of),
    narrow, waves, xticks,
    yticks: scale.ticks.map((v) => ({ v, y: y(v) })),
    past_count: past.length,
  };
}

/**
 * Строки «Таблицы значений» — все дни горизонта: остаток на конец дня, минимум дня и свободные деньги по двум режимам.
 * @param {{ctx: object}} model
 * @returns {{i: number, d: number, plan: object, worse: object, wave: number|null, narrow: string[]}[]}
 */
export function table_rows(model) {
  const a = model.ctx;
  const wave_of = new Map();
  list_waves_ex(a, 'plan').items.forEach((it, k) => {
    for (let d = it.wave.start; d <= it.wave.end; d++) wave_of.set(d, k + 1);
  });
  const nar = {};
  for (const m of MODES) nar[m] = narrowest_point(a.series[m], a.as_of, a.horizon_end).date;
  const rows = [];
  for (let i = 0; i < horizon_days_of(model); i++) {
    const d = a.series.plan.from + i;
    const row = { i, d, wave: wave_of.get(d) ?? null, narrow: MODES.filter((m) => nar[m] === d) };
    for (const m of MODES) row[m] = { close: a.series[m].close[i], trough: a.series[m].trough[i], free: a.series[m].free[i] };
    rows.push(row);
  }
  return rows;
}

/**
 * Числа обзора: узкая точка, Q1 на дату `D`, «можно потратить» до даты `T` по двум режимам (D-12, D-13).
 * @param {{ctx: object}} model
 * @param {{D?: string|number, T?: string|number}} [opts] даты вопросов (по умолчанию конец горизонта и `default_sts_horizon`)
 * @returns {object}
 */
export function overview_model(model, opts = {}) {
  const a = model.ctx;
  const B = a.buffer_minor;
  const D = opts.D === undefined || opts.D === null ? a.horizon_end : to_epoch_day(opts.D);
  const T0 = opts.T === undefined || opts.T === null ? default_sts_horizon(a) : to_epoch_day(opts.T);
  const T = Math.min(Math.max(T0, a.as_of), a.horizon_end);
  const per_mode = {};
  for (const m of MODES) {
    const s = a.series[m];
    const narrow = narrowest_point(s, a.as_of, a.horizon_end);
    const q1 = answer_q1(s, D, B);
    const q1_first = q1.beyond_horizon === true || q1.first_breach === null ? null : { date: q1.first_breach, amount_minor: s.trough[q1.first_breach - s.from] };
    const sts = safe_to_spend(a, T, null, m);
    const gated = sts.kind === 'insufficient_data';
    const min_free_h = Math.min(...s.free);
    per_mode[m] = {
      narrow, q1, q1_first, sts, gated,
      reserve_at_min: gated ? null : s.reserve_trough[sts.at - s.from],
      short_horizon: B === null ? null : Math.max(0, B - min_free_h),
      min_free_h,
      min_free_h_at: a.as_of + s.free.indexOf(min_free_h), // первая дата минимума свободных денег на горизонте (от неё считается «ближайшее поступление» в сообщении о нехватке, REQ-046)
      free_first_below: first_below(s.free, a.as_of, B, T), // REQ-046: первая дата `free < B` до даты T («не хватает до буфера (с учётом резервов)»)
      free_first_below_h: first_below(s.free, a.as_of, B), // то же на всём горизонте (строка «до конца горизонта»)
    };
  }
  return { as_of: a.as_of, horizon_end: a.horizon_end, D, T, B, opening: a.series.plan.opening_minor, reserve_now: a.series.plan.reserve_opening_minor, per_mode };
}

/**
 * Разложение «можно потратить» (REQ-057) на дату `T` в режиме `mode`.
 * @param {{ctx: object}} model
 * @param {number} T EpochDay
 * @param {'plan'|'worse'} mode
 * @returns {{rows: {id: string, v: number}[], total: number, min_free: number}|null} `null` — гейт не пропустил
 */
export function sts_model(model, T, mode) {
  const a = model.ctx;
  const sts = safe_to_spend(a, T, null, mode);
  if (sts.kind === 'insufficient_data') return null;
  const rows = sts_breakdown(a, T, null, mode);
  return { rows, total: rows.reduce((acc, r) => acc + r.v, 0), min_free: sts.min_free };
}

/**
 * Модель «Почему» (REQ-030, 104): пик до точки, цепочка вкладов и контрфакты — всё считает движок.
 * @param {{ws: object, ctx: object}} model
 * @param {'plan'|'worse'} mode
 * @param {'ru'|'en'} [lang] язык подписей групп
 * @returns {{empty: boolean, point: object, peak: object, chain: object[], counterfactuals: object[], ref: string|null}}
 */
export function explain_model(model, mode, lang = DEFAULT_LANG) {
  const a = model.ctx;
  const namer = make_namer(model.ws, lang);
  const ex = explain_narrowest(a.events[mode], a.series[mode], a.params);
  const reserve_kinds = {};
  for (const r of model.ws.reserves ?? []) reserve_kinds[r.reserve_id] = r.kind;
  const by_id = new Map(a.events[mode].map((e) => [e.cash_event_id, e]));
  const fx_of = fx_by_event(model.ws, a, a.events[mode]); // FP-16: суммы, пересчитанные по курсу, несут подпись курса и возраста
  const chain = ex.chain.map((g) => {
    const e = by_id.get(g.event_ids[0]);
    const fx = dedupe_fx(g.event_ids.map((id) => fx_of.get(id)).filter((x) => x !== undefined)); // «Подписка × 4» — одна подпись, а не четыре одинаковые (дефект D2)
    return { ...g, cause: e === undefined ? 'other' : cause_class_of(e, { as_of: a.as_of, reserve_kinds }), name: e === undefined ? namer.group(g.group) : namer(e), ...(fx.length === 0 ? {} : { fx }) };
  });
  const counterfactuals = ex.counterfactuals.map((c) => {
    if (c.kind === 'without') {
      const g = chain.find((x) => x.group === c.group);
      return { ...c, name: g?.name ?? namer.group(c.group), ...(g?.fx === undefined ? {} : { fx: g.fx }) };
    }
    const e = by_id.get(c.event_id);
    return { ...c, name: e === undefined ? namer.by_id(String(c.event_id).split('@')[0]) : namer(e), ...(fx_of.has(c.event_id) ? { fx: [fx_of.get(c.event_id)] } : {}) };
  });
  a.calls_used = 0;
  const r = run_tool('explain_min_point', { mode }, a);
  return {
    empty: chain.length === 0, point: ex.point, peak: ex.peak, chain, counterfactuals,
    ref: r.isError === true ? null : call_ref(r.call_id),
  };
}

/** Значение evidence результата инструмента по ссылке `eN` (или `null`). */
export function ev_of(result, id) {
  if (id === null || id === undefined) return null;
  return result.evidence.find((e) => e.id === id) ?? null;
}

/**
 * Физические деньги после покупки: узкая точка `trough` по режимам при гипотезе «покупка» поверх текущей модели (§9.6: 175500 · 10-31 и 153000 · 11-14).
 * @param {{ws: object, scenario: {ops: object[]}|null}} model
 * @param {{date: string, amount_minor: number}[]} parts части покупки
 * @returns {{plan: {v: number, d: number}, worse: {v: number, d: number}}|null} `null` — пересчёт не удался
 */
export function cash_after(model, parts) {
  try {
    const ops = [...(model.scenario?.ops ?? []), { op: 'add_purchase', parts }];
    const m2 = build_model(model.ws, { scenario: { ops } });
    const out = {};
    for (const mode of MODES) {
      const np = narrowest_point(m2.ctx.series[mode], m2.ctx.as_of, m2.ctx.horizon_end);
      out[mode] = { v: np.amount_minor, d: np.date };
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Запустить «Могу ли я это купить?» (D-11): инструмент `check_purchase` через A0 — вердикт, минимум свободных после покупки,
 * максимум на дату, самая ранняя дата, флаги, «за горизонтом»; текст ответа — шаблон каталога верификатора.
 * @param {{ctx: object}} model
 * @param {{date: string, amount_minor: number, parts?: {date: string, amount_minor: number}[]}} input
 * @param {'ru'|'en'} lang
 * @param {{cash_after: object|null}|null} [ready] деньги после покупки, уже посчитанные в Worker (FP-21, операция afford); без них — `cash_after` на месте
 * @returns {{ok: boolean, code?: string, text: string, result?: object, view?: object, ref?: string}}
 */
export function buy_run(model, input, lang, ready = null) {
  const a = model.ctx;
  const args = { date: input.date, amount_minor: input.amount_minor, currency: a.decision_currency };
  if (input.parts !== undefined && input.parts !== null) args.parts = input.parts;
  a.calls_used = 0;
  const r = a0_answer({ name: 'check_purchase', args }, a, { locale: lang, number_format: model.ws.number_format }); // формат чисел и дат пользователя (REQ-112, FP-16)
  if (!r.ok) return { ok: false, code: r.error.code, text: r.text };
  const f = r.result.facts;
  const val = (id) => ev_of(r.result, id)?.v ?? null;
  const view = { kind: f.kind, verified: r.verified, warnings: r.result.warnings };
  if (f.kind === 'ok') {
    view.verdict = f.verdict;
    view.buffer = val(f.buffer_minor);
    view.by_mode = {};
    for (const m of MODES) {
      const x = f.by_mode[m];
      view.by_mode[m] = { m_after: val(x.m_after), at: val(x.at), margin: val(x.margin), delta: val(x.delta), cash_gap: x.cash_gap };
    }
    view.s_max = f.s_max === null ? null : { plan: val(f.s_max.plan), worse: val(f.s_max.worse) };
    view.earliest = f.earliest === null ? null : { plan: val(f.earliest.plan), worse: val(f.earliest.worse) };
    view.flags = f.flags;
    view.beyond = val(f.beyond_horizon_minor) ?? 0;
    view.cash_after = ready !== null && ready.cash_after !== undefined ? ready.cash_after : cash_after(model, args.parts ?? [{ date: args.date, amount_minor: args.amount_minor }]);
  } else if (f.kind === 'insufficient_data') {
    view.reason = f.reason;
    view.reasons = f.reasons;
  } else view.horizon_end = val(f.horizon_end);
  return { ok: true, text: r.text, result: r.result, view, ref: call_ref(r.result.call_id) };
}

/**
 * Модель экрана «Волны» (D-09, D-10): состав, итог, метрики по двум режимам.
 * @param {{ws: object, ctx: object}} model
 * @param {'ru'|'en'} lang
 * @returns {{items: object[], threshold: number|null}}
 */
export function waves_model(model, lang) {
  const a = model.ctx;
  const namer = make_namer(model.ws, lang);
  const by_mode = {};
  const ready = calc.waves_for(a); // FP-21: списки волн пришли из Worker вместе с расчётом (операция waves); без них — считаем на месте
  for (const m of MODES) by_mode[m] = (ready?.[m] ?? list_waves_ex(a, m)).items;
  const ev_by_id = new Map(a.events.plan.map((e) => [e.cash_event_id, e]));
  const fx_of = fx_by_event(model.ws, a, a.events.plan); // FP-16: платежи волны, пересчитанные по курсу, несут подпись курса и возраста
  const items = by_mode.plan.map((it, i) => {
    const per = {};
    for (const m of MODES) {
      const mine = by_mode[m].find((x) => x.wave.wave_id === it.wave.wave_id) ?? by_mode[m][i];
      per[m] = { metrics: mine.metrics, next_income: next_income_day(a.events[m], it.wave.end) };
    }
    const members = it.wave.event_ids.map((id) => {
      const e = ev_by_id.get(id);
      return e === undefined ? { id, name: id, d: it.wave.start, amount_minor: 0 } : { id, name: namer(e), d: e.date, amount_minor: e.amount_minor, ...(fx_of.has(id) ? { fx: fx_of.get(id) } : {}) };
    });
    return { n: i + 1, wave: it.wave, members, per };
  });
  return { items, threshold: a.params['wave.threshold_minor'] ?? null };
}

/**
 * Календарь волн: месяцы горизонта, недели с понедельника; ячейка — день, номер волны, «сегодня».
 * @param {{ctx: object}} model
 * @param {{n: number, wave: {start: number, end: number}}[]} items волны из `waves_model`
 * @returns {{y: number, m: number, weeks: {d: number|null, wave: number|null, today: boolean, in_horizon: boolean}[][]}[]}
 */
export function calendar_model(model, items) {
  const a = model.ctx;
  const wave_of = new Map();
  for (const it of items) for (let d = it.wave.start; d <= it.wave.end; d++) wave_of.set(d, it.n);
  const [y0, m0] = civil_from_days(a.as_of);
  const [y1, m1] = civil_from_days(a.horizon_end);
  const months = [];
  let y = y0;
  let m = m0;
  for (;;) {
    const first = days_from_civil(y, m, 1);
    const next = m === 12 ? days_from_civil(y + 1, 1, 1) : days_from_civil(y, m + 1, 1);
    const lead = (dow(first) + 6) % 7; // 0 = понедельник
    const cells = [];
    for (let k = 0; k < lead; k++) cells.push({ d: null, wave: null, today: false, in_horizon: false });
    for (let d = first; d < next; d++) cells.push({ d, wave: wave_of.get(d) ?? null, today: d === a.as_of, in_horizon: d >= a.as_of && d <= a.horizon_end });
    while (cells.length % 7 !== 0) cells.push({ d: null, wave: null, today: false, in_horizon: false });
    const weeks = [];
    for (let k = 0; k < cells.length; k += 7) weeks.push(cells.slice(k, k + 7));
    months.push({ y, m, weeks });
    if (y === y1 && m === m1) break;
    if (m === 12) { y += 1; m = 1; } else m += 1;
  }
  return months;
}

/**
 * Модель экрана «Резервы»: свободный остаток, налоговый конверт, накопления (sinking), «можно потратить».
 * @param {{ws: object, ctx: object}} model
 * @param {'plan'|'worse'} mode
 * @returns {object}
 */
export function reserves_model(model, mode) {
  const a = model.ctx;
  const w = model.ws;
  const s = a.series[mode];
  const by = a.reserve[mode].by_reserve;
  const last = s.close.length - 1;
  const recorded = w.allocations ?? [];
  const reserves = (w.reserves ?? []).map((r) => ({ r, now: reserve_open(r, recorded, a.as_of), series: by[r.reserve_id] ?? null }));
  a.calls_used = 0;
  const tax_call = run_tool('get_tax_envelope', {}, a);
  const tax_ok = tax_call.isError !== true && tax_call.facts.kind === 'ok';
  const tax_rules = (w.tax_rules ?? []).map((tr) => {
    const rs = reserves.find((x) => x.r.kind === 'tax' && x.r.tax_rule_id === tr.tax_rule_id) ?? null;
    let alloc = null;
    if (rs !== null && rs.series !== null) {
      const i = rs.series.allocated.findIndex((v) => v > 0);
      if (i >= 0) {
        const d = s.from + i;
        const inc = a.events[mode].find((e) => e.kind === 'income' && e.date === d && e.amount_minor > 0);
        alloc = { d, amount_minor: rs.series.allocated[i], income_minor: inc === undefined ? null : inc.amount_minor };
      }
    }
    return {
      rule: tr, status: a.rule_status[tr.tax_rule_id] ?? 'fresh', now: rs === null ? 0 : rs.now,
      end: rs === null || rs.series === null ? 0 : rs.series.close[last], alloc,
    };
  });
  let next_due = null;
  if (tax_ok && tax_call.facts.next_due !== null) {
    next_due = { d: ev_of(tax_call, tax_call.facts.next_due.date)?.v, amount_minor: ev_of(tax_call, tax_call.facts.next_due.payment_minor)?.v };
  }
  let release = null; // FP-28 (A06.5): следующее списание из налогового конверта — ближайший платёж, привязанный к налоговому резерву
  for (const x of reserves.filter((y) => y.r.kind === 'tax')) {
    const n = next_release(x.r.reserve_id, a.reserve[mode], a.events[mode], a.as_of);
    if (n !== null && (release === null || n.date < release.date)) release = n;
  }
  const sinking = reserves.filter((x) => x.r.kind === 'sinking').map((x) => {
    const contrib = [];
    if (x.series !== null) x.series.contributed.forEach((v, i) => { if (v > 0) contrib.push({ d: s.from + i, amount_minor: v }); });
    return { reserve: x.r, now: x.now, end: x.series === null ? x.now : x.series.close[last], contrib };
  });
  const free_now = s.opening_minor - s.reserve_opening_minor;
  const min_free = {};
  for (const m of MODES) {
    const np = narrowest_point({ ...a.series[m], trough: a.series[m].free }, a.as_of, a.horizon_end);
    min_free[m] = { d: np.date, v: np.amount_minor };
  }
  return {
    balance: s.opening_minor, reserved_now: s.reserve_opening_minor, free_now, min_free, tax_rules, sinking, next_due, next_release: release,
    total_end: s.reserve_close[last], has_any: (w.reserves ?? []).length > 0 || (w.tax_rules ?? []).length > 0,
    tax_ref: tax_ok ? call_ref(tax_call.call_id) : null,
  };
}

/**
 * Модель «Ленты»: последние факты и будущие события выбранного режима со «швом сегодня» и номером волны.
 * @param {{ws: object, ctx: object}} model
 * @param {'plan'|'worse'} mode
 * @param {'ru'|'en'} lang
 * @returns {{past: object[], future: object[], past_total: number, past_limit: number}} `past_total` — все факты рабочей области, `past_limit` — сколько показано (FEED_PAST_LIMIT)
 */
export function feed_model(model, mode, lang) {
  const a = model.ctx;
  const namer = make_namer(model.ws, lang);
  const other = mode === 'plan' ? 'worse' : 'plan';
  const wave_of = new Map();
  list_waves_ex(a, mode).items.forEach((it, k) => { for (const id of it.wave.event_ids) wave_of.set(id, k + 1); });
  const other_by_id = new Map(a.events[other].map((e) => [e.cash_event_id, e]));
  const fx_of = fx_by_event(model.ws, a, a.events[mode]); // FP-16: пересчитанные по курсу события получают подпись курса и возраста
  const past = [...(model.ws.facts ?? [])]
    .sort((p, q) => (p.date < q.date ? 1 : p.date > q.date ? -1 : 0))
    .slice(0, FEED_PAST_LIMIT)
    .map((f) => ({ id: f.event_id, iso: f.date, d: parse_date(f.date), name: namer(f), amount_minor: f.amount_minor, kind: f.kind, ...(typeof f.transfer_id === 'string' ? { transfer: true } : {}), ...(typeof f.currency === 'string' && f.currency !== model.cur ? { currency: f.currency } : {}) })); // факт в чужой валюте показывается в своей валюте; `id` и признак перевода нужны действиям строки (FP-28)
  const future = [...a.events[mode]]
    .sort((p, q) => (p.date - q.date) || (p.amount_minor - q.amount_minor))
    .map((e) => {
      const o = other_by_id.get(e.cash_event_id);
      return {
        id: e.cash_event_id, d: e.date, name: namer(e), amount_minor: e.amount_minor, status: e.layer === 'hypothetical' ? 'hypothetical' : e.status,
        wave: wave_of.get(e.cash_event_id) ?? null, other_d: o !== undefined && o.date !== e.date ? o.date : null, income: e.kind === 'income',
        ...(fx_of.has(e.cash_event_id) ? { fx: fx_of.get(e.cash_event_id) } : {}),
      };
    });
  return { past, future, past_total: (model.ws.facts ?? []).length, past_limit: FEED_PAST_LIMIT };
}

// ── сценарии ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Первое ожидаемое поступление (ссылка для `delay_income`): по базовому плану, не из сценария.
 * @param {{ctx: object}} base_model
 * @returns {string|null} `cash_event_id` или `null`
 */
export function first_income_ref(base_model) {
  const list = base_model.ctx.events.plan
    .filter((e) => e.layer === 'planned' && e.kind === 'income' && e.amount_minor > 0 && (e.status === 'expected' || e.status === 'overdue'))
    .sort((p, q) => p.date - q.date);
  return list.length === 0 ? null : list[0].cash_event_id;
}

/**
 * Операции сценария по его описанию: `delay` — «клиент платит на N дней позже», `purchase` — покупка, `saved` — сохранённый в наборе.
 * @param {{kind: 'delay'|'purchase'|'saved', days?: number, amount_minor?: number, date?: string, sid?: string}} sc
 * @param {object} ws
 * @param {string|null} income_ref
 * @returns {object[]|null} `null` — собрать нельзя (нет поступления или нет сценария)
 */
export function scenario_ops(sc, ws, income_ref) {
  if (sc.kind === 'delay') return income_ref === null ? null : [{ op: 'delay_income', event_ref: income_ref, days: sc.days }];
  if (sc.kind === 'purchase') return [{ op: 'add_purchase', parts: [{ date: sc.date, amount_minor: sc.amount_minor }] }];
  const hooked = ext.first('scenario_ops', sc, ws, income_ref); // новые виды сценариев из пакетов
  if (hooked !== undefined) return hooked;
  const saved = (ws.scenarios ?? []).find((x) => x.scenario_id === sc.sid);
  return saved === undefined ? null : saved.ops;
}

/**
 * Человеческое имя сценария на языке интерфейса.
 * @param {{kind: string, days?: number, amount_minor?: number, date?: string, sid?: string}} sc
 * @param {object} ws
 * @param {'ru'|'en'} lang
 * @param {ReturnType<typeof make_fmt>} fmt
 * @returns {string}
 */
export function scenario_name(sc, ws, lang, fmt) {
  if (sc.kind === 'delay') return t(lang, 'sc.name_delay', { n: sc.days, days: word_form(lang, 'day', sc.days) });
  if (sc.kind === 'purchase') return t(lang, 'sc.name_purchase', { amount: fmt.money(sc.amount_minor), date: fmt.date(sc.date) });
  const saved = (ws.scenarios ?? []).find((x) => x.scenario_id === sc.sid);
  return label_of(lang, sc.sid, saved?.name ?? sc.sid);
}

/**
 * Снимок чисел модели для сравнения сценариев: минимум на счетах и минимум свободных по режимам, Q1 на конец горизонта, «можно потратить».
 * @param {{ctx: object}} model
 * @returns {object}
 */
export function snapshot_of(model) {
  const ov = overview_model(model);
  // sts_T — дата T, до которой считается «можно потратить»; sts_h — то же до конца горизонта (D-12: STS(horizon_end)).
  const snap = { trough: {}, free: {}, q1: {}, sts: {}, sts_h: {}, sts_T: ov.T, hash: model.ctx.inputs_hash };
  for (const m of MODES) {
    const p = ov.per_mode[m];
    snap.trough[m] = { d: p.narrow.date, v: p.narrow.amount_minor };
    snap.free[m] = p.min_free_h;
    snap.q1[m] = p.q1.ok_cash === false ? 'short' : p.q1.ok_buffer === false ? 'tight' : 'ok';
    snap.sts[m] = p.gated ? null : p.sts.sts;
    snap.sts_h[m] = p.gated ? null : p.sts.sts_horizon;
  }
  return snap;
}

/**
 * Ячейка «Можно потратить» в сравнении сценариев: число ВСЕГДА с датой `T`; если до конца горизонта денег меньше,
 * добавляется вторая оговорка (design-brief §10: «до {T} свободно X»; D-12). Без неё сценарий, где в горизонте нет
 * поступлений, показывал бы «435,00 €» рядом с минимумом свободных −510,00 €.
 * @param {ReturnType<typeof snapshot_of>} sn
 * @param {'plan'|'worse'} mode
 * @param {ReturnType<typeof make_fmt>} fmt
 * @param {number} horizon_end EpochDay конца горизонта
 * @param {'ru'|'en'} lang
 * @returns {string}
 */
export function sts_cell_text(sn, mode, fmt, horizon_end, lang) {
  const v = sn.sts[mode];
  if (v === null || v === undefined) return t(lang, 'sc.sts_gate');
  const main = t(lang, 'sc.sts_until', { value: fmt.money(v), date: fmt.date(sn.sts_T) });
  const hz = sn.sts_h[mode];
  return hz !== null && hz !== undefined && hz < v
    ? main + ' · ' + t(lang, 'sc.sts_horizon', { date: fmt.date(horizon_end), value: fmt.money(hz) })
    : main;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 3. Ассистент A0: разбор вопроса простыми правилами → инструмент → шаблон
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

const MONTH_STEMS = [
  ['янв', 1], ['фев', 2], ['мар', 3], ['апр', 4], ['мая', 5], ['май', 5], ['июн', 6], ['июл', 7], ['авг', 8], ['сен', 9], ['окт', 10], ['ноя', 11], ['дек', 12],
  ['jan', 1], ['feb', 2], ['mar', 3], ['apr', 4], ['may', 5], ['jun', 6], ['jul', 7], ['aug', 8], ['sep', 9], ['oct', 10], ['nov', 11], ['dec', 12],
];

function month_of(word) {
  const w = word.toLowerCase();
  const hit = MONTH_STEMS.find(([stem]) => w.startsWith(stem));
  return hit === undefined ? null : hit[1];
}

const MONTH_WORD = '([а-яa-z]{3,9})\\.?';
const RE_ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const RE_DAY_MONTH = new RegExp('(\\d{1,2})(?:-?го|st|nd|rd|th)?\\s+(?:of\\s+)?' + MONTH_WORD + '(?:\\s+(\\d{4}))?', 'gi');
const RE_MONTH_DAY = new RegExp(MONTH_WORD + '\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?(?!\\d)', 'gi');

/**
 * Найти в тексте дату: ISO, «12 октября», «Oct 12», «сегодня/завтра/послезавтра», «через N дней», «in N days».
 * @param {string} text нормализованный (нижний регистр) текст
 * @param {number} as_of EpochDay
 * @returns {{d: number, span: [number, number]}|{error: 'bad_date'}|null}
 */
export function find_date(text, as_of) {
  const guard = (fn) => {
    try { return fn(); } catch { return { error: 'bad_date' }; }
  };
  let m = RE_ISO.exec(text);
  if (m !== null) return guard(() => ({ d: parse_date(m[0]), span: [m.index, m.index + m[0].length] }));
  const roll = (y, mo, d, explicit) => {
    let dd = days_from_civil(y, mo, d);
    if (!explicit && dd < as_of) dd = days_from_civil(y + 1, mo, d);
    return dd;
  };
  const year0 = civil_from_days(as_of)[0];
  for (const mm of text.matchAll(RE_DAY_MONTH)) {
    if (month_of(mm[2]) === null) continue;
    return guard(() => ({ d: roll(mm[3] === undefined ? year0 : Number(mm[3]), month_of(mm[2]), Number(mm[1]), mm[3] !== undefined), span: [mm.index, mm.index + mm[0].length] }));
  }
  for (const mm of text.matchAll(RE_MONTH_DAY)) {
    if (month_of(mm[1]) === null) continue;
    return guard(() => ({ d: roll(mm[3] === undefined ? year0 : Number(mm[3]), month_of(mm[1]), Number(mm[2]), mm[3] !== undefined), span: [mm.index, mm.index + mm[0].length] }));
  }
  const rel = [
    [/послезавтра|day after tomorrow/, 2], [/завтра|tomorrow/, 1], [/сегодня|today/, 0], [/через неделю|next week|in a week/, 7],
  ];
  for (const [re, add] of rel) {
    m = re.exec(text);
    if (m !== null) return { d: as_of + add, span: [m.index, m.index + m[0].length] };
  }
  m = /(?:через|in)\s+(\d{1,3})\s*(?:дн\p{L}*|день|days?)/u.exec(text);
  if (m !== null) return { d: as_of + Number(m[1]), span: [m.index, m.index + m[0].length] };
  return null;
}

/** Найти в тексте сумму: число рядом с валютой или после «за/for»; иначе единственное отдельное число. */
function find_amount(text, exponent) {
  const num = '(\\d[\\d\\s\\u00a0.,]*\\d|\\d)';
  const tries = [
    new RegExp(num + '\\s*(?:€|eur\\b|euros?\\b|евро|\\$|usd\\b|долл\\p{L}*|£|gbp\\b|₽|руб\\p{L}*|rub\\b)', 'iu'),
    new RegExp('(?:за|for|на сумму|worth|of)\\s+(?:€|\\$)?\\s*' + num, 'iu'),
    new RegExp('(?:^|\\s)(?:€|\\$)\\s*' + num, 'iu'),
  ];
  for (const re of tries) {
    const m = re.exec(text);
    if (m !== null) return parse_amount_lenient(m[1], exponent);
  }
  const loose = text.match(/(?:^|\s)(\d+(?:[.,]\d{1,2})?)(?=\s|$|[?!.])/);
  return loose === null ? null : parse_amount_lenient(loose[1], exponent);
}

function find_currency(text, fallback) {
  if (/\$|usd|долл/.test(text)) return 'USD';
  if (/£|gbp/.test(text)) return 'GBP';
  if (/₽|руб|\brub\b/.test(text)) return 'RUB';
  return fallback;
}

/**
 * Разобрать вопрос к ассистенту A0 простыми правилами (без LLM): намерение по ключевым словам, сумма и дата — по шаблонам.
 * Результат — команда инструмента движка `{name, args}`; числа в текст ответа подставит рендерер из результата инструмента.
 * @param {string} text вопрос на русском или английском
 * @param {{as_of: string, horizon_end: string, currency: string, income_ref: string|null, last_call?: string|null}} info `last_call` — hex предыдущего вызова ассистента (для «с прошлого раза», FP-20)
 * @returns {{ok: true, command: {name: string, args: object}, intent: string}|{ok: false, reason: 'empty'|'unrecognized'|'no_amount'|'bad_date'|'no_income'|'no_since'|'shift_days'|'shift_unsupported'}}
 */
export function parse_assistant_command(text, info) {
  const raw = String(text ?? '').normalize('NFC').replace(/[  ]/g, ' ').trim();
  if (raw === '') return { ok: false, reason: 'empty' };
  let q = raw.toLowerCase().replace(/ё/g, 'е');
  const as_of = parse_date(info.as_of);
  const date = find_date(q, as_of);
  if (date !== null && date.error === 'bad_date') return { ok: false, reason: 'bad_date' };
  const iso = date === null ? null : format_date(date.d);
  const year_given = date !== null && /\d{4}/.test(q.slice(date.span[0], date.span[1])); // год в самой дате вопроса (для «что изменилось с …», FP-20)
  if (date !== null) q = (q.slice(0, date.span[0]) + ' ' + q.slice(date.span[1])).replace(/\s+/g, ' ');
  const exponent = currency_exponent(info.currency);
  const mode = /по плану|as planned|\bplan\b|\bпо\s+плану/.test(q) ? 'plan' : /если хуже|\bworse\b|worst|хуже/.test(q) ? 'worse' : null;
  const with_mode = (args, allowed = true) => (mode !== null && allowed ? { ...args, mode } : args);
  const ok = (name, args, intent) => ({ ok: true, command: { name, args }, intent });

  if (/(клиент|заказчик|выплат|плат[её]ж|платит|заплат|доход|поступлен|client|customer|payout|payment|income|pays?|paid).*(позже|задерж|later|delay)|(позже|задерж|later|delay).*(клиент|выплат|платит|client|payout|pays?)/u.test(q)) {
    if (info.income_ref === null) return { ok: false, reason: 'no_income' };
    const m = /(\d{1,3})\s*(?:дн\p{L}*|день|days?)/u.exec(q);
    const days = m === null ? 14 : Number(m[1]);
    return ok('run_scenario', { ops: [{ op: 'delay_income', event_ref: info.income_ref, days }] }, 'delay');
  }
  if (/почему|why|explain|объясни|узк\p{L}* точк|narrow|из чего/u.test(q)) return ok('explain_min_point', with_mode({}), 'explain');
  if (/волн|wave/u.test(q)) return ok('list_waves', with_mode({ from: info.as_of, to: info.horizon_end }), 'waves');
  if (/налог|конверт|tax|envelope/u.test(q)) return ok('get_tax_envelope', {}, 'tax');
  const amount = find_amount(q, exponent);
  const currency = find_currency(raw.toLowerCase(), info.currency);
  if (/когда|самая ранняя|ранн\p{L}* дат|earliest|when\b/u.test(q)) {
    if (amount === null) return { ok: false, reason: 'no_amount' };
    const args = with_mode({ amount_minor: amount, currency });
    if (iso !== null) args.not_before = iso;
    return ok('earliest_safe_date', args, 'earliest');
  }
  if (/сколько|максимум|макс\b|how much|maximum|\bmax\b/u.test(q)) return ok('max_purchase_amount', with_mode({ date: iso ?? info.as_of }), 'max');
  if (/куп\p{L}*|покупк|потрат|хватит|можно ли|могу ли|afford|buy|purchase|spend|get a|order/u.test(q)) {
    if (amount === null) return { ok: false, reason: 'no_amount' };
    return ok('check_purchase', { date: iso ?? info.as_of, amount_minor: amount, currency }, 'purchase');
  }
  if (/прогноз|остаток|минимум|баланс|projection|balance|forecast|minimum/u.test(q)) return ok('get_projection', with_mode({ to: iso ?? info.horizon_end }), 'projection');
  // новые намерения (FP-20) — отдельная таблица в verifier.mjs; опрашивается после прежних правил, поэтому прежние вопросы отвечают как раньше
  return parse_ext_intent(q, { as_of: info.as_of, date: iso, date_explicit: year_given, income_ref: info.income_ref, last_call: info.last_call ?? null }) ?? { ok: false, reason: 'unrecognized' };
}

/**
 * Ответ ассистента A0: разбор → инструмент движка → шаблон каталога → сверка чисел верификатором.
 * @param {{ws: object, ctx: object}} model
 * @param {string} text
 * @param {'ru'|'en'} lang
 * @param {string|null} income_ref
 * @param {{journal?: object[], call_log?: object, last_call?: string|null, record?: (result: object, args: object) => unknown}|null} [ports] порты страницы (FP-20):
 *   журнал и порт `call_log` для «что изменилось» (на время вызова подставляются в контекст инструментов), hex предыдущего вызова и запись `assistant.call` (только хэши)
 * @returns {{ok: boolean, reason?: string, date?: string, text?: string, tool?: string, ref?: string|null, result?: object, verified?: boolean,
 *   info?: {intent: string, command: object, assumed: object|null, history_start: string|null}}}
 *   `reason: 'no_history'` — основание «что изменилось» раньше начала журнала страницы (`date` — его первый день); `info` — разбор вопроса для пояснения допущений ответа (FP-20)
 */
export function ask_a0(model, text, lang, income_ref, ports = null) {
  const a = model.ctx;
  const info = { as_of: format_date(a.as_of), horizon_end: format_date(a.horizon_end), currency: a.decision_currency, income_ref, last_call: ports?.last_call ?? null };
  const p = parse_assistant_command(text, info);
  if (!p.ok) return { ok: false, reason: p.reason };
  // «что изменилось»: журнал страницы не знает истории до открытия страницы; инструменту отдаётся представление журнала, а не сырой журнал
  const view = p.command.name === 'what_changed' && Array.isArray(ports?.journal) ? changes_view(ports.journal, p.command.args.since) : null;
  if (view !== null && !view.ok) return { ok: false, reason: view.reason, date: view.history_start };
  a.calls_used = 0;
  const kept = { journal: a.journal, call_log: a.call_log };
  if (view !== null) { a.journal = view.journal; a.call_log = view.call_log; } else if (Array.isArray(ports?.journal)) { a.journal = ports.journal; a.call_log = ports.call_log ?? {}; } // журнал страницы нужен только этому вызову (what_changed)
  let r;
  try { r = a0_answer(p.command, a, { locale: lang, number_format: model.ws.number_format, notes: p.notes }); } finally { a.journal = kept.journal; a.call_log = kept.call_log; } // формат чисел и дат пользователя (REQ-112, FP-16); допущения сдвига — шаблонами каталога
  if (!r.ok) return { ok: false, reason: 'tool_error', text: r.text, tool: p.command.name };
  if (typeof ports?.record === 'function') { try { ports.record(r.result, p.command.args); } catch { /* запись в журнал вызовов не нужна для ответа */ } } // assistant.call: только хэши (FP-20)
  const env = make_env(lang, model.ws, a);
  const note = answer_note_text((key, params) => t(lang, key, params), env, rate_uses(model.ws, a, model.scenario)); // курсы, по которым пересчитан расчёт, события И остатки счетов (REQ-077, REQ-079); пусто, если пересчётов нет
  const a0_info = { intent: p.intent, command: p.command, assumed: p.assumed ?? null, history_start: view === null ? null : view.history_start }; // для пояснения допущений (хук assistant, действие 'note')
  return { ok: true, text: r.text, tool: p.command.name, ref: call_ref(r.result.call_id), result: r.result, verified: r.verified, info: a0_info, ...(note === '' ? {} : { fx_note: note }) };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 4. DOM-слой
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

const SVG_NS = 'http://www.w3.org/2000/svg';
const VIEWS = Object.freeze(['overview', 'buy', 'waves', 'reserves', 'scenarios', 'feed', 'assistant', 'data']);
const THEMES = Object.freeze(['auto', 'light', 'dark']);
const VERDICT_GLYPH = Object.freeze({ OK: '✓', FRAGILE: '▲', TIGHT: '◆', NO: '✕' });
const MAX_SCENARIOS = 3;
const known_view = (v) => VIEWS.includes(v) || ext.has_view(v); // экраны приложения и экраны пакетов (реестр ext.mjs)

/** Состояние страницы (в памяти вкладки; сценарии и вопросы в журнал фактов не пишутся). */
const S = {
  lang: DEFAULT_LANG, theme: 'auto', view: 'overview', mode: 'worse', dataset_id: 'g001', ws: null, base: null, model: null, scenario: null,
  status: 'loading', error: null, buy: null, q1_d: null, sts_t: null, cmp: [], chat: [], cmp_cache: new Map(), notice: null, quarantine: null, ask_q: null,
  calc_busy: 0, adopt_gen: 0, buy_live: null, // FP-21: число расчётов в Worker, ждущих экран; номер последней загрузки набора; метка живой отрисовки «Купить»
  buy_said: null, // FP-48: вердикт покупки, уже названный скринридеру; поздняя перерисовка с тем же вердиктом его не повторяет (сообщение о записи или отмене не затирается)
};

/** Создать элемент HTML: `h('p', {class: 'x', text: '…'}, дети…)`; `on…` — обработчики, `null`/`false` — пропуск. */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  add_kids(el, kids);
  return el;
}

/** Создать элемент SVG. */
function s(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'text') el.textContent = v;
    else el.setAttribute(k, String(v));
  }
  add_kids(el, kids);
  return el;
}

function add_kids(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(typeof k === 'string' || typeof k === 'number' ? document.createTextNode(String(k)) : k);
  }
}

const tr = (key, params) => t(S.lang, key, params);
const fmt = () => ext.first('fmt', S.lang, S.model.cur, S.model.as_of_iso, S.ws?.number_format) ?? make_fmt(S.lang, S.model.cur, S.model.as_of_iso); // хук fmt: формат чисел отдельно от языка (REQ-112)
const ro_now = () => ext.ctx.read_only(); // режим «только чтение» (FP-17, REQ-016): `null` или описание; единственное место чтения признака, остальное — через ro_now()
const a0_hook = (action, ...args) => ext.first('assistant', action, ...args); // хук assistant (FP-20): 'chip' — чип происхождения ответа (получает действие «Числа расчёта»), 'ports' — журнал и запись вызовов, 'note' — пояснение допущений ответа; единственное место обращения, без пакета — undefined
const slot = (name, ...extra) => ext.slot_nodes(name, ext.ctx, ...extra); // узлы слота пакетов; `extra` — описание места вызова (карточка, строка ленты) после ctx; слоты без описания зовут `render(ctx)` как прежде
const a0_note_node = (info) => { const n = a0_hook('note', info); return typeof n === 'string' && n !== '' ? h('p', { class: 'muted a0-note', text: n }) : null; }; // пояснение допущений (какое поступление сдвинуто, чем ограничен журнал); без пакета узла нет
const mode_label = (m) => LABELS.modes[S.lang][m];
const el_by_id = (id) => document.getElementById(id);

function table(caption, head, rows, cls) {
  return h('table', { class: cls ?? 'tbl' },
    h('caption', { class: 'sr-only', text: caption }),
    h('thead', null, h('tr', null, head.map((c) => h('th', { scope: 'col', text: c })))),
    h('tbody', null, rows));
}

/** Чип «числа из расчёта c_…»: пакет A0 (FP-20) рисует чип происхождения с режимом, версией движка, датой узкой точки и «почему»; без него — кнопка со списком чисел результата. */
function calc_chip(result, ref) {
  return a0_hook('chip', result, ref, () => show_evidence(result, ref)) ?? h('button', { type: 'button', class: 'chip', title: tr('c.chip_hint'), onclick: () => show_evidence(result, ref), text: tr('c.calc_chip', { ref }) });
}

function open_dialog(title, ...body) {
  const dlg = el_by_id('dlg');
  el_by_id('dlg-title').textContent = title;
  const box = el_by_id('dlg-body');
  box.replaceChildren(...body.flat().filter((x) => x !== null && x !== undefined && x !== false));
  el_by_id('dlg-close').textContent = tr('c.close');
  if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute('open', '');
}

function show_evidence(result, ref) {
  const f = fmt();
  const rows = result.evidence.map((e) => h('tr', null,
    h('th', { scope: 'row', text: e.id }), h('td', { text: e.kind }), h('td', { class: 'num', text: render_value(e, S.lang, S.model.as_of_iso, S.ws?.number_format) }))); // формат чисел и дат пользователя (REQ-112, FP-16)
  open_dialog(tr('as.evidence_title', { ref }),
    h('p', { text: tr('as.evidence_lead') }),
    table(tr('as.evidence_title', { ref }), [tr('as.col_id'), tr('c.kind'), tr('c.value')], rows),
    h('p', { class: 'muted', text: tr('c.engine', { version: result.engine_version, hash: result.inputs_hash.slice(0, 8) }) + ' · ' + f.date(result.as_of) }));
}

// Живая область (#live). FP-48: сообщение действия («Добавлен расход …», «Отменено: …») и вердикт покупки, объявленные в ОДНОМ ходе (до микрозадач), не затирают друг друга: в области
// сначала сообщение, затем вердикт, в каком бы порядке их ни объявили (запись перерисовывает страницу и называет вердикт раньше, чем действие объявит своё сообщение). В следующем
// ходе новое объявление заменяет прежнее, как раньше.
// FP-49: расчёт «Купить» в Worker отвечает позже действия (в другом ходе), и вердикт заменял сообщение («Сверить остаток» → «Вердикт: не хватает», текст о сверке терялся). Страница помнит
// последнее сообщение и время его объявления: вердикт в другом ходе встаёт после него, если сообщение моложе SAY_JOIN_MS, всё ещё единственное в области (чужой текст его не заменил;
// после объединения область уже не равна сообщению, поэтому повтора нет) и относится к тому же экрану и набору данных (смена экрана и набора его забывает). Старше окна — оно уже прозвучало и не дописывается.
const SAY_JOIN_MS = 600;
let said_turn = null; // что объявлено в текущем ходе: { message, verdict }; сбрасывается микрозадачей
let said_last = null; // последнее сообщение действия: { text, at }

function say(kind, text) {
  const live = el_by_id('live');
  if (live === null) return;
  if (said_turn === null) {
    said_turn = { message: '', verdict: '' };
    queueMicrotask(() => { said_turn = null; });
  }
  if (kind === 'message') said_last = { text, at: Date.now() };
  else if (said_turn.message === '' && said_last !== null && said_last.text !== '' && live.textContent === said_last.text) {
    const age = Date.now() - said_last.at; // часы шагнули назад (age < 0) — сообщение не дописываем
    if (age >= 0 && age <= SAY_JOIN_MS) said_turn.message = said_last.text;
  }
  said_turn[kind] = text;
  live.textContent = [said_turn.message, said_turn.verdict].filter((x) => x !== '').join(' ');
}

function announce(text) {
  say('message', text);
}

/** Вердикт покупки в живую область: объявляется сразу (из полей экрана и из перерисовки); сообщение того же хода встаёт перед ним. */
function say_verdict(text) {
  say('verdict', text);
}

// ── общие блоки ─────────────────────────────────────────────────────────────────────────────────────────────────────

function verdict_badge(verdict) {
  return h('span', { class: 'verdict verdict-' + verdict },
    h('span', { 'aria-hidden': 'true', class: 'glyph', text: VERDICT_GLYPH[verdict] }), h('span', { text: ' ' + LABELS.verdicts[S.lang][verdict] }));
}

function gate_text(reason) {
  const key = 'gate.' + reason;
  const since = reason === 'rule_disabled' ? (oldest_review_date(S.model.ws, S.model.ctx.as_of, S.model.ctx.rule_status, 'disabled') ?? tr('c.na')) : ''; // FP-15: «не подтверждено с <даты>»
  return Object.hasOwn(STRINGS[S.lang], key) ? tr(key, { since }) : tr('gate.generic');
}

/** FP-47 (REQ-067): `null` — «свободно» печатать можно; иначе дата, с которой правило не подтверждено, — текст с ней стоит вместо числа (тот же гейт, что на «Резервах»). */
function free_gate_since() {
  const since = free_masked_since(S.model.ws, S.model.ctx.as_of, S.model.ctx.rule_status);
  return since === null ? null : since === '' ? tr('c.na') : since;
}

function warning_text(w) {
  if (w.code === 'W_RESERVE_BEHIND' && Number.isInteger(w.missed_count) && Number.isInteger(w.missed_minor)) {
    return tr('warn.W_RESERVE_BEHIND_n', { n: w.missed_count, sum: fmt().money(w.missed_minor) });
  }
  if (w.code === 'W_DEBT_BEYOND_HORIZON' && Number.isInteger(w.count) && Number.isInteger(w.total_minor)) { // FP-14: число и сумма платежей долга за горизонтом, в валюте долга
    const money = typeof w.currency === 'string' && w.currency !== S.model.cur ? (v) => money_in(make_env(S.lang, S.model.ws, S.model.ctx), w.currency, v) : fmt().money; // в формате чисел пользователя (FP-16)
    const name = typeof w.debt_id === 'string' ? make_namer(S.model.ws, S.lang).by_id(w.debt_id) : ''; // название долга (при двух долгах строки различимы); в страницу — через textContent
    return tr('warn.W_DEBT_BEYOND_HORIZON_n', { name, n: w.count, sum: money(w.total_minor) });
  }
  if ((w.code === 'W_RESERVE_RESIDUAL' || w.code === 'W_RESERVE_OVERDUE') && typeof w.reserve_id === 'string') { // FP-15: остаток резерва называется суммой, как взносы в W_RESERVE_BEHIND
    const r = (S.model.ws.reserves ?? []).find((x) => x.reserve_id === w.reserve_id);
    if (r !== undefined) return tr('warn.' + w.code + '_n', { name: label_of(S.lang, r.reserve_id, r.name), sum: fmt().money(reserve_open(r, S.model.ws.allocations ?? [], S.model.ctx.as_of)) });
  }
  if (w.code === 'W_RULE_STALE' || w.code === 'W_RULE_DISABLED') { // FP-15: плашка называет дату последней проверки правила
    return tr('warn.' + w.code, { since: (typeof w.rule_id === 'string' ? review_date(S.model.ws, w.rule_id, S.model.ctx.as_of) : null) ?? tr('c.na') });
  }
  if (w.code === 'W_RATE_STALE') { // FP-16: плашка называет валюту, возраст курса в днях и предел, дату курса и место, где курс обновляется
    const named = rate_stale_text(tr, S.model.ws, S.model.ctx, w);
    if (named !== null) return named;
  }
  if (is_ext_warning(w)) return ext_warning_text(w, S.lang) ?? tr('warn.other', { code: w.code }); // служебные коды движка вне vocab.json (К-39)
  const key = 'warn.' + w.code;
  const known = ['W_BUFFER_UNSET', 'W_NO_RESERVES', 'W_RESERVE_BEHIND', 'W_RESERVE_RESIDUAL', 'W_RESERVE_OVERDUE', 'W_RULE_STALE', 'W_RULE_DISABLED',
    'W_WAVE_NEAR_HORIZON', 'W_DATE_CLAMPED', 'W_PART_BEYOND_HORIZON', 'W_T_CLAMPED', 'W_RATE_STALE', 'W_HOURS_NOT_CONFIRMED', 'W_NO_HISTORY',
    'W_LAG_BEYOND_HISTORY', 'W_OVERRIDE_STALE'];
  return known.includes(w.code) ? tr(key) : tr('warn.other', { code: w.code });
}

/**
 * «Ближайшее ожидаемое поступление» к сообщению о нехватке (REQ-046, FP-28): поступление режима в день `from_day` или позже (суммой за день);
 * поступлений до конца горизонта нет — отдельная фраза. Это факт расчёта по введённым данным, а не совет.
 */
function income_tail(mode, from_day) {
  const n = nearest_income(S.model.ctx.events[mode], from_day);
  return n === null ? tr('ov.next_income_none') : tr('ov.next_income', { date: fmt().date(n.date), value: fmt().money(n.amount_minor) });
}

/**
 * «Первая дата нарушения буфера» (REQ-046) — хвост фразы о нехватке: `cash` — деньги на счетах (`trough < B`), иначе — свободные деньги с учётом резервов (`free < B`).
 * Даты нет (ряд не опускается ниже буфера в окне) — пустая строка.
 */
function below_tail(cash, day) {
  return typeof day === 'number' ? ' ' + tr(cash ? 'ov.q1_first_below' : 'ov.sts_first_below', { date: fmt().date(day) }) : '';
}

/** Предложение Q1 для режима `m` (D-13): три исхода — хватает / впритык / не хватает; у двух последних — первая дата, «не хватает до буфера» и ближайшее ожидаемое поступление (REQ-046). */
function q1_sentence(p, B, f, m) {
  const q = p.q1;
  if (q.beyond_horizon === true) return tr('ov.q1_beyond');
  if (!q.ok_cash) {
    return tr('ov.q1_short', { date: f.date(p.q1_first.date), value: f.money(p.q1_first.amount_minor), n: p.q1_first.date - S.model.ctx.as_of, days: word_form(S.lang, 'day', p.q1_first.date - S.model.ctx.as_of), need: f.money(q.need) })
      + ' ' + income_tail(m, p.q1_first.date);
  }
  if (!q.ok_buffer) return tr('ov.q1_tight', { value: f.money(q.min), date: f.date(q.at), buffer: f.money(B ?? 0), need: f.money(q.need) }) + ' ' + income_tail(m, q.at) + below_tail(true, q.first_buffer_breach);
  return tr('ov.q1_ok', { margin: f.money(q.min - (B ?? 0)) });
}

function why_button(mode) {
  return h('button', { type: 'button', class: 'link', onclick: () => show_why(mode), text: tr('ov.why') });
}

/** «Спросить ассистента» (FP-28, U13): открыть «Ассистент» с заготовкой вопроса в поле ввода; вопрос сам не отправляется, текст заготовки — только значение поля. */
function ask_assistant(question) {
  S.ask_q = String(question).slice(0, 200);
  location.hash = '#assistant';
  if (S.view !== 'assistant') route();
  else render();
}

/** Кнопка «Спросить ассистента» на карточке: заготовка из каталога (question_key), подпись для скринридера называет тему карточки. */
const ask_btn = (question_key, topic_key, params) => h('button', { type: 'button', class: 'link', 'aria-label': tr('c.ask_for', { topic: tr(topic_key) }), onclick: () => ask_assistant(tr(question_key, params)), text: tr('c.ask') });

/** Сумма для заготовки вопроса: точка как десятичный знак, без разделителей тысяч (так её разбирает ассистент). */
const ask_amount = (minor) => format_minor(Math.abs(minor), fmt().exp, { decimal: '.', thousands: '' });

// ── «Почему» и «Как посчитано» ──────────────────────────────────────────────────────────────────────────────────────

function show_why(mode) {
  const f = fmt();
  const env = make_env(S.lang, S.model.ws, S.model.ctx);
  const extra = ext.collect('show_why', mode); // блоки пакетов (FP-07 и др.)
  const ex = explain_model(S.model, mode, S.lang);
  const head = [h('p', { class: 'muted', text: tr('wy.mode', { mode: mode_label(mode) }) + (S.scenario === null ? '' : ' · ' + tr('wy.scenario', { name: scenario_name(S.scenario, S.model.ws, S.lang, f) })) })];
  if (ex.empty) {
    open_dialog(tr('wy.title', { value: f.money(ex.point.amount_minor), date: f.date(ex.point.date) }), head, h('p', { text: tr('wy.empty') }), extra);
    return;
  }
  const chain_rows = ex.chain.map((c) => h('tr', null,
    h('th', { scope: 'row' }, c.name + (c.count > 1 ? ' × ' + c.count : ''), ...(c.fx ?? []).map((x) => chip_node(tr, env, x, (c.fx ?? []).length > 1))), // подпись курса и возраста у пересчитанной суммы; разных подписей несколько — у каждой число платежей
    h('td', { class: 'num', text: f.money(c.amount_minor) }), h('td', { class: 'num', text: f.bp(c.share_bp) }), h('td', { class: 'num', text: f.bp(c.cum_bp) }),
    h('td', { text: LABELS.causes[S.lang][c.cause] })));
  const cf_rows = ex.counterfactuals.map((c) => h('tr', null,
    h('th', { scope: 'row' }, c.kind === 'without' ? tr('wy.without', { name: c.name }) : tr('wy.no_delay', { name: c.name }), ...(c.fx ?? []).map((x) => chip_node(tr, env, x, (c.fx ?? []).length > 1))),
    h('td', { class: 'num', text: f.money(c.new_min.amount_minor) + ' · ' + f.short(c.new_min.date) }), h('td', { class: 'num', text: '+' + f.money(c.delta_minor) })));
  open_dialog(tr('wy.title', { value: f.money(ex.point.amount_minor), date: f.date(ex.point.date) }), head,
    h('p', { text: tr('wy.peak', { value: f.money(ex.peak.amount_minor), date: f.date(ex.peak.date), drop: f.money(ex.peak.amount_minor - ex.point.amount_minor) }) }),
    h('h3', { text: tr('wy.chain') }),
    table(tr('wy.chain'), [tr('c.name'), tr('wy.col_amount'), tr('wy.col_share'), tr('wy.col_cum'), tr('wy.col_cause')], chain_rows),
    h('h3', { text: tr('wy.counter') }),
    table(tr('wy.counter'), [tr('c.name'), tr('wy.col_new_min'), tr('wy.col_delta')], cf_rows),
    h('p', { class: 'muted', text: tr('wy.footer', { ref: ex.ref ?? tr('c.na'), version: ENGINE_VERSION, hash: S.model.ctx.inputs_hash.slice(0, 8) }) }), extra);
}

function show_breakdown(T, mode) {
  const f = fmt();
  const m = sts_model(S.model, T, mode);
  if (m === null) return;
  const labels = { opening: 'bd.opening', reserves_start: 'bd.reserves_start', payments: 'bd.payments', incomes: 'bd.incomes', released: 'bd.released', reserve_adds: 'bd.reserve_adds', buffer: 'bd.buffer' };
  const rows = m.rows.map((r) => h('tr', null, h('th', { scope: 'row', text: tr(labels[r.id]) }), h('td', { class: 'num', text: f.money(r.v) })));
  rows.push(h('tr', { class: 'total' }, h('th', { scope: 'row', text: tr('bd.total') }), h('td', { class: 'num', text: f.money(m.total) })));
  open_dialog(tr('bd.title'), h('p', { text: tr('bd.lead') + ' ' + mode_label(mode) + ' · ' + f.date(T) + '. ' + tr('bd.min_free') + ': ' + f.money(m.min_free) + '.' }),
    table(tr('bd.title'), [tr('c.name'), tr('c.value')], rows));
}

// ── график ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function build_chart(cm, f, cursor_index) {
  const pl = cm.plot;
  const svg = s('svg', { class: 'chart', viewBox: '0 0 ' + cm.w + ' ' + cm.h, width: cm.w, height: cm.h, role: 'img', 'aria-labelledby': 'chart-title chart-desc' },
    s('title', { id: 'chart-title', text: tr('ov.chart_label') }), s('desc', { id: 'chart-desc', text: tr('ov.chart_desc') }),
    s('defs', null, s('pattern', { id: 'hatch', width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, s('line', { x1: 0, y1: 0, x2: 0, y2: 7, class: 'hatch-line' }))));
  for (const tk of cm.yticks) {
    svg.append(s('line', { x1: pl.x0, x2: pl.x1, y1: tk.y.toFixed(1), y2: tk.y.toFixed(1), class: 'gridline' }),
      s('text', { x: pl.x0 - 6, y: (tk.y + 4).toFixed(1), class: 'axis', 'text-anchor': 'end', text: f.money0(tk.v) }));
  }
  for (const tk of cm.xticks) {
    svg.append(s('line', { x1: tk.x.toFixed(1), x2: tk.x.toFixed(1), y1: pl.y1, y2: pl.y1 + 4, class: 'tick' }),
      s('text', { x: tk.x.toFixed(1), y: pl.y1 + 18, class: 'axis', 'text-anchor': 'middle', text: f.short(tk.d) }));
  }
  for (const wv of cm.waves) {
    svg.append(s('rect', { x: wv.x.toFixed(1), y: pl.y0, width: Math.max(wv.w, 2).toFixed(1), height: pl.y1 - pl.y0, class: 'wave', fill: 'url(#hatch)' }),
      s('text', { x: (wv.x + wv.w / 2).toFixed(1), y: pl.y0 + 11, class: 'wave-label', 'text-anchor': 'middle', text: tr('c.wave', { n: wv.n }) }));
  }
  svg.append(s('line', { x1: pl.x0, x2: pl.x1, y1: cm.zero.y.toFixed(1), y2: cm.zero.y.toFixed(1), class: 'zero' }));
  if (cm.buffer !== null) {
    svg.append(s('line', { x1: pl.x0, x2: pl.x1, y1: cm.buffer.y.toFixed(1), y2: cm.buffer.y.toFixed(1), class: 'buffer' }),
      s('text', { x: pl.x1, y: (cm.buffer.y - 5).toFixed(1), class: 'buffer-label', 'text-anchor': 'end', text: tr('chart.buffer', { value: f.money(cm.buffer.v) }) }));
  }
  svg.append(s('line', { x1: cm.today_x.toFixed(1), x2: cm.today_x.toFixed(1), y1: pl.y0, y2: pl.y1, class: 'today' }),
    s('text', { x: (cm.today_x + 4).toFixed(1), y: pl.y1 - 6, class: 'today-label', text: tr('chart.today') }));
  if (cm.paths.past !== null) svg.append(s('path', { d: cm.paths.past, class: 'line past' }));
  svg.append(s('path', { d: cm.paths.plan_close, class: 'line plan thin' }), s('path', { d: cm.paths.worse_close, class: 'line worse thin' }),
    s('path', { d: cm.paths.plan_trough, class: 'line plan' }), s('path', { d: cm.paths.worse_trough, class: 'line worse' }));
  for (const m of MODES) {
    const np = cm.narrow[m];
    svg.append(s('circle', { cx: np.x.toFixed(1), cy: np.y.toFixed(1), r: m === S.mode ? 5.5 : 4, class: 'narrow ' + m }));
  }
  const np = cm.narrow[S.mode];
  const right = np.x > (pl.x0 + pl.x1) / 2;
  svg.append(s('text', { x: (np.x + (right ? -9 : 9)).toFixed(1), y: (np.y - 9).toFixed(1), class: 'narrow-label', 'text-anchor': right ? 'end' : 'start',
    text: tr('chart.narrow', { value: f.money(np.v), date: f.short(np.d) }) }));
  const cur = s('g', { class: 'cursor' },
    s('line', { class: 'cursor-line', y1: pl.y0, y2: pl.y1, x1: 0, x2: 0 }),
    s('circle', { class: 'cursor-dot plan', r: 3.5, cx: 0, cy: 0 }), s('circle', { class: 'cursor-dot worse', r: 3.5, cx: 0, cy: 0 }));
  svg.append(cur);
  const place = (i) => {
    const a = S.model.ctx;
    const d = a.series.plan.from + i;
    const x = cm.x(d).toFixed(1);
    cur.querySelector('.cursor-line').setAttribute('x1', x);
    cur.querySelector('.cursor-line').setAttribute('x2', x);
    for (const m of MODES) {
      const dot = cur.querySelector('.cursor-dot.' + m);
      dot.setAttribute('cx', x);
      dot.setAttribute('cy', cm.y(a.series[m].trough[i]).toFixed(1));
    }
  };
  place(cursor_index);
  return { svg, place };
}

function chart_card() {
  const a = S.model.ctx;
  const f = fmt();
  const N = horizon_days_of(S.model);
  const wrap = h('div', { class: 'chart-wrap' });
  const readout = h('p', { class: 'readout', 'aria-live': 'off' });
  const free_off = free_gate_since(); // FP-47: правило отключено — в подписи точки нет «свободно», вместо него текст с датой
  const idx0 = Math.min(narrowest_point(a.series[S.mode], a.as_of, a.horizon_end).date - a.as_of, N - 1);
  const slider = h('input', { id: 'chart-day', type: 'range', min: 0, max: N - 1, step: 1, value: idx0 });
  let place = () => {};
  const upd = (i) => {
    const d = a.series.plan.from + i;
    const x = (m, k) => f.money(a.series[m][k][i]);
    readout.textContent = free_off === null
      ? tr('ov.readout', { date: f.date(d), tp: x('plan', 'trough'), cp: x('plan', 'close'), fp: x('plan', 'free'), tw: x('worse', 'trough'), cw: x('worse', 'close'), fw: x('worse', 'free') })
      : tr('ov.readout_masked', { date: f.date(d), tp: x('plan', 'trough'), cp: x('plan', 'close'), tw: x('worse', 'trough'), cw: x('worse', 'close'), since: free_off });
    const close = a.series[S.mode].close[i]; // фраза для скринридера (REQ-167): «остаток 31 октября 2 055,00 евро» — дата и сумма словами, без знака валюты
    slider.setAttribute('aria-valuetext', tr('ov.readout_sr', { date: spoken_date(S.lang, format_date(d), S.model.as_of_iso), value: spoken_money(S.lang, close, S.model.cur, f.money(close)) }));
    place(i);
  };
  const draw = () => {
    const width = Math.max(300, Math.min(Math.floor(wrap.clientWidth || 720), 960));
    const cm = chart_model(S.model, S.mode, { w: width, h: width < 480 ? 290 : 340 });
    const b = build_chart(cm, f, Number(slider.value));
    place = b.place;
    wrap.replaceChildren(b.svg);
    b.svg.addEventListener('pointermove', (ev) => {
      const box = b.svg.getBoundingClientRect();
      const vx = ((ev.clientX - box.left) * cm.w) / Math.max(box.width, 1);
      const d = Math.round(cm.first + ((vx - cm.plot.x0) * (cm.last - cm.first)) / (cm.plot.x1 - cm.plot.x0));
      const i = Math.min(Math.max(d - a.as_of, 0), N - 1);
      slider.value = String(i);
      upd(i);
    });
    upd(Number(slider.value));
  };
  slider.addEventListener('input', () => upd(Number(slider.value)));
  let timer = null;
  if (typeof ResizeObserver === 'function') {
    let last_w = 0;
    new ResizeObserver(() => {
      const w = Math.floor(wrap.clientWidth);
      if (w === last_w || w === 0) return;
      last_w = w;
      if (timer !== null) cancelAnimationFrame(timer);
      timer = requestAnimationFrame(draw);
    }).observe(wrap);
  }
  requestAnimationFrame(draw);
  const swatch = (cls) => {
    const sw = s('svg', { class: 'swatch', width: 28, height: 12, viewBox: '0 0 28 12', 'aria-hidden': 'true' });
    if (cls === 'wave') sw.append(s('rect', { x: 1, y: 1, width: 26, height: 10, class: 'wave', fill: 'url(#hatch)' }));
    else if (cls === 'narrow') sw.append(s('circle', { cx: 8, cy: 6, r: 4.5, class: 'narrow plan' }), s('circle', { cx: 20, cy: 6, r: 4.5, class: 'narrow worse' }));
    else sw.append(s('line', { x1: 1, x2: 27, y1: 6, y2: 6, class: cls === 'buffer' ? 'buffer' : cls === 'today' ? 'today' : 'line ' + cls }));
    return sw;
  };
  const legend = h('ul', { class: 'legend' }, [
    ['plan', 'lg.plan_trough'], ['plan thin', 'lg.plan_close'], ['worse', 'lg.worse_trough'], ['worse thin', 'lg.worse_close'],
    ['buffer', 'lg.buffer'], ['wave', 'lg.wave'], ['today', 'lg.today'], ['past', 'lg.past'], ['narrow', 'lg.narrow'],
  ].map(([cls, key]) => h('li', null, swatch(cls), ' ', tr(key))));
  return h('section', { class: 'card', 'aria-labelledby': 'chart-h' },
    h('h3', { id: 'chart-h', text: tr('ov.chart_title') }), wrap,
    h('div', { class: 'slider-row' }, h('label', { for: 'chart-day', text: tr('ov.slider') }), slider), readout, legend);
}

function values_table() {
  const f = fmt();
  const free_off = free_gate_since(); // FP-47: правило отключено — столбцов «свободно» нет, над таблицей стоит текст с датой
  const rows = table_rows(S.model).map((r) => h('tr', { class: r.narrow.length > 0 ? 'mark' : null },
    h('th', { scope: 'row', text: f.short(r.d) + (r.d === S.model.ctx.as_of ? ' · ' + tr('c.today') : '') }),
    h('td', { text: [r.wave === null ? '' : tr('c.wave', { n: r.wave }), r.narrow.length > 0 ? tr('ov.narrow_mark') + ' (' + r.narrow.map(mode_label).join(', ') + ')' : ''].filter(Boolean).join('; ') }),
    ...MODES.flatMap((m) => [h('td', { class: 'num', text: f.money(r[m].close) }), h('td', { class: 'num', text: f.money(r[m].trough) }), ...(free_off === null ? [h('td', { class: 'num', text: f.money(r[m].free) })] : [])])));
  const head = [tr('c.date'), tr('c.status'),
    ...MODES.flatMap((m) => [mode_label(m) + ': ' + tr('c.close_eod'), mode_label(m) + ': ' + tr('c.trough'), ...(free_off === null ? [mode_label(m) + ': ' + tr('c.free')] : [])])];
  const n = horizon_days_of(S.model); // строк в таблице: день расчёта и дни вперёд
  const ahead = horizon_ahead_of(S.model); // дней вперёд — то же число и то же выражение, что в шапке (FP-49: заголовок говорит о строках, а не о днях горизонта)
  const caption = tr(free_off === null ? 'ov.table_caption' : 'ov.table_caption_masked');
  return h('details', { class: 'card values' }, h('summary', { text: tr('ov.table', { n, rows: word_form(S.lang, 'row', n), ahead, days: word_form(S.lang, 'day', ahead) }) }),
    free_off === null ? null : h('p', { class: 'muted', id: 'ov-table-free-off', text: tr('ov.table_free_masked', { since: free_off }) }),
    h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': caption }, table(caption, head, rows, 'tbl wide')));
}

// ── экраны ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function view_title(key, lead_key) {
  return [h('h2', { id: 'view-title', tabindex: '-1', text: tr(key) }), h('p', { class: 'lead', text: tr(lead_key) })];
}

function view_overview() {
  const a = S.model.ctx;
  const f = fmt();
  const root = h('div', { class: 'view' }, view_title('ov.title', 'ov.lead'));
  if (a.readiness.score < (a.params['ready.q1'] ?? 3)) {
    root.append(h('p', { class: 'banner', role: 'status', text: tr('ov.empty') }), ...slot('overview.cards')); // карточка «Готовность данных» нужна именно здесь
    return root;
  }
  const q1_input = h('input', { id: 'q1-date', type: 'date', min: format_date(a.as_of), max: format_date(a.horizon_end), value: S.q1_d ?? format_date(a.horizon_end) });
  const sts_input = h('input', { id: 'sts-date', type: 'date', min: format_date(a.as_of), max: format_date(a.horizon_end), value: S.sts_t ?? format_date(default_sts_horizon(a)) });
  const narrow_box = h('div', { class: 'card' });
  const q1_box = h('div', { class: 'card' });
  const sts_box = h('div', { class: 'card' });
  const state_box = h('div', { class: 'state', role: 'status' });
  const fill = () => {
    let ov;
    try {
      ov = overview_model(S.model, { D: q1_input.value || undefined, T: sts_input.value || undefined });
    } catch (e) {
      q1_box.replaceChildren(h('p', { class: 'error', text: err_text(e) }));
      return;
    }
    const B = ov.B;
    narrow_box.replaceChildren(h('h3', { text: tr('ov.narrow') }),
      h('ul', { class: 'plain' }, MODES.map((m) => h('li', { class: m === S.mode ? 'sel' : null },
        h('strong', { text: mode_label(m) + ': ' }), tr('ov.narrow_line', { value: f.money(ov.per_mode[m].narrow.amount_minor), date: f.date(ov.per_mode[m].narrow.date) }), ' ', why_button(m)))),
      h('p', null, ask_btn('as.q_why', 'as.t_narrow')));
    q1_box.replaceChildren(h('h3', null, h('label', { for: 'q1-date', text: tr('ov.q1_label') })), q1_input,
      h('ul', { class: 'plain' }, MODES.map((m) => h('li', null, h('strong', { text: mode_label(m) + ': ' }), q1_sentence(ov.per_mode[m], B, f, m)))),
      h('p', null, ask_btn('as.q_until', 'as.t_q1', { date: format_date(ov.D) })));
    sts_box.replaceChildren(h('h3', null, h('label', { for: 'sts-date', text: tr('ov.sts_title') + ' · ' + tr('ov.sts_label') })), sts_input, ...sts_lines(ov, f), h('p', null, ask_btn('as.q_max', 'as.t_sts', { date: format_date(ov.T) })));
    const worst = ov.per_mode[S.mode];
    const q = worst.q1;
    const tight = q.beyond_horizon !== true && !q.ok_buffer;
    state_box.replaceChildren(...(tight ? [h('p', { class: 'banner ' + (q.ok_cash ? 'tight' : 'short'), text: q1_sentence(worst, B, f, S.mode) })] : []));
  };
  q1_input.addEventListener('change', () => { S.q1_d = q1_input.value || null; fill(); });
  sts_input.addEventListener('change', () => { S.sts_t = sts_input.value || null; fill(); });
  fill();
  const rates_note = rates_note_node(); // курсы, по которым пересчитаны события и остатки в чужой валюте (REQ-077, REQ-079)
  // две колонки от 1024 px (U23, стили раскладки подключает пакет доступности): слева числа и карточки, справа график и ссылки; в DOM они идут в том же порядке, что на экране, а на узких окнах — одной колонкой, как раньше.
  // «Таблица значений» (восемь столбцов, min-width шире правой колонки) стоит под обеими колонками на всю ширину: в узкой правой колонке она всегда требовала бы прокрутки вбок
  root.append(h('div', { class: 'view--split' },
    h('div', { class: 'split-main' }, state_box, h('div', { class: 'grid' }, narrow_box, q1_box, sts_box), ...(rates_note === null ? [] : [rates_note]), ...slot('overview.cards', Object.freeze({ sts_t: S.sts_t }))), // sts_t — дата из поля «Можно потратить» (FP-28: карточка «Куда делись деньги» раскладывает на неё)
    h('div', { class: 'split-side' }, chart_card(),
      h('p', { class: 'actions' }, h('a', { class: 'btn', href: '#buy', text: tr('ov.go_buy') }), ' ', h('a', { class: 'btn', href: '#scenarios', text: tr('ov.go_scn') })))),
    values_table());
  return root;
}

function sts_lines(ov, f) {
  const main = ov.per_mode[S.mode];
  if (main.gated) return [h('p', { class: 'banner', text: tr('ov.sts_gate', { reason: gate_text(main.sts.reason) }) })];
  const lines = [];
  const short_modes = MODES.filter((m) => ov.per_mode[m].sts.short_to_buffer > 0);
  const ok_modes = MODES.filter((m) => !short_modes.includes(m));
  if (ok_modes.length > 0) {
    const mm = ok_modes.includes(S.mode) ? S.mode : ok_modes[0];
    const oo = mm === 'plan' ? 'worse' : 'plan';
    lines.push(h('p', { text: tr('ov.sts_main', {
      date: f.date(ov.T), value: f.money(ov.per_mode[mm].sts.sts), buffer: f.money(ov.B), mode: mode_label(mm), mode2: mode_label(oo), value2: f.money(ov.per_mode[oo].sts.sts),
      at: f.date(ov.per_mode[mm].sts.at), res_at: f.money(ov.per_mode[mm].reserve_at_min), res_now: f.money(ov.reserve_now),
    }) }));
  }
  for (const m of short_modes) lines.push(h('p', { text: tr('ov.sts_short', { date: f.date(ov.T), value: f.money(ov.per_mode[m].sts.short_to_buffer), mode: mode_label(m) }) + ' ' + income_tail(m, ov.per_mode[m].sts.at) + below_tail(false, ov.per_mode[m].free_first_below) }));
  if (main.sts.sts_horizon < main.sts.sts) {
    lines.push(h('p', { text: main.sts.sts_horizon === 0
      ? tr('ov.sts_horizon_short', { date: f.date(ov.horizon_end), value: f.money(main.short_horizon) }) + ' ' + income_tail(S.mode, main.min_free_h_at) + below_tail(false, main.free_first_below_h)
      : tr('ov.sts_horizon', { date: f.date(ov.horizon_end), value: f.money(main.sts.sts_horizon) }) }));
  }
  lines.push(h('p', null, h('button', { type: 'button', class: 'link', onclick: () => show_breakdown(ov.T, S.mode), text: tr('ov.sts_how') })));
  if (S.model.ws.reserves?.some((r) => r.kind === 'tax')) lines.push(h('p', { class: 'muted', text: tr('c.tax_note') }));
  return lines;
}

function default_buy(model) {
  const ws = model.ws;
  const a = model.ctx;
  const p = (ws.purchases ?? []).find((x) => x.parts.length === 1);
  const amount = p !== undefined ? p.parts[0].amount_minor : Math.max(100, Math.round(a.series.plan.opening_minor / 1000) * 100);
  const date = p !== undefined && parse_date(p.parts[0].date) >= a.as_of && parse_date(p.parts[0].date) <= a.horizon_end ? p.parts[0].date : format_date(a.as_of);
  return { amount_minor: amount, date, purchase_id: null };
}

function view_buy() {
  const a = S.model.ctx;
  const f = fmt();
  const cur = S.model.cur;
  if (S.buy === null) S.buy = default_buy(S.model);
  const N = horizon_days_of(S.model);
  const multi = (S.model.ws.purchases ?? []).filter((p) => p.parts.length > 1);
  const amount_in = h('input', { id: 'buy-amount', type: 'text', inputmode: 'decimal', autocomplete: 'off', value: format_plain(S.buy.amount_minor) });
  const date_in = h('input', { id: 'buy-date', type: 'date', min: format_date(a.as_of), max: format_date(a.horizon_end), value: S.buy.date });
  const slider_max = Math.max(100000, Math.ceil(a.series.plan.opening_minor / 10000) * 10000);
  const amount_rng = h('input', { id: 'buy-amount-rng', type: 'range', min: 0, max: slider_max, step: 10 ** Math.max(f.exp - 1, 0) * 10, value: Math.min(S.buy.amount_minor, slider_max) });
  const date_rng = h('input', { id: 'buy-date-rng', type: 'range', min: 0, max: N - 1, step: 1, value: Math.min(Math.max(parse_date(S.buy.date) - a.as_of, 0), N - 1) });
  const kind_sel = h('select', { id: 'buy-kind' }, h('option', { value: '', text: tr('buy.single') }),
    multi.map((p) => h('option', { value: p.purchase_id, selected: S.buy.purchase_id === p.purchase_id, text: label_of(S.lang, p.purchase_id, p.name) })));
  const out = h('div', { class: 'card result', 'aria-live': 'polite' });
  const live = {}; // FP-21: метка этой отрисовки; render_main обнуляет S.buy_live, и поздний ответ Worker в отсоединённый узел не рисует
  let want = null; // ключ последнего запроса к Worker: ответ на более старый запрос не рисуется
  S.buy_live = live;
  const show = (input, multi_part, ready) => {
    const r = buy_run(S.model, input, S.lang, ready);
    out.replaceChildren(...render_buy_result(r, input, multi_part));
    // FP-48: вердикт называется, только когда он изменился. Помнит его `S.buy_said`, а не эта отрисовка: хранилище (FP-05) после каждой записи просит перерисовать страницу ещё раз,
    // и новая отрисовка с тем же вердиктом затирала в живой области «Добавлен расход …» или «Отменено: …» словами «Вердикт: …».
    if (r.ok && r.view.kind === 'ok' && r.view.verdict !== S.buy_said) {
      S.buy_said = r.view.verdict;
      say_verdict(tr('buy.verdict') + ': ' + LABELS.verdicts[S.lang][r.view.verdict]);
    }
  };
  const run = () => {
    const parts_p = multi.find((p) => p.purchase_id === S.buy.purchase_id) ?? null;
    let input;
    want = null;
    if (parts_p !== null) {
      const dates = parts_p.parts.map((x) => x.date).sort();
      input = { date: dates[0], amount_minor: parts_p.parts.reduce((acc, x) => acc + x.amount_minor, 0), parts: parts_p.parts.map((x) => ({ date: x.date, amount_minor: x.amount_minor })) };
    } else {
      const amt = parse_amount_lenient(amount_in.value, f.exp);
      if (amt === null) { mark_busy(out, false); out.replaceChildren(h('p', { class: 'error', text: tr('buy.bad_amount') })); return; }
      let ok_date = true;
      try { ok_date = parse_date(date_in.value) >= a.as_of; } catch { ok_date = false; }
      if (!ok_date) { mark_busy(out, false); out.replaceChildren(h('p', { class: 'error', text: tr('buy.bad_date') })); return; }
      S.buy.amount_minor = amt;
      S.buy.date = date_in.value;
      input = { date: date_in.value, amount_minor: amt };
    }
    // FP-21: «деньги после покупки» (второй расчёт ответа) идут в Worker; несколько правок за кадр дают один пересчёт. Нет Worker — считаем на месте, как раньше.
    const job = calc.afford(S.model, input.parts ?? [{ date: input.date, amount_minor: input.amount_minor }]);
    if (job === null || job.value !== undefined) { mark_busy(out, false); show(input, parts_p !== null, job === null ? null : job.value); return; }
    want = job.key;
    mark_busy(out, true);
    if (out.children.length === 0) out.replaceChildren(...skeleton_nodes(tr('app.calc'))); // первый показ — скелет; прежний ответ остаётся на месте под отметкой «занято»
    job.promise.then((res) => {
      if (res === SUPERSEDED || S.buy_live !== live || want !== job.key) return;
      mark_busy(out, false);
      try { show(input, parts_p !== null, res.value); } catch (e) { out.replaceChildren(h('p', { class: 'banner short', role: 'alert', text: tr('app.calc_error', { code: e?.code ?? 'E_SCHEMA' }) })); }
    });
  };
  const lock = (on) => { amount_in.disabled = on; date_in.disabled = on; amount_rng.disabled = on; date_rng.disabled = on; };
  amount_in.addEventListener('input', () => { const v = parse_amount_lenient(amount_in.value, f.exp); if (v !== null) amount_rng.value = String(Math.min(v, slider_max)); run(); });
  date_in.addEventListener('input', () => { try { date_rng.value = String(Math.min(Math.max(parse_date(date_in.value) - a.as_of, 0), N - 1)); } catch { /* пусто */ } run(); });
  amount_rng.addEventListener('input', () => { amount_in.value = format_plain(Number(amount_rng.value)); run(); });
  date_rng.addEventListener('input', () => { date_in.value = format_date(a.as_of + Number(date_rng.value)); run(); });
  kind_sel.addEventListener('change', () => { S.buy.purchase_id = kind_sel.value === '' ? null : kind_sel.value; lock(S.buy.purchase_id !== null); run(); });
  lock(S.buy.purchase_id !== null);
  run();
  return h('div', { class: 'view' }, view_title('buy.title', 'buy.lead'),
    h('div', { class: 'card form' },
      multi.length > 0 ? h('div', { class: 'field' }, h('label', { for: 'buy-kind', text: tr('buy.kind') }), kind_sel) : null,
      h('div', { class: 'field' }, h('label', { for: 'buy-amount', text: tr('buy.amount', { cur }) }), amount_in, h('label', { for: 'buy-amount-rng', class: 'sr-only', text: tr('buy.amount_slider') }), amount_rng),
      h('div', { class: 'field' }, h('label', { for: 'buy-date', text: tr('buy.date') }), date_in, h('label', { for: 'buy-date-rng', class: 'sr-only', text: tr('buy.date_slider') }), date_rng),
      h('p', { class: 'muted', text: a.buffer_minor === null ? tr('hdr.buffer_unset') : tr('hdr.buffer', { value: f.money(a.buffer_minor) }) }),
      ...slot('buy.form', Object.freeze({ rerun: () => run() }))), // FP-28: переключатель «разбить на N платежей»; rerun пересчитывает ответ после смены его полей
    out);
}

/** Сумма без символа валюты для поля ввода: целая часть и дробь по знакам валюты, десятичный знак — по языку. */
function format_plain(v) {
  const f = fmt();
  return f.money(v).replace(/[^\d,.−\-]/g, '').replace('−', '-');
}

function render_buy_result(r, input, multi_part) {
  const f = fmt();
  if (!r.ok) return [h('p', { class: 'error', text: err_text({ code: r.code }) })];
  const v = r.view;
  const nodes = [];
  const split_slot = () => slot('buy.result', Object.freeze({ date: input.date, amount_minor: input.amount_minor, multi_part })); // FP-28: включённая разбивка отвечает и тогда, когда основного вердикта нет (названо, почему)
  if (v.kind === 'insufficient_data') {
    nodes.push(h('h3', { text: tr('buy.gate_title') }), h('p', { class: 'banner', text: gate_text(v.reason) }), h('p', { class: 'muted', text: r.text }), calc_chip(r.result, r.ref), ...split_slot());
    return nodes;
  }
  if (v.kind === 'outside_horizon') {
    nodes.push(h('p', { class: 'banner', text: r.text }), calc_chip(r.result, r.ref), ...split_slot());
    return nodes;
  }
  const a = S.model.ctx;
  const ov = overview_model(S.model);
  nodes.push(h('h3', null, tr('buy.verdict') + ': ', verdict_badge(v.verdict)));
  if (v.beyond > 0) nodes.push(h('p', { class: 'banner', text: tr('buy.beyond', { value: f.money(v.beyond) }) }));
  const rows = MODES.map((m) => {
    const x = v.by_mode[m];
    const text = x.margin === 0 ? tr('buy.row_zero', { value: f.money(x.m_after), date: f.date(x.at) })
      : tr('buy.row', { value: f.money(x.m_after), date: f.date(x.at), margin: f.money(Math.abs(x.margin)), where: x.margin < 0 ? tr('c.below_buffer') : tr('c.above_buffer') });
    return h('li', null, h('strong', { text: mode_label(m) + ': ' }), text, ' ', why_button(m));
  });
  nodes.push(h('h4', { text: tr('buy.after') }), h('ul', { class: 'plain' }, rows));
  if (v.cash_after !== null) {
    nodes.push(h('h4', { text: tr('buy.cash_after') }),
      h('ul', { class: 'plain' }, MODES.map((m) => h('li', null, h('strong', { text: mode_label(m) + ': ' }), f.money(v.cash_after[m].v) + ' · ' + f.date(v.cash_after[m].d)))));
  }
  if (v.s_max !== null) {
    nodes.push(h('h4', { text: tr('buy.smax', { date: f.date(input.date) }) }),
      h('ul', { class: 'plain' }, MODES.map((m) => h('li', null, h('strong', { text: mode_label(m) + ': ' }), f.money(v.s_max[m])))));
    nodes.push(h('h4', { text: tr('buy.earliest') }),
      h('ul', { class: 'plain' }, MODES.map((m) => h('li', null, h('strong', { text: mode_label(m) + ': ' }), v.earliest[m] === null ? tr('buy.earliest_none') : f.date(v.earliest[m])))));
  } else if (multi_part) nodes.push(h('p', { class: 'muted', text: tr('buy.multi_note') }));
  const flags = [];
  if (v.flags.worse_gap) flags.push(tr('buy.flag_worse_gap'));
  if (v.flags.cash_gap) flags.push(tr('buy.flag_cash_gap'));
  if (v.flags.baseline_below_buffer) flags.push(tr('buy.flag_baseline'));
  nodes.push(h('h4', { text: tr('buy.flags') }), flags.length === 0 ? h('p', { text: tr('buy.flags_none') }) : h('ul', { class: 'plain' }, flags.map((x) => h('li', { text: x }))));
  if (v.verdict === 'NO' && v.flags.baseline_below_buffer && ov.per_mode.plan.narrow.amount_minor >= 0) {
    nodes.push(h('p', { class: 'banner tight', text: tr('buy.cash_but_reserved', { value: f.money(ov.per_mode.plan.narrow.amount_minor) }) }));
    const lines = MODES.filter((m) => !ov.per_mode[m].gated && ov.per_mode[m].sts.short_to_buffer > 0)
      .map((m) => mode_label(m) + ': ' + tr('buy.short_to_buffer', { value: f.money(ov.per_mode[m].sts.short_to_buffer) }) + ' ' + income_tail(m, ov.per_mode[m].sts.at) + below_tail(false, ov.per_mode[m].free_first_below));
    if (lines.length > 0) nodes.push(h('p', { text: lines.join(' ') }));
  }
  nodes.push(...split_slot()); // FP-28: та же покупка, разбитая на платежи
  nodes.push(h('details', { class: 'sentence' }, h('summary', { text: tr('buy.sentence') }), h('p', { text: r.text })));
  if (a.reserve.plan !== undefined && (S.model.ws.reserves ?? []).some((x) => x.kind === 'tax')) nodes.push(h('p', { class: 'muted', text: tr('c.tax_note') }));
  const rates_note = rates_note_node(); // курсы, по которым пересчитан вердикт: события и остатки счетов в чужой валюте (REQ-077, REQ-079)
  if (rates_note !== null) nodes.push(rates_note);
  nodes.push(h('p', { class: 'muted', text: tr('buy.liquidity') }),
    h('p', { class: 'actions' },
      multi_part ? null : h('button', { type: 'button', class: 'btn', onclick: () => add_scenario({ kind: 'purchase', amount_minor: input.amount_minor, date: input.date }, true), text: tr('buy.save') }),
      ' ', calc_chip(r.result, r.ref), ' ', multi_part ? null : ask_btn('as.q_when', 'as.t_buy', { amount: ask_amount(input.amount_minor) })));
  return nodes;
}

/** Копия волны для блоков слота карточки волны (S1.5): массивы заморожены, чтобы чужой блок не мог подменить данные карточки соседям по слоту и календарю. */
function frozen_wave(w) {
  return Object.freeze(Object.fromEntries(Object.entries(w).map(([k, v]) => [k, Array.isArray(v) ? Object.freeze(v.slice()) : v])));
}

function view_waves() {
  const f = fmt();
  const wm = waves_model(S.model, S.lang);
  const root = h('div', { class: 'view' }, view_title('wv.title', 'wv.lead'));
  if (wm.items.length === 0) {
    root.append(h('p', { class: 'banner', text: tr('wv.empty', { value: f.money(wm.threshold ?? 0) }) }));
    return root;
  }
  const env = make_env(S.lang, S.model.ws, S.model.ctx);
  for (const it of wm.items) {
    const P = it.per.plan.metrics;
    const W = it.per.worse.metrics;
    const range = it.wave.start === it.wave.end ? f.short(it.wave.start) : f.short(it.wave.start) + ' – ' + f.short(it.wave.end);
    const next = (m) => (it.per[m].next_income === null ? tr('wv.no_income') : f.date(it.per[m].next_income));
    const gap_cell = (x) => h('td', { class: x.gap_minor > 0 ? 'num bad' : 'num', text: x.gap_minor > 0 ? tr('wv.status_gap', { value: f.money(x.gap_minor) }) : f.money(0) + ' · ' + tr('wv.status_ok') });
    root.append(h('section', { class: 'card wave-card', 'aria-labelledby': 'wave-h' + it.n },
      h('h3', { id: 'wave-h' + it.n, text: tr('wv.card', { n: it.n, range, count: it.members.length, payments: word_form(S.lang, 'payment', it.members.length), total: f.money(it.wave.total_out_minor) }) }),
      h('p', { class: 'members' }, h('strong', { text: tr('wv.members') + ': ' }), it.members.map((m) => m.name + ' ' + f.money(m.amount_minor) + ' (' + f.short(m.d) + ')').join(' · ')),
      it.members.some((m) => m.fx !== undefined) // подпись курса и возраста у каждого пересчитанного платежа (REQ-077, REQ-079)
        ? h('div', { class: 'rate-sigs-box' }, h('p', { class: 'muted', text: tr('ratechip.wave_title') + ':' }),
          h('ul', { class: 'rate-sigs' }, it.members.filter((m) => m.fx !== undefined).map((m) => h('li', { class: m.fx.sig.stale ? 'rate-stale' : null, text: wave_line_text(tr, env, m.name, m.fx) }))))
        : null,
      table(tr('wv.card', { n: it.n, range, count: it.members.length, payments: word_form(S.lang, 'payment', it.members.length), total: f.money(it.wave.total_out_minor) }),
        [tr('wv.metric'), mode_label('plan'), mode_label('worse')], [
          h('tr', null, h('th', { scope: 'row', text: tr('wv.cash') }), h('td', { class: 'num', text: f.money(P.cash_minor) }), h('td', { class: 'num', text: f.money(W.cash_minor) })),
          h('tr', null, h('th', { scope: 'row', text: tr('wv.need') }), h('td', { class: 'num', text: f.money(P.need_minor) }), h('td', { class: 'num', text: f.money(W.need_minor) })),
          h('tr', null, h('th', { scope: 'row', text: tr('wv.gap') }), gap_cell(P), gap_cell(W)),
          h('tr', null, h('th', { scope: 'row', text: tr('wv.coverage') }), h('td', { class: 'num', text: f.pm(P.coverage_pm) }), h('td', { class: 'num', text: f.pm(W.coverage_pm) })),
          h('tr', null, h('th', { scope: 'row', text: tr('wv.next_income') }), h('td', { text: next('plan') }), h('td', { text: next('worse') })),
        ]),
      h('p', { class: 'muted', text: tr('wv.reserved', { value: f.money(P.reserved_minor) }) }),
      ...ext.slot_nodes('waves.card', ext.ctx, Object.freeze({ wave: frozen_wave(it.wave), mode: S.mode, index: it.n - 1 })))); // слот waves.card (S1.5): блоки пакетов в конце каждой карточки; index — с нуля
  }
  root.append(calendar_block(wm, f), ...slot('waves.actions'));
  root.append(h('p', { class: 'muted', text: tr('wv.threshold', { value: f.money(wm.threshold ?? 0) }) }));
  return root;
}

function calendar_block(wm, f) {
  const months = calendar_model(S.model, wm.items);
  return h('section', { class: 'card', 'aria-labelledby': 'cal-h' }, h('h3', { id: 'cal-h', text: tr('wv.calendar') }),
    h('div', { class: 'cals' }, months.map((mo) => h('table', { class: 'cal' },
      h('caption', { text: MONTHS_FULL[S.lang][mo.m - 1] + ' ' + mo.y }),
      h('thead', null, h('tr', null, WEEKDAYS_SHORT[S.lang].map((d) => h('th', { scope: 'col', text: d })))),
      h('tbody', null, mo.weeks.map((wk) => h('tr', null, wk.map((c) => {
        if (c.d === null) return h('td', { class: 'empty' });
        const day = civil_from_days(c.d)[2];
        const label = c.wave !== null ? tr('wv.wave_day', { n: c.wave }) : c.today ? tr('c.today') : null;
        return h('td', { class: [c.in_horizon ? 'in' : 'out', c.wave !== null ? 'wave-day' : '', c.today ? 'today' : ''].join(' ').trim(), 'aria-label': f.date(c.d) + (label === null ? '' : ', ' + label) },
          h('span', { text: String(day) }), c.wave !== null ? h('small', { text: tr('c.wave', { n: c.wave }) }) : c.today ? h('small', { text: tr('c.today') }) : null);
      }))))))));
}

function view_reserves() {
  const f = fmt();
  const rm = reserves_model(S.model, S.mode);
  const ov = overview_model(S.model);
  // REQ-067 / REQ-108 (FP-15): правило не подтверждено дольше двух сроков годности — зависящие числа (резервы, «свободно», остатки конверта) заменяет текст «не подтверждено с <даты>»
  const masked = rm.tax_rules.some((x) => x.status === 'disabled');
  const since_all = masked ? (oldest_review_date(S.model.ws, S.model.ctx.as_of, S.model.ctx.rule_status, 'disabled') ?? tr('c.na')) : '';
  const root = h('div', { class: 'view' }, view_title('rs.title', 'rs.lead'));
  if (!rm.has_any) root.append(h('p', { class: 'banner', text: tr('rs.none') }));
  root.append(h('section', { class: 'card' }, h('h3', { text: tr('rs.free') }),
    masked ? h('p', { text: tr('rs.free_masked', { balance: f.money(rm.balance), since: since_all }) })
      : h('p', { text: tr('rs.free_line', { balance: f.money(rm.balance), reserved: f.money(rm.reserved_now), free: f.money(rm.free_now) }) }),
    masked ? null : h('p', { text: tr('rs.min_free', { plan: f.money(rm.min_free.plan.v), d_plan: f.date(rm.min_free.plan.d), worse: f.money(rm.min_free.worse.v), d_worse: f.date(rm.min_free.worse.d) }) })));
  const sts_card = h('section', { class: 'card' }, h('h3', { text: tr('rs.sts') }), ...sts_lines(ov, f));
  root.append(sts_card);
  if ((S.model.ws.tax_rules ?? []).length > 0) {
    const nodes = [h('h3', { text: tr('rs.tax') })];
    for (const x of rm.tax_rules) {
      nodes.push(h('p', null, h('strong', { text: tr('rs.tax_rule', { name: label_of(S.lang, x.rule.tax_rule_id, x.rule.name), rate: x.rule.rate_bp === undefined ? '' : f.bp(x.rule.rate_bp) }) })));
      const hidden = x.status === 'disabled'; // числа конверта под отключённым правилом не печатаются (C-024)
      if (!hidden && x.alloc !== null && x.alloc.income_minor !== null && x.rule.rate_bp !== undefined) {
        nodes.push(h('p', { text: tr('rs.tax_line', { income: f.money(x.alloc.income_minor), rate: f.bp(x.rule.rate_bp), value: f.money(x.alloc.amount_minor) }) }));
      }
      nodes.push(hidden ? h('p', { text: tr('rs.tax_masked', { since: review_date(S.model.ws, x.rule.tax_rule_id, S.model.ctx.as_of) ?? tr('c.na') }) })
        : h('p', { text: tr('rs.tax_in', { now: f.money(x.now), end: f.money(x.end) }) }),
      h('p', null, h('span', { class: 'state-chip ' + x.status, text: tr('rs.rule_state', { state: tr('rs.state_' + x.status) }) })));
      if (x.status !== 'fresh') nodes.push(h('p', { class: 'banner', text: warning_text({ code: x.status === 'stale' ? 'W_RULE_STALE' : 'W_RULE_DISABLED', rule_id: x.rule.tax_rule_id }) }));
    }
    if (rm.next_due !== null && rm.next_due.d !== undefined) nodes.push(h('p', { text: tr('rs.tax_next', { value: f.money(rm.next_due.amount_minor), date: f.date(rm.next_due.d) }) }));
    const nr = masked ? null : rm.next_release; // под отключённым правилом числа конверта не печатаются (C-024)
    if (nr !== null) nodes.push(h('p', { text: nr.true_up_minor === 0 ? tr('rs.tax_release_full', { date: f.date(nr.date), payment: f.money(nr.payment_minor) }) : tr('rs.tax_release', { date: f.date(nr.date), payment: f.money(nr.payment_minor), released: f.money(nr.released_minor), true_up: f.money(nr.true_up_minor) }) }));
    nodes.push(h('p', { class: 'muted', text: tr('c.tax_note') }), h('p', null, ask_btn('as.q_tax', 'as.t_tax')));
    root.append(h('section', { class: 'card' }, nodes));
  } else root.append(h('section', { class: 'card' }, h('h3', { text: tr('rs.tax') }), h('p', { text: tr('rs.tax_none') }), h('p', { class: 'muted', text: tr('c.tax_note') })));
  const sink = h('section', { class: 'card' }, h('h3', { text: tr('rs.sinking') }));
  if (rm.sinking.length === 0) sink.append(h('p', { text: tr('rs.sinking_none') }));
  for (const x of rm.sinking) {
    // накопление, которое пополняет отключённое правило, тоже не печатает суммы: «сейчас» и «к концу» зависят от правила (C-024; FP-15, дефект ADV-12)
    const off_since = reserve_off_since(S.model.ws, x.reserve, S.model.ctx.as_of, S.model.ctx.rule_status);
    const line = { name: label_of(S.lang, x.reserve.reserve_id, x.reserve.name), target: x.reserve.target_minor === undefined ? tr('c.na') : f.money(x.reserve.target_minor), due: x.reserve.due_date === undefined ? tr('c.na') : f.date(x.reserve.due_date) };
    sink.append(h('p', { text: off_since !== null ? tr('rs.sinking_masked', { ...line, since: off_since === '' ? tr('c.na') : off_since }) : tr('rs.sinking_line', { ...line, now: f.money(x.now), end: f.money(x.end) }) }));
    if (x.contrib.length > 0) sink.append(h('ul', { class: 'plain' }, x.contrib.slice(0, 3).map((c) => h('li', { text: tr('rs.sinking_contrib', { value: f.money(c.amount_minor), date: f.date(c.d) }) }))));
  }
  root.append(sink, ...(masked ? [] : [h('p', { class: 'muted', text: tr('rs.total_end', { value: f.money(rm.total_end) }) })]), ...slot('reserves.sections'));
  return root;
}

function add_scenario(sc, go) {
  if (S.cmp.length >= MAX_SCENARIOS) { S.notice = tr('sc.max'); render(); return; }
  if (sc.kind === 'delay' && first_income_ref(S.base) === null) { S.notice = tr('sc.no_income'); render(); return; }
  S.cmp.push({ ...sc, uid: S.cmp.length === 0 ? 1 : Math.max(...S.cmp.map((x) => x.uid)) + 1 });
  S.notice = tr('sc.added');
  if (go) location.hash = '#scenarios'; else render();
}

function scenario_model(sc) {
  const key = JSON.stringify(sc) + '|' + S.base.ctx.inputs_hash;
  if (!S.cmp_cache.has(key)) {
    const ops = scenario_ops(sc, S.base.ws, first_income_ref(S.base));
    S.cmp_cache.set(key, ops === null ? null : build_model(S.base.ws, { scenario: { ops }, lang: S.lang }));
  }
  return S.cmp_cache.get(key);
}

function view_scenarios() {
  const f = fmt();
  const base = S.base;
  const ref = first_income_ref(base);
  const buy_amount = S.buy?.amount_minor ?? default_buy(base).amount_minor;
  const buy_date = S.buy?.date ?? default_buy(base).date;
  const chips = [7, 14, 21, 30].map((n) => h('button', { type: 'button', class: 'chip', disabled: ref === null, onclick: () => add_scenario({ kind: 'delay', days: n }), text: tr('sc.chip_delay', { n, days: word_form(S.lang, 'day', n) }) }));
  chips.push(h('button', { type: 'button', class: 'chip', onclick: () => add_scenario({ kind: 'purchase', amount_minor: buy_amount, date: buy_date }), text: tr('sc.chip_purchase', { amount: f.money(buy_amount), date: f.date(buy_date) }) }));
  const saved = (base.ws.scenarios ?? []).map((sv) => h('button', { type: 'button', class: 'chip', onclick: () => add_scenario({ kind: 'saved', sid: sv.scenario_id }), text: label_of(S.lang, sv.scenario_id, sv.name) }));
  const root = h('div', { class: 'view' }, view_title('sc.title', 'sc.lead'),
    h('section', { class: 'card' }, h('h3', { text: tr('sc.chips') }), h('div', { class: 'chips' }, chips),
      saved.length > 0 ? h('div', null, h('h4', { text: tr('sc.saved') }), h('div', { class: 'chips' }, saved)) : null,
      ref === null ? h('p', { class: 'muted', text: tr('sc.no_income') }) : null,
      S.notice === null ? null : h('p', { class: 'muted', role: 'status', text: S.notice })));
  S.notice = null;
  const cols = [{ title: tr('sc.base'), model: base, sc: null }];
  for (const sc of S.cmp) {
    const m = scenario_model(sc);
    if (m !== null) cols.push({ title: scenario_name(sc, base.ws, S.lang, f), model: m, sc });
  }
  const snaps = cols.map((c) => snapshot_of(c.model));
  const q1_text = (k) => tr('sc.q1_' + k);
  const free_off = free_gate_since();
  const row = (label, cell) => h('tr', null, h('th', { scope: 'row', text: label }), snaps.map((sn, i) => h('td', { class: 'num' }, cell(sn, i))));
  const delta = (sn, i) => {
    if (i === 0) return '—';
    const d = sn.trough.worse.v - snaps[0].trough.worse.v;
    return (d > 0 ? '+' : '') + f.money(d);
  };
  const head = h('tr', null, h('th', { scope: 'col', text: tr('sc.col_scenario') }), cols.map((c, i) => h('th', { scope: 'col' },
    h('div', { text: c.title }),
    c.sc === null ? null : h('div', { class: 'col-actions' },
      h('button', { type: 'button', class: 'link', id: 'sc-apply-' + c.sc.uid, onclick: () => { keep_focus_after_render('sc-apply-' + c.sc.uid); S.scenario = c.sc; recompute(); render(); }, text: tr('sc.apply') }), ' ',
      h('button', { type: 'button', class: 'link', id: 'sc-remove-' + c.sc.uid, onclick: () => { keep_focus_after_render('sc-remove-' + c.sc.uid); S.cmp = S.cmp.filter((x) => x.uid !== c.sc.uid); if (S.scenario !== null && S.scenario.uid === c.sc.uid) S.scenario = null; recompute(); render(); }, text: tr('sc.remove') })))));
  const body = [
    row(tr('sc.row_trough_plan'), (sn) => f.money(sn.trough.plan.v) + ' · ' + f.short(sn.trough.plan.d)),
    row(tr('sc.row_trough_worse'), (sn) => f.money(sn.trough.worse.v) + ' · ' + f.short(sn.trough.worse.d)),
    row(tr('sc.row_free_plan'), (sn) => (free_off === null ? f.money(sn.free.plan) : tr('sc.free_masked', { since: free_off }))), // FP-47: правило отключено — вместо числа текст с датой
    row(tr('sc.row_free_worse'), (sn) => (free_off === null ? f.money(sn.free.worse) : tr('sc.free_masked', { since: free_off }))),
    row(tr('sc.row_q1'), (sn) => mode_label('plan') + ': ' + q1_text(sn.q1.plan) + '; ' + mode_label('worse') + ': ' + q1_text(sn.q1.worse)),
    row(tr('sc.row_sts'), (sn) => sts_cell_text(sn, S.mode, f, base.ctx.horizon_end, S.lang)),
    row(tr('sc.row_delta'), delta),
  ];
  root.append(h('section', { class: 'card' }, h('h3', { text: tr('sc.compare') }),
    h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': tr('sc.compare') },
      h('table', { class: 'tbl wide' }, h('caption', { class: 'sr-only', text: tr('sc.compare') }), h('thead', null, head), h('tbody', null, body))),
    S.cmp.length === 0 ? h('p', { class: 'muted', text: tr('sc.empty') }) : null), ...ext.slot_nodes('scenarios.after'));
  return root;
}

function view_feed() {
  const f = fmt();
  const a = S.model.ctx;
  const fm = feed_model(S.model, S.mode, S.lang);
  const root = h('div', { class: 'view' }, view_title('fd.title', 'fd.lead'));
  if (fm.past.length === 0 && fm.future.length === 0) {
    root.append(h('p', { class: 'banner', text: tr('fd.empty') }));
    return root;
  }
  root.append(...slot('feed.head', Object.freeze({ shown: fm.past.length, total: fm.past_total, limit: fm.past_limit }))); // FP-28: счётчик «Сверка: N» и оговорка об усечении до последних фактов
  const env = make_env(S.lang, S.model.ws, a);
  const amt = (v, cur) => h('td', { class: 'num ' + (v < 0 ? 'neg' : 'pos'), text: cur === undefined ? f.money(v) : money_in(env, cur, v) }); // факт в чужой валюте — в своей валюте (FP-16)
  const acts = (layer, i, r) => slot('feed.row', Object.freeze({ layer, index: i, id: r.id, name: r.name, date: format_date(r.d), amount_minor: r.amount_minor, mode: S.mode, transfer: r.transfer === true })); // FP-28: «Почему» и «Исправить» у строки ленты
  const past_rows = [...fm.past].reverse().map((r, i) => h('tr', null, h('td', { text: f.short(r.d) }), h('td', null, r.name, ...acts('past', i, r)), amt(r.amount_minor, r.currency), h('td', { text: tr('fd.layer_posted') })));
  const future_rows = fm.future.map((r, i) => h('tr', { class: r.status === 'overdue' ? 'overdue' : null },
    h('td', { text: f.short(r.d) }),
    h('td', null, r.name, r.wave !== null ? h('span', { class: 'tag', text: ' ' + tr('c.wave', { n: r.wave }) }) : null, r.fx === undefined ? null : chip_node(tr, env, r.fx), ...acts('future', i, r)), // подпись курса и возраста (REQ-077, REQ-079)
    amt(r.amount_minor),
    h('td', null, tr('st.' + r.status), r.other_d !== null ? h('span', { class: 'muted', text: ' *' }) : null)));
  const notes = fm.future.filter((r) => r.other_d !== null)
    .map((r) => h('li', { text: r.name + ' ' + tr(S.mode === 'plan' ? 'fd.worse_note' : 'fd.plan_note', { date: f.date(r.other_d) }) }));
  root.append(h('section', { class: 'card' },
    h('h3', { text: tr('fd.past') }), table(tr('fd.past'), [tr('c.date'), tr('c.name'), tr('fd.col_amount'), tr('c.status')], past_rows),
    h('div', { class: 'seam', role: 'separator' }, h('span', { text: tr('fd.seam', { date: f.date(a.as_of), value: f.money(a.series.plan.opening_minor) }) })),
    balance_note_node(), // остаток шва из счёта в чужой валюте — с подписью курса
    h('h3', { text: tr('fd.future') + ' · ' + mode_label(S.mode) }), table(tr('fd.future'), [tr('c.date'), tr('c.name'), tr('fd.col_amount'), tr('c.status')], future_rows),
    notes.length > 0 ? h('ul', { class: 'plain muted' }, notes) : null));
  return root;
}

function view_assistant() {
  const ref = first_income_ref(S.base);
  const input = h('input', { id: 'as-q', type: 'text', autocomplete: 'off', placeholder: tr('as.placeholder'), value: S.ask_q ?? '' }); // заготовка с карточки (FP-28) до отправки вопроса
  const log = h('div', { class: 'chat', 'aria-live': 'polite' });
  const draw_log = () => {
    log.replaceChildren(...S.chat.map((m) => h('div', { class: 'msg' },
      h('p', { class: 'you' }, h('strong', { text: tr('as.you') + ': ' }), m.q),
      h('div', { class: 'a0' }, h('p', null, h('strong', { text: tr('as.a0') + ': ' }), m.text),
        m.ok && m.fx_note !== undefined ? h('p', { class: 'muted rate-note', text: m.fx_note }) : null, // курсы, по которым пересчитан расчёт (REQ-077, REQ-079)
        m.ok && m.info !== undefined ? a0_note_node(m.info) : null,
        m.ok ? h('p', { class: 'meta' }, calc_chip(m.result, m.ref), ' ', h('span', { class: 'muted', text: tr('as.tool', { tool: m.tool }) + ' · ' + (m.verified ? tr('as.verified') : tr('as.not_verified')) })) : null))));
  };
  const submit = (q) => {
    const text = (q ?? input.value).trim();
    if (text === '') return;
    const r = ask_a0(S.model, text, S.lang, ref, a0_hook('ports'));
    let answer;
    if (r.ok) answer = { q: text, ok: true, text: r.text, tool: r.tool, ref: r.ref, result: r.result, verified: r.verified, fx_note: r.fx_note, info: r.info };
    else if (r.reason === 'tool_error') answer = { q: text, ok: false, text: r.text };
    else answer = { q: text, ok: false, text: tr(({ no_amount: 'as.no_amount', bad_date: 'as.bad_date', no_income: 'as.no_income', no_since: 'as.no_since', no_history: 'as.no_history', shift_days: 'as.shift_days', shift_unsupported: 'as.shift_unsupported' })[r.reason] ?? 'as.unrecognized', { date: typeof r.date === 'string' ? fmt().date(r.date) : '' }) };
    S.chat.push(answer);
    S.ask_q = null; // заготовка использована
    draw_log();
    input.value = '';
    announce(answer.text);
  };
  draw_log();
  return h('div', { class: 'view' }, view_title('as.title', 'as.lead'),
    h('form', { class: 'card ask', onsubmit: (ev) => { ev.preventDefault(); submit(); } },
      h('label', { for: 'as-q', text: tr('as.label') }), h('div', { class: 'row' }, input, h('button', { type: 'submit', class: 'btn primary', text: tr('as.ask') }),
        h('button', { type: 'button', class: 'btn', onclick: () => { S.chat = []; draw_log(); }, text: tr('as.clear') })),
      h('p', { class: 'muted', text: tr('as.disclaimer') })),
    h('section', { class: 'card' }, h('h3', { text: tr('as.examples') }),
      h('div', { class: 'chips' }, [1, 2, 3, 4, 5, 6, 7].map((i) => h('button', { type: 'button', class: 'chip', onclick: () => submit(tr('as.ex' + i)), text: tr('as.ex' + i) })))),
    log, ...ext.slot_nodes('assistant.extras'));
}

function view_data() {
  const f = fmt();
  const ws = S.model.ws;
  const file_in = h('input', { id: 'file-in', type: 'file', accept: 'application/json,.json' });
  file_in.addEventListener('change', () => import_file(file_in.files[0]));
  const sel = h('select', { id: 'ds-sel', 'aria-label': tr('ctl.dataset'), onchange: () => load_dataset(sel.value) }, dataset_options()); // имя поля для скринридера (FP-12, REQ-167)
  // FP-49: «Вернуть выбранный набор» возвращает ВСТРОЕННЫЙ набор; когда в списке стоит пункт-источник («Мои данные», «Файл: …»), выбранного встроенного набора нет, и кнопка, загрузив последний
  // встроенный, молча заменяла бы данные пользователя. Тогда она отключена, а рядом сказано, что сделать (обработчик и сам ничего не делает: защита от программного нажатия).
  // Встроенный набор «· изменён» пунктом-источником не считается: в списке назван именно он, и кнопка возвращает его, как до FP-49 (reset_target; исправление после проверки).
  const source_picked = reset_target() === null;
  const reset_btn = h('button', { type: 'button', id: 'ds-reset', class: 'btn', disabled: source_picked, 'aria-describedby': source_picked ? 'ds-reset-hint' : null,
    onclick: () => { const id = reset_target(); if (id !== null) { keep_focus_after_render('ds-reset'); load_dataset(id); } }, text: tr('dt.reset') }); // загрузка перерисовывает экран и заменяет кнопку: фокус возвращается на неё (урок 10)
  return h('div', { class: 'view' }, view_title('dt.title', 'dt.lead'),
    h('section', { class: 'card' }, h('h3', { text: tr('dt.dataset') }), h('p', { class: 'muted', text: tr('dt.dataset_hint') }),
      h('div', { class: 'row' }, sel, reset_btn),
      source_picked ? h('p', { class: 'muted', id: 'ds-reset-hint', text: tr('dt.reset_hint') }) : null,
      h('p', { text: tr('dt.summary', { accounts: (ws.accounts ?? []).length, facts: (ws.facts ?? []).length, rules: (ws.rules ?? []).length, scenarios: (ws.scenarios ?? []).length }) })),
    h('section', { class: 'card' }, h('h3', { text: tr('dt.export') + ' / ' + tr('dt.import') }),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: export_state, disabled: ro_now() !== null, 'aria-describedby': ro_now() === null ? null : 'fp05-ro-note', text: tr('dt.export') }), // из просмотра (FP-17) выгрузка отключена: в ней не было бы пропущенных записей
        h('label', { class: 'file', for: 'file-in', text: tr('dt.import_label') }), file_in),
      S.notice === null ? null : h('p', { role: 'status', text: S.notice })),
    quarantine_node(tr, S.quarantine), // что отброшено при открытии файла (FP-22); без карантина узла нет
    h('section', { class: 'card' }, h('h3', { text: tr('dt.where') }), h('ul', null, ['tab', 'file', 'assistant', 'third', 'risk'].map((k) => h('li', { text: tr('dt.where_' + k) }))),
      h('p', { class: 'muted', text: tr('dt.engine', { version: ENGINE_VERSION, hash: S.model.ctx.inputs_hash.slice(0, 8) }) + ' · ' + f.date(S.model.ctx.as_of) })), ...slot('data.sections'));
}

// ── загрузка и выгрузка ─────────────────────────────────────────────────────────────────────────────────────────────

function err_text(e) {
  const code = e?.code ?? 'other';
  if (code === 'E_NO_RATE') return no_rate_text(tr, e?.ctx); // FP-16: называет пару валют и ведёт на «Формы данных» → «Курсы и обмен»
  const key = 'err.' + code;
  return ['E_NOT_INTEGER', 'E_BAD_DATE', 'E_FUTURE_POSTED', 'E_RULE_INVALID', 'E_CURRENCY_MISMATCH', 'E_NO_RATE', 'E_OVERFLOW', 'E_SCHEMA'].includes(code) ? tr(key) : tr('err.other');
}

function recompute() {
  S.cmp_cache.clear();
  S.base = build_model(S.ws, { lang: S.lang });
  if (S.scenario !== null) {
    const ops = scenario_ops(S.scenario, S.ws, first_income_ref(S.base));
    S.model = ops === null ? S.base : build_model(S.ws, { scenario: { ops }, lang: S.lang });
    if (ops === null) S.scenario = null;
  } else S.model = S.base;
}

/** Общий путь записи (FP-01): подменить рабочую область с откатом при отказе пересчёта; журнал, подписчики и показ ведёт ext.mjs. */
function set_ws(ws) {
  const prev = S.ws;
  S.ws = ws;
  try { recompute(); } catch (e) { S.ws = prev; if (prev !== null) recompute(); return { ok: false, error: e }; }
  return { ok: true };
}

function adopt_workspace(ws, id, opts = {}) {
  const prev = { ws: S.ws, scenario: S.scenario };
  S.ws = ws;
  S.scenario = null;
  try {
    recompute();
  } catch (e) {
    S.ws = prev.ws;
    S.scenario = prev.scenario;
    if (S.ws !== null) recompute();
    throw e;
  }
  S.dataset_id = id;
  S.quarantine = null; // перечень отброшенного при открытии файла относится к прежнему набору
  S.buy_said = null; // новый набор данных — вердикт покупки по нему назовут заново (FP-48)
  said_last = null; // и сообщение прежнего набора к этому вердикту не дописывается (FP-49)
  S.buy = null;
  S.q1_d = null;
  S.sts_t = null;
  S.cmp = [];
  S.mode = ws.params?.headline_mode === 'plan' ? 'plan' : 'worse';
  ext.reset(ws, { ...opts, dataset_id: id });
}

/**
 * FP-21 (REQ-150): посчитать модель набора в Worker заранее. Пока идёт расчёт, экран показывает «Считаем…» (скелет, `aria-busy`), а фокус, упавший из-за перерисовок, возвращается.
 * Готовый расчёт потом заберёт `build_model` в `adopt_workspace`. Сбой Worker и отказ движка здесь не важны: набор примет `adopt_workspace`, посчитав на месте, — с теми же числами
 * и теми же кодами ошибок (клиент и сам откатывается на главный поток).
 * @returns {Promise<boolean>} `true`, если расчёт шёл через Worker-службу (вызывающий сверяет номер загрузки: за время расчёта могли выбрать другой набор)
 */
async function prepare_model(ws) {
  if (!calc.active()) return false;
  const focused_id = document.activeElement?.getAttribute?.('id'); // перерисовки на время расчёта заменяют узлы управления: фокус, упавший на body, вернётся на него
  const keep = typeof focused_id === 'string' && focused_id !== '';
  if (keep) keep_focus_after_render(focused_id);
  S.calc_busy += 1;
  try {
    try { render(); } catch { /* скелет не показан, расчёт всё равно идёт; счётчик «занято» снимается ниже в любом случае */ }
    // Операция `waves` — надмножество `project`: расчёт для «Обзора» и «Купить» плюс списки волн (+1–2 мс и около 3 % ответа). Экран к моменту загрузки почти всегда «Обзор»
    // (приложение стартует на нём), поэтому списки просим сразу: переход на «Волны» берёт готовые, а не считает на месте.
    try { await calc.prepare(ws, [{ as_of: ws.as_of }], { screen: 'waves' }); } catch { /* считаем на месте */ }
  } finally { S.calc_busy -= 1; }
  if (keep) keep_focus_after_render(focused_id); // ответ мог прийти позже окна хранителя фокуса (3 с): окно открывается заново перед отрисовкой готовой модели
  return true;
}

/**
 * Загрузка устарела (за время расчёта выбран другой набор или файл): примет последняя. Но скелет «Считаем…» могла оставить именно эта загрузка — последняя
 * из параллельных, снявшая счётчик «занято», перерисовывает экран, иначе он остался бы на скелете.
 */
function drop_stale_load() {
  if (S.calc_busy === 0) render();
}

async function load_dataset(id) {
  const d = DATASETS.find((x) => x.id === id);
  if (d === undefined) return;
  const gen = ++S.adopt_gen;
  try {
    const res = await fetch(new URL(d.file, import.meta.url));
    if (!res.ok) throw new Error('http');
    const ws = await res.json();
    if (calc.active() && (await prepare_model(ws)) && gen !== S.adopt_gen) { drop_stale_load(); return; } // за время расчёта выбран другой набор или файл: примет последний (без Worker — ни одного лишнего такта)
    adopt_workspace(ws, id);
    S.status = 'ready';
    S.notice = null;
  } catch (e) {
    S.status = 'error';
    S.error = e?.code !== undefined ? tr('app.calc_error', { code: e.code }) : tr('app.load_error');
  }
  render();
}

async function import_file(file) {
  if (file === undefined) return;
  if (file.size > MAX_FILE_BYTES) { S.notice = tr('dt.import_big'); render(); return; }
  let text;
  try { text = await file.text(); } catch { S.notice = tr('dt.import_bad'); render(); return; }
  // FP-22 (REQ-158, Q-22): inspect_import → validate_ws → карантин записей. Один невалидный объект больше не отвергает весь файл: он отбрасывается и перечисляется;
  // файл отвергается целиком только при нарушении схемы верхнего уровня или если расчёт невозможен и после карантина.
  const r = open_foreign(text);
  if (!r.ok) {
    S.notice = r.error === 'too_big' ? tr('dt.import_big') : r.error === 'bad_json' || r.error === 'not_a_copy' ? tr('dt.import_bad')
      : r.stage === 'calc' ? tr('dt.import_calc', { code: r.error }) : refused_notice(tr, r);
    render();
    return;
  }
  const gen = ++S.adopt_gen;
  // FP-21: расчёт модели при принятии файла идёт в Worker (повторный расчёт, который adopt_workspace сделал бы на главном потоке); проверочный расчёт open_foreign выше
  // остаётся на основном потоке — он решает, открывать ли файл. За время расчёта выбран другой набор или файл — примет последний
  if (calc.active() && (await prepare_model(r.ws)) && gen !== S.adopt_gen) { drop_stale_load(); return; }
  try {
    adopt_workspace(r.ws, 'custom', { file_name: String(file.name ?? '').slice(0, 80), ...(r.read_only === null ? {} : { read_only: r.read_only }) }); // имя файла — в подпись переключателя «Набор данных» (FP-48)
    S.quarantine = r.quarantined ? { rejected: r.rejected, params_replaced: r.params_replaced } : null;
    S.notice = [tr('dt.import_ok', { name: String(r.ws.name ?? file.name).slice(0, 80) }), quarantine_notice(tr, r)].filter((x) => x !== '').join(' ');
  } catch (e) {
    S.notice = e?.code === 'E_SCHEMA' || e?.code === undefined ? tr('dt.import_bad') : tr('dt.import_calc', { code: e.code });
  }
  render();
}

function export_state() {
  if (ro_now() !== null) { S.notice = tr('data.readonly_no_copy'); render(); return; } // режим «только чтение» (FP-17): выгрузка неполного набора как полного не выдаётся
  const blob = new Blob([JSON.stringify(S.model.ws, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: 'runway-state-' + S.model.as_of_iso + '.json' });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  S.notice = tr('dt.export_done');
  render();
}

// ── оболочка: шапка, навигация, тема, язык ─────────────────────────────────────────────────────────────────────────

/**
 * Пункт-источник переключателя «Набор данных» (шапка и экран «Данные»). FP-48: когда данные уже не встроенный набор «как есть» («Продолжить с сохранённого», «Восстановить из файла»,
 * открытый или правленый файл), хук `dataset_label` называет их честно, и выбран этот пункт (значение `custom`, ничего не загружает), а не `G-001 — эталон`; хук молчит — прежние подписи.
 * FP-49: ответ нужен и экрану «Данные» (см. reset_target). У правленого встроенного набора («G-001 — эталон · изменён») в ответе есть поле `builtin` — идентификатор набора.
 * @returns {{value: string, text: string, builtin?: string}|null} пункт-источник или `null`, когда выбран встроенный набор
 */
function dataset_named() {
  const hooked = ext.first('dataset_label', S.dataset_id);
  return hooked !== null && typeof hooked === 'object' && typeof hooked.value === 'string' && typeof hooked.text === 'string' ? hooked
    : (S.dataset_id === 'custom' ? { value: 'custom', text: tr('ds.custom') } : null);
}

/**
 * Что вернёт кнопка «Вернуть выбранный набор» на экране «Данные» (FP-49): идентификатор встроенного набора, который назван в списке, либо `null` — в списке пункт-источник («Мои данные»,
 * «Файл: …», «Загруженный файл»), возвращать нечего, кнопка отключена. Встроенный набор без правок — это `S.dataset_id`; встроенный набор «· изменён» — тоже он, если пункт несёт
 * его идентификатор в `builtin`. Кнопка всегда грузит `S.dataset_id`, а не то, что назвал хук: ответ хука не может заставить её загрузить другой набор.
 * @returns {string|null}
 */
function reset_target() {
  const named = dataset_named();
  if (named === null) return S.dataset_id;
  return named.builtin === S.dataset_id && DATASETS.some((d) => d.id === S.dataset_id) ? S.dataset_id : null;
}

/** Пункты переключателя «Набор данных»: пять встроенных наборов и, если данные не встроенный набор «как есть», выбранный пункт-источник. */
function dataset_options() {
  const named = dataset_named();
  const opts = DATASETS.map((d) => h('option', { value: d.id, selected: named === null && S.dataset_id === d.id, text: tr('ds.' + d.id) }));
  if (named !== null) opts.push(h('option', { value: named.value, selected: true, text: named.text }));
  return opts;
}

function pref_get(key) {
  try { return localStorage.getItem('runway-demo-' + key); } catch { return null; }
}

function pref_set(key, value) {
  try { localStorage.setItem('runway-demo-' + key, value); } catch { /* хранилище недоступно: работаем без него */ }
}

function apply_theme() {
  const root = document.documentElement;
  if (S.theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', S.theme);
}

function render_controls() {
  const box = el_by_id('controls');
  const ds = h('select', { id: 'ds-top', 'aria-label': tr('ctl.dataset'), onchange: (ev) => load_dataset(ev.target.value) }, dataset_options());
  const modes = h('div', { class: 'seg', role: 'group', 'aria-label': tr('ctl.mode') }, MODES.map((m) => h('button', {
    type: 'button', 'aria-pressed': String(S.mode === m), onclick: () => { S.mode = m; render(); }, text: mode_label(m),
  })));
  const langs = h('div', { class: 'seg', role: 'group', 'aria-label': tr('ctl.lang') }, LANGS.map((l) => h('button', {
    type: 'button', lang: l, 'aria-pressed': String(S.lang === l), onclick: () => set_lang(l), text: l.toUpperCase(),
  })));
  const theme = h('button', { type: 'button', class: 'btn', 'aria-label': tr('ctl.theme') + ': ' + tr('ctl.theme_' + S.theme), title: tr('ctl.theme') + ': ' + tr('ctl.theme_' + S.theme),
    onclick: () => { S.theme = THEMES[(THEMES.indexOf(S.theme) + 1) % THEMES.length]; pref_set('theme', S.theme); apply_theme(); render_controls(); }, text: tr('ctl.theme') + ': ' + tr('ctl.theme_' + S.theme) });
  box.replaceChildren(h('label', { class: 'ctl' }, h('span', { class: 'ctl-label', text: tr('ctl.dataset') }), ds), modes, langs, theme);
}

function set_lang(l) {
  S.lang = l;
  pref_set('lang', l);
  document.documentElement.lang = l;
  render();
}

/** Причины низкой готовности (readiness.reasons) короткими словами; неизвестная причина — общим «проверьте данные» (REQ-029). */
function not_ready_list(reasons) {
  const known = ['no_account', 'obligations_lt_3', 'no_income_45d', 'no_daily_spend'];
  const parts = (reasons ?? []).map((r) => tr('banner.miss_' + (known.includes(r) ? r : 'other')));
  return [...new Set(parts.length === 0 ? [tr('banner.miss_no_daily_spend')] : parts)].join(', ');
}

/** Примечание к «Остатку на …»: остатки счетов в чужой валюте с курсом, датой курса и возрастом; `null`, если чужих остатков нет. */
function balance_note_node() {
  const a = S.model.ctx;
  return note_node(balance_note_text(tr, make_env(S.lang, S.model.ws, a), balance_fx(S.model.ws, a, S.model.scenario)));
}

/** Примечание о курсах расчёта (события и остатки счетов) для экранов с вердиктом: «Обзор», «Покупка»; `null`, если пересчётов нет. */
function rates_note_node() {
  const a = S.model.ctx;
  return note_node(answer_note_text(tr, make_env(S.lang, S.model.ws, a), rate_uses(S.model.ws, a, S.model.scenario)));
}

function render_summary() {
  const box = el_by_id('summary');
  if (S.model === null) { box.replaceChildren(); return; }
  const a = S.model.ctx;
  const f = fmt();
  const age = a.anchor_status.age;
  const fresh = age === null || age === 0 ? tr('hdr.fresh_today') : tr('hdr.fresh_age', { n: age, days: word_form(S.lang, 'day', age) });
  const chips = [
    h('li', null, h('strong', { text: tr('hdr.balance', { date: f.date(a.as_of) }) + ': ' }), f.money(a.series.plan.opening_minor)),
    h('li', { text: fresh }),
    h('li', { text: tr('hdr.ready', { score: a.readiness.score }) + ' · ' + tr('hdr.ready_name_' + a.readiness.level) }), // ступень готовности словом (U21): пусто, каркас, рабочий, рабочий+, полный
    h('li', { text: tr('hdr.currency', { cur: S.model.cur }) }),
    h('li', { text: a.buffer_minor === null ? tr('hdr.buffer_unset') : tr('hdr.buffer', { value: f.money(a.buffer_minor) }) }),
    h('li', { text: tr('hdr.horizon', { n: horizon_ahead_of(S.model), days: word_form(S.lang, 'day', horizon_ahead_of(S.model)), date: f.date(a.horizon_end) }) }), // FP-48: то же число, что в «Настройках»
  ];
  const notes = [];
  const ro = ro_now(); // режим «только чтение» (FP-17, REQ-016): набор из файла новее известного формата — прогноз виден, правки отключены
  if (ro !== null) {
    notes.push(h('p', { class: 'banner', role: 'status', text: tr(ro.newer_format ? 'ro.banner' : 'ro.banner_records', { format: ro.format, known: 'runway-journal/' + ro.known_version }) + (ro.skipped > 0 ? ' ' + tr('ro.skipped', { n: ro.skipped }) : '') }));
  }
  if (S.scenario !== null) {
    notes.push(h('p', { class: 'banner scenario', role: 'status' }, tr('sc.banner', { name: scenario_name(S.scenario, S.model.ws, S.lang, f) }), ' ',
      h('button', { type: 'button', class: 'link', onclick: () => { keep_focus_after_render('view-title'); S.scenario = null; recompute(); render(); }, text: tr('sc.back') }))); // кнопка исчезает вместе с плашкой: фокус — на заголовок экрана
  }
  const banner_actions = () => ext.slot_nodes('banner.actions'); // действие прямо в плашке (сверить остаток)
  if (a.anchor_status.level === 'banner') notes.push(h('p', { class: 'banner' }, tr('banner.stale', { n: a.anchor_status.age, days: word_form(S.lang, 'day', a.anchor_status.age), x: f.money(a.anchor_status.unaccounted_minor ?? 0) }), ' ', ...banner_actions()));
  if (a.anchor_status.level === 'block') notes.push(h('p', { class: 'banner short' }, tr('banner.block'), ' ', ...banner_actions()));
  if (a.readiness.score < (a.params['ready.q3'] ?? 4)) notes.push(h('p', { class: 'banner', text: tr('banner.not_ready', { list: not_ready_list(a.readiness.reasons) }) }));
  for (const w of a.warnings) { // слот banner.warning (FP-15): действие в конце плашки предупреждения («Освободить остаток»)
    const acts = ext.slot_nodes('banner.warning', ext.ctx, Object.freeze({ warning: w }));
    notes.push(h('p', { class: 'banner' }, warning_text(w), acts.length === 0 ? null : ' ', ...acts));
  }
  const bal_note = balance_note_node(); // «Остаток на …» из счёта в чужой валюте называет курс, даже если событий в этой валюте нет (REQ-079)
  box.replaceChildren(h('ul', { class: 'chips-row' }, chips), ...(bal_note === null ? [] : [bal_note]), ...notes);
}

// Навигация (S1.4): два списка подряд — ссылки разделов (ul.nav-sections) и за ними кнопки действий из слота nav.actions (ul.nav-actions, li.nav-action).
// Порядок в DOM — это и порядок фокуса клавиатуры, и порядок на экране на любой ширине: CSS не переставляет списки (ни order, ни reverse), только
// меняет направление и прокрутку. Список действий рисуется, только если пакеты что-то дали: пустой список скринридеру не нужен.
function render_nav() {
  const nav = el_by_id('nav');
  nav.setAttribute('aria-label', tr('nav.label'));
  const lists = [h('ul', { class: 'nav-sections', 'aria-label': tr('nav.list_sections') },
    ext.nav_items(VIEWS).map((v) => h('li', null, h('a', { href: '#' + v.id, 'aria-current': S.view === v.id ? 'page' : null, text: tr(v.title_key) }))))];
  const actions = ext.slot_nodes('nav.actions');
  if (actions.length > 0) lists.push(h('ul', { class: 'nav-actions', 'aria-label': tr('nav.list_actions') }, actions.map((n) => h('li', { class: 'nav-action' }, n))));
  nav.replaceChildren(...group_nav(nav, lists, tr, S.view)); // FP-26: на телефоне разделы за первыми четырьмя — в группе «Ещё»; на других ширинах списки прежние
}

function render_main() {
  const main = el_by_id('main');
  S.buy_live = null; // FP-21: отрисовка заменяет содержимое — ответы «Купить» от прежней отрисовки больше не рисуют (view_buy поставит метку заново)
  mark_busy(main, S.status === 'loading'); // aria-busy, пока набор данных читается
  if (S.calc_busy > 0) { mark_busy(main, true); main.replaceChildren(...skeleton_nodes(tr('app.calc'))); return; } // FP-21: модель набора считается в Worker — «Считаем…» вместо «Загрузка…», aria-busy тот же
  if (S.status === 'loading') { main.replaceChildren(...skeleton_nodes(tr('app.loading'))); return; }
  if (S.status === 'error') { main.replaceChildren(h('p', { class: 'banner short', role: 'alert', text: S.error })); return; }
  const views = { overview: view_overview, buy: view_buy, waves: view_waves, reserves: view_reserves, scenarios: view_scenarios, feed: view_feed, assistant: view_assistant, data: view_data };
  if (S.view !== 'buy') S.buy_said = null; // ушли с экрана «Купить»: при возвращении вердикт назовут заново
  try {
    main.replaceChildren(views[S.view] !== undefined ? views[S.view]() : ext.render_view(S.view));
  } catch (e) {
    main.replaceChildren(h('p', { class: 'banner short', role: 'alert', text: tr('app.calc_error', { code: e?.code ?? 'E_SCHEMA' }) }));
  }
}

/** Перерисовать страницу целиком (состояние — в `S`). */
function render() {
  el_by_id('app-title').textContent = tr('app.title');
  el_by_id('app-sub').textContent = tr('app.subtitle');
  el_by_id('skip').textContent = tr('app.skip');
  document.title = tr('app.title');
  render_controls();
  render_nav();
  render_summary();
  render_main();
  el_by_id('footer').textContent = S.model === null ? '' : tr('app.footer', { version: ENGINE_VERSION, hash: S.model.ctx.inputs_hash.slice(0, 8) });
  nav_keep_focus(); // перерисовка заменила узлы навигации: фокус на вкладке или «Ещё» возвращается, если он упал на body
}

function route() {
  const v = location.hash.replace(/^#/, '');
  const next = known_view(v) ? v : S.view;
  const changed = next !== S.view;
  if (changed && next !== 'assistant') S.ask_q = null; // заготовка вопроса живёт, пока открыт «Ассистент»
  if (changed) said_last = null; // сообщение, объявленное на прежнем экране, к вердикту нового не дописывается (FP-49)
  S.view = next;
  render();
  if (changed) {
    const title = el_by_id('view-title');
    if (title !== null) title.focus({ preventScroll: false });
    window.scrollTo(0, 0);
  }
}

/** Запуск демо в браузере: язык и тема из настроек, набор G-001 по умолчанию, маршрутизация по `#раздел`. */
export async function boot() {
  const saved_lang = pref_get('lang');
  S.lang = LANGS.includes(saved_lang) ? saved_lang : (typeof navigator !== 'undefined' && /^en/i.test(navigator.language ?? '') ? 'en' : DEFAULT_LANG);
  const saved_theme = pref_get('theme');
  S.theme = THEMES.includes(saved_theme) ? saved_theme : 'auto';
  document.documentElement.lang = S.lang;
  apply_theme();
  el_by_id('dlg-close').addEventListener('click', () => el_by_id('dlg').close());
  ext.bind_host({ get_ws: () => S.ws, get_model: () => S.model, lang: () => S.lang, mode: () => S.mode, fmt: () => (S.model === null ? null : fmt()), set_ws, render,
    adopt: (ws, o) => { try { adopt_workspace(ws, 'custom', o); render(); return { ok: true }; } catch (e) { return { ok: false, error: e }; } }, // ctx.adopt: подмена набора целиком
    ask: ask_assistant, // ctx.ask(вопрос): «Спросить ассистента» с карточек пакетов (FP-28)
    notify: (m) => { S.notice = m; announce(m); } });
  await ext.load_packs(); // пакеты регистрируют экраны, блоки и хуки до первой отрисовки
  el_by_id('skip').addEventListener('click', (ev) => { ev.preventDefault(); el_by_id('main').focus(); });
  window.addEventListener('hashchange', route);
  S.view = known_view(location.hash.replace(/^#/, '')) ? location.hash.replace(/^#/, '') : 'overview';
  render();
  await load_dataset(DATASETS[0].id);
  await ext.run('boot');
}

if (typeof document !== 'undefined' && document.getElementById('app-title') !== null) boot();
