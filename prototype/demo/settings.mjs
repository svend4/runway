// settings.mjs — экран «Настройки» (#settings, FP-03): буфер с подсказкой `buffer_hint` (REQ-026), «сегодня» — дата расчёта (as_of.mjs, правка `set_as_of`),
// горизонт и сдвиг режима «если хуже» (REQ-024), параметры волн и допуски сопоставления, формат чисел и дат отдельно от языка (REQ-112).
// Запись только через общий путь: проверка `apply_edit` (`set_param` для параметров, `set_number_format` для формата показа) → один `ctx.set_ws`
// на форму → пересчёт страницей → журнал. Отказ проверки или пересчёта ничего не меняет, форма показывает причину.
// Устройство файла: сначала чистые модели и разбор полей (без DOM, проверяются в Node), затем узлы (`h` из dom.mjs: только textContent и узлы,
// без inline-стилей и обработчиков-строк). Расчёт по введённым данным и правилам, не консультация.
// FP-29 (ALG-08 A08.7): «Валюта решения» — выбор из валют счетов и курсов, запись правкой `set_decision_currency` поверх `set_param` (decision_currency.mjs); пересчёт идёт
// в выбранной валюте, нет курса пары — отказ с парой и путём к вводу курса (banner_texts.mjs), данные не меняются.
// FP-21 (REQ-150): в конце экрана — карточка «Расчёт в фоне» (calc_settings.mjs): флаг устройства, который выключает Web Worker расчёта; не форма и не запись в данные.
// FP-17 (REQ-019, REQ-016): под каждым полем параметра — «по умолчанию N» и «Вернуть по умолчанию» (`settings_defaults.mjs`), ниже — таблица всех параметров;
// в режиме «только чтение» (файл новее известного формата) поля и кнопки отключены, сверху сказано почему.

import { h, el_by_id } from './dom.mjs';
import { apply_edit, PARAM_SPECS } from './ws_edit.mjs';
import { buffer_hint, outflow_90, narrowest_point, list_waves_ex, currency_exponent } from '../engine/index.mjs';
import {
  make_nf_fmt, parse_decimal_text, parse_amount_text, format_input_amount, format_preview, resolve_number_format, preset_of, date_style_of,
  sanitize_number_format, NUMBER_PRESETS, DATE_STYLES,
} from './number_format.mjs';
import { ready_card, MODES } from './home_cards.mjs';
import { horizon_ahead_of } from './horizon.mjs'; // FP-49: дней вперёд от даты расчёта — то же выражение, что у шапки, «Запаса хода» и листа
import { plan_as_of_edit, as_of_model, AS_OF_MIN, AS_OF_MAX } from './as_of.mjs';
import { clock_ports, local_today } from './ids.mjs';
import { default_line, defaults_section, reset_edit } from './settings_defaults.mjs';
import { create_focus_keeper } from './focus_keep.mjs';
import { decision_model, plan_decision_edit, candidate_pairs } from './decision_currency.mjs';
import { no_rate_text } from './banner_texts.mjs';
import { rate_text } from './forms.mjs';
import { rate_date_text } from './rate_chip.mjs';
import { calc_card } from './calc_settings.mjs'; // FP-21 (REQ-150): флаг устройства «Считать в фоне (Web Worker)»; карточка без формы и без записи в данные

/** Хранитель фокуса экрана: «Вернуть по умолчанию» убирает нажатую кнопку из таблицы, а хранилище (FP-05) перерисовывает страницу ещё раз позже — на настоящем браузере фокус уходил на body (проход 2026-10-23). */
const FOCUS = create_focus_keeper(() => clock_ports().now_ms());

// ── описание полей ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Поля форм: `key` — параметр рабочей области (как в `vocab.json`), `id` — короткое имя для строк и идентификаторов страницы, `type` — `int`
 * (целое с границами из `PARAM_SPECS`), `money` (сумма в валюте решения, `nullable` — пусто значит «не задан»), `percent` (проценты → базисные пункты).
 */
export const SECTIONS = Object.freeze({
  buffer: Object.freeze([{ key: 'buffer_minor', id: 'buffer', type: 'money', nullable: true }]),
  horizon: Object.freeze([{ key: 'horizon_days', id: 'horizon', type: 'int' }, { key: 'worse.income_delay_days', id: 'delay', type: 'int' }]),
  waves: Object.freeze([
    { key: 'wave.gap_days', id: 'gap', type: 'int' },
    { key: 'wave.max_span_days', id: 'span', type: 'int' },
    { key: 'wave.threshold_minor', id: 'threshold', type: 'money', nullable: true },
  ]),
  match: Object.freeze([{ key: 'match.window_days', id: 'window', type: 'int' }, { key: 'match.tol_bp', id: 'tol', type: 'percent' }]),
});

