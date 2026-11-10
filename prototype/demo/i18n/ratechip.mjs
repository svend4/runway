// i18n/ratechip.mjs — строки пакета FP-16: подпись курса и его возраста у каждой пересчитанной суммы, плашка «курс устарел», сообщение «нет курса».
// Пространство имён `ratechip`; паритет ключей и плейсхолдеров RU/EN проверяет tests/demo.test.mjs (TST-56), использование каждого ключа в коде — тот же тест.
// Курс — допущение пользователя (введён вручную, у него есть дата), а не данные сети: подпись всегда называет сам курс, дату курса и возраст в днях;
// «возраст» считается от даты расчёта (`rate_status` движка), предел «устарел» — параметр `fx.stale_days`. Расчёт по введённым данным и правилам, не консультация.

export default {
  ru: {
    // подпись курса (ALG-08 A08.6): «курс 0,9250 от 2026-10-04 · возраст 3 дн.»
    'ratechip.sign': 'курс {rate} от {date} · возраст {n} дн.',
    'ratechip.sign_inverse': 'курс {rate} от {date} (обратная пара) · возраст {n} дн.',
    'ratechip.stale_tag': 'курс устарел',
    'ratechip.shocked': 'с учётом сценария курса',
    // строка у суммы: исходная сумма и подпись курса («200,00 $ · курс 0,9250 от 2026-10-01 · возраст 3 дн.»)
    'ratechip.row': '{orig} · {sign}',
    // карточка волны: «Доллары: 200,00 $ → 185,00 € · курс …»
    'ratechip.wave_title': 'Пересчёт по курсу',
    'ratechip.wave_line': '{name}: {orig} → {conv} · {sign}',
    // сводка курсов, по которым пересчитан расчёт: ответ ассистента, лист для печати, v0
    'ratechip.note_item': '{pair}: {sign}',
    'ratechip.answer_note': 'Суммы в иностранной валюте пересчитаны по введённым курсам: {list}',
    'ratechip.report_note': 'Суммы в иностранной валюте пересчитаны в валюту решения по введённым курсам: {list}',
    // остаток на счёте в чужой валюте («Остаток на …» в шапке, шов ленты): остаток без событий тоже пересчитан по курсу
    'ratechip.balance_note': 'Остаток пересчитан по введённым курсам: {list}',
    // плашки в шапке и сообщения об ошибке
    'ratechip.warn_stale_n': 'Курс {pair} не обновлялся {n} дн.: суммы в {cur} пересчитаны по курсу от {date}. Введите новый курс: {where}.',
    'ratechip.err_no_rate': 'Нет курса {pair}: введите его — {where}.',
    'ratechip.err_no_rate_any': 'Нет курса для одной из валют: введите его — {where}.',
    'ratechip.pair_unknown': 'для этой пары валют',
  },
  en: {
    'ratechip.sign': 'rate {rate} of {date} · age {n} d',
    'ratechip.sign_inverse': 'rate {rate} of {date} (inverse pair) · age {n} d',
    'ratechip.stale_tag': 'rate is out of date',
    'ratechip.shocked': 'with the rate scenario applied',
    'ratechip.row': '{orig} · {sign}',
    'ratechip.wave_title': 'Converted at the rate',
    'ratechip.wave_line': '{name}: {orig} → {conv} · {sign}',
    'ratechip.note_item': '{pair}: {sign}',
    'ratechip.answer_note': 'Amounts in a foreign currency are converted at the rates you entered: {list}',
    'ratechip.report_note': 'Amounts in a foreign currency are converted into the decision currency at the rates you entered: {list}',
    'ratechip.balance_note': 'The balance is converted at the rates you entered: {list}',
    'ratechip.warn_stale_n': 'The {pair} rate has not been updated for {n} d: amounts in {cur} are converted at the rate of {date}. Enter a new rate: {where}.',
    'ratechip.err_no_rate': 'There is no {pair} rate: enter it — {where}.',
    'ratechip.err_no_rate_any': 'There is no rate for one of the currencies: enter it — {where}.',
    'ratechip.pair_unknown': 'for this currency pair',
  },
};
