// ws_bridge.mjs — мост «рабочая область ↔ журнал» (FP-01, REQ-094, ADR-004).
// Форма рабочей области `ws` (массивы по видам сущностей, как в data/g001.json) и форма состояния `State` движка (словари по идентификатору,
// результат свёртки журнала) расходятся. Модуль закрывает расхождение чистыми преобразователями и даёт круг без потерь:
//
//     ws ──ws_to_events──▶ записи журнала ──reduce(effective_events)──▶ State ──state_to_ws──▶ ws'
//
// Гарантии (проверяет tests/ws_bridge.test.mjs, TST-38): на наборах G-001, -low, -gap, -late `analyze(ws')` даёт тот же `inputs_hash`
// и те же числа, что `analyze(ws)`; `state_hash` не зависит от формы файла.
//
// Что не входит в `ws` и потому не возвращается из журнала: пакеты импорта (`imports`), согласия и черновики (`extra`), ручные привязки
// (`matches` — они уже вшиты в факты как `plan_ref`/`no_plan`; если у существующего факта изменились ТОЛЬКО эти поля, `diff_ws_to_specs` пишет запись `match.set` вместо
// замены `tx.posted`, FP-11). Запись журнала, вернувшая факт, откатывается — в `ws` его нет.
// Поля `ws` вне списка корзин (имя, локаль, валюта решения, `as_of`, любые прочие) хранятся одной записью `profile.set` с зарезервированным
// `profile_id = 'ws:meta'`; из журнала они возвращаются на верхний уровень `ws`.
// Идентификатор факта в `ws` — `event_id`; в журнале это `entity_id` записи `tx.posted` (идентификатор самой записи — из портов).
// Элемент без идентификатора получает служебный `auto:<корзина>:<номер>`; при возврате в `ws` он снова снимается.
// Модуль чистый: идентификаторы записей и время ввода приходят портами; ключи `__proto__`/`constructor`/`prototype` отвергаются.

import { make_event, effective_events, reduce, fail, canon } from '../engine/index.mjs';
import { export_json, read_journal_json } from '../engine/io.mjs';
import { PARAM_RANGES } from '../engine/validate_ws.mjs';
import { FORBIDDEN_KEYS } from './ids.mjs';

/** Зарезервированный `profile_id` записи с метаданными рабочей области. */
export const META_ID = 'ws:meta';

/** Префикс служебных идентификаторов элементов, у которых своего идентификатора в `ws` не было. */
export const AUTO_PREFIX = 'auto:';

/**
 * Корзины: `ws` → `State`. `ws_key` — поле `ws`; `state_key` — корзина `State`; `type` — запись журнала; `id_field` — поле-идентификатор
 * (`null` — составной ключ). `tx.posted` и `params.set` обрабатываются отдельно.
 */
export const BUCKETS = Object.freeze([
  { ws_key: 'accounts', state_key: 'accounts', type: 'account.opened', id_field: 'account_id' },
  { ws_key: 'calendars', state_key: 'calendars', type: 'calendar.set', id_field: 'calendar_id' },
  { ws_key: 'anchors', state_key: 'anchors', type: 'anchor.set', id_field: 'anchor_id' },
  { ws_key: 'plans', state_key: 'plans', type: 'plan.set', id_field: 'plan_id' },
  { ws_key: 'rules', state_key: 'rules', type: 'rule.set', id_field: 'rule_id' },
  { ws_key: 'overrides', state_key: 'overrides', type: 'override.set', id_field: null },
  { ws_key: 'streams', state_key: 'streams', type: 'stream.set', id_field: 'stream_id' },
  { ws_key: 'tax_rules', state_key: 'tax_rules', type: 'taxrule.set', id_field: 'tax_rule_id' },
  { ws_key: 'reserves', state_key: 'reserves', type: 'reserve.set', id_field: 'reserve_id' },
  { ws_key: 'allocations', state_key: 'allocations', type: 'allocation.recorded', id_field: 'allocation_id' },
  { ws_key: 'rates', state_key: 'fx', type: 'fx.set', id_field: 'fx_id' },
  { ws_key: 'scenarios', state_key: 'scenarios', type: 'scenario.set', id_field: 'scenario_id' },
  { ws_key: 'purchases', state_key: 'purchases', type: 'purchase.saved', id_field: 'purchase_id' },
  { ws_key: 'debts', state_key: 'debts', type: 'debt.set', id_field: 'debt_id' },
  { ws_key: 'wave_overrides', state_key: 'wave_overrides', type: 'wave_override.set', id_field: 'override_id' },
  { ws_key: 'counterparties', state_key: 'counterparties', type: 'counterparty.set', id_field: 'counterparty_id' },
  { ws_key: 'profiles', state_key: 'profiles', type: 'profile.set', id_field: 'profile_id' },
  { ws_key: 'facts', state_key: 'facts', type: 'tx.posted', id_field: 'event_id' },
]);

