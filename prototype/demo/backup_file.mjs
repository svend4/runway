// backup_file.mjs — автозапись копии журнала в выбранный пользователем файл (FP-19, REQ-097, IDEA-68, ADR-005 п.2).
// Два уровня:
//   1. `write_copy(handle, text, opts)` — запись текста в файл через `FileSystemFileHandle` (File System Access API) без потери прежнего содержимого:
//      проверка разрешения (`queryPermission`), чтение прежнего содержимого для отката, `createWritable({keepExistingData: false})` — браузер пишет во
//      временный файл и подменяет настоящий только при `close()`, поэтому сбой записи оставляет прежний файл нетронутым; затем проверка — файл читается обратно,
//      и круг должен сойтись (`read_journal_json` → `state_hash` равен хэшу копии). Не сошёлся — прежнее содержимое возвращается, а запись считается неудачной.
//   2. `create_file_backup(deps)` — контроллер: `pick_target()` (`showSaveFilePicker`), запоминание ссылки в IndexedDB (`store_idb.create_handle_store`, ключ
//      `runway.file_target`), запись после каждых N новых записей журнала или по таймеру (порты времени и таймеров внедряются — тесты без реального времени),
//      откат на ручную выгрузку при отсутствии API, отозванном разрешении и сбое записи (фаза контроллера, баннер — `backup.backup_banner`), снятие ссылки при
//      «Удалить все данные» (`erase_port()`). Дополнения после проверки: предел ожидания ответа файла на каждую операцию (порт таймеров; зависший файл не держит очередь
//      и замок дольше предела), сверка ссылки с базой ссылок перед записью (файл, снятый или заменённый в другой вкладке, не пишется), приостановка автозаписи
//      (`hold()`: в файле лежит копия заменённого журнала), тихая запись не перерисовывает страницу без изменения видимого состояния.
// Модуль не читает часы и браузерные объекты сам: API файлов, хранилище ссылок, таймеры, «сегодня», записи журнала и учёт копии приходят аргументами (порты).
// Поведение Safari и iOS не проверялось: там `showSaveFilePicker` нет, остаётся ручная выгрузка. Расчёт по введённым данным и правилам, не консультация.

import { export_journal_copy, hash_of_events } from './data_actions.mjs';
import { read_journal_json } from '../engine/io.mjs';
import { make_backup_record } from './backup.mjs';
import { FILE_TARGET_KEY } from './store_idb.mjs';

/**
 * Пороги автозаписи (гипотезы прототипа, не параметры словаря): число новых записей журнала для немедленной записи, срок в мс для записи по таймеру и предел
 * ожидания ответа файла на одну операцию (`op_ms`: файл на недоступном сетевом диске или облачной заглушке может не отвечать вовсе).
 * Меняются аргументами `deps.every_events` / `deps.every_ms` / `deps.op_ms`; в `vocab.json` не входят (канон не расширяется).
 */
export const AUTO_DEFAULTS = Object.freeze({ every_events: 10, every_ms: 300000, op_ms: 20000 });

/** Идентификатор выбора файла: браузер сам запоминает каталог последнего выбора под этим именем. */
export const PICKER_ID = 'runway-backup';
/** Имя файла по умолчанию, если приложение не подсказало своё. */
export const DEFAULT_FILE_NAME = 'runway-journal.json';
/** Сколько байт прежнего содержимого файла читается для отката (больше — откат не готовится, запись всё равно атомарна). */
export const MAX_PREV_BYTES = 8 * 1024 * 1024;
/** Предел длины показываемого имени файла. */
export const NAME_MAX = 80;
/** Коды неудачи записи: каждому соответствует строка `backupfile.reason_<код>`; прочее показывается как `other`. */
export const FILE_CODES = Object.freeze(['permission', 'not_found', 'quota', 'aborted', 'verify', 'write', 'copy', 'bad_handle', 'target_changed']);
/** Фазы контроллера. */
export const FILE_PHASES = Object.freeze(['unsupported', 'none', 'ready', 'permission', 'failed', 'off']);

const pos_int = (x, fallback) => (Number.isSafeInteger(x) && x >= 1 ? x : fallback);
const utf8_length = (text) => new TextEncoder().encode(text).length;

