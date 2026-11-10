// undo.mjs — «Отменить / Вернуть» поверх записей журнала (FP-04, REQ-090, IDEA-91, ADR-004; единая стопка — этап S1.3).
//
// Единица отмены — одно действие пользователя: разность рабочей области «до → после». С этапа S1.3 она охватывает ВСЮ рабочую область, а не только
// факты, якоря, аллокации и резервы:
//   - корзины-массивы с идентификатором (`UNDO_ARRAY_BUCKETS`): счета, календари, правила, потоки часов, налоговые правила, курсы, сценарии, покупки,
//     долги, правки волн, контрагенты и т. д.; составные ключи — `overrides` (`rule_id@nominal_date`) и `tax_rules` (`tax_rule_id@version`);
//   - «слоты-объекты» (`UNDO_SLOT_BUCKETS`): параметры `params` (по ключу параметра, значение `null` отличается от отсутствия ключа) и метаполя верхнего
//     уровня (`as_of`, `number_format`, `name`, `locale`, `decision_currency` и любые прочие не-корзинные поля, см. `ws_bridge.meta_of`).
// Формат записи об изменении един: `{bucket, key, before, after}`; у массивов `before`/`after` — сам элемент или `null` («нет»), у слотов — коробка
// `{value}` или `null` («ключа нет»). Единица может нести ещё два необязательных поля — `order` (порядок элементов, если простое «заменить/добавить в
// конец/убрать» его не воспроизводит: удаление из середины, правка волн, уходящая в конец) и `presence` (корзина или `params` отсутствовали до действия:
// отмена не оставляет после себя пустой массив). Для четырёх прежних корзин формат записи не менялся.
//
// Отмена и возврат пишут в рабочую область через общий путь `ctx.set_ws`; журнал следует за ней сам (`ws_bridge.sync_journal`): удалённое
// становится записью `revert`, изменённое — исправлением `supersedes_id`, поэтому журнал остаётся append-only, а `state_hash` после отмены
// равен хэшу до действия (проверяется в tests/entry.test.mjs и tests/undo_all.test.mjs).
//
// Что попадает в стопку. Подписчик пакета FP-04 (`auto_record`) получает от `ctx.set_ws` рабочую область «до» и «после» и сам строит единицу — так
// отменяется любое действие, записанное общим путём `ctx.set_ws` / `ctx.edit`: формы данных, настройки, «Сегодня», сценарии, правки волн и т. д.
// Исключения (`UNDO_EXCLUDED_REASONS`): сами «отменить» и «вернуть»; замена набора целиком (`adopt`, `restore` — стопка очищается); мастер импорта FP-06
// (`import`, `import_rollback`: у него свой «Откатить партию» с реестром партий); служебные перерисовки без изменения данных. Действия, которые стопку
// записывают сами ДО общего пути (FP-04: «+ Факт», сверка, ответ о переводе), помечают запись `undo: 'recorded'` — второй раз она не пишется.
//
// Устойчивость к чужим правкам: единица применяется, только если элементы в рабочей области именно такие, какими их оставило действие
// (отмена) или какими они были до него (возврат). Иначе — отказ `undo_conflict`, единица снимается со стопки, данные не трогаются.
// Три случая «чужой» правки, которые одной проверки элементов не видны (дефекты после независимой проверки S1.3), закрыты отдельно:
//   - ссылочная целостность: если после применения единицы на убранный элемент (счёт, правило, накопление, календарь, контрагент…) ссылались бы
//     записи, добавленные помимо стопки (импорт), — отказ `undo_conflict` (`UNDO_REFS`, `dangling_refs`); уже висевшие ссылки не считаются;
//   - отказ страницы, который не пройдёт и при повторе (расчёт на итоговой рабочей области падает так же: например, «Сегодня» нельзя вернуть
//     раньше проведённой записи, добавленной импортом): единица снимается как конфликт, стопка не залипает; временный отказ возвращает единицу;
//   - чистая перестановка (правка волн, сохранённая заново с теми же значениями, уходит в конец списка): единица с пустым `changes` и непустым `order`.
// Ключи элементов берёт мост (`ws_bridge.item_key`): у стопки и журнала одно правило ключа.
// Модель чистая (без DOM); кнопки в навигации строит `render_undo_buttons` в конце файла.

import { canon, analyze } from '../engine/index.mjs';
import { h } from './dom.mjs';
import { FORBIDDEN_KEYS } from './ids.mjs';
import { BUCKETS as BRIDGE_BUCKETS, meta_of, item_key as bridge_item_key, NON_META_KEYS } from './ws_bridge.mjs';

/** Корзины рабочей области, которые отслеживала отмена до S1.3: `[ключ корзины, поле идентификатора]`. Состав и формат не менялись. */
export const UNDO_BUCKETS = Object.freeze([['facts', 'event_id'], ['anchors', 'anchor_id'], ['allocations', 'allocation_id'], ['reserves', 'reserve_id']]);

