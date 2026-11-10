// verifier.mjs — рендер ответа по шаблонам и независимая проверка чисел (ALG-12, ADR-010, ADR-013).
// Принцип: число пишет только движок. Ответ — структура утверждений-шаблонов с плейсхолдерами `{eN}` (evidence) и `{q.…}` (эхо вопроса);
// значения подставляет рендерер по виду и локали, итоговый текст независимо разбирает верификатор (слой 2) и сверяет с evidence ∪ эхо.
// Слой 1 (`check_structure`) проверяет структуру; оба слоя fail-closed: неоднозначное — нарушение. Верификатор сверяет токены чисел,
// а не смысл: верный по числам, но неверный по выводу текст он не ловит.
// Канон: design-brief D-21, §9.14, §10, §14 N8, N10; C-017, C-054, C-063, C-064, C-067, C-074, C-080; ADR-010, ADR-013;
// wiki/algorithms/alg-12-llm-tool-contract-and-number-verifier.md; canon-decisions «Финальные сигнатуры» (verifier.mjs).
// Зависимости (правило слоёв §14 B4): tools, index (и ниже). Модуль чистый: ни часов, ни ввода-вывода, ни Intl. Расчёт по введённым данным, не консультация.

import { fail, currency_exponent, round_div, format_minor, days_in_month, parse_date, format_date, civil_from_days, days_from_civil } from './index.mjs';
import { run_tool, build_echo, make_evidence, modes_of, paths_of } from './tools.mjs';

// ── словарь (зеркало vocab.json; тест сверяет) ─────────────────────────────────────────────────────────────────────────

/** Подписи режимов, вердиктов и классов причин для рендера (vocab.json §2.0; сверяются тестом). */
export const LABELS = Object.freeze({
  modes: Object.freeze({ ru: Object.freeze({ plan: 'по плану', worse: 'если хуже' }), en: Object.freeze({ plan: 'as planned', worse: 'if worse' }) }),
  verdicts: Object.freeze({
    ru: Object.freeze({ OK: 'выдерживает', TIGHT: 'впритык', FRAGILE: 'хрупко', NO: 'не хватает' }),
    en: Object.freeze({ OK: 'holds', TIGHT: 'tight', FRAGILE: 'fragile', NO: 'short' }),
  }),
  causes: Object.freeze({
    ru: Object.freeze({
      income_delay: 'задержка поступления', tax_payment: 'налоговый платёж', sinking_payment: 'платёж из накоплений',
      estimate: 'оценка повседневных трат', obligation: 'обязательный платёж', other: 'прочие расходы',
    }),
    en: Object.freeze({
      income_delay: 'delayed income', tax_payment: 'tax payment', sinking_payment: 'payment from savings',
      estimate: 'estimated everyday spending', obligation: 'obligatory payment', other: 'other spending',
    }),
  }),
  kinds: Object.freeze({
    ru: Object.freeze({
      tx: 'операции', anchor: 'сверки остатка', plan: 'плановые записи', rule: 'правила повторения', stream: 'потоки дохода',
      taxrule: 'налоговые правила', reserve: 'резервы', fx: 'курсы', params: 'параметры',
    }),
    en: Object.freeze({
      tx: 'transactions', anchor: 'balance anchors', plan: 'planned entries', rule: 'recurrence rules', stream: 'income streams',
      taxrule: 'tax rules', reserve: 'reserves', fx: 'rates', params: 'parameters',
    }),
  }),
});

const LOCALES = Object.freeze(['ru', 'en']);
const NBSP = ' ';
const MINUS = '−';
const CUR_SYMBOLS = Object.freeze({ EUR: '€', USD: '$', GBP: '£', RUB: '₽' });
const SYMBOL_CODES = Object.freeze({ '€': 'EUR', $: 'USD', '£': 'GBP', '₽': 'RUB' });
const FORMATS = Object.freeze({ ru: { decimal: ',', thousands: NBSP }, en: { decimal: '.', thousands: ',' } });

const MONTHS_RU = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function need_locale(locale) {
  if (!LOCALES.includes(locale)) fail('E_SCHEMA', { reason: 'unknown_locale' });
  return locale;
}

// ── формат чисел и дат пользователя (FP-16, REQ-112) ─────────────────────────────────────────────────────────────────
// Необязательный параметр `number_format` = `ws.number_format = {decimal, thousands, date}` (канон §3.1; все поля необязательны, `decimal` и `thousands` — только
// парой). Без него (или при недопустимом значении — файл недоверенный, настройка отбрасывается целиком) всё остаётся по языку, как прежде. Этот же формат
// понимает слой 2: текст, показанный в формате пользователя, проходит сверку так же, как текст в формате языка.

const NF_DECIMALS = Object.freeze([',', '.']);
const NF_THOUSANDS = Object.freeze(['', ' ', ',', '.']);
const NF_DATES = Object.freeze(['iso', 'dmy', 'mdy']);

/**
 * Разобрать настройку формата: `null` — настройки нет (или она недопустима), иначе `{decimal, thousands, date}` (недостающее — по языку; `date`: `auto|iso|dmy|mdy`).
 * @param {'ru'|'en'} locale
 * @param {any} nf
 * @returns {{decimal: string, thousands: string, date: string, custom_numbers: boolean}|null}
 */
function resolve_nf(locale, nf) {
  if (nf === null || nf === undefined || typeof nf !== 'object' || Array.isArray(nf)) return null;
  for (const k of Object.keys(nf)) if (k !== 'decimal' && k !== 'thousands' && k !== 'date') return null;
  const base = FORMATS[locale];
  const has_dec = Object.hasOwn(nf, 'decimal');
  const has_th = Object.hasOwn(nf, 'thousands');
  let decimal = base.decimal;
  let thousands = base.thousands;
  if (has_dec || has_th) {
    if (!(has_dec && has_th) || !NF_DECIMALS.includes(nf.decimal) || !NF_THOUSANDS.includes(nf.thousands) || nf.thousands === nf.decimal) return null;
    decimal = nf.decimal;
    thousands = nf.thousands === ' ' ? NBSP : nf.thousands; // в хранении пробел обычный, при показе он неразрывный
  }
  let date = 'auto';
  if (Object.hasOwn(nf, 'date')) {
    if (nf.date !== 'auto' && !NF_DATES.includes(nf.date)) return null;
    date = nf.date;
  }
  if (!(has_dec || has_th) && date === 'auto') return null;
  return { decimal, thousands, date, custom_numbers: has_dec || has_th };
}

/**
 * Плюральная форма: ru — `[one, few, many]` (1 день, 2 дня, 5 дней, 21 день, 22 дня, 11 дней), en — `[one, other]`.
 * @param {'ru'|'en'} locale
 * @param {number} n целое
 * @param {string[]} forms
 * @returns {string}
 */
export function plural(locale, n, forms) {
  const i = Math.abs(n);
  if (need_locale(locale) === 'ru') {
    const m10 = i % 10;
    const m100 = i % 100;
    if (m10 === 1 && m100 !== 11) return forms[0];
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return forms[1];
    return forms[2];
  }
  return i === 1 ? forms[0] : forms[1];
}

const DAYS_FORMS = Object.freeze({ ru: ['день', 'дня', 'дней'], en: ['day', 'days'] });

// ── рендер значений ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Показать значение evidence по виду и локали (ALG-12): money — знак «−» (U+2212) при v < 0; ru «1 234,56 €» (NBSP), en «€1,234.56»;
 * без символа — код ISO после числа; при `dp < exponent` значение округляется `half_even`. date — ru «14 ноября» (+ « 2027», если год
 * не совпадает с годом `as_of`), en «November 14» (+ «, 2027»). pct_bp — «170 %», «12,5 %». days — число и слово по числу («1 день»,
 * «14 дней»). count — число. enum — подпись словаря.
 * Необязательный четвёртый параметр `number_format` (`ws.number_format`, REQ-112, FP-16): разделители чисел и стиль даты пользователя
 * (`iso` — 2026-10-04, `dmy` — 04.10.2026, `mdy` — 10/04/2026; числовые стили всегда с годом); порядок символа валюты и слова остаются по языку.
 * Без параметра или при недопустимом значении поведение прежнее (по языку).
 * @param {{kind: string, v: number|string, cur?: string, dp?: number}} ev
 * @param {'ru'|'en'} locale
 * @param {string|null} [as_of] IsoDate расчёта (для года даты)
 * @param {{decimal?: string, thousands?: string, date?: string}|null} [number_format]
 * @returns {string}
 */
export function render_value(ev, locale, as_of = null, number_format = null) {
  need_locale(locale);
  const nfr = resolve_nf(locale, number_format);
  const fmt = nfr === null ? FORMATS[locale] : { decimal: nfr.decimal, thousands: nfr.thousands };
  switch (ev.kind) {
    case 'money': {
      const exp = currency_exponent(ev.cur);
      const dp = ev.dp ?? exp;
      const neg = ev.v < 0;
      let abs = Math.abs(ev.v);
      if (dp < exp) abs = round_div(abs, 10 ** (exp - dp), 'half_even');
      const num = format_minor(abs, dp, fmt);
      const sym = CUR_SYMBOLS[ev.cur];
      const sign = neg && abs !== 0 ? MINUS : '';
      if (sym === undefined) return sign + num + NBSP + ev.cur;
      return locale === 'ru' ? sign + num + NBSP + sym : sign + sym + num;
    }
    case 'date': {
      const y = Number(ev.v.slice(0, 4));
      const m = Number(ev.v.slice(5, 7));
      const d = Number(ev.v.slice(8, 10));
      if (nfr !== null && nfr.date !== 'auto') { // числовой стиль даты пользователя (REQ-112): всегда с годом
        const p2 = (n) => String(n).padStart(2, '0');
        if (nfr.date === 'iso') return ev.v;
        if (nfr.date === 'dmy') return p2(d) + '.' + p2(m) + '.' + y;
        return p2(m) + '/' + p2(d) + '/' + y;
      }
      const show_year = as_of === null || as_of === undefined ? false : Number(as_of.slice(0, 4)) !== y;
      if (locale === 'ru') return d + ' ' + MONTHS_RU[m - 1] + (show_year ? ' ' + y : '');
      return MONTHS_EN[m - 1] + ' ' + d + (show_year ? ', ' + y : '');
    }
    case 'pct_bp': {
      const neg = ev.v < 0;
      const abs = Math.abs(ev.v);
      const whole = Math.floor(abs / 100);
      const frac = abs % 100;
      let s = String(whole);
      if (frac !== 0) s += fmt.decimal + (frac % 10 === 0 ? String(frac / 10) : String(frac).padStart(2, '0'));
      return (neg ? MINUS : '') + s + NBSP + '%';
    }
    case 'days':
      return ev.v + ' ' + plural(locale, ev.v, DAYS_FORMS[locale]);
    case 'count':
      return String(ev.v);
    case 'enum':
      return LABELS.verdicts[locale][ev.v] ?? LABELS.modes[locale][ev.v] ?? LABELS.causes[locale][ev.v] ?? String(ev.v);
    default:
      return fail('E_SCHEMA', { reason: 'bad_evidence_kind' });
  }
}

// ── каталог шаблонов ──────────────────────────────────────────────────────────────────────────────────────────────────
//
// Синтаксис текста шаблона (цифр вне плейсхолдеров нет — V_RAW_DIGIT):
//   {путь}        — число/дата из `facts` результата (при построении ответа заменяется на {eN});
//   {путь|текст}  — то же, но если значения нет (null) — подставляется статичный текст;
//   {q.имя}       — эхо вопроса (`build_echo`): q.amount, q.date, q.days, …;
//   {@mode} {@cause} {@kind} {@gate} — статичные подписи словаря;
//   {flag.имя}    — условие по булеву факту: пусто, если истина; «нет значения», если ложь (для [[…]]);
//   [[ … ]]       — необязательный фрагмент: выбрасывается, если любое значение внутри отсутствует.

const BEYOND = Object.freeze({
  ru: ' Не все платежи учтены: {beyond_horizon_minor} за горизонтом.',
  en: ' Not all payments are included: {beyond_horizon_minor} lies beyond the horizon.',
});

