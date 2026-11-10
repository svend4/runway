# Запросы FP-09 к владельцам общих файлов

Автор: FP-09 (витрины на готовом движке). Дата: 2026-10-05. Код — `prototype/demo/` (`pack_fp09.mjs`, `debts.mjs`, `store_mode.mjs`, `ladder.mjs`, `golden_panel.mjs`, `promises.mjs` + `promises.json`, `report.mjs`, `hotkeys.mjs`, `payload_preview.mjs`, `i18n/showcase.mjs`, `css/showcase.css`), `prototype/data/golden-g001.json`; тесты — `prototype/tests/showcase.test.mjs` (42) и `promises.test.mjs` (12).
Общие файлы (`app.mjs`, `i18n.mjs`, `index.html`, `style.css`, `ext.mjs`, `tests/demo.test.mjs`) пакет не правил: всё подключено через реестр (семь экранов `store ladder debts golden promises report payload`, слоты `assistant.extras` и `nav.actions`).

## 1. Интегратор: необязательные правки

1. **Манифест.** `ext_manifest.mjs` уже перечисляет `pack_fp09`; пакет грузится без правок. Если интегратор сократит манифест до существующих файлов, `pack_fp09` оставить.
2. **Горячая клавиша «T» (Настройки).** Таблица `HOTKEYS` в `hotkeys.mjs` содержит переход на экран `settings` (пакет FP-03, `title_key = settings.nav`). Если FP-03 не подключён, клавиша ведёт на пустой маршрут, подпись в списке клавиш показывается ключом. Решение: либо оставить (FP-03 в сборке есть), либо интегратор убирает строку `KeyT` из `HOTKEYS`.
3. **Реестр обещаний и документы.** `promises.json` — единственный источник страницы «Обещаем / не обещаем»; зеркало `REGISTRY` в `promises.mjs` проверяет `tests/promises.test.mjs`. Координатору: когда в вики появятся измерения (REQ-153 и др.), строки обновляются парой «правка `promises.json` + `REGISTRY`»; срок годности измерения 90 дней проверяет `node tools/lint_vocab.mjs --registry`.
4. **Файловые маршруты и CSP.** Страница не читает `data/golden-g001.json` (сеть разрешена только `app.mjs`): значения эталона продублированы в `GOLDEN` (`golden_panel.mjs`), равенство двух копий проверяет тест. Если FP-01 разрешит пакетам чтение статических данных через `ctx`, зеркало можно убрать.

## 2. Замечания по канону

- `debt.drift_tol_bp = 50` — гипотеза v2 (`vocab.json`); экран «Долги» показывает допуск и берёт его из `params['debt.drift_tol_bp']`, если он задан в рабочей области (граница 0…10000 есть в `ws_edit.mjs`).
- Цель «ответ в магазине не более 1 с» остаётся целью до замера на эталонном устройстве: на экране печатается замер на устройстве читателя (на машине разработки ≈ 0,06 мс на вызов `store_model`).
