// wizard.mjs — мастер «Старт» (#start, FP-10, REQ-110, REQ-029, IDEA-31, IDEA-34): четыре шага и буфер, прогноз при готовности данных s ≥ 3.
//
// Шаги: (1) счёт и остаток, (2) обязательства — не менее трёх повторяющихся платежей, (3) ближайший доход, (4) повседневные траты, (+) буфер.
// Что считается «готовым», решает движок: ступень `s` и перечень недостающего (`readiness.reasons`) берутся из расчёта страницы (`home_cards.readiness_model`),
// свои причины здесь не придуманы. Прогноз появляется при `s ≥ ready.q1` (3); вердикт Q3 — по гейту (`s = 4`, задан буфер, остаток сверен).
// Шаги можно пропускать и возвращаться к ним. Запись — только общим путём (`forms.commit_edits` → `apply_edit` → `ctx.set_ws`), одним действием на шаг: «Отменить»
// откатывает шаг целиком. Поля разбираются по формату чисел рабочей области; ошибка — код канона `E_*` и текст рядом с полем, введённое значение в текст не
// попадает. Время шагов пишется в локальный журнал метрик (`metrics.record_step`) без сумм и дат: шаг, секунды активной работы, номер сеанса.
// Шаблон-скелет (`start_template.mjs`) подсказывает только названия строк; сумм и ставок в нём нет.
//
// Файл: сначала чистые функции (модель шагов, разбор полей, план правок, таймер шагов — проверяются в Node без DOM), затем узлы (`h` из dom.mjs: только
// textContent и узлы, без inline-стилей и обработчиков-строк). Расчёт по введённым данным и правилам, не консультация.

import { to_epoch_day, narrowest_point, buffer_hint, currency_exponent } from '../engine/index.mjs';
import { LABELS } from '../engine/verifier.mjs';
import { h, el_by_id } from './dom.mjs';
import { readiness_model, miss_key, gate_key, MODES } from './home_cards.mjs';
import {
  bad, first_error, list_of, env_of, fmt_of, parse_money, parse_date_input, parse_count, commit_edits, open_accounts, kids,
} from './forms.mjs';
import { format_input_amount, resolve_number_format } from './number_format.mjs';
import { template_slots, TEMPLATES, TEMPLATE_IDS } from './start_template.mjs';
import { make_rule } from './rule_kit.mjs';

// ── константы ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Шаги мастера по порядку: четыре шага и буфер. */
export const STEPS = Object.freeze(['account', 'obligations', 'income', 'daily', 'buffer']);

/** Сколько обязательств ждёт мастер (REQ-110); готовность при этом решает движок (три обязательства ИЛИ один значимый платёж). */
export const MIN_OBLIGATIONS = 3;

/** Дальше этого числа дней вперёд первую дату платежа или дохода мастер не принимает (опечатка в годе). */
export const MAX_DAYS_AHEAD = 400;

/** Окно «доход в ближайшие N дней» из REQ-029 — только для пояснения; засчитывает или нет, решает движок. */
export const INCOME_WINDOW_DAYS = 45;

/** Длина названия (как в `upsert_rule`). */
export const NAME_MAX = 120;

/**
 * Сколько миллисекунд после запроса фокус «липкий»: хранилище FP-05 после каждой записи просит `ctx.refresh()` ещё раз (data_runtime.ping → microtask или позже,
 * когда запись в базу завершилась), страница перерисовывается и заменяет узел, на котором стоял фокус; в окне фокус возвращается на заданный узел при каждой отрисовке.
 */
export const FOCUS_WINDOW_MS = 3000;

/** Частоты платежей мастера: ежемесячно, еженедельно, раз в год. */
export const OBLIGATION_FREQS = Object.freeze(['M', 'W', 'Y']);

/** Повторение дохода: ежемесячно или один раз. */
export const INCOME_REPEATS = Object.freeze(['M', 'once']);

/** Период повседневных трат: неделя или месяц. */
export const DAILY_PERIODS = Object.freeze(['W', 'M']);

/** Причина движка, по которой шаг не засчитан (`readiness.reasons`); у буфера причины в готовности нет — он отдельно (C-018). */
export const STEP_REASON = Object.freeze({ account: 'no_account', obligations: 'obligations_lt_3', income: 'no_income_45d', daily: 'no_daily_spend' });

const KNOWN_CODES = ['E_NOT_INTEGER', 'E_OVERFLOW', 'E_BAD_DATE', 'E_FUTURE_POSTED', 'E_RULE_INVALID', 'E_CURRENCY_MISMATCH', 'E_NO_RATE', 'E_SCHEMA'];
const KNOWN_REASONS = ['empty', 'bad_number', 'zero', 'negative', 'too_big', 'bad_date', 'date_past', 'date_far', 'range', 'too_long', 'no_account', 'not_in_list'];
const KNOWN_FIELDS = ['name', 'balance', 'amount', 'freq', 'date', 'repeat', 'delay', 'period'];

// ── модель шагов ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Модель мастера по расчёту страницы: ступень готовности и причины движка, какие шаги засчитаны, что уже введено.
 * @param {{ws: object, ctx: object}} model модель страницы (`build_model`)
 */
