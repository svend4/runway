---
title: "Actual Budget"
type: tool
status: verified
summary: "Open-source local-first envelope-бюджет (MIT): расписания, автоматизации для sinking funds, экспериментальный Balance Forecast; нет what-if, налогов, мультивалютности. Что взять в Runway."
sources: [https://actualbudget.org/, https://actualbudget.org/docs/experimental/balance-forecast-report/, https://actualbudget.org/docs/schedules/, https://actualbudget.org/docs/experimental/budget-automation/, https://actualbudget.org/docs/experimental/, https://actualbudget.org/docs/budgeting/multi-currency, https://actualbudget.org/docs/api/, https://actualbudget.org/docs/advanced/bank-sync/, https://actualbudget.org/docs/install/, https://actualbudget.org/docs/reports/, https://actualbudget.org/blog/release-26.10.0, https://github.com/actualbudget/actual]
updated: 2026-10-05
---

# Actual Budget

## Кратко

| Параметр | Значение |
|---|---|
| Что это | local-first envelope-бюджет: файл бюджета хранится на устройстве, фоновая синхронизация через собственный сервер. Веб, десктоп (Windows/Mac/Linux); нативных мобильных приложений в docs нет — мобильный доступ через PWA или браузер ([install](https://actualbudget.org/docs/install/)); приложения в сторах с похожим названием официальными не считать (вывод) |
| Для кого | тех, кто ведёт бюджет сам, привык к конвертам (как в YNAB) и готов к настройке; **не** для «быстрого учёта с телефона» (по [обзору](https://getfinny.app/blog/actual-budget-review-2026)) |
| Распространение | MIT, ~29,3 тыс. звёзд на GitHub ([репозиторий](https://github.com/actualbudget/actual)), волонтёрский проект |
| Цена (2026-10-04) | приложение бесплатно; self-host (Docker, CLI) или managed на PikaPods/Fly.io — по docs это «небольшая плата», часть идёт проекту; суммы не указаны (не подтверждено) |
| Банковская синхронизация | сторонние провайдеры по регионам: Akahu — NZ, Enable Banking — Европа, SimpleFIN — Сев. Америка, Pluggy.ai — Бразилия; SimpleFIN ≈ US$15/год только по независимому обзору (не подтверждено первоисточником) |
| Статус | жив: релиз 26.10.0 от 2026-10-02, до этого 26.9.0 (01.09), 26.8.1 (07.08, хотфикс), 26.8.0 (02.08), 26.7.0 (02.07) — [блог](https://actualbudget.org/blog), [GitHub releases](https://github.com/actualbudget/actual/releases) |
| Команда | волонтёрский проект; основатель в 2025 заявил о временном («short-term») отходе от руководства, команда продолжает ([roadmap 2025](https://actualbudget.org/blog/roadmap-for-2025)) |

## Три вопроса

| Вопрос | Поддержка | Как именно |
|---|---|---|
| Q1 Хватит ли денег к дате | частично | Отчёт Balance Forecast (экспериментальный): стартовый остаток + симуляция вхождений расписаний, баланс по дням или месяцам, фильтры по счетам. Режим Tracking Budget: помесячно, не привязан к счетам, горизонт до 12 месяцев; с 26.7.0 учитывает будущие записи бюджета без расписаний. Docs: отчёт помогает заметить нехватку средств, но «самую низкую точку» не выделяет — искать глазами по графику; «точность = точность ваших расписаний» ([docs](https://actualbudget.org/docs/experimental/balance-forecast-report/)) |
| Q2 Волна платежей | частично | Расписания дают видимость будущих списаний и попадают в прогноз; метрики «сколько нужно к каждой волне» в docs нет (вывод) |
| Q3 Могу ли я это купить | нет | По docs, отчёт не показывает самую низкую точку и what-if сверх правки расписаний. Обход: добавить гипотетическое расписание и смотреть график (вывод, не проверено) |
| Редкие траты | да | Конверты с накоплением остатка + автоматизации Save by Date (взнос к целевому месяцу; docs: фактически sinking fund), Refill to Cap (пополнение до лимита), Cover Schedule; автоматизации экспериментальные |
| Налоги | частично | Нет налоговых правил; есть шаблон «процент от дохода» (`10% of Paycheck`) — ручной аналог налогового конверта |

## Возможности по осям

| Ось | Уровень | Примечание |
|---|---|---|
| forecast_by_date | partial | Balance Forecast, но экспериментальный (отдельный Monte Carlo с 26.9.0 — про пенсионные накопления, не про даты платежей) |
| can_i_afford | none | нет what-if и «самой узкой точки» |
| recurring_and_waves | partial | расписания зрелые, агрегации по волнам нет |
| sinking_funds | full | конверты + шаблоны/автоматизации (экспериментальные) |
| tax_envelope | partial | только процент от дохода, без правил по датам |
| multi_currency | none | «currency agnostic», обход через правила с ручным курсом |
| hourly_income | unknown | в изученных страницах не найдено |
| privacy_local_first | full | локальные данные, опциональный E2E, self-host |
| import_export | full | CSV/OFX/QFX/QIF/CAMT, bank sync, API |
| ai_assistant | partial | встроенного нет; community MCP и LLM-категоризатор |
| openness | full | MIT, API, CLI |

## Как это устроено

1. Бюджет-файл живёт локально; браузерная версия API использует SQLite в WebAssembly и IndexedDB. Сервер синхронизирует устройства; сквозное шифрование включается отдельным паролем.
2. Модель — конверты: сумма раскладывается по категориям, остатки переносятся; есть второй режим Tracking Budget.
3. Schedules ([docs](https://actualbudget.org/docs/schedules/)):
   - частота (в т.ч. «каждые 2 месяца», несколько дат), «Last day»;
   - сдвиг при выходных (праздники не учитываются);
   - автопроводка в день срока либо ручное подтверждение;
   - приблизительная сумма для переменных счетов (совпадение в пределах ±7,5 %);
   - в релизе 26.7.0 добавлено «догоняющее» проведение пропущенных автопроводок.
4. Автоматизации бюджета (бывшие `#template` в заметках категорий) заполняют месяц одним кликом; всё помечено как experimental ([docs](https://actualbudget.org/docs/experimental/budget-automation/)):
   - Fixed Amount, Percentage of Income, Whatever is Left (`remainder`);
   - Save by Date (`by`), Refill to Cap (`up to`), Cover Schedule;
   - From History (копия/среднее).
5. Импорт: CSV с маппингом полей, OFX/QFX (с ID для дедупликации), QIF, CAMT; дедупликация по ID, дате, сумме, плательщику; импортированное приоритетнее ручного ([docs](https://actualbudget.org/docs/transactions/importing/)).
6. Банки: Akahu, Enable Banking, SimpleFIN, Pluggy.ai; GoCardless «не принимает новые аккаунты»; синхронизация запускается вручную ([docs](https://actualbudget.org/docs/advanced/bank-sync/)).
7. Расширения: `@actual-app/api` (Node.js; браузерная сборка с 26.7.0 — в docs помечена experimental, нужна cross-origin isolation), CLI (стабильный с 26.7.0), язык запросов ActualQL.

## Сильные стороны

- Зрелое ядро (envelope + schedules + правила + импорт) и свободная лицензия MIT.
- Расписания выражают реальную жизнь: сдвиг на выходные, переменная сумма; переводы между счетами учитываются в прогнозе (в docs расписаний переводы отдельно не описаны).
- Хорошая основа для sinking funds и «заполнить месяц одним кликом».
- Ежемесячные релизы, OpenID и мультипользовательский режим на сервере ([docs](https://actualbudget.org/docs/config/oauth-auth/)).

## Слабые стороны и ограничения

- Прогноз экспериментальный; нет «самой узкой точки», what-if и свёртки по волнам (по docs).
- Мультивалютности нет: «currency agnostic and does not support multi-currency» ([docs](https://actualbudget.org/docs/budgeting/multi-currency)).
  - Обход: два правила на счёт (rule action templating, experimental), курсы вводятся руками.
  - Дорожная карта сообщества (шаги 3–4: поля валюты, таблица курсов) не завершена.
  - С 26.1.0 показываются символы валюты, в 26.9.0 добавлены ещё четыре валюты — это отображение, не конвертация; нативной поддержки в релизах до 26.10.0 не найдено.
- Нет налоговых правил, ставок, часов, инвойсов (в изученных страницах не найдено).
- Мобильный клиент вторичен; для синхронизации нужен сервер; параллельное редактирование одного файла рискованно.
- API только на Node.js; агрегации в ActualQL в docs не описаны.

## Данные и приватность

| Аспект | Факт |
|---|---|
| Где хранится | локально на устройстве; сервер — по желанию |
| E2E | опционально; потеря пароля без локальной копии = потеря данных |
| Секреты bank sync | хранятся на сервере и **не** покрыты E2E — поэтому рекомендуется self-host |
| Экспорт | локальный файл + API-функции importBudget/exportBudget (26.8.0); отчёт Budget Analysis выгружается в CSV (26.8.0); экспорт транзакций в CSV из docs не подтверждён |
| API/self-host | Docker, CLI, облако PikaPods/Fly.io; HTTP-эндпоинтов нет, доступ через клиентскую библиотеку |
| LLM | сторонние MCP-серверы (например, [agigante80](https://github.com/agigante80/actual-mcp-server), 82 инструмента, MIT; [s-stefanov](https://github.com/s-stefanov/actual-mcp)) — в основном аналитика прошлого, не прогноз |

## Что взять в Runway

| Идея | Как реализовать |
|---|---|
| Прогноз как развёртка расписаний | движок разворачивает правила повторения в вхождения по дням, переводы — две ноги; это ядро [прогноза](../concepts/cash-flow-forecast.md) |
| Допуск суммы ±N % | в правиле повторения поле `tolerance_pct`; сопоставление факта с планом |
| Догоняющее проведение | при открытии после паузы создать все пропущенные вхождения, а не последнее |
| Шаблоны `by` и `up to` | детерминированные функции для [sinking funds](../concepts/sinking-funds.md): взнос = (цель − остаток) / оставшиеся периоды |
| Дедупликация импорта | ключ: ID операции → иначе дата+сумма+контрагент; флаг «не восстанавливать удалённые» |
| Метки экспериментальных функций | флаг и напоминание о бэкапе; предсказуемое созревание функций |
| Метка «AI угадал» в заметке | любые правки от AI помечаются и проверяются человеком |
| Стабильные коды ошибок API | основа для [заземлённого AI-ассистента](../concepts/grounded-ai-assistant.md) |

Недостающее у Actual — то, где Runway должен выиграть: метрика самой узкой точки, свёртка по волнам, what-if, налоговые правила по датам, настоящие курсы операций.

## Чего избегать

- Прятать главную функцию (прогноз) за флагом experimental.
- Мультивалютность через ручные правила и курсы.
- Хранить токены банков вне зоны E2E.
- DSL в свободном тексте заметок — Actual ушёл от него к UI.
- Праздники «не учитываются» — вынести календарь в данные.

## Источники

- https://actualbudget.org/ — лицензия, local-first, форматы импорта, провайдеры (устарело относительно docs) — 2026-10-04
- https://actualbudget.org/docs/experimental/balance-forecast-report/ — режимы прогноза, ограничения — 2026-10-04
- https://actualbudget.org/docs/schedules/ — повторение, сдвиг, ±7,5 % — 2026-10-04
- https://actualbudget.org/docs/experimental/budget-automation/ (ранее goal-templates) — типы автоматизаций, sinking funds — 2026-10-04
- https://actualbudget.org/docs/experimental/ и https://actualbudget.org/docs/reports/ — список experimental-функций и отчётов; про часы/инвойсы/налоги ничего нет — 2026-10-04
- https://actualbudget.org/docs/install/ — десктоп, PWA, нативных мобильных нет, PikaPods/Fly.io — 2026-10-04
- https://actualbudget.org/blog/release-26.9.0 и https://actualbudget.org/blog/release-26.10.0 — Monte Carlo, валюты, схемы, API — 2026-10-04
- https://actualbudget.org/docs/budgeting/multi-currency — отсутствие мультивалютности, обход — 2026-10-04
- https://github.com/tlesicka/actual-budget-multicurrency-todo — статус работ сообщества — 2026-10-04
- https://actualbudget.org/docs/api/ — API Node.js, ограничения — 2026-10-04
- https://actualbudget.org/docs/advanced/bank-sync/ — провайдеры, секреты вне E2E — 2026-10-04
- https://actualbudget.org/docs/getting-started/sync/ — E2E, сервер — 2026-10-04
- https://actualbudget.org/docs/transactions/importing/ — форматы импорта, дедупликация — 2026-10-04
- https://actualbudget.org/docs/config/oauth-auth/ — OpenID и мультипользователь — 2026-10-04
- https://actualbudget.org/blog/release-26.7.0 и https://actualbudget.org/blog/release-26.8.0 — изменения прогноза, API, bank sync — 2026-10-04
- https://actualbudget.org/blog/roadmap-for-2025 — волонтёрский статус — 2026-10-04
- https://github.com/actualbudget/actual — MIT, звёзды — 2026-10-04
- https://github.com/agigante80/actual-mcp-server и https://github.com/s-stefanov/actual-mcp — MCP-интеграции — 2026-10-04
- https://getfinny.app/blog/actual-budget-review-2026 — независимый обзор: стоимость, мобильный клиент — 2026-10-04

Проверка: скептическая перепроверка 2026-10-04 (25 утверждений проверено); подтверждено 19, расхождения исправлены на странице и в scorecard, неподтверждённое помечено «(не подтверждено)».

## Связанные страницы

- [Прогноз денежного потока](../concepts/cash-flow-forecast.md)
- [Sinking funds](../concepts/sinking-funds.md)
- [Правила повторения](../concepts/recurrence-rules.md)
- [Local-first и приватность](../concepts/local-first-privacy.md)
- [Матрица функций](../comparisons/feature-matrix.md)
