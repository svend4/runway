---
title: "Plain-text accounting: hledger, Beancount (+Fava), Ledger"
type: tool
status: verified
summary: "Двойная запись в текстовых файлах (hledger, Beancount+Fava, Ledger): бесплатно, мультивалютно, приватно; прогноз и what-if только вручную. Что взять из модели данных в Runway."
sources: [https://hledger.org/, https://hledger.org/hledger.html, https://hledger.org/forecasting.html, https://hledger.org/budgeting.html, https://hledger.org/faq, https://api.github.com/repos/simonmichael/hledger/releases, https://github.com/simonmichael/hledger, https://github.com/ledger/ledger, https://api.github.com/repos/ledger/ledger/releases, https://raw.githubusercontent.com/ledger/ledger/master/NEWS.md, https://raw.githubusercontent.com/ledger/ledger/master/doc/ledger.1, https://ledger-cli.org/doc/ledger3.html, https://pypi.org/project/beancount/, https://github.com/beancount/beancount/tree/master/beancount/plugins, https://beancount.io/docs/Basics/syntax, https://beancount.io/docs/Tips/forecast-plugin, https://pypi.org/project/fava/, https://raw.githubusercontent.com/beancount/fava/main/src/fava/help/budgets.md, https://plaintextaccounting.org/, https://www.bitwave.io/blog/a-primer-on-plain-text-accounting-beancount-vs-hledger, https://decks.mtlynch.io/plaintext-acccounting]
updated: 2026-10-05
---

# Plain-text accounting: hledger, Beancount (+Fava), Ledger

## Кратко

| Параметр | Значение |
|---|---|
| Что это | Семейство бухгалтерских CLI-программ: пользователь пишет операции в текстовый файл (двойная запись), программа проверяет и строит отчёты. «Большая тройка» по [plaintextaccounting.org](https://plaintextaccounting.org/): Ledger (C++), hledger (Haskell), Beancount (Python, веб-интерфейс Fava) |
| Для кого | технарей, готовых вести журнал руками или скриптами; не для массового пользователя (вывод) |
| Распространение | только открытый код: hledger — GPL-3.0+, Ledger — BSD-3-Clause, Beancount — GPL-2.0-only, Fava — MIT |
| Цена (проверено 2026-10-04) | бесплатно; hledger живёт на спонсорстве ([hledger.org](https://hledger.org/)) |
| Статус | hledger: стабильная ветка 1.52.4, превью «2.0» 1.99.5 от 2026-10-02 ([GitHub API](https://api.github.com/repos/simonmichael/hledger/releases)). Beancount 3.2.3 от 2026-05-05 ([PyPI](https://pypi.org/project/beancount/)); Fava 1.30.16 от 2026-08-18 ([PyPI](https://pypi.org/project/fava/)). Ledger: последний релиз v3.4.1 от 2025-10-26 ([GitHub API](https://api.github.com/repos/ledger/ledger/releases)) |

## Три вопроса

| Вопрос | Поддержка | Как именно |
|---|---|---|
| Q1 Хватит ли денег к дате | partial | hledger: периодические правила `~ monthly` + `--forecast` добавляют будущие транзакции «после последней обычной транзакции до +6 месяцев» (горизонт настраивается). Ledger: `--forecast-while`, `--forecast-years`. Beancount 3: файла forecast в `plugins/` на master нет, `[MONTHLY]` в голом Beancount не действует ([гайд](https://beancount.io/docs/Tips/forecast-plugin)); нужны сторонние плагины. В ветке v2 `forecast.py` в `plugins/` был (GitHub API) — то есть при переходе на v3 функцию вынесли из ядра (вывод) |
| Q2 Волна платежей | partial | Правила `~` делают будущие списания видимыми и суммируемыми по периодам; метрики «сколько нужно к каждой волне» нет (вывод) |
| Q3 Могу ли я это купить | partial | Только вручную: будущая транзакция или отдельный scenario-файл ([forecasting](https://hledger.org/forecasting.html)); команды «самая узкая точка» в docs нет (вывод) |
| Редкие траты | partial | Конверты как реальные или виртуальные субсчета ([budgeting](https://hledger.org/budgeting.html)); отдельной функции sinking fund docs не описывают. Fava: годовой бюджет разбивается на дневной эквивалент |
| Налоги | partial | Авто-проводки `= revenues:consulting` с `*0.25` в счёт налогового резерва; применяются только с `--auto`. Налоговых правил по датам нет. Это расчёт по введённым правилам, не консультация |

## Возможности по осям

| Ось | Уровень | Примечание |
|---|---|---|
| forecast_by_date | partial | `--forecast` в hledger/Ledger; в Beancount только сторонние плагины |
| can_i_afford | partial | what-if вручную через scenario-файл, без «узкой точки» |
| recurring_and_waves | partial | `~`-правила зрелые, агрегации по волнам нет |
| sinking_funds | partial | субсчета-конверты, специальной автоматики нет |
| tax_envelope | partial | авто-проводки с процентом, без правил по датам |
| multi_currency | full | несколько commodities на счёте, курс операции `@`/`@@`, база цен, оценка `-V/-X` |
| hourly_income | partial | `timeclock`/`timedot` ведут часы, но ставок и связи с деньгами в docs нет |
| privacy_local_first | full | локальные файлы, нет агрегаторов, git |
| import_export | full | экспорт CSV/JSON/HTML без lock-in; импорт полуручной (CSV-правила, скрипты), банков нет |
| ai_assistant | partial | штатного ассистента в самих программах нет; есть сторонние инструменты: MCP-серверы для hledger и Beancount, accountant24 (hledger), Countbean, Beanhand (Beancount) — по [plaintextaccounting.org](https://plaintextaccounting.org/), глубоко не проверены |
| openness | full | GPL/BSD/MIT, плагины Beancount на Python |

## Как это устроено

1. Единый текстовый журнал (источник истины): транзакция = дата + проводки, сумма по каждой commodity равна нулю.
2. Счета — иерархия (`assets:bank`, `liabilities:tax`). Beancount требует `open` до использования; hledger создаёт счета по факту ([сравнение](https://www.bitwave.io/blog/a-primer-on-plain-text-accounting-beancount-vs-hledger)).
3. Commodity — любая единица (валюта, тикер). Фактический курс — на проводке (`@`), рыночные цены — отдельными записями (`P` / `price`).
4. Balance assertion — якорь сверки с банком. hledger проверяет в порядке дат; Beancount — на начало дня, по одной валюте; `pad` вставляет выравнивающую проводку ([syntax](https://beancount.io/docs/Basics/syntax)).
5. Поток: скачать CSV банка, применить rules-файл, проверить, закоммитить; отчёты через CLI, TUI или Fava на localhost:5000.
6. Прогноз и бюджет — одни и те же `~`-правила (hledger).

## Сильные стороны

- Строгая модель: баланс проводок и assertions ловят ошибки ввода.
- Мультивалютность и цены встроены в ядро.
- Нет vendor lock-in: формат текстовый, версии в git.
- Расширяемость: авто-проводки, виртуальные проводки, плагины, Python API.

## Слабые стороны и ограничения

- UX-барьер: двойная запись, шаблоны счетов.
  - Beancount — «крутая кривая» ([Lynch, 2021](https://decks.mtlynch.io/plaintext-acccounting)); жёсткие корневые категории и обязательный `open` ([Bitwave, 2026-09](https://www.bitwave.io/blog/a-primer-on-plain-text-accounting-beancount-vs-hledger)).
  - Бюджетный отчёт встроен в Ledger и hledger, у Beancount — через Fava ([plaintextaccounting.org](https://plaintextaccounting.org/)); готового прогноза в ядре Beancount 3 нет.
- Импорт — ручная рутина и свои скрипты.
- Мобильные клиенты: официального у ядра нет; сторонние — MoLe и NanoLedger (hledger), Beancount Mobile CE, cone — в основном для ввода данных ([plaintextaccounting.org](https://plaintextaccounting.org/), [hledger FAQ](https://hledger.org/faq)).
- Прогноз стартует «после последней обычной транзакции» (вывод: заранее введённая будущая запись сдвигает старт проекции).
- Нет почасового дохода, инвойсов-прогноза, неопределённости и сценариев.
- **Противоречие источников по порядку проверки assertions:**
  - [beancount.io](https://beancount.io/blog/2026/03/17/beancount-vs-hledger-comparison-plain-text-accounting) пишет, что assertions в hledger зависят от порядка файла; [manual hledger](https://hledger.org/hledger.html) — что проверка идёт по датам. Принят manual.
  - Ledger: в последнем релизе v3.4.1 — по порядку разбора; в master (NEWS 3.5.0, релиза в GitHub Releases пока нет) проверка переведена на порядок дат, прежнее поведение возвращает `--check-in-file-order`.

## Данные и приватность

| Аспект | Факт |
|---|---|
| Хранение | локальные текстовые файлы |
| Экспорт | CSV, JSON, HTML (hledger); конвертация между форматами возможна |
| API | CLI, HTTP/JSON в hledger-web, Python API у Beancount |
| Self-host | всё локально; Fava — `pip install fava`, порт 5000 |
| Облако и аккаунты | не требуются; сторонний хостинг beancount.io (в т.ч. MCP-доступ) не изучался (не подтверждено) |

## Что взять в Runway

| Идея | Как реализовать |
|---|---|
| Журнал событий append-only + git | Транзакции неизменяемы, исправления — компенсирующими записями; прогноз всегда пересчитывается |
| Инвариант баланса | `Posting{account, amount_minor, currency}`; сумма по валюте равна 0; в UI — «откуда → куда» без дебета/кредита |
| Balance assertion как якорь | Подтверждённый остаток на дату; проекция стартует от последнего якоря; расхождение показывать, а не скрывать; `pad` — явная проводка «неразнесённое» |
| Commodity + база цен | Курс операции в проводке, цены `FxRate{date, base, quote}` отдельно; политика оценки `then/end/now` как в `--value` |
| Правила отдельно от факта | Слои Actual / Planned / Hypothetical; проекция от якоря или today, а не от последней записи |
| Авто-проводки как налоговый конверт | Правило «поступление по запросу → доля в резерв» с `effective_from`; работает всегда, помечено как derived |
| Виртуальные проводки | Конверты как наложение над реальным балансом: safe-to-spend = факт минус резервы |
| Дневной эквивалент (Fava budget) | Годовые траты нормализовать к дневной ставке для sinking funds |
| Экспорт в hledger | Экспорт в `.journal` и сверка `hledger bal` как независимый тест движка (идея, не проверено) |

## Чего избегать

- Требовать от пользователя знания дебета/кредита и плана счетов.
- Прогноз за флагом и с фиксированным горизонтом; правила, скрытые за `--auto`.
- Зависимость сверки от порядка строк (Ledger 3.4.1; в master это исправлено).
- Ручной импорт как единственный путь.
- Часы и деньги в разных мирах: ставка и часы должны питать прогноз.

## Источники

- https://hledger.org/ — что такое hledger, интерфейсы, спонсорство — 2026-10-04
- https://hledger.org/hledger.html — `~`, `--forecast`, assertions, `P`, `-V/-X`, авто-проводки, timeclock — 2026-10-04
- https://hledger.org/forecasting.html, https://hledger.org/budgeting.html — способы прогноза, конверты — 2026-10-04
- https://hledger.org/faq — полуручной импорт CSV, MoLe — 2026-10-04
- https://api.github.com/repos/simonmichael/hledger/releases, https://github.com/simonmichael/hledger — релизы, лицензия — 2026-10-04
- https://ledger-cli.org/doc/ledger3.html, https://github.com/ledger/ledger, https://api.github.com/repos/ledger/ledger/releases — Ledger: `~`, forecast, лицензия, релиз — 2026-10-04
- https://pypi.org/project/beancount/, https://github.com/beancount/beancount/tree/master/beancount/plugins — версия, лицензия, нет forecast.py — 2026-10-04
- https://beancount.io/docs/Basics/syntax, https://beancount.io/docs/Tips/forecast-plugin — assertions, pad, price; `[MONTHLY]` без эффекта (сторонний хостинг, осторожно) — 2026-10-04
- https://pypi.org/project/fava/, https://raw.githubusercontent.com/beancount/fava/main/src/fava/help/budgets.md — Fava, директива `custom "budget"`, интервалы daily–yearly, дневной эквивалент — 2026-10-04
- https://raw.githubusercontent.com/ledger/ledger/master/NEWS.md, https://raw.githubusercontent.com/ledger/ledger/master/doc/ledger.1 — Ledger: опции forecast, `--check-in-file-order`, порядок проверки assertions — 2026-10-04
- https://plaintextaccounting.org/ — обзор экосистемы, бюджетные отчёты, мобильные клиенты, AI-инструменты — 2026-10-04
- https://www.bitwave.io/blog/a-primer-on-plain-text-accounting-beancount-vs-hledger, https://decks.mtlynch.io/plaintext-acccounting — независимые оценки порога входа — 2026-10-04

Проверка: скептическая перепроверка 2026-10-04 (21 утверждение проверено); подтверждено 17, расхождения исправлены на странице и в scorecard, неподтверждённое помечено «(не подтверждено)».

## Связанные страницы

- [Actual Budget](actual-budget.md) — local-first конверты с расписаниями
- [Матрица возможностей](../comparisons/feature-matrix.md)
- [Прогноз денежного потока](../concepts/cash-flow-forecast.md)
- [Налоговый конверт](../concepts/tax-envelope.md)
- [Мультивалютность и курсы](../concepts/multi-currency-fx.md)
- [Local-first и приватность](../concepts/local-first-privacy.md)
