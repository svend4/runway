// pack_fp20.mjs — точка входа пакета FP-20: ассистент A0 — чип происхождения у каждого ответа (режим, версия движка, дата узкой точки, хэш), «почему» у ответа,
// «что изменилось с <даты>» (журнал страницы), журнал вызовов `assistant.call` (только хэши) с выгрузкой в CSV и примеры новых вопросов.
// Что подключается:
//   - хук `assistant` (ext.mjs): действие `chip` — узел чипа ответа (его вызывает app.mjs вместо прежней кнопки и передаёт действие «Числа расчёта» — таблицу чисел показывает само приложение), действие `ports` — журнал страницы, порт `call_log`
//     и запись `assistant.call` для вопроса ассистента, действие `note` — пояснение допущений ответа (какое поступление сдвинуто, чем ограничен журнал); для других действий хук не отвечает (`undefined`);
//   - слот `assistant.extras`: карточки «Новые вопросы» (порядок 905) и «Журнал вызовов» (порядок 910) после карточки происхождения чисел FP-09 (900).
// Журнал страницы создаётся при открытии набора данных (событие `adopt`), чтобы «что изменилось» видело правки с самого начала сеанса.
// Журнал вызовов живёт в журнале страницы (память вкладки), на диск и в хранилище не пишется; повтор расчёта по `call_id` не входит (решение владельца о хранении аргументов — FP-34).
// Пакет не импортирует app.mjs; прежние намерения ассистента и прежний чип не затронуты (без пакета приложение работает как раньше).
// Расчёт по введённым данным и правилам, не консультация.

import catalog from './i18n/a0ext.mjs';
import { render_answer_chip, render_calls_card, render_examples_card, make_ports, answer_notes } from './assistant_ext.mjs';

/** Места карточек в слоте `assistant.extras`: после карточки «Происхождение чисел» (FP-09, порядок 900). */
export const ORDERS = Object.freeze({ examples: 905, calls: 910 });

/** @param {object} ext реестр расширений (`ext.mjs`, версия для пакета) */
export function register(ext) {
  const ctx = ext.ctx;
  // каталог строк принимается один раз на процесс: повторная загрузка пакета (тесты, перезапуск реестра) не должна падать
  if (ctx.tr('a0ext.calls_title') === 'a0ext.calls_title') ext.register_i18n('a0ext', catalog);
  ext.ensure_css('css/showcase.css'); // стили чипа происхождения (`.sc-chip`) принадлежат FP-09; подключение повторно безвредно
  ext.ensure_css('css/a0ext.css');
  const view = { paint: null };
  // журнал страницы создаётся сразу после открытия набора данных (как в диалоге сверки остатка): иначе он собирался бы при первом вопросе из уже изменённой рабочей области,
  // и правки, внесённые до того, оказались бы в снимке открытия и пропали бы из «что изменилось»
  ctx.subscribe(({ reason }) => { if (reason === 'adopt') void ctx.journal; });
  ext.register_hook('assistant', (c, action, ...args) => {
    if (action === 'chip') return render_answer_chip(c, args[0], args[1], args[2]);
    if (action === 'ports') return make_ports(c, view);
    if (action === 'note') { const lines = answer_notes(c, args[0]); return lines.length === 0 ? undefined : lines.join(' '); }
    return undefined;
  });
  ext.register_slot_item('assistant.extras', { id: 'fp20_examples', order: ORDERS.examples, render: render_examples_card });
  ext.register_slot_item('assistant.extras', { id: 'fp20_calls', order: ORDERS.calls, render: (c) => render_calls_card(c, view) });
  return { view };
}
