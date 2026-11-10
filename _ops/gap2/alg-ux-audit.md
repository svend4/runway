# Повторный аудит алгоритмов ALG-01…14 и экранов UX (после волн 1, 2 и этапа S1)

Дата: 2026-10-10. Режим: только чтение. Тесты и серверы не запускались: утверждение «реализовано» опирается на код (путь + функция) и на тест, найденный по имени функции или идентификатору в `prototype/tests/`. Если теста нет или он проверяет только заглушку DOM, статус «частично». Отчёты волн (wave1-acceptance, wave2-acceptance) использованы как подсказка и перепроверены по коду. Первый аудит: `_ops/gap/alg-audit.md` и `_ops/gap/ux-audit.md` (2026-10-05). Расчёт по введённым данным и правилам, не консультация.

Обозначения: «Было 10-05» — статус той же строки в первом аудите (если строки там не было, оценено по его тексту); ▲ — статус изменился. Усилие: S ≤ 0,5 дня, M 1–2 дня, L ≥ 3 дней. Колонка «Решение владельца» заполнена, только если без решения (канон v1.2, политика вероятностей, юридические формулировки, внешние сервисы, люди и устройства) работу не начать.

## 1. Главное

1. **Слепые зоны первого аудита закрыты.** В 10-05 ни ALG-10, ALG-13, ALG-14, ALG-09, ALG-07, ALG-08, ALG-03, ALG-06 не доходили до экрана. Теперь: ALG-03 (правки волн), ALG-07 (часы), ALG-08 (курсы, обмен), ALG-13 (Сверка, Качество), ALG-14 (мастер импорта, экспорт, удаление), ALG-10 (полоса по согласию) и ALG-05/06 (формы, «N взносов на X», запись в конверт) имеют экран и тесты. Из 26 пунктов «что дописать» первого аудита выполнено 18, частично 7, не начат 1 (испанский).
2. **Все восемь «расхождений кода» первого аудита закрыты или сведены к решению арбитра**: set_amount (validate_override), одинокая нога перевода (W_TRANSFER_UNPAIRED), E_NO_RATE на нуле, число в W_RESERVE_BEHIND, текст W_HOURS_KEY_IGNORED, BigInt в skill_pm, строгие суммы и csv_safe_cell, три из четырёх пробелов верификатора. Открыты: зажим аннуитета (ALG-09), идентификатор-«инструкция» (ALG-12), метрики после анонимизации (ADV-6).
3. **Новые пробелы, которых первый аудит не мог видеть**: (а) метрики `min_error_bp` и `coverage` определены и проверены, но ни один экран их не заполняет (`demo/metrics.mjs:272,282` без вызывающих); (б) формат `runway-metrics/1` расходится с вики (`13-metrics.md`, `17-start-plan.md` 6.5); (в) экран «Долги» не записывает долг в рабочую область; (г) страницы ALG-01…14 не обновлялись с 2026-10-04 и по-прежнему пишут «чего нет» про вещи, которые уже есть (см. раздел 6); (д) «Качество прогноза» работает только на синтетике.
4. **Что остаётся не сделанным по сути**: режим `expected` в расчёте, adverse-политика курса, шаблоны налоговых режимов, LLM A1–A3/MCP, журнал вызовов ассистента, мастер таблиц Excel, OFX, ES, оракул hledger, ручные проверки PWA/доступности. Большая часть упирается в решения владельца.

## 2. Итоговые числа (строки этого отчёта)

| Блок | Строк | Реализовано | Частично | Нет | Не код | Изменилось с 10-05 |
|---|---:|---:|---:|---:|---:|---:|
| Алгоритмы ALG-01…14 (под-пункты) | 102 | 60 | 13 | 26 | 3 | 50 |
| Экраны (инвентарь 03-ux-screens, 16 строк) | 16 | 13 | 3 | 0 | 0 | 13 |
| UX целиком (экраны, плашки, состояния, путь «10 минут», чек-лист v0) | 62 | 35 | 19 | 6 | 2 | 33 |
| **Всего** | 164 | **95** | **32** | **32** | **5** | **83** |

Для сравнения, первый аудит по экранам (16 строк инвентаря): есть 4, частично 7, нет 5. Сейчас (раздел 5.1): 13 реализовано, 3 частично, 0 нет. По алгоритмам первый аудит дал уровень «алгоритм целиком»: реализовано 10, частично 4; теперь по сводке (раздел 3) полностью до экрана доходят 10 из 14, частично 4.

Распределение «было 10-05» по тем же строкам: реализовано 19, частично 31, нет 98, не код 5 ; ещё 11 строк первый аудит не охватывал (новые пункты, помечены «не оценивалось»); для остальных строк, которых аудит отдельно не выделял, «было» оценено по его тексту.

## 3. Сводка по алгоритмам: движок, экран, тесты

| ALG | Движок | Что доходит до экрана | Файлы тестов (число тестов) | Было 10-05 (алгоритм) | Сейчас (до экрана) |
|---|---|---|---|---|---|
| ALG-01 | реализовано | частично: правила и «пропустить» на экране; календари, move/set_amount, разовый платёж — нет | recurrence (22), dates (15), forms (42) | реализовано | частично |
| ALG-02 | реализовано; два бага закрыты (hardening) | доходит: «запас хода», подсказка буфера, 7 видов сценариев, «почему» | timeline (39), hardening (40), scenario_builder (19) | реализовано | реализовано |
| ALG-03 | реализовано | доходит полностью: merge/split/pin, «почему вместе», θ/g/S, чувствительность | waves (26), wave_edit (12), waves_card (22) | реализовано | реализовано |
| ALG-04 | реализовано | доходит: «в магазине», лестница, рассрочка с процентами, вероятностное «α» по согласию; earliest для рассрочки — нет | afford (36), installment (7), showcase (42) | реализовано | реализовано |
| ALG-05 | реализовано (числа C-030 есть) | доходит: форма, план, «N на X», «подтвердить за период»; ручное освобождение — нет | sinking (29), sinking_report (12), forms (42) | частично | реализовано |
| ALG-06 | реализовано (on_posted_* есть) | доходит: форма правила, запись в конверт, подтверждение; next_release и шаблоны — нет | tax (18), tax_hooks (11), forms (42) | частично | реализовано |
| ALG-07 | реализовано | доходит: форма часов, диапазон дохода, недоработка, чип «часы»; EWMA, CSV часов — нет | hourly (23), forms (42) | реализовано | реализовано |
| ALG-08 | реализовано | доходит: курсы, обмен, запас, чип курса; adverse, выбор валюты — нет | fx (18), liquidity (7), forms (42) | реализовано | реализовано |
| ALG-09 | реализовано | экран «Долги» как калькулятор; долг в прогноз не записывается | debt (16), showcase (42) | реализовано | частично |
| ALG-10 | реализовано | доходит по согласию: полоса P10–P90, «α»; в основном потоке и CLI нет (по замыслу) | montecarlo (38), mc_inputs (11), band_adapter (11), prob_band (20) | реализовано (в движке) | реализовано |
| ALG-11 | реализовано | доходит: «можно потратить», разложение, настройки, «почему» | afford (36), settings (36), why_more (12) | реализовано | реализовано |
| ALG-12 | частично (v2: LLM/MCP/ES нет) | A0: 8 интентов; журнал вызовов, what_changed в диалоге — нет | tools (33), verifier (33), injection (14), verifier_io (todo 1) | частично | частично |
| ALG-13 | реализовано | доходит: «Сверка», «Качество прогноза» (синтетика), «Привычки», «ожидаемый»; своего backtest нет | calibration (28), backtest (32), reconcile (28), quality_report (17), expected (6) | реализовано (с оговоркой) | частично |
| ALG-14 | реализовано | доходит: мастер CSV/hledger, откат, экспорт, удаление; мастер таблиц, OFX — нет | io (35), import_model (21), import_wizard (9), data_actions (33) | частично | реализовано |

«Сейчас (до экрана)» — реализовано, если всё, что страница относит к v1, имеет экран и тест; частично — если для v1-части нет экрана или тест не нашёл связи.

## 4. Часть 1. Алгоритмы: построчно

### ALG-01 Развёртка повторений

| № | Что | Сейчас | Было 10-05 | Доказательство | Чего не хватает | Усилие | Решение владельца |
|---|---|---|---|---|---|---|---|
| A01.1 | Развёртка D/W/M/Y, interval, by_*, count/until, exdates, override по occ_key | **реализовано** | реализовано | engine/recurrence.mjs (expand_rule, expand_all, occ_key); tests/recurrence.test.mjs, dates.test.mjs (TST-11…15, 51), adversarial/dates_money.test.mjs | — | — | — |
| A01.2 | Проверка знака и нуля у Override set_amount (баг страницы п. 8) | **реализовано** ▲ | нет | engine/recurrence.mjs:152 validate_override; вызывается из demo/form_rule.mjs:156; tests/forms.test.mjs (REQ-032, вид правки set_occurrence_override), tests/hardening.test.mjs | — | — | — |
| A01.3 | Ввод правил на экране: форма с предпросмотром ближайших дат, «Пропустить вхождение» (override skip) | **реализовано** ▲ | нет | demo/form_rule.mjs (build_rule_edit, edit_set_occurrence_override, предпросмотр через expand_all); tests/forms.test.mjs (REQ-032: 5 тестов, в том числе экранный), экран #forms раздел «Платежи» | Форма знает только freq M/W/Y/D, interval, monthday, weekend, until; by_workday и month_end в форме нет | — | — |
| A01.4 | Правка одного вхождения на экране: перенос (move) и своя сумма (set_amount) | **частично** ▲ | нет | Вид правки принимает move/set_amount (demo/form_rule.mjs:128-160, тест forms REQ-032 «вид правки») | В интерфейсе есть только кнопка «Пропустить» (form_rule.mjs:111); перенос и своя сумма вхождения без правки файла недоступны | S | — |
| A01.5 | Календари выходных и праздников: редактирование пользователем | **нет** | нет | Вида правки upsert_calendar нет (demo/ws_edit.mjs: ID_KINDS знает calendar, register_edit — нет); form_rule.mjs:71 берёт первый календарь рабочей области; в v0.mjs:289 зашит Sat/Sun без праздников | Праздники и нестандартные выходные пользователь задать не может; weekend=prev/next/skip работает только по календарю из файла | M | — |
| A01.6 | Разовый плановый платёж (plans[]) вводится на экране | **частично** | не оценивалось | Обход: правило с датой окончания (form_rule.mjs, until_date) и count=1 в мастере для дохода (demo/rule_kit.mjs:190); тест wizard.test REQ-110 | Вида правки для plans[] нет (grep upsert_plan/add_plan пуст); статус плана меняется только в «Сверке» (set_plan_status) | S | — |
| A01.7 | Не в v1: BYSETPOS («второй вторник»), BYMONTH, by_monthday для Y, версии правила valid_from, пакеты праздников со сроком | **нет** | нет | engine/recurrence.mjs:118 (Y_without_by) — отвергает; by_setpos/by_month/valid_from у правил в engine/ нет | Расширение схемы Rule: новое необязательное поле — отдельный модуль engine/recurrence_ext.mjs | M | Расширение схемы Rule и пакеты праздников — канон v1.2 (ADR-015: v2). Вопрос: брать ли в срез, и кто сопровождает данные праздников |