const BUCKET_BY_TYPE = new Map(BUCKETS.map((b) => [b.type, b]));
/** Поля верхнего уровня `ws`, которые НЕ метаданные: `params` и корзины. Экспортируется, чтобы «Отменить» (undo.mjs) не повторяла список. */
export const NON_META_KEYS = new Set(['params', ...BUCKETS.map((b) => b.ws_key)]);

/**
 * Параметры, для которых `null` — не значение, а «параметра нет»: у них в `PARAM_RANGES` нет `nullable`. Журнал не умеет удалять ключ параметра,
 * поэтому пропавший параметр (например, после «Отменить» первого задания параметра) записывается как `null`; при чтении журнала такой `null`
 * возвращается в «ключа нет» (иначе `inputs_hash` после перезагрузки отличался бы от сеансового, а `validate_ws` отверг бы `null`).
 * Параметры с допустимым `null` (`buffer_minor`, `wave.threshold_minor`, `decision_currency`) остаются как есть.
 */
const NOT_NULLABLE_PARAMS = new Set(Object.entries(PARAM_RANGES).filter(([, r]) => r.nullable !== true).map(([k]) => k));

// ── защита от чужих ключей и вспомогательное ────────────────────────────────────────────────────────────────────────────────

/** Отвергнуть ключи `__proto__`/`constructor`/`prototype`, не-JSON значения и чрезмерную глубину во всём значении. */
export function assert_safe_json(x, where = 'value', depth = 0) {
  if (depth > 40) fail('E_SCHEMA', { reason: 'too_deep', where });
  if (x === null || typeof x !== 'object') return;
  if (Array.isArray(x)) { for (const v of x) assert_safe_json(v, where, depth + 1); return; }
  const proto = Object.getPrototypeOf(x);
  if (proto !== Object.prototype && proto !== null) fail('E_SCHEMA', { reason: 'not_plain_object', where });
  for (const k of Object.getOwnPropertyNames(x)) {
    if (FORBIDDEN_KEYS.includes(k)) fail('E_SCHEMA', { reason: 'forbidden_key', key: k, where });
    assert_safe_json(x[k], where, depth + 1);
  }
}

