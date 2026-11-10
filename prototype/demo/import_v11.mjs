// import_v11.mjs — модель импорта v1.1 для мастера FP-06/FP-18 (FP-29, волна 3а-2): часы из CSV и строки в чужой валюте с двумя ногами.
// Чистый модуль (без DOM, часов и сети; проверяется в Node). Разбор, сухой прогон и откат живут в engine/hours_io.mjs и engine/io_fx_rows.mjs;
// здесь они сшиваются с рабочей областью и состоянием мастера. `import_model.mjs` обращается сюда короткими ветками (прежний разбор не менялся),
// а этот файл `import_model.mjs` не импортирует — циклов нет.
//
// Часы («профиль часов»). Сухой прогон `plan_hours` возвращает план того же вида, что и у фактов (`kind: 'hours'`, `report` с числами «распознано · отклонено ·
// дубликатов»); «Подтвердить» (`commit_hours`) записывает «отработано» периодов правками `set_stream_hours` общим путём и кладёт запись партии в поле рабочей области
// `hours_imports` (идентификатор партии → что изменено и что было прежде); «Откатить партию» (`rollback_hours`) возвращает прежние значения только там, где сейчас
// записано то, что внёс импорт: период, исправленный вами потом, не трогается. Запись партии живёт в данных, поэтому откат работает и после перезагрузки страницы.
//
// Строки обмена. `apply_fx_rows` дополняет основной разбор CSV: строки `currency_mismatch` с парой колонок второй ноги становятся обменом (кандидат с полем
// `exchange`); `commit_plan` пишет две ноги с общим `transfer_id` и выведенным курсом на проданной ноге, как форма обмена (FP-08).
// Расчёт по введённым данным и правилам, не консультация; текст из файла наружу уходит только как значение полей.

import {
  HOURS_PROFILE, HOURS_REJECT_REASONS, is_hours_profile, validate_hours_profile, dry_run_hours, hours_edits, rollback_edits,
} from '../engine/hours_io.mjs';
import {
  FX_ROWS_PROFILE, FX_REJECT_REASONS, has_fx_block, split_fx_profile, validate_fx_config, merge_fx_rows,
} from '../engine/io_fx_rows.mjs';
import { validate_profile, MAX_IMPORT_BYTES } from '../engine/io.mjs';
import { sha256 } from '../engine/index.mjs';
import { apply_edit, decision_currency_of } from './ws_edit.mjs';
import { is_valid_id } from './ids.mjs';

export { is_hours_profile, has_fx_block };

const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const list = (ws, key) => (Array.isArray(ws?.[key]) ? ws[key] : []);
const clone = (x) => JSON.parse(JSON.stringify(x));
const clip = (s, n) => String(s).slice(0, n);

/** Профили v1.1, которые мастер предлагает рядом со встроенными (данные, как в `data/profiles/<id>.json`; тест сверки). */
export const V11_PROFILES = Object.freeze({ 'hours-csv-1': HOURS_PROFILE, 'fx-rows-csv-1': FX_ROWS_PROFILE });

/** Все причины отклонения строк v1.1; для каждой есть строка `importv11.rj_<причина>`. */
export const V11_REJECT_REASONS = Object.freeze([...HOURS_REJECT_REASONS, ...FX_REJECT_REASONS]);

/** Сколько партий часов хранится в рабочей области (старые вытесняются: откат им уже недоступен). */
export const MAX_HOURS_BATCHES = 20;

/** Идентификатор — профиль v1.1 (собственное свойство, а не ключ из прототипа). */
export function is_v11_profile_id(id) {
  return typeof id === 'string' && Object.hasOwn(V11_PROFILES, id);
}

/** Отказ: код канона и контекст `{reason, …}` (как `refuse` мастера). */
function refuse(reason, extra, code = 'E_SCHEMA') {
  return { ok: false, error: { code, ctx: { reason, ...extra } } };
}