const Q3_RU = {
  OK: 'Покупка {q.amount} на {q.date}: в заданных допущениях минимум свободных денег по плану — {by_mode.plan.m_after} ({by_mode.plan.at}); '
    + 'если выплата придёт на {q.days} позже — {by_mode.worse.m_after} ({by_mode.worse.at}), это не ниже буфера {buffer_minor}. Оценка: выдерживает.',
  FRAGILE: 'Покупка {q.amount} на {q.date}: в заданных допущениях минимум свободных денег по плану — {by_mode.plan.m_after} ({by_mode.plan.at}); '
    + 'если выплата придёт на {q.days} позже — {by_mode.worse.m_after} ({by_mode.worse.at}), это ниже буфера {buffer_minor}. Оценка: хрупко.'
    + '[[ Самая ранняя дата, с которой сумма держится в буфере в режиме «если хуже», — {earliest.worse}.]]',
  TIGHT: 'Покупка {q.amount} на {q.date}: в заданных допущениях минимум свободных денег по плану — {by_mode.plan.m_after} ({by_mode.plan.at}), '
    + 'это ниже буфера {buffer_minor}; если выплата придёт на {q.days} позже — {by_mode.worse.m_after} ({by_mode.worse.at}). Оценка: впритык.'
    + '[[ Самая ранняя дата, с которой сумма держится в буфере в режиме «если хуже», — {earliest.worse}.]]',
  NO: 'Покупка {q.amount} на {q.date}: в заданных допущениях минимум свободных денег по плану — {by_mode.plan.m_after} ({by_mode.plan.at}), '
    + 'это ниже нуля; если выплата придёт на {q.days} позже — {by_mode.worse.m_after} ({by_mode.worse.at}). Оценка: не хватает.',
};
const Q3_EN = {
  OK: 'Purchase of {q.amount} on {q.date}: under the stated assumptions the minimum free money as planned is {by_mode.plan.m_after} ({by_mode.plan.at}); '
    + 'if the payout arrives {q.days} later, it is {by_mode.worse.m_after} ({by_mode.worse.at}), not below the buffer of {buffer_minor}. Assessment: holds.',
  FRAGILE: 'Purchase of {q.amount} on {q.date}: under the stated assumptions the minimum free money as planned is {by_mode.plan.m_after} ({by_mode.plan.at}); '
    + 'if the payout arrives {q.days} later, it is {by_mode.worse.m_after} ({by_mode.worse.at}), below the buffer of {buffer_minor}. Assessment: fragile.'
    + '[[ The earliest date from which the amount stays within the buffer in the “if worse” mode is {earliest.worse}.]]',
  TIGHT: 'Purchase of {q.amount} on {q.date}: under the stated assumptions the minimum free money as planned is {by_mode.plan.m_after} ({by_mode.plan.at}), '
    + 'below the buffer of {buffer_minor}; if the payout arrives {q.days} later, it is {by_mode.worse.m_after} ({by_mode.worse.at}). Assessment: tight.'
    + '[[ The earliest date from which the amount stays within the buffer in the “if worse” mode is {earliest.worse}.]]',
  NO: 'Purchase of {q.amount} on {q.date}: under the stated assumptions the minimum free money as planned is {by_mode.plan.m_after} ({by_mode.plan.at}), '
    + 'below zero; if the payout arrives {q.days} later, it is {by_mode.worse.m_after} ({by_mode.worse.at}). Assessment: short.',
};
const CASH_GAP = Object.freeze({
  ru: '[[{flag.cash_gap} Кроме того, в режиме «если хуже» денег на счетах не хватает: кассовый разрыв.]][[{flag.baseline_below_buffer} Уже без покупки свободные деньги в режиме «если хуже» ниже буфера.]]',
  en: '[[{flag.cash_gap} In the “if worse” mode the money on the accounts also runs out: a cash gap.]][[{flag.baseline_below_buffer} Even without the purchase, free money in the “if worse” mode is below the buffer.]]',
});

const INSUFFICIENT = Object.freeze({
  ru: {
    readiness: 'Данных мало для вердикта: готовность данных ниже порога. Проверьте, что введены счёт, обязательные платежи, ближайшие поступления и повседневные траты.',
    stale: 'Данных мало для вердикта: остаток давно не сверялся. Сверьте остаток счёта и введите актуальное значение.',
    no_anchor: 'Данных мало для вердикта: нет подтверждённого остатка счёта. Введите остаток.',
    no_buffer: 'Данных мало для вердикта: не задан буфер. Введите буфер.',
    rule_disabled: 'Данных мало для вердикта: налоговое правило не подтверждено. Проверьте правило.',
    generic: 'Данных мало для вердикта. Проверьте введённые данные.',
  },
  en: {
    readiness: 'Not enough data for an assessment: data readiness is below the threshold. Check that an account, obligatory payments, upcoming income and everyday spending are entered.',
    stale: 'Not enough data for an assessment: the balance has not been reconciled for a long time. Reconcile the account balance and enter the current value.',
    no_anchor: 'Not enough data for an assessment: there is no confirmed account balance. Enter the balance.',
    no_buffer: 'Not enough data for an assessment: the buffer is not set. Enter the buffer.',
    rule_disabled: 'Not enough data for an assessment: the tax rule is not confirmed. Check the rule.',
    generic: 'Not enough data for an assessment. Check the entered data.',
  },
});

const BASE = Object.freeze({
  ru: {
    OUTSIDE: 'Запрошенная дата лежит за горизонтом расчёта (последний день — {horizon_end}): в горизонте нет.',
    'PROJ.OK': 'В режиме «{@mode}» к {to}: минимум денег на счетах — {min.amount_minor} ({min.date}), на конец периода — {end_close}.'
      + '[[ Первая дата ниже нуля — {first_breach}.]][[ Деньги на счетах уходят ниже нуля через {runway_with_days}.]]'
      + '[[ Можно потратить до {to}: {sts_minor} при буфере {buffer_minor}.]][[ До буфера не хватает (с учётом резервов): {short_to_buffer_minor}.]][[ {@gate}]]',
    'MAX.OK': 'Максимальная разовая покупка на {date} при буфере {buffer_minor}: по плану — {s_max.plan}, в режиме «если хуже» — {s_max.worse}.',
    'EARLIEST.OK': 'Самая ранняя дата, с которой сумма {amount} держится в буфере {buffer_minor}: по плану — {date_or_null.plan|в горизонте нет}, '
      + 'в режиме «если хуже» — {date_or_null.worse|в горизонте нет}.',
    'WAVES.NONE': 'С {from} по {to} волн платежей нет.',
    'WAVES.HEAD': 'В режиме «{@mode}» волн платежей: {waves_count}.',
    'WAVES.ONE': 'Волна с {w.start} по {w.end}: нужно к волне {w.need}, на счетах к началу {w.cash}, дефицит волны (физический) {w.gap}, покрытие {w.coverage_pm}, зарезервировано {w.reserved}.',
    'EXPLAIN.HEAD': 'В режиме «{@mode}» самая узкая точка денег на счетах — {point.amount_minor} ({point.date}).',
    'EXPLAIN.CHAIN': 'Вклад «{@cause}»: {c.amount} ({c.share_bp} расходов до этой точки).',
    'EXPLAIN.CF.without': 'Без этой группы расходов («{@cause}») минимум был бы {cf.new_min.amount_minor} ({cf.new_min.date}).',
    'EXPLAIN.CF.no_delay': 'Если бы поступление пришло вовремя, минимум был бы {cf.new_min.amount_minor} ({cf.new_min.date}).',
    'SCENARIO.OK': 'Сценарий в режиме «{@mode}»: минимум денег на счетах — {min_minor} ({min_date}); изменение относительно базы — {delta_min} (база: {base_min_minor}).',
    'CHANGED.HEAD': 'Изменено записей: {changes_count}[[ (с {since})]]. Минимум денег на счетах в режиме «{@mode}» был {min_before}, стал {min_after}.',
    'CHANGED.KIND': '{@kind}: {k.count}.',
    'SHIFT.NOTE': 'Допущение: сдвигается ближайшее ожидаемое поступление (не расход), на {q.shift_days}.',
    'SHIFT.NOTE_DEFAULT': 'Допущение: в вопросе нет срока, взяты {q.shift_days} (срок по умолчанию); сдвигается ближайшее ожидаемое поступление (не расход).',
    'TAX.OK': 'Налоговый конверт на {as_of}: накоплено {reserved}.[[ Ближайший платёж — {next_due.date}: {next_due.payment_minor}.]] Расчёт по введённым правилам, не консультация.',
    'DRAFT.OK': 'Черновик изменений подготовлен: операций — {ops_count}. Он ничего не меняет, пока вы сами не подтвердите его в интерфейсе.',
    'DRAFT.MOVE': 'Перенос платежа на {d.to}.',
    'DRAFT.SKIP': 'Пропуск платежа.',
    'DRAFT.ADD': 'Добавление платежа {d.amount} на {d.date}.',
    'GATE.readiness': 'Свободный остаток не показан: готовность данных ниже порога.',
    'GATE.stale': 'Свободный остаток не показан: остаток давно не сверялся.',
    'GATE.no_anchor': 'Свободный остаток не показан: нет подтверждённого остатка счёта.',
    'GATE.no_buffer': 'Свободный остаток не показан: не задан буфер.',
    'GATE.rule_disabled': 'Свободный остаток не показан: налоговое правило не подтверждено.',
    'ERR.E_SCHEMA': 'Запрос не выполнен: проверьте введённые значения.',
    'ERR.E_BAD_DATE': 'Запрос не выполнен: проверьте даты.',
    'ERR.E_CURRENCY_MISMATCH': 'Запрос не выполнен: сверьте валюту с валютой расчёта.',
    'ERR.E_NOT_PERMITTED': 'Запрос не выполнен: инструмент недоступен на этом уровне прав.',
    'ERR.E_CALL_LIMIT': 'Запрос не выполнен: превышен предел вызовов на один вопрос.',
    'ERR.E_UNKNOWN_TOOL': 'Запрос не выполнен: такого инструмента нет.',
    'ERR.other': 'Запрос не выполнен: проверьте введённые данные.',
    'CAV.LIQUIDITY': 'Это расчёт ликвидности по вашим правилам и данным, не рекомендация.',
    'CAV.NOT_ADVICE': 'Расчёт по введённым данным и правилам, не консультация.',
    'FU.CHECK_ANCHOR': 'Сверьте остаток счёта с банком.',
    'FU.CHECK_DATA': 'Проверьте введённые данные.',
  },
  en: {
    OUTSIDE: 'The requested date lies beyond the calculation horizon (the last day is {horizon_end}): not within the horizon.',
    'PROJ.OK': 'In the “{@mode}” mode up to {to}: the minimum money on the accounts is {min.amount_minor} ({min.date}), at the end of the period {end_close}.'
      + '[[ The first date below zero is {first_breach}.]][[ Money on the accounts goes below zero in {runway_with_days}.]]'
      + '[[ Spendable up to {to}: {sts_minor} at a buffer of {buffer_minor}.]][[ Short of the buffer (after reserves): {short_to_buffer_minor}.]][[ {@gate}]]',
    'MAX.OK': 'Maximum one-off purchase on {date} at a buffer of {buffer_minor}: as planned {s_max.plan}, in the “if worse” mode {s_max.worse}.',
    'EARLIEST.OK': 'The earliest date from which the amount {amount} stays within the buffer of {buffer_minor}: as planned {date_or_null.plan|not within the horizon}, '
      + 'in the “if worse” mode {date_or_null.worse|not within the horizon}.',
    'WAVES.NONE': 'There are no payment waves from {from} to {to}.',
    'WAVES.HEAD': 'Payment waves in the “{@mode}” mode: {waves_count}.',
    'WAVES.ONE': 'Wave from {w.start} to {w.end}: needed for the wave {w.need}, on the accounts at the start {w.cash}, wave shortfall (physical) {w.gap}, coverage {w.coverage_pm}, reserved {w.reserved}.',
    'EXPLAIN.HEAD': 'In the “{@mode}” mode the narrowest point of money on the accounts is {point.amount_minor} ({point.date}).',
    'EXPLAIN.CHAIN': 'Contribution of “{@cause}”: {c.amount} ({c.share_bp} of the spending before this point).',
    'EXPLAIN.CF.without': 'Without this group of spending (“{@cause}”) the minimum would be {cf.new_min.amount_minor} ({cf.new_min.date}).',
    'EXPLAIN.CF.no_delay': 'If the income had arrived on time, the minimum would be {cf.new_min.amount_minor} ({cf.new_min.date}).',
    'SCENARIO.OK': 'Scenario in the “{@mode}” mode: the minimum money on the accounts is {min_minor} ({min_date}); change against the base {delta_min} (base: {base_min_minor}).',
    'CHANGED.HEAD': 'Entries changed: {changes_count}[[ (since {since})]]. The minimum money on the accounts in the “{@mode}” mode was {min_before}, now {min_after}.',
    'CHANGED.KIND': '{@kind}: {k.count}.',
    'SHIFT.NOTE': 'Assumption: the nearest expected receipt (not a payment out) is shifted, by {q.shift_days}.',
    'SHIFT.NOTE_DEFAULT': 'Assumption: the question gives no period, {q.shift_days} is used (the default); the nearest expected receipt (not a payment out) is shifted.',
    'TAX.OK': 'Tax envelope on {as_of}: accumulated {reserved}.[[ The next payment is {next_due.date}: {next_due.payment_minor}.]] Calculated from the rules you entered; not advice.',
    'DRAFT.OK': 'A draft of changes is ready: operations {ops_count}. It changes nothing until you confirm it yourself in the interface.',
    'DRAFT.MOVE': 'Moving the payment to {d.to}.',
    'DRAFT.SKIP': 'Skipping the payment.',
    'DRAFT.ADD': 'Adding a payment of {d.amount} on {d.date}.',
    'GATE.readiness': 'Free money is not shown: data readiness is below the threshold.',
    'GATE.stale': 'Free money is not shown: the balance has not been reconciled for a long time.',
    'GATE.no_anchor': 'Free money is not shown: there is no confirmed account balance.',
    'GATE.no_buffer': 'Free money is not shown: the buffer is not set.',
    'GATE.rule_disabled': 'Free money is not shown: the tax rule is not confirmed.',
    'ERR.E_SCHEMA': 'The request failed: check the entered values.',
    'ERR.E_BAD_DATE': 'The request failed: check the dates.',
    'ERR.E_CURRENCY_MISMATCH': 'The request failed: check the currency against the calculation currency.',
    'ERR.E_NOT_PERMITTED': 'The request failed: the tool is not available at this permission level.',
    'ERR.E_CALL_LIMIT': 'The request failed: the limit of calls per question is exceeded.',
    'ERR.E_UNKNOWN_TOOL': 'The request failed: there is no such tool.',
    'ERR.other': 'The request failed: check the entered data.',
    'CAV.LIQUIDITY': 'This is a liquidity calculation by your rules and data, not a recommendation.',
    'CAV.NOT_ADVICE': 'Calculated from the data and rules you entered; not advice.',
    'FU.CHECK_ANCHOR': 'Reconcile the account balance with the bank.',
    'FU.CHECK_DATA': 'Check the entered data.',
  },
});