const clone = (x) => JSON.parse(canon(x)); // канонический клон: float и не-JSON отвергаются, NFC нормализуется
const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function list_of(ws, key) {
  const v = ws[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail('E_SCHEMA', { reason: 'bucket_not_array', bucket: key });
  return key === 'tax_rules' ? v.flat() : v;
}

/**
 * Ключ элемента корзины `ws` (для словаря `State` и поиска записи): `null`, если идентификатора нет. Единственное правило ключа для моста и для
 * стопки «Отменить» (undo.mjs): пустая строка — не ключ; у `overrides` и `tax_rules` ключ составной.
 * @param {{ws_key: string, id_field: string|null}} b описание корзины из `BUCKETS`
 * @param {object} item элемент корзины (не объект — `E_SCHEMA`)
 * @returns {string|null}
 */
export function item_key(b, item) {
  if (!is_obj(item)) return fail('E_SCHEMA', { reason: 'item_not_object', bucket: b.ws_key });
  if (b.ws_key === 'overrides') {
    return typeof item.rule_id === 'string' && typeof item.nominal_date === 'string' ? item.rule_id + '@' + item.nominal_date : null;
  }
  if (b.ws_key === 'tax_rules') {
    return typeof item.tax_rule_id === 'string' && item.tax_rule_id !== '' && Number.isSafeInteger(item.version) ? item.tax_rule_id + '@' + item.version : null;
  }
  const v = b.ws_key === 'facts' ? (item.event_id ?? item.cash_event_id ?? item.entity_id ?? item.id) : item[b.id_field];
  return typeof v === 'string' && v !== '' ? v : null;
}

/** Метаданные `ws` — все поля верхнего уровня, кроме `params` и корзин. */
export function meta_of(ws) {
  const m = {};
  for (const k of Object.keys(ws)) if (!NON_META_KEYS.has(k)) m[k] = ws[k];
  return m;
}

// ── ws → записи журнала ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Записи журнала для рабочей области: метаданные, параметры, затем сущности по корзинам (факты — последними).
 * @param {object} ws
 * @param {{next_id?: () => string, recorded_at?: string|(() => string), start_seq?: number, actor?: string}} [opts]
 *   по умолчанию идентификаторы детерминированы (`evt~000001`…), время ввода — `as_of` рабочей области в 00:00:00Z
 * @returns {object[]} записи с `seq` от `start_seq` (по умолчанию 1)
 * @throws {RunwayError} E_SCHEMA (не объект, повтор идентификатора, элемент не объект, запрещённый ключ), E_NOT_INTEGER (float)
 */
export function ws_to_events(ws, opts = {}) {
  if (!is_obj(ws)) fail('E_SCHEMA', { reason: 'workspace_not_object' });
  assert_safe_json(ws, 'workspace');
  let counter = 0;
  const next_id = opts.next_id ?? (() => { counter += 1; return 'evt~' + String(counter).padStart(6, '0'); });
  const as_of = typeof ws.as_of === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ws.as_of) ? ws.as_of : '2026-01-01';
  const at = () => (typeof opts.recorded_at === 'function' ? opts.recorded_at() : (opts.recorded_at ?? as_of + 'T00:00:00Z'));
  let seq = (opts.start_seq ?? 1) - 1;
  const actor = opts.actor ?? 'user';
  const out = [];
  const emit = (type, payload, extra) => {
    seq += 1;
    out.push(make_event(type, payload, { event_id: next_id(), seq, recorded_at: at(), actor, ...extra }));
  };
  const ws_id = typeof ws.workspace_id === 'string' && ws.workspace_id !== '' ? ws.workspace_id : 'ws';
  emit('profile.set', { profile_id: META_ID, kind: 'workspace_meta', ...meta_of(ws) });
  if (is_obj(ws.params)) emit('params.set', ws.params, { entity_id: ws_id });
  for (const b of BUCKETS) {
    if (b.ws_key === 'profiles') {
      for (const item of list_of(ws, 'profiles')) emit(b.type, item);
      continue;
    }
    const seen = new Set();
    list_of(ws, b.ws_key).forEach((item, i) => {
      let key = item_key(b, item);
      let payload = item;
      if (key === null) {
        if (b.id_field === null || b.ws_key === 'tax_rules') fail('E_SCHEMA', { reason: 'item_key_required', bucket: b.ws_key, index: i });
        key = AUTO_PREFIX + b.ws_key + ':' + i;
        payload = { ...item, [b.id_field]: key };
      } else if (b.ws_key === 'facts' && item.event_id === undefined) payload = { ...item, event_id: key };
      if (seen.has(key)) fail('E_SCHEMA', { reason: 'duplicate_id', bucket: b.ws_key });
      seen.add(key);
      emit(b.type, payload, b.ws_key === 'facts' ? { entity_id: key } : undefined);
    });
  }
  return out;
}

// ── записи журнала → ws ───────────────────────────────────────────────────────────────────────────────────────────

const strip_auto = (item, field) => {
  if (typeof item[field] === 'string' && item[field].startsWith(AUTO_PREFIX)) delete item[field];
  return item;
};

/**
 * Состояние `State` → рабочая область. Корзины — массивы в порядке словаря; служебные ключи состояния (`seq` у правок волн,
 * `entity_id` у фактов) снимаются; метаданные берутся из записи `ws:meta`, а поверх них — `base` (его верхнеуровневые поля вне корзин).
 * @param {object} state результат `reduce`
 * @param {object} [base] рабочая область, чьи метаданные важнее журнальных (например, `as_of` «сегодня»)
 * @returns {object}
 */
