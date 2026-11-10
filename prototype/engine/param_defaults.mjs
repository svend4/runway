// param_defaults.mjs — значения параметров по умолчанию как ДАННЫЕ (FP-17, REQ-019): чтение сгенерированного из vocab.json модуля
// `vocab.generated.mjs` и сравнение действующих значений рабочей области с умолчаниями. Литералов-умолчаний в этом модуле нет.
// Применение: зеркала `TIMELINE_DEFAULTS` / `CALIBRATION_DEFAULTS` / `BACKTEST_DEFAULTS` и запасные значения в `fx` / `index` собираются через `vdefault`;
// экран «Настройки» показывает «по умолчанию N» рядом с действующим значением (`describe_param`) и предлагает «вернуть по умолчанию».
// Модуль чистый: ни часов, ни случайности, ни ввода-вывода; из index.mjs не реэкспортируется (низший слой: на него ссылается ядро).
// Расчёт по введённым данным и правилам, не консультация.

import { VOCAB_PARAMS } from './vocab.generated.mjs';

const own = (o, k) => Object.hasOwn(o, k);
const is_obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/**
 * Значение по умолчанию параметра (`null` — «не задан»).
 * @param {string} key ключ как в `vocab.json → params`
 * @returns {number|string|boolean|null}
 * @throws {RangeError} такого параметра нет в словаре (опечатка в ключе — ошибка при загрузке модуля, а не молчаливый `undefined`)
 */
export function vdefault(key) {
  if (typeof key !== 'string' || !own(VOCAB_PARAMS, key)) throw new RangeError('param_defaults: нет параметра ' + String(key));
  return VOCAB_PARAMS[key].default;
}

/** Ключи параметров словаря (порядок — как в `vocab.json`). */
export function param_keys() {
  return Object.keys(VOCAB_PARAMS);
}

/**
 * Запись словаря о параметре.
 * @param {string} key
 * @returns {{key: string, default: number|string|boolean|null, hypothesis: boolean, phase: string|null, note: string|null}|null} `null`, если параметра нет
 */
export function param_entry(key) {
  if (typeof key !== 'string' || !own(VOCAB_PARAMS, key)) return null;
  const p = VOCAB_PARAMS[key];
  return { key, default: p.default, hypothesis: p.hypothesis === true, phase: typeof p.phase === 'string' ? p.phase : null, note: typeof p.note === 'string' ? p.note : null };
}

/**
 * Сравнить действующее значение параметра с умолчанием.
 * `explicit` — ключ записан в `params` рабочей области (включая явный `null`); если ключа нет, действует умолчание.
 * @param {string} key
 * @param {object|null|undefined} params `ws.params` (плоские ключи с точкой в имени)
 * @returns {{key: string, default: number|string|boolean|null, explicit: boolean, value: number|string|boolean|null, is_default: boolean,
 *   hypothesis: boolean, phase: string|null, note: string|null}|null} `null`, если параметра нет в словаре
 */
export function describe_param(key, params) {
  const e = param_entry(key);
  if (e === null) return null;
  const p = is_obj(params) ? params : {};
  const explicit = own(p, key);
  const value = explicit ? (p[key] === undefined ? null : p[key]) : e.default;
  return { ...e, explicit, value, is_default: value === e.default };
}

/** Описание всех параметров словаря (или переданных ключей) для таблицы «действующее / по умолчанию». */
export function describe_params(params, keys = param_keys()) {
  return keys.map((k) => describe_param(k, params)).filter((x) => x !== null);
}