const BRIDGE_BY_KEY = new Map(BRIDGE_BUCKETS.map((b) => [b.ws_key, b]));
/** Ключ элемента `overrides` (пропуск и перенос вхождения): `rule_id@nominal_date`; `null`, если полей нет. Правило — моста. */
const key_override = (it) => bridge_item_key(BRIDGE_BY_KEY.get('overrides'), it);
/** Ключ версии налогового правила: `tax_rule_id@version` (версии добавляются, прошлые не правятся); `null`, если полей нет. Правило — моста. */
const key_tax_rule = (it) => bridge_item_key(BRIDGE_BY_KEY.get('tax_rules'), it);

/**
 * Остальные корзины-массивы рабочей области: `[ключ корзины, поле идентификатора | функция ключа]`. Вместе с `UNDO_BUCKETS` они совпадают с корзинами
 * моста «рабочая область ↔ журнал» (`ws_bridge.BUCKETS`; совпадение, в том числе поля идентификатора, проверяют tests/undo_all.test.mjs и
 * tests/undo_fix.test.mjs). Само правило ключа берётся у моста (`ws_bridge.item_key`), поле здесь — для чтения. Устаревшая форма `tax_rules` —
 * вложенные массивы версий — не отслеживается (элементы-массивы пропускаются, как элементы без идентификатора).
 */
export const UNDO_EXTRA_BUCKETS = Object.freeze([
  ['accounts', 'account_id'], ['calendars', 'calendar_id'], ['plans', 'plan_id'], ['rules', 'rule_id'], ['overrides', key_override], ['streams', 'stream_id'],
  ['tax_rules', key_tax_rule], ['rates', 'fx_id'], ['scenarios', 'scenario_id'], ['purchases', 'purchase_id'], ['debts', 'debt_id'],
  ['wave_overrides', 'override_id'], ['counterparties', 'counterparty_id'], ['profiles', 'profile_id'],
]);

/** Все корзины-массивы, которые отслеживает единица отмены. */
export const UNDO_ARRAY_BUCKETS = Object.freeze([...UNDO_BUCKETS, ...UNDO_EXTRA_BUCKETS]);

/** Слоты-объекты: `params` (по ключу параметра) и `meta` (метаполя верхнего уровня рабочей области). */
export const UNDO_SLOT_BUCKETS = Object.freeze(['params', 'meta']);

/** Служебные поля элементов, которые при сравнении не учитываются: `seq` у правок волн ставит свёртка журнала, а не пользователь. */
export const UNDO_IGNORED_FIELDS = Object.freeze({ wave_overrides: Object.freeze(['seq']) });

/** Сколько действий помнит стопка. */
export const UNDO_LIMIT = 50;

/** Значение признака `o.undo` в `ctx.set_ws`: «действие уже записано в стопку до общего пути» — подписчик второй раз его не пишет. */
export const UNDO_RECORDED = 'recorded';

/** Причины записи, при которых рабочая область заменена целиком (набор данных, файл, подтяжка другой вкладки): стопка очищается. */
export const UNDO_CLEAR_REASONS = Object.freeze(['adopt', 'restore']);

/**
 * Причины записи, которые в стопку НЕ пишутся (стопка при этом не очищается): сами «отменить» и «вернуть»; мастер импорта FP-06 (`import`,
 * `import_rollback` — у него свой «Откатить партию» с реестром партий; прежние единицы после импорта остаются валидными или дают `undo_conflict`);
 * служебные перерисовки без изменения данных (`undo_refresh`, `guard_answer`).
 */
export const UNDO_SKIP_REASONS = Object.freeze(['undo', 'redo', 'import', 'import_rollback', 'undo_refresh', 'guard_answer']);

/** Полный список исключений: очищающие и пропускаемые причины. */
export const UNDO_EXCLUDED_REASONS = Object.freeze([...UNDO_CLEAR_REASONS, ...UNDO_SKIP_REASONS]);

const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const list = (ws, key) => (Array.isArray(ws?.[key]) ? ws[key] : []);

/** Равенство по каноническому JSON; значение, которое канон не принимает (нецелое число и т. п.), считается «не равным» (осторожно, без исключения). */
const same = (a, b) => {
  if ((a ?? null) === (b ?? null)) return true;
  try { return canon(a ?? null) === canon(b ?? null); } catch { return false; }
};

const without_fields = (x, fields) => {
  if (!is_obj(x)) return x;
  const o = { ...x };
  for (const f of fields) delete o[f];
  return o;
};

/** Равенство элементов корзины с учётом служебных полей (`UNDO_IGNORED_FIELDS`). */
const same_item = (bucket, a, b) => {
  if ((a ?? null) === (b ?? null)) return true;
  const ig = Object.hasOwn(UNDO_IGNORED_FIELDS, bucket) ? UNDO_IGNORED_FIELDS[bucket] : null;
  return ig === null ? same(a, b) : same(without_fields(a, ig), without_fields(b, ig));
};

