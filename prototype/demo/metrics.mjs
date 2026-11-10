// metrics.mjs — метрики на устройстве без слежки (FP-10, REQ-185, REQ-110, IDEA-54, IDEA-95; предварительное решение № 5 владельца).
//
// Что это. Счётчики хранятся ТОЛЬКО на этом устройстве (localStorage под ключом `runway-metrics/1`, префикс `runway`) и никуда не отправляются: у приложения нет
// ни одного сетевого вызова с метриками. Наружу они попадают одним способом — пользователь сам скачивает файл `runway-metrics/1` (JSON) и передаёт его, кому хочет.
// Файл показывается ЦЕЛИКОМ до скачивания: показывается ровно тот текст, который будет скачан (`package_text`).
//
// Что в файле. Только агрегаты и порядковые номера: число сеансов, номера дней использования (0 = первый день; это смещения, а не календарные даты),
// журнал шагов мастера (шаг, секунды, порядковый номер сеанса, исход), две отметки «первый прогноз» и «готов вердикт», счётчики действий из закрытого списка,
// ошибка минимума в базисных пунктах и покрытие «k из n». Сумм нет, календарных дат нет, идентификаторов пользователя, названий и заметок нет: схема строгая
// (`validate_package`), а сборка файла отвергает всё, что в неё не входит. Номер первого дня использования хранится рядом на устройстве (служебное поле
// `anchor_day`, чтобы считать дни между сеансами); в файл оно не попадает.
//
// Удаление. Ключ начинается с `runway`, поэтому его стирает штатное «Удалить все данные» (FP-05, `data_actions.erase_all` — префикс `LOCAL_PREFIX`); чужие ключи
// общего источника localhost не трогаются. После такого удаления модуль замечает, что ключ исчез, и до перезагрузки страницы ничего не пишет
// (иначе первый же щелчок воскресил бы только что удалённое).
//
// Модуль без DOM и без часов: хранилище, часы и номер дня приходят аргументами-портами, поэтому он проверяется в Node (tests/metrics.test.mjs).
// Расчёт по введённым данным и правилам, не консультация.

import { mul_div } from '../engine/index.mjs';

/** Формат пакета метрик. */
export const METRICS_FORMAT = 'runway-metrics/1';

/** Ключ localStorage (префикс `runway` — его стирает «Удалить все данные»). */
export const METRICS_KEY = 'runway-metrics/1';

/** Шаги мастера «Старт»: четыре шага и буфер. */
export const STEP_IDS = Object.freeze(['account', 'obligations', 'income', 'daily', 'buffer']);

/** Исход шага: записан или пропущен. */
export const STEP_OUTCOMES = Object.freeze(['saved', 'skipped']);

/** Закрытый список счётчиков действий (имена, а не данные). */
export const COUNTER_NAMES = Object.freeze(['accounts_saved', 'anchors_set', 'rules_saved', 'facts_added', 'scenarios_saved', 'imports_done', 'undo_used', 'wizard_opened']);

/** Соответствие «причина записи общего пути → счётчик» (`ctx.subscribe`, поле `reason`). */
export const COUNTER_BY_REASON = Object.freeze({
  upsert_account: 'accounts_saved',
  set_anchor: 'anchors_set',
  upsert_rule: 'rules_saved',
  add_fact: 'facts_added',
  post_income: 'facts_added',
  save_scenario: 'scenarios_saved',
  import: 'imports_done',
  undo: 'undo_used',
});

/** Пределы схемы. */
export const LIMITS = Object.freeze({
  sessions: 1_000_000, steps: 200, seconds: 3600, active_days: 400, day_offset: 3650, counter: 1_000_000_000, errors: 100, error_bp: 1_000_000, windows: 1_000_000,
});

const PACKAGE_KEYS = Object.freeze(['format', 'engine_version', 'sessions', 'active_days', 'steps', 'first_forecast', 'verdict_ready', 'counters', 'min_error_bp', 'coverage']);
const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const is_int = (x, lo, hi) => Number.isSafeInteger(x) && x >= lo && x <= hi;
const same_keys = (o, keys) => is_obj(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));