/** Код неудачи по имени исключения браузера (текст исключения не копируется). */
export function classify_error(e) {
  const n = typeof e?.name === 'string' ? e.name : '';
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'permission';
  if (n === 'NotFoundError') return 'not_found';
  if (n === 'QuotaExceededError') return 'quota';
  if (n === 'AbortError') return 'aborted';
  return 'write';
}

/** Ссылка на файл годится для записи: файл (не каталог), есть `createWritable` и `getFile`. */
export function is_file_handle(h) {
  return h !== null && typeof h === 'object' && h.kind === 'file' && typeof h.createWritable === 'function' && typeof h.getFile === 'function';
}

/** Имя файла для показа: без управляющих знаков, не длиннее `NAME_MAX`; пусто — имя по умолчанию. В страницу попадает только через textContent. */
export function safe_name(h) {
  const raw = typeof h?.name === 'string' ? h.name : '';
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX);
  return clean === '' ? DEFAULT_FILE_NAME : clean;
}

/**
 * Разрешение на запись: `granted` | `prompt` | `denied`. `request: true` — спросить пользователя (`requestPermission`; браузер разрешает только из обработчика
 * нажатия). Нет `queryPermission` — считается, что разрешение есть (запись сама скажет об отказе).
 * @param {object} handle
 * @param {boolean} [request]
 */
export async function permission_of(handle, request = false) {
  const mode = { mode: 'readwrite' };
  let p;
  try { p = typeof handle.queryPermission === 'function' ? await handle.queryPermission(mode) : 'granted'; } catch { return 'denied'; }
  if (p === 'granted') return 'granted';
  if (request === true && typeof handle.requestPermission === 'function') {
    try { p = await handle.requestPermission(mode); } catch { return 'prompt'; }
  }
  return p === 'granted' ? 'granted' : p === 'denied' ? 'denied' : 'prompt';
}

/**
 * Проверка «круга» (REQ-097, REQ-094): прочитанный из файла текст разбирается как журнал, и `state_hash` его записей равен ожидаемому.
 * @param {string} expected_hash `state_hash` копии
 * @returns {(back: string) => boolean}
 */
export function verify_by_hash(expected_hash) {
  return (back) => {
    try { return hash_of_events(read_journal_json(back).events) === expected_hash; } catch { return false; }
  };
}

/**
 * Дождаться операции с файлом не дольше `o.op_ms` мс (таймер — порт `o.timers`). Файл на недоступном сетевом диске или облачной заглушке может не отвечать
 * вовсе, а запись держит очередь страницы и замок: без предела правки пользователя не доходили бы до хранилища. Нет таймеров или предела — ожидание без
 * ограничения (как прежде). По истечении — отказ `AbortError` с признаком `limit: true`; если операция всё же завершится позже, `late(результат)` убирает
 * последствия (закрывает писателя, чтобы файл не оставался занятым).
 */
function limited(o, op, late) {
  let p;
  try { p = Promise.resolve(op()); } catch (e) { p = Promise.reject(e); }
  const timers = o?.timers ?? null;
  const ms = o?.op_ms;
  if (timers === null || typeof timers.set !== 'function' || !(Number.isFinite(ms) && ms > 0)) return p;
  return new Promise((resolve, reject) => {
    let over = false;
    const id = timers.set(() => { over = true; reject(Object.assign(new Error('file_op_limit'), { name: 'AbortError', limit: true })); }, ms);
    p.then((v) => {
      if (over) { if (typeof late === 'function') { try { late(v); } catch { /* уже закрыта */ } } return; }
      try { timers.clear(id); } catch { /* таймер уже сработал */ }
      resolve(v);
    }, (e) => {
      if (over) return;
      try { timers.clear(id); } catch { /* таймер уже сработал */ }
      reject(e);
    });
  });
}
const is_limit = (e) => e !== null && typeof e === 'object' && e.limit === true;
/** Прервать писателя, не дожидаясь его: после истечения предела он мог и не ответить. */
const abort_quietly = (w) => { try { Promise.resolve(w.abort()).catch(() => {}); } catch { /* писатель уже закрыт */ } };