// ── разбор полей и план правок (чистые функции) ────────────────────────────────────────────────────────────────────

/**
 * Разобрать текст поля.
 * @param {{key: string, type: 'int'|'money'|'percent', nullable?: boolean}} def
 * @param {string} text
 * @param {{cur: string, lang: 'ru'|'en', nf?: any}} env валюта решения, язык и `ws.number_format`
 * @returns {{ok: true, value: number|null}|{ok: false, reason: 'empty'|'bad_number'|'negative'|'too_big'|'range', min?: string, max?: string}}
 */
export function parse_field(def, text, env) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (raw === '') return def.nullable === true ? { ok: true, value: null } : { ok: false, reason: 'empty' };
  const sp = PARAM_SPECS[def.key];
  if (def.type === 'int') {
    if (/^[-−]\d+$/.test(raw)) return { ok: false, reason: 'negative' };
    if (!/^\d{1,9}$/.test(raw)) return { ok: false, reason: 'bad_number' };
    const v = Number(raw);
    if (v < sp.min || v > sp.max) return { ok: false, reason: 'range', min: String(sp.min), max: String(sp.max) };
    return { ok: true, value: v };
  }
  if (def.type === 'money') {
    const r = parse_amount_text(raw, env.cur, env.lang, env.nf);
    return r.ok ? { ok: true, value: r.value } : { ok: false, reason: r.reason };
  }
  // проценты: сотые доли процента — это базисные пункты (5,25 % = 525 bp), без float
  const r = parse_decimal_text(raw.replace(/\s*%$/, ''), { exponent: 2, lang: env.lang, nf: env.nf });
  if (!r.ok) return { ok: false, reason: r.reason };
  if (r.value < sp.min || r.value > sp.max) return { ok: false, reason: 'range', min: '0', max: String(sp.max / 100) };
  return { ok: true, value: r.value };
}

/** Действующее значение поля: целые и проценты — с умолчаниями движка; суммы с «не задан» — только явное значение рабочей области (`null`, если его нет). */
export function current_value(model, def) {
  if (def.type === 'money') {
    const v = model.ws.params?.[def.key];
    return Number.isSafeInteger(v) ? v : null;
  }
  return model.ctx.params[def.key];
}

/** Текст поля при открытии экрана: десятичный знак — по формату, групп тысяч нет (число можно редактировать). */
export function initial_text(model, def, env) {
  const v = current_value(model, def);
  if (v === null || v === undefined) return '';
  if (def.type === 'int') return String(v);
  const r = resolve_number_format(env.lang, env.nf);
  return def.type === 'percent' ? format_input_amount(v, 2, r, true) : format_input_amount(v, currency_exponent(env.cur), r, false);
}

/**
 * План правок формы: разбирает все поля раздела; при любой ошибке правок нет (форма принимается целиком или отвергается целиком);
 * значения, равные действующим, не пишутся.
 * @param {{ws: object, ctx: object}} model
 * @param {'buffer'|'horizon'|'waves'|'match'} section
 * @param {Object<string, string>} texts текст поля по `key`
 * @param {{cur: string, lang: 'ru'|'en', nf?: any}} env
 * @returns {{errors: Object<string, object>, edits: {type: 'set_param', key: string, value: number|null}[]}}
 */
export function plan_section_edits(model, section, texts, env) {
  const errors = {};
  const edits = [];
  for (const def of SECTIONS[section]) {
    const r = parse_field(def, texts[def.key], env);
    if (!r.ok) { errors[def.key] = r; continue; }
    if (current_value(model, def) !== r.value) edits.push({ type: 'set_param', key: def.key, value: r.value });
  }
  return { errors, edits };
}

/**
 * Применить правки формы: каждая проходит `apply_edit` (отказ — вся форма отвергнута), результат — один `ctx.set_ws` (один пересчёт, одна запись журнала).
 * @param {object} ctx контекст расширений
 * @param {object[]} edits правки `set_param` / `set_number_format`
 * @returns {{ok: true, unchanged?: true, changed?: number}|{ok: false, error: {code: string, ctx: object|null}, edit: object}}
 */
export function save_edits(ctx, edits) {
  if (edits.length === 0) return { ok: true, unchanged: true };
  let ws = ctx.get_ws();
  for (const e of edits) {
    const r = apply_edit(ws, e, { new_id: ctx.new_id });
    if (!r.ok) return { ok: false, error: r.error, edit: e };
    ws = r.ws;
  }
  const s = ctx.set_ws(ws, { reason: edits[0].type });
  return s.ok ? { ok: true, changed: edits.length } : { ok: false, error: s.error, edit: edits[0] };
}

