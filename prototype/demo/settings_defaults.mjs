// settings_defaults.mjs — значения по умолчанию на экране «Настройки» (FP-17, REQ-019): под каждым полем — «по умолчанию N» и кнопка «Вернуть по умолчанию»,
// ниже — таблица всех параметров «действует / по умолчанию / состояние». Значения по умолчанию — ДАННЫЕ словаря `engine/vocab.json` (читаются через сгенерированный
// `engine/vocab.generated.mjs` и `engine/param_defaults.mjs`); в этом модуле литералов-умолчаний нет, `vocab.json` не правится.
// «Вернуть по умолчанию» — это правка `set_param` с признаком `reset: true` (`ws_edit.mjs`): собственное значение рабочей области снимается (ключ пропадает из `params`,
// у параметров с «не задан» — явный null), пересчёт и журнал идут общим путём, шаг можно отменить кнопкой «Отменить».
// Устройство файла: чистые модели (без DOM, проверяются в Node), затем узлы (`h` из dom.mjs: только textContent и узлы, без inline-стилей и обработчиков-строк).
// Расчёт по введённым данным и правилам, не консультация.

import { h, table } from './dom.mjs';
import { PARAM_SPECS } from './ws_edit.mjs';
import { describe_param, param_keys } from '../engine/param_defaults.mjs';
import { make_nf_fmt } from './number_format.mjs';

/** Параметры, которые показываются пользователю: есть в словаре и редактируются (валюта решения и `kdf.*` не входят: они не настраиваются здесь). */
export const LISTED_KEYS = Object.freeze(param_keys().filter((k) => Object.hasOwn(PARAM_SPECS, k) && PARAM_SPECS[k].kind !== 'currency'));

/**
 * Параметры, которые есть в словаре, но расчёт и интерфейс пока НЕ читают из `ws.params` (в коде они служат только умолчанием аргументов функций или не используются вовсе):
 * таблица называет их «пока не используется расчётом» и не выдаёт значение за действующее. Список держит тест `fp17_fix.test.mjs`: параметр, у которого появился читатель, из него убирают.
 */
export const NOT_YET_USED = Object.freeze(['crypto.liquidity_bp', 'backtest.h_days', 'backtest.min_window_days', 'calib.window', 'calib.prior', 'calib.k', 'calib.alpha_bp', 'calib.min_origins', 'mc.n_paths']);

/** Правка «вернуть по умолчанию» для параметра. */
export const reset_edit = (key) => ({ type: 'set_param', key, reset: true });

/** Ключ строки каталога с названием параметра: `fx.stale_days` → `defaults.p_fx_stale_days`. */
export const label_key = (key) => 'defaults.p_' + key.replace(/\./g, '_');

// ── чистые модели ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Строка таблицы: действующее значение, умолчание словаря и можно ли вернуть.
 * @param {{ws: object}} model модель страницы (`ctx.get_model()`)
 * @param {string} key
 * @returns {{key: string, kind: string, default: any, value: any, explicit: boolean, is_default: boolean, changed: boolean, hypothesis: boolean, phase: string|null, used: boolean}|null}
 *   `used: false` — параметр пока не читается расчётом (`NOT_YET_USED`): «действует» для него не выводится
 */
export function default_row(model, key) {
  if (!LISTED_KEYS.includes(key)) return null;
  const d = describe_param(key, model?.ws?.params);
  if (d === null) return null;
  return { key, kind: PARAM_SPECS[key].kind, default: d.default, value: d.value, explicit: d.explicit, is_default: d.is_default, changed: d.explicit && !d.is_default, hypothesis: d.hypothesis, phase: d.phase, used: !NOT_YET_USED.includes(key) };
}

/** Все строки таблицы в порядке словаря. */
export function default_rows(model) {
  return LISTED_KEYS.map((k) => default_row(model, k)).filter((r) => r !== null);
}

/** План «вернуть по умолчанию»: пусто, если собственного значения нет (или оно равно умолчанию) — писать нечего. */
export function plan_reset(model, key) {
  const r = default_row(model, key);
  if (r === null) return { ok: false, reason: 'unknown_param', edits: [] };
  return { ok: true, edits: r.changed ? [reset_edit(key)] : [] };
}

/**
 * Показ значения параметра: сумма — в валюте решения и формате пользователя, сроки — со словом «дн.», доли — в процентах, перечисления — подписью, `null` — «не задан».
 * @param {{tr: Function}} ctx
 * @param {string} key
 * @param {string} kind вид параметра из `PARAM_SPECS`
 * @param {any} v значение
 * @param {object} f форматтер `make_nf_fmt`
 */
