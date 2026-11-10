---
title: "Таблицы: Excel, Google Sheets, Tiller, шаблоны cash flow"
type: tool
status: verified
summary: "Excel/Sheets как базовый уровень, откуда уходят: шаблоны 13-week и личных прогнозов, Tiller, формулы повторов; точки отказа и путь миграции таблиц в Runway."
sources: [https://tiller.com/pricing/, https://community.tiller.com/t/update-to-tillers-annual-price-starting-in-august-2026/34853, https://workspace.google.com/marketplace/app/tiller_money_feeds/417666986289, https://help.tiller.com/en/articles/432681-transactions-sheet-columns, https://help.tiller.com/en/articles/3250724-what-is-the-tiller-foundation-template, https://help.tiller.com/en/articles/6025610-using-the-tiller-foundation-template-for-microsoft-excel, https://help.tiller.com/en/articles/432693-tiller-supported-financial-institutions-and-accounts, https://tiller.com/blog-2018-3-31-visualize-your-daily-projected-balances-in-a-google-sheet/, https://community.tiller.com/t/expense-forecasting-and-seeing-upcoming-expenses-on-a-calendar-updated-4-15-24/25118, https://www.numeric.io/template/13-week-cash-flow-template, https://support.microsoft.com/en-us/office/introduction-to-what-if-analysis-22bffa5f-e891-4acc-bf7a-e4645c446fb4, https://support.google.com/docs/answer/3093281, https://support.google.com/drive/answer/37603, https://spreadsheetpoint.com/?p=25094, https://arxiv.org/abs/0802.3457, https://support.microsoft.com/en-us/Excel/get-a-currency-exchange-rate, https://support.microsoft.com/en-US/Excel/end-of-support-for-money-in-excel-wolfram-data-types-and-partner-offers, https://tiller.com/bank-connections-plaid-yodlee-data-cleanup/, https://tiller.com/faqs/, https://tiller.com/cash-flow-planning-spreadsheets, https://support.google.com/docs/answer/49114, https://workspace.google.com/products/sheets/, https://support.google.com/docs/answer/14356410, https://workspaceupdates.googleblog.com/2026/04/build-and-edit-complex-spreadsheets-with-Gemini-in-Google-Sheets.html, https://tiller.com/community-solutions/cash-flow-forecast-spreadsheet/, https://help.tiller.com/en/articles/1589064-what-happens-after-i-cancel-my-tiller-subscription]
updated: 2026-10-05
---

# Таблицы: Excel, Google Sheets, Tiller, шаблоны cash flow

## Кратко

Таблицы — «нулевой уровень» кэшфлоу-планирования: баланс по периодам = предыдущий + приходы − расходы, всё руками. Это то, с чего уходят пользователи [Budget Guru](budget-guru.md) и Runway (сравнение с лендинга: «только руками, формулами», [источник](../sources/02-budgetguru-landing.md)).

| Вариант | Модель | Цена на 2026-10-04 |
|---|---|---|
| Google Sheets | Облачная таблица, офлайн-режим, мобильные приложения | Бесплатно для личного использования ([workspace.google.com](https://workspace.google.com/products/sheets/)) |
| Excel | Файл или OneDrive; часть Microsoft 365 | Цена подписки не подтверждена первичным источником |
| Tiller | Банковские фиды (Yodlee + Plaid) в Sheets/Excel, шаблоны, AutoCat; банки только США ([FAQ](https://tiller.com/faqs/)) | $99/год, триал 30 дней ([tiller.com/pricing](https://tiller.com/pricing/)); было $79, повышение с 2026-08-01 для продлений с августа ([пост 2026-06-17](https://community.tiller.com/t/update-to-tillers-annual-price-starting-in-august-2026/34853)); месячного тарифа нет (по FAQ только годовой), прежнее «$12.95/мес» не подтверждено и снято |
| Шаблоны 13-week, bills, freelancer | Готовые книги, часто бесплатные или на Gumroad | Разная; Numeric 13-week — бесплатно |

## Три вопроса

| Вопрос | Поддержка | Как именно |
|---|---|---|
| Q1 Хватит ли к дате? | Частично | Ручная проекция «старт + доходы − обязательные − переменные = конец» ([Tiller](https://tiller.com/cash-flow-planning-spreadsheets)). Шаблон Tiller 2018: до года, шаг день/неделя/месяц, но стартовый остаток вводится вручную |
| Q2 Волна платежей | Частично | 13-week: недельные столбцы, строка минимального остатка подсвечивает недели-провалы ([Numeric](https://www.numeric.io/template/13-week-cash-flow-template)). «Сколько нужно к волне» не считается (вывод) |
| Q3 Могу ли купить? | Обходной путь | Штатного what-if «покупка на дату» нет. Excel: Scenarios (до 32 значений), Data Tables (≤ 2 переменных), Goal Seek (1) ([Microsoft](https://support.microsoft.com/en-us/office/introduction-to-what-if-analysis-22bffa5f-e891-4acc-bf7a-e4645c446fb4)). Практика (вывод): вставить строку и смотреть MIN остатков |
| Редкие траты | Частично | Шаблоны sinking funds: цель, ежемесячный взнос, дата готовности; «годовой платёж / 12» руками |
| Налоги | Частично | Шаблон фрилансера: ставки вводятся вручную, квартальная оценка по Income Log ([SpreadsheetPoint](https://spreadsheetpoint.com/?p=25094)); расчёт по введённым ставкам, не консультация |

## Возможности по осям

| Ось | Уровень | Примечание |
|---|---|---|
| forecast_by_date | partial | Строится вручную; ломается без обновления |
| can_i_afford | partial | Только руками через сценарии/вставку строки |
| recurring_and_waves | partial | EDATE/LAMBDA-конструкции; недельные «волны» в 13-week |
| sinking_funds | partial | Шаблоны, не автоматизм |
| tax_envelope | partial | Ручные ставки, квартальный расчёт |
| multi_currency | partial | GOOGLEFINANCE/Currencies; курса операции нет |
| hourly_income | partial | В проверенном шаблоне ставок/часов нет |
| privacy_local_first | partial | Локальный .xlsx — да; Sheets — облако; Tiller — агрегаторы |
| import_export | full | CSV/XLSX/ODS, Sheets API, Tiller CSV importer |
| ai_assistant | partial | Gemini в Sheets только на платных планах (Workspace или Google AI Pro/Ultra), для бесплатного личного аккаунта недоступен; Copilot в Excel (Microsoft 365; по вторичным источникам, не подтверждено первоисточником). Не опирается на движок прогноза (вывод) |
| openness | partial | Формулы открыты, сами продукты закрыты |

## Как это устроено

1. **Tiller Transactions** — плоский журнал: Date, Description, Amount (приход +, расход −), Account, Account #, Institution, Transaction ID; опционально Month, Week, Tags, Source, Import Tag ([колонки](https://help.tiller.com/en/articles/432681-transactions-sheet-columns)). Доп. колонки надо добавить до первой заливки.
2. **Foundation**: Spending Trends, Transactions, Categories, AutoCat, Monthly/Yearly Budget, Accounts, Balances, скрытый Balance History ([справка](https://help.tiller.com/en/articles/3250724-what-is-the-tiller-foundation-template)). Прогноза в них нет.
3. **Excel-версия**: фид по кнопке Fill, не по расписанию ([справка](https://help.tiller.com/en/articles/6025610-using-the-tiller-foundation-template-for-microsoft-excel)).
4. **13-week**: три вкладки (инструкция, прогноз, Variance), блоки receipts / operating / non-operating, остаток = прошлый + нетто, строка минимума.
5. **Повторы**: community-шаблон для Excel — Expense Setup → Expense Transactions → Override → Calendar, на динамических массивах ([тред](https://community.tiller.com/t/expense-forecasting-and-seeing-upcoming-expenses-on-a-calendar-updated-4-15-24/25118)).
6. **Курсы**: GOOGLEFINANCE("CURRENCY:USDEUR") с задержкой до 20 минут, не все пары ([Google](https://support.google.com/docs/answer/3093281)); Excel Currencies — только Microsoft 365 ([Microsoft](https://support.microsoft.com/en-us/Excel/get-a-currency-exchange-rate)).

## Сильные стороны

- Нулевой порог входа, полный контроль, гибкость; бесплатно.
- Прозрачность: видно каждую формулу (вывод — для автора модели).
- Tiller: данные живут в таблице пользователя, не продаются (заявление компании); после отмены таблицы в Google Drive остаются, а данные на стороне Tiller удаляются через 90 дней ([справка](https://help.tiller.com/en/articles/1589064-what-happens-after-i-cancel-my-tiller-subscription)).
- Community-шаблон [Cash Flow Forecast](https://tiller.com/community-solutions/cash-flow-forecast-spreadsheet/) (Sheets, есть версия для Excel): «события жизни» включаются и выключаются как сценарии на горизонте лет; нужен Tiller (триал или подписка). Ближайший аналог what-if, но не «покупка на дату» (вывод).

## Слабые стороны и ограничения

| Проблема | Факт |
|---|---|
| Хрупкость формул | Panko: ошибки в таблицах «распространены и нетривиальны» ([arXiv](https://arxiv.org/abs/0802.3457)); цифра «~94% проверенных рабочих таблиц с ошибками» часто цитируется, но на странице arXiv не найдена (не подтверждено). В community-шаблоне Tiller пользователи ловили #VALUE! на LAMBDA |
| Нет what-if на траектории | См. Q3 |
| Прогноз не видит переменные траты | Шаблон Tiller 2018 не учитывает бюджет и переменные расходы (продукты, кафе) |
| Курсы | Текущий курс, а не курс операции (вывод) |
| Агрегаторы (Tiller) | По FAQ только банки США; нет банков ЕС/UK из-за Open Banking, поддержка Канады снята в 2024-03 ([справка](https://help.tiller.com/en/articles/432693-tiller-supported-financial-institutions-and-accounts)) |
| Закрытие сервисов | Microsoft закрыла «Money in Excel» 2023-06-30 ([Microsoft](https://support.microsoft.com/en-US/Excel/end-of-support-for-money-in-excel-wolfram-data-types-and-partner-offers)) |
| Масштаб | Sheets: до 20 млн ячеек или 100 МБ ([Google](https://support.google.com/drive/answer/37603)) |

## Данные и приватность

- **Где данные:** Excel — локальный файл или OneDrive; Sheets — облако Google; Tiller добавляет Plaid/Yodlee и по FAQ не продаёт данные.
- **Экспорт:** XLSX, CSV, ODS ([Google](https://support.google.com/docs/answer/49114)); Sheets API — REST, A1-нотация.
- **Self-host:** отсутствует; локальный .xlsx — аналог (вывод).

## Что взять в Runway

| Идея | Как реализовать |
|---|---|
| Строка минимального остатка | Порог `min_balance_minor` на счёт; алерт, когда проекция ниже порога |
| Variance-вкладка | Backtest: прогноз против факта по периодам, метрика точности |
| Override-таблица | Исключения отдельных вхождений правила повтора (EXDATE-подобно) |
| Теги-матчинг | Автосопоставление планового платежа и фактической транзакции по правилу |
| Включаемые события (Cash Flow Forecast от Tiller community) | Сценарии как набор переключаемых событий без лимита в 32 значения |
| Balance History | Снимки остатков как точки сверки |
| Provenance-колонки (Source, Import Tag) | Источник каждой записи: ручной/импорт/правило |

### Миграция из таблиц (Budget Guru этого не умеет)

| Структура в таблице | Сущность Runway | Правило импорта |
|---|---|---|
| Журнал (Date, Description, Amount, Account, Transaction ID) | Транзакции | Идемпотентность по Transaction ID, иначе hash(дата, сумма, описание, порядок); знак определять по колонке/столбцам Debit-Credit |
| Balance History / Balances | Точки сверки | Начальные остатки, по ним — расхождения |
| Список bills (имя, сумма, день, частота) | Правила повторов | Предупреждать о «31-м числе»; частоту маппить в RRULE-подобный формат |
| Сетка 13-week (статьи × недели) | Плановые операции | Un-pivot; дата = неделя, флаг `date_precision: week` |
| Сетка категория × месяц | Плановые лимиты | Только как план, не как факт |
| Лист sinking funds (цель, дата, накоплено) | Цели-резервы | Пересчёт взноса из даты и остатка |
| Income Log (invoiced / received, статус) | Ожидаемые поступления | Разность дат как задержка оплаты |

Общие принципы (вывод):

- импортировать значения, не формулы;
- сухой прогон с отчётом «распознано / пропущено»;
- десятичная запятая и форматы дат по локали;
- суммы — в minor units + ISO 4217.

## Чего избегать

- Правила повторов как формулы EDATE/LAMBDA — только данные с тестами.
- Обязательный ручной Fill и привязка к одному агрегатору.
- Курс «на сегодня» без фиксации на дату операции.
- Смешение данных и логики в ячейках; прогноз без переменных расходов.

## Источники

- https://tiller.com/pricing/ — $99/год, триал 30 дней — 2026-10-04
- https://community.tiller.com/t/update-to-tillers-annual-price-starting-in-august-2026/34853 — повышение с $79 до $99 с 2026-08-01 — 2026-10-04
- https://workspace.google.com/marketplace/app/tiller_money_feeds/417666986289 — $99/год, обновлено 2026-09-21 — 2026-10-04
- https://help.tiller.com/en/articles/432681-transactions-sheet-columns — колонки Transactions — 2026-10-04
- https://help.tiller.com/en/articles/3250724-what-is-the-tiller-foundation-template — листы Foundation — 2026-10-04
- https://help.tiller.com/en/articles/6025610-using-the-tiller-foundation-template-for-microsoft-excel — Excel: кнопка Fill — 2026-10-04
- https://help.tiller.com/en/articles/432693-tiller-supported-financial-institutions-and-accounts — география, CSV importer — 2026-10-04
- https://tiller.com/blog-2018-3-31-visualize-your-daily-projected-balances-in-a-google-sheet/ — шаблон дневных остатков — 2026-10-04
- https://community.tiller.com/t/expense-forecasting-and-seeing-upcoming-expenses-on-a-calendar-updated-4-15-24/25118 — community-прогноз расходов — 2026-10-04
- https://www.numeric.io/template/13-week-cash-flow-template — структура 13-week — 2026-10-04
- https://support.microsoft.com/en-us/office/introduction-to-what-if-analysis-22bffa5f-e891-4acc-bf7a-e4645c446fb4 — what-if в Excel — 2026-10-04
- https://support.google.com/docs/answer/3093281 — GOOGLEFINANCE, валюты — 2026-10-04
- https://support.microsoft.com/en-us/Excel/get-a-currency-exchange-rate — Excel Currencies — 2026-10-04
- https://support.google.com/drive/answer/37603 — лимиты Sheets — 2026-10-04
- https://spreadsheetpoint.com/?p=25094 — шаблон фрилансера: ставки руками, без валют и часов — 2026-10-04
- https://tiller.com/bank-connections-plaid-yodlee-data-cleanup/ — Plaid + Yodlee, Data Cleanup только для Sheets (пост 2026-05-21) — 2026-10-04
- https://tiller.com/faqs/ — только годовой тариф, только банки США, нет смартфон-приложения, данные не продаются (заявление) — 2026-10-04
- https://help.tiller.com/en/articles/1589064-what-happens-after-i-cancel-my-tiller-subscription — после отмены таблицы остаются, данные Tiller удаляются через 90 дней (по выдаче поиска) — 2026-10-04
- https://tiller.com/community-solutions/cash-flow-forecast-spreadsheet/ — community Cash Flow Forecast со сценариями-событиями — 2026-10-04
- https://support.google.com/docs/answer/14356410 — Gemini в Sheets требует платный план Workspace или Google AI — 2026-10-04
- https://workspaceupdates.googleblog.com/2026/04/build-and-edit-complex-spreadsheets-with-Gemini-in-Google-Sheets.html — Gemini в Sheets: Workspace, add-on, Google AI Pro/Ultra (апрель 2026) — 2026-10-04
- https://tiller.com/cash-flow-planning-spreadsheets — базовая модель ручного прогноза — 2026-10-04
- https://support.microsoft.com/en-US/Excel/end-of-support-for-money-in-excel-wolfram-data-types-and-partner-offers — закрытие Money in Excel 2023-06-30 — 2026-10-04
- https://support.google.com/docs/answer/49114 — форматы экспорта Sheets (страница перечня форматов не даёт; XLSX/CSV/PDF/ODS/TSV/HTML — по вторичным источникам) — 2026-10-04
- https://workspace.google.com/products/sheets/ — Sheets бесплатно для личного аккаунта, офлайн, мобильные приложения — 2026-10-04
- https://arxiv.org/abs/0802.3457 — Panko об ошибках в таблицах — 2026-10-04

Проверка: скептическая перепроверка 2026-10-04 (24 утверждения проверено); подтверждено 20, расхождения исправлены на странице и в scorecard, неподтверждённое помечено «(не подтверждено)».

## Связанные страницы

- [Прогноз денежного потока](../concepts/cash-flow-forecast.md)
- [Волна платежей](../concepts/payment-waves.md)
- [Правила повторов](../concepts/recurrence-rules.md)
- [Sinking funds](../concepts/sinking-funds.md)
- [Мультивалютность](../concepts/multi-currency-fx.md)
- [Budget Guru](budget-guru.md)
- [Современные SaaS-трекеры](modern-saas-trackers.md)
