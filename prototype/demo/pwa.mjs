// pwa.mjs — регистрация сервис-воркера оболочки (FP-12, REQ-117, REQ-120, решение владельца № 4, предварительное).
// Правила: воркер регистрируется ТОЛЬКО на localhost (в том числе 127.0.0.1, [::1], *.localhost) и на HTTPS; область — каталог demo/, строго внутри
// prototype/ (это `own_scope` из «Удалить все данные» FP-05: оттуда воркер снимается штатно, а чужие воркеры общего localhost не трогаются);
// свои кэши — только с префиксом `runway-shell-` (им управляет sw.js). Модуль не обращается к чужим регистрациям: только к своей, полученной от `register`.
// Обновление без тихой подмены: новая версия ждёт (`state.update_ready`), применяется кнопкой «Обновить» (`apply_update`), после чего страница
// перезагружается один раз; без нажатия страница не перезагружается и версию не меняет. Проверка обновления (`check_update`) — запрос
// браузера на собственный хост к sw.js и манифесту хэшей, других сетевых обращений у модуля нет.
// Порты (`navigator`, `location`, `reload`, `message_channel`, `set_timeout`) внедряются: в Node модуль работает без браузера и сообщает «не поддерживается».
// Расчёт по введённым данным и правилам, не консультация.

/** Файл воркера рядом с модулем. */
export const SW_FILE = 'sw.js';
/** Сообщения страницы воркеру (контракт — sw.js). */
export const MSG_SKIP = 'runway-skip-waiting';
export const MSG_STATUS = 'runway-status';
/** Сколько ждать ответа воркера на запрос состояния, мс. */
export const STATUS_TIMEOUT_MS = 3000;
/** Сколько «Проверить обновление» ждёт, пока найденная версия установится (скачивание всей оболочки), мс; дальше состояние обновится само. */
export const SETTLE_TIMEOUT_MS = 30000;

/** Причины, по которым воркер не регистрируется. */
export const UNSUPPORTED = Object.freeze(['insecure_origin', 'no_service_worker', 'bad_scope']);

/**
 * Безопасный источник для воркера: HTTPS либо петля localhost. Всё остальное (http по адресу в сети, file:) — нет.
 * @param {{protocol?: string, hostname?: string}|null|undefined} loc
 * @returns {boolean}
 */
