// i18n/calc.mjs — строки пакета FP-21 (карточка «Расчёт в фоне» на экране «Настройки»); ключи `calc.<имя>`. Строка «Считаем…» на скелете — `app.calc` в i18n.mjs.
// Формат каталога пакета: `export default { ru: {…}, en: {…} }`, паритет ключей и плейсхолдеров проверяет `register_strings` (TST-56).
// Формулировки без повелительного наклонения (REQ-046) и без обещаний из списка запретов (REQ-114).
// Расчёт по введённым данным и правилам, не консультация.

export default {
  ru: {
    'calc.title': 'Расчёт в фоне',
    'calc.lead': 'В отдельном потоке браузера (Web Worker) считаются загрузка и смена набора данных (для экранов «Обзор» и «Волны»), импорт файла и ответы экрана «Купить», чтобы страница не замирала на больших наборах. Восстановление данных из хранилища при запуске, правки через формы, сценарии и «Отменить» считаются на основном потоке. Числа те же, что при расчёте на месте. Если фоновый поток не работает, страница считает сама.',
    'calc.flag': 'Считать в фоне (Web Worker)',
    'calc.flag_hint': 'Настройка этого устройства: в данные, журнал и файл-копию она не входит. Без отметки всё считается на основном потоке.',
    'calc.state_on': 'Сейчас: расчёт в фоне. В этом сеансе в фоне посчитано {worker}, на основном потоке — {main}.',
    'calc.state_main': 'Сейчас: расчёт на основном потоке ({reason}).',
    'calc.reason_off': 'отметка снята',
    'calc.reason_no_worker': 'в этом браузере нет Web Worker',
    'calc.reason_start_failed': 'фоновый поток не запустился',
    'calc.reason_worker_error': 'фоновый поток остановился с ошибкой',
    'calc.reason_timeout': 'фоновый поток не ответил вовремя',
    'calc.reason_version': 'версия движка в фоне другая',
    'calc.reason_other': 'фоновый поток остановлен',
    'calc.restart': 'После сбоя фонового потока расчёт в фоне запустится снова, если отметку снять и поставить заново.',
    'calc.writes_note': 'Запись через формы проверяется и считается на основном потоке всегда: так отказ пересчёта ничего не меняет в данных.',
  },
  en: {
    'calc.title': 'Background calculation',
    'calc.lead': 'A separate browser thread (a Web Worker) calculates loading and switching a data set (for the Overview and Waves screens), importing a file and the answers of the purchase check, so that the page does not freeze on large data sets. Restoring data from storage at start-up, edits through the forms, scenarios and Undo are calculated on the main thread. The numbers are the same as with calculation in place. If the background thread does not work, the page calculates itself.',
    'calc.flag': 'Background calculation (Web Worker)',
    'calc.flag_hint': 'A setting of this device: it is not part of the data, the journal or the file copy. With the box cleared, everything is calculated on the main thread.',
    'calc.state_on': 'Now: background calculation. In this session {worker} calculated in the background and {main} on the main thread.',
    'calc.state_main': 'Now: calculation on the main thread ({reason}).',
    'calc.reason_off': 'the box is cleared',
    'calc.reason_no_worker': 'this browser has no Web Worker',
    'calc.reason_start_failed': 'the background thread did not start',
    'calc.reason_worker_error': 'the background thread stopped with an error',
    'calc.reason_timeout': 'the background thread did not answer in time',
    'calc.reason_version': 'the engine version in the background differs',
    'calc.reason_other': 'the background thread is stopped',
    'calc.restart': 'After a background failure, calculation in the background starts again once the box is cleared and checked again.',
    'calc.writes_note': 'A write through the forms is always checked and calculated on the main thread, so a refused recalculation changes nothing in the data.',
  },
};
