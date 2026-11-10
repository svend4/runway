// ids.mjs — генератор идентификаторов (uuidv7-подобный) с внедряемыми портами часов и случайности (FP-01, REQ-012, ADR-004).
// Канон: `event_id` и `batch_id` — uuidv7 («создаёт адаптер, не меняется», product/04); `*_id` сущностей — строка, уникальная в рабочей области.
// Модуль не читает часы и не обращается к случайности сам: всё приходит портами `{ now_ms(): number, random(): number }`.
// Единственное исключение — `system_ports()`: фабрика, которую вызывает приложение (браузер), а не тесты и не движок.
// Идентификаторы не секретны и не содержат пользовательского текста.

import { format_date } from '../engine/index.mjs';

/** Шаблон uuidv7 (версия 7, вариант RFC 9562). */
export const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Ключи, которые нельзя использовать как идентификаторы и как имена полей (загрязнение прототипа). */
export const FORBIDDEN_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

/** Допустимый идентификатор сущности: непустая строка до 128 знаков без `|`, управляющих знаков и пробелов по краям; не «опасный» ключ. */
export function is_valid_id(x) {
  if (typeof x !== 'string' || x === '' || x.length > 128) return false;
  if (x.includes('|') || x !== x.trim() || /[\u0000-\u001f\u007f]/.test(x)) return false;
  return !FORBIDDEN_KEYS.includes(x);
}

const hex = (n, width) => n.toString(16).padStart(width, '0');

/** Целое в [0, n) из порта случайности (`random()` ∈ [0, 1)); защита от плохого порта. */
function rnd_int(random, n) {
  const r = random();
  if (typeof r !== 'number' || !(r >= 0) || r >= 1) throw new RangeError('порт random() обязан возвращать число из [0, 1)');
  return Math.floor(r * n);
}

/**
 * Собрать uuidv7 из момента (мс от эпохи Unix), 12-битного счётчика и портов случайности.
 * Формат: 48 бит времени · версия 7 · 12 бит `rand_a` (здесь — монотонный счётчик внутри миллисекунды) · вариант 10 · 62 бита `rand_b`.
 * @param {number} ms
 * @param {number} counter 0…4095
 * @param {() => number} random
 * @returns {string}
 */
export function uuidv7_from(ms, counter, random) {
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > 0xffffffffffff) throw new RangeError('время вне диапазона 48 бит');
  const t = hex(ms, 12);
  const b = [rnd_int(random, 0x4000), rnd_int(random, 0x10000), rnd_int(random, 0x10000), rnd_int(random, 0x10000)];
  const variant = 0x8000 | b[0]; // 10 + 14 бит
  return `${t.slice(0, 8)}-${t.slice(8)}-7${hex(counter & 0xfff, 3)}-${hex(variant, 4)}-${hex(b[1], 4)}${hex(b[2], 4)}${hex(b[3], 4)}`;
}

/**
 * Генератор идентификаторов. Порядок: каждый следующий `next()` строго больше предыдущего (лексикографически), даже если
 * часы стоят или идут назад (RFC 9562, метод 1: счётчик внутри миллисекунды; при переполнении счётчика время сдвигается на 1 мс).
 * @param {{now_ms: () => number, random: () => number}} ports
 * @returns {{next: () => string, entity: (prefix: string) => string, instant: () => string}}
 */
export function make_id_gen(ports) {
  if (ports === null || typeof ports !== 'object' || typeof ports.now_ms !== 'function' || typeof ports.random !== 'function') {
    throw new TypeError('make_id_gen: нужны порты { now_ms, random }');
  }
  let last_ms = -1;
  let counter = 0;
  const tick = () => {
    const now = ports.now_ms();
    if (!Number.isSafeInteger(now) || now < 0) throw new RangeError('порт now_ms() обязан возвращать неотрицательное целое');
    if (now > last_ms) {
      last_ms = now;
      counter = rnd_int(ports.random, 0x800); // старший бит счётчика свободен: запас на 2048 id в одной миллисекунде
    } else {
      counter += 1;
      if (counter > 0xfff) { last_ms += 1; counter = rnd_int(ports.random, 0x800); }
    }
    return { ms: last_ms, counter };
  };
  const next = () => {
    const { ms, counter: c } = tick();
    return uuidv7_from(ms, c, ports.random);
  };
  return {
    /** Новый uuidv7 (для `event_id`, `batch_id`). */
    next,
    /** Идентификатор сущности вида `rule_7f3a9c21b4d0` (префикс — `[a-z][a-z0-9]{0,15}`; хвост — случайные знаки uuidv7). */
    entity(prefix) {
      if (typeof prefix !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(prefix)) throw new RangeError('префикс идентификатора: a-z, 0-9, до 16 знаков');
      const id = next().replace(/-/g, '');
      return prefix + '_' + id.slice(-12);
    },
    /** Момент ввода `YYYY-MM-DDTHH:MM:SSZ` по порту часов (для `recorded_at`). */
    instant() {
      const now = ports.now_ms();
      return instant_of_ms(now);
    },
  };
}