### ALG-02 Шкала и проекция

| № | Что | Сейчас | Было 10-05 | Доказательство | Чего не хватает | Усилие | Решение владельца |
|---|---|---|---|---|---|---|---|
| A02.1 | Ядро: build_events_ex, project, answer_q1, explain_narrowest, apply_scenario, runway_days | **реализовано** | реализовано | engine/timeline.mjs; tests/timeline.test.mjs, g001.test.mjs, g001.golden.test.mjs, analyze.test.mjs, adversarial/golden_properties | — | — | — |
| A02.2 | Одинокая нога перевода больше не пропадает молча (баг п. 11) | **реализовано** ▲ | нет | engine/timeline.mjs:739 external_transfers + :800 W_TRANSFER_UNPAIRED; текст — engine/warnings_ext.mjs; tests/hardening.test.mjs:50 (Q-01), adversarial/semantics.test.mjs:1336 | — | — | — |
| A02.3 | E_NO_RATE не требуется для явного нулевого остатка в чужой валюте (баг п. 12) | **реализовано** ▲ | нет | tests/hardening.test.mjs:119 (Q-16), adversarial/semantics.test.mjs:1342 | — | — | — |
| A02.4 | Запас хода (runway_days) на экране | **реализовано** ▲ | нет | demo/home_cards.mjs:8,42 runway_card (слот overview.cards); tests/settings.test.mjs REQ-023 (канон G-001, G-001-gap) | — | — | — |
| A02.5 | Подсказка буфера (buffer_hint, outflow_90) в интерфейсе | **реализовано** ▲ | нет | demo/settings.mjs («Взять подсказку»); tests/settings.test.mjs:157,173 (49000 = round_div(7·630000, 90)) | — | — | — |
| A02.6 | Чипы сценариев: shift_flow, set_amount, remove_flow, add_flow, fx_shock, hours, сдвиг выбранного поступления; «Сохранить в набор» | **реализовано** ▲ | нет | demo/scenario_builder.mjs (OP_KINDS, ENGINE_OPS), engine/scenario_ext.mjs (hours_to_ops, analyze_ext); tests/scenario_builder.test.mjs (19) | — | — | — |
| A02.7 | «Почему» у числа: цепочка с «Остальное», контрфакты | **реализовано** ▲ | частично | demo/why_more.mjs (хук show_why), demo/wave_edit.mjs (open_wave_why); tests/why_more.test.mjs (12) | — | — | — |
| A02.8 | Режим expected как режим расчёта (analyze, Q1, Q3) | **нет** | нет | engine/timeline.mjs: mode=expected → E_SCHEMA mode_not_in_v1 (README «режим расчёта expected по-прежнему»); есть только отображаемая оценка engine/expected.mjs | Снятие запрета затрагивает канон (vocab.json, golden) | L | Включать ли режим expected в расчёт (канон v1.2: снять mode_not_in_v1, определить, какой ряд считается заголовком) |
| A02.9 | Внутридневной режим intraday | **не код** | не код | Страница: «не планируется» | — | — | — |

### ALG-03 Волны платежей

| № | Что | Сейчас | Было 10-05 | Доказательство | Чего не хватает | Усилие | Решение владельца |
|---|---|---|---|---|---|---|---|
| A03.1 | detect_waves, wave_metrics, list_waves_ex; экран «Волны» и календарь | **реализовано** | реализовано | engine/waves.mjs; demo/app.mjs view_waves, calendar_block; tests/waves.test.mjs (26), demo.test.mjs TST-37 REQ-107 | — | — | — |
| A03.2 | Правки волн merge / split / pin на экране, W_OVERRIDE_STALE со снятием | **реализовано** ▲ | нет | demo/wave_edit.mjs (слоты waves.actions и waves.card), вид правки set_wave_override (ws_edit.mjs:714); tests/wave_edit.test.mjs (12), tests/waves_card.test.mjs (22) | — | — | — |
| A03.3 | «Почему вместе?»: шаги платежей, разрыв g и размах S | **реализовано** ▲ | нет | engine/wave_sweep.mjs (explain_membership, explain_boundary); tests/wave_edit.test.mjs:225, why_more.test.mjs | — | — | — |
| A03.4 | Параметры g, S, θ редактируются; таблица чувствительности | **реализовано** ▲ | нет | demo/settings.mjs:29-31 (wave.gap_days, wave.max_span_days, wave.threshold_minor); engine/wave_sweep.mjs sweep_waves; tests/settings.test.mjs:447, wave_edit.test.mjs:198 | — | — | — |
| A03.5 | Инвариант 3 для последовательности правок (идемпотентность) | **частично** | частично | tests/adversarial/semantics.test.mjs:353 — todo canon_suspect; страница исправлена, код нет | Решение арбитра: считать инвариант верным только для одиночной правки | — | Подтвердить формулировку инварианта 3 в каноне (арбитр) |
| A03.6 | v2: значимость κ, устойчивость по трём месяцам, автоподбор g/S/θ, календарь волн по истории | **нет** | нет | в engine/waves.mjs и wave_sweep.mjs нет; sweep_waves — только таблица, подбор не делает | Нужны журналы (REQ-188: ≥ 10); пороги остаются гипотезами | L | Дать ≥ 10 журналов добровольцев для калибровки порогов (REQ-188) |

### ALG-04 Могу ли купить

| № | Что | Сейчас | Было 10-05 | Доказательство | Чего не хватает | Усилие | Решение владельца |
|---|---|---|---|---|---|---|---|
| A04.1 | check_purchase, max_amount, earliest_date, verdict_of, gate; экран «Купить» | **реализовано** | реализовано | engine/afford.mjs; demo/app.mjs view_buy, buy_run; tests/afford.test.mjs (36), demo.test.mjs TST-04 | — | — | — |
| A04.2 | Режим «в магазине» (один экран над max_amount) | **реализовано** ▲ | нет | demo/store_mode.mjs (store_model, timed_store); tests/showcase.test.mjs:510-594 (REQ-052) | — | — | — |
| A04.3 | Лестница сумм (границы 210 / 435 / 935 € по вердиктам) | **реализовано** | не оценивалось | demo/ladder.mjs; tests/showcase.test.mjs:219-279 (UP-02: границы S и S+1 сверены с check_purchase) | — | — | — |
| A04.4 | Рассрочка с процентами (annuity, differential), перенос платежа, части за горизонтом | **реализовано** ▲ | частично | engine/installment.mjs; demo/form_installment.mjs; tests/installment.test.mjs (7), forms.test.mjs REQ-192 (1 200 € под 12 %, 6 платежей → Σ 124235) | — | — | — |
| A04.5 | earliest_date с рассрочкой (сдвиг графика платежей) | **нет** | нет | engine/afford.mjs earliest_date(ctx, S, not_before, B, mode) принимает одну сумму; в form_installment/store_mode вызова earliest нет | Нет «с какой даты рассрочка держится в буфере» | M | — |
| A04.6 | Вероятностный Q3: «при уверенности α максимум X», p_fail | **реализовано** ▲ | нет | demo/prob_buy.mjs, engine/band_adapter.mjs mc_buy; tests/band_adapter.test.mjs (11), prob_band.test.mjs (20); только по согласию, ответ «Купить» остаётся детерминированным | Оговорка: тестами покрыт показ на заглушке DOM; юридическое ревью формулировок не сделано | — | Юридическое ревью формулировок «эксперимент, не обещание» (REQ-183) и политика показа вероятностей |
| A04.7 | Ранжирование «ходов» при нехватке | **не код** | не код | Запрещено каноном (C10, REQ-046); не реализовывать | — | — | — |

### ALG-05 Накопительные резервы

| № | Что | Сейчас | Было 10-05 | Доказательство | Чего не хватает | Усилие | Решение владельца |
|---|---|---|---|---|---|---|---|
| A05.1 | contribution_dates, contribution_plan[_fixed], reserve_open, contribution_allocations | **реализовано** | реализовано | engine/sinking.mjs; tests/sinking.test.mjs (29), g001.test.mjs | — | — | — |
| A05.2 | W_RESERVE_BEHIND с числом и суммой («N взносов на X») | **реализовано** ▲ | нет | engine/sinking_report.mjs:103 reserve_behind_detail; demo/app.mjs:907 (warn.W_RESERVE_BEHIND_n); tests/sinking_report.test.mjs:94,108 (REQ-069 C-030) | — | — | — |
| A05.3 | Форма накопления, план «цель через N мес.», «цель достигнута», «до срока нет дат взноса» | **реализовано** ▲ | нет | demo/form_sinking.mjs (sinking_plan, periods_to_goal); tests/forms.test.mjs:449,475,917,1064; sinking_report.test.mjs:22-135 | — | — | — |
| A05.4 | Пакетное «подтвердить взносы за период» (запись allocation) | **реализовано** ▲ | нет | demo/form_sinking.mjs, вид правки confirm_contributions; tests/forms.test.mjs:483; sinking_report.test.mjs:119 | — | — | — |
| A05.5 | Перевод на копилку при действующем резерве: запрос о двойном вычитании (REQ-063) | **реализовано** ▲ | нет | engine/transfer_guard.mjs; demo/entry.mjs render_pending_card; tests/transfer_guard.test.mjs (8) | — | — | — |
| A05.6 | Остаток резерва после платежа и просрочка резерва: сумма в тексте и действие «освободить» | **частично** | частично | warn.W_RESERVE_RESIDUAL / W_RESERVE_OVERDUE (demo/i18n.mjs:155-156) — общий текст; вид правки record_allocation принимает source release/manual (ws_edit.mjs:622) | Кнопки «освободить остаток» нет; суммы в тексте нет (в отличие от W_RESERVE_BEHIND) | S | — |
| A05.7 | Частоты взноса кроме M, привязка резерва к счёту (REQ-191), потеря номинала месяца при сдвиге next | **нет** | нет | engine/sinking.mjs:57 («only_monthly_cadence»); backed_by_account_id только выводит резерв из ряда (index.mjs:132) | Расширение схемы Reserve | M | Привязка резерва к реальному счёту и частоты — решение канона v1.1/v1.2 (REQ-191) |

