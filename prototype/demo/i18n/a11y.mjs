// i18n/a11y.mjs — строки пакета FP-26 (REQ-167): слова для скринридера. Дата и сумма в фразе «остаток 31 октября 2 055,00 евро» читаются словами:
// название валюты вместо знака («€», «$», «£», «₽» озвучиваются по-разному или пропускаются), «минус» вместо знака «−» (его читают не все программы чтения с экрана).
// Каталог { ru, en }: ключи `a11y.<имя>`, паритет RU/EN и одинаковые плейсхолдеры (TST-56). Названия валют — по четырём формам русского склонения
// (`one` — 1, `few` — 2…4, `many` — 5 и больше и 0, `frac` — дробное количество: «2,5 доллара»); английский различает только `one` и `other`, поэтому
// три остальные формы равны. Валют вне списка здесь нет: сумма читается с буквенным кодом ISO 4217 (см. demo/speech.mjs). Расчёт по введённым данным и правилам, не консультация.

export default {
  ru: {
    'a11y.minus': 'минус',

    'a11y.cur_eur_one': 'евро',
    'a11y.cur_eur_few': 'евро',
    'a11y.cur_eur_many': 'евро',
    'a11y.cur_eur_frac': 'евро',

    'a11y.cur_usd_one': 'доллар',
    'a11y.cur_usd_few': 'доллара',
    'a11y.cur_usd_many': 'долларов',
    'a11y.cur_usd_frac': 'доллара',

    'a11y.cur_gbp_one': 'фунт стерлингов',
    'a11y.cur_gbp_few': 'фунта стерлингов',
    'a11y.cur_gbp_many': 'фунтов стерлингов',
    'a11y.cur_gbp_frac': 'фунта стерлингов',

    'a11y.cur_rub_one': 'рубль',
    'a11y.cur_rub_few': 'рубля',
    'a11y.cur_rub_many': 'рублей',
    'a11y.cur_rub_frac': 'рубля',
  },
  en: {
    'a11y.minus': 'minus',

    'a11y.cur_eur_one': 'euro',
    'a11y.cur_eur_few': 'euros',
    'a11y.cur_eur_many': 'euros',
    'a11y.cur_eur_frac': 'euros',

    'a11y.cur_usd_one': 'dollar',
    'a11y.cur_usd_few': 'dollars',
    'a11y.cur_usd_many': 'dollars',
    'a11y.cur_usd_frac': 'dollars',

    'a11y.cur_gbp_one': 'pound sterling',
    'a11y.cur_gbp_few': 'pounds sterling',
    'a11y.cur_gbp_many': 'pounds sterling',
    'a11y.cur_gbp_frac': 'pounds sterling',

    'a11y.cur_rub_one': 'ruble',
    'a11y.cur_rub_few': 'rubles',
    'a11y.cur_rub_many': 'rubles',
    'a11y.cur_rub_frac': 'rubles',
  },
};