/**
 * Момент `YYYY-MM-DDTHH:MM:SSZ` из миллисекунд эпохи Unix — без `Date` (целочисленная арифметика + `format_date`).
 * @param {number} ms
 * @returns {string}
 */
export function instant_of_ms(ms) {
  if (!Number.isSafeInteger(ms) || ms < 0) throw new RangeError('мс вне диапазона');
  const secs = Math.floor(ms / 1000);
  const day = Math.floor(secs / 86400);
  const rest = secs - day * 86400;
  const p2 = (n) => String(n).padStart(2, '0');
  return `${format_date(day)}T${p2(Math.floor(rest / 3600))}:${p2(Math.floor((rest % 3600) / 60))}:${p2(rest % 60)}Z`;
}

/**
 * Порты для браузера: часы и случайность системы. Вызывает приложение (`ext.mjs`), не тесты. Если `crypto` недоступен — отказ,
 * а не тихий `Math.random` (идентификаторы не должны становиться предсказуемыми молча).
 * @returns {{now_ms: () => number, random: () => number}}
 */
export function system_ports() {
  const c = globalThis.crypto;
  if (c === undefined || typeof c.getRandomValues !== 'function') throw new Error('нет crypto.getRandomValues: идентификаторы не создаются');
  const buf = new Uint32Array(1);
  return {
    now_ms: () => Date.now(),
    random: () => { c.getRandomValues(buf); return buf[0] / 4294967296; },
  };
}

/**
 * Детерминированные порты для тестов и воспроизводимых сборок: часы идут по шагу `step_ms`, случайность — mulberry32 от `seed`.
 * @param {{seed?: number, start_ms?: number, step_ms?: number}} [opts]
 * @returns {{now_ms: () => number, random: () => number}}
 */
export function seeded_ports(opts = {}) {
  let a = (opts.seed ?? 1) >>> 0;
  let now = opts.start_ms ?? 1_790_000_000_000; // 2026-09-21 — произвольная точка отсчёта
  const step = opts.step_ms ?? 1;
  return {
    now_ms: () => { const v = now; now += step; return v; },
    random: () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/**
 * Порты «сегодня» для браузера: часы и смещение часового пояса в минутах к востоку от UTC (Германия зимой +60, летом +120).
 * Вызывает приложение (экран «Настройки»), не тесты: в тестах порты подставляются.
 * @returns {{now_ms: () => number, tz_offset_min: () => number}}
 */
export function clock_ports() {
  return { now_ms: () => Date.now(), tz_offset_min: () => -new Date().getTimezoneOffset() };
}

/**
 * Календарная дата «сегодня» по местному времени: `YYYY-MM-DD`. Чистая функция портов (без `Date`): местная дата = UTC-дата момента,
 * сдвинутого на смещение пояса. Нужна, чтобы «взять дату с часов» не давала вчерашний день возле полуночи.
 * Без `tz_offset_min` смещение 0, то есть UTC-дата: это контракт функции (закреплён тестом as_of.test.mjs), приложение всегда передаёт смещение
 * (`clock_ports`), а страница v0 дополняет порт смещением устройства (FP-50, D-4).
 * @param {{now_ms: () => number, tz_offset_min?: () => number}} ports
 * @returns {string}
 */
export function local_today(ports) {
  const off = typeof ports.tz_offset_min === 'function' ? ports.tz_offset_min() : 0;
  if (!Number.isInteger(off) || off < -14 * 60 || off > 14 * 60) throw new RangeError('смещение пояса вне диапазона');
  return instant_of_ms(ports.now_ms() + off * 60000).slice(0, 10);
}
