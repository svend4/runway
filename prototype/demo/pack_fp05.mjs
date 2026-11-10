// pack_fp05.mjs — точка входа пакета FP-05: хранение (IndexedDB → localStorage → память), «Продолжить с сохранённого», файл-копия и напоминание о ней,
// экспорт JSON/CSV/hledger, «Восстановить», отчёт «где что лежит», удаление всех данных с квитанцией.
// Подключается реестром (`ext_manifest.mjs` → `register(ext)`); `app.mjs` пакет не знает. Хранилище открывается в хуке `boot` (после загрузки набора данных),
// правки рабочей области подхватываются подпиской `ctx.subscribe`. Блоки встают в слоты `overview.cards` и `data.sections`.
// Расчёт по введённым данным и правилам, не консультация.

import catalog from './i18n/data.mjs';
import { create_runtime } from './data_runtime.mjs';
import { create_lock, create_sync_channel } from './store.mjs';
import { pick_store, create_handle_store, HANDLE_DB_NAME } from './store_idb.mjs';
import { browser_file_api, system_timers } from './backup_file.mjs';
import backup_file_catalog from './i18n/backupfile.mjs';
import { system_ports, make_id_gen, clock_ports, local_today } from './ids.mjs';
import { ports_from_gen } from './journal_log.mjs';
import { render_continue_card, render_backup_banner, render_storage_section, render_rights_section, render_erase_section } from './data_view.mjs';
import { log } from './log.mjs';
import { create_tracker } from './dataset_label.mjs';
import dslabel_catalog from './i18n/dslabel.mjs';

/** Прочитать браузерный объект с защитой от исключений (в приватных режимах и в Node обращение может бросить исключение). */
function global_of(name) {
  try { return globalThis[name] ?? null; } catch { return null; }
}

/** Страница установлена как приложение (`display-mode: standalone`)? `null` — не узнать. */
function installed_state() {
  try {
    if (typeof globalThis.matchMedia === 'function') return globalThis.matchMedia('(display-mode: standalone)').matches === true || globalThis.navigator?.standalone === true;
  } catch { /* ответа нет */ }
  return null;
}

/** Собрать порты браузера для среды выполнения. В тестах подменяются аргументом `env`. */
export function browser_env() {
  const local = global_of('localStorage');
  let ls = null;
  try { if (local !== null && typeof local.getItem === 'function') ls = local; } catch { ls = null; }
  return {
    indexedDB: global_of('indexedDB'), IDBKeyRange: global_of('IDBKeyRange'), localStorage: ls, sessionStorage: global_of('sessionStorage'),
    caches: global_of('caches'), navigator: global_of('navigator'),
    // автозапись в выбранный файл (FP-19): `showSaveFilePicker` есть в Chrome и Edge; в Firefox, Safari и iOS — нет (там `null`, остаётся ручная выгрузка)
    file_api: browser_file_api(),
  };
}

/**
 * Создать среду выполнения пакета для `ctx` (асинхронно: выбор хранилища).
 * @param {object} ctx контекст реестра
 * @param {object} [env] браузерные объекты (по умолчанию — настоящие); `file_api`, `file_timers`, `file_every_events`, `file_every_ms`, `file_op_ms`, `handle_db` — порты автозаписи в файл-копию (FP-19)
 */