/** Функция ключа корзины — правило моста (`ws_bridge.item_key`); `null`, если ключа нет (такие элементы не отслеживаются). */
const KEY_OF = new Map(UNDO_ARRAY_BUCKETS.map(([bucket]) => [bucket, (it) => bridge_item_key(BRIDGE_BY_KEY.get(bucket), it)]));

const item_key = (key_of, it) => (is_obj(it) ? key_of(it) : null);
const present = (obj, k) => Object.hasOwn(obj, k) && obj[k] !== undefined;
const slot_obj = (ws, bucket) => (bucket === 'params' ? (is_obj(ws?.params) ? ws.params : {}) : (is_obj(ws) ? meta_of(ws) : {}));
const key_ok = (bucket, k) => typeof k === 'string' && !FORBIDDEN_KEYS.includes(k) && !(bucket === 'meta' && NON_META_KEYS.has(k));

/** Ключи элементов массива в порядке массива (элементы без ключа пропущены). */
const keys_in_order = (arr, key_of) => {
  const out = [];
  for (const it of arr) { const k = item_key(key_of, it); if (k !== null) out.push(k); }
  return out;
};

/** Ключи после применения изменений корзины «просто»: заменить на месте, добавить в конец, убрать (без учёта позиции). */
function simulate_keys(keys, changes, dir) {
  const out = keys.slice();
  for (const c of changes) {
    const to = dir === 'undo' ? c.before : c.after;
    const i = out.indexOf(c.key);
    if (to === null) { if (i >= 0) out.splice(i, 1); } else if (i < 0) out.push(c.key);
  }
  return out;
}
const same_keys = (a, b) => a.length === b.length && a.every((k, i) => k === b[i]);

/**
 * Разность двух рабочих областей по всем отслеживаемым корзинам и слотам.
 * @param {object} before
 * @param {object} after
 * @param {object} [meta] описание действия (не зависит от языка): `{kind, amount_minor, currency, …}`
 * @returns {{meta: object, changes: {bucket: string, key: string, before: any, after: any}[], order?: object, presence?: object}|null} `null`, если разницы нет;
 *   `changes` пуст, если изменился только порядок элементов (чистая перестановка): тогда `order` непуст
 */
export function diff_unit(before, after, meta = {}) {
  if (before === after) return null;
  const changes = [];
  const order = {};
  const presence = {};

  for (const [bucket] of UNDO_ARRAY_BUCKETS) {
    const key_of = KEY_OF.get(bucket);
    const b_arr = list(before, bucket);
    const a_arr = list(after, bucket);
    if (b_arr === a_arr) continue;
    const start = changes.length;
    const old_by = new Map();
    for (const it of b_arr) { const k = item_key(key_of, it); if (k !== null) old_by.set(k, it); }
    const seen = new Set();
    for (const it of a_arr) {
      const key = item_key(key_of, it);
      if (key === null) continue;
      seen.add(key);
      const old = old_by.get(key);
      if (old === undefined) changes.push({ bucket, key, before: null, after: it });
      else if (!same_item(bucket, old, it)) changes.push({ bucket, key, before: old, after: it });
    }
    for (const [key, old] of old_by) if (!seen.has(key)) changes.push({ bucket, key, before: old, after: null });
    const mine = changes.slice(start);
    const keys_b = keys_in_order(b_arr, key_of);
    const keys_a = keys_in_order(a_arr, key_of);
    if (mine.length === 0) {
      // изменений по ключам нет: единица нужна, только если изменился порядок (чистая перестановка: правка волн, сохранённая заново с теми же
      // значениями, уходит в конец списка, а порядок правок входит в inputs_hash)
      if (!same_keys(keys_b, keys_a)) order[bucket] = { before: keys_b, after: keys_a };
      continue;
    }
    // порядок: проверяем, воспроизводит ли «простая» отмена/возврат порядок элементов; если нет — запоминаем порядок ключей
    const need_b = !same_keys(simulate_keys(keys_a, mine, 'undo'), keys_b);
    const need_a = !same_keys(simulate_keys(keys_b, mine, 'redo'), keys_a);
    if (need_b || need_a) order[bucket] = { ...(need_b ? { before: keys_b } : {}), ...(need_a ? { after: keys_a } : {}) };
    if (Array.isArray(before?.[bucket]) !== Array.isArray(after?.[bucket])) presence[bucket] = { before: Array.isArray(before?.[bucket]), after: Array.isArray(after?.[bucket]) };
  }

  for (const bucket of UNDO_SLOT_BUCKETS) {
    const b_obj = slot_obj(before, bucket);
    const a_obj = slot_obj(after, bucket);
    const start = changes.length;
    const keys = [...Object.keys(a_obj), ...Object.keys(b_obj).filter((k) => !Object.hasOwn(a_obj, k))];
    for (const key of keys) {
      if (!key_ok(bucket, key)) continue;
      const pb = present(b_obj, key) ? { value: b_obj[key] } : null;
      const pa = present(a_obj, key) ? { value: a_obj[key] } : null;
      if (pb !== null && pa !== null && b_obj[key] === a_obj[key]) continue;
      if (!same(pb, pa)) changes.push({ bucket, key, before: pb, after: pa });
    }
    if (bucket === 'params' && changes.length > start && is_obj(before?.params) !== is_obj(after?.params)) {
      presence.params = { before: is_obj(before?.params), after: is_obj(after?.params) };
    }
  }

  if (changes.length === 0 && Object.keys(order).length === 0) return null;
  const unit = { meta: is_obj(meta) ? meta : {}, changes };
  if (Object.keys(order).length > 0) unit.order = order;
  if (Object.keys(presence).length > 0) unit.presence = presence;
  return unit;
}

