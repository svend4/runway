# Запросы FP-02 к владельцам общих файлов

Автор: FP-02 (движок: P0-хвосты и устойчивость к чужому файлу). Дата: 2026-10-05. Код — `prototype/engine/`, тесты — `prototype/tests/`.
Правила слоёв: `validate_ws.mjs` и `warnings_ext.mjs` НЕ реэкспортируются из `engine/index.mjs` (импортируются напрямую; `validate_ws` стоит выше `index`).

## 1. Интегратор: служебные предупреждения в интерфейсе (`demo/app.mjs` → `warning_text`, `demo/i18n.mjs`)

Движок теперь выдаёт предупреждения, которых нет в `vocab.json` (реестр закрыт решением К-39, `purity.test.mjs` считает ровно 16 кодов):

| Код | Где выдаётся | Поля |
|---|---|---|
| `W_TRANSFER_UNPAIRED` | `analyze(...).warnings` (одиночная нога перевода, Q-01) | `transfer_id` |
| `W_HOURS_KEY_IGNORED` | `analyze(...).warnings` (уже выдавался, Q-30) | `stream_id`, `key` |
| `W_PARAM_OUT_OF_RANGE`, `W_RECORD_QUARANTINED` | `analyze_checked(...).warnings` (карантин) | `key` / `kind`, `id`, `rec_code` |

Тексты RU/EN и список полей — `engine/warnings_ext.mjs` (`ext_warning_text(w, locale)`, `is_ext_warning`, `split_warnings`). Просьба: в `warning_text` для кода из `is_ext_warning` брать `ext_warning_text`, а не общий «warn.other»; идентификатор показывать отдельной строкой через `textContent`. Если владелец примет К-39 и К-15, коды переезжают в `vocab.json` (тогда в `purity.test.mjs` меняется число 16, а `warnings_ext.mjs` опустеет).

## 2. Интегратор: числа в `W_RESERVE_BEHIND` (Q-09, REQ-069)

Предупреждение теперь несёт `missed_count` (целое) и `missed_minor` (деньги в валюте решения); прежние поля `code`, `reserve_id` не менялись. Просьба: в `demo/i18n.mjs` добавить пару ключей `warn.W_RESERVE_BEHIND_n` (RU: «Взносов не подтверждено: {n} на сумму {sum}.», EN: «Contributions not confirmed: {n}, {sum} in total.») и в `warning_text` выбирать их, когда `missed_count` есть; `{sum}` — через общий формат денег. Тест TST-56 (паритет ключей и плейсхолдеров) проверит пару.

## 3. FP-01 / интегратор: проверка при записи и при открытии чужого файла

- `demo/ws_edit.mjs` (владелец FP-01) — одна строка, как просил FP-01 (раздел 2 его запроса). Сигнатура:
  `validate_ws(ws, {as_of?, limits?}) → {ok, errors: [{code, kind, index, id, field, reason, path}], warnings, truncated, read_only, stats}`; `code` — из набора REQ-017; значения полей в ошибках не называются. Для параметров при записи `params.set`: `assert_params(params)` (бросает `E_SCHEMA` с `{key, why}`), для правок сумм вхождений: `recurrence.validate_override(o, rule)`.
- Открытие файла-копии/рабочей области (FP-05, FP-06): сначала `validate_journal(journal)` (формат, версии, `read_only` для `runway-journal/N` выше известной) и `validate_ws(ws)`; расчёт — `analyze_checked(ws, query, {quarantine: true})` вместо `analyze`: всегда `{ok: true, analysis, rejected, warnings}` либо `{ok: false, code, errors}` без исключений; `rejected` — перечень исключённых записей (kind, index, id, codes) для плашки «N записей не прошли проверку».
- Диапазоны параметров К-4 (`PARAM_RANGES`) — предложение, границы подтверждает владелец; даты чужого файла ограничены 1900-01-01 … 2200-12-31 (иначе `as_of = 10^9` дней считался бы вечно).

## 4. FP-01: `reduce(events, base, {own: true})` — сделано

Опция из раздела 1 запроса FP-01 добавлена в `engine/ledger.mjs`: третий аргумент `{own: true}` — база принадлежит вызывающему, не клонируется и меняется на месте; без опции поведение прежнее (`base` не мутируется). Тест: `tests/hardening.test.mjs` (TST-16, 300 журналов). Обход в `journal_log.mjs` можно упростить в удобный момент.

## 5. Координатор: таблицы и документы, которые нельзя править пакетам

- `prototype/README.md`: число тестов, файлов с тестами (было 29: добавлены `hardening`, `proto_keys`, `validate_ws`, `defaults_sync`), `todo` (было 13, стало 3: остались `semantics` ×2 — П-13 и П-16 — и `verifier_io` ×1 — П-30), карта модулей (`validate_ws.mjs`, `warnings_ext.mjs`), раздел «Ограничения».
- `wiki/product/16-prototype-findings.md`: закрыты (с оговорками в notes отчёта) П-14 (К-11), П-15 (К-10), П-17 (К-15), П-18 (К-16), П-23 (К-31), П-24 (К-32), П-25 (К-24), П-26 (К-25), П-27 (К-26), П-29 (К-33), П-32 (К-4, частично); П-30 (К-n ADR-013) остаётся открытым; К-n «ждёт решения» не закрыты решениями — реализованы как предложенные.
- `_ops/tst-coverage.json`: пересобрать — в названиях новых тестов есть TST-16, 23, 25, 27, 31, 32, 35, 38, 43, 45, 46, 49, 51, 54, 55, 56, 57, 60 и REQ-010, 014, 016, 017, 019, 055, 068, 069, 077, 091, 093, 094, 095, 130, 131, 158.
- `_ops/gap/quality-backlog.json`: закрыты Q-01, Q-02, Q-03, Q-04, Q-05, Q-06, Q-07, Q-09, Q-10, Q-12, Q-16, Q-17 (проверка; поведение движка — по К-5), Q-18, Q-19, Q-20 (`reserve_open_ex`), Q-21, Q-22 (`validate_ws` вместо `writer.mjs`), Q-28, Q-29, Q-30 (служебный реестр); открыты Q-08, Q-11, Q-13…Q-15, Q-23…Q-27, Q-31…Q-35.
- Ночной прогон (Q-25): `FUZZ_N=100000 GP_SEEDS=1500 node --test` (bash) или `$env:FUZZ_N='100000'; $env:GP_SEEDS='1500'; node --test` (PowerShell). Скрипт `test:nightly` в `package.json` не добавлялся: переменные окружения в npm-скриптах несовместимы между оболочками (нужен `cross-env` или node-обёртка — это зависимость).