export async function make_runtime(ctx, env = browser_env()) {
  const ports = system_ports();
  const gen = make_id_gen(ports);
  const picked = await pick_store(env);
  const nav = env.navigator;
  const channel = create_sync_channel({ tab_id: ctx.new_id('tab') });
  let queued = false;
  const refresh = () => {
    if (queued) return;
    queued = true;
    // перерисовка без записи и без рассылки подписчикам: `ctx.refresh()` (хост ext.mjs → render); без страницы (Node) — пустой вызов
    queueMicrotask(() => {
      queued = false;
      try { ctx.refresh(); } catch { /* перерисуется при следующем действии */ }
    });
  };
  return create_runtime({
    store: picked.store, store_kind: picked.kind, lock: create_lock(), channel, storage_manager: nav?.storage ?? null, installed: installed_state,
    // «сегодня» для напоминания о копии и квитанции об удалении — по местному времени (возле полуночи UTC-дата отстаёт на день)
    today: () => local_today({ now_ms: ports.now_ms, tz_offset_min: clock_ports().tz_offset_min }), ports: ports_from_gen(gen),
    get_ws: ctx.get_ws, set_ws: ctx.set_ws, adopt: ctx.adopt, refresh, logger: log, read_only: typeof ctx.read_only === 'function' ? ctx.read_only : undefined,
    // автозапись в файл-копию (FP-19, REQ-097): ссылка на файл живёт в отдельной базе `runway-handles` (не в метаданных журнала: она не JSON); база ссылок открывается, только если в браузере есть выбор файла
    file: {
      api: env.file_api ?? null, timers: env.file_timers ?? system_timers(), every_events: env.file_every_events, every_ms: env.file_every_ms, op_ms: env.file_op_ms,
      // запись файла идёт под своим замком (не под замком журнала): зависший файл не должен останавливать запись правок в хранилище других вкладок
      lock: create_lock({ name: 'runway-file-writer' }),
      handle_store: env.indexedDB === null || env.indexedDB === undefined ? null : create_handle_store({ indexedDB: env.indexedDB, name: env.handle_db ?? HANDLE_DB_NAME }),
    },
    // own_scope — область сервис-воркеров приложения (каталог prototype/): чужие воркеры и кэши источника не удаляются
    erase_ports: { storage: env.localStorage, session_storage: env.sessionStorage, caches: env.caches, service_worker: nav?.serviceWorker ?? null, own_scope: new URL('../', import.meta.url).href },
  });
}

/** @param {object} ext реестр расширений (`ext.mjs`, версия для пакета) */
export function register(ext) {
  ext.register_i18n('data', catalog);
  if (ext.ctx.tr('backupfile.title') === 'backupfile.title') ext.register_i18n('backupfile', backup_file_catalog); // автозапись в файл-копию (FP-19)
  ext.ensure_css('css/data.css');
  const ctx = ext.ctx;
  const holder = { rt: null };
  const guard = (fn) => (c) => (holder.rt === null ? null : fn(c, holder.rt));

  ctx.subscribe((info) => { if (holder.rt !== null) holder.rt.on_change(info); });
  ext.register_hook('boot', async (c) => { holder.rt = await make_runtime(c); await holder.rt.init(); });

  // подпись источника данных в переключателе «Набор данных» (FP-48): после «Продолжить с сохранённого» и «Восстановить из файла» он больше не называет встроенный набор
  if (ext.ctx.tr('dslabel.device') === 'dslabel.device') ext.register_i18n('dslabel', dslabel_catalog);
  holder.origin = create_tracker();
  ctx.subscribe((info) => holder.origin.on_event(info));
  ext.register_hook('dataset_label', (c, dataset_id) => holder.origin.label(c.tr, c.get_ws(), dataset_id));

  ext.register_slot_item('overview.cards', { id: 'fp05_continue', order: 1, render: guard(render_continue_card) });
  ext.register_slot_item('overview.cards', { id: 'fp05_banner', order: 2, render: guard(render_backup_banner) });
  ext.register_slot_item('data.sections', { id: 'fp05_continue_d', order: 5, render: guard(render_continue_card) });
  ext.register_slot_item('data.sections', { id: 'fp05_banner_d', order: 6, render: guard(render_backup_banner) });
  ext.register_slot_item('data.sections', { id: 'fp05_storage', order: 10, render: guard(render_storage_section) });
  ext.register_slot_item('data.sections', { id: 'fp05_rights', order: 20, render: guard(render_rights_section) });
  ext.register_slot_item('data.sections', { id: 'fp05_erase', order: 30, render: guard(render_erase_section) });
  return holder;
}