/** Исключение движка → `{code, ctx}` без значений из файла (как `err_of` мастера). */
function err_of(e) {
  const code = typeof e?.code === 'string' ? e.code : 'E_SCHEMA';
  const c = is_obj(e?.ctx) ? e.ctx : {};
  const ctx = { reason: typeof c.reason === 'string' ? c.reason : 'other' };
  for (const k of ['line', 'row', 'limit', 'col', 'where']) if (typeof c[k] === 'number' || (k !== 'line' && typeof c[k] === 'string' && c[k].length <= 40)) ctx[k] = c[k];
  if (typeof c.pair === 'string' && /^[A-Z][A-Z0-9]{1,9}\/[A-Z][A-Z0-9]{1,9}$/.test(c.pair)) ctx.pair = c.pair;
  if (Array.isArray(c.errors)) ctx.errors = c.errors.slice(0, 10).map((x) => ({ field: clip(x?.field ?? '', 40), reason: clip(x?.reason ?? '', 40) }));
  return { code, ctx };
}

// ── профили и подсказка по заголовку ──────────────────────────────────────────────────────────────────────────────────

/**
 * Профиль v1.1, который подходит файлу по заголовку (обязательные колонки профиля есть; разделитель файла берётся из файла, как у профиля Runway), иначе `null`.
 * Строки обмена проверяются первыми: их набор колонок уже и ни с чем не спутывается.
 * @param {{header: string[]}} sniff
 * @returns {string|null}
 */
export function recommend_v11_profile(sniff) {
  const h = sniff.header;
  const fx = FX_ROWS_PROFILE;
  const fx_need = [fx.date.col, fx.amount.col, fx.currency.col, ...fx.desc.cols, fx.fx.counter_amount.col, fx.fx.counter_currency.col];
  if (fx_need.every((n) => h.includes(n))) return 'fx-rows-csv-1';
  const hp = HOURS_PROFILE;
  if ([hp.date.col, hp.hours.col].every((n) => h.includes(n)) && !h.includes('amount_minor')) return 'hours-csv-1';
  return null;
}

/**
 * Профиль v1.1 для разбора: копия данных; разделитель берётся из файла (файл, пересохранённый в таблице, получает другой). Строки обмена отдают обычный
 * профиль CSV и блок `fx` отдельно.
 * @param {string} id
 * @param {{delimiter: string}|null} sniff
 * @returns {{profile: object, fx: object|null}}
 */
export function v11_profile(id, sniff) {
  const p = clone(V11_PROFILES[id]);
  if (sniff !== null && sniff !== undefined && typeof sniff.delimiter === 'string') p.delimiter = sniff.delimiter;
  const { base, fx } = split_fx_profile(p);
  return { profile: base, fx };
}

/**
 * Профиль из файла пользователя (уже разобранный JSON): профиль «часы» и профиль строк обмена с блоком `fx` проверяются здесь, остальное — движком.
 * @param {object} obj
 * @returns {{ok: true, profile: object}|{ok: false, error: object}|null} `null` — профиль не v1.1, проверять обычным `validate_profile`
 */
export function read_v11_profile_obj(obj) {
  if (is_hours_profile(obj)) {
    const v = validate_hours_profile(obj);
    if (!v.ok) return refuse('bad_profile', { errors: v.errors.slice(0, 10).map((x) => ({ field: clip(x.field, 40), reason: clip(x.reason, 40) })) });
    return { ok: true, profile: clone(obj) };
  }
  if (has_fx_block(obj)) {
    const { base, fx } = split_fx_profile(obj);
    const v = validate_profile(base);
    const f = validate_fx_config(fx);
    const errors = [...v.errors, ...f.errors];
    if (errors.length > 0) return refuse('bad_profile', { errors: errors.slice(0, 10).map((x) => ({ field: clip(x.field, 40), reason: clip(x.reason, 40) })) });
    return { ok: true, profile: clone(obj) };
  }
  return null;
}

// ── состояние мастера ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Настройки v1.1, которые принимает `wiz_csv_set` (ключи патча). */
export const V11_KEYS = Object.freeze(['hours_stream_id', 'fx_on', 'fx_amount_col', 'fx_currency_col', 'fx_amount_unit', 'counter_account_id']);

/** Поля состояния v1.1 внутри `w.csv.v11` и значения, которые они принимают. */
export function new_v11_state() {
  return { hours_stream_id: null, fx_on: false, fx_amount_col: -1, fx_currency_col: -1, fx_amount_unit: 'major', counter_account_id: null };
}