export function is_secure_origin(loc) {
  if (loc === null || loc === undefined) return false;
  if (loc.protocol === 'https:') return true;
  if (loc.protocol !== 'http:') return false;
  const host = String(loc.hostname ?? '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host.endsWith('.localhost');
}

/**
 * Область воркера внутри своего каталога? (то же условие `startsWith`, по которому «Удалить все данные» признаёт воркер своим)
 * @param {string} scope адрес области
 * @param {string} own_scope адрес каталога prototype/
 */
export function scope_is_own(scope, own_scope) {
  return typeof scope === 'string' && typeof own_scope === 'string' && own_scope !== '' && scope.startsWith(own_scope);
}

/**
 * Контроллер PWA.
 * @param {{navigator?: object|null, location?: object|null, base_url?: string, own_scope?: string, reload?: () => void,
 *   message_channel?: () => MessageChannel, set_timeout?: (fn: () => void, ms: number) => any, clear_timeout?: (id: any) => void}} [env]
 */
export function create_pwa(env = {}) {
  const nav = env.navigator !== undefined ? env.navigator : (globalThis.navigator ?? null);
  const loc = env.location !== undefined ? env.location : (globalThis.location ?? null);
  const base = env.base_url ?? import.meta.url;
  const sw_url = new URL(SW_FILE, base).href;
  const scope = new URL('./', base).href;
  const own_scope = env.own_scope ?? new URL('../', base).href;
  const reload = env.reload ?? (() => globalThis.location.reload());
  const new_channel = env.message_channel ?? (() => new MessageChannel());
  const set_timeout = env.set_timeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clear_timeout = env.clear_timeout ?? ((id) => clearTimeout(id));

  /** Состояние для экрана «О программе». */
  const state = {
    status: 'idle', // idle | unsupported | registering | active | update_ready | error
    reason: null, // код причины (unsupported/error): только имена и коды, текста пользователя нет
    build: null, // хэш сборки активного воркера (от него самого)
    cached: null,
    total: null,
    installing: false, // найденная версия воркера сейчас устанавливается (скачивается и проверяется оболочка)
    sw_url, scope,
  };
  const listeners = new Set();
  let registration = null;
  let reload_wanted = false;
  let reloaded = false;
  let started = false;

  const emit = () => { for (const fn of [...listeners]) { try { fn({ ...state }); } catch { /* подписчик не должен ломать контроллер */ } } };
  const set = (patch) => { Object.assign(state, patch); emit(); };

  /** Спросить у воркера состояние кэша (сообщение через MessageChannel); без ответа за `STATUS_TIMEOUT_MS` — `null`. */
  function ask_status(worker) {
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      const finish = (v) => { if (done) return; done = true; if (timer !== null) clear_timeout(timer); resolve(v); };
      try {
        const ch = new_channel();
        ch.port1.onmessage = (ev) => finish(ev?.data?.type === MSG_STATUS ? ev.data : null);
        timer = set_timeout(() => finish(null), STATUS_TIMEOUT_MS);
        worker.postMessage({ type: MSG_STATUS }, [ch.port2]);
      } catch { finish(null); }
    });
  }

  async function refresh_status() {
    const worker = registration?.active ?? nav?.serviceWorker?.controller ?? null;
    if (worker === null) return null;
    const s = await ask_status(worker);
    if (s !== null && Number.isSafeInteger(s.cached) && Number.isSafeInteger(s.total) && typeof s.build === 'string') set({ build: s.build, cached: s.cached, total: s.total });
    return s;
  }

  /** Новая версия ждёт, если есть ожидающий воркер и страница уже управляется прежним. */
  function sync_waiting() {
    if (registration?.waiting && nav?.serviceWorker?.controller) set({ status: 'update_ready' });
    else if (state.status === 'update_ready') set({ status: 'active' });
  }

  /** Следить за установкой воркера: «установлен» → предложить обновление (если есть прежний), «активирован» → узнать, сколько файлов в кэше, «отброшен» → установка не прошла. */
  function watch_worker(w) {
    if (w !== null && w !== undefined && w.state !== 'installed' && w.state !== 'redundant' && w.state !== 'activated' && w.state !== 'activating') set({ installing: true });
    w?.addEventListener?.('statechange', () => {
      if (w.state === 'installed') { set({ installing: false }); sync_waiting(); }
      else if (w.state === 'activated') { set({ installing: false }); refresh_status().catch(() => { /* состояние кэша необязательно */ }); }
      else if (w.state === 'redundant') {
        // первая установка не прошла: офлайн-копии нет; обновление не прошло: прежняя версия работает
        set({ installing: false });
        if (nav?.serviceWorker?.controller || registration?.active) { if (state.status !== 'update_ready') set({ reason: 'install_failed' }); } else set({ status: 'error', reason: 'install_failed' });
      }
    });
  }

  function watch(reg) {
    // новая попытка установки: прежняя причина отказа устарела
    reg.addEventListener?.('updatefound', () => { if (state.reason === 'install_failed') set({ reason: null }); watch_worker(reg.installing); });
    watch_worker(reg.installing); // первая установка идёт уже сейчас
  }

  /** Дождаться, пока устанавливаемый воркер перестанет устанавливаться (установлен, отброшен или активирован) либо истечёт `SETTLE_TIMEOUT_MS`. */
  function wait_settled(w) {
    return new Promise((resolve) => {
      const done_state = (s) => s === 'installed' || s === 'redundant' || s === 'activated' || s === 'activating';
      if (w === null || w === undefined || done_state(w.state) || typeof w.addEventListener !== 'function') { resolve(); return; }
      let timer = null;
      const finish = () => { if (timer !== null) clear_timeout(timer); resolve(); };
      w.addEventListener('statechange', () => { if (done_state(w.state)) finish(); });
      timer = set_timeout(finish, SETTLE_TIMEOUT_MS);
    });
  }

  /** Зарегистрировать воркер (один раз за загрузку страницы). Никогда не бросает исключение. */
  async function start() {
    if (started) return { ...state };
    started = true;
    if (!is_secure_origin(loc)) { set({ status: 'unsupported', reason: 'insecure_origin' }); return { ...state }; }
    if (nav === null || nav === undefined || nav.serviceWorker === undefined || nav.serviceWorker === null || typeof nav.serviceWorker.register !== 'function') {
      set({ status: 'unsupported', reason: 'no_service_worker' });
      return { ...state };
    }
    if (!scope_is_own(scope, own_scope)) { set({ status: 'unsupported', reason: 'bad_scope' }); return { ...state }; }
    set({ status: 'registering', reason: null });
    try {
      registration = await nav.serviceWorker.register(sw_url, { scope, type: 'classic', updateViaCache: 'none' });
    } catch (e) {
      set({ status: 'error', reason: typeof e?.name === 'string' && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : 'register_failed' });
      return { ...state };
    }
    watch(registration);
    nav.serviceWorker.addEventListener?.('controllerchange', () => {
      if (reload_wanted && !reloaded) { reloaded = true; try { reload(); } catch { /* перезагрузка вручную */ } }
    });
    set({ status: 'active' });
    sync_waiting();
    refresh_status().catch(() => { /* состояние кэша необязательно */ }); // не ждём: ответ воркера может задержаться до STATUS_TIMEOUT_MS
    return { ...state };
  }

  /**
   * Проверить обновление оболочки: браузер заново читает sw.js (и его манифест хэшей на своём хосте).
   * `registration.update()` завершается, когда новая версия НАЧАЛА устанавливаться, а не когда установилась: поэтому ответ ждёт конца установки
   * (не дольше `SETTLE_TIMEOUT_MS`); если не дождались, в состоянии остаётся `installing: true` и экран честно говорит «идёт установка».
   */
  async function check_update() {
    if (registration === null) return { ...state };
    try { await registration.update(); } catch { /* сеть недоступна: остаёмся на текущей версии */ }
    await wait_settled(registration.installing ?? null);
    sync_waiting();
    return { ...state };
  }

  /** Применить ожидающую версию (по нажатию кнопки). Страница перезагрузится один раз, когда новый воркер возьмёт управление. */
  function apply_update() {
    const w = registration?.waiting ?? null;
    if (w === null) return false;
    reload_wanted = true;
    try { w.postMessage({ type: MSG_SKIP }); } catch { reload_wanted = false; return false; }
    return true;
  }

  return {
    start, check_update, apply_update, refresh_status,
    snapshot: () => ({ ...state }),
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}
