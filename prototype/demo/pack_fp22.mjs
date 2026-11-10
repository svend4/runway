// pack_fp22.mjs — точка входа пакета FP-22: метрики качества из окон прогноза, блок «Сообщить об ошибке», глобальные ошибки страницы в безопасный журнал, строки карантина записей.
// Что подключается:
//   - подписка `ctx.subscribe` и хук `boot`: окна прогноза закрываются сверкой остатка и кормят `metrics.record_min_error` / `record_coverage` (metrics_feed.mjs, REQ-185);
//     пакет runway-metrics/1 по-прежнему без сумм и дат; общий экземпляр метрик приложения берётся у пакета FP-10 (`metrics.app_metrics`);
//     встроенные демо-наборы ленту не кормят (признак — `dataset_id` события `adopt`), окно закрывает только согласованная с фактами сверка остатка;
//   - слот `data.sections`: блок «Сообщить об ошибке» (error_report_view.mjs, REQ-124): текст отчёта целиком, по согласию, копирование в буфер, отправки нет;
//   - глобальные ошибки страницы (`error`, `unhandledrejection`) → запись журнала приложения только с кодом, номером и версией движка (log.install_global_handlers);
//   - каталог строк открытия чужого файла с карантином записей (open_quarantine.mjs): сам разбор вызывает `app.import_file`, а строки и перечень отброшенного живут здесь.
// «Последний использованный счёт» в быстром вводе (entry_memory_store.mjs, REQ-090) подключён в пакете FP-04 (`pack_fp04.make_deps`).
// Пакет не импортирует app.mjs; запись метрик и состояния окон — только на этом устройстве (ключи с префиксом `runway`: их стирает «Удалить все данные»).
// Расчёт по введённым данным и правилам, не консультация.

import feed_catalog from './i18n/mfeed.mjs';
import report_catalog from './i18n/errrep.mjs';
import quarantine_catalog from './i18n/quarantine.mjs';
import { ENGINE_VERSION } from '../engine/index.mjs';
import { app_metrics } from './metrics.mjs';
import { create_feed, forecast_ready, WINDOW_DAYS } from './metrics_feed.mjs';
import { local_storage_or_null } from './entry_memory_store.mjs';
import { make_deps as make_report_deps, render_error_report } from './error_report_view.mjs';
import { install_global_handlers, log } from './log.mjs';

/** Место блока «Сообщить об ошибке» на экране «Данные»: после удаления всех данных (30). */
export const ERROR_REPORT_ORDER = 40;

/** Идентификатор набора из события `adopt` относится к встроенному демо-набору (не `custom` и не неизвестный): метрики пользователя демо не кормит. */
export function is_builtin_dataset(dataset_id) {
  return typeof dataset_id === 'string' && dataset_id !== '' && dataset_id !== 'custom';
}

/**
 * Сообщение о закрытии окна прогноза (одна строка пользователю): что записано в метрики. Числа форматирует `ctx.fmt().bp` (формат пользователя); без форматтера — «N bp».
 * @param {object} ctx
 * @param {{ok: true, error_bp: number|null, inside: boolean} | {ok: false, reason: string}} closed
 */
export function closed_text(ctx, closed) {
  if (closed.ok !== true) return ctx.tr('mfeed.failed', { code: closed.reason });
  const inside = ctx.tr(closed.inside ? 'mfeed.inside_yes' : 'mfeed.inside_no');
  if (closed.error_bp === null) return ctx.tr('mfeed.closed_no_error', { days: WINDOW_DAYS, inside });
  const f = ctx.fmt();
  const error = typeof f?.bp === 'function' ? f.bp(closed.error_bp) : closed.error_bp + ' bp';
  return ctx.tr('mfeed.closed', { days: WINDOW_DAYS, error, inside });
}

/**
 * @param {object} ext реестр расширений (`ext.mjs`, версия для пакета)
 * @param {{storage?: object|null, metrics?: object|null, logger?: object, errors?: object, target?: object|null}} [env] порты (в приложении не передаются; в тестах подменяются)
 */
export function register(ext, env = {}) {
  const ctx = ext.ctx;
  // каталоги принимаются один раз на процесс: повторная загрузка пакета (тесты, перезапуск реестра) не должна падать
  if (ctx.tr('mfeed.closed') === 'mfeed.closed') ext.register_i18n('mfeed', feed_catalog);
  if (ctx.tr('errrep.title') === 'errrep.title') ext.register_i18n('errrep', report_catalog);
  if (ctx.tr('quarantine.title') === 'quarantine.title') ext.register_i18n('quarantine', quarantine_catalog);
  ext.ensure_css('css/error_report.css');
  const logger = env.logger ?? log;

  // 1. окна прогноза → метрики
  const metrics = env.metrics === undefined ? app_metrics() : env.metrics;
  const feed = metrics === null ? null : create_feed({ storage: env.storage === undefined ? local_storage_or_null() : env.storage, metrics });
  // Встроенные демо-наборы (G-001 и остальные из `DATASETS`) ленту не кормят: иначе правка демо дала бы запись в метрики, неотличимую от данных пользователя.
  // Признак ставит событие `adopt` (`dataset_id` — идентификатор набора, `custom` — файл, мастер, восстановление); замена набора сохранёнными данными (`restore`) его снимает.
  let demo = false;
  const step = (ws) => {
    if (feed === null || demo || ws === null || ws === undefined || ctx.read_only() !== null) return null;
    const r = feed.step(ws, { ready: forecast_ready(ctx.get_model()) });
    if (r.closed !== null) {
      if (r.closed.ok !== true) { try { logger.warn('metrics_window_failed', { code: /^[A-Za-z][A-Za-z0-9_.:-]{0,31}$/.test(r.closed.reason) ? r.closed.reason : 'E_SCHEMA' }); } catch { /* журнал не обязателен */ } }
      ctx.notify(closed_text(ctx, r.closed), r.closed.ok === true ? 'info' : 'error');
    }
    return r;
  };
  ctx.subscribe((info) => {
    if (info.reason === 'adopt') demo = is_builtin_dataset(info.dataset_id);
    else if (info.reason === 'restore') demo = false;
    step(info.ws ?? ctx.get_ws());
  });
  ext.register_hook('boot', (c) => { step(c.get_ws()); }); // после перезагрузки окно уже могло дожить до сверки

  // 2. «Сообщить об ошибке»
  const er = make_report_deps({ logger, ...(env.errors ?? {}) });
  ext.register_slot_item('data.sections', { id: 'fp22_error_report', order: ERROR_REPORT_ORDER, render: (c) => render_error_report(c, er) });

  // 3. глобальные ошибки страницы → безопасная запись журнала
  const target = env.target === undefined ? (globalThis.window ?? globalThis) : env.target;
  const off = install_global_handlers(target, logger, { engine_version: ENGINE_VERSION });
  return { feed, er, off };
}
