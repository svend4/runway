// journal_log.mjs — append-only журнал с монотонным `seq`, префиксным хэшем, снимком состояния и хвостом (FP-01, REQ-012, REQ-153).
// Канон: design-brief §3.3, §3.10 п. 3 («журнал не мутирует; fold(все записи) = fold(снимок, хвост)»), §3.10 п. 7 (seq монотонен), ADR-004.
//
// Что делает модуль (только поверх публичного API движка `engine/ledger.mjs`; сам движок не меняется):
//   - `create_journal` / `open_journal` — журнал в памяти: `append` (одна запись) и `append_many` (пачка целиком или ничего), каждая запись
//     создаётся `make_event` (форма проверена, `v` и `seq` обязательны, float отвергается), замораживается и больше не меняется;
//   - `prefix_hash(n)` — цепочка хэшей по первым n записям; после `append` хэш прежнего префикса не меняется (проверка «ничто не мутирует»);
//   - снимок — состояние `reduce(effective_events(первые count записей))`; новый снимок берётся, когда хвост достиг `snapshot_every` (~500);
//   - снимок несёт `engine_version` (FP-17, REQ-016): версию движка, посчитавшего состояние. Снимок ДРУГОЙ версии при открытии журнала не используется
//     (его арифметика могла отличаться) и пересобирается из записей — первый же новый снимок ложится по обычному правилу «хвост достиг snapshot_every»;
//     записи журнала при этом не меняются, а такие снимки перечислены в `snapshot_info().stale` — интерфейс показывает предупреждение, не отказ.
//     Снимок БЕЗ метки (сохранён до FP-17) принимается как есть: метка ставится на новых снимках;
//   - `fold_with_snapshot(снимок, события)` — свёртка «снимок + хвост»; равна свёртке всего журнала. Хвост, который откатывает или заменяет
//     запись ИЗ префикса снимка (`revert.target` / `supersedes_id` ведут в префикс), снимком не покрывается: берётся более ранний снимок или
//     полная свёртка. Это не оптимизация, а условие корректности: состояние не помнит, какая запись его породила.
//
// Почему не `reduce(хвост, снимок)` движка: он клонирует базу целиком (канонический JSON всего состояния), и на 36 500 записях это дороже
// 2 с, то есть снимок ничего не экономит. Здесь база не клонируется: в `reduce` уходит маленькая «частичная база» из тех сущностей, которых
// касается хвост, а результат вливается обратно по ключам. Сама свёртка по-прежнему делает движок (один источник правды), а совпадение
// с полной свёрткой проверяет tests/journal_log.test.mjs на 10^3 случайных журналах (TST-16, REQ-012).
// Модуль чистый: время и идентификаторы приходят портами (`ports.next_id`, `ports.recorded_at`).

import { make_event, effective_events, reduce, empty_state, canon, sha256, state_hash, EVENT_TYPES, fail, ENGINE_VERSION } from '../engine/index.mjs';

/** Стартовое значение цепочки префиксных хэшей. */
export const CHAIN_GENESIS = 'runway-journal-chain/1';

/** Интервал снимков по умолчанию (REQ-153: «каждые ~500 записей»). */
export const DEFAULT_SNAPSHOT_EVERY = 500;

// ── вспомогательное ───────────────────────────────────────────────────────────────────────────────────────────────

const own = (d, k) => (Object.hasOwn(d, k) ? d[k] : undefined);

/** Запись ключа в словарь без побочных эффектов на прототип (ключ `__proto__` — собственное свойство). */
function put(dict, key, value) {
  if (key === '__proto__') Object.defineProperty(dict, key, { value, writable: true, enumerable: true, configurable: true });
  else dict[key] = value;
}

/** Поверхностная копия словаря: цикл вместо spread (на словарях в десятки тысяч ключей в 2–3 раза быстрее), ключ `__proto__` — собственное свойство. */
function copy_dict(d) {
  const o = {};
  for (const k in d) put(o, k, d[k]);
  return o;
}

/** Заморозить запись целиком (payload — JSON-подобный: объекты, массивы, примитивы). */
function deep_freeze(x) {
  if (x === null || typeof x !== 'object' || Object.isFrozen(x)) return x;
  for (const k of Object.keys(x)) deep_freeze(x[k]);
  return Object.freeze(x);
}