/** Вернуть в файл прежнее содержимое (откат после неудачной проверки). `true` — файл снова читается как до записи. */
async function put_back(handle, prev, o) {
  let w;
  try {
    w = await limited(o, () => handle.createWritable({ keepExistingData: false }), abort_quietly);
    await limited(o, () => w.write(prev));
    await limited(o, () => w.close());
    return (await limited(o, async () => (await handle.getFile()).text())) === prev;
  } catch (e) {
    if (w !== undefined) { if (is_limit(e)) abort_quietly(w); else { try { await w.abort(); } catch { /* запись уже закрыта */ } } }
    return false;
  }
}

/**
 * Записать текст копии в файл и проверить.
 * Порядок: разрешение → прежнее содержимое (для отката) → `createWritable({keepExistingData: false})`, запись и `close()` (браузер подменяет файл только при закрытии;
 * при сбое вызывается `abort()`, прежний файл остаётся) → чтение файла обратно и проверка (`opts.verify`, по умолчанию точное совпадение текста).
 * @param {object} handle `FileSystemFileHandle`
 * @param {string} text текст копии (`export_journal_copy().text`)
 * @param {{request?: boolean, verify?: (back: string) => boolean|Promise<boolean>, timers?: {set: Function, clear: Function}|null, op_ms?: number}} [opts]
 *   `request` — спросить разрешение (только из обработчика нажатия); `timers` и `op_ms` — предел ожидания ответа файла на каждую операцию (нет — без предела);
 *   по истечении запись прерывается (`abort`), итог — код `aborted`, прежний файл остаётся на месте
 * @returns {Promise<{ok: true, bytes: number} | {ok: false, code: string, restored: boolean|null, permission?: string}>}
 *   `code` — `permission | not_found | quota | aborted | verify | write | bad_handle`; `restored` — вернулось ли прежнее содержимое после неудачной проверки (`null` — откат не нужен или не готовился)
 */
export async function write_copy(handle, text, opts = {}) {
  if (!is_file_handle(handle) || typeof text !== 'string') return { ok: false, code: 'bad_handle', restored: null };
  const perm = await permission_of(handle, opts.request === true);
  if (perm !== 'granted') return { ok: false, code: 'permission', permission: perm, restored: null };

  let prev = null;
  try {
    const f = await limited(opts, () => handle.getFile());
    if (f.size === 0) prev = '';
    else if (Number.isFinite(f.size) && f.size <= MAX_PREV_BYTES) prev = await limited(opts, () => f.text());
  } catch (e) {
    if (is_limit(e)) return { ok: false, code: 'aborted', restored: null }; // файл не отвечает: писать в него незачем, прежнее содержимое не тронуто
    prev = null;
  }

  let w;
  try { w = await limited(opts, () => handle.createWritable({ keepExistingData: false }), abort_quietly); } catch (e) { return { ok: false, code: classify_error(e), restored: null }; }
  try {
    await limited(opts, () => w.write(text));
    await limited(opts, () => w.close());
  } catch (e) {
    if (is_limit(e)) abort_quietly(w); // писатель мог зависнуть вместе с файлом: не ждём его
    else { try { await w.abort(); } catch { /* уже закрыта или прервана: прежний файл остался на месте */ } }
    return { ok: false, code: classify_error(e), restored: null };
  }

  let same = false;
  try {
    const back = await limited(opts, async () => (await handle.getFile()).text());
    same = typeof opts.verify === 'function' ? (await opts.verify(back)) === true : back === text;
  } catch (e) {
    if (is_limit(e)) return { ok: false, code: 'aborted', restored: null }; // прочитать обратно не удалось: проверить нечем, содержимое файла неизвестно
    same = false;
  }
  if (same) return { ok: true, bytes: utf8_length(text) };
  return { ok: false, code: 'verify', restored: prev === null ? null : await put_back(handle, prev, opts) };
}

/** Порт API файлов браузера: `{showSaveFilePicker}` или `null` (нет в Firefox, Safari и iOS). Вызов идёт через `g`, чтобы не терять `this`. */
export function browser_file_api(g = globalThis) {
  try { if (typeof g.showSaveFilePicker === 'function') return { showSaveFilePicker: (o) => g.showSaveFilePicker(o) }; } catch { /* доступ запрещён */ }
  return null;
}

