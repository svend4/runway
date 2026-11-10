// store_mode.mjs — режим «в магазине» (REQ-052, IDEA-58, ALG-04): одно поле суммы → вердикт на сегодня и число «можно потратить сегодня» (S_max на as_of).
// Числа те же, что у экрана «Покупка» (`check_purchase` и `max_amount` движка на дате расчёта): другой формулы нет. Замер времени от ввода до ответа
// печатается на экране; цель «не более 1 с на эталонном устройстве» остаётся целью до замера на нём (в этом демо — замер на устройстве читателя).
// Чистая модель (`store_model`, `timed_store`) — без DOM и часов: часы приходят аргументом. DOM-часть — `render_store`.
// Здесь же общие мелочи показа для витрин FP-09: значок вердикта и текст ошибки движка. Расчёт по введённым данным и правилам, не консультация.

import { check_purchase, max_amount, gate, format_date, currency_exponent } from '../engine/index.mjs';
import { call_id, call_ref, normalize_args } from '../engine/tools.mjs';
import { LABELS } from '../engine/verifier.mjs';
import { h } from './dom.mjs';
import { oldest_review_date } from './rule_age.mjs';
import { parse_amount_text, format_input_amount, resolve_number_format } from './number_format.mjs';
import { origin_model, render_origin_chip } from './payload_preview.mjs';
import { make_env, rate_uses, answer_note_text, note_node } from './rate_chip.mjs';

/** Режимы расчёта v1. */
export const MODES = Object.freeze(['plan', 'worse']);

const VERDICT_GLYPH = Object.freeze({ OK: '✓', FRAGILE: '▲', TIGHT: '◆', NO: '✕' });

/** Цель по времени ответа (мс) — гипотеза до замера на эталонном устройстве; на экране печатается замер, а не обещание. */
export const STORE_TARGET_MS = 1000;

/**
 * Ответ «в магазине». Без суммы — только «можно потратить сегодня»; с суммой — ещё вердикт и остатки после покупки.
 * @param {object} a контекст расчёта (`model.ctx`)
 * @param {number|null} amount_minor сумма покупки (целое > 0) или `null`
 * @returns {{kind: 'ok', date: string, buffer: number, can_spend: {plan: number|null, worse: number|null}, amount_minor: number|null,
 *   verdict?: string, by_mode?: object, flags?: object, ref?: string}|{kind: 'insufficient_data', reason: string, reasons: string[]}}
 * @throws {RunwayError} E_CURRENCY_MISMATCH и прочие коды движка (сумма не целая)
 */
export function store_model(a, amount_minor = null) {
  const g = gate(a, a.buffer_minor);
  if (g !== null) return { kind: 'insufficient_data', reason: g.reason, reasons: g.reasons };
  const B = a.buffer_minor;
  const out = {
    kind: 'ok',
    date: format_date(a.as_of),
    buffer: B,
    can_spend: { plan: max_amount(a, a.as_of, B, 'plan'), worse: max_amount(a, a.as_of, B, 'worse') },
    amount_minor: null,
  };
  if (amount_minor === null || amount_minor === undefined) return out;
  const purchase = { currency: a.decision_currency, parts: [{ date: a.as_of, amount_minor }] };
  const r = check_purchase(a, purchase, B);
  out.amount_minor = amount_minor;
  if (r.kind !== 'ok') return { ...out, kind: r.kind, reason: r.reason ?? null, reasons: r.reasons ?? [] };
  out.verdict = r.verdict;
  out.by_mode = {};
  for (const m of MODES) out.by_mode[m] = { m_after: r.by_mode[m].m_after, margin: r.by_mode[m].margin, at: format_date(r.by_mode[m].at), cash_gap: r.by_mode[m].cash_gap };
  out.flags = r.flags;
  // ссылка на расчёт — та же, что у экрана «Покупка» (аргументы вызова check_purchase на дате расчёта)
  out.ref = call_ref(call_id('check_purchase', normalize_args({ date: out.date, amount_minor, currency: a.decision_currency }), a.inputs_hash));
  return out;
}

/**
 * Ответ с замером времени: `now` — часы вызывающего (в браузере `performance.now`), результат — десятые доли миллисекунды (целое).
 * @param {object} a
 * @param {number|null} amount_minor
 * @param {() => number} now
 * @returns {{answer: object, ms_x10: number}}
 */
