---
title: "Руководство по прототипу"
type: product
status: draft
summary: "Как запустить и читать прототип Runway: 3551 тест на 2026-11-09, демо и CLI, карта модулей, ALG, TST и экранов, как добавить сценарий, ограничения, честный отчёт о реализации относительно среза v1."
sources: [prototype/README.md, prototype/demo/ext_manifest.mjs, _ops/design-brief.md, _ops/canon-decisions.md, _ops/impl/run/verify-wave3a4-fp24-fix.txt, wiki/decisions/adr-014-testing-approach.md, wiki/decisions/adr-015-v1-slice.md, wiki/product/19-implementation-status-after-wave2.md]
updated: 2026-11-09
---

# Руководство по прототипу

## Назначение

`prototype/` — исполняемая версия алгоритмов из [ALG-01…14](../algorithms/alg-01-recurrence-expansion.md): детерминированный движок прогноза денежного потока на чистом JavaScript (ES-модули, без зависимостей, Node ≥ 24), тесты на встроенном `node --test`, демо-страница и командная строка. Правило проекта: псевдокод страниц обязан совпадать с кодом по смыслу, а числа страниц берутся из кода ([REQ-177](02-requirements.md), [ADR-014](../decisions/adr-014-testing-approach.md)). Где они разошлись, это записано в разделе «Реализация в прототипе» соответствующей страницы алгоритма.

Прототип — исследование, а не продукт: он реализует **все** модули, в том числе v2 (Монте-Карло, калибровка, backtest), но продуктовый срез v1 от этого не расширяется ([ADR-015](../decisions/adr-015-v1-slice.md)); что именно сделано и чего нет — в разделе «Что реализовано относительно среза v1». Все числа — расчёт по введённым данным и правилам, не консультация.

## Состояние на 2026-11-09 (волна 3а-5: FP-49, FP-50, FP-51)

Последовательный прогон «по одному файлу» (`_ops/impl/run/run_all.mjs`; Node v24.13.0, Windows 11; `_ops/impl/run/verify-wave3a5.txt`; время в шапке — 947 с (сумма времён файлов); промежуточный батч того же дня (201 файл, 6 упавших) — `_ops/impl/run/interim-wave3a5-201.txt`). После 2026-10-28 добавлены: FP-49 (хвосты FP-48 и FP-24; принят 2026-10-28), FP-50 (матрица часов и поясов `tools/clock_matrix.mjs` и предзагрузка часов; вторая проверка вернула пять low — они перечислены в [бэклоге](../../_ops/gap2/backlog-wave3.json) и в [находках прототипа](16-prototype-findings.md)) и FP-51 (вики). Прошлые числа — в скобках (прогон 2026-10-28).

| Показатель | Значение (на 2026-10-28 — в скобках) |
|---|---|
| Файлов с тестами | 202: 198 в `tests/` и 4 состязательных в `tests/adversarial/` (194: 190 и 4) |
| Тестов всего | **3551** (3452) |
| Зелёных (`pass`) | **3529** (3423) |
| Упавших (`fail`) | **0** (1) — итоговый прогон 2026-11-09 без красных. Прежний красный `tests/v0.test.mjs` (REQ-180, TST-59) исправлен в FP-50: часы страницы передаются портом, и тест не зависит от сегодняшней даты. Два красных ADV-2/ADV-3 в `tests/fp30_adv.test.mjs` (вики и отчёт не знали файлов FP-49) исправлены в FP-51, 14/14. Промежуточный батч того же дня (201 файл, отчёт `interim-wave3a5-201.txt`) упал ещё на четырёх тестах на время под нагрузкой (`tests/adversarial/verifier_io.test.mjs` TST-45, `tests/calc_async_model.test.mjs` REQ-150, `tests/import_main_thread.test.mjs` REQ-091/REQ-150, `tests/fp49_boot.test.mjs` REQ-167 ADV-11); при повторе по одному файлу они прошли и в итоговом прогоне не упали ([README прототипа](../../prototype/README.md), «Исправления по независимой проверке») |
| Пропущено (`skipped`) | **2** (2) — оракул `hledger` (нет бинаря) и ночной фаззинг (`FUZZ_N`) |
| Помечено `todo` | **20** (26): открытые недочёты проверок `fp*_adv` и спорные места канона — перечень в [стратегии тестирования](11-testing-strategy.md), «Тесты todo и пропуски»; после правок FP-51 пометки сняты у восьми (ADV-8…14 в `fp30_adv`, один в `fp25_adv`) |
| Код движка | 39 модулей `engine/*.mjs`, 14 863 строк (31 модуль, 13 016) |
| Код демо | 121 модуль `demo/*.mjs` (31 459 строк), 31 каталог строк RU/EN `demo/i18n/*.mjs`, 21 файл стилей `demo/css/*.css`; 20 пакетов в `demo/ext_manifest.mjs`; 23 раздела навигации; четыре отдельные страницы: `v0.html`, `bench.html`, `coldstart.html`, `compat.html` |
| Инструменты | 19 скриптов `tools/*.mjs` (FP-50 добавил `clock_matrix.mjs` и `clock_shift_preload.mjs`; FP-51 — `tst_coverage.mjs`): сборка и проверка оболочки, замеры, мутации, фаззинг, замок вывода, сквозной прогон, матрица часов, пакеты для людей, отчёт backtest, анонимизация, генераторы словаря |

