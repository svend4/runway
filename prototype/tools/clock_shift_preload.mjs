// clock_shift_preload.mjs — FP-50 (RISK-22): предзагрузка часов и часового пояса для матрицы часов (tools/clock_matrix.mjs).
// Подключается как `NODE_OPTIONS=--import=<file:// URL этого файла>`. Без переменных RUNWAY_CLOCK_* ничего не меняет (тождественна: Date остаётся родным).
// Переменные читаются один раз, при старте процесса:
//   RUNWAY_CLOCK_SHIFT_MS — целое число миллисекунд, прибавляемое к реальным часам. Это сдвиг, а не заморозка: часы идут, интервалы и таймауты не меняются.
//   RUNWAY_CLOCK_LOCAL    — «ГГГГ-ММ-ДД ЧЧ:ММ» или «ЧЧ:ММ»: сдвиг выбирается так, чтобы «сейчас» начиналось с этого местного времени. Без даты берётся
//                           сегодняшняя местная дата пояса. Взаимоисключает RUNWAY_CLOCK_SHIFT_MS.
//   RUNWAY_CLOCK_TZ       — имя пояса IANA (например, Pacific/Kiritimati). Пояс ставится в process.env.TZ здесь, до первого обращения к Date.
//                           Переменная TZ, переданная при запуске, тоже работает (проверено на Windows и Node 24), но путь через process.env.TZ
//                           не зависит от того, как запущен процесс. Неизвестный пояс — отказ с текстом, а не тихий UTC.
// Подмена (только при заданных переменных): globalThis.Date — функция с тем же prototype, что у прежнего Date (instanceof Date, Object.getPrototypeOf
// и Date.prototype сохраняются); Date.UTC и Date.parse — прежние; new Date() без аргументов и Date.now() дают реальное время + сдвиг.
// performance.now(), setTimeout, интервалы и процессы не трогаются.
// Инструмент проверки, не продукт: в приложении и движке часов нет (канон: дата ≠ момент времени; «сегодня» — местная дата порта часов).
// Расчёт по введённым данным и правилам, не консультация.

const OriginalDate = globalThis.Date;

/** Переменные матрицы часов (остальные имена предзагрузка не читает). */
export const CLOCK_VARS = Object.freeze(['RUNWAY_CLOCK_SHIFT_MS', 'RUNWAY_CLOCK_LOCAL', 'RUNWAY_CLOCK_TZ']);

const DAY_MS = 86400000;
const pad = (n, w = 2) => String(n).padStart(w, '0');
const has = (env, k) => env[k] !== undefined && env[k] !== '';

/** Истина, если задана хотя бы одна переменная матрицы часов (пустая строка — не задана). */
export function clock_requested(env = process.env) {
  return CLOCK_VARS.some((k) => has(env, k));
}

