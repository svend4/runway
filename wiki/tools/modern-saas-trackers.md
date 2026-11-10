---
title: "Современные SaaS-трекеры: Monarch, Copilot, Lunch Money, Simplifi"
type: tool
status: verified
summary: "Monarch, Copilot, Lunch Money, Quicken Simplifi (и Rocket Money): агрегаторы, recurring, прогноз, мультивалюта, AI, цены 2026; что у них есть для трёх вопросов Runway и что взять."
sources: [https://www.copilot.money/, https://www.copilot.money/faq, https://help.copilot.money/en/articles/9682232-cash-flow-tab-overview, https://help.copilot.money/en/articles/10768078-how-do-you-get-my-financial-data, https://help.copilot.money/en/articles/10715424-international-currency, https://www.monarch.com/blog/monarch-plus, https://www.monarch.com/blog/forecasting, https://www.monarch.com/blog/september-product-update, https://www.monarch.com/whats-new, https://www.monarch.com/blog/planning-for-the-unexpected-managing-non-monthly-expenses, https://help.monarch.com/hc/en-us/articles/48344411171092-Business-Tracking, https://help.monarch.com/hc/en-us/articles/360048393552-International-Accounts-and-Currency, https://help.monarch.com/hc/en-us/articles/50207234679956-Monarch-MCP-Connector, https://www.revenuememo.com/p/who-owns-monarch-money, https://www.costbench.com/software/personal-finance/monarch-money/, https://lunchmoney.app/pricing, https://lunchmoney.app/blog/an-update-to-our-annual-plan-minimum-effective-march-15-2026, https://lunchmoney.dev/v2/changelog, https://lunchmoney.dev/currencies, https://support.lunchmoney.app/guides/automatic-imports, https://support.lunchmoney.app/faq, https://feedback.lunchmoney.app/institution-status-requests/p/support-mx-in-addition-to-plaid, https://github.com/WesleyCeraso/cashflow-app, https://lunchmoney.app/blog/the-new-era, https://www.quicken.com/features/projected-cashflow/, https://support.simplifi.quicken.com/en/articles/3357429-using-projected-cash-flow, https://support.simplifi.quicken.com/en/articles/3828353-what-currencies-does-quicken-simplifi-support, https://support.simplifi.quicken.com/en/articles/3404263-how-to-export-transactions-from-quicken-simplifi, https://www.quicken.com/blog/what-is-quicken-ai-the-new-ai-chat-in-quicken-simplifi/, https://www.rocketmoney.com/learn/personal-finance/how-much-does-rocket-money-cost, https://fiskl.com/blog/open-finance/jpmorgan-chase-data-fees-plaid/, https://www.retailbankerinternational.com/news/monarch-secures-75m-funding/, https://help.copilot.money/en/articles/5944414-exporting-your-transaction-data]
updated: 2026-10-05
---

# Современные SaaS-трекеры: Monarch, Copilot, Lunch Money, Simplifi

## Кратко

Закрытые облачные трекеры: подключи банк через агрегатор — смотри траты, бюджеты, net worth. Для тех, кому нужны автоимпорт и аналитика, а не ответ «хватит ли к дате». Подписка; free-тарифа нет (кроме Rocket Money). Цены и статус на 2026-10-04:

| Продукт | Цена (источник) | Статус |
|---|---|---|
| Monarch | Core $99.99/год или $14.99/мес*; Plus $199/год, только годовая оплата ([monarch.com](https://www.monarch.com/blog/monarch-plus)); триал 7 дней | Активен; релизы до 2026-10-01 (анонс: $100M ARR, к команде присоединилась команда HMBradley); частная, венчурная (Series B $75M, 2025-05) |
| Copilot | $95/год ($7.92/мес при годовой оплате), триал 1 месяц ([copilot.money](https://www.copilot.money/)); помесячно ~$13* | Активен; iPhone/iPad/Mac/Web (веб с 12.2025), только США |
| Lunch Money | $10/мес*, триал 30 дней; год — «плати сколько хочешь», минимум $60 с 2026-03-15 (было $50), цена текущих подписчиков фиксируется ([блог](https://lunchmoney.app/blog/an-update-to-our-annual-plan-minimum-effective-march-15-2026)) | Активен; API v2.11.1 от 2026-09-28; без инвесторов |
| Simplifi (Quicken) | $3.99/мес при годовой оплате, обычно $6.99 ([quicken.com](https://www.quicken.com/features/projected-cashflow/)) | Активен; Quicken AI (бета) с 2026-08-04 |
| Rocket Money | Free; Premium $7–14/мес; Premium+ $15/мес с AI Rowan (страница от 2026-01-19) | Подробно не изучался |

\* Оговорки к ценам:

- Monarch Core: цифры — только в независимых обзорах, официальная страница цен их не показывает (не подтверждено официально).
- Copilot помесячно ~$13: не подтверждено официально.
- Lunch Money: $10/мес — по сниппету страницы цен (страница отдаёт 403); стандартный ориентир $100 (год) — по стороннему обзору.

## Три вопроса

| Вопрос | Поддержка | Как именно |
|---|---|---|
| Q1 Хватит ли к дате | Частично | Дневной баланс найден у Simplifi (до 12 мес.); у остальных — суммы за период, годовая модель net worth или только факт (по продуктам — ниже) |
| Q2 Волна платежей | Частично | Календарь recurring (Monarch, Lunch Money), точки событий по дням (Simplifi); «сколько нужно к волне» не считается (вывод) |
| Q3 Могу ли купить | Частично | Simplifi заявляет what-if на странице продукта, но сама страница сценарии не описывает (явного what-if нет, 2026-10-04), в справке он тоже не описан. Lunch Money: what-if — только в сторонней open-source программе CashFlow App (MIT) |
| Редкие траты | Да (Monarch) | Non-monthly bucket: сумма + периодичность → ежемесячный взнос + rollover. Simplifi — через Savings Goal |
| Налоги | Частично | Monarch Plus: Business Tax Prep (Schedule C, выбор квартала) — отчёт, а не откладывание с поступления; справка отдаёт 403, детали не подтверждены. Расчёт по введённым данным, не консультация |

Q1 по продуктам:

- **Simplifi:** дневной баланс до 12 мес. из recurring и будущих операций; Planned Spend и цели не входят (так в справке; маркетинговая страница говорит о «planned spending» — противоречие, приоритет у справки).
- **Lunch Money:** Projected Income/Expenses за период и календарь; баланс по дням — только в сторонней программе CashFlow App.
- **Monarch Plus:** годовой прогноз net worth.
- **Copilot:** Cash Flow только до сегодняшнего дня.

## Возможности по осям

| Ось | Уровень | Примечание |
|---|---|---|
| forecast_by_date | partial | Лучший — Simplifi: дни, 12 мес.; только плановые события, без неопределённости |
| can_i_afford | partial | Заявление Simplifi; what-if у Lunch Money — сторонний CashFlow App |
| recurring_and_waves | partial | Recurring зрелые; волн как кластеров нет |
| sinking_funds | full | Monarch Non-monthly; у других rollover/цели |
| tax_envelope | partial | Monarch Plus — отчётность, не конверт |
| multi_currency | full | Lunch Money: 160+ валют, курсы по дням; у Monarch, Copilot, Simplifi конвертации нет (один «$») |
| hourly_income | partial | Lunch Money: плавающие суммы; Monarch Plus: P&L; ставок/часов/инвойсов не найдено |
| privacy_local_first | partial | Облако у всех; ручные счета и CSV — Lunch Money; у Monarch ручной режим не подтверждён первоисточником (2026-10-04) |
| import_export | full | Lunch Money: CSV, API v2, SDK |
| ai_assistant | partial | Monarch, Copilot, Simplifi, Rocket+; опора на расчёт не доказана |
| openness | partial | Код закрыт; у Lunch Money открытые API и сообщество |

## Как это устроено

1. **Агрегатор**: Monarch — Plaid, Finicity, MX (не подтверждено); Copilot — Plaid плюс Mastercard, MX, Akoya; Lunch Money — только Plaid; Simplifi — «партнёры по агрегации», обновление ночью. Запасной путь — ручные счета и CSV (у Monarch ручной режим не подтверждён первоисточником, 2026-10-04).
2. **Recurring**: автодетект из истории; у Lunch Money каденс — число и единица («каждые 4 недели»), start/end, фиксированная или плавающая сумма, пришедшая операция сопоставляется с правилом.
3. **Прогноз**: Simplifi — баланс плюс recurring и будущие операции; Lunch Money — факт плюс оставшиеся recurring; Monarch — годовая модель с life events.
4. **Мультивалюта**: Lunch Money — валюта счёта и операции, home currency, дневные курсы; остальные — без конвертации.
5. **Расширяемость**: Lunch Money API v2 (Bearer-токен, TypeScript SDK) породил сторонние инструменты и MCP-серверы; Monarch — официальный MCP-коннектор (бета, OAuth, чтение/запись).

## Сильные стороны

- Низкий порог входа: счета, категории, recurring подхватываются сами.
- Lunch Money: мультивалюта, открытый API, независимость (bootstrapped); синхронизация в 19 странах (США, Канада, 17 европейских; в справке заголовок говорит «18», в списке 19 — расхождение).
- Simplifi: дневная проекция баланса из коробки (у остальных продуктов группы в изученных материалах 2026-10-04 не найдена).
- Monarch: редкие траты, бизнес-режим Plus, темп релизов.

## Слабые стороны и ограничения

- Copilot: прогноза нет, USD и только США; на вебе часть функций ещё в разработке.
- Monarch: прогноз на десятилетия и только в Plus (Monte Carlo не используется, в планах); валюты не различаются (USD/CAD, без конвертации); recurring анонсирован к переделке (2026-09-29).
- Simplifi: одна валюта (USD или CAD), США и Канада; CSV-экспорт лишь в вебе.
- Lunch Money: один агрегатор Plaid (запрос на [MX](https://feedback.lunchmoney.app/institution-status-requests/p/support-mx-in-addition-to-plaid) открыт с 2024-08), встроенного AI нет.
- Риск агрегаторов: платный доступ к данным банков (JPMorgan и Plaid, 2025; [обзор](https://fiskl.com/blog/open-finance/jpmorgan-chase-data-fees-plaid/)).
- Налогового конверта, почасового дохода и «волн» в изученных материалах (2026-10-04) не найдено ни у одного продукта группы.

## Данные и приватность

| Продукт | Хранение | Экспорт / API |
|---|---|---|
| Monarch | Облако; self-host не найден | CSV экспорт/импорт; официальный публичный API не найден (есть неофициальная python-библиотека); прогноз не экспортируется |
| Copilot | Google Cloud (бэкенд), шифрование; данные не продаются | CSV (Settings → Export); API не найден |
| Lunch Money | Облако; паролей банков не хранит, данные не продаёт | CSV (валюта и Recurring ID), API v2 |
| Simplifi | Серверы Quicken | Только CSV, только веб |

## Что взять в Runway

- **Дневная лента событий** (Simplifi): баланс = старт + события по датам; в отличие от Simplifi включать плановые траты и цели. См. [cash-flow-forecast](../concepts/cash-flow-forecast.md).
- **Recurring как Lunch Money**: каденс (N, единица), start/end, фиксированная/плавающая сумма, авто-сопоставление; `recurring_id` в операции и экспорте. См. [recurrence-rules](../concepts/recurrence-rules.md).
- **Мультивалюта**: валюта на счёте и операции, плюс курс на момент операции (дневных курсов мало). См. [multi-currency-fx](../concepts/multi-currency-fx.md).
- **Резервы на редкие траты**: цель + периодичность + дата → ежемесячный взнос, слоем на графике. См. [sinking-funds](../concepts/sinking-funds.md).
- **API-first**: OpenAPI, токен, SDK, публичный changelog; ключ клиента остаётся в браузере (как CashFlow App). См. [local-first-privacy](../concepts/local-first-privacy.md).
- **AI через MCP**: движок как инструменты, чтение по умолчанию, запись по согласию. См. [grounded-ai-assistant](../concepts/grounded-ai-assistant.md).
- **Сценарии бок о бок** (Monarch, заявлено 2026-07-29 — не подтверждено, в whats-new и блоге не найдено) и **смена источника импорта** с сохранением истории.

## Чего избегать

- «Cash flow» только за прошлое (Copilot) или прогноз лишь на годы (Monarch).
- Молча исключать плановые траты из проекции — оптимистичный результат (вывод).
- «$» для любой валюты без конвертации.
- Агрегатор без ручного пути (у Monarch ручной режим не подтверждён).
- AI на внешнем LLM вместо расчёта движка, с оговоркой «может ошибаться» (Quicken AI).

## Источники

Дата доступа ко всем — 2026-10-04.

- https://www.copilot.money/ — цена $95/год, $7.92/мес, платформы
- https://www.copilot.money/faq — США, AI (бета)
- https://help.copilot.money/en/articles/9682232-cash-flow-tab-overview — Cash Flow
- https://help.copilot.money/en/articles/10768078-how-do-you-get-my-financial-data — агрегаторы
- https://help.copilot.money/en/articles/10715424-international-currency — только USD (сниппет)
- https://www.monarch.com/blog/monarch-plus — Plus $199
- https://www.monarch.com/blog/forecasting — Forecasting
- https://www.monarch.com/blog/september-product-update — анонсы 2026-09-29
- https://www.monarch.com/whats-new — хронология 2026, запись 2026-10-01
- https://www.monarch.com/blog/planning-for-the-unexpected-managing-non-monthly-expenses — Non-monthly
- https://help.monarch.com/hc/en-us/articles/48344411171092-Business-Tracking — Tax Prep (сниппет)
- https://help.monarch.com/hc/en-us/articles/360048393552-International-Accounts-and-Currency — валюты (сниппет)
- https://help.monarch.com/hc/en-us/articles/50207234679956-Monarch-MCP-Connector — MCP (сниппет)
- https://www.revenuememo.com/p/who-owns-monarch-money — цена Core
- https://www.costbench.com/software/personal-finance/monarch-money/ — цены
- https://lunchmoney.app/pricing — $10/мес (сниппет)
- https://lunchmoney.app/blog/an-update-to-our-annual-plan-minimum-effective-march-15-2026 — минимум $60
- https://lunchmoney.dev/v2/changelog — v2.11.1, 2026-09-28
- https://lunchmoney.dev/currencies — 165+ валют, BTC/ETH
- https://support.lunchmoney.app/guides/automatic-imports — Plaid, страны
- https://support.lunchmoney.app/faq — AI нет
- https://feedback.lunchmoney.app/institution-status-requests/p/support-mx-in-addition-to-plaid — запрос MX
- https://github.com/WesleyCeraso/cashflow-app — what-if, MIT
- https://lunchmoney.app/blog/the-new-era — без инвесторов
- https://www.quicken.com/features/projected-cashflow/ — цена, 12 мес.
- https://support.simplifi.quicken.com/en/articles/3357429-using-projected-cash-flow — проекция
- https://support.simplifi.quicken.com/en/articles/3828353-what-currencies-does-quicken-simplifi-support — USD/CAD
- https://support.simplifi.quicken.com/en/articles/3404263-how-to-export-transactions-from-quicken-simplifi — только CSV
- https://www.quicken.com/blog/what-is-quicken-ai-the-new-ai-chat-in-quicken-simplifi/ — Quicken AI
- https://www.rocketmoney.com/learn/personal-finance/how-much-does-rocket-money-cost — тарифы Rocket Money
- https://fiskl.com/blog/open-finance/jpmorgan-chase-data-fees-plaid/ — комиссии банков (июль 2025)
- https://www.retailbankerinternational.com/news/monarch-secures-75m-funding/ — Monarch Series B $75M, 2025-05
- https://help.copilot.money/en/articles/5944414-exporting-your-transaction-data — CSV-экспорт Copilot

Проверка: скептическая перепроверка 2026-10-04 (22 утверждения проверено); подтверждено 19, расхождения исправлены на странице и в scorecard, неподтверждённое помечено «(не подтверждено)».

## Связанные страницы

- [Budget Guru](budget-guru.md)
- [Матрица возможностей](../comparisons/feature-matrix.md)
- [Прогноз денежного потока](../concepts/cash-flow-forecast.md)
- [Ручной ввод и банковская синхронизация](../concepts/manual-vs-bank-sync.md)
- [Мультивалютность и курсы](../concepts/multi-currency-fx.md)