function build_catalog(locale) {
  const out = { ...BASE[locale] };
  const q3 = locale === 'ru' ? Q3_RU : Q3_EN;
  for (const v of Object.keys(q3)) {
    out['Q3.' + v] = q3[v] + CASH_GAP[locale];
    out['Q3.' + v + '.BEYOND'] = q3[v] + CASH_GAP[locale] + BEYOND[locale];
  }
  for (const r of Object.keys(INSUFFICIENT[locale])) out['INSUFFICIENT.' + r] = INSUFFICIENT[locale][r];
  return Object.freeze(out);
}

const CATALOGS = Object.freeze({ ru: build_catalog('ru'), en: build_catalog('en') });

/**
 * Каталог шаблонов (статичные строки без цифр вне плейсхолдеров): ключ → текст. Ключи: `Q3.<вердикт>` и `Q3.<вердикт>.BEYOND`
 * (оговорка «не все платежи учтены» неотделима, C-017), `INSUFFICIENT.<причина>`, `OUTSIDE`, `PROJ.OK`, `MAX.OK`, `EARLIEST.OK`, `WAVES.*`,
 * `EXPLAIN.*`, `SCENARIO.OK`, `CHANGED.*`, `TAX.OK`, `DRAFT.*`, `GATE.*`, `ERR.*`, а также оговорки `CAV.*` и продолжения `FU.*`.
 * @param {'ru'|'en'} locale
 * @returns {Readonly<Object<string, string>>}
 */
export function templates(locale) {
  return CATALOGS[need_locale(locale)];
}

/** Текст шаблона по ключу каталога: только собственные ключи («constructor», «__proto__», «toString» — не ключи каталога) и только строки. */
function tpl_text(T, key) {
  return typeof key === 'string' && Object.hasOwn(T, key) && typeof T[key] === 'string' ? T[key] : undefined;
}

// ── подстановка в шаблон ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Разобрать шаблон: сначала необязательные фрагменты `[[…]]` (выбрасываются, если внутри любое значение отсутствует), затем `{…}`.
 * @param {string} text
 * @param {(name: string) => string|null} resolve значение слота или `null`
 * @returns {string}
 */
function instantiate(text, resolve) {
  const fill = (s, strict) => {
    let missing = false;
    const out = s.replace(/\{([^{}|]+)(?:\|([^{}]*))?\}/g, (_m, name, alt) => {
      if (/^e\d+$/.test(name)) return '{' + name + '}'; // уже подставленная ссылка (фрагменты `[[…]]` разобраны первым проходом)
      const v = resolve(name);
      if (v !== null && v !== undefined) return v;
      if (alt !== undefined) return alt;
      missing = true;
      return '';
    });
    if (missing && !strict) fail('E_SCHEMA', { reason: 'template_slot_missing' });
    return missing ? null : out;
  };
  const with_optional = text.replace(/\[\[([\s\S]*?)\]\]/g, (_m, inner) => fill(inner, true) ?? '');
  return fill(with_optional, false);
}

function get_path(obj, path) {
  let cur = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = Array.isArray(cur) ? cur[Number(part)] : cur[part];
  }
  return cur;
}

function ev_by_id(result, id) {
  return result.evidence.find((e) => e.id === id);
}

const EREF = /^e\d+$/;

/** Построить утверждение: `t` — шаблон с плейсхолдерами `{eN}`/`{q.…}`, `refs` — использованные `eN` по порядку появления. */
function build_claim(result, locale, tpl, { alias = {}, extra = {}, scope_mode, hide = [] } = {}) {
  const text = tpl_text(templates(locale), tpl);
  if (text === undefined) fail('E_SCHEMA', { reason: 'unknown_template' });
  const hidden = new Set(hide);
  const resolve = (name) => {
    if (name.startsWith('q.')) return '{' + name + '}';
    if (name.startsWith('@')) return extra[name.slice(1)] ?? null;
    if (name.startsWith('flag.')) return get_path(result.facts, 'flags.' + name.slice(5)) === true ? '' : null;
    if (hidden.has(name)) return null;
    let path = name;
    const dot = name.indexOf('.');
    const head = dot < 0 ? name : name.slice(0, dot);
    if (alias[head] !== undefined) path = alias[head] + (dot < 0 ? '' : name.slice(dot));
    const v = get_path(result.facts, path);
    return typeof v === 'string' && EREF.test(v) ? '{' + v + '}' : null;
  };
  const t = instantiate(text, resolve);
  const refs = [];
  for (const m of t.matchAll(/\{(e\d+)\}/g)) if (!refs.includes(m[1])) refs.push(m[1]);
  return { call: result.call_id, tpl, t, refs, scope: { mode: scope_mode ?? result.scope.mode, scenario_id: result.scope.scenario_id } };
}

const gate_note = (locale, reason) => templates(locale)['GATE.' + reason] ?? null;

/**
 * Ответ по умолчанию (A0): утверждения-шаблоны каталога по инструменту и вердикту, значения — ссылки на evidence результата.
 * Свойство: `fallback_answer` ВСЕГДА проходит `verify_answer` (тест на всех инструментах и данных G-001).
 * @param {import('./tools.mjs').Result} result результат `run_tool` (не ошибка)
 * @param {'ru'|'en'} [locale]
 * @returns {{claims: object[], caveats: string[], followups: string[]}}
 */
export function fallback_answer(result, locale = 'ru') {
  need_locale(locale);
  const T = templates(locale);
  const f = result.facts;
  const claims = [];
  const caveats = [];
  const followups = [];
  const claim = (tpl, o) => claims.push(build_claim(result, locale, tpl, o));
  const insufficient = (scope_mode) => {
    const key = 'INSUFFICIENT.' + f.reason;
    claim(T[key] === undefined ? 'INSUFFICIENT.generic' : key, { scope_mode });
    if (f.reason === 'stale' || f.reason === 'no_anchor') followups.push('FU.CHECK_ANCHOR');
  };
  switch (result.tool) {
    case 'check_purchase': {
      if (f.kind === 'insufficient_data') { insufficient('both'); break; }
      if (f.kind === 'outside_horizon') { claim('OUTSIDE', { scope_mode: 'both' }); break; }
      const beyond = ev_by_id(result, f.beyond_horizon_minor)?.v > 0;
      claim('Q3.' + f.verdict + (beyond ? '.BEYOND' : ''), { scope_mode: 'both' });
      caveats.push('CAV.LIQUIDITY');
      break;
    }
    case 'max_purchase_amount':
      if (f.kind === 'insufficient_data') insufficient('both');
      else if (f.kind === 'outside_horizon') claim('OUTSIDE', { scope_mode: 'both' });
      else claim('MAX.OK', { scope_mode: 'both' });
      break;
    case 'earliest_safe_date':
      if (f.kind === 'insufficient_data') insufficient('both');
      else claim('EARLIEST.OK', { scope_mode: 'both' });
      break;
    case 'get_projection': {
      if (f.kind === 'outside_horizon') { claim('OUTSIDE'); break; }
      const hide = [];
      const short_v = f.short_to_buffer_minor === null ? 0 : ev_by_id(result, f.short_to_buffer_minor)?.v ?? 0;
      if (short_v > 0) hide.push('sts_minor');
      else hide.push('short_to_buffer_minor');
      claim('PROJ.OK', { hide, extra: { mode: LABELS.modes[locale][result.scope.mode], gate: f.gate === null ? null : gate_note(locale, f.gate.reason) } });
      break;
    }
    case 'list_waves': {
      const mode = LABELS.modes[locale][result.scope.mode];
      if (f.waves.length === 0) { claim('WAVES.NONE'); break; }
      claim('WAVES.HEAD', { extra: { mode } });
      f.waves.forEach((_w, i) => claim('WAVES.ONE', { alias: { w: 'waves.' + i } }));
      break;
    }
    case 'explain_min_point': {
      const mode = LABELS.modes[locale][result.scope.mode];
      claim('EXPLAIN.HEAD', { extra: { mode } });
      f.chain.forEach((c, i) => claim('EXPLAIN.CHAIN', { alias: { c: 'chain.' + i }, extra: { cause: LABELS.causes[locale][c.cause_class] } }));
      f.counterfactuals.forEach((x, i) => {
        if (x.kind === 'without') {
          const c = f.chain.find((g) => g.group === x.without);
          claim('EXPLAIN.CF.without', { alias: { cf: 'counterfactuals.' + i }, extra: { cause: LABELS.causes[locale][c?.cause_class ?? 'other'] } });
        } else claim('EXPLAIN.CF.no_delay', { alias: { cf: 'counterfactuals.' + i } });
      });
      break;
    }
    case 'run_scenario':
      claim('SCENARIO.OK', { extra: { mode: LABELS.modes[locale][result.scope.mode] } });
      break;
    case 'what_changed': {
      claim('CHANGED.HEAD', { extra: { mode: LABELS.modes[locale][result.scope.mode] } });
      f.kind_counts.forEach((k, i) => claim('CHANGED.KIND', { alias: { k: 'kind_counts.' + i }, extra: { kind: LABELS.kinds[locale][k.kind] } }));
      break;
    }
    case 'get_tax_envelope':
      if (f.kind === 'outside_horizon') claim('OUTSIDE');
      else claim('TAX.OK');
      break;
    case 'propose_change': {
      claim('DRAFT.OK');
      f.diff.forEach((d, i) => claim(d.op === 'move_plan' ? 'DRAFT.MOVE' : d.op === 'skip_plan' ? 'DRAFT.SKIP' : 'DRAFT.ADD', { alias: { d: 'diff.' + i } }));
      break;
    }
    default:
      fail('E_SCHEMA', { reason: 'unknown_tool_for_template' });
  }
  return { claims, caveats, followups };
}

// ── рендер ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Подставить значения в утверждение: `{eN}` — из evidence результата, `{q.…}` — из эхо; текст берётся из `c.t`, иначе из каталога по `c.tpl`.
 * Неразрешённый плейсхолдер — `E_SCHEMA` (верификатор до рендера помечает его нарушением слоя 1).
 * @param {{call: string, tpl?: string|null, t?: string}} c
 * @param {import('./tools.mjs').Result} r
 * @param {'ru'|'en'} locale
 * @param {import('./tools.mjs').Evidence[]} [echo]
 * @param {{decimal?: string, thousands?: string, date?: string}|null} [number_format] формат чисел и дат пользователя (REQ-112); по умолчанию — по языку
 * @returns {string}
 */
