// prob_buy.mjs — «при уверенности α максимум X» по согласию (FP-11, REQ-054, REQ-055, ADR-008, ADR-015, решение владельца № 3).
// Это ОТДЕЛЬНАЯ оценка по истории пользователя поверх тех же событий, что и вердикт: она не заменяет детерминированный ответ Q3 на экране «Купить» и не влияет на вердикты OK/TIGHT/FRAGILE/NO.
// Выключено по умолчанию; блок рисуется на экране «Качество прогноза» только после явного согласия (см. `prob_band.mjs`). Правила подачи (REQ-055):
//   - без истории — отказ с перечнем потоков, у которых нет наблюдений; без буфера, с датой до расчёта или за горизонтом — отказ с причиной;
//   - число наблюдений n показывается всегда; при n < 20 проценты не подаются: полный перебор наблюдений даёт счёт «в k из n прошлых случаев», выборка — «мало наблюдений»;
//   - при n ≥ 20 — «≈ p % (95 %: lo–hi %)» по интервалу Уилсона; квантиль с ceil(q·n) = n подписан «наибольшее из n», с ceil(q·n) = 1 при q < 50 — «наименьшее из n».
// Везде пометка «эксперимент, не обещание». Расчёт по введённым данным и прошлым задержкам, не консультация и не рекомендация покупки.

import { mc_buy, CONFIDENCE_LEVELS } from '../engine/band_adapter.mjs';
import { h } from './dom.mjs';
import { env_of, fmt_of, parse_money, parse_date_input, text_field, select_field, show_field_error } from './forms.mjs';
import { source_of, kinds_of, pm_number, refusal_for, UI_PATHS } from './prob_band.mjs';

const LABEL_KEYS = Object.freeze({ min_of_n: 'quality.label_min', max_of_n: 'quality.label_max' });

/** Разобрать форму: сумма > 0 по формату рабочей области, дата, уровень уверенности из списка. */
export function parse_buy_form(env, texts) {
  const amount = parse_money(texts.amount, env, 'amount');
  if (!amount.ok) return amount;
  const date = parse_date_input(texts.date, env, 'date');
  if (!date.ok) return date;
  const c = Number(texts.confidence);
  if (!CONFIDENCE_LEVELS.includes(c)) return { ok: false, error: { code: 'E_SCHEMA', ctx: { field: 'confidence', reason: 'not_in_list' } } };
  return { ok: true, S: amount.value, date: date.value, confidence: c };
}

/**
 * Начало ключа расчёта: источник, `inputs_hash` и набор возмущений (задержки, плюс отклонения трат и курсы, если отмечены). Общий для записи ключа (`compute_buy`) и проверки свежести
 * (`render_buy_section`): смена данных, источника или набора возмущений делает прежний результат устаревшим. Заканчивается разделителем `|`, поэтому префикс однозначен.
 * @param {{synthetic: boolean, analysis: {inputs_hash: string}}} src результат `source_of`
 * @param {object} deps
 * @returns {string}
 */
export function buy_key_prefix(src, deps) {
  return [src.synthetic ? 's' : 'm', src.analysis.inputs_hash, kinds_of(deps).join('+')].join('|') + '|';
}

/** Посчитать оценку и положить в `deps.buy` с ключом (данные + настройки + ввод). */
export function compute_buy(ctx, deps, form) {
  const src = source_of(ctx, deps);
  if (src === null) { deps.buy = { ...deps.buy, key: null, result: null }; return null; }
  const result = mc_buy(src.ws, src.analysis, { S: form.S, date: form.date, confidences: [form.confidence], kinds: kinds_of(deps), n_paths: UI_PATHS });
  deps.buy = { ...deps.buy, key: buy_key_prefix(src, deps) + [form.S, form.date, form.confidence].join('|'), result };
  return result;
}

/**
 * Строки результата по режиму подачи (REQ-055). Чистая: берёт готовый `mc_buy` и форматтеры.
 * @param {(key: string, params?: object) => string} tr
 * @param {object} res результат `mc_buy` с `ok = true`
 * @param {number} confidence выбранный уровень
 * @param {{money: (m: number) => string, num: (pm: number) => string}} f форматтеры (деньги; доля ‰ → число)
 * @returns {string[]}
 */
export function buy_lines(tr, res, confidence, f) {
  const level = res.levels.find((l) => l.confidence === confidence) ?? res.levels[0];
  const label = level.label === null ? '' : ' (' + tr(LABEL_KEYS[level.label], { n: res.enumerated ? res.held.n : res.n_eff }) + ')';
  const lines = [];
  const pres = res.presentation;
  if (pres.kind === 'count') {
    lines.push(tr('quality.buy_enum', { c: level.confidence, x: f.money(level.s_max), label, n: pres.n }));
    lines.push(tr('quality.buy_count', { s: f.money(res.S), k: pres.k, n: pres.n }));
  } else if (pres.kind === 'interval') {
    lines.push(tr('quality.buy_sample', { c: level.confidence, x: f.money(level.s_max), label, n: res.n_eff }));
    lines.push(tr('quality.buy_interval', { s: f.money(res.S), p: f.num(pres.p_pm), lo: f.num(pres.lo_pm), hi: f.num(pres.hi_pm), n: pres.n }));
  } else {
    // мало наблюдений при выборке: процентов нет; сумма — осторожная оценка по n прошлым случаям
    lines.push(tr('quality.buy_small', { x: f.money(level.s_max), label, n: res.n_eff }));
  }
  return lines;
}

