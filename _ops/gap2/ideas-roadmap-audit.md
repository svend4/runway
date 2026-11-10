# Повторный аудит идей и дорожной карты (2026-10-10)

Режим: только чтение (код прототипа и вики не менялись; тесты и серверы не запускались). Первый аудит: `_ops/gap/ideas-audit.md` (2026-10-05, до волн). Что сделано с тех пор: волна 1 (FP-01…FP-09), этап S1, волна 2 (FP-10…FP-12) — приёмки `_ops/impl/wave1-acceptance.md`, `wave2-acceptance.md`. Расчёт по введённым данным и правилам, не консультация.

Источники идей: `wiki/ideas/new-ideas.md` (IDEA-01…99; номера 55 и 59 не заняты), `wiki/ideas/better-than-budget-guru.md` (UP-01…39), `wiki/ideas/red-team-critique.md` (pre-mortem, слабые места, «Чего нельзя обещать», критерии остановки). Дорожная карта: `wiki/product/10-roadmap.md`, `wiki/product/17-start-plan.md`. Обе страницы дорожной карты имеют `updated: 2026-10-05` и после волн не обновлялись (см. раздел 5).

## Метод и правила оценки

- «Реализовано» (implemented) = есть код И тест, который это проверяет (путь + функция/тест). Нет теста — partial. Если требование про экран, а есть только движок, — partial.
- Приёмки волн не принимались на веру: для каждой идеи проверено существование файла и функции в `prototype/` (Grep по `export`), имена тестов (Grep по `REQ-NNN`/`TST-NN` в `tests/*.test.mjs`). Браузерная проверка 2026-10-10 (координатор) — `wiki/product/16-prototype-findings.md`, раздел «Проверка волны 2 в браузере»: мастер, метрики, `v0.html`, сверка, качество, полоса, «Удалить все данные», «О программе» проверены глазами; **PWA в браузере не проверено**.
- Статус идеи оценивается по идее целиком (включая части, отложенные на v1.1/v2). Если решение каталога ограничило объём фазой и этот объём сделан, это сказано в колонке «Остаток». Из-за такого строгого чтения четыре идеи, считавшиеся реализованными в первом аудите «в объёме решения», переведены в partial без регресса кода: IDEA-06, 49, 71, 73 (в таблице помечены «пересмотр»).
- Пути относительно `C:/xampp/htdocs/01/301/runway/prototype/`. Размер: S ≤ 0,5 дня, M 1–2 дня, L 3+ дня. Предложения аддитивны (новые файлы/экраны/функции). `needs_owner` = true, если нужно решение владельца (канон v1.2, политика вероятностей, юридические формулировки, платформа/сервер, внешние сервисы, деньги/лицензии); вопрос назван.
- Срез: фаза из решения каталога (v0, v1, v1.1, v1.x, v2, v3, «—» если идея слита/отклонена/не код).

## 1. Итоги

| Статус | IDEA (97) было → стало | UP (39) было → стало | Всего (136) |
|---|---:|---:|---:|
| implemented | 37 → **63** | 12 → **26** | 89 |
| partial | 37 → **18** | 18 → **10** | 28 |
| missing | 16 → **9** | 9 → **3** | 12 |
| rejected (слито/отклонено) | 4 → 4 | 0 → 0 | 4 |
| not_code | 3 → 3 | 0 → 0 | 3 |

Изменилось статусов: 53 — улучшились 49 (IDEA: 26 partial→implemented, 4 missing→implemented, 3 missing→partial; UP: 10 partial→implemented, 4 missing→implemented, 2 missing→partial), пересмотрены вниз 4 (IDEA-06, 49, 71, 73, см. выше). Не изменились 83.

Главное: почти всё, что в первом аудите звучало как «движок есть, демо не показывает», теперь показывается и пишется через общий путь `ctx.edit`/`ctx.set_ws` (формы, мастер, сверка, импорт, хранение, сценарии, «почему», витрины). Остались: (а) то, что отложено каталогом на v1.1/v2/v3 и требует сервера, денег, людей или юридических решений; (б) проверки, которых не было (PWA в браузере, реальные журналы, устройства, `tsc`, оракул hledger); (в) небольшие аддитивные хвосты (S): редактор календаря, подпись курса на экранах прогноза, производные метрики, генератор меток `num:`.

Сводка по срезу (что осталось не implemented):

| Срез | Осталось |
|---|---|
| v0 | IDEA-96 сделан (`demo/v0.html`); не сделано само испытание спроса (30 приглашённых) — процесс, и счётчики критерия № 1 на самой странице `v0.html` (нет хранилища) |
| v1 | IDEA-06 (редактор праздников), 50 (подпись курса на экранах прогноза), 51 (PWA не проверено в браузере, PNG-иконок нет, REQ-152/167 не измерены), 54 (производные метрики), 82 (`tsc` не запускался), 95 (нет реальных журналов), 99 (7 меток `num:`), 90 (перенос `W_*` из расширения в `vocab.json` — канон v1.2) |
| v1.1 | IDEA-32 (мастер таблиц), 41 («куда делись деньги»), профили Дзен-мани/CoinKeeper (IDEA-33), испанский (IDEA-49), привязка резерва к счёту (REQ-191, часть IDEA-40) |
| v1.x | IDEA-98 (нет `LICENSE`, публикации хэшей, плана «если разработчик исчез») |
| v2 | IDEA-17, 20 (adverse), 47, 48, 68 (авто-копия в файл, sync), 69, 71 (A1–A3), 72, 73 (MCP), 78, 87, 93 |
| v3 | IDEA-86 |

## 2. Таблица IDEA-01…99

Колонки: ID · название · срез · было (10-05) · стало · доказательство (файл `функция`; тест) · остаток и предложение (размер) · needs_owner. Сокращения статусов: I = implemented, P = partial, M = missing, R = rejected, N = not_code.