export function render_claim(c, r, locale, echo = [], number_format = null) {
  need_locale(locale);
  const text = c.t ?? (c.tpl === undefined || c.tpl === null ? undefined : tpl_text(templates(locale), c.tpl));
  if (typeof text !== 'string') fail('E_SCHEMA', { reason: 'claim_without_text' });
  const by_echo = new Map(echo.map((e) => [e.id, e]));
  return text.replace(/\{(e\d+|q\.[a-z0-9_]+)\}/g, (_m, id) => {
    const ev = id.startsWith('q.') ? by_echo.get(id) : ev_by_id(r, id);
    if (ev === undefined) fail('E_SCHEMA', { reason: 'unresolved_placeholder' });
    return render_value(ev, locale, r.as_of, number_format);
  }).replace(/\{[^{}]*\}/g, () => fail('E_SCHEMA', { reason: 'unresolved_placeholder' }));
}

/**
 * Текст ответа: утверждения (по одному `Result` каждое) через пробел, затем оговорки и продолжения из каталога.
 * @param {{claims: object[], caveats?: string[], followups?: string[]}} answer
 * @param {import('./tools.mjs').Result[]} results
 * @param {'ru'|'en'} locale
 * @param {import('./tools.mjs').Evidence[]} [echo] эхо вопроса (`build_echo`): нужно, если в шаблонах есть `{q.…}`
 * @param {{decimal?: string, thousands?: string, date?: string}|null} [number_format] формат чисел и дат пользователя (REQ-112); по умолчанию — по языку
 * @returns {string}
 */
export function render_answer(answer, results, locale, echo = [], number_format = null) {
  if (!is_obj(answer) || !Array.isArray(answer.claims)) fail('E_SCHEMA', { reason: 'answer_malformed' });
  const R = new Map(results.filter((r) => !r.isError).map((r) => [r.call_id, r]));
  const T = templates(locale);
  const parts = [];
  for (const c of answer.claims) {
    const r = R.get(c.call);
    if (r === undefined) fail('E_SCHEMA', { reason: 'claim_call_unknown' });
    parts.push(render_claim(c, r, locale, echo, number_format));
  }
  for (const k of [...list_of_keys(answer.caveats), ...list_of_keys(answer.followups)]) {
    const line = tpl_text(T, k);
    if (line === undefined) fail('E_SCHEMA', { reason: 'unknown_catalog_key' });
    parts.push(line);
  }
  return parts.join(' ');
}

// ── разбор чисел и дат в тексте (слой 2) ──────────────────────────────────────────────────────────────────────────────

const MONTH_MAP = (() => {
  const m = new Map();
  MONTHS_RU.forEach((n, i) => m.set(n, i + 1));
  MONTHS_EN.forEach((n, i) => { m.set(n.toLowerCase(), i + 1); m.set(n.slice(0, 3).toLowerCase(), i + 1); });
  m.set('sept', 9);
  return m;
})();
const alt_of = (xs) => [...xs].sort((a, b) => b.length - a.length).join('|');
const RU_MONTH_ALT = alt_of(MONTHS_RU);
const EN_MONTH_ALT = alt_of([...MONTHS_EN.map((n) => n.toLowerCase()), ...MONTHS_EN.map((n) => n.slice(0, 3).toLowerCase()), 'sept']);

const SIGN = '[-−–\u2010-\u2012\u207B\u208B\uFE58\uFE63\uFF0D\u2796]';
/** Число с группами и разделителями любых локалей (локаль проверяется отдельно): иначе «1,234.56» в ru не поймать. */
// Повторы ограничены (≤ 8 групп): иначе откат регулярки на «1,1,1,…» квадратичен (ALG-12: O(L)). Более длинная запись распадается на несколько
// токенов, каждый из которых сам по себе нарушение (ambiguous / number без единицы), то есть fail-closed сохраняется.
const NUMG = '(?:\\d{1,3}(?:[ \\u00a0\\u202f]\\d{3}){1,8}(?:[.,]\\d+){0,8}|\\d+(?:[.,]\\d+){0,8})';
const YEAR = '(?:19|20|21)\\d{2}(?!\\d)(?!\\s?[€$£₽%])(?![.,]\\d)';

const NUMERALS = 'ноль|один|одна|одно|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|одиннадцать|двенадцать|тринадцать|четырнадцать|пятнадцать|шестнадцать|семнадцать|восемнадцать|девятнадцать|двадцать|тридцать|сорок|пятьдесят|шестьдесят|семьдесят|восемьдесят|девяносто|сто|двести|триста|полтора|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred';
/** «Круглые» числительные: одиночное такое слово без единицы — число без цифр (Q-06). */
const NUMERALS_ROUND = 'двадцать|тридцать|сорок|пятьдесят|шестьдесят|семьдесят|восемьдесят|девяносто|сто|двести|триста|четыреста|пятьсот|шестьсот|семьсот|восемьсот|девятьсот|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred';
/** Все числительные для серии: прежний набор плюс сотни русского. */
const NUMERALS_ALL = NUMERALS + '|четыреста|пятьсот|шестьсот|семьсот|восемьсот|девятьсот';
const SPELLED_UNITS ='(?:дн\\p{L}*|день|недел\\p{L}*|месяц\\p{L}*|год\\p{L}*|лет|час\\p{L}*|тысяч\\p{L}*|миллион\\p{L}*|евро|рубл\\p{L}*|долл\\p{L}*|процент\\p{L}*|days?|weeks?|months?|years?|hours?|thousand|million|euros?|dollars?|percent)';

const NF_RE = new Map();
/** Регулярное выражение числа в формате пользователя (по разделителям; кэшируется): `[1]` — целая часть с группами по три цифры, `[2]` — дробь. */
function nf_number_re(nfr) {
  const key = nfr.decimal + '|' + nfr.thousands;
  let hit = NF_RE.get(key);
  if (hit === undefined) {
    const esc = (c) => (c === '.' ? '\\.' : c);
    const group = nfr.thousands === '' ? null : (nfr.thousands === NBSP ? '[ \\u00a0\\u202f]' : esc(nfr.thousands));
    const int = group === null ? '(\\d+)' : '(\\d{1,3}(?:' + group + '\\d{3})+|\\d+)';
    hit = { re: new RegExp('^' + int + '(?:' + esc(nfr.decimal) + '(\\d+))?$'), strip: group === null ? null : new RegExp(group, 'g') };
    NF_RE.set(key, hit);
  }
  return hit;
}

/**
 * Разобрать число по правилам локали (или формата пользователя `nfr`, REQ-112): `{int, frac}` (строки цифр) или `null`, если запись двусмысленна
 * (не по правилам формата).
 */
function classify_number(raw, locale, nfr = null) {
  if (nfr !== null && nfr.custom_numbers) {
    const { re, strip } = nf_number_re(nfr);
    const m = re.exec(raw);
    if (m === null) return null;
    return { int: strip === null ? m[1] : m[1].replace(strip, ''), frac: m[2] ?? '' };
  }
  const re = locale === 'ru' ? /^(\d{1,3}(?:[   ]\d{3})+|\d+)(?:,(\d+))?$/ : /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/;
  const m = re.exec(raw);
  if (m === null) return null;
  return { int: m[1].replace(/[   ,]/g, ''), frac: m[2] ?? '' };
}

function valid_ymd(y, m, d) {
  if (m < 1 || m > 12 || d < 1) return false;
  if (y === null) return d <= days_in_month(2000, m);
  return d <= days_in_month(y, m) && y >= 1;
}

function currency_known(code) {
  try {
    currency_exponent(code);
    return true;
  } catch {
    return false;
  }
}

/**
 * Разбор текста на количества (ALG-12), проходами по порядку; найденный фрагмент маскируется:
 * 1 разметка (URL, `[..](..)`, `![..](..)`, `<тег>`) → markup · 2 даты (ISO; ru «14 ноября [2026] [г.]», «14.11.[2026]»; en «November 14[, 2026]»,
 * «14 November»; несуществующая — bad_date) · 3 относительные даты → relative_date · 4 сокращения (7.6k, тыс., млн, «тысяч», thousand) → abbrev ·
 * 5 проценты → pct · 6 деньги → money{cur, neg, digits, dp} · 7 дни → days; недели/месяцы/годы/часы → unit; слово-числительное + единица → spelled ·
 * 8 счётчики («k из n», «число + платеж*|событ*|…») → count · 9 маркеры «Шаг|Step|Paso|№|#» + 1–2 цифры и «N.»/«N)» в начале строки — пропуск ·
 10 остаток: число → number; не по правилам локали («1,234.56» в ru, «1.234,56» в en) → ambiguous.
 * Знак «-», «−», «–» учитывается вплотную к числу или символу. `digits` — строка цифр (целая и дробная часть подряд), `dp` — число знаков дроби.
 * @param {string} text
 * @param {'ru'|'en'} [locale]
 * @param {{decimal?: string, thousands?: string, date?: string}|null} [number_format] формат чисел и дат пользователя (REQ-112, FP-16): число и дата распознаются
 *   по его разделителям и стилю; по умолчанию (и при недопустимом значении) — по языку, как прежде
 * @returns {{kind: string, raw: string, index: number}[]} по возрастанию `index`
 */
