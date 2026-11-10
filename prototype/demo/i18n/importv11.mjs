// i18n/importv11.mjs — строки пакета FP-29: импорт v1.1 в мастере (часы из CSV, строки в чужой валюте с двумя ногами); ключи `importv11.<имя>`.
// Пространство имён — `importv11` (без подчёркивания: `register_strings` допускает только [a-z][a-z0-9]{1,15}), поэтому файл называется не `import_v11`.
// Динамические группы: `importv11.pf_<профиль>` («-» → «_»), `importv11.rj_<причина>` (V11_REJECT_REASONS), `importv11.u_<единица>` (hours | minutes | hm | major | minor).
// Формат каталога: `export default { ru: {…}, en: {…} }`, паритет ключей и плейсхолдеров проверяет `register_strings` и tests/demo.test.mjs (TST-56).
// Расчёт по введённым данным и правилам, не консультация.

export default {
  ru: {
    // профили в выборе
    'importv11.pf_hours_csv_1': 'Часы: дата и отработанные часы (поток — в колонке или выбранный)',
    'importv11.pf_fx_rows_csv_1': 'Обмен двумя ногами: сумма и валюта второй ноги в колонках Runway',
    'importv11.ps_hours': 'Часы: колонка {col}, {unit}',
    'importv11.ps_stream': 'Поток: колонка {col}',
    'importv11.ps_stream_none': 'Колонки потока нет: строки относятся к выбранному потоку.',
    'importv11.ps_fx_amount': 'Вторая нога, сумма: колонка {col}, {unit}',
    'importv11.ps_fx_cur_fixed': 'Вторая нога, валюта: всегда {cur}',
    'importv11.ps_fx_cur_col': 'Вторая нога, валюта: колонка {col}',
    'importv11.u_hours': 'десятичные часы',
    'importv11.u_minutes': 'целые минуты',
    'importv11.u_hm': 'часы:минуты',
    'importv11.u_major': 'основные единицы (12,50)',
    'importv11.u_minor': 'минимальные единицы (1250)',

    // часы: шаг «колонки»
    'importv11.h_hint': 'Часы одного потока за один период складываются; итог периода заменяет записанное «отработано», а не прибавляется к нему. Повторная загрузка того же файла ничего не меняет.',
    'importv11.h_no_streams': 'В данных нет потоков часов. Поток вводится в разделе «Формы данных» → «Часы»; после этого файл можно проверить.',
    'importv11.f_hours_stream': 'Поток часов (для строк без потока в файле)',
    'importv11.h_stream_none': '— не выбран —',

    // часы: отчёт
    'importv11.h_rounded': 'Дробь часов округлена до минуты в строках: {n}.',
    'importv11.h_replaced': 'Заменит уже записанное «отработано» в периодах: {n}. Прежние значения вернёт «Откатить партию».',
    'importv11.h_unchanged': 'Уже записано (дубликаты): периодов {n}.',
    'importv11.h_before_none': 'не записано',
    'importv11.h_changes_title': 'Что изменится: периодов {n}',
    'importv11.h_th_stream': 'Поток',
    'importv11.h_th_period': 'Начало периода',
    'importv11.h_th_before': 'Было',
    'importv11.h_th_after': 'Станет',

    // часы: запись и откат
    'importv11.h_committed': 'Партия записана: периодов часов {n}.',
    'importv11.h_done_text': 'Записано периодов часов: {n}. Номер партии: {id}.',
    'importv11.h_done_hint': 'Партию можно откатить: прежние значения «отработано» вернутся.',
    'importv11.h_rolled_back': 'Партия {id} откатена: возвращено периодов {n}.',
    'importv11.h_rolled_back_kept': 'Партия {id} откатена: возвращено периодов {n}. Оставлено без изменений (вы правили после импорта): {kept}.',
    'importv11.hb_title': 'Партии часов',
    'importv11.hb_hint': 'Партия — периоды одного импорта часов. Откат возвращает прежние значения; период, исправленный вами потом, остаётся как есть.',
    'importv11.hb_count': 'Периодов',

    // строки обмена: настройка
    'importv11.fx_hint': 'Строка в валюте, отличной от валюты счёта, с суммой второй ноги в валюте счёта записывается обменом между двумя вашими счетами. Курс обмена выводится из двух сумм.',
    'importv11.f_fx_counter': 'Счёт второй ноги (в валюте операции)',
    'importv11.fx_counter_auto': 'Единственный открытый счёт в этой валюте',
    'importv11.f_fx_on': 'Строки в другой валюте — обмен двумя ногами',
    'importv11.f_fx_amount_col': 'Колонка суммы второй ноги (в валюте счёта)',
    'importv11.f_fx_amount_unit': 'Единицы суммы второй ноги',
    'importv11.f_fx_currency_col': 'Колонка валюты второй ноги',

    // строки обмена: отчёт
    'importv11.fx_title': 'Обмены двумя ногами: {n}',
    'importv11.fx_note': 'Курс обмена выведен из двух сумм. Разница с курсом из ваших данных справочная: в «свободно» она не входит.',
    'importv11.fx_th_sold': 'Продано',
    'importv11.fx_th_got': 'Получено',
    'importv11.fx_th_rate': 'Курс обмена',
    'importv11.fx_th_spot': 'Курс из данных',
    'importv11.fx_th_diff': 'Справочная разница',
    'importv11.fx_rate_line': 'курс: 1 {from} = {rate} {to}',
    'importv11.fx_no_spot': 'курса пары в данных нет',
    'importv11.fx_diff_zero': 'совпадает с курсом из данных',
    'importv11.fx_diff_less': 'получено на {amount} меньше, чем по курсу из данных',
    'importv11.fx_diff_more': 'получено на {amount} больше, чем по курсу из данных',
    'importv11.fx_skipped': 'Строки в ещё {n} валютах не разобраны как обмен: за один раз берутся первые валюты по порядку в файле.',

    // причины отклонения строк
    'importv11.rj_bad_hours': 'часы не разобраны (проверьте единицы и десятичный знак)',
    'importv11.rj_empty_hours': 'пустая ячейка часов',
    'importv11.rj_future_period': 'период ещё не начался на дату расчёта',
    'importv11.rj_unknown_stream': 'поток не найден или таких названий несколько; поток выбирается в списке выше',
    'importv11.rj_over_period': 'итог периода больше 31 суток',
    'importv11.rj_fx_no_counter': 'нет суммы или валюты второй ноги',
    'importv11.rj_fx_bad_counter': 'вторая нога не разобрана (сумма или курс не получились)',
    'importv11.rj_fx_not_account_currency': 'вторая нога не в валюте счёта импорта',
    'importv11.rj_fx_sign': 'знаки ног совпадают: у обмена они противоположны',
    'importv11.rj_fx_no_counter_account': 'нет единственного открытого счёта в валюте операции; счёт выбирается в списке выше',
    'importv11.rj_no_rate': 'нет курса валюты операции к валюте решения',
    'importv11.rj_short_row': 'в строке меньше колонок, чем в заголовке',
    'importv11.rj_bad_date': 'дата не разобрана по выбранному формату',
  },
  en: {
    // profiles in the picker
    'importv11.pf_hours_csv_1': 'Hours: date and worked hours (stream — from a column or the chosen one)',
    'importv11.pf_fx_rows_csv_1': 'Exchange with two legs: amount and currency of the second leg in Runway columns',
    'importv11.ps_hours': 'Hours: column {col}, {unit}',
    'importv11.ps_stream': 'Stream: column {col}',
    'importv11.ps_stream_none': 'No stream column: rows belong to the chosen stream.',
    'importv11.ps_fx_amount': 'Second leg, amount: column {col}, {unit}',
    'importv11.ps_fx_cur_fixed': 'Second leg, currency: always {cur}',
    'importv11.ps_fx_cur_col': 'Second leg, currency: column {col}',
    'importv11.u_hours': 'decimal hours',
    'importv11.u_minutes': 'whole minutes',
    'importv11.u_hm': 'hours:minutes',
    'importv11.u_major': 'major units (12.50)',
    'importv11.u_minor': 'minor units (1250)',

    // hours: columns step
    'importv11.h_hint': 'Hours of one stream within one period are added up; the period total replaces the recorded "worked" value instead of being added to it. Loading the same file again changes nothing.',
    'importv11.h_no_streams': 'Your data has no hour streams. A stream is entered under "Data forms" → "Hours"; after that the file can be checked.',
    'importv11.f_hours_stream': 'Hours stream (for rows with no stream in the file)',
    'importv11.h_stream_none': '— not chosen —',

    // hours: report
    'importv11.h_rounded': 'A fraction of an hour was rounded to the minute in rows: {n}.',
    'importv11.h_replaced': 'Will replace the recorded "worked" value in periods: {n}. "Roll back the batch" brings the previous values back.',
    'importv11.h_unchanged': 'Already recorded (duplicates): periods {n}.',
    'importv11.h_before_none': 'not recorded',
    'importv11.h_changes_title': 'What will change: periods {n}',
    'importv11.h_th_stream': 'Stream',
    'importv11.h_th_period': 'Period start',
    'importv11.h_th_before': 'Was',
    'importv11.h_th_after': 'Will be',

    // hours: recording and rolling back
    'importv11.h_committed': 'Batch recorded: hour periods {n}.',
    'importv11.h_done_text': 'Hour periods recorded: {n}. Batch number: {id}.',
    'importv11.h_done_hint': 'The batch can be rolled back: the previous "worked" values return.',
    'importv11.h_rolled_back': 'Batch {id} rolled back: periods restored {n}.',
    'importv11.h_rolled_back_kept': 'Batch {id} rolled back: periods restored {n}. Left as they are (you edited them after the import): {kept}.',
    'importv11.hb_title': 'Hours batches',
    'importv11.hb_hint': 'A batch is the periods of one hours import. Rolling back restores the previous values; a period you edited afterwards stays as it is.',
    'importv11.hb_count': 'Periods',

    // exchange rows: setup
    'importv11.fx_hint': 'A row in a currency other than the account currency, with the second-leg amount in the account currency, is recorded as an exchange between two of your accounts. The exchange rate is derived from the two amounts.',
    'importv11.f_fx_counter': 'Second-leg account (in the operation currency)',
    'importv11.fx_counter_auto': 'The only open account in that currency',
    'importv11.f_fx_on': 'Rows in another currency — exchange with two legs',
    'importv11.f_fx_amount_col': 'Second-leg amount column (in the account currency)',
    'importv11.f_fx_amount_unit': 'Units of the second-leg amount',
    'importv11.f_fx_currency_col': 'Second-leg currency column',

    // exchange rows: report
    'importv11.fx_title': 'Exchanges with two legs: {n}',
    'importv11.fx_note': 'The exchange rate is derived from the two amounts. The difference from the rate in your data is for reference only: it is not part of "free to spend".',
    'importv11.fx_th_sold': 'Sold',
    'importv11.fx_th_got': 'Received',
    'importv11.fx_th_rate': 'Exchange rate',
    'importv11.fx_th_spot': 'Rate in your data',
    'importv11.fx_th_diff': 'Reference difference',
    'importv11.fx_rate_line': 'rate: 1 {from} = {rate} {to}',
    'importv11.fx_no_spot': 'no rate for this pair in your data',
    'importv11.fx_diff_zero': 'matches the rate in your data',
    'importv11.fx_diff_less': 'received {amount} less than at the rate in your data',
    'importv11.fx_diff_more': 'received {amount} more than at the rate in your data',
    'importv11.fx_skipped': 'Rows in {n} more currencies were not read as exchanges: one run takes the first currencies in file order.',

    // row rejection reasons
    'importv11.rj_bad_hours': 'the hours were not understood (check the units and the decimal mark)',
    'importv11.rj_empty_hours': 'empty hours cell',
    'importv11.rj_future_period': 'the period has not started yet on the as-of date',
    'importv11.rj_unknown_stream': 'the stream was not found or several have that name; the stream is picked in the list above',
    'importv11.rj_over_period': 'the period total is longer than 31 days',
    'importv11.rj_fx_no_counter': 'no amount or currency for the second leg',
    'importv11.rj_fx_bad_counter': 'the second leg was not understood (amount or rate could not be built)',
    'importv11.rj_fx_not_account_currency': 'the second leg is not in the import account currency',
    'importv11.rj_fx_sign': 'the legs have the same sign: an exchange has opposite signs',
    'importv11.rj_fx_no_counter_account': 'there is no single open account in the operation currency; the account is picked in the list above',
    'importv11.rj_no_rate': 'there is no rate from the operation currency to the decision currency',
    'importv11.rj_short_row': 'the row has fewer columns than the header',
    'importv11.rj_bad_date': 'the date does not match the chosen format',
  },
};
