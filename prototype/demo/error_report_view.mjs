// error_report_view.mjs — блок «Сообщить об ошибке» (FP-22, REQ-124, IDEA-80, TST-46) на экране «Данные».
//
// Что делает. Показывает текст отчёта об ошибке ЦЕЛИКОМ (`log.build_error_report` → `report_text`: поля белого списка `id`, `n`, `ms`, `code`, `engine_version`, строки длиннее
// 32 знаков срезаются), только после согласия пользователя, и копирует его в буфер обмена по кнопке. Больше НИЧЕГО: ни сетевого вызова, ни ссылки «отправить», ни почтового адреса —
// отчёт передаёт человек, если захочет. Без согласия текст не строится и не показывается (`build_error_report` без согласия отказывает). Согласие не хранится нигде и снимается
// при выходе со страницы. Источник отчёта — последняя запись уровня `error` в журнале приложения (`log.entries()`: ошибки хранилища, глобальные ошибки страницы); записей нет —
// отчёт содержит ТОЛЬКО версию движка (строки `code` в нём нет: придумывать код ошибки, которой не было, нечем; FP-48 — раньше стояло значение по умолчанию `E_UNKNOWN`
// при тексте блока «в отчёт войдёт только версия движка»).
//
// Состояние живёт в `deps.ui`, а узел можно перестроить на месте (`fill`): страница перерисовывается и по просьбе хранилища (FP-05), и по действию пользователя, поэтому фокус
// возвращает хранитель `focus_keep.mjs`. Ответ буфера обмена асинхронный и не трогает отсоединённый узел: после него зовётся общая перерисовка `ctx.refresh()`.
// Модуль не пишет в консоль и не читает часы напрямую (часы — порт `ids.clock_ports`). Расчёт по введённым данным и правилам, не консультация.

import { ENGINE_VERSION } from '../engine/index.mjs';
import { h, el_by_id } from './dom.mjs';
import { build_error_report, report_text, log } from './log.mjs';
import { create_focus_keeper } from './focus_keep.mjs';
import { is_checked } from './forms.mjs';
import { clock_ports } from './ids.mjs';

/** Кнопка, чекбокс и поля блока (идентификаторы в DOM страницы). */
export const IDS = Object.freeze({ block: 'er-block', title: 'er-title', consent: 'er-consent', text: 'er-text', copy: 'er-copy', status: 'er-copy-status' });

/** Буфер обмена браузера или `null` (нет API, небезопасный контекст, Node). */
export function browser_clipboard() {
  try {
    const c = globalThis.navigator?.clipboard;
    return c !== undefined && c !== null && typeof c.writeText === 'function' ? c : null;
  } catch { return null; }
}

/**
 * Последняя запись уровня `error` из записей журнала приложения или `null`.
 * @param {{level?: string}[]} entries
 */
export function latest_error(entries) {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i]?.level === 'error') return entries[i];
  return null;
}

/**
 * Отчёт по последней ошибке журнала. Поля берутся только из записи журнала (она уже очищена логгером) и проходят `build_error_report` ещё раз; название события и любые прочие
 * поля записи в отчёт не входят. Записи нет (журнал без ошибок) — в отчёте одна строка `engine_version`, без `code`: блок обещает «только версию движка» (FP-48).
 * Запись есть, но без кода — `code: E_UNKNOWN` остаётся: ошибка была, код неизвестен.
 * @param {object|null} entry запись журнала или `null`
 * @param {boolean} consent согласие пользователя
 * @param {string} [engine_version]
 * @returns {{ok: true, fields: object, text: string} | {ok: false, reason: 'consent_required'}}
 */
export function make_report(entry, consent, engine_version = ENGINE_VERSION) {
  const input = { consent, engine_version, error: { code: typeof entry?.code === 'string' ? entry.code : 'E_UNKNOWN' } };
  if (entry !== null && entry !== undefined) {
    if (entry.id !== undefined) input.id = entry.id;
    if (entry.n !== undefined) input.n = entry.n;
    if (entry.ms !== undefined) input.ms = entry.ms;
    if (typeof entry.engine_version === 'string') input.engine_version = entry.engine_version;
  }
  const r = build_error_report(input);
  if (r.ok === true && (entry === null || entry === undefined)) {
    const { code: _default_code, ...only_version } = r.fields; // код по умолчанию — не данные об ошибке, а заглушка `build_error_report`
    return { ok: true, fields: only_version, text: report_text(only_version) };
  }
  return r;
}