### ALG-06 Налоговый конверт

| № | Что | Сейчас | Было 10-05 | Доказательство | Чего не хватает | Усилие | Решение владельца |
|---|---|---|---|---|---|---|---|
| A06.1 | rule_at, allocation_for_income, allocation_range, release_on_payment, allocations_for_events, rule_age_status | **реализовано** | реализовано | engine/tax.mjs; tests/tax.test.mjs (18) | — | — | — |
| A06.2 | Оболочки on_posted_income / on_posted_payment (запись allocation.recorded, release, true_up) | **реализовано** ▲ | нет | engine/tax_hooks.mjs:111,128 (+ pending_posted_allocations); tests/tax_hooks.test.mjs (11); в UI — вид правки post_income и «записать в конверт» (demo/form_hours.mjs, form_tax.mjs; forms.test.mjs:311,336,856,881) | — | — | — |
| A06.3 | Форма налогового правила (ставка вводится пользователем), предпросмотр «что будет с конвертом», «Подтвердить правило», замена чисел текстом при disabled | **реализовано** ▲ | нет | demo/form_tax.mjs; tests/forms.test.mjs:360,379,406,423,698 (REQ-064…068; при 2·ttl числа заменены) | — | — | — |
| A06.4 | allocation_range и rule_age_status на экране | **реализовано** ▲ | нет | demo/form_tax.mjs (импорт allocation_range, rule_age_status); forms.test.mjs REQ-108 | — | — | — |
| A06.5 | next_release («следующее списание из конверта») на экране | **нет** | нет | grep next_release по demo/ пуст; в engine/tax.mjs функция есть, tests/tax.test.mjs её проверяют | — | S | — |
| A06.6 | Шаблоны налоговых режимов как данные (tax_templates.json со сроком годности), именованные режимы, base = net_of_vat, окна дат, known_at в интерфейсе, переоценка резерва в валюте платежа | **нет** | нет | data/templates/ — только freelancer-skeleton.json (названия платежей без сумм; rate_bp: null); в engine/tax.mjs net_of_vat нет | Любые ставки и режимы — юридически чувствительные данные | L | Допустимы ли шаблоны стран/режимов вообще (юридические формулировки, ответственность за актуальность) и чей это контент |

### ALG-07 Почасовой доход

| № | Что | Сейчас | Было 10-05 | Доказательство | Чего не хватает | Усилие | Решение владельца |
|---|---|---|---|---|---|---|---|
| A07.1 | gross_pay, period_bounds, pay_date, expand_stream_ex, resolve_hours, plan_to_date, shortfall, validate_stream | **реализовано** | реализовано | engine/hourly.mjs; tests/hourly.test.mjs (23) | — | — | — |
| A07.2 | Форма потока часов: диапазон часов 80/93/110 → доход 2 400/2 790/3 300 €, «отработано N часов» | **реализовано** ▲ | нет | demo/form_hours.mjs (edit_set_stream_hours); tests/forms.test.mjs:237,264,282,824 (REQ-075 REQ-108) | — | — | — |
| A07.3 | Карточка «Недоработка по часам» (shortfall: 8 ч = 240,00 €) | **реализовано** ▲ | нет | demo/form_hours.mjs render_shortfall; tests/forms.test.mjs:250,748 (TST-26) | — | — | — |
| A07.4 | Чип сценария «часы» (hours{stream_id, minutes}) | **реализовано** ▲ | нет | engine/scenario_ext.mjs hours_to_ops; tests/scenario_builder.test.mjs | — | — | — |
| A07.5 | W_HOURS_KEY_IGNORED: текст в реестре служебных предупреждений | **реализовано** ▲ | нет | engine/warnings_ext.mjs EXT_WARNING_CODES; demo/app.mjs:905 ext_warning_text; tests/hourly.test.mjs, hardening.test.mjs | — | — | — |
| A07.6 | v2/v1.1: автозамена exp_minutes по темпу ρ (EWMA), недельный порог переработки при месячной выплате, предупреждение «pace × elapsed > exp» | **нет** | нет | в engine/hourly.mjs нет (shortfall возвращает только числа) | — | M | Включать ли в срез автозамену по темпу и недельную переработку (C-027, C-033 — канон) |
| A07.7 | Импорт часов из CSV (v1.1) | **нет** | нет | grep import_hours / hours_csv по engine/ и demo/ пуст | Новый модуль engine/hours_io.mjs поверх parse_csv + вид правки set_stream_hours | M | — |

### ALG-08 Конверсия валют

| № | Что | Сейчас | Было 10-05 | Доказательство | Чего не хватает | Усилие | Решение владельца |
|---|---|---|---|---|---|---|---|
| A08.1 | convert_minor, to_decision_events, opening_in_decision, apply_shock, rate_status | **реализовано** | реализовано | engine/fx.mjs; tests/fx.test.mjs (18), adversarial/golden_properties B-70/73/74/79 | — | — | — |
| A08.2 | Форма курса, таблица «курс и свежесть» (rate_status), плашка «не обновлялся N дн.» | **реализовано** ▲ | нет | demo/form_fx.mjs; tests/forms.test.mjs:504,946 (REQ-077 REQ-079: курс от 2026-08-20 → «45 дн.») | — | — | — |
| A08.3 | Обмен двумя ногами и справочная курсовая разница (exchange_difference) | **реализовано** ▲ | нет | demo/form_fx.mjs:119; tests/forms.test.mjs:533,975 (2 000 $ → 1 842,40 €, разница 7,60 €) | — | — | — |
| A08.4 | Запас (savings + asset·bp) отдельно от operating; крипта по умолчанию неликвидна | **реализовано** ▲ | нет | engine/liquidity.mjs (liquidity_report); demo/form_accounts.mjs; tests/liquidity.test.mjs (7), forms.test.mjs:565,1002 (REQ-018 REQ-080) | fx.liquid_value вызывается опосредованно через engine/liquidity.mjs:80; экран показывает запас и счета (rate_status — в форме курсов) | — | — |
| A08.5 | Чип сценария «курс ±N bp» | **реализовано** ▲ | нет | demo/scenario_builder.mjs (fx_shock) | — | — | — |
| A08.6 | Глобальные плашки W_RATE_STALE и E_NO_RATE: пара, дата, возраст; куда идти за курсом | **частично** | частично | demo/i18n.mjs:163,174: «Курс давно не обновлялся», «Нет курса: введите курс в настройках» | Курс вводится на экране «Формы данных → Курсы», а не в «Настройках»; в шапке нет пары/даты/возраста (они есть только на экране форм) | S | — |
| A08.7 | Выбор валюты решения/показа в интерфейсе | **нет** | нет | set_param decision_currency допустим (ws_edit.mjs:367), формы в settings.mjs/form_fx.mjs нет | — | S | — |
| A08.8 | Политика adverse (доход×(1−h), расход×(1+h)), вектор остатков по валютам, пакеты курсов, переоценка резервов (X4) | **нет** | нет | engine/fx.mjs normalize_policy: kind≠spot → E_SCHEMA; "adverse" в коде встречается только в комментарии | REQ-081: 185000 → 175750, 100000 → 105000 — тест-вектор готов в странице | M | Политика показа курсов «в худшую сторону» и источник h — канон v1.2 |

### ALG-09 Долги и рассрочки

| № | Что | Сейчас | Было 10-05 | Доказательство | Чего не хватает | Усилие | Решение владельца |
|---|---|---|---|---|---|---|---|
| A09.1 | annuity_payment, amortization_schedule, schedule_to_events, prepay, reanchor | **реализовано** | реализовано | engine/debt.mjs; tests/debt.test.mjs (16) | — | — | — |
| A09.2 | Экран «Долги»: график, «досрочно» (shorten / lower_payment), сверка с банком с допуском drift_tol_bp | **реализовано** ▲ | нет | demo/debts.mjs; tests/showcase.test.mjs:305-496 (REQ-082, REQ-083: 809,00 € против 807,9x) | — | — | — |
| A09.3 | Долг как запись рабочей области (debts[]), входящая в прогноз | **нет** | нет | demo/debts.mjs: «ничего не записывает» (шапка файла); вида правки upsert_debt нет (ws_edit.mjs); только примерка на копии (tests/showcase.test.mjs:358) | Пользователь не может добавить свой кредит в прогноз; рассрочка создаётся как покупка (form_installment), а не как DebtPlan | M | — |
| A09.4 | Предупреждение о платежах долга за горизонтом | **частично** ▲ | нет | На экране «Долги»: внутри / за горизонтом (tests/showcase.test.mjs:347) | analyze по-прежнему молча отбрасывает платежи DebtPlan за horizon_end; кода W_DEBT_BEYOND_HORIZON нет (новая запись в engine/warnings_ext.mjs) | S | — |
| A09.5 | Допуск дрейфа внутри reanchor | **частично** ▲ | нет | Движок не проверяет (страница п. 3); экран «Долги» сравнивает \|drift\| с допуском (showcase.test.mjs:432) | Для других вызывающих (ассистент, CLI) проверки нет | S | — |
| A09.6 | Зажим основной части аннуитета вместо E_SCHEMA (решение кода по adversarial) | **частично** | частично | engine/debt.mjs; todo: tests/adversarial/semantics.test.mjs:1465 (гипотеза «\|последний − A\| ≤ n» опровергнута) | — | — | Утвердить зажим как канон или вернуть E_SCHEMA (арбитр) |
| A09.7 | Мультивалютный долг, плавающая ставка, акции «отсрочка» | **нет** | нет | Вне среза (страница) | — | L | Нужны ли эти виды долга вообще (границы продукта) |

