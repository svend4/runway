// data_runtime.mjs — сквозная логика хранения для страницы (FP-05): «Продолжить с сохранённого», запись правок в журнал хранилища под замком,
// файл-копия с учётом последней копии, восстановление из файла, удаление всех данных. Без DOM: всё приходит портами (хранилище, замок, канал,
// закрепление, «сегодня», доступ к рабочей области страницы), поэтому модуль проверяется в Node (tests/data_actions.test.mjs).
//
// Состояния (`status().mode`):
//   idle     — ещё не запущен (`init` не вызывался);
//   fresh    — хранилище пусто: первая же правка запишет набор данных и правку (до правки ничего не пишется);
//   found    — в хранилище есть журнал: страница спрашивает «продолжить с сохранённого?»; пока ответа нет, хранилище не трогается;
//   active   — журнал страницы ведётся в хранилище (каждая правка дописывается пачкой под замком «один писатель»);
//   paused   — запись остановлена (набор данных сменили, другая вкладка очистила хранилище): сохранённое не затирается молча;
//   erased   — данные удалены (`erase`): запись отключена до перезагрузки;
//   failed   — хранилище недоступно (в `error` — код, не текст браузера).
// Журнал хранилища — собственный (`open_persistent`), он следует за рабочей областью страницы по разности (`ws_bridge.diff_ws_to_specs`):
// рабочая область остаётся источником правды для расчёта, журнал — для сохранения и файла-копии. Расчёт по введённым данным и правилам, не консультация.

import { ENGINE_VERSION } from '../engine/index.mjs';
import { open_persistent, request_persistence } from './store.mjs';
import { events_to_ws, diff_ws_to_specs } from './ws_bridge.mjs';
import { backup_params, backup_due, backup_counters, backup_banner, make_backup_record, META_LAST_BACKUP, META_CREATED_DAY, META_ORIGIN_COUNT } from './backup.mjs';
import { rights_report } from './rights.mjs';
import { export_journal_copy, events_of_ws, hash_of_events, erase_preview, erase_all, counts_of_ws, file_name } from './data_actions.mjs';
import { create_file_backup } from './backup_file.mjs';
import { create_logger } from './log.mjs';

const code_of = (e) => (e !== null && typeof e === 'object' && typeof e.code === 'string' ? e.code.slice(0, 40) : 'failed');

/** Откуда пришли данные при восстановлении из файла (FP-48): переключатель «Набор данных» называет файл, а не встроенный набор. Имя — только короткая строка (его ставит экран «Данные»). */
const file_origin = (parsed) => ({ kind: 'file', name: typeof parsed?.file_name === 'string' ? parsed.file_name.slice(0, 80) : '' });

/**
 * @param {{store: object, store_kind: 'idb'|'local'|'memory', lock: object, channel?: object|null, storage_manager?: object|null,
 *   installed?: () => boolean|null, today: () => string, ports: {next_id: Function, recorded_at: Function},
 *   get_ws: () => object|null, set_ws: (ws: object, o?: object) => {ok: boolean}, adopt?: (ws: object, o?: object) => {ok: boolean}, refresh?: () => void, logger?: object,
 *   erase_ports?: object,
 *   file?: {api?: object|null, handle_store?: object|null, timers?: object|null, lock?: object|null, every_events?: number, every_ms?: number, op_ms?: number}|null}} deps
 *   `file` (FP-19, REQ-097) — порты автозаписи в выбранный файл-копию (см. `backup_file.mjs`); без него автозаписи нет и экран про неё молчит.
 *   `file.lock` — замок записи файла (нет — общий замок `lock`); `file.op_ms` с `file.timers` — предел ожидания ответа файла на операцию.
 */