// ── схема пакета ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Пустое содержимое пакета. */
export function empty_package(engine_version) {
  return {
    format: METRICS_FORMAT, engine_version, sessions: 0, active_days: [], steps: [], first_forecast: null, verdict_ready: null,
    counters: {}, min_error_bp: { n: 0, values: [] }, coverage: { k: 0, n: 0 },
  };
}

/**
 * Проверка пакета `runway-metrics/1`: ровно перечисленные ключи, целые числа в границах, строки только из закрытых списков; ни сумм, ни календарных дат,
 * ни идентификаторов, ни произвольного текста. Не бросает.
 * @param {any} pkg
 * @returns {string[]} нарушения (пусто — пакет допустим)
 */
export function validate_package(pkg) {
  const e = [];
  if (!is_obj(pkg)) return ['not_object'];
  if (!same_keys(pkg, PACKAGE_KEYS)) {
    for (const k of Object.keys(pkg)) if (!PACKAGE_KEYS.includes(k)) e.push('unknown_key:' + String(k).slice(0, 30));
    for (const k of PACKAGE_KEYS) if (!Object.hasOwn(pkg, k)) e.push('missing_key:' + k);
    if (e.length > 0) return e;
  }
  if (pkg.format !== METRICS_FORMAT) e.push('format');
  if (typeof pkg.engine_version !== 'string' || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(pkg.engine_version)) e.push('engine_version');
  if (!is_int(pkg.sessions, 0, LIMITS.sessions)) e.push('sessions');
  if (!Array.isArray(pkg.active_days) || pkg.active_days.length > LIMITS.active_days) e.push('active_days');
  else {
    let prev = -1;
    for (const d of pkg.active_days) {
      if (!is_int(d, 0, LIMITS.day_offset) || d <= prev) { e.push('active_days_item'); break; }
      prev = d;
    }
  }
  if (!Array.isArray(pkg.steps) || pkg.steps.length > LIMITS.steps) e.push('steps');
  else {
    for (const s of pkg.steps) {
      if (!same_keys(s, ['step', 'seconds', 'session', 'outcome']) || !STEP_IDS.includes(s.step) || !STEP_OUTCOMES.includes(s.outcome)
        || !is_int(s.seconds, 0, LIMITS.seconds) || !is_int(s.session, 1, Math.max(pkg.sessions, 1))) { e.push('steps_item'); break; }
    }
  }
  const ff = pkg.first_forecast;
  if (ff !== null && !(same_keys(ff, ['after_seconds', 'session']) && (ff.after_seconds === null || is_int(ff.after_seconds, 0, LIMITS.seconds * LIMITS.steps)) && is_int(ff.session, 1, LIMITS.sessions))) e.push('first_forecast');
  const vr = pkg.verdict_ready;
  if (vr !== null && !(same_keys(vr, ['session']) && is_int(vr.session, 1, LIMITS.sessions))) e.push('verdict_ready');
  if (!is_obj(pkg.counters)) e.push('counters');
  else for (const [k, v] of Object.entries(pkg.counters)) if (!COUNTER_NAMES.includes(k) || !is_int(v, 0, LIMITS.counter)) { e.push('counters_item'); break; }
  const me = pkg.min_error_bp;
  if (!same_keys(me, ['n', 'values']) || !is_int(me.n, 0, LIMITS.windows) || !Array.isArray(me.values) || me.values.length > LIMITS.errors || me.values.length > me.n
    || me.values.some((v) => !is_int(v, -LIMITS.error_bp, LIMITS.error_bp))) e.push('min_error_bp');
  const cv = pkg.coverage;
  if (!same_keys(cv, ['k', 'n']) || !is_int(cv.n, 0, LIMITS.windows) || !is_int(cv.k, 0, LIMITS.windows) || cv.k > cv.n) e.push('coverage');
  // страховка поверх структуры: в тексте нет ничего, похожего на календарную дату или момент времени, и нет «больших» чисел (метки времени, суммы)
  const text = JSON.stringify(pkg);
  if (/\d{4}-\d{2}-\d{2}/.test(text) || /\d{1,2}[./]\d{1,2}[./]\d{4}/.test(text)) e.push('calendar_date');
  if (/\d{10,}/.test(text)) e.push('big_number');
  return e;
}