/** Таймеры страницы (порт): `set(fn, ms) → id`, `clear(id)`; таймер не удерживает процесс Node (`unref`). */
export function system_timers() {
  return {
    set: (fn, ms) => {
      const id = globalThis.setTimeout(fn, ms);
      if (typeof id === 'object' && id !== null && typeof id.unref === 'function') id.unref();
      return id;
    },
    clear: (id) => globalThis.clearTimeout(id),
  };
}

/**
 * Контроллер автозаписи.
 * @param {{
 *   api?: {showSaveFilePicker: Function}|null,
 *   handle_store?: {get: Function, put: Function, remove: Function, destroy: Function}|null,
 *   timers?: {set: Function, clear: Function}|null,
 *   today: () => string,
 *   state: () => {mode: string, read_only: boolean},
 *   get_events: () => Promise<{events: object[], ws?: any}>,
 *   record?: (record: object, ws?: any) => Promise<void>,
 *   run?: <T>(fn: () => Promise<T>) => Promise<T>,
 *   exclusive?: <T>(fn: () => Promise<T>) => Promise<T>,
 *   on_state?: () => void, logger?: {info?: Function, warn?: Function},
 *   suggested_name?: () => string, every_events?: number, every_ms?: number, op_ms?: number
 * }} deps
 *   `state()` — режим хранения (`fresh | active | found | paused | erased | failed | idle`) и «только чтение»: запись по таймеру и по числу правок идёт только в `active`;
 *   `run` — очередь записей страницы (запись в файл не пересекается с записью журнала); `exclusive` — замок «один писатель» между вкладками
 *   на время записи файла и проверки (две вкладки не подменяют файл одна другой посреди проверки); `timers` + `op_ms` — предел ожидания ответа файла на каждую операцию.
 *
 * Запись о файле в базе ссылок: `{v: 1, handle, held}` — `held`: автозапись приостановлена, потому что в файле лежит копия прежнего журнала, которую нельзя заменить без
 * решения пользователя. Пометка привязана к файлу, а не к метаданным журнала: выбор другого файла снимает её, и она переживает перезагрузку.
 */
