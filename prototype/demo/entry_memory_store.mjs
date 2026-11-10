// entry_memory_store.mjs — «последний использованный счёт» в быстром вводе переживает перезагрузку страницы (FP-22, REQ-090).
//
// Что было. `entry.create_entry_memory()` помнит счёт только в пределах страницы: после перезагрузки быстрый ввод брал счёт самого позднего факта, что близко, но не одно и то же.
// Что стало. Та же память с записью на устройство: `localStorage` под ключом `runway-entry-memory/1` (префикс `runway`: его находит и стирает «Удалить все данные» — список ключей
// очистки в `data_actions.erase_all` строится по этому префиксу; чужие ключи общего localhost не трогаются). Хранится только пара «ключ рабочей области → идентификатор счёта»
// (идентификаторы создаёт приложение, а не пользовательский текст); сумм, названий и дат нет. Хранилища нет или оно не пишет (приватный режим, заглушка) — память страницы, как раньше.
//
// Как работает. `get` читает страницу-кэш, затем хранилище; `remember` пишет в кэш и в хранилище. `forget()` (его зовёт пакет FP-04 при смене набора данных — и при каждой загрузке
// страницы, потому что набор подставляется событием `adopt`) очищает ТОЛЬКО кэш страницы: сохранённое на устройстве остаётся и читается снова. Так можно: запомненный счёт
// `entry.default_account_id` берёт, лишь если он открыт в текущем наборе, иначе — счёт последнего факта. Если ключ исчез после записи («Удалить все данные»), кэш тоже сбрасывается:
// удалённое не воскресает до первого нового ввода.
//
// Модуль без DOM и без часов; хранилище — аргумент. Расчёт по введённым данным и правилам, не консультация.

/** Ключ localStorage (префикс `runway` — его стирает «Удалить все данные»). */
export const ENTRY_MEMORY_KEY = 'runway-entry-memory/1';

/** Сколько рабочих областей помнит хранилище (старейшая вытесняется). */
export const MAX_ENTRIES = 16;

const BAD = /[\u0000-\u001f|]/;
const ws_key = (ws) => String(ws?.workspace_id ?? '').slice(0, 64);
const ok_id = (x) => typeof x === 'string' && x !== '' && x.length <= 128 && !BAD.test(x) && x !== '__proto__' && x !== 'constructor' && x !== 'prototype';

/** localStorage или `null` (приватные режимы, запрет хранилища и Node: обращение может бросить исключение). */
export function local_storage_or_null() {
  try {
    const s = globalThis.localStorage;
    return s !== null && s !== undefined && typeof s.getItem === 'function' && typeof s.setItem === 'function' ? s : null;
  } catch { return null; }
}

/** Разобрать содержимое ключа: `[[ключ рабочей области, счёт], …]`; негодное — пусто. */
export function accept_entries(raw) {
  let x;
  try { x = JSON.parse(raw); } catch { return []; }
  if (x === null || typeof x !== 'object' || Array.isArray(x) || x.v !== 1 || !Array.isArray(x.items)) return [];
  const out = [];
  for (const it of x.items.slice(0, MAX_ENTRIES)) {
    if (!Array.isArray(it) || it.length !== 2 || typeof it[0] !== 'string' || it[0].length > 64 || !ok_id(it[1])) continue;
    if (out.some((p) => p[0] === it[0])) continue;
    out.push([it[0], it[1]]);
  }
  return out;
}

/**
 * Память последнего использованного счёта с записью на устройство.
 * @param {{getItem: Function, setItem: Function}|null} [storage] localStorage; `null` — только память страницы
 * @returns {{get: (ws: object) => string|null, remember: (ws: object, account_id: string) => void, forget: () => void}}
 *   тот же вид, что у `entry.create_entry_memory()`
 */
export function create_persisted_entry_memory(storage = null) {
  const cache = new Map();
  let seen = false; // ключ записан и прочитан обратно этой страницей: его исчезновение — удаление пользователем

  const read = () => {
    if (storage === null) return null;
    let raw = null;
    try { raw = storage.getItem(ENTRY_MEMORY_KEY); } catch { raw = null; }
    if (typeof raw === 'string') { seen = true; return accept_entries(raw); }
    if (seen) { seen = false; cache.clear(); } // «Удалить все данные»: не воскрешаем удалённое из кэша
    return null;
  };

  return {
    get(ws) {
      const key = ws_key(ws);
      const stored = read();
      if (stored !== null) {
        const hit = stored.find((p) => p[0] === key);
        if (hit !== undefined) return hit[1];
      }
      return cache.get(key) ?? null;
    },
    remember(ws, account_id) {
      if (!ok_id(account_id)) return;
      const key = ws_key(ws);
      cache.set(key, account_id);
      if (storage === null) return;
      const stored = read() ?? [];
      if (stored.some((p) => p[0] === key && p[1] === account_id)) return;
      const next = [...stored.filter((p) => p[0] !== key), [key, account_id]].slice(-MAX_ENTRIES);
      const text = JSON.stringify({ v: 1, items: next });
      try {
        storage.setItem(ENTRY_MEMORY_KEY, text);
        seen = storage.getItem(ENTRY_MEMORY_KEY) === text; // заглушка, которая не хранит, остаётся памятью страницы
      } catch { seen = false; /* места нет: счёт помнится до перезагрузки */ }
    },
    forget() { cache.clear(); },
  };
}