Числа строк и файлов — по составу каталогов на 2026-11-09. Число модулей движка в README прототипа исправлено на 39 (FP-51: учтены `hours_io` и `io_fx_rows` из FP-29). Пакет FP-49 добавил `demo/horizon.mjs` и четыре файла тестов (`fp49_adv`, `fp49_fix`, `fp49_pure`, `fp49_boot`); FP-50 — `tools/clock_matrix.mjs`, `tools/clock_shift_preload.mjs`, `tests/clock_matrix.test.mjs` и `tests/fp50_adv.test.mjs`. Аддитивность проверена `tools/additive_check.mjs` относительно снимка `_backups/2026-11-09_181351_wave3a5-fp51-before`. Тесты на время (REQ-153, TST-45, TST-54, RISK-22) под нагрузкой прогона нестабильны: красный такой тест — повод перезапустить файл по одному на свободной машине. В батче 2026-11-09 четыре из них упали под нагрузкой; повтор каждого по одному после батча (та же машина) прошёл (см. строку «Упавших»), поэтому красный тест на время при нагрузке — повод для повтора, а не доказательство регресса ([RISK-22](12-risks.md#risk-22-тесты-на-время-и-на-дату-дают-ложный-красный)).

## История: состояние на 2026-10-28 (после волны 3а, FP-48 и FP-24)

Последовательный прогон «по одному файлу» (`npm run test:all`, `tools/run_all_tests.mjs`; Node v24.13.0, Windows 11; `_ops/impl/run/verify-wave3a4-fp24-fix.txt`, 650 с). После волны 2 к прототипу добавлены: волна 3а — FP-13…FP-23, FP-25…FP-29 и хвосты повторного аудита FP-47; затем FP-48 (шесть мелких дефектов проходов в браузере) и FP-24 (тестовая сеть); разбор по пакетам — [README прототипа](../../prototype/README.md), ход волн — [дорожная карта](10-roadmap.md). Прошлые числа — в скобках (прогон 2026-10-10).

| Показатель | Значение (на 2026-10-10 — в скобках) |
|---|---|
| Файлов с тестами | 194: 190 в `tests/` и 4 состязательных в `tests/adversarial/` (94) |
| Тестов всего | **3452** (2155) |
| Зелёных (`pass`) | **3423** (2148) |
| Упавших (`fail`) | **1** (0) — `tests/v0.test.mjs`, «REQ-180 TST-59 открытие испорченного файла»: тест вводит платёж на фиксированную дату 2026-10-25, а страница `v0.html` берёт сегодняшнюю дату по часам, и с 2026-10-26 она в прошлом; ошибка теста, привязанного к календарю, не движка |
| Пропущено (`skipped`) | **2** (2) — оракул `hledger` (нет бинаря) и ночной фаззинг (`FUZZ_N`) |
| Помечено `todo` | **26** (5): четыре спора с каноном и 22 недочёта проверок пакетов (`fp*_adv`) — перечень в [стратегии тестирования](11-testing-strategy.md), «Тесты todo и пропуски» |
| Код движка | 39 модулей `engine/*.mjs`, 14 836 строк (31 модуль, 13 016) |
| Код демо | 120 модулей `demo/*.mjs` (31 347 строк), 31 каталог строк RU/EN `demo/i18n/*.mjs`, 21 файл стилей `demo/css/*.css`; 20 пакетов в `demo/ext_manifest.mjs`; 23 раздела навигации; четыре отдельные страницы: `v0.html`, `bench.html`, `coldstart.html`, `compat.html` (72 модуля, 20 554 строки) |
| Инструменты | 18 скриптов `tools/*.mjs` (9): сборка и проверка оболочки, замеры, мутации, фаззинг, замок вывода, сквозной прогон, пакеты для людей, отчёт backtest, анонимизация, генераторы словаря |

Числа строк и файлов — по составу каталогов на 2026-10-28; число модулей движка в README прототипа (37) отстаёт: в нём не учтены `hours_io` и `io_fx_rows` (FP-29). Волна 3а (FP-13…FP-29, FP-47) добавила: календарь и перенос вхождения, долг в прогнозе, экран «Резервы» с «освободить остаток», подпись курса и формат чисел на всех поверхностях, значения по умолчанию как данные и режим «только чтение», свой CSV Runway в мастере и разбор в Worker, страницы замеров, гейты слов и ставок, метрики из окон прогноза и «Сообщить об ошибке», автозапись копии в файл, чипы и журнал вызовов в ассистенте, доступность и адаптив, хвосты «Ленты» и «Обзора», часы из CSV и обмен двумя ногами, расчёт основных экранов в Worker, пакеты для людей (`_ops/people/`). Пакет FP-24 добавил девять файлов тестов (`properties`, `properties_mutation`, `engine_lock`, `mutate_engine`, `run_all_tests`, `small_journals`, `fuzz_nightly`, `fuzz_findings`, `fp24_adv`) и замок `tests/engine.lock.json`, пакет FP-48 — четыре (`fp48_pure`, `fp48_boot`, `fp48_chain`, `fp48_adv`); вместе с ними 181 файл прогона 2026-10-24 стал 194. Аддитивность проверена `tools/additive_check.mjs`: пропавших экспортов и файлов нет; числа G-001, `golden` и `arith.lock` не менялись.

Тесты на время (REQ-153, TST-45 «сложность», TST-54) на перегруженной машине нестабильны: красный тест на время — повод перезапустить файл на свободной машине, а не искать ошибку ([RISK-22](12-risks.md#risk-22-тесты-на-время-и-на-дату-дают-ложный-красный)). Интерфейс пакетов агенты проверяли на заглушке DOM; ручные проходы в настоящем браузере делал координатор ([находки](16-prototype-findings.md), [RISK-24](12-risks.md#risk-24-заглушка-dom-не-заменяет-настоящий-браузер)).

## Состояние на 2026-10-10 (после волны 1, этапа S1 и волны 2; для истории)

Последовательный прогон «по одному файлу» (`--test-concurrency=1`; Node v24.13.0, Windows 11; прогон 2026-10-09 на перезагруженной машине, свободно ≈ 1,5 ГБ из 7,8 ГБ). Этап S1 («хвосты волны 1») добавил «Сегодня» (`set_as_of`), оговорку про конец горизонта в конструкторе, единую стопку «Отменить», порядок фокуса в навигации и слот `waves.card`; итог — [анализ реализации](18-implementation-gap-analysis.md), раздел «Этап S1». Числа ниже; прогон 2026-10-06 (62 файла, 1675 тестов) — для истории. Подробности и разбор — [README прототипа](../../prototype/README.md), приёмка — `_ops/impl/wave1-acceptance.md`, итог волны — [анализ реализации](18-implementation-gap-analysis.md).

| Показатель | Значение (до волны 1 — в скобках) |
|---|---|
| Файлов с тестами | 94: 90 в `tests/` и 4 состязательных (29) |
| Тестов всего | **2155** (1098); вызовов `test(` в файлах — 2310 |
| Зелёных (`pass`) | **2148** (1084): все файлы зелёные при первом запуске сквозного прогона, включая тесты на время |
| Упавших (`fail`) | **0** (0) |
| Пропущено (`skipped`) | **2** (1) — оракул `hledger` (нет бинаря) и ночной фаззинг (`FUZZ_N`) |
| Помечено `todo` | **5** (13) — см. «Открытые вопросы» (четыре прежних и ADV-6 в `fp11_adv`) |
| Код движка | 31 модуль `engine/*.mjs`, 13 016 строк (19 модулей, 10 108 строк) |
| Код демо | 72 модуля `demo/*.mjs` (20 554 строки), 12 каталогов строк `demo/i18n/*.mjs`, 12 файлов `demo/css/*.css`, страница `demo/v0.html`, PWA-файлы; 23 раздела навигации |

Три теста на время (REQ-153 «журнал на 36 500 записей ≤ 2 с», TST-45 «сложность», TST-54 «p95 пересчёта ≤ 100 мс») в прогоне 2026-10-06 на перегруженной машине упали, а 2026-10-09 на освобождённой — прошли с первого раза. Красный тест на время — повод перезапустить файл на свободной машине, а не искать ошибку. Аддитивность проверена `tools/additive_check.mjs` относительно снимка до волны: пропавших экспортов и файлов нет. Идентификаторы TST-01…60 упомянуты в тестах (`_ops/tst-coverage.json`, `missing` пуст); неполные TST из списка ниже остаются неполными; TST-59 по-прежнему автоматически проверяет статику и заглушку DOM, а ручной прогон интерфейса в настоящем браузере выполнен отдельно (раздел «Проверка волны 1 в браузере» в [находках](16-prototype-findings.md)).

## Состояние на 2026-10-05 (до волны 1, для истории)

Полный запуск `node --test` в `prototype/` (Node v24.13.0, Windows 11; два прогона подряд дали одни и те же счётчики):

| Показатель | Значение |
|---|---|
| Файлов с тестами | 29 (25 в `tests/` и 4 состязательных в `tests/adversarial/`) |
| Тестов всего | **1098** |
| Зелёных (`pass`) | **1084** |
| Упавших (`fail`) | **0** |
| Пропущено (`skipped`) | **1** — оракул `hledger`: бинаря нет в среде |
| Помечено `todo` | **13** — спорные места канона (см. «Открытые вопросы»), набор не ломают |
| Время | 55–78 с (два прогона 2026-10-05: 77,6 и 55,0 с; прежние замеры — 67–89 с); зависит от нагрузки машины |
| Код движка | 19 модулей `engine/*.mjs`, 10 108 строк, плюс `vocab.json` |

Все идентификаторы TST-01…TST-60 из [стратегии тестирования](11-testing-strategy.md) упомянуты хотя бы в одном тесте, но не все закрыты полностью: неполно TST-44 (настоящий `hledger` не запускался), TST-51 (объёмы фаззинга меньше целевых 10⁵ журналов), TST-52 (замок арифметики есть, мутаций две вместо ≥ 30), TST-53 (оракул — для проекции, «можно ли купить», резервов, часов, курсов, долгов), TST-54 (замеры разовые), TST-55 (только синтетические журналы), TST-59 (статическая проверка файлов и CSP без прогона в браузере), TST-60 (нет `tsc --checkJs` и двойной сборки).

## Как запустить

### Требования

Node ≥ 24 (`prototype/package.json`, `engines`); `npm install` не нужен — зависимостей нет. Пути ниже — относительно `C:\xampp\htdocs\01\301\runway\`.

### Тесты

```sh
cd prototype
npm run test:all                                  # все 194 файла по одному (≈ 650 с), сводка в ../_ops/impl/run/run_all_tests.json; --resume продолжает прерванный прогон; test:fast — без тяжёлых файлов (≈ 5 минут); test:nightly — с повышенными объёмами случайных наборов
node --test                                       # весь набор параллельно: НЕ на машине с малой памятью — параллельный запуск уже дважды подвешивал систему, запускайте по одному файлу
for f in tests/*.test.mjs tests/adversarial/*.test.mjs; do node --test --test-timeout=180000 --test-concurrency=1 "$f"; done   # по одному файлу: память не перегружается (Git Bash)
node --test tests/montecarlo.test.mjs             # один файл
node --test --test-name-pattern="TST-48"          # по имени теста (идентификатор TST-NN в названии)
```

Замок арифметики (`tests/arith.lock.json`, TST-52: 574 случая операций `money`, seed 2026, вход, выход и sha256 каждого) меняют только намеренно и отдельным коммитом «ARITH-CHANGE: причина» с повышением `ENGINE_VERSION` (`engine/index.mjs`; он входит в `inputs_hash`, поэтому меняются и ссылки расчёта `c_…`): `ARITH_LOCK_UPDATE=1 node --test tests/arith.test.mjs` (в PowerShell: `$env:ARITH_LOCK_UPDATE = '1'; node --test tests/arith.test.mjs`). Без этой переменной файл не перезаписывается; рефакторинг файл замка не меняет. Замок вывода движка (`tests/engine.lock.json`, FP-24: `sha256(canon(analyze(ws, query)))` на 500 журналах общего генератора) сверяет `npm run lock:engine`; намеренную правку расчёта оформляют отдельным коммитом «ENGINE-CHANGE: причина» с повышением `ENGINE_VERSION` и `npm run lock:engine:write`.

### Демо

```sh
cd prototype
node serve.mjs                                    # http://localhost:8787/demo/  (слушает только 127.0.0.1)
```

Порт можно сменить переменной `PORT`; сервер отдаёт только `demo/`, `engine/` и `data/` (GET и HEAD). Через XAMPP сервер не нужен: `http://localhost/01/301/runway/prototype/demo/` (Apache отдаёт статику; `.mjs` Apache 2.4.58 из этого XAMPP отдаёт как `text/javascript` по `conf/mime.types`; после перезагрузки Windows Apache нужно запустить в панели XAMPP). Страница проверялась в настоящем браузере вручную после каждой волны ([находки прототипа](16-prototype-findings.md)). Открывать `file://` нельзя — страница читает модули и наборы данных по HTTP. Разделы демо — в «Карте экранов и пакетов» ниже (23 раздела: восемь базовых и пятнадцать из реестра расширений); в навигации — кнопки «+ Факт», «Сверить остаток», «Отменить», «Вернуть», «?» (горячие клавиши). Наборы: `G-001`, `G-001-low`, `G-001-gap`, `G-001-late`, `G-001-empty` (пустой, для мастера «Старт»); можно загрузить свой JSON (до 5 МБ) и выгрузить текущее состояние. Язык (ru/en) и тема запоминаются в `localStorage` под ключами `runway-demo-*`. Сами данные (журнал фактов и правок) пакет FP-05 хранит в IndexedDB (база `runway`; запасные варианты — `localStorage` и память вкладки), делает файл-копию (с автозаписью в выбранный файл там, где это позволяет браузер) и умеет «Удалить все данные…»: удаление затрагивает только данные приложения, а не соседние страницы того же `localhost` ([RISK-19](12-risks.md#risk-19-общий-источник-localhost-данные-кэши-и-воркеры-делятся-с-чужими-проектами)). Отдельные страницы: `demo/v0.html` (калькулятор v0) и страницы замеров и самопроверки устройства `demo/bench.html`, `demo/coldstart.html`, `demo/compat.html` (адреса — `http://localhost/01/301/runway/prototype/demo/<страница>` либо `http://localhost:8787/demo/<страница>`; `coldstart.html` под `node serve.mjs` вложенное окно не открывает — для замера нужен Apache или HTTPS-хост).

### Командная строка (режим A0)

```sh
cd prototype
node cli.mjs data/g001.json check-purchase 2026-10-12 30000 EUR     # суммы — целые minor units: 30000 = 300,00 €
node cli.mjs --help                                                 # список команд
```

Ответ — шаблон каталога с числами из `evidence`, затем сами доказательства и `inputs_hash`; на G-001 это вердикт `FRAGILE`, 635,00 € по плану и 410,00 € «если хуже» (ссылка расчёта `c_131fba11` для движка 0.1.0). Коды выхода: 0 — ответ получен и прошёл верификатор, 1 — ошибка инструмента или проверка не пройдена, 2 — неверный запуск. Команды: `check-purchase`, `projection`, `max-amount`, `earliest`, `waves`, `explain`, `scenario`, `tax`, `changed`, `propose` (последняя требует `--t1` и ничего не записывает). Ключи: `--locale ru|en`, `--as-of YYYY-MM-DD`, `--json`, `--t1`; у `check-purchase` ещё `--buffer N`. Ключ `--mode plan|worse` указан в шапке `cli.mjs`, но не разбирается: `… --mode plan` даёт `E_SCHEMA` (код выхода 1), режим берётся из `params.headline_mode` рабочей области (у G-001 — `worse`).

### Проверки вики

```sh
node tools/lint.mjs            # frontmatter, битые ссылки, сироты, дубли ID
node tools/lint_vocab.mjs --registry prototype/demo/promises.json   # запрещённые формулировки, императивы в строках интерфейса, метки чисел <!--num:G-001.ключ=значение-->, реестр обещаний
node tools/build_index.mjs     # пересборка wiki/index.md (руками не править)
```

## Структура папок

```
runway/
  CLAUDE.md, STATE.md      схема вики и точка возобновления
  raw/  wiki/  tools/      источники, страницы, служебные скрипты (lint, индекс, лог, снимки)
  _ops/                    канон (design-brief, canon-decisions), итоги workflow
  prototype/
    README.md              шпаргалка: быстрый старт, карта модулей, слои, замки арифметики и вывода движка, наборы данных, `todo`, разделы пакетов волн 1–3а
    CHECKLIST-release.md   чек-лист ручных проверок PWA, устройств и выпуска (заготовка для людей, ничего не выполнено)
    SPEC-format.md         форматы runway-journal/1, runway-metrics/1, runway-shell/1
    package.json           type: module, engines ≥ 24, зависимостей нет
    cli.mjs  serve.mjs     CLI режима A0; статический сервер демо (граница: тут допустимы node:fs, node:http)
    engine/                чистое ядро: 39 модулей .mjs (19 прежних, 9 модулей волны 1, `mc_inputs`, `expected`, `band_adapter` волны 2, `debt_ext`, `vocab.generated`, `param_defaults`, `io_readonly`, `call_log`, `installment_earliest`, `hours_io`, `io_fx_rows` волны 3а) + vocab.json (нет Date, Math.random, fetch, node:*, Intl)
    tests/                 *.test.mjs (190), helpers.mjs, oracle.mjs, fake_idb.mjs, journal_gen.mjs, properties_lib.mjs, fuzz_progress.mjs, dom_boot.mjs, sw_harness.mjs, arith.lock.json, arith.lock.policy.json, engine.lock.json, fixtures/
    tests/adversarial/     состязательные тесты: dates_money, golden_properties, semantics, verifier_io
    data/                  g001.json, g001-low.json, g001-gap.json, g001-late.json, g001-empty.json, g001-debt.json, golden-g001.json, backtest-report.json; templates/ (шаблон-скелет без ставок), profiles/ (профили CSV как данные)
    data/synthetic-journals/  детерминированный генератор журналов для backtest, manifest.json (sha256)
    tools/                 16 скриптов .mjs: build_manifest, verify, bench, contrast, mutate, fuzz_nightly, make_engine_lock, run_all_tests, gen_vocab, gen_vocab_tables, suggest_num_labels, backtest_report, anonymize, people_pack, onboarding_median, hledger_oracle; README.md
    demo/                  index.html, app.mjs, i18n.mjs, style.css (страница без CDN и inline-кода); реестр расширений ext.mjs и 20 пакетов pack_fp03…pack_fp29.mjs (список — ext_manifest.mjs), i18n/ (31 каталог RU/EN), css/ (21 файл); v0.html, bench.html, coldstart.html, compat.html; PWA: manifest.webmanifest, icons/*.svg, sw.js
```

Чистота `engine/` проверяется тестом (TST-60): внешнее приходит аргументами-портами (`as_of`, идентификаторы, `seq`, `recorded_at`), деньги — целые minor units, умножение и деление — только через `mul_div` / `round_div` / `split_*` (BigInt внутри), даты — `EpochDay`. Слои зависимостей (design-brief §14 B4) — порядок рангов, в котором модуль вправе импортировать только нижележащие: `money ← dates ← {recurrence, hourly, fx, tax, debt, calibration} ← timeline ← sinking ← {waves, afford} ← index ← {tools ← verifier, backtest}`; `montecarlo` — от `timeline`, `sinking`, `tax`, `calibration` (тест разрешает и `afford`, но он не импортируется); `ledger` — только `money`; `io` — `ledger`, `dates`, `money`. Фактические прямые импорты каждого модуля (например, `sinking` импортирует только `money` и `dates`, `waves` и `afford` — `timeline`) перечислены в `prototype/README.md`; граф проверяет `tests/purity.test.mjs`.

## Карта модулей, ALG и тестов

Числа в скобках — число тестов в файле по счёту раннера (с подтестами); столбец TST — идентификаторы из названий тестов перечисленных файлов, без состязательных `adversarial/*` (их названия несут и другие ID). «Подробности» — раздел «Реализация в прототипе» страницы алгоритма (экспорты, расхождения псевдокода и кода).

| Модуль | Алгоритм | Тесты (файлы) | Основные TST |
|---|---|---|---|
| `money.mjs` | [ADR-002](../decisions/adr-002-money-minor-units.md), канон §4 | `money` (19), `arith` (5) + `arith.lock.json`, `adversarial/dates_money` | 16, 17, 18, 19, 51, 52 |
| `dates.mjs` | [ALG-01](../algorithms/alg-01-recurrence-expansion.md), [ADR-003](../decisions/adr-003-civil-dates.md) | `dates` (16), `adversarial/dates_money` | 11, 12, 13, 15, 51 |
| `recurrence.mjs` | [ALG-01](../algorithms/alg-01-recurrence-expansion.md) | `recurrence` (22) | 11–14, 51 |
| `ledger.mjs` | [модель данных](04-data-model.md), [ADR-004](../decisions/adr-004-event-journal-projections.md); `norm`, `dedup_key` — [ALG-14](../algorithms/alg-14-hledger-export-csv-import.md) | `ledger` (24), `adversarial/dates_money` | 32, 33, 38, 42 |
| `timeline.mjs` | [ALG-02](../algorithms/alg-02-timeline-projection.md): события, ряды, Q1, сценарии, `explain` | `timeline` (39), `adversarial/semantics` | 31, 33–36, 41, 53, 54, 57 |
| `waves.mjs` | [ALG-03](../algorithms/alg-03-payment-waves-detection.md) | `waves` (26) | 03, 08, 37 |
| `afford.mjs` | [ALG-04](../algorithms/alg-04-can-i-afford.md), [ALG-11](../algorithms/alg-11-safe-to-spend.md) | `afford` (36) | 04, 05, 06, 08, 30, 35, 39, 53 |
| `sinking.mjs` | [ALG-05](../algorithms/alg-05-sinking-funds.md) | `sinking` (29) | 02, 06, 08, 17, 20, 21, 22, 24, 33, 39, 51, 53 |
| `tax.mjs` | [ALG-06](../algorithms/alg-06-tax-envelope.md) | `tax` (18) | 10, 23, 24, 33, 57 |
| `hourly.mjs` | [ALG-07](../algorithms/alg-07-hourly-income.md) | `hourly` (23) | 10, 25, 26, 51, 53 |
| `fx.mjs` | [ALG-08](../algorithms/alg-08-fx-conversion.md) | `fx` (18) | 27, 28, 33, 51, 53 |
| `debt.mjs` | [ALG-09](../algorithms/alg-09-debt-amortization.md) | `debt` (16) | 29, 30, 51, 53 |
| `index.mjs` | фасад `analyze(ws, query)` → `Analysis` (D-21); реэкспорт `money`, `dates`, `recurrence`, `hourly`, `fx`, `tax`, `debt`, `calibration`, `timeline`, `sinking`, `waves`, `afford`, `ledger` (без `montecarlo`, `io`, `tools`, `verifier`, `backtest`) | `analyze` (18), `g001` (22), `g001.golden` (10), `adversarial/golden_properties` (76) | 01–10, 25, 26, 33, 36, 39, 41, 57 |
| `montecarlo.mjs` | [ALG-10](../algorithms/alg-10-uncertainty-monte-carlo.md) | `montecarlo` (38) | 33, 48, 49, 50, 54 |
| `calibration.mjs` | [ALG-13](../algorithms/alg-13-plan-vs-actual-calibration.md): сопоставление, статусы, свежесть, лаги, Уилсон | `calibration` (28) | 32, 40, 41, 49, 50, 57 |
| `backtest.mjs` | [ALG-13](../algorithms/alg-13-plan-vs-actual-calibration.md): backtest, `release_gate`, `default_breach` (вынесен из `calibration`, §14 B4) | `backtest` (32) | 33, 55, 60 |
| `tools.mjs` | [ALG-12](../algorithms/alg-12-llm-tool-contract-and-number-verifier.md): 10 инструментов, схемы, `Result` | `tools` (33), `injection` (14) | 46, 47 (и 01–09, 36 через инструменты) |
| `verifier.mjs` | [ALG-12](../algorithms/alg-12-llm-tool-contract-and-number-verifier.md): шаблоны, рендер, верификатор, A0 | `verifier` (33), `injection` | 45, 46, 47, 56, 58 |
| `io.mjs` | [ALG-14](../algorithms/alg-14-hledger-export-csv-import.md): CSV, профили, дедупликация, JSON, hledger | `io` (35, один пропущен) | 19, 32, 38, 42, 43, 44, 60 |
| `validate_ws.mjs` (волна 1, FP-02) | проверка рабочей области до расчёта: `validate_ws`, `validate_journal`, `analyze_checked` (карантин записей), пределы размеров и диапазоны параметров | `validate_ws` (23), `hardening` (40) | 31, 38, 51, 54 |
| `warnings_ext.mjs` (волна 1) | служебные предупреждения вне `vocab.json`: `W_TRANSFER_UNPAIRED`, `W_HOURS_KEY_IGNORED`, `W_PARAM_OUT_OF_RANGE`, `W_RECORD_QUARANTINED`, `W_DEBT_BEYOND_HORIZON`; описаны, но движком пока не выдаются, `W_OVERRIDE_SIGN` и `W_RESERVE_CLIPPED` | `hardening`, `debt_forecast` | 27, 56 |
| `transfer_guard.mjs` (волна 1, FP-04) | перевод на копилку при резерве без привязки (REQ-063): `check_transfer`, `pending_transfers`, `decline_record` | `transfer_guard` (8) | 02 |
| `tax_hooks.mjs` (волна 1, FP-08) | запись налогового конверта по проведённому доходу (`allocation.recorded`), выпуск резерва по платежу — [ALG-06](../algorithms/alg-06-tax-envelope.md) | `tax_hooks` (11) | 23, 24 |
| `sinking_report.mjs` (волна 1, FP-08) | отчёт по накоплениям: план взносов, «цель достигнута», «до срока нет дат взноса» — [ALG-05](../algorithms/alg-05-sinking-funds.md) | `sinking_report` (12) | 20, 21, 22 |
| `liquidity.mjs`, `installment.mjs` (волна 1, FP-08) | «запас» отдельно от operating (REQ-018, REQ-080); рассрочка с процентами из `DebtPlan` для `check_purchase` (REQ-192) | `liquidity` (7), `installment` (7) | 28–30 |
| `scenario_ext.mjs`, `wave_sweep.mjs` (волна 1, FP-07) | операция сценария `hours`; чувствительность порога волн и «почему вместе» (REQ-036, REQ-051) | `scenario_builder` (19), `wave_edit` (12), `why_more` (12) | 27, 33, 37 |
| `debt_ext.mjs` (волна 3а, FP-14) | долг в прогнозе: сохранённый график, перенос строки, досрочное погашение, ре-якорение, платежи за горизонтом — [ALG-09](../algorithms/alg-09-debt-amortization.md) | `debt_forecast` (39), `debt_edit` (23), `debt_edit_boot` (15), `fp14_adv` (11) | 29, 30, 51, 53 |
| `mc_inputs.mjs`, `expected.mjs`, `band_adapter.mjs` (волна 2, FP-11) | входы вероятностных расчётов из истории, ряд «ожидаемый», коридор P10–P90 и «при уверенности α» — [ALG-10](../algorithms/alg-10-uncertainty-monte-carlo.md), [ALG-13](../algorithms/alg-13-plan-vs-actual-calibration.md) | `mc_inputs` (11), `expected` (6), `band_adapter` (11), `prob_band` (20) | 41, 48, 49, 50 |
| `vocab.generated.mjs`, `param_defaults.mjs`, `io_readonly.mjs` (волна 3а, FP-17) | значения по умолчанию из `vocab.json` как данные; файл новее известного формата открывается «только для просмотра» | `vocab_generated` (10), `defaults_sync` (9), `readonly_open` (15), `engine_stamp` (15) | 56, 57 |
| `call_log.mjs` (волна 3а-2, FP-20) | журнал вызовов ассистента (только хэши), `changes_view` для «что изменилось» — [ALG-12](../algorithms/alg-12-llm-tool-contract-and-number-verifier.md) | `call_log` (16), `assistant_ext` (35) | 47 |
| `installment_earliest.mjs` (волна 3а-2, FP-28) | «с какой даты рассрочка держится в буфере» — [ALG-04](../algorithms/alg-04-can-i-afford.md) | `installment_earliest` (17) | — |
| `hours_io.mjs`, `io_fx_rows.mjs` (волна 3а-2, FP-29) | часы из CSV; строка в чужой валюте с двумя ногами как обмен — [ALG-07](../algorithms/alg-07-hourly-income.md), [ALG-14](../algorithms/alg-14-hledger-export-csv-import.md) | `hours_io` (14), `io_fx_rows` (14), `import_v11` (14) | — |
| `vocab.json` | словарь §2.0: режимы, вердикты, коды, параметры, запрещённые фразы | `purity` (126), сверки в тестах модулей | 56, 60 |
| демо и CLI | [UX](03-ux-screens.md) | `demo` (34), пакеты (`*_boot`, `wave1_integration` и др.), `injection` (CLI) | 01, 02, 04, 10, 33, 37, 45, 47, 56, 58, 59 |

Тесты `adversarial/semantics` (177, из них 2 `todo`) обходят `waves`, `afford`, `timeline`, `sinking`, `tax`, `hourly`, `fx`, `debt`; `adversarial/verifier_io` (148, из них 2 `todo`) — `tools`, `verifier`, `io`, `calibration`, `montecarlo`. Карта демо-пакетов волны 1 (какие модули `demo/` в каком пакете и какими тестами покрыты) — в [README прототипа](../../prototype/README.md), раздел «Карта модулей демо (волна 1)».

## Карта экранов и пакетов демо

Источник — `prototype/demo/ext_manifest.mjs` (список пакетов `PACKS`, загрузка динамическим `import()`: отсутствующий или упавший пакет приложение переносит) и [README прототипа](../../prototype/README.md). Базовые разделы, которые знает `app.mjs`: «Обзор», «Купить», «Волны», «Резервы», «Сценарии» (сравнение до трёх), «Лента», «Ассистент» (режим A0), «Данные». Остальные пятнадцать разделов и кнопки навигации регистрируют пакеты через `register(ext)`; пакеты не импортируют `app.mjs`, а запись данных идёт общим путём (`ctx.edit` / `ctx.set_ws`: проверка, пересчёт, журнал, «Отменить»). Контракт для авторов пакетов — `prototype/demo/README_ext.md`.

| Пакет | Экраны, слоты и кнопки | Основные модули `demo/` | Что даёт |
|---|---|---|---|
| `pack_fp03` (FP-03, S1.1, FP-17, FP-29) | «Настройки»; карточки «Запас хода» и «Готовность данных» на «Обзоре» | `settings`, `home_cards`, `number_format`, `as_of`, `settings_defaults`, `decision_currency` | буфер и сдвиг «если хуже», формат чисел и дат, «Сегодня», значения по умолчанию из словаря, валюта решения |
| `pack_fp04` (FP-04) | кнопки «+ Факт», «Сверить остаток», «Отменить», «Вернуть» | `entry`, `anchor_dialog`, `undo`, `entry_memory_store`; `engine/transfer_guard` | быстрый ввод, сверка остатка, единая стопка «Отменить», вопрос о двойном вычитании |
| `pack_fp05` (FP-05, FP-19) | раздел «Данные» (хранение, файл-копия, экспорт, «Удалить все данные») | `store`, `store_idb`, `backup`, `backup_file`, `data_actions`, `data_runtime`, `data_view`, `rights`, `log` | IndexedDB → `localStorage` → память, замок «один писатель», копия и автозапись в файл, экспорт JSON / CSV / hledger, отчёт о правах |
| `pack_fp06` (FP-06, FP-18) | мастер импорта на «Данных» | `import_model`, `import_wizard`, `import_worker`, `import_worker_client`; `data/profiles/*.json` | CSV и hledger, сухой прогон, откат партии, свой CSV Runway, разбор больших файлов в Worker |
| `pack_fp07` (FP-07) | «Конструктор» (`#scenario_lab`); кнопки «Почему так» и «Править волну» на карточке волны (слот `waves.card`) | `scenario_builder`, `wave_edit`, `why_more`; `engine/scenario_ext`, `engine/wave_sweep` | сценарии из операций и чипов, правки волн, «почему» у чисел |
| `pack_fp08` (FP-08, FP-13) | «Формы данных» (`#forms`): платежи, часы, налог, накопления, курсы и обмен, счета, рассрочка, календарь, разовый платёж | `forms`, `form_rule`, `form_hours`, `form_tax`, `form_sinking`, `form_fx`, `form_accounts`, `form_installment`, `form_calendar`, `form_plan`; `engine/tax_hooks`, `sinking_report`, `liquidity`, `installment` | ввод данных пользователя, перенос и своя сумма вхождения |
| `pack_fp09` (FP-09) | «В магазине», «Лестница сумм», «Долги», «Эталон», «Обещаем / не обещаем», «Лист для печати», «Облако: предпросмотр» | `store_mode`, `ladder`, `debts`, `golden_panel`, `promises` (+ `promises.json`), `report`, `hotkeys`, `payload_preview` | витрины и страница обещаний, лист для печати, предпросмотр payload |
| `pack_fp10` (FP-10) | «Старт» (`#start`), «Метрики» (`#metrics`); карточка «Старт» на «Обзоре» | `wizard`, `start_template`, `rule_kit`, `metrics`, `metrics_view` | мастер первых шагов, шаблон-скелет без ставок, метрики на устройстве (`runway-metrics/1`); отдельно — `v0.html` |
| `pack_fp11` (FP-11) | «Сверка» (`#reconcile`), «Качество прогноза» (`#quality`); карточки «Сверка» и «Коридор остатка» | `reconcile`, `quality`, `quality_report`, `prob_band`, `prob_buy`, `focus_keep`; `engine/mc_inputs`, `expected`, `band_adapter` | очередь сверки план↔факт, отчёт backtest на синтетике, вероятности по согласию |
| `pack_fp12` (FP-12) | «О программе» (`#about`) | `about`, `pwa`, `worker_client`, `calc_worker`, `sw.js`, `build_info` (генерируется) | версия и хэш сборки, состояние офлайн-копии, расчёт в Worker |
| `pack_fp14` (FP-14) | блок «Долги в прогнозе» на «Долгах» | `debt_edit`; `engine/debt_ext` | долг входит в прогноз, перенос и досрочное погашение, сверка с банком |
| `pack_fp15` (FP-15) | плашки и карточки экрана «Резервы» (слот `banner.warning`) | `reserve_release`, `reserve_rules`, `alloc_explain`, `rule_age` | «Освободить остаток», срок годности правила, «Как посчитано» |
| `pack_fp16` (FP-16) | подпись курса и формат чисел на экранах прогноза | `rate_chip`, `banner_texts` | «курс … от …», «курс устарел», формат пользователя в ответах, v0 и мастере |
| `pack_fp20` (FP-20) | карточки «Новые вопросы» и «Журнал вызовов» на «Ассистенте»; чип «числа из расчёта c_…» | `assistant_ext`; `engine/call_log` | чип и «почему» у ответов, «что изменилось», журнал вызовов (хэши) |
| `pack_fp21` (FP-21) | флаг «Считать в фоне» в «Настройках», скелет «Считаем…» | `calc_async`, `calc_settings` | расчёт модели набора, «Купить» и списков волн в Worker с откатом на главный поток |
| `pack_fp22` (FP-22) | блок «Сообщить об ошибке» на «Данных» (слот `data.sections`), подписка на события реестра, глобальные ошибки страницы | `metrics_feed`, `error_report_view`, `entry_memory_store`, `log` | ошибка минимума и покрытие из окон прогноза в метрики, отчёт об ошибке без отправки, «последний счёт» между сеансами |
| `pack_fp26` (FP-26) | группа «Ещё» в нижней панели телефона, вторая колонка «Обзора», скелет | `speech`, `nav_more`, `skeleton` | доступность и адаптив |
| `pack_fp28` (FP-28) | слоты `feed.head`, `feed.row`, `buy.form`, `buy.result`, карточка «Куда делись деньги» | `feed_ext`, `fact_fix`, `where_money`, `buy_split`, `shortage`, `ask_button`; `engine/installment_earliest` | «Исправить факт», сообщения о нехватке с ближайшим поступлением, «Разбить на N платежей» |
| `pack_fp29` (FP-29) | профили «часы» и «обмен» в мастере импорта, валюта решения в «Настройках» | `import_v11`, `import_v11_view`, `decision_currency`; `engine/hours_io`, `io_fx_rows` | часы из CSV, обмен двумя ногами, выбор валюты решения |

Открытие чужого файла с карантином записей (`open_quarantine.mjs`, FP-22) подключено из `app.mjs`, а не пакетом. В `ext_manifest.mjs` нет пакетов для FP-17 (его части лежат в `pack_fp03`, `pack_fp05`), FP-18 (в `pack_fp06`), FP-19 (в `pack_fp05`), FP-23 (отдельные страницы замеров), FP-24 и FP-25 (инструменты и тесты), FP-27 (шаблоны для людей в `_ops/people/`), FP-47 и FP-48 (правки существующих модулей). Слоты реестра: `overview.cards`, `reserves.sections`, `data.sections`, `waves.actions`, `nav.actions`, `assistant.extras`, `banner.actions`, `scenarios.after`, `waves.card`, `banner.warning`, `feed.head`, `feed.row`, `buy.form`, `buy.result`; хуки: `scenario_ops`, `show_why`, `boot`, `fmt`, `assistant`, `dataset_label`.

## Наборы данных

| Набор | Что это |
|---|---|
| `data/g001.json` | сквозной пример G-001 «Ян»: `as_of` 2026-10-04, **горизонт 57 дней** (`params.horizon_days = 57`, явно), счёт EUR с якорем 4 000,00 €, четыре правила (аренда, ЖКХ, связь, продукты), поток часов `S-HOURLY`, налоговое правило, два резерва, два сценария (`scn-delay-14`, `scn-treadmill`) |
| `data/g001-low.json` | якорь 2 200,00 €: дефицит волны и `NO` из-за резервов |
| `data/g001-gap.json` | якорь 1 000,00 €: кассовый разрыв |
| `data/g001-late.json` | плановый расход `P-X` −2 500,00 € на 26 ноября (C-058): минимум свободных денег до 19 ноября не меняется, а на всём горизонте уходит в −778,00 € (28 ноября) |
| `data/g001-empty.json` | пустой набор для мастера «Старт»: ни счетов, ни правил, горизонт 57 дней, буфер не задан; проверок числами G-001 на нём нет |
| `data/g001-debt.json` | G-001 плюс одна запись долга `D-LOAN` (FP-14); тест-набор, в выбор наборов демо не входит |
| `data/golden-g001.json`, `data/backtest-report.json`, `data/templates/`, `data/profiles/` | эталон канона для панели «Эталон»; отчёт backtest на синтетике (`tools/backtest_report.mjs`); шаблон-скелет без сумм и ставок; профили CSV как данные (`csv-generic`, `csv-semicolon-dmy`, `runway-csv-1`, `hours-csv-1`, `fx-rows-csv-1`) |
| `data/synthetic-journals/` | детерминированный генератор (`generate.mjs`, счётчиковый хэш из ALG-10) и `manifest.json` с sha256 журналов: 12 «обычных» и 10 «стресс» (клиент платит на 30–60 дней позже) — только для backtest и гейта, **не данные пользователей** |

Ключи `G-001.*` воспроизводятся только при горизонте 57 дней: при 180 в ряд попадают события 7 и 25 декабря, и числа другие — это не ошибка ([стратегия тестирования](11-testing-strategy.md)).

## Как читать тесты

- **Название** = идентификатор из [стратегии тестирования](11-testing-strategy.md) (`TST-48`) и, где есть, вектор страницы алгоритма (`ALG-10 TV-3`); по идентификатору тест находится командой `--test-name-pattern`.
- **Ожидаемые числа** переписаны из канона и страниц дословно и не берутся из вывода движка. Независимые проверки: `tests/oracle.mjs` (медленная проекция день за днём на BigInt, TST-53), BigInt-оракулы в состязательных тестах, `node:crypto` для sha256, `Date` (UTC) для календаря. В тестах допустимы `Date` и `node:*`, в `engine/` — нет.
- **Метки в названиях.** `ADV` — состязательный тест. `БАГ` — тест-улика, написанный против найденной ошибки; в текущем наборе все такие тесты зелёные, то есть ошибки исправлены. `canon_suspect` и `CANON?` — тесты с `{todo}`: ожидание спорно по самому канону, набор они не ломают, но видны в выводе как `✖`.
- **Строки `ℹ` в выводе** — справочные: гейт на синтетических журналах (12 «обычных»: FRR 1 из 117 = 85 bp, cry-wolf 7 из 18 = 3889 bp; 10 «стресс»: FRR 7 из 32 = 2188 bp), отчёт линтера словаря по страницам вики (тест не падает; в прогоне 2026-10-05 он показывал 91 файл, 4 ошибки `we-first` в других страницах вики и 66 предупреждений; числа меняются по мере правки страниц, актуальные даёт `node tools/lint_vocab.mjs`).
- **Общая оснастка** — `tests/helpers.mjs`: `make_rng(seed)` (детерминированный ГПСЧ), `throws_code(fn, code)`, правила G-001 (`g001_rules`, `G001`).
- **Замеры времени** (TST-54 в `tests/timeline.test.mjs`: полный пересчёт p95 ≤ 100 мс, рост при удвоении N) зависят от нагрузки машины. В одном из отдельных прогонов этого файла 2026-10-05 упал один тест; в четырёх повторных запусках файла и во втором полном прогоне падений 0. Какой именно тест упал, не зафиксировано; вероятно, замер TST-54 (вывод): в итогах предыдущего прогона (`_ops/workflow3-result.json`, раздел `fix`) отмечен один такой сбой — 118 мс при бюджете 100 мс. Одиночный красный TST-54 — повод перезапустить файл; стабильное превышение бюджета — уже не шум.

## Как добавить сценарий

**1. Сценарий «что если» в рабочей области (данные).** Добавьте объект в `ws.scenarios`: `{ scenario_id, name, ops: [...] }`. В G-001 использованы `{ op: 'delay_income', event_ref: 'S-HOURLY@2026-11-05', days: 14 }` и `{ op: 'add_purchase', parts: [{ date: '2026-10-12', amount_minor: 30000 }] }`; движок знает также `shift_flow`, `set_amount`, `remove_flow`, `add_flow` и `fx_shock` (подробности — [ALG-02](../algorithms/alg-02-timeline-projection.md)). Посмотреть: `analyze(ws, { as_of, scenario_id })`, команда `node cli.mjs <файл> scenario delay <event_ref> <дней>` или раздел «Сценарии» демо.

**2. Новый эталонный набор данных.** Скопируйте `data/g001.json` в `data/g001-<имя>.json`, измените данные и **задайте `params.horizon_days` явно**. Ожидаемые числа получите независимо от движка (вручную или оракулом `tests/oracle.mjs`), запишите их в тест с идентификатором TST в названии. Чтобы набор появился в демо, добавьте `{ id, file }` в `DATASETS` и строки `ds.<id>` (ru и en) в `demo/i18n.mjs`.

**3. Новый тест.**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../engine/index.mjs';

test('TST-NN краткое описание: ожидаемое число из канона', () => {
  const A = analyze(ws, { as_of: '2026-10-04' });
  assert.equal(A.series.plan.close[27], 205500);   // число — из канона или независимого расчёта, не из вывода движка
});
```

Файл называется `tests/<тема>.test.mjs` и подхватывается `node --test` сам. Если тест нашёл ошибку в движке, не подгоняйте ожидание под код: назовите тест с пометкой `БАГ` или `{todo}` с причиной и опишите расхождение в разделе «Реализация в прототипе» страницы алгоритма. Меняя арифметику, пройдите процедуру «ARITH-CHANGE» (выше).

## Ограничения прототипа

| Область | Чего нет | Что вместо |
|---|---|---|
| Хранилище интерфейса | (после волны 1 есть: IndexedDB, `persist()`, баннер копии, Web Lock, `eraseAll`) нет: проверки на двух настоящих вкладках и поведения Safari и iOS | IndexedDB проверена на фейке и в настоящем браузере (одна вкладка); без IndexedDB — `localStorage`, затем память вкладки |
| Ввод данных в интерфейсе | (после волны 1 есть: «+ Факт», сверка остатка, формы правил, часов, налога, накоплений, курсов, счетов, рассрочки, мастер импорта CSV и hledger; после волны 3а — «Исправить факт», календарь, перенос и своя сумма вхождения, разовый платёж, «Сегодня» в «Настройках», единая стопка «Отменить») нет: «Отменить» для мастера импорта (у него свой «Откатить партию»), записи в налоговый конверт при вводе дохода через «+» (работает для «Выплата получена» и кнопки «Записать в конверт»; решение по связи — владелец, FP-35) | у мастера свои «Откатить партию» и «Снять правку»; доход в конверт пишут форма «Выплата получена» и кнопка «Записать в конверт» |
| Синхронизация и сервер | синхронизации, аккаунтов, серверной базы | local-first без сервера — так задумано для v1; опциональная синхронизация — [ADR-005](../decisions/adr-005-local-first-optional-sync.md), v2 |
| LLM | модели, MCP-сервера, белого списка payload по режимам A2/A3, повтора расчёта по `call_id` (журнал вызовов `assistant.call` — хэши, в памяти вкладки — и экран «Облако: предпросмотр» есть) | режим A0: команды и шаблоны; `answer_question` проверен на заглушках портов |
| Офлайн-оболочка | регистрации сервис-воркера в настоящем браузере (PWA в коде есть: манифест, воркер с проверкой sha256, офлайн-инвентарь; иконки только SVG), прогона офлайн на устройстве | «ноль внешних запросов» проверяется чтением файлов, CSP и тестами на заглушке; проход PWA — люди, `prototype/CHECKLIST-release.md` |
| Реальные данные | журналов добровольцев и юридического ревью (анонимизатор `tools/anonymize.mjs` и отчёт backtest есть) | backtest и гейт REQ-176 работают на синтетических журналах; пакет для ревью собирается из кода (`_ops/people/legal-review-package.md`) |
| Налоги и страны | шаблонов ставок по странам, квартальных авансов | правила — данные пользователя, вид `percent_of_income` |
| Языки | испанского | ru и en |
| Платформы | прогона в браузерных движках | тесты — только Node 24; `Intl` не используется, форматы чисел и дат собственные |
| Статический анализ и сборка | `tsc --checkJs` (компилятора нет, `jsconfig.json` готов) и CI (хостинг не выбран) | воспроизводимая сборка с манифестом хэшей (`tools/build_manifest.mjs`, `tools/verify.mjs`), линтер чистоты `engine/` и проверка графа зависимостей в `purity.test.mjs`, `npm run check` и хук `pre-commit` |
| Проверка по `hledger` | запуска настоящего `hledger` | независимый вычислитель в тесте; синтаксис `--forecast` не проверен (C-042) |

## Что реализовано относительно среза v1

Строки — области таблицы [«Срез v1»](../../_ops/design-brief.md) (§8, [ADR-015](../decisions/adr-015-v1-slice.md)). «Есть» — реализовано в `engine/` и покрыто тестами; «частично» и «нет» — как указано.

| Область | Состав v1 | В прототипе | Сверх среза |
|---|---|---|---|
| Ядро | слои, правила повторения, проекция `close`/`trough`, Q1, режимы `plan`/`worse`, сценарии (delay, purchase, flow), `explain` | **есть** (`timeline`, `recurrence`, `dates`) | `fx_shock` (v1.1), операция `hours` через `scenario_ext` и режим «в магазине» (v1.1) **есть**; режим `expected` в расчёте **нет** (`mode = 'expected'` → `E_SCHEMA`), есть только лаг `expected_lag` и ряд-оценка `expected.mjs` |
| Q2 волны | кластеризация, окно до поступления, `need`, `coverage`, `gap`, ручные split/merge/pin | **есть** (`waves`) | κ и календарь волн по истории — **нет** (v2) |
| Q3 | три ответа, вердикты `OK`/`TIGHT`/`FRAGILE`/`NO`, `S_max`, `earliest_date`, `STS` | **есть** (`afford`) | дробление покупки на части (`parts`, `installment_parts`), рассрочка с процентами и «Разбить на N платежей» **есть**; вероятностный Q3 (`p_fail`, `α`) — по согласию на экране «Качество прогноза» |
| Резервы и налоги | `Reserve`, sinking, налоговый конверт `percent_of_income`, пользовательские платежи | **есть** (`sinking`, `tax`) | квартальные авансы и IVA как данные со схемой — **нет** (v2) |
| Доход | ставка × минуты, диапазон, лаг выплаты, недоработка | **есть** (`hourly`) | импорт часов CSV **есть** (FP-29); автозамена по темпу `rho` (EWMA) и недельный порог переработки — **нет** |
| Валюты | две и более валюты, ручные курсы `spot`, валюта решения, выведенный курс операции | **есть** (`fx`) | `fx_shock`; сценарии `adverse` и пакеты курсов — **нет** |
| Долги | рассрочка (дробление) | **есть** (`debt`: `installment_parts`) | график аннуитета, `prepay`, `reanchor`, долг записывается в прогноз с переносом платежа и сверкой с банком (FP-14) |
| Неопределённость | честные оговорки, вероятностей нет | **есть**: оговорки в шаблонах ответа, вероятности по умолчанию не показываются | seeded Монте-Карло, P10/P50/P90, `p_gap`, калибровка, backtest — **есть** ([ALG-10](../algorithms/alg-10-uncertainty-monte-carlo.md), [ALG-13](../algorithms/alg-13-plan-vs-actual-calibration.md)); в демо вероятности есть только по явному согласию, с пометкой «эксперимент, не обещание» |
| Ввод и вывод | CSV с профилями, сухой прогон, дедупликация, экспорт JSON/CSV/hledger, файл-копия, `eraseAll` | **есть** (`io`; в демо с волны 1 — мастер импорта, экспорт, файл-копия, `eraseAll` с квитанцией) | импорт hledger (подмножество) — **есть**; мастер таблиц, OFX, адаптеры Дзен-мани/CoinKeeper — **нет** |
| Хранение | IndexedDB, `persist()`, баннер копии, Web Lock | **есть в демо с волны 1** (пакет FP-05: IndexedDB → `localStorage` → память, «Продолжить с сохранённого», напоминание о копии, с FP-19 автозапись в выбранный файл); проверено на фейковой IndexedDB и в настоящем браузере (одна вкладка) | две настоящие вкладки, Safari и iOS — не проверялись (REQ-157); шифрованной копии нет |
| AI | A0: команды, кнопки, шаблоны, чип «числа из расчёта c_…», реестр инструментов, верификатор в тестах | **есть**: CLI и раздел «Ассистент» демо; верификатор работает и в рантайме A0; чип и «почему» у ответа, журнал вызовов (хэши) | A1–A3, MCP — **нет**; предпросмотр payload — экран «Облако: предпросмотр» есть, отправки нет |
| Интерфейс | PWA офлайн, «Обзор», лента с «швом сегодня», Q3, «почему», волны, RU+EN, таблица значений, плашки свежести и готовности | **есть** в демо; PWA-оболочка в коде есть, в настоящем браузере не проверялась | ES — **нет**; режим «в магазине» — **есть** |
| Качество | golden G-001, property-инварианты, `arith.lock`, оракул, сверка с hledger, линтеры словаря и обещаний, числа вики из кода, backtest на ≥ 10 журналах добровольцев | **есть**: golden, свойства на 1000 журналах, замки арифметики и вывода движка, мутации, фаззинг, оракул, линтер словаря и реестр обещаний (`promises.json`), метки чисел в таблицах ALG-10…12; **нет**: сверка с настоящим `hledger`, backtest на журналах добровольцев, CI | — |

Итог: из того, что срез v1 относит к ядру и вычислениям, в прототипе нет только того, что требует настоящего браузера, устройств и реальных пользователей (проход PWA, замеры на устройствах, журналы добровольцев, юридическое ревью, настоящий `hledger`); движок для v2 реализован заранее и проверен тестами, но как продуктовое обещание не заявляется.

## Открытые вопросы (тесты `todo`)

**На 2026-11-09 (прогон до правок FP-51)** тестов с пометкой `todo` 28; после правок FP-51 — 20. **На 2026-10-28** тестов с пометкой `todo` 26: четыре спора с самим каноном (ALG-03 инв. 3, ALG-09 инв. 3, идентификатор-инструкция по форме `SAFE_ID`, К-31 — буквальное равенство `state_hash` после отката партии) и 22 недочёта проверок пакетов в файлах `fp*_adv`; перечень и состояние каждого — [стратегия тестирования](11-testing-strategy.md), «Тесты todo и пропуски». Из исходных тринадцати девять закрыты пакетом FP-02 (отметка снята, тест переименован «закрыто FP-02, Q-NN»). Таблица ниже — исходные тринадцать на 2026-10-05, для истории.

Тринадцать тестов `todo` — места, где ожидание тестера спорит с самим каноном; решение за арбитром (разбор с рекомендациями и приоритетами — [находки прототипа](16-prototype-findings.md)):

| Файл | Суть | Где описано |
|---|---|---|
| `adversarial/semantics` ×6 | инвариант ALG-03 для последовательности правок; потеря номинальной даты прошлого месяца в ALG-05; ограничение `plan_to_date` темпом в ALG-07; одиночная нога перевода и нулевой остаток в чужой валюте в ALG-02 и D-20; оценка накопленного округления в ALG-09 | страницы [ALG-02](../algorithms/alg-02-timeline-projection.md), [03](../algorithms/alg-03-payment-waves-detection.md), [05](../algorithms/alg-05-sinking-funds.md), [07](../algorithms/alg-07-hourly-income.md), [09](../algorithms/alg-09-debt-amortization.md) |
| `adversarial/verifier_io` ×7 | ссылочный стиль Markdown, знаки минус вне набора, символы форматирования и идентификаторы-инструкции в верификаторе; разделитель тысяч в `parse_amount_cell`; `state_hash` после отката партии; формулы в идентификаторных колонках CSV | [ALG-12](../algorithms/alg-12-llm-tool-contract-and-number-verifier.md), [ALG-14](../algorithms/alg-14-hledger-export-csv-import.md) |

## Связанные страницы

- [Стратегия тестирования](11-testing-strategy.md) — TST-01…60, G-001, гейт релиза; [требования](02-requirements.md) — REQ-109, REQ-170, REQ-177; [модель данных](04-data-model.md); [архитектура](05-architecture.md); [дорожная карта](10-roadmap.md); [глоссарий](14-glossary.md)
- ADR: [ядро на JS](../decisions/adr-001-core-js-library.md), [деньги в minor units](../decisions/adr-002-money-minor-units.md), [календарные даты](../decisions/adr-003-civil-dates.md), [журнал и проекции](../decisions/adr-004-event-journal-projections.md), [подход к тестированию](../decisions/adr-014-testing-approach.md), [срез v1](../decisions/adr-015-v1-slice.md)
- Алгоритмы: [ALG-01](../algorithms/alg-01-recurrence-expansion.md), [ALG-02](../algorithms/alg-02-timeline-projection.md), [ALG-03](../algorithms/alg-03-payment-waves-detection.md), [ALG-04](../algorithms/alg-04-can-i-afford.md), [ALG-05](../algorithms/alg-05-sinking-funds.md), [ALG-06](../algorithms/alg-06-tax-envelope.md), [ALG-07](../algorithms/alg-07-hourly-income.md), [ALG-08](../algorithms/alg-08-fx-conversion.md), [ALG-09](../algorithms/alg-09-debt-amortization.md), [ALG-10](../algorithms/alg-10-uncertainty-monte-carlo.md), [ALG-11](../algorithms/alg-11-safe-to-spend.md), [ALG-12](../algorithms/alg-12-llm-tool-contract-and-number-verifier.md), [ALG-13](../algorithms/alg-13-plan-vs-actual-calibration.md), [ALG-14](../algorithms/alg-14-hledger-export-csv-import.md)