/**
 * Расставить известные элементы корзины в заданном порядке ключей. Чужие элементы (которых нет в порядке единицы: их добавили помимо стопки,
 * например импорт) остаются при том известном элементе, за которым стояли, и едут вместе с ним; чужие в самом начале остаются в начале.
 */
function reorder(ws, bucket, target) {
  const key_of = KEY_OF.get(bucket);
  const arr = list(ws, bucket);
  const rank = new Map(target.map((k, i) => [k, i]));
  const head = [];
  const groups = [];
  for (const x of arr) {
    const k = item_key(key_of, x);
    if (k !== null && rank.has(k)) groups.push({ item: x, rank: rank.get(k), tail: [] });
    else (groups.length === 0 ? head : groups[groups.length - 1].tail).push(x);
  }
  groups.sort((p, q) => p.rank - q.rank);
  const out = [...head, ...groups.flatMap((g) => [g.item, ...g.tail])];
  return out.every((x, i) => x === arr[i]) ? ws : { ...ws, [bucket]: out };
}

/** Порядок ключей корзины в `ws`, ограниченный ключами `expected`, совпадает с порядком в `expected`, ограниченным ключами корзины. */
function order_matches(ws, bucket, expected) {
  const cur = keys_in_order(list(ws, bucket), KEY_OF.get(bucket));
  const in_expected = new Set(expected);
  const in_cur = new Set(cur);
  return same_keys(cur.filter((k) => in_expected.has(k)), expected.filter((k) => in_cur.has(k)));
}

/**
 * Ссылки между корзинами, которые приложение проверяет САМО — при записи (`ws_edit`) и при чтении чужого файла (`validate_ws`):
 * `[корзина-источник, путь к полю (через точку; массив строк — каждая строка), корзина-цель]`. Единица отмены не должна создать «висячую»
 * ссылку: если после применения на убранный элемент ссылается запись, которой нет в единице (её добавили помимо стопки, например импорт), —
 * отказ `undo_conflict`. Ссылки, которые приложение не проверяет (`rule_id`/`stream_id`/`reserve_id` у факта, `tax_rule_id` у накопления,
 * `reserve_id` у плана, `counterparty_id` у потока), не отслеживаются: иначе законная запись пользователя давала бы ложный конфликт при возврате.
 */
export const UNDO_REFS = Object.freeze([
  ['facts', 'account_id', 'accounts'], ['facts', 'counterparty_id', 'counterparties'],
  ['anchors', 'account_id', 'accounts'], ['plans', 'account_id', 'accounts'],
  ['rules', 'account_id', 'accounts'], ['rules', 'calendar_id', 'calendars'], ['rules', 'counterparty_id', 'counterparties'],
  ['overrides', 'rule_id', 'rules'],
  ['streams', 'account_id', 'accounts'], ['streams', 'calendar_id', 'calendars'],
  ['tax_rules', 'reserve_id', 'reserves'], ['tax_rules', 'applies_to.stream_ids', 'streams'],
  ['reserves', 'backed_by_account_id', 'accounts'],
  ['allocations', 'reserve_id', 'reserves'],
  ['debts', 'pay_account_id', 'accounts'],
]);

