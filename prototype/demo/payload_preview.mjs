// payload_preview.mjs — «что ушло бы в облачный режим» (предпросмотр, отправки нет), показ недоверенного текста по кнопке и чип происхождения чисел (FP-09).
// REQ-131: поля `note`, `tag`, `description`, `memo` — недоверенный текст; в результат инструмента и в контекст модели он не попадает, причины идут
// идентификаторами и классами (`txt#17`). Показ — только по кнопке, до 80 знаков, с меткой `untrusted`, только через textContent.
// REQ-132: чип «числа из расчёта c_…» раскрывает режим, версию движка, дату узкой точки и сокращённый `inputs_hash`; пометка «ответ ИИ» — только
// для режимов с LLM (в A0 её нет).
// Модуль не обращается к сети и не отправляет ничего: предпросмотр — это результат инструмента движка, показанный текстом.
// Чистые модели (без DOM) — в первой половине файла; DOM-часть — тонкая. Расчёт по введённым данным и правилам, не консультация.

import { narrowest_point, format_date } from '../engine/index.mjs';
import { run_tool, call_id, call_ref, normalize_args } from '../engine/tools.mjs';
import { LABELS } from '../engine/verifier.mjs';
import { h } from './dom.mjs';

/** Инструменты движка, результат которых показывает предпросмотр (все — только чтение, уровень T0). */
export const PREVIEW_TOOLS = Object.freeze(['explain_min_point', 'max_purchase_amount', 'list_waves', 'get_projection']);

/** Разделы рабочей области и поля в них, где лежит текст, которого пользователь мог не писать. */
export const UNTRUSTED_SECTIONS = Object.freeze(['facts', 'plans', 'rules', 'streams', 'purchases']);
export const UNTRUSTED_FIELDS = Object.freeze(['note', 'tag', 'description', 'memo']);

/** Наибольшая длина показываемого недоверенного текста (знаков, считая «…»). */
export const UNTRUSTED_MAX = 80;

/** Сколько записей недоверенного текста перечисляет предпросмотр (остальные — только счётчиком). */
export const UNTRUSTED_LIST_MAX = 200;

const HASH_SHORT = 8;

// ── чип происхождения чисел (REQ-132) ────────────────────────────────────────────────────────────────────────────────

/**
 * Аргументы вызова инструмента для ссылки `c_…`: те же, что строит приложение (нормализованные, без значений по умолчанию).
 * @param {object} a контекст расчёта (`model.ctx`)
 * @param {'plan'|'worse'} mode
 * @returns {{tool: string, args: object}}
 */
export function origin_call(a, mode) {
  return { tool: 'explain_min_point', args: normalize_args({ mode }) };
}

/**
 * Модель чипа: режим, версия движка, дата узкой точки (по `trough` режима), сокращённый `inputs_hash` и ссылка `c_…`.
 * @param {object} a `model.ctx`
 * @param {'plan'|'worse'} mode
 * @param {{tool?: string, args?: object, ai?: boolean, rows?: {label: string, value: string}[]}} [o] другой вызов (например, check_purchase) и признак «ответ ИИ»
 * @returns {{mode: string, engine_version: string, narrow: {date: string, amount_minor: number}|null, hash_short: string, ref: string, ai: boolean, rows: object[]}}
 */
export function origin_model(a, mode, o = {}) {
  const call = o.tool !== undefined ? { tool: o.tool, args: o.args ?? {} } : origin_call(a, mode);
  const np = narrowest_point(a.series[mode], a.as_of, a.horizon_end);
  return {
    mode,
    engine_version: a.engine_version,
    narrow: np === null || np === undefined ? null : { date: format_date(np.date), amount_minor: np.amount_minor },
    hash_short: a.inputs_hash.slice(0, HASH_SHORT),
    ref: call_ref(call_id(call.tool, call.args, a.inputs_hash)),
    ai: o.ai === true,
    rows: o.rows ?? [],
  };
}

/**
 * Чип происхождения: сводка «числа из расчёта c_…» и раскрывающийся блок с режимом, версией движка, датой узкой точки и коротким хэшем.
 * @param {object} ctx контекст расширений
 * @param {object} om модель из `origin_model`
 * @returns {HTMLElement}
 */