// ── чистые модели экрана ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Буфер (REQ-026): действующее значение (`null` — не задан; `0` — задан), подсказка `buffer_hint` (только факт последних 90 дней; `null` — истории нет)
 * и число, из которого она получена.
 */
export function buffer_model(model) {
  const a = model.ctx;
  const B = a.buffer_minor;
  return {
    value: B === undefined ? null : B,
    is_set: B !== null && B !== undefined,
    hint: buffer_hint(model.ws, a.as_of),
    hint_days: a.params.buffer_hint_days,
    outflow_90: outflow_90(model.ws, a.as_of),
  };
}

/**
 * Режим «если хуже» (REQ-024): сдвиг режима, сдвиг сценария (операции `delay_income` активного сценария), их сумма и узкая точка в обоих режимах.
 * Подпись «сдвиг сценария + сдвиг режима» — C-009: сценарий меняет дату данных, режим добавляет свой сдвиг.
 */
export function worse_model(model) {
  const a = model.ctx;
  const mode_days = a.params['worse.income_delay_days'];
  let scenario_days = 0;
  for (const op of model.scenario?.ops ?? []) if (op?.op === 'delay_income' && Number.isSafeInteger(op.days)) scenario_days += op.days;
  const narrow = {};
  for (const m of MODES) {
    const p = narrowest_point(a.series[m], a.as_of, a.horizon_end);
    narrow[m] = { date: p.date, amount_minor: p.amount_minor };
  }
  return { mode_days, scenario_days, total_days: scenario_days + mode_days, narrow };
}

/** Параметры волн и допуски: действующие значения, порог по умолчанию (`wave.threshold_minor` пуст → считает движок) и число найденных волн. */
export function wave_model(model) {
  const a = model.ctx;
  const counts = {};
  for (const m of MODES) {
    try { counts[m] = list_waves_ex(a, m).items.length; } catch { counts[m] = null; }
  }
  return {
    gap_days: a.params['wave.gap_days'],
    max_span_days: a.params['wave.max_span_days'],
    threshold_effective: a.params['wave.threshold_minor'],
    threshold_explicit: current_value(model, SECTIONS.waves[2]),
    counts,
  };
}

/** Настройка показа, которая получится из выбора пресета чисел и стиля даты (`custom` — оставить текущие числа из файла). */
export function candidate_number_format(current, preset, date) {
  if (preset !== 'custom' && !Object.hasOwn(NUMBER_PRESETS, preset)) return { ok: false, reason: 'bad_preset' };
  if (!DATE_STYLES.includes(date)) return { ok: false, reason: 'bad_date_style' };
  const cur = sanitize_number_format(current);
  const next = {};
  if (preset === 'custom') {
    if (cur?.decimal !== undefined) { next.decimal = cur.decimal; next.thousands = cur.thousands; }
  } else if (preset !== 'auto') {
    next.decimal = NUMBER_PRESETS[preset].decimal;
    next.thousands = NUMBER_PRESETS[preset].thousands;
  }
  if (date !== 'auto') next.date = date;
  return { ok: true, value: Object.keys(next).length === 0 ? null : next };
}

/** Правка формата показа: пусто, если выбор совпадает с текущим. Суммы и даты данных не затрагиваются (REQ-112). */
export function plan_format_edit(model, preset, date) {
  const c = candidate_number_format(model.ws.number_format, preset, date);
  if (!c.ok) return { ok: false, reason: c.reason, edits: [] };
  const same = JSON.stringify(sanitize_number_format(model.ws.number_format)) === JSON.stringify(c.value);
  return { ok: true, edits: same ? [] : [{ type: 'set_number_format', number_format: c.value }] };
}

// ── узлы ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Режим «только чтение» (FP-17): `null` или описание; контекст без этого метода (тесты) — обычный режим. */
const ro_of = (ctx) => (typeof ctx.read_only === 'function' ? ctx.read_only() : null);

/** Что показать после перерисовки: раздел, который только что сохранён, и поле, куда вернуть фокус (перерисовка заменяет страницу целиком). */
let pending = null;

function env_of(ctx, model) {
  return { cur: model.cur, lang: ctx.lang(), nf: model.ws.number_format, exp: currency_exponent(model.cur) };
}

