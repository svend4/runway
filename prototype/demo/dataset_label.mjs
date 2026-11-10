// dataset_label.mjs — честная подпись источника данных в переключателе «Набор данных» (FP-48).
//
// Дефект прохода в браузере 2026-10-26: после «Продолжить с сохранённого» (и после «Восстановить из файла») рабочая область подменяется целиком, а переключатель в шапке
// продолжал показывать «G-001 — эталон», хотя данные уже пользовательские. Страница помнит только `dataset_id` последнего ВСТРОЕННОГО набора, а откуда данные взялись, не знает.
// Здесь это знание собирается из событий реестра (`ctx.subscribe`):
//   - `adopt` с идентификатором встроенного набора → данные «как в наборе» (подпись набора);
//   - `adopt` с `custom` (файл, открытый на экране «Данные») → «Файл: имя»;
//   - `restore` без `origin` («Продолжить с сохранённого», подтяжка записей другой вкладки) → «Мои данные (с устройства)»;
//   - `restore` с `origin: {kind: 'file', name}` («Восстановить из файла») → «Файл: имя».
// Файл без имени (копия без названия, имя из одних управляющих знаков) называется «Загруженный файл» (FP-49), а не молчит: иначе после «Восстановить из файла» остался бы встроенный «G-001 — эталон».
// Встроенный набор или файл, который пользователь уже правил, называется так же, но с пометкой «изменён»: «G-001 — эталон · изменён». «Изменён» — это сравнение нынешней
// рабочей области с той, что была принята как основа (канонический вид `canon`, результат запоминается по ссылке на область): «Отменить» до основы пометку снимает.
// Хук `dataset_label` отвечает `{value: 'custom', text}` — пункт, который страница ставит выбранным вместо встроенного; `undefined` — прежние подписи страницы. Выбор
// встроенного набора из списка по-прежнему загружает его (пункт `custom` ничего не загружает). Модуль чистый: без DOM, часов и случайности; название файла — только короткая
// строка без управляющих знаков, в страницу оно попадает через textContent. Расчёт по введённым данным и правилам, не консультация.
// FP-49 (исправление после проверки): у пункта «встроенный набор · изменён» в ответе есть поле `builtin` — идентификатор этого набора. По нему страница отличает правленый встроенный
// набор от пунктов «Мои данные» и «Файл: …» (у них поля нет): кнопка «Вернуть выбранный набор» на экране «Данные» при пункте-источнике отключена, а у правленого встроенного набора включена —
// в списке назван именно он, и вернуть его исходное содержимое — прямая работа кнопки.

import { canon } from '../engine/index.mjs';
import { DATASETS } from './i18n.mjs';

/** Идентификаторы встроенных наборов (как в `DATASETS` страницы). */
export const BUILTIN_IDS = Object.freeze(DATASETS.map((d) => d.id));

/** Значение пункта «не встроенный набор» (то же, что у «Загруженного файла» страницы). */
export const CUSTOM = 'custom';

/** Сколько знаков имени файла показывает подпись. */
export const NAME_MAX = 60;

const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/**
 * Имя файла для подписи: без управляющих знаков и крайних пробелов, не длиннее `NAME_MAX` (длиннее — с многоточием). Не строка — пустая строка.
 * @param {unknown} x
 * @returns {string}
 */
export function clean_name(x) {
  if (typeof x !== 'string') return '';
  const s = x.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim();
  return s.length > NAME_MAX ? s.slice(0, NAME_MAX - 1) + '…' : s;
}

/**
 * Источник данных после события реестра.
 * @param {object|null} prev прежний источник
 * @param {{reason?: string, ws?: object, dataset_id?: string|null, file_name?: string|null, origin?: {kind?: string, name?: string}|null}} info событие `ctx.subscribe`
 * @returns {{kind: 'dataset', id: string, base: object}|{kind: 'file', name: string, base: object}|{kind: 'device', base: object}|null}
 */
export function origin_after(prev, info) {
  if (!is_obj(info)) return prev;
  if (info.reason === 'adopt') {
    if (typeof info.dataset_id === 'string' && BUILTIN_IDS.includes(info.dataset_id)) return { kind: 'dataset', id: info.dataset_id, base: info.ws };
    return { kind: 'file', name: clean_name(info.file_name), base: info.ws };
  }
  if (info.reason === 'restore') {
    const o = info.origin;
    if (is_obj(o) && o.kind === 'file') return { kind: 'file', name: clean_name(o.name), base: info.ws };
    return { kind: 'device', base: info.ws };
  }
  return prev;
}