/**
 * Применить одну настройку v1.1 из `wiz_csv_set`. Значения проверяются; неизвестное не принимается.
 * @returns {boolean} ключ относится к v1.1 (принят или отвергнут — решает проверка), чтобы вызывающий не искал его в других полях
 */
export function v11_patch(v11, ws, key, value) {
  switch (key) {
    case 'hours_stream_id':
      if (value === null || (typeof value === 'string' && list(ws, 'streams').some((s) => s?.stream_id === value))) v11.hours_stream_id = value;
      return true;
    case 'fx_on':
      if (typeof value === 'boolean') v11.fx_on = value;
      return true;
    case 'fx_amount_col': case 'fx_currency_col':
      if (Number.isInteger(value) && value >= -1 && value < 10000) v11[key] = value;
      return true;
    case 'fx_amount_unit':
      if (value === 'major' || value === 'minor') v11.fx_amount_unit = value;
      return true;
    case 'counter_account_id':
      if (value === null || (typeof value === 'string' && list(ws, 'accounts').some((a) => a?.account_id === value))) v11.counter_account_id = value;
      return true;
    default: return false;
  }
}

/** Блок `fx` из сопоставления колонок «своего» профиля; колонка — по имени из заголовка, если оно непустое и единственное, иначе по номеру. */
export function custom_fx_block(v11, mapping, header) {
  const ok = (i) => Number.isInteger(i) && i >= 0 && i < header.length;
  if (!ok(v11.fx_amount_col) || !ok(v11.fx_currency_col)) return refuse('bad_mapping', { field: ok(v11.fx_amount_col) ? 'fx_currency_col' : 'fx_amount_col' });
  const ref = (i) => (header[i] !== '' && header.indexOf(header[i]) === header.lastIndexOf(header[i]) ? header[i] : i);
  const amount = { col: ref(v11.fx_amount_col) };
  if (v11.fx_amount_unit === 'minor') amount.unit = 'minor';
  else {
    amount.decimal = mapping.decimal;
    if (mapping.thousands !== '') amount.thousands = mapping.thousands;
  }
  const fx = { counter_amount: amount, counter_currency: { col: ref(v11.fx_currency_col) } };
  const v = validate_fx_config(fx);
  if (!v.ok) return refuse('bad_mapping', { field: 'fx' });
  return { ok: true, fx };
}

/**
 * Дополнение входа сухого прогона для профилей v1.1: поток часов или блок обмена. Вызывается из `csv_run_input` мастера.
 * @param {object} v11 состояние `w.csv.v11`
 * @param {object} ws
 * @param {{fx?: object|null}} resolved результат `wiz_csv_profile`
 * @param {{profile_choice: string, mapping: object|null, sniff: object|null}} st
 * @returns {{ok: true, extra: object}|{ok: false, error: object}}
 */
export function v11_run_extra(v11, ws, resolved, st) {
  if (is_hours_profile(resolved.profile)) {
    const streams = list(ws, 'streams').filter(is_obj);
    const stream_id = v11.hours_stream_id ?? (streams.length === 1 ? streams[0].stream_id : null);
    return { ok: true, extra: { hours_stream_id: stream_id } };
  }
  const counter = v11.counter_account_id;
  if (resolved.fx !== null && resolved.fx !== undefined) return { ok: true, extra: { fx: { config: resolved.fx, counter_account_id: counter } } };
  if (st.profile_choice === 'custom' && v11.fx_on === true && st.sniff !== null && st.mapping !== null) {
    const b = custom_fx_block(v11, st.mapping, st.sniff.header);
    if (!b.ok) return b;
    return { ok: true, extra: { fx: { config: b.fx, counter_account_id: counter } } };
  }
  return { ok: true, extra: {} };
}

// ── строки обмена: дополнение основного разбора ────────────────────────────────────────────────────────────────────────

/**
 * Дополнить результат основного разбора CSV обменами (`input.fx = {config, counter_account_id}`). Без `input.fx` результат возвращается как есть.
 * @param {object} ws
 * @param {{text: string, profile: object, fx?: {config: object, counter_account_id: string|null}|null}} input
 * @param {{account_id: string, account_currency: string, as_of: string}} ctx контекст основного разбора
 * @param {{candidates: object[], rejects: object[], rows_total: number}} parsed
 * @returns {{ok: true, parsed: object, fx: object|null}|{ok: false, error: object}}
 */