| ID | Название | Срез | Было | Стало | Доказательство | Остаток и предложение | needs_owner |
|---|---|---|---|---|---|---|---|
| IDEA-01 | Три слоя событий | v1 | I | I | `engine/ledger.mjs` `reduce`, `effective_events`; `engine/timeline.mjs` `build_events_ex`, `apply_scenario`; `tests/ledger.test.mjs`, `tests/adversarial/semantics.test.mjs` TST-31/36 | — | нет |
| IDEA-02 | Сопоставление план↔факт с допуском | v1 | P | **I** | `demo/reconcile.mjs` `reconcile_model`, `edit_set_match`; `engine/calibration.mjs` `match_plan_to_fact`; `tests/reconcile.test.mjs` (28; REQ-031/032), `reconcile_boot.test.mjs` (4); браузер 10-10: на `late` после сдвига «Сегодня» 17 просроченных, «Пропустить» 17→16, «Отменить» 16→17 | После «Отменить» привязки `state_hash` журнала отличается (остаётся пустая запись `matches`; рабочая область и `inputs_hash` точны) — вопрос канона К-31 | нет (мелочь для канона) |
| IDEA-03 | Жизненный цикл ожидаемого | v1 (условный лаг v2) | I | I | `engine/timeline.mjs` `eff_date`; `engine/calibration.mjs` `assign_statuses`; `tests/calibration.test.mjs`, `timeline.test.mjs` TST-41; статусы в `demo/reconcile.mjs`; ряд-оценка `engine/expected.mjs` (`expected.test.mjs`, 6) | Условный лаг («просрочено на k дней → распределение») не сделан (v2) | нет |
| IDEA-04 | Гражданские даты и якоря | v1 | I | I | `engine/dates.mjs`; `engine/timeline.mjs` `anchor_status`; `tests/dates.test.mjs` TST-15, `purity.test.mjs` (нет `Date`) | — | нет |
| IDEA-05 | Правила повторения, ключ вхождения | v1 | I (движок) | I | `engine/recurrence.mjs` `expand_rule`, `occ_key`; UI: `demo/form_rule.mjs` `build_rule_edit`, `rule_preview`, `skip_edit`; `tests/forms.test.mjs` (REQ-032 ×6), `recurrence.test.mjs` TST-11…14 | — | нет |
| IDEA-06 | Конец месяца, праздники, n-й рабочий день | v1 | I (движок) | **P** (пересмотр) | `engine/dates.mjs` `make_calendar`, `nth_business_day`, `shift_by_policy`; форма правила даёт политику выходных (`WEEKEND_POLICIES`), день месяца, n-й день | Среди видов правок `ws_edit.mjs` нет `upsert_calendar` (Grep `upsert_calendar|add_calendar` = 0): праздники пользователя задаются только файлом; `form_rule.mjs:71` берёт первый календарь. Предложение: вид правки `upsert_calendar` + блок «Праздники» в форме правила (S–M) | нет |
| IDEA-07 | Два ряда close и trough | v1 | I | I | `engine/timeline.mjs` `project`, `answer_q1`; `tests/timeline.test.mjs` TST-01/35; `demo.test.mjs` TST-58 | — | нет |
| IDEA-08 | Инварианты, property-тесты, детерминизм | v1 | I | I | `tests/adversarial/golden_properties.test.mjs`; `tests/oracle.mjs`; новое: `tools/mutate.mjs` (61 мутация, убито 59, `_ops/mutation.json`), `tools/fuzz_nightly.mjs` (короткий режим, 137 тестов), `tests/lock_policy.test.mjs` | Полный фаззинг 10⁵ и property на 10³ журналах (REQ-171/172) не запускались | нет |
| IDEA-09 | Волны платежей | v1 | P | **I** | `demo/wave_edit.mjs` `plan_merge`, `plan_split`, `plan_pin`, `apply_override`; слот `waves.card` (`demo/pack_fp07.mjs`); `tests/wave_edit.test.mjs` (TST-37, REQ-036), `waves_card.test.mjs` (22), `s1_5_adv.test.mjs` (17) | Параметры волн (g, S, θ) — гипотеза до ≥ 10 журналов (REQ-188) | да: журналы добровольцев |
| IDEA-10 | Метрики волны | v1 | I | I | `engine/waves.mjs` `wave_metrics`; `demo.test.mjs` TST-37 REQ-107 | — | нет |
| IDEA-11 | «Могу ли я купить?» | v1 | I | I | `engine/afford.mjs` `check_purchase`, `verdict_of`; `afford.test.mjs` TST-04 | — | нет |
| IDEA-12 | Максимум и ранняя дата | v1 | I | I | `engine/afford.mjs` `max_amount`, `earliest_date`; `afford.test.mjs` TST-05; `demo/ladder.mjs` `ladder_model` | — | нет |
| IDEA-13 | Буфер и режимы | v1 | P | **I** | `demo/settings.mjs` `buffer_model`, `worse_model`; `engine/timeline.mjs` `buffer_hint`, `outflow_90`; `tests/settings.test.mjs` (REQ-026 ×6: подсказка = `buffer_hint`, 0 = «задан»; REQ-024: задержка «если хуже»); браузер 10-10: буфер 500,00 € в мастере | — | нет |
| IDEA-14 | Покупка как план платежей: рассрочка | v1 (проценты v1.1) | P | **I** | `engine/installment.mjs` `installment_plan`, `purchase_from_parts`; `demo/form_installment.mjs`; `tests/installment.test.mjs` (REQ-192: [20706×5, 20705]), `forms.test.mjs` | Переключателя «разбить на N платежей» прямо на экране «Купить» нет: рассрочка живёт в «Формы данных» (S) | нет |
| IDEA-15 | Safe-to-spend, резервы, без двойного счёта | v1 | P | **I** | `engine/transfer_guard.mjs` `check_transfer`; `demo/entry.mjs` (запрос о двойном вычитании); `tests/transfer_guard.test.mjs` (X12 REQ-063 ×3); `W_RESERVE_BEHIND` с числом: `engine/sinking_report.mjs` `reserve_behind_detail`, `tests/wave1_integration.test.mjs` REQ-069 | Критерий REQ-063 «после согласия funded 50000» ждёт решения владельца (wave1-acceptance, п. 9) | да: канон, сценарий перевода на дату `funded_as_of` |
| IDEA-16 | Налоговый конверт | v1 | I | I | `engine/tax.mjs`; `demo/form_tax.mjs` `build_tax_edits`, `rule_banner`; `engine/tax_hooks.mjs`; `tests/tax_hooks.test.mjs` (TST-23: 2 790,00 € × 20 % = 558,00 €), `forms.test.mjs` REQ-067 | Быстрый ввод «+» не пишет запись в конверт (у факта нет потока/метки; wave1-acceptance FP-08 partial) | да: сопоставление дохода по метке `tag` (C-025) |
| IDEA-17 | Квартальные авансы, IVA | v2 | M | M | Grep `quarter|IVA|tax_calendar` в `engine/`, `demo/`: 0 | Предложение: `engine/tax_calendar.mjs` — календарь налоговых сроков как данные пользователя (дата, сумма, `reviewed_at`, `ttl_days`), без ставок (S–M) | да: юридическое ревью, REQ-068/072 |
| IDEA-18 | Почасовой доход с лагом выплаты | v1 | P | **I** | `engine/hourly.mjs` `gross_pay`, `shortfall`; `demo/form_hours.mjs` `build_stream_edit`, `shortfall_model`; карточки `fp08_taxhours`, `fp08_shortfall` (`demo/pack_fp08.mjs`); `tests/forms.test.mjs` (REQ-075/108: 80/93/110 ч → 2 400/2 790/3 300 €; «недоработка 8 ч» = 240,00 €), `hourly.test.mjs` TST-10/25/26 | Фактические часы вводятся отдельной правкой (`edit_set_stream_hours`); ρ по EWMA нет (по решению) | нет |
| IDEA-19 | Мультивалютность | v1 | I (движок) | I | `engine/fx.mjs`; UI: `demo/form_fx.mjs` `build_rate_edit`, `build_exchange_edit`; `tests/forms.test.mjs` (REQ-077/078/079), `fx.test.mjs` TST-27/28 | — | нет |
| IDEA-20 | Политика курса и сценарий курса | v1 (spot), fx_shock v1.1, adverse v2 | P | P | чип «курс ±N bp»: `demo/scenario_builder.mjs` (`fx_shock`, `chip_fx_up/down`); `tests/scenario_builder.test.mjs` (REQ-051 ×5) | Политика `adverse` нет (v2). Предложение: `engine/fx_adverse.mjs` — только после решения | да: политика курса и юридические формулировки (REQ-081) |
| IDEA-21 | Sinking funds | v1 | I | I | `engine/sinking.mjs`; `engine/sinking_report.mjs` (план взносов, «цель достигнута», `reserve_behind_detail`); `demo/form_sinking.mjs`; `sinking.test.mjs` TST-20/21/22, `sinking_report.test.mjs` (12) | — | нет |
| IDEA-22 | Долги и рассрочки с ре-якорением | v1.1/v2 | P | **I** | `demo/debts.mjs` `prepay_compare`, `reanchor_check` (экран `#debts`); `engine/debt.mjs`; `tests/showcase.test.mjs` (TST-29 REQ-082 ×5), `debt.test.mjs` | — | нет |
| IDEA-23 | Сценарии, дельта-слои | v1 | P | **I** | `demo/scenario_builder.mjs` (`OP_KINDS`: 7 операций); `tests/scenario_builder.test.mjs` (TST-33 REQ-049 ×6); `engine/timeline.mjs` `apply_scenario` | `hours` не сохраняется в набор (v1.1; `engine/scenario_ext.mjs` дает операцию только как расширение, wave1-acceptance п. 9) | да: хранение `hours` в сценарии |
| IDEA-24 | Монте-Карло с seed | v2 (в прототипе да) | P | **I** | `engine/band_adapter.mjs` `mc_band`; `demo/prob_band.mjs` (согласие `runway-prob-consent/1`, выключено по умолчанию); `tests/prob_band.test.mjs` (20), `band_adapter.test.mjs` (11), `montecarlo.test.mjs` (38); браузер 10-10: коридор P10/P50/P90, «n = 3: доля процентом не показывается» | Политика вероятностей — предварительное решение координатора, не владельца | да: подтвердить политику (ADR-008/015) |
| IDEA-25 | Вероятностный Q3 (α) | v2 | P | **I** | `demo/prob_buy.mjs` `compute_buy`; `engine/band_adapter.mjs` `mc_buy`; `tests/prob_band.test.mjs` (оценка помечается устаревшей после смены набора возмущений) | то же | да (как IDEA-24) |
| IDEA-26 | Подача диапазонов без паники | — | R | R | слито с IDEA-46 | — | нет |
| IDEA-27 | Калибровка по факту | v2 | P | **I** | `engine/mc_inputs.mjs` `payment_habits` (n ≥ 10); `demo/quality.mjs` `habits_model`; `tests/mc_inputs.test.mjs` (11), `quality_report.test.mjs` (17) | — | нет |
| IDEA-28 | Бэктест «как знали тогда» | v2 | P | **I** | `tools/backtest_report.mjs` (`--check`), `data/backtest-report.json`; `demo/quality.mjs` `report_rows`; `tests/quality_report.test.mjs`, `backtest.test.mjs` TST-55; браузер 10-10: 22 журнала с пометкой «синтетика» | см. IDEA-95 | нет |
| IDEA-29 | Объяснимость | v1 | P | **I** | `demo/why_more.mjs` `narrowest_why`, `wave_why`, `sts_why`, `verdict_why`; `tests/why_more.test.mjs` (REQ-104: сумма строк + «Остальное» = просадке 217000); кнопки на карточке волны | «Почему» не у каждого числа ленты (S) | нет |
| IDEA-30 | Персоны, JTBD | v1 | N | N | `wiki/product/01-personas-jtbd.md` | — | — |
| IDEA-31 | Первые 10 минут | v1 | P | **I** | `demo/wizard.mjs` `render_start`; `demo/home_cards.mjs` `readiness_model`; `tests/wizard.test.mjs` (29: готовность 1→1→1→2→3→4 на `g001-empty`), `start_boot.test.mjs`; браузер 10-10 | Время «за N минут» не заявляется (нет замера); медиана ввода ≤ 5 с на ≥ 5 людях (REQ-090) не измерена | да (люди) |
| IDEA-32 | Мастер миграции из таблиц | v1.1 | M | M | Grep `unpivot|sheet_` 0 | Предложение: `engine/sheet_unpivot.mjs` + шаг мастера импорта (L) | да: образцы реальных таблиц пользователей |
| IDEA-33 | Импорт Дзен-мани, CoinKeeper, hledger | hledger v1.1; остальное v2 | P | P | hledger: `demo/import_model.mjs` (`HL_REASONS`), `demo/import_wizard.mjs`; `tests/import_model.test.mjs` (REQ-099 ×5); профили только `data/profiles/csv-generic.json`, `csv-semicolon-dmy.json` | Профили Дзен-мани и CoinKeeper — данные `data/profiles/*.json` (S каждый), OFX (v2) | да: образцы реальных экспортов (колонки не подтверждены) |
| IDEA-34 | Стартовые шаблоны | v2 | M | **P** | `data/templates/freelancer-skeleton.json` (`rate_bp: null`, `ttl_days`, `reviewed_at: null`), `demo/start_template.mjs`; `tests/wizard.test.mjs` (REQ-068 ×2, зеркало = файл) | Шаблоны по странам намеренно не делаются (риск консультации, REQ-068) | да: юридически, если когда-либо |
| IDEA-35 | Демо без регистрации, эталон | v1 | P | **I** | `demo/golden_panel.mjs` `golden_rows`, `data/golden-g001.json`; `tests/showcase.test.mjs` (REQ-109 ×3 + экран: восемь значений канона, все «совпало») | — | нет |
| IDEA-36 | Экран «Обзор» | v1 | I | I | `demo/app.mjs` `build_chart`; `demo.test.mjs` TST-58 | — | нет |
| IDEA-37 | Экран «Купить» | v1 | I | I | `demo/app.mjs` `view_buy`; `demo.test.mjs` REQ-044/091 | — | нет |
| IDEA-38 | Единая лента, недельная сверка | v1 | P | **I** | быстрый ввод `demo/entry.mjs` `prepare_entry`, `build_entry_edit` («+ Факт»); сверка остатка `demo/anchor_dialog.mjs`; недельная сверка — экран `#reconcile`; `tests/entry.test.mjs` (REQ-090 ×8: 3 поля, 3 действия), `reconcile.test.mjs` | **Дефект текста**: лента всё ещё показывает «В демо лента только для чтения: внесение фактов и сверка не включены» (`demo/i18n.mjs:378`, `app.mjs:1477`), хотя оба есть. Введённый факт нельзя править (README «Ограничения»). Предложение: убрать `fd.demo_note`, дать «Исправить факт» через `void_fact` + `add_fact` (S) | нет |
| IDEA-39 | Календарь волн | v1 | I | I | `demo/app.mjs` `calendar_block`; `demo.test.mjs` TST-37 | — | нет |
| IDEA-40 | Счета по ликвидности | v1 | P | **I** | `demo/form_accounts.mjs` `build_account_edits`, `liquidity_model`; `engine/liquidity.mjs`; `tests/liquidity.test.mjs` (REQ-018: запас 145000; REQ-080 крипта неликвидна), `forms.test.mjs` | Привязка резерва к счёту (`backed_by_account_id`, REQ-191, v1.1): `ws_edit.mjs` проверяет, формы создают только `null` (`form_tax.mjs:93`, `form_sinking.mjs:57`). Предложение: выбор счёта в форме резерва + ветка в `engine/` (M) | нет |
| IDEA-41 | Бюджет слоями и резервы | v1.1 | P | P | `demo/why_more.mjs` `sts_why` (разложение «можно потратить» с платежами по группам) | Диаграммы «куда делись деньги» (остаток = резервы + буфер + платежи + свободно) нет. Предложение: карточка из `sts_breakdown` (S) | нет |
| IDEA-42 | Налоги и часы: экран | v1 | P | **I** | карточки `fp08_taxhours`, `fp08_shortfall` на «Резервы» (`demo/pack_fp08.mjs`); `tests/forms.test.mjs` | — | нет |
| IDEA-43 | Сценарии слоями: экран | v1 | I | I | `demo/app.mjs` `view_scenarios`; `demo.test.mjs` REQ-049 | — | нет |
| IDEA-44 | Режим «нехватка денег» (ходы) | — | R | R | отклонено каноном (заменено IDEA-93); факты о нехватке в UI | — | нет |
| IDEA-45 | «Почему так»: экран | v1 | I | I | `demo/why_more.mjs`; `demo/app.mjs` `show_why` | — | нет |
| IDEA-46 | Честные диапазоны: язык и округление | v1 (правило), показ v2 | I | I | `engine/montecarlo.mjs` `present_probability`; `engine/calibration.mjs` `wilson`; `demo/prob_band.mjs` `present_text`; `montecarlo.test.mjs` TST-49; реестр обещаний `prob_not_promise` | — | нет |
| IDEA-47 | Оповещения с бюджетом внимания | v2 | M | M | Grep `VCALENDAR|\.ics|Notification` 0 | Предложение: `engine/ics.mjs` + кнопка «Экспорт волн в .ics» (локально, без сети) (S) | да: допустим ли локальный `.ics` вместо пушей (page 18, «Волна 3») |
| IDEA-48 | Семья: общий бюджет, роли | v2 | M | M | Grep `export_snapshot` 0 | Предложение: «Снимок для партнёра» — `export_snapshot` с хэшами вместо имён (S) | да: ADR о передаче ключей/ролях (REQ-116) |
| IDEA-49 | Языки RU, EN, ES; локаль данных | v1 RU/EN; ES v1.1 | I | **P** (пересмотр) | `demo/i18n.mjs` `LANGS = ['ru','en']`; формат чисел отдельно от языка: `demo/number_format.mjs`, `tests/settings.test.mjs` (REQ-112 «ru + 1.234,50 €»); паритет ключей TST-56 | Испанского нет (M): каталоги `es` для 12 `demo/i18n/*.mjs` + шаблоны верификатора | да: кто переводит и вычитывает (REQ-113) |
| IDEA-50 | Мультивалютный UX | v1 | P | P | `demo/form_fx.mjs` `rate_signature`, `convert_with_signature`, `stale_banner`; `tests/forms.test.mjs` (REQ-077/079: «курс 0,9250 от 2026-10-04», курс 45 дн. — устарел) | Подпись курса и возраста — только в «Формы данных → Курсы». На «Обзоре/Купить» стоит общая строка `warn.W_RATE_STALE` без числа (`demo/i18n.mjs:163`). Предложение: подпись через хук `fmt` в строке пересчёта (S) | нет |
| IDEA-51 | PWA, офлайн, быстрый ввод, доступность | v1 | P | P | `demo/sw.js`, `demo/pwa.mjs` `create_pwa`, `demo/manifest.webmanifest`, `demo/icons/*.svg`; `tests/pwa.test.mjs` (23), `offline_inventory.test.mjs` (7: 0 сетевых вызовов в сценариях), `build_manifest.test.mjs` (11), `contrast.test.mjs` (8); быстрый ввод — IDEA-38 | **В настоящем браузере не проверено** (встроенный браузер не принимает скрипты воркера); PNG 192/512 нет (решение № 4: только SVG); REQ-152 (холодный старт офлайн ≤ 2 с на трёх устройствах) не измерен — `_ops/bench.json` снят в Node; REQ-167 (клавиатура, 200 %, скринридер) — только структура на заглушке DOM. Предложение: пройти `CHECKLIST-release.md` в Chrome/Edge (S, люди) | да: устройства, ручной проход, PNG-иконки |
| IDEA-52 | Бизнес-модель | v2 | N | N | `wiki/decisions/adr-015-v1-slice.md` | — | да: модель дохода и привязка оплаты (REQ-182) |
| IDEA-53 | Обещаем и не обещаем | v1 | P | **I** | `demo/promises.json` (24 строки: 16 promise, 8 non_promise), `demo/promises.mjs` `validate_registry`, экран `#promises`; `tests/promises.test.mjs` (12; REQ-184); `tools/lint_vocab.mjs --registry demo/promises.json` — 0 ошибок (приёмки волн 1 и 2) | Юридическое ревью (REQ-183) и вычитка RU/EN не выполнены — помечено строкой `human_review_pending` | да: люди/юрист |
| IDEA-54 | Метрики успеха без слежки | v1 (на устройстве) | M | **P** | `demo/metrics.mjs` `create_metrics`, `validate_package`; `demo/metrics_view.mjs` (экран `#metrics`, файл `runway-metrics/1` целиком до скачивания); `tests/metrics.test.mjs` (19); браузер 10-10 | Производные метрики из `13-metrics.md` не считаются (Grep `d28|honest_week|anchor_stale_share|backup_gap_share` = 0): d7/d28, activation_7d, северная звезда, доля устаревших якорей, доля без копии. Поля пакета отличаются от плана `17-start-plan.md` §6.5 (`age_days`, `readiness_max`, `activated`, `q3_opened` нет). Предложение: `demo/metrics_derive.mjs` — чистая функция из локальных данных (M) | да: рабочие определения §6.5 → запись `decision` |
| IDEA-56 | Выход без боли: экспорт, удаление | v1 | P | **I** | `demo/data_actions.mjs` `export_journal_copy`, `export_csv_file`, `export_hledger_file`, `erase_all`, `erase_preview`; `tests/data_actions.test.mjs` (33; TST-38 REQ-094, TST-43/44 REQ-095/096, REQ-098 ×5); браузер 10-10: квитанция, сторожевые записи целы | Облачное удаление (v2) нет | нет |
| IDEA-57 | Предпросмотр для ассистента | v2 | P | **I** | `demo/payload_preview.mjs` (`PREVIEW_TOOLS`, `origin_call`; экран `#payload`); `tests/showcase.test.mjs` (REQ-131 ×5, REQ-132 ×2) | Предпросмотр строится из результатов инструментов, не из `verifier.payload_for`; облачных режимов нет, так что он ничего не предваряет | нет |
| IDEA-58 | Режим «в магазине» | v1.1 | M | **I** | `demo/store_mode.mjs` `store_model`, `timed_store` (`STORE_TARGET_MS` = 1000); `tests/showcase.test.mjs` (REQ-052 ×5) | — | нет |
| IDEA-60 | Local-first ядро и порты | v1 | I | I | `tests/purity.test.mjs` (нет `Date`/`Intl`/`fs` в `engine/`; 102 теста); `engine/index.mjs` `analyze` | — | нет |
| IDEA-61 | Хранилище и PWA | v1 | M | **I** | `demo/store.mjs` (`persist()`, Web Lock, `BroadcastChannel`), `demo/store_idb.mjs`, `demo/backup.mjs` (баннер); `tests/store.test.mjs` (13; REQ-122: два писателя по 1000 записей → один `state_hash`; сбой на 5-м из 10 откатывает), `tests/fake_idb.mjs`; вручную одна вкладка 2026-10-06 | Две вкладки, Safari/iOS, `localhost:80` не проверялись (REQ-157) | да (устройства, люди) |
| IDEA-62 | Журнал событий и сущности | v1 | I | I | `engine/ledger.mjs` `make_event`; демо пишет в журнал: `demo/ws_bridge.mjs` `sync_journal`, `demo/journal_log.mjs`; `tests/ws_bridge.test.mjs` (TST-38 ×4 набора), `journal_log.test.mjs` (TST-16, 10³ журналов) | — | нет |
| IDEA-63 | Проекции, canon, inputs_hash | v1 | I | I | `engine/ledger.mjs` `canon`, `inputs_hash`, `state_hash`; подвал демо | — | нет |
| IDEA-64 | Undo/redo без перезаписи | v1 | P | **I** | `demo/undo.mjs` `diff_unit`, `apply_unit` (единая стопка, лимит `UNDO_LIMIT`); `tests/undo_all.test.mjs` (43), `undo_fix.test.mjs` (24), `s1_3_adv.test.mjs` (12); `entry.test.mjs` | Мастер импорта вне стопки (свой «Откатить партию»); `state_hash` журнала после отмены первого `set_param` отличается (журнал не умеет снимать ключ) — вопрос канона | да (мелочь, канон) |
| IDEA-65 | Идемпотентный импорт и откат партии | v1 | P | **I** | `demo/import_model.mjs`, `demo/import_wizard.mjs` `render_wizard`, `render_batches`; `tests/import_model.test.mjs` (TST-42: 152 → 138 · 2 · 12), `import_wizard.test.mjs` (TST-43), `hardening.test.mjs` (TST-32 REQ-093 с опцией omit imports) | Буквальное равенство полного `state_hash` после отката — `todo` (К-31) | да: канон К-31 |
| IDEA-66 | Версионируемые правила, две оси времени | v1 (known_at v2) | I | I | `engine/tax.mjs` `rule_at(…, known_at)`; `tax.test.mjs` TST-24 | — | нет |
| IDEA-67 | Миграции схемы: апкастеры | v1 | I | I | `engine/ledger.mjs` `upcast`; фикстуры формата `tests/fixtures/FIXTURES.json`, `journal-v1.json`; `tests/build_manifest.test.mjs` (REQ-187: импорт даёт заявленный `state_hash`) | — | нет |
| IDEA-68 | Синхронизация и бэкап | v1 файл-копия; v2 sync | P | P | `demo/backup.mjs` `backup_due` (50-я запись / 7-й день), `backup_banner`; `tests/backup.test.mjs` (REQ-097 ×4) | Автокопия в выбранный файл (File System Access API) нет (Grep `showDirectoryPicker` 0): `demo/backup_fs.mjs` (M). Sync — v2, нужен сервер | да для sync (сервер, ADR-005); нет для файла |
| IDEA-69 | E2E-шифрование WebCrypto | v2 | M | M | Grep `AES-GCM|PBKDF2|crypto.subtle` — только `demo/sw.js` (SHA-256 файлов оболочки) | Предложение: «Зашифрованная копия» `demo/crypto_copy.mjs` (M–L) | да: ADR на KDF (параметры `kdf.*` в `vocab.json` = null; Argon2id — зависимость, лимит ≤ 3), политика потери пароля |
| IDEA-70 | Удаление: crypto-shredding, компакция | v1 локально | M | **I** | `demo/data_actions.mjs` `erase_all`, `erase_preview`; `demo/pack_fp05.mjs`; `tests/data_actions.test.mjs` (REQ-098); снимает воркер и кэш `runway-shell-*` (`pwa.test.mjs`) | Облачное удаление (v2) нет | нет |
| IDEA-71 | Три режима ассистента | v2 (в v1 только A0) | I (A0) | **P** (пересмотр) | A0: `engine/verifier.mjs` `a0_answer`, `parse_command`; `demo.test.mjs` REQ-127; A1–A3: порты `answer_question` на заглушках (`verifier.test.mjs` TST-45/47) | Нет провайдера, согласия, `connect-src` | да: провайдер, регион, согласие, юр. текст |
| IDEA-72 | Символьный режим M3a | v2 | M | M | Grep `symbolic` 0 | Только вместе с A2 | да (как IDEA-71) |
| IDEA-73 | Контракт инструментов (MCP) | v1 реестр; v2 MCP | I | **P** (пересмотр) | `engine/tools.mjs` `TOOLS` (10), `run_tool`; `tools.test.mjs` (33; TST-47) | MCP-сервера нет (Grep `mcp_server` 0). Предложение: `mcp_server.mjs` stdio, только T0, по явному флагу (M) | да: профиль MCP и согласие (ADR-010/013) |
| IDEA-74 | Конверт результата, evidence-ID | v1 | I | I | `engine/tools.mjs` `make_evidence`, `call_id`; `demo/payload_preview.mjs` `origin_call`; чип «числа из расчёта» | — | нет |
| IDEA-75 | Верификатор чисел и дат | v1 (тесты) | I | I | `engine/verifier.mjs` `verify_answer`; V1…V14 (`verifier.test.mjs`); `hardening.test.mjs` (Q-02/Q-03 закрыты) | — | нет |
| IDEA-76 | Структурный ответ без LLM | v1 | I | I | `engine/verifier.mjs` `fallback_answer`, `render_answer`; `demo.test.mjs` REQ-127 | — | нет |
| IDEA-77 | Prompt injection и права | v2 (политика сейчас) | I | I | `engine/tools.mjs` `assert_clean`; `tests/injection.test.mjs` (14; TST-46); `hardening.test.mjs` (Q-04/Q-06 закрыты); `demo/payload_preview.mjs` (REQ-131: недоверенный текст ≤ 80 знаков по кнопке) | `todo`: идентификатор-инструкция по форме `SAFE_ID` (ADR-013) | да (остаточный риск, ADR-013) |
| IDEA-78 | Журнал вызовов ассистента | v2 | P | P | тип `assistant.call` принят редьюсером (`ledger.EVENT_TYPES`); писателя нет (Grep `call_log` — только порт контекста в `engine/tools.mjs`) | Предложение: `engine/call_log.mjs` (хэши, без текстов) + карточка в «Ассистенте» (S) | да: политика — «хэши без текстов» (ADR-013) против повтора по `call_id` |
| IDEA-79 | Модель угроз | v1 | N | N | `wiki/product/07-privacy-security.md` | — | — |
| IDEA-80 | Приватность по умолчанию | v1 | I | I | CSP `default-src 'none'` (+ `manifest-src`, `worker-src`) в `demo/index.html`, `serve.mjs`; `demo/log.mjs` (id, n, ms, code, engine_version); `tests/log.test.mjs` (TST-46 REQ-124 ×9), `rights.test.mjs`, `demo.test.mjs` TST-59, `offline_inventory.test.mjs` | — | нет |
| IDEA-81 | arith.lock | v1 | I | I | `tests/arith.test.mjs` TST-52 (574 случая), `tests/arith.lock.json`, `tests/lock_policy.test.mjs` (REQ-172), `tools/mutate.mjs` | Замок на 500 журналах движка (REQ-172) не добавлен | нет |
| IDEA-82 | Технологический выбор | v1 | P | P | JS + JSDoc, 0 зависимостей (`package.json`); `jsconfig.json`; `npm run typecheck` = `tsc -p jsconfig.json` | `tsc --checkJs` ни разу не запускался (компилятора нет, REQ-155). Предложение: dev-запуск `npx tsc` (S) | да: допустима ли dev-зависимость при политике «0 зависимостей» |
| IDEA-83 | План прототипа | v1 | I | I | сам прототип; `wiki/product/15-prototype-guide.md` | — | нет |
| IDEA-84 | Импорт CSV: профили как данные | v1 | P | **I** | `data/profiles/*.json`; `demo/import_model.mjs` (`read_profile_text`, валидация профиля без regex/исполняемых полей); `demo/import_wizard.mjs`; `tests/import_model.test.mjs` (REQ-091 ×6), `import_wizard.test.mjs`, `hardening.test.mjs` (TST-51 REQ-091: «12,50» при `thousands=","`) | Профилей банков кроме двух общих нет — по запросу | нет |
| IDEA-85 | Интероп: hledger и OFX | v1 экспорт; v1.1 импорт; v2 OFX | P | P | `demo/data_actions.mjs` `export_hledger_file`; импорт в `import_wizard.mjs`; `tests/data_actions.test.mjs` (TST-44 REQ-096 ×3) | Оракул `hledger bal` не запускался: `tools/hledger_oracle.mjs` только скрипт и команды `docker run`, образ не подтверждён, тест в `io.test.mjs` пропущен (нет бинаря); OFX нет (v2) | да: среда (Docker/`hledger`), образ |
| IDEA-86 | Плагинный импортёр | v3 | M | M | — (по решению: вне ядра) | Только данные-профили, без исполняемого кода | да (плагины-банки, ADR-011) |
| IDEA-87 | Облако по минимуму, self-host | v2 | M | M | есть лишь `serve.mjs` как статический хост | Невозможно без сервера | да: сервер, деньги, ADR |
| IDEA-88 | Пакет доказательства | — | R | R | слито с IDEA-29 и IDEA-74 | — | нет |
| IDEA-89 | Подписанные релизы | — | R | R | отклонено; вместо — воспроизводимая сборка: `tools/build_manifest.mjs` `build_hash_of`, `tools/verify.mjs` `verify_local`; `tests/build_manifest.test.mjs` (11; двойная сборка побайтно) | Это проверка целостности копии, а не подлинности хоста (README FP-12) | нет |
| IDEA-90 | Словарь-контракт | v1 | I | I | `engine/vocab.json`; `tools/lint_vocab.mjs`; `demo.test.mjs` и `verifier.test.mjs` TST-56; служебные коды (`W_TRANSFER_UNPAIRED`, `W_HOURS_KEY_IGNORED`, `W_PARAM_OUT_OF_RANGE`, `W_RECORD_QUARANTINED`, `W_OVERRIDE_SIGN`, `W_RESERVE_CLIPPED`) — в `engine/warnings_ext.mjs`, не в `vocab.json` | Перенос в `vocab.json` — канон v1.2 (К-39) | да: принять К-1…К-41 |
| IDEA-91 | Сверка остатка за 10 секунд | v1 | P | **I** | `demo/anchor_dialog.mjs` `reconcile_preview`, `build_anchor_edit`; кнопка в плашке (слот `banner.actions`); `tests/entry.test.mjs` (REQ-028 ×7, границы 7/8 и 21/22), `wave1_integration.test.mjs`; `engine/calibration.mjs` `unlogged_rate`, `stale_status` | — | нет |
| IDEA-92 | Линтер обещаний | v1 | P | **I** | `tools/lint_vocab.mjs` (+ `--registry demo/promises.json`); `demo/promises.json`; `tests/promises.test.mjs` (12), TST-56 | Нет CI-файла: проверки запускаются вручную (`.github` нет; `17-start-plan.md` §5.3 — три команды) | нет |
| IDEA-93 | Заранее объявленная гибкость | v2 | M | M | Grep `flex|not_closed` в `engine/`, `demo/` 0 | Предложение: `engine/flex.mjs` — пометки `shift/skip_ok/reduce` → `new_min`, `not_closed`, без рекомендаций (M) | да: канон запрещает ранжирование (REQ-046); допустима ли пометка без рекомендаций |
| IDEA-94 | Честные малые выборки | v1 (правило) | I | I | `engine/montecarlo.mjs` `present_probability`; `engine/band_adapter.mjs` `quantile_label`; `tests/band_adapter.test.mjs`, `montecarlo.test.mjs` TST-49; `demo/prob_buy.mjs` («мало наблюдений», «k из n») | — | нет |
| IDEA-95 | Метрика ложного спокойствия | v1 (гейт) | P | P | `engine/backtest.mjs` `release_gate`; `tools/backtest_report.mjs`; экран `#quality` (FRR, cry-wolf, n, дата, пометка «синтетика»); `tests/backtest.test.mjs` (TST-55), `quality_report.test.mjs`; на синтетике «обычные»: FRR 85 bp, cry-wolf 3889 bp — гейт проходит; «стресс»: FRR 2188 bp — не проходит | Реальных журналов добровольцев нет; ADV-6: после `tools/anonymize.mjs` метрики backtest могут заметно отличаться (`by_monthday` и «конец месяца» не сдвигаются; `tests/fp11_adv.test.mjs` `todo`) | да: набор ≥ 10 журналов и согласие; пересчёт календарных полей или самопроверка до/после (S) |
| IDEA-96 | v0: Q3-калькулятор без аккаунта | v0 | M | **I** | `demo/v0.html`, `demo/v0.mjs` `form_to_ws`, `form_is_valid`, `read_state`; `tests/v0.test.mjs` (20; REQ-180: пределы 12/3, G-001-эквивалент даёт FRAGILE 635,00 € / 410,00 €); браузер 10-10: «Данных мало» → «выдерживает» | Само испытание спроса (30 приглашённых → ≥ 10 и ≥ 5) не проведено — процесс. У `v0.html` нет хранилища и счётчиков: критерий № 1 считать нечем, кроме наблюдения. Тест v0 без резервов не фиксирует числа TST-39 (1 555,00 / 1 330,00 € — `v0.test.mjs:149` проверяет лишь `notEqual`; числа закреплены на уровне движка в `afford.test.mjs:311`). Страница допускает до 2 необязательных резервов, хотя v0 по REQ-180 «без резервов» | да: канал и 30 приглашённых; допустим ли дрейф v0 (резервы) |
| IDEA-97 | Срок годности правил | v1 | I | I | `engine/tax.mjs` `rule_age_status`; `demo/form_tax.mjs` `rule_banner` («не подтверждено с {since}»); `forms.test.mjs` (REQ-067 ×3), `tax.test.mjs` | — | нет |
| IDEA-98 | План «если разработчик исчез» | v1.x | M | **P** | `SPEC-format.md` (форматы `runway-journal/1`, `runway-metrics/1`, `runway-shell/1`); `tools/verify.mjs` `verify_local` (+`--fixtures`); `tests/build_manifest.test.mjs` (REQ-187, REQ-154) | `LICENSE` нет (REQ-186); хэши не публикуются вместе с релизом; `verify_remote` не читает `sw.js` с хоста (wave2-acceptance); плана «sunset» нет | да: выбор лицензии, публикация |
| IDEA-99 | Числа в документации из кода | v1 | P | P | метки `<!--num:G-001.ключ=значение-->` сверяет `tools/lint_vocab.mjs` (TST-56); `g001.golden.test.mjs` | В вики по-прежнему 7 меток (Grep `<!--num:` по `wiki/`); `tools/suggest_num_labels.mjs` нет. Предложение: инструмент, который находит числа G-001 в страницах и предлагает метки (S) | нет |