### ALG-10 Неопределённость, Монте-Карло

| № | Что | Сейчас | Было 10-05 | Доказательство | Чего не хватает | Усилие | Решение владельца |
|---|---|---|---|---|---|---|---|
| A10.1 | make_seed, u01, run_paths, p_fail, q_alpha, s_max_alpha, present_probability | **реализовано** | реализовано | engine/montecarlo.mjs; tests/montecarlo.test.mjs (38), adversarial/verifier_io | — | — | — |
| A10.2 | Построитель fx_obs_bp из ws.rates и входы из истории (mc_observations, payment_habits) | **реализовано** ▲ | нет | engine/mc_inputs.mjs:41 fx_obs_from_rates, :245 mc_observations, :272 payment_habits; tests/mc_inputs.test.mjs (11) | — | — | — |
| A10.3 | Коридор P10/P50/P90 (mc_band), адаптер для backtest (mc_band_adapter), quantile_label | **реализовано** ▲ | нет | engine/band_adapter.mjs; tests/band_adapter.test.mjs (11) | — | — | — |
| A10.4 | Вероятностная полоса на экране: включается явным согласием, таблица-двойник, n, seed | **реализовано** ▲ | нет | demo/prob_band.mjs; ключ согласия runway-prob-consent/1; tests/prob_band.test.mjs (20); проход в браузере 2026-10-10 (16-prototype-findings, «Вероятностная полоса») | — | — | — |
| A10.5 | Честные отказы: нет истории, «мало наблюдений» при n < 20 (D-15), без процентов | **реализовано** ▲ | нет | engine/montecarlo.mjs present_probability; demo/prob_buy.mjs; band_adapter.test.mjs, prob_band.test.mjs | — | — | — |
| A10.6 | Вероятности в основном потоке (Обзор, Купить, ответы ассистента, CLI) | **нет** | нет | Намеренно нет (ADR-015, шаблоны ответов без ключа probability); в cli.mjs montecarlo/backtest нет | — | — | Политика вероятностей: оставлять ли их только экспериментом по согласию или выводить в основной поток |
| A10.7 | Юридическое ревью формулировок «эксперимент, не обещание» и вычитка RU/EN | **не код** | не код | wave2-acceptance: REQ-183 «ожидает людей»; tests/wizard.test.mjs:731 фиксирует пометку | — | — | Назначить юриста/вычитку |

### ALG-11 Safe-to-spend

| № | Что | Сейчас | Было 10-05 | Доказательство | Чего не хватает | Усилие | Решение владельца |
|---|---|---|---|---|---|---|---|
| A11.1 | safe_to_spend, sts_breakdown, default_sts_horizon, reserve_series, free_series | **реализовано** | реализовано | engine/afford.mjs, engine/sinking.mjs; tests/afford.test.mjs (TST-06, 08, 39), timeline.test.mjs TST-53 | — | — | — |
| A11.2 | Настройки буфера, горизонта, сдвига «если хуже» | **реализовано** ▲ | нет | demo/settings.mjs:26-27; tests/settings.test.mjs:118-228, 381-422 (REQ-024…026) | — | — | — |
| A11.3 | «Почему» у «можно потратить» | **реализовано** ▲ | частично | demo/why_more.mjs open_sts_why (кнопка на карточке «Почему так»); why_more.test.mjs | — | — | — |
| A11.4 | Привязка резерва к реальному счёту; квартальные авансы; именованные налоговые режимы как данные | **нет** | нет | sinking.mjs:27 («v1: null»); tax_templates нет | — | L | См. A05.7 и A06.6 |

### ALG-12 Контракт инструментов LLM и верификатор

| № | Что | Сейчас | Было 10-05 | Доказательство | Чего не хватает | Усилие | Решение владельца |
|---|---|---|---|---|---|---|---|
| A12.1 | 10 инструментов T0/T1, run_tool, verify_answer, a0_answer, шаблоны ru/en | **реализовано** | реализовано | engine/tools.mjs, engine/verifier.mjs; tests/tools.test.mjs (33), verifier.test.mjs (33), injection.test.mjs (14) | — | — | — |
| A12.2 | Пробелы верификатора: ссылочный Markdown, юникод-минусы, управляющие символы форматирования | **реализовано** ▲ | частично | tests/adversarial/verifier_io.test.mjs:227,231,237 — «закрыто FP-02» (были todo) | — | — | — |
| A12.3 | Идентификатор-«инструкция» по форме SAFE_ID | **частично** | частично | tests/adversarial/verifier_io.test.mjs:2673 — todo CANON? | — | — | Решение арбитра: ограничить форму идентификатора |
| A12.4 | Ассистент A0 в демо: интенты | **частично** | частично | demo/app.mjs:743 parse_assistant_command — 8 интентов (задержка клиента, объяснение, волны, налоги, когда, сколько, покупка, прогноз) | Нет «что изменилось с …» (инструмент what_changed есть в engine/tools.mjs:141, в CLI changed), нет «а если сдвинуть/сократить платёж», нет «что с резервом» | M | — |
| A12.5 | Журнал вызовов assistant.call (хэши, без текстов) | **нет** | нет | Тип события есть (engine/ledger.mjs:270, demo/journal_log.mjs:82), писателя нет: grep call_log_record / запись assistant.call по engine/ и demo/ пуст | engine/call_log.mjs: call_log_record(result) → make_event | M | — |
| A12.6 | Предпросмотр «что ушло бы в облако» (payload) | **частично** ▲ | нет | demo/payload_preview.mjs (показывает результат инструмента, тексты скрыты, метка untrusted); tests/showcase.test.mjs:605-756 (REQ-131 REQ-132) | Не использует engine payload_for() и белый список A2/A3: это предпросмотр результата, а не точного JSON запроса в модель | S | — |
| A12.7 | A1–A3 с настоящей LLM, MCP-сервер, шаблоны ES | **нет** | нет | answer_question с портами-заглушками (engine/verifier.mjs); LANGS = ru, en | — | L | Внешний сервис LLM: выбор провайдера, ключи и оплата, политика приватности; испанский — REQ-113: нужен ли и кто переводит |

### ALG-13 План↔факт и калибровка

| № | Что | Сейчас | Было 10-05 | Доказательство | Чего не хватает | Усилие | Решение владельца |
|---|---|---|---|---|---|---|---|
| A13.1 | match_plan_to_fact, assign_statuses, classify_occurrence, stale_status, flow_calibration, wilson; backtest, release_gate, window_metrics | **реализовано** | реализовано | engine/calibration.mjs, engine/backtest.mjs; tests/calibration.test.mjs (28), backtest.test.mjs (32) | — | — | — |
| A13.2 | Экран «Сверка»: очередь, «подтвердить / привязать / не относится / пропустить / отменить», match.set | **реализовано** ▲ | нет | demo/reconcile.mjs (classify_occurrence, match_plan_to_fact, EDITS set_match / set_plan_status), ws_bridge.mjs (match.set); tests/reconcile.test.mjs (28), reconcile_boot.test.mjs (4); проход в браузере (набор late, 17 просроченных) | — | — | — |
| A13.3 | Экран «Качество прогноза»: FRR, cry-wolf, решение гейта REQ-176, волны REQ-188 — на синтетических журналах с пометкой | **реализовано** ▲ | нет | demo/quality.mjs, demo/quality_report.mjs (зеркало), tools/backtest_report.mjs, data/backtest-report.json; tests/quality_report.test.mjs (17) | Только синтетика (22 журнала) | — | — |
| A13.4 | Метрики качества по собственным данным пользователя: backtest своего журнала, MAE / bias / skill | **нет** | нет | demo/quality.mjs читает только готовый отчёт на синтетике (стр. 3, 32); window_metrics в demo не вызывается | Нужен слой demo/quality_user.mjs: replay журнала ws → backtest → window_metrics при ≥ 3 точек отсчёта (calib.min_origins) | M | — |
| A13.5 | «Привычки платежей» (p50/p80/p90 при n ≥ 10) и ряд «ожидаемый» как оценка | **реализовано** ▲ | нет | demo/quality.mjs, engine/expected.mjs (EXPECTED_MIN_OBS = 10), engine/mc_inputs.mjs payment_habits; tests/expected.test.mjs (6), mc_inputs.test.mjs, quality_report.test.mjs | — | — | — |
| A13.6 | Анонимизация журналов добровольцев (сдвиг дат 7·N, множитель сумм) | **частично** ▲ | нет | tools/anonymize.mjs (anonymize_journal, verify_anonymized); tests/anonymize.test.mjs (11) | ADV-6: метрики backtest после сдвига отличаются, т.к. by_monthday и «конец месяца» не сдвигаются (tests/fp11_adv.test.mjs:224 — todo) | M | Как поступать с by_monthday при анонимизации: пересчитывать (с оговоркой о границах) или самопроверка до/после |
| A13.7 | Гейт REQ-176 на журналах добровольцев (≥ 10) | **нет** | нет | data/synthetic-journals — только синтетика; журналов добровольцев в проекте нет | — | — | Привлечь добровольцев и получить журналы (после решения про ADV-6) |
| A13.8 | skill_pm / min_error через BigInt и round_div | **реализовано** ▲ | нет | engine/backtest.mjs:257 (BigInt), :317 round_div; tests/backtest.test.mjs, hardening.test.mjs (window_metrics) | — | — | — |
| A13.9 | Метрики на устройстве: заполнение min_error_bp и coverage из сверки / backtest | **нет** | не оценивалось | demo/metrics.mjs:272,282 record_min_error / record_coverage определены и проверены (tests/metrics.test.mjs:129,254), но вызывающих в demo/ нет (grep): поля пакета всегда n = 0 | Подписка на set_match / сверку и вызов record_* | S | — |
| A13.10 | Режим расчёта expected; оповещения о просрочке | **нет** | нет | См. A02.8; карточка «Сверка» на Обзоре (demo/reconcile.mjs render_reconcile_card) — не оповещение | — | L | См. A02.8; оповещения (REQ-115) — v2, решение о приоритете |
| A13.11 | CLI / команда отчёта backtest | **реализовано** ▲ | нет | tools/backtest_report.mjs (отдельный запуск; cli.mjs backtest по-прежнему нет); tests/quality_report.test.mjs | — | — | — |