/**
 * Зависимости блока на один контекст.
 * @param {{logger?: object, clipboard?: () => ({writeText: Function}|null), engine_version?: string, ports?: {now_ms: () => number}}} [env] порты (в тестах подменяются)
 */
export function make_deps(env = {}) {
  const ports = env.ports ?? clock_ports();
  return {
    ui: { consent: false, copy: null, copied_text: null }, // copy: null | 'ok' | 'failed' — итог последней попытки; copied_text — текст отчёта, к которому он относится
    focus: create_focus_keeper(ports.now_ms),
    logger: env.logger ?? log,
    clipboard: env.clipboard ?? browser_clipboard,
    engine_version: env.engine_version ?? ENGINE_VERSION,
  };
}

/** Скопировать текст в буфер обмена: `true`, если браузер принял. Не бросает. */
export async function copy_text(deps, text) {
  try {
    const clip = deps.clipboard();
    if (clip === null || clip === undefined || typeof clip.writeText !== 'function') return false;
    await clip.writeText(text);
    return true;
  } catch { return false; }
}

function build_nodes(ctx, deps, fill) {
  const tr = ctx.tr;
  const entry = latest_error(deps.logger.entries());
  const report = deps.ui.consent ? make_report(entry, true, deps.engine_version) : null;
  const nodes = [
    h('h3', { id: IDS.title, tabindex: '-1', text: tr('errrep.title') }),
    h('p', { class: 'lead', text: tr('errrep.lead') }),
    h('p', { id: 'er-state', text: entry === null ? tr('errrep.none') : tr('errrep.last', { code: typeof entry.code === 'string' ? entry.code : 'E_UNKNOWN' }) }),
    h('p', { class: 'muted', text: tr('errrep.global_note') }),
  ];
  const agree = h('input', { type: 'checkbox', id: IDS.consent, checked: deps.ui.consent ? true : null, 'aria-describedby': 'er-consent-hint' });
  agree.addEventListener('change', () => {
    deps.ui.consent = is_checked(agree);
    deps.ui.copy = null;
    deps.ui.copied_text = null;
    deps.focus.request(IDS.consent);
    fill();
    const el = el_by_id(IDS.consent);
    if (el !== null && el !== undefined && typeof el.focus === 'function') el.focus();
  });
  nodes.push(h('div', { class: 'field check' }, h('label', { for: IDS.consent }, agree, ' ', tr('errrep.consent'))));
  if (report !== null && report.ok === true) {
    // итог копирования относится к тому тексту, который копировали: в журнале появилась новая ошибка — показанный текст другой, и отметка «скопировано» к нему не относится
    const current = deps.ui.copied_text === report.text;
    const status = current && deps.ui.copy === 'ok' ? tr('errrep.copied') : current && deps.ui.copy === 'failed' ? tr('errrep.copy_failed') : '';
    nodes.push(
      h('p', { class: 'muted', id: 'er-consent-hint', text: tr('errrep.text_label') }),
      h('pre', { id: IDS.text, class: 'er-text', tabindex: '0', text: report.text }),
      h('div', { class: 'row er-actions' }, h('button', {
        type: 'button', class: 'btn primary', id: IDS.copy, text: tr('errrep.copy'),
        onclick: async () => {
          const ok = await copy_text(deps, report.text);
          deps.ui.copy = ok ? 'ok' : 'failed';
          deps.ui.copied_text = report.text;
          deps.focus.request(IDS.copy);
          ctx.refresh(); // ответ асинхронный: узел мог уйти из страницы, поэтому перерисовывается страница, а не это замыкание
        },
      })),
      h('p', { id: IDS.status, role: 'status', class: status === '' ? 'muted' : null, text: status }));
  } else {
    nodes.push(h('p', { class: 'muted', id: 'er-consent-hint', text: tr('errrep.consent_needed') }));
  }
  nodes.push(h('p', { class: 'muted', id: 'er-no-send', text: tr('errrep.no_send') }));
  return nodes;
}

/**
 * Блок «Сообщить об ошибке» (слот `data.sections`).
 * @param {object} ctx контекст расширений
 * @param {ReturnType<typeof make_deps>} deps
 */
export function render_error_report(ctx, deps) {
  const box = h('section', { id: IDS.block, class: 'card er-block', 'aria-labelledby': IDS.title });
  const fill = () => box.replaceChildren(...build_nodes(ctx, deps, fill));
  fill();
  deps.focus.apply();
  return box;
}