export function create_file_backup(deps) {
  const api = deps.api ?? null;
  const supported = api !== null && typeof api.showSaveFilePicker === 'function';
  const handles = deps.handle_store ?? null;
  const timers = deps.timers ?? null;
  const every_events = pos_int(deps.every_events, AUTO_DEFAULTS.every_events);
  const every_ms = pos_int(deps.every_ms, AUTO_DEFAULTS.every_ms);
  const op_ms = pos_int(deps.op_ms, AUTO_DEFAULTS.op_ms);
  const run = typeof deps.run === 'function' ? deps.run : (fn) => fn();
  const exclusive = typeof deps.exclusive === 'function' ? deps.exclusive : (fn) => fn();
  const state = typeof deps.state === 'function' ? deps.state : () => ({ mode: 'active', read_only: false });
  const log_warn = (what, ctx) => { try { deps.logger?.warn?.(what, ctx); } catch { /* журнал не обязателен */ } };
  const log_info = (what, ctx) => { try { deps.logger?.info?.(what, ctx); } catch { /* журнал не обязателен */ } };
  const changed = () => { try { deps.on_state?.(); } catch { /* перерисовка не должна ломать запись */ } };

  const S = {
    phase: supported ? 'none' : 'unsupported', handle: null, name: '', remembered: false, permission: null, last_ok: null, last_error: null,
    written_count: -1, count: 0, timer: null, queued: false, busy: false, stopped: false, held: false,
  };

  const pending_of = () => (S.written_count < 0 ? S.count : Math.abs(S.count - S.written_count));
  const auto_allowed = () => { const st = state(); return st.read_only !== true && st.mode === 'active'; };
  /**
   * Что пользователь видит на экране (файл, фаза, ошибка, разрешение, приостановка). Тихая автозапись по таймеру или по числу правок перерисовывает страницу,
   * только если это изменилось: перерисовка пересоздаёт экран, и недозаполненная форма теряла бы ввод, а фокус падал бы на body (WCAG 2.4.3).
   * Строки «Последняя запись» и «Ещё не записано» при тихой успешной записи обновляются со следующей перерисовкой.
   */
  const view_key = () => [S.handle !== null, S.name, S.phase, S.last_error, S.permission, S.remembered, S.held].join('|');
  /** Запись о файле для базы ссылок (см. описание выше). */
  const rec_of = () => ({ v: 1, handle: S.handle, held: S.held });
  /** Обновить пометки в базе ссылок; сбой не мешает записи (худший случай — лишняя перезапись файла после перезагрузки). */
  async function save_rec() {
    if (handles === null || S.handle === null || !S.remembered) return;
    try { await handles.put(FILE_TARGET_KEY, rec_of()); } catch { /* пометки остаются прежними */ }
  }
  /** Снять ссылку в памяти (не трогая базу ссылок): «Не использовать файл», а также файл, снятый в другой вкладке. */
  function drop_local() {
    disarm();
    S.handle = null;
    S.name = '';
    S.phase = supported ? 'none' : 'unsupported';
    S.remembered = false;
    S.permission = null;
    S.last_error = null;
    S.last_ok = null;
    S.written_count = -1;
    S.held = false;
  }

  const disarm = () => {
    if (S.timer === null) return;
    try { timers?.clear(S.timer); } catch { /* таймер уже сработал */ }
    S.timer = null;
  };
  const arm = () => {
    if (S.timer !== null || timers === null) return;
    S.timer = timers.set(() => { S.timer = null; trigger('timer'); }, every_ms);
  };
  /** Поставить запись в очередь страницы (не больше одной ожидающей). */
  function trigger(reason) {
    if (S.queued || S.stopped) return;
    S.queued = true;
    Promise.resolve().then(() => run(() => { S.queued = false; return write_now(reason); })).catch(() => { S.queued = false; });
  }

  /**
   * Сверить ссылку с базой ссылок перед записью: другая вкладка могла снять файл («Не использовать файл») или выбрать другой. Канал оповещения вкладок
   * об этом не знает, поэтому без сверки вкладка продолжала бы писать в файл, о котором другая сказала «остановлено».
   * `same` — писать в этот файл; `gone` — ссылку сняли (в этой вкладке она тоже снята); `switched` — выбран другой файл (вкладка перешла на него).
   */
  async function sync_target() {
    if (handles === null || S.handle === null || !S.remembered) return 'same';
    let rec;
    try { rec = await handles.get(FILE_TARGET_KEY); } catch { return 'same'; } // база ссылок недоступна: не гадаем
    if (S.stopped || S.handle === null) return 'gone';
    if (rec === null || rec === undefined) { drop_local(); return 'gone'; }
    if (rec.v !== 1 || !is_file_handle(rec.handle) || rec.handle === S.handle) return 'same';
    let same = false;
    try { same = typeof S.handle.isSameEntry === 'function' && (await S.handle.isSameEntry(rec.handle)) === true; } catch { same = false; }
    if (same) return 'same';
    S.handle = rec.handle;
    S.name = safe_name(rec.handle);
    S.written_count = -1; // в другой файл (выбранный в другой вкладке) из этой вкладки ещё не писали
    S.held = rec.held === true;
    S.last_ok = null;
    S.permission = await permission_of(S.handle, false);
    S.phase = S.permission === 'granted' ? 'ready' : 'permission';
    S.last_error = S.permission === 'granted' ? null : 'permission';
    return 'switched';
  }

  /**
   * Записать копию сейчас. Причины: `events | timer` (автозапись, только в режиме `active`), `pick | manual | permission` (по действию пользователя; режимы `fresh` и `active`).
   * Не бросает: итог — объект. Успех сбрасывает счётчики напоминания (запись о копии с `via: 'file'`).
   * При приостановке (`held`: в файле лежит копия прежнего журнала) писать можно только по явному `manual` или `pick`; прочие причины отвечают кодом `held`.
   * Тихая запись (`events | timer`) просит перерисовать страницу, только если изменилось то, что видно на экране (см. `view_key`).
   * @param {'events'|'timer'|'pick'|'manual'|'permission'} reason
   * @returns {Promise<{ok: true, count: number, hash: string, day: string, bytes: number} | {ok: false, code: string, restored?: boolean|null, mode?: string}>}
   */
  async function write_now(reason) {
    if (S.stopped) return { ok: false, code: 'erased' };
    if (S.handle === null) return { ok: false, code: 'no_target' };
    const st = state();
    if (st.read_only === true) return { ok: false, code: 'read_only' };
    const auto = reason === 'events' || reason === 'timer';
    if (st.mode !== 'active' && !(st.mode === 'fresh' && !auto)) return { ok: false, code: 'not_ready', mode: st.mode };
    if (S.phase === 'permission' && auto) return { ok: false, code: 'permission' };
    const releases_hold = reason === 'manual' || reason === 'pick';
    if (S.held && !releases_hold) return { ok: false, code: 'held' };
    const key0 = view_key();
    if (reason !== 'pick') {
      const t = await sync_target();
      if (t !== 'same' || S.handle === null || S.stopped) { // ссылку сняли в другой вкладке (или здесь, пока шла сверка): в файл не пишем
        if (!auto || view_key() !== key0) changed();
        afterwards();
        return { ok: false, code: 'target_changed' };
      }
    }
    disarm();
    S.busy = true;
    const handle = S.handle; // ссылку могут снять (кнопка «Не использовать файл», удаление данных) посреди записи: тогда состояние не трогаем
    try {
      let copy;
      let source;
      try {
        source = await deps.get_events();
        copy = export_journal_copy(source.events);
      } catch {
        return S.handle === handle ? fail('copy', null) : { ok: false, code: 'target_changed' };
      }
      if (S.handle !== handle) return { ok: false, code: 'target_changed' }; // пока собиралась копия, ссылку сняли: в файл уже не пишем
      let r;
      try { r = await exclusive(() => write_copy(handle, copy.text, { verify: verify_by_hash(copy.state_hash), timers, op_ms })); } catch (e) { r = { ok: false, code: classify_error(e), restored: null }; } // замок недоступен или запись упала неожиданно: итог — неудача с кодом, а не исключение
      if (S.handle !== handle) return { ok: false, code: 'target_changed' };
      if (!r.ok) return fail(r.code, r.restored ?? null, r.permission);
      const record = make_backup_record({ day: deps.today(), count: source.events.length, hash: copy.state_hash, via: 'file' });
      S.last_ok = record;
      S.phase = 'ready';
      S.permission = 'granted';
      S.last_error = null;
      S.written_count = source.events.length;
      S.count = source.events.length; // копия — это журнал на сейчас: иначе устаревший счёт (запись до первой правки) принял бы только что записанное за «ещё не записано» и запись шла бы по кругу
      if (releases_hold && S.held) { S.held = false; await save_rec(); } // явная запись заменила прежнее содержимое файла: приостановка снята и в базе ссылок
      try { await deps.record?.(record, source.ws); } catch { log_warn('file_copy_record_failed', { code: 'meta' }); }
      log_info('file_copy', { n: source.events.length }); // журнал приложения принимает только поля белого списка (id, n, ms, code, engine_version)
      return { ok: true, count: source.events.length, hash: copy.state_hash, day: record.day, bytes: r.bytes };
    } finally {
      S.busy = false;
      if (!auto || view_key() !== key0) changed();
      afterwards();
    }
  }

  /**
   * Неудача: фаза `permission` (нет разрешения) или `failed` (прочее); запись повторится по таймеру, ручная выгрузка остаётся.
   * Отказ браузера без сведений о состоянии разрешения — `prompt` («браузер ждёт разрешения»), а не `denied` («отозвано»): точное состояние неизвестно.
   */
  function fail(code, restored, permission) {
    S.last_error = code;
    if (code === 'permission') { S.phase = 'permission'; S.permission = permission ?? 'prompt'; } else S.phase = 'failed';
    log_warn('file_copy_failed', { code });
    return { ok: false, code, restored };
  }

  /** После записи: если за время записи накопились ещё правки — следующая запись по обычным правилам. */
  function afterwards() {
    if (S.handle === null || S.stopped || S.held || S.phase === 'permission') return;
    if (S.phase === 'failed') { if (auto_allowed()) arm(); return; }
    if (auto_allowed() && pending_of() > 0) { if (pending_of() >= every_events) trigger('events'); else arm(); }
  }

  const api_obj = {
    /** Сведения для экрана и баннера. */
    status() {
      return {
        supported, phase: S.phase, name: S.name, remembered: S.remembered, permission: S.permission, last_ok: S.last_ok, last_error: S.last_error,
        pending: S.handle === null ? 0 : pending_of(), every_events, every_ms, busy: S.busy, armed: S.timer !== null,
        // приостановка (в файле копия прежнего журнала), записывалось ли в этот файл и сколько записей журнала в нём было при последней записи
        held: S.held, written: S.written_count >= 0, written_count: S.written_count >= 0 ? S.written_count : null,
      };
    },

    /**
     * Запуск: вспомнить сохранённую ссылку на файл и разрешение на запись. `known_count` — число записей в последней копии-в-файл (из метаданных) или -1, если неизвестно;
     * `count` — число записей журнала сейчас. `known_count` относится к файлу, в который писали последним: при выборе другого файла среда выполнения снимает пометку
     * `via: 'file'` с записи о последней копии (`data_runtime.file_pick`), и после перезагрузки новый файл не считается актуальным по числу записей прежнего.
     * Нет API файлов — база ссылок не открывается вовсе.
     */
    async init(o = {}) {
      S.written_count = Number.isSafeInteger(o.known_count) ? o.known_count : -1;
      if (Number.isSafeInteger(o.count) && o.count >= 0) S.count = o.count; // число записей журнала сейчас: иначе «ещё не записано» считалось бы от нуля
      if (!supported || handles === null) return api_obj.status();
      let rec = null;
      try { rec = await handles.get(FILE_TARGET_KEY); } catch { rec = null; }
      if (rec !== null && rec !== undefined) {
        if (rec.v === 1 && is_file_handle(rec.handle)) {
          S.handle = rec.handle;
          S.name = safe_name(rec.handle);
          S.remembered = true;
          S.held = rec.held === true;
          const p = await permission_of(S.handle, false);
          S.permission = p;
          S.phase = p === 'granted' ? 'ready' : 'permission';
          S.last_error = p === 'granted' ? null : 'permission';
        } else {
          try { await handles.remove(FILE_TARGET_KEY); } catch { /* ссылка негодная: при следующем выборе заменится */ }
        }
      }
      changed();
      return api_obj.status();
    },

    /**
     * Выбрать файл (`showSaveFilePicker`) и запомнить ссылку. ВЫЗЫВАТЬ прямо из обработчика нажатия: выбор файла требует жеста пользователя, поэтому до
     * вызова браузера здесь нет ни одного `await`. Запись копии в новый файл — отдельный шаг (`write_now('pick')`).
     * @returns {Promise<{ok: true, name: string, remembered: boolean} | {ok: false, reason: string}>}
     */
    pick_target() {
      if (!supported) return Promise.resolve({ ok: false, reason: 'unsupported' });
      if (S.stopped) return Promise.resolve({ ok: false, reason: 'erased' });
      if (state().read_only === true) return Promise.resolve({ ok: false, reason: 'read_only' });
      let p;
      try {
        p = api.showSaveFilePicker({
          id: PICKER_ID,
          suggestedName: typeof deps.suggested_name === 'function' ? deps.suggested_name() : DEFAULT_FILE_NAME,
          types: [{ description: 'Runway journal (.json)', accept: { 'application/json': ['.json'] } }],
        });
      } catch (e) { p = Promise.reject(e); }
      return (async () => {
        let handle;
        try { handle = await p; } catch (e) { return { ok: false, reason: e?.name === 'AbortError' ? 'cancelled' : classify_error(e) === 'permission' ? 'permission' : 'picker_failed' }; }
        if (!is_file_handle(handle)) return { ok: false, reason: 'bad_handle' };
        if (S.stopped) return { ok: false, reason: 'erased' };
        disarm();
        S.handle = handle;
        S.name = safe_name(handle);
        S.phase = 'ready';
        S.permission = 'granted';
        S.last_error = null;
        S.last_ok = null;
        S.written_count = -1; // в новый файл ещё ничего не записано
        S.held = false; // новый файл не хранит прежний журнал: приостановка не нужна
        S.remembered = false;
        if (handles !== null) {
          try { await handles.put(FILE_TARGET_KEY, rec_of()); S.remembered = true; } catch { S.remembered = false; }
        }
        changed();
        return { ok: true, name: S.name, remembered: S.remembered };
      })();
    },

    /**
     * Спросить разрешение на запись в запомненный файл. ВЫЗЫВАТЬ из обработчика нажатия. Выдано — фаза `ready`; нет — остаётся `permission`.
     * @returns {Promise<{ok: true} | {ok: false, reason: string, permission?: string}>}
     */
    async request_permission() {
      if (S.stopped) return { ok: false, reason: 'erased' };
      if (S.handle === null) return { ok: false, reason: 'no_target' };
      const p = await permission_of(S.handle, true);
      S.permission = p;
      if (p !== 'granted') { S.phase = 'permission'; S.last_error = 'permission'; changed(); return { ok: false, reason: 'permission', permission: p }; }
      S.phase = 'ready';
      S.last_error = null;
      changed();
      return { ok: true };
    },

    write_now,

    /**
     * Учесть изменение журнала (после каждой записи в хранилище): `count` — число записей. Набралось `every_events` новых записей — запись сразу
     * (в очереди страницы), меньше — таймер `every_ms`. `force: true` — журнал заменён целиком (восстановление): файл считается устаревшим.
     * При фазе `failed` повтор идёт только по таймеру (чтобы не повторять неудачную запись на каждой правке); при `permission` — не идёт вовсе.
     */
    note_change(count, o = {}) {
      if (Number.isSafeInteger(count) && count >= 0) S.count = count;
      if (o.force === true) S.written_count = -1;
      if (S.handle === null || S.stopped || S.held || S.phase === 'permission' || S.phase === 'none' || S.phase === 'unsupported') return;
      if (!auto_allowed()) return;
      const pending = pending_of();
      if (pending === 0) { disarm(); return; }
      if (S.phase === 'ready' && pending >= every_events) { disarm(); trigger('events'); return; }
      arm();
    },

    /**
     * Приостановить автозапись: в файле лежит копия журнала, который только что заменили («Начать с текущего набора», «Восстановить»), и автозапись стёрла бы
     * её молча. Пока приостановка не снята, файл пишется только по явному «Записать в файл сейчас» (`write_now('manual')`) или после выбора другого файла.
     * Приостановка запоминается вместе со ссылкой (переживает перезагрузку). Без выбранного файла ничего не делает.
     */
    async hold() {
      if (S.handle === null || S.stopped) return { ok: true, held: false };
      S.held = true;
      disarm();
      await save_rec();
      changed();
      return { ok: true, held: true };
    },

    /** Больше не использовать файл: ссылка снимается (из памяти и из базы ссылок), таймер останавливается. Сам файл остаётся у пользователя. */
    async forget() {
      const had = S.handle !== null;
      drop_local();
      if (handles !== null) { try { await handles.remove(FILE_TARGET_KEY); } catch { /* база ссылок недоступна: в памяти ссылка уже снята */ } }
      changed();
      return { ok: true, had };
    },

    /** Остановить контроллер навсегда (удаление всех данных): таймер снят, ссылка забыта, дальнейшие записи отклоняются. */
    stop() {
      S.stopped = true;
      disarm();
      S.handle = null;
      S.name = '';
      S.phase = 'off';
      S.remembered = false;
    },

    /** Порт для `data_actions.erase_all` (`ports.file_target`): остановить контроллер и снять базу ссылок; `removed` — 1, если ссылка была. */
    erase_port() {
      return {
        destroy: async () => {
          const had = S.handle !== null;
          api_obj.stop();
          let removed = 0;
          if (handles !== null) removed = (await handles.destroy()).removed;
          return { removed: Math.max(removed, had ? 1 : 0) };
        },
      };
    },
  };
  return api_obj;
}