export function state_to_ws(state, base) {
  const ws = {};
  const meta_rec = Object.hasOwn(state.profiles, META_ID) ? state.profiles[META_ID] : null;
  if (meta_rec !== null) {
    const { profile_id: _p, kind: _k, ...meta } = clone(meta_rec);
    Object.assign(ws, meta);
  }
  if (is_obj(base)) Object.assign(ws, meta_of(clone(base)));
  ws.params = clone(state.params);
  for (const k of Object.keys(ws.params)) if (ws.params[k] === null && NOT_NULLABLE_PARAMS.has(k)) delete ws.params[k]; // `null` журнала = «параметра нет»
  for (const b of BUCKETS) {
    let items;
    if (b.ws_key === 'tax_rules') items = Object.keys(state.tax_rules).flatMap((k) => state.tax_rules[k].map(clone));
    else if (b.ws_key === 'wave_overrides') items = state.wave_overrides.map((o) => { const c = clone(o); delete c.seq; return strip_auto(c, 'override_id'); });
    else if (b.ws_key === 'profiles') items = Object.keys(state.profiles).filter((k) => k !== META_ID).map((k) => clone(state.profiles[k]));
    else if (b.ws_key === 'facts') {
      items = Object.keys(state.facts).map((k) => {
        const c = clone(state.facts[k]);
        c.event_id = c.entity_id ?? k;
        delete c.entity_id;
        return strip_auto(c, 'event_id');
      });
    } else {
      items = Object.keys(state[b.state_key]).map((k) => {
        const c = clone(state[b.state_key][k]);
        return b.id_field === null ? c : strip_auto(c, b.id_field);
      });
    }
    if (b.ws_key === 'profiles' && items.length === 0) continue; // у наборов данных такого поля нет
    ws[b.ws_key] = items;
  }
  return ws;
}

/**
 * Рабочая область из записей журнала: `reduce(effective_events(events))` и `state_to_ws`.
 * @param {object[]} events записи (любой порядок: сортируются по `seq`)
 * @param {object} [base] метаданные, которые важнее журнальных
 * @returns {object}
 */
export function events_to_ws(events, base) {
  return state_to_ws(reduce(effective_events(events)), base);
}

/** `ws` → состояние `State` (через записи журнала). */
export function ws_to_state(ws, opts) {
  return reduce(effective_events(ws_to_events(ws, opts)));
}

/** `ws` → файл-копия `runway-journal/1` (канонический JSON, см. `io.export_json`). */
export function ws_to_journal(ws, opts = {}) {
  return export_json(ws_to_events(ws, opts), { engine_version: opts.engine_version });
}

/** Файл-копия `runway-journal/N` → `ws` (формат новее известного — `E_SCHEMA`, как в `io.read_journal_json`). */
export function journal_to_ws(text, base) {
  return events_to_ws(read_journal_json(text).events, base);
}

// ── разность ws → записи (синхронизация журнала с рабочей областью) ───────────────────────────────────────────────

/** Факты различаются только полями привязки к плану (`plan_ref`, `no_plan`), и они действительно различаются. */
function only_match_differs(old, now) {
  const strip = (f) => { const c = { ...f }; delete c.plan_ref; delete c.no_plan; return canon(c); };
  return strip(old) === strip(now);
}

/** Ключ записи журнала в тех же терминах, что `item_key` (чтобы найти запись по элементу `ws`). */
function event_key(e) {
  const b = BUCKET_BY_TYPE.get(e.type);
  if (b === undefined) return null;
  if (e.type === 'tx.posted') return e.entity_id;
  return item_key(b, e.payload);
}

/** Индекс «тип|ключ → последняя действующая запись» по журналу и словарь «event_id → запись» для разбора цепочек замен. */
function effective_index(events) {
  const idx = new Map();
  for (const e of effective_events(events)) {
    const k = event_key(e);
    if (k !== null) idx.set(e.type + '|' + k, e);
  }
  const by_id = new Map(events.map((e) => [e.event_id, e]));
  return { idx, by_id };
}

/**
 * Заготовки записей, которые переводят журнал из состояния `before` в `after`.
 * Новое — запись `set`; изменённое — запись с `supersedes_id` (исправление, не перезапись); удалённое — `revert` действующей записи;
 * параметр, пропавший из `params`, записывается как `null` (при чтении журнала `null` необнуляемого параметра снова становится «ключа нет»,
 * см. `state_to_ws`). Правки волн сравниваются как упорядоченный список.
 * @param {object} before
 * @param {object} after
 * @param {object[]} journal_events записи журнала (нужны, чтобы найти, что откатывать и заменять)
 * @returns {{type: string, payload: object, opts?: object}[]}
 * @throws {RunwayError} E_SCHEMA `journal_out_of_sync` — журнал не знает записи, которую надо откатить (журнал пора пересобрать из `after`)
 */