Строки без решения: IDEA-55 и IDEA-59 — номера не заняты, в расчёты не входят.

## 3. Таблица UP-01…39

| ID | Название | Фаза | Было | Стало | Доказательство | Остаток и предложение | needs_owner |
|---|---|---|---|---|---|---|---|
| UP-01 | Демо G-001 без регистрации | P1·v1 | P | **I** | `demo/golden_panel.mjs`; `tests/showcase.test.mjs` (REQ-109) | — | нет |
| UP-02 | Лестница сумм | P2·v1 | P | **I** | `demo/ladder.mjs` `ladder_model`, `verdict_at`, `cross_check`; `showcase.test.mjs` (UP-02 ×4: 210,00 / 435,00 / 935,00 €) | — | нет |
| UP-03 | «Почему» в одно действие | P1·v1 | P | **I** | `demo/why_more.mjs` (волна, STS, вердикт «по плану»); `why_more.test.mjs`, `waves_card.test.mjs` | не у каждой строки ленты (S) | нет |
| UP-04 | «Обещаем / не обещаем» и линтер | P1·v1 | P | **I** | `demo/promises.json`, `#promises`; `promises.test.mjs` | — | нет |
| UP-05 | Гейт по ложному спокойствию | P1·v1 | P | P | см. IDEA-95 | журналы добровольцев; ADV-6 | да |
| UP-06 | Замок арифметики и числа вики из кода | P2·v1 | P | P | `arith.test.mjs`, `lock_policy.test.mjs`, `tools/mutate.mjs`; метки `num:` — 7 | `tools/suggest_num_labels.mjs` (S) | нет |
| UP-07 | Путь, а не точка | P1·v1 | I | I | `engine/timeline.mjs` `project`; TST-01/35 | — | нет |
| UP-08 | Q3: три ответа, четыре вердикта | P1·v1 | I | I | `engine/afford.mjs`; TST-04/05 | — | нет |
| UP-09 | Волны с открытым правилом | P2·v1 | P | **I** | `demo/wave_edit.mjs`; `wave_edit.test.mjs`, `waves_card.test.mjs` | — | нет |
| UP-10 | Резервы вычитаются из ответов | P2·v1 | I | I | `engine/sinking.mjs` `reserve_series`, `free_series`; TST-02/08 | — | нет |
| UP-11 | Честность входа | P1·v1 | P | **I** | `demo/entry.mjs`, `demo/anchor_dialog.mjs`; `entry.test.mjs` (REQ-028, REQ-090), `reconcile.test.mjs` | медиана ввода ≤ 5 с на ≥ 5 людях не измерена | да (люди) |
| UP-12 | Ставка × часы с лагом | P2·v1 | P | **I** | `demo/form_hours.mjs`; `forms.test.mjs` (REQ-075/108) | — | нет |
| UP-13 | Валюта решения, подпись курса | P2·v1 | P | P | см. IDEA-50 | подпись на экранах прогноза (S) | нет |
| UP-14 | Сценарий «клиент заплатит позже» | P2·v1 | I | I | `demo/scenario_builder.mjs` (`shift_income`); `demo.test.mjs` REQ-049 | — | нет |
| UP-15 | Диапазоны с честными малыми выборками | P3·v2 | P | **I** | `demo/prob_band.mjs`, `engine/band_adapter.mjs`; `prob_band.test.mjs` | политика вероятностей — предварительное решение | да |
| UP-16 | v0: калькулятор Q3 без аккаунта | P1·v0 | M | **I** | `demo/v0.html`, `demo/v0.mjs`; `v0.test.mjs` (20) | см. IDEA-96 | да (спрос) |
| UP-17 | CSV по профилю, сухой прогон, дедупликация | P1·v1 | P | **I** | `demo/import_wizard.mjs`; `import_model.test.mjs` (TST-42/43) | — | нет |
| UP-18 | Скелет и быстрый ввод | P2·v1 | M | **I** | `demo/wizard.mjs`, `demo/start_template.mjs`, «+ Факт»; `wizard.test.mjs`, `entry.test.mjs` | — | нет |
| UP-19 | Мастер миграции из таблиц | P3·v1.1 | M | M | см. IDEA-32 | `sheet_unpivot.mjs` (L) | да: образцы таблиц |
| UP-20 | Local-first без аккаунтов | P1·v1 | P | P | расчёт на устройстве, CSP, 0 запросов (`offline_inventory.test.mjs`), IndexedDB (`store.test.mjs`); PWA-код есть | офлайн-холодный старт не проверен в браузере (см. IDEA-51) | да (устройства) |
| UP-21 | Экспорт и удаление кнопкой | P1·v1 | P | **I** | `demo/data_actions.mjs`; `data_actions.test.mjs` | — | нет |
| UP-22 | Файл-копия с напоминанием | P2·v1 | M | **I** | `demo/backup.mjs`, `demo/store.mjs`; `backup.test.mjs`, `store.test.mjs` | авто-файл (IDEA-68) | нет |
| UP-23 | «Где что лежит», CSP, логи без PII | P2·v1 | I | I | `dt.where_*`, CSP, `demo/log.mjs`; `log.test.mjs` | — | нет |
| UP-24 | Воспроизводимая сборка, «если разработчик исчез» | P3·v1/v1.x | M | **P** | `tools/build_manifest.mjs`, `tools/verify.mjs`, `SPEC-format.md`; `build_manifest.test.mjs` | `LICENSE`, публикация хэшей, sunset-план (см. IDEA-98) | да (лицензия) |
| UP-25 | Шифрованная синхронизация | P3·v2 | M | M | — | нужен сервер; сначала IDEA-69 | да |
| UP-26 | A0: ответы без LLM | P2·v1 | I | I | `engine/verifier.mjs` `a0_answer` | — | нет |
| UP-27 | Доказательства и чип | P2·v1 | I | I | `engine/tools.mjs` `make_evidence`, `call_id` | — | нет |
| UP-28 | Верификатор чисел в тестах | P2·v1 | I | I | `engine/verifier.mjs` `verify_answer`; V1…V14 | — | нет |
| UP-29 | Недоверенный текст вне контекста | P2·v1 | I | I | `engine/tools.mjs` `assert_clean`; `injection.test.mjs` | — | нет |
| UP-30 | Облачные режимы A2/A3 с предпросмотром | P3·v2 | P | P | `demo/payload_preview.mjs`; порты `answer_question` | согласие, провайдер, журнал вызовов — нет | да |
| UP-31 | Экспорт hledger и сверка | P2·v1 | P | P | `demo/data_actions.mjs` `export_hledger_file` (кнопка); `tools/hledger_oracle.mjs` | оракул не запускался | да (среда) |
| UP-32 | Открытая спецификация формата | P2·v1 | M | **I** | `SPEC-format.md`; `tests/fixtures/FIXTURES.json`; `build_manifest.test.mjs` (REQ-187) | — | нет |
| UP-33 | Дальнейший импорт | P3·v1.1/v2 | P | P | hledger в мастере; профилей Дзен-мани/CoinKeeper/OFX нет | см. IDEA-33 | да |
| UP-34 | MCP-сервер движка | P3·v2 | M | M | — | `mcp_server.mjs` (M) | да |
| UP-35 | Нехватка — факты | P1·v1 | I | I | `ov.sts_short`, `buy.short_to_buffer` | — | нет |
| UP-36 | Нейтральный язык вердикта | P1·v1 | I | I | `vocab.json`, TST-56, линтер | — | нет |
| UP-37 | «Можно потратить» с датой и разложением | P2·v1 | I | I | `engine/afford.mjs` `sts_breakdown`; `demo/why_more.mjs` `sts_why` | — | нет |
| UP-38 | Таблица значений и WCAG 2.2 AA | P2·v1 | P | P | `values_table`; `tools/contrast.mjs` (40 пар на тему), `contrast.test.mjs`; `tests/nav_focus.test.mjs` | настоящий обход клавиатурой, 200 %, скринридер — не сделаны (REQ-167) | да (люди) |
| UP-39 | «В магазине», flex, оповещения | P3·v1.1/v2 | M | **P** | «в магазине» — `demo/store_mode.mjs` (`showcase.test.mjs` REQ-052) | flex (IDEA-93), оповещения (IDEA-47) — нет | да |