export function render_origin_chip(ctx, om) {
  const tr = ctx.tr;
  const f = ctx.fmt();
  const lang = ctx.lang();
  const mode_name = LABELS.modes[lang][om.mode];
  const dl = [
    [tr('showcase.chip_mode'), mode_name],
    [tr('showcase.chip_engine'), om.engine_version],
    [tr('showcase.chip_narrow'), om.narrow === null ? tr('showcase.chip_none') : f.date(om.narrow.date) + ' · ' + f.money(om.narrow.amount_minor)],
    [tr('showcase.chip_hash'), om.hash_short],
    ...om.rows.map((r) => [r.label, r.value]),
  ];
  return h('details', { class: 'sc-chip', 'data-ref': om.ref },
    h('summary', null, tr('showcase.chip_summary', { ref: om.ref }), om.ai ? h('span', { class: 'sc-ai', text: ' · ' + tr('showcase.chip_ai') }) : null),
    h('dl', { class: 'sc-dl' }, dl.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])),
    h('p', { class: 'muted', text: tr('showcase.chip_note') }));
}

// ── недоверенный текст (REQ-131) ─────────────────────────────────────────────────────────────────────────────────────

/** Управляющие знаки и знаки смены направления письма: в показ не попадают. */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

/**
 * Привести недоверенный текст к показу: без управляющих знаков и без переносов, не длиннее `UNTRUSTED_MAX` знаков (по кодовым точкам), с «…» при обрезке.
 * @param {any} text
 * @returns {{text: string, truncated: boolean}}
 */
export function clip_untrusted(text) {
  const s = (typeof text === 'string' ? text : String(text ?? '')).replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  const cps = Array.from(s);
  if (cps.length <= UNTRUSTED_MAX) return { text: s, truncated: false };
  return { text: cps.slice(0, UNTRUSTED_MAX - 1).join('') + '…', truncated: true };
}

function untrusted_entries(ws) {
  const out = [];
  for (const section of UNTRUSTED_SECTIONS) {
    const list = Array.isArray(ws?.[section]) ? ws[section] : [];
    list.forEach((rec, i) => {
      if (rec === null || typeof rec !== 'object') return;
      for (const field of UNTRUSTED_FIELDS) {
        const v = Object.hasOwn(rec, field) ? rec[field] : undefined;
        if (typeof v !== 'string' || v.trim() === '') continue;
        const entity_id = typeof rec.event_id === 'string' ? rec.event_id : (typeof rec[section.slice(0, -1) + '_id'] === 'string' ? rec[section.slice(0, -1) + '_id'] : section + '#' + (i + 1));
        out.push({ section, field, entity_id: String(entity_id).slice(0, 80), value: v });
      }
    });
  }
  return out;
}

/**
 * Перечень недоверенных полей рабочей области БЕЗ их текста: идентификатор `txt#N`, раздел, поле, идентификатор записи.
 * @param {object} ws
 * @returns {{total: number, by_field: Object<string, number>, items: {id: string, section: string, field: string, entity_id: string}[], more: number}}
 */
export function list_untrusted(ws) {
  const all = untrusted_entries(ws);
  const by_field = {};
  for (const f of UNTRUSTED_FIELDS) by_field[f] = 0;
  for (const e of all) by_field[e.field] += 1;
  const items = all.slice(0, UNTRUSTED_LIST_MAX).map((e, i) => ({ id: 'txt#' + (i + 1), section: e.section, field: e.field, entity_id: e.entity_id }));
  return { total: all.length, by_field, items, more: Math.max(0, all.length - items.length) };
}

/**
 * Показать текст одной записи (по кнопке): не длиннее 80 знаков, с меткой `untrusted`.
 * @param {object} ws
 * @param {string} id вида `txt#17`
 * @returns {{ok: true, label: 'untrusted', text: string, truncated: boolean}|{ok: false}}
 */
export function reveal_untrusted(ws, id) {
  const m = /^txt#([1-9]\d{0,5})$/.exec(String(id));
  if (m === null) return { ok: false };
  const all = untrusted_entries(ws);
  const e = all[Number(m[1]) - 1];
  if (e === undefined || Number(m[1]) > UNTRUSTED_LIST_MAX) return { ok: false };
  const c = clip_untrusted(e.value);
  return { ok: true, label: 'untrusted', text: c.text, truncated: c.truncated };
}

