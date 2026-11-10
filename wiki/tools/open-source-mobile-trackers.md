---
title: "Мобильные и open-source трекеры: Cashew, Spendee, Wallet, Money Manager"
type: tool
status: verified
summary: "Cashew, Spendee, Wallet (BudgetBakers), Money Manager (Realbyte) + Bluecoins и MMEX: офлайн, recurring, мультивалюта, прогноз, цены 2026; что взять в Runway."
sources: [https://github.com/jameskokoska/Cashew, https://github.com/jameskokoska/Cashew/releases, https://github.com/jameskokoska/Cashew/issues/725, https://apps.apple.com/app/id6463662930, https://codewithandrea.com/videos/code-review-cashew-app/, https://www.spendee.com/pricing, https://help.spendee.com/article/229-scheduled-transactions, https://help.spendee.com/article/121-import-transactions, https://help.spendee.com/article/140-sync-my-bank-account-with-spendee, https://budgetbakers.com/en/products/wallet/, https://budgetbakers.com/en/products/wallet/integrations/mcp/, https://budgetbakers.com/en/products/wallet/integrations/rest-api/, https://www.finder.com/uk/budgeting/wallet-budgetbakers-review, https://apps.apple.com/app/id560481810, https://realbyteapps.com/, https://www.bluecoinsapp.com/guide/cashflow/, https://moneymanagerex.org/docs/features/scheduled/, https://github.com/moneymanagerex/moneymanagerex, https://api.github.com/repos/jameskokoska/Cashew/releases, https://api.github.com/repos/moneymanagerex/moneymanagerex/releases, https://www.apkmirror.com/apk/dapper-app-developer/cashew-expense-budget-tracker/, https://apps.apple.com/us/app/id1032467659, https://budgetbakers.com/en/products/wallet/features/planned-payments/]
updated: 2026-10-05
---

# Мобильные и open-source трекеры: Cashew, Spendee, Wallet, Money Manager

## Кратко

Четыре массовых мобильных трекера плюс два ближайших к прогнозу (Bluecoins, MMEX). Все — учёт факта и бюджет по периодам; проекция остатка по датам документирована лишь у Bluecoins и MMEX, у Wallet заявлена маркетингом, what-if в изученных материалах (2026-10-04) не найден. Уровни ниже — по лучшему продукту группы; кто именно — в примечании.

| Продукт | Модель | Цена (доступ 2026-10-04) | Статус |
|---|---|---|---|
| Cashew | GPL-3.0, Flutter, Drift/SQLite + Firebase | бесплатно; Pro $1.49/мес, $11.99/год, $19.99 навсегда ([App Store](https://apps.apple.com/app/id6463662930)) | GitHub: последний релиз 5.3.4 (2024-07-01), бета 6.0.8 (2025-06), последний push 2026-03-09; магазины новее (iOS 5.9; Android до 6.7.2 от 2026-10-03 по APKMirror, сторонний источник) |
| Spendee | проприетарный, облако + банки | Basic $0; Plus $1.99/мес или $14.99/год; Premium $5.99/мес или $35.99/год; цены зависят от страны ([pricing](https://www.spendee.com/pricing)) | жив |
| Wallet (BudgetBakers) | проприетарный, облако, банки | Free / Premium (месяц, год, lifetime); на сайте суммы не указаны; App Store US: месяц $5.99, 3-летний $49.99, lifetime $29.99 или $49.99 (агрегаторы расходятся — не подтверждено); Finder UK: £5.49/мес, £48.99 навсегда (не подтверждено) | жив, есть REST API и MCP |
| Money Manager (Realbyte) | проприетарный, офлайн + платная sync | sync $2.49/мес или $19.99/год; версия без рекламы €6.99 (App Store DE) | жив: iOS 2.14.6, обновлено в конце сентября 2026 (App Store); 20M+ загрузок (заявлено разработчиком) |
| Bluecoins | проприетарный, офлайн | бесплатно с рекламой; Premium разово (сумма не подтверждена) | жив |
| MMEX | GPL-2.0, C++17/wxWidgets, SQLite + AES | бесплатно | жив: релиз v1.9.4 от 2026-08-31 (GitHub), 2,3 тыс. звёзд |

## Три вопроса

| Вопрос | Поддержка | Как именно |
|---|---|---|
| Q1 Хватит ли денег к дате | partial | Проекция документирована у MMEX и Bluecoins, у Wallet заявлена вендором; у Cashew, Spendee, Money Manager проекции по дням не найдено (по продуктам — ниже) |
| Q2 Волна платежей | partial | Только списки: Cashew — сворачиваемый список будущих, Wallet — карточка Upcoming Planned payments, MMEX — напоминания за 15 дней. «Сколько нужно к волне» в изученных материалах не найдено (вывод) |
| Q3 Могу ли купить | none | Не найден. Обход — внести будущую операцию и смотреть проекцию там, где она есть (вывод) |
| Редкие траты | partial | Цели (Cashew, Wallet); в Cashew — сводка расписаний в среднем за месяц/год. Автооткладывания под годовой платёж нет |
| Налоги | none | Только пометка операции «для налогов» (Money Manager, по CHOICE); правил и конверта нет |

Q1 по продуктам:

- **MMEX:** cash-flow отчёт по расписаниям (свободные средства с учётом будущих обязательств).
- **Bluecoins:** проекция из напоминаний и операций с будущей датой (итоговый остаток в гайде не описан).
- **Wallet:** заявлено вендором (ожидаемый баланс после плановых платежей, страница Planned Payments); горизонт и детали не описаны.
- **Cashew, Spendee, Money Manager:** проекции по дням не найдено.

Налоговые правила в Runway — конфигурируемые данные пользователя: это расчёт по введённым правилам, не консультация.

## Возможности по осям

| Ось | Уровень | Примечание |
|---|---|---|
| forecast_by_date | partial | MMEX, Bluecoins — отчёты; Wallet — заявлено вендором (маркетинг) |
| can_i_afford | none | не найдено ни в одной документации |
| recurring_and_waves | partial | повторы зрелые у всех, агрегата волн нет |
| sinking_funds | partial | цели без графика откладывания |
| tax_envelope | none | см. выше |
| multi_currency | full | Spendee и Bluecoins — курс на операцию; Wallet — одна валюта на счёт |
| hourly_income | none | инвойсов и ставок нет |
| privacy_local_first | full | Cashew, Bluecoins, MMEX — данные на устройстве; Wallet и Spendee — облако и агрегаторы |
| import_export | full | Wallet: импорт CSV/XLS/OFX, экспорт CSV/XLS/PDF, API; API — только Premium, экспорт тоже (по сниппету справки) |
| ai_assistant | partial | Wallet MCP: чтение по умолчанию, запись включается по типам данных; OAuth 2.0 |
| openness | full | Cashew (GPL-3.0), MMEX (GPL-2.0); остальные закрыты |

## Как это устроено

- **Cashew.** Операции имеют тип: upcoming, subscription, repeating, долг/кредит; бюджеты — лимиты категорий на произвольный период; цели привязывают операции к покупке. Хранение — Drift/SQLite, синхронизация через Firebase и бэкап на Google Drive.
- **Wallet.** Одна валюта на счёт; эквивалент в базовой валюте фиксируется при записи (по пользовательскому обсуждению, не подтверждено). Предсказанные расходы бюджета = потрачено + плановые + среднее прошлых периодов (по сниппету справки). Повторы предлагаются по истории.
- **Spendee.** Кошельки ручные и банковские; повторы и импорт (только веб) — лишь для ручных; курс задаётся на операцию; банк синхронизируется раз в сутки.
- **Money Manager.** Двойная запись, повторяющиеся операции, платная облачная sync, PC-менеджер по Wi-Fi, бэкап по почте/iCloud.
- **Bluecoins.** Отчёт истории «направлен вперёд»: прошлые три месяца → будущие три; вход — напоминания и операции с будущей датой.
- **MMEX.** Расписание: автопроводка в срок или ручное подтверждение с правкой значений.

## Сильные стороны

- Cashew: бесплатное ядро (бюджеты, цели, подписки, бэкап) без агрегаторов.
- Wallet: банки (15 000+ по сайту; в App Store указано 4 000+ — расхождение), API, MCP.
- Bluecoins и MMEX: офлайн-проекция без подписки.

## Слабые стороны и ограничения

- Нет самой узкой точки и сценариев; бюджет — период, а не дата (вывод).
- Cashew: независимый ревью (2025-06) — 103 тыс. строк Dart без значимых тестов, глобальное состояние.
- Cashew: релизы GitHub отстают от магазина (последний релиз 5.3.4 от 2024-07; iOS 5.9, Android до 6.7.2 по APKMirror — вывод).
- Spendee: повторы недоступны банковским кошелькам; валюту кошелька нельзя сменить после первой операции.
- Wallet: цены не опубликованы; курс конвертации между счетами расходился с банковским (обзор 2021 года).
- Money Manager: реклама и аналитические идентификаторы (метки App Store).

## Данные и приватность

| Продукт | Где данные | Экспорт / API |
|---|---|---|
| Cashew | устройство (SQLite); Firebase и Google Drive по желанию; по метке App Store данные не собираются | импорт CSV и Google Sheets; у экспорта CSV есть открытые баги; API не найден |
| Spendee | облако; банк через агрегатор | импорт xls/xlsx/CSV до 10 МБ; API не найден |
| Wallet | облако; агрегаторы Salt Edge, Yodlee названы в правовом центре | REST API (Premium, 300 запр./час), MCP (тариф на странице не указан, лимит общий с API) |
| Money Manager | устройство + бэкап; облако — платная sync | Excel; CHOICE (дата обзора не указана): CSV/PDF, импорт TSV/TXT |
| Bluecoins | устройство; бэкап в Drive/Dropbox/OneDrive пользователя | PDF/Excel/HTML; CSV/QIF импорт |
| MMEX | локальная SQLite с AES | CSV/QIF импорт |

Self-host не найден ни у одного продукта.

## Что взять в Runway

- **Один движок для факта и прогноза** (Bluecoins): проекция — тот же агрегатор над сгенерированными вхождениями расписаний, окно «N назад → N вперёд». Реализация: `aggregate(events, window)`, отдельного кода прогноза нет.
- **Режим расписания `auto | confirm`** (MMEX); горизонт напоминаний — настройка, не константа 15 дней.
- **Повторы к месяцу/году** (Cashew): `amount_minor × частота / 12` как стартовое предложение для sinking fund.
- **Слой неопределённости** (Wallet): прогноз = факт + расписания + среднее по незапланированным категориям, помеченное «оценка» (вывод).
- **Автопоиск повторов** (Wallet): после импорта предлагать правило при стабильном интервале и получателе; подтверждает человек.
- **Курс на операцию** (Spendee, Bluecoins): `fx_rate` и источник хранятся в каждой записи, правятся вручную.
- **Права AI-инструментов** (Wallet MCP): чтение по умолчанию, запись включается отдельно, токены отзываемы, лимит запросов; движок — детерминированный инструмент.
- **Локальные данные и бэкап в хранилище пользователя** (Bluecoins, Cashew), без обязательного агрегатора.

## Чего избегать

- Делить функции по типу счёта (Spendee: повторы только для ручных кошельков) — прогноз должен работать на всех данных.
- Платный экспорт и API (Wallet) — lock-in.
- Валюта на счёт без курса записи: баланс «плавает» с курсами (по заголовку запроса feedback.budgetbakers.com/81, страница не открывалась).
- Финансовый код без тестов и с глобальным состоянием (Cashew).
- Открытый репозиторий при непрозрачных релизах: релизы должны совпадать с магазином.

## Источники

Дата доступа ко всем — 2026-10-04.

- https://github.com/jameskokoska/Cashew — GPL-3.0, стек, типы операций, цели
- https://github.com/jameskokoska/Cashew/releases — релиз 5.3.4+396 от 2024-07-01
- https://github.com/jameskokoska/Cashew/issues/725 — бета 6.0.8, 2025-06-10
- https://apps.apple.com/app/id6463662930 — цены Pro, метка приватности
- https://codewithandrea.com/videos/code-review-cashew-app/ — независимый код-ревью 2025-06-09
- https://www.spendee.com/pricing — тарифы Spendee
- https://help.spendee.com/article/229-scheduled-transactions — повторы только в ручных кошельках
- https://help.spendee.com/article/121-import-transactions — импорт
- https://help.spendee.com/article/140-sync-my-bank-account-with-spendee — sync раз в сутки
- https://help.spendee.com/article/231-how-to-setchange-the-currency-and-exchange-rate — курс на операцию
- https://budgetbakers.com/en/products/wallet/ — функции Wallet (заявления)
- https://budgetbakers.com/en/products/wallet/features/planned-payments/ — автопоиск повторов
- https://support.budgetbakers.com/hc/en-us/articles/7076953735314-Setup-Budgets — предсказанные расходы (только сниппет поиска)
- https://support.budgetbakers.com/hc/en-us/articles/7151606064018-How-to-export-transactions-from-Wallet — экспорт Premium (только сниппет поиска)
- https://budgetbakers.com/en/products/wallet/integrations/mcp/ — MCP, права, лимит
- https://budgetbakers.com/en/products/wallet/integrations/rest-api/ — REST API только Premium
- https://www.finder.com/uk/budgeting/wallet-budgetbakers-review — цены в £
- https://theportablewife.com/living-abroad/best-budgeting-app-for-expats-wallet/ — валюта счёта, обзор 2021
- https://apps.apple.com/app/id560481810 — функции и цены Money Manager
- https://www.choice.com.au/products/money/financial-planning-and-investing/creating-a-budget/realbyte-money-manager — пометка налогов
- https://realbyteapps.com/ — заявления разработчика
- https://www.bluecoinsapp.com/guide/cashflow/ — проекция из напоминаний
- https://moneymanagerex.org/docs/features/scheduled/ — расписания MMEX
- https://github.com/moneymanagerex/moneymanagerex — GPL-2.0, SQLite/AES; релизы (API): v1.9.4 от 2026-08-31
- https://api.github.com/repos/jameskokoska/Cashew/releases — подтверждение: последний релиз 5.3.4+396, 2024-07-01
- https://www.apkmirror.com/apk/dapper-app-developer/cashew-expense-budget-tracker/ — Android-сборки 6.x (сторонний каталог)
- https://apps.apple.com/us/app/id1032467659 — Wallet: цены Premium в App Store US

Проверка: скептическая перепроверка 2026-10-04 (18 утверждений проверено); подтверждено 14, расхождения исправлены на странице и в scorecard, неподтверждённое помечено «(не подтверждено)».

## Связанные страницы

- [Cash-flow прогноз](../concepts/cash-flow-forecast.md)
- [Волны платежей](../concepts/payment-waves.md)
- [Sinking funds](../concepts/sinking-funds.md)
- [Правила повторов](../concepts/recurrence-rules.md)
- [Local-first и приватность](../concepts/local-first-privacy.md)
- [Actual Budget](actual-budget.md)
- [Матрица возможностей](../comparisons/feature-matrix.md)