export function wizard_model(model) {
  const rd = readiness_model(model);
  const ws = model.ws;
  const rules = list_of(ws, 'rules');
  const done = {};
  for (const s of STEPS) done[s] = s === 'buffer' ? rd.buffer.set : !rd.reasons.includes(STEP_REASON[s]);
  const account = open_accounts(ws).find((a) => a.liquidity === 'operating') ?? null;
  const anchors = account === null ? [] : list_of(ws, 'anchors').filter((a) => a?.account_id === account.account_id).sort((p, q) => (p.date < q.date ? -1 : p.date > q.date ? 1 : 0));
  return {
    score: rd.score,
    q1: rd.q1,
    forecast_visible: rd.forecast_visible,
    reasons: rd.reasons,
    verdict_gate: rd.verdict_gate,
    buffer: rd.buffer,
    done,
    first_open: STEPS.find((s) => !done[s]) ?? 'buffer',
    account,
    anchor: anchors.length === 0 ? null : anchors[anchors.length - 1],
    obligations: rules.filter((r) => r?.kind === 'expense' && r.is_obligation === true),
    incomes: rules.filter((r) => r?.kind === 'income'),
    estimate: rules.find((r) => r?.kind === 'expense' && r.is_estimate === true) ?? null,
  };
}

/** Следующий шаг после `step` (или `null` после последнего). */
export function next_step(step) {
  const i = STEPS.indexOf(step);
  return i < 0 || i === STEPS.length - 1 ? null : STEPS[i + 1];
}

/** Предыдущий шаг (или `null` перед первым). */
export function prev_step(step) {
  const i = STEPS.indexOf(step);
  return i <= 0 ? null : STEPS[i - 1];
}

// ── разбор полей и план правок ─────────────────────────────────────────────────────────────────────────────────────────

const trim = (x) => (typeof x === 'string' ? x.trim() : '');

/** Название: непустое, до `NAME_MAX` знаков; пустое можно заменить названием по умолчанию (`fallback`). */
function parse_name(text, field, fallback) {
  let s = trim(text);
  if (s === '' && typeof fallback === 'string') s = fallback.trim();
  if (s === '') return bad('E_SCHEMA', field, 'empty');
  if (s.length > NAME_MAX) return bad('E_SCHEMA', field, 'too_long');
  return { ok: true, value: s };
}

/** Дата: ISO или формат рабочей области; не раньше даты расчёта и не дальше `MAX_DAYS_AHEAD` дней. */
function parse_future_date(text, env, field) {
  const d = parse_date_input(text, env, field);
  if (!d.ok) return d;
  if (d.value < env.as_of) return bad('E_BAD_DATE', field, 'date_past');
  if (to_epoch_day(d.value) - to_epoch_day(env.as_of) > MAX_DAYS_AHEAD) return bad('E_BAD_DATE', field, 'date_far');
  return d;
}

function pick(list, text, field, fallback) {
  const s = trim(text) === '' ? fallback : trim(text);
  return list.includes(s) ? { ok: true, value: s } : bad('E_SCHEMA', field, 'not_in_list');
}

const operating_account = (ws) => open_accounts(ws).find((a) => a.liquidity === 'operating') ?? null;

/**
 * Шаг 1. Счёт и остаток: `upsert_account` + `set_anchor` на дату расчёта одним действием. Если операционный счёт уже есть, правится он (имя и остаток).
 * @param {object} ws
 * @param {{name?: string, balance?: string}} t тексты полей
 * @param {{cur: string, lang: 'ru'|'en', nf?: any, as_of: string, default_account_name?: string}} env
 * @param {(prefix: string) => string} new_id
 */
export function plan_account(ws, t, env, new_id) {
  const name = parse_name(t.name, 'name', env.default_account_name);
  const acc = operating_account(ws);
  const balance = parse_money(t.balance, env, 'balance', { negative: true, zero: true, cur: acc?.currency });
  const err = first_error([name, balance]);
  if (err !== null) return err;
  const account_id = acc?.account_id ?? new_id('acc');
  const account = acc === null
    ? { account_id, name: name.value, kind: 'bank', liquidity: 'operating', currency: env.cur }
    : { ...acc, name: name.value };
  const same_day = list_of(ws, 'anchors').find((a) => a?.account_id === account_id && a.date === env.as_of);
  const anchor = { anchor_id: same_day?.anchor_id ?? new_id('anc'), account_id, date: env.as_of, amount_minor: balance.value };
  return { ok: true, edits: [{ type: 'upsert_account', account }, { type: 'set_anchor', anchor }], summary: { name: name.value, amount_minor: balance.value, currency: account.currency } };
}

/**
 * Шаг 2. Обязательство: повторяющийся платёж (аренда, связь…) — правило `upsert_rule` с признаком `is_obligation`. Добавляется ещё одно правило, прежние не меняются.
 * @param {{name?: string, amount?: string, freq?: string, date?: string}} t
 */
export function plan_obligation(ws, t, env, new_id) {
  const acc = operating_account(ws);
  if (acc === null) return bad('E_SCHEMA', 'account', 'no_account');
  const name = parse_name(t.name, 'name');
  const amount = parse_money(t.amount, env, 'amount', { cur: acc.currency });
  const freq = pick(OBLIGATION_FREQS, t.freq, 'freq', 'M');
  const date = parse_future_date(t.date, env, 'date');
  const err = first_error([name, amount, freq, date]);
  if (err !== null) return err;
  const rule = make_rule(acc, new_id('rule'), name.value, 'expense', amount.value, freq.value, date.value, { is_obligation: true });
  return { ok: true, edits: [{ type: 'upsert_rule', rule }], summary: { name: name.value, amount_minor: amount.value, currency: acc.currency, freq: freq.value, date: date.value } };
}

/**
 * Шаг 3. Ближайший доход: правило-поступление; «раз в месяц» или «один раз» (`count = 1`); необязательная привычная задержка (`delay_days_worse`, дни).
 * @param {{name?: string, amount?: string, repeat?: string, date?: string, delay?: string}} t
 */
