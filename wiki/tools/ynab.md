---
title: "YNAB и семейство конвертов"
type: tool
status: verified
summary: "YNAB (zero-based, Targets, Scheduled transactions) и родственные Goodbudget, Buckets, EveryDollar: как закрывают прогноз, редкие траты, мультивалюту; что взять в Runway."
sources: [https://www.ynab.com/pricing, https://support.ynab.com/en_us/how-to-use-targets-rk5kkI9ks.md, https://support.ynab.com/en_us/scheduled-transactions-a-guide-BygrAIFA9.md, https://support.ynab.com/en_us/using-multiple-currencies-in-ynab-a-guide-SyBF6PHno.md, https://support.ynab.com/en_us/direct-import-in-europe-Syae1z_A9.md, https://api.ynab.com/papi/open_api_spec.yaml, https://www.ynab.com/security, https://www.ynab.com/whats-new, https://envelopebudgeting.com/articles/ynab-review, https://www.goodbudget.com/signup, https://www.budgetwithbuckets.com/, https://www.ramseysolutions.com/ramseyplus/everydollar]
updated: 2026-10-05
---

# YNAB и семейство конвертов

## Кратко

YNAB (You Need A Budget) — закрытый облачный SaaS (веб + мобильные приложения) по методу zero-based/envelope: каждая имеющаяся денежная единица получает категорию-«конверт». Для тех, кто готов ежемесячно вести бюджет вручную.

- **Цена** ([pricing](https://www.ynab.com/pricing), 2026-10-04): $109/год ($9.08/мес) или $14.99/мес без налогов; бесплатного тарифа нет; одна подписка делится на 6 человек.
- **Триал:** 34 дня без карты при покупке напрямую (через сторонние магазины приложений карта может понадобиться); студентам — 365 дней по подтверждению обучения.
- **Статус:** продукт активен, последняя запись release notes — 2026-09-25 ([what's new](https://www.ynab.com/whats-new)).
- **Терминология:** «budget» в продукте и API теперь называется «plan».

### Семейство конвертов

| Продукт | Цена на 2026-10-04 | Редкие траты / прогноз | Заметка |
|---|---|---|---|
| [Goodbudget](https://www.goodbudget.com/signup) | Free: 10+10 конвертов, 1 счёт, 2 устройства, 1 год истории; Premium $10/мес или $80/год (безлимит конвертов и счетов, 5 устройств, 7 лет истории) | Отдельного расчёта редких трат и прогноза не найдено (не подтверждено) | Авто-синк банков только US, только Premium |
| [Buckets](https://www.budgetwithbuckets.com/) | Разово $64, без подписки, лицензия на домохозяйство | Прогноз не описан (не подтверждено) | Данные на компьютере; SimpleFIN, CSV, макросы. Последний релиз v0.80.0 — 2025-05-15 (GitHub API). Репозиторий публичный, лицензия не объявлена (license = null), сайт open source не заявляет — считать source-available/проприетарным (не подтверждено) |
| [EveryDollar](https://www.ramseysolutions.com/ramseyplus/everydollar) | Free (ручной ввод); Premium $79.99/год или $17.99/мес | Sinking funds в обоих тарифах (по вторичным источникам); Premium: Paycheck Planning (с 2022-10) — календарь доходов/расходов с красными зонами нехватки, в пределах одного месяца | Банковский синк — только Premium; CSV-экспорт только Premium (не подтверждено) |

## Три вопроса

| Вопрос | Поддержка | Как именно |
|---|---|---|
| Q1 Хватит ли к дате? | Нет (YNAB); частично (EveryDollar Premium) | YNAB не назначает будущий доход — «только то, что на руках»; календаря и обзора будущих месяцев нет. EveryDollar — хронология внутри месяца |
| Q2 Волна платежей | Частично | Scheduled transactions (12 частот): до даты не влияют на план; в деталях категории видны только в текущем месяце; суммарной «нужно к дате» нет |
| Q3 Могу ли купить? | Нет | Ответ — Available в категории «сейчас»; what-if на траектории нет. Loan Planner — what-if только для долгов |
| Редкие траты | Да (ядро метода) | Targets: weekly/monthly/yearly/custom, недофинансирование подсвечивается жёлтым |
| Налоги | Нет (вывод) | Правил нет; пользователь вручную заводит категорию «Налоги». Не консультация — расчёт всегда по введённым правилам |

## Возможности по осям

| Ось | Уровень | Примечание |
|---|---|---|
| forecast_by_date | partial | Только EveryDollar Premium, внутри месяца; YNAB — нет |
| can_i_afford | none | What-if покупки в изученных материалах (2026-10-04) не найдено ни у одного продукта группы |
| recurring_and_waves | partial | Повторы есть; волн и календаря нет |
| sinking_funds | full | Targets — главная сильная сторона YNAB |
| tax_envelope | partial | Только ручной конверт (вывод) |
| multi_currency | partial | Отдельный plan на валюту |
| hourly_income | partial | Методика для нерегулярного дохода, без ставок и инвойсов |
| privacy_local_first | partial | Локально только Buckets (заявление сайта); остальные — облако |
| import_export | full | Direct Import, CSV-конвертер, экспорт, API |
| ai_assistant | none | Официального нет; есть сторонние MCP-обёртки |
| openness | partial | Публичный API (OpenAPI); ядро закрыто (вывод) |

## Как это устроено

1. Модель: plan → счета → категории → транзакции; суммы в milliunits (1000 = единица валюты); один plan — одна валюта.
2. Поток: деньги попадают в Ready to Assign → пользователь раздаёт их по категориям → расходы списываются из Available.
3. Targets считают «сколько ещё назначить»; режимы: «Set aside another», «Refill up to», «Have a balance of». В API: `goal_type` TB/TBD/MF/NEED.
4. Запланированные операции: серые в регистре → в дату жирные → ждут подтверждения (approve).
5. Ввод — три способа:
   - Direct Import: США/Канада и 17 европейских стран по справке, включая UK и Испанию (поисковая выдача добавляет Швецию — 18-я страна не подтверждена; см. «Данные и приватность»);
   - файловый импорт с CSV-конвертером (с 2026-09-14);
   - ручной ввод.
6. Кредитки: категория «Credit Card Payment» откладывает деньги под платёж; с 2026-08-13 платежи сопоставляются автоматически.
7. Age of Money — средний возраст тратящихся денег; метрика буфера.

## Сильные стороны

- Targets для редких трат — самая зрелая реализация в группе.
- Дисциплина «план = реальные деньги»: нет иллюзий о будущих поступлениях.
- Частые релизы, документированный API.

## Слабые стороны и ограничения

- Нет прогноза остатка по датам; scheduled видны только в текущем месяце.
- Нет what-if; нет нативной мультивалютности.
- Крутая кривая: 2–4 недели привыкания, нет free-тарифа ([обзор](https://envelopebudgeting.com/articles/ynab-review)).
- Банковские подключения бывают хрупкими (вывод); факт: 2026-07-16 в release notes добавлен in-app запрос на сброс подключения при сбое.

## Данные и приватность

- Облако; шифрование в передаче и в хранилище, E2E не заявлено; хостинг Heroku/AWS ([security](https://www.ynab.com/security), дата страницы не указана). Self-host нет.
- Банковские логины уходят агрегатору (Plaid/MX), YNAB их не хранит; ручной режим работает без агрегаторов.
- Экспорт: два CSV (plan и register; TSV для валют с десятичной запятой), только из веба.
- API (v1.87.0): токен или OAuth, 200 запросов/час, delta-запросы, CRUD scheduled, bulk-создание транзакций, `import_id` для дедупликации.
- **Противоречие по географии Direct Import.**
  - Freenance утверждает, что Европа ограничена UK/US.
  - Официальная справка перечисляет 17 стран: Австрия, Бельгия, Дания, Эстония, Финляндия, Франция, Германия, Ирландия, Италия, Латвия, Литва, Нидерланды, Норвегия, Польша, Португалия, Испания, UK; страница pricing тоже говорит о банках UK и EU.
  - Принят официальный источник; расхождение по Швеции не разрешено.

## Что взять в Runway

- **Target «к дате» → ежемесячная сумма**: `ceil((цель − баланс) / месяцев_до_даты)` в minor units; статус «недофинансировано», если баланс ниже графика.
- **Две семантики пополнения** («Set aside another» vs «Refill up to») — поле `refill_mode` у резерва.
- **Жизненный цикл плана**: planned → due → approved, с сопоставлением с фактом из импорта.
- **Метрика буфера** (аналог Age of Money): «дней жизни на остатке» (вывод).
- **`import_id` вида сумма+дата+порядковый номер** для идемпотентного импорта; delta-синк через `last_knowledge_of_server`.
- **Платёж по кредитке как авто-резерв** для долгов и рассрочек.
- **CSV-конвертер** с профилями колонок и правилами нормализации получателей.

## Чего избегать

- Прогноза только в рамках текущего месяца и «календаря без суммы к волне».
- Мультивалютности через отдельные планы — нужен курс на операцию.
- Запрета учитывать будущий доход: для фрилансера ожидаемое поступление должно быть в прогнозе с пометкой «ожидается» (вывод).
- Облака без E2E и обязательной зависимости от агрегаторов.

## Источники

- https://www.ynab.com/pricing — тарифы, триал, шеринг — 2026-10-04
- https://www.ynab.com/whats-new — релизы июнь–сентябрь 2026 — 2026-10-04
- https://support.ynab.com/en_us/how-to-use-targets-rk5kkI9ks.md — режимы и частоты Targets — 2026-10-04
- https://support.ynab.com/en_us/scheduled-transactions-a-guide-BygrAIFA9.md — частоты, влияние, лимиты — 2026-10-04
- https://support.ynab.com/en_us/assigning-future-income-an-overview-BJsTo0jCq — запрет назначать будущий доход — 2026-10-04
- https://support.ynab.com/en_us/using-multiple-currencies-in-ynab-a-guide-SyBF6PHno.md — plan на валюту — 2026-10-04
- https://support.ynab.com/en_us/direct-import-in-europe-Syae1z_A9.md — страны Direct Import — 2026-10-04
- https://api.ynab.com/papi/open_api_spec.yaml — endpoints, goal-поля, bulk, import_id — 2026-10-04
- https://api.ynab.com/ — токены, OAuth, лимит 200/час — 2026-10-04
- https://support.ynab.com/en_us/how-to-export-plan-data-Sy_CouWA9.md — экспорт в два CSV, только веб (по выдаче поиска) — 2026-10-04
- https://www.ynab.com/security — шифрование, Heroku/AWS — 2026-10-04
- https://envelopebudgeting.com/articles/ynab-review — независимый обзор — 2026-10-04
- https://freenance.io/products/ynab-review-2026-budgeting-app-worth-it-european-investors/ — обзор конкурента, спорная часть про Европу — 2026-10-04
- https://www.goodbudget.com/signup — тарифы Goodbudget — 2026-10-04
- https://www.budgetwithbuckets.com/ — цена, платформы Buckets — 2026-10-04
- https://github.com/buckets/application — репозиторий Buckets — 2026-10-04
- https://api.github.com/repos/buckets/application/releases/latest — v0.80.0, 2025-05-15; license=null — 2026-10-04
- https://www.ynab.com/ynab-loan-planner/ — Loan Planner (what-if только для долгов) — 2026-10-04
- Отсутствие официального AI-ассистента: нет в release notes июнь–сентябрь 2026; сторонние обзоры (usecarly.com, truthifi.com) пишут об отсутствии официального MCP — 2026-10-04
- https://www.ramseysolutions.com/ramseyplus/everydollar — тарифы EveryDollar — 2026-10-04
- https://www.ramseysolutions.com/ramseyplus/everydollar/updates/paycheck-planning — Paycheck Planning — 2026-10-04

Проверка: скептическая перепроверка 2026-10-04 (16 утверждений проверено); подтверждено 13, расхождения исправлены на странице и в scorecard, неподтверждённое помечено «(не подтверждено)».

## Связанные страницы

- [Прогноз денежного потока](../concepts/cash-flow-forecast.md)
- [Sinking funds](../concepts/sinking-funds.md)
- [Мультивалютность и курс](../concepts/multi-currency-fx.md)
- [Матрица возможностей](../comparisons/feature-matrix.md)
- [Budget Guru](budget-guru.md)