// ── предпросмотр результата инструмента ──────────────────────────────────────────────────────────────────────────────

/** Аргументы инструмента для предпросмотра (даты — ISO; режим — выбранный на странице). */
export function preview_args(a, tool, mode) {
  const from = format_date(a.as_of);
  const to = format_date(a.horizon_end);
  switch (tool) {
    case 'explain_min_point': return { mode };
    case 'max_purchase_amount': return { date: from, mode };
    case 'list_waves': return { from, to, mode };
    default: return { to, mode };
  }
}

/** Идентификаторы сущностей рабочей области (значения полей `…_id` и `id`): они называют записи и вправе быть в результате инструмента. */
export function entity_ids(ws) {
  const ids = new Set();
  const walk = (x, depth) => {
    if (depth > 4 || x === null || typeof x !== 'object') return;
    if (Array.isArray(x)) { for (const y of x) walk(y, depth + 1); return; }
    for (const [k, v] of Object.entries(x)) {
      if (typeof v === 'string' && (k === 'id' || k.endsWith('_id'))) ids.add(v);
      else walk(v, depth + 1);
    }
  };
  walk(ws, 0);
  return ids;
}

/**
 * Результат инструмента, который увидел бы облачный режим, и проверка утечки: ни один недоверенный текст рабочей области не входит в него подстрокой.
 * Ничего не отправляется: это текст результата, показанный на странице.
 * @param {{ws: object, ctx: object}} model
 * @param {'plan'|'worse'} mode
 * @param {string} [tool]
 * @returns {{ok: true, tool: string, args: object, ref: string, text: string, bytes: number, leaks: string[], checked: number}|{ok: false, code: string}}
 */
export function build_payload(model, mode, tool = 'explain_min_point') {
  if (!PREVIEW_TOOLS.includes(tool)) return { ok: false, code: 'E_UNKNOWN_TOOL' };
  const a = model.ctx;
  const args = preview_args(a, tool, mode);
  a.calls_used = 0; // как в приложении: предпросмотр не должен расходовать предел вызовов вопроса
  const r = run_tool(tool, args, a);
  if (r.isError === true) return { ok: false, code: String(r.code) };
  const text = JSON.stringify(r, null, 2);
  const entries = untrusted_entries(model.ws);
  const ids = entity_ids(model.ws);
  const seen = new Set();
  const leaks = [];
  for (const e of entries) {
    const needle = e.value.trim();
    if (needle.length < 2 || seen.has(needle) || ids.has(needle)) continue; // метка, совпавшая с идентификатором записи, — идентификатор, а не текст
    seen.add(needle);
    if (text.includes(needle)) leaks.push('txt#' + (entries.indexOf(e) + 1));
  }
  return { ok: true, tool, args, ref: call_ref(r.call_id), text, bytes: utf8_length(text), leaks, checked: seen.size };
}

/** Длина текста в байтах UTF-8 (без TextEncoder: модуль грузится и в Node, и в браузере одинаково). */
export function utf8_length(s) {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

// ── DOM ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const view_state = { tool: 'explain_min_point', open: new Set(), reveal: new Map() };

function untrusted_block(ctx, model) {
  const tr = ctx.tr;
  const u = list_untrusted(model.ws);
  if (u.total === 0) return h('p', { class: 'muted', text: tr('showcase.pl_untrusted_none') });
  const summary = UNTRUSTED_FIELDS.filter((f) => u.by_field[f] > 0).map((f) => f + ': ' + u.by_field[f]).join(', ');
  const rows = u.items.map((it) => {
    const shown = view_state.reveal.get(it.id);
    const cell = h('td', { class: 'sc-untrusted' });
    const paint = () => {
      const r = view_state.reveal.get(it.id);
      if (r === undefined) { cell.replaceChildren(h('em', { class: 'muted', text: tr('showcase.pl_hidden') })); return; }
      cell.replaceChildren(h('span', { class: 'sc-badge', text: tr('showcase.pl_label') }), ' ', h('span', { class: 'sc-quote', text: r }));
    };
    const btn = h('button', { type: 'button', class: 'btn', 'aria-pressed': String(shown !== undefined), text: shown === undefined ? tr('showcase.pl_show') : tr('showcase.pl_hide') });
    btn.addEventListener('click', () => {
      if (view_state.reveal.has(it.id)) view_state.reveal.delete(it.id);
      else { const r = reveal_untrusted(ctx.get_ws(), it.id); if (r.ok) view_state.reveal.set(it.id, r.text); }
      btn.textContent = view_state.reveal.has(it.id) ? tr('showcase.pl_hide') : tr('showcase.pl_show');
      btn.setAttribute('aria-pressed', String(view_state.reveal.has(it.id)));
      paint();
    });
    paint();
    return h('tr', null, h('th', { scope: 'row', text: it.id }), h('td', { text: it.section + ' · ' + it.entity_id + ' · ' + it.field }), cell, h('td', null, btn));
  });
  return h('div', null,
    h('p', { text: tr('showcase.pl_untrusted_head', { n: u.total, parts: summary, max: UNTRUSTED_MAX }) }),
    h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('caption', { class: 'sr-only', text: tr('showcase.pl_untrusted_caption') }),
      h('thead', null, h('tr', null, ['showcase.pl_col_id', 'showcase.pl_col_where', 'showcase.pl_col_text', 'showcase.pl_col_act'].map((k) => h('th', { scope: 'col', text: tr(k) })))),
      h('tbody', null, rows))),
    u.more > 0 ? h('p', { class: 'muted', text: tr('showcase.pl_more', { n: u.more }) }) : null);
}