## 4. Что сделано из топ-15 и «следующих кандидатов» первого аудита

| № | Предложение 10-05 | Теперь |
|---|---|---|
| 1 | Диалог «Эталон G-001» | сделано: `demo/golden_panel.mjs` |
| 2 | Лестница сумм | сделано: `demo/ladder.mjs` |
| 3 | `#start` и `v0.html` | сделано: `demo/wizard.mjs`, `demo/v0.html` |
| 4 | Диапазон P10–P90 и «при α» | сделано по согласию: `demo/prob_band.mjs`, `prob_buy.mjs` |
| 5 | Карточка «Часы» | сделано: `demo/form_hours.mjs` |
| 6 | Экран «Настройки» | сделано: `demo/settings.mjs` |
| 7 | Экспорт/удаление | сделано: `demo/data_actions.mjs` |
| 8 | Предупреждение о двойном вычитании | сделано: `engine/transfer_guard.mjs` |
| 9 | Карточка «Качество прогноза» | сделано (синтетика): `demo/quality.mjs`, `tools/backtest_report.mjs` |
| 10 | Реестр обещаний | сделано: `demo/promises.json` |
| 11 | Подпись курса, чип «курс −5 %», диалог курса | частично: чип и диалог есть (`scenario_builder.mjs`, `form_fx.mjs`), подпись курса только в «Курсы» |
| 12 | «Почему» у каждого числа | сделано (кроме ленты): `demo/why_more.mjs` |
| 13 | Предпросмотр payload | сделано: `demo/payload_preview.mjs` |
| 14 | Конструктор сценариев | сделано: `demo/scenario_builder.mjs` |
| 15 | «+» и «Сверить остаток» | сделано: `demo/entry.mjs`, `demo/anchor_dialog.mjs` |
| доп. | PWA, «Долги», «в магазине», мастер CSV | сделано (PWA не проверено в браузере) |
| доп. | зашифрованная копия, «куда делись деньги», `.ics` | не сделано |
| доп. | `usual_delay_days` → задержка «если хуже» (LTR-02) | не сделано: поле принимается `ws_edit.mjs` (`add_counterparty`, строки 742–746), но в `engine/` 0 вхождений — на расчёт не влияет |