/** Идентификаторы записей, на которые ссылается запись «назад» и от которых зависит её эффективность. */
function ref_ids(e) {
  const out = [];
  if (e.type === 'revert' && typeof e.payload?.target === 'string') out.push(e.payload.target);
  if (typeof e.supersedes_id === 'string') out.push(e.supersedes_id);
  return out;
}

/** Проверка формы записи, пришедшей снаружи (файл, импорт): без неё свёртка упала бы позже и дальше от причины. */
function check_event_shape(e, where) {
  const bad = (reason, extra) => fail('E_SCHEMA', { reason, where, ...extra });
  if (e === null || typeof e !== 'object' || Array.isArray(e)) bad('event_not_object');
  if (typeof e.event_id !== 'string' || e.event_id === '') bad('event_id_required');
  if (!EVENT_TYPES.includes(e.type)) bad('unknown_type', { type: String(e.type) });
  if (!Number.isSafeInteger(e.v) || e.v < 1) bad('v_required', { event_id: e.event_id });
  if (!Number.isSafeInteger(e.seq) || e.seq < 0) bad('seq_required', { event_id: e.event_id });
  if (typeof e.entity_id !== 'string' || e.entity_id === '') bad('entity_id_required', { event_id: e.event_id });
  if (e.payload === null || typeof e.payload !== 'object' || Array.isArray(e.payload)) bad('payload_not_object', { event_id: e.event_id });
}

// ── свёртка «снимок + хвост» без клонирования базы ────────────────────────────────────────────────────────────────

/** Тип записи → [корзина состояния, поле payload с ключом] для записей «установить сущность по идентификатору». */
const SET_BY = Object.freeze({
  'account.opened': ['accounts', 'account_id'], 'account.closed': ['accounts', 'account_id'], 'anchor.set': ['anchors', 'anchor_id'],
  'rule.set': ['rules', 'rule_id'], 'calendar.set': ['calendars', 'calendar_id'], 'stream.set': ['streams', 'stream_id'],
  'taxrule.set': ['tax_rules', 'tax_rule_id'], 'reserve.set': ['reserves', 'reserve_id'], 'allocation.recorded': ['allocations', 'allocation_id'],
  'fx.set': ['fx', 'fx_id'], 'scenario.set': ['scenarios', 'scenario_id'], 'purchase.saved': ['purchases', 'purchase_id'],
  'counterparty.set': ['counterparties', 'counterparty_id'], 'profile.set': ['profiles', 'profile_id'], 'debt.set': ['debts', 'debt_id'],
  'import.started': ['imports', 'batch_id'], 'import.rolled_back': ['imports', 'batch_id'],
});
const V2_TYPES = Object.freeze(['consent.granted', 'consent.revoked', 'draft.proposed', 'draft.confirmed', 'assistant.call']);

/**
 * Свернуть хвост на готовое состояние. Результат равен `reduce(effective_events(всё), пусто)`, если хвост не ссылается назад в префикс.
 * `base` не мутируется; общие значения (записи фактов и т. п.) разделяются между `base` и результатом, поэтому состояния — «только чтение».
 * @param {object} base состояние снимка
 * @param {object[]} tail записи после снимка (по порядку журнала)
 * @returns {object|null} новое состояние; `null` — в хвосте тип записи, который здесь не покрыт (звать полную свёртку)
 */