/** Блок «При уверенности α максимум…» экрана «Качество прогноза» (рисуется только при согласии). */
export function render_buy_section(ctx, deps) {
  const tr = ctx.tr;
  const src = source_of(ctx, deps);
  const sec = h('section', { id: 'qx-buy', class: 'card qx-buy', 'aria-labelledby': 'qx-buy-title' },
    h('h3', { id: 'qx-buy-title', text: tr('quality.buy_title') }),
    h('p', { class: 'qx-badge', text: tr('quality.badge') }),
    h('p', { class: 'lead', text: tr('quality.buy_lead') }));
  if (src === null) { sec.append(h('p', { class: 'muted', text: tr('quality.no_data') })); return sec; }
  const env = env_of(ctx, src.ws);
  const form = deps.buy.form ?? { amount: '', date: src.ws.as_of, confidence: 90 };
  const amount = text_field(ctx, 'qxbuy', 'amount', { label: tr('quality.buy_amount', { cur: env.cur }), hint: tr('quality.buy_amount_hint'), inputmode: 'decimal', value: form.amount });
  const date = text_field(ctx, 'qxbuy', 'date', { label: tr('quality.buy_date'), hint: tr('quality.buy_date_hint'), type: 'date', value: form.date, min: src.ws.as_of });
  const conf = select_field(ctx, 'qxbuy', 'confidence', CONFIDENCE_LEVELS.map((c) => ({ value: String(c), text: tr('quality.buy_conf_option', { c }) })), String(form.confidence), { label: tr('quality.buy_conf'), hint: tr('quality.buy_conf_hint') });
  const status = h('p', { class: 'muted', role: 'status', id: 'qx-buy-status' });
  const out = h('div', { id: 'qx-buy-result', class: 'qx-result', tabindex: '-1', role: 'region', 'aria-label': tr('quality.buy_result_label') });
  const formEl = h('form', { id: 'qx-buy-form', class: 'qx-buy-form', novalidate: true, 'aria-labelledby': 'qx-buy-title', onsubmit: (ev) => {
    if (ev !== undefined && ev !== null && typeof ev.preventDefault === 'function') ev.preventDefault();
    for (const x of [amount, date, conf]) show_field_error(ctx, x, null);
    status.textContent = '';
    const texts = { amount: amount.input.value, date: date.input.value, confidence: conf.input.value };
    const r = parse_buy_form(env, texts);
    deps.buy = { ...deps.buy, form: { amount: texts.amount, date: texts.date, confidence: Number(texts.confidence) || 90 } };
    if (!r.ok) {
      const field = { amount, date, confidence: conf }[r.error?.ctx?.field] ?? amount;
      show_field_error(ctx, field, r.error);
      return r;
    }
    deps.focus.request('qx-buy-result');
    compute_buy(ctx, deps, r);
    ctx.refresh();
    return r;
  } }, amount.wrap, date.wrap, conf.wrap, h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn primary', id: 'qx-buy-run', text: tr('quality.buy_run') })), status);
  sec.append(formEl);
  // результат: только если он посчитан для текущих данных, источника и набора возмущений; иначе подсказка «устарел», как у полосы
  const r = deps.buy.result;
  const has_result = r !== null && r !== undefined && deps.buy.key !== null && deps.buy.key !== undefined;
  if (has_result && deps.buy.key.startsWith(buy_key_prefix(src, deps))) {
    if (r.ok !== true) out.append(h('p', { class: 'banner', role: 'status', id: 'qx-buy-refusal', text: refusal_for(ctx, src.ws, r) }));
    else {
      const f = fmt_of(env);
      const conf_now = deps.buy.form?.confidence ?? 90;
      if (src.synthetic) out.append(h('p', { class: 'banner', text: tr('quality.synth_note') }));
      out.append(
        h('ul', { class: 'plain qx-notes', id: 'qx-buy-lines' }, buy_lines(tr, r, conf_now, { money: f.money, num: pm_number(f) }).map((t) => h('li', { text: t }))),
        h('p', { class: 'muted', text: tr('quality.buy_n', { n: r.n_eff, mode: tr(r.enumerated ? 'quality.mode_enum' : 'quality.mode_sample'), seed: r.seed }) }),
        h('p', { class: 'muted', text: tr('quality.buy_verdict_note', { date: f.date(r.date) }) }));
    }
  } else out.append(h('p', { class: 'muted', id: has_result ? 'qx-buy-stale' : 'qx-buy-hint', text: tr(has_result ? 'quality.buy_stale' : 'quality.buy_not_run') }));
  sec.append(out);
  return sec;
}