/** Местные части времени пояса `zone` в момент `utc_ms` (мс от эпохи Unix). Часы — 0…23 (полночь — 0, не 24). */
export function zone_parts(zone, utc_ms) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  const o = {};
  for (const p of f.formatToParts(new OriginalDate(utc_ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { y: o.year, mo: o.month, d: o.day, h: o.hour % 24, mi: o.minute, s: o.second };
}

/** Смещение пояса `zone` в мс к востоку от UTC в момент `utc_ms` (секунды момента отбрасываются). */
export function zone_offset_ms(zone, utc_ms) {
  const p = zone_parts(zone, utc_ms);
  const wall = OriginalDate.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return wall - Math.floor(utc_ms / 1000) * 1000;
}

/** Момент (мс от эпохи Unix), в который местные часы пояса `zone` показывают `ГГГГ-ММ-ДД ЧЧ:ММ` (две итерации — для переходов на летнее время). */
export function wall_to_utc_ms(zone, y, mo, d, h, mi) {
  const wall = OriginalDate.UTC(y, mo - 1, d, h, mi, 0);
  const first = wall - zone_offset_ms(zone, wall);
  return wall - zone_offset_ms(zone, first);
}

/** Местная календарная дата пояса `zone` в момент `utc_ms`: `ГГГГ-ММ-ДД`. */
export function local_date_in(zone, utc_ms) {
  const p = zone_parts(zone, utc_ms);
  return `${pad(p.y, 4)}-${pad(p.mo)}-${pad(p.d)}`;
}

/** Разбор RUNWAY_CLOCK_LOCAL: `ГГГГ-ММ-ДД ЧЧ:ММ` или `ЧЧ:ММ` (дата — `null`). Неверный текст — RangeError с объяснением. */
export function parse_local(text) {
  const m = /^(?:(\d{4})-(\d{2})-(\d{2})\s+)?(\d{2}):(\d{2})$/.exec(String(text).trim());
  if (m === null) throw new RangeError(`RUNWAY_CLOCK_LOCAL: ожидается «ГГГГ-ММ-ДД ЧЧ:ММ» или «ЧЧ:ММ», получено «${text}»`);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  if (h > 23 || mi > 59) throw new RangeError(`RUNWAY_CLOCK_LOCAL: время вне диапазона: «${text}»`);
  if (m[1] === undefined) return { date: null, h, mi };
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const back = new OriginalDate(OriginalDate.UTC(y, mo - 1, d));
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) throw new RangeError(`RUNWAY_CLOCK_LOCAL: такой даты нет: «${text}»`);
  return { date: `${m[1]}-${m[2]}-${m[3]}`, h, mi };
}

/**
 * Сдвиг в мс от реального момента `real_ms`: по RUNWAY_CLOCK_LOCAL (местное время в поясе RUNWAY_CLOCK_TZ, а без него — в поясе `system_zone`),
 * либо RUNWAY_CLOCK_SHIFT_MS (целое), иначе 0. Задавать обе переменные сдвига — ошибка.
 */
export function clock_shift_ms(env, real_ms, system_zone) {
  if (has(env, 'RUNWAY_CLOCK_SHIFT_MS') && has(env, 'RUNWAY_CLOCK_LOCAL')) throw new RangeError('задайте одно из RUNWAY_CLOCK_SHIFT_MS и RUNWAY_CLOCK_LOCAL, не оба');
  if (has(env, 'RUNWAY_CLOCK_LOCAL')) {
    const zone = has(env, 'RUNWAY_CLOCK_TZ') ? env.RUNWAY_CLOCK_TZ : system_zone;
    const { date, h, mi } = parse_local(env.RUNWAY_CLOCK_LOCAL);
    const [y, mo, d] = (date ?? local_date_in(zone, real_ms)).split('-').map(Number);
    return wall_to_utc_ms(zone, y, mo, d, h, mi) - real_ms;
  }
  if (has(env, 'RUNWAY_CLOCK_SHIFT_MS')) {
    const n = Number(env.RUNWAY_CLOCK_SHIFT_MS);
    if (!Number.isSafeInteger(n)) throw new RangeError('RUNWAY_CLOCK_SHIFT_MS: ожидается целое число миллисекунд');
    return n;
  }
  return 0;
}

/** Выставить пояс: проверка через Intl (неизвестный пояс бросает), затем process.env.TZ и сверка смещения по текущему моменту. */
export function apply_zone(zone, real_ms) {
  new Intl.DateTimeFormat('en-US', { timeZone: zone }); // RangeError на неизвестный пояс
  process.env.TZ = zone;
  const want = -zone_offset_ms(zone, real_ms) / 60000;
  const got = new OriginalDate(real_ms).getTimezoneOffset();
  return { zone, want_offset_min: want, got_offset_min: got, ok: got === want };
}

/**
 * Подменить globalThis.Date. Новый класс-функция: prototype — прежний Date.prototype, Date.UTC и Date.parse — прежние,
 * new Date() без аргументов и Date.now() — реальное время + shift_ms. Вызов без new возвращает строку, как и прежний Date.
 */
export function install_date(shift_ms) {
  const shifted_now = () => OriginalDate.now() + shift_ms;
  function Date_shifted(...args) {
    if (new.target === undefined) return new OriginalDate(shifted_now()).toString();
    return Reflect.construct(OriginalDate, args.length === 0 ? [shifted_now()] : args, new.target);
  }
  Date_shifted.prototype = OriginalDate.prototype;
  Date_shifted.now = () => shifted_now();
  Date_shifted.UTC = OriginalDate.UTC;
  Date_shifted.parse = OriginalDate.parse;
  Object.defineProperty(Date_shifted, 'name', { value: 'Date' });
  Object.defineProperty(Date_shifted, 'length', { value: 7 });
  Object.defineProperty(globalThis, 'Date', { value: Date_shifted, writable: true, enumerable: false, configurable: true });
  return Date_shifted;
}

/** Применить переменные к процессу; без переменных — ничего не делает. Возвращает сведения для проверки. */
export function activate(env) {
  if (!clock_requested(env)) return { active: false, shift_ms: 0, zone: null, zone_ok: true, native_date: true };
  const real = OriginalDate.now();
  const system_zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const shift = clock_shift_ms(env, real, system_zone);
  let zone_info = null;
  if (has(env, 'RUNWAY_CLOCK_TZ')) zone_info = apply_zone(env.RUNWAY_CLOCK_TZ, real);
  install_date(shift);
  if (zone_info !== null && !zone_info.ok) process.stderr.write(`clock_shift_preload: пояс «${zone_info.zone}» не применился (смещение ${zone_info.got_offset_min} мин вместо ${zone_info.want_offset_min})\n`);
  return { active: true, shift_ms: shift, zone: zone_info?.zone ?? null, zone_ok: zone_info === null ? true : zone_info.ok, native_date: false, days: shift / DAY_MS };
}

/**
 * Состояние предзагрузки процесса (для проверки и отчётов): что применено при старте. Единственное место применения:
 * модуль выполняется один раз на процесс (кэш модулей), поэтому повторный импорт того же URL ничего не сдвигает второй раз.
 */
export const STATE = Object.freeze(activate(process.env));