function error_text(ctx, error) {
  if (error?.ctx?.reason === 'read_only') return ctx.tr('ro.refused'); // режим «только чтение» (FP-17)
  const code = typeof error?.code === 'string' ? error.code : 'E_SCHEMA';
  if (code === 'E_NO_RATE') return no_rate_text(ctx.tr, error.ctx); // FP-29: пара валют и путь к вводу курса вместо общего «нет курса»
  const s = ctx.tr('err.' + code);
  return s === 'err.' + code ? ctx.tr('err.other') : s;
}

function schedule_focus(id) {
  const focus_now = (only_if_lost) => {
    const doc = globalThis.document;
    const active = doc?.activeElement;
    if (only_if_lost && active !== undefined && active !== null && active !== doc.body) return;
    const el = el_by_id(id);
    if (el !== null && el !== undefined && typeof el.focus === 'function') el.focus();
  };
  Promise.resolve().then(() => focus_now(false));
  // хранилище (FP-05) просит ещё одну перерисовку через microtask уже после записи и заменяет поле: если фокус за это время ушёл на body,
  // возвращаем его в следующем такте (тот же приём, что у мастера «Старт» и диалога «Править волну»)
  setTimeout(() => focus_now(true), 0);
}

function make_field(ctx, def, value, hint_text, disabled = false) {
  const id = 'set-' + def.id;
  const input = h('input', {
    id, type: 'text', inputmode: def.type === 'int' ? 'numeric' : 'decimal', autocomplete: 'off', spellcheck: 'false', value, disabled,
    'aria-describedby': id + '-hint ' + id + '-err',
  });
  const err = h('p', { id: id + '-err', class: 'error', role: 'alert' });
  const wrap = h('div', { class: 'field' },
    h('label', { for: id, text: ctx.tr('settings.f_' + def.id) }), input, h('p', { id: id + '-hint', class: 'muted', text: hint_text }), err);
  return { wrap, input, err };
}

function show_error(ctx, field, e, def, env) {
  const example = def.type === 'int' ? '14' : def.type === 'percent' ? format_input_amount(500, 2, resolve_number_format(env.lang, env.nf), true) : format_input_amount(123450, env.exp, resolve_number_format(env.lang, env.nf));
  field.err.textContent = e === undefined ? '' : ctx.tr('settings.e_' + e.reason, { min: e.min ?? '', max: e.max ?? '', example });
  field.input.setAttribute('aria-invalid', e === undefined ? 'false' : 'true');
}

/** Записать правки формы: `pending` ставится до записи (запись перерисовывает страницу синхронно), при отказе — сообщение в форме. */
function commit(ctx, status, edits, section, focus_id) {
  pending = { section, focus: focus_id };
  const r = save_edits(ctx, edits);
  if (r.ok) { ctx.notify(ctx.tr('settings.saved'), 'info'); return r; }
  pending = null;
  const msg = ctx.tr('settings.save_failed', { reason: error_text(ctx, r.error) });
  status.textContent = msg;
  ctx.notify(msg, 'error');
  return r;
}

function hint_for(ctx, model, def, env, f) {
  const tr = ctx.tr;
  const sp = PARAM_SPECS[def.key];
  if (def.id === 'buffer') return tr('settings.h_buffer', { cur: model.cur });
  if (def.id === 'threshold') return tr('settings.h_threshold', { value: f.money(model.ctx.params['wave.threshold_minor']) });
  if (def.type === 'percent') return tr('settings.h_tol', { max: String(sp.max / 100) });
  return tr('settings.h_' + def.id, { min: String(sp.min), max: String(sp.max) });
}