export function plan_income(ws, t, env, new_id) {
  const acc = operating_account(ws);
  if (acc === null) return bad('E_SCHEMA', 'account', 'no_account');
  const name = parse_name(t.name, 'name', env.default_income_name);
  const amount = parse_money(t.amount, env, 'amount', { cur: acc.currency });
  const repeat = pick(INCOME_REPEATS, t.repeat, 'repeat', 'M');
  const date = parse_future_date(t.date, env, 'date');
  const delay = trim(t.delay) === '' ? { ok: true, value: null } : parse_count(t.delay, 'delay', 0, 365);
  const err = first_error([name, amount, repeat, date, delay]);
  if (err !== null) return err;
  const extra = {};
  if (repeat.value === 'once') extra.count = 1;
  if (delay.value !== null) extra.delay_days_worse = delay.value;
  const rule = make_rule(acc, new_id('rule'), name.value, 'income', amount.value, 'M', date.value, extra);
  return {
    ok: true, edits: [{ type: 'upsert_rule', rule }],
    summary: { name: name.value, amount_minor: amount.value, currency: acc.currency, repeat: repeat.value, date: date.value, delay: delay.value },
  };
}

/**
 * Шаг 4. Повседневные траты: одно приблизительное правило (`is_estimate`, не обязательство) в неделю или в месяц от даты расчёта.
 * Если приблизительное правило уже есть, правится оно (второго не появляется); прочие его поля (метка, календарь) сохраняются.
 * @param {{name?: string, amount?: string, period?: string}} t
 */
export function plan_daily(ws, t, env, new_id) {
  const acc = operating_account(ws);
  if (acc === null) return bad('E_SCHEMA', 'account', 'no_account');
  const old = list_of(ws, 'rules').find((r) => r?.kind === 'expense' && r.is_estimate === true) ?? null;
  const name = parse_name(t.name, 'name', env.default_daily_name);
  const amount = parse_money(t.amount, env, 'amount', { cur: acc.currency });
  const period = pick(DAILY_PERIODS, t.period, 'period', 'W');
  const err = first_error([name, amount, period]);
  if (err !== null) return err;
  const fresh = make_rule(acc, old?.rule_id ?? new_id('rule'), name.value, 'expense', amount.value, period.value, env.as_of, { is_estimate: true });
  let rule = fresh;
  if (old !== null) {
    const base = JSON.parse(JSON.stringify(old));
    for (const k of ['by_monthday', 'by_weekday', 'by_workday', 'until_date', 'count']) delete base[k];
    rule = { ...base, ...fresh };
  }
  return { ok: true, edits: [{ type: 'upsert_rule', rule }], summary: { name: name.value, amount_minor: amount.value, currency: acc.currency, period: period.value } };
}

/**
 * Буфер (+): сумма, ниже которой деньги на счёте не должны опускаться; `set_param buffer_minor`. Ноль допустим (буфер задан и равен нулю).
 * @param {{amount?: string}} t
 */
export function plan_buffer(ws, t, env) {
  const amount = parse_money(t.amount, env, 'amount', { zero: true });
  if (!amount.ok) return amount;
  return { ok: true, edits: [{ type: 'set_param', key: 'buffer_minor', value: amount.value }], summary: { amount_minor: amount.value, currency: env.cur } };
}

/** Подсказка буфера (`buffer_hint` движка): `null`, если истории расходов за 90 дней нет. */
export function buffer_hint_of(model) {
  try { return buffer_hint(model.ws, model.ctx.as_of); } catch { return null; }
}

// ── тексты ошибок ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Текст отказа: подпись поля, код канона и подсказка по причине. Введённое значение и значения из `ctx` ошибки не повторяются.
 * @param {(key: string, params?: object) => string} tr
 * @param {{code?: string, ctx?: {field?: string, reason?: string}|null}} error
 * @param {{cur: string, lang: 'ru'|'en', nf?: any, as_of: string}} env
 */
export function error_message(tr, error, env) {
  if (error?.ctx?.reason === 'read_only') return tr('ro.refused'); // режим «только чтение» (FP-17, REQ-016): называем причину отказа, а не винить заполнение полей и не показывать код
  const code = KNOWN_CODES.includes(error?.code) ? error.code : 'E_SCHEMA';
  const field = field_name(error);
  const reason = KNOWN_REASONS.includes(error?.ctx?.reason) ? error.ctx.reason : 'other';
  const label = KNOWN_FIELDS.includes(field) ? tr('start.f_' + field) : tr('start.f_other');
  const nf = resolve_number_format(env.lang, env.nf);
  return tr('start.er_' + reason, {
    field: label, code, example: format_input_amount(123450, currency_exponent(env.cur), nf, false), today: fmt_of(env).date(env.as_of),
    days: MAX_DAYS_AHEAD, min: 0, max: 365,
  });
}

/** Имя поля из ошибки: последняя часть пути без индекса («rule.name» → «name»). */
export function field_name(error) {
  return String(error?.ctx?.field ?? '').split('.').pop().replace(/\[\d+\]$/, '');
}

// ── таймер шагов ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Таймер активного времени по шагам. Часы приходят портом. Время считается между действиями пользователя: пауза дольше `idle_cap_ms` засчитывается
 * только в пределах этого предела (страница могла быть открыта и брошена), поэтому паузу на экране «Старт» перед действием таймер засчитывает не больше чем
 * на `idle_cap_ms` (по умолчанию минута). Время каждого шага копится отдельно: переход между шагами и обратно его не теряет.
 * Время ВНЕ экрана «Старт» шагу не приписывается: повторная отрисовка того же шага (возврат с другого экрана, смена языка, поздняя перерисовка после записи)
 * только сдвигает «последний момент» и ничего не засчитывает; засчитывает действие пользователя (`touch`) и смена шага.
 * @param {{now_ms: () => number, idle_cap_ms?: number, max_seconds?: number}} deps
 */