export function timed_store(a, amount_minor, now) {
  const t0 = now();
  const answer = store_model(a, amount_minor);
  const t1 = now();
  return { answer, ms_x10: Math.max(0, Math.round((t1 - t0) * 10)) };
}

/** Десятые доли миллисекунды → «0,3 мс» / «0.3 ms» (без float в выводе: целые деления); с `decimal` — десятичный знак из формата чисел пользователя (REQ-112, FP-16). */
export function ms_text(lang, ms_x10, decimal) {
  const whole = Math.floor(ms_x10 / 10);
  const frac = ms_x10 % 10;
  return whole + (decimal ?? (lang === 'ru' ? ',' : '.')) + frac + (lang === 'ru' ? ' мс' : ' ms');
}

/** Значок вердикта: слово словаря §2.0 и глиф (смысл не только цветом). */
export function verdict_badge(lang, verdict) {
  return h('span', { class: 'verdict verdict-' + verdict },
    h('span', { 'aria-hidden': 'true', class: 'glyph', text: VERDICT_GLYPH[verdict] }), h('span', { text: ' ' + LABELS.verdicts[lang][verdict] }));
}

/** Текст ошибки движка по коду из каталога приложения (`err.<код>`), без значений данных. */
export function engine_error_text(ctx, e) {
  const code = typeof e?.code === 'string' ? e.code : 'E_SCHEMA';
  const s = ctx.tr('err.' + code);
  return s === 'err.' + code ? ctx.tr('err.other') : s;
}

/** Часы страницы: `performance.now`, если есть, иначе без замера (ноль). */
export function page_clock() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? () => performance.now() : () => 0;
}

// ── DOM ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const view_state = { text: '' };

function gate_text(ctx, reason) {
  const key = 'gate.' + reason;
  const model = ctx.get_model();
  const since = reason === 'rule_disabled' && model !== null && model !== undefined ? (oldest_review_date(model.ws, model.ctx.as_of, model.ctx.rule_status, 'disabled') ?? ctx.tr('c.na')) : ''; // FP-15: «не подтверждено с <даты>»
  const s = ctx.tr(key, { since });
  return s === key ? ctx.tr('gate.generic') : s;
}

/**
 * Экран «В магазине»: поле суммы, вердикт, «можно потратить сегодня», остатки после покупки, чип происхождения и замер времени.
 * @param {object} ctx
 * @returns {HTMLElement}
 */