export function fold_tail(base, tail) {
  const eff = effective_events(tail);
  if (eff.length === 0) return base;
  const part = empty_state();
  const touched = new Map(); // корзина → множество ключей
  const match_keys = new Set(); // привязки `match.set`, нужные хвосту
  const tail_event_of = new Map(); // ключ факта → event_id последней записи tx.posted хвоста
  const tail_matches = new Set(); // fact_event_id привязок хвоста
  let key_by_event = null;
  const touch = (bucket, key) => {
    if (typeof key !== 'string') return;
    let set = touched.get(bucket);
    if (set === undefined) { set = new Set(); touched.set(bucket, set); }
    if (set.has(key)) return;
    set.add(key);
    if (bucket === 'matches') { match_keys.add(key); return; }
    const v = own(base[bucket], key);
    if (v !== undefined) put(part[bucket], key, v);
  };
  for (const e of eff) {
    const p = e.payload;
    if (Object.hasOwn(SET_BY, e.type)) touch(SET_BY[e.type][0], p?.[SET_BY[e.type][1]]);
    else if (e.type === 'tx.posted') { touch('facts', e.entity_id); touch('matches', e.event_id); touch('matches', e.entity_id); tail_event_of.set(e.entity_id, e.event_id); }
    else if (e.type === 'plan.set') touch('plans', e.entity_id);
    else if (e.type === 'override.set') touch('overrides', typeof p?.rule_id === 'string' && typeof p?.nominal_date === 'string' ? p.rule_id + '@' + p.nominal_date : undefined);
    else if (e.type === 'match.set') {
      const fid = p?.fact_event_id;
      touch('matches', fid);
      if (typeof fid === 'string') tail_matches.add(fid);
      if (typeof fid === 'string') {
        if (Object.hasOwn(base.facts, fid)) touch('facts', fid);
        else {
          if (key_by_event === null) { key_by_event = new Map(); for (const k of Object.keys(base.facts)) key_by_event.set(base.facts[k].event_id, k); }
          const k = key_by_event.get(fid);
          if (k !== undefined) touch('facts', k);
        }
      }
    } else if (e.type === 'wave_override.set' || e.type === 'params.set' || V2_TYPES.includes(e.type)) { /* только добавление: база не нужна */ } else return null;
  }
  // привязки, относящиеся к затронутым фактам: по ключу факта и по идентификатору записи, породившей его
  for (const k of touched.get('facts') ?? []) {
    const f = own(base.facts, k);
    const ev = tail_event_of.get(k) ?? f?.event_id;
    // Факт привязан сразу двумя способами (по ключу и по event_id): победитель зависит от порядка ключей, а канонический клон базы
    // (reduce клонирует её через canon) порядок теряет. Такой случай снимком не покрывается — полная свёртка по записям.
    const forms = new Set([k, ev].filter((x) => typeof x === 'string'));
    if ([...forms].filter((x) => Object.hasOwn(base.matches, x) || tail_matches.has(x)).length > 1) return null;
    if (f !== undefined) { touch('matches', k); touch('matches', f.event_id); }
  }
  for (const k of match_keys) if (Object.hasOwn(base.matches, k)) put(part.matches, k, base.matches[k]);
  const res = reduce(eff, part);
  const out = { ...base };
  const copied = new Set();
  const writable = (b) => {
    if (!copied.has(b)) { out[b] = Array.isArray(base[b]) ? base[b].slice() : copy_dict(base[b]); copied.add(b); }
    return out[b];
  };
  for (const [bucket, keys] of touched) {
    for (const k of keys) if (Object.hasOwn(res[bucket], k)) put(writable(bucket), k, res[bucket][k]);
  }
  for (const k of Object.keys(res.params)) put(writable('params'), k, res.params[k]);
  if (res.wave_overrides.length > 0) out.wave_overrides = base.wave_overrides.concat(res.wave_overrides);
  for (const t of Object.keys(res.extra)) {
    const slot = Object.hasOwn(base.extra, t) ? copy_dict(base.extra[t]) : {};
    for (const k of Object.keys(res.extra[t])) put(slot, k, res.extra[t][k]);
    put(writable('extra'), t, slot);
  }
  return out;
}

/** Есть ли в хвосте (`events[count..]`) ссылка «назад» на запись из префикса `events[0..count)`. */
export function has_back_ref(events, count, index) {
  const wanted = new Set();
  for (let i = count; i < events.length; i++) for (const r of ref_ids(events[i])) wanted.add(r);
  if (wanted.size === 0) return false;
  if (index !== undefined) {
    for (const r of wanted) { const pos = index.get(r); if (pos !== undefined && pos < count) return true; }
    return false;
  }
  for (let i = 0; i < count; i++) if (wanted.has(events[i].event_id)) return true;
  return false;
}

