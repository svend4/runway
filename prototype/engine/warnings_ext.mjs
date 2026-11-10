// warnings_ext.mjs — служебные предупреждения расширений движка (FP-02): коды, которых НЕТ в реестре vocab.json.
// Реестр vocab.json закрыт решением владельца (К-39: 16 кодов W_*, тест purity.test.mjs считает их точно), поэтому новые коды живут здесь
// до решения К-15/К-39: у них есть текст RU/EN и список полей, но в vocab.json они не попадают, а интерфейс показывает общий текст «warn.other».
// Модуль чистый: данные и две функции, без зависимостей (вне карты слоёв §14 B4: ни от кого не зависит, кроме проверки циклов).
// Все числа в расчётах — расчёт по введённым данным и правилам, не консультация.

/**
 * Реестр служебных предупреждений. Поля `fields` — какие ключи (кроме `code`) несёт предупреждение; значения — идентификаторы и целые.
 * @type {Readonly<Record<string, {ru: string, en: string, fields: readonly string[], note: string}>>}
 */
export const EXT_WARNING_CODES = Object.freeze({
  W_TRANSFER_UNPAIRED: Object.freeze({
    ru: 'у перевода введена только одна нога: расход учтён в прогнозе, парной записи нет',
    en: 'only one leg of the transfer is entered: the outflow is counted in the forecast, the paired entry is missing',
    fields: Object.freeze(['transfer_id']),
    note: 'Q-01, К-15: одиночная нога не исключается как «внутренний» перевод',
  }),
  W_PARAM_OUT_OF_RANGE: Object.freeze({
    ru: 'параметр вне допустимого диапазона: вместо него взято значение по умолчанию',
    en: 'a parameter is outside the allowed range: the default value is used instead',
    fields: Object.freeze(['key']),
    note: 'Q-12, К-4: чужой журнал не может задать горизонт в 10^9 дней',
  }),
  W_RECORD_QUARANTINED: Object.freeze({
    ru: 'запись не прошла проверку и исключена из расчёта',
    en: 'a record failed validation and is excluded from the calculation',
    fields: Object.freeze(['kind', 'id', 'code']),
    note: 'Q-22: режим карантина, один невалидный объект не роняет весь расчёт',
  }),
  W_OVERRIDE_SIGN: Object.freeze({
    ru: 'у правки суммы знак не совпадает со знаком правила',
    en: 'the sign of the amount override differs from the sign of the rule',
    fields: Object.freeze(['rule_id', 'nominal_date']),
    note: 'Q-17, К-5: движок на уже записанных журналах поведение не меняет',
  }),
  W_HOURS_KEY_IGNORED: Object.freeze({
    ru: 'ключ часов периода не совпал с началом периода и не учтён',
    en: 'a period hours key does not match the period start and is ignored',
    fields: Object.freeze(['stream_id', 'key']),
    note: 'Q-30, К-39: hourly.expand_stream_ex выдаёт код, которого нет в vocab.json; интерфейс показывал общий текст',
  }),
  W_RESERVE_CLIPPED: Object.freeze({
    ru: 'запись резерва больше накопленного: излишек не учтён',
    en: 'a reserve entry exceeds the accumulated amount: the excess is not counted',
    fields: Object.freeze(['reserve_id', 'clipped_minor']),
    note: 'Q-20, К-13: reserve_open_ex возвращает clipped_minor и список отброшенных записей',
  }),
  W_DEBT_BEYOND_HORIZON: Object.freeze({
    ru: 'часть платежей по долгу лежит за горизонтом прогноза и в «свободно» не входит',
    en: 'part of the debt payments lies beyond the forecast horizon and is not included in "free"',
    fields: Object.freeze(['debt_id', 'count', 'total_minor', 'currency']),
    note: 'FP-14, REQ-082: build_events отбрасывал платежи графика за horizon_end молча; теперь по каждому долгу — число и сумма таких платежей',
  }),
});

/**
 * Служебное ли предупреждение (код из этого реестра).
 * @param {string|{code?: string}} x код или предупреждение
 * @returns {boolean}
 */
export function is_ext_warning(x) {
  const code = typeof x === 'string' ? x : x?.code;
  return typeof code === 'string' && Object.hasOwn(EXT_WARNING_CODES, code);
}

/**
 * Текст служебного предупреждения (без подстановки значений: идентификаторы и числа показывает вызывающий отдельной строкой).
 * Неизвестный код — `null`, не исключение: интерфейс падает на общий текст.
 * @param {string|{code?: string}} w
 * @param {'ru'|'en'} [locale]
 * @returns {string|null}
 */
export function ext_warning_text(w, locale = 'ru') {
  const code = typeof w === 'string' ? w : w?.code;
  if (!is_ext_warning(code)) return null;
  const e = EXT_WARNING_CODES[code];
  return locale === 'en' ? e.en : e.ru;
}

/**
 * Разделить предупреждения на реестровые (vocab.json) и служебные (этот модуль); порядок внутри групп сохраняется.
 * @param {{code?: string}[]} warnings
 * @returns {{registry: object[], ext: object[]}}
 */
export function split_warnings(warnings) {
  const registry = [];
  const ext = [];
  for (const w of Array.isArray(warnings) ? warnings : []) (is_ext_warning(w) ? ext : registry).push(w);
  return { registry, ext };
}