export function apply_fx_rows(ws, input, ctx, parsed) {
  if (!is_obj(input.fx) || !is_obj(input.fx.config)) return { ok: true, parsed, fx: null };
  try {
    const merged = merge_fx_rows(parsed, input.profile, input.fx.config, input.text, {
      account_id: ctx.account_id, account_currency: ctx.account_currency, as_of: ctx.as_of,
      accounts: list(ws, 'accounts').filter(is_obj), rates: list(ws, 'rates').filter(is_obj), decision_currency: decision_currency_of(ws),
      counter_account_id: input.fx.counter_account_id ?? null, rounding: ws.params?.rounding ?? 'half_even',
    });
    const { fx, ...rest } = merged;
    return { ok: true, parsed: rest, fx };
  } catch (e) { return { ok: false, error: err_of(e) }; }
}

/** Обмены плана: кандидаты с полем `exchange`, по порядку строк файла. */
export function plan_exchanges(plan) {
  return (plan?.dry?.recognized_items ?? []).filter((c) => is_obj(c.exchange));
}

// ── часы: сухой прогон, запись партии, откат ──────────────────────────────────────────────────────────────────────────

/**
 * Сухой прогон файла с часами. Рабочая область не меняется. План того же вида, что у `plan_csv` (`kind: 'hours'`).
 * @param {object} ws
 * @param {{text: string, bytes?: Uint8Array|string, name?: string, profile: object, hours_stream_id?: string|null}} input
 * @returns {{ok: true, plan: object}|{ok: false, error: object}}
 */
export function plan_hours(ws, input) {
  if (!is_obj(ws) || typeof ws.as_of !== 'string') return refuse('no_workspace');
  if (typeof input.text !== 'string') return refuse('text_not_string');
  const bytes = input.bytes ?? input.text;
  const size = typeof bytes === 'string' ? new TextEncoder().encode(bytes).length : bytes.length;
  if (!Number.isFinite(size) || size > MAX_IMPORT_BYTES) return refuse('file_too_large', { limit: MAX_IMPORT_BYTES });
  const streams = list(ws, 'streams').filter(is_obj);
  let dry;
  try { dry = dry_run_hours(input.text, input.profile, { streams, stream_id: input.hours_stream_id ?? null, as_of: ws.as_of }); } catch (e) { return { ok: false, error: err_of(e) }; }
  const warnings = dry.rounded_rows > 0 ? [{ code: 'hours_rounded', n: dry.rounded_rows }] : [];
  const report = {
    rows_total: dry.rows_total, recognized: dry.recognized, rejected: dry.rejected, duplicates: dry.duplicates, doubles: 0, sum_ok: dry.sum_ok,
    by_reason: dry.by_reason, reject_rows: dry.reject_rows, net_minor: 0, covered_by_anchor: 0, from: dry.from, to: dry.to, overlap_days: 0, gap_days: 0, warnings,
  };
  const plan = {
    kind: 'hours', base_ws: ws, account_id: null, currency: null, profile_id: input.profile.profile_id ?? 'custom',
    source: { name: clip(input.name ?? '', 120), size, bytes, hash: sha256(bytes) },
    candidates: [],
    dry: { recognized: dry.recognized, rejected: dry.rejected, duplicates: dry.duplicates, rows_total: dry.rows_total, doubles: [], from: null, to: null, overlap_days: 0, gap_days: 0, recognized_items: [], duplicate_items: [] },
    report, pairs: new Map(), extras: null, unsupported: [], parse: { via: 'main', reason: null },
    hours: {
      changes: dry.changes, unchanged: dry.unchanged, replaced: dry.replaced, rounded_rows: dry.rounded_rows, stream_id: input.hours_stream_id ?? null,
      no_streams: streams.length === 0, header: dry.header,
    },
  };
  return { ok: true, plan };
}

/**
 * Запись партии часов: правки `set_stream_hours` по порядку (все или ни одной), запись партии в `hours_imports`. Рабочая область не мутируется.
 * @param {object} ws
 * @param {object} plan результат `plan_hours`
 * @param {{new_id: (prefix: string) => string}} env
 * @returns {{ok: true, ws: object, batch: object, events: []}|{ok: false, error: object}}
 */
