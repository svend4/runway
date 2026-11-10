// i18n/errrep.mjs — строки блока «Сообщить об ошибке» (FP-22, REQ-124); ключи `errrep.<имя>`.
// Формат каталога пакета: `export default { ru: {…}, en: {…} }`, паритет ключей и плейсхолдеров проверяет `register_strings` (TST-56).
// Формулировки без повелительного наклонения (кроме допустимых «проверьте / введите / сверьте») и без обещаний из списка запретов (REQ-114): ни про сохранность, ни про исключительный доступ.
// Расчёт по введённым данным и правилам, не консультация.

export default {
  ru: {
    'errrep.title': 'Сообщить об ошибке',
    'errrep.lead': 'Отчёт состоит только из полей белого списка: идентификатор записи, порядковый номер, время в мс, код ошибки и версия движка. Сумм, названий, заметок и дат в нём нет, строки длиннее 32 знаков срезаются.',
    'errrep.last': 'Последняя ошибка в журнале приложения: код {code}.',
    'errrep.none': 'Ошибок в журнале приложения нет: в отчёт войдёт только версия движка.',
    'errrep.global_note': 'Необработанные ошибки страницы тоже попадают в журнал приложения, но только как код и порядковый номер: без текста сообщения, стека и имён файлов.',
    'errrep.consent': 'Показать текст отчёта и разрешить копирование в буфер обмена',
    'errrep.consent_needed': 'Без согласия текст отчёта не составляется и не показывается.',
    'errrep.text_label': 'Полный текст отчёта — ровно то, что попадёт в буфер обмена:',
    'errrep.copy': 'Копировать в буфер',
    'errrep.copied': 'Текст отчёта скопирован в буфер обмена. Приложение его никуда не отправляло.',
    'errrep.copy_failed': 'Буфер обмена недоступен: текст выше можно выделить и скопировать вручную.',
    'errrep.no_send': 'Приложение ничего не отправляет: отчёт копируется в буфер обмена, а передавать его или нет, решаете вы.',
  },
  en: {
    'errrep.title': 'Report an error',
    'errrep.lead': 'The report has only whitelisted fields: an entry identifier, a sequence number, time in ms, an error code and the engine version. It has no amounts, names, notes or dates; strings longer than 32 characters are cut.',
    'errrep.last': 'Latest error in the app log: code {code}.',
    'errrep.none': 'The app log has no errors: the report will carry only the engine version.',
    'errrep.global_note': 'Unhandled page errors also go to the app log, but only as a code and a sequence number: no message text, stack or file names.',
    'errrep.consent': 'Show the report text and allow copying it to the clipboard',
    'errrep.consent_needed': 'Without consent the report text is neither built nor shown.',
    'errrep.text_label': 'Full report text — exactly what goes to the clipboard:',
    'errrep.copy': 'Copy to clipboard',
    'errrep.copied': 'The report text is copied to the clipboard. The app has not sent it anywhere.',
    'errrep.copy_failed': 'The clipboard is unavailable: the text above can be selected and copied by hand.',
    'errrep.no_send': 'The app sends nothing: the report is copied to the clipboard, and whether to pass it on is up to you.',
  },
};
