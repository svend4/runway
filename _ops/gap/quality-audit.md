# Аудит качества и «хвостов» тестирования (Runway, 2026-10-05)

Область: 13 `todo` + 1 `skip`, P0/P1/P2 из `wiki/product/16-prototype-findings.md`, `_ops/workflow3-result.json`, `tests/adversarial/*`, `wiki/product/11-testing-strategy.md`. Проверка — по коду и запуском. Машинный список: `quality-backlog.json` (35 пунктов: P0 — 5, P1 — 15, P2 — 15; усилие S — 25, M — 10, L — 0). Ничего в `prototype/`, `wiki/`, `raw/`, `data/`, `tools/` и каноне не менялось; пробные скрипты жили в scratchpad.

## 1. Что подтверждено запуском

| Проверка | Результат |
|---|---|
| `node --test` по `adversarial/semantics`, `adversarial/verifier_io`, `io.test.mjs` | 359 тестов: 345 pass, 0 fail, 1 skipped, 13 todo. Все 13 `todo` по-прежнему красные внутри (`not ok … # TODO`), `skip` — оракул hledger |
| `which hledger` / `where hledger` | не найден; Docker в PATH есть (`…/Docker/resources/bin`) |
| `calibration.lag_observations` с ключом потока `__proto__`, `constructor`, `toString` | `TypeError: Cannot read properties of undefined (reading 'push')` (шире, чем в findings: любой ключ `Object.prototype`) |
| `backtest.replay_state`, факт с `entity_id = '__proto__'` | `reduce` ключ сохраняет, `replay_state` молча теряет (`Object.hasOwn → false`) |
| `timeline.rule_statuses`, правило `__proto__` | ключ пропадает без ошибки; `constructor`, `toString` — работают |
| `parse_amount_cell('12,50', {decimal:'.', thousands:','}, 2)` | 125000 (1250,00); `'1,2,3.50'` → 12350; `'12.50'` при `decimal=','`, `thousands='.'` → 125000 |
| `verify_text` при evidence +47000 | `'остаток ‐470,00 €'` (U+2010) → `[]`; `'‮470,00 €'` → `[]`; `'[r]: //evil.example/x'`, `'![a][r]'`, `'evil.example/pixel.png'` → `[]`; `'остаток девятьсот девяносто девять'` → `[]`; `'в минус 470,00 €'` → `[]` |
| `analyze` на G-001 с `horizon_days` 200 000 | 37 с; 3 000 000 → `E_BAD_DATE` за 0,75 с; верхнего предела нет |
| `analyze` с `rules[0].interval = 0` / `tax_rules[0].rate_bp = 99999` | один невалидный объект роняет весь расчёт (`E_RULE_INVALID`) |
| Журнал 36 500 `tx.posted`: `reduce` / `state_hash` | 0,92 с / 1,65 с (один прогон, одна машина) |

## 2. Реестр открытых `todo`/`skip` (14)

| # | Тест (файл:строка) | TST | Что сломано | Куда править | Backlog |
|---|---|---|---|---|---|
| 1 | semantics:353 | 37 | код корректен; тест закрепляет опровергнутый инвариант | тест → «известное ограничение» | Q-23 |
| 2 | semantics:451 | 23 | `contribution_dates` не рассматривает месяц до `start` | `sinking.mjs:64-67` | Q-18 |
| 3 | semantics:1059 | 25 | `plan_to_date` без зажима темпом | `hourly.mjs:343` | Q-19 |
| 4 | semantics:1336 | 27 | одиночная нога перевода исключается молча | `fx.mjs:231-237,253`, `timeline.mjs:725-734` | Q-01 |
| 5 | semantics:1342 | 27 | нулевой остаток в чужой валюте требует курс | `fx.mjs:286` | Q-16 |
| 6 | semantics:1465 | 26 | тест проверяет опровергнутую гипотезу; код уже зажимает | тест → гарантии К-12 | Q-24 |
| 7 | verifier_io:227 | 46 | ссылочная разметка, `//host`, голый домен | `verifier.mjs:592` | Q-04 |
| 8 | verifier_io:231 | 45 | глифы минуса, слова | `verifier.mjs:528,633-638` | Q-02 |
| 9 | verifier_io:237 | 45 | символы Cf | `verifier.mjs:573` | Q-03 |
| 10 | verifier_io:1113 | 51 | разделитель тысяч без проверки групп | `io.mjs:134` | Q-05 |
| 11 | verifier_io:1440 | 32 | `state_hash` после отката включает `imports` | `ledger.mjs:170` (опция) | Q-21 |
| 12 | verifier_io:1599 | 43 | id-колонки CSV без защиты от формул | `io.mjs:648` | Q-10 |
| 13 | verifier_io:2657 | 46 | `SAFE_ID` проверяет форму, не содержание | `tools.mjs:67,89-92` (режим псевдонимов) | Q-11 |
| 14 | io.test.mjs:762 (skip) | 44 | оракул hledger не запускался | запасной запуск + `lint_hledger` | Q-14 |