export function extract_quantities(text, locale = 'ru', number_format = null) {
  need_locale(locale);
  const nfr = resolve_nf(locale, number_format);
  const st = { w: String(text), out: [] };
  const scan = (re, make) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(st.w)) !== null) {
      if (m[0] === '') { re.lastIndex = m.index + 1; continue; }
      const q = make(m);
      if (q === null || q === undefined) { re.lastIndex = m.index + 1; continue; }
      st.out.push({ ...q, raw: m[0], index: m.index });
      st.w = st.w.slice(0, m.index) + '\u0001'.repeat(m[0].length) + st.w.slice(m.index + m[0].length);
      re.lastIndex = m.index + m[0].length;
    }
  };
  const num_parts = (raw) => classify_number(raw, locale, nfr);

  // 0. символы форматирования Cf (bidi U+202A–202E/2066–2069, нулевые пробелы U+200B–200F, U+2060–2064, U+FEFF…): текст отображается не так,
  // как проверен (зеркальная запись числа, число, разорванное невидимым знаком) — класс V_MARKUP (Q-03, К-26). Осознанный компромисс: ZWJ U+200D
  // внутри эмодзи-последовательностей тоже отвергается. NBSP U+00A0 и U+202F — пробелы (Zs), не Cf: render_value их использует и проходит.
  scan(/\p{Cf}+/gu, () => ({ kind: 'markup' }));

  // 1. разметка
  // длины частей ограничены (линейное время на «[a[a…», «<a<a…»); разметка в любом случае нарушение, маска нужна лишь против двойного учёта
  scan(/!?\[[^\]\n]{0,300}\]\([^)\n]{0,2000}\)|(?:https?:\/\/|www\.)[^\s)>\]]+|<\/?[A-Za-z!][^>\n]{0,300}>/giu, () => ({ kind: 'markup' }));
  // 1b. разметка вне перечня канона (Q-04, К-25): ссылка-определение «[r]: //host/x», ссылочные формы «![a][r]» / «[a][r]», scheme-relative «//host/x»
  // и голый домен с путём «host.example/pixel.png» — канал утечки без цифр; ограничения длин сохраняют линейное время. Голый домен БЕЗ пути
  // («г. Берлин», «т.е.») разметкой не считается — решение владельца по К-25.
  scan(/^[ \t]{0,3}\[[^\]\n]{1,300}\]:[ \t]*\S+/gmu, () => ({ kind: 'markup' }));
  // ссылочные формы «[a][r]» и «![a][r]»: поиск по «][» без регулярного старта в каждом «[» (линейно: на находку — не более ~400 знаков вокруг)
  {
    const found = [];
    for (let from = 0; ;) {
      const i = st.w.indexOf('][', from);
      if (i === -1) break;
      from = i + 1;
      const left = st.w.slice(Math.max(0, i - 301), i);
      const o = left.lastIndexOf('[');
      if (o === -1 || /[\]\n]/.test(left.slice(o + 1))) continue;
      const right = st.w.slice(i + 2, i + 103);
      const c = right.search(/[\]\n]/);
      if (c === -1 || right[c] !== ']') continue;
      let start = i - (left.length - o);
      if (start > 0 && st.w[start - 1] === '!') start -= 1;
      if (found.length > 0 && start < found[found.length - 1][1]) start = found[found.length - 1][1]; // уже учтено
      const end = i + 2 + c + 1;
      found.push([start, end]);
      from = end;
    }
    if (found.length > 0) { // маска одним проходом (не по одному куску: иначе квадрат на длинном тексте)
      const parts = [];
      let pos = 0;
      for (const [start, end] of found) {
        parts.push(st.w.slice(pos, start), '\u0001'.repeat(end - start));
        st.out.push({ kind: 'markup', raw: st.w.slice(start, end), index: start });
        pos = end;
      }
      parts.push(st.w.slice(pos));
      st.w = parts.join('');
    }
  }
  scan(/(?<![:\w])\/\/[\p{L}\d.-]+\.\p{L}{2,}[^\s)>\]]{0,300}/gu, () => ({ kind: 'markup' }));
  scan(/(?<![\p{L}\d@.-])(?:[a-z0-9-]{1,63}\.){1,8}[a-z]{2,24}\/\S{0,300}/giu, () => ({ kind: 'markup' }));

  // 2. даты
  const date_q = (y, m, d) => (valid_ymd(y, m, d) ? { kind: 'date', y, m, d } : { kind: 'bad_date' });
  scan(/(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?!\d)/gu, (m) => date_q(Number(m[1]), Number(m[2]), Number(m[3])));
  scan(new RegExp('(?<![\\d.,])(\\d{1,2})\\s+(' + RU_MONTH_ALT + ')(?![\\p{L}])(?:\\s+(' + YEAR + '))?(?:\\s?(?:года|г\\.|г)(?![\\p{L}]))?', 'giu'),
    (m) => date_q(m[3] === undefined ? null : Number(m[3]), MONTH_MAP.get(m[2].toLowerCase()), Number(m[1])));
  scan(new RegExp('(?<![\\p{L}])(' + EN_MONTH_ALT + ')\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?![\\d\\p{L}])(?:,?\\s+(' + YEAR + '))?', 'giu'),
    (m) => date_q(m[3] === undefined ? null : Number(m[3]), MONTH_MAP.get(m[1].toLowerCase()), Number(m[2])));
  scan(new RegExp('(?<![\\d.,])(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(' + EN_MONTH_ALT + ')(?![\\p{L}])(?:,?\\s+(' + YEAR + '))?', 'giu'),
    (m) => date_q(m[3] === undefined ? null : Number(m[3]), MONTH_MAP.get(m[2].toLowerCase()), Number(m[1])));
  if (locale === 'ru') {
    scan(/(?<![\d.,])(\d{1,2})\.(\d{1,2})\.(\d{4})?(?!\d)/gu, (m) => (Number(m[2]) < 1 || Number(m[2]) > 12 ? null : date_q(m[3] === undefined ? null : Number(m[3]), Number(m[2]), Number(m[1]))));
  } else {
    scan(/(?<![\d.,])(\d{1,2})\.(\d{1,2})\.(\d{4})(?!\d)/gu, (m) => (Number(m[2]) < 1 || Number(m[2]) > 12 ? null : date_q(Number(m[3]), Number(m[2]), Number(m[1]))));
  }

  // 2b. числовой стиль даты пользователя «мм/дд/гггг» (REQ-112, FP-16): распознаётся, только если он выбран; ISO и «дд.мм.гггг» разбираются выше
  if (nfr !== null && nfr.date === 'mdy') scan(/(?<![\d.,/])(\d{1,2})\/(\d{1,2})\/(\d{4})(?!\d)/gu, (m) => date_q(Number(m[3]), Number(m[1]), Number(m[2])));

  // 3. относительные даты
  scan(/(?<![\p{L}])(?:сегодня|завтра|вчера|today|tomorrow|yesterday)(?![\p{L}])/giu, () => ({ kind: 'relative_date' }));

  // 4. сокращения
  const abbrev_q = (m) => {
    const p = m[1] === undefined ? null : num_parts(m[1]);
    return { kind: 'abbrev', normalized: p === null ? null : p.int + (p.frac === '' ? '' : '.' + p.frac) };
  };
  scan(new RegExp('(?<!\\d)(' + NUMG + ')\\s?(?:тысяч\\p{L}*|тыс\\.?|млн\\.?|миллион\\p{L}*|thousand|million)(?![\\p{L}])', 'giu'), abbrev_q);
  scan(new RegExp('(?<!\\d)(' + NUMG + ')(?:k|m)(?![\\p{L}\\d])', 'giu'), abbrev_q);
  scan(/(?<![\p{L}])(?:тысяч\p{L}*|миллион\p{L}*|thousand|million)(?![\p{L}])/giu, () => ({ kind: 'abbrev', normalized: null }));

  // 5b. знак числа не из канона (Q-02, К-24). Раньше такие знаки читались как «плюс» и проходили при положительном evidence:
  //  · «−» (U+2212) через пробел перед числом («− 470,00 €») — тот же минус: пробел между знаком и числом убирается (длина текста и индексы сохраняются);
  //  · другие глифы минуса и дефиса (U+2010–2012, U+207B, U+208B, U+FE58, U+FE63, U+FF0D, U+2796) — часть SIGN, как «-», «−», «–» вплотную к числу;
  //  · тире U+2014/U+2015 вплотную к числу или валюте и слова «минус»/«negative» перед числом — знак НЕЯСЕН: число помечается как отрицательное и
  //    никогда не совпадает с доказательством (V_NO_MATCH и при отрицательном, и при положительном evidence; нет числа рядом — V_AMBIGUOUS_NUMBER).
  //    Тире между словами («Шаг 1 — проверьте») и «–» через пробел (пункт списка) — не знак.
  st.w = st.w.replace(/\u2212[ \t\u00a0\u202f]+(?=[\d€$£₽])/gu, (m) => '\u0001'.repeat(m.length - 1) + '\u2212');
  scan(/[\u2014\u2015](?=[\d€$£₽]|[A-Z]{3,5}(?![\p{L}]))/gu, () => ({ kind: '__signword' }));
  scan(/(?<![\p{L}])(?:минус\p{L}*|minus|negative)(?![\p{L}])[ \t\u00a0\u202f]*(?=[-−–]?(?:[€$£₽]|\d)|[A-Z]{3,5}(?![\p{L}])[ \t\u00a0\u202f]?[-−–]?\d)/giu, () => ({ kind: '__signword' }));

  // 5. проценты
  scan(new RegExp('(?<![\\d])(' + SIGN + ')?(' + NUMG + ')\\s?(?:%|процент\\p{L}*|percent(?![\\p{L}]))', 'giu'), (m) => {
    const p = num_parts(m[2]);
    return p === null ? { kind: 'ambiguous' } : { kind: 'pct', neg: m[1] !== undefined, digits: p.int + p.frac, dp: p.frac.length };
  });

  // 6. деньги
  const money_q = (neg, num, cur) => {
    const p = num_parts(num);
    if (p === null) return { kind: 'ambiguous' };
    return { kind: 'money', cur, neg, digits: p.int + p.frac, dp: p.frac.length };
  };
  scan(new RegExp('(' + SIGN + ')?([€$£₽])\\s?(' + SIGN + ')?(?<![\\d])(' + NUMG + ')', 'gu'), (m) => money_q(m[1] !== undefined || m[3] !== undefined, m[4], SYMBOL_CODES[m[2]]));
  scan(new RegExp('(?<![\\d])(' + SIGN + ')?(' + NUMG + ')\\s?([€$£₽]|(?<![\\p{L}])[A-Z]{3,5}(?![\\p{L}]))', 'gu'), (m) => {
    const cur = SYMBOL_CODES[m[3]] ?? m[3];
    return currency_known(cur) ? money_q(m[1] !== undefined, m[2], cur) : null;
  });
  scan(new RegExp('(?<![\\p{L}])([A-Z]{3,5})(?![\\p{L}])\\s?(' + SIGN + ')?(?<![\\d])(' + NUMG + ')', 'gu'), (m) => (currency_known(m[1]) ? money_q(m[2] !== undefined, m[3], m[1]) : null));

  // 7. дни, единицы, числительные словами
  scan(/(?<![\d.,])(\d+)\s?(?:дн\.|дней|день|дня|дн(?![\p{L}])|days?)(?![\p{L}])/giu, (m) => ({ kind: 'days', n: Number(m[1]) }));
  scan(/(?<![\d.,])(\d+)\s?(?:недел(?:я|и|ю|ь|е|ей)|месяц(?:а|ев|у|е)?|год(?:а|у|ом|ов|ы)?|лет|час(?:а|ов|ы)?|мин(?:ут\p{L}*)?|weeks?|months?|years?|hours?|minutes?)(?![\p{L}])/giu, () => ({ kind: 'unit' }));
  scan(new RegExp('(?<![\\p{L}])(?:' + NUMERALS + ')(?:[\\s-]+(?:' + NUMERALS + ')){0,8}\\s+' + SPELLED_UNITS + '(?![\\p{L}])', 'giu'), () => ({ kind: 'spelled' }));

  // 7b. числа словами без единицы (Q-06): серия из ≥ 2 числительных подряд («девятьсот девяносто девять», «ninety nine», «nine hundred and ninety nine»)
  // и одиночное «круглое» числительное (двадцать…девяносто, сто…девятьсот, twenty…hundred). Одиночные «один/две/три/one/two…» — идиомы
  // («одна из причин»), не трогаем (граница по К-12-подобному решению владельца).
  scan(new RegExp('(?<![\\p{L}])(?:' + NUMERALS_ALL + ')(?:(?:[\\s-]+and)?[\\s-]+(?:' + NUMERALS_ALL + ')){1,8}(?![\\p{L}])', 'giu'), () => ({ kind: 'spelled' }));
  scan(new RegExp('(?<![\\p{L}])(?:' + NUMERALS_ROUND + ')(?![\\p{L}])', 'giu'), () => ({ kind: 'spelled' }));

  // 8. счётчики
  scan(/(?<![\d.,])(\d+)\s?(?:из|of)\s?(\d+)(?!\d)/giu, (m) => ({ kind: '__pair', n: Number(m[1]), n2: Number(m[2]) }));
  scan(/(?<![\d.,])(\d+)\s?(?:плат[её]ж\p{L}*|событ\p{L}*|волн\p{L}*|случа\p{L}*|раз(?:а)?|payments?|events?|waves?|cases?|times?)(?![\p{L}])/giu, (m) => ({ kind: 'count', n: Number(m[1]) }));

  // 9. маркеры шагов и нумерация строк — пропуск (маскируются, количеств не дают)
  scan(/(?<![\p{L}])(?:Шаг|Step|Paso|№|#)\s*\d{1,2}(?!\d)/giu, () => ({ kind: '__skip' }));
  scan(/^[ \t]*\d{1,2}[.)](?=\s)/gmu, () => ({ kind: '__skip' }));

  // 10. остаток: числа
  scan(new RegExp('(?<!\\d)' + NUMG, 'gu'), (m) => {
    const p = num_parts(m[0]);
    if (p === null) return { kind: 'ambiguous' };
    return { kind: 'number', digits: p.int + p.frac, dp: p.frac.length };
  });

  // 10b. цифры и числовые знаки не из ASCII (арабо-индийские, полноширинные, дроби, степени): не разбираем — значит, не пропускаем (fail-closed)
  scan(/(?![0-9])\p{N}+/gu, () => ({ kind: 'ambiguous' }));

  // «k из n» — два счётчика: каждый сверяется отдельно
  // маркеры «неясного знака» (тире, слова): ближайшее следом число становится «отрицательным и несверяемым»; нет числа — V_AMBIGUOUS_NUMBER
  const nums = st.out.filter((q) => q.kind === 'money' || q.kind === 'pct');
  for (const mk of st.out.filter((q) => q.kind === '__signword')) {
    const end = mk.index + mk.raw.length;
    const target = nums.find((q) => q.index >= end && q.index - end <= 1 && q.word_sign !== true);
    if (target === undefined) st.out.push({ kind: 'ambiguous', raw: mk.raw, index: mk.index });
    else { target.neg = true; target.word_sign = true; }
  }
  const flat = st.out.filter((q) => q.kind !== '__skip' && q.kind !== '__signword').flatMap((q) => (q.kind === '__pair' ? [{ kind: 'count', n: q.n, raw: q.raw, index: q.index }, { kind: 'count', n: q.n2, raw: q.raw, index: q.index }] : [q]));
  return flat.sort((a, b) => a.index - b.index);
}

