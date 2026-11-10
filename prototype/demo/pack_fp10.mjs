// pack_fp10.mjs — точка входа пакета FP-10: мастер «Старт», метрики на устройстве, набор «с нуля» и шаблон-скелет.
// Что подключается: экран `#start` (wizard.mjs: четыре шага и буфер, прогноз при готовности s ≥ 3, журнал времени шагов), экран `#metrics` (metrics_view.mjs: файл
// `runway-metrics/1` целиком до скачивания), карточка «Старт» на «Обзоре» (пока данных мало для вердикта), подписка на запись для счётчиков и отметок
// «первый прогноз» / «вердикт доступен», хук `boot` (начало сеанса). Страница-калькулятор v0 (v0.html) — отдельная страница, к пакету не относится.
// Пакет не импортирует app.mjs; запись — только через общий путь `ctx.set_ws` (внутри `forms.commit_edits`). Данные метрик — localStorage под ключом `runway-metrics/1`
// (префикс `runway`: его стирает «Удалить все данные» FP-05; чужие ключи общего источника localhost не трогаются). Расчёт по введённым данным и правилам, не консультация.

import catalog from './i18n/start.mjs';
import { ENGINE_VERSION, to_epoch_day } from '../engine/index.mjs';
import { clock_ports, local_today } from './ids.mjs';
import { create_metrics, set_app_metrics } from './metrics.mjs';
import { make_wizard_deps, render_start, render_start_card, reset_wizard_ui, wizard_model } from './wizard.mjs';
import { render_metrics } from './metrics_view.mjs';

/**
 * Места экранов в навигации: после экранов приложения (10…80) и «Настроек» (85), как у всех пакетов; «Метрики» — после экранов FP-09. Входом для новичка служит карточка «Старт»
 * на «Обзоре» (слот `overview.cards`) и текст пустого «Обзора» (`ov.empty`), а не первое место в списке: порядок экранов приложения остаётся прежним.
 */
export const START_ORDER = 90;
export const METRICS_ORDER = 170;

/** localStorage или `null` (приватные режимы, запрет хранилища и Node: обращение может бросить исключение). */
function local_storage() {
  try {
    const s = globalThis.localStorage;
    return s !== null && s !== undefined && typeof s.getItem === 'function' && typeof s.setItem === 'function' ? s : null;
  } catch { return null; }
}

/**
 * Зависимости пакета на один контекст: метрики, состояние мастера, прежние отметки готовности.
 * @param {object} ctx
 * @param {{ports?: {now_ms: () => number, tz_offset_min: () => number}, storage?: object|null, metrics?: object}} [env] порты (в тестах подменяются)
 */
export function make_deps(ctx, env = {}) {
  const ports = env.ports ?? clock_ports();
  const metrics = env.metrics ?? create_metrics({
    storage: env.storage === undefined ? local_storage() : env.storage,
    day: () => to_epoch_day(local_today(ports)),
    engine_version: ENGINE_VERSION,
  });
  const deps = make_wizard_deps({ now_ms: ports.now_ms, metrics, on_saved: () => update_milestones(ctx, deps, true) });
  deps.metrics_ui = { confirm_clear: false };
  deps.prev = { ready: false, gate: false };
  deps.opened = false;
  return deps;
}

/**
 * Сверить готовность с прежней: переход «не готово → готово» после действия пользователя отмечается в метриках один раз
 * (первый прогноз — `s ≥ ready.q1`; вердикт доступен — гейт пройден). Набор данных, подставленный целиком, ничего не отмечает.
 */
export function update_milestones(ctx, deps, mark) {
  const model = ctx.get_model();
  if (model === null || model === undefined) return;
  const m = wizard_model(model);
  const gate_ok = m.verdict_gate === null && m.buffer.set;
  if (mark && m.forecast_visible && !deps.prev.ready) deps.metrics.mark_first_forecast();
  if (mark && gate_ok && !deps.prev.gate) deps.metrics.mark_verdict_ready();
  deps.prev = { ready: m.forecast_visible, gate: gate_ok };
}

/**
 * @param {object} ext реестр расширений (`ext.mjs`, версия для пакета)
 * @param {{ports?: object, storage?: object|null, metrics?: object}} [env] порты и хранилище метрик (в приложении не передаются; в тестах подменяются)
 */
export function register(ext, env = {}) {
  const ctx = ext.ctx;
  // каталог строк принимается один раз на процесс: повторная загрузка пакета (тесты, перезапуск реестра) не должна падать
  if (ctx.tr('start.nav') === 'start.nav') ext.register_i18n('start', catalog);
  ext.ensure_css('css/start.css');
  const deps = make_deps(ctx, env);
  set_app_metrics(deps.metrics); // тот же экземпляр кормит пакет FP-22 (окна прогноза → ошибка минимума и покрытие)

  ext.register_view({
    id: 'start', title_key: 'start.nav', order: START_ORDER,
    render: (c) => {
      if (!deps.opened) { deps.opened = true; deps.metrics.bump('wizard_opened'); }
      return render_start(c, deps);
    },
  });
  ext.register_view({ id: 'metrics', title_key: 'start.nav_metrics', order: METRICS_ORDER, render: (c) => render_metrics(c, deps) });
  ext.register_slot_item('overview.cards', { id: 'fp10_start', order: 50, render: render_start_card });

  ctx.subscribe((info) => {
    if (info.reason === 'adopt') { reset_wizard_ui(deps); update_milestones(ctx, deps, false); return; }
    if (info.reason === 'restore') { update_milestones(ctx, deps, false); return; }
    // «Отменить» / «Вернуть» меняют данные не через мастер: он встаёт на первый незасчитанный шаг (иначе остался бы на шаге, чей предшественник отменён)
    if (info.reason === 'undo' || info.reason === 'redo') { deps.ui.step = null; deps.ui.status = null; }
    deps.metrics.count_reason(info.reason);
    if (!deps.writing) update_milestones(ctx, deps, true); // шаги мастера отмечаются после записи журнала шага (`on_saved`)
  });
  ext.register_hook('boot', (c) => { deps.metrics.begin_session(); update_milestones(c, deps, false); });
  return deps;
}
