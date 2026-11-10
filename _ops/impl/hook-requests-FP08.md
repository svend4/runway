# Запросы FP-08 к владельцам общих файлов

Автор: FP-08 (формы данных: правила, часы, налог, накопления, курсы, счета, рассрочка). Дата: 2026-10-06.
Код — `prototype/demo/` (`pack_fp08.mjs`, `forms.mjs`, `form_rule.mjs`, `form_hours.mjs`, `form_tax.mjs`, `form_sinking.mjs`, `form_fx.mjs`, `form_accounts.mjs`, `form_installment.mjs`, `i18n/forms.mjs`, `css/forms.css`)
и `prototype/engine/` (`tax_hooks.mjs`, `sinking_report.mjs`, `liquidity.mjs`, `installment.mjs`); тесты — `prototype/tests/` (`forms.test.mjs` 42, `tax_hooks.test.mjs` 11, `sinking_report.test.mjs` 12, `liquidity.test.mjs` 7, `installment.test.mjs` 7).
Общие файлы (`app.mjs`, `i18n.mjs`, `index.html`, `style.css`, `ext.mjs`, `tests/demo.test.mjs`, `tests/purity.test.mjs`) пакет не правил: всё подключено через реестр
(экран `forms`, слоты `reserves.sections` и `data.sections`, пять видов правок `register_edit`). Манифест `ext_manifest.mjs` уже перечисляет `pack_fp08` — править не нужно.

## 1. Интегратор: желательные правки

1. **Запись в конверт при вводе дохода («+»).** Правка `add_fact` из быстрого ввода (FP-04, `entry.mjs → commit_entry`) записывает факт, но не запись `allocation.recorded` по налоговому правилу.
   Вместо этого пакет FP-08 даёт вид правки `record_posted_allocations` (`{type, event_ids?}`, идемпотентна). Предложение: в `commit_entry` после `add_fact` дохода (или платежа с `reserve_id`)
   добавить в ту же цепочку правку `{type: 'record_posted_allocations', event_ids: [id нового факта]}` — тогда факт и аллокация идут одним `set_ws` и одной единицей «Отменить».
   Пока этого нет, такие факты видны на экране «Резервы» в карточке «Проведено, но в конверт не записано» с кнопкой «Записать в конверт» (REQ-064), а выплата по потоку часов
   («Часы» → «Выплата получена») пишет факт и аллокацию вместе (`post_income`).
2. **Число и сумма в тексте `W_RESERVE_BEHIND`.** Предупреждение уже несёт `missed_count` и `missed_minor` (`engine/index.mjs`), а общий текст `warn.W_RESERVE_BEHIND` в `i18n.mjs` их не использует.
   Предложение для `app.mjs → warning_text(w)`: для `W_RESERVE_BEHIND` брать строку с числами («Взносов не подтверждено: {count} на сумму {sum}») — формулировка уже есть в пакете (`forms.sink_behind`).
   Карточка «Накопления: план взносов» на экране «Резервы» показывает числа сама.
3. **«Отменить / Вернуть» для записей FP-08.** Пакет пишет через `ctx.set_ws` и в стопку отмены FP-04 не попадает (`deps.undo` создаётся внутри `pack_fp04.mjs` и наружу не выходит): отмена после записи формы
   вернёт отказ «данные изменились после этого действия». Если нужен единый «Отменить», достаточно, чтобы `register` пакета FP-04 возвращал/публиковал `deps.undo` (например `ctx.undo`), и формы FP-08 вызывали бы `undo.record(before, after, meta)`
   перед `ctx.set_ws`, как это делает `commit_entry`. Журнал при этом уже следует за правками, откат записей — отдельная от этого задача.