/** Секция параметров: поля из `SECTIONS[id]`, дополнительные узлы (подсказки, предпросмотр) и общая кнопка «Сохранить». */
function param_section(ctx, model, id, flash, extra_before = []) {
  const env = env_of(ctx, model);
  const f = make_nf_fmt(env.lang, model.cur, model.as_of_iso, env.nf);
  const defs = SECTIONS[id];
  const ro = ro_of(ctx) !== null;
  const fields = new Map();
  for (const d of defs) fields.set(d.key, make_field(ctx, d, initial_text(model, d, env), hint_for(ctx, model, d, env, f), ro));
  const status = h('p', { class: 'muted fp03-status', role: 'status', text: flash === id ? ctx.tr('settings.saved') : '' });
  // «по умолчанию N» и «Вернуть по умолчанию» под каждым полем (FP-17): значение по умолчанию — данные словаря; возврат — правка set_param с reset
  for (const d of defs) {
    const line = default_line(ctx, model, d.key, { id: 'set-' + d.id, disabled: ro, on_reset: (key) => commit(ctx, status, [reset_edit(key)], id, 'set-' + d.id) });
    if (line !== null) fields.get(d.key).wrap.append(line);
  }
  const submit = (ev) => {
    if (ev !== undefined && ev !== null && typeof ev.preventDefault === 'function') ev.preventDefault();
    const texts = {};
    for (const d of defs) texts[d.key] = fields.get(d.key).input.value;
    const plan = plan_section_edits(model, id, texts, env);
    for (const d of defs) show_error(ctx, fields.get(d.key), plan.errors[d.key], d, env);
    if (Object.keys(plan.errors).length > 0) { status.textContent = ctx.tr('settings.fix_errors'); return plan; }
    if (plan.edits.length === 0) { status.textContent = ctx.tr('settings.unchanged'); return plan; }
    commit(ctx, status, plan.edits, id, 'set-' + defs[0].id);
    return plan;
  };
  const form = h('form', { class: 'card fp03-form', id: 'settings-' + id, novalidate: true, 'aria-labelledby': 'settings-' + id + '-title', onsubmit: submit },
    h('h3', { id: 'settings-' + id + '-title', text: ctx.tr('settings.s_' + id) }),
    h('p', { class: 'lead', text: ctx.tr('settings.l_' + id) }),
    ...extra_before,
    ...defs.map((d) => fields.get(d.key).wrap),
    h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn primary', disabled: ro, text: ctx.tr('settings.save') })),
    status);
  return { form, fields, submit, status };
}

function buffer_section(ctx, model, flash) {
  const env = env_of(ctx, model);
  const f = make_nf_fmt(env.lang, model.cur, model.as_of_iso, env.nf);
  const bm = buffer_model(model);
  const hint_line = bm.hint === null
    ? ctx.tr('settings.buffer_hint_none')
    : ctx.tr('settings.buffer_hint', { value: f.money(bm.hint), days: bm.hint_days, outflow: f.money(bm.outflow_90) });
  const now = h('p', { class: bm.is_set ? null : 'banner', text: bm.is_set ? ctx.tr('settings.buffer_now', { value: f.money(bm.value) }) : ctx.tr('settings.buffer_now_unset') });
  const sec = param_section(ctx, model, 'buffer', flash, [now, h('p', { class: 'muted', text: hint_line })]);
  const take = h('button', {
    type: 'button', class: 'btn', disabled: bm.hint === null || ro_of(ctx) !== null, text: ctx.tr('settings.buffer_take_hint'),
    onclick: () => {
      if (bm.hint === null) return;
      const field = sec.fields.get('buffer_minor');
      field.input.value = format_input_amount(bm.hint, env.exp, resolve_number_format(env.lang, env.nf));
      if (typeof field.input.focus === 'function') field.input.focus();
      sec.status.textContent = ctx.tr('settings.buffer_taken');
    },
  });
  sec.fields.get('buffer_minor').wrap.append(h('div', { class: 'row' }, take));
  return sec.form;
}

function horizon_section(ctx, model, flash) {
  const env = env_of(ctx, model);
  const f = make_nf_fmt(env.lang, model.cur, model.as_of_iso, env.nf);
  const wm = worse_model(model);
  const ahead = horizon_ahead_of(model.ctx.series); // дней вперёд от даты расчёта = значение поля «Горизонт, дней»; строк в ряду на одну больше (FP-48, FP-49)
  const lines = [
    h('p', { class: 'muted', id: 'set-horizon-now', text: ctx.tr('settings.horizon_now', { n: f.days(ahead), date: f.date(model.ctx.horizon_end) }) }),
    h('p', { class: 'muted', text: ctx.tr('settings.worse_shift', { n: f.days(wm.mode_days) }) }),
    wm.scenario_days > 0
      ? h('p', { class: 'banner scenario', text: ctx.tr('settings.worse_sum', { scenario: f.days(wm.scenario_days), mode: f.days(wm.mode_days), total: f.days(wm.total_days) }) })
      : null,
    h('p', { text: ctx.tr('settings.worse_narrow', {
      plan_value: f.money(wm.narrow.plan.amount_minor), plan_date: f.date(wm.narrow.plan.date),
      worse_value: f.money(wm.narrow.worse.amount_minor), worse_date: f.date(wm.narrow.worse.date),
    }) }),
    wm.mode_days === 0 ? h('p', { class: 'muted', text: ctx.tr('settings.worse_zero') }) : null,
  ];
  return param_section(ctx, model, 'horizon', flash, lines).form;
}

/** Местная дата с часов компьютера (`YYYY-MM-DD`); `null`, если часов или `crypto`-портов нет. */
function clock_today() {
  try { return local_today(clock_ports()); } catch { return null; }
}