/** Ключи объекта по алфавиту рекурсивно (стабильный вид файла). */
function sorted(x) {
  if (Array.isArray(x)) return x.map(sorted);
  if (is_obj(x)) return Object.fromEntries(Object.keys(x).sort().map((k) => [k, sorted(x[k])]));
  return x;
}

/** Текст файла метрик: именно его показывает экран и именно он скачивается. Бросает, если пакет недопустим. */
export function package_text(pkg) {
  const errors = validate_package(pkg);
  if (errors.length > 0) throw new RangeError('метрики: пакет недопустим (' + errors[0] + ')');
  // верхний уровень — в порядке схемы (формат первым), вложенное — по алфавиту
  return JSON.stringify(Object.fromEntries(PACKAGE_KEYS.map((k) => [k, sorted(pkg[k])])), null, 2) + '\n';
}

/**
 * Ошибка минимума в базисных пунктах (C-055): `(факт − прогноз) / |прогноз|`, например прогноз 120000 и факт 109000 → −917 bp (−9,2 %).
 * Прогноз 0 или нецелые числа — `null` (ошибку не определить).
 * @param {number} forecast_minor
 * @param {number} actual_minor
 * @returns {number|null}
 */
export function min_error_bp(forecast_minor, actual_minor) {
  if (!Number.isSafeInteger(forecast_minor) || !Number.isSafeInteger(actual_minor) || forecast_minor === 0) return null;
  let bp;
  try { bp = mul_div(actual_minor - forecast_minor, 10000, Math.abs(forecast_minor), 'half_even'); } catch { return null; } // результат вне безопасных целых — ошибку не определить
  return Math.abs(bp) > LIMITS.error_bp ? null : bp;
}

// ── состояние на устройстве ───────────────────────────────────────────────────────────────────────────────────────────

function fresh_state(engine_version) {
  return { v: 1, enabled: true, anchor_day: null, ...empty_package(engine_version) };
}

/** Привести прочитанное из хранилища к допустимому состоянию; испорченное или чужое — `null` (начнём заново, ничего не показывая как метрики). */
function accept_state(raw, engine_version) {
  let x;
  try { x = JSON.parse(raw); } catch { return null; }
  if (!is_obj(x) || x.v !== 1 || typeof x.enabled !== 'boolean') return null;
  if (x.anchor_day !== null && !Number.isSafeInteger(x.anchor_day)) return null;
  const { v: _v, enabled: _e, anchor_day: _a, ...rest } = x;
  const pkg = { ...rest, engine_version };
  return validate_package(pkg).length === 0 ? { ...x, engine_version } : null;
}

/**
 * Создать модуль метрик.
 * @param {{storage?: {getItem: Function, setItem: Function, removeItem?: Function}|null, day?: () => number, engine_version: string}} deps
 *   `storage` — localStorage (или `null`: тогда метрики живут в памяти страницы); `day` — номер дня (epoch day) по часам устройства;
 *   `engine_version` — версия движка (`ENGINE_VERSION`)
 */