4. **Слои в `tests/purity.test.mjs`.** Четыре новых модуля `engine/` (`tax_hooks`, `sinking_report`, `liquidity`, `installment`) вне карты рангов `RANK/SPECIAL` — проверяются чистота и импорты, но не ранги.
   Фактические зависимости: `installment` → `money, dates, debt`; `liquidity` → `money, dates, fx, sinking, timeline`; `sinking_report` → `money, dates, sinking, timeline`;
   `tax_hooks` → `money, dates, tax, fx, sinking, timeline, ledger`. Если интегратор захочет строгие ранги, это четыре строки в `SPECIAL`; модули опираются на `sinking` (ранг 4) и `timeline` (ранг 3), `index` они не импортируют, циклов нет.
5. **Реэкспорт из `engine/index.mjs`.** Новые модули `engine/` намеренно не реэкспортируются (как `transfer_guard`, `scenario_ext`): демо импортирует их напрямую; `index.mjs` не менялся.
6. **Документы.** Для `prototype/README.md` и `wiki/product/15-prototype-guide.md` (карта модулей): `engine/` — `tax_hooks` (ALG-06 оболочки), `sinking_report` (ALG-05 отчёт), `liquidity` (REQ-018 «запас»), `installment` (REQ-044, REQ-192);
   `demo/` — семь модулей форм и `pack_fp08.mjs`. Приёмка FP-08 и числа тестов — в отчёте агента; обновить `_ops/tst-coverage.json` (TST-20…24, 26, 27, 28, 29, 30 теперь есть и в тестах форм).

## 2. Замечания по канону и поведению

- **`recorded_at` и подтверждение правила.** «Подтвердить правило» добавляет версию (REQ-065: прошлые не правятся) с `valid_from = сегодня`, `reviewed_at = сегодня`, тем же `ttl_days` и
  `recorded_at = max(сегодня T12:00:00Z, recorded_at прошлых версий)`: порядок версий движок определяет по `recorded_at`, затем по номеру. Часов в приложении нет, поэтому время записи — условное.
- **Аллокации по фактам не позже `funded_as_of`.** `reserve_open` игнорирует аллокации с датой не позже `funded_as_of` резерва (они уже в `funded_start`); `pending_posted_allocations` такие факты в список «не записано» не включает.
  На G-001 (`funded_as_of = as_of = 2026-10-04`) выплата, проведённая сегодня, в конверт отдельной записью не идёт — она уже в начальном состоянии.
- **Проведённый доход и применимость правила.** Правило применяется к факту по `stream_id` или `tag` из `applies_to` (C-025). Факты набора G-001 несут `tag = S-HOURLY`, а не `stream_id`, и правилу `applies_to.stream_ids = [S-HOURLY]` не соответствуют;
  выплата, внесённая формой «Выплата получена», `stream_id` задаёт. Если интегратор захочет сопоставлять и такие факты, сопоставление по метке `tag` нужно описать в каноне (сейчас это `applies` в `engine/tax.mjs`).
- **Параметр `crypto.liquidity_bp`.** Доля крипты в запасе берётся из поля счёта `liquidity_bp` (по умолчанию 0, REQ-080); параметр рабочей области `crypto.liquidity_bp` по-прежнему нигде не читается (К-17).
- **`fx.stale_days`.** Читается из параметров рабочей области через `flat_params` (значение по умолчанию живёт в таблице параметров движка), литерала в коде форм нет.
- **Исключение вхождения.** Вид правки `set_occurrence_override` пишет запись `ws.overrides` (`rule_id`, `nominal_date`, `action`: `skip` / `move` / `set_amount`); мост `ws_bridge` переносит её в `override.set`, возврат — `revert`.
  Номинальная дата обязана быть настоящим вхождением правила (проверка `nominal_dates`), иначе `E_SCHEMA`.

## 3. Для FP-10 (мастер «Старт») и других потребителей

Чистые сборщики правок без DOM можно использовать повторно: `build_rule_edit`, `build_stream_edit`, `build_tax_edits`, `build_sinking_edit`, `build_rate_edit`, `build_exchange_edit`, `build_account_edits`, `build_installment`
(все принимают тексты полей и окружение `{cur, lang, nf, as_of}`, возвращают `{ok, edit(s)}` или `{ok: false, error: {code, ctx}}` без повтора введённого). Запись — `forms.commit_edits(ctx, edits, reason)`.