export function create_step_timer(deps) {
  const cap = deps.idle_cap_ms ?? 60000;
  const max = deps.max_seconds ?? 3600;
  const acc = new Map();
  let current = null;
  let last = 0;
  const touch = () => {
    const now = deps.now_ms();
    if (current !== null) acc.set(current, (acc.get(current) ?? 0) + Math.min(Math.max(now - last, 0), cap));
    last = now;
  };
  return {
    /** Шаг на экране сейчас: при смене шага время до этого момента уходит прежнему шагу; повторная отрисовка того же шага времени не засчитывает. */
    enter(step) {
      if (current === step) last = deps.now_ms(); else touch();
      current = step;
      if (!acc.has(step)) acc.set(step, 0);
    },
    /** Пользователь что-то сделал (ввод, щелчок). */
    touch,
    /** Шаг закончен (записан или пропущен): запись для журнала; время шага обнуляется. */
    done(step, outcome) {
      touch();
      const seconds = Math.min(Math.round((acc.get(step) ?? 0) / 1000), max);
      acc.delete(step);
      return { step, seconds, outcome };
    },
    /** Накоплено секунд по шагу (для проверок). */
    seconds(step) { return Math.round((acc.get(step) ?? 0) / 1000); },
  };
}

// ── зависимости экрана ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Зависимости экрана: состояние интерфейса, таймер шагов и метрики (если подключены).
 * @param {{now_ms?: () => number, metrics?: object|null, on_saved?: (step: string) => void}} [o]
 */
export function make_wizard_deps(o = {}) {
  const now_ms = o.now_ms ?? (() => 0);
  return {
    metrics: o.metrics ?? null,
    now_ms,
    timer: create_step_timer({ now_ms }),
    ui: { step: null, status: null, focus: null, focus_until: 0, template: null },
    writing: false,
    on_saved: o.on_saved ?? null,
  };
}

/** Сбросить состояние экрана (набор данных заменён целиком). */
export function reset_wizard_ui(deps) {
  deps.ui.step = null;
  deps.ui.status = null;
  deps.ui.focus = null;
  deps.ui.focus_until = 0;
  deps.ui.template = null;
}

// ── узлы ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Фокус потерян: после замены узлов он на `body` (или вовсе нигде). Чужой фокус (шапка, меню) не отбирается. Без `document.activeElement` (заглушка DOM) считается потерянным. */
function focus_is_lost() {
  const doc = globalThis.document;
  const a = doc?.activeElement;
  return a === undefined || a === null || a === doc.body || a === doc.documentElement;
}

function schedule_focus(id) {
  Promise.resolve().then(() => {
    if (!focus_is_lost()) return;
    const el = el_by_id(id) ?? el_by_id('view-title');
    if (el !== null && el !== undefined && typeof el.focus === 'function') el.focus();
  });
}

/** Запросить фокус на узел с `id` после следующей отрисовки и поздних перерисовок в пределах `FOCUS_WINDOW_MS`. */
function request_focus(deps, id) {
  deps.ui.focus = id;
  deps.ui.focus_until = deps.now_ms() + FOCUS_WINDOW_MS;
}

/** Поле ввода: подпись, подсказка, место для ошибки (`role = alert`); `aria-describedby` связывает поле с подсказкой и ошибкой. */
function text_row(form, id, o = {}) {
  const dom = 'st-' + form + '-' + id;
  const input = h('input', {
    id: dom, type: o.type ?? 'text', inputmode: o.inputmode ?? null, autocomplete: 'off', spellcheck: 'false', value: o.value ?? '', min: o.min ?? null, max: o.max ?? null,
    'aria-describedby': dom + '-hint ' + dom + '-err', 'aria-required': o.required === true ? 'true' : null,
  });
  const err = h('p', { id: dom + '-err', class: 'error', role: 'alert' });
  const wrap = h('div', { class: 'field' }, h('label', { for: dom, text: o.label }), input, h('p', { id: dom + '-hint', class: 'muted', text: o.hint ?? '' }), err);
  return { wrap, input, err, id: dom, key: id };
}

function select_row(form, id, options, value, o = {}) {
  const dom = 'st-' + form + '-' + id;
  const select = h('select', { id: dom, 'aria-describedby': dom + '-err' },
    options.map((x) => h('option', { value: x.value, selected: x.value === value ? true : null, text: x.text })));
  if (value !== undefined && value !== null) select.value = value;
  const err = h('p', { id: dom + '-err', class: 'error', role: 'alert' });
  const wrap = h('div', { class: 'field' }, h('label', { for: dom, text: o.label }), select, err);
  return { wrap, input: select, err, id: dom, key: id };
}

function show_error(row, text) {
  row.err.textContent = text ?? '';
  row.input.setAttribute('aria-invalid', text === null || text === undefined || text === '' ? 'false' : 'true');
}

/** Число для поля: сумма в формате пользователя без групп тысяч и без нулевой дроби. */
function amount_text(minor, cur, lang, nf) {
  return format_input_amount(Math.abs(minor), currency_exponent(cur), resolve_number_format(lang, nf), true);
}

