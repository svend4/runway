// i18n/mfeed.mjs — строки сообщения о закрытии окна прогноза (FP-22, REQ-185); ключи `mfeed.<имя>`.
// Формат каталога пакета: `export default { ru: {…}, en: {…} }`, паритет ключей и плейсхолдеров проверяет `register_strings` (TST-56).
// Формулировки без повелительного наклонения и без обещаний из списка запретов (REQ-114). В метрики идут только базисные пункты и «k из n» — сумм и дат нет.
// Расчёт по введённым данным и правилам, не консультация.

export default {
  ru: {
    'mfeed.closed': 'Окно прогноза на {days} дн. закрыто сверкой остатка. В метрики на устройстве записано: ошибка минимума {error}, {inside}. Сумм и дат в метриках нет.',
    'mfeed.closed_no_error': 'Окно прогноза на {days} дн. закрыто сверкой остатка. Ошибку минимума определить нельзя (прогнозный минимум равен нулю); в метрики записано только покрытие: {inside}. Сумм и дат в метриках нет.',
    'mfeed.inside_yes': 'факт попал в коридор «по плану» — «если хуже»',
    'mfeed.inside_no': 'факт вне коридора «по плану» — «если хуже»',
    'mfeed.failed': 'Окно прогноза закрыть не удалось: {code}. В метрики ничего не записано.',
  },
  en: {
    'mfeed.closed': 'The {days}-day forecast window is closed by the balance check. Recorded in the on-device metrics: minimum error {error}, {inside}. The metrics hold no amounts or dates.',
    'mfeed.closed_no_error': 'The {days}-day forecast window is closed by the balance check. The minimum error cannot be defined (the forecast minimum is zero); only coverage is recorded: {inside}. The metrics hold no amounts or dates.',
    'mfeed.inside_yes': 'the actual fell inside the “plan” to “if worse” corridor',
    'mfeed.inside_no': 'the actual fell outside the “plan” to “if worse” corridor',
    'mfeed.failed': 'The forecast window could not be closed: {code}. Nothing is recorded in the metrics.',
  },
};