export function diff_ws_to_specs(before, after, journal_events) {
  assert_safe_json(after, 'workspace');
  const specs = [];
  let index = null;
  const lookup = (type, key) => {
    if (index === null) index = effective_index(journal_events);
    return index.idx.get(type + '|' + key);
  };
  // Удаление сущности — откат действующей записи И всей цепочки её замен (supersedes_id): откат одной лишь последней записи по канону
  // (C-070) вернул бы исходную, то есть «удалённое» воскресло бы.
  const revert_of = (type, key) => {
    const e = lookup(type, key);
    if (e === undefined) fail('E_SCHEMA', { reason: 'journal_out_of_sync', type });
    for (let cur = e; cur !== undefined; cur = typeof cur.supersedes_id === 'string' ? index.by_id.get(cur.supersedes_id) : undefined) {
      specs.push({ type: 'revert', payload: { target: cur.event_id }, opts: { entity_id: cur.entity_id } });
    }
  };
  const ws_id = typeof after.workspace_id === 'string' && after.workspace_id !== '' ? after.workspace_id : 'ws';

  const mb = clone(meta_of(before));
  const ma = clone(meta_of(after));
  if (canon(mb) !== canon(ma)) {
    const prev = lookup('profile.set', META_ID);
    specs.push({ type: 'profile.set', payload: { profile_id: META_ID, kind: 'workspace_meta', ...ma }, opts: prev === undefined ? undefined : { supersedes_id: prev.event_id } });
  }
  const pb = is_obj(before.params) ? before.params : {};
  const pa = is_obj(after.params) ? after.params : {};
  const pchg = {};
  for (const k of Object.keys(pa)) if (!Object.hasOwn(pb, k) || canon(pb[k]) !== canon(pa[k])) pchg[k] = pa[k];
  for (const k of Object.keys(pb)) if (!Object.hasOwn(pa, k)) pchg[k] = null;
  if (Object.keys(pchg).length > 0) specs.push({ type: 'params.set', payload: pchg, opts: { entity_id: ws_id } });

  for (const b of BUCKETS) {
    if (b.ws_key === 'wave_overrides') {
      const lb = list_of(before, b.ws_key);
      const la = list_of(after, b.ws_key);
      let i = 0;
      while (i < lb.length && i < la.length && canon(lb[i]) === canon(la[i])) i++;
      for (let j = i; j < lb.length; j++) revert_of(b.type, lb[j].override_id);
      for (let j = i; j < la.length; j++) specs.push({ type: b.type, payload: la[j] });
      continue;
    }
    const mapb = new Map();
    list_of(before, b.ws_key).forEach((it) => { const k = item_key(b, it); if (k !== null) mapb.set(k, it); });
    const seen = new Set();
    list_of(after, b.ws_key).forEach((it) => {
      const k = item_key(b, it);
      if (k === null) fail('E_SCHEMA', { reason: 'item_key_required', bucket: b.ws_key });
      if (seen.has(k)) fail('E_SCHEMA', { reason: 'duplicate_id', bucket: b.ws_key });
      seen.add(k);
      const old = mapb.get(k);
      if (old !== undefined && canon(old) === canon(it)) return;
      if (b.ws_key === 'facts' && old !== undefined && only_match_differs(old, it)) {
        // у факта изменилась только привязка к плану (`plan_ref` / `no_plan`, FP-11): факт не мутирует, пишется `match.set` (C-051, REQ-031);
        // пустая привязка снимает прежнюю (свёртка кладёт поверх факта то, что в `match.set`, а не слияние)
        const m = { fact_event_id: k };
        if (it.plan_ref !== undefined) m.plan_ref = it.plan_ref;
        if (it.no_plan !== undefined) m.no_plan = it.no_plan;
        specs.push({ type: 'match.set', payload: m });
        return;
      }
      const payload = b.ws_key === 'facts' && it.event_id === undefined ? { ...it, event_id: k } : it;
      const o = {};
      if (b.ws_key === 'facts') o.entity_id = k;
      if (old !== undefined) {
        const prev = lookup(b.type, k);
        if (prev !== undefined) o.supersedes_id = prev.event_id;
      }
      specs.push({ type: b.type, payload, opts: Object.keys(o).length === 0 ? undefined : o });
    });
    for (const [k] of mapb) if (!seen.has(k)) revert_of(b.type, k);
  }
  return specs;
}

/**
 * Привести журнал к рабочей области `after`: дописать записи разности (атомарно — пачкой).
 * @param {{events: () => object[], append_many: (specs: object[]) => object[]}} journal журнал из `journal_log.mjs`
 * @param {object} before
 * @param {object} after
 * @returns {object[]} добавленные записи
 */
export function sync_journal(journal, before, after) {
  const specs = diff_ws_to_specs(before, after, journal.events());
  return specs.length === 0 ? [] : journal.append_many(specs);
}