/**
 * Сверка одного количества с одним доказательством (ALG-12): допуск задаёт точность, показанная в тексте (`q.dp`), границы включены.
 * money — вид, валюта, `q.dp ≤ exponent`; `m = digits·10^(exp − dp)·знак`; при `m ≠ 0` знак совпадает со знаком `ev.v`; `2·|m − v| ≤ 10^(exp − dp)`.
 * pct — то же для базисных пунктов (`q.dp ≤ 2`, `2·|m − v| ≤ 10^(2 − dp)`). date — месяц и день, год — если назван. days, count — равенство целых.
 * @param {{kind: string}} q
 * @param {import('./tools.mjs').Evidence} ev
 * @returns {boolean}
 */
export function match_quantity(q, ev) {
  if (q.word_sign === true) return false; // знак задан тире/словом (неясно): сверке не подлежит (Q-02)
  switch (q.kind) {
    case 'money': {
      if (ev.kind !== 'money' || q.cur !== ev.cur) return false;
      const exp = currency_exponent(ev.cur);
      if (q.dp > exp) return false;
      const scale = 10n ** BigInt(exp - q.dp);
      let m = BigInt(q.digits) * scale;
      if (q.neg) m = -m;
      const v = BigInt(ev.v);
      if (m !== 0n && (m < 0n) !== (v < 0n)) return false;
      const diff = m > v ? m - v : v - m;
      return 2n * diff <= scale;
    }
    case 'pct': {
      if (ev.kind !== 'pct_bp' || q.dp > 2) return false;
      const scale = 10n ** BigInt(2 - q.dp);
      let m = BigInt(q.digits) * scale;
      if (q.neg) m = -m;
      const v = BigInt(ev.v);
      if (m !== 0n && (m < 0n) !== (v < 0n)) return false;
      const diff = m > v ? m - v : v - m;
      return 2n * diff <= scale;
    }
    case 'date': {
      if (ev.kind !== 'date') return false;
      const y = Number(ev.v.slice(0, 4));
      const m = Number(ev.v.slice(5, 7));
      const d = Number(ev.v.slice(8, 10));
      return q.m === m && q.d === d && (q.y === null || q.y === y);
    }
    case 'days':
      return ev.kind === 'days' && ev.v === q.n;
    case 'count':
      return ev.kind === 'count' && ev.v === q.n;
    default:
      return false;
  }
}

const KIND_CODES = Object.freeze({
  markup: 'V_MARKUP', abbrev: 'V_ABBREVIATION', unit: 'V_UNIT', spelled: 'V_SPELLED', relative_date: 'V_RELATIVE_DATE', bad_date: 'V_BAD_DATE', ambiguous: 'V_AMBIGUOUS_NUMBER',
});

/** Ближайшее доказательство того же вида (для диагностики нарушения). */
function closest_of(q, pool) {
  const kind = q.kind === 'pct' ? 'pct_bp' : q.kind;
  let best = null;
  let best_d = null;
  for (const ev of pool) {
    if (ev.kind !== kind || (q.kind === 'money' && ev.cur !== q.cur)) continue;
    let d;
    if (q.kind === 'money' || q.kind === 'pct') {
      const scale = 10n ** BigInt((q.kind === 'money' ? currency_exponent(ev.cur) : 2) - Math.min(q.dp, q.kind === 'money' ? currency_exponent(ev.cur) : 2));
      const m = BigInt(q.digits) * scale * (q.neg ? -1n : 1n);
      const diff = m - BigInt(ev.v);
      d = diff < 0n ? -diff : diff;
    } else if (q.kind === 'days' || q.kind === 'count') d = BigInt(Math.abs(ev.v - q.n));
    else d = 0n;
    if (best_d === null || d < best_d) { best = ev; best_d = d; }
  }
  return best === null ? null : (best.id ?? null);
}

/**
 * Слой 2 для одного текста: независимый разбор и сверка с пулом доказательств. Коды нарушений: `V_MARKUP`, `V_ABBREVIATION`, `V_UNIT`, `V_SPELLED`,
 * `V_RELATIVE_DATE`, `V_BAD_DATE`, `V_AMBIGUOUS_NUMBER`, `V_UNITLESS` (число без единицы и без совпавшего счётчика), `V_PRECISION` (знаков больше, чем
 * в валюте), `V_NO_MATCH` (нет доказательства; `raw` — до 24 знаков, `closest` — ближайшее).
 * @param {string} text
 * @param {import('./tools.mjs').Evidence[]} pool доказательства утверждения ∪ эхо
 * @param {'ru'|'en'} [locale]
 * @param {{decimal?: string, thousands?: string, date?: string}|null} [number_format] формат чисел и дат пользователя (REQ-112): текст в нём разбирается так же строго
 * @returns {{code: string, raw: string, closest?: string|null}[]}
 */
export function verify_text(text, pool, locale = 'ru', number_format = null) {
  const V = [];
  for (const q of extract_quantities(text, locale, number_format)) {
    const raw = q.raw.slice(0, 24);
    if (KIND_CODES[q.kind] !== undefined) { V.push({ code: KIND_CODES[q.kind], raw }); continue; }
    if (q.kind === 'number') {
      const ok = q.dp === 0 && pool.some((ev) => ev.kind === 'count' && String(ev.v) === q.digits.replace(/^0+(?=\d)/, ''));
      if (!ok) V.push({ code: 'V_UNITLESS', raw });
      continue;
    }
    if ((q.kind === 'money' && q.dp > currency_exponent(q.cur)) || (q.kind === 'pct' && q.dp > 2)) { V.push({ code: 'V_PRECISION', raw }); continue; }
    if (!pool.some((ev) => match_quantity(q, ev))) V.push({ code: 'V_NO_MATCH', raw, closest: closest_of(q, pool) });
  }
  return V;
}

// ── слой 1: структура ─────────────────────────────────────────────────────────────────────────────────────────────────

function placeholders_of(t) {
  const e = [];
  const q = [];
  const other = [];
  for (const m of t.matchAll(/\{([^{}]*)\}/g)) {
    if (/^e\d+$/.test(m[1])) e.push(m[1]);
    else if (/^q\.[a-z0-9_]+$/.test(m[1])) q.push(m[1]);
    else other.push(m[1]);
  }
  return { e, q, other };
}