/** Полная свёртка журнала: `reduce(effective_events(events))`. */
export function full_fold(events) {
  return reduce(effective_events(events));
}

/**
 * Снимок: состояние первых `count` записей и версия движка, посчитавшего его (`engine_version`, FP-17).
 * @param {object[]} events
 * @param {number} [count] по умолчанию — весь журнал
 * @param {string} [engine_version] по умолчанию — версия этого движка
 * @returns {{count: number, seq: number|null, state: object, engine_version: string}}
 */
export function take_snapshot(events, count = events.length, engine_version = ENGINE_VERSION) {
  if (!Number.isInteger(count) || count < 0 || count > events.length) fail('E_SCHEMA', { reason: 'snapshot_count_out_of_range', count: String(count) });
  const head = count === events.length ? events : events.slice(0, count);
  return { count, seq: count === 0 ? null : head[count - 1].seq, state: full_fold(head), engine_version };
}

/**
 * Свёртка «снимок + хвост» по записям всего журнала. Если хвост ссылается назад в префикс снимка (откат или замена старой записи),
 * снимок неприменим — считается полная свёртка (`used_snapshot = false`).
 * @param {{count: number, state: object}} snapshot
 * @param {object[]} events весь журнал
 * @param {Map<string, number>} [index] `event_id → позиция` (если уже построен)
 * @returns {{state: object, used_snapshot: boolean}}
 */
export function fold_with_snapshot(snapshot, events, index) {
  const { count } = snapshot;
  if (!Number.isInteger(count) || count < 0 || count > events.length) fail('E_SCHEMA', { reason: 'snapshot_count_out_of_range', count: String(count) });
  if (count === events.length) return { state: snapshot.state, used_snapshot: true };
  if (!has_back_ref(events, count, index)) {
    const state = fold_tail(snapshot.state, events.slice(count));
    if (state !== null) return { state, used_snapshot: true };
  }
  return { state: full_fold(events), used_snapshot: false };
}

// ── журнал ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Порты журнала из генератора идентификаторов (`ids.mjs`): `make_id_gen(...)` → `{ next_id, recorded_at }`.
 * @param {{next: () => string, instant: () => string}} gen
 */
export function ports_from_gen(gen) {
  return { next_id: () => gen.next(), recorded_at: () => gen.instant() };
}

/**
 * Создать (или открыть) журнал.
 * @param {{events?: object[], snapshots?: {count: number, seq: number|null, state: object, engine_version?: string}[], snapshot_every?: number, keep_snapshots?: number,
 *   verify?: boolean, engine_version?: string, ports?: {next_id: () => string, recorded_at: () => string}}} [opts]
 *   `events` — уже записанные записи (по возрастанию `seq`); `snapshots` — прочитанные снимки; `verify` — сверить `state_hash` снимков, у которых он записан;
 *   `engine_version` — версия движка, под которую ведётся журнал (по умолчанию `ENGINE_VERSION`): снимки с меткой другой версии не используются (FP-17).
 * @returns {object} журнал: `append`, `append_many`, `append_event`, `events`, `length`, `last_seq`, `prefix_hash`, `state`, `state_hash`,
 *   `take_snapshot`, `snapshots`, `snapshot_info`, `export`
 * @throws {RunwayError} E_SCHEMA (форма записи, `v`/`seq`, нарушение монотонности, повтор `event_id`, снимок не от этого журнала)
 */