Из 14: реальные дефекты кода — 9 (№ 2–5, 7–10, 12); тест надо переписать при исправном коде — 3 (№ 1, 6, 11); остаточный риск ADR-013 — 1 (№ 13); среда — 1 (№ 14).

## 3. P0 (5 пунктов) — числа и вывод могут молча стать неверными

**Q-01. Одиночная нога перевода** (П-17, К-15). `fx.to_decision_events` (231-237) считает перевод внутренним, если все ноги, которые ВИДНЫ в переданных событиях, лежат на operating-счетах; нога без пары видна как «все ноги operating». Дополнение `external_transfer_ids` (`timeline.mjs:725-734`) ловит только ноги на неоперационных счетах. Исправление — считать ноги по `transfer_id` и пометить одиночный перевод внешним, плюс предупреждение. Новый код в `vocab.json` — только после решения владельца. Тест: снять `todo` (semantics:1336), контроли: пара operating+operating по-прежнему исключается; три ноги; golden без изменений. Усилие S.

**Q-02. Знак минус.** `SIGN = '[-−–]'` (`verifier.mjs:528`) и сравнение знака (`match_quantity` 686/696) делают неотрицательным всё, что не распознано. Исправление — проход 5b: другие глифы минуса, минус через пробел и слова «минус/в минус/negative» → `ambiguous`. Тест — 8 строк из `verifier_io:231` плюс property «глиф минуса в каждом PASS-векторе V1–V14». S.

**Q-03. Символы Cf.** Нет прохода по `\p{Cf}`. Исправление — проход 0 в `extract_quantities` (`kind: 'markup'`) и быстрая проверка в `check_structure`. Оговорка: ZWJ в эмодзи тоже отвергается (К-26 это допускает, решение владельца). S.

**Q-04. Ссылочная разметка.** Проход 1 (`verifier.mjs:592`) знает `[..](..)`, `![..](..)`, URL со схемой/`www.`, `<тег>`. Добавить ссылки-определения, ссылочные формы, `//host`, голый домен с путём; решение владельца по голому домену без пути. Тест: `verifier_io:227` плюс замер времени (линейность, как D-05) и 0 ложных срабатываний на шаблонах каталога. S.

**Q-05. `parse_amount_cell`.** Строка 134 `t.split(thousands).join('')` без проверки групп. Исправление — проверка «группы ровно по три цифры», иначе `null` (reject `bad_amount`). Тест: `verifier_io:1113`; `1.234,50` (ES) и `1,234.50` без изменений; фаззинг. S.

## 4. P1 (15 пунктов)

| Backlog | Суть | Где | Усилие |
|---|---|---|---|
| Q-06 | числительные словами без единицы проходят верификатор («девятьсот девяносто девять») | `verifier.mjs:643` | S |
| Q-07 | класс «ключ из `Object.prototype`» вне `ledger`: `lag_observations` (падает), `replay_state` и `rule_statuses` (теряют запись), `scenario_fx_shock`; `flow_calibration` без валидации входа | `calibration.mjs:365-376`, `backtest.mjs:209-211`, `timeline.mjs:103,415-418` | M |
| Q-08 | `on_posted_income` / `on_posted_payment` (ALG-06) не реализованы: проведённый доход не порождает аллокацию; `reserve_open` читает только записанное, `backtest` досчитывает налог на лету — слои расходятся | `tax.mjs`, `sinking.mjs:87-99`, `backtest.mjs:121-138` | M |
| Q-09 | `W_RESERVE_BEHIND` без `missed_count`, `missed_minor` (C-030) | `index.mjs:139`, `app.mjs:900-906` | S |
| Q-10 | id-колонки CSV без защиты от формул | `io.mjs:648` | S |
| Q-11 | `SAFE_ID` по форме: идентификатор-инструкция в `Result` (режим псевдонимов, опция) | `tools.mjs:67,89-92,451-454` | M |
| Q-12 | нет диапазонов параметров: `horizon_days` 200 000 → 37 с; `lag_pool` создаёт массив длины `delay + 1`; `tools.max_calls` до 2^53 | `timeline.mjs:634`, `montecarlo.mjs:194-195`, `tools.mjs:1009-1010` | S |
| Q-13 | TST-54 покрыт частично: нет журнала 36 500 (≈ 2,6 с на `reduce` + `state_hash`), холодного старта, публикации p50/p95 | `timeline.test.mjs:1013`, новый `bench.mjs` | M |
| Q-14 | оракул hledger не запускался; запасной запуск через Docker и чистый `lint_hledger` | `io.test.mjs:754-774` | M |
| Q-15 | нет построителя `fx_obs_bp` из `ws.rates`; демо и CLI не вызывают `montecarlo`/`lag_observations`/`backtest` | `montecarlo.mjs:222,348-361` | M |
| Q-16 | нулевой остаток в чужой валюте → `E_NO_RATE` | `fx.mjs:286` | S |
| Q-17 | `Override.set_amount` без проверки знака и нуля | `recurrence.mjs:344-345` | S |
| Q-18 | `contribution_dates` теряет номинал прошлого месяца (влияет на `W_RESERVE_BEHIND` и `contribution_allocations`) | `sinking.mjs:64-67` | S |
| Q-22 | слоя записи нет; один невалидный объект валит весь `analyze` — режим карантина | `ledger.mjs:471`, новый `writer.mjs` | M |
| Q-31 | решения владельца К-1…К-41 (К-12, К-18, К-39, К-4, К-15, К-25, К-26) блокируют закрытие todo | `_ops/design-brief.md §15` | S |