/**
 * Подпись пункта. `undefined` — сказать нечего (встроенный набор без правок): страница рисует свои подписи.
 * Источник «файл» называется всегда: с именем — «Файл: имя», без имени (файл-копия без названия, имя из одних управляющих знаков) — «Загруженный файл» (`ds.custom`); после правки к любой из подписей
 * добавляется «· изменён». FP-49: раньше безымянный файл без правок молчал, и после «Восстановить из файла» переключатель оставался на встроенном «G-001 — эталон», хотя данные из файла.
 * Правленый встроенный набор несёт в ответе `builtin` — идентификатор набора (только если он из `BUILTIN_IDS`); у «Мои данные» и «Файл: …» этого поля нет.
 * @param {(key: string, params?: object) => string} tr
 * @param {{kind: string, id?: string, name?: string}|null} origin
 * @param {boolean} changed правили ли данные после того, как они были приняты
 * @returns {{value: string, text: string, builtin?: string}|undefined}
 */
export function label_of(tr, origin, changed) {
  if (origin === null || origin === undefined) return undefined;
  const mark = changed ? ' · ' + tr('dslabel.changed') : '';
  if (origin.kind === 'device') return { value: CUSTOM, text: tr('dslabel.device') };
  if (origin.kind === 'dataset') return changed ? { value: CUSTOM, text: tr('ds.' + origin.id) + mark, ...(BUILTIN_IDS.includes(origin.id) ? { builtin: origin.id } : {}) } : undefined;
  if (origin.kind !== 'file') return undefined;
  if (typeof origin.name !== 'string' || origin.name === '') return { value: CUSTOM, text: tr('ds.custom') + mark };
  return { value: CUSTOM, text: tr('dslabel.file', { name: origin.name }) + mark };
}

/**
 * Сравнение области с основой по корзинам верхнего уровня: корзина, на которую в обеих областях указывает одна и та же ссылка (правка копирует только затронутые корзины),
 * не сравнивается; различающиеся по ссылке — по каноническому виду (`canon`: «Отменить» собирает корзину заново, содержимое прежнее). Канонический вид корзин основы запоминается в `origin.parts`.
 */
function differs(origin, ws) {
  const base = origin.base;
  origin.parts ??= new Map();
  const part = (k) => {
    if (!origin.parts.has(k)) origin.parts.set(k, canon(base[k]));
    return origin.parts.get(k);
  };
  for (const k of new Set([...Object.keys(base), ...Object.keys(ws)])) {
    if (ws[k] === base[k]) continue;
    if (ws[k] === undefined || base[k] === undefined) return true; // корзина появилась или исчезла
    if (canon(ws[k]) !== part(k)) return true;
  }
  return false;
}

/**
 * Отличается ли рабочая область от принятой основы. Для данных «с устройства» пометка не нужна (это и есть данные пользователя) — всегда `false`.
 * Ответ по ссылке на область запоминается в `cache` (`WeakMap`): сравнение идёт один раз на правку, а не на каждую перерисовку; на большом файле канонический вид
 * считается только для затронутых корзин, а не для всей области.
 * @param {{kind: string, base?: object, parts?: Map<string, string>}|null} origin
 * @param {object|null} ws
 * @param {WeakMap<object, boolean>} cache
 */
export function is_changed(origin, ws, cache) {
  if (origin === null || origin.kind === 'device' || !is_obj(ws) || !is_obj(origin.base) || ws === origin.base) return false;
  const hit = cache.get(ws);
  if (hit !== undefined) return hit;
  let r = false;
  try { r = differs(origin, ws); } catch { r = false; } // область не приводится к каноническому виду: правкой её не объявляем
  cache.set(ws, r);
  return r;
}

/**
 * Следопыт источника данных на одну страницу: подписывается на события реестра (`on_event`) и отвечает на хук `dataset_label` (`label`).
 * @returns {{on_event: (info: object) => void, origin: () => object|null, label: (tr: Function, ws: object|null, dataset_id: string) => ({value: string, text: string, builtin?: string}|undefined)}}
 */
export function create_tracker() {
  let origin = null;
  let cache = new WeakMap();
  return {
    on_event(info) {
      const next = origin_after(origin, info);
      if (next === origin) return;
      origin = next;
      cache = new WeakMap();
    },
    origin: () => origin,
    label(tr, ws, dataset_id) {
      if (origin === null) return undefined;
      if (origin.kind === 'dataset' && origin.id !== dataset_id) return undefined; // страница выбрала другой набор, чем помнит следопыт: ничего не утверждаем
      return label_of(tr, origin, is_changed(origin, ws, cache));
    },
  };
}