Находки первого аудита: (1) `W_HOURS_KEY_IGNORED` вне словаря — закрыто через `engine/warnings_ext.mjs`, `vocab.json` не менялся (канон v1.2 решает владелец); (2) `W_RESERVE_BEHIND` без чисел — исправлено (`sinking_report.reserve_behind_detail`, `wave1_integration.test.mjs` REQ-069); (3) `usual_delay_days` не используется — остаётся; (4) экспорт демо не журнал — исправлено (`data_actions.export_journal_copy`, TST-38 REQ-094); (5) сообщения со ссылкой на «настройки» — экран «Настройки» появился, но `err.E_NO_RATE` («введите курс в настройках», `demo/i18n.mjs:174`) по-прежнему ведёт не туда: курс вводится в «Формы данных → Курсы» (`form_fx.mjs`), в `settings.mjs` курсов нет.

## 5. Дорожная карта (`10-roadmap.md`, `17-start-plan.md`) против реализации

### 5.1 Страницы устарели

Обе страницы заморожены на 2026-10-05, и многое в них теперь неверно (править вики — не моя задача, фиксирую расхождения):

| Утверждение страницы | Факт на 2026-10-10 |
|---|---|
| «1098 тестов, 29 файлов, 19 файлов `engine/`, 10 108 строк» | 2155 тестов, 94 файла (2148 pass, 0 fail, 2 skipped, 5 todo); 31 модуль `engine/`, 13 016 строк; 72 модуля `demo/` (20 554 строки) |
| «форм ввода счетов, правил и фактов нет, свои данные — загрузкой JSON» | есть: мастер «Старт», «+ Факт», формы правил/часов/налога/накоплений/курсов/счетов/рассрочки, импорт CSV и hledger, `v0.html` |
| «адаптера хранилища нет» (M4), «PWA, эталонный телефон нет» (M5) | IndexedDB/`persist()`/Web Lock/`eraseAll` есть (`demo/store.mjs`); PWA-код есть, в браузере не проверен |
| `17-start-plan` §5.1: v0 живёт в `prototype/v0/` с `form_model.mjs` | фактически `demo/v0.html` + `demo/v0.mjs` + `demo/i18n/v0.mjs` |
| `17-start-plan` §6.5: пакет метрик `age_days`, `readiness_max`, `activated`, `q3_opened`, `t_first_forecast_bucket` | фактический `runway-metrics/1`: `sessions`, `active_days`, `steps`, `first_forecast`, `verdict_ready`, `counters`, `min_error_bp`, `coverage` (`demo/metrics.mjs` `PACKAGE_KEYS`) |
| «Backtest — интерфейс v2» (`10-roadmap`, «Выход v1»; C-082) | экран `#quality` уже есть (с пометкой «синтетика») |
| чек-лист `17-start-plan` §1: «базовая линия 1098 тестов, 0 fail» | базовая линия теперь 2155 тестов, 0 fail |

