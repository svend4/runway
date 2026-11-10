// speech.mjs — фразы для скринридера (FP-26, REQ-167): «остаток 31 октября 2 055,00 евро». Дата и сумма читаются словами, без знаков, которые программы чтения
// с экрана озвучивают по-разному или пропускают: вместо «€»/«$»/«£»/«₽» — название валюты в нужной форме, вместо «−» — слово «минус», дата — с названием месяца
// (числовой стиль даты из настройки «формат чисел» на слух неоднозначен: «04.10.2026» читают как «ноль четыре точка десять…»; на экране он остаётся как выбран).
// Числа не пересчитываются: цифры берутся из строки форматтера страницы (`fmt().money`), поэтому разделители разрядов и дроби — те, что выбрал пользователь.
// Модуль чистый: без DOM, без часов, импортируется в Node. Названия валют — в каталоге `i18n/a11y.mjs` (четыре валюты); для остальных читается код ISO 4217.
// Расчёт по введённым данным и правилам, не консультация.

import catalog from './i18n/a11y.mjs';
import { currency_exponent } from '../engine/index.mjs';
import { make_nf_fmt } from './number_format.mjs';

const MINUS_SIGN = '−';
const SYMBOLS = ['€', '$', '£', '₽'];
const NUMBER_RE = /^\d[\d.,\s ]*$/;

const lang_of = (lang) => (lang === 'en' ? 'en' : 'ru');

/** Форма названия валюты: русский — по числу целых (`one`/`few`/`many`), дробное количество — `frac`; английский — `one` только для ровно одной единицы. */
function money_form(lang, whole, has_frac) {
  if (has_frac) return 'frac';
  if (lang === 'en') return whole === 1 ? 'one' : 'few';
  const m10 = whole % 10;
  const m100 = whole % 100;
  if (m10 === 1 && m100 !== 11) return 'one';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'few';
  return 'many';
}

/**
 * Дата словами: «31 октября» (год не показывается, пока он совпадает с годом расчёта), «31 октября 2027 года», `October 31`, `October 31, 2027`.
 * @param {'ru'|'en'} lang
 * @param {string} iso дата `YYYY-MM-DD`
 * @param {string|null} [as_of_iso] дата расчёта: год показывается, только если он другой
 * @returns {string}
 */
export function spoken_date(lang, iso, as_of_iso = null) {
  const L = lang_of(lang);
  const text = make_nf_fmt(L, 'EUR', as_of_iso ?? iso, null).date(iso); // без настройки пользователя: название месяца словом (единый путь форматирования, REQ-112)
  const other_year = as_of_iso !== null && as_of_iso !== undefined && String(as_of_iso).slice(0, 4) !== String(iso).slice(0, 4);
  return L === 'ru' && other_year ? text + ' года' : text;
}

/**
 * Сумма словами: «2 055,00 евро», «минус 1 200,00 евро», `2,055.00 euros`. Цифры — из готовой строки форматтера, знак и символ валюты заменяются словами.
 * Валюты вне каталога: число и код ISO («1 000,00 CHF»).
 * @param {'ru'|'en'} lang
 * @param {number} minor сумма в minor units
 * @param {string} cur код валюты ISO 4217
 * @param {string} formatted та же сумма в формате страницы (`fmt().money(minor)`)
 * @returns {string}
 */
export function spoken_money(lang, minor, cur, formatted) {
  const L = lang_of(lang);
  const exp = currency_exponent(cur);
  const abs = Math.abs(minor);
  const unit = 10 ** exp;
  const whole = Math.floor(abs / unit);
  const has_frac = exp > 0 && abs % unit !== 0;
  let num = String(formatted).split(MINUS_SIGN).join('');
  for (const sym of SYMBOLS) num = num.split(sym).join('');
  num = num.split(cur).join('').trim();
  if (!NUMBER_RE.test(num)) num = String(formatted).trim(); // неожиданная форма строки: читается как есть, без догадок
  // русский: число с десятичным знаком («21,00», «2 055,00») управляет родительным падежом единственного числа («21,00 доллара»), даже когда дробная часть нулевая;
  // целые формы (1 → «доллар», 2…4 → «доллара», 5… → «долларов») — только когда сумма записана без дробной части (например, `money0`: «21»)
  const written_frac = exp > 0 && new RegExp('[.,]\\d{' + exp + '}$').test(num);
  const word = catalog[L]['a11y.cur_' + String(cur).toLowerCase() + '_' + money_form(L, whole, has_frac || (L === 'ru' && written_frac))] ?? cur;
  const sign = minor < 0 && abs !== 0 ? catalog[L]['a11y.minus'] + ' ' : '';
  return sign + num + ' ' + word;
}