/**
 * «Сегодня» (дата расчёта `ws.as_of`): поле даты, кнопка «Взять дату с часов», возраст остатка по якорю и сдвиг относительно часов компьютера.
 * Запись — правка `set_as_of` через общий путь `commit` → `save_edits`: раньше последней проведённой записи дату ставить нельзя.
 */
function today_section(ctx, model, flash, clock) {
  const tr = ctx.tr;
  const env = env_of(ctx, model);
  const f = make_nf_fmt(env.lang, model.cur, model.as_of_iso, env.nf);
  const tm = as_of_model(model, clock());
  const age_line = tm.anchor_age === null
    ? h('p', { class: 'banner', text: tr('settings.today_no_anchor') })
    : tm.level === 'fresh'
      ? h('p', { class: 'muted', text: tr('settings.today_age_fresh', { age: f.days(tm.anchor_age), left: f.days(tm.left_to_banner) }) })
      : h('p', { class: 'banner', text: tr('settings.today_age_stale', { age: f.days(tm.anchor_age) }) });
  const clock_line = tm.clock === null ? null : h('p', { class: 'muted', text: tm.shift_days === 0
    ? tr('settings.today_clock_same', { date: f.date(tm.clock) })
    : tr(tm.shift_days > 0 ? 'settings.today_clock_later' : 'settings.today_clock_earlier', { date: f.date(tm.clock), days: f.days(Math.abs(tm.shift_days)) }) });
  const id = 'set-today';
  const ro = ro_of(ctx) !== null;
  const input = h('input', { id, type: 'date', value: tm.as_of, min: AS_OF_MIN, max: AS_OF_MAX, autocomplete: 'off', disabled: ro, 'aria-describedby': id + '-hint ' + id + '-err' });
  const err = h('p', { id: id + '-err', class: 'error', role: 'alert' });
  const status = h('p', { class: 'muted fp03-status', role: 'status', text: flash === 'today' ? tr('settings.saved') : '' });
  const take = h('button', {
    type: 'button', class: 'btn', disabled: tm.clock === null || ro, text: tr('settings.today_take_clock'),
    onclick: () => {
      if (tm.clock === null) return;
      input.value = tm.clock;
      if (typeof input.focus === 'function') input.focus();
      status.textContent = tr('settings.today_taken');
    },
  });
  const submit = (ev) => {
    if (ev !== undefined && ev !== null && typeof ev.preventDefault === 'function') ev.preventDefault();
    const plan = plan_as_of_edit(model, input.value);
    if (!plan.ok) {
      err.textContent = tr('settings.e_today_' + plan.reason, { min: AS_OF_MIN, max: AS_OF_MAX, latest: plan.latest === undefined ? '' : f.date(plan.latest) });
      input.setAttribute('aria-invalid', 'true');
      status.textContent = tr('settings.fix_errors');
      return plan;
    }
    err.textContent = '';
    input.setAttribute('aria-invalid', 'false');
    if (plan.edits.length === 0) { status.textContent = tr('settings.unchanged'); return plan; }
    commit(ctx, status, plan.edits, 'today', id);
    return plan;
  };
  return h('form', { class: 'card fp03-form', id: 'settings-today', novalidate: true, 'aria-labelledby': 'settings-today-title', onsubmit: submit },
    h('h3', { id: 'settings-today-title', text: tr('settings.s_today') }),
    h('p', { class: 'lead', text: tr('settings.l_today') }),
    h('p', { text: tr('settings.today_now', { date: f.date(tm.as_of) }) }),
    age_line,
    clock_line,
    h('div', { class: 'field' },
      h('label', { for: id, text: tr('settings.f_today') }), input,
      h('p', { id: id + '-hint', class: 'muted', text: tr('settings.h_today', { min: AS_OF_MIN, max: AS_OF_MAX }) }), err),
    h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn primary', disabled: ro, text: tr('settings.save') }), take),
    status);
}

/** Карточка «Все параметры и значения по умолчанию» (FP-17): возврат записывается тем же путём, что и сохранение формы (`commit` → `save_edits`). */
function defaults_card(ctx, model, flash) {
  const status = h('p', { class: 'muted fp03-status', role: 'status', text: '' });
  const on_reset = (key) => commit(ctx, status, [reset_edit(key)], 'defaults', 'settings-defaults-title');
  const card = defaults_section(ctx, model, { disabled: ro_of(ctx) !== null, flash: flash === 'defaults', on_reset });
  card.append(status);
  return card;
}

/**
 * «Валюта решения» (FP-29): выбор из валют счетов и введённых курсов, под выбором — какие курсы нужны и есть ли они; суммы буфера и порога волны не пересчитываются
 * (показаны текущие значения). Запись — правка `set_decision_currency` через общий путь `commit` → `save_edits`; отказ пересчёта (нет курса, резерв в другой валюте)
 * показан текстом у поля, данные прежние.
 */