### 5.2 Майлстоуны M0–M6 (план `10-roadmap.md`) и состояние

| М | Выход по плану | Состояние 2026-10-10 |
|---|---|---|
| M0 | TST-11…19, 31, 33, 38; `arith.lock` | сделано и усилено: `arith.lock` (574 случая) + политика версий + 61 мутация. Не добито: property на ≥ 10³ журналах (TST-33/38 — 200/400 и 4 набора; `journal_log.test` TST-16 — 10³) |
| M1 | TST-01, 07, 09, 35, 40, 41, 57; **Q1 на журнале автора** | тесты закрыты; Q1 на журнале автора не запускался (процесс; инструменты ввода теперь есть: `wizard`, `v0.html`) |
| M2 | TST-04…06, 30, 36, 39; «проверка недели 12» | сделано; недели не отсчитывались (дата старта не назначена) |
| M3 | TST-02, 03, 08, 10, 20…29, 37 | сделано и с экранами; `todo` 13 → 5 (остались ALG-03 инв. 3, ALG-09 инв. 3, SAFE_ID, К-31, ADV-6) |
| M4 | TST-32, 38, 42…47, 59; адаптер хранилища | адаптер сделан (IndexedDB, `persist()`, Web Lock, `eraseAll` — `store.test.mjs`, `data_actions.test.mjs`); TST-44 неполно (hledger не запускался); TST-59 — статика и заглушка DOM + браузерный проход координатора |
| M5 | TST-54, 58, 60; PWA, доступность, замеры | PWA-код есть, **не проверен в браузере**; замеры в Node (p95 пересчёта 17,34 мс на 1084 событиях, `_ops/bench.json`), не на эталонном телефоне; TST-60: двойная сборка есть, `tsc` не запускался; клавиатура/200 %/скринридер не пройдены |
| M6 | TST-55, запись ревью, калибровка волн | гейт на синтетике: «обычные» FRR 85 bp / cry-wolf 3889 bp — в пределах (500 / 5000 bp); «стресс» FRR 2188 bp — выше порога. Реальных журналов нет; юридическое ревью (REQ-183) не выполнено; калибровка волн (REQ-188): отчёт на синтетике даёт нулевую чувствительность, значения `vocab.json` не менялись |