export function commit_hours(ws, plan, env) {
  if (!is_obj(ws) || typeof ws.as_of !== 'string') return refuse('no_workspace');
  if (plan.base_ws !== ws) return refuse('stale_plan');
  const changes = plan.hours.changes;
  if (changes.length === 0) return refuse('nothing_to_import');
  const batch_id = env.new_id('imp');
  let cur = ws;
  for (const e of hours_edits(changes)) {
    const r = apply_edit(cur, e, { new_id: env.new_id });
    if (!r.ok) return { ok: false, error: { code: r.error.code, ctx: { reason: 'validation_failed', field: clip(r.error.ctx?.field ?? '', 40), detail: clip(r.error.ctx?.reason ?? '', 40) } } };
    cur = r.ws;
  }
  const prev = is_obj(ws.hours_imports) ? ws.hours_imports : {};
  const kept = Object.keys(prev).slice(-(MAX_HOURS_BATCHES - 1));
  const imports = Object.fromEntries(kept.map((k) => [k, prev[k]]));
  imports[batch_id] = { at: ws.as_of, source_hash: plan.source.hash, changes: changes.map((c) => ({ stream_id: c.stream_id, period_start: c.period_start, before: c.before, after: c.after })) };
  const batch = { batch_id, facts: changes.length, what: 'hours', profile_id: plan.profile_id, source_hash: plan.source.hash, accounts: [], anchors: [], rates: [] };
  return { ok: true, ws: { ...cur, hours_imports: imports }, batch, events: [] };
}

/** Партии часов рабочей области: `[{batch_id, count, from, to, at}]` в порядке записи. */
export function list_hours_batches(ws) {
  const imports = is_obj(ws?.hours_imports) ? ws.hours_imports : {};
  return Object.keys(imports).map((id) => {
    const rec = imports[id];
    const cs = Array.isArray(rec?.changes) ? rec.changes : [];
    const starts = cs.map((c) => c.period_start).filter((s) => typeof s === 'string').sort();
    return { batch_id: id, count: cs.length, from: starts[0] ?? null, to: starts[starts.length - 1] ?? null, at: typeof rec?.at === 'string' ? rec.at : null };
  });
}

/** Партия `batch_id` — партия часов этой рабочей области. */
export function is_hours_batch(ws, batch_id) {
  return typeof batch_id === 'string' && is_obj(ws?.hours_imports) && Object.hasOwn(ws.hours_imports, batch_id);
}

/**
 * Откат партии часов: прежние значения возвращаются там, где сейчас записано внесённое импортом; изменённое потом вручную остаётся (`kept`).
 * Рабочая область не мутируется; пустое поле `hours_imports` убирается.
 * @returns {{ok: true, ws: object, removed: {facts: number, accounts: number, anchors: number, rates: number, hours: number, kept: number, gone: number}}|{ok: false, error: object}}
 */
export function rollback_hours(ws, batch_id) {
  if (!is_obj(ws)) return refuse('no_workspace');
  if (!is_valid_id(batch_id) || !is_hours_batch(ws, batch_id)) return refuse('unknown_batch');
  const rec = ws.hours_imports[batch_id];
  const rb = rollback_edits(Array.isArray(rec.changes) ? rec.changes : [], list(ws, 'streams'));
  let cur = ws;
  for (const e of rb.edits) {
    const r = apply_edit(cur, e, {});
    if (!r.ok) return { ok: false, error: { code: r.error.code, ctx: { reason: 'validation_failed', field: clip(r.error.ctx?.field ?? '', 40), detail: clip(r.error.ctx?.reason ?? '', 40) } } };
    cur = r.ws;
  }
  const rest = Object.fromEntries(Object.keys(ws.hours_imports).filter((k) => k !== batch_id).map((k) => [k, ws.hours_imports[k]]));
  const after = { ...cur };
  if (Object.keys(rest).length === 0) delete after.hours_imports; else after.hours_imports = rest;
  return { ok: true, ws: after, removed: { facts: 0, accounts: 0, anchors: 0, rates: 0, hours: rb.edits.length, kept: rb.kept, gone: rb.gone } };
}

/** Число записываемых строк плана v1.1 для кнопки «Подтвердить»: периоды часов (факты считает основной код). */
export function hours_importable(plan) {
  return plan?.kind === 'hours' ? plan.hours.changes.length : 0;
}