/** Строка о введённом правиле: «Название — 900,00 € — каждый месяц, ближайшая дата …». */
function rule_line(ctx, ws, rule) {
  const env = env_of(ctx, ws);
  const money = fmt_of(env, rule.currency).money(Math.abs(rule.amount?.exp_minor ?? 0));
  const every = rule.count === 1 ? ctx.tr('start.rep_once') : ctx.tr('start.freq_' + (OBLIGATION_FREQS.includes(rule.freq) ? rule.freq : 'M'));
  return ctx.tr('start.rule_line', { name: rule.name, amount: money, every, date: fmt_of(env).date(rule.start_date) });
}

/** Подсказки названий из шаблона-скелета (если он включён): кнопки подставляют название и частоту в форму, суммы остаются пустыми. */
function template_chips(ctx, deps, part, fill) {
  const id = deps.ui.template;
  if (id === null) return null;
  const slots = template_slots(id, part, ctx.lang());
  if (slots.length === 0) return null;
  return h('div', { class: 'start-chips', role: 'group', 'aria-label': ctx.tr('start.tpl_chips') },
    slots.map((s) => h('button', { type: 'button', class: 'chip', 'data-slot': s.slot, onclick: () => fill(s), text: s.label })));
}

/** Оболочка формы шага: форма, строка состояния (`role = status`), кнопка записи. */
function step_form(id, rows, submit_label, on_submit, extra = []) {
  const status = h('p', { class: 'muted start-status', role: 'status' });
  const form = h('form', {
    id: 'st-form-' + id, class: 'start-form', novalidate: true, 'aria-labelledby': 'st-step-title',
    onsubmit: (ev) => { if (ev !== undefined && ev !== null && typeof ev.preventDefault === 'function') ev.preventDefault(); return on_submit(); },
  }, ...kids(rows.map((f) => f.wrap)), ...kids(extra), h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn primary', text: submit_label })), status);
  return { form, status };
}

/** Показать отказ: у поля (если известно, к какому он относится) или в строке состояния; прежние отметки ошибок снимаются. */
function report_failure(ctx, ws, r, rows, status) {
  const text = error_message(ctx.tr, r.error, env_of(ctx, ws));
  for (const row of rows) show_error(row, null);
  const key = field_name(r.error);
  const target = rows.find((row) => row.key === key) ?? null;
  if (target !== null) {
    show_error(target, text);
    status.textContent = '';
    if (typeof target.input.focus === 'function') target.input.focus();
  } else status.textContent = text;
}

/**
 * Разобрать и записать шаг. Состояние экрана (`ui`) ставится ДО записи: запись перерисовывает страницу синхронно. Отказ разбора или записи
 * возвращает прежнее состояние и ничего не меняет в данных.
 */
function run_step(ctx, deps, o) {
  deps.timer.touch(); // отправка формы — действие пользователя: время до неё засчитывается шагу ДО перерисовки после записи (повторная отрисовка того же шага ничего не засчитывает)
  const ws = ctx.get_ws();
  const plan = o.plan(ws, o.texts(), o.env, ctx.new_id);
  if (!plan.ok) { report_failure(ctx, ws, plan, o.rows, o.status); return plan; }
  const prev = { ...deps.ui };
  deps.ui.status = { step: o.step, text: o.done_text(plan.summary) };
  deps.ui.step = o.next();
  request_focus(deps, o.focus_after);
  deps.writing = true;
  let r;
  try { r = commit_edits(ctx, plan.edits, plan.edits[0].type); } finally { deps.writing = false; }
  if (!r.ok) {
    Object.assign(deps.ui, prev);
    report_failure(ctx, ws, r, o.rows, o.status);
    return r;
  }
  deps.metrics?.record_step(deps.timer.done(o.step, 'saved'));
  if (typeof deps.on_saved === 'function') deps.on_saved(o.step);
  ctx.notify(deps.ui.status?.text ?? '', 'info');
  return r;
}

// ── экраны шагов ───────────────────────────────────────────────────────────────────────────────────────────────────────

function step_account(ctx, deps, m, ws, env) {
  const tr = ctx.tr;
  const acc = m.account;
  const name = text_row('acc', 'name', { label: tr('start.l_account_name'), hint: tr('start.h_account_name'), value: acc?.name ?? '' });
  const bal = text_row('acc', 'balance', {
    label: tr('start.l_balance', { cur: env.cur }), hint: tr('start.h_balance', { date: fmt_of(env).date(env.as_of) }), inputmode: 'decimal', required: true,
    value: m.anchor === null ? '' : format_input_amount(m.anchor.amount_minor, currency_exponent(acc.currency), resolve_number_format(env.lang, ws.number_format), true),
  });
  const rows = [name, bal];
  const { form, status } = step_form('acc', rows, tr('start.save_account'), () => run_step(ctx, deps, {
    step: 'account', rows, status, env, plan: plan_account, texts: () => ({ name: name.input.value, balance: bal.input.value }),
    done_text: (s) => tr('start.done_account', { name: s.name, amount: fmt_of(env, s.currency).money(s.amount_minor) }),
    next: () => 'obligations', focus_after: 'st-step-title',
  }));
  const f = fmt_of(env);
  const list = acc === null ? [] : [h('li', { text: tr('start.sum_account', { name: acc.name, amount: m.anchor === null ? tr('start.none') : f.money(m.anchor.amount_minor) }) })];
  return { rows, form, status, heading: tr('start.s1_title'), lead: tr('start.s1_lead'), list };
}

function step_obligations(ctx, deps, m, ws, env) {
  const tr = ctx.tr;
  const name = text_row('obl', 'name', { label: tr('start.f_name'), hint: tr('start.h_obl_name'), required: true });
  const amount = text_row('obl', 'amount', { label: tr('start.l_amount', { cur: env.cur }), hint: tr('start.h_obl_amount'), inputmode: 'decimal', required: true });
  const freq = select_row('obl', 'freq', OBLIGATION_FREQS.map((x) => ({ value: x, text: tr('start.freq_' + x) })), 'M', { label: tr('start.f_freq') });
  const date = text_row('obl', 'date', { label: tr('start.l_obl_date'), hint: tr('start.h_obl_date'), type: 'date', value: env.as_of, min: env.as_of, required: true });
  const rows = [name, amount, freq, date];
  const chips = template_chips(ctx, deps, 'obligations', (s) => {
    name.input.value = s.label;
    freq.input.value = s.freq;
    if (typeof amount.input.focus === 'function') amount.input.focus();
  });
  const { form, status } = step_form('obl', rows, tr('start.add_obligation'), () => run_step(ctx, deps, {
    step: 'obligations', rows, status, env, plan: plan_obligation,
    texts: () => ({ name: name.input.value, amount: amount.input.value, freq: freq.input.value, date: date.input.value }),
    done_text: (s) => tr('start.done_obligation', { name: s.name, amount: fmt_of(env, s.currency).money(s.amount_minor), n: m.obligations.length + 1, need: MIN_OBLIGATIONS }),
    next: () => 'obligations', focus_after: 'st-obl-name',
  }), [chips]);
  const count = m.obligations.length;
  // «n из 3» говорит о недоборе, а шаг может быть уже засчитан расчётом (один значимый платёж): тогда строка не противоречит отметке «учтено»
  const progress_key = count >= MIN_OBLIGATIONS ? 'start.obl_progress_ok' : (m.done.obligations ? 'start.obl_progress_engine' : 'start.obl_progress');
  return {
    rows, form, status, heading: tr('start.s2_title'), lead: tr('start.s2_lead', { need: MIN_OBLIGATIONS }),
    list: m.obligations.map((r) => h('li', { text: rule_line(ctx, ws, r) })),
    progress: tr(progress_key, { n: count, need: MIN_OBLIGATIONS }),
  };
}

function step_income(ctx, deps, m, ws, env) {
  const tr = ctx.tr;
  const name = text_row('inc', 'name', { label: tr('start.f_name'), hint: tr('start.h_inc_name') });
  const amount = text_row('inc', 'amount', { label: tr('start.l_amount', { cur: env.cur }), hint: tr('start.h_inc_amount'), inputmode: 'decimal', required: true });
  const date = text_row('inc', 'date', { label: tr('start.l_inc_date'), hint: tr('start.h_inc_date', { days: INCOME_WINDOW_DAYS }), type: 'date', value: env.as_of, min: env.as_of, required: true });
  const repeat = select_row('inc', 'repeat', INCOME_REPEATS.map((x) => ({ value: x, text: tr('start.rep_' + x) })), 'M', { label: tr('start.f_repeat') });
  const delay = text_row('inc', 'delay', { label: tr('start.l_delay'), hint: tr('start.h_delay'), inputmode: 'numeric' });
  const rows = [name, amount, date, repeat, delay];
  const chips = template_chips(ctx, deps, 'income', (s) => {
    name.input.value = s.label;
    if (typeof amount.input.focus === 'function') amount.input.focus();
  });
  const { form, status } = step_form('inc', rows, tr('start.add_income'), () => run_step(ctx, deps, {
    step: 'income', rows, status, env, plan: plan_income,
    texts: () => ({ name: name.input.value, amount: amount.input.value, date: date.input.value, repeat: repeat.input.value, delay: delay.input.value }),
    done_text: (s) => tr('start.done_income', { name: s.name, amount: fmt_of(env, s.currency).money(s.amount_minor) })
      + (to_epoch_day(s.date) - to_epoch_day(env.as_of) > INCOME_WINDOW_DAYS ? ' ' + tr('start.income_far', { days: INCOME_WINDOW_DAYS }) : ''),
    next: () => 'income', focus_after: 'st-inc-name',
  }), [chips]);
  return {
    rows, form, status, heading: tr('start.s3_title'), lead: tr('start.s3_lead', { days: INCOME_WINDOW_DAYS }),
    list: m.incomes.map((r) => h('li', { text: rule_line(ctx, ws, r) })),
  };
}

function step_daily(ctx, deps, m, ws, env) {
  const tr = ctx.tr;
  const old = m.estimate;
  const name = text_row('day', 'name', { label: tr('start.f_name'), hint: tr('start.h_day_name'), value: old?.name ?? '' });
  const amount = text_row('day', 'amount', {
    label: tr('start.l_amount', { cur: env.cur }), hint: tr('start.h_day_amount'), inputmode: 'decimal', required: true,
    value: old === null ? '' : amount_text(old.amount?.exp_minor ?? 0, old.currency, env.lang, ws.number_format),
  });
  const period = select_row('day', 'period', DAILY_PERIODS.map((x) => ({ value: x, text: tr('start.per_' + x) })), old?.freq === 'M' ? 'M' : 'W', { label: tr('start.f_period') });
  const rows = [name, amount, period];
  const chips = template_chips(ctx, deps, 'daily', (s) => {
    name.input.value = s.label;
    period.input.value = s.freq === 'M' ? 'M' : 'W';
    if (typeof amount.input.focus === 'function') amount.input.focus();
  });
  const { form, status } = step_form('day', rows, tr('start.save_daily'), () => run_step(ctx, deps, {
    step: 'daily', rows, status, env, plan: plan_daily,
    texts: () => ({ name: name.input.value, amount: amount.input.value, period: period.input.value }),
    done_text: (s) => tr('start.done_daily', { amount: fmt_of(env, s.currency).money(s.amount_minor), per: tr('start.per_' + s.period) }),
    next: () => 'buffer', focus_after: 'st-step-title',
  }), [chips]);
  return { rows, form, status, heading: tr('start.s4_title'), lead: tr('start.s4_lead'), list: old === null ? [] : [h('li', { text: rule_line(ctx, ws, old) })] };
}

function step_buffer(ctx, deps, m, ws, env, model) {
  const tr = ctx.tr;
  const hint = buffer_hint_of(model);
  const amount = text_row('buf', 'amount', {
    label: tr('start.l_buffer', { cur: env.cur }), hint: hint === null ? tr('start.h_buffer_none') : tr('start.h_buffer', { value: fmt_of(env).money(hint) }), inputmode: 'decimal', required: true,
    value: m.buffer.set ? amount_text(m.buffer.value, env.cur, env.lang, ws.number_format) : '',
  });
  const rows = [amount];
  const { form, status } = step_form('buf', rows, tr('start.save_buffer'), () => run_step(ctx, deps, {
    step: 'buffer', rows, status, env, plan: plan_buffer, texts: () => ({ amount: amount.input.value }),
    done_text: (s) => tr('start.done_buffer', { amount: fmt_of(env, s.currency).money(s.amount_minor) }),
    next: () => 'buffer', focus_after: 'st-step-title',
  }));
  const extra = hint === null ? [] : [h('p', null, h('button', {
    type: 'button', class: 'btn', id: 'st-use-hint', onclick: () => { amount.input.value = amount_text(hint, env.cur, env.lang, ws.number_format); }, text: tr('start.use_hint'),
  }))];
  return { rows, form, status, heading: tr('start.s5_title'), lead: tr('start.s5_lead'), list: [], extra };
}

const STEP_VIEWS = { account: step_account, obligations: step_obligations, income: step_income, daily: step_daily, buffer: step_buffer };

// ── прогноз ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Раздел «Прогноз»: пока `s < ready.q1` — что не набрано (причины движка); при `s ≥ ready.q1` — узкая точка по обоим режимам и что ещё не учтено. */
function forecast_section(ctx, m, model) {
  const tr = ctx.tr;
  const ws = model.ws;
  const f = fmt_of(env_of(ctx, ws));
  const missing = m.reasons.map((r) => tr(miss_key(r)));
  const head = h('h3', { id: 'st-fc-title', text: tr('start.fc_title') });
  if (!m.forecast_visible) {
    return h('section', { id: 'st-forecast', class: 'card start-forecast', 'aria-labelledby': 'st-fc-title' }, head,
      h('p', { class: 'banner', role: 'status', text: tr('start.fc_wait', { q1: m.q1, score: m.score }) }),
      h('ul', { class: 'plain' }, missing.map((x) => h('li', { text: x }))));
  }
  const a = model.ctx;
  const lang = ctx.lang();
  return h('section', { id: 'st-forecast', class: 'card start-forecast', 'aria-labelledby': 'st-fc-title' }, head,
    h('p', { class: 'start-big', role: 'status', text: tr('start.fc_ready', { score: m.score }) }),
    h('ul', { class: 'plain' }, MODES.map((mode) => {
      const np = narrowest_point(a.series[mode], a.as_of, a.horizon_end);
      return h('li', null, h('strong', { text: LABELS.modes[lang][mode] + ': ' }), tr('start.fc_line', { value: f.money(np.amount_minor), date: f.date(np.date) }));
    })),
    missing.length === 0 ? null : h('div', { class: 'banner', role: 'status' }, h('p', { text: tr('start.fc_missing') }), h('ul', null, missing.map((x) => h('li', { text: x })))),
    m.verdict_gate === null
      ? h('p', { text: tr('start.fc_verdict_on') })
      : h('p', { class: 'muted', text: tr('start.fc_verdict_off', { reasons: m.verdict_gate.reasons.map((r) => tr(gate_key(r), { q3: a.params['ready.q3'] ?? 4 })).join('; ') }) }),
    h('p', { class: 'actions' },
      h('a', { class: 'btn', href: '#overview', text: tr('start.go_overview') }),
      m.verdict_gate === null ? h('a', { class: 'btn', href: '#buy', text: tr('start.go_buy') }) : null));
}

// ── экран ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

function go_step(ctx, deps, step) {
  deps.timer.touch();
  deps.ui.step = step;
  deps.ui.status = null;
  request_focus(deps, 'st-step-title');
  ctx.refresh();
}

function progress_list(ctx, deps, m, current) {
  const tr = ctx.tr;
  return h('ol', { class: 'start-steps', 'aria-label': tr('start.steps_label') }, STEPS.map((s, i) => {
    const state = s === 'buffer' ? (m.done[s] ? tr('start.st_buf_set') : tr('start.st_buf_unset')) : (m.done[s] ? tr('start.st_done') : tr('start.st_open'));
    const here = s === current;
    return h('li', null, h('button', {
      type: 'button', class: here ? 'btn primary' : 'btn', 'data-step': s, 'aria-current': here ? 'step' : null, onclick: () => go_step(ctx, deps, s),
      text: tr('start.step_label', { n: s === 'buffer' ? '+' : String(i + 1) + '.', name: tr('start.sn_' + s), state }),
    }));
  }));
}

function template_block(ctx, deps) {
  const tr = ctx.tr;
  const id = deps.ui.template;
  if (id === null) {
    return h('div', { class: 'row start-template' },
      h('button', { type: 'button', class: 'btn', id: 'st-template-on', onclick: () => { deps.ui.template = TEMPLATE_IDS[0]; request_focus(deps, 'st-template-off'); ctx.refresh(); }, text: tr('start.tpl_on') }),
      h('span', { class: 'muted', text: tr('start.tpl_hint') }));
  }
  const t = TEMPLATES[id];
  const lang = ctx.lang();
  return h('div', { class: 'banner start-template', role: 'group', 'aria-label': t.title[lang] },
    h('p', null, h('strong', { text: t.title[lang] })),
    h('p', { text: t.note[lang] }),
    h('p', { text: tr('start.tpl_ttl', { days: t.review.ttl_days }) }),
    h('p', { text: tr('start.tpl_review_pending') }),
    h('button', { type: 'button', class: 'btn', id: 'st-template-off', onclick: () => { deps.ui.template = null; request_focus(deps, 'st-template-on'); ctx.refresh(); }, text: tr('start.tpl_off') }));
}

/**
 * Экран «Старт» (#start): ход по шагам, текущий шаг с формой, прогноз, шаблон. Страница перерисовывается после каждой записи.
 * @param {object} ctx контекст расширений
 * @param {ReturnType<typeof make_wizard_deps>} deps
 * @returns {HTMLElement}
 */
export function render_start(ctx, deps) {
  const tr = ctx.tr;
  const root = h('div', { class: 'view start' }, h('h2', { id: 'view-title', tabindex: '-1', text: tr('start.title') }), h('p', { class: 'lead', text: tr('start.lead') }));
  const ws = ctx.get_ws();
  const model = ctx.get_model();
  if (ws === null || ws === undefined || model === null || model === undefined) { root.append(h('p', { class: 'muted', text: tr('start.no_data') })); return root; }
  const env = { ...env_of(ctx, ws), default_account_name: tr('start.default_account'), default_daily_name: tr('start.default_daily'), default_income_name: tr('start.default_income') };
  const m = wizard_model(model);
  const step = STEPS.includes(deps.ui.step) ? deps.ui.step : m.first_open;
  deps.timer.enter(step);
  const built = STEP_VIEWS[step](ctx, deps, m, ws, env, model);
  built.status.textContent = deps.ui.status !== null && deps.ui.status.step === step ? deps.ui.status.text : '';
  const prev = prev_step(step);
  const next = next_step(step);
  const nav = h('div', { class: 'row start-nav' },
    prev === null ? null : h('button', { type: 'button', class: 'btn', id: 'st-back', onclick: () => go_step(ctx, deps, prev), text: tr('start.back') }),
    next === null ? null : (m.done[step]
      ? h('button', { type: 'button', class: 'btn', id: 'st-next', onclick: () => go_step(ctx, deps, next), text: tr('start.next') })
      : h('button', {
        type: 'button', class: 'btn', id: 'st-skip',
        onclick: () => { deps.metrics?.record_step(deps.timer.done(step, 'skipped')); go_step(ctx, deps, next); }, text: tr('start.skip'),
      })));
  const touch = () => deps.timer.touch();
  const card = h('section', { id: 'st-step', class: 'card start-step', 'aria-labelledby': 'st-step-title' },
    h('h3', { id: 'st-step-title', tabindex: '-1', text: built.heading }),
    h('p', { class: 'lead', text: built.lead }),
    built.progress === undefined ? null : h('p', { class: 'start-progress', role: 'status', text: built.progress }),
    built.list.length === 0 ? null : h('div', null, h('p', { class: 'muted', text: tr('start.entered') }), h('ul', { class: 'plain start-list' }, built.list),
      step === 'obligations' || step === 'income' ? h('p', { class: 'muted' }, tr('start.edit_in_forms') + ' ', h('a', { class: 'link', href: '#forms', text: tr('start.go_forms') })) : null),
    built.form,
    ...kids(built.extra ?? []),
    nav);
  card.addEventListener('input', touch);
  card.addEventListener('change', touch);
  card.addEventListener('click', touch);
  const forecast = forecast_section(ctx, m, model);
  // готовый прогноз — выше формы (он и есть результат шагов); пока его нет, вперёд идёт форма шага, а «ожидание» — под ней
  root.append(progress_list(ctx, deps, m, step), ...(m.forecast_visible ? [forecast, card] : [card, forecast]), template_block(ctx, deps),
    h('p', { class: 'muted start-note', text: tr('start.disclaimer') }));
  // фокус не сбрасывается сразу: поздняя перерисовка (хранилище просит ctx.refresh() после записи) заменит узлы ещё раз, и он вернётся; по истечении окна запрос снимается
  if (deps.ui.focus !== null) {
    if (deps.now_ms() <= deps.ui.focus_until) schedule_focus(deps.ui.focus);
    else deps.ui.focus = null;
  }
  return root;
}

/** Карточка «Старт» для «Обзора»: пока данных мало для вердикта (нет `s = ready.q3` или буфера), ведёт в мастер. Иначе — ничего. */
export function render_start_card(ctx) {
  const model = ctx.get_model();
  if (model === null || model === undefined) return null;
  const m = wizard_model(model);
  const q3 = model.ctx.params['ready.q3'] ?? 4;
  if (m.score >= q3 && m.buffer.set) return null;
  const tr = ctx.tr;
  return h('section', { class: 'card start-card', 'aria-labelledby': 'st-card-title' },
    h('h3', { id: 'st-card-title', text: tr('start.card_title') }),
    h('p', { text: m.forecast_visible ? tr('start.card_partial', { score: m.score }) : tr('start.card_empty') }),
    h('p', null, h('a', { class: 'btn primary', href: '#start', text: tr('start.card_go') })));
}