export function create_journal(opts = {}) {
  const every = opts.snapshot_every ?? DEFAULT_SNAPSHOT_EVERY;
  if (!Number.isInteger(every) || every < 1) fail('E_SCHEMA', { reason: 'snapshot_every_not_positive_int' });
  const keep = opts.keep_snapshots ?? 2;
  const engine_version = opts.engine_version ?? ENGINE_VERSION;
  const stale = []; // снимки другой версии движка: не используются, пересобираются (FP-17)
  const ports = opts.ports ?? null;
  const log = [];
  const index = new Map();
  let last_seq = 0;
  const push_checked = (e, where) => {
    check_event_shape(e, where);
    if (e.seq <= last_seq) fail('E_SCHEMA', { reason: 'seq_not_monotonic', seq: e.seq, last_seq });
    if (index.has(e.event_id)) fail('E_SCHEMA', { reason: 'duplicate_event_id', event_id: e.event_id });
    index.set(e.event_id, log.length);
    log.push(e);
    last_seq = e.seq;
  };
  for (const e of opts.events ?? []) push_checked(e, 'open');
  /** @type {{count: number, seq: number|null, state: object, state_hash?: string}[]} */
  let snaps = [];
  for (const sn of opts.snapshots ?? []) {
    if (sn === null || typeof sn !== 'object' || !Number.isInteger(sn.count) || sn.count < 0 || sn.count > log.length || typeof sn.state !== 'object' || sn.state === null) {
      fail('E_SCHEMA', { reason: 'bad_snapshot' });
    }
    if (sn.count > 0 && log[sn.count - 1].seq !== sn.seq) fail('E_SCHEMA', { reason: 'snapshot_not_from_this_journal', count: sn.count });
    // снимок посчитан другой версией движка (метка есть и не совпадает): арифметика могла отличаться, поэтому его не используем и не сверяем по хэшу —
    // состояние досчитывается из записей, а новый снимок ляжет по обычному правилу; метки нет (снимок до FP-17) — принимаем как раньше
    if (typeof sn.engine_version === 'string' && sn.engine_version !== engine_version) { stale.push({ count: sn.count, engine_version: sn.engine_version.slice(0, 40) }); continue; }
    if (opts.verify === true && typeof sn.state_hash === 'string' && state_hash(sn.state) !== sn.state_hash) fail('E_SCHEMA', { reason: 'snapshot_hash_mismatch', count: sn.count });
    snaps.push(sn);
  }
  snaps.sort((a, b) => a.count - b.count);
  const chain = [sha256(CHAIN_GENESIS)];
  let cache = null; // { count, state } — последнее вычисленное состояние (неявный снимок)

  const trim = () => { if (snaps.length > keep) snaps = snaps.slice(snaps.length - keep); };

  const state_info = () => {
    const n = log.length;
    if (cache !== null && cache.count === n) return { state: cache.state, used_snapshot: true, from_count: n };
    const cands = snaps.slice();
    if (cache !== null) cands.push({ count: cache.count, seq: null, state: cache.state });
    cands.sort((a, b) => b.count - a.count);
    for (const sn of cands) {
      if (sn.count > n || has_back_ref(log, sn.count, index)) continue;
      const state = sn.count === n ? sn.state : fold_tail(sn.state, log.slice(sn.count));
      if (state === null) continue;
      cache = { count: n, state };
      return { state, used_snapshot: true, from_count: sn.count };
    }
    const state = full_fold(log);
    cache = { count: n, state };
    return { state, used_snapshot: false, from_count: 0 };
  };

  const snapshot_now = () => {
    const { state } = state_info();
    const last = snaps.length === 0 ? null : snaps[snaps.length - 1];
    if (last !== null && last.count === log.length) return last;
    const sn = { count: log.length, seq: log.length === 0 ? null : last_seq, state, engine_version };
    snaps.push(sn);
    trim();
    return sn;
  };

  const maybe_snapshot = () => {
    const last_count = snaps.length === 0 ? 0 : snaps[snaps.length - 1].count;
    if (log.length - last_count < every) return;
    try { snapshot_now(); } catch { /* журнал не сворачивается (повреждённый файл): запись принята, снимка нет, ошибку покажет state() */ }
  };

  const need_ports = () => {
    if (ports === null || typeof ports.next_id !== 'function' || typeof ports.recorded_at !== 'function') fail('E_SCHEMA', { reason: 'journal_ports_required' });
    return ports;
  };

  const known_ref = (id, what, extra_ids) => {
    if (id === undefined || id === null) return;
    if (!index.has(id) && !extra_ids.has(id)) fail('E_SCHEMA', { reason: 'reference_to_unknown_event', what });
  };

  const build = (specs) => {
    const p = need_ports();
    const pending = new Set();
    const out = [];
    let seq = last_seq;
    for (const sp of specs) {
      const o = sp.opts ?? {};
      seq += 1;
      const ctx = { event_id: p.next_id(), seq, recorded_at: p.recorded_at(), actor: o.actor ?? 'user' };
      for (const k of ['entity_id', 'causation_id', 'supersedes_id', 'v']) if (o[k] !== undefined) ctx[k] = o[k];
      const e = make_event(sp.type, sp.payload, ctx);
      known_ref(e.supersedes_id, 'supersedes_id', pending);
      known_ref(e.causation_id, 'causation_id', pending);
      if (e.type === 'revert') known_ref(e.payload.target, 'revert.target', pending);
      pending.add(e.event_id);
      out.push(deep_freeze(e));
    }
    return out;
  };

  const commit = (evs) => {
    for (const e of evs) push_checked(e, 'append');
    maybe_snapshot();
  };

  const journal = {
    /** Число записей. */
    get length() { return log.length; },
    /** `seq` последней записи (0 — журнал пуст). */
    get last_seq() { return last_seq; },
    /** Записи (копия массива; сами записи заморожены). */
    events() { return log.slice(); },
    /** Запись по позиции (0-based) или `undefined`. */
    at(i) { return log[i]; },
    /** Позиция записи по `event_id` или `undefined`. */
    position_of(event_id) { return index.get(event_id); },
    /**
     * Добавить запись: `append('tx.posted', payload, {entity_id?, actor?, causation_id?, supersedes_id?, v?})`.
     * @returns {object} созданная (замороженная) запись
     */
    append(type, payload, o) {
      const [e] = build([{ type, payload, opts: o }]);
      commit([e]);
      return e;
    },
    /** Добавить пачку записей: либо все, либо ни одной (проверка ссылок и форм до первой вставки). */
    append_many(specs) {
      if (!Array.isArray(specs)) fail('E_SCHEMA', { reason: 'specs_not_array' });
      const evs = build(specs);
      commit(evs);
      return evs;
    },
    /** Добавить готовую запись (например, из импорта): `seq` строго больше последнего, `event_id` новый. Запись замораживается. */
    append_event(e) {
      push_checked(deep_freeze(e), 'append_event');
      maybe_snapshot();
      return e;
    },
    /**
     * Цепочка префиксных хэшей: `hex` по первым `n` записям. Не меняется, пока журнал растёт (проверка «записанное не мутирует»).
     * Считается лениво: открытие журнала хэшей не требует.
     * @param {number} [n]
     */
    prefix_hash(n = log.length) {
      if (!Number.isInteger(n) || n < 0 || n > log.length) fail('E_SCHEMA', { reason: 'prefix_out_of_range', n: String(n) });
      while (chain.length <= n) chain.push(sha256(chain[chain.length - 1] + canon(log[chain.length - 1])));
      return chain[n];
    },
    /** Состояние журнала: свёртка «снимок + хвост»; `used_snapshot = false` — понадобилась полная свёртка. Результат — только чтение. */
    state() { return state_info(); },
    /** `state_hash` свёртки журнала. */
    state_hash() { return state_hash(state_info().state); },
    /** Взять снимок сейчас (или вернуть уже взятый на этой длине). */
    take_snapshot: snapshot_now,
    /** Хранимые снимки (копия массива). */
    snapshots() { return snaps.slice(); },
    /**
     * Версия движка журнала и что с ней у снимков (FP-17): `held` — используемые снимки (`engine_version: null` — снимок без метки, сохранён до FP-17),
     * `stale` — снимки другой версии движка, отброшенные при открытии. Записи журнала версией движка не помечаются и не меняются.
     */
    snapshot_info() {
      return { engine_version, held: snaps.map((x) => ({ count: x.count, engine_version: typeof x.engine_version === 'string' ? x.engine_version : null })), stale: stale.map((x) => ({ ...x })) };
    },
    /** Данные для сохранения: записи и снимки (сериализует хранилище, FP-05). */
    export() { return { events: log.slice(), snapshots: snaps.slice() }; },
  };
  return journal;
}

/** Открыть журнал из прочитанных данных `{events, snapshots}`. */
export function open_journal(data, opts = {}) {
  return create_journal({ ...opts, events: data?.events ?? [], snapshots: data?.snapshots ?? [] });
}