/**
 * Экран «Облако: предпросмотр»: результат инструмента (то, что ушло бы модели), проверка «недоверенного текста нет», размер, перечень полей с кнопкой показа.
 * @param {object} ctx
 * @returns {HTMLElement}
 */
export function render_payload(ctx) {
  const tr = ctx.tr;
  const model = ctx.get_model();
  const title = h('h2', { id: 'view-title', tabindex: '-1', text: tr('showcase.pl_title') });
  if (model === null) return h('div', { class: 'view sc-view' }, title, h('p', { text: tr('showcase.no_data') }));
  const mode = ctx.mode();
  const out = h('div', { 'aria-live': 'polite' });
  const select = h('select', { id: 'sc-pl-tool', 'aria-label': tr('showcase.pl_tool') },
    PREVIEW_TOOLS.map((t) => h('option', { value: t, selected: view_state.tool === t, text: t })));
  const update = () => {
    const p = build_payload(model, mode, view_state.tool);
    if (!p.ok) { out.replaceChildren(h('p', { class: 'banner short', role: 'alert', text: tr('showcase.pl_failed', { code: p.code }) })); return; }
    out.replaceChildren(
      h('p', { class: p.leaks.length === 0 ? 'pos' : 'bad', role: 'status', text: p.leaks.length === 0 ? tr('showcase.pl_clean', { n: p.checked }) : tr('showcase.pl_leak', { ids: p.leaks.join(', ') }) }),
      h('p', { class: 'muted', text: tr('showcase.pl_size', { bytes: p.bytes, ref: p.ref }) }),
      h('pre', { class: 'sc-pre', tabindex: '0', 'aria-label': tr('showcase.pl_pre_label'), text: p.text }));
  };
  select.addEventListener('change', (ev) => { view_state.tool = ev.target.value; update(); });
  update();
  return h('div', { class: 'view sc-view' }, title,
    h('p', { class: 'lead', text: tr('showcase.pl_lead') }),
    h('p', { class: 'banner', role: 'note', text: tr('showcase.pl_no_send') }),
    h('div', { class: 'field' }, h('label', { for: 'sc-pl-tool', text: tr('showcase.pl_tool') }), select),
    out,
    h('section', { class: 'card' }, h('h3', { text: tr('showcase.pl_untrusted_title') }), h('p', { class: 'muted', text: tr('showcase.pl_untrusted_lead') }), untrusted_block(ctx, model)),
    h('p', { class: 'muted', text: tr('showcase.tax_note') }));
}

/**
 * Чип происхождения для слота ассистента: числа ответа берутся из расчёта выбранного режима.
 * @param {object} ctx
 * @returns {HTMLElement|null}
 */
export function render_assistant_chip(ctx) {
  const model = ctx.get_model();
  if (model === null) return null;
  return h('section', { class: 'card sc-card', 'aria-label': ctx.tr('showcase.chip_card') }, render_origin_chip(ctx, origin_model(model.ctx, ctx.mode())));
}