### ALG-14 hledger-экспорт и CSV-импорт

| № | Что | Сейчас | Было 10-05 | Доказательство | Чего не хватает | Усилие | Решение владельца |
|---|---|---|---|---|---|---|---|
| A14.1 | Ядро io.mjs: профили-данные, parse_with_profile, dry_run, import_commit, import_rollback, export_json / csv / hledger, import_hledger | **реализовано** | реализовано | engine/io.mjs; tests/io.test.mjs (35), adversarial/verifier_io.test.mjs | — | — | — |
| A14.2 | Мастер импорта CSV и hledger: файл ≤ 5 МБ, сопоставление колонок, сухой прогон «распознано · отклонено · дубликатов · двойников», «Откатить партию» | **реализовано** ▲ | нет | demo/import_model.mjs, demo/import_wizard.mjs (раздел «Данные»); tests/import_model.test.mjs (21), import_wizard.test.mjs (9) | — | — | — |
| A14.3 | Кнопки экспорта JSON / CSV / hledger со списком потерь; файл-копия с напоминанием; «Удалить все данные» с квитанцией | **реализовано** ▲ | нет | demo/data_actions.mjs, data_view.mjs, backup.mjs; tests/data_actions.test.mjs (33 теста; строки 153, 190, 244, 252, 504), проход в браузере 2026-10-10 | — | — | — |
| A14.4 | Строгий разбор сумм с группами тысяч («12,50» при thousands «,» → отказ); защита идентификаторных колонок от формул | **реализовано** ▲ | нет | engine/io.mjs:133 groups_ok, :657 csv_safe_cell (изменён существующий io.mjs, а не новый io_strict); tests/adversarial/verifier_io.test.mjs:1092,1113,1615 («закрыто FP-02») | — | — | — |
| A14.5 | Мастер таблиц Excel / Google Sheets (классы листов, un-pivot; REQ-099/100) | **нет** | нет | grep classify / sheet по io.mjs и import_model.mjs пуст | Новый модуль engine/sheet_classify.mjs + экран | L | — |
| A14.6 | OFX с FITID; адаптеры Дзен-мани / CoinKeeper | **нет** | нет | data/profiles/ — только csv-generic.json и csv-semicolon-dmy.json | Профили банков как данные (S каждый) — нужны образцы выгрузок | M | — |
| A14.7 | Строки в чужой валюте с двумя ногами (v1.1) | **нет** | нет | engine/io.mjs:385 — такие строки отвергаются как currency_mismatch | — | M | — |
| A14.8 | Разбор больших файлов в Worker | **нет** | нет | demo/calc_worker.mjs считает только analyze; parse_csv / dry_run синхронны | — | M | — |
| A14.9 | Оракул hledger (сверка экспорта с настоящим hledger) | **частично** | частично | tools/hledger_oracle.mjs (печатает команды Docker); tests/io.test.mjs — единственный skip | Не запускался: нет бинаря и образа | — | Установить hledger / Docker для разового прогона (внешний инструмент) |

## 5. Часть 2. Экраны и сценарии UX

Источники: `wiki/product/03-ux-screens.md` (инвентарь из 16 экранов, плашки, ошибки, состояния), `01-personas-jtbd.md` (путь «первые 10 минут», Q1–Q3, граничные варианты), `17-start-plan.md` (чек-лист «Готовность v0», измерение без телеметрии). Демо сейчас: 23 раздела навигации (подтверждено проходом в браузере 2026-10-10, `16-prototype-findings.md`), десять пакетов `pack_fp03…pack_fp12`, отдельная страница `demo/v0.html`.

### 5.1 Инвентарь экранов 03-ux-screens

