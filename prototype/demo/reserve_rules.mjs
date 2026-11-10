// reserve_rules.mjs — срок годности налоговых правил на экране «Резервы»: плашка «не подтверждено с <даты>» и «Подтвердить правило» (FP-15, REQ-067, REQ-108, C-023, C-024).
//
// Статус считает движок (`rule_age_status`, формула единая: `fresh` при возрасте ≤ ttl, `stale` при ttl < возраст ≤ 2·ttl, `disabled` при возрасте > 2·ttl); модель карточки — готовая
// `tax_state_model` формы «Налог» (FP-08), правка «подтвердить» — её `confirm_edit`: новая версия правила с `reviewed_at = сегодня` и прежним `ttl_days`, прошлые версии и записанные
// по ним суммы не меняются. Правило без отметки проверки — «проверка не отмечена» (не `fresh` молча). Запись общим путём (`forms.commit_edits` → `ctx.set_ws`): стопка «Отменить»
// откатывает подтверждение целиком. Даты показываются в ISO (однозначно). Ставок и сроков в модуле нет: правило и его срок вводит пользователь.
// Расчёт по введённым правилам, не консультация.

import { format_date } from '../engine/index.mjs';
import { h } from './dom.mjs';
import { label_of } from './i18n.mjs';
import { tax_state_model, confirm_edit } from './form_tax.mjs';
import { commit_edits, error_text } from './forms.mjs';
import { refocus_later } from './reserve_release.mjs';

/**
 * Карточка «Срок годности налоговых правил» (слот `reserves.sections`): по каждому правилу — состояние словами, дата проверки, возраст; для `stale` и `disabled` — плашка
 * с датой и кнопка «Подтвердить правило». Правил нет — `null`.
 * @param {object} ctx
 * @returns {HTMLElement|null}
 */
export function render_rule_cards(ctx) {
  const model = ctx.get_model();
  if (model === null || model === undefined) return null;
  const states = tax_state_model(model);
  if (states.length === 0) return null;
  const tr = ctx.tr;
  const items = states.map((r, i) => {
    const name = label_of(ctx.lang(), r.id, r.rule.name ?? r.id);
    const kids = [h('p', { id: 'fp15-rule-' + i + '-title', tabindex: '-1' }, h('strong', { text: name }), ' ',
      h('span', { class: 'state-chip ' + r.status, text: tr('rs.rule_state', { state: tr('rs.state_' + r.status) }) }))];
    if (!r.marked) kids.push(h('p', { class: 'muted', text: tr('reserveui.rule_unmarked') }));
    else if (r.status === 'fresh') {
      // отметка проверки есть, а срока годности нет (старые данные): честно говорим «срок не задан», а не печатаем пустое значение (FP-15, дефект ADV-2)
      kids.push(h('p', { class: 'muted', text: Number.isSafeInteger(r.ttl_days)
        ? tr('reserveui.rule_fresh', { since: r.reviewed_at, ttl: r.ttl_days, age: r.age_days }) : tr('reserveui.rule_no_ttl', { since: r.reviewed_at }) }));
    } else {
      const text = tr(r.status === 'disabled' ? 'reserveui.rule_disabled' : 'reserveui.rule_stale', { since: r.reviewed_at, ttl: r.ttl_days, age: r.age_days });
      const id = 'fp15-rule-' + i + '-confirm';
      const confirm = () => {
        const ws = ctx.get_ws();
        const c = confirm_edit(ws, r.id, ws.as_of);
        if (!c.ok) { ctx.notify(error_text(ctx, c.error), 'error'); return; }
        refocus_later([id, 'fp15-rule-' + i + '-title', 'fp15-rules-title']);
        const w = commit_edits(ctx, [c.edit], 'upsert_tax_rule');
        if (w.ok) {
          // запланированная версия (смена ставки с даты) не менялась: подтверждение действует только до её начала
          const until = c.scheduled_from === null || c.scheduled_from === undefined ? null : (typeof c.scheduled_from === 'string' ? c.scheduled_from : format_date(c.scheduled_from));
          ctx.notify(until === null ? tr('reserveui.rule_confirmed', { name }) : tr('reserveui.rule_confirmed_until', { name, until }), 'info');
        } else ctx.notify(w.error?.ctx?.reason === 'read_only' ? tr('ro.refused') : tr('reserveui.rule_failed', { code: w.error?.code ?? 'E_SCHEMA' }), 'error'); // «только чтение» (FP-17): причина, а не код
      };
      kids.push(h('div', { class: r.status === 'disabled' ? 'banner short' : 'banner tight', role: 'status', 'data-status': r.status },
        h('p', { text: text }),
        h('div', { class: 'row' }, h('button', {
          type: 'button', class: 'btn primary small', id, 'data-act': 'confirm', disabled: !Number.isSafeInteger(r.ttl_days), 'aria-label': tr('reserveui.rule_confirm_aria', { name }),
          onclick: confirm, text: tr('reserveui.rule_confirm'),
        }), !Number.isSafeInteger(r.ttl_days) ? h('span', { class: 'muted', text: tr('reserveui.rule_needs_ttl') }) : null)));
    }
    return h('li', { class: 'fp15-rule', 'data-rule': r.id }, kids);
  });
  return h('section', { class: 'card fp15-card', id: 'fp15-rules', 'aria-labelledby': 'fp15-rules-title' },
    h('h3', { id: 'fp15-rules-title', tabindex: '-1', text: tr('reserveui.rules_title') }),
    h('p', { class: 'muted', text: tr('reserveui.rules_lead') }),
    h('ul', { class: 'plain' }, items),
    h('p', { class: 'muted', text: tr('c.tax_note') }));
}