### 5.3 Критерии остановки (таблица `10-roadmap.md`)

| № | Порог | Состояние | Что нужно |
|---|---|---|---|
| 1 | v0: < 10 из 30 вводят числа или < 5 возвращаются | инструмент есть (`v0.html`), приглашений нет; нет счётчиков на `v0.html` | владелец: канал, 30 приглашённых, определения §6.5, запись `decision` (люди) |
| 2 | к неделе 12 нет Q1+Q3 на реальных данных автора | дата старта не назначена; на данных автора прототип не запускался | владелец: ввести свои числа в мастер/`v0.html` |
| 3 | бэктест на ≥ 10 журналах: FRR > 5 % | только синтетика; «стресс» не проходит порог | журналы добровольцев + решение по ADV-6 |
| 4 | D28 < 25 % | измерить нечем: d7/d28 не считаются | `metrics_derive.mjs` + когорта |
| 5 | юр. ревью признаёт налоговую часть консультацией | ревью не проводилось; налоговая часть — только по введённым правилам, шаблоны без ставок | юрист/люди |
| 6 | PocketSmith/Monarch выпустили автоминимум | процесс (REQ-190): первая проверка не позже 2027-01-02; в коде нет | N (не код) |

### 5.4 Чек-лист «Готовность v0» (`17-start-plan` §3) и «Выход v1» (`10-roadmap`)

| Пункт | Статус | Доказательство или причина |
|---|---|---|
| Форма с данными G-001 без резервов даёт 1 555,00 / 1 330,00 €, дорожка 300,00 € → OK, подпись «без учёта резервов» | partial | подпись и `W_NO_RESERVES` проверены (`v0.test.mjs:149`), числа TST-39 закреплены на движке (`afford.test.mjs:311`), но в `v0.test` их нет: только `notEqual` |
| Гейт не пускает вердикт без буфера/со старым остатком/при нехватке данных | implemented | `engine/afford.mjs` `gate`; `v0.test.mjs` («нет остатка → данных мало», «нет буфера — no_buffer») |
| Файл сохраняется и открывается | implemented | `v0.test.mjs` (REQ-180 REQ-091 «сохранить → открыть»), `read_state` |
| Страница не делает запросов после загрузки | implemented | `v0.test.mjs` (TST-59 CSP только self), `offline_inventory.test.mjs` |
| `node --test`, `lint`, `lint_vocab` без ошибок | implemented | сквозной прогон 2026-10-10: 2148 pass, 0 fail; lint 0 ошибок (приёмка волны 2) |
| Файл `runway-metrics/1` показывается целиком | implemented (в приложении) | `demo/metrics_view.mjs`, `metrics.test.mjs`; на `v0.html` метрик нет |
| «Выход v1»: golden, property, arith.lock, оракул, фаззинг 10⁵ | partial | golden/arith/оракул есть; фаззинг и property на целевых объёмах не гонялись |
| «Выход v1»: гейт REQ-176; ревью REQ-183; калибровка REQ-188 | missing на реальных данных | см. 5.2 M6 |
| «Выход v1»: p95, доступность, i18n, 0 запросов | partial | p95 в Node; a11y — структура; i18n RU/EN; 0 запросов — `offline_inventory.test.mjs` |

### 5.5 Pre-mortem красной команды

| # | Причина провала | Контрмера в коде |
|---|---|---|
| 1 | Ручной ввод не выживает | сделано: сверка остатка (IDEA-91), «скелет» и мастер, CSV/hledger-импорт, `v0.html`; индикаторы (доля устаревших якорей, D28) не считаются |
| 2 | v1 не выходит | процесс; срез и v0 первым — `v0.html` существует |
| 3 | Нет платящей ниши | инструмент проверки есть; проверки нет (30 приглашённых) |
| 4 | Ложное спокойствие | сделано на синтетике (IDEA-94/95, формулировки, гейт Q3); реальных журналов нет |
| 5 | Потеря данных | напоминание и баннер сделаны; авто-запись в файл и sunset-план нет |
| 6 | Налоговый инцидент | шаблоны без ставок, срок годности правил (IDEA-97); юр. ревью нет |
| 7 | Ошибка движка | оракул TST-53, backtest, мутации 61; оракул hledger не запускался; меток `num:` 7 |
| 8 | Выгорание | процесс |
| 9 | Зависимости | A0 полностью работает без сети; курс — ручной ввод |
| 10 | Конкурент | процесс (REQ-190) |