function decision_section(ctx, model, flash) {
  const tr = ctx.tr;
  const env = env_of(ctx, model);
  const f = make_nf_fmt(env.lang, model.cur, model.as_of_iso, env.nf);
  const dm = decision_model(model);
  const ro = ro_of(ctx) !== null;
  const id = 'set-dcur';
  const sel = h('select', { id, disabled: ro, 'aria-describedby': id + '-hint ' + id + '-pairs ' + id + '-err' },
    dm.options.map((c) => h('option', { value: c, selected: c === dm.current, text: c })));
  const err = h('p', { id: id + '-err', class: 'error', role: 'alert' });
  const status = h('p', { class: 'muted fp03-status', role: 'status', text: flash === 'dcur' ? tr('settings.saved') : '' });
  const pairs = h('ul', { id: id + '-pairs', class: 'plain', 'aria-live': 'polite' });
  const pair_line = (p) => (p.rate === null
    ? tr('settings.dcur_pair_none', { from: p.from, to: p.to })
    : tr('settings.dcur_pair_ok', { from: p.from, to: p.to, rate: rate_text(p.rate.num, p.rate.den, env), date: rate_date_text(env.nf, p.rate.date) }));
  const draw_pairs = () => {
    const list = candidate_pairs(model.ws, sel.value ?? dm.current);
    pairs.replaceChildren(...(list.length === 0 ? [h('li', { class: 'muted', text: tr('settings.dcur_pairs_none') })] : list.map((p) => h('li', { class: p.rate === null ? 'banner tight' : null, text: pair_line(p) }))));
  };
  draw_pairs();
  sel.addEventListener('change', draw_pairs);
  const submit = (ev) => {
    if (ev !== undefined && ev !== null && typeof ev.preventDefault === 'function') ev.preventDefault();
    const plan = plan_decision_edit(model, sel.value);
    if (!plan.ok) {
      // резервы (налоговый конверт, накопления) заводятся в валюте решения: пока они в прежней валюте, расчёт в другой не строится
      err.textContent = plan.reason !== 'refused' ? tr('settings.e_dcur_bad')
        : plan.error?.ctx?.reason === 'reserve_not_in_decision_currency' ? tr('settings.e_dcur_reserve') : error_text(ctx, plan.error);
      sel.setAttribute('aria-invalid', 'true');
      status.textContent = tr('settings.fix_errors');
      return plan;
    }
    err.textContent = '';
    sel.setAttribute('aria-invalid', 'false');
    if (plan.edits.length === 0) { status.textContent = tr('settings.unchanged'); return plan; }
    commit(ctx, status, plan.edits, 'dcur', id);
    return plan;
  };
  const amounts = [
    dm.buffer_minor === null ? null : tr('settings.dcur_buffer', { value: f.money(dm.buffer_minor), cur: dm.current }),
    dm.threshold_minor === null ? null : tr('settings.dcur_threshold', { value: f.money(dm.threshold_minor), cur: dm.current }),
  ].filter((x) => x !== null);
  return h('form', { class: 'card fp03-form', id: 'settings-dcur', novalidate: true, 'aria-labelledby': 'settings-dcur-title', onsubmit: submit },
    h('h3', { id: 'settings-dcur-title', text: tr('settings.s_dcur') }),
    h('p', { class: 'lead', text: tr('settings.l_dcur') }),
    h('p', { text: tr('settings.dcur_now', { cur: dm.current }) }),
    h('div', { class: 'field' }, h('label', { for: id, text: tr('settings.f_dcur') }), sel,
      h('p', { id: id + '-hint', class: 'muted', text: tr('settings.h_dcur') }), pairs, err),
    h('p', { class: 'muted', text: tr('settings.dcur_units_note') }),
    ...amounts.map((t) => h('p', { class: 'muted', text: t })),
    h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn primary', disabled: ro, text: tr('settings.save') })),
    status);
}

function waves_section(ctx, model, flash) {
  const wv = wave_model(model);
  const count = (n) => (n === null ? '—' : String(n));
  const line = h('p', { class: 'muted', text: ctx.tr('settings.waves_found', { plan: count(wv.counts.plan), worse: count(wv.counts.worse) }) });
  return param_section(ctx, model, 'waves', flash, [line]).form;
}