export function create_runtime(deps) {
  const { store, lock } = deps;
  const channel = deps.channel ?? null;
  const logger = deps.logger ?? create_logger();
  const S = {
    mode: 'idle', error: null, persistence: { supported: false, persisted: null, requested: false }, head: null, meta: {}, pj: null, prev_ws: null,
    baseline_ws: null, baseline_count: 0, count: 0, pending_backup: null, pause_reason: null, foreign: false, write_failed: false, queue: Promise.resolve(),
    readonly: false,
  };
  // Режим «только чтение» (FP-17): истина — реестр расширений (`deps.read_only()`), а без него (тесты, Node) — признак, который ведут `open_readonly` и события `adopt`/`restore`.
  // Пока режим включён, сохранённое нельзя стирать «ради текущего набора» и нельзя выдавать копию журнала: просмотр записать нельзя, а в копии не хватало бы пропущенных записей.
  const in_readonly = () => (typeof deps.read_only === 'function' ? (deps.read_only() ?? null) !== null : S.readonly);
  const refuse_readonly = () => { const e = new Error('read_only'); e.code = 'read_only'; return e; };
  const ping = () => { try { deps.refresh?.(); } catch { /* перерисовка не должна ломать запись */ } };
  const enqueue = (task) => { const p = S.queue.then(task); S.queue = p.then(() => undefined, () => undefined); return p; };
  const fail_with = (e, where) => { S.error = code_of(e); logger.error(where, { code: S.error }); };

  const open_pj = async () => open_persistent({ store, lock, channel, ports: deps.ports, snapshot_every: 500 });
  const refresh_meta = async () => { try { S.meta = await store.get_meta(); } catch { /* метаданные — не данные */ } };
  const set_meta = (key, value) => lock.run(() => store.set_meta(key, value));

  /** Записи для копии: журнал хранилища (если ведётся), иначе детерминированные записи рабочей области. Общее для «Скачать журнал» и автозаписи в файл. */
  async function current_events() {
    const ws = deps.get_ws();
    let events;
    if (S.mode === 'active' && S.pj !== null) { try { await S.pj.refresh(); } catch { /* берём то, что есть */ } events = S.pj.journal.events(); } else events = events_of_ws(ws);
    return { events, ws };
  }

  /** Отметить копию как последнюю: в метаданных хранилища (если журнал ведётся) либо отложенно, до первой записи. Копия из файла-автозаписи отмечается так же, как скачанная. */
  async function note_copy(record, ws) {
    if (S.mode === 'active') {
      try { await set_meta(META_LAST_BACKUP, record); S.meta = { ...S.meta, [META_LAST_BACKUP]: record }; } catch (e) { fail_with(e, 'store_meta'); }
    } else S.pending_backup = { record, ws };
  }

  // автозапись в выбранный файл-копию (FP-19, REQ-097): порты приходят в `deps.file`; запись идёт через общую очередь страницы и отдельный замок записи файла
  const file = deps.file === undefined || deps.file === null ? null : create_file_backup({
    suggested_name: () => file_name('journal', deps.today()),
    ...deps.file,
    // замок записи файла — отдельный (`deps.file.lock`): зависший файл не должен держать замок «один писатель», под которым пишется журнал
    today: deps.today, logger, run: enqueue, exclusive: (fn) => (deps.file.lock ?? lock).run(fn), on_state: ping,
    state: () => ({ mode: S.mode, read_only: in_readonly() }), get_events: current_events, record: note_copy,
  });

  if (channel !== null) {
    channel.subscribe((m) => {
      if (m.type === 'appended') S.foreign = true;
      else if (S.mode === 'active' || S.mode === 'fresh') { S.mode = 'paused'; S.pause_reason = 'foreign_reset'; S.pj = null; }
      ping();
    });
  }

  const api = {
    /** Запуск: закрепление хранилища, чтение «головы» журнала; решает `fresh` или `found`. Не меняет рабочую область. */
    async init() {
      try { S.persistence = await request_persistence(deps.storage_manager ?? null); } catch { /* закрепление — улучшение, не условие */ }
      try {
        S.head = await store.stat();
        await refresh_meta();
      } catch (e) { S.mode = 'failed'; fail_with(e, 'store_open'); ping(); return api.status(); }
      S.baseline_ws = deps.get_ws();
      S.baseline_count = S.baseline_ws === null ? 0 : events_of_ws(S.baseline_ws).length;
      if (S.head.count > 0) { S.mode = 'found'; S.count = S.head.count; } else { S.mode = 'fresh'; S.count = S.baseline_count; }
      logger.info('store_open', { n: S.head.count });
      if (file !== null) {
        // ссылка на выбранный файл и разрешение на запись; число записей в последней копии-в-файл — из метаданных (нет — неизвестно, первая запись обновит файл)
        const lb = S.meta[META_LAST_BACKUP];
        try { await file.init({ known_count: lb?.via === 'file' && Number.isSafeInteger(lb.count) ? lb.count : -1, count: S.count }); } catch { /* автозапись — улучшение, не условие */ }
      }
      ping();
      return api.status();
    },

    /** Подписка на изменения рабочей области (`ctx.subscribe`): запись правок в хранилище. */
    on_change({ reason, ws, source }) {
      if (reason === 'adopt') S.readonly = source === 'readonly'; // признак ведётся сразу, а не по очереди: экран читает его между событиями
      else if (reason === 'restore') S.readonly = false;
      return enqueue(() => handle_change(reason, ws, source));
    },

    /** «Продолжить с сохранённого»: рабочая область из записей хранилища, журнал хранилища открыт, запись включена. */
    continue_saved() {
      return enqueue(async () => {
        if (S.mode !== 'found' && S.mode !== 'paused') return { ok: false, error: 'not_available' };
        try {
          const data = await store.load();
          if (data.events.length === 0) return { ok: false, error: 'empty' };
          const ws = events_to_ws(data.events);
          S.pj = await open_pj();
          S.prev_ws = ws;
          S.mode = 'active';
          S.pause_reason = null;
          S.count = S.pj.journal.length;
          S.foreign = false;
          await refresh_meta();
          const r = deps.set_ws(ws, { reason: 'restore' });
          if (r?.ok !== true) { S.mode = 'found'; S.pj = null; return { ok: false, error: r?.error?.code ?? 'E_SCHEMA' }; }
          S.readonly = false; // «Продолжить с сохранённого» снимает просмотр (FP-17)
          file?.note_change(S.count);
          return { ok: true, count: S.count };
        } catch (e) { fail_with(e, 'store_read'); return { ok: false, error: code_of(e) }; }
      });
    },

    /** «Начать с текущего набора»: сохранённое стирается (после подтверждения в интерфейсе); запись включится с первой правкой. */
    replace_saved() {
      return enqueue(async () => {
        if (in_readonly()) return { ok: false, error: 'read_only' }; // просмотр записать нельзя: сохранённый журнал не стирается ради него (FP-17)
        try {
          await lock.run(() => store.clear());
          if (channel !== null) channel.post('replaced', { count: 0, last_seq: 0 });
        } catch (e) { fail_with(e, 'store_clear'); return { ok: false, error: code_of(e) }; }
        S.pj = null; S.meta = {}; S.head = { count: 0, last_seq: 0, last_event_id: null };
        S.mode = 'fresh'; S.pause_reason = null; S.baseline_ws = deps.get_ws(); S.baseline_count = events_of_ws(S.baseline_ws).length; S.count = S.baseline_count; S.pending_backup = null;
        // в выбранном файле-копии лежит прежний журнал, который только что стёрт: автозапись не заменит его молча (до явного «Записать в файл сейчас»)
        if (file !== null) { try { await file.hold(); } catch { /* автозапись — улучшение, не условие */ } }
        ping();
        return { ok: true };
      });
    },

    /** Файл-копия: записи журнала хранилища (если ведётся) либо детерминированные записи рабочей области; учитывает «последнюю копию». */
    export_copy() {
      return enqueue(async () => {
        if (in_readonly()) throw refuse_readonly(); // копия из просмотра была бы неполной (без пропущенных записей) и выглядела бы как полноценная (FP-17)
        const { events, ws } = await current_events();
        const copy = export_journal_copy(events);
        const record = make_backup_record({ day: deps.today(), count: events.length, hash: copy.state_hash });
        await note_copy(record, ws);
        S.last_copy_hash = copy.state_hash;
        ping();
        return { ...copy, day: record.day };
      });
    },

    /**
     * Восстановить из разобранной копии (`inspect_import` → `kind: 'journal'`): хранилище заменяется записями файла (под замком), рабочая область страницы —
     * из них же. `state_hash` хранилища после этого равен `state_hash` файла. Для файла-рабочей области (`kind: 'workspace'`) хранилище не трогается:
     * страница читает его как прежде, запись начнётся с первой правки.
     */
    restore(parsed) {
      return enqueue(async () => {
        if (parsed?.ok !== true) return { ok: false, error: 'bad_file' };
        if (parsed.read_only === true) return { ok: false, error: 'read_only' }; // файл новее известного читается только для просмотра: хранилище им не заменяется
        if (parsed.kind === 'workspace') {
          S.baseline_ws = parsed.ws; S.baseline_count = events_of_ws(parsed.ws).length;
          const r = deps.set_ws(parsed.ws, { reason: 'restore', origin: file_origin(parsed) });
          if (r?.ok === true) S.readonly = false;
          return r?.ok === true ? { ok: true, kind: 'workspace' } : { ok: false, error: r?.error?.code ?? 'E_SCHEMA' };
        }
        if (parsed.events.length === 0) return { ok: false, error: 'empty' };
        const hash = hash_of_events(parsed.events);
        const record = make_backup_record({ day: deps.today(), count: parsed.events.length, hash });
        try {
          await lock.run(() => store.replace({
            events: parsed.events, snapshots: [], meta: { [META_CREATED_DAY]: deps.today(), [META_ORIGIN_COUNT]: parsed.events.length, [META_LAST_BACKUP]: record },
          }));
          if (channel !== null) channel.post('replaced', { count: parsed.events.length, last_seq: parsed.events[parsed.events.length - 1].seq });
          S.pj = await open_pj();
        } catch (e) { fail_with(e, 'store_replace'); return { ok: false, error: code_of(e) }; }
        S.prev_ws = parsed.ws; S.mode = 'active'; S.pause_reason = null; S.foreign = false; S.count = S.pj.journal.length; S.pending_backup = null;
        S.head = { count: S.count, last_seq: S.pj.journal.last_seq, last_event_id: null };
        await refresh_meta();
        const r = deps.set_ws(parsed.ws, { reason: 'restore', origin: file_origin(parsed) });
        if (r?.ok !== true) return { ok: false, error: r?.error?.code ?? 'E_SCHEMA' };
        S.readonly = false;
        // журнал заменён целиком: файл-копия устарела, но в ней может лежать единственная копия прежнего журнала — автозапись приостанавливается до явного «Записать в файл сейчас»
        if (file !== null) { try { await file.hold(); } catch { /* автозапись — улучшение, не условие */ } file.note_change(S.count, { force: true }); }
        return { ok: true, kind: 'journal', hash, count: S.count };
      });
    },

    /**
     * «Открыть только для просмотра» (FP-17, REQ-016): файл новее известного формата (или с записями новее известных) показывается на странице, но не пишется
     * ни в журнал хранилища, ни в метаданные; запись на время просмотра приостановлена (`paused`, причина `readonly`), сохранённое не затирается.
     * Правки на странице отключает реестр расширений (`ctx.read_only()`); выйти из режима можно, открыв набор данных или «Продолжить с сохранённого».
     */
    open_readonly(parsed) {
      return enqueue(async () => {
        if (parsed?.ok !== true || parsed.read_only !== true) return { ok: false, error: 'bad_file' };
        if (typeof parsed.read_only_info?.unusable === 'string') return { ok: false, error: 'unusable' }; // прогноз по читаемым записям не построить: открывать нечего
        if (typeof deps.adopt !== 'function') return { ok: false, error: 'not_available' };
        const r = deps.adopt(parsed.ws, { source: 'readonly', read_only: parsed.read_only_info, file_name: file_origin(parsed).name });
        if (r?.ok !== true) return { ok: false, error: r?.error?.code ?? 'E_SCHEMA' };
        S.readonly = true;
        logger.info('open_readonly', { n: parsed.events?.length ?? 0 });
        return { ok: true, count: parsed.events?.length ?? 0, skipped: parsed.read_only_info?.skipped ?? 0 };
      });
    },

    /** Подтянуть записи, которые добавила другая вкладка: рабочая область страницы — из журнала хранилища. */
    reload_foreign() {
      return enqueue(async () => {
        if (S.mode !== 'active' || S.pj === null) return { ok: false, error: 'not_available' };
        try {
          await S.pj.refresh();
          const ws = events_to_ws(S.pj.journal.events());
          S.prev_ws = ws; S.foreign = false; S.count = S.pj.journal.length;
          await refresh_meta();
          const r = deps.set_ws(ws, { reason: 'restore' });
          if (r?.ok === true) S.readonly = false;
          file?.note_change(S.count);
          return { ok: r?.ok === true };
        } catch (e) { fail_with(e, 'store_read'); return { ok: false, error: code_of(e) }; }
      });
    },

    /** Что будет удалено (счётчики для показа перед `erase`). */
    erase_preview() { return erase_preview(deps.get_ws(), { count: S.head?.count ?? 0 }); },

    /** Удалить все данные приложения на устройстве; выдаёт квитанцию. Запись в хранилище после этого отключена. */
    erase() {
      return enqueue(async () => {
        const counts = erase_preview(deps.get_ws(), { count: S.pj !== null ? S.pj.journal.length : (S.head?.count ?? 0) });
        file?.stop(); // автозапись останавливается до удаления: ни таймер, ни запись из очереди не вернут данные в файл-копию
        const receipt = await lock.run(() => erase_all({ store, channel, today: deps.today, ...(deps.erase_ports ?? {}), ...(file === null ? {} : { file_target: file.erase_port() }) }, { counts: { operations: counts.operations, rules: counts.rules, scenarios: counts.scenarios }, events: counts.events }));
        S.mode = 'erased'; S.pj = null; S.meta = {}; S.head = { count: 0, last_seq: 0, last_event_id: null }; S.count = 0; S.pending_backup = null;
        logger.info('erase_all', { n: counts.events });
        ping();
        return receipt;
      });
    },

    // ── автозапись в выбранный файл-копию (FP-19, REQ-097) ──────────────────────────────────────────────────────────────
    // Три действия — из обработчика нажатия: выбор файла и вопрос о разрешении браузер допускает только по жесту пользователя, поэтому вызов браузера идёт
    // первым и без ожидания очереди; запись — уже в очереди страницы.
    /** Выбрать файл и записать в него копию. */
    file_pick() {
      if (file === null) return Promise.resolve({ ok: false, reason: 'unsupported' });
      return file.pick_target().then(async (r) => {
        if (!r.ok) return r;
        const write = await enqueue(async () => { await unmark_file_copy(); return file.write_now('pick'); });
        return { ...r, write };
      });
    },

    /** Записать копию в выбранный файл сейчас. */
    file_write_now() { return file === null ? Promise.resolve({ ok: false, code: 'unsupported' }) : enqueue(() => file.write_now('manual')); },

    /** Спросить у браузера разрешение на запись в запомненный файл и, если выдано, записать копию. */
    async file_permission() {
      if (file === null) return { ok: false, reason: 'unsupported' };
      const r = await file.request_permission();
      if (!r.ok) return r;
      const write = await enqueue(() => file.write_now('permission'));
      return { ...r, write };
    },

    /** Больше не использовать файл: ссылка снимается, сам файл остаётся у пользователя. */
    file_forget() { return file === null ? Promise.resolve({ ok: false, reason: 'unsupported' }) : file.forget(); },

    /** Ждать, пока все поставленные записи завершатся (для тестов и «Скачать»). */
    flush() { return S.queue; },

    /** Снимок состояния для экрана: режим, сведения о хранилище, копии, баннер, отчёт «где что лежит». */
    status() {
      const ws = deps.get_ws();
      const lb = S.meta[META_LAST_BACKUP] ?? (S.pending_backup !== null && S.pending_backup.ws === S.baseline_ws ? { ...S.pending_backup.record, count: S.baseline_count } : null);
      const today = deps.today();
      const counters = backup_counters({ count: S.count, today, last_backup: lb, origin_count: S.meta[META_ORIGIN_COUNT] ?? S.baseline_count, created_day: S.meta[META_CREATED_DAY] ?? null });
      const due = backup_due(counters, backup_params(ws?.params));
      const installed = typeof deps.installed === 'function' ? deps.installed() : null;
      const file_st = file === null ? null : file.status();
      const banner = backup_banner({ due: due.due, persisted: S.persistence.persisted, installed, store_kind: deps.store_kind, file_phase: file_st?.phase ?? null });
      const rights = rights_report({ store_kind: deps.store_kind, persisted: S.persistence.persisted, installed, count: S.count, new_since_copy: counters.events_since, last_backup: lb, today, file: file_st });
      const snap = S.pj !== null ? S.pj.journal.snapshot_info() : null;
      return {
        // версия движка и снимки других версий (FP-17): `stale` — снимки, которые не использованы и пересобраны из записей; записи журнала не менялись
        engine: { current: ENGINE_VERSION, stale: snap === null ? [] : snap.stale, held: snap === null ? [] : snap.held },
        read_only: in_readonly(), mode: S.mode, error: S.error, store_kind: deps.store_kind, persisted: S.persistence.persisted, installed, count: S.count, saved: S.head?.count ?? 0, last_backup: lb,
        events_since: counters.events_since, days_since: counters.days_since, due, banner, rights, foreign: S.foreign, pause_reason: S.pause_reason, write_failed: S.write_failed,
        counts: counts_of_ws(ws), file: file_st,
      };
    },
  };

  /**
   * Выбран другой файл: запись о последней копии больше не относится к нему. Пометка `via: 'file'` снимается (день, число записей и хэш остаются: напоминание о копии
   * считает от них по-прежнему), и после перезагрузки число записей прежнего файла не принимается за число записей нового — иначе при неудачной первой записи
   * новый файл остался бы пустым при «автозапись включена, ничего не ожидает». Первая удачная запись в новый файл отметит копию заново.
   */
  async function unmark_file_copy() {
    const lb = S.meta[META_LAST_BACKUP];
    if (lb === undefined || lb === null || lb.via !== 'file') return;
    const plain = make_backup_record({ day: lb.day, count: lb.count, hash: lb.hash });
    try { await set_meta(META_LAST_BACKUP, plain); S.meta = { ...S.meta, [META_LAST_BACKUP]: plain }; } catch (e) { fail_with(e, 'store_meta'); }
  }

  async function handle_change(reason, ws, source) {
    if (S.mode === 'erased' || S.mode === 'failed' || S.mode === 'idle' || S.mode === 'found') return;
    if (reason === 'adopt') {
      if (S.mode === 'active') { S.mode = 'paused'; S.pause_reason = source === 'readonly' ? 'readonly' : 'adopt'; S.pj = null; }
      else if (S.mode === 'fresh') { S.baseline_ws = ws; S.baseline_count = events_of_ws(ws).length; S.count = S.baseline_count; S.pending_backup = null; return; } // страница перерисовывается сама
      ping();
      return;
    }
    if (S.mode === 'paused') return;
    if (S.mode === 'fresh') {
      if (ws === S.baseline_ws) return;
      const ok = await activate();
      if (!ok) { ping(); return; }
    }
    if (S.mode !== 'active' || ws === S.prev_ws) return;
    try {
      await S.pj.refresh();
      const specs = diff_ws_to_specs(S.prev_ws, ws, S.pj.journal.events());
      if (specs.length > 0) await S.pj.write(specs);
      S.prev_ws = ws;
      S.count = S.pj.journal.length;
      S.head = { count: S.count, last_seq: S.pj.journal.last_seq, last_event_id: null };
      S.write_failed = false;
      S.error = null;
    } catch (e) {
      S.write_failed = true; // прежняя рабочая область не принята: следующая правка допишет накопленную разность
      fail_with(e, 'store_write');
    }
    if (S.mode === 'active' && !S.write_failed) file?.note_change(S.count); // автозапись в файл-копию: по числу правок или по таймеру
    ping();
  }

  /** Первая запись: набор данных (то, что пришло не от пользователя) и метаданные; затем правка пишется как обычно. */
  async function activate() {
    try {
      const pj = await open_pj();
      if (pj.journal.length > 0) { S.mode = 'found'; S.head = await store.stat(); S.count = S.head.count; return false; } // другая вкладка успела первой
      const specs = diff_ws_to_specs({}, S.baseline_ws, []);
      await pj.write(specs, { retries: 0, if_empty: true });
      S.pj = pj;
      S.prev_ws = S.baseline_ws;
      const meta = { [META_CREATED_DAY]: deps.today(), [META_ORIGIN_COUNT]: specs.length };
      if (S.pending_backup !== null && S.pending_backup.ws === S.baseline_ws) meta[META_LAST_BACKUP] = { ...S.pending_backup.record, count: specs.length };
      for (const k of Object.keys(meta)) await set_meta(k, meta[k]);
      S.pending_backup = null;
      S.mode = 'active';
      await refresh_meta();
      S.count = pj.journal.length;
      S.head = { count: S.count, last_seq: pj.journal.last_seq, last_event_id: null };
      return true;
    } catch (e) {
      if (code_of(e) === 'store_conflict') { S.mode = 'found'; try { S.head = await store.stat(); S.count = S.head.count; } catch { /* голова обновится при следующем запуске */ } return false; }
      fail_with(e, 'store_write');
      S.write_failed = true;
      return false;
    }
  }

  return api;
}