«Чего нельзя обещать»: реестр `demo/promises.json` содержит 8 строк `non_promise` (в т.ч. `first_minutes`, `advice`, `accuracy`, `bank_sync`, `human_review_pending`, `prob_not_promise`), все проверены линтером и тестом `promises.test.mjs`.

## 6. Что невозможно без сервера, денег или людей

| Что | Идеи/REQ | Чего именно не хватает |
|---|---|---|
| Сервер | синхронизация и облачное удаление (IDEA-68 sync, 69, 70 облако, 87, UP-25), семья с общим vault (IDEA-48), push-уведомления (IDEA-47) | нет сервера и ADR на ключи и биллинг; локальные заменители: `.ics`, зашифрованный файл |
| Деньги/внешние сервисы | облачные режимы A1–A3 и MCP (IDEA-71/72/73, UP-30/34): провайдер модели, регион, лимиты; HTTPS-хостинг публичной бету; юридическое ревью (REQ-183); эталонные телефоны для REQ-152 | бюджет, договор с провайдером, юрист |
| Люди | v0-спрос на 30 приглашённых (критерий № 1); ≥ 10 журналов добровольцев и анонимизация (REQ-176, 188, IDEA-95); 8–10 интервью (REQ-189); медиана ввода ≤ 5 с на ≥ 5 людях (REQ-090); вычитка RU/EN; ручной проход PWA и устройств (Safari/iOS, две вкладки, клавиатура, 200 %, скринридер; REQ-157/167); образцы экспортов Дзен-мани/CoinKeeper/таблиц; ревью налогового специалиста; перевод на испанский (REQ-113) |
| Решения владельца без кода | канон v1.2 (К-1…К-41, особенно К-39 для `W_*` в `vocab.json`, К-31 для `state_hash`), политика вероятностей (сейчас предварительная), хранение `hours` в сценарии, лицензия (REQ-186), метка `tag` для дохода через «+» (C-025), допустимость `flex` без рекомендаций, `.ics`, определения метрик §6.5, дрейф `v0.html` (резервы) |

## 7. Аддитивный бэклог закрытия пробелов

Порядок — по заметности и дешевизне; `needs_owner` = требуется решение до работы.

| # | Что | Идеи/UP | Размер | needs_owner (вопрос) |
|---|---|---|---|---|
| 1 | Убрать устаревшую оговорку `fd.demo_note` и исправить `err.E_NO_RATE` («Формы данных → Курсы») | IDEA-38, 50 | S | нет |
| 2 | Вид правки `upsert_calendar` + блок «Праздники» в `form_rule.mjs` | IDEA-06 | S–M | нет |
| 3 | Подпись курса и возраста в строках пересчёта на «Обзоре/Купить» | IDEA-50, UP-13 | S | нет |
| 4 | Тест `v0.test.mjs`: форма G-001 без резервов = 1 555,00 / 1 330,00 €, дорожка 300,00 € → OK | IDEA-96 | S | нет |
| 5 | `tools/suggest_num_labels.mjs` (метки `num:` для чисел G-001 в вики) | IDEA-99, UP-06 | S | нет |
| 6 | `demo/metrics_derive.mjs`: d7, d28, activation_7d, северная звезда, доля устаревших якорей/без копии; счётчики на `v0.html` | IDEA-54, критерии № 1 и № 4 | M | да: определения §6.5 → `decision` |
| 7 | Диаграмма «куда делись деньги» из `sts_breakdown` | IDEA-41 | S | нет |
| 8 | «Исправить факт» (`void_fact` + `add_fact`) и «Почему» у строки ленты | IDEA-38, 29 | S | нет |
| 9 | `usual_delay_days` → сдвиг поступления в «если хуже» | LTR-02, OBS-14 | S–M | да: семантика поля в каноне v1.2 |
| 10 | Привязка резерва к счёту в формах + ветка движка | IDEA-40, REQ-191 | M | нет (v1.1) |
| 11 | `demo/backup_fs.mjs`: автокопия в выбранный файл | IDEA-68 | M | нет |
| 12 | `engine/ics.mjs` + кнопка «Экспорт волн в .ics» | IDEA-47 | S | да: допустим ли `.ics` вместо пушей |
| 13 | `engine/call_log.mjs` (хэши, без текстов) | IDEA-78 | S | да: политика журнала (ADR-013) |
| 14 | Профили Дзен-мани/CoinKeeper как `data/profiles/*.json` | IDEA-33, UP-33 | S каждый | да: образцы экспортов |
| 15 | `engine/sheet_unpivot.mjs` + шаг мастера | IDEA-32, UP-19 | L | да: образцы таблиц |
| 16 | `engine/tax_calendar.mjs` (сроки как данные пользователя) | IDEA-17 | S–M | да: юр. ревью |
| 17 | Пересчёт `by_monthday` в `tools/anonymize.mjs` или самопроверка backtest до/после | IDEA-95, ADV-6 | S | да: какой из двух вариантов |
| 18 | `tsc --checkJs` как dev-шаг | IDEA-82 | S | да: dev-зависимость при политике «0 зависимостей» |
| 19 | Запись `sw.js` в `verify_remote`; `LICENSE`; публикация хэшей | IDEA-98, UP-24 | S | да: лицензия |
| 20 | Зашифрованная копия `demo/crypto_copy.mjs` | IDEA-69 | M–L | да: ADR на KDF |
| 21 | `engine/flex.mjs` | IDEA-93 | M | да: канон REQ-046 |
| 22 | Испанский каталог | IDEA-49 | M | да: переводчик и вычитка |
| 23 | `mcp_server.mjs` (stdio, T0) | IDEA-73, UP-34 | M | да: профиль MCP, согласие |
| 24 | Ручной проход PWA в Chrome/Edge; PNG-иконки 192/512 | IDEA-51 | S | да: владелец, устройства |

## 8. Находки по ходу проверки (в отчёт, не правились)

1. `demo/i18n.mjs:378`/`:735` и `demo/app.mjs:1477`: оговорка «лента только для чтения: внесение фактов и сверка не включены» показывается рядом с работающими «+ Факт» и экраном «Сверка».
2. `demo/i18n.mjs:174`/`:538` (`err.E_NO_RATE`): «введите курс в настройках» — в `settings.mjs` курсов нет, курс вводится в «Формы данных → Курсы».
3. `usual_delay_days` хранится (`ws_edit.mjs:742–746`), но не влияет на расчёт (0 вхождений в `engine/`); документация (OBS-14) описывает как рабочее.
4. `10-roadmap.md` и `17-start-plan.md` не обновлялись после волн (раздел 5.1); `17-start-plan.md` §5.1 и §6.5 расходятся с фактическим `demo/v0.html` и `runway-metrics/1`.
5. `v0.html` допускает до двух необязательных резервов, хотя v0 по REQ-180 и дорожной карте — «без резервов» (с резервами числа канона G-001 воспроизводятся тестом `v0.test.mjs`, без — подпись `W_NO_RESERVES`). Это расширение среза; решение за владельцем.
6. Тест `v0.test.mjs:149` не закрепляет числа TST-39 для варианта без резервов (только неравенство каноническим числам).
7. ADV-6: метрики backtest на анонимизированном журнале расходятся с исходным (`tests/fp11_adv.test.mjs`, `todo`): гейт REQ-176 по анонимизированным журналам считать нельзя до сравнения «до/после».
8. В вики по-прежнему 7 меток `<!--num:`; тезис «числа в документации из кода» (IDEA-99) работает на очень малой доле чисел.
9. PWA: запись `sw.js` не входит в `precache_list`, поэтому `verify.mjs --url` не поймает вручную правленый воркер на хосте (wave2-acceptance).

## 9. Ограничения этого аудита

- Тесты не запускались; статусы опираются на содержимое и названия тестов, приёмки волн и отчёт сквозного прогона 2026-10-10 (2155 тестов, 2148 pass, 0 fail, 2 skipped, 5 todo).
- Утверждения «в браузере проверено» взяты из `16-prototype-findings.md` (проход координатора 2026-10-10); сам браузер в этом аудите не открывался.
- Идеи, помеченные I для v2-функций (Монте-Карло, бэктест, долги), реализованы как исследование прототипа и включены по согласию; продуктовым обещанием они не являются (реестр обещаний, `prob_not_promise`).

## Связанные страницы

- [Первый аудит идей](../gap/ideas-audit.md)
- [Приёмка волны 1](../impl/wave1-acceptance.md)
- [Приёмка волны 2](../impl/wave2-acceptance.md)
- [Дорожная карта](../../wiki/product/10-roadmap.md)
- [План старта](../../wiki/product/17-start-plan.md)
