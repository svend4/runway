---
title: "PocketSmith"
type: tool
status: verified
summary: "PocketSmith — облачный forecast-first трекер: календарь событий, дневной прогноз до 60 лет, what-if сценарии; нет налогов, ставок и авто-поиска узкой точки (только legacy-алерт минимума)."
sources: [https://my.pocketsmith.com/plans, https://www.pocketsmith.com/features/, https://learn.pocketsmith.com/article/1248-everything-you-need-to-know-about-scenarios-in-pocketsmith, https://pocketsmith.com/plan-ahead/what-if-scenarios, https://learn.pocketsmith.com/article/1246-using-the-calendar-and-forecast-graph, https://learn.pocketsmith.com/article/1247-troubleshooting-the-calendar-and-forecast-graph, https://learn.pocketsmith.com/article/169-forecast-correction-events-on-the-calendar, https://learn.pocketsmith.com/article/55-safe-balance-what-it-does-and-how-it-works, https://learn.pocketsmith.com/article/306-bill-categories, https://learn.pocketsmith.com/article/505-budgets, https://learn.pocketsmith.com/article/1355-tips-and-tricks-for-creating-budgets-in-pocketsmith, https://learn.pocketsmith.com/article/1391-envelope-budgeting-in-pocketsmith, https://www.pocketsmith.com/blog/paying-tax-as-a-freelancer/, https://www.pocketsmith.com/blog/how-i-manage-multiple-sources-of-income-in-pocketsmith/, https://www.pocketsmith.com/blog/using-pocketsmith-to-forecast-your-bills/, https://www.pocketsmith.com/blog/managing-multiple-currencies-in-pocketsmith-with-video/, https://www.pocketsmith.com/news/191-multi-currency-support-for-budgets/, https://pocketsmith.com/security, https://pocketsmith.com/legal/privacy-policy, https://learn.pocketsmith.com/article/158-exporting-your-transactions, https://learn.pocketsmith.com/article/1538-pocketsmith-api-developer-keys, https://developers.pocketsmith.com/docs/pocketsmith-mcp-server, https://www.pocketsmith.com/ai/, https://www.pocketsmith.com/changes, https://learn.pocketsmith.com/article/209-setting-minimum-balance-alerts-for-my-accounts, https://learn.pocketsmith.com/article/1480-widgets-balance-alert-widget, https://learn.pocketsmith.com/article/122-multi-currency-beta-features-in-pocketsmith, https://learn.pocketsmith.com/article/145-different-file-types-that-can-be-imported, https://developers.pocketsmith.com/docs/oauth, https://www.pocketsmith.com/news/139-introducing-safe-balance-see-what-s-safe-to-spend/, https://www.companiesoffice.govt.nz/companies/app/ui/pages/companies/2177684, https://www.phroogal.com/product/pocketsmith-app-budget-personal-finance/, https://personalfinanceapp.net/tools/pocketsmith/]
updated: 2026-10-05
---

# PocketSmith

## Кратко

Закрытый облачный SaaS (веб, iOS, Android) для тех, кто ведёт деньги как календарь будущих платежей.

- **Владелец:** PocketSmith Limited, Новая Зеландия (компания №2177684 в реестре NZ).
- **Идея forecast-first:** баланс по дням строится из «бюджетных событий» на календаре.
- **Статус:** жив, последняя запись changelog — 2026-09-27 ([changes](https://www.pocketsmith.com/changes)).

Тарифы на 2026-10-04, USD ([plans](https://my.pocketsmith.com/plans)):

| Тариф | В месяц | При оплате за год | Прогноз | Фиды / лимиты |
|---|---|---|---|---|
| Free | 0 | — | 6 мес | 2 счёта, 12 бюджетов, 2 дашборда (фиды: см. оговорки) |
| Foundation | $14.95 | $9.99/мес | 10 лет | 6 подключений из 1 страны |
| Flourish | $24.95 | $16.66/мес | 30 лет | 18 подключений, любые страны |
| Fortune | $39.95 | $26.66/мес | 60 лет | без лимита |

Оговорки по тарифам:

- Цены на тарифной странице и у стороннего агрегатора цен совпали (2026-10-04).
- Старые страницы и часть обзоров называют тарифы Premium/Super (10/30 лет) — устаревшая схема (вывод).
- Фиды на Free: официальная таблица тарифов перечисляет автоматические фиды, а справка и часть обзоров называют их только платной опцией — противоречие (не подтверждено).
- Гарантия возврата — 14 дней.

## Три вопроса

| Вопрос | Поддержка | Как именно |
|---|---|---|
| Q1 Хватит ли к дате? | Да (ядро) | Каждое budget event прибавляется к текущему балансу; график: дни на 3 месяца вперёд, дальше недели ([справка](https://learn.pocketsmith.com/article/1246-using-the-calendar-and-forecast-graph)); флаги сверяют прогноз с банком |
| Q2 Волна платежей | Частично | Bill-категории кладут полную сумму на дату, есть напоминания и grace period; кластеров и «сколько нужно к дате» нет — смотреть календарь глазами. Месячный Cashflows объявлен deprecated 2026-09-16 |
| Q3 Могу ли купить? | Частично, вручную | Вторичный сценарий + бюджет покупки (разовый или повторяющийся) + переключатель на календаре; автоматического «минимум после покупки» в справке не найдено (не подтверждено). Из порогов по прогнозу найден только legacy-алерт минимального остатка на дашборде (для начавших до сентября 2021; первый алерт в месяц) |
| Редкие траты | Частично | Rollover-бюджеты (beta) переносят неистраченное; справка прямо пишет, что продукт не рассчитан на конверты/zero-based; обход — отдельный счёт |
| Налоги | Только обходной путь | Нативных правил нет; блог советует вручную переводить % дохода на «налоговый» счёт (пример 17.5%, Новая Зеландия, 2021); метки для вычитаемых расходов; экспорт для бухгалтера |

## Возможности по осям

| Ось | Уровень | Примечание |
|---|---|---|
| forecast_by_date | full | Дневной прогноз до 60 лет, лимит по тарифу |
| can_i_afford | partial | Ручной what-if через сценарий; авто-минимума и даты минимума нет, есть лишь legacy-алерт порога |
| recurring_and_waves | partial | Повторы и исключения есть; агрегации волн нет |
| sinking_funds | partial | Rollover beta, не конверты |
| tax_envelope | partial | Только ручной перевод %, правил нет |
| multi_currency | partial | Валюта счёта + пересчёт в базовую (курс обновляется ежечасно); операция в чужой валюте импортируется как сумма в валюте счёта, без конвертации |
| hourly_income | partial | Приблизительные события вручную; ставок/часов/инвойсов нет |
| privacy_local_first | partial | Облако; агрегатор не обязателен (файлы, calendar-only), self-host нет |
| import_export | full | Импорт OFX/QFX/QIF/CSV, экспорт CSV/XLSX, API |
| ai_assistant | partial | Не встроен; MCP-сервер даёт ИИ готовый прогноз |
| openness | partial | Код закрыт; публичные API и MCP |

## Как это устроено

1. **Счёт ↔ сценарий.** У каждого счёта есть первичный сценарий (прогноз «как есть») и любое число вторичных; вторичные добавляют/вычитают поверх (для роста аренды вносят только разницу) ([сценарии](https://learn.pocketsmith.com/article/1248-everything-you-need-to-know-about-scenarios-in-pocketsmith)).
2. **Budget event** = категория + сумма + дата + повтор (недельный, месячный, квартальный и др.; полный список не подтверждён) + счёт. Исключение «только это событие» правит один экземпляр серии.
3. **Bill и обычные категории.** Bill/scheduled income — вся сумма в дату; обычные категории в отчётах распределяются по периоду, а в прогнозе, по справке, применяются полной суммой.
4. **Старт прогноза** — всегда от фактического баланса. Красные/зелёные флаги — ежедневная разница факта и плана; синий — ручной «reset past forecast»; серый — технический чекпоинт для скорости ([флаги](https://learn.pocketsmith.com/article/169-forecast-correction-events-on-the-calendar)).
5. **Safe Balance** (beta с 2016-03-09, opt-in): факт + неполученный доход − неистраченные расходные бюджеты выбранных повторяющихся категорий; нет на мобильном ([справка](https://learn.pocketsmith.com/article/55-safe-balance-what-it-does-and-how-it-works)).
6. **Сопоставление** транзакции и события по периоду: при сдвиге дат возможен двойной учёт; в июне 2026 добавлена кнопка «Fix this bill» для ранних оплат.
7. **Ввод:** фиды (Yodlee, Plaid, Salt Edge, Akahu, Basiq, Mastercard для Австралии) или файлы; бюджеты живут в валюте счёта и пересчитываются в базовую по текущему курсу ([2019](https://www.pocketsmith.com/news/191-multi-currency-support-for-budgets/)).

## Сильные стороны

- Одна модель «событие на дате» питает и прогноз, и сравнение план/факт; горизонт — десятилетия.
- Дельта-сценарии накладываются на тот же график, переключаются одним кликом.
- Сверка прогноза с банком и «исторический прогноз» показывают, где план промахнулся.
- Зрелая периферия: фиды из шести агрегаторов, API (developer key; OAuth 2 для приложений после регистрации у PocketSmith), официальный MCP-сервер с 2026-04-01.
- Независимые обзоры называют прогноз сильнейшим в категории ([Phroogal](https://www.phroogal.com/product/pocketsmith-app-budget-personal-finance/), [PersonalFinanceApp, 2026-05-01](https://personalfinanceapp.net/tools/pocketsmith/)).

## Слабые стороны и ограничения

- Горизонт и фиды привязаны к тарифу; Free даёт 6 месяцев.
- Нет авто-«самой узкой точки» и суммы «нужно к волне» (не найдено в справке).
- Порог минимального остатка — только legacy-алерт для аккаунтов до сентября 2021; Balance alert widget смотрит на текущий баланс, не на прогноз.
- Точность держится на ручной поддержке событий; расхождение дат даёт двойной учёт.
- Обзоры: крутая кривая обучения, десктопный интерфейс, мобильное приложение легче веба.
- Нет налоговых правил, ставки×часы, инвойсов (Files page июля 2026 — хранилище документов, не расчёт).
- Beta-статус Safe Balance и rollover тянется годами (вывод).

## Данные и приватность

| Что | Факт |
|---|---|
| Хранение | Облако на «собственных физических серверах», шифрование at rest на уровне устройства, поля БД не шифруются; регион не указан ([security](https://pocketsmith.com/security)) |
| Доступ | Фиды read-only, логины банков у агрегатора; 2FA через приложение для всех; сквозного (E2E) шифрования нет |
| Политика | Данные не продаются; после удаления аккаунта — стирание из продакшна, бэкапы год; редакция 2019-02-12 |
| Экспорт | Транзакции в CSV/XLSX; бюджеты и сценарии — через API (UI-экспорт не подтверждён) |
| API / MCP | Developer key (для личных инструментов) или OAuth 2 (регистрация приложения); тарифные ограничения и лимиты не подтверждены. MCP: 66 инструментов (полный доступ) / 40 (чтение), «свой ИИ — своя подписка» |
| Self-host | Нет |

## Что взять в Runway

1. **Первичный + дельта-сценарии.** Хранить what-if как набор событий-дельт поверх базовой линии; Q3 = временный сценарий с автоматическим выводом минимума и даты минимума — то, чего у PocketSmith нет ([can-i-afford-it](../concepts/can-i-afford-it.md), [uncertainty-and-scenarios](../concepts/uncertainty-and-scenarios.md)).
2. **Исключения серии.** Правило повтора + override по `occurrence_id`, чтобы менять одну дату без разрыва серии ([recurrence-rules](../concepts/recurrence-rules.md)).
3. **Окно сопоставления.** Матчить факт с планом в окне ±N дней и закрывать событие, чтобы не было двойного учёта.
4. **Безопасная сумма с датами.** Аналог Safe Balance, но считать от обязательств до следующего дохода, а не по категориям ([safe-to-spend](../concepts/safe-to-spend.md)).
5. **Метрика промаха.** Ежедневная сверка «прогноз vs факт» и сохранённые снапшоты прогноза для обратной связи; снапшоты баланса как ускорение.
6. **Grounded-ИИ.** Читает готовый расчёт движка, по умолчанию read-only, правки с подтверждением ([grounded-ai-assistant](../concepts/grounded-ai-assistant.md)).
7. **Простая модель событий.** Все платежи — точечные на дату; «распределённый» бюджет — отдельный слой.

## Чего избегать

- Применять обычные бюджеты к прогнозу целой суммой и допускать двойной учёт.
- Оставлять поиск узкой точки на глаз или ограничиваться порогом на счёт — это ключевой вопрос, ему нужен вывод числом.
- Привязывать горизонт прогноза к тарифу: прогноз — ядро, а не премиум-опция (вывод).
- Годами держать базовые функции в beta без чёткой семантики.
- Налоги как ручной перевод процента: нужны конфигурируемые правила с оговоркой «не консультация» ([tax-envelope](../concepts/tax-envelope.md)).
- Три разрозненных экрана «cash flow / budget / net worth»: по обзорам, путают новичков.

## Источники

Доступ ко всем — 2026-10-04; страницы читались через пересказ загрузчика.

- https://my.pocketsmith.com/plans — тарифы и лимиты (две загрузки, цифры совпали)
- https://www.pocketsmith.com/features/ — позиционирование, до 60 лет
- https://learn.pocketsmith.com/article/1248-everything-you-need-to-know-about-scenarios-in-pocketsmith — сценарии
- https://pocketsmith.com/plan-ahead/what-if-scenarios — what-if
- https://learn.pocketsmith.com/article/1246-using-the-calendar-and-forecast-graph — график, дни/недели
- https://learn.pocketsmith.com/article/1247-troubleshooting-the-calendar-and-forecast-graph — старт прогноза, двойной учёт
- https://learn.pocketsmith.com/article/169-forecast-correction-events-on-the-calendar — флаги
- https://learn.pocketsmith.com/article/55-safe-balance-what-it-does-and-how-it-works — Safe Balance
- https://learn.pocketsmith.com/article/306-bill-categories — bill-категории
- https://learn.pocketsmith.com/article/505-budgets — бюджеты и прогноз
- https://learn.pocketsmith.com/article/1355-tips-and-tricks-for-creating-budgets-in-pocketsmith — повторы, исключения
- https://learn.pocketsmith.com/article/1391-envelope-budgeting-in-pocketsmith — rollover, конверты
- https://www.pocketsmith.com/blog/paying-tax-as-a-freelancer/ — ручной налоговый резерв (2021-12-28)
- https://www.pocketsmith.com/blog/how-i-manage-multiple-sources-of-income-in-pocketsmith/ — нерегулярный доход
- https://www.pocketsmith.com/blog/using-pocketsmith-to-forecast-your-bills/ — проверка «выше нуля» на глаз
- https://www.pocketsmith.com/blog/managing-multiple-currencies-in-pocketsmith-with-video/ — мультивалюта
- https://www.pocketsmith.com/news/191-multi-currency-support-for-budgets/ — валюта бюджета (2019-02-20)
- https://pocketsmith.com/security — шифрование, агрегаторы, 2FA
- https://pocketsmith.com/legal/privacy-policy — политика (2019-02-12)
- https://learn.pocketsmith.com/article/158-exporting-your-transactions — экспорт
- https://learn.pocketsmith.com/article/1538-pocketsmith-api-developer-keys — developer keys
- https://developers.pocketsmith.com/docs/pocketsmith-mcp-server — MCP 66/40 инструментов
- https://www.pocketsmith.com/ai/ — ИИ читает расчёты продукта
- https://www.pocketsmith.com/changes — changelog (MCP 2026-04-01, Cashflows 2026-09-16, последняя 2026-09-27)
- https://learn.pocketsmith.com/article/209-setting-minimum-balance-alerts-for-my-accounts — legacy-алерт минимального остатка
- https://learn.pocketsmith.com/article/1480-widgets-balance-alert-widget — Balance alert widget (текущий баланс)
- https://learn.pocketsmith.com/article/122-multi-currency-beta-features-in-pocketsmith — операции в чужой валюте не конвертируются
- https://learn.pocketsmith.com/article/145-different-file-types-that-can-be-imported — форматы импорта
- https://developers.pocketsmith.com/docs/oauth — OAuth 2 API
- https://www.pocketsmith.com/news/139-introducing-safe-balance-see-what-s-safe-to-spend/ — Safe Balance beta, 2016-03-09
- https://www.companiesoffice.govt.nz/companies/app/ui/pages/companies/2177684 — PocketSmith Limited, реестр NZ
- https://www.phroogal.com/product/pocketsmith-app-budget-personal-finance/ — обзор; годовые цены совпали
- https://personalfinanceapp.net/tools/pocketsmith/ — обзор 2026-05-01: обучение, мобильная версия (цены расходятся с официальными — не использованы)

Проверка: скептическая перепроверка 2026-10-04 (16 утверждений проверено); подтверждено 13, расхождения исправлены на странице и в scorecard, неподтверждённое помечено «(не подтверждено)».

## Связанные страницы

- [Прогноз денежного потока](../concepts/cash-flow-forecast.md)
- [Волны платежей](../concepts/payment-waves.md)
- [Могу ли я это купить](../concepts/can-i-afford-it.md)
- [Budget Guru](budget-guru.md)
- [Матрица возможностей](../comparisons/feature-matrix.md)
- [Сравнение подходов](../comparisons/approach-comparison.md)