export function render_store(ctx) {
  const tr = ctx.tr;
  const title = h('h2', { id: 'view-title', tabindex: '-1', text: tr('showcase.st_title') });
  const model = ctx.get_model();
  if (model === null) return h('div', { class: 'view sc-view' }, title, h('p', { text: tr('showcase.no_data') }));
  const a = model.ctx;
  const f = ctx.fmt();
  const lang = ctx.lang();
  const nf = model.ws.number_format;
  const clock = page_clock();
  const out = h('div', { class: 'sc-out', role: 'status', 'aria-live': 'polite' });
  const err = h('p', { id: 'sc-st-err', class: 'error', role: 'alert' });
  const input = h('input', {
    id: 'sc-st-amount', type: 'text', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false', value: view_state.text,
    'aria-describedby': 'sc-st-hint sc-st-err', 'aria-invalid': 'false',
  });
  const mode_main = MODES.includes(ctx.mode()) ? ctx.mode() : 'worse';
  const other = mode_main === 'plan' ? 'worse' : 'plan';
  const mode_name = (m) => LABELS.modes[lang][m];

  const time_line = h('p', { class: 'muted sc-time' });
  const paint = (ans) => {
    const nodes = [];
    if (ans.kind === 'insufficient_data') {
      nodes.push(h('p', { class: 'banner', text: gate_text(ctx, ans.reason) }));
    } else {
      const cs = ans.can_spend;
      nodes.push(h('p', { class: 'sc-big' }, h('span', { class: 'muted', text: tr('showcase.st_can_spend') + ' ' }), h('strong', { text: f.money(cs[mode_main]) }), ' ',
        h('span', { class: 'muted', text: '(' + mode_name(mode_main) + ')' })));
      nodes.push(h('p', { class: 'muted', text: tr('showcase.st_other', { value: f.money(cs[other]), mode: mode_name(other), buffer: f.money(ans.buffer), date: f.date(ans.date) }) }));
      if (ans.amount_minor !== null) {
        if (ans.verdict === undefined) {
          nodes.push(h('p', { class: 'banner', text: tr('showcase.st_no_verdict') }));
        } else {
          nodes.push(h('p', { class: 'sc-verdict' }, h('span', { text: tr('showcase.st_verdict', { amount: f.money(ans.amount_minor) }) + ' ' }), verdict_badge(lang, ans.verdict)));
          const rows = MODES.map((m) => h('tr', { class: m === mode_main ? 'mark' : null },
            h('th', { scope: 'row', text: mode_name(m) }),
            h('td', { text: f.money(ans.by_mode[m].m_after) + ' · ' + f.date(ans.by_mode[m].at) }),
            h('td', { text: (ans.by_mode[m].margin < 0 ? tr('showcase.st_below') + ' ' : tr('showcase.st_above') + ' ') + f.money(Math.abs(ans.by_mode[m].margin)) })));
          nodes.push(h('table', { class: 'tbl' },
            h('caption', { class: 'sr-only', text: tr('showcase.st_caption') }),
            h('thead', null, h('tr', null, ['showcase.st_col_mode', 'showcase.st_col_after', 'showcase.st_col_margin'].map((k) => h('th', { scope: 'col', text: tr(k) })))),
            h('tbody', null, rows)));
          if (ans.flags.worse_gap) nodes.push(h('p', { class: 'banner short', text: tr('showcase.st_gap') }));
          nodes.push(render_origin_chip(ctx, origin_model(a, mode_main, {
            tool: 'check_purchase', args: normalize_args({ date: ans.date, amount_minor: ans.amount_minor, currency: a.decision_currency }),
            rows: [{ label: tr('showcase.st_chip_amount'), value: f.money(ans.amount_minor) }],
          })));
        }
      }
    }
    nodes.push(time_line);
    out.replaceChildren(...nodes);
  };

  const update = () => {
    const t0 = clock();
    const text = input.value;
    view_state.text = text;
    let amount = null;
    err.textContent = '';
    input.setAttribute('aria-invalid', 'false');
    if (text.trim() !== '') {
      const p = parse_amount_text(text, model.cur, lang, nf);
      if (!p.ok || p.value < 1) {
        err.textContent = tr('showcase.st_bad_amount', { example: f.money(12345).replace(/\s*[^\d\s.,−-]+\s*$/u, '') });
        input.setAttribute('aria-invalid', 'true');
      } else amount = p.value;
    }
    let ans;
    try { ans = store_model(a, amount); } catch (e) {
      out.replaceChildren(h('p', { class: 'banner short', role: 'alert', text: tr('showcase.st_failed', { reason: engine_error_text(ctx, e) }) }));
      return;
    }
    paint(ans);
    const ms_x10 = Math.max(0, Math.round((clock() - t0) * 10)); // от ввода до готового ответа, вместе с показом
    time_line.textContent = tr('showcase.st_time', { ms: ms_text(lang, ms_x10, resolve_number_format(lang, nf).decimal), target: STORE_TARGET_MS / 1000 });
  };
  input.addEventListener('input', update);
  update();
  const rate_note = note_node(answer_note_text(tr, make_env(lang, model.ws, a), rate_uses(model.ws, a, model.scenario))); // курсы, по которым пересчитан ответ: события и остатки в чужой валюте (REQ-077, REQ-079)
  return h('div', { class: 'view sc-view' }, title,
    h('p', { class: 'lead', text: tr('showcase.st_lead') }),
    h('div', { class: 'field' },
      h('label', { for: 'sc-st-amount', text: tr('showcase.st_label', { cur: model.cur }) }), input,
      h('p', { id: 'sc-st-hint', class: 'muted', text: tr('showcase.st_hint', { exp: currency_exponent(model.cur) }) }), err),
    out,
    rate_note,
    h('p', { class: 'muted', text: tr('showcase.tax_note') }));
}