export function value_text(ctx, key, kind, v, f) {
  if (v === null || v === undefined) return ctx.tr(key === 'wave.threshold_minor' ? 'defaults.v_auto' : 'defaults.v_unset');
  if (kind === 'minor') return f.money(v);
  if (kind === 'enum') return ctx.tr('defaults.e_' + v);
  if (key.endsWith('_bp')) return f.bp(v);
  if (key.endsWith('_days') || key.startsWith('grace_days.')) return f.days(v);
  return String(v);
}

function formatter(ctx, model) {
  return make_nf_fmt(ctx.lang(), model.cur, model.as_of_iso, model.ws.number_format);
}

// ── узлы ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Строка «по умолчанию N» под полем формы и кнопка «Вернуть по умолчанию» (отключена, пока собственного значения нет).
 * @param {object} ctx контекст расширений
 * @param {object} model модель страницы
 * @param {string} key параметр рабочей области
 * @param {{id: string, disabled?: boolean, on_reset: (key: string) => void}} o `id` — идентификатор поля (`set-horizon`); `on_reset` записывает правку
 * @returns {HTMLElement|null}
 */
export function default_line(ctx, model, key, o) {
  const r = default_row(model, key);
  if (r === null) return null;
  const f = formatter(ctx, model);
  const dflt = value_text(ctx, key, r.kind, r.default, f);
  const text = r.changed
    ? ctx.tr('defaults.line_diff', { value: dflt, current: value_text(ctx, key, r.kind, r.value, f) })
    : ctx.tr('defaults.line_same', { value: dflt });
  return h('div', { class: 'row fp17-default' },
    h('p', { id: o.id + '-default', class: 'muted', text }),
    h('button', {
      type: 'button', class: 'btn', id: o.id + '-reset', disabled: !r.changed || o.disabled === true, 'aria-describedby': o.id + '-default',
      text: ctx.tr('defaults.reset'), onclick: () => { if (r.changed && o.disabled !== true) o.on_reset(key); },
    }));
}

/**
 * Карточка «Все параметры и значения по умолчанию»: таблица «параметр — действует — по умолчанию — состояние — действие».
 * @param {object} ctx
 * @param {object} model
 * @param {{disabled?: boolean, flash?: boolean, on_reset: (key: string) => void}} o `flash` — подтверждение «Сохранено.» после возврата
 * @returns {HTMLElement}
 */
export function defaults_section(ctx, model, o) {
  const tr = ctx.tr;
  const f = formatter(ctx, model);
  const rows = default_rows(model);
  const changed = rows.filter((r) => r.changed).length;
  const body = rows.map((r) => {
    const name = tr(label_key(r.key));
    const label = r.hypothesis ? name + ' · ' + tr('defaults.hypothesis') : name;
    const act = r.changed
      ? h('button', {
        type: 'button', class: 'btn', disabled: o.disabled === true, 'aria-label': tr('defaults.reset_row_aria', { name }), text: tr('defaults.reset_row'),
        onclick: () => { if (o.disabled !== true) o.on_reset(r.key); },
      })
      : '—';
    return h('tr', { class: r.changed ? 'mark' : null },
      h('th', { scope: 'row', text: label }),
      h('td', { class: 'num', text: r.used ? value_text(ctx, r.key, r.kind, r.value, f) : tr('defaults.v_not_used') }),
      h('td', { class: 'num', text: value_text(ctx, r.key, r.kind, r.default, f) }),
      h('td', { text: r.used ? tr(r.changed ? 'defaults.st_changed' : 'defaults.st_default') : tr('defaults.st_unused') }),
      h('td', null, act));
  });
  return h('section', { class: 'card fp17-defaults', id: 'settings-defaults', 'aria-labelledby': 'settings-defaults-title' },
    h('h3', { id: 'settings-defaults-title', tabindex: '-1', text: tr('defaults.s_all') }),
    h('p', { class: 'lead', text: tr('defaults.l_all') }),
    h('p', { class: 'muted', role: 'status', text: changed === 0 ? tr('defaults.none_changed') : tr('defaults.changed_count', { n: changed, total: rows.length }) + (o.flash === true ? ' ' + tr('settings.saved') : '') }),
    table(tr('defaults.s_all'), [tr('defaults.col_param'), tr('defaults.col_now'), tr('defaults.col_default'), tr('defaults.col_state'), tr('defaults.col_action')], body));
}