function format_section(ctx, model, flash) {
  const tr = ctx.tr;
  const lang = ctx.lang();
  const nf = model.ws.number_format;
  const cur_preset = preset_of(nf);
  const cur_date = date_style_of(nf);
  const preset_ids = [...Object.keys(NUMBER_PRESETS), ...(cur_preset === 'custom' ? ['custom'] : [])];
  const ro = ro_of(ctx) !== null;
  const preset_sel = h('select', { id: 'set-nf-preset', disabled: ro },
    preset_ids.map((id) => h('option', { value: id, selected: id === cur_preset, text: tr('settings.nf_' + id) })));
  const date_sel = h('select', { id: 'set-nf-date', disabled: ro },
    DATE_STYLES.map((id) => h('option', { value: id, selected: id === cur_date, text: tr('settings.df_' + id) })));
  const preview_text = (value) => {
    const c = candidate_number_format(nf, preset_sel.value ?? cur_preset, date_sel.value ?? cur_date);
    return tr('settings.nf_preview', format_preview(lang, model.cur, model.as_of_iso, c.ok ? c.value : value));
  };
  const preview = h('p', { id: 'set-nf-preview', class: 'fp03-preview', 'aria-live': 'polite', text: tr('settings.nf_preview', format_preview(lang, model.cur, model.as_of_iso, nf)) });
  const refresh = () => { preview.textContent = preview_text(nf); };
  preset_sel.addEventListener('change', refresh);
  date_sel.addEventListener('change', refresh);
  const status = h('p', { class: 'muted fp03-status', role: 'status', text: flash === 'format' ? tr('settings.saved') : '' });
  const submit = (ev) => {
    if (ev !== undefined && ev !== null && typeof ev.preventDefault === 'function') ev.preventDefault();
    const plan = plan_format_edit(model, preset_sel.value, date_sel.value);
    if (!plan.ok) { status.textContent = tr('settings.fix_errors'); return plan; }
    if (plan.edits.length === 0) { status.textContent = tr('settings.unchanged'); return plan; }
    commit(ctx, status, plan.edits, 'format', 'set-nf-preset');
    return plan;
  };
  return h('form', { class: 'card fp03-form', id: 'settings-format', novalidate: true, 'aria-labelledby': 'settings-format-title', onsubmit: submit },
    h('h3', { id: 'settings-format-title', text: tr('settings.s_format') }),
    h('p', { class: 'lead', text: tr('settings.l_format') }),
    h('div', { class: 'field' }, h('label', { for: 'set-nf-preset', text: tr('settings.f_nf_preset') }), preset_sel),
    h('div', { class: 'field' }, h('label', { for: 'set-nf-date', text: tr('settings.f_nf_date') }), date_sel),
    preview,
    h('p', { class: 'muted', text: tr('settings.nf_note') }),
    h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn primary', disabled: ro, text: tr('settings.save') })),
    status);
}

/**
 * Экран «Настройки»: буфер, «сегодня» (дата расчёта), горизонт и «если хуже», волны, допуски сопоставления, формат чисел и дат; ниже — карточка готовности данных.
 * @param {object} ctx контекст расширений
 * @param {{clock?: () => string|null}} [opts] источник местной даты с часов (в тестах подставляется; по умолчанию часы компьютера)
 * @returns {HTMLElement}
 */
export function render_settings(ctx, opts = {}) {
  const clock = typeof opts?.clock === 'function' ? opts.clock : clock_today;
  const flash = pending?.section ?? null;
  const focus = pending?.focus ?? null;
  pending = null;
  const model = ctx.get_model();
  const root = h('div', { class: 'view settings' },
    h('h2', { id: 'view-title', tabindex: '-1', text: ctx.tr('settings.title') }),
    h('p', { class: 'lead', text: ctx.tr('settings.lead') }));
  if (model === null) {
    root.append(h('p', { class: 'muted', text: ctx.tr('settings.no_data') }));
    return root;
  }
  if (ro_of(ctx) !== null) root.append(h('p', { class: 'banner', role: 'status', text: ctx.tr('ro.settings') })); // файл новее известного формата: настройки не меняются (FP-17)
  root.append(
    buffer_section(ctx, model, flash),
    decision_section(ctx, model, flash),
    today_section(ctx, model, flash, clock),
    horizon_section(ctx, model, flash),
    waves_section(ctx, model, flash),
    param_section(ctx, model, 'match', flash).form,
    format_section(ctx, model, flash),
    defaults_card(ctx, model, flash),
    ...[calc_card(ctx)].filter((n) => n !== null), // FP-21: нет каталога строк пакета — карточки нет
    ready_card(ctx));
  if (focus !== null) { schedule_focus(focus); FOCUS.request(focus); }
  FOCUS.apply(); // поздние перерисовки от хранилища в окне запроса: фокус возвращается, только если он потерян
  return root;
}