## 5. P2 (15 пунктов, кратко)

Q-19 (зажим темпом, отдельная ветка для закрытого периода), Q-20 (`reserve_open_ex`: что отброшено и сколько обрезано), Q-21 (`state_hash` с `omit: ['imports']`), Q-23 и Q-24 (переписать два `todo` без правки кода), Q-25 (`FUZZ_N`, ночной прогон 10^5), Q-26 (мутатор ≥ 30 мутантов), Q-27 (CI/pre-commit и скрипты `test:fast`, `test:nightly`), Q-28 (`window_metrics` через `floor_div`), Q-29 (`E_SCHEMA target_missing`), Q-30 (`W_HOURS_KEY_IGNORED` в реестр после К-39), Q-32 (мелочи демо: подпись горизонта, подложка «узкой точки», цели касания, сообщение для суммы ≤ 0), Q-33 (регрессионная сеть демо на уровне модели и smoke в браузере), Q-34 (открытые вопросы ALG-13: TIGHT, коридор p10–p90, анонимизация REQ-176), Q-35 (метки TST, комментарий `debt.mjs:157`, README).

## 6. Особо запрошенные пункты — итог

| Пункт | Статус | Доказательство |
|---|---|---|
| Одиночная нога перевода | нет (открыт, P0) | `fx.mjs:253`, todo `semantics:1336`, Q-01 |
| Слепые зоны верификатора: минус / Cf / ссылочная разметка | нет (P0) | запуск `verify_text`; todo `verifier_io:227,231,237`; Q-02…Q-04 |
| `parse_amount_cell` «12,50» → 1250,00 | нет (P0) | запуск → 125000; `io.mjs:134`; Q-05 |
| Белый список идентификаторов | частично: вне формы — псевдоним, содержание не проверяется | `tools.mjs:89-92`; todo `verifier_io:2657`; Q-11 |
| Класс `__proto__` в `calibration.lag_observations` / `timeline.rule_statuses` / `flow_calibration` | частично: `ledger` закрыт (A-01…A-04, D-08), остальное открыто | запуск; `calibration.mjs:365-367`, `timeline.mjs:415-418`, ещё `backtest.mjs:209-211`; Q-07. `flow_calibration` работает с массивами: по ключам не уязвим, но падает `TypeError` на не-массиве |
| `on_posted_income` / `on_posted_payment` | нет | `grep` по `engine/`: нет; запись только в `generate.mjs:169,181`; Q-08 |
| `W_RESERVE_BEHIND` без чисел | частично (предупреждение есть, чисел нет) | `index.mjs:139`; Q-09 |
| `fx_obs_bp` | частично: движок читает, построителя нет | `montecarlo.mjs:222,348-361`; Q-15 |
| Оракул hledger (TST-44) | частично: тест и мини-вычислитель есть, настоящий hledger не запускался | `io.test.mjs:761`; Q-14 |
| Производительность TST-54 | частично: p95 пересчёта и масштабирование проверяются, остальные цели нет | `timeline.test.mjs:1013`; замер журнала; Q-13 |

## 7. Что проверить до начала работ

1. Оценка 36 500 записей — один прогон на одной машине; повторить в `bench.mjs` (Q-13) перед выводами.
2. Запуск hledger через Docker не пробовался: нужны наличие Docker-демона и образа (имя образа не проверялось).
3. Мелкие наблюдения демо (Q-32, Q-33) взяты из findings и не перепроверялись.
4. Классы ошибок Q-07 найдены перебором `= {}` и `??=` по `engine/`; сквозной тест `proto_keys.test.mjs` найдёт остальные.
5. Граничные значения Q-12 — предложение К-4, не решение владельца.

## 8. Порядок работ (всё аддитивно)

1. Волна 1 (≈ 1–1,5 дня, S): Q-01…Q-05, Q-16, Q-18, Q-10 — снимают 8 из 13 `todo`, все P0.
2. Волна 2 (≈ 2–3 дня): Q-12, Q-07, Q-22, Q-08, Q-09 — устойчивость к чужому файлу, слой записи, налоговые аллокации.
3. Волна 3: Q-13, Q-14, Q-25…Q-27 — измерения, оракул, CI.
4. По решению владельца: Q-11, Q-15, Q-17, Q-30, Q-31, Q-34.

## Связанные страницы

- [16-prototype-findings.md](../../wiki/product/16-prototype-findings.md), [11-testing-strategy.md](../../wiki/product/11-testing-strategy.md), [15-prototype-guide.md](../../wiki/product/15-prototype-guide.md)
- [design-brief.md](../design-brief.md), [canon-decisions.md](../canon-decisions.md), [workflow3-result.json](../workflow3-result.json), [tst-coverage.json](../tst-coverage.json)
- [quality-backlog.json](quality-backlog.json)
