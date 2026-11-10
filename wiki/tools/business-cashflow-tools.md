---
title: "Бизнес-инструменты cash flow: Float, Pulse, Xero, QuickBooks"
type: tool
status: reviewed
summary: "Бизнес-планировщики кассы (Float, Pulse, Xero, QuickBooks, FreeAgent, Fathom): сценарии, runway, 13-недельная модель, что перенести на личный уровень."
sources: [https://www.floatapp.com/pricing, https://www.floatapp.com/features, https://floatapp.com/product, https://floatapp.com/xero-cash-flow-forecast, https://floatapp.com/ai-info-page, https://intercom.help/floatapp/en/articles/8588038-forecast-confidence, https://apps.xero.com/au/app/float-cashflow-forecasting, https://www.freeagent.com/blog/cashflow-integrations/, https://www.freeagent.com/features/cashflow/, https://www.pulseapp.com/pricing, https://www.pulseapp.com/, https://www.pulseapp.com/features, https://www.capterra.com/p/226486/Float-Cash-Flow/, https://www.capterra.com/p/192868/Pulse/pricing/, https://www.xero.com/accounting-software/analytics/cash-flow/, https://cfotech.co.uk/story/xero-cash-flow-manager-projects-short-term-cash-moves, https://cashflowfrog.com/blog/xero-cash-flow-forecasting-tool-uses-and-limitations, https://quickbooks.intuit.com/global/cash-flow/, https://www.fathomhq.com/pricing, https://www.fathomhq.com/blog/the-best-cash-flow-forecasting-software, https://hidata.ai/resources/13-week-cash-flow-forecast, https://agicap.com/en/features/cashflow-forecast/, https://www.runfutureproof.com/blog/cash-flow-forecasting-software, https://blog.finexer.com/?p=25735, https://metricgate.com/calculator/fan-chart-uncertainty, https://www.freeagent.com/en/integrations/float/, https://intercom.help/floatapp/en/articles/1934041-what-are-budgets, https://www.accountingtoday.com/news/xeros-jax-ai-gains-agentic-capacities]
updated: 2026-10-05
---

# Бизнес-инструменты cash flow: Float, Pulse, Xero, QuickBooks

## Кратко

Группа B2B-планировщиков кассы для малого бизнеса и бухгалтеров. Это ближайшие по идее «прогноз остатка по датам» продукты, но заточены под учётную систему (Xero, QuickBooks Online, FreeAgent), а не под личные деньги. Полезны как источник UX- и модельных паттернов для Runway (личный уровень, аналог [Budget Guru](budget-guru.md)).

Внимание: **Float cash flow (floatapp.com)** не путать с float.com (планирование ресурсов, $7–12 за человека).

| Продукт | Модель | Цена на 2026-10-04 |
|---|---|---|
| Float (floatapp.com) | SaaS поверх Xero/QBO/FreeAgent | Essentials £99/мес (£79 при годовой оплате), Growth £199/£159, Scale £295/£235; триал 14 дней без карты, без VAT; 8 сценариев на всех планах; горизонт 12 мес. (Essentials) и 36 мес. (Growth, Scale) ([pricing](https://www.floatapp.com/pricing)) |
| Pulse (pulseapp.com, Simple Focus) | Веб-SaaS, QuickBooks Online + ручной ввод | Basics $29 (дневной вид, повторы, сценарии, multi-currency), Small Business $59 (+ синхронизация QuickBooks Online, план/факт, доступ для команды), Premium $89 (+ конвертация валют для отчётности) в мес, триал 30 дней ([pricing](https://www.pulseapp.com/pricing)) |
| Xero Cash flow, QuickBooks Cash Flow Planner, FreeAgent Cashflow | Функция внутри бухгалтерской платформы | Отдельной цены нет; стоимость самих платформ (не подтверждено) |
| Fathom | SaaS для бухгалтеров, 3-way forecast | Pro $450/мес (25 компаний, +$17 за компанию), Portfolio $67/мес (100 компаний), Enterprise по запросу; триал 14 дней ([pricing](https://www.fathomhq.com/pricing)) |

Оговорки к таблице:

- **Float:** на pricing-странице интеграции — Xero и QBO; FreeAgent подтверждён [страницей FreeAgent](https://www.freeagent.com/en/integrations/float/). Capterra показывает другие USD-тарифы — расхождение, вероятно устаревшие данные.
- **Pulse:** в подвале сайта ©2019 — признак слабой активности (вывод).
- **Fathom:** цифры нетипичны для SMB, перечитать при использовании.

## Три вопроса

| Вопрос | Поддержка | Как именно |
|---|---|---|
| Q1 Хватит ли к дате? | Да | Float: дневной/недельный/месячный вид до 12 мес. (Essentials) или 36 мес. (Growth, Scale); Xero: 7/30/60/90/180 дней (180 — по независимому обзору только с Analytics (Syft); по тарифам не подтверждено); QuickBooks: 30/90 дней; FreeAgent: 90 дней |
| Q2 Волна платежей | Частично | 13-недельная сетка и «самая низкая точка окна» (Float); у Xero метрика cash buffer. Расчёта «сколько нужно к волне» нет (вывод) |
| Q3 Могу ли купить? | Частично | Разовое событие или сценарий поверх базы (QuickBooks, Xero, FreeAgent, Float). Вердикта «да/нет» по узкой точке нет — читать min вручную (вывод) |
| Редкие траты | Не найдено | Платёж падает на свою дату; амортизации/резервов не обнаружено |
| Налоги | Частично | FreeAgent включает налоговые обязательства в проекцию; отложения при поступлении нет. Расчёт по введённым правилам, не консультация |

## Возможности по осям

| Ось | Уровень | Примечание |
|---|---|---|
| forecast_by_date | full | Дневная проекция; Fathom — только месяц/квартал/год |
| can_i_afford | partial | События и сценарии, без вердикта |
| recurring_and_waves | partial | Автопоиск повторов, правила, неделя как единица |
| sinking_funds | unknown | Не найдено |
| tax_envelope | partial | Налоги как плановые оттоки |
| multi_currency | partial | Pulse (Basics — multi-currency, Premium — конвертация для отчётности), Fathom; у Float официально не подтверждено, пользователи жалуются на отсутствие; у QuickBooks planner не работает с multi-currency |
| hourly_income | partial | Счета с ожидаемой датой оплаты; ставок/часов нет |
| privacy_local_first | none | Облако, данные из учётной системы |
| import_export | partial | Живая синхронизация, экспорт CSV/PDF |
| ai_assistant | partial | В самих планировщиках — подсказки (Float, Xero ML), не диалог; на уровне платформ есть диалоговые агенты (Xero JAX, Intuit Assist), отвечающие в т.ч. про cash flow |
| openness | none | Закрытые SaaS |

## Как это устроено

1. **Источник данных.** Float читает Xero/QBO/FreeAgent только на чтение раз в 24 часа (ручной запуск тоже есть): балансы, счета, счета-фактуры, повторяющиеся документы ([Float + Xero](https://floatapp.com/xero-cash-flow-forecast)).
2. **Прямой метод.** Остаток + ожидаемые поступления − платежи по датам. Открытые счета получают ожидаемую дату: вручную или Smart Expected Dates по реальному поведению клиента.
3. **План против факта.** Float берёт по каждой строке большее из бюджета и фактической суммы ([справка](https://intercom.help/floatapp/en/articles/1934041-what-are-budgets)); автобюджеты считаются по средним, плюс правила повтора и разовые записи.
4. **Сценарии как слой.** Float: до 8 сценариев, сравнение рядом, слияние в базу после решения. Pulse: переключатели строк. Xero/QuickBooks: ручные события, не попадающие в книги.
5. **Метрики риска.** Самый низкий остаток окна и причины (Float); runway и buffer в днях (Xero); дни до нуля (FreeAgent).
6. **Forecast Confidence (Float).** Оценка сравнивает 3 месяца оплаченного факта с 6 месяцами прогноза; просрочки и неполные бюджеты её снижают ([справка](https://intercom.help/floatapp/en/articles/8588038-forecast-confidence)). Границы полос не опубликованы.
7. **13-недельная модель.** Сетка: открытие → приходы → расходы → закрытие, строка минимального порога и «избыток/дефицит»; каждую неделю факт заменяет прогноз, горизонт сдвигается ([hidata](https://hidata.ai/resources/13-week-cash-flow-forecast)).

## Сильные стороны

- Чёткие метрики риска: низшая точка, runway, buffer.
- Сценарии не трогают учёт; Float сравнивает и сливает их.
- Недельная дисциплина «факт заменяет прогноз» обучает модель ошибкам.
- Float: оценка 4.83 из 5 по 345 отзывам на Xero (2026-10-04); на Capterra 4.8 по 67 отзывам и устаревшие USD-тарифы.

## Слабые стороны и ограничения

| Ограничение | Источник |
|---|---|
| Прогноз унаследует задержки закрытия ledger | [Futureproof, 2026-04-27](https://www.runfutureproof.com/blog/cash-flow-forecasting-software) |
| QuickBooks planner не учитывает кредитные карты, вручную введённые транзакции и multi-currency | [Intuit](https://quickbooks.intuit.com/global/cash-flow/) |
| Xero: сценарии сводятся к ручным разовым суммам (страница Xero) либо отсутствуют как переключаемые (обзор Cash Flow Frog, 2026-08-31); источники расходятся | [Cash Flow Frog](https://cashflowfrog.com/blog/xero-cash-flow-forecasting-tool-uses-and-limitations), [Xero](https://www.xero.com/accounting-software/analytics/cash-flow/) |
| Дорого для частного лица: от £79/мес у Float | [Float](https://www.floatapp.com/pricing) |
| Нет интервалов неопределённости, только скаляр-оценка (вывод) | — |

## Данные и приватность

Всё облачное.

- **Float:** односторонний доступ через официальный API, отключение в любой момент, экспорт CSV/PDF, роли Admin/Editor/Viewer, 2FA. Прямой банковской интеграции нет, данные идут через учётную систему. Хостинг и сертификации не подтверждены; публичный API не найден.
- **Pulse:** экспорт в CSV и read-only доступ для инвесторов.
- **Общее:** self-host, E2E и локальные данные не заявлены.

## Что взять в Runway

| Идея | Как реализовать |
|---|---|
| Сценарий как слой-diff | Именованный набор событий поверх базы; сравнение рядом; merge в базу ([сценарии](../concepts/uncertainty-and-scenarios.md)) |
| Низшая точка как главная метрика | `min(balance[t])` и её дата, маркер на графике, порог минимального остатка (буфер) |
| Runway + buffer | Два числа в днях: с ожидаемыми приходами и без них |
| Ожидаемая дата поступления | Дата оплаты по истории задержек каждого плательщика; задержка — параметр неопределённости |
| Индекс доверия | Хранить снимки прогнозов, считать ошибку по факту за N недель; показывать формулу открыто |
| Недельный режим | Группировка в недели с closing/min для [волн платежей](../concepts/payment-waves.md); воскресный ритуал «факт вместо прогноза» |
| События вне книг | What-if не создаёт транзакций ([можно ли купить](../concepts/can-i-afford-it.md)) |
| Автопоиск повторов | Предлагать правила по истории, подтверждает пользователь |

## Чего избегать

- Зависимости от ledger и задержки синхронизации: ввод у Runway должен быть мгновенным.
- Непрозрачного балла доверия без формулы.
- Единственной линии без диапазона (fan-chart по [сниппету поиска](https://metricgate.com/calculator/fan-chart-uncertainty), страница не открывалась).
- Месячной гранулярности (Fathom): для Q1–Q2 нужен день.
- Смешения выручки и денег: частая ошибка 13-недельных моделей.

## Источники

- https://www.floatapp.com/pricing — тарифы, 8 сценариев, 36 мес., триал — 2026-10-04
- https://www.floatapp.com/features, https://floatapp.com/product — виды, низшая точка, экспорт, роли — 2026-10-04
- https://floatapp.com/xero-cash-flow-forecast — состав импорта, синхронизация, ожидаемые даты — 2026-10-04
- https://floatapp.com/ai-info-page — Smart Cost Prediction, интеграции — 2026-10-04
- https://intercom.help/floatapp/en/articles/8588038-forecast-confidence — механика оценки — 2026-10-04
- https://apps.xero.com/au/app/float-cashflow-forecasting — рейтинг, read-only — 2026-10-04
- https://www.pulseapp.com/pricing, https://www.pulseapp.com/, https://www.pulseapp.com/features — тарифы, функции — 2026-10-04
- https://www.capterra.com/p/226486/Float-Cash-Flow/, https://www.capterra.com/p/192868/Pulse/pricing/ — отзывы, расхождение цен — 2026-10-04
- https://www.xero.com/accounting-software/analytics/cash-flow/, https://cfotech.co.uk/story/xero-cash-flow-manager-projects-short-term-cash-moves — горизонт, runway/buffer (2026-05-27) — 2026-10-04
- https://quickbooks.intuit.com/global/cash-flow/ — 30/90 дней, ограничения — 2026-10-04
- https://www.freeagent.com/features/cashflow/, https://www.freeagent.com/blog/cashflow-integrations/ — 90 дней, ручные сценарии — 2026-10-04
- https://www.fathomhq.com/pricing, https://www.fathomhq.com/blog/the-best-cash-flow-forecasting-software — горизонты, сценарии — 2026-10-04
- https://hidata.ai/resources/13-week-cash-flow-forecast, https://agicap.com/en/features/cashflow-forecast/ — 13-недельная модель, оповещения — 2026-10-04
- https://www.runfutureproof.com/blog/cash-flow-forecasting-software, https://cashflowfrog.com/blog/xero-cash-flow-forecasting-tool-uses-and-limitations, https://blog.finexer.com/?p=25735 — независимые оценки — 2026-10-04

Проверка: скептическая перепроверка 2026-10-04 (22 утверждения проверено); подтверждено 17, расхождения исправлены на странице и в scorecard, неподтверждённое помечено «(не подтверждено)».

## Связанные страницы

- [Прогноз денежного потока](../concepts/cash-flow-forecast.md)
- [Неопределённость и сценарии](../concepts/uncertainty-and-scenarios.md)
- [Волны платежей](../concepts/payment-waves.md)
- [Могу ли я это купить?](../concepts/can-i-afford-it.md)
- [Budget Guru](budget-guru.md)
- [Матрица возможностей](../comparisons/feature-matrix.md)