export function create_metrics(deps) {
  const storage = deps.storage ?? null;
  const day_of = typeof deps.day === 'function' ? deps.day : () => 0;
  const engine_version = deps.engine_version;
  let mem = null; // состояние в памяти, если хранилища нет
  let seen = false; // ключ уже был записан этой страницей
  let halted = false; // ключ исчез после записи: данные удалены, ждём перезагрузки

  const read_raw = () => { try { return storage === null ? undefined : storage.getItem(METRICS_KEY); } catch { return undefined; } };

  const load = () => {
    if (storage === null || read_raw() === undefined) { mem ??= fresh_state(engine_version); return mem; }
    const raw = read_raw();
    if (raw === null) {
      if (seen) { halted = true; return fresh_state(engine_version); }
      return fresh_state(engine_version);
    }
    return accept_state(raw, engine_version) ?? fresh_state(engine_version);
  };

  const save = (st) => {
    if (storage === null) { mem = st; return true; }
    try { storage.setItem(METRICS_KEY, JSON.stringify(st)); seen = true; return true; } catch { mem = st; return false; }
  };

  /** Изменить состояние: прочитать, применить `fn`, записать. Выключено, остановлено или нет места — молча ничего. */
  const mutate = (fn) => {
    const st = load();
    if (halted || st.enabled !== true) return false;
    fn(st);
    return save(st);
  };

  const session_now = (st) => Math.max(st.sessions, 1);

  const api = {
    /** Включены ли метрики (по умолчанию да: счёт идёт на устройстве). */
    enabled() { return load().enabled === true; },

    /** Включить или выключить счёт. Выключенный модуль ничего не записывает; уже собранное остаётся до `clear`. */
    set_enabled(on) {
      const st = load();
      if (halted) return false;
      st.enabled = on === true;
      return save(st);
    },

    /** Начало сеанса (загрузка страницы): +1 к числу сеансов и отметка дня использования. Возвращает номер сеанса или `null`. */
    begin_session() {
      let n = null;
      const ok = mutate((st) => {
        const today = day_of();
        if (st.anchor_day === null) st.anchor_day = today;
        st.sessions = Math.min(st.sessions + 1, LIMITS.sessions);
        const off = Math.min(Math.max(today - st.anchor_day, 0), LIMITS.day_offset);
        if (!st.active_days.includes(off) && st.active_days.length < LIMITS.active_days) st.active_days = [...st.active_days, off].sort((a, b) => a - b);
        n = st.sessions;
      });
      return ok ? n : null;
    },

    /** Журнал шага мастера: шаг, секунды, исход; номер сеанса ставит модуль. Лишнее отвергается (`false`). */
    record_step({ step, seconds, outcome }) {
      if (!STEP_IDS.includes(step) || !STEP_OUTCOMES.includes(outcome) || !Number.isFinite(seconds)) return false;
      const sec = Math.min(Math.max(Math.round(seconds), 0), LIMITS.seconds);
      return mutate((st) => {
        st.steps = [...st.steps, { step, seconds: sec, session: session_now(st), outcome }].slice(-LIMITS.steps);
      });
    },

    /** Счётчик действия из закрытого списка. */
    bump(name) {
      if (!COUNTER_NAMES.includes(name)) return false;
      return mutate((st) => { st.counters = { ...st.counters, [name]: Math.min((st.counters[name] ?? 0) + 1, LIMITS.counter) }; });
    },

    /** Счётчик по причине записи общего пути (`ctx.subscribe`): неизвестные причины игнорируются. */
    count_reason(reason) {
      return typeof reason === 'string' && Object.hasOwn(COUNTER_BY_REASON, reason) ? api.bump(COUNTER_BY_REASON[reason]) : false;
    },

    /** Первый прогноз (готовность `s ≥ 3` после правки пользователя): один раз; секунды — сумма журнала шагов мастера на этот момент или `null`. */
    mark_first_forecast() {
      let done = false;
      mutate((st) => {
        if (st.first_forecast !== null) return;
        const total = st.steps.reduce((a, s) => a + s.seconds, 0);
        st.first_forecast = { after_seconds: st.steps.length === 0 ? null : Math.min(total, LIMITS.seconds * LIMITS.steps), session: session_now(st) };
        done = true;
      });
      return done;
    },

    /** Вердикт Q3 стал доступен (гейт пройден после правки пользователя): один раз. */
    mark_verdict_ready() {
      let done = false;
      mutate((st) => { if (st.verdict_ready === null) { st.verdict_ready = { session: session_now(st) }; done = true; } });
      return done;
    },

    /** Ошибка минимума: окно сверки «прогноз против факта» → базисные пункты; возвращает значение или `null`, если ошибку не определить. */
    record_min_error(forecast_minor, actual_minor) {
      const bp = min_error_bp(forecast_minor, actual_minor);
      if (bp === null) return null;
      const ok = mutate((st) => {
        st.min_error_bp = { n: Math.min(st.min_error_bp.n + 1, LIMITS.windows), values: [...st.min_error_bp.values, bp].slice(-LIMITS.errors) };
      });
      return ok ? bp : null;
    },

    /** Покрытие коридора `plan`–`worse` «k из n»: факт попал в коридор или нет. */
    record_coverage(inside) {
      return mutate((st) => {
        const n = Math.min(st.coverage.n + 1, LIMITS.windows);
        st.coverage = { k: Math.min(st.coverage.k + (inside === true ? 1 : 0), n), n };
      });
    },

    /** Состояние метрик для экрана: пакет, включённость, остановка. */
    status() {
      const st = load();
      return { enabled: st.enabled === true, halted, persisted: storage !== null && !halted && seen, in_memory: storage === null };
    },

    /** Пакет `runway-metrics/1` по текущему состоянию (без служебных полей). */
    package() {
      const st = load();
      const { v: _v, enabled: _e, anchor_day: _a, ...pkg } = st;
      const errors = validate_package(pkg);
      if (errors.length > 0) throw new RangeError('метрики: пакет недопустим (' + errors[0] + ')');
      return pkg;
    },

    /** Текст файла метрик — тот, что показывается на экране и скачивается. */
    package_text() { return package_text(api.package()); },

    /**
     * Очистить собранное на устройстве: следующая запись начнёт с нуля. Отказ пользователя очистка НЕ отменяет: если счёт был выключен, он остаётся
     * выключенным — вместо стирания ключа пишется пустой пакет с `enabled: false` (без этого «выключить → очистить» молча включало бы счёт снова).
     * Включённый счёт очищается стиранием ключа, как прежде. «Удалить все данные» (FP-05) стирает ключ целиком, и выключатель возвращается в исходное
     * положение (счёт на устройстве включён) — так задумано, экран метрик об этом говорит.
     */
    clear() {
      const refused = !halted && load().enabled !== true; // отказ читается до стирания
      const blank = refused ? { ...fresh_state(engine_version), enabled: false } : null;
      mem = blank;
      if (storage === null) return true;
      try {
        if (blank !== null || typeof storage.removeItem !== 'function') {
          storage.setItem(METRICS_KEY, JSON.stringify(blank ?? fresh_state(engine_version)));
          seen = true;
        } else {
          storage.removeItem(METRICS_KEY);
          seen = false;
        }
        halted = false;
        return true;
      } catch { return false; }
    },
  };
  return api;
}

// ── экземпляр приложения (FP-22) ──────────────────────────────────────────────────────────────────────────────────────

let app_instance = null;

/**
 * Запомнить экземпляр метрик приложения (его создаёт пакет FP-10 при регистрации). Нужен пакетам, которым надо кормить те же метрики
 * (FP-22, `metrics_feed.mjs`): второй экземпляр над тем же ключом хранилища принял бы стирание ключа («Очистить метрики») за удаление всех данных
 * и остановился бы до перезагрузки. Модуль чистый: запоминается только ссылка, ничего не пишется.
 * @param {ReturnType<typeof create_metrics>|null} m
 */
export function set_app_metrics(m) { app_instance = m ?? null; }

/** Экземпляр метрик приложения или `null`, если пакет FP-10 не зарегистрирован. */
export function app_metrics() { return app_instance; }
