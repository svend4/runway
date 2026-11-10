# Запросы FP-01 к владельцам общих файлов

Автор: FP-01 (каркас записи и расширений). Дата: 2026-10-05. Документация каркаса — `prototype/demo/README_ext.md`.

## 1. FP-02 (engine/ledger.mjs): свёртка без клонирования базы

`reduce(events, base)` клонирует `base` через `JSON.parse(canon(base))` при каждом вызове. На состоянии 36 500 фактов (≈ 6 МБ канонического JSON) один вызов стоит ≈ 2 с, то есть «снимок + хвост» через `reduce(хвост, снимок)` не быстрее полной свёртки (измерено: 1,9 с полная, 2,0 с с большой базой на хвосте из 500 записей).

Обход в `demo/journal_log.mjs`: в `reduce` отдаётся маленькая «частичная база» (только сущности, которых касается хвост), результат вливается обратно по ключам. Совпадение с полной свёрткой проверяет `tests/journal_log.test.mjs` (TST-16, 1000 случайных журналов + 300 пошаговых).

Просьба (необязательная, ломает ничего): добавить в `reduce` третий аргумент `{own: true}` — «база принадлежит вызывающему, не клонировать, мутировать на месте». Тогда `fold_tail` в `journal_log.mjs` сводится к одному вызову, а копирование корзин при снимке исчезает (сейчас ≈ 20 мс на снимок на 18 000 фактов).

Попутно найденная особенность (для `todo`/канона, не ошибка FP-01): послепроход `reduce` по `matches` зависит от порядка ключей, а клон базы через `canon` сортирует ключи. Если факт привязан и по ключу (`entity_id`), и по `event_id` записи, победитель в `reduce(events, base)` может отличаться от победителя в `reduce(events)`. В `journal_log.mjs` такой случай отправляется на полную свёртку. Предложение канону: `match.set.fact_event_id` — только `event_id` записи `tx.posted`; форма «по ключу факта» в `reduce` (`Object.hasOwn(s.facts, fid)`) — запасная и в журнал не пишется.

## 2. Интегратор / FP-02: подключить `validate_ws`

Когда появится `engine/validate_ws.mjs`, в `demo/ws_edit.mjs` одной строкой подключается общая проверка результата правки:

```js
import { validate_ws } from '../engine/validate_ws.mjs';
register_validator((ws) => { const r = validate_ws(ws); if (!r.ok) throw new RunwayError(r.errors[0].code, r.errors[0]); });
```

(сигнатуру уточнить по реализации FP-02). Файл `ws_edit.mjs` принадлежит FP-01; прошу интегратора сделать это в фазе C или написать мне. Пока проверки — внутри `ws_edit.mjs` (`check_model`) и пересчёт страницей с откатом при отказе `analyze`.

## 3. Координатор: таблицы и реестры, которые нельзя править пакетам

- `prototype/README.md`, `wiki/product/15-prototype-guide.md`: в карту модулей и структуру каталога добавить `demo/ext.mjs`, `dom.mjs`, `ws_edit.mjs`, `ws_bridge.mjs`, `ids.mjs`, `journal_log.mjs`, `ext_manifest.mjs`, `README_ext.md`; тесты `tests/ext.test.mjs`, `ext_boot.test.mjs`, `ws_edit.test.mjs`, `ws_bridge.test.mjs`, `journal_log.test.mjs`, `journal_gen.mjs` (вспомогательный). Число тестов в README пересчитать после общего прогона.
- `wiki/product/05-architecture.md`: «расширения — чистые модули вне карты слоёв `engine/`» (риск из 18-implementation-gap-analysis), демо-слой: `app.mjs → ext.mjs → ws_edit/ws_bridge/journal_log/ids`, пакеты не импортируют `app.mjs`.
- `_ops/tst-coverage.json`: пересобрать — в названиях новых тестов есть TST-16, TST-38, TST-54, TST-56, TST-59 и REQ-012, 014, 017, 094, 153.
- Запись REQ-094 «10^3 журналов»: `tests/io.test.mjs` проверяет 400 журналов `import_json(export_json(...))`; на 10^3 журналах проверяется свёртка «снимок + хвост» (`journal_log.test.mjs`, TST-16) и круг `ws → журнал → ws` на четырёх наборах (`ws_bridge.test.mjs`). Если нужен именно 10^3 для `state_hash(import(export(x)))`, поднять число в `io.test.mjs` (файл FP-02).

## 4. Заметки для авторов пакетов (не запросы)

- Пакеты фазы B пишут только через `ctx.edit` или `apply_edit` + одно `ctx.set_ws` (пачка правок за один пересчёт: например, импорт сотен строк — цикл `apply_edit`, затем один `set_ws(ws_итог, {reason: 'import'})`; откат партии — `set_ws(ws_до)`).
- Журнал `ctx.journal` — проекция правок: хранение и файл-копия (FP-05) берут `journal.export()` и `ws_to_journal(ws)`; импорт CSV/hledger (FP-06) использует записи `io.import_commit` и добавляет их `journal.append_event(...)` либо переводит строки в факты через `add_fact`.
- Новые тексты проходят `node tools/lint_vocab.mjs`; в комментариях демо не писать слово «безопасность» и формулировки из `vocab.json → forbidden_phrases` (тест ищет подстроку, см. README_ext.md).
