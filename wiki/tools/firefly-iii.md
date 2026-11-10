---
title: "Firefly III"
type: tool
status: verified
summary: "Self-hosted open-source (AGPL-3.0, PHP/Laravel) учёт с двойной записью, recurring, правилами и мультивалютностью; прогноз автор исключил. Что взять в Runway."
sources: [https://www.firefly-iii.org/, https://github.com/firefly-iii/firefly-iii, https://raw.githubusercontent.com/firefly-iii/firefly-iii/main/changelog.md, https://docs.firefly-iii.org/explanation/more-information/what-its-not/, https://docs.firefly-iii.org/how-to/firefly-iii/finances/recurring/, https://docs.firefly-iii.org/how-to/firefly-iii/finances/subscriptions/, https://docs.firefly-iii.org/how-to/firefly-iii/features/rules/, https://docs.firefly-iii.org/explanation/financial-concepts/exchange-rates/, https://docs.firefly-iii.org/references/firefly-iii/api/, https://docs.firefly-iii.org/how-to/data-importer/installation/docker/, https://github.com/orgs/firefly-iii/discussions/8811, https://github.com/4242labs/ff3e, https://selfhosting.sh/best/personal-finance/, https://raw.githubusercontent.com/firefly-iii/firefly-iii/main/app/Models/PiggyBank.php, https://raw.githubusercontent.com/firefly-iii/firefly-iii/main/app/Transformers/PiggyBankTransformer.php, https://docs.firefly-iii.org/how-to/firefly-iii/features/multi-user/]
updated: 2026-10-05
---

# Firefly III

## Кратко

| Параметр | Значение |
|---|---|
| Что это | self-hosted менеджер личных финансов на PHP/Laravel: двойная запись, бюджеты, recurring, piggy banks, правила, отчёты, REST API ([сайт](https://www.firefly-iii.org/), [GitHub](https://github.com/firefly-iii/firefly-iii)) |
| Для кого | тех, кто готов администрировать Docker + БД и хочет **учёт прошлого** с автокатегоризацией; идеология: знаешь, куда уходят деньги, — можешь это остановить ([intro](https://docs.firefly-iii.org/explanation/firefly-iii/about/introduction/)) |
| Распространение | AGPL-3.0 (composer.json: AGPL-3.0-or-later; требуется PHP ≥ 8.5 с v6.5.0), ~24,8 тыс. звёзд, ~159 открытых issues, один основной мейнтейнер, финансирование донатами; README: «No AI, no cloud» |
| Цена (2026-10-04) | бесплатно, платных тарифов нет; официального облака нет (README: проект его не предлагает). Managed-хостинг только у третьих лиц, например [DINAO](https://dinao.com/en/conteneur/firefly-iii) от €9,90/мес (1 vCPU, 2 ГБ RAM; старшие планы до €79,90) |
| Статус | жив: v6.7.7 (3–4 окт. 2026, источники расходятся на день), v6.7.6 (28.09), v6.7.3 (18.09); релизы каждые несколько дней, в основном багфиксы ([changelog](https://raw.githubusercontent.com/firefly-iii/firefly-iii/main/changelog.md)) |

## Три вопроса

| Вопрос | Поддержка | Как именно |
|---|---|---|
| Q1 Хватит ли денег к дате | нет | Docs «Missing features»: прогноз и «взгляд в будущее» поддерживаться не будут ([what-its-not](https://docs.firefly-iii.org/explanation/more-information/what-its-not/)). Запросы с 2018 г. ([#1544](https://github.com/firefly-iii/firefly-iii/issues/1544), [#1795](https://github.com/firefly-iii/firefly-iii/issues/1795), [#3361](https://github.com/firefly-iii/firefly-iii/issues/3361)) закрыты без реализации; [Discussion #8811](https://github.com/orgs/firefly-iii/discussions/8811) открыта, ответа мейнтейнера нет. Обходы: сторонний read-only [ff3e](https://github.com/4242labs/ff3e), скрипты через API |
| Q2 Волна платежей | частично | Recurring и subscriptions показывают ожидаемые списания (на странице recurring в исходниках есть список будущих вхождений с пометкой «fired»; subscriptions выводятся на главной), но свёртки «сколько нужно к волне» нет; отдельного календаря в docs не описано (не подтверждено) |
| Q3 Могу ли я это купить | нет | what-if нет; обход (вывод): вручную вносить будущие операции и смотреть график — так делал автор #1544 |
| Редкие траты | частично | piggy banks — метка внутри asset-счёта (с v6.2.17 допускается привязка к нескольким счетам), баланс счёта не меняется; пополнение кнопками +/- или привязкой перевода; в модели и API есть `start_date`, `target_date`, `left_to_save`, `save_per_month` (по исходникам; в docs не описаны). Автоматических регулярных взносов нет |
| Налоги | нет | налоговых правил нет; rules не создают транзакции (для этого — webhooks наружу) |

## Возможности по осям

| Ось | Уровень | Примечание |
|---|---|---|
| forecast_by_date | none | заявлено «не будет»; только внешние обходы |
| can_i_afford | none | what-if нет |
| recurring_and_waves | partial | recurring + subscriptions (min/max), агрегации по волнам нет |
| sinking_funds | partial | piggy banks с target date и расчётом «в месяц», но без автоматических взносов |
| tax_envelope | none | нет |
| multi_currency | full | валюта счёта, foreign amount, курсы, пересчёт в primary |
| hourly_income | none | инвойсы и бизнес-учёт вне целей проекта |
| privacy_local_first | full | self-host, не обращается к внешним серверам без разрешения; E2E не найдено |
| import_export | full | Data Importer, CSV/CAMT, REST API; экспорт CSV обратно не импортируется |
| ai_assistant | none | позиция «No AI»; встроенного нет |
| openness | full | AGPL-3.0, Swagger-API, webhooks, expression engine |

## Как это устроено

1. **Модель.** Двойная запись: счета разных типов (asset, liability и др.), транзакции withdrawal/deposit/transfer; бюджеты, категории, теги ([intro](https://docs.firefly-iii.org/explanation/firefly-iii/about/introduction/)).
2. **Recurring** ([docs](https://docs.firefly-iii.org/how-to/firefly-iii/finances/recurring/)). Шаблон по cron создаёт **реальные** транзакции в срок.
   - Правила: день/неделя/день месяца/n-й день недели/год, «пропускать каждые X», откат на последний день короткого месяца; выходные — пропуск, пятница, понедельник или как есть.
   - Ограничения: нельзя динамическую сумму и split; заранее создать нельзя.
   - Обход: cron с `--date` в будущем; мейнтейнер назвал запрос нишевым ([#8759](https://github.com/orgs/firefly-iii/discussions/8759)).
3. **Subscriptions.** Мин./макс. сумма (среднее идёт в графики), ожидаемая дата, период, skip; после создания предлагается правило привязки факта ([docs](https://docs.firefly-iii.org/how-to/firefly-iii/finances/subscriptions/)).
4. **Rules** ([docs](https://docs.firefly-iii.org/how-to/firefly-iii/features/rules/)).
   - Триггеры + действия, группы, strict/non-strict, три флага «stop processing»; нет сложной булевой логики.
   - Expression engine на Symfony ExpressionLanguage: с 6.1.20, по умолчанию выключен (включается в системных настройках).
   - Применяются к новым транзакциям и вручную к старым.
5. **Бюджеты.** Лимит на период; auto-budget reset/rollover/adjusted создаётся только в первый день периода и требует ежедневного cron; смешанные периоды обрабатываются плохо ([docs](https://docs.firefly-iii.org/how-to/firefly-iii/finances/budgets/)).
6. **Валюты** ([docs](https://docs.firefly-iii.org/explanation/financial-concepts/exchange-rates/)). Валюта у каждого asset-счёта, при расхождении вводятся обе суммы. Курсы — вручную или из Azure-хранилища проекта (только встроенные валюты, без истории). Графики и API отдают `pc_*` — пересчёт в primary.
7. **Отчёты.** Шесть типов (default, audit, expense/revenue, budget, category, tag), диапазон 1 день – 20 лет; будущих дат в docs нет ([docs](https://docs.firefly-iii.org/how-to/firefly-iii/finances/reports/)).
8. **Импорт.** Отдельное приложение Data Importer: CSV, CAMT.05x, GoCardless, Spectre, Enable Banking, SimpleFIN, FinTS, Lunch Flow и др.; доступ через OAuth-клиент или токен ([docs](https://docs.firefly-iii.org/how-to/data-importer/installation/docker/)).

## Сильные стороны

- Зрелое ядро учёта: правила, категории, отчёты, ~120 МБ RAM вместе с MariaDB (по [selfhosting.sh](https://selfhosting.sh/best/personal-finance/)).
- Настоящая мультивалютность и документированный REST API с webhooks.
- Бесплатно, без ограничений функций; данные у владельца.
- Живая экосистема: неофициальный Android-клиент Waterfly III ([F-Droid](https://f-droid.org/packages/com.dreautall.waterflyiii/), 1.2.1 от 2026-08-12, MIT), импортёры, ff3e.
- С v6.7.1 (2026-09-15) обновлён интерфейс (Blade вместо Twig, новые формы транзакций); в релизе заявлены «много юзабилити-проблем нового макета» ([changelog](https://raw.githubusercontent.com/firefly-iii/firefly-iii/main/changelog.md)).

## Слабые стороны и ограничения

- Нет прогноза и what-if — сознательно; рынок это просит годами (4+ запросов 2018–2026).
- Крутая кривая: типы счетов и порядок правил ([обзор beancount.io](https://beancount.io/blog/2026/07/26/firefly-iii-vs-actual-budget-self-hosted-open-source-budgeting-guide), издатель — вендор plain-text-подхода, учитывать предвзятость).
- Нужны Docker, БД и cron; авто-бюджеты хрупки к пропущенному запуску.
- Банковская синхронизация — сторонние агрегаторы; docs предупреждают, что GoCardless уходит от продукта Bank Account Data, нужного импортёру ([docs](https://docs.firefly-iii.org/tutorials/data-importer/gocardless/)). Условия Spectre (не подтверждено).
- Месяц только с 1-го по последнее число, нет 4-недельных периодов; мульти-пользователи изолированы.
- Официального мобильного приложения нет (только responsive web и сторонние клиенты).

## Данные и приватность

| Аспект | Факт |
|---|---|
| Где хранится | ваша БД (MySQL/MariaDB по умолчанию, PostgreSQL); официального облака нет |
| Внешние обращения | по docs — только по явному разрешению: загрузка курсов, проверка обновлений через GitHub, агрегаторы |
| Экспорт | CSV (транзакции, счета, бюджеты, recurring, правила, piggy banks); **импортировать обратно нельзя**, бэкап — только дамп БД ([docs](https://docs.firefly-iii.org/tutorials/firefly-iii/exporting-data/)) |
| API | REST JSON, OAuth2 и personal access tokens, Swagger на api-docs.firefly-iii.org; v6.6.0/6.6.1 (2026-04-19) инвалидировали все OAuth-токены и клиенты |
| Webhooks | события транзакций и бюджетов, подпись HMAC-SHA256 |
| Лицензия | AGPL-3.0: копирование кода в закрытый продукт исключено (вывод) |

## Что взять в Runway

| Идея | Как реализовать |
|---|---|
| Спрос на прогноз доказан | годы запросов + сторонний ff3e; аргумент для [прогноза](../concepts/cash-flow-forecast.md) как ядра |
| Виртуальные вхождения вместо материализации | правило повторения порождает плановые события в памяти, а факт сопоставляется с планом; статусы `expected → matched → overdue` (как в ff3e) |
| Мин./макс. сумма | у плановой операции `amount_min`, `amount_max`, `expected`; прогноз — центр + коридор для [сценариев](../concepts/uncertainty-and-scenarios.md) |
| Опции выходных | `skip / prev_business / next_business / keep` + откат на последний день месяца + календарь праздников в данных ([правила повторения](../concepts/recurrence-rules.md)) |
| Две ноги в валютах | при обмене хранить обе суммы, курс операции выводить; у каждой суммы отдавать нативное и пересчитанное значение (`pc_*`) ([FX](../concepts/multi-currency-fx.md)) |
| Piggy bank как аллокация | метка без движения денег; число «можно потратить» (safe-to-spend) вычитает аллокации ([sinking funds](../concepts/sinking-funds.md)) |
| Правила с dry-run | триггеры/действия + предпросмотр «что изменится» перед применением |
| Webhooks с подписью | формат `t=<ts>,v1=<hmac>` и версионирование схемы |
| Импортёр отдельным процессом | ключи агрегаторов не в ядре ([ручной ввод vs банк](../concepts/manual-vs-bank-sync.md)) |
| Обратимый экспорт | формат, который Runway сам импортирует без потерь |

## Чего избегать

- «Прогноз вне целей» и ставка на «таблицы лучше».
- Обязательный cron и материализация в срок как единственный механизм.
- Recurring без динамических сумм и split; месяц только 1–последнее число.
- Односторонний экспорт без возврата.
- Зависимость от одного агрегатора банков.
- Двойная запись как обязательная пользовательская модель для новичка (вывод).

## Источники

- https://www.firefly-iii.org/ — позиционирование, список функций — 2026-10-04
- https://github.com/firefly-iii/firefly-iii — AGPL-3.0, звёзды, мейнтейнер, «No AI, no cloud» — 2026-10-04
- https://raw.githubusercontent.com/firefly-iii/firefly-iii/main/changelog.md — версии 6.5–6.7, даты (по пересказу) — 2026-10-04
- https://github.com/firefly-iii/firefly-iii/releases — v6.7.7, даты расходятся на день — 2026-10-04
- https://docs.firefly-iii.org/explanation/more-information/what-its-not/ — отказ от прогноза, пределы — 2026-10-04
- https://docs.firefly-iii.org/explanation/firefly-iii/about/introduction/ — философия, список функций — 2026-10-04
- https://docs.firefly-iii.org/how-to/firefly-iii/finances/recurring/ — recurring, выходные, ограничения — 2026-10-04
- https://docs.firefly-iii.org/how-to/firefly-iii/finances/subscriptions/ — min/max, expected date — 2026-10-04
- https://docs.firefly-iii.org/how-to/firefly-iii/finances/budgets/ — auto-budget, cron — 2026-10-04
- https://docs.firefly-iii.org/how-to/firefly-iii/finances/piggy-banks/ и https://docs.firefly-iii.org/explanation/financial-concepts/piggy-banks/ — модель piggy banks — 2026-10-04
- https://docs.firefly-iii.org/how-to/firefly-iii/features/rules/ и https://docs.firefly-iii.org/references/firefly-iii/rule-expressions/ — правила, выражения — 2026-10-04
- https://docs.firefly-iii.org/how-to/firefly-iii/features/currencies/ и https://docs.firefly-iii.org/explanation/financial-concepts/exchange-rates/ — валюты, курсы — 2026-10-04
- https://docs.firefly-iii.org/how-to/firefly-iii/finances/reports/ — отчёты — 2026-10-04
- https://docs.firefly-iii.org/references/firefly-iii/api/ , https://docs.firefly-iii.org/how-to/firefly-iii/features/api/ , https://docs.firefly-iii.org/how-to/firefly-iii/features/webhooks/ — API, авторизация, webhooks — 2026-10-04
- https://docs.firefly-iii.org/tutorials/firefly-iii/exporting-data/ — экспорт, «не бэкап» — 2026-10-04
- https://docs.firefly-iii.org/how-to/firefly-iii/installation/docker/ — Docker, БД — 2026-10-04
- https://docs.firefly-iii.org/how-to/data-importer/installation/docker/ , https://docs.firefly-iii.org/tutorials/data-importer/gocardless/ , https://github.com/firefly-iii/data-importer — Data Importer, провайдеры, GoCardless — 2026-10-04
- https://github.com/orgs/firefly-iii/discussions/8759 , https://github.com/orgs/firefly-iii/discussions/8811 , issues #1544, #1795, #3361 — запросы и обходы прогноза — 2026-10-04
- https://github.com/4242labs/ff3e — сторонний read-only прогноз (11 звёзд) — 2026-10-04
- https://raw.githubusercontent.com/firefly-iii/firefly-iii/main/app/Models/PiggyBank.php и .../app/Transformers/PiggyBankTransformer.php — поля target_date, save_per_month, связь с несколькими счетами — 2026-10-04
- https://docs.firefly-iii.org/how-to/firefly-iii/features/multi-user/ — мультипользовательский режим без общего доступа к данным — 2026-10-04
- https://selfhosting.sh/best/personal-finance/ — независимый обзор, RAM, слабые стороны (обновлён 2026-03-18) — 2026-10-04
- https://beancount.io/blog/2026/07/26/firefly-iii-vs-actual-budget-self-hosted-open-source-budgeting-guide — обзор, кривая обучения (издатель предвзят) — 2026-10-04
- https://dinao.com/en/conteneur/firefly-iii — цена стороннего хостинга — 2026-10-04
- https://f-droid.org/packages/com.dreautall.waterflyiii/ — Waterfly III (только по поисковой выдаче) — 2026-10-04

Проверка: скептическая перепроверка 2026-10-04 (22 утверждения проверено); подтверждено 17, расхождения исправлены на странице и в scorecard, неподтверждённое помечено «(не подтверждено)».

## Связанные страницы

- [Прогноз денежного потока](../concepts/cash-flow-forecast.md)
- [Правила повторения](../concepts/recurrence-rules.md)
- [Sinking funds](../concepts/sinking-funds.md)
- [Мультивалютность и курсы](../concepts/multi-currency-fx.md)
- [Actual Budget](../tools/actual-budget.md)
- [Матрица функций](../comparisons/feature-matrix.md)