/** Непустые строки по пути `a.b` элемента (массив строк — каждая строка). */
function ref_values(item, path) {
  let v = item;
  for (const part of path.split('.')) {
    if (!is_obj(v)) return [];
    v = Object.hasOwn(v, part) ? v[part] : undefined;
  }
  return (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string' && x !== '');
}

/** Висячие ссылки рабочей области: `«источник|ключ|поле|значение» → {bucket, key}` источника. */
function dangling_refs(ws) {
  const found = new Map();
  const ids = new Map();
  const known_in = (target) => {
    let s = ids.get(target);
    if (s === undefined) { s = new Set(keys_in_order(list(ws, target), KEY_OF.get(target))); ids.set(target, s); }
    return s;
  };
  for (const [src, path, target] of UNDO_REFS) {
    const arr = list(ws, src);
    if (arr.length === 0) continue;
    const key_of = KEY_OF.get(src);
    const known = known_in(target);
    for (const it of arr) {
      const key = item_key(key_of, it);
      if (key === null) continue;
      for (const v of ref_values(it, path)) if (!known.has(v)) found.set(src + '|' + key + '|' + path + '|' + v, { bucket: src, key });
    }
  }
  return found;
}

/** Записать значение слота (`null` — убрать ключ) в копию рабочей области. */
function with_slot(ws, bucket, key, box) {
  if (bucket === 'params') {
    const p = { ...(is_obj(ws.params) ? ws.params : {}) };
    if (box === null) delete p[key]; else p[key] = box.value;
    return { ...ws, params: p };
  }
  const n = { ...ws };
  if (box === null) delete n[key]; else n[key] = box.value;
  return n;
}

/**
 * Применить единицу к рабочей области в нужную сторону.
 * @param {object} ws
 * @param {{changes: object[], order?: object, presence?: object}} unit
 * @param {'undo'|'redo'} dir
 * @returns {{ok: true, ws: object} | {ok: false, reason: 'undo_conflict', bucket: string, key: string, cause?: 'dangling_ref'}}
 *   `cause: 'dangling_ref'` — элементы совпали, но после применения на убранный элемент ссылалась бы чужая запись
 */
export function apply_unit(ws, unit, dir) {
  let next = ws;
  const conflict = (c) => ({ ok: false, reason: 'undo_conflict', bucket: c.bucket, key: c.key });
  for (const c of unit.changes) {
    const from = dir === 'undo' ? c.after : c.before;
    const to = dir === 'undo' ? c.before : c.after;
    if (UNDO_SLOT_BUCKETS.includes(c.bucket)) {
      if (!key_ok(c.bucket, c.key)) return conflict(c);
      const obj = slot_obj(next, c.bucket);
      const cur = present(obj, c.key) ? { value: obj[c.key] } : null;
      if (!same(cur, from)) return conflict(c);
      next = with_slot(next, c.bucket, c.key, to);
      continue;
    }
    const key_of = KEY_OF.get(c.bucket);
    if (key_of === undefined) return conflict(c);
    const arr = list(next, c.bucket);
    const i = arr.findIndex((x) => item_key(key_of, x) === c.key);
    const cur = i < 0 ? null : arr[i];
    if (!same_item(c.bucket, cur, from)) return conflict(c);
    let out;
    if (to === null) out = arr.filter((_, j) => j !== i);
    else if (i < 0) out = [...arr, to];
    else { out = arr.slice(); out[i] = to; }
    next = { ...next, [c.bucket]: out };
  }
  if (is_obj(unit.order)) {
    for (const [bucket, o] of Object.entries(unit.order)) {
      const target = dir === 'undo' ? o?.before : o?.after;
      const from_keys = dir === 'undo' ? o?.after : o?.before;
      if (!Array.isArray(target) || !KEY_OF.has(bucket)) continue;
      // чистая перестановка (по ключам ничего не менялось): содержимое не проверить, поэтому проверяем сам порядок — его не должны были менять помимо стопки
      if (Array.isArray(from_keys) && !unit.changes.some((c) => c.bucket === bucket) && !order_matches(next, bucket, from_keys)) return conflict({ bucket, key: from_keys[0] ?? '' });
      next = reorder(next, bucket, target);
    }
  }
  if (is_obj(unit.presence)) {
    for (const [bucket, p] of Object.entries(unit.presence)) {
      const want = dir === 'undo' ? p?.before : p?.after;
      if (bucket === 'params') {
        if (want === false && is_obj(next.params) && Object.keys(next.params).length === 0) { const { params: _p, ...rest } = next; next = rest; } else if (want === true && !is_obj(next.params)) next = { ...next, params: {} };
      } else if (KEY_OF.has(bucket)) {
        if (want === false && Array.isArray(next[bucket]) && next[bucket].length === 0) { const rest = { ...next }; delete rest[bucket]; next = rest; } else if (want === true && !Array.isArray(next[bucket])) next = { ...next, [bucket]: [] };
      }
    }
  }
  // ссылочная целостность: единица не должна оставить на рабочей области ссылок на несуществующее (чужие записи ссылаются на то, что мы убираем)
  const after_refs = dangling_refs(next);
  if (after_refs.size > 0) {
    const before_refs = dangling_refs(ws);
    for (const [k, at] of after_refs) if (!before_refs.has(k)) return { ok: false, reason: 'undo_conflict', bucket: at.bucket, key: at.key, cause: 'dangling_ref' };
  }
  return { ok: true, ws: next };
}

// ── подписи действий ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Вид действия (`meta.kind`) → ключ строки для подписи кнопок и сообщений. Неизвестный вид — общая подпись `entry.u_other`. */
export const UNDO_LABEL_KEYS = Object.freeze({
  expense: 'entry.u_expense',
  income: 'entry.u_income',
  transfer: 'entry.u_transfer',
  anchor: 'entry.u_anchor',
  reserve_cut: 'entry.u_reserve',
  fact_removed: 'entry.u_fact_removed',
  fact_fix: 'entry.u_fact_fix',
  settings: 'entry.u_settings',
  today: 'entry.u_today',
  rule: 'entry.u_rule',
  stream: 'entry.u_stream',
  tax_rule: 'entry.u_tax_rule',
  reserve_edit: 'entry.u_reserve_edit',
  account: 'entry.u_account',
  rate: 'entry.u_rate',
  scenario: 'entry.u_scenario',
  wave_override: 'entry.u_wave',
  counterparty: 'entry.u_counterparty',
  purchase: 'entry.u_purchase',
  debt: 'entry.u_debt',
  reconcile: 'entry.u_reconcile',
  calendar: 'entry.u_calendar',
  plan: 'entry.u_plan',
  other: 'entry.u_other',
});

/**
 * Подпись действия для кнопок и сообщений: язык-независимое описание → строка словаря.
 * @param {{kind?: string, amount_minor?: number, currency?: string, reduced_minor?: number}} meta
 * @param {(key: string, params?: object) => string} tr
 * @param {(minor: number, currency: string) => string} money
 */
export function unit_label(meta, tr, money) {
  const m = is_obj(meta) ? meta : {};
  const amount = Number.isSafeInteger(m.amount_minor) && typeof m.currency === 'string' ? money(Math.abs(m.amount_minor), m.currency) : '';
  const key = typeof m.kind === 'string' && Object.hasOwn(UNDO_LABEL_KEYS, m.kind) ? UNDO_LABEL_KEYS[m.kind] : UNDO_LABEL_KEYS.other;
  return tr(key, { amount }).trim();
}

/** Причина записи (вид правки) → вид действия для подписи. `fact` разбирается по добавленным фактам (расход, приход, перевод). */
export const REASON_KINDS = Object.freeze({
  add_fact: 'fact',
  post_income: 'fact',
  void_fact: 'fact_removed',
  fix_fact: 'fact_fix',
  set_anchor: 'anchor',
  set_param: 'settings',
  set_number_format: 'settings',
  set_as_of: 'today',
  set_decision_currency: 'settings',
  upsert_account: 'account',
  upsert_rule: 'rule',
  delete_rule: 'rule',
  set_occurrence_override: 'rule',
  upsert_stream: 'stream',
  set_stream_hours: 'stream',
  upsert_tax_rule: 'tax_rule',
  upsert_reserve: 'reserve_edit',
  record_allocation: 'reserve_edit',
  record_posted_allocations: 'reserve_edit',
  confirm_contributions: 'reserve_edit',
  upsert_fx_rate: 'rate',
  add_purchase: 'purchase',
  save_scenario: 'scenario',
  delete_scenario: 'scenario',
  set_wave_override: 'wave_override',
  add_counterparty: 'counterparty',
  set_match: 'reconcile',
  set_plan_status: 'reconcile',
  upsert_debt: 'debt',
  delete_debt: 'debt',
  move_debt_row: 'debt',
  apply_prepay: 'debt',
  apply_reanchor: 'debt',
  upsert_calendar: 'calendar',
  delete_calendar: 'calendar',
  upsert_plan: 'plan',
  delete_plan: 'plan',
});

/** Если причина неизвестна: вид по изменённым корзинам (первое совпадение по порядку). */
const BUCKET_KINDS = Object.freeze([
  ['rules', 'rule'], ['overrides', 'rule'], ['streams', 'stream'], ['tax_rules', 'tax_rule'], ['reserves', 'reserve_edit'], ['accounts', 'account'], ['rates', 'rate'],
  ['scenarios', 'scenario'], ['wave_overrides', 'wave_override'], ['counterparties', 'counterparty'], ['purchases', 'purchase'], ['debts', 'debt'], ['calendars', 'calendar'], ['plans', 'plan'],
  ['allocations', 'reserve_edit'], ['anchors', 'anchor'], ['facts', 'fact'], ['params', 'settings'], ['meta', 'settings'],
]);

function kind_from_buckets(unit) {
  for (const [bucket, kind] of BUCKET_KINDS) {
    const hit = unit.changes.find((c) => c.bucket === bucket);
    if (hit !== undefined) return bucket === 'meta' && hit.key === 'as_of' ? 'today' : kind;
    if (is_obj(unit.order) && Object.hasOwn(unit.order, bucket)) return kind; // чистая перестановка
  }
  return 'other';
}

const currency_of_account = (ws, id) => {
  const a = list(ws, 'accounts').find((x) => is_obj(x) && x.account_id === id);
  return typeof a?.currency === 'string' ? a.currency : undefined;
};

/** Описание добавленных фактов: один факт — расход или приход; две ноги одного перевода — перевод; иначе общая подпись. */
function fact_meta(unit, ws) {
  const added = unit.changes.filter((c) => c.bucket === 'facts' && c.before === null && is_obj(c.after)).map((c) => c.after);
  if (added.length === 0) return { kind: 'other' };
  const f = added[0];
  const currency = typeof f.currency === 'string' ? f.currency : currency_of_account(ws, f.account_id);
  const shaped = (kind) => (Number.isSafeInteger(f.amount_minor) && currency !== undefined ? { kind, amount_minor: Math.abs(f.amount_minor), currency } : { kind });
  if (added.length === 1) return shaped(f.kind === 'income' || (f.kind !== 'expense' && f.amount_minor > 0) ? 'income' : 'expense');
  const tid = f.transfer_id;
  if (added.length === 2 && typeof tid === 'string' && added[1].transfer_id === tid) return shaped('transfer');
  return { kind: 'other' };
}

/**
 * Описание действия для подписи, если его не дал сам вызывающий: вид — по причине записи, иначе по изменённым корзинам.
 * Пользовательских текстов (названий, заметок) в описании нет.
 * @param {string} reason причина записи (`ctx.set_ws(…, {reason})`, обычно вид правки)
 * @param {{changes: object[]}} unit единица отмены
 * @param {object} [ws] рабочая область после действия (для валюты счёта)
 * @returns {{kind: string, amount_minor?: number, currency?: string}}
 */
export function describe_unit(reason, unit, ws) {
  const kind = typeof reason === 'string' && Object.hasOwn(REASON_KINDS, reason) ? REASON_KINDS[reason] : kind_from_buckets(unit);
  if (kind === 'fact') return fact_meta(unit, ws);
  if (kind === 'anchor') {
    const hit = unit.changes.find((c) => c.bucket === 'anchors' && is_obj(c.after));
    const currency = hit === undefined ? undefined : currency_of_account(ws, hit.after.account_id);
    return hit !== undefined && Number.isSafeInteger(hit.after.amount_minor) && currency !== undefined ? { kind, amount_minor: hit.after.amount_minor, currency } : { kind };
  }
  return { kind };
}

// ── стопка ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Код отказа расчёта на рабочей области, если он не пройдёт и при повторе; `null`, если расчёт проходит (значит, отказ страницы был временным).
 * Страница считает модель тем же `analyze(ws, {as_of: ws.as_of})` (`app.build_model`), поэтому проба на самой рабочей области даёт тот же ответ.
 * Пользовательские тексты в код не попадают: берётся только код ошибки канона (`E_*`).
 */
export function refusal_code(ws) {
  try { analyze(ws, { as_of: ws.as_of }); } catch (e) { return typeof e?.code === 'string' && /^E_[A-Z_]+$/.test(e.code) ? e.code : 'E_SCHEMA'; }
  return null;
}

/**
 * Стопка отмены: действие записывается ДО общего пути записи (`record` возвращает ручку `rollback` на случай отказа пересчёта), чтобы кнопки
 * в навигации, которые страница перерисовывает внутри `ctx.set_ws`, уже видели новое состояние стопки. Отмена и возврат работают так же:
 * единица переносится между стопками до `ctx.set_ws` и возвращается назад при отказе. Новое действие очищает «вернуть».
 * Остальные действия пишет подписчик (`auto_record`): он вызывается внутри `ctx.set_ws` ДО перерисовки страницы, поэтому кнопки тоже видят
 * новое состояние. Стопка живёт, пока открыта страница; смена набора данных очищает её (`clear`).
 * @param {{limit?: number}} [opts]
 */
export function create_undo_stack(opts = {}) {
  const limit = Number.isSafeInteger(opts.limit) && opts.limit > 0 ? opts.limit : UNDO_LIMIT;
  const undo = [];
  const redo = [];

  /** Положить единицу в стопку с ограничением длины; вернуть вытесненную (или `undefined`). */
  const put = (stack, unit) => {
    stack.push(unit);
    return stack.length > limit ? stack.shift() : undefined;
  };

  /** @returns {{ok: boolean, error?: {code: string, ctx: object|null}, meta?: object}} */
  const run = (ctx, from, to, dir) => {
    const unit = from[from.length - 1];
    if (unit === undefined) return { ok: false, error: { code: 'E_SCHEMA', ctx: { reason: 'nothing_to_' + dir } } };
    const ws = ctx.get_ws();
    if (ws === null || ws === undefined) return { ok: false, error: { code: 'E_SCHEMA', ctx: { reason: 'no_workspace' } } };
    const r = apply_unit(ws, unit, dir);
    if (!r.ok) {
      from.pop(); // единица устарела: данные менялись помимо неё
      return { ok: false, error: { code: 'E_SCHEMA', ctx: { reason: r.reason, bucket: r.bucket, ...(r.cause === undefined ? {} : { cause: r.cause }) } } };
    }
    from.pop();
    const dropped = put(to, unit);
    const s = ctx.set_ws(r.ws, { reason: dir });
    if (!s.ok) {
      to.pop();
      if (dropped !== undefined) to.unshift(dropped);
      // Детерминированный отказ: расчёт на итоговой рабочей области падает так же при любом повторе (чужая запись после действия мешает вернуть
      // состояние: «Сегодня» раньше проведённой записи и т. п.). Единица устарела — снимается, как при конфликте; иначе она залипла бы на вершине
      // и закрыла бы все более ранние. Временный отказ (страница недоступна, исключение хозяина): единица возвращается на место.
      const final = refusal_code(r.ws);
      if (final !== null) return { ok: false, error: { code: 'E_SCHEMA', ctx: { reason: 'undo_conflict', bucket: null, cause: 'refused', code: final } } };
      from.push(unit);
      return { ok: false, error: s.error };
    }
    return { ok: true, meta: unit.meta };
  };

  return {
    /**
     * Записать действие «до → после» (вызывать до `ctx.set_ws` или из подписчика); очищает «вернуть».
     * @param {object} before
     * @param {object} after
     * @param {object|((unit: object) => object)} [meta] описание действия или функция, которая строит его по готовой единице
     * @returns {false | {rollback: () => void}} `false`, если рабочая область не изменилась; иначе ручка отката записи (при отказе пересчёта)
     */
    record(before, after, meta) {
      const unit = diff_unit(before, after, typeof meta === 'function' ? {} : meta);
      if (unit === null) return false;
      if (typeof meta === 'function') {
        let m = null;
        try { m = meta(unit); } catch { m = null; }
        unit.meta = is_obj(m) ? m : { kind: 'other' };
      }
      const saved_redo = redo.slice();
      const dropped = put(undo, unit);
      redo.length = 0;
      return {
        rollback() {
          const i = undo.lastIndexOf(unit);
          if (i >= 0) undo.splice(i, 1);
          if (dropped !== undefined) undo.unshift(dropped);
          redo.length = 0;
          redo.push(...saved_redo);
        },
      };
    },
    can_undo: () => undo.length > 0,
    can_redo: () => redo.length > 0,
    peek_undo: () => (undo.length === 0 ? null : undo[undo.length - 1].meta),
    peek_redo: () => (redo.length === 0 ? null : redo[redo.length - 1].meta),
    undo: (ctx) => run(ctx, undo, redo, 'undo'),
    redo: (ctx) => run(ctx, redo, undo, 'redo'),
    clear() { undo.length = 0; redo.length = 0; },
    size: () => ({ undo: undo.length, redo: redo.length }),
  };
}

/**
 * Записать в стопку действие, о котором сообщил `ctx.subscribe` (`{reason, ws, before, meta, undo}`). Подписчик пакета вызывает её на каждое событие.
 * Не пишет: исключённые причины (`UNDO_EXCLUDED_REASONS`), действия с признаком `undo: 'recorded'` (стопка записала их сама до общего пути),
 * события без рабочей области «до» и «после» и правки без разницы. Если разность построить нельзя, стопка очищается: прежние единицы
 * не опираются на состояние, которое нельзя описать.
 * @param {ReturnType<typeof create_undo_stack>} stack
 * @param {{reason?: string, ws?: object, before?: object|null, meta?: object|null, undo?: string|null}} info
 * @returns {boolean} единица записана
 */
export function auto_record(stack, info) {
  if (!is_obj(info) || typeof info.reason !== 'string') return false;
  if (info.undo === UNDO_RECORDED || UNDO_EXCLUDED_REASONS.includes(info.reason)) return false;
  if (!is_obj(info.before) || !is_obj(info.ws)) return false;
  try {
    const meta = is_obj(info.meta) ? info.meta : (unit) => describe_unit(info.reason, unit, info.ws);
    return stack.record(info.before, info.ws, meta) !== false;
  } catch {
    stack.clear();
    return false;
  }
}

// ── кнопки навигации (DOM) ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Пара кнопок «Отменить» и «Вернуть» для слота `nav.actions`. Состояние (доступность и подпись действия) читается при каждой перерисовке
 * страницы: она происходит после каждой правки.
 * @param {object} ctx контекст расширений
 * @param {ReturnType<typeof create_undo_stack>} stack
 * @param {(minor: number, currency: string) => string} money форматтер денег с валютой
 * @param {{on_done?: (kind: 'undo'|'redo', r: object) => void}} [hooks]
 * @returns {HTMLElement}
 */
export function render_undo_buttons(ctx, stack, money, hooks = {}) {
  const label_of = (meta) => unit_label(meta, ctx.tr, money);
  const btn = (kind, text_key, label_key, meta) => h('button', {
    type: 'button',
    class: 'btn undo-btn',
    disabled: meta === null,
    'aria-label': meta === null ? null : ctx.tr(label_key, { what: label_of(meta) }),
    onclick: () => {
      const r = kind === 'undo' ? stack.undo(ctx) : stack.redo(ctx);
      hooks.on_done?.(kind, r);
    },
    text: ctx.tr(text_key),
  });
  return h('span', { class: 'undo-group' },
    btn('undo', 'entry.nav_undo', 'entry.nav_undo_label', stack.peek_undo()),
    btn('redo', 'entry.nav_redo', 'entry.nav_redo_label', stack.peek_redo()));
}
