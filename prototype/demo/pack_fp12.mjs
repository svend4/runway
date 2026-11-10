// pack_fp12.mjs — точка входа пакета FP-12: экран «О программе» (#about) и запуск сервис-воркера оболочки (PWA, офлайн-копия).
// Что подключается: экран «О программе» (версия движка, хэш сборки, число файлов оболочки, состояние офлайн-копии, «Проверить обновление» / «Обновить»,
// сведения о сети и лицензиях, проверка расчёта в фоне) и хук `boot`, который один раз регистрирует воркер (только localhost и HTTPS, область — каталог demo/
// внутри prototype/, см. pwa.mjs). Пакет не импортирует app.mjs и ничего не пишет в данные пользователя.
// Решение владельца № 4 (хостинг и PWA) — предварительное. Расчёт по введённым данным и правилам, не консультация.

import catalog from './i18n/about.mjs';
import { ABOUT_ORDER, make_deps, render_about } from './about.mjs';

/**
 * @param {object} ext реестр расширений (`ext.mjs`, версия для пакета)
 * @param {{pwa?: object, calc?: object, build?: object, now_ms?: () => number}} [env] только для тестов: загрузчик реестра второй аргумент не передаёт
 */
export function register(ext, env = {}) {
  const ctx = ext.ctx;
  // каталог принимается один раз на процесс: повторная загрузка пакета (тесты, перезапуск реестра) не должна падать
  if (ctx.tr('about.nav') === 'about.nav') ext.register_i18n('about', catalog);
  ext.ensure_css('css/about.css');
  const deps = make_deps(env);
  ext.register_view({ id: 'about', title_key: 'about.nav', order: ABOUT_ORDER, render: (c) => render_about(c, deps) });
  // состояние воркера меняется само (установка, обновление): экран «О программе» перерисовывается, остальные экраны — нет (ввод в формах не трогаем)
  deps.pwa.subscribe(() => { if (globalThis.location?.hash === '#about') { try { ctx.refresh(); } catch { /* перерисуется при следующем действии */ } } });
  ext.register_hook('boot', () => { void deps.pwa.start(); });
  return deps;
}