function is_obj(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

/** Ключи каталога из поля ответа (caveats/followups): не массив строк — пустой список (форму проверяет слой 1). */
function list_of_keys(x) {
  return Array.isArray(x) ? x.filter((k) => typeof k === 'string') : [];
}

/** Совпадает ли `c.t` с текстом утверждения того же шаблона, который строит движок (`fallback_answer`) для этого результата. */
function claim_text_in_catalog(cache, result, locale, c) {
  const key = result.call_id + '|' + locale;
  if (!cache.has(key)) {
    let texts = [];
    try { texts = fallback_answer(result, locale).claims.map((x) => x.tpl + '\u0000' + x.t); } catch { texts = []; }
    cache.set(key, new Set(texts));
  }
  return cache.get(key).has(c.tpl + '\u0000' + c.t);
}

/** Есть ли в тексте цифры вне плейсхолдеров (кроме «Шаг N», «N.» в начале строки). */
function has_raw_digit(t) {
  const s = t.replace(/\{[^{}]*\}/g, ' ').replace(/(?<![\p{L}])(?:Шаг|Step|Paso|№|#)\s*\d{1,2}(?!\d)/giu, ' ').replace(/^[ \t]*\d{1,2}[.)](?=\s)/gmu, ' ');
  return /\p{N}/u.test(s); // любые цифры Unicode, не только ASCII (fail-closed)
}

/**
 * Слой 1 (ALG-12): структура утверждений. Нарушения: `V_CALL` (нет результата с таким `call_id`), `V_PLACEHOLDER` (`{eN}` не из `refs` либо
 * неразрешённый слот), `V_REF` (нет такого evidence / такого эхо / ключа каталога), `V_RAW_DIGIT` (цифра вне плейсхолдеров), `V_SCOPE`
 * (сценарий не совпадает; число из режима, которого нет в области утверждения), `V_SHORTAGE` (число «не хватает» — только шаблоном с подписью ряда, C-067).
 * Область утверждения `scope.mode` — `plan`, `worse` или `both` (утверждение явно говорит об обоих режимах, как шаблоны Q3).
 * @param {{claims: object[], caveats?: string[], followups?: string[]}} answer
 * @param {import('./tools.mjs').Result[]} results
 * @param {{echo?: import('./tools.mjs').Evidence[], locale?: 'ru'|'en'}} [ctx]
 * @returns {{code: string, claim?: number}[]}
 */
export function check_structure(answer, results, ctx = {}) {
  const locale = ctx.locale ?? 'ru';
  const T = templates(locale);
  const R = new Map(results.filter((r) => !r.isError).map((r) => [r.call_id, r]));
  const echo_ids = new Set((ctx.echo ?? []).map((e) => e.id));
  const V = [];
  // Ответ модели — недоверенный ввод: форма проверяется до чтения полей, мусор даёт нарушение (fail-closed), а не исключение
  if (!is_obj(answer)) return [{ code: 'V_REF' }];
  if (answer.claims !== undefined && answer.claims !== null && !Array.isArray(answer.claims)) V.push({ code: 'V_REF' });
  for (const key of ['caveats', 'followups']) {
    if (answer[key] !== undefined && answer[key] !== null && !(Array.isArray(answer[key]) && answer[key].every((k) => typeof k === 'string'))) V.push({ code: 'V_REF' });
  }
  const catalog_texts = new Map(); // call_id → тексты утверждений каталога (для сверки «tpl + свободный t»)
  (Array.isArray(answer.claims) ? answer.claims : []).forEach((c, i) => {
    if (!is_obj(c) || (c.refs !== undefined && c.refs !== null && !(Array.isArray(c.refs) && c.refs.every((x) => typeof x === 'string')))
      || (c.t !== undefined && typeof c.t !== 'string') || (c.tpl !== undefined && c.tpl !== null && typeof c.tpl !== 'string')) {
      V.push({ code: 'V_REF', claim: i });
      return;
    }
    const r = R.get(c.call);
    if (r === undefined) { V.push({ code: 'V_CALL', claim: i }); return; }
    const text = c.t ?? (c.tpl === undefined || c.tpl === null ? undefined : tpl_text(T, c.tpl));
    if (typeof text !== 'string') { V.push({ code: 'V_REF', claim: i }); return; }
    const ph = placeholders_of(text);
    const ids = new Set(r.evidence.map((e) => e.id));
    const refs = c.refs ?? [];
    for (const id of ph.e) {
      if (!refs.includes(id)) V.push({ code: 'V_PLACEHOLDER', claim: i });
      if (!ids.has(id)) V.push({ code: 'V_REF', claim: i });
    }
    for (const x of ph.q) if (!echo_ids.has(x)) V.push({ code: 'V_REF', claim: i });
    for (const _x of ph.other) V.push({ code: 'V_PLACEHOLDER', claim: i });
    if (has_raw_digit(text)) V.push({ code: 'V_RAW_DIGIT', claim: i });
    // V_SHORTAGE (C-067) проверяется для всякого текста, не являющегося точным текстом шаблона каталога: подпись «tpl» у свободного
    // текста (WAVES.ONE, OUTSIDE, CAV.LIQUIDITY…) не даёт права показать число «дефицит волны» под видом остатка (баг D-01)
    const from_catalog = c.tpl !== undefined && c.tpl !== null && (c.t === undefined || claim_text_in_catalog(catalog_texts, r, locale, c));
    const sc = is_obj(c.scope) ? c.scope : {};
    if ((sc.scenario_id ?? null) !== (r.scope.scenario_id ?? null)) V.push({ code: 'V_SCOPE', claim: i });
    const allowed = sc.mode === 'both' ? new Set(['plan', 'worse']) : new Set([sc.mode]);
    for (const id of refs) {
      const M = modes_of(r, id);
      if (M.size > 0) { for (const m of M) if (!allowed.has(m)) { V.push({ code: 'V_SCOPE', claim: i }); break; } } else if (sc.mode !== r.scope.mode && sc.mode !== 'both') V.push({ code: 'V_SCOPE', claim: i });
      if (!from_catalog && paths_of(r, id).some((p) => /(^|\.)(gap|short_to_buffer_minor)$/.test(p))) V.push({ code: 'V_SHORTAGE', claim: i });
    }
  });
  for (const k of [...list_of_keys(answer.caveats), ...list_of_keys(answer.followups)]) if (tpl_text(T, k) === undefined) V.push({ code: 'V_REF' });
  return V;
}

/**
 * Проверка ответа: слой 1 (структура) + слой 2 (независимый разбор отрендеренного текста каждого утверждения и сверка с `evidence ∪ эхо`).
 * Результат не зависит от порядка утверждений. Fail-closed: неоднозначное — нарушение.
 * @param {{claims: object[], caveats?: string[], followups?: string[]}} answer
 * @param {import('./tools.mjs').Result[]} results
 * @param {{echo?: import('./tools.mjs').Evidence[], locale?: 'ru'|'en', number_format?: object|null}} [ctx]
 * @returns {{ok: boolean, violations: {code: string, claim?: number, raw?: string, closest?: string|null}[]}}
 */
export function verify_answer(answer, results, ctx = {}) {
  const locale = ctx.locale ?? 'ru';
  const echo = ctx.echo ?? [];
  const number_format = ctx.number_format ?? null; // формат чисел и дат пользователя (REQ-112, FP-16)
  const V = check_structure(answer, results, ctx);
  if (!is_obj(answer) || !Array.isArray(answer.claims)) return { ok: V.length === 0, violations: V };
  const R = new Map(results.filter((r) => !r.isError).map((r) => [r.call_id, r]));
  answer.claims.forEach((c, i) => {
    if (!is_obj(c)) return; // уже V_REF слоя 1
    const r = R.get(c.call);
    if (r === undefined) return;
    let text;
    try {
      text = render_claim(c, r, locale, echo, number_format);
    } catch {
      return; // неразрешённый плейсхолдер уже отмечен слоем 1
    }
    const pool = [...(Array.isArray(c.refs) ? c.refs : []).map((id) => ev_by_id(r, id)).filter((e) => e !== undefined), ...echo];
    for (const v of verify_text(text, pool, locale, number_format)) V.push({ ...v, claim: i });
  });
  return { ok: V.length === 0, violations: V };
}

// ── A0: команда → инструмент → шаблон ─────────────────────────────────────────────────────────────────────────────────

/**
 * Статичный текст ошибки инструмента (без значений аргументов).
 * @param {{code: string}} err
 * @param {'ru'|'en'} [locale]
 */
export function error_text(err, locale = 'ru') {
  const T = templates(locale);
  return T['ERR.' + err.code] ?? T['ERR.other'];
}

/**
 * Ответ режима A0 (без LLM): команда → инструмент → шаблон каталога → проверка → текст. Команда — `{name, args}` либо массив слов
 * (`parse_command`). Рендер выполняет `fallback_answer`; текст всегда проходит `verify_answer` (`verified`).
 * @param {{name: string, args: object}|string[]} command
 * @param {object} ctx контекст раннера (`make_tool_ctx`)
 * @param {{locale?: 'ru'|'en', number_format?: object|null, notes?: string[]}} [opts] `number_format` внутри `opts` — второй способ передать формат; если заданы оба, действует четвёртый параметр;
 *   `notes` (FP-20) — ключи шаблонов допущений из `EXT_NOTES` (`SHIFT.NOTE`, `SHIFT.NOTE_DEFAULT`): после утверждения инструмента добавляется утверждение с этим шаблоном,
 *   его числа берутся из эхо вопроса и проходят тот же верификатор; ключ вне `EXT_NOTES` — `E_SCHEMA`
 * @param {{decimal?: string, thousands?: string, date?: string}|null} [number_format] формат чисел и дат пользователя (`ws.number_format`, REQ-112, FP-16): суммы и даты
 *   ответа показываются в нём, а слой 2 сверяет текст по тому же формату; по умолчанию (и при недопустимом значении) — по языку, как прежде
 * @returns {{ok: boolean, text: string, source: 'template', result?: object, answer?: object, echo?: object[], verified?: boolean, violations?: object[], error?: object}}
 */
export function a0_answer(command, ctx, opts = {}, number_format = null) {
  const locale = opts.locale ?? ctx.locale ?? 'ru';
  const nf = number_format ?? opts.number_format ?? null; // формат чисел и дат пользователя (REQ-112, FP-16); по умолчанию — по языку
  const cmd = Array.isArray(command) ? parse_command(command) : command;
  const r = run_tool(cmd.name, cmd.args, ctx);
  if (r.isError) return { ok: false, text: error_text(r, locale), source: 'template', error: r };
  const echo = build_echo([cmd], ctx.params, ctx.decision_currency);
  // срок сдвига для допущения — из проверенных аргументов вызова: эхо `q.days` в `build_echo` — параметр режима «если хуже» (14 дней), а не срок из вопроса
  const shift = Array.isArray(opts.notes) && opts.notes.length > 0 && Array.isArray(cmd.args?.ops) ? cmd.args.ops.find((o) => o?.op === 'delay_income') : undefined;
  if (shift !== undefined && Number.isSafeInteger(shift.days) && shift.days > 0) echo.push({ id: 'q.shift_days', ...make_evidence('days', shift.days) });
  ctx.echo = echo;
  const answer = fallback_answer(r, locale);
  for (const key of Array.isArray(opts.notes) ? opts.notes : []) {
    if (!EXT_NOTES.includes(key)) fail('E_SCHEMA', { reason: 'unknown_note' });
    answer.claims.push(build_claim(r, locale, key, { scope_mode: r.scope.mode }));
  }
  const v = verify_answer(answer, [r], { echo, locale, number_format: nf });
  return { ok: true, text: render_answer(answer, [r], locale, echo, nf), source: 'template', result: r, answer, echo, verified: v.ok, violations: v.violations };
}

/** Шаблоны допущений, которые можно добавить к ответу через `opts.notes` у `a0_answer` (FP-20). */
export const EXT_NOTES = Object.freeze(['SHIFT.NOTE', 'SHIFT.NOTE_DEFAULT']);

const NUM_ARG = /^-?\d+$/;

/**
 * Разбор команды A0 из слов (CLI): `check-purchase <date> <amount_minor> <CUR> [--buffer N]`, `projection <to> [from]`, `max-amount <date>`,
 * `earliest <amount_minor> <CUR> [not_before]`, `waves <from> <to>`, `explain [top_k]`, `scenario delay <event_ref> <days>`,
 * `scenario purchase <date> <amount_minor> <CUR>`, `changed <since>`, `tax [as_of]`, `propose skip <ref> | move <ref> <date> | add <date> <amount_minor> <CUR>`;
 * общий ключ `--mode plan|worse`. Суммы — целые minor units. Неверная команда — `E_SCHEMA`.
 * Слова новых намерений (FP-20) — в отдельной таблице `EXT_COMMANDS`: `what-changed <since>`, `shift <event_ref> <дней>`, `reserve [as_of]`.
 * @param {string[]} words
 * @returns {{name: string, args: object}}
 */
export function parse_command(words) {
  const w = [...words];
  const opt = {};
  for (let i = 0; i < w.length; i++) {
    if (w[i] === '--mode' || w[i] === '--buffer') {
      opt[w[i].slice(2)] = w[i + 1];
      w.splice(i, 2);
      i -= 1;
    }
  }
  const n = (s) => (NUM_ARG.test(String(s)) ? Number(s) : s);
  const cmd = w[0];
  let name;
  let args;
  switch (cmd) {
    case 'check-purchase': name = 'check_purchase'; args = { date: w[1], amount_minor: n(w[2]), currency: w[3] }; if (opt.buffer !== undefined) args.buffer_minor = n(opt.buffer); break;
    case 'projection': name = 'get_projection'; args = { to: w[1] }; if (w[2] !== undefined) args.from = w[2]; break;
    case 'max-amount': name = 'max_purchase_amount'; args = { date: w[1] }; break;
    case 'earliest': name = 'earliest_safe_date'; args = { amount_minor: n(w[1]), currency: w[2] }; if (w[3] !== undefined) args.not_before = w[3]; break;
    case 'waves': name = 'list_waves'; args = { from: w[1], to: w[2] }; break;
    case 'explain': name = 'explain_min_point'; args = w[1] === undefined ? {} : { top_k: n(w[1]) }; break;
    case 'scenario':
      name = 'run_scenario';
      if (w[1] === 'delay') args = { ops: [{ op: 'delay_income', event_ref: w[2], days: n(w[3]) }] };
      else if (w[1] === 'purchase') args = { ops: [{ op: 'add_purchase', date: w[2], amount_minor: n(w[3]), currency: w[4] }] };
      else return fail('E_SCHEMA', { reason: 'bad_command' });
      break;
    case 'changed': name = 'what_changed'; args = { since: w[1] }; break;
    case 'tax': name = 'get_tax_envelope'; args = w[1] === undefined ? {} : { as_of: w[1] }; break;
    case 'propose':
      name = 'propose_change';
      if (w[1] === 'skip') args = { ops: [{ op: 'skip_plan', ref: w[2] }] };
      else if (w[1] === 'move') args = { ops: [{ op: 'move_plan', ref: w[2], date: w[3] }] };
      else if (w[1] === 'add') args = { ops: [{ op: 'add_plan', date: w[2], amount_minor: n(w[3]), currency: w[4] }] };
      else return fail('E_SCHEMA', { reason: 'bad_command' });
      break;
    default: {
      // слова новых намерений (FP-20) — отдельная таблица `EXT_COMMANDS`; прежние слова разобраны выше и не затронуты
      const ext_cmd = typeof cmd === 'string' && Object.hasOwn(EXT_COMMANDS, cmd) ? EXT_COMMANDS[cmd] : undefined;
      if (ext_cmd === undefined) return fail('E_SCHEMA', { reason: 'bad_command' });
      ({ name, args } = ext_cmd(w, n));
    }
  }
  for (const k of Object.keys(args)) if (args[k] === undefined) delete args[k];
  if (opt.mode !== undefined) args.mode = opt.mode;
  return { name, args };
}

// ── новые намерения A0 (FP-20): отдельная таблица; прежний разбор не затронут ────────────────────────────────────────────

/**
 * Слова новых намерений в `parse_command` (CLI и тесты): `what-changed <дата|c_hex>`, `shift <event_ref> <дней>` (сдвиг ожидаемого поступления),
 * `reserve [as_of]` (резервы). Таблица отдельная: слова прежнего разбора (`changed`, `scenario delay`, `tax`) остаются как были.
 * @type {Readonly<Object<string, (w: string[], n: (s: string) => any) => {name: string, args: object}>>}
 */
export const EXT_COMMANDS = Object.freeze({
  'what-changed': (w) => ({ name: 'what_changed', args: { since: w[1] } }),
  shift: (w, n) => ({ name: 'run_scenario', args: { ops: [{ op: 'delay_income', event_ref: w[1], days: n(w[2]) }] } }),
  reserve: (w) => ({ name: 'get_tax_envelope', args: w[1] === undefined ? {} : { as_of: w[1] } }),
});

// `\b` в JS видит границу слова только у латиницы, поэтому после кириллического «с/за/после» он не срабатывал и ветка «изменения с …» была мертва; граница — «не буква и не цифра»
const RE_CHANGED = /что\s+(?:у\s+меня\s+)?(?:изменил\p{L}*|поменял\p{L}*)|какие\s+изменени\p{L}*|изменени\p{L}*\s+(?:с|за|после)(?![\p{L}\p{N}])|что\s+нового|what\s+(?:has\s+|have\s+)?changed|what(?:'s|\s+is)\s+(?:new|different)|changes\s+(?:since|from)\b/u;
const RE_SINCE_YESTERDAY = /вчера|yesterday/u;
const RE_SINCE_WEEK = /за\s+(?:последн\p{L}*\s+)?недел\p{L}*|(?:last|past)\s+week|in\s+the\s+last\s+week/u;
const RE_SINCE_MONTH = /за\s+(?:последн\p{L}*\s+)?месяц|(?:last|past)\s+month|in\s+the\s+last\s+month/u;
const RE_SINCE_LAST_CALL = /с\s+прошл\p{L}*\s+раза|с\s+последн\p{L}*\s+(?:вопрос|раза)|since\s+(?:the\s+)?last\s+(?:time|question|call)|last\s+time/u;
const RE_SHIFT = /(?:сдвин|перенес|перенос|отодвин|сместит|отложит)\p{L}*[^.?!]*?(?:плат[её]ж|выплат|поступлен|оплат|доход)|(?:плат[её]ж|выплат|поступлен|оплат|доход)\p{L}*[^.?!]*?(?:сдвин|перенес|перенос|отодвин|сместит|отложит)|\b(?:shift|move|push|postpone|defer)\b[^.?!]*?\b(?:payments?|payouts?|income|receipts?|invoices?)\b|\b(?:payments?|payouts?|income|receipts?|invoices?)\b[^.?!]*?\b(?:shifted|moved|pushed|postponed|deferred)\b/u;
const RE_OWN_PAYMENT = /аренд|жкх|коммунал|связ[иь]|телефон|продукт|налог|кредит|долг|рассрочк|взнос|подписк|\brent\b|utilit|phone|grocer|\btax|loan|debt|instal|subscription/u;
const RE_RESERVE = /резерв|накоплен|reserve|set[\s-]?aside|sinking/u;
// Слова, прямо называющие поступление: при них «платёж» — приход, и сдвиг ближайшего ожидаемого поступления отвечает на вопрос без допущения о слове «платёж».
const RE_INCOME_WORD = /поступлен|выплат|клиент|заказчик|доход|зарплат|гонорар|получк|\b(?:payouts?|income|receipts?|invoices?|clients?|customers?|salary|paycheck)\b/u;
// «Платёж» с уточнением, что именно за платёж, — это свой расход, который в реестре из 10 инструментов не сдвигается (список слов RE_OWN_PAYMENT неполон: ипотека, квартира, страховка, садик…).
// Уточнение — предлог («платёж по ипотеке», «за квартиру», «payment for the loan») либо слово перед «платёж» (прилагательное «ипотечный»; «mortgage payment»), кроме общих («ближайший», «next», «the»).
const RE_PAYMENT_BY_RU = /плат[её]ж\p{L}*\s+(?:по|за|для|в\s+сч[её]т)\s+(?!\d|недел|дн[яей]|день|месяц|плану|факту)\p{L}/u; // «по плану / по факту» — режим ответа, а не название платежа
const RE_PAYMENT_FOR_EN = /\bpayments?\s+(?:for|of|to)\s+(?!\d)[a-z]/u;
const RE_PAYMENT_ADJ_RU = /(\p{L}{4,}(?:ый|ий|ой|ая|яя|ое|ее|ые|ие|ого|его|ому|ему|ым|им|ую|юю|ых|их))\s+плат[её]ж/u;
const RE_GENERIC_ADJ_RU = /^(?:ближайш|следующ|очередн|ожидаем|входящ|любо|кажд|предстоящ|будущ|первы|послед|един|нужн)/u;
const RE_WORD_BEFORE_PAYMENT_EN = /\b([a-z][a-z'-]*)\s+payments?\b/gu;
const EN_GENERIC_BEFORE_PAYMENT = new Set([
  'the', 'a', 'an', 'my', 'our', 'your', 'his', 'her', 'their', 'this', 'that', 'these', 'those', 'next', 'first', 'last', 'expected', 'incoming', 'nearest', 'upcoming',
  'coming', 'any', 'each', 'every', 'one', 'all', 'some', 'shift', 'move', 'push', 'postpone', 'defer', 'delay', 'if', 'we', 'i', 'you', 'to', 'can', 'could', 'would',
  'should', 'what', 'then', 'and', 'or', 'by', 'of', 'in', 'on', 'it', 'is', 'are', 'be', 'also', 'just', 'only', 'such', 'whole', 'entire',
]);

/** Названо ли в вопросе, какой именно собственный платёж сдвигать (и нет ли слов, прямо называющих поступление). */
function names_own_payment(q) {
  const s = q.toLowerCase();
  if (RE_INCOME_WORD.test(s)) return false;
  if (RE_PAYMENT_BY_RU.test(s) || RE_PAYMENT_FOR_EN.test(s)) return true;
  const adj = RE_PAYMENT_ADJ_RU.exec(s);
  if (adj !== null && !RE_GENERIC_ADJ_RU.test(adj[1])) return true;
  for (const m of s.matchAll(RE_WORD_BEFORE_PAYMENT_EN)) if (!EN_GENERIC_BEFORE_PAYMENT.has(m[1])) return true;
  return false;
}

/** Срок сдвига в днях: «на 10 дней», «2 недели», «на неделю»; `null` — срока в вопросе нет. */
function shift_days_of(q) {
  let m = /(\d{1,3})\s*(?:дн\p{L}*|день|days?)/u.exec(q);
  if (m !== null) return Number(m[1]);
  m = /(\d{1,2})\s*(?:недел\p{L}*|weeks?)/u.exec(q);
  if (m !== null) return Number(m[1]) * 7;
  return /на\s+недел\p{L}*|\ba\s+week\b|one\s+week/u.test(q) ? 7 : null;
}

/**
 * День, с которого сравнивать для «что изменилось»: дата вопроса (будущая без года — прошлогодняя; будущая с годом — не принимается),
 * «вчера», «за неделю», «за месяц» либо вызов `c_<hex>` («с прошлого раза»). `null` — основания нет.
 * @param {string} q
 * @param {{as_of: string, date?: string|null, date_explicit?: boolean, last_call?: string|null}} info
 * @returns {string|null} `YYYY-MM-DD` или `c_` + 8 hex-знаков
 */
function since_of(q, info) {
  if (typeof info.as_of !== 'string') return null;
  const as_of = parse_date(info.as_of);
  if (typeof info.date === 'string') {
    let d = parse_date(info.date);
    if (d > as_of) {
      if (info.date_explicit === true) return null;
      const [y, m, day] = civil_from_days(d);
      d = days_from_civil(y - 1, m, day);
    }
    return d <= as_of ? format_date(d) : null;
  }
  if (RE_SINCE_LAST_CALL.test(q)) return typeof info.last_call === 'string' && /^[0-9a-f]{8}$/.test(info.last_call) ? 'c_' + info.last_call : null;
  if (RE_SINCE_YESTERDAY.test(q)) return format_date(as_of - 1);
  if (RE_SINCE_WEEK.test(q)) return format_date(as_of - 7);
  if (RE_SINCE_MONTH.test(q)) return format_date(as_of - 30);
  return null;
}

/**
 * Таблица новых намерений ассистента A0 (FP-20): «что изменилось с <даты>» → `what_changed`, «а если сдвинуть платёж» → `run_scenario` со сдвигом
 * ожидаемого поступления, «что с резервом» → `get_tax_envelope`. Запись: `{id, tool, re, build(q, info)}`. Таблица опрашивается только тогда, когда прежние правила
 * разбора вопроса его не распознали, поэтому ни один прежний вопрос не меняет ответа.
 */
export const EXT_INTENTS = Object.freeze([
  Object.freeze({
    id: 'changed',
    tool: 'what_changed',
    re: RE_CHANGED,
    build(q, info) {
      const since = since_of(q, info);
      if (since === null) return { ok: false, reason: 'no_since' };
      // дата без года, ушедшая на прошлый год (будущая «20 октября» при дне расчёта 4 октября → 2025): страница называет год в пояснении, иначе «с 20 октября» читалось бы как этот год
      const rolled = typeof info.date === 'string' && info.date_explicit !== true && since.slice(0, 4) !== info.as_of.slice(0, 4);
      return { ok: true, command: { name: 'what_changed', args: { since } }, intent: 'changed', ...(rolled ? { assumed: { year_rolled: true } } : {}) };
    },
  }),
  Object.freeze({
    id: 'shift',
    tool: 'run_scenario',
    re: RE_SHIFT,
    build(q, info) {
      if (RE_OWN_PAYMENT.test(q) || names_own_payment(q)) return { ok: false, reason: 'shift_unsupported' }; // сдвиг расхода в реестре из 10 инструментов не выражается
      if (info.income_ref === null || info.income_ref === undefined) return { ok: false, reason: 'no_income' };
      const given = shift_days_of(q);
      if (given === null && typeof info.date === 'string') return { ok: false, reason: 'shift_days' };
      const days = given ?? 14;
      // допущение («сдвигается ближайшее ожидаемое поступление, срок по умолчанию») называет сам ответ: шаблон из каталога, число срока — из эхо вопроса
      return {
        ok: true, command: { name: 'run_scenario', args: { ops: [{ op: 'delay_income', event_ref: info.income_ref, days }] } }, intent: 'shift',
        notes: [given === null ? 'SHIFT.NOTE_DEFAULT' : 'SHIFT.NOTE'],
      };
    },
  }),
  Object.freeze({
    id: 'reserve',
    tool: 'get_tax_envelope',
    re: RE_RESERVE,
    build() {
      return { ok: true, command: { name: 'get_tax_envelope', args: {} }, intent: 'reserve' };
    },
  }),
]);

/**
 * Разобрать вопрос по таблице новых намерений. Текст — в нижнем регистре, «ё» → «е», с вырезанной датой (как у прежнего разбора в демо).
 * @param {string} q
 * @param {{as_of: string, date?: string|null, date_explicit?: boolean, income_ref?: string|null, last_call?: string|null}} info
 *   `as_of` — день расчёта; `date` — дата, найденная в вопросе; `date_explicit` — в дате был год; `income_ref` — ближайшее ожидаемое поступление;
 *   `last_call` — hex предыдущего вызова ассистента (для «с прошлого раза»)
 * @returns {{ok: true, command: {name: string, args: object}, intent: string, notes?: string[], assumed?: {year_rolled: true}}|{ok: false, reason: 'no_since'|'shift_days'|'shift_unsupported'|'no_income'}|null}
 *   `null` — вопрос не относится к новым намерениям; `notes` (сдвиг) — ключи шаблонов допущений для `a0_answer`; `assumed.year_rolled` («что изменилось») — дата без года понята как прошлогодняя
 */
export function parse_ext_intent(q, info) {
  const text = String(q ?? '');
  for (const it of EXT_INTENTS) if (it.re.test(text)) return it.build(text, info ?? {});
  return null;
}

// ── A1–A3 (v2): политика при расхождении ──────────────────────────────────────────────────────────────────────────────

/**
 * Сборщик payload для модели (A2/A3): только результаты без недоверенного текста — имя инструмента, область, факты и evidence БЕЗ `event_ids`
 * (не `timeline.project`, ряды модель не получает).
 * @param {import('./tools.mjs').Result[]} results
 * @returns {object[]}
 */
export function payload_for(results) {
  return results.filter((r) => !r.isError).map((r) => ({
    call_id: r.call_id, tool: r.tool, scope: r.scope, facts: r.facts, evidence: r.evidence.map(({ id, kind, v, cur, dp }) => ({ id, kind, v, cur, dp })),
  }));
}

/** Вызов порта модели: исключение порта — «нет ответа» (дальше он отвергнут верификатором, откат на шаблон). */
function safe_call(fn) {
  try { return fn(); } catch { return null; }
}

/**
 * Вопрос → ответ (A1–A3, v2; в A0 — `a0_answer`). Две фазы: `llm.plan(question, tools)` выбирает вызовы (без данных и недоверенного текста),
 * `llm.compose(question, payload, violations)` пишет структурный ответ (без инструментов). Проверка: попытка 0 и один повтор с кодами нарушений
 * (без исходных строк); иначе — шаблон `fallback_answer` (доля «с первого раза» — метрика).
 * @param {string} question
 * @param {object} ctx контекст раннера
 * @param {{plan: Function, compose: Function}} llm порты модели
 * @returns {{text: string, source: 'llm'|'llm_retry'|'template', violations?: object[]}}
 */
export function answer_question(question, ctx, llm) {
  const locale = ctx.locale ?? 'ru';
  // порты модели недоверенные: план — только массив объектов, мусор отбрасывается; исключение порта не роняет процесс
  const planned = safe_call(() => llm.plan(question, null));
  const calls = Array.isArray(planned) ? planned.filter(is_obj) : [];
  const results = calls.map((c) => run_tool(c.name, c.args, ctx));
  const ok_calls = calls.filter((_c, i) => !results[i].isError);
  const echo = build_echo(ok_calls, ctx.params, ctx.decision_currency);
  ctx.echo = echo;
  const good = results.filter((r) => !r.isError);
  const payload = payload_for(good);
  let answer = safe_call(() => llm.compose(question, payload, null));
  let last = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const v = verify_answer(answer, good, { echo, locale });
    if (v.ok) return { text: render_answer(answer, good, locale, echo), source: attempt === 0 ? 'llm' : 'llm_retry' };
    last = v.violations;
    if (attempt === 0) answer = safe_call(() => llm.compose(question, payload, v.violations.map(({ code, claim }) => ({ code, claim }))));
  }
  if (good.length === 0) return { text: error_text(results[0] ?? { code: 'other' }, locale), source: 'template', violations: last };
  const fb = fallback_answer(good[0], locale);
  return { text: render_answer(fb, good, locale, echo), source: 'template', violations: last };
}