| № | Что | Сейчас | Было 10-05 | Доказательство | Чего не хватает | Усилие | Решение владельца |
|---|---|---|---|---|---|---|---|
| U01 | start — мастер первых минут (REQ-110) | **реализовано** ▲ | нет | demo/wizard.mjs, pack_fp10.mjs (#start); tests/wizard.test.mjs (29), start_boot.test.mjs (7): g001-empty проходит готовность 1→1→1→2→3→4 | См. P03, P06 | — | — |
| U02 | overview — Обзор (Q1, «можно потратить», график, таблица значений) | **реализовано** | реализовано | demo/app.mjs view_overview, chart_card, values_table; tests/demo.test.mjs TST-01/02/04/58; состояние «пусто» достижимо: набор g001-empty (tests/start_boot.test.mjs:127) | См. U40 (скелет), U41 (вторая колонка) | — | — |
| U03 | buy — «Могу ли я это купить» (ползунки, флаги, «почему», чип c_…) | **реализовано** | реализовано | demo/app.mjs view_buy, buy_run; tests/demo.test.mjs TST-04, REQ-044, REQ-091; рассрочка — #forms «Рассрочка»; «почему» по плану — карточка «Почему так» на Обзоре | Нет состояния «Считаем…» (U40); конструктор рассрочки — на другом экране, не в «Купить» | — | — |
| U04 | why — «Почему» (пик, цепочка, «Остальное», контрфакты) | **реализовано** ▲ | частично | demo/why_more.mjs (хук show_why; сверка «сумма строк = просадка»), кнопки у карточки волны; tests/why_more.test.mjs (12) | — | — | — |
| U05 | waves — карточка и календарь, «почему вместе?», разделить / объединить / закрепить | **реализовано** ▲ | частично | demo/wave_edit.mjs; tests/wave_edit.test.mjs (12), waves_card.test.mjs (22) | Состояние «Поступлений нет: окно метрики до конца горизонта» отдельной строкой не найдено | — | — |
| U06 | feed — «Лента и сверка» | **частично** | частично | Лента demo/app.mjs view_feed (по-прежнему показывает 8 последних фактов, :555); сверка — отдельный экран #reconcile (demo/reconcile.mjs, подпись «Просрочено: ожидали …», пагинация всех фактов по 15) | Документ описывает один экран; в демо два (#feed и #reconcile), в ленте нет счётчика «Сверка: N» и действий; усечение до 8 фактов не оговорено | S | — |
| U07 | scenarios — до трёх рядом, конструктор, «сохранить в набор», плашка «вы в сценарии» | **реализовано** ▲ | частично | demo/app.mjs view_scenarios (MAX_SCENARIOS = 3); demo/scenario_builder.mjs (#scenario_lab); tests/scenario_builder.test.mjs (19), demo.test.mjs | — | — | — |
| U08 | tax_hours — налоги и часы (диапазон дохода, недоработка, конверт, правка правила с предпросмотром) | **реализовано** ▲ | частично | demo/form_hours.mjs, form_tax.mjs + карточки в «Резервы»; tests/forms.test.mjs:237-423, 684-748, 894 | Отдельного экрана tax_hours нет: живёт в #forms («Часы», «Налог») и на «Резервы» | — | — |
| U09 | accounts — счета и резервы (L0/L1/L2/D, «Операционные · Запас») | **реализовано** ▲ | частично | demo/form_accounts.mjs; engine/liquidity.mjs; tests/forms.test.mjs:565,738,1002; liquidity.test.mjs (7) | — | — | — |
| U10 | entry — быстрый ввод факта «+ Факт», «Сверить остаток», «Отменить / Вернуть» | **реализовано** ▲ | нет | demo/entry.mjs, anchor_dialog.mjs, undo.mjs; tests/entry.test.mjs (25), undo_all.test.mjs (43), undo_fix (24), s1_3_adv (12) | — | — | — |
| U11 | import — импорт CSV и hledger с сухим прогоном | **реализовано** ▲ | нет | demo/import_wizard.mjs (карточка в «Данные», а не отдельный экран); tests/import_model.test.mjs (21), import_wizard.test.mjs (9) | — | — | — |
| U12 | data — возраст копии, persist(), PWA-статус, экспорт, удаление с квитанцией, «где что лежит» | **реализовано** ▲ | частично | demo/data_view.mjs, data_runtime.mjs, store*.mjs; tests/store.test.mjs (41), data_actions.test.mjs (33), backup (8), rights (6) | — | — | — |
| U13 | assistant — A0 | **частично** ▲ | реализовано | demo/app.mjs view_assistant, ask_a0; tests/demo.test.mjs, verifier.test.mjs | См. A12.4: 8 интентов; нет контекстных кнопок «Спросить про эту сумму» | S | — |
| U14 | settings — буфер + подсказка, горизонт, «если хуже», пороги волн и допуски сверки, формат чисел, «Сегодня» | **реализовано** ▲ | нет | demo/settings.mjs, number_format.mjs, as_of.mjs; tests/settings.test.mjs (36), as_of (14) | — | — | — |
| U15 | metrics — метрики на устройстве runway-metrics/1, показ файла целиком | **частично** ▲ | нет | demo/metrics.mjs, metrics_view.mjs; tests/metrics.test.mjs (19) | Формат пакета не совпадает с wiki/product/13-metrics.md и 17-start-plan 6.5 (нет readiness_max, activated, q3_opened, anchor_age, backup_age); min_error_bp и coverage не заполняются (A13.9) | S | Единый канон формата runway-metrics/1: вики (13-metrics) или SPEC-format; какая сборка раздаётся 30 приглашённым |
| U16 | demo — демо G-001 и «эталонные ответы» | **реализовано** ▲ | частично | demo/golden_panel.mjs, data/golden-g001.json; tests/showcase.test.mjs:143-205 (REQ-109); четыре набора + g001-empty | — | — | — |

### 5.2 Шапка, навигация, плашки, ошибки, состояния, платформа

| № | Что | Сейчас | Было 10-05 | Доказательство | Чего не хватает | Усилие | Решение владельца |
|---|---|---|---|---|---|---|---|
| U20 | Шапка: остаток · свежесть · готовность · буфер · режим · валюта · плашка сценария | **реализовано** | реализовано | demo/app.mjs render_summary, render_controls; tests/demo.test.mjs, wave1_integration.test.mjs | — | — | — |
| U21 | Названия ступеней готовности («каркас», «рабочий», «рабочий+», «полный», IDEA-31) | **нет** | нет | demo/i18n.mjs:116 hdr.ready — только «готовность данных: N из 4» | Строки hdr.ready_name + карточка home_cards | S | — |
| U22 | Телефон: нижняя панель Обзор · Купить · Лента · Волны · Ещё и «+» | **частично** | частично | demo/style.css (max-width: 599px): нижняя панель в два ряда — разделы и действия; «+ Факт» есть среди действий (pack_fp04 nav.actions) | Все 23 раздела плоским списком, группы «Ещё» нет; проверка на 375 px по коду и по 16-prototype-findings не подтверждена для волны 2 | S | — |
| U23 | Широкий экран: боковая панель и вторая колонка (график слева, детали справа) | **частично** | частично | Боковая панель есть (style.css, min-width 1024px) | Второй колонки нет — график и карточки стопкой (чистый CSS .view--split) | S | — |
| U24 | Плашка «Готовность s < 4» с перечнем недостающего | **реализовано** ▲ | частично | demo/app.mjs:1672 not_ready_list(readiness.reasons); tests/settings.test.mjs:316-335 (REQ-029 TST-57), start_boot.test.mjs:142 | — | — | — |
| U25 | Плашка «Остаток устарел» / «Вердикт отключён» с действием «Сверить остаток» | **реализовано** ▲ | частично | слот banner.actions (pack_fp04, anchor_dialog.mjs); tests/entry.test.mjs, wave1_integration.test.mjs (REQ-028, ≤ 3 действий) | — | — | — |
| U26 | Плашка «Буфер не задан» с полем ввода и подсказкой | **реализовано** ▲ | частично | demo/settings.mjs; tests/settings.test.mjs:118-228 | — | — | — |
| U27 | Плашка «Взносы не подтверждены: N на сумму X» + «подтвердить за период» | **реализовано** ▲ | частично | demo/app.mjs:907, form_sinking.mjs; tests/forms.test.mjs:483, sinking_report.test.mjs:94 | — | — | — |
| U28 | Плашки «Остаток резерва» / «срок резерва прошёл» с суммой и «освободить вручную» | **частично** | частично | См. A05.6 (общий текст) | Нет суммы и действия | S | — |
| U29 | Плашка «Курс 0,9250 от 2026-08-20, не обновлялся 45 дн.» | **частично** | частично | Полный текст есть на экране «Курсы» (form_fx.mjs; forms.test.mjs:946); в шапке warn.W_RATE_STALE — общий текст | См. A08.6 | S | — |
| U30 | Плашка «Правило не подтверждено с <даты>» + кнопка «подтвердить»; при disabled числа заменены текстом | **частично** | частично | Подтверждение и замена чисел на «Резервы» — demo/form_tax.mjs; tests/forms.test.mjs:423,698 | Плашка в шапке (warn.W_RULE_STALE) — без даты | S | — |
| U31 | Плашка «Копия: 50 записей или 7 дней» + напоминание | **реализовано** ▲ | нет | demo/data_runtime.mjs:200 backup_banner; tests/data_actions.test.mjs:504,531 | — | — | — |
| U32 | Плашка «Перевод при резерве» (REQ-063) | **реализовано** ▲ | нет | engine/transfer_guard.mjs; demo/entry.mjs render_pending_card; tests/transfer_guard.test.mjs | — | — | — |
| U33 | Сообщения E_*: 8 кодов | **частично** | частично | demo/i18n.mjs:174 и err.* + demo/app.mjs err_text | E_NO_RATE: «введите курс в настройках» без пары и даты, а курс вводится в #forms → Курсы | S | — |
| U34 | Загрузка: скелет, «Считаем…», расчёт в Worker без блокировки интерфейса (REQ-150) | **частично** ▲ | нет | demo/calc_worker.mjs, worker_client.mjs; tests/worker_contract.test.mjs (13); только app.loading «Загрузка набора данных…» (demo/app.mjs:1721) | Основной расчёт приложения синхронный (README: Worker используется проверкой «О программе»); скелета нет | S | — |
| U35 | Пустые состояния всех экранов достижимы и покрыты отрисовкой | **частично** | частично | g001-empty делает достижимыми ov.empty и карточку «Старт» (tests/start_boot.test.mjs:127); sc.empty достижим из набора | Тест отрисовки wv.empty, fd.empty, rs.none, rs.tax_none, rs.sinking_none не найден (grep по tests/) — проверить | S | — |
| U36 | Календарь волн: штриховка + подпись, не только цвет | **реализовано** | реализовано | demo/app.mjs calendar_block; tests/demo.test.mjs TST-37, TST-58 | — | — | — |
| U37 | Режим «в магазине» (REQ-052) | **реализовано** ▲ | нет | См. A04.2 | — | — | — |
| U38 | Доступность WCAG 2.2 AA: клавиатура, фокус, контраст токенов, 200 % шрифт, скринридер | **частично** | частично | Структура и CSS — tests/demo.test.mjs TST-58, wizard.test.mjs; контраст — tools/contrast.mjs (tests/contrast.test.mjs, 8) | Настоящий обход клавиатурой, 200 % и скринридер не выполнялись (wave2-acceptance: REQ-167 partial) | — | Нужны люди и устройства |
| U39 | PWA: установка, офлайн, обновление без тихой подмены | **частично** ▲ | нет | demo/pwa.mjs, sw.js, about.mjs, manifest.webmanifest; tests/pwa.test.mjs (23), offline_inventory (7), build_manifest (11) | Встроенный браузер не принял воркер — PWA в реальном браузере не проверялась (16-prototype-findings); чек-лист prototype/CHECKLIST-release.md не выполнен | — | Ручной прогон на 3 устройствах/браузерах; HTTPS-хост |
| U40 | Скелет загрузки (CSS .is-loading / aria-busy) | **нет** | нет | grep skeleton / aria-busy по demo/ пуст | Только CSS + класс на время fetch | S | — |
| U41 | Вторая колонка Обзора на ≥ 1024 px | **нет** | нет | См. U23 | Только CSS | S | — |
| U42 | Испанский интерфейс (REQ-113, v1.1) | **нет** | нет | demo/i18n.mjs: LANGS = ru, en | STRINGS.es, FORMS.es, шаблоны верификатора | L | См. A12.7 |
| U43 | Оповещения / дайджест (REQ-115, v2) | **нет** | нет | grep Notification по demo/ пуст | — | M | Нужны ли в v1; политика «≤ 2 в неделю» |

### 5.3 Путь «первые 10 минут» (01-personas-jtbd)

| № | Что | Сейчас | Было 10-05 | Доказательство | Чего не хватает | Усилие | Решение владельца |
|---|---|---|---|---|---|---|---|
| P01 | Шаг 1. Счёт: название, валюта, остаток, якорь | **реализовано** ▲ | нет | demo/wizard.mjs step_account; tests/wizard.test.mjs:153,258 (s = 1) | — | — | — |
| P02 | Шаг 2. Обязательства: ≥ 3 повторяющихся платежа или волна | **реализовано** ▲ | нет | wizard.mjs step_obligations; wizard.test.mjs:217,917 (подсказка «n из 3» согласована с отметкой) | — | — | — |
| P03 | Шаг 3. Ближайший доход как поток «ставка × часы, выплата через N дней» (путь Яна) | **частично** ▲ | нет | Мастер создаёт правило-поступление «раз в месяц / один раз» + привычная задержка (rule_kit.mjs INCOME_REPEATS); s = 3 достигается | Поток часов (80/93/110 ч) вводится не в мастере, а в #forms → «Часы»; у почасовика прогноз на шаге 3 не воспроизводит числа сквозного примера | M | Какой доход считать «первым» для целевой персоны: правило или поток часов (влияет на проверку спроса v0) |
| P04 | Шаг 4. Повседневные траты (приблизительное правило) + буфер с подсказкой | **реализовано** ▲ | нет | wizard.mjs step_daily, step_buffer; wizard.test.mjs:153 (узкая точка 3 440,00 € сверена ручной симуляцией) | — | — | — |
| P05 | «Первый прогноз» при s ≥ 3 с плашкой «не учтено», Q3 «данных мало» до шага 4 | **реализовано** ▲ | нет | wizard.mjs forecast_section; wizard.test.mjs:153,992 | — | — | — |
| P06 | Названия ступеней s (IDEA-31) | **нет** | нет | См. U21 | — | S | — |
| P07 | Замер времени до первого прогноза (журнал шагов, «первый прогноз» в метриках) | **реализовано** ▲ | нет | wizard.mjs create_step_timer, metrics.mjs mark_first_forecast; tests/wizard.test.mjs:493-542,948,974; metrics.test.mjs | Оценка сверху (простой до минуты); бюджет 7,5 мин — гипотеза | — | — |
| P08 | Публикация «за N минут» | **не код** | не код | Запрещено до измерения на ≥ 5 пользователях (REQ-110); tools/lint_vocab.mjs lint_promises | Процесс, не код | — | — |
| P09 | Импорт CSV как ускорение шагов 1 и 4 | **частично** ▲ | нет | Мастер импорта в «Данные» (U11); связи «Старт → Импорт» в wizard.mjs не найдено (grep import) | Ссылка из шага 1 и 4 на мастер импорта | S | — |
| P10 | Второй валютный счёт и курс spot; до курса — E_NO_RATE | **реализовано** ▲ | нет | demo/form_accounts.mjs, form_fx.mjs; tests/forms.test.mjs:504,565,946 | Текст E_NO_RATE ведёт не туда (U33) | — | — |
| P11 | Налоговое правило и накопление после четырёх шагов; числа 635,00 / 410,00 € только с резервами (C-065) | **реализовано** ▲ | нет | demo/v0.mjs (форма резервов), form_tax.mjs, form_sinking.mjs; tests/v0.test.mjs:97,149 | — | — | — |
| P12 | Первая неделя: факт в три поля, сверка на 7-й день, очередь | **реализовано** ▲ | нет | entry.mjs, anchor_dialog.mjs, reconcile.mjs; tests/entry.test.mjs, reconcile.test.mjs | Цель «очередь ≤ 5 минут» (REQ-106) не измерялась | — | — |
| P13 | «Сохраните файл: сайт его не хранит» после первого вердикта (v0) | **частично** ▲ | нет | demo/i18n/v0.mjs:120 v0.file_hint (постоянная подсказка у кнопок файла) | Нет напоминания именно в момент первого вердикта | S | — |

### 5.4 Чек-лист «Готовность v0» и проверка спроса (17-start-plan)

| № | Что | Сейчас | Было 10-05 | Доказательство | Чего не хватает | Усилие | Решение владельца |
|---|---|---|---|---|---|---|---|
| C01 | v0: форма с данными G-001 даёт 1 555,00 / 1 330,00 € без резервов, дорожка 300 € → OK, подпись «без учёта резервов» | **реализовано** | не оценивалось | demo/v0.html, v0.mjs; tests/v0.test.mjs:97,124,149 (восемь значений golden-g001.json) | — | — | — |
| C02 | v0: гейт не пускает вердикт без буфера, со старым остатком, без данных; причина названа | **реализовано** | не оценивалось | tests/v0.test.mjs:350 | — | — | — |
| C03 | v0: файл сохраняется и открывается, state_hash совпадает | **реализовано** | не оценивалось | tests/v0.test.mjs:185,474,663,726 | — | — | — |
| C04 | v0: нет запросов после загрузки, нет внешних шрифтов и аналитики | **реализовано** | не оценивалось | tests/v0.test.mjs:535 (CSP только self), 577 | — | — | — |
| C05 | node --test, lint, lint_vocab без ошибок | **реализовано** | не оценивалось | По отчёту приёмки: _ops/impl/wave2-acceptance.md (2155 тестов, 0 fail, 2 skipped, 5 todo); в этом аудите не перезапускалось | — | — | — |
| C06 | Файл runway-metrics/1 показывается целиком до отправки | **частично** | не оценивалось | demo/metrics_view.mjs (#metrics в приложении); проход в браузере 2026-10-10 | В v0.html метрик нет (страница без хранилища): если приглашённым раздаётся v0.html, пакет получить неоткуда | S | Какую сборку раздавать приглашённым: v0.html или приложение |
| C07 | Пакет метрик покрывает критерии спроса v0 («вводит свои числа», «возвращается через 7 дней») | **частично** | не оценивалось | metrics.mjs: first_forecast (после правки пользователя), active_days, sessions | Нет readiness_max, activated, q3_opened, anchor/backup age; age_days вычисляется из active_days; формат расходится с вики | S | Единый канон формата (см. U15) |
| C08 | Приглашения (30 целевых), интервью, журнал приглашений, запись decision | **не код** | не код | Процесс (17-start-plan, разделы 4.2, 6): не код | — | — | Владелец/люди |
| C09 | Ручной прогон в браузере (клавиатура, ширина телефона, вкладка сети) | **частично** | не оценивалось | Проход волны 2 в браузере выполнен координатором (16-prototype-findings, раздел «Проверка волны 2 в браузере»): мастер, метрики, v0, сверка, качество, полоса, удаление, «О программе» | Не выполнено: PWA, ширина 375 px, обход клавиатурой, 200 % | — | Люди и устройства |

Общий вывод по UX: демо перестало быть «экраном ответов» — появились ввод факта, сверка остатка, мастер «Старт», настройки, формы, импорт, хранение, сценарии, сверка, качество, метрики, «О программе». Оставшиеся UX-пробелы либо косметические и аддитивные (скелет, вторая колонка, «Ещё» на телефоне, названия ступеней, тексты плашек), либо про согласованность с вики (метрики, персона-почасовик в мастере).

## 6. Что изменилось против первого аудита

### 6.1 Двадцать шесть пунктов «Что дописать» (alg-audit.md)

| № | Пункт 10-05 | Сейчас | Доказательство / остаток |
|---|---|---|---|
| 1 | tax_hooks (on_posted_*) | выполнено | engine/tax_hooks.mjs; tests/tax_hooks.test.mjs (11) |
| 2 | reserve_behind_detail, текст «N на X» | выполнено | engine/sinking_report.mjs:103; tests/sinking_report.test.mjs:94 |
| 3 | fx_obs_from_rates | выполнено | engine/mc_inputs.mjs:41; tests/mc_inputs.test.mjs |
| 4 | Вероятностная полоса по согласию | выполнено | demo/prob_band.mjs; tests/prob_band.test.mjs (20) |
| 5 | «Купить» с уверенностью α | выполнено | demo/prob_buy.mjs; tests/band_adapter.test.mjs |
| 6 | Адаптер коридора для backtest | выполнено | engine/band_adapter.mjs mc_band_adapter |
| 7 | CLI backtest + release_gate | выполнено иначе | tools/backtest_report.mjs (не cli.mjs) |
| 8 | anonymize_journal | выполнено с оговоркой | tools/anonymize.mjs; ADV-6 todo (метрики после сдвига расходятся) |
| 9 | Экран «Сверка» | выполнено | demo/reconcile.mjs; reconcile.test (28) |
| 10 | Экран «Качество прогноза» | выполнено с оговоркой | только синтетика; своего backtest нет (A13.4) |
| 11 | expected_series | выполнено | engine/expected.mjs; режим расчёта по-прежнему закрыт |
| 12 | Мастер CSV | выполнено | demo/import_wizard.mjs; import_model.test (21) |
| 13 | Экспорт и удаление | выполнено | demo/data_actions.mjs; data_actions.test (33) |
| 14 | Строгий разбор сумм, csv_safe_cell | выполнено иначе | правка engine/io.mjs (groups_ok, csv_safe_cell), без io_strict.mjs |
| 15 | Правки волн | выполнено | demo/wave_edit.mjs |
| 16 | Чипы сценариев | выполнено | demo/scenario_builder.mjs |
| 17 | Экран «Долги» | частично | калькулятор; долг в ws не пишется (A09.3) |
| 18 | Часы за период, недобор; импорт часов CSV | частично | форма и shortfall есть; import_hours_csv нет (A07.7) |
| 19 | «В магазине» | выполнено | demo/store_mode.mjs |
| 20 | «Запас в днях», буфер/горизонт | выполнено | home_cards.mjs, settings.mjs |
| 21 | by_setpos / by_month / valid_from + экран правил | частично | экран правил есть; новых полей Rule нет (A01.7) |
| 22 | Политика adverse + таблица курсов | частично | таблица курсов есть; adverse нет (A08.8) |
| 23 | Журнал вызовов, payload_preview, интенты A0 | частично | предпросмотр есть (иной по смыслу); call_log и интенты нет |
| 24 | ES-шаблоны | не начато | LANGS = ru, en |
| 25 | Шаблоны налогов, next_release | частично | rule_age_status и allocation_range в UI; шаблоны и next_release нет |
| 26 | W_DEBT_BEYOND_HORIZON, W_TRANSFER_UNPAIRED | частично | W_TRANSFER_UNPAIRED есть; кода W_DEBT_BEYOND_HORIZON нет |

Итого: выполнено 18 (в том числе 7, 8, 10, 14 «иначе/с оговоркой»), частично 7, не начато 1.

### 6.2 Восемь «расхождений кода» (alg-audit.md, раздел «Расхождения и баги»)

| № | Расхождение 10-05 | Сейчас | Доказательство |
|---|---|---|---|
| 1 | ALG-01: set_amount без проверки знака | закрыто | validate_override (recurrence.mjs:152); forms.test, hardening.test |
| 2 | ALG-02: одинокая нога; E_NO_RATE на нуле | закрыто | hardening.test:50,119; semantics.test:1336,1342 |
| 3 | ALG-05: W_RESERVE_BEHIND без числа | закрыто | sinking_report.test:94,108 |
| 4 | ALG-07: W_HOURS_KEY_IGNORED без текста | закрыто | engine/warnings_ext.mjs |
| 5 | ALG-09: зажим аннуитета | открыто | semantics.test:1465 todo; вердикт арбитра |
| 6 | ALG-13: skill_pm / min_error на Number | закрыто | backtest.mjs:257 (BigInt), :317 |
| 7 | ALG-14: «12,50» → 1250,00; формулы в идентификаторах | закрыто | io.mjs:133,657; verifier_io.test:1113,1615 |
| 8 | ALG-12: ссылочный Markdown, юникод-минусы, bidi | закрыто (3 из 4) | verifier_io.test:227,231,237; остался :2673 (SAFE_ID) |

### 6.3 Сравнение по экранам (ux-audit.md)

Первый аудит, 16 экранов: есть 4 (overview, buy, scenarios, assistant), частично 7, нет 5 (start, entry, import, settings, metrics). Сейчас: 13 реализовано, 3 частично, 0 нет (строки U01…U16). Пять «нет» закрыты: start, entry, import, settings — реализовано; metrics — частично (U15). Частичные экраны why, waves, scenarios, tax_hours, accounts, data, demo — реализовано; feed остаётся частичным (два экрана вместо одного, лента усечена до 8). Assistant понижен до «частично» после уточнения (A12.4): интенты не изменились, но сравнение шло с более полной формулировкой экрана.

### 6.4 Десять «самых ценных UX-дополнений» первого аудита

| № | Дополнение 10-05 | Сейчас |
|---|---|---|
| 1 | Настройки | выполнено (U14) |
| 2 | Автосохранение + копия + удаление | выполнено (U12) |
| 3 | «+», «Сверить остаток» | выполнено (U10) |
| 4 | Формы данных | выполнено (#forms: платежи, часы, налог, накопления, курсы, счета, рассрочка) |
| 5 | Мастер «Старт» | выполнено с оговоркой (P03: доход — правило, не поток часов) |
| 6 | Очередь сверки | выполнено (A13.2) |
| 7 | Импорт CSV + экспорт | выполнено (A14.2, A14.3) |
| 8 | «Почему» везде | выполнено (U04) |
| 9 | Редактор волн | выполнено (A03.2) |
| 10 | «В магазине» + печать + горячие клавиши | выполнено (demo/store_mode.mjs, report.mjs, hotkeys.mjs; tests/showcase.test.mjs) |

### 6.5 Расхождение вики и кода (новое)

Страницы `wiki/algorithms/alg-01…14*.md` помечены `updated: 2026-10-04`; разделы «Реализация в прототипе» не отражают волн. Примеры устаревших утверждений: ALG-05 п. 4 («числа N на X не вычисляются»), ALG-06 («оболочек on_posted_* нет»), ALG-10 («демо-страница и CLI вероятностей не показывают», «функции fx_obs_bp нет»), ALG-13 («интерфейса backtest нет», «анонимизации в коде нет»), ALG-02 п. 11–12, ALG-07 п. 5, ALG-12 и ALG-14 («известные пробелы»). Это расхождение документации, а не кода; правка вики вне этого аудита. Параллельно `wiki/product/13-metrics.md` (раздел «Из метрик этой страницы в коде есть…») называет `runway-metrics/1` нереализованным — тоже устарело, но при этом формат из примера отличается от реализованного (U15).

## 7. Список пробелов и предложений (аддитивно, по убыванию пользы)

needs_owner = true ставится, если нужно решение владельца. Новые файлы названы в предложении; существующие не меняются, кроме указанных «малых правок общих файлов» (их нужно согласовать, потому что `app.mjs` и `i18n.mjs` общие).

| # | Пробел | Предложение (аддитивно) | Усилие | needs_owner | Вопрос владельцу |
|---|---|---|---|---|---|
| 1 | Метрики качества на устройстве никогда не заполняются (A13.9); формат пакета расходится с вики (U15, C07) | Подписка в новом `demo/metrics_feed.mjs`: после `set_match` и «Сверки» вызывать `record_min_error` / `record_coverage`; добавить `readiness_max`, `activated`, `q3_opened` в схему как новую версию `runway-metrics/1`-совместимого поля или привести вики к реализации | S–M | **true** (формат) | Какой формат канон: вики-пример или SPEC-format; и какую сборку раздавать приглашённым — приложение или v0.html (метрик в v0.html нет) |
| 2 | Долг нельзя добавить в прогноз; платежи за горизонтом молчат (A09.3, A09.4, A09.5) | Вид правки `upsert_debt` в новом пакете (`register_edit`), кнопка «Добавить в прогноз» на экране «Долги»; код `W_DEBT_BEYOND_HORIZON` в `engine/warnings_ext.mjs` (вызов после analyze) | M + S | false | — |
| 3 | Мастер «Старт» не покрывает путь почасовика (P03) | `demo/wizard_hours.mjs`: вариант шага 3 «Поток часов» (ставка, диапазон 80/93/110, выплата через N дней) на `form_hours.edit_set_stream_hours`/`upsert_stream`; предпросмотр дохода | M | true | Что считать «первым доходом» для целевой персоны и для проверки спроса: правило или поток часов |
| 4 | «Качество прогноза» только на синтетике; своего backtest нет (A13.4); гейт на добровольцах не запущен (A13.7) | `demo/quality_user.mjs`: replay журнала пользователя (`replay_state`/`backtest` при ≥ `calib.min_origins`), `window_metrics` (MAE, bias, skill) с пометкой «ваши данные, n = …» | M | true для A13.7 | Привлечь добровольцев и решение по ADV-6 (как анонимизировать by_monthday) |
| 5 | Журнал вызовов ассистента и интенты (A12.4, A12.5, A12.6) | `engine/call_log.mjs` (`call_log_record` → `assistant.call` с хэшами), `demo/assistant_ext.mjs`: «что изменилось», «а если сдвинуть платёж», «что с резервом»; предпросмотр на основе `payload_for` | M | false | — |
| 6 | Тексты плашек слабее документа: W_RATE_STALE, W_RULE_STALE, W_RESERVE_RESIDUAL / OVERDUE, E_NO_RATE (U28…U30, U33) | Новые ключи в `demo/i18n/` и функции в новом `demo/banner_texts.mjs`, вызываемые из слота; малая правка `app.mjs:warning_text` | S | false | — |
| 7 | Ручное освобождение остатка резерва (A05.6) | Кнопка «Освободить остаток» в `form_sinking`-карточке на `record_allocation {source: release}` + сумма в тексте | S | false | — |
| 8 | Календари выходных и праздников; перенос и своя сумма вхождения; разовый платёж (A01.4…A01.6) | Вид правки `upsert_calendar` и `demo/form_calendar.mjs`; кнопки «Перенести» и «Другая сумма» рядом с «Пропустить»; `add_plan`/`upsert_plan` | M + S + S | false | — |
| 9 | Мобильная навигация и широкий экран (U22, U23, U40, U41, U21) | CSS-сетка `.view--split`, группа «Ещё» (`<details>`), скелет (`aria-busy`), `hdr.ready_name` | S | false | — |
| 10 | earliest_date для рассрочки (A04.5) | `engine/installment_earliest.mjs`: перебор сдвига графика через `move_part_date` + `check_purchase` | M | false | — |
| 11 | Лента усечена до 8 фактов; два экрана вместо «Лента и сверка» (U06) | Счётчик «Сверка: N» и пагинация в ленте через слот; ссылка на #reconcile | S | false | — |
| 12 | Нет next_release, known_at в интерфейсе (A06.5) | Строка «следующее списание из конверта» в карточке налога | S | false | — |
| 13 | Импорт часов из CSV (A07.7); валюта решения (A08.7); профили банков (A14.6) | `engine/hours_io.mjs`; поле в `settings.mjs`-стиле; `data/profiles/*.json` по образцам выгрузок | M + S + M | false | — |
| 14 | Контекстные кнопки «Спросить ассистента» (U13), тесты пустых состояний (U35) | Кнопки на карточках с предзаполнением; тесты отрисовки `wv.empty`, `fd.empty`, `rs.none` | S | false | — |
| 15 | Страницы ALG-01…14 и 13-metrics устарели (раздел 6.5) | Обновить блоки «Реализация в прототипе» (вики-проход, не код) | S на страницу | false | — |
| 16 | Режим `expected` в расчёте (A02.8, A13.10) | Снять `mode_not_in_v1` только после канона; до того ряд остаётся оценкой (`engine/expected.mjs`) | L | **true** | Включать ли `expected` в расчёт и какой ряд считать заголовком |
| 17 | Политика `adverse` для курса (A08.8) | `engine/fx_adverse.mjs`: `adverse_halfwidth(rates_history, base, quote, q)`, обёртка над `to_decision_events`; тест-вектор REQ-081 (185000 → 175750, 100000 → 105000) | M | **true** | Нужна ли политика «в худшую сторону» и откуда берётся h |
| 18 | Шаблоны налоговых режимов, `net_of_vat`, окна дат (A06.6) | `data/tax_templates.json` со сроком годности + проверка `validate_tax_rule`; без ставок по умолчанию | L | **true** | Допустимы ли шаблоны стран/режимов (юридические формулировки, кто отвечает за актуальность) |
| 19 | Расширение правил: BYSETPOS, BYMONTH, valid_from, пакеты праздников (A01.7) | `engine/recurrence_ext.mjs` (расширяет, не меняет `expand_rule`) | M | **true** | Брать ли в срез и кто сопровождает данные праздников |
| 20 | Привязка резерва к счёту, частоты взноса (A05.7, A11.4) | Расширение схемы Reserve через новый модуль | M | **true** | Решение канона v1.1/v1.2 (REQ-191) |
| 21 | Автозамена по темпу EWMA, недельная переработка (A07.6) | `engine/hours_pace.mjs` как отображаемая оценка | M | **true** | Включать ли в срез (C-027, C-033) |
| 22 | LLM A1–A3, MCP, ES (A12.7, U42) | Порты уже есть (`answer_question`); нужен провайдер и i18n | L | **true** | Провайдер, ключи и оплата, политика приватности; нужен ли испанский |
| 23 | Вероятности в основном потоке; юридическое ревью формулировок (A10.6, A10.7, A04.6) | Не делать до решения; ревью вне кода | — | **true** | Политика показа вероятностей (ADR-015) и юрист |
| 24 | Мастер таблиц Excel/Sheets, OFX, чужая валюта двумя ногами, разбор в Worker (A14.5…A14.8) | `engine/sheet_classify.mjs` + экран; `engine/io_fx_rows.mjs`; `demo/import_worker.mjs` | L + M + M | false (нужны образцы файлов) | — |
| 25 | Оракул hledger (A14.9); PWA и доступность вручную (U38, U39, C09) | Запуск `tools/hledger_oracle.mjs --run`; чек-лист `CHECKLIST-release.md` | S + люди | **true** | Docker/hledger, HTTPS-хост, устройства, люди для обхода клавиатурой и скринридера |
| 26 | Зажим аннуитета; SAFE_ID по форме; инвариант 3 волн (A09.6, A12.3, A03.5) | Решения арбитра; тесты `todo` перевести в обычные | S | **true** | Утвердить решение кода или вернуть `E_SCHEMA`; ограничить форму идентификатора |

## 8. Что проверить руками (в этом аудите не проверялось)

- Браузер не запускался. Состояние DOM-кода подтверждено тестами на заглушке; проход 2026-10-10 (16-prototype-findings) покрыл мастер, метрики, v0, сверку, качество, полосу, удаление, «О программе». Не покрыто: PWA/сервис-воркер, ширина 375 px (нижняя панель на 23 разделах), обход клавиатурой, 200 % и скринридер.
- Прогон тестов не повторялся: числа 2155/2148/2/5 взяты из `_ops/impl/wave2-acceptance.md`. Тесты на время (TST-54, REQ-153, TST-45) зависят от нагрузки машины.
- Наличие теста у пустых состояний (U35) определено поиском по именам; возможен тест, не найденный поиском.
- `engine/index.mjs` не реэкспортирует `montecarlo`, `backtest`, `io`, `tools`, `verifier` и модули волн: это правило слоёв (README), не пробел.
