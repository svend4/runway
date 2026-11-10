// i18n/dslabel.mjs — подписи источника данных в переключателе «Набор данных» (FP-48); ключи `dslabel.<имя>`.
// Формат каталога пакета: `export default { ru: {…}, en: {…} }`, паритет ключей и плейсхолдеров проверяет `register_strings` и tests/demo.test.mjs (TST-56).
// Названия встроенных наборов (`ds.*`) остаются в каталоге страницы. Расчёт по введённым данным и правилам, не консультация.

export default {
  ru: {
    'dslabel.device': 'Мои данные (с устройства)',
    'dslabel.file': 'Файл: {name}',
    'dslabel.changed': 'изменён',
  },
  en: {
    'dslabel.device': 'My data (from this device)',
    'dslabel.file': 'File: {name}',
    'dslabel.changed': 'changed',
  },
};
