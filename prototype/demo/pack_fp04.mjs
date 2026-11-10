// pack_fp04.mjs — точка входа пакета FP-04: быстрый ввод факта «+», сверка остатка одним числом, «Отменить / Вернуть», запрос о двойном вычитании.
// Подключается реестром (`ext_manifest.mjs` → `register(ext)`); `app.mjs` пакет не знает. Всё записывается только через общий путь `ctx.set_ws`
// (проверка `ws_edit` → пересчёт страницы → журнал → показ). Расчёт по введённым данным и правилам, не консультация.
//
// Что регистрируется:
//   - слот `nav.actions`: «+ Факт» (шторка ввода), «Сверить остаток», «Отменить» и «Вернуть»;
//   - слоты `overview.cards` и `reserves.sections`: карточка «перевод ждёт ответа» (REQ-063) — видна, только пока есть такие переводы;
//   - хук `boot`: журнал создаётся сразу после загрузки набора данных, чтобы правка и отмена попали в него;
//   - подписка на события записи: смена набора данных (`adopt`) и замена целиком (`restore`) очищают стопку отмены (`adopt` — ещё память счёта и отказы);
//     любое другое действие, записанное общим путём `ctx.set_ws` / `ctx.edit`, становится одной единицей «Отменить» (`auto_record`, этап S1.3):
//     формы данных, настройки, «Сегодня», сценарии, правки волн и т. д. Исключения и признак «уже записано» — в `undo.mjs`.

import catalog from './i18n/entry.mjs';
import { create_undo_stack, render_undo_buttons, unit_label, auto_record, UNDO_CLEAR_REASONS } from './undo.mjs';
import { create_decline_store, open_entry_dialog, render_nav_add, render_pending_card, money_text } from './entry.mjs';
import { open_anchor_dialog, render_nav_anchor } from './anchor_dialog.mjs';
import { create_persisted_entry_memory, local_storage_or_null } from './entry_memory_store.mjs'; // FP-22: последний счёт переживает перезагрузку (REQ-090)

/** Зависимости пакета (стопка отмены, память счёта, отказы): создаются на каждую регистрацию. Память счёта пишется на устройство (`runway-entry-memory/1`); без хранилища — память страницы. */
export function make_deps(ctx, storage = local_storage_or_null()) {
  return { undo: create_undo_stack(), memory: create_persisted_entry_memory(storage), declines: create_decline_store(ctx) };
}

/** Обработчик итога «Отменить / Вернуть»: сообщение пользователю и перерисовка, если стопка изменилась без записи. */
export function undo_done_handler(ctx) {
  const money = (minor, currency) => money_text(ctx.lang(), minor, currency, ctx.get_ws()?.as_of, ctx.get_ws()?.number_format); // сумма в формате чисел пользователя (REQ-112, FP-16)
  return (kind, r) => {
    if (r.ok) {
      ctx.notify(ctx.tr(kind === 'undo' ? 'entry.undone' : 'entry.redone', { what: unit_label(r.meta, ctx.tr, money) }), 'info');
      return;
    }
    ctx.notify(ctx.tr(r.error?.ctx?.reason === 'undo_conflict' ? 'entry.undo_conflict' : 'entry.undo_failed'), 'error');
    ctx.set_ws(ctx.get_ws(), { reason: 'undo_refresh' }); // единица снята со стопки без записи: кнопки перерисовываются
  };
}

export function register(ext) {
  const ctx = ext.ctx;
  ext.register_i18n('entry', catalog);
  ext.ensure_css('css/entry.css');
  const deps = make_deps(ctx);
  const money = (minor, currency) => money_text(ctx.lang(), minor, currency, ctx.get_ws()?.as_of, ctx.get_ws()?.number_format);
  const done = undo_done_handler(ctx);

  ctx.subscribe((info) => {
    if (info.reason === 'adopt') { deps.undo.clear(); deps.memory.forget(); deps.declines.clear(); }
    // «Продолжить с сохранённого», «Восстановить из файла», подтяжка записей другой вкладки заменяют набор целиком: прежние единицы отмены устарели
    else if (UNDO_CLEAR_REASONS.includes(info.reason)) deps.undo.clear();
    // любое другое действие, записанное общим путём `ctx.set_ws` / `ctx.edit`, — одна единица «Отменить» (кроме исключений и уже записанных FP-04)
    else auto_record(deps.undo, info);
  });
  ext.register_hook('boot', (c) => { void c.journal; });

  ext.register_slot_item('nav.actions', { id: 'entry_add', order: 10, render: (c) => render_nav_add(c, () => open_entry_dialog(c, deps)) });
  ext.register_slot_item('nav.actions', { id: 'entry_anchor', order: 20, render: (c) => render_nav_anchor(c, () => open_anchor_dialog(c, deps)) });
  ext.register_slot_item('nav.actions', { id: 'entry_undo', order: 30, render: (c) => render_undo_buttons(c, deps.undo, money, { on_done: done }) });
  ext.register_slot_item('banner.actions', { id: 'entry_anchor_banner', order: 10, render: (c) => render_nav_anchor(c, () => open_anchor_dialog(c, deps)) }); // сверка прямо в плашке «данные устарели»
  ext.register_slot_item('overview.cards', { id: 'entry_pending', order: 5, render: (c) => render_pending_card(c, deps) });
  ext.register_slot_item('reserves.sections', { id: 'entry_pending', order: 5, render: (c) => render_pending_card(c, deps) });
  return deps;
}
